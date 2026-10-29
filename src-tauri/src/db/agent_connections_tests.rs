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

#[test]
fn builtin_project_page_uses_frozen_ids_and_live_keyset() {
    let (_root, db, binding) = fixture();
    db.conn.execute("INSERT INTO projects(id,name,root_path,is_archived,created_at,updated_at) VALUES(4,'C','workspace:c',0,'now','now')", []).unwrap();
    let request = RequestContext {
        binding: binding.clone(), request_id: "project-page".into(), caller: Caller::Gui,
        scope_grant: ScopeGrant { object_keys: None, workspace_id: binding.workspace_id.clone(),
            workspace_content: true, project_ids: vec![1,2,3],
            operations: vec!["context.read".into(), "source.read".into()] },
    };
    let first = db.agent_project_page(&request, &binding, None, 1).unwrap();
    assert_eq!(first.items.iter().map(|p| p.id).collect::<Vec<_>>(), vec![1]);
    assert_eq!(first.next_cursor.as_deref(), Some("1"));
    let second = db.agent_project_page(&request, &binding, first.next_cursor.as_deref(), 1).unwrap();
    assert_eq!(second.items.iter().map(|p| p.id).collect::<Vec<_>>(), vec![2]);
    assert!(second.next_cursor.is_none());
    db.conn.execute("UPDATE projects SET is_archived=1 WHERE id=2", []).unwrap();
    assert!(db.agent_project_page(&request, &binding, Some("1"), 1).unwrap().items.is_empty());
    assert_eq!(db.agent_project_page(&request, &binding, Some("01"), 1).unwrap_err().code,
        ErrorCode::InvalidArgument);
}

fn create(db: &Database, binding: &WorkspaceBinding) -> ConnectionGrant {
    db.agent_connection_create(
        binding,
        &ConnectionCreateInput {
            client_label: "  Test CLI  ".into(),
            workspace_content: true,
            project_ids: vec![1],
            all_projects: false,
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
    assert_eq!(grant.operations, vec!["context.read", "source.read", "session.read"]);
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
    assert!(request.authorize(&binding, &Scope::Project { project_id: 1 }, "session.read").is_ok());
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
        client_label: "bad".into(),
        workspace_content: false,
        project_ids: vec![3],
        all_projects: false,
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
            client_label: "Record editor".into(),
            workspace_content: false,
            project_ids: vec![1],
            all_projects: false,
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
            client_label: "Patch only".into(),
            workspace_content: false,
            project_ids: vec![1],
            all_projects: false,
            write_operations: vec!["record.patch".into()],
        },
        &"e".repeat(32),
        &"f".repeat(64),
    ).unwrap();
    assert_eq!(patch_grant.operations, vec!["context.read", "source.read", "session.read", "operation.read", "record.patch"]);
}

#[test]
fn unsupported_writes_fail_and_old_json_keeps_original_scope() {
    let (_root, db, binding) = fixture();
    let mut input: ConnectionCreateInput = serde_json::from_value(serde_json::json!({
        "clientLabel":"Old client",
        "workspaceContent":false,
        "projectIds":[1]
    })).unwrap();
    assert!(input.write_operations.is_empty());
    assert!(!input.all_projects);
    let grant = db.agent_connection_create(&binding, &input, &"a".repeat(32), &"b".repeat(64)).unwrap();
    assert!(!grant.all_projects);
    assert_eq!(grant.operations, vec!["context.read", "source.read", "session.read"]);
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
            client_label: "File editor".into(), workspace_content: false,
            project_ids: vec![1], all_projects: false,
            write_operations: vec!["content.create".into(), "file.update".into(), "file.restore".into()],
        },
        &"8".repeat(32), &token,
    ).unwrap();
    assert!(grant.operations.iter().any(|op| op == "file.update"));
    assert!(grant.operations.iter().any(|op| op == "file.restore"));
    let request = db.agent_connection_authenticate(&binding, &grant.id, &token, "file-request").unwrap();
    let input = super::super::file_imports::AgentFileCreateInput {
        project_id: Some(1), safe_name: "connection.txt".into(), utf8_content: "bytes".into(),
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
            client_label: "Todo editor".into(),
            workspace_content: false,
            project_ids: vec![1],
            all_projects: false,
            write_operations: vec!["todo.update".into(), "content.create".into(), "todo.update".into()],
        },
        &"7".repeat(32),
        &"8".repeat(64),
    ).unwrap();
    let expected = vec!["context.read", "source.read", "session.read", "operation.read", "content.create", "todo.update"];
    assert_eq!(grant.operations, expected);
    let stored: String = db.conn.query_row(
        "SELECT operations_json FROM agent_connection_grants WHERE id=?1",
        [&grant.id],
        |row| row.get(0),
    ).unwrap();
    assert_eq!(serde_json::from_str::<Vec<String>>(&stored).unwrap(), expected);
    assert_eq!(db.agent_connection_list(&binding).unwrap().into_iter()
        .find(|item| item.id == original.id).unwrap().operations,
        vec!["context.read", "source.read", "session.read"]);
    let request = db.agent_connection_authenticate(&binding, &grant.id, &"8".repeat(64), "todo-auth").unwrap();
    assert!(request.authorize(&binding, &Scope::Project { project_id: 1 }, "todo.update").is_ok());
    assert_eq!(request.authorize(&binding, &Scope::Project { project_id: 1 }, "record.patch").unwrap_err().code, ErrorCode::ScopeDenied);
}

