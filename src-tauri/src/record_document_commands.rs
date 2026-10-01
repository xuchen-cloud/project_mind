//! Trusted local editor adapter. Shared Record writes enforce editor
//! coordination; Bridge/Pi adapters must also provide their persisted grants.
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
    record_editor_coordination::{RecordEditorFlushReply, RecordEditorRegistration},
    AppState,
};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State, WebviewWindow};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordCutInput {
    target: RecordTarget,
    token: String,
}

#[tauri::command]
pub(crate) fn record_cut_register(
    state: State<'_, AppState>,
    input: RecordCommandInput<RecordCutInput>,
) -> ApiResponse<()> {
    let result = (|| {
        let request = gui_request(&state, &input, &input.data.target.scope, &["record.read"])?;
        let utility = AppDocumentUtility(state.app_handle.clone());
        RecordDocumentService::new(&*state, &utility).authorize_target(
            &request,
            &input.data.target,
            "record.read",
        )?;
        state
            .record_editors
            .register_cut(&request.binding, &input.data.target, &input.data.token)
    })();
    ApiResponse::from_result(input.request_id, result)
}

#[tauri::command]
pub(crate) fn record_cut_claim(
    state: State<'_, AppState>,
    input: RecordCommandInput<RecordCutInput>,
) -> ApiResponse<bool> {
    let result = (|| {
        let request = gui_request(&state, &input, &input.data.target.scope, &["record.read"])?;
        let utility = AppDocumentUtility(state.app_handle.clone());
        RecordDocumentService::new(&*state, &utility).authorize_target(
            &request,
            &input.data.target,
            "record.read",
        )?;
        state
            .record_editors
            .claim_cut(&request.binding, &input.data.target, &input.data.token)
    })();
    ApiResponse::from_result(input.request_id, result)
}

#[tauri::command]
pub(crate) fn record_editor_register(
    state: State<'_, AppState>,
    window: WebviewWindow,
    input: RecordCommandInput<RecordEditorRegistration>,
) -> ApiResponse<()> {
    let result = (|| {
        let request = gui_request(&state, &input, &input.data.target.scope, &["record.read"])?;
        let utility = AppDocumentUtility(state.app_handle.clone());
        RecordDocumentService::new(&*state, &utility).authorize_target(
            &request,
            &input.data.target,
            "record.read",
        )?;
        state
            .record_editors
            .register(&request.binding, window.label(), &input.data)
    })();
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn record_editor_unregister(
    state: State<'_, AppState>,
    window: WebviewWindow,
    input: RecordCommandInput<RecordEditorRegistration>,
) -> ApiResponse<()> {
    let result = state
        .record_editors
        .unregister(&input.binding, window.label(), &input.data);
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn record_editor_flush_reply(
    state: State<'_, AppState>,
    window: WebviewWindow,
    input: RecordCommandInput<RecordEditorFlushReply>,
) -> ApiResponse<()> {
    let result = state
        .record_editors
        .reply(&input.binding, window.label(), &input.data);
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) async fn record_editors_flush(
    state: State<'_, AppState>,
    input: RecordCommandInput<RecordTarget>,
) -> Result<ApiResponse<RecordEditorState>, String> {
    let result = async {
        let request = gui_request(&state, &input, &input.data.scope, &["record.read"])?;
        let utility = AppDocumentUtility(state.app_handle.clone());
        let service = RecordDocumentService::new(&*state, &utility);
        service
            .flush_editors(&request, &input.data, "record.read")
            .await?;
        service.editor_get(&request, &input.data).await
    }
    .await;
    Ok(ApiResponse::from_result(input.request_id, result))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordHeadChanged<'a> {
    binding: &'a WorkspaceBinding,
    target: &'a RecordTarget,
    request_id: &'a str,
    head_revision: Option<u64>,
    metadata_revision: Option<&'a str>,
}
fn notify_record_changed(
    state: &AppState,
    request: &RequestContext,
    target: &RecordTarget,
    head_revision: Option<u64>,
    metadata: Option<&RecordMetadata>,
) {
    let _ = state.app_handle.emit(
        "record:head-changed",
        RecordHeadChanged {
            binding: &request.binding,
            target,
            request_id: &request.request_id,
            head_revision,
            metadata_revision: metadata.map(|value| value.revision.as_str()),
        },
    );
}

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceBindingInput {
    workspace_root: String,
    request_id: String,
}
#[tauri::command]
pub(crate) fn record_workspace_binding_get(
    state: State<'_, AppState>,
    input: WorkspaceBindingInput,
) -> ApiResponse<WorkspaceBinding> {
    let result = (|| {
        if input.request_id.is_empty()
            || input.request_id.len() > 128
            || !std::path::Path::new(&input.workspace_root).is_absolute()
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid editor Workspace identity",
            ));
        }
        let current = crate::lock_mutex(&state.current_workspace);
        let runtime = current.as_ref().ok_or_else(|| {
            AgentError::new(ErrorCode::WorkspaceNotOpen, "Open a Workspace first")
        })?;
        if std::path::Path::new(&input.workspace_root) != runtime.paths.root_path {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Editor Workspace is no longer current",
            ));
        }
        Ok(runtime.agent_binding.clone())
    })();
    ApiResponse::from_result(input.request_id, result)
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
        notify_record_changed(
            &state,
            &request,
            &commit.head.target,
            Some(commit.head.head_revision),
            commit.metadata.as_ref(),
        );
        let editor = service.editor_get(&request, &input.data.target).await?;
        Ok(RecordEditorSaveResult { commit, editor })
    }
    .await;
    Ok(ApiResponse::from_result(input.request_id, result))
}

