use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{Local, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::{
    ai_provider::{self, ResolvedAiProfile},
    models::{
        AcceptedSuggestionResult, ActivityAttributeOption, ActivityAttributeOptionUpsertInput,
        ActivityCardData, ActivityCreateInput, ActivityDeleteInput, ActivityDigest,
        ActivityOptionDeleteInput, ActivitySettingsSnapshot, ActivityStatusOption,
        ActivityStatusOptionUpsertInput, ActivityUpdateMetaInput, AiAcceptSuggestionInput,
        AiAnswerCitationRecord, AiEditorRewriteActionDeleteInput,
        AiEditorRewriteActionRecord, AiEditorRewriteActionUpsertInput,
        AiEditorRewriteInput, AiEditorRewriteResult,
        AiAnswerQuestionInput, AiAnswerResult, AiAnswerScope, AiArtifactCitationRecord,
        AiArtifactGetInput, AiArtifactPayload, AiArtifactRecord, AiCapabilityBindingRecord,
        AiCapabilityBindingUpsertInput, AiExecutionSettings, AiFeatureSettings, AiGenerateInput,
        AiJobEnqueueInput, AiJobResult, AiProfileTestInput, AiProfileTestResult,
        AiProviderProfileDeleteInput, AiProviderProfileRecord, AiProviderProfileUpsertInput,
        AiSettingsSnapshot, AiSuggestionRecord, ConclusionCreateInput, ConclusionDeleteInput,
        ConclusionGroup, ConclusionListInput, ConclusionRecord, ConclusionUpdateInput,
        DocumentAddVersionInput, DocumentDeleteInput, DocumentImportClipboardImageInput,
        DocumentImportClipboardNoteImageInput, DocumentImportInput, DocumentImportNoteImageInput,
        DocumentListVersionsInput, DocumentRecord, DocumentRelocateInput, DocumentTagRecord,
        DocumentUpdateMetaInput, DocumentVersionRecord, FileTagOptionDeleteInput,
        FileTagOptionUpsertInput, FileTagRecord, FileTagSettingsSnapshot,
        InternalReferenceResolveInput, InternalReferenceResolveResult,
        InternalReferenceSearchInput, InternalReferenceSearchResult, NoteDeleteInput, NoteRecord,
        NoteUpsertInput, ProjectArchiveInput, ProjectCreateInput, ProjectDashboard, ProjectIdInput,
        ProjectListItem, ProjectOverviewData, ProjectRecord, ProjectUpdateSummaryInput,
        ProjectsListInput, RecordTypeOptionDeleteInput, RecordTypeOptionUpsertInput,
        RecordTypeRecord, RecordTypeSettingsSnapshot, RichTextFontSelection,
        RichTextStyleBlockSettings, RichTextStyleSettings, RichTextStyleUpsertInput,
        TodoAddProgressInput, TodoCreateInput, TodoDeleteInput, TodoDeleteProgressInput,
        TodoProgressRecord, TodoRecord, TodoUpdateActivityInput, TodoUpdateContentInput,
        TodoUpdatePriorityInput, TodoUpdateProgressInput, TodoUpdateStatusInput,
        TodayQuickNoteUpsertInput, WorkspaceNoteDeleteInput, WorkspaceNoteRecord,
        WorkspaceNoteUpsertInput, WorkspaceSearchInput, WorkspaceSearchResult,
    },
    secret_crypto,
    workspace::{WORKSPACE_HIDDEN_DIR_NAME, WORKSPACE_SECURITY_MODE},
};

const TODO_SCHEMA_VERSION: i64 = 2;
const FILE_LAYOUT_SCHEMA_VERSION: i64 = 3;
const DOCUMENT_SCHEMA_VERSION: i64 = 4;
const ACTIVITY_SETTINGS_SCHEMA_VERSION: i64 = 5;
const FILE_TAG_SCHEMA_VERSION: i64 = 6;
const ACTIVITY_ATTRIBUTE_COLOR_SCHEMA_VERSION: i64 = 7;
const ACTIVITY_STATUS_COLOR_SCHEMA_VERSION: i64 = 8;
const RECORD_TYPE_SCHEMA_VERSION: i64 = 8;
const AI_CAPABILITIES: [&str; 5] = [
    "default",
    "assistant",
    "summary",
    "suggestion_generation",
    "editor_rewrite",
];
const AI_VISIBLE_CAPABILITIES: [&str; 4] = [
    "assistant",
    "summary",
    "suggestion_generation",
    "editor_rewrite",
];
const AI_FEATURE_KEYS: [&str; 5] = [
    "summary.activity_summary",
    "summary.project_brief",
    "summary.daily_brief",
    "suggestion_generation.conclusion",
    "suggestion_generation.todo",
];
const RICH_TEXT_FONT_PRESETS: [&str; 4] = [
    "workspace_sans",
    "work_sans",
    "noto_sans_sc",
    "source_serif",
];
const FILE_TAG_COLOR_KEYS: [&str; 8] = [
    "slate", "blue", "teal", "green", "amber", "orange", "red", "rose",
];
const WINDOWS_RESERVED_PATH_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];
const APP_SETTING_KEY_RICH_TEXT_STYLE: &str = "rich_text_style";
const APP_SETTING_KEY_AI_EXECUTION_SETTINGS: &str = "ai_execution_settings";
const APP_SETTING_KEY_AI_FEATURE_SETTINGS: &str = "ai_feature_settings";
const APP_SETTING_KEY_AI_EDITOR_REWRITE_ACTIONS: &str = "ai_editor_rewrite_actions";
const MANAGED_NOTE_IMAGE_STORAGE_MODE: &str = "managed_note_image";
const PROJECT_NOTE_ASSET_DIR_NAME: &str = "embedded-note-assets";
const DEFAULT_RECORD_TYPE_KEY: &str = "quick_note";
const DEFAULT_RECORD_TYPE_LABEL: &str = "原始记录";
const DEFAULT_RECORD_TYPE_COLOR_KEY: &str = "slate";
const DEFAULT_RECORD_TYPE_TEMPLATE_HTML: &str = "<p></p>";
const TODO_PRIORITY_URGENCY_KEYWORDS: [&str; 19] = [
    "今天",
    "今日",
    "当天",
    "明天",
    "本周",
    "周内",
    "周五前",
    "尽快",
    "尽早",
    "立即",
    "马上",
    "立刻",
    "紧急",
    "加急",
    "asap",
    "urgent",
    "immediately",
    "today",
    "tomorrow",
];
const TODO_PRIORITY_IMPORTANCE_KEYWORDS: [&str; 20] = [
    "预算", "合同", "法务", "审批", "客户", "上线", "发布", "交付", "回款", "付款", "风险", "合规",
    "方案", "决策", "评审", "blocking", "blocker", "launch", "release", "legal",
];
const MEETING_RECORD_TYPE_KEY: &str = "meeting_minutes";
const MEETING_RECORD_TYPE_LABEL: &str = "会议记录";
const MEETING_RECORD_TYPE_COLOR_KEY: &str = "blue";
const MEETING_RECORD_TYPE_TEMPLATE_HTML: &str =
    "<h2>背景</h2><p></p><h2>讨论要点</h2><p></p><h2>初步结论</h2><p></p><h2>行动项</h2><p></p>";
const SYSTEM_ACTIVITY_STATUS_PENDING: &str = "pending";
const INTERNAL_REFERENCE_PRIORITY_NOTE_TITLE: u8 = 0;
const INTERNAL_REFERENCE_PRIORITY_CONCLUSION_CONTENT: u8 = 1;
const INTERNAL_REFERENCE_PRIORITY_TODO_CONTENT: u8 = 2;
const INTERNAL_REFERENCE_PRIORITY_DOCUMENT_NAME: u8 = 3;
const INTERNAL_REFERENCE_PRIORITY_NOTE_CONTENT: u8 = 4;
const INTERNAL_REFERENCE_PRIORITY_ACTIVITY_TITLE: u8 = 5;
const INTERNAL_REFERENCE_COMPACT_LABEL_MAX_CHARS: usize = 15;
const WORKSPACE_SEARCH_PRIORITY_PROJECT_NAME: u8 = 0;
const WORKSPACE_SEARCH_PRIORITY_ACTIVITY_TITLE: u8 = 1;
const WORKSPACE_SEARCH_PRIORITY_NOTE_TITLE: u8 = 2;
const WORKSPACE_SEARCH_PRIORITY_CONCLUSION_CONTENT: u8 = 3;
const WORKSPACE_SEARCH_PRIORITY_TODO_CONTENT: u8 = 4;
const WORKSPACE_SEARCH_PRIORITY_DOCUMENT_NAME: u8 = 5;
const WORKSPACE_SEARCH_PRIORITY_NOTE_CONTENT: u8 = 6;
const WORKSPACE_SEARCH_PRIORITY_ACTIVITY_META: u8 = 7;
const WORKSPACE_SEARCH_PRIORITY_PROJECT_SUMMARY: u8 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InternalReferenceFilterKind {
    Note,
    Conclusion,
    Todo,
    Document,
}

impl InternalReferenceFilterKind {
    fn matches_result_kind(self, kind: &str) -> bool {
        matches!(
            (self, kind),
            (Self::Note, "note")
                | (Self::Conclusion, "conclusion")
                | (Self::Todo, "todo")
                | (Self::Document, "document")
        )
    }
}

#[derive(Debug, Clone)]
struct ParsedInternalReferenceSearchQuery {
    kind_filter: Option<InternalReferenceFilterKind>,
    query: String,
}

#[derive(Debug, Clone)]
struct InternalReferenceSearchField {
    priority: u8,
    text: String,
}

#[derive(Debug, Clone)]
struct InternalReferenceSearchCandidate {
    result: InternalReferenceSearchResult,
    fields: Vec<InternalReferenceSearchField>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum InternalReferenceMatchKind {
    Exact,
    Prefix,
    Contains,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct InternalReferenceSearchRank {
    field_priority: u8,
    match_kind: InternalReferenceMatchKind,
}

#[derive(Debug, Clone)]
struct WorkspaceSearchField {
    priority: u8,
    text: String,
}

#[derive(Debug, Clone)]
struct WorkspaceSearchCandidate {
    result: WorkspaceSearchResult,
    fields: Vec<WorkspaceSearchField>,
    updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct WorkspaceSearchRank {
    field_priority: u8,
    match_kind: InternalReferenceMatchKind,
}
const SYSTEM_ACTIVITY_STATUS_PENDING_LABEL: &str = "待启动";
const UNTITLED_ACTIVITY_PREFIX: &str = "未命名 Activity";
const LEGACY_ACTIVITY_STATUS_REVIEW_LABEL: &str = "待复核";
const LEGACY_ACTIVITY_STATUS_ORGANIZED_LABEL: &str = "已整理";
const DEFAULT_ACTIVITY_ATTRIBUTE_COLOR_KEY: &str = "slate";
const DEFAULT_ACTIVITY_STATUS_COLOR_KEY: &str = "amber";
const LEGACY_ACTIVITY_STATUS_REVIEW_COLOR_KEY: &str = "orange";
const LEGACY_ACTIVITY_STATUS_ORGANIZED_COLOR_KEY: &str = "green";
const AI_ARTIFACT_STATUS_FRESH: &str = "fresh";
const AI_ARTIFACT_STATUS_STALE: &str = "stale";
const AI_ARTIFACT_STATUS_ERROR: &str = "error";
const WORKSPACE_NOTE_KIND_STANDARD: &str = "workspace_note";
const WORKSPACE_NOTE_KIND_TODAY_QUICK: &str = "today_quick_note";
const WORKSPACE_PATH_PREFIX: &str = "workspace:";
const ABSOLUTE_PATH_PREFIX: &str = "absolute:";
const ACTIVITY_SUMMARY_SECTIONS: [&str; 3] = ["关键结论", "未决问题 / 风险", "下一步建议"];
const PROJECT_BRIEF_SECTIONS: [&str; 4] = ["最近变化", "关键决策", "阻塞", "建议下一步"];
const DAILY_BRIEF_SECTIONS: [&str; 3] = ["优先做的 3 件事", "等待 / 阻塞项", "建议跟进行动"];

pub struct Database {
    conn: Connection,
    workspace_root: PathBuf,
    secret_password: Option<String>,
}

struct AiProfileStorage {
    id: i64,
    name: String,
    provider_family: String,
    base_url: String,
    api_key_ciphertext: String,
    api_key_nonce: String,
    api_key_salt: String,
    api_key_last4: String,
    default_model: String,
    supports_text: bool,
    supports_image: bool,
    supports_file: bool,
    enabled: bool,
    created_at: String,
    updated_at: String,
}

struct ActivityFsRecord {
    project_id: i64,
    attribute_option_id: Option<i64>,
    title: String,
    brief_markdown: String,
    brief_html: String,
    activity_time: String,
    status_option_id: Option<i64>,
    is_pinned: bool,
    is_expanded: bool,
    folder_name: String,
}

struct RecordTypeStorage {
    id: i64,
    key: String,
    label: String,
    color_key: String,
    template_html: String,
    is_default: bool,
    created_at: String,
    updated_at: String,
}

struct ArtifactSkillSpec {
    kind: &'static str,
    skill_key: &'static str,
    skill_version: &'static str,
    artifact_name: &'static str,
    section_titles: &'static [&'static str],
}

struct AskSkillSpec {
    skill_key: &'static str,
    skill_version: &'static str,
}

const ACTIVITY_SUMMARY_SKILL: ArtifactSkillSpec = ArtifactSkillSpec {
    kind: "activity_summary",
    skill_key: "builtin.activity_summary",
    skill_version: "1.0.0",
    artifact_name: "Activity Summary",
    section_titles: &ACTIVITY_SUMMARY_SECTIONS,
};

const PROJECT_BRIEF_SKILL: ArtifactSkillSpec = ArtifactSkillSpec {
    kind: "project_brief",
    skill_key: "builtin.project_brief",
    skill_version: "1.0.0",
    artifact_name: "Project Brief",
    section_titles: &PROJECT_BRIEF_SECTIONS,
};

const DAILY_BRIEF_SKILL: ArtifactSkillSpec = ArtifactSkillSpec {
    kind: "daily_brief",
    skill_key: "builtin.daily_brief",
    skill_version: "1.0.0",
    artifact_name: "Daily Brief",
    section_titles: &DAILY_BRIEF_SECTIONS,
};

const ASK_SKILL: AskSkillSpec = AskSkillSpec {
    skill_key: "builtin.ask",
    skill_version: "1.0.0",
};

#[derive(Clone)]
struct ArtifactSource {
    ref_code: String,
    source_kind: String,
    source_id: i64,
    project_id: Option<i64>,
    activity_id: Option<i64>,
    label: String,
    excerpt: String,
}

struct ArtifactGenerationContext {
    project_id: Option<i64>,
    activity_id: Option<i64>,
    artifact_date: Option<String>,
    source_updated_at: String,
    context_text: String,
    sources: Vec<ArtifactSource>,
}

#[derive(Clone)]
struct AskSource {
    ref_code: String,
    source_kind: String,
    source_id: i64,
    project_id: Option<i64>,
    activity_id: Option<i64>,
    label: String,
    excerpt: String,
    body_text: String,
    updated_at: String,
}

struct ResolvedArtifactRequest {
    spec: &'static ArtifactSkillSpec,
    project_id: Option<i64>,
    activity_id: Option<i64>,
    artifact_date: Option<String>,
}

struct ResolvedAskRequest {
    scope: AiAnswerScope,
    question: String,
    project_id: Option<i64>,
    activity_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DemoSeedResult {
    pub workspace_root: String,
    pub project_count: i64,
    pub activity_count: i64,
    pub note_count: i64,
    pub conclusion_count: i64,
    pub todo_count: i64,
    pub document_count: i64,
    pub artifact_count: i64,
    pub ai_profile_mode: String,
}

struct DemoSeedCatalog {
    attribute_ids: HashMap<String, i64>,
    status_ids: HashMap<String, i64>,
    tag_ids: HashMap<String, i64>,
    record_type_keys: HashMap<String, String>,
}

impl DemoSeedCatalog {
    fn attribute_id(&self, label: &str) -> Result<i64> {
        self.attribute_ids
            .get(label)
            .copied()
            .ok_or_else(|| anyhow!("missing demo activity attribute: {label}"))
    }

    fn status_id(&self, label: &str) -> Result<i64> {
        self.status_ids
            .get(label)
            .copied()
            .ok_or_else(|| anyhow!("missing demo activity status: {label}"))
    }

    fn tag_id(&self, label: &str) -> Result<i64> {
        self.tag_ids
            .get(label)
            .copied()
            .ok_or_else(|| anyhow!("missing demo file tag: {label}"))
    }

    fn note_type_key(&self, label: &str) -> Result<&str> {
        self.record_type_keys
            .get(label)
            .map(String::as_str)
            .ok_or_else(|| anyhow!("missing demo record type: {label}"))
    }
}

struct SeededProjectRefs {
    project_id: i64,
    activity_ids: Vec<i64>,
}

impl Database {
    pub fn open(
        db_path: &Path,
        workspace_root: &Path,
        secret_password: Option<String>,
    ) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!("failed to create app data dir at {}", parent.display())
            })?;
        }

        let conn = Connection::open(db_path)
            .with_context(|| format!("failed to open sqlite at {}", db_path.display()))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let mut db = Self {
            conn,
            workspace_root: workspace_root.to_path_buf(),
            secret_password,
        };
        db.migrate()?;
        Ok(db)
    }

    pub fn migrate(&mut self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS projects (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'active',
              root_path TEXT NOT NULL,
              summary TEXT NOT NULL DEFAULT '',
              summary_markdown TEXT NOT NULL DEFAULT '',
              summary_html TEXT NOT NULL DEFAULT '',
              is_archived INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS activity_attribute_options (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              label TEXT NOT NULL UNIQUE COLLATE NOCASE,
              color_key TEXT NOT NULL DEFAULT 'slate',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS activity_status_options (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              system_key TEXT UNIQUE,
              label TEXT NOT NULL UNIQUE COLLATE NOCASE,
              color_key TEXT NOT NULL DEFAULT 'amber',
              needs_attention INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS activities (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_id INTEGER NOT NULL,
              category TEXT NOT NULL,
              attribute_option_id INTEGER,
              title TEXT NOT NULL DEFAULT '',
              brief_markdown TEXT NOT NULL DEFAULT '',
              brief_html TEXT NOT NULL DEFAULT '',
              folder_name TEXT NOT NULL DEFAULT '',
              activity_time TEXT NOT NULL,
              is_pinned INTEGER NOT NULL DEFAULT 0,
              is_expanded INTEGER NOT NULL DEFAULT 0,
              organize_status TEXT NOT NULL DEFAULT 'needs_review',
              status_option_id INTEGER,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
              FOREIGN KEY(attribute_option_id) REFERENCES activity_attribute_options(id) ON DELETE SET NULL,
              FOREIGN KEY(status_option_id) REFERENCES activity_status_options(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS notes (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_id INTEGER NOT NULL,
              activity_id INTEGER NOT NULL,
              note_type TEXT NOT NULL,
              title TEXT,
              content_markdown TEXT NOT NULL DEFAULT '',
              content_html TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
              FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS workspace_notes (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              note_kind TEXT NOT NULL DEFAULT 'workspace_note',
              title TEXT,
              content_markdown TEXT NOT NULL DEFAULT '',
              content_html TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS conclusions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_id INTEGER NOT NULL,
              activity_id INTEGER,
              note_id INTEGER,
              content_markdown TEXT NOT NULL DEFAULT '',
              content_html TEXT NOT NULL DEFAULT '',
              content TEXT NOT NULL,
              promoted_to_project INTEGER NOT NULL DEFAULT 0,
              is_pinned INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
              FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE CASCADE,
              FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS todos (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_id INTEGER NOT NULL,
              activity_id INTEGER,
              content TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'unfinished',
              priority TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
              FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS todo_progresses (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              todo_id INTEGER NOT NULL,
              content TEXT NOT NULL,
              progress_date TEXT NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY(todo_id) REFERENCES todos(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS documents (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_id INTEGER NOT NULL,
              activity_id INTEGER,
              name TEXT NOT NULL,
              base_name TEXT NOT NULL DEFAULT '',
              original_path TEXT NOT NULL,
              managed_path TEXT NOT NULL,
              history_dir_path TEXT NOT NULL DEFAULT '',
              storage_mode TEXT NOT NULL,
              mime_type TEXT NOT NULL,
              is_starred INTEGER NOT NULL DEFAULT 0,
              current_version_number INTEGER NOT NULL DEFAULT 1,
              version_count INTEGER NOT NULL DEFAULT 1,
              health TEXT NOT NULL DEFAULT 'normal',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
              FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS document_versions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              document_id INTEGER NOT NULL,
              version_number INTEGER NOT NULL,
              name TEXT NOT NULL,
              source_path TEXT NOT NULL,
              managed_path TEXT NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE,
              UNIQUE(document_id, version_number)
            );

            CREATE TABLE IF NOT EXISTS file_tag_options (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              label TEXT NOT NULL UNIQUE COLLATE NOCASE,
              color_key TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS record_type_options (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              key TEXT NOT NULL UNIQUE,
              label TEXT NOT NULL UNIQUE COLLATE NOCASE,
              color_key TEXT NOT NULL,
              template_html TEXT NOT NULL DEFAULT '<p></p>',
              is_default INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS document_tag_links (
              document_id INTEGER NOT NULL,
              tag_id INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              PRIMARY KEY(document_id, tag_id),
              FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE,
              FOREIGN KEY(tag_id) REFERENCES file_tag_options(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS ai_suggestions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_id INTEGER NOT NULL,
              activity_id INTEGER,
              note_id INTEGER,
              suggestion_type TEXT NOT NULL,
              title TEXT NOT NULL,
              preview TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'pending',
              created_at TEXT NOT NULL,
              accepted_at TEXT,
              FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
              FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE CASCADE,
              FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS ai_provider_profiles (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              provider_family TEXT NOT NULL,
              base_url TEXT NOT NULL,
              api_key_ciphertext TEXT NOT NULL,
              api_key_nonce TEXT NOT NULL,
              api_key_salt TEXT NOT NULL,
              api_key_last4 TEXT NOT NULL DEFAULT '',
              default_model TEXT NOT NULL,
              supports_text INTEGER NOT NULL DEFAULT 1,
              supports_image INTEGER NOT NULL DEFAULT 0,
              supports_file INTEGER NOT NULL DEFAULT 0,
              enabled INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS ai_capability_bindings (
              capability TEXT PRIMARY KEY,
              use_default INTEGER NOT NULL DEFAULT 1,
              profile_id INTEGER,
              model TEXT,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(profile_id) REFERENCES ai_provider_profiles(id) ON DELETE RESTRICT
            );

            CREATE TABLE IF NOT EXISTS ai_artifacts (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              scope_key TEXT NOT NULL UNIQUE,
              kind TEXT NOT NULL,
              skill_key TEXT NOT NULL DEFAULT '',
              skill_version TEXT NOT NULL DEFAULT '',
              project_id INTEGER,
              activity_id INTEGER,
              artifact_date TEXT,
              status TEXT NOT NULL DEFAULT 'stale',
              markdown TEXT NOT NULL DEFAULT '',
              json_payload TEXT NOT NULL DEFAULT '{}',
              source_updated_at TEXT NOT NULL DEFAULT '',
              generated_at TEXT,
              error_message TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS ai_artifact_citations (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              artifact_id INTEGER NOT NULL,
              source_kind TEXT NOT NULL,
              source_id INTEGER NOT NULL,
              project_id INTEGER,
              activity_id INTEGER,
              label TEXT NOT NULL,
              excerpt TEXT NOT NULL DEFAULT '',
              order_index INTEGER NOT NULL DEFAULT 0,
              FOREIGN KEY(artifact_id) REFERENCES ai_artifacts(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS app_settings (
              key TEXT PRIMARY KEY,
              value_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            "#,
        )?;
        self.ensure_column(
            "projects",
            "is_archived",
            "ALTER TABLE projects ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0",
        )?;
        self.ensure_column(
            "projects",
            "summary_markdown",
            "ALTER TABLE projects ADD COLUMN summary_markdown TEXT NOT NULL DEFAULT ''",
        )?;
        self.ensure_column(
            "projects",
            "summary_html",
            "ALTER TABLE projects ADD COLUMN summary_html TEXT NOT NULL DEFAULT ''",
        )?;
        self.ensure_column(
            "workspace_notes",
            "note_kind",
            "ALTER TABLE workspace_notes ADD COLUMN note_kind TEXT NOT NULL DEFAULT 'workspace_note'",
        )?;
        self.ensure_column(
            "activities",
            "folder_name",
            "ALTER TABLE activities ADD COLUMN folder_name TEXT NOT NULL DEFAULT ''",
        )?;
        self.ensure_column(
            "activities",
            "brief_markdown",
            "ALTER TABLE activities ADD COLUMN brief_markdown TEXT NOT NULL DEFAULT ''",
        )?;
        self.ensure_column(
            "activities",
            "brief_html",
            "ALTER TABLE activities ADD COLUMN brief_html TEXT NOT NULL DEFAULT ''",
        )?;
        self.ensure_column(
            "activity_attribute_options",
            "color_key",
            "ALTER TABLE activity_attribute_options ADD COLUMN color_key TEXT NOT NULL DEFAULT 'slate'",
        )?;
        self.ensure_column(
            "activity_status_options",
            "color_key",
            "ALTER TABLE activity_status_options ADD COLUMN color_key TEXT NOT NULL DEFAULT 'amber'",
        )?;
        self.ensure_column(
            "activities",
            "attribute_option_id",
            "ALTER TABLE activities ADD COLUMN attribute_option_id INTEGER REFERENCES activity_attribute_options(id) ON DELETE SET NULL",
        )?;
        self.ensure_column(
            "conclusions",
            "content_markdown",
            "ALTER TABLE conclusions ADD COLUMN content_markdown TEXT NOT NULL DEFAULT ''",
        )?;
        self.ensure_column(
            "conclusions",
            "content_html",
            "ALTER TABLE conclusions ADD COLUMN content_html TEXT NOT NULL DEFAULT ''",
        )?;
        self.ensure_column(
            "conclusions",
            "is_pinned",
            "ALTER TABLE conclusions ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0",
        )?;
        self.ensure_column(
            "documents",
            "base_name",
            "ALTER TABLE documents ADD COLUMN base_name TEXT NOT NULL DEFAULT ''",
        )?;
        self.ensure_column(
            "documents",
            "history_dir_path",
            "ALTER TABLE documents ADD COLUMN history_dir_path TEXT NOT NULL DEFAULT ''",
        )?;
        self.ensure_column(
            "documents",
            "current_version_number",
            "ALTER TABLE documents ADD COLUMN current_version_number INTEGER NOT NULL DEFAULT 1",
        )?;
        self.ensure_column(
            "documents",
            "version_count",
            "ALTER TABLE documents ADD COLUMN version_count INTEGER NOT NULL DEFAULT 1",
        )?;
        self.ensure_column(
            "activities",
            "status_option_id",
            "ALTER TABLE activities ADD COLUMN status_option_id INTEGER REFERENCES activity_status_options(id) ON DELETE SET NULL",
        )?;
        self.conn.execute(
            "UPDATE activities SET organize_status = 'needs_review' WHERE organize_status = 'unorganized'",
            [],
        )?;
        self.conn.execute(
            r#"
            UPDATE conclusions
            SET content_markdown = content
            WHERE TRIM(COALESCE(content_markdown, '')) = ''
              AND TRIM(COALESCE(content, '')) <> ''
            "#,
            [],
        )?;
        self.conn.execute(
            r#"
            UPDATE projects
            SET summary_markdown = summary
            WHERE TRIM(COALESCE(summary_markdown, '')) = ''
              AND TRIM(COALESCE(summary, '')) <> ''
            "#,
            [],
        )?;
        self.backfill_project_summary_html()?;
        if self.schema_version()? < TODO_SCHEMA_VERSION {
            self.rebuild_todo_schema()?;
            self.set_schema_version(TODO_SCHEMA_VERSION)?;
        }
        if self.schema_version()? < FILE_LAYOUT_SCHEMA_VERSION {
            self.set_schema_version(FILE_LAYOUT_SCHEMA_VERSION)?;
        }
        if self.schema_version()? < DOCUMENT_SCHEMA_VERSION {
            self.rebuild_document_schema()?;
            self.set_schema_version(DOCUMENT_SCHEMA_VERSION)?;
        }
        if self.schema_version()? < ACTIVITY_SETTINGS_SCHEMA_VERSION {
            self.migrate_activity_settings_schema()?;
            self.set_schema_version(ACTIVITY_SETTINGS_SCHEMA_VERSION)?;
        } else {
            self.ensure_activity_settings_seeded()?;
        }
        if self.schema_version()? < FILE_TAG_SCHEMA_VERSION {
            self.set_schema_version(FILE_TAG_SCHEMA_VERSION)?;
        }
        if self.schema_version()? < ACTIVITY_ATTRIBUTE_COLOR_SCHEMA_VERSION {
            self.migrate_activity_attribute_color_schema()?;
            self.set_schema_version(ACTIVITY_ATTRIBUTE_COLOR_SCHEMA_VERSION)?;
        }
        if self.schema_version()? < ACTIVITY_STATUS_COLOR_SCHEMA_VERSION {
            self.migrate_activity_status_color_schema()?;
            self.set_schema_version(ACTIVITY_STATUS_COLOR_SCHEMA_VERSION)?;
        }
        if self.schema_version()? < RECORD_TYPE_SCHEMA_VERSION {
            self.migrate_record_type_schema()?;
            self.set_schema_version(RECORD_TYPE_SCHEMA_VERSION)?;
        } else {
            self.ensure_record_type_settings_seeded()?;
        }
        self.conn.execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS idx_projects_archived_updated ON projects(is_archived, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_activities_project_time ON activities(project_id, activity_time DESC);
            CREATE INDEX IF NOT EXISTS idx_activities_project_folder ON activities(project_id, folder_name);
            CREATE INDEX IF NOT EXISTS idx_activities_attribute_option ON activities(attribute_option_id);
            CREATE INDEX IF NOT EXISTS idx_activities_status_option ON activities(status_option_id);
            CREATE INDEX IF NOT EXISTS idx_notes_activity ON notes(activity_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_conclusions_project ON conclusions(project_id, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project_id, status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_todos_activity ON todos(activity_id, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_todo_progresses_todo_date ON todo_progresses(todo_id, progress_date DESC, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_documents_project_activity_base ON documents(project_id, activity_id, base_name);
            CREATE INDEX IF NOT EXISTS idx_documents_project_starred ON documents(project_id, is_starred, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_document_versions_document_version ON document_versions(document_id, version_number DESC);
            CREATE INDEX IF NOT EXISTS idx_file_tag_options_created ON file_tag_options(created_at ASC, id ASC);
            CREATE INDEX IF NOT EXISTS idx_record_type_options_default_created ON record_type_options(is_default DESC, created_at ASC, id ASC);
            CREATE INDEX IF NOT EXISTS idx_document_tag_links_tag ON document_tag_links(tag_id, document_id);
            CREATE INDEX IF NOT EXISTS idx_document_tag_links_document ON document_tag_links(document_id, tag_id);
            CREATE INDEX IF NOT EXISTS idx_ai_suggestions_activity ON ai_suggestions(activity_id, status, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_ai_profiles_enabled ON ai_provider_profiles(enabled, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_ai_artifacts_kind_scope ON ai_artifacts(kind, project_id, activity_id, artifact_date);
            CREATE INDEX IF NOT EXISTS idx_ai_artifacts_status_kind ON ai_artifacts(status, kind, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_ai_artifact_citations_artifact_order ON ai_artifact_citations(artifact_id, order_index ASC, id ASC);
            "#,
        )?;
        Ok(())
    }

    fn encode_path_ref(&self, path: &Path) -> String {
        if let Ok(relative) = path.strip_prefix(&self.workspace_root) {
            let relative = relative.to_string_lossy().replace('\\', "/");
            if relative.is_empty() {
                WORKSPACE_PATH_PREFIX.to_string()
            } else {
                format!("{WORKSPACE_PATH_PREFIX}{relative}")
            }
        } else {
            format!("{ABSOLUTE_PATH_PREFIX}{}", path.to_string_lossy())
        }
    }

    fn decode_path_ref(&self, value: &str) -> PathBuf {
        if let Some(relative) = value.strip_prefix(WORKSPACE_PATH_PREFIX) {
            if relative.is_empty() {
                return self.workspace_root.clone();
            }

            let mut path = self.workspace_root.clone();
            for segment in relative.split('/').filter(|segment| !segment.is_empty()) {
                path.push(segment);
            }
            path
        } else if let Some(absolute) = value.strip_prefix(ABSOLUTE_PATH_PREFIX) {
            PathBuf::from(absolute)
        } else {
            PathBuf::from(value)
        }
    }

    fn decode_path_ref_to_string(&self, value: &str) -> String {
        self.decode_path_ref(value).to_string_lossy().to_string()
    }

    fn require_secret_password(&self) -> Result<&str> {
        self.secret_password
            .as_deref()
            .ok_or_else(|| anyhow!("workspace secrets are locked"))
    }

    fn has_usable_profile_for_capability(&self, capability: &str) -> Result<bool> {
        let default_binding = self.ai_binding_record("default")?;
        let binding = if capability == "default" {
            default_binding.clone()
        } else {
            self.ai_binding_record(capability)?
        };

        let effective_binding = if capability != "default" && binding.use_default {
            default_binding
        } else {
            binding
        };

        let Some(profile_id) = effective_binding.profile_id else {
            return Ok(false);
        };
        let profile = self.ai_profile_storage(profile_id)?;
        if !profile.enabled {
            return Ok(false);
        }

        let model = effective_binding
            .model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(profile.default_model.trim());
        Ok(!model.is_empty())
    }

    pub fn projects_list(&mut self, input: ProjectsListInput) -> Result<Vec<ProjectListItem>> {
        let include_archived = input.include_archived.unwrap_or(false);
        let sql = format!(
            r#"
            SELECT
              p.id, p.name, p.status, p.root_path, p.summary, p.summary_markdown, p.summary_html,
              p.is_archived, p.created_at, p.updated_at,
              (SELECT COUNT(*) FROM activities a WHERE a.project_id = p.id) AS activity_count,
              (
                SELECT COUNT(*)
                FROM activities a
                WHERE a.project_id = p.id
                  AND COALESCE(
                    a.status_option_id,
                    (SELECT id FROM activity_status_options WHERE system_key = '{SYSTEM_ACTIVITY_STATUS_PENDING}' LIMIT 1)
                  ) = (SELECT id FROM activity_status_options WHERE system_key = '{SYSTEM_ACTIVITY_STATUS_PENDING}' LIMIT 1)
              ) AS unorganized_count,
              (SELECT COUNT(*) FROM todos t WHERE t.project_id = p.id AND t.status = 'unfinished') AS open_todo_count
            FROM projects p
            {}
            ORDER BY p.updated_at DESC
            "#,
            if include_archived {
                ""
            } else {
                "WHERE p.is_archived = 0"
            }
        );
        let mut stmt = self.conn.prepare(&sql)?;

        let rows = stmt.query_map([], |row| {
            let root_path_ref = row.get::<_, String>(3)?;
            Ok(ProjectListItem {
                id: row.get(0)?,
                name: row.get(1)?,
                status: row.get(2)?,
                root_path: self.decode_path_ref_to_string(&root_path_ref),
                summary: row.get(4)?,
                summary_markdown: row.get(5)?,
                summary_html: row.get(6)?,
                is_archived: int_to_bool(row.get::<_, i64>(7)?),
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
                activity_count: row.get(10)?,
                unorganized_count: row.get(11)?,
                open_todo_count: row.get(12)?,
            })
        })?;

        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn project_create(&mut self, input: ProjectCreateInput) -> Result<ProjectRecord> {
        let timestamp = now_iso();
        let base = self.workspace_root.clone();
        if !base.exists() {
            return Err(anyhow!("workspace root does not exist"));
        }

        let project_name = input.name.trim();
        if project_name.is_empty() {
            return Err(anyhow!("project name is required"));
        }

        let project_dir_name = project_directory_name(project_name)?;

        let project_dir = base.join(project_dir_name);
        if project_dir.exists() {
            return Err(anyhow!(
                "project folder already exists at {}",
                project_dir.display()
            ));
        }
        fs::create_dir_all(&project_dir)?;

        let summary = input.summary.unwrap_or_default();
        let summary_markdown = summary.clone();
        let summary_html = rich_text_html_from_markdown(&summary_markdown);

        self.conn.execute(
            r#"
            INSERT INTO projects (
              name, status, root_path, summary, summary_markdown, summary_html, is_archived, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8)
            "#,
            params![
                project_name,
                input.status.unwrap_or_else(|| "active".to_string()),
                self.encode_path_ref(&project_dir),
                summary,
                summary_markdown,
                summary_html,
                timestamp,
                timestamp
            ],
        )?;

        let id = self.conn.last_insert_rowid();
        self.project_record(id)
    }

    pub fn project_get_overview(&mut self, input: ProjectIdInput) -> Result<ProjectOverviewData> {
        self.ensure_project_file_layout(input.project_id)?;
        self.refresh_document_health(input.project_id)?;
        let project = self.project_record(input.project_id)?;
        let activity_feed = self.activity_digests(input.project_id, None)?;
        let project_documents = self.fetch_project_documents_for_project(input.project_id)?;
        let conclusion_groups = self.fetch_conclusion_groups(input.project_id)?;
        let unfinished_todos = self.fetch_project_todos(input.project_id, false)?;
        let finished_todos = self.fetch_project_todos(input.project_id, true)?;

        Ok(ProjectOverviewData {
            project,
            activity_feed,
            project_documents,
            conclusion_groups,
            unfinished_todos,
            finished_todos,
        })
    }

    pub fn project_get_dashboard(&mut self, input: ProjectIdInput) -> Result<ProjectDashboard> {
        self.ensure_project_file_layout(input.project_id)?;
        self.refresh_document_health(input.project_id)?;

        let project = self.project_record(input.project_id)?;
        let key_conclusions = self.list_project_conclusions(input.project_id, true)?;
        let open_todos = self.todo_list_open(input.clone())?;
        let starred_documents = self.fetch_documents_for_project(input.project_id, true)?;
        let recent_activities = self.activity_digests(input.project_id, Some(6))?;
        let unorganized_count: i64 = self.conn.query_row(
            r#"
            SELECT COUNT(*)
            FROM activities a
            WHERE a.project_id = ?1
              AND COALESCE(
                a.status_option_id,
                (SELECT id FROM activity_status_options WHERE system_key = ?2 LIMIT 1)
              ) = (SELECT id FROM activity_status_options WHERE system_key = ?2 LIMIT 1)
            "#,
            params![input.project_id, SYSTEM_ACTIVITY_STATUS_PENDING],
            |row| row.get(0),
        )?;

        Ok(ProjectDashboard {
            project,
            key_conclusions,
            open_todos,
            starred_documents,
            recent_activities,
            unorganized_count,
        })
    }

    fn rename_project_root(&mut self, current: &ProjectRecord, next_name: &str) -> Result<()> {
        let current_dir = PathBuf::from(&current.root_path);
        if !current_dir.exists() {
            return Err(anyhow!(
                "project folder does not exist at {}",
                current_dir.display()
            ));
        }

        let next_dir = self
            .workspace_root
            .join(project_directory_name(next_name.trim())?);
        if current_dir == next_dir {
            return Ok(());
        }

        if next_dir.exists() {
            return Err(anyhow!("文件夹名称已被占用，项目名称未保存"));
        }

        let documents = self.fetch_all_documents_for_project(current.id)?;
        let mut document_path_updates = Vec::with_capacity(documents.len());
        let mut version_path_updates = Vec::new();
        for document in &documents {
            let next_managed_path =
                rebase_path_prefix(Path::new(&document.managed_path), &current_dir, &next_dir)
                    .ok_or_else(|| {
                        anyhow!(
                            "document {} is outside project root: {}",
                            document.id,
                            document.managed_path
                        )
                    })?;
            let next_history_dir = rebase_path_prefix(
                Path::new(&document.history_dir_path),
                &current_dir,
                &next_dir,
            )
            .ok_or_else(|| {
                anyhow!(
                    "document history {} is outside project root: {}",
                    document.id,
                    document.history_dir_path
                )
            })?;
            let next_original_path_ref = self.rewrite_path_ref_prefix_if_within(
                &self.encode_path_ref(Path::new(&document.original_path)),
                &current_dir,
                &next_dir,
            );

            document_path_updates.push((
                document.id,
                self.encode_path_ref(&next_managed_path),
                self.encode_path_ref(&next_history_dir),
                next_original_path_ref,
            ));

            let versions = self.fetch_document_versions(document.id)?;
            for version in &versions {
                let next_managed_path =
                    rebase_path_prefix(Path::new(&version.managed_path), &current_dir, &next_dir)
                        .ok_or_else(|| {
                        anyhow!(
                            "document version {} is outside project root: {}",
                            version.id,
                            version.managed_path
                        )
                    })?;
                let next_source_path_ref = self.rewrite_path_ref_prefix_if_within(
                    &self.encode_path_ref(Path::new(&version.source_path)),
                    &current_dir,
                    &next_dir,
                );
                version_path_updates.push((
                    version.id,
                    self.encode_path_ref(&next_managed_path),
                    next_source_path_ref,
                ));
            }
        }

        let note_html_updates =
            self.collect_note_html_rewrites_for_project(current.id, &current_dir, &next_dir)?;
        let conclusion_html_updates =
            self.collect_conclusion_html_rewrites_for_project(current.id, &current_dir, &next_dir)?;

        let next_root_path_ref = self.encode_path_ref(&next_dir);

        fs::rename(&current_dir, &next_dir).with_context(|| {
            format!(
                "failed to rename project folder from {} to {}",
                current_dir.display(),
                next_dir.display()
            )
        })?;

        let tx = self.conn.transaction()?;
        let update_result: Result<()> = (|| {
            tx.execute(
                "UPDATE projects SET root_path = ?1 WHERE id = ?2",
                params![next_root_path_ref, current.id],
            )?;

            for (document_id, managed_path_ref, history_dir_ref, original_path_ref) in
                &document_path_updates
            {
                tx.execute(
                    r#"
                    UPDATE documents
                    SET managed_path = ?1,
                        history_dir_path = ?2,
                        original_path = ?3
                    WHERE id = ?4
                    "#,
                    params![
                        managed_path_ref,
                        history_dir_ref,
                        original_path_ref,
                        document_id
                    ],
                )?;
            }

            for (version_id, managed_path_ref, source_path_ref) in &version_path_updates {
                tx.execute(
                    r#"
                    UPDATE document_versions
                    SET managed_path = ?1,
                        source_path = ?2
                    WHERE id = ?3
                    "#,
                    params![managed_path_ref, source_path_ref, version_id],
                )?;
            }

            apply_note_html_updates(&tx, &note_html_updates)?;
            apply_conclusion_html_updates(&tx, &conclusion_html_updates)?;
            tx.commit()?;
            Ok(())
        })();

        if let Err(error) = update_result {
            let _ = fs::rename(&next_dir, &current_dir);
            return Err(error);
        }

        Ok(())
    }

    pub fn project_update_summary(
        &mut self,
        input: ProjectUpdateSummaryInput,
    ) -> Result<ProjectRecord> {
        let current = self.project_record(input.project_id)?;
        let project_name = match input.name.as_deref() {
            Some(value) => {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    return Err(anyhow!("project name is required"));
                }
                trimmed.to_string()
            }
            None => current.name.clone(),
        };
        if project_name != current.name {
            self.rename_project_root(&current, &project_name)?;
        }
        let next_summary = input.summary.trim().to_string();
        let next_summary_markdown = input
            .summary_markdown
            .as_deref()
            .map(str::trim)
            .map(str::to_string)
            .unwrap_or_else(|| {
                if next_summary == current.summary {
                    current.summary_markdown.clone()
                } else {
                    next_summary.clone()
                }
            });
        let next_summary_html = input
            .summary_html
            .as_deref()
            .map(str::trim)
            .map(str::to_string)
            .unwrap_or_else(|| {
                if next_summary == current.summary && input.summary_markdown.is_none() {
                    current.summary_html.clone()
                } else {
                    rich_text_html_from_markdown(&next_summary_markdown)
                }
            });
        self.conn.execute(
            "UPDATE projects SET name = ?1, summary = ?2, summary_markdown = ?3, summary_html = ?4, status = ?5, updated_at = ?6 WHERE id = ?7",
            params![
                project_name,
                next_summary,
                next_summary_markdown,
                next_summary_html,
                input.status.unwrap_or(current.status),
                now_iso(),
                input.project_id
            ],
        )?;
        self.mark_project_artifacts_stale(input.project_id)?;
        self.mark_daily_artifacts_stale()?;
        self.project_record(input.project_id)
    }

    pub fn project_set_archive(&mut self, input: ProjectArchiveInput) -> Result<ProjectRecord> {
        self.conn.execute(
            "UPDATE projects SET is_archived = ?1, updated_at = ?2 WHERE id = ?3",
            params![bool_to_int(input.is_archived), now_iso(), input.project_id],
        )?;
        self.mark_project_artifacts_stale(input.project_id)?;
        self.mark_daily_artifacts_stale()?;
        self.project_record(input.project_id)
    }

    pub fn activity_create(&mut self, input: ActivityCreateInput) -> Result<ActivityCardData> {
        self.ensure_project_file_layout(input.project_id)?;
        let timestamp = now_iso();
        let requested_title = input.title.unwrap_or_default();
        let attribute_option = match input.attribute_option_id {
            Some(option_id) => Some(self.activity_attribute_option_record(option_id)?),
            None => None,
        };
        let pending_status = self.pending_activity_status_option()?;
        self.conn.execute(
            r#"
            INSERT INTO activities (
              project_id, category, attribute_option_id, title, brief_markdown, brief_html,
              folder_name, activity_time, is_pinned, is_expanded, organize_status,
              status_option_id, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, '', '', '', ?5, 0, 0, ?6, NULL, ?7, ?8)
            "#,
            params![
                input.project_id,
                attribute_option
                    .as_ref()
                    .map(|option| option.label.as_str())
                    .unwrap_or(""),
                input.attribute_option_id,
                requested_title.trim(),
                input.activity_time,
                legacy_organize_status_for_system(pending_status.is_system),
                timestamp,
                timestamp
            ],
        )?;
        let activity_id = self.conn.last_insert_rowid();
        let activity_title = normalize_activity_title(&requested_title, activity_id);
        let project = self.project_record(input.project_id)?;
        let folder_name = self.default_activity_folder_name(&activity_title, activity_id);
        self.create_activity_directory(&project.root_path, &folder_name)?;
        self.conn.execute(
            "UPDATE activities SET title = ?1, folder_name = ?2 WHERE id = ?3",
            params![activity_title, folder_name, activity_id],
        )?;
        self.touch_project(input.project_id)?;
        self.activity_card(activity_id)
    }

    pub fn activity_list(&mut self, input: ProjectIdInput) -> Result<Vec<ActivityCardData>> {
        self.ensure_project_file_layout(input.project_id)?;
        self.refresh_document_health(input.project_id)?;
        let mut stmt = self.conn.prepare(
            "SELECT id FROM activities WHERE project_id = ?1 ORDER BY activity_time DESC, updated_at DESC",
        )?;
        let ids = stmt
            .query_map([input.project_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        ids.into_iter().map(|id| self.activity_card(id)).collect()
    }

    pub fn activity_update_meta(
        &mut self,
        input: ActivityUpdateMetaInput,
    ) -> Result<ActivityCardData> {
        let timestamp = now_iso();
        let current = self.activity_row(input.activity_id)?;
        let next_title = input
            .title
            .as_deref()
            .map(|title| normalize_activity_title(title, input.activity_id))
            .unwrap_or_else(|| current.title.clone());
        let next_brief_markdown = input
            .brief_markdown
            .as_deref()
            .map(str::trim)
            .map(str::to_string)
            .unwrap_or_else(|| current.brief_markdown.clone());
        let next_activity_time = input
            .activity_time
            .unwrap_or_else(|| current.activity_time.clone());
        let next_brief_html = input
            .brief_html
            .as_deref()
            .map(str::trim)
            .map(str::to_string)
            .unwrap_or_else(|| {
                if input.brief_markdown.is_some() {
                    rich_text_html_from_markdown(&next_brief_markdown)
                } else {
                    current.brief_html.clone()
                }
            });
        let next_attribute_option_id = if input.clear_attribute_option.unwrap_or(false) {
            None
        } else if let Some(option_id) = input.attribute_option_id {
            self.activity_attribute_option_record(option_id)?;
            Some(option_id)
        } else {
            current.attribute_option_id
        };
        let next_attribute_label = match next_attribute_option_id {
            Some(option_id) => Some(self.activity_attribute_option_record(option_id)?.label),
            None => None,
        };
        let next_status_option_id = if let Some(option_id) = input.status_option_id {
            self.activity_status_option_record(option_id)?;
            Some(option_id)
        } else {
            current.status_option_id
        };
        let next_status = self.resolve_activity_status_option(next_status_option_id)?;

        if next_title != current.title {
            self.ensure_project_file_layout(current.project_id)?;
            self.rename_activity_folder(input.activity_id, &current, &next_title, &timestamp)?;
        }
        self.conn.execute(
            r#"
            UPDATE activities
            SET title = ?1,
                brief_markdown = ?2,
                brief_html = ?3,
                category = ?4,
                attribute_option_id = ?5,
                activity_time = ?6,
                is_pinned = ?7,
                is_expanded = ?8,
                organize_status = ?9,
                status_option_id = ?10,
                updated_at = ?11
            WHERE id = ?12
            "#,
            params![
                next_title,
                next_brief_markdown,
                next_brief_html,
                next_attribute_label.unwrap_or_default(),
                next_attribute_option_id,
                next_activity_time,
                bool_to_int(input.is_pinned.unwrap_or(current.is_pinned)),
                bool_to_int(input.is_expanded.unwrap_or(current.is_expanded)),
                legacy_organize_status_for_system(next_status.is_system),
                next_status_option_id,
                timestamp,
                input.activity_id
            ],
        )?;
        self.touch_activity(input.activity_id)?;
        self.activity_card(input.activity_id)
    }

    pub fn activity_delete(&mut self, input: ActivityDeleteInput) -> Result<ActivityCardData> {
        let deleted = self.activity_card(input.activity_id)?;
        let current = self.activity_row(input.activity_id)?;
        let project_id = current.project_id;
        self.ensure_project_file_layout(project_id)?;
        let project = self.project_record(project_id)?;
        let project_root = PathBuf::from(&project.root_path);

        for document in self.fetch_all_documents_for_activity(input.activity_id)? {
            self.document_delete(DocumentDeleteInput {
                document_id: document.id,
            })?;
        }

        for todo_id in self.fetch_todo_ids_for_activity(input.activity_id)? {
            self.todo_delete(TodoDeleteInput { todo_id })?;
        }

        self.conn
            .execute("DELETE FROM activities WHERE id = ?1", [input.activity_id])?;

        let folder_name = if current.folder_name.trim().is_empty() {
            self.default_activity_folder_name(&current.title, input.activity_id)
        } else {
            current.folder_name
        };
        let activity_dir = project_root.join(folder_name);
        let note_asset_dir = project_root
            .join(WORKSPACE_HIDDEN_DIR_NAME)
            .join(PROJECT_NOTE_ASSET_DIR_NAME)
            .join(format!("activity-{}", input.activity_id));
        let cleanup_paths = [activity_dir, note_asset_dir]
            .into_iter()
            .filter(|path| path.exists())
            .collect::<Vec<_>>();
        move_paths_to_trash(&cleanup_paths)?;

        self.touch_project(project_id)?;
        Ok(deleted)
    }

    pub fn activity_settings_get(&mut self) -> Result<ActivitySettingsSnapshot> {
        self.ensure_activity_settings_seeded()?;
        Ok(ActivitySettingsSnapshot {
            activity_attribute_options: self.fetch_activity_attribute_options()?,
            activity_status_options: self.fetch_activity_status_options()?,
        })
    }

    pub fn activity_attribute_option_upsert(
        &mut self,
        input: ActivityAttributeOptionUpsertInput,
    ) -> Result<ActivityAttributeOption> {
        let label = validate_activity_option_label(&input.label)?;
        let color_key = validate_activity_attribute_color_key(&input.color_key)?;
        let now = now_iso();

        if let Some(option_id) = input.id {
            self.activity_attribute_option_record(option_id)?;
            self.conn.execute(
                "UPDATE activity_attribute_options SET label = ?1, color_key = ?2, updated_at = ?3 WHERE id = ?4",
                params![label, color_key, now, option_id],
            )?;
            return self.activity_attribute_option_record(option_id);
        }

        self.conn.execute(
            r#"
            INSERT INTO activity_attribute_options (label, color_key, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4)
            "#,
            params![label, color_key, now, now],
        )?;

        self.activity_attribute_option_record(self.conn.last_insert_rowid())
    }

    pub fn activity_attribute_option_delete(
        &mut self,
        input: ActivityOptionDeleteInput,
    ) -> Result<ActivitySettingsSnapshot> {
        self.activity_attribute_option_record(input.option_id)?;
        self.conn.execute(
            "DELETE FROM activity_attribute_options WHERE id = ?1",
            params![input.option_id],
        )?;
        self.activity_settings_get()
    }

    pub fn activity_status_option_upsert(
        &mut self,
        input: ActivityStatusOptionUpsertInput,
    ) -> Result<ActivityStatusOption> {
        let label = validate_activity_option_label(&input.label)?;
        let color_key = validate_activity_status_color_key(&input.color_key)?;
        let needs_attention = bool_to_int(color_key_implies_attention(&color_key));
        let now = now_iso();

        if let Some(option_id) = input.id {
            self.conn.execute(
                r#"
                UPDATE activity_status_options
                SET label = ?1, color_key = ?2, needs_attention = ?3, updated_at = ?4
                WHERE id = ?5
                "#,
                params![label, color_key, needs_attention, now, option_id],
            )?;
            return self.activity_status_option_record(option_id);
        }

        self.conn.execute(
            r#"
            INSERT INTO activity_status_options (system_key, label, color_key, needs_attention, created_at, updated_at)
            VALUES (NULL, ?1, ?2, ?3, ?4, ?5)
            "#,
            params![label, color_key, needs_attention, now, now],
        )?;

        self.activity_status_option_record(self.conn.last_insert_rowid())
    }

    pub fn activity_status_option_delete(
        &mut self,
        input: ActivityOptionDeleteInput,
    ) -> Result<ActivitySettingsSnapshot> {
        let current = self.activity_status_option_record(input.option_id)?;
        if current.is_system {
            return Err(anyhow!("system activity status cannot be deleted"));
        }

        self.conn.execute(
            "DELETE FROM activity_status_options WHERE id = ?1",
            params![input.option_id],
        )?;
        self.activity_settings_get()
    }

    pub fn file_tag_settings_get(&mut self) -> Result<FileTagSettingsSnapshot> {
        Ok(FileTagSettingsSnapshot {
            tags: self.fetch_file_tag_records()?,
        })
    }

    pub fn file_tag_option_upsert(
        &mut self,
        input: FileTagOptionUpsertInput,
    ) -> Result<FileTagRecord> {
        let label = validate_file_tag_label(&input.label)?;
        let color_key = validate_file_tag_color_key(&input.color_key)?;
        let now = now_iso();

        if let Some(tag_id) = input.id {
            self.file_tag_record(tag_id)?;
            self.conn.execute(
                r#"
                UPDATE file_tag_options
                SET label = ?1, color_key = ?2, updated_at = ?3
                WHERE id = ?4
                "#,
                params![label, color_key, now, tag_id],
            )?;
            return self.file_tag_record(tag_id);
        }

        self.conn.execute(
            r#"
            INSERT INTO file_tag_options (label, color_key, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4)
            "#,
            params![label, color_key, now, now],
        )?;
        self.file_tag_record(self.conn.last_insert_rowid())
    }

    pub fn file_tag_option_delete(
        &mut self,
        input: FileTagOptionDeleteInput,
    ) -> Result<FileTagSettingsSnapshot> {
        self.file_tag_record(input.tag_id)?;
        self.conn.execute(
            "DELETE FROM file_tag_options WHERE id = ?1",
            params![input.tag_id],
        )?;
        self.file_tag_settings_get()
    }

    pub fn record_type_settings_get(&mut self) -> Result<RecordTypeSettingsSnapshot> {
        self.ensure_record_type_settings_seeded()?;
        Ok(RecordTypeSettingsSnapshot {
            record_types: self.fetch_record_type_records()?,
        })
    }

    pub fn record_type_option_upsert(
        &mut self,
        input: RecordTypeOptionUpsertInput,
    ) -> Result<RecordTypeRecord> {
        self.ensure_record_type_settings_seeded()?;
        let label = validate_record_type_label(&input.label)?;
        let color_key = validate_file_tag_color_key(&input.color_key)?;
        let template_html = normalize_record_type_template_html(&input.template_html);
        let now = now_iso();
        let key = if input.id.is_none() {
            Some(self.generate_unique_record_type_key(&label)?)
        } else {
            None
        };
        let tx = self.conn.transaction()?;

        if let Some(type_id) = input.id {
            let current = record_type_storage_with_tx(&tx, type_id)?;

            if current.is_default && !input.is_default {
                return Err(anyhow!("default record type cannot be unset directly"));
            }

            if input.is_default {
                tx.execute("UPDATE record_type_options SET is_default = 0", [])?;
            }

            tx.execute(
                r#"
                UPDATE record_type_options
                SET label = ?1,
                    color_key = ?2,
                    template_html = ?3,
                    is_default = ?4,
                    updated_at = ?5
                WHERE id = ?6
                "#,
                params![
                    label,
                    color_key,
                    template_html,
                    bool_to_int(input.is_default || current.is_default),
                    now,
                    type_id
                ],
            )?;

            tx.commit()?;
            self.normalize_record_type_defaults()?;
            return self.record_type_record(type_id);
        }

        let should_be_default = input.is_default
            || tx.query_row("SELECT COUNT(*) FROM record_type_options", [], |row| {
                row.get::<_, i64>(0)
            })? == 0;

        if should_be_default {
            tx.execute("UPDATE record_type_options SET is_default = 0", [])?;
        }

        tx.execute(
            r#"
            INSERT INTO record_type_options (
              key, label, color_key, template_html, is_default, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            "#,
            params![
                key.expect("record type key is generated for create"),
                label,
                color_key,
                template_html,
                bool_to_int(should_be_default),
                now,
                now
            ],
        )?;

        let type_id = tx.last_insert_rowid();
        tx.commit()?;
        self.normalize_record_type_defaults()?;
        self.record_type_record(type_id)
    }

    pub fn record_type_option_delete(
        &mut self,
        input: RecordTypeOptionDeleteInput,
    ) -> Result<RecordTypeSettingsSnapshot> {
        self.ensure_record_type_settings_seeded()?;
        let current = self.record_type_record(input.type_id)?;

        if current.is_default {
            return Err(anyhow!("default record type cannot be deleted"));
        }

        if current.usage_count > 0 {
            return Err(anyhow!("record type in use cannot be deleted"));
        }

        self.conn.execute(
            "DELETE FROM record_type_options WHERE id = ?1",
            params![input.type_id],
        )?;

        self.record_type_settings_get()
    }

    pub fn note_upsert(&mut self, input: NoteUpsertInput) -> Result<NoteRecord> {
        self.ensure_record_type_settings_seeded()?;
        let timestamp = now_iso();
        let note_type = validate_record_type_key(&input.note_type)?;
        match input.note_id {
            Some(note_id) => {
                let current = self.note_record(note_id)?;
                if current.note_type != note_type {
                    return Err(anyhow!("note type cannot be changed after creation"));
                }

                self.conn.execute(
                    r#"
                    UPDATE notes
                    SET note_type = ?1,
                        title = ?2,
                        content_markdown = ?3,
                        content_html = ?4,
                        updated_at = ?5
                    WHERE id = ?6
                    "#,
                    params![
                        current.note_type,
                        input.title,
                        input.markdown,
                        input.html,
                        timestamp,
                        note_id
                    ],
                )?;
                self.touch_activity(input.activity_id)?;
                self.note_record(note_id)
            }
            None => {
                let record_type = self.record_type_record_by_key(&note_type)?;
                self.conn.execute(
                    r#"
                    INSERT INTO notes (
                      project_id, activity_id, note_type, title, content_markdown, content_html, created_at, updated_at
                    )
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                    "#,
                    params![
                        input.project_id,
                        input.activity_id,
                        record_type.key,
                        input.title,
                        input.markdown,
                        input.html,
                        timestamp,
                        timestamp
                    ],
                )?;
                let note_id = self.conn.last_insert_rowid();
                self.touch_activity(input.activity_id)?;
                self.note_record(note_id)
            }
        }
    }

    pub fn note_delete(&mut self, input: NoteDeleteInput) -> Result<NoteRecord> {
        let current = self.note_record(input.note_id)?;
        self.conn
            .execute("DELETE FROM notes WHERE id = ?1", [input.note_id])?;
        self.touch_activity(current.activity_id)?;
        Ok(current)
    }

    pub fn workspace_note_list(&mut self) -> Result<Vec<WorkspaceNoteRecord>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id
            FROM workspace_notes
            WHERE note_kind = ?1
            ORDER BY updated_at DESC, created_at DESC
            "#,
        )?;
        let ids = stmt
            .query_map([WORKSPACE_NOTE_KIND_STANDARD], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter()
            .map(|id| self.workspace_note_record(id))
            .collect()
    }

    pub fn workspace_note_upsert(
        &mut self,
        input: WorkspaceNoteUpsertInput,
    ) -> Result<WorkspaceNoteRecord> {
        let timestamp = now_iso();

        match input.note_id {
            Some(note_id) => {
                self.workspace_note_record(note_id)?;
                self.conn.execute(
                    r#"
                    UPDATE workspace_notes
                    SET title = ?1,
                        content_markdown = ?2,
                        content_html = ?3,
                        updated_at = ?4
                    WHERE id = ?5
                    "#,
                    params![input.title, input.markdown, input.html, timestamp, note_id],
                )?;
                self.workspace_note_record(note_id)
            }
            None => {
                self.conn.execute(
                    r#"
                    INSERT INTO workspace_notes (
                      note_kind, title, content_markdown, content_html, created_at, updated_at
                    )
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                    "#,
                    params![
                        WORKSPACE_NOTE_KIND_STANDARD,
                        input.title,
                        input.markdown,
                        input.html,
                        timestamp,
                        timestamp
                    ],
                )?;
                self.workspace_note_record(self.conn.last_insert_rowid())
            }
        }
    }

    pub fn today_quick_note_get(&mut self) -> Result<Option<WorkspaceNoteRecord>> {
        let quick_note_id = self
            .conn
            .query_row(
                r#"
                SELECT id
                FROM workspace_notes
                WHERE note_kind = ?1
                ORDER BY updated_at DESC, created_at DESC
                LIMIT 1
                "#,
                [WORKSPACE_NOTE_KIND_TODAY_QUICK],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;

        quick_note_id
            .map(|note_id| self.workspace_note_record(note_id))
            .transpose()
    }

    pub fn today_quick_note_upsert(
        &mut self,
        input: TodayQuickNoteUpsertInput,
    ) -> Result<WorkspaceNoteRecord> {
        let timestamp = now_iso();
        let existing = self.today_quick_note_get()?;

        match existing {
            Some(note) => {
                self.conn.execute(
                    r#"
                    UPDATE workspace_notes
                    SET title = NULL,
                        content_markdown = ?1,
                        content_html = ?2,
                        updated_at = ?3
                    WHERE id = ?4
                    "#,
                    params![input.markdown, input.html, timestamp, note.id],
                )?;
                self.workspace_note_record(note.id)
            }
            None => {
                self.conn.execute(
                    r#"
                    INSERT INTO workspace_notes (
                      note_kind, title, content_markdown, content_html, created_at, updated_at
                    )
                    VALUES (?1, NULL, ?2, ?3, ?4, ?5)
                    "#,
                    params![
                        WORKSPACE_NOTE_KIND_TODAY_QUICK,
                        input.markdown,
                        input.html,
                        timestamp,
                        timestamp
                    ],
                )?;
                self.workspace_note_record(self.conn.last_insert_rowid())
            }
        }
    }

    pub fn workspace_note_delete(
        &mut self,
        input: WorkspaceNoteDeleteInput,
    ) -> Result<WorkspaceNoteRecord> {
        let current = self.workspace_note_record(input.note_id)?;
        self.conn
            .execute("DELETE FROM workspace_notes WHERE id = ?1", [input.note_id])?;
        Ok(current)
    }

    pub fn conclusion_create(&mut self, input: ConclusionCreateInput) -> Result<ConclusionRecord> {
        let timestamp = now_iso();
        self.conn.execute(
            r#"
            INSERT INTO conclusions (
              project_id, activity_id, note_id, content_markdown, content_html, content, promoted_to_project, is_pinned, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            "#,
            params![
                input.project_id,
                input.activity_id,
                input.note_id,
                input.markdown,
                input.html,
                input.markdown,
                bool_to_int(input.promoted_to_project),
                bool_to_int(input.is_pinned.unwrap_or(false)),
                timestamp,
                timestamp
            ],
        )?;
        let id = self.conn.last_insert_rowid();
        if let Some(activity_id) = input.activity_id {
            self.touch_activity(activity_id)?;
        }
        self.touch_project(input.project_id)?;
        self.conclusion_record(id)
    }

    pub fn conclusion_list(&mut self, input: ConclusionListInput) -> Result<Vec<ConclusionRecord>> {
        if let Some(activity_id) = input.activity_id {
            let mut stmt = self.conn.prepare(
                r#"
                SELECT id FROM conclusions
                WHERE project_id = ?1 AND activity_id = ?2
                ORDER BY is_pinned DESC, created_at DESC
                "#,
            )?;
            let ids = stmt
                .query_map(params![input.project_id, activity_id], |row| {
                    row.get::<_, i64>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            ids.into_iter()
                .map(|id| self.conclusion_record(id))
                .collect()
        } else {
            self.list_project_conclusions(input.project_id, false)
        }
    }

    pub fn conclusion_update(&mut self, input: ConclusionUpdateInput) -> Result<ConclusionRecord> {
        let current = self.conclusion_record(input.conclusion_id)?;
        self.conn.execute(
            r#"
            UPDATE conclusions
            SET content_markdown = ?1,
                content_html = ?2,
                content = ?3,
                promoted_to_project = ?4,
                is_pinned = ?5,
                updated_at = ?6
            WHERE id = ?7
            "#,
            params![
                input.markdown,
                input.html,
                input.markdown,
                bool_to_int(
                    input
                        .promoted_to_project
                        .unwrap_or(current.promoted_to_project)
                ),
                bool_to_int(input.is_pinned.unwrap_or(current.is_pinned)),
                now_iso(),
                input.conclusion_id
            ],
        )?;
        self.touch_project(current.project_id)?;
        if let Some(activity_id) = current.activity_id {
            self.touch_activity(activity_id)?;
        }
        self.conclusion_record(input.conclusion_id)
    }

    pub fn conclusion_delete(&mut self, input: ConclusionDeleteInput) -> Result<ConclusionRecord> {
        let current = self.conclusion_record(input.conclusion_id)?;
        self.conn.execute(
            "DELETE FROM conclusions WHERE id = ?1",
            [input.conclusion_id],
        )?;
        self.touch_project(current.project_id)?;
        if let Some(activity_id) = current.activity_id {
            self.touch_activity(activity_id)?;
        }
        Ok(current)
    }

    pub fn todo_create(&mut self, input: TodoCreateInput) -> Result<TodoRecord> {
        let timestamp = now_iso();
        self.conn.execute(
            r#"
            INSERT INTO todos (
              project_id, activity_id, content, status, priority, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, 'unfinished', ?4, ?5, ?6)
            "#,
            params![
                input.project_id,
                input.activity_id,
                input.content,
                input.priority,
                timestamp,
                timestamp
            ],
        )?;
        let id = self.conn.last_insert_rowid();
        if let Some(activity_id) = input.activity_id {
            self.touch_activity(activity_id)?;
        }
        self.touch_project(input.project_id)?;
        self.todo_record(id)
    }

    pub fn todo_update_content(&mut self, input: TodoUpdateContentInput) -> Result<TodoRecord> {
        self.conn.execute(
            "UPDATE todos SET content = ?1, updated_at = ?2 WHERE id = ?3",
            params![input.content, now_iso(), input.todo_id],
        )?;
        let record = self.todo_record(input.todo_id)?;
        self.touch_project(record.project_id)?;
        if let Some(activity_id) = record.activity_id {
            self.touch_activity(activity_id)?;
        }
        Ok(record)
    }

    pub fn todo_update_activity(&mut self, input: TodoUpdateActivityInput) -> Result<TodoRecord> {
        let current = self.todo_record(input.todo_id)?;
        if let Some(activity_id) = input.activity_id {
            let activity_project_id = self
                .conn
                .query_row(
                    "SELECT project_id FROM activities WHERE id = ?1",
                    [activity_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .ok_or_else(|| anyhow!("目标 Activity 不存在"))?;

            if activity_project_id != current.project_id {
                return Err(anyhow!("Todo 只能改绑到同项目下的 Activity"));
            }
        }

        self.conn.execute(
            "UPDATE todos SET activity_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![input.activity_id, now_iso(), input.todo_id],
        )?;
        let record = self.todo_record(input.todo_id)?;

        match (current.activity_id, record.activity_id) {
            (Some(previous), Some(next)) if previous == next => self.touch_activity(previous)?,
            (Some(previous), Some(next)) => {
                self.touch_activity(previous)?;
                self.touch_activity(next)?;
            }
            (Some(previous), None) => self.touch_activity(previous)?,
            (None, Some(next)) => self.touch_activity(next)?,
            (None, None) => self.touch_project(record.project_id)?,
        }

        Ok(record)
    }

    pub fn todo_update_status(&mut self, input: TodoUpdateStatusInput) -> Result<TodoRecord> {
        self.conn.execute(
            "UPDATE todos SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![input.status, now_iso(), input.todo_id],
        )?;
        let record = self.todo_record(input.todo_id)?;
        self.touch_project(record.project_id)?;
        if let Some(activity_id) = record.activity_id {
            self.touch_activity(activity_id)?;
        }
        Ok(record)
    }

    pub fn todo_update_priority(&mut self, input: TodoUpdatePriorityInput) -> Result<TodoRecord> {
        self.conn.execute(
            "UPDATE todos SET priority = ?1, updated_at = ?2 WHERE id = ?3",
            params![input.priority, now_iso(), input.todo_id],
        )?;
        let record = self.todo_record(input.todo_id)?;
        self.touch_project(record.project_id)?;
        if let Some(activity_id) = record.activity_id {
            self.touch_activity(activity_id)?;
        }
        Ok(record)
    }

    pub fn todo_add_progress(&mut self, input: TodoAddProgressInput) -> Result<TodoProgressRecord> {
        let timestamp = now_iso();
        let todo = self.todo_record(input.todo_id)?;
        self.conn.execute(
            r#"
            INSERT INTO todo_progresses (todo_id, content, progress_date, created_at)
            VALUES (?1, ?2, ?3, ?4)
            "#,
            params![input.todo_id, input.content, input.progress_date, timestamp],
        )?;
        self.conn.execute(
            "UPDATE todos SET updated_at = ?1 WHERE id = ?2",
            params![now_iso(), input.todo_id],
        )?;
        let progress_id = self.conn.last_insert_rowid();
        self.touch_project(todo.project_id)?;
        if let Some(activity_id) = todo.activity_id {
            self.touch_activity(activity_id)?;
        }
        self.todo_progress_record(progress_id)
    }

    pub fn todo_update_progress(
        &mut self,
        input: TodoUpdateProgressInput,
    ) -> Result<TodoProgressRecord> {
        let current = self.todo_progress_record(input.progress_id)?;
        let todo = self.todo_record(current.todo_id)?;
        let timestamp = now_iso();

        self.conn.execute(
            "UPDATE todo_progresses SET content = ?1, progress_date = ?2 WHERE id = ?3",
            params![input.content, input.progress_date, input.progress_id],
        )?;
        self.conn.execute(
            "UPDATE todos SET updated_at = ?1 WHERE id = ?2",
            params![timestamp, current.todo_id],
        )?;
        self.touch_project(todo.project_id)?;
        if let Some(activity_id) = todo.activity_id {
            self.touch_activity(activity_id)?;
        }
        self.todo_progress_record(input.progress_id)
    }

    pub fn todo_delete_progress(
        &mut self,
        input: TodoDeleteProgressInput,
    ) -> Result<TodoProgressRecord> {
        let current = self.todo_progress_record(input.progress_id)?;
        let todo = self.todo_record(current.todo_id)?;

        self.conn.execute(
            "DELETE FROM todo_progresses WHERE id = ?1",
            [input.progress_id],
        )?;
        self.conn.execute(
            "UPDATE todos SET updated_at = ?1 WHERE id = ?2",
            params![now_iso(), current.todo_id],
        )?;
        self.touch_project(todo.project_id)?;
        if let Some(activity_id) = todo.activity_id {
            self.touch_activity(activity_id)?;
        }
        Ok(current)
    }

    pub fn todo_delete(&mut self, input: TodoDeleteInput) -> Result<TodoRecord> {
        let current = self.todo_record(input.todo_id)?;
        self.conn
            .execute("DELETE FROM todos WHERE id = ?1", [input.todo_id])?;
        self.touch_project(current.project_id)?;
        if let Some(activity_id) = current.activity_id {
            self.touch_activity(activity_id)?;
        }
        Ok(current)
    }

    pub fn todo_list_open(&mut self, input: ProjectIdInput) -> Result<Vec<TodoRecord>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id FROM todos
            WHERE project_id = ?1 AND status = 'unfinished'
            ORDER BY updated_at DESC
            "#,
        )?;
        let ids = stmt
            .query_map([input.project_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().map(|id| self.todo_record(id)).collect()
    }

    pub fn workspace_todo_list(&mut self) -> Result<Vec<TodoRecord>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT t.id
            FROM todos t
            JOIN projects p ON p.id = t.project_id
            WHERE p.is_archived = 0
            ORDER BY
              CASE WHEN t.status = 'unfinished' THEN 0 ELSE 1 END,
              t.updated_at DESC
            "#,
        )?;
        let ids = stmt
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().map(|id| self.todo_record(id)).collect()
    }

    pub fn document_import(&mut self, input: DocumentImportInput) -> Result<DocumentRecord> {
        self.ensure_project_file_layout(input.project_id)?;
        let timestamp = now_iso();
        let source = PathBuf::from(&input.source_path);
        if !source.exists() {
            return Err(anyhow!("source file does not exist"));
        }

        let project = self.project_record(input.project_id)?;
        let target_dir = self.document_target_dir(input.project_id, input.activity_id)?;

        let file_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| anyhow!("invalid file name"))?
            .to_string();
        self.ensure_document_name_available(input.project_id, input.activity_id, &file_name, None)?;
        let managed_path = target_dir.join(&file_name);
        let storage_mode = self.materialize_file_for_target(
            Path::new(&project.root_path),
            &source,
            &managed_path,
        )?;

        let mime = mime_guess::from_path(&source)
            .first_or_octet_stream()
            .essence_str()
            .to_string();

        self.conn.execute(
            r#"
            INSERT INTO documents (
              project_id, activity_id, name, base_name, original_path, managed_path, history_dir_path, storage_mode, mime_type, is_starred, current_version_number, version_count, health, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8, ?9, 1, 1, 'normal', ?10, ?11)
            "#,
            params![
                input.project_id,
                input.activity_id,
                file_name,
                file_name,
                self.encode_path_ref(&source),
                self.encode_path_ref(&managed_path),
                storage_mode,
                mime,
                bool_to_int(input.is_starred),
                timestamp,
                timestamp
            ],
        )?;
        let id = self.conn.last_insert_rowid();
        let history_dir = self.history_dir_path_for(&managed_path, id);
        self.conn.execute(
            "UPDATE documents SET history_dir_path = ?1 WHERE id = ?2",
            params![self.encode_path_ref(&history_dir), id],
        )?;
        self.conn.execute(
            r#"
            INSERT INTO document_versions (
              document_id, version_number, name, source_path, managed_path, created_at
            )
            VALUES (?1, 1, ?2, ?3, ?4, ?5)
            "#,
            params![
                id,
                file_name,
                self.encode_path_ref(&source),
                self.encode_path_ref(&managed_path),
                timestamp
            ],
        )?;
        if let Some(tag_ids) = input.tag_ids.as_deref() {
            self.replace_document_tags(id, tag_ids, &timestamp)?;
        }
        self.touch_project(input.project_id)?;
        if let Some(activity_id) = input.activity_id {
            self.touch_activity(activity_id)?;
        }
        self.document_record(id)
    }

    pub fn document_import_note_image(
        &mut self,
        input: DocumentImportNoteImageInput,
    ) -> Result<DocumentRecord> {
        self.ensure_project_file_layout(input.project_id)?;
        let timestamp = now_iso();
        let source = PathBuf::from(&input.source_path);
        if !source.exists() {
            return Err(anyhow!("source file does not exist"));
        }

        let mime = mime_guess::from_path(&source)
            .first_or_octet_stream()
            .essence_str()
            .to_string();
        let file_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| anyhow!("invalid file name"))?
            .to_string();
        let sanitized_name = sanitize_import_file_name(&file_name, &mime)?;
        let target_dir = self.note_image_target_dir(input.project_id, input.activity_id)?;
        let resolved_name = self.resolve_internal_document_name(
            input.project_id,
            input.activity_id,
            &sanitized_name,
            &target_dir,
        )?;
        let managed_path = target_dir.join(&resolved_name);

        if let Some(parent) = managed_path.parent() {
            fs::create_dir_all(parent)?;
        }

        fs::copy(&source, &managed_path).with_context(|| {
            format!(
                "failed to copy note image from {} to {}",
                source.display(),
                managed_path.display()
            )
        })?;

        self.conn.execute(
            r#"
            INSERT INTO documents (
              project_id, activity_id, name, base_name, original_path, managed_path, history_dir_path, storage_mode, mime_type, is_starred, current_version_number, version_count, health, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8, 0, 1, 1, 'normal', ?9, ?10)
            "#,
            params![
                input.project_id,
                input.activity_id,
                resolved_name,
                resolved_name,
                self.encode_path_ref(&source),
                self.encode_path_ref(&managed_path),
                MANAGED_NOTE_IMAGE_STORAGE_MODE,
                mime,
                timestamp,
                timestamp
            ],
        )?;
        let id = self.conn.last_insert_rowid();
        let history_dir = self.history_dir_path_for(&managed_path, id);
        self.conn.execute(
            "UPDATE documents SET history_dir_path = ?1 WHERE id = ?2",
            params![self.encode_path_ref(&history_dir), id],
        )?;
        self.conn.execute(
            r#"
            INSERT INTO document_versions (
              document_id, version_number, name, source_path, managed_path, created_at
            )
            VALUES (?1, 1, ?2, ?3, ?4, ?5)
            "#,
            params![
                id,
                resolved_name,
                self.encode_path_ref(&source),
                self.encode_path_ref(&managed_path),
                timestamp
            ],
        )?;
        self.touch_project(input.project_id)?;
        if let Some(activity_id) = input.activity_id {
            self.touch_activity(activity_id)?;
        }
        self.document_record(id)
    }

    pub fn document_import_clipboard_image(
        &mut self,
        input: DocumentImportClipboardImageInput,
    ) -> Result<DocumentRecord> {
        self.ensure_project_file_layout(input.project_id)?;
        let timestamp = now_iso();
        let target_dir = self.document_target_dir(input.project_id, input.activity_id)?;
        let file_name = sanitize_import_file_name(&input.file_name, &input.mime_type)?;

        self.ensure_document_name_available(input.project_id, input.activity_id, &file_name, None)?;

        let managed_path = target_dir.join(&file_name);
        if let Some(parent) = managed_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let bytes = STANDARD
            .decode(input.data_base64.trim())
            .context("failed to decode clipboard image")?;

        fs::write(&managed_path, &bytes).with_context(|| {
            format!(
                "failed to write clipboard image to {}",
                managed_path.display()
            )
        })?;

        self.conn.execute(
            r#"
            INSERT INTO documents (
              project_id, activity_id, name, base_name, original_path, managed_path, history_dir_path, storage_mode, mime_type, is_starred, current_version_number, version_count, health, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8, ?9, 1, 1, 'normal', ?10, ?11)
            "#,
            params![
                input.project_id,
                input.activity_id,
                file_name,
                file_name,
                self.encode_path_ref(&managed_path),
                self.encode_path_ref(&managed_path),
                "managed_clipboard",
                input.mime_type,
                bool_to_int(input.is_starred),
                timestamp,
                timestamp
            ],
        )?;
        let id = self.conn.last_insert_rowid();
        let history_dir = self.history_dir_path_for(&managed_path, id);
        self.conn.execute(
            "UPDATE documents SET history_dir_path = ?1 WHERE id = ?2",
            params![self.encode_path_ref(&history_dir), id],
        )?;
        self.conn.execute(
            r#"
            INSERT INTO document_versions (
              document_id, version_number, name, source_path, managed_path, created_at
            )
            VALUES (?1, 1, ?2, ?3, ?4, ?5)
            "#,
            params![
                id,
                file_name,
                self.encode_path_ref(&managed_path),
                self.encode_path_ref(&managed_path),
                timestamp
            ],
        )?;
        if let Some(tag_ids) = input.tag_ids.as_deref() {
            self.replace_document_tags(id, tag_ids, &timestamp)?;
        }
        self.touch_project(input.project_id)?;
        if let Some(activity_id) = input.activity_id {
            self.touch_activity(activity_id)?;
        }
        self.document_record(id)
    }

    pub fn document_import_clipboard_note_image(
        &mut self,
        input: DocumentImportClipboardNoteImageInput,
    ) -> Result<DocumentRecord> {
        self.ensure_project_file_layout(input.project_id)?;
        let timestamp = now_iso();
        let target_dir = self.note_image_target_dir(input.project_id, input.activity_id)?;
        let file_name = sanitize_import_file_name(&input.file_name, &input.mime_type)?;
        let resolved_name = self.resolve_internal_document_name(
            input.project_id,
            input.activity_id,
            &file_name,
            &target_dir,
        )?;
        let managed_path = target_dir.join(&resolved_name);
        if let Some(parent) = managed_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let bytes = STANDARD
            .decode(input.data_base64.trim())
            .context("failed to decode clipboard image")?;

        fs::write(&managed_path, &bytes)
            .with_context(|| format!("failed to write note image to {}", managed_path.display()))?;

        self.conn.execute(
            r#"
            INSERT INTO documents (
              project_id, activity_id, name, base_name, original_path, managed_path, history_dir_path, storage_mode, mime_type, is_starred, current_version_number, version_count, health, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8, 0, 1, 1, 'normal', ?9, ?10)
            "#,
            params![
                input.project_id,
                input.activity_id,
                resolved_name,
                resolved_name,
                self.encode_path_ref(&managed_path),
                self.encode_path_ref(&managed_path),
                MANAGED_NOTE_IMAGE_STORAGE_MODE,
                input.mime_type,
                timestamp,
                timestamp
            ],
        )?;
        let id = self.conn.last_insert_rowid();
        let history_dir = self.history_dir_path_for(&managed_path, id);
        self.conn.execute(
            "UPDATE documents SET history_dir_path = ?1 WHERE id = ?2",
            params![self.encode_path_ref(&history_dir), id],
        )?;
        self.conn.execute(
            r#"
            INSERT INTO document_versions (
              document_id, version_number, name, source_path, managed_path, created_at
            )
            VALUES (?1, 1, ?2, ?3, ?4, ?5)
            "#,
            params![
                id,
                resolved_name,
                self.encode_path_ref(&managed_path),
                self.encode_path_ref(&managed_path),
                timestamp
            ],
        )?;
        self.touch_project(input.project_id)?;
        if let Some(activity_id) = input.activity_id {
            self.touch_activity(activity_id)?;
        }
        self.document_record(id)
    }

    pub fn document_update_meta(
        &mut self,
        input: DocumentUpdateMetaInput,
    ) -> Result<DocumentRecord> {
        let timestamp = now_iso();
        let current = self.document_record(input.document_id)?;
        self.ensure_project_file_layout(current.project_id)?;
        let next_activity_id = input.activity_id.unwrap_or(current.activity_id);
        let next_base_name = match input.base_name.as_deref() {
            Some(base_name) => self.normalize_document_base_name(base_name, &current.base_name)?,
            None => current.base_name.clone(),
        };

        if next_activity_id != current.activity_id || next_base_name != current.base_name {
            self.move_document_storage(&current, next_activity_id, &next_base_name)?;
        }

        self.conn.execute(
            "UPDATE documents SET activity_id = ?1, base_name = ?2, is_starred = ?3, updated_at = ?4 WHERE id = ?5",
            params![
                next_activity_id,
                next_base_name,
                bool_to_int(input.is_starred.unwrap_or(current.is_starred)),
                timestamp,
                input.document_id
            ],
        )?;
        if let Some(tag_ids) = input.tag_ids.as_deref() {
            self.replace_document_tags(input.document_id, tag_ids, &timestamp)?;
        }
        self.touch_project(current.project_id)?;
        if let Some(activity_id) = current.activity_id {
            self.touch_activity(activity_id)?;
        }
        if let Some(activity_id) = next_activity_id {
            if Some(activity_id) != current.activity_id {
                self.touch_activity(activity_id)?;
            }
        }
        self.document_record(input.document_id)
    }

    pub fn document_relocate(&mut self, input: DocumentRelocateInput) -> Result<DocumentRecord> {
        let current = self.document_record(input.document_id)?;
        self.ensure_project_file_layout(current.project_id)?;
        let new_source = PathBuf::from(&input.new_source_path);
        if !new_source.exists() {
            return Err(anyhow!("relocation source file does not exist"));
        }

        let managed_path = PathBuf::from(&current.managed_path);
        if let Some(parent) = managed_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&new_source, &managed_path)?;

        self.conn.execute(
            r#"
            UPDATE documents
            SET original_path = ?1, health = 'normal', updated_at = ?2
            WHERE id = ?3
            "#,
            params![
                self.encode_path_ref(&new_source),
                now_iso(),
                input.document_id
            ],
        )?;
        self.conn.execute(
            r#"
            UPDATE document_versions
            SET source_path = ?1
            WHERE document_id = ?2 AND version_number = ?3
            "#,
            params![
                self.encode_path_ref(&new_source),
                input.document_id,
                current.current_version_number
            ],
        )?;
        if let Some(activity_id) = current.activity_id {
            self.touch_activity(activity_id)?;
        } else {
            self.touch_project(current.project_id)?;
        }
        self.document_record(input.document_id)
    }

    pub fn document_list_versions(
        &mut self,
        input: DocumentListVersionsInput,
    ) -> Result<Vec<DocumentVersionRecord>> {
        let document = self.document_record(input.document_id)?;
        self.ensure_project_file_layout(document.project_id)?;
        self.fetch_document_versions(input.document_id)
    }

    pub fn document_add_version(
        &mut self,
        input: DocumentAddVersionInput,
    ) -> Result<DocumentRecord> {
        let timestamp = now_iso();
        let current = self.document_record(input.document_id)?;
        self.ensure_project_file_layout(current.project_id)?;
        let current_path = PathBuf::from(&current.managed_path);
        if !current_path.exists() {
            return Err(anyhow!(
                "current document file is missing; please relocate it before adding a version"
            ));
        }

        let project = self.project_record(current.project_id)?;
        let target_dir = self.document_target_dir(current.project_id, current.activity_id)?;
        let history_dir = PathBuf::from(&current.history_dir_path);
        let previous_version_name =
            versioned_file_name(&current.base_name, current.current_version_number);
        let previous_history_path = history_dir.join(&previous_version_name);
        let next_version_number = current.current_version_number + 1;
        let next_name = versioned_file_name(&current.base_name, next_version_number);
        let next_path = target_dir.join(&next_name);
        let current_source_path_ref = self
            .document_version_source_path_ref(input.document_id, current.current_version_number)?;
        let source = input.source_path.as_deref().map(PathBuf::from);

        if let Some(source) = source.as_ref() {
            if !source.exists() {
                return Err(anyhow!("version source file does not exist"));
            }
            if *source == current_path {
                return Err(anyhow!(
                    "cannot add a version from the current managed file"
                ));
            }
            if next_path.exists() && next_path != *source {
                return Err(anyhow!("target version file already exists"));
            }
        } else if next_path.exists() {
            return Err(anyhow!("target version file already exists"));
        }

        fs::create_dir_all(&history_dir)?;
        fs::rename(&current_path, &previous_history_path).with_context(|| {
            format!(
                "failed to archive current version from {} to {}",
                current_path.display(),
                previous_history_path.display()
            )
        })?;

        let (storage_mode, next_source_path_ref) = if let Some(source) = source.as_ref() {
            match self.materialize_file_for_target(
                Path::new(&project.root_path),
                source,
                &next_path,
            ) {
                Ok(storage_mode) => (storage_mode, self.encode_path_ref(source)),
                Err(error) => {
                    let _ = fs::rename(&previous_history_path, &current_path);
                    return Err(error);
                }
            }
        } else {
            if let Err(error) = fs::copy(&previous_history_path, &next_path).with_context(|| {
                format!(
                    "failed to copy archived version from {} to {}",
                    previous_history_path.display(),
                    next_path.display()
                )
            }) {
                let _ = fs::rename(&previous_history_path, &current_path);
                return Err(error);
            }
            ("managed_copy".to_string(), current_source_path_ref.clone())
        };

        if source.is_some() {
            self.conn.execute(
                r#"
                UPDATE documents
                SET name = ?1,
                    original_path = ?2,
                    managed_path = ?3,
                    storage_mode = ?4,
                    current_version_number = ?5,
                    version_count = ?6,
                    updated_at = ?7
                WHERE id = ?8
                "#,
                params![
                    next_name,
                    &next_source_path_ref,
                    self.encode_path_ref(&next_path),
                    storage_mode,
                    next_version_number,
                    current.version_count + 1,
                    timestamp,
                    input.document_id
                ],
            )?;
        } else {
            self.conn.execute(
                r#"
                UPDATE documents
                SET name = ?1,
                    managed_path = ?2,
                    storage_mode = ?3,
                    current_version_number = ?4,
                    version_count = ?5,
                    updated_at = ?6
                WHERE id = ?7
                "#,
                params![
                    next_name,
                    self.encode_path_ref(&next_path),
                    storage_mode,
                    next_version_number,
                    current.version_count + 1,
                    timestamp,
                    input.document_id
                ],
            )?;
        }
        self.conn.execute(
            r#"
            UPDATE document_versions
            SET name = ?1, managed_path = ?2
            WHERE document_id = ?3 AND version_number = ?4
            "#,
            params![
                previous_version_name,
                self.encode_path_ref(&previous_history_path),
                input.document_id,
                current.current_version_number
            ],
        )?;
        self.conn.execute(
            r#"
            INSERT INTO document_versions (
              document_id, version_number, name, source_path, managed_path, created_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
            params![
                input.document_id,
                next_version_number,
                next_name,
                &next_source_path_ref,
                self.encode_path_ref(&next_path),
                timestamp
            ],
        )?;

        self.touch_project(current.project_id)?;
        if let Some(activity_id) = current.activity_id {
            self.touch_activity(activity_id)?;
        }
        self.document_record(input.document_id)
    }

    pub fn document_delete(&mut self, input: DocumentDeleteInput) -> Result<DocumentRecord> {
        let current = self.document_record(input.document_id)?;
        self.ensure_project_file_layout(current.project_id)?;

        let managed_assets = collect_document_managed_assets_for_delete(&current);
        move_paths_to_trash(&managed_assets)?;

        self.conn
            .execute("DELETE FROM documents WHERE id = ?1", [input.document_id])?;

        self.touch_project(current.project_id)?;
        if let Some(activity_id) = current.activity_id {
            self.touch_activity(activity_id)?;
        }

        Ok(current)
    }

    pub fn ai_generate_note_suggestions(
        &mut self,
        input: AiGenerateInput,
    ) -> Result<Vec<AiSuggestionRecord>> {
        self.ensure_ai_capability_enabled("suggestion_generation")?;

        let (activity_title, source_text) =
            self.ai_source(input.project_id, input.activity_id, input.note_id)?;
        let profile = self.resolve_profile_for_capability("suggestion_generation")?;
        let feature_settings = self.ai_feature_settings_get()?;
        let allow_conclusions =
            ai_feature_enabled(&feature_settings, "suggestion_generation.conclusion")?;
        let allow_todos = ai_feature_enabled(&feature_settings, "suggestion_generation.todo")?;
        if !allow_conclusions && !allow_todos {
            return Err(anyhow!(
                "AI suggestion generation has no enabled output types in workspace settings"
            ));
        }
        self.conn.execute(
            "DELETE FROM ai_suggestions WHERE project_id = ?1 AND activity_id = ?2 AND status = 'pending'",
            params![input.project_id, input.activity_id],
        )?;

        let payload = ai_provider::generate_suggestions(&profile, &activity_title, &source_text)?;
        let timestamp = now_iso();

        if let Some(proposed_title) = payload
            .activity_title
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty() && *value != activity_title.trim())
        {
            self.insert_ai_suggestion(
                input.project_id,
                Some(input.activity_id),
                input.note_id,
                "activity_title",
                "活动标题建议",
                proposed_title,
                json!({ "proposedTitle": proposed_title }),
                &timestamp,
            )?;
        }

        if allow_conclusions {
            for content in payload.conclusions.iter().take(3) {
                self.insert_ai_suggestion(
                    input.project_id,
                    Some(input.activity_id),
                    input.note_id,
                    "conclusion",
                    "结论候选",
                    content,
                    json!({
                        "content": content,
                        "promotedToProject": true
                    }),
                    &timestamp,
                )?;
            }
        }

        if allow_todos {
            for content in payload.todos.iter().take(3) {
                let priority = infer_todo_priority(content);
                self.insert_ai_suggestion(
                    input.project_id,
                    Some(input.activity_id),
                    input.note_id,
                    "todo",
                    "待办候选",
                    content,
                    json!({
                        "content": content,
                        "priority": priority
                    }),
                    &timestamp,
                )?;
            }
        }

        self.fetch_ai_suggestions(Some(input.activity_id))
    }

    pub fn ai_accept_suggestion(
        &mut self,
        input: AiAcceptSuggestionInput,
    ) -> Result<AcceptedSuggestionResult> {
        let suggestion = self.ai_suggestion_record(input.suggestion_id)?;
        let timestamp = now_iso();
        let merged_payload =
            merge_ai_suggestion_payload(&suggestion.payload, input.payload_override.as_ref());

        let entity_kind;
        let entity_id;
        match suggestion.suggestion_type.as_str() {
            "activity_title" => {
                let proposed_title = suggestion_payload_string(
                    &merged_payload,
                    "proposedTitle",
                    "missing proposedTitle",
                )?;
                let activity_id = suggestion
                    .activity_id
                    .ok_or_else(|| anyhow!("title suggestion requires activity"))?;
                let next_title = normalize_activity_title(proposed_title, activity_id);
                self.ensure_project_file_layout(suggestion.project_id)?;
                let current = self.activity_row(activity_id)?;
                self.rename_activity_folder(activity_id, &current, &next_title, &timestamp)?;
                self.conn.execute(
                    "UPDATE activities SET title = ?1, updated_at = ?2 WHERE id = ?3",
                    params![next_title, timestamp, activity_id],
                )?;
                entity_kind = "activity".to_string();
                entity_id = activity_id;
            }
            "conclusion" => {
                let content = suggestion_payload_string(
                    &merged_payload,
                    "content",
                    "missing conclusion content",
                )?;
                self.conn.execute(
                    r#"
                    INSERT INTO conclusions (
                      project_id, activity_id, note_id, content_markdown, content_html, content, promoted_to_project, created_at, updated_at
                    )
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                    "#,
                    params![
                        suggestion.project_id,
                        suggestion.activity_id,
                        suggestion.note_id,
                        content,
                        "",
                        content,
                        bool_to_int(
                            merged_payload
                                .get("promotedToProject")
                                .and_then(Value::as_bool)
                                .unwrap_or(true)
                        ),
                        timestamp,
                        timestamp
                    ],
                )?;
                entity_kind = "conclusion".to_string();
                entity_id = self.conn.last_insert_rowid();
            }
            "todo" => {
                let content =
                    suggestion_payload_string(&merged_payload, "content", "missing todo content")?;
                let priority = merged_payload
                    .get("priority")
                    .and_then(Value::as_str)
                    .filter(|value| is_todo_priority(value))
                    .unwrap_or_else(|| infer_todo_priority(content));
                self.conn.execute(
                    r#"
                    INSERT INTO todos (
                      project_id, activity_id, content, status, priority, created_at, updated_at
                    )
                    VALUES (?1, ?2, ?3, 'unfinished', ?4, ?5, ?6)
                    "#,
                    params![
                        suggestion.project_id,
                        suggestion.activity_id,
                        content,
                        priority,
                        timestamp,
                        timestamp
                    ],
                )?;
                entity_kind = "todo".to_string();
                entity_id = self.conn.last_insert_rowid();
            }
            _ => return Err(anyhow!("unsupported suggestion type")),
        }

        let preview = ai_suggestion_preview(&suggestion.suggestion_type, &merged_payload)?;
        self.conn.execute(
            "UPDATE ai_suggestions SET payload_json = ?1, preview = ?2, status = 'accepted', accepted_at = ?3 WHERE id = ?4",
            params![merged_payload.to_string(), preview, timestamp, input.suggestion_id],
        )?;
        self.touch_project(suggestion.project_id)?;
        if let Some(activity_id) = suggestion.activity_id {
            self.touch_activity(activity_id)?;
        }

        Ok(AcceptedSuggestionResult {
            suggestion: self.ai_suggestion_record(input.suggestion_id)?,
            entity_kind,
            entity_id,
        })
    }

    pub fn ai_artifact_get(
        &mut self,
        input: AiArtifactGetInput,
    ) -> Result<Option<AiArtifactRecord>> {
        let resolved = self.resolve_artifact_request(input)?;
        if let Some(project_id) = resolved.project_id {
            self.ensure_project_file_layout(project_id)?;
            self.refresh_document_health(project_id)?;
        }
        self.ai_artifact_record_by_scope(
            resolved.spec.kind,
            resolved.project_id,
            resolved.activity_id,
            resolved.artifact_date.as_deref(),
        )
    }

    pub fn ai_artifact_refresh(&mut self, input: AiArtifactGetInput) -> Result<AiArtifactRecord> {
        let resolved = self.resolve_artifact_request(input)?;
        self.ensure_ai_feature_enabled(ai_feature_key_for_artifact_kind(resolved.spec.kind)?)?;
        if let Some(project_id) = resolved.project_id {
            self.ensure_project_file_layout(project_id)?;
            self.refresh_document_health(project_id)?;
        }

        let profile = self.resolve_profile_for_capability("summary")?;
        let context = self.build_artifact_context(
            resolved.spec,
            resolved.project_id,
            resolved.activity_id,
            resolved.artifact_date.clone(),
        )?;
        let timestamp = now_iso();
        match ai_provider::generate_artifact(
            &profile,
            resolved.spec.artifact_name,
            resolved.spec.section_titles,
            &context.context_text,
        ) {
            Ok(payload) => {
                self.upsert_ai_artifact_success(resolved.spec, context, payload, &timestamp)
            }
            Err(error) => self.upsert_ai_artifact_error(
                resolved.spec,
                context.project_id,
                context.activity_id,
                context.artifact_date.as_deref(),
                &context.source_updated_at,
                &timestamp,
                &error.to_string(),
            ),
        }
    }

    pub fn ai_answer_question(&mut self, input: AiAnswerQuestionInput) -> Result<AiAnswerResult> {
        self.ensure_ai_capability_enabled("assistant")?;
        let resolved = self.resolve_ai_answer_request(input)?;
        if let Some(project_id) = resolved.project_id {
            self.ensure_project_file_layout(project_id)?;
            self.refresh_document_health(project_id)?;
        }

        let profile = self.resolve_profile_for_capability("assistant")?;
        let context_sources = self.build_ai_answer_sources(
            &resolved.scope,
            resolved.project_id,
            resolved.activity_id,
        )?;
        let ranked_sources = rank_ask_sources(&resolved.question, context_sources);
        if ranked_sources.is_empty() || ranked_sources[0].0 < 12 {
            return Ok(insufficient_ai_answer(
                resolved.scope,
                "当前作用域内没有足够的直接依据，暂时不能可靠回答这个问题。可以换一个更具体的问法，或切到更贴近内容的范围继续提问。",
            ));
        }

        let sources = select_ask_sources(ranked_sources, 8);
        let generated_at = now_iso();
        let context_text = render_ask_context(
            resolved.scope.as_str(),
            resolved.project_id,
            resolved.activity_id,
            &resolved.question,
            &sources,
        );
        let payload = ai_provider::generate_answer(
            &profile,
            resolved.scope.as_str(),
            &resolved.question,
            &context_text,
        )?;
        let allowed_refs = sources
            .iter()
            .map(|source| (source.ref_code.clone(), source))
            .collect::<HashMap<_, _>>();
        let citations =
            payload
                .citations
                .into_iter()
                .filter_map(|ref_code| {
                    allowed_refs.get(ref_code.trim()).cloned().map(|source| {
                        AiAnswerCitationRecord {
                            ref_code: source.ref_code.clone(),
                            source_kind: source.source_kind.clone(),
                            source_id: source.source_id,
                            project_id: source.project_id,
                            activity_id: source.activity_id,
                            label: source.label.clone(),
                            excerpt: source.excerpt.clone(),
                        }
                    })
                })
                .fold(Vec::new(), |mut acc, citation| {
                    if !acc.iter().any(|existing: &AiAnswerCitationRecord| {
                        existing.ref_code == citation.ref_code
                    }) {
                        acc.push(citation);
                    }
                    acc
                });

        if citations.is_empty() {
            return Ok(insufficient_ai_answer(
                resolved.scope,
                "检索到了相关资料，但当前证据还不足以给出可引用的可靠答案。建议换成更具体的问题，或缩小到当前项目 / 当前活动范围继续提问。",
            ));
        }

        let answer_markdown = payload.answer_markdown.trim();
        if answer_markdown.is_empty() {
            return Ok(insufficient_ai_answer(
                resolved.scope,
                "当前资料还不足以形成稳定答案，建议补充更明确的问题或更多记录后再试。",
            ));
        }

        Ok(AiAnswerResult {
            answer_markdown: truncate_text(answer_markdown, 4000),
            citations,
            scope: resolved.scope,
            generated_at,
            skill_key: ASK_SKILL.skill_key.to_string(),
            skill_version: ASK_SKILL.skill_version.to_string(),
        })
    }

    pub fn ai_settings_get(&mut self) -> Result<AiSettingsSnapshot> {
        let profiles = self.fetch_ai_profiles()?;
        let bindings = self.fetch_ai_bindings()?;
        let execution = self.ai_execution_settings_get()?;
        let feature_settings = self.ai_feature_settings_get()?;
        let editor_rewrite_actions = self.ai_editor_rewrite_actions_get()?;

        Ok(AiSettingsSnapshot {
            has_usable_default: self.has_usable_profile_for_capability("default")?,
            profiles,
            bindings,
            security_mode: WORKSPACE_SECURITY_MODE.to_string(),
            ai_secrets_unlocked: self.secret_password.is_some(),
            execution,
            feature_settings,
            editor_rewrite_actions,
        })
    }

    pub fn ai_editor_rewrite_actions_get(&mut self) -> Result<Vec<AiEditorRewriteActionRecord>> {
        let stored = self
            .conn
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = ?1",
                params![APP_SETTING_KEY_AI_EDITOR_REWRITE_ACTIONS],
                |row| row.get::<_, String>(0),
            )
            .optional()?;

        let mut actions = if let Some(value_json) = stored {
            serde_json::from_str::<Vec<AiEditorRewriteActionRecord>>(&value_json)
                .context("failed to parse AI editor rewrite actions")?
        } else {
            Vec::new()
        };

        for action in &actions {
            validate_ai_editor_rewrite_action_fields(&action.label, &action.prompt)?;
        }

        actions.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });

        Ok(actions)
    }

    pub fn ai_editor_rewrite_action_upsert(
        &mut self,
        input: AiEditorRewriteActionUpsertInput,
    ) -> Result<AiEditorRewriteActionRecord> {
        validate_ai_editor_rewrite_action_fields(&input.label, &input.prompt)?;

        let mut actions = self.ai_editor_rewrite_actions_get()?;
        let now = now_iso();

        let saved = if let Some(action_id) = input.id {
            let action = actions
                .iter_mut()
                .find(|action| action.id == action_id)
                .ok_or_else(|| anyhow!("AI editor rewrite action does not exist"))?;
            action.label = input.label.trim().to_string();
            action.prompt = input.prompt.trim().to_string();
            action.enabled = input.enabled;
            action.updated_at = now.clone();
            action.clone()
        } else {
            let next_id = actions.iter().map(|action| action.id).max().unwrap_or(0) + 1;
            let action = AiEditorRewriteActionRecord {
                id: next_id,
                label: input.label.trim().to_string(),
                prompt: input.prompt.trim().to_string(),
                enabled: input.enabled,
                created_at: now.clone(),
                updated_at: now,
            };
            actions.push(action.clone());
            action
        };

        self.persist_ai_editor_rewrite_actions(&actions)?;
        Ok(saved)
    }

    pub fn ai_editor_rewrite_action_delete(
        &mut self,
        input: AiEditorRewriteActionDeleteInput,
    ) -> Result<Vec<AiEditorRewriteActionRecord>> {
        let mut actions = self.ai_editor_rewrite_actions_get()?;
        let initial_len = actions.len();
        actions.retain(|action| action.id != input.action_id);
        if actions.len() == initial_len {
            return Err(anyhow!("AI editor rewrite action does not exist"));
        }

        self.persist_ai_editor_rewrite_actions(&actions)?;
        Ok(actions)
    }

    fn persist_ai_editor_rewrite_actions(
        &mut self,
        actions: &[AiEditorRewriteActionRecord],
    ) -> Result<()> {
        let value_json = serde_json::to_string(actions)?;
        let now = now_iso();
        self.conn.execute(
            r#"
            INSERT INTO app_settings (key, value_json, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(key) DO UPDATE SET
              value_json = excluded.value_json,
              updated_at = excluded.updated_at
            "#,
            params![APP_SETTING_KEY_AI_EDITOR_REWRITE_ACTIONS, value_json, now],
        )?;
        Ok(())
    }

    pub fn ai_feature_settings_get(&mut self) -> Result<AiFeatureSettings> {
        let stored = self
            .conn
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = ?1",
                params![APP_SETTING_KEY_AI_FEATURE_SETTINGS],
                |row| row.get::<_, String>(0),
            )
            .optional()?;

        if let Some(value_json) = stored {
            return parse_ai_feature_settings_json(&value_json);
        }

        Ok(default_ai_feature_settings())
    }

    pub fn ai_feature_settings_upsert(
        &mut self,
        input: AiFeatureSettings,
    ) -> Result<AiFeatureSettings> {
        let now = now_iso();
        let mut value = serde_json::to_value(&input)?;
        normalize_ai_feature_settings_value(&mut value)?;
        let settings: AiFeatureSettings = serde_json::from_value(value.clone())
            .context("failed to decode AI feature settings")?;
        let value_json = serde_json::to_string(&value)?;

        self.conn.execute(
            r#"
            INSERT INTO app_settings (key, value_json, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(key) DO UPDATE SET
              value_json = excluded.value_json,
              updated_at = excluded.updated_at
            "#,
            params![APP_SETTING_KEY_AI_FEATURE_SETTINGS, value_json, now],
        )?;

        Ok(settings)
    }

    fn ensure_ai_capability_enabled(&mut self, capability: &str) -> Result<()> {
        if capability == "default" {
            return Ok(());
        }

        let settings = self.ai_feature_settings_get()?;
        if !settings.master_enabled {
            return Err(anyhow!("AI is disabled in workspace settings"));
        }

        if !settings
            .capabilities
            .get(capability)
            .copied()
            .unwrap_or(true)
        {
            return Err(anyhow!(
                "AI capability '{}' is disabled in workspace settings",
                capability
            ));
        }

        Ok(())
    }

    fn ensure_ai_feature_enabled(&mut self, feature_key: &str) -> Result<()> {
        let settings = self.ai_feature_settings_get()?;
        if !settings.master_enabled {
            return Err(anyhow!("AI is disabled in workspace settings"));
        }

        let capability = ai_capability_for_feature(feature_key)?;
        if !settings
            .capabilities
            .get(capability)
            .copied()
            .unwrap_or(true)
        {
            return Err(anyhow!(
                "AI capability '{}' is disabled in workspace settings",
                capability
            ));
        }

        if !ai_feature_enabled(&settings, feature_key)? {
            return Err(anyhow!(
                "AI feature '{}' is disabled in workspace settings",
                feature_key
            ));
        }

        Ok(())
    }

    pub fn ai_execution_settings_get(&mut self) -> Result<AiExecutionSettings> {
        let stored = self
            .conn
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = ?1",
                params![APP_SETTING_KEY_AI_EXECUTION_SETTINGS],
                |row| row.get::<_, String>(0),
            )
            .optional()?;

        if let Some(value_json) = stored {
            let settings: AiExecutionSettings = serde_json::from_str(&value_json)
                .context("failed to parse AI execution settings")?;
            validate_ai_execution_settings(&settings)?;
            return Ok(settings);
        }

        Ok(default_ai_execution_settings())
    }

    pub fn ai_execution_settings_upsert(
        &mut self,
        input: AiExecutionSettings,
    ) -> Result<AiExecutionSettings> {
        validate_ai_execution_settings(&input)?;
        let now = now_iso();
        let value_json = serde_json::to_string(&input)?;

        self.conn.execute(
            r#"
            INSERT INTO app_settings (key, value_json, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(key) DO UPDATE SET
              value_json = excluded.value_json,
              updated_at = excluded.updated_at
            "#,
            params![APP_SETTING_KEY_AI_EXECUTION_SETTINGS, value_json, now],
        )?;

        self.ai_execution_settings_get()
    }

    pub fn rich_text_style_get(&mut self) -> Result<RichTextStyleSettings> {
        let stored = self
            .conn
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = ?1",
                params![APP_SETTING_KEY_RICH_TEXT_STYLE],
                |row| row.get::<_, String>(0),
            )
            .optional()?;

        if let Some(value_json) = stored {
            let mut value: Value =
                serde_json::from_str(&value_json).context("failed to parse rich text style")?;
            normalize_rich_text_style_value(&mut value)?;
            let settings: RichTextStyleSettings =
                serde_json::from_value(value).context("failed to parse rich text style")?;
            validate_rich_text_style_settings(&settings)?;
            return Ok(settings);
        }

        Ok(default_rich_text_style_settings())
    }

    pub fn rich_text_style_upsert(
        &mut self,
        input: RichTextStyleUpsertInput,
    ) -> Result<RichTextStyleSettings> {
        validate_rich_text_style_settings(&input)?;
        let now = now_iso();
        let value_json = serde_json::to_string(&input)?;

        self.conn.execute(
            r#"
            INSERT INTO app_settings (key, value_json, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(key) DO UPDATE SET
              value_json = excluded.value_json,
              updated_at = excluded.updated_at
            "#,
            params![APP_SETTING_KEY_RICH_TEXT_STYLE, value_json, now],
        )?;

        self.rich_text_style_get()
    }

    pub fn ai_profile_upsert(
        &mut self,
        input: AiProviderProfileUpsertInput,
    ) -> Result<AiProviderProfileRecord> {
        validate_ai_profile_fields(
            &input.name,
            &input.provider_family,
            &input.base_url,
            &input.default_model,
        )?;

        let now = now_iso();
        let encrypted = match input.api_key.as_deref().map(str::trim) {
            Some("") | None => None,
            Some(api_key) => Some(secret_crypto::encrypt_secret(
                api_key,
                self.require_secret_password()?,
            )?),
        };

        if let Some(profile_id) = input.id {
            let current = self.ai_profile_storage(profile_id)?;
            let encrypted = if let Some(encrypted) = encrypted {
                encrypted
            } else {
                secret_crypto::EncryptedSecret {
                    ciphertext_b64: current.api_key_ciphertext.clone(),
                    nonce_b64: current.api_key_nonce.clone(),
                    salt_b64: current.api_key_salt.clone(),
                    last4: current.api_key_last4.clone(),
                }
            };

            self.conn.execute(
                r#"
                UPDATE ai_provider_profiles
                SET name = ?1,
                    provider_family = ?2,
                    base_url = ?3,
                    api_key_ciphertext = ?4,
                    api_key_nonce = ?5,
                    api_key_salt = ?6,
                    api_key_last4 = ?7,
                    default_model = ?8,
                    supports_text = ?9,
                    supports_image = ?10,
                    supports_file = ?11,
                    enabled = ?12,
                    updated_at = ?13
                WHERE id = ?14
                "#,
                params![
                    input.name.trim(),
                    input.provider_family.trim(),
                    normalize_base_url(&input.base_url),
                    encrypted.ciphertext_b64,
                    encrypted.nonce_b64,
                    encrypted.salt_b64,
                    encrypted.last4,
                    input.default_model.trim(),
                    bool_to_int(input.supports_text),
                    bool_to_int(input.supports_image),
                    bool_to_int(input.supports_file),
                    bool_to_int(input.enabled),
                    now,
                    profile_id
                ],
            )?;

            return self.ai_profile_record(profile_id);
        }

        let encrypted =
            encrypted.ok_or_else(|| anyhow!("a new AI profile must include an API key"))?;
        self.conn.execute(
            r#"
            INSERT INTO ai_provider_profiles (
              name, provider_family, base_url, api_key_ciphertext, api_key_nonce, api_key_salt,
              api_key_last4, default_model, supports_text, supports_image, supports_file, enabled,
              created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
            "#,
            params![
                input.name.trim(),
                input.provider_family.trim(),
                normalize_base_url(&input.base_url),
                encrypted.ciphertext_b64,
                encrypted.nonce_b64,
                encrypted.salt_b64,
                encrypted.last4,
                input.default_model.trim(),
                bool_to_int(input.supports_text),
                bool_to_int(input.supports_image),
                bool_to_int(input.supports_file),
                bool_to_int(input.enabled),
                now,
                now
            ],
        )?;

        self.ai_profile_record(self.conn.last_insert_rowid())
    }

    pub fn ai_profile_delete(
        &mut self,
        input: AiProviderProfileDeleteInput,
    ) -> Result<AiSettingsSnapshot> {
        let bindings = self.fetch_ai_bindings()?;
        if let Some(binding) = bindings
            .iter()
            .find(|binding| binding.profile_id == Some(input.profile_id))
        {
            return Err(anyhow!(
                "profile is still used by '{}' binding; update the binding first",
                binding.capability
            ));
        }

        self.conn.execute(
            "DELETE FROM ai_provider_profiles WHERE id = ?1",
            params![input.profile_id],
        )?;
        self.ai_settings_get()
    }

    pub fn ai_profile_test(&mut self, input: AiProfileTestInput) -> Result<AiProfileTestResult> {
        validate_ai_profile_fields(
            &input.name,
            &input.provider_family,
            &input.base_url,
            &input.default_model,
        )?;

        let api_key = if let Some(api_key) = input.api_key.as_ref().map(|value| value.trim()) {
            if api_key.is_empty() {
                None
            } else {
                Some(api_key.to_string())
            }
        } else {
            None
        }
        .or_else(|| {
            input
                .id
                .and_then(|profile_id| self.decrypt_api_key_for_profile(profile_id).ok())
        })
        .ok_or_else(|| anyhow!("testing an AI profile requires an API key"))?;

        let profile = ResolvedAiProfile {
            provider_family: input.provider_family.trim().to_string(),
            base_url: normalize_base_url(&input.base_url),
            api_key,
            model: input.default_model.trim().to_string(),
            supports_text: input.supports_text,
        };
        let outcome = ai_provider::test_profile(&profile)?;

        Ok(AiProfileTestResult {
            success: true,
            message: outcome.message,
            latency_ms: Some(outcome.latency_ms),
            resolved_model: outcome.resolved_model,
        })
    }

    pub fn ai_binding_upsert(
        &mut self,
        input: AiCapabilityBindingUpsertInput,
    ) -> Result<AiCapabilityBindingRecord> {
        validate_ai_binding(&input)?;

        if let Some(profile_id) = input.profile_id {
            self.ai_profile_record(profile_id)?;
        }

        let now = now_iso();
        self.conn.execute(
            r#"
            INSERT INTO ai_capability_bindings (capability, use_default, profile_id, model, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(capability) DO UPDATE SET
              use_default = excluded.use_default,
              profile_id = excluded.profile_id,
              model = excluded.model,
              updated_at = excluded.updated_at
            "#,
            params![
                input.capability.trim(),
                bool_to_int(input.use_default),
                input.profile_id,
                nullable_trimmed(input.model.as_deref()),
                now
            ],
        )?;

        self.ai_binding_record(input.capability.trim())
    }

    pub fn ai_editor_rewrite(
        &mut self,
        input: AiEditorRewriteInput,
        mut on_stream: impl FnMut(String),
    ) -> Result<AiEditorRewriteResult> {
        self.ensure_ai_capability_enabled("editor_rewrite")?;
        let action_id = input.action_id;
        let prompt_override = input
            .prompt_override
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        let action_prompt = match (action_id, prompt_override.as_deref()) {
            (Some(action_id), None) => {
                let actions = self.ai_editor_rewrite_actions_get()?;
                let action = actions
                    .iter()
                    .find(|candidate| candidate.id == action_id)
                    .ok_or_else(|| anyhow!("AI editor rewrite action does not exist"))?;
                if !action.enabled {
                    return Err(anyhow!("AI editor rewrite action is disabled"));
                }
                action.prompt.clone()
            }
            (None, Some(prompt_override)) => prompt_override.to_string(),
            (Some(_), Some(_)) => {
                return Err(anyhow!(
                    "AI editor rewrite requires either action_id or prompt_override, but not both"
                ));
            }
            (None, None) => {
                return Err(anyhow!(
                    "AI editor rewrite requires either action_id or prompt_override"
                ));
            }
        };

        let selected_text = input.selected_text.trim();
        if selected_text.is_empty() {
            return Err(anyhow!("selected text cannot be empty"));
        }

        let expanded_markdown = input.expanded_markdown.trim();
        if expanded_markdown.is_empty() {
            return Err(anyhow!("expanded markdown cannot be empty"));
        }

        let profile = self.resolve_profile_for_capability("editor_rewrite")?;
        let payload = ai_provider::rewrite_selection(
            &profile,
            &action_prompt,
            selected_text,
            expanded_markdown,
            &input.placeholder_tokens,
            input.context.as_ref(),
            |stream_text| on_stream(stream_text),
        )?;
        let rewritten_markdown = normalize_ai_editor_rewrite_markdown(&payload.rewritten_markdown);
        validate_rewrite_placeholder_tokens(&rewritten_markdown, &input.placeholder_tokens)?;

        Ok(AiEditorRewriteResult {
            action_id,
            rewritten_markdown,
            resolved_model: payload.resolved_model,
        })
    }

    pub fn execute_ai_job(&mut self, input: AiJobEnqueueInput) -> Result<AiJobResult> {
        self.execute_ai_job_with_progress(input, |_| {})
    }

    pub fn execute_ai_job_with_progress(
        &mut self,
        input: AiJobEnqueueInput,
        mut on_stream: impl FnMut(String),
    ) -> Result<AiJobResult> {
        match input {
            AiJobEnqueueInput::ArtifactRefresh { input, .. } => {
                let artifact = self.ai_artifact_refresh(input)?;
                Ok(AiJobResult::ArtifactRefresh { artifact })
            }
            AiJobEnqueueInput::AnswerQuestion { input, .. } => {
                let answer = self.ai_answer_question(input)?;
                Ok(AiJobResult::AnswerQuestion { answer })
            }
            AiJobEnqueueInput::NoteSuggestions { input, .. } => {
                let suggestions = self.ai_generate_note_suggestions(input)?;
                Ok(AiJobResult::NoteSuggestions { suggestions })
            }
            AiJobEnqueueInput::ProfileTest { input, .. } => {
                let test_result = self.ai_profile_test(input)?;
                Ok(AiJobResult::ProfileTest { test_result })
            }
            AiJobEnqueueInput::EditorRewrite { input, .. } => {
                let rewrite = self.ai_editor_rewrite(input, |stream_text| on_stream(stream_text))?;
                Ok(AiJobResult::EditorRewrite { rewrite })
            }
        }
    }

    pub fn workspace_search(
        &mut self,
        input: WorkspaceSearchInput,
    ) -> Result<Vec<WorkspaceSearchResult>> {
        let query = input.query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let pattern = format!("%{}%", query);
        let include_archived = input.include_archived.unwrap_or(false);
        let project_filter = if include_archived {
            String::new()
        } else {
            " AND p.is_archived = 0".to_string()
        };
        let mut candidates = Vec::new();

        let project_sql = format!(
            "SELECT p.id, p.name, p.summary, p.updated_at FROM projects p WHERE (p.name LIKE ?1 OR p.summary LIKE ?1){}",
            project_filter
        );
        let mut stmt = self.conn.prepare(&project_sql)?;
        let rows = stmt.query_map([pattern.as_str()], |row| {
            let title: String = row.get(1)?;
            let summary: String = row.get::<_, Option<String>>(2)?.unwrap_or_default();
            Ok(WorkspaceSearchCandidate {
                result: WorkspaceSearchResult {
                    kind: "project".to_string(),
                    id: row.get(0)?,
                    project_id: row.get(0)?,
                    activity_id: None,
                    title: title.clone(),
                    subtitle: summary.clone(),
                    matched_text: query.to_string(),
                },
                fields: build_workspace_search_fields([
                    (WORKSPACE_SEARCH_PRIORITY_PROJECT_NAME, title),
                    (WORKSPACE_SEARCH_PRIORITY_PROJECT_SUMMARY, summary),
                ]),
                updated_at: row.get(3)?,
            })
        })?;
        candidates.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);

        let activity_sql = format!(
            r#"
            SELECT a.id, a.project_id, a.title, COALESCE(ao.label, ''), p.name, COALESCE(a.category, ''), a.updated_at
            FROM activities a
            INNER JOIN projects p ON p.id = a.project_id
            LEFT JOIN activity_attribute_options ao ON ao.id = a.attribute_option_id
            WHERE (a.title LIKE ?1 OR COALESCE(ao.label, '') LIKE ?1 OR a.category LIKE ?1) {}
            "#,
            project_filter
        );
        let mut stmt = self.conn.prepare(&activity_sql)?;
        let rows = stmt.query_map([pattern.as_str()], |row| {
            let title: String = row.get(2)?;
            let attribute_label: String = row.get(3)?;
            let project_name: String = row.get(4)?;
            let category: String = row.get(5)?;
            Ok(WorkspaceSearchCandidate {
                result: WorkspaceSearchResult {
                    kind: "activity".to_string(),
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    activity_id: row.get(0)?,
                    title: title.clone(),
                    subtitle: if attribute_label.trim().is_empty() {
                        project_name
                    } else {
                        format!("{} · {}", project_name, attribute_label)
                    },
                    matched_text: query.to_string(),
                },
                fields: build_workspace_search_fields([
                    (WORKSPACE_SEARCH_PRIORITY_ACTIVITY_TITLE, title),
                    (WORKSPACE_SEARCH_PRIORITY_ACTIVITY_META, attribute_label),
                    (WORKSPACE_SEARCH_PRIORITY_ACTIVITY_META, category),
                ]),
                updated_at: row.get(6)?,
            })
        })?;
        candidates.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);

        let note_sql = format!(
            r#"
            SELECT
              n.id,
              n.project_id,
              n.activity_id,
              CASE
                WHEN NULLIF(TRIM(n.title), '') IS NOT NULL AND TRIM(n.title) != '记录'
                  THEN TRIM(n.title)
                ELSE COALESCE(NULLIF(TRIM(n.content_markdown), ''), '记录')
              END AS title,
              CASE
                WHEN NULLIF(TRIM(n.title), '') IS NOT NULL AND TRIM(n.title) != '记录'
                  THEN TRIM(n.title)
                ELSE ''
              END AS title_match_text,
              COALESCE(NULLIF(TRIM(n.content_markdown), ''), '') AS content_match_text,
              p.name AS project_name,
              COALESCE(NULLIF(TRIM(a.title), ''), '') AS activity_title,
              n.updated_at
            FROM notes n
            INNER JOIN projects p ON p.id = n.project_id
            INNER JOIN activities a ON a.id = n.activity_id
            WHERE (
              (
                NULLIF(TRIM(n.title), '') IS NOT NULL
                AND TRIM(n.title) != '记录'
                AND TRIM(n.title) LIKE ?1
              )
              OR COALESCE(NULLIF(TRIM(n.content_markdown), ''), '') LIKE ?1
              OR COALESCE(NULLIF(TRIM(a.title), ''), '') LIKE ?1
            ) {}
            "#,
            project_filter
        );
        let mut stmt = self.conn.prepare(&note_sql)?;
        let rows = stmt.query_map([pattern.as_str()], |row| {
            let title: String = row.get(3)?;
            let project_name: String = row.get(6)?;
            let activity_title: String = row.get(7)?;
            Ok(WorkspaceSearchCandidate {
                result: WorkspaceSearchResult {
                    kind: "note".to_string(),
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    activity_id: row.get(2)?,
                    title: truncate_text(&normalize_internal_reference_label("note", &title), 72),
                    subtitle: build_internal_reference_subtitle(
                        &project_name,
                        Some(activity_title.as_str()),
                    ),
                    matched_text: query.to_string(),
                },
                fields: build_workspace_search_fields([
                    (WORKSPACE_SEARCH_PRIORITY_NOTE_TITLE, row.get::<_, String>(4)?),
                    (WORKSPACE_SEARCH_PRIORITY_NOTE_CONTENT, row.get::<_, String>(5)?),
                    (WORKSPACE_SEARCH_PRIORITY_ACTIVITY_META, activity_title),
                ]),
                updated_at: row.get(8)?,
            })
        })?;
        candidates.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);

        let conclusion_sql = format!(
            r#"
            SELECT
              c.id,
              c.project_id,
              c.activity_id,
              COALESCE(NULLIF(c.content_markdown, ''), c.content),
              COALESCE(a.title, p.name),
              c.updated_at
            FROM conclusions c
            INNER JOIN projects p ON p.id = c.project_id
            LEFT JOIN activities a ON a.id = c.activity_id
            WHERE (
              COALESCE(NULLIF(c.content_markdown, ''), c.content) LIKE ?1
              OR COALESCE(a.title, '') LIKE ?1
            ) {}
            "#,
            project_filter
        );
        let mut stmt = self.conn.prepare(&conclusion_sql)?;
        let rows = stmt.query_map([pattern.as_str()], |row| {
            let content: String = row.get(3)?;
            let activity_title: String = row.get(4)?;
            Ok(WorkspaceSearchCandidate {
                result: WorkspaceSearchResult {
                    kind: "conclusion".to_string(),
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    activity_id: row.get(2)?,
                    title: truncate_text(
                        &normalize_internal_reference_label("conclusion", &content),
                        72,
                    ),
                    subtitle: activity_title.clone(),
                    matched_text: query.to_string(),
                },
                fields: build_workspace_search_fields([
                    (WORKSPACE_SEARCH_PRIORITY_CONCLUSION_CONTENT, content),
                    (WORKSPACE_SEARCH_PRIORITY_ACTIVITY_META, activity_title),
                ]),
                updated_at: row.get(5)?,
            })
        })?;
        candidates.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);

        let todo_sql = format!(
            r#"
            SELECT t.id, t.project_id, t.activity_id, t.content, COALESCE(a.title, p.name), t.updated_at
            FROM todos t
            INNER JOIN projects p ON p.id = t.project_id
            LEFT JOIN activities a ON a.id = t.activity_id
            WHERE (t.content LIKE ?1 OR COALESCE(a.title, '') LIKE ?1) {}
            "#,
            project_filter
        );
        let mut stmt = self.conn.prepare(&todo_sql)?;
        let rows = stmt.query_map([pattern.as_str()], |row| {
            let content: String = row.get(3)?;
            let activity_title: String = row.get(4)?;
            Ok(WorkspaceSearchCandidate {
                result: WorkspaceSearchResult {
                    kind: "todo".to_string(),
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    activity_id: row.get(2)?,
                    title: truncate_text(&normalize_internal_reference_label("todo", &content), 72),
                    subtitle: activity_title.clone(),
                    matched_text: query.to_string(),
                },
                fields: build_workspace_search_fields([
                    (WORKSPACE_SEARCH_PRIORITY_TODO_CONTENT, content),
                    (WORKSPACE_SEARCH_PRIORITY_ACTIVITY_META, activity_title),
                ]),
                updated_at: row.get(5)?,
            })
        })?;
        candidates.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);

        let document_sql = format!(
            r#"
            SELECT d.id, d.project_id, d.activity_id, d.name, COALESCE(a.title, p.name), d.updated_at
            FROM documents d
            INNER JOIN projects p ON p.id = d.project_id
            LEFT JOIN activities a ON a.id = d.activity_id
            WHERE (d.name LIKE ?1 OR COALESCE(a.title, '') LIKE ?1)
              AND d.storage_mode != '{MANAGED_NOTE_IMAGE_STORAGE_MODE}' {}
            "#,
            project_filter
        );
        let mut stmt = self.conn.prepare(&document_sql)?;
        let rows = stmt.query_map([pattern.as_str()], |row| {
            let title: String = row.get(3)?;
            let activity_title: String = row.get(4)?;
            Ok(WorkspaceSearchCandidate {
                result: WorkspaceSearchResult {
                    kind: "document".to_string(),
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    activity_id: row.get(2)?,
                    title: title.clone(),
                    subtitle: activity_title.clone(),
                    matched_text: query.to_string(),
                },
                fields: build_workspace_search_fields([
                    (WORKSPACE_SEARCH_PRIORITY_DOCUMENT_NAME, title),
                    (WORKSPACE_SEARCH_PRIORITY_ACTIVITY_META, activity_title),
                ]),
                updated_at: row.get(5)?,
            })
        })?;
        candidates.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);

        let mut ranked = candidates
            .into_iter()
            .filter_map(|candidate| {
                rank_workspace_search_candidate(&candidate, query).map(|rank| (candidate.result, candidate.updated_at, rank))
            })
            .collect::<Vec<_>>();

        ranked.sort_by(|(left_result, left_updated_at, left_rank), (right_result, right_updated_at, right_rank)| {
            left_rank
                .cmp(right_rank)
                .then_with(|| right_updated_at.cmp(left_updated_at))
                .then_with(|| left_result.kind.cmp(&right_result.kind))
                .then_with(|| left_result.id.cmp(&right_result.id))
        });

        Ok(ranked
            .into_iter()
            .take(16)
            .map(|(result, _, _)| result)
            .collect())
    }

    pub fn internal_reference_search(
        &mut self,
        input: InternalReferenceSearchInput,
    ) -> Result<Vec<InternalReferenceSearchResult>> {
        let scope = input.scope.trim();
        let limit = if input.limit <= 0 {
            8
        } else {
            input.limit.min(16)
        };
        let project_id = match scope {
            "project" => {
                let Some(project_id) = input.project_id else {
                    return Ok(Vec::new());
                };
                Some(project_id)
            }
            "workspace" => None,
            _ => return Err(anyhow!("unsupported internal reference scope: {scope}")),
        };
        let parsed_query = parse_internal_reference_search_query(&input.query);
        let query = parsed_query.query.trim().to_string();
        let query_is_empty = query.is_empty();
        let mut candidates = Vec::new();

        if parsed_query.kind_filter.is_none()
            || parsed_query
                .kind_filter
                .is_some_and(|kind| kind.matches_result_kind("note"))
        {
            let note_sql = r#"
            SELECT
              n.id,
              n.project_id,
              n.activity_id,
              CASE
                WHEN NULLIF(TRIM(n.title), '') IS NOT NULL AND TRIM(n.title) != '记录'
                  THEN TRIM(n.title)
                ELSE COALESCE(NULLIF(TRIM(n.content_markdown), ''), '记录')
              END AS label,
              CASE
                WHEN NULLIF(TRIM(n.title), '') IS NOT NULL AND TRIM(n.title) != '记录'
                  THEN TRIM(n.title)
                ELSE ''
              END AS title_match_text,
              COALESCE(NULLIF(TRIM(n.content_markdown), ''), '') AS content_match_text,
              p.name AS project_name,
              COALESCE(NULLIF(TRIM(a.title), ''), '') AS activity_title,
              n.updated_at
            FROM notes n
            INNER JOIN projects p ON p.id = n.project_id
            INNER JOIN activities a ON a.id = n.activity_id
            WHERE (?1 IS NULL OR n.project_id = ?1)
            ORDER BY n.updated_at DESC
            "#
            .to_string();
            let mut stmt = self.conn.prepare(&note_sql)?;
            let rows = stmt.query_map(params![project_id], |row| {
                let project_name: String = row.get(6)?;
                let activity_title: String = row.get(7)?;
                Ok(InternalReferenceSearchCandidate {
                    result: InternalReferenceSearchResult {
                        kind: "note".to_string(),
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        activity_id: row.get(2)?,
                        label: truncate_text(
                            &normalize_internal_reference_label("note", &row.get::<_, String>(3)?),
                            72,
                        ),
                        subtitle: build_internal_reference_subtitle(
                            &project_name,
                            Some(activity_title.as_str()),
                        ),
                        updated_at: row.get(8)?,
                    },
                    fields: build_internal_reference_search_fields([
                        (
                            INTERNAL_REFERENCE_PRIORITY_NOTE_TITLE,
                            row.get::<_, String>(4)?,
                        ),
                        (
                            INTERNAL_REFERENCE_PRIORITY_NOTE_CONTENT,
                            row.get::<_, String>(5)?,
                        ),
                        (INTERNAL_REFERENCE_PRIORITY_ACTIVITY_TITLE, activity_title),
                    ]),
                })
            })?;
            candidates.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
        }

        if parsed_query.kind_filter.is_none()
            || parsed_query
                .kind_filter
                .is_some_and(|kind| kind.matches_result_kind("conclusion"))
        {
            let conclusion_sql = r#"
            SELECT
              c.id,
              c.project_id,
              c.activity_id,
              COALESCE(NULLIF(TRIM(c.content_markdown), ''), NULLIF(TRIM(c.content), ''), '结论') AS label,
              COALESCE(NULLIF(TRIM(c.content_markdown), ''), NULLIF(TRIM(c.content), ''), '') AS content_match_text,
              p.name AS project_name,
              COALESCE(NULLIF(TRIM(a.title), ''), '') AS activity_title,
              c.updated_at
            FROM conclusions c
            INNER JOIN projects p ON p.id = c.project_id
            LEFT JOIN activities a ON a.id = c.activity_id
            WHERE (?1 IS NULL OR c.project_id = ?1)
            ORDER BY c.updated_at DESC
            "#
            .to_string();
            let mut stmt = self.conn.prepare(&conclusion_sql)?;
            let rows = stmt.query_map(params![project_id], |row| {
                let project_name: String = row.get(5)?;
                let activity_title: String = row.get(6)?;
                Ok(InternalReferenceSearchCandidate {
                    result: InternalReferenceSearchResult {
                        kind: "conclusion".to_string(),
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        activity_id: row.get(2)?,
                        label: truncate_text(
                            &normalize_internal_reference_label(
                                "conclusion",
                                &row.get::<_, String>(3)?,
                            ),
                            72,
                        ),
                        subtitle: build_internal_reference_subtitle(
                            &project_name,
                            if activity_title.is_empty() {
                                None
                            } else {
                                Some(activity_title.as_str())
                            },
                        ),
                        updated_at: row.get(7)?,
                    },
                    fields: build_internal_reference_search_fields([
                        (
                            INTERNAL_REFERENCE_PRIORITY_CONCLUSION_CONTENT,
                            row.get::<_, String>(4)?,
                        ),
                        (INTERNAL_REFERENCE_PRIORITY_ACTIVITY_TITLE, activity_title),
                    ]),
                })
            })?;
            candidates.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
        }

        if parsed_query.kind_filter.is_none()
            || parsed_query
                .kind_filter
                .is_some_and(|kind| kind.matches_result_kind("todo"))
        {
            let todo_sql = r#"
            SELECT
              t.id,
              t.project_id,
              t.activity_id,
              COALESCE(NULLIF(TRIM(t.content), ''), 'Todo') AS label,
              COALESCE(NULLIF(TRIM(t.content), ''), '') AS content_match_text,
              p.name AS project_name,
              COALESCE(NULLIF(TRIM(a.title), ''), '') AS activity_title,
              t.updated_at
            FROM todos t
            INNER JOIN projects p ON p.id = t.project_id
            LEFT JOIN activities a ON a.id = t.activity_id
            WHERE (?1 IS NULL OR t.project_id = ?1)
            ORDER BY t.updated_at DESC
            "#
            .to_string();
            let mut stmt = self.conn.prepare(&todo_sql)?;
            let rows = stmt.query_map(params![project_id], |row| {
                let project_name: String = row.get(5)?;
                let activity_title: String = row.get(6)?;
                Ok(InternalReferenceSearchCandidate {
                    result: InternalReferenceSearchResult {
                        kind: "todo".to_string(),
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        activity_id: row.get(2)?,
                        label: truncate_text(
                            &normalize_internal_reference_label("todo", &row.get::<_, String>(3)?),
                            72,
                        ),
                        subtitle: build_internal_reference_subtitle(
                            &project_name,
                            if activity_title.is_empty() {
                                None
                            } else {
                                Some(activity_title.as_str())
                            },
                        ),
                        updated_at: row.get(7)?,
                    },
                    fields: build_internal_reference_search_fields([
                        (
                            INTERNAL_REFERENCE_PRIORITY_TODO_CONTENT,
                            row.get::<_, String>(4)?,
                        ),
                        (INTERNAL_REFERENCE_PRIORITY_ACTIVITY_TITLE, activity_title),
                    ]),
                })
            })?;
            candidates.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
        }

        if parsed_query.kind_filter.is_none()
            || parsed_query
                .kind_filter
                .is_some_and(|kind| kind.matches_result_kind("document"))
        {
            let document_sql = format!(
                r#"
            SELECT
              d.id,
              d.project_id,
              d.activity_id,
              d.name AS label,
              d.name AS name_match_text,
              p.name AS project_name,
              COALESCE(NULLIF(TRIM(a.title), ''), '') AS activity_title,
              d.updated_at
            FROM documents d
            INNER JOIN projects p ON p.id = d.project_id
            LEFT JOIN activities a ON a.id = d.activity_id
            WHERE d.storage_mode != '{MANAGED_NOTE_IMAGE_STORAGE_MODE}'
              AND (?1 IS NULL OR d.project_id = ?1)
            ORDER BY d.updated_at DESC
            "#
            );
            let mut stmt = self.conn.prepare(&document_sql)?;
            let rows = stmt.query_map(params![project_id], |row| {
                let project_name: String = row.get(5)?;
                let activity_title: String = row.get(6)?;
                Ok(InternalReferenceSearchCandidate {
                    result: InternalReferenceSearchResult {
                        kind: "document".to_string(),
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        activity_id: row.get(2)?,
                        label: truncate_text(
                            &normalize_internal_reference_label(
                                "document",
                                &row.get::<_, String>(3)?,
                            ),
                            72,
                        ),
                        subtitle: build_internal_reference_subtitle(
                            &project_name,
                            if activity_title.is_empty() {
                                None
                            } else {
                                Some(activity_title.as_str())
                            },
                        ),
                        updated_at: row.get(7)?,
                    },
                    fields: build_internal_reference_search_fields([
                        (
                            INTERNAL_REFERENCE_PRIORITY_DOCUMENT_NAME,
                            row.get::<_, String>(4)?,
                        ),
                        (INTERNAL_REFERENCE_PRIORITY_ACTIVITY_TITLE, activity_title),
                    ]),
                })
            })?;
            candidates.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
        }

        let mut results = if query_is_empty {
            let mut items = candidates
                .into_iter()
                .map(|candidate| candidate.result)
                .collect::<Vec<_>>();
            items.sort_by(|left, right| {
                right
                    .updated_at
                    .cmp(&left.updated_at)
                    .then_with(|| left.kind.cmp(&right.kind))
                    .then_with(|| left.id.cmp(&right.id))
            });
            items
        } else {
            let mut ranked = candidates
                .into_iter()
                .filter_map(|candidate| {
                    rank_internal_reference_search_candidate(&candidate, &query)
                        .map(|rank| (candidate.result, rank))
                })
                .collect::<Vec<_>>();

            ranked.sort_by(|(left_result, left_rank), (right_result, right_rank)| {
                left_rank
                    .cmp(right_rank)
                    .then_with(|| right_result.updated_at.cmp(&left_result.updated_at))
                    .then_with(|| left_result.kind.cmp(&right_result.kind))
                    .then_with(|| left_result.id.cmp(&right_result.id))
            });

            ranked
                .into_iter()
                .map(|(result, _)| result)
                .collect::<Vec<_>>()
        };

        results.truncate(limit as usize);

        Ok(results)
    }

    pub fn internal_reference_resolve(
        &mut self,
        input: InternalReferenceResolveInput,
    ) -> Result<Option<InternalReferenceResolveResult>> {
        match input.kind.trim() {
            "note" => self
                .conn
                .query_row(
                    r#"
                    SELECT
                      n.id,
                      n.project_id,
                      n.activity_id,
                      CASE
                        WHEN NULLIF(TRIM(n.title), '') IS NOT NULL AND TRIM(n.title) != '记录'
                          THEN TRIM(n.title)
                        ELSE COALESCE(NULLIF(TRIM(n.content_markdown), ''), '记录')
                      END AS label
                    FROM notes n
                    WHERE n.id = ?1
                    "#,
                    [input.id],
                    |row| {
                        let id: i64 = row.get(0)?;
                        let project_id: i64 = row.get(1)?;
                        let activity_id: i64 = row.get(2)?;
                        let label = truncate_text(
                            &normalize_internal_reference_label("note", &row.get::<_, String>(3)?),
                            72,
                        );
                        Ok(InternalReferenceResolveResult {
                            kind: "note".to_string(),
                            id,
                            label,
                            project_id,
                            activity_id: Some(activity_id),
                            route: build_activity_note_route(project_id, activity_id, id),
                            focus_id: None,
                        })
                    },
                )
                .optional()
                .map_err(Into::into),
            "conclusion" => self
                .conn
                .query_row(
                    r#"
                    SELECT
                      c.id,
                      c.project_id,
                      c.activity_id,
                      COALESCE(NULLIF(TRIM(c.content_markdown), ''), NULLIF(TRIM(c.content), ''), '结论')
                    FROM conclusions c
                    WHERE c.id = ?1
                    "#,
                    [input.id],
                    |row| {
                        let id: i64 = row.get(0)?;
                        let project_id: i64 = row.get(1)?;
                        let activity_id: Option<i64> = row.get(2)?;
                        Ok(InternalReferenceResolveResult {
                            kind: "conclusion".to_string(),
                            id,
                            label: truncate_text(
                                &normalize_internal_reference_label(
                                    "conclusion",
                                    &row.get::<_, String>(3)?,
                                ),
                                72,
                            ),
                            project_id,
                            activity_id,
                            route: build_internal_reference_route(
                                project_id,
                                activity_id,
                                &format!("conclusion-{id}"),
                            ),
                            focus_id: Some(format!("conclusion-{id}")),
                        })
                    },
                )
                .optional()
                .map_err(Into::into),
            "todo" => self
                .conn
                .query_row(
                    r#"
                    SELECT
                      t.id,
                      t.project_id,
                      t.activity_id,
                      COALESCE(NULLIF(TRIM(t.content), ''), 'Todo')
                    FROM todos t
                    WHERE t.id = ?1
                    "#,
                    [input.id],
                    |row| {
                        let id: i64 = row.get(0)?;
                        let project_id: i64 = row.get(1)?;
                        let activity_id: Option<i64> = row.get(2)?;
                        Ok(InternalReferenceResolveResult {
                            kind: "todo".to_string(),
                            id,
                            label: truncate_text(
                                &normalize_internal_reference_label(
                                    "todo",
                                    &row.get::<_, String>(3)?,
                                ),
                                72,
                            ),
                            project_id,
                            activity_id,
                            route: build_internal_reference_route(
                                project_id,
                                activity_id,
                                &format!("todo-{id}"),
                            ),
                            focus_id: Some(format!("todo-{id}")),
                        })
                    },
                )
                .optional()
                .map_err(Into::into),
            "document" => self
                .conn
                .query_row(
                    r#"
                    SELECT
                      d.id,
                      d.project_id,
                      d.activity_id,
                      d.name
                    FROM documents d
                    WHERE d.id = ?1
                      AND d.storage_mode != ?2
                    "#,
                    params![input.id, MANAGED_NOTE_IMAGE_STORAGE_MODE],
                    |row| {
                        let id: i64 = row.get(0)?;
                        let project_id: i64 = row.get(1)?;
                        let activity_id: Option<i64> = row.get(2)?;
                        Ok(InternalReferenceResolveResult {
                            kind: "document".to_string(),
                            id,
                            label: truncate_text(
                                &normalize_internal_reference_label(
                                    "document",
                                    &row.get::<_, String>(3)?,
                                ),
                                72,
                            ),
                            project_id,
                            activity_id,
                            route: build_internal_reference_route(
                                project_id,
                                activity_id,
                                &format!("document-{id}"),
                            ),
                            focus_id: Some(format!("document-{id}")),
                        })
                    },
                )
                .optional()
                .map_err(Into::into),
            other => Err(anyhow!("unsupported internal reference kind: {other}")),
        }
    }

    pub fn reset_and_seed_demo_data(&mut self, workspace_root: &Path) -> Result<DemoSeedResult> {
        fs::create_dir_all(workspace_root).with_context(|| {
            format!(
                "failed to create demo workspace root at {}",
                workspace_root.display()
            )
        })?;

        self.remove_existing_project_roots_from_disk()?;
        self.clear_seedable_data()?;
        self.ensure_activity_settings_seeded()?;
        self.ensure_record_type_settings_seeded()?;

        let source_root = workspace_root.join("__demo_seed_sources");
        remove_path_if_exists(&source_root)?;
        for project_name in [
            "智能客服知识库升级",
            "海外销售线索评分 Copilot",
            "合同审阅 AI 助手试点",
        ] {
            remove_path_if_exists(
                &workspace_root.join(normalize_windows_safe_component(project_name)),
            )?;
        }
        fs::create_dir_all(&source_root)?;

        let catalog = self.build_demo_seed_catalog()?;
        let project_a =
            self.seed_demo_customer_service_project(workspace_root, &source_root, &catalog)?;
        let project_b =
            self.seed_demo_lead_scoring_project(workspace_root, &source_root, &catalog)?;
        let project_c =
            self.seed_demo_contract_review_project(workspace_root, &source_root, &catalog)?;

        let mock_ai_profile_created = self.ensure_demo_mock_ai_profile_if_needed()?;
        if mock_ai_profile_created {
            for project_id in [
                project_a.project_id,
                project_b.project_id,
                project_c.project_id,
            ] {
                self.ai_artifact_refresh(AiArtifactGetInput {
                    kind: "project_brief".to_string(),
                    project_id: Some(project_id),
                    activity_id: None,
                    artifact_date: None,
                })?;
            }
            for activity_id in project_a
                .activity_ids
                .iter()
                .chain(project_b.activity_ids.iter())
                .chain(project_c.activity_ids.iter())
            {
                let project_id = self.activity_row(*activity_id)?.project_id;
                self.ai_artifact_refresh(AiArtifactGetInput {
                    kind: "activity_summary".to_string(),
                    project_id: Some(project_id),
                    activity_id: Some(*activity_id),
                    artifact_date: None,
                })?;
            }
            self.ai_artifact_refresh(AiArtifactGetInput {
                kind: "daily_brief".to_string(),
                project_id: None,
                activity_id: None,
                artifact_date: Some(current_workspace_date()),
            })?;
        }

        Ok(DemoSeedResult {
            workspace_root: workspace_root.to_string_lossy().to_string(),
            project_count: self.count_table_rows("projects")?,
            activity_count: self.count_table_rows("activities")?,
            note_count: self.count_table_rows("notes")?,
            conclusion_count: self.count_table_rows("conclusions")?,
            todo_count: self.count_table_rows("todos")?,
            document_count: self.count_table_rows("documents")?,
            artifact_count: self.count_table_rows("ai_artifacts")?,
            ai_profile_mode: if mock_ai_profile_created {
                "mock_seeded".to_string()
            } else {
                "preserved".to_string()
            },
        })
    }

    fn remove_existing_project_roots_from_disk(&self) -> Result<()> {
        let mut stmt = self
            .conn
            .prepare("SELECT root_path FROM projects ORDER BY id ASC")?;
        let roots = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        for root_ref in roots {
            let root = self.decode_path_ref(&root_ref);
            remove_path_if_exists(&root).with_context(|| {
                format!(
                    "failed to remove existing project root at {}",
                    root.display()
                )
            })?;
        }

        Ok(())
    }

    fn clear_seedable_data(&mut self) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute_batch(
            r#"
            DELETE FROM ai_artifact_citations;
            DELETE FROM ai_artifacts;
            DELETE FROM ai_suggestions;
            DELETE FROM document_tag_links;
            DELETE FROM document_versions;
            DELETE FROM documents;
            DELETE FROM todo_progresses;
            DELETE FROM todos;
            DELETE FROM conclusions;
            DELETE FROM notes;
            DELETE FROM activities;
            DELETE FROM projects;
            DELETE FROM file_tag_options;
            DELETE FROM record_type_options;
            DELETE FROM activity_attribute_options;
            DELETE FROM activity_status_options;
            DELETE FROM sqlite_sequence
            WHERE name IN (
              'ai_artifact_citations',
              'ai_artifacts',
              'ai_suggestions',
              'documents',
              'document_versions',
              'todos',
              'todo_progresses',
              'conclusions',
              'notes',
              'activities',
              'projects',
              'file_tag_options',
              'record_type_options',
              'activity_attribute_options',
              'activity_status_options'
            );
            "#,
        )?;
        tx.commit()?;
        Ok(())
    }

    fn build_demo_seed_catalog(&mut self) -> Result<DemoSeedCatalog> {
        let mut attribute_ids = HashMap::new();
        for (label, color_key) in [
            ("会议", "blue"),
            ("需求澄清", "teal"),
            ("数据分析", "amber"),
            ("法务评审", "rose"),
            ("实验验证", "green"),
            ("用户反馈", "orange"),
        ] {
            let option =
                self.activity_attribute_option_upsert(ActivityAttributeOptionUpsertInput {
                    id: None,
                    label: label.to_string(),
                    color_key: color_key.to_string(),
                })?;
            attribute_ids.insert(label.to_string(), option.id);
        }

        let mut status_ids = HashMap::new();
        let pending = self.pending_activity_status_option()?;
        status_ids.insert(pending.label.clone(), pending.id);
        for (label, color_key) in [
            ("信息已整理", "green"),
            ("进行中", "blue"),
            ("待跟进", "amber"),
            ("需升级处理", "red"),
            ("已验证", "teal"),
        ] {
            let option = self.activity_status_option_upsert(ActivityStatusOptionUpsertInput {
                id: None,
                label: label.to_string(),
                color_key: color_key.to_string(),
            })?;
            status_ids.insert(label.to_string(), option.id);
        }

        let mut tag_ids = HashMap::new();
        for (label, color_key) in [
            ("PRD", "blue"),
            ("会议纪要", "teal"),
            ("数据样本", "amber"),
            ("评审材料", "orange"),
            ("法务条款", "rose"),
            ("Prompt草案", "slate"),
            ("流程清单", "green"),
        ] {
            let tag = self.file_tag_option_upsert(FileTagOptionUpsertInput {
                id: None,
                label: label.to_string(),
                color_key: color_key.to_string(),
            })?;
            tag_ids.insert(label.to_string(), tag.id);
        }

        for (label, color_key, template_html) in [
            (
                "访谈记录",
                "teal",
                "<h2>受访对象</h2><p></p><h2>关键反馈</h2><p></p><h2>证据片段</h2><p></p><h2>下一步</h2><p></p>",
            ),
            (
                "实验记录",
                "amber",
                "<h2>目标</h2><p></p><h2>样本与方法</h2><p></p><h2>观察</h2><p></p><h2>下一步</h2><p></p>",
            ),
            (
                "法务审查",
                "rose",
                "<h2>审查范围</h2><p></p><h2>风险点</h2><p></p><h2>建议口径</h2><p></p><h2>结论</h2><p></p>",
            ),
        ] {
            self.record_type_option_upsert(RecordTypeOptionUpsertInput {
                id: None,
                label: label.to_string(),
                color_key: color_key.to_string(),
                template_html: template_html.to_string(),
                is_default: false,
            })?;
        }

        let record_type_settings = self.record_type_settings_get()?;
        let record_type_keys = record_type_settings
            .record_types
            .into_iter()
            .map(|record| (record.label, record.key))
            .collect();

        Ok(DemoSeedCatalog {
            attribute_ids,
            status_ids,
            tag_ids,
            record_type_keys,
        })
    }

    fn ensure_demo_mock_ai_profile_if_needed(&mut self) -> Result<bool> {
        if !self.fetch_ai_profiles()?.is_empty() {
            return Ok(false);
        }

        let profile = self.ai_profile_upsert(AiProviderProfileUpsertInput {
            id: None,
            name: "Demo Mock AI".to_string(),
            provider_family: "openai_compatible".to_string(),
            base_url: "https://mock.local/v1".to_string(),
            api_key: Some("demo-mock-key".to_string()),
            default_model: "mock-model".to_string(),
            supports_text: true,
            supports_image: false,
            supports_file: false,
            enabled: true,
        })?;

        self.ai_binding_upsert(AiCapabilityBindingUpsertInput {
            capability: "default".to_string(),
            use_default: false,
            profile_id: Some(profile.id),
            model: None,
        })?;
        for capability in [
            "assistant",
            "summary",
            "suggestion_generation",
            "editor_rewrite",
        ] {
            self.ai_binding_upsert(AiCapabilityBindingUpsertInput {
                capability: capability.to_string(),
                use_default: true,
                profile_id: None,
                model: None,
            })?;
        }

        Ok(true)
    }

    fn count_table_rows(&self, table: &str) -> Result<i64> {
        let sql = format!("SELECT COUNT(*) FROM {table}");
        self.conn
            .query_row(&sql, [], |row| row.get(0))
            .map_err(Into::into)
    }

    fn create_demo_note(
        &mut self,
        project_id: i64,
        activity_id: i64,
        note_type: &str,
        title: &str,
        markdown: &str,
    ) -> Result<NoteRecord> {
        self.note_upsert(NoteUpsertInput {
            project_id,
            activity_id,
            note_id: None,
            note_type: note_type.to_string(),
            title: Some(title.to_string()),
            markdown: markdown.to_string(),
            html: rich_text_html_from_markdown(markdown),
        })
    }

    fn create_demo_conclusion(
        &mut self,
        project_id: i64,
        activity_id: Option<i64>,
        note_id: Option<i64>,
        markdown: &str,
        promoted_to_project: bool,
    ) -> Result<ConclusionRecord> {
        self.conclusion_create(ConclusionCreateInput {
            project_id,
            activity_id,
            note_id,
            markdown: markdown.to_string(),
            html: rich_text_html_from_markdown(markdown),
            promoted_to_project,
            is_pinned: None,
        })
    }

    fn create_demo_todo(
        &mut self,
        project_id: i64,
        activity_id: Option<i64>,
        content: &str,
        priority: &str,
        progresses: &[(&str, &str)],
        finished: bool,
    ) -> Result<TodoRecord> {
        let todo = self.todo_create(TodoCreateInput {
            project_id,
            activity_id,
            content: content.to_string(),
            priority: priority.to_string(),
        })?;

        for (progress_date, progress_content) in progresses {
            self.todo_add_progress(TodoAddProgressInput {
                todo_id: todo.id,
                content: (*progress_content).to_string(),
                progress_date: (*progress_date).to_string(),
            })?;
        }

        if finished {
            self.todo_update_status(TodoUpdateStatusInput {
                todo_id: todo.id,
                status: "finished".to_string(),
            })?;
        }

        self.todo_record(todo.id)
    }

    fn write_demo_source_file(
        &self,
        source_root: &Path,
        scope: &str,
        file_name: &str,
        contents: &str,
    ) -> Result<PathBuf> {
        let target_dir = source_root.join(scope);
        fs::create_dir_all(&target_dir)?;
        let path = target_dir.join(file_name);
        fs::write(&path, contents)
            .with_context(|| format!("failed to write demo source file at {}", path.display()))?;
        Ok(path)
    }

    fn import_demo_document(
        &mut self,
        project_id: i64,
        activity_id: Option<i64>,
        source_path: &Path,
        is_starred: bool,
        tag_ids: &[i64],
    ) -> Result<DocumentRecord> {
        self.document_import(DocumentImportInput {
            project_id,
            activity_id,
            source_path: source_path.to_string_lossy().to_string(),
            is_starred,
            tag_ids: if tag_ids.is_empty() {
                None
            } else {
                Some(tag_ids.to_vec())
            },
        })
    }

    fn seed_demo_customer_service_project(
        &mut self,
        _workspace_root: &Path,
        source_root: &Path,
        catalog: &DemoSeedCatalog,
    ) -> Result<SeededProjectRefs> {
        let project = self.project_create(ProjectCreateInput {
            name: "智能客服知识库升级".to_string(),
            summary: Some("目标是在 6 周内把退款、物流、账户三类高频问题沉淀为可检索知识库，并让 AI 助手引用统一口径。当前处于数据清洗与法务边界确认阶段。".to_string()),
            status: Some("active".to_string()),
        })?;

        let kickoff = self.activity_create(ActivityCreateInput {
            project_id: project.id,
            attribute_option_id: Some(catalog.attribute_id("会议")?),
            title: Some("Kickoff 范围对齐".to_string()),
            activity_time: "2026-04-02T01:30:00.000Z".to_string(),
        })?;
        self.activity_update_meta(ActivityUpdateMetaInput {
            activity_id: kickoff.id,
            title: None,
            brief_markdown: None,
            brief_html: None,
            attribute_option_id: None,
            clear_attribute_option: None,
            activity_time: None,
            is_pinned: Some(true),
            is_expanded: Some(true),
            status_option_id: Some(catalog.status_id("信息已整理")?),
        })?;
        let kickoff_note = self.create_demo_note(
            project.id,
            kickoff.id,
            catalog.note_type_key(MEETING_RECORD_TYPE_LABEL)?,
            "Kickoff 纪要",
            "## 背景\n现有客服知识分散在 FAQ 表、培训录屏和飞书文档中，回复口径不一致。\n\n## 讨论要点\n- 本期范围统一为退款、物流、账户三类高频问题。\n- 先做知识清洗，再接 AI 引用，不直接开放自动回复。\n- 知识条目统一采用四段式：问题定义、标准回复、边界条件、升级路径。\n\n## 初步结论\n- 确认第一阶段只覆盖中文场景。\n- 建议把退款时效与物流异常拆成独立知识条目。\n- 需要法务确认赔付承诺相关措辞边界。\n\n## 行动项\n- 待产品在周三前补齐高频问题 Top 50。\n- 需要客服主管输出现有标准话术。\n- 安排法务参加下一轮边界评审。",
        )?;
        self.create_demo_conclusion(
            project.id,
            Some(kickoff.id),
            Some(kickoff_note.id),
            "第一阶段范围锁定为退款、物流、账户问题，先支持辅助检索，不直接自动回复。",
            true,
        )?;
        self.create_demo_conclusion(
            project.id,
            Some(kickoff.id),
            Some(kickoff_note.id),
            "知识条目统一采用“问题定义 / 标准回复 / 边界条件 / 升级路径”四段式模板。",
            true,
        )?;
        self.create_demo_todo(
            project.id,
            Some(kickoff.id),
            "整理近 30 天高频工单 Top 50",
            "urgent_important",
            &[(
                &current_workspace_date(),
                "已从工单系统导出 4,812 条样本，并完成首轮去重。",
            )],
            true,
        )?;
        self.create_demo_todo(
            project.id,
            Some(kickoff.id),
            "补齐退款与物流场景标准回复草案",
            "not_urgent_important",
            &[(
                &current_workspace_date(),
                "客服主管已补充 12 条标准口径，待产品统一格式。",
            )],
            false,
        )?;
        self.create_demo_todo(
            project.id,
            Some(kickoff.id),
            "与法务确认赔付类敏感措辞",
            "urgent_not_important",
            &[("2026-04-07", "已预约本周五法务评审会。")],
            false,
        )?;

        let prd_v1 = self.write_demo_source_file(
            source_root,
            "customer_service",
            "kb-upgrade-prd-v1.md",
            "# 智能客服知识库升级 PRD v1\n\n## 目标\n- 将高频问题从人工经验整理为标准知识条目。\n- 为后续 AI 辅助检索提供统一引用源。\n\n## 首期范围\n- 退款\n- 物流\n- 账户\n\n## 成功指标\n- 首次响应时间下降 20%\n- 口径偏差投诉下降 30%\n",
        )?;
        let kickoff_doc = self.import_demo_document(
            project.id,
            Some(kickoff.id),
            &prd_v1,
            true,
            &[catalog.tag_id("PRD")?, catalog.tag_id("评审材料")?],
        )?;
        let prd_v2 = self.write_demo_source_file(
            source_root,
            "customer_service",
            "kb-upgrade-prd-v2.md",
            "# 智能客服知识库升级 PRD v2\n\n## 目标\n- 在首期知识清洗完成后接入 AI 检索引用。\n- 回复内容必须可追溯到知识条目。\n\n## 新增约束\n- 敏感话术必须增加“禁止表达”字段。\n- 所有赔付结论默认走人工复核。\n\n## 成功指标\n- 首次响应时间下降 20%\n- 升级工单占比下降 15%\n",
        )?;
        self.document_add_version(DocumentAddVersionInput {
            document_id: kickoff_doc.id,
            source_path: Some(prd_v2.to_string_lossy().to_string()),
        })?;

        let labeling = self.activity_create(ActivityCreateInput {
            project_id: project.id,
            attribute_option_id: Some(catalog.attribute_id("数据分析")?),
            title: Some("历史工单标签梳理".to_string()),
            activity_time: "2026-04-04T06:00:00.000Z".to_string(),
        })?;
        self.activity_update_meta(ActivityUpdateMetaInput {
            activity_id: labeling.id,
            title: None,
            brief_markdown: None,
            brief_html: None,
            attribute_option_id: None,
            clear_attribute_option: None,
            activity_time: None,
            is_pinned: Some(false),
            is_expanded: Some(true),
            status_option_id: Some(catalog.status_id("进行中")?),
        })?;
        let labeling_note = self.create_demo_note(
            project.id,
            labeling.id,
            catalog.note_type_key("实验记录")?,
            "标签映射实验",
            "## 目标\n验证现有工单标签能否直接映射为知识库一级 / 二级分类。\n\n## 样本与方法\n- 抽样退款工单 1200 条、物流工单 900 条、账户工单 600 条。\n- 比较现有 87 个标签与知识条目候选结构的一致性。\n\n## 观察\n- “退款失败”“退款处理中”“退款超时”需要拆成状态维度。\n- 物流问题里“揽收延迟”和“在途异常”被混用。\n- 建议保留一级大类 + 二级问题码，不再沿用自然语言标签。\n\n## 下一步\n- 需要输出旧标签到新问题码的映射表。\n- 待客服团队补充近两周新增标签样本。",
        )?;
        self.create_demo_conclusion(
            project.id,
            Some(labeling.id),
            Some(labeling_note.id),
            "二级问题码需要独立维护，不能直接复用现有工单自然语言标签。",
            true,
        )?;
        self.create_demo_todo(
            project.id,
            Some(labeling.id),
            "输出旧标签到新问题码映射表",
            "urgent_important",
            &[("2026-04-08", "已完成 87 个旧标签的首轮聚类。")],
            false,
        )?;
        self.create_demo_todo(
            project.id,
            Some(labeling.id),
            "补充最近两周新增标签样本",
            "urgent_not_important",
            &[("2026-04-08", "客服团队承诺今晚补齐新增标签导出。")],
            false,
        )?;
        let label_mapping = self.write_demo_source_file(
            source_root,
            "customer_service",
            "ticket-tag-mapping.csv",
            "old_tag,new_code,new_label\n退款失败,refund_status_failed,退款失败\n退款处理中,refund_status_processing,退款处理中\n物流延迟,logistics_delay,物流延迟\n在途异常,logistics_exception,在途异常\n账号冻结,account_locked,账号冻结\n",
        )?;
        self.import_demo_document(
            project.id,
            Some(labeling.id),
            &label_mapping,
            false,
            &[catalog.tag_id("数据样本")?, catalog.tag_id("评审材料")?],
        )?;

        let legal = self.activity_create(ActivityCreateInput {
            project_id: project.id,
            attribute_option_id: Some(catalog.attribute_id("法务评审")?),
            title: Some("敏感问题回复边界评审".to_string()),
            activity_time: "2026-04-07T02:00:00.000Z".to_string(),
        })?;
        self.activity_update_meta(ActivityUpdateMetaInput {
            activity_id: legal.id,
            title: None,
            brief_markdown: None,
            brief_html: None,
            attribute_option_id: None,
            clear_attribute_option: None,
            activity_time: None,
            is_pinned: Some(false),
            is_expanded: Some(true),
            status_option_id: Some(catalog.status_id("需升级处理")?),
        })?;
        let legal_note = self.create_demo_note(
            project.id,
            legal.id,
            catalog.note_type_key("法务审查")?,
            "敏感话术法务审查",
            "## 审查范围\n赔付、退款承诺、平台责任、时效承诺。\n\n## 风险点\n- 不能使用“保证到账”“一定补偿”这类绝对表述。\n- 若物流责任未判定，AI 只能使用条件式回应。\n- 涉及现金补偿需引导人工确认，不允许直接承诺金额。\n\n## 建议口径\n- 可使用“我们将协助核查并在 24 小时内同步处理结果”。\n- 需要在知识条目里增加“禁止表达”字段。\n\n## 结论\n所有赔付与责任认定类问题均需人工复核。",
        )?;
        self.create_demo_conclusion(
            project.id,
            Some(legal.id),
            Some(legal_note.id),
            "所有赔付与责任认定类问题必须增加“禁止表达”字段，并走人工复核。",
            true,
        )?;
        self.create_demo_todo(
            project.id,
            Some(legal.id),
            "整理禁止表达黑名单",
            "urgent_important",
            &[(
                "2026-04-08",
                "法务已圈定 18 条高风险表达，待整理成结构化清单。",
            )],
            false,
        )?;
        self.create_demo_todo(
            project.id,
            Some(legal.id),
            "在提示词中加入人工复核 gate",
            "not_urgent_important",
            &[("2026-04-08", "已在 prompt 草案中增加 escalation 条件。")],
            false,
        )?;
        let legal_doc = self.write_demo_source_file(
            source_root,
            "customer_service",
            "legal-language-boundary.md",
            "# 客服敏感话术边界\n\n## 禁止表达\n- 保证到账\n- 一定赔付\n- 平台全责\n\n## 可替代表达\n- 我们将协助核查并同步处理结果\n- 该问题需要人工进一步确认\n",
        )?;
        self.import_demo_document(
            project.id,
            Some(legal.id),
            &legal_doc,
            true,
            &[catalog.tag_id("法务条款")?, catalog.tag_id("Prompt草案")?],
        )?;

        self.create_demo_conclusion(
            project.id,
            None,
            None,
            "知识库升级的首期上线条件已经明确：标签映射表完成、敏感话术黑名单确认、标准回复模板统一。",
            true,
        )?;
        self.create_demo_todo(
            project.id,
            None,
            "输出首期上线 checklist",
            "not_urgent_important",
            &[("2026-04-08", "已汇总产品、客服、法务三方 gating 条件。")],
            false,
        )?;

        Ok(SeededProjectRefs {
            project_id: project.id,
            activity_ids: vec![kickoff.id, labeling.id, legal.id],
        })
    }

    fn seed_demo_lead_scoring_project(
        &mut self,
        _workspace_root: &Path,
        source_root: &Path,
        catalog: &DemoSeedCatalog,
    ) -> Result<SeededProjectRefs> {
        let project = self.project_create(ProjectCreateInput {
            name: "海外销售线索评分 Copilot".to_string(),
            summary: Some("为北美 SMB 销售团队做一套线索评分 Copilot，目标是把 SDR 首次筛选时间从 12 分钟降到 4 分钟。当前在验证 CRM 接入与特征字段稳定性。".to_string()),
            status: Some("active".to_string()),
        })?;

        let alignment = self.activity_create(ActivityCreateInput {
            project_id: project.id,
            attribute_option_id: Some(catalog.attribute_id("会议")?),
            title: Some("北美销售与市场对齐会".to_string()),
            activity_time: "2026-04-03T00:00:00.000Z".to_string(),
        })?;
        self.activity_update_meta(ActivityUpdateMetaInput {
            activity_id: alignment.id,
            title: None,
            brief_markdown: None,
            brief_html: None,
            attribute_option_id: None,
            clear_attribute_option: None,
            activity_time: None,
            is_pinned: Some(true),
            is_expanded: Some(true),
            status_option_id: Some(catalog.status_id("信息已整理")?),
        })?;
        let alignment_note = self.create_demo_note(
            project.id,
            alignment.id,
            catalog.note_type_key(MEETING_RECORD_TYPE_LABEL)?,
            "销售与市场对齐纪要",
            "## 背景\nSDR 认为当前线索筛选完全依赖个人经验，优先级不稳定。\n\n## 讨论要点\n- 第一阶段只覆盖北美 inbound demo / ebook / webinar 三类线索。\n- 输出建议分，不自动改写 CRM 原始 score。\n- 评分解释必须能追溯到字段与规则。\n\n## 初步结论\n- 确认先做建议分 + 推荐动作，不触发自动分配。\n- 需要市场补齐 campaign taxonomy 与 lead source 映射。\n- 销售只接受 5 档评分，不接受纯文本建议。\n\n## 行动项\n- 待 RevOps 输出字段字典。\n- 需要 SDR 主管提供最近 50 条高转化样本。",
        )?;
        self.create_demo_conclusion(
            project.id,
            Some(alignment.id),
            Some(alignment_note.id),
            "第一阶段只覆盖北美 inbound demo / ebook / webinar leads，先给建议分，不自动改写 CRM 原始 score。",
            true,
        )?;
        self.create_demo_todo(
            project.id,
            Some(alignment.id),
            "让 RevOps 输出字段字典与评分口径说明",
            "urgent_important",
            &[(
                "2026-04-08",
                "RevOps 已确认 23 个可用字段，并补充字段释义。",
            )],
            true,
        )?;
        self.create_demo_todo(
            project.id,
            Some(alignment.id),
            "补齐 campaign taxonomy 与 lead source 映射",
            "not_urgent_important",
            &[("2026-04-08", "市场团队已交付首版渠道映射，待清洗历史别名。")],
            false,
        )?;

        let project_scope = self.write_demo_source_file(
            source_root,
            "lead_scoring",
            "lead-scoring-scope.md",
            "# Lead Scoring Copilot Scope\n\n## Phase 1\n- North America inbound demo\n- Ebook download\n- Webinar registration\n\n## Output\n- 推荐评分档位\n- 推荐动作\n- 解释字段\n",
        )?;
        self.import_demo_document(
            project.id,
            None,
            &project_scope,
            true,
            &[catalog.tag_id("PRD")?, catalog.tag_id("流程清单")?],
        )?;

        let feature_review = self.activity_create(ActivityCreateInput {
            project_id: project.id,
            attribute_option_id: Some(catalog.attribute_id("实验验证")?),
            title: Some("评分特征初版评审".to_string()),
            activity_time: "2026-04-05T02:30:00.000Z".to_string(),
        })?;
        self.activity_update_meta(ActivityUpdateMetaInput {
            activity_id: feature_review.id,
            title: None,
            brief_markdown: None,
            brief_html: None,
            attribute_option_id: None,
            clear_attribute_option: None,
            activity_time: None,
            is_pinned: Some(false),
            is_expanded: Some(true),
            status_option_id: Some(catalog.status_id("进行中")?),
        })?;
        let feature_note = self.create_demo_note(
            project.id,
            feature_review.id,
            catalog.note_type_key("实验记录")?,
            "评分特征评审记录",
            "## 目标\n验证首版评分特征是否具备业务解释性与字段稳定性。\n\n## 样本与方法\n- 使用近 90 天 3,200 条北美 inbound leads。\n- 对比行业、员工数、官网质量、回复速度、渠道来源等字段。\n\n## 观察\n- 官网缺失但来自高 intent 渠道的线索不应被直接降分。\n- 员工数字段缺失率高，需要 fallback 规则。\n- 建议把“最近 7 天互动次数”作为单独的加分项。\n\n## 下一步\n- 待数据团队补齐员工数缺失值策略。\n- 需要销售确认各档评分的 follow-up SLA。",
        )?;
        self.create_demo_conclusion(
            project.id,
            Some(feature_review.id),
            Some(feature_note.id),
            "官网质量、渠道来源、最近 7 天互动次数应作为首版评分的核心解释字段。",
            true,
        )?;
        self.create_demo_todo(
            project.id,
            Some(feature_review.id),
            "补齐员工数缺失值 fallback 规则",
            "urgent_important",
            &[("2026-04-08", "数据团队建议回退到公司域名解析 + 手工补全。")],
            false,
        )?;
        self.create_demo_todo(
            project.id,
            Some(feature_review.id),
            "确认 5 档评分对应的 follow-up SLA",
            "urgent_not_important",
            &[(
                "2026-04-08",
                "SDR 主管已接受 P1/P2/P3 三档差异化 SLA 方案。",
            )],
            false,
        )?;
        let features_v1 = self.write_demo_source_file(
            source_root,
            "lead_scoring",
            "lead-score-features-v1.csv",
            "feature,weight,comment\nwebsite_quality,0.25,官网信息完整度\nlead_source,0.20,渠道意图强度\nemployee_size,0.15,公司规模\nrecent_activity_7d,0.10,最近 7 天互动次数\njob_title_match,0.10,职位匹配度\n",
        )?;
        let feature_doc = self.import_demo_document(
            project.id,
            Some(feature_review.id),
            &features_v1,
            false,
            &[catalog.tag_id("数据样本")?, catalog.tag_id("评审材料")?],
        )?;
        let features_v2 = self.write_demo_source_file(
            source_root,
            "lead_scoring",
            "lead-score-features-v2.csv",
            "feature,weight,comment\nwebsite_quality,0.22,官网信息完整度\nlead_source,0.22,渠道意图强度\nemployee_size,0.12,公司规模\nrecent_activity_7d,0.16,最近 7 天互动次数\njob_title_match,0.10,职位匹配度\ncampaign_fit,0.08,活动匹配度\n",
        )?;
        self.document_add_version(DocumentAddVersionInput {
            document_id: feature_doc.id,
            source_path: Some(features_v2.to_string_lossy().to_string()),
        })?;

        let crm = self.activity_create(ActivityCreateInput {
            project_id: project.id,
            attribute_option_id: Some(catalog.attribute_id("需求澄清")?),
            title: Some("CRM 接入可行性确认".to_string()),
            activity_time: "2026-04-07T08:30:00.000Z".to_string(),
        })?;
        self.activity_update_meta(ActivityUpdateMetaInput {
            activity_id: crm.id,
            title: None,
            brief_markdown: None,
            brief_html: None,
            attribute_option_id: None,
            clear_attribute_option: None,
            activity_time: None,
            is_pinned: Some(false),
            is_expanded: Some(true),
            status_option_id: Some(catalog.status_id("待跟进")?),
        })?;
        let crm_note = self.create_demo_note(
            project.id,
            crm.id,
            catalog.note_type_key(DEFAULT_RECORD_TYPE_LABEL)?,
            "CRM 接入可行性记录",
            "## 背景\n当前 HubSpot webhook 无法稳定覆盖所有 lead 更新事件。\n\n## 关键发现\n- 新增线索事件实时可用，但字段修订事件存在延迟。\n- 若直接做实时重算，会出现解释字段与 CRM 页面不一致。\n- 建议 nightly full sync + webhook incremental 的混合方案。\n\n## 下一步\n- 需要 RevOps 确认 nightly sync 窗口。\n- 待工程确认 webhook 限流策略。",
        )?;
        self.create_demo_conclusion(
            project.id,
            Some(crm.id),
            Some(crm_note.id),
            "CRM 接入采用 webhook 增量 + nightly full sync 的混合方案，优先保证评分解释与页面字段一致。",
            true,
        )?;
        self.create_demo_todo(
            project.id,
            Some(crm.id),
            "确认 nightly sync 时间窗口",
            "urgent_not_important",
            &[("2026-04-08", "RevOps 倾向每天美西时间 02:00 执行全量同步。")],
            false,
        )?;
        self.create_demo_todo(
            project.id,
            Some(crm.id),
            "评估 webhook 限流与补偿重试策略",
            "not_urgent_important",
            &[("2026-04-08", "工程建议先做 3 次指数退避重试。")],
            false,
        )?;
        let crm_doc = self.write_demo_source_file(
            source_root,
            "lead_scoring",
            "crm-integration-checklist.md",
            "# CRM Integration Checklist\n\n- Confirm webhook event coverage\n- Define nightly full sync window\n- Add retry and dead-letter handling\n- Align score explanation fields with CRM UI\n",
        )?;
        self.import_demo_document(
            project.id,
            Some(crm.id),
            &crm_doc,
            false,
            &[catalog.tag_id("流程清单")?, catalog.tag_id("评审材料")?],
        )?;

        self.create_demo_conclusion(
            project.id,
            None,
            None,
            "Lead Scoring Copilot 的首版落地前提已经明确：评分可解释、字段稳定、CRM 同步一致。",
            true,
        )?;
        self.create_demo_todo(
            project.id,
            None,
            "准备北美 SDR 内测说明页",
            "not_urgent_important",
            &[("2026-04-08", "已收集需要展示的评分解释示例。")],
            false,
        )?;

        Ok(SeededProjectRefs {
            project_id: project.id,
            activity_ids: vec![alignment.id, feature_review.id, crm.id],
        })
    }

    fn seed_demo_contract_review_project(
        &mut self,
        _workspace_root: &Path,
        source_root: &Path,
        catalog: &DemoSeedCatalog,
    ) -> Result<SeededProjectRefs> {
        let project = self.project_create(ProjectCreateInput {
            name: "合同审阅 AI 助手试点".to_string(),
            summary: Some("面向法务与采购的合同审阅 AI 助手试点，聚焦红线条款识别、审阅意见归类和标准修改建议。当前已完成试点范围确认，Prompt 与复核流程仍在迭代。".to_string()),
            status: Some("active".to_string()),
        })?;

        let scope = self.activity_create(ActivityCreateInput {
            project_id: project.id,
            attribute_option_id: Some(catalog.attribute_id("会议")?),
            title: Some("试点范围确认".to_string()),
            activity_time: "2026-04-01T07:30:00.000Z".to_string(),
        })?;
        self.activity_update_meta(ActivityUpdateMetaInput {
            activity_id: scope.id,
            title: None,
            brief_markdown: None,
            brief_html: None,
            attribute_option_id: None,
            clear_attribute_option: None,
            activity_time: None,
            is_pinned: Some(true),
            is_expanded: Some(true),
            status_option_id: Some(catalog.status_id("信息已整理")?),
        })?;
        let scope_note = self.create_demo_note(
            project.id,
            scope.id,
            catalog.note_type_key(MEETING_RECORD_TYPE_LABEL)?,
            "试点范围纪要",
            "## 背景\n法务希望优先验证红线条款识别与修改建议，不希望一开始覆盖所有合同类型。\n\n## 讨论要点\n- 试点仅覆盖 NDA 与采购合同，不覆盖劳动合同。\n- 输出需包含风险等级、风险依据、建议修改文本。\n- 所有 AI 建议必须由法务二次确认后才能对外发送。\n\n## 初步结论\n- 先用匿名化历史合同做离线验证。\n- 红线条款模板由法务统一维护。\n- 采购合同优先关注责任限制、付款条件、自动续约。\n\n## 行动项\n- 待法务提供 20 份匿名化样本。\n- 需要整理红线条款模板 v1。",
        )?;
        self.create_demo_conclusion(
            project.id,
            Some(scope.id),
            Some(scope_note.id),
            "试点仅覆盖 NDA 与采购合同，所有 AI 建议必须经过法务二次确认后才能输出。",
            true,
        )?;
        self.create_demo_todo(
            project.id,
            Some(scope.id),
            "收集 20 份匿名化历史合同样本",
            "urgent_important",
            &[("2026-04-08", "法务已完成 12 份 NDA 样本脱敏。")],
            false,
        )?;
        self.create_demo_todo(
            project.id,
            Some(scope.id),
            "整理红线条款模板 v1",
            "not_urgent_important",
            &[("2026-04-08", "已完成责任限制与自动续约两类条款模板。")],
            false,
        )?;
        let scope_doc = self.write_demo_source_file(
            source_root,
            "contract_review",
            "pilot-scope.md",
            "# 合同审阅 AI 助手试点范围\n\n## Included\n- NDA\n- Procurement Agreement\n\n## Excluded\n- Employment Contract\n- Equity Agreement\n\n## Output Fields\n- 风险等级\n- 风险依据\n- 建议修改文本\n",
        )?;
        self.import_demo_document(
            project.id,
            None,
            &scope_doc,
            true,
            &[catalog.tag_id("PRD")?, catalog.tag_id("法务条款")?],
        )?;

        let prompt = self.activity_create(ActivityCreateInput {
            project_id: project.id,
            attribute_option_id: Some(catalog.attribute_id("实验验证")?),
            title: Some("红线条款 Prompt 调整".to_string()),
            activity_time: "2026-04-06T03:30:00.000Z".to_string(),
        })?;
        self.activity_update_meta(ActivityUpdateMetaInput {
            activity_id: prompt.id,
            title: None,
            brief_markdown: None,
            brief_html: None,
            attribute_option_id: None,
            clear_attribute_option: None,
            activity_time: None,
            is_pinned: Some(false),
            is_expanded: Some(true),
            status_option_id: Some(catalog.status_id("进行中")?),
        })?;
        let prompt_note = self.create_demo_note(
            project.id,
            prompt.id,
            catalog.note_type_key("实验记录")?,
            "Prompt 调整记录",
            "## 目标\n减少泛化建议，提升红线条款识别的准确率与依据可读性。\n\n## 样本与方法\n- 使用 12 份匿名 NDA 与 8 份采购合同做离线评估。\n- 对比 prompt v1 / v2 在风险条款召回率上的差异。\n\n## 观察\n- 若不提供条款类别清单，模型会把普通商务条款误判为高风险。\n- 要求输出“风险依据”后，法务对结果的信任度明显提高。\n- 建议把建议修改文本限制在标准模板候选集合内。\n\n## 下一步\n- 待法务补充付款条件与赔偿责任模板。\n- 需要增加拒答条件：当证据不足时输出“需人工判断”。",
        )?;
        self.create_demo_conclusion(
            project.id,
            Some(prompt.id),
            Some(prompt_note.id),
            "Prompt 必须同时输出风险等级与风险依据，并在证据不足时明确回退为“需人工判断”。",
            true,
        )?;
        self.create_demo_todo(
            project.id,
            Some(prompt.id),
            "补充付款条件与赔偿责任模板",
            "urgent_important",
            &[("2026-04-08", "法务已提供 6 条标准修改建议模板。")],
            false,
        )?;
        self.create_demo_todo(
            project.id,
            Some(prompt.id),
            "增加证据不足时的拒答条件",
            "not_urgent_important",
            &[("2026-04-08", "prompt v3 已增加“需人工判断”回退语。")],
            true,
        )?;
        let prompt_doc = self.write_demo_source_file(
            source_root,
            "contract_review",
            "clause-risk-matrix.json",
            "{\n  \"liability_cap\": {\"risk\": \"high\", \"template\": \"责任上限不应低于合同金额 100%\"},\n  \"auto_renewal\": {\"risk\": \"medium\", \"template\": \"自动续约需提供明确取消窗口\"},\n  \"payment_terms\": {\"risk\": \"medium\", \"template\": \"付款条件需与验收节点绑定\"}\n}\n",
        )?;
        self.import_demo_document(
            project.id,
            Some(prompt.id),
            &prompt_doc,
            false,
            &[catalog.tag_id("Prompt草案")?, catalog.tag_id("法务条款")?],
        )?;

        let review_flow = self.activity_create(ActivityCreateInput {
            project_id: project.id,
            attribute_option_id: Some(catalog.attribute_id("法务评审")?),
            title: Some("法务复核机制设计".to_string()),
            activity_time: "2026-04-08T01:00:00.000Z".to_string(),
        })?;
        self.activity_update_meta(ActivityUpdateMetaInput {
            activity_id: review_flow.id,
            title: None,
            brief_markdown: None,
            brief_html: None,
            attribute_option_id: None,
            clear_attribute_option: None,
            activity_time: None,
            is_pinned: Some(false),
            is_expanded: Some(true),
            status_option_id: Some(catalog.status_id("待跟进")?),
        })?;
        let review_note = self.create_demo_note(
            project.id,
            review_flow.id,
            catalog.note_type_key("法务审查")?,
            "复核流程设计记录",
            "## 审查范围\nAI 输出的风险等级、风险依据、建议修改文本、拒答原因。\n\n## 风险点\n- 若没有统一复核清单，不同法务对相同结果的判断会不一致。\n- 采购合同的付款与违约条款更依赖业务上下文，不能只看单条条款。\n\n## 建议口径\n- 先按“高风险必审、中风险抽审、低风险 spot check”设计。\n- 对所有拒答结果保留原因与证据片段。\n\n## 结论\n需要一套标准复核清单与升级规则，才能支持试点上线。",
        )?;
        self.create_demo_conclusion(
            project.id,
            Some(review_flow.id),
            Some(review_note.id),
            "试点上线前必须先落地标准复核清单与升级规则，避免同类条款出现不同判定口径。",
            true,
        )?;
        self.create_demo_todo(
            project.id,
            Some(review_flow.id),
            "输出高 / 中 / 低风险分级复核清单",
            "urgent_important",
            &[(
                "2026-04-08",
                "已初步按责任限制、付款条件、续约条款划分风险级别。",
            )],
            false,
        )?;
        self.create_demo_todo(
            project.id,
            Some(review_flow.id),
            "定义拒答结果的记录字段",
            "not_urgent_important",
            &[("2026-04-08", "建议记录触发原因、证据片段和建议升级人。")],
            false,
        )?;
        let review_doc = self.write_demo_source_file(
            source_root,
            "contract_review",
            "review-checklist.md",
            "# 法务复核清单\n\n## High Risk\n- Liability cap below threshold\n- One-sided indemnity\n\n## Medium Risk\n- Auto renewal without cancellation window\n- Payment terms detached from acceptance\n\n## Low Risk\n- Standard template wording changes\n",
        )?;
        self.import_demo_document(
            project.id,
            Some(review_flow.id),
            &review_doc,
            false,
            &[catalog.tag_id("流程清单")?, catalog.tag_id("法务条款")?],
        )?;

        self.create_demo_conclusion(
            project.id,
            None,
            None,
            "合同审阅试点已经具备离线验证条件，下一阶段的关键不再是继续堆 prompt，而是把复核机制和升级规则做扎实。",
            true,
        )?;
        self.create_demo_todo(
            project.id,
            None,
            "准备第二批匿名采购合同样本",
            "not_urgent_important",
            &[("2026-04-08", "采购团队答应补充 8 份不同付款模式样本。")],
            false,
        )?;

        Ok(SeededProjectRefs {
            project_id: project.id,
            activity_ids: vec![scope.id, prompt.id, review_flow.id],
        })
    }

    fn resolve_artifact_request(
        &self,
        input: AiArtifactGetInput,
    ) -> Result<ResolvedArtifactRequest> {
        let kind = input.kind.trim();
        let spec = artifact_skill_spec(kind)?;

        match kind {
            "activity_summary" => {
                let project_id = input
                    .project_id
                    .ok_or_else(|| anyhow!("activity_summary requires projectId"))?;
                let activity_id = input
                    .activity_id
                    .ok_or_else(|| anyhow!("activity_summary requires activityId"))?;
                Ok(ResolvedArtifactRequest {
                    spec,
                    project_id: Some(project_id),
                    activity_id: Some(activity_id),
                    artifact_date: None,
                })
            }
            "project_brief" => {
                let project_id = input
                    .project_id
                    .ok_or_else(|| anyhow!("project_brief requires projectId"))?;
                Ok(ResolvedArtifactRequest {
                    spec,
                    project_id: Some(project_id),
                    activity_id: None,
                    artifact_date: None,
                })
            }
            "daily_brief" => Ok(ResolvedArtifactRequest {
                spec,
                project_id: None,
                activity_id: None,
                artifact_date: Some(
                    nullable_trimmed(input.artifact_date.as_deref())
                        .unwrap_or_else(current_workspace_date),
                ),
            }),
            _ => Err(anyhow!("unsupported artifact kind")),
        }
    }

    fn resolve_ai_answer_request(
        &self,
        input: AiAnswerQuestionInput,
    ) -> Result<ResolvedAskRequest> {
        let question = input.question.trim().to_string();
        if question.is_empty() {
            return Err(anyhow!("question is required"));
        }

        match input.scope {
            AiAnswerScope::Activity => {
                let project_id = input
                    .project_id
                    .ok_or_else(|| anyhow!("activity scope requires projectId"))?;
                let activity_id = input
                    .activity_id
                    .ok_or_else(|| anyhow!("activity scope requires activityId"))?;
                let activity = self.activity_row(activity_id)?;
                if activity.project_id != project_id {
                    return Err(anyhow!("activity does not belong to the selected project"));
                }

                Ok(ResolvedAskRequest {
                    scope: AiAnswerScope::Activity,
                    question,
                    project_id: Some(project_id),
                    activity_id: Some(activity_id),
                })
            }
            AiAnswerScope::Project => {
                let project_id = input
                    .project_id
                    .ok_or_else(|| anyhow!("project scope requires projectId"))?;
                self.project_record(project_id)?;
                Ok(ResolvedAskRequest {
                    scope: AiAnswerScope::Project,
                    question,
                    project_id: Some(project_id),
                    activity_id: None,
                })
            }
            AiAnswerScope::Workspace => Ok(ResolvedAskRequest {
                scope: AiAnswerScope::Workspace,
                question,
                project_id: None,
                activity_id: None,
            }),
        }
    }

    fn build_ai_answer_sources(
        &mut self,
        scope: &AiAnswerScope,
        project_id: Option<i64>,
        activity_id: Option<i64>,
    ) -> Result<Vec<AskSource>> {
        match scope {
            AiAnswerScope::Activity => self.build_activity_ask_sources(
                project_id.ok_or_else(|| anyhow!("missing projectId"))?,
                activity_id.ok_or_else(|| anyhow!("missing activityId"))?,
            ),
            AiAnswerScope::Project => self
                .build_project_ask_sources(project_id.ok_or_else(|| anyhow!("missing projectId"))?),
            AiAnswerScope::Workspace => self.build_workspace_ask_sources(),
        }
    }

    fn build_artifact_context(
        &mut self,
        spec: &ArtifactSkillSpec,
        project_id: Option<i64>,
        activity_id: Option<i64>,
        artifact_date: Option<String>,
    ) -> Result<ArtifactGenerationContext> {
        match spec.kind {
            "activity_summary" => self.build_activity_summary_context(
                project_id.ok_or_else(|| anyhow!("missing projectId"))?,
                activity_id.ok_or_else(|| anyhow!("missing activityId"))?,
            ),
            "project_brief" => self.build_project_brief_context(
                project_id.ok_or_else(|| anyhow!("missing projectId"))?,
            ),
            "daily_brief" => {
                self.build_daily_brief_context(artifact_date.unwrap_or_else(current_workspace_date))
            }
            _ => Err(anyhow!("unsupported artifact kind")),
        }
    }

    fn build_activity_summary_context(
        &mut self,
        project_id: i64,
        activity_id: i64,
    ) -> Result<ArtifactGenerationContext> {
        let activity = self.activity_card(activity_id)?;
        let project = self.project_record(project_id)?;
        let mut sources = Vec::new();
        let mut latest = project.updated_at.clone();

        push_artifact_source(
            &mut sources,
            &mut latest,
            Some(project.id),
            Some(activity.id),
            "ACTIVITY",
            activity.id,
            "activity",
            format!("Activity · {}", activity.title),
            format!(
                "项目：{}；时间：{}；状态：{}；属性：{}",
                project.name,
                activity.activity_time,
                activity.status_label,
                activity
                    .attribute_label
                    .clone()
                    .unwrap_or_else(|| "未设置".to_string())
            ),
            &activity.updated_at,
        );

        for note in &activity.notes {
            push_artifact_source(
                &mut sources,
                &mut latest,
                Some(note.project_id),
                Some(note.activity_id),
                "NOTE",
                note.id,
                "note",
                format!(
                    "Note · {}",
                    note.title
                        .clone()
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or_else(|| note.note_type.clone())
                ),
                note.content_markdown.clone(),
                &note.updated_at,
            );
        }

        for conclusion in &activity.conclusions {
            push_artifact_source(
                &mut sources,
                &mut latest,
                Some(conclusion.project_id),
                conclusion.activity_id,
                "CONCLUSION",
                conclusion.id,
                "conclusion",
                "Conclusion".to_string(),
                conclusion.content_markdown.clone(),
                &conclusion.updated_at,
            );
        }

        for todo in &activity.todos {
            push_artifact_source(
                &mut sources,
                &mut latest,
                Some(todo.project_id),
                todo.activity_id,
                "TODO",
                todo.id,
                "todo",
                "Todo".to_string(),
                format!(
                    "{}；优先级：{}；最近进展：{}",
                    todo.content,
                    todo.priority,
                    todo.progresses
                        .first()
                        .map(|item| item.content.clone())
                        .unwrap_or_else(|| "暂无进展".to_string())
                ),
                &todo.updated_at,
            );
        }

        for document in &activity.documents {
            push_artifact_source(
                &mut sources,
                &mut latest,
                Some(document.project_id),
                document.activity_id,
                "DOCUMENT",
                document.id,
                "document",
                format!("Document · {}", document.name),
                format!(
                    "文件：{}；类型：{}；状态：{}；最近更新时间：{}",
                    document.name, document.mime_type, document.health, document.updated_at
                ),
                &document.updated_at,
            );
        }

        Ok(ArtifactGenerationContext {
            project_id: Some(project_id),
            activity_id: Some(activity_id),
            artifact_date: None,
            source_updated_at: latest,
            context_text: render_artifact_context(
                "Activity Summary",
                &format!("Project: {}\nActivity: {}", project.name, activity.title),
                &sources,
            ),
            sources,
        })
    }

    fn build_project_brief_context(
        &mut self,
        project_id: i64,
    ) -> Result<ArtifactGenerationContext> {
        let dashboard = self.project_get_dashboard(ProjectIdInput { project_id })?;
        let mut sources = Vec::new();
        let mut latest = dashboard.project.updated_at.clone();

        push_artifact_source(
            &mut sources,
            &mut latest,
            Some(dashboard.project.id),
            None,
            "PROJECT",
            dashboard.project.id,
            "project",
            format!("Project · {}", dashboard.project.name),
            format!(
                "状态：{}；简介：{}",
                dashboard.project.status,
                if dashboard.project.summary.trim().is_empty() {
                    "暂无项目简介"
                } else {
                    dashboard.project.summary.trim()
                }
            ),
            &dashboard.project.updated_at,
        );

        for activity in &dashboard.recent_activities {
            push_artifact_source(
                &mut sources,
                &mut latest,
                Some(activity.project_id),
                Some(activity.id),
                "ACTIVITY",
                activity.id,
                "activity",
                format!("Recent Activity · {}", activity.title),
                format!(
                    "时间：{}；状态：{}；开放 Todo：{}；记录数：{}",
                    activity.activity_time,
                    activity.status_label,
                    activity.todo_count,
                    activity.note_count
                ),
                &dashboard.project.updated_at,
            );
        }

        for conclusion in &dashboard.key_conclusions {
            push_artifact_source(
                &mut sources,
                &mut latest,
                Some(conclusion.project_id),
                conclusion.activity_id,
                "CONCLUSION",
                conclusion.id,
                "conclusion",
                "Project Conclusion".to_string(),
                conclusion.content_markdown.clone(),
                &conclusion.updated_at,
            );
        }

        for todo in &dashboard.open_todos {
            push_artifact_source(
                &mut sources,
                &mut latest,
                Some(todo.project_id),
                todo.activity_id,
                "TODO",
                todo.id,
                "todo",
                "Open Todo".to_string(),
                format!(
                    "{}；优先级：{}；最近进展：{}",
                    todo.content,
                    todo.priority,
                    todo.progresses
                        .first()
                        .map(|item| item.content.clone())
                        .unwrap_or_else(|| "暂无进展".to_string())
                ),
                &todo.updated_at,
            );
        }

        for document in &dashboard.starred_documents {
            push_artifact_source(
                &mut sources,
                &mut latest,
                Some(document.project_id),
                document.activity_id,
                "DOCUMENT",
                document.id,
                "document",
                format!("Starred Document · {}", document.name),
                format!(
                    "文件：{}；类型：{}；状态：{}",
                    document.name, document.mime_type, document.health
                ),
                &document.updated_at,
            );
        }

        Ok(ArtifactGenerationContext {
            project_id: Some(project_id),
            activity_id: None,
            artifact_date: None,
            source_updated_at: latest,
            context_text: render_artifact_context(
                "Project Brief",
                &format!("Project: {}", dashboard.project.name),
                &sources,
            ),
            sources,
        })
    }

    fn build_daily_brief_context(
        &mut self,
        artifact_date: String,
    ) -> Result<ArtifactGenerationContext> {
        let visible_projects = self.projects_list(ProjectsListInput {
            include_archived: Some(false),
        })?;
        let todo_sources = self.workspace_open_todo_sources(10)?;
        let activity_sources = self.workspace_recent_activity_sources(10)?;
        let mut sources = Vec::new();
        let mut latest = now_iso();

        for project in visible_projects.iter().take(6) {
            push_artifact_source(
                &mut sources,
                &mut latest,
                Some(project.id),
                None,
                "PROJECT",
                project.id,
                "project",
                format!("Project · {}", project.name),
                format!(
                    "状态：{}；简介：{}；未完成 Todo：{}",
                    project.status,
                    if project.summary.trim().is_empty() {
                        "暂无项目简介"
                    } else {
                        project.summary.trim()
                    },
                    project.open_todo_count
                ),
                &project.updated_at,
            );
        }

        for source in todo_sources {
            push_existing_artifact_source(&mut sources, &mut latest, source, None);
        }

        for source in activity_sources {
            push_existing_artifact_source(&mut sources, &mut latest, source, None);
        }

        Ok(ArtifactGenerationContext {
            project_id: None,
            activity_id: None,
            artifact_date: Some(artifact_date.clone()),
            source_updated_at: latest,
            context_text: render_artifact_context(
                "Daily Brief",
                &format!("Workspace day: {artifact_date}"),
                &sources,
            ),
            sources,
        })
    }

    fn build_activity_ask_sources(
        &mut self,
        project_id: i64,
        activity_id: i64,
    ) -> Result<Vec<AskSource>> {
        let project = self.project_record(project_id)?;
        let activity = self.activity_card(activity_id)?;
        if activity.project_id != project_id {
            return Err(anyhow!("activity does not belong to the selected project"));
        }

        let mut sources = Vec::new();
        push_ask_source(
            &mut sources,
            Some(project.id),
            Some(activity.id),
            "ACTIVITY",
            activity.id,
            "activity",
            format!("Activity · {}", activity.title),
            format!(
                "项目：{}；时间：{}；状态：{}；属性：{}",
                project.name,
                activity.activity_time,
                activity.status_label,
                activity
                    .attribute_label
                    .clone()
                    .unwrap_or_else(|| "未设置".to_string())
            ),
            format!(
                "Activity title: {}\nProject: {}\nTime: {}\nStatus: {}\nAttribute: {}",
                activity.title,
                project.name,
                activity.activity_time,
                activity.status_label,
                activity
                    .attribute_label
                    .clone()
                    .unwrap_or_else(|| "未设置".to_string())
            ),
            &activity.updated_at,
        );

        for note in &activity.notes {
            let label = note
                .title
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| note.note_type.clone());
            push_ask_source(
                &mut sources,
                Some(note.project_id),
                Some(note.activity_id),
                "NOTE",
                note.id,
                "note",
                format!("Note · {}", label),
                note.content_markdown.clone(),
                truncate_text(&note.content_markdown, 2200),
                &note.updated_at,
            );
        }

        for conclusion in &activity.conclusions {
            push_ask_source(
                &mut sources,
                Some(conclusion.project_id),
                conclusion.activity_id,
                "CONCLUSION",
                conclusion.id,
                "conclusion",
                "Conclusion".to_string(),
                conclusion.content_markdown.clone(),
                conclusion.content_markdown.clone(),
                &conclusion.updated_at,
            );
        }

        for todo in &activity.todos {
            let progress = todo
                .progresses
                .first()
                .map(|item| item.content.clone())
                .unwrap_or_else(|| "暂无进展".to_string());
            let body_text = format!(
                "Todo: {}\nPriority: {}\nStatus: {}\nLatest progress: {}",
                todo.content, todo.priority, todo.status, progress
            );
            push_ask_source(
                &mut sources,
                Some(todo.project_id),
                todo.activity_id,
                "TODO",
                todo.id,
                "todo",
                "Todo".to_string(),
                format!(
                    "{}；优先级：{}；最近进展：{}",
                    todo.content, todo.priority, progress
                ),
                body_text,
                &todo.updated_at,
            );
        }

        for document in &activity.documents {
            let tags = if document.tags.is_empty() {
                "无标签".to_string()
            } else {
                document
                    .tags
                    .iter()
                    .map(|tag| tag.label.clone())
                    .collect::<Vec<_>>()
                    .join("、")
            };
            let body_text = format!(
                "Document: {}\nType: {}\nHealth: {}\nTags: {}\nActivity: {}",
                document.name, document.mime_type, document.health, tags, activity.title
            );
            push_ask_source(
                &mut sources,
                Some(document.project_id),
                document.activity_id,
                "DOCUMENT",
                document.id,
                "document",
                format!("Document · {}", document.name),
                format!(
                    "文件：{}；类型：{}；状态：{}；标签：{}",
                    document.name, document.mime_type, document.health, tags
                ),
                body_text,
                &document.updated_at,
            );
        }

        Ok(sources)
    }

    fn build_project_ask_sources(&mut self, project_id: i64) -> Result<Vec<AskSource>> {
        let dashboard = self.project_get_dashboard(ProjectIdInput { project_id })?;
        let mut sources = Vec::new();

        push_ask_source(
            &mut sources,
            Some(dashboard.project.id),
            None,
            "PROJECT",
            dashboard.project.id,
            "project",
            format!("Project · {}", dashboard.project.name),
            format!(
                "状态：{}；简介：{}",
                dashboard.project.status,
                if dashboard.project.summary.trim().is_empty() {
                    "暂无项目简介"
                } else {
                    dashboard.project.summary.trim()
                }
            ),
            format!(
                "Project: {}\nStatus: {}\nSummary: {}",
                dashboard.project.name,
                dashboard.project.status,
                if dashboard.project.summary.trim().is_empty() {
                    "暂无项目简介"
                } else {
                    dashboard.project.summary.trim()
                }
            ),
            &dashboard.project.updated_at,
        );

        for activity in &dashboard.recent_activities {
            push_ask_source(
                &mut sources,
                Some(activity.project_id),
                Some(activity.id),
                "ACTIVITY",
                activity.id,
                "activity",
                format!("Recent Activity · {}", activity.title),
                format!(
                    "时间：{}；状态：{}；记录数：{}；开放 Todo：{}",
                    activity.activity_time,
                    activity.status_label,
                    activity.note_count,
                    activity.todo_count
                ),
                format!(
                    "Activity: {}\nTime: {}\nStatus: {}\nNote count: {}\nTodo count: {}",
                    activity.title,
                    activity.activity_time,
                    activity.status_label,
                    activity.note_count,
                    activity.todo_count
                ),
                &dashboard.project.updated_at,
            );
        }

        for conclusion in &dashboard.key_conclusions {
            push_ask_source(
                &mut sources,
                Some(conclusion.project_id),
                conclusion.activity_id,
                "CONCLUSION",
                conclusion.id,
                "conclusion",
                "Project Conclusion".to_string(),
                conclusion.content_markdown.clone(),
                conclusion.content_markdown.clone(),
                &conclusion.updated_at,
            );
        }

        for todo in &dashboard.open_todos {
            let progress = todo
                .progresses
                .first()
                .map(|item| item.content.clone())
                .unwrap_or_else(|| "暂无进展".to_string());
            push_ask_source(
                &mut sources,
                Some(todo.project_id),
                todo.activity_id,
                "TODO",
                todo.id,
                "todo",
                "Open Todo".to_string(),
                format!(
                    "{}；优先级：{}；最近进展：{}",
                    todo.content, todo.priority, progress
                ),
                format!(
                    "Todo: {}\nPriority: {}\nStatus: {}\nLatest progress: {}",
                    todo.content, todo.priority, todo.status, progress
                ),
                &todo.updated_at,
            );
        }

        for document in self
            .fetch_project_documents_for_project(project_id)?
            .into_iter()
            .take(8)
        {
            let tags = if document.tags.is_empty() {
                "无标签".to_string()
            } else {
                document
                    .tags
                    .iter()
                    .map(|tag| tag.label.clone())
                    .collect::<Vec<_>>()
                    .join("、")
            };
            push_ask_source(
                &mut sources,
                Some(document.project_id),
                document.activity_id,
                "DOCUMENT",
                document.id,
                "document",
                format!("Project Document · {}", document.name),
                format!(
                    "文件：{}；类型：{}；状态：{}；标签：{}",
                    document.name, document.mime_type, document.health, tags
                ),
                format!(
                    "Document: {}\nType: {}\nHealth: {}\nTags: {}",
                    document.name, document.mime_type, document.health, tags
                ),
                &document.updated_at,
            );
        }

        let mut note_count = 0usize;
        for activity in dashboard.recent_activities.iter().take(4) {
            if note_count >= 6 {
                break;
            }
            for note in self.fetch_notes(activity.id)?.into_iter().take(2) {
                let label = note
                    .title
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| note.note_type.clone());
                let note_excerpt = truncate_text(&note.content_markdown, 360);
                push_ask_source(
                    &mut sources,
                    Some(note.project_id),
                    Some(note.activity_id),
                    "NOTE",
                    note.id,
                    "note",
                    format!("Recent Note · {}", label),
                    note_excerpt.clone(),
                    note_excerpt,
                    &note.updated_at,
                );
                note_count += 1;
                if note_count >= 6 {
                    break;
                }
            }
        }

        Ok(sources)
    }

    fn build_workspace_ask_sources(&mut self) -> Result<Vec<AskSource>> {
        let visible_projects = self.projects_list(ProjectsListInput {
            include_archived: Some(false),
        })?;
        let mut sources = Vec::new();

        for project in visible_projects.iter().take(8) {
            push_ask_source(
                &mut sources,
                Some(project.id),
                None,
                "PROJECT",
                project.id,
                "project",
                format!("Project · {}", project.name),
                format!(
                    "状态：{}；简介：{}；未完成 Todo：{}",
                    project.status,
                    if project.summary.trim().is_empty() {
                        "暂无项目简介"
                    } else {
                        project.summary.trim()
                    },
                    project.open_todo_count
                ),
                format!(
                    "Project: {}\nStatus: {}\nSummary: {}\nOpen todos: {}",
                    project.name,
                    project.status,
                    if project.summary.trim().is_empty() {
                        "暂无项目简介"
                    } else {
                        project.summary.trim()
                    },
                    project.open_todo_count
                ),
                &project.updated_at,
            );

            for conclusion in self
                .list_project_conclusions(project.id, true)?
                .into_iter()
                .take(2)
            {
                push_ask_source(
                    &mut sources,
                    Some(conclusion.project_id),
                    conclusion.activity_id,
                    "CONCLUSION",
                    conclusion.id,
                    "conclusion",
                    format!("Project Conclusion · {}", project.name),
                    conclusion.content_markdown.clone(),
                    conclusion.content_markdown.clone(),
                    &conclusion.updated_at,
                );
            }
        }

        sources.extend(self.workspace_open_todo_ask_sources(12)?);
        sources.extend(self.workspace_recent_activity_ask_sources(10)?);
        sources.extend(self.workspace_starred_document_ask_sources(10)?);

        Ok(sources)
    }

    fn workspace_open_todo_sources(&self, limit: i64) -> Result<Vec<ArtifactSource>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT
              t.id,
              t.project_id,
              t.activity_id,
              t.content,
              t.priority,
              t.updated_at,
              p.name,
              COALESCE(a.title, '')
            FROM todos t
            INNER JOIN projects p ON p.id = t.project_id
            LEFT JOIN activities a ON a.id = t.activity_id
            WHERE p.is_archived = 0
              AND t.status = 'unfinished'
            ORDER BY
              CASE t.priority
                WHEN 'urgent_important' THEN 0
                WHEN 'urgent_not_important' THEN 1
                WHEN 'not_urgent_important' THEN 2
                ELSE 3
              END,
              t.updated_at DESC
            LIMIT ?1
            "#,
        )?;
        let rows = stmt.query_map([limit], |row| {
            Ok(ArtifactSource {
                ref_code: format!("TODO-{}", row.get::<_, i64>(0)?),
                source_kind: "todo".to_string(),
                source_id: row.get(0)?,
                project_id: Some(row.get(1)?),
                activity_id: row.get(2)?,
                label: format!(
                    "Todo · {} · {}",
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?
                ),
                excerpt: format!(
                    "{}；优先级：{}",
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?
                ),
            })
        })?;
        let sources = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(sources)
    }

    fn workspace_recent_activity_sources(&self, limit: i64) -> Result<Vec<ArtifactSource>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT
              a.id,
              a.project_id,
              a.title,
              a.activity_time,
              a.updated_at,
              p.name,
              COALESCE(aso.label, '')
            FROM activities a
            INNER JOIN projects p ON p.id = a.project_id
            LEFT JOIN activity_status_options aso ON aso.id = a.status_option_id
            WHERE p.is_archived = 0
            ORDER BY a.updated_at DESC
            LIMIT ?1
            "#,
        )?;
        let rows = stmt.query_map([limit], |row| {
            Ok(ArtifactSource {
                ref_code: format!("ACTIVITY-{}", row.get::<_, i64>(0)?),
                source_kind: "activity".to_string(),
                source_id: row.get(0)?,
                project_id: Some(row.get(1)?),
                activity_id: Some(row.get(0)?),
                label: format!(
                    "Activity · {} · {}",
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(2)?
                ),
                excerpt: format!(
                    "时间：{}；状态：{}；最近更新：{}",
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(4)?
                ),
            })
        })?;
        let sources = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(sources)
    }

    fn workspace_open_todo_ask_sources(&self, limit: i64) -> Result<Vec<AskSource>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT
              t.id,
              t.project_id,
              t.activity_id,
              t.content,
              t.priority,
              t.status,
              t.updated_at,
              p.name,
              COALESCE(a.title, '')
            FROM todos t
            INNER JOIN projects p ON p.id = t.project_id
            LEFT JOIN activities a ON a.id = t.activity_id
            WHERE p.is_archived = 0
              AND t.status = 'unfinished'
            ORDER BY
              CASE t.priority
                WHEN 'urgent_important' THEN 0
                WHEN 'urgent_not_important' THEN 1
                WHEN 'not_urgent_important' THEN 2
                ELSE 3
              END,
              t.updated_at DESC
            LIMIT ?1
            "#,
        )?;
        let rows = stmt.query_map([limit], |row| {
            let source_id = row.get::<_, i64>(0)?;
            let content = row.get::<_, String>(3)?;
            let priority = row.get::<_, String>(4)?;
            let status = row.get::<_, String>(5)?;
            let project_name = row.get::<_, String>(7)?;
            let activity_title = row.get::<_, String>(8)?;
            Ok(AskSource {
                ref_code: format!("TODO-{source_id}"),
                source_kind: "todo".to_string(),
                source_id,
                project_id: Some(row.get(1)?),
                activity_id: row.get(2)?,
                label: if activity_title.trim().is_empty() {
                    format!("Todo · {project_name}")
                } else {
                    format!("Todo · {project_name} · {activity_title}")
                },
                excerpt: truncate_text(&format!("{content}；优先级：{priority}"), 280),
                body_text: format!(
                    "Todo: {content}\nPriority: {priority}\nStatus: {status}\nProject: {project_name}\nActivity: {activity_title}"
                ),
                updated_at: row.get(6)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    fn workspace_recent_activity_ask_sources(&self, limit: i64) -> Result<Vec<AskSource>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT
              a.id,
              a.project_id,
              a.title,
              a.activity_time,
              a.updated_at,
              p.name,
              COALESCE(aso.label, '')
            FROM activities a
            INNER JOIN projects p ON p.id = a.project_id
            LEFT JOIN activity_status_options aso ON aso.id = a.status_option_id
            WHERE p.is_archived = 0
            ORDER BY a.updated_at DESC
            LIMIT ?1
            "#,
        )?;
        let rows = stmt.query_map([limit], |row| {
            let activity_id = row.get::<_, i64>(0)?;
            let title = row.get::<_, String>(2)?;
            let project_name = row.get::<_, String>(5)?;
            let status_label = row.get::<_, String>(6)?;
            Ok(AskSource {
                ref_code: format!("ACTIVITY-{activity_id}"),
                source_kind: "activity".to_string(),
                source_id: activity_id,
                project_id: Some(row.get(1)?),
                activity_id: Some(activity_id),
                label: format!("Activity · {project_name} · {title}"),
                excerpt: truncate_text(
                    &format!(
                        "时间：{}；状态：{}；最近更新：{}",
                        row.get::<_, String>(3)?,
                        status_label,
                        row.get::<_, String>(4)?
                    ),
                    280,
                ),
                body_text: format!(
                    "Activity: {title}\nProject: {project_name}\nTime: {}\nStatus: {status_label}",
                    row.get::<_, String>(3)?
                ),
                updated_at: row.get(4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    fn workspace_starred_document_ask_sources(&self, limit: i64) -> Result<Vec<AskSource>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT
              d.id,
              d.project_id,
              d.activity_id,
              d.name,
              d.mime_type,
              d.health,
              d.updated_at,
              p.name,
              COALESCE(a.title, '')
            FROM documents d
            INNER JOIN projects p ON p.id = d.project_id
            LEFT JOIN activities a ON a.id = d.activity_id
            WHERE p.is_archived = 0
              AND d.is_starred = 1
            ORDER BY d.updated_at DESC
            LIMIT ?1
            "#,
        )?;
        let rows = stmt.query_map([limit], |row| {
            let source_id = row.get::<_, i64>(0)?;
            let document_name = row.get::<_, String>(3)?;
            let project_name = row.get::<_, String>(7)?;
            let activity_title = row.get::<_, String>(8)?;
            Ok(AskSource {
                ref_code: format!("DOCUMENT-{source_id}"),
                source_kind: "document".to_string(),
                source_id,
                project_id: Some(row.get(1)?),
                activity_id: row.get(2)?,
                label: if activity_title.trim().is_empty() {
                    format!("Starred Document · {project_name} · {document_name}")
                } else {
                    format!("Starred Document · {project_name} · {activity_title} · {document_name}")
                },
                excerpt: truncate_text(
                    &format!(
                        "文件：{}；类型：{}；状态：{}",
                        document_name,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?
                    ),
                    280,
                ),
                body_text: format!(
                    "Document: {document_name}\nProject: {project_name}\nActivity: {activity_title}\nType: {}\nHealth: {}",
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?
                ),
                updated_at: row.get(6)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    fn ai_artifact_record_by_scope(
        &self,
        kind: &str,
        project_id: Option<i64>,
        activity_id: Option<i64>,
        artifact_date: Option<&str>,
    ) -> Result<Option<AiArtifactRecord>> {
        let scope_key = ai_artifact_scope_key(kind, project_id, activity_id, artifact_date);
        let artifact_id = self
            .conn
            .query_row(
                "SELECT id FROM ai_artifacts WHERE scope_key = ?1",
                params![scope_key],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;

        artifact_id
            .map(|id| self.ai_artifact_record(id))
            .transpose()
    }

    fn ai_artifact_record(&self, artifact_id: i64) -> Result<AiArtifactRecord> {
        let mut record = self.conn.query_row(
            r#"
                SELECT
                  id, kind, skill_key, skill_version, project_id, activity_id, artifact_date,
                  status, markdown, json_payload, source_updated_at, generated_at, error_message,
                  created_at, updated_at
                FROM ai_artifacts
                WHERE id = ?1
                "#,
            [artifact_id],
            |row| {
                let payload_json: String = row.get(9)?;
                let json_payload =
                    serde_json::from_str::<Value>(&payload_json).unwrap_or_else(|_| {
                        json!({
                            "overview": "",
                            "sections": []
                        })
                    });

                Ok(AiArtifactRecord {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    skill_key: row.get(2)?,
                    skill_version: row.get(3)?,
                    project_id: row.get(4)?,
                    activity_id: row.get(5)?,
                    artifact_date: row.get(6)?,
                    status: row.get(7)?,
                    markdown: row.get(8)?,
                    json_payload,
                    source_updated_at: row.get(10)?,
                    generated_at: row.get(11)?,
                    error_message: row.get(12)?,
                    citations: Vec::new(),
                    created_at: row.get(13)?,
                    updated_at: row.get(14)?,
                })
            },
        )?;
        record.citations = self.fetch_ai_artifact_citations(artifact_id)?;
        Ok(record)
    }

    fn fetch_ai_artifact_citations(
        &self,
        artifact_id: i64,
    ) -> Result<Vec<AiArtifactCitationRecord>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id, artifact_id, source_kind, source_id, project_id, activity_id, label, excerpt, order_index
            FROM ai_artifact_citations
            WHERE artifact_id = ?1
            ORDER BY order_index ASC, id ASC
            "#,
        )?;
        let rows = stmt.query_map([artifact_id], |row| {
            Ok(AiArtifactCitationRecord {
                id: row.get(0)?,
                artifact_id: row.get(1)?,
                source_kind: row.get(2)?,
                source_id: row.get(3)?,
                project_id: row.get(4)?,
                activity_id: row.get(5)?,
                label: row.get(6)?,
                excerpt: row.get(7)?,
                order_index: row.get(8)?,
            })
        })?;
        let citations = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(citations)
    }

    fn upsert_ai_artifact_success(
        &mut self,
        spec: &ArtifactSkillSpec,
        context: ArtifactGenerationContext,
        payload: ai_provider::ArtifactPayload,
        timestamp: &str,
    ) -> Result<AiArtifactRecord> {
        let ai_provider::ArtifactPayload {
            overview,
            sections,
            citations,
        } = payload;
        let structured_payload = AiArtifactPayload { overview, sections };
        let markdown = render_artifact_markdown(&structured_payload);
        let payload_json = serde_json::to_string(&structured_payload)?;
        let artifact_date = context.artifact_date.clone();
        let scope_key = ai_artifact_scope_key(
            spec.kind,
            context.project_id,
            context.activity_id,
            artifact_date.as_deref(),
        );
        self.conn.execute(
            r#"
            INSERT INTO ai_artifacts (
              scope_key, kind, skill_key, skill_version, project_id, activity_id, artifact_date,
              status, markdown, json_payload, source_updated_at, generated_at, error_message,
              created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, ?13, ?14)
            ON CONFLICT(scope_key) DO UPDATE SET
              kind = excluded.kind,
              skill_key = excluded.skill_key,
              skill_version = excluded.skill_version,
              project_id = excluded.project_id,
              activity_id = excluded.activity_id,
              artifact_date = excluded.artifact_date,
              status = excluded.status,
              markdown = excluded.markdown,
              json_payload = excluded.json_payload,
              source_updated_at = excluded.source_updated_at,
              generated_at = excluded.generated_at,
              error_message = NULL,
              updated_at = excluded.updated_at
            "#,
            params![
                scope_key,
                spec.kind,
                spec.skill_key,
                spec.skill_version,
                context.project_id,
                context.activity_id,
                artifact_date.clone(),
                AI_ARTIFACT_STATUS_FRESH,
                markdown,
                payload_json,
                context.source_updated_at,
                timestamp,
                timestamp,
                timestamp
            ],
        )?;
        let artifact_id = self.conn.query_row(
            "SELECT id FROM ai_artifacts WHERE scope_key = ?1",
            params![ai_artifact_scope_key(
                spec.kind,
                context.project_id,
                context.activity_id,
                artifact_date.as_deref()
            )],
            |row| row.get::<_, i64>(0),
        )?;
        self.replace_ai_artifact_citations(artifact_id, &context.sources, &citations)?;
        self.ai_artifact_record(artifact_id)
    }

    fn upsert_ai_artifact_error(
        &mut self,
        spec: &ArtifactSkillSpec,
        project_id: Option<i64>,
        activity_id: Option<i64>,
        artifact_date: Option<&str>,
        source_updated_at: &str,
        timestamp: &str,
        error_message: &str,
    ) -> Result<AiArtifactRecord> {
        let scope_key = ai_artifact_scope_key(spec.kind, project_id, activity_id, artifact_date);
        let existing_id = self
            .conn
            .query_row(
                "SELECT id FROM ai_artifacts WHERE scope_key = ?1",
                params![scope_key.clone()],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;

        if let Some(artifact_id) = existing_id {
            self.conn.execute(
                r#"
                UPDATE ai_artifacts
                SET kind = ?1,
                    skill_key = ?2,
                    skill_version = ?3,
                    project_id = ?4,
                    activity_id = ?5,
                    artifact_date = ?6,
                    status = ?7,
                    source_updated_at = ?8,
                    error_message = ?9,
                    updated_at = ?10
                WHERE id = ?11
                "#,
                params![
                    spec.kind,
                    spec.skill_key,
                    spec.skill_version,
                    project_id,
                    activity_id,
                    artifact_date,
                    AI_ARTIFACT_STATUS_ERROR,
                    source_updated_at,
                    error_message,
                    timestamp,
                    artifact_id
                ],
            )?;
            return self.ai_artifact_record(artifact_id);
        }

        let empty_payload = serde_json::to_string(&AiArtifactPayload {
            overview: String::new(),
            sections: Vec::new(),
        })?;
        self.conn.execute(
            r#"
            INSERT INTO ai_artifacts (
              scope_key, kind, skill_key, skill_version, project_id, activity_id, artifact_date,
              status, markdown, json_payload, source_updated_at, generated_at, error_message,
              created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '', ?9, ?10, NULL, ?11, ?12, ?13)
            "#,
            params![
                scope_key,
                spec.kind,
                spec.skill_key,
                spec.skill_version,
                project_id,
                activity_id,
                artifact_date,
                AI_ARTIFACT_STATUS_ERROR,
                empty_payload,
                source_updated_at,
                error_message,
                timestamp,
                timestamp
            ],
        )?;
        self.ai_artifact_record(self.conn.last_insert_rowid())
    }

    fn replace_ai_artifact_citations(
        &mut self,
        artifact_id: i64,
        sources: &[ArtifactSource],
        citation_refs: &[String],
    ) -> Result<()> {
        self.conn.execute(
            "DELETE FROM ai_artifact_citations WHERE artifact_id = ?1",
            params![artifact_id],
        )?;

        let resolved_refs = if citation_refs.is_empty() {
            sources
                .iter()
                .take(3)
                .map(|source| source.ref_code.clone())
                .collect::<Vec<_>>()
        } else {
            citation_refs.to_vec()
        };

        let mut unique_refs = Vec::new();
        for reference in resolved_refs {
            if !unique_refs.contains(&reference) {
                unique_refs.push(reference);
            }
        }

        for (index, reference) in unique_refs.iter().enumerate() {
            if let Some(source) = sources.iter().find(|item| item.ref_code == *reference) {
                self.conn.execute(
                    r#"
                    INSERT INTO ai_artifact_citations (
                      artifact_id, source_kind, source_id, project_id, activity_id,
                      label, excerpt, order_index
                    )
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                    "#,
                    params![
                        artifact_id,
                        source.source_kind,
                        source.source_id,
                        source.project_id,
                        source.activity_id,
                        source.label,
                        source.excerpt,
                        index as i64
                    ],
                )?;
            }
        }

        Ok(())
    }

    fn project_record(&self, project_id: i64) -> Result<ProjectRecord> {
        self.conn
            .query_row(
                r#"
                SELECT id, name, status, root_path, summary, summary_markdown, summary_html,
                  is_archived, created_at, updated_at
                FROM projects WHERE id = ?1
                "#,
                [project_id],
                |row| {
                    let root_path_ref = row.get::<_, String>(3)?;
                    Ok(ProjectRecord {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        status: row.get(2)?,
                        root_path: self.decode_path_ref_to_string(&root_path_ref),
                        summary: row.get(4)?,
                        summary_markdown: row.get(5)?,
                        summary_html: row.get(6)?,
                        is_archived: int_to_bool(row.get::<_, i64>(7)?),
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    fn activity_row(&self, activity_id: i64) -> Result<ActivityFsRecord> {
        self.conn
            .query_row(
                r#"
                SELECT
                  project_id, attribute_option_id, title, brief_markdown, brief_html,
                  activity_time, status_option_id, is_pinned, is_expanded, folder_name
                FROM activities WHERE id = ?1
                "#,
                [activity_id],
                |row| {
                    Ok(ActivityFsRecord {
                        project_id: row.get(0)?,
                        attribute_option_id: row.get(1)?,
                        title: row.get(2)?,
                        brief_markdown: row.get(3)?,
                        brief_html: row.get(4)?,
                        activity_time: row.get(5)?,
                        status_option_id: row.get(6)?,
                        is_pinned: int_to_bool(row.get::<_, i64>(7)?),
                        is_expanded: int_to_bool(row.get::<_, i64>(8)?),
                        folder_name: row.get(9)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    fn note_record(&self, note_id: i64) -> Result<NoteRecord> {
        self.conn
            .query_row(
                r#"
                SELECT id, project_id, activity_id, note_type, title, content_markdown, content_html, created_at, updated_at
                FROM notes WHERE id = ?1
                "#,
                [note_id],
                |row| {
                    Ok(NoteRecord {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        activity_id: row.get(2)?,
                        note_type: row.get(3)?,
                        title: row.get(4)?,
                        content_markdown: row.get(5)?,
                        content_html: row.get(6)?,
                        created_at: row.get(7)?,
                        updated_at: row.get(8)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    fn workspace_note_record(&self, note_id: i64) -> Result<WorkspaceNoteRecord> {
        self.conn
            .query_row(
                r#"
                SELECT id, title, content_markdown, content_html, created_at, updated_at
                FROM workspace_notes WHERE id = ?1
                "#,
                [note_id],
                |row| {
                    Ok(WorkspaceNoteRecord {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        content_markdown: row.get(2)?,
                        content_html: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    fn conclusion_record(&self, conclusion_id: i64) -> Result<ConclusionRecord> {
        self.conn
            .query_row(
                r#"
                SELECT
                  c.id,
                  c.project_id,
                  c.activity_id,
                  c.note_id,
                  COALESCE(NULLIF(c.content_markdown, ''), c.content),
                  c.content_html,
                  c.promoted_to_project,
                  c.is_pinned,
                  a.title,
                  c.created_at,
                  c.updated_at
                FROM conclusions c
                LEFT JOIN activities a ON a.id = c.activity_id
                WHERE c.id = ?1
                "#,
                [conclusion_id],
                |row| {
                    Ok(ConclusionRecord {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        activity_id: row.get(2)?,
                        note_id: row.get(3)?,
                        content_markdown: row.get(4)?,
                        content_html: row.get(5)?,
                        promoted_to_project: int_to_bool(row.get::<_, i64>(6)?),
                        is_pinned: int_to_bool(row.get::<_, i64>(7)?),
                        source_activity_title: row.get(8)?,
                        created_at: row.get(9)?,
                        updated_at: row.get(10)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    fn todo_progress_record(&self, progress_id: i64) -> Result<TodoProgressRecord> {
        self.conn
            .query_row(
                r#"
                SELECT id, todo_id, content, progress_date, created_at
                FROM todo_progresses WHERE id = ?1
                "#,
                [progress_id],
                |row| {
                    Ok(TodoProgressRecord {
                        id: row.get(0)?,
                        todo_id: row.get(1)?,
                        content: row.get(2)?,
                        progress_date: row.get(3)?,
                        created_at: row.get(4)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    fn todo_record(&self, todo_id: i64) -> Result<TodoRecord> {
        let base = self.conn.query_row(
            r#"
            SELECT
              t.id, t.project_id, t.activity_id, a.title, t.content, t.status, t.priority, t.created_at, t.updated_at
            FROM todos t
            LEFT JOIN activities a ON a.id = t.activity_id
            WHERE t.id = ?1
            "#,
            [todo_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )?;
        let progresses = self.fetch_todo_progresses(todo_id)?;
        Ok(TodoRecord {
            id: base.0,
            project_id: base.1,
            activity_id: base.2,
            source_activity_title: base.3,
            content: base.4,
            status: base.5,
            priority: base.6,
            created_at: base.7,
            updated_at: base.8,
            progresses,
        })
    }

    fn document_record(&self, document_id: i64) -> Result<DocumentRecord> {
        let base = self
            .conn
            .query_row(
                r#"
                SELECT
                  d.id, d.project_id, d.activity_id, d.name, d.base_name, d.original_path, d.managed_path,
                  d.history_dir_path, d.storage_mode, d.mime_type, d.is_starred, d.current_version_number,
                  d.version_count, d.health, a.title, d.created_at, d.updated_at
                FROM documents d
                LEFT JOIN activities a ON a.id = d.activity_id
                WHERE d.id = ?1
                "#,
                [document_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                        int_to_bool(row.get::<_, i64>(10)?),
                        row.get::<_, i64>(11)?,
                        row.get::<_, i64>(12)?,
                        row.get::<_, String>(13)?,
                        row.get::<_, Option<String>>(14)?,
                        row.get::<_, String>(15)?,
                        row.get::<_, String>(16)?,
                    ))
                },
            )?;
        let tags = self.fetch_document_tags(document_id)?;
        Ok(DocumentRecord {
            id: base.0,
            project_id: base.1,
            activity_id: base.2,
            name: base.3,
            base_name: base.4,
            original_path: self.decode_path_ref_to_string(&base.5),
            managed_path: self.decode_path_ref_to_string(&base.6),
            history_dir_path: self.decode_path_ref_to_string(&base.7),
            storage_mode: base.8,
            mime_type: base.9,
            is_starred: base.10,
            current_version_number: base.11,
            version_count: base.12,
            health: base.13,
            source_activity_title: base.14,
            tags,
            created_at: base.15,
            updated_at: base.16,
        })
    }

    fn ai_suggestion_record(&self, suggestion_id: i64) -> Result<AiSuggestionRecord> {
        self.conn
            .query_row(
                r#"
                SELECT
                  id, project_id, activity_id, note_id, suggestion_type, title, preview, payload_json, status, created_at, accepted_at
                FROM ai_suggestions WHERE id = ?1
                "#,
                [suggestion_id],
                |row| {
                    let payload_json: String = row.get(7)?;
                    let payload = serde_json::from_str::<Value>(&payload_json).unwrap_or_else(|_| json!({}));
                    Ok(AiSuggestionRecord {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        activity_id: row.get(2)?,
                        note_id: row.get(3)?,
                        suggestion_type: row.get(4)?,
                        title: row.get(5)?,
                        preview: row.get(6)?,
                        payload,
                        status: row.get(8)?,
                        created_at: row.get(9)?,
                        accepted_at: row.get(10)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    fn ai_profile_storage(&self, profile_id: i64) -> Result<AiProfileStorage> {
        self.conn
            .query_row(
                r#"
                SELECT
                  id, name, provider_family, base_url, api_key_ciphertext, api_key_nonce,
                  api_key_salt, api_key_last4, default_model, supports_text, supports_image,
                  supports_file, enabled, created_at, updated_at
                FROM ai_provider_profiles
                WHERE id = ?1
                "#,
                [profile_id],
                |row| {
                    Ok(AiProfileStorage {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        provider_family: row.get(2)?,
                        base_url: row.get(3)?,
                        api_key_ciphertext: row.get(4)?,
                        api_key_nonce: row.get(5)?,
                        api_key_salt: row.get(6)?,
                        api_key_last4: row.get(7)?,
                        default_model: row.get(8)?,
                        supports_text: int_to_bool(row.get::<_, i64>(9)?),
                        supports_image: int_to_bool(row.get::<_, i64>(10)?),
                        supports_file: int_to_bool(row.get::<_, i64>(11)?),
                        enabled: int_to_bool(row.get::<_, i64>(12)?),
                        created_at: row.get(13)?,
                        updated_at: row.get(14)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    fn ai_profile_record(&self, profile_id: i64) -> Result<AiProviderProfileRecord> {
        let profile = self.ai_profile_storage(profile_id)?;
        Ok(AiProviderProfileRecord {
            id: profile.id,
            name: profile.name,
            provider_family: profile.provider_family,
            base_url: profile.base_url,
            api_key_last4: profile.api_key_last4,
            has_stored_key: true,
            default_model: profile.default_model,
            supports_text: profile.supports_text,
            supports_image: profile.supports_image,
            supports_file: profile.supports_file,
            enabled: profile.enabled,
            created_at: profile.created_at,
            updated_at: profile.updated_at,
        })
    }

    fn fetch_ai_profiles(&self) -> Result<Vec<AiProviderProfileRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM ai_provider_profiles ORDER BY enabled DESC, updated_at DESC",
        )?;
        let ids = stmt
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter()
            .map(|profile_id| self.ai_profile_record(profile_id))
            .collect()
    }

    fn ai_binding_record(&self, capability: &str) -> Result<AiCapabilityBindingRecord> {
        let binding = self
            .conn
            .query_row(
                r#"
                SELECT capability, use_default, profile_id, model, updated_at
                FROM ai_capability_bindings
                WHERE capability = ?1
                "#,
                [capability],
                |row| {
                    Ok(AiCapabilityBindingRecord {
                        capability: row.get(0)?,
                        use_default: int_to_bool(row.get::<_, i64>(1)?),
                        profile_id: row.get(2)?,
                        model: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                },
            )
            .optional()?;

        Ok(binding.unwrap_or_else(|| AiCapabilityBindingRecord {
            capability: capability.to_string(),
            use_default: capability != "default",
            profile_id: None,
            model: None,
            updated_at: String::new(),
        }))
    }

    fn fetch_ai_bindings(&self) -> Result<Vec<AiCapabilityBindingRecord>> {
        AI_CAPABILITIES
            .iter()
            .map(|capability| self.ai_binding_record(capability))
            .collect()
    }

    fn decrypt_api_key_for_profile(&self, profile_id: i64) -> Result<String> {
        let profile = self.ai_profile_storage(profile_id)?;
        secret_crypto::decrypt_secret(
            &profile.api_key_ciphertext,
            &profile.api_key_nonce,
            &profile.api_key_salt,
            self.require_secret_password()?,
        )
    }

    fn resolve_profile_for_capability(&self, capability: &str) -> Result<ResolvedAiProfile> {
        let default_binding = self.ai_binding_record("default")?;
        let binding = if capability == "default" {
            default_binding.clone()
        } else {
            self.ai_binding_record(capability)?
        };

        let effective_binding = if capability != "default" && binding.use_default {
            default_binding
        } else {
            binding
        };

        let profile_id = effective_binding
            .profile_id
            .ok_or_else(|| anyhow!("AI capability '{}' is not configured yet", capability))?;
        let profile = self.ai_profile_storage(profile_id)?;
        if !profile.enabled {
            return Err(anyhow!(
                "AI capability '{}' points to a disabled profile",
                capability
            ));
        }

        let api_key = self.decrypt_api_key_for_profile(profile_id)?;
        let model = effective_binding
            .model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(profile.default_model.trim());

        if model.is_empty() {
            return Err(anyhow!(
                "AI capability '{}' does not have a model configured",
                capability
            ));
        }

        Ok(ResolvedAiProfile {
            provider_family: profile.provider_family,
            base_url: profile.base_url,
            api_key,
            model: model.to_string(),
            supports_text: profile.supports_text,
        })
    }

    fn insert_ai_suggestion(
        &self,
        project_id: i64,
        activity_id: Option<i64>,
        note_id: Option<i64>,
        suggestion_type: &str,
        title: &str,
        preview: &str,
        payload: Value,
        created_at: &str,
    ) -> Result<()> {
        self.conn.execute(
            r#"
            INSERT INTO ai_suggestions (
              project_id, activity_id, note_id, suggestion_type, title, preview, payload_json, status, created_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8)
            "#,
            params![
                project_id,
                activity_id,
                note_id,
                suggestion_type,
                title,
                preview,
                payload.to_string(),
                created_at
            ],
        )?;
        Ok(())
    }

    fn fetch_notes(&self, activity_id: i64) -> Result<Vec<NoteRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM notes WHERE activity_id = ?1 ORDER BY updated_at DESC, created_at DESC",
        )?;
        let ids = stmt
            .query_map([activity_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().map(|id| self.note_record(id)).collect()
    }

    fn fetch_conclusions(&self, activity_id: i64) -> Result<Vec<ConclusionRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM conclusions WHERE activity_id = ?1 ORDER BY is_pinned DESC, created_at DESC",
        )?;
        let ids = stmt
            .query_map([activity_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter()
            .map(|id| self.conclusion_record(id))
            .collect()
    }

    fn fetch_todos_for_activity(&self, activity_id: i64) -> Result<Vec<TodoRecord>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM todos WHERE activity_id = ?1 ORDER BY updated_at DESC")?;
        let ids = stmt
            .query_map([activity_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().map(|id| self.todo_record(id)).collect()
    }

    fn fetch_todo_progresses(&self, todo_id: i64) -> Result<Vec<TodoProgressRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM todo_progresses WHERE todo_id = ?1 ORDER BY progress_date DESC, created_at DESC",
        )?;
        let ids = stmt
            .query_map([todo_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter()
            .map(|id| self.todo_progress_record(id))
            .collect()
    }

    fn fetch_todo_ids_for_activity(&self, activity_id: i64) -> Result<Vec<i64>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM todos WHERE activity_id = ?1 ORDER BY updated_at DESC")?;
        let ids = stmt
            .query_map([activity_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ids)
    }

    fn fetch_documents(&self, activity_id: i64) -> Result<Vec<DocumentRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM documents WHERE activity_id = ?1 AND storage_mode != ?2 ORDER BY updated_at DESC",
        )?;
        let ids = stmt
            .query_map(
                params![activity_id, MANAGED_NOTE_IMAGE_STORAGE_MODE],
                |row| row.get::<_, i64>(0),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().map(|id| self.document_record(id)).collect()
    }

    fn fetch_all_documents_for_activity(&self, activity_id: i64) -> Result<Vec<DocumentRecord>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM documents WHERE activity_id = ?1 ORDER BY updated_at DESC")?;
        let ids = stmt
            .query_map([activity_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().map(|id| self.document_record(id)).collect()
    }

    fn fetch_all_documents_for_project(&self, project_id: i64) -> Result<Vec<DocumentRecord>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM documents WHERE project_id = ?1 ORDER BY updated_at DESC")?;
        let ids = stmt
            .query_map([project_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().map(|id| self.document_record(id)).collect()
    }

    fn fetch_document_tags(&self, document_id: i64) -> Result<Vec<DocumentTagRecord>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT f.id, f.label, f.color_key
            FROM document_tag_links l
            INNER JOIN file_tag_options f ON f.id = l.tag_id
            WHERE l.document_id = ?1
            ORDER BY f.created_at ASC, f.id ASC
            "#,
        )?;
        let rows = stmt.query_map([document_id], |row| {
            Ok(DocumentTagRecord {
                id: row.get(0)?,
                label: row.get(1)?,
                color_key: row.get(2)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    fn fetch_documents_for_project(
        &self,
        project_id: i64,
        starred_only: bool,
    ) -> Result<Vec<DocumentRecord>> {
        let query = if starred_only {
            "SELECT id FROM documents WHERE project_id = ?1 AND storage_mode != ?2 AND is_starred = 1 ORDER BY updated_at DESC"
        } else {
            "SELECT id FROM documents WHERE project_id = ?1 AND storage_mode != ?2 ORDER BY updated_at DESC"
        };
        let mut stmt = self.conn.prepare(query)?;
        let ids = stmt
            .query_map(
                params![project_id, MANAGED_NOTE_IMAGE_STORAGE_MODE],
                |row| row.get::<_, i64>(0),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().map(|id| self.document_record(id)).collect()
    }

    fn fetch_project_documents_for_project(&self, project_id: i64) -> Result<Vec<DocumentRecord>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id
            FROM documents
            WHERE project_id = ?1
              AND storage_mode != ?2
              AND (activity_id IS NULL OR is_starred = 1)
            ORDER BY updated_at DESC
            LIMIT 18
            "#,
        )?;
        let ids = stmt
            .query_map(
                params![project_id, MANAGED_NOTE_IMAGE_STORAGE_MODE],
                |row| row.get::<_, i64>(0),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().map(|id| self.document_record(id)).collect()
    }

    fn collect_note_html_rewrites_for_project(
        &self,
        project_id: i64,
        old_prefix: &Path,
        new_prefix: &Path,
    ) -> Result<Vec<(i64, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, content_html FROM notes WHERE project_id = ?1")?;
        let rows = stmt.query_map([project_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;

        let mut updates = Vec::new();
        for row in rows {
            let (id, content_html) = row?;
            let next_html = rewrite_rich_text_asset_paths(&content_html, old_prefix, new_prefix);
            if next_html != content_html {
                updates.push((id, next_html));
            }
        }

        Ok(updates)
    }

    fn collect_conclusion_html_rewrites_for_project(
        &self,
        project_id: i64,
        old_prefix: &Path,
        new_prefix: &Path,
    ) -> Result<Vec<(i64, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, content_html FROM conclusions WHERE project_id = ?1")?;
        let rows = stmt.query_map([project_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;

        let mut updates = Vec::new();
        for row in rows {
            let (id, content_html) = row?;
            let next_html = rewrite_rich_text_asset_paths(&content_html, old_prefix, new_prefix);
            if next_html != content_html {
                updates.push((id, next_html));
            }
        }

        Ok(updates)
    }

    fn collect_note_html_rewrites_for_activity(
        &self,
        activity_id: i64,
        old_prefix: &Path,
        new_prefix: &Path,
    ) -> Result<Vec<(i64, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, content_html FROM notes WHERE activity_id = ?1")?;
        let rows = stmt.query_map([activity_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;

        let mut updates = Vec::new();
        for row in rows {
            let (id, content_html) = row?;
            let next_html = rewrite_rich_text_asset_paths(&content_html, old_prefix, new_prefix);
            if next_html != content_html {
                updates.push((id, next_html));
            }
        }

        Ok(updates)
    }

    fn collect_conclusion_html_rewrites_for_activity(
        &self,
        activity_id: i64,
        old_prefix: &Path,
        new_prefix: &Path,
    ) -> Result<Vec<(i64, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, content_html FROM conclusions WHERE activity_id = ?1")?;
        let rows = stmt.query_map([activity_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;

        let mut updates = Vec::new();
        for row in rows {
            let (id, content_html) = row?;
            let next_html = rewrite_rich_text_asset_paths(&content_html, old_prefix, new_prefix);
            if next_html != content_html {
                updates.push((id, next_html));
            }
        }

        Ok(updates)
    }

    fn rewrite_path_ref_prefix_if_within(
        &self,
        path_ref: &str,
        old_prefix: &Path,
        new_prefix: &Path,
    ) -> String {
        let decoded = self.decode_path_ref(path_ref);
        rebase_path_prefix(&decoded, old_prefix, new_prefix)
            .map(|path| self.encode_path_ref(&path))
            .unwrap_or_else(|| path_ref.to_string())
    }

    fn document_version_record(&self, version_id: i64) -> Result<DocumentVersionRecord> {
        self.conn
            .query_row(
                r#"
                SELECT id, document_id, version_number, name, source_path, managed_path, created_at
                FROM document_versions
                WHERE id = ?1
                "#,
                [version_id],
                |row| {
                    let source_path_ref = row.get::<_, String>(4)?;
                    let managed_path_ref = row.get::<_, String>(5)?;
                    Ok(DocumentVersionRecord {
                        id: row.get(0)?,
                        document_id: row.get(1)?,
                        version_number: row.get(2)?,
                        name: row.get(3)?,
                        source_path: self.decode_path_ref_to_string(&source_path_ref),
                        managed_path: self.decode_path_ref_to_string(&managed_path_ref),
                        created_at: row.get(6)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    fn document_version_source_path_ref(
        &self,
        document_id: i64,
        version_number: i64,
    ) -> Result<String> {
        self.conn
            .query_row(
                "SELECT source_path FROM document_versions WHERE document_id = ?1 AND version_number = ?2",
                params![document_id, version_number],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    fn fetch_document_versions(&self, document_id: i64) -> Result<Vec<DocumentVersionRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM document_versions WHERE document_id = ?1 ORDER BY version_number DESC",
        )?;
        let ids = stmt
            .query_map([document_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter()
            .map(|version_id| self.document_version_record(version_id))
            .collect()
    }

    fn file_tag_record(&self, tag_id: i64) -> Result<FileTagRecord> {
        self.conn
            .query_row(
                r#"
                SELECT
                  f.id,
                  f.label,
                  f.color_key,
                  COUNT(l.document_id) AS usage_count,
                  f.created_at,
                  f.updated_at
                FROM file_tag_options f
                LEFT JOIN document_tag_links l ON l.tag_id = f.id
                WHERE f.id = ?1
                GROUP BY f.id, f.label, f.color_key, f.created_at, f.updated_at
                "#,
                [tag_id],
                |row| {
                    Ok(FileTagRecord {
                        id: row.get(0)?,
                        label: row.get(1)?,
                        color_key: row.get(2)?,
                        usage_count: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    fn fetch_file_tag_records(&self) -> Result<Vec<FileTagRecord>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM file_tag_options ORDER BY created_at ASC, id ASC")?;
        let ids = stmt
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter()
            .map(|tag_id| self.file_tag_record(tag_id))
            .collect()
    }

    fn record_type_storage(&self, type_id: i64) -> Result<RecordTypeStorage> {
        self.conn
            .query_row(
                r#"
                SELECT id, key, label, color_key, template_html, is_default, created_at, updated_at
                FROM record_type_options
                WHERE id = ?1
                "#,
                [type_id],
                record_type_storage_from_row,
            )
            .map_err(Into::into)
    }

    fn record_type_record(&self, type_id: i64) -> Result<RecordTypeRecord> {
        let storage = self.record_type_storage(type_id)?;
        let usage_count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE note_type = ?1",
            params![storage.key.as_str()],
            |row| row.get(0),
        )?;

        Ok(RecordTypeRecord {
            id: storage.id,
            key: storage.key,
            label: storage.label,
            color_key: storage.color_key,
            template_html: storage.template_html,
            is_default: storage.is_default,
            usage_count,
            created_at: storage.created_at,
            updated_at: storage.updated_at,
        })
    }

    fn record_type_record_by_key(&self, key: &str) -> Result<RecordTypeRecord> {
        let type_id = self.conn.query_row(
            "SELECT id FROM record_type_options WHERE key = ?1",
            params![key],
            |row| row.get::<_, i64>(0),
        )?;
        self.record_type_record(type_id)
    }

    fn fetch_record_type_records(&self) -> Result<Vec<RecordTypeRecord>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id
            FROM record_type_options
            ORDER BY is_default DESC, created_at ASC, id ASC
            "#,
        )?;
        let ids = stmt
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);

        ids.into_iter()
            .map(|type_id| self.record_type_record(type_id))
            .collect()
    }

    fn record_type_count(&self) -> Result<i64> {
        self.conn
            .query_row("SELECT COUNT(*) FROM record_type_options", [], |row| {
                row.get(0)
            })
            .map_err(Into::into)
    }

    fn generate_unique_record_type_key(&self, label: &str) -> Result<String> {
        let base = normalize_record_type_key_from_label(label);
        let base_candidate = if base.is_empty() {
            format!("record_type_{}", Utc::now().timestamp_millis())
        } else {
            base
        };
        let mut candidate = base_candidate.clone();
        let mut suffix = 2;

        while self
            .conn
            .query_row(
                "SELECT id FROM record_type_options WHERE key = ?1",
                params![candidate.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some()
        {
            candidate = format!("{base_candidate}-{suffix}");
            suffix += 1;
        }

        Ok(candidate)
    }

    fn replace_document_tags(
        &mut self,
        document_id: i64,
        tag_ids: &[i64],
        timestamp: &str,
    ) -> Result<()> {
        let normalized_tag_ids = normalize_file_tag_ids(tag_ids);
        for &tag_id in &normalized_tag_ids {
            self.file_tag_record(tag_id)?;
        }

        self.conn.execute(
            "DELETE FROM document_tag_links WHERE document_id = ?1",
            params![document_id],
        )?;

        for tag_id in normalized_tag_ids {
            self.conn.execute(
                r#"
                INSERT INTO document_tag_links (document_id, tag_id, created_at)
                VALUES (?1, ?2, ?3)
                "#,
                params![document_id, tag_id, timestamp],
            )?;
        }

        Ok(())
    }

    fn fetch_project_todos(&self, project_id: i64, finished: bool) -> Result<Vec<TodoRecord>> {
        let query = if finished {
            "SELECT id FROM todos WHERE project_id = ?1 AND status = 'finished' ORDER BY updated_at DESC"
        } else {
            "SELECT id FROM todos WHERE project_id = ?1 AND status = 'unfinished' ORDER BY updated_at DESC"
        };
        let mut stmt = self.conn.prepare(query)?;
        let ids = stmt
            .query_map([project_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().map(|id| self.todo_record(id)).collect()
    }

    fn fetch_ai_suggestions(&self, activity_id: Option<i64>) -> Result<Vec<AiSuggestionRecord>> {
        let mut ids = Vec::new();
        if let Some(activity_id) = activity_id {
            let mut stmt = self.conn.prepare(
                "SELECT id FROM ai_suggestions WHERE activity_id = ?1 ORDER BY created_at DESC",
            )?;
            ids = stmt
                .query_map([activity_id], |row| row.get::<_, i64>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
        }
        ids.into_iter()
            .map(|id| self.ai_suggestion_record(id))
            .collect()
    }

    fn backfill_file_layout_metadata(&self) -> Result<()> {
        self.conn.execute(
            "UPDATE documents SET base_name = name WHERE base_name = ''",
            [],
        )?;
        self.conn.execute(
            "UPDATE documents SET current_version_number = 1 WHERE current_version_number < 1",
            [],
        )?;
        self.conn.execute(
            r#"
            UPDATE documents
            SET version_count = CASE
              WHEN version_count < current_version_number THEN current_version_number
              WHEN version_count < 1 THEN 1
              ELSE version_count
            END
            "#,
            [],
        )?;
        Ok(())
    }

    fn ensure_project_file_layout(&mut self, _project_id: i64) -> Result<()> {
        self.backfill_file_layout_metadata()
    }

    fn default_activity_folder_name(&self, title: &str, activity_id: i64) -> String {
        let raw = normalize_activity_title(title, activity_id);
        let sanitized = normalize_windows_safe_component(&raw);

        if sanitized.is_empty() {
            normalize_windows_safe_component(&untitled_activity_title(activity_id))
        } else {
            sanitized
        }
    }

    fn create_activity_directory(&self, project_root: &str, folder_name: &str) -> Result<PathBuf> {
        let activity_dir = PathBuf::from(project_root).join(folder_name);
        if activity_dir.exists() {
            return Err(anyhow!(
                "activity folder rename failed: target folder already exists at {}",
                activity_dir.display()
            ));
        }
        fs::create_dir_all(&activity_dir)?;
        Ok(activity_dir)
    }

    fn document_target_dir(
        &mut self,
        project_id: i64,
        activity_id: Option<i64>,
    ) -> Result<PathBuf> {
        let project = self.project_record(project_id)?;
        let project_root = PathBuf::from(&project.root_path);
        fs::create_dir_all(&project_root)?;

        if let Some(activity_id) = activity_id {
            let activity = self.activity_row(activity_id)?;
            if activity.project_id != project_id {
                return Err(anyhow!("activity does not belong to the selected project"));
            }
            let folder_name = if activity.folder_name.trim().is_empty() {
                let computed = self.default_activity_folder_name(&activity.title, activity_id);
                self.conn.execute(
                    "UPDATE activities SET folder_name = ?1 WHERE id = ?2",
                    params![computed, activity_id],
                )?;
                computed
            } else {
                activity.folder_name
            };
            let activity_dir = project_root.join(folder_name);
            fs::create_dir_all(&activity_dir)?;
            Ok(activity_dir)
        } else {
            Ok(project_root)
        }
    }

    fn note_image_target_dir(
        &mut self,
        project_id: i64,
        activity_id: Option<i64>,
    ) -> Result<PathBuf> {
        let project = self.project_record(project_id)?;
        let project_root = PathBuf::from(&project.root_path);
        fs::create_dir_all(&project_root)?;

        if let Some(activity_id) = activity_id {
            let activity = self.activity_row(activity_id)?;
            if activity.project_id != project_id {
                return Err(anyhow!("activity does not belong to the selected project"));
            }
        }

        let target_dir = project_root
            .join(WORKSPACE_HIDDEN_DIR_NAME)
            .join(PROJECT_NOTE_ASSET_DIR_NAME)
            .join(
                activity_id
                    .map(|value| format!("activity-{value}"))
                    .unwrap_or_else(|| "project".to_string()),
            );
        fs::create_dir_all(&target_dir)?;
        Ok(target_dir)
    }

    fn document_name_exists(
        &self,
        project_id: i64,
        activity_id: Option<i64>,
        base_name: &str,
        exclude_document_id: Option<i64>,
    ) -> Result<bool> {
        self.conn
            .query_row(
                r#"
                SELECT id
                FROM documents
                WHERE project_id = ?1
                  AND ((activity_id IS NULL AND ?2 IS NULL) OR activity_id = ?2)
                  AND base_name = ?3
                  AND id != ?4
                LIMIT 1
                "#,
                params![
                    project_id,
                    activity_id,
                    base_name,
                    exclude_document_id.unwrap_or(-1)
                ],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map(|row| row.is_some())
            .map_err(Into::into)
    }

    fn ensure_document_name_available(
        &self,
        project_id: i64,
        activity_id: Option<i64>,
        base_name: &str,
        exclude_document_id: Option<i64>,
    ) -> Result<()> {
        if self.document_name_exists(project_id, activity_id, base_name, exclude_document_id)? {
            return Err(anyhow!(
                "a file named '{}' already exists in the target location; rename it or add a new version instead",
                base_name
            ));
        }

        Ok(())
    }

    fn resolve_internal_document_name(
        &self,
        project_id: i64,
        activity_id: Option<i64>,
        desired_name: &str,
        target_dir: &Path,
    ) -> Result<String> {
        let desired_path = Path::new(desired_name);
        let stem = desired_path
            .file_stem()
            .and_then(|value| value.to_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("file name cannot be empty"))?;
        let extension = desired_path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let mut suffix = 1;

        loop {
            let candidate = if suffix == 1 {
                desired_name.to_string()
            } else if let Some(extension) = extension {
                format!("{stem}-{suffix}.{extension}")
            } else {
                format!("{stem}-{suffix}")
            };

            if !self.document_name_exists(project_id, activity_id, &candidate, None)?
                && !target_dir.join(&candidate).exists()
            {
                return Ok(candidate);
            }

            suffix += 1;
        }
    }

    fn normalize_document_base_name(&self, raw: &str, current_base_name: &str) -> Result<String> {
        let sanitized = normalize_windows_safe_component(raw);

        if sanitized.is_empty() {
            return Err(anyhow!("file name cannot be empty"));
        }

        let stem = Path::new(&sanitized)
            .file_stem()
            .and_then(|value| value.to_str())
            .map(str::trim)
            .unwrap_or("");
        if stem.is_empty() {
            return Err(anyhow!("file name cannot be empty"));
        }

        let has_extension = Path::new(&sanitized)
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        if has_extension {
            return Ok(sanitized);
        }

        let current_extension = Path::new(current_base_name)
            .extension()
            .and_then(|value| value.to_str())
            .map(str::trim)
            .filter(|value| !value.is_empty());

        Ok(match current_extension {
            Some(extension) => format!("{sanitized}.{extension}"),
            None => sanitized,
        })
    }

    fn materialize_file_for_target(
        &self,
        project_root: &Path,
        source: &Path,
        target_path: &Path,
    ) -> Result<String> {
        if source == target_path {
            return Ok("managed_existing".to_string());
        }

        if target_path.exists() {
            return Err(anyhow!(
                "target file already exists at {}",
                target_path.display()
            ));
        }

        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent)?;
        }

        if path_is_within(source, project_root) {
            fs::rename(source, target_path).with_context(|| {
                format!(
                    "failed to move file from {} to {}",
                    source.display(),
                    target_path.display()
                )
            })?;
            Ok("managed_move".to_string())
        } else {
            fs::copy(source, target_path).with_context(|| {
                format!(
                    "failed to copy file from {} to {}",
                    source.display(),
                    target_path.display()
                )
            })?;
            Ok("managed_copy".to_string())
        }
    }

    fn history_dir_path_for(&self, managed_path: &Path, document_id: i64) -> PathBuf {
        managed_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(format!(".{}.pm-versions", document_id))
    }

    fn move_document_storage(
        &mut self,
        document: &DocumentRecord,
        next_activity_id: Option<i64>,
        next_base_name: &str,
    ) -> Result<()> {
        struct VersionStoragePlan {
            version_id: i64,
            source_path: PathBuf,
            temp_path: Option<PathBuf>,
            final_name: String,
            final_path: PathBuf,
            final_path_ref: String,
        }

        let target_dir = self.document_target_dir(document.project_id, next_activity_id)?;
        self.ensure_document_name_available(
            document.project_id,
            next_activity_id,
            next_base_name,
            Some(document.id),
        )?;

        let history_dir = PathBuf::from(&document.history_dir_path);
        let next_current_name =
            versioned_file_name(next_base_name, document.current_version_number);
        let next_current_path = target_dir.join(&next_current_name);
        let next_history_dir = self.history_dir_path_for(&next_current_path, document.id);
        let versions = self.fetch_document_versions(document.id)?;
        let known_paths = versions
            .iter()
            .map(|version| PathBuf::from(&version.managed_path))
            .collect::<HashSet<_>>();

        if next_history_dir.exists() && next_history_dir != history_dir {
            return Err(anyhow!(
                "target history folder already exists at {}",
                next_history_dir.display()
            ));
        }

        if let Some(parent) = next_current_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let needs_history_dir = versions
            .iter()
            .any(|version| version.version_number != document.current_version_number);
        if needs_history_dir {
            fs::create_dir_all(&next_history_dir)?;
        }

        let mut plans = Vec::with_capacity(versions.len());
        for version in versions {
            let source_path = PathBuf::from(&version.managed_path);
            let final_name = versioned_file_name(next_base_name, version.version_number);
            let final_path = if version.version_number == document.current_version_number {
                next_current_path.clone()
            } else {
                next_history_dir.join(&final_name)
            };

            if final_path.exists() && !known_paths.contains(&final_path) {
                return Err(anyhow!(
                    "target file already exists at {}",
                    final_path.display()
                ));
            }

            let temp_path = if source_path.exists() && source_path != final_path {
                let temp_name =
                    format!(".{}.pm-rename-{}.tmp", document.id, version.version_number);
                let candidate = source_path.with_file_name(temp_name);
                if candidate.exists() {
                    return Err(anyhow!(
                        "temporary rename path already exists at {}",
                        candidate.display()
                    ));
                }
                Some(candidate)
            } else {
                None
            };

            plans.push(VersionStoragePlan {
                version_id: version.id,
                source_path,
                temp_path,
                final_name,
                final_path: final_path.clone(),
                final_path_ref: self.encode_path_ref(&final_path),
            });
        }

        let next_current_path_ref = self.encode_path_ref(&next_current_path);
        let next_history_dir_ref = self.encode_path_ref(&next_history_dir);

        let rollback_file_moves = |plans: &[VersionStoragePlan], finalized_count: usize| {
            for plan in plans.iter().take(finalized_count).rev() {
                if plan.final_path.exists() && plan.final_path != plan.source_path {
                    let _ = fs::rename(&plan.final_path, &plan.source_path);
                }
            }
            for plan in plans.iter().skip(finalized_count) {
                if let Some(temp_path) = &plan.temp_path {
                    if temp_path.exists() {
                        let _ = fs::rename(temp_path, &plan.source_path);
                    }
                }
            }
        };

        for plan in &plans {
            if let Some(temp_path) = &plan.temp_path {
                fs::rename(&plan.source_path, temp_path).with_context(|| {
                    format!(
                        "failed to prepare file rename from {} to {}",
                        plan.source_path.display(),
                        temp_path.display()
                    )
                })?;
            }
        }

        let mut finalized_count = 0usize;
        for plan in &plans {
            if let Some(temp_path) = &plan.temp_path {
                if let Some(parent) = plan.final_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                if let Err(error) = fs::rename(temp_path, &plan.final_path).with_context(|| {
                    format!(
                        "failed to move renamed file from {} to {}",
                        temp_path.display(),
                        plan.final_path.display()
                    )
                }) {
                    rollback_file_moves(&plans, finalized_count);
                    return Err(error);
                }
                finalized_count += 1;
            }
        }

        let tx = match self.conn.transaction() {
            Ok(tx) => tx,
            Err(error) => {
                rollback_file_moves(&plans, finalized_count);
                return Err(error.into());
            }
        };

        let update_result: Result<()> = (|| {
            tx.execute(
                "UPDATE documents SET name = ?1, managed_path = ?2, history_dir_path = ?3 WHERE id = ?4",
                params![
                    next_current_name,
                    next_current_path_ref,
                    next_history_dir_ref,
                    document.id
                ],
            )?;

            for plan in &plans {
                tx.execute(
                    "UPDATE document_versions SET name = ?1, managed_path = ?2 WHERE id = ?3",
                    params![plan.final_name, plan.final_path_ref, plan.version_id],
                )?;
            }

            tx.commit()?;
            Ok(())
        })();

        if let Err(error) = update_result {
            rollback_file_moves(&plans, finalized_count);
            return Err(error);
        }

        if history_dir != next_history_dir && history_dir.exists() {
            let _ = fs::remove_dir(&history_dir);
        }

        Ok(())
    }

    fn rename_activity_folder(
        &mut self,
        activity_id: i64,
        current: &ActivityFsRecord,
        next_title: &str,
        _timestamp: &str,
    ) -> Result<()> {
        let project = self.project_record(current.project_id)?;
        let project_root = PathBuf::from(&project.root_path);
        let current_folder = if current.folder_name.trim().is_empty() {
            self.default_activity_folder_name(&current.title, activity_id)
        } else {
            current.folder_name.clone()
        };
        let next_folder = self.default_activity_folder_name(next_title, activity_id);

        if current_folder == next_folder {
            if current.folder_name != next_folder {
                self.conn.execute(
                    "UPDATE activities SET folder_name = ?1 WHERE id = ?2",
                    params![next_folder, activity_id],
                )?;
            }
            return Ok(());
        }

        let current_dir = project_root.join(&current_folder);
        let next_dir = project_root.join(&next_folder);
        if next_dir.exists() {
            return Err(anyhow!("文件夹名称已被占用，activity 名称未保存"));
        }

        let documents = self.fetch_documents(activity_id)?;
        let mut document_versions = Vec::new();
        let mut next_document_paths = Vec::new();
        for document in &documents {
            document_versions.push((document.id, self.fetch_document_versions(document.id)?));
            let next_current_path = next_dir.join(&document.name);
            let next_history_dir = self.history_dir_path_for(&next_current_path, document.id);
            next_document_paths.push((document.id, next_current_path, next_history_dir));
        }
        let encoded_path_updates = next_document_paths
            .iter()
            .map(|(document_id, next_current_path, next_history_dir)| {
                (
                    *document_id,
                    self.encode_path_ref(next_current_path),
                    self.encode_path_ref(next_history_dir),
                )
            })
            .collect::<Vec<_>>();
        let encoded_version_updates = documents
            .iter()
            .map(|document| {
                let (_, _, next_history_dir) = next_document_paths
                    .iter()
                    .find(|(document_id, _, _)| *document_id == document.id)
                    .cloned()
                    .ok_or_else(|| anyhow!("missing path update for document {}", document.id))?;
                let versions = document_versions
                    .iter()
                    .find(|(document_id, _)| *document_id == document.id)
                    .map(|(_, versions)| versions.clone())
                    .unwrap_or_default();
                let version_updates = versions
                    .into_iter()
                    .map(|version| {
                        let file_name = Path::new(&version.managed_path)
                            .file_name()
                            .and_then(|value| value.to_str())
                            .map(ToOwned::to_owned)
                            .unwrap_or_else(|| version.name.clone());
                        let next_version_path =
                            if version.version_number == document.current_version_number {
                                next_dir.join(file_name)
                            } else {
                                next_history_dir.join(file_name)
                            };
                        Ok((version.id, self.encode_path_ref(&next_version_path)))
                    })
                    .collect::<Result<Vec<_>>>()?;
                Ok((document.id, version_updates))
            })
            .collect::<Result<Vec<_>>>()?;
        let note_html_updates =
            self.collect_note_html_rewrites_for_activity(activity_id, &current_dir, &next_dir)?;
        let conclusion_html_updates = self.collect_conclusion_html_rewrites_for_activity(
            activity_id,
            &current_dir,
            &next_dir,
        )?;

        let renamed_existing_dir = current_dir.exists();
        if renamed_existing_dir {
            fs::rename(&current_dir, &next_dir).with_context(|| {
                format!(
                    "failed to rename activity folder from {} to {}",
                    current_dir.display(),
                    next_dir.display()
                )
            })?;
        } else {
            fs::create_dir_all(&next_dir)?;
        }

        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE activities SET folder_name = ?1 WHERE id = ?2",
            params![next_folder, activity_id],
        )?;
        for document in &documents {
            let (_, _next_current_path, _next_history_dir) = next_document_paths
                .iter()
                .find(|(document_id, _, _)| *document_id == document.id)
                .cloned()
                .ok_or_else(|| anyhow!("missing path update for document {}", document.id))?;
            tx.execute(
                "UPDATE documents SET managed_path = ?1, history_dir_path = ?2 WHERE id = ?3",
                params![
                    encoded_path_updates
                        .iter()
                        .find(|(document_id, _, _)| *document_id == document.id)
                        .map(|(_, managed_path_ref, _)| managed_path_ref.clone())
                        .ok_or_else(|| anyhow!(
                            "missing managed path ref for document {}",
                            document.id
                        ))?,
                    encoded_path_updates
                        .iter()
                        .find(|(document_id, _, _)| *document_id == document.id)
                        .map(|(_, _, history_dir_ref)| history_dir_ref.clone())
                        .ok_or_else(|| anyhow!(
                            "missing history path ref for document {}",
                            document.id
                        ))?,
                    document.id
                ],
            )?;
            let versions = document_versions
                .iter()
                .find(|(document_id, _)| *document_id == document.id)
                .map(|(_, versions)| versions.clone())
                .unwrap_or_default();
            for version in versions {
                let next_version_path_ref = encoded_version_updates
                    .iter()
                    .find(|(document_id, _)| *document_id == document.id)
                    .and_then(|(_, version_updates)| {
                        version_updates
                            .iter()
                            .find(|(version_id, _)| *version_id == version.id)
                            .map(|(_, path_ref)| path_ref.clone())
                    })
                    .ok_or_else(|| {
                        anyhow!("missing version path ref for version {}", version.id)
                    })?;
                tx.execute(
                    "UPDATE document_versions SET managed_path = ?1 WHERE id = ?2",
                    params![next_version_path_ref, version.id],
                )?;
            }
        }

        apply_note_html_updates(&tx, &note_html_updates)?;
        apply_conclusion_html_updates(&tx, &conclusion_html_updates)?;

        if let Err(error) = tx.commit() {
            if renamed_existing_dir {
                let _ = fs::rename(&next_dir, &current_dir);
            } else {
                let _ = fs::remove_dir(&next_dir);
            }
            return Err(error.into());
        }

        Ok(())
    }

    fn fetch_conclusion_groups(&self, project_id: i64) -> Result<Vec<ConclusionGroup>> {
        let mut groups = Vec::new();

        let mut project_stmt = self.conn.prepare(
            "SELECT id FROM conclusions WHERE project_id = ?1 AND activity_id IS NULL ORDER BY is_pinned DESC, created_at DESC",
        )?;
        let project_ids = project_stmt
            .query_map([project_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if !project_ids.is_empty() {
            let conclusions = project_ids
                .into_iter()
                .map(|id| self.conclusion_record(id))
                .collect::<Result<Vec<_>>>()?;
            groups.push(ConclusionGroup {
                activity_id: None,
                activity_title: "Project-Level".to_string(),
                conclusions,
            });
        }

        let mut stmt = self.conn.prepare(
            "SELECT id, title FROM activities WHERE project_id = ?1 ORDER BY activity_time DESC, updated_at DESC",
        )?;
        let activities = stmt
            .query_map([project_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        for (activity_id, activity_title) in activities {
            let mut conclusion_stmt = self.conn.prepare(
                "SELECT id FROM conclusions WHERE project_id = ?1 AND activity_id = ?2 AND promoted_to_project = 1 ORDER BY is_pinned DESC, created_at DESC",
            )?;
            let conclusion_ids = conclusion_stmt
                .query_map(params![project_id, activity_id], |row| row.get::<_, i64>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if conclusion_ids.is_empty() {
                continue;
            }
            let conclusions = conclusion_ids
                .into_iter()
                .map(|id| self.conclusion_record(id))
                .collect::<Result<Vec<_>>>()?;
            groups.push(ConclusionGroup {
                activity_id: Some(activity_id),
                activity_title: normalize_activity_title(&activity_title, activity_id),
                conclusions,
            });
        }

        Ok(groups)
    }

    fn activity_digests(&self, project_id: i64, limit: Option<i64>) -> Result<Vec<ActivityDigest>> {
        let base = format!(
            r#"
            SELECT
              a.id,
              a.project_id,
              a.attribute_option_id,
              ao.label,
              ao.color_key,
              a.title,
              a.activity_time,
              COALESCE(a.status_option_id, (SELECT id FROM activity_status_options WHERE system_key = '{SYSTEM_ACTIVITY_STATUS_PENDING}' LIMIT 1)) AS status_option_id,
              COALESCE(so.label, (SELECT label FROM activity_status_options WHERE system_key = '{SYSTEM_ACTIVITY_STATUS_PENDING}' LIMIT 1)) AS status_label,
              COALESCE(so.color_key, (SELECT color_key FROM activity_status_options WHERE system_key = '{SYSTEM_ACTIVITY_STATUS_PENDING}' LIMIT 1), '{DEFAULT_ACTIVITY_STATUS_COLOR_KEY}') AS status_color_key,
              COALESCE(
                so.needs_attention,
                (SELECT needs_attention FROM activity_status_options WHERE system_key = '{SYSTEM_ACTIVITY_STATUS_PENDING}' LIMIT 1),
                1
              ) AS status_needs_attention,
              a.is_pinned,
              (SELECT COUNT(*) FROM notes n WHERE n.activity_id = a.id) AS note_count,
              (SELECT COUNT(*) FROM conclusions c WHERE c.activity_id = a.id) AS conclusion_count,
              (SELECT COUNT(*) FROM todos t WHERE t.activity_id = a.id) AS todo_count,
              (SELECT COUNT(*) FROM documents d WHERE d.activity_id = a.id AND d.storage_mode != '{MANAGED_NOTE_IMAGE_STORAGE_MODE}') AS document_count,
              (SELECT COUNT(*) FROM todos t WHERE t.activity_id = a.id AND t.status = 'finished') AS completed_todo_count,
              (SELECT COUNT(*) FROM todos t WHERE t.activity_id = a.id) AS total_todo_count,
              EXISTS(SELECT 1 FROM todos t WHERE t.activity_id = a.id AND t.status = 'unfinished') AS has_open_todos
            FROM activities a
            LEFT JOIN activity_attribute_options ao ON ao.id = a.attribute_option_id
            LEFT JOIN activity_status_options so ON so.id = a.status_option_id
            WHERE a.project_id = ?1
            ORDER BY a.activity_time DESC, a.updated_at DESC
            {}
            "#,
            limit.map(|_| "LIMIT ?2").unwrap_or("")
        );
        let mut stmt = self.conn.prepare(&base)?;
        let rows = if let Some(limit) = limit {
            stmt.query_map(params![project_id, limit], activity_digest_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            stmt.query_map([project_id], activity_digest_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        Ok(rows)
    }

    fn activity_card(&self, activity_id: i64) -> Result<ActivityCardData> {
        let base = self.conn.query_row(
            r#"
            SELECT
              a.id,
              a.project_id,
              a.attribute_option_id,
              ao.label,
              ao.color_key,
              a.title,
              a.brief_markdown,
              a.brief_html,
              a.activity_time,
              COALESCE(a.status_option_id, (SELECT id FROM activity_status_options WHERE system_key = ?2 LIMIT 1)),
              COALESCE(so.label, (SELECT label FROM activity_status_options WHERE system_key = ?2 LIMIT 1)),
              COALESCE(so.color_key, (SELECT color_key FROM activity_status_options WHERE system_key = ?2 LIMIT 1), ?3),
              COALESCE(
                so.needs_attention,
                (SELECT needs_attention FROM activity_status_options WHERE system_key = ?2 LIMIT 1),
                1
              ),
              a.is_pinned,
              a.is_expanded,
              a.created_at,
              a.updated_at
            FROM activities a
            LEFT JOIN activity_attribute_options ao ON ao.id = a.attribute_option_id
            LEFT JOIN activity_status_options so ON so.id = a.status_option_id
            WHERE a.id = ?1
            "#,
            params![activity_id, SYSTEM_ACTIVITY_STATUS_PENDING, DEFAULT_ACTIVITY_STATUS_COLOR_KEY],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                    int_to_bool(row.get::<_, i64>(12)?),
                    int_to_bool(row.get::<_, i64>(13)?),
                    int_to_bool(row.get::<_, i64>(14)?),
                    row.get::<_, String>(15)?,
                    row.get::<_, String>(16)?,
                ))
            },
        )?;
        let notes = self.fetch_notes(activity_id)?;
        let conclusions = self.fetch_conclusions(activity_id)?;
        let todos = self.fetch_todos_for_activity(activity_id)?;
        let documents = self.fetch_documents(activity_id)?;
        let ai_suggestions = self.fetch_ai_suggestions(Some(activity_id))?;
        let digest = ActivityDigest {
            id: base.0,
            project_id: base.1,
            attribute_option_id: base.2,
            attribute_label: base.3.clone(),
            attribute_color_key: base.4.clone(),
            title: base.5.clone(),
            activity_time: base.8.clone(),
            status_option_id: base.9,
            status_label: base.10.clone(),
            status_color_key: base.11.clone(),
            status_needs_attention: base.12,
            is_pinned: base.13,
            note_count: notes.len() as i64,
            conclusion_count: conclusions.len() as i64,
            todo_count: todos.len() as i64,
            document_count: documents.len() as i64,
            completed_todo_count: todos
                .iter()
                .filter(|todo| todo.status == "finished")
                .count() as i64,
            total_todo_count: todos.len() as i64,
            has_open_todos: todos.iter().any(|todo| todo.status == "unfinished"),
        };

        Ok(ActivityCardData {
            id: base.0,
            project_id: base.1,
            attribute_option_id: base.2,
            attribute_label: base.3,
            attribute_color_key: base.4,
            title: base.5,
            brief_markdown: base.6,
            brief_html: base.7,
            activity_time: base.8,
            status_option_id: base.9,
            status_label: base.10,
            status_color_key: base.11,
            status_needs_attention: base.12,
            is_pinned: base.13,
            is_expanded: base.14,
            created_at: base.15,
            updated_at: base.16,
            digest,
            notes,
            conclusions,
            todos,
            documents,
            ai_suggestions,
        })
    }

    fn list_project_conclusions(
        &self,
        project_id: i64,
        promoted_only: bool,
    ) -> Result<Vec<ConclusionRecord>> {
        let query = if promoted_only {
            "SELECT id FROM conclusions WHERE project_id = ?1 AND promoted_to_project = 1 ORDER BY is_pinned DESC, created_at DESC LIMIT 8"
        } else {
            "SELECT id FROM conclusions WHERE project_id = ?1 ORDER BY is_pinned DESC, created_at DESC"
        };
        let mut stmt = self.conn.prepare(query)?;
        let ids = stmt
            .query_map([project_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter()
            .map(|id| self.conclusion_record(id))
            .collect()
    }

    fn ai_source(
        &self,
        project_id: i64,
        activity_id: i64,
        note_id: Option<i64>,
    ) -> Result<(String, String)> {
        let title: String = self.conn.query_row(
            "SELECT title FROM activities WHERE id = ?1 AND project_id = ?2",
            params![activity_id, project_id],
            |row| row.get::<_, String>(0),
        )?;

        if let Some(note_id) = note_id {
            let note = self.note_record(note_id)?;
            return Ok((title, note.content_markdown));
        }

        let notes = self.fetch_notes(activity_id)?;
        let source = notes
            .iter()
            .map(|note| note.content_markdown.clone())
            .collect::<Vec<_>>()
            .join("\n");
        Ok((title, source))
    }

    fn refresh_document_health(&mut self, project_id: i64) -> Result<()> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, managed_path, health FROM documents WHERE project_id = ?1")?;
        let rows = stmt
            .query_map([project_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        for (id, managed_path_ref, health) in rows {
            let exists = self.decode_path_ref(&managed_path_ref).exists();
            let next_health = if exists { "normal" } else { "missing" };
            if next_health != health {
                self.conn.execute(
                    "UPDATE documents SET health = ?1, updated_at = ?2 WHERE id = ?3",
                    params![next_health, now_iso(), id],
                )?;
            }
        }
        Ok(())
    }

    fn touch_project(&self, project_id: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
            params![now_iso(), project_id],
        )?;
        self.mark_project_artifacts_stale(project_id)?;
        self.mark_daily_artifacts_stale()?;
        Ok(())
    }

    fn touch_activity(&self, activity_id: i64) -> Result<()> {
        let project_id: i64 = self.conn.query_row(
            "SELECT project_id FROM activities WHERE id = ?1",
            [activity_id],
            |row| row.get(0),
        )?;
        self.conn.execute(
            "UPDATE activities SET updated_at = ?1 WHERE id = ?2",
            params![now_iso(), activity_id],
        )?;
        self.mark_activity_artifacts_stale(project_id, activity_id)?;
        self.conn.execute(
            "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
            params![now_iso(), project_id],
        )?;
        self.mark_project_artifacts_stale(project_id)?;
        self.mark_daily_artifacts_stale()?;
        Ok(())
    }

    fn mark_project_artifacts_stale(&self, project_id: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE ai_artifacts SET status = ?1, updated_at = ?2 WHERE project_id = ?3 AND kind = 'project_brief'",
            params![AI_ARTIFACT_STATUS_STALE, now_iso(), project_id],
        )?;
        Ok(())
    }

    fn mark_activity_artifacts_stale(&self, project_id: i64, activity_id: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE ai_artifacts SET status = ?1, updated_at = ?2 WHERE project_id = ?3 AND activity_id = ?4 AND kind = 'activity_summary'",
            params![AI_ARTIFACT_STATUS_STALE, now_iso(), project_id, activity_id],
        )?;
        Ok(())
    }

    fn mark_daily_artifacts_stale(&self) -> Result<()> {
        self.conn.execute(
            "UPDATE ai_artifacts SET status = ?1, updated_at = ?2 WHERE kind = 'daily_brief'",
            params![AI_ARTIFACT_STATUS_STALE, now_iso()],
        )?;
        Ok(())
    }

    fn rebuild_todo_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            DROP TABLE IF EXISTS todo_progresses;
            DROP TABLE IF EXISTS todos;

            CREATE TABLE todos (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_id INTEGER NOT NULL,
              activity_id INTEGER,
              content TEXT NOT NULL,
              priority TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'unfinished',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
              FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE SET NULL
            );

            CREATE TABLE todo_progresses (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              todo_id INTEGER NOT NULL,
              content TEXT NOT NULL,
              progress_date TEXT NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY(todo_id) REFERENCES todos(id) ON DELETE CASCADE
            );
            "#,
        )?;
        Ok(())
    }

    fn rebuild_document_schema(&self) -> Result<()> {
        let promoted_expr = if self.has_column("documents", "promoted_to_project")? {
            "COALESCE(promoted_to_project, 0)"
        } else {
            "0"
        };
        let role_expr = if self.has_column("documents", "role")? {
            "COALESCE(role, '') = 'key_material'"
        } else {
            "0"
        };
        let sql = format!(
            r#"
            PRAGMA foreign_keys = OFF;
            BEGIN IMMEDIATE;

            CREATE TABLE documents_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_id INTEGER NOT NULL,
              activity_id INTEGER,
              name TEXT NOT NULL,
              base_name TEXT NOT NULL DEFAULT '',
              original_path TEXT NOT NULL,
              managed_path TEXT NOT NULL,
              history_dir_path TEXT NOT NULL DEFAULT '',
              storage_mode TEXT NOT NULL,
              mime_type TEXT NOT NULL,
              is_starred INTEGER NOT NULL DEFAULT 0,
              current_version_number INTEGER NOT NULL DEFAULT 1,
              version_count INTEGER NOT NULL DEFAULT 1,
              health TEXT NOT NULL DEFAULT 'normal',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
              FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE SET NULL
            );

            INSERT INTO documents_new (
              id, project_id, activity_id, name, base_name, original_path, managed_path, history_dir_path,
              storage_mode, mime_type, is_starred, current_version_number, version_count, health, created_at, updated_at
            )
            SELECT
              id,
              project_id,
              activity_id,
              name,
              COALESCE(NULLIF(base_name, ''), name),
              original_path,
              managed_path,
              COALESCE(history_dir_path, ''),
              storage_mode,
              mime_type,
              CASE
                WHEN is_starred = 1 OR {promoted_expr} = 1 OR {role_expr} THEN 1
                ELSE 0
              END,
              COALESCE(current_version_number, 1),
              COALESCE(version_count, 1),
              COALESCE(NULLIF(health, ''), 'normal'),
              created_at,
              updated_at
            FROM documents;

            DROP TABLE documents;
            ALTER TABLE documents_new RENAME TO documents;

            COMMIT;
            PRAGMA foreign_keys = ON;
            "#
        );
        self.conn.execute_batch(&sql)?;
        Ok(())
    }

    fn migrate_activity_settings_schema(&mut self) -> Result<()> {
        self.ensure_system_pending_activity_status()?;
        let review_status_id = self.find_or_create_custom_activity_status_option(
            LEGACY_ACTIVITY_STATUS_REVIEW_LABEL,
            LEGACY_ACTIVITY_STATUS_REVIEW_COLOR_KEY,
        )?;
        let organized_status_id = self.find_or_create_custom_activity_status_option(
            LEGACY_ACTIVITY_STATUS_ORGANIZED_LABEL,
            LEGACY_ACTIVITY_STATUS_ORGANIZED_COLOR_KEY,
        )?;

        let mut stmt = self.conn.prepare(
            r#"
            SELECT DISTINCT category
            FROM activities
            WHERE attribute_option_id IS NULL AND TRIM(COALESCE(category, '')) <> ''
            ORDER BY id ASC
            "#,
        )?;
        let categories = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);

        for category in categories {
            let label = legacy_activity_attribute_label(&category);
            let option_id = self.find_or_create_activity_attribute_option(&label)?;
            self.conn.execute(
                "UPDATE activities SET attribute_option_id = ?1 WHERE attribute_option_id IS NULL AND category = ?2",
                params![option_id, category],
            )?;
        }

        self.conn.execute(
            "UPDATE activities SET status_option_id = ?1 WHERE status_option_id IS NULL AND organize_status = 'organized'",
            params![organized_status_id],
        )?;
        self.conn.execute(
            "UPDATE activities SET status_option_id = ?1 WHERE status_option_id IS NULL",
            params![review_status_id],
        )?;

        Ok(())
    }

    fn migrate_activity_attribute_color_schema(&mut self) -> Result<()> {
        self.conn.execute(
            r#"
            UPDATE activity_attribute_options
            SET color_key = ?1
            WHERE TRIM(COALESCE(color_key, '')) = ''
               OR color_key NOT IN ('slate', 'blue', 'teal', 'green', 'amber', 'orange', 'red', 'rose')
            "#,
            params![DEFAULT_ACTIVITY_ATTRIBUTE_COLOR_KEY],
        )?;
        Ok(())
    }

    fn migrate_activity_status_color_schema(&mut self) -> Result<()> {
        self.conn.execute(
            r#"
            UPDATE activity_status_options
            SET color_key = CASE
              WHEN system_key = ?1 THEN ?2
              WHEN needs_attention = 1 THEN ?3
              ELSE ?4
            END
            WHERE TRIM(COALESCE(color_key, '')) = ''
               OR color_key NOT IN ('slate', 'blue', 'teal', 'green', 'amber', 'orange', 'red', 'rose')
            "#,
            params![
                SYSTEM_ACTIVITY_STATUS_PENDING,
                DEFAULT_ACTIVITY_STATUS_COLOR_KEY,
                LEGACY_ACTIVITY_STATUS_REVIEW_COLOR_KEY,
                LEGACY_ACTIVITY_STATUS_ORGANIZED_COLOR_KEY,
            ],
        )?;
        Ok(())
    }

    fn ensure_activity_settings_seeded(&mut self) -> Result<()> {
        self.ensure_system_pending_activity_status()?;
        Ok(())
    }

    fn migrate_record_type_schema(&mut self) -> Result<()> {
        self.ensure_record_type_settings_seeded()
    }

    fn ensure_record_type_settings_seeded(&mut self) -> Result<()> {
        if self.record_type_count()? == 0 {
            let now = now_iso();
            self.conn.execute(
                r#"
                INSERT INTO record_type_options (
                  key, label, color_key, template_html, is_default, created_at, updated_at
                )
                VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)
                "#,
                params![
                    DEFAULT_RECORD_TYPE_KEY,
                    DEFAULT_RECORD_TYPE_LABEL,
                    DEFAULT_RECORD_TYPE_COLOR_KEY,
                    DEFAULT_RECORD_TYPE_TEMPLATE_HTML,
                    now,
                    now
                ],
            )?;

            self.conn.execute(
                r#"
                INSERT INTO record_type_options (
                  key, label, color_key, template_html, is_default, created_at, updated_at
                )
                VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)
                "#,
                params![
                    MEETING_RECORD_TYPE_KEY,
                    MEETING_RECORD_TYPE_LABEL,
                    MEETING_RECORD_TYPE_COLOR_KEY,
                    MEETING_RECORD_TYPE_TEMPLATE_HTML,
                    now,
                    now
                ],
            )?;
        }

        self.normalize_record_type_defaults()
    }

    fn normalize_record_type_defaults(&mut self) -> Result<()> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id, key, is_default
            FROM record_type_options
            ORDER BY
              CASE WHEN key = ?1 THEN 0 ELSE 1 END,
              is_default DESC,
              created_at ASC,
              id ASC
            "#,
        )?;
        let rows = stmt
            .query_map(params![DEFAULT_RECORD_TYPE_KEY], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    int_to_bool(row.get::<_, i64>(2)?),
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);

        if rows.is_empty() {
            return Err(anyhow!("record type dictionary is empty"));
        }

        let preferred_id = rows
            .iter()
            .find(|(_id, key, is_default)| *is_default && key == DEFAULT_RECORD_TYPE_KEY)
            .map(|(id, _, _)| *id)
            .or_else(|| {
                rows.iter()
                    .find(|(_, _, is_default)| *is_default)
                    .map(|(id, _, _)| *id)
            })
            .unwrap_or(rows[0].0);

        self.conn
            .execute("UPDATE record_type_options SET is_default = 0", [])?;
        self.conn.execute(
            "UPDATE record_type_options SET is_default = 1 WHERE id = ?1",
            params![preferred_id],
        )?;

        Ok(())
    }

    fn ensure_system_pending_activity_status(&mut self) -> Result<ActivityStatusOption> {
        let now = now_iso();
        self.conn.execute(
            r#"
            INSERT INTO activity_status_options (system_key, label, color_key, needs_attention, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(system_key) DO NOTHING
            "#,
            params![
                SYSTEM_ACTIVITY_STATUS_PENDING,
                SYSTEM_ACTIVITY_STATUS_PENDING_LABEL,
                DEFAULT_ACTIVITY_STATUS_COLOR_KEY,
                bool_to_int(color_key_implies_attention(DEFAULT_ACTIVITY_STATUS_COLOR_KEY)),
                now,
                now
            ],
        )?;
        self.pending_activity_status_option()
    }

    fn find_or_create_activity_attribute_option(&mut self, label: &str) -> Result<i64> {
        let normalized = validate_activity_option_label(label)?;
        let existing = self
            .conn
            .query_row(
                "SELECT id FROM activity_attribute_options WHERE label = ?1 COLLATE NOCASE",
                params![normalized.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;

        if let Some(option_id) = existing {
            return Ok(option_id);
        }

        let now = now_iso();
        self.conn.execute(
            r#"
            INSERT INTO activity_attribute_options (label, color_key, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4)
            "#,
            params![normalized, DEFAULT_ACTIVITY_ATTRIBUTE_COLOR_KEY, now, now],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    fn find_or_create_custom_activity_status_option(
        &mut self,
        label: &str,
        color_key: &str,
    ) -> Result<i64> {
        let normalized = validate_activity_option_label(label)?;
        let color_key = validate_activity_status_color_key(color_key)?;
        let needs_attention = bool_to_int(color_key_implies_attention(&color_key));
        let existing = self
            .conn
            .query_row(
                "SELECT id FROM activity_status_options WHERE label = ?1 COLLATE NOCASE",
                params![normalized.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;

        let now = now_iso();
        if let Some(option_id) = existing {
            self.conn.execute(
                r#"
                UPDATE activity_status_options
                SET color_key = ?1, needs_attention = ?2, updated_at = ?3
                WHERE id = ?4 AND system_key IS NULL
                "#,
                params![color_key, needs_attention, now, option_id],
            )?;
            return Ok(option_id);
        }

        self.conn.execute(
            r#"
            INSERT INTO activity_status_options (system_key, label, color_key, needs_attention, created_at, updated_at)
            VALUES (NULL, ?1, ?2, ?3, ?4, ?5)
            "#,
            params![normalized, color_key, needs_attention, now, now],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    fn activity_attribute_option_record(&self, option_id: i64) -> Result<ActivityAttributeOption> {
        self.conn
            .query_row(
                r#"
                SELECT id, label, color_key, created_at, updated_at
                FROM activity_attribute_options
                WHERE id = ?1
                "#,
                [option_id],
                |row| {
                    Ok(ActivityAttributeOption {
                        id: row.get(0)?,
                        label: row.get(1)?,
                        color_key: row.get(2)?,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    fn fetch_activity_attribute_options(&self) -> Result<Vec<ActivityAttributeOption>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM activity_attribute_options ORDER BY created_at ASC, id ASC")?;
        let ids = stmt
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter()
            .map(|option_id| self.activity_attribute_option_record(option_id))
            .collect()
    }

    fn activity_status_option_record(&self, option_id: i64) -> Result<ActivityStatusOption> {
        self.conn
            .query_row(
                r#"
                SELECT id, label, color_key, needs_attention, system_key, created_at, updated_at
                FROM activity_status_options
                WHERE id = ?1
                "#,
                [option_id],
                |row| {
                    let system_key = row.get::<_, Option<String>>(4)?;
                    Ok(ActivityStatusOption {
                        id: row.get(0)?,
                        label: row.get(1)?,
                        color_key: row.get(2)?,
                        needs_attention: int_to_bool(row.get::<_, i64>(3)?),
                        is_system: system_key.is_some(),
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    fn pending_activity_status_option(&self) -> Result<ActivityStatusOption> {
        let option_id = self.conn.query_row(
            "SELECT id FROM activity_status_options WHERE system_key = ?1 LIMIT 1",
            params![SYSTEM_ACTIVITY_STATUS_PENDING],
            |row| row.get::<_, i64>(0),
        )?;
        self.activity_status_option_record(option_id)
    }

    fn resolve_activity_status_option(
        &self,
        option_id: Option<i64>,
    ) -> Result<ActivityStatusOption> {
        match option_id {
            Some(option_id) => self.activity_status_option_record(option_id),
            None => self.pending_activity_status_option(),
        }
    }

    fn fetch_activity_status_options(&self) -> Result<Vec<ActivityStatusOption>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id
            FROM activity_status_options
            ORDER BY
              CASE WHEN system_key IS NOT NULL THEN 0 ELSE 1 END,
              created_at ASC,
              id ASC
            "#,
        )?;
        let ids = stmt
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter()
            .map(|option_id| self.activity_status_option_record(option_id))
            .collect()
    }

    fn schema_version(&self) -> Result<i64> {
        self.conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(Into::into)
    }

    fn set_schema_version(&self, version: i64) -> Result<()> {
        self.conn.pragma_update(None, "user_version", version)?;
        Ok(())
    }

    fn has_column(&self, table: &str, column: &str) -> Result<bool> {
        let pragma = format!("PRAGMA table_info({})", table);
        let mut stmt = self.conn.prepare(&pragma)?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(columns.iter().any(|existing| existing == column))
    }

    fn ensure_column(&self, table: &str, column: &str, sql: &str) -> Result<()> {
        if !self.has_column(table, column)? {
            self.conn.execute(sql, [])?;
        }
        Ok(())
    }

    fn backfill_project_summary_html(&self) -> Result<()> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id, summary_markdown, summary
            FROM projects
            WHERE TRIM(COALESCE(summary_html, '')) = ''
            "#,
        )?;
        let updates = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);

        for (project_id, summary_markdown, summary) in updates {
            let markdown = if summary_markdown.trim().is_empty() {
                summary
            } else {
                summary_markdown
            };
            self.conn.execute(
                "UPDATE projects SET summary_html = ?1 WHERE id = ?2",
                params![rich_text_html_from_markdown(&markdown), project_id],
            )?;
        }

        Ok(())
    }
}

fn activity_digest_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ActivityDigest> {
    Ok(ActivityDigest {
        id: row.get(0)?,
        project_id: row.get(1)?,
        attribute_option_id: row.get(2)?,
        attribute_label: row.get(3)?,
        attribute_color_key: row.get(4)?,
        title: row.get(5)?,
        activity_time: row.get(6)?,
        status_option_id: row.get(7)?,
        status_label: row.get(8)?,
        status_color_key: row.get(9)?,
        status_needs_attention: int_to_bool(row.get::<_, i64>(10)?),
        is_pinned: int_to_bool(row.get::<_, i64>(11)?),
        note_count: row.get(12)?,
        conclusion_count: row.get(13)?,
        todo_count: row.get(14)?,
        document_count: row.get(15)?,
        completed_todo_count: row.get(16)?,
        total_todo_count: row.get(17)?,
        has_open_todos: int_to_bool(row.get::<_, i64>(18)?),
    })
}

fn bool_to_int(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn int_to_bool(value: i64) -> bool {
    value != 0
}

fn legacy_organize_status_for_system(is_system: bool) -> &'static str {
    if is_system {
        "needs_review"
    } else {
        "organized"
    }
}

fn color_key_implies_attention(color_key: &str) -> bool {
    matches!(color_key.trim(), "amber" | "orange" | "red" | "rose")
}

fn legacy_activity_attribute_label(raw: &str) -> String {
    match raw.trim() {
        "product" => "PRODUCT".to_string(),
        "legal" => "LEGAL".to_string(),
        "engineering" => "ENGINEERING".to_string(),
        "planning" => "PLANNING".to_string(),
        "meeting" => "MEETING".to_string(),
        "finance" => "FINANCE".to_string(),
        "accounting" => "ACCOUNTING".to_string(),
        "operations" => "OPERATIONS".to_string(),
        "compliance" => "COMPLIANCE".to_string(),
        "reporting" => "REPORTING".to_string(),
        "other" => "OTHER".to_string(),
        value if !value.is_empty() => value.to_uppercase(),
        _ => String::new(),
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn sanitize_import_file_name(file_name: &str, mime_type: &str) -> Result<String> {
    let trimmed = file_name.trim();
    let fallback_extension = match mime_type.trim().to_ascii_lowercase().as_str() {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/bmp" => "bmp",
        "image/avif" => "avif",
        "image/heic" => "heic",
        "image/heif" => "heif",
        _ => "png",
    };
    let fallback_name = format!("clipboard-image.{fallback_extension}");
    let candidate = if trimmed.is_empty() {
        fallback_name
    } else {
        trimmed.to_string()
    };
    let sanitized = candidate
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => ch,
        })
        .collect::<String>();

    if sanitized.trim().is_empty() {
        return Err(anyhow!("invalid clipboard image file name"));
    }

    Ok(sanitized)
}

fn current_workspace_date() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn artifact_skill_spec(kind: &str) -> Result<&'static ArtifactSkillSpec> {
    match kind {
        "activity_summary" => Ok(&ACTIVITY_SUMMARY_SKILL),
        "project_brief" => Ok(&PROJECT_BRIEF_SKILL),
        "daily_brief" => Ok(&DAILY_BRIEF_SKILL),
        _ => Err(anyhow!("unsupported artifact kind")),
    }
}

fn ai_artifact_scope_key(
    kind: &str,
    project_id: Option<i64>,
    activity_id: Option<i64>,
    artifact_date: Option<&str>,
) -> String {
    format!(
        "{}|{}|{}|{}",
        kind.trim(),
        project_id.unwrap_or_default(),
        activity_id.unwrap_or_default(),
        artifact_date.unwrap_or_default().trim()
    )
}

fn normalize_internal_reference_label(kind: &str, value: &str) -> String {
    let normalized = normalize_internal_reference_match_text(&strip_internal_reference_label_tokens(
        value,
    ));
    let fallback = match kind {
        "note" => "记录",
        "conclusion" => "结论",
        "todo" => "Todo",
        "document" => "文件",
        _ => "未命名引用",
    };
    let resolved = if normalized.is_empty() {
        fallback.to_string()
    } else {
        normalized
    };

    if matches!(kind, "conclusion" | "todo") {
        truncate_text(&resolved, INTERNAL_REFERENCE_COMPACT_LABEL_MAX_CHARS)
    } else {
        resolved
    }
}

fn strip_internal_reference_label_tokens(value: &str) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    let mut normalized = String::with_capacity(value.len());
    let mut index = 0usize;

    while index < chars.len() {
        let start_token = match chars.get(index..index + 2) {
            Some(['[', '[']) => Some((']', ']')),
            Some(['【', '【']) => Some(('】', '】')),
            _ => None,
        };

        if let Some((end_left, end_right)) = start_token {
            let mut close_index = index + 2;
            while close_index + 1 < chars.len() {
                if chars[close_index] == end_left && chars[close_index + 1] == end_right {
                    break;
                }
                close_index += 1;
            }

            if close_index + 1 < chars.len()
                && chars[close_index] == end_left
                && chars[close_index + 1] == end_right
            {
                if normalized
                    .chars()
                    .last()
                    .is_some_and(|ch| !ch.is_whitespace())
                {
                    normalized.push(' ');
                }
                index = close_index + 2;
                continue;
            }
        }

        normalized.push(chars[index]);
        index += 1;
    }

    normalized
}

fn normalize_internal_reference_match_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn parse_internal_reference_search_query(raw: &str) -> ParsedInternalReferenceSearchQuery {
    let trimmed = raw.trim();

    let Some((prefix, remainder)) = split_internal_reference_search_prefix(trimmed) else {
        return ParsedInternalReferenceSearchQuery {
            kind_filter: None,
            query: trimmed.to_string(),
        };
    };

    let normalized_prefix = prefix.trim().to_ascii_lowercase();
    let kind_filter = match normalized_prefix.as_str() {
        "note" => Some(InternalReferenceFilterKind::Note),
        "todo" => Some(InternalReferenceFilterKind::Todo),
        "con" | "conclusion" => Some(InternalReferenceFilterKind::Conclusion),
        "doc" | "document" => Some(InternalReferenceFilterKind::Document),
        _ => None,
    };

    if let Some(kind_filter) = kind_filter {
        return ParsedInternalReferenceSearchQuery {
            kind_filter: Some(kind_filter),
            query: remainder.trim().to_string(),
        };
    }

    ParsedInternalReferenceSearchQuery {
        kind_filter: None,
        query: trimmed.to_string(),
    }
}

fn split_internal_reference_search_prefix(value: &str) -> Option<(&str, &str)> {
    let half = value.find(':');
    let full = value.find('：');
    let delimiter_index = match (half, full) {
        (Some(left), Some(right)) => left.min(right),
        (Some(index), None) | (None, Some(index)) => index,
        (None, None) => return None,
    };
    let delimiter_len = value[delimiter_index..].chars().next()?.len_utf8();

    Some((
        &value[..delimiter_index],
        &value[delimiter_index + delimiter_len..],
    ))
}

fn build_internal_reference_search_fields<const N: usize>(
    items: [(u8, String); N],
) -> Vec<InternalReferenceSearchField> {
    items.into_iter()
        .filter_map(|(priority, text)| {
            let normalized = normalize_internal_reference_match_text(&text);
            if normalized.is_empty() {
                None
            } else {
                Some(InternalReferenceSearchField {
                    priority,
                    text: normalized,
                })
            }
        })
        .collect()
}

fn classify_internal_reference_match(
    haystack: &str,
    query: &str,
) -> Option<InternalReferenceMatchKind> {
    let normalized_haystack = normalize_internal_reference_match_text(haystack);
    let normalized_query = normalize_internal_reference_match_text(query);

    if normalized_haystack.is_empty() || normalized_query.is_empty() {
        return None;
    }

    let haystack_lower = normalized_haystack.to_lowercase();
    let query_lower = normalized_query.to_lowercase();

    if haystack_lower == query_lower {
        Some(InternalReferenceMatchKind::Exact)
    } else if haystack_lower.starts_with(&query_lower) {
        Some(InternalReferenceMatchKind::Prefix)
    } else if haystack_lower.contains(&query_lower) {
        Some(InternalReferenceMatchKind::Contains)
    } else {
        None
    }
}

fn rank_internal_reference_search_candidate(
    candidate: &InternalReferenceSearchCandidate,
    query: &str,
) -> Option<InternalReferenceSearchRank> {
    for field in &candidate.fields {
        if let Some(match_kind) = classify_internal_reference_match(&field.text, query) {
            return Some(InternalReferenceSearchRank {
                field_priority: field.priority,
                match_kind,
            });
        }
    }

    None
}

fn build_workspace_search_fields<const N: usize>(
    items: [(u8, String); N],
) -> Vec<WorkspaceSearchField> {
    items
        .into_iter()
        .filter_map(|(priority, text)| {
            let normalized = normalize_internal_reference_match_text(&text);
            if normalized.is_empty() {
                None
            } else {
                Some(WorkspaceSearchField {
                    priority,
                    text: normalized,
                })
            }
        })
        .collect()
}

fn rank_workspace_search_candidate(
    candidate: &WorkspaceSearchCandidate,
    query: &str,
) -> Option<WorkspaceSearchRank> {
    for field in &candidate.fields {
        if let Some(match_kind) = classify_internal_reference_match(&field.text, query) {
            return Some(WorkspaceSearchRank {
                field_priority: field.priority,
                match_kind,
            });
        }
    }

    None
}

fn untitled_activity_title(activity_id: i64) -> String {
    format!("{UNTITLED_ACTIVITY_PREFIX} {activity_id}")
}

fn normalize_activity_title(value: &str, activity_id: i64) -> String {
    let normalized = value.trim();
    if normalized.is_empty() {
        untitled_activity_title(activity_id)
    } else {
        normalized.to_string()
    }
}

fn build_internal_reference_subtitle(project_name: &str, activity_title: Option<&str>) -> String {
    match activity_title.map(str::trim) {
        Some(activity_title) if !activity_title.is_empty() => {
            format!("{} · {}", project_name.trim(), activity_title)
        }
        _ => project_name.trim().to_string(),
    }
}

fn build_activity_note_route(project_id: i64, activity_id: i64, note_id: i64) -> String {
    format!("/projects/{project_id}/activities/{activity_id}/notes/{note_id}")
}

fn build_internal_reference_route(
    project_id: i64,
    activity_id: Option<i64>,
    focus_id: &str,
) -> String {
    match activity_id {
        Some(activity_id) => {
            format!("/projects/{project_id}/activities/{activity_id}?focus={focus_id}")
        }
        None => format!("/projects/{project_id}?focus={focus_id}"),
    }
}

fn push_artifact_source(
    sources: &mut Vec<ArtifactSource>,
    latest: &mut String,
    project_id: Option<i64>,
    activity_id: Option<i64>,
    ref_prefix: &str,
    source_id: i64,
    source_kind: &str,
    label: String,
    excerpt: String,
    updated_at: &str,
) {
    let normalized_excerpt = truncate_text(&excerpt.replace('\n', " "), 280);
    sources.push(ArtifactSource {
        ref_code: format!("{ref_prefix}-{source_id}"),
        source_kind: source_kind.to_string(),
        source_id,
        project_id,
        activity_id,
        label,
        excerpt: normalized_excerpt,
    });
    if updated_at > latest.as_str() {
        *latest = updated_at.to_string();
    }
}

fn push_existing_artifact_source(
    sources: &mut Vec<ArtifactSource>,
    latest: &mut String,
    source: ArtifactSource,
    updated_at: Option<&str>,
) {
    if let Some(value) = updated_at {
        if value > latest.as_str() {
            *latest = value.to_string();
        }
    }
    sources.push(ArtifactSource {
        excerpt: truncate_text(&source.excerpt.replace('\n', " "), 280),
        ..source
    });
}

fn render_artifact_context(title: &str, scope: &str, sources: &[ArtifactSource]) -> String {
    let rendered_sources = sources
        .iter()
        .map(|source| {
            format!(
                "{} | {} | {}",
                source.ref_code, source.label, source.excerpt
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!("Artifact:\n{title}\n\nScope:\n{scope}\n\nSources:\n{rendered_sources}")
}

fn render_artifact_markdown(payload: &AiArtifactPayload) -> String {
    let mut markdown = String::new();
    if !payload.overview.trim().is_empty() {
        markdown.push_str(payload.overview.trim());
    }

    for section in &payload.sections {
        if section.title.trim().is_empty() {
            continue;
        }
        if !markdown.is_empty() {
            markdown.push_str("\n\n");
        }
        markdown.push_str("## ");
        markdown.push_str(section.title.trim());
        for item in &section.items {
            markdown.push('\n');
            markdown.push_str("- ");
            markdown.push_str(item.trim());
        }
    }

    markdown
}

fn merge_ai_suggestion_payload(base: &Value, override_payload: Option<&Value>) -> Value {
    let mut merged = match base {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };

    if let Some(Value::Object(override_map)) = override_payload {
        for (key, value) in override_map {
            merged.insert(key.clone(), value.clone());
        }
    }

    Value::Object(merged)
}

fn suggestion_payload_string<'a>(
    payload: &'a Value,
    key: &str,
    error_message: &str,
) -> Result<&'a str> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!(error_message.to_string()))
}

fn ai_suggestion_preview(suggestion_type: &str, payload: &Value) -> Result<String> {
    match suggestion_type {
        "activity_title" => {
            Ok(
                suggestion_payload_string(payload, "proposedTitle", "missing proposedTitle")?
                    .to_string(),
            )
        }
        "conclusion" | "todo" => {
            Ok(
                suggestion_payload_string(payload, "content", "missing suggestion content")?
                    .to_string(),
            )
        }
        _ => Err(anyhow!("unsupported suggestion type")),
    }
}

fn is_todo_priority(value: &str) -> bool {
    matches!(
        value,
        "urgent_important"
            | "urgent_not_important"
            | "not_urgent_important"
            | "not_urgent_not_important"
    )
}

fn infer_todo_priority(content: &str) -> &'static str {
    let normalized = content.trim().to_lowercase();
    let has_urgency = TODO_PRIORITY_URGENCY_KEYWORDS
        .iter()
        .any(|keyword| normalized.contains(keyword));
    let has_importance = TODO_PRIORITY_IMPORTANCE_KEYWORDS
        .iter()
        .any(|keyword| normalized.contains(keyword));

    if has_urgency && has_importance {
        "urgent_important"
    } else if has_urgency {
        "urgent_not_important"
    } else if has_importance {
        "not_urgent_important"
    } else {
        "not_urgent_not_important"
    }
}

fn push_ask_source(
    sources: &mut Vec<AskSource>,
    project_id: Option<i64>,
    activity_id: Option<i64>,
    ref_prefix: &str,
    source_id: i64,
    source_kind: &str,
    label: String,
    excerpt: String,
    body_text: String,
    updated_at: &str,
) {
    sources.push(AskSource {
        ref_code: format!("{ref_prefix}-{source_id}"),
        source_kind: source_kind.to_string(),
        source_id,
        project_id,
        activity_id,
        label,
        excerpt: truncate_text(&excerpt.replace('\n', " "), 280),
        body_text: truncate_text(&body_text.replace('\n', " "), 2400),
        updated_at: updated_at.to_string(),
    });
}

fn render_ask_context(
    scope: &str,
    project_id: Option<i64>,
    activity_id: Option<i64>,
    question: &str,
    sources: &[AskSource],
) -> String {
    let rendered_sources = sources
        .iter()
        .map(|source| {
            format!(
                "{} | {} | {} | updatedAt={}\nExcerpt: {}\nBody: {}",
                source.ref_code,
                source.source_kind,
                source.label,
                source.updated_at,
                source.excerpt,
                source.body_text
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    format!(
        "Scope:\n{}\n\nProjectId:\n{}\n\nActivityId:\n{}\n\nQuestion:\n{}\n\nSources:\n{}",
        scope,
        project_id
            .map(|value| value.to_string())
            .unwrap_or_default(),
        activity_id
            .map(|value| value.to_string())
            .unwrap_or_default(),
        question.trim(),
        rendered_sources
    )
}

fn insufficient_ai_answer(scope: AiAnswerScope, message: &str) -> AiAnswerResult {
    AiAnswerResult {
        answer_markdown: message.trim().to_string(),
        citations: Vec::new(),
        scope,
        generated_at: now_iso(),
        skill_key: ASK_SKILL.skill_key.to_string(),
        skill_version: ASK_SKILL.skill_version.to_string(),
    }
}

fn rank_ask_sources(question: &str, sources: Vec<AskSource>) -> Vec<(i64, AskSource)> {
    let phrase = compact_ask_text(question);
    let terms = ask_query_terms(question);
    let mut ranked = sources
        .into_iter()
        .filter_map(|source| {
            let label = normalize_ask_text(&source.label);
            let excerpt = normalize_ask_text(&source.excerpt);
            let body = normalize_ask_text(&source.body_text);
            let label_compact = compact_ask_text(&source.label);
            let excerpt_compact = compact_ask_text(&source.excerpt);
            let body_compact = compact_ask_text(&source.body_text);

            let mut score = ask_source_type_weight(&source.source_kind);
            let mut hits = 0_i64;

            if phrase.chars().count() >= 2 {
                if label_compact.contains(&phrase) {
                    score += 30;
                    hits += 1;
                } else if excerpt_compact.contains(&phrase) {
                    score += 22;
                    hits += 1;
                } else if body_compact.contains(&phrase) {
                    score += 16;
                    hits += 1;
                }
            }

            for term in &terms {
                if term.chars().count() < 2 {
                    continue;
                }
                if label.contains(term) {
                    score += 10;
                    hits += 1;
                } else if excerpt.contains(term) {
                    score += 6;
                    hits += 1;
                } else if body.contains(term) {
                    score += 4;
                    hits += 1;
                }
            }

            if hits == 0 {
                return None;
            }

            Some((score, source))
        })
        .collect::<Vec<_>>();

    ranked.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| right.1.updated_at.cmp(&left.1.updated_at))
            .then_with(|| left.1.ref_code.cmp(&right.1.ref_code))
    });
    ranked
}

fn select_ask_sources(ranked: Vec<(i64, AskSource)>, total_limit: usize) -> Vec<AskSource> {
    let mut per_kind = HashMap::<String, usize>::new();
    let mut selected = Vec::new();

    for (_, source) in ranked {
        let current = per_kind.get(&source.source_kind).copied().unwrap_or(0);
        if current >= ask_source_type_cap(&source.source_kind) {
            continue;
        }

        per_kind.insert(source.source_kind.clone(), current + 1);
        selected.push(source);
        if selected.len() >= total_limit {
            break;
        }
    }

    selected
}

fn ask_source_type_weight(source_kind: &str) -> i64 {
    match source_kind {
        "conclusion" => 8,
        "todo" => 7,
        "note" => 6,
        "activity" => 5,
        "project" => 4,
        "document" => 3,
        _ => 1,
    }
}

fn ask_source_type_cap(source_kind: &str) -> usize {
    match source_kind {
        "note" | "todo" | "conclusion" => 3,
        "activity" | "document" => 2,
        "project" => 2,
        _ => 1,
    }
}

fn normalize_ask_text(value: &str) -> String {
    let mut normalized = String::new();
    let mut last_space = false;
    for ch in value.to_lowercase().chars() {
        if is_ask_lexical_char(ch) {
            normalized.push(ch);
            last_space = false;
        } else if !last_space {
            normalized.push(' ');
            last_space = true;
        }
    }
    normalized.trim().to_string()
}

fn compact_ask_text(value: &str) -> String {
    normalize_ask_text(value)
        .split_whitespace()
        .collect::<String>()
}

fn ask_query_terms(question: &str) -> Vec<String> {
    let mut terms = Vec::new();
    for segment in normalize_ask_text(question).split_whitespace() {
        push_unique_term(&mut terms, segment.to_string());

        let chars = segment.chars().collect::<Vec<_>>();
        if chars.len() > 2 && chars.iter().all(|ch| is_cjk_char(*ch)) {
            for window in chars.windows(2) {
                push_unique_term(&mut terms, window.iter().collect());
            }
        }
    }
    terms
}

fn push_unique_term(terms: &mut Vec<String>, term: String) {
    let normalized = term.trim();
    if normalized.chars().count() < 2 {
        return;
    }
    if !terms.iter().any(|existing| existing == normalized) {
        terms.push(normalized.to_string());
    }
}

fn is_ask_lexical_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || is_cjk_char(ch)
}

fn is_cjk_char(ch: char) -> bool {
    let code = ch as u32;
    (0x4E00..=0x9FFF).contains(&code)
        || (0x3400..=0x4DBF).contains(&code)
        || (0xF900..=0xFAFF).contains(&code)
}

fn truncate_text(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{}...", truncated)
    } else {
        truncated
    }
}

fn project_directory_name(project_name: &str) -> Result<String> {
    let project_dir_name = normalize_windows_safe_component(project_name);
    if project_dir_name.is_empty() {
        return Err(anyhow!(
            "project name must contain at least one usable character"
        ));
    }

    Ok(project_dir_name)
}

fn rebase_path_prefix(path: &Path, old_prefix: &Path, new_prefix: &Path) -> Option<PathBuf> {
    path.strip_prefix(old_prefix).ok().map(|relative| {
        if relative.as_os_str().is_empty() {
            new_prefix.to_path_buf()
        } else {
            new_prefix.join(relative)
        }
    })
}

fn rewrite_rich_text_asset_paths(html: &str, old_prefix: &Path, new_prefix: &Path) -> String {
    if html.is_empty() || old_prefix == new_prefix {
        return html.to_string();
    }

    let old_path_prefix = old_prefix.to_string_lossy().to_string();
    let new_path_prefix = new_prefix.to_string_lossy().to_string();
    let old_href_prefix = file_href_from_path(old_prefix);
    let new_href_prefix = file_href_from_path(new_prefix);

    ["data-path", "data-href", "href", "src"].into_iter().fold(
        html.to_string(),
        |current, attribute| {
            rewrite_html_attribute_path_prefix(
                &current,
                attribute,
                &old_path_prefix,
                &new_path_prefix,
                &old_href_prefix,
                &new_href_prefix,
            )
        },
    )
}

fn rewrite_html_attribute_path_prefix(
    html: &str,
    attribute: &str,
    old_path_prefix: &str,
    new_path_prefix: &str,
    old_href_prefix: &str,
    new_href_prefix: &str,
) -> String {
    let needle = format!(r#"{attribute}=""#);
    let mut rewritten = String::with_capacity(html.len());
    let mut cursor = 0usize;

    while let Some(start_offset) = html[cursor..].find(&needle) {
        let start = cursor + start_offset;
        let value_start = start + needle.len();
        rewritten.push_str(&html[cursor..value_start]);

        let Some(end_offset) = html[value_start..].find('"') else {
            rewritten.push_str(&html[value_start..]);
            return rewritten;
        };
        let value_end = value_start + end_offset;
        let value = &html[value_start..value_end];
        if let Some(remainder) = value.strip_prefix(old_path_prefix) {
            rewritten.push_str(new_path_prefix);
            rewritten.push_str(remainder);
        } else if let Some(remainder) = value.strip_prefix(old_href_prefix) {
            rewritten.push_str(new_href_prefix);
            rewritten.push_str(remainder);
        } else {
            rewritten.push_str(value);
        }

        cursor = value_end;
    }

    rewritten.push_str(&html[cursor..]);
    rewritten
}

fn file_href_from_path(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");

    if normalized.starts_with("//") {
        return format!("file:{}", encode_uri_path_preserving_slashes(&normalized));
    }

    if normalized
        .as_bytes()
        .get(1)
        .is_some_and(|value| *value == b':')
        && normalized
            .as_bytes()
            .first()
            .is_some_and(|value| value.is_ascii_alphabetic())
    {
        return format!(
            "file:///{}",
            encode_uri_path_preserving_slashes(&normalized)
        );
    }

    format!("file://{}", encode_uri_path_preserving_slashes(&normalized))
}

fn encode_uri_path_preserving_slashes(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for ch in value.chars() {
        if matches!(
            ch,
            'A'..='Z'
                | 'a'..='z'
                | '0'..='9'
                | ';'
                | ','
                | '/'
                | '?'
                | ':'
                | '@'
                | '&'
                | '='
                | '+'
                | '$'
                | '-'
                | '_'
                | '.'
                | '!'
                | '~'
                | '*'
                | '\''
                | '('
                | ')'
                | '#'
        ) {
            encoded.push(ch);
            continue;
        }

        let mut buffer = [0u8; 4];
        for byte in ch.encode_utf8(&mut buffer).as_bytes() {
            encoded.push_str(&format!("%{:02X}", byte));
        }
    }

    encoded
}

fn apply_note_html_updates(tx: &Transaction<'_>, updates: &[(i64, String)]) -> Result<()> {
    for (note_id, content_html) in updates {
        tx.execute(
            "UPDATE notes SET content_html = ?1 WHERE id = ?2",
            params![content_html, note_id],
        )?;
    }

    Ok(())
}

fn apply_conclusion_html_updates(tx: &Transaction<'_>, updates: &[(i64, String)]) -> Result<()> {
    for (conclusion_id, content_html) in updates {
        tx.execute(
            "UPDATE conclusions SET content_html = ?1 WHERE id = ?2",
            params![content_html, conclusion_id],
        )?;
    }

    Ok(())
}

fn versioned_file_name(base_name: &str, version_number: i64) -> String {
    if version_number <= 1 {
        return normalize_windows_safe_component(base_name);
    }

    let path = Path::new(base_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(base_name);
    let extension = path.extension().and_then(|value| value.to_str());

    match extension {
        Some(extension) if !extension.is_empty() => {
            normalize_windows_safe_component(&format!("{stem}_v{version_number}.{extension}"))
        }
        _ => normalize_windows_safe_component(&format!("{stem}_v{version_number}")),
    }
}

fn normalize_windows_safe_component(raw: &str) -> String {
    let sanitized = raw
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            ch if ch.is_control() => '_',
            _ => ch,
        })
        .collect::<String>()
        .trim()
        .trim_end_matches(|ch| ch == '.' || ch == ' ')
        .to_string();

    if sanitized.is_empty() {
        return sanitized;
    }

    if uses_windows_reserved_path_name(&sanitized) {
        append_suffix_before_extension(&sanitized, "_")
    } else {
        sanitized
    }
}

fn uses_windows_reserved_path_name(value: &str) -> bool {
    let candidate = value.trim_end_matches(|ch| ch == '.' || ch == ' ');
    if candidate.is_empty() {
        return false;
    }

    let stem = Path::new(candidate)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(candidate)
        .trim_end_matches(|ch| ch == '.' || ch == ' ');

    WINDOWS_RESERVED_PATH_NAMES
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
}

fn append_suffix_before_extension(value: &str, suffix: &str) -> String {
    let path = Path::new(value);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(value);
    let extension = path.extension().and_then(|value| value.to_str());

    match extension {
        Some(extension) if !extension.is_empty() => format!("{stem}{suffix}.{extension}"),
        _ => format!("{stem}{suffix}"),
    }
}

fn remove_path_if_exists(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }

    if path.is_dir() {
        fs::remove_dir_all(path)
            .with_context(|| format!("failed to remove directory at {}", path.display()))?;
    } else {
        fs::remove_file(path)
            .with_context(|| format!("failed to remove file at {}", path.display()))?;
    }

    Ok(())
}

fn collect_document_managed_assets_for_delete(document: &DocumentRecord) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let managed_path = PathBuf::from(&document.managed_path);
    if managed_path.exists() {
        paths.push(managed_path);
    }

    let history_dir = PathBuf::from(&document.history_dir_path);
    if history_dir.exists() {
        paths.push(history_dir);
    }

    paths
}

fn move_paths_to_trash(paths: &[PathBuf]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }

    #[cfg(test)]
    {
        for path in paths {
            remove_path_if_exists(path)?;
        }
        Ok(())
    }

    #[cfg(not(test))]
    {
        trash::delete_all(paths)
            .map_err(|error| anyhow!("failed to move managed paths to trash: {}", error))
    }
}

fn rich_text_html_from_markdown(markdown: &str) -> String {
    let mut html = String::new();
    let mut in_list = false;

    for raw_line in markdown.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            if in_list {
                html.push_str("</ul>");
                in_list = false;
            }
            continue;
        }

        if let Some(content) = line.strip_prefix("## ") {
            if in_list {
                html.push_str("</ul>");
                in_list = false;
            }
            html.push_str("<h2>");
            html.push_str(&escape_html(content));
            html.push_str("</h2>");
            continue;
        }

        if let Some(content) = line.strip_prefix("### ") {
            if in_list {
                html.push_str("</ul>");
                in_list = false;
            }
            html.push_str("<h3>");
            html.push_str(&escape_html(content));
            html.push_str("</h3>");
            continue;
        }

        if let Some(content) = line.strip_prefix("- ") {
            if !in_list {
                html.push_str("<ul>");
                in_list = true;
            }
            html.push_str("<li>");
            html.push_str(&escape_html(content));
            html.push_str("</li>");
            continue;
        }

        if in_list {
            html.push_str("</ul>");
            in_list = false;
        }
        html.push_str("<p>");
        html.push_str(&escape_html(line));
        html.push_str("</p>");
    }

    if in_list {
        html.push_str("</ul>");
    }

    if html.trim().is_empty() {
        "<p></p>".to_string()
    } else {
        html
    }
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn path_is_within(path: &Path, root: &Path) -> bool {
    match (path.canonicalize(), root.canonicalize()) {
        (Ok(path), Ok(root)) => path.starts_with(root),
        _ => path.starts_with(root),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    static TEST_UNIQUE_COUNTER: AtomicU64 = AtomicU64::new(1);

    struct TestHarness {
        root: PathBuf,
        workspace_root: PathBuf,
    }

    impl Drop for TestHarness {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn next_test_unique() -> String {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let counter = TEST_UNIQUE_COUNTER.fetch_add(1, Ordering::Relaxed);
        format!("{timestamp}-{counter}")
    }

    fn setup_database() -> (TestHarness, Database) {
        let unique = next_test_unique();
        let root = std::env::temp_dir().join(format!("project-mind-db-test-{unique}"));
        let workspace_root = root.join("workspace");
        fs::create_dir_all(&workspace_root).unwrap();
        let database = Database::open(
            &root.join("app.sqlite3"),
            &workspace_root,
            Some("test-secret".to_string()),
        )
        .unwrap();

        (
            TestHarness {
                root,
                workspace_root,
            },
            database,
        )
    }

    fn create_project(database: &mut Database, workspace_root: &Path) -> ProjectRecord {
        fs::create_dir_all(workspace_root).unwrap();
        database
            .project_create(ProjectCreateInput {
                name: "Alpha".to_string(),
                summary: None,
                status: None,
            })
            .unwrap()
    }

    fn create_project_named(
        database: &mut Database,
        workspace_root: &Path,
        name: &str,
        summary: Option<&str>,
    ) -> ProjectRecord {
        fs::create_dir_all(workspace_root).unwrap();
        database
            .project_create(ProjectCreateInput {
                name: name.to_string(),
                summary: summary.map(str::to_string),
                status: None,
            })
            .unwrap()
    }

    fn create_activity(database: &mut Database, project_id: i64, title: &str) -> ActivityCardData {
        database
            .activity_create(ActivityCreateInput {
                project_id,
                attribute_option_id: None,
                title: Some(title.to_string()),
                activity_time: "2026-04-06T08:00:00.000Z".to_string(),
            })
            .unwrap()
    }

    fn create_todo(
        database: &mut Database,
        project_id: i64,
        activity_id: Option<i64>,
        content: &str,
        priority: &str,
    ) -> TodoRecord {
        database
            .todo_create(TodoCreateInput {
                project_id,
                activity_id,
                content: content.to_string(),
                priority: priority.to_string(),
            })
            .unwrap()
    }

    fn create_note(
        database: &mut Database,
        project_id: i64,
        activity_id: i64,
        note_type: &str,
        markdown: &str,
    ) -> NoteRecord {
        database
            .note_upsert(NoteUpsertInput {
                project_id,
                activity_id,
                note_id: None,
                note_type: note_type.to_string(),
                title: Some("记录".to_string()),
                markdown: markdown.to_string(),
                html: format!("<p>{markdown}</p>"),
            })
            .unwrap()
    }

    fn create_note_with_title(
        database: &mut Database,
        project_id: i64,
        activity_id: i64,
        note_type: &str,
        title: &str,
        markdown: &str,
    ) -> NoteRecord {
        database
            .note_upsert(NoteUpsertInput {
                project_id,
                activity_id,
                note_id: None,
                note_type: note_type.to_string(),
                title: Some(title.to_string()),
                markdown: markdown.to_string(),
                html: format!("<p>{markdown}</p>"),
            })
            .unwrap()
    }

    fn configure_summary_profile(database: &mut Database) -> AiProviderProfileRecord {
        let profile = database
            .ai_profile_upsert(AiProviderProfileUpsertInput {
                id: None,
                name: "Mock Summary".to_string(),
                provider_family: "openai_compatible".to_string(),
                base_url: "https://mock.local/v1".to_string(),
                api_key: Some("test-key".to_string()),
                default_model: "mock-model".to_string(),
                supports_text: true,
                supports_image: false,
                supports_file: false,
                enabled: true,
            })
            .unwrap();

        database
            .ai_binding_upsert(AiCapabilityBindingUpsertInput {
                capability: "summary".to_string(),
                use_default: false,
                profile_id: Some(profile.id),
                model: None,
            })
            .unwrap();

        profile
    }

    fn configure_assistant_profile(database: &mut Database) -> AiProviderProfileRecord {
        let profile = database
            .ai_profile_upsert(AiProviderProfileUpsertInput {
                id: None,
                name: "Mock Assistant".to_string(),
                provider_family: "openai_compatible".to_string(),
                base_url: "https://mock.local/v1".to_string(),
                api_key: Some("test-key".to_string()),
                default_model: "mock-model".to_string(),
                supports_text: true,
                supports_image: false,
                supports_file: false,
                enabled: true,
            })
            .unwrap();

        database
            .ai_binding_upsert(AiCapabilityBindingUpsertInput {
                capability: "assistant".to_string(),
                use_default: false,
                profile_id: Some(profile.id),
                model: None,
            })
            .unwrap();

        profile
    }

    fn configure_suggestion_profile(database: &mut Database) -> AiProviderProfileRecord {
        let profile = database
            .ai_profile_upsert(AiProviderProfileUpsertInput {
                id: None,
                name: "Mock Suggestions".to_string(),
                provider_family: "openai_compatible".to_string(),
                base_url: "https://mock.local/v1".to_string(),
                api_key: Some("test-key".to_string()),
                default_model: "mock-model".to_string(),
                supports_text: true,
                supports_image: false,
                supports_file: false,
                enabled: true,
            })
            .unwrap();

        database
            .ai_binding_upsert(AiCapabilityBindingUpsertInput {
                capability: "suggestion_generation".to_string(),
                use_default: false,
                profile_id: Some(profile.id),
                model: None,
            })
            .unwrap();

        profile
    }

    fn configure_editor_rewrite_profile(database: &mut Database) -> AiProviderProfileRecord {
        let profile = database
            .ai_profile_upsert(AiProviderProfileUpsertInput {
                id: None,
                name: "Mock Editor Rewrite".to_string(),
                provider_family: "openai_compatible".to_string(),
                base_url: "https://mock.local/v1".to_string(),
                api_key: Some("test-key".to_string()),
                default_model: "mock-model".to_string(),
                supports_text: true,
                supports_image: false,
                supports_file: false,
                enabled: true,
            })
            .unwrap();

        database
            .ai_binding_upsert(AiCapabilityBindingUpsertInput {
                capability: "editor_rewrite".to_string(),
                use_default: false,
                profile_id: Some(profile.id),
                model: None,
            })
            .unwrap();

        profile
    }

    #[test]
    fn windows_safe_component_normalizes_reserved_names() {
        assert_eq!(normalize_windows_safe_component("CON"), "CON_");
        assert_eq!(normalize_windows_safe_component("NUL.txt"), "NUL_.txt");
        assert_eq!(normalize_windows_safe_component(" report. "), "report");
        assert_eq!(
            normalize_windows_safe_component("bad\u{0007}name"),
            "bad_name"
        );
        assert_eq!(normalize_windows_safe_component(".env"), ".env");
    }

    #[test]
    fn project_create_uses_windows_safe_directory_name() {
        let (_harness, mut database) = setup_database();
        let project = database
            .project_create(ProjectCreateInput {
                name: "CON".to_string(),
                summary: None,
                status: None,
            })
            .unwrap();

        assert_eq!(
            Path::new(&project.root_path)
                .file_name()
                .and_then(|value| value.to_str()),
            Some("CON_")
        );
        assert!(Path::new(&project.root_path).exists());
    }

    #[test]
    fn reset_and_seed_demo_data_replaces_existing_workspace_data_with_demo_fixture() {
        let (harness, mut database) = setup_database();
        let legacy_project = create_project(&mut database, &harness.workspace_root);
        create_activity(&mut database, legacy_project.id, "Legacy Activity");
        let legacy_root = PathBuf::from(&legacy_project.root_path);

        let summary = database
            .reset_and_seed_demo_data(&harness.workspace_root)
            .unwrap();

        assert_eq!(summary.project_count, 3);
        assert!(summary.activity_count >= 9);
        assert!(summary.note_count >= 9);
        assert!(summary.conclusion_count >= 9);
        assert!(summary.todo_count >= 12);
        assert!(summary.document_count >= 8);
        assert_eq!(summary.ai_profile_mode, "mock_seeded");
        assert!(summary.artifact_count >= 13);
        assert!(!legacy_root.exists());

        let projects = database
            .projects_list(ProjectsListInput {
                include_archived: Some(true),
            })
            .unwrap();
        let project_names = projects
            .iter()
            .map(|project| project.name.clone())
            .collect::<Vec<_>>();
        assert!(project_names.contains(&"智能客服知识库升级".to_string()));
        assert!(project_names.contains(&"海外销售线索评分 Copilot".to_string()));
        assert!(project_names.contains(&"合同审阅 AI 助手试点".to_string()));

        let search_results = database
            .workspace_search(WorkspaceSearchInput {
                query: "法务".to_string(),
                include_archived: Some(true),
            })
            .unwrap();
        assert!(!search_results.is_empty());
        assert!(search_results.iter().any(|item| {
            matches!(
                item.kind.as_str(),
                "activity" | "conclusion" | "document" | "todo"
            )
        }));
    }

    #[test]
    fn document_base_name_normalization_handles_windows_only_restrictions() {
        let (_harness, database) = setup_database();

        assert_eq!(
            database
                .normalize_document_base_name("AUX.txt", "brief.pdf")
                .unwrap(),
            "AUX_.txt"
        );
        assert_eq!(
            database
                .normalize_document_base_name("final summary. ", "brief.pdf")
                .unwrap(),
            "final summary.pdf"
        );
    }

    #[test]
    fn ai_feature_settings_default_and_round_trip_persistence() {
        let (_harness, mut database) = setup_database();

        let defaults = database.ai_feature_settings_get().unwrap();
        assert_eq!(defaults, default_ai_feature_settings());
        assert_eq!(
            database.ai_settings_get().unwrap().feature_settings,
            defaults
        );

        let custom = AiFeatureSettings {
            master_enabled: false,
            capabilities: BTreeMap::from([
                ("assistant".to_string(), false),
                ("summary".to_string(), true),
                ("suggestion_generation".to_string(), false),
                ("editor_rewrite".to_string(), true),
            ]),
            features: BTreeMap::from([
                ("summary.activity_summary".to_string(), false),
                ("summary.project_brief".to_string(), true),
                ("summary.daily_brief".to_string(), false),
                ("suggestion_generation.conclusion".to_string(), true),
                ("suggestion_generation.todo".to_string(), false),
            ]),
        };

        let saved = database.ai_feature_settings_upsert(custom.clone()).unwrap();
        assert_eq!(saved, custom);
        assert_eq!(database.ai_feature_settings_get().unwrap(), custom);
        assert_eq!(database.ai_settings_get().unwrap().feature_settings, custom);
    }

    #[test]
    fn ai_feature_settings_parser_fills_missing_fields_and_rejects_invalid_keys() {
        let normalized = parse_ai_feature_settings_json(
            r#"{
                "capabilities": { "assistant": false },
                "features": { "suggestion_generation.todo": false }
            }"#,
        )
        .unwrap();

        assert!(normalized.master_enabled);
        assert!(!normalized.capabilities["assistant"]);
        assert!(normalized.capabilities["summary"]);
        assert!(normalized.capabilities["suggestion_generation"]);
        assert!(normalized.capabilities["editor_rewrite"]);
        assert!(normalized.features["summary.activity_summary"]);
        assert!(normalized.features["summary.project_brief"]);
        assert!(normalized.features["summary.daily_brief"]);
        assert!(normalized.features["suggestion_generation.conclusion"]);
        assert!(!normalized.features["suggestion_generation.todo"]);

        let top_level_error = parse_ai_feature_settings_json(
            r#"{
                "masterEnabled": true,
                "capabilities": {},
                "features": {},
                "extra": true
            }"#,
        )
        .unwrap_err();
        assert!(top_level_error
            .to_string()
            .contains("AI feature settings contains unsupported key 'extra'"));

        let nested_error = parse_ai_feature_settings_json(
            r#"{
                "masterEnabled": true,
                "capabilities": { "assistant": true, "unexpected": false },
                "features": {}
            }"#,
        )
        .unwrap_err();
        assert!(nested_error
            .to_string()
            .contains("AI feature settings capabilities contains unsupported key 'unexpected'"));
    }

    #[test]
    fn ai_editor_rewrite_actions_can_be_upserted_and_deleted() {
        let (_harness, mut database) = setup_database();

        let action = database
            .ai_editor_rewrite_action_upsert(AiEditorRewriteActionUpsertInput {
                id: None,
                label: "润色".to_string(),
                prompt: "请润色当前段落".to_string(),
                enabled: true,
            })
            .unwrap();

        assert_eq!(action.label, "润色");
        assert_eq!(database.ai_settings_get().unwrap().editor_rewrite_actions.len(), 1);

        let updated = database
            .ai_editor_rewrite_action_upsert(AiEditorRewriteActionUpsertInput {
                id: Some(action.id),
                label: "翻译".to_string(),
                prompt: "请翻译成英文".to_string(),
                enabled: false,
            })
            .unwrap();

        assert_eq!(updated.label, "翻译");
        assert!(!updated.enabled);

        let remaining = database
            .ai_editor_rewrite_action_delete(AiEditorRewriteActionDeleteInput {
                action_id: action.id,
            })
            .unwrap();
        assert!(remaining.is_empty());
    }

    #[test]
    fn ai_editor_rewrite_preserves_placeholder_tokens_and_returns_markdown() {
        let (_harness, mut database) = setup_database();
        configure_editor_rewrite_profile(&mut database);
        let action = database
            .ai_editor_rewrite_action_upsert(AiEditorRewriteActionUpsertInput {
                id: None,
                label: "润色".to_string(),
                prompt: "请润色这段文字".to_string(),
                enabled: true,
            })
            .unwrap();

        let mut streamed = Vec::new();
        let result = database
            .ai_editor_rewrite(
                AiEditorRewriteInput {
                    action_id: Some(action.id),
                    prompt_override: None,
                    selected_text: "第一段".to_string(),
                    expanded_markdown: "第一段\n\nPM_TOKEN_IMAGE_1\n\n第二段".to_string(),
                    placeholder_tokens: vec!["PM_TOKEN_IMAGE_1".to_string()],
                    context: None,
                },
                |stream_text| streamed.push(stream_text),
            )
            .unwrap();

        assert_eq!(result.action_id, Some(action.id));
        assert!(result.rewritten_markdown.contains("PM_TOKEN_IMAGE_1"));
        assert!(!streamed.is_empty());
        assert_eq!(
            streamed.last().map(String::as_str),
            Some(result.rewritten_markdown.as_str())
        );
    }

    #[test]
    fn ai_editor_rewrite_accepts_prompt_override_without_preset_action() {
        let (_harness, mut database) = setup_database();
        configure_editor_rewrite_profile(&mut database);

        let result = database
            .ai_editor_rewrite(
                AiEditorRewriteInput {
                    action_id: None,
                    prompt_override: Some("请把这段翻译成英文".to_string()),
                    selected_text: "第一段".to_string(),
                    expanded_markdown: "第一段".to_string(),
                    placeholder_tokens: Vec::new(),
                    context: None,
                },
                |_| {},
            )
            .unwrap();

        assert_eq!(result.action_id, None);
        assert!(!result.rewritten_markdown.trim().is_empty());
    }

    #[test]
    fn ai_editor_rewrite_placeholder_validator_rejects_missing_tokens() {
        let error =
            validate_rewrite_placeholder_tokens("第一段\n\n第二段", &["PM_TOKEN_IMAGE_1".to_string()])
                .unwrap_err();
        assert!(error
            .to_string()
            .contains("missing required placeholder token"));
    }

    #[test]
    fn ai_artifact_refresh_generates_activity_summary_with_skill_metadata() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Budget Review");
        create_note(
            &mut database,
            project.id,
            activity.id,
            DEFAULT_RECORD_TYPE_KEY,
            "确认当前目标与下一步约束",
        );
        create_todo(
            &mut database,
            project.id,
            Some(activity.id),
            "补充风险清单",
            "urgent_important",
        );
        configure_summary_profile(&mut database);

        let artifact = database
            .ai_artifact_refresh(AiArtifactGetInput {
                kind: "activity_summary".to_string(),
                project_id: Some(project.id),
                activity_id: Some(activity.id),
                artifact_date: None,
            })
            .unwrap();

        assert_eq!(artifact.kind, "activity_summary");
        assert_eq!(artifact.status, AI_ARTIFACT_STATUS_FRESH);
        assert_eq!(artifact.skill_key, ACTIVITY_SUMMARY_SKILL.skill_key);
        assert_eq!(artifact.skill_version, ACTIVITY_SUMMARY_SKILL.skill_version);
        assert!(!artifact.markdown.trim().is_empty());
        assert!(artifact.generated_at.is_some());
        assert!(!artifact.citations.is_empty());
        assert_eq!(
            artifact.json_payload["overview"].as_str().unwrap_or(""),
            "AI 已基于当前本地上下文整理出一版概览，方便快速判断当前状态与下一步。"
        );

        let sections = artifact
            .json_payload
            .get("sections")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(sections.len(), ACTIVITY_SUMMARY_SECTIONS.len());

        let loaded = database
            .ai_artifact_get(AiArtifactGetInput {
                kind: "activity_summary".to_string(),
                project_id: Some(project.id),
                activity_id: Some(activity.id),
                artifact_date: None,
            })
            .unwrap()
            .unwrap();
        assert_eq!(loaded.id, artifact.id);
    }

    #[test]
    fn ai_artifact_refresh_returns_controlled_error_when_feature_toggle_is_disabled() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Budget Review");
        create_note(
            &mut database,
            project.id,
            activity.id,
            DEFAULT_RECORD_TYPE_KEY,
            "确认当前目标与下一步约束",
        );
        configure_summary_profile(&mut database);

        let mut feature_settings = default_ai_feature_settings();
        feature_settings
            .features
            .insert("summary.activity_summary".to_string(), false);
        database
            .ai_feature_settings_upsert(feature_settings)
            .unwrap();

        let error = database
            .ai_artifact_refresh(AiArtifactGetInput {
                kind: "activity_summary".to_string(),
                project_id: Some(project.id),
                activity_id: Some(activity.id),
                artifact_date: None,
            })
            .unwrap_err();

        assert!(error
            .to_string()
            .contains("AI feature 'summary.activity_summary' is disabled in workspace settings"));
    }

    #[test]
    fn ai_artifact_stale_marking_only_hits_related_scope() {
        let (harness, mut database) = setup_database();
        let project_a = create_project(&mut database, &harness.workspace_root);
        let activity_a = create_activity(&mut database, project_a.id, "Kickoff");
        let note_a = create_note(
            &mut database,
            project_a.id,
            activity_a.id,
            DEFAULT_RECORD_TYPE_KEY,
            "记录 A",
        );

        let project_b = database
            .project_create(ProjectCreateInput {
                name: "Beta".to_string(),
                summary: Some("Second project".to_string()),
                status: None,
            })
            .unwrap();
        create_activity(&mut database, project_b.id, "Review");

        configure_summary_profile(&mut database);

        let activity_a_artifact = database
            .ai_artifact_refresh(AiArtifactGetInput {
                kind: "activity_summary".to_string(),
                project_id: Some(project_a.id),
                activity_id: Some(activity_a.id),
                artifact_date: None,
            })
            .unwrap();
        let project_a_artifact = database
            .ai_artifact_refresh(AiArtifactGetInput {
                kind: "project_brief".to_string(),
                project_id: Some(project_a.id),
                activity_id: None,
                artifact_date: None,
            })
            .unwrap();
        let project_b_artifact = database
            .ai_artifact_refresh(AiArtifactGetInput {
                kind: "project_brief".to_string(),
                project_id: Some(project_b.id),
                activity_id: None,
                artifact_date: None,
            })
            .unwrap();
        let daily_artifact = database
            .ai_artifact_refresh(AiArtifactGetInput {
                kind: "daily_brief".to_string(),
                project_id: None,
                activity_id: None,
                artifact_date: Some(current_workspace_date()),
            })
            .unwrap();

        assert_eq!(activity_a_artifact.status, AI_ARTIFACT_STATUS_FRESH);
        assert_eq!(project_a_artifact.status, AI_ARTIFACT_STATUS_FRESH);
        assert_eq!(project_b_artifact.status, AI_ARTIFACT_STATUS_FRESH);
        assert_eq!(daily_artifact.status, AI_ARTIFACT_STATUS_FRESH);

        database
            .note_upsert(NoteUpsertInput {
                project_id: project_a.id,
                activity_id: activity_a.id,
                note_id: Some(note_a.id),
                note_type: DEFAULT_RECORD_TYPE_KEY.to_string(),
                title: Some("记录".to_string()),
                markdown: "记录 A updated".to_string(),
                html: "<p>记录 A updated</p>".to_string(),
            })
            .unwrap();

        let refreshed_activity_a = database
            .ai_artifact_get(AiArtifactGetInput {
                kind: "activity_summary".to_string(),
                project_id: Some(project_a.id),
                activity_id: Some(activity_a.id),
                artifact_date: None,
            })
            .unwrap()
            .unwrap();
        let refreshed_project_a = database
            .ai_artifact_get(AiArtifactGetInput {
                kind: "project_brief".to_string(),
                project_id: Some(project_a.id),
                activity_id: None,
                artifact_date: None,
            })
            .unwrap()
            .unwrap();
        let refreshed_project_b = database
            .ai_artifact_get(AiArtifactGetInput {
                kind: "project_brief".to_string(),
                project_id: Some(project_b.id),
                activity_id: None,
                artifact_date: None,
            })
            .unwrap()
            .unwrap();
        let refreshed_daily = database
            .ai_artifact_get(AiArtifactGetInput {
                kind: "daily_brief".to_string(),
                project_id: None,
                activity_id: None,
                artifact_date: Some(current_workspace_date()),
            })
            .unwrap()
            .unwrap();

        assert_eq!(refreshed_activity_a.status, AI_ARTIFACT_STATUS_STALE);
        assert_eq!(refreshed_project_a.status, AI_ARTIFACT_STATUS_STALE);
        assert_eq!(refreshed_project_b.status, AI_ARTIFACT_STATUS_FRESH);
        assert_eq!(refreshed_daily.status, AI_ARTIFACT_STATUS_STALE);
    }

    #[test]
    fn ai_answer_question_returns_controlled_error_when_assistant_is_unconfigured() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);

        let error = database
            .ai_answer_question(AiAnswerQuestionInput {
                scope: AiAnswerScope::Project,
                question: "当前重点是什么？".to_string(),
                project_id: Some(project.id),
                activity_id: None,
            })
            .unwrap_err();

        assert!(error
            .to_string()
            .contains("AI capability 'assistant' is not configured yet"));
    }

    #[test]
    fn ai_answer_question_returns_controlled_error_when_assistant_toggle_is_disabled() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        create_activity(&mut database, project.id, "Budget Review");
        configure_assistant_profile(&mut database);

        let mut feature_settings = default_ai_feature_settings();
        feature_settings
            .capabilities
            .insert("assistant".to_string(), false);
        database
            .ai_feature_settings_upsert(feature_settings)
            .unwrap();

        let error = database
            .ai_answer_question(AiAnswerQuestionInput {
                scope: AiAnswerScope::Project,
                question: "当前重点是什么？".to_string(),
                project_id: Some(project.id),
                activity_id: None,
            })
            .unwrap_err();

        assert!(error
            .to_string()
            .contains("AI capability 'assistant' is disabled in workspace settings"));
    }

    #[test]
    fn ai_answer_question_returns_mock_answer_with_citations() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Budget Review");
        create_note(
            &mut database,
            project.id,
            activity.id,
            DEFAULT_RECORD_TYPE_KEY,
            "需要先确认预算范围，再决定是否推进合同。",
        );
        create_todo(
            &mut database,
            project.id,
            Some(activity.id),
            "确认预算边界",
            "urgent_important",
        );
        configure_assistant_profile(&mut database);

        let answer = database
            .ai_answer_question(AiAnswerQuestionInput {
                scope: AiAnswerScope::Activity,
                question: "预算下一步是什么？".to_string(),
                project_id: Some(project.id),
                activity_id: Some(activity.id),
            })
            .unwrap();

        assert_eq!(answer.scope, AiAnswerScope::Activity);
        assert_eq!(answer.skill_key, ASK_SKILL.skill_key);
        assert_eq!(answer.skill_version, ASK_SKILL.skill_version);
        assert!(!answer.answer_markdown.trim().is_empty());
        assert!(!answer.citations.is_empty());
        assert!(answer
            .citations
            .iter()
            .all(|citation| citation.project_id == Some(project.id)));
    }

    #[test]
    fn ai_answer_question_keeps_project_scope_isolated() {
        let (harness, mut database) = setup_database();
        let project_a = create_project(&mut database, &harness.workspace_root);
        let activity_a = create_activity(&mut database, project_a.id, "Alpha Activity");
        create_todo(
            &mut database,
            project_a.id,
            Some(activity_a.id),
            "确认预算边界",
            "urgent_important",
        );

        let project_b = database
            .project_create(ProjectCreateInput {
                name: "Beta".to_string(),
                summary: Some("Second project".to_string()),
                status: None,
            })
            .unwrap();
        let activity_b = create_activity(&mut database, project_b.id, "Beta Activity");
        create_todo(
            &mut database,
            project_b.id,
            Some(activity_b.id),
            "法务回款阻塞",
            "urgent_important",
        );
        configure_assistant_profile(&mut database);

        let answer = database
            .ai_answer_question(AiAnswerQuestionInput {
                scope: AiAnswerScope::Project,
                question: "预算当前卡在哪？".to_string(),
                project_id: Some(project_a.id),
                activity_id: None,
            })
            .unwrap();

        assert!(!answer.citations.is_empty());
        assert!(answer
            .citations
            .iter()
            .all(|citation| citation.project_id == Some(project_a.id)));
    }

    #[test]
    fn ai_answer_question_returns_conservative_result_when_hits_are_insufficient() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        create_activity(&mut database, project.id, "Kickoff");
        configure_assistant_profile(&mut database);

        let answer = database
            .ai_answer_question(AiAnswerQuestionInput {
                scope: AiAnswerScope::Workspace,
                question: "完全不存在的超长专有词条".to_string(),
                project_id: None,
                activity_id: None,
            })
            .unwrap();

        assert!(answer.answer_markdown.contains("依据"));
        assert!(answer.citations.is_empty());
        assert_eq!(answer.scope, AiAnswerScope::Workspace);
    }

    #[test]
    fn ai_generate_note_suggestions_respects_enabled_output_types() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Budget Review");
        let note = create_note(
            &mut database,
            project.id,
            activity.id,
            DEFAULT_RECORD_TYPE_KEY,
            "确认当前阶段目标与约束",
        );
        configure_suggestion_profile(&mut database);

        let mut conclusion_only = default_ai_feature_settings();
        conclusion_only
            .features
            .insert("suggestion_generation.conclusion".to_string(), true);
        conclusion_only
            .features
            .insert("suggestion_generation.todo".to_string(), false);
        database
            .ai_feature_settings_upsert(conclusion_only)
            .unwrap();

        let suggestions = database
            .ai_generate_note_suggestions(AiGenerateInput {
                project_id: project.id,
                activity_id: activity.id,
                note_id: Some(note.id),
            })
            .unwrap();

        assert!(!suggestions.is_empty());
        assert!(suggestions
            .iter()
            .all(|suggestion| suggestion.suggestion_type == "conclusion"));

        let mut todo_only = default_ai_feature_settings();
        todo_only
            .features
            .insert("suggestion_generation.conclusion".to_string(), false);
        todo_only
            .features
            .insert("suggestion_generation.todo".to_string(), true);
        database.ai_feature_settings_upsert(todo_only).unwrap();

        let suggestions = database
            .ai_generate_note_suggestions(AiGenerateInput {
                project_id: project.id,
                activity_id: activity.id,
                note_id: Some(note.id),
            })
            .unwrap();

        assert!(!suggestions.is_empty());
        assert!(suggestions
            .iter()
            .all(|suggestion| suggestion.suggestion_type == "todo"));
    }

    #[test]
    fn ai_generate_note_suggestions_returns_controlled_error_when_capability_is_disabled() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Budget Review");
        let note = create_note(
            &mut database,
            project.id,
            activity.id,
            DEFAULT_RECORD_TYPE_KEY,
            "确认当前阶段目标与约束",
        );
        configure_suggestion_profile(&mut database);

        let mut feature_settings = default_ai_feature_settings();
        feature_settings
            .capabilities
            .insert("suggestion_generation".to_string(), false);
        database
            .ai_feature_settings_upsert(feature_settings)
            .unwrap();

        let error = database
            .ai_generate_note_suggestions(AiGenerateInput {
                project_id: project.id,
                activity_id: activity.id,
                note_id: Some(note.id),
            })
            .unwrap_err();

        assert!(error
            .to_string()
            .contains("AI capability 'suggestion_generation' is disabled in workspace settings"));
    }

    #[test]
    fn infer_todo_priority_distinguishes_urgency_and_importance() {
        assert_eq!(
            infer_todo_priority("今天确认预算审批边界，并由财务补充拆分明细"),
            "urgent_important"
        );
        assert_eq!(
            infer_todo_priority("尽快同步会议纪要"),
            "urgent_not_important"
        );
        assert_eq!(
            infer_todo_priority("准备法务评审材料"),
            "not_urgent_important"
        );
        assert_eq!(
            infer_todo_priority("整理一下记录"),
            "not_urgent_not_important"
        );
    }

    #[test]
    fn ai_accept_suggestion_uses_payload_override_for_edited_content() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Budget Review");
        let note = create_note(
            &mut database,
            project.id,
            activity.id,
            DEFAULT_RECORD_TYPE_KEY,
            "确认预算范围，需要财务补充拆分明细",
        );
        configure_suggestion_profile(&mut database);

        let suggestions = database
            .ai_generate_note_suggestions(AiGenerateInput {
                project_id: project.id,
                activity_id: activity.id,
                note_id: Some(note.id),
            })
            .unwrap();

        let conclusion = suggestions
            .iter()
            .find(|suggestion| suggestion.suggestion_type == "conclusion")
            .unwrap();
        let todo = suggestions
            .iter()
            .find(|suggestion| suggestion.suggestion_type == "todo")
            .unwrap();

        let accepted_conclusion = database
            .ai_accept_suggestion(AiAcceptSuggestionInput {
                suggestion_id: conclusion.id,
                payload_override: Some(json!({
                    "content": "已确认预算边界，按现方案推进",
                    "promotedToProject": false
                })),
            })
            .unwrap();
        let accepted_todo = database
            .ai_accept_suggestion(AiAcceptSuggestionInput {
                suggestion_id: todo.id,
                payload_override: Some(json!({
                    "content": "财务今天补充预算拆分明细",
                    "priority": "urgent_important"
                })),
            })
            .unwrap();

        let saved_conclusion = database
            .conclusion_record(accepted_conclusion.entity_id)
            .unwrap();
        let saved_todo = database.todo_record(accepted_todo.entity_id).unwrap();

        assert_eq!(
            saved_conclusion.content_markdown,
            "已确认预算边界，按现方案推进"
        );
        assert!(!saved_conclusion.promoted_to_project);
        assert_eq!(saved_todo.content, "财务今天补充预算拆分明细");
        assert_eq!(saved_todo.priority, "urgent_important");
        assert_eq!(
            accepted_todo
                .suggestion
                .payload
                .get("content")
                .and_then(Value::as_str),
            Some("财务今天补充预算拆分明细")
        );
        assert_eq!(
            accepted_todo
                .suggestion
                .payload
                .get("priority")
                .and_then(Value::as_str),
            Some("urgent_important")
        );
    }

    #[test]
    fn todo_update_priority_persists_new_priority_and_returns_updated_record() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Budget Review");
        let todo = create_todo(
            &mut database,
            project.id,
            Some(activity.id),
            "Prepare legal summary",
            "not_urgent_important",
        );

        thread::sleep(Duration::from_millis(5));

        let updated = database
            .todo_update_priority(TodoUpdatePriorityInput {
                todo_id: todo.id,
                priority: "urgent_important".to_string(),
            })
            .unwrap();

        assert_eq!(updated.id, todo.id);
        assert_eq!(updated.priority, "urgent_important");
        assert_ne!(updated.updated_at, todo.updated_at);

        let refreshed = database.todo_record(todo.id).unwrap();
        assert_eq!(refreshed.priority, "urgent_important");
        assert_eq!(refreshed.updated_at, updated.updated_at);
    }

    #[test]
    fn todo_update_activity_rebinds_within_project_and_can_clear_to_project_level() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity_a = create_activity(&mut database, project.id, "Budget Review");
        let activity_b = create_activity(&mut database, project.id, "Project Retro");
        let todo = create_todo(
            &mut database,
            project.id,
            Some(activity_a.id),
            "Prepare legal summary",
            "not_urgent_important",
        );

        let rebound = database
            .todo_update_activity(TodoUpdateActivityInput {
                todo_id: todo.id,
                activity_id: Some(activity_b.id),
            })
            .unwrap();

        assert_eq!(rebound.activity_id, Some(activity_b.id));
        assert_eq!(rebound.source_activity_title.as_deref(), Some("Project Retro"));

        let cleared = database
            .todo_update_activity(TodoUpdateActivityInput {
                todo_id: todo.id,
                activity_id: None,
            })
            .unwrap();

        assert_eq!(cleared.activity_id, None);
        assert_eq!(cleared.source_activity_title, None);
    }

    #[test]
    fn conclusion_list_orders_pinned_first_then_created_at() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Budget Review");

        let pinned_older = database
            .conclusion_create(ConclusionCreateInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                note_id: None,
                markdown: "较早置顶结论".to_string(),
                html: "<p>较早置顶结论</p>".to_string(),
                promoted_to_project: true,
                is_pinned: Some(true),
            })
            .unwrap();
        thread::sleep(Duration::from_millis(5));

        let unpinned_newer = database
            .conclusion_create(ConclusionCreateInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                note_id: None,
                markdown: "较新普通结论".to_string(),
                html: "<p>较新普通结论</p>".to_string(),
                promoted_to_project: true,
                is_pinned: Some(false),
            })
            .unwrap();
        thread::sleep(Duration::from_millis(5));

        let pinned_newest = database
            .conclusion_create(ConclusionCreateInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                note_id: None,
                markdown: "最新置顶结论".to_string(),
                html: "<p>最新置顶结论</p>".to_string(),
                promoted_to_project: true,
                is_pinned: Some(true),
            })
            .unwrap();

        let conclusions = database
            .conclusion_list(ConclusionListInput {
                project_id: project.id,
                activity_id: Some(activity.id),
            })
            .unwrap();

        let ids = conclusions.iter().map(|item| item.id).collect::<Vec<_>>();
        assert_eq!(ids, vec![pinned_newest.id, pinned_older.id, unpinned_newer.id]);
    }

    #[test]
    fn project_overview_groups_prioritize_pinned_project_conclusions() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);

        let pinned_older = database
            .conclusion_create(ConclusionCreateInput {
                project_id: project.id,
                activity_id: None,
                note_id: None,
                markdown: "较早置顶项目结论".to_string(),
                html: "<p>较早置顶项目结论</p>".to_string(),
                promoted_to_project: false,
                is_pinned: Some(true),
            })
            .unwrap();
        thread::sleep(Duration::from_millis(5));

        let unpinned_newer = database
            .conclusion_create(ConclusionCreateInput {
                project_id: project.id,
                activity_id: None,
                note_id: None,
                markdown: "较新普通项目结论".to_string(),
                html: "<p>较新普通项目结论</p>".to_string(),
                promoted_to_project: false,
                is_pinned: Some(false),
            })
            .unwrap();

        let overview = database
            .project_get_overview(ProjectIdInput {
                project_id: project.id,
            })
            .unwrap();
        let project_group = overview
            .conclusion_groups
            .iter()
            .find(|group| group.activity_id.is_none())
            .unwrap();
        let ids = project_group
            .conclusions
            .iter()
            .map(|item| item.id)
            .collect::<Vec<_>>();

        assert_eq!(ids, vec![pinned_older.id, unpinned_newer.id]);
    }

    #[test]
    fn conclusion_delete_removes_record_and_returns_deleted_conclusion() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Budget Review");
        let conclusion = database
            .conclusion_create(ConclusionCreateInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                note_id: None,
                markdown: "确认第一阶段只覆盖中文场景".to_string(),
                html: "<p>确认第一阶段只覆盖中文场景</p>".to_string(),
                promoted_to_project: true,
                is_pinned: None,
            })
            .unwrap();

        let deleted = database
            .conclusion_delete(ConclusionDeleteInput {
                conclusion_id: conclusion.id,
            })
            .unwrap();

        assert_eq!(deleted.id, conclusion.id);
        assert!(database.conclusion_record(conclusion.id).is_err());
        assert!(database
            .conclusion_list(ConclusionListInput {
                project_id: project.id,
                activity_id: Some(activity.id),
            })
            .unwrap()
            .is_empty());
    }

    #[test]
    fn todo_delete_removes_record_and_cascades_progresses() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Budget Review");
        let todo = create_todo(
            &mut database,
            project.id,
            Some(activity.id),
            "Prepare legal summary",
            "not_urgent_important",
        );
        database
            .todo_add_progress(TodoAddProgressInput {
                todo_id: todo.id,
                content: "已同步法务".to_string(),
                progress_date: "2026-04-06".to_string(),
            })
            .unwrap();

        let deleted = database
            .todo_delete(TodoDeleteInput { todo_id: todo.id })
            .unwrap();

        assert_eq!(deleted.id, todo.id);
        assert!(database.todo_record(todo.id).is_err());

        let progress_count = database
            .conn
            .query_row(
                "SELECT COUNT(*) FROM todo_progresses WHERE todo_id = ?1",
                [todo.id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(progress_count, 0);
    }

    #[test]
    fn todo_update_progress_persists_changes_and_refreshes_todo_timestamp() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Budget Review");
        let todo = create_todo(
            &mut database,
            project.id,
            Some(activity.id),
            "Prepare legal summary",
            "not_urgent_important",
        );
        let progress = database
            .todo_add_progress(TodoAddProgressInput {
                todo_id: todo.id,
                content: "已同步法务".to_string(),
                progress_date: "2026-04-06".to_string(),
            })
            .unwrap();

        thread::sleep(Duration::from_millis(5));

        let updated = database
            .todo_update_progress(TodoUpdateProgressInput {
                progress_id: progress.id,
                content: "已同步法务并补充截止时间".to_string(),
                progress_date: "2026-04-07".to_string(),
            })
            .unwrap();

        assert_eq!(updated.id, progress.id);
        assert_eq!(updated.content, "已同步法务并补充截止时间");
        assert_eq!(updated.progress_date, "2026-04-07");

        let refreshed = database.todo_record(todo.id).unwrap();
        assert_eq!(refreshed.progresses[0].content, "已同步法务并补充截止时间");
        assert_eq!(refreshed.progresses[0].progress_date, "2026-04-07");
        assert_ne!(refreshed.updated_at, todo.updated_at);
    }

    #[test]
    fn todo_delete_progress_removes_only_target_progress() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Budget Review");
        let todo = create_todo(
            &mut database,
            project.id,
            Some(activity.id),
            "Prepare legal summary",
            "not_urgent_important",
        );
        let progress_a = database
            .todo_add_progress(TodoAddProgressInput {
                todo_id: todo.id,
                content: "已同步法务".to_string(),
                progress_date: "2026-04-06".to_string(),
            })
            .unwrap();
        let progress_b = database
            .todo_add_progress(TodoAddProgressInput {
                todo_id: todo.id,
                content: "等待财务确认".to_string(),
                progress_date: "2026-04-05".to_string(),
            })
            .unwrap();

        let deleted = database
            .todo_delete_progress(TodoDeleteProgressInput {
                progress_id: progress_b.id,
            })
            .unwrap();

        assert_eq!(deleted.id, progress_b.id);
        assert!(database.todo_progress_record(progress_b.id).is_err());

        let refreshed = database.todo_record(todo.id).unwrap();
        assert_eq!(refreshed.progresses.len(), 1);
        assert_eq!(refreshed.progresses[0].id, progress_a.id);
    }

    #[test]
    fn project_update_summary_can_rename_project_and_refresh_updated_at() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let old_root = PathBuf::from(&project.root_path);

        thread::sleep(Duration::from_millis(5));

        let updated = database
            .project_update_summary(ProjectUpdateSummaryInput {
                project_id: project.id,
                name: Some("Alpha Prime".to_string()),
                summary: "最新项目简介".to_string(),
                summary_markdown: Some("## 最新项目简介\n- 风险已同步".to_string()),
                summary_html: Some("<h2>最新项目简介</h2><ul><li>风险已同步</li></ul>".to_string()),
                status: Some("active".to_string()),
            })
            .unwrap();

        assert_eq!(updated.id, project.id);
        assert_eq!(updated.name, "Alpha Prime");
        assert_eq!(updated.summary, "最新项目简介");
        assert_eq!(updated.summary_markdown, "## 最新项目简介\n- 风险已同步");
        assert_eq!(updated.summary_html, "<h2>最新项目简介</h2><ul><li>风险已同步</li></ul>");
        assert_ne!(updated.updated_at, project.updated_at);
        assert_eq!(
            updated.root_path,
            harness
                .workspace_root
                .join("Alpha Prime")
                .to_string_lossy()
                .to_string()
        );
        assert!(!old_root.exists());
        assert!(Path::new(&updated.root_path).exists());

        let refreshed = database.project_record(project.id).unwrap();
        assert_eq!(refreshed.name, "Alpha Prime");
        assert_eq!(refreshed.summary, "最新项目简介");
        assert_eq!(refreshed.summary_markdown, updated.summary_markdown);
        assert_eq!(refreshed.summary_html, updated.summary_html);
        assert_eq!(refreshed.updated_at, updated.updated_at);
        assert_eq!(refreshed.root_path, updated.root_path);
    }

    #[test]
    fn project_update_summary_preserves_existing_rich_text_when_only_renaming() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);

        let enriched = database
            .project_update_summary(ProjectUpdateSummaryInput {
                project_id: project.id,
                name: None,
                summary: "阶段目标与关键约束".to_string(),
                summary_markdown: Some("## 阶段目标\n- 关键约束".to_string()),
                summary_html: Some("<h2>阶段目标</h2><ul><li>关键约束</li></ul>".to_string()),
                status: Some(project.status.clone()),
            })
            .unwrap();

        let renamed = database
            .project_update_summary(ProjectUpdateSummaryInput {
                project_id: project.id,
                name: Some("Alpha Prime".to_string()),
                summary: enriched.summary.clone(),
                summary_markdown: None,
                summary_html: None,
                status: Some(enriched.status.clone()),
            })
            .unwrap();

        assert_eq!(renamed.name, "Alpha Prime");
        assert_eq!(renamed.summary, enriched.summary);
        assert_eq!(renamed.summary_markdown, enriched.summary_markdown);
        assert_eq!(renamed.summary_html, enriched.summary_html);
    }

    #[test]
    fn project_rename_moves_document_paths_and_rewrites_internal_asset_refs() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");

        let project_source = PathBuf::from(&project.root_path).join("brief.pdf");
        fs::write(&project_source, b"brief-v1").unwrap();
        let project_document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: None,
                source_path: project_source.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        let versioned_project_document = database
            .document_add_version(DocumentAddVersionInput {
                document_id: project_document.id,
                source_path: None,
            })
            .unwrap();

        let activity_source = PathBuf::from(&project.root_path)
            .join("Kickoff")
            .join("agenda.pdf");
        fs::write(&activity_source, b"agenda").unwrap();
        let activity_document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                source_path: activity_source.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();

        let external_source = harness.root.join("outside.pdf");
        fs::write(&external_source, b"outside").unwrap();
        let external_document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                source_path: external_source.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();

        let note_image = database
            .document_import_clipboard_note_image(DocumentImportClipboardNoteImageInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                file_name: "clip.png".to_string(),
                mime_type: "image/png".to_string(),
                data_base64: STANDARD.encode(b"clip-image"),
            })
            .unwrap();

        let old_note_image_path = note_image.managed_path.clone();
        let old_project_document_path = versioned_project_document.managed_path.clone();
        let old_activity_document_path = activity_document.managed_path.clone();
        let project_document_href =
            file_href_from_path(Path::new(&versioned_project_document.managed_path));
        let activity_document_href =
            file_href_from_path(Path::new(&activity_document.managed_path));
        let old_project_document_href = project_document_href.clone();
        let old_activity_document_href = activity_document_href.clone();
        let rich_html = format!(
            concat!(
                r#"<p><img src="data:image/png;base64,AAAA" data-path="{note_image_path}" data-mime-type="image/png" alt="截图" /></p>"#,
                r#"<div data-type="attachment" data-path="{project_document_path}" data-href="{project_document_href}">"#,
                r#"<a class="rich-editor__attachment-link" href="{project_document_href}">项目附件</a></div>"#,
                r#"<div data-type="attachment" data-path="{activity_document_path}" data-href="{activity_document_href}">"#,
                r#"<a class="rich-editor__attachment-link" href="{activity_document_href}">活动附件</a></div>"#
            ),
            note_image_path = note_image.managed_path,
            project_document_path = versioned_project_document.managed_path,
            project_document_href = project_document_href,
            activity_document_path = activity_document.managed_path,
            activity_document_href = activity_document_href,
        );

        let note = database
            .note_upsert(NoteUpsertInput {
                project_id: project.id,
                activity_id: activity.id,
                note_id: None,
                note_type: DEFAULT_RECORD_TYPE_KEY.to_string(),
                title: Some("路径联动记录".to_string()),
                markdown: "[图片] 截图\n[附件] 项目附件\n[附件] 活动附件".to_string(),
                html: rich_html.clone(),
            })
            .unwrap();
        let conclusion = database
            .conclusion_create(ConclusionCreateInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                note_id: Some(note.id),
                markdown: "[附件] 活动附件".to_string(),
                html: rich_html.clone(),
                promoted_to_project: false,
                is_pinned: None,
            })
            .unwrap();

        let old_root = PathBuf::from(&project.root_path);
        let updated_project = database
            .project_update_summary(ProjectUpdateSummaryInput {
                project_id: project.id,
                name: Some("Alpha Prime".to_string()),
                summary: project.summary.clone(),
                summary_markdown: None,
                summary_html: None,
                status: Some(project.status.clone()),
            })
            .unwrap();

        let new_root = PathBuf::from(&updated_project.root_path);
        let renamed_project_document = database.document_record(project_document.id).unwrap();
        let renamed_activity_document = database.document_record(activity_document.id).unwrap();
        let renamed_external_document = database.document_record(external_document.id).unwrap();
        let renamed_note_image = database.document_record(note_image.id).unwrap();
        let project_versions = database
            .document_list_versions(DocumentListVersionsInput {
                document_id: project_document.id,
            })
            .unwrap();
        let activity_versions = database
            .document_list_versions(DocumentListVersionsInput {
                document_id: activity_document.id,
            })
            .unwrap();
        let external_versions = database
            .document_list_versions(DocumentListVersionsInput {
                document_id: external_document.id,
            })
            .unwrap();
        let saved_note = database.note_record(note.id).unwrap();
        let saved_conclusion = database.conclusion_record(conclusion.id).unwrap();

        assert!(!old_root.exists());
        assert!(new_root.exists());
        assert!(renamed_project_document
            .managed_path
            .starts_with(updated_project.root_path.as_str()));
        assert!(renamed_project_document
            .history_dir_path
            .starts_with(updated_project.root_path.as_str()));
        assert!(renamed_project_document
            .original_path
            .starts_with(updated_project.root_path.as_str()));
        assert!(renamed_activity_document
            .managed_path
            .starts_with(updated_project.root_path.as_str()));
        assert!(renamed_activity_document
            .original_path
            .starts_with(updated_project.root_path.as_str()));
        assert!(renamed_note_image
            .managed_path
            .starts_with(updated_project.root_path.as_str()));
        assert!(renamed_note_image
            .original_path
            .starts_with(updated_project.root_path.as_str()));
        assert_eq!(
            renamed_external_document.original_path,
            external_source.to_string_lossy().to_string()
        );
        assert!(project_versions.iter().all(|version| version
            .managed_path
            .starts_with(updated_project.root_path.as_str())));
        assert!(project_versions.iter().all(|version| version
            .source_path
            .starts_with(updated_project.root_path.as_str())));
        assert!(activity_versions.iter().all(|version| version
            .managed_path
            .starts_with(updated_project.root_path.as_str())));
        assert!(activity_versions.iter().all(|version| version
            .source_path
            .starts_with(updated_project.root_path.as_str())));
        assert_eq!(
            external_versions[0].source_path,
            external_source.to_string_lossy().to_string()
        );
        assert!(saved_note
            .content_html
            .contains(&renamed_note_image.managed_path));
        assert!(saved_note
            .content_html
            .contains(&renamed_project_document.managed_path));
        assert!(saved_note
            .content_html
            .contains(&renamed_activity_document.managed_path));
        assert!(saved_note
            .content_html
            .contains(&file_href_from_path(Path::new(
                &renamed_project_document.managed_path
            ))));
        assert!(saved_note
            .content_html
            .contains(&file_href_from_path(Path::new(
                &renamed_activity_document.managed_path
            ))));
        assert!(!saved_note.content_html.contains(&old_note_image_path));
        assert!(!saved_note.content_html.contains(&old_project_document_path));
        assert!(!saved_note
            .content_html
            .contains(&old_activity_document_path));
        assert!(!saved_note.content_html.contains(&old_project_document_href));
        assert!(!saved_note
            .content_html
            .contains(&old_activity_document_href));
        assert!(saved_conclusion
            .content_html
            .contains(&renamed_note_image.managed_path));
        assert!(saved_conclusion
            .content_html
            .contains(&renamed_activity_document.managed_path));
        assert!(!saved_conclusion.content_html.contains(&old_note_image_path));
        assert!(!saved_conclusion
            .content_html
            .contains(&old_activity_document_path));
        assert!(!saved_conclusion
            .content_html
            .contains(&old_project_document_href));
        assert!(!saved_conclusion
            .content_html
            .contains(&old_activity_document_href));
    }

    #[test]
    fn project_rename_fails_when_target_folder_already_exists_without_mutating_state() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let old_root = PathBuf::from(&project.root_path);
        let conflicting_root = harness.workspace_root.join("Alpha Prime");
        fs::create_dir_all(&conflicting_root).unwrap();

        let error = database
            .project_update_summary(ProjectUpdateSummaryInput {
                project_id: project.id,
                name: Some("Alpha Prime".to_string()),
                summary: project.summary.clone(),
                summary_markdown: None,
                summary_html: None,
                status: Some(project.status.clone()),
            })
            .unwrap_err();

        assert!(error.to_string().contains("文件夹名称已被占用"));
        assert!(old_root.exists());
        assert!(conflicting_root.exists());
        let refreshed = database.project_record(project.id).unwrap();
        assert_eq!(refreshed.name, project.name);
        assert_eq!(refreshed.root_path, project.root_path);
    }

    #[test]
    fn legacy_activity_settings_migration_backfills_existing_rows() {
        let unique = next_test_unique();
        let root =
            std::env::temp_dir().join(format!("project-mind-activity-settings-legacy-{unique}"));
        let workspace_root = root.join("workspace");
        let project_root = workspace_root.join("Alpha");
        fs::create_dir_all(&project_root).unwrap();
        let db_path = root.join("app.sqlite3");
        let conn = Connection::open(&db_path).unwrap();

        conn.execute_batch(
            r#"
            CREATE TABLE projects (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'active',
              root_path TEXT NOT NULL,
              file_layout_version INTEGER NOT NULL DEFAULT 2,
              summary TEXT NOT NULL DEFAULT '',
              is_archived INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE activities (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_id INTEGER NOT NULL,
              category TEXT NOT NULL,
              title TEXT NOT NULL DEFAULT '',
              activity_time TEXT NOT NULL,
              is_pinned INTEGER NOT NULL DEFAULT 0,
              is_expanded INTEGER NOT NULL DEFAULT 0,
              organize_status TEXT NOT NULL DEFAULT 'needs_review',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            "#,
        )
        .unwrap();
        conn.execute(
            r#"
            INSERT INTO projects (id, name, status, root_path, file_layout_version, summary, is_archived, created_at, updated_at)
            VALUES (?1, ?2, 'active', ?3, 2, '', 0, ?4, ?5)
            "#,
            params![
                1,
                "Alpha",
                project_root.to_string_lossy().to_string(),
                "2026-04-06T08:00:00.000Z",
                "2026-04-06T08:00:00.000Z",
            ],
        )
        .unwrap();
        conn.execute(
            r#"
            INSERT INTO activities (
              project_id, category, title, activity_time, is_pinned, is_expanded, organize_status, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, 0, 1, 'organized', ?5, ?6)
            "#,
            params![
                1,
                "legal",
                "法务确认",
                "2026-04-06T10:00:00.000Z",
                "2026-04-06T10:00:00.000Z",
                "2026-04-06T10:00:00.000Z",
            ],
        )
        .unwrap();
        drop(conn);

        let mut database =
            Database::open(&db_path, &workspace_root, Some("test-secret".to_string())).unwrap();
        let settings = database.activity_settings_get().unwrap();
        let activities = database
            .activity_list(ProjectIdInput { project_id: 1 })
            .unwrap();

        assert!(settings
            .activity_attribute_options
            .iter()
            .any(|option| option.label == "LEGAL"));
        assert!(settings
            .activity_attribute_options
            .iter()
            .any(|option| option.label == "LEGAL"
                && option.color_key == DEFAULT_ACTIVITY_ATTRIBUTE_COLOR_KEY));
        assert!(settings
            .activity_status_options
            .iter()
            .any(|option| option.label == "待启动" && option.is_system));
        assert_eq!(activities[0].attribute_label.as_deref(), Some("LEGAL"));
        assert_eq!(
            activities[0].attribute_color_key.as_deref(),
            Some(DEFAULT_ACTIVITY_ATTRIBUTE_COLOR_KEY)
        );
        assert_eq!(activities[0].status_label, "已整理");
        assert_eq!(
            activities[0].status_color_key,
            LEGACY_ACTIVITY_STATUS_ORGANIZED_COLOR_KEY
        );
        assert!(!activities[0].status_needs_attention);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deleting_activity_options_updates_existing_activities() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let attribute = database
            .activity_attribute_option_upsert(ActivityAttributeOptionUpsertInput {
                id: None,
                label: "LEGAL".to_string(),
                color_key: "blue".to_string(),
            })
            .unwrap();
        let status = database
            .activity_status_option_upsert(ActivityStatusOptionUpsertInput {
                id: None,
                label: "待外部反馈".to_string(),
                color_key: "orange".to_string(),
            })
            .unwrap();

        let activity = database
            .activity_create(ActivityCreateInput {
                project_id: project.id,
                attribute_option_id: Some(attribute.id),
                title: Some("合同同步".to_string()),
                activity_time: "2026-04-06T10:00:00.000Z".to_string(),
            })
            .unwrap();

        database
            .activity_update_meta(ActivityUpdateMetaInput {
                activity_id: activity.id,
                title: None,
                brief_markdown: None,
                brief_html: None,
                attribute_option_id: None,
                clear_attribute_option: None,
                activity_time: None,
                is_pinned: None,
                is_expanded: None,
                status_option_id: Some(status.id),
            })
            .unwrap();

        database
            .activity_attribute_option_delete(ActivityOptionDeleteInput {
                option_id: attribute.id,
            })
            .unwrap();
        database
            .activity_status_option_delete(ActivityOptionDeleteInput {
                option_id: status.id,
            })
            .unwrap();

        let refreshed = database.activity_card(activity.id).unwrap();
        assert_eq!(refreshed.attribute_option_id, None);
        assert_eq!(refreshed.attribute_label, None);
        assert_eq!(refreshed.attribute_color_key, None);
        assert_eq!(refreshed.status_label, "待启动");
        assert_eq!(
            refreshed.status_color_key,
            DEFAULT_ACTIVITY_STATUS_COLOR_KEY
        );
        assert!(refreshed.status_needs_attention);
    }

    #[test]
    fn activity_update_meta_persists_brief_and_preserves_it_on_title_changes() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");

        let updated = database
            .activity_update_meta(ActivityUpdateMetaInput {
                activity_id: activity.id,
                title: None,
                brief_markdown: Some("## 当前背景\n- 已完成范围澄清".to_string()),
                brief_html: Some(
                    "<h2>当前背景</h2><ul><li>已完成范围澄清</li></ul>".to_string(),
                ),
                attribute_option_id: None,
                clear_attribute_option: None,
                activity_time: None,
                is_pinned: None,
                is_expanded: None,
                status_option_id: None,
            })
            .unwrap();

        assert_eq!(updated.brief_markdown, "## 当前背景\n- 已完成范围澄清");
        assert_eq!(
            updated.brief_html,
            "<h2>当前背景</h2><ul><li>已完成范围澄清</li></ul>"
        );

        let renamed = database
            .activity_update_meta(ActivityUpdateMetaInput {
                activity_id: activity.id,
                title: Some("Kickoff Review".to_string()),
                brief_markdown: None,
                brief_html: None,
                attribute_option_id: None,
                clear_attribute_option: None,
                activity_time: None,
                is_pinned: None,
                is_expanded: None,
                status_option_id: None,
            })
            .unwrap();

        assert_eq!(renamed.title, "Kickoff Review");
        assert_eq!(renamed.brief_markdown, updated.brief_markdown);
        assert_eq!(renamed.brief_html, updated.brief_html);
    }

    #[test]
    fn activity_create_assigns_unique_default_title_when_blank() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);

        let created = database
            .activity_create(ActivityCreateInput {
                project_id: project.id,
                attribute_option_id: None,
                title: Some("   ".to_string()),
                activity_time: "2026-04-06T10:00:00.000Z".to_string(),
            })
            .unwrap();

        assert_eq!(created.title, format!("未命名 Activity {}", created.id));
    }

    #[test]
    fn activity_update_meta_assigns_unique_default_title_when_cleared() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");

        let updated = database
            .activity_update_meta(ActivityUpdateMetaInput {
                activity_id: activity.id,
                title: Some("   ".to_string()),
                brief_markdown: None,
                brief_html: None,
                attribute_option_id: None,
                clear_attribute_option: None,
                activity_time: None,
                is_pinned: None,
                is_expanded: None,
                status_option_id: None,
            })
            .unwrap();

        assert_eq!(updated.title, format!("未命名 Activity {}", activity.id));
    }

    #[test]
    fn activity_delete_removes_related_notes_conclusions_todos_and_documents() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");

        let note = create_note(
            &mut database,
            project.id,
            activity.id,
            "quick_note",
            "范围确认记录",
        );
        let conclusion = database
            .conclusion_create(ConclusionCreateInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                note_id: Some(note.id),
                markdown: "已确认第一阶段交付范围".to_string(),
                html: "<p>已确认第一阶段交付范围</p>".to_string(),
                promoted_to_project: true,
                is_pinned: None,
            })
            .unwrap();
        let todo = create_todo(
            &mut database,
            project.id,
            Some(activity.id),
            "同步第一阶段排期",
            "not_urgent_important",
        );

        let activity_source = harness.root.join("kickoff-brief.pdf");
        fs::write(&activity_source, b"brief").unwrap();
        let activity_document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                source_path: activity_source.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();

        let root_source = harness.root.join("root-overview.pdf");
        fs::write(&root_source, b"root").unwrap();
        let root_document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: None,
                source_path: root_source.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();

        let note_image = database
            .document_import_clipboard_note_image(DocumentImportClipboardNoteImageInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                file_name: "kickoff-inline.png".to_string(),
                mime_type: "image/png".to_string(),
                data_base64: STANDARD.encode("inline-image"),
            })
            .unwrap();

        let activity_dir = PathBuf::from(&activity_document.managed_path)
            .parent()
            .unwrap()
            .to_path_buf();
        let note_asset_dir = PathBuf::from(&note_image.managed_path)
            .parent()
            .unwrap()
            .to_path_buf();

        let deleted = database
            .activity_delete(ActivityDeleteInput {
                activity_id: activity.id,
            })
            .unwrap();

        assert_eq!(deleted.id, activity.id);
        assert_eq!(deleted.project_id, project.id);
        assert!(database.activity_card(activity.id).is_err());
        assert!(database.note_record(note.id).is_err());
        assert!(database.conclusion_record(conclusion.id).is_err());
        assert!(database.todo_record(todo.id).is_err());
        assert!(database.document_record(activity_document.id).is_err());
        assert!(database.document_record(note_image.id).is_err());
        assert!(database.document_record(root_document.id).is_ok());
        assert!(!Path::new(&activity_document.managed_path).exists());
        assert!(!activity_dir.exists());
        assert!(!note_asset_dir.exists());
        assert_eq!(database.activity_list(ProjectIdInput { project_id: project.id }).unwrap().len(), 0);
        assert_eq!(
            database
                .fetch_documents_for_project(project.id, false)
                .unwrap()
                .into_iter()
                .map(|document| document.id)
                .collect::<Vec<_>>(),
            vec![root_document.id]
        );
    }

    #[test]
    fn system_activity_status_can_be_edited_and_remains_non_deletable() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let pending_status = database
            .activity_settings_get()
            .unwrap()
            .activity_status_options
            .into_iter()
            .find(|option| option.is_system)
            .unwrap();

        let updated = database
            .activity_status_option_upsert(ActivityStatusOptionUpsertInput {
                id: Some(pending_status.id),
                label: "待排期".to_string(),
                color_key: "green".to_string(),
            })
            .unwrap();

        assert!(updated.is_system);
        assert_eq!(updated.label, "待排期");
        assert_eq!(updated.color_key, "green");
        assert!(!updated.needs_attention);

        let activity = database
            .activity_create(ActivityCreateInput {
                project_id: project.id,
                attribute_option_id: None,
                title: Some("合同同步".to_string()),
                activity_time: "2026-04-06T10:00:00.000Z".to_string(),
            })
            .unwrap();
        let refreshed = database.activity_card(activity.id).unwrap();

        assert_eq!(refreshed.status_label, "待排期");
        assert_eq!(refreshed.status_color_key, "green");
        assert!(!refreshed.status_needs_attention);
        assert!(database
            .activity_status_option_delete(ActivityOptionDeleteInput {
                option_id: pending_status.id,
            })
            .is_err());
    }

    #[test]
    fn rich_text_style_get_returns_defaults_when_absent() {
        let (_harness, mut database) = setup_database();

        let settings = database.rich_text_style_get().unwrap();

        assert_eq!(settings.body.font_family.source, "preset");
        assert_eq!(settings.body.font_family.value, "workspace_sans");
        assert_eq!(settings.body.font_size_px, 14);
        assert_eq!(settings.body.line_height, 1.6);
        assert_eq!(settings.body.paragraph_spacing_before_px, 12);
        assert_eq!(settings.body.paragraph_spacing_after_px, 0);
        assert_eq!(settings.headings.h1_size_px, 24);
        assert_eq!(settings.headings.h2_size_px, 20);
        assert_eq!(settings.headings.h3_size_px, 16);
        assert_eq!(settings.list.font_family.value, "workspace_sans");
    }

    #[test]
    fn rich_text_style_upsert_round_trips_saved_values() {
        let (_harness, mut database) = setup_database();

        let saved = database
            .rich_text_style_upsert(RichTextStyleSettings {
                body: RichTextStyleBlockSettings {
                    font_family: RichTextFontSelection {
                        source: "preset".to_string(),
                        value: "work_sans".to_string(),
                    },
                    font_size_px: 15,
                    line_height: 1.7,
                    paragraph_spacing_before_px: 14,
                    paragraph_spacing_after_px: 2,
                },
                headings: crate::models::RichTextHeadingStyleSettings {
                    font_family: RichTextFontSelection {
                        source: "system".to_string(),
                        value: "SF Pro Text".to_string(),
                    },
                    line_height: 1.3,
                    paragraph_spacing_before_px: 10,
                    paragraph_spacing_after_px: 4,
                    h1_size_px: 28,
                    h2_size_px: 22,
                    h3_size_px: 18,
                },
                list: RichTextStyleBlockSettings {
                    font_family: RichTextFontSelection {
                        source: "preset".to_string(),
                        value: "noto_sans_sc".to_string(),
                    },
                    font_size_px: 15,
                    line_height: 1.65,
                    paragraph_spacing_before_px: 10,
                    paragraph_spacing_after_px: 3,
                },
            })
            .unwrap();
        let loaded = database.rich_text_style_get().unwrap();

        assert_eq!(loaded.body.font_family.value, "work_sans");
        assert_eq!(loaded.body.font_size_px, 15);
        assert_eq!(loaded.headings.font_family.source, "system");
        assert_eq!(loaded.headings.font_family.value, "SF Pro Text");
        assert_eq!(loaded.headings.h1_size_px, 28);
        assert_eq!(loaded.list.font_family.value, "noto_sans_sc");
        assert_eq!(loaded.list.paragraph_spacing_before_px, 10);
        assert_eq!(loaded.list.paragraph_spacing_after_px, 3);
        assert_eq!(style_json_signature(&loaded), style_json_signature(&saved));
    }

    #[test]
    fn rich_text_style_get_normalizes_legacy_paragraph_spacing() {
        let (_harness, mut database) = setup_database();

        database
            .conn
            .execute(
                "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)",
                params![
                    APP_SETTING_KEY_RICH_TEXT_STYLE,
                    json!({
                        "body": {
                            "fontPreset": "workspace_sans",
                            "fontSizePx": 14,
                            "lineHeight": 1.6,
                            "paragraphSpacingPx": 12
                        },
                        "headings": {
                            "fontPreset": "workspace_sans",
                            "lineHeight": 1.35,
                            "paragraphSpacingPx": 10,
                            "h1SizePx": 24,
                            "h2SizePx": 20,
                            "h3SizePx": 16
                        },
                        "list": {
                            "fontPreset": "workspace_sans",
                            "fontSizePx": 14,
                            "lineHeight": 1.6,
                            "paragraphSpacingPx": 8
                        }
                    })
                    .to_string(),
                    now_iso()
                ],
            )
            .unwrap();

        let settings = database.rich_text_style_get().unwrap();

        assert_eq!(settings.body.font_family.value, "workspace_sans");
        assert_eq!(settings.body.paragraph_spacing_before_px, 12);
        assert_eq!(settings.body.paragraph_spacing_after_px, 0);
        assert_eq!(settings.headings.font_family.value, "workspace_sans");
        assert_eq!(settings.headings.paragraph_spacing_before_px, 10);
        assert_eq!(settings.headings.paragraph_spacing_after_px, 0);
        assert_eq!(settings.list.font_family.value, "workspace_sans");
        assert_eq!(settings.list.paragraph_spacing_before_px, 8);
        assert_eq!(settings.list.paragraph_spacing_after_px, 0);
    }

    #[test]
    fn migration_adds_app_settings_without_affecting_ai_profiles() {
        let unique = next_test_unique();
        let root = std::env::temp_dir().join(format!("project-mind-db-legacy-{unique}"));
        fs::create_dir_all(&root).unwrap();
        let db_path = root.join("app.sqlite3");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE ai_provider_profiles (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              provider_family TEXT NOT NULL,
              base_url TEXT NOT NULL,
              api_key_ciphertext TEXT NOT NULL,
              api_key_nonce TEXT NOT NULL,
              api_key_salt TEXT NOT NULL,
              api_key_last4 TEXT NOT NULL DEFAULT '',
              default_model TEXT NOT NULL,
              supports_text INTEGER NOT NULL DEFAULT 1,
              supports_image INTEGER NOT NULL DEFAULT 0,
              supports_file INTEGER NOT NULL DEFAULT 0,
              enabled INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE ai_capability_bindings (
              capability TEXT PRIMARY KEY,
              use_default INTEGER NOT NULL DEFAULT 1,
              profile_id INTEGER,
              model TEXT,
              updated_at TEXT NOT NULL
            );
            "#,
        )
        .unwrap();
        conn.execute(
            r#"
            INSERT INTO ai_provider_profiles (
              name, provider_family, base_url, api_key_ciphertext, api_key_nonce, api_key_salt,
              api_key_last4, default_model, supports_text, supports_image, supports_file, enabled,
              created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, 0, 0, 1, ?9, ?10)
            "#,
            params![
                "Legacy AI",
                "openai_compatible",
                "https://api.openai.com/v1",
                "cipher",
                "nonce",
                "salt",
                "1234",
                "gpt-4.1-mini",
                "2026-04-06T08:00:00.000Z",
                "2026-04-06T08:00:00.000Z",
            ],
        )
        .unwrap();
        drop(conn);

        let workspace_root = root.join("workspace");
        fs::create_dir_all(&workspace_root).unwrap();
        let mut database =
            Database::open(&db_path, &workspace_root, Some("test-secret".to_string())).unwrap();
        let ai_settings = database.ai_settings_get().unwrap();
        let rich_text = database.rich_text_style_get().unwrap();

        assert_eq!(ai_settings.profiles.len(), 1);
        assert_eq!(ai_settings.profiles[0].name, "Legacy AI");
        assert_eq!(ai_settings.feature_settings, default_ai_feature_settings());
        assert_eq!(rich_text.headings.h2_size_px, 20);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn document_import_moves_project_file_into_activity_folder() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");

        let source_path = PathBuf::from(&project.root_path).join("brief.pdf");
        fs::write(&source_path, b"brief").unwrap();

        let document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                source_path: source_path.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();

        assert!(!source_path.exists());
        assert!(Path::new(&document.managed_path).exists());
        assert!(document.managed_path.contains("Kickoff"));
        assert_eq!(document.base_name, "brief.pdf");
        assert_eq!(document.version_count, 1);
    }

    #[test]
    fn note_image_import_copies_source_into_hidden_project_folder() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");

        let source_path = PathBuf::from(&project.root_path).join("cover.png");
        fs::write(&source_path, b"cover-image").unwrap();

        let document = database
            .document_import_note_image(DocumentImportNoteImageInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                source_path: source_path.to_string_lossy().to_string(),
            })
            .unwrap();

        assert!(source_path.exists());
        assert!(Path::new(&document.managed_path).exists());
        assert_eq!(fs::read(&source_path).unwrap(), b"cover-image");
        assert_eq!(fs::read(&document.managed_path).unwrap(), b"cover-image");
        assert_eq!(document.storage_mode, MANAGED_NOTE_IMAGE_STORAGE_MODE);
        assert!(document
            .managed_path
            .contains(".project-mind/embedded-note-assets/activity-"));
        assert!(!document.managed_path.contains("/Kickoff/"));
    }

    #[test]
    fn note_image_imports_are_hidden_from_activity_and_project_document_queries() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");

        let image_source = harness.root.join("embedded-diagram.png");
        fs::write(&image_source, b"embedded-image").unwrap();
        let hidden_document = database
            .document_import_note_image(DocumentImportNoteImageInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                source_path: image_source.to_string_lossy().to_string(),
            })
            .unwrap();

        let visible_source = harness.root.join("brief.pdf");
        fs::write(&visible_source, b"brief").unwrap();
        let visible_document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                source_path: visible_source.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();

        let root_source = harness.root.join("root-doc.pdf");
        fs::write(&root_source, b"root").unwrap();
        let root_document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: None,
                source_path: root_source.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();

        let activity_documents = database.fetch_documents(activity.id).unwrap();
        let all_project_documents = database
            .fetch_documents_for_project(project.id, false)
            .unwrap();
        let project_documents = database
            .fetch_project_documents_for_project(project.id)
            .unwrap();
        let activity_card = database.activity_card(activity.id).unwrap();
        let search_results = database
            .workspace_search(WorkspaceSearchInput {
                query: "embedded-diagram".to_string(),
                include_archived: None,
            })
            .unwrap();

        assert_eq!(
            activity_documents
                .iter()
                .map(|document| document.id)
                .collect::<Vec<_>>(),
            vec![visible_document.id]
        );
        assert_eq!(all_project_documents.len(), 2);
        assert!(all_project_documents
            .iter()
            .any(|document| document.id == visible_document.id));
        assert!(all_project_documents
            .iter()
            .any(|document| document.id == root_document.id));
        assert_eq!(project_documents.len(), 1);
        assert_eq!(project_documents[0].id, root_document.id);
        assert_eq!(activity_card.digest.document_count, 1);
        assert!(!activity_card
            .documents
            .iter()
            .any(|document| document.id == hidden_document.id));
        assert!(!search_results
            .iter()
            .any(|result| result.id == hidden_document.id));
    }

    #[test]
    fn internal_reference_search_supports_scope_and_all_supported_kinds() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");
        let other_project = database
            .project_create(ProjectCreateInput {
                name: "Beta".to_string(),
                summary: None,
                status: None,
            })
            .unwrap();
        let other_activity = create_activity(&mut database, other_project.id, "Retro");

        let note = create_note(
            &mut database,
            project.id,
            activity.id,
            "quick_note",
            "预算讨论纪要",
        );
        let conclusion = database
            .conclusion_create(ConclusionCreateInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                note_id: Some(note.id),
                markdown: "已确认预算审批路径".to_string(),
                html: "<p>已确认预算审批路径</p>".to_string(),
                promoted_to_project: false,
                is_pinned: None,
            })
            .unwrap();
        let todo = create_todo(
            &mut database,
            project.id,
            Some(activity.id),
            "推进预算审批",
            "not_urgent_important",
        );
        let document_source = harness.root.join("project-brief.pdf");
        fs::write(&document_source, b"brief").unwrap();
        let document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                source_path: document_source.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        let other_todo = create_todo(
            &mut database,
            other_project.id,
            Some(other_activity.id),
            "跨项目事项",
            "not_urgent_important",
        );

        let project_results = database
            .internal_reference_search(InternalReferenceSearchInput {
                query: "".to_string(),
                project_id: Some(project.id),
                scope: "project".to_string(),
                limit: 20,
            })
            .unwrap();
        let workspace_results = database
            .internal_reference_search(InternalReferenceSearchInput {
                query: "".to_string(),
                project_id: None,
                scope: "workspace".to_string(),
                limit: 20,
            })
            .unwrap();

        assert!(project_results
            .iter()
            .any(|result| result.kind == "note" && result.id == note.id));
        assert!(project_results
            .iter()
            .any(|result| result.kind == "conclusion" && result.id == conclusion.id));
        assert!(project_results
            .iter()
            .any(|result| result.kind == "todo" && result.id == todo.id));
        assert!(project_results
            .iter()
            .any(|result| result.kind == "document" && result.id == document.id));
        assert!(!project_results.iter().any(|result| result.id == other_todo.id));
        assert!(workspace_results
            .iter()
            .any(|result| result.kind == "todo" && result.id == other_todo.id));
    }

    #[test]
    fn workspace_search_prioritizes_fields_match_strength_and_notes() {
        let (harness, mut database) = setup_database();
        let project_exact = create_project_named(&mut database, &harness.workspace_root, "预算", None);
        let project_prefix =
            create_project_named(&mut database, &harness.workspace_root, "预算平台", None);
        let project_contains =
            create_project_named(&mut database, &harness.workspace_root, "推进预算系统", None);
        let project_summary =
            create_project_named(&mut database, &harness.workspace_root, "Alpha", Some("预算摘要"));

        let activity = create_activity(&mut database, project_exact.id, "预算");
        let note = create_note_with_title(
            &mut database,
            project_exact.id,
            activity.id,
            "quick_note",
            "预算",
            "标题精确匹配",
        );
        let note_body = create_note_with_title(
            &mut database,
            project_exact.id,
            activity.id,
            "quick_note",
            "正文记录",
            "预算只写在正文里",
        );
        let conclusion = database
            .conclusion_create(ConclusionCreateInput {
                project_id: project_exact.id,
                activity_id: Some(activity.id),
                note_id: Some(note.id),
                markdown: "预算结论已确认".to_string(),
                html: "<p>预算结论已确认</p>".to_string(),
                promoted_to_project: false,
                is_pinned: None,
            })
            .unwrap();
        let todo = create_todo(
            &mut database,
            project_exact.id,
            Some(activity.id),
            "预算待办推进",
            "not_urgent_important",
        );
        let document_source = harness.root.join("预算材料.pdf");
        fs::write(&document_source, b"budget-doc").unwrap();
        let document = database
            .document_import(DocumentImportInput {
                project_id: project_exact.id,
                activity_id: Some(activity.id),
                source_path: document_source.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();

        let results = database
            .workspace_search(WorkspaceSearchInput {
                query: "预算".to_string(),
                include_archived: Some(true),
            })
            .unwrap();

        let ordered = results
            .iter()
            .map(|result| (result.kind.as_str(), result.id))
            .collect::<Vec<_>>();

        assert_eq!(
            ordered,
            vec![
                ("project", project_exact.id),
                ("project", project_prefix.id),
                ("project", project_contains.id),
                ("activity", activity.id),
                ("note", note.id),
                ("conclusion", conclusion.id),
                ("todo", todo.id),
                ("document", document.id),
                ("note", note_body.id),
                ("project", project_summary.id),
            ]
        );
    }

    #[test]
    fn internal_reference_search_prioritizes_fields_and_match_strength() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");
        let activity_only = create_activity(&mut database, project.id, "预算复盘");

        let note_exact = create_note_with_title(
            &mut database,
            project.id,
            activity.id,
            "quick_note",
            "预算",
            "完全匹配标题",
        );
        let note_prefix = create_note_with_title(
            &mut database,
            project.id,
            activity.id,
            "quick_note",
            "预算审批排期",
            "前缀匹配标题",
        );
        let note_contains = create_note_with_title(
            &mut database,
            project.id,
            activity.id,
            "quick_note",
            "推进预算审批",
            "包含匹配标题",
        );
        let conclusion = database
            .conclusion_create(ConclusionCreateInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                note_id: Some(note_exact.id),
                markdown: "预算结论已确认".to_string(),
                html: "<p>预算结论已确认</p>".to_string(),
                promoted_to_project: false,
                is_pinned: None,
            })
            .unwrap();
        let todo = create_todo(
            &mut database,
            project.id,
            Some(activity.id),
            "预算待办推进",
            "not_urgent_important",
        );
        let document_source = harness.root.join("预算材料.pdf");
        fs::write(&document_source, b"budget-doc").unwrap();
        let document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                source_path: document_source.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        let note_body = create_note_with_title(
            &mut database,
            project.id,
            activity.id,
            "quick_note",
            "正文记录",
            "预算只写在正文里",
        );
        let todo_activity_only = create_todo(
            &mut database,
            project.id,
            Some(activity_only.id),
            "无关内容",
            "not_urgent_important",
        );

        let results = database
            .internal_reference_search(InternalReferenceSearchInput {
                query: "预算".to_string(),
                project_id: Some(project.id),
                scope: "project".to_string(),
                limit: 16,
            })
            .unwrap();

        let ordered = results
            .iter()
            .map(|result| (result.kind.as_str(), result.id))
            .collect::<Vec<_>>();

        assert_eq!(
            ordered,
            vec![
                ("note", note_exact.id),
                ("note", note_prefix.id),
                ("note", note_contains.id),
                ("conclusion", conclusion.id),
                ("todo", todo.id),
                ("document", document.id),
                ("note", note_body.id),
                ("todo", todo_activity_only.id),
            ]
        );
    }

    #[test]
    fn internal_reference_search_supports_type_prefix_aliases_and_empty_queries() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");

        let note = create_note_with_title(
            &mut database,
            project.id,
            activity.id,
            "quick_note",
            "审批记录",
            "记录正文",
        );
        let conclusion = database
            .conclusion_create(ConclusionCreateInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                note_id: Some(note.id),
                markdown: "审批结论".to_string(),
                html: "<p>审批结论</p>".to_string(),
                promoted_to_project: false,
                is_pinned: None,
            })
            .unwrap();
        let todo = create_todo(
            &mut database,
            project.id,
            Some(activity.id),
            "审批待办",
            "not_urgent_important",
        );
        let todo_recent = create_todo(
            &mut database,
            project.id,
            Some(activity.id),
            "后续跟进",
            "not_urgent_important",
        );
        let document_source = harness.root.join("审批材料.pdf");
        fs::write(&document_source, b"approval-doc").unwrap();
        let document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                source_path: document_source.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();

        database
            .todo_update_content(TodoUpdateContentInput {
                todo_id: todo_recent.id,
                content: "后续跟进".to_string(),
            })
            .unwrap();

        let note_results = database
            .internal_reference_search(InternalReferenceSearchInput {
                query: "note:审批".to_string(),
                project_id: Some(project.id),
                scope: "project".to_string(),
                limit: 16,
            })
            .unwrap();
        assert_eq!(
            note_results
                .iter()
                .map(|result| result.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["note"]
        );
        assert_eq!(note_results[0].id, note.id);

        let todo_results = database
            .internal_reference_search(InternalReferenceSearchInput {
                query: "todo：审批".to_string(),
                project_id: Some(project.id),
                scope: "project".to_string(),
                limit: 16,
            })
            .unwrap();
        assert_eq!(
            todo_results
                .iter()
                .map(|result| result.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["todo"]
        );
        assert_eq!(todo_results[0].id, todo.id);

        let conclusion_results = database
            .internal_reference_search(InternalReferenceSearchInput {
                query: "con:审批".to_string(),
                project_id: Some(project.id),
                scope: "project".to_string(),
                limit: 16,
            })
            .unwrap();
        assert_eq!(
            conclusion_results
                .iter()
                .map(|result| result.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["conclusion"]
        );
        assert_eq!(conclusion_results[0].id, conclusion.id);

        let document_results = database
            .internal_reference_search(InternalReferenceSearchInput {
                query: "doc:审批".to_string(),
                project_id: Some(project.id),
                scope: "project".to_string(),
                limit: 16,
            })
            .unwrap();
        assert_eq!(
            document_results
                .iter()
                .map(|result| result.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["document"]
        );
        assert_eq!(document_results[0].id, document.id);

        let empty_todo_results = database
            .internal_reference_search(InternalReferenceSearchInput {
                query: "todo:".to_string(),
                project_id: Some(project.id),
                scope: "project".to_string(),
                limit: 16,
            })
            .unwrap();
        assert!(empty_todo_results.iter().all(|result| result.kind == "todo"));
        assert_eq!(empty_todo_results[0].id, todo_recent.id);

        let invalid_prefix_results = database
            .internal_reference_search(InternalReferenceSearchInput {
                query: "abc:审批".to_string(),
                project_id: Some(project.id),
                scope: "project".to_string(),
                limit: 16,
            })
            .unwrap();
        assert!(invalid_prefix_results.is_empty());
    }

    #[test]
    fn internal_reference_labels_compact_todo_and_conclusion_content() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");
        let note = create_note_with_title(
            &mut database,
            project.id,
            activity.id,
            "quick_note",
            "预算记录",
            "讨论正文",
        );

        let conclusion = database
            .conclusion_create(ConclusionCreateInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                note_id: Some(note.id),
                markdown: "[[note:1|预算记录]] 预算审批需要补充材料并确认时间安排".to_string(),
                html: "<p>[[note:1|预算记录]] 预算审批需要补充材料并确认时间安排</p>"
                    .to_string(),
                promoted_to_project: false,
                is_pinned: None,
            })
            .unwrap();
        let todo = create_todo(
            &mut database,
            project.id,
            Some(activity.id),
            "[[document:2|预算材料.pdf]] 联系财务安排评审并确认后续计划时间",
            "not_urgent_important",
        );

        let results = database
            .internal_reference_search(InternalReferenceSearchInput {
                query: "安排".to_string(),
                project_id: Some(project.id),
                scope: "project".to_string(),
                limit: 16,
            })
            .unwrap();
        let conclusion_result = results
            .iter()
            .find(|result| result.kind == "conclusion" && result.id == conclusion.id)
            .unwrap();
        let todo_result = results
            .iter()
            .find(|result| result.kind == "todo" && result.id == todo.id)
            .unwrap();

        assert_eq!(conclusion_result.label, "预算审批需要补充材料并确认时间...");
        assert!(!conclusion_result.label.contains("[["));
        assert_eq!(todo_result.label, "联系财务安排评审并确认后续计划...");
        assert!(!todo_result.label.contains("[["));

        let resolved_conclusion = database
            .internal_reference_resolve(InternalReferenceResolveInput {
                kind: "conclusion".to_string(),
                id: conclusion.id,
            })
            .unwrap()
            .unwrap();
        let resolved_todo = database
            .internal_reference_resolve(InternalReferenceResolveInput {
                kind: "todo".to_string(),
                id: todo.id,
            })
            .unwrap()
            .unwrap();

        assert_eq!(resolved_conclusion.label, "预算审批需要补充材料并确认时间...");
        assert!(!resolved_conclusion.label.contains("[["));
        assert_eq!(resolved_todo.label, "联系财务安排评审并确认后续计划...");
        assert!(!resolved_todo.label.contains("[["));
    }

    #[test]
    fn internal_reference_resolve_returns_current_routes_after_todo_and_document_moves() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");
        let next_activity = create_activity(&mut database, project.id, "Delivery");
        let note = create_note(
            &mut database,
            project.id,
            activity.id,
            "quick_note",
            "预算讨论纪要",
        );
        let conclusion = database
            .conclusion_create(ConclusionCreateInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                note_id: Some(note.id),
                markdown: "已确认预算审批路径".to_string(),
                html: "<p>已确认预算审批路径</p>".to_string(),
                promoted_to_project: false,
                is_pinned: None,
            })
            .unwrap();
        let todo = create_todo(
            &mut database,
            project.id,
            Some(activity.id),
            "推进预算审批",
            "not_urgent_important",
        );
        let document_source = harness.root.join("delivery-brief.pdf");
        fs::write(&document_source, b"brief").unwrap();
        let document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                source_path: document_source.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();

        database
            .todo_update_activity(TodoUpdateActivityInput {
                todo_id: todo.id,
                activity_id: Some(next_activity.id),
            })
            .unwrap();
        database
            .document_update_meta(DocumentUpdateMetaInput {
                document_id: document.id,
                activity_id: Some(Some(next_activity.id)),
                base_name: None,
                is_starred: None,
                tag_ids: None,
            })
            .unwrap();

        let resolved_note = database
            .internal_reference_resolve(InternalReferenceResolveInput {
                kind: "note".to_string(),
                id: note.id,
            })
            .unwrap()
            .unwrap();
        let resolved_conclusion = database
            .internal_reference_resolve(InternalReferenceResolveInput {
                kind: "conclusion".to_string(),
                id: conclusion.id,
            })
            .unwrap()
            .unwrap();
        let resolved_todo = database
            .internal_reference_resolve(InternalReferenceResolveInput {
                kind: "todo".to_string(),
                id: todo.id,
            })
            .unwrap()
            .unwrap();
        let resolved_document = database
            .internal_reference_resolve(InternalReferenceResolveInput {
                kind: "document".to_string(),
                id: document.id,
            })
            .unwrap()
            .unwrap();

        assert_eq!(
            resolved_note.route,
            format!(
                "/projects/{}/activities/{}/notes/{}",
                project.id, activity.id, note.id
            )
        );
        assert_eq!(
            resolved_conclusion.route,
            format!(
                "/projects/{}/activities/{}?focus=conclusion-{}",
                project.id, activity.id, conclusion.id
            )
        );
        assert_eq!(
            resolved_todo.route,
            format!(
                "/projects/{}/activities/{}?focus=todo-{}",
                project.id, next_activity.id, todo.id
            )
        );
        assert_eq!(
            resolved_document.route,
            format!(
                "/projects/{}/activities/{}?focus=document-{}",
                project.id, next_activity.id, document.id
            )
        );
    }

    #[test]
    fn clipboard_note_image_import_uses_hidden_folder_and_internal_storage_mode() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");

        let document = database
            .document_import_clipboard_note_image(DocumentImportClipboardNoteImageInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                file_name: "clipboard-image.png".to_string(),
                mime_type: "image/png".to_string(),
                data_base64: STANDARD.encode("clipboard-note-image"),
            })
            .unwrap();

        assert!(Path::new(&document.managed_path).exists());
        assert_eq!(
            fs::read(&document.managed_path).unwrap(),
            b"clipboard-note-image"
        );
        assert_eq!(document.storage_mode, MANAGED_NOTE_IMAGE_STORAGE_MODE);
        assert!(document
            .managed_path
            .contains(".project-mind/embedded-note-assets/activity-"));
        assert!(database.fetch_documents(activity.id).unwrap().is_empty());
    }

    #[test]
    fn clipboard_note_image_import_preserves_heic_extension_when_name_is_blank() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");

        let document = database
            .document_import_clipboard_note_image(DocumentImportClipboardNoteImageInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                file_name: "".to_string(),
                mime_type: "image/heic".to_string(),
                data_base64: STANDARD.encode("clipboard-note-image"),
            })
            .unwrap();

        assert!(Path::new(&document.managed_path).exists());
        assert_eq!(fs::read(&document.managed_path).unwrap(), b"clipboard-note-image");
        assert!(document.name.ends_with(".heic"));
        assert!(document.managed_path.ends_with(".heic"));
    }

    #[test]
    fn activity_rename_moves_folder_and_document_paths() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");

        let source_path = harness.root.join("agenda.pdf");
        fs::write(&source_path, b"agenda").unwrap();
        let document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                source_path: source_path.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        let document_href = file_href_from_path(Path::new(&document.managed_path));
        let rich_html = format!(
            concat!(
                r#"<div data-type="attachment" data-path="{document_path}" data-href="{document_href}">"#,
                r#"<a class="rich-editor__attachment-link" href="{document_href}">agenda</a></div>"#
            ),
            document_path = document.managed_path,
            document_href = document_href,
        );
        let note = database
            .note_upsert(NoteUpsertInput {
                project_id: project.id,
                activity_id: activity.id,
                note_id: None,
                note_type: DEFAULT_RECORD_TYPE_KEY.to_string(),
                title: Some("活动附件记录".to_string()),
                markdown: "[附件] agenda".to_string(),
                html: rich_html.clone(),
            })
            .unwrap();
        let conclusion = database
            .conclusion_create(ConclusionCreateInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                note_id: Some(note.id),
                markdown: "[附件] agenda".to_string(),
                html: rich_html,
                promoted_to_project: false,
                is_pinned: None,
            })
            .unwrap();

        let old_folder = PathBuf::from(&project.root_path).join("Kickoff");
        let updated_activity = database
            .activity_update_meta(ActivityUpdateMetaInput {
                activity_id: activity.id,
                title: Some("Review Final".to_string()),
                brief_markdown: None,
                brief_html: None,
                attribute_option_id: None,
                clear_attribute_option: None,
                activity_time: None,
                is_pinned: None,
                is_expanded: None,
                status_option_id: None,
            })
            .unwrap();
        let updated_document = database.document_record(document.id).unwrap();
        let saved_note = database.note_record(note.id).unwrap();
        let saved_conclusion = database.conclusion_record(conclusion.id).unwrap();

        assert_eq!(updated_activity.title, "Review Final");
        assert!(!old_folder.exists());
        assert!(updated_document.managed_path.contains("Review Final"));
        assert!(Path::new(&updated_document.managed_path).exists());
        assert!(saved_note
            .content_html
            .contains(&updated_document.managed_path));
        assert!(saved_note
            .content_html
            .contains(&file_href_from_path(Path::new(
                &updated_document.managed_path
            ))));
        assert!(!saved_note.content_html.contains("/Kickoff/"));
        assert!(saved_conclusion
            .content_html
            .contains(&updated_document.managed_path));
        assert!(!saved_conclusion.content_html.contains("/Kickoff/"));
    }

    #[test]
    fn activity_rename_fails_when_target_folder_already_exists_without_mutating_state() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");
        let old_folder = PathBuf::from(&project.root_path).join("Kickoff");
        let conflicting_folder = PathBuf::from(&project.root_path).join("Review Final");
        fs::create_dir_all(&conflicting_folder).unwrap();

        let error = database
            .activity_update_meta(ActivityUpdateMetaInput {
                activity_id: activity.id,
                title: Some("Review Final".to_string()),
                brief_markdown: None,
                brief_html: None,
                attribute_option_id: None,
                clear_attribute_option: None,
                activity_time: None,
                is_pinned: None,
                is_expanded: None,
                status_option_id: None,
            })
            .unwrap_err();

        assert!(error.to_string().contains("文件夹名称已被占用"));
        assert!(old_folder.exists());
        assert!(conflicting_folder.exists());
        let refreshed = database.activity_card(activity.id).unwrap();
        assert_eq!(refreshed.title, "Kickoff");
    }

    #[test]
    fn document_add_version_moves_previous_current_into_history_dir() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);

        let source_v1 = harness.root.join("proposal-v1-source.pdf");
        fs::write(&source_v1, b"version1").unwrap();
        let document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: None,
                source_path: source_v1.to_string_lossy().to_string(),
                is_starred: true,
                tag_ids: None,
            })
            .unwrap();

        let source_v2 = harness.root.join("proposal-v2-source.pdf");
        fs::write(&source_v2, b"version2").unwrap();
        let versioned_document = database
            .document_add_version(DocumentAddVersionInput {
                document_id: document.id,
                source_path: Some(source_v2.to_string_lossy().to_string()),
            })
            .unwrap();
        let versions = database
            .document_list_versions(DocumentListVersionsInput {
                document_id: document.id,
            })
            .unwrap();
        let history_path =
            PathBuf::from(&versioned_document.history_dir_path).join("proposal-v1-source.pdf");

        assert_eq!(versioned_document.current_version_number, 2);
        assert_eq!(versioned_document.name, "proposal-v1-source_v2.pdf");
        assert!(Path::new(&versioned_document.managed_path).exists());
        assert!(history_path.exists());
        assert_eq!(
            versions
                .iter()
                .map(|version| version.version_number)
                .collect::<Vec<_>>(),
            vec![2, 1]
        );
    }

    #[test]
    fn document_add_version_without_source_path_duplicates_current_version() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);

        let source_v1 = harness.root.join("proposal-v1-source.pdf");
        fs::write(&source_v1, b"version1").unwrap();
        let document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: None,
                source_path: source_v1.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        let original_path = document.original_path.clone();

        let versioned_document = database
            .document_add_version(DocumentAddVersionInput {
                document_id: document.id,
                source_path: None,
            })
            .unwrap();
        let versions = database
            .document_list_versions(DocumentListVersionsInput {
                document_id: document.id,
            })
            .unwrap();
        let history_path =
            PathBuf::from(&versioned_document.history_dir_path).join("proposal-v1-source.pdf");

        assert_eq!(versioned_document.current_version_number, 2);
        assert_eq!(versioned_document.version_count, 2);
        assert_eq!(versioned_document.original_path, original_path);
        assert_eq!(versioned_document.name, "proposal-v1-source_v2.pdf");
        assert!(Path::new(&versioned_document.managed_path).exists());
        assert!(history_path.exists());
        assert_eq!(
            fs::read(&versioned_document.managed_path).unwrap(),
            b"version1"
        );
        assert_eq!(versions[0].source_path, original_path);
        assert_eq!(versions[1].source_path, original_path);
    }

    #[test]
    fn document_rename_updates_current_and_history_file_names() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);

        let source_v1 = harness.root.join("brief-source.pdf");
        fs::write(&source_v1, b"version1").unwrap();
        let document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: None,
                source_path: source_v1.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();

        let source_v2 = harness.root.join("brief-source-v2.pdf");
        fs::write(&source_v2, b"version2").unwrap();
        let versioned_document = database
            .document_add_version(DocumentAddVersionInput {
                document_id: document.id,
                source_path: Some(source_v2.to_string_lossy().to_string()),
            })
            .unwrap();

        let renamed_document = database
            .document_update_meta(DocumentUpdateMetaInput {
                document_id: document.id,
                activity_id: None,
                base_name: Some("final-summary.pdf".to_string()),
                is_starred: None,
                tag_ids: None,
            })
            .unwrap();
        let versions = database
            .document_list_versions(DocumentListVersionsInput {
                document_id: document.id,
            })
            .unwrap();

        let history_v1 =
            PathBuf::from(&renamed_document.history_dir_path).join("final-summary.pdf");

        assert_eq!(versioned_document.current_version_number, 2);
        assert_eq!(renamed_document.base_name, "final-summary.pdf");
        assert_eq!(renamed_document.name, "final-summary_v2.pdf");
        assert!(Path::new(&renamed_document.managed_path).exists());
        assert!(history_v1.exists());
        assert_eq!(versions[0].name, "final-summary_v2.pdf");
        assert_eq!(versions[1].name, "final-summary.pdf");
    }

    #[test]
    fn document_delete_removes_managed_assets_and_cascades_related_rows() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                id: None,
                label: "待归档".to_string(),
                color_key: "amber".to_string(),
            })
            .unwrap();

        let source_v1 = harness.root.join("delete-me-source-v1.pdf");
        fs::write(&source_v1, b"version1").unwrap();
        let document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: None,
                source_path: source_v1.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: Some(vec![tag.id]),
            })
            .unwrap();

        let source_v2 = harness.root.join("delete-me-source-v2.pdf");
        fs::write(&source_v2, b"version2").unwrap();
        let versioned_document = database
            .document_add_version(DocumentAddVersionInput {
                document_id: document.id,
                source_path: Some(source_v2.to_string_lossy().to_string()),
            })
            .unwrap();

        let deleted = database
            .document_delete(DocumentDeleteInput {
                document_id: document.id,
            })
            .unwrap();

        let version_count: i64 = database
            .conn
            .query_row(
                "SELECT COUNT(*) FROM document_versions WHERE document_id = ?1",
                [document.id],
                |row| row.get(0),
            )
            .unwrap();
        let tag_link_count: i64 = database
            .conn
            .query_row(
                "SELECT COUNT(*) FROM document_tag_links WHERE document_id = ?1",
                [document.id],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(deleted.id, document.id);
        assert_eq!(
            deleted.current_version_number,
            versioned_document.current_version_number
        );
        assert!(!Path::new(&deleted.managed_path).exists());
        assert!(!Path::new(&deleted.history_dir_path).exists());
        assert!(Path::new(&deleted.original_path).exists());
        assert!(database.document_record(document.id).is_err());
        assert_eq!(version_count, 0);
        assert_eq!(tag_link_count, 0);
    }

    #[test]
    fn document_delete_skips_missing_managed_file_and_removes_remaining_assets() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);

        let source_v1 = harness.root.join("missing-delete-source-v1.pdf");
        fs::write(&source_v1, b"version1").unwrap();
        let document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: None,
                source_path: source_v1.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();

        let source_v2 = harness.root.join("missing-delete-source-v2.pdf");
        fs::write(&source_v2, b"version2").unwrap();
        let versioned_document = database
            .document_add_version(DocumentAddVersionInput {
                document_id: document.id,
                source_path: Some(source_v2.to_string_lossy().to_string()),
            })
            .unwrap();

        fs::remove_file(&versioned_document.managed_path).unwrap();
        database.refresh_document_health(project.id).unwrap();
        let missing_document = database.document_record(document.id).unwrap();
        let history_dir = PathBuf::from(&missing_document.history_dir_path);

        assert_eq!(missing_document.health, "missing");
        assert!(history_dir.exists());

        let deleted = database
            .document_delete(DocumentDeleteInput {
                document_id: document.id,
            })
            .unwrap();

        assert_eq!(deleted.health, "missing");
        assert!(!history_dir.exists());
        assert!(Path::new(&deleted.original_path).exists());
        assert!(database.document_record(document.id).is_err());
    }

    #[test]
    fn project_overview_lists_project_root_documents_and_starred_activity_documents() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");

        let root_source = harness.root.join("root-brief.pdf");
        fs::write(&root_source, b"root").unwrap();
        let root_document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: None,
                source_path: root_source.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();

        let activity_source = harness.root.join("activity-note.pdf");
        fs::write(&activity_source, b"activity").unwrap();
        let activity_document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                source_path: activity_source.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();

        let starred_source = harness.root.join("activity-starred.pdf");
        fs::write(&starred_source, b"starred").unwrap();
        let starred_document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                source_path: starred_source.to_string_lossy().to_string(),
                is_starred: true,
                tag_ids: None,
            })
            .unwrap();

        let overview = database
            .project_get_overview(ProjectIdInput {
                project_id: project.id,
            })
            .unwrap();
        let document_ids = overview
            .project_documents
            .iter()
            .map(|document| document.id)
            .collect::<Vec<_>>();

        assert!(document_ids.contains(&root_document.id));
        assert!(document_ids.contains(&starred_document.id));
        assert!(!document_ids.contains(&activity_document.id));
    }

    #[test]
    fn project_overview_only_lists_promoted_activity_conclusions() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");

        let promoted = database
            .conclusion_create(ConclusionCreateInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                note_id: None,
                markdown: "这是项目级结论".to_string(),
                html: "<p>这是项目级结论</p>".to_string(),
                promoted_to_project: true,
                is_pinned: None,
            })
            .unwrap();
        let hidden = database
            .conclusion_create(ConclusionCreateInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                note_id: None,
                markdown: "这条只留在活动里".to_string(),
                html: "<p>这条只留在活动里</p>".to_string(),
                promoted_to_project: false,
                is_pinned: None,
            })
            .unwrap();

        let overview = database
            .project_get_overview(ProjectIdInput {
                project_id: project.id,
            })
            .unwrap();
        let conclusion_ids = overview
            .conclusion_groups
            .iter()
            .flat_map(|group| group.conclusions.iter().map(|conclusion| conclusion.id))
            .collect::<Vec<_>>();

        assert_eq!(conclusion_ids, vec![promoted.id]);
        assert!(!conclusion_ids.contains(&hidden.id));
    }

    #[test]
    fn file_tag_settings_round_trip_usage_counts_and_document_payloads() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);

        let legal_tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                id: None,
                label: "法务".to_string(),
                color_key: "blue".to_string(),
            })
            .unwrap();
        let urgent_tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                id: None,
                label: "紧急".to_string(),
                color_key: "red".to_string(),
            })
            .unwrap();

        let source_path = harness.root.join("contract.pdf");
        fs::write(&source_path, b"contract").unwrap();
        let document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: None,
                source_path: source_path.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: Some(vec![legal_tag.id, urgent_tag.id, legal_tag.id]),
            })
            .unwrap();
        let overview = database
            .project_get_overview(ProjectIdInput {
                project_id: project.id,
            })
            .unwrap();
        let settings = database.file_tag_settings_get().unwrap();

        assert_eq!(
            document.tags.iter().map(|tag| tag.id).collect::<Vec<_>>(),
            vec![legal_tag.id, urgent_tag.id]
        );
        assert_eq!(
            overview.project_documents[0]
                .tags
                .iter()
                .map(|tag| tag.id)
                .collect::<Vec<_>>(),
            vec![legal_tag.id, urgent_tag.id]
        );
        assert_eq!(
            settings
                .tags
                .iter()
                .find(|tag| tag.id == legal_tag.id)
                .map(|tag| tag.usage_count),
            Some(1)
        );
        assert_eq!(
            settings
                .tags
                .iter()
                .find(|tag| tag.id == urgent_tag.id)
                .map(|tag| tag.usage_count),
            Some(1)
        );
    }

    #[test]
    fn document_update_meta_replaces_document_tags_without_losing_other_changes() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);

        let draft_tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                id: None,
                label: "草稿".to_string(),
                color_key: "slate".to_string(),
            })
            .unwrap();
        let review_tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                id: None,
                label: "待审核".to_string(),
                color_key: "amber".to_string(),
            })
            .unwrap();
        let final_tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                id: None,
                label: "定稿".to_string(),
                color_key: "green".to_string(),
            })
            .unwrap();

        let source_path = harness.root.join("brief.pdf");
        fs::write(&source_path, b"brief").unwrap();
        let document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: None,
                source_path: source_path.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: Some(vec![draft_tag.id, review_tag.id]),
            })
            .unwrap();

        let updated = database
            .document_update_meta(DocumentUpdateMetaInput {
                document_id: document.id,
                activity_id: None,
                base_name: Some("brief-final.pdf".to_string()),
                is_starred: Some(true),
                tag_ids: Some(vec![final_tag.id]),
            })
            .unwrap();
        let settings = database.file_tag_settings_get().unwrap();

        assert_eq!(updated.base_name, "brief-final.pdf");
        assert!(updated.is_starred);
        assert_eq!(
            updated.tags.iter().map(|tag| tag.id).collect::<Vec<_>>(),
            vec![final_tag.id]
        );
        assert_eq!(
            settings
                .tags
                .iter()
                .find(|tag| tag.id == draft_tag.id)
                .map(|tag| tag.usage_count),
            Some(0)
        );
        assert_eq!(
            settings
                .tags
                .iter()
                .find(|tag| tag.id == review_tag.id)
                .map(|tag| tag.usage_count),
            Some(0)
        );
        assert_eq!(
            settings
                .tags
                .iter()
                .find(|tag| tag.id == final_tag.id)
                .map(|tag| tag.usage_count),
            Some(1)
        );
    }

    #[test]
    fn deleting_file_tag_cascades_document_links() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);

        let tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                id: None,
                label: "合同".to_string(),
                color_key: "teal".to_string(),
            })
            .unwrap();

        let source_path = harness.root.join("agreement.pdf");
        fs::write(&source_path, b"agreement").unwrap();
        let document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: None,
                source_path: source_path.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: Some(vec![tag.id]),
            })
            .unwrap();
        assert_eq!(document.tags.len(), 1);

        let refreshed_settings = database
            .file_tag_option_delete(FileTagOptionDeleteInput { tag_id: tag.id })
            .unwrap();
        let refreshed_document = database.document_record(document.id).unwrap();

        assert!(refreshed_settings.tags.iter().all(|item| item.id != tag.id));
        assert!(refreshed_document.tags.is_empty());
    }

    #[test]
    fn file_tag_color_key_is_validated() {
        let (_harness, mut database) = setup_database();

        let error = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                id: None,
                label: "非法颜色".to_string(),
                color_key: "purple".to_string(),
            })
            .unwrap_err();

        assert!(error
            .to_string()
            .contains("file tag color is not supported"));
    }

    #[test]
    fn activity_attribute_color_key_is_validated() {
        let (_harness, mut database) = setup_database();

        let error = database
            .activity_attribute_option_upsert(ActivityAttributeOptionUpsertInput {
                id: None,
                label: "非法属性颜色".to_string(),
                color_key: "purple".to_string(),
            })
            .unwrap_err();

        assert!(error
            .to_string()
            .contains("activity attribute color is not supported"));
    }

    #[test]
    fn record_type_settings_are_seeded_with_legacy_defaults() {
        let (_harness, mut database) = setup_database();

        let snapshot = database.record_type_settings_get().unwrap();

        assert_eq!(snapshot.record_types.len(), 2);
        assert_eq!(snapshot.record_types[0].key, DEFAULT_RECORD_TYPE_KEY);
        assert!(snapshot.record_types[0].is_default);
        assert_eq!(snapshot.record_types[1].key, MEETING_RECORD_TYPE_KEY);
        assert!(!snapshot.record_types[1].is_default);
    }

    #[test]
    fn record_type_upsert_round_trips_template_color_and_default_selection() {
        let (_harness, mut database) = setup_database();

        let created = database
            .record_type_option_upsert(RecordTypeOptionUpsertInput {
                id: None,
                label: "Research Note".to_string(),
                color_key: "teal".to_string(),
                template_html: "<h2>背景</h2><p></p>".to_string(),
                is_default: false,
            })
            .unwrap();

        assert_eq!(created.label, "Research Note");
        assert_eq!(created.color_key, "teal");
        assert_eq!(created.template_html, "<h2>背景</h2><p></p>");
        assert_eq!(created.key, "research_note");

        let updated = database
            .record_type_option_upsert(RecordTypeOptionUpsertInput {
                id: Some(created.id),
                label: "Research Note".to_string(),
                color_key: "green".to_string(),
                template_html: "<h2>结论</h2><p></p>".to_string(),
                is_default: true,
            })
            .unwrap();

        assert!(updated.is_default);
        assert_eq!(updated.color_key, "green");
        assert_eq!(updated.template_html, "<h2>结论</h2><p></p>");

        let snapshot = database.record_type_settings_get().unwrap();
        assert_eq!(snapshot.record_types[0].id, updated.id);
        assert!(snapshot.record_types[0].is_default);
        assert!(
            snapshot
                .record_types
                .iter()
                .filter(|record_type| record_type.is_default)
                .count()
                == 1
        );
    }

    #[test]
    fn record_type_delete_rejects_default_and_in_use_types() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");
        let snapshot = database.record_type_settings_get().unwrap();
        let default_type = snapshot
            .record_types
            .iter()
            .find(|record_type| record_type.is_default)
            .cloned()
            .unwrap();
        let meeting_type = snapshot
            .record_types
            .iter()
            .find(|record_type| record_type.key == MEETING_RECORD_TYPE_KEY)
            .cloned()
            .unwrap();

        let default_error = database
            .record_type_option_delete(RecordTypeOptionDeleteInput {
                type_id: default_type.id,
            })
            .unwrap_err();
        assert!(default_error
            .to_string()
            .contains("default record type cannot be deleted"));

        create_note(
            &mut database,
            project.id,
            activity.id,
            MEETING_RECORD_TYPE_KEY,
            "会议结论",
        );

        let in_use_error = database
            .record_type_option_delete(RecordTypeOptionDeleteInput {
                type_id: meeting_type.id,
            })
            .unwrap_err();
        assert!(in_use_error
            .to_string()
            .contains("record type in use cannot be deleted"));
    }

    #[test]
    fn note_upsert_rejects_record_type_changes_after_creation() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");
        let note = create_note(
            &mut database,
            project.id,
            activity.id,
            DEFAULT_RECORD_TYPE_KEY,
            "Captured detail",
        );

        let error = database
            .note_upsert(NoteUpsertInput {
                project_id: project.id,
                activity_id: activity.id,
                note_id: Some(note.id),
                note_type: MEETING_RECORD_TYPE_KEY.to_string(),
                title: Some("记录".to_string()),
                markdown: "Updated detail".to_string(),
                html: "<p>Updated detail</p>".to_string(),
            })
            .unwrap_err();

        assert!(error
            .to_string()
            .contains("note type cannot be changed after creation"));
    }

    #[test]
    fn note_delete_removes_note_from_activity_results() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");
        let note = create_note(
            &mut database,
            project.id,
            activity.id,
            DEFAULT_RECORD_TYPE_KEY,
            "Captured detail",
        );

        let deleted = database
            .note_delete(NoteDeleteInput { note_id: note.id })
            .unwrap();

        assert_eq!(deleted.id, note.id);
        assert!(database.note_record(note.id).is_err());
        assert!(database.fetch_notes(activity.id).unwrap().is_empty());
    }

    #[test]
    fn workspace_todo_list_only_returns_unarchived_project_todos_with_activity_titles() {
        let (harness, mut database) = setup_database();
        let active_project = create_project(&mut database, &harness.workspace_root);
        let archived_project = database
            .project_create(ProjectCreateInput {
                name: "Archived".to_string(),
                summary: None,
                status: None,
            })
            .unwrap();
        let activity = create_activity(&mut database, active_project.id, "Kickoff");
        let active_todo = create_todo(
            &mut database,
            active_project.id,
            Some(activity.id),
            "跟进预算",
            "urgent_important",
        );
        create_todo(
            &mut database,
            archived_project.id,
            None,
            "归档项目待办",
            "not_urgent_not_important",
        );
        database
            .project_set_archive(ProjectArchiveInput {
                project_id: archived_project.id,
                is_archived: true,
            })
            .unwrap();

        let todos = database.workspace_todo_list().unwrap();

        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].id, active_todo.id);
        assert_eq!(todos[0].source_activity_title.as_deref(), Some("Kickoff"));
    }

    #[test]
    fn workspace_notes_round_trip_create_update_delete_and_sort() {
        use std::{thread::sleep, time::Duration};

        let (_harness, mut database) = setup_database();
        let first = database
            .workspace_note_upsert(WorkspaceNoteUpsertInput {
                note_id: None,
                title: Some("第一条".to_string()),
                markdown: "第一条记录".to_string(),
                html: "<p>第一条记录</p>".to_string(),
            })
            .unwrap();

        sleep(Duration::from_millis(5));

        let second = database
            .workspace_note_upsert(WorkspaceNoteUpsertInput {
                note_id: None,
                title: Some("第二条".to_string()),
                markdown: "第二条记录".to_string(),
                html: "<p>第二条记录</p>".to_string(),
            })
            .unwrap();

        sleep(Duration::from_millis(5));

        let updated_first = database
            .workspace_note_upsert(WorkspaceNoteUpsertInput {
                note_id: Some(first.id),
                title: Some("第一条（更新）".to_string()),
                markdown: "第一条记录，补充判断".to_string(),
                html: "<p>第一条记录，补充判断</p>".to_string(),
            })
            .unwrap();

        let listed = database.workspace_note_list().unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, updated_first.id);
        assert_eq!(listed[0].title.as_deref(), Some("第一条（更新）"));
        assert_eq!(listed[1].id, second.id);

        let deleted = database
            .workspace_note_delete(WorkspaceNoteDeleteInput { note_id: second.id })
            .unwrap();
        assert_eq!(deleted.id, second.id);
        assert!(database.workspace_note_record(second.id).is_err());

        let remaining = database.workspace_note_list().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, updated_first.id);
    }

    #[test]
    fn today_quick_note_is_singleton_and_stays_out_of_workspace_notes() {
        let (_harness, mut database) = setup_database();

        let first = database
            .today_quick_note_upsert(TodayQuickNoteUpsertInput {
                markdown: "第一版今日快记".to_string(),
                html: "<p>第一版今日快记</p>".to_string(),
            })
            .unwrap();
        let second = database
            .today_quick_note_upsert(TodayQuickNoteUpsertInput {
                markdown: "更新后的今日快记".to_string(),
                html: "<p>更新后的今日快记</p>".to_string(),
            })
            .unwrap();
        let workspace_note = database
            .workspace_note_upsert(WorkspaceNoteUpsertInput {
                note_id: None,
                title: Some("工作区记录".to_string()),
                markdown: "常规工作区记录".to_string(),
                html: "<p>常规工作区记录</p>".to_string(),
            })
            .unwrap();

        assert_eq!(first.id, second.id);
        assert_eq!(second.title, None);

        let quick_note = database.today_quick_note_get().unwrap().unwrap();
        assert_eq!(quick_note.id, second.id);
        assert_eq!(quick_note.content_markdown, "更新后的今日快记");

        let listed = database.workspace_note_list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, workspace_note.id);
        assert_eq!(listed[0].title.as_deref(), Some("工作区记录"));
    }

    #[test]
    fn note_upsert_preserves_embedded_image_html() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");
        let data_url = format!("data:image/png;base64,{}", "A".repeat(256));
        let html = format!(r#"<p><img src="{data_url}" alt="截图" /></p>"#);

        let saved = database
            .note_upsert(NoteUpsertInput {
                project_id: project.id,
                activity_id: activity.id,
                note_id: None,
                note_type: DEFAULT_RECORD_TYPE_KEY.to_string(),
                title: Some("带图片记录".to_string()),
                markdown: "[图片] 截图".to_string(),
                html: html.clone(),
            })
            .unwrap();

        assert_eq!(saved.content_html, html);
    }

    #[test]
    fn note_upsert_preserves_embedded_image_metadata_html() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");
        let data_url = format!("data:image/png;base64,{}", "B".repeat(384));
        let html = format!(
            r#"<p><img src="{data_url}" data-path="/tmp/managed/clip.png" data-mime-type="image/png" data-document-id="18" alt="截图" /></p>"#,
        );

        let saved = database
            .note_upsert(NoteUpsertInput {
                project_id: project.id,
                activity_id: activity.id,
                note_id: None,
                note_type: DEFAULT_RECORD_TYPE_KEY.to_string(),
                title: Some("带图片元数据记录".to_string()),
                markdown: "[图片] 截图".to_string(),
                html: html.clone(),
            })
            .unwrap();

        assert_eq!(saved.content_html, html);
    }

    #[test]
    fn document_schema_migration_folds_legacy_priority_flags_into_starred() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");

        let role_source = harness.root.join("role-key.pdf");
        fs::write(&role_source, b"role").unwrap();
        let role_document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                source_path: role_source.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();

        let promoted_source = harness.root.join("promoted.pdf");
        fs::write(&promoted_source, b"promoted").unwrap();
        let promoted_document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                source_path: promoted_source.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();

        let starred_source = harness.root.join("starred.pdf");
        fs::write(&starred_source, b"starred").unwrap();
        let starred_document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                source_path: starred_source.to_string_lossy().to_string(),
                is_starred: true,
                tag_ids: None,
            })
            .unwrap();

        database
            .conn
            .execute(
                "ALTER TABLE documents ADD COLUMN role TEXT NOT NULL DEFAULT 'reference_material'",
                [],
            )
            .unwrap();
        database
            .conn
            .execute(
                "ALTER TABLE documents ADD COLUMN promoted_to_project INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .unwrap();
        database
            .conn
            .execute(
                "UPDATE documents SET role = 'key_material' WHERE id = ?1",
                params![role_document.id],
            )
            .unwrap();
        database
            .conn
            .execute(
                "UPDATE documents SET promoted_to_project = 1 WHERE id = ?1",
                params![promoted_document.id],
            )
            .unwrap();
        database
            .set_schema_version(FILE_LAYOUT_SCHEMA_VERSION)
            .unwrap();

        drop(database);
        let reopened = Database::open(
            &harness.root.join("app.sqlite3"),
            &harness.workspace_root,
            Some("test-secret".to_string()),
        )
        .unwrap();

        assert!(!reopened.has_column("documents", "role").unwrap());
        assert!(!reopened
            .has_column("documents", "promoted_to_project")
            .unwrap());
        assert!(
            reopened
                .document_record(role_document.id)
                .unwrap()
                .is_starred
        );
        assert!(
            reopened
                .document_record(promoted_document.id)
                .unwrap()
                .is_starred
        );
        assert!(
            reopened
                .document_record(starred_document.id)
                .unwrap()
                .is_starred
        );
    }
}

#[cfg(test)]
fn style_json_signature(settings: &RichTextStyleSettings) -> String {
    serde_json::to_string(settings).unwrap()
}

fn default_rich_text_style_settings() -> RichTextStyleSettings {
    RichTextStyleSettings {
        body: RichTextStyleBlockSettings {
            font_family: preset_font_selection("workspace_sans"),
            font_size_px: 14,
            line_height: 1.6,
            paragraph_spacing_before_px: 12,
            paragraph_spacing_after_px: 0,
        },
        headings: crate::models::RichTextHeadingStyleSettings {
            font_family: preset_font_selection("workspace_sans"),
            line_height: 1.35,
            paragraph_spacing_before_px: 12,
            paragraph_spacing_after_px: 0,
            h1_size_px: 24,
            h2_size_px: 20,
            h3_size_px: 16,
        },
        list: RichTextStyleBlockSettings {
            font_family: preset_font_selection("workspace_sans"),
            font_size_px: 14,
            line_height: 1.6,
            paragraph_spacing_before_px: 12,
            paragraph_spacing_after_px: 0,
        },
    }
}

fn default_ai_execution_settings() -> AiExecutionSettings {
    AiExecutionSettings { max_concurrency: 1 }
}

fn default_ai_feature_settings() -> AiFeatureSettings {
    AiFeatureSettings {
        master_enabled: true,
        capabilities: BTreeMap::from([
            ("assistant".to_string(), true),
            ("summary".to_string(), true),
            ("suggestion_generation".to_string(), true),
            ("editor_rewrite".to_string(), true),
        ]),
        features: BTreeMap::from([
            ("summary.activity_summary".to_string(), true),
            ("summary.project_brief".to_string(), true),
            ("summary.daily_brief".to_string(), true),
            ("suggestion_generation.conclusion".to_string(), true),
            ("suggestion_generation.todo".to_string(), true),
        ]),
    }
}

fn parse_ai_feature_settings_json(value_json: &str) -> Result<AiFeatureSettings> {
    let mut value: Value =
        serde_json::from_str(value_json).context("failed to parse AI feature settings")?;
    normalize_ai_feature_settings_value(&mut value)?;
    serde_json::from_value(value).context("failed to decode AI feature settings")
}

fn normalize_ai_feature_settings_value(value: &mut Value) -> Result<()> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| anyhow!("AI feature settings must be an object"))?;

    for key in object.keys() {
        if !matches!(key.as_str(), "masterEnabled" | "capabilities" | "features") {
            return Err(anyhow!(
                "AI feature settings contains unsupported key '{}'",
                key
            ));
        }
    }

    if !object.contains_key("masterEnabled") {
        object.insert("masterEnabled".to_string(), json!(true));
    }
    if !object
        .get("masterEnabled")
        .is_some_and(serde_json::Value::is_boolean)
    {
        return Err(anyhow!(
            "AI feature settings masterEnabled must be a boolean"
        ));
    }

    if !object.contains_key("capabilities") {
        object.insert("capabilities".to_string(), json!({}));
    }
    if !object.contains_key("features") {
        object.insert("features".to_string(), json!({}));
    }

    normalize_ai_toggle_map_value(
        object.get_mut("capabilities"),
        &AI_VISIBLE_CAPABILITIES,
        "AI feature settings capabilities",
    )?;
    normalize_ai_toggle_map_value(
        object.get_mut("features"),
        &AI_FEATURE_KEYS,
        "AI feature settings features",
    )?;

    Ok(())
}

fn normalize_ai_toggle_map_value(
    value: Option<&mut Value>,
    allowed_keys: &[&str],
    field: &str,
) -> Result<()> {
    let Some(value) = value else {
        return Err(anyhow!("{field} is missing"));
    };

    let object = value
        .as_object_mut()
        .ok_or_else(|| anyhow!("{field} must be an object"))?;

    for key in object.keys() {
        if !allowed_keys.contains(&key.as_str()) {
            return Err(anyhow!("{field} contains unsupported key '{}'", key));
        }
    }

    for &key in allowed_keys {
        match object.get(key) {
            Some(existing) if existing.is_boolean() => {}
            Some(_) => return Err(anyhow!("{field} key '{}' must be a boolean", key)),
            None => {
                object.insert(key.to_string(), json!(true));
            }
        }
    }

    Ok(())
}

fn ai_capability_for_feature(feature_key: &str) -> Result<&'static str> {
    if feature_key.starts_with("summary.") {
        return Ok("summary");
    }
    if feature_key.starts_with("suggestion_generation.") {
        return Ok("suggestion_generation");
    }
    Err(anyhow!("unsupported AI feature '{}'", feature_key))
}

fn ai_feature_key_for_artifact_kind(kind: &str) -> Result<&'static str> {
    match kind {
        "activity_summary" => Ok("summary.activity_summary"),
        "project_brief" => Ok("summary.project_brief"),
        "daily_brief" => Ok("summary.daily_brief"),
        _ => Err(anyhow!("unsupported artifact kind")),
    }
}

fn ai_feature_enabled(settings: &AiFeatureSettings, feature_key: &str) -> Result<bool> {
    if !AI_FEATURE_KEYS.contains(&feature_key) {
        return Err(anyhow!("unsupported AI feature '{}'", feature_key));
    }

    Ok(settings.features.get(feature_key).copied().unwrap_or(true))
}

fn normalize_rich_text_style_value(value: &mut Value) -> Result<()> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| anyhow!("rich text style must be an object"))?;

    normalize_rich_text_style_block_value(object.get_mut("body"))?;
    normalize_rich_text_style_heading_value(object.get_mut("headings"))?;
    normalize_rich_text_style_block_value(object.get_mut("list"))?;

    Ok(())
}

fn normalize_rich_text_style_block_value(value: Option<&mut Value>) -> Result<()> {
    let Some(value) = value else {
        return Err(anyhow!("rich text style block is missing"));
    };

    let object = value
        .as_object_mut()
        .ok_or_else(|| anyhow!("rich text style block must be an object"))?;
    let legacy_spacing = object
        .get("paragraphSpacingPx")
        .and_then(|value| value.as_i64())
        .unwrap_or(0);
    let legacy_font_preset = object
        .get("fontPreset")
        .and_then(|value| value.as_str())
        .map(str::to_string);

    if !object.contains_key("paragraphSpacingBeforePx") {
        object.insert(
            "paragraphSpacingBeforePx".to_string(),
            json!(legacy_spacing),
        );
    }

    if !object.contains_key("paragraphSpacingAfterPx") {
        object.insert("paragraphSpacingAfterPx".to_string(), json!(0));
    }

    if !object.contains_key("fontFamily") {
        let font_family = match legacy_font_preset {
            Some(font_preset) => json!({
                "source": "preset",
                "value": font_preset,
            }),
            None => json!({
                "source": "preset",
                "value": "workspace_sans",
            }),
        };
        object.insert("fontFamily".to_string(), font_family);
    }

    Ok(())
}

fn normalize_rich_text_style_heading_value(value: Option<&mut Value>) -> Result<()> {
    normalize_rich_text_style_block_value(value)
}

fn validate_rich_text_style_settings(settings: &RichTextStyleSettings) -> Result<()> {
    validate_rich_text_style_block(&settings.body, "body")?;
    validate_rich_text_font_selection(&settings.headings.font_family, "headings.fontFamily")?;

    if !(1.0..=2.4).contains(&settings.headings.line_height) {
        return Err(anyhow!("headings.lineHeight must be between 1.0 and 2.4"));
    }

    if !(0..=48).contains(&settings.headings.paragraph_spacing_before_px) {
        return Err(anyhow!(
            "headings.paragraphSpacingBeforePx must be between 0 and 48"
        ));
    }

    if !(0..=48).contains(&settings.headings.paragraph_spacing_after_px) {
        return Err(anyhow!(
            "headings.paragraphSpacingAfterPx must be between 0 and 48"
        ));
    }

    validate_px_value(settings.headings.h1_size_px, "headings.h1SizePx", 14, 48)?;
    validate_px_value(settings.headings.h2_size_px, "headings.h2SizePx", 14, 40)?;
    validate_px_value(settings.headings.h3_size_px, "headings.h3SizePx", 12, 32)?;

    if settings.headings.h1_size_px < settings.headings.h2_size_px
        || settings.headings.h2_size_px < settings.headings.h3_size_px
    {
        return Err(anyhow!("heading sizes must descend from h1 to h3"));
    }

    validate_rich_text_style_block(&settings.list, "list")?;
    Ok(())
}

fn validate_rich_text_style_block(
    settings: &RichTextStyleBlockSettings,
    prefix: &str,
) -> Result<()> {
    validate_rich_text_font_selection(&settings.font_family, &format!("{prefix}.fontFamily"))?;
    validate_px_value(
        settings.font_size_px,
        &format!("{prefix}.fontSizePx"),
        12,
        28,
    )?;

    if !(1.0..=2.4).contains(&settings.line_height) {
        return Err(anyhow!("{prefix}.lineHeight must be between 1.0 and 2.4"));
    }

    if !(0..=48).contains(&settings.paragraph_spacing_before_px) {
        return Err(anyhow!(
            "{prefix}.paragraphSpacingBeforePx must be between 0 and 48"
        ));
    }

    if !(0..=48).contains(&settings.paragraph_spacing_after_px) {
        return Err(anyhow!(
            "{prefix}.paragraphSpacingAfterPx must be between 0 and 48"
        ));
    }

    Ok(())
}

fn validate_rich_text_font_selection(selection: &RichTextFontSelection, field: &str) -> Result<()> {
    match selection.source.as_str() {
        "preset" => validate_rich_text_font_preset(&selection.value, &format!("{field}.value")),
        "system" => validate_system_font_family(&selection.value, &format!("{field}.value")),
        _ => Err(anyhow!("{field}.source must be one of: preset, system")),
    }
}

fn validate_rich_text_font_preset(value: &str, field: &str) -> Result<()> {
    if !RICH_TEXT_FONT_PRESETS.contains(&value) {
        return Err(anyhow!("{field} is not a supported font preset"));
    }
    Ok(())
}

fn validate_system_font_family(value: &str, field: &str) -> Result<()> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("{field} must not be empty"));
    }

    if trimmed.len() > 160 {
        return Err(anyhow!("{field} must be 160 characters or fewer"));
    }

    if trimmed.contains(',') {
        return Err(anyhow!("{field} must be a single font family"));
    }

    if trimmed.chars().any(|character| character.is_control()) {
        return Err(anyhow!("{field} must not contain control characters"));
    }

    Ok(())
}

fn preset_font_selection(value: &str) -> RichTextFontSelection {
    RichTextFontSelection {
        source: "preset".to_string(),
        value: value.to_string(),
    }
}

fn validate_px_value(value: i64, field: &str, min: i64, max: i64) -> Result<()> {
    if !(min..=max).contains(&value) {
        return Err(anyhow!("{field} must be between {min} and {max}"));
    }
    Ok(())
}

fn validate_activity_option_label(value: &str) -> Result<String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(anyhow!("activity option label cannot be empty"));
    }
    if normalized.chars().count() > 32 {
        return Err(anyhow!(
            "activity option label must be 32 characters or fewer"
        ));
    }
    Ok(normalized.to_string())
}

fn validate_record_type_label(value: &str) -> Result<String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(anyhow!("record type label cannot be empty"));
    }
    if normalized.chars().count() > 32 {
        return Err(anyhow!("record type label must be 32 characters or fewer"));
    }
    Ok(normalized.to_string())
}

fn validate_record_type_key(value: &str) -> Result<String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(anyhow!("record type key cannot be empty"));
    }
    Ok(normalized.to_string())
}

fn validate_file_tag_label(value: &str) -> Result<String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(anyhow!("file tag label cannot be empty"));
    }
    if normalized.chars().count() > 32 {
        return Err(anyhow!("file tag label must be 32 characters or fewer"));
    }
    Ok(normalized.to_string())
}

fn validate_file_tag_color_key(value: &str) -> Result<String> {
    let normalized = value.trim();
    if !FILE_TAG_COLOR_KEYS.contains(&normalized) {
        return Err(anyhow!("file tag color is not supported"));
    }
    Ok(normalized.to_string())
}

fn validate_activity_attribute_color_key(value: &str) -> Result<String> {
    let normalized = value.trim();
    if !FILE_TAG_COLOR_KEYS.contains(&normalized) {
        return Err(anyhow!("activity attribute color is not supported"));
    }
    Ok(normalized.to_string())
}

fn validate_activity_status_color_key(value: &str) -> Result<String> {
    let normalized = value.trim();
    if !FILE_TAG_COLOR_KEYS.contains(&normalized) {
        return Err(anyhow!("activity status color is not supported"));
    }
    Ok(normalized.to_string())
}

fn normalize_record_type_template_html(value: &str) -> String {
    let normalized = value.trim();
    if normalized.is_empty() {
        DEFAULT_RECORD_TYPE_TEMPLATE_HTML.to_string()
    } else {
        normalized.to_string()
    }
}

fn normalize_record_type_key_from_label(label: &str) -> String {
    let mut normalized = String::new();
    let mut previous_was_separator = false;

    for ch in label.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            normalized.push(ch.to_ascii_lowercase());
            previous_was_separator = false;
            continue;
        }

        if ch == '_' || ch == '-' {
            if !previous_was_separator && !normalized.is_empty() {
                normalized.push(ch);
                previous_was_separator = true;
            }
            continue;
        }

        if ch.is_whitespace() {
            if !previous_was_separator && !normalized.is_empty() {
                normalized.push('_');
                previous_was_separator = true;
            }
        }
    }

    normalized
        .trim_matches(|ch| ch == '_' || ch == '-')
        .to_string()
}

fn record_type_storage_from_row(row: &Row<'_>) -> rusqlite::Result<RecordTypeStorage> {
    Ok(RecordTypeStorage {
        id: row.get(0)?,
        key: row.get(1)?,
        label: row.get(2)?,
        color_key: row.get(3)?,
        template_html: row.get(4)?,
        is_default: int_to_bool(row.get::<_, i64>(5)?),
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn record_type_storage_with_tx(tx: &Transaction<'_>, type_id: i64) -> Result<RecordTypeStorage> {
    tx.query_row(
        r#"
        SELECT id, key, label, color_key, template_html, is_default, created_at, updated_at
        FROM record_type_options
        WHERE id = ?1
        "#,
        [type_id],
        record_type_storage_from_row,
    )
    .map_err(Into::into)
}

fn normalize_file_tag_ids(tag_ids: &[i64]) -> Vec<i64> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for &tag_id in tag_ids {
        if seen.insert(tag_id) {
            normalized.push(tag_id);
        }
    }
    normalized
}

fn validate_ai_profile_fields(
    name: &str,
    provider_family: &str,
    base_url: &str,
    default_model: &str,
) -> Result<()> {
    if name.trim().is_empty() {
        return Err(anyhow!("AI profile name cannot be empty"));
    }

    match provider_family.trim() {
        "openai_compatible" | "anthropic_compatible" | "gemini_compatible" => {}
        _ => return Err(anyhow!("unsupported AI provider family")),
    }

    let normalized_url = normalize_base_url(base_url);
    if !(normalized_url.starts_with("https://") || normalized_url.starts_with("http://")) {
        return Err(anyhow!("AI base URL must start with http:// or https://"));
    }

    if default_model.trim().is_empty() {
        return Err(anyhow!("AI default model cannot be empty"));
    }

    Ok(())
}

fn validate_ai_binding(input: &AiCapabilityBindingUpsertInput) -> Result<()> {
    let capability = input.capability.trim();
    if !AI_CAPABILITIES.contains(&capability) {
        return Err(anyhow!("unsupported AI capability"));
    }

    if capability == "default" {
        if input.use_default {
            return Err(anyhow!("the default AI binding cannot inherit from itself"));
        }
        if input.profile_id.is_none() {
            return Err(anyhow!("the default AI binding must choose a profile"));
        }
        return Ok(());
    }

    if input.use_default {
        if input.profile_id.is_some() || nullable_trimmed(input.model.as_deref()).is_some() {
            return Err(anyhow!(
                "a binding that uses the default profile cannot also override profile or model"
            ));
        }
    } else if input.profile_id.is_none() {
        return Err(anyhow!("a custom AI binding must choose a profile"));
    }

    Ok(())
}

fn validate_ai_execution_settings(settings: &AiExecutionSettings) -> Result<()> {
    if !(1..=4).contains(&settings.max_concurrency) {
        return Err(anyhow!("AI maxConcurrency must be between 1 and 4"));
    }

    Ok(())
}

fn validate_ai_editor_rewrite_action_fields(label: &str, prompt: &str) -> Result<()> {
    let label = label.trim();
    if label.is_empty() {
        return Err(anyhow!("AI editor rewrite action name cannot be empty"));
    }
    if label.chars().count() > 32 {
        return Err(anyhow!(
            "AI editor rewrite action name must be 32 characters or fewer"
        ));
    }

    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(anyhow!("AI editor rewrite action prompt cannot be empty"));
    }
    if prompt.chars().count() > 4_000 {
        return Err(anyhow!(
            "AI editor rewrite action prompt must be 4000 characters or fewer"
        ));
    }

    Ok(())
}

fn normalize_ai_editor_rewrite_markdown(value: &str) -> String {
    let trimmed = value.trim();

    if let Some(stripped) = trimmed.strip_prefix("```") {
        let without_language = stripped
            .lines()
            .skip(1)
            .collect::<Vec<_>>()
            .join("\n");
        if let Some(inner) = without_language.strip_suffix("```") {
            return inner.trim().to_string();
        }
    }

    trimmed.to_string()
}

fn validate_rewrite_placeholder_tokens(rewritten_markdown: &str, tokens: &[String]) -> Result<()> {
    let mut search_start = 0usize;

    for token in tokens {
        let Some(relative_index) = rewritten_markdown[search_start..].find(token) else {
            return Err(anyhow!(
                "AI rewrite output is missing required placeholder token '{}'",
                token
            ));
        };
        search_start += relative_index + token.len();
    }

    Ok(())
}

fn normalize_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn nullable_trimmed(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}
