//! Pure bounded text paging. Source services authorize their snapshots before
//! projection and recheck the current binding/revision before returning a page.
use crate::{
    agent::{
        errors::{AgentError, AgentResult, ErrorCode},
        models::{SourceLocator, SourceRef},
    },
    source_file_read::FileExtractionStatus,
    source_service::{SourceReadInput, SourceReadPage, SourceReadSpan, SourceReadView},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(crate) struct TextSpan {
    pub start: usize,
    pub end: usize,
    pub block_id: Option<String>,
    pub locator: SourceLocator,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadCursor {
    object_key: String,
    revision: String,
    selection_hash: String,
    offset: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    file_version: Option<u32>,
}
fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
pub(crate) fn decode_cursor(input: &SourceReadInput) -> AgentResult<Option<ReadCursor>> {
    input
        .cursor
        .as_ref()
        .map(|encoded| {
            if encoded.len() > 2048 {
                return Err(invalid("Invalid source cursor"));
            }
            let bytes = URL_SAFE_NO_PAD
                .decode(encoded)
                .map_err(|_| invalid("Invalid source cursor"))?;
            serde_json::from_slice(&bytes).map_err(|_| invalid("Invalid source cursor"))
        })
        .transpose()
}
fn locator_span(spans: &[SourceReadSpan]) -> Option<SourceLocator> {
    let first = &spans.first()?.locator;
    let last = &spans.last()?.locator;
    match (first, last) {
        (SourceLocator::Paragraph { start, .. }, SourceLocator::Paragraph { end, .. }) => {
            Some(SourceLocator::Paragraph {
                start: *start,
                end: *end,
            })
        }
        (
            SourceLocator::Page { page, start, .. },
            SourceLocator::Page {
                page: last, end, ..
            },
        ) if page == last => Some(SourceLocator::Page {
            page: *page,
            start: *start,
            end: *end,
        }),
        (SourceLocator::Time { .. }, SourceLocator::Time { .. }) => {
            let (start_ms, end_ms) =
                spans
                    .iter()
                    .try_fold((u64::MAX, 0), |(start, end), span| match &span.locator {
                        SourceLocator::Time { start_ms, end_ms } => {
                            Some((start.min(*start_ms), end.max(*end_ms)))
                        }
                        _ => None,
                    })?;
            Some(SourceLocator::Time { start_ms, end_ms })
        }
        _ => None,
    }
}
fn clipped_locator(span: &TextSpan, start: usize, end: usize) -> SourceLocator {
    match &span.locator {
        SourceLocator::Page {
            page,
            start: local_start,
            ..
        } => SourceLocator::Page {
            page: *page,
            start: *local_start + (start - span.start) as u32,
            end: *local_start + (end - span.start) as u32,
        },
        locator => locator.clone(),
    }
}
pub(crate) fn paginate(
    input: &SourceReadInput,
    source: SourceRef,
    text: &str,
    spans: &[TextSpan],
    cursor: Option<ReadCursor>,
    extraction: Option<FileExtractionStatus>,
) -> AgentResult<SourceReadPage> {
    let budget = input.budget_chars.unwrap_or(4000).min(12000);
    if budget == 0 {
        return Err(invalid("Source read budget must be positive"));
    }
    let key = source.object.key()?;
    let selection_hash = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(
                input.view,
                &input.selection,
                input.source.record_version,
                input.source.file_version
            ))
            .map_err(|_| invalid("Invalid source selection"))?
        )
    );
    let offset = if let Some(cursor) = cursor {
        if cursor.object_key != key || cursor.selection_hash != selection_hash {
            return Err(invalid("Cursor belongs to another source selection"));
        }
        if cursor.revision != source.revision || cursor.file_version != source.file_version {
            return Err(AgentError::new(
                ErrorCode::SourceChanged,
                "Source changed; restart reading its current reference",
            ));
        }
        cursor.offset
    } else {
        0
    };
    if offset > text.len()
        || !text.is_char_boundary(offset)
        || (input.cursor.is_some() && offset == text.len())
    {
        return Err(invalid("Source cursor is outside the selected text"));
    }
    let start_char = text[..offset].chars().count();
    let tail = &text[offset..];
    let coverage_complete = extraction
        .as_ref()
        .is_none_or(|status| status.coverage["complete"] == true);
    let make_page = |count: usize| -> AgentResult<SourceReadPage> {
        let bytes = tail
            .char_indices()
            .nth(count)
            .map(|(byte, _)| byte)
            .unwrap_or(tail.len());
        let end = offset + bytes;
        let page_spans: Vec<_> = spans
            .iter()
            .filter_map(|span| {
                let start = span.start.max(start_char);
                let end = span.end.min(start_char + count);
                (end > start).then(|| SourceReadSpan {
                    start: start - start_char,
                    end: end - start_char,
                    block_id: span.block_id.clone(),
                    locator: clipped_locator(span, start, end),
                })
            })
            .collect();
        let next_cursor = if end < text.len() {
            Some(
                URL_SAFE_NO_PAD.encode(
                    serde_json::to_vec(&ReadCursor {
                        object_key: key.clone(),
                        revision: source.revision.clone(),
                        file_version: source.file_version,
                        selection_hash: selection_hash.clone(),
                        offset: end,
                    })
                    .map_err(|_| invalid("Invalid source cursor"))?,
                ),
            )
        } else {
            None
        };
        let mut source_ref = source.clone();
        source_ref.title = source.title.chars().take(1000).collect();
        source_ref.excerpt = text[offset..end].chars().take(240).collect();
        source_ref.block_id = input
            .selection
            .as_ref()
            .and_then(|selection| selection.block_id.clone())
            .or_else(|| {
                if page_spans.len() == 1 {
                    page_spans[0].block_id.clone()
                } else {
                    None
                }
            });
        source_ref.locator = locator_span(&page_spans);
        Ok(SourceReadPage {
            source_ref,
            text: text[offset..end].into(),
            spans: page_spans,
            complete: next_cursor.is_none()
                && input.view == SourceReadView::Full
                && coverage_complete,
            range_complete: next_cursor.is_none()
                && (input.view == SourceReadView::Range || coverage_complete),
            next_cursor,
            extraction: extraction.clone(),
        })
    };
    // Metadata, spans, excerpts and the continuation cursor count toward the
    // same Unicode budget; a page must make progress or fail explicitly.
    let mut low = 0;
    let mut high = tail.chars().take(budget).count();
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
        return Err(AgentError::new(
            ErrorCode::BudgetExceeded,
            "Source metadata does not fit this read budget",
        ));
    }
    Ok(page)
}
