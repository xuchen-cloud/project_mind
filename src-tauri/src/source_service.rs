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
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) trait BoundSourceStore:
    crate::committed_changes::CommittedChangePublisher
{
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T>;
}
pub(crate) trait SourceUtility {
    fn prepared_extractor(
        &self,
    ) -> impl std::future::Future<
        Output = AgentResult<Option<crate::source_extraction_worker::SourceExtractionWorker>>,
    > + Send {
        async { Ok(None) }
    }
    fn extraction_identity(
        &self,
    ) -> impl std::future::Future<Output = AgentResult<Option<String>>> + Send {
        async { Ok(None) }
    }

    fn session_inventory(
        &self,
        _binding: &WorkspaceBinding,
        _input: &crate::agent::record_list::RecordListInput,
        _authorization: &str,
    ) -> impl std::future::Future<Output = AgentResult<Value>> + Send {
        async {
            Err(AgentError::new(
                ErrorCode::RuntimeUnavailable,
                "Session inventory requires the native DSH runtime",
            ))
        }
    }
    fn request(
        &self,
        workspace_id: &str,
        request_id: &str,
        format: &str,
        bytes: &[u8],
    ) -> impl std::future::Future<Output = AgentResult<Value>> + Send;
}
impl SourceUtility for crate::source_extraction_worker::SourceExtractionWorker {
    async fn extraction_identity(&self) -> AgentResult<Option<String>> {
        Ok(Some(self.cache_identity()))
    }

    async fn request(
        &self,
        workspace_id: &str,
        request_id: &str,
        format: &str,
        bytes: &[u8],
    ) -> AgentResult<Value> {
        crate::source_extraction_worker::SourceExtractionWorker::request(
            self,
            workspace_id,
            request_id,
            format,
            bytes,
        )
        .await
    }
}
// Cache only outputs from a versioned extractor. Test/adaptor utilities without
// that identity retain their existing call behavior. Each request still plans,
// captures/verifies bytes, then reauthorizes before and after this lookup.
const EXTRACTION_ENTRIES: usize = 4;
const EXTRACTION_RESULT_BYTES: usize = 16 * 1024 * 1024;
static EXTRACTION_SLOTS: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| {
        std::sync::Arc::new(tokio::sync::Semaphore::new(EXTRACTION_ENTRIES))
    });
#[derive(Debug)]
pub(crate) struct FileExtractionData {
    value: Value,
    // The permit follows returned data, even after policy/generation invalidates
    // a cache entry while an authorized request is still using its result.
    _permit: Option<tokio::sync::OwnedSemaphorePermit>,
}
impl std::ops::Deref for FileExtractionData {
    type Target = Value;
    fn deref(&self) -> &Value {
        &self.value
    }
}
const EXTRACTION_IDLE: std::time::Duration = std::time::Duration::from_secs(60);
struct CachedExtraction {
    binding: WorkspaceBinding,
    plan: crate::source_file_snapshot::FileReadPlan,
    parser: String,
    result: tokio::sync::OnceCell<AgentResult<std::sync::Arc<FileExtractionData>>>,
}
static FILE_EXTRACTIONS: std::sync::LazyLock<
    std::sync::Mutex<
        std::collections::VecDeque<(std::time::Instant, std::sync::Arc<CachedExtraction>)>,
    >,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::VecDeque::new()));
