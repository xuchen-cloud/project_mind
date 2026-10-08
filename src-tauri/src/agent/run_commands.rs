//! Trusted local GUI entry points. Credentials never appear in command responses.
use super::{
    access::Caller,
    conversation::{RunPreparation, RunSettlement, StoredRun},
    errors::{AgentError, AgentResult, ApiResponse, ErrorCode},
    models::WorkspaceBinding,
    runtime::{RunEventKind, RunState},
    settings::SettingsRepository,
};
use crate::{lock_mutex, AppState};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tauri::{Emitter, State};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RunCommandInput<T> {
    binding: WorkspaceBinding,
    request_id: String,
    data: T,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StartInput {
    session_id: String,
    client_request_id: String,
    prompt: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CancelInput {
    run_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProbeInput {
    profile_override_id: Option<i64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeResult {
    verified: bool,
}

fn bound_runtime(
    state: &AppState,
    binding: &WorkspaceBinding,
) -> AgentResult<Arc<crate::WorkspaceRuntime>> {
    let current = lock_mutex(&state.current_workspace);
    let runtime = current
        .as_ref()
        .ok_or_else(|| AgentError::new(ErrorCode::WorkspaceNotOpen, "Open a Workspace first"))?;
    if runtime.agent_binding != *binding {
        return Err(AgentError::new(
            ErrorCode::WorkspaceChanged,
            "Workspace binding changed",
        ));
    }
    Ok(runtime.clone())
}

#[tauri::command]
pub(crate) fn agent_run_start(
    state: State<'_, AppState>,
    input: RunCommandInput<StartInput>,
) -> ApiResponse<StoredRun> {
    let result = (|| {
        if input.data.prompt.trim().is_empty() || input.data.prompt.len() > 65536 {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Question must contain 1–65536 bytes",
            ));
        }
        // Keep selection fixed until the run and cancellation channel are registered.
        let current = lock_mutex(&state.current_workspace);
        let runtime = current
            .as_ref()
            .ok_or_else(|| AgentError::new(ErrorCode::WorkspaceNotOpen, "Open a Workspace first"))?
            .clone();
        let db = lock_mutex(&runtime.db);
        let mut request = db.agent_gui_session_request(
            &input.binding,
            &runtime.agent_binding,
            &input.request_id,
            &input.data.session_id,
            &[
                "session.read",
                "session.write",
                "run.start",
                "run.cancel",
                "context.read",
                "source.read",
            ],
        )?;
        let session = db
            .agent_session_get(
                &request,
                &runtime.agent_binding,
                &input.data.session_id,
                None,
                1,
            )?
            .session;
        if session.runtime_id != "builtin-pi" {
            return Err(AgentError::new(
                ErrorCode::RuntimeUnavailable,
                "The selected session runtime is not installed",
            ));
        }
        if lock_mutex(&runtime.agent_runs)
            .keys()
            .any(|id| id.starts_with("probe-"))
        {
            return Err(AgentError::new(
                ErrorCode::RunBusy,
                "Wait for Profile verification to finish",
            ));
        }
        let settings = db.agent_settings_get(&session.scope)?;
        if !settings.enabled {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Enable the assistant for this scope first",
            ));
        }
        request
            .scope_grant
            .operations
            .extend(["output.read", "operation.read"].map(str::to_owned));
        if settings.execution_mode != super::models::ExecutionMode::ReadOnly {
            request.scope_grant.operations.extend(
                [
                    "output.stage",
                    "output.update",
                    "output.commit",
                    "content.create",
                    "record.patch",
                ]
                .map(str::to_owned),
            );
        }
        if settings.execution_mode == super::models::ExecutionMode::Collaborate {
            request
                .scope_grant
                .operations
                .extend(["operation.undo", "operation.restore_created"].map(str::to_owned));
        }
        let resolved = db.agent_resolve_profile(session.profile_override_id)?;
        if !db.agent_profile_verified(&resolved.fingerprint)? {
            return Err(AgentError::new(
                ErrorCode::ToolCallUnsupported,
                "Verify tool calling for this Profile and model first",
            ));
        }
        if !super::process::PackagedAgentRuntime::available(&state.app_handle) {
            return Err(AgentError::new(
                ErrorCode::RuntimeUnavailable,
                "Packaged assistant runtime is missing",
            ));
        }
        let prepared = db.agent_run_prepare(&request, &runtime.agent_binding, &session.id,
            &input.data.client_request_id, &RunPreparation {
                run_id: format!("{:032x}", rand::random::<u128>()),
                context_manifest: json!({"prompt": input.data.prompt, "scope": session.scope,
                    "profileFingerprint": resolved.fingerprint, "settingsRevision": settings.revision,
                    "goalRecordId": settings.goal_record_id, "pinnedRefs": settings.pinned_refs,
                    "mode": settings.execution_mode}),
            })?;
        if !prepared.created {
            return Ok(prepared.run);
        }
        let run = prepared.run;
        request.caller = Caller::BuiltinRun {
            run_id: run.id.clone(),
        };
        let (cancel, receiver) = tokio::sync::watch::channel(false);
        lock_mutex(&runtime.agent_runs).insert(run.id.clone(), cancel);
        drop(db);
        drop(current);
        let app = state.app_handle.clone();
        let run_id = run.id.clone();
        tauri::async_runtime::spawn(async move {
            let outcome = super::host::execute(
                app.clone(),
                runtime.clone(),
                request.clone(),
                session,
                run_id.clone(),
                input.data.prompt,
                resolved.profile,
                receiver,
            )
            .await;
            let mut settlement = outcome.unwrap_or_else(|error| RunSettlement {
                state: RunState::Failed,
                runtime_settled: false,
                projection: None,
                usage: None,
                error_code: Some(error.code),
            });
            let db = lock_mutex(&runtime.db);
            let mut settled =
                db.agent_run_settle(&request, &runtime.agent_binding, &run_id, &settlement);
            if let Err(error) = &settled {
                // A rejected projection must not leave a dead process occupying
                // the single active-run slot. Preserve the last verified history
                // and record the failed settlement without publishing success.
                settlement = RunSettlement {
                    state: RunState::Failed,
                    runtime_settled: false,
                    projection: None,
                    usage: settlement.usage,
                    error_code: Some(error.code),
                };
                settled =
                    db.agent_run_settle(&request, &runtime.agent_binding, &run_id, &settlement);
            }
            if let Ok(run) = settled {
                let event = match run.state {
                    RunState::Completed => RunEventKind::Completed,
                    RunState::Cancelled => RunEventKind::Cancelled,
                    _ => RunEventKind::Failed {
                        error: AgentError::new(
                            settlement
                                .error_code
                                .unwrap_or(ErrorCode::RuntimeUnavailable),
                            "Assistant run did not complete",
                        ),
                    },
                };
                if let Ok(event) =
                    db.agent_run_event_append(&request, &runtime.agent_binding, &run_id, &event)
                {
                    let _ = app.emit("agent-run-event", event);
                }
            } else {
                // Database failure is recoverable on Workspace reopen; do not
                // claim a durable terminal state that was never committed.
                eprintln!("Assistant run settlement could not be persisted");
            }
            drop(db);
            lock_mutex(&runtime.agent_runs).remove(&run_id);
        });
        Ok(run)
    })();
    ApiResponse::from_result(input.request_id, result)
}

