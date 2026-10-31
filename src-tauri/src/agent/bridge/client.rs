//! CLI transport for the currently running desktop application's local bridge.
use super::{
    local_data_dir,
    protocol::{CallInput, ConnectInput, Discovery, DISCOVERY_FILE},
};
use crate::agent::{
    bridge::credentials,
    errors::{AgentError, AgentResult, ErrorCode},
    models::WorkspaceBinding,
};
use reqwest::{blocking::Client, redirect::Policy};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

fn unavailable() -> AgentError {
    AgentError::new(
        ErrorCode::RuntimeUnavailable,
        "Project Mind is not running or its local bridge is unavailable",
    )
}

/// An incomplete runtime environment must fail closed, never fall back to a
/// persistent external credential. Values are never included in errors.
fn runtime_credentials(
    path: Option<std::ffi::OsString>,
    token: Option<std::ffi::OsString>,
) -> AgentResult<Option<(PathBuf, String)>> {
    match (path, token) {
        (None, None) => Ok(None),
        (Some(path), Some(token)) => {
            let path = PathBuf::from(path);
            let token = token.into_string().map_err(|_| unavailable())?;
            if !path.is_absolute()
                || token.is_empty()
                || token.bytes().any(|b| b.is_ascii_whitespace())
            {
                return Err(unavailable());
            }
            Ok(Some((path, token)))
        }
        _ => Err(unavailable()),
    }
}

pub struct BridgeClient {
    http: Client,
    instance_id: String,
    base_url: String,
    token: String,
    call_timeout: Duration,
    connect_timeout: Duration,
}

impl BridgeClient {
    pub fn discover(grant_id: &str) -> AgentResult<Self> {
        match runtime_credentials(
            std::env::var_os("PROJECT_MIND_CLI_DISCOVERY"),
            std::env::var_os("PROJECT_MIND_CLI_TOKEN"),
        )? {
            Some((path, token)) => Self::with_token(&path, || Ok(token)),
            None => {
                let data_dir = local_data_dir().map_err(|_| unavailable())?;
                Self::from_discovery(&data_dir.join(DISCOVERY_FILE), grant_id)
            }
        }
    }

    pub(crate) fn from_discovery(path: &Path, grant_id: &str) -> AgentResult<Self> {
        Self::from_discovery_with_store(path, grant_id, &credentials::FileCredentialStore::local()?)
    }

    pub(super) fn from_discovery_with_store(
        path: &Path,
        grant_id: &str,
        store: &credentials::FileCredentialStore,
    ) -> AgentResult<Self> {
        Self::with_token(path, || store.load(grant_id))
    }

