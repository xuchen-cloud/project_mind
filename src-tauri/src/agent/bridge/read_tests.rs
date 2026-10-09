//! Connection read integration against native SQLite storage and a registered File.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use serde_json::{json, Value};
use tokio::sync::{oneshot, Semaphore};

use super::{dispatch, protocol::CallInput};
use crate::{
    agent::{
        access::{Caller, RequestContext, ScopeGrant},
        connections::ConnectionCreateInput,
        errors::{AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
        tools::BoundReadContextStore,
    },
    committed_changes::{CommittedChangePublisher, CommittedChanges},
    db::Database,
    models::{DocumentImportInput, ProjectCreateInput, ProjectRecordUpsertInput, TodoCreateInput, TodoScope},
    record_document_service::DocumentUtility,
    record_documents::{body_hash, RecordDocumentProjection, RecordTarget},
    source_service::{BoundSourceStore, SourceIndexBudget, SourcePolicyUpdate, SourceReadTarget, SourceService, SourceUtility},
};

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const GRANT: &str = "0123456789abcdef0123456789abcdef";
const EVIDENCE: &str = "Bridge File evidence";

struct Store {
    binding: Mutex<WorkspaceBinding>,
    db: Mutex<Database>,
}
impl CommittedChangePublisher for Store {
    fn publish_committed(&self, _: CommittedChanges) {}
}
impl BoundReadContextStore for Store {
    fn with_current_context<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database, &str) -> AgentResult<T>,
    ) -> AgentResult<T> {
        let binding = self.binding.lock().unwrap();
        let db = self.db.lock().unwrap();
        action(&binding, &db, "Bridge Workspace")
    }
}
impl BoundSourceStore for Store {
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        self.with_current_context(|binding, db, _| action(binding, db))
    }
}

struct UnusedDocument;
impl DocumentUtility for UnusedDocument {
    async fn request(&self, _: &str, _: &str, _: Value) -> AgentResult<Value> {
        panic!("these reads must not invoke Record conversion")
    }
}

struct PausedCompare {
    entered: Mutex<Option<oneshot::Sender<()>>>,
    resume: Semaphore,
}
impl DocumentUtility for PausedCompare {
    async fn request(&self, _: &str, method: &str, data: Value) -> AgentResult<Value> {
        assert_eq!(method, "record.compare");
        assert_eq!(data["document"], data["otherDocument"]);
        assert_eq!(data["document"]["content"][0]["content"][0]["text"], "Record evidence");
        if let Some(sender) = self.entered.lock().unwrap().take() {
            let _ = sender.send(());
        }
        self.resume.acquire().await.unwrap().forget();
        Ok(json!({
            "added": [], "deleted": [],
            "modified": ["1234567890abcdef1234567890abcdef"], "moved": [],
        }))
    }
}

struct TextUtility {
    entered: Mutex<Option<oneshot::Sender<()>>>,
    resume: Semaphore,
}
impl TextUtility {
    fn immediate() -> Self {
        Self {
            entered: Mutex::new(None),
            resume: Semaphore::new(1),
        }
    }
    fn paused() -> (Self, oneshot::Receiver<()>) {
        let (sender, receiver) = oneshot::channel();
        (
            Self {
                entered: Mutex::new(Some(sender)),
                resume: Semaphore::new(0),
            },
            receiver,
        )
    }
}
impl SourceUtility for TextUtility {
    async fn request(&self, _: &str, _: &str, format: &str, bytes: &[u8]) -> AgentResult<Value> {
        assert_eq!(format, "text");
        let text = std::str::from_utf8(bytes).unwrap().to_owned();
        if let Some(sender) = self.entered.lock().unwrap().take() {
            let _ = sender.send(());
        }
        self.resume.acquire().await.unwrap().forget();
        let len = text.chars().count();
        Ok(json!({
            "state": "ready", "reason": null,
            "chunks": [{"ordinal": 0, "text": text,
                "locator": {"kind": "paragraph", "start": 1, "end": 1},
                "range": {"start": 0, "end": len}}],
            "coverage": {"chars": len, "paragraphs": 1, "complete": true},
        }))
    }
}

