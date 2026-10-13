//! DSH owns one Node process per Project and native authenticated client carriers.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Manager, State, Url, Webview};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{mpsc, oneshot, watch, Mutex},
    task::JoinHandle,
};

const READY_TIMEOUT: Duration = Duration::from_secs(45);
const STOP_TIMEOUT: Duration = Duration::from_secs(8);
const READY_PREFIX: &str = "MIND_DSH_READY ";
const SESSION_ERROR: &str = "无法读取当前项目的助手会话，请重试";
const INVALID_READY: &str = "助手启动返回了无效地址，请重试";

#[derive(Default)]
pub(crate) struct DshAssistantState {
    stopping: AtomicBool,
    // Serializes runtime identity changes and authenticated carrier mutations.
    inner: Mutex<ProjectRuntimes>,
    requests: std::sync::Mutex<HashMap<String, PendingRequest>>,
}

#[derive(Default)]
struct ProjectRuntimes {
    projects: HashMap<i64, RuntimeState>,
}

impl ProjectRuntimes {
    fn project_mut(&mut self, project_id: i64) -> Result<&mut RuntimeState, String> {
        self.projects.get_mut(&project_id).ok_or_else(|| "助手尚未就绪，请重新打开助手".into())
    }

    fn active_count(&mut self) -> Result<usize, String> {
        let mut count = 0;
        for runtime in self.projects.values_mut() {
            if let Some(process) = runtime.process.as_mut() {
                if process.child.try_wait().map_err(|_| "无法检查助手进程状态")?.is_none() { count += 1; }
            }
        }
        Ok(count)
    }

    async fn stop(&mut self) -> Result<(), String> {
        let mut failure = None;
        for runtime in self.projects.values_mut() {
            if let Err(error) = runtime.stop().await { failure.get_or_insert(error); }
        }
        self.projects.clear();
        failure.map_or(Ok(()), Err)
    }
}

#[derive(Default)]
struct RuntimeState {
    process: Option<AssistantProcess>,
    identity: Option<Identity>,
    generation: u64,
    connections: HashMap<String, NativeConnection>,
}

#[derive(Clone, PartialEq, Eq)]
struct Identity {
    workspace_id: String,
    workspace_generation: String,
    root: PathBuf,
    fingerprint: String,
    project: ProjectContext,
}

#[derive(Clone, PartialEq, Eq)]
struct ProjectContext {
    id: i64,
    name: String,
    directory: PathBuf,
}

impl ProjectContext {
    fn resolve(
        db: &mut crate::db::Database,
        workspace_root: &Path,
        project_id: i64,
    ) -> Result<Self, String> {
        if !(1..=9_007_199_254_740_991).contains(&project_id) {
            return Err("请选择当前工作区中的有效项目".into());
        }
        let project = db
            .project_page_get(crate::models::ProjectIdInput { project_id })
            .map_err(|_| "项目不存在或已不可用，请重新选择项目".to_string())?
            .project;
        if project.name.trim().is_empty() {
            return Err("项目名称为空，请先修复项目".into());
        }
        let directory = canonical_project_directory(workspace_root, Path::new(&project.root_path))?;
        Ok(Self {
            id: project.id,
            name: project.name,
            directory,
        })
    }
}

fn canonical_project_directory(
    workspace_root: &Path,
    project_root: &Path,
) -> Result<PathBuf, String> {
    if !project_root.is_absolute() {
        return Err("项目目录必须是实际绝对路径".into());
    }
    let workspace = workspace_root
        .canonicalize()
        .map_err(|_| "工作区目录不可用")?;
    let directory = project_root
        .canonicalize()
        .map_err(|_| "项目目录不可用，请检查项目文件夹")?;
    if !directory.is_dir() || directory == workspace || !directory.starts_with(&workspace) {
        return Err("项目目录不属于当前工作区".into());
    }
    if directory.to_str().is_none() {
        return Err("项目目录无法传递给助手".into());
    }
    Ok(directory)
}

struct Configuration {
    identity: Identity,
    profile: crate::ai_provider::ResolvedAiProfile,
    alternatives: Vec<(i64, crate::ai_provider::ResolvedAiProfile)>,
}

impl Identity {
    fn matches_workspace(
        &self,
        binding: &crate::agent::models::WorkspaceBinding,
        root: &Path,
    ) -> bool {
        self.workspace_id == binding.workspace_id
            && self.workspace_generation == binding.generation
            && self.root == root
    }
}

impl Configuration {
    fn resolve(app: &tauri::AppHandle, project_id: i64) -> Result<Self, String> {
        let state = app.state::<crate::AppState>();
        let current = crate::lock_mutex(&state.current_workspace);
        let runtime = current.as_ref().ok_or("请先打开工作区，再使用助手")?;
        if !runtime.ai_secrets_unlocked() {
            return Err("请先解锁工作区，再使用助手".into());
        }
        let mut db = crate::lock_mutex(&runtime.db);
        let project = ProjectContext::resolve(&mut db, &runtime.paths.root_path, project_id)?;
        let selected = db
            .agent_resolve_profile(None)
            .map_err(|error| match error.code {
                crate::agent::errors::ErrorCode::SecretsLocked => {
                    "无法解锁模型密钥，请解锁工作区或重新保存 AI 设置".to_string()
                }
                _ => "请在 AI 设置中配置可用模型，并将其设为通用默认模型".to_string(),
            })?;
        let alternatives = Self::configured_profiles(&mut db)?;
        let main_fingerprint = configuration_fingerprint(&selected.fingerprint, &selected.profile)?;
        Ok(Self {
            identity: Identity {
                workspace_id: runtime.agent_binding.workspace_id.clone(),
                workspace_generation: runtime.agent_binding.generation.clone(),
                root: runtime.paths.root_path.clone(),
                fingerprint: configuration_catalog_fingerprint(&main_fingerprint, &alternatives)?,
                project,
            },
            profile: selected.profile,
            alternatives,
        })
    }

    fn configured_profiles(db: &mut crate::db::Database) -> Result<Vec<(i64, crate::ai_provider::ResolvedAiProfile)>, String> {
        let mut profiles = Vec::new();
        for stored in db.ai_settings_get().map_err(|_| "无法读取助手模型配置")?.profiles {
            if !stored.enabled || !stored.supports_text || stored.provider_family != "openai_compatible"
                || !stored.has_stored_key || stored.default_model.trim().is_empty() {
                continue;
            }
            let resolved = db.agent_resolve_profile(Some(stored.id))
                .map_err(|_| "无法读取或解锁助手模型配置，请检查工作区 AI 设置")?;
            profiles.push((stored.id, resolved.profile));
        }
        profiles.sort_by_key(|(id, _)| *id);
        Ok(profiles)
    }

    fn message(&self) -> serde_json::Value {
        let providers: Vec<_> = self.alternatives.iter().map(|(id, profile)| {
            let mut provider = configured_provider_message(profile);
            provider["id"] = serde_json::json!(format!("mind-profile-{id}"));
            provider
        }).collect();
        serde_json::json!({"type": "configure", "provider": configured_provider_message(&self.profile),
            "providers": providers, "project": {
            "id": self.identity.project.id, "name": self.identity.project.name,
            "directory": self.identity.project.directory,
        }})
    }
}

fn configured_provider_message(profile: &crate::ai_provider::ResolvedAiProfile) -> serde_json::Value {
    serde_json::json!({
        "name": profile.profile_name, "baseUrl": profile.base_url,
        "modelId": profile.model, "apiKey": profile.api_key,
        "supportsImage": profile.supports_image,
    })
}

fn configuration_catalog_fingerprint(main: &str, alternatives: &[(i64, crate::ai_provider::ResolvedAiProfile)]) -> Result<String, String> {
    let fingerprints = alternatives.iter().map(|(id, profile)| {
        configuration_fingerprint("", profile).map(|fingerprint| (*id, fingerprint))
    }).collect::<Result<Vec<_>, _>>()?;
    let bytes = serde_json::to_vec(&(main, fingerprints)).map_err(|_| "无法读取助手模型配置")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

// The existing profile receipt does not cover proxy or image capability changes.
// Keep only a digest in the reuse key, never decrypted proxy credentials.
fn configuration_fingerprint(
    fingerprint: &str,
    profile: &crate::ai_provider::ResolvedAiProfile,
) -> Result<String, String> {
    let bytes = serde_json::to_vec(&(
        fingerprint,
        &profile.network.mode,
        &profile.network.proxy_url,
        &profile.profile_name,
        &profile.provider_family,
        &profile.base_url,
        &profile.model,
        &profile.api_key,
        profile.supports_text,
        profile.supports_image,
    ))
    .map_err(|_| "无法读取助手模型配置")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn authorize_project_label(label: &str, project_id: i64) -> Result<(), String> {
    if label == "main"
        || label
            .strip_prefix("project-")
            .and_then(|id| id.parse::<i64>().ok())
            == Some(project_id)
    {
        Ok(())
    } else {
        Err("此窗口不能操作其他项目的助手".into())
    }
}

fn local_caller_url(url: &Url, dev_url: Option<&Url>, is_dev: bool) -> bool {
    if is_dev {
        dev_url.is_some_and(|dev| dev.origin() == url.origin())
    } else {
        (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
    }
}

fn authorize_caller(caller: &Webview) -> Result<(), String> {
    let label = caller.label();
    let local_label = label == "main"
        || label
            .strip_prefix("project-")
            .is_some_and(|suffix| !suffix.is_empty());
    let url = caller.url().map_err(|_| "无法验证助手调用窗口")?;
    let local_url = local_caller_url(&url, caller.app_handle().config().build.dev_url.as_ref(), cfg!(dev));
    if !local_label || caller.window().label() != label || !local_url {
        return Err("此窗口不能操作助手".into());
    }
    Ok(())
}

// Parsing errors never include stdout, URLs, credentials, or serde diagnostics.
fn parse_ready(line: &str) -> Result<Option<Url>, String> {
    let Some(json) = line.strip_prefix(READY_PREFIX) else {
        return Ok(None);
    };
    #[derive(Deserialize)]
    struct Ready {
        url: String,
    }
    let ready: Ready = serde_json::from_str(json).map_err(|_| INVALID_READY)?;
    let url = Url::parse(&ready.url).map_err(|_| INVALID_READY)?;
    let tokens: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| key == "token")
        .collect();
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none_or(|port| port == 0)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || tokens.len() != 1
        || tokens[0].1.trim().is_empty()
    {
        return Err(INVALID_READY.into());
    }
    Ok(Some(url))
}

struct AssistantProcess {
    child: Child,
    url: Url,
    drain: JoinHandle<()>,
    session_http: reqwest::Client,
    session_cookie: Option<reqwest::header::HeaderValue>,
    closed: watch::Sender<bool>,
    sensitive: Arc<Vec<String>>,
    source_stdin: Option<Arc<Mutex<Option<tokio::process::ChildStdin>>>>,
    source_revoked: Arc<AtomicBool>,
    source_gate: Arc<std::sync::Mutex<()>>,
}

impl Drop for AssistantProcess {
    fn drop(&mut self) {
        self.revoke_sources();
        let _ = self.closed.send(true);
        self.drain.abort();
    } // Child also has kill_on_drop.
}

impl AssistantProcess {
    async fn launch(command: Command, config: &serde_json::Value) -> Result<Self, String> {
        Self::launch_with_source(command, config, None).await
    }

    async fn launch_with_source(mut command: Command, config: &serde_json::Value, source: Option<SourceHandler>) -> Result<Self, String> {
        let session_http = session_http_client()?;
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|_| "无法启动助手，请检查 Node 和助手资源")?;
        let stdout = child.stdout.take().ok_or("无法读取助手启动状态")?;
        let mut reader = BufReader::new(stdout);
        let ready = tokio::time::timeout(READY_TIMEOUT, async {
            let mut message = serde_json::to_vec(config).map_err(|_| "无法生成助手模型配置")?;
            message.push(b'\n');
            child
                .stdin
                .as_mut()
                .ok_or("无法发送助手模型配置")?
                .write_all(&message)
                .await
                .map_err(|_| "无法发送助手模型配置")?;
            loop {
                // Bound each line, and consume unrelated logs without displaying them.
                let mut line = Vec::new();
                let n = (&mut reader)
                    .take(64 * 1024 + 1)
                    .read_until(b'\n', &mut line)
                    .await
                    .map_err(|_| "无法读取助手启动状态")?;
                if n == 0 {
                    return Err("助手在就绪前退出，请检查模型设置".to_string());
                }
                if n > 64 * 1024 {
                    return Err(INVALID_READY.into());
                }
                let line = std::str::from_utf8(&line).map_err(|_| INVALID_READY)?;
                if let Some(url) = parse_ready(line)? {
                    return Ok(url);
                }
            }
        })
        .await;
        let url = match ready {
            Ok(Ok(url)) => url,
            failure => {
                // EOF requests disposal even if boot failed or timed out.
                let _ = stop_child(&mut child).await;
                return Err(match failure {
                    Ok(Err(error)) => error,
                    Err(_) => "助手启动超时，请重试".into(),
                    _ => unreachable!(),
                });
            }
        };
        let source_revoked = Arc::new(AtomicBool::new(false));
        let source_gate = Arc::new(std::sync::Mutex::new(()));
        let gate = source_gate.clone();
        let source_stdin = if source.is_some() { Some(Arc::new(Mutex::new(child.stdin.take()))) } else { None };
        let writer = source_stdin.clone();
        let revoked = source_revoked.clone();
        let drain = tokio::spawn(async move {
            if let (Some(handler), Some(writer)) = (source, writer) {
                loop {
                    let mut line = Vec::new();
                    let read = (&mut reader).take(256 * 1024 + 1).read_until(b'\n', &mut line).await;
                    match read { Ok(0) | Err(_) => break, Ok(size) if size > 256 * 1024 => break, _ => () }
                    let Some(payload) = line.strip_prefix(b"MIND_DSH_SOURCE ") else { continue; };
                    let Ok(frame) = serde_json::from_slice::<SourceFrame>(payload) else { break; };
                    if revoked.load(Ordering::SeqCst) { break; }
                    let task_handler = handler.clone();
                    let task_revoked = revoked.clone();
                    let task_gate = gate.clone();
                    let result = tokio::task::spawn_blocking(move || {
                        let _guard = crate::lock_mutex(&task_gate);
                        if task_revoked.load(Ordering::SeqCst) { return Err("Source runtime revoked".into()); }
                        let result = task_handler(frame.payload, &task_revoked);
                        if task_revoked.load(Ordering::SeqCst) { return Err("Source runtime revoked".into()); }
                        result
                    }).await.unwrap_or_else(|_| Err("Source handler failed".into()));
                    if revoked.load(Ordering::SeqCst) { break; }
                    let result = match result {
                        Ok(value) => serde_json::json!({"ok":true,"value":value}),
                        Err(message) => serde_json::json!({"ok":false,"error":{"message":message}}),
                    };
                    let mut bytes = serde_json::to_vec(&serde_json::json!({"type":"mind-source-response","id":frame.id,"result":result})).expect("JSON values serialize");
                    bytes.push(b'\n');
                    let mut locked = writer.lock().await;
                    let Some(stdin) = locked.as_mut() else { break; };
                    if revoked.load(Ordering::SeqCst) { break; }
                    if stdin.write_all(&bytes).await.is_err() { break; }
                }
                revoked.store(true, Ordering::SeqCst);
                writer.lock().await.take();
            } else {
                let _ = tokio::io::copy(&mut reader, &mut tokio::io::sink()).await;
            }
        });
        let (closed, _) = watch::channel(false);
        let mut sensitive = vec![url
            .query_pairs()
            .find(|(key, _)| key == "token")
            .expect("validated token")
            .1
            .into_owned()];
        for provider in std::iter::once(&config["provider"])
            .chain(config["providers"].as_array().into_iter().flatten()) {
            if let Some(key) = provider.get("apiKey").and_then(serde_json::Value::as_str).filter(|key| !key.is_empty()) {
                sensitive.push(key.to_owned());
            }
        }
        Ok(Self {
            closed,
            sensitive: Arc::new(sensitive),
            child,
            url,
            drain,
            session_http,
            session_cookie: None,
            source_stdin,
            source_revoked,
            source_gate,
        })
    }

    async fn stop(&mut self) -> Result<(), String> {
        self.revoke_sources();
        if let Some(writer) = &self.source_stdin {
            if let Some(mut stdin) = writer.lock().await.take() { let _ = stdin.write_all(b"shutdown\n").await; }
        }
        stop_child(&mut self.child).await
    }

    fn revoke_sources(&self) {
        let _guard = crate::lock_mutex(&self.source_gate);
        self.source_revoked.store(true, Ordering::SeqCst);
    }
}

type SourceHandler = Arc<dyn Fn(serde_json::Value, &AtomicBool) -> Result<serde_json::Value, String> + Send + Sync>;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceFrame { id: String, payload: serde_json::Value }

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
enum SourceRequest {
    Resolve { #[serde(rename="sessionId")] session_id: String, path: String },
    Prepare { #[serde(rename="sessionId")] session_id: String, path: Option<String>, #[serde(rename="sourceRef")] source_ref: Option<crate::agent::models::SourceRef>, offset: usize, limit: usize },
    Delivery { #[serde(rename="sessionId")] session_id: String, #[serde(rename="deliveryId")] delivery_id: String, projection: String, #[serde(rename="projectionHash")] projection_hash: String },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct SourceProjection {
    id: String,
    source_ref: crate::agent::models::SourceRef,
    offset: usize,
    limit: usize,
    requested_limit: usize,
    truncated: bool,
    content: String,
}

fn render_source_projection(projection: &SourceProjection) -> Result<String, String> {
    Ok(format!("@{}\n<mind-file-source>{}</mind-file-source>", source_file_token(&projection.source_ref)?, serde_json::to_string(projection).map_err(|_| "Invalid File projection")?.replace('<', "\\u003c").replace('>', "\\u003e")))
}

fn source_file_token(source: &crate::agent::models::SourceRef) -> Result<String, String> {
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(source).map_err(|_| "Invalid File source")?);
    let label: String = source.title.chars().map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' }).collect();
    Ok(format!("mind-source/{encoded}/{label}"))
}

fn source_prepare(db: &crate::db::Database, identity: &Identity, binding: &crate::agent::models::WorkspaceBinding, session_id: &str, id: &str, path: Option<&str>, fixed: Option<crate::agent::models::SourceRef>, offset: usize, limit: usize) -> Result<serde_json::Value, String> {
    use crate::agent::access::{Caller, RequestContext, ScopeGrant};
    if session_id.is_empty() || session_id.len() > 512 || session_id.chars().any(char::is_control)
        || id.is_empty() || id.len() > 128 || offset == 0 || offset > u32::MAX as usize || limit == 0 || limit > 2000 { return Err("Invalid source read range or identity".into()); }
    let input = source_file_input(db, identity, binding, path, fixed)?;
    let request = RequestContext { binding: binding.clone(), scope_grant: ScopeGrant { workspace_id: binding.workspace_id.clone(), workspace_content: false, project_ids: vec![identity.project.id], operations: vec!["source.read".into()], object_keys: None }, caller: Caller::Connection { grant_id: format!("dsh:{session_id}") }, request_id: id.into() };
    let (bytes, mut source_ref) = db.project_file_read_source(&request, binding, &input).map_err(|e| e.message)?;
    let bytes = BASE64.decode(bytes.base64).map_err(|_| "Invalid File snapshot")?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "Unsupported: File is not UTF-8 text; text source read is unavailable")?;
    if text.contains('\0') { return Err("Unsupported: binary File cannot be delivered as text".into()); }
    let mut content = String::new();
    let mut lines = Vec::new();
    let total_lines = text.lines().count();
    let mut truncated = false;
    for (index, line) in text.lines().enumerate().skip(offset - 1).take(limit) {
        let line = if line.chars().count() > 2000 {
            truncated = true;
            format!("{} [truncated after 2000 characters]", line.chars().take(2000).collect::<String>())
        } else { line.to_owned() };
        let rendered = format!("{}: {}", index + 1, line);
        if content.len() + rendered.len() + 1 > 64 * 1024 { truncated = true; break; }
        if !content.is_empty() { content.push('\n'); }
        content.push_str(&rendered);
        lines.push(serde_json::json!({"number":index + 1,"text":line}));
    }
    if offset - 1 + lines.len() < total_lines { truncated = true; }
    if !lines.is_empty() { source_ref.locator = Some(crate::agent::models::SourceLocator::Line { start: offset as u32, end: (offset - 1 + lines.len()) as u32 }); }
    let projection = render_source_projection(&SourceProjection { id: id.into(), source_ref: source_ref.clone(), offset, limit: lines.len(), requested_limit: limit, truncated, content })?;
    Ok(serde_json::json!({"sourceRef":source_ref,"projection":projection,"readValue":{"path":source_file_token(&source_ref)?,"offset":offset,"lines":lines,"totalLines":total_lines,"truncated":truncated}}))
}

fn source_file_input(db: &crate::db::Database, identity: &Identity, binding: &crate::agent::models::WorkspaceBinding, path: Option<&str>, fixed: Option<crate::agent::models::SourceRef>) -> Result<crate::db::project_directory_files::FileBytesInput, String> {
    use crate::agent::models::Scope;
    // A model can continue reading a persisted fixed File token. The embedded
    // object is still untrusted and passes the same native ownership/policy gate.
    let fixed = if fixed.is_none() {
        if let Some(encoded) = path.and_then(|p| p.strip_prefix("mind-source/")).and_then(|p| p.split('/').next()) {
            let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(encoded).map_err(|_| "Invalid fixed File token")?;
            Some(serde_json::from_slice(&bytes).map_err(|_| "Invalid fixed File token")?)
        } else { None }
    } else { fixed };
    Ok(if let Some(source) = fixed {
        if source.object.workspace_id != binding.workspace_id || source.object.scope != (Scope::Project { project_id: identity.project.id }) { return Err("File belongs to another Project".into()); }
        crate::db::project_directory_files::FileBytesInput { object: source.object, version_number: source.file_version.ok_or("Fixed File version required")?, expected_content_hash: source.revision }
    } else {
        let requested = Path::new(path.ok_or("File path required")?);
        let relative = if requested.is_absolute() { requested.strip_prefix(&identity.project.directory).map_err(|_| "File belongs to another Project")? } else { requested };
        let relative = relative.to_str().ok_or("Invalid File path")?;
        let file = db.project_file_register(&binding.workspace_id, identity.project.id, relative).map_err(|e| e.to_string())?;
        if file.state != "ready" { return Err(format!("File requires confirmation: {}", file.state)); }
        crate::db::project_directory_files::FileBytesInput { object: file.object, version_number: file.version_number, expected_content_hash: file.content_hash.ok_or("File version not ready")? }
    })
}

fn source_resolve(db: &crate::db::Database, identity: &Identity, binding: &crate::agent::models::WorkspaceBinding, session_id: &str, path: &str) -> Result<serde_json::Value, String> {
    use crate::agent::{access::{Caller, RequestContext, ScopeGrant}, models::SourceRef};
    let input = source_file_input(db, identity, binding, Some(path), None)?;
    let request = RequestContext { binding: binding.clone(), scope_grant: ScopeGrant { workspace_id: binding.workspace_id.clone(), workspace_content: false, project_ids: vec![identity.project.id], operations: vec!["source.read".into()], object_keys: None }, caller: Caller::Connection { grant_id: format!("dsh:{session_id}") }, request_id: session_rpc_id() };
    let actual = db.source_read_historical_file(&request, binding, &input.object).map_err(|e| e.message)?;
    request.authorize_object(binding, &input.object, &actual, "source.read").map_err(|e| e.message)?;
    let file = db.project_file_resolve(&input.object).map_err(|e| e.to_string())?;
    let source = SourceRef { object: input.object, revision: input.expected_content_hash, file_version: Some(input.version_number), record_version: None, block_id: None, locator: None, title: file.name, excerpt: String::new() };
    Ok(serde_json::json!({"sourceRef":source}))
}

fn source_handler(app: tauri::AppHandle, identity: Identity, runtime_generation: String) -> SourceHandler {
    Arc::new(move |payload, revoked| {
        if revoked.load(Ordering::SeqCst) { return Err("Source runtime revoked".into()); }
        let operation: SourceRequest = serde_json::from_value(payload).map_err(|_| "Invalid native source request")?;
        let state = app.state::<crate::AppState>();
        let current = crate::lock_mutex(&state.current_workspace);
        let runtime = current.as_ref().ok_or("Source Workspace closed")?;
        if !identity.matches_workspace(&runtime.agent_binding, &runtime.paths.root_path) || !runtime.ai_secrets_unlocked() { return Err("Source Workspace binding expired".into()); }
        let mut db = crate::lock_mutex(&runtime.db);
        if ProjectContext::resolve(&mut db, &runtime.paths.root_path, identity.project.id)? != identity.project { return Err("Source Project binding changed".into()); }
        let result = match operation {
            SourceRequest::Resolve { session_id, path } => source_resolve(&db, &identity, &runtime.agent_binding, &session_id, &path),
            SourceRequest::Prepare { session_id, path, source_ref, offset, limit } => source_prepare(&db, &identity, &runtime.agent_binding, &session_id, &format!("{runtime_generation}:{}", session_rpc_id()), path.as_deref(), source_ref, offset, limit),
            SourceRequest::Delivery { session_id, delivery_id, projection, projection_hash } => {
                source_delivery(&db, &identity, &runtime.agent_binding, &session_id, &delivery_id, &projection, &projection_hash, revoked)?;
                Ok(serde_json::Value::Null)
            }
        };
        if revoked.load(Ordering::SeqCst) { return Err("Source runtime revoked".into()); }
        result
    })
}

fn source_delivery(db: &crate::db::Database, identity: &Identity, binding: &crate::agent::models::WorkspaceBinding, session_id: &str, delivery_id: &str, projection: &str, projection_hash: &str, revoked: &AtomicBool) -> Result<(), String> {
    if revoked.load(Ordering::SeqCst) { return Err("Source runtime revoked".into()); }
    let json = projection.split_once('\n').and_then(|(_, s)| s.strip_prefix("<mind-file-source>")).and_then(|s| s.strip_suffix("</mind-file-source>")).ok_or("Invalid source projection")?;
    let metadata: SourceProjection = serde_json::from_str(json).map_err(|_| "Invalid source projection")?;
    let expected = source_prepare(db, identity, binding, session_id, &metadata.id, None, Some(metadata.source_ref.clone()), metadata.offset, metadata.requested_limit)?;
    if expected["projection"].as_str() != Some(projection) || format!("{:x}", Sha256::digest(projection.as_bytes())) != projection_hash { return Err("Source projection does not match fixed bytes".into()); }
    if revoked.load(Ordering::SeqCst) { return Err("Source runtime revoked".into()); }
    db.dsh_record_source_evidence(binding, identity.project.id, session_id, delivery_id, projection_hash, &[metadata.source_ref]).map_err(|e| e.message)?;
    if revoked.load(Ordering::SeqCst) { return Err("Source runtime revoked".into()); }
    Ok(())
}

#[derive(Serialize)]
pub(crate) struct AssistantSession {
    id: String,
    title: String,
    running: bool,
}

fn session_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| SESSION_ERROR.to_string())
}