    fn with_token(path: &Path, token: impl FnOnce() -> AgentResult<String>) -> AgentResult<Self> {
        let contents = fs::read(path).map_err(|_| unavailable())?;
        let discovery: Discovery = serde_json::from_slice(&contents).map_err(|_| unavailable())?;
        if discovery.endpoint_version != 1
            || discovery.port == 0
            || discovery.instance_id.is_empty()
        {
            return Err(unavailable());
        }
        let token = token()?;
        let http = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(180))
            .build()
            .map_err(|_| unavailable())?;
        Ok(Self {
            http,
            instance_id: discovery.instance_id,
            base_url: format!("http://127.0.0.1:{}", discovery.port),
            token,
            call_timeout: Duration::from_secs(180),
            connect_timeout: Duration::from_secs(10),
        })
    }

    /// The CLI deadline covers queueing and extraction, each of which may take 60s.
    /// Connection establishment and the binding handshake remain short and bounded.
    pub fn with_timeout(mut self, timeout: Duration) -> AgentResult<Self> {
        if timeout.is_zero() || timeout > Duration::from_secs(3600) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Bridge request timeout must be greater than zero and at most 3600 seconds",
            ));
        }
        self.call_timeout = timeout;
        Ok(self)
    }

    fn request_timeout(&self, route: &str) -> Duration {
        if route == "/v1/connect" {
            self.connect_timeout.min(self.call_timeout)
        } else {
            self.call_timeout
        }
    }

    fn failure(
        &self,
        request_id: &str,
        method: &str,
        kind: &str,
        code: ErrorCode,
        message: &str,
        write_state_unknown: bool,
    ) -> AgentError {
        AgentError::new(code, message).with_details(json!({
            "requestId": request_id, "method": method, "transportKind": kind,
            "writeStateUnknown": write_state_unknown
        }))
    }

    fn post(
        &self,
        route: &str,
        request_id: &str,
        method: &str,
        body: &impl serde::Serialize,
    ) -> AgentResult<Value> {
        let write = method_may_write(method);
        let protocol = || {
            self.failure(
                request_id,
                method,
                "protocol",
                ErrorCode::RuntimeIncompatible,
                "Local Bridge returned an invalid protocol response",
                write,
            )
        };
        let response = self.http
            .post(format!("{}{route}", self.base_url))
            .timeout(self.request_timeout(route))
            .bearer_auth(&self.token)
            .json(body)
            .send()
            .map_err(|error| {
                if error.is_timeout() {
                    self.failure(request_id, method, "timeout", ErrorCode::TimedOut,
                        "Local Bridge request exceeded its deadline; the application may still be processing it", write && !error.is_connect())
                } else if error.is_connect() {
                    let refused = connection_refused(&error);
                    self.failure(request_id, method, if refused { "refused" } else { "connect" },
                        ErrorCode::RuntimeUnavailable,
                        if refused { "Local Bridge refused the connection; check that Project Mind is running" }
                        else { "Could not connect to the local Bridge" }, false)
                } else {
                    self.failure(request_id, method, "transport", ErrorCode::RuntimeUnavailable,
                        "Local Bridge connection was interrupted", write)
                }
            })?;
        let status = response.status();
        let bytes = response.bytes().map_err(|error| {
            if error.is_timeout() {
                self.failure(request_id, method, "timeout", ErrorCode::TimedOut,
                    "Local Bridge response exceeded its deadline; the application may still be processing it", write)
            } else {
                self.failure(request_id, method, "transport", ErrorCode::RuntimeUnavailable,
                    "Local Bridge response was interrupted", write)
            }
        })?;
        let envelope: Value = serde_json::from_slice(&bytes).map_err(|_| protocol())?;
        if envelope.get("apiVersion").and_then(Value::as_u64) != Some(1)
            || envelope.get("requestId").and_then(Value::as_str) != Some(request_id)
        {
            return Err(protocol());
        }
        match envelope.get("ok").and_then(Value::as_bool) {
            Some(true) if status.is_success() => envelope.get("data").cloned().ok_or_else(protocol),
            Some(false) => {
                let error = envelope.get("error").cloned().ok_or_else(protocol)?;
                serde_json::from_value::<AgentError>(error)
                    .map_err(|_| protocol())
                    .and_then(Err)
            }
            _ => Err(protocol()),
        }
    }

    pub fn connect(
        &self,
        grant_id: &str,
        workspace: &Path,
        request_id: &str,
    ) -> AgentResult<WorkspaceBinding> {
        let canonical = workspace.canonicalize().map_err(|_| {
            AgentError::new(ErrorCode::WorkspaceNotOpen, "Workspace path is unavailable")
        })?;
        let input = ConnectInput {
            instance_id: self.instance_id.clone(),
            grant_id: grant_id.to_owned(),
            request_id: request_id.to_owned(),
            workspace_path: canonical.to_string_lossy().into_owned(),
        };
        let value = self.post("/v1/connect", request_id, "connect", &input)?;
        serde_json::from_value(value).map_err(|_| {
            self.failure(
                request_id,
                "connect",
                "protocol",
                ErrorCode::RuntimeIncompatible,
                "Local Bridge returned an invalid workspace binding",
                false,
            )
        })
    }

    pub fn call(
        &self,
        grant_id: &str,
        binding: &WorkspaceBinding,
        method: &str,
        params: Value,
        request_id: &str,
    ) -> AgentResult<Value> {
        self.post(
            "/v1/call",
            request_id,
            method,
            &CallInput {
                instance_id: self.instance_id.clone(),
                grant_id: grant_id.to_owned(),
                request_id: request_id.to_owned(),
                binding: binding.clone(),
                method: method.to_owned(),
                params,
            },
        )
    }
}