#[tauri::command]
pub(crate) fn agent_run_cancel(
    state: State<'_, AppState>,
    input: RunCommandInput<CancelInput>,
) -> ApiResponse<StoredRun> {
    let result = (|| {
        let runtime = bound_runtime(&state, &input.binding)?;
        let db = lock_mutex(&runtime.db);
        let request = db.agent_gui_run_request(
            &input.binding,
            &runtime.agent_binding,
            &input.request_id,
            &input.data.run_id,
            &["session.read", "run.cancel"],
        )?;
        let run = db.agent_run_get(&request, &runtime.agent_binding, &input.data.run_id)?;
        if !run.state.is_terminal() {
            if let Some(cancel) = lock_mutex(&runtime.agent_runs).get(&run.id) {
                cancel.send_replace(true);
            }
        }
        Ok(run)
    })();
    ApiResponse::from_result(input.request_id, result)
}

#[tauri::command]
pub(crate) async fn agent_profile_probe(
    state: State<'_, AppState>,
    input: RunCommandInput<ProbeInput>,
) -> Result<ApiResponse<ProbeResult>, String> {
    let result = async {
        if input.request_id.is_empty() || input.request_id.len() > 128 {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid request identity",
            ));
        }
        let (runtime, resolved, receiver, probe_id) = {
            let current = lock_mutex(&state.current_workspace);
            let runtime = current
                .as_ref()
                .ok_or_else(|| {
                    AgentError::new(ErrorCode::WorkspaceNotOpen, "Open a Workspace first")
                })?
                .clone();
            if runtime.agent_binding != input.binding {
                return Err(AgentError::new(
                    ErrorCode::WorkspaceChanged,
                    "Workspace binding changed",
                ));
            }
            let resolved =
                lock_mutex(&runtime.db).agent_resolve_profile(input.data.profile_override_id)?;
            let mut running = lock_mutex(&runtime.agent_runs);
            if !running.is_empty() {
                return Err(AgentError::new(
                    ErrorCode::RunBusy,
                    "Wait for the current assistant operation",
                ));
            }
            let probe_id = format!("probe-{:032x}", rand::random::<u128>());
            let (cancel, receiver) = tokio::sync::watch::channel(false);
            running.insert(probe_id.clone(), cancel);
            drop(running);
            (runtime, resolved, receiver, probe_id)
        };
        let outcome = super::profile_probe::verify(
            &state.app_handle,
            &runtime.paths.root_path,
            resolved.profile,
            receiver,
        )
        .await;
        lock_mutex(&runtime.agent_runs).remove(&probe_id);
        outcome?;
        // The async probe proves only the exact configuration that initiated it.
        let current = lock_mutex(&state.current_workspace);
        if !current
            .as_ref()
            .is_some_and(|value| value.agent_binding == input.binding)
        {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Workspace binding changed",
            ));
        }
        let db = lock_mutex(&runtime.db);
        let now = db.agent_resolve_profile(input.data.profile_override_id)?;
        if now.fingerprint != resolved.fingerprint {
            return Err(AgentError::new(
                ErrorCode::ProfileUnavailable,
                "Profile changed during verification",
            ));
        }
        db.agent_profile_record_verification(&now.fingerprint)?;
        Ok(ProbeResult { verified: true })
    }
    .await;
    Ok(ApiResponse::from_result(input.request_id, result))
}