struct Fixture {
    _root: tempfile::TempDir,
    store: Arc<Store>,
    enabled: Arc<AtomicBool>,
    binding: WorkspaceBinding,
    project_id: i64,
    other_project_id: i64,
    file: ObjectRef,
    record: ObjectRef,
    todo: ObjectRef,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("bridge.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("bridge-workspace").unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Allowed Project".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let other = db
            .project_create(ProjectCreateInput {
                name: "Foreign Project".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let path = root.path().join("evidence.txt");
        std::fs::write(&path, EVIDENCE).unwrap();
        let file = db
            .document_import(DocumentImportInput {
                project_id: project.id,
                source_path: path.to_string_lossy().into(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        let record = db.project_record_upsert(ProjectRecordUpsertInput {
            project_id: project.id, note_id: None, title: Some("Bridge Record".into()),
            markdown: "Record evidence".into(), html: "<p>Record evidence</p>".into(),
            default_code_language: None, tag_ids: vec![],
        }).unwrap();
        let target = RecordTarget { scope: Scope::Project { project_id: project.id }, record_id: record.id };
        let document = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"1234567890abcdef1234567890abcdef"},"content":[{"type":"text","text":"Record evidence"}]}]});
        let projection = RecordDocumentProjection {
            schema_version: 1, body_hash: body_hash(&document, &None), document,
            html: "<p>Record evidence</p>".into(), markdown: "Record evidence".into(),
            text: "Record evidence".into(), code_language: None,
        };
        db.record_document_initialize(
            "gui", "bridge-record-initialize", &target,
            &db.record_document_source(&target).unwrap().source_hash,
            &projection, "bridge-workspace",
        ).unwrap();
        let todo = db.todo_create(TodoCreateInput {
            scope: TodoScope::Project, project_id: Some(project.id),
            content: "Bridge Todo".into(), priority: "normal".into(),
            due_date: None, tag_ids: vec![],
        }).unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "bridge-workspace".into(),
            generation: "open-1".into(),
        };
        db.agent_connection_create(
            &binding,
            &ConnectionCreateInput {
                client_label: "Read Integration".into(),
                workspace_content: false,
                project_ids: vec![project.id],
                session_read: false,
                write_operations: vec![],
            },
            GRANT,
            TOKEN,
        )
        .unwrap();
        let object = ObjectRef {
            workspace_id: binding.workspace_id.clone(),
            scope: Scope::Project {
                project_id: project.id,
            },
            kind: ObjectKind::File,
            id: file.id.to_string(),
        };
        let record_object = ObjectRef {
            workspace_id: binding.workspace_id.clone(), scope: Scope::Project { project_id: project.id },
            kind: ObjectKind::Record, id: record.id.to_string(),
        };
        let todo_object = ObjectRef {
            workspace_id: binding.workspace_id.clone(), scope: Scope::Project { project_id: project.id },
            kind: ObjectKind::Todo, id: todo.id.to_string(),
        };
        Self {
            _root: root,
            store: Arc::new(Store {
                binding: Mutex::new(binding.clone()),
                db: Mutex::new(db),
            }),
            enabled: Arc::new(AtomicBool::new(true)),
            binding,
            project_id: project.id,
            other_project_id: other.id,
            file: object,
            record: record_object,
            todo: todo_object,
        }
    }
    fn input(&self, id: &str, method: &str, params: Value) -> CallInput {
        CallInput {
            instance_id: "test-instance".into(),
            grant_id: GRANT.into(),
            request_id: id.into(),
            binding: self.binding.clone(),
            method: method.into(),
            params,
        }
    }
    async fn read(
        &self,
        id: &str,
        method: &str,
        params: Value,
        utility: &TextUtility,
    ) -> AgentResult<Value> {
        dispatch::execute(
            &*self.store,
            &self.enabled,
            TOKEN,
            self.input(id, method, params),
            &UnusedDocument,
            utility,
            &UnusedDocument,
        )
        .await
    }
    fn scope(&self) -> Scope {
        Scope::Project {
            project_id: self.project_id,
        }
    }
    fn file_input(&self) -> Value {
        json!({"source": {"object": self.file}, "view": "full", "budgetChars": 2000})
    }
}

