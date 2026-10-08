//! Local GUI adapter for staged outputs and committed operation recovery.
//! Scope comes from the bound database; wire arguments cannot mint GUI grants.
use super::{
    access::{Caller, RequestContext, ScopeGrant},
    errors::{AgentError, AgentResult, ApiResponse, ErrorCode},
    models::{Scope, WorkspaceBinding},
    operations::{
        OperationEntry, OperationGetInput, OperationListInput, OperationPage, OperationUndoInput,
        OperationUndoResult,
    },
    output_runtime::{OutputPage, OutputUpdateInput, RuntimeOutput},
    record_outputs::{RecordOutputPreview, RecordOutputResult, RecordOutputService},
};
use crate::{
    committed_changes::{capture_committed, CommittedChangePublisher},
    db::agent_record_withdrawals::{RecordRestoreInput, RecordWithdrawalResult},
    record_document_service::{AppDocumentUtility, BoundRecordStore, RecordDocumentService},
    AppState,
};
use serde::Deserialize;
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OutputCommandInput<T> {
    binding: WorkspaceBinding,
    request_id: String,
    data: T,
}
fn page_limit() -> u16 {
    50
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OutputListInput {
    pub(crate) run_id: String,
    pub(crate) cursor: Option<String>,
    #[serde(default = "page_limit")]
    pub(crate) limit: u16,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OutputGetInput {
    pub(crate) output_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OutputCommitInput {
    pub(crate) output_id: String,
    pub(crate) expected_revision: u64,
}

fn check_binding<T>(input: &OutputCommandInput<T>, current: &WorkspaceBinding) -> AgentResult<()> {
    if &input.binding != current {
        return Err(AgentError::new(
            ErrorCode::WorkspaceChanged,
            "Output Workspace is no longer current",
        ));
    }
    if input.request_id.is_empty() || input.request_id.len() > 128 {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "requestId must contain 1–128 bytes",
        ));
    }
    Ok(())
}
fn request<T>(input: &OutputCommandInput<T>, grant: ScopeGrant) -> RequestContext {
    RequestContext {
        binding: input.binding.clone(),
        request_id: input.request_id.clone(),
        caller: Caller::Gui,
        scope_grant: grant,
    }
}
fn operation_grant(
    binding: &WorkspaceBinding,
    scopes: &[Scope],
    operations: &[&str],
) -> ScopeGrant {
    let mut project_ids = vec![];
    for scope in scopes {
        if let Scope::Project { project_id } = scope {
            if !project_ids.contains(project_id) {
                project_ids.push(*project_id);
            }
        }
    }
    ScopeGrant {
        workspace_id: binding.workspace_id.clone(),
        workspace_content: scopes.contains(&Scope::Workspace),
        project_ids,
        operations: operations
            .iter()
            .map(|operation| (*operation).into())
            .collect(),
    }
}
fn output_request<T>(
    state: &AppState,
    input: &OutputCommandInput<T>,
    output_id: &str,
    operations: &[&str],
) -> AgentResult<RequestContext> {
    state.with_current(|binding, db| {
        check_binding(input, binding)?;
        // Frozen Run scopes allow only the source scopes already authorized for this output.
        Ok(request(
            input,
            db.agent_output_gui_grant(binding, output_id, operations)?,
        ))
    })
}
fn operation_request<T>(
    state: &AppState,
    input: &OutputCommandInput<T>,
    operation_id: &str,
    operations: &[&str],
) -> AgentResult<RequestContext> {
    state.with_current(|binding, db| {
        check_binding(input, binding)?;
        let scope = db.agent_operation_scope(binding, operation_id)?;
        Ok(request(
            input,
            operation_grant(binding, &[scope], operations),
        ))
    })
}

#[tauri::command]
pub(crate) fn agent_output_list(
    state: State<'_, AppState>,
    input: OutputCommandInput<OutputListInput>,
) -> ApiResponse<OutputPage> {
    let result = state.with_current(|binding, db| {
        check_binding(&input, binding)?;
        let grant =
            db.agent_output_gui_grant_for_run(binding, &input.data.run_id, &["output.read"])?;
        db.agent_output_list(
            &request(&input, grant),
            binding,
            &input.data.run_id,
            input.data.cursor.as_deref(),
            input.data.limit,
        )
    });
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn agent_output_get(
    state: State<'_, AppState>,
    input: OutputCommandInput<OutputGetInput>,
) -> ApiResponse<RuntimeOutput> {
    let result = state.with_current(|binding, db| {
        check_binding(&input, binding)?;
        let grant = db.agent_output_gui_grant(binding, &input.data.output_id, &["output.read"])?;
        db.agent_output_get(&request(&input, grant), binding, &input.data.output_id)
    });
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) async fn agent_output_preview(
    state: State<'_, AppState>,
    input: OutputCommandInput<OutputCommitInput>,
) -> Result<ApiResponse<RecordOutputPreview>, String> {
    let result = async {
        let request = output_request(
            &state,
            &input,
            &input.data.output_id,
            &["output.read", "source.read", "record.patch"],
        )?;
        let utility = AppDocumentUtility(state.app_handle.clone());
        RecordOutputService::new(&*state, &utility)
            .preview_record(
                &request,
                &input.data.output_id,
                input.data.expected_revision,
            )
            .await
    }
    .await;
    Ok(ApiResponse::from_result(input.request_id, result))
}
#[tauri::command]
pub(crate) async fn agent_output_update(
    state: State<'_, AppState>,
    input: OutputCommandInput<OutputUpdateInput>,
) -> Result<ApiResponse<RuntimeOutput>, String> {
    let result = async {
        let request = output_request(
            &state,
            &input,
            &input.data.output_id,
            &[
                "output.update",
                "source.read",
                "content.create",
                "record.patch",
            ],
        )?;
        let utility = AppDocumentUtility(state.app_handle.clone());
        RecordOutputService::new(&*state, &utility)
            .update_record(&request, &input.data)
            .await
    }
    .await;
    Ok(ApiResponse::from_result(input.request_id, result))
}
#[tauri::command]
pub(crate) async fn agent_output_commit(
    state: State<'_, AppState>,
    input: OutputCommandInput<OutputCommitInput>,
) -> Result<ApiResponse<RecordOutputResult>, String> {
    let result = async {
        let request = output_request(
            &state,
            &input,
            &input.data.output_id,
            &[
                "output.commit",
                "output.read",
                "source.read",
                "content.create",
                "record.patch",
                "record.read",
                "record.write",
                "record.metadata.write",
            ],
        )?;
        let utility = AppDocumentUtility(state.app_handle.clone());
        // The native service coordinates editors and publishes CommittedChanges after commit.
        RecordOutputService::new(&*state, &utility)
            .commit_record(
                &request,
                &input.data.output_id,
                input.data.expected_revision,
            )
            .await
    }
    .await;
    Ok(ApiResponse::from_result(input.request_id, result))
}
#[tauri::command]
pub(crate) fn agent_operation_list(
    state: State<'_, AppState>,
    input: OutputCommandInput<OperationListInput>,
) -> ApiResponse<OperationPage> {
    let result = state.with_current(|binding, db| {
        check_binding(&input, binding)?;
        // Receipt ownership still exists after its chat session has been deleted.
        let scopes = db.agent_operation_run_scopes(binding, &input.data.run_id)?;
        let grant = operation_grant(binding, &scopes, &["operation.read"]);
        db.agent_operation_list(&request(&input, grant), binding, &input.data)
    });
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn agent_operation_get(
    state: State<'_, AppState>,
    input: OutputCommandInput<OperationGetInput>,
) -> ApiResponse<OperationEntry> {
    let result = state.with_current(|binding, db| {
        check_binding(&input, binding)?;
        let scope = db.agent_operation_scope(binding, &input.data.operation_id)?;
        db.agent_operation_get(
            &request(
                &input,
                operation_grant(binding, &[scope], &["operation.read"]),
            ),
            binding,
            &input.data.operation_id,
        )
    });
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) async fn agent_operation_undo(
    state: State<'_, AppState>,
    input: OutputCommandInput<OperationUndoInput>,
) -> Result<ApiResponse<OperationUndoResult>, String> {
    let result = async {
        let request = operation_request(
            &state,
            &input,
            &input.data.operation_id,
            &["operation.read", "operation.undo"],
        )?;
        let utility = AppDocumentUtility(state.app_handle.clone());
        RecordDocumentService::new(&*state, &utility)
            .undo_operation(&request, &input.data)
            .await
    }
    .await;
    Ok(ApiResponse::from_result(input.request_id, result))
}
#[tauri::command]
pub(crate) fn agent_operation_restore_created(
    state: State<'_, AppState>,
    input: OutputCommandInput<RecordRestoreInput>,
) -> ApiResponse<RecordWithdrawalResult> {
    let result = (|| {
        let (result, changes) = state.with_current(|binding, db| {
            check_binding(&input, binding)?;
            let scope = db.agent_operation_scope(binding, &input.data.creation_operation_id)?;
            let request = request(
                &input,
                operation_grant(binding, &[scope], &["operation.restore_created"]),
            );
            capture_committed(binding, db, &input.request_id, || {
                db.agent_record_creation_restore(&request, binding, &input.data)
            })
        })?;
        if let Some(changes) = changes {
            state.publish_committed(changes);
        }
        result
    })();
    ApiResponse::from_result(input.request_id, result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn output_envelopes_reject_frontend_authority_and_scope() {
        let mut input = json!({"binding":{"workspaceId":"w","generation":"g"},"requestId":"read","data":{"outputId":"a".repeat(32)}});
        assert!(
            serde_json::from_value::<OutputCommandInput<OutputGetInput>>(input.clone()).is_ok()
        );
        input["caller"] = json!("gui");
        assert!(
            serde_json::from_value::<OutputCommandInput<OutputGetInput>>(input.clone()).is_err()
        );
        input.as_object_mut().unwrap().remove("caller");
        input["data"]["scope"] = json!({"kind":"workspace"});
        assert!(serde_json::from_value::<OutputCommandInput<OutputGetInput>>(input).is_err());
        let forged = json!({"binding":{"workspaceId":"w","generation":"g","scopeGrant":{}},"requestId":"read","data":{"operationId":"a".repeat(32)}});
        assert!(serde_json::from_value::<OutputCommandInput<OperationGetInput>>(forged).is_err());
    }
    #[test]
    fn recovery_inputs_are_strict_and_list_pages_have_a_bound() {
        let value = json!({"binding":{"workspaceId":"w","generation":"g"},"requestId":"confirm","data":{"outputId":"a".repeat(32),"expectedRevision":2}});
        assert!(serde_json::from_value::<OutputCommandInput<OutputCommitInput>>(value).is_ok());
        let mut value = json!({"binding":{"workspaceId":"w","generation":"g"},"requestId":"undo","data":{"operationId":"a".repeat(32),"expectedHeadRevision":3}});
        assert!(
            serde_json::from_value::<OutputCommandInput<OperationUndoInput>>(value.clone()).is_ok()
        );
        value["data"]["document"] = json!({});
        assert!(serde_json::from_value::<OutputCommandInput<OperationUndoInput>>(value).is_err());
        let mut restore = json!({"binding":{"workspaceId":"w","generation":"g"},"requestId":"restore","data":{"creationOperationId":"a".repeat(32),"expectedWithdrawalRevision":1}});
        assert!(
            serde_json::from_value::<OutputCommandInput<RecordRestoreInput>>(restore.clone())
                .is_ok()
        );
        restore["data"]["scopeGrant"] = json!({"workspaceContent":true});
        assert!(serde_json::from_value::<OutputCommandInput<RecordRestoreInput>>(restore).is_err());
        let list: OutputListInput =
            serde_json::from_value(json!({"runId":"a".repeat(32)})).unwrap();
        assert_eq!(list.limit, 50);
        let grant = operation_grant(
            &WorkspaceBinding {
                workspace_id: "w".into(),
                generation: "g".into(),
            },
            &[Scope::Project { project_id: 7 }],
            &["operation.read"],
        );
        assert!(!grant.workspace_content);
        assert_eq!(grant.project_ids, vec![7]);
        assert_eq!(grant.operations, vec!["operation.read"]);
    }
}
