mod ai_jobs;
mod ai_provider;
mod db;
mod device_identity;
mod models;
mod secret_crypto;

use std::{
    env,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use ai_jobs::AiJobManager;
use anyhow::{bail, Result};
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
    DocumentAddVersionInput, DocumentDeleteInput,
    DocumentImportInput, DocumentListVersionsInput, DocumentRecord, DocumentRelocateInput,
    DocumentUpdateMetaInput, DocumentVersionRecord, FileTagOptionDeleteInput,
    FileTagOptionUpsertInput, FileTagRecord, FileTagSettingsSnapshot, NoteRecord, NoteUpsertInput,
    ProjectArchiveInput, ProjectCreateInput, ProjectDashboard, ProjectIdInput, ProjectListItem,
    ProjectOverviewData, ProjectRecord, ProjectUpdateSummaryInput, ProjectsListInput,
    RecordTypeOptionDeleteInput, RecordTypeOptionUpsertInput, RecordTypeRecord,
    RecordTypeSettingsSnapshot, RichTextStyleSettings, RichTextStyleUpsertInput,
    TodoAddProgressInput, TodoCreateInput, TodoDeleteInput, TodoProgressRecord, TodoRecord,
    TodoUpdateContentInput, TodoUpdatePriorityInput, TodoUpdateStatusInput, WorkspaceSearchInput,
    WorkspaceSearchResult,
};
use tauri::{Emitter, Manager, State, WebviewWindowBuilder};
use tauri_plugin_opener::{open_path, reveal_item_in_dir};

const APP_IDENTIFIER: &str = "com.xuchen.projectmind.alpha";
const APP_DB_FILE_NAME: &str = "project_mind_alpha.sqlite3";
const DEFAULT_DEMO_WORKSPACE_DIR_NAME: &str = "Project Mind Alpha Demo Workspace";

struct AppState {
    db: Mutex<Database>,
    _db_path: PathBuf,
    ai_jobs: AiJobManager,
}

type CommandResult<T> = std::result::Result<T, String>;

fn with_db<T>(
    state: State<'_, AppState>,
    task: impl FnOnce(&mut Database) -> Result<T>,
) -> CommandResult<T> {
    let mut db = state
        .db
        .lock()
        .map_err(|_| "failed to lock application state".to_string())?;
    task(&mut db).map_err(|error| error.to_string())
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

pub fn default_app_database_path() -> Result<PathBuf> {
    Ok(default_app_data_dir()?.join(APP_DB_FILE_NAME))
}

pub fn default_demo_workspace_root() -> Result<PathBuf> {
    Ok(default_home_dir()?
        .join("Documents")
        .join(DEFAULT_DEMO_WORKSPACE_DIR_NAME))
}

pub fn seed_demo_database_at(db_path: &Path, workspace_root: &Path) -> Result<DemoSeedResult> {
    let mut db = Database::open(db_path)?;
    db.reset_and_seed_demo_data(workspace_root)
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
            .ok_or_else(|| anyhow::anyhow!("APPDATA is not available"))?;
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
        .ok_or_else(|| anyhow::anyhow!("failed to resolve the current user's home directory"))
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
fn document_import(
    state: State<'_, AppState>,
    input: DocumentImportInput,
) -> CommandResult<DocumentRecord> {
    with_db(state, |db| db.document_import(input))
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
    Ok(state.ai_jobs.enqueue(input))
}

#[tauri::command]
fn ai_job_get(state: State<'_, AppState>, job_id: i64) -> CommandResult<Option<AiJobSnapshot>> {
    Ok(state.ai_jobs.get(job_id))
}

#[tauri::command]
fn ai_jobs_list_active(state: State<'_, AppState>) -> CommandResult<Vec<AiJobSnapshot>> {
    Ok(state.ai_jobs.list_active())
}

#[tauri::command]
fn ai_execution_settings_upsert(
    state: State<'_, AppState>,
    input: AiExecutionSettings,
) -> CommandResult<AiExecutionSettings> {
    let settings = {
        let mut db = state
            .db
            .lock()
            .map_err(|_| "failed to lock application state".to_string())?;
        db.ai_execution_settings_upsert(input)
            .map_err(|error| error.to_string())?
    };
    state.ai_jobs.set_max_concurrency(settings.max_concurrency);
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
            let app_data_dir = app.path().app_data_dir()?;
            let db_path = app_data_dir.join("project_mind_alpha.sqlite3");
            let mut db = Database::open(&db_path)?;
            let execution = db.ai_execution_settings_get()?;
            let app_handle = app.handle().clone();
            let ai_jobs = AiJobManager::new(
                db_path.clone(),
                execution.max_concurrency,
                Arc::new(move |snapshot| {
                    let _ = app_handle.emit(ai_jobs::AI_JOB_EVENT, snapshot);
                }),
            );
            app.manage(AppState {
                db: Mutex::new(db),
                _db_path: db_path,
                ai_jobs,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_open_file,
            desktop_open_folder,
            desktop_reveal_in_explorer,
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
            conclusion_create,
            conclusion_list,
            conclusion_update,
            conclusion_delete,
            todo_create,
            todo_update_status,
            todo_update_priority,
            todo_update_content,
            todo_add_progress,
            todo_delete,
            todo_list_open,
            document_import,
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
