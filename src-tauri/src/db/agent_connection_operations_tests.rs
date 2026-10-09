use super::*;
use crate::{
    agent::{access::{Caller, RequestContext, ScopeGrant}, models::{ObjectKind, ObjectRef}},
    models::{ProjectCreateInput, ProjectRecordUpsertInput, TodoCreateInput, TodoScope},
    source_service::SourcePolicyUpdate,
};
use rusqlite::params;

struct Fixture {
    _root: tempfile::TempDir,
    db: Database,
    binding: WorkspaceBinding,
    request: RequestContext,
    object: ObjectRef,
    other_project_id: i64,
}

fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(&root.path().join("operations.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace("connection-operations").unwrap();
    let project = db.project_create(ProjectCreateInput { name: "Owned".into(), summary: None, status: None }).unwrap();
    let other = db.project_create(ProjectCreateInput { name: "Other".into(), summary: None, status: None }).unwrap();
    let todo = db.todo_create(TodoCreateInput {
        scope: TodoScope::Project, project_id: Some(project.id), content: "Native Todo".into(),
        priority: "normal".into(), due_date: None, tag_ids: vec![],
    }).unwrap();
    let binding = WorkspaceBinding { workspace_id: "connection-operations".into(), generation: "open-1".into() };
    let object = ObjectRef { workspace_id: binding.workspace_id.clone(), scope: Scope::Project { project_id: project.id }, kind: ObjectKind::Todo, id: todo.id.to_string() };
    let request = RequestContext {
        binding: binding.clone(), caller: Caller::Connection { grant_id: "mine".into() },
        request_id: "history-list".into(),
        scope_grant: ScopeGrant {
            object_keys: None,
            workspace_id: binding.workspace_id.clone(), workspace_content: false,
            project_ids: vec![project.id], operations: vec!["operation.read".into(), "source.read".into()],
        },
    };
    Fixture { _root: root, db, binding, request, object, other_project_id: other.id }
}

fn receipt(db: &Database, caller: &str, request: &str, id: &str, object: &ObjectRef) {
    db.conn.execute(
        "INSERT INTO agent_operation_receipts(request_id,caller_id,payload_hash,operation,state,result_json,created_at,operation_id,target_ref_json,undo_state) VALUES (?1,?2,'test-hash','todo.update','committed','{}','2026-01-01',?3,?4,'available')",
        params![request, caller, id, serde_json::to_string(object).unwrap()],
    ).unwrap();
}

fn input(scope: Scope, limit: u16) -> ConnectionOperationListInput {
    ConnectionOperationListInput { scope, cursor: None, limit, budget_chars: None }
}

#[test]
fn connection_history_only_returns_own_committed_receipts_with_snapshot_paging() {
    let f = fixture();
    let scope = f.object.scope.clone();
    receipt(&f.db, "connection:mine", "mine-1", &"1".repeat(32), &f.object);
    receipt(&f.db, "connection:other", "other-1", &"2".repeat(32), &f.object);
    receipt(&f.db, "gui", "gui-1", &"3".repeat(32), &f.object);
    receipt(&f.db, "run:foreign", "run-1", &"4".repeat(32), &f.object);
    receipt(&f.db, "connection:mine", "mine-2", &"5".repeat(32), &f.object);
    let mut query = input(scope, 1);
    let first = f.db.agent_connection_operation_list(&f.request, &f.binding, &query).unwrap();
    assert_eq!(first.operations.len(), 1);
    assert_eq!(first.operations[0].request_id, "mine-1");
    assert!(first.operations[0].run_id.is_none());
    assert!(first.next_cursor.is_some());
    receipt(&f.db, "connection:mine", "mine-after-snapshot", &"6".repeat(32), &f.object);
    query.cursor = first.next_cursor;
    let second = f.db.agent_connection_operation_list(&f.request, &f.binding, &query).unwrap();
    assert_eq!(second.operations.len(), 1);
    assert_eq!(second.operations[0].request_id, "mine-2");
    assert!(second.next_cursor.is_none());
    let fresh = f.db.agent_connection_operation_list(&f.request, &f.binding, &input(f.object.scope.clone(), 20)).unwrap();
    assert_eq!(fresh.operations.iter().map(|entry| entry.request_id.as_str()).collect::<Vec<_>>(), vec!["mine-1", "mine-2", "mine-after-snapshot"]);
}

#[test]
fn connection_history_rejects_other_caller_scope_cursor_and_tiny_budget() {
    let f = fixture();
    receipt(&f.db, "connection:mine", "mine-1", &"1".repeat(32), &f.object);
    receipt(&f.db, "connection:mine", "mine-2", &"2".repeat(32), &f.object);
    let mut query = input(f.object.scope.clone(), 1);
    let first = f.db.agent_connection_operation_list(&f.request, &f.binding, &query).unwrap();
    let mut gui = f.request.clone();
    gui.caller = Caller::Gui;
    assert_eq!(f.db.agent_connection_operation_list(&gui, &f.binding, &query).unwrap_err().code, ErrorCode::ScopeDenied);
    let mut other = f.request.clone();
    other.caller = Caller::Connection { grant_id: "other".into() };
    assert!(f.db.agent_connection_operation_list(&other, &f.binding, &query).unwrap().operations.is_empty());
    query.scope = Scope::Project { project_id: f.other_project_id };
    assert_eq!(f.db.agent_connection_operation_list(&f.request, &f.binding, &query).unwrap_err().code, ErrorCode::ScopeDenied);
    query.scope = f.object.scope.clone();
    query.cursor = first.next_cursor;
    query.limit = 2;
    assert_eq!(f.db.agent_connection_operation_list(&f.request, &f.binding, &query).unwrap_err().code, ErrorCode::InvalidArgument);
    query.cursor = None;
    query.budget_chars = Some(1);
    assert_eq!(f.db.agent_connection_operation_list(&f.request, &f.binding, &query).unwrap_err().code, ErrorCode::BudgetExceeded);
}

#[test]
fn connection_history_hides_currently_excluded_source() {
    let f = fixture();
    receipt(&f.db, "connection:mine", "mine-1", &"1".repeat(32), &f.object);
    let input = input(f.object.scope.clone(), 20);
    assert_eq!(f.db.agent_connection_operation_list(&f.request, &f.binding, &input).unwrap().operations.len(), 1);
    let mut gui = f.request.clone();
    gui.caller = Caller::Gui;
    gui.request_id = "exclude-todo".into();
    gui.scope_grant.operations = vec!["settings.write".into(), "source.read".into()];
    f.db.source_policy_update(&gui, &f.binding, &SourcePolicyUpdate {
        object: f.object.clone(), expected_revision: 0, excluded: true,
    }).unwrap();
    assert!(f.db.agent_connection_operation_list(&f.request, &f.binding, &input).unwrap().operations.is_empty());
}

#[test]
fn connection_history_trims_for_cursor_and_accepts_exact_complete_page_budget() {
    let f = fixture();
    for (ordinal, id) in [('1', "one"), ('2', "two"), ('3', "three")] {
        receipt(&f.db, "connection:mine", id, &ordinal.to_string().repeat(32), &f.object);
    }
    let scope = f.object.scope.clone();
    let complete = f.db.agent_connection_operation_list(&f.request, &f.binding, &input(scope.clone(), 3)).unwrap();
    assert_eq!(complete.operations.len(), 3);
    assert!(complete.next_cursor.is_none());
    let exact = size(&complete).unwrap();
    let mut query = input(scope.clone(), 3);
    query.budget_chars = Some(exact);
    let page = f.db.agent_connection_operation_list(&f.request, &f.binding, &query).unwrap();
    assert_eq!(page.operations.len(), 3);
    assert!(page.next_cursor.is_none());
    assert_eq!(size(&page).unwrap(), exact);

    let one = f.db.agent_connection_operation_list(&f.request, &f.binding, &input(scope.clone(), 1)).unwrap();
    let budget = size(&one).unwrap() + 16;
    assert!(budget < exact);
    query.budget_chars = Some(budget);
    let mut seen = Vec::new();
    loop {
        let page = f.db.agent_connection_operation_list(&f.request, &f.binding, &query).unwrap();
        assert!(size(&page).unwrap() <= budget);
        assert!(!page.operations.is_empty());
        seen.extend(page.operations.iter().map(|entry| entry.request_id.clone()));
        let Some(next) = page.next_cursor else { break; };
        query.cursor = Some(next);
    }
    assert_eq!(seen, vec!["one", "two", "three"]);
}

#[test]
fn withdrawn_record_receipt_remains_owned_but_exclusion_hides_history() {
    let mut f = fixture();
    let project_id = match &f.object.scope { Scope::Project { project_id } => *project_id, _ => unreachable!() };
    let record = f.db.project_record_upsert(ProjectRecordUpsertInput {
        project_id, note_id: None, title: Some("Recoverable".into()),
        markdown: "content".into(), html: "<p>content</p>".into(),
        default_code_language: None, tag_ids: vec![],
    }).unwrap();
    let object = ObjectRef {
        workspace_id: f.binding.workspace_id.clone(), scope: f.object.scope.clone(),
        kind: ObjectKind::Record, id: record.id.to_string(),
    };
    let id = "a".repeat(32);
    receipt(&f.db, "connection:mine", "record-create", &id, &object);
    f.db.conn.execute(
        "UPDATE agent_operation_receipts SET operation='record.create' WHERE operation_id=?1", [&id],
    ).unwrap();
    f.db.conn.execute(
        "INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,revision) VALUES(?1,?2,'2026-01-02',1)",
        params![object.key().unwrap(), id],
    ).unwrap();
    let entry = f.db.agent_connection_operation_get(&f.request, &f.binding, &id).unwrap();
    assert_eq!(entry.recovery.as_ref().unwrap().withdrawn, true);
    let list = f.db.agent_connection_operation_list(&f.request, &f.binding, &input(object.scope.clone(), 20)).unwrap();
    assert_eq!(list.operations.iter().filter(|entry| entry.operation_id == id).count(), 1);
    let mut exact_request = f.request.clone();
    exact_request.request_id = "record-create".into();
    assert_eq!(f.db.agent_connection_operation_for_request(&exact_request, &f.binding).unwrap().operation_id, id);

    let mut gui = f.request.clone();
    gui.caller = Caller::Gui;
    gui.request_id = "exclude-withdrawn-record".into();
    gui.scope_grant.operations = vec!["settings.write".into(), "source.read".into()];
    f.db.source_policy_update(&gui, &f.binding, &SourcePolicyUpdate {
        object: object.clone(), expected_revision: 0, excluded: true,
    }).unwrap();
    assert_eq!(f.db.agent_connection_operation_get(&f.request, &f.binding, &id).unwrap_err().code, ErrorCode::ScopeDenied);
    let list = f.db.agent_connection_operation_list(&f.request, &f.binding, &input(object.scope.clone(), 20)).unwrap();
    assert!(!list.operations.iter().any(|entry| entry.operation_id == id));
    // A successful write's exact receipt remains available for the immediate
    // operation response, even if the source policy changes afterward.
    assert_eq!(f.db.agent_connection_operation_for_request(&exact_request, &f.binding).unwrap().operation_id, id);
}

#[test]
fn withdrawn_todo_receipt_is_recoverable_until_source_is_excluded() {
    let f = fixture();
    let id = "b".repeat(32);
    receipt(&f.db, "connection:mine", "todo-create", &id, &f.object);
    f.db.conn.execute(
        "UPDATE agent_operation_receipts SET operation='todo.create' WHERE operation_id=?1",
        [&id],
    ).unwrap();
    f.db.conn.execute(
        "INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,revision) VALUES(?1,?2,'2026-01-02',1)",
        params![f.object.key().unwrap(), id],
    ).unwrap();

    assert_eq!(f.db.source_read_object(&f.request, &f.binding, &f.object).unwrap_err().code, ErrorCode::ObjectWithdrawn);
    let entry = f.db.agent_connection_operation_get(&f.request, &f.binding, &id).unwrap();
    assert_eq!(entry.recovery.as_ref().unwrap().withdrawn, true);
    let query = input(f.object.scope.clone(), 20);
    assert!(f.db.agent_connection_operation_list(&f.request, &f.binding, &query).unwrap().operations.iter().any(|entry| entry.operation_id == id));

    let mut gui = f.request.clone();
    gui.caller = Caller::Gui;
    gui.request_id = "exclude-withdrawn-todo".into();
    gui.scope_grant.operations = vec!["settings.write".into(), "source.read".into()];
    f.db.source_policy_update(&gui, &f.binding, &SourcePolicyUpdate {
        object: f.object.clone(), expected_revision: 0, excluded: true,
    }).unwrap();
    assert_eq!(f.db.agent_connection_operation_get(&f.request, &f.binding, &id).unwrap_err().code, ErrorCode::ScopeDenied);
    assert!(!f.db.agent_connection_operation_list(&f.request, &f.binding, &query).unwrap().operations.iter().any(|entry| entry.operation_id == id));
}

#[test]
fn recovery_source_rejects_other_object_kinds() {
    let f = fixture();
    let object = ObjectRef {
        kind: ObjectKind::Project,
        id: match &f.object.scope { Scope::Project { project_id } => project_id.to_string(), _ => unreachable!() },
        ..f.object.clone()
    };
    assert_eq!(f.db.source_read_recovery_object(&f.request, &f.binding, &object).unwrap_err().code, ErrorCode::InvalidArgument);
    let id = "c".repeat(32);
    receipt(&f.db, "connection:mine", "unsupported-kind", &id, &object);
    assert_eq!(f.db.agent_connection_operation_get(&f.request, &f.binding, &id).unwrap_err().code, ErrorCode::ScopeDenied);
    assert!(f.db.agent_connection_operation_list(&f.request, &f.binding, &input(object.scope.clone(), 20)).unwrap().operations.is_empty());
}
