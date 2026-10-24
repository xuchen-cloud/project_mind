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
            assert_eq!(id, "session-a:stable-call");
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
    )).unwrap();
    let request = json!({"operation":"officeEdit","sessionId":"real-session",
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
    let edit = json!({"operation":"officeEdit","sessionId":"session-a","requestId":"session-a:stable-call","sourceRef":old["sourceRef"],"edits":[{"text":"saved office"}]});
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
    let list: SessionListValue =
        serde_json::from_value(json!({"items":[{"sessionId":"real","cwd":project}]}))
            .unwrap();
    assert!(validate_session(&list, "real", &directory).is_ok());
    for (session, cwd) in [
        ("forged", directory.as_path()),
        ("", directory.as_path()),
        ("real", other.as_path()),
        ("real", root.path()),
    ] {
        assert_eq!(
            validate_session(&list, session, cwd)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
    }
    std::fs::remove_dir(&project).unwrap();
    assert_eq!(validate_session(&list, "real", &directory).unwrap_err().code, ErrorCode::ScopeDenied);
    for value in [
        json!({"operation":"officeInspect","sessionId":"real","path":"original.docx","projectId":9999}),
        json!({"operation":"officeEdit","sessionId":"real","sourceRef":{},"edits":[]}),
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
