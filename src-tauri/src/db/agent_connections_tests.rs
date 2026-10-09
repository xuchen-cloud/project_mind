use super::*;

fn fixture() -> (tempfile::TempDir, Database, WorkspaceBinding) {
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(&root.path().join("app.sqlite"), root.path(), None).unwrap();
    db.native_workspace_id = Some("workspace-a".into());
    for (id, name, archived) in [(1, "Included", 0), (2, "Other", 0), (3, "Archived", 1)] {
        db.conn.execute(
            "INSERT INTO projects(id,name,root_path,is_archived,created_at,updated_at) VALUES(?1,?2,?3,?4,'now','now')",
            params![id, name, format!("workspace:project-{id}"), archived],
        ).unwrap();
    }
    let binding = WorkspaceBinding {
        workspace_id: "workspace-a".into(),
        generation: "open-1".into(),
    };
    (root, db, binding)
}

fn create(db: &Database, binding: &WorkspaceBinding) -> ConnectionGrant {
    db.agent_connection_create(
        binding,
        &ConnectionCreateInput {
            objects: None,
            client_label: "  Test CLI  ".into(),
            workspace_content: true,
            project_ids: vec![1],
            all_projects: false,
            session_read: false,
            write_operations: vec![],
        },
        "0123456789abcdef0123456789abcdef",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    )
    .unwrap()
}

