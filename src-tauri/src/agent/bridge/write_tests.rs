//! Persistent connection writes through the same bridge dispatcher as the app.
use std::sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Arc, Mutex};
use serde_json::{json, Value};
use tokio::sync::{oneshot, Semaphore};

use super::{dispatch, protocol::CallInput};
use crate::{
    agent::{
        access::{Caller, RequestContext, ScopeGrant},
        connections::ConnectionCreateInput,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
        tools::BoundReadContextStore,
    },
    committed_changes::{CommittedChangePublisher, CommittedChanges},
    db::Database,
    models::ProjectCreateInput,
    record_document_service::{BoundRecordStore, DocumentUtility},
    record_documents::{body_hash, record_block_hash, RecordDocumentProjection, RecordTarget},
    source_service::{BoundSourceStore, SourcePolicyUpdate, SourceUtility},
    source_session_read::{SessionHistoryFragment, SessionHistoryUtility},
};

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const GRANT: &str = "0123456789abcdef0123456789abcdef";
const READ_ONLY: &str = "11111111111111111111111111111111";
const OTHER: &str = "22222222222222222222222222222222";
const BLOCK: &str = "33333333333333333333333333333333";

fn document(text: &str) -> Value {
    json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":BLOCK},"content":[{"type":"text","text":text}]}]})
}
fn projection(document: Value) -> RecordDocumentProjection {
    let text = document["content"][0]["content"][0]["text"].as_str().unwrap_or("").to_owned();
    RecordDocumentProjection {
        schema_version: 1, body_hash: body_hash(&document, &None), document,
        html: format!("<p>{text}</p>"), markdown: text.clone(), text, code_language: None,
    }
}
struct Store {
    binding: Mutex<WorkspaceBinding>,
    db: Mutex<Database>,
    published: AtomicUsize,
    editor_busy: AtomicBool,
}
impl CommittedChangePublisher for Store {
    fn publish_committed(&self, _: CommittedChanges) {
        assert!(self.db.try_lock().is_ok(), "publish after releasing DB");
        self.published.fetch_add(1, Ordering::SeqCst);
    }
}
impl BoundReadContextStore for Store {
    fn with_current_context<T>(&self, action: impl FnOnce(&WorkspaceBinding, &Database, &str) -> AgentResult<T>) -> AgentResult<T> {
        let binding = self.binding.lock().unwrap();
        let db = self.db.lock().unwrap();
        action(&binding, &db, "Write Fixture")
    }
}
impl BoundSourceStore for Store {
    fn with_current<T>(&self, action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>) -> AgentResult<T> {
        self.with_current_context(|binding, db, _| action(binding, db))
    }
}
impl BoundRecordStore for Store {
    async fn flush_editors(&self, _: &WorkspaceBinding, _: &RecordTarget) -> AgentResult<()> {
        if self.editor_busy.load(Ordering::SeqCst) {
            return Err(AgentError::new(ErrorCode::EditorBusy, "Editor is busy"));
        }
        Ok(())
    }
    async fn submission_lock(&self, _: &WorkspaceBinding, _: &RecordTarget) -> AgentResult<Option<tokio::sync::OwnedMutexGuard<()>>> { Ok(None) }
    fn with_current<T>(&self, action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>) -> AgentResult<T> {
        BoundSourceStore::with_current(self, action)
    }
}
struct DocumentWorker {
    entered: Mutex<Option<oneshot::Sender<()>>>,
    resume: Semaphore,
}
impl DocumentWorker {
    fn ready() -> Self { Self { entered: Mutex::new(None), resume: Semaphore::new(1) } }
    fn paused() -> (Self, oneshot::Receiver<()>) {
        let (send, receive) = oneshot::channel();
        (Self { entered: Mutex::new(Some(send)), resume: Semaphore::new(0) }, receive)
    }
}
impl DocumentUtility for DocumentWorker {
    async fn request(&self, _: &str, method: &str, data: Value) -> AgentResult<Value> {
        if let Some(entered) = self.entered.lock().unwrap().take() { let _ = entered.send(()); }
        let _permit = self.resume.acquire().await.unwrap();
        let mut doc = data["document"].clone();
        if method == "record.patch" {
            let suffix = data["operations"][0]["text"].as_str().expect("append_inline text");
            let text = doc["content"][0]["content"][0]["text"].as_str().unwrap().to_owned() + suffix;
            doc["content"][0]["content"][0]["text"] = json!(text);
        }
        let mut result = serde_json::to_value(projection(doc)).unwrap();
        if method == "record.patch" {
            result["patch"] = json!({"createdBlockIds":[],"deletedBlockIds":[],"normalizations":[],"noChange":false});
        }
        Ok(result)
    }
}
struct Unused;
impl SourceUtility for Unused {
    async fn request(&self, _: &str, _: &str, _: &str, _: &[u8]) -> AgentResult<Value> { panic!("No source extraction") }
}
impl SessionHistoryUtility for Unused {
    async fn read(&self, _: &WorkspaceBinding, _: &crate::db::agent_session_model_search::SourceReadRecord, _: Option<&str>, _: u32) -> AgentResult<SessionHistoryFragment> { panic!("No history read") }
}
struct Fixture {
    _root: tempfile::TempDir,
    store: Arc<Store>,
    enabled: AtomicBool,
    binding: WorkspaceBinding,
    project_id: i64,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("app.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("write-workspace").unwrap();
        let project = db.project_create(ProjectCreateInput { name: "Granted".into(), summary: None, status: None }).unwrap();
        let binding = WorkspaceBinding { workspace_id: "write-workspace".into(), generation: "open-1".into() };
        for (id, writes) in [
            (GRANT, vec!["content.create", "record.patch", "record.restore", "operation.undo"]),
            (READ_ONLY, vec![]),
            (OTHER, vec!["content.create", "record.patch", "record.restore", "operation.undo"]),
        ] {
            db.agent_connection_create(&binding, &ConnectionCreateInput {
                client_label: id.into(), workspace_content: false, project_ids: vec![project.id],
                session_read: false, write_operations: writes.into_iter().map(str::to_owned).collect(),
            }, id, TOKEN).unwrap();
        }
        Self { _root: root, store: Arc::new(Store { binding: Mutex::new(binding.clone()), db: Mutex::new(db), published: AtomicUsize::new(0), editor_busy: AtomicBool::new(false) }), enabled: AtomicBool::new(true), binding, project_id: project.id }
    }
    fn scope(&self) -> Scope { Scope::Project { project_id: self.project_id } }
    fn create_input(&self, request_id: &str, title: &str) -> Value {
        json!({"requestId":request_id,"input":{"scope":self.scope(),"title":title,"tagIds":[],"document":document("Alpha"),"codeLanguage":null}})
    }
    async fn call<W: DocumentUtility>(&self, grant: &str, id: &str, method: &str, params: Value, worker: &W) -> AgentResult<Value> {
        dispatch::execute(&*self.store, &self.enabled, TOKEN, CallInput {
            instance_id: "fixture".into(), grant_id: grant.into(), request_id: id.into(),
            binding: self.binding.clone(), method: method.into(), params,
        }, worker, &Unused, &Unused).await
    }
    fn object(&self, created: &Value) -> ObjectRef {
        ObjectRef { workspace_id: self.binding.workspace_id.clone(), scope: self.scope(), kind: ObjectKind::Record, id: created["result"]["target"]["recordId"].as_i64().unwrap().to_string() }
    }
}

