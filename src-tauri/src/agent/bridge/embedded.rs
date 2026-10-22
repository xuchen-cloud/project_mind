//! Native DSH CLI bridge. Persistent native authority never crosses the HTTP boundary.
use super::{
    credentials,
    dispatch::{self, AppHistoryUtility, AppSourceUtility},
    protocol::{CallInput, ConnectInput},
    registry,
    transport::{self, BridgeCallFuture, BridgeHandler, RunningBridge},
};
use crate::{
    agent::{
        connections::{ConnectionCreateInput, ConnectionGrant},
        errors::{AgentError, AgentResult, ErrorCode},
        models::{Scope, WorkspaceBinding},
    },
    db::Database,
    lock_mutex, AppState,
};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::Manager;

const WRITE_OPERATIONS: [&str; 7] = [
    "content.create",
    "record.patch",
    "record.restore",
    "todo.update",
    "file.update",
    "file.restore",
    "operation.undo",
];
const MAX_LEASES: usize = 64;
// Reserve a native-only ID namespace so external transport rejects these grants
// even if another local process has access to the OS credential store.
const INTERNAL_PREFIX: &str = "d5c11ea5";
pub(super) fn is_internal_grant(id: &str) -> bool {
    id.starts_with(INTERNAL_PREFIX)
}
/// Check the complete scope-derived ID, so a random external ID that merely
/// shares the prefix retains its ordinary external semantics.
pub(super) fn require_external(request: &crate::agent::access::RequestContext) -> AgentResult<()> {
    let crate::agent::access::Caller::Connection { grant_id: id } = &request.caller else {
        return Ok(());
    };
    let grant = &request.scope_grant;
    let project = match (grant.workspace_content, grant.project_ids.as_slice()) {
        (true, []) => Some(None),
        (false, [id]) => Some(Some(*id)),
        _ => None,
    };
    if project.is_some_and(|project| *id == grant_id(&request.binding.workspace_id, project)) {
        return Err(denied());
    }
    Ok(())
}
// Serializes credential provisioning across concurrently starting native sessions.
static GRANT_START: Mutex<()> = Mutex::new(());

fn denied() -> AgentError {
    AgentError::new(
        ErrorCode::ScopeDenied,
        "Embedded CLI authority is unavailable or outside its scope",
    )
}
fn unavailable() -> AgentError {
    AgentError::new(
        ErrorCode::RuntimeUnavailable,
        "Embedded CLI runtime is closed",
    )
}
fn secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn grant_id(workspace_id: &str, project_id: Option<i64>) -> String {
    // Length framed Workspace identity, domain separated from other native IDs.
    let scope = project_id.map_or(Scope::Workspace, |project_id| Scope::Project { project_id });
    let mut hash = Sha256::new();
    hash.update(b"project-mind:embedded-cli:v1\0");
    hash.update((workspace_id.len() as u64).to_be_bytes());
    hash.update(workspace_id.as_bytes());
    hash.update(scope.key().as_bytes());
    format!(
        "{INTERNAL_PREFIX}{}",
        &format!("{:x}", hash.finalize())[..24]
    )
}

fn grant_input(project_id: Option<i64>) -> ConnectionCreateInput {
    ConnectionCreateInput {
        client_label: "Built-in DSH Mind CLI".into(),
        workspace_content: project_id.is_none(),
        project_ids: project_id.into_iter().collect(),
        all_projects: false,
        write_operations: WRITE_OPERATIONS.iter().map(|s| (*s).into()).collect(),
    }
}
fn validate_grant(
    grant: &ConnectionGrant,
    binding: &WorkspaceBinding,
    project_id: Option<i64>,
) -> AgentResult<()> {
    let expected = grant_input(project_id);
    let mut operations: Vec<&str> = vec![
        "context.read",
        "source.read",
        "session.read",
        "operation.read",
    ];
    operations.extend(WRITE_OPERATIONS);
    operations.push("operation.restore_created");
    operations.sort_unstable();
    let mut actual: Vec<&str> = grant.operations.iter().map(String::as_str).collect();
    actual.sort_unstable();
    if grant.id != grant_id(&binding.workspace_id, project_id)
        || grant.workspace_id != binding.workspace_id
        || grant.workspace_content != expected.workspace_content
        || grant.project_ids != expected.project_ids
        || grant.all_projects
        || grant.objects.is_some()
        || actual != operations
        || !grant.enabled
        || grant.revoked_at.is_some()
    {
        return Err(denied());
    }
    Ok(())
}

