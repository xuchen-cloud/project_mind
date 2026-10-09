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
            client_label: "  Test CLI  ".into(),
            workspace_content: true,
            project_ids: vec![1],
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
        client_label: "bad".into(),
        workspace_content: false,
        project_ids: vec![3],
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
            client_label: "Record editor".into(),
            workspace_content: false,
            project_ids: vec![1],
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
            client_label: "Patch only".into(),
            workspace_content: false,
            project_ids: vec![1],
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
    let grant = db.agent_connection_create(&binding, &input, &"a".repeat(32), &"b".repeat(64)).unwrap();
    assert_eq!(grant.operations, vec!["context.read", "source.read"]);
    for operation in ["file.update", "todo.update", "operation.read", "operation.restore_created", "record.delete"] {
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