#[derive(Deserialize)]
struct SessionEnvelope {
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "rpcId")]
    rpc_id: String,
    result: SessionResult,
}
#[derive(Deserialize)]
struct SessionResult {
    ok: bool,
    value: Option<serde_json::Value>,
}
#[derive(Deserialize)]
struct SessionListValue {
    items: Vec<WireSession>,
}
#[derive(Deserialize)]
struct WireSession {
    #[serde(rename = "sessionId")]
    id: String,
    cwd: Option<String>,
    title: Option<String>,
    projections: Option<SessionProjections>,
    #[serde(default)]
    running: bool,
}
#[derive(Deserialize)]
struct SessionProjections {
    values: SessionProjectionValues,
}
#[derive(Deserialize)]
struct SessionProjectionValues {
    title: Option<String>,
}

fn session_rpc_id() -> String {
    let id =
        (rand::random::<u128>() & !(0xfu128 << 76 | 0x3u128 << 62)) | 0x4u128 << 76 | 0x2u128 << 62;
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        id >> 96,
        (id >> 80) & 0xffff,
        (id >> 64) & 0xffff,
        (id >> 48) & 0xffff,
        id & 0xffffffffffff
    )
}

enum SessionRequest {
    List,
    Create,
    Delete(String),
}

async fn authenticate(
    url: &Url,
    client: &reqwest::Client,
    cookie: &mut Option<reqwest::header::HeaderValue>,
) -> Result<(), String> {
    if cookie.is_none() {
        let response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|_| SESSION_ERROR)?;
        if response.status() != reqwest::StatusCode::SEE_OTHER {
            return Err(SESSION_ERROR.into());
        }
        let mut pairs = Vec::new();
        for value in response.headers().get_all(reqwest::header::SET_COOKIE) {
            let pair = value
                .to_str()
                .map_err(|_| SESSION_ERROR)?
                .split(';')
                .next()
                .unwrap_or("")
                .trim();
            if pair.is_empty() || !pair.contains('=') {
                return Err(SESSION_ERROR.into());
            }
            pairs.push(pair);
        }
        if pairs.is_empty() {
            return Err(SESSION_ERROR.into());
        }
        *cookie = Some(
            reqwest::header::HeaderValue::from_str(&pairs.join("; ")).map_err(|_| SESSION_ERROR)?,
        );
    }
    Ok(())
}

async fn session_request(
    url: &Url,
    client: &reqwest::Client,
    cookie: &mut Option<reqwest::header::HeaderValue>,
    request: SessionRequest,
) -> Result<serde_json::Value, String> {
    authenticate(url, client, cookie).await?;
    let empty_result = matches!(&request, SessionRequest::Delete(_));
    let (method, args) = match request {
        SessionRequest::List => ("session/list", serde_json::json!({"_request": {}})),
        SessionRequest::Create => ("session/create", serde_json::json!({"request": {}})),
        SessionRequest::Delete(id) => (
            "mind/session/delete",
            serde_json::json!({"request": {"sessionId":id}}),
        ),
    };
    let rpc_id = session_rpc_id();
    let endpoint = url
        .join(&format!("/api/{method}"))
        .map_err(|_| SESSION_ERROR)?;
    let response = client.post(endpoint).header(reqwest::header::ORIGIN, url.origin().ascii_serialization())
        .header(reqwest::header::COOKIE, cookie.as_ref().expect("authenticated cookie").clone())
        .json(&serde_json::json!({"type": "client-request", "rpcId": rpc_id, "method": method, "payload": {"args": args}}))
        .send().await.map_err(|_| SESSION_ERROR)?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(SESSION_ERROR.into());
    }
    let envelope: SessionEnvelope = response.json().await.map_err(|_| SESSION_ERROR)?;
    if envelope.kind != "server-response" || envelope.rpc_id != rpc_id || !envelope.result.ok {
        return Err(SESSION_ERROR.into());
    }
    if empty_result {
        Ok(envelope.result.value.unwrap_or(serde_json::Value::Null))
    } else {
        envelope
            .result
            .value
            .ok_or_else(|| SESSION_ERROR.to_string())
    }
}

async fn list_sessions(
    url: &Url,
    client: &reqwest::Client,
    cookie: &mut Option<reqwest::header::HeaderValue>,
    directory: &Path,
) -> Result<Vec<AssistantSession>, String> {
    let value = session_request(url, client, cookie, SessionRequest::List).await?;
    let list: SessionListValue = serde_json::from_value(value).map_err(|_| SESSION_ERROR)?;
    list.items
        .into_iter()
        .filter(|item| {
            item.cwd
                .as_deref()
                .is_some_and(|cwd| Path::new(cwd) == directory)
        })
        .map(|item| {
            if item.id.is_empty() {
                return Err(SESSION_ERROR.to_string());
            }
            // The pinned controller stores generated titles in the projection;
            // an explicit list title, when supplied, is already the display title.
            let title = item
                .title
                .or_else(|| {
                    item.projections
                        .and_then(|projection| projection.values.title)
                })
                .filter(|title| !title.trim().is_empty())
                .unwrap_or_else(|| "新会话".into());
            Ok(AssistantSession {
                id: item.id,
                title,
                running: item.running,
            })
        })
        .collect()
}

async fn create_session(
    url: &Url,
    client: &reqwest::Client,
    cookie: &mut Option<reqwest::header::HeaderValue>,
) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Created {
        #[serde(rename = "sessionId")]
        id: String,
    }
    let value = session_request(url, client, cookie, SessionRequest::Create).await?;
    let created: Created = serde_json::from_value(value).map_err(|_| SESSION_ERROR)?;
    if created.id.is_empty() {
        return Err(SESSION_ERROR.into());
    }
    Ok(created.id)
}

fn validate_session_selection(
    session_id: &str,
    sessions: &[AssistantSession],
) -> Result<(), String> {
    if sessions.iter().any(|session| session.id == session_id) {
        Ok(())
    } else {
        Err("会话不属于当前项目或已被删除，请刷新会话列表".into())
    }
}

async fn stop_child(child: &mut Child) -> Result<(), String> {
    if child
        .try_wait()
        .map_err(|_| "无法检查助手进程状态")?
        .is_some()
    {
        return Ok(());
    }
    let graceful = tokio::time::timeout(STOP_TIMEOUT, async {
        if let Some(mut stdin) = child.stdin.take() {
            // Dropping stdin also requests shutdown if the write fails.
            let _ = stdin.write_all(b"shutdown\n").await;
        }
        child.wait().await
    })
    .await;
    if matches!(graceful, Ok(Ok(_))) {
        return Ok(());
    }
    child
        .kill()
        .await
        .map_err(|_| "无法停止助手进程".to_string())
}

fn runtime_command(app: &tauri::AppHandle, config: &Configuration) -> Result<Command, String> {
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    #[cfg(debug_assertions)]
    let (root, node) = {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let pinned = manifest.join("resources/agent-host").join(node_name);
        let node = if pinned.is_file() {
            pinned
        } else {
            development_node(node_name)?
        };
        (manifest.join("../packages/dsh-assistant"), node)
    };
    #[cfg(not(debug_assertions))]
    let (root, node) = {
        let resources = app
            .path()
            .resource_dir()
            .map_err(|_| "找不到助手资源目录")?;
        (
            resources.join("dsh-assistant"),
            resources.join("agent-host").join(node_name),
        )
    };
    let script = root.join("scripts/runtime.mjs");
    if !script.is_file() || !node.is_file() {
        return Err("助手资源不完整，请重新安装应用".into());
    }
    let mut command = Command::new(node);
    command.current_dir(root).arg(script).args([
        "--embedded",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--no-open",
    ]);
    let data_root = assistant_data_root()?;
    command.env(
        "PROJECT_MIND_DSH_USER_DATA",
        project_data_directory(
            &data_root,
            &config.identity.workspace_id,
            config.identity.project.id,
        )?,
    );
    command.env(
        "PROJECT_MIND_DSH_PROFILE_DIR",
        workspace_profile_directory(&data_root, &config.identity.workspace_id)?,
    );
    crate::ai_network::configure_node(
        &mut command,
        &config.profile.base_url,
        &config.profile.network,
    )
    .map_err(|_| "无法应用 AI 网络设置，请检查代理配置")?;
    let _ = app; // Development uses the source root, never bundle path guessing.
    Ok(command)
}

fn assistant_data_root() -> Result<PathBuf, String> {
    let root = if let Some(path) =
        std::env::var_os("PROJECT_MIND_DSH_USER_DATA").filter(|path| !path.is_empty())
    {
        PathBuf::from(path)
    } else {
        let home = crate::default_home_dir().map_err(|_| "找不到助手数据目录")?;
        #[cfg(target_os = "macos")]
        let root = home.join("Library/Application Support/project-mind-dsh");
        #[cfg(target_os = "windows")]
        let root = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join("project-mind-dsh");
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let root = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"))
            .join("project-mind-dsh");
        root
    };
    if !root.is_absolute() {
        return Err("助手数据目录必须是绝对路径".into());
    }
    Ok(root)
}