fn connection_refused(error: &reqwest::Error) -> bool {
    let mut source = std::error::Error::source(error);
    while let Some(error) = source {
        if error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::ConnectionRefused)
        {
            return true;
        }
        source = error.source();
    }
    false
}

fn method_may_write(method: &str) -> bool {
    // Public read operations never mutate user content. Unknown operations are
    // conservatively treated as writes when their response is lost.
    !matches!(method, "connect" | "capabilities" | "schema" | "doctor")
        && !method.ends_with(".list")
        && !method.ends_with(".get")
        && !method.ends_with(".read")
        && !method.ends_with(".search")
        && !method.ends_with(".preview")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runtime_credentials_require_a_complete_pair_without_secret_errors() {
        use std::ffi::OsString;
        assert!(runtime_credentials(None, None).unwrap().is_none());
        let root = tempfile::tempdir().unwrap();
        let expected_path = root.path().join("embedded-discovery.json");
        let path = expected_path.clone().into_os_string();
        let token = OsString::from("private-execution-token");
        let (actual_path, actual_token) =
            runtime_credentials(Some(path.clone()), Some(token.clone()))
                .unwrap()
                .unwrap();
        assert_eq!(actual_path, expected_path);
        assert_eq!(actual_token, "private-execution-token");
        for (path, token) in [
            (Some(path), None),
            (None, Some(token.clone())),
            (Some(OsString::from("relative")), Some(token)),
        ] {
            let error = runtime_credentials(path, token).unwrap_err();
            assert!(!error.message.contains("private-execution-token"));
        }
    }
    #[test]
    fn runtime_discovery_uses_execution_token_without_keyring() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("discovery.json");
        fs::write(
            &path,
            serde_json::to_vec(&Discovery {
                instance_id: "embedded-fixture".into(),
                port: 1234,
                endpoint_version: 1,
            })
            .unwrap(),
        )
        .unwrap();
        let client = BridgeClient::with_token(&path, || Ok("execution-token".into())).unwrap();
        assert_eq!(client.token, "execution-token");
        assert_eq!(client.instance_id, "embedded-fixture");
        assert_eq!(client.call_timeout, Duration::from_secs(180));
        assert_eq!(client.connect_timeout, Duration::from_secs(10));
    }
    #[test]
    fn missing_discovery_is_connection_error() {
        let error = match BridgeClient::from_discovery(
            Path::new("/no/such/mind-discovery.json"),
            "invalid",
        ) {
            Ok(_) => panic!("unexpected connection"),
            Err(error) => error,
        };
        assert_eq!(error.code, ErrorCode::RuntimeUnavailable);
        assert!(!error.message.contains("/no/such"));
    }
}

