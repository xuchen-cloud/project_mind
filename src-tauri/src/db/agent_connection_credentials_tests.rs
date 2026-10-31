use super::*;
use std::{cell::RefCell, collections::HashMap};

const ID: &str = "0123456789abcdef0123456789abcdef";
const OLD: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn fixture() -> (tempfile::TempDir, Database, WorkspaceBinding) {
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(&root.path().join("app.sqlite"), root.path(), None).unwrap();
    db.native_workspace_id = Some("workspace-a".into());
    let binding = WorkspaceBinding {
        workspace_id: "workspace-a".into(),
        generation: "open-1".into(),
    };
    (root, db, binding)
}

fn legacy(db: &Database, binding: &WorkspaceBinding, id: &str, native: bool) {
    let scope = serde_json::json!({"workspaceId":binding.workspace_id,"workspaceContent":true,
        "projectIds":[],"allProjects":native,"objects":null,
        "tokenHash":format!("{:x}", Sha256::digest(OLD.as_bytes()))});
    let operations = if native {
        vec![
            "context.read",
            "source.read",
            "content.create",
            "schedule.manage",
        ]
    } else {
        vec!["context.read", "source.read"]
    };
    db.conn.execute("INSERT INTO agent_connection_grants(id,client_label,scope_grant_json,operations_json,enabled,created_at,revoked_at) VALUES(?1,'original',?2,?3,1,'original-time',NULL)",
        params![id, scope.to_string(), serde_json::to_string(&operations).unwrap()]).unwrap();
}

fn snapshot(db: &Database, id: &str) -> serde_json::Value {
    let stored = db.stored_connection(id).unwrap().unwrap();
    serde_json::json!({"scope":serde_json::from_str::<serde_json::Value>(&stored.scope_json).unwrap(),
        "operations":stored.operations_json,"label":stored.client_label,"created":stored.created_at,
        "enabled":stored.enabled,"revoked":stored.revoked_at})
}

#[test]
fn migration_preserves_external_read_only_and_native_grants_and_rotates_authentication() {
    let (_root, db, binding) = fixture();
    let native_id = "abcdef0123456789abcdef0123456789";
    legacy(&db, &binding, ID, false);
    legacy(&db, &binding, native_id, true);
    let before = [snapshot(&db, ID), snapshot(&db, native_id)];
    let files = RefCell::new(HashMap::<String, String>::new());
    db.agent_connection_migrate_local_credentials(
        &binding,
        |id| Ok(files.borrow().get(id).cloned()),
        |id, token| {
            files.borrow_mut().insert(id.into(), token.into());
            Ok(())
        },
    )
    .unwrap();
    for (index, id) in [ID, native_id].iter().enumerate() {
        let mut after = snapshot(&db, id);
        assert_eq!(after["scope"]["localCredentialVersion"], 1);
        after["scope"]
            .as_object_mut()
            .unwrap()
            .remove("localCredentialVersion");
        after["scope"]["tokenHash"] = before[index]["scope"]["tokenHash"].clone();
        assert_eq!(after, before[index]);
        assert!(db
            .agent_connection_authenticate(&binding, id, OLD, "old")
            .is_err());
        assert!(db
            .agent_connection_authenticate(&binding, id, &files.borrow()[*id], "new")
            .is_ok());
    }
    db.agent_connection_migrate_local_credentials(
        &binding,
        |_| panic!("version 1 must not read credentials"),
        |_, _| panic!("version 1 must not recreate credentials"),
    )
    .unwrap();
}

#[test]
fn migration_skips_revoked_and_disabled_without_credential_io() {
    let (_root, db, binding) = fixture();
    legacy(&db, &binding, ID, false);
    db.conn
        .execute("UPDATE agent_connection_grants SET enabled=0", [])
        .unwrap();
    let before = snapshot(&db, ID);
    db.agent_connection_migrate_local_credentials(
        &binding,
        |_| panic!("disabled read"),
        |_, _| panic!("disabled save"),
    )
    .unwrap();
    assert_eq!(snapshot(&db, ID), before);
    db.conn
        .execute(
            "UPDATE agent_connection_grants SET enabled=1,revoked_at='revoked'",
            [],
        )
        .unwrap();
    let before = snapshot(&db, ID);
    db.agent_connection_migrate_local_credentials(
        &binding,
        |_| panic!("revoked read"),
        |_, _| panic!("revoked save"),
    )
    .unwrap();
    assert_eq!(snapshot(&db, ID), before);
}