fn workspace_data_directory(root: &Path, workspace_id: &str) -> Result<PathBuf, String> {
    let mut components = Path::new(workspace_id).components();
    if !root.is_absolute()
        || !matches!(components.next(), Some(std::path::Component::Normal(_)))
        || components.next().is_some()
    {
        return Err("助手工作区数据目录标识无效".into());
    }
    Ok(root.join("projects").join(workspace_id))
}

fn project_data_directory(
    root: &Path,
    workspace_id: &str,
    project_id: i64,
) -> Result<PathBuf, String> {
    if project_id <= 0 {
        return Err("助手项目数据目录标识无效".into());
    }
    Ok(workspace_data_directory(root, workspace_id)?.join(project_id.to_string()))
}

fn workspace_profile_directory(root: &Path, workspace_id: &str) -> Result<PathBuf, String> {
    Ok(workspace_data_directory(root, workspace_id)?.join("profiles/assistant"))
}

#[cfg(debug_assertions)]
fn development_node(name: &str) -> Result<PathBuf, String> {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
        .ok_or_else(|| "开发环境未找到 Node，请将 Node 加入 PATH".into())
}

impl RuntimeState {
    fn authorize_project(&self, label: &str, project_id: i64) -> Result<(), String> {
        let identity = self
            .identity
            .as_ref()
            .ok_or("助手尚未就绪，请重新打开助手")?;
        if identity.project.id != project_id {
            return Err("项目已切换，请重新打开助手".into());
        }
        authorize_project_label(label, project_id)
    }
    async fn stop(&mut self) -> Result<(), String> {
        self.identity = None;
        let connections = std::mem::take(&mut self.connections);
        if let Some(process) = self.process.as_ref() {
            process.revoke_sources();
            let _ = process.closed.send(true);
        }
        let mut failure = None;
        for (_, connection) in connections {
            if let Err(error) = connection.finish().await {
                failure.get_or_insert(error);
            }
        }
        if let Some(mut process) = self.process.take() {
            if let Err(error) = process.stop().await {
                failure.get_or_insert(error);
            }
        }
        if let Some(error) = failure {
            return Err(error);
        }
        Ok(())
    }

    fn check_ready(&mut self, app: &tauri::AppHandle) -> Result<(), String> {
        let state = app.state::<crate::AppState>();
        let current = crate::lock_mutex(&state.current_workspace);
        let runtime = current.as_ref().ok_or("请先打开工作区，再使用助手")?;
        if !runtime.ai_secrets_unlocked() {
            return Err("请先解锁工作区，再使用助手".into());
        }
        if !self.identity.as_ref().is_some_and(|identity| {
            identity.matches_workspace(&runtime.agent_binding, &runtime.paths.root_path)
        }) {
            return Err("助手尚未就绪，请重新打开助手".into());
        }
        let process = self
            .process
            .as_mut()
            .ok_or("助手尚未就绪，请重新打开助手")?;
        if process
            .child
            .try_wait()
            .map_err(|_| "无法检查助手进程状态")?
            .is_some()
        {
            return Err("助手已退出，请重新打开助手".into());
        }
        Ok(())
    }

    async fn ensure_current_project(&mut self, caller: &Webview) -> Result<(), String> {
        if let Some(identity) = self.identity.as_ref() {
            authorize_project_label(caller.label(), identity.project.id)?;
        }
        let app = caller.app_handle();
        let validation = self.check_ready(app).and_then(|_| {
            let state = app.state::<crate::AppState>();
            let current = crate::lock_mutex(&state.current_workspace);
            let runtime = current.as_ref().ok_or("请先打开工作区，再使用助手")?;
            let identity = self.identity.as_ref().expect("ready identity");
            let project = ProjectContext::resolve(
                &mut crate::lock_mutex(&runtime.db),
                &runtime.paths.root_path,
                identity.project.id,
            )?;
            if project != identity.project {
                return Err("项目名称或目录已变化，请重新打开助手".into());
            }
            Ok(())
        });
        if let Err(error) = validation {
            let stopped = self.stop().await;
            stopped?;
            return Err(error);
        }
        Ok(())
    }

    async fn reject_running_replacement(&mut self) -> Result<(), String> {
        let process = self.process.as_mut().ok_or(TRANSPORT_ERROR)?;
        let value = session_request(
            &process.url,
            &process.session_http,
            &mut process.session_cookie,
            SessionRequest::List,
        )
        .await?;
        let list: SessionListValue = serde_json::from_value(value).map_err(|_| SESSION_ERROR)?;
        if list.items.iter().any(|session| session.running) {
            return Err(RUNNING_ERROR.into());
        }
        Ok(())
    }

    async fn ensure_ready(
        &mut self,
        app: &tauri::AppHandle,
        project_id: i64,
        has_pending_requests: bool,
    ) -> Result<(), String> {
        // Reject an invalid target Project before resolving settings or stopping the live Project.
        {
            let state = app.state::<crate::AppState>();
            let current = crate::lock_mutex(&state.current_workspace);
            if let Some(runtime) = current.as_ref() {
                ProjectContext::resolve(
                    &mut crate::lock_mutex(&runtime.db),
                    &runtime.paths.root_path,
                    project_id,
                )?;
            }
        }
        let config = match Configuration::resolve(app, project_id) {
            Ok(config) => config,
            Err(error) => {
                // Stop using a decrypted key after workspace lock or settings removal.
                let stopped = self.stop().await;
                stopped?;
                return Err(error);
            }
        };
        let alive = match self.process.as_mut() {
            Some(process) => process
                .child
                .try_wait()
                .map_err(|_| "无法检查助手进程状态")?
                .is_none(),
            None => false,
        };
        if alive && self.identity.as_ref() == Some(&config.identity) {
            return Ok(());
        }
        if alive {
            if has_pending_requests {
                return Err(RUNNING_ERROR.into());
            }
            self.reject_running_replacement().await?;
        }
        self.stop().await?;
        let process = AssistantProcess::launch_with_source(runtime_command(app, &config)?, &config.message(),
            Some(source_handler(app.clone(), config.identity.clone(), session_rpc_id()))).await?;
        // Workspace/settings can change while Node boots. Never expose that stale runtime.
        let current = Configuration::resolve(app, project_id);
        if current.as_ref().map(|config| &config.identity).ok() != Some(&config.identity) {
            let mut process = process;
            process.stop().await?;
            return Err(current
                .err()
                .unwrap_or_else(|| "工作区或模型设置已变化，请重新打开助手".into()));
        }
        self.generation += 1;
        self.identity = Some(config.identity);
        self.process = Some(process);
        Ok(())
    }
}

impl DshAssistantState {
    // Keep the mutation lock through the native workspace transition, so a
    // concurrent start cannot reuse old credentials between stop and lock/switch.
    pub(crate) async fn invalidate<T>(
        &self,
        _app: &tauri::AppHandle,
        change: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let mut inner = self.inner.lock().await;
        if self.stopping.load(Ordering::SeqCst) {
            return Err("应用正在退出".into());
        }
        let stopped = inner.stop().await;
        stopped?;
        change()
    }

    pub(crate) async fn shutdown(&self) -> Result<(), String> {
        self.stopping.store(true, Ordering::SeqCst);
        self.inner.lock().await.stop().await
    }

    pub(crate) fn detach_parent(app: tauri::AppHandle, owner: String) {
        // Reload/close releases carriers, never the Node runtime or an executing task.
        tauri::async_runtime::spawn(async move {
            let Some(state) = app.try_state::<DshAssistantState>() else {
                return;
            };
            {
                let mut requests = crate::lock_mutex(&state.requests);
                for (key, request) in requests.iter_mut() {
                    if key.starts_with(&format!("{owner}:")) {
                        if let Some(cancel) = request.cancel.take() {
                            let _ = cancel.send(());
                        }
                    }
                }
            }
            let mut runtimes = state.inner.lock().await;
            for inner in runtimes.projects.values_mut() {
                let ids: Vec<_> = inner.connections.iter()
                    .filter(|(_, connection)| connection.owner == owner)
                    .map(|(id, _)| id.clone()).collect();
                for id in ids {
                    if let Some(connection) = inner.connections.remove(&id) {
                        if connection.finish().await.is_err() {
                            eprintln!("DSH assistant carrier disposal failed");
                        }
                    }
                }
            }
        });
    }

    // Ordinary exits await async shutdown; the final Exit event must not wait
    // for a runtime mutation already in flight.
    pub(crate) fn exit_fallback(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Ok(mut inner) = self.inner.try_lock() {
            // Once try_lock succeeds, stop only performs process I/O and does
            // not dispatch UI work. It is safe to await grace on this thread.
            let _ = tauri::async_runtime::block_on(inner.stop());
        }
    }
}

/// Real process count; no new concurrency cap is imposed here.
#[tauri::command]
pub(crate) async fn dsh_assistant_runtime_status(
    caller: Webview,
    state: State<'_, DshAssistantState>,
) -> Result<usize, String> {
    authorize_caller(&caller)?;
    state.inner.lock().await.active_count()
}

#[tauri::command]
pub(crate) async fn dsh_assistant_start(
    caller: Webview,
    state: State<'_, DshAssistantState>,
    project_id: i64,
) -> Result<(), String> {
    authorize_caller(&caller)?;
    authorize_project_label(caller.label(), project_id)?;
    let mut runtimes = state.inner.lock().await;
    if state.stopping.load(Ordering::SeqCst) {
        return Err("应用正在退出".into());
    }
    let has_pending_requests = crate::lock_mutex(&state.requests).values().any(|request| request.project_id == project_id);
    let inner = runtimes.projects.entry(project_id).or_default();
    inner
        .ensure_ready(caller.app_handle(), project_id, has_pending_requests)
        .await
}

#[tauri::command]
pub(crate) async fn dsh_assistant_sessions(
    caller: Webview,
    state: State<'_, DshAssistantState>,
    project_id: i64,
) -> Result<Vec<AssistantSession>, String> {
    authorize_caller(&caller)?;
    let mut runtimes = state.inner.lock().await;
    let inner = runtimes.project_mut(project_id)?;
    if state.stopping.load(Ordering::SeqCst) {
        return Err("应用正在退出".into());
    }
    inner.authorize_project(caller.label(), project_id)?;
    inner.ensure_current_project(&caller).await?;
    let directory = inner
        .identity
        .as_ref()
        .expect("ready identity")
        .project
        .directory
        .clone();
    let process = inner.process.as_mut().expect("ready process");
    let sessions = list_sessions(
        &process.url,
        &process.session_http,
        &mut process.session_cookie,
        &directory,
    )
    .await?;
    inner.ensure_current_project(&caller).await?;
    Ok(sessions)
}

#[tauri::command]
pub(crate) async fn dsh_assistant_select_session(
    caller: Webview,
    state: State<'_, DshAssistantState>,
    project_id: i64,
    session_id: Option<String>,
) -> Result<String, String> {
    authorize_caller(&caller)?;
    let mut runtimes = state.inner.lock().await;
    let inner = runtimes.project_mut(project_id)?;
    if state.stopping.load(Ordering::SeqCst) {
        return Err("应用正在退出".into());
    }
    inner.authorize_project(caller.label(), project_id)?;
    inner.ensure_current_project(&caller).await?;
    let directory = inner
        .identity
        .as_ref()
        .expect("ready identity")
        .project
        .directory
        .clone();
    let process = inner.process.as_mut().expect("ready process");
    let selected = if let Some(id) = session_id {
        let sessions = list_sessions(
            &process.url,
            &process.session_http,
            &mut process.session_cookie,
            &directory,
        )
        .await?;
        validate_session_selection(&id, &sessions)?;
        id
    } else {
        create_session(
            &process.url,
            &process.session_http,
            &mut process.session_cookie,
        )
        .await?
    };
    inner.ensure_current_project(&caller).await?;
    Ok(selected)
}

const TRANSPORT_ERROR: &str = "助手通信失败，请重新连接";
const RUNNING_ERROR: &str = "助手正在执行任务，请先停止当前项目任务后再切换";
const MAX_CARRIER_BYTES: usize = 300 * 1024 * 1024; // Pinned HTTP carrier limit.
const MAX_MUX_BYTES: usize = 64 * 1024 * 1024;

struct PendingRequest {
    project_id: i64,
    cancel: Option<oneshot::Sender<()>>,
}
struct RequestGuard<'a> {
    state: &'a DshAssistantState,
    key: String,
}
impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        crate::lock_mutex(&self.state.requests).remove(&self.key);
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum CarrierFrame {
    Text { text: String },
    Binary { base64: String },
}
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum CarrierEvent {
    Text { text: String },
    Binary { base64: String },
    Close { code: u16, reason: String },
    Error { message: String },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CarrierOutput {
    project_id: i64,
    connection_id: String,
    #[serde(flatten)]
    event: CarrierEvent,
}
struct SocketWrite {
    message: tokio_tungstenite::tungstenite::Message,
    result: oneshot::Sender<Result<(), String>>,
}
struct NativeConnection {
    owner: String,
    project_id: i64,
    writes: mpsc::Sender<SocketWrite>,
    close: watch::Sender<bool>,
    task: JoinHandle<()>,
}
impl Drop for NativeConnection {
    fn drop(&mut self) {
        let _ = self.close.send(true);
    }
}
impl NativeConnection {
    async fn finish(mut self) -> Result<(), String> {
        let _ = self.close.send(true);
        // One finite close write; do not wait for a vanished browser or peer handshake.
        (&mut self.task)
            .await
            .map_err(|_| TRANSPORT_ERROR.to_string())
    }
    fn authorize(&self, owner: &str, project_id: i64) -> Result<(), String> {
        if self.owner != owner || self.project_id != project_id {
            return Err("此窗口不能操作其他项目的助手连接".into());
        }
        if self.task.is_finished() {
            return Err(TRANSPORT_ERROR.into());
        }
        Ok(())
    }
}

fn contains_secret(bytes: &[u8], sensitive: &[String]) -> bool {
    sensitive
        .iter()
        .filter(|secret| !secret.is_empty())
        .any(|secret| {
            bytes
                .windows(secret.len())
                .any(|part| part == secret.as_bytes())
        })
}

async fn connect_socket(
    url: &Url,
    cookie: &reqwest::header::HeaderValue,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    String,
> {
    use tokio_tungstenite::tungstenite::{
        client::IntoClientRequest, http::header, protocol::WebSocketConfig,
    };
    let mut endpoint = url.join("/api/remote.mux").map_err(|_| TRANSPORT_ERROR)?;
    endpoint.set_scheme("ws").map_err(|_| TRANSPORT_ERROR)?;
    endpoint.set_query(None);
    let mut request = endpoint
        .as_str()
        .into_client_request()
        .map_err(|_| TRANSPORT_ERROR)?;
    request.headers_mut().insert(
        header::ORIGIN,
        url.origin()
            .ascii_serialization()
            .parse()
            .map_err(|_| TRANSPORT_ERROR)?,
    );
    request.headers_mut().insert(
        header::COOKIE,
        cookie
            .to_str()
            .map_err(|_| TRANSPORT_ERROR)?
            .parse()
            .map_err(|_| TRANSPORT_ERROR)?,
    );
    let (socket, _) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async_with_config(
            request,
            Some(
                WebSocketConfig::default()
                    .max_message_size(Some(MAX_MUX_BYTES))
                    .max_frame_size(Some(MAX_MUX_BYTES)),
            ),
            false,
        ),
    )
    .await
    .map_err(|_| TRANSPORT_ERROR)?
    .map_err(|_| TRANSPORT_ERROR)?;
    Ok(socket)
}

fn spawn_socket(
    mut socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    owner: String,
    project_id: i64,
    connection_id: String,
    channel: tauri::ipc::Channel<CarrierOutput>,
    mut runtime_closed: watch::Receiver<bool>,
    sensitive: Arc<Vec<String>>,
) -> NativeConnection {
    use tokio_tungstenite::tungstenite::Message;
    let (writes, mut rx) = mpsc::channel::<SocketWrite>(16);
    let (close, mut closing) = watch::channel(false);
    let task = tokio::spawn(async move {
        let emit = |event| {
            channel
                .send(CarrierOutput {
                    project_id,
                    connection_id: connection_id.clone(),
                    event,
                })
                .map_err(|_| TRANSPORT_ERROR)
        };
        let failure = || {
            let _ = emit(CarrierEvent::Error {
                message: TRANSPORT_ERROR.into(),
            });
        };
        let mut close_code = 1000;
        let mut close_reason = String::new();
        loop {
            tokio::select! {
                biased;
                _ = runtime_closed.changed() => { close_code = 1001; break; }
                _ = closing.changed() => break,
                write = rx.recv() => {
                    let Some(write) = write else { break; };
                    let result = tokio::time::timeout(Duration::from_secs(10), socket.send(write.message)).await;
                    let result = match result { Ok(Ok(())) => Ok(()), _ => Err(TRANSPORT_ERROR.to_string()) };
                    let failed = result.is_err();
                    let _ = write.result.send(result);
                    if failed { failure(); close_code = 1006; break; }
                }
                message = socket.next() => {
                    let event = match message {
                        Some(Ok(Message::Text(text))) => {
                            if contains_secret(text.as_bytes(), &sensitive) { failure(); close_code = 1006; break; }
                            CarrierEvent::Text { text: text.to_string() }
                        }
                        Some(Ok(Message::Binary(bytes))) => {
                            if contains_secret(&bytes, &sensitive) { failure(); close_code = 1006; break; }
                            CarrierEvent::Binary { base64: BASE64.encode(bytes) }
                        }
                        Some(Ok(Message::Ping(bytes))) => {
                            if !matches!(tokio::time::timeout(Duration::from_secs(10), socket.send(Message::Pong(bytes))).await, Ok(Ok(()))) { failure(); close_code = 1006; break; }
                            continue;
                        }
                        Some(Ok(Message::Close(frame))) => {
                            if let Some(frame) = frame {
                                close_code = frame.code.into();
                                if !contains_secret(frame.reason.as_bytes(), &sensitive) { close_reason = frame.reason.to_string(); }
                            }
                            break;
                        }
                        Some(Ok(_)) => continue,
                        Some(Err(_)) => { failure(); close_code = 1006; break; }
                        None => { close_code = 1006; break; }
                    };
                    if emit(event).is_err() { close_code = 1001; break; }
                }
            }
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), socket.close(None)).await;
        let _ = emit(CarrierEvent::Close {
            code: close_code,
            reason: close_reason,
        });
    });
    NativeConnection {
        owner,
        project_id,
        writes,
        close,
        task,
    }
}

