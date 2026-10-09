use super::{
    connection_store::ConnectionStore,
    protocol::{CallInput, ConnectInput},
    registry,
    transport::{BridgeCallFuture, BridgeHandler},
};
use crate::{
    agent::{
        errors::{AgentError, AgentResult, ErrorCode},
        models::WorkspaceBinding,
        tools::BoundReadContextStore,
    },
    lock_mutex,
    record_document_service::DocumentUtility,
    source_service::SourceUtility,
    source_session_read::{SessionHistoryFragment, SessionHistoryUtility},
    AppState,
};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

pub(crate) struct AppBridge(pub tauri::AppHandle);

fn unavailable() -> AgentError {
    AgentError::new(
        ErrorCode::WorkspaceNotOpen,
        "Open the requested Workspace in ProjectMind",
    )
}

pub(crate) async fn execute<S, R, F, H>(
    store: &S,
    enabled: &AtomicBool,
    token: &str,
    input: CallInput,
    record: &R,
    source: &F,
    history: &H,
) -> AgentResult<Value>
where
    S: BoundReadContextStore + crate::record_document_service::BoundRecordStore + Sync,
    R: DocumentUtility,
    F: SourceUtility,
    H: SessionHistoryUtility,
{
    let connection = ConnectionStore {
        inner: store,
        enabled,
        token,
        input: &input,
    };
    if matches!(input.method.as_str(), "project.list" | "context.get") {
        return connection.with_authenticated(|binding, db, workspace_name, request| {
            registry::validate(&input.method, &input.params)?;
            let value = if input.method == "project.list" {
                serde_json::to_value(db.agent_connection_projects(&request, binding)?)
            } else {
                let params: crate::agent::context::ContextGetInput =
                    serde_json::from_value(input.params.clone()).expect("validated context input");
                // L0 includes project identity: check its source policy and read
                // the context under one lock, just like the initial bridge.
                if let crate::agent::models::Scope::Project { project_id } = &params.scope {
                    db.source_read_object(
                        &request,
                        binding,
                        &crate::agent::models::ObjectRef {
                            workspace_id: binding.workspace_id.clone(),
                            scope: params.scope.clone(),
                            kind: crate::agent::models::ObjectKind::Project,
                            id: project_id.to_string(),
                        },
                    )?;
                }
                let repository =
                    crate::db::agent::WorkspaceContextRepository { db, workspace_name };
                serde_json::to_value(
                    crate::agent::service::AgentDomainService::new(binding, &repository)
                        .context_get(&request, params)?,
                )
            };
            value.map_err(|_| {
                AgentError::new(ErrorCode::IoFailed, "Cannot encode connection result")
            })
        });
    }
    let request = connection.with_authenticated(|_, _, _, request| Ok(request))?;
    match input.method.as_str() {
        "record.create" | "record.patch" | "record.restore" | "operation.get"
        | "operation.list" | "operation.undo" | "operation.restore_created" => {
            return super::record_writes::execute(&connection, record, &request, &input.method, input.params.clone()).await;
        }
        "session.search" => {
            let params = decode(input.params.clone())?;
            return encode(
                crate::agent::model_history::search_with_store(
                    &connection,
                    history,
                    &request,
                    &params,
                )
                .await?,
            );
        }
        "session.messages.read" => {
            let params = decode(input.params.clone())?;
            return encode(
                crate::agent::model_history::read_with_store(
                    &connection,
                    history,
                    &request,
                    &params,
                )
                .await?,
            );
        }
        "record.blocks.get"
        | "record.versions.list"
        | "record.versions.get"
        | "record.versions.compare"
        | "todo.get"
        | "file.versions.list"
        | "file.versions.get"
        | "file.source.read" => {
            return super::object_reads::execute(
                &connection,
                &request,
                &input.method,
                input.params.clone(),
                record,
            )
            .await;
        }
        _ => {}
    }
    crate::agent::tools::dispatch_read(
        &connection,
        record,
        source,
        &request,
        &input.method,
        input.params.clone(),
    )
    .await
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> AgentResult<T> {
    serde_json::from_value(value).map_err(|_| {
        AgentError::new(
            ErrorCode::InvalidArgument,
            "Arguments do not match the read input DTO",
        )
    })
}
fn encode(value: impl serde::Serialize) -> AgentResult<Value> {
    serde_json::to_value(value)
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot encode connection result"))
}

/// History resources are opened only for an authorized history request.
struct AppHistoryUtility(tauri::AppHandle);
impl AppHistoryUtility {
    fn reader(
        &self,
        binding: &WorkspaceBinding,
    ) -> AgentResult<crate::agent::model_history::AppSessionHistoryUtility> {
        let state = self.0.state::<AppState>();
        let current = lock_mutex(&state.current_workspace);
        let runtime = current.as_ref().ok_or_else(unavailable)?;
        if &runtime.agent_binding != binding {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Workspace changed; reconnect explicitly",
            ));
        }
        Ok(crate::agent::model_history::AppSessionHistoryUtility {
            app: self.0.clone(),
            runtime: runtime.clone(),
        })
    }
}
impl SessionHistoryUtility for AppHistoryUtility {
    async fn read(
        &self,
        binding: &WorkspaceBinding,
        record: &crate::db::agent_session_model_search::SourceReadRecord,
        cursor: Option<&str>,
        max_chars: u32,
    ) -> AgentResult<SessionHistoryFragment> {
        self.reader(binding)?
            .read(binding, record, cursor, max_chars)
            .await
    }
    async fn scan(
        &self,
        binding: &WorkspaceBinding,
        work: &crate::db::agent_session_search::SessionScanWork,
    ) -> AgentResult<crate::db::agent_session_search::SessionScanPage> {
        self.reader(binding)?.scan(binding, work).await
    }
}

