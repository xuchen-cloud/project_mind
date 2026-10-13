pub mod agent;
mod ai_jobs;
mod dsh_assistant;
mod project_directory;
mod ai_provider;
mod ai_network;
mod db;
mod models;
mod record_documents;
mod record_document_worker;
mod source_extraction_worker;
mod source_search_index;
mod source_service;
mod source_session_summary;
mod source_session_read;
mod source_maintenance;
mod source_file_snapshot;
mod source_file_read;
mod source_text_page;
mod source_native;
mod overview_evidence;
mod overview_service;
mod overview_generation;
mod overview_model;
mod overview_maintenance;
mod overview_session;
mod overview_commands;
mod knowledge_service;
mod memory_commands;
mod knowledge_registry;
mod utility_process;
mod record_document_service;
mod record_version_reads;
mod record_document_commands;
mod file_document_commands;
mod file_version_service;
mod file_version_restore;
mod file_text_patch;
mod file_content;
mod file_source_read;
mod file_read_commands;
mod workspace_commit_fence;
mod record_editor_coordination;
mod record_export;
mod secret_crypto;
mod system_fonts;
pub mod voice;
mod workspace;
mod workspace_initialization;
mod committed_changes;

use std::{
    collections::hash_map::DefaultHasher,
    env, fs,
    hash::{Hash, Hasher},
    io::BufWriter,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::UNIX_EPOCH,
};

use ai_jobs::AiJobManager;
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use db::Database;
pub use db::DemoSeedResult;
use image::{codecs::jpeg::JpegEncoder, ExtendedColorType, ImageReader};
use models::{
    AiCapabilityBindingRecord, AiCapabilityBindingUpsertInput, AiEditorSkillDeleteInput,
    AiEditorSkillRecord, AiEditorSkillReorderInput, AiEditorSkillUpsertInput, AiExecutionSettings,
    AiJobEnqueueInput, AiJobSnapshot, AiProfileTestInput, AiProfileTestResult,
    AiProviderProfileDeleteInput, AiProviderProfileRecord, AiProviderProfileUpsertInput,
    AiSettingsSnapshot, ContactDeleteInput, ContactRecord, ContactSearchInput, ContactUpsertInput,
    DocumentDeleteInput, DocumentImportClipboardImageInput,
    DocumentImportClipboardNoteImageInput, DocumentImportInput, DocumentImportNoteImageInput,
    DocumentListVersionsInput, DocumentRecord, DocumentRelocateInput, DocumentUpdateMetaInput,
    DocumentVersionRecord, FileTagOptionDeleteInput, FileTagOptionUpsertInput, FileTagRecord,
    FileTagSettingsGetInput, FileTagSettingsSnapshot, InternalReferenceResolveInput,
    InternalReferenceResolveResult, InternalReferenceSearchInput, InternalReferenceSearchResult,
    NoteRecord, ProjectArchiveInput, ProjectCreateInput, ProjectDeleteInput, ProjectIdInput,
    ProjectListItem, ProjectPageData, ProjectRecord, ProjectRecordDeleteInput,
    ProjectRecordMetadataApplyInput, ProjectRecordUpsertInput, ProjectQuickNoteCommitInput, ProjectUpdateInput,
    ProjectsListInput, RichTextStyleSettings, RichTextStyleUpsertInput, TodoAddProgressInput,
    TodoCreateInput, TodoDeleteInput, TodoDeleteProgressInput, TodoProgressRecord, TodoRecord,
    TodoUpdateContentInput, TodoUpdatePriorityInput, TodoUpdateProgressInput,
    TodoUpdateStatusInput, TodoUpdateTagsInput, WorkspaceClipboardNoteImageImportInput,
    WorkspaceCreateInput, WorkspaceNoteImageAsset, WorkspaceNoteImageImportInput,
    WorkspaceOpenInput, WorkspacePageData, WorkspaceQuickNoteCommitInput, WorkspaceQuickNoteUpsertInput, WorkspaceRecord,
    WorkspaceRecordDeleteInput, WorkspaceRecordMetadataApplyInput, WorkspaceRecordUpsertInput,
    WorkspaceSearchInput, WorkspaceSearchResult, WorkspaceStatusSnapshot, WorkspaceSummary,
    WorkspaceUnlockInput,
};
use record_export::{
    desktop_cancel_export_image, desktop_cancel_export_write, desktop_export_available_bytes,
    desktop_export_path_exists, desktop_next_available_export_path, desktop_resolve_export_image,
    desktop_write_export_file,
};
use tauri::{Emitter, Manager, State, WebviewWindowBuilder};
use tauri_plugin_opener::{open_path, reveal_item_in_dir};
use workspace::{
    cleanup_legacy_app_data, create_workspace, load_local_session, load_metadata,
    save_local_session, verify_workspace_password, workspace_summary, WorkspaceMetadata,
    WorkspacePaths, WORKSPACE_SECURITY_MODE,
};

const APP_IDENTIFIER: &str = "com.xuchen.projectmind.alpha";
const DEFAULT_DEMO_WORKSPACE_DIR_NAME: &str = "ProjectMind Demo Workspace";
const LOCAL_WORKSPACE_SESSION_FILE_NAME: &str = "workspace-session.json";

#[tauri::command]
async fn voice_caption_apply_material(app: tauri::AppHandle) -> std::result::Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{
            apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
        };

        let window = app
            .get_webview_window("voice-caption")
            .ok_or_else(|| "voice caption window is unavailable".to_string())?;
        let main_window = window.clone();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                // Liquid Glass adds a focus-dependent rim and optical shadow outside the
                // rounded web content. Use one frosted layer with a fixed effect state;
                // Active keeps the blur enabled even when this non-focusing panel is inactive.
                let result = clear_vibrancy(&main_window)
                    .and_then(|_| {
                        apply_vibrancy(
                            &main_window,
                            NSVisualEffectMaterial::Popover,
                            Some(NSVisualEffectState::Active),
                            Some(24.0),
                        )
                    })
                    .map_err(|error| error.to_string());
                let _ = sender.send(result);
            })
            .map_err(|error| error.to_string())?;
        receiver.await.map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

pub struct SeedDemoWorkspaceResult {
    pub workspace_root: String,
    pub metadata_path: String,
    pub summary: DemoSeedResult,
}

pub(crate) struct WorkspaceRuntime {
    agent_binding: agent::models::WorkspaceBinding,
    agent_runs: Mutex<std::collections::HashMap<String, tokio::sync::watch::Sender<bool>>>,
    agent_cancel_started: Mutex<std::collections::HashMap<String, std::time::Instant>>,
    summary: WorkspaceSummary,
    metadata: WorkspaceMetadata,
    pub(crate) paths: WorkspacePaths,
    secret_state: Arc<Mutex<Option<String>>>,
    pub(crate) db: Mutex<Database>,
    file_commit_fence: Arc<workspace_commit_fence::WorkspaceCommitFence>,
    ai_jobs: AiJobManager,
    voice_minutes_worker_running: Arc<std::sync::atomic::AtomicBool>,
    pub(crate) voice_recovery_running: std::sync::atomic::AtomicBool,
    pub(crate) voice_recovery_interrupt: std::sync::atomic::AtomicBool,
}

impl WorkspaceRuntime {
    fn new(
        app_handle: &tauri::AppHandle,
        metadata: WorkspaceMetadata,
        paths: WorkspacePaths,
        secret_password: Option<String>,
    ) -> Result<Self> {
        let opened = workspace_initialization::open_workspace_database(
            &paths.db_path, &paths.root_path, secret_password.clone(), &metadata.workspace_id,
        )?;
        if let Some(error) = opened.checkpoint_error {
            let _ = app_handle.emit("record:checkpoint-error", error);
        }
        let mut db = opened.db;
        let execution = db.ai_execution_settings_get()?;
        let secret_state = Arc::new(Mutex::new(secret_password));
        let app_handle = app_handle.clone();
        let ai_jobs = AiJobManager::new(
            paths.db_path.clone(),
            paths.root_path.clone(),
            secret_state.clone(),
            execution.max_concurrency,
            Arc::new(move |snapshot| {
                let _ = app_handle.emit(ai_jobs::AI_JOB_EVENT, snapshot);
            }),
        );

        let agent_binding = agent::models::WorkspaceBinding {
                workspace_id: metadata.workspace_id.clone(),
                generation: format!("{:032x}", rand::random::<u128>()),
            };
        db.agent_gui_interrupt_orphans(&agent_binding)
            .map_err(|error| anyhow!(error.message))?;
        Ok(Self {
            agent_binding,
            agent_runs: Mutex::new(std::collections::HashMap::new()),
            agent_cancel_started: Mutex::new(std::collections::HashMap::new()),
            summary: workspace_summary(&paths.root_path, &metadata),
            metadata,
            paths,
            secret_state,
            db: Mutex::new(db),
            file_commit_fence: Arc::new(workspace_commit_fence::WorkspaceCommitFence::new()),
            ai_jobs,
            voice_minutes_worker_running: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            voice_recovery_running: std::sync::atomic::AtomicBool::new(false),
            voice_recovery_interrupt: std::sync::atomic::AtomicBool::new(true),
        })
    }