#[test]
fn all_projects_resolves_current_projects_without_expanding_workspace_content() {
    let (_root, db, binding) = fixture();
    let input = ConnectionCreateInput {
        client_label: "All project reader".into(),
        workspace_content: false,
        project_ids: vec![],
        all_projects: true,
        write_operations: vec![],
    };
    let token = "b".repeat(64);
    let grant = db.agent_connection_create(&binding, &input, &"a".repeat(32), &token).unwrap();
    assert!(grant.all_projects);
    assert!(grant.project_ids.is_empty());
    assert!(!grant.workspace_content);
    assert_eq!(grant.operations, vec!["context.read", "source.read", "session.read"]);
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
        client_label: "All project File writer".into(),
        workspace_content: true,
        project_ids: vec![1],
        all_projects: true,
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

#[test]
fn legacy_object_scoped_grant_is_listed_but_cannot_authenticate_or_commit() {
    let (_root, db, binding) = fixture();
    let grant = create(&db, &binding);
    let request = db.agent_connection_authenticate(&binding, &grant.id, &"0123456789abcdef".repeat(4), "before-migration").unwrap();
    let stored: String = db.conn.query_row("SELECT scope_grant_json FROM agent_connection_grants WHERE id=?1", [&grant.id], |row| row.get(0)).unwrap();
    let mut legacy: serde_json::Value = serde_json::from_str(&stored).unwrap();
    legacy["objects"] = serde_json::json!([{
        "workspaceId": binding.workspace_id,
        "scope": {"kind":"project", "projectId":1},
        "kind":"record", "id":"1"
    }]);
    db.conn.execute("UPDATE agent_connection_grants SET scope_grant_json=?1 WHERE id=?2",
        params![legacy.to_string(), grant.id]).unwrap();
    assert!(db.agent_connection_list(&binding).unwrap()[0].objects.is_some());
    assert_eq!(db.agent_connection_authenticate(&binding, &grant.id, &"0123456789abcdef".repeat(4), "after-migration").unwrap_err().code, ErrorCode::ScopeDenied);
    assert_eq!(db.agent_connection_require_live(&request, &binding, &Scope::Project { project_id: 1 }, "source.read").unwrap_err().code, ErrorCode::ScopeDenied);
    assert_eq!(connection_caller_live(&db.conn, &request.caller.key(), Some(&binding.workspace_id)).unwrap_err().code, ErrorCode::ScopeDenied);
}

#[test]
fn removed_object_and_history_selectors_are_rejected_at_input_boundary() {
    let old_object = serde_json::json!({"clientLabel":"legacy", "workspaceContent":true,
        "projectIds":[], "allProjects":true, "writeOperations":[], "objects":[]});
    let old_history = serde_json::json!({"clientLabel":"legacy", "workspaceContent":true,
        "projectIds":[], "allProjects":true, "writeOperations":[], "sessionRead":false});
    assert!(serde_json::from_value::<ConnectionCreateInput>(old_object).is_err());
    assert!(serde_json::from_value::<ConnectionCreateInput>(old_history).is_err());
}

#[test]
fn contacts_are_explicit_extra_operations_independent_of_content_scope() {
    for (index, selected) in [
        vec![],
        vec!["contact.read"],
        vec!["contact.write"],
        vec!["contact.read", "contact.write"],
    ]
    .into_iter()
    .enumerate()
    {
        let (_root, db, binding) = fixture();
        let id = format!("{:032x}", index + 1);
        let token = "a".repeat(64);
        let grant = db
            .agent_connection_create(
                &binding,
                &ConnectionCreateInput {
                    client_label: "Project contacts".into(),
                    workspace_content: false,
                    all_projects: false,
                    project_ids: vec![1],
                    write_operations: selected
                        .iter()
                        .map(|operation| (*operation).into())
                        .collect(),
                },
                &id,
                &token,
            )
            .unwrap();
        assert_eq!(
            grant
                .operations
                .iter()
                .any(|operation| operation == "contact.read"),
            !selected.is_empty()
        );
        assert_eq!(
            grant
                .operations
                .iter()
                .any(|operation| operation == "contact.write"),
            selected.contains(&"contact.write")
        );
        // Merely granting address-book access does not grant operation receipts
        // or Workspace/other-Project content.
        assert!(!grant
            .operations
            .iter()
            .any(|operation| operation == "operation.read"));
        let request = db
            .agent_connection_authenticate(&binding, &id, &token, "contacts")
            .unwrap();
        assert!(!request.scope_grant.workspace_content);
        assert_eq!(request.scope_grant.project_ids, vec![1]);
        assert!(request
            .authorize(&binding, &Scope::Workspace, "source.read")
            .is_err());
        assert!(request
            .authorize(&binding, &Scope::Project { project_id: 2 }, "source.read")
            .is_err());
        assert_eq!(request.scope_grant.operations, grant.operations);
    }
}

#[test]
fn ordinary_external_connections_never_upgrade_to_contacts() {
    let (_root, db, binding) = fixture();
    let original = create(&db, &binding);
    let listed = db.agent_connection_list(&binding).unwrap();
    assert_eq!(listed[0].operations, original.operations);
    assert!(!listed[0]
        .operations
        .iter()
        .any(|operation| operation.starts_with("contact.")));
    assert!(db
        .agent_connection_upgrade_embedded_grant(
            &binding,
            &listed[0],
            &"0123456789abcdef".repeat(4)
        )
        .is_err());
    assert_eq!(
        db.agent_connection_list(&binding).unwrap()[0].operations,
        original.operations
    );
}
