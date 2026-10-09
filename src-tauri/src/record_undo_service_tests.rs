//! Creation undo must coordinate resident editors before changing visibility.
use super::*;
use crate::{
    agent::{
        access::ScopeGrant,
        conversation::RunPreparation,
        models::Scope,
        operations::{OperationUndoInput, OperationUndoResult},
        output_runtime::StageRecordInput,
        outputs::OutputIntent,
    },
    committed_changes::{CommittedChangePublisher, CommittedChanges},
    record_documents::{body_hash, RecordCreate},
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};

struct Store {
    binding: WorkspaceBinding,
    db: Arc<Mutex<Database>>,
    db_path: std::path::PathBuf,
    flush_calls: AtomicUsize,
    submission_calls: AtomicUsize,
    flush_error: Mutex<Option<ErrorCode>>,
    draft: Mutex<Option<RecordDocumentProjection>>,
    events: Mutex<Vec<CommittedChanges>>,
}
impl CommittedChangePublisher for Store {
    fn publish_committed(&self, changes: CommittedChanges) {
        assert!(self.db.try_lock().is_ok());
        self.events.lock().unwrap().push(changes);
    }
}
impl BoundRecordStore for Store {
    async fn flush_editors(
        &self,
        binding: &WorkspaceBinding,
        target: &RecordTarget,
    ) -> AgentResult<()> {
        assert_eq!(binding, &self.binding);
        self.flush_calls.fetch_add(1, Ordering::Relaxed);
        if let Some(code) = *self.flush_error.lock().unwrap() {
            return Err(AgentError::new(code, "Editor has an unresolved review"));
        }
        if let Some(draft) = self.draft.lock().unwrap().take() {
            let db = self.db.lock().unwrap();
            let head = db.record_document_head(target)?.unwrap();
            db.record_document_commit(
                "gui",
                "flush-user-draft",
                &RecordDocumentCommit {
                    target: target.clone(),
                    base_revision: head.head_revision,
                    projection: draft,
                    origin: RecordVersionOrigin::Manual,
                    actor: json!({"kind":"gui"}),
                    edit_session_id: Some("e".repeat(32)),
                },
                &binding.workspace_id,
            )?;
        }
        Ok(())
    }
    async fn submission_lock(
        &self,
        _: &WorkspaceBinding,
        _: &RecordTarget,
    ) -> AgentResult<Option<tokio::sync::OwnedMutexGuard<()>>> {
        self.submission_calls.fetch_add(1, Ordering::Relaxed);
        Ok(None)
    }
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        action(&self.binding, &self.db.lock().unwrap())
    }
}
struct NoUtility;
impl DocumentUtility for NoUtility {
    async fn request(&self, _: &str, _: &str, _: Value) -> AgentResult<Value> {
        panic!("Creation withdrawal does not convert or rewrite the Record body");
    }
}
fn projection(text: &str) -> RecordDocumentProjection {
    let document = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"content":[{"type":"text","text":text}]}]});
    RecordDocumentProjection {
        schema_version: 1,
        body_hash: body_hash(&document, &None),
        document,
        html: format!("<p data-block-id=\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\">{text}</p>"),
        markdown: text.into(),
        text: text.into(),
        code_language: None,
    }
}
fn setup() -> (
    tempfile::TempDir,
    Store,
    RequestContext,
    OperationUndoInput,
    RecordTarget,
) {
    let root = tempfile::tempdir().unwrap();
    let mut db =
        Database::open(&root.path().join("service-undo.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace("undo-workspace").unwrap();
    let binding = WorkspaceBinding {
        workspace_id: "undo-workspace".into(),
        generation: "one".into(),
    };
    let mut request = RequestContext {
        binding: binding.clone(),
        caller: Caller::Gui,
        request_id: "session".into(),
        scope_grant: ScopeGrant {
            object_keys: None,
            workspace_id: binding.workspace_id.clone(),
            workspace_content: true,
            project_ids: vec![],
            operations: [
                "session.read",
                "session.write",
                "run.start",
                "output.stage",
                "output.commit",
                "content.create",
                "source.read",
                "operation.read",
                "operation.undo",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
        },
    };
    let session = db
        .agent_session_create(&request, &binding, &Scope::Workspace, "Undo", "pi", None)
        .unwrap();
    let run = "1234567890abcdef1234567890abcdef".to_string();
    db.agent_run_prepare(
        &request,
        &binding,
        &session.id,
        "create",
        &RunPreparation {
            run_id: run.clone(),
            context_manifest: json!({"scope":Scope::Workspace,"mode":"collaborate"}),
        },
    )
    .unwrap();
    db.agent_run_start(&request, &binding, &run).unwrap();
    request.caller = Caller::BuiltinRun { run_id: run };
    request.request_id = "stage".into();
    let staged = db
        .agent_output_stage_record(
            &request,
            &binding,
            &StageRecordInput {
                intent: OutputIntent::RecordCreate {
                    scope: Scope::Workspace,
                    title: "Original".into(),
                    markdown: "Committed body".into(),
                },
                sources: vec![],
            },
        )
        .unwrap();
    let prepared = db
        .agent_output_commit_prepare(&request, &binding, &staged.staged.id, 1)
        .unwrap();
    let body = projection("Committed body");
    let head = db
        .record_create(
            &request.caller.key(),
            &prepared.commit_request_id,
            &RecordCreate {
                scope: Scope::Workspace,
                title: Some("Original".into()),
                tag_ids: vec![],
                document: body.document.clone(),
                code_language: None,
            },
            &body,
            &binding.workspace_id,
        )
        .unwrap();
    request.caller = Caller::Gui;
    request.request_id = "undo-create".into();
    let page = db
        .agent_operation_list(
            &request,
            &binding,
            &crate::agent::operations::OperationListInput {
                run_id: staged.staged.run_id,
                cursor: None,
                limit: 50,
            },
        )
        .unwrap();
    let input = OperationUndoInput {
        operation_id: page.operations[0].operation_id.clone(),
        expected_head_revision: head.head_revision,
    };
    let store = Store {
        binding,
        db: Arc::new(Mutex::new(db)),
        db_path: root.path().join("service-undo.sqlite"),
        flush_calls: AtomicUsize::new(0),
        submission_calls: AtomicUsize::new(0),
        flush_error: Mutex::new(None),
        draft: Mutex::new(None),
        events: Mutex::new(vec![]),
    };
    (root, store, request, input, head.target)
}
fn receipt_count(store: &Store) -> i64 {
    let conn = rusqlite::Connection::open_with_flags(
        &store.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    conn.query_row("SELECT COUNT(*) FROM agent_operation_receipts", [], |r| {
        r.get(0)
    })
    .unwrap()
}

fn assert_visible(
    store: &Store,
    request: &RequestContext,
    input: &OperationUndoInput,
    target: &RecordTarget,
    text: &str,
) {
    store
        .with_current(|binding, db| {
            let entry = db.agent_operation_get(request, binding, &input.operation_id)?;
            assert_eq!(entry.undo_state, "available");
            assert!(!entry.recovery.unwrap().withdrawn);
            assert_eq!(
                db.record_document_head(target)?.unwrap().projection.text,
                text
            );
            Ok(())
        })
        .unwrap();
    let mut db = store.db.lock().unwrap();
    assert!(db
        .workspace_record_list()
        .unwrap()
        .iter()
        .any(|r| r.id == target.record_id));
}

#[tokio::test]
async fn creation_undo_flushes_new_user_draft_and_preserves_it_on_conflict() {
    let (_root, store, request, input, target) = setup();
    *store.draft.lock().unwrap() = Some(projection("Unsaved user draft 用户新改动"));
    let service = RecordDocumentService::new(&store, &NoUtility);
    let error = service.undo_operation(&request, &input).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::UndoConflict, "{error:?}");
    assert_eq!(store.flush_calls.load(Ordering::Relaxed), 1);
    assert_eq!(store.submission_calls.load(Ordering::Relaxed), 1);
    assert_visible(
        &store,
        &request,
        &input,
        &target,
        "Unsaved user draft 用户新改动",
    );
    let conn = rusqlite::Connection::open_with_flags(
        &store.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM agent_operation_receipts WHERE operation='record.withdraw')",[],|r|r.get(0)).unwrap();
    assert!(!exists);
}
#[tokio::test]
async fn creation_undo_review_pending_keeps_original_body_and_has_no_receipt() {
    let (_root, store, request, input, target) = setup();
    let count = receipt_count(&store);
    *store.flush_error.lock().unwrap() = Some(ErrorCode::EditorReviewPending);
    let service = RecordDocumentService::new(&store, &NoUtility);
    assert_eq!(
        service
            .undo_operation(&request, &input)
            .await
            .unwrap_err()
            .code,
        ErrorCode::EditorReviewPending
    );
    assert_eq!(store.flush_calls.load(Ordering::Relaxed), 1);
    assert_eq!(store.submission_calls.load(Ordering::Relaxed), 0);
    assert_eq!(receipt_count(&store), count);
    assert_visible(&store, &request, &input, &target, "Committed body");
}
#[tokio::test]
async fn creation_undo_retry_skips_hidden_editor_flush_and_keeps_same_receipt() {
    let (_root, store, request, input, target) = setup();
    let service = RecordDocumentService::new(&store, &NoUtility);
    let first = service.undo_operation(&request, &input).await.unwrap();
    let OperationUndoResult::CreatedRecord(first) = first else {
        panic!("withdrawal receipt");
    };
    assert!(first.withdrawn);
    let count = receipt_count(&store);
    let events = store.events.lock().unwrap().len();
    *store.flush_error.lock().unwrap() = Some(ErrorCode::EditorReviewPending);
    let OperationUndoResult::CreatedRecord(retry) =
        service.undo_operation(&request, &input).await.unwrap()
    else {
        panic!("withdrawal receipt");
    };
    assert_eq!(retry.operation_id, first.operation_id);
    assert_eq!(store.flush_calls.load(Ordering::Relaxed), 1);
    assert_eq!(store.submission_calls.load(Ordering::Relaxed), 1);
    assert_eq!(receipt_count(&store), count);
    assert_eq!(store.events.lock().unwrap().len(), events);
    let mut db = store.db.lock().unwrap();
    assert!(!db
        .workspace_record_list()
        .unwrap()
        .iter()
        .any(|r| r.id == target.record_id));
}
