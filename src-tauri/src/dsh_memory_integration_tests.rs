//! Real SQLite + real DSH child + deterministic HTTP Provider; no desktop window.
use super::*;
use crate::agent::models::WorkspaceBinding;
use serde_json::{json, Value};

// Reuses production frame parsing, scope/intent validation, Session ownership,
// SQLite services and behavior CAS. AppState's lifecycle is replaced by the
// fixture's fixed binding; the real child revocation flags remain enforced.
pub(crate) fn wrap(
    database: Arc<std::sync::Mutex<crate::db::Database>>,
    identity: Identity,
    binding: WorkspaceBinding,
    fallback: SourceHandler,
    observed: Arc<std::sync::Mutex<Vec<Value>>>,
) -> SourceHandler {
    Arc::new(move |payload, revoked, url, frame_id, alive| {
        if !matches!(
            payload["operation"].as_str(),
            Some(
                "memory"
                    | "memoryAdoption"
                    | "memoryBehavior"
                    | "projectHistory"
                    | "memorySchedule"
            )
        ) {
            return fallback(payload, revoked, url, frame_id, alive);
        }
        if revoked.load(Ordering::SeqCst) || !alive.load(Ordering::SeqCst) {
            return Err("Runtime revoked".into());
        }
        crate::lock_mutex(&observed).push(payload.clone());
        let mut frame = BridgeFrame::parse(payload)?;
        let access = frame.validate(&identity)?;
        let session = frame.session_id();
        let client = session_http_client()?;
        let value = tokio::runtime::Handle::current().block_on(session_request(
            url,
            &client,
            &mut None,
            SessionRequest::List,
        ))?;
        let list: SessionListValue = serde_json::from_value(value).map_err(|e| e.to_string())?;
        if !list.items.iter().any(|item| {
            item.id == session
                && item
                    .cwd
                    .as_deref()
                    .is_some_and(|cwd| Path::new(cwd) == identity.directory())
        }) {
            return Err("Foreign memory Session".into());
        }
        let mut db = crate::lock_mutex(&database);
        identity
            .validate_context(&mut db, &identity.root)
            .map_err(|error| {
                eprintln!("Fixture context: {error}");
                error
            })?;
        execute_frame(&db, &identity, &binding, &identity.root, frame, access)
    })
}

async fn rpc(process: &mut AssistantProcess, method: &str, request: Value) -> Value {
    authenticate(
        &process.url,
        &process.session_http,
        &mut process.session_cookie,
    )
    .await
    .unwrap();
    let args = if method == "session/list" {
        json!({"_request":request})
    } else {
        json!({"request":request})
    };
    let value: Value = process.session_http.post(process.url.join(&format!("/api/{method}")).unwrap())
        .header(reqwest::header::ORIGIN, process.url.origin().ascii_serialization())
        .header(reqwest::header::COOKIE, process.session_cookie.clone().unwrap())
        .json(&json!({"type":"client-request","rpcId":session_rpc_id(),"method":method,"payload":{"args":args}}))
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(value["result"]["ok"], true, "{value}");
    value["result"]["value"].clone()
}
fn snapshot(body: &Value) -> Value {
    body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["content"].as_str())
        .find_map(|text| {
            text.strip_prefix("Current authoritative memory.")
                .and_then(|_| text.split_once('\n'))
                .map(|(_, json)| serde_json::from_str(json).unwrap())
        })
        .expect("actual provider memory snapshot")
}

