mod ai_jobs;
mod ai_provider;
mod db;
mod models;
mod secret_crypto;
mod system_fonts;
mod workspace;

use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

use ai_jobs::AiJobManager;
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use db::Database;
pub use db::DemoSeedResult;
use models::{
    AcceptedSuggestionResult, ActivityAttributeOption, ActivityAttributeOptionUpsertInput,
    ActivityCardData, ActivityCreateInput, ActivityOptionDeleteInput, ActivitySettingsSnapshot,
    ActivityStatusOption, ActivityStatusOptionUpsertInput, ActivityUpdateMetaInput,
    AiAcceptSuggestionInput, AiAnswerQuestionInput, AiAnswerResult, AiArtifactGetInput,
    AiArtifactRecord, AiCapabilityBindingRecord, AiCapabilityBindingUpsertInput,
    AiExecutionSettings, AiFeatureSettings, AiGenerateInput, AiJobEnqueueInput, AiJobSnapshot,
    AiProfileTestInput, AiProfileTestResult, AiProviderProfileDeleteInput, AiProviderProfileRecord,
    AiProviderProfileUpsertInput, AiSettingsSnapshot, AiSuggestionRecord, ConclusionCreateInput,
    ConclusionDeleteInput, ConclusionListInput, ConclusionRecord, ConclusionUpdateInput,
    DocumentAddVersionInput, DocumentDeleteInput, DocumentImportClipboardImageInput,
    DocumentImportClipboardNoteImageInput, DocumentImportInput, DocumentImportNoteImageInput,
    DocumentListVersionsInput, DocumentRecord, DocumentRelocateInput, DocumentUpdateMetaInput,
    DocumentVersionRecord, FileTagOptionDeleteInput, FileTagOptionUpsertInput, FileTagRecord,
    FileTagSettingsSnapshot, NoteDeleteInput, NoteRecord, NoteUpsertInput, ProjectArchiveInput,
    ProjectCreateInput, ProjectDashboard, ProjectIdInput, ProjectListItem, ProjectOverviewData,
    ProjectRecord, ProjectUpdateSummaryInput, ProjectsListInput, RecordTypeOptionDeleteInput,
    RecordTypeOptionUpsertInput, RecordTypeRecord, RecordTypeSettingsSnapshot,
    RichTextStyleSettings, RichTextStyleUpsertInput, TodayQuickNoteUpsertInput,
    TodoAddProgressInput, TodoCreateInput, TodoDeleteInput, TodoDeleteProgressInput,
    TodoProgressRecord, TodoRecord, TodoUpdateActivityInput, TodoUpdateContentInput,
    TodoUpdatePriorityInput, TodoUpdateProgressInput, TodoUpdateStatusInput,
    WorkspaceCreateInput, WorkspaceNoteDeleteInput, WorkspaceNoteRecord,
    WorkspaceNoteUpsertInput, WorkspaceOpenInput, WorkspaceSearchInput,
    WorkspaceSearchResult, WorkspaceStatusSnapshot, WorkspaceSummary, WorkspaceUnlockInput,
};
use tauri::{Emitter, Manager, State, WebviewWindowBuilder};
use tauri_plugin_opener::{open_path, reveal_item_in_dir};
use workspace::{
    cleanup_legacy_app_data, create_workspace, load_local_session, load_metadata,
    save_local_session, verify_workspace_password, workspace_summary, WorkspaceMetadata,
    WorkspacePaths, WORKSPACE_SECURITY_MODE,
};

const APP_IDENTIFIER: &str = "com.xuchen.projectmind.alpha";
const DEFAULT_DEMO_WORKSPACE_DIR_NAME: &str = "Project Mind Alpha Demo Workspace";
const LOCAL_WORKSPACE_SESSION_FILE_NAME: &str = "workspace-session.json";

pub struct SeedDemoWorkspaceResult {
    pub workspace_root: String,
    pub metadata_path: String,
    pub summary: DemoSeedResult,
}

struct WorkspaceRuntime {
    summary: WorkspaceSummary,
    metadata: WorkspaceMetadata,
    paths: WorkspacePaths,
    secret_state: Arc<Mutex<Option<String>>>,
    db: Mutex<Database>,
    ai_jobs: AiJobManager,
}