pub(crate) fn clear_file_caches(binding: &WorkspaceBinding) {
    crate::source_file_snapshot::clear_binding(binding);
    if let Ok(mut entries) = FILE_EXTRACTIONS.lock() {
        entries.retain(|(_, entry)| &entry.binding != binding);
    }
}
fn invalidate_file_extractions(binding: &WorkspaceBinding, object: &ObjectRef) {
    crate::source_file_snapshot::invalidate_file_cache(binding, object);
    if let Ok(mut entries) = FILE_EXTRACTIONS.lock() {
        entries.retain(|(_, entry)| &entry.binding != binding || &entry.plan.object != object);
    }
}
fn extraction_slot(
    binding: &WorkspaceBinding,
    plan: &crate::source_file_snapshot::FileReadPlan,
    parser: String,
    active: Option<&crate::source_file_snapshot::FileByteSnapshot>,
) -> AgentResult<std::sync::Arc<CachedExtraction>> {
    let busy = || {
        AgentError::new(
            ErrorCode::RunBusy,
            "Source extraction cache is at its active byte or entry budget",
        )
    };
    let mut entries = FILE_EXTRACTIONS.lock().map_err(|_| busy())?;
    // clear_file_caches marks snapshots inactive before taking this cache lock.
    // Check under the same lock as insertion to prevent a late post-close fill.
    if active.is_some_and(|snapshot| !snapshot.cache_is_active()) {
        return Err(AgentError::new(
            ErrorCode::WorkspaceChanged,
            "Source extraction generation is no longer active",
        ));
    }
    let now = std::time::Instant::now();
    entries.retain(|(used, entry)| {
        (entry.binding.workspace_id != binding.workspace_id || entry.binding == *binding)
            && (now.duration_since(*used) < EXTRACTION_IDLE
                || std::sync::Arc::strong_count(entry) > 1)
    });
    if let Some(index) = entries.iter().position(|(_, entry)| {
        entry.binding == *binding && entry.plan == *plan && entry.parser == parser
    }) {
        let (_, entry) = entries.remove(index).unwrap();
        entries.push_back((now, entry.clone()));
        return Ok(entry);
    }
    if entries.len() == EXTRACTION_ENTRIES {
        let index = entries
            .iter()
            .position(|(_, entry)| {
                std::sync::Arc::strong_count(entry) == 1
                    && entry.result.get().is_none_or(|result| {
                        result
                            .as_ref()
                            .map_or(true, |data| std::sync::Arc::strong_count(data) == 1)
                    })
            })
            .ok_or_else(busy)?;
        entries.remove(index);
    }
    let entry = std::sync::Arc::new(CachedExtraction {
        binding: binding.clone(),
        plan: plan.clone(),
        parser,
        result: tokio::sync::OnceCell::new(),
    });
    entries.push_back((now, entry.clone()));
    Ok(entry)
}
async fn extracted_data<W: SourceUtility>(
    binding: &WorkspaceBinding,
    request_id: &str,
    plan: &crate::source_file_snapshot::FileReadPlan,
    bytes: &[u8],
    utility: &W,
    active: Option<&crate::source_file_snapshot::FileByteSnapshot>,
) -> AgentResult<std::sync::Arc<FileExtractionData>> {
    let Some(parser) = utility.extraction_identity().await? else {
        return utility
            .request(
                &plan.object.workspace_id,
                request_id,
                plan.format.worker_format(),
                bytes,
            )
            .await
            .map(|value| {
                std::sync::Arc::new(FileExtractionData {
                    value,
                    _permit: None,
                })
            });
    };
    let entry = extraction_slot(binding, plan, parser, active)?;
    // OnceCell releases initialization on cancellation. Errors are shared with
    // existing waiters, then removed so an explicit later request can retry.
    let result = entry
        .result
        .get_or_init(|| async {
            let permit = EXTRACTION_SLOTS.clone().try_acquire_owned().map_err(|_| {
                AgentError::new(
                    ErrorCode::RunBusy,
                    "Source extraction active result budget is full",
                )
            })?;
            let data = utility
                .request(
                    &plan.object.workspace_id,
                    request_id,
                    plan.format.worker_format(),
                    bytes,
                )
                .await?;
            if serde_json::to_vec(&data)
                .map_err(|_| {
                    AgentError::new(
                        ErrorCode::RuntimeIncompatible,
                        "Invalid extraction cache result",
                    )
                })?
                .len()
                > EXTRACTION_RESULT_BYTES
            {
                return Err(AgentError::new(
                    ErrorCode::BudgetExceeded,
                    "Source extraction exceeds its cache byte limit",
                ));
            }
            Ok(std::sync::Arc::new(FileExtractionData {
                value: data,
                _permit: Some(permit),
            }))
        })
        .await
        .clone();
    if result
        .as_ref()
        .map_or(true, |data| data["state"] == "failed")
    {
        if let Ok(mut entries) = FILE_EXTRACTIONS.lock() {
            entries.retain(|(_, current)| !std::sync::Arc::ptr_eq(current, &entry));
        }
    }
    result
}
#[cfg(test)]
mod extraction_cache_tests {
    use super::*;
    use crate::agent::models::{ObjectKind, Scope};
    use crate::source_file_snapshot::{FileReadPlan, FileSourceFormat};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    struct Counter {
        calls: AtomicUsize,
        identity: String,
        fail: std::sync::atomic::AtomicBool,
    }
    impl Counter {
        fn new(identity: String) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                identity,
                fail: std::sync::atomic::AtomicBool::new(false),
            }
        }
    }
    impl SourceUtility for Counter {
        async fn extraction_identity(&self) -> AgentResult<Option<String>> {
            Ok(Some(self.identity.clone()))
        }
        async fn request(&self, _: &str, _: &str, _: &str, bytes: &[u8]) -> AgentResult<Value> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            if self.fail.load(Ordering::SeqCst) {
                return Err(AgentError::new(ErrorCode::IoFailed, "worker failed"));
            }
            Ok(serde_json::json!({"state":"ready","text":String::from_utf8_lossy(bytes)}))
        }
    }
    fn fixture() -> (tempfile::TempDir, WorkspaceBinding, FileReadPlan, Counter) {
        use sha2::{Digest, Sha256};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.txt");
        std::fs::write(&path, b"evidence").unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "cache-workspace".into(),
            generation: dir.path().display().to_string(),
        };
        let plan = FileReadPlan {
            object: ObjectRef {
                workspace_id: binding.workspace_id.clone(),
                scope: Scope::Workspace,
                kind: ObjectKind::File,
                id: "42".into(),
            },
            file_version: 1,
            registered_hash: format!("sha256:{:x}", Sha256::digest(b"evidence")),
            title: "source.txt".into(),
            updated_at: "now".into(),
            path,
            format: FileSourceFormat::Text,
        };
        let counter = Counter::new(binding.generation.clone());
        (dir, binding, plan, counter)
    }
    #[tokio::test]
    async fn source_extraction_cache_shares_one_worker_for_one_hundred_pages_and_inflight_reads() {
        let _gate = crate::source_file_snapshot::CACHE_TEST_GATE.lock().await;
        let (_dir, binding, plan, utility) = fixture();
        let (a, b, c) = tokio::join!(
            extracted_data(&binding, "a", &plan, b"evidence", &utility, None),
            extracted_data(&binding, "b", &plan, b"evidence", &utility, None),
            extracted_data(&binding, "c", &plan, b"evidence", &utility, None)
        );
        let first = a.unwrap();
        assert!(Arc::ptr_eq(&first, &b.unwrap()));
        assert!(Arc::ptr_eq(&first, &c.unwrap()));
        for _ in 0..100 {
            let next = extracted_data(&binding, "page", &plan, b"evidence", &utility, None)
                .await
                .unwrap();
            assert!(Arc::ptr_eq(&first, &next));
        }
        assert_eq!(utility.calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn source_extraction_cache_keys_version_generation_parser_and_invalidation() {
        let _gate = crate::source_file_snapshot::CACHE_TEST_GATE.lock().await;
        let (_dir, binding, plan, utility) = fixture();
        drop(
            extracted_data(&binding, "a", &plan, b"evidence", &utility, None)
                .await
                .unwrap(),
        );
        let mut newer = plan.clone();
        newer.file_version += 1;
        drop(
            extracted_data(&binding, "v", &newer, b"evidence", &utility, None)
                .await
                .unwrap(),
        );
        let parser = Counter::new(format!("{}-new-parser", utility.identity));
        drop(
            extracted_data(&binding, "p", &plan, b"evidence", &parser, None)
                .await
                .unwrap(),
        );
        let mut reopened = binding.clone();
        reopened.generation.push_str("-reopened");
        drop(
            extracted_data(&reopened, "g", &plan, b"evidence", &utility, None)
                .await
                .unwrap(),
        );
        invalidate_file_extractions(&reopened, &plan.object);
        drop(
            extracted_data(&reopened, "r", &plan, b"evidence", &utility, None)
                .await
                .unwrap(),
        );
        assert_eq!(utility.calls.load(Ordering::SeqCst), 4);
        assert_eq!(parser.calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn source_extraction_cache_shares_failure_without_retaining_it_for_retry() {
        let _gate = crate::source_file_snapshot::CACHE_TEST_GATE.lock().await;
        let (_dir, binding, plan, utility) = fixture();
        utility.fail.store(true, Ordering::SeqCst);
        let (a, b) = tokio::join!(
            extracted_data(&binding, "a", &plan, b"evidence", &utility, None),
            extracted_data(&binding, "b", &plan, b"evidence", &utility, None)
        );
        assert_eq!(a.unwrap_err().code, ErrorCode::IoFailed);
        assert_eq!(b.unwrap_err().code, ErrorCode::IoFailed);
        assert_eq!(utility.calls.load(Ordering::SeqCst), 1);
        utility.fail.store(false, Ordering::SeqCst);
        assert_eq!(
            extracted_data(&binding, "retry", &plan, b"evidence", &utility, None)
                .await
                .unwrap()["state"],
            "ready"
        );
        assert_eq!(utility.calls.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn source_extraction_cache_close_does_not_refill_and_keeps_live_result_charged() {
        let _gate = crate::source_file_snapshot::CACHE_TEST_GATE.lock().await;
        struct Paused {
            started: tokio::sync::Notify,
            release: tokio::sync::Notify,
        }
        impl SourceUtility for Paused {
            async fn extraction_identity(&self) -> AgentResult<Option<String>> {
                Ok(Some("paused-parser".into()))
            }
            async fn request(&self, _: &str, _: &str, _: &str, _: &[u8]) -> AgentResult<Value> {
                self.started.notify_one();
                self.release.notified().await;
                Ok(serde_json::json!({"state":"ready","chunks":[]}))
            }
        }
        let (_dir, binding, plan, _) = fixture();
        let scope = crate::source_file_snapshot::file_read_scope(&binding).unwrap();
        let snapshot = crate::source_file_snapshot::capture_file_scoped(&scope, &plan)
            .await
            .unwrap();
        let utility = Paused {
            started: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        };
        let pending = extracted_data(
            &binding,
            "paused",
            &plan,
            &snapshot.bytes,
            &utility,
            Some(&snapshot),
        );
        tokio::pin!(pending);
        tokio::select! { _=utility.started.notified()=>{}, result=&mut pending=>panic!("worker did not pause: {result:?}") }
        let during = EXTRACTION_SLOTS.available_permits();
        clear_file_caches(&binding);
        assert_eq!(EXTRACTION_SLOTS.available_permits(), during);
        utility.release.notify_one();
        let result = pending.await.unwrap();
        assert!(FILE_EXTRACTIONS
            .lock()
            .unwrap()
            .iter()
            .all(|(_, entry)| entry.binding != binding));
        assert_eq!(EXTRACTION_SLOTS.available_permits(), during);
        assert_eq!(
            extracted_data(
                &binding,
                "late",
                &plan,
                &snapshot.bytes,
                &utility,
                Some(&snapshot)
            )
            .await
            .unwrap_err()
            .code,
            ErrorCode::WorkspaceChanged
        );
        drop(result);
        assert_eq!(EXTRACTION_SLOTS.available_permits(), during + 1);
    }
    #[tokio::test]
    async fn source_extraction_cache_eviction_and_idle_expiry_start_new_work() {
        let _gate = crate::source_file_snapshot::CACHE_TEST_GATE.lock().await;
        let (_dir, binding, plan, utility) = fixture();
        for i in 0..=EXTRACTION_ENTRIES {
            let mut target = plan.clone();
            target.file_version = i as u32 + 1;
            drop(
                extracted_data(&binding, "fill", &target, b"evidence", &utility, None)
                    .await
                    .unwrap(),
            );
        }
        drop(
            extracted_data(&binding, "evicted", &plan, b"evidence", &utility, None)
                .await
                .unwrap(),
        );
        assert_eq!(utility.calls.load(Ordering::SeqCst), EXTRACTION_ENTRIES + 2);
        {
            let mut entries = FILE_EXTRACTIONS.lock().unwrap();
            for (used, entry) in entries.iter_mut() {
                if entry.binding == binding {
                    *used -= EXTRACTION_IDLE;
                }
            }
        }
        drop(
            extracted_data(&binding, "expired", &plan, b"evidence", &utility, None)
                .await
                .unwrap(),
        );
        assert_eq!(utility.calls.load(Ordering::SeqCst), EXTRACTION_ENTRIES + 3);
    }
}
/// Internal extraction result, deliberately not a tool response: adapters must
/// paginate/budget the chunks before any model-facing response.
#[derive(Debug)]
pub(crate) struct SourceFileExtraction {
    pub object: ObjectRef,
    pub title: String,
    pub revision: String,
    pub file_version: u32,
    pub data: std::sync::Arc<FileExtractionData>,
    pub(super) plan: crate::source_file_snapshot::FileReadPlan,
    pub(super) snapshot: std::sync::Arc<crate::source_file_snapshot::FileByteSnapshot>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceReadTarget {
    pub object: ObjectRef,
    #[schemars(length(max = 128))]
    pub revision: Option<String>,
    pub record_version: Option<u32>,
    pub file_version: Option<u32>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SourceReadView {
    Full,
    Range,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceSelection {
    pub block_id: Option<String>,
    pub locator: Option<SourceLocator>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceReadInput {
    pub source: SourceReadTarget,
    pub view: SourceReadView,
    pub selection: Option<SourceSelection>,
    #[schemars(length(max = 2048))]
    pub cursor: Option<String>,
    #[schemars(range(min = 1, max = 12000))]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extraction: Option<crate::source_file_read::FileExtractionStatus>,
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
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceSearchInput {
    pub scope: Scope,
    #[schemars(
        length(min = 1, max = 256),
        regex(pattern = r"\S"),
        description = "Query containing non-whitespace characters, at most 256 characters including surrounding whitespace. Search trims surrounding whitespace and accepts at most 16 whitespace-separated terms."
    )]
    pub query: String,
    #[serde(default)]
    #[schemars(length(max = 7))]
    pub kinds: Vec<crate::agent::models::ObjectKind>,
    #[serde(default)]
    #[schemars(length(max = 50))]
    pub selected: Vec<ObjectRef>,
    #[serde(default)]
    pub include_history: bool,
    #[schemars(range(min = 1, max = 50))]
    pub limit: Option<usize>,
    #[schemars(range(min = 1, max = 12000))]
    pub budget_chars: Option<usize>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceSearchPage {
    pub items: Vec<crate::source_search_index::SearchCandidate>,
    pub has_more: bool,
    pub stale_count: usize,
    /// Non-Record results depend on extraction/index coverage, including on an empty page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coverage_note: Option<&'static str>,
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
struct TextSpan {
    start_byte: usize,
    end_byte: usize,
    start: usize,
    end: usize,
    block_id: String,
    paragraph: u32,
}
pub(crate) fn committed_paragraphs(document: &Value) -> AgentResult<Vec<String>> {
    let (text, spans) = flatten_record(document, None)?;
    Ok(spans
        .into_iter()
        .map(|span| text[span.start_byte..span.end_byte].to_owned())
        .collect())
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
    // Spans still identify the original nonempty leaf blocks, in DFS order.
    // Table punctuation belongs to the projection, never to a leaf's evidence.
    #[derive(Default)]
    struct Projection {
        text: String,
        spans: Vec<TextSpan>,
        chars: usize,
    }
    impl Projection {
        fn push(&mut self, text: &str) {
            self.text.push_str(text);
            self.chars += text.chars().count();
        }
        fn append(&mut self, mut other: Self) {
            for span in &mut other.spans {
                span.start_byte += self.text.len();
                span.end_byte += self.text.len();
                span.start += self.chars;
                span.end += self.chars;
            }
            self.push(&other.text);
            self.spans.extend(other.spans);
        }
    }
    struct Renderer<'a> {
        selected_block: Option<&'a str>,
        range: Option<&'a SourceLocator>,
        block_found: bool,
        paragraph: u32,
    }
    impl Renderer<'_> {
        fn selected(&self, node: &Value, ancestor_selected: bool) -> bool {
            self.selected_block.is_none()
                || ancestor_selected
                || node.pointer("/attrs/blockId").and_then(Value::as_str) == self.selected_block
        }
        fn render(&mut self, node: &Value, ancestor_selected: bool) -> Projection {
            let children = node.get("content").and_then(Value::as_array);
            let block = node.pointer("/attrs/blockId").and_then(Value::as_str);
            let selected = self.selected(node, ancestor_selected);
            self.block_found |= block.is_some() && block == self.selected_block;
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
                        Some("text") => body
                            .push_str(part.get("text").and_then(Value::as_str).unwrap_or_default()),
                        Some("hardBreak") => body.push('\n'),
                        Some("internalReference" | "contactMention" | "tagMention") => body
                            .push_str(
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
                let mut result = Projection::default();
                if !body.is_empty() {
                    self.paragraph += 1;
                    let in_range = match self.range {
                        Some(SourceLocator::Paragraph { start, end }) => {
                            (*start..=*end).contains(&self.paragraph)
                        }
                        _ => true,
                    };
                    if selected && in_range {
                        result.push(&body);
                        result.spans.push(TextSpan {
                            start_byte: 0,
                            end_byte: body.len(),
                            start: 0,
                            end: result.chars,
                            block_id: id.into(),
                            paragraph: self.paragraph,
                        });
                    }
                }
                return result;
            }
            let Some(children) = children else {
                return Projection::default();
            };
            // Narrow selections keep the existing leaf/ancestor selection
            // behavior: selecting a cell must not include neighboring cells.
            let table_selected = selected || children.iter().any(|row| self.selected(row, false));
            if node["type"] == "table" && self.range.is_none() && table_selected {
                return self.table(children, selected);
            }
            let mut result = Projection::default();
            for child in children {
                let part = self.render(child, selected);
                if !part.text.is_empty() {
                    if !result.text.is_empty() {
                        result.push("\n\n");
                    }
                    result.append(part);
                }
            }
            result
        }
        fn table(&mut self, rows: &[Value], ancestor_selected: bool) -> Projection {
            struct Cell {
                column: usize,
                colspan: usize,
                rowspan: usize,
                body: Projection,
            }
            let mut projected = vec![];
            // Only spanning cells occupy later rows. Keep intervals rather than
            // expanding a colspan/rowspan into a potentially huge dense grid.
            let mut occupied: Vec<(usize, usize, usize)> = vec![];
            let mut detailed = false;
            for (row_index, row) in rows.iter().enumerate() {
                let selected = self.selected(row, ancestor_selected);
                self.block_found |= row
                    .pointer("/attrs/blockId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| Some(id) == self.selected_block);
                occupied.retain(|&(_, _, until)| until > row_index);
                let mut column = 0;
                let mut cells = vec![];
                if let Some(content) = row.get("content").and_then(Value::as_array) {
                    for cell in content {
                        let span = |name| {
                            cell.get("attrs")
                                .and_then(|attrs| attrs.get(name))
                                .and_then(Value::as_u64)
                                .unwrap_or(1) as usize
                        };
                        let colspan = span("colspan");
                        let rowspan = span("rowspan");
                        while let Some(&(_, end, _)) = occupied
                            .iter()
                            .find(|&&(start, end, _)| start < column + colspan && column < end)
                        {
                            column = end;
                        }
                        let body = self.render(cell, selected);
                        detailed |= colspan > 1 || rowspan > 1 || body.text.contains(['\n', '|']);
                        if rowspan > 1 {
                            occupied.push((column, column + colspan, row_index + rowspan));
                        }
                        cells.push(Cell {
                            column,
                            colspan,
                            rowspan,
                            body,
                        });
                        column += colspan;
                    }
                }
                projected.push((selected, cells));
            }
            let mut result = Projection::default();
            for (row_index, (selected, cells)) in projected.into_iter().enumerate() {
                if !selected {
                    continue;
                }
                if !result.text.is_empty() {
                    result.push(if detailed { "\n\n" } else { "\n" });
                }
                if detailed {
                    // Markdown has no portable merged/multiline cell syntax.
                    // Explicit coordinates and fenced raw bodies preserve both
                    // relationships and exact evidence spans without guessing
                    // headers, duplicating merged values, or escaping evidence.
                    result.push(&format!("**Row {}**", row_index + 1));
                    for cell in cells {
                        let column = cell.column + 1;
                        let label = if cell.colspan > 1 {
                            format!("Columns {column}-{}", cell.column + cell.colspan)
                        } else {
                            format!("Column {column}")
                        };
                        result.push(&format!("\n\n{label}"));
                        if cell.colspan > 1 || cell.rowspan > 1 {
                            result.push(&format!(
                                " (colspan={}, rowspan={})",
                                cell.colspan, cell.rowspan
                            ));
                        }
                        // A body may itself contain code or a nested table.
                        let fence = "`".repeat(
                            cell.body
                                .text
                                .split(|c| c != '`')
                                .map(str::len)
                                .max()
                                .unwrap_or(0)
                                .max(2)
                                + 1,
                        );
                        result.push(&format!(":\n\n{fence}text\n"));
                        result.append(cell.body);
                        result.push(&format!("\n{fence}"));
                    }
                } else {
                    result.push("| ");
                    for (index, cell) in cells.into_iter().enumerate() {
                        if index > 0 {
                            result.push(" | ");
                        }
                        result.append(cell.body);
                    }
                    result.push(" |");
                    if row_index == 0
                        && rows[0]["content"].as_array().is_some_and(|cells| {
                            !cells.is_empty()
                                && cells.iter().all(|cell| cell["type"] == "tableHeader")
                        })
                    {
                        result.push("\n|");
                        for _ in rows[0]["content"].as_array().unwrap() {
                            result.push(" --- |");
                        }
                    }
                }
            }
            result
        }
    }
    let range = selection.and_then(|selection| selection.locator.as_ref());
    if let Some(locator) = range {
        if !matches!(locator, SourceLocator::Paragraph {start,end} if *start>0 && end>=start) {
            return Err(invalid("Record selection requires a valid paragraph range"));
        }
    }
    let selected_block = selection.and_then(|selection| selection.block_id.as_deref());
    let mut renderer = Renderer {
        selected_block,
        range,
        block_found: selected_block.is_none(),
        paragraph: 0,
    };
    let result = renderer.render(document, false);
    if !renderer.block_found
        || matches!(range,Some(SourceLocator::Paragraph {start,..}) if *start>renderer.paragraph)
    {
        return Err(AgentError::new(
            ErrorCode::NotFound,
            "Selected source range is no longer present",
        ));
    }
    if matches!(range,Some(SourceLocator::Paragraph {end,..}) if *end>renderer.paragraph) {
        return Err(invalid("Paragraph range exceeds this source"));
    }
    Ok((result.text, result.spans))
}

pub(crate) struct SourceService<'a, S> {
    pub(super) store: &'a S,
}
impl<'a, S: BoundSourceStore> SourceService<'a, S> {
    fn with_committed<T>(
        &self,
        request: &RequestContext,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        let (result, changes) = self.store.with_current(|binding, db| {
            crate::committed_changes::capture_committed(binding, db, &request.request_id, || {
                action(binding, db)
            })
        })?;
        if let Some(changes) = changes {
            self.store.publish_committed(changes);
        }
        result
    }

    pub(crate) fn new(store: &'a S) -> Self {
        Self { store }
    }
    pub(crate) fn backfill_index_queue(
        &self,
        request: &RequestContext,
        scope: &Scope,
        max_objects: usize,
    ) -> AgentResult<crate::db::source_index_queue::SourceBackfillProgress> {
        self.store.with_current(|binding, db| {
            db.source_queue_backfill(request, binding, scope, max_objects, chrono::Utc::now())
        })
    }
    pub(crate) fn sync_index_queue(
        &self,
        request: &RequestContext,
        scope: &Scope,
    ) -> AgentResult<crate::db::source_index_queue::SourceQueueProgress> {
        self.store.with_current(|binding, db| {
            db.source_queue_sync(request, binding, scope, chrono::Utc::now())
        })
    }
    /// Process one bounded job through the existing source services. Claims and
    /// settlement hold only short locks; conversion, hashing and paging do not.
    pub(crate) async fn index_next_queued<
        R: crate::record_document_service::DocumentUtility,
        F: SourceUtility,
    >(
        &self,
        request: &RequestContext,
        scope: &Scope,
        budget: SourceIndexBudget,
        record_utility: &R,
        file_utility: &F,
    ) -> AgentResult<Option<ObjectRef>> {
        if budget.max_chars == 0 || budget.max_chunks == 0 {
            return Err(invalid("Source index budgets must be positive"));
        }
        let lease = self.store.with_current(|binding, db| {
            db.source_queue_claim(request, binding, scope, chrono::Utc::now())
        })?;
        let Some(lease) = lease else {
            return Ok(None);
        };
        self.index_claimed(request, &lease, budget, record_utility, file_utility)
            .await?;
        Ok(Some(lease.object))
    }
    /// The host retains the lease while awaiting this future, so it can yield
    /// abandoned work without waiting for lease expiry or consuming a retry.
    pub(crate) async fn index_claimed<
        R: crate::record_document_service::DocumentUtility,
        F: SourceUtility,
    >(
        &self,
        request: &RequestContext,
        lease: &crate::db::source_index_queue::SourceIndexLease,
        budget: SourceIndexBudget,
        record_utility: &R,
        file_utility: &F,
    ) -> AgentResult<()> {
        use crate::{agent::models::ObjectKind, db::source_index_queue::SourceIndexOutcome};
        if budget.max_chars == 0 || budget.max_chunks == 0 {
            return Err(invalid("Source index budgets must be positive"));
        }
        let source = SourceReadTarget {
            object: lease.object.clone(),
            revision: None,
            record_version: None,
            file_version: None,
        };
        let result = async {
            match source.object.kind {
                ObjectKind::Record => {
                    self.prepare_record(request, &source, record_utility)
                        .await?;
                    self.index_record(request, &source, budget)
                }
                ObjectKind::File => {
                    self.index_file(request, &source, budget, file_utility)
                        .await
                }
                ObjectKind::QuickNote => {
                    self.index_quick_note(request, &source, budget, record_utility)
                        .await
                }
                ObjectKind::Project | ObjectKind::Todo | ObjectKind::Transcript => {
                    self.index_native(request, &source, budget)
                }
                _ => Err(AgentError::new(
                    ErrorCode::SourceNotReady,
                    "Queued source kind is not ready",
                )),
            }
        }
        .await;
        let outcome = match &result {
            Ok(_) => SourceIndexOutcome::Completed,
            Err(error)
                if matches!(
                    error.code,
                    ErrorCode::SourceChanged | ErrorCode::RunBusy | ErrorCode::RateLimited
                ) =>
            {
                SourceIndexOutcome::Retry
            }
            Err(error) => SourceIndexOutcome::Failed(error.code),
        };
        let settled = self.store.with_current(|binding, db| {
            db.source_queue_finish(request, binding, &lease, outcome, chrono::Utc::now())
        })?;
        result?;
        if !settled {
            return Err(AgentError::new(
                ErrorCode::SourceChanged,
                "Source index lease changed while processing",
            ));
        }
        Ok(())
    }
    pub(crate) async fn extract_file<W: SourceUtility>(
        &self,
        request: &RequestContext,
        source: &SourceReadTarget,
        utility: &W,
    ) -> AgentResult<SourceFileExtraction> {
        let (plan, scope) = self
            .store
            .with_current(|binding, db| {
                let plan = db.source_file_plan(request, binding, source)?;
                Ok((plan, crate::source_file_snapshot::file_read_scope(binding)?))
            })
            .map_err(|error| {
                invalidate_file_extractions(&request.binding, &source.object);
                error
            })?;
        let snapshot = crate::source_file_snapshot::capture_file_scoped(&scope, &plan)
            .await
            .map_err(|error| {
                invalidate_file_extractions(&request.binding, &source.object);
                error
            })?;
        self.verify_file_plan(request, source, &plan)?;
        let prepared = utility.prepared_extractor().await?;
        self.verify_file_plan(request, source, &plan)?;
        let data = if let Some(worker) = prepared.as_ref() {
            extracted_data(
                &request.binding,
                &request.request_id,
                &plan,
                &snapshot.bytes,
                worker,
                Some(&snapshot),
            )
            .await
        } else {
            extracted_data(
                &request.binding,
                &request.request_id,
                &plan,
                &snapshot.bytes,
                utility,
                Some(&snapshot),
            )
            .await
        };
        // Stop on revocation before inspecting the filesystem again. Utility
        // work and both byte checks run outside Workspace database locks.
        self.verify_file_plan(request, source, &plan)?;
        let data = data?;
        crate::source_file_snapshot::verify_file(&plan, &snapshot).await?;
        self.verify_file_plan(request, source, &plan)?;
        Ok(SourceFileExtraction {
            object: plan.object.clone(),
            title: plan.title.clone(),
            revision: snapshot.revision.clone(),
            file_version: plan.file_version,
            data,
            plan,
            snapshot,
        })
    }
    pub(super) async fn verify_file_extraction(
        &self,
        request: &RequestContext,
        source: &SourceReadTarget,
        extraction: &SourceFileExtraction,
    ) -> AgentResult<()> {
        self.verify_file_plan(request, source, &extraction.plan)?;
        crate::source_file_snapshot::verify_file(&extraction.plan, &extraction.snapshot).await?;
        self.verify_file_plan(request, source, &extraction.plan)
    }
    pub(crate) async fn verify_inventory_file(&self, request: &RequestContext, source: &SourceReadTarget,
        plan: &crate::source_file_snapshot::FileReadPlan, receipt: &crate::source_file_snapshot::FileVerification) -> AgentResult<()> {
        self.verify_file_plan(request,source,plan)?;
        crate::source_file_snapshot::verify_file_receipt(plan,receipt).await?;
        self.verify_file_plan(request,source,plan)
    }
    fn verify_file_plan(
        &self,
        request: &RequestContext,
        source: &SourceReadTarget,
        plan: &crate::source_file_snapshot::FileReadPlan,
    ) -> AgentResult<()> {
        let current = self
            .store
            .with_current(|binding, db| db.source_file_plan(request, binding, source));
        match current {
            Ok(current) if &current == plan => Ok(()),
            Ok(_) => {
                invalidate_file_extractions(&request.binding, &source.object);
                Err(changed())
            }
            // A previously registered current version becoming unready is a
            // change, never permission to publish the older extraction.
            Err(error) if error.code == ErrorCode::SourceNotReady => {
                invalidate_file_extractions(&request.binding, &source.object);
                Err(changed())
            }
            Err(error) => {
                invalidate_file_extractions(&request.binding, &source.object);
                Err(error)
            }
        }
    }
    pub(crate) async fn read_record<W: crate::record_document_service::DocumentUtility>(
        &self,
        request: &RequestContext,
        input: &SourceReadInput,
        utility: &W,
    ) -> AgentResult<SourceReadPage> {
        match self.read(request, input) {
            Err(error) if error.code == ErrorCode::SourceNotReady => {
                self.prepare_record(request, &input.source, utility).await?;
                self.read(request, input)
            }
            result => result,
        }
    }
    /// Maintenance of the existing committed body, not a content edit. The
    /// fixed converter runs outside business locks; a second authorized phase
    /// validates policy/binding and the original legacy hash before committing.
    pub(crate) async fn prepare_record<W: crate::record_document_service::DocumentUtility>(
        &self,
        request: &RequestContext,
        source: &SourceReadTarget,
        utility: &W,
    ) -> AgentResult<()> {
        let Some((target, legacy)) = self
            .store
            .with_current(|binding, db| db.source_record_baseline(request, binding, source))?
        else {
            return Ok(());
        };
        // A baseline belongs to one object, independently of a caller's batch
        // request. Concurrent conversion may generate different fresh IDs;
        // transaction head checks still commit exactly one baseline.
        let operation_id = format!("source-baseline-{:032x}", rand::random::<u128>());
        let data = serde_json::json!({
            "html":legacy.html,
            "assetBasePath":legacy.asset_base_path,
            "codeLanguage":legacy.code_language
        });
        let converted = utility
            .request(&operation_id, "record.initialize", data)
            .await?;
        let projection: crate::record_documents::RecordDocumentProjection =
            serde_json::from_value(converted).map_err(|_| {
                AgentError::new(
                    ErrorCode::RuntimeIncompatible,
                    "Invalid source baseline projection",
                )
            })?;
        projection.validate()?;
        self.with_committed(request, |binding, db| {
            if db
                .source_record_baseline(request, binding, source)?
                .is_none()
            {
                return Ok(());
            }
            if !(matches!(request.caller, crate::agent::access::Caller::Gui)
                && request.scope_grant.workspace_content)
            {
                for scope in db.record_reference_scopes(&projection.document)? {
                    request.authorize(binding, &scope, "source.read")?;
                }
            }
            db.record_document_initialize(
                &request.caller.key(),
                &operation_id,
                &target,
                &legacy.source_hash,
                &projection,
                &binding.workspace_id,
            )?;
            Ok(())
        })
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
    pub(crate) async fn search(
        &self,
        request: &RequestContext,
        input: &SourceSearchInput,
    ) -> AgentResult<SourceSearchPage> {
        use crate::agent::models::ObjectKind;
        let budget = input.budget_chars.unwrap_or(3000).min(12000);
        if budget == 0 {
            return Err(invalid("Source search budget must be positive"));
        }
        let limit = input.limit.unwrap_or(8);
        if !(1..=50).contains(&limit) { return Err(invalid("Invalid source search limit")); }
        let wants_summary = (input.kinds.is_empty() && request.scope_grant.operations.iter().any(|op| op == "session.read"))
            || input.kinds.contains(&ObjectKind::SessionSummary);
        let native_kinds: Vec<_> = input.kinds.iter().copied().filter(|kind| *kind != ObjectKind::SessionSummary).collect();
        let native_selected: Vec<_> = input.selected.iter().filter(|object| object.kind != ObjectKind::SessionSummary).cloned().collect();
        let wants_native = (input.kinds.is_empty() || !native_kinds.is_empty())
            && (input.selected.is_empty() || !native_selected.is_empty());
        let candidates = self.store.with_current(|binding, db| {
            request.authorize(binding, &input.scope, "source.read")?;
            for selected in &input.selected {
                if selected.workspace_id != binding.workspace_id || selected.scope != input.scope {
                    return Err(AgentError::new(ErrorCode::ScopeDenied, "Selected source is outside this search scope"));
                }
                selected.key()?;
            }
            let mut candidates = if wants_native {
                let mut native_input = input.clone();
                native_input.kinds = native_kinds;
                native_input.selected = native_selected;
                db.source_search_candidates(request, binding, &native_input)?
            } else {
                crate::source_search_index::SearchPage { items: vec![], has_more: false }
            };
            if wants_summary {
                let summary = crate::source_session_summary::search(db, request, binding, input)?;
                candidates.has_more |= summary.has_more;
                let native = std::mem::take(&mut candidates.items);
                let mut native = native.into_iter();
                let mut summary = summary.items.into_iter();
                loop {
                    match (native.next(), summary.next()) {
                        (None, None) => break,
                        (a, b) => { candidates.items.extend(a); candidates.items.extend(b); }
                    }
                }
            }
            if candidates.items.len() > limit { candidates.has_more = true; candidates.items.truncate(limit); }
            Ok(candidates)
        })?;
        let mut page = SourceSearchPage {
            items: vec![],
            has_more: false,
            stale_count: 0,
            coverage_note: (input.kinds.is_empty() || input.kinds.iter().any(|kind| *kind != ObjectKind::Record)).then_some("Current Records are searched from saved content. Other source kinds depend on available indexes; no matches does not prove their content is absent."),
        };
        let mut file_checks = vec![];
        for candidate in candidates.items {
            let source = SourceReadTarget {
                object: candidate.source_ref.object.clone(),
                revision: Some(candidate.source_ref.revision.clone()),
                record_version: candidate.source_ref.record_version,
                file_version: candidate.source_ref.file_version,
            };
            let verified = match source.object.kind {
                ObjectKind::Project
                | ObjectKind::Todo
                | ObjectKind::QuickNote
                | ObjectKind::Transcript => self.store.with_current(|binding, db| {
                    let snapshot = db.source_native_snapshot(request, binding, &source)?;
                    if candidate.title != snapshot.title.chars().take(1000).collect::<String>() {
                        return Err(changed());
                    }
                    Ok(None)
                }),
                ObjectKind::Record => self.store.with_current(|binding, db| {
                    let fingerprint = db.source_record_fingerprint(request, binding, &source)?;
                    if candidate.title != fingerprint.title.chars().take(1000).collect::<String>() {
                        return Err(changed());
                    }
                    Ok(None)
                }),
                ObjectKind::File => {
                    async {
                        let (plan, scope) = self.store.with_current(|binding, db| {
                            let plan = db.source_file_search_plan(
                                request,
                                binding,
                                &source,
                                input.include_history,
                                &candidate.title,
                            )?;
                            Ok((plan, crate::source_file_snapshot::file_read_scope(binding)?))
                        })?;
                        // Release the potentially 50 MiB byte buffer immediately;
                        // only the verified identity/stat receipt survives ranking.
                        let receipt = crate::source_file_snapshot::verification_scoped(&scope, &plan)
                            .await?;
                        let current = self.store.with_current(|binding, db| {
                            db.source_file_search_plan(
                                request,
                                binding,
                                &source,
                                input.include_history,
                                &candidate.title,
                            )
                        })?;
                        if current != plan {
                            return Err(changed());
                        }
                        Ok(Some((plan, receipt)))
                    }
                    .await
                }
                ObjectKind::SessionSummary => self.store.with_current(|binding, db| {
                    let node = db.agent_knowledge_get(&source.object.scope, &source.object.id, None)?
                        .ok_or_else(changed)?;
                    if node.revision.to_string() != source.revision.as_deref().unwrap_or_default() || candidate.title != node.title.chars().take(1000).collect::<String>()
                        || !crate::source_session_summary::visible(db, request, binding, &node)? { return Err(changed()); }
                    Ok(None)
                }),
                _ => continue,
            };
            match verified {
                Ok(file) => {
                    if let Some((plan, receipt)) = file {
                        file_checks.push((source, plan, receipt));
                    }
                    page.items.push(candidate);
                }
                Err(error)
                    if matches!(
                        error.code,
                        ErrorCode::SourceChanged | ErrorCode::SourceNotReady
                    ) =>
                {
                    page.stale_count += 1
                }
                Err(error)
                    if matches!(
                        error.code,
                        ErrorCode::ScopeDenied | ErrorCode::NotFound | ErrorCode::ObjectWithdrawn
                    ) =>
                {
                    ()
                }
                Err(error) => return Err(error),
            }
        }
        page.has_more = candidates.has_more && !page.items.is_empty();
        while crate::agent::context::serialized_chars(&page)? > budget {
            if page.items.pop().is_none() {
                return Err(AgentError::new(
                    ErrorCode::BudgetExceeded,
                    "Source search metadata does not fit this budget",
                ));
            }
            page.has_more = true;
        }
        // Recheck retained results after all async captures and budget trimming.
        // Revocation is checked before filesystem inspection and after it.
        for (source, plan, receipt) in file_checks {
            if !page.items.iter().any(|item| {
                item.source_ref.object == source.object
                    && item.source_ref.file_version == source.file_version
            }) {
                continue;
            }
            let current = self.store.with_current(|binding, db| {
                db.source_file_search_plan(
                    request,
                    binding,
                    &source,
                    input.include_history,
                    &plan.title.chars().take(1000).collect::<String>(),
                )
            })?;
            if current != plan {
                return Err(changed());
            }
            crate::source_file_snapshot::verify_file_receipt(&plan, &receipt).await?;
        }
        self.store.with_current(|binding, db| {
            db.source_verify_search_page(request, binding, input, &page)?;
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
        let policy = self.with_committed(request, |binding, db| {
            db.source_policy_update(request, binding, input)
        })?;
        if input.object.kind == crate::agent::models::ObjectKind::File {
            invalidate_file_extractions(&request.binding, &input.object);
        }
        Ok(policy)
    }
    pub(crate) fn read(
        &self,
        request: &RequestContext,
        input: &SourceReadInput,
    ) -> AgentResult<SourceReadPage> {
        if matches!(
            input.source.object.kind,
            crate::agent::models::ObjectKind::Project
                | crate::agent::models::ObjectKind::Todo
                | crate::agent::models::ObjectKind::Transcript
        ) {
            return self.read_native(request, input);
        }
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
        let cursor = crate::source_text_page::decode_cursor(input)?;
        let snapshot = self.store.with_current(|binding, db| {
            db.source_record_snapshot(request, binding, &input.source)
        })?;
        // Pure projection and paging stay outside current Workspace/DB locks.
        let (text, spans) = flatten_record(&snapshot.document, input.selection.as_ref())?;
        let spans: Vec<_> = spans
            .into_iter()
            .map(|span| crate::source_text_page::TextSpan {
                start: span.start,
                end: span.end,
                block_id: Some(span.block_id),
                locator: SourceLocator::Paragraph {
                    start: span.paragraph,
                    end: span.paragraph,
                },
            })
            .collect();
        let page = crate::source_text_page::paginate(
            input,
            SourceRef {
                object: snapshot.object,
                revision: snapshot.revision.clone(),
                title: snapshot.title,
                file_version: None,
                record_version: snapshot.record_version,
                block_id: None,
                locator: None,
                excerpt: String::new(),
            },
            &text,
            &spans,
            cursor,
            None,
        );
        self.store.with_current(|binding, db| {
            let current = db.source_record_fingerprint(request, binding, &input.source)?;
            if current.revision != snapshot.revision {
                return Err(changed());
            }
            page
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
        events: Mutex<Vec<crate::committed_changes::CommittedChanges>>,
    }
    impl crate::committed_changes::CommittedChangePublisher for Store {
        fn publish_committed(&self, changes: crate::committed_changes::CommittedChanges) {
            assert!(self.db.try_lock().is_ok());
            assert!(self.binding.try_lock().is_ok());
            self.events.lock().unwrap().push(changes);
        }
    }
    impl BoundSourceStore for Store {
        fn with_current<T>(
            &self,
            action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
        ) -> AgentResult<T> {
            action(&self.binding.lock().unwrap(), &self.db.lock().unwrap())
        }
    }
    fn add_legacy(store: &Store, input: &mut SourceReadInput, text: &str) -> RecordTarget {
        let record = store
            .db
            .lock()
            .unwrap()
            .workspace_record_upsert(WorkspaceRecordUpsertInput {
                note_id: None,
                title: Some("存量来源".into()),
                html: format!("<p>{text}</p>"),
                markdown: text.into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        input.source.object.id = record.id.to_string();
        RecordTarget {
            scope: Scope::Workspace,
            record_id: record.id,
        }
    }
    struct PausedConverter {
        worker: crate::record_document_worker::RecordDocumentWorker,
        converted: tokio::sync::Notify,
        resume: tokio::sync::Notify,
    }
    impl PausedConverter {
        fn new() -> Self {
            Self {
                worker: crate::record_document_worker::RecordDocumentWorker::development().unwrap(),
                converted: tokio::sync::Notify::new(),
                resume: tokio::sync::Notify::new(),
            }
        }
    }
    impl crate::record_document_service::DocumentUtility for PausedConverter {
        async fn request(&self, id: &str, method: &str, data: Value) -> AgentResult<Value> {
            let result = self.worker.request(id, method, data).await;
            self.converted.notify_one();
            self.resume.notified().await;
            result
        }
    }
    struct UnavailableConverter;
    impl crate::record_document_service::DocumentUtility for UnavailableConverter {
        async fn request(&self, _id: &str, _method: &str, _data: Value) -> AgentResult<Value> {
            Err(AgentError::new(
                ErrorCode::RuntimeUnavailable,
                "Converter resources unavailable",
            ))
        }
    }
    #[tokio::test]
    async fn source_project_reads_only_project_identity_and_preserves_reference_across_quick_note_edits(
    ) {
        use crate::models::{ProjectCreateInput, ProjectUpdateInput};
        let (_directory, store, mut request, mut input) = fixture("unrelated Record");
        let project = store
            .db
            .lock()
            .unwrap()
            .project_create(ProjectCreateInput {
                name: "项目来源".into(),
                summary: Some("PRIVATE QUICK NOTE".into()),
                status: Some("active".into()),
            })
            .unwrap();
        request.scope_grant.project_ids.push(project.id);
        input.source.object = ObjectRef {
            workspace_id: request.binding.workspace_id.clone(),
            scope: Scope::Project {
                project_id: project.id,
            },
            kind: ObjectKind::Project,
            id: project.id.to_string(),
        };
        input.budget_chars = None;
        let service = SourceService::new(&store);
        let first = service.read(&request, &input).unwrap();
        assert_eq!(first.source_ref.object, input.source.object);
        assert_eq!(first.source_ref.title, "项目来源");
        assert_eq!(first.text, "名称：项目来源\n\n状态：active\n\n归档：false");
        assert!(!first.text.contains("PRIVATE QUICK NOTE"));
        assert!(first.spans.iter().all(|span| span.block_id.is_none()));
        assert_eq!(first.source_ref.record_version, None);
        assert_eq!(first.source_ref.file_version, None);
        store
            .db
            .lock()
            .unwrap()
            .project_update(ProjectUpdateInput {
                project_id: project.id,
                name: None,
                summary: "Later buffer".into(),
                summary_markdown: Some("Later buffer".into()),
                summary_html: Some("<p>Later buffer</p>".into()),
                summary_code_language: None,
                status: None,
            })
            .unwrap();
        input.source.revision = Some(first.source_ref.revision.clone());
        let same = service.read(&request, &input).unwrap();
        assert_eq!(same.source_ref.revision, first.source_ref.revision);
        assert_eq!(same.text, first.text);
        store
            .db
            .lock()
            .unwrap()
            .project_update(ProjectUpdateInput {
                project_id: project.id,
                name: None,
                summary: "Later buffer".into(),
                summary_markdown: Some("Later buffer".into()),
                summary_html: Some("<p>Later buffer</p>".into()),
                summary_code_language: None,
                status: Some("done".into()),
            })
            .unwrap();
        assert_eq!(
            service.read(&request, &input).unwrap_err().code,
            ErrorCode::SourceChanged
        );
        input.source.revision = None;
        let current = service.read(&request, &input).unwrap();
        assert!(current.text.contains("状态：done"));
        assert_ne!(current.source_ref.revision, first.source_ref.revision);
    }
    #[tokio::test]
    async fn source_empty_record_is_discoverable_by_title_without_invented_block_evidence() {
        let (_directory, store, request, input) = fixture("initial");
        commit_document(
            &store,
            &input,
            json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"1234567890abcdef1234567890abcdef"}}]}),
            "",
        );
        let service = SourceService::new(&store);
        service
            .index_record(&request, &input.source, SourceIndexBudget::default())
            .unwrap();
        let found = service
            .search(
                &request,
                &SourceSearchInput {
                    scope: Scope::Workspace,
                    query: "分页验收".into(),
                    kinds: vec![],
                    selected: vec![],
                    include_history: false,
                    limit: None,
                    budget_chars: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(found.items.len(), 1);
        assert_eq!(found.items[0].source_ref.object, input.source.object);
        assert_eq!(found.items[0].coverage.chars, 0);
        assert!(found.items[0].coverage.complete);
        assert_eq!(found.items[0].excerpt, "");
        assert!(found.items[0].source_ref.block_id.is_none());
        assert!(found.items[0].source_ref.locator.is_none());
        let read = service.read(&request, &input).unwrap();
        assert_eq!(read.text, "");
        assert!(read.spans.is_empty());
        assert!(read.complete);
    }
    #[tokio::test]
    async fn source_legacy_record_denies_access_and_preserves_body_when_conversion_is_unavailable()
    {
        let (_directory, store, mut request, mut input) = fixture("unrelated");
        let target = add_legacy(&store, &mut input, "保留原正文");
        let service = SourceService::new(&store);
        request.scope_grant.workspace_content = false;
        assert_eq!(
            service
                .read_record(&request, &input, &UnavailableConverter)
                .await
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        request.scope_grant.workspace_content = true;
        input.budget_chars = Some(0);
        assert_eq!(
            service
                .read_record(&request, &input, &UnavailableConverter)
                .await
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        input.budget_chars = None;
        input.cursor = Some("malformed cursor".into());
        assert_eq!(
            service
                .read_record(&request, &input, &UnavailableConverter)
                .await
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        input.cursor = None;
        assert_eq!(
            service
                .read_record(&request, &input, &UnavailableConverter)
                .await
                .unwrap_err()
                .code,
            ErrorCode::RuntimeUnavailable
        );
        let db = store.db.lock().unwrap();
        assert!(db.record_document_head(&target).unwrap().is_none());
        assert_eq!(
            db.record_document_source(&target).unwrap().markdown,
            "保留原正文"
        );
    }
    #[tokio::test]
    #[ignore = "requires the prepared fixed Node runtime and built Record worker"]
    async fn source_legacy_record_rechecks_binding_policy_and_committed_content() {
        for scenario in ["switch", "exclude", "edit"] {
            let (_directory, store, request, mut input) = fixture("unrelated");
            let target = add_legacy(&store, &mut input, "旧的证据");
            let utility = PausedConverter::new();
            let service = SourceService::new(&store);
            let read = service.read_record(&request, &input, &utility);
            let intervene = async {
                utility.converted.notified().await;
                match scenario {
                    "switch" => store.binding.lock().unwrap().generation = "another-open".into(),
                    "exclude" => {
                        let mut policy_request = request.clone();
                        policy_request.request_id = "exclude-during-conversion".into();
                        policy_request
                            .scope_grant
                            .operations
                            .push("settings.write".into());
                        service
                            .set_policy(
                                &policy_request,
                                &SourcePolicyUpdate {
                                    object: input.source.object.clone(),
                                    expected_revision: 0,
                                    excluded: true,
                                },
                            )
                            .unwrap();
                    }
                    _ => {
                        store
                            .db
                            .lock()
                            .unwrap()
                            .workspace_record_upsert(WorkspaceRecordUpsertInput {
                                note_id: Some(target.record_id),
                                title: Some("并发标题".into()),
                                html: "<p>后来的证据</p>".into(),
                                markdown: "后来的证据".into(),
                                default_code_language: None,
                                tag_ids: vec![],
                            })
                            .unwrap();
                    }
                }
                utility.resume.notify_one();
            };
            let (result, _) = tokio::time::timeout(std::time::Duration::from_secs(20), async {
                tokio::join!(read, intervene)
            })
            .await
            .unwrap();
            let expected = match scenario {
                "switch" => ErrorCode::WorkspaceChanged,
                "exclude" => ErrorCode::ScopeDenied,
                _ => ErrorCode::RevisionConflict,
            };
            assert_eq!(result.unwrap_err().code, expected, "{scenario}");
            let db = store.db.lock().unwrap();
            assert!(db.record_document_head(&target).unwrap().is_none());
            assert_eq!(
                db.record_document_source(&target).unwrap().markdown,
                if scenario == "edit" {
                    "后来的证据"
                } else {
                    "旧的证据"
                }
            );
        }
    }
    #[tokio::test]
    #[ignore = "requires the prepared fixed Node runtime and built Record worker"]
    async fn source_legacy_record_concurrent_conversion_preserves_the_new_committed_head() {
        let (_directory, store, request, mut input) = fixture("unrelated");
        let target = add_legacy(&store, &mut input, "旧的证据");
        let utility = PausedConverter::new();
        let other = crate::record_document_worker::RecordDocumentWorker::development().unwrap();
        let service = SourceService::new(&store);
        let read = service.read_record(&request, &input, &utility);
        let intervene = async {
            utility.converted.notified().await;
            service
                .prepare_record(&request, &input.source, &other)
                .await
                .unwrap();
            let head = store
                .db
                .lock()
                .unwrap()
                .record_document_head(&target)
                .unwrap()
                .unwrap();
            let mut document = head.projection.document;
            document["content"][0]["content"][0]["text"] = json!("后来的已保存证据");
            commit_document(&store, &input, document, "后来的已保存证据");
            utility.resume.notify_one();
        };
        let (page, _) = tokio::time::timeout(std::time::Duration::from_secs(20), async {
            tokio::join!(read, intervene)
        })
        .await
        .unwrap();
        let page = page.unwrap();
        assert_eq!(page.text, "后来的已保存证据");
        let db = store.db.lock().unwrap();
        let head = db.record_document_head(&target).unwrap().unwrap();
        assert_eq!(head.head_revision, 2);
        assert_eq!(
            page.spans[0].block_id.as_deref(),
            head.projection.document["content"][0]["attrs"]["blockId"].as_str()
        );
        assert_eq!(
            db.record_versions_list(&target, None, 50)
                .unwrap()
                .versions
                .len(),
            1
        );
    }
    #[tokio::test]
    #[ignore = "requires the prepared fixed Node runtime and built Record worker"]
    async fn source_legacy_record_is_read_without_opening_an_editor() {
        let (_directory, store, mut request, mut input) = fixture("other committed Record");
        let legacy = store.db.lock().unwrap().workspace_record_upsert(WorkspaceRecordUpsertInput {
            note_id: None,
            title: Some("存量来源".into()),
            html: "<h2>真实标题</h2><p>原始证据🙂</p><pre><code class=\"language-rust\">let x = 7;</code></pre>".into(),
            markdown: "## 真实标题\n\n原始证据🙂\n\n```rust\nlet x = 7;\n```".into(),
            default_code_language: Some("rust".into()),
            tag_ids: vec![],
        }).unwrap();
        input.source.object.id = legacy.id.to_string();
        request.request_id = "read-legacy-baseline".into();
        let utility = crate::record_document_worker::RecordDocumentWorker::development().unwrap();
        let service = SourceService::new(&store);
        let page = service
            .read_record(&request, &input, &utility)
            .await
            .unwrap();
        assert_eq!(page.text, "真实标题\n\n原始证据🙂\n\nlet x = 7;");
        assert_eq!(page.source_ref.title, "存量来源");
        assert_eq!(page.spans.len(), 3);
        assert!(page
            .spans
            .iter()
            .all(|span| span.block_id.as_ref().is_some_and(|id| id.len() == 32)));
        assert!(page.complete);
        let first = serde_json::to_value(&page).unwrap();
        let repeated = service
            .read_record(&request, &input, &utility)
            .await
            .unwrap();
        assert_eq!(serde_json::to_value(repeated).unwrap(), first);
        let events = store.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].changed_refs, vec![input.source.object.clone()]);
        assert_eq!(events[0].record_heads[0].head_revision, Some(1));
        drop(events);
        service
            .index_record(&request, &input.source, SourceIndexBudget::default())
            .unwrap();
        let found = service
            .search(
                &request,
                &SourceSearchInput {
                    scope: Scope::Workspace,
                    query: "原始证据".into(),
                    kinds: vec![],
                    selected: vec![],
                    include_history: false,
                    limit: None,
                    budget_chars: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(found.items.len(), 1);
        assert_eq!(found.items[0].source_ref.revision, page.source_ref.revision);
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
                object_keys: None,
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
                events: Mutex::new(vec![]),
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
    // Dedicated Record table projection fixtures keep canonical leaf identities
    // stable across full reads, block selections, paragraph reads and indexing.
    fn record_table_block(id: u32, text: &str) -> Value {
        json!({"type":"paragraph","attrs":{"blockId":format!("{id:032x}")},
            "content":[{"type":"text","text":text}]})
    }
    fn record_table_fixture() -> Value {
        let cell = |id: u32, paragraph: u32, text: &str, header: bool| {
            json!({"type":if header {"tableHeader"} else {"tableCell"},
                "attrs":{"blockId":format!("{id:032x}"),"colspan":1,"rowspan":1},
                "content":[record_table_block(paragraph, text)]})
        };
        json!({"type":"doc","content":[record_table_block(1,"列车🚄发布排期"),
            {"type":"table","attrs":{"blockId":format!("{:032x}",10)},"content":[
                {"type":"tableRow","attrs":{"blockId":format!("{:032x}",11)},"content":[
                    cell(12,13,"版本",true),cell(14,15,"中国区发布日期",true),cell(16,17,"国际区发布日期",true)]},
                {"type":"tableRow","attrs":{"blockId":format!("{:032x}",20)},"content":[
                    cell(21,22,"5.1",false),cell(23,24,"2026-11-04",false),cell(25,26,"2026-11-11",false)]},
                {"type":"tableRow","attrs":{"blockId":format!("{:032x}",30)},"content":[
                    cell(31,32,"5.2",false),cell(33,34,"2026-12-02",false),cell(35,36,"待定",false)]}
            ]},record_table_block(40,"以上为计划日期")]})
    }
    fn assert_record_table_spans(document: &Value, text: &str, spans: &[TextSpan]) {
        let mut leaves = vec![];
        let mut stack = vec![document];
        while let Some(node) = stack.pop() {
            if node["type"] == "paragraph" {
                let mut body = String::new();
                for inline in node["content"].as_array().unwrap() {
                    if inline["type"] == "hardBreak" {
                        body.push('\n');
                    } else if let Some(text) = inline["text"].as_str() {
                        body.push_str(text);
                    }
                }
                if !body.is_empty() {
                    leaves.push((node["attrs"]["blockId"].as_str().unwrap(), body));
                }
            } else if let Some(children) = node["content"].as_array() {
                stack.extend(children.iter().rev());
            }
        }
        let characters: Vec<_> = text.chars().collect();
        assert_eq!(spans.len(), leaves.len());
        for (index, (span, (id, body))) in spans.iter().zip(&leaves).enumerate() {
            assert_eq!(span.block_id, *id);
            assert_eq!(span.paragraph, index as u32 + 1);
            assert_eq!(&text[span.start_byte..span.end_byte], body);
            assert_eq!(
                characters[span.start..span.end].iter().collect::<String>(),
                *body
            );
        }
        assert_eq!(
            committed_paragraphs(document).unwrap(),
            leaves.into_iter().map(|(_, body)| body).collect::<Vec<_>>()
        );
    }
    #[test]
    fn record_table_projection_keeps_release_rows_and_original_leaf_spans() {
        let document = record_table_fixture();
        let (text, spans) = flatten_record(&document, None).unwrap();
        assert_eq!(text, "列车🚄发布排期\n\n| 版本 | 中国区发布日期 | 国际区发布日期 |\n| --- | --- | --- |\n| 5.1 | 2026-11-04 | 2026-11-11 |\n| 5.2 | 2026-12-02 | 待定 |\n\n以上为计划日期");
        assert_record_table_spans(&document, &text, &spans);
    }
    #[test]
    fn record_table_projection_preserves_multiline_and_merged_cell_coordinates() {
        let mut document = record_table_fixture();
        let rows = document["content"][1]["content"].as_array_mut().unwrap();
        rows[0]["content"][1]["attrs"]["colspan"] = json!(2);
        rows[0]["content"].as_array_mut().unwrap().remove(2);
        rows[1]["content"][0]["attrs"]["rowspan"] = json!(2);
        rows[2]["content"].as_array_mut().unwrap().remove(0);
        rows[1]["content"][1]["content"][0]["content"] = json!([
            {"type":"text","text":"2026-11-04"},{"type":"hardBreak"},
            {"type":"text","text":"中国 | 灰度🚄"}]);
        rows[1]["content"][1]["content"]
            .as_array_mut()
            .unwrap()
            .push(record_table_block(27, "```text\n补充说明\n```"));
        let (text, spans) = flatten_record(&document, None).unwrap();
        assert!(text.contains("Columns 2-3 (colspan=2, rowspan=1)"));
        assert!(text.contains("Column 1 (colspan=1, rowspan=2)"));
        assert!(text.contains("2026-11-04\n中国 | 灰度🚄\n\n```text\n补充说明\n```"));
        assert!(text.contains("Column 2:\n\n````text\n2026-11-04"));
        let last_row = text.split("**Row 3**").nth(1).unwrap();
        assert!(last_row.starts_with("\n\nColumn 2:\n\n```text\n2026-12-02"));
        assert!(last_row.contains("Column 3:\n\n```text\n待定"));
        assert_record_table_spans(&document, &text, &spans);
        let (cell, spans) = flatten_record(
            &document,
            Some(&SourceSelection {
                block_id: Some(format!("{:032x}", 23)),
                locator: None,
            }),
        )
        .unwrap();
        assert_eq!(cell, "2026-11-04\n中国 | 灰度🚄\n\n```text\n补充说明\n```");
        assert_eq!(
            spans.iter().map(|span| span.paragraph).collect::<Vec<_>>(),
            vec![5, 6]
        );
        let (row, spans) = flatten_record(
            &document,
            Some(&SourceSelection {
                block_id: Some(format!("{:032x}", 30)),
                locator: None,
            }),
        )
        .unwrap();
        assert!(row.starts_with("**Row 3**\n\nColumn 2:"));
        assert!(!row.contains("5.1") && !row.contains("2026-11-04"));
        assert_eq!(spans.len(), 2);
    }
    #[test]
    fn record_table_projection_keeps_empty_cells_without_inventing_paragraphs() {
        let mut document = record_table_fixture();
        document["content"][1]["content"][1]["content"][1]["content"][0]["content"] = json!([]);
        let (text, spans) = flatten_record(&document, None).unwrap();
        assert!(text.contains("| 5.1 |  | 2026-11-11 |"));
        assert_record_table_spans(&document, &text, &spans);
    }
    #[tokio::test]
    async fn record_table_projection_read_selection_paging_and_index_keep_leaf_identity() {
        let (directory, store, request, mut input) = fixture("before");
        let document = record_table_fixture();
        let (expected, _) = flatten_record(&document, None).unwrap();
        commit_document(&store, &input, document.clone(), &expected);
        input.budget_chars = Some(12000);
        let service = SourceService::new(&store);
        let full = service.read(&request, &input).unwrap();
        assert_eq!(full.text, expected);
        assert_eq!(full.spans.len(), 11);
        input.view = SourceReadView::Range;
        for (id, expected, paragraphs) in [
            (10, "| 版本 | 中国区发布日期 | 国际区发布日期 |\n| --- | --- | --- |\n| 5.1 | 2026-11-04 | 2026-11-11 |\n| 5.2 | 2026-12-02 | 待定 |", vec![2,3,4,5,6,7,8,9,10]),
            (20, "| 5.1 | 2026-11-04 | 2026-11-11 |", vec![5,6,7]),
            (23, "2026-11-04", vec![6]),
            (24, "2026-11-04", vec![6]),
        ] {
            input.selection = Some(SourceSelection { block_id: Some(format!("{id:032x}")), locator: None });
            let page = service.read(&request, &input).unwrap();
            assert_eq!(page.text, expected);
            assert!(page.range_complete);
            assert!(!page.complete);
            assert_eq!(page.spans.iter().map(|span| match span.locator {
                SourceLocator::Paragraph { start, end } => {assert_eq!(start,end); start},
                _ => panic!("Record needs paragraph locators"),
            }).collect::<Vec<_>>(), paragraphs);
        }
        input.selection = Some(SourceSelection {
            block_id: Some(format!("{:032x}", 23)),
            locator: Some(SourceLocator::Paragraph { start: 7, end: 7 }),
        });
        assert!(service.read(&request, &input).unwrap().text.is_empty());
        input.selection = Some(SourceSelection {
            block_id: None,
            locator: Some(SourceLocator::Paragraph { start: 6, end: 7 }),
        });
        assert_eq!(
            service.read(&request, &input).unwrap().text,
            "2026-11-04\n\n2026-11-11"
        );
        input.selection = None;
        input.view = SourceReadView::Full;
        input.budget_chars = Some(1800);
        let mut paged = String::new();
        loop {
            let page = service.read(&request, &input).unwrap();
            let characters: Vec<_> = page.text.chars().collect();
            for span in &page.spans {
                assert!(span.start < span.end && span.end <= characters.len());
                let original = full
                    .spans
                    .iter()
                    .find(|original| original.block_id == span.block_id)
                    .unwrap();
                assert_eq!(
                    serde_json::to_value(&span.locator).unwrap(),
                    serde_json::to_value(&original.locator).unwrap()
                );
            }
            paged.push_str(&page.text);
            input.cursor = page.next_cursor;
            if input.cursor.is_none() {
                break;
            }
        }
        assert_eq!(paged, expected);
        service
            .index_record(&request, &input.source, SourceIndexBudget::default())
            .unwrap();
        let found = service
            .search(
                &request,
                &SourceSearchInput {
                    scope: Scope::Workspace,
                    query: "2026-11-04".into(),
                    kinds: vec![ObjectKind::Record],
                    selected: vec![],
                    include_history: false,
                    limit: None,
                    budget_chars: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(found.items.len(), 1);
        assert_eq!(found.items[0].source_ref.revision, full.source_ref.revision);
        assert!(found.items[0].source_ref.excerpt.contains("2026-11-04"));
        assert!(found.items[0].source_ref.block_id.is_none());
        assert!(found.items[0].source_ref.locator.is_none());
        // The retrieval cache still stores the original leaf identities; the
        // direct current-Record search above deliberately has no block locator.
        let connection =
            rusqlite::Connection::open(directory.path().join("source.sqlite")).unwrap();
        let (block, locator): (String, String) = connection
            .query_row(
                "SELECT block_id,locator_json FROM source_index_chunks WHERE text='2026-11-04'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(block, format!("{:032x}", 24));
        assert!(matches!(
            serde_json::from_str::<SourceLocator>(&locator).unwrap(),
            SourceLocator::Paragraph { start: 6, end: 6 }
        ));
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
        assert_eq!(store.events.lock().unwrap().len(), 1);
        assert_eq!(
            store.events.lock().unwrap()[0].changed_refs,
            vec![input.source.object.clone()]
        );
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
        assert_eq!(store.events.lock().unwrap().len(), 2);
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
        impl crate::committed_changes::CommittedChangePublisher for SwitchingStore {
            fn publish_committed(&self, changes: crate::committed_changes::CommittedChanges) {
                crate::committed_changes::CommittedChangePublisher::publish_committed(
                    &self.inner,
                    changes,
                );
            }
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
    #[tokio::test]
    async fn source_search_uses_current_body_and_rechecks_real_revision_before_returning_evidence(
    ) {
        let (_directory, store, request, input) = fixture("合同风险 evidence");
        let service = SourceService::new(&store);
        let query = SourceSearchInput {
            scope: Scope::Workspace,
            query: "合同风险".into(),
            kinds: vec![],
            selected: vec![],
            include_history: false,
            limit: None,
            budget_chars: None,
        };
        service
            .index_record(&request, &input.source, SourceIndexBudget::default())
            .unwrap();
        let page = service.search(&request, &query).await.unwrap();
        assert_eq!(page.items.len(), 1);
        // Search references the saved document; precise blocks come from a source read.
        assert!(page.items[0].source_ref.block_id.is_none());
        let read = service.read(&request, &input).unwrap();
        assert_eq!(page.items[0].source_ref.revision, read.source_ref.revision);
        assert!(crate::agent::context::serialized_chars(&page).unwrap() <= 3000);
        let document = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"1234567890abcdef1234567890abcdef"},"content":[{"type":"text","text":"新的证据 evidence"}]}]});
        commit_document(&store, &input, document, "新的证据 evidence");
        let stale = service.search(&request, &query).await.unwrap();
        assert!(stale.items.is_empty());
        assert_eq!(stale.stale_count, 0);
        service
            .index_record(&request, &input.source, SourceIndexBudget::default())
            .unwrap();
        assert_eq!(
            service.search(&request, &query).await.unwrap().stale_count,
            0
        );
        let fresh = service
            .search(
                &request,
                &SourceSearchInput {
                    query: "新的证据".into(),
                    ..query
                },
            )
            .await
            .unwrap();
        assert_eq!(fresh.items.len(), 1);
        assert_eq!(
            fresh.items[0].source_ref.revision,
            service.read(&request, &input).unwrap().source_ref.revision
        );
    }
    fn cached_record_search(store: &Store, request: &RequestContext, query: &str) -> crate::source_search_index::SearchPage {
        store.with_current(|binding, db| {
            db.source_cached_record_search_for_test(request, binding, query)
        }).unwrap()
    }
    #[tokio::test]
    async fn source_index_record_reports_partial_when_scope_batch_character_budget_is_reached() {
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
        let page = cached_record_search(&store, &request, "evidence");
        assert_eq!(page.items.len(), 1);
        assert!(!page.items[0].coverage.complete);
        assert_eq!(page.items[0].coverage.chars, 600);
    }
    #[tokio::test]
    async fn source_index_chunk_budget_keeps_unique_coverage_and_later_rebuild_becomes_complete() {
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
            kinds: vec![],
            selected: vec![],
            include_history: false,
            limit: None,
            budget_chars: None,
        };
        let partial = cached_record_search(&store, &request, &query.query);
        let current = service.search(&request, &query).await.unwrap();
        assert!(current.items[0].coverage.complete);
        assert_eq!(current.items[0].coverage.chars, body.chars().count() as u32);
        assert_eq!(partial.items.len(), 1);
        assert_eq!(partial.items[0].coverage.chars, 3400);
        assert!(!partial.items[0].coverage.complete);
        service
            .index_record(&request, &input.source, SourceIndexBudget::default())
            .unwrap();
        let complete = cached_record_search(&store, &request, &query.query);
        assert_eq!(complete.items.len(), 1);
        assert_eq!(complete.items[0].coverage.chars, 4009);
        assert!(complete.items[0].coverage.complete);
    }
    #[tokio::test]
    async fn source_cache_does_not_keep_deleted_record_body_or_history() {
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
                    kinds: vec![],
                    selected: vec![],
                    include_history: true,
                    limit: None,
                    budget_chars: None,
                },
            )
            .await
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
    #[tokio::test]
    async fn source_search_discards_candidates_if_workspace_switches_before_response() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct SwitchingStore {
            inner: Store,
            phase: AtomicUsize,
        }
        impl crate::committed_changes::CommittedChangePublisher for SwitchingStore {
            fn publish_committed(&self, changes: crate::committed_changes::CommittedChanges) {
                crate::committed_changes::CommittedChangePublisher::publish_committed(
                    &self.inner,
                    changes,
                );
            }
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
            kinds: vec![],
            selected: vec![],
            include_history: false,
            limit: None,
            budget_chars: None,
        };
        assert_eq!(
            SourceService::new(&store)
                .search(&request, &query)
                .await
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
    #[tokio::test]
    #[ignore = "requires the prepared fixed Node runtime and built source resources"]
    async fn source_queue_processes_legacy_baselines_through_real_shared_workers() {
        let (root, store, request, mut input) = fixture("existing source");
        let target = add_legacy(&store, &mut input, "后台队列建立的原始证据🙂");
        let converter = crate::record_document_worker::RecordDocumentWorker::development().unwrap();
        let extractor = crate::source_extraction_worker::SourceExtractionWorker::bundled(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"),
        )
        .unwrap();
        let service = SourceService::new(&store);
        let planned = service
            .backfill_index_queue(&request, &Scope::Workspace, 200)
            .unwrap();
        assert_eq!(planned.queued, 2);
        assert!(!planned.has_more);
        let page = service
            .sync_index_queue(&request, &Scope::Workspace)
            .unwrap();
        assert!(!page.has_more);
        assert!(!page.needs_backfill);
        let mut processed = vec![];
        for _ in 0..2 {
            processed.push(
                service
                    .index_next_queued(
                        &request,
                        &Scope::Workspace,
                        SourceIndexBudget::default(),
                        &converter,
                        &extractor,
                    )
                    .await
                    .unwrap()
                    .unwrap(),
            );
        }
        assert!(processed.contains(&input.source.object));
        assert!(service
            .index_next_queued(
                &request,
                &Scope::Workspace,
                SourceIndexBudget::default(),
                &converter,
                &extractor
            )
            .await
            .unwrap()
            .is_none());
        let found = service
            .search(
                &request,
                &SourceSearchInput {
                    scope: Scope::Workspace,
                    query: "后台队列".into(),
                    kinds: vec![crate::agent::models::ObjectKind::Record],
                    selected: vec![],
                    include_history: false,
                    limit: None,
                    budget_chars: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(found.items.len(), 1);
        assert_eq!(found.items[0].source_ref.object, input.source.object);
        let db = store.db.lock().unwrap();
        assert_eq!(
            db.record_version_capacity(&target).unwrap().version_count,
            1
        );
        let connection = rusqlite::Connection::open(root.path().join("source.sqlite")).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM agent_jobs WHERE state='completed'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            2
        );
    }
}