/// Resolve packaged extraction resources only when a File read needs them.
struct AppSourceUtility(tauri::AppHandle);
impl SourceUtility for AppSourceUtility {
    async fn request(
        &self,
        workspace_id: &str,
        request_id: &str,
        format: &str,
        bytes: &[u8],
    ) -> AgentResult<Value> {
        let app = self.0.clone();
        let worker = tokio::task::spawn_blocking(move || {
            crate::source_extraction_worker::SourceExtractionWorker::for_app(&app)
        })
        .await
        .map_err(|_| {
            AgentError::new(
                ErrorCode::RuntimeUnavailable,
                "Cannot prepare source reader",
            )
        })??;
        worker
            .request(workspace_id, request_id, format, bytes)
            .await
    }
}

impl BridgeHandler for AppBridge {
    fn connect(&self, token: &str, input: ConnectInput) -> AgentResult<WorkspaceBinding> {
        let state = self.0.state::<AppState>();
        if !state.external_bridge.enabled.load(Ordering::Acquire) {
            return Err(AgentError::new(
                ErrorCode::RuntimeUnavailable,
                "External connections are disabled",
            ));
        }
        let current = lock_mutex(&state.current_workspace);
        let runtime = current.as_ref().ok_or_else(unavailable)?;
        // Only canonicalize the application's known root. Client paths are compared,
        // never opened by this endpoint.
        let root =
            runtime.paths.root_path.canonicalize().map_err(|_| {
                AgentError::new(ErrorCode::IoFailed, "Workspace path is unavailable")
            })?;
        if root != std::path::Path::new(&input.workspace_path) {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "The requested Workspace is not open",
            ));
        }
        lock_mutex(&runtime.db).agent_connection_authenticate(
            &runtime.agent_binding,
            &input.grant_id,
            token,
            &input.request_id,
        )?;
        Ok(runtime.agent_binding.clone())
    }

    fn call<'a>(&'a self, token: &'a str, input: CallInput) -> BridgeCallFuture<'a> {
        Box::pin(async move {
            let state = self.0.state::<AppState>();
            execute(
                &*state,
                &state.external_bridge.enabled,
                token,
                input,
                &crate::record_document_service::AppDocumentUtility(self.0.clone()),
                &AppSourceUtility(self.0.clone()),
                &AppHistoryUtility(self.0.clone()),
            )
            .await
        })
    }
}
