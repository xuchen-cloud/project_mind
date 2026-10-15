use super::*;
use crate::{
    agent::{
        access::{Caller, ScopeGrant},
        conversation::RunPreparation,
        output_runtime::StageRecordInput,
        outputs::{OutputIntent, TodoMutation},
    },
    models::{
        FileTagOptionUpsertInput, InternalReferenceResolveInput, ProjectArchiveInput,
        ProjectCreateInput, TodoAddProgressInput, TodoCreateInput, TodoUpdateContentInput,
        TodoUpdateProgressInput,
    },
};

struct Fixture {
    _root: tempfile::TempDir,
    db: Database,
    request: RequestContext,
    object: ObjectRef,
    before: todo_revisions::TodoRevisionHead,
    operation_id: String,
    run_id: String,
}
fn fixture(project: bool) -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(&root.path().join("todo-undo.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace("todo-workspace").unwrap();
    let project_id = project.then(|| {
        db.project_create(ProjectCreateInput {
            name: "Recovery project".into(),
            summary: None,
            status: None,
        })
        .unwrap()
        .id
    });
    let scope = project_id.map_or(Scope::Workspace, |project_id| Scope::Project { project_id });
    let tag = db
        .file_tag_option_upsert(FileTagOptionUpsertInput {
            project_id,
            id: None,
            label: "Before tag".into(),
            color_key: "blue".into(),
        })
        .unwrap();
    let todo = db
        .todo_create(TodoCreateInput {
            scope: if project {
                TodoScope::Project
            } else {
                TodoScope::Workspace
            },
            project_id,
            content: "Original body".into(),
            priority: "high".into(),
            due_date: Some("2026-11-01".into()),
            tag_ids: vec![tag.id],
        })
        .unwrap();
    let child = db
        .todo_add_progress(TodoAddProgressInput {
            expected_revision: todo.revision,
            todo_id: todo.id,
            content: "Original child".into(),
            progress_date: "2026-10-01".into(),
            due_date: Some("2026-11-02".into()),
        })
        .unwrap();
    db.todo_update_progress(TodoUpdateProgressInput {
        expected_revision: child.todo_revision,
        progress_id: child.id,
        content: child.content.clone(),
        progress_date: child.progress_date.clone(),
        due_date: child.due_date.clone(),
        status: Some("finished".into()),
    })
    .unwrap();
    let before = todo_revisions::head(&db.conn, todo.id).unwrap();
    let object = ObjectRef {
        workspace_id: "todo-workspace".into(),
        scope: scope.clone(),
        kind: ObjectKind::Todo,
        id: todo.id.to_string(),
    };
    let binding = WorkspaceBinding {
        workspace_id: object.workspace_id.clone(),
        generation: "one".into(),
    };
    let request = RequestContext {
        binding: binding.clone(),
        caller: Caller::Gui,
        request_id: "recover".into(),
        scope_grant: ScopeGrant {
            object_keys: None,
            workspace_id: binding.workspace_id.clone(),
            workspace_content: true,
            project_ids: project_id.into_iter().collect(),
            operations: [
                "operation.read",
                "operation.undo",
                "operation.restore_created",
                "session.read",
                "session.write",
                "run.start",
                "source.read",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        },
    };
    let session = db
        .agent_session_create(&request, &binding, &scope, "Todo recovery", "pi", None)
        .unwrap();
    let run_id = "a".repeat(32);
    db.agent_run_prepare(
        &request,
        &binding,
        &session.id,
        "run-original",
        &RunPreparation {
            run_id: run_id.clone(),
            context_manifest: json!({"scope":scope,"mode":"collaborate"}),
        },
    )
    .unwrap();
    db.agent_run_start(&request, &binding, &run_id).unwrap();
    Fixture {
        _root: root,
        db,
        request,
        object,
        before,
        operation_id: "c".repeat(32),
        run_id,
    }
}

/// Original native receipts carry the actual immutable snapshot IDs and hash.
/// Recovery tests exercise SQLite transactions and the formal revision helpers;
/// there is no fake body hash or in-memory ledger standing in for storage.
fn receipt(
    f: &Fixture,
    tx: &Transaction<'_>,
    kind: &str,
    before: Option<&todo_revisions::TodoRevisionHead>,
    after: &todo_revisions::TodoRevisionHead,
) {
    let result = json!({"operationId":f.operation_id,"object":f.object,"beforeRevision":before.map(|head|head.revision),"afterRevision":after.revision,"beforeSnapshotRef":before.map(|head|&head.snapshot_ref),"afterSnapshotRef":after.snapshot_ref,"bodyHash":after.body_hash});
    tx.execute("INSERT INTO agent_operation_receipts(caller_id,request_id,payload_hash,operation,state,result_json,created_at,operation_id,run_id,target_ref_json,before_revision,after_revision,before_snapshot_ref,after_snapshot_ref,output_context_json,undo_state) VALUES (?1,?2,'fixture',?3,'committed',?4,'original',?5,?6,?7,?8,?9,?10,?11,?12,'available')", params![format!("run:{}",f.run_id),format!("native-{kind}-{}",f.operation_id),kind,result.to_string(),f.operation_id,f.run_id,encode(&f.object).unwrap(),before.map(|head|head.revision as i64),after.revision as i64,before.map(|head|&head.snapshot_ref),after.snapshot_ref,json!({"afterBodyHash":after.body_hash}).to_string()]).unwrap();
}
fn modification(f: &Fixture) -> todo_revisions::TodoRevisionHead {
    let id = todo_id(&f.object).unwrap();
    let tx = f.db.conn.unchecked_transaction().unwrap();
    tx.execute("UPDATE todos SET content='Agent changed body',status='unfinished',priority='normal',due_date=NULL WHERE id=?1", [id]).unwrap();
    tx.execute("DELETE FROM todo_tag_links WHERE todo_id=?1", [id])
        .unwrap();
    tx.execute("DELETE FROM todo_progresses WHERE todo_id=?1", [id])
        .unwrap();
    tx.execute("INSERT INTO todo_progresses(id,todo_id,content,status,progress_date,due_date,completed_at,order_index,created_at) VALUES (999,?1,'Agent child','unfinished','2026-10-02',NULL,NULL,4,'new-child')", [id]).unwrap();
    let after = todo_revisions::commit(&tx, id, f.before.revision, Some(&f.operation_id)).unwrap();
    receipt(f, &tx, "todo.update", Some(&f.before), &after);
    tx.commit().unwrap();
    after
}
fn creation(f: &Fixture) {
    let tx = f.db.conn.unchecked_transaction().unwrap();
    receipt(f, &tx, "todo.create", None, &f.before);
    tx.commit().unwrap();
}
fn count(db: &Database, table: &str) -> i64 {
    db.conn
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}
fn undo(f: &Fixture, revision: u64) -> OperationUndoInput {
    OperationUndoInput {
        operation_id: f.operation_id.clone(),
        expected_head_revision: revision,
    }
}

fn creation_chain() -> (Fixture, OperationUndoBatchInput, TodoSnapshot) {
    let mut f = fixture(false);
    creation(&f);
    f.operation_id = "d".repeat(32);
    let first = modification(&f);
    f.before = first;
    f.operation_id = "e".repeat(32);
    let tail = modification(&f);
    let snapshot = todo_revisions::snapshot(&f.db.conn, todo_id(&f.object).unwrap()).unwrap();
    assert_eq!(tail.revision, f.before.revision + 1);
    let input = OperationUndoBatchInput {
        run_id: f.run_id.clone(),
        operation_ids: ["c".repeat(32), "d".repeat(32), "e".repeat(32)].to_vec(),
    };
    (f, input, snapshot)
}

fn creation_group(f: &Fixture, input: &OperationUndoBatchInput) -> OperationUndoGroup {
    let plan = super::super::agent_operation_batches::plan(
        &f.db.conn,
        &f.request,
        &f.request.binding,
        input,
    )
    .unwrap();
    assert_eq!(plan.groups.len(), 1);
    plan.groups.into_iter().next().unwrap()
}

#[test]
fn todo_created_then_updated_twice_withdraws_once_and_restores_tail_identity() {
    let (mut f, input, before) = creation_chain();
    let id = todo_id(&f.object).unwrap();
    let native = todo_revisions::head(&f.db.conn, id).unwrap();
    let snapshots = count(&f.db, "todo_revision_snapshots");
    let group = creation_group(&f, &input);
    assert!(group.conflicts.is_empty());
    let tx = f.db.conn.unchecked_transaction().unwrap();
    assert!(
        creation_group_check(&f.db, &tx, &f.request, &f.request.binding, &group)
            .unwrap()
            .is_none()
    );
    let withdrawn =
        creation_group_apply(&f.db, &tx, &f.request, &f.request.binding, &group).unwrap();
    tx.commit().unwrap();
    assert_eq!(count(&f.db, "agent_visible_todos"), 0);
    assert_eq!(count(&f.db, "todo_revision_snapshots"), snapshots);
    assert_eq!(todo_revisions::head(&f.db.conn, id).unwrap(), native);
    assert_eq!(todo_revisions::snapshot(&f.db.conn, id).unwrap(), before);
    let context: String =
        f.db.conn
            .query_row(
                "SELECT output_context_json FROM agent_operation_receipts WHERE operation_id=?1",
                [&withdrawn.operation_id],
                |r| r.get(0),
            )
            .unwrap();
    let context: Value = decode(&context).unwrap();
    assert_eq!(context["originalOperationIds"], json!(input.operation_ids));
    assert_eq!(context["tailBaseline"]["snapshotRef"], native.snapshot_ref);
    let repeated_group = creation_group(&f, &input);
    assert_eq!(
        creation_group_check(
            &f.db,
            &f.db.conn,
            &f.request,
            &f.request.binding,
            &repeated_group
        )
        .unwrap()
        .unwrap()
        .operation_id,
        withdrawn.operation_id
    );
    f.request.request_id = "restore-chain".into();
    let restored =
        f.db.agent_todo_creation_restore(
            &f.request,
            &f.request.binding,
            &RecordRestoreInput {
                creation_operation_id: "c".repeat(32),
                expected_withdrawal_revision: withdrawn.revision,
            },
        )
        .unwrap();
    assert!(!restored.withdrawn);
    assert_eq!(count(&f.db, "agent_visible_todos"), 1);
    assert_eq!(todo_revisions::head(&f.db.conn, id).unwrap(), native);
    assert_eq!(todo_revisions::snapshot(&f.db.conn, id).unwrap(), before);
    f.request.request_id = "restore-chain-repeat".into();
    assert_eq!(
        f.db.agent_todo_creation_restore(
            &f.request,
            &f.request.binding,
            &RecordRestoreInput {
                creation_operation_id: "c".repeat(32),
                expected_withdrawal_revision: withdrawn.revision
            }
        )
        .unwrap()
        .operation_id,
        restored.operation_id
    );
}

#[test]
fn todo_creation_chain_rejects_manual_head_and_child_drift() {
    for changed_head in [true, false] {
        let (f, input, _) = creation_chain();
        let id = todo_id(&f.object).unwrap();
        if changed_head {
            let body = todo_revisions::snapshot(&f.db.conn, id).unwrap();
            f.db.todo_update_content(TodoUpdateContentInput {
                expected_revision: todo_revisions::head(&f.db.conn, id).unwrap().revision,
                todo_id: id,
                content: body.content,
                due_date: body.due_date,
                tag_ids: body.tag_ids,
            })
            .unwrap();
        } else {
            f.db.conn
                .execute(
                    "UPDATE todo_progresses SET content='manual child drift' WHERE todo_id=?1",
                    [id],
                )
                .unwrap();
        }
        let group = creation_group(&f, &input);
        assert_eq!(
            creation_group_check(&f.db, &f.db.conn, &f.request, &f.request.binding, &group)
                .unwrap_err()
                .code,
            ErrorCode::UndoConflict
        );
        assert_eq!(count(&f.db, "agent_object_withdrawals"), 0);
    }
}

#[test]
fn todo_creation_chain_rolls_back_visibility_and_all_original_links_on_receipt_failure() {
    let (f, input, _) = creation_chain();
    let group = creation_group(&f, &input);
    f.db.conn.execute_batch("CREATE TRIGGER fail_todo_chain_receipt BEFORE INSERT ON agent_change_log WHEN NEW.operation='todo.withdraw' BEGIN SELECT RAISE(ABORT,'forced'); END;").unwrap();
    let tx = f.db.conn.unchecked_transaction().unwrap();
    assert_eq!(
        creation_group_apply(&f.db, &tx, &f.request, &f.request.binding, &group)
            .unwrap_err()
            .code,
        ErrorCode::IoFailed
    );
    drop(tx);
    assert_eq!(count(&f.db, "agent_object_withdrawals"), 0);
    assert_eq!(count(&f.db, "agent_visible_todos"), 1);
    for id in input.operation_ids {
        let entry =
            f.db.agent_operation_get(&f.request, &f.request.binding, &id)
                .unwrap();
        assert_eq!(entry.undo_state, "available");
        assert!(entry.undo_operation_id.is_none());
    }
}

#[test]
fn todo_undo_restores_actual_fields_tags_children_and_replays_original_receipt() {
    for project in [false, true] {
        let mut f = fixture(project);
        let before = todo_revisions::retained_snapshot(&f.db.conn, &f.before.snapshot_ref).unwrap();
        let after = modification(&f);
        let outbox = count(&f.db, "agent_change_log");
        f.request.caller = Caller::BuiltinRun {
            run_id: f.run_id.clone(),
        };
        let result =
            f.db.agent_todo_undo(&f.request, &f.request.binding, &undo(&f, after.revision))
                .unwrap();
        assert_eq!(result.before_revision, after.revision);
        assert_eq!(result.after_revision, after.revision + 1);
        assert_eq!(
            todo_revisions::snapshot(&f.db.conn, todo_id(&f.object).unwrap()).unwrap(),
            before
        );
        assert_eq!(
            todo_revisions::retained_snapshot(&f.db.conn, &result.after_snapshot_ref).unwrap(),
            before
        );
        assert_eq!(
            todo_revisions::retained_snapshot(&f.db.conn, &after.snapshot_ref)
                .unwrap()
                .content,
            "Agent changed body"
        );
        assert_eq!(count(&f.db, "agent_change_log"), outbox + 1);
        let committed =
            f.db.agent_operation_get(&f.request, &f.request.binding, &result.operation_id)
                .unwrap();
        assert_eq!(committed.kind, "todo.undo");
        assert_eq!(committed.before_revision, Some(after.revision));
        assert_eq!(
            committed.after_snapshot_ref,
            Some(result.after_snapshot_ref.clone())
        );
        assert_eq!(
            f.db.agent_operation_get(&f.request, &f.request.binding, &f.operation_id)
                .unwrap()
                .undo_state,
            "undone"
        );
        f.request.request_id = "another-request-for-same-undo".into();
        let repeated =
            f.db.agent_todo_undo(&f.request, &f.request.binding, &undo(&f, after.revision))
                .unwrap();
        assert_eq!(result.operation_id, repeated.operation_id);
        assert_eq!(count(&f.db, "agent_change_log"), outbox + 1);
        assert_eq!(
            todo_revisions::head(&f.db.conn, todo_id(&f.object).unwrap())
                .unwrap()
                .revision,
            result.after_revision
        );
    }
}

#[test]
fn todo_undo_rejects_same_body_manual_revision_and_untracked_child_drift() {
    for same_body in [false, true] {
        let f = fixture(false);
        let after = modification(&f);
        let id = todo_id(&f.object).unwrap();
        if same_body {
            let body = todo_revisions::snapshot(&f.db.conn, id).unwrap();
            f.db.todo_update_content(TodoUpdateContentInput {
                expected_revision: after.revision,
                todo_id: id,
                content: body.content,
                due_date: body.due_date,
                tag_ids: body.tag_ids,
            })
            .unwrap();
            let head = todo_revisions::head(&f.db.conn, id).unwrap();
            assert_eq!(head.body_hash, after.body_hash);
            assert_ne!(head.snapshot_ref, after.snapshot_ref);
        } else {
            f.db.conn
                .execute(
                    "UPDATE todo_progresses SET content='Later draft' WHERE todo_id=?1",
                    [id],
                )
                .unwrap();
        }
        let actual = todo_revisions::snapshot(&f.db.conn, id).unwrap();
        let outbox = count(&f.db, "agent_change_log");
        assert_eq!(
            f.db.agent_todo_undo(&f.request, &f.request.binding, &undo(&f, after.revision))
                .unwrap_err()
                .code,
            ErrorCode::UndoConflict
        );
        assert_eq!(todo_revisions::snapshot(&f.db.conn, id).unwrap(), actual);
        assert_eq!(count(&f.db, "agent_change_log"), outbox);
        assert_eq!(
            f.db.agent_operation_get(&f.request, &f.request.binding, &f.operation_id)
                .unwrap()
                .undo_state,
            "available"
        );
    }
}

#[test]
fn todo_creation_withdraw_restore_preserves_identity_business_rows_and_retained_history() {
    for project in [false, true] {
        let mut f = fixture(project);
        creation(&f);
        let id = todo_id(&f.object).unwrap();
        let before = todo_revisions::snapshot(&f.db.conn, id).unwrap();
        let snapshots = count(&f.db, "todo_revision_snapshots");
        let input = RecordWithdrawalInput {
            creation_operation_id: f.operation_id.clone(),
        };
        let withdrawn =
            f.db.agent_todo_creation_withdraw(&f.request, &f.request.binding, &input)
                .unwrap();
        assert!(withdrawn.withdrawn);
        assert_eq!(withdrawn.object, f.object);
        assert_eq!(count(&f.db, "todos"), 1);
        assert_eq!(count(&f.db, "agent_visible_todos"), 0);
        assert_eq!(todo_revisions::snapshot(&f.db.conn, id).unwrap(), before);
        assert_eq!(todo_revisions::head(&f.db.conn, id).unwrap(), f.before);
        assert_eq!(count(&f.db, "todo_revision_snapshots"), snapshots);
        let error =
            f.db.source_read_object(&f.request, &f.request.binding, &f.object)
                .unwrap_err();
        assert_eq!(error.code, ErrorCode::ObjectWithdrawn);
        assert_eq!(error.details.unwrap()["workspaceId"], f.object.workspace_id);
        assert!(f
            .db
            .internal_reference_resolve(InternalReferenceResolveInput {
                kind: "todo".into(),
                id
            })
            .unwrap_err()
            .to_string()
            .contains("OBJECT_WITHDRAWN"));
        let catalogue = f
            .db
            .agent_source_catalogue_page(&f.object.workspace_id, &f.object.scope, "", 0, 50, true)
            .unwrap();
        assert!(!catalogue
            .iter()
            .any(|entry| entry.0 == "todo" && entry.1 == id));
        let recovery =
            f.db.agent_operation_get(&f.request, &f.request.binding, &f.operation_id)
                .unwrap()
                .recovery
                .unwrap();
        assert!(recovery.withdrawn && recovery.restore_available);
        f.request.request_id = "withdraw-repeat".into();
        assert_eq!(
            f.db.agent_todo_creation_withdraw(&f.request, &f.request.binding, &input)
                .unwrap()
                .operation_id,
            withdrawn.operation_id
        );
        f.request.request_id = "restore".into();
        let restored =
            f.db.agent_todo_creation_restore(
                &f.request,
                &f.request.binding,
                &RecordRestoreInput {
                    creation_operation_id: f.operation_id.clone(),
                    expected_withdrawal_revision: withdrawn.revision,
                },
            )
            .unwrap();
        assert!(!restored.withdrawn);
        assert_eq!(restored.object.id, f.object.id);
        assert_eq!(count(&f.db, "agent_visible_todos"), 1);
        assert_eq!(todo_revisions::snapshot(&f.db.conn, id).unwrap(), before);
        assert_eq!(
            todo_revisions::retained_snapshot(&f.db.conn, &f.before.snapshot_ref).unwrap(),
            before
        );
        assert_eq!(count(&f.db, "todo_revision_snapshots"), snapshots);
        f.request.request_id = "restore-repeat".into();
        assert_eq!(
            f.db.agent_todo_creation_restore(
                &f.request,
                &f.request.binding,
                &RecordRestoreInput {
                    creation_operation_id: f.operation_id.clone(),
                    expected_withdrawal_revision: withdrawn.revision
                }
            )
            .unwrap()
            .operation_id,
            restored.operation_id
        );
        f.request.request_id = "restore-wrong-revision".into();
        assert_eq!(
            f.db.agent_todo_creation_restore(
                &f.request,
                &f.request.binding,
                &RecordRestoreInput {
                    creation_operation_id: f.operation_id.clone(),
                    expected_withdrawal_revision: restored.revision
                }
            )
            .unwrap_err()
            .code,
            ErrorCode::UndoConflict
        );
    }
}

#[test]
fn todo_creation_withdraw_rejects_later_changes_native_edges_and_legacy_typed_references() {
    for reason in ["same_body", "edge", "legacy"] {
        let f = fixture(false);
        creation(&f);
        let id = todo_id(&f.object).unwrap();
        match reason {
            "same_body" => {
                let body = todo_revisions::snapshot(&f.db.conn, id).unwrap();
                f.db.todo_update_content(TodoUpdateContentInput {
                    expected_revision: f.before.revision,
                    todo_id: id,
                    content: body.content,
                    due_date: body.due_date,
                    tag_ids: body.tag_ids,
                })
                .unwrap();
            }
            "edge" => {
                f.db.conn.execute("INSERT INTO content_reference_edges(source_object_key,target_object_key,relation) VALUES ('todo-workspace/workspace/consumer/a',?1,'derived_from')", [f.object.key().unwrap()]).unwrap();
            }
            _ => {
                f.db.todo_create(TodoCreateInput {
                    scope: TodoScope::Workspace,
                    project_id: None,
                    content: format!("[[todo:{id}|Actual referenced task]]"),
                    priority: "normal".into(),
                    due_date: None,
                    tag_ids: vec![],
                })
                .unwrap();
            }
        }
        let outbox = count(&f.db, "agent_change_log");
        assert_eq!(
            f.db.agent_todo_creation_withdraw(
                &f.request,
                &f.request.binding,
                &RecordWithdrawalInput {
                    creation_operation_id: f.operation_id.clone()
                }
            )
            .unwrap_err()
            .code,
            ErrorCode::UndoConflict
        );
        assert_eq!(count(&f.db, "agent_object_withdrawals"), 0);
        assert_eq!(count(&f.db, "agent_change_log"), outbox);
        require_todo_visible(&f.db.conn, id).unwrap();
    }
}

#[test]
fn todo_undo_authorizes_original_run_scope_binding_and_restored_references() {
    let mut f = fixture(false);
    let after = modification(&f);
    let mut wrong = f.request.clone();
    wrong.caller = Caller::BuiltinRun {
        run_id: "b".repeat(32),
    };
    assert_eq!(
        f.db.agent_todo_undo(&wrong, &wrong.binding, &undo(&f, after.revision))
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    wrong = f.request.clone();
    wrong.scope_grant.workspace_content = false;
    assert_eq!(
        f.db.agent_todo_undo(&wrong, &wrong.binding, &undo(&f, after.revision))
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    wrong = f.request.clone();
    wrong.binding.generation = "later".into();
    assert_eq!(
        f.db.agent_todo_undo(&wrong, &f.request.binding, &undo(&f, after.revision))
            .unwrap_err()
            .code,
        ErrorCode::WorkspaceChanged
    );
    // A retained before-body may no longer be a valid current native reference.
    let other =
        f.db.todo_create(TodoCreateInput {
            scope: TodoScope::Workspace,
            project_id: None,
            content: "Referenced task".into(),
            priority: "normal".into(),
            due_date: None,
            tag_ids: vec![],
        })
        .unwrap();
    let tx = f.db.conn.unchecked_transaction().unwrap();
    tx.execute(
        "UPDATE todos SET content=?1 WHERE id=?2",
        params![
            format!("[[todo:{}|Referenced task]]", other.id),
            todo_id(&f.object).unwrap()
        ],
    )
    .unwrap();
    let before =
        todo_revisions::commit(&tx, todo_id(&f.object).unwrap(), after.revision, None).unwrap();
    tx.commit().unwrap();
    f.before = before;
    f.operation_id = "d".repeat(32);
    f.request.request_id = "reference-undo".into();
    let changed = modification(&f);
    f.db.conn
        .execute("DELETE FROM todos WHERE id=?1", [other.id])
        .unwrap();
    let current = todo_revisions::snapshot(&f.db.conn, todo_id(&f.object).unwrap()).unwrap();
    assert_eq!(
        f.db.agent_todo_undo(&f.request, &f.request.binding, &undo(&f, changed.revision))
            .unwrap_err()
            .code,
        ErrorCode::UndoConflict
    );
    assert_eq!(
        todo_revisions::snapshot(&f.db.conn, todo_id(&f.object).unwrap()).unwrap(),
        current
    );
}

#[test]
fn archived_project_keeps_committed_todo_body_when_undo_is_requested() {
    let f = fixture(true);
    let after = modification(&f);
    let id = todo_id(&f.object).unwrap();
    let saved = todo_revisions::snapshot(&f.db.conn, id).unwrap();
    let Scope::Project { project_id } = &f.object.scope else { panic!("Project fixture") };
    f.db.project_set_archive(ProjectArchiveInput { project_id: *project_id, is_archived: true }).unwrap();
    assert_eq!(f.db.agent_todo_undo(&f.request, &f.request.binding,
        &undo(&f, after.revision)).unwrap_err().code, ErrorCode::ScopeDenied);
    assert_eq!(todo_revisions::snapshot(&f.db.conn, id).unwrap(), saved);
}

#[test]
fn todo_undo_native_receipt_failure_rolls_back_body_revisions_outbox_and_original_state() {
    let f = fixture(true);
    let after = modification(&f);
    let id = todo_id(&f.object).unwrap();
    let actual = todo_revisions::snapshot(&f.db.conn, id).unwrap();
    let outbox = count(&f.db, "agent_change_log");
    let snapshots = count(&f.db, "todo_revision_snapshots");
    f.db.conn.execute_batch("CREATE TRIGGER reject_todo_undo_receipt BEFORE UPDATE OF operation_id ON agent_operation_receipts WHEN NEW.operation='todo.undo' BEGIN SELECT RAISE(ABORT,'reject receipt'); END;").unwrap();
    assert_eq!(
        f.db.agent_todo_undo(&f.request, &f.request.binding, &undo(&f, after.revision))
            .unwrap_err()
            .code,
        ErrorCode::IoFailed
    );
    assert_eq!(todo_revisions::snapshot(&f.db.conn, id).unwrap(), actual);
    assert_eq!(todo_revisions::head(&f.db.conn, id).unwrap(), after);
    assert_eq!(count(&f.db, "agent_change_log"), outbox);
    assert_eq!(count(&f.db, "todo_revision_snapshots"), snapshots);
    assert_eq!(
        f.db.agent_operation_get(&f.request, &f.request.binding, &f.operation_id)
            .unwrap()
            .undo_state,
        "available"
    );
}

#[test]
fn todo_undo_revalidates_restored_child_reference_availability_and_current_scope() {
    for reason in ["deleted", "archived", "ungranted"] {
        let mut f = fixture(false);
        let project_id = (reason != "deleted").then(|| {
            f.db.project_create(ProjectCreateInput {
                name: "Referenced project".into(),
                summary: None,
                status: None,
            })
            .unwrap()
            .id
        });
        let target =
            f.db.todo_create(TodoCreateInput {
                scope: if project_id.is_some() {
                    TodoScope::Project
                } else {
                    TodoScope::Workspace
                },
                project_id,
                content: "Referenced child target".into(),
                priority: "normal".into(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
        if let Some(project_id) = project_id {
            f.request.scope_grant.project_ids.push(project_id);
        }
        let id = todo_id(&f.object).unwrap();
        let child = todo_revisions::snapshot(&f.db.conn, id)
            .unwrap()
            .children
            .remove(0);
        // Save the reference through the native GUI path before the Agent
        // update removes that child. Undo must validate the actual old child.
        f.db.todo_update_progress(TodoUpdateProgressInput {
            expected_revision: f.before.revision,
            progress_id: child.id,
            content: format!("[[todo:{}|Referenced child target]]", target.id),
            progress_date: child.progress_date,
            due_date: child.due_date,
            status: Some(child.status),
        })
        .unwrap();
        f.before = todo_revisions::head(&f.db.conn, id).unwrap();
        let after = modification(&f);
        match reason {
            "deleted" => {
                f.db.conn
                    .execute("DELETE FROM todos WHERE id=?1", [target.id])
                    .unwrap();
            }
            "archived" => {
                f.db.project_set_archive(ProjectArchiveInput {
                    project_id: project_id.unwrap(),
                    is_archived: true,
                })
                .unwrap();
            }
            _ => f.request.scope_grant.project_ids.clear(),
        }
        let actual = todo_revisions::snapshot(&f.db.conn, id).unwrap();
        let outbox = count(&f.db, "agent_change_log");
        let snapshots = count(&f.db, "todo_revision_snapshots");
        let error =
            f.db.agent_todo_undo(&f.request, &f.request.binding, &undo(&f, after.revision))
                .unwrap_err();
        assert_eq!(
            error.code,
            if reason == "ungranted" {
                ErrorCode::ScopeDenied
            } else {
                ErrorCode::UndoConflict
            }
        );
        assert_eq!(todo_revisions::snapshot(&f.db.conn, id).unwrap(), actual);
        assert_eq!(todo_revisions::head(&f.db.conn, id).unwrap(), after);
        assert_eq!(count(&f.db, "agent_change_log"), outbox);
        assert_eq!(count(&f.db, "todo_revision_snapshots"), snapshots);
        assert_eq!(
            f.db.agent_operation_get(&f.request, &f.request.binding, &f.operation_id)
                .unwrap()
                .undo_state,
            "available"
        );
    }
}

/// Exercise the actual stage/native output path, including its frozen Run grant
/// and receipt hook, rather than assembling a group from fake revision evidence.
fn native_update(
    f: &Fixture,
    request_id: &str,
    changes: Vec<TodoMutation>,
) -> super::super::agent_todo_outputs::TodoCommittedResult {
    let mut model = f.request.clone();
    model.caller = Caller::BuiltinRun {
        run_id: f.run_id.clone(),
    };
    model.request_id = request_id.into();
    model.scope_grant.operations.extend(
        [
            "output.stage",
            "output.read",
            "output.update",
            "output.commit",
            "todo.update",
        ]
        .into_iter()
        .map(str::to_owned),
    );
    let grant = &model.scope_grant;
    f.db.conn.execute("UPDATE agent_runs SET grant_json=?1 WHERE id=?2", params![json!({"workspaceId":grant.workspace_id,"workspaceContent":grant.workspace_content,"projectIds":grant.project_ids,"operations":grant.operations}).to_string(), f.run_id]).unwrap();
    let head = todo_revisions::head(&f.db.conn, todo_id(&f.object).unwrap()).unwrap();
    let output =
        f.db.agent_output_stage_record(
            &model,
            &model.binding,
            &StageRecordInput {
                sources: vec![],
                intent: OutputIntent::TodoUpdate {
                    target: f.object.clone(),
                    expected_revision: head.revision,
                    changes,
                },
            },
        )
        .unwrap();
    f.db.agent_todo_output_commit(
        &model,
        &model.binding,
        &output.staged.id,
        output.staged.revision,
    )
    .unwrap()
}
fn group_input(f: &Fixture, ids: &[&str]) -> OperationUndoBatchInput {
    OperationUndoBatchInput {
        run_id: f.run_id.clone(),
        operation_ids: ids.iter().map(|id| (*id).into()).collect(),
    }
}
fn native_update_pair(
    f: &Fixture,
) -> (
    super::super::agent_todo_outputs::TodoCommittedResult,
    super::super::agent_todo_outputs::TodoCommittedResult,
) {
    let child = todo_revisions::snapshot(&f.db.conn, todo_id(&f.object).unwrap())
        .unwrap()
        .children
        .remove(0);
    let first = native_update(
        f,
        "first-native-update",
        vec![
            TodoMutation::Content {
                content: "First native change".into(),
            },
            TodoMutation::Priority {
                priority: "urgent_important".into(),
            },
            TodoMutation::ChildUpdate {
                child_id: child.id,
                content: "First child change".into(),
                progress_date: child.progress_date,
                due_date: None,
                status: "unfinished".into(),
            },
        ],
    );
    let tail = native_update(
        f,
        "tail-native-update",
        vec![
            TodoMutation::Content {
                content: "Tail native change".into(),
            },
            TodoMutation::Tags { tag_ids: vec![] },
            TodoMutation::ChildDelete { child_id: child.id },
            TodoMutation::ChildCreate {
                content: "New tail child".into(),
                progress_date: "2026-10-08".into(),
                due_date: None,
            },
        ],
    );
    (first, tail)
}

#[test]
fn todo_group_undo_restores_first_baseline_once_and_replays_each_original_after_later_work() {
    for project in [false, true] {
        let mut f = fixture(project);
        let id = todo_id(&f.object).unwrap();
        let before = todo_revisions::snapshot(&f.db.conn, id).unwrap();
        let (first, tail) = native_update_pair(&f);
        let input = group_input(&f, &[&tail.operation_id, &first.operation_id]);
        let old_entries = [first.operation_id.as_str(), tail.operation_id.as_str()].map(|id| {
            f.db.agent_operation_get(&f.request, &f.request.binding, id)
                .unwrap()
        });
        let outbox = count(&f.db, "agent_change_log");
        let snapshots = count(&f.db, "todo_revision_snapshots");
        let result =
            f.db.agent_todo_undo_group(&f.request, &f.request.binding, &input)
                .unwrap();
        assert_eq!(result.original_operation_id, first.operation_id);
        assert_eq!(result.before_revision, tail.after_revision);
        assert_eq!(result.before_snapshot_ref, tail.after_snapshot_ref);
        assert_eq!(result.after_revision, tail.after_revision + 1);
        assert_eq!(todo_revisions::snapshot(&f.db.conn, id).unwrap(), before);
        assert_eq!(
            todo_revisions::retained_snapshot(&f.db.conn, &result.after_snapshot_ref).unwrap(),
            before
        );
        assert_eq!(count(&f.db, "agent_change_log"), outbox + 1);
        assert_eq!(count(&f.db, "todo_revision_snapshots"), snapshots + 1);
        for old in &old_entries {
            let saved =
                f.db.agent_operation_get(&f.request, &f.request.binding, &old.operation_id)
                    .unwrap();
            assert_eq!(saved.undo_state, "undone");
            assert_eq!(
                saved.undo_operation_id.as_deref(),
                Some(result.operation_id.as_str())
            );
            assert_eq!(saved.before_revision, old.before_revision);
            assert_eq!(saved.after_revision, old.after_revision);
            assert_eq!(saved.before_snapshot_ref, old.before_snapshot_ref);
            assert_eq!(saved.after_snapshot_ref, old.after_snapshot_ref);
            f.request.request_id = format!("single-repeat-{}", old.operation_id);
            let repeated =
                f.db.agent_todo_undo(
                    &f.request,
                    &f.request.binding,
                    &OperationUndoInput {
                        operation_id: old.operation_id.clone(),
                        expected_head_revision: old.after_revision.unwrap(),
                    },
                )
                .unwrap();
            assert_eq!(encode(&repeated).unwrap(), encode(&result).unwrap());
        }
        f.db.todo_update_content(TodoUpdateContentInput {
            expected_revision: result.after_revision,
            todo_id: id,
            content: "Later user work".into(),
            due_date: before.due_date,
            tag_ids: before.tag_ids,
        })
        .unwrap();
        let current = todo_revisions::head(&f.db.conn, id).unwrap();
        let outbox_after_later_work = count(&f.db, "agent_change_log");
        f.request.request_id = "group-repeat-after-later-work".into();
        let repeated =
            f.db.agent_todo_undo_group(&f.request, &f.request.binding, &input)
                .unwrap();
        assert_eq!(encode(&repeated).unwrap(), encode(&result).unwrap());
        assert_eq!(todo_revisions::head(&f.db.conn, id).unwrap(), current);
        assert_eq!(count(&f.db, "agent_change_log"), outbox_after_later_work);
    }
}

#[test]
fn todo_group_undo_rejects_later_native_or_untracked_child_changes_and_keeps_receipts_available() {
    for manual in [false, true] {
        let f = fixture(false);
        let id = todo_id(&f.object).unwrap();
        let (first, tail) = native_update_pair(&f);
        if manual {
            let snapshot = todo_revisions::snapshot(&f.db.conn, id).unwrap();
            f.db.todo_update_content(TodoUpdateContentInput {
                expected_revision: tail.after_revision,
                todo_id: id,
                content: snapshot.content,
                due_date: snapshot.due_date,
                tag_ids: snapshot.tag_ids,
            })
            .unwrap();
        } else {
            f.db.conn
                .execute(
                    "UPDATE todo_progresses SET content='Later untracked child' WHERE todo_id=?1",
                    [id],
                )
                .unwrap();
        }
        let current = todo_revisions::snapshot(&f.db.conn, id).unwrap();
        let head = todo_revisions::head(&f.db.conn, id).unwrap();
        let outbox = count(&f.db, "agent_change_log");
        assert_eq!(
            f.db.agent_todo_undo_group(
                &f.request,
                &f.request.binding,
                &group_input(&f, &[&first.operation_id, &tail.operation_id])
            )
            .unwrap_err()
            .code,
            ErrorCode::UndoConflict
        );
        assert_eq!(todo_revisions::snapshot(&f.db.conn, id).unwrap(), current);
        assert_eq!(todo_revisions::head(&f.db.conn, id).unwrap(), head);
        assert_eq!(count(&f.db, "agent_change_log"), outbox);
        for operation in [&first.operation_id, &tail.operation_id] {
            assert_eq!(
                f.db.agent_operation_get(&f.request, &f.request.binding, operation)
                    .unwrap()
                    .undo_state,
                "available"
            );
        }
    }
}

#[test]
fn todo_group_undo_rejects_foreign_run_scope_missing_middle_creation_and_mixed_states() {
    for reason in ["run", "scope", "middle", "creation", "mixed"] {
        let f = fixture(false);
        if reason == "creation" {
            creation(&f);
        }
        let (first, tail) = native_update_pair(&f);
        let mut input = group_input(&f, &[&first.operation_id, &tail.operation_id]);
        let mut request = f.request.clone();
        match reason {
            "run" => input.run_id = "b".repeat(32),
            "scope" => request.scope_grant.workspace_content = false,
            "middle" => {
                let third = native_update(
                    &f,
                    "third-native-update",
                    vec![TodoMutation::Content {
                        content: "Third change".into(),
                    }],
                );
                input.operation_ids = vec![first.operation_id.clone(), third.operation_id];
            }
            "creation" => input.operation_ids.insert(0, f.operation_id.clone()),
            _ => {
                f.db.conn.execute("UPDATE agent_operation_receipts SET undo_state='undone',undo_operation_id=?1 WHERE operation_id=?2", params!["d".repeat(32), first.operation_id]).unwrap();
            }
        }
        let id = todo_id(&f.object).unwrap();
        let current = todo_revisions::snapshot(&f.db.conn, id).unwrap();
        let head = todo_revisions::head(&f.db.conn, id).unwrap();
        let outbox = count(&f.db, "agent_change_log");
        let error =
            f.db.agent_todo_undo_group(&request, &request.binding, &input)
                .unwrap_err();
        assert_eq!(
            error.code,
            if matches!(reason, "run" | "scope") {
                ErrorCode::ScopeDenied
            } else {
                ErrorCode::UndoConflict
            }
        );
        assert_eq!(todo_revisions::snapshot(&f.db.conn, id).unwrap(), current);
        assert_eq!(todo_revisions::head(&f.db.conn, id).unwrap(), head);
        assert_eq!(count(&f.db, "agent_change_log"), outbox);
    }
}

#[test]
fn todo_group_undo_receipt_failures_roll_back_restoration_and_every_original_marker() {
    for failure in ["final_receipt", "second_original"] {
        let f = fixture(true);
        let (first, tail) = native_update_pair(&f);
        if failure == "final_receipt" {
            f.db.conn.execute_batch("CREATE TRIGGER reject_group_undo_receipt BEFORE UPDATE OF operation_id ON agent_operation_receipts WHEN NEW.operation='todo.undo' BEGIN SELECT RAISE(ABORT,'reject receipt'); END;").unwrap();
        } else {
            f.db.conn.execute_batch(&format!("CREATE TRIGGER reject_group_second_original BEFORE UPDATE OF undo_state ON agent_operation_receipts WHEN NEW.operation_id='{}' AND NEW.undo_state='undone' BEGIN SELECT RAISE(ABORT,'reject original'); END;", tail.operation_id)).unwrap();
        }
        let id = todo_id(&f.object).unwrap();
        let current = todo_revisions::snapshot(&f.db.conn, id).unwrap();
        let head = todo_revisions::head(&f.db.conn, id).unwrap();
        let outbox = count(&f.db, "agent_change_log");
        let snapshots = count(&f.db, "todo_revision_snapshots");
        assert_eq!(
            f.db.agent_todo_undo_group(
                &f.request,
                &f.request.binding,
                &group_input(&f, &[&first.operation_id, &tail.operation_id])
            )
            .unwrap_err()
            .code,
            ErrorCode::IoFailed
        );
        assert_eq!(todo_revisions::snapshot(&f.db.conn, id).unwrap(), current);
        assert_eq!(todo_revisions::head(&f.db.conn, id).unwrap(), head);
        assert_eq!(count(&f.db, "agent_change_log"), outbox);
        assert_eq!(count(&f.db, "todo_revision_snapshots"), snapshots);
        for operation in [&first.operation_id, &tail.operation_id] {
            let entry =
                f.db.agent_operation_get(&f.request, &f.request.binding, operation)
                    .unwrap();
            assert_eq!(entry.undo_state, "available");
            assert!(entry.undo_operation_id.is_none());
        }
    }
}

#[test]
fn todo_group_undo_net_zero_changes_follow_native_revision_strategy() {
    let f = fixture(false);
    let id = todo_id(&f.object).unwrap();
    let before = todo_revisions::snapshot(&f.db.conn, id).unwrap();
    let first = native_update(
        &f,
        "net-zero-first",
        vec![TodoMutation::Content {
            content: "Temporary change".into(),
        }],
    );
    let tail = native_update(
        &f,
        "net-zero-tail",
        vec![TodoMutation::Content {
            content: before.content.clone(),
        }],
    );
    assert_eq!(todo_revisions::snapshot(&f.db.conn, id).unwrap(), before);
    let result =
        f.db.agent_todo_undo_group(
            &f.request,
            &f.request.binding,
            &group_input(&f, &[&first.operation_id, &tail.operation_id]),
        )
        .unwrap();
    assert_eq!(result.before_revision, tail.after_revision);
    assert_eq!(result.after_revision, tail.after_revision + 1);
    assert_eq!(result.body_hash, tail.body_hash);
    assert_eq!(todo_revisions::snapshot(&f.db.conn, id).unwrap(), before);
}
