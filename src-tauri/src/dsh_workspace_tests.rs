use super::*;

#[test]
fn uncached_passwordless_migration_reopens_with_repaired_default_and_skips_locked_candidate() {
    use crate::agent::errors::ErrorCode;
    use crate::models::{
        AiCapabilityBindingUpsertInput, AiNetworkSettingsUpsertInput, AiProfileTestInput,
        AiProviderProfileUpsertInput, AiProxyMode,
    };
    use std::io::{BufRead, BufReader, Read, Write};

    let root = tempfile::tempdir().unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
    let (legacy, paths) =
        crate::workspace::create_workspace(root.path(), "legacy-password").unwrap();
    let mut db =
        crate::db::Database::open(&paths.db_path, root.path(), Some("legacy-password".into()))
            .unwrap();
    db.ai_network_settings_upsert(AiNetworkSettingsUpsertInput {
        mode: AiProxyMode::Direct,
        proxy_url: None,
        username: None,
        password: None,
    })
    .unwrap();
    let mut default_input = AiProviderProfileUpsertInput {
        id: None,
        name: "Default".into(),
        provider_family: "openai_compatible".into(),
        base_url,
        api_key: Some("legacy-default-key".into()),
        default_model: "fixture-model".into(),
        supports_text: true,
        supports_image: false,
        supports_file: false,
        enabled: true,
    };
    let default_id = db.ai_profile_upsert(default_input.clone()).unwrap().id;
    default_input.id = Some(default_id);
    let mut candidate_input = AiProviderProfileUpsertInput {
        id: None,
        name: "Candidate".into(),
        api_key: Some("legacy-candidate-key".into()),
        ..default_input.clone()
    };
    let candidate = db.ai_profile_upsert(candidate_input.clone()).unwrap();
    candidate_input.id = Some(candidate.id);
    db.ai_binding_upsert(AiCapabilityBindingUpsertInput {
        capability: "default".into(),
        use_default: false,
        profile_id: Some(default_id),
        model: None,
    })
    .unwrap();
    assert_eq!(
        db.agent_resolve_profile(None).unwrap().profile.api_key,
        "legacy-default-key"
    );
    drop(db);

    // Windows can reach migration without the old password in its local cache.
    let (migrated, paths, key) =
        crate::open_passwordless_workspace(root.path(), None, |_| Ok(None)).unwrap();
    assert_eq!(migrated.workspace_id, legacy.workspace_id);
    assert_ne!(key, "legacy-password");
    let mut db = crate::db::Database::open(&paths.db_path, root.path(), Some(key.clone())).unwrap();
    assert_eq!(
        db.agent_resolve_profile(None).err().unwrap().code,
        ErrorCode::SecretsLocked,
        "an unreadable selected default must still fail"
    );
    default_input.api_key = Some("repaired-default-key".into());
    db.ai_profile_upsert(default_input.clone()).unwrap();
    drop(db);

    let (_, paths, reopened_key) =
        crate::open_passwordless_workspace(root.path(), None, |_| Ok(None)).unwrap();
    assert_eq!(reopened_key, key);
    let mut db =
        crate::db::Database::open(&paths.db_path, root.path(), Some(reopened_key)).unwrap();
    assert_eq!(
        db.agent_resolve_profile(None).unwrap().profile.api_key,
        "repaired-default-key"
    );

    // Exercise the settings probe with the saved default key, not a draft key.
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(socket.try_clone().unwrap());
        let mut request_line = String::new();
        reader.read_line(&mut request_line).unwrap();
        assert!(request_line.starts_with("POST /v1/chat/completions "));
        let mut length = 0;
        let mut authenticated = false;
        loop {
            let mut line = String::new();
            assert_ne!(reader.read_line(&mut line).unwrap(), 0);
            if line == "\r\n" {
                break;
            }
            let header = line.to_ascii_lowercase();
            if let Some(value) = header.strip_prefix("content-length:") {
                length = value.trim().parse::<usize>().unwrap();
            }
            if let Some(value) = header.strip_prefix("authorization:") {
                authenticated = value.trim() == "bearer repaired-default-key";
            }
        }
        assert!(authenticated);
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(request["model"], "fixture-model");
        let response = r#"{"model":"fixture-model","choices":[{"message":{"role":"assistant","content":"OK"}}]}"#;
        write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
            response.len()
        )
        .unwrap();
    });
    let tested = db
        .ai_profile_test(AiProfileTestInput {
            id: Some(default_id),
            name: default_input.name,
            provider_family: default_input.provider_family,
            base_url: default_input.base_url,
            api_key: None,
            default_model: default_input.default_model,
            supports_text: true,
            supports_image: false,
            supports_file: false,
            enabled: true,
            test_image: false,
        })
        .unwrap();
    server.join().unwrap();
    assert!(tested.success);
    assert_eq!(tested.resolved_model.as_deref(), Some("fixture-model"));
    assert_eq!(
        db.agent_resolve_profile(Some(candidate.id))
            .err()
            .unwrap()
            .code,
        ErrorCode::SecretsLocked,
        "a successful default probe does not repair another profile's ciphertext"
    );

    let configured = Configuration::configured_profiles(&mut db).unwrap();
    assert_eq!(configured.len(), 1);
    assert_eq!(configured[0].0, default_id);
    assert_eq!(configured[0].1.api_key, "repaired-default-key");
    let settings = db.ai_settings_get().unwrap();
    assert_eq!(settings.profiles.len(), 2);
    let retained = settings
        .profiles
        .iter()
        .find(|p| p.id == candidate.id)
        .unwrap();
    assert_eq!(
        serde_json::to_value(retained).unwrap(),
        serde_json::to_value(&candidate).unwrap(),
        "catalog filtering must preserve the old configuration"
    );

    candidate_input.api_key = Some("repaired-candidate-key".into());
    db.ai_profile_upsert(candidate_input).unwrap();
    let restored = Configuration::configured_profiles(&mut db).unwrap();
    assert_eq!(
        restored.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
        vec![default_id, candidate.id]
    );
    assert_eq!(restored[1].1.api_key, "repaired-candidate-key");
    assert_eq!(
        db.agent_resolve_profile(None).unwrap().profile.api_key,
        "repaired-default-key"
    );
}

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
