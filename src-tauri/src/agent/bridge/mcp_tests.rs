use super::*;
use rmcp::{serve_client_with_lifecycle, ClientLifecycleMode};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};

#[tokio::test]
async fn sdk_client_negotiates_and_calls_registered_reads() {
    let revoked = Arc::new(AtomicBool::new(false));
    let changed = Arc::new(AtomicBool::new(false));
    let server = MindMcp::with_call(Arc::new({
        let revoked = Arc::clone(&revoked);
        let changed = Arc::clone(&changed);
        move |method, params, _| {
            if changed.load(Ordering::SeqCst) {
                return Err(AgentError::new(
                    ErrorCode::WorkspaceChanged,
                    "Workspace changed",
                ));
            }
            if revoked.load(Ordering::SeqCst) {
                return Err(AgentError::new(
                    ErrorCode::ScopeDenied,
                    "Connection revoked",
                ));
            }
            Ok(json!({"method": method, "params": params}))
        }
    }));
    let (server_io, client_io) = tokio::io::duplex(64 * 1024);
    let (server, client) = tokio::join!(
        server.serve(server_io),
        serve_client_with_lifecycle((), client_io, ClientLifecycleMode::Initialize)
    );
    let mut server = server.unwrap();
    let client = client.unwrap();
    assert_eq!(
        client.peer_info().unwrap().protocol_version,
        ProtocolVersion::V_2025_11_25
    );

    let listed = client.peer().list_tools(None).await.unwrap();
    assert_eq!(
        listed
            .tools
            .iter()
            .map(|tool| tool.name.as_ref())
            .collect::<Vec<_>>(),
        vec!["mind_project_list", "mind_context_get"]
    );
    for tool in &listed.tools {
        assert_eq!(
            tool.annotations.as_ref().unwrap().read_only_hint,
            Some(true)
        );
        let method = method_for_tool(&tool.name).unwrap();
        assert_eq!(
            *tool.input_schema,
            registry::schema(method)
                .unwrap()
                .as_object()
                .unwrap()
                .clone()
        );
    }
    assert!(listed
        .tools
        .iter()
        .all(|tool| tool.name != "mind_run_start"));

    let project = client
        .peer()
        .call_tool(CallToolRequestParams::new("mind_project_list"))
        .await
        .unwrap();
    assert_eq!(project.is_error, Some(false));
    assert_eq!(
        project.structured_content.as_ref().unwrap()["data"]["method"],
        "project.list"
    );
    let context = client
        .peer()
        .call_tool(
            CallToolRequestParams::new("mind_context_get").with_arguments(
                json!({"scope":{"kind":"workspace"}, "budgetChars": 100})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        context.structured_content.as_ref().unwrap()["data"]["method"],
        "context.get"
    );

    let malformed = client
        .peer()
        .call_tool(
            CallToolRequestParams::new("mind_context_get").with_arguments(
                json!({"scope":{"kind":"project","projectId":"forged"}})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await
        .unwrap();
    assert_eq!(malformed.is_error, Some(true));
    assert_eq!(
        malformed.structured_content.as_ref().unwrap()["error"]["code"],
        "INVALID_ARGUMENT"
    );
    assert!(client
        .peer()
        .call_tool(CallToolRequestParams::new("mind_run_start"))
        .await
        .is_err());

    revoked.store(true, Ordering::SeqCst);
    let denied = client
        .peer()
        .call_tool(CallToolRequestParams::new("mind_project_list"))
        .await
        .unwrap();
    assert_eq!(denied.is_error, Some(true));
    assert_eq!(
        denied.structured_content.as_ref().unwrap()["error"]["code"],
        "SCOPE_DENIED"
    );
    changed.store(true, Ordering::SeqCst);
    let stale = client
        .peer()
        .call_tool(CallToolRequestParams::new("mind_project_list"))
        .await
        .unwrap();
    assert_eq!(
        stale.structured_content.as_ref().unwrap()["error"]["code"],
        "WORKSPACE_CHANGED"
    );

    server.close().await.unwrap();
}
