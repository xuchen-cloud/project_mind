use super::*;
use crate::{
    agent::{
        access::Caller,
        conversation::{RunPreparation, RunSettlement},
        output_runtime::StageRecordInput,
        outputs::OutputIntent,
        runtime::RunState,
    },
    committed_changes::{CommittedChangePublisher, CommittedChanges},
    db::file_imports::AgentFileCreateInput,
    file_text_patch::{FileTextPatch, TextEdit},
    file_version_service::{
        BoundFileCommitStore, FileCommitHost, FileVersionService, FilesystemFileReader,
    },
    models::{
        DocumentAddVersionInput, DocumentUpdateMetaInput, InternalReferenceResolveInput,
        ProjectCreateInput, TodoCreateInput, TodoScope,
    },
    workspace::{create_workspace, WorkspacePaths},
    workspace_commit_fence::WorkspaceCommitFence,
};
use std::{
    fs,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
struct Store {
    paths: WorkspacePaths,
    binding: WorkspaceBinding,
    fence: Arc<WorkspaceCommitFence>,
    published: AtomicUsize,
}
impl CommittedChangePublisher for Store {
    fn publish_committed(&self, _: CommittedChanges) {
        self.published.fetch_add(1, Ordering::Relaxed);
    }
}
impl BoundFileCommitStore for Store {
    fn gui_commit_host(&self, binding: &WorkspaceBinding) -> AgentResult<FileCommitHost> {
        if *binding != self.binding {
            return Err(AgentError::new(ErrorCode::WorkspaceChanged, "Reopened"));
        }
        Ok(FileCommitHost::for_test(
            self.binding.clone(),
            self.paths.clone(),
            None,
            self.fence.clone(),
        ))
    }
}
struct Fixture {
    _root: tempfile::TempDir,
    store: Store,
    request: RequestContext,
    object: ObjectRef,
    creation: String,
    session: String,
    run: String,
}
fn open_db(f: &Fixture) -> Database {
    f.store
        .gui_commit_host(&f.request.binding)
        .unwrap()
        .database()
        .unwrap()
}
fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let (metadata, paths) = create_workspace(root.path(), "password").unwrap();
    let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
    db.bind_native_workspace(&metadata.workspace_id).unwrap();
    let project = db
        .project_create(ProjectCreateInput {
            name: "File recovery".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let binding = WorkspaceBinding {
        workspace_id: metadata.workspace_id,
        generation: "one".into(),
    };
    let mut request = RequestContext {
        binding: binding.clone(),
        caller: Caller::Gui,
        request_id: "session".into(),
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: false,
            project_ids: vec![project.id],
            operations: [
                "operation.read",
                "operation.undo",
                "operation.restore_created",
                "content.create",
                "file.update",
                "file.restore",
                "source.read",
                "session.read",
                "session.write",
                "run.start",
                "output.stage",
                "output.read",
                "output.commit",
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
        .agent_session_create(&request, &binding, &scope, "Files", "pi", None)
        .unwrap();
    let run = "a".repeat(32);
    db.agent_run_prepare(
        &request,
        &binding,
        &session.id,
        "initial-run",
        &RunPreparation {
            run_id: run.clone(),
            context_manifest: json!({"scope":scope,"mode":"collaborate"}),
        },
    )
    .unwrap();
    db.agent_run_start(&request, &binding, &run).unwrap();
    request.caller = Caller::BuiltinRun {
        run_id: run.clone(),
    };
    request.request_id = "stage-create".into();
    let input = AgentFileCreateInput {
        project_id: project.id,
        safe_name: "result.txt".into(),
        utf8_content: "Before bytes\r\n".into(),
    };
    let output = db
        .agent_output_stage_record(
            &request,
            &binding,
            &StageRecordInput {
                intent: OutputIntent::FileCreate {
                    project_id: input.project_id,
                    safe_name: input.safe_name.clone(),
                    utf8_content: input.utf8_content.clone(),
                },
                sources: vec![],
            },
        )
        .unwrap();
    let prepared = db
        .agent_output_commit_prepare(&request, &binding, &output.staged.id, 1)
        .unwrap();
    request.request_id = prepared.commit_request_id;
    let fence = Arc::new(WorkspaceCommitFence::new());
    let created = db
        .agent_file_create_bound(&request, &binding, &input, &fence)
        .unwrap();
    request.caller = Caller::Gui;
    request.request_id = "recovery".into();
    Fixture {
        _root: root,
        store: Store {
            paths,
            binding,
            fence,
            published: AtomicUsize::new(0),
        },
        request,
        object: created.object,
        creation: created.operation_id,
        session: session.id,
        run,
    }
}
fn modify(f: &Fixture) -> OperationEntry {
    let db = open_db(f);
    let current = db.document_record(file_id(&f.object).unwrap()).unwrap();
    let (hash, _) = registered_version(
        &db.conn,
        &f.object,
        &current_version(&db, file_id(&f.object).unwrap()),
        current.current_version_number as u64,
    )
    .unwrap();
    let patch = FileTextPatch {
        object: f.object.clone(),
        expected_version_number: current.current_version_number as u32,
        expected_content_hash: hash,
        edits: Some(vec![TextEdit {
            old_text: "Before".into(),
            new_text: "Agent after".into(),
            occurrence: None,
        }]),
        append_text: None,
    };
    let mut request = f.request.clone();
    request.caller = Caller::BuiltinRun {
        run_id: f.run.clone(),
    };
    request.request_id = "stage-modify".into();
    let output = db
        .agent_output_stage_record(
            &request,
            &request.binding,
            &StageRecordInput {
                intent: OutputIntent::FilePatch {
                    patch: patch.clone(),
                },
                sources: vec![],
            },
        )
        .unwrap();
    let prepared = db
        .agent_output_commit_prepare(&request, &request.binding, &output.staged.id, 1)
        .unwrap();
    request.request_id = prepared.commit_request_id;
    drop(db);
    FileVersionService::new(&f.store, &FilesystemFileReader)
        .patch_text(&request, &patch)
        .unwrap();
    let db = open_db(f);
    let op: String = db
        .conn
        .query_row(
            "SELECT operation_id FROM agent_operation_receipts WHERE request_id=?1",
            [&request.request_id],
            |r| r.get(0),
        )
        .unwrap();
    db.agent_operation_get(&f.request, &f.request.binding, &op)
        .unwrap()
}
fn current_version(db: &Database, id: i64) -> String {
    db.conn.query_row("SELECT CAST(v.id AS TEXT) FROM document_versions v JOIN documents d ON d.id=v.document_id AND d.current_version_number=v.version_number WHERE d.id=?1",[id],|r|r.get(0)).unwrap()
}
fn count(db: &Database, table: &str) -> i64 {
    db.conn
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
fn undo_input(entry: &OperationEntry) -> OperationUndoInput {
    OperationUndoInput {
        operation_id: entry.operation_id.clone(),
        expected_head_revision: entry.after_revision.unwrap(),
    }
}
fn withdraw(f: &Fixture) -> RecordWithdrawalInput {
    RecordWithdrawalInput {
        creation_operation_id: f.creation.clone(),
    }
}

#[test]
fn file_undo_restores_preoperation_bytes_as_new_version_and_replays_actual_receipt() {
    let mut f = fixture();
    let original = modify(&f);
    f.request
        .scope_grant
        .operations
        .retain(|op| op != "file.restore" && op != "file.update" && op != "source.read");
    let result =
        crate::agent::file_undo::undo_file(&f.store, &f.request, &undo_input(&original)).unwrap();
    let db = open_db(&f);
    let current = db.document_record(file_id(&f.object).unwrap()).unwrap();
    assert_eq!(result.before_version_number, 2);
    assert_eq!(result.after_version_number, 3);
    assert_eq!(
        fs::read(&current.managed_path).unwrap(),
        b"Before bytes\r\n"
    );
    assert_eq!(count(&db, "document_versions"), 3);
    let after = db
        .document_version_record(
            original
                .after_snapshot_ref
                .as_deref()
                .unwrap()
                .parse()
                .unwrap(),
        )
        .unwrap();
    assert_eq!(
        fs::read(after.managed_path).unwrap(),
        b"Agent after bytes\r\n"
    );
    let original = db
        .agent_operation_get(&f.request, &f.request.binding, &original.operation_id)
        .unwrap();
    assert_eq!(original.undo_state, "undone");
    assert_eq!(
        original.undo_operation_id.as_deref(),
        Some(result.operation_id.as_str())
    );
    let watermark = db.committed_change_watermark().unwrap();
    drop(db);
    f.request.request_id = "new-request-same-undo".into();
    let repeated =
        crate::agent::file_undo::undo_file(&f.store, &f.request, &undo_input(&original)).unwrap();
    assert_eq!(repeated.operation_id, result.operation_id);
    assert_eq!(open_db(&f).committed_change_watermark().unwrap(), watermark);
    assert_eq!(f.store.published.load(Ordering::Relaxed), 2);
}
#[test]
fn file_undo_rejects_same_bytes_manual_new_version_and_unregistered_external_bytes() {
    for manual in [false, true] {
        let f = fixture();
        let original = modify(&f);
        let mut db = open_db(&f);
        let current = db.document_record(file_id(&f.object).unwrap()).unwrap();
        if manual {
            db.document_add_version(DocumentAddVersionInput {
                document_id: current.id,
                source_path: None,
            })
            .unwrap();
        } else {
            fs::write(&current.managed_path, b"Unregistered external bytes").unwrap();
        }
        let head = db.document_record(current.id).unwrap();
        let bytes = fs::read(&head.managed_path).unwrap();
        let watermark = db.committed_change_watermark().unwrap();
        let versions = count(&db, "document_versions");
        drop(db);
        let error =
            crate::agent::file_undo::undo_file(&f.store, &f.request, &undo_input(&original))
                .unwrap_err();
        assert_eq!(
            error.code,
            if manual {
                ErrorCode::UndoConflict
            } else {
                ErrorCode::FileChangedUnregistered
            }
        );
        let db = open_db(&f);
        assert_eq!(count(&db, "document_versions"), versions);
        assert_eq!(db.committed_change_watermark().unwrap(), watermark);
        assert_eq!(fs::read(head.managed_path).unwrap(), bytes);
        assert_eq!(
            db.agent_operation_get(&f.request, &f.request.binding, &original.operation_id)
                .unwrap()
                .undo_state,
            "available"
        );
    }
}
#[test]
fn file_creation_withdraw_restore_retains_identity_versions_bytes_and_history_authority() {
    let mut f = fixture();
    let db = open_db(&f);
    let id = file_id(&f.object).unwrap();
    let current = db.document_record(id).unwrap();
    let version = current_version(&db, id);
    let hash = baseline(
        &db.conn,
        &db.agent_operation_get(&f.request, &f.request.binding, &f.creation)
            .unwrap(),
    )
    .unwrap();
    let watermark = db.committed_change_watermark().unwrap();
    let hidden = db
        .agent_file_creation_withdraw(&f.request, &f.request.binding, &withdraw(&f))
        .unwrap();
    assert!(hidden.withdrawn);
    assert_eq!(count(&db, "agent_visible_files"), 0);
    assert_eq!(count(&db, "documents"), 1);
    assert_eq!(count(&db, "document_versions"), 1);
    assert_eq!(
        fs::read(&current.managed_path).unwrap(),
        b"Before bytes\r\n"
    );
    assert_eq!(db.committed_change_watermark().unwrap(), watermark + 1);
    assert_eq!(
        db.source_read_object(&f.request, &f.request.binding, &f.object)
            .unwrap_err()
            .code,
        ErrorCode::ObjectWithdrawn
    );
    db.source_read_historical_file(&f.request, &f.request.binding, &f.object)
        .unwrap();
    let fixed = crate::source_service::SourceReadTarget {
        object: f.object.clone(),
        revision: Some(hash.clone()),
        file_version: Some(1),
        record_version: None,
    };
    assert_eq!(
        db.source_file_plan(&f.request, &f.request.binding, &fixed)
            .unwrap_err()
            .code,
        ErrorCode::ObjectWithdrawn
    );
    assert_eq!(
        db.source_file_history_plan(&f.request, &f.request.binding, &fixed)
            .unwrap()
            .registered_hash,
        hash
    );
    for caller in [
        Caller::BuiltinRun {
            run_id: f.run.clone(),
        },
        Caller::Connection {
            grant_id: "fixed-history".into(),
        },
    ] {
        let mut ai = f.request.clone();
        ai.caller = caller;
        assert_eq!(
            db.source_read_historical_file(&ai, &ai.binding, &f.object)
                .unwrap_err()
                .code,
            ErrorCode::ObjectWithdrawn
        );
        assert_eq!(
            db.source_file_plan(
                &ai,
                &ai.binding,
                &crate::source_service::SourceReadTarget {
                    object: f.object.clone(),
                    revision: Some(hash.clone()),
                    file_version: Some(1),
                    record_version: None,
                }
            )
            .unwrap_err()
            .code,
            ErrorCode::ObjectWithdrawn
        );
    }
    assert_eq!(
        registered_version(&db.conn, &f.object, &version, 1)
            .unwrap()
            .0,
        hash
    );
    let mut excluded = f.request.clone();
    excluded.scope_grant.project_ids.clear();
    assert_eq!(
        db.source_read_historical_file(&excluded, &excluded.binding, &f.object)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    assert!(db
        .internal_reference_resolve(InternalReferenceResolveInput {
            kind: "document".into(),
            id
        })
        .unwrap_err()
        .to_string()
        .contains("OBJECT_WITHDRAWN"));
    assert!(db
        .file_native_write_locks(id)
        .unwrap_err()
        .to_string()
        .contains("withdrawn")); // Reject even a no-change GUI write.
    drop(db);
    let mut db = open_db(&f);
    assert!(db
        .document_update_meta(DocumentUpdateMetaInput {
            document_id: id,
            base_name: None,
            is_starred: None,
            tag_ids: None
        })
        .unwrap_err()
        .to_string()
        .contains("withdrawn"));
    f.request.request_id = "restore-visible".into();
    let restored = db
        .agent_file_creation_restore(
            &f.request,
            &f.request.binding,
            &RecordRestoreInput {
                creation_operation_id: f.creation.clone(),
                expected_withdrawal_revision: hidden.revision,
            },
        )
        .unwrap();
    assert!(!restored.withdrawn);
    assert_eq!(count(&db, "agent_visible_files"), 1);
    assert_eq!(
        fs::read(db.document_record(id).unwrap().managed_path).unwrap(),
        b"Before bytes\r\n"
    );
    assert_eq!(count(&db, "document_versions"), 1);
    assert_eq!(restored.object.id, f.object.id);
    f.request.request_id = "restore-repeat".into();
    assert_eq!(
        db.agent_file_creation_restore(
            &f.request,
            &f.request.binding,
            &RecordRestoreInput {
                creation_operation_id: f.creation.clone(),
                expected_withdrawal_revision: hidden.revision
            }
        )
        .unwrap()
        .operation_id,
        restored.operation_id
    );
}
#[test]
fn file_creation_withdraw_rejects_metadata_external_bytes_and_incoming_references() {
    for reason in ["metadata", "external", "edge", "legacy"] {
        let f = fixture();
        let mut db = open_db(&f);
        let id = file_id(&f.object).unwrap();
        let current = db.document_record(id).unwrap();
        match reason {
            "metadata" => {
                db.document_update_meta(DocumentUpdateMetaInput {
                    document_id: id,
                    base_name: None,
                    is_starred: Some(true),
                    tag_ids: None,
                })
                .unwrap();
            }
            "external" => fs::write(current.managed_path, b"External bytes").unwrap(),
            "edge" => {
                db.conn.execute("INSERT INTO content_reference_edges(source_object_key,target_object_key,relation) VALUES ('consumer',?1,'derived_from')",[f.object.key().unwrap()]).unwrap();
            }
            _ => {
                db.todo_create(TodoCreateInput {
                    scope: TodoScope::Project,
                    project_id: Some(current.project_id),
                    content: format!("[[document:{id}|File result]]"),
                    priority: "normal".into(),
                    due_date: None,
                    tag_ids: vec![],
                })
                .unwrap();
            }
        }
        let watermark = db.committed_change_watermark().unwrap();
        let error = db
            .agent_file_creation_withdraw(&f.request, &f.request.binding, &withdraw(&f))
            .unwrap_err();
        assert_eq!(
            error.code,
            if reason == "external" {
                ErrorCode::FileChangedUnregistered
            } else {
                ErrorCode::UndoConflict
            }
        );
        assert_eq!(count(&db, "agent_object_withdrawals"), 0);
        assert_eq!(db.committed_change_watermark().unwrap(), watermark);
        require_file_visible(&db.conn, id).unwrap();
    }
}
#[test]
fn file_undo_original_authority_survives_real_session_deletion() {
    let f = fixture();
    let original = modify(&f);
    let db = open_db(&f);
    db.agent_run_settle(
        &f.request,
        &f.request.binding,
        &f.run,
        &RunSettlement {
            state: RunState::Interrupted,
            runtime_settled: false,
            projection: None,
            usage: None,
            error_code: None,
        },
    )
    .unwrap();
    assert!(db
        .agent_session_delete(&f.request, &f.request.binding, &f.session)
        .unwrap());
    assert_eq!(count(&db, "agent_runs"), 0);
    drop(db);
    let result =
        crate::agent::file_undo::undo_file(&f.store, &f.request, &undo_input(&original)).unwrap();
    assert_eq!(result.after_version_number, 3);
    let db = open_db(&f);
    assert_eq!(
        fs::read(
            db.document_record(file_id(&f.object).unwrap())
                .unwrap()
                .managed_path
        )
        .unwrap(),
        b"Before bytes\r\n"
    );
}
#[test]
fn file_undo_receipt_failure_rolls_back_original_state_sql_and_managed_bytes() {
    let f = fixture();
    let original = modify(&f);
    let db = open_db(&f);
    let current = db.document_record(file_id(&f.object).unwrap()).unwrap();
    let bytes = fs::read(&current.managed_path).unwrap();
    let watermark = db.committed_change_watermark().unwrap();
    let versions = count(&db, "document_versions");
    db.conn.execute_batch("CREATE TRIGGER reject_file_undo_receipt BEFORE UPDATE OF operation_id ON agent_operation_receipts WHEN NEW.request_id LIKE 'fileundo:%' BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END;").unwrap();
    drop(db);
    assert_eq!(
        crate::agent::file_undo::undo_file(&f.store, &f.request, &undo_input(&original))
            .unwrap_err()
            .code,
        ErrorCode::IoFailed
    );
    let db = open_db(&f);
    assert_eq!(count(&db, "document_versions"), versions);
    assert_eq!(db.committed_change_watermark().unwrap(), watermark);
    assert_eq!(fs::read(&current.managed_path).unwrap(), bytes);
    assert_eq!(
        db.agent_operation_get(&f.request, &f.request.binding, &original.operation_id)
            .unwrap()
            .undo_state,
        "available"
    );
}
