use super::*;
use crate::{
    agent::access::{Caller, RequestContext, ScopeGrant},
    db::Database,
};
use serde_json::json;
use std::fs;

fn request() -> HistoryRequest {
    serde_json::from_value(json!({"sessionId":"session-1","limit":2,"maxChars":8})).unwrap()
}
fn binding() -> WorkspaceBinding {
    WorkspaceBinding {
        workspace_id: "workspace-1".into(),
        generation: "generation-1".into(),
    }
}
fn message() -> Value {
    json!({"messageId":format!("{:x}", Sha256::digest("session-1:entry-1".as_bytes()))[..32].to_string(),"runtimeEntryId":"entry-1",
        "ordinal":4,"role":"assistant","createdAt":"2026-10-09T00:00:00Z","text":"中🙂",
        "contentHash":format!("sha256:{:x}", Sha256::digest("中🙂".as_bytes())),"charStart":0,"charEnd":2,"totalChars":2})
}
fn page(messages: Vec<Value>) -> RuntimePage {
    serde_json::from_value(json!({"sessionId":"session-1","branchId":"branch-1",
        "messages":messages,"nextCursor":null,"hasMore":false}))
    .unwrap()
}

#[test]
fn gui_dto_rejects_claimed_scope_and_grants() {
    for extra in [
        json!({"scope":{"kind":"workspace"}}),
        json!({"scopeGrant":{"operations":["source.read"]}}),
    ] {
        let mut value =
            json!({"binding":binding(),"requestId":"r","data":{"sessionId":"session-1"}});
        value["data"]
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert!(serde_json::from_value::<HistoryCommandInput>(value).is_err());
    }
    let mut value = json!({"binding":binding(),"requestId":"r","data":{"sessionId":"session-1"},"caller":"model"});
    assert!(serde_json::from_value::<HistoryCommandInput>(value.take()).is_err());
}

#[test]
fn history_request_rejects_page_bounds_and_anchor_conflicts() {
    for (field, invalid_value) in [
        ("limit", json!(0)),
        ("limit", json!(51)),
        ("maxChars", json!(0)),
        ("maxChars", json!(12_001)),
    ] {
        let mut value = serde_json::to_value(request()).unwrap();
        value[field] = invalid_value;
        assert!(serde_json::from_value::<HistoryRequest>(value)
            .unwrap()
            .validate()
            .is_err());
    }
    let cursor = json!({"branchId":"branch-1","fromMessageId":null,"toMessageId":null,
        "messageId":"0123456789abcdef0123456789abcdef","charOffset":1});
    let mut value = serde_json::to_value(request()).unwrap();
    value["cursor"] = cursor;
    value["branchId"] = json!("other");
    assert!(serde_json::from_value::<HistoryRequest>(value)
        .unwrap()
        .validate()
        .is_err());
}

#[test]
fn history_page_binds_exact_stored_scope_and_unicode_offsets() {
    let scope = Scope::Project { project_id: 17 };
    let output = convert_page(page(vec![message()]), &request(), &binding(), &scope).unwrap();
    let value = serde_json::to_value(output).unwrap();
    assert_eq!(
        value["messages"][0]["messageRef"],
        json!({
            "workspaceId":"workspace-1","scope":{"kind":"project","projectId":17},
            "sessionId":"session-1","branchId":"branch-1","messageId":format!("{:x}", Sha256::digest("session-1:entry-1".as_bytes()))[..32].to_string(),
            "ordinal":4,"contentHash":format!("sha256:{:x}", Sha256::digest("中🙂".as_bytes()))
        })
    );
    assert_eq!(value["messages"][0]["charEnd"], 2);
}

#[test]
fn history_page_rejects_oversize_or_mismatched_runtime_data() {
    let mut wrong_offset = message();
    wrong_offset["charEnd"] = json!(3);
    assert!(convert_page(
        page(vec![wrong_offset]),
        &request(),
        &binding(),
        &Scope::Workspace
    )
    .is_err());
    let mut long_text = message();
    long_text["text"] = json!("a".repeat(9));
    long_text["charEnd"] = json!(9);
    long_text["totalChars"] = json!(9);
    assert!(convert_page(
        page(vec![long_text]),
        &request(),
        &binding(),
        &Scope::Workspace
    )
    .is_err());
    let wrong_branch: RuntimePage =
        serde_json::from_value(json!({"sessionId":"session-1","branchId":null,
        "messages":[message()],"nextCursor":null,"hasMore":false}))
        .unwrap();
    assert!(convert_page(wrong_branch, &request(), &binding(), &Scope::Workspace).is_err());
}

