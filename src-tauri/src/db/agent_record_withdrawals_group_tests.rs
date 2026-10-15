use super::tests::{fixture, Fixture};
use super::*;
use crate::{
    agent::{
        operation_batches::OperationUndoBatchInput,
        output_runtime::StageRecordInput,
        outputs::{BlockEdit, OutputIntent, RecordPatch},
    },
    record_documents::{body_hash, RecordPatchMetadata},
};
use rusqlite::{Transaction, TransactionBehavior};

fn patch(f: &mut Fixture, index: usize) -> String {
    let run_id = "1234567890abcdef1234567890abcdef".to_string();
    let before = f.db.record_document_head(&f.target).unwrap().unwrap();
    let id = format!("{index:032x}");
    let text = format!("Agent addition {index}");
    let block =
        json!({"type":"paragraph","attrs":{"blockId":id},"content":[{"type":"text","text":text}]});
    let operation: BlockEdit = serde_json::from_value(json!({"op":"append","parentBlockId":null,"blocks":[{"type":"paragraph","content":[{"type":"text","text":text}]}]})).unwrap();
    f.request.caller = Caller::BuiltinRun { run_id };
    f.request.request_id = format!("stage-patch-{index}");
    let staged =
        f.db.agent_output_stage_record(
            &f.request,
            &f.binding,
            &StageRecordInput {
                intent: OutputIntent::RecordPatch {
                    patch: RecordPatch {
                        record: ObjectRef {
                            workspace_id: f.binding.workspace_id.clone(),
                            scope: f.target.scope.clone(),
                            kind: ObjectKind::Record,
                            id: f.target.record_id.to_string(),
                        },
                        base_revision: before.head_revision,
                        request_id: format!("patch-candidate-{index}"),
                        operations: vec![operation],
                    },
                },
                sources: vec![],
            },
        )
        .unwrap();
    let prepared =
        f.db.agent_output_commit_prepare(&f.request, &f.binding, &staged.staged.id, 1)
            .unwrap();
    let OutputIntent::RecordPatch { mut patch } = prepared.output.staged.intent else {
        panic!("patch");
    };
    patch.request_id = prepared.commit_request_id;
    let mut projection = before.projection;
    projection.document["content"]
        .as_array_mut()
        .unwrap()
        .push(block);
    projection.body_hash = body_hash(&projection.document, &projection.code_language);
    projection
        .html
        .push_str(&format!("<p data-block-id=\"{id}\">{text}</p>"));
    projection.markdown.push_str(&format!("\n\n{text}"));
    projection.text.push_str(&format!("\n{text}"));
    let saved =
        f.db.record_patch_commit(
            &f.request.caller.key(),
            &patch,
            &projection,
            &RecordPatchMetadata {
                created_block_ids: vec![id],
                deleted_block_ids: vec![],
                normalizations: vec![],
                no_change: false,
            },
            &f.binding.workspace_id,
        )
        .unwrap();
    f.request.caller = Caller::Gui;
    f.request.request_id = "batch-undo".into();
    saved.receipt.operation_id
}

fn chain() -> (Fixture, OperationUndoBatchInput) {
    let mut f = fixture(Scope::Workspace);
    let second = patch(&mut f, 2);
    let third = patch(&mut f, 3);
    let input = OperationUndoBatchInput {
        run_id: "1234567890abcdef1234567890abcdef".into(),
        operation_ids: vec![f.input.creation_operation_id.clone(), second, third],
    };
    (f, input)
}

fn withdraw(f: &Fixture, input: &OperationUndoBatchInput) -> AgentResult<RecordWithdrawalResult> {
    let tx =
        Transaction::new_unchecked(&f.db.conn, TransactionBehavior::Immediate).map_err(io_error)?;
    let plan = super::super::agent_operation_batches::plan(&tx, &f.request, &f.binding, input)?;
    let group = &plan.groups[0];
    let result = creation_group_apply(&f.db, &tx, &f.request, &f.binding, group)?;
    tx.commit().map_err(io_error)?;
    Ok(result)
}

