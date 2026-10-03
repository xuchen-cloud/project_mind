//! Trusted local File GUI adapter. Remote File capabilities remain closed.
use crate::{
    agent::{
        errors::{AgentError, ApiResponse, ErrorCode},
        models::WorkspaceBinding,
    },
    db::file_versions::{GuiFileVersionIntent, GuiFileVersionPrepare},
    file_version_service::{FileVersionCommitResult, FileVersionService, FilesystemFileReader},
    AppState,
};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedFileVersion {
    binding: WorkspaceBinding,
    intent: GuiFileVersionIntent,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileVersionCommitInput {
    binding: WorkspaceBinding,
    request_id: String,
    intent: GuiFileVersionIntent,
    register_current_bytes: bool,
}
#[cfg(test)]
use crate::file_version_service::validate_binding;
#[tauri::command]
pub(crate) async fn document_version_prepare(
    state: State<'_, AppState>,
    input: GuiFileVersionPrepare,
    request_id: String,
) -> Result<ApiResponse<PreparedFileVersion>, String> {
    let result = async {
        if request_id.is_empty() || request_id.len() > 128 {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid File preflight identity",
            ));
        }
        let runtime = state.current_workspace().map_err(|_| {
            AgentError::new(ErrorCode::WorkspaceNotOpen, "Open a Workspace first")
        })?;
        let binding = runtime.agent_binding.clone();
        let app_handle = state.app_handle.clone();
        // Hashing must neither block the command thread nor retain the DB or
        // Workspace selection guard. The service resolves the frozen binding
        // again inside this task, including switches while the task was queued.
        tauri::async_runtime::spawn_blocking(move || {
            let state = app_handle.state::<AppState>();
            let intent = FileVersionService::new(&*state, &FilesystemFileReader)
                .prepare_gui(&binding, &input)?;
            Ok(PreparedFileVersion { binding, intent })
        })
        .await
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "File preflight task failed"))?
    }
    .await;
    Ok(ApiResponse::from_result(request_id, result))
}
#[tauri::command]
pub(crate) async fn document_add_version(
    state: State<'_, AppState>,
    input: FileVersionCommitInput,
) -> Result<ApiResponse<FileVersionCommitResult>, String> {
    let request_id = input.request_id.clone();
    let app_handle = state.app_handle.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        FileVersionService::new(&*state, &FilesystemFileReader).commit_gui(
            &input.binding,
            &input.request_id,
            &input.intent,
            input.register_current_bytes,
        )
    })
    .await
    .unwrap_or_else(|_| {
        Err(AgentError::new(ErrorCode::IoFailed, "File commit task failed"))
    });
    Ok(ApiResponse::from_result(request_id, result))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_gui_binding_rejects_other_workspace_and_same_path_reopen() {
        let original = WorkspaceBinding {
            workspace_id: "workspace".into(),
            generation: "open-1".into(),
        };
        assert!(validate_binding(&original, &original).is_ok());
        for changed in [
            WorkspaceBinding {
                generation: "open-2".into(),
                ..original.clone()
            },
            WorkspaceBinding {
                workspace_id: "other-workspace".into(),
                ..original.clone()
            },
        ] {
            assert_eq!(
                validate_binding(&original, &changed).unwrap_err().code,
                ErrorCode::WorkspaceChanged
            );
        }
    }
}
