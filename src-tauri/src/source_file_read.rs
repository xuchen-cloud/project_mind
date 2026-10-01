//! Bounded File text projections; original bytes remain in File Versions.
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, SourceLocator, SourceRef},
    },
    source_service::{
        BoundSourceStore, SourceReadInput, SourceReadPage, SourceReadSpan, SourceReadView,
        SourceService, SourceUtility,
    },
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileExtractionStatus {
    pub state: String,
    pub coverage: Value,
    pub reason: Option<String>,
}
#[derive(Deserialize)]
struct Extraction {
    state: String,
    coverage: Value,
    reason: Option<String>,
    chunks: Vec<Chunk>,
}
#[derive(Deserialize)]
struct Chunk {
    text: String,
    locator: SourceLocator,
    range: CharacterRange,
}
#[derive(Deserialize)]
struct CharacterRange {
    start: usize,
    end: usize,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    object_key: String,
    revision: String,
    file_version: u32,
    selection_hash: String,
    offset: usize,
}
struct Span {
    start: usize,
    end: usize,
    locator: SourceLocator,
}
fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn protocol() -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Invalid source extraction projection")
}
fn source_changed() -> AgentError {
    AgentError::new(
        ErrorCode::SourceChanged,
        "File source changed; restart reading its current version",
    )
}

