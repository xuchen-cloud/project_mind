use super::super::AssistantContext;
use super::*;
use crate::{
    agent::models::Scope,
    file_version_service::FileCommitHost,
    office_worker::{OfficePayload, OfficeUtility},
    workspace::{create_workspace, WorkspacePaths},
    workspace_commit_fence::WorkspaceCommitFence,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};

struct TestStore {
    db: Mutex<Database>,
    binding: WorkspaceBinding,
    paths: WorkspacePaths,
    fence: Arc<WorkspaceCommitFence>,
    alive: Arc<AtomicBool>,
}
impl BoundSourceStore for TestStore {
    fn with_current<T>(
        &self,
        f: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "test runtime revoked",
            ));
        }
        let result = f(&self.binding, &crate::lock_mutex(&self.db));
        if !self.alive.load(Ordering::SeqCst) {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "test runtime revoked",
            ));
        }
        result
    }
}
impl CommittedChangePublisher for TestStore {
    fn publish_committed(&self, _: CommittedChanges) {}
}
impl BoundFileCommitStore for TestStore {
    fn gui_commit_host(&self, binding: &WorkspaceBinding) -> AgentResult<FileCommitHost> {
        crate::file_version_service::validate_binding(binding, &self.binding)?;
        Ok(FileCommitHost::for_test(
            self.binding.clone(),
            self.paths.clone(),
            None,
            self.fence.clone(),
        ))
    }
}
struct TestEngine;

fn create_fixture() -> (tempfile::TempDir, TestStore, Identity) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let (metadata, paths) = create_workspace(&root, "password").unwrap();
    let mut db = Database::open(&paths.db_path, &root, None).unwrap();
    db.bind_native_workspace(&metadata.workspace_id).unwrap();
    let project = db.project_create(crate::models::ProjectCreateInput { name:"创建测试".into(), summary:None, status:None }).unwrap();
    let binding = WorkspaceBinding { workspace_id:metadata.workspace_id, generation:"create-runtime".into() };
    let identity = Identity { workspace_id:binding.workspace_id.clone(), workspace_generation:binding.generation.clone(), root,
        fingerprint:"create-fixture".into(), context:AssistantContext::Project(ProjectContext {
            id:project.id, name:project.name, directory:std::path::PathBuf::from(project.root_path),
        }) };
    let store = TestStore { db:Mutex::new(db), binding, paths, fence:Arc::new(WorkspaceCommitFence::new()), alive:Arc::new(AtomicBool::new(true)) };
    (temp, store, identity)
}
fn creation(request_id: &str, content: &str) -> OfficeCreateCall {
    OfficeCreateCall::parse(serde_json::from_value(json!({"operation":"officeCreate","sessionId":"create-session",
        "requestId":request_id,"mode":"workspace-write","projectId":null,"name":"中文报告.docx","content":content})).unwrap()).unwrap()
}
struct CreationEngine { count: std::sync::atomic::AtomicUsize, fail: bool }
impl OfficeUtility for CreationEngine {
    async fn request(&self, _: &str, method: &str, _: &str, source: &str, payload: OfficePayload<'_>) -> AgentResult<Value> {
        if let OfficePayload::Create(content) = payload {
            assert_eq!(method,"office.create"); assert!(source.is_empty()); assert!(content.to_string().contains("报告"));
            let count = self.count.fetch_add(1, Ordering::SeqCst);
            if self.fail { return Err(AgentError::new(ErrorCode::InvalidArgument,"generation failed")); }
            return Ok(json!({"base64":STANDARD.encode(format!("candidate-{count}"))}));
        }
        assert_eq!(method,"office.inspect");
        Ok(json!({"model":{"format":"docx","nodes":[{"id":"p0","text":String::from_utf8(STANDARD.decode(source).unwrap()).unwrap()}]}}))
    }
}

