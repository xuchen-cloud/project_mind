use super::*;
use rmcp::{serve_client_with_lifecycle, ClientLifecycleMode};
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

#[tokio::test]
async fn sdk_client_negotiates_and_calls_registered_methods() {
    let revoked = Arc::new(AtomicBool::new(false));
    let changed = Arc::new(AtomicBool::new(false));
    let calls = Arc::new(AtomicUsize::new(0));
    let server = MindMcp::with_call(Arc::new({
        let revoked = Arc::clone(&revoked);
        let changed = Arc::clone(&changed);
        let calls = Arc::clone(&calls);
        move |method, params, request_id| {
            calls.fetch_add(1, Ordering::SeqCst);
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
            Ok(json!({"method": method, "params": params, "bridgeRequestId": request_id}))
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
        listed.tools.iter().map(|tool| tool.name.to_string()).collect::<Vec<_>>(),
        registry::registered_methods().iter().map(|entry| format!("mind_{}", entry.method.replace('.', "_"))).collect::<Vec<_>>(),
    );
    for tool in &listed.tools {
        assert_eq!(
            tool.annotations.as_ref().unwrap().read_only_hint,
            registry::is_read_only(method_for_tool(&tool.name).unwrap())
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
    let project_scope = json!({"kind":"project","projectId":1});
    let record = json!({"workspaceId":"test","scope":project_scope,"kind":"record","id":"1"});
    let todo = json!({"workspaceId":"test","scope":project_scope,"kind":"todo","id":"1"});
    let file = json!({"workspaceId":"test","scope":project_scope,"kind":"file","id":"1"});
    let reads = [
        ("mind_project_list", "project.list", json!({})),
        ("mind_context_get", "context.get", json!({"scope":workspace_scope.clone(),"budgetChars":100})),
        ("mind_context_overview_get", "context.overview.get", json!({"scope":workspace_scope.clone(),"budgetChars":100})),
        ("mind_knowledge_search", "knowledge.search", json!({"scope":workspace_scope.clone(),"query":"plan","budgetChars":100})),
        ("mind_knowledge_get", "knowledge.get", json!({"scope":workspace_scope.clone(),"nodeId":"node-1","budgetChars":100})),
        ("mind_source_search", "source.search", json!({"scope":workspace_scope.clone(),"query":"plan","budgetChars":100})),
        ("mind_source_read", "source.read", json!({"source":{"object":{"workspaceId":"test","scope":workspace_scope,"kind":"record","id":"1"}},"view":"full","budgetChars":100})),
        ("mind_record_blocks_get", "record.blocks.get", json!({"record":record})),
        ("mind_record_get", "record.get", json!({"record":record,"budgetChars":100})),
        ("mind_reference_list", "reference.list", json!({"object":record,"direction":"outgoing","limit":10,"budgetChars":1000})),
        ("mind_record_create_preview", "record.create.preview", json!({"input":{"scope":project_scope,"title":"MCP preview","tagIds":[],"markdown":"# 你好\n\n- Item\n","codeLanguage":null},"budgetChars":100})),
        ("mind_record_patch_preview", "record.patch.preview", json!({"record":record,"baseRevision":1,"operations":[],"budgetChars":100})),
        ("mind_record_versions_list", "record.versions.list", json!({"record":record})),
        ("mind_record_versions_get", "record.versions.get", json!({"record":record,"versionId":"a".repeat(32)})),
        ("mind_record_versions_compare", "record.versions.compare", json!({"record":record,"beforeVersionId":"a".repeat(32),"afterVersionId":"b".repeat(32)})),
        ("mind_todo_get", "todo.get", json!({"target":todo})),
        ("mind_file_list", "file.list", json!({"scope":project_scope,"tag":"topic","mode":"detail"})),
        ("mind_session_list", "session.list", json!({"scope":project_scope,"titleQuery":"chat","limit":0})),
        ("mind_record_list", "record.list", json!({"scope":project_scope,"tag":"topic","limit":1})),
        ("mind_todo_list", "todo.list", json!({"scope":project_scope,"status":"unfinished","dueTo":"2026-10-22","includeChildren":true,"limit":10})),
        ("mind_file_versions_list", "file.versions.list", json!({"object":file})),
        ("mind_file_versions_get", "file.versions.get", json!({"object":file,"versionId":"1"})),
        ("mind_file_source_read", "file.source.read", json!({"object":file,"versionNumber":1})),
    ];
    for (name, method, arguments) in reads {
        let called = client.peer().call_tool(
            CallToolRequestParams::new(name).with_arguments(arguments.as_object().unwrap().clone())
        ).await.unwrap();
        assert_eq!(called.is_error, Some(false), "{name}");
        assert_eq!(called.structured_content.as_ref().unwrap()["data"]["method"], method);
    }
    let preview_tool = listed.tools.iter().find(|tool| tool.name == "mind_record_patch_preview").unwrap();
    assert_eq!(preview_tool.annotations.as_ref().unwrap().read_only_hint, Some(true));
    assert_eq!(*preview_tool.input_schema, registry::schema("record.patch.preview").unwrap().as_object().unwrap().clone());
    let preview = client.peer().call_tool(
        CallToolRequestParams::new("mind_record_patch_preview").with_arguments(
            json!({"record":record,"baseRevision":1,"operations":[]}).as_object().unwrap().clone()
        )
    ).await.unwrap();
    assert_eq!(preview.is_error, Some(false));
    assert_eq!(preview.structured_content.as_ref().unwrap()["data"]["method"], "record.patch.preview");
    assert!(preview.structured_content.as_ref().unwrap()["requestId"].as_str().is_some_and(|id| !id.is_empty()));
    let create_preview_tool = listed.tools.iter().find(|tool| tool.name == "mind_record_create_preview").unwrap();
    assert_eq!(create_preview_tool.annotations.as_ref().unwrap().read_only_hint, Some(true));
    assert_eq!(*create_preview_tool.input_schema, registry::schema("record.create.preview").unwrap().as_object().unwrap().clone());
    let create_preview = client.peer().call_tool(
        CallToolRequestParams::new("mind_record_create_preview").with_arguments(
            json!({"input":{"scope":{"kind":"project","projectId":1},"title":"Preview","tagIds":[],"markdown":"# 你好","codeLanguage":null}}).as_object().unwrap().clone()
        )
    ).await.unwrap();
    assert_eq!(create_preview.is_error, Some(false));
    assert_eq!(create_preview.structured_content.as_ref().unwrap()["data"]["method"], "record.create.preview");
    let patch = |request_id: &str| json!({
        "record":{"workspaceId":"test","scope":{"kind":"project","projectId":1},"kind":"record","id":"1"},
        "baseRevision":1,
        "requestId":request_id,
        "operations":[]
    });
    for _ in 0..2 {
        let supplied = "stable-record-patch-1";
        let called = client.peer().call_tool(
            CallToolRequestParams::new("mind_record_patch")
                .with_arguments(patch(supplied).as_object().unwrap().clone())
        ).await.unwrap();
        assert_eq!(called.is_error, Some(false));
        assert_eq!(called.structured_content.as_ref().unwrap()["requestId"], supplied);
        assert_eq!(called.structured_content.as_ref().unwrap()["data"]["bridgeRequestId"], supplied);
    }
    for (name, request_id, input) in [
        (
            "mind_todo_create", "stable-todo-create-1",
            json!({"scope":{"kind":"project","projectId":1},"content":"Follow up",
                "priority":"normal","dueDate":null,"tagIds":[],"children":[]}),
        ),
        (
            "mind_todo_update", "stable-todo-update-1",
            json!({"target":{"workspaceId":"test","scope":{"kind":"project","projectId":1},"kind":"todo","id":"1"},
                "expectedRevision":1,"changes":[{"change":"deadline","dueDate":null}]}),
        ),
    ] {
        let arguments = json!({"requestId":request_id,"input":input});
        let called = client.peer().call_tool(
            CallToolRequestParams::new(name)
                .with_arguments(arguments.as_object().unwrap().clone())
        ).await.unwrap();
        assert_eq!(called.is_error, Some(false), "{name}");
        assert_eq!(called.structured_content.as_ref().unwrap()["requestId"], request_id);
        assert_eq!(called.structured_content.as_ref().unwrap()["data"]["bridgeRequestId"], request_id);
    }
    let file_create_id = "stable-file-create-1";
    let file_create = json!({"requestId":file_create_id,"input":{
        "projectId":1,"safeName":"notes.txt","utf8Content":"From MCP"
    }});
    let called = client.peer().call_tool(
        CallToolRequestParams::new("mind_file_create")
            .with_arguments(file_create.as_object().unwrap().clone())
    ).await.unwrap();
    assert_eq!(called.is_error, Some(false));
    assert_eq!(called.structured_content.as_ref().unwrap()["requestId"], file_create_id);
    assert_eq!(called.structured_content.as_ref().unwrap()["data"]["bridgeRequestId"], file_create_id);
    let stage_status = json!({"stagedContentId":"a".repeat(32)});
    let status = client.peer().call_tool(
        CallToolRequestParams::new("mind_file_content_status")
            .with_arguments(stage_status.as_object().unwrap().clone())
    ).await.unwrap();
    assert_eq!(status.is_error, Some(false));
    assert_ne!(status.structured_content.as_ref().unwrap()["requestId"], file_create_id);
    let calls_before_invalid = calls.load(Ordering::SeqCst);
    for invalid in ["", &"x".repeat(129)] {
        let called = client.peer().call_tool(
            CallToolRequestParams::new("mind_record_patch")
                .with_arguments(patch(invalid).as_object().unwrap().clone())
        ).await.unwrap();
        assert_eq!(called.is_error, Some(true));
        assert_eq!(called.structured_content.as_ref().unwrap()["error"]["code"], "INVALID_ARGUMENT");
    }
    let mut missing = patch("stable-record-patch-1");
    missing.as_object_mut().unwrap().remove("requestId");
    let missing = client.peer().call_tool(
        CallToolRequestParams::new("mind_record_patch")
            .with_arguments(missing.as_object().unwrap().clone())
    ).await.unwrap();
    assert_eq!(missing.is_error, Some(true));
    assert_eq!(calls.load(Ordering::SeqCst), calls_before_invalid);

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
