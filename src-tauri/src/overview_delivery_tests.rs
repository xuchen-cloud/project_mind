use super::*;
use crate::{
    agent::{context::{OverviewItem, OverviewSection, SourceCoverage, ValidState},
        models::{ObjectKind, ObjectRef}, overview::{OverviewCorrectionUpsert, OverviewPublishInput}},
    models::{DocumentImportInput, DocumentUpdateMetaInput},
    overview_evidence::capture,
    overview_service::{OverviewReadInput, OverviewService},
    source_service::{SourceReadInput, SourceReadTarget, SourceReadView, SourceUtility},
};

struct DeliveryUtility;
impl DocumentUtility for DeliveryUtility {
    async fn request(&self, _: &str, method: &str, data: serde_json::Value) -> AgentResult<serde_json::Value> {
        let text = match method {
            "record.initialize" => data["html"].as_str().unwrap().trim_start_matches("<p>").trim_end_matches("</p>"),
            "record.create" => data["document"]["content"][0]["content"][0]["text"].as_str().unwrap(),
            _ => panic!("Unexpected Record utility method: {method}"),
        };
        let html = format!("<p>{text}</p>");
        let document = serde_json::json!({"type":"doc","content":[{"type":"paragraph",
            "attrs":{"blockId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
            "content":[{"type":"text","text":text}]}]});
        let projection = crate::record_documents::RecordDocumentProjection {
            schema_version: 1, body_hash: crate::record_documents::body_hash(&document, &None),
            document, html, markdown: text.into(), text: text.into(), code_language: None,
        };
        projection.validate()?;
        Ok(serde_json::to_value(projection).unwrap())
    }
}
impl crate::record_document_service::BoundRecordStore for Store {
    async fn flush_editors(&self, _: &WorkspaceBinding, _: &crate::record_documents::RecordTarget) -> AgentResult<()> {
        Ok(())
    }
    async fn submission_lock(&self, _: &WorkspaceBinding, _: &crate::record_documents::RecordTarget)
        -> AgentResult<Option<tokio::sync::OwnedMutexGuard<()>>> { Ok(None) }
    fn with_current<T>(&self, action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>) -> AgentResult<T> {
        <Store as BoundSourceStore>::with_current(self, action)
    }
}
impl SourceUtility for DeliveryUtility {
    async fn request(&self, _: &str, _: &str, _: &str, bytes: &[u8]) -> AgentResult<serde_json::Value> {
        let text = std::str::from_utf8(bytes).unwrap();
        Ok(serde_json::json!({"state":"ready","coverage":{"complete":true,"chars":text.chars().count()},
            "reason":null,"chunks":[{"text":text,"range":{"start":0,"end":text.chars().count()},
            "locator":{"kind":"paragraph","start":1,"end":1}}]}))
    }
}

fn enable_workspace(f: &Fixture) {
    f.store.with_current(|_, db| {
        let mut settings = db.agent_settings_get(&Scope::Workspace)?;
        let expected_revision = settings.revision;
        settings.enabled = true;
        db.agent_settings_update("gui", "delivery-enable-workspace", &SettingsUpdate { settings, expected_revision })
    }).unwrap();
}
fn workspace_request(f: &Fixture, projects: &[i64], id: &str) -> RequestContext {
    let mut result = request(f.store.binding.clone(), &Scope::Workspace, id.into());
    result.scope_grant.workspace_content = true;
    result.scope_grant.project_ids = projects.into();
    result
}
fn source_input(f: &Fixture, scope: Scope, kind: ObjectKind, id: i64) -> SourceReadInput {
    SourceReadInput { source: SourceReadTarget { object: ObjectRef {
        workspace_id: f.store.binding.workspace_id.clone(), scope, kind, id: id.to_string(),
    }, revision: None, record_version: None, file_version: None },
        view: SourceReadView::Full, selection: None, cursor: None, budget_chars: None }
}
async fn publish_parent(f: &Fixture, project_id: i64, item_id: &str, text: Option<&str>,
    source: Option<SourceReadInput>, revision: u64, utility: &DeliveryUtility) {
    let scope = Scope::Project { project_id };
    let req = request(f.store.binding.clone(), &scope, format!("delivery-parent-{item_id}-{revision}"));
    let evidence = if let Some(source) = source {
        vec![capture(&f.store, &req, &source, utility, utility).await.unwrap().1]
    } else { vec![] };
    let (target_seq, policy_revision, correction_revision) = f.store.with_current(|_, db| Ok((
        db.committed_change_watermark()? as u64,
        db.agent_settings_get(&scope)?.revision,
        db.agent_overview_corrections(&scope)?.revision,
    ))).unwrap();
    let item = text.map(|text| OverviewItem {
        id: item_id.into(), section: OverviewSection::KnowledgeMap, text: text.into(),
        epistemic_status: EpistemicStatus::Inferred,
        source_refs: evidence.iter().map(|proof| proof.reference().clone()).collect(),
        published_sources: vec![], dependency_item_ids: vec![],
        valid_state: ValidState::Current, updated_at: "2026-10-09T00:00:00Z".into(),
    });
    let input = OverviewPublishInput {
        expected_memory_epoch: 0, scope, batch_id: format!("delivery-parent-batch-{project_id}-{revision}"),
        expected_revision: revision, target_seq, policy_revision, correction_revision,
        upsert_items: item.into_iter().collect(),
        remove_item_ids: if text.is_none() { vec![item_id.into()] } else { vec![] },
        settled_object_keys: vec![], knowledge_upserts: vec![], knowledge_removes: vec![],
        coverage: SourceCoverage { processed: 1, partial: 0, excluded: 0, unsupported: 0, pending: 0 },
        source_manifest_hash: format!("delivery-parent-{project_id}-{revision}"), model_profile_id: "fixture".into(),
    };
    OverviewService::new(&f.store).publish(&req, &input, &evidence).await.unwrap();
}
async fn drain_workspace(f: &Fixture, projects: &[i64], model: &MockModel, utility: &DeliveryUtility, offset: usize) {
    for index in 0..40 {
        let req = workspace_request(f, projects, &format!("delivery-workspace-{offset}-{index}"));
        f.store.with_current(|binding, db| db.overview_schedule_request(binding, &Scope::Workspace, Utc::now()).map(|_| ())).unwrap();
        let worked = step(&f.store, &req, &Scope::Workspace, utility, utility, model, &NoUtility).await.unwrap();
        let status = f.store.with_current(|binding, db| db.agent_overview_maintenance_status(binding, &Scope::Workspace)).unwrap();
        if !worked && status.pending_count == 0 && status.directory_complete { return; }
    }
    panic!("Workspace maintenance did not settle within the test bound");
}

#[tokio::test]
async fn deleted_parent_hides_historical_workspace_body_immediately() {
    let f = fixture();
    let utility = DeliveryUtility;
    let a = match &f.scope { Scope::Project { project_id } => *project_id, _ => unreachable!() };
    let todo = f.store.with_current(|_, db| Ok(db.todo_create(TodoCreateInput {
        scope: TodoScope::Project, project_id: Some(a), content: "父项原始任务".into(),
        priority: "normal".into(), due_date: None, tag_ids: vec![],
    }).unwrap().id)).unwrap();
    publish_parent(&f, a, "parent-a", Some("A 的已发布事实"),
        Some(source_input(&f, f.scope.clone(), ObjectKind::Todo, todo)), 0, &utility).await;
    enable_workspace(&f);
    let model = MockModel::new();
    model.set_response(r#"{"upsertItems":[{"id":"workspace-a","section":"knowledgeMap","text":"由 A 推导的旧正文","epistemicStatus":"inferred","evidenceIndices":[0],"dependencyItemIds":[]}],"removeItemIds":[]}"#);
    drain_workspace(&f, &[a], &model, &utility, 10).await;
    let req = workspace_request(&f, &[a], "delivery-read-before-delete");
    let service = OverviewService::new(&f.store);
    let read = |version| OverviewReadInput { scope: Scope::Workspace, version,
        sections: vec![OverviewSection::KnowledgeMap], item_ids: vec![], cursor: None, budget_chars: Some(8000) };
    let before = service.get(&req, &read(None)).await.unwrap();
    assert!(before.items.iter().any(|entry| entry.item.text == "由 A 推导的旧正文"));
    publish_parent(&f, a, "parent-a", None, None, 1, &utility).await;
    let historical = service.get(&req, &read(before.revision)).await.unwrap();
    assert!(!historical.items.iter().any(|entry| entry.item.text == "由 A 推导的旧正文"));
}

#[tokio::test]
async fn three_projects_and_direct_record_only_regenerate_changed_inputs() {
    let f = fixture();
    let utility = DeliveryUtility;
    let a = match &f.scope { Scope::Project { project_id } => *project_id, _ => unreachable!() };
    let (b, c, todos) = f.store.with_current(|_, db| {
        let b = db.project_create(ProjectCreateInput { name: "B".into(), summary: None, status: None }).unwrap().id;
        let c = db.project_create(ProjectCreateInput { name: "C".into(), summary: None, status: None }).unwrap().id;
        let mut todos = vec![];
        for (project_id, content) in [(a, "A source"), (b, "B_RAW_ONLY_612"), (c, "C_RAW_ONLY_903")] {
            todos.push(db.todo_create(TodoCreateInput { scope: TodoScope::Project,
                project_id: Some(project_id), content: content.into(), priority: "normal".into(),
                due_date: None, tag_ids: vec![] }).unwrap().id);
        }
        Ok((b, c, todos))
    }).unwrap();
    for (project_id, todo, id) in [(a, todos[0], "a"), (b, todos[1], "b"), (c, todos[2], "c")] {
        publish_parent(&f, project_id, id, Some(&format!("Parent {id} v1")),
            Some(source_input(&f, Scope::Project { project_id }, ObjectKind::Todo, todo)), 0, &utility).await;
    }
    enable_workspace(&f);
    let model = MockModel::new();
    drain_workspace(&f, &[a, b, c], &model, &utility, 20).await;
    let baseline = model.calls();
    f.store.with_current(|_, db| {
        let revision = db.todo_record(todos[0]).unwrap().revision;
        db.todo_update_content(TodoUpdateContentInput { expected_revision: revision,
            todo_id: todos[0], content: "A changed source".into(), due_date: None, tag_ids: vec![] }).unwrap();
        Ok(())
    }).unwrap();
    publish_parent(&f, a, "a", Some("Parent A v2"),
        Some(source_input(&f, Scope::Project { project_id: a }, ObjectKind::Todo, todos[0])), 1, &utility).await;
    let mut record_request = workspace_request(&f, &[a, b, c], "delivery-create-direct-record");
    record_request.scope_grant.operations.extend(["record.write".into(), "record.metadata.write".into()]);
    crate::record_document_service::RecordDocumentService::new(&f.store, &utility)
        .create(&record_request, &crate::record_documents::RecordCreate {
            scope: Scope::Workspace, title: Some("Direct Record".into()), tag_ids: vec![],
            document: serde_json::json!({"type":"doc","content":[{"type":"paragraph",
                "attrs":{"blockId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
                "content":[{"type":"text","text":"DIRECT_RECORD_418"}]}]}),
            code_language: None,
        }).await.unwrap();
    drain_workspace(&f, &[a, b, c], &model, &utility, 21).await;
    assert_eq!(model.calls() - baseline, 2);
    let prompts = model.prompts.lock().unwrap();
    let later = &prompts[baseline..];
    assert!(later.iter().any(|prompt| prompt.contains("Parent A v2")));
    assert!(later.iter().any(|prompt| prompt.contains("DIRECT_RECORD_418")));
    assert!(later.iter().all(|prompt| !prompt.contains("B_RAW_ONLY_612") && !prompt.contains("C_RAW_ONLY_903")));
    // Native source reads have no per-object counter; this verifies the actual
    // consumed batches/model inputs, not an unobservable physical read count.
}

#[tokio::test]
async fn file_rename_does_not_regenerate_workspace_parent() {
    let f = fixture();
    let utility = DeliveryUtility;
    let a = match &f.scope { Scope::Project { project_id } => *project_id, _ => unreachable!() };
    let path = f._root.path().join("delivery-source.txt");
    std::fs::write(&path, "Unchanged file contents").unwrap();
    let file = {
        let mut db = f.store.db.lock().unwrap();
        db.document_import(DocumentImportInput { project_id: a,
            source_path: path.to_string_lossy().into(), is_starred: false, tag_ids: None }).unwrap()
    };
    publish_parent(&f, a, "file-parent", Some("Stable file parent"),
        Some(source_input(&f, f.scope.clone(), ObjectKind::File, file.id)), 0, &utility).await;
    enable_workspace(&f);
    let model = MockModel::new();
    drain_workspace(&f, &[a], &model, &utility, 30).await;
    let calls = model.calls();
    let before = f.store.with_current(|_, db| db.agent_overview_head(&Scope::Workspace)).unwrap().unwrap().revision;
    {
        let mut db = f.store.db.lock().unwrap();
        db.document_update_meta(DocumentUpdateMetaInput { document_id: file.id,
            base_name: Some("renamed-source.txt".into()), is_starred: None, tag_ids: None }).unwrap();
    }
    drain_workspace(&f, &[a], &model, &utility, 31).await;
    assert_eq!(model.calls(), calls);
    assert_eq!(f.store.with_current(|_, db| db.agent_overview_head(&Scope::Workspace)).unwrap().unwrap().revision, before);
}

#[tokio::test]
async fn long_parent_repeats_user_correction_on_every_small_model_page() {
    let f = fixture();
    let utility = DeliveryUtility;
    let a = match &f.scope { Scope::Project { project_id } => *project_id, _ => unreachable!() };
    let todo = f.store.with_current(|_, db| Ok(db.todo_create(TodoCreateInput {
        scope: TodoScope::Project, project_id: Some(a), content: "长父项来源".into(),
        priority: "normal".into(), due_date: None, tag_ids: vec![],
    }).unwrap().id)).unwrap();
    publish_parent(&f, a, "long-parent", Some(&format!("首段事实{}尾段事实", "甲".repeat(3500))),
        Some(source_input(&f, f.scope.clone(), ObjectKind::Todo, todo)), 0, &utility).await;
    f.store.with_current(|_, db| db.agent_overview_correction_upsert("gui", "delivery-correction",
        &OverviewCorrectionUpsert { scope: f.scope.clone(), id: "delivery-correction".into(),
            item_id: Some("long-parent".into()), text: "用户纠正：此事实仍需复核".into(), expected_revision: 0 }).map(|_| ())).unwrap();
    enable_workspace(&f);
    let model = MockModel::new();
    model.set_input_bytes(3_800);
    drain_workspace(&f, &[a], &model, &utility, 40).await;
    assert!(model.calls() >= 2);
    assert!(model.prompts.lock().unwrap().iter().all(|prompt|
        prompt.contains("用户纠正：此事实仍需复核") && prompt.len() <= 3_800));
}
