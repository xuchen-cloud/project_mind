//! The GUI/native Todo paths must share the same CAS and immutable snapshots.
use super::*;
use crate::agent::errors::{AgentError, ErrorCode};
use std::sync::{Arc, Barrier};

fn create(db: &Database) -> TodoRecord {
    db.todo_create(TodoCreateInput {
        scope: TodoScope::Workspace,
        project_id: None,
        content: "Native Todo 原始".into(),
        priority: "normal".into(),
        due_date: None,
        tag_ids: vec![],
    })
    .unwrap()
}
fn open(root: &std::path::Path) -> Database {
    let mut db = Database::open(&root.join("todo.sqlite"), root, None).unwrap();
    db.bind_native_workspace("todo-gui-workspace").unwrap();
    db
}
fn agent_error(error: anyhow::Error) -> AgentError {
    serde_json::from_str(&error.to_string()).unwrap()
}
fn snapshots(db: &Database, id: i64) -> i64 {
    db.conn
        .query_row(
            "SELECT count(*) FROM todo_revision_snapshots WHERE todo_id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
}

#[test]
fn todo_gui_concurrent_same_revision_commits_exactly_one_business_write() {
    let root = tempfile::tempdir().unwrap();
    let db = open(root.path());
    let todo = create(&db);
    assert_eq!(todo.revision, 1);
    drop(db);
    let barrier = Arc::new(Barrier::new(2));
    let mut threads = vec![];
    for content in ["First GUI", "Second GUI"] {
        let root = root.path().to_owned();
        let barrier = barrier.clone();
        let todo = todo.clone();
        threads.push(std::thread::spawn(move || {
            let db = open(&root);
            barrier.wait();
            db.todo_update_content(TodoUpdateContentInput {
                todo_id: todo.id,
                expected_revision: todo.revision,
                content: content.into(),
                due_date: None,
                tag_ids: vec![],
            })
        }));
    }
    let results = threads
        .into_iter()
        .map(|t| t.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    let error = agent_error(results.into_iter().find_map(Result::err).unwrap());
    assert_eq!(error.code, ErrorCode::RevisionConflict);
    assert_eq!(error.details.unwrap()["currentRevision"], 2);
    let db = open(root.path());
    let current = db.todo_record(todo.id).unwrap();
    assert_eq!(current.revision, 2);
    assert!(matches!(
        current.content.as_str(),
        "First GUI" | "Second GUI"
    ));
    assert_eq!(snapshots(&db, todo.id), 2);
    assert_eq!(
        db.conn
            .query_row(
                "SELECT count(*) FROM agent_change_log WHERE operation='todo.update'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}
#[test]
fn todo_gui_children_tags_same_value_and_delete_return_real_parent_revisions() {
    let root = tempfile::tempdir().unwrap();
    let mut db = open(root.path());
    let todo = create(&db);
    let tag = db
        .file_tag_option_upsert(FileTagOptionUpsertInput {
            id: None,
            project_id: None,
            label: "Evidence".into(),
            color_key: "blue".into(),
        })
        .unwrap();
    let tagged = db
        .todo_update_tags(TodoUpdateTagsInput {
            todo_id: todo.id,
            expected_revision: 1,
            tag_ids: vec![tag.id],
        })
        .unwrap();
    assert_eq!(tagged.revision, 2);
    let child = db
        .todo_add_progress(TodoAddProgressInput {
            todo_id: todo.id,
            expected_revision: 2,
            content: "Child".into(),
            progress_date: "2026-10-01".into(),
            due_date: Some("2026-10-02".into()),
        })
        .unwrap();
    assert_eq!(child.todo_revision, 3);
    assert_eq!(
        db.todo_record(todo.id).unwrap().progresses[0].todo_revision,
        3
    );
    let child = db
        .todo_update_progress(TodoUpdateProgressInput {
            progress_id: child.id,
            expected_revision: 3,
            content: "Finished child".into(),
            progress_date: child.progress_date,
            due_date: child.due_date,
            status: Some("finished".into()),
        })
        .unwrap();
    assert_eq!(child.todo_revision, 4);
    let before_delete = todo_revisions::head(&db.conn, todo.id).unwrap();
    assert_eq!(
        todo_revisions::retained_snapshot(&db.conn, &before_delete.snapshot_ref)
            .unwrap()
            .children[0]
            .content,
        "Finished child"
    );
    let deleted = db
        .todo_delete_progress(TodoDeleteProgressInput {
            progress_id: child.id,
            expected_revision: 4,
        })
        .unwrap();
    assert_eq!(deleted.todo_revision, 5);
    assert!(db.todo_record(todo.id).unwrap().progresses.is_empty());
    let previous_hash = source_native::todo_revision(&db.todo_record(todo.id).unwrap());
    let same = db
        .todo_update_priority(TodoUpdatePriorityInput {
            todo_id: todo.id,
            expected_revision: 5,
            priority: "normal".into(),
        })
        .unwrap();
    assert_eq!(same.revision, 6);
    assert_ne!(source_native::todo_revision(&same), previous_hash);
    let deleted = db
        .todo_delete(TodoDeleteInput {
            todo_id: todo.id,
            expected_revision: 6,
        })
        .unwrap();
    assert_eq!(deleted.revision, 7);
    assert_eq!(deleted.content, todo.content);
    assert_eq!(deleted.tags[0].id, tag.id);
    assert!(todo_revisions::head(&db.conn, todo.id).is_err());
    assert_eq!(snapshots(&db, todo.id), 7);
    let final_ref: String = db
        .conn
        .query_row(
            "SELECT id FROM todo_revision_snapshots WHERE todo_id=?1 AND revision=7",
            [todo.id],
            |r| r.get(0),
        )
        .unwrap();
    let final_body = todo_revisions::retained_snapshot(&db.conn, &final_ref).unwrap();
    assert_eq!(final_body.tag_ids, vec![tag.id]);
    assert!(final_body.children.is_empty());
}
#[test]
fn todo_gui_revision_failure_rolls_back_native_body_snapshot_and_outbox() {
    let root = tempfile::tempdir().unwrap();
    let db = open(root.path());
    let todo = create(&db);
    let watermark = db.committed_change_watermark().unwrap();
    db.conn.execute_batch("CREATE TRIGGER fail_gui_revision BEFORE UPDATE ON todo_revision_heads BEGIN SELECT RAISE(ABORT,'revision failure'); END;").unwrap();
    let error = agent_error(
        db.todo_update_content(TodoUpdateContentInput {
            todo_id: todo.id,
            expected_revision: 1,
            content: "Must roll back".into(),
            due_date: None,
            tag_ids: vec![],
        })
        .unwrap_err(),
    );
    assert_eq!(error.code, ErrorCode::IoFailed);
    let current = db.todo_record(todo.id).unwrap();
    assert_eq!(current.content, todo.content);
    assert_eq!(current.revision, 1);
    assert_eq!(snapshots(&db, todo.id), 1);
    assert_eq!(db.committed_change_watermark().unwrap(), watermark);
}
#[test]
fn todo_gui_inputs_require_expected_revision_and_reads_never_initialize() {
    for value in [
        serde_json::json!({"todoId":1,"content":"new","dueDate":null}),
        serde_json::json!({"todoId":1,"status":"finished"}),
    ] {
        assert!(serde_json::from_value::<TodoUpdateContentInput>(value).is_err());
    }
    assert!(serde_json::from_value::<TodoDeleteInput>(serde_json::json!({"todoId":1})).is_err());
    let root = tempfile::tempdir().unwrap();
    let db = open(root.path());
    let todo = create(&db);
    db.conn
        .execute(
            "DELETE FROM todo_revision_heads WHERE todo_id=?1",
            [todo.id],
        )
        .unwrap();
    assert_eq!(
        agent_error(db.todo_record(todo.id).unwrap_err()).code,
        ErrorCode::SourceNotReady
    );
    assert_eq!(snapshots(&db, todo.id), 1);
}
#[test]
fn todo_gui_schema30_upgrade_backs_up_business_children_and_reopens_once() {
    let root = tempfile::tempdir().unwrap();
    let db = open(root.path());
    let todo = create(&db);
    let child = db
        .todo_add_progress(TodoAddProgressInput {
            todo_id: todo.id,
            expected_revision: 1,
            content: "Existing legacy child".into(),
            progress_date: "2026-10-01".into(),
            due_date: None,
        })
        .unwrap();
    db.conn.execute_batch("DROP VIEW agent_visible_todos; DROP TABLE todo_revision_heads; DROP TABLE todo_revision_snapshots; DROP INDEX agent_todo_output_dedupe; ALTER TABLE agent_outputs DROP COLUMN dedupe_key; PRAGMA user_version=30;").unwrap();
    drop(db);
    let db = open(root.path());
    assert_eq!(db.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
    let migrated = db.todo_record(todo.id).unwrap();
    assert_eq!(migrated.revision, 1);
    assert_eq!(migrated.progresses[0].id, child.id);
    assert_eq!(migrated.progresses[0].todo_revision, 1);
    assert_eq!(snapshots(&db, todo.id), 1);
    let backups = std::fs::read_dir(root.path().join(".project-mind/backups"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(backups.len(), 1);
    let backup = Connection::open(&backups[0]).unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        30
    );
    assert_eq!(
        backup
            .query_row(
                "SELECT content FROM todo_progresses WHERE id=?1",
                [child.id],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "Existing legacy child"
    );
    drop(db);
    let reopened = open(root.path());
    assert_eq!(snapshots(&reopened, todo.id), 1);
}
#[test]
fn todo_gui_visibility_retains_raw_history_and_missing_reference_semantics() {
    let root = tempfile::tempdir().unwrap();
    let mut db = open(root.path());
    let todo = create(&db);
    assert!(db
        .internal_reference_resolve(InternalReferenceResolveInput {
            kind: "todo".into(),
            id: 99999
        })
        .unwrap()
        .is_none());
    let snapshot = todo_revisions::head(&db.conn, todo.id).unwrap();
    let key = format!("todo-gui-workspace/workspace/todo/{}", todo.id);
    db.conn.execute("INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,revision) VALUES (?1,?2,'now',1)",params![key,"f".repeat(32)]).unwrap();
    assert!(db.workspace_todo_rail_list().unwrap().is_empty());
    assert_eq!(
        agent_error(db.todo_record(todo.id).unwrap_err()).code,
        ErrorCode::ObjectWithdrawn
    );
    assert_eq!(
        agent_error(
            db.internal_reference_resolve(InternalReferenceResolveInput {
                kind: "todo".into(),
                id: todo.id
            })
            .unwrap_err()
        )
        .code,
        ErrorCode::ObjectWithdrawn
    );
    assert_eq!(
        agent_error(
            db.todo_update_status(TodoUpdateStatusInput {
                todo_id: todo.id,
                expected_revision: 1,
                status: "finished".into()
            })
            .unwrap_err()
        )
        .code,
        ErrorCode::ObjectWithdrawn
    );
    assert_eq!(
        db.todo_record_unchecked(todo.id).unwrap().content,
        todo.content
    );
    assert_eq!(
        todo_revisions::retained_snapshot(&db.conn, &snapshot.snapshot_ref)
            .unwrap()
            .content,
        todo.content
    );
}

#[test]
fn todo_gui_tag_delete_commits_raw_hidden_heads_and_rejects_stale_gui_revision() {
    let root = tempfile::tempdir().unwrap();
    let mut db = open(root.path());
    let tag = db
        .file_tag_option_upsert(FileTagOptionUpsertInput {
            id: None,
            project_id: None,
            label: "Shared tag".into(),
            color_key: "blue".into(),
        })
        .unwrap();
    let visible = create(&db);
    let hidden = create(&db);
    for todo in [&visible, &hidden] {
        db.todo_update_tags(TodoUpdateTagsInput {
            todo_id: todo.id,
            expected_revision: 1,
            tag_ids: vec![tag.id],
        })
        .unwrap();
    }
    let hidden_before = todo_revisions::head(&db.conn, hidden.id).unwrap();
    db.conn.execute("INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,revision) VALUES (?1,?2,'now',1)",params![format!("todo-gui-workspace/workspace/todo/{}",hidden.id),"f".repeat(32)]).unwrap();
    let settings = db
        .file_tag_option_delete(FileTagOptionDeleteInput {
            project_id: None,
            tag_id: tag.id,
        })
        .unwrap();
    assert!(settings.tags.is_empty());
    for todo in [&visible, &hidden] {
        let current = db.todo_record_unchecked(todo.id).unwrap();
        assert_eq!(current.revision, 3);
        assert!(current.tags.is_empty());
        let head = todo_revisions::head(&db.conn, todo.id).unwrap();
        assert!(
            todo_revisions::retained_snapshot(&db.conn, &head.snapshot_ref)
                .unwrap()
                .tag_ids
                .is_empty()
        );
        assert_eq!(snapshots(&db, todo.id), 3);
    }
    assert_eq!(
        todo_revisions::retained_snapshot(&db.conn, &hidden_before.snapshot_ref)
            .unwrap()
            .tag_ids,
        vec![tag.id]
    );
    assert_ne!(
        todo_revisions::head(&db.conn, hidden.id).unwrap().body_hash,
        hidden_before.body_hash
    );
    let error = agent_error(
        db.todo_update_status(TodoUpdateStatusInput {
            todo_id: visible.id,
            expected_revision: 2,
            status: "finished".into(),
        })
        .unwrap_err(),
    );
    assert_eq!(error.code, ErrorCode::RevisionConflict);
    let events = db
        .conn
        .prepare("SELECT object_key FROM agent_change_log WHERE operation='todo.tags.delete'")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(
        events,
        vec![format!("todo-gui-workspace/workspace/todo/{}", visible.id)]
    );
}
#[test]
fn todo_gui_tag_delete_outbox_failure_rolls_back_tag_links_every_head_and_snapshots() {
    let root = tempfile::tempdir().unwrap();
    let mut db = open(root.path());
    let tag = db
        .file_tag_option_upsert(FileTagOptionUpsertInput {
            id: None,
            project_id: None,
            label: "Keep tag".into(),
            color_key: "blue".into(),
        })
        .unwrap();
    let first = create(&db);
    let second = create(&db);
    for todo in [&first, &second] {
        db.todo_update_tags(TodoUpdateTagsInput {
            todo_id: todo.id,
            expected_revision: 1,
            tag_ids: vec![tag.id],
        })
        .unwrap();
    }
    let watermark = db.committed_change_watermark().unwrap();
    db.conn.execute_batch("CREATE TRIGGER fail_tag_outbox BEFORE INSERT ON agent_change_log WHEN NEW.operation='todo.tags.delete' BEGIN SELECT RAISE(ABORT,'tag outbox failure'); END;").unwrap();
    assert!(db
        .file_tag_option_delete(FileTagOptionDeleteInput {
            project_id: None,
            tag_id: tag.id
        })
        .is_err());
    assert!(db.file_tag_record(tag.id).is_ok());
    for todo in [&first, &second] {
        let current = db.todo_record(todo.id).unwrap();
        assert_eq!(current.revision, 2);
        assert_eq!(current.tags[0].id, tag.id);
        assert_eq!(snapshots(&db, todo.id), 2);
        let head = todo_revisions::head(&db.conn, todo.id).unwrap();
        assert_eq!(
            todo_revisions::retained_snapshot(&db.conn, &head.snapshot_ref)
                .unwrap()
                .tag_ids,
            vec![tag.id]
        );
    }
    assert_eq!(db.committed_change_watermark().unwrap(), watermark);
}
