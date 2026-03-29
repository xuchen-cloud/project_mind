mod db;
mod mock_ai;
mod models;

use std::sync::Mutex;

use anyhow::Result;
use db::Database;
use models::{
    AcceptedSuggestionResult, ActivityCardData, ActivityCreateInput, ActivityUpdateMetaInput,
    AiAcceptSuggestionInput, AiGenerateInput, AiSuggestionRecord, ConclusionCreateInput,
    ConclusionListInput, ConclusionRecord, ConclusionUpdateInput, DocumentImportInput,
    DocumentRecord, DocumentRelocateInput, DocumentUpdateMetaInput, NoteAppendQuickInput,
    NoteRecord, NoteUpsertMinutesInput, ProjectArchiveInput, ProjectCreateInput,
    ProjectDashboard, ProjectIdInput, ProjectListItem, ProjectOverviewData, ProjectRecord,
    ProjectUpdateSummaryInput, ProjectsListInput, TodoAddProgressInput, TodoCreateInput,
    TodoProgressRecord, TodoRecord, TodoUpdateStatusInput, WorkspaceSearchInput,
    WorkspaceSearchResult,
};
use tauri::{Manager, State};

struct AppState {
    db: Mutex<Database>,
}

type CommandResult<T> = std::result::Result<T, String>;

fn with_db<T>(state: State<'_, AppState>, task: impl FnOnce(&mut Database) -> Result<T>) -> CommandResult<T> {
    let mut db = state
        .db
        .lock()
        .map_err(|_| "failed to lock application state".to_string())?;
    task(&mut db).map_err(|error| error.to_string())
}

#[tauri::command]
fn projects_list(
    state: State<'_, AppState>,
    input: Option<ProjectsListInput>,
) -> CommandResult<Vec<ProjectListItem>> {
    with_db(state, |db| db.projects_list(input.unwrap_or(ProjectsListInput {
        include_archived: Some(false),
    })))
}

#[tauri::command]
fn project_create(state: State<'_, AppState>, input: ProjectCreateInput) -> CommandResult<ProjectRecord> {
    with_db(state, |db| db.project_create(input))
}

#[tauri::command]
fn project_get_dashboard(state: State<'_, AppState>, input: ProjectIdInput) -> CommandResult<ProjectDashboard> {
    with_db(state, |db| db.project_get_dashboard(input))
}

#[tauri::command]
fn project_get_overview(state: State<'_, AppState>, input: ProjectIdInput) -> CommandResult<ProjectOverviewData> {
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
fn activity_create(state: State<'_, AppState>, input: ActivityCreateInput) -> CommandResult<ActivityCardData> {
    with_db(state, |db| db.activity_create(input))
}

#[tauri::command]
fn activity_list(state: State<'_, AppState>, input: ProjectIdInput) -> CommandResult<Vec<ActivityCardData>> {
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
fn note_append_quick(state: State<'_, AppState>, input: NoteAppendQuickInput) -> CommandResult<NoteRecord> {
    with_db(state, |db| db.note_append_quick(input))
}

#[tauri::command]
fn note_upsert_minutes(
    state: State<'_, AppState>,
    input: NoteUpsertMinutesInput,
) -> CommandResult<NoteRecord> {
    with_db(state, |db| db.note_upsert_minutes(input))
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
fn todo_add_progress(
    state: State<'_, AppState>,
    input: TodoAddProgressInput,
) -> CommandResult<TodoProgressRecord> {
    with_db(state, |db| db.todo_add_progress(input))
}

#[tauri::command]
fn todo_list_open(state: State<'_, AppState>, input: ProjectIdInput) -> CommandResult<Vec<TodoRecord>> {
    with_db(state, |db| db.todo_list_open(input))
}

#[tauri::command]
fn document_import(state: State<'_, AppState>, input: DocumentImportInput) -> CommandResult<DocumentRecord> {
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
            projects_list,
            project_create,
            project_get_dashboard,
            project_get_overview,
            project_update_summary,
            project_set_archive,
            activity_create,
            activity_list,
            activity_update_meta,
            note_append_quick,
            note_upsert_minutes,
            conclusion_create,
            conclusion_list,
            conclusion_update,
            todo_create,
            todo_update_status,
            todo_add_progress,
            todo_list_open,
            document_import,
            document_update_meta,
            document_relocate,
            ai_generate_note_suggestions,
            ai_accept_suggestion,
            workspace_search
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
