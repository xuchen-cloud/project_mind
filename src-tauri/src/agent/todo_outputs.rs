//! Shared Todo output execution. Native validators, mutations, snapshots and
//! receipts remain inside the current Workspace's business transaction.
use super::{
    access::RequestContext,
    errors::{AgentError, AgentResult, ErrorCode},
    models::ExecutionMode,
    output_runtime::{OutputUpdateInput, StageRecordInput},
    outputs::OutputIntent,
    record_outputs::RecordOutputResult,
};
use crate::{committed_changes::capture_committed, record_document_service::BoundRecordStore};
pub(crate) struct TodoOutputService<'a, S> {
    store: &'a S,
}
fn todo(input: &StageRecordInput) -> AgentResult<()> {
    if !matches!(
        input.intent,
        OutputIntent::TodoCreate { .. } | OutputIntent::TodoUpdate { .. }
    ) {
        return Err(AgentError::new(
            ErrorCode::ToolCallUnsupported,
            "Expected a Todo candidate",
        ));
    }
    Ok(())
}
impl<'a, S: BoundRecordStore> TodoOutputService<'a, S> {
    pub(crate) fn new(store: &'a S) -> Self {
        Self { store }
    }
    pub(crate) fn stage_and_execute(
        &self,
        request: &RequestContext,
        input: &StageRecordInput,
    ) -> AgentResult<RecordOutputResult> {
        todo(input)?;
        let output = self.store.with_current(|binding, db| {
            db.agent_output_stage_validate(request, binding, input)?;
            // A second tool request for the same action also receives its own
            // original atomic receipt; changing that request's payload cannot
            // bypass idempotency by choosing a different action key later.
            let staged = db.agent_output_stage_record(request, binding, input)?;
            db.agent_output_get(request, binding, &staged.staged.id)
        })?;
        if output.mode == ExecutionMode::Collaborate {
            self.commit_todo(request, &output.staged.id, output.staged.revision)
        } else {
            Ok(RecordOutputResult {
                output,
                receipt: None,
                operation: None,
            })
        }
    }
    pub(crate) fn update_todo(
        &self,
        request: &RequestContext,
        input: &OutputUpdateInput,
    ) -> AgentResult<super::output_runtime::RuntimeOutput> {
        todo(&input.candidate)?;
        self.store.with_current(|binding, db| {
            let previous = db.agent_output_update_validate(request, binding, input)?;
            if previous.staged.revision != input.expected_revision {
                return Ok(previous);
            }
            db.agent_output_update(request, binding, input)
        })
    }
    pub(crate) fn commit_todo(
        &self,
        request: &RequestContext,
        id: &str,
        revision: u64,
    ) -> AgentResult<RecordOutputResult> {
        let (result, changes) = self.store.with_current(|binding, db| {
            capture_committed(binding, db, &request.request_id, || {
                if let Some(receipt) =
                    db.agent_output_record_receipt(request, binding, id, revision)?
                {
                    let output = db.agent_output_get(request, binding, id)?;
                    todo(&StageRecordInput {
                        intent: output.staged.intent.clone(),
                        sources: output.staged.sources.clone(),
                    })?;
                    return Ok(RecordOutputResult {
                        output,
                        receipt: Some(receipt),
                        operation: db
                            .agent_output_record_operation(request, binding, id, revision)?,
                    });
                }
                let output = db.agent_output_get(request, binding, id)?;
                todo(&StageRecordInput {
                    intent: output.staged.intent,
                    sources: output.staged.sources,
                })?;
                let saved = db.agent_todo_output_commit(request, binding, id, revision);
                if let Err(error) = saved {
                    // A native commit remains authoritative if its acknowledgement
                    // was interrupted; failed reservations never become successes.
                    if db
                        .agent_output_record_receipt(request, binding, id, revision)?
                        .is_none()
                    {
                        let _ =
                            db.agent_output_mark_failed(request, binding, id, revision, error.code);
                        return Err(error);
                    }
                }
                let receipt = db
                    .agent_output_record_receipt(request, binding, id, revision)?
                    .ok_or_else(|| {
                        AgentError::new(
                            ErrorCode::OutputCommitFailed,
                            "Native Todo save has no committed output receipt",
                        )
                    })?;
                Ok(RecordOutputResult {
                    output: db.agent_output_get(request, binding, id)?,
                    receipt: Some(receipt),
                    operation: db.agent_output_record_operation(request, binding, id, revision)?,
                })
            })
        })?;
        if let Some(changes) = changes {
            self.store.publish_committed(changes);
        }
        result
    }
}