    fn ai_secrets_unlocked(&self) -> bool {
        lock_mutex(&self.secret_state).is_some()
    }

    fn cancel_agent_runs(&self) {
        for cancel in lock_mutex(&self.agent_runs).values() {
            cancel.send_replace(true);
        }
    }

    pub(crate) fn kick_voice_minutes(&self) {
        voice::processing::kick(
            self.paths.db_path.clone(),
            self.paths.root_path.clone(),
            self.secret_state.clone(),
            self.voice_minutes_worker_running.clone(),
        );
    }

    fn set_secret_password(&self, secret_password: Option<String>) -> Result<Option<agent::errors::AgentError>> {
        let mut db_guard = lock_mutex(&self.db);
        let opened = workspace_initialization::open_workspace_database(
            &self.paths.db_path, &self.paths.root_path, secret_password.clone(), &self.agent_binding.workspace_id,
        )?;
        let mut next_db = opened.db;
        let execution = next_db.ai_execution_settings_get()?;
        *db_guard = next_db;
        *lock_mutex(&self.secret_state) = secret_password;
        self.ai_jobs.set_max_concurrency(execution.max_concurrency);
        Ok(opened.checkpoint_error)
    }
}

pub(crate) struct AppState {
    app_handle: tauri::AppHandle,
    local_session_path: PathBuf,
    current_workspace: Mutex<Option<Arc<WorkspaceRuntime>>>,
    voice_runtime: Mutex<voice::runtime::VoiceRuntime>,
    exit_authorized: std::sync::atomic::AtomicBool,
    record_editors: Arc<record_editor_coordination::RecordEditorCoordinator>,
    external_bridge: agent::bridge::BridgeRuntime,
}

impl AppState {
    fn ensure_voice_idle(&self) -> Result<()> {
        let Some(workspace) = lock_mutex(&self.current_workspace).clone() else {
            return Ok(());
        };
        let mut voice = lock_mutex(&self.voice_runtime);
        let mut db = lock_mutex(&workspace.db);
        if voice.has_unfinished_session(&mut db, &workspace.paths.root_path)? {
            return Err(anyhow!("请先结束当前语音记录，再切换或关闭 Workspace"));
        }
        voice.reset();
        Ok(())
    }

    fn status_snapshot(&self) -> Result<WorkspaceStatusSnapshot> {
        let current = lock_mutex(&self.current_workspace).clone();
        let recent_state = load_local_session(&self.local_session_path)?;
        let recent_workspaces = recent_state
            .recent_workspace_roots
            .iter()
            .filter_map(|root| {
                let root_path = PathBuf::from(root);
                load_metadata(&root_path)
                    .ok()
                    .map(|(metadata, _)| workspace_summary(&root_path, &metadata))
            })
            .collect::<Vec<_>>();

        Ok(WorkspaceStatusSnapshot {
            current_workspace: current.as_ref().map(|runtime| runtime.summary.clone()),
            recent_workspaces,
            ai_secrets_unlocked: current
                .as_ref()
                .map(|runtime| runtime.ai_secrets_unlocked())
                .unwrap_or(false),
            security_mode: current
                .as_ref()
                .map(|runtime| runtime.metadata.security_mode.clone())
                .unwrap_or_else(|| WORKSPACE_SECURITY_MODE.to_string()),
        })
    }

    fn set_current_workspace(&self, runtime: Option<Arc<WorkspaceRuntime>>) {
        let mut current = lock_mutex(&self.current_workspace);
        if let Some(previous) = current.as_ref() {
            previous.cancel_agent_runs();
            previous.file_commit_fence.invalidate();
            previous.voice_recovery_interrupt.store(true, std::sync::atomic::Ordering::Release);
        }
        *current = runtime;
    }

    fn current_workspace(&self) -> Result<Arc<WorkspaceRuntime>> {
        lock_mutex(&self.current_workspace)
            .clone()
            .ok_or_else(|| anyhow!("no workspace is currently open"))
    }

    fn open_workspace_root(&self, root_path: &Path) -> Result<WorkspaceStatusSnapshot> {
        self.ensure_voice_idle()?;
        self.seal_current_record_checkpoints()?;
        let (metadata, paths) = load_metadata(root_path)?;
        let runtime = Arc::new(WorkspaceRuntime::new(
            &self.app_handle,
            metadata,
            paths,
            None,
        )?);
        #[cfg(debug_assertions)]
        {
            if let Some(password) = debug_workspace_password(
                &runtime.metadata,
                std::env::var("PROJECT_MIND_DEV_WORKSPACE_PASSWORD").ok().as_deref(),
                debug_cached_workspace_password,
            )? {
                if let Some(error) = runtime.set_secret_password(Some(password))? {
                    let _ = self.app_handle.emit("record:checkpoint-error", error);
                }
            }
        }
        self.set_current_workspace(Some(runtime));

        let mut session = load_local_session(&self.local_session_path)?;
        session.record_recent_workspace(root_path);
        save_local_session(&self.local_session_path, &session)?;

        self.status_snapshot()
    }

    fn create_workspace_root(
        &self,
        root_path: &Path,
        password: &str,
    ) -> Result<WorkspaceStatusSnapshot> {
        #[cfg(debug_assertions)]
        debug_create_workspace(root_path, debug_cache_workspace_password)?;
        #[cfg(not(debug_assertions))]
        create_workspace(root_path, password)?;
        #[cfg(debug_assertions)]
        let _ = password;
        self.open_workspace_root(root_path)
    }

    fn close_current_workspace(&self) -> Result<WorkspaceStatusSnapshot> {
        self.ensure_voice_idle()?;
        self.seal_current_record_checkpoints()?;
        close_workspace_runtime(&self.local_session_path, &self.current_workspace, |previous| {
            previous.cancel_agent_runs();
            previous.file_commit_fence.invalidate();
            previous.voice_recovery_interrupt.store(true, std::sync::atomic::Ordering::Release);
        })?;
        self.status_snapshot()
    }

    fn unlock_current_workspace(&self, password: &str) -> Result<WorkspaceStatusSnapshot> {
        let runtime = self.current_workspace()?;
        verify_workspace_password(&runtime.metadata, password)?;
        if let Some(error) = runtime.set_secret_password(Some(password.to_string()))? {
            let _ = self.app_handle.emit("record:checkpoint-error", error);
        }
        self.status_snapshot()
    }

    fn seal_current_record_checkpoints(&self) -> Result<()> {
        let current = lock_mutex(&self.current_workspace);
        if let Some(workspace) = current.as_ref() {
            lock_mutex(&workspace.db)
                .record_seal_checkpoints(record_documents::RecordCheckpointReason::Shutdown, &workspace.agent_binding.workspace_id)
                .map_err(|error| anyhow!(error.message))?;
        }
        Ok(())
    }

    fn lock_current_workspace_secrets(&self) -> Result<WorkspaceStatusSnapshot> {
        let runtime = self.current_workspace()?;
        runtime.cancel_agent_runs();
        if let Some(error) = runtime.set_secret_password(None)? {
            let _ = self.app_handle.emit("record:checkpoint-error", error);
        }
        self.status_snapshot()
    }
}

type CommandResult<T> = std::result::Result<T, String>;

#[cfg(debug_assertions)]
fn debug_workspace_key_path(app_data: &Path, workspace_id: &str) -> Result<PathBuf> {
    if workspace_id.len() != 32 || !workspace_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("invalid workspace identity for development cache");
    }
    Ok(app_data.join("debug-workspace-keys").join(workspace_id))
}

#[cfg(debug_assertions)]
fn debug_read_workspace_key(app_data: &Path, workspace_id: &str) -> Result<Option<String>> {
    match fs::read_to_string(debug_workspace_key_path(app_data, workspace_id)?) {
        Ok(password) => Ok(Some(password)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).context("failed to read development workspace key"),
    }
}

