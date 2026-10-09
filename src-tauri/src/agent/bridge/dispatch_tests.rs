//! Full local socket -> bridge -> persistent grant -> native database read path.
//! The handler below supplies only the current Workspace container used by AppBridge.
use std::{path::PathBuf, sync::{Arc, Mutex}};

use serde_json::{json, Value};
use rmcp::{model::CallToolRequestParams, serve_client_with_lifecycle, ClientLifecycleMode, ServiceExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{
    client::BridgeClient,
    credentials,
    dispatch,
    mcp::MindMcp,
    protocol::{CallInput, ConnectInput},
    transport::{self, BridgeHandler},
};
use crate::{
    agent::{
        access::{Caller, RequestContext, ScopeGrant},
        connections::ConnectionCreateInput,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
    },
    db::Database,
    models::{ProjectArchiveInput, ProjectCreateInput, ProjectUpdateInput},
    source_service::SourcePolicyUpdate,
};

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

struct WorkspaceHandler {
    db: Mutex<Database>,
    binding: Mutex<WorkspaceBinding>,
    path: PathBuf,
}

impl BridgeHandler for WorkspaceHandler {
    fn connect(&self, token: &str, input: ConnectInput) -> AgentResult<WorkspaceBinding> {
        if self.path != std::path::Path::new(&input.workspace_path) {
            return Err(AgentError::new(ErrorCode::WorkspaceChanged, "Workspace path changed"));
        }
        let binding = self.binding.lock().unwrap().clone();
        self.db.lock().unwrap().agent_connection_authenticate(
            &binding, &input.grant_id, token, &input.request_id,
        )?;
        Ok(binding)
    }

    fn call(&self, token: &str, input: CallInput) -> AgentResult<Value> {
        let binding = self.binding.lock().unwrap();
        let db = self.db.lock().unwrap();
        dispatch::execute(&db, &binding, "Test Workspace", token, input)
    }
}

async fn post(port: u16, endpoint: &str, body: Value) -> Value {
    let body = body.to_string();
    let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let request = format!(
        "POST {endpoint} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len(),
    );
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    socket.read_to_end(&mut response).await.unwrap();
    let response = String::from_utf8(response).unwrap();
    let (headers, body) = response.split_once("\r\n\r\n").unwrap();
    assert!(headers.starts_with("HTTP/1.1 200") || headers.starts_with("HTTP/1.1 409"));
    serde_json::from_str(body).unwrap()
}

fn call(instance: &str, grant: &str, binding: &WorkspaceBinding, request_id: &str, method: &str, params: Value) -> Value {
    json!({
        "instanceId": instance, "grantId": grant, "requestId": request_id,
        "binding": binding, "method": method, "params": params,
    })
}

fn context(project_id: i64) -> Value {
    json!({"scope": Scope::Project { project_id }, "query": null, "budgetChars": null})
}

fn expect_error(response: &Value, code: &str) {
    assert_eq!(response["ok"], false, "{response}");
    assert_eq!(response["error"]["code"], code, "{response}");
}

#[tokio::test]
async fn real_socket_uses_native_projects_and_live_grant_checks() {
    let root = tempfile::tempdir().unwrap();
    let workspace_path = root.path().canonicalize().unwrap();
    let mut db = Database::open(&root.path().join("app.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace("workspace-a").unwrap();
    let included = db.project_create(ProjectCreateInput {
        name: "Initial Project".into(), summary: Some("Initial context".into()), status: None,
    }).unwrap();
    let other = db.project_create(ProjectCreateInput {
        name: "Other Project".into(), summary: None, status: None,
    }).unwrap();
    let binding = WorkspaceBinding { workspace_id: "workspace-a".into(), generation: "open-1".into() };
    let grant = db.agent_connection_create(
        &binding,
        &ConnectionCreateInput {
            client_label: "External Test".into(), workspace_content: false,
            project_ids: vec![included.id], session_read: false,
        },
        "0123456789abcdef0123456789abcdef", TOKEN,
    ).unwrap();
    let handler = Arc::new(WorkspaceHandler {
        db: Mutex::new(db), binding: Mutex::new(binding.clone()), path: workspace_path.clone(),
    });
    let bridge = transport::start(handler.clone(), root.path().join("agent-bridge.json")).await.unwrap();
    let instance = &bridge.discovery.instance_id;
    let port = bridge.discovery.port;

    let response = post(port, "/v1/connect", json!({
        "instanceId": instance, "grantId": grant.id, "requestId": "connect-1",
        "workspacePath": workspace_path,
    })).await;
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["data"], serde_json::to_value(&binding).unwrap());

    let response = post(port, "/v1/call", call(instance, &grant.id, &binding, "list-1", "project.list", json!({}))).await;
    assert_eq!(response["data"], json!([{"id": included.id, "name": "Initial Project"}]));
    let response = post(port, "/v1/call", call(instance, &grant.id, &binding, "context-1", "context.get", context(included.id))).await;
    assert_eq!(response["data"]["identity"]["name"], "Initial Project");

    // A native GUI write commits on the same Database while the connection remains open.
    handler.db.lock().unwrap().project_update(ProjectUpdateInput {
        project_id: included.id, name: Some("Updated Project".into()),
        summary: "Updated context".into(), summary_markdown: None, summary_html: None,
        summary_code_language: None, status: None,
    }).unwrap();
    let response = post(port, "/v1/call", call(instance, &grant.id, &binding, "list-2", "project.list", json!({}))).await;
    assert_eq!(response["data"], json!([{"id": included.id, "name": "Updated Project"}]));
    let response = post(port, "/v1/call", call(instance, &grant.id, &binding, "context-2", "context.get", context(included.id))).await;
    assert_eq!(response["data"]["identity"]["name"], "Updated Project");

    let response = post(port, "/v1/call", call(instance, &grant.id, &binding, "other", "context.get", context(other.id))).await;
    expect_error(&response, "SCOPE_DENIED");
    let response = post(port, "/v1/call", call(instance, &grant.id, &binding, "workspace", "context.get", json!({"scope": {"kind": "workspace"}, "query": null, "budgetChars": null}))).await;
    expect_error(&response, "SCOPE_DENIED");
    let response = post(port, "/v1/call", call(instance, &grant.id, &binding, "unsupported", "run.start", json!({}))).await;
    expect_error(&response, "TOOL_CALL_UNSUPPORTED");

    handler.db.lock().unwrap().project_set_archive(ProjectArchiveInput { project_id: included.id, is_archived: true }).unwrap();
    let response = post(port, "/v1/call", call(instance, &grant.id, &binding, "archived", "context.get", context(included.id))).await;
    expect_error(&response, "SCOPE_DENIED");
    handler.db.lock().unwrap().project_set_archive(ProjectArchiveInput { project_id: included.id, is_archived: false }).unwrap();

    let object = ObjectRef {
        workspace_id: binding.workspace_id.clone(), scope: Scope::Project { project_id: included.id },
        kind: ObjectKind::Project, id: included.id.to_string(),
    };
    let gui = RequestContext {
        binding: binding.clone(),
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(), workspace_content: false,
            project_ids: vec![included.id],
            operations: vec!["settings.write".into(), "source.read".into(), "session.read".into()],
        },
        caller: Caller::Gui,
        request_id: "gui-exclude-project".into(),
    };
    handler.db.lock().unwrap().source_policy_update(
        &gui, &binding, &SourcePolicyUpdate { object, expected_revision: 0, excluded: true },
    ).unwrap();
    let response = post(port, "/v1/call", call(instance, &grant.id, &binding, "excluded", "context.get", context(included.id))).await;
    expect_error(&response, "SCOPE_DENIED");

    handler.db.lock().unwrap().agent_connection_revoke(&binding, &grant.id).unwrap();
    let response = post(port, "/v1/call", call(instance, &grant.id, &binding, "revoked", "project.list", json!({}))).await;
    expect_error(&response, "SCOPE_DENIED");

    handler.binding.lock().unwrap().generation = "open-2".into();
    let response = post(port, "/v1/call", call(instance, &grant.id, &binding, "stale-binding", "project.list", json!({}))).await;
    expect_error(&response, "WORKSPACE_CHANGED");
    bridge.stop().await.unwrap();
}

struct CredentialCleanup(String);

impl Drop for CredentialCleanup {
    fn drop(&mut self) {
        let _ = credentials::delete(&self.0);
    }
}

#[tokio::test]
#[ignore = "requires isolated unlocked OS Secret Service"]
async fn real_keyring_client_roundtrip() {
    let root = tempfile::tempdir().unwrap();
    let workspace_path = root.path().canonicalize().unwrap();
    let discovery_path = root.path().join("agent-bridge.json");
    let grant_id = format!("{:032x}", rand::random::<u128>());
    let token = format!("{:032x}{:032x}", rand::random::<u128>(), rand::random::<u128>());
    let _cleanup = CredentialCleanup(grant_id.clone());

    let mut db = Database::open(&root.path().join("app.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace("keyring-workspace").unwrap();
    let project = db.project_create(ProjectCreateInput {
        name: "Keyring Project".into(), summary: None, status: None,
    }).unwrap();
    let project_id = project.id;
    let binding = WorkspaceBinding { workspace_id: "keyring-workspace".into(), generation: "open-1".into() };
    db.agent_connection_create(
        &binding,
        &ConnectionCreateInput {
            client_label: "Keyring Client".into(), workspace_content: false,
            project_ids: vec![project_id], session_read: false,
        },
        &grant_id, &token,
    ).unwrap();
    credentials::save(&grant_id, &token).unwrap();
    assert!(credentials::load(&grant_id).unwrap() == token);

    let handler = Arc::new(WorkspaceHandler {
        db: Mutex::new(db), binding: Mutex::new(binding.clone()), path: workspace_path.clone(),
    });
    let bridge = transport::start(handler.clone(), discovery_path.clone()).await.unwrap();
    let client_path = discovery_path.clone();
    let client_grant = grant_id.clone();
    let client_workspace = workspace_path.clone();
    let (client, connected, listed, context) = tokio::task::spawn_blocking(move || {
        let client = BridgeClient::from_discovery(&client_path, &client_grant)?;
        let connected = client.connect(&client_grant, &client_workspace, "keyring-connect")?;
        let listed = client.call(&client_grant, &connected, "project.list", json!({}), "keyring-list")?;
        let context = client.call(&client_grant, &connected, "context.get", context(project_id), "keyring-context")?;
        Ok::<_, AgentError>((client, connected, listed, context))
    }).await.unwrap().unwrap();
    assert_eq!(connected, binding);
    assert_eq!(listed, json!([{"id": project_id, "name": "Keyring Project"}]));
    assert_eq!(context["identity"]["name"], "Keyring Project");

    let mcp = MindMcp::bound(client, connected.clone(), grant_id.clone());
    let (server_io, client_io) = tokio::io::duplex(64 * 1024);
    let (server, mcp_client) = tokio::join!(
        mcp.serve(server_io),
        serve_client_with_lifecycle((), client_io, ClientLifecycleMode::Initialize)
    );
    let mut server = server.unwrap();
    let mcp_client = mcp_client.unwrap();
    let tools = mcp_client.peer().list_tools(None).await.unwrap();
    assert_eq!(tools.tools.len(), 2);
    let mcp_list = mcp_client.peer().call_tool(CallToolRequestParams::new("mind_project_list")).await.unwrap();
    assert_eq!(mcp_list.is_error, Some(false));
    assert_eq!(mcp_list.structured_content.as_ref().unwrap()["data"], listed);

    handler.db.lock().unwrap().agent_connection_revoke(&binding, &grant_id).unwrap();
    let mcp_rejected = mcp_client.peer().call_tool(CallToolRequestParams::new("mind_project_list")).await.unwrap();
    assert_eq!(mcp_rejected.is_error, Some(true));
    assert_eq!(mcp_rejected.structured_content.as_ref().unwrap()["error"]["code"], "SCOPE_DENIED");
    let client_path = discovery_path.clone();
    let client_grant = grant_id.clone();
    let rejected = tokio::task::spawn_blocking(move || {
        let client = BridgeClient::from_discovery(&client_path, &client_grant)?;
        client.call(&client_grant, &connected, "project.list", json!({}), "keyring-revoked")
    }).await.unwrap().unwrap_err();
    assert_eq!(rejected.code, ErrorCode::ScopeDenied);

    server.close().await.unwrap();

    bridge.stop().await.unwrap();
    credentials::delete(&grant_id).unwrap();
    credentials::delete(&grant_id).unwrap();
}
