use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: i64,
    pub name: String,
    pub status: String,
    pub root_path: String,
    pub summary: String,
    pub is_archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListItem {
    pub id: i64,
    pub name: String,
    pub status: String,
    pub root_path: String,
    pub summary: String,
    pub is_archived: bool,
    pub created_at: String,
    pub updated_at: String,
    pub activity_count: i64,
    pub unorganized_count: i64,
    pub open_todo_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRecord {
    pub id: i64,
    pub project_id: i64,
    pub activity_id: i64,
    pub note_type: String,
    pub title: Option<String>,
    pub content_markdown: String,
    pub content_html: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConclusionRecord {
    pub id: i64,
    pub project_id: i64,
    pub activity_id: Option<i64>,
    pub note_id: Option<i64>,
    pub content: String,
    pub promoted_to_project: bool,
    pub source_activity_title: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoProgressRecord {
    pub id: i64,
    pub todo_id: i64,
    pub content: String,
    pub status_snapshot: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoRecord {
    pub id: i64,
    pub project_id: i64,
    pub activity_id: Option<i64>,
    pub source_note_id: Option<i64>,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub priority: String,
    pub due_date: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub source_activity_title: Option<String>,
    pub progresses: Vec<TodoProgressRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRecord {
    pub id: i64,
    pub project_id: i64,
    pub activity_id: Option<i64>,
    pub name: String,
    pub original_path: String,
    pub managed_path: String,
    pub storage_mode: String,
    pub mime_type: String,
    pub role: String,
    pub is_starred: bool,
    pub promoted_to_project: bool,
    pub source_activity_title: Option<String>,
    pub health: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDigest {
    pub id: i64,
    pub project_id: i64,
    pub category: String,
    pub title: String,
    pub activity_time: String,
    pub review_status: String,
    pub organize_status: String,
    pub is_pinned: bool,
    pub note_count: i64,
    pub conclusion_count: i64,
    pub todo_count: i64,
    pub document_count: i64,
    pub completed_todo_count: i64,
    pub total_todo_count: i64,
    pub has_open_todos: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSuggestionRecord {
    pub id: i64,
    pub project_id: i64,
    pub activity_id: Option<i64>,
    pub note_id: Option<i64>,
    pub suggestion_type: String,
    pub title: String,
    pub preview: String,
    pub payload: Value,
    pub status: String,
    pub created_at: String,
    pub accepted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityCardData {
    pub id: i64,
    pub project_id: i64,
    pub category: String,
    pub title: String,
    pub activity_time: String,
    pub is_pinned: bool,
    pub is_expanded: bool,
    pub organize_status: String,
    pub created_at: String,
    pub updated_at: String,
    pub digest: ActivityDigest,
    pub notes: Vec<NoteRecord>,
    pub conclusions: Vec<ConclusionRecord>,
    pub todos: Vec<TodoRecord>,
    pub documents: Vec<DocumentRecord>,
    pub ai_suggestions: Vec<AiSuggestionRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDashboard {
    pub project: ProjectRecord,
    pub key_conclusions: Vec<ConclusionRecord>,
    pub open_todos: Vec<TodoRecord>,
    pub starred_documents: Vec<DocumentRecord>,
    pub recent_activities: Vec<ActivityDigest>,
    pub unorganized_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConclusionGroup {
    pub activity_id: Option<i64>,
    pub activity_title: String,
    pub conclusions: Vec<ConclusionRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOverviewData {
    pub project: ProjectRecord,
    pub activity_feed: Vec<ActivityDigest>,
    pub key_documents: Vec<DocumentRecord>,
    pub conclusion_groups: Vec<ConclusionGroup>,
    pub unfinished_todos: Vec<TodoRecord>,
    pub finished_todos: Vec<TodoRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchResult {
    pub kind: String,
    pub id: i64,
    pub project_id: i64,
    pub activity_id: Option<i64>,
    pub title: String,
    pub subtitle: String,
    pub matched_text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedSuggestionResult {
    pub suggestion: AiSuggestionRecord,
    pub entity_kind: String,
    pub entity_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreateInput {
    pub name: String,
    pub summary: Option<String>,
    pub status: Option<String>,
    pub workspace_root: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUpdateSummaryInput {
    pub project_id: i64,
    pub summary: String,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIdInput {
    pub project_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsListInput {
    pub include_archived: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchInput {
    pub query: String,
    pub include_archived: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectArchiveInput {
    pub project_id: i64,
    pub is_archived: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityCreateInput {
    pub project_id: i64,
    pub category: String,
    pub title: Option<String>,
    pub activity_time: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityUpdateMetaInput {
    pub activity_id: i64,
    pub title: Option<String>,
    pub category: Option<String>,
    pub activity_time: Option<String>,
    pub is_pinned: Option<bool>,
    pub is_expanded: Option<bool>,
    pub organize_status: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteAppendQuickInput {
    pub project_id: i64,
    pub activity_id: i64,
    pub title: Option<String>,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpsertMinutesInput {
    pub project_id: i64,
    pub activity_id: i64,
    pub note_id: Option<i64>,
    pub title: Option<String>,
    pub markdown: String,
    pub html: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConclusionCreateInput {
    pub project_id: i64,
    pub activity_id: Option<i64>,
    pub note_id: Option<i64>,
    pub content: String,
    pub promoted_to_project: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConclusionListInput {
    pub project_id: i64,
    pub activity_id: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConclusionUpdateInput {
    pub conclusion_id: i64,
    pub content: String,
    pub promoted_to_project: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoCreateInput {
    pub project_id: i64,
    pub activity_id: Option<i64>,
    pub source_note_id: Option<i64>,
    pub title: String,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub due_date: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoUpdateStatusInput {
    pub todo_id: i64,
    pub status: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoAddProgressInput {
    pub todo_id: i64,
    pub content: String,
    pub status_snapshot: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentImportInput {
    pub project_id: i64,
    pub activity_id: Option<i64>,
    pub source_path: String,
    pub role: String,
    pub is_starred: bool,
    pub promoted_to_project: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentUpdateMetaInput {
    pub document_id: i64,
    pub role: Option<String>,
    pub is_starred: Option<bool>,
    pub promoted_to_project: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRelocateInput {
    pub document_id: i64,
    pub new_source_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiGenerateInput {
    pub project_id: i64,
    pub activity_id: i64,
    pub note_id: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAcceptSuggestionInput {
    pub suggestion_id: i64,
}