#[tokio::test]
#[ignore = "requires the prepared native RecordDocumentWorker runtime"]
async fn prepared_document_worker_roundtrip_preserves_canonical_history() {
    let f = Fixture::new();
    let worker = crate::record_document_worker::RecordDocumentWorker::development().unwrap();
    let input = f.create_input("worker-create", "Worker Record");
    let created = f.call(GRANT, "worker-create", "record.create", input.clone(), &worker).await.unwrap();
    let object = f.object(&created);
    let target = RecordTarget { scope: f.scope(), record_id: object.id.parse().unwrap() };
    let before = f.store.db.lock().unwrap().record_document_head(&target).unwrap().unwrap();
    assert_eq!(before.head_revision, 1);
    let block = &before.projection.document["content"][0];
    let block_id = block["attrs"]["blockId"].as_str().unwrap();
    let block_hash = record_block_hash(block).unwrap();
    let patch = json!({"record":object,"baseRevision":before.head_revision,"requestId":"worker-patch","operations":[{"op":"append_inline","blockId":block_id,"expectedBlockHash":block_hash,"text":" beta"}]});
    let patched = f.call(GRANT, "worker-patch", "record.patch", patch.clone(), &worker).await.unwrap();
    assert_eq!(patched["result"]["afterRevision"], 2);
    let changed = f.store.db.lock().unwrap().record_document_head(&target).unwrap().unwrap();
    assert_ne!(changed.projection.body_hash, before.projection.body_hash);
    assert!(changed.projection.text.contains("Alpha beta"));
    let patch_operation = patched["operation"]["operationId"].as_str().unwrap().to_owned();
    assert_eq!(f.call(GRANT, "worker-patch", "record.patch", patch, &worker).await.unwrap(), patched);
    let undo_input = json!({"requestId":"worker-undo","input":{"operationId":patch_operation,"expectedHeadRevision":2}});
    let undone = f.call(GRANT, "worker-undo", "operation.undo", undo_input.clone(), &worker).await.unwrap();
    assert_eq!(undone["result"]["head"]["headRevision"], 3);
    assert_eq!(f.call(GRANT, "worker-undo", "operation.undo", undo_input, &worker).await.unwrap(), undone);
    let after = f.store.db.lock().unwrap().record_document_head(&target).unwrap().unwrap();
    assert_eq!(after.projection.document, before.projection.document);
    assert_eq!(after.projection.body_hash, before.projection.body_hash);
    assert_eq!(f.store.db.lock().unwrap().record_versions_list(&target, None, 10).unwrap().versions.len(), 3);
    assert_eq!(created["operation"]["requestId"], "worker-create");
    assert_eq!(undone["operation"]["requestId"], "worker-undo");
}

