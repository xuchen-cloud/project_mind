use super::*;
use crate::agent::bridge::credentials::FileCredentialStore;

async fn exercise_local_credentials(cli: Option<PathBuf>) {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().canonicalize().unwrap();
    let app_data = root.path().join("app-data");
    std::fs::create_dir(&app_data).unwrap();
    let credential_dir = app_data.join("connection-credentials");
    let store = FileCredentialStore::new(&credential_dir);
    let discovery = app_data.join("agent-bridge.json");
    let id = "0123456789abcdef0123456789abcdef".to_owned();
    let mut db = Database::open(&root.path().join("app.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace("passwordless-fixture").unwrap();
    let binding = WorkspaceBinding {
        workspace_id: "passwordless-fixture".into(),
        generation: "open-1".into(),
    };
    let grant = db
        .agent_connection_create(
            &binding,
            &ConnectionCreateInput {
                client_label: "Local read-only client".into(),
                workspace_content: true,
                project_ids: vec![],
                all_projects: true,
                write_operations: vec![],
            },
            &id,
            TOKEN,
        )
        .unwrap();
    store.save(&id, TOKEN).unwrap();
    drop(store);
    let handler = Arc::new(WorkspaceHandler {
        db: Mutex::new(db),
        binding: Mutex::new(binding.clone()),
        path: workspace.clone(),
        record_worker: None,
        file_paths: None,
        file_fence: None,
    });
    let bridge = transport::start(handler.clone(), discovery.clone())
        .await
        .unwrap();
    let (client, actual_binding) = {
        let discovery = discovery.clone();
        let credential_dir = credential_dir.clone();
        let id = id.clone();
        let workspace = workspace.clone();
        tokio::task::spawn_blocking(move || {
            let reopened = FileCredentialStore::new(credential_dir);
            let client =
                BridgeClient::from_discovery_with_store(&discovery, &id, &reopened).unwrap();
            let binding = client.connect(&id, &workspace, "local-connect").unwrap();
            assert_eq!(
                client
                    .call(&id, &binding, "project.list", json!({}), "local-list")
                    .unwrap(),
                json!([])
            );
            assert_eq!(
                client
                    .call(&id, &binding, "contact.list", json!({}), "local-denied")
                    .unwrap_err()
                    .code,
                ErrorCode::ScopeDenied
            );
            (client, binding)
        })
        .await
        .unwrap()
    };
    assert_eq!(actual_binding, binding);
    assert!(!grant.operations.iter().any(|op| op == "content.create"));
    if let Some(binary) = cli.clone() {
        let app_data = app_data.clone();
        let workspace = workspace.clone();
        let id = id.clone();
        tokio::task::spawn_blocking(move || {
            let result = std::process::Command::new(binary)
                .args(["doctor", "--workspace"])
                .arg(workspace)
                .arg("--connection")
                .arg(id)
                .arg("--json")
                .env("PROJECT_MIND_APP_DATA_DIR", app_data)
                .env_remove("PROJECT_MIND_CLI_DISCOVERY")
                .env_remove("PROJECT_MIND_CLI_TOKEN")
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{} {}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            );
            let result: Value = serde_json::from_slice(&result.stdout).unwrap();
            assert_eq!(result["ok"], true);
        })
        .await
        .unwrap();
    }
    handler
        .db
        .lock()
        .unwrap()
        .agent_connection_revoke(&binding, &id)
        .unwrap();
    let connection = id.clone();
    tokio::task::spawn_blocking(move || {
        assert_eq!(
            client
                .call(
                    &connection,
                    &binding,
                    "project.list",
                    json!({}),
                    "after-revoke"
                )
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
    })
    .await
    .unwrap();
    if let Some(binary) = cli {
        tokio::task::spawn_blocking(move || {
            let result = std::process::Command::new(binary)
                .args(["doctor", "--workspace"])
                .arg(workspace)
                .arg("--connection")
                .arg(id)
                .arg("--json")
                .env("PROJECT_MIND_APP_DATA_DIR", app_data)
                .env_remove("PROJECT_MIND_CLI_DISCOVERY")
                .env_remove("PROJECT_MIND_CLI_TOKEN")
                .output()
                .unwrap();
            assert!(!result.status.success());
            let result: Value = serde_json::from_slice(&result.stdout).unwrap();
            assert_eq!(result["error"]["code"], "SCOPE_DENIED");
        })
        .await
        .unwrap();
    }
    bridge.stop().await.unwrap();
}

#[tokio::test]
async fn local_file_credentials_survive_reopen_and_enforce_scope_and_revocation() {
    exercise_local_credentials(None).await;
}

#[tokio::test]
#[ignore = "requires PROJECT_MIND_TEST_CLI pointing to a freshly built debug mind executable"]
async fn real_cli_uses_local_file_credentials_without_keychain() {
    let binary = std::env::var_os("PROJECT_MIND_TEST_CLI").expect("set PROJECT_MIND_TEST_CLI");
    exercise_local_credentials(Some(PathBuf::from(binary))).await;
}
