//! Integration at the trusted dispatcher: real bytes, Workspace, run and receipts.
use super::{
    access::{Caller, RequestContext, ScopeGrant},
    conversation::RunPreparation,
    errors::{AgentResult, ErrorCode},
    models::{ExecutionMode, ObjectRef, Scope, WorkspaceBinding},
    output_tools::dispatch_output,
};
use crate::{
    committed_changes::{CommittedChangePublisher, CommittedChanges},
    db::Database,
    file_version_service::{BoundFileCommitStore, FileCommitHost},
    record_document_service::{BoundRecordStore, DocumentUtility},
    record_documents::RecordTarget,
    source_service::BoundSourceStore,
    workspace_commit_fence::WorkspaceCommitFence,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
const ORIGINAL: &str = "\u{feff}<script>original<&></script>\r\n正文\r\n";
struct Store {
    binding: WorkspaceBinding,
    paths: crate::workspace::WorkspacePaths,
    db: Mutex<Database>,
    fence: Arc<WorkspaceCommitFence>,
    published: Mutex<Vec<CommittedChanges>>,
}
impl CommittedChangePublisher for Store {
    fn publish_committed(&self, change: CommittedChanges) {
        assert!(
            self.db.try_lock().is_ok(),
            "publication must release GUI storage"
        );
        assert_eq!(change.binding, self.binding);
        self.published.lock().unwrap().push(change);
    }
}
impl BoundFileCommitStore for Store {
    fn gui_commit_host(&self, binding: &WorkspaceBinding) -> AgentResult<FileCommitHost> {
        crate::file_version_service::validate_binding(binding, &self.binding)?;
        Ok(FileCommitHost::for_test(
            self.binding.clone(),
            self.paths.clone(),
            None,
            self.fence.clone(),
        ))
    }
}
impl BoundRecordStore for Store {
    async fn flush_editors(&self, _: &WorkspaceBinding, _: &RecordTarget) -> AgentResult<()> {
        panic!("File writes must not flush a Record editor")
    }
    async fn submission_lock(
        &self,
        _: &WorkspaceBinding,
        _: &RecordTarget,
    ) -> AgentResult<Option<tokio::sync::OwnedMutexGuard<()>>> {
        panic!("File writes must not acquire a Record submission lock")
    }
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        action(&self.binding, &self.db.lock().unwrap())
    }
}
impl BoundSourceStore for Store {
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        action(&self.binding, &self.db.lock().unwrap())
    }
}
struct NoRecordWorker;
impl DocumentUtility for NoRecordWorker {
    async fn request(&self, _: &str, _: &str, _: Value) -> AgentResult<Value> {
        panic!("File output must never call the Record worker")
    }
}
struct Fixture {
    _root: tempfile::TempDir,
    store: Store,
    project_id: i64,
    model: RequestContext,
    gui: RequestContext,
}
fn fixture(mode: ExecutionMode) -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let (metadata, paths) = crate::workspace::create_workspace(root.path(), "password").unwrap();
    let db = Database::open(&paths.db_path, root.path(), None).unwrap();
    let project = db
        .project_create(crate::models::ProjectCreateInput {
            name: "File integration".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let binding = WorkspaceBinding {
        workspace_id: metadata.workspace_id,
        generation: "file-dispatch-fixture".into(),
    };
    let gui = RequestContext {
        binding: binding.clone(),
        caller: Caller::Gui,
        request_id: "gui-request".into(),
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: false,
            project_ids: vec![project.id],
            operations: [
                "session.read",
                "session.write",
                "run.start",
                "output.stage",
                "output.read",
                "output.update",
                "output.commit",
                "source.read",
                "content.create",
                "file.update",
                "file.restore",
                "operation.read",
                "operation.undo",
                "operation.restore_created",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        },
    };
    let scope = Scope::Project {
        project_id: project.id,
    };
    let session = db
        .agent_session_create(&gui, &binding, &scope, "Files", "pi", None)
        .unwrap();
    let run = db
        .agent_run_prepare(
            &gui,
            &binding,
            &session.id,
            "user-message",
            &RunPreparation {
                run_id: "f".repeat(32),
                context_manifest: json!({"scope":scope,"mode":mode}),
            },
        )
        .unwrap()
        .run;
    db.agent_run_start(&gui, &binding, &run.id).unwrap();
    let model = RequestContext {
        caller: Caller::BuiltinRun { run_id: run.id },
        request_id: "create".into(),
        ..gui.clone()
    };
    Fixture {
        _root: root,
        store: Store {
            binding,
            paths,
            db: Mutex::new(db),
            fence: Arc::new(WorkspaceCommitFence::new()),
            published: Mutex::new(vec![]),
        },
        project_id: project.id,
        model,
        gui,
    }
}
fn create(project_id: i64, name: &str) -> Value {
    json!({"intent":{"intent":"file_create","projectId":project_id,"safeName":name,"utf8Content":ORIGINAL},"sources":[]})
}
async fn call(f: &Fixture, request: &RequestContext, method: &str, input: Value) -> Value {
    dispatch_output(&f.store, &NoRecordWorker, request, method, input)
        .await
        .unwrap()
}
fn request(f: &Fixture, id: &str) -> RequestContext {
    RequestContext {
        request_id: id.into(),
        ..f.model.clone()
    }
}
fn sql(f: &Fixture, statement: &str) -> i64 {
    rusqlite::Connection::open(&f.store.paths.db_path)
        .unwrap()
        .query_row(statement, [], |r| r.get(0))
        .unwrap()
}
fn file(f: &Fixture, object: &Value) -> (PathBuf, u32) {
    let object: ObjectRef = serde_json::from_value(object.clone()).unwrap();
    let host = f.store.gui_commit_host(&f.model.binding).unwrap();
    let record = host
        .database()
        .unwrap()
        .file_version_registered_target(&f.model, host.binding(), &object)
        .unwrap();
    (
        record.managed_path.into(),
        record.current_version_number.try_into().unwrap(),
    )
}
async fn source(
    f: &Fixture,
    object: &Value,
    version: u32,
    hash: &str,
) -> crate::file_source_read::FileSourcePage {
    crate::file_source_read::FileSourceReadService::new(&f.store)
        .read(
            &f.model,
            &super::file_tools::FileSourceReadInput {
                object: serde_json::from_value::<ObjectRef>(object.clone()).unwrap(),
                version_number: version,
                expected_content_hash: Some(hash.into()),
                cursor: None,
                budget_chars: Some(4000),
            },
        )
        .await
        .unwrap()
}
fn patch(object: &Value, version: u32, hash: &str, old: &str, new: &str) -> Value {
    json!({"intent":{"intent":"file_patch","patch":{"object":object,"expectedVersionNumber":version,"expectedContentHash":hash,"edits":[{"oldText":old,"newText":new,"occurrence":1}],"appendText":null}},"sources":[]})
}
#[tokio::test]
async fn file_dispatch_collaborate_exact_source_replay_no_change_undo_and_created_recovery() {
    let f = fixture(ExecutionMode::Collaborate);
    let input = create(f.project_id, "exact.html");
    let created = call(&f, &f.model, "output.stage", input.clone()).await;
    assert_eq!(created["state"], "committed");
    assert_eq!(created["fileReceipt"]["versionNumber"], 1);
    assert_eq!(created["undoAvailable"], true);
    let (_, version) = file(&f, &created["object"]);
    assert_eq!(version, 1);
    assert_eq!(
        std::fs::read(file(&f, &created["object"]).0).unwrap(),
        ORIGINAL.as_bytes()
    );
    let replay = call(&f, &f.model, "output.stage", input).await;
    assert_eq!(replay["operationId"], created["operationId"]);
    assert_eq!(sql(&f, "SELECT COUNT(*) FROM document_versions"), 1);
    let page = source(
        &f,
        &created["object"],
        1,
        created["fileReceipt"]["contentHash"].as_str().unwrap(),
    )
    .await;
    assert_eq!(page.text, ORIGINAL);
    assert!(page.complete);
    let change = patch(
        &created["object"],
        1,
        &page.content_hash,
        "original",
        "changed",
    );
    let patched = call(&f, &request(&f, "patch"), "output.stage", change.clone()).await;
    assert_eq!(patched["fileReceipt"]["versionNumber"], 2);
    assert_eq!(
        std::fs::read(file(&f, &created["object"]).0).unwrap(),
        ORIGINAL.replace("original", "changed").as_bytes()
    );
    assert_eq!(
        source(&f, &created["object"], 1, &page.content_hash)
            .await
            .text,
        ORIGINAL
    );
    let replay = call(&f, &request(&f, "patch"), "output.stage", change).await;
    assert_eq!(replay["operationId"], patched["operationId"]);
    assert_eq!(file(&f, &created["object"]).1, 2);
    let unchanged = call(
        &f,
        &request(&f, "no-change"),
        "output.stage",
        patch(
            &created["object"],
            2,
            patched["fileReceipt"]["contentHash"].as_str().unwrap(),
            "changed",
            "changed",
        ),
    )
    .await;
    assert_eq!(unchanged["fileReceipt"]["noChange"], true);
    assert_eq!(unchanged["undoAvailable"], false);
    assert_eq!(file(&f, &created["object"]).1, 2);
    let undo_input = json!({"operationId":patched["operationId"],"expectedHeadRevision":2});
    let undone = call(
        &f,
        &request(&f, "undo-patch"),
        "operation.undo",
        undo_input.clone(),
    )
    .await;
    assert_eq!(undone["afterVersionNumber"], 3);
    assert_eq!(
        std::fs::read(file(&f, &created["object"]).0).unwrap(),
        ORIGINAL.as_bytes()
    );
    assert_eq!(
        call(
            &f,
            &request(&f, "undo-patch-retry"),
            "operation.undo",
            undo_input
        )
        .await["operationId"],
        undone["operationId"]
    );
    assert_eq!(file(&f, &created["object"]).1, 3);
    let separate = call(
        &f,
        &request(&f, "create-withdrawal"),
        "output.stage",
        create(f.project_id, "recover.txt"),
    )
    .await;
    let withdrawn = call(
        &f,
        &request(&f, "withdraw"),
        "operation.undo",
        json!({"operationId":separate["operationId"],"expectedHeadRevision":1}),
    )
    .await;
    assert_eq!(withdrawn["withdrawn"], true);
    assert!(matches!(f.model.caller, Caller::BuiltinRun { .. }));
    let historical = crate::file_source_read::FileSourceReadService::new(&f.store)
        .read(
            &f.gui,
            &super::file_tools::FileSourceReadInput {
                object: serde_json::from_value(separate["object"].clone()).unwrap(),
                version_number: 1,
                expected_content_hash: Some(
                    separate["fileReceipt"]["contentHash"]
                        .as_str()
                        .unwrap()
                        .into(),
                ),
                cursor: None,
                budget_chars: Some(4000),
            },
        )
        .await
        .unwrap();
    assert_eq!(historical.text, ORIGINAL);
    assert!(historical.complete);
    assert_eq!(
        source_error(
            &f,
            &separate["object"],
            separate["fileReceipt"]["contentHash"].as_str().unwrap()
        )
        .await,
        ErrorCode::ObjectWithdrawn
    );
    let restored=call(&f,&request(&f,"restore"),"operation.restore_created",json!({"creationOperationId":separate["operationId"],"expectedWithdrawalRevision":withdrawn["revision"]})).await;
    assert_eq!(restored["withdrawn"], false);
    assert_eq!(
        std::fs::read(file(&f, &separate["object"]).0).unwrap(),
        ORIGINAL.as_bytes()
    );
    let operation = call(
        &f,
        &f.model,
        "operation.get",
        json!({"operationId":patched["operationId"]}),
    )
    .await;
    assert_eq!(operation["undoState"], "undone");
    let output = call(
        &f,
        &f.model,
        "output.get",
        json!({"outputId":patched["outputId"]}),
    )
    .await;
    assert_eq!(output["fileReceipt"], patched["fileReceipt"]);
    assert!(f.store.published.lock().unwrap().len() >= 5);
    assert_eq!(
        std::fs::read_dir(
            f.store
                .paths
                .root_path
                .join(".project-mind/file-import-journal")
        )
        .unwrap()
        .count(),
        0
    );
}
async fn source_error(f: &Fixture, object: &Value, hash: &str) -> ErrorCode {
    crate::file_source_read::FileSourceReadService::new(&f.store)
        .read(
            &f.model,
            &super::file_tools::FileSourceReadInput {
                object: serde_json::from_value(object.clone()).unwrap(),
                version_number: 1,
                expected_content_hash: Some(hash.into()),
                cursor: None,
                budget_chars: Some(4000),
            },
        )
        .await
        .unwrap_err()
        .code
}
#[tokio::test]
async fn file_dispatch_review_upload_gui_adoption_and_cancel_leave_business_bytes_authoritative() {
    use base64::Engine;
    let f = fixture(ExecutionMode::Review);
    let staged = call(
        &f,
        &f.model,
        "output.stage",
        create(f.project_id, "review.html"),
    )
    .await;
    assert_eq!(staged["state"], "staged");
    assert!(staged["operationId"].is_null());
    assert_eq!(sql(&f, "SELECT COUNT(*) FROM documents"), 0);
    assert_eq!(
        dispatch_output(
            &f.store,
            &NoRecordWorker,
            &f.model,
            "output.commit",
            json!({"outputId":staged["outputId"],"expectedRevision":1})
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::ScopeDenied
    );
    let committed = call(
        &f,
        &f.gui,
        "output.commit",
        json!({"outputId":staged["outputId"],"expectedRevision":1}),
    )
    .await;
    assert_eq!(committed["outputId"], staged["outputId"]);
    assert_eq!(committed["state"], "committed");
    let (_, version) = file(&f, &committed["object"]);
    assert_eq!(version, 1);
    let bytes = "\u{feff}<script>uploaded</script>\r\n新正文\r\n".as_bytes();
    let hash = format!("sha256:{:x}", <sha2::Sha256 as sha2::Digest>::digest(bytes));
    let upload_request = request(&f, "upload-begin");
    let ticket=call(&f,&upload_request,"file.content.begin",json!({"object":committed["object"],"expectedVersionNumber":1,"expectedContentHash":committed["fileReceipt"]["contentHash"],"length":bytes.len(),"contentHash":hash})).await;
    let content_id = &ticket["stagedContentId"];
    call(&f,&request(&f,"upload-chunk"),"file.content.chunk",json!({"stagedContentId":content_id,"offset":0,"dataBase64":base64::engine::general_purpose::STANDARD.encode(bytes)})).await;
    let ready = call(
        &f,
        &request(&f, "upload-complete"),
        "file.content.complete",
        json!({"stagedContentId":content_id}),
    )
    .await;
    assert_eq!(ready["ready"], true);
    let candidate=call(&f,&request(&f,"upload-stage"),"output.stage",json!({"intent":{"intent":"file_update","target":committed["object"],"expectedVersion":1,"expectedHash":committed["fileReceipt"]["contentHash"],"stagedContentId":content_id},"sources":[]})).await;
    assert_eq!(candidate["state"], "staged");
    assert_eq!(
        std::fs::read(file(&f, &committed["object"]).0).unwrap(),
        ORIGINAL.as_bytes()
    );
    assert_eq!(sql(&f, "SELECT COUNT(*) FROM document_versions"), 1);
    let adopted = call(
        &f,
        &RequestContext {
            request_id: "gui-adopt-upload".into(),
            ..f.gui.clone()
        },
        "output.commit",
        json!({"outputId":candidate["outputId"],"expectedRevision":1}),
    )
    .await;
    assert_eq!(adopted["outputId"], candidate["outputId"]);
    assert_eq!(adopted["fileReceipt"]["versionNumber"], 2);
    assert_eq!(
        std::fs::read(file(&f, &committed["object"]).0).unwrap(),
        bytes
    );
    let replay = call(
        &f,
        &f.gui,
        "output.commit",
        json!({"outputId":candidate["outputId"],"expectedRevision":1}),
    )
    .await;
    assert_eq!(replay["operationId"], adopted["operationId"]);
    assert_eq!(file(&f, &committed["object"]).1, 2);
    let cancel = call(
        &f,
        &request(&f, "cancel-stage"),
        "output.stage",
        create(f.project_id, "cancelled.md"),
    )
    .await;
    // Same trusted GUI candidate interface used by agent_output_dismiss; no model dismiss tool exists.
    let dismissed = BoundRecordStore::with_current(&f.store, |binding, db| {
        db.agent_output_dismiss(
            &RequestContext {
                request_id: "gui-cancel".into(),
                ..f.gui.clone()
            },
            binding,
            cancel["outputId"].as_str().unwrap(),
            1,
        )
    })
    .unwrap();
    assert!(dismissed.dismissed);
    assert!(dispatch_output(
        &f.store,
        &NoRecordWorker,
        &f.gui,
        "output.commit",
        json!({"outputId":cancel["outputId"],"expectedRevision":dismissed.staged.revision})
    )
    .await
    .is_err());
    assert_eq!(sql(&f, "SELECT COUNT(*) FROM documents"), 1);
    assert_eq!(sql(&f, "SELECT COUNT(*) FROM document_versions"), 2);
    assert_eq!(
        std::fs::read(file(&f, &committed["object"]).0).unwrap(),
        bytes
    );
    assert_eq!(
        call(
            &f,
            &f.model,
            "output.get",
            json!({"outputId":cancel["outputId"]})
        )
        .await["dismissed"],
        true
    );
    let stale = dispatch_output(
        &f.store,
        &NoRecordWorker,
        &request(&f, "stale-file-baseline"),
        "output.stage",
        patch(
            &committed["object"],
            1,
            committed["fileReceipt"]["contentHash"].as_str().unwrap(),
            "original",
            "stale",
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(stale.code, ErrorCode::RevisionConflict);
    assert_eq!(
        std::fs::read(file(&f, &committed["object"]).0).unwrap(),
        bytes
    );
    let readonly = fixture(ExecutionMode::ReadOnly);
    assert_eq!(
        dispatch_output(
            &readonly.store,
            &NoRecordWorker,
            &readonly.model,
            "output.stage",
            create(readonly.project_id, "blocked.md")
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::ScopeDenied
    );
    assert_eq!(sql(&readonly, "SELECT COUNT(*) FROM documents"), 0);
}
