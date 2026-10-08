//! Shared dispatch for the implemented Record and Todo output services.
use super::{
    access::RequestContext,
    errors::{AgentError, AgentResult, ErrorCode},
    models::ObjectKind,
    operations::{OperationUndoInput, OperationUndoResult},
    output_runtime::{OutputUpdateInput, RuntimeOutput, StageRecordInput},
    outputs::OutputIntent,
    record_outputs::{RecordOutputResult, RecordOutputService},
    todo_outputs::TodoOutputService,
};
use crate::{
    committed_changes::capture_committed,
    db::agent_record_withdrawals::{
        RecordRestoreInput, RecordWithdrawalInput, RecordWithdrawalResult,
    },
    record_document_service::{BoundRecordStore, DocumentUtility, RecordDocumentService},
};

pub(crate) async fn stage<S: BoundRecordStore, W: DocumentUtility>(
    store: &S,
    utility: &W,
    request: &RequestContext,
    input: &StageRecordInput,
) -> AgentResult<RecordOutputResult> {
    match &input.intent {
        OutputIntent::TodoCreate { .. } | OutputIntent::TodoUpdate { .. } => {
            TodoOutputService::new(store).stage_and_execute(request, input)
        }
        _ => {
            RecordOutputService::new(store, utility)
                .stage_and_execute(request, input)
                .await
        }
    }
}

pub(crate) async fn update<S: BoundRecordStore, W: DocumentUtility>(
    store: &S,
    utility: &W,
    request: &RequestContext,
    input: &OutputUpdateInput,
) -> AgentResult<RuntimeOutput> {
    match &input.candidate.intent {
        OutputIntent::TodoCreate { .. } | OutputIntent::TodoUpdate { .. } => {
            TodoOutputService::new(store).update_todo(request, input)
        }
        _ => {
            RecordOutputService::new(store, utility)
                .update_record(request, input)
                .await
        }
    }
}

pub(crate) async fn commit<S: BoundRecordStore, W: DocumentUtility>(
    store: &S,
    utility: &W,
    request: &RequestContext,
    id: &str,
    revision: u64,
) -> AgentResult<RecordOutputResult> {
    let output = store.with_current(|binding, db| db.agent_output_get(request, binding, id))?;
    match output.staged.intent {
        OutputIntent::TodoCreate { .. } | OutputIntent::TodoUpdate { .. } => {
            TodoOutputService::new(store).commit_todo(request, id, revision)
        }
        _ => {
            RecordOutputService::new(store, utility)
                .commit_record(request, id, revision)
                .await
        }
    }
}

pub(crate) async fn undo<S: BoundRecordStore, W: DocumentUtility>(
    store: &S,
    utility: &W,
    request: &RequestContext,
    input: &OperationUndoInput,
) -> AgentResult<OperationUndoResult> {
    let entry = store.with_current(|binding, db| {
        db.agent_operation_access(request, binding, &input.operation_id, "operation.undo")
    })?;
    if entry.object.kind == ObjectKind::Record {
        return RecordDocumentService::new(store, utility)
            .undo_operation(request, input)
            .await;
    }
    if entry.object.kind != ObjectKind::Todo {
        return Err(AgentError::new(
            ErrorCode::ToolCallUnsupported,
            "Undo is not available for this object",
        ));
    }
    if input.expected_head_revision == 0
        || entry.after_revision != Some(input.expected_head_revision)
    {
        return Err(AgentError::new(
            ErrorCode::UndoConflict,
            "Expected Todo revision differs from the operation baseline",
        ));
    }
    let (result, changes) = store.with_current(|binding, db| {
        capture_committed(binding, db, &request.request_id, || {
            if entry.kind == "todo.create" {
                db.agent_todo_creation_withdraw(
                    request,
                    binding,
                    &RecordWithdrawalInput {
                        creation_operation_id: input.operation_id.clone(),
                    },
                )
                .map(OperationUndoResult::CreatedTodo)
            } else {
                db.agent_todo_undo(request, binding, input)
                    .map(OperationUndoResult::ModifiedTodo)
            }
        })
    })?;
    if let Some(changes) = changes {
        store.publish_committed(changes);
    }
    result
}

pub(crate) fn restore<S: BoundRecordStore>(
    store: &S,
    request: &RequestContext,
    input: &RecordRestoreInput,
) -> AgentResult<RecordWithdrawalResult> {
    let (result, changes) = store.with_current(|binding, db| {
        let entry = db.agent_operation_access(
            request,
            binding,
            &input.creation_operation_id,
            "operation.restore_created",
        )?;
        capture_committed(binding, db, &request.request_id, || {
            match entry.object.kind {
                ObjectKind::Record => db.agent_record_creation_restore(request, binding, input),
                ObjectKind::Todo => db.agent_todo_creation_restore(request, binding, input),
                _ => Err(AgentError::new(
                    ErrorCode::ToolCallUnsupported,
                    "Restore is not available for this object",
                )),
            }
        })
    })?;
    if let Some(changes) = changes {
        store.publish_committed(changes);
    }
    result
}
