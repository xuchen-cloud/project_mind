//! Read and manage DSH Skills without starting an assistant or resolving a model.
use std::{path::PathBuf, process::Stdio, time::Duration};

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};
use tauri::Manager;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Notify,
};

use crate::{
    agent::models::WorkspaceBinding,
    dsh_assistant::{
        assistant_data_root, assistant_script_command, runtime_data_directory, ProjectContext,
    },
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SkillCatalog {
    skills: Vec<Skill>,
    directories: Vec<String>,
    complete: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Skill {
    name: String,
    description: String,
    // Required in the wire contract, while allowing JSON null.
    #[serde(deserialize_with = "Option::<String>::deserialize")]
    path: Option<String>,
    source: String,
    disabled: bool,
    #[serde(deserialize_with = "Option::<String>::deserialize")]
    entry_path: Option<String>,
    #[serde(deserialize_with = "Option::<String>::deserialize")]
    directory: Option<String>,
    can_delete: bool,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SkillAction {
    Enable,
    Disable,
    Delete,
}

impl SkillAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Enable => "enable",
            Self::Disable => "disable",
            Self::Delete => "delete",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct WorkspaceSnapshot {
    binding: WorkspaceBinding,
    root: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
struct CatalogContext {
    workspace: Option<WorkspaceSnapshot>,
    cwd: PathBuf,
    user_data: PathBuf,
}

impl CatalogContext {
    fn resolve(app: &tauri::AppHandle, project_id: Option<i64>) -> Result<Self, String> {
        let data_root = assistant_data_root()?;
        let state = app.state::<crate::AppState>();
        let current = crate::lock_mutex(&state.current_workspace);
        let workspace = current.as_ref().map(|runtime| WorkspaceSnapshot {
            binding: runtime.agent_binding.clone(),
            root: runtime.paths.root_path.clone(),
        });
        let project = if let Some(id) = project_id {
            let runtime = current.as_ref().ok_or("请先打开项目所属的工作区")?;
            let mut db = crate::lock_mutex(&runtime.db);
            Some(ProjectContext::resolve(
                &mut db,
                &runtime.paths.root_path,
                id,
            )?)
        } else {
            None
        };
        let cwd = match (project.as_ref(), workspace.as_ref()) {
            (Some(project), _) => project.directory.clone(),
            (None, Some(workspace)) => workspace
                .root
                .canonicalize()
                .map_err(|_| "工作区目录不可用，请重新打开工作区")?,
            _ => data_root.join("workspace"),
        };
        let user_data = match workspace.as_ref() {
            Some(workspace) => {
                runtime_data_directory(&data_root, &workspace.binding.workspace_id, project_id)?
            }
            _ => data_root,
        };
        Ok(Self {
            workspace,
            cwd,
            user_data,
        })
    }

    fn verify(&self, current: &Self) -> Result<(), String> {
        if self != current {
            return Err("工作区或项目目录已切换，请重新读取 Skills".into());
        }
        Ok(())
    }
}

async fn read_catalog(mut command: Command) -> Result<SkillCatalog, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let child = command
        .spawn()
        .map_err(|error| format!("无法启动 Skills 目录进程: {error}"))?;
    let output = tokio::time::timeout(Duration::from_secs(15), child.wait_with_output())
        .await
        .map_err(|_| "读取 Skills 目录超时".to_string())?
        .map_err(|error| format!("无法读取 Skills 目录: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "读取 Skills 目录失败 ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Skills 目录返回无效 JSON: {error}"))
}

fn configure_catalog_command(
    command: &mut Command,
    context: &CatalogContext,
    management: Option<(&str, SkillAction)>,
) {
    command
        .arg("--cwd")
        .arg(&context.cwd)
        .env("PROJECT_MIND_DSH_USER_DATA", &context.user_data);
    if let Some((entry, action)) = management {
        command
            .arg("--action")
            .arg(action.as_str())
            .arg("--entry")
            .arg(entry);
    }
}

async fn run_catalog(
    app: &tauri::AppHandle,
    project_id: Option<i64>,
    management: Option<(&str, SkillAction)>,
) -> Result<SkillCatalog, String> {
    let context = CatalogContext::resolve(app, project_id)?;
    let mut command = assistant_script_command(app, "skills.mjs")?;
    configure_catalog_command(&mut command, &context, management);
    context.verify(&CatalogContext::resolve(app, project_id)?)?;
    let result = read_catalog(command).await;
    // Resolve against the current native DB again, including canonical directory ownership.
    context.verify(&CatalogContext::resolve(app, project_id)?)?;
    result
}

// One serial process owns the bounded Node catalogue cache. A cancelled active
// read drops its child, so a stale response can never become the next response.
struct CatalogWorker {
    child: Child,
    epoch: u64,
    last_used: tokio::time::Instant,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl CatalogWorker {
    fn spawn(mut command: Command) -> Result<Self, String> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 Skills 目录进程: {error}"))?;
        let input = child.stdin.take().ok_or("Skills 输入不可用")?;
        let output = BufReader::new(child.stdout.take().ok_or("Skills 输出不可用")?);
        Ok(Self {
            child,
            epoch: catalog_epoch().load(std::sync::atomic::Ordering::SeqCst),
            last_used: tokio::time::Instant::now(),
            input,
            output,
        })
    }
    async fn stop(&mut self) -> Result<(), String> {
        if self.child.try_wait().map_err(|e| e.to_string())?.is_none() {
            self.child
                .start_kill()
                .map_err(|e| format!("无法终止 Skills 目录进程: {e}"))?;
        }
        self.child
            .wait()
            .await
            .map_err(|e| format!("无法回收 Skills 目录进程: {e}"))?;
        Ok(())
    }
    async fn read(
        &mut self,
        context: &CatalogContext,
        refresh: bool,
    ) -> Result<SkillCatalog, String> {
        let mut frame = serde_json::to_vec(&serde_json::json!({
            "cwd":context.cwd, "userData":context.user_data, "refresh":refresh
        }))
        .map_err(|error| error.to_string())?;
        frame.push(b'\n');
        self.input
            .write_all(&frame)
            .await
            .map_err(|error| format!("无法发送 Skills 读取: {error}"))?;
        const LIMIT: usize = 8 * 1024 * 1024;
        let mut line = Vec::new();
        // Bound allocation before reading, including an unterminated frame.
        if (&mut self.output)
            .take((LIMIT + 1) as u64)
            .read_until(b'\n', &mut line)
            .await
            .map_err(|error| error.to_string())?
            == 0
        {
            return Err("Skills 目录进程已退出".into());
        }
        if line.len() > LIMIT {
            return Err("Skills 目录超过响应预算".into());
        }
        self.last_used = tokio::time::Instant::now();
        #[derive(Deserialize)]
        struct Reply {
            ok: bool,
            value: Option<SkillCatalog>,
            error: Option<String>,
        }
        let reply: Reply = serde_json::from_slice(&line)
            .map_err(|error| format!("Skills 目录返回无效 JSON: {error}"))?;
        if reply.ok {
            reply.value.ok_or_else(|| "Skills 目录缺少结果".into())
        } else {
            Err(reply.error.unwrap_or_else(|| "Skills 目录读取失败".into()))
        }
    }
}
fn catalog_worker() -> &'static tokio::sync::Mutex<Option<CatalogWorker>> {
    static WORKER: OnceLock<tokio::sync::Mutex<Option<CatalogWorker>>> = OnceLock::new();
    WORKER.get_or_init(|| tokio::sync::Mutex::new(None))
}
fn catalog_requests() -> &'static Mutex<HashMap<String, Arc<Notify>>> {
    static REQUESTS: OnceLock<Mutex<HashMap<String, Arc<Notify>>>> = OnceLock::new();
    REQUESTS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn catalog_epoch() -> &'static std::sync::atomic::AtomicU64 {
    static EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    &EPOCH
}
fn catalog_stopping() -> &'static std::sync::atomic::AtomicBool {
    static STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    &STOP
}
fn cancel_requests() {
    for request in crate::lock_mutex(catalog_requests()).values() {
        request.notify_one();
    }
}
async fn stop_worker(worker: &mut Option<CatalogWorker>) -> Result<(), String> {
    if let Some(mut child) = worker.take() {
        child.stop().await?;
    }
    Ok(())
}
async fn read_worker(
    worker: &mut Option<CatalogWorker>,
    context: &CatalogContext,
    refresh: bool,
    cancel: &Notify,
) -> Result<SkillCatalog, String> {
    let result = tokio::select! {
        biased;
        _ = cancel.notified() => Err("Skills 发现已取消".into()),
        result = tokio::time::timeout(Duration::from_secs(15), worker.as_mut().expect("spawned").read(context, refresh)) =>
            result.unwrap_or_else(|_| Err("读取 Skills 目录超时".into())),
    };
    if result.is_err() {
        stop_worker(worker).await?;
    }
    result
}
#[derive(Debug)]
pub(crate) struct ShutdownLease {
    committed: bool,
}
impl ShutdownLease {
    fn begin() -> Result<Self, String> {
        catalog_stopping()
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .map_err(|_| "Skills 正在关闭".to_string())?;
        Ok(Self { committed: false })
    }
    pub(crate) fn commit(mut self) {
        self.committed = true;
    }
}
impl Drop for ShutdownLease {
    fn drop(&mut self) {
        if !self.committed {
            catalog_stopping().store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
}
fn finish_shutdown(
    lease: ShutdownLease,
    result: Result<(), String>,
) -> Result<ShutdownLease, String> {
    result.map(|()| lease)
}
pub(crate) async fn shutdown() -> Result<ShutdownLease, String> {
    let lease = ShutdownLease::begin()?;
    catalog_epoch().fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    cancel_requests();
    let mut worker = catalog_worker().lock().await;
    finish_shutdown(lease, stop_worker(&mut worker).await)
}
pub(crate) fn exit_fallback() {
    // The final RunEvent also follows an already committed normal shutdown.
    // Close admission unconditionally and reap, without acquiring a second lease.
    catalog_stopping().store(true, std::sync::atomic::Ordering::SeqCst);
    cancel_requests();
    let result = tauri::async_runtime::block_on(async {
        let mut worker = catalog_worker().lock().await;
        stop_worker(&mut worker).await
    });
    if let Err(error) = result {
        eprintln!("Skills shutdown: {error}");
    }
}
// Synchronous Workspace switches revoke queued readers before releasing the
// native authority lock. Cleanup does not kill a worker created in a newer epoch.
pub(crate) fn invalidate() {
    let epoch = catalog_epoch().fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    cancel_requests();
    tauri::async_runtime::spawn(async move {
        let mut worker = catalog_worker().lock().await;
        if worker.as_ref().is_some_and(|worker| worker.epoch < epoch) {
            if let Err(error) = stop_worker(&mut worker).await {
                eprintln!("Skills invalidate: {error}");
            }
        }
    });
}
fn idle_notify() -> &'static Notify {
    static WAKE: OnceLock<Notify> = OnceLock::new();
    WAKE.get_or_init(Notify::new)
}
async fn reap_idle(
    worker: &tokio::sync::Mutex<Option<CatalogWorker>>,
    wake: &Notify,
    idle: Duration,
) {
    loop {
        let deadline = worker.lock().await.as_ref().map(|w| w.last_used + idle);
        if let Some(deadline) = deadline {
            tokio::select! { _ = wake.notified() => {}, _ = tokio::time::sleep_until(deadline) => {} }
        } else {
            wake.notified().await;
        }
        let mut worker = worker.lock().await;
        if worker
            .as_ref()
            .is_some_and(|w| w.last_used.elapsed() >= idle)
        {
            if let Err(error) = stop_worker(&mut worker).await {
                eprintln!("Skills idle shutdown: {error}");
            }
        }
    }
}
fn start_idle_reaper() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        tauri::async_runtime::spawn(reap_idle(
            catalog_worker(),
            idle_notify(),
            Duration::from_secs(60),
        ));
    });
    idle_notify().notify_one();
}
async fn shared_catalog(
    app: &tauri::AppHandle,
    project_id: Option<i64>,
    refresh: bool,
    cancel: &Notify,
) -> Result<SkillCatalog, String> {
    let context = CatalogContext::resolve(app, project_id)?;
    let epoch = catalog_epoch().load(std::sync::atomic::Ordering::SeqCst);
    let mut worker = tokio::select! {
        biased;
        _=cancel.notified()=>return Err("Skills 发现已取消".into()),
        worker=catalog_worker().lock()=>worker,
    };
    if catalog_stopping().load(std::sync::atomic::Ordering::SeqCst)
        || catalog_epoch().load(std::sync::atomic::Ordering::SeqCst) != epoch
    {
        return Err("Skills 范围已失效".into());
    }
    context.verify(&CatalogContext::resolve(app, project_id)?)?;
    if worker.as_ref().is_some_and(|worker| worker.epoch != epoch) {
        stop_worker(&mut worker).await?;
    }
    if worker.is_none() {
        let mut command = assistant_script_command(app, "skills.mjs")?;
        command.arg("--serve");
        *worker = Some(CatalogWorker::spawn(command)?);
        start_idle_reaper();
    }
    let result = read_worker(&mut worker, &context, refresh, cancel).await;
    context.verify(&CatalogContext::resolve(app, project_id)?)?;
    if catalog_epoch().load(std::sync::atomic::Ordering::SeqCst) != epoch {
        return Err("Skills 范围已失效".into());
    }
    result
}

