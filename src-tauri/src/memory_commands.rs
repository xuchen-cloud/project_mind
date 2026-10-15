use crate::{
    agent::{
        access::{Caller, RequestContext, ScopeGrant},
        errors::{AgentError, ApiResponse, ErrorCode},
        models::{Scope, WorkspaceBinding},
    },
    db::memory_service::{
        MemoryDetail, MemoryGetInput, MemoryListInput, MemoryListPage, MemoryUpdateInput,
    },
    source_service::BoundSourceStore,
    AppState,
};
use serde::Deserialize;
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemoryCommandInput<T> {
    binding: WorkspaceBinding,
    request_id: String,
    data: T,
}

fn request(
    binding: &WorkspaceBinding,
    request_id: &str,
    scope: &Scope,
    project_ids: Vec<i64>,
) -> RequestContext {
    RequestContext {
        binding: binding.clone(),
        request_id: request_id.into(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: matches!(scope, Scope::Workspace),
            project_ids,
            operations: vec![
                "memory.manage".into(),
                "context.read".into(),
                "session.read".into(),
            ],
            object_keys: None,
        },
    }
}

#[tauri::command]
pub(crate) fn agent_memory_list(
    state: State<'_, AppState>,
    input: MemoryCommandInput<MemoryListInput>,
) -> ApiResponse<MemoryListPage> {
    let result = state.with_current(|binding, db| {
        if binding != &input.binding {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Workspace changed",
            ));
        }
        let project_ids = match &input.data.scope {
            Scope::Project { project_id } => vec![*project_id],
            Scope::Workspace => db.agent_active_project_ids()?,
        };
        db.agent_memory_list(
            &request(binding, &input.request_id, &input.data.scope, project_ids),
            binding,
            &input.data,
        )
    });
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn agent_memory_get(
    state: State<'_, AppState>,
    input: MemoryCommandInput<MemoryGetInput>,
) -> ApiResponse<MemoryDetail> {
    let result = state.with_current(|binding, db| {
        if binding != &input.binding {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Workspace changed",
            ));
        }
        let project_ids = match &input.data.scope {
            Scope::Project { project_id } => vec![*project_id],
            Scope::Workspace => db.agent_active_project_ids()?,
        };
        db.agent_memory_get(
            &request(binding, &input.request_id, &input.data.scope, project_ids),
            binding,
            &input.data,
        )
    });
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn agent_memory_update(
    state: State<'_, AppState>,
    input: MemoryCommandInput<MemoryUpdateInput>,
) -> ApiResponse<MemoryDetail> {
    let result = state.with_current(|binding, db| {
        if binding != &input.binding {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Workspace changed",
            ));
        }
        let project_ids = match &input.data.scope {
            Scope::Project { project_id } => vec![*project_id],
            Scope::Workspace => db.agent_active_project_ids()?,
        };
        db.agent_memory_update(
            &request(binding, &input.request_id, &input.data.scope, project_ids),
            binding,
            &input.data,
        )
    });
    ApiResponse::from_result(input.request_id, result)
}
