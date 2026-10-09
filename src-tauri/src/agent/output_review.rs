//! Plan decisions persist metadata; existing per-output commits own mutations.
use super::{
    access::{Caller, RequestContext},
    errors::{AgentError, ApiResponse, ErrorCode},
    models::WorkspaceBinding,
    output_runtime::RuntimeOutput,
};
use crate::{record_document_service::BoundRecordStore, AppState};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReviewDecision {
    Confirm,
    Cancel,
    Revise,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OutputReviewItem {
    pub output_id: String,
    pub expected_revision: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OutputReviewInput {
    pub run_id: String,
    pub outputs: Vec<OutputReviewItem>,
    pub decision: ReviewDecision,
    pub text: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutputReviewDecision {
    pub request_id: String,
    pub decision: ReviewDecision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub decided_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutputReviewResult {
    pub run_id: String,
    pub decision: ReviewDecision,
    pub outputs: Vec<RuntimeOutput>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OutputReviewCommandInput {
    binding: WorkspaceBinding,
    request_id: String,
    data: OutputReviewInput,
}
/// Buttons use the same durable decision path as a Host-bound model tool.
#[tauri::command]
pub(crate) fn agent_output_review(
    state: State<'_, AppState>,
    input: OutputReviewCommandInput,
) -> ApiResponse<OutputReviewResult> {
    let result = state.with_current(|binding, db| {
        if binding != &input.binding {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Review Workspace changed",
            ));
        }
        let request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: input.request_id.clone(),
            scope_grant: db.agent_output_gui_grant_for_run(
                binding,
                &input.data.run_id,
                &["output.commit", "output.update"],
            )?,
        };
        db.agent_output_review(&request, binding, &input.data)
    });
    ApiResponse::from_result(input.request_id, result)
}