#[cfg(test)]
mod transport_tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    fn client(port: u16) -> BridgeClient {
        BridgeClient {
            http: Client::builder()
                .no_proxy()
                .redirect(Policy::none())
                .connect_timeout(Duration::from_millis(100))
                .build()
                .unwrap(),
            instance_id: "test-instance".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            token: "private-test-token".into(),
            call_timeout: Duration::from_millis(200),
            connect_timeout: Duration::from_millis(10),
        }
    }

    fn stalled_server() -> (BridgeClient, TcpListener) {
        // Binding synchronously makes TCP connection establishment available.
        // Keep the listener alive until the request deadline expires, without a
        // server thread, response delay, or competing server-side read timeout.
        // The kernel accepts the connection into its backlog; no HTTP response
        // can arrive and no fixture thread can close the socket first.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = client(listener.local_addr().unwrap().port());
        (client, listener)
    }
    fn server(delay: Duration, body: &'static str) -> (BridgeClient, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = client(listener.local_addr().unwrap().port());
        listener.set_nonblocking(true).unwrap();
        let task = thread::spawn(move || {
            let started = std::time::Instant::now();
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && started.elapsed() < Duration::from_secs(2) =>
                    {
                        thread::sleep(Duration::from_millis(1))
                    }
                    Err(error) => panic!("mock Bridge did not receive request: {error}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = [0; 8192];
            stream.read(&mut bytes).unwrap();
            thread::sleep(delay);
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = stream.write_all(response.as_bytes());
        });
        (client, task)
    }
    #[test]
    fn processing_has_its_own_deadline_and_timeouts_preserve_safe_request_identity() {
        let (client, task) = server(
            Duration::from_millis(30),
            r#"{"apiVersion":1,"requestId":"read-1","ok":true,"data":{"text":"ok"}}"#,
        );
        assert_eq!(
            client
                .post("/v1/call", "read-1", "record.get", &json!({}))
                .unwrap()["text"],
            "ok"
        );
        task.join().unwrap();
        let (client, listener) = stalled_server();
        let client = client.with_timeout(Duration::from_millis(20)).unwrap();
        let error = client
            .post(
                "/v1/call",
                "write-1",
                "record.patch.commit",
                &json!({"secretBody":"do-not-echo"}),
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::TimedOut);
        assert!(!error.retryable);
        let details = error.details.as_ref().unwrap();
        assert_eq!(details["requestId"], "write-1");
        assert_eq!(details["method"], "record.patch.commit");
        assert_eq!(details["transportKind"], "timeout");
        assert_eq!(details["writeStateUnknown"], true);
        let public = serde_json::to_string(&error).unwrap();
        assert!(!public.contains("private-test-token"));
        assert!(!public.contains("do-not-echo"));
        drop(listener);
    }
    #[test]
    fn handshake_uses_short_deadline_and_read_timeout_has_no_uncertain_write() {
        for (route, method) in [("/v1/connect", "connect"), ("/v1/call", "source.read")] {
            let (client, listener) = stalled_server();
            let client = client.with_timeout(Duration::from_millis(20)).unwrap();
            assert_eq!(
                client.request_timeout("/v1/connect"),
                Duration::from_millis(10)
            );
            assert_eq!(
                client.request_timeout("/v1/call"),
                Duration::from_millis(20)
            );
            let error = client.post(route, "req", method, &json!({})).unwrap_err();
            assert_eq!(error.code, ErrorCode::TimedOut);
            assert_eq!(error.details.unwrap()["writeStateUnknown"], false);
            drop(listener);
        }
    }
    #[test]
    fn refused_connection_and_bad_protocol_are_distinct_and_never_echo_bodies() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = client(listener.local_addr().unwrap().port());
        drop(listener);
        let error = client
            .post("/v1/call", "req", "record.patch.commit", &json!({}))
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::RuntimeUnavailable);
        assert_eq!(error.details.as_ref().unwrap()["transportKind"], "refused");
        assert_eq!(error.details.unwrap()["writeStateUnknown"], false);
        for body in [
            "private-invalid-response",
            r#"{"apiVersion":1,"requestId":"wrong","ok":true,"data":{}}"#,
        ] {
            let (client, task) = server(Duration::ZERO, body);
            let error = client
                .post("/v1/call", "req", "record.patch.commit", &json!({}))
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::RuntimeIncompatible);
            assert_eq!(error.details.as_ref().unwrap()["transportKind"], "protocol");
            assert_eq!(error.details.unwrap()["writeStateUnknown"], true);
            assert!(!error.message.contains(body));
            task.join().unwrap();
        }
    }
    #[test]
    fn timeout_configuration_is_bounded() {
        for duration in [Duration::ZERO, Duration::from_secs(3601)] {
            assert_eq!(
                client(1).with_timeout(duration).err().unwrap().code,
                ErrorCode::InvalidArgument
            );
        }
        assert_eq!(
            client(1)
                .with_timeout(Duration::from_secs(180))
                .unwrap()
                .call_timeout,
            Duration::from_secs(180)
        );
    }
}