#[test]
fn connection_scope_and_revocation_are_enforced_from_storage() {
    let (_root, db, binding) = fixture();
    let grant = create(&db, &binding);
    assert_eq!(grant.client_label, "Test CLI");
    assert_eq!(grant.operations, vec!["context.read", "source.read"]);
    let request = db
        .agent_connection_authenticate(
            &binding,
            &grant.id,
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "request-1",
        )
        .unwrap();
    assert!(request
        .authorize(&binding, &Scope::Workspace, "context.read")
        .is_ok());
    assert!(request
        .authorize(&binding, &Scope::Project { project_id: 1 }, "context.read")
        .is_ok());
    assert_eq!(
        request
            .authorize(&binding, &Scope::Project { project_id: 2 }, "context.read")
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    assert_eq!(
        request
            .authorize(&binding, &Scope::Project { project_id: 1 }, "session.read")
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    assert_eq!(
        db.agent_connection_projects(&request, &binding)
            .unwrap()
            .iter()
            .map(|p| p.id)
            .collect::<Vec<_>>(),
        vec![1]
    );
    assert_eq!(db.agent_connection_list(&binding).unwrap().len(), 1);
    assert_eq!(
        db.agent_connection_authenticate(&binding, &grant.id, &"f".repeat(64), "request-2")
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    let revoked = db.agent_connection_revoke(&binding, &grant.id).unwrap();
    assert!(!revoked.enabled);
    assert_eq!(
        db.agent_connection_revoke(&binding, &grant.id)
            .unwrap()
            .revoked_at,
        revoked.revoked_at
    );
    assert_eq!(
        db.agent_connection_authenticate(
            &binding,
            &grant.id,
            &"0123456789abcdef".repeat(4),
            "request-3"
        )
        .unwrap_err()
        .code,
        ErrorCode::ScopeDenied
    );
}

#[test]
fn invalid_scopes_and_other_workspace_cannot_obtain_grants() {
    let (_root, db, binding) = fixture();
    let grant = create(&db, &binding);
    let other = WorkspaceBinding {
        workspace_id: "workspace-b".into(),
        generation: binding.generation.clone(),
    };
    assert_eq!(
        db.agent_connection_list(&other).unwrap_err().code,
        ErrorCode::WorkspaceChanged
    );
    assert_eq!(
        db.agent_connection_revoke(&other, &grant.id)
            .unwrap_err()
            .code,
        ErrorCode::WorkspaceChanged
    );
    assert_eq!(
        db.agent_connection_authenticate(
            &other,
            &grant.id,
            &"0123456789abcdef".repeat(4),
            "request-4"
        )
        .unwrap_err()
        .code,
        ErrorCode::WorkspaceChanged
    );
    let invalid = ConnectionCreateInput {
        objects: None,
        client_label: "bad".into(),
        workspace_content: false,
        project_ids: vec![3],
        all_projects: false,
        session_read: false,
        write_operations: vec![],
    };
    assert_eq!(
        db.agent_connection_create(&binding, &invalid, &"a".repeat(32), &"b".repeat(64))
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
}

#[test]
fn public_grant_never_serializes_secret_or_digest() {
    let (_root, db, binding) = fixture();
    let grant = create(&db, &binding);
    let json = serde_json::to_string(&grant).unwrap();
    assert!(!json.contains("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"));
    assert!(!json.contains("tokenHash"));
    assert!(!json.contains("scopeGrant"));
}

#[test]
fn project_list_omits_excluded_project_even_when_granted() {
    let (_root, db, binding) = fixture();
    let grant = create(&db, &binding);
    let request = db
        .agent_connection_authenticate(
            &binding,
            &grant.id,
            &"0123456789abcdef".repeat(4),
            "request-project-list",
        )
        .unwrap();
    let project = ObjectRef {
        workspace_id: binding.workspace_id.clone(),
        scope: Scope::Project { project_id: 1 },
        kind: ObjectKind::Project,
        id: "1".into(),
    };
    db.conn
        .execute(
            "INSERT INTO source_access_policies(object_key,excluded,revision) VALUES(?1,1,1)",
            [project.key().unwrap()],
        )
        .unwrap();
    assert!(db
        .agent_connection_projects(&request, &binding)
        .unwrap()
        .is_empty());
}

#[test]
fn authenticate_rejects_invalid_request_id_before_bridge_dispatch() {
    let (_root, db, binding) = fixture();
    let grant = create(&db, &binding);
    for id in ["", &"x".repeat(129)] {
        assert_eq!(
            db.agent_connection_authenticate(
                &binding,
                &grant.id,
                &"0123456789abcdef".repeat(4),
                id
            )
            .unwrap_err()
            .code,
            ErrorCode::InvalidArgument,
        );
    }
}

#[test]
fn selected_record_writes_are_canonical_and_persisted_exactly() {
    let (_root, db, binding) = fixture();
    let token = "c".repeat(64);
    let grant = db.agent_connection_create(
        &binding,
        &ConnectionCreateInput {
            objects: None,
            client_label: "Record editor".into(),
            workspace_content: false,
            project_ids: vec![1],
            all_projects: false,
            session_read: true,
            write_operations: vec![
                "record.restore".into(),
                "content.create".into(),
                "record.restore".into(),
                "operation.undo".into(),
            ],
        },
        &"d".repeat(32),
        &token,
    ).unwrap();
    let expected = vec![
        "context.read", "source.read", "session.read", "operation.read",
        "content.create", "record.restore", "operation.undo",
        "operation.restore_created",
    ];
    assert_eq!(grant.operations, expected);
    let stored: String = db.conn.query_row(
        "SELECT operations_json FROM agent_connection_grants WHERE id=?1",
        [&grant.id],
        |row| row.get(0),
    ).unwrap();
    assert_eq!(serde_json::from_str::<Vec<String>>(&stored).unwrap(), expected);
    let request = db.agent_connection_authenticate(&binding, &grant.id, &token, "write-check").unwrap();
    assert_eq!(request.scope_grant.operations, expected);
    assert!(request.authorize(&binding, &Scope::Project { project_id: 1 }, "record.restore").is_ok());
    assert!(request.authorize(&binding, &Scope::Project { project_id: 1 }, "operation.restore_created").is_ok());
    assert_eq!(request.authorize(&binding, &Scope::Project { project_id: 1 }, "record.patch").unwrap_err().code, ErrorCode::ScopeDenied);
    assert_eq!(request.authorize(&binding, &Scope::Project { project_id: 2 }, "record.restore").unwrap_err().code, ErrorCode::ScopeDenied);
    let patch_grant = db.agent_connection_create(
        &binding,
        &ConnectionCreateInput {
            objects: None,
            client_label: "Patch only".into(),
            workspace_content: false,
            project_ids: vec![1],
            all_projects: false,
            session_read: false,
            write_operations: vec!["record.patch".into()],
        },
        &"e".repeat(32),
        &"f".repeat(64),
    ).unwrap();
    assert_eq!(patch_grant.operations, vec!["context.read", "source.read", "operation.read", "record.patch"]);
}

#[test]
fn unsupported_writes_fail_and_old_json_remains_read_only() {
    let (_root, db, binding) = fixture();
    let mut input: ConnectionCreateInput = serde_json::from_value(serde_json::json!({
        "clientLabel":"Old client",
        "workspaceContent":false,
        "projectIds":[1],
        "sessionRead":false
    })).unwrap();
    assert!(input.write_operations.is_empty());
    assert!(!input.all_projects);
    let grant = db.agent_connection_create(&binding, &input, &"a".repeat(32), &"b".repeat(64)).unwrap();
    assert!(!grant.all_projects);
    assert_eq!(grant.operations, vec!["context.read", "source.read"]);
    let stored: String = db.conn.query_row(
        "SELECT scope_grant_json FROM agent_connection_grants WHERE id=?1",
        [&grant.id], |row| row.get(0),
    ).unwrap();
    let mut old_scope: serde_json::Value = serde_json::from_str(&stored).unwrap();
    old_scope.as_object_mut().unwrap().remove("allProjects");
    old_scope.as_object_mut().unwrap().remove("objects");
    db.conn.execute(
        "UPDATE agent_connection_grants SET scope_grant_json=?1 WHERE id=?2",
        params![old_scope.to_string(), grant.id],
    ).unwrap();
    assert!(!db.agent_connection_list(&binding).unwrap()[0].all_projects);
    assert_eq!(db.agent_connection_list(&binding).unwrap()[0].objects, None);
    let old_request = db.agent_connection_authenticate(&binding, &grant.id, &"b".repeat(64), "old-scope").unwrap();
    assert_eq!(old_request.scope_grant.project_ids, vec![1]);
    assert!(old_request.scope_grant.object_keys.is_none());
    for operation in ["operation.read", "operation.restore_created", "record.delete"] {
        input.write_operations = vec![operation.into()];
        assert_eq!(
            db.agent_connection_create(&binding, &input, &"c".repeat(32), &"d".repeat(64))
                .unwrap_err().code,
            ErrorCode::InvalidArgument,
        );
    }
    let count: i64 = db.conn.query_row("SELECT count(*) FROM agent_connection_grants", [], |row| row.get(0)).unwrap();
    assert_eq!(count, 1);
}

#[test]
fn native_file_preflight_and_transaction_recheck_persisted_connection_grant() {
    let (_root, db, binding) = fixture();
    let token = "9".repeat(64);
    let grant = db.agent_connection_create(
        &binding,
        &ConnectionCreateInput {
            objects: None,
            client_label: "File editor".into(), workspace_content: false,
            project_ids: vec![1], all_projects: false, session_read: false,
            write_operations: vec!["content.create".into(), "file.update".into(), "file.restore".into()],
        },
        &"8".repeat(32), &token,
    ).unwrap();
    assert!(grant.operations.iter().any(|op| op == "file.update"));
    assert!(grant.operations.iter().any(|op| op == "file.restore"));
    let request = db.agent_connection_authenticate(&binding, &grant.id, &token, "file-request").unwrap();
    let input = super::super::file_imports::AgentFileCreateInput {
        project_id: 1, safe_name: "connection.txt".into(), utf8_content: "bytes".into(),
    };
    db.agent_file_create_authorize(&request, &binding, &input).unwrap();
    db.agent_connection_require_live(&request, &binding, &Scope::Project { project_id: 1 }, "file.update").unwrap();
    db.agent_connection_revoke(&binding, &grant.id).unwrap();
    assert_eq!(db.agent_file_create_authorize(&request, &binding, &input).unwrap_err().code, ErrorCode::ScopeDenied);
    assert_eq!(db.agent_connection_require_live(&request, &binding, &Scope::Project { project_id: 1 }, "file.restore").unwrap_err().code, ErrorCode::ScopeDenied);
    let result = db.agent_atomic_operation::<serde_json::Value>(
        &request.caller.key(), &request.request_id, "file.version.commit", &serde_json::json!({"probe":true}),
        |_| panic!("revoked grant reached native File mutation"),
    );
    assert_eq!(result.unwrap_err().code, ErrorCode::ScopeDenied);
    let count: i64 = db.conn.query_row(
        "SELECT count(*) FROM agent_operation_receipts WHERE caller_id=?1 AND request_id=?2",
        rusqlite::params![request.caller.key(), request.request_id], |row| row.get(0),
    ).unwrap();
    assert_eq!(count, 0);
}

#[test]
fn todo_update_grant_persists_without_changing_prior_read_only_grants() {
    let (_root, db, binding) = fixture();
    let original = create(&db, &binding);
    let grant = db.agent_connection_create(
        &binding,
        &ConnectionCreateInput {
            objects: None,
            client_label: "Todo editor".into(),
            workspace_content: false,
            project_ids: vec![1],
            all_projects: false,
            session_read: false,
            write_operations: vec!["todo.update".into(), "content.create".into(), "todo.update".into()],
        },
        &"7".repeat(32),
        &"8".repeat(64),
    ).unwrap();
    let expected = vec!["context.read", "source.read", "operation.read", "content.create", "todo.update"];
    assert_eq!(grant.operations, expected);
    let stored: String = db.conn.query_row(
        "SELECT operations_json FROM agent_connection_grants WHERE id=?1",
        [&grant.id],
        |row| row.get(0),
    ).unwrap();
    assert_eq!(serde_json::from_str::<Vec<String>>(&stored).unwrap(), expected);
    assert_eq!(db.agent_connection_list(&binding).unwrap().into_iter()
        .find(|item| item.id == original.id).unwrap().operations,
        vec!["context.read", "source.read"]);
    let request = db.agent_connection_authenticate(&binding, &grant.id, &"8".repeat(64), "todo-auth").unwrap();
    assert!(request.authorize(&binding, &Scope::Project { project_id: 1 }, "todo.update").is_ok());
    assert_eq!(request.authorize(&binding, &Scope::Project { project_id: 1 }, "record.patch").unwrap_err().code, ErrorCode::ScopeDenied);
}

#[test]
fn all_projects_resolves_current_projects_without_expanding_workspace_content() {
    let (_root, db, binding) = fixture();
    let input = ConnectionCreateInput {
        objects: None,
        client_label: "All project reader".into(),
        workspace_content: false,
        project_ids: vec![],
        all_projects: true,
        session_read: false,
        write_operations: vec![],
    };
    let token = "b".repeat(64);
    let grant = db.agent_connection_create(&binding, &input, &"a".repeat(32), &token).unwrap();
    assert!(grant.all_projects);
    assert!(grant.project_ids.is_empty());
    assert!(!grant.workspace_content);
    assert_eq!(grant.operations, vec!["context.read", "source.read"]);
    let public = serde_json::to_value(&grant).unwrap();
    assert_eq!(public["allProjects"], true);
    assert_eq!(public["projectIds"], serde_json::json!([]));
    assert_eq!(db.agent_connection_list(&binding).unwrap()[0].all_projects, true);

    let first = db.agent_connection_authenticate(&binding, &grant.id, &token, "all-first").unwrap();
    assert_eq!(first.scope_grant.project_ids, vec![1, 2]);
    assert_eq!(first.authorize(&binding, &Scope::Workspace, "context.read").unwrap_err().code, ErrorCode::ScopeDenied);
    assert_eq!(first.authorize(&binding, &Scope::Project { project_id: 1 }, "record.patch").unwrap_err().code, ErrorCode::ScopeDenied);
    db.conn.execute(
        "INSERT INTO projects(id,name,root_path,is_archived,created_at,updated_at) VALUES(4,'New','workspace:project-4',0,'now','now')",
        [],
    ).unwrap();
    assert_eq!(first.authorize(&binding, &Scope::Project { project_id: 4 }, "context.read").unwrap_err().code, ErrorCode::ScopeDenied);
    let second = db.agent_connection_authenticate(&binding, &grant.id, &token, "all-second").unwrap();
    assert_eq!(second.scope_grant.project_ids, vec![1, 2, 4]);
    assert!(second.authorize(&binding, &Scope::Project { project_id: 4 }, "context.read").is_ok());
    db.conn.execute("UPDATE projects SET is_archived=1 WHERE id=2", []).unwrap();
    let third = db.agent_connection_authenticate(&binding, &grant.id, &token, "all-third").unwrap();
    assert_eq!(third.scope_grant.project_ids, vec![1, 4]);
    assert_eq!(db.agent_connection_projects(&third, &binding).unwrap().into_iter().map(|item| item.id).collect::<Vec<_>>(), vec![1, 4]);

    let other = WorkspaceBinding { workspace_id: "workspace-b".into(), generation: binding.generation.clone() };
    assert_eq!(db.agent_connection_authenticate(&other, &grant.id, &token, "other").unwrap_err().code, ErrorCode::WorkspaceChanged);
    db.agent_connection_revoke(&binding, &grant.id).unwrap();
    assert_eq!(db.agent_connection_authenticate(&binding, &grant.id, &token, "revoked").unwrap_err().code, ErrorCode::ScopeDenied);
}

#[test]
fn all_projects_rejects_explicit_ids_and_native_file_recheck_uses_target() {
    let (_root, db, binding) = fixture();
    let mut input = ConnectionCreateInput {
        objects: None,
        client_label: "All project File writer".into(),
        workspace_content: true,
        project_ids: vec![1],
        all_projects: true,
        session_read: false,
        write_operations: vec!["file.update".into()],
    };
    let token = "d".repeat(64);
    assert_eq!(db.agent_connection_create(&binding, &input, &"c".repeat(32), &token).unwrap_err().code, ErrorCode::InvalidArgument);
    input.project_ids.clear();
    let grant = db.agent_connection_create(&binding, &input, &"c".repeat(32), &token).unwrap();
    assert!(grant.all_projects && grant.workspace_content && grant.project_ids.is_empty());
    let request = db.agent_connection_authenticate(&binding, &grant.id, &token, "file-all").unwrap();
    db.conn.execute(
        "INSERT INTO projects(id,name,root_path,is_archived,created_at,updated_at) VALUES(4,'New','workspace:project-4',0,'now','now')",
        [],
    ).unwrap();
    db.conn.execute("UPDATE projects SET is_archived=1 WHERE id=2", []).unwrap();
    db.agent_connection_require_live(&request, &binding, &Scope::Project { project_id: 1 }, "file.update").unwrap();
    assert_eq!(db.agent_connection_require_live(&request, &binding, &Scope::Project { project_id: 2 }, "file.update").unwrap_err().code, ErrorCode::ScopeDenied);
    let fresh = db.agent_connection_authenticate(&binding, &grant.id, &token, "file-new").unwrap();
    db.agent_connection_require_live(&fresh, &binding, &Scope::Project { project_id: 4 }, "file.update").unwrap();
    db.conn.execute("UPDATE projects SET is_archived=1 WHERE id=4", []).unwrap();
    assert_eq!(db.agent_connection_require_live(&fresh, &binding, &Scope::Project { project_id: 4 }, "file.update").unwrap_err().code, ErrorCode::ScopeDenied);
    db.agent_connection_revoke(&binding, &grant.id).unwrap();
    assert_eq!(db.agent_connection_require_live(&request, &binding, &Scope::Project { project_id: 1 }, "file.update").unwrap_err().code, ErrorCode::ScopeDenied);
}

fn insert_record(db: &Database, project_id: i64, title: &str) -> i64 {
    db.conn.execute(
        "INSERT INTO notes(project_id,title,content_markdown,content_html,created_at,updated_at) VALUES(?1,?2,'body','<p>body</p>','now','now')",
        params![project_id, title],
    ).unwrap();
    db.conn.last_insert_rowid()
}

fn record_ref(binding: &WorkspaceBinding, project_id: i64, id: i64) -> ObjectRef {
    ObjectRef {
        workspace_id: binding.workspace_id.clone(),
        scope: Scope::Project { project_id },
        kind: ObjectKind::Record,
        id: id.to_string(),
    }
}

fn selected_input(objects: Vec<ObjectRef>) -> ConnectionCreateInput {
    ConnectionCreateInput {
        client_label: "Selected records".into(), workspace_content: false,
        project_ids: vec![1, 2], all_projects: false, session_read: false,
        write_operations: vec!["record.patch".into(), "record.restore".into(), "file.update".into(), "file.restore".into(), "operation.undo".into()],
        objects: Some(objects),
    }
}

#[test]
fn selected_objects_are_persisted_and_centrally_enforced_after_new_objects_arrive() {
    let (_root, db, binding) = fixture();
    let selected = record_ref(&binding, 1, insert_record(&db, 1, "Selected"));
    let other = record_ref(&binding, 2, insert_record(&db, 2, "Other"));
    let token = "4".repeat(64);
    let grant = db.agent_connection_create(&binding, &selected_input(vec![selected.clone()]), &"3".repeat(32), &token).unwrap();
    assert_eq!(grant.objects, Some(vec![selected.clone()]));
    assert_eq!(db.agent_connection_list(&binding).unwrap()[0].objects, grant.objects);
    let request = db.agent_connection_authenticate(&binding, &grant.id, &token, "selected-read").unwrap();
    assert_eq!(request.scope_grant.object_keys, Some(vec![selected.key().unwrap()]));
    request.authorize_object(&binding, &selected, &selected, "record.patch").unwrap();
    assert_eq!(request.authorize_object(&binding, &other, &other, "record.patch").unwrap_err().code, ErrorCode::ScopeDenied);
    assert_eq!(request.require_object_allowed(&other).unwrap_err().code, ErrorCode::ScopeDenied);
    assert_eq!(request.require_scope_context().unwrap_err().code, ErrorCode::ScopeDenied);
    assert_eq!(db.agent_connection_projects(&request, &binding).unwrap().into_iter().map(|p| p.id).collect::<Vec<_>>(), vec![1]);
    let parent = ObjectRef { workspace_id: binding.workspace_id.clone(), scope: selected.scope.clone(), kind: ObjectKind::Project, id: "1".into() };
    assert_eq!(db.source_read_object(&request, &binding, &parent).unwrap_err().code, ErrorCode::ScopeDenied);
    db.agent_connection_require_live(&request, &binding, &selected.scope, "record.patch").unwrap();
    let new_object = record_ref(&binding, 1, insert_record(&db, 1, "New after grant"));
    assert_eq!(request.authorize_object(&binding, &new_object, &new_object, "source.read").unwrap_err().code, ErrorCode::ScopeDenied);
    assert_eq!(db.source_read_object(&request, &binding, &new_object).unwrap_err().code, ErrorCode::ScopeDenied);
    db.conn.execute(
        "INSERT INTO source_access_policies(object_key,excluded,revision) VALUES(?1,1,1)",
        [ObjectRef { workspace_id: binding.workspace_id.clone(), scope: selected.scope.clone(), kind: ObjectKind::Project, id: "1".into() }.key().unwrap()],
    ).unwrap();
    assert!(db.agent_connection_projects(&request, &binding).unwrap().is_empty());
    // A changed persisted object selection cannot be used by a captured File/Record request.
    let stored: String = db.conn.query_row("SELECT scope_grant_json FROM agent_connection_grants WHERE id=?1", [&grant.id], |r| r.get(0)).unwrap();
    let mut scope: serde_json::Value = serde_json::from_str(&stored).unwrap();
    scope["objects"] = serde_json::json!([other]);
    db.conn.execute("UPDATE agent_connection_grants SET scope_grant_json=?1 WHERE id=?2", params![scope.to_string(), grant.id]).unwrap();
    assert_eq!(db.agent_connection_require_live(&request, &binding, &selected.scope, "record.patch").unwrap_err().code, ErrorCode::ScopeDenied);
}

#[test]
fn object_grants_reject_broad_permissions_bad_scope_and_invisible_sources() {
    let (_root, db, binding) = fixture();
    let first = record_ref(&binding, 1, insert_record(&db, 1, "First"));
    let second = record_ref(&binding, 2, insert_record(&db, 2, "Second"));
    let base = selected_input(vec![first.clone()]);
    for input in [
        ConnectionCreateInput { all_projects: true, project_ids: vec![], ..base.clone() },
        ConnectionCreateInput { session_read: true, ..base.clone() },
        ConnectionCreateInput { write_operations: vec!["content.create".into()], ..base.clone() },
        ConnectionCreateInput { write_operations: vec!["todo.update".into()], ..base.clone() },
        ConnectionCreateInput { objects: Some(vec![]), ..base.clone() },
        ConnectionCreateInput { objects: Some(vec![first.clone(); 51]), ..base.clone() },
        ConnectionCreateInput { objects: Some(vec![first.clone(), first.clone()]), ..base.clone() },
        ConnectionCreateInput { objects: Some(vec![ObjectRef {kind:ObjectKind::Todo,..first.clone()}]), ..base.clone() },
    ] {
        assert_eq!(db.agent_connection_create(&binding, &input, &"a".repeat(32), &"b".repeat(64)).unwrap_err().code, ErrorCode::InvalidArgument);
    }
    let cross_scope = ConnectionCreateInput { project_ids: vec![1], objects: Some(vec![second.clone()]), ..base.clone() };
    assert_eq!(db.agent_connection_create(&binding, &cross_scope, &"a".repeat(32), &"b".repeat(64)).unwrap_err().code, ErrorCode::ScopeDenied);
    let wrong_workspace = ConnectionCreateInput { objects: Some(vec![ObjectRef {workspace_id:"elsewhere".into(),..first.clone()}]), ..base.clone() };
    assert_eq!(db.agent_connection_create(&binding, &wrong_workspace, &"a".repeat(32), &"b".repeat(64)).unwrap_err().code, ErrorCode::InvalidArgument);
    let wrong_claim = ConnectionCreateInput { objects: Some(vec![ObjectRef {scope:Scope::Project {project_id:2},..first.clone()}]), ..base.clone() };
    assert_eq!(db.agent_connection_create(&binding, &wrong_claim, &"a".repeat(32), &"b".repeat(64)).unwrap_err().code, ErrorCode::ScopeDenied);
    db.conn.execute("INSERT INTO source_access_policies(object_key,excluded,revision) VALUES(?1,1,1)", [first.key().unwrap()]).unwrap();
    assert_eq!(db.agent_connection_create(&binding, &base, &"a".repeat(32), &"b".repeat(64)).unwrap_err().code, ErrorCode::ScopeDenied);
    db.conn.execute("DELETE FROM source_access_policies", []).unwrap();
    db.conn.execute("INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,revision) VALUES(?1,'receipt','now',1)", [first.key().unwrap()]).unwrap();
    assert_eq!(db.agent_connection_create(&binding, &base, &"a".repeat(32), &"b".repeat(64)).unwrap_err().code, ErrorCode::ObjectWithdrawn);
}

#[test]
fn object_selection_accepts_exactly_fifty_distinct_visible_records() {
    let (_root, db, binding) = fixture();
    let objects = (0..50).map(|index| record_ref(&binding, 1, insert_record(&db, 1, &format!("Record {index}")))).collect::<Vec<_>>();
    let input = selected_input(objects.clone());
    let grant = db.agent_connection_create(&binding, &input, &"e".repeat(32), &"f".repeat(64)).unwrap();
    assert_eq!(grant.objects, Some(objects));
}
