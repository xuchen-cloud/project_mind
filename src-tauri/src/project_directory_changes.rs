//! Trusted local GUI adapters. Capture a Host before taking storage leases.
use crate::{
    agent::{
        errors::{AgentError, ErrorCode},
        models::WorkspaceBinding,
    },
    committed_changes::CommittedChangePublisher,
    db::{
        project_directory_changes::{
            DirectoryChangeInput, DirectoryChangeResult, PreparedDirectoryChange,
        },
        project_directory_files::FileServiceError,
    },
    file_version_service::BoundFileCommitStore,
    AppState,
};
use tauri::{Manager, Webview};
fn service_error(error: AgentError) -> FileServiceError {
    FileServiceError {
        code: if error.code == ErrorCode::WorkspaceChanged {
            "workspace_changed"
        } else {
            "io_failed"
        },
        message: error.message,
    }
}
fn host(
    caller: &Webview,
    binding: &WorkspaceBinding,
    project: Option<i64>,
) -> Result<crate::file_version_service::FileCommitHost, FileServiceError> {
    crate::project_directory::authorize_caller(caller, project).map_err(|message| {
        FileServiceError {
            code: "ownership_mismatch",
            message,
        }
    })?;
    caller
        .state::<AppState>()
        .gui_commit_host(binding)
        .map_err(service_error)
}
#[tauri::command]
pub(crate) async fn project_directory_change_prepare(
    caller: Webview,
    binding: WorkspaceBinding,
    project_id: Option<i64>,
    relative_path: String,
) -> Result<PreparedDirectoryChange, FileServiceError> {
    let host = host(&caller, &binding, project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let db = host.database().map_err(service_error)?;
        // Preparing a menu never performs crash recovery or writes content.
        let _permit = host.fence().enter().map_err(service_error)?;
        db.project_directory_change_prepare(&binding, project_id, &relative_path)
            .map_err(FileServiceError::from_error)
    })
    .await
    .map_err(|e| FileServiceError {
        code: "io_failed",
        message: e.to_string(),
    })?
}
async fn change(
    caller: Webview,
    input: DirectoryChangeInput,
) -> Result<DirectoryChangeResult, FileServiceError> {
    let host = host(&caller, &input.binding, input.project_id)?;
    let app = caller.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = host.database().map_err(service_error)?;
        // Reconcile File journals before acquiring owner/File leases or entering
        // the lifecycle fence. Per-File conflicts remain guarded below.
        db.file_version_recover_pending()
            .map_err(FileServiceError::from_error)?;
        let (result, changes) = {
            crate::committed_changes::capture_committed(
                host.binding(),
                &db,
                &input.request_id,
                || {
                    // Preserve the structured GUI error, including active_editors.
                    Ok(db
                        .project_directory_change_fenced_with(
                            &input,
                            |path| {
                                trash::delete(path)
                                    .map_err(|e| anyhow::anyhow!("无法移入系统回收站：{e}"))
                            },
                            || host.fence().enter().map_err(|e| anyhow::anyhow!(e.message)),
                        )
                        .map_err(FileServiceError::from_error))
                },
            )
            .map_err(service_error)?
        };
        if let Some(changes) = changes {
            app.state::<AppState>().publish_committed(changes);
        }
        let result = result.map_err(service_error)??;
        // Retire cached descendants, including folders with no registered File.
        if let Ok(root) = db.file_scope_root(input.project_id) {
            let scope = crate::project_directory::DirectoryScope::new(
                &input.binding,
                input.project_id,
                &root,
            );
            crate::project_directory::invalidate_scope(&scope, None, false);
        }
        Ok(result)
    })
    .await
    .map_err(|e| FileServiceError {
        code: "io_failed",
        message: e.to_string(),
    })?
}
#[tauri::command]
pub(crate) async fn project_directory_rename(
    caller: Webview,
    binding: WorkspaceBinding,
    project_id: Option<i64>,
    relative_path: String,
    token: String,
    name: String,
    request_id: String,
) -> Result<DirectoryChangeResult, FileServiceError> {
    change(
        caller,
        DirectoryChangeInput {
            binding,
            project_id,
            relative_path,
            token,
            name: Some(name),
            confirmed: None,
            request_id,
        },
    )
    .await
}
#[tauri::command]
pub(crate) async fn project_directory_delete(
    caller: Webview,
    binding: WorkspaceBinding,
    project_id: Option<i64>,
    relative_path: String,
    token: String,
    confirmed: bool,
    request_id: String,
) -> Result<DirectoryChangeResult, FileServiceError> {
    change(
        caller,
        DirectoryChangeInput {
            binding,
            project_id,
            relative_path,
            token,
            name: None,
            confirmed: Some(confirmed),
            request_id,
        },
    )
    .await
}
