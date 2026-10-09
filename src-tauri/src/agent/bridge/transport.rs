use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{
        header::{AUTHORIZATION, HOST, ORIGIN},
        HeaderMap, Method, Request, StatusCode,
    },
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};

use super::protocol::{CallInput, ConnectInput, Discovery, ENDPOINT_VERSION};
use crate::agent::{
    errors::{AgentError, AgentResult, ApiResponse, ErrorCode},
    models::WorkspaceBinding,
};

const MAX_BODY_BYTES: usize = 64 * 1024;

pub trait BridgeHandler: Send + Sync + 'static {
    fn connect(&self, token: &str, input: ConnectInput) -> AgentResult<WorkspaceBinding>;
    fn call(&self, token: &str, input: CallInput) -> AgentResult<Value>;
}

struct BridgeState {
    handler: Arc<dyn BridgeHandler>,
    discovery: Discovery,
    accepting: AtomicBool,
}

pub struct RunningBridge {
    pub discovery: Discovery,
    discovery_path: PathBuf,
    state: Arc<BridgeState>,
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<std::io::Result<()>>>,
}

fn io_error(context: &str, error: impl std::fmt::Display) -> AgentError {
    AgentError::new(ErrorCode::IoFailed, format!("{context}: {error}"))
}

fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}

fn json_response<T: serde::Serialize>(
    status: StatusCode,
    request_id: String,
    result: AgentResult<T>,
) -> Response {
    (status, Json(ApiResponse::from_result(request_id, result))).into_response()
}

fn validate_headers(headers: &HeaderMap, expected_port: u16) -> AgentResult<String> {
    if headers.get_all(HOST).iter().count() != 1
        || headers.get(HOST).and_then(|value| value.to_str().ok())
            != Some(format!("127.0.0.1:{expected_port}").as_str())
    {
        return Err(invalid("invalid Host header"));
    }
    if headers.contains_key(ORIGIN) {
        return Err(invalid("Origin is not supported"));
    }
    if headers.get_all(AUTHORIZATION).iter().count() != 1 {
        return Err(invalid("a Bearer authorization header is required"));
    }
    let value = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| invalid("a Bearer authorization header is required"))?;
    let token = value
        .strip_prefix("Bearer ")
        .filter(|token| !token.is_empty() && !token.bytes().any(|byte| byte.is_ascii_whitespace()))
        .ok_or_else(|| invalid("a Bearer authorization header is required"))?;
    Ok(token.to_owned())
}

async fn parse_input<T: DeserializeOwned>(request: Request<Body>) -> AgentResult<T> {
    let body = to_bytes(request.into_body(), MAX_BODY_BYTES)
        .await
        .map_err(|_| invalid("request body exceeds 64 KiB or could not be read"))?;
    serde_json::from_slice(&body).map_err(|_| invalid("invalid request JSON"))
}

async fn connect(State(state): State<Arc<BridgeState>>, request: Request<Body>) -> Response {
    if request.method() != Method::POST {
        return json_response::<WorkspaceBinding>(
            StatusCode::METHOD_NOT_ALLOWED,
            String::new(),
            Err(invalid("method is not supported")),
        );
    }
    let token = match validate_headers(request.headers(), state.discovery.port) {
        Ok(token) => token,
        Err(error) => {
            return json_response::<WorkspaceBinding>(
                StatusCode::BAD_REQUEST,
                String::new(),
                Err(error),
            )
        }
    };
    let input: ConnectInput = match parse_input(request).await {
        Ok(input) => input,
        Err(error) => {
            return json_response::<WorkspaceBinding>(
                StatusCode::BAD_REQUEST,
                String::new(),
                Err(error),
            )
        }
    };
    let request_id = input.request_id.clone();
    if !state.accepting.load(Ordering::Acquire) {
        return json_response::<WorkspaceBinding>(
            StatusCode::SERVICE_UNAVAILABLE,
            request_id,
            Err(AgentError::new(
                ErrorCode::RuntimeUnavailable,
                "bridge is stopping",
            )),
        );
    }
    if input.instance_id != state.discovery.instance_id {
        return json_response::<WorkspaceBinding>(
            StatusCode::CONFLICT,
            request_id,
            Err(AgentError::new(
                ErrorCode::RuntimeIncompatible,
                "bridge instance changed",
            )),
        );
    }
    json_response(
        StatusCode::OK,
        request_id,
        state.handler.connect(&token, input),
    )
}