#[test]
fn creation_chain_withdraw_restore_preserves_tail_and_replays_after_later_work() {
    let (mut f, input) = chain();
    let before = f.db.record_document_head(&f.target).unwrap().unwrap();
    let versions_before =
        f.db.record_versions_list(&f.target, None, 20)
            .unwrap()
            .versions;
    let withdrawn = withdraw(&f, &input).unwrap();
    assert_eq!(withdrawn.revision, 1);
    assert_eq!(
        f.db.record_document_head(&f.target).unwrap_err().code,
        ErrorCode::ObjectWithdrawn
    );
    for id in &input.operation_ids {
        let entry =
            f.db.agent_operation_get(&f.request, &f.binding, id)
                .unwrap();
        assert_eq!(entry.undo_state, "undone");
        assert_eq!(
            entry.undo_operation_id.as_deref(),
            Some(withdrawn.operation_id.as_str())
        );
    }
    f.request.request_id = "restore-chain".into();
    let restored =
        f.db.agent_record_creation_restore(
            &f.request,
            &f.binding,
            &RecordRestoreInput {
                creation_operation_id: f.input.creation_operation_id.clone(),
                expected_withdrawal_revision: 1,
            },
        )
        .unwrap();
    assert!(!restored.withdrawn);
    let after = f.db.record_document_head(&f.target).unwrap().unwrap();
    assert_eq!(after.head_revision, before.head_revision);
    assert_eq!(after.projection.body_hash, before.projection.body_hash);
    assert_eq!(after.projection.document, before.projection.document);
    assert_eq!(after.projection.html, before.projection.html);
    assert_eq!(
        f.db.record_versions_list(&f.target, None, 20)
            .unwrap()
            .versions
            .len(),
        versions_before.len()
    );
    assert_eq!(
        withdraw(&f, &input).unwrap().operation_id,
        withdrawn.operation_id
    );
}

#[test]
fn creation_chain_rejects_human_head_and_metadata_changes_without_partial_marks() {
    for metadata in [false, true] {
        let (f, input) = chain();
        if metadata {
            f.db.conn
                .execute(
                    "UPDATE workspace_notes SET title='Human title' WHERE id=?1",
                    [f.target.record_id],
                )
                .unwrap();
        } else {
            f.db.conn.execute("UPDATE record_document_heads SET head_revision=head_revision+1 WHERE record_key=?1", [f.target.key().unwrap()]).unwrap();
        }
        assert_eq!(
            withdraw(&f, &input).unwrap_err().code,
            ErrorCode::UndoConflict
        );
        let marks: i64 =
            f.db.conn
                .query_row(
                    "SELECT count(*) FROM agent_operation_receipts WHERE undo_state='undone'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
        assert_eq!(marks, 0);
        let rows: i64 =
            f.db.conn
                .query_row("SELECT count(*) FROM agent_object_withdrawals", [], |r| {
                    r.get(0)
                })
                .unwrap();
        assert_eq!(rows, 0);
    }
}

#[test]
fn creation_chain_outbox_failure_rolls_back_all_marks_and_visibility() {
    let (f, input) = chain();
    f.db.conn.execute_batch("CREATE TRIGGER reject_chain_outbox BEFORE INSERT ON agent_change_log WHEN NEW.operation='record.withdraw' BEGIN SELECT RAISE(ABORT,'outbox failure'); END").unwrap();
    assert_eq!(withdraw(&f, &input).unwrap_err().code, ErrorCode::IoFailed);
    assert!(f.db.record_document_head(&f.target).unwrap().is_some());
    let marks: i64 =
        f.db.conn
            .query_row(
                "SELECT count(*) FROM agent_operation_receipts WHERE undo_state='undone'",
                [],
                |r| r.get(0),
            )
            .unwrap();
    assert_eq!(marks, 0);
    let rows: i64 =
        f.db.conn
            .query_row("SELECT count(*) FROM agent_object_withdrawals", [], |r| {
                r.get(0)
            })
            .unwrap();
    assert_eq!(rows, 0);
}