impl WorkspaceRuntime {
    fn new(
        app_handle: &tauri::AppHandle,
        metadata: WorkspaceMetadata,
        paths: WorkspacePaths,
        secret_password: Option<String>,
    ) -> Result<Self> {
        let mut db = Database::open(&paths.db_path, &paths.root_path, secret_password.clone())?;
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

        Ok(Self {
            summary: workspace_summary(&paths.root_path, &metadata),
            metadata,
            paths,
            secret_state,
            db: Mutex::new(db),
            ai_jobs,
        })
    }

    fn ai_secrets_unlocked(&self) -> bool {
        lock_mutex(&self.secret_state).is_some()
    }

    fn set_secret_password(&self, secret_password: Option<String>) -> Result<()> {
        {
            let mut secret = lock_mutex(&self.secret_state);
            *secret = secret_password.clone();
        }

        let mut db_guard = lock_mutex(&self.db);
        let next_db = Database::open(&self.paths.db_path, &self.paths.root_path, secret_password)?;
        *db_guard = next_db;
        let execution = db_guard.ai_execution_settings_get()?;
        self.ai_jobs.set_max_concurrency(execution.max_concurrency);
        Ok(())
    }
}

struct AppState {
    app_handle: tauri::AppHandle,
    local_session_path: PathBuf,
    current_workspace: Mutex<Option<Arc<WorkspaceRuntime>>>,
}

impl AppState {
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
        *current = runtime;
    }

    fn current_workspace(&self) -> Result<Arc<WorkspaceRuntime>> {
        lock_mutex(&self.current_workspace)
            .clone()
            .ok_or_else(|| anyhow!("no workspace is currently open"))
    }

    fn open_workspace_root(&self, root_path: &Path) -> Result<WorkspaceStatusSnapshot> {
        let (metadata, paths) = load_metadata(root_path)?;
        let runtime = Arc::new(WorkspaceRuntime::new(
            &self.app_handle,
            metadata,
            paths,
            None,
        )?);
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
        create_workspace(root_path, password)?;
        self.open_workspace_root(root_path)
    }

    fn unlock_current_workspace(&self, password: &str) -> Result<WorkspaceStatusSnapshot> {
        let runtime = self.current_workspace()?;
        verify_workspace_password(&runtime.metadata, password)?;
        runtime.set_secret_password(Some(password.to_string()))?;
        self.status_snapshot()
    }

    fn lock_current_workspace_secrets(&self) -> Result<WorkspaceStatusSnapshot> {
        let runtime = self.current_workspace()?;
        runtime.set_secret_password(None)?;
        self.status_snapshot()
    }
}

type CommandResult<T> = std::result::Result<T, String>;

fn lock_mutex<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn with_db<T>(
    state: State<'_, AppState>,
    task: impl FnOnce(&mut Database) -> Result<T>,
) -> CommandResult<T> {
    let runtime = state
        .current_workspace()
        .map_err(|error| error.to_string())?;
    let mut db = lock_mutex(&runtime.db);
    task(&mut db).map_err(|error| error.to_string())
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
    let summary = db.reset_and_seed_demo_data(workspace_root)?;

    Ok(SeedDemoWorkspaceResult {
        workspace_root: workspace_root.to_string_lossy().to_string(),
        metadata_path: paths.metadata_path.to_string_lossy().to_string(),
        summary,
    })
}

