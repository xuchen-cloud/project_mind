use super::tests::{fixture, projection, versions, Fixture};
use super::*;
use crate::{
    agent::{
        output_runtime::StageRecordInput,
        outputs::{BlockEdit, OutputIntent, RecordPatch},
    },
    committed_changes::{CommittedChangePublisher, CommittedChanges},
    record_document_service::{BoundRecordStore, DocumentUtility, RecordDocumentService},
    record_documents::{body_hash, record_block_hash, RecordPatchMetadata},
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};

fn extended() -> RecordDocumentProjection {
    let mut value = projection(true);
    value.document["content"].as_array_mut().unwrap().push(json!({"type":"paragraph","attrs":{"blockId":"cccccccccccccccccccccccccccccccc"},"content":[{"type":"text","text":"Second"}]}));
    value.body_hash = body_hash(&value.document, &None);
    value
        .html
        .push_str("<p data-block-id=\"cccccccccccccccccccccccccccccccc\">Second</p>");
    value.markdown.push_str("\n\nSecond");
    value.text.push_str("\nSecond");
    value
}
fn chain(net_zero: bool) -> (Fixture, OperationUndoBatchInput) {
    let mut f = fixture();
    let first =
        f.db.agent_operation_get(&f.request, &f.binding, &f.input.operation_id)
            .unwrap();
    let operation: BlockEdit = if net_zero {
        BlockEdit::Delete {
            block_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            expected_block_hash: record_block_hash(&projection(true).document["content"][1])
                .unwrap(),
        }
    } else {
        serde_json::from_value(json!({"op":"append","parentBlockId":null,"blocks":[{"type":"paragraph","content":[{"type":"text","text":"Second"}]}]})).unwrap()
    };
    f.request.caller = Caller::BuiltinRun {
        run_id: f.run.clone(),
    };
    f.request.request_id = "stage-second".into();
    let output =
        f.db.agent_output_stage_record(
            &f.request,
            &f.binding,
            &StageRecordInput {
                intent: OutputIntent::RecordPatch {
                    patch: RecordPatch {
                        record: first.object,
                        base_revision: first.after_revision.unwrap(),
                        request_id: "second-candidate".into(),
                        operations: vec![operation],
                    },
                },
                sources: vec![],
            },
        )
        .unwrap();
    let prepared =
        f.db.agent_output_commit_prepare(&f.request, &f.binding, &output.staged.id, 1)
            .unwrap();
    let OutputIntent::RecordPatch { mut patch } = prepared.output.staged.intent else {
        panic!("patch");
    };
    patch.request_id = prepared.commit_request_id;
    let final_projection = if net_zero {
        f.before.clone()
    } else {
        extended()
    };
    let saved =
        f.db.record_patch_commit(
            &f.request.caller.key(),
            &patch,
            &final_projection,
            &RecordPatchMetadata {
                created_block_ids: if net_zero {
                    vec![]
                } else {
                    vec!["cccccccccccccccccccccccccccccccc".into()]
                },
                deleted_block_ids: if net_zero {
                    vec!["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into()]
                } else {
                    vec![]
                },
                normalizations: vec![],
                no_change: false,
            },
            &f.binding.workspace_id,
        )
        .unwrap();
    f.request.caller = Caller::Gui;
    f.request.request_id = "undo-group".into();
    let input = OperationUndoBatchInput {
        run_id: f.run.clone(),
        operation_ids: vec![f.input.operation_id.clone(), saved.receipt.operation_id],
    };
    (f, input)
}
fn entries(f: &Fixture, input: &OperationUndoBatchInput) -> Vec<OperationEntry> {
    input
        .operation_ids
        .iter()
        .map(|id| {
            f.db.agent_operation_get(&f.request, &f.binding, id)
                .unwrap()
        })
        .collect()
}
fn manual(f: &Fixture, draft: bool) -> RecordDocumentProjection {
    let mut value = extended();
    value.document["content"][2]["content"][0]["text"] = json!("Human work");
    value.body_hash = body_hash(&value.document, &None);
    value.html = value.html.replace("Second", "Human work");
    value.markdown = value.markdown.replace("Second", "Human work");
    value.text = value.text.replace("Second", "Human work");
    let head = f.db.record_document_head(&f.target).unwrap().unwrap();
    f.db.record_document_commit(
        "gui",
        "human-after",
        &RecordDocumentCommit {
            target: f.target.clone(),
            base_revision: head.head_revision,
            projection: value.clone(),
            origin: RecordVersionOrigin::Manual,
            actor: json!({"kind":"gui"}),
            edit_session_id: draft.then(|| "dddddddddddddddddddddddddddddddd".into()),
        },
        &f.binding.workspace_id,
    )
    .unwrap();
    value
}

#[test]
fn record_group_undo_restores_once_and_preserves_native_original_receipts() {
    let (f, input) = chain(false);
    let originals = entries(&f, &input);
    let before =
        f.db.record_version_get(
            &f.target,
            originals[1].before_snapshot_ref.as_deref().unwrap(),
        )
        .unwrap();
    let after =
        f.db.record_version_get(
            &f.target,
            originals[0].after_snapshot_ref.as_deref().unwrap(),
        )
        .unwrap();
    assert_eq!(
        (before.head_revision, before.projection.body_hash),
        (after.head_revision, after.projection.body_hash)
    );
    let result =
        f.db.agent_record_undo_group_commit(&f.request, &f.binding, &input, &f.before)
            .unwrap();
    assert_eq!(result.original_operation_id, input.operation_ids[0]);
    assert_eq!(
        result.head.head_revision,
        originals[1].after_revision.unwrap() + 1
    );
    assert_eq!(result.head.body_hash, f.before.body_hash);
    let restores: i64 =
        f.db.conn
            .query_row(
                "SELECT count(*) FROM record_versions WHERE record_key=?1 AND origin='restore'",
                [f.target.key().unwrap()],
                |r| r.get(0),
            )
            .unwrap();
    assert_eq!(restores, 1);
    for (entry, original) in entries(&f, &input).iter().zip(&originals) {
        assert_eq!(entry.undo_state, "undone");
        assert_eq!(
            entry.undo_operation_id.as_deref(),
            Some(result.operation_id.as_str())
        );
        assert_eq!(
            (
                &entry.before_snapshot_ref,
                &entry.after_snapshot_ref,
                entry.before_revision,
                entry.after_revision
            ),
            (
                &original.before_snapshot_ref,
                &original.after_snapshot_ref,
                original.before_revision,
                original.after_revision
            )
        );
        assert_eq!(
            f.db.agent_record_undo_previous(entry)
                .unwrap()
                .unwrap()
                .operation_id,
            result.operation_id
        );
    }
    let receipt =
        f.db.agent_operation_get(&f.request, &f.binding, &result.operation_id)
            .unwrap();
    assert_eq!(receipt.before_revision, originals[1].after_revision);
    assert_eq!(receipt.after_revision, Some(result.head.head_revision));
    assert_eq!(
        receipt.before_snapshot_ref.as_deref(),
        Some(result.before_version.as_str())
    );
    assert_eq!(
        receipt.after_snapshot_ref.as_deref(),
        Some(result.after_version.as_str())
    );
}

#[test]
fn record_group_net_zero_uses_retained_version_without_creating_a_snapshot() {
    let (f, input) = chain(true);
    let count = versions(&f);
    let current = f.db.record_document_head(&f.target).unwrap().unwrap();
    let result =
        f.db.agent_record_undo_group_commit(&f.request, &f.binding, &input, &f.before)
            .unwrap();
    assert_eq!(versions(&f), count);
    assert_eq!(result.head.head_revision, current.head_revision);
    assert_eq!(result.before_version, result.after_version);
    let retained =
        f.db.record_version_get(&f.target, &result.after_version)
            .unwrap();
    assert_eq!(retained.head_revision, current.head_revision);
    assert_eq!(retained.projection.body_hash, current.projection.body_hash);
    assert!(entries(&f, &input)
        .iter()
        .all(|entry| entry.undo_operation_id.as_deref() == Some(result.operation_id.as_str())));
}

#[test]
fn record_group_success_replays_after_new_human_work_and_single_undo_reads_it() {
    let (mut f, input) = chain(false);
    let result =
        f.db.agent_record_undo_group_commit(&f.request, &f.binding, &input, &f.before)
            .unwrap();
    let human = manual(&f, true);
    let count = versions(&f);
    f.request.request_id = "undo-group-again".into();
    let repeated =
        f.db.agent_record_undo_group_commit(&f.request, &f.binding, &input, &f.before)
            .unwrap();
    assert_eq!(repeated.operation_id, result.operation_id);
    let subset = OperationUndoBatchInput {
        run_id: input.run_id.clone(),
        operation_ids: vec![input.operation_ids[1].clone()],
    };
    assert_eq!(
        f.db.agent_record_undo_group_commit(&f.request, &f.binding, &subset, &f.before)
            .unwrap()
            .operation_id,
        result.operation_id
    );
    for (index, entry) in entries(&f, &input).into_iter().enumerate() {
        f.request.request_id = format!("individual-group-result-{index}");
        let individual = OperationUndoInput {
            operation_id: entry.operation_id,
            expected_head_revision: entry.after_revision.unwrap(),
        };
        assert_eq!(
            f.db.agent_record_undo_commit(&f.request, &f.binding, &individual, &f.before)
                .unwrap()
                .operation_id,
            result.operation_id
        );
    }
    assert_eq!(versions(&f), count);
    assert_eq!(
        f.db.record_document_head(&f.target)
            .unwrap()
            .unwrap()
            .projection
            .body_hash,
        human.body_hash
    );
}

#[test]
fn record_group_accepts_distinct_valid_snapshot_ids_at_one_revision_boundary() {
    let (f, input) = chain(false);
    let originals = entries(&f, &input);
    let checkpoint_id = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    // Seed a retained checkpoint with the exact verified canonical snapshot.
    // Record revision continuity compares evidence, not checkpoint identity.
    f.db.conn.execute("INSERT INTO record_versions(id,record_key,version_number,head_revision,document_snapshot,html,markdown,text,schema_version,code_language,title_snapshot,body_hash,origin,actor_json,operation_id,restored_from_version_id,created_at) SELECT ?1,record_key,(SELECT MAX(version_number)+1 FROM record_versions WHERE record_key=?2),head_revision,document_snapshot,html,markdown,text,schema_version,code_language,title_snapshot,body_hash,origin,actor_json,operation_id,restored_from_version_id,created_at FROM record_versions WHERE id=?3", params![checkpoint_id, f.target.key().unwrap(), originals[1].before_snapshot_ref]).unwrap();
    f.db.conn.execute("UPDATE agent_operation_receipts SET before_snapshot_ref=?1,result_json=json_set(result_json,'$.beforeVersion',?1) WHERE operation_id=?2", params![checkpoint_id, input.operation_ids[1]]).unwrap();
    let changed = entries(&f, &input);
    assert_ne!(
        changed[0].after_snapshot_ref,
        changed[1].before_snapshot_ref
    );
    assert_eq!(changed[0].after_revision, changed[1].before_revision);
    assert_eq!(
        f.db.agent_record_undo_group_commit(&f.request, &f.binding, &input, &f.before)
            .unwrap()
            .head
            .body_hash,
        f.before.body_hash
    );
}

#[test]
fn record_group_refuses_later_head_metadata_and_mixed_undo_without_overwriting() {
    for mode in 0..3 {
        let (f, input) = chain(false);
        match mode {
            0 => {
                manual(&f, true);
            }
            1 => {
                let metadata = f.db.record_metadata_get(&f.target).unwrap();
                f.db.record_metadata_update(
                    "gui",
                    "human-title",
                    &crate::record_documents::RecordMetadataUpdate {
                        target: f.target.clone(),
                        expected_revision: metadata.revision,
                        title: Some("Human title".into()),
                        tag_ids: vec![],
                    },
                    &f.binding.workspace_id,
                )
                .unwrap();
            }
            _ => {
                let tail = entries(&f, &input).pop().unwrap();
                f.db.agent_record_undo_commit(
                    &f.request,
                    &f.binding,
                    &OperationUndoInput {
                        operation_id: tail.operation_id,
                        expected_head_revision: tail.after_revision.unwrap(),
                    },
                    &projection(true),
                )
                .unwrap();
            }
        }
        let count = versions(&f);
        let head = f.db.record_document_head(&f.target).unwrap().unwrap();
        assert_eq!(
            f.db.agent_record_undo_group_commit(&f.request, &f.binding, &input, &f.before)
                .unwrap_err()
                .code,
            ErrorCode::UndoConflict
        );
        assert_eq!(versions(&f), count);
        assert_eq!(
            f.db.record_document_head(&f.target)
                .unwrap()
                .unwrap()
                .projection
                .body_hash,
            head.projection.body_hash
        );
    }
}

#[test]
fn record_group_receipt_failure_rolls_back_head_versions_and_all_originals() {
    let (f, input) = chain(false);
    let count = versions(&f);
    let head = f.db.record_document_head(&f.target).unwrap().unwrap();
    f.db.conn.execute_batch(&format!("CREATE TRIGGER block_first_undo BEFORE UPDATE OF undo_state ON agent_operation_receipts WHEN OLD.operation_id='{}' AND NEW.undo_state='undone' BEGIN SELECT RAISE(ABORT,'receipt failure'); END", input.operation_ids[0])).unwrap();
    assert!(f
        .db
        .agent_record_undo_group_commit(&f.request, &f.binding, &input, &f.before)
        .is_err());
    assert_eq!(versions(&f), count);
    assert_eq!(
        f.db.record_document_head(&f.target)
            .unwrap()
            .unwrap()
            .head_revision,
        head.head_revision
    );
    assert!(entries(&f, &input)
        .iter()
        .all(|entry| entry.undo_state == "available" && entry.undo_operation_id.is_none()));
    let saved: bool = f
        .db
        .conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_operation_receipts WHERE request_id='undo-group')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!saved);
}