// Credential I/O is injected only here so fixture tests exercise persistent grant
// reuse and revocation through the same provisioning path without OS keyring access.
trait CredentialStore {
    fn load(&self, id: &str) -> AgentResult<String>;
    fn save(&self, id: &str, token: &str) -> AgentResult<()>;
    fn delete(&self, id: &str) -> AgentResult<()>;
}
struct NativeCredentials;
impl CredentialStore for NativeCredentials {
    fn load(&self, id: &str) -> AgentResult<String> {
        credentials::load(id)
    }
    fn save(&self, id: &str, token: &str) -> AgentResult<()> {
        credentials::save(id, token)
    }
    fn delete(&self, id: &str) -> AgentResult<()> {
        credentials::delete(id)
    }
}
fn ensure_grant(
    db: &Database,
    binding: &WorkspaceBinding,
    project_id: Option<i64>,
    secrets: &impl CredentialStore,
) -> AgentResult<(String, String)> {
    let id = grant_id(&binding.workspace_id, project_id);
    let grants = db.agent_connection_list(binding)?;
    if let Some(grant) = grants.iter().find(|grant| grant.id == id) {
        validate_grant(grant, binding, project_id)?;
        let token = secrets.load(&id)?;
        db.agent_connection_authenticate(binding, &id, &token, "embedded-start")?;
        return Ok((id, token));
    }
    // The public list is capped. Fail closed rather than overwriting a credential
    // for an older grant hidden by the cap (including revoked grants).
    if grants.len() >= 1000 {
        return Err(AgentError::new(
            ErrorCode::BudgetExceeded,
            "Cannot resolve embedded connection in capped grant list",
        ));
    }
    let token = secret();
    secrets.save(&id, &token)?;
    if let Err(error) = db.agent_connection_create(binding, &grant_input(project_id), &id, &token) {
        secrets.delete(&id)?;
        return Err(error);
    }
    db.agent_connection_authenticate(binding, &id, &token, "embedded-start")?;
    Ok((id, token))
}

struct Lease {
    token: String,
    read_only: bool,
    enabled: Arc<AtomicBool>,
}
struct Leases {
    alive: bool,
    entries: HashMap<String, Lease>,
}
impl Default for Leases {
    fn default() -> Self {
        Self {
            alive: true,
            entries: HashMap::new(),
        }
    }
}
#[derive(Clone, Default)]
pub(crate) struct EmbeddedCliControl {
    leases: Arc<Mutex<Leases>>,
}
impl EmbeddedCliControl {
    /// Trusted native stdin control only; never expose this through the bridge.
    pub(crate) fn open(&self, mode: &str) -> AgentResult<Value> {
        let read_only = match mode {
            "read-only" => true,
            "workspace-write" | "danger-full-access" => false,
            _ => {
                return Err(AgentError::new(
                    ErrorCode::InvalidArgument,
                    "Unknown CLI execution mode",
                ))
            }
        };
        let mut leases = lock_mutex(&self.leases);
        if !leases.alive {
            return Err(unavailable());
        }
        if leases.entries.len() >= MAX_LEASES {
            return Err(AgentError::new(
                ErrorCode::BudgetExceeded,
                "Too many active CLI executions",
            ));
        }
        let id = format!("{:032x}", rand::random::<u128>());
        let token = secret();
        leases.entries.insert(
            id.clone(),
            Lease {
                token: token.clone(),
                read_only,
                enabled: Arc::new(AtomicBool::new(true)),
            },
        );
        Ok(json!({"leaseId": id, "token": token}))
    }
    pub(crate) fn close(&self, lease_id: &str) -> AgentResult<()> {
        let mut leases = lock_mutex(&self.leases);
        if let Some(lease) = leases.entries.remove(lease_id) {
            lease.enabled.store(false, Ordering::Release);
        }
        Ok(())
    }
    fn authorize(&self, token: &str, method: &str) -> AgentResult<Arc<AtomicBool>> {
        let leases = lock_mutex(&self.leases);
        if !leases.alive {
            return Err(unavailable());
        }
        let lease = leases
            .entries
            .values()
            .find(|lease| token_matches(&lease.token, token))
            .ok_or_else(denied)?;
        if !lease.enabled.load(Ordering::Acquire) {
            return Err(unavailable());
        }
        if method != "connect" {
            match registry::is_read_only(method) {
                Some(true) => {}
                Some(false) if !lease.read_only => {}
                Some(false) => return Err(denied()),
                None => {
                    return Err(AgentError::new(
                        ErrorCode::ToolCallUnsupported,
                        "Method is not registered",
                    ))
                }
            }
        }
        Ok(lease.enabled.clone())
    }
    pub(crate) fn revoke(&self) {
        let mut leases = lock_mutex(&self.leases);
        leases.alive = false;
        for (_, lease) in leases.entries.drain() {
            lease.enabled.store(false, Ordering::Release);
        }
    }
}
fn token_matches(expected: &str, actual: &str) -> bool {
    let mut mismatch = expected.len() ^ actual.len();
    for (index, byte) in expected.bytes().enumerate() {
        mismatch |= usize::from(byte ^ actual.as_bytes().get(index).copied().unwrap_or(0));
    }
    mismatch == 0
}

