//! Trusted local editor adapter. Bridge/Pi adapters must use their persisted
//! grants and the editor coordination barrier before enabling external writes.
use crate::{
    agent::{
        access::{Caller, RequestContext, ScopeGrant},
        errors::{AgentError, AgentResult, ApiResponse, ErrorCode},
        models::{Scope, WorkspaceBinding},
    },
    record_document_service::{
        AppDocumentUtility, RecordBodySave, RecordDocumentService, RecordVersionDifference,
    },
    record_documents::*,
    AppState,
};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordCommandInput<T> {
    binding: WorkspaceBinding,
    request_id: String,
    data: T,
}
fn gui_request<T>(
    state: &AppState,
    input: &RecordCommandInput<T>,
    scope: &Scope,
    operations: &[&str],
) -> AgentResult<RequestContext> {
    let current = crate::lock_mutex(&state.current_workspace);
    let runtime = current
        .as_ref()
        .ok_or_else(|| AgentError::new(ErrorCode::WorkspaceNotOpen, "Open a Workspace first"))?;
    Ok(RequestContext {
        binding: input.binding.clone(),
        request_id: input.request_id.clone(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: runtime.agent_binding.workspace_id.clone(),
            workspace_content: matches!(scope, Scope::Workspace),
            project_ids: match scope {
                Scope::Project { project_id } => vec![*project_id],
                _ => vec![],
            },
            operations: operations
                .iter()
                .map(|operation| (*operation).into())
                .collect(),
        },
    })
}

#[tauri::command]
pub(crate) async fn record_editor_get(
    state: State<'_, AppState>,
    input: RecordCommandInput<RecordTarget>,
) -> Result<ApiResponse<RecordEditorState>, String> {
    let result = async {
        let request = gui_request(&state, &input, &input.data.scope, &["record.read"])?;
        let utility = AppDocumentUtility(state.app_handle.clone());
        RecordDocumentService::new(&*state, &utility)
            .editor_get(&request, &input.data)
            .await
    }
    .await;
    Ok(ApiResponse::from_result(input.request_id, result))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordEditorSaveResult {
    commit: RecordCommitResult,
    editor: RecordEditorState,
}
#[tauri::command]
pub(crate) async fn record_body_save(
    state: State<'_, AppState>,
    input: RecordCommandInput<RecordBodySave>,
) -> Result<ApiResponse<RecordEditorSaveResult>, String> {
    let result = async {
        let request = gui_request(
            &state,
            &input,
            &input.data.target.scope,
            &["record.read", "record.write", "record.metadata.write"],
        )?;
        let utility = AppDocumentUtility(state.app_handle.clone());
        let service = RecordDocumentService::new(&*state, &utility);
        let commit = service.save(&request, &input.data).await?;
        let editor = service.editor_get(&request, &input.data.target).await?;
        Ok(RecordEditorSaveResult { commit, editor })
    }
    .await;
    Ok(ApiResponse::from_result(input.request_id, result))
}
#[tauri::command]
pub(crate) fn record_metadata_update(
    state: State<'_, AppState>,
    input: RecordCommandInput<RecordMetadataUpdate>,
) -> ApiResponse<RecordMetadata> {
    let result = (|| {
        let request = gui_request(
            &state,
            &input,
            &input.data.target.scope,
            &["record.metadata.write"],
        )?;
        let utility = AppDocumentUtility(state.app_handle.clone());
        RecordDocumentService::new(&*state, &utility).metadata_update(&request, &input.data)
    })();
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn record_checkpoint(
    state: State<'_, AppState>,
    input: RecordCommandInput<RecordCheckpointInput>,
) -> ApiResponse<RecordCheckpointResult> {
    let result = (|| {
        let request = gui_request(&state, &input, &input.data.target.scope, &["record.write"])?;
        let utility = AppDocumentUtility(state.app_handle.clone());
        RecordDocumentService::new(&*state, &utility).checkpoint(&request, &input.data)
    })();
    ApiResponse::from_result(input.request_id, result)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VersionListInput {
    target: RecordTarget,
    before: Option<u64>,
    limit: u32,
}
#[tauri::command]
pub(crate) fn record_versions_list(
    state: State<'_, AppState>,
    input: RecordCommandInput<VersionListInput>,
) -> ApiResponse<RecordVersionPage> {
    let result = (|| {
        let request = gui_request(&state, &input, &input.data.target.scope, &["record.read"])?;
        let utility = AppDocumentUtility(state.app_handle.clone());
        RecordDocumentService::new(&*state, &utility).versions_list(
            &request,
            &input.data.target,
            input.data.before,
            input.data.limit,
        )
    })();
    ApiResponse::from_result(input.request_id, result)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VersionGetInput {
    target: RecordTarget,
    version_id: String,
}
#[tauri::command]
pub(crate) async fn record_version_get(
    state: State<'_, AppState>,
    input: RecordCommandInput<VersionGetInput>,
) -> Result<ApiResponse<RecordVersion>, String> {
    let result = async {
        let request = gui_request(&state, &input, &input.data.target.scope, &["record.read"])?;
        let utility = AppDocumentUtility(state.app_handle.clone());
        RecordDocumentService::new(&*state, &utility)
            .version_get(&request, &input.data.target, &input.data.version_id)
            .await
    }
    .await;
    Ok(ApiResponse::from_result(input.request_id, result))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VersionCompareInput {
    target: RecordTarget,
    before_version_id: String,
    after_version_id: String,
}
#[tauri::command]
pub(crate) async fn record_versions_compare(
    state: State<'_, AppState>,
    input: RecordCommandInput<VersionCompareInput>,
) -> Result<ApiResponse<RecordVersionDifference>, String> {
    let result = async {
        let request = gui_request(&state, &input, &input.data.target.scope, &["record.read"])?;
        let utility = AppDocumentUtility(state.app_handle.clone());
        RecordDocumentService::new(&*state, &utility)
            .versions_compare(
                &request,
                &input.data.target,
                &input.data.before_version_id,
                &input.data.after_version_id,
            )
            .await
    }
    .await;
    Ok(ApiResponse::from_result(input.request_id, result))
}
#[tauri::command]
pub(crate) fn record_version_capacity(
    state: State<'_, AppState>,
    input: RecordCommandInput<RecordTarget>,
) -> ApiResponse<RecordVersionCapacity> {
    let result = (|| {
        let request = gui_request(&state, &input, &input.data.scope, &["record.read"])?;
        let utility = AppDocumentUtility(state.app_handle.clone());
        RecordDocumentService::new(&*state, &utility).capacity(&request, &input.data)
    })();
    ApiResponse::from_result(input.request_id, result)
}
// Restore/patch are deliberately absent from the GUI adapter until the shared
// multi-window flush and review barrier is connected. Their domain methods are
// exercised through the service integration tests.
