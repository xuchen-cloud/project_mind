//! Real DSH Session adapter for the same Office/File save kernel.
use super::{Identity, ProjectContext, SessionListValue, SessionRequest, SourceRequest};
use crate::{
    agent::{
        access::RequestContext,
        connections::ConnectionCreateInput,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{SourceRef, WorkspaceBinding},
    },
    committed_changes::{CommittedChangePublisher, CommittedChanges},
    db::Database,
    file_office::{FileOfficeEditInput, FileOfficeInput, FileOfficeService},
    file_version_service::{BoundFileCommitStore, FileCommitHost},
    office_worker::{AppOfficeUtility, OfficePayload, OfficeUtility},
    source_service::BoundSourceStore,
    AppState,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Manager, Url};

pub(super) struct OfficeBridge {
    app: tauri::AppHandle,
    identity: Identity,
    // Native credentials never enter the JS payload or utility environment.
    grants: Mutex<HashMap<String, (String, String)>>,
}
impl OfficeBridge {
    pub(super) fn new(app: tauri::AppHandle, identity: Identity) -> Self {
        Self {
            app,
            identity,
            grants: Mutex::new(HashMap::new()),
        }
    }
    pub(super) fn execute(
        &self,
        operation: SourceRequest,
        revoked: &AtomicBool,
        url: &Url,
        frame_id: &str,
        alive: Arc<AtomicBool>,
    ) -> Result<Value, String> {
        let call = OfficeCall::parse(operation, frame_id).map_err(|e| e.message)?;
        let session_id = call.session_id.clone();
        let store = Store {
            bridge: self,
            revoked,
            url,
            alive,
            session_id: &session_id,
            cookie: Mutex::new(None),
            client: super::session_http_client()?,
        };
        store.session_owned().map_err(|e| e.message)?;
        let result = tokio::runtime::Handle::current()
            .block_on(call.execute(
                &store,
                &SessionUtility {
                    store: &store,
                    worker: AppOfficeUtility(self.app.clone()),
                },
                &self.identity,
                &self.grants,
            ))
            .map_err(|e| e.message)?;
        store.session_owned().map_err(|e| e.message)?;
        Ok(result)
    }
}
impl Drop for OfficeBridge {
    fn drop(&mut self) {
        // Stages stay caller-bound and expire through the existing recovery path.
        let state = self.app.state::<AppState>();
        let _ = state.with_current(|binding, db| {
            if binding.workspace_id == self.identity.workspace_id {
                for (id, _) in crate::lock_mutex(&self.grants).values() {
                    db.agent_connection_revoke(binding, id)?;
                }
            }
            Ok(())
        });
    }
}
struct Store<'a> {
    alive: Arc<AtomicBool>,
    bridge: &'a OfficeBridge,
    revoked: &'a AtomicBool,
    url: &'a Url,
    session_id: &'a str,
    cookie: Mutex<Option<reqwest::header::HeaderValue>>,
    client: reqwest::Client,
}
impl Store<'_> {
    fn session_owned(&self) -> AgentResult<()> {
        tokio::runtime::Handle::current().block_on(self.session_owned_async())
    }
    async fn session_owned_async(&self) -> AgentResult<()> {
        if self.revoked.load(Ordering::SeqCst) || !self.alive.load(Ordering::SeqCst) {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "DSH runtime was revoked",
            ));
        }
        let mut cookie = crate::lock_mutex(&self.cookie).clone();
        let value =
            super::session_request(self.url, &self.client, &mut cookie, SessionRequest::List)
                .await
                .map_err(|m| AgentError::new(ErrorCode::ScopeDenied, m))?;
        *crate::lock_mutex(&self.cookie) = cookie;
        let list: SessionListValue = serde_json::from_value(value).map_err(|_| {
            AgentError::new(
                ErrorCode::RuntimeIncompatible,
                "Invalid DSH Session catalog",
            )
        })?;
        validate_session(
            &list,
            self.session_id,
            self.bridge.identity.directory(),
        )
    }
}
impl BoundSourceStore for Store<'_> {
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        if self.revoked.load(Ordering::SeqCst) || !self.alive.load(Ordering::SeqCst) {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "DSH runtime was revoked",
            ));
        }
        let state = self.bridge.app.state::<AppState>();
        let current = crate::lock_mutex(&state.current_workspace);
        let runtime = current
            .as_ref()
            .ok_or_else(|| AgentError::new(ErrorCode::WorkspaceNotOpen, "DSH Workspace closed"))?;
        if !self
            .bridge
            .identity
            .matches_workspace(&runtime.agent_binding, &runtime.paths.root_path)
            || !runtime.ai_secrets_unlocked()
        {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "DSH Workspace binding expired",
            ));
        }
        let mut db = crate::lock_mutex(&runtime.db);
        let project = self.bridge.identity.project()
            .map_err(|message| AgentError::new(ErrorCode::ScopeDenied, message))?;
        if ProjectContext::resolve(
            &mut db,
            &runtime.paths.root_path,
            project.id,
        )
        .map_err(|m| AgentError::new(ErrorCode::ScopeDenied, m))?
            != *project
        {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "DSH Project binding changed",
            ));
        }
        let result = action(&runtime.agent_binding, &db);
        if self.revoked.load(Ordering::SeqCst) || !self.alive.load(Ordering::SeqCst) {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "DSH runtime was revoked",
            ));
        }
        result
    }
}
impl CommittedChangePublisher for Store<'_> {
    fn publish_committed(&self, changes: CommittedChanges) {
        self.bridge
            .app
            .state::<AppState>()
            .publish_committed(changes);
    }
}
impl BoundFileCommitStore for Store<'_> {
    fn gui_commit_host(&self, binding: &WorkspaceBinding) -> AgentResult<FileCommitHost> {
        self.with_current(|current, _| {
            crate::file_version_service::validate_binding(binding, current)
        })?;
        let host = self
            .bridge
            .app
            .state::<AppState>()
            .gui_commit_host(binding)?;
        // The existing fence handles Workspace close/reopen; the connection
        // lease additionally rejects writes after this DSH runtime stops.
        Ok(host.for_connection(self.alive.clone()))
    }
}

