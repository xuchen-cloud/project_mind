use super::{credentials, dispatch::AppBridge, protocol::DISCOVERY_FILE, transport};
use crate::{
    agent::{
        connections::{ConnectionCreateInput, ConnectionGrant},
        errors::{AgentError, AgentResult, ApiResponse, ErrorCode},
        models::WorkspaceBinding,
    },
    lock_mutex, AppState,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{atomic::Ordering, Arc},
};
use tauri::{Manager, State};

const SETTINGS_FILE: &str = "external-connections.json";

#[derive(Serialize, Deserialize)]
struct LocalSettings {
    enabled: bool,
}

fn local_file(state: &AppState, name: &str) -> PathBuf {
    state.local_session_path.with_file_name(name)
}
fn io_error() -> AgentError {
    AgentError::new(
        ErrorCode::IoFailed,
        "Cannot save external connection settings",
    )
}
fn save_enabled(state: &AppState, enabled: bool) -> AgentResult<()> {
    let path = local_file(state, SETTINGS_FILE);
    let parent = path.parent().ok_or_else(io_error)?;
    std::fs::create_dir_all(parent).map_err(|_| io_error())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|_| io_error())?;
    serde_json::to_writer(temporary.as_file_mut(), &LocalSettings { enabled })
        .map_err(|_| io_error())?;
    temporary.as_file().sync_all().map_err(|_| io_error())?;
    temporary.persist(path).map_err(|_| io_error())?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionStatus {
    enabled: bool,
    running: bool,
    binding: Option<WorkspaceBinding>,
    cli_path: Option<String>,
    cli_shell: &'static str,
    workspace_path: Option<String>,
    connections: Vec<ConnectionGrant>,
}

async fn snapshot(state: &AppState) -> AgentResult<ConnectionStatus> {
    let running = state.external_bridge.running.lock().await.as_ref().is_some_and(|server| server.is_running());
    let current = lock_mutex(&state.current_workspace);
    let (binding, workspace_path, connections) = if let Some(runtime) = current.as_ref() {
        let connections = lock_mutex(&runtime.db).agent_connection_list(&runtime.agent_binding)?;
        (
            Some(runtime.agent_binding.clone()),
            Some(runtime.paths.root_path.to_string_lossy().into_owned()),
            connections,
        )
    } else {
        (None, None, vec![])
    };
    let cli_path = std::env::current_exe().ok().and_then(|exe| {
        let candidate = exe
            .parent()?
            .join(if cfg!(windows) { "mind.exe" } else { "mind" });
        candidate
            .is_file()
            .then(|| candidate.to_string_lossy().into_owned())
    });
    let enabled = state.external_bridge.enabled.load(Ordering::Acquire);
    Ok(ConnectionStatus {
        enabled,
        running,
        binding,
        cli_path,
        cli_shell: if cfg!(windows) { "powershell" } else { "posix" },
        workspace_path,
        connections,
    })
}

async fn set_enabled(state: &AppState, enabled: bool) -> AgentResult<()> {
    let mut current = state.external_bridge.running.lock().await;
    if enabled && current.is_none() {
        let running = transport::start(
            Arc::new(AppBridge(state.app_handle.clone())),
            local_file(state, DISCOVERY_FILE),
        )
        .await?;
        if let Err(error) = save_enabled(state, true) {
            running.stop().await?;
            return Err(error);
        }
        *current = Some(running);
        state.external_bridge.enabled.store(true, Ordering::Release);
    } else if !enabled {
        state
            .external_bridge
            .enabled
            .store(false, Ordering::Release);
        if let Some(running) = current.take() {
            running.stop().await?;
        }
        save_enabled(state, false)?;
    }
    Ok(())
}

pub(crate) fn restore(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let result = async {
            let bytes = match std::fs::read(local_file(&state, SETTINGS_FILE)) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(_) => return Err(io_error()),
            };
            let settings: LocalSettings = serde_json::from_slice(&bytes).map_err(|_| io_error())?;
            if settings.enabled {
                set_enabled(&state, true).await?;
            }
            Ok::<_, AgentError>(())
        }
        .await;
        if let Err(error) = result {
            eprintln!("External connections could not start: {:?}", error.code);
        }
    });
}

#[tauri::command]
pub(crate) async fn agent_connections_status(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<ApiResponse<ConnectionStatus>, String> {
    Ok(ApiResponse::from_result(request_id, snapshot(&state).await))
}
#[tauri::command]
pub(crate) async fn agent_connections_enable(
    state: State<'_, AppState>,
    request_id: String,
    enabled: bool,
) -> Result<ApiResponse<ConnectionStatus>, String> {
    let result = match set_enabled(&state, enabled).await {
        Ok(()) => snapshot(&state).await,
        Err(error) => Err(error),
    };
    Ok(ApiResponse::from_result(request_id, result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectionCommand<T> {
    binding: WorkspaceBinding,
    request_id: String,
    data: T,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RevokeInput {
    grant_id: String,
}

fn with_bound<T>(
    state: &AppState,
    binding: &WorkspaceBinding,
    action: impl FnOnce(&crate::db::Database) -> AgentResult<T>,
) -> AgentResult<T> {
    let current = lock_mutex(&state.current_workspace);
    let runtime = current
        .as_ref()
        .ok_or_else(|| AgentError::new(ErrorCode::WorkspaceNotOpen, "Open a Workspace first"))?;
    if &runtime.agent_binding != binding {
        return Err(AgentError::new(
            ErrorCode::WorkspaceChanged,
            "Workspace changed",
        ));
    }
    let db = lock_mutex(&runtime.db);
    action(&db)
}

#[tauri::command]
pub(crate) fn agent_connection_create(
    state: State<'_, AppState>,
    input: ConnectionCommand<ConnectionCreateInput>,
) -> ApiResponse<ConnectionGrant> {
    let result = (|| {
        with_bound(&state, &input.binding, |_| Ok(()))?;
        let grant_id = format!("{:032x}", rand::random::<u128>());
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        credentials::save(&grant_id, &token)?;
        let result = with_bound(&state, &input.binding, |db| {
            db.agent_connection_create(&input.binding, &input.data, &grant_id, &token)
        });
        if result.is_err() {
            credentials::delete(&grant_id).map_err(|_| {
                AgentError::new(
                    ErrorCode::IoFailed,
                    "Connection was not created; local credential cleanup failed",
                )
            })?;
        }
        result
    })();
    ApiResponse::from_result(input.request_id, result)
}

#[tauri::command]
pub(crate) fn agent_connection_revoke(
    state: State<'_, AppState>,
    input: ConnectionCommand<RevokeInput>,
) -> ApiResponse<ConnectionGrant> {
    let result = (|| {
        let grant = with_bound(&state, &input.binding, |db| {
            db.agent_connection_revoke(&input.binding, &input.data.grant_id)
        })?;
        credentials::delete(&input.data.grant_id).map_err(|_| {
            AgentError::new(
                ErrorCode::IoFailed,
                "Connection is revoked; local credential cleanup failed",
            )
        })?;
        Ok(grant)
    })();
    ApiResponse::from_result(input.request_id, result)
}
