use super::{
    protocol::{CallInput, ConnectInput},
    registry,
    transport::BridgeHandler,
};
use crate::{
    agent::{
        errors::{AgentError, AgentResult, ErrorCode},
        models::WorkspaceBinding,
        service::AgentDomainService,
    },
    db::{agent::WorkspaceContextRepository, Database},
    lock_mutex, AppState,
};
use serde_json::Value;
use std::sync::atomic::Ordering;
use tauri::Manager;

pub(crate) struct AppBridge(pub tauri::AppHandle);

fn unavailable() -> AgentError {
    AgentError::new(
        ErrorCode::WorkspaceNotOpen,
        "Open the requested Workspace in ProjectMind",
    )
}

pub(crate) fn execute(
    db: &Database,
    current: &WorkspaceBinding,
    workspace_name: &str,
    token: &str,
    input: CallInput,
) -> AgentResult<Value> {
    if input.binding != *current {
        return Err(AgentError::new(
            ErrorCode::WorkspaceChanged,
            "Workspace changed; reconnect explicitly",
        ));
    }
    let request =
        db.agent_connection_authenticate(current, &input.grant_id, token, &input.request_id)?;
    let value = match input.method.as_str() {
        "project.list" => {
            serde_json::from_value::<registry::ProjectListInput>(input.params).map_err(|_| {
                AgentError::new(
                    ErrorCode::InvalidArgument,
                    "Invalid project.list parameters",
                )
            })?;
            serde_json::to_value(db.agent_connection_projects(&request, current)?)
        }
        "context.get" => {
            let params: crate::agent::context::ContextGetInput =
                serde_json::from_value(input.params).map_err(|_| {
                    AgentError::new(ErrorCode::InvalidArgument, "Invalid context.get parameters")
                })?;
            if let crate::agent::models::Scope::Project { project_id } = &params.scope {
                db.source_read_object(
                    &request,
                    current,
                    &crate::agent::models::ObjectRef {
                        workspace_id: current.workspace_id.clone(),
                        scope: params.scope.clone(),
                        kind: crate::agent::models::ObjectKind::Project,
                        id: project_id.to_string(),
                    },
                )?;
            }
            let repository = WorkspaceContextRepository { db, workspace_name };
            serde_json::to_value(
                AgentDomainService::new(current, &repository).context_get(&request, params)?,
            )
        }
        _ => {
            return Err(AgentError::new(
                ErrorCode::ToolCallUnsupported,
                "Method is not available through this connection",
            ))
        }
    };
    value.map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot encode connection result"))
}

impl BridgeHandler for AppBridge {
    fn connect(&self, token: &str, input: ConnectInput) -> AgentResult<WorkspaceBinding> {
        let state = self.0.state::<AppState>();
        if !state.external_bridge.enabled.load(Ordering::Acquire) {
            return Err(AgentError::new(
                ErrorCode::RuntimeUnavailable,
                "External connections are disabled",
            ));
        }
        let current = lock_mutex(&state.current_workspace);
        let runtime = current.as_ref().ok_or_else(unavailable)?;
        // Only canonicalize the application's known root. Client paths are compared,
        // never opened by this endpoint.
        let root =
            runtime.paths.root_path.canonicalize().map_err(|_| {
                AgentError::new(ErrorCode::IoFailed, "Workspace path is unavailable")
            })?;
        if root != std::path::Path::new(&input.workspace_path) {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "The requested Workspace is not open",
            ));
        }
        lock_mutex(&runtime.db).agent_connection_authenticate(
            &runtime.agent_binding,
            &input.grant_id,
            token,
            &input.request_id,
        )?;
        Ok(runtime.agent_binding.clone())
    }

    fn call(&self, token: &str, input: CallInput) -> AgentResult<Value> {
        let state = self.0.state::<AppState>();
        if !state.external_bridge.enabled.load(Ordering::Acquire) {
            return Err(AgentError::new(
                ErrorCode::RuntimeUnavailable,
                "External connections are disabled",
            ));
        }
        // Synchronous read holds the same Workspace/DB locks used by GUI writes.
        // Workspace switches and grant revocation cannot interleave with this read.
        let current = lock_mutex(&state.current_workspace);
        let runtime = current.as_ref().ok_or_else(unavailable)?;
        let db = lock_mutex(&runtime.db);
        execute(
            &db,
            &runtime.agent_binding,
            &runtime.summary.display_name,
            token,
            input,
        )
    }
}