struct Store {
    fixture: Mutex<Fixture>,
    flush_error: Option<ErrorCode>,
    save_draft: bool,
    flushes: AtomicUsize,
    events: AtomicUsize,
}
impl CommittedChangePublisher for Store {
    fn publish_committed(&self, _: CommittedChanges) {
        assert!(self.fixture.try_lock().is_ok());
        self.events.fetch_add(1, Ordering::Relaxed);
    }
}
impl BoundRecordStore for Store {
    async fn flush_editors(&self, _: &WorkspaceBinding, _: &RecordTarget) -> AgentResult<()> {
        self.flushes.fetch_add(1, Ordering::Relaxed);
        if let Some(code) = self.flush_error {
            return Err(AgentError::new(code, "Editor review is pending"));
        }
        if self.save_draft {
            manual(&self.fixture.lock().unwrap(), true);
        }
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
        let f = self.fixture.lock().unwrap();
        action(&f.binding, &f.db)
    }
}
struct Utility(RecordDocumentProjection);
impl DocumentUtility for Utility {
    async fn request(&self, _: &str, method: &str, _: Value) -> AgentResult<Value> {
        assert_eq!(method, "record.validate");
        Ok(serde_json::to_value(&self.0).unwrap())
    }
}
#[tokio::test]
async fn record_group_service_requires_editor_ack_and_preserves_a_flushed_draft() {
    for save_draft in [false, true] {
        let (f, input) = chain(false);
        let request = f.request.clone();
        let count = versions(&f);
        let initial = f.db.record_document_head(&f.target).unwrap().unwrap();
        let utility = Utility(f.before.clone());
        let store = Store {
            fixture: Mutex::new(f),
            flush_error: (!save_draft).then_some(ErrorCode::EditorReviewPending),
            save_draft,
            flushes: AtomicUsize::new(0),
            events: AtomicUsize::new(0),
        };
        let error = RecordDocumentService::new(&store, &utility)
            .undo_operation_group(&request, &input)
            .await
            .unwrap_err();
        assert_eq!(
            error.code,
            if save_draft {
                ErrorCode::UndoConflict
            } else {
                ErrorCode::EditorReviewPending
            }
        );
        assert_eq!(store.flushes.load(Ordering::Relaxed), 1);
        let f = store.fixture.lock().unwrap();
        let current = f.db.record_document_head(&f.target).unwrap().unwrap();
        assert_eq!(versions(&f), count);
        if save_draft {
            assert_eq!(current.head_revision, initial.head_revision + 1);
            assert!(current.edit_session_id.is_some());
            assert_eq!(current.projection.text, "Before 保留\nAdded\nHuman work");
        } else {
            assert_eq!(current.head_revision, initial.head_revision);
        }
        assert!(entries(&f, &input)
            .iter()
            .all(|entry| entry.undo_state == "available"));
    }
}

#[tokio::test]
async fn record_group_service_uses_real_native_result_and_skips_flush_on_saved_replay() {
    let (f, input) = chain(false);
    let request = f.request.clone();
    let utility = Utility(f.before.clone());
    let store = Store {
        fixture: Mutex::new(f),
        flush_error: None,
        save_draft: false,
        flushes: AtomicUsize::new(0),
        events: AtomicUsize::new(0),
    };
    let service = RecordDocumentService::new(&store, &utility);
    let result = service
        .undo_operation_group(&request, &input)
        .await
        .unwrap();
    manual(&store.fixture.lock().unwrap(), true);
    assert_eq!(
        service
            .undo_operation_group(&request, &input)
            .await
            .unwrap()
            .operation_id,
        result.operation_id
    );
    assert_eq!(store.flushes.load(Ordering::Relaxed), 1);
    assert_eq!(store.events.load(Ordering::Relaxed), 1);
}