#[test]
fn gui_session_scope_comes_from_stored_session_and_deletion_is_rechecked() {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open(&root.path().join("workspace.sqlite"), root.path(), None).unwrap();
    let conn = rusqlite::Connection::open(root.path().join("workspace.sqlite")).unwrap();
    conn.execute("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES (17,'Project','workspace:project','now','now')", []).unwrap();
    let binding = binding();
    let scope = Scope::Workspace;
    let gui = RequestContext {
        binding: binding.clone(),
        request_id: "fixture".into(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: true,
            project_ids: vec![],
            operations: vec!["session.read".into(), "session.write".into()],
        },
    };
    let session = db
        .agent_session_create(&gui, &binding, &scope, "History", "builtin-pi", None)
        .unwrap();
    let resolved = db
        .agent_gui_session_request(
            &binding,
            &binding,
            "history-read",
            &session.id,
            &["session.read"],
        )
        .unwrap();
    assert_eq!(resolved.scope_grant.workspace_id, binding.workspace_id);
    assert!(resolved.scope_grant.workspace_content);
    assert_eq!(resolved.scope_grant.operations, vec!["session.read"]);
    assert_eq!(
        db.agent_session_get(&resolved, &binding, &session.id, None, 1)
            .unwrap()
            .session
            .scope,
        scope
    );
    let mut project_gui = gui.clone();
    project_gui.scope_grant.project_ids = vec![17];
    let project = db
        .agent_session_create(
            &project_gui,
            &binding,
            &Scope::Project { project_id: 17 },
            "Project history",
            "builtin-pi",
            None,
        )
        .unwrap();
    let project_read = db
        .agent_gui_session_request(
            &binding,
            &binding,
            "project-history",
            &project.id,
            &["session.read"],
        )
        .unwrap();
    assert!(!project_read.scope_grant.workspace_content);
    assert_eq!(project_read.scope_grant.project_ids, vec![17]);
    db.agent_session_delete(&gui, &binding, &session.id)
        .unwrap();
    assert!(db
        .agent_gui_session_request(
            &binding,
            &binding,
            "history-read",
            &session.id,
            &["session.read"]
        )
        .is_err());
}

