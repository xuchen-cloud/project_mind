use super::*;

#[test]
fn workspace_chat_is_owned_by_main_window_and_distinct_from_projects() {
    assert!(authorize_scope_label("main", None).is_ok());
    assert!(authorize_scope_label("main", Some(7)).is_ok());
    assert!(authorize_scope_label("project-7", Some(7)).is_ok());
    assert!(authorize_scope_label("project-7", None).is_err());
    assert!(authorize_scope_label("project-7", Some(8)).is_err());
    assert!(authorize_scope_label("other", None).is_err());
    assert!(authorize_scope_label("main", Some(0)).is_err());
    assert!(authorize_scope_label("main", Some(-1)).is_err());
}

#[test]
fn workspace_history_is_stable_separate_and_preserves_existing_project_paths() {
    let data = tempfile::tempdir().unwrap();
    let workspace = runtime_data_directory(data.path(), "workspace-a", None).unwrap();
    let project = runtime_data_directory(data.path(), "workspace-a", Some(7)).unwrap();
    assert_eq!(
        workspace,
        data.path().join("projects/workspace-a/workspace")
    );
    assert_eq!(project, data.path().join("projects/workspace-a/7"));
    assert_eq!(
        project,
        project_data_directory(data.path(), "workspace-a", 7).unwrap()
    );
    assert_ne!(
        workspace,
        runtime_data_directory(data.path(), "workspace-b", None).unwrap()
    );
    assert!(runtime_data_directory(data.path(), "../escape", None).is_err());
    assert!(runtime_data_directory(data.path(), "workspace-a", Some(0)).is_err());
}

#[test]
fn workspace_identity_uses_workspace_directory_and_registered_project_file_ownership() {
    let root = tempfile::tempdir().unwrap();
    let identity = Identity {
        workspace_id: "workspace-a".into(),
        workspace_generation: "open-a".into(),
        root: root.path().to_path_buf(),
        fingerprint: "model-a".into(),
        context: AssistantContext::Workspace {
            directory: root.path().to_path_buf(),
        },
    };
    assert_eq!(identity.project_id(), None);
    assert_eq!(identity.directory(), root.path());
    assert!(identity.project().is_err());
    let mut db = crate::db::Database::open(&root.path().join("workspace.sqlite"), root.path(), None)
        .unwrap();
    db.bind_native_workspace("workspace-a").unwrap();
    let project = db.project_create(crate::models::ProjectCreateInput {
        name: "Registered".into(), summary: None, status: None,
    }).unwrap();
    let file = std::path::Path::new(&project.root_path).join("file.txt");
    std::fs::write(&file, "registered Project content").unwrap();
    let binding = crate::agent::models::WorkspaceBinding {
        workspace_id: "workspace-a".into(),
        generation: "open-a".into(),
    };
    assert!(source_file_input(&db, &identity, &binding, file.to_str(), None).is_ok());
    assert!(source_file_input(&db, &identity, &binding, Some("unknown-project/file.txt"), None).is_err());
    assert!(identity.matches_workspace(&binding, root.path()));
    assert!(!identity.matches_workspace(
        &crate::agent::models::WorkspaceBinding {
            generation: "open-b".into(),
            ..binding
        },
        root.path()
    ));
}

#[cfg(unix)]
#[test]
fn workspace_directory_alias_is_resolved_and_retargeting_invalidates_the_runtime() {
    let root = tempfile::tempdir().unwrap();
    let first = root.path().join("first");
    let second = root.path().join("second");
    let alias = root.path().join("workspace");
    std::fs::create_dir(&first).unwrap();
    std::fs::create_dir(&second).unwrap();
    std::os::unix::fs::symlink(&first, &alias).unwrap();
    let identity = Identity {
        workspace_id: "workspace-a".into(),
        workspace_generation: "open-a".into(),
        root: alias.clone(),
        fingerprint: "model-a".into(),
        context: AssistantContext::Workspace {
            directory: alias.canonicalize().unwrap(),
        },
    };
    let mut db = crate::db::Database::open(&first.join("workspace.sqlite"), &first, None).unwrap();
    assert!(identity.validate_context(&mut db, &alias).is_ok());
    std::fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink(&second, &alias).unwrap();
    assert!(identity.validate_context(&mut db, &alias).is_err());
}

