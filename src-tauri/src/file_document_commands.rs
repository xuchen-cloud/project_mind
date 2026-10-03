//! Trusted local File GUI adapter. Remote File capabilities remain closed.
use crate::{
    agent::{
        errors::{AgentError, AgentResult, ApiResponse, ErrorCode},
        models::WorkspaceBinding,
    },
    committed_changes::CommittedChangePublisher,
    db::file_versions::{CommittedVersion, GuiFileVersionIntent, GuiFileVersionPrepare},
    file_version_service::{FileVersionService, FilesystemFileReader},
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
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileVersionCommitResult {
    receipt: CommittedVersion,
    version_path: Option<String>,
}
fn validate_binding(expected: &WorkspaceBinding, current: &WorkspaceBinding) -> AgentResult<()> {
    if expected != current {
        return Err(AgentError::new(
            ErrorCode::WorkspaceChanged,
            "File Workspace was closed or reopened",
        ));
    }
    Ok(())
}
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
pub(crate) fn document_add_version(
    state: State<'_, AppState>,
    input: FileVersionCommitInput,
) -> ApiResponse<FileVersionCommitResult> {
    let result = (|| {
        let (result, changes) = {
            let current = crate::lock_mutex(&state.current_workspace);
            let runtime = current.as_ref().ok_or_else(|| {
                AgentError::new(ErrorCode::WorkspaceNotOpen, "Open a Workspace first")
            })?;
            validate_binding(&input.binding, &runtime.agent_binding)?;
            let mut db = crate::lock_mutex(&runtime.db);
            let before = db.committed_change_watermark()?;
            let result = db.file_version_commit_gui(
                &runtime.agent_binding,
                &input.request_id,
                &input.intent,
                input.register_current_bytes,
            );
            // Delivery/cleanup reads cannot change a successful durable receipt.
            let changes =
                match db.committed_changes_since(&runtime.agent_binding, &input.request_id, before)
                {
                    Ok(changes) => changes,
                    Err(error) => {
                        eprintln!("File notification capture failed: {}", error.message);
                        None
                    }
                };
            let result = result.map(|receipt| {
                let version_path =
                    db.file_version_committed_path(&receipt)
                        .unwrap_or_else(|error| {
                            eprintln!("Committed File path lookup failed: {error}");
                            None
                        });
                FileVersionCommitResult {
                    receipt,
                    version_path,
                }
            });
            (result, changes)
        };
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