#[tauri::command]
pub(crate) async fn record_quick_note_transfer(
    state: State<'_, AppState>,
    input: RecordCommandInput<RecordQuickNoteTransfer>,
) -> Result<ApiResponse<RecordEditorSaveResult>, String> {
    let result = async {
        let request = gui_request(
            &state,
            &input,
            &input.data.scope,
            &[
                "record.read",
                "record.write",
                "record.metadata.write",
                "record.quick_note.write",
            ],
        )?;
        let utility = AppDocumentUtility(state.app_handle.clone());
        let service = RecordDocumentService::new(&*state, &utility);
        let commit = service.quick_note_transfer(&request, &input.data).await?;
        notify_record_changed(
            &state,
            &request,
            &commit.head.target,
            Some(commit.head.head_revision),
            commit.metadata.as_ref(),
        );
        let editor = service.editor_get(&request, &commit.head.target).await?;
        Ok(RecordEditorSaveResult { commit, editor })
    }
    .await;
    Ok(ApiResponse::from_result(input.request_id, result))
}
#[tauri::command]
pub(crate) async fn record_create(
    state: State<'_, AppState>,
    input: RecordCommandInput<RecordCreate>,
) -> Result<ApiResponse<RecordEditorState>, String> {
    let result = async {
        let request = gui_request(
            &state,
            &input,
            &input.data.scope,
            &["record.read", "record.write", "record.metadata.write"],
        )?;
        let utility = AppDocumentUtility(state.app_handle.clone());
        let service = RecordDocumentService::new(&*state, &utility);
        let head = service.create(&request, &input.data).await?;
        notify_record_changed(
            &state,
            &request,
            &head.target,
            Some(head.head_revision),
            None,
        );
        service.editor_get(&request, &head.target).await
    }
    .await;
    Ok(ApiResponse::from_result(input.request_id, result))
}
#[tauri::command]
pub(crate) fn record_metadata_get(
    state: State<'_, AppState>,
    input: RecordCommandInput<RecordTarget>,
) -> ApiResponse<RecordMetadata> {
    let result = (|| {
        let request = gui_request(&state, &input, &input.data.scope, &["record.read"])?;
        let utility = AppDocumentUtility(state.app_handle.clone());
        RecordDocumentService::new(&*state, &utility).metadata_get(&request, &input.data)
    })();
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn record_metadata_apply(
    state: State<'_, AppState>,
    input: RecordCommandInput<RecordMetadataApply>,
) -> ApiResponse<RecordMetadataApplyResult> {
    let result = (|| {
        let request = gui_request(
            &state,
            &input,
            &input.data.metadata.target.scope,
            &["record.read", "record.metadata.write"],
        )?;
        let utility = AppDocumentUtility(state.app_handle.clone());
        let metadata =
            RecordDocumentService::new(&*state, &utility).metadata_apply(&request, &input.data)?;
        let tags = crate::record_document_service::BoundRecordStore::with_current(
            &*state,
            |binding, db| {
                request.authorize(binding, &input.data.metadata.target.scope, "record.read")?;
                db.record_metadata_tags(&input.data.metadata.target, &metadata.tag_ids)
            },
        )?;
        notify_record_changed(
            &state,
            &request,
            &input.data.metadata.target,
            None,
            Some(&metadata),
        );
        Ok(RecordMetadataApplyResult { metadata, tags })
    })();
    ApiResponse::from_result(input.request_id, result)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordMetadataApplyResult {
    metadata: RecordMetadata,
    tags: Vec<crate::models::DocumentTagRecord>,
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
        let metadata =
            RecordDocumentService::new(&*state, &utility).metadata_update(&request, &input.data)?;
        notify_record_changed(&state, &request, &input.data.target, None, Some(&metadata));
        Ok(metadata)
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
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordVersionPreview {
    version: RecordVersion,
    html: String,
}
#[tauri::command]
pub(crate) async fn record_version_preview(
    state: State<'_, AppState>,
    input: RecordCommandInput<VersionGetInput>,
) -> Result<ApiResponse<RecordVersionPreview>, String> {
    let result = async {
        let request = gui_request(&state, &input, &input.data.target.scope, &["record.read"])?;
        let utility = AppDocumentUtility(state.app_handle.clone());
        let (version, html) = RecordDocumentService::new(&*state, &utility)
            .version_preview(&request, &input.data.target, &input.data.version_id)
            .await?;
        Ok(RecordVersionPreview { version, html })
    }
    .await;
    Ok(ApiResponse::from_result(input.request_id, result))
}
#[tauri::command]
pub(crate) async fn record_version_restore(
    state: State<'_, AppState>,
    input: RecordCommandInput<RecordRestoreInput>,
) -> Result<ApiResponse<RecordEditorSaveResult>, String> {
    let result = async {
        let request = gui_request(
            &state,
            &input,
            &input.data.target.scope,
            &["record.read", "record.restore"],
        )?;
        let utility = AppDocumentUtility(state.app_handle.clone());
        let service = RecordDocumentService::new(&*state, &utility);
        let commit = service.restore(&request, &input.data).await?;
        notify_record_changed(
            &state,
            &request,
            &commit.head.target,
            Some(commit.head.head_revision),
            None,
        );
        let editor = service.editor_get(&request, &input.data.target).await?;
        Ok(RecordEditorSaveResult { commit, editor })
    }
    .await;
    Ok(ApiResponse::from_result(input.request_id, result))
}
// Public Agent/bridge patch/restore capabilities remain disabled until their
// persisted grants and request adapters are implemented. Coordination is enforced by the service.
