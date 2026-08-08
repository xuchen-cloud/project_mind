use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub status: String,
    pub root_path: String,
    #[serde(rename = "quickNote")]
    pub summary: String,
    #[serde(rename = "quickNoteMarkdown")]
    pub summary_markdown: String,
    #[serde(rename = "quickNoteHtml")]
    pub summary_html: String,
    #[serde(rename = "quickNoteCodeLanguage")]
    pub summary_code_language: Option<String>,
    pub is_archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListItem {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub status: String,
    pub root_path: String,
    #[serde(rename = "quickNote")]
    pub summary: String,
    #[serde(rename = "quickNoteMarkdown")]
    pub summary_markdown: String,
    #[serde(rename = "quickNoteHtml")]
    pub summary_html: String,
    #[serde(rename = "quickNoteCodeLanguage")]
    pub summary_code_language: Option<String>,
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
    pub activity_id: Option<i64>,
    pub title: Option<String>,
    pub content_markdown: String,
    pub content_html: String,
    pub default_code_language: Option<String>,
    pub tags: Vec<DocumentTagRecord>,
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
    pub is_pinned: bool,
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
    pub due_date: Option<String>,
    pub status: String,
    pub completed_at: Option<String>,
    pub order_index: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoScope {
    Workspace,
    Project,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoRecord {
    pub id: i64,
    pub scope: TodoScope,
    pub project_id: Option<i64>,
    pub project_name: Option<String>,
    pub activity_id: Option<i64>,
    pub source_activity_title: Option<String>,
    pub content: String,
    pub status: String,
    pub priority: String,
    pub due_date: Option<String>,
    pub tags: Vec<DocumentTagRecord>,
    pub created_at: String,
    pub updated_at: String,
    pub progresses: Vec<TodoProgressRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub id: i64,
    pub title: Option<String>,
    pub content_markdown: String,
    pub content_html: String,
    pub default_code_language: Option<String>,
    pub tags: Vec<DocumentTagRecord>,
    pub created_at: String,
    pub updated_at: String,
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
pub struct FileTagSettingsSnapshot {
    pub tags: Vec<FileTagRecord>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTagSettingsGetInput {
    pub project_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecordGroup {
    pub group_key: String,
    pub group_title: String,
    pub notes: Vec<NoteRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactRecord {
    pub id: i64,
    pub name: String,
    pub pinyin_full: String,
    pub pinyin_abbr: String,
    pub email: String,
    pub employee_id: String,
    pub role: String,
    pub department: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiEditorSkillActionRecord {
    pub id: i64,
    pub label: String,
    pub prompt: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiEditorSkillRecord {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub prompt: String,
    pub result_mode: String,
    pub show_in_text_menu: bool,
    #[serde(default)]
    pub show_in_image_menu: bool,
    #[serde(default)]
    pub profile_id: Option<i64>,
    pub sort_order: i64,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsSnapshot {
    pub profiles: Vec<AiProviderProfileRecord>,
    pub bindings: Vec<AiCapabilityBindingRecord>,
    pub has_usable_default: bool,
    pub has_usable_image_default: bool,
    pub security_mode: String,
    pub ai_secrets_unlocked: bool,
    pub execution: AiExecutionSettings,
    pub editor_skills: Vec<AiEditorSkillRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub root_path: String,
    pub metadata_path: String,
    pub display_name: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatusSnapshot {
    pub current_workspace: Option<WorkspaceSummary>,
    pub recent_workspaces: Vec<WorkspaceSummary>,
    pub ai_secrets_unlocked: bool,
    pub security_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiArtifactSection {
    pub title: String,
    pub items: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiArtifactPayload {
    pub overview: String,
    pub sections: Vec<AiArtifactSection>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiArtifactCitationRecord {
    pub id: i64,
    pub artifact_id: i64,
    pub source_kind: String,
    pub source_id: i64,
    pub project_id: Option<i64>,
    pub activity_id: Option<i64>,
    pub label: String,
    pub excerpt: String,
    pub order_index: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiArtifactRecord {
    pub id: i64,
    pub kind: String,
    pub skill_key: String,
    pub skill_version: String,
    pub project_id: Option<i64>,
    pub activity_id: Option<i64>,
    pub artifact_date: Option<String>,
    pub status: String,
    pub markdown: String,
    pub json_payload: Value,
    pub source_updated_at: String,
    pub generated_at: Option<String>,
    pub error_message: Option<String>,
    pub citations: Vec<AiArtifactCitationRecord>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AiAnswerScope {
    Workspace,
    Project,
    Activity,
}

impl AiAnswerScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::Project => "project",
            Self::Activity => "activity",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAnswerCitationRecord {
    pub ref_code: String,
    pub source_kind: String,
    pub source_id: i64,
    pub project_id: Option<i64>,
    pub activity_id: Option<i64>,
    pub label: String,
    pub excerpt: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAnswerResult {
    pub answer_markdown: String,
    pub citations: Vec<AiAnswerCitationRecord>,
    pub scope: AiAnswerScope,
    pub generated_at: String,
    pub skill_key: String,
    pub skill_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditorSkillContext {
    pub scope: String,
    pub project_id: Option<i64>,
    pub activity_id: Option<i64>,
    pub note_id: Option<i64>,
    pub workspace_record_id: Option<i64>,
    pub source_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditorImageTarget {
    pub path: String,
    pub mime_type: String,
    pub signature: String,
    pub annotation_state: Option<String>,
    pub before_markdown: Option<String>,
    pub after_markdown: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditorSkillResult {
    pub skill_id: Option<String>,
    pub result_mode: String,
    pub content: String,
    pub replacement_markdown: Option<String>,
    pub answer_markdown: Option<String>,
    pub resolved_model: Option<String>,
    pub resolved_profile_name: Option<String>,
    pub used_default_fallback: bool,
    pub parse_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AiJobKind {
    ProfileTest,
    #[serde(rename = "editor_skill", alias = "editor_rewrite")]
    EditorSkill,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AiJobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl AiJobStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiExecutionSettings {
    pub max_concurrency: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiFeatureSettings {
    pub master_enabled: bool,
    pub capabilities: BTreeMap<String, bool>,
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AiJobResult {
    ProfileTest {
        #[serde(rename = "testResult")]
        test_result: AiProfileTestResult,
    },
    #[serde(rename = "editor_skill")]
    EditorSkill { rewrite: AiEditorSkillResult },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiJobSnapshot {
    pub id: i64,
    pub kind: AiJobKind,
    pub target_key: String,
    pub status: AiJobStatus,
    pub queued_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub error_message: Option<String>,
    pub stream_text: Option<String>,
    pub result: Option<AiJobResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RichTextFontSelection {
    pub source: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RichTextStyleBlockSettings {
    pub font_family: RichTextFontSelection,
    pub font_size_px: i64,
    pub line_height: f64,
    pub paragraph_spacing_before_px: i64,
    pub paragraph_spacing_after_px: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RichTextHeadingStyleSettings {
    pub font_family: RichTextFontSelection,
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
    pub brief_markdown: String,
    pub brief_html: String,
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
pub struct ProjectPageData {
    pub project: ProjectRecord,
    pub activity_feed: Vec<ActivityDigest>,
    pub project_documents: Vec<DocumentRecord>,
    pub conclusion_groups: Vec<ConclusionGroup>,
    pub record_groups: Vec<ProjectRecordGroup>,
    pub records: Vec<NoteRecord>,
    pub unfinished_todos: Vec<TodoRecord>,
    pub finished_todos: Vec<TodoRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePageData {
    pub quick_note: Option<WorkspaceRecord>,
    pub records: Vec<WorkspaceRecord>,
    pub unfinished_todos: Vec<TodoRecord>,
    pub finished_todos: Vec<TodoRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalReferenceSearchResult {
    pub kind: String,
    pub id: i64,
    pub label: String,
    pub scope: TodoScope,
    pub project_id: Option<i64>,
    pub activity_id: Option<i64>,
    pub subtitle: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalReferenceResolveResult {
    pub kind: String,
    pub id: i64,
    pub label: String,
    pub scope: TodoScope,
    pub project_id: Option<i64>,
    pub activity_id: Option<i64>,
    pub route: String,
    pub focus_id: Option<String>,
    pub managed_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchResult {
    pub kind: String,
    pub id: i64,
    pub scope: Option<String>,
    pub project_id: Option<i64>,
    pub activity_id: Option<i64>,
    pub source: Option<String>,
    pub title: String,
    pub subtitle: String,
    pub matched_text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreateInput {
    pub name: String,
    #[serde(rename = "quickNote", alias = "summary")]
    pub summary: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCreateInput {
    pub root_path: String,
    pub password: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOpenInput {
    pub root_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUnlockInput {
    pub password: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUpdateInput {
    pub project_id: i64,
    pub name: Option<String>,
    #[serde(rename = "quickNote", alias = "summary")]
    pub summary: String,
    #[serde(rename = "quickNoteMarkdown", alias = "summaryMarkdown")]
    pub summary_markdown: Option<String>,
    #[serde(rename = "quickNoteHtml", alias = "summaryHtml")]
    pub summary_html: Option<String>,
    #[serde(rename = "quickNoteCodeLanguage", alias = "summaryCodeLanguage")]
    pub summary_code_language: Option<String>,
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
    pub project_id: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalReferenceSearchInput {
    pub query: String,
    pub project_id: Option<i64>,
    pub scope: String,
    pub limit: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalReferenceResolveInput {
    pub kind: String,
    pub id: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectArchiveInput {
    pub project_id: i64,
    pub is_archived: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDeleteInput {
    pub project_id: i64,
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
    pub brief_markdown: Option<String>,
    pub brief_html: Option<String>,
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
pub struct FileTagOptionUpsertInput {
    pub project_id: Option<i64>,
    pub id: Option<i64>,
    pub label: String,
    pub color_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTagOptionDeleteInput {
    pub project_id: Option<i64>,
    pub tag_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactUpsertInput {
    pub id: Option<i64>,
    pub name: String,
    pub pinyin_full: Option<String>,
    pub pinyin_abbr: Option<String>,
    pub email: Option<String>,
    pub employee_id: Option<String>,
    pub role: Option<String>,
    pub department: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactSearchInput {
    pub query: String,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactDeleteInput {
    pub contact_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecordUpsertInput {
    pub project_id: i64,
    pub activity_id: Option<i64>,
    pub note_id: Option<i64>,
    pub title: Option<String>,
    pub markdown: String,
    pub html: String,
    pub default_code_language: Option<String>,
    #[serde(default)]
    pub tag_ids: Vec<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecordDeleteInput {
    pub note_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecordUpsertInput {
    pub note_id: Option<i64>,
    pub title: Option<String>,
    pub markdown: String,
    pub html: String,
    pub default_code_language: Option<String>,
    #[serde(default)]
    pub tag_ids: Vec<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceQuickNoteUpsertInput {
    pub markdown: String,
    pub html: String,
    pub default_code_language: Option<String>,
    #[serde(default)]
    pub tag_ids: Vec<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecordDeleteInput {
    pub note_id: i64,
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
    pub is_pinned: Option<bool>,
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
    pub is_pinned: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConclusionDeleteInput {
    pub conclusion_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoCreateInput {
    pub scope: TodoScope,
    pub project_id: Option<i64>,
    pub activity_id: Option<i64>,
    pub content: String,
    pub priority: String,
    pub due_date: Option<String>,
    #[serde(default)]
    pub tag_ids: Vec<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoUpdateContentInput {
    pub todo_id: i64,
    pub content: String,
    pub due_date: Option<String>,
    #[serde(default)]
    pub tag_ids: Vec<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoUpdateTagsInput {
    pub todo_id: i64,
    #[serde(default)]
    pub tag_ids: Vec<i64>,
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
    pub due_date: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoUpdateProgressInput {
    pub progress_id: i64,
    pub content: String,
    pub progress_date: String,
    pub due_date: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoDeleteProgressInput {
    pub progress_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoDeleteInput {
    pub todo_id: i64,
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
pub struct DocumentImportClipboardImageInput {
    pub project_id: i64,
    pub activity_id: Option<i64>,
    pub file_name: String,
    pub mime_type: String,
    pub data_base64: String,
    pub is_starred: bool,
    pub tag_ids: Option<Vec<i64>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentImportNoteImageInput {
    pub project_id: i64,
    pub activity_id: Option<i64>,
    pub source_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentImportClipboardNoteImageInput {
    pub project_id: i64,
    pub activity_id: Option<i64>,
    pub file_name: String,
    pub mime_type: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceNoteImageImportInput {
    pub source_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceClipboardNoteImageImportInput {
    pub file_name: String,
    pub mime_type: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceNoteImageAsset {
    pub title: String,
    pub path: String,
    pub mime_type: String,
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
    pub source_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDeleteInput {
    pub document_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditorSkillInput {
    pub skill_id: Option<String>,
    pub skill_name: Option<String>,
    pub prompt: Option<String>,
    #[serde(default = "default_ai_editor_skill_result_mode")]
    pub result_mode: String,
    pub action_id: Option<i64>,
    pub prompt_override: Option<String>,
    #[serde(default)]
    pub selected_text: String,
    pub expanded_markdown: Option<String>,
    #[serde(default)]
    pub placeholder_tokens: Vec<String>,
    pub document_context: Option<String>,
    pub context: Option<AiEditorSkillContext>,
    #[serde(default)]
    pub target_type: Option<String>,
    pub image_target: Option<AiEditorImageTarget>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiArtifactGetInput {
    pub kind: String,
    pub project_id: Option<i64>,
    pub activity_id: Option<i64>,
    pub artifact_date: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAnswerQuestionInput {
    pub scope: AiAnswerScope,
    pub question: String,
    pub project_id: Option<i64>,
    pub activity_id: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AiJobEnqueueInput {
    ProfileTest {
        #[serde(rename = "targetKey", alias = "target_key")]
        target_key: String,
        input: AiProfileTestInput,
    },
    #[serde(rename = "editor_skill", alias = "editor_rewrite")]
    EditorSkill {
        #[serde(rename = "targetKey", alias = "target_key")]
        target_key: String,
        input: AiEditorSkillInput,
    },
}

impl AiJobEnqueueInput {
    pub fn kind(&self) -> AiJobKind {
        match self {
            Self::ProfileTest { .. } => AiJobKind::ProfileTest,
            Self::EditorSkill { .. } => AiJobKind::EditorSkill,
        }
    }

    pub fn target_key(&self) -> &str {
        match self {
            Self::ProfileTest { target_key, .. } | Self::EditorSkill { target_key, .. } => {
                target_key
            }
        }
    }
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
    #[serde(default)]
    pub test_image: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilityBindingUpsertInput {
    pub capability: String,
    pub use_default: bool,
    pub profile_id: Option<i64>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditorSkillActionUpsertInput {
    pub id: Option<i64>,
    pub label: String,
    pub prompt: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditorSkillActionDeleteInput {
    pub action_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditorSkillUpsertInput {
    pub id: Option<String>,
    pub name: String,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub prompt: String,
    pub result_mode: String,
    pub show_in_text_menu: bool,
    #[serde(default)]
    pub show_in_image_menu: bool,
    pub profile_id: Option<i64>,
    pub sort_order: Option<i64>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditorSkillDeleteInput {
    pub skill_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditorSkillReorderInput {
    pub skill_ids: Vec<String>,
}

pub type RichTextStyleUpsertInput = RichTextStyleSettings;

fn default_ai_editor_skill_result_mode() -> String {
    "modify".to_string()
}

#[cfg(test)]
mod tests {
    use super::AiJobEnqueueInput;
    use serde_json::json;

    #[test]
    fn ai_job_enqueue_input_accepts_camel_case_target_key() {
        let input: AiJobEnqueueInput = serde_json::from_value(json!({
            "kind": "editor_rewrite",
            "targetKey": "editor-rewrite:test",
            "input": {
                "selectedText": "hello",
                "expandedMarkdown": "hello",
                "placeholderTokens": [],
                "promptOverride": "请润色"
            }
        }))
        .expect("camelCase ai job payload should deserialize");

        match input {
            AiJobEnqueueInput::EditorSkill { target_key, input } => {
                assert_eq!(target_key, "editor-rewrite:test");
                assert_eq!(input.selected_text, "hello");
                assert_eq!(input.expanded_markdown.as_deref(), Some("hello"));
                assert_eq!(input.prompt_override.as_deref(), Some("请润色"));
                assert_eq!(input.result_mode, "modify");
            }
            other => panic!("expected answer question payload, got {other:?}"),
        }
    }
}
