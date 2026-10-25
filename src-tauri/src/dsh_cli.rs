//! Bind the bundled CLI to one native assistant runtime. Shell execution leases
//! arrive only on the parent's private stdin/stdout channel, never from Web RPC.
use super::*;
use crate::agent::bridge::embedded::EmbeddedCli;
#[cfg(test)]
use crate::agent::bridge::embedded::EmbeddedCliControl;

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

#[cfg(test)]
struct RuntimeLeaseLifetime(EmbeddedCliControl);
#[cfg(test)]
impl Drop for RuntimeLeaseLifetime {
    fn drop(&mut self) {
        self.0.revoke();
    }
}

pub(super) struct Registry {
    executable: PathBuf,
    scopes: std::sync::Mutex<HashMap<Option<i64>, EmbeddedCli>>,
}
impl Registry {
    pub(super) fn revoke(&self) {
        for cli in crate::lock_mutex(&self.scopes).values() { cli.revoke(); }
    }
    fn config(&self, project: Option<i64>) -> Result<serde_json::Value, String> {
        let scopes = crate::lock_mutex(&self.scopes);
        let mut value = scopes.get(&project).ok_or("Mind CLI 范围尚未注册")?.config();
        value["executable"] = serde_json::json!(self.executable);
        value["projectId"] = serde_json::json!(project);
        Ok(value)
    }
    async fn register(&self, app: &tauri::AppHandle, identity: &Identity) -> Result<serde_json::Value, String> {
        let project = identity.project_id();
        if !crate::lock_mutex(&self.scopes).contains_key(&project) {
            let binding = crate::agent::models::WorkspaceBinding { workspace_id: identity.workspace_id.clone(), generation: identity.workspace_generation.clone() };
            let discovery = runtime_data_directory(&assistant_data_root()?, &binding.workspace_id, project)?.join("native-cli.json");
            let cli = EmbeddedCli::start(app, &binding, &identity.root, project, discovery).await.map_err(|error|error.message)?;
            crate::lock_mutex(&self.scopes).insert(project, cli);
        }
        self.config(project)
    }
}

pub(super) async fn register_context(app: &tauri::AppHandle, process: &mut AssistantProcess, identity: &Identity) -> Result<(), String> {
    let registry = process.cli_registry.as_ref().ok_or("Mind CLI 尚未就绪")?;
    let cli = registry.register(app, identity).await?;
    session_request(&process.url, &process.session_http, &mut process.session_cookie,
        SessionRequest::Private { method: "mind/context".into(), request: serde_json::json!({"context":identity.context_message(),"cli":cli}) }).await?;
    process.context_directories.insert(identity.project_id(), identity.directory().to_path_buf());
    Ok(())
}

pub(super) async fn launch(app: &tauri::AppHandle, config: &Configuration) -> Result<AssistantProcess, String> {
    let executable = std::env::current_exe().map_err(|_| "无法定位内置 Mind CLI")?.parent().ok_or("无法定位内置 Mind CLI")?.join(if cfg!(windows) { "mind.exe" } else { "mind" });
    if !executable.is_file() { return Err("内置 Mind CLI 缺失，请重新构建或安装包含 CLI 的应用".into()); }
    let registry = Arc::new(Registry { executable, scopes: std::sync::Mutex::new(HashMap::new()) });
    let mut message = config.message();
    message["cli"] = registry.register(app, &config.identity).await?;
    message["migration"] = serde_json::json!({"legacyRoot":workspace_data_directory(&assistant_data_root()?, &config.identity.workspace_id)?, "workspaceId":config.identity.workspace_id});
    let (contexts, directories) = {
        let state = app.state::<crate::AppState>();
        let current = crate::lock_mutex(&state.current_workspace);
        let runtime = current.as_ref().ok_or("请先打开工作区")?;
        let mut db = crate::lock_mutex(&runtime.db);
        let projects = db.projects_list(crate::models::ProjectsListInput { include_archived: Some(true) }).map_err(|_|"无法读取助手项目目录")?;
        let mut contexts = vec![config.identity.context_message()];
        let mut directories = HashMap::from([(config.identity.project_id(), config.identity.directory().to_path_buf())]);
        for project in projects {
            directories.insert(Some(project.id), PathBuf::from(&project.root_path));
            // Removed Project folders have no active native capability. Their
            // durable history stays preserved by migration until restored.
            if let Ok(project) = ProjectContext::resolve(&mut db, &runtime.paths.root_path, project.id) {
                let mut identity = config.identity.clone(); identity.context = AssistantContext::Project(project);
                directories.insert(identity.project_id(), identity.directory().to_path_buf());
                contexts.push(identity.context_message());
            }
        }
        (contexts, directories)
    };
    message["contexts"] = serde_json::json!(contexts);
    let handler = source_handler(app.clone(), config.identity.clone(), session_rpc_id());
    let handler = with_registry(app.clone(), config.identity.clone(), registry.clone(), handler);
    let mut process = AssistantProcess::launch_with_registry(runtime_command(app, config)?, &message, Some(handler), Some(registry.clone())).await?;
    process.cli_registry = Some(registry);
    process.context_directories = directories;
    Ok(process)
}

