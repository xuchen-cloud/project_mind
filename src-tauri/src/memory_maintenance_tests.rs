use super::*;
use crate::agent::settings::{SettingsRepository, SettingsUpdate};
use crate::overview_model::{GeneratedOverview, OverviewBudget};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Mutex,
};
struct Store {
    db: Mutex<Database>,
    root: tempfile::TempDir,
    binding: WorkspaceBinding,
    busy: AtomicBool,
}
impl MaintenanceStore for Store {
    fn current<T>(
        &self,
        binding: &WorkspaceBinding,
        action: impl FnOnce(&Database, &Path) -> AgentResult<T>,
    ) -> AgentResult<T> {
        if binding != &self.binding {
            return Err(AgentError::new(ErrorCode::WorkspaceChanged, "changed"));
        }
        action(&self.db.lock().unwrap(), self.root.path())
    }
    async fn foreground_busy(&self, _: &WorkspaceBinding) -> AgentResult<bool> {
        Ok(self.busy.load(Ordering::SeqCst))
    }
}
struct Model {
    calls: AtomicUsize,
    response: String,
}
impl OverviewModel for Model {
    async fn generate(
        &self,
        _: &str,
        prompt: &str,
        budget: &OverviewBudget,
    ) -> AgentResult<GeneratedOverview> {
        budget.check(prompt)?;
        assert!(prompt.contains("## 记忆行为"));
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(GeneratedOverview {
            text: self.response.clone(),
            model_profile_id: "test-profile".into(),
            usage: json!({"inputTokens":111,"outputTokens":22}),
        })
    }
}
fn fixture() -> (Store, Value) {
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(&root.path().join("memory.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace("memory-maintenance").unwrap();
    let mut settings = db.agent_settings_get(&Scope::Workspace).unwrap();
    settings.enabled = true;
    db.agent_settings_update(
        "gui",
        "enable",
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
    let added=db.memory_execute(&user,MemoryRequest::Apply{request_id:"seed".into(),changes:vec![json!({"action":"add","scope":{"kind":"workspace"},"category":"preference","content":"Prefer concise Chinese","condition":"product discussions"})]}).unwrap();
    let fact = added["facts"][0].clone();
    (
        Store {
            db: Mutex::new(db),
            root,
            binding: WorkspaceBinding {
                workspace_id: "memory-maintenance".into(),
                generation: "one".into(),
            },
            busy: AtomicBool::new(false),
        },
        fact,
    )
}
fn model(fact: &Value) -> Model {
    Model{calls:AtomicUsize::new(0),response:json!({"changes":[{"action":"patch","scope":{"kind":"workspace"},"id":fact["id"],"expectedRevision":fact["revision"],"content":"产品讨论中使用简洁中文"}]}).to_string()}
}
fn status(store: &Store) -> MaintenanceRun {
    store
        .db
        .lock()
        .unwrap()
        .memory_maintenance_status(&store.binding, &Scope::Workspace)
        .unwrap()
        .unwrap()
}
#[tokio::test]
async fn scheduled_without_source_dirty_uses_real_store_and_records_usage_once() {
    let (store, fact) = fixture();
    let model = model(&fact);
    let now = Utc::now();
    assert_eq!(
        store
            .db
            .lock()
            .unwrap()
            .memory_maintenance_next(&store.binding, now)
            .unwrap(),
        Some(Scope::Workspace)
    );
    assert!(step(&store, &store.binding, &Scope::Workspace, &model, now)
        .await
        .unwrap());
    let run = status(&store);
    assert_eq!(run.phase, "completed");
    assert_eq!(run.usage.unwrap()["inputTokens"], 111);
    let receipt = run.receipt.unwrap();
    assert_eq!(receipt["facts"][0]["confirmation"], "inferred");
    assert_eq!(receipt["facts"][0]["condition"], "product discussions");
    assert!(
        !step(&store, &store.binding, &Scope::Workspace, &model, now)
            .await
            .unwrap()
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn approval_mode_creates_proposal_and_foreground_defers_generation() {
    let (store, fact) = fixture();
    let model = model(&fact);
    store
        .db
        .lock()
        .unwrap()
        .memory_execute(
            &MemoryAccess {
                origin: MemoryOrigin::User,
                ..access(&Scope::Workspace)
            },
            MemoryRequest::Settings {
                require_approval: true,
            },
        )
        .unwrap();
    store.busy.store(true, Ordering::SeqCst);
    assert_eq!(
        step(
            &store,
            &store.binding,
            &Scope::Workspace,
            &model,
            Utc::now()
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::RunBusy
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 0);
    store.busy.store(false, Ordering::SeqCst);
    step(
        &store,
        &store.binding,
        &Scope::Workspace,
        &model,
        Utc::now(),
    )
    .await
    .unwrap();
    assert_eq!(status(&store).receipt.unwrap()["pending"], true);
}
#[tokio::test]
async fn prepared_replay_reuses_idempotent_apply_and_does_not_generate() {
    let (store, fact) = fixture();
    let model = model(&fact);
    let now = Utc::now();
    let mut run = MaintenanceRun {
        id: "a".repeat(32),
        scope: Scope::Workspace,
        started_at: now,
        due_at: now + chrono::Duration::days(1),
        phase: "prepared".into(),
        behavior_revision: "r".into(),
        facts: vec![fact],
        suppressed: vec![],
        settings_revision: 1,
        response: Some(model.response.clone()),
        usage: Some(json!({"inputTokens":10})),
        model_profile_id: Some("saved-profile".into()),
        receipt: None,
        error: None,
    };
    let delta = changes(&run).unwrap();
    {
        let db = store.db.lock().unwrap();
        db.memory_maintenance_save(&store.binding, &run).unwrap();
        // Simulate crash after atomic apply but before ledger completion.
        db.memory_execute(
            &access(&Scope::Workspace),
            MemoryRequest::Apply {
                request_id: format!("memory-organization-{}", run.id),
                changes: delta,
            },
        )
        .unwrap();
        // A later explicit forget must not hide the already committed receipt
        // or cause a second organization mutation during crash recovery.
        db.memory_execute(&MemoryAccess{origin:MemoryOrigin::User,..access(&Scope::Workspace)},MemoryRequest::Apply{request_id:"forget-after-commit".into(),changes:vec![json!({"action":"forget","scope":{"kind":"workspace"},"id":run.facts[0]["id"],"expectedRevision":2})]}).unwrap();
    }
    step(&store, &store.binding, &Scope::Workspace, &model, now)
        .await
        .unwrap();
    run = status(&store);
    assert_eq!(run.phase, "completed");
    assert_eq!(run.receipt.unwrap()["facts"][0]["revision"], 2);
    assert_eq!(model.calls.load(Ordering::SeqCst), 0);
    let current = store
        .db
        .lock()
        .unwrap()
        .memory_execute(
            &access(&Scope::Workspace),
            MemoryRequest::List {
                scope: MemoryScope::Workspace,
                include_inactive: true,
            },
        )
        .unwrap();
    assert_eq!(current["facts"][0]["state"], "forgotten");
    assert_eq!(current["facts"][0]["revision"], 3);
}
#[tokio::test]
async fn stale_revision_fails_cycle_and_cannot_overwrite_user_edit() {
    let (store, fact) = fixture();
    let model = model(&fact);
    let now = Utc::now();
    let run = MaintenanceRun {
        id: "b".repeat(32),
        scope: Scope::Workspace,
        started_at: now,
        due_at: now + chrono::Duration::days(1),
        phase: "prepared".into(),
        behavior_revision: "r".into(),
        facts: vec![fact.clone()],
        suppressed: vec![],
        settings_revision: 1,
        response: Some(model.response.clone()),
        usage: Some(json!({"inputTokens":10})),
        model_profile_id: None,
        receipt: None,
        error: None,
    };
    {
        let db = store.db.lock().unwrap();
        db.memory_maintenance_save(&store.binding, &run).unwrap();
        db.memory_execute(&MemoryAccess{origin:MemoryOrigin::User,..access(&Scope::Workspace)},MemoryRequest::Apply{request_id:"user-edit".into(),changes:vec![json!({"action":"patch","scope":{"kind":"workspace"},"id":fact["id"],"expectedRevision":fact["revision"],"content":"later edit"})]}).unwrap();
    }
    assert!(step(&store, &store.binding, &Scope::Workspace, &model, now)
        .await
        .is_err());
    assert_eq!(status(&store).phase, "failed");
    assert!(status(&store)
        .error
        .unwrap()
        .contains("Memory revision conflict"));
    assert!(
        !step(&store, &store.binding, &Scope::Workspace, &model, now)
            .await
            .unwrap()
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn model_cannot_add_facts_or_cross_scope_and_failure_is_inspectable() {
    let (store, _) = fixture();
    let model=Model{calls:AtomicUsize::new(0),response:json!({"changes":[{"action":"add","scope":{"kind":"workspace"},"category":"preference","content":"invented"}]}).to_string()};
    assert!(step(
        &store,
        &store.binding,
        &Scope::Workspace,
        &model,
        Utc::now()
    )
    .await
    .is_err());
    let run = status(&store);
    assert_eq!(run.phase, "failed");
    assert!(run.error.unwrap().contains("only accepts patch or merge"));
    assert!(run.usage.is_some());
}

#[tokio::test]
async fn rotates_bounded_facts_across_scheduled_cycles() {
    let (store, _) = fixture();
    {
        let db = store.db.lock().unwrap();
        let changes=(0..60).map(|index|json!({"action":"add","scope":{"kind":"workspace"},"category":"preference","content":format!("Independent preference {index}")})).collect();
        db.memory_execute(
            &MemoryAccess {
                origin: MemoryOrigin::User,
                ..access(&Scope::Workspace)
            },
            MemoryRequest::Apply {
                request_id: "many-facts".into(),
                changes,
            },
        )
        .unwrap();
    }
    let model = Model {
        calls: AtomicUsize::new(0),
        response: "{\"changes\":[]}".into(),
    };
    let mut now = Utc::now();
    let mut seen = std::collections::HashSet::new();
    for _ in 0..5 {
        step(&store, &store.binding, &Scope::Workspace, &model, now)
            .await
            .unwrap();
        let run = status(&store);
        assert!(run.facts.len() <= 50);
        seen.extend(
            run.facts
                .iter()
                .map(|f| f["id"].as_str().unwrap().to_owned()),
        );
        now = run.due_at + chrono::Duration::seconds(1);
    }
    assert_eq!(seen.len(), 61);
}
#[tokio::test]
async fn suppression_is_persisted_and_included_without_truncation() {
    let (store, fact) = fixture();
    {
        let db = store.db.lock().unwrap();
        let user = MemoryAccess {
            origin: MemoryOrigin::User,
            ..access(&Scope::Workspace)
        };
        db.memory_execute(&user,MemoryRequest::Apply{request_id:"forget".into(),changes:vec![json!({"action":"forget","scope":{"kind":"workspace"},"id":fact["id"],"expectedRevision":fact["revision"]})]}).unwrap();
        db.memory_execute(&user,MemoryRequest::Apply{request_id:"other".into(),changes:vec![json!({"action":"add","scope":{"kind":"workspace"},"category":"background","content":"An independent fact"})]}).unwrap();
    }
    struct SuppressionModel;
    impl OverviewModel for SuppressionModel {
        async fn generate(
            &self,
            _: &str,
            prompt: &str,
            _: &OverviewBudget,
        ) -> AgentResult<GeneratedOverview> {
            assert!(prompt.contains("持久抑制约束"));
            assert!(prompt.contains("Prefer concise Chinese"));
            assert!(prompt.contains("product discussions"));
            Ok(GeneratedOverview {
                text: "{\"changes\":[]}".into(),
                usage: json!({}),
                model_profile_id: "test".into(),
            })
        }
    }
    step(
        &store,
        &store.binding,
        &Scope::Workspace,
        &SuppressionModel,
        Utc::now(),
    )
    .await
    .unwrap();
    assert_eq!(status(&store).suppressed.len(), 1);
    let long = vec![json!({"content":"x".repeat(30_000)})];
    let text = prompt("Skill", &[], &long).unwrap();
    assert!(text.len() > 30_000);
}
#[tokio::test]
async fn schedule_edit_retimes_existing_completed_cycle_using_workspace_settings() {
    let (store, _) = fixture();
    let model = Model {
        calls: AtomicUsize::new(0),
        response: "{\"changes\":[]}".into(),
    };
    let now = Utc::now();
    step(&store, &store.binding, &Scope::Workspace, &model, now)
        .await
        .unwrap();
    let original = status(&store);
    {
        let db = store.db.lock().unwrap();
        let mut settings = db.agent_settings_get(&Scope::Workspace).unwrap();
        settings.overview_interval_hours = 48;
        settings.overview_local_time = "04:17".into();
        settings.overview_timezone = "Asia/Shanghai".into();
        db.agent_settings_update(
            "gui",
            "new-schedule",
            &SettingsUpdate {
                expected_revision: settings.revision,
                settings,
            },
        )
        .unwrap();
    }
    let retimed = status(&store);
    assert_ne!(original.due_at, retimed.due_at);
    assert!(retimed.settings_revision > original.settings_revision);
    assert_eq!(
        retimed.due_at,
        store
            .db
            .lock()
            .unwrap()
            .memory_maintenance_due_at(&Scope::Workspace, now)
            .unwrap()
    );
}

#[tokio::test]
async fn newly_forgotten_fact_invalidates_prepared_semantic_work() {
    let (store, fact) = fixture();
    let model = Model {
        calls: AtomicUsize::new(0),
        response: "{\"changes\":[]}".into(),
    };
    let now = Utc::now();
    step(&store, &store.binding, &Scope::Workspace, &model, now)
        .await
        .unwrap();
    let mut run = status(&store);
    run.phase = "prepared".into();
    run.receipt = None;
    {
        let db = store.db.lock().unwrap();
        db.memory_maintenance_save(&store.binding, &run).unwrap();
        db.memory_execute(&MemoryAccess{origin:MemoryOrigin::User,..access(&Scope::Workspace)},MemoryRequest::Apply{request_id:"forget-after-generation".into(),changes:vec![json!({"action":"forget","scope":{"kind":"workspace"},"id":fact["id"],"expectedRevision":fact["revision"]})]}).unwrap();
    }
    let failure = step(&store, &store.binding, &Scope::Workspace, &model, now)
        .await
        .unwrap_err();
    assert_eq!(failure.code, ErrorCode::SourceChanged);
    assert!(failure.message.contains("suppression changed"));
    assert_eq!(status(&store).phase, "failed");
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn interrupted_generation_ends_cycle_without_another_provider_call() {
    let (store, _) = fixture();
    let model = Model {
        calls: AtomicUsize::new(0),
        response: "{\"changes\":[]}".into(),
    };
    let now = Utc::now();
    step(&store, &store.binding, &Scope::Workspace, &model, now)
        .await
        .unwrap();
    let mut run = status(&store);
    run.phase = "generating".into();
    run.response = None;
    run.usage = None;
    run.receipt = None;
    store
        .db
        .lock()
        .unwrap()
        .memory_maintenance_save(&store.binding, &run)
        .unwrap();
    assert!(step(&store, &store.binding, &Scope::Workspace, &model, now)
        .await
        .unwrap());
    assert_eq!(status(&store).phase, "failed");
    assert!(status(&store).error.unwrap().contains("Interrupted"));
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    assert!(
        !step(&store, &store.binding, &Scope::Workspace, &model, now)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn schedule_helpers_preserve_unrelated_settings_cas_and_redact_status() {
    let (store, fact) = fixture();
    let model = model(&fact);
    step(
        &store,
        &store.binding,
        &Scope::Workspace,
        &model,
        Utc::now(),
    )
    .await
    .unwrap();
    let db = store.db.lock().unwrap();
    let before = db.agent_settings_get(&Scope::Workspace).unwrap();
    let view = save_schedule(
        &db,
        &store.binding,
        &Scope::Workspace,
        MemoryScheduleUpdate {
            enabled: true,
            interval_hours: 48,
            local_time: "05:30".into(),
            timezone: "Asia/Shanghai".into(),
            expected_revision: before.revision,
        },
    )
    .unwrap();
    let after = db.agent_settings_get(&Scope::Workspace).unwrap();
    assert_eq!(before.summary_policy, after.summary_policy);
    assert_eq!(before.execution_mode, after.execution_mode);
    assert_eq!(before.pinned_refs, after.pinned_refs);
    assert_eq!(before.goal_record_id, after.goal_record_id);
    assert_eq!(view.interval_hours, 48);
    assert_eq!(
        save_schedule(
            &db,
            &store.binding,
            &Scope::Workspace,
            MemoryScheduleUpdate {
                enabled: false,
                interval_hours: 24,
                local_time: "03:00".into(),
                timezone: "UTC".into(),
                expected_revision: before.revision
            }
        )
        .err()
        .unwrap()
        .code,
        ErrorCode::RevisionConflict
    );
    let serialized = serde_json::to_string(&view).unwrap();
    assert!(!serialized.contains("产品讨论"));
    assert!(!serialized.contains("facts"));
    assert!(!serialized.contains("response"));
    assert!(save_schedule(
        &db,
        &store.binding,
        &Scope::Workspace,
        MemoryScheduleUpdate {
            enabled: true,
            interval_hours: 168,
            local_time: "03:00".into(),
            timezone: "UTC".into(),
            expected_revision: after.revision
        }
    )
    .is_err());
}
