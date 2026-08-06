use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{Local, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::{
    ai_provider::{self, ResolvedAiProfile},
    models::{
        ActivityAttributeOption, ActivityAttributeOptionUpsertInput, ActivityCardData,
        ActivityCreateInput, ActivityDigest, ActivityStatusOption, ActivityStatusOptionUpsertInput,
        ActivityUpdateMetaInput, AiAnswerQuestionInput, AiAnswerResult, AiAnswerScope,
        AiArtifactCitationRecord, AiArtifactGetInput, AiArtifactPayload, AiArtifactRecord,
        AiCapabilityBindingRecord, AiCapabilityBindingUpsertInput,
        AiEditorRewriteActionDeleteInput, AiEditorRewriteActionRecord,
        AiEditorRewriteActionUpsertInput, AiEditorRewriteInput, AiEditorRewriteResult,
        AiEditorSkillDeleteInput, AiEditorSkillRecord, AiEditorSkillReorderInput,
        AiEditorSkillUpsertInput, AiExecutionSettings, AiFeatureSettings, AiJobEnqueueInput,
        AiJobResult, AiProfileTestInput, AiProfileTestResult, AiProviderProfileDeleteInput,
        AiProviderProfileRecord, AiProviderProfileUpsertInput, AiSettingsSnapshot,
        AiSuggestionRecord, ConclusionCreateInput, ConclusionDeleteInput, ConclusionGroup,
        ConclusionListInput, ConclusionRecord, ConclusionUpdateInput, ContactDeleteInput,
        ContactRecord, ContactSearchInput, ContactUpsertInput, DocumentAddVersionInput,
        DocumentDeleteInput, DocumentImportClipboardImageInput,
        DocumentImportClipboardNoteImageInput, DocumentImportInput, DocumentImportNoteImageInput,
        DocumentListVersionsInput, DocumentRecord, DocumentRelocateInput, DocumentTagRecord,
        DocumentUpdateMetaInput, DocumentVersionRecord, FileTagOptionDeleteInput,
        FileTagOptionUpsertInput, FileTagRecord, FileTagSettingsGetInput, FileTagSettingsSnapshot,
        InternalReferenceResolveInput, InternalReferenceResolveResult,
        InternalReferenceSearchInput, InternalReferenceSearchResult, NoteRecord,
        ProjectArchiveInput, ProjectCreateInput, ProjectDashboard, ProjectDeleteInput,
        ProjectIdInput, ProjectListItem, ProjectPageData, ProjectRecord, ProjectRecordDeleteInput,
        ProjectRecordUpsertInput, ProjectUpdateInput, ProjectsListInput, RichTextFontSelection,
        RichTextStyleBlockSettings, RichTextStyleSettings, RichTextStyleUpsertInput,
        TodoAddProgressInput, TodoCreateInput, TodoDeleteInput, TodoDeleteProgressInput,
        TodoProgressRecord, TodoRecord, TodoScope, TodoUpdateContentInput, TodoUpdatePriorityInput,
        TodoUpdateProgressInput, TodoUpdateStatusInput, TodoUpdateTagsInput,
        WorkspaceClipboardNoteImageImportInput, WorkspaceNoteImageAsset,
        WorkspaceNoteImageImportInput, WorkspacePageData, WorkspaceQuickNoteUpsertInput,
        WorkspaceRecord, WorkspaceRecordDeleteInput, WorkspaceRecordUpsertInput,
        WorkspaceSearchInput, WorkspaceSearchResult,
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
const TODO_SUBITEM_SCHEMA_VERSION: i64 = 9;
const PROJECT_KIND_SCHEMA_VERSION: i64 = 10;
const PROJECT_ENTITY_TAG_SCHEMA_VERSION: i64 = 12;
const ACTIVITY_RETIRE_SCHEMA_VERSION: i64 = 13;
const FILE_TAG_PROJECT_UNIQUENESS_SCHEMA_VERSION: i64 = 14;
const NOTE_TYPE_REMOVAL_SCHEMA_VERSION: i64 = 15;
const WORKSPACE_NOTE_TAG_SCHEMA_VERSION: i64 = 16;
const AI_REWRITE_ONLY_SCHEMA_VERSION: i64 = 17;
const TODO_DUE_DATE_SCHEMA_VERSION: i64 = 18;
const TODO_OWNERSHIP_SCHEMA_VERSION: i64 = 19;
const PROJECT_KIND_NORMAL: &str = "normal";
const AI_CAPABILITIES: [&str; 2] = ["default", "editor_rewrite"];
const AI_VISIBLE_CAPABILITIES: [&str; 4] = [
    "assistant",
    "summary",
    "suggestion_generation",
    "editor_rewrite",
];
const AI_FEATURE_KEYS: [&str; 4] = [
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
const APP_SETTING_KEY_AI_EDITOR_SKILLS: &str = "ai_editor_skills";
const AI_EDITOR_SKILL_LIMIT: usize = 24;
const AI_EDITOR_REWRITE_ACTION_LIMIT: usize = 5;
const MANAGED_NOTE_IMAGE_STORAGE_MODE: &str = "managed_note_image";
const PROJECT_NOTE_ASSET_DIR_NAME: &str = "embedded-note-assets";
const DEFAULT_RECORD_TYPE_COLOR_KEY: &str = "slate";
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
const SYSTEM_ACTIVITY_STATUS_PENDING: &str = "pending";
const INTERNAL_REFERENCE_PRIORITY_NOTE_TITLE: u8 = 0;
const INTERNAL_REFERENCE_PRIORITY_CONCLUSION_CONTENT: u8 = 1;
const INTERNAL_REFERENCE_PRIORITY_TODO_CONTENT: u8 = 2;
const INTERNAL_REFERENCE_PRIORITY_DOCUMENT_NAME: u8 = 3;
const INTERNAL_REFERENCE_PRIORITY_NOTE_CONTENT: u8 = 4;
const INTERNAL_REFERENCE_COMPACT_LABEL_MAX_CHARS: usize = 15;
const WORKSPACE_SEARCH_PRIORITY_PROJECT_NAME: u8 = 0;
const WORKSPACE_SEARCH_PRIORITY_ACTIVITY_TITLE: u8 = 1;
const WORKSPACE_SEARCH_PRIORITY_CONTACT_NAME: u8 = 1;
const WORKSPACE_SEARCH_PRIORITY_WORKSPACE_NOTE_TITLE: u8 = 2;
const WORKSPACE_SEARCH_PRIORITY_NOTE_TITLE: u8 = 2;
const WORKSPACE_SEARCH_PRIORITY_CONCLUSION_CONTENT: u8 = 3;
const WORKSPACE_SEARCH_PRIORITY_TODO_CONTENT: u8 = 4;
const WORKSPACE_SEARCH_PRIORITY_DOCUMENT_NAME: u8 = 5;
const WORKSPACE_SEARCH_PRIORITY_NOTE_CONTENT: u8 = 6;
const WORKSPACE_SEARCH_PRIORITY_TODO_PROGRESS: u8 = 6;
const WORKSPACE_SEARCH_PRIORITY_ACTIVITY_BRIEF: u8 = 7;
const WORKSPACE_SEARCH_PRIORITY_PROJECT_SUMMARY: u8 = 8;
const WORKSPACE_SEARCH_PRIORITY_CONTACT_META: u8 = 8;
const WORKSPACE_SEARCH_PRIORITY_DOCUMENT_VERSION: u8 = 8;
const WORKSPACE_SEARCH_PRIORITY_TAG: u8 = 9;

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
    pub ai_profile_mode: String,
}

struct DemoSeedCatalog {
    attribute_ids: HashMap<String, i64>,
    status_ids: HashMap<String, i64>,
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
              kind TEXT NOT NULL DEFAULT 'normal',
              status TEXT NOT NULL DEFAULT 'active',
              root_path TEXT NOT NULL,
              summary TEXT NOT NULL DEFAULT '',
              summary_markdown TEXT NOT NULL DEFAULT '',
              summary_html TEXT NOT NULL DEFAULT '',
              quick_note_code_language TEXT,
              is_archived INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS activity_attribute_options (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              label TEXT NOT NULL COLLATE NOCASE,
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
              activity_id INTEGER,
              title TEXT,
              content_markdown TEXT NOT NULL DEFAULT '',
              content_html TEXT NOT NULL DEFAULT '',
              default_code_language TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
              FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS workspace_notes (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              note_kind TEXT NOT NULL DEFAULT 'workspace_note',
              title TEXT,
              content_markdown TEXT NOT NULL DEFAULT '',
              content_html TEXT NOT NULL DEFAULT '',
              default_code_language TEXT,
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
              scope TEXT NOT NULL DEFAULT 'project',
              project_id INTEGER,
              activity_id INTEGER,
              content TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'unfinished',
              priority TEXT NOT NULL,
              due_date TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              CHECK (
                (scope = 'workspace' AND project_id IS NULL AND activity_id IS NULL)
                OR
                (scope = 'project' AND project_id IS NOT NULL)
              ),
              FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
              FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS todo_progresses (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              todo_id INTEGER NOT NULL,
              content TEXT NOT NULL,
              progress_date TEXT NOT NULL,
              due_date TEXT,
              status TEXT NOT NULL DEFAULT 'unfinished',
              completed_at TEXT,
              order_index INTEGER NOT NULL DEFAULT 0,
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
              project_id INTEGER,
              label TEXT NOT NULL COLLATE NOCASE,
              color_key TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
              UNIQUE(project_id, label)
            );

            CREATE TABLE IF NOT EXISTS contacts (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              pinyin_full TEXT NOT NULL DEFAULT '',
              pinyin_abbr TEXT NOT NULL DEFAULT '',
              email TEXT NOT NULL DEFAULT '',
              employee_id TEXT NOT NULL DEFAULT '',
              role TEXT NOT NULL DEFAULT '',
              department TEXT NOT NULL DEFAULT '',
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

            CREATE TABLE IF NOT EXISTS note_tag_links (
              note_id INTEGER NOT NULL,
              tag_id INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              PRIMARY KEY(note_id, tag_id),
              FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE,
              FOREIGN KEY(tag_id) REFERENCES file_tag_options(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS todo_tag_links (
              todo_id INTEGER NOT NULL,
              tag_id INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              PRIMARY KEY(todo_id, tag_id),
              FOREIGN KEY(todo_id) REFERENCES todos(id) ON DELETE CASCADE,
              FOREIGN KEY(tag_id) REFERENCES file_tag_options(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS workspace_note_tag_links (
              workspace_note_id INTEGER NOT NULL,
              tag_id INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              PRIMARY KEY(workspace_note_id, tag_id),
              FOREIGN KEY(workspace_note_id) REFERENCES workspace_notes(id) ON DELETE CASCADE,
              FOREIGN KEY(tag_id) REFERENCES file_tag_options(id) ON DELETE CASCADE
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
            "kind",
            "ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal'",
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
            "projects",
            "quick_note_code_language",
            "ALTER TABLE projects ADD COLUMN quick_note_code_language TEXT",
        )?;
        self.ensure_column(
            "notes",
            "default_code_language",
            "ALTER TABLE notes ADD COLUMN default_code_language TEXT",
        )?;
        self.ensure_column(
            "workspace_notes",
            "note_kind",
            "ALTER TABLE workspace_notes ADD COLUMN note_kind TEXT NOT NULL DEFAULT 'workspace_note'",
        )?;
        self.ensure_column(
            "workspace_notes",
            "default_code_language",
            "ALTER TABLE workspace_notes ADD COLUMN default_code_language TEXT",
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
        self.ensure_column(
            "todo_progresses",
            "status",
            "ALTER TABLE todo_progresses ADD COLUMN status TEXT NOT NULL DEFAULT 'unfinished'",
        )?;
        self.ensure_column(
            "todo_progresses",
            "completed_at",
            "ALTER TABLE todo_progresses ADD COLUMN completed_at TEXT",
        )?;
        self.ensure_column(
            "todo_progresses",
            "order_index",
            "ALTER TABLE todo_progresses ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0",
        )?;
        self.ensure_column(
            "file_tag_options",
            "project_id",
            "ALTER TABLE file_tag_options ADD COLUMN project_id INTEGER",
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
        if self.schema_version()? < TODO_SUBITEM_SCHEMA_VERSION {
            self.migrate_todo_subitem_schema()?;
            self.set_schema_version(TODO_SUBITEM_SCHEMA_VERSION)?;
        }
        if self.schema_version()? < PROJECT_KIND_SCHEMA_VERSION {
            self.migrate_project_kind_schema()?;
            self.set_schema_version(PROJECT_KIND_SCHEMA_VERSION)?;
        }
        if self.schema_version()? < PROJECT_ENTITY_TAG_SCHEMA_VERSION {
            self.migrate_project_entity_tags_schema()?;
            self.set_schema_version(PROJECT_ENTITY_TAG_SCHEMA_VERSION)?;
        }
        if self.schema_version()? < ACTIVITY_RETIRE_SCHEMA_VERSION {
            self.migrate_activity_retire_schema()?;
            self.set_schema_version(ACTIVITY_RETIRE_SCHEMA_VERSION)?;
        }
        if self.schema_version()? < FILE_TAG_PROJECT_UNIQUENESS_SCHEMA_VERSION {
            self.migrate_file_tag_project_uniqueness_schema()?;
            self.set_schema_version(FILE_TAG_PROJECT_UNIQUENESS_SCHEMA_VERSION)?;
        }
        if self.schema_version()? < NOTE_TYPE_REMOVAL_SCHEMA_VERSION {
            self.migrate_note_type_removal_schema()?;
            self.set_schema_version(NOTE_TYPE_REMOVAL_SCHEMA_VERSION)?;
        }
        if self.schema_version()? < WORKSPACE_NOTE_TAG_SCHEMA_VERSION {
            self.migrate_workspace_note_tag_schema()?;
            self.set_schema_version(WORKSPACE_NOTE_TAG_SCHEMA_VERSION)?;
        }
        if self.schema_version()? < AI_REWRITE_ONLY_SCHEMA_VERSION {
            self.migrate_ai_rewrite_only_schema()?;
            self.set_schema_version(AI_REWRITE_ONLY_SCHEMA_VERSION)?;
        }
        if self.schema_version()? < TODO_DUE_DATE_SCHEMA_VERSION {
            self.migrate_todo_due_date_schema()?;
            self.set_schema_version(TODO_DUE_DATE_SCHEMA_VERSION)?;
        }
        if self.schema_version()? < TODO_OWNERSHIP_SCHEMA_VERSION {
            self.migrate_todo_ownership_schema()?;
            self.set_schema_version(TODO_OWNERSHIP_SCHEMA_VERSION)?;
        }
        self.prune_out_of_scope_project_tag_links()?;
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
            CREATE UNIQUE INDEX IF NOT EXISTS idx_file_tag_options_project_label ON file_tag_options(project_id, label COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name COLLATE NOCASE, id ASC);
            CREATE INDEX IF NOT EXISTS idx_contacts_pinyin_full ON contacts(pinyin_full COLLATE NOCASE, id ASC);
            CREATE INDEX IF NOT EXISTS idx_contacts_pinyin_abbr ON contacts(pinyin_abbr COLLATE NOCASE, id ASC);
            CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email COLLATE NOCASE, id ASC);
            CREATE INDEX IF NOT EXISTS idx_document_tag_links_tag ON document_tag_links(tag_id, document_id);
            CREATE INDEX IF NOT EXISTS idx_document_tag_links_document ON document_tag_links(document_id, tag_id);
            CREATE INDEX IF NOT EXISTS idx_note_tag_links_tag ON note_tag_links(tag_id, note_id);
            CREATE INDEX IF NOT EXISTS idx_note_tag_links_note ON note_tag_links(note_id, tag_id);
            CREATE INDEX IF NOT EXISTS idx_todo_tag_links_tag ON todo_tag_links(tag_id, todo_id);
            CREATE INDEX IF NOT EXISTS idx_todo_tag_links_todo ON todo_tag_links(todo_id, tag_id);
            CREATE INDEX IF NOT EXISTS idx_workspace_note_tag_links_tag ON workspace_note_tag_links(tag_id, workspace_note_id);
            CREATE INDEX IF NOT EXISTS idx_workspace_note_tag_links_note ON workspace_note_tag_links(workspace_note_id, tag_id);
            CREATE INDEX IF NOT EXISTS idx_ai_profiles_enabled ON ai_provider_profiles(enabled, updated_at DESC);
            "#,
        )?;
        Ok(())
    }

    fn prune_out_of_scope_project_tag_links(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            DELETE FROM workspace_note_tag_links
            WHERE EXISTS (
              SELECT 1
              FROM file_tag_options tag
              WHERE tag.id = workspace_note_tag_links.tag_id
                AND tag.project_id IS NOT NULL
            );

            DELETE FROM note_tag_links
            WHERE EXISTS (
              SELECT 1
              FROM notes note
              INNER JOIN file_tag_options tag ON tag.id = note_tag_links.tag_id
              WHERE note.id = note_tag_links.note_id
                AND tag.project_id IS NOT note.project_id
            );

            DELETE FROM todo_tag_links
            WHERE EXISTS (
              SELECT 1
              FROM todos todo
              INNER JOIN file_tag_options tag ON tag.id = todo_tag_links.tag_id
              WHERE todo.id = todo_tag_links.todo_id
                AND tag.project_id IS NOT todo.project_id
            );

            DELETE FROM document_tag_links
            WHERE EXISTS (
              SELECT 1
              FROM documents document
              INNER JOIN file_tag_options tag ON tag.id = document_tag_links.tag_id
              WHERE document.id = document_tag_links.document_id
                AND tag.project_id IS NOT document.project_id
            );
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
              p.id, p.name, p.kind, p.status, p.root_path, p.summary, p.summary_markdown, p.summary_html,
              p.quick_note_code_language, p.is_archived, p.created_at, p.updated_at,
              0 AS activity_count,
              0 AS unorganized_count,
              (SELECT COUNT(*) FROM todos t WHERE t.scope = 'project' AND t.project_id = p.id AND t.status = 'unfinished') AS open_todo_count
            FROM projects p
            {}
            ORDER BY p.created_at DESC, p.id DESC
            "#,
            if include_archived {
                ""
            } else {
                "WHERE p.is_archived = 0"
            }
        );
        let mut stmt = self.conn.prepare(&sql)?;

        let rows = stmt.query_map([], |row| {
            let root_path_ref = row.get::<_, String>(4)?;
            Ok(ProjectListItem {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                status: row.get(3)?,
                root_path: self.decode_path_ref_to_string(&root_path_ref),
                summary: row.get(5)?,
                summary_markdown: row.get(6)?,
                summary_html: row.get(7)?,
                summary_code_language: row.get(8)?,
                is_archived: int_to_bool(row.get::<_, i64>(9)?),
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
                activity_count: row.get(12)?,
                unorganized_count: row.get(13)?,
                open_todo_count: row.get(14)?,
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
              name, kind, status, root_path, summary, summary_markdown, summary_html,
              quick_note_code_language, is_archived, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, 0, ?8, ?9)
            "#,
            params![
                project_name,
                PROJECT_KIND_NORMAL,
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

    pub fn project_page_get(&mut self, input: ProjectIdInput) -> Result<ProjectPageData> {
        self.ensure_project_file_layout(input.project_id)?;
        self.refresh_document_health(input.project_id)?;
        let project = self.project_record(input.project_id)?;
        let activity_feed = self.activity_digests(input.project_id, None)?;
        let project_documents = self.fetch_project_documents_for_project(input.project_id)?;
        let conclusion_groups = self.fetch_conclusion_groups(input.project_id)?;
        let records = self.fetch_project_notes(input.project_id)?;
        let record_groups = Vec::new(); // deprecated, kept for compatibility
        let unfinished_todos = self.fetch_project_todos(input.project_id, false)?;
        let finished_todos = self.fetch_project_todos(input.project_id, true)?;

        Ok(ProjectPageData {
            project,
            activity_feed,
            project_documents,
            conclusion_groups,
            record_groups,
            records,
            unfinished_todos,
            finished_todos,
        })
    }

    pub fn workspace_page_get(&mut self) -> Result<WorkspacePageData> {
        let quick_note = self.workspace_quick_note_get()?;
        let records = self.workspace_record_list()?;
        let all_todos = self.workspace_todo_rail_list()?;
        let (unfinished_todos, finished_todos): (Vec<_>, Vec<_>) = all_todos
            .into_iter()
            .partition(|todo| todo.status == "unfinished");

        Ok(WorkspacePageData {
            quick_note,
            records,
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

    pub fn project_update(&mut self, input: ProjectUpdateInput) -> Result<ProjectRecord> {
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
        let next_summary_code_language = input
            .summary_code_language
            .as_deref()
            .map(normalize_code_language)
            .unwrap_or_else(|| current.summary_code_language.clone());
        self.conn.execute(
            "UPDATE projects SET name = ?1, summary = ?2, summary_markdown = ?3, summary_html = ?4, quick_note_code_language = ?5, status = ?6, updated_at = ?7 WHERE id = ?8",
            params![
                project_name,
                next_summary,
                next_summary_markdown,
                next_summary_html,
                next_summary_code_language,
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

    pub fn project_delete(&mut self, input: ProjectDeleteInput) -> Result<ProjectRecord> {
        let current = self.project_record(input.project_id)?;
        let project_root = PathBuf::from(&current.root_path);
        let cleanup_paths = if project_root.exists() {
            vec![project_root]
        } else {
            Vec::new()
        };

        move_paths_to_trash(&cleanup_paths)?;
        self.conn
            .execute("DELETE FROM projects WHERE id = ?1", [input.project_id])?;
        self.mark_daily_artifacts_stale()?;

        Ok(current)
    }

    pub fn activity_create(&mut self, input: ActivityCreateInput) -> Result<ActivityCardData> {
        self.project_record(input.project_id)?;
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

    pub fn file_tag_settings_get(
        &mut self,
        input: FileTagSettingsGetInput,
    ) -> Result<FileTagSettingsSnapshot> {
        Ok(FileTagSettingsSnapshot {
            tags: self.fetch_file_tag_records(input.project_id)?,
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
            self.scoped_file_tag_record(input.project_id, tag_id)?;
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

        let tag_id = self.upsert_file_tag_by_label(input.project_id, &label, &color_key, &now)?;
        self.file_tag_record(tag_id)
    }

    pub fn file_tag_option_delete(
        &mut self,
        input: FileTagOptionDeleteInput,
    ) -> Result<FileTagSettingsSnapshot> {
        self.scoped_file_tag_record(input.project_id, input.tag_id)?;
        self.conn.execute(
            "DELETE FROM file_tag_options WHERE id = ?1",
            params![input.tag_id],
        )?;
        self.file_tag_settings_get(FileTagSettingsGetInput {
            project_id: input.project_id,
        })
    }

    pub fn contact_list(&self) -> Result<Vec<ContactRecord>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id
            FROM contacts
            ORDER BY created_at DESC, id DESC
            "#,
        )?;
        let ids = stmt
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        ids.into_iter()
            .map(|contact_id| self.contact_record(contact_id))
            .collect()
    }

    pub fn contact_search(&self, input: ContactSearchInput) -> Result<Vec<ContactRecord>> {
        let query = input.query.trim();
        let limit = input.limit.unwrap_or(20).clamp(1, 100);

        if query.is_empty() {
            let mut stmt = self.conn.prepare(
                r#"
                SELECT id
                FROM contacts
                ORDER BY created_at DESC, id DESC
                LIMIT ?1
                "#,
            )?;
            let ids = stmt
                .query_map([limit], |row| row.get::<_, i64>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            return ids
                .into_iter()
                .map(|contact_id| self.contact_record(contact_id))
                .collect();
        }

        let pattern = format!("%{}%", query.to_lowercase());
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id
            FROM contacts
            WHERE LOWER(name) LIKE ?1
               OR LOWER(pinyin_full) LIKE ?1
               OR LOWER(pinyin_abbr) LIKE ?1
               OR LOWER(email) LIKE ?1
               OR LOWER(employee_id) LIKE ?1
               OR LOWER(role) LIKE ?1
               OR LOWER(department) LIKE ?1
            ORDER BY
              CASE
                WHEN LOWER(name) = LOWER(?2) THEN 0
                WHEN LOWER(pinyin_full) = LOWER(?2) THEN 1
                WHEN LOWER(pinyin_abbr) = LOWER(?2) THEN 2
                ELSE 3
              END,
              created_at DESC,
              id DESC
            LIMIT ?3
            "#,
        )?;
        let ids = stmt
            .query_map(params![pattern, query, limit], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        ids.into_iter()
            .map(|contact_id| self.contact_record(contact_id))
            .collect()
    }

    pub fn contact_upsert(&mut self, input: ContactUpsertInput) -> Result<ContactRecord> {
        let name = validate_contact_name(&input.name)?;
        let email = normalize_contact_field(input.email.as_deref(), "email", 128)?;
        let employee_id = normalize_contact_field(input.employee_id.as_deref(), "employee id", 64)?;
        let role = normalize_contact_field(input.role.as_deref(), "role", 64)?;
        let department = normalize_contact_field(input.department.as_deref(), "department", 64)?;
        let pinyin_full = normalize_contact_pinyin(
            input.pinyin_full.as_deref(),
            &derive_contact_search_text(&name),
            "pinyin full",
        )?;
        let pinyin_abbr = normalize_contact_pinyin(
            input.pinyin_abbr.as_deref(),
            &derive_contact_search_abbr(&pinyin_full),
            "pinyin abbreviation",
        )?;
        let now = now_iso();

        if let Some(contact_id) = input.id {
            self.contact_record(contact_id)?;
            self.conn.execute(
                r#"
                UPDATE contacts
                SET name = ?1,
                    pinyin_full = ?2,
                    pinyin_abbr = ?3,
                    email = ?4,
                    employee_id = ?5,
                    role = ?6,
                    department = ?7,
                    updated_at = ?8
                WHERE id = ?9
                "#,
                params![
                    name,
                    pinyin_full,
                    pinyin_abbr,
                    email,
                    employee_id,
                    role,
                    department,
                    now,
                    contact_id
                ],
            )?;
            return self.contact_record(contact_id);
        }

        self.conn.execute(
            r#"
            INSERT INTO contacts (
              name, pinyin_full, pinyin_abbr, email, employee_id, role, department, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                name,
                pinyin_full,
                pinyin_abbr,
                email,
                employee_id,
                role,
                department,
                now,
                now
            ],
        )?;

        self.contact_record(self.conn.last_insert_rowid())
    }

    pub fn contact_delete(&mut self, input: ContactDeleteInput) -> Result<ContactRecord> {
        let current = self.contact_record(input.contact_id)?;
        self.conn
            .execute("DELETE FROM contacts WHERE id = ?1", [input.contact_id])?;
        Ok(current)
    }

    pub fn project_record_upsert(&mut self, input: ProjectRecordUpsertInput) -> Result<NoteRecord> {
        let timestamp = now_iso();
        let default_code_language = input
            .default_code_language
            .as_deref()
            .and_then(normalize_code_language);
        match input.note_id {
            Some(note_id) => {
                let current = self.note_record(note_id)?;
                self.conn.execute(
                    r#"
                    UPDATE notes
                    SET title = ?1,
                        content_markdown = ?2,
                        content_html = ?3,
                        default_code_language = ?4,
                        updated_at = ?5
                    WHERE id = ?6
                    "#,
                    params![
                        input.title,
                        input.markdown,
                        input.html,
                        default_code_language,
                        timestamp,
                        note_id
                    ],
                )?;
                self.replace_note_tags(note_id, &input.tag_ids, &timestamp)?;
                self.touch_project(current.project_id)?;
                if let Some(activity_id) = input.activity_id {
                    self.touch_activity(activity_id)?;
                }
                self.note_record(note_id)
            }
            None => {
                self.insert_project_note(
                    input.project_id,
                    input.activity_id,
                    "note",
                    input.title.as_deref(),
                    input.markdown.as_str(),
                    input.html.as_str(),
                    default_code_language.as_deref(),
                    &timestamp,
                )?;
                let note_id = self.conn.last_insert_rowid();
                self.replace_note_tags(note_id, &input.tag_ids, &timestamp)?;
                self.touch_project(input.project_id)?;
                if let Some(activity_id) = input.activity_id {
                    self.touch_activity(activity_id)?;
                }
                self.note_record(note_id)
            }
        }
    }

    pub fn project_record_delete(&mut self, input: ProjectRecordDeleteInput) -> Result<NoteRecord> {
        let current = self.note_record(input.note_id)?;
        self.conn
            .execute("DELETE FROM notes WHERE id = ?1", [input.note_id])?;
        self.touch_project(current.project_id)?;
        if let Some(activity_id) = current.activity_id {
            self.touch_activity(activity_id)?;
        }
        Ok(current)
    }

    pub fn workspace_record_list(&mut self) -> Result<Vec<WorkspaceRecord>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id
            FROM workspace_notes
            WHERE note_kind = ?1
            ORDER BY updated_at DESC, id DESC
            "#,
        )?;
        let ids = stmt
            .query_map([WORKSPACE_NOTE_KIND_STANDARD], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter()
            .map(|id| self.workspace_note_record(id))
            .collect()
    }

    pub fn workspace_record_upsert(
        &mut self,
        input: WorkspaceRecordUpsertInput,
    ) -> Result<WorkspaceRecord> {
        let timestamp = now_iso();
        let default_code_language = input
            .default_code_language
            .as_deref()
            .and_then(normalize_code_language);

        match input.note_id {
            Some(note_id) => {
                self.workspace_note_record(note_id)?;
                self.conn.execute(
                    r#"
                    UPDATE workspace_notes
                    SET title = ?1,
                        content_markdown = ?2,
                        content_html = ?3,
                        default_code_language = ?4,
                        updated_at = ?5
                    WHERE id = ?6
                    "#,
                    params![
                        input.title,
                        input.markdown,
                        input.html,
                        default_code_language,
                        timestamp,
                        note_id
                    ],
                )?;
                self.replace_workspace_note_tags(note_id, &input.tag_ids, &timestamp)?;
                self.workspace_note_record(note_id)
            }
            None => {
                self.conn.execute(
                    r#"
                    INSERT INTO workspace_notes (
                      note_kind, title, content_markdown, content_html, default_code_language, created_at, updated_at
                    )
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                    "#,
                    params![
                        WORKSPACE_NOTE_KIND_STANDARD,
                        input.title,
                        input.markdown,
                        input.html,
                        default_code_language,
                        timestamp,
                        timestamp
                    ],
                )?;
                let note_id = self.conn.last_insert_rowid();
                self.replace_workspace_note_tags(note_id, &input.tag_ids, &timestamp)?;
                self.workspace_note_record(note_id)
            }
        }
    }

    pub fn workspace_quick_note_get(&mut self) -> Result<Option<WorkspaceRecord>> {
        let quick_note_id = self
            .conn
            .query_row(
                r#"
                SELECT id
                FROM workspace_notes
                WHERE note_kind = ?1
                ORDER BY created_at DESC, id DESC
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

    pub fn workspace_quick_note_upsert(
        &mut self,
        input: WorkspaceQuickNoteUpsertInput,
    ) -> Result<WorkspaceRecord> {
        let timestamp = now_iso();
        let existing = self.workspace_quick_note_get()?;
        let default_code_language = input
            .default_code_language
            .as_deref()
            .and_then(normalize_code_language);

        match existing {
            Some(note) => {
                self.conn.execute(
                    r#"
                    UPDATE workspace_notes
                    SET title = NULL,
                        content_markdown = ?1,
                        content_html = ?2,
                        default_code_language = ?3,
                        updated_at = ?4
                    WHERE id = ?5
                    "#,
                    params![
                        input.markdown,
                        input.html,
                        default_code_language,
                        timestamp,
                        note.id
                    ],
                )?;
                self.replace_workspace_note_tags(note.id, &input.tag_ids, &timestamp)?;
                self.workspace_note_record(note.id)
            }
            None => {
                self.conn.execute(
                    r#"
                    INSERT INTO workspace_notes (
                      note_kind, title, content_markdown, content_html, default_code_language, created_at, updated_at
                    )
                    VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6)
                    "#,
                    params![
                        WORKSPACE_NOTE_KIND_TODAY_QUICK,
                        input.markdown,
                        input.html,
                        default_code_language,
                        timestamp,
                        timestamp
                    ],
                )?;
                let note_id = self.conn.last_insert_rowid();
                self.replace_workspace_note_tags(note_id, &input.tag_ids, &timestamp)?;
                self.workspace_note_record(note_id)
            }
        }
    }

    pub fn workspace_record_delete(
        &mut self,
        input: WorkspaceRecordDeleteInput,
    ) -> Result<WorkspaceRecord> {
        let current = self.workspace_note_record(input.note_id)?;
        self.conn.execute(
            "DELETE FROM workspace_note_tag_links WHERE workspace_note_id = ?1",
            [input.note_id],
        )?;
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
        let scope = input.scope;
        self.validate_todo_internal_references(scope, input.project_id, &input.content, None)?;
        let scope_value = match scope {
            TodoScope::Workspace => "workspace",
            TodoScope::Project => "project",
        };
        let tag_scope = match scope {
            TodoScope::Workspace => None,
            TodoScope::Project => input.project_id,
        };
        let tag_ids = self.validated_todo_tag_ids(tag_scope, &input.tag_ids)?;
        let timestamp = now_iso();
        self.conn.execute(
            r#"
            INSERT INTO todos (
              scope, project_id, activity_id, content, status, priority, due_date, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, 'unfinished', ?5, ?6, ?7, ?8)
            "#,
            params![
                scope_value,
                input.project_id,
                input.activity_id,
                input.content,
                input.priority,
                input.due_date,
                timestamp,
                timestamp
            ],
        )?;
        let id = self.conn.last_insert_rowid();
        self.write_todo_tags(id, &tag_ids, &timestamp)?;
        let record = self.todo_record(id)?;
        self.touch_todo_owners(&record)?;
        Ok(record)
    }

    pub fn todo_update_content(&mut self, input: TodoUpdateContentInput) -> Result<TodoRecord> {
        let current = self.todo_record(input.todo_id)?;
        self.validate_todo_internal_references(
            current.scope,
            current.project_id,
            &input.content,
            Some(&current.content),
        )?;
        let tag_ids = self.validated_todo_tag_ids(current.project_id, &input.tag_ids)?;
        let timestamp = now_iso();
        self.conn.execute(
            "UPDATE todos SET content = ?1, due_date = ?2, updated_at = ?3 WHERE id = ?4",
            params![input.content, input.due_date, timestamp, input.todo_id],
        )?;
        self.write_todo_tags(input.todo_id, &tag_ids, &timestamp)?;
        let record = self.todo_record(input.todo_id)?;
        self.touch_todo_owners(&record)?;
        Ok(record)
    }

    pub fn todo_update_tags(&mut self, input: TodoUpdateTagsInput) -> Result<TodoRecord> {
        let timestamp = now_iso();
        let current = self.todo_record(input.todo_id)?;
        self.replace_todo_tags(input.todo_id, &input.tag_ids, &timestamp)?;
        self.conn.execute(
            "UPDATE todos SET updated_at = ?1 WHERE id = ?2",
            params![timestamp, input.todo_id],
        )?;
        self.touch_todo_owners(&current)?;
        self.todo_record(input.todo_id)
    }

    pub fn todo_update_status(&mut self, input: TodoUpdateStatusInput) -> Result<TodoRecord> {
        self.conn.execute(
            "UPDATE todos SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![input.status, now_iso(), input.todo_id],
        )?;
        let record = self.todo_record(input.todo_id)?;
        self.touch_todo_owners(&record)?;
        Ok(record)
    }

    pub fn todo_update_priority(&mut self, input: TodoUpdatePriorityInput) -> Result<TodoRecord> {
        self.conn.execute(
            "UPDATE todos SET priority = ?1, updated_at = ?2 WHERE id = ?3",
            params![input.priority, now_iso(), input.todo_id],
        )?;
        let record = self.todo_record(input.todo_id)?;
        self.touch_todo_owners(&record)?;
        Ok(record)
    }

    pub fn todo_add_progress(&mut self, input: TodoAddProgressInput) -> Result<TodoProgressRecord> {
        let timestamp = now_iso();
        let todo = self.todo_record(input.todo_id)?;
        self.validate_todo_internal_references(todo.scope, todo.project_id, &input.content, None)?;
        let order_index = self.next_todo_subitem_order_index(input.todo_id)?;
        self.conn.execute(
            r#"
            INSERT INTO todo_progresses (todo_id, content, progress_date, due_date, status, completed_at, order_index, created_at)
            VALUES (?1, ?2, ?3, ?4, 'unfinished', NULL, ?5, ?6)
            "#,
            params![
                input.todo_id,
                input.content,
                input.progress_date,
                input.due_date,
                order_index,
                timestamp
            ],
        )?;
        self.conn.execute(
            "UPDATE todos SET updated_at = ?1 WHERE id = ?2",
            params![now_iso(), input.todo_id],
        )?;
        let progress_id = self.conn.last_insert_rowid();
        self.touch_todo_owners(&todo)?;
        self.todo_progress_record(progress_id)
    }

    pub fn todo_update_progress(
        &mut self,
        input: TodoUpdateProgressInput,
    ) -> Result<TodoProgressRecord> {
        let current = self.todo_progress_record(input.progress_id)?;
        let todo = self.todo_record(current.todo_id)?;
        self.validate_todo_internal_references(
            todo.scope,
            todo.project_id,
            &input.content,
            Some(&current.content),
        )?;
        let timestamp = now_iso();
        let next_status = input.status.unwrap_or_else(|| current.status.clone());
        if !matches!(next_status.as_str(), "unfinished" | "finished") {
            return Err(anyhow!("Unsupported todo subitem status: {}", next_status));
        }
        let completed_at = if next_status == "finished" {
            current
                .completed_at
                .clone()
                .or_else(|| Some(timestamp.clone()))
        } else {
            None
        };

        self.conn.execute(
            "UPDATE todo_progresses SET content = ?1, progress_date = ?2, due_date = ?3, status = ?4, completed_at = ?5 WHERE id = ?6",
            params![
                input.content,
                input.progress_date,
                input.due_date,
                next_status,
                completed_at,
                input.progress_id
            ],
        )?;
        self.conn.execute(
            "UPDATE todos SET updated_at = ?1 WHERE id = ?2",
            params![timestamp, current.todo_id],
        )?;
        self.touch_todo_owners(&todo)?;
        self.todo_progress_record(input.progress_id)
    }

    fn validate_todo_internal_references(
        &mut self,
        source_scope: TodoScope,
        source_project_id: Option<i64>,
        content: &str,
        existing_content: Option<&str>,
    ) -> Result<()> {
        let existing_references = existing_content
            .map(parse_internal_reference_tokens)
            .unwrap_or_default()
            .into_iter()
            .collect::<HashSet<_>>();

        for (kind, id) in parse_internal_reference_tokens(content) {
            let Some(target) = self.internal_reference_resolve(InternalReferenceResolveInput {
                kind: kind.clone(),
                id,
            })?
            else {
                return Err(anyhow!(
                    "Internal Reference 已失效，请移除或重新选择后再提交"
                ));
            };

            if source_scope == TodoScope::Project {
                if target.scope == TodoScope::Workspace {
                    return Err(anyhow!("Project Todo 不能引用 Workspace 内容"));
                }
                if target.project_id != source_project_id {
                    return Err(anyhow!("Project Todo 不能引用其他 Project 的内容"));
                }
            } else if let Some(target_project_id) = target.project_id {
                let target_is_archived = self.conn.query_row(
                    "SELECT is_archived FROM projects WHERE id = ?1",
                    [target_project_id],
                    |row| row.get::<_, bool>(0),
                )?;
                if target_is_archived && !existing_references.contains(&(kind, id)) {
                    return Err(anyhow!("Workspace Todo 不能新增指向已归档 Project 的引用"));
                }
            }
        }
        Ok(())
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
        self.touch_todo_owners(&todo)?;
        Ok(current)
    }

    pub fn todo_delete(&mut self, input: TodoDeleteInput) -> Result<TodoRecord> {
        let current = self.todo_record(input.todo_id)?;
        self.conn
            .execute("DELETE FROM todos WHERE id = ?1", [input.todo_id])?;
        self.touch_todo_owners(&current)?;
        Ok(current)
    }

    pub fn todo_list_open(&mut self, input: ProjectIdInput) -> Result<Vec<TodoRecord>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id FROM todos
            WHERE project_id = ?1 AND status = 'unfinished'
            ORDER BY created_at DESC, id DESC
            "#,
        )?;
        let ids = stmt
            .query_map([input.project_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().map(|id| self.todo_record(id)).collect()
    }

    pub fn workspace_todo_rail_list(&mut self) -> Result<Vec<TodoRecord>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT t.id
            FROM todos t
            LEFT JOIN projects p ON p.id = t.project_id
            WHERE t.scope = 'workspace'
               OR (t.scope = 'project' AND p.is_archived = 0)
            ORDER BY
              CASE WHEN t.status = 'unfinished' THEN 0 ELSE 1 END,
              t.created_at DESC,
              t.id DESC
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

    pub fn workspace_note_image_import(
        &mut self,
        input: WorkspaceNoteImageImportInput,
    ) -> Result<WorkspaceNoteImageAsset> {
        let source = PathBuf::from(input.source_path.trim());
        if !source.exists() {
            return Err(anyhow!("source file does not exist"));
        }

        let mime_type = mime_guess::from_path(&source)
            .first_or_octet_stream()
            .essence_str()
            .to_string();
        let file_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| anyhow!("invalid file name"))?
            .to_string();
        let sanitized_name = sanitize_import_file_name(&file_name, &mime_type)?;
        let target_dir = self.workspace_note_image_target_dir()?;
        let resolved_name = resolve_unique_file_name(&target_dir, &sanitized_name);
        let managed_path = target_dir.join(&resolved_name);

        fs::copy(&source, &managed_path).with_context(|| {
            format!(
                "failed to copy workspace note image from {} to {}",
                source.display(),
                managed_path.display()
            )
        })?;

        Ok(WorkspaceNoteImageAsset {
            title: resolved_name,
            path: managed_path.to_string_lossy().to_string(),
            mime_type,
        })
    }

    pub fn workspace_clipboard_note_image_import(
        &mut self,
        input: WorkspaceClipboardNoteImageImportInput,
    ) -> Result<WorkspaceNoteImageAsset> {
        let file_name = sanitize_import_file_name(&input.file_name, &input.mime_type)?;
        let target_dir = self.workspace_note_image_target_dir()?;
        let resolved_name = resolve_unique_file_name(&target_dir, &file_name);
        let managed_path = target_dir.join(&resolved_name);
        let bytes = STANDARD
            .decode(input.data_base64.trim())
            .context("failed to decode workspace clipboard image")?;

        fs::write(&managed_path, &bytes).with_context(|| {
            format!(
                "failed to write workspace note image to {}",
                managed_path.display()
            )
        })?;

        Ok(WorkspaceNoteImageAsset {
            title: resolved_name,
            path: managed_path.to_string_lossy().to_string(),
            mime_type: input.mime_type,
        })
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

    pub fn ai_settings_get(&mut self) -> Result<AiSettingsSnapshot> {
        let profiles = self.fetch_ai_profiles().unwrap_or_else(|_| {
            let _ = self.clear_ai_profiles_and_bindings();
            Vec::new()
        });
        let bindings = self.fetch_ai_bindings().unwrap_or_else(|_| {
            let _ = self.clear_ai_bindings();
            AI_CAPABILITIES
                .iter()
                .map(|capability| AiCapabilityBindingRecord {
                    capability: (*capability).to_string(),
                    use_default: *capability != "default",
                    profile_id: None,
                    model: None,
                    updated_at: String::new(),
                })
                .collect::<Vec<_>>()
        });
        let execution = self.ai_execution_settings_get().unwrap_or_else(|_| {
            let _ = self.clear_app_setting(APP_SETTING_KEY_AI_EXECUTION_SETTINGS);
            default_ai_execution_settings()
        });
        let editor_skills = self.ai_editor_skills_get().unwrap_or_else(|_| {
            let _ = self.clear_app_setting(APP_SETTING_KEY_AI_EDITOR_SKILLS);
            Vec::new()
        });
        let has_usable_default = self
            .has_usable_profile_for_capability("default")
            .unwrap_or(false);

        Ok(AiSettingsSnapshot {
            has_usable_default,
            profiles,
            bindings,
            security_mode: WORKSPACE_SECURITY_MODE.to_string(),
            ai_secrets_unlocked: self.secret_password.is_some(),
            execution,
            editor_skills,
        })
    }

    pub fn ai_editor_skills_get(&mut self) -> Result<Vec<AiEditorSkillRecord>> {
        let stored = self
            .conn
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = ?1",
                params![APP_SETTING_KEY_AI_EDITOR_SKILLS],
                |row| row.get::<_, String>(0),
            )
            .optional()?;

        let mut skills = if let Some(value_json) = stored {
            serde_json::from_str::<Vec<AiEditorSkillRecord>>(&value_json)
                .context("failed to parse AI editor skills")?
        } else {
            let legacy_actions = self.ai_editor_rewrite_actions_get().unwrap_or_default();
            let next_skills = if legacy_actions.is_empty() {
                default_ai_editor_skills()
            } else {
                legacy_actions
                    .into_iter()
                    .enumerate()
                    .map(|(index, action)| AiEditorSkillRecord {
                        id: format!("rewrite-action-{}", action.id),
                        name: action.label,
                        icon: None,
                        description: None,
                        prompt: action.prompt,
                        result_mode: "modify".to_string(),
                        show_in_text_menu: true,
                        sort_order: index as i64 + 1,
                        enabled: action.enabled,
                        created_at: action.created_at,
                        updated_at: action.updated_at,
                    })
                    .collect()
            };
            self.persist_ai_editor_skills(&next_skills)?;
            next_skills
        };

        for skill in &skills {
            validate_ai_editor_skill(skill)?;
        }

        skills.sort_by(|left, right| {
            left.sort_order
                .cmp(&right.sort_order)
                .then_with(|| left.created_at.cmp(&right.created_at))
                .then_with(|| left.id.cmp(&right.id))
        });

        Ok(skills)
    }

    pub fn ai_editor_skill_upsert(
        &mut self,
        input: AiEditorSkillUpsertInput,
    ) -> Result<AiEditorSkillRecord> {
        validate_ai_editor_skill_fields(
            &input.name,
            input.icon.as_deref(),
            input.description.as_deref(),
            &input.prompt,
            &input.result_mode,
        )?;

        let mut skills = self.ai_editor_skills_get()?;
        let now = now_iso();
        let saved =
            if let Some(skill_id) = input.id.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
                let skill = skills
                    .iter_mut()
                    .find(|skill| skill.id == skill_id)
                    .ok_or_else(|| anyhow!("AI editor skill does not exist"))?;
                skill.name = input.name.trim().to_string();
                skill.icon = nullable_trimmed(input.icon.as_deref());
                skill.description = nullable_trimmed(input.description.as_deref());
                skill.prompt = input.prompt.trim().to_string();
                skill.result_mode = normalize_ai_editor_skill_result_mode(&input.result_mode)?;
                skill.show_in_text_menu = input.show_in_text_menu;
                skill.sort_order = input.sort_order.unwrap_or(skill.sort_order);
                skill.enabled = input.enabled;
                skill.updated_at = now.clone();
                skill.clone()
            } else {
                if skills.len() >= AI_EDITOR_SKILL_LIMIT {
                    return Err(anyhow!(
                        "AI editor skills cannot exceed {}",
                        AI_EDITOR_SKILL_LIMIT
                    ));
                }
                let sort_order = input.sort_order.unwrap_or_else(|| {
                    skills
                        .iter()
                        .map(|skill| skill.sort_order)
                        .max()
                        .unwrap_or(0)
                        + 1
                });
                let skill = AiEditorSkillRecord {
                    id: next_ai_editor_skill_id(&skills),
                    name: input.name.trim().to_string(),
                    icon: nullable_trimmed(input.icon.as_deref()),
                    description: nullable_trimmed(input.description.as_deref()),
                    prompt: input.prompt.trim().to_string(),
                    result_mode: normalize_ai_editor_skill_result_mode(&input.result_mode)?,
                    show_in_text_menu: input.show_in_text_menu,
                    sort_order,
                    enabled: input.enabled,
                    created_at: now.clone(),
                    updated_at: now,
                };
                skills.push(skill.clone());
                skill
            };

        normalize_ai_editor_skill_sort_orders(&mut skills);
        self.persist_ai_editor_skills(&skills)?;
        Ok(saved)
    }

    pub fn ai_editor_skill_delete(
        &mut self,
        input: AiEditorSkillDeleteInput,
    ) -> Result<Vec<AiEditorSkillRecord>> {
        let mut skills = self.ai_editor_skills_get()?;
        let initial_len = skills.len();
        let skill_id = input.skill_id.trim();
        skills.retain(|skill| skill.id != skill_id);
        if skills.len() == initial_len {
            return Err(anyhow!("AI editor skill does not exist"));
        }

        normalize_ai_editor_skill_sort_orders(&mut skills);
        self.persist_ai_editor_skills(&skills)?;
        Ok(skills)
    }

    pub fn ai_editor_skill_reorder(
        &mut self,
        input: AiEditorSkillReorderInput,
    ) -> Result<Vec<AiEditorSkillRecord>> {
        let mut skills = self.ai_editor_skills_get()?;
        if input.skill_ids.len() != skills.len() {
            return Err(anyhow!("AI editor skill reorder must include every skill"));
        }

        let mut order_by_id = BTreeMap::new();
        for (index, skill_id) in input.skill_ids.iter().enumerate() {
            let skill_id = skill_id.trim();
            if skill_id.is_empty()
                || order_by_id
                    .insert(skill_id.to_string(), index as i64 + 1)
                    .is_some()
            {
                return Err(anyhow!(
                    "AI editor skill reorder contains duplicate or empty ids"
                ));
            }
        }

        for skill in &mut skills {
            let Some(sort_order) = order_by_id.get(&skill.id).copied() else {
                return Err(anyhow!("AI editor skill reorder contains unknown ids"));
            };
            skill.sort_order = sort_order;
            skill.updated_at = now_iso();
        }

        self.persist_ai_editor_skills(&skills)?;
        self.ai_editor_skills_get()
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
            if actions.len() >= AI_EDITOR_REWRITE_ACTION_LIMIT {
                return Err(anyhow!(
                    "AI editor rewrite actions cannot exceed {}",
                    AI_EDITOR_REWRITE_ACTION_LIMIT
                ));
            }
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

    fn persist_ai_editor_skills(&mut self, skills: &[AiEditorSkillRecord]) -> Result<()> {
        let value_json = serde_json::to_string(skills)?;
        let now = now_iso();
        self.conn.execute(
            r#"
            INSERT INTO app_settings (key, value_json, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(key) DO UPDATE SET
              value_json = excluded.value_json,
              updated_at = excluded.updated_at
            "#,
            params![APP_SETTING_KEY_AI_EDITOR_SKILLS, value_json, now],
        )?;
        Ok(())
    }

    fn insert_project_note(
        &self,
        project_id: i64,
        activity_id: Option<i64>,
        note_type: &str,
        title: Option<&str>,
        markdown: &str,
        html: &str,
        default_code_language: Option<&str>,
        timestamp: &str,
    ) -> Result<()> {
        if self.has_column("notes", "note_type")? {
            self.conn.execute(
                r#"
                INSERT INTO notes (
                  project_id, activity_id, note_type, title, content_markdown, content_html,
                  default_code_language, created_at, updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                "#,
                params![
                    project_id,
                    activity_id,
                    note_type,
                    title,
                    markdown,
                    html,
                    default_code_language,
                    timestamp,
                    timestamp
                ],
            )?;
        } else {
            self.conn.execute(
                r#"
                INSERT INTO notes (
                  project_id, activity_id, title, content_markdown, content_html,
                  default_code_language, created_at, updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                "#,
                params![
                    project_id,
                    activity_id,
                    title,
                    markdown,
                    html,
                    default_code_language,
                    timestamp,
                    timestamp
                ],
            )?;
        }
        Ok(())
    }

    fn clear_app_setting(&self, key: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM app_settings WHERE key = ?1", params![key])?;
        Ok(())
    }

    fn clear_ai_bindings(&self) -> Result<()> {
        self.conn
            .execute("DELETE FROM ai_capability_bindings", [])?;
        Ok(())
    }

    fn clear_ai_profiles_and_bindings(&self) -> Result<()> {
        self.clear_ai_bindings()?;
        self.conn.execute("DELETE FROM ai_provider_profiles", [])?;
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
        let _request_capabilities = (input.supports_image, input.supports_file, input.enabled);
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
        let result_mode = normalize_ai_editor_rewrite_result_mode(&input.result_mode)?;
        let skill_id = input
            .skill_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        let skill_name = input
            .skill_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("AI 编辑")
            .to_string();
        let skill_prompt = input
            .prompt
            .as_deref()
            .or(input.prompt_override.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        let skill_prompt = match (skill_prompt, input.action_id) {
            (Some(prompt), _) => prompt,
            (None, Some(action_id)) => {
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
            (None, None) => {
                return Err(anyhow!("AI editor skill prompt cannot be empty"));
            }
        };

        let selected_markdown = input
            .expanded_markdown
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| input.selected_text.trim());
        if selected_markdown.is_empty() {
            return Err(anyhow!("selected text cannot be empty"));
        }

        let profile = self.resolve_profile_for_capability("editor_rewrite")?;
        let payload = ai_provider::run_editor_skill(
            &profile,
            &skill_name,
            &skill_prompt,
            &result_mode,
            selected_markdown,
            &input.placeholder_tokens,
            input.document_context.as_deref(),
            |stream_text| on_stream(stream_text),
        )?;
        let content = normalize_ai_editor_rewrite_markdown(&payload.content);
        let replacement_markdown = payload
            .replacement_markdown
            .as_deref()
            .map(normalize_ai_editor_rewrite_markdown)
            .filter(|value| !value.is_empty());
        let answer_markdown = payload
            .answer_markdown
            .as_deref()
            .map(normalize_ai_editor_rewrite_markdown)
            .filter(|value| !value.is_empty());
        if let Some(replacement) = replacement_markdown.as_deref() {
            validate_rewrite_placeholder_tokens(replacement, &input.placeholder_tokens)?;
        }

        Ok(AiEditorRewriteResult {
            skill_id,
            result_mode,
            content,
            replacement_markdown,
            answer_markdown,
            resolved_model: payload.resolved_model,
        })
    }

    pub fn execute_ai_job_with_progress(
        &mut self,
        input: AiJobEnqueueInput,
        mut on_stream: impl FnMut(String),
    ) -> Result<AiJobResult> {
        match input {
            AiJobEnqueueInput::ProfileTest { input, .. } => {
                let test_result = self.ai_profile_test(input)?;
                Ok(AiJobResult::ProfileTest { test_result })
            }
            AiJobEnqueueInput::EditorRewrite { input, .. } => {
                let rewrite =
                    self.ai_editor_rewrite(input, |stream_text| on_stream(stream_text))?;
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
                    scope: None,
                    project_id: Some(row.get(0)?),
                    activity_id: None,
                    source: None,
                    title: title.clone(),
                    subtitle: summary.clone(),
                    matched_text: workspace_search_match_excerpt(
                        &[title.as_str(), summary.as_str()],
                        query,
                    ),
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
            SELECT
              a.id,
              a.project_id,
              a.title,
              COALESCE(NULLIF(TRIM(a.brief_markdown), ''), '') AS brief_match_text,
              p.name,
              a.updated_at
            FROM activities a
            INNER JOIN projects p ON p.id = a.project_id
            WHERE (
              a.title LIKE ?1
              OR COALESCE(NULLIF(TRIM(a.brief_markdown), ''), '') LIKE ?1
            ) {}
            "#,
            project_filter
        );
        let mut stmt = self.conn.prepare(&activity_sql)?;
        let rows = stmt.query_map([pattern.as_str()], |row| {
            let activity_id: i64 = row.get(0)?;
            let title: String = row.get(2)?;
            let brief: String = row.get(3)?;
            Ok(WorkspaceSearchCandidate {
                result: WorkspaceSearchResult {
                    kind: "activity".to_string(),
                    id: activity_id,
                    scope: None,
                    project_id: Some(row.get(1)?),
                    activity_id: Some(activity_id),
                    source: None,
                    title: normalize_activity_title(&title, activity_id),
                    subtitle: row.get(4)?,
                    matched_text: workspace_search_match_excerpt(
                        &[title.as_str(), brief.as_str()],
                        query,
                    ),
                },
                fields: build_workspace_search_fields([
                    (WORKSPACE_SEARCH_PRIORITY_ACTIVITY_TITLE, title),
                    (WORKSPACE_SEARCH_PRIORITY_ACTIVITY_BRIEF, brief),
                ]),
                updated_at: row.get(5)?,
            })
        })?;
        candidates.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);

        let workspace_note_sql = r#"
            SELECT
              wn.id,
              wn.note_kind,
              COALESCE(NULLIF(TRIM(wn.title), ''), '') AS title_match_text,
              COALESCE(NULLIF(TRIM(wn.content_markdown), ''), '') AS content_match_text,
              COALESCE((
                SELECT GROUP_CONCAT(ft.label, ' ')
                FROM workspace_note_tag_links wntl
                INNER JOIN file_tag_options ft ON ft.id = wntl.tag_id
                WHERE wntl.workspace_note_id = wn.id
              ), '') AS tag_match_text,
              wn.updated_at
            FROM workspace_notes wn
            WHERE wn.title LIKE ?1
              OR wn.content_markdown LIKE ?1
              OR EXISTS (
                SELECT 1
                FROM workspace_note_tag_links wntl
                INNER JOIN file_tag_options ft ON ft.id = wntl.tag_id
                WHERE wntl.workspace_note_id = wn.id
                  AND ft.label LIKE ?1
              )
        "#;
        let mut stmt = self.conn.prepare(workspace_note_sql)?;
        let rows = stmt.query_map([pattern.as_str()], |row| {
            let note_id: i64 = row.get(0)?;
            let note_kind: String = row.get(1)?;
            let title: String = row.get(2)?;
            let content: String = row.get(3)?;
            let tags: String = row.get(4)?;
            let kind = if note_kind == WORKSPACE_NOTE_KIND_TODAY_QUICK {
                "workspace_quick_note"
            } else {
                "workspace_note"
            };
            let display_title = if kind == "workspace_quick_note" {
                "Workspace 快速笔记".to_string()
            } else if title.trim().is_empty() {
                truncate_text(&normalize_internal_reference_label("note", &content), 72)
            } else {
                title.clone()
            };

            Ok(WorkspaceSearchCandidate {
                result: WorkspaceSearchResult {
                    kind: kind.to_string(),
                    id: note_id,
                    scope: None,
                    project_id: None,
                    activity_id: None,
                    source: None,
                    title: display_title,
                    subtitle: "Workspace".to_string(),
                    matched_text: workspace_search_match_excerpt(
                        &[title.as_str(), content.as_str(), tags.as_str()],
                        query,
                    ),
                },
                fields: build_workspace_search_fields([
                    (WORKSPACE_SEARCH_PRIORITY_WORKSPACE_NOTE_TITLE, title),
                    (WORKSPACE_SEARCH_PRIORITY_NOTE_CONTENT, content),
                    (WORKSPACE_SEARCH_PRIORITY_TAG, tags),
                ]),
                updated_at: row.get(5)?,
            })
        })?;
        candidates.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);

        let contact_sql = r#"
            SELECT
              id,
              name,
              pinyin_full,
              pinyin_abbr,
              email,
              employee_id,
              role,
              department,
              updated_at
            FROM contacts
            WHERE name LIKE ?1
              OR pinyin_full LIKE ?1
              OR pinyin_abbr LIKE ?1
              OR email LIKE ?1
              OR employee_id LIKE ?1
              OR role LIKE ?1
              OR department LIKE ?1
        "#;
        let mut stmt = self.conn.prepare(contact_sql)?;
        let rows = stmt.query_map([pattern.as_str()], |row| {
            let name: String = row.get(1)?;
            let pinyin_full: String = row.get(2)?;
            let pinyin_abbr: String = row.get(3)?;
            let email: String = row.get(4)?;
            let employee_id: String = row.get(5)?;
            let role: String = row.get(6)?;
            let department: String = row.get(7)?;
            let subtitle = [department.as_str(), role.as_str(), email.as_str()]
                .into_iter()
                .filter(|value| !value.trim().is_empty())
                .collect::<Vec<_>>()
                .join(" · ");

            Ok(WorkspaceSearchCandidate {
                result: WorkspaceSearchResult {
                    kind: "contact".to_string(),
                    id: row.get(0)?,
                    scope: None,
                    project_id: None,
                    activity_id: None,
                    source: None,
                    title: name.clone(),
                    subtitle,
                    matched_text: workspace_search_match_excerpt(
                        &[
                            name.as_str(),
                            pinyin_full.as_str(),
                            pinyin_abbr.as_str(),
                            email.as_str(),
                            employee_id.as_str(),
                            role.as_str(),
                            department.as_str(),
                        ],
                        query,
                    ),
                },
                fields: build_workspace_search_fields([
                    (WORKSPACE_SEARCH_PRIORITY_CONTACT_NAME, name),
                    (WORKSPACE_SEARCH_PRIORITY_CONTACT_NAME, pinyin_full),
                    (WORKSPACE_SEARCH_PRIORITY_CONTACT_NAME, pinyin_abbr),
                    (WORKSPACE_SEARCH_PRIORITY_CONTACT_META, email),
                    (WORKSPACE_SEARCH_PRIORITY_CONTACT_META, employee_id),
                    (WORKSPACE_SEARCH_PRIORITY_CONTACT_META, role),
                    (WORKSPACE_SEARCH_PRIORITY_CONTACT_META, department),
                ]),
                updated_at: row.get(8)?,
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
              COALESCE((
                SELECT GROUP_CONCAT(ft.label, ' ')
                FROM note_tag_links ntl
                INNER JOIN file_tag_options ft ON ft.id = ntl.tag_id
                WHERE ntl.note_id = n.id
              ), '') AS tag_match_text,
              p.name AS project_name,
              n.updated_at
            FROM notes n
            INNER JOIN projects p ON p.id = n.project_id
            WHERE (
              (
                NULLIF(TRIM(n.title), '') IS NOT NULL
                AND TRIM(n.title) != '记录'
                AND TRIM(n.title) LIKE ?1
              )
              OR COALESCE(NULLIF(TRIM(n.content_markdown), ''), '') LIKE ?1
              OR EXISTS (
                SELECT 1
                FROM note_tag_links ntl
                INNER JOIN file_tag_options ft ON ft.id = ntl.tag_id
                WHERE ntl.note_id = n.id
                  AND ft.label LIKE ?1
              )
            ) {}
            "#,
            project_filter
        );
        let mut stmt = self.conn.prepare(&note_sql)?;
        let rows = stmt.query_map([pattern.as_str()], |row| {
            let title: String = row.get(3)?;
            let title_match_text: String = row.get(4)?;
            let content_match_text: String = row.get(5)?;
            let tag_match_text: String = row.get(6)?;
            let project_name: String = row.get(7)?;
            Ok(WorkspaceSearchCandidate {
                result: WorkspaceSearchResult {
                    kind: "note".to_string(),
                    id: row.get(0)?,
                    scope: None,
                    project_id: Some(row.get(1)?),
                    activity_id: row.get(2)?,
                    source: None,
                    title: truncate_text(&normalize_internal_reference_label("note", &title), 72),
                    subtitle: project_name,
                    matched_text: workspace_search_match_excerpt(
                        &[
                            title_match_text.as_str(),
                            content_match_text.as_str(),
                            tag_match_text.as_str(),
                        ],
                        query,
                    ),
                },
                fields: build_workspace_search_fields([
                    (WORKSPACE_SEARCH_PRIORITY_NOTE_TITLE, title_match_text),
                    (WORKSPACE_SEARCH_PRIORITY_NOTE_CONTENT, content_match_text),
                    (WORKSPACE_SEARCH_PRIORITY_TAG, tag_match_text),
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
              p.name,
              c.updated_at
            FROM conclusions c
            INNER JOIN projects p ON p.id = c.project_id
            WHERE (
              COALESCE(NULLIF(c.content_markdown, ''), c.content) LIKE ?1
            ) {}
            "#,
            project_filter
        );
        let mut stmt = self.conn.prepare(&conclusion_sql)?;
        let rows = stmt.query_map([pattern.as_str()], |row| {
            let content: String = row.get(3)?;
            let project_title: String = row.get(4)?;
            Ok(WorkspaceSearchCandidate {
                result: WorkspaceSearchResult {
                    kind: "conclusion".to_string(),
                    id: row.get(0)?,
                    scope: None,
                    project_id: Some(row.get(1)?),
                    activity_id: row.get(2)?,
                    source: None,
                    title: truncate_text(
                        &normalize_internal_reference_label("conclusion", &content),
                        72,
                    ),
                    subtitle: project_title.clone(),
                    matched_text: workspace_search_match_excerpt(&[content.as_str()], query),
                },
                fields: build_workspace_search_fields([(
                    WORKSPACE_SEARCH_PRIORITY_CONCLUSION_CONTENT,
                    content,
                )]),
                updated_at: row.get(5)?,
            })
        })?;
        candidates.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);

        let todo_sql = format!(
            r#"
            SELECT
              t.id,
              t.scope,
              t.project_id,
              t.activity_id,
              t.content,
              COALESCE((
                SELECT GROUP_CONCAT(tp.content, ' ')
                FROM todo_progresses tp
                WHERE tp.todo_id = t.id
              ), '') AS progress_match_text,
              COALESCE((
                SELECT GROUP_CONCAT(ft.label, ' ')
                FROM todo_tag_links ttl
                INNER JOIN file_tag_options ft ON ft.id = ttl.tag_id
                WHERE ttl.todo_id = t.id
              ), '') AS tag_match_text,
              COALESCE(p.name, 'Workspace'),
              t.updated_at
            FROM todos t
            LEFT JOIN projects p ON p.id = t.project_id
            WHERE (
              t.content LIKE ?1
              OR EXISTS (
                SELECT 1 FROM todo_progresses tp
                WHERE tp.todo_id = t.id AND tp.content LIKE ?1
              )
              OR EXISTS (
                SELECT 1
                FROM todo_tag_links ttl
                INNER JOIN file_tag_options ft ON ft.id = ttl.tag_id
                WHERE ttl.todo_id = t.id AND ft.label LIKE ?1
              )
            )
            AND (
              t.scope = 'workspace'
              OR (t.scope = 'project' {})
            )
            "#,
            project_filter
        );
        let mut stmt = self.conn.prepare(&todo_sql)?;
        let rows = stmt.query_map([pattern.as_str()], |row| {
            let scope: String = row.get(1)?;
            let content: String = row.get(4)?;
            let progress_text: String = row.get(5)?;
            let tag_match_text: String = row.get(6)?;
            let source: String = row.get(7)?;
            Ok(WorkspaceSearchCandidate {
                result: WorkspaceSearchResult {
                    kind: "todo".to_string(),
                    id: row.get(0)?,
                    scope: Some(scope),
                    project_id: row.get(2)?,
                    activity_id: row.get(3)?,
                    source: Some(source.clone()),
                    title: truncate_text(&normalize_internal_reference_label("todo", &content), 72),
                    subtitle: String::new(),
                    matched_text: workspace_search_match_excerpt(
                        &[
                            content.as_str(),
                            progress_text.as_str(),
                            tag_match_text.as_str(),
                        ],
                        query,
                    ),
                },
                fields: build_workspace_search_fields([
                    (WORKSPACE_SEARCH_PRIORITY_TODO_CONTENT, content),
                    (WORKSPACE_SEARCH_PRIORITY_TODO_PROGRESS, progress_text),
                    (WORKSPACE_SEARCH_PRIORITY_TAG, tag_match_text),
                ]),
                updated_at: row.get(8)?,
            })
        })?;
        candidates.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);

        let document_sql = format!(
            r#"
            SELECT
              d.id,
              d.project_id,
              d.activity_id,
              d.name,
              d.base_name,
              COALESCE((
                SELECT GROUP_CONCAT(dv.name, ' ')
                FROM document_versions dv
                WHERE dv.document_id = d.id
              ), '') AS version_name_match_text,
              COALESCE((
                SELECT GROUP_CONCAT(ft.label, ' ')
                FROM document_tag_links dtl
                INNER JOIN file_tag_options ft ON ft.id = dtl.tag_id
                WHERE dtl.document_id = d.id
              ), '') AS tag_match_text,
              p.name,
              d.updated_at
            FROM documents d
            INNER JOIN projects p ON p.id = d.project_id
            WHERE (
                d.name LIKE ?1
                OR d.base_name LIKE ?1
                OR EXISTS (
                  SELECT 1
                  FROM document_versions dv
                  WHERE dv.document_id = d.id AND dv.name LIKE ?1
                )
                OR EXISTS (
                  SELECT 1
                  FROM document_tag_links dtl
                  INNER JOIN file_tag_options ft ON ft.id = dtl.tag_id
                  WHERE dtl.document_id = d.id AND ft.label LIKE ?1
                )
              )
              AND d.storage_mode != '{MANAGED_NOTE_IMAGE_STORAGE_MODE}' {}
            "#,
            project_filter
        );
        let mut stmt = self.conn.prepare(&document_sql)?;
        let rows = stmt.query_map([pattern.as_str()], |row| {
            let title: String = row.get(3)?;
            let base_name: String = row.get(4)?;
            let version_name_match_text: String = row.get(5)?;
            let tag_match_text: String = row.get(6)?;
            let project_title: String = row.get(7)?;
            Ok(WorkspaceSearchCandidate {
                result: WorkspaceSearchResult {
                    kind: "document".to_string(),
                    id: row.get(0)?,
                    scope: None,
                    project_id: Some(row.get(1)?),
                    activity_id: row.get(2)?,
                    source: None,
                    title: title.clone(),
                    subtitle: project_title,
                    matched_text: workspace_search_match_excerpt(
                        &[
                            title.as_str(),
                            base_name.as_str(),
                            version_name_match_text.as_str(),
                            tag_match_text.as_str(),
                        ],
                        query,
                    ),
                },
                fields: build_workspace_search_fields([
                    (WORKSPACE_SEARCH_PRIORITY_DOCUMENT_NAME, title),
                    (WORKSPACE_SEARCH_PRIORITY_DOCUMENT_NAME, base_name),
                    (
                        WORKSPACE_SEARCH_PRIORITY_DOCUMENT_VERSION,
                        version_name_match_text,
                    ),
                    (WORKSPACE_SEARCH_PRIORITY_TAG, tag_match_text),
                ]),
                updated_at: row.get(8)?,
            })
        })?;
        candidates.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);

        if let Some(project_id) = input.project_id {
            candidates.retain(|candidate| {
                candidate.result.kind == "todo"
                    && candidate.result.scope.as_deref() == Some("project")
                    && candidate.result.project_id == Some(project_id)
            });
        }

        let mut ranked = candidates
            .into_iter()
            .filter_map(|candidate| {
                rank_workspace_search_candidate(&candidate, query)
                    .map(|rank| (candidate.result, candidate.updated_at, rank))
            })
            .collect::<Vec<_>>();

        ranked.sort_by(
            |(left_result, left_updated_at, left_rank),
             (right_result, right_updated_at, right_rank)| {
                left_rank
                    .cmp(right_rank)
                    .then_with(|| right_updated_at.cmp(left_updated_at))
                    .then_with(|| left_result.kind.cmp(&right_result.kind))
                    .then_with(|| left_result.id.cmp(&right_result.id))
            },
        );

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
              n.updated_at
            FROM notes n
            INNER JOIN projects p ON p.id = n.project_id
            WHERE p.is_archived = 0
              AND (?1 IS NULL OR n.project_id = ?1)
            ORDER BY n.updated_at DESC
            "#
            .to_string();
            let mut stmt = self.conn.prepare(&note_sql)?;
            let rows = stmt.query_map(params![project_id], |row| {
                let project_name: String = row.get(5)?;
                Ok(InternalReferenceSearchCandidate {
                    result: InternalReferenceSearchResult {
                        kind: "note".to_string(),
                        id: row.get(0)?,
                        scope: TodoScope::Project,
                        project_id: Some(row.get(1)?),
                        activity_id: None,
                        label: truncate_text(
                            &normalize_internal_reference_label("note", &row.get::<_, String>(2)?),
                            72,
                        ),
                        subtitle: project_name,
                        updated_at: row.get(6)?,
                    },
                    fields: build_internal_reference_search_fields([
                        (
                            INTERNAL_REFERENCE_PRIORITY_NOTE_TITLE,
                            row.get::<_, String>(3)?,
                        ),
                        (
                            INTERNAL_REFERENCE_PRIORITY_NOTE_CONTENT,
                            row.get::<_, String>(4)?,
                        ),
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
              COALESCE(NULLIF(TRIM(c.content_markdown), ''), NULLIF(TRIM(c.content), ''), '结论') AS label,
              COALESCE(NULLIF(TRIM(c.content_markdown), ''), NULLIF(TRIM(c.content), ''), '') AS content_match_text,
              p.name AS project_name,
              c.updated_at
            FROM conclusions c
            INNER JOIN projects p ON p.id = c.project_id
            WHERE p.is_archived = 0
              AND (?1 IS NULL OR c.project_id = ?1)
            ORDER BY c.updated_at DESC
            "#
            .to_string();
            let mut stmt = self.conn.prepare(&conclusion_sql)?;
            let rows = stmt.query_map(params![project_id], |row| {
                let project_name: String = row.get(4)?;
                Ok(InternalReferenceSearchCandidate {
                    result: InternalReferenceSearchResult {
                        kind: "conclusion".to_string(),
                        id: row.get(0)?,
                        scope: TodoScope::Project,
                        project_id: Some(row.get(1)?),
                        activity_id: None,
                        label: truncate_text(
                            &normalize_internal_reference_label(
                                "conclusion",
                                &row.get::<_, String>(2)?,
                            ),
                            72,
                        ),
                        subtitle: project_name,
                        updated_at: row.get(5)?,
                    },
                    fields: build_internal_reference_search_fields([(
                        INTERNAL_REFERENCE_PRIORITY_CONCLUSION_CONTENT,
                        row.get::<_, String>(3)?,
                    )]),
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
              t.scope,
              t.project_id,
              COALESCE(NULLIF(TRIM(t.content), ''), 'Todo') AS label,
              COALESCE(NULLIF(TRIM(t.content), ''), '') AS content_match_text,
              COALESCE(p.name, 'Workspace') AS scope_name,
              t.updated_at
            FROM todos t
            LEFT JOIN projects p ON p.id = t.project_id
            WHERE (
              (?1 IS NOT NULL AND t.scope = 'project' AND t.project_id = ?1)
              OR
              (?1 IS NULL AND (
                t.scope = 'workspace'
                OR (t.scope = 'project' AND p.is_archived = 0)
              ))
            )
            ORDER BY t.updated_at DESC
            "#
            .to_string();
            let mut stmt = self.conn.prepare(&todo_sql)?;
            let rows = stmt.query_map(params![project_id], |row| {
                let scope_name: String = row.get(5)?;
                Ok(InternalReferenceSearchCandidate {
                    result: InternalReferenceSearchResult {
                        kind: "todo".to_string(),
                        id: row.get(0)?,
                        scope: todo_scope_from_sql(row.get(1)?, 1)?,
                        project_id: row.get(2)?,
                        activity_id: None,
                        label: truncate_text(
                            &normalize_internal_reference_label("todo", &row.get::<_, String>(3)?),
                            72,
                        ),
                        subtitle: scope_name,
                        updated_at: row.get(6)?,
                    },
                    fields: build_internal_reference_search_fields([(
                        INTERNAL_REFERENCE_PRIORITY_TODO_CONTENT,
                        row.get::<_, String>(4)?,
                    )]),
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
              d.name AS label,
              d.name AS name_match_text,
              p.name AS project_name,
              d.updated_at
            FROM documents d
            INNER JOIN projects p ON p.id = d.project_id
            WHERE d.storage_mode != '{MANAGED_NOTE_IMAGE_STORAGE_MODE}'
              AND p.is_archived = 0
              AND (?1 IS NULL OR d.project_id = ?1)
            ORDER BY d.updated_at DESC
            "#
            );
            let mut stmt = self.conn.prepare(&document_sql)?;
            let rows = stmt.query_map(params![project_id], |row| {
                let project_name: String = row.get(4)?;
                Ok(InternalReferenceSearchCandidate {
                    result: InternalReferenceSearchResult {
                        kind: "document".to_string(),
                        id: row.get(0)?,
                        scope: TodoScope::Project,
                        project_id: Some(row.get(1)?),
                        activity_id: None,
                        label: truncate_text(
                            &normalize_internal_reference_label(
                                "document",
                                &row.get::<_, String>(2)?,
                            ),
                            72,
                        ),
                        subtitle: project_name,
                        updated_at: row.get(5)?,
                    },
                    fields: build_internal_reference_search_fields([(
                        INTERNAL_REFERENCE_PRIORITY_DOCUMENT_NAME,
                        row.get::<_, String>(3)?,
                    )]),
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
                        let label = truncate_text(
                            &normalize_internal_reference_label("note", &row.get::<_, String>(2)?),
                            72,
                        );
                        Ok(InternalReferenceResolveResult {
                            kind: "note".to_string(),
                            id,
                            label,
                            scope: TodoScope::Project,
                            project_id: Some(project_id),
                            activity_id: None,
                            route: format!("/projects/{project_id}/records/{id}"),
                            focus_id: None,
                            managed_path: None,
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
                      COALESCE(NULLIF(TRIM(c.content_markdown), ''), NULLIF(TRIM(c.content), ''), '结论')
                    FROM conclusions c
                    WHERE c.id = ?1
                    "#,
                    [input.id],
                    |row| {
                        let id: i64 = row.get(0)?;
                        let project_id: i64 = row.get(1)?;
                        Ok(InternalReferenceResolveResult {
                            kind: "conclusion".to_string(),
                            id,
                            label: truncate_text(
                                &normalize_internal_reference_label(
                                    "conclusion",
                                    &row.get::<_, String>(2)?,
                                ),
                                72,
                            ),
                            scope: TodoScope::Project,
                            project_id: Some(project_id),
                            activity_id: None,
                            route: build_internal_reference_route(project_id, None, &format!("conclusion-{id}")),
                            focus_id: Some(format!("conclusion-{id}")),
                            managed_path: None,
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
                      t.scope,
                      t.project_id,
                      COALESCE(NULLIF(TRIM(t.content), ''), 'Todo')
                    FROM todos t
                    WHERE t.id = ?1
                    "#,
                    [input.id],
                    |row| {
                        let id: i64 = row.get(0)?;
                        let scope = todo_scope_from_sql(row.get(1)?, 1)?;
                        let project_id: Option<i64> = row.get(2)?;
                        let route = if scope == TodoScope::Workspace {
                            format!("/?focus=todo-{id}")
                        } else {
                            build_internal_reference_route(
                                project_id.expect("Project Todo must have project_id"),
                                None,
                                &format!("todo-{id}"),
                            )
                        };
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
                            scope,
                            project_id,
                            activity_id: None,
                            route,
                            focus_id: Some(format!("todo-{id}")),
                            managed_path: None,
                        })
                    },
                )
                .optional()
                .map_err(Into::into),
            "document" => {
                let resolved = self.conn.query_row(
                    r#"
                    SELECT
                      d.id,
                      d.project_id,
                      d.name,
                      d.managed_path
                    FROM documents d
                    WHERE d.id = ?1
                      AND d.storage_mode != ?2
                    "#,
                    params![input.id, MANAGED_NOTE_IMAGE_STORAGE_MODE],
                    |row| {
                        let id: i64 = row.get(0)?;
                        let project_id: i64 = row.get(1)?;
                        let name: String = row.get(2)?;
                        let managed_path_ref: String = row.get(3)?;
                        Ok((id, project_id, name, managed_path_ref))
                    },
                )
                .optional()?;

                Ok(resolved.map(|(id, project_id, name, managed_path_ref)| {
                    InternalReferenceResolveResult {
                        kind: "document".to_string(),
                        id,
                        label: truncate_text(
                            &normalize_internal_reference_label("document", &name),
                            72,
                        ),
                        scope: TodoScope::Project,
                        project_id: Some(project_id),
                        activity_id: None,
                        route: build_internal_reference_route(
                            project_id,
                            None,
                            &format!("document-{id}"),
                        ),
                        focus_id: Some(format!("document-{id}")),
                        managed_path: Some(self.decode_path_ref_to_string(&managed_path_ref)),
                    }
                }))
            }
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
        let _project_a =
            self.seed_demo_customer_service_project(workspace_root, &source_root, &catalog)?;
        let _project_b =
            self.seed_demo_lead_scoring_project(workspace_root, &source_root, &catalog)?;
        let _project_c =
            self.seed_demo_contract_review_project(workspace_root, &source_root, &catalog)?;

        let mock_ai_profile_created = self.ensure_demo_mock_ai_profile_if_needed()?;
        Ok(DemoSeedResult {
            workspace_root: workspace_root.to_string_lossy().to_string(),
            project_count: self.count_table_rows("projects")?,
            activity_count: self.count_table_rows("activities")?,
            note_count: self.count_table_rows("notes")?,
            conclusion_count: self.count_table_rows("conclusions")?,
            todo_count: self.count_table_rows("todos")?,
            document_count: self.count_table_rows("documents")?,
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

        Ok(DemoSeedCatalog {
            attribute_ids,
            status_ids,
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
        self.ai_binding_upsert(AiCapabilityBindingUpsertInput {
            capability: "editor_rewrite".to_string(),
            use_default: true,
            profile_id: None,
            model: None,
        })?;

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
        title: &str,
        markdown: &str,
    ) -> Result<NoteRecord> {
        self.project_record_upsert(ProjectRecordUpsertInput {
            project_id,
            activity_id: Some(activity_id),
            note_id: None,
            title: Some(title.to_string()),
            markdown: markdown.to_string(),
            html: rich_text_html_from_markdown(markdown),
            default_code_language: None,
            tag_ids: vec![],
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
            scope: TodoScope::Project,
            project_id: Some(project_id),
            activity_id,
            content: content.to_string(),
            priority: priority.to_string(),
            due_date: None,
            tag_ids: vec![],
        })?;

        for (progress_date, progress_content) in progresses {
            self.todo_add_progress(TodoAddProgressInput {
                todo_id: todo.id,
                content: (*progress_content).to_string(),
                progress_date: (*progress_date).to_string(),
                due_date: None,
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
        tag_labels: &[&str],
    ) -> Result<DocumentRecord> {
        let timestamp = now_iso();
        let mut tag_ids = Vec::with_capacity(tag_labels.len());
        for label in tag_labels {
            let tag_id = self.upsert_project_tag_by_label(
                project_id,
                label,
                DEFAULT_RECORD_TYPE_COLOR_KEY,
                &timestamp,
            )?;
            tag_ids.push(tag_id);
        }

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
            &["PRD", "评审材料"],
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
            &["数据样本", "评审材料"],
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
            &["法务条款", "Prompt草案"],
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
        self.import_demo_document(project.id, None, &project_scope, true, &["PRD", "流程清单"])?;

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
            &["数据样本", "评审材料"],
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
            &["流程清单", "评审材料"],
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
        self.import_demo_document(project.id, None, &scope_doc, true, &["PRD", "法务条款"])?;

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
            &["Prompt草案", "法务条款"],
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
            &["流程清单", "法务条款"],
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
        if input.activity_id.is_some() {
            return Err(anyhow!(
                "activity artifacts are no longer supported; use project_brief or daily_brief"
            ));
        }

        let kind = input.kind.trim();
        let spec = artifact_skill_spec(kind)?;

        match kind {
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
        if input.activity_id.is_some() {
            return Err(anyhow!(
                "activity scope is no longer supported; use project scope instead"
            ));
        }

        let question = input.question.trim().to_string();
        if question.is_empty() {
            return Err(anyhow!("question is required"));
        }

        match input.scope {
            AiAnswerScope::Activity => Err(anyhow!(
                "activity scope is no longer supported; use project scope instead"
            )),
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
        _activity_id: Option<i64>,
    ) -> Result<Vec<AskSource>> {
        match scope {
            AiAnswerScope::Activity => Err(anyhow!(
                "activity scope is no longer supported; use project scope instead"
            )),
            AiAnswerScope::Project => self
                .build_project_ask_sources(project_id.ok_or_else(|| anyhow!("missing projectId"))?),
            AiAnswerScope::Workspace => self.build_workspace_ask_sources(),
        }
    }

    fn build_artifact_context(
        &mut self,
        spec: &ArtifactSkillSpec,
        project_id: Option<i64>,
        _activity_id: Option<i64>,
        artifact_date: Option<String>,
    ) -> Result<ArtifactGenerationContext> {
        match spec.kind {
            "project_brief" => self.build_project_brief_context(
                project_id.ok_or_else(|| anyhow!("missing projectId"))?,
            ),
            "daily_brief" => {
                self.build_daily_brief_context(artifact_date.unwrap_or_else(current_workspace_date))
            }
            _ => Err(anyhow!("unsupported artifact kind")),
        }
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
                todo.project_id,
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
                todo.project_id,
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
                    .unwrap_or_else(|| "记录".to_string());
                let note_excerpt = truncate_text(&note.content_markdown, 360);
                push_ask_source(
                    &mut sources,
                    Some(note.project_id),
                    note.activity_id,
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
        _spec: &ArtifactSkillSpec,
        _context: ArtifactGenerationContext,
        _payload: AiArtifactPayload,
        _timestamp: &str,
    ) -> Result<AiArtifactRecord> {
        Err(anyhow!("AI artifacts have been removed"))
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
                SELECT id, name, kind, status, root_path, summary, summary_markdown, summary_html,
                  quick_note_code_language, is_archived, created_at, updated_at
                FROM projects WHERE id = ?1
                "#,
                [project_id],
                |row| {
                    let root_path_ref = row.get::<_, String>(4)?;
                    Ok(ProjectRecord {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        kind: row.get(2)?,
                        status: row.get(3)?,
                        root_path: self.decode_path_ref_to_string(&root_path_ref),
                        summary: row.get(5)?,
                        summary_markdown: row.get(6)?,
                        summary_html: row.get(7)?,
                        summary_code_language: row.get(8)?,
                        is_archived: int_to_bool(row.get::<_, i64>(9)?),
                        created_at: row.get(10)?,
                        updated_at: row.get(11)?,
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
        let tags = self.fetch_note_tags(note_id)?;
        self.conn
            .query_row(
                r#"
                SELECT id, project_id, activity_id, title, content_markdown, content_html,
                  default_code_language, created_at, updated_at
                FROM notes WHERE id = ?1
                "#,
                [note_id],
                |row| {
                    Ok(NoteRecord {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        activity_id: row.get(2)?,
                        title: row.get(3)?,
                        content_markdown: row.get(4)?,
                        content_html: row.get(5)?,
                        default_code_language: row.get(6)?,
                        tags: tags.clone(),
                        created_at: row.get(7)?,
                        updated_at: row.get(8)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    fn workspace_note_record(&self, note_id: i64) -> Result<WorkspaceRecord> {
        let tags = self.fetch_workspace_note_tags(note_id)?;
        self.conn
            .query_row(
                r#"
                SELECT id, title, content_markdown, content_html, default_code_language, created_at, updated_at
                FROM workspace_notes WHERE id = ?1
                "#,
                [note_id],
                |row| {
                    Ok(WorkspaceRecord {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        content_markdown: row.get(2)?,
                        content_html: row.get(3)?,
                        default_code_language: row.get(4)?,
                        tags: tags.clone(),
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
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
                SELECT id, todo_id, content, progress_date, due_date, status, completed_at, order_index, created_at
                FROM todo_progresses WHERE id = ?1
                "#,
                [progress_id],
                |row| {
                    Ok(TodoProgressRecord {
                        id: row.get(0)?,
                        todo_id: row.get(1)?,
                        content: row.get(2)?,
                        progress_date: row.get(3)?,
                        due_date: row.get(4)?,
                        status: row.get(5)?,
                        completed_at: row.get(6)?,
                        order_index: row.get(7)?,
                        created_at: row.get(8)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    fn todo_record(&self, todo_id: i64) -> Result<TodoRecord> {
        let base = self.conn.query_row(
            r#"
            SELECT
              t.id, t.scope, t.project_id, p.name, t.activity_id, a.title, t.content, t.status, t.priority, t.due_date, t.created_at, t.updated_at
            FROM todos t
            LEFT JOIN projects p ON p.id = t.project_id
            LEFT JOIN activities a ON a.id = t.activity_id
            WHERE t.id = ?1
            "#,
            [todo_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                ))
            },
        )?;
        let scope = match base.1.as_str() {
            "workspace" => TodoScope::Workspace,
            "project" => TodoScope::Project,
            value => return Err(anyhow!("Unsupported todo scope: {value}")),
        };
        let progresses = self.fetch_todo_progresses(todo_id)?;
        let tags = self.fetch_todo_tags(todo_id)?;
        Ok(TodoRecord {
            id: base.0,
            scope,
            project_id: base.2,
            project_name: base.3,
            activity_id: base.4,
            source_activity_title: base.5,
            content: base.6,
            status: base.7,
            priority: base.8,
            due_date: base.9,
            tags,
            created_at: base.10,
            updated_at: base.11,
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
            "SELECT id FROM notes WHERE activity_id = ?1 ORDER BY created_at DESC, id DESC",
        )?;
        let ids = stmt
            .query_map([activity_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().map(|id| self.note_record(id)).collect()
    }

    fn fetch_project_notes(&self, project_id: i64) -> Result<Vec<NoteRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM notes WHERE project_id = ?1 ORDER BY created_at DESC, id DESC",
        )?;
        let ids = stmt
            .query_map([project_id], |row| row.get::<_, i64>(0))?
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
        let mut stmt = self.conn.prepare(
            "SELECT id FROM todos WHERE activity_id = ?1 ORDER BY created_at DESC, id DESC",
        )?;
        let ids = stmt
            .query_map([activity_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().map(|id| self.todo_record(id)).collect()
    }

    fn fetch_todo_progresses(&self, todo_id: i64) -> Result<Vec<TodoProgressRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM todo_progresses WHERE todo_id = ?1 ORDER BY CASE status WHEN 'unfinished' THEN 0 ELSE 1 END ASC, order_index ASC, progress_date DESC, created_at DESC",
        )?;
        let ids = stmt
            .query_map([todo_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter()
            .map(|id| self.todo_progress_record(id))
            .collect()
    }

    fn next_todo_subitem_order_index(&self, todo_id: i64) -> Result<i64> {
        let current_max = self
            .conn
            .query_row(
                "SELECT MAX(order_index) FROM todo_progresses WHERE todo_id = ?1",
                [todo_id],
                |row| row.get::<_, Option<i64>>(0),
            )?
            .unwrap_or(-1);
        Ok(current_max + 1)
    }

    fn fetch_documents(&self, activity_id: i64) -> Result<Vec<DocumentRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM documents WHERE activity_id = ?1 AND storage_mode != ?2 ORDER BY created_at DESC, id DESC",
        )?;
        let ids = stmt
            .query_map(
                params![activity_id, MANAGED_NOTE_IMAGE_STORAGE_MODE],
                |row| row.get::<_, i64>(0),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().map(|id| self.document_record(id)).collect()
    }

    fn fetch_all_documents_for_project(&self, project_id: i64) -> Result<Vec<DocumentRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM documents WHERE project_id = ?1 ORDER BY created_at DESC, id DESC",
        )?;
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

    fn fetch_note_tags(&self, note_id: i64) -> Result<Vec<DocumentTagRecord>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT f.id, f.label, f.color_key
            FROM note_tag_links l
            INNER JOIN file_tag_options f ON f.id = l.tag_id
            WHERE l.note_id = ?1
            ORDER BY f.created_at ASC, f.id ASC
            "#,
        )?;
        let rows = stmt.query_map([note_id], |row| {
            Ok(DocumentTagRecord {
                id: row.get(0)?,
                label: row.get(1)?,
                color_key: row.get(2)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    fn fetch_workspace_note_tags(&self, note_id: i64) -> Result<Vec<DocumentTagRecord>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT f.id, f.label, f.color_key
            FROM workspace_note_tag_links l
            INNER JOIN file_tag_options f ON f.id = l.tag_id
            WHERE l.workspace_note_id = ?1
            ORDER BY f.created_at ASC, f.id ASC
            "#,
        )?;
        let rows = stmt.query_map([note_id], |row| {
            Ok(DocumentTagRecord {
                id: row.get(0)?,
                label: row.get(1)?,
                color_key: row.get(2)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    fn fetch_todo_tags(&self, todo_id: i64) -> Result<Vec<DocumentTagRecord>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT f.id, f.label, f.color_key
            FROM todo_tag_links l
            INNER JOIN file_tag_options f ON f.id = l.tag_id
            WHERE l.todo_id = ?1
            ORDER BY f.created_at ASC, f.id ASC
            "#,
        )?;
        let rows = stmt.query_map([todo_id], |row| {
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
            "SELECT id FROM documents WHERE project_id = ?1 AND storage_mode != ?2 AND is_starred = 1 ORDER BY created_at DESC, id DESC"
        } else {
            "SELECT id FROM documents WHERE project_id = ?1 AND storage_mode != ?2 ORDER BY created_at DESC, id DESC"
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
            ORDER BY created_at DESC, id DESC
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

    fn upsert_project_tag_by_label(
        &mut self,
        project_id: i64,
        label: &str,
        color_key: &str,
        timestamp: &str,
    ) -> Result<i64> {
        let label = validate_file_tag_label(label)?;
        let color_key = validate_file_tag_color_key(color_key)?;
        if let Some(existing_id) = self
            .conn
            .query_row(
                "SELECT id FROM file_tag_options WHERE project_id = ?1 AND label = ?2 COLLATE NOCASE",
                params![project_id, label.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
        {
            return Ok(existing_id);
        }

        self.conn.execute(
            r#"
            INSERT INTO file_tag_options (project_id, label, color_key, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
            params![project_id, label, color_key, timestamp, timestamp],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    fn upsert_file_tag_by_label(
        &mut self,
        project_id: Option<i64>,
        label: &str,
        color_key: &str,
        timestamp: &str,
    ) -> Result<i64> {
        let label = validate_file_tag_label(label)?;
        let color_key = validate_file_tag_color_key(color_key)?;
        if let Some(existing_id) = self
            .conn
            .query_row(
                "SELECT id FROM file_tag_options WHERE project_id IS ?1 AND label = ?2 COLLATE NOCASE",
                params![project_id, label.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
        {
            return Ok(existing_id);
        }

        self.conn.execute(
            r#"
            INSERT INTO file_tag_options (project_id, label, color_key, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
            params![project_id, label, color_key, timestamp, timestamp],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    fn file_tag_record(&self, tag_id: i64) -> Result<FileTagRecord> {
        self.conn
            .query_row(
                r#"
                SELECT
                  f.id,
                  f.label,
                  f.color_key,
                  (
                    COUNT(DISTINCT l.document_id) +
                    COUNT(DISTINCT nl.note_id) +
                    COUNT(DISTINCT tl.todo_id) +
                    COUNT(DISTINCT wnl.workspace_note_id)
                  ) AS usage_count,
                  f.created_at,
                  f.updated_at
                FROM file_tag_options f
                LEFT JOIN document_tag_links l ON l.tag_id = f.id
                LEFT JOIN note_tag_links nl ON nl.tag_id = f.id
                LEFT JOIN todo_tag_links tl ON tl.tag_id = f.id
                LEFT JOIN workspace_note_tag_links wnl ON wnl.tag_id = f.id
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

    fn scoped_file_tag_record(
        &self,
        project_id: Option<i64>,
        tag_id: i64,
    ) -> Result<FileTagRecord> {
        let belongs_to_scope = self
            .conn
            .query_row(
                "SELECT 1 FROM file_tag_options WHERE id = ?1 AND project_id IS ?2",
                params![tag_id, project_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();

        if !belongs_to_scope {
            return Err(anyhow!("project tag does not belong to the active scope"));
        }

        self.file_tag_record(tag_id)
    }

    fn fetch_file_tag_records(&self, project_id: Option<i64>) -> Result<Vec<FileTagRecord>> {
        let query = if project_id.is_some() {
            "SELECT id FROM file_tag_options WHERE project_id = ?1 ORDER BY created_at ASC, id ASC"
        } else {
            "SELECT id FROM file_tag_options WHERE project_id IS NULL ORDER BY created_at ASC, id ASC"
        };
        let mut stmt = self.conn.prepare(query)?;
        let ids = if let Some(project_id) = project_id {
            stmt.query_map(params![project_id], |row| row.get::<_, i64>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            stmt.query_map([], |row| row.get::<_, i64>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        ids.into_iter()
            .map(|tag_id| self.file_tag_record(tag_id))
            .collect()
    }

    fn contact_record(&self, contact_id: i64) -> Result<ContactRecord> {
        self.conn
            .query_row(
                r#"
                SELECT
                  id,
                  name,
                  pinyin_full,
                  pinyin_abbr,
                  email,
                  employee_id,
                  role,
                  department,
                  created_at,
                  updated_at
                FROM contacts
                WHERE id = ?1
                "#,
                [contact_id],
                |row| {
                    Ok(ContactRecord {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        pinyin_full: row.get(2)?,
                        pinyin_abbr: row.get(3)?,
                        email: row.get(4)?,
                        employee_id: row.get(5)?,
                        role: row.get(6)?,
                        department: row.get(7)?,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    fn replace_document_tags(
        &mut self,
        document_id: i64,
        tag_ids: &[i64],
        timestamp: &str,
    ) -> Result<()> {
        let project_id = self.conn.query_row(
            "SELECT project_id FROM documents WHERE id = ?1",
            [document_id],
            |row| row.get::<_, i64>(0),
        )?;
        let normalized_tag_ids = normalize_file_tag_ids(tag_ids);
        for &tag_id in &normalized_tag_ids {
            self.scoped_file_tag_record(Some(project_id), tag_id)?;
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

    fn replace_note_tags(&mut self, note_id: i64, tag_ids: &[i64], timestamp: &str) -> Result<()> {
        let project_id = self.conn.query_row(
            "SELECT project_id FROM notes WHERE id = ?1",
            [note_id],
            |row| row.get::<_, i64>(0),
        )?;
        let normalized_tag_ids = normalize_file_tag_ids(tag_ids);
        for &tag_id in &normalized_tag_ids {
            self.scoped_file_tag_record(Some(project_id), tag_id)?;
        }

        self.conn.execute(
            "DELETE FROM note_tag_links WHERE note_id = ?1",
            params![note_id],
        )?;

        for tag_id in normalized_tag_ids {
            self.conn.execute(
                r#"
                INSERT INTO note_tag_links (note_id, tag_id, created_at)
                VALUES (?1, ?2, ?3)
                "#,
                params![note_id, tag_id, timestamp],
            )?;
        }

        Ok(())
    }

    fn replace_workspace_note_tags(
        &mut self,
        note_id: i64,
        tag_ids: &[i64],
        timestamp: &str,
    ) -> Result<()> {
        let normalized_tag_ids = normalize_file_tag_ids(tag_ids);
        for &tag_id in &normalized_tag_ids {
            self.scoped_file_tag_record(None, tag_id)?;
        }

        self.conn.execute(
            "DELETE FROM workspace_note_tag_links WHERE workspace_note_id = ?1",
            params![note_id],
        )?;

        for tag_id in normalized_tag_ids {
            self.conn.execute(
                r#"
                INSERT INTO workspace_note_tag_links (workspace_note_id, tag_id, created_at)
                VALUES (?1, ?2, ?3)
                "#,
                params![note_id, tag_id, timestamp],
            )?;
        }

        Ok(())
    }

    fn replace_todo_tags(&mut self, todo_id: i64, tag_ids: &[i64], timestamp: &str) -> Result<()> {
        let project_id = self.conn.query_row(
            "SELECT project_id FROM todos WHERE id = ?1",
            [todo_id],
            |row| row.get::<_, Option<i64>>(0),
        )?;
        let normalized_tag_ids = self.validated_todo_tag_ids(project_id, tag_ids)?;
        self.write_todo_tags(todo_id, &normalized_tag_ids, timestamp)
    }

    fn validated_todo_tag_ids(&self, project_id: Option<i64>, tag_ids: &[i64]) -> Result<Vec<i64>> {
        let normalized_tag_ids = normalize_file_tag_ids(tag_ids);
        for &tag_id in &normalized_tag_ids {
            self.scoped_file_tag_record(project_id, tag_id)?;
        }
        Ok(normalized_tag_ids)
    }

    fn write_todo_tags(
        &mut self,
        todo_id: i64,
        normalized_tag_ids: &[i64],
        timestamp: &str,
    ) -> Result<()> {
        self.conn.execute(
            "DELETE FROM todo_tag_links WHERE todo_id = ?1",
            params![todo_id],
        )?;

        for &tag_id in normalized_tag_ids {
            self.conn.execute(
                r#"
                INSERT INTO todo_tag_links (todo_id, tag_id, created_at)
                VALUES (?1, ?2, ?3)
                "#,
                params![todo_id, tag_id, timestamp],
            )?;
        }

        Ok(())
    }

    fn fetch_project_todos(&self, project_id: i64, finished: bool) -> Result<Vec<TodoRecord>> {
        let query = if finished {
            "SELECT id FROM todos WHERE project_id = ?1 AND status = 'finished' ORDER BY created_at DESC, id DESC"
        } else {
            "SELECT id FROM todos WHERE project_id = ?1 AND status = 'unfinished' ORDER BY created_at DESC, id DESC"
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

    fn workspace_note_image_target_dir(&self) -> Result<PathBuf> {
        let target_dir = self
            .workspace_root
            .join(WORKSPACE_HIDDEN_DIR_NAME)
            .join(PROJECT_NOTE_ASSET_DIR_NAME)
            .join("workspace");
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
            "SELECT id, title FROM activities WHERE project_id = ?1 ORDER BY created_at DESC, id DESC",
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

    fn touch_todo_owners(&self, todo: &TodoRecord) -> Result<()> {
        if let Some(project_id) = todo.project_id {
            self.touch_project(project_id)?;
        }
        if let Some(activity_id) = todo.activity_id {
            self.touch_activity(activity_id)?;
        }
        Ok(())
    }

    fn mark_project_artifacts_stale(&self, _project_id: i64) -> Result<()> {
        Ok(())
    }

    fn mark_activity_artifacts_stale(&self, _project_id: i64, _activity_id: i64) -> Result<()> {
        Ok(())
    }

    fn mark_daily_artifacts_stale(&self) -> Result<()> {
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
              status TEXT NOT NULL DEFAULT 'unfinished',
              completed_at TEXT,
              order_index INTEGER NOT NULL DEFAULT 0,
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

    fn migrate_todo_subitem_schema(&self) -> Result<()> {
        self.ensure_column(
            "todo_progresses",
            "status",
            "ALTER TABLE todo_progresses ADD COLUMN status TEXT NOT NULL DEFAULT 'unfinished'",
        )?;
        self.ensure_column(
            "todo_progresses",
            "completed_at",
            "ALTER TABLE todo_progresses ADD COLUMN completed_at TEXT",
        )?;
        self.ensure_column(
            "todo_progresses",
            "order_index",
            "ALTER TABLE todo_progresses ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0",
        )?;
        self.conn.execute_batch(
            r#"
            WITH ranked AS (
              SELECT
                id,
                ROW_NUMBER() OVER (
                  PARTITION BY todo_id
                  ORDER BY progress_date DESC, created_at DESC, id DESC
                ) - 1 AS next_order_index
              FROM todo_progresses
            )
            UPDATE todo_progresses
            SET order_index = (
              SELECT next_order_index FROM ranked WHERE ranked.id = todo_progresses.id
            )
            WHERE order_index = 0;
            "#,
        )?;
        Ok(())
    }

    fn migrate_todo_due_date_schema(&self) -> Result<()> {
        self.ensure_column(
            "todos",
            "due_date",
            "ALTER TABLE todos ADD COLUMN due_date TEXT",
        )?;
        self.ensure_column(
            "todo_progresses",
            "due_date",
            "ALTER TABLE todo_progresses ADD COLUMN due_date TEXT",
        )?;
        Ok(())
    }

    fn migrate_todo_ownership_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            PRAGMA foreign_keys = OFF;
            BEGIN IMMEDIATE;

            CREATE TABLE todos_with_ownership (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              scope TEXT NOT NULL DEFAULT 'project',
              project_id INTEGER,
              activity_id INTEGER,
              content TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'unfinished',
              priority TEXT NOT NULL,
              due_date TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              CHECK (
                (scope = 'workspace' AND project_id IS NULL AND activity_id IS NULL)
                OR
                (scope = 'project' AND project_id IS NOT NULL)
              ),
              FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
              FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE SET NULL
            );

            INSERT INTO todos_with_ownership (
              id, scope, project_id, activity_id, content, status, priority, due_date, created_at, updated_at
            )
            SELECT
              todo.id,
              'project',
              todo.project_id,
              CASE
                WHEN todo.activity_id IS NULL THEN NULL
                WHEN activity.project_id = todo.project_id THEN todo.activity_id
                ELSE NULL
              END,
              todo.content,
              todo.status,
              todo.priority,
              todo.due_date,
              todo.created_at,
              todo.updated_at
            FROM todos todo
            LEFT JOIN activities activity ON activity.id = todo.activity_id;

            DROP TABLE todos;
            ALTER TABLE todos_with_ownership RENAME TO todos;

            CREATE TRIGGER todos_require_matching_activity_project_on_insert
            BEFORE INSERT ON todos
            WHEN NEW.activity_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM activities
                WHERE id = NEW.activity_id
                  AND project_id = NEW.project_id
              )
            BEGIN
              SELECT RAISE(ABORT, 'Project Todo Activity must belong to the same Project');
            END;

            CREATE TRIGGER todos_require_matching_activity_project_on_update
            BEFORE UPDATE OF scope, project_id, activity_id ON todos
            WHEN NEW.activity_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM activities
                WHERE id = NEW.activity_id
                  AND project_id = NEW.project_id
              )
            BEGIN
              SELECT RAISE(ABORT, 'Project Todo Activity must belong to the same Project');
            END;

            COMMIT;
            PRAGMA foreign_keys = ON;
            "#,
        )?;
        Ok(())
    }

    fn migrate_project_kind_schema(&mut self) -> Result<()> {
        self.ensure_column(
            "projects",
            "kind",
            "ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal'",
        )?;
        self.conn.execute(
            "UPDATE projects SET kind = ?1 WHERE kind <> ?1 OR TRIM(COALESCE(kind, '')) = ''",
            params![PROJECT_KIND_NORMAL],
        )?;
        Ok(())
    }

    fn migrate_note_type_removal_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            PRAGMA foreign_keys = OFF;
            CREATE TABLE IF NOT EXISTS notes_next (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_id INTEGER NOT NULL,
              activity_id INTEGER,
              title TEXT,
              content_markdown TEXT NOT NULL DEFAULT '',
              content_html TEXT NOT NULL DEFAULT '',
              default_code_language TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
              FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE SET NULL
            );
            INSERT INTO notes_next (
              id, project_id, activity_id, title, content_markdown, content_html,
              default_code_language, created_at, updated_at
            )
            SELECT id, project_id, activity_id, title, content_markdown, content_html,
              CASE WHEN EXISTS(SELECT 1 FROM pragma_table_info('notes') WHERE name = 'default_code_language')
                THEN default_code_language ELSE NULL END,
              created_at, updated_at
            FROM notes;
            DROP TABLE notes;
            ALTER TABLE notes_next RENAME TO notes;
            DROP TABLE IF EXISTS record_type_options;
            PRAGMA foreign_keys = ON;
            "#,
        )?;
        Ok(())
    }

    fn migrate_project_entity_tags_schema(&mut self) -> Result<()> {
        self.rebuild_notes_for_project_level_records()?;
        self.rebuild_file_tags_for_project_scope()?;
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS note_tag_links (
              note_id INTEGER NOT NULL,
              tag_id INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              PRIMARY KEY(note_id, tag_id),
              FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE,
              FOREIGN KEY(tag_id) REFERENCES file_tag_options(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS todo_tag_links (
              todo_id INTEGER NOT NULL,
              tag_id INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              PRIMARY KEY(todo_id, tag_id),
              FOREIGN KEY(todo_id) REFERENCES todos(id) ON DELETE CASCADE,
              FOREIGN KEY(tag_id) REFERENCES file_tag_options(id) ON DELETE CASCADE
            );
            "#,
        )?;

        self.migrate_legacy_file_tags_to_project_scope()?;
        self.migrate_activity_titles_to_project_tags()?;
        self.conn.execute("DELETE FROM conclusions", [])?;
        Ok(())
    }

    fn rebuild_notes_for_project_level_records(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            PRAGMA foreign_keys = OFF;
            CREATE TABLE IF NOT EXISTS notes_next (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_id INTEGER NOT NULL,
              activity_id INTEGER,
              title TEXT,
              content_markdown TEXT NOT NULL DEFAULT '',
              content_html TEXT NOT NULL DEFAULT '',
              default_code_language TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
              FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE SET NULL
            );
            INSERT INTO notes_next (
              id, project_id, activity_id, title, content_markdown, content_html,
              default_code_language, created_at, updated_at
            )
            SELECT id, project_id, activity_id, title, content_markdown, content_html,
              CASE WHEN EXISTS(SELECT 1 FROM pragma_table_info('notes') WHERE name = 'default_code_language')
                THEN default_code_language ELSE NULL END,
              created_at, updated_at
            FROM notes;
            DROP TABLE notes;
            ALTER TABLE notes_next RENAME TO notes;
            PRAGMA foreign_keys = ON;
            "#,
        )?;
        Ok(())
    }

    fn rebuild_file_tags_for_project_scope(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            PRAGMA foreign_keys = OFF;
            CREATE TABLE IF NOT EXISTS file_tag_options_next (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_id INTEGER,
              label TEXT NOT NULL COLLATE NOCASE,
              color_key TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            INSERT INTO file_tag_options_next (id, project_id, label, color_key, created_at, updated_at)
            SELECT id, project_id, label, color_key, created_at, updated_at
            FROM file_tag_options;
            DROP TABLE file_tag_options;
            ALTER TABLE file_tag_options_next RENAME TO file_tag_options;
            PRAGMA foreign_keys = ON;
            "#,
        )?;
        Ok(())
    }

    fn migrate_legacy_file_tags_to_project_scope(&mut self) -> Result<()> {
        let unscoped_count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM file_tag_options WHERE project_id IS NULL",
            [],
            |row| row.get(0),
        )?;
        if unscoped_count == 0 {
            return Ok(());
        }

        let timestamp = now_iso();
        let mut stmt = self.conn.prepare(
            r#"
            SELECT DISTINCT f.id, f.label, f.color_key, d.project_id
            FROM file_tag_options f
            LEFT JOIN document_tag_links l ON l.tag_id = f.id
            LEFT JOIN documents d ON d.id = l.document_id
            WHERE f.project_id IS NULL
            "#,
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);

        for (old_tag_id, label, color_key, maybe_project_id) in rows {
            let Some(project_id) = maybe_project_id else {
                continue;
            };
            let new_tag_id =
                self.upsert_project_tag_by_label(project_id, &label, &color_key, &timestamp)?;
            self.conn.execute(
                r#"
                UPDATE OR IGNORE document_tag_links
                SET tag_id = ?1
                WHERE tag_id = ?2
                  AND document_id IN (SELECT id FROM documents WHERE project_id = ?3)
                "#,
                params![new_tag_id, old_tag_id, project_id],
            )?;
        }

        self.conn
            .execute("DELETE FROM file_tag_options WHERE project_id IS NULL", [])?;
        Ok(())
    }

    fn migrate_file_tag_project_uniqueness_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            PRAGMA foreign_keys = OFF;
            CREATE TABLE IF NOT EXISTS file_tag_options_next (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_id INTEGER,
              label TEXT NOT NULL COLLATE NOCASE,
              color_key TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
              UNIQUE(project_id, label)
            );
            INSERT OR IGNORE INTO file_tag_options_next (id, project_id, label, color_key, created_at, updated_at)
            SELECT id, project_id, label, color_key, created_at, updated_at
            FROM file_tag_options;
            DROP TABLE file_tag_options;
            ALTER TABLE file_tag_options_next RENAME TO file_tag_options;
            CREATE INDEX IF NOT EXISTS idx_file_tag_options_project_label
              ON file_tag_options(project_id, label);
            PRAGMA foreign_keys = ON;
            "#,
        )?;
        Ok(())
    }

    fn migrate_workspace_note_tag_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS workspace_note_tag_links (
              workspace_note_id INTEGER NOT NULL,
              tag_id INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              PRIMARY KEY(workspace_note_id, tag_id),
              FOREIGN KEY(workspace_note_id) REFERENCES workspace_notes(id) ON DELETE CASCADE,
              FOREIGN KEY(tag_id) REFERENCES file_tag_options(id) ON DELETE CASCADE
            );
            "#,
        )?;
        Ok(())
    }

    fn migrate_ai_rewrite_only_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            DROP TABLE IF EXISTS ai_artifact_citations;
            DROP TABLE IF EXISTS ai_artifacts;
            DROP TABLE IF EXISTS ai_suggestions;
            DELETE FROM app_settings WHERE key = 'ai_feature_settings';
            DELETE FROM ai_capability_bindings
            WHERE capability NOT IN ('default', 'editor_rewrite');
            "#,
        )?;
        Ok(())
    }

    fn migrate_activity_titles_to_project_tags(&mut self) -> Result<()> {
        let timestamp = now_iso();
        let mut stmt = self
            .conn
            .prepare("SELECT id, project_id, title FROM activities ORDER BY id ASC")?;
        let activities = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);

        for (activity_id, project_id, title) in activities {
            let label = title.trim();
            let label = if label.is_empty() {
                format!("{UNTITLED_ACTIVITY_PREFIX} {activity_id}")
            } else {
                label.to_string()
            };
            let tag_id = self.upsert_project_tag_by_label(
                project_id,
                &label,
                DEFAULT_RECORD_TYPE_COLOR_KEY,
                &timestamp,
            )?;

            self.conn.execute(
                r#"
                INSERT OR IGNORE INTO note_tag_links (note_id, tag_id, created_at)
                SELECT id, ?1, ?2 FROM notes WHERE activity_id = ?3
                "#,
                params![tag_id, timestamp, activity_id],
            )?;
            self.conn.execute(
                r#"
                INSERT OR IGNORE INTO todo_tag_links (todo_id, tag_id, created_at)
                SELECT id, ?1, ?2 FROM todos WHERE activity_id = ?3
                "#,
                params![tag_id, timestamp, activity_id],
            )?;
            self.conn.execute(
                r#"
                INSERT OR IGNORE INTO document_tag_links (document_id, tag_id, created_at)
                SELECT id, ?1, ?2
                FROM documents
                WHERE activity_id = ?3 AND storage_mode != ?4
                "#,
                params![
                    tag_id,
                    timestamp,
                    activity_id,
                    MANAGED_NOTE_IMAGE_STORAGE_MODE
                ],
            )?;
        }

        self.conn
            .execute("UPDATE notes SET activity_id = NULL", [])?;
        self.conn
            .execute("UPDATE todos SET activity_id = NULL", [])?;
        self.conn
            .execute("UPDATE documents SET activity_id = NULL", [])?;
        Ok(())
    }

    fn migrate_activity_retire_schema(&mut self) -> Result<()> {
        let timestamp = now_iso();
        let mut stmt = self.conn.prepare(
            r#"
            SELECT
              id,
              project_id,
              title,
              brief_markdown,
              brief_html
            FROM activities
            ORDER BY project_id ASC, id ASC
            "#,
        )?;
        let activities = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);

        for (activity_id, project_id, title, brief_markdown, brief_html) in activities {
            let base_label = if title.trim().is_empty() {
                format!("来源: {} {}", UNTITLED_ACTIVITY_PREFIX, activity_id)
            } else {
                format!("来源: {}", title.trim())
            };
            let label = if self
                .conn
                .query_row(
                    "SELECT id FROM file_tag_options WHERE project_id = ?1 AND label = ?2 COLLATE NOCASE",
                    params![project_id, base_label.as_str()],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_some()
            {
                format!("{base_label} (#{activity_id})")
            } else {
                base_label
            };
            let tag_id = self.upsert_project_tag_by_label(
                project_id,
                &label,
                DEFAULT_RECORD_TYPE_COLOR_KEY,
                &timestamp,
            )?;

            self.conn.execute(
                r#"
                INSERT OR IGNORE INTO note_tag_links (note_id, tag_id, created_at)
                SELECT id, ?1, ?2 FROM notes WHERE activity_id = ?3
                "#,
                params![tag_id, timestamp, activity_id],
            )?;
            self.conn.execute(
                r#"
                INSERT OR IGNORE INTO todo_tag_links (todo_id, tag_id, created_at)
                SELECT id, ?1, ?2 FROM todos WHERE activity_id = ?3
                "#,
                params![tag_id, timestamp, activity_id],
            )?;
            self.conn.execute(
                r#"
                INSERT OR IGNORE INTO document_tag_links (document_id, tag_id, created_at)
                SELECT id, ?1, ?2
                FROM documents
                WHERE activity_id = ?3 AND storage_mode != ?4
                "#,
                params![
                    tag_id,
                    timestamp,
                    activity_id,
                    MANAGED_NOTE_IMAGE_STORAGE_MODE
                ],
            )?;

            if !brief_markdown.trim().is_empty() || !brief_html.trim().is_empty() {
                let resolved_markdown = if brief_markdown.trim().is_empty() {
                    title.trim().to_string()
                } else {
                    brief_markdown.clone()
                };
                let resolved_html = if brief_html.trim().is_empty() {
                    rich_text_html_from_markdown(&resolved_markdown)
                } else {
                    brief_html.clone()
                };
                self.insert_project_note(
                    project_id,
                    None,
                    "note",
                    if title.trim().is_empty() {
                        None
                    } else {
                        Some(title.as_str())
                    },
                    resolved_markdown.as_str(),
                    resolved_html.as_str(),
                    None,
                    &timestamp,
                )?;
                let note_id = self.conn.last_insert_rowid();
                self.conn.execute(
                    "INSERT OR IGNORE INTO note_tag_links (note_id, tag_id, created_at) VALUES (?1, ?2, ?3)",
                    params![note_id, tag_id, timestamp],
                )?;
            }

            self.conn.execute(
                "DELETE FROM conclusions WHERE activity_id = ?1",
                params![activity_id],
            )?;
        }

        self.conn
            .execute("UPDATE notes SET activity_id = NULL", [])?;
        self.conn
            .execute("UPDATE todos SET activity_id = NULL", [])?;
        self.conn
            .execute("UPDATE documents SET activity_id = NULL", [])?;
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

fn normalize_code_language(value: &str) -> Option<String> {
    let trimmed = value.trim().to_lowercase();

    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
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

fn resolve_unique_file_name(target_dir: &Path, file_name: &str) -> String {
    let candidate = Path::new(file_name);
    let stem = candidate
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("image");
    let extension = candidate.extension().and_then(|value| value.to_str());

    if !target_dir.join(file_name).exists() {
        return file_name.to_string();
    }

    for suffix in 2.. {
        let next_name = match extension {
            Some(extension) if !extension.is_empty() => format!("{stem}-{suffix}.{extension}"),
            _ => format!("{stem}-{suffix}"),
        };

        if !target_dir.join(&next_name).exists() {
            return next_name;
        }
    }

    unreachable!("unbounded suffix search should always return")
}

fn current_workspace_date() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn artifact_skill_spec(kind: &str) -> Result<&'static ArtifactSkillSpec> {
    match kind {
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
    let normalized =
        normalize_internal_reference_match_text(&strip_internal_reference_label_tokens(value));
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

fn parse_internal_reference_tokens(content: &str) -> Vec<(String, i64)> {
    let mut references = Vec::new();
    let mut remaining = content;

    while let Some(start) = remaining.find("[[") {
        remaining = &remaining[start + 2..];
        let Some(end) = remaining.find("]]") else {
            break;
        };
        let token = &remaining[..end];
        remaining = &remaining[end + 2..];

        let Some((target, _label)) = token.split_once('|') else {
            continue;
        };
        let Some((kind, id)) = target.split_once(':') else {
            continue;
        };
        if matches!(kind, "note" | "conclusion" | "todo" | "document") {
            if let Ok(id) = id.parse::<i64>() {
                references.push((kind.to_string(), id));
            }
        }
    }

    references
}

fn todo_scope_from_sql(value: String, column_index: usize) -> rusqlite::Result<TodoScope> {
    match value.as_str() {
        "workspace" => Ok(TodoScope::Workspace),
        "project" => Ok(TodoScope::Project),
        _ => Err(rusqlite::Error::InvalidColumnType(
            column_index,
            value,
            rusqlite::types::Type::Text,
        )),
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
    items
        .into_iter()
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

fn workspace_search_match_excerpt(fields: &[&str], query: &str) -> String {
    fields
        .iter()
        .find(|field| classify_internal_reference_match(field, query).is_some())
        .map(|field| workspace_search_excerpt(field, query, 96))
        .unwrap_or_else(|| query.trim().to_string())
}

fn workspace_search_excerpt(value: &str, query: &str, max_chars: usize) -> String {
    let normalized = normalize_internal_reference_match_text(value);
    let original_chars = normalized.chars().collect::<Vec<_>>();
    if original_chars.len() <= max_chars {
        return normalized;
    }

    let query_chars = normalize_internal_reference_match_text(query)
        .chars()
        .flat_map(char::to_lowercase)
        .collect::<Vec<_>>();
    let mut lowered_chars = Vec::new();
    let mut original_indexes = Vec::new();
    for (original_index, character) in original_chars.iter().copied().enumerate() {
        for lowered in character.to_lowercase() {
            lowered_chars.push(lowered);
            original_indexes.push(original_index);
        }
    }

    let Some(lowered_start) = (!query_chars.is_empty())
        .then(|| {
            lowered_chars
                .windows(query_chars.len())
                .position(|window| window == query_chars.as_slice())
        })
        .flatten()
    else {
        return truncate_text(&normalized, max_chars);
    };

    let match_start = original_indexes[lowered_start];
    let match_end = original_indexes[lowered_start + query_chars.len() - 1] + 1;
    let match_length = match_end.saturating_sub(match_start);
    let context_length = max_chars.saturating_sub(match_length);
    let mut excerpt_start = match_start.saturating_sub(context_length / 2);
    let excerpt_end = (excerpt_start + max_chars).min(original_chars.len());
    excerpt_start = excerpt_end.saturating_sub(max_chars);

    let mut excerpt = original_chars[excerpt_start..excerpt_end]
        .iter()
        .collect::<String>();
    if excerpt_start > 0 {
        excerpt.insert(0, '…');
    }
    if excerpt_end < original_chars.len() {
        excerpt.push('…');
    }
    excerpt
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
                scope: TodoScope::Project,
                project_id: Some(project_id),
                activity_id,
                content: content.to_string(),
                priority: priority.to_string(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap()
    }

    #[test]
    fn todo_creation_contract_requires_explicit_scope() {
        let input = serde_json::json!({
            "projectId": 1,
            "activityId": null,
            "content": "Legacy implicit Project Todo",
            "priority": "not_urgent_important",
            "dueDate": null,
            "tagIds": []
        });

        assert!(serde_json::from_value::<TodoCreateInput>(input).is_err());
    }

    fn downgrade_todos_to_legacy_schema(database: &Database) {
        database
            .conn
            .execute_batch(
                r#"
                PRAGMA foreign_keys = OFF;
                PRAGMA legacy_alter_table = ON;
                BEGIN IMMEDIATE;

                CREATE TABLE todos_legacy (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  project_id INTEGER NOT NULL,
                  activity_id INTEGER,
                  content TEXT NOT NULL,
                  status TEXT NOT NULL DEFAULT 'unfinished',
                  priority TEXT NOT NULL,
                  due_date TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
                  FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE SET NULL
                );
                INSERT INTO todos_legacy (
                  id, project_id, activity_id, content, status, priority, due_date, created_at, updated_at
                )
                SELECT
                  id, project_id, activity_id, content, status, priority, due_date, created_at, updated_at
                FROM todos;
                DROP TABLE todos;
                ALTER TABLE todos_legacy RENAME TO todos;

                COMMIT;
                PRAGMA legacy_alter_table = OFF;
                PRAGMA foreign_keys = ON;
                "#,
            )
            .unwrap();
        database
            .set_schema_version(TODO_DUE_DATE_SCHEMA_VERSION)
            .unwrap();
    }

    fn create_note(
        database: &mut Database,
        project_id: i64,
        activity_id: i64,
        _legacy_note_type: &str,
        markdown: &str,
    ) -> NoteRecord {
        database
            .project_record_upsert(ProjectRecordUpsertInput {
                project_id,
                activity_id: Some(activity_id),
                note_id: None,
                title: Some("记录".to_string()),
                markdown: markdown.to_string(),
                html: format!("<p>{markdown}</p>"),
                tag_ids: vec![],
                default_code_language: None,
            })
            .unwrap()
    }

    fn create_note_with_title(
        database: &mut Database,
        project_id: i64,
        activity_id: i64,
        _legacy_note_type: &str,
        title: &str,
        markdown: &str,
    ) -> NoteRecord {
        database
            .project_record_upsert(ProjectRecordUpsertInput {
                project_id,
                activity_id: Some(activity_id),
                note_id: None,
                title: Some(title.to_string()),
                markdown: markdown.to_string(),
                html: format!("<p>{markdown}</p>"),
                tag_ids: vec![],
                default_code_language: None,
            })
            .unwrap()
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
                project_id: None,
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
    fn ai_editor_skills_can_be_upserted_deleted_and_reordered() {
        let (_harness, mut database) = setup_database();

        let skill = database
            .ai_editor_skill_upsert(AiEditorSkillUpsertInput {
                id: None,
                name: "润色".to_string(),
                icon: Some("📝".to_string()),
                description: Some("润色当前选区".to_string()),
                prompt: "请润色当前段落".to_string(),
                result_mode: "modify".to_string(),
                show_in_text_menu: true,
                sort_order: Some(99),
                enabled: true,
            })
            .unwrap();

        assert_eq!(skill.name, "润色");
        assert_eq!(database.ai_settings_get().unwrap().editor_skills.len(), 5);

        let updated = database
            .ai_editor_skill_upsert(AiEditorSkillUpsertInput {
                id: Some(skill.id.clone()),
                name: "解释".to_string(),
                icon: None,
                description: None,
                prompt: "请翻译成英文".to_string(),
                result_mode: "answer".to_string(),
                show_in_text_menu: false,
                sort_order: Some(skill.sort_order),
                enabled: false,
            })
            .unwrap();

        assert_eq!(updated.name, "解释");
        assert_eq!(updated.result_mode, "answer");
        assert!(!updated.show_in_text_menu);
        assert!(!updated.enabled);

        let mut skill_ids = database
            .ai_editor_skills_get()
            .unwrap()
            .into_iter()
            .map(|skill| skill.id)
            .collect::<Vec<_>>();
        skill_ids.reverse();
        let reordered = database
            .ai_editor_skill_reorder(AiEditorSkillReorderInput { skill_ids })
            .unwrap();
        assert_eq!(reordered.first().map(|skill| skill.sort_order), Some(1));

        let remaining = database
            .ai_editor_skill_delete(AiEditorSkillDeleteInput { skill_id: skill.id })
            .unwrap();
        assert_eq!(remaining.len(), 4);
    }

    #[test]
    fn ai_editor_skills_migrate_legacy_rewrite_actions() {
        let (_harness, mut database) = setup_database();
        let action = database
            .ai_editor_rewrite_action_upsert(AiEditorRewriteActionUpsertInput {
                id: None,
                label: "旧动作".to_string(),
                prompt: "请改写当前选区".to_string(),
                enabled: true,
            })
            .unwrap();

        let skills = database.ai_editor_skills_get().unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, format!("rewrite-action-{}", action.id));
        assert_eq!(skills[0].result_mode, "modify");
        assert!(skills[0].show_in_text_menu);
    }

    #[test]
    fn ai_binding_upsert_rejects_removed_capabilities() {
        let (_harness, mut database) = setup_database();
        let error = database
            .ai_binding_upsert(AiCapabilityBindingUpsertInput {
                capability: "assistant".to_string(),
                use_default: true,
                profile_id: None,
                model: None,
            })
            .unwrap_err();

        assert!(error.to_string().contains("unsupported AI capability"));
    }

    #[test]
    fn ai_editor_rewrite_runs_modify_skill() {
        let (_harness, mut database) = setup_database();
        configure_editor_rewrite_profile(&mut database);
        let skill = database
            .ai_editor_skill_upsert(AiEditorSkillUpsertInput {
                id: None,
                name: "润色".to_string(),
                icon: None,
                description: None,
                prompt: "请润色这段文字".to_string(),
                result_mode: "modify".to_string(),
                show_in_text_menu: true,
                sort_order: None,
                enabled: true,
            })
            .unwrap();

        let mut streamed = Vec::new();
        let result = database
            .ai_editor_rewrite(
                AiEditorRewriteInput {
                    skill_id: Some(skill.id.clone()),
                    skill_name: Some(skill.name.clone()),
                    prompt: Some(skill.prompt.clone()),
                    result_mode: "modify".to_string(),
                    action_id: None,
                    prompt_override: None,
                    selected_text: "第一段".to_string(),
                    expanded_markdown: None,
                    placeholder_tokens: Vec::new(),
                    document_context: None,
                    context: None,
                },
                |stream_text| streamed.push(stream_text),
            )
            .unwrap();

        assert_eq!(result.skill_id.as_deref(), Some(skill.id.as_str()));
        assert_eq!(result.result_mode, "modify");
        assert!(result.content.contains("第一段"));
        assert!(!streamed.is_empty());
        assert_eq!(
            streamed.last().map(String::as_str),
            Some(result.content.as_str())
        );
    }

    #[test]
    fn ai_editor_rewrite_runs_answer_prompt_override() {
        let (_harness, mut database) = setup_database();
        configure_editor_rewrite_profile(&mut database);

        let result = database
            .ai_editor_rewrite(
                AiEditorRewriteInput {
                    skill_id: None,
                    skill_name: Some("解释".to_string()),
                    prompt: Some("请解释这段话".to_string()),
                    result_mode: "answer".to_string(),
                    action_id: None,
                    prompt_override: None,
                    selected_text: "第一段".to_string(),
                    expanded_markdown: None,
                    placeholder_tokens: Vec::new(),
                    document_context: None,
                    context: None,
                },
                |_| {},
            )
            .unwrap();

        assert_eq!(result.skill_id, None);
        assert_eq!(result.result_mode, "answer");
        assert!(result.content.contains("AI 回答"));
    }

    #[test]
    fn ai_editor_rewrite_auto_can_return_a_replacement_and_answer() {
        let (_harness, mut database) = setup_database();
        configure_editor_rewrite_profile(&mut database);

        let result = database
            .ai_editor_rewrite(
                AiEditorRewriteInput {
                    skill_id: None,
                    skill_name: Some("AI 编辑".to_string()),
                    prompt: Some("请润色并解释修改原因".to_string()),
                    result_mode: "auto".to_string(),
                    action_id: None,
                    prompt_override: None,
                    selected_text: "第一段".to_string(),
                    expanded_markdown: None,
                    placeholder_tokens: Vec::new(),
                    document_context: None,
                    context: None,
                },
                |_| {},
            )
            .unwrap();

        assert_eq!(result.result_mode, "auto");
        assert!(result.replacement_markdown.is_some());
        assert!(result.answer_markdown.is_some());
    }

    #[test]
    fn ai_editor_rewrite_placeholder_validator_rejects_missing_tokens() {
        let error = validate_rewrite_placeholder_tokens(
            "第一段\n\n第二段",
            &["PM_TOKEN_IMAGE_1".to_string()],
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("missing required placeholder token"));
    }

    #[test]
    fn workspace_todo_can_be_created_without_project_or_activity_ownership() {
        let (_harness, mut database) = setup_database();
        let workspace_tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                project_id: None,
                id: None,
                label: "跨项目".to_string(),
                color_key: "teal".to_string(),
            })
            .unwrap();

        let created = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Workspace,
                project_id: None,
                activity_id: None,
                content: "整理跨项目复盘模板".to_string(),
                priority: "not_urgent_important".to_string(),
                due_date: Some("2026-08-01".to_string()),
                tag_ids: vec![workspace_tag.id],
            })
            .unwrap();

        assert_eq!(created.scope, TodoScope::Workspace);
        assert_eq!(created.project_id, None);
        assert_eq!(created.activity_id, None);
        assert_eq!(created.content, "整理跨项目复盘模板");
        assert_eq!(created.due_date.as_deref(), Some("2026-08-01"));
        assert_eq!(created.tags[0].id, workspace_tag.id);

        let updated = database
            .todo_update_content(TodoUpdateContentInput {
                todo_id: created.id,
                content: "完成跨项目复盘模板".to_string(),
                due_date: Some("2026-08-05".to_string()),
                tag_ids: vec![workspace_tag.id],
            })
            .unwrap();
        assert_eq!(updated.content, "完成跨项目复盘模板");
        assert_eq!(updated.due_date.as_deref(), Some("2026-08-05"));

        let prioritized = database
            .todo_update_priority(TodoUpdatePriorityInput {
                todo_id: created.id,
                priority: "urgent_important".to_string(),
            })
            .unwrap();
        assert_eq!(prioritized.priority, "urgent_important");

        let subtask = database
            .todo_add_progress(TodoAddProgressInput {
                todo_id: created.id,
                content: "整理访谈材料".to_string(),
                progress_date: "2026-07-30".to_string(),
                due_date: Some("2026-08-02".to_string()),
            })
            .unwrap();
        database
            .todo_update_progress(TodoUpdateProgressInput {
                progress_id: subtask.id,
                content: subtask.content,
                progress_date: subtask.progress_date,
                due_date: subtask.due_date,
                status: Some("finished".to_string()),
            })
            .unwrap();

        let finished = database
            .todo_update_status(TodoUpdateStatusInput {
                todo_id: created.id,
                status: "finished".to_string(),
            })
            .unwrap();
        assert_eq!(finished.status, "finished");
        assert_eq!(finished.progresses[0].status, "finished");

        let page = database.workspace_page_get().unwrap();
        assert!(page.unfinished_todos.is_empty());
        assert_eq!(page.finished_todos[0].id, created.id);

        database
            .todo_delete(TodoDeleteInput {
                todo_id: created.id,
            })
            .unwrap();
        assert!(database.workspace_todo_rail_list().unwrap().is_empty());
    }

    #[test]
    fn workspace_todo_rejects_project_tags_without_partially_persisting() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let project_tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                project_id: Some(project.id),
                id: None,
                label: "复盘".to_string(),
                color_key: "blue".to_string(),
            })
            .unwrap();

        let result = database.todo_create(TodoCreateInput {
            scope: TodoScope::Workspace,
            project_id: None,
            activity_id: None,
            content: "整理跨项目复盘".to_string(),
            priority: "not_urgent_important".to_string(),
            due_date: None,
            tag_ids: vec![project_tag.id],
        });

        assert!(result.is_err());
        assert!(database
            .workspace_todo_rail_list()
            .unwrap()
            .iter()
            .all(|todo| todo.content != "整理跨项目复盘"));

        let workspace_tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                project_id: None,
                id: None,
                label: "复盘".to_string(),
                color_key: "teal".to_string(),
            })
            .unwrap();
        assert_ne!(workspace_tag.id, project_tag.id);
        let todo = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Workspace,
                project_id: None,
                activity_id: None,
                content: "整理 Workspace 复盘".to_string(),
                priority: "not_urgent_important".to_string(),
                due_date: None,
                tag_ids: vec![workspace_tag.id],
            })
            .unwrap();

        let update_result = database.todo_update_content(TodoUpdateContentInput {
            todo_id: todo.id,
            content: "不应保存的修改".to_string(),
            due_date: Some("2026-08-10".to_string()),
            tag_ids: vec![project_tag.id],
        });

        assert!(update_result.is_err());
        let unchanged = database.todo_record(todo.id).unwrap();
        assert_eq!(unchanged.content, "整理 Workspace 复盘");
        assert_eq!(unchanged.due_date, None);
        assert_eq!(unchanged.tags.len(), 1);
        assert_eq!(unchanged.tags[0].id, workspace_tag.id);
    }

    #[test]
    fn todo_creation_rejects_invalid_scope_ownership_combinations() {
        let (harness, mut database) = setup_database();
        let first_project =
            create_project_named(&mut database, &harness.workspace_root, "First", None);
        let second_project =
            create_project_named(&mut database, &harness.workspace_root, "Second", None);
        let second_activity = create_activity(&mut database, second_project.id, "Second Activity");

        let cases = [
            (
                TodoScope::Workspace,
                Some(first_project.id),
                None,
                "Workspace Todo with Project",
            ),
            (
                TodoScope::Workspace,
                None,
                Some(second_activity.id),
                "Workspace Todo with Activity",
            ),
            (
                TodoScope::Project,
                None,
                None,
                "Project Todo without Project",
            ),
            (
                TodoScope::Project,
                Some(first_project.id),
                Some(second_activity.id),
                "Project Todo with another Project's Activity",
            ),
        ];

        for (scope, project_id, activity_id, content) in cases {
            let result = database.todo_create(TodoCreateInput {
                scope,
                project_id,
                activity_id,
                content: content.to_string(),
                priority: "not_urgent_important".to_string(),
                due_date: None,
                tag_ids: vec![],
            });

            assert!(result.is_err(), "{content} should be rejected");
        }
    }

    #[test]
    fn legacy_workspace_todos_migrate_to_project_scope_without_losing_data() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Legacy Activity");
        let tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                project_id: Some(project.id),
                id: None,
                label: "旧标签".to_string(),
                color_key: "blue".to_string(),
            })
            .unwrap();
        let todo = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Project,
                project_id: Some(project.id),
                activity_id: Some(activity.id),
                content: "曾从 Workspace 入口创建的旧 Todo".to_string(),
                priority: "urgent_important".to_string(),
                due_date: Some("2026-08-15".to_string()),
                tag_ids: vec![tag.id],
            })
            .unwrap();
        let progress = database
            .todo_add_progress(TodoAddProgressInput {
                todo_id: todo.id,
                content: "保留旧 Subtask".to_string(),
                progress_date: "2026-07-29".to_string(),
                due_date: Some("2026-08-02".to_string()),
            })
            .unwrap();
        let expected = database
            .todo_update_status(TodoUpdateStatusInput {
                todo_id: todo.id,
                status: "finished".to_string(),
            })
            .unwrap();

        downgrade_todos_to_legacy_schema(&database);
        let db_path = harness.root.join("app.sqlite3");
        drop(database);

        let reopened = Database::open(
            &db_path,
            &harness.workspace_root,
            Some("test-secret".to_string()),
        )
        .unwrap();
        let migrated = reopened.todo_record(todo.id).unwrap();

        assert_eq!(migrated.id, expected.id);
        assert_eq!(migrated.scope, TodoScope::Project);
        assert_eq!(migrated.project_id, Some(project.id));
        assert_eq!(migrated.activity_id, Some(activity.id));
        assert_eq!(migrated.content, expected.content);
        assert_eq!(migrated.status, expected.status);
        assert_eq!(migrated.priority, expected.priority);
        assert_eq!(migrated.due_date, expected.due_date);
        assert_eq!(migrated.created_at, expected.created_at);
        assert_eq!(migrated.updated_at, expected.updated_at);
        assert_eq!(migrated.tags.len(), 1);
        assert_eq!(migrated.tags[0].id, tag.id);
        assert_eq!(migrated.progresses.len(), 1);
        assert_eq!(migrated.progresses[0].id, progress.id);
        assert_eq!(migrated.progresses[0].content, progress.content);
        assert_eq!(migrated.progresses[0].due_date, progress.due_date);
    }

    #[test]
    fn legacy_todo_with_cross_project_activity_migrates_without_invalid_activity() {
        let (harness, mut database) = setup_database();
        let first_project =
            create_project_named(&mut database, &harness.workspace_root, "First", None);
        let second_project =
            create_project_named(&mut database, &harness.workspace_root, "Second", None);
        let second_activity = create_activity(&mut database, second_project.id, "Second Activity");
        let todo = create_todo(
            &mut database,
            first_project.id,
            None,
            "旧 Todo 的 Activity 归属已损坏",
            "not_urgent_important",
        );

        downgrade_todos_to_legacy_schema(&database);
        database
            .conn
            .execute(
                "UPDATE todos SET activity_id = ?1 WHERE id = ?2",
                params![second_activity.id, todo.id],
            )
            .unwrap();
        let db_path = harness.root.join("app.sqlite3");
        drop(database);

        let reopened = Database::open(
            &db_path,
            &harness.workspace_root,
            Some("test-secret".to_string()),
        )
        .unwrap();
        let migrated = reopened.todo_record(todo.id).unwrap();

        assert_eq!(migrated.scope, TodoScope::Project);
        assert_eq!(migrated.project_id, Some(first_project.id));
        assert_eq!(migrated.activity_id, None);
        assert_eq!(migrated.content, todo.content);
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
        assert_eq!(
            ids,
            vec![pinned_newest.id, pinned_older.id, unpinned_newer.id]
        );
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
            .project_page_get(ProjectIdInput {
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
                due_date: None,
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
                due_date: None,
            })
            .unwrap();

        thread::sleep(Duration::from_millis(5));

        let updated = database
            .todo_update_progress(TodoUpdateProgressInput {
                progress_id: progress.id,
                content: "已同步法务并补充截止时间".to_string(),
                progress_date: "2026-04-07".to_string(),
                due_date: None,
                status: None,
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
    fn todo_due_dates_are_stored_separately_from_creation_and_progress_dates() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let todo = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Project,
                project_id: Some(project.id),
                activity_id: None,
                content: "提交方案".to_string(),
                priority: "not_urgent_important".to_string(),
                due_date: Some("2027-03-15".to_string()),
                tag_ids: vec![],
            })
            .unwrap();

        assert_eq!(todo.due_date.as_deref(), Some("2027-03-15"));
        assert_ne!(todo.created_at.get(..10), todo.due_date.as_deref());

        let progress = database
            .todo_add_progress(TodoAddProgressInput {
                todo_id: todo.id,
                content: "确认附件".to_string(),
                progress_date: "2026-07-14".to_string(),
                due_date: Some("2027-03-16".to_string()),
            })
            .unwrap();

        assert_eq!(progress.progress_date, "2026-07-14");
        assert_eq!(progress.due_date.as_deref(), Some("2027-03-16"));
    }

    #[test]
    fn todo_progress_status_tracks_subitem_completion() {
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
                content: "等待财务确认".to_string(),
                progress_date: "2026-04-05".to_string(),
                due_date: None,
            })
            .unwrap();

        assert_eq!(progress.status, "unfinished");
        assert_eq!(progress.completed_at, None);
        assert_eq!(progress.order_index, 0);

        let finished = database
            .todo_update_progress(TodoUpdateProgressInput {
                progress_id: progress.id,
                content: progress.content.clone(),
                progress_date: progress.progress_date.clone(),
                due_date: progress.due_date.clone(),
                status: Some("finished".to_string()),
            })
            .unwrap();

        assert_eq!(finished.status, "finished");
        assert!(finished.completed_at.is_some());

        let reopened = database
            .todo_update_progress(TodoUpdateProgressInput {
                progress_id: progress.id,
                content: progress.content,
                progress_date: progress.progress_date,
                due_date: progress.due_date,
                status: Some("unfinished".to_string()),
            })
            .unwrap();

        assert_eq!(reopened.status, "unfinished");
        assert_eq!(reopened.completed_at, None);
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
                due_date: None,
            })
            .unwrap();
        let progress_b = database
            .todo_add_progress(TodoAddProgressInput {
                todo_id: todo.id,
                content: "等待财务确认".to_string(),
                progress_date: "2026-04-05".to_string(),
                due_date: None,
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
    fn project_update_can_rename_project_and_refresh_updated_at() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let old_root = PathBuf::from(&project.root_path);

        thread::sleep(Duration::from_millis(5));

        let updated = database
            .project_update(ProjectUpdateInput {
                project_id: project.id,
                name: Some("Alpha Prime".to_string()),
                summary: "最新项目简介".to_string(),
                summary_markdown: Some("## 最新项目简介\n- 风险已同步".to_string()),
                summary_html: Some("<h2>最新项目简介</h2><ul><li>风险已同步</li></ul>".to_string()),
                summary_code_language: None,
                status: Some("active".to_string()),
            })
            .unwrap();

        assert_eq!(updated.id, project.id);
        assert_eq!(updated.name, "Alpha Prime");
        assert_eq!(updated.summary, "最新项目简介");
        assert_eq!(updated.summary_markdown, "## 最新项目简介\n- 风险已同步");
        assert_eq!(
            updated.summary_html,
            "<h2>最新项目简介</h2><ul><li>风险已同步</li></ul>"
        );
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
    fn project_update_preserves_existing_rich_text_when_only_renaming() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);

        let enriched = database
            .project_update(ProjectUpdateInput {
                project_id: project.id,
                name: None,
                summary: "阶段目标与关键约束".to_string(),
                summary_markdown: Some("## 阶段目标\n- 关键约束".to_string()),
                summary_html: Some("<h2>阶段目标</h2><ul><li>关键约束</li></ul>".to_string()),
                summary_code_language: None,
                status: Some(project.status.clone()),
            })
            .unwrap();

        let renamed = database
            .project_update(ProjectUpdateInput {
                project_id: project.id,
                name: Some("Alpha Prime".to_string()),
                summary: enriched.summary.clone(),
                summary_markdown: None,
                summary_html: None,
                summary_code_language: None,
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
            .project_record_upsert(ProjectRecordUpsertInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                note_id: None,
                title: Some("路径联动记录".to_string()),
                markdown: "[图片] 截图\n[附件] 项目附件\n[附件] 活动附件".to_string(),
                html: rich_html.clone(),
                tag_ids: vec![],
                default_code_language: None,
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
            .project_update(ProjectUpdateInput {
                project_id: project.id,
                name: Some("Alpha Prime".to_string()),
                summary: project.summary.clone(),
                summary_markdown: None,
                summary_html: None,
                summary_code_language: None,
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
            .project_update(ProjectUpdateInput {
                project_id: project.id,
                name: Some("Alpha Prime".to_string()),
                summary: project.summary.clone(),
                summary_markdown: None,
                summary_html: None,
                summary_code_language: None,
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
    fn activity_update_meta_persists_brief_and_preserves_it_on_title_changes() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");

        let updated = database
            .activity_update_meta(ActivityUpdateMetaInput {
                activity_id: activity.id,
                title: None,
                brief_markdown: Some("## 当前背景\n- 已完成范围澄清".to_string()),
                brief_html: Some("<h2>当前背景</h2><ul><li>已完成范围澄清</li></ul>".to_string()),
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
                project_id: None,
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
        assert_eq!(project_documents.len(), 2);
        assert!(project_documents
            .iter()
            .any(|item| item.id == root_document.id));
        assert!(project_documents
            .iter()
            .any(|item| item.id == visible_document.id));
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
        let workspace_todo = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Workspace,
                project_id: None,
                activity_id: None,
                content: "工作区预算统筹".to_string(),
                priority: "not_urgent_important".to_string(),
                due_date: None,
                tag_ids: Vec::new(),
            })
            .unwrap();

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
        assert!(!project_results
            .iter()
            .any(|result| result.id == other_todo.id));
        assert!(workspace_results
            .iter()
            .any(|result| result.kind == "todo" && result.id == other_todo.id));
        let workspace_todo_result = workspace_results
            .iter()
            .find(|result| result.kind == "todo" && result.id == workspace_todo.id)
            .unwrap();
        assert_eq!(workspace_todo_result.scope, TodoScope::Workspace);
        assert_eq!(workspace_todo_result.project_id, None);

        database
            .project_set_archive(ProjectArchiveInput {
                project_id: other_project.id,
                is_archived: true,
            })
            .unwrap();
        let active_workspace_results = database
            .internal_reference_search(InternalReferenceSearchInput {
                query: "".to_string(),
                project_id: None,
                scope: "workspace".to_string(),
                limit: 20,
            })
            .unwrap();
        assert!(!active_workspace_results
            .iter()
            .any(|result| result.kind == "todo" && result.id == other_todo.id));
        let resolved_archived_todo = database
            .internal_reference_resolve(InternalReferenceResolveInput {
                kind: "todo".to_string(),
                id: other_todo.id,
            })
            .unwrap()
            .unwrap();
        assert_eq!(resolved_archived_todo.scope, TodoScope::Project);
        assert_eq!(resolved_archived_todo.project_id, Some(other_project.id));
    }

    #[test]
    fn todo_content_rejects_internal_references_outside_its_scope() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let other_project = database
            .project_create(ProjectCreateInput {
                name: "Beta".to_string(),
                summary: None,
                status: None,
            })
            .unwrap();
        let workspace_todo = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Workspace,
                project_id: None,
                activity_id: None,
                content: "Workspace target".to_string(),
                priority: "not_urgent_important".to_string(),
                due_date: None,
                tag_ids: Vec::new(),
            })
            .unwrap();
        let other_todo = create_todo(
            &mut database,
            other_project.id,
            None,
            "Other Project target",
            "not_urgent_important",
        );

        let workspace_reference = format!("[[todo:{}|Workspace target]]", workspace_todo.id);
        let other_project_reference = format!("[[todo:{}|Other Project target]]", other_todo.id);

        let workspace_with_reference = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Workspace,
                project_id: None,
                activity_id: None,
                content: other_project_reference.clone(),
                priority: "not_urgent_important".to_string(),
                due_date: None,
                tag_ids: Vec::new(),
            })
            .unwrap();
        assert_eq!(workspace_with_reference.content, other_project_reference);

        let project_to_workspace = database.todo_create(TodoCreateInput {
            scope: TodoScope::Project,
            project_id: Some(project.id),
            activity_id: None,
            content: workspace_reference,
            priority: "not_urgent_important".to_string(),
            due_date: None,
            tag_ids: Vec::new(),
        });
        assert!(project_to_workspace
            .unwrap_err()
            .to_string()
            .contains("Project Todo 不能引用 Workspace 内容"));

        let project_to_other_project = database.todo_create(TodoCreateInput {
            scope: TodoScope::Project,
            project_id: Some(project.id),
            activity_id: None,
            content: other_project_reference.clone(),
            priority: "not_urgent_important".to_string(),
            due_date: None,
            tag_ids: Vec::new(),
        });
        assert!(project_to_other_project
            .unwrap_err()
            .to_string()
            .contains("Project Todo 不能引用其他 Project 的内容"));

        database
            .project_set_archive(ProjectArchiveInput {
                project_id: other_project.id,
                is_archived: true,
            })
            .unwrap();
        let new_archived_reference = database.todo_create(TodoCreateInput {
            scope: TodoScope::Workspace,
            project_id: None,
            activity_id: None,
            content: other_project_reference.clone(),
            priority: "not_urgent_important".to_string(),
            due_date: None,
            tag_ids: Vec::new(),
        });
        assert!(new_archived_reference
            .unwrap_err()
            .to_string()
            .contains("Workspace Todo 不能新增指向已归档 Project 的引用"));

        let preserved = database
            .todo_update_content(TodoUpdateContentInput {
                todo_id: workspace_with_reference.id,
                content: format!("{} 继续跟进", other_project_reference),
                due_date: None,
                tag_ids: Vec::new(),
            })
            .unwrap();
        assert!(preserved.content.contains(&other_project_reference));
        let legacy_token_target = database
            .internal_reference_resolve(InternalReferenceResolveInput {
                kind: "todo".to_string(),
                id: other_todo.id,
            })
            .unwrap()
            .unwrap();
        assert_eq!(legacy_token_target.id, other_todo.id);
        assert_eq!(legacy_token_target.project_id, Some(other_project.id));
    }

    #[test]
    fn workspace_search_prioritizes_fields_match_strength_and_notes() {
        let (harness, mut database) = setup_database();
        let project_exact =
            create_project_named(&mut database, &harness.workspace_root, "预算", None);
        let project_prefix =
            create_project_named(&mut database, &harness.workspace_root, "预算平台", None);
        let project_contains =
            create_project_named(&mut database, &harness.workspace_root, "推进预算系统", None);
        let project_summary = create_project_named(
            &mut database,
            &harness.workspace_root,
            "Alpha",
            Some("预算摘要"),
        );

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
                project_id: None,
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

        let activity_result = results
            .iter()
            .find(|result| result.kind == "activity" && result.id == activity.id)
            .unwrap();
        assert_eq!(activity_result.activity_id, Some(activity.id));
        assert_eq!(activity_result.matched_text, "预算");

        let note_body_result = results
            .iter()
            .find(|result| result.kind == "note" && result.id == note_body.id)
            .unwrap();
        assert_eq!(note_body_result.matched_text, "预算只写在正文里");

        database
            .conn
            .execute(
                "UPDATE activities SET brief_markdown = ?1 WHERE id = ?2",
                params!["本次复盘讨论长期现金流预测", activity.id],
            )
            .unwrap();
        let brief_results = database
            .workspace_search(WorkspaceSearchInput {
                query: "现金流".to_string(),
                include_archived: Some(true),
                project_id: None,
            })
            .unwrap();
        let brief_activity = brief_results
            .iter()
            .find(|result| result.kind == "activity" && result.id == activity.id)
            .unwrap();
        assert_eq!(brief_activity.matched_text, "本次复盘讨论长期现金流预测");
    }

    #[test]
    fn workspace_search_includes_workspace_notes_todo_progress_and_tags() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "搜索补全");
        let workspace_tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                project_id: None,
                id: None,
                label: "专项检索标签".to_string(),
                color_key: "blue".to_string(),
            })
            .unwrap();
        let project_tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                project_id: Some(project.id),
                id: None,
                label: "专项检索标签".to_string(),
                color_key: "blue".to_string(),
            })
            .unwrap();

        let quick_note = database
            .workspace_quick_note_upsert(WorkspaceQuickNoteUpsertInput {
                markdown: "Workspace 快速笔记中的跨域关键词".to_string(),
                html: "<p>Workspace 快速笔记中的跨域关键词</p>".to_string(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        let workspace_note = database
            .workspace_record_upsert(WorkspaceRecordUpsertInput {
                note_id: None,
                title: Some("Workspace 搜索记录".to_string()),
                markdown: "记录正文".to_string(),
                html: "<p>记录正文</p>".to_string(),
                default_code_language: None,
                tag_ids: vec![workspace_tag.id],
            })
            .unwrap();
        let contact = database
            .contact_upsert(ContactUpsertInput {
                id: None,
                name: "张三".to_string(),
                pinyin_full: Some("zhangsan".to_string()),
                pinyin_abbr: Some("zs".to_string()),
                email: Some("zhangsan@example.com".to_string()),
                employee_id: Some("EMP-SEARCH".to_string()),
                role: Some("产品负责人".to_string()),
                department: Some("创新中心".to_string()),
            })
            .unwrap();

        let project_note = database
            .project_record_upsert(ProjectRecordUpsertInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                note_id: None,
                title: Some("项目记录".to_string()),
                markdown: "项目正文".to_string(),
                html: "<p>项目正文</p>".to_string(),
                default_code_language: None,
                tag_ids: vec![project_tag.id],
            })
            .unwrap();
        let todo = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Project,
                project_id: Some(project.id),
                activity_id: Some(activity.id),
                content: "跟进搜索覆盖".to_string(),
                priority: "not_urgent_important".to_string(),
                due_date: None,
                tag_ids: vec![project_tag.id],
            })
            .unwrap();
        database
            .todo_add_progress(TodoAddProgressInput {
                todo_id: todo.id,
                content: "Todo 进展里的独有检索词".to_string(),
                progress_date: "2026-07-14".to_string(),
                due_date: None,
            })
            .unwrap();

        let document_source = harness.root.join("search-coverage.pdf");
        fs::write(&document_source, b"coverage").unwrap();
        let document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                source_path: document_source.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: Some(vec![project_tag.id]),
            })
            .unwrap();

        let quick_results = database
            .workspace_search(WorkspaceSearchInput {
                query: "跨域关键词".to_string(),
                include_archived: None,
                project_id: None,
            })
            .unwrap();
        let quick_result = quick_results
            .iter()
            .find(|result| result.kind == "workspace_quick_note" && result.id == quick_note.id)
            .unwrap();
        assert_eq!(quick_result.project_id, None);

        let title_results = database
            .workspace_search(WorkspaceSearchInput {
                query: "搜索记录".to_string(),
                include_archived: None,
                project_id: None,
            })
            .unwrap();
        assert!(title_results
            .iter()
            .any(|result| result.kind == "workspace_note" && result.id == workspace_note.id));

        let contact_results = database
            .workspace_search(WorkspaceSearchInput {
                query: "zhangsan".to_string(),
                include_archived: None,
                project_id: None,
            })
            .unwrap();
        assert!(contact_results
            .iter()
            .any(|result| result.kind == "contact" && result.id == contact.id));

        let progress_results = database
            .workspace_search(WorkspaceSearchInput {
                query: "独有检索词".to_string(),
                include_archived: None,
                project_id: None,
            })
            .unwrap();
        let progress_result = progress_results
            .iter()
            .find(|result| result.kind == "todo" && result.id == todo.id)
            .unwrap();
        assert_eq!(progress_result.matched_text, "Todo 进展里的独有检索词");

        let tag_results = database
            .workspace_search(WorkspaceSearchInput {
                query: "专项检索标签".to_string(),
                include_archived: None,
                project_id: None,
            })
            .unwrap();
        assert!(tag_results
            .iter()
            .any(|result| result.kind == "workspace_note" && result.id == workspace_note.id));
        assert!(tag_results
            .iter()
            .any(|result| result.kind == "note" && result.id == project_note.id));
        assert!(tag_results
            .iter()
            .any(|result| result.kind == "todo" && result.id == todo.id));
        assert!(tag_results
            .iter()
            .any(|result| result.kind == "document" && result.id == document.id));
    }

    #[test]
    fn workspace_search_distinguishes_todo_scopes_and_applies_archive_semantics() {
        let (harness, mut database) = setup_database();
        let active_project =
            create_project_named(&mut database, &harness.workspace_root, "Active", None);
        let archived_project =
            create_project_named(&mut database, &harness.workspace_root, "Archived", None);
        database
            .project_set_archive(ProjectArchiveInput {
                project_id: archived_project.id,
                is_archived: true,
            })
            .unwrap();

        let workspace_todo = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Workspace,
                project_id: None,
                activity_id: None,
                content: "共同检索词 Workspace Todo".to_string(),
                priority: "not_urgent_important".to_string(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
        let active_todo = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Project,
                project_id: Some(active_project.id),
                activity_id: None,
                content: "共同检索词 Project Todo".to_string(),
                priority: "not_urgent_important".to_string(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
        let archived_todo = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Project,
                project_id: Some(archived_project.id),
                activity_id: None,
                content: "共同检索词 Archived Todo".to_string(),
                priority: "not_urgent_important".to_string(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();

        let active_results = database
            .workspace_search(WorkspaceSearchInput {
                query: "共同检索词".to_string(),
                include_archived: None,
                project_id: None,
            })
            .unwrap();
        let workspace_result = active_results
            .iter()
            .find(|result| result.kind == "todo" && result.id == workspace_todo.id)
            .unwrap();
        assert_eq!(workspace_result.scope.as_deref(), Some("workspace"));
        assert_eq!(workspace_result.project_id, None);
        assert_eq!(workspace_result.subtitle, "");
        assert_eq!(workspace_result.source.as_deref(), Some("Workspace"));
        let active_result = active_results
            .iter()
            .find(|result| result.kind == "todo" && result.id == active_todo.id)
            .unwrap();
        assert_eq!(active_result.scope.as_deref(), Some("project"));
        assert_eq!(active_result.project_id, Some(active_project.id));
        assert_eq!(active_result.subtitle, "");
        assert_eq!(active_result.source.as_deref(), Some("Active"));
        assert!(!active_results
            .iter()
            .any(|result| result.kind == "todo" && result.id == archived_todo.id));

        let archived_results = database
            .workspace_search(WorkspaceSearchInput {
                query: "共同检索词".to_string(),
                include_archived: Some(true),
                project_id: None,
            })
            .unwrap();
        assert!(archived_results
            .iter()
            .any(|result| result.kind == "todo" && result.id == workspace_todo.id));
        assert!(archived_results
            .iter()
            .any(|result| result.kind == "todo" && result.id == archived_todo.id));

        let exact_workspace_todo = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Workspace,
                project_id: None,
                activity_id: None,
                content: "统一排序".to_string(),
                priority: "not_urgent_important".to_string(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
        let prefix_project_todo = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Project,
                project_id: Some(active_project.id),
                activity_id: None,
                content: "统一排序 Project Todo".to_string(),
                priority: "not_urgent_important".to_string(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
        let sorted_results = database
            .workspace_search(WorkspaceSearchInput {
                query: "统一排序".to_string(),
                include_archived: None,
                project_id: None,
            })
            .unwrap();
        let sorted_todo_ids = sorted_results
            .iter()
            .filter(|result| result.kind == "todo")
            .map(|result| result.id)
            .collect::<Vec<_>>();
        assert_eq!(
            sorted_todo_ids,
            vec![exact_workspace_todo.id, prefix_project_todo.id]
        );
    }

    #[test]
    fn project_search_returns_only_current_project_todos_with_scoped_matches() {
        let (harness, mut database) = setup_database();
        let project = create_project_named(&mut database, &harness.workspace_root, "Current", None);
        let other_project =
            create_project_named(&mut database, &harness.workspace_root, "Other", None);
        let workspace_tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                project_id: None,
                id: None,
                label: "同名标签".to_string(),
                color_key: "blue".to_string(),
            })
            .unwrap();
        let project_tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                project_id: Some(project.id),
                id: None,
                label: "同名标签".to_string(),
                color_key: "blue".to_string(),
            })
            .unwrap();

        let workspace_todo = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Workspace,
                project_id: None,
                activity_id: None,
                content: "Workspace 专属正文".to_string(),
                priority: "not_urgent_important".to_string(),
                due_date: None,
                tag_ids: vec![workspace_tag.id],
            })
            .unwrap();
        let project_todo = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Project,
                project_id: Some(project.id),
                activity_id: None,
                content: "Current 专属正文".to_string(),
                priority: "not_urgent_important".to_string(),
                due_date: None,
                tag_ids: vec![project_tag.id],
            })
            .unwrap();
        database
            .todo_add_progress(TodoAddProgressInput {
                todo_id: project_todo.id,
                content: "Current 独有 Subtask".to_string(),
                progress_date: "2026-07-30".to_string(),
                due_date: None,
            })
            .unwrap();
        let other_todo = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Project,
                project_id: Some(other_project.id),
                activity_id: None,
                content: "Current 专属正文也出现在其他 Project".to_string(),
                priority: "not_urgent_important".to_string(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();

        for query in ["Current 专属正文", "Current 独有 Subtask", "同名标签"] {
            let results = database
                .workspace_search(WorkspaceSearchInput {
                    query: query.to_string(),
                    include_archived: None,
                    project_id: Some(project.id),
                })
                .unwrap();
            assert!(results
                .iter()
                .any(|result| result.kind == "todo" && result.id == project_todo.id));
            assert!(!results
                .iter()
                .any(|result| result.kind == "todo" && result.id == workspace_todo.id));
            assert!(!results
                .iter()
                .any(|result| result.kind == "todo" && result.id == other_todo.id));
            assert!(results.iter().all(|result| result.kind == "todo"));
        }
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
        create_todo(
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
                due_date: None,
                tag_ids: vec![],
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
        assert!(empty_todo_results
            .iter()
            .all(|result| result.kind == "todo"));
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
                html: "<p>[[note:1|预算记录]] 预算审批需要补充材料并确认时间安排</p>".to_string(),
                promoted_to_project: false,
                is_pinned: None,
            })
            .unwrap();
        let todo = create_todo(
            &mut database,
            project.id,
            Some(activity.id),
            &format!(
                "[[note:{}|预算记录]] 联系财务安排评审并确认后续计划时间",
                note.id
            ),
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

        assert_eq!(
            resolved_conclusion.label,
            "预算审批需要补充材料并确认时间..."
        );
        assert!(!resolved_conclusion.label.contains("[["));
        assert_eq!(resolved_todo.label, "联系财务安排评审并确认后续计划...");
        assert!(!resolved_todo.label.contains("[["));
    }

    #[test]
    fn internal_reference_resolve_returns_current_routes_after_document_moves() {
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
        let resolved_document = database
            .internal_reference_resolve(InternalReferenceResolveInput {
                kind: "document".to_string(),
                id: document.id,
            })
            .unwrap()
            .unwrap();

        assert_eq!(
            resolved_note.route,
            format!("/projects/{}/records/{}", project.id, note.id)
        );
        assert_eq!(
            resolved_conclusion.route,
            format!(
                "/projects/{}?focus=conclusion-{}",
                project.id, conclusion.id
            )
        );
        assert_eq!(
            resolved_document.route,
            format!("/projects/{}?focus=document-{}", project.id, document.id)
        );
        let current_document = database.document_record(document.id).unwrap();
        assert_eq!(
            resolved_document.managed_path.as_deref(),
            Some(current_document.managed_path.as_str())
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
        assert_eq!(
            fs::read(&document.managed_path).unwrap(),
            b"clipboard-note-image"
        );
        assert!(document.name.ends_with(".heic"));
        assert!(document.managed_path.ends_with(".heic"));
    }

    #[test]
    fn workspace_note_image_imports_are_file_backed_without_project_documents() {
        let (harness, mut database) = setup_database();
        let source_path = harness.root.join("workspace-clip.png");
        fs::write(&source_path, b"workspace-image").unwrap();

        let first = database
            .workspace_note_image_import(WorkspaceNoteImageImportInput {
                source_path: source_path.to_string_lossy().to_string(),
            })
            .unwrap();
        let second = database
            .workspace_clipboard_note_image_import(WorkspaceClipboardNoteImageImportInput {
                file_name: "workspace-clip.png".to_string(),
                mime_type: "image/png".to_string(),
                data_base64: STANDARD.encode("second-image"),
            })
            .unwrap();

        assert!(source_path.exists());
        assert!(Path::new(&first.path).exists());
        assert!(Path::new(&second.path).exists());
        assert_eq!(fs::read(&first.path).unwrap(), b"workspace-image");
        assert_eq!(fs::read(&second.path).unwrap(), b"second-image");
        assert_eq!(first.mime_type, "image/png");
        assert_eq!(second.mime_type, "image/png");
        assert!(first
            .path
            .contains(".project-mind/embedded-note-assets/workspace/"));
        assert!(second.path.ends_with("workspace-clip-2.png"));
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
            .project_record_upsert(ProjectRecordUpsertInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                note_id: None,
                title: Some("活动附件记录".to_string()),
                markdown: "[附件] agenda".to_string(),
                html: rich_html.clone(),
                tag_ids: vec![],
                default_code_language: None,
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
                project_id: Some(project.id),
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
            .project_page_get(ProjectIdInput {
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
        assert!(document_ids.contains(&activity_document.id));
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
            .project_page_get(ProjectIdInput {
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
    fn contact_upsert_search_and_delete_round_trip() {
        let (_harness, mut database) = setup_database();

        let created = database
            .contact_upsert(ContactUpsertInput {
                id: None,
                name: "张三".to_string(),
                pinyin_full: Some("zhangsan".to_string()),
                pinyin_abbr: Some("zs".to_string()),
                email: Some("zhangsan@example.com".to_string()),
                employee_id: Some("E007".to_string()),
                role: Some("PM".to_string()),
                department: Some("Product".to_string()),
            })
            .unwrap();

        assert_eq!(created.name, "张三");
        assert_eq!(created.pinyin_full, "zhangsan");
        assert_eq!(created.pinyin_abbr, "zs");

        let pinyin_matches = database
            .contact_search(ContactSearchInput {
                query: "zs".to_string(),
                limit: Some(10),
            })
            .unwrap();
        assert_eq!(pinyin_matches[0].id, created.id);

        let email_matches = database
            .contact_search(ContactSearchInput {
                query: "example.com".to_string(),
                limit: Some(10),
            })
            .unwrap();
        assert_eq!(email_matches[0].id, created.id);

        let updated = database
            .contact_upsert(ContactUpsertInput {
                id: Some(created.id),
                name: "张三丰".to_string(),
                pinyin_full: Some("zhangsanfeng".to_string()),
                pinyin_abbr: Some("zsf".to_string()),
                email: Some("zsf@example.com".to_string()),
                employee_id: Some("E008".to_string()),
                role: Some("Tech Lead".to_string()),
                department: Some("Engineering".to_string()),
            })
            .unwrap();
        assert_eq!(updated.name, "张三丰");
        assert_eq!(updated.employee_id, "E008");

        let deleted = database
            .contact_delete(ContactDeleteInput {
                contact_id: created.id,
            })
            .unwrap();
        assert_eq!(deleted.id, created.id);
        assert!(database
            .contact_search(ContactSearchInput {
                query: "zsf".to_string(),
                limit: Some(10),
            })
            .unwrap()
            .is_empty());
    }

    #[test]
    fn file_tag_settings_round_trip_usage_counts_and_document_payloads() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);

        let legal_tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                project_id: Some(project.id),
                id: None,
                label: "法务".to_string(),
                color_key: "blue".to_string(),
            })
            .unwrap();
        let urgent_tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                project_id: Some(project.id),
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
            .project_page_get(ProjectIdInput {
                project_id: project.id,
            })
            .unwrap();
        let settings = database
            .file_tag_settings_get(FileTagSettingsGetInput {
                project_id: Some(project.id),
            })
            .unwrap();

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
    fn tag_scopes_are_isolated_between_workspace_and_projects() {
        let (harness, mut database) = setup_database();
        let first_project = create_project(&mut database, &harness.workspace_root);
        let second_project =
            create_project_named(&mut database, &harness.workspace_root, "Beta", None);
        let workspace_tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                project_id: None,
                id: None,
                label: "工作区标签".to_string(),
                color_key: "blue".to_string(),
            })
            .unwrap();
        let first_project_tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                project_id: Some(first_project.id),
                id: None,
                label: "项目标签".to_string(),
                color_key: "teal".to_string(),
            })
            .unwrap();
        let second_project_tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                project_id: Some(second_project.id),
                id: None,
                label: "项目标签".to_string(),
                color_key: "green".to_string(),
            })
            .unwrap();

        let workspace_settings = database
            .file_tag_settings_get(FileTagSettingsGetInput { project_id: None })
            .unwrap();
        assert_eq!(
            workspace_settings
                .tags
                .iter()
                .map(|tag| tag.id)
                .collect::<Vec<_>>(),
            vec![workspace_tag.id]
        );

        let workspace_record = database
            .workspace_record_upsert(WorkspaceRecordUpsertInput {
                note_id: None,
                title: Some("工作区记录".to_string()),
                markdown: "正文".to_string(),
                html: "<p>正文</p>".to_string(),
                default_code_language: None,
                tag_ids: vec![workspace_tag.id],
            })
            .unwrap();
        database
            .conn
            .execute(
                "INSERT INTO workspace_note_tag_links (workspace_note_id, tag_id, created_at) VALUES (?1, ?2, ?3)",
                params![workspace_record.id, first_project_tag.id, now_iso()],
            )
            .unwrap();
        database.prune_out_of_scope_project_tag_links().unwrap();
        assert_eq!(
            database
                .workspace_note_record(workspace_record.id)
                .unwrap()
                .tags
                .iter()
                .map(|tag| tag.id)
                .collect::<Vec<_>>(),
            vec![workspace_tag.id]
        );

        let workspace_error = database
            .workspace_record_upsert(WorkspaceRecordUpsertInput {
                note_id: None,
                title: Some("跨作用域".to_string()),
                markdown: "正文".to_string(),
                html: "<p>正文</p>".to_string(),
                default_code_language: None,
                tag_ids: vec![first_project_tag.id],
            })
            .unwrap_err();
        assert!(workspace_error
            .to_string()
            .contains("tag does not belong to the active scope"));

        let project_error = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Project,
                project_id: Some(first_project.id),
                activity_id: None,
                content: "跨项目标签".to_string(),
                priority: "not_urgent_important".to_string(),
                due_date: None,
                tag_ids: vec![second_project_tag.id],
            })
            .unwrap_err();
        assert!(project_error
            .to_string()
            .contains("tag does not belong to the active scope"));
    }

    #[test]
    fn document_update_meta_replaces_document_tags_without_losing_other_changes() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);

        let draft_tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                project_id: Some(project.id),
                id: None,
                label: "草稿".to_string(),
                color_key: "slate".to_string(),
            })
            .unwrap();
        let review_tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                project_id: Some(project.id),
                id: None,
                label: "待审核".to_string(),
                color_key: "amber".to_string(),
            })
            .unwrap();
        let final_tag = database
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                project_id: Some(project.id),
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
        let settings = database
            .file_tag_settings_get(FileTagSettingsGetInput {
                project_id: Some(project.id),
            })
            .unwrap();

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
                project_id: Some(project.id),
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
            .file_tag_option_delete(FileTagOptionDeleteInput {
                project_id: Some(project.id),
                tag_id: tag.id,
            })
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
                project_id: None,
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
    fn project_record_delete_removes_note_from_activity_results() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");
        let note = create_note(
            &mut database,
            project.id,
            activity.id,
            "",
            "Captured detail",
        );

        let deleted = database
            .project_record_delete(ProjectRecordDeleteInput { note_id: note.id })
            .unwrap();

        assert_eq!(deleted.id, note.id);
        assert!(database.note_record(note.id).is_err());
        assert!(database.fetch_notes(activity.id).unwrap().is_empty());
    }

    #[test]
    fn project_archive_only_changes_workspace_todo_visibility() {
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
        let finished_project_todo = create_todo(
            &mut database,
            active_project.id,
            None,
            "完成发布复盘",
            "not_urgent_important",
        );
        let archived_open_todo = create_todo(
            &mut database,
            archived_project.id,
            None,
            "归档项目未完成 Todo",
            "not_urgent_not_important",
        );
        let archived_finished_todo = create_todo(
            &mut database,
            archived_project.id,
            None,
            "归档项目已完成 Todo",
            "not_urgent_important",
        );
        database
            .todo_update_status(TodoUpdateStatusInput {
                todo_id: archived_finished_todo.id,
                status: "finished".to_string(),
            })
            .unwrap();
        let workspace_todo = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Workspace,
                project_id: None,
                activity_id: None,
                content: "跨项目复盘".to_string(),
                priority: "not_urgent_important".to_string(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
        let finished_workspace_todo = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Workspace,
                project_id: None,
                activity_id: None,
                content: format!("回顾 Project {}", active_project.name),
                priority: "not_urgent_not_important".to_string(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
        database
            .todo_update_status(TodoUpdateStatusInput {
                todo_id: finished_project_todo.id,
                status: "finished".to_string(),
            })
            .unwrap();
        database
            .todo_update_status(TodoUpdateStatusInput {
                todo_id: finished_workspace_todo.id,
                status: "finished".to_string(),
            })
            .unwrap();
        let before_archive = database.workspace_todo_rail_list().unwrap();
        assert!(before_archive
            .iter()
            .any(|todo| todo.id == archived_open_todo.id));
        assert!(before_archive
            .iter()
            .any(|todo| todo.id == archived_finished_todo.id));
        database
            .project_set_archive(ProjectArchiveInput {
                project_id: archived_project.id,
                is_archived: true,
            })
            .unwrap();

        let todos = database.workspace_todo_rail_list().unwrap();

        assert_eq!(todos.len(), 4);
        let listed_workspace_todo = todos
            .iter()
            .find(|todo| todo.id == workspace_todo.id)
            .unwrap();
        assert_eq!(listed_workspace_todo.project_name, None);
        assert!(!todos.iter().any(|todo| todo.id == archived_open_todo.id));
        assert!(!todos
            .iter()
            .any(|todo| todo.id == archived_finished_todo.id));
        let listed_project_todo = todos.iter().find(|todo| todo.id == active_todo.id).unwrap();
        assert_eq!(
            listed_project_todo.project_name.as_deref(),
            Some(active_project.name.as_str())
        );
        assert_eq!(
            listed_project_todo.source_activity_title.as_deref(),
            Some("Kickoff")
        );

        let project_page = database
            .project_page_get(ProjectIdInput {
                project_id: active_project.id,
            })
            .unwrap();
        assert_eq!(project_page.unfinished_todos.len(), 1);
        assert_eq!(project_page.unfinished_todos[0].id, active_todo.id);
        assert_eq!(project_page.finished_todos.len(), 1);
        assert_eq!(project_page.finished_todos[0].id, finished_project_todo.id);
        assert!(project_page
            .unfinished_todos
            .iter()
            .chain(project_page.finished_todos.iter())
            .all(|todo| todo.scope == TodoScope::Project
                && todo.project_id == Some(active_project.id)));

        let workspace_page = database.workspace_page_get().unwrap();
        assert!(workspace_page
            .unfinished_todos
            .iter()
            .any(|todo| todo.id == workspace_todo.id));
        assert!(workspace_page
            .unfinished_todos
            .iter()
            .any(|todo| todo.id == active_todo.id));
        assert!(workspace_page
            .finished_todos
            .iter()
            .any(|todo| todo.id == finished_workspace_todo.id));
        assert!(workspace_page
            .finished_todos
            .iter()
            .any(|todo| todo.id == finished_project_todo.id));

        let active_project_list_item = database
            .projects_list(ProjectsListInput {
                include_archived: Some(false),
            })
            .unwrap()
            .into_iter()
            .find(|project| project.id == active_project.id)
            .unwrap();
        assert_eq!(active_project_list_item.open_todo_count, 1);

        let archived_page = database
            .project_page_get(ProjectIdInput {
                project_id: archived_project.id,
            })
            .unwrap();
        assert_eq!(archived_page.unfinished_todos[0].id, archived_open_todo.id);
        assert_eq!(archived_page.unfinished_todos[0].status, "unfinished");
        assert_eq!(
            archived_page.finished_todos[0].id,
            archived_finished_todo.id
        );
        assert_eq!(archived_page.finished_todos[0].status, "finished");

        database
            .project_set_archive(ProjectArchiveInput {
                project_id: archived_project.id,
                is_archived: false,
            })
            .unwrap();
        let restored = database.workspace_todo_rail_list().unwrap();
        assert!(restored.iter().any(|todo| todo.id == workspace_todo.id));
        assert!(restored
            .iter()
            .any(|todo| todo.id == finished_workspace_todo.id));
        assert_eq!(
            restored
                .iter()
                .find(|todo| todo.id == archived_open_todo.id)
                .unwrap()
                .status,
            "unfinished"
        );
        assert_eq!(
            restored
                .iter()
                .find(|todo| todo.id == archived_finished_todo.id)
                .unwrap()
                .status,
            "finished"
        );

        let projects = database
            .projects_list(ProjectsListInput {
                include_archived: Some(true),
            })
            .unwrap();
        assert_eq!(
            projects
                .iter()
                .find(|project| project.id == archived_project.id)
                .unwrap()
                .open_todo_count,
            1
        );
    }

    #[test]
    fn workspace_notes_round_trip_create_update_delete_and_sort() {
        use std::{thread::sleep, time::Duration};

        let (_harness, mut database) = setup_database();
        let first = database
            .workspace_record_upsert(WorkspaceRecordUpsertInput {
                note_id: None,
                title: Some("第一条".to_string()),
                markdown: "第一条记录".to_string(),
                html: "<p>第一条记录</p>".to_string(),
                tag_ids: vec![],
                default_code_language: None,
            })
            .unwrap();

        sleep(Duration::from_millis(5));

        let second = database
            .workspace_record_upsert(WorkspaceRecordUpsertInput {
                note_id: None,
                title: Some("第二条".to_string()),
                markdown: "第二条记录".to_string(),
                html: "<p>第二条记录</p>".to_string(),
                tag_ids: vec![],
                default_code_language: None,
            })
            .unwrap();

        sleep(Duration::from_millis(5));

        let updated_first = database
            .workspace_record_upsert(WorkspaceRecordUpsertInput {
                note_id: Some(first.id),
                title: Some("第一条（更新）".to_string()),
                markdown: "第一条记录，补充判断".to_string(),
                html: "<p>第一条记录，补充判断</p>".to_string(),
                tag_ids: vec![],
                default_code_language: None,
            })
            .unwrap();

        let listed = database.workspace_record_list().unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, updated_first.id);
        assert_eq!(listed[0].title.as_deref(), Some("第一条（更新）"));
        assert_eq!(listed[1].id, second.id);

        let deleted = database
            .workspace_record_delete(WorkspaceRecordDeleteInput { note_id: second.id })
            .unwrap();
        assert_eq!(deleted.id, second.id);
        assert!(database.workspace_note_record(second.id).is_err());

        let remaining = database.workspace_record_list().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, updated_first.id);
    }

    #[test]
    fn today_quick_note_is_singleton_and_stays_out_of_workspace_notes() {
        let (_harness, mut database) = setup_database();

        let first = database
            .workspace_quick_note_upsert(WorkspaceQuickNoteUpsertInput {
                markdown: "第一版今日快记".to_string(),
                html: "<p>第一版今日快记</p>".to_string(),
                tag_ids: vec![],
                default_code_language: None,
            })
            .unwrap();
        let second = database
            .workspace_quick_note_upsert(WorkspaceQuickNoteUpsertInput {
                markdown: "更新后的今日快记".to_string(),
                html: "<p>更新后的今日快记</p>".to_string(),
                tag_ids: vec![],
                default_code_language: None,
            })
            .unwrap();
        let workspace_note = database
            .workspace_record_upsert(WorkspaceRecordUpsertInput {
                note_id: None,
                title: Some("工作区记录".to_string()),
                markdown: "常规工作区记录".to_string(),
                html: "<p>常规工作区记录</p>".to_string(),
                tag_ids: vec![],
                default_code_language: None,
            })
            .unwrap();

        assert_eq!(first.id, second.id);
        assert_eq!(second.title, None);

        let quick_note = database.workspace_quick_note_get().unwrap().unwrap();
        assert_eq!(quick_note.id, second.id);
        assert_eq!(quick_note.content_markdown, "更新后的今日快记");

        let listed = database.workspace_record_list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, workspace_note.id);
        assert_eq!(listed[0].title.as_deref(), Some("工作区记录"));
    }

    #[test]
    fn project_record_upsert_preserves_embedded_image_html() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");
        let data_url = format!("data:image/png;base64,{}", "A".repeat(256));
        let html = format!(r#"<p><img src="{data_url}" alt="截图" /></p>"#);

        let saved = database
            .project_record_upsert(ProjectRecordUpsertInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                note_id: None,
                title: Some("带图片记录".to_string()),
                markdown: "[图片] 截图".to_string(),
                html: html.clone(),
                tag_ids: vec![],
                default_code_language: None,
            })
            .unwrap();

        assert_eq!(saved.content_html, html);
    }

    #[test]
    fn project_record_upsert_preserves_embedded_image_metadata_html() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");
        let data_url = format!("data:image/png;base64,{}", "B".repeat(384));
        let html = format!(
            r#"<p><img src="{data_url}" data-path="/tmp/managed/clip.png" data-mime-type="image/png" data-document-id="18" alt="截图" /></p>"#,
        );

        let saved = database
            .project_record_upsert(ProjectRecordUpsertInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                note_id: None,
                title: Some("带图片元数据记录".to_string()),
                markdown: "[图片] 截图".to_string(),
                html: html.clone(),
                tag_ids: vec![],
                default_code_language: None,
            })
            .unwrap();

        assert_eq!(saved.content_html, html);
    }

    #[test]
    fn reopening_pre_note_type_removal_workspace_runs_note_migrations() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");

        database
            .conn
            .execute(
                "UPDATE activities SET brief_markdown = ?1, brief_html = ?2 WHERE id = ?3",
                params!["需要沉淀的简报", "<p>需要沉淀的简报</p>", activity.id],
            )
            .unwrap();
        database
            .conn
            .execute_batch(
                r#"
                PRAGMA foreign_keys = OFF;
                CREATE TABLE notes_legacy (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  project_id INTEGER NOT NULL,
                  activity_id INTEGER,
                  note_type TEXT NOT NULL,
                  title TEXT,
                  content_markdown TEXT NOT NULL DEFAULT '',
                  content_html TEXT NOT NULL DEFAULT '',
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
                  FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE SET NULL
                );
                INSERT INTO notes_legacy (
                  id, project_id, activity_id, note_type, title, content_markdown, content_html, created_at, updated_at
                )
                SELECT id, project_id, activity_id, 'note', title, content_markdown, content_html, created_at, updated_at
                FROM notes;
                DROP TABLE notes;
                ALTER TABLE notes_legacy RENAME TO notes;
                PRAGMA foreign_keys = ON;
                "#,
            )
            .unwrap();
        database
            .set_schema_version(PROJECT_KIND_SCHEMA_VERSION)
            .unwrap();

        drop(database);
        let mut reopened = Database::open(
            &harness.root.join("app.sqlite3"),
            &harness.workspace_root,
            Some("test-secret".to_string()),
        )
        .unwrap();

        assert!(!reopened.has_column("notes", "note_type").unwrap());
        let project_page = reopened
            .project_page_get(ProjectIdInput {
                project_id: project.id,
            })
            .unwrap();
        assert!(project_page
            .records
            .iter()
            .any(|record| record.content_markdown.contains("需要沉淀的简报")));
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

fn validate_contact_name(value: &str) -> Result<String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(anyhow!("contact name cannot be empty"));
    }
    if normalized.chars().count() > 64 {
        return Err(anyhow!("contact name must be 64 characters or fewer"));
    }
    Ok(normalized.to_string())
}

fn normalize_contact_field(value: Option<&str>, field: &str, max_len: usize) -> Result<String> {
    let normalized = value.unwrap_or_default().trim();
    if normalized.chars().count() > max_len {
        return Err(anyhow!("{field} must be {max_len} characters or fewer"));
    }
    Ok(normalized.to_string())
}

fn normalize_contact_pinyin(value: Option<&str>, fallback: &str, field: &str) -> Result<String> {
    let normalized = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback);
    if normalized.chars().count() > 128 {
        return Err(anyhow!("{field} must be 128 characters or fewer"));
    }
    Ok(normalized.to_lowercase())
}

fn derive_contact_search_text(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_lowercase()
}

fn derive_contact_search_abbr(value: &str) -> String {
    value
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter_map(|part| part.chars().next())
        .collect::<String>()
        .to_lowercase()
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

fn default_ai_editor_skills() -> Vec<AiEditorSkillRecord> {
    let now = now_iso();
    vec![
        AiEditorSkillRecord {
            id: "improve-writing".to_string(),
            name: "改进写作".to_string(),
            icon: Some("📝".to_string()),
            description: Some("优化表达，使文字更清晰、自然、专业。".to_string()),
            prompt: "请优化这段文字的表达，使其更清晰、自然、专业。".to_string(),
            result_mode: "modify".to_string(),
            show_in_text_menu: true,
            sort_order: 1,
            enabled: true,
            created_at: now.clone(),
            updated_at: now.clone(),
        },
        AiEditorSkillRecord {
            id: "proofread".to_string(),
            name: "校对".to_string(),
            icon: Some("✅".to_string()),
            description: Some("检查错别字、语法、标点和表达问题。".to_string()),
            prompt: "请检查这段文字中的错别字、语法、标点和表达问题，并直接返回修正后的版本。"
                .to_string(),
            result_mode: "modify".to_string(),
            show_in_text_menu: true,
            sort_order: 2,
            enabled: true,
            created_at: now.clone(),
            updated_at: now.clone(),
        },
        AiEditorSkillRecord {
            id: "explain".to_string(),
            name: "解释".to_string(),
            icon: Some("💬".to_string()),
            description: Some("解释选中文字的含义。".to_string()),
            prompt: "请解释这段文字的含义，并用更容易理解的方式说明。".to_string(),
            result_mode: "answer".to_string(),
            show_in_text_menu: true,
            sort_order: 3,
            enabled: true,
            created_at: now.clone(),
            updated_at: now.clone(),
        },
        AiEditorSkillRecord {
            id: "reformat".to_string(),
            name: "重排格式".to_string(),
            icon: Some("✨".to_string()),
            description: Some("整理文字格式，使结构更清晰。".to_string()),
            prompt: "请重新整理这段文字的格式，使结构更清晰，但不要改变原意。".to_string(),
            result_mode: "modify".to_string(),
            show_in_text_menu: true,
            sort_order: 4,
            enabled: true,
            created_at: now.clone(),
            updated_at: now,
        },
    ]
}

fn next_ai_editor_skill_id(skills: &[AiEditorSkillRecord]) -> String {
    let mut index = skills.len() + 1;
    loop {
        let id = format!("custom-skill-{index}");
        if !skills.iter().any(|skill| skill.id == id) {
            return id;
        }
        index += 1;
    }
}

fn normalize_ai_editor_skill_sort_orders(skills: &mut [AiEditorSkillRecord]) {
    skills.sort_by(|left, right| {
        left.sort_order
            .cmp(&right.sort_order)
            .then_with(|| left.created_at.cmp(&right.created_at))
            .then_with(|| left.id.cmp(&right.id))
    });

    for (index, skill) in skills.iter_mut().enumerate() {
        skill.sort_order = index as i64 + 1;
    }
}

fn normalize_ai_editor_skill_result_mode(value: &str) -> Result<String> {
    match value.trim() {
        "modify" => Ok("modify".to_string()),
        "answer" => Ok("answer".to_string()),
        _ => Err(anyhow!(
            "AI editor skill result mode must be modify or answer"
        )),
    }
}

fn normalize_ai_editor_rewrite_result_mode(value: &str) -> Result<String> {
    match value.trim() {
        "auto" => Ok("auto".to_string()),
        _ => normalize_ai_editor_skill_result_mode(value),
    }
}

fn validate_ai_editor_skill(skill: &AiEditorSkillRecord) -> Result<()> {
    if skill.id.trim().is_empty() {
        return Err(anyhow!("AI editor skill id cannot be empty"));
    }
    validate_ai_editor_skill_fields(
        &skill.name,
        skill.icon.as_deref(),
        skill.description.as_deref(),
        &skill.prompt,
        &skill.result_mode,
    )
}

fn validate_ai_editor_skill_fields(
    name: &str,
    icon: Option<&str>,
    description: Option<&str>,
    prompt: &str,
    result_mode: &str,
) -> Result<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(anyhow!("AI editor skill name cannot be empty"));
    }
    if name.chars().count() > 32 {
        return Err(anyhow!(
            "AI editor skill name must be 32 characters or fewer"
        ));
    }
    if icon
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some_and(|value| value.chars().count() > 8)
    {
        return Err(anyhow!(
            "AI editor skill icon must be 8 characters or fewer"
        ));
    }
    if description
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some_and(|value| value.chars().count() > 200)
    {
        return Err(anyhow!(
            "AI editor skill description must be 200 characters or fewer"
        ));
    }

    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(anyhow!("AI editor skill prompt cannot be empty"));
    }
    if prompt.chars().count() > 4_000 {
        return Err(anyhow!(
            "AI editor skill prompt must be 4000 characters or fewer"
        ));
    }
    normalize_ai_editor_skill_result_mode(result_mode)?;
    Ok(())
}

fn normalize_ai_editor_rewrite_markdown(value: &str) -> String {
    let trimmed = value.trim();

    if let Some(stripped) = trimmed.strip_prefix("```") {
        let without_language = stripped.lines().skip(1).collect::<Vec<_>>().join("\n");
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