#[cfg(debug_assertions)]
fn debug_write_workspace_key(app_data: &Path, workspace_id: &str, password: &str) -> Result<()> {
    use std::io::Write;
    let path = debug_workspace_key_path(app_data, workspace_id)?;
    let directory = path.parent().unwrap();
    fs::create_dir_all(directory)?;
    // NamedTempFile creates a private file (0600 on Unix) and atomically
    // replaces the key. Production builds have no development key cache.
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(password.as_bytes())?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

#[cfg(debug_assertions)]
fn debug_cached_workspace_password(workspace_id: &str) -> Result<Option<String>> {
    debug_read_workspace_key(&default_app_data_dir()?, workspace_id)
}

#[cfg(debug_assertions)]
fn debug_cache_workspace_password(workspace_id: &str, password: &str) -> Result<()> {
    debug_write_workspace_key(&default_app_data_dir()?, workspace_id, password)
}

#[cfg(debug_assertions)]
fn debug_workspace_password(
    metadata: &WorkspaceMetadata,
    fixture_password: Option<&str>,
    read: impl FnOnce(&str) -> Result<Option<String>>,
) -> Result<Option<String>> {
    if let Some(password) = fixture_password {
        // Explicit acceptance configuration needs no cache access. It can
        // unlock only the workspace whose verifier matches that password.
        match verify_workspace_password(metadata, password) {
            Ok(()) => return Ok(Some(password.to_owned())),
            Err(error) if error.to_string() == "workspace password is incorrect" => {},
            Err(error) => return Err(error),
        }
    }
    if let Some(password) = read(&metadata.workspace_id)? {
        verify_workspace_password(metadata, &password)?;
        return Ok(Some(password));
    }
    Ok(None)
}

#[cfg(debug_assertions)]
fn debug_create_workspace(
    root: &Path,
    save: impl FnOnce(&str, &str) -> Result<()>,
) -> Result<()> {
    let password = format!("{:032x}{:032x}", rand::random::<u128>(), rand::random::<u128>());
    let (metadata, paths) = create_workspace(root, &password)?;
    if let Err(error) = save(&metadata.workspace_id, &password) {
        // No database exists yet; allow creation to be retried without losing a generated key.
        std::fs::remove_file(&paths.metadata_path)
            .context("failed to roll back workspace metadata after development key cache failure")?;
        return Err(error);
    }
    Ok(())
}

fn lock_mutex<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn close_workspace_runtime<T>(
    local_session_path: &Path,
    current_workspace: &Mutex<Option<T>>,
    on_close: impl FnOnce(&T),
) -> Result<()> {
    let mut session = load_local_session(local_session_path)?;
    session.clear_current_workspace();
    save_local_session(local_session_path, &session)?;
    let mut current = lock_mutex(current_workspace);
    if let Some(previous) = current.as_ref() {
        on_close(previous);
    }
    *current = None;
    Ok(())
}

fn with_db<T>(
    state: State<'_, AppState>,
    task: impl FnOnce(&mut Database) -> Result<T>,
) -> CommandResult<T> {
    let runtime = state
        .current_workspace()
        .map_err(|error| error.to_string())?;
    let request_id = format!("gui:{:032x}", rand::random::<u128>());
    let (result, changes) = {
        let current = lock_mutex(&state.current_workspace);
        if !current.as_ref().is_some_and(|current| Arc::ptr_eq(current, &runtime)) {
            return Err("Workspace changed before the command acquired storage".into());
        }
        let mut db = lock_mutex(&runtime.db);
        committed_changes::capture_native_committed(&runtime.agent_binding, &mut db, &request_id, task)
            .map_err(|error| error.to_string())?
    };
    // Both the transaction and storage lock are released before event delivery.
    if let Some(changes) = changes {
        use committed_changes::CommittedChangePublisher;
        state.publish_committed(changes);
    }
    result.map_err(|error| error.to_string())
}

fn with_workspace_runtime<T>(
    state: State<'_, AppState>,
    task: impl FnOnce(&WorkspaceRuntime) -> Result<T>,
) -> CommandResult<T> {
    let runtime = state
        .current_workspace()
        .map_err(|error| error.to_string())?;
    task(&runtime).map_err(|error| error.to_string())
}

fn ensure_path_exists(path: &Path) -> Result<()> {
    if path.exists() {
        Ok(())
    } else {
        bail!("path does not exist: {}", path.display())
    }
}

fn open_path_with_system_app(path: &Path) -> Result<()> {
    ensure_path_exists(path)?;
    open_path(path, None::<&str>).map_err(Into::into)
}

fn reveal_path_in_explorer(path: &Path) -> Result<()> {
    ensure_path_exists(path)?;
    reveal_item_in_dir(path).map_err(Into::into)
}

pub fn default_demo_workspace_root() -> Result<PathBuf> {
    Ok(default_home_dir()?
        .join("Documents")
        .join(DEFAULT_DEMO_WORKSPACE_DIR_NAME))
}

pub fn seed_demo_workspace_at(
    workspace_root: &Path,
    password: &str,
    force: bool,
) -> Result<SeedDemoWorkspaceResult> {
    if force && workspace_root.exists() {
        fs::remove_dir_all(workspace_root).with_context(|| {
            format!(
                "failed to remove existing demo workspace at {}",
                workspace_root.display()
            )
        })?;
    }

    let (_, paths) = create_workspace(workspace_root, password)?;
    let mut db = Database::open(&paths.db_path, workspace_root, Some(password.to_string()))?;
    let summary = db.seed_demo_data(workspace_root)?;

    Ok(SeedDemoWorkspaceResult {
        workspace_root: workspace_root.to_string_lossy().to_string(),
        metadata_path: paths.metadata_path.to_string_lossy().to_string(),
        summary,
    })
}

fn thumbnail_cache_key(path: &str, len: u64, modified_millis: u128, max_edge: u32) -> String {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    len.hash(&mut hasher);
    modified_millis.hash(&mut hasher);
    max_edge.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[cfg(debug_assertions)]
fn debug_app_data_dir_override(path: PathBuf) -> Result<PathBuf> {
    if !path.is_absolute() {
        bail!("PROJECT_MIND_APP_DATA_DIR must be an absolute path");
    }
    Ok(path)
}

fn default_app_data_dir() -> Result<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(path) = env::var_os("PROJECT_MIND_APP_DATA_DIR") {
        return debug_app_data_dir_override(PathBuf::from(path));
    }
    #[cfg(target_os = "macos")]
    {
        return Ok(default_home_dir()?
            .join("Library")
            .join("Application Support")
            .join(APP_IDENTIFIER));
    }

    #[cfg(target_os = "windows")]
    {
        let appdata = env::var_os("APPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| anyhow!("APPDATA is not available"))?;
        return Ok(appdata.join(APP_IDENTIFIER));
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Some(xdg_data_home) = env::var_os("XDG_DATA_HOME").map(PathBuf::from) {
            return Ok(xdg_data_home.join(APP_IDENTIFIER));
        }

        Ok(default_home_dir()?
            .join(".local")
            .join("share")
            .join(APP_IDENTIFIER))
    }
}

fn default_home_dir() -> Result<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("failed to resolve the current user's home directory"))
}

fn ensure_main_window<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    if !app.webview_windows().is_empty() {
        return Ok(());
    }

    let window_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .ok_or_else(|| tauri::Error::AssetNotFound("main window config".into()))?;

    let builder = WebviewWindowBuilder::from_config(app.handle(), window_config)?;
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        // Wry positions the native titlebar container, not the button center.
        // Include the native button frame offset when centering in the 44px row.
        .traffic_light_position(tauri::LogicalPosition::new(14.0, 24.0))
        .initialization_script("document.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('native-titlebar-overlay'));");
    builder.build()?;
    Ok(())
}

#[tauri::command]
fn desktop_open_file(path: String) -> CommandResult<()> {
    open_path_with_system_app(Path::new(&path)).map_err(|error| error.to_string())
}

