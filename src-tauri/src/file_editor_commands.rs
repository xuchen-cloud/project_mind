//! Native-window identity and current ownership guard the File move coordinator.
use crate::{
    agent::{
        errors::{AgentError, AgentResult, ApiResponse, ErrorCode},
        models::{ObjectRef, WorkspaceBinding},
    },
    file_editor_coordination::*,
    AppState,
};
use serde::Deserialize;
use std::sync::Arc;
use tauri::{Emitter, Manager, State, Webview};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Input<T> {
    binding: WorkspaceBinding,
    request_id: String,
    data: T,
}
fn authorize_caller(caller: &Webview, object: &ObjectRef) -> AgentResult<()> {
    crate::project_directory::authorize_caller(caller, crate::db::file_scope::owner(&object.scope))
        .map_err(|message| AgentError::new(ErrorCode::ScopeDenied, message))
}
fn authorize(
    state: &AppState,
    binding: &WorkspaceBinding,
    id: &str,
    object: &ObjectRef,
) -> AgentResult<()> {
    crate::file_office::gui_request(state, binding, id, object, false).map(|_| ())
}
#[tauri::command]
pub(crate) fn file_editor_register(
    caller: Webview,
    state: State<'_, AppState>,
    input: Input<FileEditorRegistration>,
) -> ApiResponse<()> {
    let result = (|| {
        authorize_caller(&caller, &input.data.object)?;
        authorize(
            &state,
            &input.binding,
            &input.request_id,
            &input.data.object,
        )?;
        state
            .file_editors
            .register(&input.binding, caller.label(), &input.data)
    })();
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn file_editor_unregister(
    caller: Webview,
    state: State<'_, AppState>,
    input: Input<FileEditorRegistration>,
) -> ApiResponse<()> {
    let result = (|| {
        authorize_caller(&caller, &input.data.object)?;
        state
            .file_editors
            .unregister(&input.binding, caller.label(), &input.data)
    })();
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn file_editor_flush_reply(
    caller: Webview,
    state: State<'_, AppState>,
    input: Input<FileEditorFlushReply>,
) -> ApiResponse<()> {
    let result = (|| {
        authorize_caller(&caller, &input.data.object)?;
        state
            .file_editors
            .reply(&input.binding, caller.label(), &input.data)
    })();
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn file_editors_release(
    caller: Webview,
    state: State<'_, AppState>,
    input: Input<ObjectRef>,
) -> ApiResponse<()> {
    let result = (|| {
        authorize_caller(&caller, &input.data)?;
        state.file_editors.release(
            &input.binding,
            &input.data,
            &input.request_id,
            caller.label(),
        )
    })();
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) async fn file_editors_flush(
    caller: Webview,
    state: State<'_, AppState>,
    input: Input<ObjectRef>,
) -> Result<ApiResponse<()>, String> {
    let result = async {
        authorize_caller(&caller, &input.data)?;
        authorize(&state, &input.binding, &input.request_id, &input.data)?;
        let app = state.app_handle.clone();
        let release_app = app.clone();
        let windows = app.webview_windows().into_keys().collect();
        state
            .file_editors
            .prepare(
                &input.binding,
                &input.data,
                &input.request_id,
                caller.label(),
                &windows,
                |request| {
                    app.emit_to(&request.window, "file:editor-flush-request", request)
                        .map_err(|_| {
                            AgentError::new(ErrorCode::IoFailed, "Cannot contact File editor")
                        })
                },
                Arc::new(move |event| {
                    let _ = release_app.emit("content:owner-move-released", event);
                }),
            )
            .await?;
        if let Err(error) = authorize(&state, &input.binding, &input.request_id, &input.data) {
            let _ = state.file_editors.release(
                &input.binding,
                &input.data,
                &input.request_id,
                caller.label(),
            );
            return Err(error);
        }
        Ok(())
    }
    .await;
    Ok(ApiResponse::from_result(input.request_id, result))
}
