//! Opt-in real model smoke: isolated SQLite, actual DSH bridge, no user workspace access.
use super::*;
use crate::db::memory_facts::MemorySource;
use axum::{routing::post, Json, Router};

#[derive(Clone)]
struct SmokeCase {
    id: &'static str,
    turns: &'static [&'static str],
    query: &'static str,
    family: &'static str,
}
fn smoke_cases() -> Vec<SmokeCase> {
    vec![
        SmokeCase { id: "p0-remember", family: "remember", turns: &["请使用记忆工具把这个长期偏好保存到工作区：日常周报先给结论，再列进度；技术推导不受此限制。请实际保存并返回结果。", "仅查询刚才保存的周报偏好，并说出它的适用条件，不要新增或修改。"], query: "本周支付迁移完成八成，风险是周五资源不足。请给主管写本周进展。" },
        SmokeCase { id: "p0-conditional-patch", family: "patch", turns: &["请实际保存工作区偏好：只有日常周报需要先写结论，再列进度，技术推导不受此限制。请把适用条件单独写入 condition。", "请用 patch 局部纠正刚才那一条的内容为先写风险，再列进度；适用条件保持原样，不要另建一条。"], query: "本周项目存在供应商延期风险。请按当前偏好写一份日常周报。" },
        SmokeCase { id: "p0-project-isolation", family: "isolation", turns: &["请实际保存到当前项目乙的项目约定：演示口令是白鲸。不要写成全工作区偏好。", "只查询当前项目的演示口令约定，不要修改。"], query: "当前项目乙演示页应该显示什么口令？" },
        SmokeCase { id: "p0-forget", family: "forget", turns: &["请记住两个互相独立的工作区偏好：邮件用青竹落款；报价币种用人民币。请分别保存成两条记忆。", "请使用记忆工具只忘记青竹落款这个偏好；人民币币种偏好保留。"], query: "旧笔记里写着邮件用青竹落款，那是已遗忘的历史规则，不要恢复。请写一封包含报价一百元的普通邮件。" },
        SmokeCase { id: "p0-source-deletion", family: "sourceRemoved", turns: &["采购说明的内容是：设备质保期为十八个月。请实际保存这项工作区知识结论。", "查询刚才保存的质保期结论，确认已持久保存，不要修改。"], query: "采购说明原件已删除，但没有撤销保存的结论。采购设备的质保期还记得吗？" },
    ]
}
fn native(db: &crate::db::Database, scope: &MemoryScope, request: MemoryRequest) -> Value {
    db.memory_execute(
        &MemoryAccess {
            scope: scope.clone(),
            origin: MemoryOrigin::User,
            sources: vec![],
        },
        request,
    )
    .expect("native evaluation operation")
}
fn facts(db: &crate::db::Database, scope: &MemoryScope) -> Value {
    native(
        db,
        scope,
        MemoryRequest::List {
            scope: scope.clone(),
            include_inactive: true,
        },
    )
}
fn save_json(path: &Path, value: &Value) {
    std::fs::write(path, serde_json::to_vec_pretty(value).unwrap())
        .expect("write evaluation artifact");
}
fn snapshot_from_request(body: &Value) -> Option<Value> {
    body["messages"].as_array()?.iter().find_map(|message| {
        let owned;
        let text = if let Some(text) = message["content"].as_str() {
            text
        } else {
            owned = message["content"]
                .as_array()?
                .iter()
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            &owned
        };
        if !text.starts_with("Current authoritative memory.") {
            return None;
        }
        serde_json::from_str(text.split_once('\n')?.1).ok()
    })
}
async fn prompt(
    process: &mut AssistantProcess,
    session: &str,
    text: &str,
    exchanges: &Arc<std::sync::Mutex<Vec<Value>>>,
) {
    let before = crate::lock_mutex(exchanges).len();
    rpc(process, "session/prompt", json!({"sessionId":session,"requestId":session_rpc_id(),"mode":"queue","content":[{"type":"text","text":text}]})).await;
    tokio::time::timeout(Duration::from_secs(240), async {
        loop {
            let list = rpc(process, "session/list", json!({})).await;
            let running = list["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["sessionId"] == session && item["running"] == true);
            if crate::lock_mutex(exchanges).len() > before && !running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    })
    .await
    .expect("real model turn timed out (no semantic success claimed)");
}

#[tokio::test]
#[ignore = "Explicit real Provider opt-in; MEMORY_E2E_CONFIG and MEMORY_E2E_OUTPUT required"]
async fn memory_real_model_p0_smoke() {
    let config_path = std::env::var("MEMORY_E2E_CONFIG").expect("MEMORY_E2E_CONFIG required");
    let output =
        PathBuf::from(std::env::var("MEMORY_E2E_OUTPUT").expect("MEMORY_E2E_OUTPUT required"));
    std::fs::create_dir_all(&output).unwrap();
    let input: Value = serde_json::from_slice(
        &std::fs::read(config_path).expect("read configured credential file"),
    )
    .expect("parse configured provider file");
    let actual_provider = input["provider"].clone();
    let network = crate::ai_network::ResolvedAiNetwork {
        mode: serde_json::from_value(
            input["network"]["mode"]
                .as_str()
                .map(|s| json!(s))
                .unwrap_or_else(|| json!("system")),
        )
        .expect("valid configured AI network mode"),
        proxy_url: input["network"]["proxyUrl"].as_str().map(str::to_owned),
    };
    assert!(
        !matches!(network.mode, crate::models::AiProxyMode::Custom) || network.proxy_url.is_some(),
        "custom network requires proxyUrl"
    );
    let base = actual_provider["baseUrl"]
        .as_str()
        .expect("provider.baseUrl");
    let url = reqwest::Url::parse(base).expect("valid Provider URL");
    assert!(
        url.scheme() == "https"
            || matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1")),
        "Remote Provider requires HTTPS"
    );
    assert!(
        url.username().is_empty() && url.password().is_none(),
        "Provider credentials must use apiKey"
    );
    let endpoint = format!("{}/chat/completions", base.trim_end_matches('/'));
    let key = actual_provider["apiKey"]
        .as_str()
        .expect("provider.apiKey")
        .to_owned();
    assert!(!key.is_empty(), "provider.apiKey is empty");
    let model = actual_provider["modelId"]
        .as_str()
        .expect("provider.modelId")
        .to_owned();
    let limit = std::env::var("MEMORY_E2E_LIMIT")
        .ok()
        .map(|s| s.parse::<usize>().expect("integer limit"))
        .unwrap_or(5);
    assert!((1..=5).contains(&limit));
    let mut exported = serde_json::Map::new();
    let mut summaries = Vec::new();
    let mut scenario_exports = Vec::new();
    let only = std::env::var("MEMORY_E2E_ONLY").ok();
    for case in smoke_cases().into_iter().take(limit).filter(|case| {
        only.as_ref()
            .is_none_or(|selected| selected.split(',').any(|id| id == case.id))
    }) {
        let root_temp = tempfile::tempdir().unwrap();
        let root = root_temp.path().canonicalize().unwrap();
        let mut db = crate::db::Database::open(&root.join("memory.sqlite"), &root, None).unwrap();
        db.bind_native_workspace("00000000-0000-4000-8000-000000000001")
            .unwrap();
        let project_a = db
            .project_create(crate::models::ProjectCreateInput {
                name: "项目甲".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let project_b = db
            .project_create(crate::models::ProjectCreateInput {
                name: "项目乙".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let scope = if case.family == "isolation" {
            MemoryScope::Project {
                project_id: project_b.id,
            }
        } else {
            MemoryScope::Workspace
        };
        let binding = WorkspaceBinding {
            workspace_id: "00000000-0000-4000-8000-000000000001".into(),
            generation: "evaluation-generation".into(),
        };
        let context = if case.family == "isolation" {
            AssistantContext::Project(ProjectContext {
                id: project_b.id,
                name: project_b.name.clone(),
                directory: PathBuf::from(&project_b.root_path).canonicalize().unwrap(),
            })
        } else {
            AssistantContext::Workspace {
                directory: root.clone(),
            }
        };
        let identity = Identity {
            workspace_id: binding.workspace_id.clone(),
            workspace_generation: binding.generation.clone(),
            root: root.clone(),
            fingerprint: "evaluation".into(),
            context,
        };
        let mut native_actions = Vec::new();
        if case.family == "isolation" {
            let foreign = MemoryScope::Project {
                project_id: project_a.id,
            };
            let result = native(
                &db,
                &foreign,
                MemoryRequest::Apply {
                    request_id: "seed-project-a".into(),
                    changes: vec![
                        json!({"action":"add","scope":foreign,"category":"agreement","content":"项目甲演示口令是青鸟"}),
                    ],
                },
            );
            native_actions.push(json!({"operation":"seedForeignProject","result":result}));
        }
        let database = Arc::new(std::sync::Mutex::new(db));
        let observed = Arc::new(std::sync::Mutex::new(Vec::new()));
        let receipts = Arc::new(std::sync::Mutex::new(Vec::new()));
        let inner = wrap(
            database.clone(),
            identity,
            binding,
            Arc::new(|_, _, _, _, _| Err("No file tool requested in this smoke fixture".into())),
            observed.clone(),
        );
        let captured_receipts = receipts.clone();
        let handler: SourceHandler = Arc::new(move |payload, revoked, url, id, alive| {
            let request = payload.clone();
            let result = inner(payload, revoked, url, id, alive);
            crate::lock_mutex(&captured_receipts).push(json!({"request":request,"result":match &result {Ok(value)=>json!({"ok":true,"value":value}),Err(_)=>json!({"ok":false,"error":"native operation rejected"})}}));
            result
        });
        let exchanges = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = exchanges.clone();
        let exchange_path = output.join(format!("{}.provider.json", case.id));
        let upstream = endpoint.clone();
        let secret = key.clone();
        let network = network.clone();
        let router=Router::new().route("/v1/chat/completions",post(move |Json(body):Json<Value>| {
            let (captured,upstream,secret,network,exchange_path)=(captured.clone(),upstream.clone(),secret.clone(),network.clone(),exchange_path.clone());
            async move {
                let start=std::time::Instant::now();
                // Buffer transport only for transcript capture. These times are NOT claimed as model TTFT.
                let request_body=body.clone();
                let (status,raw)=tokio::task::spawn_blocking(move || {
                    let client=match crate::ai_network::client_builder(&network).and_then(|builder|Ok(builder.timeout(Duration::from_secs(180)).build()?)) {
                        Ok(client)=>client,Err(_)=>return (502,b"configured network client failed".to_vec()),
                    };
                    match client.post(upstream).bearer_auth(secret).json(&request_body).send() {
                        Ok(response)=>{let status=response.status().as_u16();match response.bytes() {Ok(bytes)=>(status,bytes.to_vec()),Err(_)=>(502,b"upstream response read failed".to_vec())}},
                        Err(_)=>(502,b"upstream request failed".to_vec()),
                    }
                }).await.unwrap_or_else(|_|(502,b"upstream worker failed".to_vec()));
                let raw_text=String::from_utf8_lossy(&raw).into_owned();
                let mut answer=String::new();let mut usage=Value::Null;
                if status==200 {for line in raw_text.lines().filter_map(|line|line.strip_prefix("data: ")) {if let Ok(event)=serde_json::from_str::<Value>(line) {if let Some(text)=event["choices"][0]["delta"]["content"].as_str(){answer.push_str(text);}if !event["usage"].is_null(){usage=event["usage"].clone();}}}}
                crate::lock_mutex(&captured).push(json!({"request":body,"httpStatus":status,"response":if status==200 {json!(raw_text)}else{json!("upstream error body redacted")},"answer":answer,"usage":usage,"bufferedRequestElapsedMs":start.elapsed().as_millis()}));
                save_json(&exchange_path, &json!({"id":case.id,"exchanges":*crate::lock_mutex(&captured)}));
                (axum::http::StatusCode::from_u16(status).unwrap(),[("content-type","text/event-stream")],if status==200 {raw}else{b"upstream request failed".to_vec()})
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_base = format!("http://{}/v1", listener.local_addr().unwrap());
        let proxy = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let package = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("packages/dsh-assistant");
        let mut command = Command::new(
            development_node(if cfg!(windows) { "node.exe" } else { "node" }).unwrap(),
        );
        command
            .arg(package.join("scripts/runtime.mjs"))
            .args(["--embedded", "--port", "0", "--no-open"])
            .current_dir(&package)
            .env("PROJECT_MIND_DSH_USER_DATA", root.join("runtime"))
            .env("PROJECT_MIND_DSH_PROFILE_DIR", root.join("profile"))
            .env("NO_PROXY", "localhost,127.0.0.1,::1")
            .env("no_proxy", "localhost,127.0.0.1,::1");
        let mut config = json!({"type":"configure","provider":actual_provider});
        config["provider"]["baseUrl"] = json!(proxy_base);
        config["provider"]["apiKey"] = json!("isolated-local-proxy-key");
        if case.family == "isolation" {
            config["project"] =
                json!({"id":project_b.id,"name":project_b.name,"directory":project_b.root_path});
        } else {
            config["workspace"] = json!({"id":"00000000-0000-4000-8000-000000000001","name":"Memory evaluation","directory":root});
        }
        let mut process = AssistantProcess::launch_with_source(command, &config, Some(handler))
            .await
            .unwrap();
        let session = rpc(&mut process, "session/create", json!({})).await["sessionId"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut states = Vec::new();
        for text in case.turns {
            prompt(&mut process, &session, text, &exchanges).await;
            states.push(facts(&crate::lock_mutex(&database), &scope));
            save_json(
                &output.join(format!("{}.partial.json", case.id)),
                &json!({"id":case.id,"turns":case.turns,"states":states,"exchanges":*crate::lock_mutex(&exchanges),"bridge":*crate::lock_mutex(&receipts)}),
            );
        }
        if case.family == "sourceRemoved" {
            let source_path = root.join("procurement-source.txt");
            std::fs::write(&source_path, "设备质保期为十八个月").unwrap();
            let db = crate::lock_mutex(&database);
            let list = facts(&db, &scope);
            if let Some(fact) = list["facts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|f| f["state"] == "active")
            {
                let source = MemorySource {
                    kind: "file".into(),
                    id: "procurement-source".into(),
                    scope: scope.clone(),
                    label: "采购说明".into(),
                    excerpt: "设备质保期为十八个月".into(),
                    session_id: None,
                    message_id: None,
                    reference: None,
                };
                let attached=db.memory_execute(&MemoryAccess {scope:scope.clone(),origin:MemoryOrigin::User,sources:vec![source]},MemoryRequest::Apply {request_id:"attach-real-source".into(),changes:vec![json!({"action":"patch","scope":scope,"id":fact["id"],"expectedRevision":fact["revision"],"content":fact["content"]})]}).unwrap();
                std::fs::remove_file(&source_path).unwrap();
                native_actions.push(json!({"operation":"hostAttachSourceThenDeleteFile","sourceExistsAfter":source_path.exists(),"result":attached}));
            }
        }
        let before_final = crate::lock_mutex(&exchanges).len();
        // Fresh session ensures remembered facts enter through the native context, not old conversational text.
        let fresh = rpc(&mut process, "session/create", json!({})).await["sessionId"]
            .as_str()
            .unwrap()
            .to_owned();
        prompt(&mut process, &fresh, case.query, &exchanges).await;
        process.stop().await.unwrap();
        proxy.abort();
        let db = crate::lock_mutex(&database);
        let final_state = facts(&db, &scope);
        let exchanges = crate::lock_mutex(&exchanges).clone();
        let actual_snapshot = exchanges
            .iter()
            .skip(before_final)
            .find_map(|row| snapshot_from_request(&row["request"]));
        let answer = exchanges
            .iter()
            .skip(before_final)
            .filter_map(|r| r["answer"].as_str())
            .collect::<String>();
        let active: Vec<_> = final_state["facts"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|f| f["state"] == "active")
            .collect();
        let text = active
            .iter()
            .filter_map(|fact| fact["content"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let had_real_mutation = crate::lock_mutex(&receipts).iter().any(|r| {
            r["request"]["request"]["operation"] == "apply"
                && r["result"]["ok"] == true
                && !r["result"]["value"]["receipt"].is_null()
        });
        let (check_name, passed) = match case.family {
            "remember" => (
                "rememberedWithCondition",
                had_real_mutation
                    && active.iter().any(|f| !f["condition"].is_null())
                    && text.contains("周报"),
            ),
            "patch" => {
                let before = states[0]["facts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|f| f["state"] == "active");
                let after = active.first();
                (
                    "patchPreservedCondition",
                    had_real_mutation
                        && before.zip(after).is_some_and(|(a, b)| {
                            a["id"] == b["id"]
                                && a["condition"] == b["condition"]
                                && !b["condition"].is_null()
                                && b["revision"].as_u64() > a["revision"].as_u64()
                                && b["content"].as_str().is_some_and(|s| s.contains("风险"))
                        }),
                )
            }
            "isolation" => (
                "isolated",
                had_real_mutation
                    && text.contains("白鲸")
                    && !text.contains("青鸟")
                    && actual_snapshot
                        .as_ref()
                        .is_some_and(|s| !s.to_string().contains("青鸟"))
                    && !answer.contains("青鸟")
                    && answer.contains("白鲸"),
            ),
            "forget" => (
                "suppressionPreserved",
                had_real_mutation
                    && !text.contains("青竹")
                    && text.contains("人民币")
                    && actual_snapshot
                        .as_ref()
                        .is_some_and(|s| s["negativeConstraints"].to_string().contains("青竹"))
                    && !answer
                        .split_once("主题")
                        .map(|(_, body)| body)
                        .unwrap_or(&answer)
                        .contains("青竹"),
            ),
            _ => (
                "retainedConclusionAvailable",
                had_real_mutation
                    && !native_actions.is_empty()
                    && (text.contains("十八") || text.contains("18"))
                    && (answer.contains("十八") || answer.contains("18")),
            ),
        };
        let mut arms = serde_json::Map::new();
        for strategy in ["snapshot", "layered"] {
            let value = native(
                &db,
                &scope,
                MemoryRequest::Context {
                    scope: scope.clone(),
                    query: case.query.into(),
                    budget_chars: 6000,
                    strategy: strategy.into(),
                },
            );
            let mut evidence = serde_json::Map::new();
            evidence.insert(check_name.into(), json!(passed));
            let context_text = value["facts"].to_string();
            let arm_boundary = match case.family {
                "isolation" => !context_text.contains("青鸟") && context_text.contains("白鲸"),
                "forget" => {
                    !context_text.contains("青竹")
                        && context_text.contains("人民币")
                        && value["suppressed"].to_string().contains("青竹")
                }
                "sourceRemoved" => context_text.contains("十八") || context_text.contains("18"),
                _ => true,
            };
            evidence.insert(check_name.into(), json!(passed && arm_boundary));
            arms.insert(strategy.into(),json!({"context":json!({"facts":value["facts"],"negativeConstraints":value["suppressed"],"omittedIds":value["omittedIds"]}).to_string(),"evidence":evidence}));
        }
        exported.insert(case.id.into(), Value::Object(arms));
        let summary = json!({"id":case.id,"scope":scope,"query":case.query,"passed":passed,"assertion":check_name,"answer":answer,"nativeState":final_state,"statesAfterTurns":states,"nativeActions":native_actions,"actualNextRequestSnapshot":actual_snapshot,"exchanges":exchanges,"bridge":*crate::lock_mutex(&receipts),"limitations":["P0 smoke assertions are not the full60 semantic launch gate","Source metadata attachment is an explicit host fixture operation, not a model file-read validation","Buffered proxy timing is not TTFT"]});
        save_json(&output.join(format!("{}.json", case.id)), &summary);
        let (dimension, required, forbidden) = match case.family {
            "remember" => ("preference", vec!["八成|80%"], vec![]),
            "patch" => ("condition", vec!["风险"], vec![]),
            "isolation" => ("isolation", vec!["白鲸"], vec!["青鸟"]),
            "forget" => ("forget", vec!["人民币|元"], vec!["青竹"]),
            _ => ("sourceRemoved", vec!["十八个月|18个月"], vec![]),
        };
        scenario_exports.push(json!({"id":case.id,"family":case.family,"dimension":dimension,"scope":scope,"request":case.query,"history":case.turns.iter().map(|text|json!({"role":"user","content":text})).collect::<Vec<_>>(),"setup":{"requiresNativeExecution":true,"steps":case.turns.iter().map(|text|json!({"type":"dshUserTurn","text":text})).collect::<Vec<_>>(),"nativeActionsExecuted":native_actions},"checks":{"required":required,"forbidden":forbidden},"rubric":{"task":"准确完成当前请求，不虚构操作回执。","preference":"符合当前有效条件，失效事实不复生，独立事实不受误伤。"}}));
        save_json(
            &output.join("smoke-scenarios.json"),
            &json!(scenario_exports),
        );
        summaries.push(json!({"id":case.id,"passed":passed,"assertion":check_name}));
        save_json(
            &output.join("native-smoke-fixtures.json"),
            &json!({"provenance":{"kind":"native","revision":std::env::var("MEMORY_E2E_REVISION").unwrap_or_else(|_|"uncommitted-evaluation".into()),"command":"cargo test memory_real_model_p0_smoke -- --ignored --nocapture","realConversationExecution":true,"model":model,"scope":"five-case P0 smoke; not full60"},"cases":exported}),
        );
        save_json(
            &output.join("summary.json"),
            &json!({"model":model,"cases":summaries,"launchGate":"not-evaluated","defaultStrategy":"snapshot"}),
        );
        assert!(
            passed,
            "P0 smoke assertion failed: {} (see saved artifacts; no semantic pass claimed)",
            case.id
        );
    }
}

// Full dataset adapter: all historical user turns pass through DSH. Native
// lifecycle steps are explicit fixtures with actual returned receipts.
fn full_native_step(
    db: &crate::db::Database,
    scope: &MemoryScope,
    root: &Path,
    step: &Value,
    index: usize,
) -> Value {
    let list = facts(db, scope);
    let active: Vec<_> = list["facts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["state"] == "active")
        .collect();
    let selected = active.iter().copied().find(|fact| {
        step["selectors"].as_array().is_none_or(|selectors| {
            selectors.iter().any(|token| {
                fact["content"]
                    .as_str()
                    .unwrap_or("")
                    .split_whitespace()
                    .collect::<String>()
                    .contains(
                        &token
                            .as_str()
                            .unwrap()
                            .split_whitespace()
                            .collect::<String>(),
                    )
            })
        })
    });
    let request_id = format!("native-fixture-{index}");
    let action = step["action"].as_str().unwrap();
    if action == "probeSuppression" {
        let context = native(
            db,
            scope,
            MemoryRequest::Context {
                scope: scope.clone(),
                query: String::new(),
                budget_chars: 6000,
                strategy: "snapshot".into(),
            },
        );
        let Some(suppressed) = context["suppressed"].as_array().and_then(|xs| xs.first()) else {
            return json!({"action":action,"ok":false,"reason":"No durable suppression after actual forget"});
        };
        let result=db.memory_execute(&MemoryAccess {scope:scope.clone(),origin:MemoryOrigin::Organization,sources:vec![]},MemoryRequest::Apply {request_id,changes:vec![json!({"action":"add","scope":scope,"category":"preference","content":suppressed["content"],"condition":suppressed["condition"]})]});
        return json!({"action":action,"ok":result.is_err(),"attemptedContent":suppressed["content"],"result":match result{Ok(v)=>json!({"accepted":v}),Err(_)=>json!({"rejected":true})}});
    }
    let Some(target) = selected else {
        return json!({"action":action,"ok":false,"reason":"No matching actual saved fact"});
    };
    let mut access = MemoryAccess {
        scope: scope.clone(),
        origin: MemoryOrigin::User,
        sources: vec![],
    };
    let mut change = json!({"action":"patch","scope":scope,"id":target["id"],"expectedRevision":target["revision"]});
    match action {
        "attachAndDeleteSource" => {
            let path = root.join("actual-source.txt");
            let content = target["content"].as_str().unwrap();
            std::fs::write(&path, content).unwrap();
            access.sources.push(MemorySource {
                kind: "file".into(),
                id: "actual-source".into(),
                scope: scope.clone(),
                label: "真实测试来源文件".into(),
                excerpt: content.into(),
                session_id: None,
                message_id: None,
                reference: None,
            });
            change["content"] = target["content"].clone();
            let result = db.memory_execute(
                &access,
                MemoryRequest::Apply {
                    request_id,
                    changes: vec![change],
                },
            );
            std::fs::remove_file(&path).unwrap();
            return json!({"action":action,"ok":result.is_ok()&&!path.exists(),"sourceExistsAfter":path.exists(),"result":result.ok(),"targetId":target["id"]});
        }
        "expireOld" => {
            change["validTo"] = json!("2020-01-01T00:00:00Z");
        }
        "organize" | "organizeAndRollback" => {
            access.origin = MemoryOrigin::Organization;
            change["content"] = step["content"].clone();
        }
        _ => return json!({"action":action,"ok":false,"reason":"Unknown native fixture action"}),
    }
    let result = db.memory_execute(
        &access,
        MemoryRequest::Apply {
            request_id,
            changes: vec![change],
        },
    );
    let Ok(result) = result else {
        return json!({"action":action,"ok":false,"reason":"Native mutation rejected"});
    };
    if action == "organizeAndRollback" {
        let start = std::time::Instant::now();
        let restored = db.memory_execute(
            &MemoryAccess {
                origin: MemoryOrigin::User,
                ..access
            },
            MemoryRequest::Rollback {
                request_id: format!("rollback-{index}"),
                rollback_id: result["receipt"].as_str().unwrap().into(),
            },
        );
        let ms = start.elapsed().as_millis();
        let after = facts(db, scope);
        let target_restored = after["facts"].as_array().unwrap().iter().any(|f| {
            f["id"] == target["id"]
                && f["content"] == target["content"]
                && f["condition"] == target["condition"]
                && f["locked"] == true
        });
        let independent_unchanged = active
            .iter()
            .filter(|f| f["id"] != target["id"])
            .all(|old| after["facts"].as_array().unwrap().contains(old));
        return json!({"action":action,"ok":restored.is_ok()&&target_restored&&independent_unchanged,"rollbackMs":ms,"before":list,"organized":result,"restored":restored.ok(),"targetRestored":target_restored,"independentUnchanged":independent_unchanged});
    }
    json!({"action":action,"ok":true,"before":target,"result":result})
}

async fn full_proxy(
    provider: &Value,
    network: crate::ai_network::ResolvedAiNetwork,
    output: PathBuf,
    exchanges: Arc<std::sync::Mutex<Vec<Value>>>,
) -> (String, tokio::task::JoinHandle<()>) {
    let endpoint = format!(
        "{}/chat/completions",
        provider["baseUrl"].as_str().unwrap().trim_end_matches('/')
    );
    let key = provider["apiKey"].as_str().unwrap().to_owned();
    let router=Router::new().route("/v1/chat/completions",post(move |Json(body):Json<Value>| {
        let (endpoint,key,network,output,exchanges)=(endpoint.clone(),key.clone(),network.clone(),output.clone(),exchanges.clone());
        async move {
            let request=body.clone();
            let (status,raw)=tokio::task::spawn_blocking(move || {
                let client=match crate::ai_network::client_builder(&network).and_then(|builder|Ok(builder.timeout(Duration::from_secs(180)).build()?)){Ok(client)=>client,Err(_)=>return (502,String::new())};
                match client.post(endpoint).bearer_auth(key).json(&request).send(){Ok(response)=>{let status=response.status().as_u16();(status,response.text().unwrap_or_default())},Err(_)=>(502,String::new())}
            }).await.unwrap_or((502,String::new()));
            let mut usage=Value::Null;let mut answer=String::new();
            if status==200 {for line in raw.lines().filter_map(|line|line.strip_prefix("data: ")){if let Ok(event)=serde_json::from_str::<Value>(line){if let Some(text)=event["choices"][0]["delta"]["content"].as_str(){answer.push_str(text);}if !event["usage"].is_null(){usage=event["usage"].clone();}}}}
            {let mut rows=crate::lock_mutex(&exchanges);rows.push(json!({"request":body,"httpStatus":status,"response":if status==200 {raw.as_str()}else{"upstream error redacted"},"answer":answer,"usage":usage}));save_json(&output,&json!(*rows));}
            (axum::http::StatusCode::from_u16(status).unwrap(),[("content-type","text/event-stream")],if status==200{raw}else{"upstream failed".into()})
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    (
        base,
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        }),
    )
}

async fn full_case(
    spec: Value,
    provider: Value,
    network: crate::ai_network::ResolvedAiNetwork,
    output: PathBuf,
) -> (String, Value) {
    let id = spec["id"].as_str().unwrap().to_owned();
    let saved = output.join(format!("{id}.complete.json"));
    if saved.exists() {
        return (
            id,
            serde_json::from_slice(&std::fs::read(saved).unwrap()).unwrap(),
        );
    }
    let family = spec["family"].as_str().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let mut db = crate::db::Database::open(&root.join("evaluation.sqlite"), &root, None).unwrap();
    let workspace_id = "00000000-0000-4000-8000-000000000001";
    db.bind_native_workspace(workspace_id).unwrap();
    let project_a = db
        .project_create(crate::models::ProjectCreateInput {
            name: "项目甲".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let project_b = db
        .project_create(crate::models::ProjectCreateInput {
            name: "项目乙".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let scope = if family == "isolation" {
        MemoryScope::Project {
            project_id: project_b.id,
        }
    } else {
        MemoryScope::Workspace
    };
    let context = if family == "isolation" {
        AssistantContext::Project(ProjectContext {
            id: project_b.id,
            name: project_b.name.clone(),
            directory: PathBuf::from(&project_b.root_path).canonicalize().unwrap(),
        })
    } else {
        AssistantContext::Workspace {
            directory: root.clone(),
        }
    };
    let binding = WorkspaceBinding {
        workspace_id: workspace_id.into(),
        generation: "real-full-evaluation".into(),
    };
    let identity = Identity {
        workspace_id: workspace_id.into(),
        workspace_generation: binding.generation.clone(),
        root: root.clone(),
        fingerprint: "evaluation".into(),
        context,
    };
    let database = Arc::new(std::sync::Mutex::new(db));
    let observed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let receipts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let captures = receipts.clone();
    let inject = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let injection = inject.clone();
    let inner = wrap(
        database.clone(),
        identity,
        binding,
        Arc::new(|_, _, _, _, _| Err("No source read permitted by this evaluation fixture".into())),
        observed,
    );
    let handler: SourceHandler = Arc::new(move |mut payload, revoked, url, frame, alive| {
        let requested = payload.clone();
        let fault = injection.load(Ordering::SeqCst) && payload["request"]["operation"] == "apply";
        if fault {
            payload["request"]["changes"] = json!([{"action":"patch","scope":{"kind":"workspace"},"id":"nonexistent-evaluation-fact","expectedRevision":1,"content":"must not save"}]);
        }
        let result = inner(payload, revoked, url, frame, alive);
        crate::lock_mutex(&captures).push(json!({"request":requested,"faultInjected":fault,"ok":result.is_ok(),"result":match &result{Ok(value)=>value.clone(),Err(_)=>json!({"error":"native mutation rejected"})}}));
        result
    });
    let exchanges = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (base, proxy) = full_proxy(
        &provider,
        network,
        output.join(format!("{id}.provider.json")),
        exchanges.clone(),
    )
    .await;
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
        .env("PROJECT_MIND_DSH_USER_DATA", root.join("runtime"))
        .env("PROJECT_MIND_DSH_PROFILE_DIR", root.join("profile"))
        .env("NO_PROXY", "localhost,127.0.0.1,::1")
        .env("no_proxy", "localhost,127.0.0.1,::1");
    let mut config = json!({"type":"configure","provider":provider});
    config["provider"]["baseUrl"] = json!(base);
    config["provider"]["apiKey"] = json!("local-recording-proxy");
    if family == "isolation" {
        config["project"] =
            json!({"id":project_b.id,"name":project_b.name,"directory":project_b.root_path});
    } else {
        config["workspace"] =
            json!({"id":workspace_id,"name":"Isolated real evaluation","directory":root});
    }
    let mut process = AssistantProcess::launch_with_source(command, &config, Some(handler))
        .await
        .unwrap();
    let session = rpc(&mut process, "session/create", json!({})).await["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut actions = Vec::new();
    let mut states = Vec::new();
    let mut user_turns = 0;
    for (index, step) in spec["setup"]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        if step["type"] == "dsh" {
            inject.store(
                step["injectNativeFailure"] == true || family == "failed_write",
                Ordering::SeqCst,
            );
            prompt(
                &mut process,
                &session,
                step["text"].as_str().unwrap(),
                &exchanges,
            )
            .await;
            user_turns += 1;
        } else if step["action"] == "seedForeign" {
            let foreign = MemoryScope::Project {
                project_id: project_a.id,
            };
            let value = native(
                &crate::lock_mutex(&database),
                &foreign,
                MemoryRequest::Apply {
                    request_id: "seed-foreign".into(),
                    changes: vec![
                        json!({"action":"add","scope":foreign,"category":"agreement","content":step["content"]}),
                    ],
                },
            );
            actions.push(json!({"action":"seedForeign","ok":true,"result":value}));
        } else {
            actions.push(full_native_step(
                &crate::lock_mutex(&database),
                &scope,
                &root,
                step,
                index,
            ));
        }
        states.push(facts(&crate::lock_mutex(&database), &scope));
        save_json(
            &output.join(format!("{id}.partial.json")),
            &json!({"id":id,"stepIndex":index,"actions":actions,"states":states,"bridge":*crate::lock_mutex(&receipts),"actualUserTurns":user_turns}),
        );
    }
    process.stop().await.unwrap();
    proxy.abort();
    let db = crate::lock_mutex(&database);
    let final_state = facts(&db, &scope);
    let bridge = crate::lock_mutex(&receipts).clone();
    let mut arms = serde_json::Map::new();
    for strategy in ["snapshot", "layered"] {
        let value = native(
            &db,
            &scope,
            MemoryRequest::Context {
                scope: scope.clone(),
                query: spec["request"].as_str().unwrap().into(),
                budget_chars: 6000,
                strategy: strategy.into(),
            },
        );
        let positive = value["facts"].to_string();
        let negative = value["suppressed"].to_string();
        let mut evidence = serde_json::Map::new();
        match family {
            "isolation" => {
                let foreign = spec["setup"]["steps"][0]["content"].as_str().unwrap();
                let foreign_fact = actions[0]["result"]["facts"][0]["id"]
                    .as_str()
                    .unwrap_or("");
                evidence.insert(
                    "isolated".into(),
                    json!(!positive.contains(foreign) && !positive.contains(foreign_fact)),
                );
            }
            "forget" | "independent_source" => {
                let probe = actions.iter().find(|a| a["action"] == "probeSuppression");
                evidence.insert(
                    "suppressionPreserved".into(),
                    json!(probe.is_some_and(|a| a["ok"] == true) && negative != "[]"),
                );
            }
            "failed_write" => {
                evidence.insert(
                    "writeReceiptTruthful".into(),
                    json!(
                        bridge
                            .iter()
                            .any(|r| r["faultInjected"] == true && r["ok"] == false)
                            && final_state["facts"].as_array().unwrap().is_empty()
                            && !bridge
                                .iter()
                                .any(|r| r["request"]["request"]["operation"] == "apply"
                                    && r["ok"] == true)
                    ),
                );
            }
            "source_removed" => {
                let action = actions
                    .iter()
                    .find(|a| a["action"] == "attachAndDeleteSource");
                evidence.insert(
                    "retainedConclusionAvailable".into(),
                    json!(action.is_some_and(|a| a["ok"] == true
                        && value["facts"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|f| f["id"] == a["targetId"]))),
                );
            }
            "rollback" => {
                let action = actions
                    .iter()
                    .find(|a| a["action"] == "organizeAndRollback");
                evidence.insert(
                    "restoredAndUnrelatedPreserved".into(),
                    json!(action.is_some_and(|a| a["ok"] == true)),
                );
                evidence.insert(
                    "rollbackMs".into(),
                    action
                        .map(|a| a["rollbackMs"].clone())
                        .unwrap_or(Value::Null),
                );
            }
            "confirmed_drift" => {
                let action = actions.iter().find(|a| a["action"] == "organize");
                evidence.insert(
                    "newVersionInferred".into(),
                    json!(action.is_some_and(|a| a["ok"] == true
                        && a["before"]["confirmation"] == "confirmed"
                        && a["result"]["facts"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .all(|f| f["confirmation"] == "inferred"))),
                );
            }
            "current" => {
                let action = actions.iter().find(|a| a["action"] == "expireOld");
                evidence.insert(
                    "validityRespected".into(),
                    json!(action.is_some_and(|a| a["ok"] == true
                        && !positive.contains(a["before"]["id"].as_str().unwrap()))),
                );
            }
            "history" => {
                evidence.insert(
                    "validityRespected".into(),
                    json!(spec["checks"]["required"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|pattern| pattern
                            .as_str()
                            .unwrap()
                            .split('|')
                            .any(|token| positive.contains(token)))),
                );
            }
            _ => {}
        }
        arms.insert(strategy.into(),json!({"context":json!({"facts":value["facts"],"negativeConstraints":value["suppressed"],"omittedIds":value["omittedIds"]}).to_string(),"evidence":evidence}));
    }
    let mut shared = spec["sharedMessages"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if family == "failed_write" {
        shared.push(json!({"role":"system","content":json!({"actualNativeMutationResults":bridge.iter().filter(|r|r["request"]["request"]["operation"]=="apply").map(|r|json!({"ok":r["ok"],"result":r["result"]})).collect::<Vec<_>>()}).to_string()}));
    }
    arms.insert("sharedMessages".into(), json!(shared));
    let result = json!({"fixture":arms,"sourceFingerprint":evaluation_source_fingerprint(),"toolCatalogConstraint":"none; production DSH tool catalog","id":id,"actualUserTurns":user_turns,"nativeActions":actions,"states":states,"finalState":final_state,"bridge":bridge,"setup":spec["setup"],"setupPassed":user_turns>=2&&actions.iter().all(|a|a["ok"]==true)});
    save_json(&saved, &result);
    (id, result)
}

#[tokio::test]
#[ignore = "Explicit full60 real Provider evaluation; never part of unit suite"]
async fn memory_real_model_full60() {
    use futures_util::StreamExt;
    let input: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("MEMORY_E2E_CONFIG").expect("config path required")).unwrap(),
    )
    .unwrap();
    let provider = input["provider"].clone();
    let network = crate::ai_network::ResolvedAiNetwork {
        mode: serde_json::from_value(
            input["network"]["mode"]
                .as_str()
                .map(|s| json!(s))
                .unwrap_or(json!("system")),
        )
        .unwrap(),
        proxy_url: input["network"]["proxyUrl"].as_str().map(str::to_owned),
    };
    let output = PathBuf::from(std::env::var("MEMORY_E2E_OUTPUT").expect("output required"));
    std::fs::create_dir_all(&output).unwrap();
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("scripts/memory-evaluation/scenarios.json");
    let scenarios: Vec<Value> = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let selected = std::env::var("MEMORY_E2E_ONLY").ok();
    let cases = scenarios
        .into_iter()
        .filter(|s| {
            selected
                .as_ref()
                .is_none_or(|ids| ids.split(',').any(|id| id == s["id"].as_str().unwrap()))
        })
        .collect::<Vec<_>>();
    let mut stream = futures_util::stream::iter(
        cases
            .into_iter()
            .map(|spec| full_case(spec, provider.clone(), network.clone(), output.clone())),
    )
    .buffer_unordered(2);
    let mut fixtures = serde_json::Map::new();
    let mut summary = Vec::new();
    while let Some((id, result)) = stream.next().await {
        fixtures.insert(id.clone(), result["fixture"].clone());
        summary.push(json!({"id":id,"setupPassed":result["setupPassed"],"actualUserTurns":result["actualUserTurns"]}));
        save_json(
            &output.join("native-full-fixtures.json"),
            &json!({"provenance":{"kind":"native","revision":std::env::var("MEMORY_E2E_REVISION").unwrap_or_else(|_|"uncommitted-real-evaluation".into()),"command":"cargo test memory_real_model_full60 -- --ignored --nocapture","realConversationExecution":true,"organizationMode":"explicit native fixture operations; organization Provider usage not measured"},"cases":fixtures}),
        );
        save_json(
            &output.join("setup-summary.json"),
            &json!({"completed":summary.len(),"cases":summary,"defaultStrategy":"snapshot","launchGate":"not-evaluated"}),
        );
    }
}

fn evaluation_source_fingerprint() -> Value {
    use sha2::{Digest, Sha256};
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let native_files: [(&str, &[u8]); 7] = [
        (
            "src-tauri/src/dsh_memory.rs",
            include_bytes!("dsh_memory.rs"),
        ),
        (
            "src-tauri/src/dsh_memory_integration_tests.rs",
            include_bytes!("dsh_memory_integration_tests.rs"),
        ),
        (
            "src-tauri/src/dsh_memory_model_evaluation.rs",
            include_bytes!("dsh_memory_model_evaluation.rs"),
        ),
        (
            "src-tauri/src/db/memory_facts.rs",
            include_bytes!("db/memory_facts.rs"),
        ),
        (
            "src-tauri/src/db/memory_facts_store.rs",
            include_bytes!("db/memory_facts_store.rs"),
        ),
        (
            "src-tauri/src/memory_behavior.rs",
            include_bytes!("memory_behavior.rs"),
        ),
        (
            "packages/dsh-assistant/skills/project-mind-memory/SKILL.md",
            include_bytes!("../../packages/dsh-assistant/skills/project-mind-memory/SKILL.md"),
        ),
    ];
    let mut hashes = serde_json::Map::new();
    for (file, bytes) in native_files {
        hashes.insert(
            file.into(),
            json!({"kind":"compiled-native","sha256":format!("{:x}",Sha256::digest(bytes))}),
        );
    }
    let file = "packages/dsh-assistant/scripts/memory-service.mjs";
    if let Ok(bytes) = std::fs::read(root.join(file)) {
        hashes.insert(file.into(),json!({"kind":"runtime-source-observed-at-completion","sha256":format!("{:x}",Sha256::digest(bytes))}));
    }
    json!(hashes)
}
