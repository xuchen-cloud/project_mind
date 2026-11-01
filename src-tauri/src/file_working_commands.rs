//! Only trusted GUI authority can create or use an editing session.
use crate::{
    agent::{
        errors::{AgentError, ApiResponse, ErrorCode},
        models::WorkspaceBinding,
    },
    file_working::*,
    AppState,
};
use serde::Deserialize;
use tauri::{Manager, State};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Input<T> {
    binding: WorkspaceBinding,
    request_id: String,
    data: T,
}
macro_rules! sync_command {
    ($name:ident,$data:ty,$result:ty,$body:expr) => {
        #[tauri::command]
        pub(crate) async fn $name(
            state: State<'_, AppState>,
            input: Input<$data>,
        ) -> Result<ApiResponse<$result>, String> {
            let id = input.request_id.clone();
            let app = state.app_handle.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                let state = app.state::<AppState>();
                let request = crate::file_office::gui_request(
                    &*state,
                    &input.binding,
                    &input.request_id,
                    &input.data.object,
                    true,
                )?;
                ($body)(&*state, &request, &input.data)
            })
            .await
            .unwrap_or_else(|_| {
                Err(AgentError::new(
                    ErrorCode::IoFailed,
                    "File working task failed",
                ))
            });
            Ok(ApiResponse::from_result(id, result))
        }
    };
}
sync_command!(
    file_working_save_text,
    WorkingSaveText,
    WorkingStatus,
    save_text
);
sync_command!(
    file_working_activity,
    WorkingSession,
    WorkingStatus,
    |s: &AppState, r: &crate::agent::access::RequestContext, i: &WorkingSession| with_db(
        s,
        r,
        |db| db.file_working_activity(r, &r.binding, i, chrono::Utc::now().timestamp_millis())
    )
);
sync_command!(
    file_working_close,
    WorkingSession,
    (),
    |s: &AppState, r: &crate::agent::access::RequestContext, i: &WorkingSession| with_db(
        s,
        r,
        |db| db.file_working_close(r, &r.binding, i)
    )
);
sync_command!(
    file_working_tick,
    WorkingObject,
    WorkingStatus,
    |s: &AppState, r: &crate::agent::access::RequestContext, i: &WorkingObject| with_db(
        s,
        r,
        |db| db.file_working_archive(
            r,
            &r.binding,
            &i.object,
            chrono::Utc::now().timestamp_millis(),
            false
        )
    )
);
sync_command!(
    file_working_archive,
    WorkingObject,
    WorkingStatus,
    |s: &AppState, r: &crate::agent::access::RequestContext, i: &WorkingObject| with_db(
        s,
        r,
        |db| db.file_working_archive(
            r,
            &r.binding,
            &i.object,
            chrono::Utc::now().timestamp_millis(),
            true
        )
    )
);
macro_rules! office_command {
    ($name:ident,$data:ty,$result:ty,$body:ident) => {
        #[tauri::command]
        pub(crate) async fn $name(
            state: State<'_, AppState>,
            input: Input<$data>,
        ) -> Result<ApiResponse<$result>, String> {
            let id = input.request_id.clone();
            let app = state.app_handle.clone();
            let handle = tokio::runtime::Handle::current();
            let result = tauri::async_runtime::spawn_blocking(move || {
                let state = app.state::<AppState>();
                let request = crate::file_office::gui_request(
                    &*state,
                    &input.binding,
                    &input.request_id,
                    &input.data.object,
                    true,
                )?;
                handle.block_on(crate::file_working::$body(
                    &*state,
                    &crate::office_worker::AppOfficeUtility(app.clone()),
                    &request,
                    &input.data,
                ))
            })
            .await
            .unwrap_or_else(|_| {
                Err(AgentError::new(
                    ErrorCode::IoFailed,
                    "Office working task failed",
                ))
            });
            Ok(ApiResponse::from_result(id, result))
        }
    };
}
office_command!(file_working_open, WorkingObject, WorkingOpened, open);
office_command!(
    file_working_save_office,
    WorkingSaveOffice,
    WorkingStatus,
    save_office
);
office_command!(
    file_working_recalculate,
    WorkingRecalculate,
    crate::office_worker::OfficeRecalculationResult,
    recalculate
);

pub(crate) fn start(app: &tauri::AppHandle) {
    use crate::source_service::BoundSourceStore;
    use tauri::Emitter;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last_error: Option<String> = None;
        loop {
            let binding = {
                let state = app.state::<AppState>();
                state.with_current(|binding, _| Ok(binding.clone())).ok()
            };
            if let Some(binding) = binding {
                let handle = app.clone();
                let captured = binding.clone();
                let result = tauri::async_runtime::spawn_blocking(
                    move || -> crate::agent::errors::AgentResult<()> {
                        let state = handle.state::<AppState>();
                        let now = chrono::Utc::now().timestamp_millis();
                        let objects = state.with_current(|binding, db| {
                            crate::file_version_service::validate_binding(&captured, binding)?;
                            db.file_working_due_objects(&binding.workspace_id, now)
                        })?;
                        let mut failure = None;
                        for object in objects {
                            let request = crate::file_office::gui_request(
                                &*state,
                                &captured,
                                &format!("working-tick-{}-{now}", object.id),
                                &object,
                                true,
                            )?;
                            if let Err(error) = with_db(&*state, &request, |db| {
                                db.file_working_archive(&request, &captured, &object, now, false)
                            }) {
                                failure = Some(error);
                            }
                        }
                        if let Some(error) = failure {
                            Err(error)
                        } else {
                            Ok(())
                        }
                    },
                )
                .await
                .unwrap_or_else(|error| {
                    Err(AgentError::new(
                        ErrorCode::IoFailed,
                        format!("Working archive task failed: {error}"),
                    ))
                });
                match result {
                    Ok(()) => last_error = None,
                    Err(error)
                        if matches!(
                            error.code,
                            ErrorCode::WorkspaceChanged | ErrorCode::WorkspaceNotOpen
                        ) =>
                    {
                        last_error = None
                    }
                    Err(error) => {
                        let payload = serde_json::json!({"binding":binding,"error":error});
                        let key = payload.to_string();
                        if last_error.as_ref() != Some(&key) {
                            let _ = app.emit("file:working-archive-error", payload);
                            last_error = Some(key);
                        }
                    }
                }
            } else {
                last_error = None;
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    });
}
sync_command!(
    file_working_recovery_read,
    WorkingObject,
    WorkingRecovery,
    |s: &AppState, r: &crate::agent::access::RequestContext, i: &WorkingObject| with_db(
        s,
        r,
        |db| db.file_working_recovery_read(r, &r.binding, &i.object)
    )
);
