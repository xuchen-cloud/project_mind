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
        vec![
            "mind_project_list",
            "mind_context_get",
            "mind_context_overview_get",
            "mind_knowledge_search",
            "mind_knowledge_get",
            "mind_source_search",
            "mind_source_read",
        ]
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

    let workspace_scope = json!({"kind":"workspace"});
    let reads = [
        ("mind_project_list", "project.list", json!({})),
        ("mind_context_get", "context.get", json!({"scope":workspace_scope.clone(),"budgetChars":100})),
        ("mind_context_overview_get", "context.overview.get", json!({"scope":workspace_scope.clone(),"budgetChars":100})),
        ("mind_knowledge_search", "knowledge.search", json!({"scope":workspace_scope.clone(),"query":"plan","budgetChars":100})),
        ("mind_knowledge_get", "knowledge.get", json!({"scope":workspace_scope.clone(),"nodeId":"node-1","budgetChars":100})),
        ("mind_source_search", "source.search", json!({"scope":workspace_scope.clone(),"query":"plan","budgetChars":100})),
        ("mind_source_read", "source.read", json!({"source":{"object":{"workspaceId":"test","scope":workspace_scope,"kind":"record","id":"1"}},"view":"full","budgetChars":100})),
    ];
    for (name, method, arguments) in reads {
        let called = client.peer().call_tool(
            CallToolRequestParams::new(name).with_arguments(arguments.as_object().unwrap().clone())
        ).await.unwrap();
        assert_eq!(called.is_error, Some(false), "{name}");
        assert_eq!(called.structured_content.as_ref().unwrap()["data"]["method"], method);
    }

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
    let over_budget = client.peer().call_tool(
        CallToolRequestParams::new("mind_source_search").with_arguments(
            json!({"scope":{"kind":"workspace"},"query":"plan","budgetChars":12001})
                .as_object().unwrap().clone(),
        ),
    ).await.unwrap();
    assert_eq!(over_budget.is_error, Some(true));
    assert_eq!(over_budget.structured_content.as_ref().unwrap()["error"]["code"], "INVALID_ARGUMENT");
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