#[tokio::test]
async fn office_creation_replays_original_request_and_rejects_readonly_or_foreign_targets() {
    let (_temp,store,identity)=create_fixture(); let grants=Mutex::new(HashMap::new());
    let engine=CreationEngine{count:std::sync::atomic::AtomicUsize::new(0),fail:false};
    let first=creation("stable-create","<h1>报告</h1>").execute(&store,&engine,&identity,&grants,None).await.unwrap();
    assert_eq!(first["saved"],true);assert_eq!(first["sourceRef"]["fileVersion"],1);
    assert_eq!(first["commit"]["contentHash"],first["sourceRef"]["revision"]);
    assert_eq!(first["commit"]["object"],first["sourceRef"]["object"]);
    assert_eq!(creation("stable-create","<h1>报告</h1>").execute(&store,&engine,&identity,&grants,None).await.unwrap(),first);
    assert_eq!(engine.count.load(Ordering::SeqCst),1);
    assert_eq!(creation("stable-create","<h1>报告改变</h1>").execute(&store,&engine,&identity,&grants,None).await.unwrap_err().code,ErrorCode::IdempotencyConflict);
    let mut foreign=creation("foreign","<h1>报告</h1>");foreign.project_id=Some(9999);
    assert_eq!(foreign.execute(&store,&engine,&identity,&grants,None).await.unwrap_err().code,ErrorCode::ScopeDenied);
    let readonly=serde_json::from_value(json!({"operation":"officeCreate","sessionId":"create-session","requestId":"readonly","mode":"read-only","name":"x.docx","content":"<p>报告</p>"})).unwrap();
    assert_eq!(OfficeCreateCall::parse(readonly).err().unwrap().code,ErrorCode::ScopeDenied);
    assert_eq!(engine.count.load(Ordering::SeqCst),1);
}

#[tokio::test]
async fn office_creation_failure_leaves_no_file_or_creation_receipt() {
    let (_temp,store,identity)=create_fixture();let grants=Mutex::new(HashMap::new());
    let engine=CreationEngine{count:std::sync::atomic::AtomicUsize::new(0),fail:true};
    assert_eq!(creation("failed-create","<p>报告</p>").execute(&store,&engine,&identity,&grants,None).await.unwrap_err().code,ErrorCode::InvalidArgument);
    assert!(!identity.directory().join("中文报告.docx").exists());
    let (grant,token)=crate::lock_mutex(&grants).get("create-session").unwrap().clone();
    store.with_current(|binding,db| {
        let request=db.agent_connection_authenticate(binding,&grant,&token,"failed-create")?;
        let receipt:Option<crate::db::file_imports::AgentFileCreateResult>=db.agent_operation_replay(&request.caller.key(),"failed-create","file.create",&crate::db::file_imports::agent_file_generated_payload(identity.project_id(),"中文报告.docx","<p>报告</p>"))?;
        assert!(receipt.is_none());Ok(())
    }).unwrap();
}

#[tokio::test]
#[ignore = "requires prepared GenOffice runtime"]
async fn office_creation_real_genoffice_saves_reads_and_edits_same_native_file() {
    let (_temp,store,identity)=create_fixture();let grants=Mutex::new(HashMap::new());
    let worker=crate::office_worker::OfficeWorker::development().unwrap();
    let content="<h1>中文报告</h1><p>原始正文</p><ol><li>第一步</li><li>第二步</li></ol><table><tr><th>项目</th><th>结果</th></tr><tr><td>检查</td><td>通过</td></tr></table>";
    let first=creation("real-create",content).execute(&store,&worker,&identity,&grants,None).await.unwrap();
    let nodes=first["model"]["nodes"].as_array().unwrap();
    for text in ["中文报告","原始正文","第一步","第二步","项目","结果","检查","通过"] { assert!(nodes.iter().any(|node|node["text"]==text),"{text}"); }
    let node=nodes.iter().find(|node|node["text"]=="原始正文").unwrap();
    let edit=json!({"operation":"officeEdit","mode":"workspace-write","sessionId":"create-session","requestId":"real-v2","sourceRef":first["sourceRef"],"edits":[{"type":"text","nodeId":node["id"],"expectedText":"原始正文","text":"编辑后的正文"}]});
    let second=call(edit.clone()).execute(&store,&worker,&identity,&grants).await.unwrap();
    assert_eq!(second["sourceRef"]["object"],first["sourceRef"]["object"]);assert_eq!(second["sourceRef"]["fileVersion"],2);
    assert!(second["model"]["nodes"].as_array().unwrap().iter().any(|node|node["text"]=="编辑后的正文"));
    let mut stale=edit;stale["requestId"]=json!("stale-create-edit");
    assert_eq!(call(stale).execute(&store,&worker,&identity,&grants).await.unwrap_err().code,ErrorCode::RevisionConflict);
    assert_eq!(creation("real-create",content).execute(&store,&worker,&identity,&grants,None).await.unwrap()["sourceRef"],first["sourceRef"]);
}
impl OfficeUtility for TestEngine {
    async fn request(
        &self,
        id: &str,
        method: &str,
        _: &str,
        base64: &str,
        _: OfficePayload<'_>,
    ) -> AgentResult<Value> {
        assert!(!id.is_empty());
        let bytes = STANDARD.decode(base64).unwrap();
        if method == "office.inspect" {
            Ok(json!({"model":{"text":String::from_utf8(bytes).unwrap()}}))
        } else {
            assert!(["session-a:stable-call", "session-a:project-call"].contains(&id));
            Ok(json!({"model":{"text":"saved office"},"base64":STANDARD.encode(b"saved office")}))
        }
    }
}
fn call(value: Value) -> OfficeCall {
    OfficeCall::parse(serde_json::from_value(value).unwrap(), "native-frame-id").unwrap()
}

