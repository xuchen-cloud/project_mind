//! Resumable metadata inventory seeds pending without reading or copying bodies.
use super::{
    agent_operations::{io_error, OperationChange},
    Database,
};
use crate::agent::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::Scope,
    overview_inventory::OverviewInventoryProgress,
};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InventoryIntent<'a> {
    workspace_id: &'a str,
    scope: &'a Scope,
    limit: u16,
}
impl Database {
    pub(crate) fn agent_overview_inventory_advance(
        &self,
        caller_id: &str,
        request_id: &str,
        workspace_id: &str,
        scope: &Scope,
        limit: u16,
    ) -> AgentResult<OverviewInventoryProgress> {
        scope.validate()?;
        if matches!(scope, Scope::Workspace) {
            return Err(AgentError::new(
                ErrorCode::SourceNotReady,
                "Workspace Overview inventory awaits M2",
            ));
        }
        self.source_live_scope(scope)?;
        if workspace_id.is_empty()
            || workspace_id.len() > 128
            || !workspace_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid Workspace identity",
            ));
        }
        if self
            .native_workspace_id
            .as_deref()
            .is_some_and(|id| id != workspace_id)
        {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Inventory Workspace is no longer current",
            ));
        }
        if !(1..=200).contains(&limit) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Inventory batch must contain 1–200 objects",
            ));
        }
        self.agent_overviews_prepare().map_err(|_| {
            AgentError::new(ErrorCode::IoFailed, "Cannot prepare Overview inventory")
        })?;
        let intent = InventoryIntent {
            workspace_id,
            scope,
            limit,
        };
        self.agent_atomic_operation(caller_id,request_id,"overview.inventory.advance",&intent,|tx|{
            self.source_live_scope(scope)?;
            let previous:Option<(String,i64,i64,i64,bool)>=tx.query_row("SELECT kind,object_id,start_seq,scanned,complete FROM agent_overview_inventory_cursors WHERE workspace_id=?1 AND scope_key=?2",params![workspace_id,scope.key()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(io_error)?;
            let (kind,id,start_seq,scanned,complete)=match previous {
                Some(previous)=>previous,
                None=>{
                    // Allocate a real positive metadata outbox sequence. This is not
                    // a source event or a fabricated semantic source revision.
                    tx.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES(?1,?2,'overview.inventory.start','directory',?3)",params![format!("overview_inventory/{}",scope.key()),scope.key(),Utc::now().to_rfc3339()]).map_err(io_error)?;
                    let start_seq=tx.last_insert_rowid();
                    tx.execute("INSERT INTO agent_overview_pending_state(scope_key,needs_rebuild) VALUES(?1,1) ON CONFLICT(scope_key) DO NOTHING",[scope.key()]).map_err(io_error)?;
                    (String::new(),0,start_seq,0,false)
                }
            };
            if complete {
                let (pending_count,needs_rebuild)=inventory_status(tx,scope)?;
                return Ok((OverviewInventoryProgress{scope:scope.clone(),start_seq:start_seq as u64,after_kind:kind,after_id:id,scanned:scanned as u64,advanced:0,directory_complete:true,pending_count,needs_rebuild},None));
            }
            let mut objects=self.agent_source_catalogue_page(workspace_id,scope,&kind,id,limit+1,true)?;
            let has_more=objects.len()>limit as usize;objects.truncate(limit as usize);
            for (kind,id,excluded) in &objects {
                let object_key=format!("{}/{}/{}/{}",workspace_id,scope.key(),kind,id);
                let registry:Option<(i64,String,bool)>=tx.query_row("SELECT last_change_seq,event_revision,deleted_at IS NOT NULL FROM source_registry WHERE object_key=?1",[&object_key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(io_error)?;
                let (seq,revision,deleted)=registry.unwrap_or((start_seq,"inventory:unprocessed".into(),false));
                // A native change/policy/tombstone row always wins over directory seed.
                tx.execute("INSERT OR IGNORE INTO agent_overview_pending(scope_key,object_key,first_seq,last_seq,operation,latest_revision,deleted,excluded) VALUES(?1,?2,?3,?3,'overview.inventory.unprocessed',?4,?5,?6)",params![scope.key(),object_key,seq,revision,deleted,excluded]).map_err(io_error)?;
            }
            let advanced=objects.len() as u16;
            let (next_kind,next_id)=objects.last().map(|(kind,id,_)|(kind.clone(),*id)).unwrap_or((kind,id));
            let scanned=scanned+advanced as i64;
            tx.execute("INSERT INTO agent_overview_inventory_cursors(workspace_id,scope_key,kind,object_id,start_seq,scanned,complete) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(workspace_id,scope_key) DO UPDATE SET kind=excluded.kind,object_id=excluded.object_id,scanned=excluded.scanned,complete=excluded.complete",params![workspace_id,scope.key(),next_kind,next_id,start_seq,scanned,!has_more]).map_err(io_error)?;
            if !has_more {tx.execute("UPDATE agent_overview_pending_state SET needs_rebuild=0 WHERE scope_key=?1",[scope.key()]).map_err(io_error)?;}
            let (pending_count,needs_rebuild)=inventory_status(tx,scope)?;
            let result=OverviewInventoryProgress{scope:scope.clone(),start_seq:start_seq as u64,after_kind:next_kind,after_id:next_id,scanned:scanned as u64,advanced,directory_complete:!has_more,pending_count,needs_rebuild};
            Ok((result,Some(OperationChange{object_key:format!("overview_inventory/{}",scope.key()),scope:scope.clone(),revision:scanned.to_string()})))
        })
    }
}
fn inventory_status(conn: &rusqlite::Connection, scope: &Scope) -> AgentResult<(u64, bool)> {
    conn.query_row("SELECT (SELECT count(*) FROM agent_overview_pending WHERE scope_key=?1),needs_rebuild FROM agent_overview_pending_state WHERE scope_key=?1",[scope.key()],|r|Ok((r.get::<_,i64>(0)? as u64,r.get(1)?))).map_err(io_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        models::{
            DocumentImportInput, ProjectCreateInput, ProjectRecordDeleteInput,
            ProjectRecordUpsertInput, TodoAddProgressInput, TodoCreateInput, TodoScope,
        },
        voice::contracts::RecordTarget,
    };
    fn setup() -> (tempfile::TempDir, Database, Scope) {
        let root = tempfile::tempdir().unwrap();
        let mut db =
            Database::open(&root.path().join("inventory.sqlite"), root.path(), None).unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Inventory".into(),
                summary: Some("private user buffer".into()),
                status: None,
            })
            .unwrap();
        (
            root,
            db,
            Scope::Project {
                project_id: project.id,
            },
        )
    }
    fn project_id(scope: &Scope) -> i64 {
        match scope {
            Scope::Project { project_id } => *project_id,
            _ => unreachable!(),
        }
    }
    fn record(db: &mut Database, scope: &Scope, title: &str) -> i64 {
        db.project_record_upsert(ProjectRecordUpsertInput {
            project_id: project_id(scope),
            note_id: None,
            title: Some(title.into()),
            html: "<p>private raw body</p>".into(),
            markdown: "private raw body".into(),
            default_code_language: None,
            tag_ids: vec![],
        })
        .unwrap()
        .id
    }
    fn advance(
        db: &Database,
        request: &str,
        scope: &Scope,
        limit: u16,
    ) -> OverviewInventoryProgress {
        db.agent_overview_inventory_advance("gui", request, "w", scope, limit)
            .unwrap()
    }
    #[test]
    fn overview_inventory_legacy_objects_without_logs_use_real_metadata_start_sequence() {
        let (_root, mut db, scope) = setup();
        let id = record(&mut db, &scope, "old");
        assert_eq!(db.committed_change_watermark().unwrap(), 0);
        let progress = advance(&db, "initial", &scope, 200);
        assert!(progress.start_seq > 0);
        assert_eq!(progress.advanced, 3);
        assert_eq!(progress.scanned, 3);
        assert!(progress.directory_complete);
        assert!(!progress.needs_rebuild);
        assert_eq!(progress.pending_count, 3);
        let (seq, revision): (i64, String) = db
            .conn
            .query_row(
                "SELECT first_seq,latest_revision FROM agent_overview_pending WHERE object_key=?1",
                [format!("w/{}/record/{id}", scope.key())],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(seq as u64, progress.start_seq);
        assert_eq!(revision, "inventory:unprocessed");
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT operation FROM agent_change_log WHERE seq=?1",
                    [progress.start_seq as i64],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "overview.inventory.start"
        );
        assert_eq!(db.conn.query_row("SELECT count(*) FROM source_registry WHERE object_key LIKE 'overview_inventory/%'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM agent_jobs", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM agent_evidence", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT content_markdown FROM notes WHERE id=?1",
                    [id],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "private raw body"
        );
    }
    #[test]
    fn overview_inventory_batch_one_reopens_and_request_replay_does_not_advance() {
        let (root, mut db, scope) = setup();
        record(&mut db, &scope, "a");
        record(&mut db, &scope, "b");
        let first = advance(&db, "page1", &scope, 1);
        assert_eq!(first.scanned, 1);
        assert!(!first.directory_complete);
        let replay = advance(&db, "page1", &scope, 1);
        assert_eq!(replay.scanned, 1);
        assert_eq!(replay.after_kind, first.after_kind);
        drop(db);
        let db = Database::open(&root.path().join("inventory.sqlite"), root.path(), None).unwrap();
        for index in 2..=4 {
            let progress = advance(&db, &format!("page{index}"), &scope, 1);
            assert_eq!(progress.scanned, index);
            assert_eq!(progress.directory_complete, index == 4);
            assert_eq!(progress.start_seq, first.start_seq);
        }
        let completed = advance(&db, "completed", &scope, 1);
        assert_eq!(completed.advanced, 0);
        assert_eq!(completed.scanned, 4);
        assert_eq!(completed.pending_count, 4);
        assert_eq!(
            db.agent_overview_inventory_advance("gui", "page1", "w", &scope, 2)
                .unwrap_err()
                .code,
            ErrorCode::IdempotencyConflict
        );
    }
    #[test]
    fn overview_inventory_catalogue_includes_excluded_while_index_backfill_selection_skips_it() {
        let (_root, mut db, scope) = setup();
        let id = record(&mut db, &scope, "excluded");
        db.agent_overviews_prepare().unwrap();
        let key = format!("w/{}/record/{id}", scope.key());
        db.conn
            .execute(
                "INSERT INTO source_access_policies(object_key,excluded,revision) VALUES(?1,1,1)",
                [&key],
            )
            .unwrap();
        let included = db
            .agent_source_catalogue_page("w", &scope, "", 0, 201, true)
            .unwrap();
        let skipped = db
            .agent_source_catalogue_page("w", &scope, "", 0, 201, false)
            .unwrap();
        assert_eq!(included.len(), 3);
        assert_eq!(skipped.len(), 2);
        assert!(included
            .iter()
            .any(|(kind, object_id, excluded)| kind == "record" && *object_id == id && *excluded));
        let complete = advance(&db, "full", &scope, 200);
        assert_eq!(complete.pending_count, 3);
        assert!(db
            .conn
            .query_row(
                "SELECT excluded FROM agent_overview_pending WHERE object_key=?1",
                [key],
                |r| r.get::<_, bool>(0)
            )
            .unwrap());
    }
    #[test]
    fn overview_inventory_log_pruning_does_not_reset_progress_or_drop_tombstone() {
        let (_root, mut db, scope) = setup();
        let deleted = record(&mut db, &scope, "delete");
        record(&mut db, &scope, "keep");
        let first = advance(&db, "page1", &scope, 1);
        db.conn
            .execute("DELETE FROM notes WHERE id=?1", [deleted])
            .unwrap();
        let key = format!("w/{}/record/{deleted}", scope.key());
        db.conn.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES(?1,?2,'record.delete','deleted','now')",params![key,scope.key()]).unwrap();
        db.conn.execute("DELETE FROM agent_change_log", []).unwrap();
        let complete = advance(&db, "page2", &scope, 200);
        assert!(complete.directory_complete);
        assert_eq!(complete.start_seq, first.start_seq);
        assert_eq!(complete.scanned, 3);
        assert_eq!(complete.pending_count, 4);
        assert!(db
            .conn
            .query_row(
                "SELECT deleted FROM agent_overview_pending WHERE object_key=?1",
                [key],
                |r| r.get::<_, bool>(0)
            )
            .unwrap());
    }
    #[test]
    fn overview_inventory_cursor_pending_receipt_and_outbox_roll_back_together() {
        let (_root, mut db, scope) = setup();
        record(&mut db, &scope, "old");
        db.agent_overviews_prepare().unwrap();
        db.conn.execute_batch("CREATE TEMP TRIGGER inventory_receipt_failure BEFORE INSERT ON agent_operation_receipts BEGIN SELECT RAISE(ABORT,'inventory receipt fixture'); END").unwrap();
        assert_eq!(
            db.agent_overview_inventory_advance("gui", "failure", "w", &scope, 200)
                .unwrap_err()
                .code,
            ErrorCode::IoFailed
        );
        for table in [
            "agent_overview_pending",
            "agent_overview_inventory_cursors",
            "agent_operation_receipts",
            "agent_change_log",
        ] {
            assert_eq!(
                db.conn
                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        assert!(
            db.agent_overview_pending_status(&scope)
                .unwrap()
                .needs_rebuild
        );
        db.conn
            .execute_batch("DROP TRIGGER inventory_receipt_failure")
            .unwrap();
        assert!(advance(&db, "retry", &scope, 200).directory_complete);
    }
    #[test]
    fn overview_inventory_all_six_business_kinds_and_subtask_is_not_an_object() {
        let (root, mut db, scope) = setup();
        record(&mut db, &scope, "record");
        let todo = db
            .todo_create(TodoCreateInput {
                scope: TodoScope::Project,
                project_id: Some(project_id(&scope)),
                content: "parent".into(),
                priority: "not_urgent_important".into(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
        db.todo_add_progress(TodoAddProgressInput {
            todo_id: todo.id,
            content: "subtask".into(),
            progress_date: "2026-10-03".into(),
            due_date: None,
        })
        .unwrap();
        db.voice_session_create(
            &RecordTarget::Project {
                project_id: project_id(&scope),
            },
            "voice-request",
            "voice-session",
            "voice",
        )
        .unwrap();
        let source = root.path().join("source.md");
        std::fs::write(&source, "file raw body").unwrap();
        db.document_import(DocumentImportInput {
            project_id: project_id(&scope),
            source_path: source.to_string_lossy().into_owned(),
            is_starred: false,
            tag_ids: None,
        })
        .unwrap();
        let complete = advance(&db, "all", &scope, 200);
        assert!(complete.directory_complete);
        let catalogue = db
            .agent_source_catalogue_page("w", &scope, "", 0, 201, true)
            .unwrap();
        let kinds: std::collections::HashSet<_> =
            catalogue.iter().map(|(kind, _, _)| kind.as_str()).collect();
        assert_eq!(kinds.len(), 6);
        assert_eq!(
            catalogue
                .iter()
                .filter(|(kind, _, _)| kind == "todo")
                .count(),
            1
        );
        assert_eq!(complete.scanned, catalogue.len() as u64);
        assert!(complete.pending_count > 0);
    }
    #[test]
    fn overview_inventory_native_late_file_before_cursor_and_record_delete_stay_pending() {
        let root = tempfile::tempdir().unwrap();
        let (metadata, paths) =
            crate::workspace::create_workspace(root.path(), "password").unwrap();
        let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Native inventory".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let scope = Scope::Project {
            project_id: project.id,
        };
        let id = record(&mut db, &scope, "delete me");
        let first = db
            .agent_overview_inventory_advance("gui", "first", &metadata.workspace_id, &scope, 1)
            .unwrap();
        assert_eq!(first.after_kind, "project");
        let source = root.path().join("late.md");
        std::fs::write(&source, "late file").unwrap();
        let file = db
            .document_import(DocumentImportInput {
                project_id: project.id,
                source_path: source.to_string_lossy().into_owned(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        db.project_record_delete(ProjectRecordDeleteInput { note_id: id })
            .unwrap();
        let complete = db
            .agent_overview_inventory_advance(
                "gui",
                "complete",
                &metadata.workspace_id,
                &scope,
                200,
            )
            .unwrap();
        assert!(complete.directory_complete);
        let file_key = format!("{}/{}/file/{}", metadata.workspace_id, scope.key(), file.id);
        let deleted_key = format!("{}/{}/record/{id}", metadata.workspace_id, scope.key());
        assert!(db
            .conn
            .query_row(
                "SELECT last_seq>?2 FROM agent_overview_pending WHERE object_key=?1",
                params![file_key, first.start_seq as i64],
                |r| r.get::<_, bool>(0)
            )
            .unwrap());
        assert!(db
            .conn
            .query_row(
                "SELECT deleted FROM agent_overview_pending WHERE object_key=?1",
                [deleted_key],
                |r| r.get::<_, bool>(0)
            )
            .unwrap());
    }
}