struct EmbeddedHandler {
    app: tauri::AppHandle,
    binding: WorkspaceBinding,
    workspace: PathBuf,
    grant_id: String,
    native_token: String,
    control: EmbeddedCliControl,
}
impl EmbeddedHandler {
    fn with_current<T>(&self, action: impl FnOnce(&Database) -> AgentResult<T>) -> AgentResult<T> {
        let state = self.app.state::<AppState>();
        let current = lock_mutex(&state.current_workspace);
        let runtime = current.as_ref().ok_or_else(unavailable)?;
        let root =
            runtime.paths.root_path.canonicalize().map_err(|_| {
                AgentError::new(ErrorCode::IoFailed, "Workspace path is unavailable")
            })?;
        if runtime.agent_binding != self.binding || root != self.workspace {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Embedded CLI Workspace changed",
            ));
        }
        let db = lock_mutex(&runtime.db);
        action(&db)
    }
}
impl BridgeHandler for EmbeddedHandler {
    fn connect(&self, token: &str, input: ConnectInput) -> AgentResult<WorkspaceBinding> {
        let enabled = self.control.authorize(token, "connect")?;
        if input.grant_id != self.grant_id || Path::new(&input.workspace_path) != self.workspace {
            return Err(denied());
        }
        self.with_current(|db| {
            if !enabled.load(Ordering::Acquire) {
                return Err(unavailable());
            }
            db.agent_connection_authenticate(
                &self.binding,
                &self.grant_id,
                &self.native_token,
                &input.request_id,
            )?;
            Ok(self.binding.clone())
        })
    }
    fn call<'a>(&'a self, token: &'a str, input: CallInput) -> BridgeCallFuture<'a> {
        Box::pin(async move {
            let enabled = self.control.authorize(token, &input.method)?;
            if input.grant_id != self.grant_id || input.binding != self.binding {
                return Err(denied());
            }
            self.with_current(|_| Ok(()))?;
            let state = self.app.state::<AppState>();
            dispatch::execute(
                &*state,
                &enabled,
                &self.native_token,
                input,
                &crate::record_document_service::AppDocumentUtility(self.app.clone()),
                &AppSourceUtility(self.app.clone()),
                &AppHistoryUtility(self.app.clone()),
            )
            .await
        })
    }
}

pub(crate) struct EmbeddedCli {
    running: Option<RunningBridge>,
    control: EmbeddedCliControl,
    config: Value,
}
impl EmbeddedCli {
    pub(crate) async fn start(
        app: &tauri::AppHandle,
        binding: &WorkspaceBinding,
        workspace: &Path,
        project_id: Option<i64>,
        discovery_path: PathBuf,
    ) -> AgentResult<Self> {
        project_id
            .map_or(Scope::Workspace, |project_id| Scope::Project { project_id })
            .validate()?;
        let workspace = workspace
            .canonicalize()
            .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Workspace path is unavailable"))?;
        if !discovery_path.is_absolute() {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Embedded discovery path must be absolute",
            ));
        }
        let control = EmbeddedCliControl::default();
        let app = app.clone();
        let binding = binding.clone();
        let prepared_control = control.clone();
        let prepared_workspace = workspace.clone();
        let handler = tauri::async_runtime::spawn_blocking(move || {
            let _provisioning = lock_mutex(&GRANT_START);
            let mut handler = EmbeddedHandler {
                app,
                binding,
                workspace: prepared_workspace,
                grant_id: String::new(),
                native_token: String::new(),
                control: prepared_control,
            };
            let (id, token) = handler.with_current(|db| {
                ensure_grant(db, &handler.binding, project_id, &NativeCredentials)
            })?;
            handler.grant_id = id;
            handler.native_token = token;
            Ok::<_, AgentError>(handler)
        })
        .await
        .map_err(|_| unavailable())??;
        let config = json!({"workspace": workspace, "connection": handler.grant_id, "discovery": discovery_path});
        let running = transport::start(Arc::new(handler), discovery_path).await?;
        Ok(Self {
            running: Some(running),
            control,
            config,
        })
    }
    pub(crate) fn config(&self) -> Value {
        self.config.clone()
    }
    pub(crate) fn control(&self) -> EmbeddedCliControl {
        self.control.clone()
    }
    /// Terminal revocation of this runtime. Existing in-flight storage phases
    /// observe each lease flag through ConnectionStore and FileCommitHost.
    pub(crate) fn revoke(&self) {
        self.control.revoke();
    }
}
impl Drop for EmbeddedCli {
    fn drop(&mut self) {
        self.revoke();
        // Transport drops after all lease flags have been disabled.
        drop(self.running.take());
    }
}

#[cfg(test)]
#[path = "embedded_tests.rs"]
mod tests;