#[tokio::test]
async fn memory_real_sqlite_node_provider_mutations_behavior_and_scope() {
    use axum::{routing::post, Json, Router};
    let root = tempfile::tempdir().unwrap();
    let mut db =
        crate::db::Database::open(&root.path().join("memory.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace("memory-native").unwrap();
    let project = db
        .project_create(crate::models::ProjectCreateInput {
            name: "Memory".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let foreign = db
        .project_create(crate::models::ProjectCreateInput {
            name: "Other".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let current_scope = MemoryScope::Project {
        project_id: project.id,
    };
    for (scope, content, category) in [
        (
            MemoryScope::Workspace,
            "shared workspace fact",
            "preference",
        ),
        (
            MemoryScope::Project {
                project_id: foreign.id,
            },
            "FOREIGN_PRIVATE_FACT",
            "agreement",
        ),
    ] {
        db.memory_execute(
            &MemoryAccess {
                scope: scope.clone(),
                origin: MemoryOrigin::User,
                sources: vec![],
            },
            MemoryRequest::Apply {
                request_id: content.into(),
                changes: vec![
                    json!({"action":"add","scope":scope,"category":category,"content":content}),
                ],
            },
        )
        .unwrap();
    }
    let binding = WorkspaceBinding {
        workspace_id: "memory-native".into(),
        generation: "generation-one".into(),
    };
    let identity = Identity {
        workspace_id: binding.workspace_id.clone(),
        workspace_generation: binding.generation.clone(),
        root: root.path().into(),
        fingerprint: "local".into(),
        context: AssistantContext::Project(ProjectContext {
            id: project.id,
            name: project.name.clone(),
            directory: PathBuf::from(&project.root_path).canonicalize().unwrap(),
        }),
    };
    let database = Arc::new(std::sync::Mutex::new(db));
    let observed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let handler = wrap(
        database.clone(),
        identity,
        binding,
        Arc::new(|_, _, _, _, _| Err("Unexpected File operation".into())),
        observed.clone(),
    );
    let bodies = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let captured = bodies.clone();
    let project_id = project.id;
    let router=Router::new().route("/v1/chat/completions",post(move |Json(body):Json<Value>| {
        let captured=captured.clone();
        async move {
            let mut bodies=crate::lock_mutex(&captured);
            let index=bodies.len();
            let current=snapshot(&body);
            let target=current["facts"].as_array().unwrap().iter().find(|fact|fact["scope"]["projectId"]==project_id);
            let call=match index {
                0=>Some(("memory_apply",json!({"changes":[{"action":"add","scope":{"kind":"project","projectId":project_id},"category":"agreement","content":"before correction","condition":"work only"}]}))),
                1=>{let fact=target.unwrap();Some(("memory_apply",json!({"changes":[{"action":"patch","scope":fact["scope"],"id":fact["id"],"expectedRevision":fact["revision"],"content":"after correction"}]})))},
                2=>Some(("project_history",json!({"query":"correction"}))),
                3=>{let fact=target.unwrap();Some(("memory_apply",json!({"changes":[{"action":"forget","scope":fact["scope"],"id":fact["id"],"expectedRevision":fact["revision"]}]})))},
                4=>Some(("memory_behavior",json!({"action":"write","expected_revision":current["behavior"]["revision"],"content":format!("{}\nNative runtime behavior refreshed.\n",current["behavior"]["content"].as_str().unwrap())}))),
                5=>Some(("memory_schedule",json!({"action":"read"}))),
                6 | 7=>Some(("memory_schedule",json!({"action":"write","input":{"enabled":true,"intervalHours":48,"localTime":"08:30","timezone":"Asia/Shanghai","expectedRevision":0}}))),
                _=>None,
            };
            bodies.push(body);
            let delta=call.as_ref().map(|(name,args)|json!({"tool_calls":[{"index":0,"id":format!("memory-call-{index}"),"type":"function","function":{"name":name,"arguments":args.to_string()}}]})).unwrap_or_else(||json!({"content":"Completed native memory operations"}));
            let frame=|delta,reason:Option<&str>|json!({"id":"memory-local","object":"chat.completion.chunk","created":0,"model":"local-test-model","choices":[{"index":0,"delta":delta,"finish_reason":reason}]}).to_string();
            ([("content-type","text/event-stream")],format!("data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",frame(delta,None),frame(json!({}),Some(if call.is_some(){"tool_calls"}else{"stop"}))))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}/v1", listener.local_addr().unwrap());
    let provider = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let package = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("packages/dsh-assistant");
    let mut command =
        Command::new(development_node(if cfg!(windows) { "node.exe" } else { "node" }).unwrap());
    command
        .arg(package.join("scripts/runtime.mjs"))
        .args(["--embedded", "--port", "0", "--no-open"])
        .current_dir(&package)
        .env("PROJECT_MIND_DSH_USER_DATA", root.path().join("runtime"))
        .env("PROJECT_MIND_DSH_PROFILE_DIR", root.path().join("profile"));
    let config = json!({"type":"configure","provider":{"name":"local","baseUrl":origin,"modelId":"local-test-model","apiKey":"local-integration-key","supportsImage":false},"project":{"id":project.id,"name":project.name,"directory":project.root_path}});
    let mut process = AssistantProcess::launch_with_source(command, &config, Some(handler))
        .await
        .unwrap();
    let session = rpc(&mut process, "session/create", json!({})).await["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    rpc(
        &mut process,
        "session/rename",
        json!({"sessionId":session,"title":"Native memory"}),
    )
    .await;
    let human = "请记住项目约定，再纠正并忘记这条测试记忆，同时查看项目约定历史、修改记忆行为并将工作区整理改为每48小时上海时间08:30。";
    rpc(&mut process,"session/prompt",json!({"sessionId":session,"requestId":"native-human-request","mode":"queue","content":[{"type":"text","text":human}]})).await;
    let completed = tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            let count = crate::lock_mutex(&bodies).len();
            let list = rpc(&mut process, "session/list", json!({})).await;
            let running = list["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["sessionId"] == session && item["running"] == true);
            if count > 0 && !running {
                break count;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await;
    process.stop().await.unwrap();
    provider.abort();
    assert_eq!(
        completed.unwrap(),
        9,
        "native frames: {:?}",
        crate::lock_mutex(&observed)
    );
    let bodies = crate::lock_mutex(&bodies);
    assert!(snapshot(&bodies[1])
        .to_string()
        .contains("before correction"));
    assert!(snapshot(&bodies[2])
        .to_string()
        .contains("after correction"));
    assert_eq!(snapshot(&bodies[4])["facts"].as_array().unwrap().len(), 1);
    assert!(snapshot(&bodies[4])["negativeConstraints"]
        .to_string()
        .contains("after correction"));
    assert!(snapshot(&bodies[5])["behavior"]["content"]
        .as_str()
        .unwrap()
        .contains("Native runtime behavior refreshed."));
    let history_text = bodies[3]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["tool_call_id"] == "memory-call-2")
        .unwrap()["content"]
        .as_str()
        .unwrap();
    assert!(history_text.contains("\"historical\":true"));
    assert!(
        history_text.contains("before correction") && history_text.contains("after correction")
    );
    assert!(!snapshot(&bodies[3])["facts"]
        .to_string()
        .contains("before correction"));
    assert!(bodies[7]["messages"]
        .to_string()
        .contains("记忆整理时间已保存"));
    assert!(snapshot(&bodies[8])["operationResults"]
        .to_string()
        .contains("重新读取"));
    for body in bodies.iter() {
        assert!(!body.to_string().contains("FOREIGN_PRIVATE_FACT"));
        assert!(snapshot(body).to_string().contains("shared workspace fact"));
    }
    let db = crate::lock_mutex(&database);
    let result = db
        .memory_execute(
            &MemoryAccess {
                scope: current_scope.clone(),
                origin: MemoryOrigin::User,
                sources: vec![],
            },
            MemoryRequest::List {
                scope: current_scope.clone(),
                include_inactive: true,
            },
        )
        .unwrap();
    let fact = result["facts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["scope"]["projectId"] == project.id)
        .unwrap();
    assert_eq!(fact["state"], "forgotten");
    assert_eq!(fact["revision"], 3);
    let schedule = serde_json::to_value(
        crate::memory_maintenance::read_schedule(
            &db,
            &crate::agent::models::WorkspaceBinding {
                workspace_id: "memory-native".into(),
                generation: "generation-one".into(),
            },
            &crate::agent::models::Scope::Workspace,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(schedule["revision"], 1);
    assert_eq!(schedule["localTime"], "08:30");
    assert_eq!(schedule["intervalHours"], 48);
    let observed = crate::lock_mutex(&observed);
    let actual = observed
        .iter()
        .find(|frame| frame["request"]["operation"] == "apply")
        .unwrap();
    assert_eq!(actual["userMessage"]["text"], human);
    assert_eq!(fact["sources"][0]["messageId"], actual["userMessage"]["id"]);
    assert_eq!(fact["sources"][0]["sessionId"], session);
    assert_eq!(
        db.memory_adoption_get(&current_scope, &session)
            .unwrap()
            .unwrap()["snapshot"]["sessionId"],
        session
    );
    assert!(crate::memory_behavior::read(root.path())
        .unwrap()
        .content
        .contains("Native runtime behavior refreshed."));
}

#[path = "dsh_memory_model_evaluation.rs"]
mod model_evaluation;