#[tauri::command]
fn desktop_open_folder(path: String) -> CommandResult<()> {
    let target = Path::new(&path);
    ensure_path_exists(target)
        .and_then(|_| {
            if target.is_dir() {
                open_path_with_system_app(target)
            } else {
                bail!("not a directory: {}", target.display())
            }
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn desktop_reveal_in_explorer(path: String) -> CommandResult<()> {
    reveal_path_in_explorer(Path::new(&path)).map_err(|error| error.to_string())
}

#[tauri::command]
fn desktop_read_file_as_data_url(path: String, mime_type: Option<String>) -> CommandResult<String> {
    let normalized_path = path.trim();
    let target = Path::new(normalized_path);

    ensure_path_exists(target)
        .and_then(|_| {
            fs::read(target).with_context(|| format!("failed to read {}", target.display()))
        })
        .map(|bytes| {
            let resolved_mime = mime_type
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .or_else(|| {
                    mime_guess::from_path(target)
                        .first_raw()
                        .map(ToOwned::to_owned)
                })
                .unwrap_or_else(|| "application/octet-stream".to_string());
            let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);

            format!("data:{resolved_mime};base64,{encoded}")
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn desktop_read_clipboard_html() -> CommandResult<Option<String>> {
    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    normalize_clipboard_html_result(clipboard.get().html())
}

fn normalize_clipboard_html_result(
    result: Result<String, arboard::Error>,
) -> CommandResult<Option<String>> {
    match result {
        Ok(html) if html.trim().is_empty() => Ok(None),
        Ok(html) => Ok(Some(html)),
        Err(arboard::Error::ContentNotAvailable) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn desktop_generate_image_thumbnail(
    state: State<'_, AppState>,
    path: String,
    max_edge: Option<u32>,
) -> CommandResult<String> {
    with_workspace_runtime(state, |runtime| {
        let normalized_path = path.trim();
        let source_path = Path::new(normalized_path);

        ensure_path_exists(source_path)?;

        let max_edge = max_edge.unwrap_or(960).clamp(160, 1600);
        let metadata = fs::metadata(source_path)
            .with_context(|| format!("failed to read metadata for {}", source_path.display()))?;
        let modified_millis = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_millis())
            .unwrap_or(0);
        let cache_key =
            thumbnail_cache_key(normalized_path, metadata.len(), modified_millis, max_edge);
        let cache_dir = runtime
            .paths
            .root_path
            .join(".project-mind")
            .join("cache")
            .join("image-thumbnails");
        fs::create_dir_all(&cache_dir)?;

        let target_path = cache_dir.join(format!("{cache_key}-{max_edge}.jpg"));

        if target_path.exists() {
            return Ok(target_path.to_string_lossy().to_string());
        }

        let pending_path = cache_dir.join(format!("{cache_key}-{max_edge}.tmp"));
        let image = ImageReader::open(source_path)
            .with_context(|| format!("failed to open image {}", source_path.display()))?
            .with_guessed_format()
            .context("failed to detect image format")?
            .decode()
            .with_context(|| format!("failed to decode image {}", source_path.display()))?;
        let thumbnail = image.thumbnail(max_edge, max_edge).to_rgb8();
        let file = fs::File::create(&pending_path)
            .with_context(|| format!("failed to create thumbnail {}", pending_path.display()))?;
        let mut writer = BufWriter::new(file);
        let mut encoder = JpegEncoder::new_with_quality(&mut writer, 72);

        encoder
            .encode(
                thumbnail.as_raw(),
                thumbnail.width(),
                thumbnail.height(),
                ExtendedColorType::Rgb8,
            )
            .with_context(|| format!("failed to encode thumbnail {}", target_path.display()))?;
        fs::rename(&pending_path, &target_path).with_context(|| {
            format!(
                "failed to move thumbnail from {} to {}",
                pending_path.display(),
                target_path.display(),
            )
        })?;

        Ok(target_path.to_string_lossy().to_string())
    })
}

#[tauri::command]
fn desktop_list_system_font_families() -> CommandResult<Vec<String>> {
    system_fonts::list_system_font_families().map_err(|error| error.to_string())
}

#[tauri::command]
fn workspace_status_get(state: State<'_, AppState>) -> CommandResult<WorkspaceStatusSnapshot> {
    state.status_snapshot().map_err(|error| error.to_string())
}

#[tauri::command]
async fn workspace_create(
    state: State<'_, AppState>,
    input: WorkspaceCreateInput,
) -> CommandResult<WorkspaceStatusSnapshot> {
    state.app_handle.state::<dsh_assistant::DshAssistantState>()
        .invalidate(&state.app_handle, || {
            state.create_workspace_root(Path::new(input.root_path.trim()), &input.password).map_err(|error| error.to_string())
        })
        .await
}

#[tauri::command]
async fn workspace_open(
    state: State<'_, AppState>,
    input: WorkspaceOpenInput,
) -> CommandResult<WorkspaceStatusSnapshot> {
    state.app_handle.state::<dsh_assistant::DshAssistantState>()
        .invalidate(&state.app_handle, || {
            state.open_workspace_root(Path::new(input.root_path.trim())).map_err(|error| error.to_string())
        })
        .await
}

#[tauri::command]
async fn workspace_close(state: State<'_, AppState>) -> CommandResult<WorkspaceStatusSnapshot> {
    state.app_handle.state::<dsh_assistant::DshAssistantState>()
        .invalidate(&state.app_handle, || {
            state.close_current_workspace().map_err(|error| error.to_string())
        })
        .await
}

#[tauri::command]
fn workspace_unlock(
    state: State<'_, AppState>,
    input: WorkspaceUnlockInput,
) -> CommandResult<WorkspaceStatusSnapshot> {
    state
        .unlock_current_workspace(&input.password)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn workspace_lock(state: State<'_, AppState>) -> CommandResult<WorkspaceStatusSnapshot> {
    state.app_handle.state::<dsh_assistant::DshAssistantState>()
        .invalidate(&state.app_handle, || {
            state.lock_current_workspace_secrets().map_err(|error| error.to_string())
        })
        .await
}

#[tauri::command]
fn projects_list(
    state: State<'_, AppState>,
    input: Option<ProjectsListInput>,
) -> CommandResult<Vec<ProjectListItem>> {
    with_db(state, |db| {
        db.projects_list(input.unwrap_or(ProjectsListInput {
            include_archived: Some(false),
        }))
    })
}

#[tauri::command]
fn project_create(
    state: State<'_, AppState>,
    input: ProjectCreateInput,
) -> CommandResult<ProjectRecord> {
    with_db(state, |db| db.project_create(input))
}

#[tauri::command]
fn project_page_get(
    state: State<'_, AppState>,
    input: ProjectIdInput,
) -> CommandResult<ProjectPageData> {
    with_db(state, |db| db.project_page_get(input))
}

#[tauri::command]
fn workspace_page_get(state: State<'_, AppState>) -> CommandResult<WorkspacePageData> {
    with_db(state, |db| db.workspace_page_get())
}

#[tauri::command]
fn project_update(
    state: State<'_, AppState>,
    input: ProjectUpdateInput,
) -> CommandResult<ProjectRecord> {
    with_db(state, |db| db.project_update(input))
}

#[tauri::command]
fn project_set_archive(
    state: State<'_, AppState>,
    input: ProjectArchiveInput,
) -> CommandResult<ProjectRecord> {
    with_db(state, |db| db.project_set_archive(input))
}

#[tauri::command]
fn project_delete(
    state: State<'_, AppState>,
    input: ProjectDeleteInput,
) -> CommandResult<ProjectRecord> {
    with_db(state, |db| db.project_delete(input))
}

#[tauri::command]
fn file_tag_settings_get(
    state: State<'_, AppState>,
    input: FileTagSettingsGetInput,
) -> CommandResult<FileTagSettingsSnapshot> {
    with_db(state, |db| db.file_tag_settings_get(input))
}

#[tauri::command]
fn file_tag_option_upsert(
    state: State<'_, AppState>,
    input: FileTagOptionUpsertInput,
) -> CommandResult<FileTagRecord> {
    with_db(state, |db| db.file_tag_option_upsert(input))
}

#[tauri::command]
fn file_tag_option_delete(
    state: State<'_, AppState>,
    input: FileTagOptionDeleteInput,
) -> CommandResult<FileTagSettingsSnapshot> {
    with_db(state, |db| db.file_tag_option_delete(input))
}

#[tauri::command]
fn contact_list(state: State<'_, AppState>) -> CommandResult<Vec<ContactRecord>> {
    with_db(state, |db| db.contact_list())
}

#[tauri::command]
fn contact_search(
    state: State<'_, AppState>,
    input: ContactSearchInput,
) -> CommandResult<Vec<ContactRecord>> {
    with_db(state, |db| db.contact_search(input))
}

#[tauri::command]
fn contact_upsert(
    state: State<'_, AppState>,
    input: ContactUpsertInput,
) -> CommandResult<ContactRecord> {
    with_db(state, |db| db.contact_upsert(input))
}

#[tauri::command]
fn contact_delete(
    state: State<'_, AppState>,
    input: ContactDeleteInput,
) -> CommandResult<ContactRecord> {
    with_db(state, |db| db.contact_delete(input))
}

// Retired desktop adapters deliberately have no AppState/database access. Old
// renderer requests cannot mutate even Records that lack a canonical baseline.
fn reject_legacy_record_write<I, O>(_: I) -> CommandResult<O> {
    Err("旧记录写入接口已停用，请通过正文或元信息保存接口提交；草稿已保留".into())
}

#[tauri::command]
fn project_record_upsert(
    input: ProjectRecordUpsertInput,
) -> CommandResult<NoteRecord> {
    reject_legacy_record_write(input)
}

#[tauri::command]
fn project_quick_note_commit(
    input: ProjectQuickNoteCommitInput,
) -> CommandResult<NoteRecord> {
    reject_legacy_record_write(input)
}

#[tauri::command]
fn project_record_metadata_apply(
    input: ProjectRecordMetadataApplyInput,
) -> CommandResult<NoteRecord> {
    reject_legacy_record_write(input)
}

#[tauri::command]
fn project_record_delete(
    state: State<'_, AppState>,
    input: ProjectRecordDeleteInput,
) -> CommandResult<NoteRecord> {
    with_db(state, |db| db.project_record_delete(input))
}

#[tauri::command]
fn todo_create(state: State<'_, AppState>, input: TodoCreateInput) -> CommandResult<TodoRecord> {
    with_db(state, |db| db.todo_create(input))
}

#[tauri::command]
fn todo_update_status(
    state: State<'_, AppState>,
    input: TodoUpdateStatusInput,
) -> CommandResult<TodoRecord> {
    with_db(state, |db| db.todo_update_status(input))
}

#[tauri::command]
fn todo_update_priority(
    state: State<'_, AppState>,
    input: TodoUpdatePriorityInput,
) -> CommandResult<TodoRecord> {
    with_db(state, |db| db.todo_update_priority(input))
}

#[tauri::command]
fn todo_update_content(
    state: State<'_, AppState>,
    input: TodoUpdateContentInput,
) -> CommandResult<TodoRecord> {
    with_db(state, |db| db.todo_update_content(input))
}

#[tauri::command]
fn todo_update_tags(
    state: State<'_, AppState>,
    input: TodoUpdateTagsInput,
) -> CommandResult<TodoRecord> {
    with_db(state, |db| db.todo_update_tags(input))
}

#[tauri::command]
fn todo_add_progress(
    state: State<'_, AppState>,
    input: TodoAddProgressInput,
) -> CommandResult<TodoProgressRecord> {
    with_db(state, |db| db.todo_add_progress(input))
}

#[tauri::command]
fn todo_update_progress(
    state: State<'_, AppState>,
    input: TodoUpdateProgressInput,
) -> CommandResult<TodoProgressRecord> {
    with_db(state, |db| db.todo_update_progress(input))
}

#[tauri::command]
fn todo_delete_progress(
    state: State<'_, AppState>,
    input: TodoDeleteProgressInput,
) -> CommandResult<TodoProgressRecord> {
    with_db(state, |db| db.todo_delete_progress(input))
}

#[tauri::command]
fn todo_delete(state: State<'_, AppState>, input: TodoDeleteInput) -> CommandResult<TodoRecord> {
    with_db(state, |db| db.todo_delete(input))
}

#[tauri::command]
fn todo_list_open(
    state: State<'_, AppState>,
    input: ProjectIdInput,
) -> CommandResult<Vec<TodoRecord>> {
    with_db(state, |db| db.todo_list_open(input))
}

#[tauri::command]
fn workspace_record_list(state: State<'_, AppState>) -> CommandResult<Vec<WorkspaceRecord>> {
    with_db(state, |db| db.workspace_record_list())
}

#[tauri::command]
fn workspace_quick_note_get(state: State<'_, AppState>) -> CommandResult<Option<WorkspaceRecord>> {
    with_db(state, |db| db.workspace_quick_note_get())
}

#[tauri::command]
fn workspace_quick_note_upsert(
    state: State<'_, AppState>,
    input: WorkspaceQuickNoteUpsertInput,
) -> CommandResult<WorkspaceRecord> {
    with_db(state, |db| db.workspace_quick_note_upsert(input))
}

#[tauri::command]
fn workspace_quick_note_commit(
    input: WorkspaceQuickNoteCommitInput,
) -> CommandResult<WorkspaceRecord> {
    reject_legacy_record_write(input)
}

#[tauri::command]
fn workspace_record_upsert(
    input: WorkspaceRecordUpsertInput,
) -> CommandResult<WorkspaceRecord> {
    reject_legacy_record_write(input)
}

#[tauri::command]
fn workspace_record_metadata_apply(
    input: WorkspaceRecordMetadataApplyInput,
) -> CommandResult<WorkspaceRecord> {
    reject_legacy_record_write(input)
}

#[tauri::command]
fn workspace_record_delete(
    state: State<'_, AppState>,
    input: WorkspaceRecordDeleteInput,
) -> CommandResult<WorkspaceRecord> {
    with_db(state, |db| db.workspace_record_delete(input))
}

#[tauri::command]
fn workspace_note_image_import(
    state: State<'_, AppState>,
    input: WorkspaceNoteImageImportInput,
) -> CommandResult<WorkspaceNoteImageAsset> {
    with_db(state, |db| db.workspace_note_image_import(input))
}

#[tauri::command]
fn workspace_clipboard_note_image_import(
    state: State<'_, AppState>,
    input: WorkspaceClipboardNoteImageImportInput,
) -> CommandResult<WorkspaceNoteImageAsset> {
    with_db(state, |db| db.workspace_clipboard_note_image_import(input))
}

#[tauri::command]
fn document_import(
    state: State<'_, AppState>,
    input: DocumentImportInput,
) -> CommandResult<DocumentRecord> {
    with_db(state, |db| db.document_import(input))
}

#[tauri::command]
fn document_import_clipboard_image(
    state: State<'_, AppState>,
    input: DocumentImportClipboardImageInput,
) -> CommandResult<DocumentRecord> {
    with_db(state, |db| db.document_import_clipboard_image(input))
}

#[tauri::command]
fn document_import_note_image(
    state: State<'_, AppState>,
    input: DocumentImportNoteImageInput,
) -> CommandResult<DocumentRecord> {
    with_db(state, |db| db.document_import_note_image(input))
}

#[tauri::command]
fn document_import_clipboard_note_image(
    state: State<'_, AppState>,
    input: DocumentImportClipboardNoteImageInput,
) -> CommandResult<DocumentRecord> {
    with_db(state, |db| db.document_import_clipboard_note_image(input))
}

#[tauri::command]
fn document_update_meta(
    state: State<'_, AppState>,
    input: DocumentUpdateMetaInput,
) -> CommandResult<DocumentRecord> {
    with_db(state, |db| db.document_update_meta(input))
}

#[tauri::command]
fn document_relocate(
    state: State<'_, AppState>,
    input: DocumentRelocateInput,
) -> CommandResult<DocumentRecord> {
    with_db(state, |db| db.document_relocate(input))
}

#[tauri::command]
fn document_list_versions(
    state: State<'_, AppState>,
    input: DocumentListVersionsInput,
) -> CommandResult<Vec<DocumentVersionRecord>> {
    with_db(state, |db| db.document_list_versions(input))
}

#[tauri::command]
fn document_delete(
    state: State<'_, AppState>,
    input: DocumentDeleteInput,
) -> CommandResult<DocumentRecord> {
    with_db(state, |db| db.document_delete(input))
}

#[tauri::command]
fn ai_settings_get(state: State<'_, AppState>) -> CommandResult<AiSettingsSnapshot> {
    with_db(state, |db| db.ai_settings_get())
}

#[tauri::command]
fn rich_text_style_get(state: State<'_, AppState>) -> CommandResult<RichTextStyleSettings> {
    with_db(state, |db| db.rich_text_style_get())
}

#[tauri::command]
fn rich_text_style_upsert(
    state: State<'_, AppState>,
    input: RichTextStyleUpsertInput,
) -> CommandResult<RichTextStyleSettings> {
    with_db(state, |db| db.rich_text_style_upsert(input))
}

#[tauri::command]
fn ai_profile_upsert(
    state: State<'_, AppState>,
    input: AiProviderProfileUpsertInput,
) -> CommandResult<AiProviderProfileRecord> {
    with_db(state, |db| db.ai_profile_upsert(input))
}

#[tauri::command]
fn ai_profile_delete(
    state: State<'_, AppState>,
    input: AiProviderProfileDeleteInput,
) -> CommandResult<AiSettingsSnapshot> {
    with_db(state, |db| db.ai_profile_delete(input))
}

#[tauri::command]
fn ai_profile_test(
    state: State<'_, AppState>,
    input: AiProfileTestInput,
) -> CommandResult<AiProfileTestResult> {
    with_db(state, |db| db.ai_profile_test(input))
}

#[tauri::command]
fn ai_binding_upsert(
    state: State<'_, AppState>,
    input: AiCapabilityBindingUpsertInput,
) -> CommandResult<AiCapabilityBindingRecord> {
    with_db(state, |db| db.ai_binding_upsert(input))
}

#[tauri::command]
fn ai_editor_skill_upsert(
    state: State<'_, AppState>,
    input: AiEditorSkillUpsertInput,
) -> CommandResult<AiEditorSkillRecord> {
    with_db(state, |db| db.ai_editor_skill_upsert(input))
}

#[tauri::command]
fn ai_editor_skill_delete(
    state: State<'_, AppState>,
    input: AiEditorSkillDeleteInput,
) -> CommandResult<Vec<AiEditorSkillRecord>> {
    with_db(state, |db| db.ai_editor_skill_delete(input))
}

#[tauri::command]
fn ai_editor_skill_reorder(
    state: State<'_, AppState>,
    input: AiEditorSkillReorderInput,
) -> CommandResult<Vec<AiEditorSkillRecord>> {
    with_db(state, |db| db.ai_editor_skill_reorder(input))
}

#[tauri::command]
fn ai_job_enqueue(
    state: State<'_, AppState>,
    input: AiJobEnqueueInput,
) -> CommandResult<AiJobSnapshot> {
    with_workspace_runtime(state, |runtime| Ok(runtime.ai_jobs.enqueue(input)))
}

#[tauri::command]
fn ai_job_get(state: State<'_, AppState>, job_id: i64) -> CommandResult<Option<AiJobSnapshot>> {
    with_workspace_runtime(state, |runtime| Ok(runtime.ai_jobs.get(job_id)))
}

#[tauri::command]
fn ai_job_cancel(state: State<'_, AppState>, job_id: i64) -> CommandResult<Option<AiJobSnapshot>> {
    with_workspace_runtime(state, |runtime| Ok(runtime.ai_jobs.cancel(job_id)))
}

#[tauri::command]
fn ai_image_target_signature(
    path: String,
    annotation_state: Option<String>,
) -> CommandResult<String> {
    ai_provider::image_target_signature(&path, annotation_state.as_deref())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn ai_jobs_list_active(state: State<'_, AppState>) -> CommandResult<Vec<AiJobSnapshot>> {
    with_workspace_runtime(state, |runtime| Ok(runtime.ai_jobs.list_active()))
}

#[tauri::command]
fn ai_network_settings_upsert(
    state: State<'_, AppState>,
    input: models::AiNetworkSettingsUpsertInput,
) -> CommandResult<models::AiNetworkSettings> {
    with_db(state, |db| db.ai_network_settings_upsert(input))
}

#[tauri::command]
fn ai_execution_settings_upsert(
    state: State<'_, AppState>,
    input: AiExecutionSettings,
) -> CommandResult<AiExecutionSettings> {
    let runtime = state
        .current_workspace()
        .map_err(|error| error.to_string())?;
    let settings = {
        let mut db = lock_mutex(&runtime.db);
        db.ai_execution_settings_upsert(input)
            .map_err(|error| error.to_string())?
    };
    runtime
        .ai_jobs
        .set_max_concurrency(settings.max_concurrency);
    Ok(settings)
}

#[tauri::command]
async fn app_exit(state: State<'_, AppState>) -> CommandResult<()> {
    state.ensure_voice_idle().map_err(|error| error.to_string())?;
    settle_agents_before_exit(&state).await;
    state.seal_current_record_checkpoints().map_err(|error| error.to_string())?;
    state.app_handle.state::<dsh_assistant::DshAssistantState>().shutdown().await?;
    state.exit_authorized.store(true, std::sync::atomic::Ordering::SeqCst);
    state.app_handle.exit(0);
    Ok(())
}

#[tauri::command]
async fn app_restart(state: State<'_, AppState>) -> CommandResult<()> {
    state.ensure_voice_idle().map_err(|error| error.to_string())?;
    settle_agents_before_exit(&state).await;
    state.seal_current_record_checkpoints().map_err(|error| error.to_string())?;
    state.app_handle.state::<dsh_assistant::DshAssistantState>().shutdown().await?;
    state.exit_authorized.store(true, std::sync::atomic::Ordering::SeqCst);
    state.app_handle.request_restart();
    Ok(())
}

async fn settle_agents_before_exit(state: &AppState) {
    let runtime = lock_mutex(&state.current_workspace).clone();
    if let Some(runtime) = runtime {
        runtime.cancel_agent_runs();
        // The Host cancels, then kills after its grace period. A damaged database
        // must not trap application exit; startup marks unfinished runs interrupted.
        let _ = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            while !lock_mutex(&runtime.agent_runs).is_empty() {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }).await;
    }
}

#[tauri::command]
fn workspace_search(
    state: State<'_, AppState>,
    input: WorkspaceSearchInput,
) -> CommandResult<Vec<WorkspaceSearchResult>> {
    with_db(state, |db| db.workspace_search(input))
}

#[tauri::command]
fn internal_reference_search(
    state: State<'_, AppState>,
    input: InternalReferenceSearchInput,
) -> CommandResult<Vec<InternalReferenceSearchResult>> {
    with_db(state, |db| db.internal_reference_search(input))
}

#[tauri::command]
fn internal_reference_resolve(
    state: State<'_, AppState>,
    input: InternalReferenceResolveInput,
) -> CommandResult<Option<InternalReferenceResolveResult>> {
    with_db(state, |db| db.internal_reference_resolve(input))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                dsh_assistant::DshAssistantState::detach_parent(window.app_handle().clone(), window.label().into());
            }
        })
        .on_page_load(|webview, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Started {
                return;
            }
            let label = webview.label();
            let parent_label = label == "main"
                || label.strip_prefix("project-").is_some_and(|id| {
                    !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit())
                });
            let window = webview.window();
            if !parent_label || window.label() != label {
                return;
            }
            let url = payload.url();
            let local = if cfg!(dev) {
                webview.app_handle().config().build.dev_url.as_ref()
                    .is_some_and(|dev| dev.origin() == url.origin())
            } else {
                (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                    || (matches!(url.scheme(), "http" | "https")
                        && url.host_str() == Some("tauri.localhost"))
            };
            if !local {
                return;
            }
            // A document reload skips React cleanup; release its carriers while
            // retaining the runtime and any executing task.
            dsh_assistant::DshAssistantState::detach_parent(webview.app_handle().clone(), label.into());

        })
        .setup(|app| {
            ensure_main_window(app)?;

            let app_data_dir = default_app_data_dir()?;
            let local_session_path = app_data_dir.join(LOCAL_WORKSPACE_SESSION_FILE_NAME);
            cleanup_legacy_app_data(&app_data_dir, &local_session_path)?;

            let state = AppState {
                app_handle: app.handle().clone(),
                local_session_path: local_session_path.clone(),
                current_workspace: Mutex::new(None),
                record_editors: Arc::new(record_editor_coordination::RecordEditorCoordinator::default()),
                voice_runtime: Mutex::new(voice::runtime::VoiceRuntime::default()),
                exit_authorized: std::sync::atomic::AtomicBool::new(false),
                external_bridge: agent::bridge::BridgeRuntime::default(),
            };

            let local_session = load_local_session(&local_session_path)?;
            if let Some(last_root) = local_session.last_opened_workspace_root {
                let _ = state.open_workspace_root(Path::new(&last_root));
            }

            app.manage(dsh_assistant::DshAssistantState::default());
            app.manage(state);
            agent::bridge::commands::restore(app.handle());
            source_maintenance::start(app.handle());
            overview_maintenance::start(app.handle());
            let record_handle = app.handle().clone();
            std::thread::Builder::new()
                .name("record-checkpoints".into())
                .spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    let state = record_handle.state::<AppState>();
                    let current = lock_mutex(&state.current_workspace);
                    if let Some(workspace) = current.as_ref() {
                        let db = lock_mutex(&workspace.db);
                        if let Err(error) = db.record_seal_pending_checkpoints(false, &workspace.agent_binding.workspace_id) {
                            let _ = record_handle.emit("record:checkpoint-error", error);
                        }
                    }
                })?;
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("voice-supervisor".into())
                .spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    let state = handle.state::<AppState>();
                    let workspace = lock_mutex(&state.current_workspace).clone();
                    if let Some(workspace) = workspace {
                        let mut voice = lock_mutex(&state.voice_runtime);
                        let current = lock_mutex(&state.current_workspace);
                        if !current
                            .as_ref()
                            .is_some_and(|current| Arc::ptr_eq(current, &workspace))
                        {
                            continue;
                        }
                        let mut db = lock_mutex(&workspace.db);
                        let captured = committed_changes::capture_native_committed(&workspace.agent_binding, &mut db, "voice-supervisor", |db|
                            voice.snapshot(db, &workspace.paths.root_path));
                        let (result, changes) = match captured {
                            Ok(captured) => captured,
                            Err(error) => (Err(error), None),
                        };
                        let (recover, error) = match result {
                            Ok(snapshot) => {
                                let busy = !workspace.ai_secrets_unlocked()
                                    || snapshot.as_ref().is_some_and(|session| {
                                        matches!(session.phase.as_str(), "recording" | "preparing" | "ending")
                                    });
                                workspace.voice_recovery_interrupt.store(busy, std::sync::atomic::Ordering::Release);
                                let recover = !busy && db.voice_cloud_has_ready(chrono::Utc::now().timestamp_millis()).unwrap_or(false);
                                (recover, None)
                            }
                            Err(error) => {
                                (false, Some(error))
                            }
                        };
                        drop(db);
                        drop(current);
                        drop(voice);
                        if let Some(changes) = changes { committed_changes::publish_to(&handle, changes); }
                        if let Some(error) = error { let _ = handle.emit("voice:error", error.to_string()); }
                        if recover { voice::recovery::kick(workspace.clone(), handle.clone()); }
                    }
                })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            source_maintenance::agent_source_maintenance,
            overview_commands::agent_overview_maintenance,
            overview_commands::agent_overview_corrections_get,
            overview_commands::agent_overview_correction_upsert,
            overview_commands::agent_overview_correction_delete,
            record_document_commands::record_editor_register,
            record_document_commands::record_cut_register,
            record_document_commands::record_cut_claim,
            record_document_commands::record_editor_unregister,
            record_document_commands::record_editor_flush_reply,
            record_document_commands::record_editors_flush,
            record_document_commands::record_workspace_binding_get,
            record_document_commands::record_quick_note_transfer,
            record_document_commands::record_editor_get,
            record_document_commands::record_body_save,
            record_document_commands::record_metadata_apply,
            record_document_commands::record_create,
            record_document_commands::record_metadata_get,
            record_document_commands::record_metadata_update,
            record_document_commands::record_checkpoint,
            record_document_commands::record_versions_list,
            record_document_commands::record_version_get,
            record_document_commands::record_version_preview,
            record_document_commands::record_version_restore,
            record_document_commands::record_versions_compare,
            record_document_commands::record_version_capacity,
            agent::commands::agent_status_get,
            agent::bridge::commands::agent_connections_status,
            agent::bridge::commands::agent_cli_install,
            agent::bridge::commands::agent_cli_uninstall,
            agent::bridge::commands::agent_connections_enable,
            agent::bridge::commands::agent_connection_create,
            agent::bridge::commands::agent_connection_revoke,
            agent::conversation_commands::agent_session_create,
            agent::conversation_commands::agent_sessions_list,
            agent::conversation_commands::agent_session_search,
            agent::conversation_commands::agent_session_get,
            agent::session_history::agent_session_messages_read,
            agent::conversation_commands::agent_session_archive,
            agent::conversation_commands::agent_session_delete,
            agent::conversation_commands::agent_run_get,
            agent::conversation_commands::agent_run_events_list,
            agent::run_commands::agent_run_start,
            agent::run_commands::agent_run_cancel,
            agent::run_commands::agent_profile_probe,
            agent::output_commands::agent_output_list,
            agent::output_commands::agent_output_get,
            agent::output_commands::agent_output_preview,
            agent::output_commands::agent_output_update,
            agent::output_commands::agent_output_dismiss,
            agent::output_review::agent_output_review,
            file_read_commands::file_source_read,
            file_read_commands::file_versions_list,
            file_read_commands::file_versions_get,
            file_read_commands::file_version_restore,
            agent::output_commands::agent_output_commit,
            agent::output_commands::agent_operation_list,
            agent::output_commands::agent_operation_get,
            agent::output_commands::agent_operation_undo,
            agent::output_commands::agent_operation_undo_batch,
            agent::output_commands::agent_operation_restore_created,
            agent::source_navigation::agent_source_resolve,
            agent::commands::agent_context_get,
            agent::commands::agent_overview_get,
            agent::commands::agent_knowledge_get,
            agent::commands::agent_knowledge_search,
            memory_commands::agent_memory_list,
            memory_commands::agent_memory_get,
            memory_commands::agent_memory_update,
            agent::commands::agent_settings_get,
            agent::commands::agent_settings_update,
            agent::commands::agent_instructions_list,
            agent::commands::agent_instruction_upsert,
            agent::commands::agent_instruction_delete,
            agent::commands::agent_changes_list,
            agent::commands::agent_business_changes_list,
            voice_caption_apply_material,
            voice::commands::voice_availability_get,
            voice::commands::voice_model_status_get,
            voice::commands::voice_model_import,
            voice::commands::voice_profile_test,
            voice::commands::voice_settings_get,
            voice::commands::voice_settings_upsert,
            voice::commands::voice_start,
            voice::commands::voice_pause,
            voice::commands::voice_resume,
            voice::commands::voice_end,
            voice::commands::voice_snapshot_get,
            voice::commands::voice_playback_get,
            voice::commands::voice_transcript_list,
            voice::commands::voice_recovery_get,
            voice::commands::voice_recovery_retry,
            voice::commands::voice_transcript_tail,
            voice::commands::voice_minutes_get,
            voice::commands::voice_minutes_generate,
            desktop_open_file,
            desktop_open_folder,
            desktop_reveal_in_explorer,
            desktop_read_file_as_data_url,
            desktop_resolve_export_image,
            desktop_cancel_export_image,
            desktop_export_available_bytes,
            desktop_export_path_exists,
            desktop_next_available_export_path,
            desktop_write_export_file,
            desktop_cancel_export_write,
            desktop_read_clipboard_html,
            desktop_generate_image_thumbnail,
            desktop_list_system_font_families,
            workspace_status_get,
            workspace_create,
            workspace_open,
            workspace_close,
            workspace_unlock,
            workspace_lock,
            projects_list,
            project_create,
            project_page_get,
            workspace_page_get,
            project_update,
            project_set_archive,
            project_delete,
            file_tag_settings_get,
            file_tag_option_upsert,
            file_tag_option_delete,
            contact_list,
            contact_search,
            contact_upsert,
            contact_delete,
            project_record_upsert,
            project_quick_note_commit,
            project_record_metadata_apply,
            project_record_delete,
            todo_create,
            todo_update_status,
            todo_update_priority,
            todo_update_content,
            todo_update_tags,
            todo_add_progress,
            todo_update_progress,
            todo_delete_progress,
            todo_delete,
            todo_list_open,
            workspace_quick_note_get,
            workspace_quick_note_upsert,
            workspace_quick_note_commit,
            workspace_record_list,
            workspace_record_upsert,
            workspace_record_metadata_apply,
            workspace_record_delete,
            workspace_note_image_import,
            workspace_clipboard_note_image_import,
            document_import,
            document_import_clipboard_image,
            document_import_note_image,
            document_import_clipboard_note_image,
            document_update_meta,
            document_relocate,
            document_list_versions,
            file_document_commands::document_version_prepare,
            file_document_commands::document_add_version,
            document_delete,
            ai_settings_get,
            rich_text_style_get,
            rich_text_style_upsert,
            ai_profile_upsert,
            ai_profile_delete,
            ai_profile_test,
            ai_binding_upsert,
            ai_editor_skill_upsert,
            ai_editor_skill_delete,
            ai_editor_skill_reorder,
            ai_job_enqueue,
            ai_job_get,
            ai_job_cancel,
            ai_image_target_signature,
            ai_jobs_list_active,
            ai_execution_settings_upsert,
            ai_network_settings_upsert,
            internal_reference_search,
            internal_reference_resolve,
            workspace_search,
            dsh_assistant::dsh_assistant_start,
            dsh_assistant::dsh_assistant_sessions,
            dsh_assistant::dsh_assistant_runtime_status,
            dsh_assistant::dsh_assistant_select_session,
            dsh_assistant::dsh_assistant_fetch,
            dsh_assistant::dsh_assistant_cancel,
            dsh_assistant::dsh_assistant_connect,
            dsh_assistant::dsh_assistant_send,
            dsh_assistant::dsh_assistant_disconnect,
            dsh_assistant::dsh_assistant_create_session,
            dsh_assistant::dsh_assistant_delete_session,
            project_directory::project_directory_list,
            project_directory::project_directory_preview,
            project_directory::project_directory_open,
            project_directory::project_directory_resolve_reference,
            project_directory::project_file_register,
            project_directory::project_file_resolve,
            project_directory::project_file_resolve_related,
            project_directory::project_file_read_bytes,
            project_directory::project_file_open_local,
            project_directory::project_file_move,
            project_directory::project_file_rename,
            project_directory::project_file_reconcile,
            project_directory::project_file_scan,
            app_exit,
            app_restart
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app.state::<AppState>();
                if !state.exit_authorized.load(std::sync::atomic::Ordering::SeqCst)
                    && lock_mutex(&state.current_workspace).is_some() {
                    api.prevent_exit();
                    let _ = app.emit_to("main", "app:exit-requested", ());
                } else if !state.exit_authorized.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if handle.state::<dsh_assistant::DshAssistantState>().shutdown().await.is_err() {
                            handle.state::<dsh_assistant::DshAssistantState>().exit_fallback();
                        }
                        handle.state::<AppState>().exit_authorized.store(true, std::sync::atomic::Ordering::SeqCst);
                        handle.exit(0);
                    });
                }
            } else if let tauri::RunEvent::Exit = event {
                app.state::<dsh_assistant::DshAssistantState>().exit_fallback();
            }
        });
}