#[tauri::command]
pub(crate) async fn skills_list(
    app: tauri::AppHandle,
    project_id: Option<i64>,
    request_id: Option<String>,
    refresh: Option<bool>,
    cancel: Option<bool>,
) -> Result<Option<SkillCatalog>, String> {
    let id = request_id.unwrap_or_else(|| format!("skills-{:032x}", rand::random::<u128>()));
    if id.is_empty() || id.len() > 128 {
        return Err("无效的 Skills 请求身份".into());
    }
    if cancel.unwrap_or(false) {
        if let Some(request) = crate::lock_mutex(catalog_requests()).get(&id) {
            request.notify_one();
        }
        return Ok(None);
    }
    let cancellation = Arc::new(Notify::new());
    admit_catalog_request(&id, cancellation.clone())?;
    let result = shared_catalog(&app, project_id, refresh.unwrap_or(false), &cancellation).await;
    crate::lock_mutex(catalog_requests()).remove(&id);
    result.map(Some)
}
fn admit_catalog_request(id: &str, cancellation: Arc<Notify>) -> Result<(), String> {
    let mut requests = crate::lock_mutex(catalog_requests());
    if catalog_stopping().load(std::sync::atomic::Ordering::SeqCst) {
        return Err("应用正在退出".into());
    }
    if requests.contains_key(id) || requests.len() >= 32 {
        return Err("Skills 发现请求繁忙".into());
    }
    requests.insert(id.to_owned(), cancellation);
    Ok(())
}

