use super::*;
use crate::{
    agent::settings::SettingsUpdate,
    committed_changes::{CommittedChangePublisher, CommittedChanges},
    models::{
        ProjectCreateInput, ProjectIdInput, TodoCreateInput, TodoScope, TodoUpdateContentInput,
    },
    record_document_service::DocumentUtility,
    source_service::{SourcePolicyUpdate, SourceService},
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};

struct Store {
    binding: WorkspaceBinding,
    db: Mutex<Database>,
}
impl CommittedChangePublisher for Store {
    fn publish_committed(&self, _: CommittedChanges) {}
}
impl BoundSourceStore for Store {
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        action(&self.binding, &self.db.lock().unwrap())
    }
}
struct NoUtility;
impl DocumentUtility for NoUtility {
    async fn request(
        &self,
        _: &str,
        method: &str,
        data: serde_json::Value,
    ) -> AgentResult<serde_json::Value> {
        // Project creation stores a legacy HTML QuickNote. SourceService reads
        // its committed bytes through the same canonical read-only conversion
        // boundary used in production; this fixture has one fixed paragraph.
        assert_eq!(method, "record.initialize");
        let text = "用户原始 QuickNote 不变";
        let html = data["html"].as_str().unwrap();
        assert!(html.contains(text));
        let document = serde_json::json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"content":[{"type":"text","text":text}]}]});
        let projection = crate::record_documents::RecordDocumentProjection {
            schema_version: 1,
            body_hash: crate::record_documents::body_hash(&document, &None),
            document,
            html: html.into(),
            markdown: text.into(),
            text: text.into(),
            code_language: None,
        };
        projection.validate()?;
        Ok(serde_json::to_value(projection).unwrap())
    }
}
impl SourceUtility for NoUtility {
    async fn request(&self, _: &str, _: &str, _: &str, _: &[u8]) -> AgentResult<serde_json::Value> {
        panic!("native Todo and QuickNote must not invoke File conversion")
    }
}
struct MockModel {
    response: Mutex<String>,
    fail: Mutex<Option<ErrorCode>>,
    prompts: Mutex<Vec<String>>,
    batch_ids: Mutex<Vec<String>>,
    calls: AtomicUsize,
}
impl MockModel {
    fn new() -> Self {
        Self {
            response: Mutex::new(r#"{"upsertItems":[],"removeItemIds":[]}"#.into()),
            fail: Mutex::new(None),
            prompts: Mutex::new(vec![]),
            batch_ids: Mutex::new(vec![]),
            calls: AtomicUsize::new(0),
        }
    }
    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
    fn set_response(&self, response: &str) {
        *self.response.lock().unwrap() = response.into();
    }
}
impl OverviewModel for MockModel {
    async fn generate(
        &self,
        batch_id: &str,
        prompt: &str,
    ) -> AgentResult<crate::overview_model::GeneratedOverview> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.prompts.lock().unwrap().push(prompt.into());
        self.batch_ids.lock().unwrap().push(batch_id.into());
        if let Some(code) = *self.fail.lock().unwrap() {
            return Err(AgentError::new(code, "mock model failed"));
        }
        Ok(crate::overview_model::GeneratedOverview {
            text: self.response.lock().unwrap().clone(),
            model_profile_id: "mock-profile".into(),
            usage: serde_json::json!({}),
        })
    }
}
#[derive(Clone)]
struct BlockingModel {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}
impl OverviewModel for BlockingModel {
    async fn generate(
        &self,
        _: &str,
        _: &str,
    ) -> AgentResult<crate::overview_model::GeneratedOverview> {
        self.entered.notify_one();
        self.release.notified().await;
        Ok(crate::overview_model::GeneratedOverview {
            text: r#"{"upsertItems":[],"removeItemIds":[]}"#.into(),
            model_profile_id: "blocked-mock".into(),
            usage: serde_json::json!({}),
        })
    }
}
struct Fixture {
    _root: tempfile::TempDir,
    store: Store,
    scope: Scope,
    todo_id: i64,
    quick_note: String,
}
fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let mut db =
        Database::open(&root.path().join("maintenance.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace("maintenance-workspace").unwrap();
    let quick_note = "用户原始 QuickNote 不变".to_string();
    let project = db
        .project_create(ProjectCreateInput {
            name: "真实项目".into(),
            summary: Some(quick_note.clone()),
            status: None,
        })
        .unwrap();
    let scope = Scope::Project {
        project_id: project.id,
    };
    let mut settings = db.agent_settings_get(&scope).unwrap();
    settings.enabled = true;
    db.agent_settings_update(
        "gui",
        "enable-maintenance",
        &SettingsUpdate {
            expected_revision: settings.revision,
            settings,
        },
    )
    .unwrap();
    let binding = WorkspaceBinding {
        workspace_id: "maintenance-workspace".into(),
        generation: "one".into(),
    };
    Fixture {
        _root: root,
        store: Store {
            binding,
            db: Mutex::new(db),
        },
        scope,
        todo_id: 0,
        quick_note,
    }
}
async fn next(f: &Fixture, model: &impl OverviewModel, index: usize) -> AgentResult<bool> {
    // The production driver activates the durable schedule before stepping.
    f.store.with_current(|binding, db| {
        db.overview_schedule_request(binding, &f.scope, Utc::now())
            .map(|_| ())
    })?;
    let request = request(
        f.store.binding.clone(),
        &f.scope,
        format!("maintenance-step-{index}"),
    );
    step(&f.store, &request, &f.scope, &NoUtility, &NoUtility, model).await
}
async fn warmup(f: &Fixture, model: &MockModel) {
    for index in 0..12 {
        if !next(f, model, index).await.unwrap() {
            break;
        }
    }
    let status = f
        .store
        .with_current(|binding, db| db.agent_overview_maintenance_status(binding, &f.scope))
        .unwrap();
    assert_eq!(status.pending_count, 0);
}
fn add_todo(f: &mut Fixture, content: String) {
    let db = f.store.db.lock().unwrap();
    f.todo_id = db
        .todo_create(TodoCreateInput {
            scope: TodoScope::Project,
            project_id: Some(match &f.scope {
                Scope::Project { project_id } => *project_id,
                _ => unreachable!(),
            }),
            content,
            priority: "normal".into(),
            due_date: None,
            tag_ids: vec![],
        })
        .unwrap()
        .id;
}
fn edit_todo(f: &Fixture, content: String) {
    let db = f.store.db.lock().unwrap();
    let revision = db.todo_record(f.todo_id).unwrap().revision;
    db.todo_update_content(TodoUpdateContentInput {
        expected_revision: revision,
        todo_id: f.todo_id,
        content,
        due_date: None,
        tag_ids: vec![],
    })
    .unwrap();
}

#[tokio::test]
async fn fifty_todo_edits_generate_once_from_latest_native_source_and_leave_quick_note() {
    let mut f = fixture();
    let model = MockModel::new();
    warmup(&f, &model).await;
    add_todo(&mut f, "第一版".into());
    for index in 0..50 {
        edit_todo(&f, format!("真实最新内容 {index}"));
    }
    let calls = model.calls();
    assert!(next(&f, &model, 100).await.unwrap());
    assert_eq!(model.calls(), calls + 1);
    assert!(model
        .prompts
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .contains("真实最新内容 49"));
    assert!(!next(&f, &model, 101).await.unwrap());
    assert_eq!(model.calls(), calls + 1);
    let mut db = f.store.db.lock().unwrap();
    let project_id = match &f.scope {
        Scope::Project { project_id } => *project_id,
        _ => unreachable!(),
    };
    let original = db
        .project_page_get(ProjectIdInput { project_id })
        .unwrap()
        .project
        .summary_markdown;
    assert_eq!(original, f.quick_note);
}

#[tokio::test]
async fn large_todo_continues_across_native_source_pages_with_distinct_batches() {
    let mut f = fixture();
    let model = MockModel::new();
    warmup(&f, &model).await;
    let baseline_revision = f
        .store
        .with_current(|_, db| Ok(db.agent_overview_head(&f.scope)?.unwrap().revision))
        .unwrap();
    add_todo(&mut f, "长资料".repeat(7_000));
    let before_calls = model.calls();
    let mut saw_partial = false;
    let mut settled = false;
    for index in 300..315 {
        let did_work = next(&f, &model, index).await.unwrap();
        let status = f
            .store
            .with_current(|binding, db| db.agent_overview_maintenance_status(binding, &f.scope))
            .unwrap();
        saw_partial |= status.coverage.partial > 0;
        if !did_work {
            settled = true;
            assert_eq!(status.coverage.partial, 0);
            assert!(status.coverage.processed > 0);
            break;
        }
    }
    assert!(settled && saw_partial);
    assert!(model.calls() >= before_calls + 2);
    let ids = model.batch_ids.lock().unwrap();
    let later = &ids[before_calls..];
    assert_eq!(
        later.iter().collect::<std::collections::HashSet<_>>().len(),
        later.len()
    );
    let db = f.store.db.lock().unwrap();
    let revisions = db
        .agent_overview_versions(&f.scope, baseline_revision, 20)
        .unwrap();
    let target_seqs: Vec<u64> = revisions
        .iter()
        .map(|revision| {
            db.agent_overview_version(&f.scope, *revision)
                .unwrap()
                .unwrap()
                .as_of_seq
        })
        .collect();
    assert!(target_seqs.len() >= 2);
    assert!(target_seqs.iter().all(|seq| *seq == target_seqs[0]));
}

#[tokio::test]
async fn invalid_model_json_keeps_pending_and_resume_retries_same_source() {
    let mut f = fixture();
    let model = MockModel::new();
    warmup(&f, &model).await;
    add_todo(&mut f, "未处理事实".into());
    *model.fail.lock().unwrap() = Some(ErrorCode::RuntimeUnavailable);
    assert_eq!(
        next(&f, &model, 199).await.unwrap_err().code,
        ErrorCode::RuntimeUnavailable
    );
    let failed = f
        .store
        .with_current(|binding, db| db.agent_overview_maintenance_status(binding, &f.scope))
        .unwrap();
    assert!(failed.pending_count > 0);
    assert_eq!(failed.error_code, Some(ErrorCode::RuntimeUnavailable));
    control(
        &f.store,
        &request(
            f.store.binding.clone(),
            &f.scope,
            "resume-after-model-failure".into(),
        ),
        &f.scope,
        "resume",
    )
    .unwrap();
    *model.fail.lock().unwrap() = None;
    model.set_response("```json\n{}\n```");
    let error = next(&f, &model, 200).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidArgument);
    let status = f
        .store
        .with_current(|binding, db| db.agent_overview_maintenance_status(binding, &f.scope))
        .unwrap();
    assert!(status.pending_count > 0);
    assert_eq!(status.error_code, Some(ErrorCode::InvalidArgument));
    model.set_response(r#"{"upsertItems":[{"id":"native-todo","section":"progress","text":"未处理事实","epistemicStatus":"recorded","evidenceIndices":[0],"dependencyItemIds":[]}],"removeItemIds":[]}"#);
    let control_request = request(
        f.store.binding.clone(),
        &f.scope,
        "resume-after-invalid".into(),
    );
    control(&f.store, &control_request, &f.scope, "resume").unwrap();
    assert!(next(&f, &model, 201).await.unwrap());
    let head = f
        .store
        .with_current(|_, db| db.agent_overview_head(&f.scope))
        .unwrap()
        .unwrap();
    assert!(head
        .items
        .iter()
        .any(|item| item.id == "native-todo" && item.source_refs.len() == 1));
}

#[tokio::test]
async fn cancellation_during_generation_cannot_publish_the_old_draft() {
    let mut f = fixture();
    warmup(&f, &MockModel::new()).await;
    add_todo(&mut f, "撤销期间的来源".into());
    let f = Arc::new(f);
    let baseline = f
        .store
        .with_current(|_, db| Ok(db.agent_overview_head(&f.scope)?.unwrap().revision))
        .unwrap();
    let model = BlockingModel {
        entered: Arc::new(tokio::sync::Notify::new()),
        release: Arc::new(tokio::sync::Notify::new()),
    };
    let running = {
        let f = f.clone();
        let model = model.clone();
        tokio::spawn(async move { next(&f, &model, 500).await })
    };
    tokio::time::timeout(std::time::Duration::from_secs(3), model.entered.notified())
        .await
        .unwrap();
    control(
        &f.store,
        &request(
            f.store.binding.clone(),
            &f.scope,
            "cancel-while-model-runs".into(),
        ),
        &f.scope,
        "cancel",
    )
    .unwrap();
    assert_eq!(
        running.await.unwrap().unwrap_err().code,
        ErrorCode::Cancelled
    );
    let head = f
        .store
        .with_current(|_, db| db.agent_overview_head(&f.scope))
        .unwrap()
        .unwrap();
    assert_eq!(head.revision, baseline);
    let status = f
        .store
        .with_current(|binding, db| db.agent_overview_maintenance_status(binding, &f.scope))
        .unwrap();
    assert!(status.cancelled && status.pending_count > 0);
}

#[tokio::test]
async fn manual_source_edit_during_generation_rejects_stale_publication() {
    let mut f = fixture();
    warmup(&f, &MockModel::new()).await;
    add_todo(&mut f, "提交前来源".into());
    let f = Arc::new(f);
    let baseline = f
        .store
        .with_current(|_, db| Ok(db.agent_overview_head(&f.scope)?.unwrap().revision))
        .unwrap();
    let model = BlockingModel {
        entered: Arc::new(tokio::sync::Notify::new()),
        release: Arc::new(tokio::sync::Notify::new()),
    };
    let running = {
        let f = f.clone();
        let model = model.clone();
        tokio::spawn(async move { next(&f, &model, 600).await })
    };
    tokio::time::timeout(std::time::Duration::from_secs(3), model.entered.notified())
        .await
        .unwrap();
    edit_todo(&f, "用户提交的新内容".into());
    model.release.notify_one();
    let result = running.await.unwrap();
    if let Err(error) = &result {
        assert!(
            matches!(
                error.code,
                ErrorCode::SourceChanged | ErrorCode::RevisionConflict
            ),
            "{error:?}"
        );
    }
    let head = f
        .store
        .with_current(|_, db| db.agent_overview_head(&f.scope))
        .unwrap()
        .unwrap();
    // A checked snapshot at the captured target is still valid; later source
    // work must remain pending for a future version.
    assert!(head.revision >= baseline);
    let status = f
        .store
        .with_current(|binding, db| db.agent_overview_maintenance_status(binding, &f.scope))
        .unwrap();
    assert!(status.pending_count > 0);
}

#[tokio::test]
async fn excluded_old_overview_item_is_absent_from_next_visible_source_prompt() {
    let mut f = fixture();
    let model = MockModel::new();
    warmup(&f, &model).await;

    add_todo(&mut f, "Visible task before edit".into());
    let visible_id = f.todo_id;
    assert!(next(&f, &model, 700).await.unwrap());
    add_todo(&mut f, "Secret source before exclusion".into());
    let secret_id = f.todo_id;
    assert!(visible_id < secret_id);
    let secret_text = "PRIVATE_OVERVIEW_MARKER_6372";
    model.set_response(&format!(r#"{{"upsertItems":[{{"id":"secret-overview","section":"progress","text":"{secret_text}","epistemicStatus":"recorded","evidenceIndices":[0],"dependencyItemIds":[]}}],"removeItemIds":[]}}"#));
    assert!(next(&f, &model, 701).await.unwrap());
    let stored = f
        .store
        .with_current(|_, db| db.agent_overview_head(&f.scope))
        .unwrap()
        .unwrap();
    assert!(stored.items.iter().any(|item| item.text == secret_text));

    let secret = crate::agent::models::ObjectRef {
        workspace_id: f.store.binding.workspace_id.clone(),
        scope: f.scope.clone(),
        kind: ObjectKind::Todo,
        id: secret_id.to_string(),
    };
    let policy_request = request(
        f.store.binding.clone(),
        &f.scope,
        "exclude-secret-source".into(),
    );
    SourceService::new(&f.store)
        .set_policy(
            &policy_request,
            &SourcePolicyUpdate {
                object: secret,
                expected_revision: 0,
                excluded: true,
            },
        )
        .unwrap();
    f.todo_id = visible_id;
    edit_todo(&f, "Visible task after edit".into());

    model.set_response(r#"{"upsertItems":[],"removeItemIds":[]}"#);
    let before = model.calls();
    assert!(next(&f, &model, 702).await.unwrap());
    assert_eq!(model.calls(), before + 1);
    let prompt = model.prompts.lock().unwrap().last().unwrap().clone();
    assert!(prompt.contains("Visible task after edit"));
    assert!(!prompt.contains(secret_text));
    assert!(!prompt.contains("Secret source before exclusion"));
    let status = f
        .store
        .with_current(|binding, db| db.agent_overview_maintenance_status(binding, &f.scope))
        .unwrap();
    assert!(
        status.pending_count > 0,
        "excluded source is still pending for its own settlement"
    );
}
