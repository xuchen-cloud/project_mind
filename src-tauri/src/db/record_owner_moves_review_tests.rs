use super::*;
use crate::{
    agent::{
        errors::{AgentResult, ErrorCode},
        models::{SourceLocator, SourceRef},
    },
    committed_changes::{CommittedChangePublisher, CommittedChanges},
    record_document_service::{
        BoundRecordStore, DocumentUtility, RecordBodySave, RecordDocumentService, RecordSaveOrigin,
    },
    record_documents::{body_hash, RecordCreate},
    source_service::{SourcePolicyUpdate, SourceReadTarget},
};
use serde_json::{json, Value};
use std::sync::Mutex;

fn plain(text: &str) -> RecordDocumentProjection {
    let document = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"a".repeat(32)},"content":[{"type":"text","text":text}]}]});
    RecordDocumentProjection {
        schema_version: 1,
        body_hash: body_hash(&document, &None),
        document,
        html: format!("<p data-block-id=\"{}\">{text}</p>", "a".repeat(32)),
        markdown: text.into(),
        text: text.into(),
        code_language: None,
    }
}
fn create(db: &Database, id: &str, scope: Scope, p: &RecordDocumentProjection) -> RecordTarget {
    db.record_create(
        "connection:g13-review",
        id,
        &RecordCreate {
            scope,
            title: Some(id.into()),
            tag_ids: vec![],
            document: p.document.clone(),
            code_language: None,
        },
        p,
        "test",
    )
    .unwrap()
    .target
}
fn voice(db: &Database, target: &RecordTarget) -> ObjectRef {
    db.conn
        .execute(
            "INSERT INTO voice_records(project_note_id,created_at) VALUES(?1,'now')",
            [target.record_id],
        )
        .unwrap();
    let id = db.conn.last_insert_rowid();
    db.conn.execute("INSERT INTO recording_sessions(id,voice_record_id,request_id,lifecycle,started_at,ended_at) VALUES('review-session',?1,'review-voice','ended','now','now')",[id]).unwrap();
    db.conn.execute("INSERT INTO voice_transcript_segments(id,session_id,start_ms,end_ms,text,created_at) VALUES('review-segment','review-session',1000,3000,'original transcript','now')",[]).unwrap();
    ObjectRef {
        workspace_id: "test".into(),
        scope: target.scope.clone(),
        kind: ObjectKind::Transcript,
        id: id.to_string(),
    }
}
#[test]
fn g13_review_excluded_transcript_policy_follows_voice_owner() {
    let (_dir, db, mut r, _) = setup();
    let target = create(
        &db,
        "excluded-voice",
        Scope::Project { project_id: 1 },
        &plain("voice"),
    );
    let old = voice(&db, &target);
    r.scope_grant.operations.push("settings.write".into());
    r.request_id = "exclude-transcript".into();
    db.source_policy_update(
        &r,
        &r.binding,
        &SourcePolicyUpdate {
            object: old.clone(),
            expected_revision: 0,
            excluded: true,
        },
    )
    .unwrap();
    r.request_id = "move-excluded-voice".into();
    db.record_owner_move(
        &r,
        &r.binding,
        &input(&db, &target, Scope::Project { project_id: 2 }),
    )
    .unwrap();
    let actual = ObjectRef {
        scope: Scope::Project { project_id: 2 },
        ..old.clone()
    };
    r.scope_grant.workspace_content = false;
    r.scope_grant.project_ids = vec![2];
    let result = db.source_transcript_snapshot(
        &r,
        &r.binding,
        &SourceReadTarget {
            object: actual.clone(),
            revision: None,
            record_version: None,
            file_version: None,
        },
    );
    assert_eq!(
        result
            .err()
            .expect("excluded Transcript must be denied")
            .code,
        ErrorCode::ScopeDenied
    );
    assert_eq!(
        db.conn
            .query_row(
                "SELECT excluded,revision FROM source_access_policies WHERE object_key=?1",
                [actual.key().unwrap()],
                |row| Ok((row.get::<_, bool>(0)?, row.get::<_, i64>(1)?))
            )
            .unwrap(),
        (true, 1)
    );
    assert_eq!(
        db.conn
            .query_row(
                "SELECT count(*) FROM source_access_policies WHERE object_key=?1",
                [old.key().unwrap()],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}
#[test]
fn g13_review_old_transcript_time_navigation_authorizes_actual_owner() {
    let (_dir, db, mut r, _) = setup();
    let target = create(
        &db,
        "voice-nav",
        Scope::Project { project_id: 1 },
        &plain("voice"),
    );
    let old = voice(&db, &target);
    let snapshot = db
        .source_transcript_snapshot(
            &r,
            &r.binding,
            &SourceReadTarget {
                object: old.clone(),
                revision: None,
                record_version: None,
                file_version: None,
            },
        )
        .unwrap();
    let source = SourceRef {
        object: old.clone(),
        revision: snapshot.revision,
        record_version: None,
        file_version: None,
        block_id: None,
        locator: Some(SourceLocator::Time {
            start_ms: 1500,
            end_ms: 2500,
        }),
        title: "Voice".into(),
        excerpt: "original".into(),
    };
    let moved = db
        .record_owner_move(
            &r,
            &r.binding,
            &input(&db, &target, Scope::Project { project_id: 2 }),
        )
        .unwrap();
    r.scope_grant.workspace_content = false;
    r.scope_grant.project_ids = vec![2];
    let nav = db.agent_source_resolve(&r, &r.binding, &source).unwrap();
    assert_eq!(nav.object.scope, moved.target.scope);
    assert_eq!(
        nav.record_target.unwrap().key().unwrap(),
        moved.target.key().unwrap()
    );
    assert_eq!((nav.start_ms, nav.end_ms), (Some(1500), Some(2500)));
    assert_eq!(nav.revision_matches, Some(true));
    r.scope_grant.project_ids = vec![1];
    assert_eq!(
        db.agent_source_resolve(&r, &r.binding, &source)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    r.scope_grant.project_ids = vec![2];
    r.scope_grant.object_keys = Some(vec![old.key().unwrap()]);
    assert_eq!(
        db.agent_source_resolve(&r, &r.binding, &source)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    r.scope_grant.object_keys = Some(vec![nav.object.key().unwrap()]);
    for projects in [vec![2], vec![1, 2]] {
        r.scope_grant.project_ids = projects;
        assert_eq!(db.agent_source_resolve(&r, &r.binding, &source).unwrap().object, nav.object);
    }
    r.scope_grant.object_keys = None;
    let forged = SourceRef {
        object: ObjectRef {
            scope: Scope::Project { project_id: 999 },
            ..old
        },
        ..source
    };
    assert_eq!(
        db.agent_source_resolve(&r, &r.binding, &forged)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
}
struct Store {
    db: Mutex<Database>,
    binding: WorkspaceBinding,
}
impl CommittedChangePublisher for Store {
    fn publish_committed(&self, _: CommittedChanges) {
        assert!(self.db.try_lock().is_ok());
    }
}
impl BoundRecordStore for Store {
    async fn flush_editors(&self, _: &WorkspaceBinding, _: &RecordTarget) -> AgentResult<()> {
        Ok(())
    }
    async fn submission_lock(
        &self,
        _: &WorkspaceBinding,
        _: &RecordTarget,
    ) -> AgentResult<Option<tokio::sync::OwnedMutexGuard<()>>> {
        Ok(None)
    }
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        action(&self.binding, &self.db.lock().unwrap())
    }
}
struct Worker;
impl DocumentUtility for Worker {
    async fn request(&self, id: &str, method: &str, params: Value) -> AgentResult<Value> {
        crate::record_document_worker::RecordDocumentWorker::development()?
            .request(id, method, params)
            .await
    }
}
#[tokio::test]
async fn g13_review_retained_moved_reference_saves_but_new_copies_are_rejected() {
    let (_dir, db, mut r, _) = setup();
    let target = create(
        &db,
        "referenced",
        Scope::Project { project_id: 1 },
        &plain("R"),
    );
    let reference = json!({"type":"internalReference","attrs":{"refKind":"note","refId":target.record_id,"label":"R"}});
    let mut doc = plain("Q").document;
    doc["content"][0]["content"]
        .as_array_mut()
        .unwrap()
        .push(reference.clone());
    let q = create(
        &db,
        "referrer",
        Scope::Project { project_id: 1 },
        &converted(doc.clone(), None).await,
    );
    let other = create(
        &db,
        "other-referrer",
        Scope::Project { project_id: 1 },
        &plain("other"),
    );
    db.record_owner_move(
        &r,
        &r.binding,
        &input(&db, &target, Scope::Project { project_id: 2 }),
    )
    .unwrap();
    r.scope_grant.workspace_content = false;
    r.scope_grant.project_ids = vec![1];
    r.scope_grant
        .operations
        .extend(["record.write".into(), "record.read".into()]);
    let store = Store {
        db: Mutex::new(db),
        binding: r.binding.clone(),
    };
    let service = RecordDocumentService::new(&store, &Worker);
    doc["content"][0]["content"][0]["text"] = json!("Q unrelated edit");
    let mut save = RecordBodySave {
        target: q.clone(),
        base_revision: 1,
        document: doc.clone(),
        code_language: None,
        origin: RecordSaveOrigin::Manual,
        edit_session_id: Some("c".repeat(32)),
        metadata: None,
    };
    r.request_id = "save-retained".into();
    let saved = service.save(&r, &save).await.unwrap();
    save.base_revision = saved.head.head_revision;
    // Same old token in another Record, another block, or duplicated in the same block is new.
    for mode in 0..3 {
        let mut candidate = save.clone();
        if mode == 0 {
            candidate.target = other.clone();
            candidate.base_revision = 1;
        } else if mode == 1 {
            let mut block = candidate.document["content"][0].clone();
            block["attrs"]["blockId"] = json!("d".repeat(32));
            candidate.document["content"]
                .as_array_mut()
                .unwrap()
                .push(block);
        } else {
            candidate.document["content"][0]["content"]
                .as_array_mut()
                .unwrap()
                .push(reference.clone());
        }
        r.request_id = format!("new-copy-{mode}");
        assert_eq!(
            service.save(&r, &candidate).await.unwrap_err().code,
            ErrorCode::ScopeDenied
        );
    }
    assert_eq!(
        store
            .db
            .lock()
            .unwrap()
            .record_document_head(&q)
            .unwrap()
            .unwrap()
            .head_revision,
        saved.head.head_revision
    );
    // Q follows R into B using its existing A token; then R moves again to Workspace.
    // The same logical reference remains retainable in B, without gaining a new token.
    r.scope_grant.project_ids = vec![1, 2];
    r.scope_grant.workspace_content = true;
    {
        let db = store.db.lock().unwrap();
        r.request_id = "move-referrer-b".into();
        let moved_q = db
            .record_owner_move(
                &r,
                &r.binding,
                &input(&db, &q, Scope::Project { project_id: 2 }),
            )
            .unwrap();
        let current_r = db.record_resolve_location(&target).unwrap().target;
        r.request_id = "move-referenced-root".into();
        db.record_owner_move(&r, &r.binding, &input(&db, &current_r, Scope::Workspace))
            .unwrap();
        save.target = moved_q.target;
        save.base_revision = moved_q.head_revision;
    }
    r.scope_grant.workspace_content = false;
    r.scope_grant.project_ids = vec![2];
    r.request_id = "save-retained-after-repeat".into();
    save.document["content"][0]["content"][0]["text"] = json!("Q edit after repeated moves");
    service.save(&r, &save).await.unwrap();
    let retained = store
        .db
        .lock()
        .unwrap()
        .record_document_head(&save.target)
        .unwrap()
        .unwrap()
        .projection
        .document;
    assert_eq!(
        retained["content"][0]["content"].as_array().unwrap().len(),
        2
    );
    assert_eq!(
        crate::record_documents::positive_object_id(
            &retained["content"][0]["content"][1]["attrs"]["refId"]
        ),
        Some(target.record_id as u64)
    );
}
#[test]
fn g13_review_creation_undo_detects_todo_old_locator_without_edges() {
    let (_dir, db, mut r, _) = setup();
    let target = create(
        &db,
        "created-undo",
        Scope::Project { project_id: 1 },
        &plain("created"),
    );
    let operation:String=db.conn.query_row("SELECT operation_id FROM agent_operation_receipts WHERE request_id='created-undo' AND caller_id='connection:g13-review'",[],|r|r.get(0)).unwrap();
    let moved = db
        .record_owner_move(
            &r,
            &r.binding,
            &input(&db, &target, Scope::Project { project_id: 2 }),
        )
        .unwrap();
    db.conn.execute("INSERT INTO todos(scope,project_id,content,priority,status,created_at,updated_at) VALUES('workspace',NULL,?1,'normal','unfinished','now','now')",[format!("[[note:{}|old reference]]",target.record_id)]).unwrap();
    r.scope_grant.operations.push("operation.undo".into());
    r.request_id = "undo-created".into();
    let result = db.agent_record_creation_withdraw(
        &r,
        &r.binding,
        &crate::db::agent_record_withdrawals::RecordWithdrawalInput {
            creation_operation_id: operation,
        },
    );
    assert_eq!(result.unwrap_err().code, ErrorCode::UndoConflict);
    assert!(db.record_document_head(&moved.target).unwrap().is_some());
}
