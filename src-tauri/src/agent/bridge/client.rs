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
use serde_json::Value;
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
        Self::with_token(path, || credentials::load(grant_id))
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
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| unavailable())?;
        Ok(Self {
            http,
            instance_id: discovery.instance_id,
            base_url: format!("http://127.0.0.1:{}", discovery.port),
            token,
        })
    }

    fn post(
        &self,
        route: &str,
        request_id: &str,
        body: &impl serde::Serialize,
    ) -> AgentResult<Value> {
        let response = self
            .http
            .post(format!("{}{route}", self.base_url))
            .bearer_auth(&self.token)
            .json(body)
            .send()
            .map_err(|_| unavailable())?;
        let status = response.status();
        let envelope: Value = response.json().map_err(|_| unavailable())?;
        if envelope.get("apiVersion").and_then(Value::as_u64) != Some(1)
            || envelope.get("requestId").and_then(Value::as_str) != Some(request_id)
        {
            return Err(unavailable());
        }
        match envelope.get("ok").and_then(Value::as_bool) {
            Some(true) if status.is_success() => {
                envelope.get("data").cloned().ok_or_else(unavailable)
            }
            Some(false) => {
                let error = envelope.get("error").cloned().ok_or_else(unavailable)?;
                // Parse only the public error shape. Do not echo a malformed response body.
                serde_json::from_value::<AgentError>(error)
                    .map_err(|_| unavailable())
                    .and_then(Err)
            }
            _ => Err(unavailable()),
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
        let value = self.post("/v1/connect", request_id, &input)?;
        serde_json::from_value(value).map_err(|_| unavailable())
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runtime_credentials_require_a_complete_pair_without_secret_errors() {
        use std::ffi::OsString;
        assert!(runtime_credentials(None, None).unwrap().is_none());
        let path = OsString::from("/tmp/embedded-discovery.json");
        let token = OsString::from("private-execution-token");
        let (actual_path, actual_token) =
            runtime_credentials(Some(path.clone()), Some(token.clone()))
                .unwrap()
                .unwrap();
        assert_eq!(actual_path, PathBuf::from("/tmp/embedded-discovery.json"));
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
