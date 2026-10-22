//! Trusted local GUI Profile verification. Credentials never appear in responses.
use super::{
    errors::{AgentError, ApiResponse, ErrorCode},
    models::WorkspaceBinding,
};
use crate::{lock_mutex, AppState};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RunCommandInput<T> {
    binding: WorkspaceBinding,
    request_id: String,
    data: T,
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