#[cfg(all(test, debug_assertions))]
mod app_data_override_tests {
    use super::debug_app_data_dir_override;
    use std::path::PathBuf;

    #[test]
    fn absolute_fixture_path_is_preserved() {
        let path = std::env::temp_dir().join("project-mind-isolated-acceptance");
        assert_eq!(debug_app_data_dir_override(path.clone()).unwrap(), path);
    }

    #[test]
    fn relative_and_empty_fixture_paths_are_rejected() {
        for path in [PathBuf::new(), PathBuf::from("relative-fixture")] {
            assert!(debug_app_data_dir_override(path).is_err());
        }
    }
}

#[cfg(test)]
mod clipboard_tests {
    use super::normalize_clipboard_html_result;

    #[test]
    fn clipboard_html_normalization_distinguishes_empty_content_from_failures() {
        assert_eq!(
            normalize_clipboard_html_result(Ok("  <p>Rich</p>  ".to_owned())).unwrap(),
            Some("  <p>Rich</p>  ".to_owned())
        );
        assert_eq!(
            normalize_clipboard_html_result(Ok("  ".to_owned())).unwrap(),
            None
        );
        assert_eq!(
            normalize_clipboard_html_result(Err(arboard::Error::ContentNotAvailable)).unwrap(),
            None
        );
        assert!(normalize_clipboard_html_result(Err(arboard::Error::ClipboardOccupied)).is_err());
    }
}

