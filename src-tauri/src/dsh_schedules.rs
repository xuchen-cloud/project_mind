use super::*;

fn enabled_tasks(bytes: &[u8]) -> Result<bool, String> {
    #[derive(Deserialize)]
    struct Store {
        version: u32,
        tasks: Vec<Task>,
    }
    #[derive(Deserialize)]
    struct Task {
        enabled: bool,
    }
    let store: Store =
        serde_json::from_slice(bytes).map_err(|error| format!("无法读取定时任务文件：{error}"))?;
    if store.version != 1 {
        return Err("不支持的定时任务文件版本".into());
    }
    Ok(store.tasks.iter().any(|task| task.enabled))
}

fn verify_binding(
    app: &tauri::AppHandle,
    binding: &crate::agent::models::WorkspaceBinding,
) -> Result<(), String> {
    let state = app.state::<crate::AppState>();
    let current = crate::lock_mutex(&state.current_workspace);
    let runtime = current.as_ref().ok_or("工作区已关闭")?;
    if &runtime.agent_binding != binding {
        return Err("工作区已变化".into());
    }
    if !runtime.ai_secrets_unlocked() {
        return Err("请先解锁工作区，再使用定时任务".into());
    }
    Ok(())
}

pub(super) async fn request_with_admission(
    app: &tauri::AppHandle,
    binding: &crate::agent::models::WorkspaceBinding,
    request: serde_json::Value,
    admit: impl FnOnce() -> Result<(), String> + Send,
) -> Result<serde_json::Value, String> {
    let state = app.state::<DshAssistantState>();
    let mut runtimes = state.inner.lock().await;
    if state.stopping.load(Ordering::SeqCst) {
        return Err("应用正在退出".into());
    }
    verify_binding(app, binding)?;
    let pending = !crate::lock_mutex(&state.requests).is_empty();
    let inner = runtimes.ensure_scope(app, None, pending).await?;
    verify_binding(app, binding)?;
    inner.check_ready(app)?;
    admit()?;
    let process = inner.process.as_mut().expect("ready runtime");
    let value = session_request(
        &process.url,
        &process.session_http,
        &mut process.session_cookie,
        SessionRequest::ScheduledTasks(request),
    )
    .await?;
    verify_binding(app, binding)?;
    inner.check_ready(app)?;
    Ok(value)
}

pub(super) fn start(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut previous_error = None;
        loop {
            let result = restore(&app).await;
            match result {
                Err(error) => {
                    if previous_error.as_ref() != Some(&error) {
                        eprintln!("Workspace scheduled tasks: {error}");
                    }
                    previous_error = Some(error);
                }
                Ok(()) => previous_error = None,
            }
            tokio::time::sleep(Duration::from_secs(15)).await;
        }
    });
}

async fn restore(app: &tauri::AppHandle) -> Result<(), String> {
    // Copy authority and path before I/O; never hold the Workspace mutex over await.
    let target = {
        let state = app.state::<crate::AppState>();
        let current = crate::lock_mutex(&state.current_workspace);
        current
            .as_ref()
            .filter(|runtime| runtime.ai_secrets_unlocked())
            .map(|runtime| {
                workspace_runtime_home(&runtime.agent_binding.workspace_id).map(|home| {
                    (
                        runtime.agent_binding.clone(),
                        home.join("scheduled-tasks.json"),
                    )
                })
            })
            .transpose()?
    };
    let Some((binding, file)) = target else {
        return Ok(());
    };
    let bytes = match tokio::fs::read(&file).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let legacy = runtime_data_directory(&assistant_data_root()?, &binding.workspace_id, None)?.join("scheduled-tasks.json");
            match tokio::fs::read(&legacy).await {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(format!("{}: {error}", legacy.display())),
            }
        },
        Err(error) => return Err(format!("{}: {error}", file.display())),
    };
    if !enabled_tasks(&bytes)? {
        return Ok(());
    }
    let state = app.state::<DshAssistantState>();
    let mut runtimes = state.inner.lock().await;
    if state.stopping.load(Ordering::SeqCst) {
        return Ok(());
    }
    verify_binding(app, &binding)?;
    // An existing runtime may be reused, but background recovery never replaces it.
    let inner = runtimes.ensure_scope(app, None, true).await?;
    verify_binding(app, &binding)?;
    inner.check_ready(app)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn scheduled_transport_preserves_native_envelopes_and_null_delete() {
        use axum::{
            http::{header, StatusCode},
            routing::{get, post},
            Json, Router,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!(
            "http://{}/?token=fixture",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let router = Router::new()
            .route("/", get(|| async { (StatusCode::SEE_OTHER, [(header::SET_COOKIE, "fixture=cookie; HttpOnly")], "") }))
            .route("/api/mind/schedules", post(|Json(frame): Json<serde_json::Value>| async move {
                assert_eq!(frame["method"], "mind/schedules");
                assert_eq!(frame["payload"]["args"]["request"]["requestId"], "fixture-request");
                let operation = frame["payload"]["args"]["request"]["operation"].as_str().unwrap();
                let result = if operation == "delete" { serde_json::json!({"ok":true,"value":null}) }
                    else { serde_json::json!({"ok":false,"error":{"message":"Session was removed","code":"gateway/internal","details":{}}}) };
                Json(serde_json::json!({"type":"server-response","rpcId":frame["rpcId"],"result":result}))
            }));
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let client = session_http_client().unwrap();
        let mut cookie = None;
        let deleted = session_request(&url, &client, &mut cookie, SessionRequest::ScheduledTasks(
            serde_json::json!({"operation":"delete","id":"fixture","requestId":"fixture-request"}))).await.unwrap();
        assert!(deleted.is_null());
        assert_eq!(
            session_request(
                &url,
                &client,
                &mut cookie,
                SessionRequest::ScheduledTasks(
                    serde_json::json!({"operation":"create","requestId":"fixture-request"})
                )
            )
            .await
            .unwrap_err(),
            "Session was removed"
        );
        server.abort();
    }

    #[test]
    fn scheduled_restore_uses_the_same_assistant_home_as_node_launch() {
        let root = assistant_data_root().unwrap();
        let workspace = "schedule-fixture-workspace";
        assert_eq!(
            workspace_runtime_home(workspace).unwrap(),
            root.join("projects").join(workspace).join("shared-runtime")
        );
        assert_ne!(
            workspace_runtime_home(workspace)
                .unwrap()
                .join("scheduled-tasks.json"),
            runtime_data_directory(&root, workspace, None)
                .unwrap()
                .join("scheduled-tasks.json")
        );
    }

    #[test]
    fn scheduled_restore_requires_a_valid_enabled_task_store() {
        assert!(!enabled_tasks(br#"{"version":1,"tasks":[]}"#).unwrap());
        assert!(enabled_tasks(br#"{"version":1,"tasks":[{"enabled":true}]}"#).unwrap());
        assert!(!enabled_tasks(br#"{"version":1,"tasks":[{"enabled":false}]}"#).unwrap());
        assert!(enabled_tasks(br#"{"version":2,"tasks":[]}"#).is_err());
        assert!(enabled_tasks(br#"{"version":1,"tasks":[{}]}"#).is_err());
        assert!(enabled_tasks(b"broken").is_err());
    }
}
