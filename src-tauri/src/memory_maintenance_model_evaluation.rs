//! Explicit remote-Provider acceptance. Never runs in the ordinary test suite.
use super::*;
use crate::{
    agent::settings::{SettingsRepository, SettingsUpdate},
    ai_provider::ResolvedAiProfile,
    dsh_model::ModelRuntime,
    overview_model::{GeneratedOverview, OverviewBudget, MAX_OVERVIEW_INPUT_BYTES},
};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
    time::Duration,
};
use tokio::time::Instant;

struct RemoteModel {
    runtime: ModelRuntime,
    profile: ResolvedAiProfile,
    capacity_calls: AtomicUsize,
    generation_calls: AtomicUsize,
}
impl Drop for RemoteModel {
    fn drop(&mut self) {
        self.profile.api_key.clear();
    }
}
fn incompatible() -> AgentError {
    AgentError::new(
        ErrorCode::RuntimeIncompatible,
        "Remote model acceptance response is incompatible",
    )
}
fn positive(data: &Value, key: &str) -> AgentResult<usize> {
    data[key]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .filter(|n| *n > 0)
        .ok_or_else(incompatible)
}
impl OverviewModel for RemoteModel {
    async fn prepare(&self) -> AgentResult<OverviewBudget> {
        self.capacity_calls.fetch_add(1, Ordering::SeqCst);
        let mut profile = self.profile.clone();
        profile.api_key.clear();
        let capacity = self
            .runtime
            .call(
                "capacity",
                &mut profile,
                json!({}),
                Instant::now() + Duration::from_secs(60),
                None,
            )
            .await?;
        // Same capacity constraints as AppOverviewModel; every value comes from
        // the production runtime response, not a test-supplied capacity stub.
        let input_bytes = positive(&capacity, "inputBytes")?;
        let output_tokens = positive(&capacity, "outputTokens")?;
        let context_window = positive(&capacity, "contextWindow")?;
        let max_tokens = positive(&capacity, "maxTokens")?;
        if input_bytes > MAX_OVERVIEW_INPUT_BYTES
            || output_tokens > 4096
            || output_tokens > max_tokens
            || output_tokens > context_window / 4
            || input_bytes > context_window.saturating_sub(output_tokens)
        {
            return Err(incompatible());
        }
        let source = capacity["source"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(incompatible)?
            .to_owned();
        Ok(OverviewBudget {
            input_bytes,
            context_window,
            max_tokens,
            fingerprint: "remote-acceptance".into(),
            source,
        })
    }
    async fn generate(
        &self,
        batch_id: &str,
        prompt: &str,
        budget: &OverviewBudget,
    ) -> AgentResult<GeneratedOverview> {
        if batch_id.len() != 32
            || !batch_id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || prompt.trim().is_empty()
        {
            return Err(incompatible());
        }
        budget.check(prompt)?;
        self.generation_calls.fetch_add(1, Ordering::SeqCst);
        let mut profile = self.profile.clone();
        let result=self.runtime.call("generate",&mut profile,json!({"prompt":prompt,"capacity":{"contextWindow":budget.context_window,"maxTokens":budget.max_tokens,"source":budget.source}}),Instant::now()+Duration::from_secs(60),None).await?;
        let text = result["text"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(incompatible)?;
        if text.chars().count() > 24_000 {
            return Err(AgentError::new(
                ErrorCode::BudgetExceeded,
                "Remote organization output exceeds budget",
            ));
        }
        let usage = result
            .get("usage")
            .filter(|u| u.is_object())
            .cloned()
            .ok_or_else(incompatible)?;
        Ok(GeneratedOverview {
            text: text.into(),
            usage,
            model_profile_id: budget.fingerprint.clone(),
        })
    }
}
struct Store {
    db: Mutex<Database>,
    root: tempfile::TempDir,
    binding: WorkspaceBinding,
}
impl MaintenanceStore for Store {
    fn current<T>(
        &self,
        binding: &WorkspaceBinding,
        action: impl FnOnce(&Database, &Path) -> AgentResult<T>,
    ) -> AgentResult<T> {
        if binding != &self.binding {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Evaluation Workspace changed",
            ));
        }
        action(&self.db.lock().unwrap(), self.root.path())
    }
    async fn foreground_busy(&self, _: &WorkspaceBinding) -> AgentResult<bool> {
        Ok(false)
    }
}
fn report(path: &Path, value: &Value) {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    fs::create_dir_all(path.parent().unwrap()).expect("create restricted report directory");
    fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o700)).unwrap();
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .expect("open restricted report");
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .unwrap();
    file.write_all(&serde_json::to_vec_pretty(value).unwrap())
        .unwrap();
    file.sync_all().unwrap();
}
fn field(provider: &Value, key: &str) -> String {
    provider[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .expect("configured Provider field required")
        .into()
}

#[tokio::test]
#[ignore = "Explicit remote Provider: MEMORY_E2E_CONFIG and MEMORY_E2E_OUTPUT required"]
async fn memory_background_real_model_organization_and_rollback() {
    let config_path = std::env::var("MEMORY_E2E_CONFIG").expect("MEMORY_E2E_CONFIG required");
    let output =
        PathBuf::from(std::env::var("MEMORY_E2E_OUTPUT").expect("MEMORY_E2E_OUTPUT required"));
    assert!(
        output.starts_with("/tmp") || output.starts_with("/private/tmp"),
        "acceptance output must stay in temporary storage"
    );
    let report_path = output.join("background-organization.json");
    let input: Value =
        serde_json::from_slice(&fs::read(config_path).expect("read private Provider config"))
            .expect("parse private Provider config");
    let provider = &input["provider"];
    let base_url = field(provider, "baseUrl");
    let url = reqwest::Url::parse(&base_url).expect("valid configured Provider URL");
    assert_eq!(url.scheme(), "https", "real remote Provider requires HTTPS");
    assert!(
        url.username().is_empty() && url.password().is_none(),
        "credentials must use apiKey"
    );
    let profile = ResolvedAiProfile {
        profile_name: "remote-acceptance".into(),
        provider_family: provider["providerFamily"]
            .as_str()
            .unwrap_or("openai_compatible")
            .into(),
        base_url,
        api_key: field(provider, "apiKey"),
        model: field(provider, "modelId"),
        supports_text: true,
        supports_image: false,
        network: crate::ai_network::ResolvedAiNetwork {
            mode: serde_json::from_value(
                input["network"]["mode"]
                    .as_str()
                    .map(|s| json!(s))
                    .unwrap_or(json!("system")),
            )
            .expect("valid network mode"),
            proxy_url: input["network"]["proxyUrl"].as_str().map(str::to_owned),
        },
    };
    let resources = std::env::var_os("MEMORY_E2E_RESOURCES")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"));
    let runtime = ModelRuntime::bundled(&resources)
        .expect("verified staged production ModelRuntime resources required");
    let model = RemoteModel {
        runtime,
        profile,
        capacity_calls: AtomicUsize::new(0),
        generation_calls: AtomicUsize::new(0),
    };
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(&root.path().join("memory.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace("real-background-acceptance")
        .unwrap();
    let mut settings = db.agent_settings_get(&Scope::Workspace).unwrap();
    settings.enabled = true;
    db.agent_settings_update(
        "gui",
        "enable-background-acceptance",
        &SettingsUpdate {
            expected_revision: settings.revision,
            settings,
        },
    )
    .unwrap();
    let user = MemoryAccess {
        scope: MemoryScope::Workspace,
        origin: MemoryOrigin::User,
        sources: vec![],
    };
    let condition = "仅在项目复盘讨论中";
    let seeded=db.memory_execute(&user,MemoryRequest::Apply{request_id:"seed-real-organization".into(),changes:vec![
        json!({"action":"add","scope":{"kind":"workspace"},"category":"preference","content":"用户希望先用简洁中文给出结论，再解释原因。","condition":condition}),
        json!({"action":"add","scope":{"kind":"workspace"},"category":"preference","content":"用户偏好简洁的中文表达，先说结论再说明理由。","condition":condition}),
        json!({"action":"add","scope":{"kind":"workspace"},"category":"method","content":"会议纪要中的日期采用 YYYY-MM-DD 格式。","condition":"记录会议日期时"}),
    ]}).unwrap();
    let before = seeded["facts"].as_array().unwrap().clone();
    let independent = before
        .iter()
        .find(|f| f["category"] == "method")
        .unwrap()
        .clone();
    let pair: Vec<Value> = before
        .iter()
        .filter(|f| f["category"] == "preference")
        .cloned()
        .collect();
    let store = Store {
        db: Mutex::new(db),
        root,
        binding: WorkspaceBinding {
            workspace_id: "real-background-acceptance".into(),
            generation: "one".into(),
        },
    };
    let execution = step(
        &store,
        &store.binding,
        &Scope::Workspace,
        &model,
        Utc::now(),
    )
    .await;
    let db = store.db.lock().unwrap();
    let run = db
        .memory_maintenance_status(&store.binding, &Scope::Workspace)
        .unwrap()
        .expect("persisted real organization cycle");
    let after = db
        .memory_execute(
            &user,
            MemoryRequest::List {
                scope: MemoryScope::Workspace,
                include_inactive: true,
            },
        )
        .unwrap()["facts"]
        .as_array()
        .unwrap()
        .clone();
    let usage = run.usage.clone().unwrap_or(Value::Null);
    let actual_tokens = usage["inputTokens"].as_u64().unwrap_or(0)
        + usage["cacheReadTokens"].as_u64().unwrap_or(0)
        + usage["cacheWriteTokens"].as_u64().unwrap_or(0);
    let survivor = after.iter().find(|f| {
        f["category"] == "preference" && f["state"] == "active" && f["confirmation"] == "inferred"
    });
    let merged = after
        .iter()
        .filter(|f| f["category"] == "preference" && f["state"] == "superseded")
        .count()
        == 1;
    let unchanged = after.iter().find(|f| f["id"] == independent["id"]) == Some(&independent);
    let preserved = after
        .iter()
        .filter(|f| f["category"] == "preference")
        .all(|f| f["condition"] == condition);
    let rollback_id = survivor.and_then(|f| f["rollbackId"].as_str());
    let rollback = rollback_id.map(|id| {
        db.memory_execute(
            &user,
            MemoryRequest::Rollback {
                request_id: "rollback-real-organization".into(),
                rollback_id: id.into(),
            },
        )
    });
    let restored = db
        .memory_execute(
            &user,
            MemoryRequest::List {
                scope: MemoryScope::Workspace,
                include_inactive: true,
            },
        )
        .unwrap()["facts"]
        .as_array()
        .unwrap()
        .clone();
    let restored_pair = pair.iter().all(|old| {
        restored.iter().any(|f| {
            f["id"] == old["id"]
                && f["content"] == old["content"]
                && f["condition"] == old["condition"]
                && f["confirmation"] == old["confirmation"]
                && f["state"] == "active"
                && f["locked"] == true
                && f["revision"].as_u64() > old["revision"].as_u64()
        })
    });
    let unrelated_restored =
        restored.iter().find(|f| f["id"] == independent["id"]) == Some(&independent);
    let rollback_json = match &rollback {
        Some(Ok(value)) => value.clone(),
        Some(Err(reason)) => json!({"error":reason}),
        None => Value::Null,
    };
    let silent = run.receipt.as_ref().is_some_and(|r| r["pending"] == false);
    let checks = json!({"executionSucceeded":execution.is_ok(),"silentInferred":silent && survivor.is_some(),"duplicateMerged":merged,"conditionPreserved":preserved,"actualTokenUsage":actual_tokens>0 && usage["outputTokens"].as_u64().unwrap_or(0)>0,"independentUnchanged":unchanged,"rollbackWithin24Hours":rollback.as_ref().is_some_and(|r|r.is_ok()),"restoredBothOriginalFactsAndLocked":restored_pair,"independentUnchangedAfterRollback":unrelated_restored});
    let passed = checks
        .as_object()
        .unwrap()
        .values()
        .all(|value| value == true);
    report(
        &report_path,
        &json!({"schemaVersion":1,"passed":passed,"executedAt":Utc::now(),"path":"production memory_maintenance::step -> ModelRuntime::call capacity/generate -> native memory_execute organization/apply -> native rollback","backgroundOrganizationUsage":usage,"actualGenerationCalls":model.generation_calls.load(Ordering::SeqCst),"actualCapacityCalls":model.capacity_calls.load(Ordering::SeqCst),"checks":checks,"before":before,"after":after,"receipt":run.receipt,"modelOutput":run.response,"rollback":rollback_json,"restored":restored,"error":execution.err().map(|e|format!("{:?}: {}",e.code,e.message))}),
    );
    assert!(passed,"Real background organization acceptance did not pass; inspect restricted report (no synthetic changes substituted)");
}