#[cfg(test)]
mod workspace_lifecycle_tests {
    use std::{path::Path, sync::Mutex};

    use crate::workspace::LocalSessionState;

    use super::{close_workspace_runtime, load_local_session, save_local_session};

    #[test]
    fn closing_workspace_releases_runtime_and_persists_only_recent_history() {
        let temp = tempfile::tempdir().unwrap();
        let session_path = temp.path().join("workspace-session.json");
        let mut session = LocalSessionState::default();
        session.record_recent_workspace(Path::new("active-workspace"));
        save_local_session(&session_path, &session).unwrap();
        let fence = std::sync::Arc::new(crate::workspace_commit_fence::WorkspaceCommitFence::new());
        let current_runtime = Mutex::new(Some(fence.clone()));

        close_workspace_runtime(&session_path, &current_runtime, |fence| fence.invalidate()).unwrap();

        assert!(current_runtime.lock().unwrap().is_none());
        assert_eq!(
            fence.enter().unwrap_err().code,
            crate::agent::errors::ErrorCode::WorkspaceChanged,
        );
        let session = load_local_session(&session_path).unwrap();
        assert_eq!(session.last_opened_workspace_root, None);
        assert_eq!(session.recent_workspace_roots.len(), 1);
    }
    #[test]
    fn failed_workspace_close_keeps_runtime_and_commit_fence_active() {
        let temp = tempfile::tempdir().unwrap();
        let blocker = temp.path().join("not-a-directory");
        std::fs::write(&blocker, b"keep").unwrap();
        let fence = std::sync::Arc::new(crate::workspace_commit_fence::WorkspaceCommitFence::new());
        let current_runtime = Mutex::new(Some(fence.clone()));
        assert!(close_workspace_runtime(
            &blocker.join("workspace-session.json"),
            &current_runtime,
            |fence| fence.invalidate(),
        ).is_err());
        assert!(current_runtime.lock().unwrap().is_some());
        assert!(fence.enter().is_ok());
    }
}