#[tokio::test]
#[ignore = "requires the staged packaged Host runtime; run explicitly"]
async fn packaged_history_reads_checkpoint_without_profile_or_session_open() {
    let workspace = tempfile::tempdir().unwrap();
    let root = workspace.path().canonicalize().unwrap();
    let db = Database::open(&root.join("workspace.sqlite"), &root, None).unwrap();
    let gui = RequestContext {
        binding: binding(),
        request_id: "history-search".into(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: binding().workspace_id,
            workspace_content: true,
            project_ids: vec![],
            operations: vec!["session.read".into(), "session.write".into()],
        },
    };
    let session_id = db
        .agent_session_create(
            &gui,
            &binding(),
            &Scope::Workspace,
            "原文定位",
            "builtin-pi",
            None,
        )
        .unwrap()
        .id;
    let sessions = root.join(".project-mind/agent/sessions").join(&session_id);
    fs::create_dir_all(&sessions).unwrap();
    let header = json!({"type":"session","version":3,"id":session_id,
        "timestamp":"2026-10-09T00:00:00Z","cwd":"workspace:."});
    let entry = json!({"type":"message","id":"entry1","parentId":null,
        "timestamp":"2026-10-09T00:00:00Z","message":{"role":"user","content":[{"type":"text","text":"中🙂"}]}});
    let old_branch = json!({"type":"message","id":"old-branch","parentId":"entry1",
        "timestamp":"2026-10-09T00:00:01Z","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"旧决定"}]}});
    let new_branch = json!({"type":"message","id":"new-branch","parentId":"entry1",
        "timestamp":"2026-10-09T00:00:02Z","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"新决定"}]}});
    let jsonl = format!("{}\n{}\n{}\n{}\n", header, entry, old_branch, new_branch);
    let checksum = format!("sha256:{:x}", Sha256::digest(jsonl.as_bytes()));
    fs::write(sessions.join("session.jsonl"), &jsonl).unwrap();
    fs::write(
        sessions.join("checkpoint.json"),
        format!(
            "{}\n",
            json!({
                "schemaVersion":1,"checksum":checksum,"bytes":jsonl.len(),"offset":jsonl.len(),
                "leafId":"new-branch","entryCount":3,"messageCount":2
            })
        ),
    )
    .unwrap();
    let checkpoint =
        serde_json::from_slice(&fs::read(sessions.join("checkpoint.json")).unwrap()).unwrap();
    let projection_message = serde_json::from_value(json!({
        "runtimeEntryId":"entry1","ordinal":0,"createdAt":"2026-10-09T00:00:00Z",
        "role":"user","content":[{"type":"text","text":"中🙂"}]
    }))
    .unwrap();
    let new_projection_message = serde_json::from_value(json!({
        "runtimeEntryId":"new-branch","parentId":"entry1","ordinal":1,
        "createdAt":"2026-10-09T00:00:02Z","role":"assistant","stopReason":"stop",
        "content":[{"type":"text","text":"新决定"}]
    }))
    .unwrap();
    db.agent_session_restore_projection(
        &gui,
        &binding(),
        &session_id,
        &crate::agent::conversation::VerifiedSessionProjection {
            checkpoint,
            messages: vec![projection_message, new_projection_message],
        },
    )
    .unwrap();
    let found = db
        .agent_session_search(
            &gui,
            &binding(),
            &serde_json::from_value(json!({"scope":{"kind":"workspace"},"query":"🙂"})).unwrap(),
        )
        .unwrap();
    assert_eq!(found.matches.len(), 1);
    let hit = &found.matches[0];
    let packaged = PackagedAgentRuntime::bundled(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"),
    )
    .unwrap();
    let mut process = packaged.spawn(&root, false).await.unwrap();
    let end = Instant::now() + Duration::from_secs(30);
    let initialized = exchange(
        &mut process,
        "init",
        "initialize",
        json!({"workspaceRoot":root,"tools":[],"systemPrompt":"Read persisted session history."}),
        end,
    )
    .await
    .unwrap();
    assert_eq!(initialized["activeTools"], json!([]));
    let old_search =
        serde_json::from_value(json!({"scope":{"kind":"workspace"},"query":"旧决定"})).unwrap();
    assert!(db
        .agent_session_search(&gui, &binding(), &old_search)
        .unwrap()
        .matches
        .is_empty());
    let mut scan_pages = 0;
    while let Some(work) = db
        .agent_session_scan_work(&gui, &binding(), &Scope::Workspace, None)
        .unwrap()
    {
        scan_pages += 1;
        assert!(scan_pages <= 10, "bounded fixture scan must make progress");
        let page = exchange(
            &mut process,
            "scan",
            "session.history.scan",
            json!({"sessionId":work.session_id,"expectedChecksum":work.checksum,
                "cursor":work.cursor,"previousCheckpoint":work.previous_checkpoint,"maxChars":2}),
            end,
        )
        .await
        .unwrap();
        let page = serde_json::from_value(page).unwrap();
        db.agent_session_scan_commit(&gui, &binding(), &work, &page)
            .unwrap();
    }
    assert!(
        scan_pages > 1,
        "fixture must exercise persisted fragment continuation"
    );
    let old_result = db
        .agent_session_search(&gui, &binding(), &old_search)
        .unwrap();
    assert!(old_result.coverage.complete);
    assert_eq!(old_result.matches.len(), 1);
    let old_hit = &old_result.matches[0];
    assert_eq!(old_hit.branch_leaf_id, "old-branch");
    let old_request: HistoryRequest = serde_json::from_value(json!({
        "sessionId":old_hit.session_id,"branchId":old_hit.branch_leaf_id,
        "fromMessageId":old_hit.message_id,"toMessageId":old_hit.message_id
    }))
    .unwrap();
    let old_page = exchange(
        &mut process,
        "old-read",
        "session.history.read",
        serde_json::to_value(&old_request).unwrap(),
        end,
    )
    .await
    .unwrap();
    let old_page = convert_page(
        serde_json::from_value(old_page).unwrap(),
        &old_request,
        &binding(),
        &Scope::Workspace,
    )
    .unwrap();
    assert_eq!(old_page.messages[0].text, "旧决定");
    assert_eq!(old_page.messages[0].content_hash, old_hit.content_hash);
    assert_eq!(old_page.messages[0].ordinal, old_hit.ordinal);
    let request: HistoryRequest = serde_json::from_value(
        json!({"sessionId":hit.session_id,"branchId":hit.branch_leaf_id,
            "fromMessageId":hit.message_id,"toMessageId":hit.message_id,"maxChars":1}),
    )
    .unwrap();
    let runtime_page = exchange(
        &mut process,
        "read",
        "session.history.read",
        serde_json::to_value(&request).unwrap(),
        end,
    )
    .await
    .unwrap();
    let page: RuntimePage = serde_json::from_value(runtime_page).unwrap();
    let page = convert_page(page, &request, &binding(), &Scope::Workspace).unwrap();
    assert_eq!(page.messages[0].text, "中");
    assert!(page.has_more);
    let first_id = page.messages[0].message_id.clone();
    let first_hash = page.messages[0].content_hash.clone();
    assert_eq!(first_id, hit.message_id);
    assert_eq!(first_hash, hit.content_hash);
    let next_request: HistoryRequest = serde_json::from_value(json!({
        "sessionId":session_id,"maxChars":1,"cursor":page.next_cursor
    }))
    .unwrap();
    let second_page = exchange(
        &mut process,
        "read-next",
        "session.history.read",
        serde_json::to_value(&next_request).unwrap(),
        end,
    )
    .await
    .unwrap();
    let second_page: RuntimePage = serde_json::from_value(second_page).unwrap();
    let second_page =
        convert_page(second_page, &next_request, &binding(), &Scope::Workspace).unwrap();
    assert_eq!(second_page.messages.len(), 1);
    assert_eq!(second_page.messages[0].text, "🙂");
    assert_eq!(second_page.messages[0].message_id, first_id);
    assert_eq!(second_page.messages[0].content_hash, first_hash);
    assert_eq!(
        (
            second_page.messages[0].char_start,
            second_page.messages[0].char_end
        ),
        (1, 2)
    );
    assert!(!second_page.has_more);
    assert!(second_page.next_cursor.is_none());
    let shutdown = json!({"protocolVersion":HOST_PROTOCOL,"requestId":"shutdown","method":"shutdown","data":{}});
    process.send(&shutdown).await.unwrap();
    process.shutdown().await.unwrap();
}