#[tokio::test]
async fn all_registered_reads_use_native_storage_and_enforce_scope() {
    let f = Fixture::new();
    let utility = TextUtility::immediate();
    let list = f
        .read("list", "project.list", json!({}), &utility)
        .await
        .unwrap();
    assert_eq!(
        list,
        json!([{"id": f.project_id, "name": "Allowed Project"}])
    );
    let context = f
        .read(
            "context",
            "context.get",
            json!({"scope": f.scope()}),
            &utility,
        )
        .await
        .unwrap();
    assert_eq!(context["identity"]["name"], "Allowed Project");
    let overview = f
        .read(
            "overview",
            "context.overview.get",
            json!({"scope": f.scope()}),
            &utility,
        )
        .await
        .unwrap();
    assert!(overview["items"].as_array().unwrap().is_empty());
    let knowledge = f
        .read(
            "knowledge-search",
            "knowledge.search",
            json!({"scope": f.scope(), "query": "missing"}),
            &utility,
        )
        .await
        .unwrap();
    assert!(knowledge["items"].as_array().unwrap().is_empty());
    let missing = f
        .read(
            "knowledge-get",
            "knowledge.get",
            json!({"scope": f.scope(), "nodeId": "node:missing"}),
            &utility,
        )
        .await
        .unwrap_err();
    assert_eq!(missing.code, ErrorCode::NotFound);
    let project_object = ObjectRef {
        workspace_id: f.binding.workspace_id.clone(),
        scope: f.scope(),
        kind: ObjectKind::Project,
        id: f.project_id.to_string(),
    };
    let index_request = f.store.db.lock().unwrap().agent_connection_authenticate(
        &f.binding, GRANT, TOKEN, "index-project",
    ).unwrap();
    SourceService::new(&*f.store).index_native(
        &index_request,
        &SourceReadTarget {
            object: project_object.clone(), revision: None,
            record_version: None, file_version: None,
        },
        SourceIndexBudget::default(),
    ).unwrap();
    let search = f
        .read(
            "source-search",
            "source.search",
            json!({"scope": f.scope(), "query": "Allowed"}),
            &utility,
        )
        .await
        .unwrap();
    assert_eq!(search["items"].as_array().unwrap().len(), 1);
    assert_eq!(search["items"][0]["sourceRef"]["object"], json!(project_object));
    assert_eq!(search["items"][0]["title"], "Allowed Project");
    let file = f
        .read("file", "source.read", f.file_input(), &utility)
        .await
        .unwrap();
    assert_eq!(file["text"], EVIDENCE);
    assert_eq!(file["sourceRef"]["object"], json!(f.file));

    let foreign = ObjectRef {
        workspace_id: f.binding.workspace_id.clone(),
        scope: Scope::Project {
            project_id: f.other_project_id,
        },
        kind: ObjectKind::Project,
        id: f.other_project_id.to_string(),
    };
    let denied = f
        .read(
            "foreign-object",
            "source.read",
            json!({"source": {"object": foreign}, "view": "full"}),
            &utility,
        )
        .await
        .unwrap_err();
    assert_eq!(denied.code, ErrorCode::ScopeDenied);
    let denied = f.read("foreign-scope", "knowledge.search", json!({"scope": Scope::Project { project_id: f.other_project_id }, "query": "evidence"}), &utility).await.unwrap_err();
    assert_eq!(denied.code, ErrorCode::ScopeDenied);
    let denied = f
        .read(
            "workspace-scope",
            "context.overview.get",
            json!({"scope": Scope::Workspace}),
            &utility,
        )
        .await
        .unwrap_err();
    assert_eq!(denied.code, ErrorCode::ScopeDenied);
}

#[tokio::test]
async fn file_extraction_rechecks_revocation_workspace_and_enabled_state() {
    for scenario in ["revoke", "switch", "disable"] {
        let f = Fixture::new();
        let (utility, entered) = TextUtility::paused();
        let read = f.read("suspended-file", "source.read", f.file_input(), &utility);
        let intervene = async {
            entered.await.unwrap();
            match scenario {
                "revoke" => {
                    f.store
                        .db
                        .lock()
                        .unwrap()
                        .agent_connection_revoke(&f.binding, GRANT)
                        .unwrap();
                }
                "switch" => {
                    f.store.binding.lock().unwrap().generation = "open-2".into();
                }
                "disable" => {
                    f.enabled.store(false, Ordering::Release);
                }
                _ => unreachable!(),
            }
            utility.resume.add_permits(1);
        };
        let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(read, intervene)
        })
        .await
        .expect("read must reach and leave the extraction boundary");
        let error = result.unwrap_err();
        assert_eq!(
            error.code,
            match scenario {
                "revoke" => ErrorCode::ScopeDenied,
                "switch" => ErrorCode::WorkspaceChanged,
                "disable" => ErrorCode::RuntimeUnavailable,
                _ => unreachable!(),
            }
        );
        assert!(!error.message.contains(EVIDENCE));
    }
}

