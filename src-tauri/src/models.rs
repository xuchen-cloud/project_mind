use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: i64,
    pub name: String,
    pub status: String,
    pub root_path: String,
    pub file_layout_version: i64,
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
    pub file_layout_version: i64,
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
    pub content_markdown: String,
    pub content_html: String,
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
    pub progress_date: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoRecord {
    pub id: i64,
    pub project_id: i64,
    pub activity_id: Option<i64>,
    pub content: String,
    pub status: String,
    pub priority: String,
    pub created_at: String,
    pub updated_at: String,
    pub progresses: Vec<TodoProgressRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRecord {
    pub id: i64,
    pub project_id: i64,
    pub activity_id: Option<i64>,
    pub name: String,
    pub base_name: String,
    pub original_path: String,
    pub managed_path: String,
    pub history_dir_path: String,
    pub storage_mode: String,
    pub mime_type: String,
    pub is_starred: bool,
    pub current_version_number: i64,
    pub version_count: i64,
    pub source_activity_title: Option<String>,
    pub health: String,
    pub tags: Vec<DocumentTagRecord>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentVersionRecord {
    pub id: i64,
    pub document_id: i64,
    pub version_number: i64,
    pub name: String,
    pub source_path: String,
    pub managed_path: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentTagRecord {
    pub id: i64,
    pub label: String,
    pub color_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTagRecord {
    pub id: i64,
    pub label: String,
    pub color_key: String,
    pub usage_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordTypeRecord {
    pub id: i64,
    pub key: String,
    pub label: String,
    pub color_key: String,
    pub template_html: String,
    pub is_default: bool,
    pub usage_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityAttributeOption {
    pub id: i64,
    pub label: String,
    pub color_key: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityStatusOption {
    pub id: i64,
    pub label: String,
    pub color_key: String,
    pub needs_attention: bool,
    pub is_system: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySettingsSnapshot {
    pub activity_attribute_options: Vec<ActivityAttributeOption>,
    pub activity_status_options: Vec<ActivityStatusOption>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTagSettingsSnapshot {
    pub tags: Vec<FileTagRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordTypeSettingsSnapshot {
    pub record_types: Vec<RecordTypeRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDigest {
    pub id: i64,
    pub project_id: i64,
    pub attribute_option_id: Option<i64>,
    pub attribute_label: Option<String>,
    pub attribute_color_key: Option<String>,
    pub title: String,
    pub activity_time: String,
    pub status_option_id: i64,
    pub status_label: String,
    pub status_color_key: String,
    pub status_needs_attention: bool,
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
pub struct AiProviderProfileRecord {
    pub id: i64,
    pub name: String,
    pub provider_family: String,
    pub base_url: String,
    pub api_key_last4: String,
    pub has_stored_key: bool,
    pub default_model: String,
    pub supports_text: bool,
    pub supports_image: bool,
    pub supports_file: bool,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilityBindingRecord {
    pub capability: String,
    pub use_default: bool,
    pub profile_id: Option<i64>,
    pub model: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsSnapshot {
    pub profiles: Vec<AiProviderProfileRecord>,
    pub bindings: Vec<AiCapabilityBindingRecord>,
    pub has_usable_default: bool,
    pub security_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RichTextStyleBlockSettings {
    pub font_preset: String,
    pub font_size_px: i64,
    pub line_height: f64,
    pub paragraph_spacing_before_px: i64,
    pub paragraph_spacing_after_px: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RichTextHeadingStyleSettings {
    pub font_preset: String,
    pub line_height: f64,
    pub paragraph_spacing_before_px: i64,
    pub paragraph_spacing_after_px: i64,
    pub h1_size_px: i64,
    pub h2_size_px: i64,
    pub h3_size_px: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RichTextStyleSettings {
    pub body: RichTextStyleBlockSettings,
    pub headings: RichTextHeadingStyleSettings,
    pub list: RichTextStyleBlockSettings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProfileTestResult {
    pub success: bool,
    pub message: String,
    pub latency_ms: Option<i64>,
    pub resolved_model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityCardData {
    pub id: i64,
    pub project_id: i64,
    pub attribute_option_id: Option<i64>,
    pub attribute_label: Option<String>,
    pub attribute_color_key: Option<String>,
    pub title: String,
    pub activity_time: String,
    pub status_option_id: i64,
    pub status_label: String,
    pub status_color_key: String,
    pub status_needs_attention: bool,
    pub is_pinned: bool,
    pub is_expanded: bool,
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
    pub project_documents: Vec<DocumentRecord>,
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
    pub name: Option<String>,
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
    pub attribute_option_id: Option<i64>,
    pub title: Option<String>,
    pub activity_time: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityUpdateMetaInput {
    pub activity_id: i64,
    pub title: Option<String>,
    pub attribute_option_id: Option<i64>,
    pub clear_attribute_option: Option<bool>,
    pub activity_time: Option<String>,
    pub is_pinned: Option<bool>,
    pub is_expanded: Option<bool>,
    pub status_option_id: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityAttributeOptionUpsertInput {
    pub id: Option<i64>,
    pub label: String,
    pub color_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityStatusOptionUpsertInput {
    pub id: Option<i64>,
    pub label: String,
    pub color_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityOptionDeleteInput {
    pub option_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTagOptionUpsertInput {
    pub id: Option<i64>,
    pub label: String,
    pub color_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTagOptionDeleteInput {
    pub tag_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordTypeOptionUpsertInput {
    pub id: Option<i64>,
    pub label: String,
    pub color_key: String,
    pub template_html: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordTypeOptionDeleteInput {
    pub type_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpsertInput {
    pub project_id: i64,
    pub activity_id: i64,
    pub note_id: Option<i64>,
    pub note_type: String,
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
    pub markdown: String,
    pub html: String,
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
    pub markdown: String,
    pub html: String,
    pub promoted_to_project: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoCreateInput {
    pub project_id: i64,
    pub activity_id: Option<i64>,
    pub content: String,
    pub priority: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoUpdateContentInput {
    pub todo_id: i64,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoUpdateStatusInput {
    pub todo_id: i64,
    pub status: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoUpdatePriorityInput {
    pub todo_id: i64,
    pub priority: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoAddProgressInput {
    pub todo_id: i64,
    pub content: String,
    pub progress_date: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentImportInput {
    pub project_id: i64,
    pub activity_id: Option<i64>,
    pub source_path: String,
    pub is_starred: bool,
    pub tag_ids: Option<Vec<i64>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentUpdateMetaInput {
    pub document_id: i64,
    pub activity_id: Option<Option<i64>>,
    pub base_name: Option<String>,
    pub is_starred: Option<bool>,
    pub tag_ids: Option<Vec<i64>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRelocateInput {
    pub document_id: i64,
    pub new_source_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentListVersionsInput {
    pub document_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentAddVersionInput {
    pub document_id: i64,
    pub source_path: String,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderProfileUpsertInput {
    pub id: Option<i64>,
    pub name: String,
    pub provider_family: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub default_model: String,
    pub supports_text: bool,
    pub supports_image: bool,
    pub supports_file: bool,
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderProfileDeleteInput {
    pub profile_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProfileTestInput {
    pub id: Option<i64>,
    pub name: String,
    pub provider_family: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub default_model: String,
    pub supports_text: bool,
    pub supports_image: bool,
    pub supports_file: bool,
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilityBindingUpsertInput {
    pub capability: String,
    pub use_default: bool,
    pub profile_id: Option<i64>,
    pub model: Option<String>,
}

pub type RichTextStyleUpsertInput = RichTextStyleSettings;
