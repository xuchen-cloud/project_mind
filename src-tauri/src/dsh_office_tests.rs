use super::*;
use crate::{
    agent::models::Scope,
    file_version_service::FileCommitHost,
    office_worker::OfficeUtility,
    workspace::{create_workspace, WorkspacePaths},
    workspace_commit_fence::WorkspaceCommitFence,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};

struct TestStore {
    db: Mutex<Database>,
    binding: WorkspaceBinding,
    paths: WorkspacePaths,
    fence: Arc<WorkspaceCommitFence>,
}
impl BoundSourceStore for TestStore {
    fn with_current<T>(
        &self,
        f: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        f(&self.binding, &crate::lock_mutex(&self.db))
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
        _: Option<&[Value]>,
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
        project: ProjectContext {
            id: project.id,
            name: project.name,
            directory: directory.clone(),
        },
    };
    let store = TestStore {
        db: Mutex::new(db),
        binding,
        paths,
        fence: Arc::new(WorkspaceCommitFence::new()),
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
    let list: SessionListValue =
        serde_json::from_value(json!({"items":[{"sessionId":"real","cwd":"/fixed/project"}]}))
            .unwrap();
    assert!(validate_session(&list, "real", std::path::Path::new("/fixed/project")).is_ok());
    for (session, cwd) in [("forged", "/fixed/project"), ("real", "/other/project")] {
        assert_eq!(
            validate_session(&list, session, std::path::Path::new(cwd))
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
    }
    for value in [
        json!({"operation":"officeInspect","sessionId":"real","path":"original.docx","projectId":9999}),
        json!({"operation":"officeEdit","sessionId":"real","sourceRef":{},"edits":[]}),
    ] {
        assert!(serde_json::from_value::<SourceRequest>(value).is_err());
    }
}