fn validate_endpoint(endpoint: &str) -> Result<(), String> {
    if matches!(
        endpoint,
        "$events" | "$events/result" | "mind/session/delete" | "mind/source/prepare" | "mind/source/resolve"
    ) {
        return Ok(());
    }
    let (namespace, method) = endpoint.split_once('/').ok_or(TRANSPORT_ERROR)?;
    if method.is_empty()
        || !method
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'$'))
    {
        return Err(TRANSPORT_ERROR.into());
    }
    // Account, credential, provider, filesystem and directory-picker APIs are owned by the main app.
    if !matches!(
        namespace,
        "session"
            | "commands"
            | "agentPresets"
            | "fileReferences"
            | "fileUploads"
            | "goals"
            | "job"
            | "messageFeedback"
            | "permissionPresets"
            | "pluginInventory"
            | "pluginManager"
            | "pluginRegistryProbe"
            | "sessionFeedback"
            | "sessionReferenceResolver"
            | "settings"
            | "skills"
            | "subagents"
            | "userQuestions"
            | "dynamicCordisRunner"
            | "officeToPdf"
    ) && !matches!(endpoint, "workspace/follow" | "workspace/initializeDefault")
    {
        return Err("此助手接口由主应用管理".into());
    }
    if matches!(
        endpoint,
        "session/initializeDefaultModel"
            | "session/openWorkspacePath"
            | "settings/openSettingsDocument"
    ) {
        return Err("请使用主应用设置或文件入口".into());
    }
    Ok(())
}

