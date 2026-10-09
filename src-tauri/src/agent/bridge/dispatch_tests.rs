//! Full local socket -> bridge -> persistent grant -> native database read path.
//! The handler below supplies only the current Workspace container used by AppBridge.
use std::{
    io::Write,
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc, Mutex},
};

use rmcp::{
    model::CallToolRequestParams, serve_client_with_lifecycle, ClientLifecycleMode, ServiceExt,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{
    client::BridgeClient,
    credentials, dispatch,
    mcp::MindMcp,
    protocol::{CallInput, ConnectInput},
    transport::{self, BridgeCallFuture, BridgeHandler},
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
    record_worker: Option<crate::record_document_worker::RecordDocumentWorker>,
    file_paths: Option<crate::workspace::WorkspacePaths>,
    file_fence: Option<Arc<crate::workspace_commit_fence::WorkspaceCommitFence>>,
}

impl BridgeHandler for WorkspaceHandler {
    fn connect(&self, token: &str, input: ConnectInput) -> AgentResult<WorkspaceBinding> {
        if self.path != std::path::Path::new(&input.workspace_path) {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Workspace path changed",
            ));
        }
        let binding = self.binding.lock().unwrap().clone();
        self.db.lock().unwrap().agent_connection_authenticate(
            &binding,
            &input.grant_id,
            token,
            &input.request_id,
        )?;
        Ok(binding)
    }

    fn call<'a>(&'a self, token: &'a str, input: CallInput) -> BridgeCallFuture<'a> {
        Box::pin(async move {
            if let Some(worker) = &self.record_worker {
                dispatch::execute(
                    self, &Arc::new(AtomicBool::new(true)), token, input, worker, &NoUtility, &NoUtility,
                ).await
            } else {
                dispatch::execute(
                    self, &Arc::new(AtomicBool::new(true)), token, input, &NoUtility, &NoUtility, &NoUtility,
                ).await
            }
        })
    }
}

impl crate::committed_changes::CommittedChangePublisher for WorkspaceHandler {
    fn publish_committed(&self, _: crate::committed_changes::CommittedChanges) {}
}
impl crate::agent::tools::BoundReadContextStore for WorkspaceHandler {
    fn with_current_context<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database, &str) -> AgentResult<T>,
    ) -> AgentResult<T> {
        let binding = self.binding.lock().unwrap();
        let db = self.db.lock().unwrap();
        action(&binding, &db, "Test Workspace")
    }
}
impl crate::source_service::BoundSourceStore for WorkspaceHandler {
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        crate::agent::tools::BoundReadContextStore::with_current_context(self, |binding, db, _| {
            action(binding, db)
        })
    }
}
struct NoUtility;
impl crate::record_document_service::DocumentUtility for NoUtility {
    async fn request(&self, _: &str, _: &str, _: Value) -> AgentResult<Value> {
        panic!("This fixture does not extract documents")
    }
}
impl crate::source_service::SourceUtility for NoUtility {
    async fn request(&self, _: &str, _: &str, _: &str, _: &[u8]) -> AgentResult<Value> {
        panic!("This fixture does not extract files")
    }
}

