//! Workspace configuration and authoritative object ownership; L0 reads no bodies.
use super::Database;
use crate::agent::{
    context::ScopeIdentity,
    errors::{AgentError, AgentResult, ErrorCode},
    models::Scope,
    repository::ContextRepository,
};
use rusqlite::OptionalExtension;

#[path = "overview_context.rs"]
mod overview_context;

pub(crate) struct WorkspaceContextRepository<'a> {
    pub db: &'a Database,
    pub workspace_name: &'a str,
}
impl ContextRepository for WorkspaceContextRepository<'_> {
    fn context_entry(
        &self,
        request: &crate::agent::access::RequestContext,
        binding: &crate::agent::models::WorkspaceBinding,
        input: &crate::agent::context::ContextGetInput,
        identity: ScopeIdentity,
    ) -> AgentResult<crate::agent::context::ContextEntry> {
        self.db.agent_overview_context_entry(request, binding, input, identity)
    }
    fn scope_identity(&self, scope: &Scope) -> AgentResult<Option<ScopeIdentity>> {
        match scope {
            Scope::Workspace => Ok(Some(ScopeIdentity {
                scope: scope.clone(),
                name: self.workspace_name.into(),
                archived: false,
            })),
            Scope::Project { project_id } => self
                .db
                .conn
                .query_row(
                    "SELECT name, is_archived FROM projects WHERE id = ?1",
                    [project_id],
                    |row| {
                        Ok(ScopeIdentity {
                            scope: scope.clone(),
                            name: row.get(0)?,
                            archived: row.get(1)?,
                        })
                    },
                )
                .optional()
                .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot read project metadata")),
        }
    }
}

impl Database {
    pub(super) fn ensure_agent_schema(&mut self) -> anyhow::Result<()> {
        let savepoint = self.conn.savepoint()?;
        savepoint.execute_batch(include_str!("agent_schema.sql"))?;
        let version: i64 = savepoint.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version < super::AGENT_FOUNDATION_SCHEMA_VERSION {
            savepoint.pragma_update(
                None,
                "user_version",
                super::AGENT_FOUNDATION_SCHEMA_VERSION,
            )?;
        }
        savepoint.commit()?;
        Ok(())
    }
}
impl crate::agent::settings::SettingsRepository for Database {
    fn agent_settings_get(
        &self,
        scope: &Scope,
    ) -> AgentResult<crate::agent::settings::AgentScopeSettings> {
        use crate::agent::settings::AgentScopeSettings;
        scope.validate()?;
        self.conn.query_row(
            "SELECT enabled,goal_record_id,pinned_refs_json,summary_policy,overview_interval_hours,overview_local_time,overview_timezone,execution_mode,revision FROM agent_scope_settings WHERE scope_key=?1",
            [scope.key()], |row| {
                let pins: String = row.get(2)?;
                let policy: String = row.get(3)?;
                let mode: String = row.get(7)?;
                Ok(AgentScopeSettings { scope: scope.clone(), enabled: row.get(0)?, goal_record_id: row.get(1)?,
                    pinned_refs: decode_json(&pins)?, summary_policy: decode_json(&format!("\"{policy}\""))?,
                    overview_interval_hours: row.get(4)?, overview_local_time: row.get(5)?, overview_timezone: row.get(6)?,
                    execution_mode: decode_json(&format!("\"{mode}\""))?, revision: row.get::<_, i64>(8)? as u64 })
            }).optional().map(|settings| settings.unwrap_or_else(|| AgentScopeSettings::defaults(scope.clone())))
            .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot read assistant settings"))
    }
    fn agent_settings_update(
        &self,
        caller_id: &str,
        request_id: &str,
        input: &crate::agent::settings::SettingsUpdate,
    ) -> AgentResult<crate::agent::settings::AgentScopeSettings> {
        use super::agent_operations::{io_error, OperationChange};
        use rusqlite::params;
        input.validate()?;
        self.agent_atomic_operation(caller_id, request_id, "context.settings.update", input, |tx| {
            let revision: i64 = tx.query_row("SELECT revision FROM agent_scope_settings WHERE scope_key=?1", [input.settings.scope.key()], |row| row.get(0)).optional().map_err(io_error)?.unwrap_or(0);
            if revision as u64 != input.expected_revision {
                let current = self.agent_settings_get(&input.settings.scope)?;
                return Err(AgentError::new(ErrorCode::RevisionConflict, "Assistant settings changed; reload before saving").with_details(serde_json::json!({ "current": current })));
            }
            let mut saved = input.settings.clone(); saved.revision += 1;
            let pins = serde_json::to_string(&saved.pinned_refs).map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Invalid pins"))?;
            let policy = serde_json::to_value(saved.summary_policy).unwrap();
            let mode = serde_json::to_value(saved.execution_mode).unwrap();
            tx.execute("INSERT INTO agent_scope_settings(scope_key,enabled,goal_record_id,pinned_refs_json,summary_policy,overview_interval_hours,overview_local_time,overview_timezone,execution_mode,revision) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(scope_key) DO UPDATE SET enabled=excluded.enabled,goal_record_id=excluded.goal_record_id,pinned_refs_json=excluded.pinned_refs_json,summary_policy=excluded.summary_policy,overview_interval_hours=excluded.overview_interval_hours,overview_local_time=excluded.overview_local_time,overview_timezone=excluded.overview_timezone,execution_mode=excluded.execution_mode,revision=excluded.revision",
                params![saved.scope.key(),saved.enabled,saved.goal_record_id,pins,policy.as_str(),saved.overview_interval_hours,saved.overview_local_time,saved.overview_timezone,mode.as_str(),saved.revision as i64]).map_err(io_error)?;
            let change = OperationChange { object_key: format!("agent_settings/{}",saved.scope.key()), scope: saved.scope.clone(), revision: saved.revision.to_string() };
            Ok((saved, Some(change)))
        })
    }
}
impl crate::agent::repository::ObjectRepository for WorkspaceContextRepository<'_> {
    fn resolve_object(
        &self,
        object: &crate::agent::models::ObjectRef,
        workspace_id: &str,
    ) -> AgentResult<Option<crate::agent::models::ObjectRef>> {
        self.db.agent_resolve_object(object, workspace_id)
    }
}
impl crate::agent::settings::SettingsRepository for WorkspaceContextRepository<'_> {
    fn agent_settings_get(
        &self,
        scope: &Scope,
    ) -> AgentResult<crate::agent::settings::AgentScopeSettings> {
        self.db.agent_settings_get(scope)
    }
    fn agent_settings_update(
        &self,
        caller_id: &str,
        request_id: &str,
        input: &crate::agent::settings::SettingsUpdate,
    ) -> AgentResult<crate::agent::settings::AgentScopeSettings> {
        self.db.agent_settings_update(caller_id, request_id, input)
    }
}