#[tokio::test]
async fn object_reads_return_native_versions_bodies_and_enforce_current_policy() {
    let f = Fixture::new();
    let utility = TextUtility::immediate();
    let blocks = f.read("blocks", "record.blocks.get", json!({"record": f.record}), &utility).await.unwrap();
    assert_eq!(blocks["record"], json!(f.record));
    assert_eq!(blocks["headRevision"], 1);
    assert_eq!(blocks["items"][0]["node"]["content"][0]["text"], "Record evidence");
    assert_eq!(blocks["items"][0]["tree"][0]["blockId"], "1234567890abcdef1234567890abcdef");
    assert!(blocks["bodyHash"].as_str().unwrap().starts_with("sha256:"));

    let todo = f.read("todo", "todo.get", json!({"target": f.todo}), &utility).await.unwrap();
    assert_eq!(todo["object"], json!(f.todo));
    assert_eq!(todo["revision"], 1);
    assert_eq!(todo["snapshot"]["content"], "Bridge Todo");
    assert!(todo["bodyHash"].as_str().unwrap().starts_with("sha256:"));

    let versions = f.read("versions", "file.versions.list", json!({"object": f.file}), &utility).await.unwrap();
    assert_eq!(versions["object"], json!(f.file));
    assert_eq!(versions["currentVersionNumber"], 1);
    assert_eq!(versions["versions"].as_array().unwrap().len(), 1);
    let version_id = versions["versions"][0]["id"].as_str().unwrap().to_owned();
    let hash = versions["versions"][0]["contentHash"].as_str().unwrap().to_owned();
    assert!(hash.starts_with("sha256:"));
    let version = f.read("version", "file.versions.get", json!({"object": f.file, "versionId": version_id}), &utility).await.unwrap();
    assert_eq!(version["version"]["contentHash"], hash);
    assert_eq!(version["version"]["versionNumber"], 1);

    let page = f.read("raw", "file.source.read", json!({"object": f.file, "versionNumber": 1, "expectedContentHash": hash}), &utility).await.unwrap();
    assert_eq!(page["text"], EVIDENCE);
    assert_eq!(page["contentHash"], hash);
    assert_eq!(page["byteLength"], EVIDENCE.len());
    assert_eq!(page["complete"], true);
    let tiny = f.read("raw-small", "file.source.read", json!({"object": f.file, "versionNumber": 1, "budgetChars": 1}), &utility).await.unwrap_err();
    assert_eq!(tiny.code, ErrorCode::BudgetExceeded);
    let wrong_hash = format!("sha256:{}", "0".repeat(64));
    let changed = f.read("raw-hash", "file.source.read", json!({"object": f.file, "versionNumber": 1, "expectedContentHash": wrong_hash}), &utility).await.unwrap_err();
    assert_eq!(changed.code, ErrorCode::SourceChanged);

    for (method, field, object) in [
        ("record.blocks.get", "record", &f.record),
        ("todo.get", "target", &f.todo),
        ("file.versions.list", "object", &f.file),
        ("file.versions.get", "object", &f.file),
        ("file.source.read", "object", &f.file),
    ] {
        let mut foreign = object.clone();
        foreign.scope = Scope::Project { project_id: f.other_project_id };
        let mut params = json!({});
        params[field] = json!(foreign);
        if method == "file.versions.get" { params["versionId"] = json!(version_id); }
        if method == "file.source.read" { params["versionNumber"] = json!(1); }
        let denied = f.read(&format!("foreign-{method}"), method, params, &utility).await.unwrap_err();
        assert_eq!(denied.code, ErrorCode::ScopeDenied, "{method}");
    }

    let gui = RequestContext {
        binding: f.binding.clone(), caller: Caller::Gui,
        request_id: "gui-exclude-file".into(),
        scope_grant: ScopeGrant {
            workspace_id: f.binding.workspace_id.clone(), workspace_content: false,
            project_ids: vec![f.project_id],
            operations: vec!["settings.write".into(), "source.read".into()],
        },
    };
    f.store.db.lock().unwrap().source_policy_update(
        &gui, &f.binding,
        &SourcePolicyUpdate { object: f.file.clone(), expected_revision: 0, excluded: true },
    ).unwrap();
    for (method, params) in [
        ("file.versions.list", json!({"object": f.file})),
        ("file.versions.get", json!({"object": f.file, "versionId": version_id})),
        ("file.source.read", json!({"object": f.file, "versionNumber": 1})),
    ] {
        let denied = f.read(&format!("excluded-{method}"), method, params, &utility).await.unwrap_err();
        assert_eq!(denied.code, ErrorCode::ScopeDenied, "{method}");
    }
}

