mod ai_provider;
mod db;
mod device_identity;
mod models;
mod secret_crypto;

use std::sync::Mutex;
use std::{path::Path, process::Command};

use anyhow::{bail, Context, Result};
use db::Database;
use models::{
    AcceptedSuggestionResult, ActivityAttributeOption, ActivityAttributeOptionUpsertInput,
    ActivityCardData, ActivityCreateInput, ActivityOptionDeleteInput, ActivitySettingsSnapshot,
    ActivityStatusOption, ActivityStatusOptionUpsertInput, ActivityUpdateMetaInput,
    AiAcceptSuggestionInput, AiCapabilityBindingRecord, AiCapabilityBindingUpsertInput,
    AiGenerateInput, AiProfileTestInput, AiProfileTestResult, AiProviderProfileDeleteInput,
    AiProviderProfileRecord, AiProviderProfileUpsertInput, AiSettingsSnapshot, AiSuggestionRecord,
    ConclusionCreateInput, ConclusionListInput, ConclusionRecord, ConclusionUpdateInput,
    DocumentAddVersionInput, DocumentImportInput, DocumentListVersionsInput, DocumentRecord,
    DocumentRelocateInput, DocumentUpdateMetaInput, DocumentVersionRecord, NoteRecord,
    NoteUpsertInput, ProjectArchiveInput, ProjectCreateInput, ProjectDashboard, ProjectIdInput,
    ProjectListItem, ProjectOverviewData, ProjectRecord, ProjectUpdateSummaryInput,
    ProjectsListInput, RichTextStyleSettings, RichTextStyleUpsertInput, TodoAddProgressInput,
    TodoCreateInput, TodoProgressRecord, TodoRecord, TodoUpdateContentInput, TodoUpdateStatusInput,
    WorkspaceSearchInput, WorkspaceSearchResult,
};
use tauri::{Manager, State};

struct AppState {
    db: Mutex<Database>,
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

fn run_command(command: &mut Command, action: &str, path: &Path) -> Result<()> {
    let status = command
        .status()
        .with_context(|| format!("failed to {} {}", action, path.display()))?;

    if status.success() {
        Ok(())
    } else {
        bail!(
            "failed to {} {} (exit status: {})",
            action,
            path.display(),
            status
        )
    }
}

fn open_path_with_system_app(path: &Path) -> Result<()> {
    ensure_path_exists(path)?;
    open_path_with_system_app_impl(path)
}

fn reveal_path_in_explorer(path: &Path) -> Result<()> {
    ensure_path_exists(path)?;
    reveal_path_in_explorer_impl(path)
}

#[cfg(target_os = "macos")]
fn open_path_with_system_app_impl(path: &Path) -> Result<()> {
    let mut command = Command::new("open");
    command.arg(path);
    run_command(&mut command, "open path", path)
}

#[cfg(target_os = "windows")]
fn open_path_with_system_app_impl(path: &Path) -> Result<()> {
    let mut command = Command::new("cmd");
    command.arg("/C").arg("start").arg("").arg(path.as_os_str());
    run_command(&mut command, "open path", path)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_path_with_system_app_impl(path: &Path) -> Result<()> {
    let mut command = Command::new("xdg-open");
    command.arg(path);
    run_command(&mut command, "open path", path)
}

#[cfg(target_os = "macos")]
fn reveal_path_in_explorer_impl(path: &Path) -> Result<()> {
    let mut command = Command::new("open");
    command.arg("-R").arg(path);
    run_command(&mut command, "reveal path", path)
}

#[cfg(target_os = "windows")]
fn reveal_path_in_explorer_impl(path: &Path) -> Result<()> {
    let mut command = Command::new("explorer");
    command.arg(format!("/select,{}", path.display()));
    run_command(&mut command, "reveal path", path)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn reveal_path_in_explorer_impl(path: &Path) -> Result<()> {
    let reveal_target = path.parent().unwrap_or(path);
    let mut command = Command::new("xdg-open");
    command.arg(reveal_target);
    run_command(&mut command, "reveal path", path)
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
            let app_data_dir = app.path().app_data_dir()?;
            let db_path = app_data_dir.join("project_mind_alpha.sqlite3");
            let db = Database::open(&db_path)?;
            app.manage(AppState { db: Mutex::new(db) });
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
            note_upsert,
            conclusion_create,
            conclusion_list,
            conclusion_update,
            todo_create,
            todo_update_status,
            todo_update_content,
            todo_add_progress,
            todo_list_open,
            document_import,
            document_update_meta,
            document_relocate,
            document_list_versions,
            document_add_version,
            ai_generate_note_suggestions,
            ai_accept_suggestion,
            ai_settings_get,
            rich_text_style_get,
            rich_text_style_upsert,
            ai_profile_upsert,
            ai_profile_delete,
            ai_profile_test,
            ai_binding_upsert,
            workspace_search
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