async fn call(State(state): State<Arc<BridgeState>>, request: Request<Body>) -> Response {
    if request.method() != Method::POST {
        return json_response::<Value>(
            StatusCode::METHOD_NOT_ALLOWED,
            String::new(),
            Err(invalid("method is not supported")),
        );
    }
    let token = match validate_headers(request.headers(), state.discovery.port) {
        Ok(token) => token,
        Err(error) => {
            return json_response::<Value>(StatusCode::BAD_REQUEST, String::new(), Err(error))
        }
    };
    let input: CallInput = match parse_input(request).await {
        Ok(input) => input,
        Err(error) => {
            return json_response::<Value>(StatusCode::BAD_REQUEST, String::new(), Err(error))
        }
    };
    let request_id = input.request_id.clone();
    if !state.accepting.load(Ordering::Acquire) {
        return json_response::<Value>(
            StatusCode::SERVICE_UNAVAILABLE,
            request_id,
            Err(AgentError::new(
                ErrorCode::RuntimeUnavailable,
                "bridge is stopping",
            )),
        );
    }
    if input.instance_id != state.discovery.instance_id {
        return json_response::<Value>(
            StatusCode::CONFLICT,
            request_id,
            Err(AgentError::new(
                ErrorCode::RuntimeIncompatible,
                "bridge instance changed",
            )),
        );
    }
    json_response(
        StatusCode::OK,
        request_id,
        state.handler.call(&token, input),
    )
}

async fn unknown_route() -> Response {
    json_response::<Value>(
        StatusCode::NOT_FOUND,
        String::new(),
        Err(invalid("path is not supported")),
    )
}

fn publish_discovery(path: &Path, discovery: &Discovery) -> AgentResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid("discovery path has no parent"))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| io_error("create discovery directory", error))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| io_error("create discovery file", error))?;
    serde_json::to_writer(temp.as_file_mut(), discovery)
        .map_err(|error| io_error("write discovery file", error))?;
    temp.as_file()
        .sync_all()
        .map_err(|error| io_error("sync discovery file", error))?;
    temp.persist(path)
        .map_err(|error| io_error("publish discovery file", error.error))?;
    Ok(())
}

fn remove_own_discovery(path: &Path, instance_id: &str) -> AgentResult<()> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_error("read discovery file", error)),
    };
    if serde_json::from_slice::<Discovery>(&bytes)
        .ok()
        .is_some_and(|value| value.instance_id == instance_id)
    {
        std::fs::remove_file(path).map_err(|error| io_error("remove discovery file", error))?;
    }
    Ok(())
}

pub async fn start(
    handler: Arc<dyn BridgeHandler>,
    discovery_path: PathBuf,
) -> AgentResult<RunningBridge> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|error| io_error("bind bridge", error))?;
    let port = listener
        .local_addr()
        .map_err(|error| io_error("get bridge port", error))?
        .port();
    let discovery = Discovery {
        instance_id: format!("{:032x}", rand::random::<u128>()),
        port,
        endpoint_version: ENDPOINT_VERSION,
    };
    let state = Arc::new(BridgeState {
        handler,
        discovery: discovery.clone(),
        accepting: AtomicBool::new(true),
    });
    let app = Router::new()
        .route("/v1/connect", any(connect))
        .route("/v1/call", any(call))
        .fallback(unknown_route)
        .with_state(Arc::clone(&state));
    publish_discovery(&discovery_path, &discovery)?;
    let (shutdown, rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
    });
    Ok(RunningBridge {
        discovery,
        discovery_path,
        state,
        shutdown: Some(shutdown),
        task: Some(task),
    })
}

impl RunningBridge {
    pub fn is_running(&self) -> bool {
        self.task.as_ref().is_some_and(|task| !task.is_finished())
    }

    pub async fn stop(mut self) -> AgentResult<()> {
        self.state.accepting.store(false, Ordering::Release);
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(task) = self.task.take() {
            task.await
                .map_err(|error| io_error("join bridge", error))?
                .map_err(|error| io_error("stop bridge", error))?;
        }
        remove_own_discovery(&self.discovery_path, &self.discovery.instance_id)
    }
}

impl Drop for RunningBridge {
    fn drop(&mut self) {
        self.state.accepting.store(false, Ordering::Release);
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
        let _ = remove_own_discovery(&self.discovery_path, &self.discovery.instance_id);
    }
}
