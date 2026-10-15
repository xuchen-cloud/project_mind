//! Trusted local GUI adapter for independent Overview corrections.
use crate::{
    agent::{
        access::{Caller, RequestContext, ScopeGrant},
        errors::ApiResponse,
        models::{Scope, WorkspaceBinding},
        overview::{OverviewCorrectionDelete, OverviewCorrectionUpsert, OverviewCorrections},
    },
    AppState,
};
use serde::Deserialize;
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OverviewCommandInput<T> {
    binding: WorkspaceBinding,
    request_id: String,
    data: T,
}

fn gui_request(binding: &WorkspaceBinding, scope: &Scope, request_id: &str) -> RequestContext {
    RequestContext {
        binding: binding.clone(),
        request_id: request_id.into(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            object_keys: None,
            workspace_id: binding.workspace_id.clone(),
            workspace_content: matches!(scope, Scope::Workspace),
            project_ids: match scope {
                Scope::Project { project_id } => vec![*project_id],
                Scope::Workspace => vec![],
            },
            operations: [
                "settings.read",
                "settings.write",
                "context.read",
                "knowledge.write",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        },
    }
}

#[tauri::command]
pub(crate) fn agent_overview_corrections_get(
    state: State<'_, AppState>,
    input: OverviewCommandInput<Scope>,
) -> ApiResponse<OverviewCorrections> {
    let request = gui_request(&input.binding, &input.data, &input.request_id);
    let result = crate::overview_service::OverviewService::new(state.inner())
        .corrections(&request, &input.data);
    ApiResponse::from_result(input.request_id, result)
}

#[tauri::command]
pub(crate) fn agent_overview_correction_upsert(
    state: State<'_, AppState>,
    input: OverviewCommandInput<OverviewCorrectionUpsert>,
) -> ApiResponse<OverviewCorrections> {
    let request = gui_request(&input.binding, &input.data.scope, &input.request_id);
    let result = crate::overview_service::OverviewService::new(state.inner())
        .correction_upsert(&request, &input.data);
    ApiResponse::from_result(input.request_id, result)
}

#[tauri::command]
pub(crate) fn agent_overview_correction_delete(
    state: State<'_, AppState>,
    input: OverviewCommandInput<OverviewCorrectionDelete>,
) -> ApiResponse<OverviewCorrections> {
    let request = gui_request(&input.binding, &input.data.scope, &input.request_id);
    let result = crate::overview_service::OverviewService::new(state.inner())
        .correction_delete(&request, &input.data);
    ApiResponse::from_result(input.request_id, result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OverviewMaintenanceInput {
    binding: WorkspaceBinding,
    request_id: String,
    scope: Scope,
    action: Option<String>,
}

#[tauri::command]
pub(crate) fn agent_overview_maintenance(
    state: State<'_, AppState>,
    input: OverviewMaintenanceInput,
) -> ApiResponse<crate::overview_maintenance::OverviewMaintenanceView> {
    let request = gui_request(&input.binding, &input.scope, &input.request_id);
    let result = match input.action.as_deref() {
        Some(action) => {
            crate::overview_maintenance::control(state.inner(), &request, &input.scope, action)
        }
        None => crate::overview_maintenance::status(state.inner(), &request, &input.scope),
    };
    ApiResponse::from_result(input.request_id, result)
}
