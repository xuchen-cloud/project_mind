//! Source identity tombstones and dependency dirtiness survive log compaction.
//! This catalogue stores no bodies, evidence copies or parallel versions.
use super::Database;
use crate::agent::{
    access::RequestContext,
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectRef, WorkspaceBinding},
};
use rusqlite::OptionalExtension;

#[derive(Debug)]
pub(crate) struct SourceRegistryEntry {
    pub object: ObjectRef,
    pub seq: i64,
    /// Delivery watermark; never substituted for a SourceRef semantic hash.
    pub event_revision: String,
    pub deleted_at: Option<String>,
}

#[derive(Debug)]
pub(crate) struct SourceDependencyInvalidation {
    pub seq: i64,
    pub reason: String,
}

fn io_error(_: rusqlite::Error) -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Cannot read source registry")
}

impl Database {
    fn source_dependency_owner(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        scope: &crate::agent::models::Scope,
        owner_key: &str,
        operation: &str,
    ) -> AgentResult<()> {
        request.authorize(binding, scope, operation)?;
        if self
            .native_workspace_id
            .as_deref()
            .is_some_and(|id| id != binding.workspace_id)
        {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Dependency Workspace is no longer current",
            ));
        }
        self.source_live_scope(scope)?;
        let prefix = format!("{}/{}/", binding.workspace_id, scope.key());
        if owner_key.len() > 512
            || !owner_key.starts_with(&prefix)
            || owner_key.len() == prefix.len()
        {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Dependency owner is outside the granted scope",
            ));
        }
        Ok(())
    }

    /// AI-04/05/08 own the real consumer IDs and graph registration. Return only
    /// dirtiness, not a potentially ungranted cross-scope evidence reference.
    pub(crate) fn source_dependency_invalidation(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        scope: &crate::agent::models::Scope,
        owner_key: &str,
    ) -> AgentResult<Option<SourceDependencyInvalidation>> {
        self.source_dependency_owner(request, binding, scope, owner_key, "knowledge.read")?;
        self.conn
            .query_row(
                "SELECT seq,reason FROM source_dependency_invalidations WHERE owner_key=?1",
                [owner_key],
                |r| {
                    Ok(SourceDependencyInvalidation {
                        seq: r.get(0)?,
                        reason: r.get(1)?,
                    })
                },
            )
            .optional()
            .map_err(io_error)
    }

    /// Invoke inside the real owner's publication/CAS transaction. A stale
    /// refresh cannot acknowledge a later source event; no knowledge is minted here.
    pub(crate) fn source_dependency_acknowledge(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        scope: &crate::agent::models::Scope,
        owner_key: &str,
        through_seq: i64,
    ) -> AgentResult<bool> {
        self.source_dependency_owner(request, binding, scope, owner_key, "knowledge.write")?;
        if self.conn.is_autocommit() {
            return Err(AgentError::new(
                ErrorCode::IoFailed,
                "Dependency acknowledgement requires the owner's publication transaction",
            ));
        }
        if through_seq <= 0 || through_seq > self.committed_change_watermark()? {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid dependency acknowledgement watermark",
            ));
        }
        self.conn
            .execute(
                "DELETE FROM source_dependency_invalidations WHERE owner_key=?1 AND seq<=?2",
                rusqlite::params![owner_key, through_seq],
            )
            .map(|count| count == 1)
            .map_err(io_error)
    }
    #[cfg(test)]
    pub(super) fn source_registry_prepare(&self) -> anyhow::Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute_batch(include_str!("source_registry.sql"))?;
        tx.commit()?;
        self.source_registry_reconcile()?;
        Ok(())
    }

    /// Metadata-only recovery for existing committed logs, including migrated
    /// Record keys. Tombstones are never cleared by log retention or an older row.
    pub(crate) fn source_registry_reconcile(&self) -> anyhow::Result<()> {
        self.conn.execute("INSERT INTO source_registry(object_key,scope_key,last_change_seq,event_revision,deleted_at)
          SELECT object_key,scope_key,seq,revision,CASE WHEN revision='deleted' THEN created_at ELSE NULL END
          FROM source_registry_log_objects WHERE seq IN (SELECT MAX(seq) FROM source_registry_log_objects GROUP BY object_key)
          ON CONFLICT(object_key) DO UPDATE SET scope_key=excluded.scope_key,last_change_seq=excluded.last_change_seq,
            event_revision=excluded.event_revision,deleted_at=excluded.deleted_at
          WHERE excluded.last_change_seq>source_registry.last_change_seq", [])?;
        Ok(())
    }

    pub(crate) fn source_registry_entry(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
    ) -> AgentResult<Option<SourceRegistryEntry>> {
        request.authorize(binding, &object.scope, "source.read")?;
        request.require_object_allowed(object)?;
        if object.workspace_id != binding.workspace_id {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Source registry belongs to another Workspace",
            ));
        }
        if self
            .native_workspace_id
            .as_deref()
            .is_some_and(|id| id != binding.workspace_id)
        {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Source registry Workspace is no longer current",
            ));
        }
        let entry = self.conn.query_row("SELECT last_change_seq,event_revision,deleted_at FROM source_registry WHERE object_key=?1 AND scope_key=?2", rusqlite::params![object.key()?,object.scope.key()], |r| Ok(SourceRegistryEntry { object: object.clone(), seq: r.get(0)?, event_revision: r.get(1)?, deleted_at: r.get(2)? })).optional().map_err(io_error)?;
        if entry
            .as_ref()
            .is_some_and(|entry| entry.deleted_at.is_none())
        {
            self.source_read_object(request, binding, object)?;
        }
        Ok(entry)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            access::{Caller, ScopeGrant},
            models::{ObjectKind, Scope},
        },
        models::*,
        workspace,
    };

    #[test]
    fn source_registry_tombstone_survives_log_expiry_and_reopen() {
        let root = tempfile::tempdir().unwrap();
        let (metadata, paths) = workspace::create_workspace(root.path(), "password").unwrap();
        let db = Database::open(&paths.db_path, root.path(), None).unwrap();
        let binding = WorkspaceBinding {
            workspace_id: metadata.workspace_id.clone(),
            generation: "generation".into(),
        };
        let mut request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "registry".into(),
            scope_grant: ScopeGrant {
                object_keys: None,
                workspace_id: metadata.workspace_id.clone(),
                workspace_content: true,
                project_ids: vec![],
                operations: vec!["source.read".into()],
            },
        };
        let todo = db
            .todo_create(TodoCreateInput {
                scope: TodoScope::Workspace,
                project_id: None,
                content: "first".into(),
                priority: "not_urgent_important".into(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
        let object = ObjectRef {
            workspace_id: metadata.workspace_id,
            scope: Scope::Workspace,
            kind: ObjectKind::Todo,
            id: todo.id.to_string(),
        };
        let entry = db
            .source_registry_entry(&request, &binding, &object)
            .unwrap()
            .unwrap();
        assert_eq!(entry.object, object);
        assert!(entry.event_revision.starts_with("sha256:"));
        assert!(entry.deleted_at.is_none());
        db.todo_delete(TodoDeleteInput { expected_revision: db.todo_record(todo.id).unwrap().revision, todo_id: todo.id })
            .unwrap();
        let deleted = db
            .source_registry_entry(&request, &binding, &object)
            .unwrap()
            .unwrap();
        assert!(deleted.seq > entry.seq);
        assert!(deleted.deleted_at.is_some());
        db.conn.execute("DELETE FROM agent_change_log", []).unwrap();
        drop(db);
        let db = Database::open(&paths.db_path, root.path(), None).unwrap();
        assert!(db
            .source_registry_entry(&request, &binding, &object)
            .unwrap()
            .unwrap()
            .deleted_at
            .is_some());
        request.scope_grant.workspace_content = false;
        assert_eq!(
            db.source_registry_entry(&request, &binding, &object)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
    }

    #[test]
    fn source_registry_invalidates_transitive_dependencies_without_rewriting_evidence() {
        let root = tempfile::tempdir().unwrap();
        let (metadata, paths) = workspace::create_workspace(root.path(), "password").unwrap();
        let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
        let todo = db
            .todo_create(TodoCreateInput {
                scope: TodoScope::Workspace,
                project_id: None,
                content: "first".into(),
                priority: "not_urgent_important".into(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
        let mut owners = vec![];
        for title in ["derived A", "derived B", "unrelated"] {
            let record = db
                .workspace_record_upsert(WorkspaceRecordUpsertInput {
                    note_id: None,
                    title: Some(title.into()),
                    markdown: title.into(),
                    html: format!("<p>{title}</p>"),
                    default_code_language: None,
                    tag_ids: vec![],
                })
                .unwrap();
            owners.push(format!(
                "{}/workspace/record/{}",
                metadata.workspace_id, record.id
            ));
        }
        let source_key = format!("{}/workspace/todo/{}", metadata.workspace_id, todo.id);
        let old_revision: String = db
            .conn
            .query_row(
                "SELECT event_revision FROM source_registry WHERE object_key=?1",
                [&source_key],
                |r| r.get(0),
            )
            .unwrap();
        for (owner, target) in [
            (&owners[0], &source_key),
            (&owners[1], &owners[0]),
            (&owners[0], &owners[1]),
        ] {
            db.conn.execute("INSERT INTO content_reference_edges(source_object_key,target_object_key,relation,target_revision) VALUES (?1,?2,'derived_from',?3)", rusqlite::params![owner,target,old_revision]).unwrap();
        }
        db.todo_update_status(TodoUpdateStatusInput { expected_revision: db.todo_record(todo.id).unwrap().revision,
            todo_id: todo.id,
            status: "finished".into(),
        })
        .unwrap();
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM source_dependency_invalidations",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            2
        );
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM content_reference_edges WHERE target_revision=?1",
                    [&old_revision],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            3
        );
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM source_dependency_invalidations WHERE owner_key=?1",
                    [&owners[2]],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        let before = db.committed_change_watermark().unwrap();
        db.conn.execute_batch("CREATE TRIGGER fail_registry_outbox BEFORE INSERT ON agent_change_log BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
        assert!(db
            .todo_delete(TodoDeleteInput { expected_revision: db.todo_record(todo.id).unwrap().revision, todo_id: todo.id })
            .is_err());
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT MAX(seq) FROM source_dependency_invalidations",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            before
        );
        let object = ObjectRef {
            workspace_id: metadata.workspace_id,
            scope: Scope::Workspace,
            kind: ObjectKind::Todo,
            id: todo.id.to_string(),
        };
        db.conn
            .execute_batch("DROP TRIGGER fail_registry_outbox")
            .unwrap();
        db.todo_delete(TodoDeleteInput { expected_revision: db.todo_record(todo.id).unwrap().revision, todo_id: todo.id })
            .unwrap();
        assert_eq!(db.conn.query_row("SELECT count(*) FROM source_dependency_invalidations WHERE reason='source_deleted' AND changed_object_key=?1", [object.key().unwrap()], |r| r.get::<_,i64>(0)).unwrap(), 2);
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM content_reference_edges WHERE target_revision=?1",
                    [&old_revision],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            3
        );
    }

    #[test]
    fn source_registry_ignores_malformed_log_keys_and_compacts_repeated_objects() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("db.sqlite"), root.path(), None).unwrap();
        for key in [
            "legacy:record:1",
            "agent_settings/workspace",
            "w/workspace/todo/01",
            "w/workspace/todo/not-an-id",
            "quote\"/workspace/todo/1",
            "w/workspace/todo/1",
        ] {
            db.conn.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES (?1,'workspace','todo.update','one','now')", [key]).unwrap();
        }
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM source_registry", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        db.conn.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES ('w/workspace/todo/1','workspace','todo.update','two','later')", []).unwrap();
        db.source_registry_reconcile().unwrap();
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM source_registry", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.conn
                .query_row("SELECT event_revision FROM source_registry", [], |r| r
                    .get::<_, String>(
                    0
                ))
                .unwrap(),
            "two"
        );
    }

    #[test]
    fn source_registry_storage_failure_rolls_back_business_and_outbox() {
        let root = tempfile::tempdir().unwrap();
        let (metadata, paths) = workspace::create_workspace(root.path(), "password").unwrap();
        let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
        let todo = db
            .todo_create(TodoCreateInput {
                scope: TodoScope::Workspace,
                project_id: None,
                content: "first".into(),
                priority: "not_urgent_important".into(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
        let binding = WorkspaceBinding {
            workspace_id: metadata.workspace_id.clone(),
            generation: "generation".into(),
        };
        let watermark = db.committed_change_watermark().unwrap();
        db.conn.execute_batch("CREATE TRIGGER fail_registry BEFORE INSERT ON source_registry BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
        let (result, event) =
            crate::committed_changes::capture_native_committed(&binding, &mut db, "failed", |db| {
                db.todo_update_status(TodoUpdateStatusInput { expected_revision: db.todo_record(todo.id).unwrap().revision,
                    todo_id: todo.id,
                    status: "finished".into(),
                })
            })
            .unwrap();
        assert!(result.is_err());
        assert!(event.is_none());
        assert_eq!(db.todo_record(todo.id).unwrap().status, "unfinished");
        assert_eq!(db.committed_change_watermark().unwrap(), watermark);
        assert_eq!(
            db.conn
                .query_row("SELECT last_change_seq FROM source_registry", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            watermark
        );
    }
    #[test]
    fn source_dependency_acknowledgement_is_scoped_and_cannot_clear_newer_changes() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("db.sqlite"), root.path(), None).unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "w_1".into(),
            generation: "g".into(),
        };
        let request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "dependency".into(),
            scope_grant: ScopeGrant {
                object_keys: None,
                workspace_id: "w_1".into(),
                workspace_content: true,
                project_ids: vec![],
                operations: vec!["knowledge.read".into(), "knowledge.write".into()],
            },
        };
        // Consumer keys are fixture graph identities, never fabricated SourceRefs
        // or business rows. Real modules register their own stable consumers.
        db.conn.execute("INSERT INTO content_reference_edges(source_object_key,target_object_key,relation) VALUES ('w_1/workspace/consumer/a','w_1/workspace/todo/1','derived_from')", []).unwrap();
        db.conn.execute("INSERT INTO content_reference_edges(source_object_key,target_object_key,relation) VALUES ('wx1/workspace/consumer/foreign','w_1/workspace/todo/1','derived_from')", []).unwrap();
        for revision in ["one", "two"] {
            db.conn.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES ('w_1/workspace/todo/1','workspace','todo.update',?1,'now')", [revision]).unwrap();
        }
        let dirty = db
            .source_dependency_invalidation(
                &request,
                &binding,
                &Scope::Workspace,
                "w_1/workspace/consumer/a",
            )
            .unwrap()
            .unwrap();
        assert_eq!(dirty.seq, 2);
        assert_eq!(dirty.reason, "source_changed");
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM source_dependency_invalidations",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            db.source_dependency_invalidation(
                &request,
                &binding,
                &Scope::Workspace,
                "wx1/workspace/consumer/foreign"
            )
            .unwrap_err()
            .code,
            ErrorCode::ScopeDenied
        );
        assert!(db
            .source_dependency_acknowledge(
                &request,
                &binding,
                &Scope::Workspace,
                "w_1/workspace/consumer/a",
                2
            )
            .is_err());
        {
            let tx = db.conn.unchecked_transaction().unwrap();
            assert!(!db
                .source_dependency_acknowledge(
                    &request,
                    &binding,
                    &Scope::Workspace,
                    "w_1/workspace/consumer/a",
                    1
                )
                .unwrap());
            assert!(db
                .source_dependency_acknowledge(
                    &request,
                    &binding,
                    &Scope::Workspace,
                    "w_1/workspace/consumer/a",
                    2
                )
                .unwrap());
            drop(tx);
        }
        assert!(db
            .source_dependency_invalidation(
                &request,
                &binding,
                &Scope::Workspace,
                "w_1/workspace/consumer/a"
            )
            .unwrap()
            .is_some());
        let tx = db.conn.unchecked_transaction().unwrap();
        assert!(db
            .source_dependency_acknowledge(
                &request,
                &binding,
                &Scope::Workspace,
                "w_1/workspace/consumer/a",
                2
            )
            .unwrap());
        tx.commit().unwrap();
        assert!(db
            .source_dependency_invalidation(
                &request,
                &binding,
                &Scope::Workspace,
                "w_1/workspace/consumer/a"
            )
            .unwrap()
            .is_none());
    }
}
