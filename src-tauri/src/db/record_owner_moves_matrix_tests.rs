use super::*;
use crate::{
    record_documents::{RecordDocumentProjection, RecordTarget},
    record_owner_moves::RecordOwnerMoveInput,
};
use rusqlite::params;

fn setup() -> (tempfile::TempDir, Database, RequestContext, RecordTarget) {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Database::open(&dir.path().join("db.sqlite"), dir.path(), None).unwrap();
    db.conn.execute_batch("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES(1,'A','workspace:a','now','now'),(2,'B','workspace:b','now','now'); INSERT INTO notes(id,project_id,title,created_at,updated_at) VALUES(1,1,'collision','now','now');").unwrap();
    let p: RecordDocumentProjection =
        serde_json::from_str(include_str!("../record_document_projection.fixture.json")).unwrap();
    for path in ["assets/图片.png", "assets/文件.pdf"] {
        let path = dir.path().join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"retained").unwrap();
    }
    let row = db
        .workspace_record_upsert(WorkspaceRecordUpsertInput {
            note_id: None,
            title: Some("moving".into()),
            html: p.html.clone(),
            markdown: p.markdown.clone(),
            default_code_language: p.code_language.clone(),
            tag_ids: vec![],
        })
        .unwrap();
    let target = RecordTarget {
        scope: Scope::Workspace,
        record_id: row.id,
    };
    let source = db.record_document_source(&target).unwrap();
    db.record_document_initialize("gui", "init", &target, &source.source_hash, &p, "test")
        .unwrap();
    db.ensure_record_owner_moves_schema().unwrap();
    db.bind_native_workspace("test").unwrap();
    let request = RequestContext {
        binding: WorkspaceBinding {
            workspace_id: "test".into(),
            generation: "open".into(),
        },
        request_id: "move-1".into(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: "test".into(),
            workspace_content: true,
            project_ids: vec![1, 2],
            operations: vec!["record.move".into(), "source.read".into()],
            object_keys: None,
        },
    };
    (dir, db, request, target)
}
fn input(db: &Database, source: &RecordTarget, destination: Scope) -> RecordOwnerMoveInput {
    let head = db.record_document_head(source).unwrap().unwrap();
    RecordOwnerMoveInput {
        source: source.clone(),
        destination,
        head_revision: head.head_revision,
        body_hash: head.projection.body_hash,
        metadata_revision: db.record_metadata_get(source).unwrap().revision,
    }
}
fn versions(db: &Database) -> Vec<String> {
    let mut q=db.conn.prepare("SELECT json_array(id,version_number,head_revision,document_snapshot,html,markdown,text,schema_version,code_language,title_snapshot,body_hash,origin,actor_json,operation_id,restored_from_version_id,created_at) FROM record_versions ORDER BY id").unwrap();
    q.query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}
