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

/// Bind GUI operations to the Workspace opened when the panel was loaded.
/// The store is shared with DSH; a GUI action supplies user confirmation itself.
#[tauri::command]
pub(crate) fn memory_execute(
    state: State<'_, AppState>,
    caller: tauri::Webview,
    binding: WorkspaceBinding,
    scope: crate::db::memory_facts::MemoryScope,
    request: crate::db::memory_facts::MemoryRequest,
) -> Result<serde_json::Value, String> {
    use crate::db::memory_facts::{MemoryAccess, MemoryOrigin, MemoryScope};
    crate::dsh_assistant::authorize_caller(&caller)?;
    let project_id = match &scope {
        MemoryScope::Workspace => None,
        MemoryScope::Project { project_id } => Some(*project_id),
    };
    crate::dsh_assistant::authorize_scope_label(caller.label(), project_id)?;
    let current = crate::lock_mutex(&state.current_workspace);
    let runtime = current.as_ref().ok_or("请先打开工作区")?;
    if runtime.agent_binding != binding {
        return Err("工作区已变化，请重新打开记忆面板".into());
    }
    let db = crate::lock_mutex(&runtime.db);
    let listing = matches!(request, crate::db::memory_facts::MemoryRequest::List { .. });
    let mut result = db.memory_execute(
        &MemoryAccess {
            scope,
            origin: MemoryOrigin::User,
            sources: vec![],
        },
        request,
    )?;
    if let Some(facts) = result
        .get_mut("facts")
        .and_then(serde_json::Value::as_array_mut)
        .filter(|_| listing)
    {
        for fact in facts {
            if let Some(sources) = fact
                .get_mut("sources")
                .and_then(serde_json::Value::as_array_mut)
            {
                for source in sources {
                    let stored =
                        serde_json::from_value(source.clone()).map_err(|_| "无效记忆来源")?;
                    source["availability"] =
                        serde_json::json!(db.memory_source_availability(&binding, &stored)?);
                }
            }
        }
    }
    Ok(result)
}

#[tauri::command]
pub(crate) fn memory_adoption_get(
    state: State<'_, AppState>,
    caller: tauri::Webview,
    binding: WorkspaceBinding,
    scope: crate::db::memory_facts::MemoryScope,
    session_id: String,
    turn: u32,
) -> Result<Vec<serde_json::Value>, String> {
    use crate::db::memory_facts::MemoryScope;
    crate::dsh_assistant::authorize_caller(&caller)?;
    crate::dsh_assistant::authorize_scope_label(
        caller.label(),
        match scope {
            MemoryScope::Workspace => None,
            MemoryScope::Project { project_id } => Some(project_id),
        },
    )?;
    let current = crate::lock_mutex(&state.current_workspace);
    let runtime = current.as_ref().ok_or("工作区已关闭")?;
    if runtime.agent_binding != binding {
        return Err("工作区已变化".into());
    }
    let db = crate::lock_mutex(&runtime.db);
    db.memory_adoptions_for_turn(&scope, &session_id, turn)
}

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