#[tauri::command]
pub(crate) async fn skills_manage(
    app: tauri::AppHandle,
    project_id: Option<i64>,
    entry_path: String,
    action: SkillAction,
) -> Result<SkillCatalog, String> {
    let result = run_catalog(&app, project_id, Some((&entry_path, action))).await;
    if result.is_ok() {
        invalidate();
    }
    result
}

#[tauri::command]
pub(crate) async fn skills_import(
    app: tauri::AppHandle,
    project_id: Option<i64>,
    archive_path: String,
) -> Result<SkillCatalog, String> {
    let context = CatalogContext::resolve(&app, project_id)?;
    let mut command = assistant_script_command(&app, "skills.mjs")?;
    configure_catalog_command(&mut command, &context, None);
    command.arg("--import").arg(archive_path);
    context.verify(&CatalogContext::resolve(&app, project_id)?)?;
    let result = read_catalog(command).await;
    context.verify(&CatalogContext::resolve(&app, project_id)?)?;
    if result.is_ok() {
        invalidate();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn lifecycle_test_lock() -> &'static tokio::sync::Mutex<()> {
        static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
    }

    #[tokio::test]
    async fn failed_shutdown_and_later_exit_failure_restore_real_catalog_admission() {
        let _guard = lifecycle_test_lock().lock().await;
        let lease = ShutdownLease::begin().unwrap();
        assert!(admit_catalog_request("blocked", Arc::new(Notify::new())).is_err());
        let error = finish_shutdown(lease, Err("kill/wait failed".into())).unwrap_err();
        assert_eq!(error, "kill/wait failed");
        admit_catalog_request("after-failed-shutdown", Arc::new(Notify::new())).unwrap();
        crate::lock_mutex(catalog_requests()).remove("after-failed-shutdown");
        let lease = shutdown().await.unwrap();
        assert!(admit_catalog_request("blocked", Arc::new(Notify::new())).is_err());
        drop(lease); // e.g. authorize_voice_shutdown failed after both services stopped.
        admit_catalog_request("after-later-failure", Arc::new(Notify::new())).unwrap();
        crate::lock_mutex(catalog_requests()).remove("after-later-failure");
        let dsh = crate::dsh_assistant::DshAssistantState::default();
        let error = crate::finish_app_shutdown(&dsh, || Err("late voice failure".into()))
            .await
            .unwrap_err();
        assert_eq!(error, "late voice failure");
        admit_catalog_request("after-app-exit-failure", Arc::new(Notify::new())).unwrap();
        crate::lock_mutex(catalog_requests()).remove("after-app-exit-failure");
        drop(dsh.shutdown().await.unwrap());
        let lease = shutdown().await.unwrap();
        lease.commit();
        assert!(admit_catalog_request("blocked", Arc::new(Notify::new())).is_err());
        catalog_stopping().store(false, std::sync::atomic::Ordering::SeqCst);
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn shared_worker_keeps_one_process_and_detects_external_edits() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("workspace");
        let skill = cwd.join(".dsh/skills/example");
        std::fs::create_dir_all(&skill).unwrap();
        let user_data = root.path().join("data");
        std::fs::create_dir_all(&user_data).unwrap();
        let instructions = skill.join("SKILL.md");
        std::fs::write(
            &instructions,
            "---\nname: example\ndescription: first\n---\nInstructions",
        )
        .unwrap();
        let node =
            crate::dsh_assistant::development_node(if cfg!(windows) { "node.exe" } else { "node" })
                .unwrap();
        let mut command = Command::new(node);
        command
            .arg(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../packages/dsh-assistant/scripts/skills.mjs"),
            )
            .arg("--serve")
            .env("PROJECT_MIND_DSH_USER_DATA", &user_data)
            .env("DSH_AGENTS_HOME", root.path().join("agents"))
            .env("DSH_BUNDLED_SKILL_DIR", root.path().join("bundled"));
        let mut worker = CatalogWorker::spawn(command).unwrap();
        let pid = worker.child.id();
        let context = CatalogContext {
            workspace: None,
            cwd,
            user_data,
        };
        let first = worker.read(&context, false).await.unwrap();
        assert!(first
            .skills
            .iter()
            .any(|s| s.name == "example" && s.description == "first"));
        assert!(worker.read(&context, false).await.unwrap().complete);
        assert_eq!(worker.child.id(), pid);
        std::fs::write(
            &instructions,
            "---\nname: example\ndescription: external change\n---\nInstructions",
        )
        .unwrap();
        let changed = worker.read(&context, false).await.unwrap();
        assert!(changed
            .skills
            .iter()
            .any(|s| s.description == "external change"));
        std::fs::remove_file(&instructions).unwrap();
        assert!(!worker
            .read(&context, true)
            .await
            .unwrap()
            .skills
            .iter()
            .any(|s| s.name == "example"));
        worker.child.kill().await.unwrap();
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn oversized_unterminated_worker_output_is_bounded_before_parsing() {
        let node =
            crate::dsh_assistant::development_node(if cfg!(windows) { "node.exe" } else { "node" })
                .unwrap();
        let mut command = Command::new(node);
        command.args([
            "--eval",
            "process.stdin.once('data',()=>process.stdout.write('x'.repeat(9*1024*1024)))",
        ]);
        let mut worker = CatalogWorker::spawn(command).unwrap();
        let context = CatalogContext {
            workspace: None,
            cwd: "/tmp".into(),
            user_data: "/tmp".into(),
        };
        assert!(worker
            .read(&context, false)
            .await
            .unwrap_err()
            .contains("预算"));
        worker.stop().await.unwrap();
        assert!(worker.child.try_wait().unwrap().is_some());
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn serve_worker_is_reaped_by_real_idle_timer_and_explicit_shutdown() {
        let _guard = lifecycle_test_lock().lock().await;
        let root = tempfile::tempdir().unwrap();
        let node =
            crate::dsh_assistant::development_node(if cfg!(windows) { "node.exe" } else { "node" })
                .unwrap();
        let spawn = || {
            let mut command = Command::new(&node);
            command
                .arg(
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("../packages/dsh-assistant/scripts/skills.mjs"),
                )
                .arg("--serve")
                .env("PROJECT_MIND_DSH_USER_DATA", root.path());
            CatalogWorker::spawn(command).unwrap()
        };
        let context = CatalogContext {
            workspace: None,
            cwd: root.path().into(),
            user_data: root.path().into(),
        };
        let mut child = spawn();
        child.read(&context, false).await.unwrap();
        let pid = child.child.id().unwrap();
        let pool = Arc::new(tokio::sync::Mutex::new(Some(child)));
        let signal = Arc::new(Notify::new());
        let task = {
            let pool = pool.clone();
            let signal = signal.clone();
            tokio::spawn(async move { reap_idle(&pool, &signal, Duration::from_millis(30)).await })
        };
        tokio::time::timeout(Duration::from_secs(2), async {
            while pool.lock().await.is_some() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        task.abort();
        #[cfg(unix)]
        assert!(!std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success());
        let mut child = spawn();
        child.read(&context, false).await.unwrap();
        let pid = child.child.id().unwrap();
        *catalog_worker().lock().await = Some(child);
        invalidate();
        tokio::time::timeout(Duration::from_secs(2), async {
            while catalog_worker().lock().await.is_some() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        #[cfg(unix)]
        assert!(!std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success());
        let mut child = spawn();
        child.read(&context, false).await.unwrap();
        let pid = child.child.id().unwrap();
        *catalog_worker().lock().await = Some(child);
        let cancel = Arc::new(Notify::new());
        crate::lock_mutex(catalog_requests()).insert("shutdown-fixture".into(), cancel.clone());
        let shutdown_lease = shutdown().await.unwrap();
        tokio::time::timeout(Duration::from_millis(100), cancel.notified())
            .await
            .unwrap();
        crate::lock_mutex(catalog_requests()).remove("shutdown-fixture");
        assert!(catalog_worker().lock().await.is_none());
        #[cfg(unix)]
        assert!(!std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success());
        drop(shutdown_lease);
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn cancelling_an_active_discovery_kills_and_waits_before_releasing_the_worker() {
        let node =
            crate::dsh_assistant::development_node(if cfg!(windows) { "node.exe" } else { "node" })
                .unwrap();
        let mut command = Command::new(node);
        command.args(["--eval", "process.stdin.once('data',()=>setTimeout(()=>console.log(JSON.stringify({ok:true,value:{skills:[],directories:[],complete:true}})),1000))"]);
        let child = CatalogWorker::spawn(command).unwrap();
        let pid = child.child.id().unwrap();
        let mut worker = Some(child);
        let context = CatalogContext {
            workspace: None,
            cwd: "/tmp".into(),
            user_data: "/tmp".into(),
        };
        let cancel = Notify::new();
        let (_, result) = tokio::join!(
            async {
                tokio::time::sleep(Duration::from_millis(30)).await;
                cancel.notify_one();
            },
            read_worker(&mut worker, &context, false, &cancel),
        );
        assert!(result.unwrap_err().contains("取消"));
        assert!(worker.is_none());
        #[cfg(unix)]
        assert!(!std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success());
    }

    #[test]
    fn catalog_requires_exact_wire_shape_and_nullable_path() {
        let valid = r#"{"skills":[{"name":"example","description":"method","path":null,"source":"builtin","disabled":false,"entryPath":null,"directory":null,"canDelete":false}],"directories":["/skills"],"complete":true}"#;
        let catalog: SkillCatalog = serde_json::from_str(valid).unwrap();
        assert!(catalog.skills[0].path.is_none());
        let serialized = serde_json::to_value(&catalog).unwrap();
        assert_eq!(
            serialized,
            serde_json::from_str::<serde_json::Value>(valid).unwrap()
        );
        for invalid in [
            valid.replace("\"path\":null,", ""),
            valid.replace("\"disabled\":false,", ""),
            valid.replace("\"entryPath\":null,", ""),
            valid.replace("\"directory\":null,", ""),
            valid.replace(",\"canDelete\":false", ""),
            valid.replace("\"disabled\":false", "\"disabled\":null"),
            valid.replace("\"canDelete\":false", "\"canDelete\":1"),
            valid.replace("\"complete\":true", "\"complete\":1"),
            valid.replace(
                "\"source\":\"builtin\"",
                "\"source\":\"builtin\",\"unexpected\":true",
            ),
            format!("log line\n{valid}"),
            format!("{valid}\n{valid}"),
        ] {
            assert!(
                serde_json::from_str::<SkillCatalog>(&invalid).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn management_actions_and_command_arguments_follow_wire_contract() {
        let context = CatalogContext {
            workspace: None,
            cwd: "/workspace/project".into(),
            user_data: "/data/projects/one/1".into(),
        };
        for action in ["enable", "disable", "delete"] {
            let parsed: SkillAction = serde_json::from_value(serde_json::json!(action)).unwrap();
            let mut command = Command::new("node");
            configure_catalog_command(
                &mut command,
                &context,
                Some(("/skills/a b/SKILL.md", parsed)),
            );
            let args: Vec<_> = command
                .as_std()
                .get_args()
                .map(|arg| arg.to_str().unwrap())
                .collect();
            assert_eq!(
                args,
                [
                    "--cwd",
                    "/workspace/project",
                    "--action",
                    action,
                    "--entry",
                    "/skills/a b/SKILL.md"
                ]
            );
            assert!(command
                .as_std()
                .get_envs()
                .any(|(key, value)| key == "PROJECT_MIND_DSH_USER_DATA"
                    && value == Some(context.user_data.as_os_str())));
        }
        for invalid in [
            serde_json::json!("remove"),
            serde_json::json!("Enable"),
            serde_json::json!(null),
            serde_json::json!(1),
        ] {
            assert!(serde_json::from_value::<SkillAction>(invalid).is_err());
        }
        let mut command = Command::new("node");
        configure_catalog_command(&mut command, &context, None);
        assert_eq!(
            command.as_std().get_args().collect::<Vec<_>>(),
            ["--cwd", "/workspace/project"]
        );
    }

    #[test]
    fn stale_workspace_generation_root_and_project_path_are_rejected() {
        let original = CatalogContext {
            workspace: Some(WorkspaceSnapshot {
                binding: WorkspaceBinding {
                    workspace_id: "one".into(),
                    generation: "opened".into(),
                },
                root: "/workspace".into(),
            }),
            cwd: "/workspace/project".into(),
            user_data: "/data/projects/one/1".into(),
        };
        assert!(original.verify(&original).is_ok());
        for mutation in 0..6 {
            let mut changed = CatalogContext {
                workspace: original.workspace.clone(),
                cwd: original.cwd.clone(),
                user_data: original.user_data.clone(),
            };
            match mutation {
                0 => changed.workspace = None,
                1 => changed.workspace.as_mut().unwrap().binding.generation = "reopened".into(),
                2 => changed.workspace.as_mut().unwrap().binding.workspace_id = "two".into(),
                3 => changed.workspace.as_mut().unwrap().root = "/other".into(),
                4 => changed.cwd = "/workspace/moved-project".into(),
                _ => changed.user_data = "/different-data".into(),
            }
            assert!(original.verify(&changed).is_err());
            assert!(changed.verify(&original).is_err());
        }
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn one_shot_preserves_stderr_and_rejects_stdout_noise() {
        // The shared resolver selects the same development Node as the assistant.
        let node =
            crate::dsh_assistant::development_node(if cfg!(windows) { "node.exe" } else { "node" })
                .unwrap();
        let mut success = Command::new(&node);
        success.args([
            "--eval",
            "console.log(JSON.stringify({skills:[],directories:[],complete:true}))",
        ]);
        assert!(read_catalog(success).await.unwrap().complete);
        let mut command = Command::new(&node);
        command.args([
            "--eval",
            "process.stderr.write('catalog fixture failed'); process.exit(7)",
        ]);
        assert!(read_catalog(command)
            .await
            .unwrap_err()
            .contains("catalog fixture failed"));
        let mut command = Command::new(node);
        command.args(["--eval", "console.log('unexpected startup log'); console.log(JSON.stringify({skills:[],directories:[],complete:true}))"]);
        assert!(read_catalog(command).await.unwrap_err().contains("JSON"));
    }
}