#[tokio::test]
async fn create_patch_undo_replay_and_receipt_isolation() {
    let f = Fixture::new();
    let worker = DocumentWorker::ready();
    let input = f.create_input("create-1", "Created");
    let created = f.call(GRANT, "create-1", "record.create", input.clone(), &worker).await.unwrap();
    assert_eq!(created["result"]["headRevision"], 1);
    let create_op = created["operation"]["operationId"].as_str().unwrap().to_owned();
    let after_create_events = f.store.published.load(Ordering::SeqCst);
    assert_eq!(f.call(GRANT, "create-1", "record.create", input.clone(), &worker).await.unwrap(), created);
    assert_eq!(f.store.published.load(Ordering::SeqCst), after_create_events);
    let mut changed = input.clone(); changed["input"]["title"] = json!("Different");
    assert_eq!(f.call(GRANT, "create-1", "record.create", changed, &worker).await.unwrap_err().code, ErrorCode::IdempotencyConflict);
    let object = f.object(&created);
    assert_eq!(f.call(OTHER, "other-receipt", "operation.get", json!({"operationId":create_op}), &worker).await.unwrap_err().code, ErrorCode::ScopeDenied);
    let found = f.call(GRANT, "own-receipt", "operation.get", json!({"operationId":create_op}), &worker).await.unwrap();
    assert_eq!(found["requestId"], "create-1");
    assert_eq!(f.call(READ_ONLY, "readonly", "record.create", f.create_input("readonly", "Denied"), &worker).await.unwrap_err().code, ErrorCode::ScopeDenied);

    let block_hash = record_block_hash(&document("Alpha")["content"][0]).unwrap();
    let patch = json!({"record":object.clone(),"baseRevision":1,"requestId":"patch-1","operations":[{"op":"append_inline","blockId":BLOCK,"expectedBlockHash":block_hash,"text":" beta"}]});
    let patched = f.call(GRANT, "patch-1", "record.patch", patch.clone(), &worker).await.unwrap();
    assert_eq!(patched["result"]["afterRevision"], 2);
    let patch_op = patched["operation"]["operationId"].as_str().unwrap().to_owned();
    assert_eq!(f.call(GRANT, "patch-1", "record.patch", patch, &worker).await.unwrap(), patched);
    let undone = f.call(GRANT, "undo-1", "operation.undo", json!({"requestId":"undo-1","input":{"operationId":patch_op,"expectedHeadRevision":2}}), &worker).await.unwrap();
    assert_eq!(undone["result"]["head"]["headRevision"], 3);
    let target = RecordTarget { scope: f.scope(), record_id: object.id.parse().unwrap() };
    let head = f.store.db.lock().unwrap().record_document_head(&target).unwrap().unwrap();
    assert_eq!(head.projection.document, document("Alpha"));
    assert_eq!(f.store.db.lock().unwrap().record_versions_list(&target, None, 10).unwrap().versions.len(), 3);
}