/// The native source operation and its fixed File input are shared by the
/// production stdio handler and tests against real Connection grants/storage.
struct OfficeCall {
    session_id: String,
    id: String,
    path: Option<String>,
    fixed: Option<SourceRef>,
    edits: Option<Vec<Value>>,
}
impl OfficeCall {
    fn parse(operation: SourceRequest, frame_id: &str) -> AgentResult<Self> {
        let (session_id, id, path, fixed, edits) = match operation {
            SourceRequest::OfficeInspect {
                session_id,
                path,
                source_ref,
            } => (session_id, frame_id.to_owned(), path, source_ref, None),
            SourceRequest::OfficeEdit {
                session_id,
                request_id,
                source_ref,
                edits,
            } => (session_id, request_id, None, Some(source_ref), Some(edits)),
            _ => {
                return Err(AgentError::new(
                    ErrorCode::InvalidArgument,
                    "Invalid Office operation",
                ))
            }
        };
        if session_id.is_empty()
            || session_id.len() > 512
            || session_id.chars().any(char::is_control)
            || id.is_empty()
            || id.len() > 128
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid Office Session/request identity",
            ));
        }
        Ok(Self {
            session_id,
            id,
            path,
            fixed,
            edits,
        })
    }
    async fn execute<S: BoundSourceStore + BoundFileCommitStore, W: OfficeUtility>(
        self,
        store: &S,
        worker: &W,
        identity: &Identity,
        grants: &Mutex<HashMap<String, (String, String)>>,
    ) -> AgentResult<Value> {
        let project = identity.project()
            .map_err(|message| AgentError::new(ErrorCode::ScopeDenied, message))?;
        let request = store.with_current(|binding, db| {
            let mut grants = crate::lock_mutex(grants);
            let (grant, token) = if let Some(grant) = grants.get(&self.session_id) {
                grant.clone()
            } else {
                let grant = format!("{:032x}", rand::random::<u128>());
                let token = format!(
                    "{:032x}{:032x}",
                    rand::random::<u128>(),
                    rand::random::<u128>()
                );
                db.agent_connection_create(
                    binding,
                    &ConnectionCreateInput {
                        client_label: "DSH Office Session".into(),
                        workspace_content: false,
                        project_ids: vec![project.id],
                        all_projects: false,
                        write_operations: vec!["file.update".into()],
                    },
                    &grant,
                    &token,
                )?;
                grants.insert(self.session_id.clone(), (grant.clone(), token.clone()));
                (grant, token)
            };
            db.agent_connection_authenticate(binding, &grant, &token, &self.id)
        })?;
        let input = store.with_current(|binding, db| {
            super::source_file_input(db, identity, binding, self.path.as_deref(), self.fixed)
                .map(|input| FileOfficeInput {
                    object: input.object,
                    version_number: input.version_number,
                    expected_content_hash: input.expected_content_hash,
                })
                .map_err(|message| AgentError::new(ErrorCode::InvalidArgument, message))
        })?;
        let service = FileOfficeService::new(store, worker);
        let (baseline, model, commit) = if let Some(edits) = self.edits {
            let saved = service
                .save(
                    &request,
                    &FileOfficeEditInput {
                        object: input.object.clone(),
                        version_number: input.version_number,
                        expected_content_hash: input.expected_content_hash,
                        edits,
                    },
                )
                .await?;
            let version = u32::try_from(saved.version_number).map_err(|_| {
                AgentError::new(
                    ErrorCode::RuntimeIncompatible,
                    "Invalid Office saved version",
                )
            })?;
            (
                FileOfficeInput {
                    object: saved.object,
                    version_number: version,
                    expected_content_hash: saved.content_hash,
                },
                saved.model,
                Some(saved.commit),
            )
        } else {
            let inspected = service.inspect(&request, &input).await?;
            (input, inspected.model, None)
        };
        let source = store.with_current(|binding, db| {
            db.project_file_read_office_source(
                &request,
                binding,
                &crate::db::project_directory_files::FileBytesInput {
                    object: baseline.object,
                    version_number: baseline.version_number,
                    expected_content_hash: baseline.expected_content_hash,
                },
            )
            .map(|x| x.1)
        })?;
        let mut value = json!({"sourceRef":source,"model":model});
        if let Some(commit) = commit {
            value["commit"] = json!(commit);
        }
        Ok(value)
    }
}
fn validate_session(
    list: &SessionListValue,
    session_id: &str,
    directory: &std::path::Path,
) -> AgentResult<()> {
    if !list
        .items
        .iter()
        .any(|session| session.id == session_id && session.cwd.as_deref() == directory.to_str())
    {
        return Err(AgentError::new(
            ErrorCode::ScopeDenied,
            "Office Session belongs to another Project",
        ));
    }
    Ok(())
}

struct SessionUtility<'a, 'b> {
    store: &'a Store<'b>,
    worker: AppOfficeUtility,
}
impl OfficeUtility for SessionUtility<'_, '_> {
    async fn request(
        &self,
        id: &str,
        method: &str,
        format: &str,
        base64: &str,
        payload: OfficePayload<'_>,
    ) -> AgentResult<Value> {
        self.store.session_owned_async().await?;
        let wait_revocation = async {
            while self.store.alive.load(Ordering::SeqCst) {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            AgentError::new(ErrorCode::WorkspaceChanged, "DSH runtime was revoked")
        };
        let result = tokio::select! {
            result=self.worker.request(id,method,format,base64,payload)=>result?,
            error=wait_revocation=>return Err(error),
        };
        self.store.session_owned_async().await?;
        Ok(result)
    }
}

#[cfg(test)]
#[path = "dsh_office_tests.rs"]
mod tests;