async fn post(port: u16, endpoint: &str, body: Value) -> Value {
    let body = body.to_string();
    let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
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

fn call(
    instance: &str,
    grant: &str,
    binding: &WorkspaceBinding,
    request_id: &str,
    method: &str,
    params: Value,
) -> Value {
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
    let included = db
        .project_create(ProjectCreateInput {
            name: "Initial Project".into(),
            summary: Some("Initial context".into()),
            status: None,
        })
        .unwrap();
    let other = db
        .project_create(ProjectCreateInput {
            name: "Other Project".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let binding = WorkspaceBinding {
        workspace_id: "workspace-a".into(),
        generation: "open-1".into(),
    };
    let grant = db
        .agent_connection_create(
            &binding,
            &ConnectionCreateInput {
                client_label: "External Test".into(),
                workspace_content: false,
                all_projects: false,
                project_ids: vec![included.id],
                session_read: false,
                write_operations: vec![],
            },
            "0123456789abcdef0123456789abcdef",
            TOKEN,
        )
        .unwrap();
    let handler = Arc::new(WorkspaceHandler {
        db: Mutex::new(db),
        binding: Mutex::new(binding.clone()),
        path: workspace_path.clone(),
        record_worker: None,
        file_paths: None,
        file_fence: None,
    });
    let bridge = transport::start(handler.clone(), root.path().join("agent-bridge.json"))
        .await
        .unwrap();
    let instance = &bridge.discovery.instance_id;
    let port = bridge.discovery.port;

    let response = post(
        port,
        "/v1/connect",
        json!({
            "instanceId": instance, "grantId": grant.id, "requestId": "connect-1",
            "workspacePath": workspace_path,
        }),
    )
    .await;
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["data"], serde_json::to_value(&binding).unwrap());

    let response = post(
        port,
        "/v1/call",
        call(
            instance,
            &grant.id,
            &binding,
            "list-1",
            "project.list",
            json!({}),
        ),
    )
    .await;
    assert_eq!(
        response["data"],
        json!([{"id": included.id, "name": "Initial Project"}])
    );
    let response = post(
        port,
        "/v1/call",
        call(
            instance,
            &grant.id,
            &binding,
            "context-1",
            "context.get",
            context(included.id),
        ),
    )
    .await;
    assert_eq!(response["data"]["identity"]["name"], "Initial Project");

    // A native GUI write commits on the same Database while the connection remains open.
    handler
        .db
        .lock()
        .unwrap()
        .project_update(ProjectUpdateInput {
            project_id: included.id,
            name: Some("Updated Project".into()),
            summary: "Updated context".into(),
            summary_markdown: None,
            summary_html: None,
            summary_code_language: None,
            status: None,
        })
        .unwrap();
    let response = post(
        port,
        "/v1/call",
        call(
            instance,
            &grant.id,
            &binding,
            "list-2",
            "project.list",
            json!({}),
        ),
    )
    .await;
    assert_eq!(
        response["data"],
        json!([{"id": included.id, "name": "Updated Project"}])
    );
    let response = post(
        port,
        "/v1/call",
        call(
            instance,
            &grant.id,
            &binding,
            "context-2",
            "context.get",
            context(included.id),
        ),
    )
    .await;
    assert_eq!(response["data"]["identity"]["name"], "Updated Project");

    let response = post(
        port,
        "/v1/call",
        call(
            instance,
            &grant.id,
            &binding,
            "other",
            "context.get",
            context(other.id),
        ),
    )
    .await;
    expect_error(&response, "SCOPE_DENIED");
    let response = post(
        port,
        "/v1/call",
        call(
            instance,
            &grant.id,
            &binding,
            "workspace",
            "context.get",
            json!({"scope": {"kind": "workspace"}, "query": null, "budgetChars": null}),
        ),
    )
    .await;
    expect_error(&response, "SCOPE_DENIED");
    let response = post(
        port,
        "/v1/call",
        call(
            instance,
            &grant.id,
            &binding,
            "unsupported",
            "run.start",
            json!({}),
        ),
    )
    .await;
    expect_error(&response, "TOOL_CALL_UNSUPPORTED");

    handler
        .db
        .lock()
        .unwrap()
        .project_set_archive(ProjectArchiveInput {
            project_id: included.id,
            is_archived: true,
        })
        .unwrap();
    let response = post(
        port,
        "/v1/call",
        call(
            instance,
            &grant.id,
            &binding,
            "archived",
            "context.get",
            context(included.id),
        ),
    )
    .await;
    expect_error(&response, "SCOPE_DENIED");
    handler
        .db
        .lock()
        .unwrap()
        .project_set_archive(ProjectArchiveInput {
            project_id: included.id,
            is_archived: false,
        })
        .unwrap();

    let object = ObjectRef {
        workspace_id: binding.workspace_id.clone(),
        scope: Scope::Project {
            project_id: included.id,
        },
        kind: ObjectKind::Project,
        id: included.id.to_string(),
    };
    let gui = RequestContext {
        binding: binding.clone(),
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: false,
            project_ids: vec![included.id],
            operations: vec![
                "settings.write".into(),
                "source.read".into(),
                "session.read".into(),
            ],
        },
        caller: Caller::Gui,
        request_id: "gui-exclude-project".into(),
    };
    handler
        .db
        .lock()
        .unwrap()
        .source_policy_update(
            &gui,
            &binding,
            &SourcePolicyUpdate {
                object,
                expected_revision: 0,
                excluded: true,
            },
        )
        .unwrap();
    let response = post(
        port,
        "/v1/call",
        call(
            instance,
            &grant.id,
            &binding,
            "excluded",
            "context.get",
            context(included.id),
        ),
    )
    .await;
    expect_error(&response, "SCOPE_DENIED");

    handler
        .db
        .lock()
        .unwrap()
        .agent_connection_revoke(&binding, &grant.id)
        .unwrap();
    let response = post(
        port,
        "/v1/call",
        call(
            instance,
            &grant.id,
            &binding,
            "revoked",
            "project.list",
            json!({}),
        ),
    )
    .await;
    expect_error(&response, "SCOPE_DENIED");

    handler.binding.lock().unwrap().generation = "open-2".into();
    let response = post(
        port,
        "/v1/call",
        call(
            instance,
            &grant.id,
            &binding,
            "stale-binding",
            "project.list",
            json!({}),
        ),
    )
    .await;
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
#[ignore = "requires isolated unlocked OS Secret Service and PROJECT_MIND_TEST_CLI binary"]
async fn real_keyring_client_roundtrip() {
    let root = tempfile::tempdir().unwrap();
    let workspace_path = root.path().canonicalize().unwrap();
    let discovery_path = root.path().join("agent-bridge.json");
    let grant_id = format!("{:032x}", rand::random::<u128>());
    let token = format!(
        "{:032x}{:032x}",
        rand::random::<u128>(),
        rand::random::<u128>()
    );
    let _cleanup = CredentialCleanup(grant_id.clone());

    let (metadata, paths) = crate::workspace::create_workspace(root.path(), "test-password").unwrap();
    let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
    db.bind_native_workspace(&metadata.workspace_id).unwrap();
    let project = db
        .project_create(ProjectCreateInput {
            name: "Keyring Project".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let project_id = project.id;
    let binding = WorkspaceBinding {
        workspace_id: metadata.workspace_id,
        generation: "open-1".into(),
    };
    db.agent_connection_create(
        &binding,
        &ConnectionCreateInput {
            client_label: "Keyring Client".into(),
            workspace_content: true,
            all_projects: true,
            project_ids: vec![],
            session_read: false,
            write_operations: vec!["content.create".into(), "record.patch".into(), "record.restore".into(), "file.update".into(), "file.restore".into(), "operation.undo".into()],
        },
        &grant_id,
        &token,
    )
    .unwrap();
    credentials::save(&grant_id, &token).unwrap();
    assert!(credentials::load(&grant_id).unwrap() == token);

    let handler = Arc::new(WorkspaceHandler {
        db: Mutex::new(db),
        binding: Mutex::new(binding.clone()),
        path: workspace_path.clone(),
        record_worker: Some(crate::record_document_worker::RecordDocumentWorker::development().unwrap()),
        file_paths: Some(paths),
        file_fence: Some(Arc::new(crate::workspace_commit_fence::WorkspaceCommitFence::new())),
    });
    let bridge = transport::start(handler.clone(), discovery_path.clone())
        .await
        .unwrap();
    let client_path = discovery_path.clone();
    let client_grant = grant_id.clone();
    let client_workspace = workspace_path.clone();
    let (client, connected, listed, context_result) = tokio::task::spawn_blocking(move || {
        let client = BridgeClient::from_discovery(&client_path, &client_grant)?;
        let connected = client.connect(&client_grant, &client_workspace, "keyring-connect")?;
        let listed = client.call(
            &client_grant,
            &connected,
            "project.list",
            json!({}),
            "keyring-list",
        )?;
        let context = client.call(
            &client_grant,
            &connected,
            "context.get",
            context(project_id),
            "keyring-context",
        )?;
        Ok::<_, AgentError>((client, connected, listed, context))
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(connected, binding);
    assert_eq!(
        listed,
        json!([{"id": project_id, "name": "Keyring Project"}])
    );
    assert_eq!(context_result["identity"]["name"], "Keyring Project");

    let mcp = MindMcp::bound(client, connected.clone(), grant_id.clone());
    let (server_io, client_io) = tokio::io::duplex(64 * 1024);
    let (server, mcp_client) = tokio::join!(
        mcp.serve(server_io),
        serve_client_with_lifecycle((), client_io, ClientLifecycleMode::Initialize)
    );
    let mut server = server.unwrap();
    let mcp_client = mcp_client.unwrap();
    let tools = mcp_client.peer().list_tools(None).await.unwrap();
    assert_eq!(tools.tools.len(), super::registry::registered_methods().len());
    let mcp_list = mcp_client
        .peer()
        .call_tool(CallToolRequestParams::new("mind_project_list"))
        .await
        .unwrap();
    assert_eq!(mcp_list.is_error, Some(false));
    assert_eq!(
        mcp_list.structured_content.as_ref().unwrap()["data"],
        listed
    );
    let mcp_context = mcp_client.peer().call_tool(
        CallToolRequestParams::new("mind_context_get")
            .with_arguments(context(project_id).as_object().unwrap().clone())
    ).await.unwrap();
    assert_eq!(mcp_context.is_error, Some(false));
    assert_eq!(mcp_context.structured_content.as_ref().unwrap()["data"]["identity"]["name"], "Keyring Project");

    let create = json!({
        "requestId":"keyring-create",
        "input":{
            "scope":{"kind":"project","projectId":project_id},
            "title":"MCP saved",
            "tagIds":[],
            "document":{"type":"doc","content":[{
                "type":"paragraph",
                "attrs":{"blockId":"33333333333333333333333333333333"},
                "content":[{"type":"text","text":"Saved through MCP"}]
            }]},
            "codeLanguage":null
        }
    });
    let create_tool = || CallToolRequestParams::new("mind_record_create")
        .with_arguments(create.as_object().unwrap().clone());
    let created = mcp_client.peer().call_tool(create_tool()).await.unwrap();
    assert_eq!(created.is_error, Some(false), "{created:?}");
    let created = created.structured_content.unwrap();
    assert_eq!(created["requestId"], "keyring-create");
    let saved = &created["data"];
    assert_eq!(saved["operation"]["requestId"], "keyring-create");
    assert!(saved["operation"]["operationId"].as_str().is_some());
    let record_id = saved["result"]["target"]["recordId"].as_i64().unwrap();
    let retried = mcp_client.peer().call_tool(create_tool()).await.unwrap();
    assert_eq!(retried.is_error, Some(false), "{retried:?}");
    assert_eq!(retried.structured_content.as_ref().unwrap()["data"], *saved);
    {
        let mut db = handler.db.lock().unwrap();
        let page = db.project_page_get(crate::models::ProjectIdInput { project_id }).unwrap();
        assert_eq!(page.records.len(), 1);
        assert_eq!(page.records[0].id, record_id);
        assert_eq!(page.records[0].title.as_deref(), Some("MCP saved"));
    }

    let file_create = json!({"requestId":"keyring-file-create","input":{
        "projectId":project_id,"safeName":"wire-content.txt","utf8Content":"original"
    }});
    let created_file = mcp_client.peer().call_tool(
        CallToolRequestParams::new("mind_file_create")
            .with_arguments(file_create.as_object().unwrap().clone())
    ).await.unwrap();
    assert_eq!(created_file.is_error, Some(false), "{created_file:?}");
    let created_file = created_file.structured_content.unwrap()["data"].clone();
    let create_replay = mcp_client.peer().call_tool(
        CallToolRequestParams::new("mind_file_create")
            .with_arguments(file_create.as_object().unwrap().clone())
    ).await.unwrap();
    assert_eq!(create_replay.is_error, Some(false), "{create_replay:?}");
    assert_eq!(create_replay.structured_content.unwrap()["data"], created_file);
    let file = created_file["result"]["object"].clone();
    let file_id = file["id"].as_str().unwrap().parse::<i64>().unwrap();
    let file_versions = mcp_client.peer().call_tool(
        CallToolRequestParams::new("mind_file_versions_list")
            .with_arguments(json!({"object":file}).as_object().unwrap().clone())
    ).await.unwrap();
    assert_eq!(file_versions.is_error, Some(false), "{file_versions:?}");
    let baseline = file_versions.structured_content.unwrap()["data"].clone();
    let bytes: Vec<u8> = (0..1024 * 1024).map(|index| (index % 251) as u8).collect();
    let content_hash = format!("sha256:{:x}", Sha256::digest(&bytes));
    let begin = json!({"requestId":"keyring-file-begin","input":{
        "object":file,"expectedVersionNumber":baseline["currentVersionNumber"],
        "expectedContentHash":baseline["currentContentHash"],
        "length":bytes.len(),"contentHash":content_hash,
    }});
    let begun = mcp_client.peer().call_tool(
        CallToolRequestParams::new("mind_file_content_begin")
            .with_arguments(begin.as_object().unwrap().clone())
    ).await.unwrap();
    assert_eq!(begun.is_error, Some(false), "{begun:?}");
    let ticket = begun.structured_content.unwrap()["data"].clone();
    let stage = ticket["stagedContentId"].as_str().unwrap().to_owned();
    assert_eq!(ticket["contentHash"], content_hash);
    let chunk = json!({"requestId":"keyring-file-chunk","input":{
        "stagedContentId":stage,"offset":0,"dataBase64":STANDARD.encode(&bytes),
    }});
    assert!(chunk.to_string().len() > 64 * 1024);
    let appended = mcp_client.peer().call_tool(
        CallToolRequestParams::new("mind_file_content_chunk")
            .with_arguments(chunk.as_object().unwrap().clone())
    ).await.unwrap();
    assert_eq!(appended.is_error, Some(false), "{appended:?}");
    let complete = json!({"requestId":"keyring-file-complete","input":{"stagedContentId":stage}});
    let completed = mcp_client.peer().call_tool(
        CallToolRequestParams::new("mind_file_content_complete")
            .with_arguments(complete.as_object().unwrap().clone())
    ).await.unwrap();
    assert_eq!(completed.is_error, Some(false), "{completed:?}");
    assert_eq!(completed.structured_content.as_ref().unwrap()["data"]["ready"], true);
    let update = json!({"requestId":"keyring-file-update","input":{
        "object":file,"expectedVersionNumber":baseline["currentVersionNumber"],
        "expectedContentHash":baseline["currentContentHash"],"stagedContentId":stage,
    }});
    let update_tool = || CallToolRequestParams::new("mind_file_update")
        .with_arguments(update.as_object().unwrap().clone());
    let updated = mcp_client.peer().call_tool(update_tool()).await.unwrap();
    assert_eq!(updated.is_error, Some(false), "{updated:?}");
    let updated = updated.structured_content.unwrap()["data"].clone();
    assert_eq!(updated["result"]["receipt"]["contentHash"], content_hash);
    let replay = mcp_client.peer().call_tool(update_tool()).await.unwrap();
    assert_eq!(replay.is_error, Some(false), "{replay:?}");
    assert_eq!(replay.structured_content.unwrap()["data"], updated);
    let receipt: crate::db::file_versions::CommittedVersion =
        serde_json::from_value(updated["result"]["receipt"].clone()).unwrap();
    assert_eq!(receipt.document_id, file_id);
    let committed_path = handler.db.lock().unwrap().file_version_committed_path(&receipt).unwrap().unwrap();
    assert_eq!(std::fs::read(committed_path).unwrap(), bytes);
    let current = mcp_client.peer().call_tool(
        CallToolRequestParams::new("mind_file_versions_list")
            .with_arguments(json!({"object":file}).as_object().unwrap().clone())
    ).await.unwrap();
    assert_eq!(current.is_error, Some(false), "{current:?}");
    assert_eq!(current.structured_content.unwrap()["data"]["currentContentHash"], content_hash);

    // The production executable discovers this live bridge from its own
    // isolated app-data directory; it reads the body file itself.
    let cli_binary = PathBuf::from(std::env::var_os("PROJECT_MIND_TEST_CLI")
        .expect("PROJECT_MIND_TEST_CLI must point to the built mind executable"));
    let cli_data_home = root.path().join("client-data");
    let cli_app_data = cli_data_home.join(crate::APP_IDENTIFIER);
    std::fs::create_dir_all(&cli_app_data).unwrap();
    std::fs::copy(&discovery_path, cli_app_data.join("agent-bridge.json")).unwrap();
    let record_target = crate::record_documents::RecordTarget {
        scope: crate::agent::models::Scope::Project { project_id }, record_id,
    };
    let before_preview = handler.db.lock().unwrap().record_document_head(&record_target).unwrap().unwrap();
    let block = &before_preview.projection.document["content"][0];
    let preview_params = json!({
        "record":{"workspaceId":binding.workspace_id,"scope":record_target.scope,"kind":"record","id":record_id.to_string()},
        "baseRevision":before_preview.head_revision,
        "operations":[{"op":"append_inline","blockId":block["attrs"]["blockId"],
            "expectedBlockHash":crate::record_documents::record_block_hash(block).unwrap(),"text":" preview"}]
    });
    let previewed = mcp_client.peer().call_tool(
        CallToolRequestParams::new("mind_record_patch_preview")
            .with_arguments(preview_params.as_object().unwrap().clone())
    ).await.unwrap();
    assert_eq!(previewed.is_error, Some(false), "{previewed:?}");
    assert_eq!(previewed.structured_content.as_ref().unwrap()["data"]["previewText"], "Saved through MCP preview");
    let patch_path = root.path().join("cli-record-patch.json");
    // A preview needs no mutation identity, including through the real CLI.
    std::fs::write(&patch_path, serde_json::to_vec(&preview_params).unwrap()).unwrap();
    let binary = cli_binary.clone();
    let data_home = cli_data_home.clone();
    let workspace = workspace_path.clone();
    let connection = grant_id.clone();
    let preview_output = tokio::task::spawn_blocking(move || {
        std::process::Command::new(binary)
            .args(["record", "patch", "--patch-file"]).arg(patch_path)
            .args(["--dry-run", "--budget-chars", "5", "--workspace"]).arg(workspace)
            .arg("--connection").arg(connection).arg("--json")
            .env("XDG_DATA_HOME", data_home).output()
    }).await.unwrap().unwrap();
    assert!(preview_output.status.success(), "{}", String::from_utf8_lossy(&preview_output.stderr));
    assert!(preview_output.stderr.is_empty());
    let preview_response: Value = serde_json::from_slice(&preview_output.stdout).unwrap();
    assert_eq!(preview_response["data"]["previewText"], "Saved");
    assert_eq!(preview_response["data"]["previewTruncated"], true);
    let after_preview = handler.db.lock().unwrap().record_document_head(&record_target).unwrap().unwrap();
    assert_eq!(after_preview.head_revision, before_preview.head_revision);
    assert_eq!(after_preview.projection.body_hash, before_preview.projection.body_hash);

    let mut patch_params = preview_params.clone();
    patch_params["requestId"] = json!("keyring-record-for-restore");
    let patched = mcp_client.peer().call_tool(
        CallToolRequestParams::new("mind_record_patch")
            .with_arguments(patch_params.as_object().unwrap().clone())
    ).await.unwrap();
    assert_eq!(patched.is_error, Some(false), "{patched:?}");
    assert_eq!(patched.structured_content.as_ref().unwrap()["data"]["result"]["afterRevision"], 2);
    let original_version = handler.db.lock().unwrap()
        .record_versions_list(&record_target, None, 10).unwrap().versions
        .into_iter().find(|version| version.version_number == 1).unwrap().id;
    let mut first_restore = None;
    for _ in 0..2 {
        let binary = cli_binary.clone();
        let data_home = cli_data_home.clone();
        let workspace = workspace_path.clone();
        let connection = grant_id.clone();
        let version_id = original_version.clone();
        let output = tokio::task::spawn_blocking(move || {
            std::process::Command::new(binary)
                .args(["record", "restore", "--id"])
                .arg(record_id.to_string())
                .arg("--version").arg(version_id)
                .args(["--base-revision", "2", "--project"])
                .arg(project_id.to_string())
                .args(["--request-id", "keyring-cli-record-restore", "--workspace"])
                .arg(workspace)
                .arg("--connection").arg(connection)
                .arg("--json")
                .env("XDG_DATA_HOME", data_home)
                .output()
        }).await.unwrap().unwrap();
        assert!(output.status.success(), "CLI Record restore: {:?}, stdout: {}, stderr: {}",
            output.status.code(), String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        assert!(output.stderr.is_empty());
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(response["ok"], true, "{response}");
        if let Some(first) = &first_restore { assert_eq!(&response["data"], first); }
        else { first_restore = Some(response["data"].clone()); }
    }
    let restored_record = handler.db.lock().unwrap().record_document_head(&record_target).unwrap().unwrap();
    assert_eq!(restored_record.head_revision, 3);
    assert_eq!(restored_record.projection.text, before_preview.projection.text);
    assert_eq!(handler.db.lock().unwrap().record_versions_list(&record_target, None, 10).unwrap().versions.len(), 3);

    let mut cli_bytes = bytes.clone();
    cli_bytes.extend_from_slice(&[0xf1, 0x00, 0x7f]);
    let cli_hash = format!("sha256:{:x}", Sha256::digest(&cli_bytes));
    let target_path = root.path().join("cli-upload-target.json");
    let body_path = root.path().join("cli-upload-body.bin");
    std::fs::write(&target_path, serde_json::to_vec(&json!({
        "object":file,"expectedVersionNumber":2,"expectedContentHash":content_hash,
    })).unwrap()).unwrap();
    std::fs::write(&body_path, &cli_bytes).unwrap();
    let mut first_cli = None;
    for _ in 0..2 {
        let binary = cli_binary.clone();
        let data_home = cli_data_home.clone();
        let target_path = target_path.clone();
        let body_path = body_path.clone();
        let workspace = workspace_path.clone();
        let connection = grant_id.clone();
        let output = tokio::task::spawn_blocking(move || {
            std::process::Command::new(binary)
                .args(["file", "upload", "--input-file"])
                .arg(target_path)
                .arg("--body-file").arg(body_path)
                .args(["--request-id", "keyring-cli-upload", "--workspace"])
                .arg(workspace)
                .arg("--connection").arg(connection)
                .arg("--json")
                .env("XDG_DATA_HOME", data_home)
                .output()
        }).await.unwrap().unwrap();
        assert!(output.status.success(), "CLI status: {:?}, stdout: {}, stderr: {}",
            output.status.code(), String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        assert!(output.stderr.is_empty(), "CLI stderr: {}", String::from_utf8_lossy(&output.stderr));
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(response["ok"], true, "{response}");
        assert_eq!(response["requestId"], "keyring-cli-upload");
        assert_eq!(response["data"]["result"]["receipt"]["versionNumber"], 3);
        assert_eq!(response["data"]["result"]["receipt"]["contentHash"], cli_hash);
        if let Some(first) = &first_cli {
            assert_eq!(&response["data"], first);
        } else {
            first_cli = Some(response["data"].clone());
        }
    }
    let cli_result = first_cli.unwrap();
    let cli_receipt: crate::db::file_versions::CommittedVersion =
        serde_json::from_value(cli_result["result"]["receipt"].clone()).unwrap();
    let cli_committed_path = handler.db.lock().unwrap().file_version_committed_path(&cli_receipt).unwrap().unwrap();
    assert_eq!(std::fs::read(cli_committed_path).unwrap(), cli_bytes);
    let after_cli = mcp_client.peer().call_tool(
        CallToolRequestParams::new("mind_file_versions_list")
            .with_arguments(json!({"object":file}).as_object().unwrap().clone())
    ).await.unwrap();
    assert_eq!(after_cli.is_error, Some(false), "{after_cli:?}");
    let after_cli = after_cli.structured_content.unwrap()["data"].clone();
    assert_eq!(after_cli["currentVersionNumber"], 3);
    assert_eq!(after_cli["currentContentHash"], cli_hash);

    let replacement_bytes: Vec<u8> = b"direct replacement\0\xff\n".to_vec();
    let replacement_hash = format!("sha256:{:x}", Sha256::digest(&replacement_bytes));
    let replacement_path = root.path().join("cli-direct-update.bin");
    std::fs::write(&replacement_path, &replacement_bytes).unwrap();
    let mut first_direct_update = None;
    for _ in 0..2 {
        let binary = cli_binary.clone();
        let data_home = cli_data_home.clone();
        let source_path = replacement_path.clone();
        let workspace = workspace_path.clone();
        let connection = grant_id.clone();
        let expected_hash = cli_hash.clone();
        let output = tokio::task::spawn_blocking(move || {
            std::process::Command::new(binary)
                .args(["file", "update", "--id"])
                .arg(file_id.to_string())
                .arg("--source-file").arg(source_path)
                .arg("--project").arg(project_id.to_string())
                .args(["--expected-version", "3", "--expected-hash"])
                .arg(expected_hash)
                .args(["--request-id", "keyring-cli-direct-update", "--workspace"])
                .arg(workspace)
                .arg("--connection").arg(connection)
                .arg("--json")
                .env("XDG_DATA_HOME", data_home)
                .output()
        }).await.unwrap().unwrap();
        assert!(output.status.success(), "CLI File update: {:?}, stdout: {}, stderr: {}",
            output.status.code(), String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        assert!(output.stderr.is_empty());
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(response["ok"], true, "{response}");
        assert_eq!(response["data"]["result"]["receipt"]["versionNumber"], 4);
        assert_eq!(response["data"]["result"]["receipt"]["contentHash"], replacement_hash);
        if let Some(first) = &first_direct_update { assert_eq!(&response["data"], first); }
        else { first_direct_update = Some(response["data"].clone()); }
    }
    let direct_receipt: crate::db::file_versions::CommittedVersion = serde_json::from_value(
        first_direct_update.unwrap()["result"]["receipt"].clone()).unwrap();
    let direct_path = handler.db.lock().unwrap().file_version_committed_path(&direct_receipt).unwrap().unwrap();
    assert_eq!(std::fs::read(direct_path).unwrap(), replacement_bytes);
    let binary = cli_binary.clone();
    let data_home = cli_data_home.clone();
    let workspace = workspace_path.clone();
    let connection = grant_id.clone();
    let expected_hash = cli_hash.clone();
    let stale_output = tokio::task::spawn_blocking(move || {
        std::process::Command::new(binary)
            .args(["file", "update", "--id"])
            .arg(file_id.to_string())
            .arg("--source-file").arg(replacement_path)
            .arg("--project").arg(project_id.to_string())
            .args(["--expected-version", "3", "--expected-hash"])
            .arg(expected_hash)
            .args(["--request-id", "keyring-cli-stale-update", "--workspace"])
            .arg(workspace)
            .arg("--connection").arg(connection)
            .arg("--json")
            .env("XDG_DATA_HOME", data_home)
            .output()
    }).await.unwrap().unwrap();
    assert_eq!(stale_output.status.code(), Some(5));
    let stale_response: Value = serde_json::from_slice(&stale_output.stdout).unwrap();
    assert_eq!(stale_response["error"]["code"], "REVISION_CONFLICT");
    let head_after_stale = mcp_client.peer().call_tool(
        CallToolRequestParams::new("mind_file_versions_list")
            .with_arguments(json!({"object":file}).as_object().unwrap().clone())
    ).await.unwrap();
    assert_eq!(head_after_stale.structured_content.as_ref().unwrap()["data"]["currentVersionNumber"], 4);

    let cli_file_body = "CLI 本地文件\n$(printf unsafe) `literal`\n";
    let cli_file_body_path = root.path().join("cli-create-body.txt");
    std::fs::write(&cli_file_body_path, cli_file_body.as_bytes()).unwrap();
    let mut first_created_file = None;
    for _ in 0..2 {
        let binary = cli_binary.clone();
        let data_home = cli_data_home.clone();
        let body_path = cli_file_body_path.clone();
        let workspace = workspace_path.clone();
        let connection = grant_id.clone();
        let output = tokio::task::spawn_blocking(move || {
            std::process::Command::new(binary)
                .args(["file", "create", "--name", "cli-created.md", "--body-file"])
                .arg(body_path)
                .arg("--project").arg(project_id.to_string())
                .args(["--request-id", "keyring-cli-file-create", "--workspace"])
                .arg(workspace)
                .arg("--connection").arg(connection)
                .arg("--json")
                .env("XDG_DATA_HOME", data_home)
                .output()
        }).await.unwrap().unwrap();
        assert!(output.status.success(), "CLI File create: {:?}, stdout: {}, stderr: {}",
            output.status.code(), String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        assert!(output.stderr.is_empty());
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(response["ok"], true, "{response}");
        assert_eq!(response["requestId"], "keyring-cli-file-create");
        assert_eq!(response["data"]["operation"]["requestId"], "keyring-cli-file-create");
        if let Some(first) = &first_created_file {
            assert_eq!(&response["data"], first);
        } else {
            first_created_file = Some(response["data"].clone());
        }
    }
    let cli_created_file = first_created_file.unwrap();
    let cli_created_file_id = cli_created_file["result"]["object"]["id"].as_str().unwrap().parse().unwrap();
    let cli_created_receipt = crate::db::file_versions::CommittedVersion {
        document_id: cli_created_file_id,
        version_number: cli_created_file["result"]["versionNumber"].as_i64().unwrap(),
        content_hash: cli_created_file["result"]["contentHash"].as_str().unwrap().to_owned(),
        no_change: false,
    };
    let cli_created_path = handler.db.lock().unwrap().file_version_committed_path(&cli_created_receipt).unwrap().unwrap();
    assert_eq!(std::fs::read(cli_created_path).unwrap(), cli_file_body.as_bytes());
    assert_eq!(cli_created_file["result"]["versionNumber"], 1);

    // This Project did not exist when the whole-Workspace grant was created.
    let later_project = handler.db.lock().unwrap().project_create(ProjectCreateInput {
        name: "Later Project".into(), summary: None, status: None,
    }).unwrap();
    let listed_later = mcp_client.peer().call_tool(CallToolRequestParams::new("mind_project_list")).await.unwrap();
    assert_eq!(listed_later.is_error, Some(false));
    assert!(listed_later.structured_content.as_ref().unwrap()["data"].as_array().unwrap()
        .iter().any(|project| project["id"] == later_project.id));
    let cli_todo_body = "核对发布\n$(echo literal) `backticks`\n";
    let mut first_created_todo = None;
    for _ in 0..2 {
        let binary = cli_binary.clone();
        let data_home = cli_data_home.clone();
        let workspace = workspace_path.clone();
        let connection = grant_id.clone();
        let body = cli_todo_body.as_bytes().to_vec();
        let output = tokio::task::spawn_blocking(move || {
            let mut child = std::process::Command::new(binary)
                .args(["todo", "create", "--body-file", "-", "--project"])
                .arg(later_project.id.to_string())
                .args(["--request-id", "keyring-cli-todo-create", "--workspace"])
                .arg(workspace)
                .arg("--connection").arg(connection)
                .arg("--json")
                .env("XDG_DATA_HOME", data_home)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()?;
            child.stdin.take().unwrap().write_all(&body)?;
            child.wait_with_output()
        }).await.unwrap().unwrap();
        assert!(output.status.success(), "CLI Todo create: {:?}, stdout: {}, stderr: {}",
            output.status.code(), String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        assert!(output.stderr.is_empty());
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(response["ok"], true, "{response}");
        assert_eq!(response["requestId"], "keyring-cli-todo-create");
        assert_eq!(response["data"]["operation"]["requestId"], "keyring-cli-todo-create");
        if let Some(first) = &first_created_todo {
            assert_eq!(&response["data"], first);
        } else {
            first_created_todo = Some(response["data"].clone());
        }
    }
    let cli_created_todo = first_created_todo.unwrap();
    let todo_object: ObjectRef = serde_json::from_value(cli_created_todo["result"]["object"].clone()).unwrap();
    let todo_snapshot = {
        let db = handler.db.lock().unwrap();
        let request = db.agent_connection_authenticate(&binding, &grant_id, &token, "keyring-cli-todo-check").unwrap();
        db.agent_todo_get(&request, &binding, &todo_object).unwrap()
    };
    let todo_value = serde_json::to_value(todo_snapshot).unwrap();
    assert_eq!(todo_value["snapshot"]["content"], cli_todo_body);
    assert_eq!(todo_value["snapshot"]["priority"], "not_urgent_not_important");
    assert_eq!(todo_value["snapshot"]["dueDate"], Value::Null);

    let cli_markdown = format!("# 发布记录\n\n- 第一项\n- 第二项\n\n{}",
        "- 附注中文用于分页。\n".repeat(20));
    let cli_markdown_path = root.path().join("cli-record-create.md");
    std::fs::write(&cli_markdown_path, cli_markdown.as_bytes()).unwrap();
    let records_before_create = handler.db.lock().unwrap()
        .project_page_get(crate::models::ProjectIdInput { project_id }).unwrap().records.len();
    let binary = cli_binary.clone();
    let data_home = cli_data_home.clone();
    let body_path = cli_markdown_path.clone();
    let workspace = workspace_path.clone();
    let connection = grant_id.clone();
    let preview_output = tokio::task::spawn_blocking(move || {
        std::process::Command::new(binary)
            .args(["record", "create", "--title", "CLI Markdown", "--body-file"])
            .arg(body_path)
            .arg("--project").arg(project_id.to_string())
            .args(["--dry-run", "--workspace"])
            .arg(workspace)
            .arg("--connection").arg(connection)
            .arg("--json")
            .env("XDG_DATA_HOME", data_home)
            .output()
    }).await.unwrap().unwrap();
    assert!(preview_output.status.success(), "CLI Record preview: {:?}, stdout: {}, stderr: {}",
        preview_output.status.code(), String::from_utf8_lossy(&preview_output.stdout), String::from_utf8_lossy(&preview_output.stderr));
    assert!(preview_output.stderr.is_empty());
    let preview_response: Value = serde_json::from_slice(&preview_output.stdout).unwrap();
    assert_eq!(preview_response["ok"], true, "{preview_response}");
    assert_eq!(preview_response["data"]["normalizedTitle"], "CLI Markdown");
    assert_eq!(preview_response["data"]["previewTruncated"], false);
    let preview_text = preview_response["data"]["previewText"].as_str().unwrap().to_owned();
    assert!(preview_text.contains("发布记录") && preview_text.contains("第一项") && preview_text.contains("第二项"));
    assert_eq!(handler.db.lock().unwrap()
        .project_page_get(crate::models::ProjectIdInput { project_id }).unwrap().records.len(), records_before_create);

    let mut first_markdown_create = None;
    for _ in 0..2 {
        let binary = cli_binary.clone();
        let data_home = cli_data_home.clone();
        let body_path = cli_markdown_path.clone();
        let workspace = workspace_path.clone();
        let connection = grant_id.clone();
        let output = tokio::task::spawn_blocking(move || {
            std::process::Command::new(binary)
                .args(["record", "create", "--title", "CLI Markdown", "--body-file"])
                .arg(body_path)
                .arg("--project").arg(project_id.to_string())
                .args(["--request-id", "keyring-cli-record-create", "--workspace"])
                .arg(workspace)
                .arg("--connection").arg(connection)
                .arg("--json")
                .env("XDG_DATA_HOME", data_home)
                .output()
        }).await.unwrap().unwrap();
        assert!(output.status.success(), "CLI Record create: {:?}, stdout: {}, stderr: {}",
            output.status.code(), String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        assert!(output.stderr.is_empty());
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(response["ok"], true, "{response}");
        assert_eq!(response["requestId"], "keyring-cli-record-create");
        assert_eq!(response["data"]["operation"]["requestId"], "keyring-cli-record-create");
        if let Some(first) = &first_markdown_create { assert_eq!(&response["data"], first); }
        else { first_markdown_create = Some(response["data"].clone()); }
    }
    let markdown_created = first_markdown_create.unwrap();
    let markdown_target = crate::record_documents::RecordTarget {
        scope: crate::agent::models::Scope::Project { project_id },
        record_id: markdown_created["result"]["target"]["recordId"].as_i64().unwrap(),
    };
    let saved_markdown = handler.db.lock().unwrap().record_document_head(&markdown_target).unwrap().unwrap();
    assert_eq!(saved_markdown.head_revision, 1);
    assert_eq!(saved_markdown.projection.text, preview_text);
    assert_eq!(handler.db.lock().unwrap()
        .project_page_get(crate::models::ProjectIdInput { project_id }).unwrap().records.len(), records_before_create + 1);

    let mut cursor: Option<String> = None;
    let mut source_revision: Option<String> = None;
    let mut cli_read_text = String::new();
    let mut seen_cursors = std::collections::HashSet::new();
    let mut read_pages = 0;
    loop {
        let binary = cli_binary.clone();
        let data_home = cli_data_home.clone();
        let workspace = workspace_path.clone();
        let connection = grant_id.clone();
        let revision = source_revision.clone();
        let next = cursor.clone();
        let record_id = markdown_target.record_id;
        let output = tokio::task::spawn_blocking(move || {
            let mut command = std::process::Command::new(binary);
            command.args(["record", "get"])
                .arg(record_id.to_string())
                .arg("--project").arg(project_id.to_string())
                .args(["--budget-chars", "1000", "--workspace"])
                .arg(workspace)
                .arg("--connection").arg(connection)
                .arg("--json")
                .env("XDG_DATA_HOME", data_home);
            if let Some(cursor) = next { command.arg("--cursor").arg(cursor); }
            if let Some(revision) = revision { command.arg("--revision").arg(revision); }
            command.output()
        }).await.unwrap().unwrap();
        assert!(output.status.success(), "CLI Record get: {:?}, stdout: {}, stderr: {}",
            output.status.code(), String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        assert!(output.stderr.is_empty());
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(response["ok"], true, "{response}");
        assert_eq!(response["data"]["sourceRef"]["object"]["id"], markdown_target.record_id.to_string());
        let returned_revision = response["data"]["sourceRef"]["revision"].as_str().unwrap().to_owned();
        if let Some(expected) = &source_revision { assert_eq!(&returned_revision, expected); }
        source_revision = Some(returned_revision);
        let page_text = response["data"]["text"].as_str().unwrap();
        let page_chars = page_text.chars().count();
        assert!(page_chars > 0, "CLI Record page {read_pages} made no text progress");
        cli_read_text.push_str(page_text);
        read_pages += 1;
        cursor = response["data"]["nextCursor"].as_str().map(str::to_owned);
        if cursor.is_none() { assert_eq!(response["data"]["complete"], true); break; }
        assert!(seen_cursors.insert(cursor.clone().unwrap()), "CLI Record cursor repeated after {read_pages} pages");
        assert!(read_pages < 100, "CLI Record paging exceeded 100 pages after {} chars; last page had {page_chars} chars", cli_read_text.chars().count());
    }
    assert!(read_pages > 1);
    assert_eq!(cli_read_text, saved_markdown.projection.text);

    std::fs::write(&cli_markdown_path, b"# changed body\n").unwrap();
    let binary = cli_binary.clone();
    let data_home = cli_data_home.clone();
    let workspace = workspace_path.clone();
    let connection = grant_id.clone();
    let conflict_output = tokio::task::spawn_blocking(move || {
        std::process::Command::new(binary)
            .args(["record", "create", "--title", "CLI Markdown", "--body-file"])
            .arg(cli_markdown_path)
            .arg("--project").arg(project_id.to_string())
            .args(["--request-id", "keyring-cli-record-create", "--workspace"])
            .arg(workspace)
            .arg("--connection").arg(connection)
            .arg("--json")
            .env("XDG_DATA_HOME", data_home)
            .output()
    }).await.unwrap().unwrap();
    assert_eq!(conflict_output.status.code(), Some(5));
    let conflict: Value = serde_json::from_slice(&conflict_output.stdout).unwrap();
    assert_eq!(conflict["error"]["code"], "IDEMPOTENCY_CONFLICT");
    assert_eq!(handler.db.lock().unwrap()
        .project_page_get(crate::models::ProjectIdInput { project_id }).unwrap().records.len(), records_before_create + 1);

    let rejected_request = handler.db.lock().unwrap().agent_connection_authenticate(
        &binding, &grant_id, &token, "keyring-after-revoke",
    ).unwrap();

    handler
        .db
        .lock()
        .unwrap()
        .agent_connection_revoke(&binding, &grant_id)
        .unwrap();
    let mcp_rejected = mcp_client
        .peer()
        .call_tool(CallToolRequestParams::new("mind_project_list"))
        .await
        .unwrap();
    assert_eq!(mcp_rejected.is_error, Some(true));
    assert_eq!(
        mcp_rejected.structured_content.as_ref().unwrap()["error"]["code"],
        "SCOPE_DENIED"
    );
    let mut rejected_create = create.clone();
    rejected_create["requestId"] = json!("keyring-after-revoke");
    rejected_create["input"]["title"] = json!("Must not save");
    let rejected_write = mcp_client.peer().call_tool(
        CallToolRequestParams::new("mind_record_create")
            .with_arguments(rejected_create.as_object().unwrap().clone())
    ).await.unwrap();
    assert_eq!(rejected_write.is_error, Some(true));
    assert_eq!(rejected_write.structured_content.as_ref().unwrap()["error"]["code"], "SCOPE_DENIED");
    let rejected_file = mcp_client.peer().call_tool(update_tool()).await.unwrap();
    assert_eq!(rejected_file.is_error, Some(true));
    assert_eq!(rejected_file.structured_content.as_ref().unwrap()["error"]["code"], "SCOPE_DENIED");
    {
        let mut db = handler.db.lock().unwrap();
        let page = db.project_page_get(crate::models::ProjectIdInput { project_id }).unwrap();
        assert_eq!(page.records.len(), records_before_create + 1);
        assert_eq!(
            db.agent_connection_operation_for_request(&rejected_request, &binding)
                .unwrap_err().code,
            ErrorCode::IoFailed,
            "a rejected write must have no committed operation receipt",
        );
    }
    let client_path = discovery_path.clone();
    let client_grant = grant_id.clone();
    let rejected = tokio::task::spawn_blocking(move || {
        let client = BridgeClient::from_discovery(&client_path, &client_grant)?;
        client.call(
            &client_grant,
            &connected,
            "project.list",
            json!({}),
            "keyring-revoked",
        )
    })
    .await
    .unwrap()
    .unwrap_err();
    assert_eq!(rejected.code, ErrorCode::ScopeDenied);

    server.close().await.unwrap();

    bridge.stop().await.unwrap();
    credentials::delete(&grant_id).unwrap();
    credentials::delete(&grant_id).unwrap();
}

impl crate::source_session_read::SessionHistoryUtility for NoUtility {
    async fn read(&self, _: &WorkspaceBinding, _: &crate::db::agent_session_model_search::SourceReadRecord, _: Option<&str>, _: u32) -> AgentResult<crate::source_session_read::SessionHistoryFragment> {
        panic!("This fixture does not read session history")
    }
}

// This headless transport fixture has no registered editors.
impl crate::record_document_service::BoundRecordStore for WorkspaceHandler {
    async fn flush_editors(&self, _: &WorkspaceBinding, _: &crate::record_documents::RecordTarget) -> AgentResult<()> { Ok(()) }
    async fn submission_lock(&self, _: &WorkspaceBinding, _: &crate::record_documents::RecordTarget) -> AgentResult<Option<tokio::sync::OwnedMutexGuard<()>>> { Ok(None) }
    fn with_current<T>(&self, action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>) -> AgentResult<T> {
        crate::source_service::BoundSourceStore::with_current(self, action)
    }
}

impl crate::file_version_service::BoundFileCommitStore for WorkspaceHandler {
    fn gui_commit_host(&self, binding: &WorkspaceBinding) -> AgentResult<crate::file_version_service::FileCommitHost> {
        assert_eq!(*self.binding.lock().unwrap(), *binding);
        Ok(crate::file_version_service::FileCommitHost::for_test(
            binding.clone(), self.file_paths.as_ref().expect("File fixture paths").clone(),
            None, self.file_fence.as_ref().expect("File fixture fence").clone(),
        ))
    }
}