#[test]
fn g13_three_directions_colliding_ids_versions_resources_and_replay() {
    let (dir, db, mut r, old) = setup();
    let before = versions(&db);
    let first = input(&db, &old, Scope::Project { project_id: 1 });
    let a = db.record_owner_move(&r, &r.binding, &first).unwrap();
    assert_ne!(a.target.record_id, 1);
    assert_eq!(versions(&db), before);
    assert_eq!(
        db.record_owner_move(&r, &r.binding, &first)
            .unwrap()
            .operation_id,
        a.operation_id
    );
    r.request_id = "move-2".into();
    let b = db
        .record_owner_move(
            &r,
            &r.binding,
            &input(&db, &a.target, Scope::Project { project_id: 2 }),
        )
        .unwrap();
    r.request_id = "move-3".into();
    let w = db
        .record_owner_move(&r, &r.binding, &input(&db, &b.target, Scope::Workspace))
        .unwrap();
    assert_eq!(a.logical_id, b.logical_id);
    assert_eq!(a.logical_id, w.logical_id);
    assert_eq!(versions(&db), before);
    assert_eq!(
        db.record_resolve_location(&old)
            .unwrap()
            .target
            .key()
            .unwrap(),
        w.target.key().unwrap()
    );
    assert_eq!(
        db.conn
            .query_row("SELECT title FROM notes WHERE id=1", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "collision"
    );
    for path in ["assets/图片.png", "assets/文件.pdf"] {
        assert_eq!(std::fs::read(dir.path().join(path)).unwrap(), b"retained");
    }
    assert_eq!(
        db.conn
            .query_row("SELECT count(*) FROM record_version_assets", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        db.conn
            .query_row(
                "SELECT count(*) FROM agent_change_log WHERE operation='record.owner.move'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        6
    );
    assert_eq!(
        db.conn
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        0
    );
}
#[test]
fn g13_cas_replay_binding_archive_and_transaction_failure() {
    let (_dir, db, mut r, source) = setup();
    let mut i = input(&db, &source, Scope::Project { project_id: 1 });
    i.body_hash = "sha256:stale".into();
    assert_eq!(
        db.record_owner_move(&r, &r.binding, &i).unwrap_err().code,
        crate::agent::errors::ErrorCode::RevisionConflict
    );
    i = input(&db, &source, Scope::Project { project_id: 1 });
    db.conn.execute_batch("CREATE TRIGGER fail_move BEFORE INSERT ON agent_change_log WHEN NEW.operation='record.owner.move' BEGIN SELECT RAISE(FAIL,'disk full'); END;").unwrap();
    assert!(db.record_owner_move(&r, &r.binding, &i).is_err());
    assert!(db.record_document_head(&source).unwrap().is_some());
    assert_eq!(
        db.conn
            .query_row("SELECT count(*) FROM record_logical_identities", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    assert_eq!(
        db.conn
            .query_row("SELECT count(*) FROM notes", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    db.conn
        .execute_batch("DROP TRIGGER fail_move; UPDATE projects SET is_archived=1 WHERE id=1")
        .unwrap();
    assert!(db.record_owner_move(&r, &r.binding, &i).is_err());
    db.conn
        .execute("UPDATE projects SET is_archived=0 WHERE id=1", [])
        .unwrap();
    db.record_owner_move(&r, &r.binding, &i).unwrap();
    let mut changed = i.clone();
    changed.destination = Scope::Project { project_id: 2 };
    assert_eq!(
        db.record_owner_move(&r, &r.binding, &changed)
            .unwrap_err()
            .code,
        crate::agent::errors::ErrorCode::IdempotencyConflict
    );
    r.binding.generation = "different".into();
    let actual = WorkspaceBinding {
        generation: "open".into(),
        ..r.binding.clone()
    };
    assert_eq!(
        db.record_owner_move(&r, &actual, &i).unwrap_err().code,
        crate::agent::errors::ErrorCode::WorkspaceChanged
    );
}

#[test]
fn g13_move_old_reads_actual_owner_and_stale_editor_writes_reject() {
    let (_dir, db, mut r, old) = setup();
    let historic_revision = db
        .source_record_fingerprint(
            &r,
            &r.binding,
            &crate::source_service::SourceReadTarget {
                object: ObjectRef {
                    workspace_id: "test".into(),
                    scope: old.scope.clone(),
                    kind: ObjectKind::Record,
                    id: old.record_id.to_string(),
                },
                revision: None,
                record_version: Some(1),
                file_version: None,
            },
        )
        .unwrap()
        .revision;
    let first = input(&db, &old, Scope::Project { project_id: 1 });
    let a = db.record_owner_move(&r, &r.binding, &first).unwrap();
    r.request_id = "second".into();
    let b = db
        .record_owner_move(
            &r,
            &r.binding,
            &input(&db, &a.target, Scope::Project { project_id: 2 }),
        )
        .unwrap();
    let old_object = ObjectRef {
        workspace_id: "test".into(),
        scope: old.scope.clone(),
        kind: ObjectKind::Record,
        id: old.record_id.to_string(),
    };
    let historic_ref = crate::agent::models::SourceRef {
        object: old_object.clone(),
        revision: historic_revision,
        file_version: None,
        record_version: Some(1),
        block_id: None,
        locator: None,
        title: "historic".into(),
        excerpt: String::new(),
    };
    r.scope_grant.workspace_content = false;
    r.scope_grant.project_ids = vec![1];
    assert_eq!(
        db.agent_source_resolve(&r, &r.binding, &historic_ref)
            .unwrap_err()
            .code,
        crate::agent::errors::ErrorCode::ScopeDenied
    );
    assert_eq!(
        db.source_read_object(&r, &r.binding, &old_object)
            .unwrap_err()
            .code,
        crate::agent::errors::ErrorCode::ScopeDenied
    );
    r.scope_grant.project_ids = vec![2];
    let nav = db
        .agent_source_resolve(&r, &r.binding, &historic_ref)
        .unwrap();
    assert_eq!(nav.object.scope, b.target.scope);
    assert_eq!(nav.object.id, b.target.record_id.to_string());
    assert_eq!(
        nav.record_target.unwrap().key().unwrap(),
        b.target.key().unwrap()
    );
    assert_eq!(
        nav.status,
        crate::agent::source_navigation::SourceNavigationStatus::Historical
    );
    let actual = db.source_read_object(&r, &r.binding, &old_object).unwrap();
    assert_eq!(actual.id, b.target.record_id.to_string());
    assert_eq!(actual.scope, b.target.scope);
    r.scope_grant.object_keys = Some(vec![old_object.key().unwrap()]);
    assert!(db.source_read_object(&r, &r.binding, &old_object).is_err());
    r.scope_grant.object_keys = None;
    assert_eq!(
        db.record_editor_state(&old)
            .unwrap()
            .head
            .target
            .key()
            .unwrap(),
        b.target.key().unwrap()
    );
    assert!(!db
        .record_versions_list(&old, None, 100)
        .unwrap()
        .versions
        .is_empty());
    assert_eq!(
        db.record_require_current_location(&old).unwrap_err().code,
        crate::agent::errors::ErrorCode::SourceChanged
    );
    let project_ref =
        super::super::record_owner_moves::resolve_legacy(&db.conn, "note", a.target.record_id)
            .unwrap()
            .unwrap();
    assert_eq!(project_ref.key().unwrap(), b.target.key().unwrap());
    let route = db
        .record_move_reference_route("workspace_record", old.record_id)
        .unwrap()
        .unwrap();
    assert_eq!(route.id, b.target.record_id);
    assert_eq!(route.project_id, Some(2));
}
#[test]
fn g13_tags_map_by_label_color_and_source_definitions_survive() {
    let (_dir, db, r, source) = setup();
    db.conn.execute_batch("INSERT INTO file_tag_options(id,project_id,label,color_key,created_at,updated_at) VALUES(1,NULL,'Decision','blue','now','now'),(2,1,'decision','blue','now','now');").unwrap();
    db.conn
        .execute(
            "INSERT INTO workspace_note_tag_links VALUES(?1,1,'now')",
            [source.record_id],
        )
        .unwrap();
    let moved = db
        .record_owner_move(
            &r,
            &r.binding,
            &input(&db, &source, Scope::Project { project_id: 1 }),
        )
        .unwrap();
    assert_eq!(
        db.record_metadata_get(&moved.target).unwrap().tag_ids,
        vec![2]
    );
    assert_eq!(
        db.conn
            .query_row("SELECT label FROM file_tag_options WHERE id=1", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
        "Decision"
    );
    assert_eq!(db.record_metadata_get(&source).unwrap().tag_ids, vec![2]);
}
#[test]
fn g13_voice_active_rejects_finished_session_tracks_and_transcript_survive() {
    let (dir, db, mut r, source) = setup();
    db.conn.execute("INSERT INTO voice_records(project_note_id,workspace_note_id,created_at) VALUES(NULL,?1,'now')",[source.record_id]).unwrap();
    let voice = db.conn.last_insert_rowid();
    db.conn.execute("INSERT INTO recording_sessions(id,voice_record_id,request_id,lifecycle,started_at) VALUES('session',?1,'voice','paused','now')",[voice]).unwrap();
    let i = input(&db, &source, Scope::Project { project_id: 1 });
    assert_eq!(
        db.record_owner_move(&r, &r.binding, &i).unwrap_err().code,
        crate::agent::errors::ErrorCode::RunBusy
    );
    db.conn
        .execute(
            "UPDATE recording_sessions SET lifecycle='ended',ended_at='now'",
            [],
        )
        .unwrap();
    std::fs::write(dir.path().join("track.wav"), b"voice").unwrap();
    db.conn.execute("INSERT INTO voice_audio_chunks(session_id,source,epoch,chunk_index,start_sample,sample_count,sample_rate,channels,relative_path,byte_size,state,created_at) VALUES('session','microphone',1,0,0,3,16000,1,'track.wav',5,'complete','now')",[]).unwrap();
    db.conn.execute("INSERT INTO voice_transcript_segments(id,session_id,start_ms,end_ms,text,created_at) VALUES('segment','session',0,500,'保留转写','now')", []).unwrap();
    r.request_id = "ended".into();
    let moved = db.record_owner_move(&r, &r.binding, &i).unwrap();
    assert_eq!(
        db.conn
            .query_row(
                "SELECT project_note_id FROM voice_records WHERE id=?1",
                [voice],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        moved.target.record_id
    );
    assert_eq!(
        db.conn
            .query_row(
                "SELECT count(*) FROM voice_audio_chunks WHERE session_id='session'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(db.conn.query_row("SELECT text FROM voice_transcript_segments WHERE id='segment' AND session_id='session'", [], |r| r.get::<_, String>(0)).unwrap(), "保留转写");
    assert_eq!(
        std::fs::read(dir.path().join("track.wav")).unwrap(),
        b"voice"
    );
}

async fn converted(
    document: serde_json::Value,
    language: Option<String>,
) -> RecordDocumentProjection {
    let worker = crate::record_document_worker::RecordDocumentWorker::development().unwrap();
    let result = worker
        .request(
            "g13-canonical",
            "record.validate",
            serde_json::json!({"document":document,"codeLanguage":language}),
        )
        .await
        .unwrap();
    serde_json::from_value(result).unwrap()
}
async fn save_document(db: &Database, target: &RecordTarget, document: serde_json::Value) {
    let old = db.record_document_head(target).unwrap().unwrap();
    let p = converted(document, old.projection.code_language).await;
    db.record_document_commit(
        "gui",
        "body-before-move",
        &crate::record_documents::RecordDocumentCommit {
            target: target.clone(),
            base_revision: old.head_revision,
            projection: p,
            origin: crate::record_documents::RecordVersionOrigin::EditorAi,
            actor: serde_json::json!({"kind":"gui"}),
            edit_session_id: None,
        },
        "test",
    )
    .unwrap();
}
#[tokio::test]
#[ignore = "requires prepared pinned canonical worker; run g13_worker_ explicitly"]
async fn g13_worker_current_tag_mentions_append_versions_while_all_original_history_is_immutable() {
    let (_dir, db, mut r, source) = setup();
    db.conn.execute_batch("INSERT INTO file_tag_options(id,project_id,label,color_key,created_at,updated_at) VALUES(1,NULL,'Decision','blue','now','now');").unwrap();
    db.conn
        .execute(
            "INSERT INTO workspace_note_tag_links VALUES(?1,1,'now')",
            [source.record_id],
        )
        .unwrap();
    let mut doc = db
        .record_document_head(&source)
        .unwrap()
        .unwrap()
        .projection
        .document;
    doc["content"][0]["content"].as_array_mut().unwrap().push(serde_json::json!({"type":"tagMention","attrs":{"tagId":1,"label":"Decision","colorKey":"blue"}}));
    save_document(&db, &source, doc).await;
    let before = versions(&db);
    let original_context:Vec<(String,String)>=db.conn.prepare("SELECT version_id,original_record_key FROM record_version_owner_context ORDER BY version_id").unwrap().query_map([],|r|Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<Result<_,_>>().unwrap();
    let mut current = source.clone();
    let mut logical = None;
    for (n, destination) in [
        Scope::Project { project_id: 1 },
        Scope::Project { project_id: 2 },
        Scope::Workspace,
    ]
    .into_iter()
    .enumerate()
    {
        r.request_id = format!("tag-move-{n}");
        let i = input(&db, &current, destination);
        let plan = db.record_owner_move_prepare(&r, &r.binding, &i).unwrap();
        assert!(plan.needs_projection);
        let p = converted(plan.document.clone(), plan.code_language.clone()).await;
        let moved = db
            .record_owner_move_commit(&r, &r.binding, &i, &plan, Some(&p))
            .unwrap();
        if let Some(id) = &logical {
            assert_eq!(id, &moved.logical_id);
        } else {
            logical = Some(moved.logical_id.clone());
        }
        let tags = db.record_metadata_get(&moved.target).unwrap().tag_ids;
        assert_eq!(
            db.record_document_head(&source)
                .unwrap()
                .unwrap()
                .projection
                .document["content"][0]["content"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()["attrs"]["tagId"],
            serde_json::json!(tags[0])
        );
        current = moved.target;
    }
    let after = versions(&db);
    for original in &before {
        assert!(after.contains(original));
    }
    assert_eq!(after.len(), before.len() + 3);
    for (id, key) in original_context {
        assert_eq!(db.conn.query_row("SELECT original_record_key FROM record_version_owner_context WHERE version_id=?1",[id],|r|r.get::<_,String>(0)).unwrap(),key);
    }
    assert_eq!(
        db.conn
            .query_row("SELECT count(*) FROM file_tag_options", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        3
    );
}
#[tokio::test]
#[ignore = "requires prepared pinned canonical worker; run g13_worker_ explicitly"]
async fn g13_worker_invalid_reference_set_is_explicit_and_no_partial_move_or_tag_creation_survives()
{
    let (_dir, mut db, r, source) = setup();
    let p = db
        .record_document_head(&source)
        .unwrap()
        .unwrap()
        .projection;
    let other = db
        .workspace_record_upsert(WorkspaceRecordUpsertInput {
            note_id: None,
            title: Some("other".into()),
            html: String::new(),
            markdown: String::new(),
            default_code_language: None,
            tag_ids: vec![],
        })
        .unwrap();
    db.conn.execute_batch("INSERT INTO notes(id,project_id,title,created_at,updated_at) VALUES(2,2,'B ref','now','now'); INSERT INTO file_tag_options(id,project_id,label,color_key,created_at,updated_at) VALUES(1,NULL,'mapped','blue','now','now');").unwrap();
    db.conn
        .execute(
            "INSERT INTO workspace_note_tag_links VALUES(?1,1,'now')",
            [source.record_id],
        )
        .unwrap();
    let mut doc = p.document;
    let nodes = doc["content"][0]["content"].as_array_mut().unwrap();
    for (kind, id) in [("workspace_record", other.id), ("note", 2)] {
        nodes.push(serde_json::json!({"type":"internalReference","attrs":{"refKind":kind,"refId":id,"sourceRef":null,"label":"ref"}}));
    }
    save_document(&db, &source, doc).await;
    let e = db
        .record_owner_move(
            &r,
            &r.binding,
            &input(&db, &source, Scope::Project { project_id: 1 }),
        )
        .unwrap_err();
    assert_eq!(e.code, crate::agent::errors::ErrorCode::ScopeDenied);
    assert_eq!(
        e.details.unwrap()["references"].as_array().unwrap().len(),
        2
    );
    assert_eq!(
        db.conn
            .query_row("SELECT count(*) FROM file_tag_options", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(db.record_document_head(&source).unwrap().is_some());
    assert_eq!(
        db.conn
            .query_row("SELECT count(*) FROM record_logical_identities", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
}
#[test]
fn g13_tag_plan_race_and_color_conflict_leave_source_untouched() {
    let (_dir, db, r, source) = setup();
    db.conn.execute_batch("INSERT INTO file_tag_options(id,project_id,label,color_key,created_at,updated_at) VALUES(1,NULL,'decision','blue','now','now');").unwrap();
    db.conn
        .execute(
            "INSERT INTO workspace_note_tag_links VALUES(?1,1,'now')",
            [source.record_id],
        )
        .unwrap();
    let i = input(&db, &source, Scope::Project { project_id: 1 });
    let plan = db.record_owner_move_prepare(&r, &r.binding, &i).unwrap();
    db.conn.execute_batch("INSERT INTO file_tag_options(id,project_id,label,color_key,created_at,updated_at) VALUES(10,1,'decision','blue','now','now');").unwrap();
    assert_eq!(
        db.record_owner_move_commit(&r, &r.binding, &i, &plan, None)
            .unwrap_err()
            .code,
        crate::agent::errors::ErrorCode::RevisionConflict
    );
    db.conn
        .execute(
            "UPDATE file_tag_options SET color_key='red' WHERE id=10",
            [],
        )
        .unwrap();
    let e = db.record_owner_move(&r, &r.binding, &i).unwrap_err();
    assert_eq!(e.code, crate::agent::errors::ErrorCode::RevisionConflict);
    assert_eq!(e.details.unwrap()["label"], "decision");
}

#[test]
fn g13_closed_fence_and_owner_lease_wait_do_not_enter_sql_or_hold_fence() {
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    let (dir, db, r, source) = setup();
    let fence = Arc::new(crate::workspace_commit_fence::WorkspaceCommitFence::new());
    let owner = db.file_project_lock(Some(1), true).unwrap();
    let root = dir.path().to_path_buf();
    let i = input(&db, &source, Scope::Project { project_id: 1 });
    let mover_fence = fence.clone();
    let (start_tx, start_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        let mut other = Database::open(&root.join("db.sqlite"), &root, None).unwrap();
        other.bind_native_workspace("test").unwrap();
        other.bind_file_commit_fence(mover_fence);
        start_tx.send(()).unwrap();
        done_tx
            .send(other.record_owner_move(&r, &r.binding, &i))
            .unwrap();
    });
    start_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let f = fence.clone();
    let (fence_tx, fence_rx) = mpsc::channel();
    let close = std::thread::spawn(move || {
        f.invalidate();
        fence_tx.send(()).unwrap();
    });
    fence_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("owner wait must not retain Workspace fence");
    assert!(done_rx.recv_timeout(Duration::from_millis(40)).is_err());
    drop(owner);
    assert_eq!(
        done_rx
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap_err()
            .code,
        crate::agent::errors::ErrorCode::WorkspaceChanged
    );
    thread.join().unwrap();
    close.join().unwrap();
    assert!(db.record_document_head(&source).unwrap().is_some());
}

#[path = "record_owner_moves_service_tests.rs"]
mod service;

#[test]
fn g13_prior_operation_undo_after_repeated_moves_uses_actual_owner_without_rewriting_receipt() {
    use crate::record_documents::{body_hash, RecordDocumentCommit, RecordVersionOrigin};
    let (_dir, db, mut r, source) = setup();
    let before = db.record_document_head(&source).unwrap().unwrap();
    let before_version = db.record_versions_list(&source, None, 10).unwrap().versions[0]
        .id
        .clone();
    let mut after = before.projection.clone();
    after.code_language = Some("rust".into());
    after.body_hash = body_hash(&after.document, &after.code_language);
    let saved = db
        .record_document_commit(
            "gui",
            "native-edit",
            &RecordDocumentCommit {
                target: source.clone(),
                base_revision: 1,
                projection: after.clone(),
                origin: RecordVersionOrigin::EditorAi,
                actor: serde_json::json!({"kind":"gui"}),
                edit_session_id: None,
            },
            "test",
        )
        .unwrap();
    let object = ObjectRef {
        workspace_id: "test".into(),
        scope: source.scope.clone(),
        kind: ObjectKind::Record,
        id: source.record_id.to_string(),
    };
    let raw = serde_json::to_string(&object).unwrap();
    let operation = "f".repeat(32);
    let metadata = db.record_metadata_get(&source).unwrap();
    db.conn.execute("INSERT INTO agent_operation_receipts(caller_id,request_id,payload_hash,operation,state,result_json,created_at,operation_id,target_ref_json,before_revision,after_revision,before_snapshot_ref,after_snapshot_ref,output_context_json,undo_state) VALUES('gui','receipt-fixture','hash','record.patch','committed','{}','now',?1,?2,1,2,?3,?4,?5,'available')",params![operation,raw,before_version,saved.after_version,serde_json::json!({"afterBodyHash":after.body_hash,"afterMetadata":metadata}).to_string()]).unwrap();
    let a = db
        .record_owner_move(
            &r,
            &r.binding,
            &input(&db, &source, Scope::Project { project_id: 1 }),
        )
        .unwrap();
    r.request_id = "second-move".into();
    let b = db
        .record_owner_move(
            &r,
            &r.binding,
            &input(&db, &a.target, Scope::Project { project_id: 2 }),
        )
        .unwrap();
    r.scope_grant
        .operations
        .extend(["operation.read".into(), "operation.undo".into()]);
    r.scope_grant.workspace_content = true;
    r.scope_grant.project_ids = vec![1];
    assert_eq!(
        db.agent_operation_get(&r, &r.binding, &operation)
            .unwrap_err()
            .code,
        crate::agent::errors::ErrorCode::ScopeDenied
    );
    r.scope_grant.workspace_content = false;
    r.scope_grant.project_ids = vec![2];
    r.request_id = "undo-after-moves".into();
    assert_eq!(
        db.agent_operation_get(&r, &r.binding, &operation)
            .unwrap()
            .object
            .scope,
        Scope::Project { project_id: 2 }
    );
    let result = db
        .agent_record_undo_commit(
            &r,
            &r.binding,
            &crate::agent::operations::OperationUndoInput {
                operation_id: operation.clone(),
                expected_head_revision: 2,
            },
            &before.projection,
        )
        .unwrap();
    assert_eq!(result.head.target.key().unwrap(), b.target.key().unwrap());
    assert_eq!(result.head.body_hash, before.projection.body_hash);
    assert_eq!(result.head.head_revision, 3);
    assert_eq!(
        db.conn
            .query_row(
                "SELECT target_ref_json FROM agent_operation_receipts WHERE operation_id=?1",
                [operation],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        raw
    );
}

#[tokio::test]
#[ignore = "requires prepared pinned canonical worker; run g13_worker_ explicitly"]
async fn g13_worker_project_assets_remain_scoped_and_block_source_root_cleanup() {
    let (dir, mut db, mut r, source) = setup();
    let a = db
        .record_owner_move(
            &r,
            &r.binding,
            &input(&db, &source, Scope::Project { project_id: 1 }),
        )
        .unwrap();
    let relative = "a/.project-mind/embedded-note-assets/project/retained.png";
    let file = dir.path().join(relative);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, b"retained-project-image").unwrap();
    let mut document = db
        .record_document_head(&a.target)
        .unwrap()
        .unwrap()
        .projection
        .document;
    let mut image = document["content"][2].clone();
    image["attrs"]["blockId"] = serde_json::json!("e".repeat(32));
    image["attrs"]["path"] = serde_json::json!(relative);
    document["content"].as_array_mut().unwrap().push(image);
    save_document(&db, &a.target, document).await;
    r.request_id = "project-resource-move".into();
    let b = db
        .record_owner_move(
            &r,
            &r.binding,
            &input(&db, &a.target, Scope::Project { project_id: 2 }),
        )
        .unwrap();
    assert_eq!(std::fs::read(&file).unwrap(), b"retained-project-image");
    assert!(db
        .project_delete(crate::models::ProjectDeleteInput { project_id: 1 })
        .is_err());
    assert_eq!(std::fs::read(&file).unwrap(), b"retained-project-image");
    assert!(db
        .conn
        .execute(
            "UPDATE projects SET root_path='workspace:elsewhere' WHERE id=1",
            []
        )
        .is_err());
    let mut doc = db
        .record_document_head(&b.target)
        .unwrap()
        .unwrap()
        .projection
        .document;
    doc["content"][0]["content"][0]["text"] = serde_json::json!("saved after move");
    let portable = db.record_document_from_gui(&b.target, &doc).unwrap();
    let p = converted(portable, None).await;
    let rev = db
        .record_document_head(&b.target)
        .unwrap()
        .unwrap()
        .head_revision;
    db.record_document_commit(
        "gui",
        "after-resource-move",
        &crate::record_documents::RecordDocumentCommit {
            target: b.target.clone(),
            base_revision: rev,
            projection: p,
            origin: crate::record_documents::RecordVersionOrigin::EditorAi,
            actor: serde_json::json!({"kind":"gui"}),
            edit_session_id: None,
        },
        "test",
    )
    .unwrap();
    let state = db.record_editor_state(&a.target).unwrap();
    match state.record {
        crate::record_documents::RecordEditorRecord::Project(record) => {
            assert!(record.content_html.contains("retained.png"))
        }
        _ => panic!("expected actual Project editor"),
    }
    let mut forbidden = doc;
    forbidden["content"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap()["attrs"]["path"] = serde_json::json!("a/private.txt");
    assert_eq!(
        db.record_document_from_gui(&b.target, &forbidden)
            .unwrap_err()
            .code,
        crate::agent::errors::ErrorCode::ScopeDenied
    );
}

#[test]
fn g13_native_move_origin_and_response_lost_replay_do_not_authorize_fresh_alias_moves() {
    let (_dir, db, mut r, source) = setup();
    let first = input(&db, &source, Scope::Project { project_id: 1 });
    let a = db.record_owner_move(&r, &r.binding, &first).unwrap();
    r.request_id = "origin-second".into();
    let second = input(&db, &a.target, Scope::Project { project_id: 2 });
    let b = db.record_owner_move(&r, &r.binding, &second).unwrap();
    let authorize = |label: &str, window: &str, local: bool, id: &str, i: &RecordOwnerMoveInput| {
        crate::record_owner_moves::gui_move_request(
            &r.binding,
            id,
            i,
            |scope| {
                let project = match scope {
                    Scope::Workspace => None,
                    Scope::Project { project_id } => Some(*project_id),
                };
                crate::project_directory::authorize_identity(label, window, project, local).map_err(
                    |message| {
                        crate::agent::errors::AgentError::new(
                            crate::agent::errors::ErrorCode::ScopeDenied,
                            message,
                        )
                    },
                )
            },
            || {
                Ok((
                    db.record_resolve_location(&i.source)?.target,
                    db.record_owner_move_gui_receipt_exists(&r.binding, id, i)?,
                ))
            },
        )
    };
    assert_eq!(
        authorize("project-3", "project-3", true, "origin-second", &second)
            .unwrap_err()
            .code,
        crate::agent::errors::ErrorCode::ScopeDenied
    );
    assert!(authorize("project-1", "main", true, "origin-second", &second).is_err());
    assert!(authorize("main", "main", false, "origin-second", &second).is_err());
    // Response lost: retry still comes from original Project A window after A→B commit.
    let retry = authorize("project-1", "project-1", true, "origin-second", &second).unwrap();
    let replay = db
        .record_owner_move_replay(&retry, &r.binding, &second)
        .unwrap()
        .unwrap();
    assert_eq!(replay.operation_id, b.operation_id);
    assert_eq!(replay.logical_id, b.logical_id);
    assert_eq!(
        retry.scope_grant.object_keys,
        Some(vec![b.target.object_key("test").unwrap()])
    );
    assert_eq!(
        authorize("project-1", "project-1", true, "fresh-stale", &second)
            .unwrap_err()
            .code,
        crate::agent::errors::ErrorCode::SourceChanged
    );
    let fresh_b = input(&db, &b.target, Scope::Workspace);
    assert_eq!(
        authorize("project-1", "project-1", true, "fresh-b", &fresh_b)
            .unwrap_err()
            .code,
        crate::agent::errors::ErrorCode::ScopeDenied
    );
    let main = authorize("main", "main", true, "origin-second", &second).unwrap();
    assert!(db
        .record_owner_move_replay(&main, &r.binding, &second)
        .unwrap()
        .is_some());
    // A later B→Workspace move is outside the frozen A/B grant, even for old receipts.
    let mut third = r.clone();
    third.request_id = "origin-third".into();
    db.record_owner_move(&third, &third.binding, &fresh_b)
        .unwrap();
    let retry = authorize("project-1", "project-1", true, "origin-second", &second).unwrap();
    assert_eq!(
        db.record_owner_move_replay(&retry, &r.binding, &second)
            .unwrap_err()
            .code,
        crate::agent::errors::ErrorCode::ScopeDenied
    );
}

#[tokio::test]
async fn g13_resource_subdirectory_and_single_file_guard_retains_foreign_record_assets() {
    let (dir, mut db, mut r, source) = setup();
    let a = db
        .record_owner_move(
            &r,
            &r.binding,
            &input(&db, &source, Scope::Project { project_id: 1 }),
        )
        .unwrap();
    let resources = dir.path().join("a/resources/sub");
    std::fs::create_dir_all(&resources).unwrap();
    for name in ["图片.png", "文件.pdf", "unrelated.txt"] {
        std::fs::write(resources.join(name), b"retained").unwrap();
    }
    let original = db
        .record_document_head(&a.target)
        .unwrap()
        .unwrap()
        .projection
        .document;
    let document = serde_json::from_str(
        &original
            .to_string()
            .replace("assets/图片.png", "a/resources/sub/图片.png")
            .replace("assets/文件.pdf", "a/resources/sub/文件.pdf"),
    )
    .unwrap();
    save_document(&db, &a.target, document).await;
    r.request_id = "resource-subpath".into();
    db.record_owner_move(
        &r,
        &r.binding,
        &input(&db, &a.target, Scope::Project { project_id: 2 }),
    )
    .unwrap();
    // Integration must stop physical root mutation before the SQL trigger runs.
    let project = db.project_record(1).unwrap();
    assert!(db.rename_project_root(&project, "renamed-resource-owner").is_err());
    assert!(dir.path().join("a").exists());
    assert!(!dir.path().join("renamed-resource-owner").exists());
    assert!(db.project_delete(crate::models::ProjectDeleteInput { project_id: 1 }).is_err());
    assert!(db.project_record(1).is_ok());
    // Both reachable file rename/trash and parent directory rename/trash must be blocked.
    assert!(db
        .record_owner_require_unshared_root(&resources.join("图片.png"), Some(1))
        .is_err());
    assert!(db
        .record_owner_require_unshared_root(&dir.path().join("a/resources"), Some(1))
        .is_err());
    assert!(db
        .record_owner_require_unshared_root(&resources, Some(1))
        .is_err());
    assert!(db
        .record_owner_require_unshared_root(&resources.join("unrelated.txt"), Some(1))
        .is_ok());
    let sibling = dir.path().join("a/resources/sub-extra");
    std::fs::create_dir_all(&sibling).unwrap();
    assert!(db
        .record_owner_require_unshared_root(&sibling, Some(1))
        .is_ok());
    // This helper protects resources owned by other Records; caller validates physical owner.
    assert!(db
        .record_owner_require_unshared_root(&resources, Some(2))
        .is_ok());
    assert!(db
        .record_owner_require_unshared_root(&dir.path().join("assets/图片.png"), None)
        .is_err());
    assert_eq!(
        std::fs::read(resources.join("图片.png")).unwrap(),
        b"retained"
    );
}

#[path = "record_owner_moves_review_tests.rs"]
mod review;