fn decode_json<T: serde::de::DeserializeOwned>(text: &str) -> rusqlite::Result<T> {
    serde_json::from_str(text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

#[cfg(test)]
mod tests {
    // Remove schema30 additions before this fixture simulates an older file.
    const REMOVE_SCHEMA30: &str = r#"
DROP VIEW agent_visible_notes;
DROP VIEW agent_visible_workspace_notes;
DROP TABLE agent_object_withdrawals;
DROP INDEX idx_agent_receipt_operation_id;
DROP INDEX idx_agent_receipts_run;
ALTER TABLE agent_operation_receipts DROP COLUMN operation_id;
ALTER TABLE agent_operation_receipts DROP COLUMN run_id;
ALTER TABLE agent_operation_receipts DROP COLUMN target_ref_json;
ALTER TABLE agent_operation_receipts DROP COLUMN before_revision;
ALTER TABLE agent_operation_receipts DROP COLUMN after_revision;
ALTER TABLE agent_operation_receipts DROP COLUMN before_snapshot_ref;
ALTER TABLE agent_operation_receipts DROP COLUMN after_snapshot_ref;
ALTER TABLE agent_operation_receipts DROP COLUMN output_context_json;
ALTER TABLE agent_operation_receipts DROP COLUMN undo_state;
ALTER TABLE agent_operation_receipts DROP COLUMN undo_operation_id;
"#;

    use super::*;
    use crate::agent::settings::{AgentScopeSettings, SettingsRepository};

    #[test]
    fn agent_settings_retry_is_exactly_once_and_stale_updates_are_rejected() {
        use crate::agent::{
            access::{Caller, RequestContext, ScopeGrant},
            models::WorkspaceBinding,
            service::AgentDomainService,
            settings::SettingsUpdate,
        };
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "w".into(),
            generation: "g".into(),
        };
        let request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "configure".into(),
            scope_grant: ScopeGrant {
                workspace_id: "w".into(),
                workspace_content: true,
                project_ids: vec![],
                operations: vec!["settings.read".into(), "settings.write".into()],
            },
        };
        let repo = WorkspaceContextRepository {
            db: &db,
            workspace_name: "Work",
        };
        let service = AgentDomainService::new(&binding, &repo);
        let mut settings = AgentScopeSettings::defaults(Scope::Workspace);
        settings.enabled = true;
        let input = SettingsUpdate {
            settings,
            expected_revision: 0,
        };
        let saved = service.settings_update(&request, input.clone()).unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(
            service.settings_update(&request, input.clone()).unwrap(),
            saved
        );
        let mut changed = input.clone();
        changed.settings.overview_interval_hours = 48;
        assert_eq!(
            service.settings_update(&request, changed).unwrap_err().code,
            ErrorCode::IdempotencyConflict
        );
        let mut fresh_request = request.clone();
        fresh_request.request_id = "other".into();
        assert_eq!(
            service
                .settings_update(&fresh_request, input)
                .unwrap_err()
                .code,
            ErrorCode::RevisionConflict
        );
        assert_eq!(
            service.settings_get(&request, Scope::Workspace).unwrap(),
            saved
        );
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM agent_change_log", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn agent_failed_outbox_rolls_back_settings_and_can_retry() {
        use crate::agent::settings::SettingsUpdate;
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
        let mut settings = AgentScopeSettings::defaults(Scope::Workspace);
        settings.enabled = true;
        let input = SettingsUpdate {
            settings,
            expected_revision: 0,
        };
        db.conn.execute_batch("CREATE TRIGGER fail_agent_outbox BEFORE INSERT ON agent_change_log BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
        assert_eq!(
            db.agent_settings_update("gui", "save", &input)
                .unwrap_err()
                .code,
            ErrorCode::IoFailed
        );
        assert!(!db.agent_settings_get(&Scope::Workspace).unwrap().enabled);
        db.conn
            .execute_batch("DROP TRIGGER fail_agent_outbox;")
            .unwrap();
        assert_eq!(
            db.agent_settings_update("gui", "save", &input)
                .unwrap()
                .revision,
            1
        );
    }

    #[test]
    fn agent_user_instructions_are_versioned_and_cannot_change_scope() {
        use crate::agent::{
            instructions::{InstructionRepository, InstructionUpsert},
            settings::SummaryPolicy,
        };
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
        let input = InstructionUpsert {
            scope: Scope::Workspace,
            id: None,
            text: "Use the confirmed goal".into(),
            enabled: true,
            expected_revision: 0,
        };
        let saved = db.agent_instruction_upsert("gui", "new", &input).unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(
            db.agent_instruction_upsert("gui", "new", &input).unwrap(),
            saved
        );
        assert_eq!(
            db.agent_instructions_list(&Scope::Workspace, None, 50)
                .unwrap(),
            vec![saved.clone()]
        );
        let moved = InstructionUpsert {
            id: Some(saved.id.clone()),
            scope: Scope::Project { project_id: 1 },
            expected_revision: 1,
            ..input.clone()
        };
        assert_eq!(
            db.agent_instruction_upsert("gui", "move", &moved)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        let too_long = InstructionUpsert {
            text: "中".repeat(2001),
            ..input
        };
        assert_eq!(
            db.agent_instruction_upsert("gui", "long", &too_long)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            db.agent_settings_get(&Scope::Workspace)
                .unwrap()
                .summary_policy,
            SummaryPolicy::OnSuccess
        );
    }

    #[test]
    fn agent_changes_are_paged_and_filtered_by_the_persisted_grant() {
        use crate::agent::{
            access::ScopeGrant,
            changes::{ChangeInput, ChangeRepository},
        };
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
        db.conn.execute_batch("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES ('A','project:1','record.patch','1','2030-01-01T00:00:00+00:00'),('secret B','project:2','record.patch','2','2030-01-01T00:00:00+00:00'),('workspace','workspace','record.patch','3','2030-01-01T00:00:00+00:00'),('A2','project:1','record.patch','4','2030-01-01T00:00:00+00:00');").unwrap();
        let grant = ScopeGrant {
            workspace_id: "w".into(),
            workspace_content: false,
            project_ids: vec![1],
            operations: vec!["changes.read".into()],
        };
        let first = db
            .agent_changes_list(
                &grant,
                &ChangeInput {
                    after_seq: 0,
                    limit: 1,
                },
            )
            .unwrap();
        assert_eq!(first.entries.len(), 1);
        assert_eq!(first.entries[0].object_key, "A");
        assert!(first.has_more);
        let second = db
            .agent_changes_list(
                &grant,
                &ChangeInput {
                    after_seq: first.cursor,
                    limit: 1,
                },
            )
            .unwrap();
        assert_eq!(second.entries[0].object_key, "A2");
        assert!(!second.has_more);
        assert!(db
            .agent_changes_list(
                &grant,
                &ChangeInput {
                    after_seq: second.cursor,
                    limit: 1
                }
            )
            .unwrap()
            .entries
            .is_empty());
        assert_eq!(
            db.agent_changes_list(
                &grant,
                &ChangeInput {
                    after_seq: -1,
                    limit: 1
                }
            )
            .unwrap_err()
            .code,
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn agent_resolves_pin_ownership_and_keeps_colliding_record_ids_separate() {
        use crate::agent::{
            access::{Caller, RequestContext, ScopeGrant},
            models::{ObjectKind, ObjectRef, WorkspaceBinding},
            service::AgentDomainService,
            settings::SettingsUpdate,
        };
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
        db.conn.execute_batch("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES (1,'A','workspace:a','now','now'),(2,'B','workspace:b','now','now'); INSERT INTO notes(id,project_id,title,created_at,updated_at) VALUES(1,2,'Secret B','now','now'); INSERT INTO workspace_notes(id,title,created_at,updated_at) VALUES(1,'Workspace','now','now');").unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "w".into(),
            generation: "g".into(),
        };
        let request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "save".into(),
            scope_grant: ScopeGrant {
                workspace_id: "w".into(),
                workspace_content: true,
                project_ids: vec![1],
                operations: vec!["settings.write".into()],
            },
        };
        let repo = WorkspaceContextRepository {
            db: &db,
            workspace_name: "Work",
        };
        let service = AgentDomainService::new(&binding, &repo);
        let pin = ObjectRef {
            workspace_id: "w".into(),
            scope: Scope::Project { project_id: 1 },
            kind: ObjectKind::Record,
            id: "1".into(),
        };
        let mut settings = AgentScopeSettings::defaults(pin.scope.clone());
        settings.pinned_refs.push(pin.clone());
        assert_eq!(
            service
                .settings_update(
                    &request,
                    SettingsUpdate {
                        settings,
                        expected_revision: 0
                    }
                )
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        let mut settings = AgentScopeSettings::defaults(Scope::Workspace);
        settings.pinned_refs.push(ObjectRef {
            scope: Scope::Workspace,
            ..pin
        });
        assert!(service
            .settings_update(
                &request,
                SettingsUpdate {
                    settings,
                    expected_revision: 0
                }
            )
            .is_ok());
        let mut model = request.clone();
        model.caller = Caller::BuiltinRun {
            run_id: "model".into(),
        };
        model.request_id = "model-update".into();
        assert_eq!(
            service
                .settings_update(
                    &model,
                    SettingsUpdate {
                        settings: AgentScopeSettings::defaults(Scope::Workspace),
                        expected_revision: 0
                    }
                )
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
    }

    #[test]
    fn agent_upgrade_preserves_quick_note_and_defaults_to_disabled() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("workspace.sqlite3");
        let db = Database::open(&path, root.path(), None).unwrap();
        db.conn.execute("INSERT INTO projects (name, root_path, summary, summary_markdown, created_at, updated_at) VALUES ('Plan', 'workspace:plan', 'buffer', 'Keep this draft', 'now', 'now')", []).unwrap();
        db.conn.execute_batch(REMOVE_SCHEMA30).unwrap();
        db.conn.pragma_update(None, "user_version", 25).unwrap();
        drop(db);
        let mut db = Database::open(&path, root.path(), None).unwrap();
        assert_eq!(
            db.agent_settings_get(&Scope::Project { project_id: 1 })
                .unwrap(),
            AgentScopeSettings::defaults(Scope::Project { project_id: 1 })
        );
        db.migrate().unwrap();
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT summary_markdown FROM projects WHERE id = 1",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "Keep this draft"
        );
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM agent_jobs", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM agent_sessions", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(!db.table_exists("activities").unwrap());
        assert!(!db.table_exists("conclusions").unwrap());
    }
    #[test]
    fn agent_migration_failure_rolls_back_tables_and_schema_version() {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
        db.conn.execute_batch(REMOVE_SCHEMA30).unwrap();
        db.conn.execute_batch("DROP TABLE agent_context_instructions; DROP TABLE agent_jobs; CREATE TABLE agent_jobs(id TEXT); PRAGMA user_version=25;").unwrap();
        assert!(db.migrate().is_err());
        assert_eq!(db.schema_version().unwrap(), 25);
        assert!(!db.table_exists("agent_context_instructions").unwrap());
        db.conn.execute_batch("DROP TABLE agent_jobs;").unwrap();
        db.migrate().unwrap();
        assert_eq!(db.schema_version().unwrap(), super::super::CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn agent_schema_serializes_runs_and_deletes_only_session_owned_data() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
        let session_a = "1".repeat(32);
        let session_b = "2".repeat(32);
        for session in [&session_a, &session_b] {
            db.conn.execute("INSERT INTO agent_sessions(id,scope_key,title,runtime_id,state,session_path,created_at,updated_at) VALUES (?1,'workspace','Session','pi','active',?2,'now','now')",rusqlite::params![session,format!(".project-mind/agent/sessions/{session}/session.jsonl")]).unwrap();
        }
        db.conn.execute("INSERT INTO agent_runs(id,session_id,client_request_id,state,context_manifest_json,grant_json,started_at) VALUES ('run-a',?1,'a','running','{}','{}','now')",[&session_a]).unwrap();
        assert!(db.conn.execute("INSERT INTO agent_runs(id,session_id,client_request_id,state,context_manifest_json,grant_json,started_at) VALUES ('run-b',?1,'b','preparing','{}','{}','now')",[&session_b]).is_err());
        db.conn.execute_batch("UPDATE agent_runs SET state='completed' WHERE id='run-a'; INSERT INTO agent_messages(id,session_id,run_id,runtime_entry_id,role,content_json,state,ordinal,created_at) SELECT 'message',session_id,id,'pi-entry','assistant','{}','complete',0,'now' FROM agent_runs; INSERT INTO agent_outputs(id,run_id,ordinal,kind,intent,payload_json,sources_json,state) VALUES ('saved-output','run-a',0,'record','create','{}','[]','committed'); INSERT INTO agent_evidence VALUES ('message-evidence','message','message','{}','Original message'),('saved-evidence','output','saved-output','{}','Saved result'); INSERT INTO agent_operation_receipts(request_id,caller_id,payload_hash,operation,state,result_json,error,created_at) VALUES ('save','gui','sha256:x','record.create','committed','{}',NULL,'now');").unwrap();
        db.conn
            .execute("DELETE FROM agent_sessions WHERE id=?1", [&session_a])
            .unwrap();
        for table in ["agent_runs", "agent_messages", "agent_outputs"] {
            assert_eq!(
                db.conn
                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        assert_eq!(
            db.conn
                .query_row("SELECT excerpt FROM agent_evidence", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "Saved result"
        );
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM agent_operation_receipts", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
    }

    #[test]
    fn agent_identity_needs_no_quick_note_or_record_columns() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE projects(id INTEGER PRIMARY KEY, name TEXT, is_archived INTEGER);
            INSERT INTO projects VALUES (7, 'Design', 0);",
        )
        .unwrap();
        let db = Database {
            conn,
            workspace_root: Default::default(),
            secret_password: None,
            native_workspace_id: None,
        };
        let repository = WorkspaceContextRepository {
            db: &db,
            workspace_name: "Work",
        };
        let project = repository
            .scope_identity(&Scope::Project { project_id: 7 })
            .unwrap()
            .unwrap();
        assert_eq!(project.name, "Design");
        assert!(repository
            .scope_identity(&Scope::Project { project_id: 8 })
            .unwrap()
            .is_none());
        assert_eq!(
            repository
                .scope_identity(&Scope::Workspace)
                .unwrap()
                .unwrap()
                .name,
            "Work"
        );
    }
}
