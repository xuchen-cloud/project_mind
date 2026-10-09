use super::{
    access::{Caller, RequestContext, ScopeGrant},
    capabilities::{capabilities, Capability},
    context::{ContextEntry, ContextGetInput},
    errors::{AgentError, ApiResponse, ErrorCode},
    models::{Scope, WorkspaceBinding},
    service::AgentDomainService,
};
use crate::{lock_mutex, AppState};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentStatus {
    binding: Option<WorkspaceBinding>,
    runtime_available: bool,
    bridge_available: bool,
    capabilities: Vec<Capability>,
}

#[tauri::command]
pub(crate) fn agent_status_get(
    state: State<'_, AppState>,
    request_id: String,
) -> ApiResponse<AgentStatus> {
    let workspace = lock_mutex(&state.current_workspace);
    ApiResponse::from_result(
        request_id,
        Ok(AgentStatus {
            binding: workspace
                .as_ref()
                .map(|runtime| runtime.agent_binding.clone()),
            runtime_available: super::process::PackagedAgentRuntime::available(&state.app_handle),
            bridge_available: state.external_bridge.enabled.load(std::sync::atomic::Ordering::Acquire),
            capabilities: capabilities(),
        }),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContextCommandInput {
    binding: WorkspaceBinding,
    request_id: String,
    context: ContextGetInput,
}

#[tauri::command]
pub(crate) fn agent_context_get(
    state: State<'_, AppState>,
    input: ContextCommandInput,
) -> ApiResponse<ContextEntry> {
    let result = (|| {
        // Hold the Workspace lock through this short metadata read, so a switch cannot
        // interleave between generation verification and repository access.
        let current = lock_mutex(&state.current_workspace);
        let runtime = current.as_ref().ok_or_else(|| {
            AgentError::new(ErrorCode::WorkspaceNotOpen, "Open a Workspace first")
        })?;
        let scope_grant = ScopeGrant {
            workspace_id: runtime.agent_binding.workspace_id.clone(),
            workspace_content: matches!(input.context.scope, Scope::Workspace),
            project_ids: match input.context.scope {
                Scope::Project { project_id } => vec![project_id],
                _ => vec![],
            },
            operations: vec!["context.read".into(), "session.read".into()],
        };
        // This is the trusted local GUI adapter. Connections must resolve their own
        // persisted grant; never reuse this GUI grant builder for bridge/Pi requests.
        let request = RequestContext {
            binding: input.binding,
            scope_grant,
            caller: Caller::Gui,
            request_id: input.request_id.clone(),
        };
        let db = lock_mutex(&runtime.db);
        let repository = crate::db::agent::WorkspaceContextRepository {
            db: &db,
            workspace_name: &runtime.summary.display_name,
        };
        AgentDomainService::new(&runtime.agent_binding, &repository)
            .context_get(&request, input.context)
    })();
    ApiResponse::from_result(input.request_id, result)
}

/// The local GUI can select a Project, but cannot supply a caller or grant.
#[tauri::command]
pub(crate) async fn agent_overview_get(
    state: State<'_, AppState>,
    input: AgentCommandInput<crate::overview_service::OverviewReadInput>,
) -> Result<ApiResponse<crate::overview_service::OverviewReadPage>, String> {
    let request = RequestContext {
        binding: input.binding.clone(),
        request_id: input.request_id.clone(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: input.binding.workspace_id.clone(),
            workspace_content: matches!(input.data.scope, Scope::Workspace),
            project_ids: match input.data.scope {
                Scope::Project { project_id } => vec![project_id],
                _ => vec![],
            },
            operations: vec!["context.read".into(), "session.read".into()],
        },
    };
    let result = crate::overview_service::OverviewService::new(state.inner())
        .get(&request, &input.data)
        .await;
    Ok(ApiResponse::from_result(input.request_id, result))
}

fn gui_knowledge_request(binding: &WorkspaceBinding, request_id: &str, scope: &Scope) -> RequestContext {
    RequestContext {
        binding: binding.clone(), request_id: request_id.into(), caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: matches!(scope, Scope::Workspace),
            project_ids: match scope { Scope::Project { project_id } => vec![*project_id], _ => vec![] },
            operations: vec!["context.read".into(), "session.read".into()],
        },
    }
}
#[tauri::command]
pub(crate) async fn agent_knowledge_get(
    state: State<'_, AppState>,
    input: AgentCommandInput<crate::knowledge_service::KnowledgeGetInput>,
) -> Result<ApiResponse<crate::knowledge_service::KnowledgeGetPage>, String> {
    let request = gui_knowledge_request(&input.binding, &input.request_id, &input.data.scope);
    let result = crate::knowledge_registry::KnowledgeRegistry::new(state.inner()).get(&request, &input.data).await;
    Ok(ApiResponse::from_result(input.request_id, result))
}
#[tauri::command]
pub(crate) fn agent_knowledge_search(
    state: State<'_, AppState>,
    input: AgentCommandInput<crate::knowledge_service::KnowledgeSearchInput>,
) -> ApiResponse<crate::knowledge_service::KnowledgeSearchPage> {
    let request = gui_knowledge_request(&input.binding, &input.request_id, &input.data.scope);
    let result = crate::knowledge_registry::KnowledgeRegistry::new(state.inner()).search(&request, &input.data);
    ApiResponse::from_result(input.request_id, result)
}

#[tauri::command]
pub(crate) fn agent_business_changes_list(
    state: State<'_, AppState>,
    input: AgentCommandInput<super::changes::ChangeInput>,
) -> ApiResponse<super::changes::ChangePage> {
    let result = with_gui_service(
        &state,
        &input.binding,
        &input.request_id,
        &Scope::Workspace,
        |request, binding, repo| repo.db.gui_business_changes(request, binding, &input.data),
    );
    ApiResponse::from_result(input.request_id, result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentCommandInput<T> {
    binding: WorkspaceBinding,
    request_id: String,
    data: T,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InstructionsListInput {
    scope: Scope,
    after_id: Option<String>,
    #[serde(default = "instruction_limit")]
    limit: u16,
}
fn instruction_limit() -> u16 {
    50
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChangesCommandInput {
    scope: Scope,
    after_seq: i64,
    limit: u16,
}

/// GUI scopes come from explicit selections. External adapters must load their stored grant.
fn with_gui_service<T>(
    state: &AppState,
    binding: &WorkspaceBinding,
    request_id: &str,
    scope: &Scope,
    action: impl FnOnce(
        &RequestContext,
        &WorkspaceBinding,
        &crate::db::agent::WorkspaceContextRepository<'_>,
    ) -> super::errors::AgentResult<T>,
) -> super::errors::AgentResult<T> {
    let current = lock_mutex(&state.current_workspace);
    let runtime = current
        .as_ref()
        .ok_or_else(|| AgentError::new(ErrorCode::WorkspaceNotOpen, "Open a Workspace first"))?;
    let request = RequestContext {
        binding: binding.clone(),
        request_id: request_id.into(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: runtime.agent_binding.workspace_id.clone(),
            workspace_content: matches!(scope, Scope::Workspace),
            project_ids: match scope {
                Scope::Project { project_id } => vec![*project_id],
                _ => vec![],
            },
            operations: vec![
                "settings.read".into(),
                "settings.write".into(),
                "changes.read".into(),
            ],
        },
    };
    let db = lock_mutex(&runtime.db);
    let repository = crate::db::agent::WorkspaceContextRepository {
        db: &db,
        workspace_name: &runtime.summary.display_name,
    };
    action(&request, &runtime.agent_binding, &repository)
}

#[tauri::command]
pub(crate) fn agent_settings_get(
    state: State<'_, AppState>,
    input: AgentCommandInput<Scope>,
) -> ApiResponse<super::settings::AgentScopeSettings> {
    let result = with_gui_service(
        &state,
        &input.binding,
        &input.request_id,
        &input.data,
        |request, binding, repo| {
            AgentDomainService::new(binding, repo).settings_get(request, input.data.clone())
        },
    );
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn agent_settings_update(
    state: State<'_, AppState>,
    input: AgentCommandInput<super::settings::SettingsUpdate>,
) -> ApiResponse<super::settings::AgentScopeSettings> {
    let result = with_gui_service(
        &state,
        &input.binding,
        &input.request_id,
        &input.data.settings.scope,
        |request, binding, repo| {
            AgentDomainService::new(binding, repo).settings_update(request, input.data.clone())
        },
    );
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn agent_instructions_list(
    state: State<'_, AppState>,
    input: AgentCommandInput<InstructionsListInput>,
) -> ApiResponse<Vec<super::instructions::ContextInstruction>> {
    let result = with_gui_service(
        &state,
        &input.binding,
        &input.request_id,
        &input.data.scope,
        |request, binding, repo| {
            AgentDomainService::new(binding, repo).instructions_list(
                request,
                input.data.scope.clone(),
                input.data.after_id.as_deref(),
                input.data.limit,
            )
        },
    );
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn agent_instruction_upsert(
    state: State<'_, AppState>,
    input: AgentCommandInput<super::instructions::InstructionUpsert>,
) -> ApiResponse<super::instructions::ContextInstruction> {
    let result = with_gui_service(
        &state,
        &input.binding,
        &input.request_id,
        &input.data.scope,
        |request, binding, repo| {
            AgentDomainService::new(binding, repo).instruction_upsert(request, input.data.clone())
        },
    );
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn agent_instruction_delete(
    state: State<'_, AppState>,
    input: AgentCommandInput<super::instructions::InstructionDelete>,
) -> ApiResponse<bool> {
    let result = with_gui_service(
        &state,
        &input.binding,
        &input.request_id,
        &input.data.scope,
        |request, binding, repo| {
            AgentDomainService::new(binding, repo).instruction_delete(request, input.data.clone())
        },
    );
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn agent_changes_list(
    state: State<'_, AppState>,
    input: AgentCommandInput<ChangesCommandInput>,
) -> ApiResponse<super::changes::ChangePage> {
    let result = with_gui_service(
        &state,
        &input.binding,
        &input.request_id,
        &input.data.scope,
        |request, binding, repo| {
            AgentDomainService::new(binding, repo).changes_list(
                request,
                super::changes::ChangeInput {
                    after_seq: input.data.after_seq,
                    limit: input.data.limit,
                },
            )
        },
    );
    ApiResponse::from_result(input.request_id, result)
}
