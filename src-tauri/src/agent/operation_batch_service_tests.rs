use super::*;
use crate::{
    agent::{
        access::{Caller, ScopeGrant},
        conversation::{RunPreparation, RunSettlement},
        models::{ExecutionMode, Scope, WorkspaceBinding},
        output_tools::dispatch_output,
        runtime::RunState,
    },
    committed_changes::{CommittedChangePublisher, CommittedChanges},
    db::Database,
    file_version_service::{BoundFileCommitStore, FileCommitHost},
    record_documents::RecordTarget,
    workspace_commit_fence::WorkspaceCommitFence,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

struct Store {
    binding: WorkspaceBinding,
    paths: crate::workspace::WorkspacePaths,
    db: Mutex<Database>,
    fence: Arc<WorkspaceCommitFence>,
    published: Mutex<Vec<CommittedChanges>>,
}
impl CommittedChangePublisher for Store {
    fn publish_committed(&self, changes: CommittedChanges) {
        assert!(self.db.try_lock().is_ok());
        self.published.lock().unwrap().push(changes);
    }
}
impl BoundRecordStore for Store {
    async fn flush_editors(&self, _: &WorkspaceBinding, _: &RecordTarget) -> AgentResult<()> {
        panic!("No Record in File batch")
    }
    async fn submission_lock(
        &self,
        _: &WorkspaceBinding,
        _: &RecordTarget,
    ) -> AgentResult<Option<tokio::sync::OwnedMutexGuard<()>>> {
        panic!("No Record in File batch")
    }
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        action(&self.binding, &self.db.lock().unwrap())
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
struct NoRecordWorker;
impl DocumentUtility for NoRecordWorker {
    async fn request(&self, _: &str, _: &str, _: Value) -> AgentResult<Value> {
        panic!("No Record conversion in File batch")
    }
}
struct Fixture {
    _root: tempfile::TempDir,
    store: Store,
    gui: RequestContext,
    model: RequestContext,
    run_id: String,
    session_id: String,
    project_id: i64,
}
fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().canonicalize().unwrap();
    let (metadata, paths) = crate::workspace::create_workspace(&root_path, "password").unwrap();
    let db = Database::open(&paths.db_path, &root_path, None).unwrap();
    let project_id = db
        .project_create(crate::models::ProjectCreateInput {
            name: "Batch service".into(),
            summary: None,
            status: None,
        })
        .unwrap()
        .id;
    let binding = WorkspaceBinding {
        workspace_id: metadata.workspace_id,
        generation: "batch-service".into(),
    };
    let gui = RequestContext {
        binding: binding.clone(),
        caller: Caller::Gui,
        request_id: "gui-batch".into(),
        scope_grant: ScopeGrant {
            object_keys: None,
            workspace_id: binding.workspace_id.clone(),
            workspace_content: false,
            project_ids: vec![project_id],
            operations: [
                "session.read",
                "session.write",
                "run.start",
                "output.stage",
                "output.read",
                "output.commit",
                "source.read",
                "content.create",
                "file.update",
                "file.restore",
                "operation.read",
                "operation.undo",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        },
    };
    let scope = Scope::Project { project_id };
    let session_id = db
        .agent_session_create(&gui, &binding, &scope, "Batch", "pi", None)
        .unwrap()
        .id;
    let run_id = "a".repeat(32);
    db.agent_run_prepare(
        &gui,
        &binding,
        &session_id,
        "message",
        &RunPreparation {
            run_id: run_id.clone(),
            context_manifest: json!({"scope":scope,"mode":ExecutionMode::Collaborate}),
        },
    )
    .unwrap();
    db.agent_run_start(&gui, &binding, &run_id).unwrap();
    let model = RequestContext {
        caller: Caller::BuiltinRun {
            run_id: run_id.clone(),
        },
        request_id: "stage".into(),
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
        gui,
        model,
        run_id,
        session_id,
        project_id,
    }
}
async fn stage(f: &Fixture, request_id: &str, intent: Value) -> Value {
    let request = RequestContext {
        request_id: request_id.into(),
        ..f.model.clone()
    };
    dispatch_output(
        &f.store,
        &NoRecordWorker,
        &request,
        "output.stage",
        json!({"intent":intent,"sources":[]}),
    )
    .await
    .unwrap()
}
fn patch(object: &Value, version: u64, hash: &str, old: &str, new: &str) -> Value {
    json!({"intent":"file_patch","patch":{"object":object,"expectedVersionNumber":version,"expectedContentHash":hash,"edits":[{"oldText":old,"newText":new,"occurrence":1}],"appendText":null}})
}
#[tokio::test]
async fn real_file_batch_reports_partial_conflict_excludes_no_change_and_replays_after_session_delete(
) {
    let f = fixture();
    let a = stage(&f, "create-a", json!({"intent":"file_create","projectId":f.project_id,"safeName":"batch-a.txt","utf8Content":"original"})).await;
    let b = stage(&f, "create-b", json!({"intent":"file_create","projectId":f.project_id,"safeName":"batch-b.txt","utf8Content":"original"})).await;
    let a1 = stage(
        &f,
        "a-change",
        patch(
            &a["object"],
            1,
            a["fileReceipt"]["contentHash"].as_str().unwrap(),
            "original",
            "changed",
        ),
    )
    .await;
    let a_no_change = stage(
        &f,
        "a-no-change",
        patch(
            &a["object"],
            2,
            a1["fileReceipt"]["contentHash"].as_str().unwrap(),
            "changed",
            "changed",
        ),
    )
    .await;
    assert_eq!(a_no_change["fileReceipt"]["noChange"], true);
    let b1 = stage(
        &f,
        "b-change",
        patch(
            &b["object"],
            1,
            b["fileReceipt"]["contentHash"].as_str().unwrap(),
            "original",
            "changed",
        ),
    )
    .await;
    stage(
        &f,
        "b-later",
        patch(
            &b["object"],
            2,
            b1["fileReceipt"]["contentHash"].as_str().unwrap(),
            "changed",
            "later",
        ),
    )
    .await;
    let input = OperationUndoBatchInput {
        run_id: f.run_id.clone(),
        operation_ids: [&b1, &a_no_change, &a1]
            .into_iter()
            .map(|value| value["operationId"].as_str().unwrap().to_owned())
            .collect(),
    };
    {
        let db = f.store.db.lock().unwrap();
        db.agent_run_settle(
            &f.gui,
            &f.gui.binding,
            &f.run_id,
            &RunSettlement {
                state: RunState::Interrupted,
                runtime_settled: false,
                projection: None,
                usage: None,
                error_code: None,
            },
        )
        .unwrap();
        db.agent_session_delete(&f.gui, &f.gui.binding, &f.session_id)
            .unwrap();
        assert_eq!(
            db.agent_operation_run_scopes(&f.gui.binding, &f.run_id)
                .unwrap()
                .len(),
            1
        );
    }
    let published_before = f.store.published.lock().unwrap().len();
    let result = undo_batch(&f.store, &NoRecordWorker, &f.gui, &input)
        .await
        .unwrap();
    assert_eq!(
        result.excluded_no_change_ids,
        vec![a_no_change["operationId"].as_str().unwrap()]
    );
    assert_eq!(result.results.len(), 2);
    assert!(matches!(
        &result.results[0].outcome,
        OperationUndoBatchOutcome::Succeeded {
            result: OperationUndoResult::ModifiedFile(_)
        }
    ));
    assert!(
        matches!(&result.results[1].outcome, OperationUndoBatchOutcome::Failed { error } if error.code == ErrorCode::UndoConflict)
    );
    let encoded = serde_json::to_value(&result).unwrap();
    assert_eq!(encoded["results"][0]["outcome"]["status"], "succeeded");
    assert_eq!(encoded["results"][1]["outcome"]["status"], "failed");
    assert_eq!(
        encoded["excludedNoChangeIds"][0],
        a_no_change["operationId"]
    );
    let replay = undo_batch(&f.store, &NoRecordWorker, &f.gui, &input)
        .await
        .unwrap();
    assert!(matches!(
        &replay.results[0].outcome,
        OperationUndoBatchOutcome::Succeeded {
            result: OperationUndoResult::ModifiedFile(_)
        }
    ));
    assert_eq!(
        f.store.published.lock().unwrap().len(),
        published_before + 1
    );
}