#[test]
fn migration_save_failure_leaves_legacy_grant_intact() {
    let (_root, db, binding) = fixture();
    legacy(&db, &binding, ID, false);
    let before = snapshot(&db, ID);
    assert!(db
        .agent_connection_migrate_local_credentials(
            &binding,
            |_| Ok(None),
            |_, _| Err(io_error("injected write failure"))
        )
        .is_err());
    assert_eq!(snapshot(&db, ID), before);
}

#[test]
fn migration_reuses_pending_file_after_database_failure() {
    let (_root, db, binding) = fixture();
    legacy(&db, &binding, ID, false);
    let before = snapshot(&db, ID);
    let pending = RefCell::new(None::<String>);
    db.conn.execute_batch("CREATE TRIGGER reject_rotation BEFORE UPDATE ON agent_connection_grants BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    assert!(db
        .agent_connection_migrate_local_credentials(
            &binding,
            |_| Ok(None),
            |_, token| {
                *pending.borrow_mut() = Some(token.into());
                Ok(())
            }
        )
        .is_err());
    assert_eq!(snapshot(&db, ID), before);
    db.conn
        .execute_batch("DROP TRIGGER reject_rotation")
        .unwrap();
    db.agent_connection_migrate_local_credentials(
        &binding,
        |_| Ok(pending.borrow().clone()),
        |_, _| panic!("pending token must be reused"),
    )
    .unwrap();
    assert!(db
        .agent_connection_authenticate(
            &binding,
            ID,
            pending.borrow().as_ref().unwrap(),
            "recovered"
        )
        .is_ok());
}

#[test]
fn migration_fails_closed_for_wrong_binding_foreign_scope_and_malformed_grants() {
    let (_root, db, binding) = fixture();
    legacy(&db, &binding, ID, false);
    let mut wrong = binding.clone();
    wrong.workspace_id = "foreign".into();
    assert!(db
        .agent_connection_migrate_local_credentials(
            &wrong,
            |_| panic!("wrong binding read"),
            |_, _| panic!("wrong binding save")
        )
        .is_err());
    db.conn.execute("UPDATE agent_connection_grants SET scope_grant_json=json_set(scope_grant_json,'$.workspaceId','foreign')", []).unwrap();
    assert!(db
        .agent_connection_migrate_local_credentials(
            &binding,
            |_| panic!("foreign read"),
            |_, _| panic!("foreign save")
        )
        .is_err());
    db.conn
        .execute(
            "UPDATE agent_connection_grants SET scope_grant_json='{}'",
            [],
        )
        .unwrap();
    assert!(db
        .agent_connection_migrate_local_credentials(
            &binding,
            |_| panic!("malformed read"),
            |_, _| panic!("malformed save")
        )
        .is_err());
}

#[test]
fn migration_cas_rejects_grant_changed_during_local_credential_io() {
    let (_root, db, binding) = fixture();
    legacy(&db, &binding, ID, false);
    assert!(db
        .agent_connection_migrate_local_credentials(
            &binding,
            |_| Ok(None),
            |_, _| {
                db.conn
                    .execute(
                        "UPDATE agent_connection_grants SET operations_json='[]' WHERE id=?1",
                        [ID],
                    )
                    .unwrap();
                Ok(())
            }
        )
        .is_err());
    let after = snapshot(&db, ID);
    assert!(after["scope"].get("localCredentialVersion").is_none());
    assert_eq!(after["operations"], "[]");
}

#[test]
fn migration_retains_exact_object_scope_without_widening_authentication() {
    let (_root, db, binding) = fixture();
    legacy(&db, &binding, ID, false);
    let objects = serde_json::to_string(&vec![ObjectRef {
        workspace_id: binding.workspace_id.clone(),
        scope: Scope::Workspace,
        kind: ObjectKind::QuickNote,
        id: "1".into(),
    }])
    .unwrap();
    db.conn.execute("UPDATE agent_connection_grants SET scope_grant_json=json_set(scope_grant_json,'$.objects',json(?1))", [objects]).unwrap();
    let before = snapshot(&db, ID);
    let token = "f".repeat(64);
    db.agent_connection_migrate_local_credentials(
        &binding,
        |_| Ok(Some(token.clone())),
        |_, _| panic!("reuse pending"),
    )
    .unwrap();
    let mut after = snapshot(&db, ID);
    after["scope"]
        .as_object_mut()
        .unwrap()
        .remove("localCredentialVersion");
    after["scope"]["tokenHash"] = before["scope"]["tokenHash"].clone();
    assert_eq!(before, after);
    assert!(db
        .agent_connection_authenticate(&binding, ID, &token, "object-scoped")
        .is_err());
}
