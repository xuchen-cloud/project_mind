use super::*;
use crate::{
    agent::{
        access::{Caller, RequestContext, ScopeGrant},
        conversation::RunPreparation,
        errors::ErrorCode,
        models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
        operation_batches::{OperationUndoBatchInput, OperationUndoBatchOutcome},
        output_runtime::StageRecordInput,
        outputs::{BlockEdit, OutputIntent, RecordPatch, TodoMutation},
    },
    models::{TodoCreateInput, TodoScope},
    record_documents::{
        body_hash, RecordCreate, RecordDocumentProjection, RecordPatchMetadata, RecordTarget,
    },
};
use rusqlite::params;
use serde_json::json;

const RUN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
struct Fixture {
    _root: tempfile::TempDir,
    db: Database,
    model: RequestContext,
    gui: RequestContext,
}
fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(
        &root.path().join("creation-batch.sqlite"),
        root.path(),
        None,
    )
    .unwrap();
    db.bind_native_workspace("creation-batch").unwrap();
    let binding = WorkspaceBinding {
        workspace_id: "creation-batch".into(),
        generation: "one".into(),
    };
    let gui = RequestContext {
        binding: binding.clone(),
        caller: Caller::Gui,
        request_id: "gui-batch".into(),
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
                "output.read",
                "output.commit",
                "content.create",
                "record.patch",
                "source.read",
                "todo.update",
                "operation.read",
                "operation.undo",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        },
    };
    let session = db
        .agent_session_create(&gui, &binding, &Scope::Workspace, "Batch", "pi", None)
        .unwrap();
    db.agent_run_prepare(
        &gui,
        &binding,
        &session.id,
        "message",
        &RunPreparation {
            run_id: RUN.into(),
            context_manifest: json!({"scope":Scope::Workspace,"mode":"collaborate"}),
        },
    )
    .unwrap();
    db.agent_run_start(&gui, &binding, RUN).unwrap();
    let model = RequestContext {
        caller: Caller::BuiltinRun { run_id: RUN.into() },
        request_id: "initial".into(),
        ..gui.clone()
    };
    Fixture {
        _root: root,
        db,
        model,
        gui,
    }
}
fn record(f: &mut Fixture, label: &str, block: char) -> (String, ObjectRef, RecordTarget, String) {
    f.model.request_id = format!("stage-record-{label}");
    let text = format!("Body {label}");
    let block_id: String = std::iter::repeat(block).take(32).collect();
    let document = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":block_id},"content":[{"type":"text","text":text}]}]});
    let projection = RecordDocumentProjection {
        schema_version: 1,
        body_hash: body_hash(&document, &None),
        document: document.clone(),
        html: format!("<p data-block-id=\"{block_id}\">{text}</p>"),
        markdown: text.clone(),
        text: text.clone(),
        code_language: None,
    };
    let staged =
        f.db.agent_output_stage_record(
            &f.model,
            &f.model.binding,
            &StageRecordInput {
                intent: OutputIntent::RecordCreate {
                    scope: Scope::Workspace,
                    title: label.into(),
                    markdown: text.clone(),
                },
                sources: vec![],
            },
        )
        .unwrap();
    let prepared =
        f.db.agent_output_commit_prepare(&f.model, &f.model.binding, &staged.staged.id, 1)
            .unwrap();
    let head =
        f.db.record_create(
            &f.model.caller.key(),
            &prepared.commit_request_id,
            &RecordCreate {
                scope: Scope::Workspace,
                title: Some(label.into()),
                tag_ids: vec![],
                document,
                code_language: None,
            },
            &projection,
            &f.model.binding.workspace_id,
        )
        .unwrap();
    let (id, snapshot): (String, String) = f.db.conn.query_row(
        "SELECT operation_id,after_snapshot_ref FROM agent_operation_receipts WHERE caller_id=?1 AND request_id=?2",
        params![f.model.caller.key(), prepared.commit_request_id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    let object = ObjectRef {
        workspace_id: f.model.binding.workspace_id.clone(),
        scope: Scope::Workspace,
        kind: ObjectKind::Record,
        id: head.target.record_id.to_string(),
    };
    (id, object, head.target, snapshot)
}
fn todo(f: &mut Fixture, label: &str) -> (String, ObjectRef, String, u64) {
    f.model.request_id = format!("stage-todo-{label}");
    let staged =
        f.db.agent_output_stage_record(
            &f.model,
            &f.model.binding,
            &StageRecordInput {
                intent: OutputIntent::TodoCreate {
                    scope: Scope::Workspace,
                    content: label.into(),
                    priority: "urgent_important".into(),
                    due_date: None,
                    tag_ids: vec![],
                    dedupe_key: format!("todo-{label}"),
                    children: vec![],
                },
                sources: vec![],
            },
        )
        .unwrap();
    let created =
        f.db.agent_todo_output_commit(
            &f.model,
            &f.model.binding,
            &staged.staged.id,
            staged.staged.revision,
        )
        .unwrap();
    (
        created.operation_id,
        created.object,
        created.after_snapshot_ref,
        created.after_revision,
    )
}
fn update_record(f: &mut Fixture, object: &ObjectRef, target: &RecordTarget) -> String {
    f.model.request_id = "stage-record-update".into();
    let before = f.db.record_document_head(target).unwrap().unwrap();
    let operation: BlockEdit = serde_json::from_value(json!({
        "op":"append", "parentBlockId":null,
        "blocks":[{"type":"paragraph","content":[{"type":"text","text":"Later"}]}]
    }))
    .unwrap();
    let staged =
        f.db.agent_output_stage_record(
            &f.model,
            &f.model.binding,
            &StageRecordInput {
                intent: OutputIntent::RecordPatch {
                    patch: RecordPatch {
                        record: object.clone(),
                        base_revision: before.head_revision,
                        request_id: "record-update-candidate".into(),
                        operations: vec![operation],
                    },
                },
                sources: vec![],
            },
        )
        .unwrap();
    let prepared =
        f.db.agent_output_commit_prepare(&f.model, &f.model.binding, &staged.staged.id, 1)
            .unwrap();
    let OutputIntent::RecordPatch { mut patch } = prepared.output.staged.intent else {
        panic!("Record patch");
    };
    patch.request_id = prepared.commit_request_id;
    let mut after = before.projection;
    let block_id = "99999999999999999999999999999999";
    after.document["content"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "type":"paragraph", "attrs":{"blockId":block_id},
            "content":[{"type":"text","text":"Later"}]
        }));
    after.body_hash = body_hash(&after.document, &after.code_language);
    after
        .html
        .push_str(&format!("<p data-block-id=\"{block_id}\">Later</p>"));
    after.markdown.push_str("\n\nLater");
    after.text.push_str("\nLater");
    f.db.record_patch_commit(
        &f.model.caller.key(),
        &patch,
        &after,
        &RecordPatchMetadata {
            created_block_ids: vec![block_id.into()],
            deleted_block_ids: vec![],
            normalizations: vec![],
            no_change: false,
        },
        &f.model.binding.workspace_id,
    )
    .unwrap()
    .receipt
    .operation_id
}
fn update_todo(f: &mut Fixture, object: &ObjectRef, revision: u64, label: &str) -> String {
    f.model.request_id = format!("update-todo-{label}");
    let staged =
        f.db.agent_output_stage_record(
            &f.model,
            &f.model.binding,
            &StageRecordInput {
                intent: OutputIntent::TodoUpdate {
                    target: object.clone(),
                    expected_revision: revision,
                    changes: vec![TodoMutation::Content {
                        content: format!("{label} updated"),
                    }],
                },
                sources: vec![],
            },
        )
        .unwrap();
    f.db.agent_todo_output_commit(
        &f.model,
        &f.model.binding,
        &staged.staged.id,
        staged.staged.revision,
    )
    .unwrap()
    .operation_id
}
fn batch(ids: &[&str]) -> OperationUndoBatchInput {
    OperationUndoBatchInput {
        run_id: RUN.into(),
        operation_ids: ids.iter().map(|id| (*id).into()).collect(),
    }
}
fn edge(f: &Fixture, source: &ObjectRef, target: &ObjectRef) {
    f.db.conn.execute("INSERT INTO content_reference_edges(source_object_key,target_object_key,relation) VALUES (?1,?2,'internal_reference')",
        params![source.key().unwrap(), target.key().unwrap()]).unwrap();
}
fn visible(f: &Fixture, object: &ObjectRef) -> bool {
    !f.db.conn.query_row("SELECT EXISTS(SELECT 1 FROM agent_object_withdrawals WHERE object_key=?1 AND withdrawn_at IS NOT NULL)",
        [object.key().unwrap()], |row| row.get::<_, bool>(0)).unwrap()
}
fn success(outcome: &OperationUndoBatchOutcome) -> bool {
    matches!(outcome, OperationUndoBatchOutcome::Succeeded { .. })
}
fn count(f: &Fixture, table: &str) -> i64 {
    f.db.conn
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}

