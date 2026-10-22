//! Shared dispatch for Record, Todo and File output services.
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::{sync::watch, time::Instant};

use super::{
    access::{Caller, RequestContext},
    errors::{AgentError, AgentResult, ErrorCode},
    file_outputs::FileOutputService,
    models::ObjectKind,
    operation_batches::{
        OperationBatchUndoState, OperationUndoBatchInput, OperationUndoBatchItem,
        OperationUndoBatchOutcome, OperationUndoBatchResult, OperationUndoGroup,
    },
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
    file_version_service::BoundFileCommitStore,
    record_document_service::{BoundRecordStore, DocumentUtility, RecordDocumentService},
    record_documents::RecordTarget,
};

fn batch_item(
    group: &OperationUndoGroup,
    outcome: AgentResult<OperationUndoResult>,
) -> OperationUndoBatchItem {
    OperationUndoBatchItem {
        object: group.object.clone(),
        operation_ids: group
            .operations
            .iter()
            .map(|entry| entry.operation_id.clone())
            .collect(),
        outcome: match outcome {
            Ok(result) => OperationUndoBatchOutcome::Succeeded { result },
            Err(error) => OperationUndoBatchOutcome::Failed { error },
        },
    }
}

/// The selected receipts are validated together before any mutation. Each
/// modification then settles independently; creations settle as one closed set.
pub(crate) async fn undo_batch<S: BoundRecordStore + BoundFileCommitStore, W: DocumentUtility>(
    store: &S,
    utility: &W,
    request: &RequestContext,
    input: &OperationUndoBatchInput,
) -> AgentResult<OperationUndoBatchResult> {
    let plan = store
        .with_current(|binding, db| db.agent_operation_undo_batch_plan(request, binding, input))?;
    let mut settled = Vec::with_capacity(plan.groups.len());
    let mut creation_ids = Vec::new();
    let mut creation_guards = Vec::new();
    for group in &plan.groups {
        if group.creation().is_some() {
            settled.push(None);
            continue;
        }
        let first = group.first();
        let last = group.last();
        let group_input = OperationUndoBatchInput {
            run_id: plan.run_id.clone(),
            operation_ids: group
                .operations
                .iter()
                .map(|entry| entry.operation_id.clone())
                .collect(),
        };
        let mut trusted = request.clone();
        trusted.request_id = format!("taskundo:{}:{}", first.operation_id, last.operation_id);
        let outcome = match group.object.kind {
            ObjectKind::Record => RecordDocumentService::new(store, utility)
                .undo_operation_group(&trusted, &group_input)
                .await
                .map(OperationUndoResult::ModifiedRecord),
            ObjectKind::Todo => {
                let committed = store.with_current(|binding, db| {
                    capture_committed(binding, db, &trusted.request_id, || {
                        db.agent_todo_undo_group(&trusted, binding, &group_input)
                    })
                });
                match committed {
                    Ok((result, changes)) => {
                        if let Some(changes) = changes {
                            store.publish_committed(changes);
                        }
                        result.map(OperationUndoResult::ModifiedTodo)
                    }
                    Err(error) => Err(error),
                }
            }
            ObjectKind::File => super::file_undo::undo_file_group(store, &trusted, &group_input)
                .map(OperationUndoResult::ModifiedFile),
            _ => Err(AgentError::new(
                ErrorCode::ToolCallUnsupported,
                "Undo is not available for this object",
            )),
        };
        settled.push(Some(batch_item(group, outcome)));
    }
    // Keep editor submission locks until the creation transaction settles.
    // Sort targets so simultaneous batch requests acquire locks in one order.
    let mut creation_indices: Vec<usize> = plan
        .groups
        .iter()
        .enumerate()
        .filter_map(|(index, group)| group.creation().map(|_| index))
        .collect();
    creation_indices.sort_by(|a, b| plan.groups[*a].object_key.cmp(&plan.groups[*b].object_key));
    for index in creation_indices {
        let group = &plan.groups[index];
        // A replay is already durable. Flushing an editor would create an
        // unrelated write and turn an idempotent retry into a conflict.
        if group.object.kind == ObjectKind::Record
            && group.undo_state == OperationBatchUndoState::Available
            && group.conflicts.is_empty()
        {
            let prepared = async {
                let target = RecordTarget {
                    scope: group.object.scope.clone(),
                    record_id: group.object.id.parse().map_err(|_| {
                        AgentError::new(ErrorCode::UndoConflict, "Invalid Record receipt target")
                    })?,
                };
                RecordDocumentService::new(store, utility)
                    .flush_editors(request, &target, "operation.undo")
                    .await?;
                store.submission_lock(&request.binding, &target).await
            }
            .await;
            match prepared {
                Ok(guard) => creation_guards.push(guard),
                Err(error) => {
                    settled[index] = Some(batch_item(group, Err(error)));
                    continue;
                }
            }
        }
        creation_ids.extend(
            group
                .operations
                .iter()
                .map(|entry| entry.operation_id.clone()),
        );
    }
    if !creation_ids.is_empty() {
        let creation_input = OperationUndoBatchInput {
            run_id: plan.run_id.clone(),
            operation_ids: creation_ids,
        };
        let committed = (|| {
            let host = store.gui_commit_host(&request.binding)?;
            let db = host.database()?;
            capture_committed(host.binding(), &db, &request.request_id, || {
                db.agent_creation_batch_withdraw(request, host.binding(), &creation_input)
            })
        })();
        drop(creation_guards);
        match committed {
            Ok((creation_result, changes)) => {
                if let Some(changes) = changes {
                    store.publish_committed(changes);
                }
                match creation_result {
                    Ok(items) => {
                        for item in items {
                            let key = item.object.key()?;
                            if let Some((index, _)) =
                                plan.groups.iter().enumerate().find(|(index, group)| {
                                    settled[*index].is_none() && group.object_key == key
                                })
                            {
                                settled[index] = Some(item);
                            }
                        }
                    }
                    Err(error) => {
                        for (index, group) in plan.groups.iter().enumerate() {
                            if settled[index].is_none() {
                                settled[index] = Some(batch_item(group, Err(error.clone())));
                            }
                        }
                    }
                }
            }
            Err(error) => {
                for (index, group) in plan.groups.iter().enumerate() {
                    if settled[index].is_none() {
                        settled[index] = Some(batch_item(group, Err(error.clone())));
                    }
                }
            }
        }
    }
    Ok(OperationUndoBatchResult {
        run_id: plan.run_id,
        results: settled
            .into_iter()
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| {
                AgentError::new(
                    ErrorCode::IoFailed,
                    "Creation withdrawal omitted an object result",
                )
            })?,
        excluded_no_change_ids: plan
            .excluded_no_change
            .into_iter()
            .map(|entry| entry.operation_id)
            .collect(),
    })
}

