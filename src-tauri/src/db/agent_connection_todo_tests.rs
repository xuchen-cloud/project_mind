use super::*;
use crate::agent::{
    access::ScopeGrant,
    operations::OperationUndoInput,
};
use crate::db::agent_record_withdrawals::{RecordRestoreInput, RecordWithdrawalInput};
use crate::models::{ProjectCreateInput, ProjectRecordUpsertInput};

struct Fixture {
    _root: tempfile::TempDir,
    db: Database,
    binding: WorkspaceBinding,
    request: RequestContext,
}
fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(&root.path().join("todo-connection.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace("todo-connection").unwrap();
    let binding = WorkspaceBinding { workspace_id: "todo-connection".into(), generation: "one".into() };
    let request = RequestContext {
        binding: binding.clone(), caller: Caller::Connection { grant_id: "todo-writer".into() },
        request_id: "output:external-todo".into(),
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(), workspace_content: true, project_ids: vec![],
            operations: ["content.create","todo.update","source.read","operation.undo","operation.restore_created"]
                .into_iter().map(str::to_owned).collect(),
        },
    };
    Fixture { _root: root, db, binding, request }
}
fn create(children: Vec<TodoNewChild>) -> ConnectionTodoCreateInput {
    ConnectionTodoCreateInput {
        scope: Scope::Workspace, content: "Plan delivery".into(), priority: "urgent_important".into(),
        due_date: None, tag_ids: vec![], children,
    }
}
fn child() -> TodoNewChild {
    TodoNewChild { content: "Check evidence".into(), progress_date: "2026-10-09".into(), due_date: None }
}

#[test]
fn connection_create_children_update_and_undo_use_native_snapshots_and_exact_owner() {
    let mut f = fixture();
    let input = create(vec![child()]);
    let created = f.db.agent_connection_todo_create(&f.request, &f.binding, &input).unwrap();
    assert_eq!(created.after_revision, 2);
    assert_eq!(f.db.agent_connection_todo_create(&f.request, &f.binding, &input).unwrap().operation_id, created.operation_id);
    let entry = f.db.agent_operation_access(&f.request, &f.binding, &created.operation_id, "operation.undo").unwrap();
    assert_eq!(entry.run_id, None);
    assert_eq!(entry.undo_state, "available");
    let before = todo_revisions::snapshot(&f.db.conn, id(&created.object).unwrap()).unwrap();
    assert_eq!(before.children.len(), 1);
    f.request.request_id = "todo-update".into();
    let input = ConnectionTodoUpdateInput {
        target: created.object.clone(), expected_revision: created.after_revision,
        changes: vec![TodoMutation::Content { content: "Deliver reviewed plan".into() }],
    };
    let saved = f.db.agent_connection_todo_update(&f.request, &f.binding, &input).unwrap();
    assert_eq!(saved.after_revision, 3);
    assert_eq!(f.db.agent_connection_todo_update(&f.request, &f.binding, &input).unwrap().operation_id, saved.operation_id);
    let mut foreign = f.request.clone();
    foreign.caller = Caller::Connection { grant_id: "other-writer".into() };
    foreign.request_id = "foreign-undo".into();
    let undo = OperationUndoInput { operation_id: saved.operation_id.clone(), expected_head_revision: 3 };
    assert_eq!(f.db.agent_todo_undo(&foreign, &f.binding, &undo).unwrap_err().code, ErrorCode::ScopeDenied);
    f.request.request_id = "todo-undo".into();
    let undone = f.db.agent_todo_undo(&f.request, &f.binding, &undo).unwrap();
    assert_eq!(undone.after_revision, 4);
    let restored = todo_revisions::snapshot(&f.db.conn, id(&created.object).unwrap()).unwrap();
    assert_eq!(restored.content, before.content);
    assert_eq!(restored.children, before.children);
    assert_eq!(f.db.agent_todo_undo(&f.request, &f.binding, &undo).unwrap().operation_id, undone.operation_id);
}

#[test]
fn connection_creation_withdraw_and_restore_replay_without_a_run() {
    let mut f = fixture();
    let created = f.db.agent_connection_todo_create(&f.request, &f.binding, &create(vec![child()])).unwrap();
    let input = RecordWithdrawalInput { creation_operation_id: created.operation_id.clone() };
    let mut foreign = f.request.clone();
    foreign.caller = Caller::Connection { grant_id: "other-writer".into() };
    assert_eq!(f.db.agent_todo_creation_withdraw(&foreign, &f.binding, &input).unwrap_err().code, ErrorCode::ScopeDenied);
    f.request.request_id = "todo-withdraw".into();
    let withdrawn = f.db.agent_todo_creation_withdraw(&f.request, &f.binding, &input).unwrap();
    assert!(withdrawn.withdrawn);
    assert_eq!(f.db.agent_todo_creation_withdraw(&f.request, &f.binding, &input).unwrap().operation_id, withdrawn.operation_id);
    assert_eq!(f.db.source_read_object(&f.request, &f.binding, &created.object).unwrap_err().code, ErrorCode::ObjectWithdrawn);
    f.request.request_id = "todo-restore-created".into();
    let restore = RecordRestoreInput { creation_operation_id: created.operation_id,
        expected_withdrawal_revision: withdrawn.revision };
    let restored = f.db.agent_todo_creation_restore(&f.request, &f.binding, &restore).unwrap();
    assert!(!restored.withdrawn);
    assert!(!f.db.agent_todo_creation_restore(&f.request, &f.binding, &restore).unwrap().withdrawn);
}