struct RegistryLifetime(Arc<Registry>);
impl Drop for RegistryLifetime {
    fn drop(&mut self) { self.0.revoke(); }
}

fn with_registry(app: tauri::AppHandle, host: Identity, registry: Arc<Registry>, source: SourceHandler) -> SourceHandler {
    let lifetime = RegistryLifetime(registry.clone());
    Arc::new(move |payload, revoked, url, frame_id, alive| {
        if !matches!(payload["operation"].as_str(), Some("cliLeaseOpen" | "cliLeaseClose")) { return source(payload, revoked, url, frame_id, alive); }
        if revoked.load(Ordering::SeqCst) || !alive.load(Ordering::SeqCst) { return Err("Mind CLI 助手已停止".into()); }
        let request: LeaseRequest = serde_json::from_value(payload).map_err(|_|"无效 Mind CLI 请求")?;
        let session_id = match &request { LeaseRequest::Open {session_id,..} | LeaseRequest::Close {session_id,..} => session_id };
        let identity = session_identity(&app, &host, url, session_id)?;
        let scopes = crate::lock_mutex(&lifetime.0.scopes);
        let cli = scopes.get(&identity.project_id()).ok_or("Mind CLI 范围未注册")?;
        if revoked.load(Ordering::SeqCst) || !alive.load(Ordering::SeqCst) { return Err("Mind CLI 助手已停止".into()); }
        match request {
            LeaseRequest::Open {mode,..} => {
                let mut result = cli.control().open(&mode).map_err(|e|e.message)?;
                let mut config = cli.config();
                config["executable"] = serde_json::json!(registry.executable);
                config["projectId"] = serde_json::json!(identity.project_id());
                result["cli"] = config;
                Ok(result)
            }
            LeaseRequest::Close {lease_id,..} => { cli.control().close(&lease_id).map_err(|e|e.message)?; Ok(serde_json::Value::Null) }
        }
    })
}

#[cfg(test)]
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
                    .is_some_and(|cwd| session_directory_matches(Path::new(cwd), directory))
        })
    {
        return Err("Mind CLI 会话不属于当前助手范围".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_lease_requires_real_session_in_exact_context_directory() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let other = root.path().join("other");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&other).unwrap();
        let directory = project.canonicalize().unwrap();
        let list: SessionListValue = serde_json::from_value(serde_json::json!({"items":[
            {"sessionId":"owned","cwd":project},
            {"sessionId":"foreign","cwd":other},
            {"sessionId":"removed","cwd":root.path().join("missing")}
        ]}))
        .unwrap();
        assert!(validate_session(&list, "owned", &directory).is_ok());
        for id in ["", "missing", "foreign", "removed"] {
            assert!(validate_session(&list, id, &directory).is_err());
        }
        assert!(validate_session(&list, "owned", root.path()).is_err());
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
