use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{
    protocol::{CallInput, ConnectInput, Discovery},
    transport::{self, BridgeCallFuture, BridgeHandler},
};
use crate::agent::{errors::AgentResult, models::WorkspaceBinding};

#[derive(Default)]
struct FakeHandler {
    calls: Mutex<Vec<(String, String)>>,
}

impl BridgeHandler for FakeHandler {
    fn connect(&self, token: &str, input: ConnectInput) -> AgentResult<WorkspaceBinding> {
        self.calls
            .lock()
            .unwrap()
            .push((token.into(), input.grant_id));
        Ok(WorkspaceBinding {
            workspace_id: "workspace-1".into(),
            generation: "generation-1".into(),
        })
    }

    fn call<'a>(&'a self, token: &'a str, input: CallInput) -> BridgeCallFuture<'a> {
        Box::pin(async move {
            self.calls
                .lock()
                .unwrap()
                .push((token.into(), input.method));
            Ok(json!({"echo": input.params}))
        })
    }
}

async fn request(
    port: u16,
    endpoint: &str,
    host: &str,
    extra_headers: &str,
    body: &str,
) -> (u16, Value) {
    request_method("POST", port, endpoint, host, extra_headers, body).await
}

async fn request_method(
    method: &str,
    port: u16,
    endpoint: &str,
    host: &str,
    extra_headers: &str,
    body: &str,
) -> (u16, Value) {
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    let message = format!(
        "{method} {endpoint} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer secret-1\r\nContent-Type: application/json\r\nConnection: close\r\n{extra_headers}Content-Length: {}\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(message.as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).await.unwrap();
    let response = String::from_utf8(bytes).unwrap();
    let (head, body) = response.split_once("\r\n\r\n").unwrap();
    let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, serde_json::from_str(body).unwrap())
}

fn connect_body(instance_id: &str) -> String {
    json!({"instanceId": instance_id, "grantId": "grant-1", "requestId": "request-1", "workspacePath": "/tmp/workspace"}).to_string()
}

fn call_body(instance_id: &str) -> String {
    json!({"instanceId": instance_id, "grantId": "grant-1", "requestId": "request-2", "binding": {"workspaceId": "workspace-1", "generation": "generation-1"}, "method": "project.list", "params": {"limit": 3}}).to_string()
}

fn path(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().join("agent-bridge.json")
}

#[tokio::test]
async fn real_socket_forwards_only_valid_requests_and_cleans_discovery() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Arc::new(FakeHandler::default());
    let bridge = transport::start(fake.clone(), path(&dir)).await.unwrap();
    let port = bridge.discovery.port;
    let host = format!("127.0.0.1:{port}");
    assert_ne!(port, 0);
    let on_disk: Discovery = serde_json::from_slice(&std::fs::read(path(&dir)).unwrap()).unwrap();
    assert_eq!(on_disk, bridge.discovery);
    let discovery_json: Value =
        serde_json::from_slice(&std::fs::read(path(&dir)).unwrap()).unwrap();
    assert_eq!(discovery_json.as_object().unwrap().len(), 3);

    let (status, response) = request(
        port,
        "/v1/connect",
        &host,
        "",
        &connect_body(&bridge.discovery.instance_id),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        response,
        json!({"apiVersion": 1, "requestId": "request-1", "ok": true, "data": {"workspaceId": "workspace-1", "generation": "generation-1"}})
    );
    let (status, response) = request(
        port,
        "/v1/call",
        &host,
        "",
        &call_body(&bridge.discovery.instance_id),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        response,
        json!({"apiVersion": 1, "requestId": "request-2", "ok": true, "data": {"echo": {"limit": 3}}})
    );
    assert_eq!(
        *fake.calls.lock().unwrap(),
        vec![
            ("secret-1".into(), "grant-1".into()),
            ("secret-1".into(), "project.list".into())
        ]
    );

    bridge.stop().await.unwrap();
    assert!(!path(&dir).exists());
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .is_err());
}

#[tokio::test]
async fn real_socket_rejects_wrong_host_origin_instance_and_large_body() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Arc::new(FakeHandler::default());
    let bridge = transport::start(fake.clone(), path(&dir)).await.unwrap();
    let port = bridge.discovery.port;
    let host = format!("127.0.0.1:{port}");
    let body = connect_body(&bridge.discovery.instance_id);

    for (host_value, extra) in [
        ("localhost:1234", ""),
        (host.as_str(), "Origin: http://localhost\r\n"),
        (host.as_str(), "Authorization: Bearer extra\r\n"),
    ] {
        let (status, response) = request(port, "/v1/connect", host_value, extra, &body).await;
        assert_eq!(status, 400);
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "INVALID_ARGUMENT");
        assert!(!response.to_string().contains("secret-1"));
    }
    let (status, response) = request(
        port,
        "/v1/connect",
        &host,
        "",
        &connect_body("stale-instance"),
    )
    .await;
    assert_eq!(status, 409);
    assert_eq!(response["requestId"], "request-1");
    assert_eq!(response["error"]["code"], "RUNTIME_INCOMPATIBLE");

    let (status, response) = request(port, "/v1/unknown", &host, "", &body).await;
    assert_eq!(status, 404);
    assert_eq!(response["error"]["code"], "INVALID_ARGUMENT");
    let (status, response) = request_method("GET", port, "/v1/connect", &host, "", "").await;
    assert_eq!(status, 405);
    assert_eq!(response["error"]["code"], "INVALID_ARGUMENT");

    let oversized = format!(
        "{}{}",
        body.trim_end_matches('}'),
        format!(",\"padding\":\"{}\"}}", "x".repeat(65536))
    );
    let (status, response) = request(port, "/v1/connect", &host, "", &oversized).await;
    assert_eq!(status, 400);
    assert_eq!(response["error"]["code"], "INVALID_ARGUMENT");
    assert!(fake.calls.lock().unwrap().is_empty());
    bridge.stop().await.unwrap();
}

#[test]
fn bridge_inputs_reject_unknown_fields() {
    let input = json!({"instanceId": "a", "grantId": "b", "requestId": "c", "workspacePath": "/tmp", "token": "wrong-place"});
    assert!(serde_json::from_value::<ConnectInput>(input).is_err());
}