#[cfg(all(test, debug_assertions))]
mod debug_workspace_auto_unlock_tests {
    use super::{debug_create_workspace, debug_workspace_password, debug_read_workspace_key, debug_write_workspace_key, debug_workspace_key_path};
    use crate::workspace::{create_workspace, load_metadata, verify_workspace_password};

    #[test]
    fn new_workspace_uses_local_generated_key_and_reopens_without_keychain() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        let app_data = temp.path().join("app-data");
        debug_create_workspace(&root, |id, password| debug_write_workspace_key(&app_data, id, password)).unwrap();
        let (metadata, _) = load_metadata(&root).unwrap();
        let password = debug_workspace_password(&metadata, None,
            |id| debug_read_workspace_key(&app_data, id),
        ).unwrap().unwrap();
        verify_workspace_password(&metadata, &password).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let key = debug_workspace_key_path(&app_data, &metadata.workspace_id).unwrap();
            assert_eq!(std::fs::metadata(key).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn explicit_fixture_configuration_unlocks_without_any_cache_access() {
        let temp = tempfile::tempdir().unwrap();
        let (metadata, _) = create_workspace(temp.path(), "fixture-password").unwrap();
        let password = debug_workspace_password(&metadata, Some("fixture-password"),
            |_| panic!("explicit fixture must not access a password cache"),
        ).unwrap();
        assert_eq!(password.as_deref(), Some("fixture-password"));
    }

    #[test]
    fn uncached_workspace_stays_locked_and_wrong_fixture_cannot_unlock_it() {
        let temp = tempfile::tempdir().unwrap();
        let (metadata, _) = create_workspace(temp.path(), "existing-password").unwrap();
        for fixture in [None, Some("other-fixture-password")] {
            assert!(debug_workspace_password(&metadata, fixture, |_| Ok(None)).unwrap().is_none());
        }
        assert!(debug_workspace_password(&metadata, None, |_| Ok(Some("wrong".into()))).is_err());
    }

    #[test]
    fn development_key_cache_is_workspace_scoped_and_rejects_path_escape() {
        let temp = tempfile::tempdir().unwrap();
        let first = "00000000000000000000000000000001";
        let second = "00000000000000000000000000000002";
        debug_write_workspace_key(temp.path(), first, "first generated key").unwrap();
        debug_write_workspace_key(temp.path(), second, "second generated key").unwrap();
        assert_eq!(debug_read_workspace_key(temp.path(), first).unwrap().as_deref(), Some("first generated key"));
        assert_eq!(debug_read_workspace_key(temp.path(), second).unwrap().as_deref(), Some("second generated key"));
        for id in ["../outside", "/absolute", "", "0000000000000000000000000000000g"] {
            assert!(debug_write_workspace_key(temp.path(), id, "key").is_err());
            assert!(debug_read_workspace_key(temp.path(), id).is_err());
        }
    }

    #[test]
    fn local_cache_failure_does_not_leave_an_unrecoverable_generated_workspace() {
        let temp = tempfile::tempdir().unwrap();
        assert!(debug_create_workspace(temp.path(), |_, _| Err(anyhow::anyhow!("store unavailable"))).is_err());
        assert!(load_metadata(temp.path()).is_err());
        debug_create_workspace(temp.path(), |_, _| Ok(())).unwrap();
    }
}
