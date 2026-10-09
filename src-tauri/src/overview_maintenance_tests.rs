use crate::agent::settings::SettingsRepository;
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
impl crate::source_session_read::SessionHistoryUtility for NoUtility {
    async fn read(&self, _: &WorkspaceBinding, _: &crate::db::agent_session_model_search::SourceReadRecord, _: Option<&str>, _: u32) -> AgentResult<crate::source_session_read::SessionHistoryFragment> {
        panic!("Business source fixture does not read sessions")
    }
}
struct MockModel {
    response: Mutex<String>,
    fail: Mutex<Option<ErrorCode>>,
    prompts: Mutex<Vec<String>>,
    batch_ids: Mutex<Vec<String>>,
    calls: AtomicUsize,
    input_bytes: AtomicUsize,
}
impl MockModel {
    fn new() -> Self {
        Self {
            response: Mutex::new(r#"{"upsertItems":[],"removeItemIds":[]}"#.into()),
            fail: Mutex::new(None),
            prompts: Mutex::new(vec![]),
            batch_ids: Mutex::new(vec![]),
            calls: AtomicUsize::new(0),
            input_bytes: AtomicUsize::new(26_000),
        }
    }
    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
    fn set_response(&self, response: &str) {
        *self.response.lock().unwrap() = response.into();
    }
    fn set_input_bytes(&self, bytes: usize) { self.input_bytes.store(bytes, Ordering::SeqCst); }
}
impl OverviewModel for MockModel {
    async fn prepare(&self) -> AgentResult<crate::overview_model::OverviewBudget> {
        Ok(crate::overview_model::OverviewBudget { input_bytes: self.input_bytes.load(Ordering::SeqCst),
            context_window: 8000, max_tokens: 2000,
            fingerprint: "mock-profile".into(), source: "sdk_catalog".into() })
    }
    async fn generate(
        &self,
        batch_id: &str,
        prompt: &str,
        _: &crate::overview_model::OverviewBudget,
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
        _: &crate::overview_model::OverviewBudget,
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
    step(&f.store, &request, &f.scope, &NoUtility, &NoUtility, model, &NoUtility).await
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
async fn model_memory_candidate_uses_todo_evidence_and_updates_stable_node() {
    use crate::agent::{knowledge::KnowledgeKind, memory::MemoryCategory};
    let mut f = fixture();
    let model = MockModel::new();
    warmup(&f, &model).await;
    add_todo(&mut f, "每周复核项目来源".into());
    model.set_response(r#"{"upsertItems":[],"removeItemIds":[],"memoryCandidates":[{"category":"method","title":"每周来源复核","oneLine":"每周复核项目来源","summary":"用户持续按周复核项目来源。","evidenceIndices":[0]}]}"#);
    let before = model.calls();
    assert!(next(&f, &model, 811).await.unwrap());
    assert_eq!(model.calls(), before + 1);
    let first = f.store.with_current(|_, db| {
        let nodes = db.agent_knowledge_candidates(&f.scope, "", &[KnowledgeKind::Memory], None, 10)?;
        Ok(nodes.into_iter().next().unwrap())
    }).unwrap();
    assert_eq!(first.kind, KnowledgeKind::Memory);
    assert_eq!(first.memory.as_ref().unwrap().category, MemoryCategory::Method);
    assert!(matches!(first.epistemic_status, EpistemicStatus::Inferred));
    assert_eq!(first.source_refs.len(), 1);
    assert_eq!(first.source_refs[0].object.id, f.todo_id.to_string());
    edit_todo(&f, "每周复核项目来源并记录结论".into());
    assert!(next(&f, &model, 812).await.unwrap());
    let second = f.store.with_current(|_, db| db.agent_knowledge_get(&f.scope, &first.node_id, None)).unwrap().unwrap();
    assert_eq!(second.revision, first.revision + 1);
    assert_ne!(second.source_refs[0].revision, first.source_refs[0].revision);
    f.store.with_current(|_, db| {
        db.agent_memory_policy_save(&f.scope, &second.node_id, 0,
            crate::agent::memory::MemoryConfirmation::Inferred,
            crate::agent::memory::MemoryStatus::Disabled, false)?;
        db.agent_memory_replace_suppressions(&f.scope, &second, true)
    }).unwrap();
    edit_todo(&f, "每周复核项目来源并记录明确结论".into());
    model.set_response(r#"{"upsertItems":[{"id":"todo-progress","section":"progress","text":"已记录明确结论","epistemicStatus":"recorded","evidenceIndices":[0],"dependencyItemIds":[]}],"removeItemIds":[],"memoryCandidates":[{"category":"method","title":"每周来源复核","oneLine":"每周复核项目来源","summary":"用户持续按周复核项目来源。","evidenceIndices":[0]}]}"#);
    assert!(next(&f, &model, 813).await.unwrap());
    let (memory, head) = f.store.with_current(|_, db| Ok((
        db.agent_knowledge_get(&f.scope, &first.node_id, None)?.unwrap(),
        db.agent_overview_head(&f.scope)?.unwrap(),
    ))).unwrap();
    assert_eq!(memory.revision, second.revision);
    assert!(head.items.iter().any(|item| item.id == "todo-progress"));
}

#[path = "overview_session_tests.rs"]
mod session_tests;

#[tokio::test]
async fn workspace_published_input_uses_visible_other_project_understanding() {
    use crate::agent::context::{OverviewItem,OverviewSection,ValidState};
    let mut f=fixture();
    add_todo(&mut f,"A 项目已核实的原始事实".into());
    let todo=crate::agent::models::ObjectRef {
        workspace_id:f.store.binding.workspace_id.clone(),scope:f.scope.clone(),
        kind:ObjectKind::Todo,id:f.todo_id.to_string(),
    };
    let (source,_) = crate::overview_evidence::capture(&f.store,
        &request(f.store.binding.clone(),&f.scope,"workspace-parent-evidence".into()),
        &SourceReadInput {source:SourceReadTarget {object:todo,revision:None,
            record_version:None,file_version:None},view:SourceReadView::Full,
            selection:None,cursor:None,budget_chars:Some(2_500)},
        &NoUtility,&NoUtility).await.unwrap();
    let workspace=Scope::Workspace;
    let (a,b)={
        let db=f.store.db.lock().unwrap();
        let a=match &f.scope {Scope::Project{project_id}=>*project_id,_=>unreachable!()};
        let b=db.project_create(ProjectCreateInput{name:"B".into(),summary:None,status:None}).unwrap().id;
        let c=db.project_create(ProjectCreateInput{name:"C".into(),summary:None,status:None}).unwrap().id;
        let mut settings=db.agent_settings_get(&workspace).unwrap();
        settings.enabled=true;
        db.agent_settings_update("gui","enable-workspace-test",&SettingsUpdate{
            expected_revision:settings.revision,settings}).unwrap();
        let publish=|scope:Scope,batch:&str,items:Vec<OverviewItem>,settled:Vec<String>| {
            let input=OverviewPublishInput {scope:scope.clone(),batch_id:batch.into(),expected_revision:0,
                target_seq:db.committed_change_watermark().unwrap() as u64,
                policy_revision:db.agent_settings_get(&scope).unwrap().revision,
                correction_revision:0,expected_memory_epoch:0,upsert_items:items,remove_item_ids:vec![],settled_object_keys:settled,
                knowledge_upserts:vec![],knowledge_removes:vec![],
                coverage:SourceCoverage{processed:0,partial:0,excluded:0,unsupported:0,pending:0},
                source_manifest_hash:"test".into(),model_profile_id:"fixture".into()};
            db.agent_overview_publish("gui",batch,&f.store.binding.workspace_id,&input,|_,_|Ok(())).unwrap();
        };
        let item=|id:&str,text:&str,published_sources| OverviewItem {id:id.into(),
            section:OverviewSection::KnowledgeMap,text:text.into(),epistemic_status:EpistemicStatus::Inferred,
            source_refs:vec![],published_sources,dependency_item_ids:vec![],
            valid_state:ValidState::Current,updated_at:"fixture".into()};
        let mut primary=item("a","A 原有结论",vec![]);
        primary.source_refs=vec![source.source_ref.clone()];
        publish(f.scope.clone(),"project-a",vec![primary],vec![]);
        publish(Scope::Project{project_id:b},"project-b",vec![item("b","B 的项目结论",vec![])],vec![]);
        publish(Scope::Project{project_id:c},"project-c",vec![item("c","C 的撤权结论",vec![])],vec![]);
        for index in 0..10 {
            if db.agent_overview_inventory_advance("gui",&format!("workspace-inventory-{index}"),
                &f.store.binding.workspace_id,&workspace,100).unwrap().directory_complete {break;}
        }
        let bref=db.agent_published_item_capture(b,"b").unwrap().0;
        let cref=db.agent_published_item_capture(c,"c").unwrap().0;
        publish(workspace.clone(),"workspace-seed",vec![
            item("workspace-b","B 的已发布 Workspace 理解",vec![bref]),
            item("workspace-c","C 的撤权 Workspace 理解",vec![cref])],
            vec![format!("published:{b}:b"),format!("published:{c}:c")]);
        (a,b)
    };
    let mut req=request(f.store.binding.clone(),&workspace,"workspace-step".into());
    req.scope_grant.workspace_content=true;
    req.scope_grant.project_ids=vec![a,b];
    let model=MockModel::new();
    model.set_response(r#"{"upsertItems":[{"id":"workspace-a-b","section":"knowledgeMap","text":"A 与 B 相关","epistemicStatus":"inferred","evidenceIndices":[0],"dependencyItemIds":["workspace-b"]}],"removeItemIds":[],"sourceSummary":{"title":"A B 关联主题","oneLine":"跨项目关系","summary":"A 与 B 的已发布知识关联","bodySections":[],"keywords":["跨项目"]},"memoryCandidates":[{"category":"domain","title":"A 项目领域知识","oneLine":"A 的长期领域背景","summary":"A 项目提供领域背景。","evidenceIndices":[0]}]}"#);
    for index in 0..8 {
        f.store.with_current(|binding,db|db.overview_schedule_request(binding,&workspace,Utc::now()).map(|_|())).unwrap();
        req.request_id=format!("workspace-step-{index}");
        step(&f.store,&req,&workspace,&NoUtility,&NoUtility,&model,&NoUtility).await.unwrap();
        if model.calls()>0 {break;}
    }
    assert_eq!(model.calls(),1);
    let prompt=&model.prompts.lock().unwrap()[0];
    assert!(prompt.contains("B 的已发布 Workspace 理解"));
    assert!(!prompt.contains("C 的撤权 Workspace 理解"));
    let head=f.store.with_current(|_,db|db.agent_overview_head(&workspace)).unwrap().unwrap();
    assert!(head.items.iter().any(|item|item.id=="workspace-a-b" &&
        item.dependency_item_ids==vec!["workspace-b".to_string()]));
    let memory=f.store.with_current(|_,db|db.agent_knowledge_candidates(&workspace,"",
        &[crate::agent::knowledge::KnowledgeKind::Memory],None,10)).unwrap().into_iter().next().unwrap();
    assert!(memory.source_refs.is_empty());
    assert_eq!(memory.published_sources.len(),1);
    assert_eq!(memory.published_sources[0].project_id,a);
    let gui_ids=crate::agent::commands::gui_project_ids(&f.store,&f.store.binding,&workspace).unwrap();
    assert!(gui_ids.contains(&a) && gui_ids.contains(&b));
    let mut gui_request=req.clone();
    gui_request.scope_grant.project_ids=gui_ids;
    let registry=crate::knowledge_registry::KnowledgeRegistry::new(&f.store);
    let result=registry.search(&gui_request,&crate::knowledge_service::KnowledgeSearchInput {
        scope:workspace.clone(),query:"A B 关联主题".into(),kinds:vec![],cursor:None,
        limit:Some(10),budget_chars:Some(3000),
    }).unwrap();
    let node=result.items.iter().find(|item|item.node_id.starts_with("node:published-")).unwrap();
    let page=registry.get(&gui_request,&crate::knowledge_service::KnowledgeGetInput {
        scope:workspace.clone(),node_id:node.node_id.clone(),version:None,
        view:crate::knowledge_service::KnowledgeView::Summary,section_ids:vec![],
        cursor:None,budget_chars:Some(8000),
    }).await.unwrap();
    assert!(!page.published_sources.is_empty());
    f.store.with_current(|_,db|db.agent_overview_correction_upsert("gui","correct-project-a",
        &crate::agent::overview::OverviewCorrectionUpsert {scope:f.scope.clone(),id:"correct-a".into(),
            item_id:Some("a".into()),text:"A 的旧结论已纠正".into(),expected_revision:0}).map(|_|())).unwrap();
    let hidden=registry.get(&gui_request,&crate::knowledge_service::KnowledgeGetInput {
        scope:Scope::Workspace,node_id:node.node_id.clone(),version:Some(page.revision),
        view:crate::knowledge_service::KnowledgeView::Summary,section_ids:vec![],
        cursor:None,budget_chars:Some(8000),
    }).await.unwrap_err();
    assert_eq!(hidden.code,ErrorCode::NotFound);

    let batch=f.store.with_current(|binding,db|db.agent_overview_maintenance_prepare(binding,&workspace,Utc::now()))
        .unwrap().unwrap();
    assert_eq!(batch.source_object.published().unwrap().project_id,a);
    let parent=f.store.with_current(|_,db|db.agent_published_item_capture(a,"a").map(|v|v.0)).unwrap();
    let progress=OverviewSourceProgress {object:batch.source_object.clone(),read_target:None,read_cursor:None,
        state:OverviewSourceState::Processed,handled_seq:batch.source.last_seq};
    let coverage=f.store.with_current(|binding,db|db.agent_overview_maintenance_coverage(binding,&workspace,Some(&progress))).unwrap();
    let draft=OverviewPublishInput {scope:workspace.clone(),batch_id:batch.batch_id.clone(),
        expected_revision:batch.expected_revision,target_seq:batch.target_seq,
        policy_revision:batch.policy_revision,correction_revision:batch.correction_revision,
        expected_memory_epoch:batch.expected_memory_epoch,
        upsert_items:vec![OverviewItem {id:"workspace-corrected-a".into(),
            section:OverviewSection::KnowledgeMap,text:"按纠正更新的 A".into(),
            epistemic_status:EpistemicStatus::Inferred,source_refs:vec![],published_sources:vec![parent],
            dependency_item_ids:vec![],valid_state:ValidState::Current,updated_at:"now".into()}],
        remove_item_ids:vec![],settled_object_keys:vec![batch.source.object_key.clone()],
        knowledge_upserts:vec![],knowledge_removes:vec![],coverage,
        source_manifest_hash:"saved-workspace-draft".into(),model_profile_id:"saved-model".into()};
    f.store.with_current(|binding,db|db.agent_overview_maintenance_save_draft_many(binding,&workspace,
        &batch.batch_id,&draft,std::slice::from_ref(&progress),Some(1200),Utc::now())).unwrap();
    let before=model.calls();
    *model.fail.lock().unwrap()=Some(ErrorCode::RuntimeUnavailable);
    f.store.with_current(|binding,db|db.overview_schedule_request(binding,&workspace,Utc::now()).map(|_|())).unwrap();
    req.request_id="replay-workspace-draft".into();
    assert!(step(&f.store,&req,&workspace,&NoUtility,&NoUtility,&model,&NoUtility).await.unwrap());
    assert_eq!(model.calls(),before);
    assert!(f.store.with_current(|_,db|db.agent_overview_head(&workspace)).unwrap().unwrap().items
        .iter().any(|item|item.id=="workspace-corrected-a"));
}

#[tokio::test]
async fn published_parent_second_page_sees_first_page_memory_before_update() {
    use crate::agent::context::{OverviewItem,OverviewSection,ValidState};
    let mut f=fixture();
    add_todo(&mut f,"项目背景的真实来源".into());
    let project_id=match &f.scope {Scope::Project{project_id}=>*project_id,_=>unreachable!()};
    let workspace=Scope::Workspace;
    let todo=crate::agent::models::ObjectRef {
        workspace_id:f.store.binding.workspace_id.clone(),scope:f.scope.clone(),
        kind:ObjectKind::Todo,id:f.todo_id.to_string(),
    };
    let (source,_) = crate::overview_evidence::capture(&f.store,
        &request(f.store.binding.clone(),&f.scope,"parent-memory-evidence".into()),
        &SourceReadInput {source:SourceReadTarget {object:todo,revision:None,
            record_version:None,file_version:None},view:SourceReadView::Full,
            selection:None,cursor:None,budget_chars:Some(2_500)},
        &NoUtility,&NoUtility).await.unwrap();
    f.store.with_current(|_,db| {
        let mut settings=db.agent_settings_get(&workspace)?;
        settings.enabled=true;
        db.agent_settings_update("gui","enable-memory-pages",&SettingsUpdate{
            expected_revision:settings.revision,settings})?;
        let item=|id:&str,text:String,deps:Vec<String>| OverviewItem {
            id:id.into(),section:OverviewSection::KnowledgeMap,text,
            epistemic_status:EpistemicStatus::Inferred,source_refs:vec![],
            published_sources:vec![],dependency_item_ids:deps,
            valid_state:ValidState::Current,updated_at:"fixture".into(),
        };
        let mut primary=item("a",format!("首段事实{}", "甲".repeat(1700)),vec!["support".into()]);
        primary.source_refs=vec![source.source_ref.clone()];
        let input=OverviewPublishInput {
            scope:f.scope.clone(),batch_id:"long-parent".into(),expected_revision:0,
            target_seq:db.committed_change_watermark()? as u64,
            policy_revision:db.agent_settings_get(&f.scope)?.revision,
            correction_revision:0,expected_memory_epoch:0,
            upsert_items:vec![primary,
                item("support",format!("后段事实{}", "乙".repeat(1700)),vec![])],
            remove_item_ids:vec![],settled_object_keys:vec![],knowledge_upserts:vec![],
            knowledge_removes:vec![],coverage:SourceCoverage{processed:0,partial:0,excluded:0,unsupported:0,pending:0},
            source_manifest_hash:"long-parent".into(),model_profile_id:"fixture".into(),
        };
        db.agent_overview_publish("gui","long-parent",&f.store.binding.workspace_id,&input,|_,_|Ok(()))?;
        for index in 0..10 {
            if db.agent_overview_inventory_advance("gui",&format!("memory-page-inventory-{index}"),
                &f.store.binding.workspace_id,&workspace,100)?.directory_complete {break;}
        }
        Ok(())
    }).unwrap();
    let mut req=request(f.store.binding.clone(),&workspace,"memory-page-1".into());
    req.scope_grant.workspace_content=true;
    req.scope_grant.project_ids=vec![project_id];
    let model=MockModel::new();
    model.set_input_bytes(5_500);
    model.set_response(r#"{"upsertItems":[],"removeItemIds":[],"memoryCandidates":[{"category":"domain","title":"项目背景","oneLine":"跨页背景","summary":"首段稳定事实。","evidenceIndices":[0]}]}"#);
    for index in 0..8 {
        f.store.with_current(|binding,db|db.overview_schedule_request(binding,&workspace,Utc::now()).map(|_|())).unwrap();
        req.request_id=format!("memory-page-first-{index}");
        step(&f.store,&req,&workspace,&NoUtility,&NoUtility,&model,&NoUtility).await.unwrap();
        if model.calls()>0 {break;}
    }
    assert_eq!(model.calls(),1);
    assert!(model.prompts.lock().unwrap()[0].contains("\"complete\":false"));
    let (first_memory,next_batch)=f.store.with_current(|binding,db| Ok((
        db.agent_knowledge_candidates(&workspace,"",&[crate::agent::knowledge::KnowledgeKind::Memory],None,10)?.into_iter().next().unwrap(),
        db.agent_overview_maintenance_prepare(binding,&workspace,Utc::now())?.unwrap(),
    ))).unwrap();
    assert_eq!(first_memory.published_sources.len(),1);
    assert_eq!(next_batch.source_object.published().unwrap().item_id,first_memory.published_sources[0].item_id);
    assert!(next_batch.source_cursor.is_some());
    let prior=f.store.with_current(|_,db|db.agent_overview_memory_for_input(&workspace,&next_batch.source_object)).unwrap();
    assert!(prior.iter().any(|node|node.node_id==first_memory.node_id));
    assert!(f.store.with_current(|binding,db|db.agent_memory_model_visible(&req,binding,&first_memory)).unwrap());
    model.set_response(r#"{"upsertItems":[],"removeItemIds":[],"memoryCandidates":[{"category":"domain","title":"项目背景","oneLine":"跨页背景","summary":"首段稳定事实；后段稳定事实。","evidenceIndices":[0]}]}"#);
    for index in 0..8 {
        f.store.with_current(|binding,db|db.overview_schedule_request(binding,&workspace,Utc::now()).map(|_|())).unwrap();
        req.request_id=format!("memory-page-second-{index}");
        step(&f.store,&req,&workspace,&NoUtility,&NoUtility,&model,&NoUtility).await.unwrap();
        if model.calls()>1 {break;}
    }
    assert_eq!(model.calls(),2);
    let prompts=model.prompts.lock().unwrap();
    assert!(prompts[1].contains("首段稳定事实"));
    assert!(prompts[1].contains("priorMemory"));
    drop(prompts);
    let memory=f.store.with_current(|_,db|db.agent_knowledge_candidates(&workspace,"",
        &[crate::agent::knowledge::KnowledgeKind::Memory],None,10)).unwrap().into_iter().next().unwrap();
    assert_eq!(memory.revision,2);
    assert!(memory.summary.contains("首段稳定事实") && memory.summary.contains("后段稳定事实"));
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
    model.set_input_bytes(3_800);
    let baseline_revision = f
        .store
        .with_current(|_, db| Ok(db.agent_overview_head(&f.scope)?.unwrap().revision))
        .unwrap();
    add_todo(&mut f, "长资料".repeat(7_000));
    let before_calls = model.calls();
    let mut saw_partial = false;
    let mut settled = false;
    let mut last_cursor = 0usize;
    for index in 300..520 {
        let did_work = next(&f, &model, index).await.unwrap();
        let status = f
            .store
            .with_current(|binding, db| db.agent_overview_maintenance_status(binding, &f.scope))
            .unwrap();
        saw_partial |= status.coverage.partial > 0;
        if status.coverage.partial > 0 {
            if let Some(cursor) = f.store.with_current(|binding, db|
                db.agent_overview_maintenance_prepare(binding, &f.scope, Utc::now()))
                .unwrap().and_then(|batch| batch.source_cursor) {
                use base64::Engine;
                let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(cursor).unwrap();
                let cursor = serde_json::from_slice::<crate::source_text_page::ReadCursor>(&bytes).unwrap().offset;
                assert!(cursor > last_cursor, "native source cursor did not advance");
                last_cursor = cursor;
            }
        }
        if !did_work {
            settled = true;
            assert_eq!(status.coverage.partial, 0);
            assert!(status.coverage.processed > 0);
            break;
        }
    }
    eprintln!("large source settled after {} model pages, cursor reached {}", model.calls() - before_calls, last_cursor);
    assert!(settled && saw_partial);
    assert!(model.calls() >= before_calls + 2);
    assert!(model.prompts.lock().unwrap()[before_calls..].iter().all(|prompt| prompt.len() <= 3_800));
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
async fn saved_small_page_draft_replays_without_model_and_preserves_cursor() {
    let mut f = fixture();
    let model = MockModel::new();
    warmup(&f, &model).await;
    add_todo(&mut f, "分段中文".repeat(2_000));
    *model.fail.lock().unwrap() = Some(ErrorCode::RuntimeUnavailable);
    assert_eq!(next(&f, &model, 900).await.unwrap_err().code, ErrorCode::RuntimeUnavailable);
    control(&f.store, &request(f.store.binding.clone(), &f.scope, "resume-small-draft".into()), &f.scope, "resume").unwrap();
    let batch = f.store.with_current(|binding, db| {
        db.agent_overview_maintenance_prepare(binding, &f.scope, Utc::now())
    }).unwrap().unwrap();
    let source_request = request(f.store.binding.clone(), &f.scope, "draft-small-page".into());
    let input = SourceReadInput { source: batch.source_read_target.clone().unwrap_or(SourceReadTarget {
        object: batch.source_object.raw_object().unwrap().clone(), revision: None, record_version: None, file_version: None,
    }), view: SourceReadView::Full, selection: None, cursor: batch.source_cursor.clone(), budget_chars: Some(2_500) };
    let (page, _) = crate::overview_evidence::capture(&f.store, &source_request, &input, &NoUtility, &NoUtility).await.unwrap();
    assert!(!page.complete);
    let progress = OverviewSourceProgress { object: batch.source_object.clone(),
        read_target: Some(SourceReadTarget { revision: Some(page.source_ref.revision.clone()), ..input.source }),
        read_cursor: page.next_cursor.clone(), state: OverviewSourceState::Partial,
        handled_seq: batch.source.last_seq };
    let coverage = f.store.with_current(|binding, db| db.agent_overview_maintenance_coverage_many(binding, &f.scope, std::slice::from_ref(&progress))).unwrap();
    let draft = OverviewPublishInput { scope: f.scope.clone(), batch_id: batch.batch_id.clone(),
        expected_revision: batch.expected_revision, target_seq: batch.target_seq,
        policy_revision: batch.policy_revision, correction_revision: batch.correction_revision,
        expected_memory_epoch:batch.expected_memory_epoch,
        upsert_items: vec![crate::agent::context::OverviewItem {
            id: "small-page-cited".into(), section: crate::agent::context::OverviewSection::Progress,
            text: "已读取首个中文片段".into(), epistemic_status: EpistemicStatus::Recorded,
            source_refs: vec![page.source_ref.clone()],
            published_sources: vec![], dependency_item_ids: vec![],
            valid_state: crate::agent::context::ValidState::Current,
            updated_at: Utc::now().to_rfc3339(),
        }], remove_item_ids: vec![], settled_object_keys: vec![],
        knowledge_upserts: memory_nodes(&f.store, &f.scope,
            vec![crate::overview_generation::ParsedMemoryCandidate {
                node_id: "memory-saved-page".into(),
                category: crate::agent::memory::MemoryCategory::Method,
                title: "分段阅读方法".into(), one_line: "分段阅读来源".into(),
                summary: "分段阅读长来源。".into(), body_sections: vec![], keywords: vec![],
                source_refs: vec![page.source_ref.clone()], published_sources: vec![],
            }], &Utc::now().to_rfc3339()).unwrap(),
        knowledge_removes: vec![], coverage,
        source_manifest_hash: "small-page-draft".into(), model_profile_id: "mock-profile".into() };
    f.store.with_current(|binding, db| db.agent_overview_maintenance_save_draft_many(binding,
        &f.scope, &batch.batch_id, &draft, std::slice::from_ref(&progress), Some(2_500), Utc::now())).unwrap();
    let calls = model.calls();
    *model.fail.lock().unwrap() = None;
    assert!(next(&f, &model, 901).await.unwrap());
    assert_eq!(model.calls(), calls);
    let saved_memory = f.store.with_current(|_, db| db.agent_knowledge_get(&f.scope, "memory-saved-page", None)).unwrap().unwrap();
    assert_eq!(saved_memory.source_refs[0].revision, page.source_ref.revision);
    let status = f.store.with_current(|binding, db| db.agent_overview_maintenance_status(binding, &f.scope)).unwrap();
    assert!(status.coverage.partial > 0);
    let (head, continuation) = f.store.with_current(|binding, db| Ok((
        db.agent_overview_head(&f.scope)?.unwrap(),
        db.agent_overview_maintenance_prepare(binding, &f.scope, Utc::now())?.unwrap(),
    ))).unwrap();
    let cited = head.items.iter().find(|item| item.id == "small-page-cited").unwrap();
    assert_eq!(serde_json::to_value(&cited.source_refs[0]).unwrap(), serde_json::to_value(&page.source_ref).unwrap());
    assert_eq!(continuation.source_cursor, progress.read_cursor);
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
    let raw_after_exclusion = f
        .store
        .with_current(|_, db| db.agent_overview_head(&f.scope))
        .unwrap()
        .unwrap();
    assert!(raw_after_exclusion
        .items
        .iter()
        .any(|item| item.text == secret_text));
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

#[path = "overview_delivery_tests.rs"]
mod delivery;
