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
        connections::ConnectionCreateInput,
        errors::{AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
        tools::BoundReadContextStore,
    },
    committed_changes::{CommittedChangePublisher, CommittedChanges},
    db::Database,
    models::{DocumentImportInput, ProjectCreateInput},
    record_document_service::DocumentUtility,
    source_service::{BoundSourceStore, SourceIndexBudget, SourceReadTarget, SourceService, SourceUtility},
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
    enabled: AtomicBool,
    binding: WorkspaceBinding,
    project_id: i64,
    other_project_id: i64,
    file: ObjectRef,
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
        Self {
            _root: root,
            store: Arc::new(Store {
                binding: Mutex::new(binding.clone()),
                db: Mutex::new(db),
            }),
            enabled: AtomicBool::new(true),
            binding,
            project_id: project.id,
            other_project_id: other.id,
            file: object,
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