#[tokio::test]
async fn created_record_withdrawal_and_restore_keep_immutable_body() {
    let f = Fixture::new(); let worker = DocumentWorker::ready();
    let created = f.call(GRANT, "create-withdraw", "record.create", f.create_input("create-withdraw", "Temporary"), &worker).await.unwrap();
    let operation = created["operation"]["operationId"].as_str().unwrap();
    let object = f.object(&created);
    let target = RecordTarget { scope: f.scope(), record_id: object.id.parse().unwrap() };
    let withdrawn = f.call(GRANT, "withdraw", "operation.undo", json!({"requestId":"withdraw","input":{"operationId":operation,"expectedHeadRevision":1}}), &worker).await.unwrap();
    assert_eq!(withdrawn["result"]["withdrawn"], true);
    assert_eq!(f.store.db.lock().unwrap().record_document_head(&target).unwrap_err().code, ErrorCode::ObjectWithdrawn);
    let revision = withdrawn["result"]["revision"].as_u64().unwrap();
    let restored = f.call(GRANT, "restore", "operation.restore_created", json!({"requestId":"restore","input":{"creationOperationId":operation,"expectedWithdrawalRevision":revision}}), &worker).await.unwrap();
    assert_eq!(restored["result"]["withdrawn"], false);
    assert_eq!(f.store.db.lock().unwrap().record_document_head(&target).unwrap().unwrap().projection.document, document("Alpha"));
    assert_eq!(f.store.db.lock().unwrap().record_versions_list(&target, None, 10).unwrap().versions.len(), 1);
}

#[tokio::test]
async fn paused_conversion_rechecks_revocation_before_commit() {
    let f = Fixture::new();
    let (worker, entered) = DocumentWorker::paused();
    let write = f.call(GRANT, "paused-create", "record.create", f.create_input("paused-create", "Not saved"), &worker);
    let revoke = async {
        entered.await.unwrap();
        f.store.db.lock().unwrap().agent_connection_revoke(&f.binding, GRANT).unwrap();
        worker.resume.add_permits(1);
    };
    let (result, _) = tokio::join!(write, revoke);
    assert_eq!(result.unwrap_err().code, ErrorCode::ScopeDenied);
    assert_eq!(f.store.published.load(Ordering::SeqCst), 0);
    assert!(f.store.db.lock().unwrap().project_page_get(crate::models::ProjectIdInput { project_id: f.project_id }).unwrap().records.is_empty());
}

#[tokio::test]
async fn policy_and_editor_busy_reject_patch_without_commit() {
    let f = Fixture::new(); let worker = DocumentWorker::ready();
    let created = f.call(GRANT, "base", "record.create", f.create_input("base", "Base"), &worker).await.unwrap();
    let object = f.object(&created);
    let block_hash = record_block_hash(&document("Alpha")["content"][0]).unwrap();
    let patch = |id| json!({"record":object.clone(),"baseRevision":1,"requestId":id,"operations":[{"op":"append_inline","blockId":BLOCK,"expectedBlockHash":block_hash.clone(),"text":" beta"}]});
    f.store.editor_busy.store(true, Ordering::SeqCst);
    assert_eq!(f.call(GRANT, "busy", "record.patch", patch("busy"), &worker).await.unwrap_err().code, ErrorCode::EditorBusy);
    f.store.editor_busy.store(false, Ordering::SeqCst);
    let gui = RequestContext { binding: f.binding.clone(), caller: Caller::Gui, request_id: "exclude".into(), scope_grant: ScopeGrant { workspace_id: f.binding.workspace_id.clone(), workspace_content: false, project_ids: vec![f.project_id], operations: vec!["settings.write".into(), "source.read".into()] } };
    f.store.db.lock().unwrap().source_policy_update(&gui, &f.binding, &SourcePolicyUpdate { object: object.clone(), expected_revision: 0, excluded: true }).unwrap();
    assert_eq!(f.call(GRANT, "excluded", "record.patch", patch("excluded"), &worker).await.unwrap_err().code, ErrorCode::ScopeDenied);
    let target = RecordTarget { scope: f.scope(), record_id: object.id.parse().unwrap() };
    assert_eq!(f.store.db.lock().unwrap().record_document_head(&target).unwrap().unwrap().head_revision, 1);
}