fn payload_session_ids(value: &serde_json::Value, ids: &mut Vec<String>) -> Result<(), String> {
    match value {
        serde_json::Value::Object(fields) => {
            for (key, value) in fields {
                if matches!(key.as_str(), "apiKey" | "token" | "credentials" | "baseUrl") {
                    return Err("模型和凭据由主应用管理".into());
                }
                if key == "agentId" || key.ends_with("sessionId") || key.ends_with("SessionId") {
                    if !value.is_null() {
                        ids.push(
                            value
                                .as_str()
                                .filter(|id| !id.is_empty())
                                .ok_or(TRANSPORT_ERROR)?
                                .into(),
                        );
                    }
                } else if key == "sessionIds" {
                    for id in value.as_array().ok_or(TRANSPORT_ERROR)? {
                        ids.push(id.as_str().ok_or(TRANSPORT_ERROR)?.into());
                    }
                } else {
                    payload_session_ids(value, ids)?;
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                payload_session_ids(item, ids)?;
            }
        }
        _ => {}
    }
    Ok(())
}

impl RuntimeState {
    async fn authorize_payload(
        &mut self,
        endpoint: &str,
        payload: &serde_json::Value,
    ) -> Result<(), String> {
        validate_endpoint(endpoint)?;
        if !payload.is_object() {
            return Err(TRANSPORT_ERROR.into());
        }
        if endpoint == "session/create" {
            let request = payload
                .pointer("/args/request")
                .and_then(serde_json::Value::as_object)
                .ok_or(TRANSPORT_ERROR)?;
            if let Some(cwd) = request.get("cwd") {
                let cwd = Path::new(cwd.as_str().ok_or(TRANSPORT_ERROR)?);
                if !cwd.is_absolute()
                    || cwd.canonicalize().map_err(|_| TRANSPORT_ERROR)?
                        != self
                            .identity
                            .as_ref()
                            .ok_or(TRANSPORT_ERROR)?
                            .project
                            .directory
                {
                    return Err("会话目录由当前项目确定".into());
                }
            }
            // bindProject is the authoritative Node wrapper: an explicit workspaceId
            // must equal its mapped workspace. Keep that official create contract.
            if let Some(id) = request.get("workspaceId") {
                if id.as_str().is_none_or(str::is_empty) {
                    return Err(TRANSPORT_ERROR.into());
                }
            }
            return Ok(());
        }
        if endpoint == "session/selectModel" && payload.pointer("/args/request/sessionId")
            .and_then(serde_json::Value::as_str).is_none_or(str::is_empty) {
            return Err(TRANSPORT_ERROR.into());
        }
        let mut ids = Vec::new();
        payload_session_ids(payload, &mut ids)?;
        if !ids.is_empty() {
            let directory = &self
                .identity
                .as_ref()
                .ok_or(TRANSPORT_ERROR)?
                .project
                .directory;
            let process = self.process.as_mut().ok_or(TRANSPORT_ERROR)?;
            let sessions = list_sessions(
                &process.url,
                &process.session_http,
                &mut process.session_cookie,
                directory,
            )
            .await?;
            for id in ids {
                validate_session_selection(&id, &sessions)?;
                if endpoint == "mind/session/delete"
                    && sessions
                        .iter()
                        .any(|session| session.id == id && session.running)
                {
                    return Err("会话正在执行任务，请先停止再删除".into());
                }
            }
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FetchOutput {
    status: u16,
    headers: HashMap<String, String>,
    body_base64: String,
}

fn carrier_path(
    path: &str,
    method: &str,
    body: &[u8],
) -> Result<(String, Option<serde_json::Value>, Option<String>), String> {
    // Never let an IPC caller choose authority, credentials, redirects or a normalized traversal.
    if !path.starts_with("/api/") && !path.starts_with("api/") {
        return Err(TRANSPORT_ERROR.into());
    }
    if path.contains(['\\', '#', '\0']) {
        return Err(TRANSPORT_ERROR.into());
    }
    let raw = path.trim_start_matches('/');
    let route = raw.split('?').next().ok_or(TRANSPORT_ERROR)?;
    if route
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == ".." || part.contains('%'))
    {
        return Err(TRANSPORT_ERROR.into());
    }
    let endpoint = route
        .strip_prefix("api/")
        .ok_or(TRANSPORT_ERROR)?
        .to_owned();
    if endpoint == "file" {
        if !matches!(method, "GET" | "HEAD") || !body.is_empty() {
            return Err(TRANSPORT_ERROR.into());
        }
        return Ok((endpoint, None, None));
    }
    if method != "POST" {
        return Err(TRANSPORT_ERROR.into());
    }
    if endpoint == "session/uploadFileBinary" {
        return Ok((endpoint, None, None));
    }
    if path.contains('?') {
        return Err(TRANSPORT_ERROR.into());
    }
    validate_endpoint(&endpoint)?;
    let frame: serde_json::Value = serde_json::from_slice(body).map_err(|_| TRANSPORT_ERROR)?;
    if frame["type"] != "client-request"
        || frame["method"] != endpoint
        || frame["rpcId"].as_str().is_none_or(str::is_empty)
    {
        return Err(TRANSPORT_ERROR.into());
    }
    Ok((
        endpoint,
        Some(frame["payload"].clone()),
        frame["rpcId"].as_str().map(str::to_owned),
    ))
}

async fn fetch_bytes(
    client: &reqwest::Client,
    url: Url,
    cookie: reqwest::header::HeaderValue,
    method: &str,
    bytes: Vec<u8>,
    raw_upload: bool,
    sensitive: &[String],
) -> Result<FetchOutput, String> {
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| TRANSPORT_ERROR)?;
    let origin = url.origin().ascii_serialization();
    let mut request = client
        .request(method, url)
        .header(reqwest::header::ORIGIN, origin)
        .header(reqwest::header::COOKIE, cookie);
    if raw_upload {
        request = request.header(reqwest::header::CONTENT_TYPE, "application/octet-stream");
    } else if !bytes.is_empty() {
        request = request.header(reqwest::header::CONTENT_TYPE, "application/json");
    }
    let mut response = request
        .body(bytes)
        .send()
        .await
        .map_err(|_| TRANSPORT_ERROR)?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return Err(TRANSPORT_ERROR.into());
    }
    let mut headers = HashMap::new();
    for name in ["content-type", "content-length", "cache-control"] {
        if let Some(value) = response.headers().get(name) {
            headers.insert(
                name.into(),
                value.to_str().map_err(|_| TRANSPORT_ERROR)?.into(),
            );
        }
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CARRIER_BYTES as u64)
    {
        return Err("助手响应超过大小限制".into());
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| TRANSPORT_ERROR)? {
        if data.len() + chunk.len() > MAX_CARRIER_BYTES {
            return Err("助手响应超过大小限制".into());
        }
        data.extend_from_slice(&chunk);
    }
    if contains_secret(&data, sensitive) {
        return Err(TRANSPORT_ERROR.into());
    }
    Ok(FetchOutput {
        status,
        headers,
        body_base64: BASE64.encode(data),
    })
}

#[tauri::command]
pub(crate) async fn dsh_assistant_fetch(
    caller: Webview,
    state: State<'_, DshAssistantState>,
    project_id: i64,
    request_id: String,
    path: String,
    method: String,
    body_base64: Option<String>,
) -> Result<FetchOutput, String> {
    authorize_caller(&caller)?;
    authorize_project_label(caller.label(), project_id)?;
    if request_id.is_empty() || request_id.len() > 128 {
        return Err(TRANSPORT_ERROR.into());
    }
    let key = format!("{}:{request_id}", caller.label());
    let (cancel, mut cancelled) = oneshot::channel();
    {
        let mut requests = crate::lock_mutex(&state.requests);
        if requests.contains_key(&key) {
            return Err("助手请求标识重复".into());
        }
        requests.insert(
            key.clone(),
            PendingRequest {
                project_id,
                cancel: Some(cancel),
            },
        );
    }
    let _guard = RequestGuard { state: &state, key };
    let operation = async {
        let encoded = body_base64.unwrap_or_default();
        if encoded.len() > MAX_CARRIER_BYTES.div_ceil(3) * 4 {
            return Err("助手请求超过大小限制".into());
        }
        let body = BASE64.decode(encoded).map_err(|_| TRANSPORT_ERROR)?;
        if body.len() > MAX_CARRIER_BYTES {
            return Err("助手请求超过大小限制".into());
        }
        let (endpoint, payload, _) = carrier_path(&path, &method, &body)?;
        let (url, client, cookie, generation, mut runtime_closed, sensitive) = {
            let mut runtimes = state.inner.lock().await;
    let inner = runtimes.project_mut(project_id)?;
            inner.authorize_project(caller.label(), project_id)?;
            inner.ensure_current_project(&caller).await?;
            if let Some(payload) = payload {
                inner.authorize_payload(&endpoint, &payload).await?;
            }
            let process = inner.process.as_ref().ok_or(TRANSPORT_ERROR)?;
            let mut url = process
                .url
                .join(&format!("/{}", path.trim_start_matches('/')))
                .map_err(|_| TRANSPORT_ERROR)?;
            if endpoint == "session/uploadFileBinary" {
                let mut pairs = HashMap::new();
                for (key, value) in url.query_pairs().into_owned() {
                    if !matches!(key.as_str(), "sessionId" | "name")
                        || pairs.insert(key, value).is_some()
                    {
                        return Err(TRANSPORT_ERROR.into());
                    }
                }
                let id = pairs.get("sessionId").ok_or(TRANSPORT_ERROR)?;
                inner
                    .authorize_payload(
                        "fileUploads/upload",
                        &serde_json::json!({"args":{"sessionId":id}}),
                    )
                    .await?;
            }
            if endpoint == "file" {
                let pairs: Vec<_> = url.query_pairs().into_owned().collect();
                if pairs.len() != 1 || pairs[0].0 != "path" {
                    return Err(TRANSPORT_ERROR.into());
                }
                let file = PathBuf::from(&pairs[0].1);
                if !file.is_absolute() {
                    return Err("助手引用必须是绝对路径".into());
                }
                let identity = inner.identity.as_ref().ok_or(TRANSPORT_ERROR)?;
                let file = file.canonicalize().map_err(|_| "助手引用文件不可用")?;
                let attachments = project_data_directory(
                    &assistant_data_root()?,
                    &identity.workspace_id,
                    project_id,
                )?
                .join("attachments/v1");
                if !file.is_file()
                    || (!file.starts_with(&identity.project.directory)
                        && !attachments
                            .canonicalize()
                            .is_ok_and(|root| file.starts_with(root)))
                {
                    return Err("不能读取当前项目之外的文件".into());
                }
                url.query_pairs_mut()
                    .clear()
                    .append_pair("path", file.to_str().ok_or(TRANSPORT_ERROR)?);
            }
            let generation = inner.generation;
            let process = inner.process.as_mut().ok_or(TRANSPORT_ERROR)?;
            authenticate(
                &process.url,
                &process.session_http,
                &mut process.session_cookie,
            )
            .await?;
            (
                url,
                process.session_http.clone(),
                process.session_cookie.clone().ok_or(TRANSPORT_ERROR)?,
                generation,
                process.closed.subscribe(),
                process.sensitive.clone(),
            )
        };
        let output = tokio::select! {
            output = fetch_bytes(&client, url, cookie, &method, body, endpoint == "session/uploadFileBinary", &sensitive) => output?,
            _ = runtime_closed.changed() => return Err("项目已切换，请重新打开助手".into()),
        };
        let mut runtimes = state.inner.lock().await;
    let inner = runtimes.project_mut(project_id)?;
        inner.authorize_project(caller.label(), project_id)?;
        if inner.generation != generation {
            return Err("项目已切换，请重新打开助手".into());
        }
        inner.ensure_current_project(&caller).await?;
        Ok(output)
    };
    tokio::select! { result = operation => result, _ = &mut cancelled => Err("助手请求已取消".into()) }
}

#[tauri::command]
pub(crate) async fn dsh_assistant_cancel(
    caller: Webview,
    state: State<'_, DshAssistantState>,
    project_id: i64,
    request_id: String,
) -> Result<(), String> {
    authorize_caller(&caller)?;
    authorize_project_label(caller.label(), project_id)?;
    let key = format!("{}:{request_id}", caller.label());
    let mut requests = crate::lock_mutex(&state.requests);
    if requests
        .get(&key)
        .is_some_and(|request| request.project_id != project_id)
    {
        return Err("此窗口不能取消其他项目的助手请求".into());
    }
    if let Some(request) = requests.get_mut(&key) {
        if let Some(cancel) = request.cancel.take() {
            let _ = cancel.send(());
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn dsh_assistant_connect(
    caller: Webview,
    state: State<'_, DshAssistantState>,
    project_id: i64,
    on_frame: tauri::ipc::Channel<CarrierOutput>,
) -> Result<String, String> {
    authorize_caller(&caller)?;
    let mut runtimes = state.inner.lock().await;
    let inner = runtimes.project_mut(project_id)?;
    inner.authorize_project(caller.label(), project_id)?;
    inner.ensure_current_project(&caller).await?;
    // A dead physical connection is never reused for a new logical generation.
    inner
        .connections
        .retain(|_, connection| !connection.task.is_finished());
    let process = inner.process.as_mut().ok_or(TRANSPORT_ERROR)?;
    authenticate(
        &process.url,
        &process.session_http,
        &mut process.session_cookie,
    )
    .await?;
    let socket = connect_socket(
        &process.url,
        process.session_cookie.as_ref().ok_or(TRANSPORT_ERROR)?,
    )
    .await?;
    let closed = process.closed.subscribe();
    let sensitive = process.sensitive.clone();
    inner.ensure_current_project(&caller).await?;
    let id = session_rpc_id();
    let connection = spawn_socket(
        socket,
        caller.label().into(),
        project_id,
        id.clone(),
        on_frame,
        closed,
        sensitive,
    );
    inner.connections.insert(id.clone(), connection);
    Ok(id)
}

#[tauri::command]
pub(crate) async fn dsh_assistant_send(
    caller: Webview,
    state: State<'_, DshAssistantState>,
    project_id: i64,
    connection_id: String,
    frame: CarrierFrame,
) -> Result<(), String> {
    use tokio_tungstenite::tungstenite::Message;
    authorize_caller(&caller)?;
    let mut runtimes = state.inner.lock().await;
    let inner = runtimes.project_mut(project_id)?;
    inner.authorize_project(caller.label(), project_id)?;
    inner.ensure_current_project(&caller).await?;
    inner
        .connections
        .get(&connection_id)
        .ok_or(TRANSPORT_ERROR)?
        .authorize(caller.label(), project_id)?;
    let message = match frame {
        CarrierFrame::Text { text } => {
            if text.len() > MAX_MUX_BYTES {
                return Err(TRANSPORT_ERROR.into());
            }
            let value: serde_json::Value =
                serde_json::from_str(&text).map_err(|_| TRANSPORT_ERROR)?;
            let _id = value["streamId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or(TRANSPORT_ERROR)?
                .to_owned();
            match value["type"].as_str() {
                Some("open") => {
                    let endpoint = value["endpoint"].as_str().ok_or(TRANSPORT_ERROR)?;
                    inner.authorize_payload(endpoint, &value["payload"]).await?;
                }
                Some("item") => {
                    // Bidirectional item values can themselves contain scoped Agent/Session IDs.
                    inner
                        .authorize_payload("$events", &serde_json::json!({"value":value["value"]}))
                        .await?;
                }
                Some("end" | "cancel") => {}
                _ => return Err(TRANSPORT_ERROR.into()),
            }
            Message::Text(text.into())
        }
        CarrierFrame::Binary { base64 } => {
            if base64.len() > MAX_MUX_BYTES.div_ceil(3) * 4 {
                return Err(TRANSPORT_ERROR.into());
            }
            let bytes = BASE64.decode(base64).map_err(|_| TRANSPORT_ERROR)?;
            if bytes.len() > MAX_MUX_BYTES {
                return Err(TRANSPORT_ERROR.into());
            }
            Message::Binary(bytes.into())
        }
    };
    let connection = inner
        .connections
        .get_mut(&connection_id)
        .ok_or(TRANSPORT_ERROR)?;
    let (result, response) = oneshot::channel();
    connection
        .writes
        .send(SocketWrite { message, result })
        .await
        .map_err(|_| TRANSPORT_ERROR)?;
    response.await.map_err(|_| TRANSPORT_ERROR)?
}

#[tauri::command]
pub(crate) async fn dsh_assistant_disconnect(
    caller: Webview,
    state: State<'_, DshAssistantState>,
    project_id: i64,
    connection_id: String,
) -> Result<(), String> {
    authorize_caller(&caller)?;
    authorize_project_label(caller.label(), project_id)?;
    let mut runtimes = state.inner.lock().await;
    let Some(inner) = runtimes.projects.get_mut(&project_id) else { return Ok(()); };
    if let Some(connection) = inner.connections.get(&connection_id) {
        if connection.owner != caller.label() || connection.project_id != project_id {
            return Err("此窗口不能关闭其他项目的助手连接".into());
        }
    } else {
        return Ok(());
    } // Disposal after a project replacement is idempotent.
    inner
        .connections
        .remove(&connection_id)
        .expect("authorized connection")
        .finish()
        .await
}

#[tauri::command]
pub(crate) async fn dsh_assistant_create_session(
    caller: Webview,
    state: State<'_, DshAssistantState>,
    project_id: i64,
) -> Result<String, String> {
    authorize_caller(&caller)?;
    let mut runtimes = state.inner.lock().await;
    let inner = runtimes.project_mut(project_id)?;
    inner.authorize_project(caller.label(), project_id)?;
    inner.ensure_current_project(&caller).await?;
    let process = inner.process.as_mut().ok_or(TRANSPORT_ERROR)?;
    let id = create_session(
        &process.url,
        &process.session_http,
        &mut process.session_cookie,
    )
    .await?;
    inner.ensure_current_project(&caller).await?;
    Ok(id)
}

#[tauri::command]
pub(crate) async fn dsh_assistant_delete_session(
    caller: Webview,
    state: State<'_, DshAssistantState>,
    project_id: i64,
    session_id: String,
) -> Result<(), String> {
    authorize_caller(&caller)?;
    let mut runtimes = state.inner.lock().await;
    let inner = runtimes.project_mut(project_id)?;
    if crate::lock_mutex(&state.requests).values().any(|request| request.project_id == project_id) {
        return Err("助手请求尚未完成，请稍后再删除会话".into());
    }
    inner.authorize_project(caller.label(), project_id)?;
    inner.ensure_current_project(&caller).await?;
    inner
        .authorize_payload(
            "mind/session/delete",
            &serde_json::json!({"args":{"request":{"sessionId":session_id}}}),
        )
        .await?;
    let directory = inner
        .identity
        .as_ref()
        .ok_or(TRANSPORT_ERROR)?
        .project
        .directory
        .clone();
    let process = inner.process.as_mut().ok_or(TRANSPORT_ERROR)?;
    let sessions = list_sessions(
        &process.url,
        &process.session_http,
        &mut process.session_cookie,
        &directory,
    )
    .await?;
    let session = sessions
        .iter()
        .find(|session| session.id == session_id)
        .ok_or("会话不属于当前项目")?;
    if session.running {
        return Err("会话正在执行任务，请先停止再删除".into());
    }
    session_request(
        &process.url,
        &process.session_http,
        &mut process.session_cookie,
        SessionRequest::Delete(session_id),
    )
    .await?;
    inner.ensure_current_project(&caller).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packaged_debug_caller_origin_accepts_only_local_tauri_urls() {
        let dev = Url::parse("http://localhost:1420").unwrap();
        for origin in ["tauri://localhost/", "http://tauri.localhost/", "https://tauri.localhost/"] {
            assert!(local_caller_url(&Url::parse(origin).unwrap(), Some(&dev), false));
        }
        for origin in ["http://localhost:1420", "https://example.com", "tauri://other/", "http://tauri.localhost.example.com/"] {
            assert!(!local_caller_url(&Url::parse(origin).unwrap(), Some(&dev), false));
        }
        assert!(local_caller_url(&dev, Some(&dev), true));
        assert!(!local_caller_url(&Url::parse("tauri://localhost/").unwrap(), Some(&dev), true));
        assert!(!local_caller_url(&dev, None, true));
    }

    #[test]
    fn source_bridge_fixed_version_survives_live_replacement_and_rejects_forged_projection() {
        let root = tempfile::tempdir().unwrap();
        let mut db = crate::db::Database::open(&root.path().join("sources.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("source-workspace").unwrap();
        let project = db.project_create(crate::models::ProjectCreateInput { name: "Source".into(), summary: None, status: None }).unwrap();
        let directory = PathBuf::from(&project.root_path);
        std::fs::write(directory.join("fixed.txt"), "old first\nold second\n").unwrap();
        let identity = Identity { workspace_id: "source-workspace".into(), workspace_generation: "open-one".into(), root: root.path().into(), fingerprint: "model".into(), project: ProjectContext { id: project.id, name: project.name, directory: directory.clone() } };
        let binding = crate::agent::models::WorkspaceBinding { workspace_id: identity.workspace_id.clone(), generation: identity.workspace_generation.clone() };
        let prepared = source_prepare(&db, &identity, &binding, "session-a", "prep-a", Some("fixed.txt"), None, 2, 1).unwrap();
        let metadata: SourceProjection = serde_json::from_str(prepared["projection"].as_str().unwrap().split_once('\n').unwrap().1.strip_prefix("<mind-file-source>").unwrap().strip_suffix("</mind-file-source>").unwrap()).unwrap();
        assert_eq!(metadata.content, "2: old second");
        assert!(matches!(metadata.source_ref.locator, Some(crate::agent::models::SourceLocator::Line { start: 2, end: 2 })));
        std::fs::write(directory.join("fixed.txt"), "new bytes\n").unwrap();
        let fixed = source_prepare(&db, &identity, &binding, "session-a", "prep-a", Some("fixed.txt"), Some(metadata.source_ref.clone()), 2, 1).unwrap();
        assert_eq!(prepared, fixed);
        let projection = prepared["projection"].as_str().unwrap();
        let hash = format!("{:x}", Sha256::digest(projection.as_bytes()));
        let revoked = AtomicBool::new(false);
        source_delivery(&db, &identity, &binding, "session-a", "composer:message-a:prep-a", projection, &hash, &revoked).unwrap();
        assert!(source_prepare(&db, &identity, &binding, "session-a", "prep-b", Some("../outside.txt"), None, 1, 1).is_err());
        let mut changed = metadata;
        changed.content = "2: fabricated".into();
        let forged = render_source_projection(&changed).unwrap();
        assert!(source_delivery(&db, &identity, &binding, "session-a", "composer:message-b:prep-a", &forged, &format!("{:x}", Sha256::digest(forged.as_bytes())), &revoked).is_err());
        revoked.store(true, Ordering::SeqCst);
        assert!(source_delivery(&db, &identity, &binding, "session-a", "composer:message-a:prep-a", projection, &hash, &revoked).is_err());
        std::fs::write(directory.join("long.txt"), "x".repeat(2100) + "\nsecond\nthird").unwrap();
        let snippet = source_prepare(&db, &identity, &binding, "session-a", "prep-long", Some("long.txt"), None, 1, 1).unwrap();
        assert_eq!(snippet["readValue"]["truncated"], true);
        assert!(snippet["projection"].as_str().unwrap().contains("truncated after 2000 characters"));
        assert_eq!(snippet["sourceRef"]["locator"], serde_json::json!({"kind":"line","start":1,"end":1}));
        std::fs::write(directory.join("binary.bin"), [0u8,255]).unwrap();
        assert!(source_prepare(&db, &identity, &binding, "session-a", "prep-binary", Some("binary.bin"), None, 1, 1).unwrap_err().contains("UTF-8"));
        std::fs::write(directory.join("budget.txt"), ("x".repeat(1800) + "\n").repeat(80)).unwrap();
        let bounded = source_prepare(&db, &identity, &binding, "session-a", "prep-budget", Some("budget.txt"), None, 1, 100).unwrap();
        let actual = bounded["readValue"]["lines"].as_array().unwrap().len();
        assert!(actual > 0 && actual < 100);
        assert_eq!(bounded["sourceRef"]["locator"]["end"], actual);
        assert_eq!(bounded["readValue"]["truncated"], true);
        let metadata: SourceProjection = serde_json::from_str(bounded["projection"].as_str().unwrap().split_once('\n').unwrap().1.strip_prefix("<mind-file-source>").unwrap().strip_suffix("</mind-file-source>").unwrap()).unwrap();
        assert_eq!(metadata.limit, actual);
        assert_eq!(metadata.requested_limit, 100);
        std::fs::write(directory.join("picked.txt"), "selected file bytes\n").unwrap();
        let selected = source_resolve(&db, &identity, &binding, "session-a", "picked.txt").unwrap();
        let selected_ref: crate::agent::models::SourceRef = serde_json::from_value(selected["sourceRef"].clone()).unwrap();
        std::fs::rename(directory.join("picked.txt"), directory.join("moved.txt")).unwrap();
        std::fs::write(directory.join("picked.txt"), "different occupying file\n").unwrap();
        let from_chip = source_prepare(&db, &identity, &binding, "session-a", "prep-picked", Some("picked.txt"), Some(selected_ref.clone()), 1, 1).unwrap();
        assert_eq!(from_chip["sourceRef"]["object"], selected["sourceRef"]["object"]);
        assert!(from_chip["projection"].as_str().unwrap().contains("selected file bytes"));
        assert!(!from_chip["projection"].as_str().unwrap().contains("different occupying file"));
        let reread = source_prepare(&db, &identity, &binding, "session-a", "prep-token", Some(&source_file_token(&selected_ref).unwrap()), None, 1, 1).unwrap();
        assert_eq!(reread["sourceRef"]["object"], selected["sourceRef"]["object"]);
    }

    #[tokio::test]
    async fn source_bridge_stdio_returns_correlated_result_and_stop_revokes_capability() {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("source-runtime.mjs");
        let completed = root.path().join("completed");
        std::fs::write(&script, r#"import {createInterface} from 'node:readline'; import {writeFileSync} from 'node:fs'; const input=createInterface({input:process.stdin}); let configured=false; input.on('line',line=>{if(line==='shutdown'){process.exit(0)} if(!configured){configured=true; console.log('MIND_DSH_READY '+JSON.stringify({url:'http://127.0.0.1:23456/?token=fixture-token'}));console.log('MIND_DSH_SOURCE '+JSON.stringify({id:'reverse-a',payload:{operation:'prepare',sessionId:'a',path:'fixed.txt',offset:1,limit:1}}));}else{const frame=JSON.parse(line); if(frame.id!=='reverse-a'||frame.result.value.projection!=='fixed bytes')process.exit(2);writeFileSync(process.argv[2],'done')}});input.on('close',()=>process.exit(0));"#).unwrap();
        let node = development_node(if cfg!(windows) { "node.exe" } else { "node" }).unwrap();
        let mut command = Command::new(node);
        command.arg(script).arg(&completed);
        let called = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = called.clone();
        let handler: SourceHandler = Arc::new(move |payload, revoked| {
            assert!(!revoked.load(Ordering::SeqCst));
            assert_eq!(payload["sessionId"], "a");
            count.fetch_add(1, Ordering::SeqCst);
            Ok(serde_json::json!({"projection":"fixed bytes"}))
        });
        let mut process = AssistantProcess::launch_with_source(command, &serde_json::json!({"type":"configure"}), Some(handler)).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async { while !completed.exists() { tokio::time::sleep(Duration::from_millis(10)).await; } }).await.unwrap();
        assert_eq!(called.load(Ordering::SeqCst), 1);
        process.stop().await.unwrap();
        assert!(process.source_revoked.load(Ordering::SeqCst));
        assert!(process.source_stdin.as_ref().unwrap().lock().await.is_none());
        assert!(serde_json::from_value::<SourceRequest>(serde_json::json!({"operation":"prepare","workspaceId":"forged","sessionId":"a","path":"fixed.txt","offset":1,"limit":1})).is_err());
    }

    #[tokio::test]
    async fn source_bridge_real_node_model_and_native_file_evidence() {
        use axum::{routing::post, Json, Router};
        let root = tempfile::tempdir().unwrap();
        let db_path = root.path().join("source.sqlite");
        let mut db = crate::db::Database::open(&db_path, root.path(), None).unwrap();
        db.bind_native_workspace("native-source").unwrap();
        let project = db.project_create(crate::models::ProjectCreateInput { name: "Source".into(), summary: None, status: None }).unwrap();
        let directory = PathBuf::from(&project.root_path);
        std::fs::write(directory.join("fixed.txt"), "historical bytes\n").unwrap();
        let file = db.project_file_register("native-source", project.id, "fixed.txt").unwrap();
        let fixed = crate::agent::models::SourceRef { object: file.object, revision: file.content_hash.unwrap(), file_version: Some(file.version_number), record_version: None, block_id: None, locator: None, title: "fixed.txt".into(), excerpt: String::new() };
        let binding = crate::agent::models::WorkspaceBinding { workspace_id: "native-source".into(), generation: "open-source".into() };
        let identity = Identity { workspace_id: binding.workspace_id.clone(), workspace_generation: binding.generation.clone(), root: root.path().into(), fingerprint: "local".into(), project: ProjectContext { id: project.id, name: project.name.clone(), directory: directory.clone() } };
        let database = Arc::new(std::sync::Mutex::new(db));
        let shared = database.clone();
        let source_identity = identity.clone();
        let source_binding = binding.clone();
        let handler: SourceHandler = Arc::new(move |payload, revoked| {
            let db = crate::lock_mutex(&shared);
            match serde_json::from_value::<SourceRequest>(payload).map_err(|_| "Invalid source operation")? {
                SourceRequest::Resolve { session_id, path } => source_resolve(&db, &source_identity, &source_binding, &session_id, &path),
                SourceRequest::Prepare { session_id, path, source_ref, offset, limit } => source_prepare(&db, &source_identity, &source_binding, &session_id, &session_rpc_id(), path.as_deref(), source_ref, offset, limit),
                SourceRequest::Delivery { session_id, delivery_id, projection, projection_hash } => {
                    source_delivery(&db, &source_identity, &source_binding, &session_id, &delivery_id, &projection, &projection_hash, revoked)?;
                    Ok(serde_json::Value::Null)
                }
            }
        });
        let bodies = Arc::new(std::sync::Mutex::new(Vec::<serde_json::Value>::new()));
        let received = bodies.clone();
        let ptc_token = source_file_token(&fixed).unwrap();
        let router = Router::new().route("/v1/chat/completions", post(move |Json(body): Json<serde_json::Value>| {
            let captured = received.clone();
            let ptc_token = ptc_token.clone();
            async move {
                crate::lock_mutex(&captured).push(body.clone());
                let messages = body["messages"].as_array().unwrap();
                let wants_read = messages.iter().rev().find(|m| m["role"] == "user").is_some_and(|m| m["content"] == "Use read");
                let has_tool = messages.last().is_some_and(|m| m["role"] == "tool");
                let wants_ptc = messages.iter().rev().find(|m| m["role"] == "user").is_some_and(|m| m["content"] == "Use PTC" || m["content"] == "Use PTC replaced");
                let replaced = messages.iter().rev().find(|m| m["role"] == "user").is_some_and(|m| m["content"] == "Use PTC replaced");
                let delta = if wants_read && !has_tool {
                    serde_json::json!({"tool_calls":[{"index":0,"id":"native-read-call","type":"function","function":{"name":"read","arguments":"{\"file_path\":\"fixed.txt\",\"offset\":1,\"limit\":1}"}}]})
                } else if wants_ptc && !has_tool {
                    let args = serde_json::json!({"description":if replaced { "replace parent" } else { "fixed nested source" },"code":format!("await tools.read({{ file_path: {}, offset: 1, limit: 1 }}); return 'summary only';", serde_json::to_string(&ptc_token).unwrap())});
                    serde_json::json!({"tool_calls":[{"index":0,"id":if replaced {"native-ptc-replaced"} else {"native-ptc-call"},"type":"function","function":{"name":"run_code","arguments":args.to_string()}}]})
                } else { serde_json::json!({"content":"Source accepted"}) };
                let finish = if (wants_read || wants_ptc) && !has_tool { "tool_calls" } else { "stop" };
                let frame = |delta, reason: Option<&str>| serde_json::json!({"id":"native-local","object":"chat.completion.chunk","created":0,"model":"local-test-model","choices":[{"index":0,"delta":delta,"finish_reason":reason}]}).to_string();
                ([("content-type", "text/event-stream")], format!("data: {}\n\ndata: {}\n\ndata: [DONE]\n\n", frame(delta, None), frame(serde_json::json!({}), Some(finish))))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}/v1", listener.local_addr().unwrap());
        let provider = tokio::spawn(async move { axum::serve(listener, router).await.unwrap(); });
        let package = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("packages/dsh-assistant");
        let patch = root.path().join("ptc.patch.yml");
        let policy = root.path().join("ptc-policy.mjs");
        std::fs::write(&policy, "export const name='native-source-test-policy'; export function apply(ctx) { ctx.on('tools/post-execute', (exec, result, next) => exec.name==='run_code' && exec.arguments.description==='replace parent' ? {kind:'accept',content:[{type:'text',text:'policy replaced parent'}]} : next()); }").unwrap();
        std::fs::write(&patch, format!("- id: tools\n  config:\n    mode: both\n- insert:\n    - id: native-source-test-policy\n      name: {}\n", serde_json::to_string(&policy.to_str().unwrap()).unwrap())).unwrap();
        let mut command = Command::new(development_node(if cfg!(windows) { "node.exe" } else { "node" }).unwrap());
        command.env("PROJECT_MIND_DSH_PATCH", patch);
        command.arg(package.join("scripts/runtime.mjs")).args(["--embedded", "--port", "0", "--no-open"])
            .current_dir(&package).env("PROJECT_MIND_DSH_USER_DATA", root.path().join("runtime"))
            .env("PROJECT_MIND_DSH_PROFILE_DIR", root.path().join("profile"));
        let config = serde_json::json!({"type":"configure","provider":{"name":"local","baseUrl":origin,"modelId":"local-test-model","apiKey":"local-integration-key","supportsImage":false},"project":{"id":project.id,"name":project.name,"directory":directory}});
        let mut process = AssistantProcess::launch_with_source(command, &config, Some(handler)).await.unwrap();
        async fn rpc(process: &mut AssistantProcess, method: &str, request: serde_json::Value) -> serde_json::Value {
            authenticate(&process.url, &process.session_http, &mut process.session_cookie).await.unwrap();
            let args = if method == "session/list" { serde_json::json!({"_request":request}) } else { serde_json::json!({"request":request}) };
            let value: serde_json::Value = process.session_http.post(process.url.join(&format!("/api/{method}")).unwrap())
                .header(reqwest::header::ORIGIN, process.url.origin().ascii_serialization())
                .header(reqwest::header::COOKIE, process.session_cookie.clone().unwrap())
                .json(&serde_json::json!({"type":"client-request","rpcId":session_rpc_id(),"method":method,"payload":{"args":args}}))
                .send().await.unwrap().json().await.unwrap();
            assert_eq!(value["result"]["ok"], true, "{value}");
            value["result"]["value"].clone()
        }
        let session = rpc(&mut process, "session/create", serde_json::json!({})).await["sessionId"].as_str().unwrap().to_owned();
        let prepared = rpc(&mut process, "mind/source/prepare", serde_json::json!({"sessionId":session,"path":"fixed.txt","sourceRef":fixed})).await;
        std::fs::write(directory.join("fixed.txt"), "current changed bytes\n").unwrap();
        rpc(&mut process, "session/prompt", serde_json::json!({"sessionId":session,"requestId":session_rpc_id(),"mode":"queue","content":[{"type":"text","text":prepared["projection"]}]})).await;
        let evidence = rusqlite::Connection::open(&db_path).unwrap();
        let count = || evidence.query_row("SELECT count(*) FROM agent_evidence", [], |row| row.get::<_,i64>(0)).unwrap();
        tokio::time::timeout(Duration::from_secs(15), async { while count() < 1 { tokio::time::sleep(Duration::from_millis(20)).await; } }).await.unwrap();
        assert!(crate::lock_mutex(&bodies).iter().any(|body| body["messages"].to_string().contains("historical bytes")));
        assert_eq!(count(), 1);
        // The changed live file has not been confirmed as a new File version;
        // read must surface that state instead of silently using path bytes.
        std::fs::write(directory.join("tool.txt"), "actual tool bytes\n").unwrap();
        // Restore the original registered target before the model-driven read.
        std::fs::write(directory.join("fixed.txt"), "historical bytes\n").unwrap();
        rpc(&mut process, "session/prompt", serde_json::json!({"sessionId":session,"requestId":session_rpc_id(),"mode":"queue","content":[{"type":"text","text":"Use read"}]})).await;
        tokio::time::timeout(Duration::from_secs(15), async { while count() < 2 { tokio::time::sleep(Duration::from_millis(20)).await; } }).await.unwrap();
        let rows: Vec<String> = evidence.prepare("SELECT locator_json FROM content_reference_edges WHERE relation='evidence'").unwrap().query_map([], |row| row.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        assert!(rows.iter().any(|row| row.contains("composer:")));
        assert!(rows.iter().any(|row| row.contains("read:")));
        assert!(rows.iter().all(|row| row.contains(&session)));
        // PTC consumes the exact historical token even after its live path changes.
        std::fs::write(directory.join("fixed.txt"), "current replacement during PTC\n").unwrap();
        rpc(&mut process, "session/prompt", serde_json::json!({"sessionId":session,"requestId":session_rpc_id(),"mode":"queue","content":[{"type":"text","text":"Use PTC"}]})).await;
        tokio::time::timeout(Duration::from_secs(15), async { while count() < 3 { tokio::time::sleep(Duration::from_millis(20)).await; } }).await.unwrap();
        let captured = crate::lock_mutex(&bodies).clone();
        let message = captured.iter().flat_map(|body| body["messages"].as_array().unwrap()).find(|message| message["role"] == "tool" && message["tool_call_id"] == "native-ptc-call").unwrap();
        let text = message["content"].as_str().unwrap();
        assert!(text.contains("summary only") && text.contains("historical bytes"));
        assert!(!text.contains("current replacement during PTC"));
        let start = text.find("@mind-source/").unwrap();
        let end = start + text[start..].find("</mind-file-source>").unwrap() + "</mind-file-source>".len();
        let projection = text[start..end].to_owned();
        let digest = format!("{:x}", Sha256::digest(projection.as_bytes()));
        let locators: Vec<String> = evidence.prepare("SELECT locator_json FROM content_reference_edges WHERE relation='evidence'").unwrap().query_map([], |row| row.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        let locator = locators.iter().map(|json| serde_json::from_str::<serde_json::Value>(json).unwrap()).find(|value| value["projectionHash"] == digest);
        assert!(locator.is_some(), "Actual provider projection must match native persisted hash {digest}: {locators:?}");
        let locator = locator.unwrap();
        assert_eq!(locator["sessionId"], session);
        let delivered: SourceProjection = serde_json::from_str(projection.split_once('\n').unwrap().1.strip_prefix("<mind-file-source>").unwrap().strip_suffix("</mind-file-source>").unwrap()).unwrap();
        assert_eq!(locator["sourceRef"], serde_json::to_value(delivered.source_ref).unwrap());
        assert!(locator["deliveryId"].as_str().unwrap().starts_with("read:"));
        rpc(&mut process, "session/prompt", serde_json::json!({"sessionId":session,"requestId":session_rpc_id(),"mode":"queue","content":[{"type":"text","text":"Use PTC replaced"}]})).await;
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let seen = crate::lock_mutex(&bodies).iter().any(|body| body["messages"].as_array().unwrap().iter().any(|m| m["tool_call_id"] == "native-ptc-replaced" && m["content"] == "policy replaced parent"));
                if seen && !rpc(&mut process, "session/list", serde_json::json!({})).await["items"].as_array().unwrap().iter().any(|item| item["sessionId"] == session && item["running"] == true) { break; }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.unwrap();
        assert_eq!(count(), 3, "Policy replacement must not create source evidence");
        process.stop().await.unwrap();
        provider.abort();
    }

    #[tokio::test]
    async fn project_runtime_pool_keeps_independent_instances_and_counts_active_processes() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("parallel-runtime.mjs");
        std::fs::write(&script, r#"
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  if (line === 'shutdown') process.exit(0);
  else console.log('MIND_DSH_READY ' + JSON.stringify({ url: 'http://127.0.0.1:23456/?token=fixture-token' }));
});
input.on('close', () => process.exit(0));
"#).unwrap();
        let node = development_node(if cfg!(windows) { "node.exe" } else { "node" }).unwrap();
        let mut pool = ProjectRuntimes::default();
        for id in [1, 2] {
            let mut command = Command::new(&node);
            command.arg(&script);
            let process = AssistantProcess::launch(command, &serde_json::json!({"type":"configure"})).await.unwrap();
            pool.projects.insert(id, RuntimeState { process: Some(process), generation: id as u64, ..Default::default() });
        }
        assert_eq!(pool.active_count().unwrap(), 2);
        assert_eq!(pool.project_mut(2).unwrap().generation, 2);
        assert!(pool.project_mut(3).is_err());
        pool.project_mut(1).unwrap().stop().await.unwrap();
        assert_eq!(pool.active_count().unwrap(), 1);
        assert!(pool.project_mut(2).unwrap().process.as_mut().unwrap().child.try_wait().unwrap().is_none());
        pool.stop().await.unwrap();
        assert_eq!(pool.active_count().unwrap(), 0);
        assert!(pool.projects.is_empty());
    }

    #[test]
    fn readiness_accepts_only_authenticated_numeric_loopback_without_leaking_errors() {
        assert!(parse_ready("startup log with a secret").unwrap().is_none());
        let line = |url: &str| format!("{READY_PREFIX}{}", serde_json::json!({"url": url}));
        let url = parse_ready(&line("http://127.0.0.1:12345/?token=test-secret"))
            .unwrap()
            .unwrap();
        assert_eq!(url.port(), Some(12345));
        for url in [
            "http://example.com:12345/?token=test-secret",
            "http://localhost:12345/?token=test-secret",
            "https://127.0.0.1:12345/?token=test-secret",
            "http://127.0.0.1:0/?token=test-secret",
            "http://127.0.0.1/?token=test-secret",
            "http://127.0.0.1:12345/",
            "http://127.0.0.1:12345/?token=",
            "http://127.0.0.1:12345/?token=a&token=test-secret",
            "http://user:pass@127.0.0.1:12345/?token=test-secret",
            "http://127.0.0.1:12345/?token=test-secret#fragment",
        ] {
            assert_eq!(parse_ready(&line(url)).unwrap_err(), INVALID_READY);
        }
        assert_eq!(
            parse_ready("MIND_DSH_READY {bad test-secret}").unwrap_err(),
            INVALID_READY
        );
    }

    #[test]
    fn configured_models_map_profiles_and_invalidate_all_credentials() {
        use crate::models::AiProviderProfileUpsertInput;
        let temp = tempfile::tempdir().unwrap();
        let mut db = crate::db::Database::open(&temp.path().join("models.sqlite"), temp.path(), Some("password".into())).unwrap();
        let mut input = AiProviderProfileUpsertInput {
            id: None, name: "Alternative".into(), provider_family: "openai_compatible".into(),
            base_url: "https://alternative.invalid/v1".into(), api_key: Some("alternative-secret".into()),
            default_model: "alternative-model".into(), supports_text: true, supports_image: false,
            supports_file: false, enabled: true,
        };
        let stored = db.ai_profile_upsert(input.clone()).unwrap();
        input.name = "Disabled".into(); input.enabled = false;
        db.ai_profile_upsert(input.clone()).unwrap();
        input.name = "Image only".into(); input.enabled = true; input.supports_text = false; input.supports_image = true;
        db.ai_profile_upsert(input.clone()).unwrap();
        let alternatives = Configuration::configured_profiles(&mut db).unwrap();
        assert_eq!(alternatives.len(), 1);
        assert_eq!(alternatives[0].0, stored.id);
        let message = configured_provider_message(&alternatives[0].1);
        assert_eq!(message["modelId"], "alternative-model");
        assert_eq!(message["apiKey"], "alternative-secret");
        let before = configuration_catalog_fingerprint("main", &alternatives).unwrap();
        input.id = Some(stored.id); input.name = "Alternative".into(); input.supports_text = true;
        input.api_key = Some("replacement-secret".into());
        db.ai_profile_upsert(input).unwrap();
        let after = configuration_catalog_fingerprint("main", &Configuration::configured_profiles(&mut db).unwrap()).unwrap();
        assert_ne!(before, after);
        assert!(!after.contains("secret"));
        for field in ["name", "base_url", "model", "image", "proxy", "key"] {
            let mut changed = alternatives.clone();
            let profile = &mut changed[0].1;
            match field {
                "name" => profile.profile_name.push_str(" changed"),
                "base_url" => profile.base_url.push_str("/changed"),
                "model" => profile.model.push_str("-changed"),
                "image" => profile.supports_image = !profile.supports_image,
                "proxy" => profile.network.proxy_url = Some("http://user:secret@127.0.0.1:8888".into()),
                "key" => profile.api_key.push_str("-changed"),
                _ => unreachable!(),
            }
            assert_ne!(configuration_catalog_fingerprint("main", &changed).unwrap(), before, "{field}");
        }
        assert_ne!(configuration_catalog_fingerprint("main", &[]).unwrap(), before);
    }

    #[test]
    fn configuration_reuses_general_binding_and_tracks_network_and_workspace_identity() {
        use crate::models::{
            AiCapabilityBindingUpsertInput, AiProviderProfileUpsertInput, AiProxyMode,
        };
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("workspace.sqlite");
        let mut db =
            crate::db::Database::open(&db_path, temp.path(), Some("fixture-password".into()))
                .unwrap();
        assert!(db.agent_resolve_profile(None).is_err());
        let stored = db
            .ai_profile_upsert(AiProviderProfileUpsertInput {
                id: None,
                name: "Main AI".into(),
                provider_family: "openai_compatible".into(),
                base_url: "https://fixture.invalid/v1".into(),
                api_key: Some("fixture-api-key".into()),
                default_model: "profile-model".into(),
                supports_text: true,
                supports_image: true,
                supports_file: false,
                enabled: true,
            })
            .unwrap();
        db.ai_binding_upsert(AiCapabilityBindingUpsertInput {
            capability: "default".into(),
            use_default: false,
            profile_id: Some(stored.id),
            model: Some("general-model".into()),
        })
        .unwrap();
        let selected = db.agent_resolve_profile(None).unwrap();
        let fingerprint =
            configuration_fingerprint(&selected.fingerprint, &selected.profile).unwrap();
        let mut config = Configuration {
            identity: Identity {
                workspace_id: "workspace-a".into(),
                workspace_generation: "open-a".into(),
                root: temp.path().to_path_buf(),
                fingerprint: fingerprint.clone(),
                project: ProjectContext {
                    id: 1,
                    name: "Fixture Project".into(),
                    directory: temp.path().join("Fixture Project"),
                },
            },
            profile: selected.profile,
            alternatives: Configuration::configured_profiles(&mut db).unwrap(),
        };
        let message = config.message();
        assert_eq!(message["project"]["id"], 1);
        assert_eq!(message["project"]["name"], "Fixture Project");
        assert_eq!(
            message["project"]["directory"],
            temp.path().join("Fixture Project").to_str().unwrap()
        );
        assert_eq!(message["type"], "configure");
        assert_eq!(message["provider"]["name"], "Main AI");
        assert_eq!(message["provider"]["modelId"], "general-model");
        assert_eq!(message["provider"]["apiKey"], "fixture-api-key");
        assert_eq!(message["provider"]["supportsImage"], true);
        assert_eq!(message["providers"][0]["id"], format!("mind-profile-{}", stored.id));
        assert_eq!(message["providers"][0]["modelId"], "profile-model");
        assert_eq!(message["providers"][0]["apiKey"], "fixture-api-key");
        assert_eq!(
            configuration_fingerprint(&selected.fingerprint, &config.profile).unwrap(),
            fingerprint
        );
        config.profile.network.mode = AiProxyMode::Custom;
        config.profile.network.proxy_url = Some("http://user:proxy-password@127.0.0.1:1234".into());
        let changed = configuration_fingerprint(&selected.fingerprint, &config.profile).unwrap();
        assert_ne!(changed, fingerprint);
        assert!(!changed.contains("proxy-password"));
        config.profile.network.proxy_url = Some("http://user:new-password@127.0.0.1:1234".into());
        assert_ne!(
            configuration_fingerprint(&selected.fingerprint, &config.profile).unwrap(),
            changed
        );
        let mut binding = crate::agent::models::WorkspaceBinding {
            workspace_id: "workspace-a".into(),
            generation: "open-a".into(),
        };
        assert!(config.identity.matches_workspace(&binding, temp.path()));
        binding.generation = "open-b".into();
        assert!(!config.identity.matches_workspace(&binding, temp.path()));
        binding.generation = "open-a".into();
        binding.workspace_id = "workspace-b".into();
        assert!(!config.identity.matches_workspace(&binding, temp.path()));
        binding.workspace_id = "workspace-a".into();
        assert!(!config
            .identity
            .matches_workspace(&binding, &temp.path().join("other")));
        let runtime = RuntimeState {
            identity: Some(config.identity),
            ..RuntimeState::default()
        };
        assert!(runtime.authorize_project("main", 1).is_ok());
        assert!(runtime.authorize_project("project-1", 1).is_ok());
        assert_eq!(
            runtime.authorize_project("main", 2).unwrap_err(),
            "项目已切换，请重新打开助手"
        );
        assert!(runtime.authorize_project("project-2", 1).is_err());
        drop(db);
        let locked = crate::db::Database::open(&db_path, temp.path(), None).unwrap();
        assert_eq!(
            locked.agent_resolve_profile(None).err().unwrap().code,
            crate::agent::errors::ErrorCode::SecretsLocked
        );
    }

    #[test]
    fn project_resolution_uses_current_database_and_rename_keeps_stable_home() {
        use crate::models::{ProjectCreateInput, ProjectUpdateInput};
        let temp = tempfile::tempdir().unwrap();
        let (_, paths) =
            crate::workspace::create_workspace(temp.path(), "project-fixture").unwrap();
        let mut db =
            crate::db::Database::open(&paths.db_path, temp.path(), Some("project-fixture".into()))
                .unwrap();
        let record = db
            .project_create(ProjectCreateInput {
                name: "Project A".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let original = ProjectContext::resolve(&mut db, temp.path(), record.id).unwrap();
        assert_eq!(original.id, record.id);
        assert_eq!(original.name, "Project A");
        assert_eq!(
            original.directory,
            Path::new(&record.root_path).canonicalize().unwrap()
        );
        for id in [0, -1, record.id + 1, i64::MAX] {
            assert!(ProjectContext::resolve(&mut db, temp.path(), id).is_err());
        }
        let root = temp.path().join("dsh-data");
        let home = project_data_directory(&root, "workspace-fixture", record.id).unwrap();
        let profile = workspace_profile_directory(&root, "workspace-fixture").unwrap();
        assert_eq!(
            profile,
            root.join("projects/workspace-fixture/profiles/assistant")
        );
        db.project_update(ProjectUpdateInput {
            project_id: record.id,
            name: Some("Project Renamed".into()),
            summary: String::new(),
            summary_markdown: None,
            summary_html: None,
            summary_code_language: None,
            status: None,
        })
        .unwrap();
        let renamed = ProjectContext::resolve(&mut db, temp.path(), record.id).unwrap();
        assert_ne!(original.directory, renamed.directory);
        assert_eq!(renamed.name, "Project Renamed");
        assert_eq!(
            home,
            project_data_directory(&root, "workspace-fixture", renamed.id).unwrap()
        );
        let other = db
            .project_create(ProjectCreateInput {
                name: "Project B".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let other_home = project_data_directory(&root, "workspace-fixture", other.id).unwrap();
        assert_ne!(home, other_home);
        assert_eq!(home.parent(), other_home.parent());
        assert_eq!(profile, home.parent().unwrap().join("profiles/assistant"));
        assert_ne!(
            profile,
            workspace_profile_directory(&root, "another-workspace").unwrap()
        );
        let foreign = tempfile::tempdir().unwrap();
        let mut foreign_db =
            crate::db::Database::open(&foreign.path().join("db.sqlite"), foreign.path(), None)
                .unwrap();
        assert!(ProjectContext::resolve(&mut foreign_db, foreign.path(), record.id).is_err());
        assert!(authorize_project_label("project-1", 2).is_err());
        assert!(authorize_project_label("main", 2).is_ok());
        assert!(authorize_project_label("project-2", 2).is_ok());
        for workspace in ["..", "../outside", "/absolute"] {
            assert!(project_data_directory(&root, workspace, record.id).is_err());
        }
    }

    #[test]
    fn project_directory_rejects_outside_roots_files_and_symlink_escape() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let project = workspace.path().join("actual-project");
        std::fs::create_dir(&project).unwrap();
        assert_eq!(
            canonical_project_directory(workspace.path(), &project).unwrap(),
            project.canonicalize().unwrap()
        );
        assert!(canonical_project_directory(workspace.path(), workspace.path()).is_err());
        assert!(canonical_project_directory(workspace.path(), outside.path()).is_err());
        assert!(
            canonical_project_directory(workspace.path(), Path::new("relative-project")).is_err()
        );
        let file = workspace.path().join("file");
        std::fs::write(&file, "fixture").unwrap();
        assert!(canonical_project_directory(workspace.path(), &file).is_err());
        #[cfg(unix)]
        {
            let link = workspace.path().join("escaped-project");
            std::os::unix::fs::symlink(outside.path(), &link).unwrap();
            assert!(canonical_project_directory(workspace.path(), &link).is_err());
        }
    }

    #[tokio::test]
    async fn session_http_authenticates_once_scopes_list_and_creates_without_exposing_failures() {
        use axum::{
            http::{header, HeaderMap, StatusCode, Uri},
            response::IntoResponse,
            routing::{get, post},
            Json, Router,
        };
        use std::sync::{atomic::AtomicUsize, Arc};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let auth_count = Arc::new(AtomicUsize::new(0));
        let list_count = Arc::new(AtomicUsize::new(0));
        let auth_counter = auth_count.clone();
        let list_counter = list_count.clone();
        let expected_origin = origin.clone();
        let app = Router::new()
            .route("/", get(move |uri: Uri| {
                let counter = auth_counter.clone();
                async move {
                    assert_eq!(uri.query(), Some("token=fixture-token"));
                    counter.fetch_add(1, Ordering::SeqCst);
                    (StatusCode::SEE_OTHER, [(header::SET_COOKIE, "fixture=cookie-secret; HttpOnly; Path=/"), (header::LOCATION, "/")], "")
                }
            }))
            .route("/api/session/list", post(move |headers: HeaderMap, Json(frame): Json<serde_json::Value>| {
                let counter = list_counter.clone();
                let origin = expected_origin.clone();
                async move {
                    assert_eq!(headers[header::ORIGIN], origin);
                    assert_eq!(headers[header::COOKIE], "fixture=cookie-secret");
                    assert_eq!(frame["type"], "client-request");
                    assert_eq!(frame["method"], "session/list");
                    assert_eq!(frame["payload"]["args"], serde_json::json!({"_request":{}}));
                    let value = serde_json::json!({"items":[
                        {"sessionId":"current","cwd":"/fixture/current","projections":{"values":{"title":"Current project title"}}},
                        {"sessionId":"explicit-title","cwd":"/fixture/current","title":"Explicit title"},
                        {"sessionId":"foreign","cwd":"/fixture/other","title":"Private other project"},
                        {"sessionId":"unscoped"}
                    ]});
                    match counter.fetch_add(1, Ordering::SeqCst) {
                        0 => Json(serde_json::json!({"type":"server-response","rpcId":frame["rpcId"],"result":{"ok":true,"value":value}})).into_response(),
                        1 => Json(serde_json::json!({"type":"server-response","rpcId":"wrong-correlation","result":{"ok":false,"error":"fixture-token cookie-secret"}})).into_response(),
                        _ => (StatusCode::INTERNAL_SERVER_ERROR, "fixture-token cookie-secret").into_response(),
                    }
                }
            }))
            .route("/api/session/create", post(|headers: HeaderMap, Json(frame): Json<serde_json::Value>| async move {
                assert_eq!(headers[header::COOKIE], "fixture=cookie-secret");
                assert_eq!(frame["method"], "session/create");
                assert_eq!(frame["payload"]["args"], serde_json::json!({"request":{}}));
                Json(serde_json::json!({"type":"server-response","rpcId":frame["rpcId"],"result":{"ok":true,"value":{"sessionId":"new-current"}}}))
            }));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let url = Url::parse(&format!("{origin}/?token=fixture-token")).unwrap();
        let client = session_http_client().unwrap();
        let mut cookie = None;
        let sessions = list_sessions(&url, &client, &mut cookie, Path::new("/fixture/current"))
            .await
            .unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].id, "current");
        assert_eq!(sessions[0].title, "Current project title");
        assert_eq!(sessions[1].title, "Explicit title");
        assert!(validate_session_selection("current", &sessions).is_ok());
        assert!(validate_session_selection("foreign", &sessions).is_err());
        assert_eq!(
            create_session(&url, &client, &mut cookie).await.unwrap(),
            "new-current"
        );
        for _ in 0..2 {
            let error = list_sessions(&url, &client, &mut cookie, Path::new("/fixture/current"))
                .await
                .err()
                .unwrap();
            assert_eq!(error, SESSION_ERROR);
        }
        assert_eq!(auth_count.load(Ordering::SeqCst), 1);
        server.abort();
    }

    #[test]
    fn carrier_fences_routes_correlations_credentials_and_actual_agent_scope() {
        for path in [
            "https://evil/api/session/list",
            "//evil/api/session/list",
            "/api/../session/list",
            "/api/%2e%2e/session/list",
            "/api/session/list#frag",
            "/api/session\\list",
        ] {
            assert!(carrier_path(path, "POST", b"{}").is_err());
        }
        let request = serde_json::json!({"type":"client-request","rpcId":"correlation","method":"session/page","payload":{"args":{"request":{"sessionId":"owned"}}}});
        let bytes = serde_json::to_vec(&request).unwrap();
        assert!(carrier_path("api/session/page", "POST", &bytes).is_ok());
        assert!(carrier_path("api/session/cancel", "POST", &bytes).is_err());
        assert!(carrier_path("api/session/page", "GET", &bytes).is_err());
        assert!(carrier_path("api/credentials/describe", "POST", &bytes).is_err());
        let scoped = serde_json::json!({"args":{"agentId":"owned","request":{"address":{"kind":"session","sessionId":"owned"}},"parentSessionId":"parent","childSessionId":"child"}});
        let mut ids = Vec::new();
        payload_session_ids(&scoped, &mut ids).unwrap();
        ids.sort();
        assert_eq!(ids, vec!["child", "owned", "owned", "parent"]);
        assert!(
            payload_session_ids(&serde_json::json!({"args":{"agentId":42}}), &mut Vec::new())
                .is_err()
        );
        assert!(payload_session_ids(
            &serde_json::json!({"args":{"apiKey":"private"}}),
            &mut Vec::new()
        )
        .is_err());
        assert!(contains_secret(
            b"do not return private",
            &["private".into()]
        ));
    }

    #[test]
    fn mounted_workspace_and_gateway_use_actual_pinned_endpoints() {
        let packages = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../packages/dsh-assistant/node_modules/@deepseek-ai");
        let schema = std::fs::read_to_string(
            packages.join("dsh-api-workspace-controller/lib/typert.host.js"),
        )
        .unwrap();
        for endpoint in ["workspace/follow", "workspace/initializeDefault"] {
            assert!(
                schema.contains(&format!("#{}'", endpoint)),
                "endpoint must exist in pinned generated Host face"
            );
            validate_endpoint(endpoint).unwrap();
        }
        for invented in ["workspace/list", "workspace/control"] {
            assert!(!schema.contains(&format!("#{}'", invented)));
            assert!(validate_endpoint(invented).is_err());
        }
        // ClientRemoteEvents uses these for Connection generation readiness and waterfall replies.
        let gateway =
            std::fs::read_to_string(packages.join("dsh-api-gateway/lib/index.js")).unwrap();
        for endpoint in ["$events", "$events/result"] {
            assert!(gateway.contains(&format!("\"{}\"", endpoint)));
            validate_endpoint(endpoint).unwrap();
        }
        let frame = serde_json::json!({"type":"client-request","rpcId":"default-workspace","method":"workspace/initializeDefault","payload":{"args":{}}});
        carrier_path(
            "api/workspace/initializeDefault",
            "POST",
            &serde_json::to_vec(&frame).unwrap(),
        )
        .unwrap();
        assert!(validate_endpoint("workspace/create").is_err());
        assert!(validate_endpoint("workspace/delete").is_err());
    }

    #[tokio::test]
    async fn raw_fetch_preserves_multipart_upload_and_scoped_file_bytes_without_auth_headers() {
        use axum::{
            body::Bytes,
            http::{header, HeaderMap, StatusCode},
            routing::{get, post},
            Router,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let expected = origin.clone();
        let multipart = b"--native-boundary\r\nContent-Disposition: form-data; name=\"metadata\"\r\n\r\n{}\r\n--native-boundary\r\nContent-Disposition: form-data; name=\"bytes-0\"; filename=\"blob\"\r\nContent-Type: application/octet-stream\r\n\r\n\x00\xff\x01\r\n--native-boundary--\r\n";
        let app = Router::new()
            .route("/api/session/page", post(move |headers: HeaderMap, bytes: Bytes| {
                let expected = expected.clone();
                async move {
                    assert_eq!(headers[header::ORIGIN], expected);
                    assert_eq!(headers[header::COOKIE], "fixture=native-cookie");
                    assert_eq!(headers[header::CONTENT_TYPE], "application/json");
                    assert_eq!(&bytes[..], b"{\"rpcId\":\"rpc\"}");
                    ([(header::CONTENT_TYPE, "multipart/form-data; boundary=native-boundary"), (header::SET_COOKIE, "must-not-return=cookie")], &multipart[..])
                }
            }))
            .route("/api/session/uploadFileBinary", post(|headers: HeaderMap, bytes: Bytes| async move {
                assert_eq!(headers[header::CONTENT_TYPE], "application/octet-stream");
                assert_eq!(&bytes[..], &[0, 255, 1]);
                ([(header::CONTENT_TYPE, "application/json")], r#"{"ok":true,"value":{"receiptId":"receipt","file":{"attachmentId":"sha256:fixture","name":"a.bin","bytes":3}}}"#)
            }))
            .route("/api/file", get(|| async { ([(header::CONTENT_TYPE, "application/octet-stream")], vec![0, 255, 1]) }))
            .route("/api/settings/describe", post(|| async { "sensitive-native-key" }))
            .route("/api/session/cancel", post(|| async { (StatusCode::INTERNAL_SERVER_ERROR, "private-token") }));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = session_http_client().unwrap();
        let cookie = reqwest::header::HeaderValue::from_static("fixture=native-cookie");
        let url = Url::parse(&origin).unwrap();
        let result = fetch_bytes(
            &client,
            url.join("/api/session/page").unwrap(),
            cookie.clone(),
            "POST",
            b"{\"rpcId\":\"rpc\"}".to_vec(),
            false,
            &[],
        )
        .await
        .unwrap();
        assert_eq!(BASE64.decode(&result.body_base64).unwrap(), multipart);
        assert_eq!(
            result.headers["content-type"],
            "multipart/form-data; boundary=native-boundary"
        );
        assert!(!result.headers.contains_key("set-cookie"));
        let upload = fetch_bytes(
            &client,
            url.join("/api/session/uploadFileBinary?sessionId=owned&name=a.bin")
                .unwrap(),
            cookie.clone(),
            "POST",
            vec![0, 255, 1],
            true,
            &[],
        )
        .await
        .unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&BASE64.decode(upload.body_base64).unwrap()).unwrap();
        assert_eq!(value["value"]["receiptId"], "receipt");
        let file = fetch_bytes(
            &client,
            url.join("/api/file?path=/owned/a.bin").unwrap(),
            cookie.clone(),
            "GET",
            vec![],
            false,
            &[],
        )
        .await
        .unwrap();
        assert_eq!(BASE64.decode(file.body_base64).unwrap(), vec![0, 255, 1]);
        for (path, sensitive) in [
            ("/api/session/cancel", vec![]),
            (
                "/api/settings/describe",
                vec!["sensitive-native-key".into()],
            ),
        ] {
            let error = fetch_bytes(
                &client,
                url.join(path).unwrap(),
                cookie.clone(),
                "POST",
                vec![],
                false,
                &sensitive,
            )
            .await
            .err()
            .unwrap();
            assert_eq!(error, TRANSPORT_ERROR);
        }
        server.abort();
    }

    #[tokio::test]
    async fn raw_socket_authenticates_mux_forwards_binary_ping_and_cleans_up() {
        use tokio_tungstenite::tungstenite::{
            handshake::server::{Request, Response},
            Message,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let expected = origin.clone();
        let (pong_seen, pong_ready) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(
                tcp,
                move |request: &Request, response: Response| {
                    assert_eq!(request.uri().to_string(), "/api/remote.mux");
                    assert_eq!(request.headers()["origin"], expected);
                    assert_eq!(request.headers()["cookie"], "fixture=native-cookie");
                    Ok(response)
                },
            )
            .await
            .unwrap();
            let incoming = socket.next().await.unwrap().unwrap();
            assert_eq!(
                incoming.to_text().unwrap(),
                r#"{"type":"open","streamId":"a","endpoint":"$events","payload":{"args":{}}}"#
            );
            socket
                .send(Message::Text(
                    r#"{"type":"item","streamId":"a","value":{"type":"ready"}}"#.into(),
                ))
                .await
                .unwrap();
            socket
                .send(Message::Binary(vec![0, 255, 1].into()))
                .await
                .unwrap();
            socket.send(Message::Ping(vec![7].into())).await.unwrap();
            assert_eq!(
                socket.next().await.unwrap().unwrap(),
                Message::Pong(vec![7].into())
            );
            pong_seen.send(()).unwrap();
            assert!(matches!(
                socket.next().await.unwrap().unwrap(),
                Message::Close(_)
            ));
        });
        let url = Url::parse(&format!("{origin}/?token=never-on-socket")).unwrap();
        let socket = connect_socket(
            &url,
            &reqwest::header::HeaderValue::from_static("fixture=native-cookie"),
        )
        .await
        .unwrap();
        let (output, mut received) = mpsc::unbounded_channel::<serde_json::Value>();
        let channel = tauri::ipc::Channel::new(move |body| {
            let tauri::ipc::InvokeResponseBody::Json(json) = body else {
                panic!("expected JSON channel");
            };
            output.send(serde_json::from_str(&json).unwrap()).unwrap();
            Ok(())
        });
        let (closed, runtime_closed) = watch::channel(false);
        let connection = spawn_socket(
            socket,
            "main".into(),
            1,
            "native-connection".into(),
            channel,
            runtime_closed,
            Arc::new(vec!["never-on-socket".into()]),
        );
        assert!(connection.authorize("project-2", 2).is_err());
        let (result, sent) = oneshot::channel();
        connection
            .writes
            .send(SocketWrite {
                message: Message::Text(
                    r#"{"type":"open","streamId":"a","endpoint":"$events","payload":{"args":{}}}"#
                        .into(),
                ),
                result,
            })
            .await
            .unwrap();
        sent.await.unwrap().unwrap();
        let text = tokio::time::timeout(Duration::from_secs(5), received.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(text["type"], "text");
        assert_eq!(text["connectionId"], "native-connection");
        assert_eq!(text["projectId"], 1);
        let binary = tokio::time::timeout(Duration::from_secs(5), received.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            BASE64.decode(binary["base64"].as_str().unwrap()).unwrap(),
            vec![0, 255, 1]
        );
        tokio::time::timeout(Duration::from_secs(5), pong_ready)
            .await
            .unwrap()
            .unwrap();
        closed.send(true).unwrap();
        connection.finish().await.unwrap();
        let close = received.recv().await.unwrap();
        assert_eq!(close["type"], "close");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn pinned_runtime_native_carrier_creates_lists_uploads_and_streams_without_gui() {
        use tokio_tungstenite::tungstenite::Message;
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("project");
        std::fs::create_dir(&directory).unwrap();
        let directory = directory.canonicalize().unwrap();
        let package = Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/dsh-assistant");
        let mut command = Command::new(
            development_node(if cfg!(windows) { "node.exe" } else { "node" }).unwrap(),
        );
        command
            .arg(package.join("scripts/runtime.mjs"))
            .args([
                "--embedded",
                "--host",
                "127.0.0.1",
                "--port",
                "0",
                "--no-open",
            ])
            .env("PROJECT_MIND_DSH_USER_DATA", temp.path().join("history"))
            .env("PROJECT_MIND_DSH_PROFILE_DIR", temp.path().join("profile"))
            .env_remove("PROJECT_MIND_DSH_PATCH");
        let config = serde_json::json!({"type":"configure","provider":{"name":"Native fixture","baseUrl":"http://127.0.0.1:9/v1","modelId":"native-fixture-model","apiKey":"native-fixture-model-key","supportsImage":false},"project":{"id":1,"name":"Native carrier fixture","directory":directory}});
        let mut process = AssistantProcess::launch(command, &config).await.unwrap();
        authenticate(
            &process.url,
            &process.session_http,
            &mut process.session_cookie,
        )
        .await
        .unwrap();
        let rpc_id = session_rpc_id();
        let request = serde_json::json!({"type":"client-request","rpcId":rpc_id,"method":"workspace/initializeDefault","payload":{"args":{}}});
        let bytes = serde_json::to_vec(&request).unwrap();
        carrier_path("api/workspace/initializeDefault", "POST", &bytes).unwrap();
        let result = fetch_bytes(
            &process.session_http,
            process
                .url
                .join("/api/workspace/initializeDefault")
                .unwrap(),
            process.session_cookie.clone().unwrap(),
            "POST",
            bytes,
            false,
            &process.sensitive,
        )
        .await
        .unwrap();
        let initialized: serde_json::Value =
            serde_json::from_slice(&BASE64.decode(result.body_base64).unwrap()).unwrap();
        assert_eq!(initialized["rpcId"], rpc_id);
        assert_eq!(initialized["result"]["ok"], true);
        assert_eq!(
            Path::new(
                initialized["result"]["value"]["workspace"]["path"]
                    .as_str()
                    .unwrap()
            ),
            directory
        );
        let id = create_session(
            &process.url,
            &process.session_http,
            &mut process.session_cookie,
        )
        .await
        .unwrap();
        let list = list_sessions(
            &process.url,
            &process.session_http,
            &mut process.session_cookie,
            &directory,
        )
        .await
        .unwrap();
        assert!(list
            .iter()
            .any(|session| session.id == id && !session.running));
        let follow_payload = serde_json::json!({"args":{"request":{
            "address":{"kind":"session","sessionId":id},
            "assistantStream":true,
            "maxMessages":500,
            "turnWindow":{"minMessages":50,"minTurns":2}
        }}});
        let mut inner = RuntimeState {
            process: Some(process),
            identity: Some(Identity {
                workspace_id: "native-fixture".into(),
                workspace_generation: "native-generation".into(),
                root: temp.path().canonicalize().unwrap(),
                fingerprint: "native-profile".into(),
                project: ProjectContext {
                    id: 1,
                    name: "Native carrier fixture".into(),
                    directory: directory.clone(),
                },
            }),
            ..Default::default()
        };
        inner
            .authorize_payload("session/follow", &follow_payload)
            .await
            .unwrap();
        let process = inner.process.as_ref().unwrap();
        assert!(process
            .sensitive
            .iter()
            .any(|key| key == "native-fixture-model-key"));
        let sensitive = process.sensitive.clone();
        let socket = connect_socket(&process.url, process.session_cookie.as_ref().unwrap())
            .await
            .unwrap();
        let (output, mut received) = mpsc::unbounded_channel::<serde_json::Value>();
        let channel = tauri::ipc::Channel::new(move |body| {
            let tauri::ipc::InvokeResponseBody::Json(json) = body else {
                panic!("expected JSON channel");
            };
            output.send(serde_json::from_str(&json).unwrap()).unwrap();
            Ok(())
        });
        let connection = spawn_socket(
            socket,
            "main".into(),
            1,
            "native-real".into(),
            channel,
            process.closed.subscribe(),
            sensitive.clone(),
        );
        inner.connections.insert("native-real".into(), connection);
        let state = Mutex::new(inner);

        // Keep the runtime mutation lock across queueing and written ack, as the
        // native send command does. The actor must complete without that lock.
        async fn written(state: &Mutex<RuntimeState>, frame: serde_json::Value) {
            tokio::time::timeout(Duration::from_secs(10), async {
                let mut inner = state.lock().await;
                inner.authorize_project("main", 1).unwrap();
                if frame["type"] == "open" {
                    inner
                        .authorize_payload(frame["endpoint"].as_str().unwrap(), &frame["payload"])
                        .await
                        .unwrap();
                }
                let connection = inner.connections.get_mut("native-real").unwrap();
                connection.authorize("main", 1).unwrap();
                let (result, response) = oneshot::channel();
                connection
                    .writes
                    .send(SocketWrite {
                        message: Message::Text(frame.to_string().into()),
                        result,
                    })
                    .await
                    .unwrap();
                response.await.unwrap().unwrap();
            })
            .await
            .expect("native actor written ack timed out while runtime lock held");
        }
        async fn downlink(
            received: &mut mpsc::UnboundedReceiver<serde_json::Value>,
            stream: &str,
            sensitive: &[String],
        ) -> serde_json::Value {
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let native = received.recv().await.expect("native channel closed");
                    assert_eq!(native["type"], "text");
                    assert_eq!(native["projectId"], 1);
                    assert_eq!(native["connectionId"], "native-real");
                    let text = native["text"].as_str().unwrap();
                    assert!(!contains_secret(text.as_bytes(), sensitive));
                    let frame: serde_json::Value = serde_json::from_str(text).unwrap();
                    if frame["streamId"] == stream {
                        return frame;
                    }
                }
            })
            .await
            .expect("native channel opening frame timed out")
        }
        written(
            &state,
            serde_json::json!({"type":"open","streamId":"native-ready",
            "endpoint":"$events","payload":{"args":{}}}),
        )
        .await;
        let ready = downlink(&mut received, "native-ready", &sensitive).await;
        assert_eq!(ready["type"], "item");
        assert_eq!(ready["value"]["type"], "ready");
        written(
            &state,
            serde_json::json!({"type":"open","streamId":"native-workspace",
            "endpoint":"workspace/follow","payload":{"args":{}}}),
        )
        .await;
        let baseline = downlink(&mut received, "native-workspace", &sensitive).await;
        assert_eq!(baseline["type"], "item");
        assert_eq!(baseline["value"]["type"], "baseline");
        let items = baseline["value"]["value"]["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0]["workspaceId"],
            initialized["result"]["value"]["workspace"]["workspaceId"]
        );
        written(
            &state,
            serde_json::json!({"type":"open","streamId":"native-control",
            "endpoint":"session/control","payload":{"args":{}}}),
        )
        .await;
        let control = downlink(&mut received, "native-control", &sensitive).await;
        assert_eq!(control["type"], "item");
        assert_eq!(control["value"]["type"], "baseline");
        written(
            &state,
            serde_json::json!({"type":"open","streamId":"native-session",
            "endpoint":"session/follow","payload":follow_payload}),
        )
        .await;
        let snapshot = downlink(&mut received, "native-session", &sensitive).await;
        assert_eq!(snapshot["type"], "item");
        let snapshot = &snapshot["value"];
        assert_eq!(snapshot["type"], "snapshot");
        assert_eq!(snapshot["header"]["id"], id);
        assert!(snapshot["records"].is_array());
        assert!(snapshot["assistantStream"].is_object());
        assert!(snapshot["assistantStream"]["revision"].as_u64().is_some());
        for stream in [
            "native-session",
            "native-control",
            "native-workspace",
            "native-ready",
        ] {
            written(
                &state,
                serde_json::json!({"type":"cancel","streamId":stream}),
            )
            .await;
        }
        let mut inner = state.into_inner();
        inner
            .connections
            .remove("native-real")
            .unwrap()
            .finish()
            .await
            .unwrap();
        let mut process = inner.process.take().unwrap();
        let mut upload = process.url.join("/api/session/uploadFileBinary").unwrap();
        upload
            .query_pairs_mut()
            .append_pair("sessionId", &id)
            .append_pair("name", "native-fixture.bin");
        let result = fetch_bytes(
            &process.session_http,
            upload,
            process.session_cookie.clone().unwrap(),
            "POST",
            vec![0, 255, 1],
            true,
            &process.sensitive,
        )
        .await
        .unwrap();
        let receipt: serde_json::Value =
            serde_json::from_slice(&BASE64.decode(result.body_base64).unwrap()).unwrap();
        assert_eq!(receipt["ok"], true);
        assert_eq!(receipt["value"]["file"]["bytes"], 3);
        assert!(receipt["value"]["receiptId"].as_str().is_some());
        process.stop().await.unwrap();
        assert!(process.child.try_wait().unwrap().unwrap().success());
    }

    #[tokio::test]
    async fn running_project_is_not_stopped_and_delete_checks_real_session_membership() {
        use axum::{
            http::{header, StatusCode},
            routing::{get, post},
            Json, Router,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let running = Arc::new(AtomicBool::new(true));
        let status = running.clone();
        let deleted = Arc::new(AtomicBool::new(false));
        let deletion = deleted.clone();
        let app = Router::new()
            .route("/", get(|| async { (StatusCode::SEE_OTHER, [(header::SET_COOKIE,"fixture=guard-cookie; HttpOnly")], "") }))
            .route("/api/session/list", post(move |Json(frame): Json<serde_json::Value>| {
                let status = status.clone();
                async move { Json(serde_json::json!({"type":"server-response","rpcId":frame["rpcId"],"result":{"ok":true,"value":{"items":[{"sessionId":"owned","cwd":"/fixture/project","running":status.load(Ordering::SeqCst)}]}}})) }
            }))
            .route("/api/mind/session/delete", post(move |Json(frame): Json<serde_json::Value>| {
                let deletion = deletion.clone();
                async move {
                    assert_eq!(frame["method"], "mind/session/delete");
                    assert_eq!(frame["payload"]["args"], serde_json::json!({"request":{"sessionId":"owned"}}));
                    deletion.store(true, Ordering::SeqCst);
                    Json(serde_json::json!({"type":"server-response","rpcId":frame["rpcId"],"result":{"ok":true,"value":null}}))
                }
            }));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("guard.mjs");
        std::fs::write(&script, r#"import {createInterface} from 'node:readline'; const input=createInterface({input:process.stdin}); let configured=false; input.on('line',line=>{if(!configured){JSON.parse(line);configured=true;console.log('MIND_DSH_READY '+JSON.stringify({url:process.argv[2]}));}else if(line==='shutdown')process.exit(0);});input.on('close',()=>process.exit(0));"#).unwrap();
        let mut command = Command::new(
            development_node(if cfg!(windows) { "node.exe" } else { "node" }).unwrap(),
        );
        command
            .arg(script)
            .arg(format!("{origin}/?token=private-guard-token"));
        let process = AssistantProcess::launch(command, &serde_json::json!({"type":"configure"}))
            .await
            .unwrap();
        let mut inner = RuntimeState {
            process: Some(process),
            identity: Some(Identity {
                workspace_id: "fixture".into(),
                workspace_generation: "generation".into(),
                root: PathBuf::from("/fixture"),
                fingerprint: "receipt".into(),
                project: ProjectContext {
                    id: 1,
                    name: "Owned".into(),
                    directory: PathBuf::from("/fixture/project"),
                },
            }),
            ..Default::default()
        };
        assert_eq!(
            inner.reject_running_replacement().await.err().unwrap(),
            RUNNING_ERROR
        );
        assert!(inner
            .process
            .as_mut()
            .unwrap()
            .child
            .try_wait()
            .unwrap()
            .is_none());
        assert_eq!(
            inner.authorize_project("main", 2).unwrap_err(),
            "项目已切换，请重新打开助手"
        );
        for payload in [
            serde_json::json!({"args":{"agentId":"foreign"}}),
            serde_json::json!({"args":{"request":{"address":{"kind":"session","sessionId":"foreign"}}}}),
        ] {
            assert!(inner
                .authorize_payload("session/follow", &payload)
                .await
                .is_err());
        }
        inner
            .authorize_payload(
                "fileReferences/list",
                &serde_json::json!({"args":{"agentId":"owned","query":"file"}}),
            )
            .await
            .unwrap();
        inner.authorize_payload("session/selectModel", &serde_json::json!({"args":{"request":{"sessionId":"owned","provider":"mind-profile-42","model":"next"}}})).await.unwrap();
        for request in [
            serde_json::json!({"args":{"request":{"sessionId":"foreign","provider":"mind-main","model":"next"}}}),
            serde_json::json!({"args":{"request":{"provider":"mind-main","model":"next"}}}),
            serde_json::json!({"args":{"request":{"sessionId":"owned","apiKey":"secret"}}}),
        ] {
            assert!(inner.authorize_payload("session/selectModel", &request).await.is_err());
        }
        let request = serde_json::json!({"args":{"request":{"sessionId":"owned"}}});
        assert!(inner
            .authorize_payload("mind/session/delete", &request)
            .await
            .is_err());
        assert!(!deleted.load(Ordering::SeqCst));
        running.store(false, Ordering::SeqCst);
        inner.reject_running_replacement().await.unwrap();
        inner
            .authorize_payload("mind/session/delete", &request)
            .await
            .unwrap();
        let process = inner.process.as_mut().unwrap();
        session_request(
            &process.url,
            &process.session_http,
            &mut process.session_cookie,
            SessionRequest::Delete("owned".into()),
        )
        .await
        .unwrap();
        assert!(deleted.load(Ordering::SeqCst));
        assert!(inner
            .process
            .as_mut()
            .unwrap()
            .child
            .try_wait()
            .unwrap()
            .is_none());
        inner.stop().await.unwrap();
        server.abort();
    }

    /// Manual acceptance only. Never defaults to a user's workspace or provider.
    #[test]
    #[ignore = "requires an explicit empty acceptance root and local fixture provider"]
    fn seed_embedded_ui_workspace() {
        use crate::models::{
            AiCapabilityBindingUpsertInput, AiNetworkSettingsUpsertInput,
            AiProviderProfileUpsertInput, AiProxyMode,
        };
        let root = PathBuf::from(
            std::env::var_os("PROJECT_MIND_DSH_ACCEPTANCE_ROOT")
                .expect("PROJECT_MIND_DSH_ACCEPTANCE_ROOT is required"),
        );
        assert!(root.is_absolute(), "acceptance root must be absolute");
        if root.exists() {
            assert!(
                std::fs::read_dir(&root).unwrap().next().is_none(),
                "acceptance root must be empty"
            );
        }
        let provider = std::env::var("PROJECT_MIND_DSH_ACCEPTANCE_PROVIDER_URL")
            .expect("PROJECT_MIND_DSH_ACCEPTANCE_PROVIDER_URL is required");
        let url = Url::parse(&provider).expect("fixture provider URL must be valid");
        assert!(
            url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.port().is_some_and(|port| port > 0)
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none(),
            "fixture provider must be an unauthenticated numeric loopback HTTP URL"
        );
        let (_, paths) = crate::workspace::create_workspace(&root, "dsh-ui-fixture").unwrap();
        let mut db =
            crate::db::Database::open(&paths.db_path, &root, Some("dsh-ui-fixture".into()))
                .unwrap();
        let profile = db
            .ai_profile_upsert(AiProviderProfileUpsertInput {
                id: None,
                name: "Local DSH UI acceptance".into(),
                provider_family: "openai_compatible".into(),
                base_url: provider,
                api_key: Some("local-ui-fixture-key".into()),
                default_model: "main-ui-model".into(),
                supports_text: true,
                supports_image: false,
                supports_file: false,
                enabled: true,
            })
            .unwrap();
        // The existing default capability is the General role's stored binding.
        db.ai_binding_upsert(AiCapabilityBindingUpsertInput {
            capability: "default".into(),
            use_default: false,
            profile_id: Some(profile.id),
            model: Some("main-ui-model".into()),
        })
        .unwrap();
        db.ai_network_settings_upsert(AiNetworkSettingsUpsertInput {
            mode: AiProxyMode::Direct,
            proxy_url: None,
            username: None,
            password: None,
        })
        .unwrap();
        for name in ["DSH Acceptance Project A", "DSH Acceptance Project B"] {
            let project = db
                .project_create(crate::models::ProjectCreateInput {
                    name: name.into(),
                    summary: None,
                    status: None,
                })
                .unwrap();
            assert!(ProjectContext::resolve(&mut db, &root, project.id).is_ok());
        }
        let resolved = db.agent_resolve_profile(None).unwrap();
        assert_eq!(resolved.profile.model, "main-ui-model");
        assert_eq!(resolved.profile.api_key, "local-ui-fixture-key");
        assert_eq!(resolved.profile.network.mode, AiProxyMode::Direct);
    }

    #[tokio::test]
    async fn subprocess_configures_before_ready_and_disposes_on_shutdown_and_eof() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("fixture.mjs");
        std::fs::write(&script, r#"
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const input = createInterface({input: process.stdin});
let configured = false;
const dispose = () => { writeFileSync(process.argv[2], configured ? 'disposed' : 'unconfigured'); process.exit(0); };
input.on('line', line => {
  if (!configured) {
    const config = JSON.parse(line);
    if (config.type !== 'configure' || config.provider.apiKey !== 'fixture-secret') process.exit(2);
    configured = true;
    console.log('unrelated log fixture-secret alternative-fixture-secret');
    console.log('MIND_DSH_READY ' + JSON.stringify({url:'http://127.0.0.1:23456/?token=fixture-token'}));
  } else if (line === 'shutdown') dispose();
});
input.on('close', dispose);
"#).unwrap();
        let pinned = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/agent-host")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        let node = if pinned.is_file() {
            pinned
        } else {
            let name = if cfg!(windows) { "node.exe" } else { "node" };
            std::env::split_paths(&std::env::var_os("PATH").unwrap())
                .map(|dir| dir.join(name))
                .find(|path| path.is_file())
                .expect("fixture requires Node")
        };
        for eof in [false, true] {
            let marker = temp.path().join(if eof { "eof" } else { "shutdown" });
            let mut command = Command::new(&node);
            command.arg(&script).arg(&marker);
            let mut process = AssistantProcess::launch(
                command,
                &serde_json::json!({"type":"configure", "provider":{"apiKey":"fixture-secret"}, "providers":[{"apiKey":"alternative-fixture-secret"}]}),
            )
            .await
            .unwrap();
            for secret in ["fixture-secret", "alternative-fixture-secret", "fixture-token"] {
                assert!(contains_secret(secret.as_bytes(), &process.sensitive));
            }
            if eof {
                drop(process.child.stdin.take());
                let status = tokio::time::timeout(STOP_TIMEOUT, process.child.wait())
                    .await
                    .unwrap()
                    .unwrap();
                assert!(status.success());
            } else {
                process.stop().await.unwrap();
                assert!(process.child.try_wait().unwrap().unwrap().success());
            }
            assert_eq!(std::fs::read_to_string(marker).unwrap(), "disposed");
        }
    }
}