#[test]
fn scoped_carrier_replaces_forged_context_for_http_and_mux_frames() {
    let root = tempfile::tempdir().unwrap();
    for project_id in [7, 8] {
        let identity = Identity {
            workspace_id: "native-workspace".into(), workspace_generation: "opening".into(), root: root.path().to_path_buf(), fingerprint: "profile".into(),
            context: AssistantContext::Project(ProjectContext { id: project_id, name: format!("Project {project_id}"), directory: root.path().join(project_id.to_string()) }),
        };
        for endpoint in ["session/list", "session/create", "session/search", "workspace/initializeDefault", "mind/session/delete"] {
            let mut frame = serde_json::json!({"type":"client-request","rpcId":"correlation","method":endpoint,"payload":{"args":{"_request":{},"request":{"context":{"kind":"workspace","id":"forged"},"sessionId":"selector"}}}});
            route_scope_frame(&mut frame, endpoint, &identity).unwrap();
            assert_eq!(frame["payload"]["args"]["request"]["context"], identity.context_message());
            assert_eq!(frame["rpcId"], "correlation");
            assert_eq!(frame["payload"]["args"]["request"]["sessionId"], "selector");
            assert_eq!(frame["method"], match endpoint { "session/list" => "mind/session/list", "session/create" => "mind/session/create", "session/search" => "mind/session/search", "workspace/initializeDefault" => "mind/workspace/initializeDefault", _ => endpoint });
        }
    }
}

#[tokio::test]
async fn shared_runtime_native_sessions_keep_real_project_membership() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().canonicalize().unwrap();
    let mut identities = Vec::new();
    for id in [7, 8] {
        let directory = workspace.join(id.to_string());
        std::fs::create_dir(&directory).unwrap();
        identities.push(Identity { workspace_id: "2f3dc81a-bb8d-42c0-bf7d-517f8a7e8d84".into(), workspace_generation:"opening".into(), root:workspace.clone(), fingerprint:"profile".into(), context:AssistantContext::Project(ProjectContext{id,name:format!("Project {id}"),directory}) });
    }
    let package = Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/dsh-assistant");
    let mut command = Command::new(development_node(if cfg!(windows) {"node.exe"} else {"node"}).unwrap());
    command.arg(package.join("scripts/runtime.mjs")).args(["--embedded","--host","127.0.0.1","--port","0","--no-open"])
        .env("PROJECT_MIND_DSH_USER_DATA", root.path().join("history"))
        .env("PROJECT_MIND_DSH_PROFILE_DIR", root.path().join("profile"));
    let mut process = AssistantProcess::launch(command, &serde_json::json!({"type":"configure","workspace":{"id":"2f3dc81a-bb8d-42c0-bf7d-517f8a7e8d84","name":"Shared","directory":workspace},"provider":{"name":"Fixture","baseUrl":"http://127.0.0.1:9/v1","modelId":"fixture","apiKey":"fixture-key","supportsImage":false}})).await.unwrap();
    for identity in &identities {
        session_request(&process.url,&process.session_http,&mut process.session_cookie,SessionRequest::Private {method:"mind/context".into(),request:serde_json::json!({"context":identity.context_message()})}).await.unwrap();
    }
    let mut ids = Vec::new();
    for identity in &identities {
        ids.push(create_scope_session(&process.url,&process.session_http,&mut process.session_cookie,identity).await.unwrap());
    }
    for (index, identity) in identities.iter().enumerate() {
        let sessions = list_scope_sessions(&process.url,&process.session_http,&mut process.session_cookie,identity.directory(),identity).await.unwrap();
        assert_eq!(sessions.len(),1);
        assert_eq!(sessions[0].id,ids[index]);
        assert!(validate_session_selection(&ids[1-index],&sessions).is_err());
        let actual = session_request(&process.url,&process.session_http,&mut process.session_cookie,SessionRequest::Private {method:"mind/session/context".into(),request:serde_json::json!({"sessionId":ids[index]})}).await.unwrap();
        assert_eq!(actual["context"]["id"], identity.project_id().unwrap());
    }
    scope_session_request(&process.url,&process.session_http,&mut process.session_cookie,&identities[0],SessionRequest::Delete(ids[1].clone())).await.expect_err("foreign Session delete must fail");
    scope_session_request(&process.url,&process.session_http,&mut process.session_cookie,&identities[0],SessionRequest::Delete(ids[0].clone())).await.unwrap();
    let surviving = list_scope_sessions(&process.url,&process.session_http,&mut process.session_cookie,identities[1].directory(),&identities[1]).await.unwrap();
    assert_eq!(surviving[0].id, ids[1]);
    process.stop().await.unwrap();
}