#[test]
fn closed_record_todo_cycle_with_update_withdraws_together_and_keeps_versions() {
    let mut f = fixture();
    let (record_op, record_object, target, version) = record(&mut f, "Cycle record", 'a');
    let record_update_op = update_record(&mut f, &record_object, &target);
    let (todo_op, todo_object, snapshot, revision) = todo(&mut f, "Cycle todo");
    let update_op = update_todo(&mut f, &todo_object, revision, "Cycle todo");
    edge(&f, &record_object, &todo_object);
    edge(&f, &todo_object, &record_object);
    let items =
        f.db.agent_creation_batch_withdraw(
            &f.gui,
            &f.gui.binding,
            &batch(&[&update_op, &record_update_op, &record_op, &todo_op]),
        )
        .unwrap();
    assert_eq!(items.len(), 2);
    assert!(items.iter().all(|item| success(&item.outcome)));
    assert!(!visible(&f, &record_object));
    assert!(!visible(&f, &todo_object));
    assert!(f.db.record_version_get(&target, &version).is_ok());
    assert!(crate::db::todo_revisions::retained_snapshot(&f.db.conn, &snapshot).is_ok());
    for id in [&record_op, &record_update_op, &todo_op, &update_op] {
        assert_eq!(
            f.db.agent_operation_get(&f.gui, &f.gui.binding, id)
                .unwrap()
                .undo_state,
            "undone"
        );
    }
    let replay =
        f.db.agent_creation_batch_withdraw(
            &f.gui,
            &f.gui.binding,
            &batch(&[&record_op, &record_update_op, &todo_op, &update_op]),
        )
        .unwrap();
    assert!(replay.iter().all(|item| success(&item.outcome)));
}

