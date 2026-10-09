//! Local GUI conversation adapter. All object-ID commands resolve stored scope.
use super::{
    access::{Caller, RequestContext, ScopeGrant},
    conversation::{
        RunEventPage, SessionCursor, SessionMetadata, SessionPage, SessionSnapshot, StoredRun,
    },
    errors::{AgentError, AgentResult, ApiResponse, ErrorCode},
    models::{Scope, WorkspaceBinding},
};
use crate::db::agent_session_search::{AgentSessionSearchInput, AgentSessionSearchPage};
use crate::{db::Database, lock_mutex, AppState};
use serde::Deserialize;
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConversationCommandInput<T> {
    binding: WorkspaceBinding,
    request_id: String,
    data: T,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionCreateInput {
    scope: Scope,
    title: String,
    #[serde(default = "pi_runtime")]
    runtime_id: String,
    profile_override_id: Option<i64>,
}
fn pi_runtime() -> String {
    "builtin-pi".into()
}
fn session_limit() -> u16 {
    50
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionListInput {
    scope: Scope,
    cursor: Option<SessionCursor>,
    #[serde(default = "session_limit")]
    limit: u16,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionGetInput {
    session_id: String,
    after_ordinal: Option<u64>,
    #[serde(default = "session_limit")]
    limit: u16,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionArchiveInput {
    session_id: String,
    archived: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionDeleteInput {
    session_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RunGetInput {
    run_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RunEventsInput {
    run_id: String,
    #[serde(default)]
    after_seq: u64,
    #[serde(default = "session_limit")]
    limit: u16,
}

/// Hold both locks through every short metadata operation so switching cannot
/// interleave after binding validation. The action never starts external I/O.
fn with_conversation<T>(
    state: &AppState,
    binding: &WorkspaceBinding,
    action: impl FnOnce(&Database, &WorkspaceBinding) -> AgentResult<T>,
) -> AgentResult<T> {
    let current = lock_mutex(&state.current_workspace);
    let runtime = current
        .as_ref()
        .ok_or_else(|| AgentError::new(ErrorCode::WorkspaceNotOpen, "Open a Workspace first"))?;
    if binding != &runtime.agent_binding {
        return Err(AgentError::new(
            ErrorCode::WorkspaceChanged,
            "Workspace binding changed",
        ));
    }
    let db = lock_mutex(&runtime.db);
    action(&db, &runtime.agent_binding)
}
fn gui_scope_request(
    binding: &WorkspaceBinding,
    request_id: &str,
    scope: &Scope,
) -> RequestContext {
    RequestContext {
        binding: binding.clone(),
        request_id: request_id.into(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: matches!(scope, Scope::Workspace),
            project_ids: match scope {
                Scope::Project { project_id } => vec![*project_id],
                _ => vec![],
            },
            operations: vec!["session.read".into(), "session.write".into()],
        },
    }
}

#[tauri::command]
pub(crate) fn agent_session_create(
    state: State<'_, AppState>,
    input: ConversationCommandInput<SessionCreateInput>,
) -> ApiResponse<SessionMetadata> {
    let result = with_conversation(&state, &input.binding, |db, current| {
        if input.data.runtime_id != "builtin-pi" {
            return Err(AgentError::new(
                ErrorCode::RuntimeUnavailable,
                "Only the bundled Pi runtime is supported",
            ));
        }
        let request = gui_scope_request(&input.binding, &input.request_id, &input.data.scope);
        db.agent_session_create(
            &request,
            current,
            &input.data.scope,
            &input.data.title,
            &input.data.runtime_id,
            input.data.profile_override_id,
        )
    });
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn agent_sessions_list(
    state: State<'_, AppState>,
    input: ConversationCommandInput<SessionListInput>,
) -> ApiResponse<SessionPage> {
    let result = with_conversation(&state, &input.binding, |db, current| {
        let request = gui_scope_request(&input.binding, &input.request_id, &input.data.scope);
        db.agent_sessions_list(
            &request,
            current,
            &input.data.scope,
            input.data.cursor.as_ref(),
            input.data.limit,
        )
    });
    ApiResponse::from_result(input.request_id, result)
}

/// User-owned history search. Model tools must use the separate AI source
/// policy boundary before this projection can be exposed to a run.
#[tauri::command]
pub(crate) async fn agent_session_search(
    state: State<'_, AppState>,
    input: ConversationCommandInput<AgentSessionSearchInput>,
) -> Result<ApiResponse<AgentSessionSearchPage>, String> {
    let result = async {
        input.data.validate()?;
        let request = gui_scope_request(&input.binding, &input.request_id, &input.data.scope);
        // Retain the runtime identity across the external reader. Database and
        // Workspace locks are held only for the short selection/commit phases.
        let (runtime, work) = {
            let current = lock_mutex(&state.current_workspace);
            let runtime = current.as_ref().ok_or_else(|| {
                AgentError::new(ErrorCode::WorkspaceNotOpen, "Open a Workspace first")
            })?;
            if runtime.agent_binding != input.binding {
                return Err(AgentError::new(
                    ErrorCode::WorkspaceChanged,
                    "Workspace binding changed",
                ));
            }
            let db = lock_mutex(&runtime.db);
            request.authorize(&runtime.agent_binding, &input.data.scope, "session.read")?;
            let work = if input.data.after_message_id.is_none() {
                db.agent_session_scan_work(
                    &request,
                    &runtime.agent_binding,
                    &input.data.scope,
                    input.data.session_id.as_deref(),
                )?
            } else {
                None
            };
            (runtime.clone(), work)
        };
        let page = if let Some(work) = &work {
            let value = super::session_history::history_runtime_request(
                state.app_handle.clone(),
                runtime.clone(),
                "session.history.scan",
                serde_json::json!({"sessionId":work.session_id,"expectedChecksum":work.checksum,
                    "cursor":work.cursor,"previousCheckpoint":work.previous_checkpoint}),
            )
            .await?;
            Some(
                serde_json::from_value::<crate::db::agent_session_search::SessionScanPage>(value)
                    .map_err(|_| {
                    AgentError::new(
                        ErrorCode::RuntimeIncompatible,
                        "Invalid history scan response",
                    )
                })?,
            )
        } else {
            None
        };
        let current = lock_mutex(&state.current_workspace);
        let selected = current.as_ref().ok_or_else(|| {
            AgentError::new(ErrorCode::WorkspaceNotOpen, "Open a Workspace first")
        })?;
        if selected.agent_binding != input.binding || !std::sync::Arc::ptr_eq(selected, &runtime) {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Workspace binding changed",
            ));
        }
        let db = lock_mutex(&runtime.db);
        if let (Some(work), Some(page)) = (&work, &page) {
            db.agent_session_scan_commit(&request, &runtime.agent_binding, work, page)?;
        }
        let mut result = db.agent_session_search(&request, &runtime.agent_binding, &input.data)?;
        if let Some(page) = page {
            result.coverage.backfilled_this_request = page.messages.len() as u16;
        }
        Ok(result)
    }
    .await;
    Ok(ApiResponse::from_result(input.request_id, result))
}
#[tauri::command]
pub(crate) fn agent_session_get(
    state: State<'_, AppState>,
    input: ConversationCommandInput<SessionGetInput>,
) -> ApiResponse<SessionSnapshot> {
    let result = with_conversation(&state, &input.binding, |db, current| {
        let request = db.agent_gui_session_request(
            &input.binding,
            current,
            &input.request_id,
            &input.data.session_id,
            &["session.read", "session.write"],
        )?;
        db.agent_session_get(
            &request,
            current,
            &input.data.session_id,
            input.data.after_ordinal,
            input.data.limit,
        )
    });
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn agent_session_archive(
    state: State<'_, AppState>,
    input: ConversationCommandInput<SessionArchiveInput>,
) -> ApiResponse<SessionMetadata> {
    let result = with_conversation(&state, &input.binding, |db, current| {
        let request = db.agent_gui_session_request(
            &input.binding,
            current,
            &input.request_id,
            &input.data.session_id,
            &["session.read", "session.write"],
        )?;
        db.agent_session_archive(
            &request,
            current,
            &input.data.session_id,
            input.data.archived,
        )
    });
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn agent_session_delete(
    state: State<'_, AppState>,
    input: ConversationCommandInput<SessionDeleteInput>,
) -> ApiResponse<bool> {
    let result = with_conversation(&state, &input.binding, |db, current| {
        let request = db.agent_gui_session_request(
            &input.binding,
            current,
            &input.request_id,
            &input.data.session_id,
            &["session.read", "session.write"],
        )?;
        // Authoritative JSONL cleanup is not implemented in this metadata adapter.
        // The application Host owns the session store and its safe deletion policy.
        db.agent_session_delete(&request, current, &input.data.session_id)
    });
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn agent_run_get(
    state: State<'_, AppState>,
    input: ConversationCommandInput<RunGetInput>,
) -> ApiResponse<StoredRun> {
    let result = with_conversation(&state, &input.binding, |db, current| {
        let request = db.agent_gui_run_request(
            &input.binding,
            current,
            &input.request_id,
            &input.data.run_id,
            &["session.read"],
        )?;
        db.agent_run_get(&request, current, &input.data.run_id)
    });
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn agent_run_events_list(
    state: State<'_, AppState>,
    input: ConversationCommandInput<RunEventsInput>,
) -> ApiResponse<RunEventPage> {
    let result = with_conversation(&state, &input.binding, |db, current| {
        let request = db.agent_gui_run_request(
            &input.binding,
            current,
            &input.request_id,
            &input.data.run_id,
            &["session.read"],
        )?;
        db.agent_run_events_list(
            &request,
            current,
            &input.data.run_id,
            input.data.after_seq,
            input.data.limit,
        )
    });
    ApiResponse::from_result(input.request_id, result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn object_commands_reject_caller_grants_and_claimed_scope() {
        let valid = json!({
            "binding": {"workspaceId":"workspace", "generation":"generation"},
            "requestId":"request", "data":{"sessionId":"a".repeat(32)}
        });
        assert!(
            serde_json::from_value::<ConversationCommandInput<SessionGetInput>>(valid.clone())
                .is_ok()
        );
        let mut grant = valid.clone();
        grant["scopeGrant"] = json!({"workspaceContent":true,"projectIds":[999]});
        assert!(
            serde_json::from_value::<ConversationCommandInput<SessionGetInput>>(grant).is_err()
        );
        let mut scope = valid;
        scope["data"]["scope"] = json!({"kind":"project","projectId":999});
        assert!(
            serde_json::from_value::<ConversationCommandInput<SessionGetInput>>(scope).is_err()
        );
    }
}
