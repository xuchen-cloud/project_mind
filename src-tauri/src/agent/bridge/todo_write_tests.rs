//! Direct Todo mutations through a persistent connection and native Workspace DB.
use std::sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Arc, Mutex};
use serde_json::{json, Value};

use super::{dispatch, protocol::CallInput};
use crate::{
    agent::{
        connections::ConnectionCreateInput,
        errors::{AgentResult, ErrorCode},
        models::{ObjectRef, Scope, WorkspaceBinding},
        tools::BoundReadContextStore,
    },
    committed_changes::{CommittedChangePublisher, CommittedChanges},
    db::Database,
    models::{ProjectCreateInput, TodoUpdateContentInput},
    record_document_service::{BoundRecordStore, DocumentUtility},
    record_documents::RecordTarget,
    source_service::{BoundSourceStore, SourceUtility},
    source_session_read::{SessionHistoryFragment, SessionHistoryUtility},
};

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const GRANT: &str = "0123456789abcdef0123456789abcdef";
const READ_ONLY: &str = "11111111111111111111111111111111";
const OTHER: &str = "22222222222222222222222222222222";

struct Store {
    binding: Mutex<WorkspaceBinding>,
    db: Mutex<Database>,
    published: AtomicUsize,
}
impl CommittedChangePublisher for Store {
    fn publish_committed(&self, _: CommittedChanges) {
        assert!(self.db.try_lock().is_ok(), "publish after the DB phase");
        self.published.fetch_add(1, Ordering::SeqCst);
    }
}
impl BoundReadContextStore for Store {
    fn with_current_context<T>(&self, action: impl FnOnce(&WorkspaceBinding, &Database, &str) -> AgentResult<T>) -> AgentResult<T> {
        let binding = self.binding.lock().unwrap();
        let db = self.db.lock().unwrap();
        action(&binding, &db, "Todo Bridge Fixture")
    }
}
impl BoundSourceStore for Store {
    fn with_current<T>(&self, action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>) -> AgentResult<T> {
        self.with_current_context(|binding, db, _| action(binding, db))
    }
}
impl BoundRecordStore for Store {
    async fn flush_editors(&self, _: &WorkspaceBinding, _: &RecordTarget) -> AgentResult<()> { Ok(()) }
    async fn submission_lock(&self, _: &WorkspaceBinding, _: &RecordTarget) -> AgentResult<Option<tokio::sync::OwnedMutexGuard<()>>> { Ok(None) }
    fn with_current<T>(&self, action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>) -> AgentResult<T> {
        BoundSourceStore::with_current(self, action)
    }
}
struct Unused;
impl DocumentUtility for Unused {
    async fn request(&self, _: &str, _: &str, _: Value) -> AgentResult<Value> { panic!("Todo writes do not invoke document conversion") }
}
impl SourceUtility for Unused {
    async fn request(&self, _: &str, _: &str, _: &str, _: &[u8]) -> AgentResult<Value> { panic!("Todo writes do not extract sources") }
}
impl SessionHistoryUtility for Unused {
    async fn read(&self, _: &WorkspaceBinding, _: &crate::db::agent_session_model_search::SourceReadRecord, _: Option<&str>, _: u32) -> AgentResult<SessionHistoryFragment> { panic!("Todo writes do not read history") }
}
struct Fixture {
    _root: tempfile::TempDir,
    store: Store,
    enabled: Arc<AtomicBool>,
    binding: WorkspaceBinding,
    project_id: i64,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("todos.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("todo-bridge-workspace").unwrap();
        let project = db.project_create(ProjectCreateInput { name: "Granted".into(), summary: None, status: None }).unwrap();
        let binding = WorkspaceBinding { workspace_id: "todo-bridge-workspace".into(), generation: "open-1".into() };
        for (id, writes) in [
            (GRANT, vec!["content.create", "todo.update", "operation.undo"]),
            (READ_ONLY, vec![]),
            (OTHER, vec!["content.create", "todo.update", "operation.undo"]),
        ] {
            db.agent_connection_create(&binding, &ConnectionCreateInput {
                all_projects: false,
                client_label: id.into(), workspace_content: false, project_ids: vec![project.id],
                write_operations: writes.into_iter().map(str::to_owned).collect(),
            }, id, TOKEN).unwrap();
        }
        Self { _root: root, store: Store { binding: Mutex::new(binding.clone()), db: Mutex::new(db), published: AtomicUsize::new(0) }, enabled: Arc::new(AtomicBool::new(true)), binding, project_id: project.id }
    }
    fn scope(&self) -> Scope { Scope::Project { project_id: self.project_id } }
    fn create_input(&self, id: &str) -> Value {
        json!({"requestId":id,"input":{"scope":self.scope(),"content":"Plan delivery","priority":"urgent_important","dueDate":null,"tagIds":[],"children":[{"content":"Check evidence","progressDate":"2026-10-08","dueDate":null}]}})
    }
    async fn call(&self, grant: &str, id: &str, method: &str, params: Value) -> AgentResult<Value> {
        dispatch::execute(&self.store, &self.enabled, TOKEN, CallInput {
            instance_id: "todo-fixture".into(), grant_id: grant.into(), request_id: id.into(),
            binding: self.binding.clone(), method: method.into(), params,
        }, &Unused, &Unused, &Unused).await
    }
    async fn get(&self, object: &ObjectRef) -> Value {
        self.call(GRANT, "read-todo", "todo.get", json!({"target":object})).await.unwrap()
    }
}