#[test]
fn outside_visible_reference_blocks_dependents_but_independent_creation_succeeds() {
    let mut f = fixture();
    let (record_op, record_object, _, _) = record(&mut f, "Dependent record", 'b');
    let (todo_op, todo_object, _, _) = todo(&mut f, "Dependent todo");
    let (independent_op, independent_object, _, _) = record(&mut f, "Independent record", 'c');
    edge(&f, &todo_object, &record_object);
    let external =
        f.db.todo_create(TodoCreateInput {
            scope: TodoScope::Workspace,
            project_id: None,
            content: "Human reference owner".into(),
            priority: "normal".into(),
            due_date: None,
            tag_ids: vec![],
        })
        .unwrap();
    let external_object = ObjectRef {
        workspace_id: f.gui.binding.workspace_id.clone(),
        scope: Scope::Workspace,
        kind: ObjectKind::Todo,
        id: external.id.to_string(),
    };
    edge(&f, &external_object, &todo_object);
    let items =
        f.db.agent_creation_batch_withdraw(
            &f.gui,
            &f.gui.binding,
            &batch(&[&independent_op, &todo_op, &record_op]),
        )
        .unwrap();
    assert_eq!(items.len(), 3);
    assert!(items.iter().filter(|item| success(&item.outcome)).count() == 1);
    assert!(items
        .iter()
        .any(|item| item.object == independent_object && success(&item.outcome)));
    assert!(items.iter().filter(|item| !success(&item.outcome)).all(|item|
        matches!(&item.outcome, OperationUndoBatchOutcome::Failed { error } if error.code == ErrorCode::UndoConflict)));
    assert!(visible(&f, &record_object));
    assert!(visible(&f, &todo_object));
    assert!(!visible(&f, &independent_object));
}

#[test]
fn retained_edge_from_previously_withdrawn_source_does_not_block() {
    let mut f = fixture();
    let (target_op, target_object, _, _) = record(&mut f, "Remaining target", 'd');
    let (source_op, source_object, _, _) = record(&mut f, "Withdrawn source", 'e');
    edge(&f, &source_object, &target_object);
    let source =
        f.db.agent_creation_batch_withdraw(&f.gui, &f.gui.binding, &batch(&[&source_op]))
            .unwrap();
    assert!(success(&source[0].outcome));
    assert!(!visible(&f, &source_object));
    assert_eq!(count(&f, "content_reference_edges"), 1);
    let target =
        f.db.agent_creation_batch_withdraw(&f.gui, &f.gui.binding, &batch(&[&target_op]))
            .unwrap();
    assert!(success(&target[0].outcome));
    assert!(!visible(&f, &target_object));
}

#[test]
fn second_receipt_failure_rolls_back_every_candidate_and_outbox() {
    let mut f = fixture();
    let (first_op, first_object, _, _) = record(&mut f, "First", 'f');
    let (second_op, second_object, _, _) = todo(&mut f, "Second");
    edge(&f, &first_object, &second_object);
    edge(&f, &second_object, &first_object);
    let outbox_before = count(&f, "agent_change_log");
    f.db.conn.execute_batch(&format!("CREATE TRIGGER reject_second_batch_receipt BEFORE UPDATE OF undo_state ON agent_operation_receipts WHEN OLD.operation_id='{second_op}' AND NEW.undo_state='undone' BEGIN SELECT RAISE(ABORT,'second receipt unavailable'); END;")).unwrap();
    let items = f
        .db
        .agent_creation_batch_withdraw(&f.gui, &f.gui.binding, &batch(&[&first_op, &second_op]))
        .unwrap();
    assert_eq!(items.len(), 2);
    assert!(items
        .iter()
        .all(|item| matches!(&item.outcome, OperationUndoBatchOutcome::Failed { .. })));
    assert!(visible(&f, &first_object));
    assert!(visible(&f, &second_object));
    assert_eq!(count(&f, "agent_object_withdrawals"), 0);
    assert_eq!(count(&f, "agent_change_log"), outbox_before);
    for id in [&first_op, &second_op] {
        let entry =
            f.db.agent_operation_get(&f.gui, &f.gui.binding, id)
                .unwrap();
        assert_eq!(entry.undo_state, "available");
        assert!(entry.undo_operation_id.is_none());
    }
}
