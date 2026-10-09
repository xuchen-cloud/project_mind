use super::Database;
use crate::{
    agent::{
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
    },
    committed_changes::{CommittedChanges, RecordHeadChange},
    record_documents::RecordTarget,
};
use rusqlite::OptionalExtension;

fn io_error(_: rusqlite::Error) -> AgentError {
    AgentError::new(
        ErrorCode::IoFailed,
        "Cannot read committed change notifications",
    )
}
pub(super) fn object_from_key(key: &str, workspace_id: &str) -> Option<ObjectRef> {
    let parts: Vec<_> = key.split('/').collect();
    let [workspace, scope, kind, id] = parts.as_slice() else {
        return None;
    };
    if *workspace != workspace_id {
        return None;
    }
    let scope = if *scope == "workspace" {
        Scope::Workspace
    } else {
        Scope::Project {
            project_id: scope.strip_prefix("project:")?.parse().ok()?,
        }
    };
    let object = ObjectRef {
        workspace_id: workspace_id.into(),
        scope,
        kind: serde_json::from_value(serde_json::Value::String((*kind).into())).ok()?,
        id: (*id).into(),
    };
    if object.key().ok()?.as_str() != key {
        return None;
    }
    Some(object)
}
impl Database {
    pub(crate) fn gui_business_changes(
        &self,
        request: &crate::agent::access::RequestContext,
        binding: &WorkspaceBinding,
        input: &crate::agent::changes::ChangeInput,
    ) -> AgentResult<crate::agent::changes::ChangePage> {
        use crate::agent::{access::Caller, changes::ChangeRepository};
        if !matches!(request.caller, Caller::Gui) {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Workspace cache catch-up requires the GUI adapter",
            ));
        }
        request.authorize(binding, &Scope::Workspace, "changes.read")?;
        // GUI sees the whole open Workspace, including deleted Project scopes
        // needed to invalidate warm pages. Connections retain explicit grants.
        let mut statement = self.conn.prepare("SELECT DISTINCT CAST(substr(scope_key,9) AS INTEGER) FROM agent_change_log WHERE scope_key LIKE 'project:%'").map_err(io_error)?;
        let mut grant = request.scope_grant.clone();
        grant.project_ids = statement
            .query_map([], |row| row.get(0))
            .map_err(io_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io_error)?;
        self.agent_changes_list(&grant, input)
    }
    pub(crate) fn committed_change_watermark(&self) -> AgentResult<i64> {
        self.conn
            .query_row(
                "SELECT COALESCE(MAX(seq),(SELECT seq FROM sqlite_sequence WHERE name='agent_change_log'),0) FROM agent_change_log",
                [],
                |row| row.get(0),
            )
            .map_err(io_error)
    }
    pub(crate) fn committed_changes_since(
        &self,
        binding: &WorkspaceBinding,
        request_id: &str,
        after_seq: i64,
    ) -> AgentResult<Option<CommittedChanges>> {
        // Never turn uncommitted rows from an adapter-owned transaction into
        // successful events. The durable outbox is the publication boundary.
        if !self.conn.is_autocommit() {
            return Err(AgentError::new(
                ErrorCode::IoFailed,
                "Cannot publish an uncommitted transaction",
            ));
        }
        let seq = self.committed_change_watermark()?;
        if seq <= after_seq {
            return Ok(None);
        }
        let mut statement = self
            .conn
            .prepare("SELECT object_key FROM agent_change_log WHERE seq>?1 ORDER BY seq LIMIT 201")
            .map_err(io_error)?;
        let keys = statement
            .query_map([after_seq], |row| row.get::<_, String>(0))
            .map_err(io_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io_error)?;
        let reset_required = keys.len() > 200;
        let mut changed_refs = vec![];
        let mut record_heads = vec![];
        for key in keys.into_iter().take(200) {
            let Some(object) = object_from_key(&key, &binding.workspace_id) else {
                continue;
            };
            if changed_refs.contains(&object) {
                continue;
            }
            if object.kind == ObjectKind::Record {
                let target = RecordTarget {
                    scope: object.scope.clone(),
                    record_id: object.id.parse().map_err(|_| {
                        AgentError::new(ErrorCode::IoFailed, "Invalid committed Record identity")
                    })?,
                };
                let mut head_revision = self
                    .conn
                    .query_row(
                        "SELECT head_revision FROM record_document_heads WHERE record_key=?1",
                        [target.key()?],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()
                    .map_err(io_error)?
                    .map(|revision| {
                        u64::try_from(revision).map_err(|_| {
                            AgentError::new(ErrorCode::IoFailed, "Invalid committed head revision")
                        })
                    })
                    .transpose()?;
                let metadata_revision = match self.record_metadata_get(&target) {
                    Ok(metadata) => Some(metadata.revision),
                    Err(error) if error.code == ErrorCode::NotFound => None,
                    Err(error) => return Err(error),
                };
                if metadata_revision.is_none() { head_revision = None; }
                record_heads.push(RecordHeadChange {
                    binding: binding.clone(),
                    target,
                    request_id: request_id.into(),
                    head_revision,
                    metadata_revision,
                });
            }
            changed_refs.push(object);
        }
        Ok(Some(CommittedChanges {
            binding: binding.clone(),
            request_id: request_id.into(),
            seq,
            changed_refs,
            record_heads,
            reset_required,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{
        access::{Caller, RequestContext, ScopeGrant},
        changes::{ChangeInput, ChangeRepository},
    };
    use chrono::Utc;

    #[test]
    fn gui_catch_up_includes_deleted_scopes_but_connections_retain_their_grants() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("app.sqlite"), root.path(), None).unwrap();
        for (scope, key) in [
            ("workspace", "w/workspace/todo/1"),
            ("project:7", "w/project:7/project/7"),
            ("project:8", "w/project:8/project/8"),
        ] {
            db.conn.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES (?1,?2,'delete','r',?3)", rusqlite::params![key, scope, Utc::now().to_rfc3339()]).unwrap();
        }
        let binding = WorkspaceBinding {
            workspace_id: "w".into(),
            generation: "g".into(),
        };
        let mut request = RequestContext {
            binding: binding.clone(),
            request_id: "catch-up".into(),
            caller: Caller::Gui,
            scope_grant: ScopeGrant {
                object_keys: None,
                workspace_id: "w".into(),
                workspace_content: true,
                project_ids: vec![7],
                operations: vec!["changes.read".into()],
            },
        };
        let input = ChangeInput {
            after_seq: 0,
            limit: 200,
        };
        let page = db.gui_business_changes(&request, &binding, &input).unwrap();
        assert_eq!(page.entries.len(), 3);
        assert!(page
            .entries
            .iter()
            .any(|entry| entry.scope == Scope::Project { project_id: 8 }));
        request.binding.generation = "stale".into();
        assert_eq!(
            db.gui_business_changes(&request, &binding, &input)
                .unwrap_err()
                .code,
            ErrorCode::WorkspaceChanged
        );
        request.binding = binding.clone();
        request.caller = Caller::Connection {
            grant_id: "limited".into(),
        };
        assert_eq!(
            db.gui_business_changes(&request, &binding, &input)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            db.agent_changes_list(&request.scope_grant, &input)
                .unwrap()
                .entries
                .len(),
            2
        );
        request.caller = Caller::Gui;
        request.scope_grant.operations.clear();
        assert_eq!(
            db.gui_business_changes(&request, &binding, &input)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
    }

    #[test]
    fn committed_hints_are_canonical_deduplicated_bounded_and_never_uncommitted() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("app.sqlite"), root.path(), None).unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "w".into(),
            generation: "g".into(),
        };
        for key in [
            "w/workspace/todo/1",
            "w/workspace/todo/1",
            "other/workspace/todo/1",
            "w/project:07/todo/1",
        ] {
            db.conn.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES (?1,'workspace','update','r',?2)", rusqlite::params![key, Utc::now().to_rfc3339()]).unwrap();
        }
        let changes = db
            .committed_changes_since(&binding, "r", 0)
            .unwrap()
            .unwrap();
        assert_eq!(changes.seq, 4);
        assert_eq!(changes.changed_refs.len(), 1);
        assert!(!changes.reset_required);
        assert!(db
            .committed_changes_since(&binding, "r", 4)
            .unwrap()
            .is_none());
        db.conn.execute_batch("BEGIN").unwrap();
        assert_eq!(
            db.committed_changes_since(&binding, "r", 0)
                .unwrap_err()
                .code,
            ErrorCode::IoFailed
        );
        db.conn.execute_batch("ROLLBACK").unwrap();
        for i in 1..=201 {
            db.conn.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES (?1,'workspace','update','r',?2)", rusqlite::params![format!("w/workspace/todo/{i}"), Utc::now().to_rfc3339()]).unwrap();
        }
        let changes = db
            .committed_changes_since(&binding, "r", 4)
            .unwrap()
            .unwrap();
        assert!(changes.reset_required);
        assert_eq!(changes.changed_refs.len(), 200);
        assert_eq!(changes.seq, 205);
    }
    #[test]
    fn gui_catch_up_resets_after_the_last_retained_log_row_is_deleted() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("app.sqlite"), root.path(), None).unwrap();
        db.conn.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES ('w/workspace/todo/1','workspace','delete','r',?1)", [Utc::now().to_rfc3339()]).unwrap();
        db.conn.execute("DELETE FROM agent_change_log", []).unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "w".into(),
            generation: "g".into(),
        };
        let request = RequestContext {
            binding: binding.clone(),
            request_id: "catch-up".into(),
            caller: Caller::Gui,
            scope_grant: ScopeGrant {
                object_keys: None,
                workspace_id: "w".into(),
                workspace_content: true,
                project_ids: vec![],
                operations: vec!["changes.read".into()],
            },
        };
        let page = db
            .gui_business_changes(
                &request,
                &binding,
                &ChangeInput {
                    after_seq: 0,
                    limit: 200,
                },
            )
            .unwrap();
        assert!(page.reset_required);
        assert_eq!(page.cursor, 1);
        assert!(page.entries.is_empty());
    }
}