#[test]
fn dsh_office_tool_source_ref_contract_reaches_native_without_coercion() {
    // Shared with the actual DSH tool schema test, rather than a hand-built
    // native-only reference that could hide a cross-runtime DTO mismatch.
    let source: Value = serde_json::from_str(include_str!(
        "../../packages/dsh-assistant/test/fixtures/office-source-ref.json"
    ))
    .unwrap();
    let request = json!({"operation":"officeEdit","mode":"workspace-write","sessionId":"real-session",
        "requestId":"tool-call","sourceRef":source,"edits":[]});
    let parsed = call(request.clone());
    assert_eq!(serde_json::to_value(parsed.fixed.unwrap()).unwrap(), source);
    for invalid in [Value::String(source.to_string()), json!({})] {
        let mut request = request.clone();
        request["sourceRef"] = invalid;
        assert!(serde_json::from_value::<SourceRequest>(request).is_err());
    }
}

#[tokio::test]
async fn dsh_office_operations_save_through_real_grant_replay_and_retain_history() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let (metadata, paths) = create_workspace(&root, "password").unwrap();
    let mut db = Database::open(&paths.db_path, &root, None).unwrap();
    db.bind_native_workspace(&metadata.workspace_id).unwrap();
    let project = db
        .project_create(crate::models::ProjectCreateInput {
            name: "Office DSH".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let directory = std::path::PathBuf::from(&project.root_path);
    std::fs::write(directory.join("original.docx"), b"old office").unwrap();
    let binding = WorkspaceBinding {
        workspace_id: metadata.workspace_id,
        generation: "test-runtime".into(),
    };
    let identity = Identity {
        workspace_id: binding.workspace_id.clone(),
        workspace_generation: binding.generation.clone(),
        root,
        fingerprint: "fixture".into(),
        context: AssistantContext::Project(ProjectContext {
            id: project.id,
            name: project.name,
            directory: directory.clone(),
        }),
    };
    let store = TestStore {
        db: Mutex::new(db),
        binding,
        paths,
        fence: Arc::new(WorkspaceCommitFence::new()),
        alive: Arc::new(AtomicBool::new(true)),
    };
    let grants = Mutex::new(HashMap::new());
    let inspect =
        json!({"operation":"officeInspect","sessionId":"session-a","path":"original.docx"});
    let old = call(inspect)
        .execute(&store, &TestEngine, &identity, &grants)
        .await
        .unwrap();
    assert_eq!(old["sourceRef"]["fileVersion"], 1);
    assert_eq!(old["model"]["text"], "old office");
    let edit = json!({"operation":"officeEdit","mode":"workspace-write","sessionId":"session-a","requestId":"session-a:stable-call","sourceRef":old["sourceRef"],"edits":[{"text":"saved office"}]});
    let saved = call(edit.clone())
        .execute(&store, &TestEngine, &identity, &grants)
        .await
        .unwrap();
    assert_eq!(saved["sourceRef"]["fileVersion"], 2);
    assert_eq!(
        saved["sourceRef"]["revision"],
        saved["commit"]["receipt"]["contentHash"]
    );
    assert_eq!(
        std::fs::read(directory.join("original.docx")).unwrap(),
        b"saved office"
    );
    assert_eq!(
        call(edit.clone())
            .execute(&store, &TestEngine, &identity, &grants)
            .await
            .unwrap(),
        saved
    );
    let history =
        json!({"operation":"officeInspect","sessionId":"session-a","sourceRef":old["sourceRef"]});
    assert_eq!(
        call(history)
            .execute(&store, &TestEngine, &identity, &grants)
            .await
            .unwrap()["model"]["text"],
        "old office"
    );
    let mut stale = edit.clone();
    stale["requestId"] = json!("session-a:new-call");
    assert_eq!(
        call(stale)
            .execute(&store, &TestEngine, &identity, &grants)
            .await
            .unwrap_err()
            .code,
        ErrorCode::RevisionConflict
    );
    let mut changed = edit.clone();
    changed["edits"] = json!([{"text":"different"}]);
    assert_eq!(
        call(changed)
            .execute(&store, &TestEngine, &identity, &grants)
            .await
            .unwrap_err()
            .code,
        ErrorCode::IdempotencyConflict
    );
    let mut forged = old["sourceRef"].clone();
    forged["object"]["scope"] = json!({"kind":"project","projectId":9999});
    assert!(
        call(json!({"operation":"officeInspect","sessionId":"session-a","sourceRef":forged}))
            .execute(&store, &TestEngine, &identity, &grants)
            .await
            .is_err()
    );
    assert!(call(
        json!({"operation":"officeInspect","sessionId":"session-a","path":"../outside.docx"})
    )
    .execute(&store, &TestEngine, &identity, &grants)
    .await
    .is_err());
    let (grant, token) = crate::lock_mutex(&grants).get("session-a").unwrap().clone();
    let request = store
        .with_current(|binding, db| {
            db.agent_connection_authenticate(binding, &grant, &token, "check-grant")
        })
        .unwrap();
    assert!(matches!(
        request.caller,
        crate::agent::access::Caller::Connection { .. }
    ));
    assert!(request
        .authorize(
            &store.binding,
            &Scope::Project {
                project_id: project.id
            },
            "file.update"
        )
        .is_ok());
    store
        .with_current(|binding, db| db.agent_connection_revoke(binding, &grant))
        .unwrap();
    assert_eq!(
        call(edit)
            .execute(&store, &TestEngine, &identity, &grants)
            .await
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    assert_eq!(
        std::fs::read(directory.join("original.docx")).unwrap(),
        b"saved office"
    );
}

#[test]
fn dsh_office_rejects_unbound_session_and_untrusted_authority_payload() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    let other = root.path().join("other");
    std::fs::create_dir(&project).unwrap();
    std::fs::create_dir(&other).unwrap();
    let directory = project.canonicalize().unwrap();
    let identity = Identity { workspace_id: "workspace".into(), workspace_generation: "opening".into(), root: root.path().to_path_buf(), fingerprint: "profile".into(), context: AssistantContext::Project(ProjectContext { id: 7, name: "Project".into(), directory: directory.clone() }) };
    let context = json!({"kind":"project","id":7,"directory":project});
    assert!(validate_session_context(&context, &identity).is_ok());
    for forged in [
        json!({"kind":"project","id":8,"directory":project}),
        json!({"kind":"workspace","id":"workspace","directory":project}),
        json!({"kind":"project","id":7,"directory":other}),
        json!({"kind":"project","id":7,"directory":root.path()}),
        json!({}),
    ] {
        assert_eq!(validate_session_context(&forged, &identity).unwrap_err().code, ErrorCode::ScopeDenied);
    }
    std::fs::remove_dir(&project).unwrap();
    assert_eq!(validate_session_context(&context, &identity).unwrap_err().code, ErrorCode::ScopeDenied);
    for value in [
        json!({"operation":"officeInspect","sessionId":"real","path":"original.docx","projectId":9999}),
        json!({"operation":"officeEdit","mode":"workspace-write","sessionId":"real","sourceRef":{},"edits":[]}),
    ] {
        assert!(serde_json::from_value::<SourceRequest>(value).is_err());
    }
}

fn selected(value: Value) -> SelectionCall {
    SelectionCall::parse(serde_json::from_value(value).unwrap(), "native-frame").unwrap()
}
fn apply_selection(id: &str, request: &str, text: &str) -> Value {
    json!({"operation":"officeSelectionApply","sessionId":"session-a","selectionId":id,"requestId":request,"mode":"workspace-write","change":{"text":text}})
}
fn editor_reply(request: &EditRequest, text: Option<&str>) -> crate::office_selection::Reply {
    serde_json::from_value(json!({"editorId":request.editor_id,"selectionId":request.selection_id,"requestId":request.request_id,"text":text})).unwrap()
}
async fn selection_fixture() -> (
    tempfile::TempDir,
    TestStore,
    crate::agent::models::ObjectRef,
    i64,
    std::path::PathBuf,
) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let (metadata, paths) = create_workspace(&root, "password").unwrap();
    let mut db = Database::open(&paths.db_path, &root, None).unwrap();
    db.bind_native_workspace(&metadata.workspace_id).unwrap();
    let project = db
        .project_create(crate::models::ProjectCreateInput {
            name: "Selection DSH".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let directory = std::path::PathBuf::from(&project.root_path);
    std::fs::write(directory.join("draft.docx"), b"original file").unwrap();
    let binding = WorkspaceBinding {
        workspace_id: metadata.workspace_id,
        generation: "selection-runtime".into(),
    };
    let identity = Identity {
        workspace_id: binding.workspace_id.clone(),
        workspace_generation: binding.generation.clone(),
        root,
        fingerprint: "fixture".into(),
        context: AssistantContext::Project(ProjectContext {
            id: project.id,
            name: project.name,
            directory: directory.clone(),
        }),
    };
    let store = TestStore {
        db: Mutex::new(db),
        binding,
        paths,
        fence: Arc::new(WorkspaceCommitFence::new()),
        alive: Arc::new(AtomicBool::new(true)),
    };
    let value =
        call(json!({"operation":"officeInspect","sessionId":"session-a","path":"draft.docx"}))
            .execute(&store, &TestEngine, &identity, &Mutex::new(HashMap::new()))
            .await
            .unwrap();
    let object = serde_json::from_value(value["sourceRef"]["object"].clone()).unwrap();
    (temp, store, object, project.id, directory)
}
fn register_selected(
    selections: &Selections,
    binding: &WorkspaceBinding,
    object: crate::agent::models::ObjectRef,
    id: &str,
) {
    selections
        .register(
            binding,
            "main",
            crate::office_selection::Registration {
                object,
                editor_id: id.into(),
                selection_id: id.into(),
                format: "docx".into(),
                text: "冻结原文".into(),
                label: "draft.docx".into(),
            },
        )
        .unwrap();
    selections
        .bind(
            binding,
            "main",
            &serde_json::from_value(json!({"selectionId":id,"sessionId":"session-a"})).unwrap(),
        )
        .unwrap();
}
#[tokio::test]
async fn dsh_office_selection_authorizes_real_file_and_only_returns_editor_drafts() {
    let (_temp, store, object, project, directory) = selection_fixture().await;
    let selections = Selections::default();
    register_selected(&selections, &store.binding, object.clone(), "selection");
    let read = json!({"operation":"officeSelectionRead","sessionId":"session-a","selectionId":"selection"});
    assert_eq!(
        selected(read.clone())
            .execute(
                &store,
                &selections,
                project,
                store.alive.clone(),
                |_| panic!("read must not emit")
            )
            .await
            .unwrap()["text"],
        "冻结原文"
    );
    let mut foreign = read.clone();
    foreign["sessionId"] = json!("other-session");
    assert_eq!(
        selected(foreign)
            .execute(
                &store,
                &selections,
                project,
                store.alive.clone(),
                |_| panic!()
            )
            .await
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    assert!(selected(read)
        .execute(
            &store,
            &selections,
            project + 1,
            store.alive.clone(),
            |_| panic!()
        )
        .await
        .is_err());
    let input = apply_selection("selection", "call", "润色");
    let result = selected(input.clone())
        .execute(
            &store,
            &selections,
            project,
            store.alive.clone(),
            |request| {
                assert_eq!(request.window, "main");
                assert_eq!(request.change, json!({"text":"润色"}));
                selections.claim(&store.binding, "main", &editor_reply(request, None))?;
                selections.reply(&store.binding, "main", editor_reply(request, Some("润色")))
            },
        )
        .await
        .unwrap();
    assert_eq!(result["saved"], false);
    assert_eq!(result["status"], "editor_draft");
    assert_eq!(
        selected(input.clone())
            .execute(
                &store,
                &selections,
                project,
                store.alive.clone(),
                |_| panic!("replay must not apply twice")
            )
            .await
            .unwrap(),
        result
    );
    assert_eq!(
        selected(apply_selection("selection", "call", "different"))
            .execute(
                &store,
                &selections,
                project,
                store.alive.clone(),
                |_| panic!()
            )
            .await
            .unwrap_err()
            .code,
        ErrorCode::IdempotencyConflict
    );
    // A claimed scope cannot authorize a real File owned by another Project.
    let mut forged = object.clone();
    forged.scope = Scope::Project {
        project_id: project + 100,
    };
    register_selected(&selections, &store.binding, forged, "forged");
    assert!(selected(apply_selection("forged", "forged-call", "bad"))
        .execute(
            &store,
            &selections,
            project + 100,
            store.alive.clone(),
            |_| panic!("forged ownership must never emit")
        )
        .await
        .is_err());
    let db = crate::lock_mutex(&store.db);
    let file = db.project_file_resolve(&object).unwrap();
    assert_eq!(file.version_number, 1);
    assert_eq!(
        std::fs::read(directory.join(&file.relative_path)).unwrap(),
        b"original file"
    );
}
#[tokio::test]
async fn dsh_office_selection_emit_failure_and_revoke_prevent_late_claim() {
    let (_temp, store, object, project, _directory) = selection_fixture().await;
    let selections = Selections::default();
    register_selected(&selections, &store.binding, object.clone(), "failed");
    let failed_request = Mutex::new(None);
    let input = apply_selection("failed", "emit-call", "new");
    assert!(selected(input.clone())
        .execute(
            &store,
            &selections,
            project,
            store.alive.clone(),
            |request| {
                *crate::lock_mutex(&failed_request) = Some(request.clone());
                Err(AgentError::new(ErrorCode::EditorBusy, "emit failed"))
            }
        )
        .await
        .is_err());
    let request = crate::lock_mutex(&failed_request).clone().unwrap();
    assert!(selections
        .claim(&store.binding, "main", &editor_reply(&request, None))
        .is_err());
    assert!(selected(input)
        .execute(
            &store,
            &selections,
            project,
            store.alive.clone(),
            |_| panic!("failed call must not dispatch again")
        )
        .await
        .is_err());
    register_selected(&selections, &store.binding, object, "revoked");
    let request = Mutex::new(None);
    assert!(selected(apply_selection("revoked", "revoke-call", "new"))
        .execute(&store, &selections, project, store.alive.clone(), |event| {
            *crate::lock_mutex(&request) = Some(event.clone());
            let alive = store.alive.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                alive.store(false, Ordering::SeqCst);
            });
            Ok(())
        })
        .await
        .is_err());
    assert!(selections
        .claim(
            &store.binding,
            "main",
            &editor_reply(&crate::lock_mutex(&request).clone().unwrap(), None)
        )
        .is_err());
}
#[test]
fn dsh_office_selection_requires_native_write_mode_and_rejects_forged_fields() {
    for mode in ["read-only", "untrusted", "invented"] {
        let mut value = apply_selection("selection", "call", "new");
        value["mode"] = json!(mode);
        assert_eq!(
            SelectionCall::parse(serde_json::from_value(value).unwrap(), "frame")
                .err()
                .unwrap()
                .code,
            ErrorCode::ScopeDenied
        );
    }
    for mode in ["workspace-write", "danger-full-access"] {
        let mut value = apply_selection("selection", "call", "new");
        value["mode"] = json!(mode);
        assert!(SelectionCall::parse(serde_json::from_value(value).unwrap(), "frame").is_ok());
    }
    let mut forged = apply_selection("selection", "call", "new");
    forged["projectId"] = json!(999);
    assert!(serde_json::from_value::<SourceRequest>(forged).is_err());
}

#[tokio::test]
async fn dsh_office_selection_timeout_is_final_and_late_claim_cannot_mutate() {
    let (_temp, store, object, project, _directory) = selection_fixture().await;
    let selections = Selections::default();
    register_selected(&selections, &store.binding, object, "timed-out");
    let event = Mutex::new(None);
    let input = apply_selection("timed-out", "timeout-call", "new");
    let error = selected(input.clone())
        .execute(
            &store,
            &selections,
            project,
            store.alive.clone(),
            |request| {
                *crate::lock_mutex(&event) = Some(request.clone());
                Ok(())
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::EditorBusy);
    assert!(error.message.contains("超时"));
    assert!(selections
        .claim(
            &store.binding,
            "main",
            &editor_reply(&crate::lock_mutex(&event).clone().unwrap(), None)
        )
        .is_err());
    let retried = selected(input)
        .execute(&store, &selections, project, store.alive.clone(), |_| {
            panic!("timeout replay cannot emit")
        })
        .await
        .unwrap_err();
    assert_eq!(retried.code, error.code);
    assert_eq!(retried.message, error.message);
}

#[tokio::test]
async fn workspace_dsh_office_commits_real_versions_and_scopes_live_selection() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let (metadata, paths) = create_workspace(&root, "password").unwrap();
    let mut db = Database::open(&paths.db_path, &root, None).unwrap();
    db.bind_native_workspace(&metadata.workspace_id).unwrap();
    let file_root = db.ensure_file_scope_root(None).unwrap();
    std::fs::write(file_root.join("original.docx"), b"old office").unwrap();
    let binding = WorkspaceBinding {
        workspace_id: metadata.workspace_id,
        generation: "workspace-office-runtime".into(),
    };
    let identity = Identity {
        workspace_id: binding.workspace_id.clone(),
        workspace_generation: binding.generation.clone(),
        root: root.clone(),
        fingerprint: "fixture".into(),
        context: AssistantContext::Workspace { directory: root },
    };
    let store = TestStore {
        db: Mutex::new(db),
        binding,
        paths,
        fence: Arc::new(WorkspaceCommitFence::new()),
        alive: Arc::new(AtomicBool::new(true)),
    };
    let grants = Mutex::new(HashMap::new());
    let old = call(
        json!({"operation":"officeInspect","sessionId":"session-a","path":"files/original.docx"}),
    )
    .execute(&store, &TestEngine, &identity, &grants)
    .await
    .unwrap();
    assert_eq!(
        old["sourceRef"]["object"]["scope"],
        json!({"kind":"workspace"})
    );
    let edit = json!({"operation":"officeEdit","mode":"workspace-write","sessionId":"session-a","requestId":"session-a:stable-call","sourceRef":old["sourceRef"],"edits":[{"text":"saved office"}]});
    let saved = call(edit.clone())
        .execute(&store, &TestEngine, &identity, &grants)
        .await
        .unwrap();
    assert_eq!(saved["sourceRef"]["fileVersion"], 2);
    assert_eq!(
        std::fs::read(file_root.join("original.docx")).unwrap(),
        b"saved office"
    );
    let replay = call(edit)
        .execute(&store, &TestEngine, &identity, &grants)
        .await
        .unwrap();
    assert_eq!(replay["sourceRef"], saved["sourceRef"]);
    // A Project created after the first Workspace Office request is resolved
    // from the current DB membership, not a grant snapshot or raw root access.
    let project = crate::lock_mutex(&store.db)
        .project_create(crate::models::ProjectCreateInput {
            name: "Workspace readable Project".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let project_path = std::path::PathBuf::from(&project.root_path).join("project.docx");
    std::fs::write(&project_path, b"project office").unwrap();
    let project_source =
        call(json!({"operation":"officeInspect","sessionId":"session-a","path":project_path}))
            .execute(&store, &TestEngine, &identity, &grants)
            .await
            .unwrap();
    assert_eq!(
        project_source["sourceRef"]["object"]["scope"],
        json!({"kind":"project","projectId":project.id})
    );
    let project_saved = call(json!({"operation":"officeEdit","mode":"workspace-write","sessionId":"session-a","requestId":"session-a:project-call","sourceRef":project_source["sourceRef"],"edits":[{"text":"saved office"}]}))
        .execute(&store, &TestEngine, &identity, &grants).await.unwrap();
    assert_eq!(project_saved["sourceRef"]["fileVersion"], 2);
    assert_eq!(std::fs::read(&project_path).unwrap(), b"saved office");
    let restricted = Identity {
        context: AssistantContext::Project(ProjectContext {
            id: project.id,
            name: project.name,
            directory: std::path::PathBuf::from(&project.root_path),
        }),
        ..identity.clone()
    };
    assert!(call(json!({"operation":"officeInspect","sessionId":"session-a","path":file_root.join("original.docx")}))
        .execute(&store, &TestEngine, &restricted, &Mutex::new(HashMap::new())).await.is_err());
    let mut forged = old["sourceRef"].clone();
    forged["object"]["scope"] = json!({"kind":"project","projectId":project.id + 100});
    assert!(call(json!({"operation":"officeEdit","mode":"workspace-write","sessionId":"session-a","requestId":"forged-edit","sourceRef":forged,"edits":[]}))
        .execute(&store, &TestEngine, &identity, &grants).await.is_err());
    let selections = Selections::default();
    let object = serde_json::from_value(saved["sourceRef"]["object"].clone()).unwrap();
    register_selected(&selections, &store.binding, object, "workspace-selection");
    let read = json!({"operation":"officeSelectionRead","sessionId":"session-a","selectionId":"workspace-selection"});
    assert_eq!(
        selected(read.clone())
            .execute(&store, &selections, None, store.alive.clone(), |_| panic!())
            .await
            .unwrap()["text"],
        "冻结原文"
    );
    assert!(selected(read)
        .execute(
            &store,
            &selections,
            Some(1),
            store.alive.clone(),
            |_| panic!()
        )
        .await
        .is_err());
    let draft = selected(apply_selection(
        "workspace-selection",
        "workspace-draft",
        "Workspace revised draft",
    ))
    .execute(&store, &selections, None, store.alive.clone(), |request| {
        selections.claim(&store.binding, "main", &editor_reply(request, None))?;
        selections.reply(
            &store.binding,
            "main",
            editor_reply(request, Some("Workspace revised draft")),
        )
    })
    .await
    .unwrap();
    assert_eq!(draft["saved"], false);
    assert_eq!(
        std::fs::read(file_root.join("original.docx")).unwrap(),
        b"saved office"
    );
}

#[test]
fn office_edit_native_rejects_readonly_mode() {
    let source:Value=serde_json::from_str(include_str!("../../packages/dsh-assistant/test/fixtures/office-source-ref.json")).unwrap();
    let operation=serde_json::from_value(json!({"operation":"officeEdit","mode":"read-only","sessionId":"s","requestId":"r","sourceRef":source,"edits":[]})).unwrap();
    assert_eq!(OfficeCall::parse(operation,"frame").err().unwrap().code,ErrorCode::ScopeDenied);
}

#[tokio::test]
#[ignore = "requires prepared complete GenOffice runtime"]
async fn full_office_creation_real_engines_keep_identity_and_versions_for_project_and_workspace() {
    for workspace in [false,true] {
        for (format,content) in [
            ("docx",include_str!("../../packages/dsh-assistant/test/fixtures/office-authoring/word.json")),
            ("xlsx",include_str!("../../packages/dsh-assistant/test/fixtures/office-authoring/excel.json")),
            ("pptx",include_str!("../../packages/dsh-assistant/test/fixtures/office-authoring/powerpoint.json")),
        ] {
            let (_temp,store,mut identity)=create_fixture();
            if workspace {
                crate::lock_mutex(&store.db).ensure_file_scope_root(None).unwrap();
                identity.context=AssistantContext::Workspace{directory:identity.root.clone()};
            }
            let grants=Mutex::new(HashMap::new());
            let worker=crate::office_worker::OfficeWorker::development().unwrap();
            let create=json!({"operation":"officeCreate","sessionId":"full-office","requestId":"full-create","mode":"workspace-write",
                "name":format!("完整中文.{format}"),"content":serde_json::from_str::<Value>(content).unwrap()});
            let first=OfficeCreateCall::parse(serde_json::from_value(create.clone()).unwrap()).unwrap()
                .execute(&store,&worker,&identity,&grants,None).await.unwrap();
            assert_eq!(first["model"]["format"],format);
            assert_eq!(first["sourceRef"]["fileVersion"],1);
            assert_eq!(first["sourceRef"]["object"]["scope"]["kind"],if workspace {"workspace"}else{"project"});
            let edits=match format {
                "docx"=>json!([{"type":"operations","ops":[{"op":"findReplace","find":"复杂排版正文","replace":"原生第二版"}]}]),
                "xlsx"=>json!([{"sheetId":first["model"]["sheets"][0]["id"],"row":4,"column":0,"kind":"string","value":"原生第二版"}]),
                _=>{
                    let element=first["model"]["textElements"].as_array().unwrap().iter().find(|e|e["editable"]==true).unwrap();
                    json!([{"kind":"text","slideIndex":element["slideIndex"],"cNvPrId":element["cNvPrId"],"paragraphIndex":0,"runIndex":0,"text":"原生第二版"}])
                }
            };
            let edit=json!({"operation":"officeEdit","mode":"workspace-write","sessionId":"full-office","requestId":"full-v2","sourceRef":first["sourceRef"],"edits":edits});
            let second=call(edit.clone()).execute(&store,&worker,&identity,&grants).await.unwrap();
            assert_eq!(second["sourceRef"]["object"],first["sourceRef"]["object"]);
            assert_eq!(second["sourceRef"]["fileVersion"],2);
            assert!(second["model"].to_string().contains("原生第二版"));
            let mut stale=edit;stale["requestId"]=json!("full-stale");
            assert_eq!(call(stale).execute(&store,&worker,&identity,&grants).await.unwrap_err().code,ErrorCode::RevisionConflict);
            let replay=OfficeCreateCall::parse(serde_json::from_value(create).unwrap()).unwrap()
                .execute(&store,&worker,&identity,&grants,None).await.unwrap();
            assert_eq!(replay["sourceRef"],first["sourceRef"]);
            assert_eq!(replay["commit"],first["commit"]);
        }
    }
}
