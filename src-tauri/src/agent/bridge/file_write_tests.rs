//! Persistent connection File writes through the real Workspace database and managed bytes.
use std::{fs, sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Arc, Mutex}};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{connection_store::ConnectionStore, dispatch, protocol::CallInput};
use crate::{
    agent::{access::{Caller, RequestContext, ScopeGrant}, connections::ConnectionCreateInput, errors::{AgentError, AgentResult, ErrorCode}, models::{ObjectRef, Scope, WorkspaceBinding}, tools::BoundReadContextStore},
    committed_changes::{CommittedChangePublisher, CommittedChanges},
    db::Database,
    file_version_service::{BoundFileCommitStore, FileBytesReader, FileCommitHost, FileHashSnapshot, FileVersionService, FilesystemFileReader},
    models::ProjectCreateInput,
    record_document_service::{BoundRecordStore, DocumentUtility},
    record_documents::RecordTarget,
    source_service::{BoundSourceStore, SourcePolicyUpdate, SourceUtility},
    source_session_read::{SessionHistoryFragment, SessionHistoryUtility},
    workspace::{create_workspace, WorkspacePaths},
    workspace_commit_fence::WorkspaceCommitFence,
};
const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const GRANT: &str = "0123456789abcdef0123456789abcdef";
const READ_ONLY: &str = "11111111111111111111111111111111";
const OTHER: &str = "22222222222222222222222222222222";

