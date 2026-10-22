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
    for (id, token, scope, outside) in [
        (
            &project_id,
            &project_token,
            Scope::Project { project_id: first },
            Scope::Workspace,
        ),
        (
            &workspace_id,
            &workspace_token,
            Scope::Workspace,
            Scope::Project { project_id: first },
        ),
    ] {
        let request = db
            .agent_connection_authenticate(&binding, id, token, "scope")
            .unwrap();
        request
            .authorize(&binding, &scope, "content.create")
            .unwrap();
        assert!(request
            .authorize(&binding, &outside, "content.create")
            .is_err());
        assert!(request
            .authorize(
                &binding,
                &Scope::Project { project_id: second },
                "context.read"
            )
            .is_err());
        assert_eq!(
            require_external(&request).unwrap_err().code,
            ErrorCode::ScopeDenied
        );
    }
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