fn default_app_data_dir() -> Result<PathBuf> {
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

    WebviewWindowBuilder::from_config(app.handle(), window_config)?.build()?;
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
fn desktop_list_system_font_families() -> CommandResult<Vec<String>> {
    system_fonts::list_system_font_families().map_err(|error| error.to_string())
}

#[tauri::command]
fn workspace_status_get(state: State<'_, AppState>) -> CommandResult<WorkspaceStatusSnapshot> {
    state.status_snapshot().map_err(|error| error.to_string())
}

#[tauri::command]
fn workspace_create(
    state: State<'_, AppState>,
    input: WorkspaceCreateInput,
) -> CommandResult<WorkspaceStatusSnapshot> {
    state
        .create_workspace_root(Path::new(input.root_path.trim()), &input.password)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn workspace_open(
    state: State<'_, AppState>,
    input: WorkspaceOpenInput,
) -> CommandResult<WorkspaceStatusSnapshot> {
    state
        .open_workspace_root(Path::new(input.root_path.trim()))
        .map_err(|error| error.to_string())
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
fn workspace_lock(state: State<'_, AppState>) -> CommandResult<WorkspaceStatusSnapshot> {
    state
        .lock_current_workspace_secrets()
        .map_err(|error| error.to_string())
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
fn project_get_dashboard(
    state: State<'_, AppState>,
    input: ProjectIdInput,
) -> CommandResult<ProjectDashboard> {
    with_db(state, |db| db.project_get_dashboard(input))
}

#[tauri::command]
fn project_get_overview(
    state: State<'_, AppState>,
    input: ProjectIdInput,
) -> CommandResult<ProjectOverviewData> {
    with_db(state, |db| db.project_get_overview(input))
}

#[tauri::command]
fn project_update_summary(
    state: State<'_, AppState>,
    input: ProjectUpdateSummaryInput,
) -> CommandResult<ProjectRecord> {
    with_db(state, |db| db.project_update_summary(input))
}

#[tauri::command]
fn project_set_archive(
    state: State<'_, AppState>,
    input: ProjectArchiveInput,
) -> CommandResult<ProjectRecord> {
    with_db(state, |db| db.project_set_archive(input))
}

#[tauri::command]
fn activity_create(
    state: State<'_, AppState>,
    input: ActivityCreateInput,
) -> CommandResult<ActivityCardData> {
    with_db(state, |db| db.activity_create(input))
}

#[tauri::command]
fn activity_list(
    state: State<'_, AppState>,
    input: ProjectIdInput,
) -> CommandResult<Vec<ActivityCardData>> {
    with_db(state, |db| db.activity_list(input))
}

#[tauri::command]
fn activity_update_meta(
    state: State<'_, AppState>,
    input: ActivityUpdateMetaInput,
) -> CommandResult<ActivityCardData> {
    with_db(state, |db| db.activity_update_meta(input))
}

#[tauri::command]
fn activity_settings_get(state: State<'_, AppState>) -> CommandResult<ActivitySettingsSnapshot> {
    with_db(state, |db| db.activity_settings_get())
}

#[tauri::command]
fn activity_attribute_option_upsert(
    state: State<'_, AppState>,
    input: ActivityAttributeOptionUpsertInput,
) -> CommandResult<ActivityAttributeOption> {
    with_db(state, |db| db.activity_attribute_option_upsert(input))
}

#[tauri::command]
fn activity_attribute_option_delete(
    state: State<'_, AppState>,
    input: ActivityOptionDeleteInput,
) -> CommandResult<ActivitySettingsSnapshot> {
    with_db(state, |db| db.activity_attribute_option_delete(input))
}

#[tauri::command]
fn activity_status_option_upsert(
    state: State<'_, AppState>,
    input: ActivityStatusOptionUpsertInput,
) -> CommandResult<ActivityStatusOption> {
    with_db(state, |db| db.activity_status_option_upsert(input))
}

#[tauri::command]
fn activity_status_option_delete(
    state: State<'_, AppState>,
    input: ActivityOptionDeleteInput,
) -> CommandResult<ActivitySettingsSnapshot> {
    with_db(state, |db| db.activity_status_option_delete(input))
}

#[tauri::command]
fn file_tag_settings_get(state: State<'_, AppState>) -> CommandResult<FileTagSettingsSnapshot> {
    with_db(state, |db| db.file_tag_settings_get())
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
fn record_type_settings_get(
    state: State<'_, AppState>,
) -> CommandResult<RecordTypeSettingsSnapshot> {
    with_db(state, |db| db.record_type_settings_get())
}

#[tauri::command]
fn record_type_option_upsert(
    state: State<'_, AppState>,
    input: RecordTypeOptionUpsertInput,
) -> CommandResult<RecordTypeRecord> {
    with_db(state, |db| db.record_type_option_upsert(input))
}

#[tauri::command]
fn record_type_option_delete(
    state: State<'_, AppState>,
    input: RecordTypeOptionDeleteInput,
) -> CommandResult<RecordTypeSettingsSnapshot> {
    with_db(state, |db| db.record_type_option_delete(input))
}

#[tauri::command]
fn note_upsert(state: State<'_, AppState>, input: NoteUpsertInput) -> CommandResult<NoteRecord> {
    with_db(state, |db| db.note_upsert(input))
}

#[tauri::command]
fn note_delete(state: State<'_, AppState>, input: NoteDeleteInput) -> CommandResult<NoteRecord> {
    with_db(state, |db| db.note_delete(input))
}

#[tauri::command]
fn conclusion_create(
    state: State<'_, AppState>,
    input: ConclusionCreateInput,
) -> CommandResult<ConclusionRecord> {
    with_db(state, |db| db.conclusion_create(input))
}

#[tauri::command]
fn conclusion_list(
    state: State<'_, AppState>,
    input: ConclusionListInput,
) -> CommandResult<Vec<ConclusionRecord>> {
    with_db(state, |db| db.conclusion_list(input))
}

#[tauri::command]
fn conclusion_update(
    state: State<'_, AppState>,
    input: ConclusionUpdateInput,
) -> CommandResult<ConclusionRecord> {
    with_db(state, |db| db.conclusion_update(input))
}

#[tauri::command]
fn conclusion_delete(
    state: State<'_, AppState>,
    input: ConclusionDeleteInput,
) -> CommandResult<ConclusionRecord> {
    with_db(state, |db| db.conclusion_delete(input))
}

#[tauri::command]
fn todo_create(state: State<'_, AppState>, input: TodoCreateInput) -> CommandResult<TodoRecord> {
    with_db(state, |db| db.todo_create(input))
}

#[tauri::command]
fn todo_update_activity(
    state: State<'_, AppState>,
    input: TodoUpdateActivityInput,
) -> CommandResult<TodoRecord> {
    with_db(state, |db| db.todo_update_activity(input))
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
fn workspace_todo_list(state: State<'_, AppState>) -> CommandResult<Vec<TodoRecord>> {
    with_db(state, |db| db.workspace_todo_list())
}

#[tauri::command]
fn workspace_note_list(state: State<'_, AppState>) -> CommandResult<Vec<WorkspaceNoteRecord>> {
    with_db(state, |db| db.workspace_note_list())
}

#[tauri::command]
fn today_quick_note_get(
    state: State<'_, AppState>,
) -> CommandResult<Option<WorkspaceNoteRecord>> {
    with_db(state, |db| db.today_quick_note_get())
}

#[tauri::command]
fn today_quick_note_upsert(
    state: State<'_, AppState>,
    input: TodayQuickNoteUpsertInput,
) -> CommandResult<WorkspaceNoteRecord> {
    with_db(state, |db| db.today_quick_note_upsert(input))
}

#[tauri::command]
fn workspace_note_upsert(
    state: State<'_, AppState>,
    input: WorkspaceNoteUpsertInput,
) -> CommandResult<WorkspaceNoteRecord> {
    with_db(state, |db| db.workspace_note_upsert(input))
}

#[tauri::command]
fn workspace_note_delete(
    state: State<'_, AppState>,
    input: WorkspaceNoteDeleteInput,
) -> CommandResult<WorkspaceNoteRecord> {
    with_db(state, |db| db.workspace_note_delete(input))
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
fn document_add_version(
    state: State<'_, AppState>,
    input: DocumentAddVersionInput,
) -> CommandResult<DocumentRecord> {
    with_db(state, |db| db.document_add_version(input))
}

#[tauri::command]
fn document_delete(
    state: State<'_, AppState>,
    input: DocumentDeleteInput,
) -> CommandResult<DocumentRecord> {
    with_db(state, |db| db.document_delete(input))
}

#[tauri::command]
fn ai_generate_note_suggestions(
    state: State<'_, AppState>,
    input: AiGenerateInput,
) -> CommandResult<Vec<AiSuggestionRecord>> {
    with_db(state, |db| db.ai_generate_note_suggestions(input))
}

#[tauri::command]
fn ai_accept_suggestion(
    state: State<'_, AppState>,
    input: AiAcceptSuggestionInput,
) -> CommandResult<AcceptedSuggestionResult> {
    with_db(state, |db| db.ai_accept_suggestion(input))
}

#[tauri::command]
fn ai_artifact_get(
    state: State<'_, AppState>,
    input: AiArtifactGetInput,
) -> CommandResult<Option<AiArtifactRecord>> {
    with_db(state, |db| db.ai_artifact_get(input))
}

#[tauri::command]
fn ai_artifact_refresh(
    state: State<'_, AppState>,
    input: AiArtifactGetInput,
) -> CommandResult<AiArtifactRecord> {
    with_db(state, |db| db.ai_artifact_refresh(input))
}

#[tauri::command]
fn ai_answer_question(
    state: State<'_, AppState>,
    input: AiAnswerQuestionInput,
) -> CommandResult<AiAnswerResult> {
    with_db(state, |db| db.ai_answer_question(input))
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
fn ai_jobs_list_active(state: State<'_, AppState>) -> CommandResult<Vec<AiJobSnapshot>> {
    with_workspace_runtime(state, |runtime| Ok(runtime.ai_jobs.list_active()))
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
fn ai_feature_settings_upsert(
    state: State<'_, AppState>,
    input: AiFeatureSettings,
) -> CommandResult<AiFeatureSettings> {
    with_db(state, |db| db.ai_feature_settings_upsert(input))
}

#[tauri::command]
fn workspace_search(
    state: State<'_, AppState>,
    input: WorkspaceSearchInput,
) -> CommandResult<Vec<WorkspaceSearchResult>> {
    with_db(state, |db| db.workspace_search(input))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            ensure_main_window(app)?;

            let app_data_dir = default_app_data_dir()?;
            let local_session_path = app_data_dir.join(LOCAL_WORKSPACE_SESSION_FILE_NAME);
            cleanup_legacy_app_data(&app_data_dir, &local_session_path)?;

            let state = AppState {
                app_handle: app.handle().clone(),
                local_session_path: local_session_path.clone(),
                current_workspace: Mutex::new(None),
            };

            let local_session = load_local_session(&local_session_path)?;
            if let Some(last_root) = local_session.last_opened_workspace_root {
                let _ = state.open_workspace_root(Path::new(&last_root));
            }

            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_open_file,
            desktop_open_folder,
            desktop_reveal_in_explorer,
            desktop_read_file_as_data_url,
            desktop_list_system_font_families,
            workspace_status_get,
            workspace_create,
            workspace_open,
            workspace_unlock,
            workspace_lock,
            projects_list,
            project_create,
            project_get_dashboard,
            project_get_overview,
            project_update_summary,
            project_set_archive,
            activity_create,
            activity_list,
            activity_update_meta,
            activity_settings_get,
            activity_attribute_option_upsert,
            activity_attribute_option_delete,
            activity_status_option_upsert,
            activity_status_option_delete,
            file_tag_settings_get,
            file_tag_option_upsert,
            file_tag_option_delete,
            record_type_settings_get,
            record_type_option_upsert,
            record_type_option_delete,
            note_upsert,
            note_delete,
            conclusion_create,
            conclusion_list,
            conclusion_update,
            conclusion_delete,
            todo_create,
            todo_update_activity,
            todo_update_status,
            todo_update_priority,
            todo_update_content,
            todo_add_progress,
            todo_update_progress,
            todo_delete_progress,
            todo_delete,
            todo_list_open,
            workspace_todo_list,
            today_quick_note_get,
            today_quick_note_upsert,
            workspace_note_list,
            workspace_note_upsert,
            workspace_note_delete,
            document_import,
            document_import_clipboard_image,
            document_import_note_image,
            document_import_clipboard_note_image,
            document_update_meta,
            document_relocate,
            document_list_versions,
            document_add_version,
            document_delete,
            ai_generate_note_suggestions,
            ai_accept_suggestion,
            ai_artifact_get,
            ai_artifact_refresh,
            ai_answer_question,
            ai_settings_get,
            rich_text_style_get,
            rich_text_style_upsert,
            ai_profile_upsert,
            ai_profile_delete,
            ai_profile_test,
            ai_binding_upsert,
            ai_job_enqueue,
            ai_job_get,
            ai_jobs_list_active,
            ai_execution_settings_upsert,
            ai_feature_settings_upsert,
            workspace_search
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
