use super::*;

fn fixture() -> (tempfile::TempDir, Database, WorkspaceBinding) {
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(&root.path().join("selector.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace("object-selector").unwrap();
    for (id, archived) in [(1, 0), (2, 1)] {
        db.conn.execute(
            "INSERT INTO projects(id,name,root_path,is_archived,created_at,updated_at) VALUES(?1,'Project',?2,?3,'now','now')",
            params![id, format!("workspace:project-{id}"), archived],
        ).unwrap();
    }
    let binding = WorkspaceBinding { workspace_id: "object-selector".into(), generation: "open-1".into() };
    (root, db, binding)
}

fn record(db: &Database, project: i64, title: &str) -> i64 {
    db.conn.execute(
        "INSERT INTO notes(project_id,title,created_at,updated_at) VALUES(?1,?2,'now','now')",
        params![project, title],
    ).unwrap();
    db.conn.last_insert_rowid()
}

fn file(db: &Database, project: i64, title: &str, mode: &str) -> i64 {
    db.conn.execute(
        "INSERT INTO documents(project_id,name,base_name,original_path,managed_path,storage_mode,mime_type,created_at,updated_at) VALUES(?1,?2,?2,'','','', 'text/plain','now','now')",
        params![project, title],
    ).unwrap();
    let id = db.conn.last_insert_rowid();
    db.conn.execute("UPDATE documents SET storage_mode=?1 WHERE id=?2", params![mode,id]).unwrap();
    id
}

fn input(scope: Scope, query: &str) -> ConnectionObjectsInput {
    ConnectionObjectsInput { scope, query: query.into(), cursor: None }
}

#[test]
fn selector_pages_visible_metadata_only_and_cursor_is_bound_to_query_and_scope() {
    let (_root, db, binding) = fixture();
    for number in 0..25 { record(&db, 1, &format!("Allowed {number:02}")); }
    let excluded_id = record(&db, 1, "Allowed excluded");
    let withdrawn_id = record(&db, 1, "Allowed withdrawn");
    record(&db, 2, "Allowed archived");
    file(&db, 1, "Allowed file.txt", "managed");
    file(&db, 1, "Allowed image.png", "managed_note_image");
    let excluded = ObjectRef { workspace_id:binding.workspace_id.clone(),scope:Scope::Project{project_id:1},kind:ObjectKind::Record,id:excluded_id.to_string() };
    let withdrawn = ObjectRef { id:withdrawn_id.to_string(), ..excluded.clone() };
    db.conn.execute("INSERT INTO source_access_policies(object_key,excluded,revision) VALUES(?1,1,1)", [excluded.key().unwrap()]).unwrap();
    db.conn.execute("INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,revision) VALUES(?1,'receipt','now',1)", [withdrawn.key().unwrap()]).unwrap();
    let mut request = input(Scope::Project{project_id:1}, "Allowed");
    let first = db.agent_connection_objects(&binding, &request).unwrap();
    assert_eq!(first.items.len(), 20);
    assert!(first.next_cursor.is_some());
    assert!(first.items.iter().all(|item| item.object.kind == ObjectKind::File || item.object.kind == ObjectKind::Record));
    request.cursor = first.next_cursor;
    let second = db.agent_connection_objects(&binding, &request).unwrap();
    assert_eq!(second.items.len(), 6);
    assert!(second.next_cursor.is_none());
    let all = first.items.into_iter().chain(second.items).collect::<Vec<_>>();
    assert_eq!(all.iter().filter(|item| item.object.kind == ObjectKind::File).count(), 1);
    assert!(!all.iter().any(|item| item.object == excluded || item.object == withdrawn || item.title.contains("archived") || item.title.contains("image")));
    let mut mismatched = request.clone();
    mismatched.query = "Other".into();
    assert_eq!(db.agent_connection_objects(&binding, &mismatched).unwrap_err().code, ErrorCode::InvalidArgument);
    let wrong_binding = WorkspaceBinding {workspace_id:"other".into(),generation:binding.generation.clone()};
    assert_eq!(db.agent_connection_objects(&wrong_binding, &request).unwrap_err().code, ErrorCode::WorkspaceChanged);
}

#[test]
fn selector_escapes_like_wildcards_and_bounds_title_and_query() {
    let (_root, db, binding) = fixture();
    let literal = record(&db, 1, &format!("100%_literal {}", "x".repeat(140)));
    record(&db, 1, "100Xyliteral");
    let page = db.agent_connection_objects(&binding, &input(Scope::Project{project_id:1}, "%_")).unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].object.id, literal.to_string());
    assert_eq!(page.items[0].title.chars().count(), 120);
    assert_eq!(db.agent_connection_objects(&binding, &input(Scope::Project{project_id:1}, &"x".repeat(201))).unwrap_err().code, ErrorCode::InvalidArgument);
}

#[test]
fn selector_workspace_scope_only_lists_workspace_records() {
    let (_root, db, binding) = fixture();
    record(&db, 1, "Project record");
    db.conn.execute("INSERT INTO workspace_notes(note_kind,title,created_at,updated_at) VALUES('workspace_note','Workspace record','now','now')", []).unwrap();
    db.conn.execute("INSERT INTO workspace_notes(note_kind,title,created_at,updated_at) VALUES('today_quick_note','QuickNote','now','now')", []).unwrap();
    let page = db.agent_connection_objects(&binding, &input(Scope::Workspace, "")).unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].title, "Workspace record");
    assert_eq!(page.items[0].object.scope, Scope::Workspace);
}