impl crate::source_session_read::SessionHistoryUtility for UnusedDocument {
    async fn read(&self, _: &WorkspaceBinding, _: &crate::db::agent_session_model_search::SourceReadRecord, _: Option<&str>, _: u32) -> AgentResult<crate::source_session_read::SessionHistoryFragment> {
        panic!("This fixture does not read session history")
    }
}

#[tokio::test]
async fn record_version_reads_return_exact_source_and_compare_rechecks_revocation() {
    let f = Fixture::new();
    let utility = TextUtility::immediate();
    let listed = f.read("record-versions", "record.versions.list", json!({"record": f.record}), &utility).await.unwrap();
    assert_eq!(listed["object"], json!(f.record));
    assert_eq!(listed["versions"].as_array().unwrap().len(), 1);
    assert_eq!(listed["versions"][0]["versionNumber"], 1);
    assert_eq!(listed["versions"][0]["headRevision"], 1);
    let version_id = listed["versions"][0]["id"].as_str().unwrap().to_owned();
    assert_eq!(version_id.len(), 32);
    let hash = listed["versions"][0]["bodyHash"].as_str().unwrap().to_owned();
    assert!(hash.starts_with("sha256:"));

    let version = f.read("record-version", "record.versions.get", json!({"record": f.record, "versionId": version_id}), &utility).await.unwrap();
    assert_eq!(version["version"]["id"], version_id);
    assert_eq!(version["version"]["bodyHash"], hash);
    assert_eq!(version["source"]["object"], json!(f.record));
    assert_eq!(version["source"]["recordVersion"], 1);
    assert!(version["source"]["revision"].as_str().unwrap().starts_with("sha256:"));
    let body = f.read("record-source", "source.read", json!({"source": version["source"], "view": "full"}), &utility).await.unwrap();
    assert_eq!(body["text"], "Record evidence");
    assert_eq!(body["sourceRef"]["object"], json!(f.record));

    let (entered_tx, entered_rx) = oneshot::channel();
    let compare = PausedCompare { entered: Mutex::new(Some(entered_tx)), resume: Semaphore::new(0) };
    let read = dispatch::execute(
        &*f.store, &f.enabled, TOKEN,
        f.input("record-compare", "record.versions.compare", json!({
            "record": f.record, "beforeVersionId": version_id, "afterVersionId": version_id,
        })),
        &compare, &utility, &UnusedDocument,
    );
    let intervene = async {
        entered_rx.await.unwrap();
        f.store.db.lock().unwrap().agent_connection_revoke(&f.binding, GRANT).unwrap();
        compare.resume.add_permits(1);
    };
    let (result, ()) = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        async { tokio::join!(read, intervene) },
    ).await.expect("Record comparison must reach the document utility");
    let error = result.unwrap_err();
    assert_eq!(error.code, ErrorCode::ScopeDenied);
    assert!(!error.message.contains("Record evidence"));
}

// This headless transport fixture has no registered editors.
impl crate::record_document_service::BoundRecordStore for Store {
    async fn flush_editors(&self, _: &WorkspaceBinding, _: &crate::record_documents::RecordTarget) -> AgentResult<()> { Ok(()) }
    async fn submission_lock(&self, _: &WorkspaceBinding, _: &crate::record_documents::RecordTarget) -> AgentResult<Option<tokio::sync::OwnedMutexGuard<()>>> { Ok(None) }
    fn with_current<T>(&self, action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>) -> AgentResult<T> {
        crate::source_service::BoundSourceStore::with_current(self, action)
    }
}

impl crate::file_version_service::BoundFileCommitStore for Store {
    fn gui_commit_host(&self, _: &WorkspaceBinding) -> AgentResult<crate::file_version_service::FileCommitHost> {
        panic!("This fixture does not perform File mutations")
    }
}