pub(crate) async fn stage<S: BoundRecordStore + BoundFileCommitStore, W: DocumentUtility>(
    store: &S,
    utility: &W,
    request: &RequestContext,
    input: &StageRecordInput,
) -> AgentResult<RecordOutputResult> {
    match &input.intent {
        OutputIntent::FileCreate { .. }
        | OutputIntent::FileUpdate { .. }
        | OutputIntent::FilePatch { .. }
        | OutputIntent::FileRestore { .. } => {
            FileOutputService::new(store).stage_and_execute(request, input)
        }
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

pub(crate) async fn update<S: BoundRecordStore + BoundFileCommitStore, W: DocumentUtility>(
    store: &S,
    utility: &W,
    request: &RequestContext,
    input: &OutputUpdateInput,
) -> AgentResult<RuntimeOutput> {
    match &input.candidate.intent {
        OutputIntent::FileCreate { .. }
        | OutputIntent::FileUpdate { .. }
        | OutputIntent::FilePatch { .. }
        | OutputIntent::FileRestore { .. } => {
            FileOutputService::new(store).update_file(request, input)
        }
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

pub(crate) async fn commit<S: BoundRecordStore + BoundFileCommitStore, W: DocumentUtility>(
    store: &S,
    utility: &W,
    request: &RequestContext,
    id: &str,
    revision: u64,
) -> AgentResult<RecordOutputResult> {
    let output = store.with_current(|binding, db| db.agent_output_get(request, binding, id))?;
    match output.staged.intent {
        OutputIntent::FileCreate { .. }
        | OutputIntent::FileUpdate { .. }
        | OutputIntent::FilePatch { .. }
        | OutputIntent::FileRestore { .. } => {
            FileOutputService::new(store).commit_file(request, id, revision)
        }
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

pub(crate) async fn undo<S: BoundRecordStore + BoundFileCommitStore, W: DocumentUtility>(
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
    if entry.object.kind == ObjectKind::File {
        if entry.kind == "file.create" {
            if entry.after_revision != Some(input.expected_head_revision) {
                return Err(AgentError::new(
                    ErrorCode::UndoConflict,
                    "File creation baseline changed",
                ));
            }
            return super::file_outputs::withdraw_created_file(
                store,
                request,
                &RecordWithdrawalInput {
                    creation_operation_id: input.operation_id.clone(),
                },
            )
            .map(OperationUndoResult::CreatedFile);
        }
        return super::file_undo::undo_file(store, request, input)
            .map(OperationUndoResult::ModifiedFile);
    }
    undo_todo(store, request, input)
}

pub(crate) fn undo_todo<S: BoundRecordStore>(
    store: &S,
    request: &RequestContext,
    input: &OperationUndoInput,
) -> AgentResult<OperationUndoResult> {
    let (result, changes) = store.with_current(|binding, db| {
        let entry = db.agent_operation_access(request, binding, &input.operation_id, "operation.undo")?;
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
        if matches!(request.caller, Caller::Connection { .. }) && entry.undo_state != "undone" {
            db.source_read_object(request, binding, &entry.object)?;
        }
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

pub(crate) fn restore<S: BoundRecordStore + BoundFileCommitStore>(
    store: &S,
    request: &RequestContext,
    input: &RecordRestoreInput,
) -> AgentResult<RecordWithdrawalResult> {
    let entry = store.with_current(|binding, db| {
        db.agent_operation_access(
            request,
            binding,
            &input.creation_operation_id,
            "operation.restore_created",
        )
    })?;
    if entry.object.kind == ObjectKind::File {
        return super::file_outputs::restore_created_file(store, request, input);
    }
    restore_created_content(store, request, input)
}

pub(crate) fn restore_created_content<S: BoundRecordStore>(
    store: &S,
    request: &RequestContext,
    input: &RecordRestoreInput,
) -> AgentResult<RecordWithdrawalResult> {
    let (result, changes) = store.with_current(|binding, db| {
        let entry = db.agent_operation_access(request, binding, &input.creation_operation_id, "operation.restore_created")?;
        if matches!(request.caller, Caller::Connection { .. }) {
            db.source_read_recovery_object(request, binding, &entry.object)?;
        }
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

/// Apply a later user decision through native output permissions and receipts.
pub(super) async fn execute_review_decision<
    S: crate::record_document_service::BoundRecordStore
        + crate::file_version_service::BoundFileCommitStore,
    R: crate::record_document_service::DocumentUtility,
>(
    store: &S,
    record: &R,
    request: &RequestContext,
    arguments: Value,
    cancel: &watch::Receiver<bool>,
    deadline: Option<Instant>,
) -> AgentResult<Value> {
    let should_stop = || *cancel.borrow() || deadline.is_some_and(|limit| Instant::now() >= limit);
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ModelDecision {
        run_id: String,
        outputs: Vec<super::output_review::OutputReviewItem>,
        decision: super::output_review::ReviewDecision,
    }
    let input: ModelDecision = serde_json::from_value(arguments)
        .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Invalid review decision"))?;
    let super::access::Caller::BuiltinRun { run_id } = &request.caller else {
        return Err(AgentError::new(
            ErrorCode::ScopeDenied,
            "Assistant run required",
        ));
    };
    let reviewed =
        crate::record_document_service::BoundRecordStore::with_current(store, |binding, db| {
            let current = db.agent_run_get(request, binding, run_id)?;
            let prompt = current
                .context_manifest
                .get("prompt")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AgentError::new(ErrorCode::InvalidArgument, "Real user message is missing")
                })?;
            let data = super::output_review::OutputReviewInput {
                run_id: input.run_id.clone(),
                outputs: input.outputs,
                decision: input.decision,
                text: Some(prompt.to_owned()),
            };
            db.agent_output_review(request, binding, &data)
        })?;
    let mut saved_count = 0usize;
    let mut saved_refs = Vec::new();
    let mut failures = Vec::new();
    if reviewed.decision == super::output_review::ReviewDecision::Confirm {
        let gui = crate::record_document_service::BoundRecordStore::with_current(
            store,
            |binding, db| {
                let old = db.agent_output_gui_grant_for_run(
                    binding,
                    &reviewed.run_id,
                    &["output.commit", "output.update"],
                )?;
                let mut current = request.scope_grant.clone();
                current.workspace_content &= old.workspace_content;
                current
                    .project_ids
                    .retain(|id| old.project_ids.contains(id));
                Ok(super::access::RequestContext {
                    binding: binding.clone(),
                    caller: super::access::Caller::Gui,
                    request_id: request.request_id.clone(),
                    scope_grant: current,
                })
            },
        )?;
        for candidate in &reviewed.outputs {
            if should_stop() {
                break;
            }
            let mut native = gui.clone();
            native.request_id = format!(
                "review:{}:{}",
                candidate.staged.id, candidate.staged.revision
            );
            let outcome = super::output_service::commit(
                store,
                record,
                &native,
                &candidate.staged.id,
                candidate.staged.revision,
            )
            .await;
            match outcome {
                Ok(saved) => {
                    saved_count += 1;
                    if saved_refs.len() < 32 {
                        saved_refs.push(json!({"outputId":candidate.staged.id,"object":saved.output.object,"operationId":saved.operation.map(|entry|entry.operation_id)}));
                    }
                }
                Err(error) => {
                    failures.push(json!({"outputId":candidate.staged.id,"code":error.code}))
                }
            }
        }
        if should_stop() {
            let remaining = crate::record_document_service::BoundRecordStore::with_current(
                store,
                |binding, db| {
                    reviewed
                        .outputs
                        .iter()
                        .map(|candidate| db.agent_output_get(&gui, binding, &candidate.staged.id))
                        .collect::<AgentResult<Vec<_>>>()
                },
            )?
            .into_iter()
            .filter(|item| {
                !item.dismissed
                    && matches!(
                        item.state,
                        super::output_runtime::OutputState::Staged
                            | super::output_runtime::OutputState::Failed
                    )
            })
            .map(|item| super::output_review::OutputReviewItem {
                output_id: item.staged.id,
                expected_revision: item.staged.revision,
            })
            .collect::<Vec<_>>();
            if !remaining.is_empty() {
                let mut stop = gui.clone();
                stop.request_id = format!("{}:stop", request.request_id);
                crate::record_document_service::BoundRecordStore::with_current(
                    store,
                    |binding, db| {
                        db.agent_output_review(
                            &stop,
                            binding,
                            &super::output_review::OutputReviewInput {
                                run_id: reviewed.run_id.clone(),
                                outputs: remaining,
                                decision: super::output_review::ReviewDecision::Cancel,
                                text: None,
                            },
                        )
                    },
                )?;
            }
        }
    }
    let unexecuted = reviewed
        .outputs
        .len()
        .saturating_sub(saved_count + failures.len());
    let stopped = should_stop() && unexecuted > 0;
    Ok(
        json!({"runId":reviewed.run_id,"decision":reviewed.decision,"savedCount":saved_count,"saved":saved_refs,"hasMoreSaved":saved_count>saved_refs.len(),"failures":failures,"unexecutedCount":unexecuted,"stopped":stopped}),
    )
}

#[cfg(test)]
#[path = "operation_batch_service_tests.rs"]
mod batch_tests;
