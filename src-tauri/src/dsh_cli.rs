//! Bind the bundled CLI to one native assistant runtime. Shell execution leases
//! arrive only on the parent's private stdin/stdout channel, never from Web RPC.
use super::*;
use crate::agent::bridge::embedded::{EmbeddedCli, EmbeddedCliControl};

#[derive(Deserialize)]
#[serde(tag = "operation", deny_unknown_fields)]
enum LeaseRequest {
    #[serde(rename = "cliLeaseOpen")]
    Open {
        #[serde(rename = "sessionId")]
        session_id: String,
        mode: String,
    },
    #[serde(rename = "cliLeaseClose")]
    Close {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "leaseId")]
        lease_id: String,
    },
}

struct RuntimeLeaseLifetime(EmbeddedCliControl);
impl RuntimeLeaseLifetime {
    fn control(&self) -> &EmbeddedCliControl {
        &self.0
    }
}
impl Drop for RuntimeLeaseLifetime {
    fn drop(&mut self) {
        self.0.revoke();
    }
}

pub(super) async fn launch(
    app: &tauri::AppHandle,
    config: &Configuration,
) -> Result<AssistantProcess, String> {
    let executable = std::env::current_exe()
        .map_err(|_| "无法定位内置 Mind CLI")?
        .parent()
        .ok_or("无法定位内置 Mind CLI")?
        .join(if cfg!(windows) { "mind.exe" } else { "mind" });
    if !executable.is_file() {
        return Err("内置 Mind CLI 缺失，请重新构建或安装包含 CLI 的应用".into());
    }
    let binding = crate::agent::models::WorkspaceBinding {
        workspace_id: config.identity.workspace_id.clone(),
        generation: config.identity.workspace_generation.clone(),
    };
    let discovery = runtime_data_directory(
        &assistant_data_root()?,
        &binding.workspace_id,
        config.identity.project_id(),
    )?
    .join("native-cli.json");
    let cli = EmbeddedCli::start(
        app,
        &binding,
        &config.identity.root,
        config.identity.project_id(),
        discovery,
    )
    .await
    .map_err(|error| error.message)?;
    let mut message = config.message();
    message["cli"] = cli.config();
    message["cli"]["executable"] = serde_json::json!(executable);
    message["cli"]["projectId"] = serde_json::json!(config.identity.project_id());
    let handler = source_handler(app.clone(), config.identity.clone(), session_rpc_id());
    let handler = with_cli(app.clone(), config.identity.clone(), cli.control(), handler);
    let mut process = AssistantProcess::launch_with_source(
        runtime_command(app, config)?,
        &message,
        Some(handler),
    )
    .await?;
    process.native_cli = Some(cli);
    Ok(process)
}

fn validate_session(
    list: &SessionListValue,
    session_id: &str,
    directory: &Path,
) -> Result<(), String> {
    if session_id.is_empty()
        || !list.items.iter().any(|item| {
            item.id == session_id
                && item
                    .cwd
                    .as_deref()
                    .is_some_and(|cwd| Path::new(cwd) == directory)
        })
    {
        return Err("Mind CLI 会话不属于当前助手范围".into());
    }
    Ok(())
}

fn with_cli(
    app: tauri::AppHandle,
    identity: Identity,
    control: EmbeddedCliControl,
    source: SourceHandler,
) -> SourceHandler {
    // The process may exit without RuntimeState being replaced. Dropping its
    // stdout handler also revokes HTTP leases already issued to child shells.
    let lifetime = RuntimeLeaseLifetime(control);
    Arc::new(move |payload, revoked, url, frame_id, alive| {
        if !matches!(
            payload["operation"].as_str(),
            Some("cliLeaseOpen" | "cliLeaseClose")
        ) {
            return source(payload, revoked, url, frame_id, alive);
        }
        if revoked.load(Ordering::SeqCst) || !alive.load(Ordering::SeqCst) {
            return Err("Mind CLI 助手已停止".into());
        }
        let request: LeaseRequest =
            serde_json::from_value(payload).map_err(|_| "无效 Mind CLI 请求")?;
        let session_id = match &request {
            LeaseRequest::Open { session_id, .. } | LeaseRequest::Close { session_id, .. } => {
                session_id
            }
        };
        // A Session identifier supplied by a tool remains a selector: verify it
        // through the real controller and native Workspace identity before use.
        let client = session_http_client()?;
        let value = tokio::runtime::Handle::current().block_on(session_request(
            url,
            &client,
            &mut None,
            SessionRequest::List,
        ))?;
        let list: SessionListValue =
            serde_json::from_value(value).map_err(|_| "无法核验 Mind CLI 会话")?;
        validate_session(&list, session_id, identity.directory())?;
        let state = app.state::<crate::AppState>();
        let current = crate::lock_mutex(&state.current_workspace);
        let runtime = current.as_ref().ok_or("Mind CLI 工作区已关闭")?;
        if !identity.matches_workspace(&runtime.agent_binding, &runtime.paths.root_path)
            || !runtime.ai_secrets_unlocked()
        {
            return Err("Mind CLI 工作区绑定已失效".into());
        }
        identity.validate_context(
            &mut crate::lock_mutex(&runtime.db),
            &runtime.paths.root_path,
        )?;
        if revoked.load(Ordering::SeqCst) {
            return Err("Mind CLI 助手已停止".into());
        }
        match request {
            LeaseRequest::Open { mode, .. } => lifetime
                .control()
                .open(&mode)
                .map_err(|error| error.message),
            LeaseRequest::Close { lease_id, .. } => {
                lifetime
                    .control()
                    .close(&lease_id)
                    .map_err(|error| error.message)?;
                Ok(serde_json::Value::Null)
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_lease_requires_real_session_in_exact_context_directory() {
        let list: SessionListValue = serde_json::from_value(serde_json::json!({"items":[
            {"sessionId":"owned","cwd":"/fixture/project"},
            {"sessionId":"foreign","cwd":"/fixture/other"}
        ]}))
        .unwrap();
        assert!(validate_session(&list, "owned", Path::new("/fixture/project")).is_ok());
        for id in ["", "missing", "foreign"] {
            assert!(validate_session(&list, id, Path::new("/fixture/project")).is_err());
        }
        assert!(validate_session(&list, "owned", Path::new("/fixture")).is_err());
    }

    #[test]
    fn cli_lease_control_cannot_supply_native_grants_or_workspace_paths() {
        let mut value =
            serde_json::json!({"operation":"cliLeaseOpen","sessionId":"owned","mode":"read-only"});
        assert!(serde_json::from_value::<LeaseRequest>(value.clone()).is_ok());
        value["workspace"] = serde_json::json!("/foreign");
        assert!(serde_json::from_value::<LeaseRequest>(value).is_err());
    }

    #[test]
    fn cli_lease_authority_expires_when_process_handler_is_dropped() {
        let control = EmbeddedCliControl::default();
        let handler_lifetime = RuntimeLeaseLifetime(control.clone());
        assert!(control.open("workspace-write").is_ok());
        drop(handler_lifetime);
        assert!(control.open("workspace-write").is_err());
    }
}
