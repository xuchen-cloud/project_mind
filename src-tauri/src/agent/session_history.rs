//! Trusted GUI adapter for persisted Pi history. No model, profile, or tool grant is involved.
use super::{
    errors::{AgentError, AgentResult, ApiResponse, ErrorCode},
    models::{MessageRef, Scope, WorkspaceBinding},
    process::{HostProcess, PackagedAgentRuntime},
    runtime::HOST_PROTOCOL,
};
use crate::{lock_mutex, AppState, WorkspaceRuntime};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tauri::State;
use tokio::time::{timeout_at, Instant};

const READ_LIMIT: Duration = Duration::from_secs(30);
const CLEANUP_LIMIT: Duration = Duration::from_secs(5);

fn invalid(message: &'static str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn incompatible(message: &'static str) -> AgentError {
    AgentError::new(ErrorCode::RuntimeIncompatible, message)
}
fn deadline() -> AgentError {
    AgentError::new(
        ErrorCode::BudgetExceeded,
        "History read reached its time limit",
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HistoryCommandInput {
    binding: WorkspaceBinding,
    request_id: String,
    data: HistoryRequest,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HistoryCursor {
    branch_id: String,
    from_message_id: Option<String>,
    to_message_id: Option<String>,
    message_id: String,
    char_offset: u32,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HistoryRequest {
    session_id: String,
    branch_id: Option<String>,
    from_message_id: Option<String>,
    to_message_id: Option<String>,
    cursor: Option<HistoryCursor>,
    limit: Option<u16>,
    max_chars: Option<u32>,
}

impl HistoryRequest {
    fn validate(&self) -> AgentResult<()> {
        if self.limit.is_some_and(|n| !(1..=50).contains(&n))
            || self.max_chars.is_some_and(|n| !(1..=12_000).contains(&n))
        {
            return Err(invalid("History page bounds are invalid"));
        }
        if let Some(cursor) = &self.cursor {
            if self
                .branch_id
                .as_ref()
                .is_some_and(|id| id != &cursor.branch_id)
                || self
                    .from_message_id
                    .as_ref()
                    .is_some_and(|id| Some(id) != cursor.from_message_id.as_ref())
                || self
                    .to_message_id
                    .as_ref()
                    .is_some_and(|id| Some(id) != cursor.to_message_id.as_ref())
            {
                return Err(invalid("History cursor does not match its anchors"));
            }
        }
        for id in [
            self.from_message_id.as_ref(),
            self.to_message_id.as_ref(),
            self.cursor.as_ref().map(|c| &c.message_id),
        ]
        .into_iter()
        .flatten()
        {
            if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(invalid("History message ID is invalid"));
            }
        }
        if self
            .branch_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 128)
            || self
                .cursor
                .as_ref()
                .is_some_and(|c| c.branch_id.is_empty() || c.branch_id.len() > 128)
        {
            return Err(invalid("History branch ID is invalid"));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeMessage {
    message_id: String,
    runtime_entry_id: String,
    ordinal: u64,
    role: HistoryRole,
    created_at: String,
    text: String,
    content_hash: String,
    char_start: u32,
    char_end: u32,
    total_chars: u32,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum HistoryRole {
    User,
    Assistant,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryMessage {
    message_id: String,
    runtime_entry_id: String,
    ordinal: u64,
    role: HistoryRole,
    created_at: String,
    text: String,
    content_hash: String,
    char_start: u32,
    char_end: u32,
    total_chars: u32,
    message_ref: MessageRef,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimePage {
    session_id: String,
    branch_id: Option<String>,
    messages: Vec<RuntimeMessage>,
    next_cursor: Option<HistoryCursor>,
    has_more: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryPage {
    session_id: String,
    branch_id: Option<String>,
    messages: Vec<HistoryMessage>,
    next_cursor: Option<HistoryCursor>,
    has_more: bool,
}

fn convert_page(
    page: RuntimePage,
    request: &HistoryRequest,
    binding: &WorkspaceBinding,
    scope: &Scope,
) -> AgentResult<HistoryPage> {
    let max_chars = request.max_chars.unwrap_or(12_000);
    let limit = request.limit.unwrap_or(50);
    let from_message_id = request.from_message_id.as_ref().or_else(|| {
        request
            .cursor
            .as_ref()
            .and_then(|c| c.from_message_id.as_ref())
    });
    let to_message_id = request.to_message_id.as_ref().or_else(|| {
        request
            .cursor
            .as_ref()
            .and_then(|c| c.to_message_id.as_ref())
    });
    if page.session_id != request.session_id
        || page.messages.len() > limit as usize
        || page.branch_id.is_none()
            && (!page.messages.is_empty() || page.next_cursor.is_some() || page.has_more)
        || page.has_more != page.next_cursor.is_some()
        || request
            .branch_id
            .as_ref()
            .is_some_and(|branch| page.branch_id.as_ref() != Some(branch))
        || request
            .cursor
            .as_ref()
            .is_some_and(|cursor| page.branch_id.as_ref() != Some(&cursor.branch_id))
        || page.next_cursor.as_ref().is_some_and(|cursor| {
            page.branch_id.as_ref() != Some(&cursor.branch_id)
                || cursor.from_message_id.as_ref() != from_message_id
                || cursor.to_message_id.as_ref() != to_message_id
        })
    {
        return Err(incompatible("History page identity or bounds are invalid"));
    }
    let mut total = 0usize;
    let mut messages = Vec::with_capacity(page.messages.len());
    for message in page.messages {
        let chars = message.text.chars().count();
        let expected_message_id = format!(
            "{:x}",
            Sha256::digest(
                format!("{}:{}", request.session_id, message.runtime_entry_id).as_bytes()
            )
        );
        total += chars;
        if message.message_id.len() != 32
            || !message.message_id.bytes().all(|b| b.is_ascii_hexdigit())
            || message.content_hash.len() != 71
            || !message.content_hash.starts_with("sha256:")
            || !message.content_hash[7..]
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
            || message.runtime_entry_id.is_empty()
            || message.created_at.is_empty()
            || message.message_id != expected_message_id[..32]
            || message.char_end < message.char_start
            || message.char_end > message.total_chars
            || (message.char_end - message.char_start) as usize != chars
            || total > max_chars as usize
            || (message.char_start == 0
                && message.char_end == message.total_chars
                && message.content_hash
                    != format!("sha256:{:x}", Sha256::digest(message.text.as_bytes())))
        {
            return Err(incompatible("History message is invalid"));
        }
        let branch_id = page
            .branch_id
            .as_ref()
            .ok_or_else(|| incompatible("History branch is missing"))?;
        let message_ref = MessageRef {
            workspace_id: binding.workspace_id.clone(),
            scope: scope.clone(),
            session_id: request.session_id.clone(),
            branch_id: branch_id.clone(),
            message_id: message.message_id.clone(),
            ordinal: message.ordinal,
            content_hash: message.content_hash.clone(),
        };
        messages.push(HistoryMessage {
            message_id: message.message_id,
            runtime_entry_id: message.runtime_entry_id,
            ordinal: message.ordinal,
            role: message.role,
            created_at: message.created_at,
            text: message.text,
            content_hash: message.content_hash,
            char_start: message.char_start,
            char_end: message.char_end,
            total_chars: message.total_chars,
            message_ref,
        });
    }
    Ok(HistoryPage {
        session_id: page.session_id,
        branch_id: page.branch_id,
        messages,
        next_cursor: page.next_cursor,
        has_more: page.has_more,
    })
}

fn current_runtime(
    state: &AppState,
    binding: &WorkspaceBinding,
) -> AgentResult<Arc<WorkspaceRuntime>> {
    let current = lock_mutex(&state.current_workspace);
    let runtime = current
        .as_ref()
        .ok_or_else(|| AgentError::new(ErrorCode::WorkspaceNotOpen, "Open a Workspace first"))?;
    if &runtime.agent_binding != binding {
        return Err(AgentError::new(
            ErrorCode::WorkspaceChanged,
            "Workspace binding changed",
        ));
    }
    Ok(runtime.clone())
}

fn stored_scope(
    runtime: &WorkspaceRuntime,
    binding: &WorkspaceBinding,
    request_id: &str,
    session_id: &str,
) -> AgentResult<(Scope, bool)> {
    let db = lock_mutex(&runtime.db);
    let request = db.agent_gui_session_request(
        binding,
        &runtime.agent_binding,
        request_id,
        session_id,
        &["session.read"],
    )?;
    let snapshot = db.agent_session_get(&request, &runtime.agent_binding, session_id, None, 1)?;
    if snapshot.session.runtime_id != "builtin-pi" {
        return Err(AgentError::new(
            ErrorCode::RuntimeUnavailable,
            "The selected session runtime is not installed",
        ));
    }
    Ok((snapshot.session.scope, snapshot.checkpoint.is_some()))
}

async fn exchange(
    process: &mut HostProcess,
    id: &str,
    method: &str,
    data: Value,
    end: Instant,
) -> AgentResult<Value> {
    let command =
        json!({"protocolVersion": HOST_PROTOCOL, "requestId": id, "method": method, "data": data});
    timeout_at(end, process.send(&command))
        .await
        .map_err(|_| deadline())??;
    let frame = timeout_at(end, process.next_frame())
        .await
        .map_err(|_| deadline())??
        .ok_or_else(|| incompatible("History runtime ended before response"))?;
    if frame["protocolVersion"] != HOST_PROTOCOL
        || frame["requestId"] != id
        || !frame["ok"].is_boolean()
    {
        return Err(incompatible("History response correlation failed"));
    }
    if frame["ok"] == false {
        let code = serde_json::from_value(frame["error"]["code"].clone())
            .unwrap_or(ErrorCode::RuntimeIncompatible);
        return Err(AgentError::new(
            code,
            "History runtime rejected the request",
        ));
    }
    frame
        .get("data")
        .cloned()
        .ok_or_else(|| incompatible("History response data is missing"))
}

async fn read_runtime(
    app: tauri::AppHandle,
    runtime: Arc<WorkspaceRuntime>,
    request: &HistoryRequest,
    binding: &WorkspaceBinding,
    scope: &Scope,
) -> AgentResult<HistoryPage> {
    let end = Instant::now() + READ_LIMIT;
    let root = runtime
        .paths
        .root_path
        .canonicalize()
        .map_err(|_| incompatible("Workspace root cannot be resolved"))?;
    let packaged = timeout_at(
        end,
        tokio::task::spawn_blocking(move || PackagedAgentRuntime::for_app(&app)),
    )
    .await
    .map_err(|_| deadline())?
    .map_err(|_| incompatible("Runtime verification stopped"))??;
    let mut process = timeout_at(end, packaged.spawn(&root, false))
        .await
        .map_err(|_| deadline())??;
    let result = async {
        let init = exchange(&mut process, "history-initialize", "initialize", json!({"workspaceRoot":root,"tools":[],"systemPrompt":"Read persisted session history."}), end).await?;
        if init["runtimeAvailable"] != true || init["activeTools"] != json!([]) {
            return Err(incompatible("History runtime initialized with unexpected tools"));
        }
        let data = serde_json::to_value(request).map_err(|_| invalid("History request is invalid"))?;
        let page = exchange(&mut process, "history-read", "session.history.read", data, end).await?;
        let page: RuntimePage = serde_json::from_value(page).map_err(|_| incompatible("History response shape is invalid"))?;
        convert_page(page, request, binding, scope)
    }.await;
    let cleanup_end = Instant::now() + CLEANUP_LIMIT;
    let cleanup = async {
        let command = json!({"protocolVersion":HOST_PROTOCOL,"requestId":"history-shutdown","method":"shutdown","data":{}});
        process.send(&command).await?;
        process.shutdown().await
    };
    if !matches!(timeout_at(cleanup_end, cleanup).await, Ok(Ok(()))) {
        let _ = timeout_at(cleanup_end, process.kill()).await;
    }
    result
}

#[tauri::command]
pub(crate) async fn agent_session_messages_read(
    state: State<'_, AppState>,
    input: HistoryCommandInput,
) -> Result<ApiResponse<HistoryPage>, String> {
    let result = async {
        input.data.validate()?;
        let runtime = current_runtime(&state, &input.binding)?;
        let (scope, checkpoint) = stored_scope(
            &runtime,
            &input.binding,
            &input.request_id,
            &input.data.session_id,
        )?;
        let page = if checkpoint {
            read_runtime(
                state.app_handle.clone(),
                runtime.clone(),
                &input.data,
                &input.binding,
                &scope,
            )
            .await?
        } else {
            if input.data.branch_id.is_some()
                || input.data.from_message_id.is_some()
                || input.data.to_message_id.is_some()
                || input.data.cursor.is_some()
            {
                return Err(AgentError::new(
                    ErrorCode::NotFound,
                    "History anchor does not exist",
                ));
            }
            HistoryPage {
                session_id: input.data.session_id.clone(),
                branch_id: None,
                messages: vec![],
                next_cursor: None,
                has_more: false,
            }
        };
        let current_guard = lock_mutex(&state.current_workspace);
        let current = current_guard.as_ref().ok_or_else(|| {
            AgentError::new(ErrorCode::WorkspaceNotOpen, "Open a Workspace first")
        })?;
        if current.agent_binding != input.binding || !Arc::ptr_eq(&runtime, current) {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Workspace binding changed",
            ));
        }
        let (after_scope, _) = stored_scope(
            &runtime,
            &input.binding,
            &input.request_id,
            &input.data.session_id,
        )?;
        if scope != after_scope {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Session scope changed",
            ));
        }
        Ok(page)
    }
    .await;
    Ok(ApiResponse::from_result(input.request_id, result))
}

#[cfg(test)]
#[path = "session_history_tests.rs"]
mod tests;