struct Store {
    binding: Mutex<WorkspaceBinding>,
    db: Mutex<Database>,
    paths: WorkspacePaths,
    fence: Arc<WorkspaceCommitFence>,
    published: AtomicUsize,
}
impl CommittedChangePublisher for Store {
    fn publish_committed(&self, _: CommittedChanges) { self.published.fetch_add(1, Ordering::SeqCst); }
}
impl BoundReadContextStore for Store {
    fn with_current_context<T>(&self, action: impl FnOnce(&WorkspaceBinding, &Database, &str) -> AgentResult<T>) -> AgentResult<T> {
        let binding = self.binding.lock().unwrap();
        let db = self.db.lock().unwrap();
        action(&binding, &db, "File Bridge Fixture")
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
impl BoundFileCommitStore for Store {
    fn gui_commit_host(&self, binding: &WorkspaceBinding) -> AgentResult<FileCommitHost> {
        if *self.binding.lock().unwrap() != *binding {
            return Err(AgentError::new(ErrorCode::WorkspaceChanged, "Workspace changed"));
        }
        Ok(FileCommitHost::for_test(binding.clone(), self.paths.clone(), None, self.fence.clone()))
    }
}
struct Unused;
impl DocumentUtility for Unused {
    async fn request(&self, _: &str, _: &str, _: Value) -> AgentResult<Value> { panic!("File writes do not invoke the document worker") }
}
impl SourceUtility for Unused {
    async fn request(&self, _: &str, _: &str, _: &str, _: &[u8]) -> AgentResult<Value> { panic!("File writes do not extract sources") }
}
impl SessionHistoryUtility for Unused {
    async fn read(&self, _: &WorkspaceBinding, _: &crate::db::agent_session_model_search::SourceReadRecord, _: Option<&str>, _: u32) -> AgentResult<SessionHistoryFragment> { panic!("File writes do not read history") }
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
        let (metadata, paths) = create_workspace(root.path(), "password").unwrap();
        let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
        db.bind_native_workspace(&metadata.workspace_id).unwrap();
        let project = db.project_create(ProjectCreateInput { name: "Granted".into(), summary: None, status: None }).unwrap();
        let binding = WorkspaceBinding { workspace_id: metadata.workspace_id, generation: "open-1".into() };
        for (id, writes) in [
            (GRANT, vec!["content.create", "file.update", "file.restore", "operation.undo"]),
            (READ_ONLY, vec![]),
            (OTHER, vec!["content.create", "file.update", "file.restore", "operation.undo"]),
        ] {
            db.agent_connection_create(&binding, &ConnectionCreateInput {
                all_projects: false,
                client_label: id.into(), workspace_content: false, project_ids: vec![project.id],
                session_read: false, write_operations: writes.into_iter().map(str::to_owned).collect(),
            }, id, TOKEN).unwrap();
        }
        Self { _root: root, store: Store { binding: Mutex::new(binding.clone()), db: Mutex::new(db), paths, fence: Arc::new(WorkspaceCommitFence::new()), published: AtomicUsize::new(0) }, enabled: Arc::new(AtomicBool::new(true)), binding, project_id: project.id }
    }
    async fn call(&self, grant: &str, id: &str, method: &str, params: Value) -> AgentResult<Value> {
        dispatch::execute(&self.store, &self.enabled, TOKEN, CallInput {
            instance_id: "file-fixture".into(), grant_id: grant.into(), request_id: id.into(),
            binding: self.binding.clone(), method: method.into(), params,
        }, &Unused, &Unused, &Unused).await
    }
    fn create_input(&self, id: &str, text: &str) -> Value {
        json!({"requestId":id,"input":{"projectId":self.project_id,"safeName":"notes.txt","utf8Content":text}})
    }
    async fn create(&self, id: &str, text: &str) -> Value {
        self.call(GRANT, id, "file.create", self.create_input(id, text)).await.unwrap()
    }
    async fn versions(&self, object: &ObjectRef) -> Value {
        self.call(GRANT, "versions", "file.versions.list", json!({"object":object})).await.unwrap()
    }
    fn bytes(&self, commit: &Value) -> Vec<u8> {
        let receipt = serde_json::from_value(commit["result"]["receipt"].clone()).unwrap();
        let path = self.store.db.lock().unwrap().file_version_committed_path(&receipt).unwrap().unwrap();
        fs::read(path).unwrap()
    }
}
fn mutation(id: &str, input: Value) -> Value { json!({"requestId":id,"input":input}) }
fn object(result: &Value) -> ObjectRef { serde_json::from_value(result["result"]["object"].clone()).unwrap() }

#[tokio::test]
async fn create_patch_restore_and_undo_commit_real_versions() {
    let f = Fixture::new();
    let input = f.create_input("create", "alpha\n");
    let created = f.call(GRANT, "create", "file.create", input.clone()).await.unwrap();
    let file = object(&created);
    let count = f.store.published.load(Ordering::SeqCst);
    assert_eq!(f.call(GRANT, "create", "file.create", input).await.unwrap(), created);
    assert_eq!(f.store.published.load(Ordering::SeqCst), count);
    assert_eq!(f.call(GRANT, "create", "file.create", f.create_input("create", "changed")).await.unwrap_err().code, ErrorCode::IdempotencyConflict);
    let first = f.versions(&file).await;
    let patch = mutation("patch", json!({"object":file,"expectedVersionNumber":first["currentVersionNumber"],"expectedContentHash":first["currentContentHash"],"appendText":"beta\n"}));
    let patched = f.call(GRANT, "patch", "file.patch", patch.clone()).await.unwrap();
    assert_eq!(f.bytes(&patched), b"alpha\nbeta\n");
    assert_eq!(f.call(GRANT, "patch", "file.patch", patch).await.unwrap(), patched);
    let second = f.versions(&file).await;
    let historical = first["versions"].as_array().unwrap().iter().find(|v| v["versionNumber"] == 1).unwrap()["id"].clone();
    let restore = mutation("restore", json!({"object":file,"versionId":historical,"expectedVersionNumber":second["currentVersionNumber"],"expectedContentHash":second["currentContentHash"]}));
    let restored = f.call(GRANT, "restore", "file.version.restore", restore).await.unwrap();
    assert_eq!(f.bytes(&restored), b"alpha\n");
    let undo = f.call(GRANT, "undo-restore", "operation.undo", mutation("undo-restore", json!({"operationId":restored["operation"]["operationId"],"expectedHeadRevision":restored["result"]["receipt"]["versionNumber"]}))).await.unwrap();
    assert!(undo["operation"]["operationId"].is_string());
    let after = f.versions(&file).await;
    assert!(after["currentVersionNumber"].as_u64().unwrap() > restored["result"]["receipt"]["versionNumber"].as_u64().unwrap());
    let read = f.call(GRANT, "read-after-undo", "file.source.read", json!({"object":file,"versionNumber":after["currentVersionNumber"],"expectedContentHash":after["currentContentHash"],"budgetChars":1000})).await.unwrap();
    assert!(read.to_string().contains("beta"));
}

#[tokio::test]
async fn creation_withdrawal_and_restoration_preserve_file_identity_and_bytes() {
    let f = Fixture::new();
    let created = f.create("created", "kept bytes").await;
    let file = object(&created);
    let operation = created["operation"]["operationId"].as_str().unwrap();
    let before = f.versions(&file).await;
    let withdrawn = f.call(GRANT, "withdraw", "operation.undo", mutation("withdraw", json!({"operationId":operation,"expectedHeadRevision":before["currentVersionNumber"]}))).await.unwrap();
    assert_eq!(withdrawn["result"]["withdrawn"], true);
    assert_eq!(f.call(GRANT, "hidden", "file.versions.list", json!({"object":file})).await.unwrap_err().code, ErrorCode::ObjectWithdrawn);
    assert_eq!(f.call(GRANT, "receipt", "operation.get", json!({"operationId":operation})).await.unwrap()["operationId"], operation);
    let restored = f.call(GRANT, "restore-created", "operation.restore_created", mutation("restore-created", json!({"creationOperationId":operation,"expectedWithdrawalRevision":withdrawn["result"]["revision"]}))).await.unwrap();
    assert_eq!(restored["result"]["object"], json!(file));
    let after = f.versions(&file).await;
    assert_eq!(after["currentContentHash"], before["currentContentHash"]);
}

#[tokio::test]
async fn binary_upload_commits_exact_bytes_and_replays() {
    let f = Fixture::new();
    let created = f.create("upload-create", "old").await;
    let file = object(&created);
    let baseline = f.versions(&file).await;
    let bytes = b"\0binary\xff\xfe\n";
    let hash = format!("sha256:{:x}", Sha256::digest(bytes));
    let begin = f.call(GRANT, "upload-begin", "file.content.begin", mutation("upload-begin", json!({"object":file,"expectedVersionNumber":baseline["currentVersionNumber"],"expectedContentHash":baseline["currentContentHash"],"length":bytes.len(),"contentHash":hash}))).await.unwrap();
    let stage = begin["stagedContentId"].as_str().unwrap();
    f.call(GRANT, "upload-chunk", "file.content.chunk", mutation("upload-chunk", json!({"stagedContentId":stage,"offset":0,"dataBase64":STANDARD.encode(bytes)}))).await.unwrap();
    let complete = f.call(GRANT, "upload-complete", "file.content.complete", mutation("upload-complete", json!({"stagedContentId":stage}))).await.unwrap();
    assert_eq!(complete["ready"], true);
    let update = mutation("upload-update", json!({"object":file,"expectedVersionNumber":baseline["currentVersionNumber"],"expectedContentHash":baseline["currentContentHash"],"stagedContentId":stage}));
    let committed = f.call(GRANT, "upload-update", "file.update", update.clone()).await.unwrap();
    assert_eq!(f.bytes(&committed), bytes);
    assert_eq!(f.versions(&file).await["currentContentHash"], hash);
    assert_eq!(f.call(GRANT, "upload-update", "file.update", update).await.unwrap(), committed);
}

#[tokio::test]
async fn read_only_foreign_caller_and_stale_baseline_are_rejected() {
    let f = Fixture::new();
    assert_eq!(f.call(READ_ONLY, "readonly", "file.create", f.create_input("readonly", "x")).await.unwrap_err().code, ErrorCode::ScopeDenied);
    let created = f.create("authorized", "old").await;
    let file = object(&created);
    let baseline = f.versions(&file).await;
    let patch = mutation("foreign", json!({"object":file,"expectedVersionNumber":baseline["currentVersionNumber"],"expectedContentHash":baseline["currentContentHash"],"appendText":"new"}));
    assert_eq!(f.call(READ_ONLY, "foreign", "file.patch", patch.clone()).await.unwrap_err().code, ErrorCode::ScopeDenied);
    assert_eq!(f.call(OTHER, "foreign-undo", "operation.undo", mutation("foreign-undo", json!({"operationId":created["operation"]["operationId"],"expectedHeadRevision":1}))).await.unwrap_err().code, ErrorCode::ScopeDenied);
    let mut own_patch = patch; own_patch["requestId"] = json!("own");
    f.call(GRANT, "own", "file.patch", own_patch).await.unwrap();
    let stale = mutation("stale", json!({"object":file,"expectedVersionNumber":baseline["currentVersionNumber"],"expectedContentHash":baseline["currentContentHash"],"appendText":"stale"}));
    assert_eq!(f.call(GRANT, "stale", "file.patch", stale).await.unwrap_err().code, ErrorCode::RevisionConflict);
}

#[tokio::test]
async fn revocation_or_disable_during_file_capture_prevents_commit() {
    struct ChangeAuthority<'a> { fixture: &'a Fixture, revoke: bool }
    impl FileBytesReader for ChangeAuthority<'_> {
        fn capture(&self, path: &std::path::Path) -> AgentResult<FileHashSnapshot> {
            FilesystemFileReader.capture(path)
        }
        fn capture_update(&self, plan: &crate::source_file_snapshot::FileReadPlan) -> AgentResult<crate::source_file_snapshot::FileByteSnapshot> {
            let snapshot = crate::source_file_snapshot::capture_file_update(plan)?;
            if self.revoke {
                self.fixture.store.db.lock().unwrap().agent_connection_revoke(&self.fixture.binding, GRANT)?;
            } else {
                self.fixture.enabled.store(false, Ordering::Release);
            }
            Ok(snapshot)
        }
    }
    for revoke in [true, false] {
        let f = Fixture::new();
        let created = f.create("create", "original").await;
        let file = object(&created);
        let before = f.versions(&file).await;
        let patch = serde_json::from_value(json!({"object":file,"expectedVersionNumber":before["currentVersionNumber"],"expectedContentHash":before["currentContentHash"],"appendText":"new"})).unwrap();
        let input = CallInput {
            instance_id: "file-fixture".into(), grant_id: GRANT.into(), request_id: "paused-patch".into(),
            binding: f.binding.clone(), method: "file.patch".into(), params: Value::Null,
        };
        let connection = ConnectionStore { inner: &f.store, enabled: &f.enabled, token: TOKEN, input: &input };
        let request = connection.with_authenticated(|_, _, _, request| Ok(request)).unwrap();
        let result = FileVersionService::new(&connection, &ChangeAuthority { fixture: &f, revoke }).patch_text(&request, &patch);
        assert_eq!(result.unwrap_err().code, if revoke { ErrorCode::ScopeDenied } else { ErrorCode::RuntimeUnavailable });
        // Inspect through the trusted fixture DB: revoked clients cannot read the head.
        let absent = crate::db::file_versions::CommittedVersion {
            document_id: file.id.parse().unwrap(), version_number: 2,
            content_hash: String::new(), no_change: false,
        };
        assert!(f.store.db.lock().unwrap().file_version_committed_path(&absent).unwrap().is_none());
        assert_eq!(f.store.published.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn cross_project_and_excluded_file_cannot_be_mutated() {
    let f = Fixture::new();
    let second = f.store.db.lock().unwrap().project_create(ProjectCreateInput {
        name: "Ungranted".into(), summary: None, status: None,
    }).unwrap();
    let forbidden = mutation("other-project", json!({"projectId":second.id,"safeName":"forbidden.txt","utf8Content":"x"}));
    assert_eq!(f.call(GRANT, "other-project", "file.create", forbidden).await.unwrap_err().code, ErrorCode::ScopeDenied);

    let created = f.create("to-exclude", "old").await;
    let file = object(&created);
    let baseline = f.versions(&file).await;
    let gui = RequestContext {
        binding: f.binding.clone(), caller: Caller::Gui, request_id: "exclude".into(),
        scope_grant: ScopeGrant {
            workspace_id: f.binding.workspace_id.clone(), workspace_content: false,
            project_ids: vec![f.project_id], operations: vec!["settings.write".into(), "source.read".into()],
        },
    };
    assert!(matches!(file.scope, Scope::Project { .. }));
    f.store.db.lock().unwrap().source_policy_update(&gui, &f.binding, &SourcePolicyUpdate {
        object: file.clone(), expected_revision: 0, excluded: true,
    }).unwrap();
    let patch = mutation("excluded", json!({"object":file,"expectedVersionNumber":baseline["currentVersionNumber"],"expectedContentHash":baseline["currentContentHash"],"appendText":"new"}));
    assert_eq!(f.call(GRANT, "excluded", "file.patch", patch).await.unwrap_err().code, ErrorCode::ScopeDenied);
}

#[tokio::test]
async fn upload_staging_stops_after_withdrawal_or_source_exclusion() {
    for withdraw in [true, false] {
        let f = Fixture::new();
        let created = f.create("create", "old").await;
        let file = object(&created);
        let baseline = f.versions(&file).await;
        let bytes = b"replacement";
        let hash = format!("sha256:{:x}", Sha256::digest(bytes));
        let begin = f.call(GRANT, "begin", "file.content.begin", mutation("begin", json!({
            "object":file,"expectedVersionNumber":baseline["currentVersionNumber"],
            "expectedContentHash":baseline["currentContentHash"],"length":bytes.len(),"contentHash":hash,
        }))).await.unwrap();
        let stage = begin["stagedContentId"].as_str().unwrap();
        let expected = if withdraw {
            f.call(GRANT, "withdraw", "operation.undo", mutation("withdraw", json!({
                "operationId":created["operation"]["operationId"],
                "expectedHeadRevision":baseline["currentVersionNumber"],
            }))).await.unwrap();
            ErrorCode::ObjectWithdrawn
        } else {
            let gui = RequestContext {
                binding: f.binding.clone(), caller: Caller::Gui, request_id: "exclude".into(),
                scope_grant: ScopeGrant {
                    workspace_id: f.binding.workspace_id.clone(), workspace_content: false,
                    project_ids: vec![f.project_id], operations: vec!["settings.write".into(), "source.read".into()],
                },
            };
            let project = ObjectRef {
                workspace_id: f.binding.workspace_id.clone(),
                scope: Scope::Project { project_id: f.project_id },
                kind: crate::agent::models::ObjectKind::Project,
                id: f.project_id.to_string(),
            };
            f.store.db.lock().unwrap().source_policy_update(&gui, &f.binding, &SourcePolicyUpdate {
                object: project, expected_revision: 0, excluded: true,
            }).unwrap();
            ErrorCode::ScopeDenied
        };
        assert_eq!(f.call(GRANT, "chunk", "file.content.chunk", mutation("chunk", json!({
            "stagedContentId":stage,"offset":0,"dataBase64":STANDARD.encode(bytes),
        }))).await.unwrap_err().code, expected);
        assert_eq!(f.call(GRANT, "complete", "file.content.complete", mutation("complete", json!({
            "stagedContentId":stage,
        }))).await.unwrap_err().code, expected);
        let absent = crate::db::file_versions::CommittedVersion {
            document_id: file.id.parse().unwrap(), version_number: 2,
            content_hash: String::new(), no_change: false,
        };
        assert!(f.store.db.lock().unwrap().file_version_committed_path(&absent).unwrap().is_none());
    }
}
