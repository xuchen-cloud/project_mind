//! Trusted model search/read adapters. The original Pi history remains authoritative.
use super::{
    access::RequestContext,
    errors::{AgentError, AgentResult, ErrorCode},
    models::{Scope, SourceRef, WorkspaceBinding},
    session_history::{HistoryCursor, HistoryRequest},
};
use crate::{
    db::{
        agent_session_model_search::{ModelHistorySearchInput, ModelHistorySearchPage},
        agent_session_search::{SessionScanPage, SessionScanWork},
    },
    lock_mutex,
    source_service::{BoundSourceStore, SourceReadInput, SourceReadTarget, SourceReadView, SourceService},
    source_session_read::{SessionHistoryFragment, SessionHistoryUtility},
    AppState, WorkspaceRuntime,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::Manager;

fn err(code: ErrorCode, message: &str) -> AgentError {
    AgentError::new(code, message)
}
fn budget_default() -> usize {
    4000
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelHistoryReadInput {
    #[schemars(length(min = 32, max = 32))]
    pub session_id: String,
    #[schemars(length(min = 32, max = 32))]
    pub message_id: String,
    pub cursor: Option<HistoryCursor>,
    #[serde(default = "budget_default")]
    #[schemars(range(min = 1, max = 12000))]
    pub budget_chars: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelHistoryReadPage {
    pub source_ref: SourceRef,
    pub text: String,
    pub char_start: u32,
    pub char_end: u32,
    pub total_chars: u32,
    pub next_cursor: Option<HistoryCursor>,
}

fn read_cursor(entry: &str, message_id: &str, offset: u32) -> HistoryCursor {
    HistoryCursor {
        branch_id: entry.into(),
        from_message_id: Some(message_id.into()),
        to_message_id: Some(message_id.into()),
        message_id: message_id.into(),
        char_offset: offset,
    }
}

pub(crate) fn history_cursor_json(
    entry: &str,
    message_id: &str,
    offset: u32,
) -> AgentResult<String> {
    serde_json::to_string(&read_cursor(entry, message_id, offset))
        .map_err(|_| err(ErrorCode::IoFailed, "Cannot encode history cursor"))
}
pub(crate) fn history_cursor_offset(
    cursor: Option<&str>,
    record: &crate::db::agent_session_model_search::SourceReadRecord,
) -> AgentResult<u32> {
    let Some(cursor) = cursor else { return Ok(0) };
    let cursor: HistoryCursor = serde_json::from_str(cursor)
        .map_err(|_| err(ErrorCode::InvalidArgument, "Invalid history cursor"))?;
    if cursor.branch_id != record.runtime_entry_id
        || cursor.message_id != record.message_id
        || cursor.from_message_id.as_deref() != Some(record.message_id.as_str())
        || cursor.to_message_id.as_deref() != Some(record.message_id.as_str())
        || cursor.char_offset >= record.total_chars
    {
        return Err(err(
            ErrorCode::InvalidArgument,
            "History cursor does not match message",
        ));
    }
    Ok(cursor.char_offset)
}

pub(crate) struct AppSessionHistoryUtility {
    pub app: tauri::AppHandle,
    pub runtime: Arc<WorkspaceRuntime>,
}
impl SessionHistoryUtility for AppSessionHistoryUtility {
    async fn scan(
        &self,
        binding: &WorkspaceBinding,
        work: &SessionScanWork,
    ) -> AgentResult<SessionScanPage> {
        {
            let state = self.app.state::<AppState>();
            let current = lock_mutex(&state.current_workspace);
            if current.as_ref().is_none_or(|r| !Arc::ptr_eq(r, &self.runtime))
                || &self.runtime.agent_binding != binding
            {
                return Err(err(ErrorCode::WorkspaceChanged, "Workspace binding changed"));
            }
        }
        let value = super::session_history::history_runtime_request(
            self.app.clone(),
            self.runtime.clone(),
            "session.history.scan",
            serde_json::json!({
                "sessionId": work.session_id,
                "expectedChecksum": work.checksum,
                "cursor": work.cursor,
                "previousCheckpoint": work.previous_checkpoint,
            }),
        ).await?;
        serde_json::from_value(value).map_err(|_| {
            err(ErrorCode::RuntimeIncompatible, "Invalid history scan response")
        })
    }

    async fn advance_index(
        &self,
        binding: &super::models::WorkspaceBinding,
        request: &RequestContext,
        scope: &super::models::Scope,
    ) -> AgentResult<bool> {
        if binding != &self.runtime.agent_binding {
            return Err(err(
                ErrorCode::WorkspaceChanged,
                "Workspace binding changed",
            ));
        }
        advance_index(self.app.clone(), self.runtime.clone(), request, scope, None).await
    }
    async fn read(
        &self,
        binding: &super::models::WorkspaceBinding,
        record: &crate::db::agent_session_model_search::SourceReadRecord,
        cursor: Option<&str>,
        max_chars: u32,
    ) -> AgentResult<SessionHistoryFragment> {
        let _ = history_cursor_offset(cursor, record)?;
        let parsed = cursor
            .map(|value| {
                serde_json::from_str::<HistoryCursor>(value)
                    .map_err(|_| err(ErrorCode::InvalidArgument, "Invalid history cursor"))
            })
            .transpose()?;
        {
            let state = self.app.state::<AppState>();
            let current = lock_mutex(&state.current_workspace);
            if current
                .as_ref()
                .is_none_or(|r| !Arc::ptr_eq(r, &self.runtime))
                || &self.runtime.agent_binding != binding
            {
                return Err(err(
                    ErrorCode::WorkspaceChanged,
                    "Workspace binding changed",
                ));
            }
        }
        let request_page = HistoryRequest {
            session_id: record.session_id.clone(),
            branch_id: Some(record.runtime_entry_id.clone()),
            from_message_id: Some(record.message_id.clone()),
            to_message_id: Some(record.message_id.clone()),
            cursor: parsed,
            limit: Some(1),
            max_chars: Some(max_chars),
        };
        let page = super::session_history::read_runtime(
            self.app.clone(),
            self.runtime.clone(),
            &request_page,
            binding,
            &record.scope,
        )
        .await?;
        let message = page
            .messages
            .into_iter()
            .next()
            .ok_or_else(|| err(ErrorCode::NotFound, "History message not found"))?;
        Ok(SessionHistoryFragment {
            session_id: record.session_id.clone(),
            message_id: message.message_id,
            runtime_entry_id: message.runtime_entry_id,
            ordinal: message.ordinal,
            content_hash: message.content_hash,
            text: message.text,
            char_start: message.char_start,
            char_end: message.char_end,
            total_chars: message.total_chars,
            next_cursor: page
                .next_cursor
                .map(|c| {
                    serde_json::to_string(&c)
                        .map_err(|_| err(ErrorCode::IoFailed, "Cannot encode history cursor"))
                })
                .transpose()?,
        })
    }
}

fn fit_read_page(
    mut output: ModelHistoryReadPage,
    budget: usize,
    entry: &str,
    message_id: &str,
) -> AgentResult<ModelHistoryReadPage> {
    let chars: Vec<char> = output.text.chars().collect();
    if chars.is_empty() {
        return Err(err(
            ErrorCode::BudgetExceeded,
            "History read budget is too small",
        ));
    }
    let original_size = serde_json::to_string(&output)
        .map_err(|_| err(ErrorCode::IoFailed, "Cannot encode history page"))?
        .chars()
        .count();
    if original_size <= budget {
        return Ok(output);
    }
    let mut low = 0usize;
    let mut high = chars.len();
    while low + 1 < high {
        let mid = (low + high) / 2;
        output.text = chars[..mid].iter().collect();
        output.char_end = output.char_start + mid as u32;
        output.next_cursor = if output.char_end < output.total_chars {
            Some(read_cursor(entry, message_id, output.char_end))
        } else {
            None
        };
        let size = serde_json::to_string(&output)
            .map_err(|_| err(ErrorCode::IoFailed, "Cannot encode history page"))?
            .chars()
            .count();
        if size <= budget {
            low = mid;
        } else {
            high = mid;
        }
    }
    if low == 0 {
        return Err(err(
            ErrorCode::BudgetExceeded,
            "History read budget is too small",
        ));
    }
    output.text = chars[..low].iter().collect();
    output.char_end = output.char_start + low as u32;
    output.next_cursor = if output.char_end < output.total_chars {
        Some(read_cursor(entry, message_id, output.char_end))
    } else {
        None
    };
    Ok(output)
}

pub(crate) async fn advance_index(
    app: tauri::AppHandle,
    runtime: Arc<WorkspaceRuntime>,
    request: &RequestContext,
    scope: &Scope,
    session_id: Option<&str>,
) -> AgentResult<bool> {
    let utility = AppSessionHistoryUtility { app: app.clone(), runtime };
    let state = app.state::<AppState>();
    advance_index_with_store(&*state, &utility, request, scope, session_id).await
}

pub(crate) async fn advance_index_with_store<S: BoundSourceStore, U: SessionHistoryUtility>(
    store: &S,
    utility: &U,
    request: &RequestContext,
    scope: &Scope,
    session_id: Option<&str>,
) -> AgentResult<bool> {
    let (binding, work) = store.with_current(|binding, db| {
        request.authorize(binding, scope, "session.read")?;
        Ok((binding.clone(), db.agent_session_scan_work(request, binding, scope, session_id)?))
    })?;
    let Some(work) = work else { return Ok(false) };
    let page = utility.scan(&binding, &work).await?;
    store.with_current(|current, db| {
        if current != &binding {
            return Err(err(ErrorCode::WorkspaceChanged, "Workspace binding changed"));
        }
        db.agent_session_scan_commit(request, current, &work, &page)
    })?;
    Ok(true)
}

pub(crate) async fn search(
    app: tauri::AppHandle,
    runtime: Arc<WorkspaceRuntime>,
    request: &RequestContext,
    input: &ModelHistorySearchInput,
) -> AgentResult<ModelHistorySearchPage> {
    let utility = AppSessionHistoryUtility { app: app.clone(), runtime };
    let state = app.state::<AppState>();
    search_with_store(&*state, &utility, request, input).await
}

pub(crate) async fn search_with_store<S: BoundSourceStore, U: SessionHistoryUtility>(
    store: &S,
    utility: &U,
    request: &RequestContext,
    input: &ModelHistorySearchInput,
) -> AgentResult<ModelHistorySearchPage> {
    input.validate()?;
    if input.after_message_id.is_none() {
        advance_index_with_store(store, utility, request, &input.scope, input.session_id.as_deref()).await?;
    }
    store.with_current(|binding, db| db.agent_model_session_search(request, binding, input))
}

pub(crate) async fn read(
    app: tauri::AppHandle,
    runtime: Arc<WorkspaceRuntime>,
    request: &RequestContext,
    input: &ModelHistoryReadInput,
) -> AgentResult<ModelHistoryReadPage> {
    let utility = AppSessionHistoryUtility { app: app.clone(), runtime };
    let state = app.state::<AppState>();
    read_with_store(&*state, &utility, request, input).await
}

pub(crate) async fn read_with_store<S: BoundSourceStore, U: SessionHistoryUtility>(
    store: &S,
    utility: &U,
    request: &RequestContext,
    input: &ModelHistoryReadInput,
) -> AgentResult<ModelHistoryReadPage> {
    if !(1..=12000).contains(&input.budget_chars) {
        return Err(err(
            ErrorCode::InvalidArgument,
            "Invalid history read budget",
        ));
    }
    let (binding, original) = store.with_current(|binding, db| {
        Ok((binding.clone(), db.agent_model_session_message_record(
            request,
            binding,
            &input.session_id,
            &input.message_id,
        )?))
    })?;
    let cursor = input
        .cursor
        .as_ref()
        .map(|c| {
            serde_json::to_string(c)
                .map_err(|_| err(ErrorCode::InvalidArgument, "Invalid history cursor"))
        })
        .transpose()?;
    history_cursor_offset(cursor.as_deref(), &original)?;
    let source_input = SourceReadInput {
        source: SourceReadTarget {
            object: original.source_ref(&binding).object,
            revision: Some(original.text_hash.clone()),
            record_version: None,
            file_version: None,
        },
        view: SourceReadView::Full,
        selection: None,
        cursor,
        budget_chars: Some(input.budget_chars),
    };
    let mut source_request = request.clone();
    if !source_request
        .scope_grant
        .operations
        .iter()
        .any(|op| op == "source.read")
    {
        source_request
            .scope_grant
            .operations
            .push("source.read".into());
    }
    let result = SourceService::new(store)
        .read_session_result(&source_request, &source_input, utility)
        .await?;
    let next_cursor = result
        .page
        .next_cursor
        .as_deref()
        .map(|c| {
            serde_json::from_str(c)
                .map_err(|_| err(ErrorCode::RuntimeIncompatible, "Invalid history cursor"))
        })
        .transpose()?;
    let output = ModelHistoryReadPage {
        source_ref: result.page.source_ref,
        text: result.page.text,
        char_start: result.char_start,
        char_end: result.char_end,
        total_chars: result.total_chars,
        next_cursor,
    };
    let output = fit_read_page(
        output,
        input.budget_chars,
        &original.runtime_entry_id,
        &input.message_id,
    )?;
    Ok(output)
}

#[cfg(test)]
#[path = "model_history_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "model_history_shared_tests.rs"]
mod shared_tests;