// Worker chunks overlap within one location. Reconstruct each location once,
// retaining Unicode offsets rather than joining duplicate evidence.
fn text_locations(chunks: Vec<Chunk>) -> AgentResult<Vec<(SourceLocator, String)>> {
    let mut locations: Vec<(SourceLocator, String)> = vec![];
    let mut covered = 0;
    for chunk in chunks {
        let same = locations
            .last()
            .is_some_and(|(locator, _)| match (locator, &chunk.locator) {
                (
                    SourceLocator::Paragraph { start: a, .. },
                    SourceLocator::Paragraph { start: b, .. },
                ) => a == b,
                (SourceLocator::Page { page: a, .. }, SourceLocator::Page { page: b, .. }) => {
                    a == b
                }
                _ => false,
            });
        if !same {
            covered = 0;
            locations.push((chunk.locator.clone(), String::new()));
        }
        if chunk.range.start > covered
            || chunk.range.end <= covered
            || chunk.text.chars().count() != chunk.range.end.saturating_sub(chunk.range.start)
        {
            return Err(protocol());
        }
        locations
            .last_mut()
            .ok_or_else(protocol)?
            .1
            .extend(chunk.text.chars().skip(covered - chunk.range.start));
        covered = chunk.range.end;
        if let Some((SourceLocator::Page { end, .. }, _)) = locations.last_mut() {
            *end = covered as u32;
        }
    }
    Ok(locations)
}
fn projection(
    extraction: &FileExtractionStatus,
    locations: Vec<(SourceLocator, String)>,
    input: &SourceReadInput,
) -> AgentResult<(String, Vec<Span>)> {
    let selected = input
        .selection
        .as_ref()
        .and_then(|selection| selection.locator.as_ref());
    let mut text = String::new();
    let mut spans = vec![];
    let mut chars = 0;
    let mut last_paragraph = 0;
    for (mut locator, mut content) in locations {
        if let SourceLocator::Paragraph { end, .. } = &locator {
            last_paragraph = *end;
        }
        match (selected, &mut locator) {
            (None, _) => (),
            (
                Some(SourceLocator::Paragraph { start, end }),
                SourceLocator::Paragraph {
                    start: paragraph, ..
                },
            ) if *paragraph >= *start && *paragraph <= *end => (),
            (
                Some(SourceLocator::Page { page, start, end }),
                SourceLocator::Page {
                    page: location,
                    start: local_start,
                    end: local_end,
                },
            ) if page == location => {
                if *end > *local_end {
                    return Err(if extraction.coverage["complete"] == false {
                        AgentError::new(
                            ErrorCode::SourceNotReady,
                            "Requested page range exceeds extracted coverage",
                        )
                    } else {
                        invalid("Page range exceeds extracted text")
                    });
                }
                content = content
                    .chars()
                    .skip(*start as usize)
                    .take((end - start) as usize)
                    .collect();
                *local_start = *start;
                *local_end = *end;
            }
            _ => continue,
        }
        if !text.is_empty() {
            text.push_str("\n\n");
            chars += 2;
        }
        let start = chars;
        chars += content.chars().count();
        text.push_str(&content);
        spans.push(Span {
            start,
            end: chars,
            locator,
        });
    }
    if selected.is_some() && spans.is_empty() {
        return Err(AgentError::new(
            if extraction.coverage["complete"] == false {
                ErrorCode::SourceNotReady
            } else {
                ErrorCode::NotFound
            },
            "Selected range has no extracted text",
        ));
    }
    if matches!(selected, Some(SourceLocator::Paragraph { end, .. }) if *end > last_paragraph) {
        return Err(if extraction.coverage["complete"] == false {
            AgentError::new(
                ErrorCode::SourceNotReady,
                "Requested paragraphs exceed extracted coverage",
            )
        } else {
            invalid("Paragraph range exceeds extracted text")
        });
    }
    Ok((text, spans))
}
fn clipped_locator(span: &Span, start: usize, end: usize) -> SourceLocator {
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
impl<'a, S: BoundSourceStore> SourceService<'a, S> {
    pub(crate) async fn index_file<W: SourceUtility>(
        &self,
        request: &RequestContext,
        source: &crate::source_service::SourceReadTarget,
        budget: crate::source_service::SourceIndexBudget,
        utility: &W,
    ) -> AgentResult<()> {
        use crate::source_search_index::{IndexChunk, IndexCoverage, IndexSource};
        let max_chars = budget.max_chars.min(2 * 1024 * 1024);
        let max_chunks = budget.max_chunks.min(10000);
        if max_chars == 0 || max_chunks == 0 {
            return Err(invalid("Source index budgets must be positive"));
        }
        let extraction = self.extract_file(request, source, utility).await?;
        let data: Extraction =
            serde_json::from_value(extraction.data.clone()).map_err(|_| protocol())?;
        let mut complete = data.coverage["complete"] == true;
        let mut chunks = vec![];
        let mut previous_location = None;
        let mut covered = 0;
        let mut chars = 0;
        for chunk in data.chunks {
            if chunks.len() == max_chunks || chars == max_chars {
                complete = false;
                break;
            }
            let location = match &chunk.locator {
                SourceLocator::Paragraph { start, .. } => (false, *start),
                SourceLocator::Page { page, .. } => (true, *page),
                _ => return Err(protocol()),
            };
            if previous_location != Some(location) {
                covered = 0;
            }
            if chunk.range.start > covered || chunk.range.end <= covered {
                return Err(protocol());
            }
            let end = chunk.range.end.min(covered + max_chars - chars);
            let mut locator = chunk.locator;
            if let SourceLocator::Page { end: local_end, .. } = &mut locator {
                *local_end = end as u32;
            }
            chunks.push(IndexChunk {
                text: chunk.text.chars().take(end - chunk.range.start).collect(),
                locator,
                block_id: None,
            });
            chars += end - covered;
            covered = end;
            previous_location = Some(location);
            if end < chunk.range.end {
                complete = false;
                break;
            }
        }
        let cached = IndexSource {
            object: extraction.object.clone(),
            revision: extraction.revision.clone(),
            title: extraction.title.chars().take(1000).collect(),
            version: Some(extraction.file_version),
            updated_at: extraction.plan.updated_at.clone(),
            current: source.file_version.is_none(),
            chunks,
            coverage: IndexCoverage {
                chars: chars as u32,
                complete,
            },
        };
        self.verify_file_extraction(request, source, &extraction)
            .await?;
        self.store.with_current(|binding, db| {
            db.source_index_file(request, binding, source, &extraction.plan, &cached)
        })
    }
    pub(crate) async fn read_file<W: SourceUtility>(
        &self,
        request: &RequestContext,
        input: &SourceReadInput,
        utility: &W,
    ) -> AgentResult<SourceReadPage> {
        let budget = input.budget_chars.unwrap_or(4000).min(12000);
        if budget == 0
            || input.source.object.kind != ObjectKind::File
            || input.source.record_version.is_some()
            || input.source.file_version == Some(0)
        {
            return Err(invalid("Invalid File read target or budget"));
        }
        if input.source.revision.as_ref().is_some_and(|revision| {
            revision.len() != 71
                || !revision.starts_with("sha256:")
                || !revision.as_bytes()[7..]
                    .iter()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
        }) {
            return Err(invalid("Invalid File source revision"));
        }
        match (input.view, &input.selection) {
            (SourceReadView::Full, None) => (),
            (SourceReadView::Range, Some(selection)) if selection.block_id.is_none() => {
                match &selection.locator {
                    Some(SourceLocator::Paragraph { start, end }) if *start > 0 && end >= start => {
                        ()
                    }
                    Some(SourceLocator::Page { page, start, end }) if *page > 0 && end > start => {
                        ()
                    }
                    _ => return Err(invalid("Choose a paragraph or page range for this File")),
                }
            }
            _ => return Err(invalid("Choose an explicit full view or File text range")),
        }
        let cursor: Option<Cursor> = input
            .cursor
            .as_ref()
            .map(|encoded| {
                if encoded.len() > 2048 {
                    return Err(invalid("Invalid File read cursor"));
                }
                let bytes = URL_SAFE_NO_PAD
                    .decode(encoded)
                    .map_err(|_| invalid("Invalid File read cursor"))?;
                serde_json::from_slice(&bytes).map_err(|_| invalid("Invalid File read cursor"))
            })
            .transpose()?;
        let extraction = self.extract_file(request, &input.source, utility).await?;
        let key = extraction.object.key()?;
        let selection_hash = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(input.view, &input.selection, input.source.file_version))
                    .map_err(|_| invalid("Invalid File selection"))?
            )
        );
        let offset = if let Some(cursor) = cursor {
            if cursor.object_key != key || cursor.selection_hash != selection_hash {
                return Err(invalid("Cursor belongs to another File selection"));
            }
            if cursor.revision != extraction.revision
                || cursor.file_version != extraction.file_version
            {
                return Err(source_changed());
            }
            cursor.offset
        } else {
            0
        };
        let data: Extraction =
            serde_json::from_value(extraction.data.clone()).map_err(|_| protocol())?;
        let status = FileExtractionStatus {
            state: data.state,
            coverage: data.coverage,
            reason: data.reason,
        };
        let (text, spans) = projection(&status, text_locations(data.chunks)?, input)?;
        if offset > text.len()
            || !text.is_char_boundary(offset)
            || (input.cursor.is_some() && offset == text.len())
        {
            return Err(invalid("File cursor is outside the selected text"));
        }
        let start_char = text[..offset].chars().count();
        let tail = &text[offset..];
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
                        block_id: None,
                        locator: clipped_locator(span, start, end),
                    })
                })
                .collect();
            let next_cursor = if end < text.len() {
                Some(
                    URL_SAFE_NO_PAD.encode(
                        serde_json::to_vec(&Cursor {
                            object_key: key.clone(),
                            revision: extraction.revision.clone(),
                            file_version: extraction.file_version,
                            selection_hash: selection_hash.clone(),
                            offset: end,
                        })
                        .map_err(|_| invalid("Invalid File cursor"))?,
                    ),
                )
            } else {
                None
            };
            let locator = page_spans.first().and_then(|first| {
                match (&first.locator, &page_spans.last()?.locator) {
                    (
                        SourceLocator::Paragraph { start, .. },
                        SourceLocator::Paragraph { end, .. },
                    ) => Some(SourceLocator::Paragraph {
                        start: *start,
                        end: *end,
                    }),
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
                    _ => None,
                }
            });
            Ok(SourceReadPage {
                source_ref: SourceRef {
                    object: extraction.object.clone(),
                    revision: extraction.revision.clone(),
                    file_version: Some(extraction.file_version),
                    record_version: None,
                    block_id: None,
                    locator,
                    title: extraction.title.chars().take(1000).collect(),
                    excerpt: text[offset..end].chars().take(240).collect(),
                },
                text: text[offset..end].into(),
                spans: page_spans,
                complete: next_cursor.is_none()
                    && input.view == SourceReadView::Full
                    && status.coverage["complete"] == true,
                range_complete: next_cursor.is_none()
                    && (input.view == SourceReadView::Range || status.coverage["complete"] == true),
                next_cursor,
                extraction: Some(status.clone()),
            })
        };
        let mut low = 0;
        let mut high = tail.chars().take(budget).count();
        while low < high {
            let middle = (low + high + 1) / 2;
            if crate::agent::context::serialized_chars(&make_page(middle)?)? <= budget {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        let page = make_page(low)?;
        if (!tail.is_empty() && low == 0)
            || crate::agent::context::serialized_chars(&page)? > budget
        {
            return Err(AgentError::new(
                ErrorCode::BudgetExceeded,
                "File metadata does not fit this read budget",
            ));
        }
        self.verify_file_extraction(request, &input.source, &extraction)
            .await?;
        Ok(page)
    }
}
