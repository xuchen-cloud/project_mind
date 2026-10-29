//! Current Record reads with immutable projections and direct line windows.
//! Issue #283: no scan/migration; initialize only a requested legacy Record.
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef, SourceLocator, SourceRef},
    },
    record_document_service::DocumentUtility,
    source_service::{
        BoundSourceStore, SourceReadPage, SourceReadSpan, SourceReadTarget, SourceService,
    },
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[path = "record_read_cache.rs"]
mod record_read_cache;
use record_read_cache::{Key, Projection};

#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RecordReadFormat {
    #[default]
    Text,
    Markdown,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordGetInput {
    #[serde(rename = "object", alias = "record")]
    pub record: ObjectRef,
    #[schemars(length(max = 128))]
    pub revision: Option<String>,
    #[schemars(length(max = 2048))]
    pub cursor: Option<String>,
    #[schemars(range(min = 1, max = 12000))]
    pub budget_chars: Option<usize>,
    /// text preserves the existing source projection; markdown is canonical Markdown.
    pub format: Option<RecordReadFormat>,
    /// Inclusive 1-based first line of the selected projection.
    #[schemars(range(min = 1))]
    pub offset: Option<usize>,
    #[schemars(range(min = 1))]
    pub limit: Option<usize>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordReadWindow {
    pub offset: usize,
    pub limit: Option<usize>,
    pub total_lines: usize,
    /// Lines covered by this page; an empty page has endLine < startLine.
    pub start_line: usize,
    pub end_line: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordGetPage {
    #[serde(flatten)]
    pub page: SourceReadPage,
    /// Numeric write baseline, observed atomically with this exact body/revision.
    pub head_revision: u64,
    pub format: RecordReadFormat,
    pub window: RecordReadWindow,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
// Opaque cursor keys stay compact: cursor metadata shares the read budget.
struct Cursor {
    #[serde(rename = "o")]
    object: String,
    #[serde(rename = "r")]
    revision: String,
    #[serde(rename = "h")]
    head_revision: u64,
    #[serde(rename = "f")]
    format: RecordReadFormat,
    #[serde(rename = "s")]
    offset: usize,
    #[serde(rename = "l")]
    limit: Option<usize>,
    #[serde(rename = "b")]
    byte: usize,
}
fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn changed() -> AgentError {
    AgentError::new(
        ErrorCode::SourceChanged,
        "Record changed; restart reading its current reference",
    )
}
fn source(input: &RecordGetInput) -> SourceReadTarget {
    SourceReadTarget {
        object: input.record.clone(),
        revision: input.revision.clone(),
        record_version: None,
        file_version: None,
    }
}
#[cfg(test)]
fn key(
    request: &RequestContext,
    revision: &str,
    head_revision: u64,
    input: &RecordGetInput,
) -> AgentResult<Key> {
    Ok(Key {
        workspace: request.binding.workspace_id.clone(),
        generation: request.binding.generation.clone(),
        object: input.record.key()?,
        revision: revision.into(),
        head_revision,
        format: input.format.unwrap_or_default(),
    })
}
fn read<S: BoundSourceStore>(
    store: &S,
    request: &RequestContext,
    input: &RecordGetInput,
) -> AgentResult<RecordGetPage> {
    if input.record.kind != ObjectKind::Record {
        return Err(invalid("Expected a Record target"));
    }
    if input.offset == Some(0) || input.limit == Some(0) {
        return Err(invalid(
            "Record offset and limit must be positive (offset is 1-based)",
        ));
    }
    if input.budget_chars == Some(0) || input.budget_chars.is_some_and(|budget| budget > 12000) {
        return Err(invalid("Record read budget must be between 1 and 12000"));
    }
    if input.revision.as_ref().is_some_and(|revision| {
        revision.len() != 71
            || !revision.starts_with("sha256:")
            || !revision.as_bytes()[7..]
                .iter()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    }) {
        return Err(invalid("Invalid source revision"));
    }
    let format = input.format.unwrap_or_default();
    let cursor: Option<Cursor> = input
        .cursor
        .as_ref()
        .map(|encoded| {
            if encoded.len() > 2048 {
                return Err(invalid("Invalid Record cursor"));
            }
            let bytes = URL_SAFE_NO_PAD
                .decode(encoded)
                .map_err(|_| invalid("Invalid Record cursor"))?;
            serde_json::from_slice(&bytes).map_err(|_| invalid("Invalid Record cursor"))
        })
        .transpose()?;
    let mut cached = None;
    let mut cache_key = None;
    let state = store.with_current(|binding, db| {
        db.record_read_snapshot(
            request,
            binding,
            &source(input),
            format == RecordReadFormat::Markdown,
            |fingerprint, head_revision| {
                // Object identity was validated by the snapshot's authorization phase.
                let candidate = Key {
                    workspace: binding.workspace_id.clone(),
                    generation: binding.generation.clone(),
                    object: input.record.key().expect("authorized object key"),
                    revision: fingerprint.revision.clone(),
                    head_revision,
                    format,
                };
                cached = record_read_cache::get(&candidate);
                cache_key = Some(candidate);
                cached.is_none()
            },
        )
    })?;
    let cache_key = cache_key.expect("snapshot always consults projection cache");
    let projection = match cached {
        Some(projection) => projection,
        None => {
            let content = state.content.ok_or_else(|| {
                AgentError::new(ErrorCode::IoFailed, "Missing Record snapshot body")
            })?;
            let (text, spans) = match format {
                RecordReadFormat::Markdown => (content, vec![]),
                RecordReadFormat::Text => {
                    let document = serde_json::from_str(&content).map_err(|_| {
                        AgentError::new(ErrorCode::IoFailed, "Stored Record document is damaged")
                    })?;
                    crate::source_service::flatten_record(&document, None)?
                }
            };
            let projection = Arc::new(Projection::new(text, spans));
            record_read_cache::insert(cache_key, projection.clone());
            projection
        }
    };
    let page = paginate(
        input,
        &state.fingerprint,
        state.head_revision,
        &projection,
        cursor,
    );
    // Projection/pagination occurs outside DB locks. Check again after this
    // lock boundary before releasing the authorized snapshot data.
    store.with_current(|binding, db| {
        let current = db.record_read_snapshot(
            request,
            binding,
            &source(input),
            format == RecordReadFormat::Markdown,
            |_, _| false,
        )?;
        if current.fingerprint.revision != state.fingerprint.revision
            || current.head_revision != state.head_revision
        {
            return Err(changed());
        }
        page
    })
}
pub(crate) async fn get<S: BoundSourceStore, W: DocumentUtility>(
    store: &S,
    request: &RequestContext,
    input: &RecordGetInput,
    utility: &W,
) -> AgentResult<RecordGetPage> {
    match read(store, request, input) {
        Err(error)
            if error.code == ErrorCode::SourceNotReady
                && input.record.kind == ObjectKind::Record =>
        {
            SourceService::new(store)
                .prepare_record(request, &source(input), utility)
                .await?;
            read(store, request, input)
        }
        result => result,
    }
}
fn paginate(
    input: &RecordGetInput,
    fingerprint: &crate::source_service::SourceFingerprint,
    head_revision: u64,
    projection: &Projection,
    cursor: Option<Cursor>,
) -> AgentResult<RecordGetPage> {
    let format = input.format.unwrap_or_default();
    let offset = input.offset.unwrap_or(1);
    let start = projection.line_byte(offset);
    let end = input
        .limit
        .map(|limit| projection.line_byte(offset.saturating_add(limit)))
        .unwrap_or(projection.text.len());
    let position = match cursor {
        Some(cursor) => {
            if cursor.object != input.record.key()?
                || cursor.format != format
                || cursor.offset != offset
                || cursor.limit != input.limit
            {
                return Err(invalid(
                    "Cursor belongs to another Record format or line window",
                ));
            }
            if cursor.revision != fingerprint.revision || cursor.head_revision != head_revision {
                return Err(changed());
            }
            if cursor.byte < start
                || cursor.byte >= end
                || !projection.text.is_char_boundary(cursor.byte)
            {
                return Err(invalid("Record cursor is outside the selected text"));
            }
            cursor.byte
        }
        None => start,
    };
    let budget = input.budget_chars.unwrap_or(4000);
    let tail = &projection.text[position..end];
    // Only the target window and at most this page's budget are processed here.
    let boundaries: Vec<_> = tail
        .char_indices()
        .take(budget)
        .map(|(byte, _)| byte)
        .collect();
    let maximum = boundaries.len();
    let start_char = projection.char_at(position);
    let span_start = projection
        .spans
        .partition_point(|span| span.end <= start_char);
    let make_page = |count: usize| -> AgentResult<RecordGetPage> {
        let bytes = boundaries.get(count).copied().unwrap_or_else(|| {
            tail.char_indices()
                .nth(count)
                .map(|(byte, _)| byte)
                .unwrap_or(tail.len())
        });
        let finish = position + bytes;
        let spans: Vec<_> = projection.spans[span_start..]
            .iter()
            .take_while(|span| span.start < start_char + count)
            .filter_map(|span| {
                let begin = span.start.max(start_char);
                let finish = span.end.min(start_char + count);
                (finish > begin).then(|| SourceReadSpan {
                    start: begin - start_char,
                    end: finish - start_char,
                    block_id: Some(span.block_id.clone()),
                    locator: SourceLocator::Paragraph {
                        start: span.paragraph,
                        end: span.paragraph,
                    },
                })
            })
            .collect();
        let next_cursor = if finish < end {
            Some(
                URL_SAFE_NO_PAD.encode(
                    serde_json::to_vec(&Cursor {
                        object: input.record.key()?,
                        revision: fingerprint.revision.clone(),
                        head_revision,
                        format,
                        offset,
                        limit: input.limit,
                        byte: finish,
                    })
                    .map_err(|_| invalid("Invalid Record cursor"))?,
                ),
            )
        } else {
            None
        };
        let locator = match (spans.first(), spans.last()) {
            (Some(first), Some(last)) => match (&first.locator, &last.locator) {
                (SourceLocator::Paragraph { start, .. }, SourceLocator::Paragraph { end, .. }) => {
                    Some(SourceLocator::Paragraph {
                        start: *start,
                        end: *end,
                    })
                }
                _ => None,
            },
            _ => None,
        };
        let source_ref = SourceRef {
            object: fingerprint.object.clone(),
            revision: fingerprint.revision.clone(),
            title: fingerprint.title.chars().take(1000).collect(),
            file_version: None,
            record_version: None,
            block_id: (spans.len() == 1)
                .then(|| spans[0].block_id.clone())
                .flatten(),
            locator,
            excerpt: tail[..bytes].chars().take(240).collect(),
        };
        Ok(RecordGetPage {
            page: SourceReadPage {
                source_ref,
                text: tail[..bytes].into(),
                spans,
                complete: next_cursor.is_none() && start == 0 && end == projection.text.len(),
                range_complete: next_cursor.is_none(),
                next_cursor,
                extraction: None,
            },
            head_revision,
            format,
            window: RecordReadWindow {
                offset,
                limit: input.limit,
                total_lines: projection.total_lines(),
                start_line: if tail.is_empty() {
                    offset
                } else {
                    projection.line_at(position)
                },
                end_line: if bytes == 0 {
                    offset.saturating_sub(1)
                } else {
                    projection.line_at(finish - 1)
                },
            },
        })
    };
    let mut low = 0;
    let mut high = maximum;
    if crate::agent::context::serialized_chars(&make_page(high)?)? <= budget {
        low = high;
    }
    while low < high {
        let middle = (low + high + 1) / 2;
        if crate::agent::context::serialized_chars(&make_page(middle)?)? <= budget {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    let page = make_page(low)?;
    if (!tail.is_empty() && low == 0) || crate::agent::context::serialized_chars(&page)? > budget {
        return Err(AgentError::new(ErrorCode::BudgetExceeded, "Source metadata does not fit this read budget")
            .with_details(serde_json::json!({"object":input.record, "title":fingerprint.title.chars().take(120).collect::<String>(),
                "minimumBudgetChars":crate::agent::context::serialized_chars(&make_page(usize::from(!tail.is_empty()))?)?})));
    }
    Ok(page)
}

#[cfg(test)]
#[path = "record_get_tests.rs"]
mod tests;
