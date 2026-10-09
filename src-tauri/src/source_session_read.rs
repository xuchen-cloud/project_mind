//! Original session-message source reads through a checked, credential-free Pi reader.
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{Scope, WorkspaceBinding},
    },
    db::agent_session_model_search::SourceReadRecord,
    source_service::{
        BoundSourceStore, SourceReadInput, SourceReadPage, SourceReadView, SourceService,
    },
};

fn error(code: ErrorCode, message: &str) -> AgentError {
    AgentError::new(code, message)
}

/// The utility performs the Pi checkpoint and response checks. Its cursor is
/// the serialized internal HistoryCursor, opaque to source callers.
pub(crate) trait SessionHistoryUtility {
    fn read(
        &self,
        binding: &WorkspaceBinding,
        record: &SourceReadRecord,
        cursor: Option<&str>,
        max_chars: u32,
    ) -> impl std::future::Future<Output = AgentResult<SessionHistoryFragment>> + Send;
    fn advance_index(
        &self,
        _binding: &WorkspaceBinding,
        _request: &RequestContext,
        _scope: &Scope,
    ) -> impl std::future::Future<Output = AgentResult<bool>> + Send {
        async { Ok(false) }
    }
}

pub(crate) struct SessionHistoryFragment {
    pub session_id: String,
    pub message_id: String,
    pub runtime_entry_id: String,
    pub ordinal: u64,
    pub content_hash: String,
    pub text: String,
    pub char_start: u32,
    pub char_end: u32,
    pub total_chars: u32,
    pub next_cursor: Option<String>,
}

pub(crate) struct SessionReadResult {
    pub page: SourceReadPage,
    pub char_start: u32,
    pub char_end: u32,
    pub total_chars: u32,
}

fn page_size(page: &SourceReadPage) -> AgentResult<usize> {
    Ok(serde_json::to_string(page)
        .map_err(|_| error(ErrorCode::IoFailed, "Cannot encode session source page"))?
        .chars()
        .count())
}
fn fit_page(
    mut page: SourceReadPage,
    starting: u32,
    total: u32,
    budget: usize,
    entry: &str,
    id: &str,
) -> AgentResult<(SourceReadPage, u32)> {
    let chars: Vec<char> = page.text.chars().collect();
    if chars.is_empty() {
        return Err(error(
            ErrorCode::BudgetExceeded,
            "Session source budget is too small",
        ));
    }
    if page_size(&page)? <= budget {
        return Ok((page, starting + chars.len() as u32));
    }
    let mut low = 0usize;
    let mut high = chars.len();
    while low + 1 < high {
        let mid = (low + high) / 2;
        page.text = chars[..mid].iter().collect();
        let end = starting + mid as u32;
        page.next_cursor = Some(crate::agent::model_history::history_cursor_json(
            entry, id, end,
        )?);
        page.complete = end == total;
        page.range_complete = page.complete;
        if page_size(&page)? <= budget {
            low = mid;
        } else {
            high = mid;
        }
    }
    if low == 0 {
        return Err(error(
            ErrorCode::BudgetExceeded,
            "Session source budget is too small",
        ));
    }
    page.text = chars[..low].iter().collect();
    let end = starting + low as u32;
    page.next_cursor = Some(crate::agent::model_history::history_cursor_json(
        entry, id, end,
    )?);
    page.complete = false;
    page.range_complete = false;
    Ok((page, end))
}

impl<'a, S: BoundSourceStore> SourceService<'a, S> {
    pub(crate) async fn read_session<U: SessionHistoryUtility>(
        &self,
        request: &RequestContext,
        input: &SourceReadInput,
        utility: &U,
    ) -> AgentResult<SourceReadPage> {
        Ok(self
            .read_session_result(request, input, utility)
            .await?
            .page)
    }

    pub(crate) async fn read_session_result<U: SessionHistoryUtility>(
        &self,
        request: &RequestContext,
        input: &SourceReadInput,
        utility: &U,
    ) -> AgentResult<SessionReadResult> {
        if input.view != SourceReadView::Full || input.selection.is_some() {
            return Err(error(
                ErrorCode::InvalidArgument,
                "Session message read requires a full message",
            ));
        }
        let budget = input.budget_chars.unwrap_or(4000);
        if !(1..=12000).contains(&budget) {
            return Err(error(
                ErrorCode::InvalidArgument,
                "Invalid session source budget",
            ));
        }
        let (binding, record) = self.store.with_current(|binding, db| {
            let record = db.source_session_record(request, binding, &input.source)?;
            Ok((binding.clone(), record))
        })?;
        let fragment = utility
            .read(&binding, &record, input.cursor.as_deref(), budget as u32)
            .await?;
        if fragment.session_id != record.session_id
            || fragment.message_id != record.message_id
            || fragment.runtime_entry_id != record.runtime_entry_id
            || fragment.ordinal != record.ordinal
            || fragment.content_hash != record.text_hash
            || fragment.total_chars != record.total_chars
            || fragment.char_end < fragment.char_start
            || fragment.char_end > fragment.total_chars
            || fragment.next_cursor.is_some() != (fragment.char_end < fragment.total_chars)
            || fragment.char_end - fragment.char_start != fragment.text.chars().count() as u32
        {
            return Err(error(
                ErrorCode::SourceChanged,
                "Session source changed during read",
            ));
        }
        let expected_start =
            crate::agent::model_history::history_cursor_offset(input.cursor.as_deref(), &record)?;
        if fragment.char_start != expected_start {
            return Err(error(
                ErrorCode::SourceChanged,
                "Session source cursor changed",
            ));
        }
        let complete = fragment.char_end == fragment.total_chars;
        let page = SourceReadPage {
            source_ref: record.source_ref(&binding),
            text: fragment.text,
            spans: vec![],
            next_cursor: fragment.next_cursor,
            complete,
            range_complete: complete,
            extraction: None,
        };
        let (page, end) = fit_page(
            page,
            fragment.char_start,
            fragment.total_chars,
            budget,
            &record.runtime_entry_id,
            &record.message_id,
        )?;
        self.store.with_current(|current, db| {
            if current != &binding {
                return Err(error(
                    ErrorCode::WorkspaceChanged,
                    "Workspace binding changed",
                ));
            }
            let latest = db.source_session_record(request, current, &input.source)?;
            if latest != record {
                return Err(error(
                    ErrorCode::SourceChanged,
                    "Session source changed during read",
                ));
            }
            Ok(())
        })?;
        Ok(SessionReadResult {
            page,
            char_start: fragment.char_start,
            char_end: end,
            total_chars: fragment.total_chars,
        })
    }
}

#[cfg(test)]
#[path = "source_session_read_tests.rs"]
mod tests;