#[test]
fn connection_todo_rejects_invalid_child_stale_revision_and_excluded_source_atomically() {
    let mut f = fixture();
    let mut input = create(vec![child()]);
    input.children.push(TodoNewChild { progress_date: "2026-02-30".into(), ..child() });
    assert_eq!(f.db.agent_connection_todo_create(&f.request, &f.binding, &input).unwrap_err().code, ErrorCode::InvalidArgument);
    let count: i64 = f.db.conn.query_row("SELECT count(*) FROM todos", [], |row| row.get(0)).unwrap();
    assert_eq!(count, 0);
    let created = f.db.agent_connection_todo_create(&f.request, &f.binding, &create(vec![])).unwrap();
    f.db.todo_update_status(TodoUpdateStatusInput {
        todo_id: id(&created.object).unwrap(), expected_revision: created.after_revision,
        status: "finished".into(),
    }).unwrap();
    f.request.request_id = "stale-update".into();
    let stale = ConnectionTodoUpdateInput { target: created.object.clone(), expected_revision: created.after_revision,
        changes: vec![TodoMutation::Status { status: "unfinished".into() }] };
    assert_eq!(f.db.agent_connection_todo_update(&f.request, &f.binding, &stale).unwrap_err().code, ErrorCode::RevisionConflict);
    f.db.source_read_object(&f.request, &f.binding, &created.object).unwrap();
    f.db.conn.execute("INSERT INTO source_access_policies(object_key,excluded,revision) VALUES (?1,1,1)", [created.object.key().unwrap()]).unwrap();
    let allowed_revision = todo_revisions::head(&f.db.conn, id(&created.object).unwrap()).unwrap().revision;
    let update = ConnectionTodoUpdateInput { expected_revision: allowed_revision, ..stale };
    f.request.request_id = "excluded-update".into();
    assert_eq!(f.db.agent_connection_todo_update(&f.request, &f.binding, &update).unwrap_err().code, ErrorCode::ScopeDenied);
    assert_eq!(todo_revisions::head(&f.db.conn, id(&created.object).unwrap()).unwrap().revision, allowed_revision);
}

#[test]
fn connection_todo_create_checks_live_project_and_referenced_source() {
    let mut f = fixture();
    let project = f.db.project_create(ProjectCreateInput {
        name: "Policy project".into(), summary: None, status: None,
    }).unwrap();
    let record = f.db.project_record_upsert(ProjectRecordUpsertInput {
        project_id: project.id, note_id: None, title: Some("Excluded".into()),
        markdown: "Source".into(), html: "<p>Source</p>".into(),
        default_code_language: None, tag_ids: vec![],
    }).unwrap();
    f.request.scope_grant.project_ids.push(project.id);
    let mut input = create(vec![]);
    input.scope = Scope::Project { project_id: project.id };
    f.db.conn.execute("UPDATE projects SET is_archived=1 WHERE id=?1", [project.id]).unwrap();
    assert_eq!(f.db.agent_connection_todo_create(&f.request, &f.binding, &input).unwrap_err().code, ErrorCode::ScopeDenied);
    f.db.conn.execute("UPDATE projects SET is_archived=0 WHERE id=?1", [project.id]).unwrap();
    input.scope = Scope::Workspace;
    input.content = format!("Review [[note:{}|source]]", record.id);
    let source = ObjectRef { workspace_id: f.binding.workspace_id.clone(),
        scope: Scope::Project { project_id: project.id }, kind: ObjectKind::Record,
        id: record.id.to_string() };
    f.db.source_read_object(&f.request, &f.binding, &source).unwrap();
    f.db.conn.execute("INSERT INTO source_access_policies(object_key,excluded,revision) VALUES (?1,1,1)", [source.key().unwrap()]).unwrap();
    f.request.request_id = "excluded-reference-create".into();
    assert_eq!(f.db.agent_connection_todo_create(&f.request, &f.binding, &input).unwrap_err().code, ErrorCode::ScopeDenied);
    let count: i64 = f.db.conn.query_row("SELECT count(*) FROM todos", [], |row|row.get(0)).unwrap();
    assert_eq!(count, 0);
}
