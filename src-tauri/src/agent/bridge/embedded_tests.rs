use super::super::connection_store::ConnectionStore;
use super::*;
use crate::agent::{connection_todos::ConnectionTodoCreateInput, tools::BoundReadContextStore};
use std::cell::RefCell;

#[test]
fn execution_lease_enforces_mode_and_revocation() {
    let control = EmbeddedCliControl::default();
    assert!(control.open("unknown").is_err());
    let opened = control.open("read-only").unwrap();
    let token = opened["token"].as_str().unwrap();
    let lease = control.authorize(token, "record.get").unwrap();
    assert!(control.authorize(token, "record.patch").is_err());
    assert!(control
        .authorize("native-long-term-token", "record.get")
        .is_err());
    control.close(opened["leaseId"].as_str().unwrap()).unwrap();
    assert_eq!(lease.mode, "read-only");
    assert!(!lease.enabled.load(Ordering::Acquire));
    assert!(control.authorize(token, "record.get").is_err());
    for mode in ["workspace-write", "danger-full-access"] {
        let runtime = EmbeddedCliControl::default();
        let opened = runtime.open(mode).unwrap();
        let enabled = runtime
            .authorize(opened["token"].as_str().unwrap(), "record.patch")
            .unwrap();
        runtime.revoke();
        assert_eq!(enabled.mode, mode);
        assert!(!enabled.enabled.load(Ordering::Acquire));
        assert!(runtime.open(mode).is_err());
        assert!(runtime
            .authorize(opened["token"].as_str().unwrap(), "record.get")
            .is_err());
    }
}

#[test]
fn connection_status_uses_the_actual_lease_mode_without_relaxing_any_write() {
    let control = EmbeddedCliControl::default();
    for mode in ["read-only", "workspace-write", "danger-full-access"] {
        let opened = control.open(mode).unwrap();
        let token = opened["token"].as_str().unwrap();
        let status = control.authorize(token, "connection.status").unwrap();
        assert_eq!(status.mode, mode);
        for method in ["todo.create", "todo.update", "record.create", "record.patch", "file.create", "file.update"] {
            assert_eq!(control.authorize(token, method).is_ok(), mode != "read-only", "{mode}: {method}");
        }
        control.close(opened["leaseId"].as_str().unwrap()).unwrap();
        assert!(!status.enabled.load(Ordering::Acquire));
        assert!(control.authorize(token, "connection.status").is_err());
    }
}

#[test]
fn leases_are_independent_bounded_and_readonly_covers_every_registered_write() {
    let control = EmbeddedCliControl::default();
    let readonly = control.open("read-only").unwrap();
    for method in registry::registered_methods() {
        assert_eq!(
            control
                .authorize(readonly["token"].as_str().unwrap(), method.method)
                .is_ok(),
            method.read_only,
            "{}",
            method.method
        );
    }
    let write = control.open("workspace-write").unwrap();
    control
        .close(readonly["leaseId"].as_str().unwrap())
        .unwrap();
    assert!(control
        .authorize(write["token"].as_str().unwrap(), "todo.create")
        .is_ok());
    assert!(control
        .authorize(write["token"].as_str().unwrap(), "unregistered")
        .is_err());
    for _ in 1..MAX_LEASES {
        control.open("read-only").unwrap();
    }
    assert_eq!(
        control.open("read-only").unwrap_err().code,
        ErrorCode::BudgetExceeded
    );
    control.close(write["leaseId"].as_str().unwrap()).unwrap();
    assert!(control.open("read-only").is_ok());
}

#[test]
fn dropping_runtime_invalidates_outstanding_controls_and_storage_flags() {
    let control = EmbeddedCliControl::default();
    let opened = control.open("workspace-write").unwrap();
    let enabled = control
        .authorize(opened["token"].as_str().unwrap(), "todo.create")
        .unwrap();
    let runtime = EmbeddedCli {
        running: None,
        control: control.clone(),
        config: json!({}),
    };
    drop(runtime);
    assert!(!enabled.enabled.load(Ordering::Acquire));
    assert!(control.open("read-only").is_err());
    assert!(control
        .authorize(opened["token"].as_str().unwrap(), "record.get")
        .is_err());
}