#[tokio::test]
async fn create_children_update_and_undo_preserve_child_identity() {
    let f = Fixture::new();
    let create_input = f.create_input("create-todo");
    let created = f.call(GRANT, "create-todo", "todo.create", create_input.clone()).await.unwrap();
    let object: ObjectRef = serde_json::from_value(created["result"]["object"].clone()).unwrap();
    let initial_events = f.store.published.load(Ordering::SeqCst);
    assert_eq!(f.call(GRANT, "create-todo", "todo.create", create_input.clone()).await.unwrap(), created);
    assert_eq!(f.store.published.load(Ordering::SeqCst), initial_events);
    let mut changed = create_input; changed["input"]["content"] = json!("Other payload");
    assert_eq!(f.call(GRANT, "create-todo", "todo.create", changed).await.unwrap_err().code, ErrorCode::IdempotencyConflict);
    let before = f.get(&object).await;
    let child_id = before["snapshot"]["children"][0]["id"].as_i64().unwrap();
    let revision = before["revision"].as_u64().unwrap();
    let update_input = json!({"requestId":"update-todo","input":{"target":object,"expectedRevision":revision,"changes":[
        {"change":"content","content":"Ship delivery"},
        {"change":"status","status":"finished"},
        {"change":"child_update","childId":child_id,"content":"Checked evidence","progressDate":"2026-10-09","dueDate":null,"status":"finished"},
        {"change":"child_create","content":"Publish summary","progressDate":"2026-10-10","dueDate":null}
    ]}});
    let updated = f.call(GRANT, "update-todo", "todo.update", update_input.clone()).await.unwrap();
    assert_eq!(updated["result"]["beforeRevision"], revision);
    assert_eq!(f.call(GRANT, "update-todo", "todo.update", update_input).await.unwrap(), updated);
    let after = f.get(&object).await;
    assert_eq!(after["snapshot"]["content"], "Ship delivery");
    assert_eq!(after["snapshot"]["status"], "finished");
    assert_eq!(after["snapshot"]["children"][0]["id"], child_id);
    assert_eq!(after["snapshot"]["children"][1]["content"], "Publish summary");
    let undo = f.call(GRANT, "undo-update", "operation.undo", json!({"requestId":"undo-update","input":{"operationId":updated["operation"]["operationId"],"expectedHeadRevision":updated["result"]["afterRevision"]}})).await.unwrap();
    assert!(undo["operation"]["operationId"].is_string());
    let restored = f.get(&object).await;
    assert_eq!(restored["snapshot"], before["snapshot"]);
    assert_eq!(restored["snapshot"]["children"][0]["id"], child_id);
}

#[tokio::test]
async fn stale_gui_revision_readonly_and_other_grant_are_denied() {
    let f = Fixture::new();
    let created = f.call(GRANT, "create", "todo.create", f.create_input("create")).await.unwrap();
    let object: ObjectRef = serde_json::from_value(created["result"]["object"].clone()).unwrap();
    let before = f.get(&object).await;
    let revision = before["revision"].as_u64().unwrap();
    assert_eq!(f.call(READ_ONLY, "readonly", "todo.create", f.create_input("readonly")).await.unwrap_err().code, ErrorCode::ScopeDenied);
    assert_eq!(f.call(OTHER, "foreign-undo", "operation.undo", json!({"requestId":"foreign-undo","input":{"operationId":created["operation"]["operationId"],"expectedHeadRevision":revision}})).await.unwrap_err().code, ErrorCode::ScopeDenied);
    f.store.db.lock().unwrap().todo_update_content(TodoUpdateContentInput { expected_revision: revision, todo_id: object.id.parse().unwrap(), content: "GUI saved newer text".into(), due_date: None, tag_ids: vec![] }).unwrap();
    let update = json!({"requestId":"stale-update","input":{"target":object,"expectedRevision":revision,"changes":[{"change":"content","content":"Stale client"}]}});
    assert_eq!(f.call(GRANT, "stale-update", "todo.update", update).await.unwrap_err().code, ErrorCode::RevisionConflict);
    assert_eq!(f.get(&object).await["snapshot"]["content"], "GUI saved newer text");
}

#[tokio::test]
async fn created_todo_withdrawal_hides_read_but_keeps_receipt_and_restores_identity() {
    let f = Fixture::new();
    let created = f.call(GRANT, "create-withdraw", "todo.create", f.create_input("create-withdraw")).await.unwrap();
    let object: ObjectRef = serde_json::from_value(created["result"]["object"].clone()).unwrap();
    let operation = created["operation"]["operationId"].as_str().unwrap();
    let before = f.get(&object).await;
    let withdrawn = f.call(GRANT, "withdraw", "operation.undo", json!({"requestId":"withdraw","input":{"operationId":operation,"expectedHeadRevision":before["revision"]}})).await.unwrap();
    assert_eq!(withdrawn["result"]["withdrawn"], true);
    assert_eq!(f.call(GRANT, "withdrawn-read", "todo.get", json!({"target":object})).await.unwrap_err().code, ErrorCode::ObjectWithdrawn);
    let receipt = f.call(GRANT, "withdrawn-receipt", "operation.get", json!({"operationId":operation})).await.unwrap();
    assert_eq!(receipt["operationId"], operation);
    let revision = withdrawn["result"]["revision"].as_u64().unwrap();
    let restored = f.call(GRANT, "restore-created", "operation.restore_created", json!({"requestId":"restore-created","input":{"creationOperationId":operation,"expectedWithdrawalRevision":revision}})).await.unwrap();
    assert_eq!(restored["result"]["withdrawn"], false);
    assert_eq!(restored["result"]["object"], json!(object));
    assert_eq!(f.get(&object).await["snapshot"], before["snapshot"]);
}

impl crate::file_version_service::BoundFileCommitStore for Store {
    fn gui_commit_host(&self, _: &WorkspaceBinding) -> AgentResult<crate::file_version_service::FileCommitHost> {
        panic!("This fixture does not perform File mutations")
    }
}
