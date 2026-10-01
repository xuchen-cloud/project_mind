//! Shared source reads. Adapters supply trusted grants, never file paths or
//! caller-resolved ownership. Every database phase uses the current binding.
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectRef, Scope, SourceLocator, SourceRef, WorkspaceBinding},
    },
    db::Database,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub(crate) trait BoundSourceStore {
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T>;
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceReadTarget {
    pub object: ObjectRef,
    pub revision: Option<String>,
    pub record_version: Option<u32>,
    pub file_version: Option<u32>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SourceReadView {
    Full,
    Range,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceSelection {
    pub block_id: Option<String>,
    pub locator: Option<SourceLocator>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceReadInput {
    pub source: SourceReadTarget,
    pub view: SourceReadView,
    pub selection: Option<SourceSelection>,
    pub cursor: Option<String>,
    pub budget_chars: Option<usize>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceReadSpan {
    pub start: usize,
    pub end: usize,
    pub block_id: Option<String>,
    pub locator: SourceLocator,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceReadPage {
    pub source_ref: SourceRef,
    pub text: String,
    pub spans: Vec<SourceReadSpan>,
    pub next_cursor: Option<String>,
    pub complete: bool,
    pub range_complete: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourcePolicyUpdate {
    pub object: ObjectRef,
    pub expected_revision: u64,
    pub excluded: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourcePolicy {
    pub object: ObjectRef,
    pub revision: u64,
    pub excluded: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceSearchInput {
    pub scope: Scope,
    pub query: String,
    #[serde(default)]
    pub selected: Vec<ObjectRef>,
    #[serde(default)]
    pub include_history: bool,
    pub limit: Option<usize>,
    pub budget_chars: Option<usize>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceSearchPage {
    pub items: Vec<crate::source_search_index::SearchCandidate>,
    pub has_more: bool,
    pub stale_count: usize,
}
pub(crate) struct SourceIndexBudget {
    pub max_chars: usize,
    pub max_chunks: usize,
}
impl Default for SourceIndexBudget {
    fn default() -> Self {
        Self {
            max_chars: 2 * 1024 * 1024,
            max_chunks: 10000,
        }
    }
}
pub(crate) struct SourceFingerprint {
    pub object: ObjectRef,
    pub revision: String,
    pub title: String,
    pub record_version: Option<u32>,
    pub updated_at: String,
}
pub(crate) struct SourceSnapshot {
    pub object: ObjectRef,
    pub revision: String,
    pub title: String,
    pub record_version: Option<u32>,
    pub document: Value,
    pub updated_at: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadCursor {
    object_key: String,
    revision: String,
    selection_hash: String,
    offset: usize,
}
struct TextSpan {
    start_byte: usize,
    end_byte: usize,
    start: usize,
    end: usize,
    block_id: String,
    paragraph: u32,
}
fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn changed() -> AgentError {
    AgentError::new(
        ErrorCode::SourceChanged,
        "Source changed during reading; start from its current reference",
    )
}
fn flatten_record(
    document: &Value,
    selection: Option<&SourceSelection>,
) -> AgentResult<(String, Vec<TextSpan>)> {
    let range = selection.and_then(|selection| selection.locator.as_ref());
    if let Some(locator) = range {
        if !matches!(locator, SourceLocator::Paragraph {start,end} if *start>0 && end>=start) {
            return Err(invalid("Record selection requires a valid paragraph range"));
        }
    }
    let selected_block = selection.and_then(|selection| selection.block_id.as_ref());
    let mut block_found = selected_block.is_none();
    let mut paragraph = 0u32;

    let mut text = String::new();
    let mut spans = vec![];
    let mut chars = 0;
    let mut stack = vec![(document, false)];
    while let Some((node, ancestor_selected)) = stack.pop() {
        let children = node.get("content").and_then(Value::as_array);
        let block = node.pointer("/attrs/blockId").and_then(Value::as_str);
        let selected = selected_block.is_none()
            || ancestor_selected
            || block.is_some_and(|id| selected_block.is_some_and(|selected| selected == id));
        block_found |=
            block.is_some_and(|id| selected_block.is_some_and(|selected| selected == id));
        let container = children.is_some_and(|children| {
            children
                .iter()
                .any(|child| child.pointer("/attrs/blockId").is_some())
        });
        if let Some(id) = block.filter(|_| !container) {
            let mut body = String::new();
            let mut inline = vec![node];
            while let Some(part) = inline.pop() {
                match part.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        body.push_str(part.get("text").and_then(Value::as_str).unwrap_or_default())
                    }
                    Some("hardBreak") => body.push('\n'),
                    Some("internalReference" | "contactMention" | "tagMention") => body.push_str(
                        part.pointer("/attrs/label")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    ),
                    Some("image") => body.push_str(
                        part.pointer("/attrs/alt")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    ),
                    _ => (),
                }
                if let Some(content) = part.get("content").and_then(Value::as_array) {
                    inline.extend(content.iter().rev());
                }
            }
            if !body.is_empty() {
                paragraph += 1;
                let in_range = match range {
                    Some(SourceLocator::Paragraph { start, end }) => {
                        (*start..=*end).contains(&paragraph)
                    }
                    _ => true,
                };
                if !selected || !in_range {
                    continue;
                }
                if !text.is_empty() {
                    text.push_str("\n\n");
                    chars += 2;
                }
                let start = chars;
                chars += body.chars().count();
                spans.push(TextSpan {
                    start_byte: text.len(),
                    end_byte: text.len() + body.len(),
                    start,
                    end: chars,
                    block_id: id.into(),
                    paragraph,
                });
                text.push_str(&body);
            }
        } else if let Some(content) = children {
            stack.extend(content.iter().rev().map(|child| (child, selected)));
        }
    }
    if !block_found || matches!(range,Some(SourceLocator::Paragraph {start,..}) if *start>paragraph)
    {
        return Err(AgentError::new(
            ErrorCode::NotFound,
            "Selected source range is no longer present",
        ));
    }
    if matches!(range,Some(SourceLocator::Paragraph {end,..}) if *end>paragraph) {
        return Err(invalid("Paragraph range exceeds this source"));
    }
    Ok((text, spans))
}
pub(crate) struct SourceService<'a, S> {
    store: &'a S,
}
impl<'a, S: BoundSourceStore> SourceService<'a, S> {
    pub(crate) fn new(store: &'a S) -> Self {
        Self { store }
    }
    pub(crate) fn index_record(
        &self,
        request: &RequestContext,
        source: &SourceReadTarget,
        budget: SourceIndexBudget,
    ) -> AgentResult<()> {
        use crate::source_search_index::{IndexChunk, IndexSource};
        let snapshot = self
            .store
            .with_current(|binding, db| db.source_record_snapshot(request, binding, source))?;
        let (text, spans) = flatten_record(&snapshot.document, None)?;
        let max_chars = budget.max_chars.min(2 * 1024 * 1024);
        let max_chunks = budget.max_chunks.min(10000);
        if max_chars == 0 || max_chunks == 0 {
            return Err(invalid("Source index budgets must be positive"));
        }
        let mut chunks = vec![];
        let mut unique_chars = 0;
        let mut complete = true;
        'paragraphs: for span in spans {
            let characters: Vec<char> = text[span.start_byte..span.end_byte].chars().collect();
            let allowed = characters.len().min(max_chars - unique_chars);
            if allowed == 0 {
                complete = false;
                break;
            }
            let mut offset = 0;
            let mut covered = 0;
            while offset < allowed {
                if chunks.len() == max_chunks {
                    complete = false;
                    break 'paragraphs;
                }
                let end = (offset + 1800).min(allowed);
                chunks.push(IndexChunk {
                    text: characters[offset..end].iter().collect(),
                    locator: SourceLocator::Paragraph {
                        start: span.paragraph,
                        end: span.paragraph,
                    },
                    block_id: Some(span.block_id.clone()),
                });
                unique_chars += end - covered;
                covered = end;
                if end == allowed {
                    break;
                }
                offset = end - 200;
            }
            if allowed < characters.len() {
                complete = false;
                break;
            }
        }
        let cached = IndexSource {
            object: snapshot.object,
            revision: snapshot.revision,
            title: snapshot.title.chars().take(1000).collect(),
            chunks,
            version: snapshot.record_version,
            updated_at: snapshot.updated_at,
            current: source.record_version.is_none(),
            coverage: crate::source_search_index::IndexCoverage {
                chars: unique_chars as u32,
                complete,
            },
        };
        self.store
            .with_current(|binding, db| db.source_index_record(request, binding, source, &cached))
    }
    pub(crate) fn search(
        &self,
        request: &RequestContext,
        input: &SourceSearchInput,
    ) -> AgentResult<SourceSearchPage> {
        let budget = input.budget_chars.unwrap_or(3000).min(12000);
        if budget == 0 {
            return Err(invalid("Source search budget must be positive"));
        }
        let mut page = self
            .store
            .with_current(|binding, db| db.source_search_records(request, binding, input))?;
        while crate::agent::context::serialized_chars(&page)? > budget {
            if page.items.pop().is_none() {
                return Err(AgentError::new(
                    ErrorCode::BudgetExceeded,
                    "Source search metadata does not fit this budget",
                ));
            }
            page.has_more = true;
        }
        self.store.with_current(|binding, db| {
            db.source_verify_search_page(request, binding, &input.scope, &page)?;
            Ok(page)
        })
    }
    pub(crate) fn cache_capacity(
        &self,
        request: &RequestContext,
        scope: &Scope,
    ) -> AgentResult<crate::source_search_index::SourceCacheCapacity> {
        self.store
            .with_current(|binding, db| db.source_cache_capacity(request, binding, scope))
    }
    pub(crate) fn set_policy(
        &self,
        request: &RequestContext,
        input: &SourcePolicyUpdate,
    ) -> AgentResult<SourcePolicy> {
        self.store
            .with_current(|binding, db| db.source_policy_update(request, binding, input))
    }
    pub(crate) fn read(
        &self,
        request: &RequestContext,
        input: &SourceReadInput,
    ) -> AgentResult<SourceReadPage> {
        if input.source.revision.as_ref().is_some_and(|revision| {
            revision.len() != 71
                || !revision.starts_with("sha256:")
                || !revision.as_bytes()[7..]
                    .iter()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
        }) {
            return Err(invalid("Invalid source revision"));
        }
        if input
            .selection
            .as_ref()
            .and_then(|selection| selection.block_id.as_ref())
            .is_some_and(|id| {
                id.len() != 32
                    || !id
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
        {
            return Err(invalid("Invalid source block identity"));
        }
        let budget = input.budget_chars.unwrap_or(4000).min(12000);
        if budget == 0
            || match input.view {
                SourceReadView::Full => input.selection.is_some(),
                SourceReadView::Range => input.selection.as_ref().is_none_or(|selection| {
                    selection.block_id.is_none() && selection.locator.is_none()
                }),
            }
        {
            return Err(invalid(
                "Choose an explicit full view or nonempty source range",
            ));
        }
        let snapshot = self.store.with_current(|binding, db| {
            db.source_record_snapshot(request, binding, &input.source)
        })?;
        let key = snapshot.object.key()?;
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
        let offset = if let Some(encoded) = &input.cursor {
            if encoded.len() > 2048 {
                return Err(invalid("Invalid source cursor"));
            }
            let bytes = URL_SAFE_NO_PAD
                .decode(encoded)
                .map_err(|_| invalid("Invalid source cursor"))?;
            let cursor: ReadCursor =
                serde_json::from_slice(&bytes).map_err(|_| invalid("Invalid source cursor"))?;
            if cursor.object_key != key || cursor.selection_hash != selection_hash {
                return Err(invalid("Cursor belongs to another source selection"));
            }
            if cursor.revision != snapshot.revision {
                return Err(changed());
            }
            cursor.offset
        } else {
            0
        };
        // Pure document projection happens outside the current Workspace/DB locks.
        let (text, spans) = flatten_record(&snapshot.document, input.selection.as_ref())?;
        if offset > text.len()
            || !text.is_char_boundary(offset)
            || (input.cursor.is_some() && offset == text.len())
        {
            return Err(invalid("Source cursor is outside the selected text"));
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
            let content = &text[offset..end];
            let end_char = start_char + count;
            let spans: Vec<_> = spans
                .iter()
                .filter_map(|span| {
                    let start = span.start.max(start_char);
                    let end = span.end.min(end_char);
                    (end > start).then(|| SourceReadSpan {
                        start: start - start_char,
                        end: end - start_char,
                        block_id: Some(span.block_id.clone()),
                        locator: SourceLocator::Paragraph {
                            start: span.paragraph,
                            end: span.paragraph,
                        },
                    })
                })
                .collect();
            let next_cursor = if end < text.len() {
                Some(
                    URL_SAFE_NO_PAD.encode(
                        serde_json::to_vec(&ReadCursor {
                            object_key: key.clone(),
                            revision: snapshot.revision.clone(),
                            selection_hash: selection_hash.clone(),
                            offset: end,
                        })
                        .map_err(|_| invalid("Invalid source cursor"))?,
                    ),
                )
            } else {
                None
            };
            Ok(SourceReadPage {
                source_ref: SourceRef {
                    object: snapshot.object.clone(),
                    revision: snapshot.revision.clone(),
                    file_version: None,
                    record_version: snapshot.record_version,
                    block_id: input
                        .selection
                        .as_ref()
                        .and_then(|selection| selection.block_id.clone())
                        .or_else(|| {
                            if spans.len() == 1 {
                                spans[0].block_id.clone()
                            } else {
                                None
                            }
                        }),
                    locator: spans.first().and_then(|first| {
                        match (&first.locator, &spans.last()?.locator) {
                            (
                                SourceLocator::Paragraph { start, .. },
                                SourceLocator::Paragraph { end, .. },
                            ) => Some(SourceLocator::Paragraph {
                                start: *start,
                                end: *end,
                            }),
                            _ => None,
                        }
                    }),
                    title: snapshot.title.chars().take(1000).collect(),
                    excerpt: content.chars().take(240).collect(),
                },
                text: content.into(),
                spans,
                complete: next_cursor.is_none() && input.view == SourceReadView::Full,
                range_complete: next_cursor.is_none(),
                next_cursor,
            })
        };
        // Include metadata, spans and cursor in the returned-character budget.
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
        if (!tail.is_empty() && low == 0)
            || crate::agent::context::serialized_chars(&page)? > budget
        {
            return Err(AgentError::new(
                ErrorCode::BudgetExceeded,
                "Source metadata does not fit this read budget",
            ));
        }
        self.store.with_current(|binding, db| {
            let current = db.source_record_fingerprint(request, binding, &input.source)?;
            if current.revision != snapshot.revision {
                return Err(changed());
            }
            Ok(page)
        })
    }
}
impl BoundSourceStore for crate::AppState {
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        crate::record_document_service::BoundRecordStore::with_current(self, action)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            access::{Caller, ScopeGrant},
            models::{ObjectKind, Scope},
        },
        models::WorkspaceRecordUpsertInput,
        record_documents::{body_hash, RecordDocumentProjection, RecordTarget},
    };
    use serde_json::json;
    use std::sync::Mutex;
    struct Store {
        binding: Mutex<WorkspaceBinding>,
        db: Mutex<Database>,
    }
    impl BoundSourceStore for Store {
        fn with_current<T>(
            &self,
            action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
        ) -> AgentResult<T> {
            action(&self.binding.lock().unwrap(), &self.db.lock().unwrap())
        }
    }
    fn fixture(text: &str) -> (tempfile::TempDir, Store, RequestContext, SourceReadInput) {
        let directory = tempfile::tempdir().unwrap();
        let mut db = Database::open(
            &directory.path().join("source.sqlite"),
            directory.path(),
            None,
        )
        .unwrap();
        let record = db
            .workspace_record_upsert(WorkspaceRecordUpsertInput {
                note_id: None,
                title: Some("来源分页验收".into()),
                html: "<p>source</p>".into(),
                markdown: "source".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        let target = RecordTarget {
            scope: Scope::Workspace,
            record_id: record.id,
        };
        let document = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"1234567890abcdef1234567890abcdef"},"content":[{"type":"text","text":text}]}]});
        let projection = RecordDocumentProjection {
            schema_version: 1,
            body_hash: body_hash(&document, &None),
            document,
            html: format!("<p>{text}</p>"),
            markdown: text.into(),
            text: text.into(),
            code_language: None,
        };
        db.record_document_initialize(
            "gui",
            "initialize-source",
            &target,
            &db.record_document_source(&target).unwrap().source_hash,
            &projection,
            "source-workspace",
        )
        .unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "source-workspace".into(),
            generation: "generation-1".into(),
        };
        let request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "read-source".into(),
            scope_grant: ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: true,
                project_ids: vec![],
                operations: vec!["source.read".into()],
            },
        };
        let input = SourceReadInput {
            source: SourceReadTarget {
                object: ObjectRef {
                    workspace_id: binding.workspace_id.clone(),
                    scope: Scope::Workspace,
                    kind: ObjectKind::Record,
                    id: record.id.to_string(),
                },
                revision: None,
                record_version: None,
                file_version: None,
            },
            view: SourceReadView::Full,
            selection: None,
            cursor: None,
            budget_chars: Some(1800),
        };
        (
            directory,
            Store {
                binding: Mutex::new(binding),
                db: Mutex::new(db),
            },
            request,
            input,
        )
    }
    fn commit_document(store: &Store, input: &SourceReadInput, document: Value, text: &str) {
        use crate::record_documents::{RecordDocumentCommit, RecordVersionOrigin};
        let target = RecordTarget {
            scope: input.source.object.scope.clone(),
            record_id: input.source.object.id.parse().unwrap(),
        };
        let db = store.db.lock().unwrap();
        let head = db.record_document_head(&target).unwrap().unwrap();
        let projection = RecordDocumentProjection {
            schema_version: 1,
            body_hash: body_hash(&document, &None),
            document,
            html: format!("<p>{text}</p>"),
            markdown: text.into(),
            text: text.into(),
            code_language: None,
        };
        db.record_document_commit(
            "gui",
            "commit-source-fixture",
            &RecordDocumentCommit {
                target,
                base_revision: head.head_revision,
                projection,
                origin: RecordVersionOrigin::Manual,
                actor: json!({"kind":"gui"}),
                edit_session_id: Some("abcdefabcdefabcdefabcdefabcdefab".into()),
            },
            "source-workspace",
        )
        .unwrap();
    }
    #[test]
    fn source_read_block_range_includes_its_children_and_no_adjacent_body() {
        let (_directory, store, request, mut input) = fixture("before");
        let block = |id: &str, text: &str| json!({"type":"paragraph","attrs":{"blockId":id},"content":[{"type":"text","text":text}]});
        let document = json!({"type":"doc","content":[block("11111111111111111111111111111111","before"),{"type":"blockquote","attrs":{"blockId":"22222222222222222222222222222222"},"content":[block("33333333333333333333333333333333","quoted evidence"),block("44444444444444444444444444444444","second paragraph")]},block("55555555555555555555555555555555","after")]});
        commit_document(
            &store,
            &input,
            document,
            "before\n\nquoted evidence\n\nsecond paragraph\n\nafter",
        );
        input.view = SourceReadView::Range;
        input.selection = Some(SourceSelection {
            block_id: Some("22222222222222222222222222222222".into()),
            locator: None,
        });
        let page = SourceService::new(&store).read(&request, &input).unwrap();
        assert_eq!(page.text, "quoted evidence\n\nsecond paragraph");
        assert_eq!(page.spans.len(), 2);
        assert_eq!(
            page.source_ref.block_id.as_deref(),
            Some("22222222222222222222222222222222")
        );
        assert!(page.range_complete);
        assert!(
            !page.complete,
            "a block selection is not a complete full-document read"
        );
        input.selection = Some(SourceSelection {
            block_id: None,
            locator: Some(SourceLocator::Paragraph { start: 3, end: 3 }),
        });
        let paragraph = SourceService::new(&store).read(&request, &input).unwrap();
        assert_eq!(paragraph.text, "second paragraph");
        assert_eq!(
            paragraph.spans[0].block_id.as_deref(),
            Some("44444444444444444444444444444444")
        );
    }
    #[test]
    fn source_read_rejects_invalid_revision_and_block_identity() {
        let (_directory, store, request, mut input) = fixture("evidence");
        input.source.revision = Some("sha256:invalid".into());
        assert_eq!(
            SourceService::new(&store)
                .read(&request, &input)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        input.source.revision = None;
        input.view = SourceReadView::Range;
        input.selection = Some(SourceSelection {
            block_id: Some("guessed-block".into()),
            locator: None,
        });
        assert_eq!(
            SourceService::new(&store)
                .read(&request, &input)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
    }
    #[test]
    fn source_read_current_cursor_expires_on_metadata_change_but_retained_version_does_not() {
        use crate::record_documents::RecordMetadataUpdate;
        let old = "原始版本🙂".repeat(1600);
        let (_directory, store, request, mut current) = fixture(&old);
        let mut history = current.clone();
        history.source.record_version = Some(1);
        let service = SourceService::new(&store);
        let first_current = service.read(&request, &current).unwrap();
        current.cursor = first_current.next_cursor.clone();
        let first_history = service.read(&request, &history).unwrap();
        history.cursor = first_history.next_cursor.clone();
        let target = RecordTarget {
            scope: Scope::Workspace,
            record_id: current.source.object.id.parse().unwrap(),
        };
        {
            let db = store.db.lock().unwrap();
            let metadata = db.record_metadata_get(&target).unwrap();
            db.record_metadata_update(
                "gui",
                "source-rename",
                &RecordMetadataUpdate {
                    target: target.clone(),
                    expected_revision: metadata.revision,
                    title: Some("新标题".into()),
                    tag_ids: vec![],
                },
                "source-workspace",
            )
            .unwrap();
        }
        assert_eq!(
            service.read(&request, &current).unwrap_err().code,
            ErrorCode::SourceChanged
        );
        let document = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"1234567890abcdef1234567890abcdef"},"content":[{"type":"text","text":"新的正文"}]}]});
        commit_document(&store, &current, document, "新的正文");
        let next_history = service.read(&request, &history).unwrap();
        assert_eq!(
            next_history.source_ref.revision,
            first_history.source_ref.revision
        );
        assert_eq!(next_history.source_ref.title, "来源分页验收");
        assert_eq!(next_history.source_ref.record_version, Some(1));
        assert!(next_history.text.contains("原始版本"));
        current.cursor = None;
        current.source.revision = Some(first_current.source_ref.revision);
        assert_eq!(
            service.read(&request, &current).unwrap_err().code,
            ErrorCode::SourceChanged
        );
    }
    #[test]
    fn source_read_checks_current_binding_grants_and_cursor_selection_on_every_page() {
        let (_directory, store, mut request, mut input) = fixture(&"证据🙂".repeat(1800));
        let service = SourceService::new(&store);
        input.cursor = service.read(&request, &input).unwrap().next_cursor;
        request.scope_grant.workspace_content = false;
        assert_eq!(
            service.read(&request, &input).unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        request.scope_grant.workspace_content = true;
        store.binding.lock().unwrap().generation = "generation-2".into();
        assert_eq!(
            service.read(&request, &input).unwrap_err().code,
            ErrorCode::WorkspaceChanged
        );
        store.binding.lock().unwrap().generation = request.binding.generation.clone();
        let mut range = input.clone();
        range.view = SourceReadView::Range;
        range.selection = Some(SourceSelection {
            block_id: Some("1234567890abcdef1234567890abcdef".into()),
            locator: None,
        });
        assert_eq!(
            service.read(&request, &range).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
        let mut other = input.clone();
        other.source.object.workspace_id = "other-workspace".into();
        assert_eq!(
            service.read(&request, &other).unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        let mut malformed = input.clone();
        malformed.cursor = Some("not a cursor".into());
        assert_eq!(
            service.read(&request, &malformed).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
        malformed = input.clone();
        malformed.budget_chars = Some(1);
        assert_eq!(
            service.read(&request, &malformed).unwrap_err().code,
            ErrorCode::BudgetExceeded
        );
    }
    #[test]
    fn source_read_resolves_project_owner_in_storage_before_returning_title_or_body() {
        use crate::models::{ProjectCreateInput, ProjectRecordUpsertInput};
        let (_directory, store, mut request, mut input) = fixture("workspace body");
        let (visible, private_id, record) = {
            let mut db = store.db.lock().unwrap();
            let visible = db
                .project_create(ProjectCreateInput {
                    name: "Allowed".into(),
                    summary: None,
                    status: None,
                })
                .unwrap();
            let private = db
                .project_create(ProjectCreateInput {
                    name: "Private".into(),
                    summary: None,
                    status: None,
                })
                .unwrap();
            let record = db
                .project_record_upsert(ProjectRecordUpsertInput {
                    project_id: private.id,
                    note_id: None,
                    title: Some("secret title".into()),
                    markdown: "secret body".into(),
                    html: "<p>secret body</p>".into(),
                    default_code_language: None,
                    tag_ids: vec![],
                })
                .unwrap();
            (visible.id, private.id, record.id)
        };
        request.scope_grant.project_ids = vec![visible];
        input.source.object.scope = Scope::Project {
            project_id: visible,
        };
        input.source.object.id = record.to_string();
        assert_eq!(
            SourceService::new(&store)
                .read(&request, &input)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        input.source.object.scope = Scope::Project {
            project_id: private_id,
        };
        assert_eq!(
            SourceService::new(&store)
                .read(&request, &input)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
    }
    #[test]
    fn source_policy_excludes_current_and_history_reads_and_replays_without_reapplying() {
        let (_directory, store, mut request, input) = fixture("excluded evidence");
        request.scope_grant.operations.push("settings.write".into());
        let service = SourceService::new(&store);
        let update = SourcePolicyUpdate {
            object: input.source.object.clone(),
            expected_revision: 0,
            excluded: true,
        };
        let result = service.set_policy(&request, &update).unwrap();
        assert_eq!(result.revision, 1);
        assert!(result.excluded);
        assert_eq!(
            service.read(&request, &input).unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        let mut history = input.clone();
        history.source.record_version = Some(1);
        assert_eq!(
            service.read(&request, &history).unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        let mut unexclude = request.clone();
        unexclude.request_id = "unexclude-source".into();
        let current = service
            .set_policy(
                &unexclude,
                &SourcePolicyUpdate {
                    object: update.object.clone(),
                    expected_revision: 1,
                    excluded: false,
                },
            )
            .unwrap();
        assert_eq!(current.revision, 2);
        assert!(!current.excluded);
        let replay = service.set_policy(&request, &update).unwrap();
        assert_eq!(replay.revision, 1);
        assert!(replay.excluded);
        assert_eq!(
            service.read(&request, &input).unwrap().text,
            "excluded evidence"
        );
        assert_eq!(
            service.read(&request, &history).unwrap().text,
            "excluded evidence"
        );
        let mut remote = unexclude.clone();
        remote.caller = Caller::Connection {
            grant_id: "external".into(),
        };
        remote.request_id = "remote-policy".into();
        assert_eq!(
            service
                .set_policy(
                    &remote,
                    &SourcePolicyUpdate {
                        object: update.object.clone(),
                        expected_revision: 2,
                        excluded: true
                    }
                )
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        let mut stale = unexclude.clone();
        stale.request_id = "stale-policy".into();
        assert_eq!(
            service.set_policy(&stale, &update).unwrap_err().code,
            ErrorCode::RevisionConflict
        );
    }
    #[test]
    fn source_read_discards_snapshot_if_workspace_switches_before_response() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct SwitchingStore {
            inner: Store,
            phase: AtomicUsize,
        }
        impl BoundSourceStore for SwitchingStore {
            fn with_current<T>(
                &self,
                action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
            ) -> AgentResult<T> {
                if self.phase.fetch_add(1, Ordering::SeqCst) == 1 {
                    self.inner.binding.lock().unwrap().generation = "reopened".into();
                }
                self.inner.with_current(action)
            }
        }
        let (_directory, inner, request, input) = fixture("snapshot evidence");
        let store = SwitchingStore {
            inner,
            phase: AtomicUsize::new(0),
        };
        assert_eq!(
            SourceService::new(&store)
                .read(&request, &input)
                .unwrap_err()
                .code,
            ErrorCode::WorkspaceChanged
        );
    }
    #[test]
    fn source_search_indexes_committed_blocks_and_rechecks_real_revision_before_returning_evidence()
    {
        let (_directory, store, request, input) = fixture("合同风险 evidence");
        let service = SourceService::new(&store);
        let query = SourceSearchInput {
            scope: Scope::Workspace,
            query: "合同风险".into(),
            selected: vec![],
            include_history: false,
            limit: None,
            budget_chars: None,
        };
        service
            .index_record(&request, &input.source, SourceIndexBudget::default())
            .unwrap();
        let page = service.search(&request, &query).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(
            page.items[0].source_ref.block_id.as_deref(),
            Some("1234567890abcdef1234567890abcdef")
        );
        let read = service.read(&request, &input).unwrap();
        assert_eq!(page.items[0].source_ref.revision, read.source_ref.revision);
        assert!(crate::agent::context::serialized_chars(&page).unwrap() <= 3000);
        let document = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"1234567890abcdef1234567890abcdef"},"content":[{"type":"text","text":"新的证据 evidence"}]}]});
        commit_document(&store, &input, document, "新的证据 evidence");
        let stale = service.search(&request, &query).unwrap();
        assert!(stale.items.is_empty());
        assert_eq!(stale.stale_count, 1);
        service
            .index_record(&request, &input.source, SourceIndexBudget::default())
            .unwrap();
        assert_eq!(service.search(&request, &query).unwrap().stale_count, 0);
        let fresh = service
            .search(
                &request,
                &SourceSearchInput {
                    query: "新的证据".into(),
                    ..query
                },
            )
            .unwrap();
        assert_eq!(fresh.items.len(), 1);
        assert_eq!(
            fresh.items[0].source_ref.revision,
            service.read(&request, &input).unwrap().source_ref.revision
        );
    }
    #[test]
    fn source_index_record_reports_partial_when_scope_batch_character_budget_is_reached() {
        let body = format!("evidence {}", "a".repeat(900));
        let (_directory, store, request, input) = fixture(&body);
        let service = SourceService::new(&store);
        service
            .index_record(
                &request,
                &input.source,
                SourceIndexBudget {
                    max_chars: 600,
                    max_chunks: 10000,
                },
            )
            .unwrap();
        let page = service
            .search(
                &request,
                &SourceSearchInput {
                    scope: Scope::Workspace,
                    query: "evidence".into(),
                    selected: vec![],
                    include_history: false,
                    limit: None,
                    budget_chars: None,
                },
            )
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert!(!page.items[0].coverage.complete);
        assert_eq!(page.items[0].coverage.chars, 600);
    }
    #[test]
    fn source_index_chunk_budget_keeps_unique_coverage_and_later_rebuild_becomes_complete() {
        let body = format!("evidence {}", "a".repeat(4000));
        let (_directory, store, request, input) = fixture(&body);
        let service = SourceService::new(&store);
        service
            .index_record(
                &request,
                &input.source,
                SourceIndexBudget {
                    max_chars: 2 * 1024 * 1024,
                    max_chunks: 2,
                },
            )
            .unwrap();
        let query = SourceSearchInput {
            scope: Scope::Workspace,
            query: "evidence".into(),
            selected: vec![],
            include_history: false,
            limit: None,
            budget_chars: None,
        };
        let partial = service.search(&request, &query).unwrap();
        assert_eq!(partial.items.len(), 1);
        assert_eq!(partial.items[0].coverage.chars, 3400);
        assert!(!partial.items[0].coverage.complete);
        service
            .index_record(&request, &input.source, SourceIndexBudget::default())
            .unwrap();
        let complete = service.search(&request, &query).unwrap();
        assert_eq!(complete.items.len(), 1);
        assert_eq!(complete.items[0].coverage.chars, 4009);
        assert!(complete.items[0].coverage.complete);
    }
    #[test]
    fn source_cache_does_not_keep_deleted_record_body_or_history() {
        use crate::models::WorkspaceRecordDeleteInput;
        let (_directory, store, request, input) = fixture("deleted evidence");
        let service = SourceService::new(&store);
        service
            .index_record(&request, &input.source, SourceIndexBudget::default())
            .unwrap();
        let mut historical = input.source.clone();
        historical.record_version = Some(1);
        service
            .index_record(&request, &historical, SourceIndexBudget::default())
            .unwrap();
        let before = service.cache_capacity(&request, &Scope::Workspace).unwrap();
        assert_eq!(before.objects, 1);
        assert_eq!(before.snapshots, 2);
        assert!(before.content_bytes > 0);
        store
            .db
            .lock()
            .unwrap()
            .workspace_record_delete(WorkspaceRecordDeleteInput {
                note_id: input.source.object.id.parse().unwrap(),
            })
            .unwrap();
        let search = service
            .search(
                &request,
                &SourceSearchInput {
                    scope: Scope::Workspace,
                    query: "evidence".into(),
                    selected: vec![],
                    include_history: true,
                    limit: None,
                    budget_chars: None,
                },
            )
            .unwrap();
        assert!(search.items.is_empty());
        assert_eq!(search.stale_count, 0);
        assert!(!search.has_more);
        let after = service.cache_capacity(&request, &Scope::Workspace).unwrap();
        assert_eq!(after.objects, 0);
        assert_eq!(after.snapshots, 0);
        assert_eq!(after.chunks, 0);
        assert_eq!(after.content_bytes, 0);
    }
    #[test]
    fn source_search_discards_candidates_if_workspace_switches_before_response() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct SwitchingStore {
            inner: Store,
            phase: AtomicUsize,
        }
        impl BoundSourceStore for SwitchingStore {
            fn with_current<T>(
                &self,
                action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
            ) -> AgentResult<T> {
                if self.phase.fetch_add(1, Ordering::SeqCst) == 1 {
                    self.inner.binding.lock().unwrap().generation = "reopened".into();
                }
                self.inner.with_current(action)
            }
        }
        let (_directory, inner, request, input) = fixture("evidence");
        SourceService::new(&inner)
            .index_record(&request, &input.source, SourceIndexBudget::default())
            .unwrap();
        let store = SwitchingStore {
            inner,
            phase: AtomicUsize::new(0),
        };
        let query = SourceSearchInput {
            scope: Scope::Workspace,
            query: "evidence".into(),
            selected: vec![],
            include_history: false,
            limit: None,
            budget_chars: None,
        };
        assert_eq!(
            SourceService::new(&store)
                .search(&request, &query)
                .unwrap_err()
                .code,
            ErrorCode::WorkspaceChanged
        );
    }
    #[test]
    fn source_read_unicode_pages_are_bounded_and_only_last_page_is_complete() {
        let expected = "中文🙂证据".repeat(1600);
        let (_directory, store, request, mut input) = fixture(&expected);
        let service = SourceService::new(&store);
        let mut text = String::new();
        let mut pages = 0;
        loop {
            let page = service.read(&request, &input).unwrap();
            assert!(crate::agent::context::serialized_chars(&page).unwrap() <= 1800);
            assert_eq!(
                page.spans[0].block_id.as_deref(),
                Some("1234567890abcdef1234567890abcdef")
            );
            assert_eq!(page.spans[0].end, page.text.chars().count());
            text.push_str(&page.text);
            pages += 1;
            if page.next_cursor.is_none() {
                assert!(page.complete);
                break;
            }
            assert!(!page.complete);
            input.cursor = page.next_cursor;
            assert!(pages < 100);
        }
        assert!(pages > 1);
        assert_eq!(text, expected);
    }
}