#[derive(Default)]
struct Secrets(RefCell<HashMap<String, String>>);
impl CredentialStore for Secrets {
    fn load(&self, id: &str) -> AgentResult<String> {
        self.0.borrow().get(id).cloned().ok_or_else(denied)
    }
    fn save(&self, id: &str, token: &str) -> AgentResult<()> {
        self.0.borrow_mut().insert(id.into(), token.into());
        Ok(())
    }
    fn delete(&self, id: &str) -> AgentResult<()> {
        self.0.borrow_mut().remove(id);
        Ok(())
    }
}
fn fixture() -> (tempfile::TempDir, Database, WorkspaceBinding, i64, i64) {
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(&root.path().join("app.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace("embedded-workspace").unwrap();
    let project = |name: &str| {
        db.project_create(crate::models::ProjectCreateInput {
            name: name.into(),
            summary: None,
            status: None,
        })
        .unwrap()
        .id
    };
    let first = project("First");
    let second = project("Second");
    let binding = WorkspaceBinding {
        workspace_id: "embedded-workspace".into(),
        generation: "open-1".into(),
    };
    (root, db, binding, first, second)
}

#[test]
fn persistent_native_grants_are_exact_scope_and_excluded_from_external_bridge() {
    let (_root, db, binding, first, second) = fixture();
    let secrets = Secrets::default();
    let (project_id, project_token) = ensure_grant(&db, &binding, Some(first), &secrets).unwrap();
    let (workspace_id, workspace_token) = ensure_grant(&db, &binding, None, &secrets).unwrap();
    assert_ne!(project_id, workspace_id);
    assert_ne!(project_id, grant_id(&binding.workspace_id, Some(second)));
    assert_ne!(workspace_id, grant_id("another-workspace", None));
    let workspace = db
        .agent_connection_authenticate(&binding, &workspace_id, &workspace_token, "workspace")
        .unwrap();
    for scope in [
        Scope::Workspace,
        Scope::Project { project_id: first },
        Scope::Project { project_id: second },
    ] {
        workspace
            .authorize(&binding, &scope, "content.create")
            .unwrap();
    }
    let third = db
        .project_create(crate::models::ProjectCreateInput {
            name: "Later".into(),
            summary: None,
            status: None,
        })
        .unwrap()
        .id;
    let workspace = db
        .agent_connection_authenticate(&binding, &workspace_id, &workspace_token, "later-project")
        .unwrap();
    workspace
        .authorize(
            &binding,
            &Scope::Project { project_id: third },
            "content.create",
        )
        .unwrap();
    assert!(require_external(&workspace).is_err());
    let project = db
        .agent_connection_authenticate(&binding, &project_id, &project_token, "project")
        .unwrap();
    project
        .authorize(
            &binding,
            &Scope::Project { project_id: first },
            "content.create",
        )
        .unwrap();
    for scope in [
        Scope::Workspace,
        Scope::Project { project_id: second },
        Scope::Project { project_id: third },
    ] {
        assert!(project.authorize(&binding, &scope, "context.read").is_err());
    }
    assert!(require_external(&project).is_err());
    let foreign = WorkspaceBinding {
        workspace_id: "foreign".into(),
        generation: binding.generation.clone(),
    };
    assert!(workspace
        .authorize(&foreign, &Scope::Workspace, "context.read")
        .is_err());
    // An existing random external connection with the same prefix is unaffected.
    let external_id = "d5c11ea5000000000000000000000000";
    let token = "a".repeat(64);
    db.agent_connection_create(&binding, &grant_input(Some(first)), external_id, &token)
        .unwrap();
    let request = db
        .agent_connection_authenticate(&binding, external_id, &token, "external")
        .unwrap();
    require_external(&request).unwrap();
}

#[test]
fn legacy_workspace_native_grant_upgrades_without_rotating_identity_or_credentials() {
    let (_root, db, binding, first, _) = fixture();
    let secrets = Secrets::default();
    let id = grant_id(&binding.workspace_id, None);
    let token = "a".repeat(64);
    let mut legacy = grant_input(None);
    legacy.all_projects = false;
    legacy
        .write_operations
        .retain(|operation| operation != "schedule.manage" && !CONTACT_OPERATIONS.contains(&operation.as_str()));
    let original = db
        .agent_connection_create(&binding, &legacy, &id, &token)
        .unwrap();
    secrets.save(&id, &token).unwrap();
    let (reused_id, reused_token) = ensure_grant(&db, &binding, None, &secrets).unwrap();
    assert_eq!((reused_id, reused_token), (id.clone(), token.clone()));
    let upgraded = db.agent_connection_list(&binding).unwrap().remove(0);
    assert!(upgraded.all_projects);
    assert!(CONTACT_OPERATIONS.iter().all(|operation| upgraded.operations.iter().any(|actual| actual.as_str() == *operation)));
    assert_eq!(upgraded.created_at, original.created_at);
    let request = db
        .agent_connection_authenticate(&binding, &id, &token, "upgraded")
        .unwrap();
    request
        .authorize(
            &binding,
            &Scope::Project { project_id: first },
            "content.create",
        )
        .unwrap();
}

#[test]
fn scheduling_authority_requires_explicit_workspace_and_all_projects_grant() {
    let (_root, db, binding, first, _) = fixture();
    let secrets = Secrets::default();
    let (id, token) = ensure_grant(&db, &binding, None, &secrets).unwrap();
    let native = db
        .agent_connection_authenticate(&binding, &id, &token, "schedule")
        .unwrap();
    for operation in ["schedule.read", "schedule.manage"] {
        native
            .authorize(&binding, &Scope::Workspace, operation)
            .unwrap();
    }
    let (id, token) = ensure_grant(&db, &binding, Some(first), &secrets).unwrap();
    let project = db
        .agent_connection_authenticate(&binding, &id, &token, "schedule")
        .unwrap();
    assert!(project
        .authorize(
            &binding,
            &Scope::Project { project_id: first },
            "schedule.manage"
        )
        .is_err());
    for (workspace_content, all_projects, project_ids) in [
        (true, false, vec![]),
        (false, true, vec![]),
        (false, false, vec![first]),
    ] {
        let input = ConnectionCreateInput {
            client_label: "Explicit external scheduling".into(),
            workspace_content,
            all_projects,
            project_ids,
            write_operations: vec!["schedule.manage".into()],
        };
        assert!(db
            .agent_connection_create(&binding, &input, &"f".repeat(32), &"a".repeat(64))
            .is_err());
    }
    let input = ConnectionCreateInput {
        client_label: "Explicit external scheduling".into(),
        workspace_content: true,
        all_projects: true,
        project_ids: vec![],
        write_operations: vec!["schedule.manage".into()],
    };
    db.agent_connection_create(&binding, &input, &"f".repeat(32), &"a".repeat(64))
        .unwrap();
    let external = db
        .agent_connection_authenticate(&binding, &"f".repeat(32), &"a".repeat(64), "schedule")
        .unwrap();
    for operation in ["schedule.read", "schedule.manage"] {
        external
            .authorize(&binding, &Scope::Workspace, operation)
            .unwrap();
    }
    require_external(&external).unwrap();
}

#[test]
fn workspace_native_identity_covers_archived_projects_without_changing_source_policy() {
    let (_root, db, binding, first, _) = fixture();
    let secrets = Secrets::default();
    let (id, token) = ensure_grant(&db, &binding, None, &secrets).unwrap();
    db.project_set_archive(crate::models::ProjectArchiveInput {
        project_id: first,
        is_archived: true,
    })
    .unwrap();
    let native = db
        .agent_connection_authenticate(&binding, &id, &token, "archived")
        .unwrap();
    native
        .authorize(
            &binding,
            &Scope::Project { project_id: first },
            "source.read",
        )
        .unwrap();
    let object = crate::agent::models::ObjectRef {
        workspace_id: binding.workspace_id.clone(),
        scope: Scope::Project { project_id: first },
        kind: crate::agent::models::ObjectKind::Project,
        id: first.to_string(),
    };
    assert_eq!(
        db.source_read_object(&native, &binding, &object)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    let input = ConnectionCreateInput {
        client_label: "External all projects".into(),
        workspace_content: true,
        all_projects: true,
        project_ids: vec![],
        write_operations: vec![],
    };
    db.agent_connection_create(&binding, &input, &"e".repeat(32), &"a".repeat(64))
        .unwrap();
    let external = db
        .agent_connection_authenticate(&binding, &"e".repeat(32), &"a".repeat(64), "archived")
        .unwrap();
    assert!(external
        .authorize(
            &binding,
            &Scope::Project { project_id: first },
            "source.read"
        )
        .is_err());
}

#[test]
fn legacy_workspace_upgrade_preserves_revocation_user_edits_and_credentials() {
    for change in [
        "revoked",
        "label",
        "operations",
        "projects",
        "wrong-token",
        "missing-token",
    ] {
        let (_root, db, binding, first, _) = fixture();
        let secrets = Secrets::default();
        let id = grant_id(&binding.workspace_id, None);
        let token = "a".repeat(64);
        let mut legacy = grant_input(None);
        legacy.all_projects = false;
        legacy
            .write_operations
            .retain(|operation| operation != "schedule.manage" && !CONTACT_OPERATIONS.contains(&operation.as_str()));
        match change {
            "label" => legacy.client_label = "User changed connection".into(),
            "operations" => {
                legacy.write_operations.pop();
            }
            "projects" => legacy.project_ids = vec![first],
            _ => {}
        }
        db.agent_connection_create(&binding, &legacy, &id, &token)
            .unwrap();
        if change == "revoked" {
            db.agent_connection_revoke(&binding, &id).unwrap();
        }
        if change != "missing-token" {
            let saved = if change == "wrong-token" {
                "b".repeat(64)
            } else {
                token.clone()
            };
            secrets.save(&id, &saved).unwrap();
        }
        let before = serde_json::to_value(db.agent_connection_list(&binding).unwrap()).unwrap();
        let saved_secrets = secrets.0.borrow().clone();
        assert!(
            ensure_grant(&db, &binding, None, &secrets).is_err(),
            "{change}"
        );
        assert_eq!(
            serde_json::to_value(db.agent_connection_list(&binding).unwrap()).unwrap(),
            before,
            "{change}"
        );
        assert_eq!(*secrets.0.borrow(), saved_secrets, "{change}");
    }
}

#[test]
fn restart_reuses_native_identity_and_original_receipt() {
    let (root, db, binding, _, _) = fixture();
    let secrets = Secrets::default();
    let (id, token) = ensure_grant(&db, &binding, None, &secrets).unwrap();
    let request = db
        .agent_connection_authenticate(&binding, &id, &token, "stable-todo")
        .unwrap();
    let input = ConnectionTodoCreateInput {
        scope: Scope::Workspace,
        content: "Native receipt survives restart".into(),
        priority: "urgent_important".into(),
        due_date: None,
        tag_ids: vec![],
        children: vec![],
    };
    let saved = db
        .agent_connection_todo_create(&request, &binding, &input)
        .unwrap();
    drop(db);
    let mut db = Database::open(&root.path().join("app.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace(&binding.workspace_id).unwrap();
    let reopened = WorkspaceBinding {
        generation: "open-2".into(),
        ..binding
    };
    let (again_id, again_token) = ensure_grant(&db, &reopened, None, &secrets).unwrap();
    assert_eq!(again_id, id);
    assert_eq!(again_token, token);
    assert_eq!(db.agent_connection_list(&reopened).unwrap().len(), 1);
    let request = db
        .agent_connection_authenticate(&reopened, &again_id, &again_token, "stable-todo")
        .unwrap();
    let replay = db
        .agent_connection_todo_create(&request, &reopened, &input)
        .unwrap();
    assert_eq!(replay.operation_id, saved.operation_id);
    assert_eq!(replay.object, saved.object);
    db.agent_connection_operation_get(&request, &reopened, &saved.operation_id)
        .unwrap();
}

#[test]
fn revoked_or_mismatched_or_missing_credentials_never_regrant() {
    let (_root, db, binding, first, _) = fixture();
    let secrets = Secrets::default();
    let (id, token) = ensure_grant(&db, &binding, Some(first), &secrets).unwrap();
    let mut grant = db.agent_connection_list(&binding).unwrap().remove(0);
    grant.all_projects = true;
    assert!(validate_grant(&grant, &binding, Some(first)).is_err());
    grant.all_projects = false;
    grant.operations.push("unknown".into());
    assert!(validate_grant(&grant, &binding, Some(first)).is_err());
    secrets.delete(&id).unwrap();
    assert!(ensure_grant(&db, &binding, Some(first), &secrets).is_err());
    secrets.save(&id, &"b".repeat(64)).unwrap();
    assert!(ensure_grant(&db, &binding, Some(first), &secrets).is_err());
    secrets.save(&id, &token).unwrap();
    db.agent_connection_revoke(&binding, &id).unwrap();
    assert!(ensure_grant(&db, &binding, Some(first), &secrets).is_err());
    assert_eq!(secrets.load(&id).unwrap(), token);
    assert_eq!(db.agent_connection_list(&binding).unwrap().len(), 1);
}

struct Store {
    binding: RefCell<WorkspaceBinding>,
    db: Database,
}
impl crate::committed_changes::CommittedChangePublisher for Store {
    fn publish_committed(&self, _: crate::committed_changes::CommittedChanges) {}
}
impl crate::source_service::BoundSourceStore for Store {
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        self.with_current_context(|binding, db, _| action(binding, db))
    }
}
impl BoundReadContextStore for Store {
    fn with_current_context<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database, &str) -> AgentResult<T>,
    ) -> AgentResult<T> {
        action(&self.binding.borrow(), &self.db, "Embedded fixture")
    }
}
#[test]
fn in_flight_storage_rechecks_lease_and_workspace_binding() {
    let (_root, db, binding, _, _) = fixture();
    let (id, token) = ensure_grant(&db, &binding, None, &Secrets::default()).unwrap();
    let store = Store {
        binding: RefCell::new(binding.clone()),
        db,
    };
    let control = EmbeddedCliControl::default();
    let opened = control.open("workspace-write").unwrap();
    let enabled = control
        .authorize(opened["token"].as_str().unwrap(), "todo.create")
        .unwrap();
    let input = CallInput {
        instance_id: "fixture".into(),
        grant_id: id,
        request_id: "phase".into(),
        binding,
        method: "todo.create".into(),
        params: json!({}),
    };
    let connection = ConnectionStore {
        inner: &store,
        enabled: &enabled.enabled,
        token: &token,
        input: &input,
    };
    connection.with_authenticated(|_, _, _, _| Ok(())).unwrap();
    store.binding.borrow_mut().generation = "reopened".into();
    assert_eq!(
        connection
            .with_authenticated(|_, _, _, _| Ok(()))
            .unwrap_err()
            .code,
        ErrorCode::WorkspaceChanged
    );
    *store.binding.borrow_mut() = input.binding.clone();
    control.close(opened["leaseId"].as_str().unwrap()).unwrap();
    assert_eq!(
        connection
            .with_authenticated(|_, _, _, _| Ok(()))
            .unwrap_err()
            .code,
        ErrorCode::RuntimeUnavailable
    );
}

#[test]
fn native_office_workspace_request_reuses_embedded_grant_and_actual_project_membership() {
    let (_root, db, binding, first, second) = fixture();
    let secrets = Secrets::default();
    let original = ensure_grant(&db, &binding, None, &secrets).unwrap();
    db.project_set_archive(crate::models::ProjectArchiveInput { project_id: first, is_archived: true }).unwrap();
    let request = workspace_request_with_credentials(&db, &binding, "office-native", &secrets).unwrap();
    assert!(matches!(&request.caller, crate::agent::access::Caller::Connection { grant_id } if grant_id == &original.0));
    assert_eq!(request.scope_grant.project_ids, vec![first, second]);
    assert!(request.scope_grant.workspace_content);
    assert_eq!(request.request_id, "office-native");
    request.authorize(&binding, &Scope::Workspace, "source.read").unwrap();
    request.authorize(&binding, &Scope::Project { project_id: second }, "file.update").unwrap();
    assert!(request.authorize(&binding, &Scope::Project { project_id: second + 100 }, "source.read").is_err());
    db.agent_connection_revoke(&binding, &original.0).unwrap();
    assert!(workspace_request_with_credentials(&db, &binding, "revoked-office", &secrets).is_err());
}

#[test]
fn current_project_and_workspace_grants_add_contacts_without_widening_content_or_rotating_token() {
    for workspace in [false, true] {
        let (_root, db, binding, first, _) = fixture();
        let secrets = Secrets::default();
        let project = if workspace { None } else { Some(first) };
        let id = grant_id(&binding.workspace_id, project);
        let token = "a".repeat(64);
        let mut old = grant_input(project);
        old.write_operations
            .retain(|operation| !CONTACT_OPERATIONS.contains(&operation.as_str()));
        let original = db
            .agent_connection_create(&binding, &old, &id, &token)
            .unwrap();
        secrets.save(&id, &token).unwrap();
        let saved_secrets = secrets.0.borrow().clone();
        assert_eq!(
            ensure_grant(&db, &binding, project, &secrets).unwrap(),
            (id.clone(), token.clone())
        );
        assert_eq!(*secrets.0.borrow(), saved_secrets);
        let upgraded = db
            .agent_connection_embedded_grant(&binding, &id)
            .unwrap()
            .unwrap();
        assert_eq!(upgraded.created_at, original.created_at);
        assert_eq!(upgraded.project_ids, original.project_ids);
        assert_eq!(upgraded.workspace_content, original.workspace_content);
        assert_eq!(upgraded.all_projects, original.all_projects);
        assert!(CONTACT_OPERATIONS
            .iter()
            .all(|operation| upgraded.operations.iter().any(|actual| actual.as_str() == *operation)));
        let request = db
            .agent_connection_authenticate(&binding, &id, &token, "contact-native")
            .unwrap();
        if !workspace {
            assert!(!request.scope_grant.workspace_content);
            assert_eq!(request.scope_grant.project_ids, vec![first]);
            assert!(request
                .authorize(&binding, &Scope::Workspace, "source.read")
                .is_err());
        }
        assert_eq!(
            ensure_grant(&db, &binding, project, &secrets).unwrap(),
            (id, token)
        );
        assert_eq!(db.agent_connection_list(&binding).unwrap().len(), 1);
    }
}

#[test]
fn contact_reads_and_writes_follow_actual_execution_mode() {
    let control = EmbeddedCliControl::default();
    for mode in ["read-only", "workspace-write", "danger-full-access"] {
        let opened = control.open(mode).unwrap();
        let token = opened["token"].as_str().unwrap();
        for method in ["contact.list", "contact.search", "contact.get"] {
            assert!(control.authorize(token, method).is_ok(), "{mode} {method}");
        }
        for method in ["contact.create", "contact.update"] {
            assert_eq!(
                control.authorize(token, method).is_ok(),
                mode != "read-only",
                "{mode} {method}"
            );
        }
        control.close(opened["leaseId"].as_str().unwrap()).unwrap();
    }
}

#[test]
fn contacts_upgrade_rejects_malformed_native_grants_without_changing_credentials_or_storage() {
    for change in [
        "partial-contact",
        "missing-write",
        "extra-operation",
        "duplicate-operation",
        "label",
        "object-scope",
        "foreign-workspace",
        "unknown-scope-field",
        "wrong-token",
        "missing-token",
        "revoked",
    ] {
        let (root, db, binding, first, _) = fixture();
        let secrets = Secrets::default();
        let project = Some(first);
        let id = grant_id(&binding.workspace_id, project);
        let token = "a".repeat(64);
        let mut old = grant_input(project);
        old.write_operations
            .retain(|operation| !CONTACT_OPERATIONS.contains(&operation.as_str()));
        match change {
            "partial-contact" => old.write_operations.push("contact.read".into()),
            "missing-write" => {
                old.write_operations.pop();
            }
            "label" => old.client_label = "User changed connection".into(),
            _ => {}
        }
        db.agent_connection_create(&binding, &old, &id, &token)
            .unwrap();
        let connection = rusqlite::Connection::open(root.path().join("app.sqlite")).unwrap();
        match change {
            "extra-operation" => {
                connection.execute("UPDATE agent_connection_grants SET operations_json=json_insert(operations_json,'$[#]','unknown') WHERE id=?1",[&id]).unwrap();
            }
            "duplicate-operation" => {
                connection.execute("UPDATE agent_connection_grants SET operations_json=json_insert(operations_json,'$[#]','source.read') WHERE id=?1",[&id]).unwrap();
            }
            "object-scope" => {
                connection.execute("UPDATE agent_connection_grants SET scope_grant_json=json_set(scope_grant_json,'$.objects',json(?2)) WHERE id=?1",rusqlite::params![id,json!([{"workspaceId":binding.workspace_id,"scope":{"kind":"project","projectId":first},"kind":"record","id":"1"}]).to_string()]).unwrap();
            }
            "foreign-workspace" => {
                connection.execute("UPDATE agent_connection_grants SET scope_grant_json=json_set(scope_grant_json,'$.workspaceId','foreign') WHERE id=?1",[&id]).unwrap();
            }
            "unknown-scope-field" => {
                connection.execute("UPDATE agent_connection_grants SET scope_grant_json=json_set(scope_grant_json,'$.unknown',true) WHERE id=?1",[&id]).unwrap();
            }
            "revoked" => {
                db.agent_connection_revoke(&binding, &id).unwrap();
            }
            _ => {}
        }
        if change != "missing-token" {
            let saved_token=if change=="wrong-token" {"b".repeat(64)} else {token.clone()};
            secrets.save(&id,&saved_token).unwrap();
        }
        let saved_secrets = secrets.0.borrow().clone();
        let snapshot = || {
            connection.query_row("SELECT scope_grant_json,operations_json,client_label,enabled,revoked_at FROM agent_connection_grants WHERE id=?1",[&id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,bool>(3)?,row.get::<_,Option<String>>(4)?))).unwrap()
        };
        let before = snapshot();
        assert!(
            ensure_grant(&db, &binding, project, &secrets).is_err(),
            "{change}"
        );
        assert_eq!(snapshot(), before, "{change}");
        assert_eq!(*secrets.0.borrow(), saved_secrets, "{change}");
    }
}
