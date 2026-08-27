use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction, MAIN_DB};
use serde_json::{json, Value};

use crate::{
    ai_provider::{self, ResolvedAiProfile},
    models::{
        AiCapabilityBindingRecord, AiCapabilityBindingUpsertInput, AiEditorSkillActionRecord,
        AiEditorSkillDeleteInput, AiEditorSkillInput, AiEditorSkillRecord,
        AiEditorSkillReorderInput, AiEditorSkillResult, AiEditorSkillUpsertInput,
        AiExecutionSettings, AiJobEnqueueInput, AiJobResult, AiProfileTestInput,
        AiProfileTestResult, AiProviderProfileDeleteInput, AiProviderProfileRecord,
        AiProviderProfileUpsertInput, AiSettingsSnapshot, ContactDeleteInput, ContactRecord,
        ContactSearchInput, ContactUpsertInput, DocumentAddVersionInput, DocumentDeleteInput,
        DocumentImportClipboardImageInput, DocumentImportClipboardNoteImageInput,
        DocumentImportInput, DocumentImportNoteImageInput, DocumentListVersionsInput,
        DocumentRecord, DocumentRelocateInput, DocumentTagRecord, DocumentUpdateMetaInput,
        DocumentVersionRecord, FileTagOptionDeleteInput, FileTagOptionUpsertInput, FileTagRecord,
        FileTagSettingsGetInput, FileTagSettingsSnapshot, InternalReferenceResolveInput,
        InternalReferenceResolveResult, InternalReferenceSearchInput,
        InternalReferenceSearchResult, NoteRecord, ProjectArchiveInput, ProjectCreateInput,
        ProjectDeleteInput, ProjectIdInput, ProjectListItem, ProjectPageData, ProjectRecord,
        ProjectRecordDeleteInput, ProjectRecordUpsertInput, ProjectUpdateInput, ProjectsListInput,
        RichTextFontSelection, RichTextStyleBlockSettings, RichTextStyleSettings,
        RichTextStyleUpsertInput, TodoAddProgressInput, TodoCreateInput, TodoDeleteInput,
        TodoDeleteProgressInput, TodoProgressRecord, TodoRecord, TodoScope, TodoUpdateContentInput,
        TodoUpdatePriorityInput, TodoUpdateProgressInput, TodoUpdateStatusInput,
        TodoUpdateTagsInput, WorkspaceClipboardNoteImageImportInput, WorkspaceNoteImageAsset,
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
const RICH_TEXT_RELATIVE_ASSET_PATH_SCHEMA_VERSION: i64 = 20;
const LEGACY_DOMAIN_RETIRE_SCHEMA_VERSION: i64 = 21;
const CURRENT_SCHEMA_VERSION: i64 = LEGACY_DOMAIN_RETIRE_SCHEMA_VERSION;
const PROJECT_KIND_NORMAL: &str = "normal";
const AI_CAPABILITIES: [&str; 2] = ["default", "image_default"];
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
const APP_SETTING_KEY_AI_EDITOR_REWRITE_ACTIONS: &str = "ai_editor_rewrite_actions";
const APP_SETTING_KEY_AI_EDITOR_SKILLS: &str = "ai_editor_skills";
const APP_SETTING_KEY_AI_IMAGE_SKILL_MIGRATED: &str = "ai_image_skill_migrated";
const AI_EDITOR_SKILL_LIMIT: usize = 24;
const MANAGED_NOTE_IMAGE_STORAGE_MODE: &str = "managed_note_image";
const PROJECT_NOTE_ASSET_DIR_NAME: &str = "embedded-note-assets";
const RICH_TEXT_PATH_ATTRIBUTES: [&str; 4] = ["data-path", "data-href", "href", "src"];
const DEFAULT_RECORD_TYPE_COLOR_KEY: &str = "slate";
const TAG_LABEL_MAX_CHARS: usize = 32;

#[derive(Clone, Copy)]
enum AiDefaultRole {
    General,
    Image,
}

impl AiDefaultRole {
    fn capability(self) -> &'static str {
        match self {
            Self::General => "default",
            Self::Image => "image_default",
        }
    }

    fn requires_image(self) -> bool {
        matches!(self, Self::Image)
    }
}
const SYSTEM_ACTIVITY_STATUS_PENDING: &str = "pending";
const INTERNAL_REFERENCE_PRIORITY_NOTE_TITLE: u8 = 0;
const INTERNAL_REFERENCE_PRIORITY_TODO_CONTENT: u8 = 2;
const INTERNAL_REFERENCE_PRIORITY_DOCUMENT_NAME: u8 = 3;
const INTERNAL_REFERENCE_PRIORITY_NOTE_CONTENT: u8 = 4;
const INTERNAL_REFERENCE_COMPACT_LABEL_MAX_CHARS: usize = 15;
const WORKSPACE_SEARCH_PRIORITY_PROJECT_NAME: u8 = 0;
const WORKSPACE_SEARCH_PRIORITY_CONTACT_NAME: u8 = 1;
const WORKSPACE_SEARCH_PRIORITY_WORKSPACE_NOTE_TITLE: u8 = 2;
const WORKSPACE_SEARCH_PRIORITY_NOTE_TITLE: u8 = 2;
const WORKSPACE_SEARCH_PRIORITY_TODO_CONTENT: u8 = 4;
const WORKSPACE_SEARCH_PRIORITY_DOCUMENT_NAME: u8 = 5;
const WORKSPACE_SEARCH_PRIORITY_NOTE_CONTENT: u8 = 6;
const WORKSPACE_SEARCH_PRIORITY_TODO_PROGRESS: u8 = 6;
const WORKSPACE_SEARCH_PRIORITY_PROJECT_SUMMARY: u8 = 8;
const WORKSPACE_SEARCH_PRIORITY_CONTACT_META: u8 = 8;
const WORKSPACE_SEARCH_PRIORITY_DOCUMENT_VERSION: u8 = 8;
const WORKSPACE_SEARCH_PRIORITY_TAG: u8 = 9;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InternalReferenceFilterKind {
    Note,
    Todo,
    Document,
}

impl InternalReferenceFilterKind {
    fn matches_result_kind(self, kind: &str) -> bool {
        matches!(
            (self, kind),
            (Self::Note, "note") | (Self::Todo, "todo") | (Self::Document, "document")
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
const LEGACY_ACTIVITY_STATUS_REVIEW_LABEL: &str = "待复核";
const LEGACY_ACTIVITY_STATUS_ORGANIZED_LABEL: &str = "已整理";
const DEFAULT_ACTIVITY_ATTRIBUTE_COLOR_KEY: &str = "slate";
const DEFAULT_ACTIVITY_STATUS_COLOR_KEY: &str = "amber";
const LEGACY_ACTIVITY_STATUS_REVIEW_COLOR_KEY: &str = "orange";
const LEGACY_ACTIVITY_STATUS_ORGANIZED_COLOR_KEY: &str = "green";
const WORKSPACE_NOTE_KIND_STANDARD: &str = "workspace_note";
const WORKSPACE_NOTE_KIND_TODAY_QUICK: &str = "today_quick_note";
const WORKSPACE_PATH_PREFIX: &str = "workspace:";
const ABSOLUTE_PATH_PREFIX: &str = "absolute:";

pub struct Database {
    conn: Connection,
    workspace_root: PathBuf,
    secret_password: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DemoSeedResult {
    pub workspace_root: String,
    pub project_count: i64,
    pub project_record_count: i64,
    pub workspace_record_count: i64,
    pub todo_count: i64,
    pub file_count: i64,
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

struct RichTextAssetScope {
    root_path: PathBuf,
    document_paths: HashMap<i64, PathBuf>,
}

impl Database {
    pub fn open(
        db_path: &Path,
        workspace_root: &Path,
        secret_password: Option<String>,
    ) -> Result<Self> {
        let database_already_exists = db_path.exists();
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!("failed to create app data dir at {}", parent.display())
            })?;
        }

        let conn = Connection::open(db_path)
            .with_context(|| format!("failed to open sqlite at {}", db_path.display()))?;
        if database_already_exists {
            backup_before_migration(&conn, workspace_root)?;
        }
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
        let initial_schema_version = self.schema_version()?;
        let is_fresh_workspace = initial_schema_version == 0 && !self.table_exists("projects")?;
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

            CREATE TABLE IF NOT EXISTS notes (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_id INTEGER NOT NULL,
              title TEXT,
              content_markdown TEXT NOT NULL DEFAULT '',
              content_html TEXT NOT NULL DEFAULT '',
              default_code_language TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
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

            CREATE TABLE IF NOT EXISTS todos (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              scope TEXT NOT NULL DEFAULT 'project',
              project_id INTEGER,
              content TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'unfinished',
              priority TEXT NOT NULL,
              due_date TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              CHECK (
                (scope = 'workspace' AND project_id IS NULL)
                OR
                (scope = 'project' AND project_id IS NOT NULL)
              ),
              FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
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
              FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
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

        if is_fresh_workspace {
            self.set_schema_version(CURRENT_SCHEMA_VERSION)?;
        } else if initial_schema_version < CURRENT_SCHEMA_VERSION {
            self.ensure_legacy_domain_schema()?;
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
            if self.schema_version()? < RICH_TEXT_RELATIVE_ASSET_PATH_SCHEMA_VERSION {
                self.migrate_rich_text_asset_paths_to_relative()?;
                self.set_schema_version(RICH_TEXT_RELATIVE_ASSET_PATH_SCHEMA_VERSION)?;
            }
            if self.schema_version()? < LEGACY_DOMAIN_RETIRE_SCHEMA_VERSION {
                self.migrate_legacy_domain_records(true)?;
                self.set_schema_version(LEGACY_DOMAIN_RETIRE_SCHEMA_VERSION)?;
            }
        }
        self.prune_out_of_scope_project_tag_links()?;
        self.conn.execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS idx_projects_archived_updated ON projects(is_archived, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project_id, status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_todo_progresses_todo_date ON todo_progresses(todo_id, progress_date DESC, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id, updated_at DESC);
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

    fn project_root_path(&self, project_id: i64) -> Result<PathBuf> {
        let root_path_ref = self.conn.query_row(
            "SELECT root_path FROM projects WHERE id = ?1",
            [project_id],
            |row| row.get::<_, String>(0),
        )?;
        Ok(self.decode_path_ref(&root_path_ref))
    }

    fn project_rich_text_document_paths(&self, project_id: i64) -> Result<HashMap<i64, PathBuf>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, managed_path FROM documents WHERE project_id = ?1")?;
        let rows = stmt.query_map([project_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut paths = HashMap::new();
        for row in rows {
            let (document_id, managed_path_ref) = row?;
            paths.insert(document_id, self.decode_path_ref(&managed_path_ref));
        }
        Ok(paths)
    }

    fn persist_project_rich_text_html(&self, project_id: i64, html: &str) -> Result<String> {
        let project_root = self.project_root_path(project_id)?;
        let document_paths = self.project_rich_text_document_paths(project_id)?;
        Ok(persist_rich_text_asset_paths(
            html,
            &project_root,
            &document_paths,
        ))
    }

    fn persist_project_rich_text_html_at_root(
        &self,
        project_id: i64,
        project_root: &Path,
        html: &str,
    ) -> Result<String> {
        let document_paths = self.project_rich_text_document_paths(project_id)?;
        Ok(persist_rich_text_asset_paths(
            html,
            project_root,
            &document_paths,
        ))
    }

    fn hydrate_project_rich_text_html(&self, project_id: i64, html: &str) -> Result<String> {
        Ok(hydrate_rich_text_asset_paths(
            html,
            &self.project_root_path(project_id)?,
        ))
    }

    pub fn seed_demo_data(&mut self, workspace_root: &Path) -> Result<DemoSeedResult> {
        fs::create_dir_all(workspace_root).with_context(|| {
            format!(
                "failed to create demo workspace root at {}",
                workspace_root.display()
            )
        })?;
        let source_root = workspace_root
            .join(WORKSPACE_HIDDEN_DIR_NAME)
            .join("demo-sources");
        fs::create_dir_all(&source_root)?;

        let fixtures = [
            (
                "智能客服知识库升级",
                "退款、物流和账户问题已经统一到同一工作现场，下一步验证检索口径。",
                "法务边界与知识库口径",
                "已确认敏感字段必须在进入模型前脱敏，FAQ 由业务负责人维护。",
                "确认退款场景的最终验收样例",
                "customer-service-guidelines.md",
            ),
            (
                "海外销售线索评分 Copilot",
                "目标是缩短 SDR 首次筛选时间，当前聚焦 CRM 字段稳定性。",
                "评分字段评审记录",
                "公司规模、地区和最近互动是首版评分的核心输入，解释文本必须可追溯。",
                "补齐 CRM 沙箱字段映射",
                "lead-scoring-fields.csv",
            ),
            (
                "合同审阅 AI 助手试点",
                "试点聚焦红线条款识别、审阅意见归类和标准修改建议。",
                "试点范围与复核流程",
                "所有建议都由法务确认后写回 Record，AI 结果不能自动覆盖已提交正文。",
                "安排下一轮法务复核",
                "contract-review-checklist.md",
            ),
        ];

        for (index, (name, quick_note, record_title, record_body, todo, file_name)) in
            fixtures.into_iter().enumerate()
        {
            let project = self.project_create(ProjectCreateInput {
                name: name.to_string(),
                summary: Some(quick_note.to_string()),
                status: Some("active".to_string()),
            })?;
            self.project_record_upsert(ProjectRecordUpsertInput {
                project_id: project.id,
                note_id: None,
                title: Some(record_title.to_string()),
                markdown: record_body.to_string(),
                html: rich_text_html_from_markdown(record_body),
                default_code_language: None,
                tag_ids: Vec::new(),
            })?;
            self.todo_create(TodoCreateInput {
                scope: TodoScope::Project,
                project_id: Some(project.id),
                content: todo.to_string(),
                priority: if index == 0 {
                    "urgent_important".to_string()
                } else {
                    "not_urgent_important".to_string()
                },
                due_date: None,
                tag_ids: Vec::new(),
            })?;
            let source_path = source_root.join(file_name);
            fs::write(&source_path, format!("{record_title}\n\n{record_body}\n"))?;
            self.document_import(DocumentImportInput {
                project_id: project.id,
                source_path: source_path.to_string_lossy().to_string(),
                is_starred: index == 0,
                tag_ids: None,
            })?;
        }

        self.workspace_record_upsert(WorkspaceRecordUpsertInput {
            note_id: None,
            title: Some("跨项目复盘框架".to_string()),
            markdown: "每周汇总风险、依据和下一步，并把需要持续保留的信息沉淀为 Record。"
                .to_string(),
            html: rich_text_html_from_markdown(
                "每周汇总风险、依据和下一步，并把需要持续保留的信息沉淀为 Record。",
            ),
            default_code_language: None,
            tag_ids: Vec::new(),
        })?;
        self.workspace_quick_note_upsert(WorkspaceQuickNoteUpsertInput {
            markdown: "检查三个 Project 的本周 Todo。".to_string(),
            html: rich_text_html_from_markdown("检查三个 Project 的本周 Todo。"),
            default_code_language: None,
            tag_ids: Vec::new(),
        })?;

        let count = |table: &str| -> Result<i64> {
            self.conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .map_err(Into::into)
        };
        Ok(DemoSeedResult {
            workspace_root: workspace_root.to_string_lossy().to_string(),
            project_count: count("projects")?,
            project_record_count: count("notes")?,
            workspace_record_count: self.conn.query_row(
                "SELECT COUNT(*) FROM workspace_notes WHERE note_kind = ?1",
                [WORKSPACE_NOTE_KIND_STANDARD],
                |row| row.get(0),
            )?,
            todo_count: count("todos")?,
            file_count: self.conn.query_row(
                "SELECT COUNT(*) FROM documents WHERE storage_mode != ?1",
                [MANAGED_NOTE_IMAGE_STORAGE_MODE],
                |row| row.get(0),
            )?,
        })
    }

    fn persist_workspace_rich_text_html(&self, html: &str) -> String {
        persist_rich_text_asset_paths(html, &self.workspace_root, &HashMap::new())
    }

    fn hydrate_workspace_rich_text_html(&self, html: &str) -> String {
        hydrate_rich_text_asset_paths(html, &self.workspace_root)
    }

    fn collect_project_scoped_rich_text_updates(
        &self,
        select_sql: &str,
        project_scopes: &HashMap<i64, RichTextAssetScope>,
    ) -> Result<Vec<(i64, String)>> {
        let mut stmt = self.conn.prepare(select_sql)?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let mut updates = Vec::new();

        for row in rows {
            let (id, project_id, content_html) = row?;
            let Some(scope) = project_scopes.get(&project_id) else {
                continue;
            };
            let next_html = persist_rich_text_asset_paths(
                &content_html,
                &scope.root_path,
                &scope.document_paths,
            );
            if next_html != content_html {
                updates.push((id, next_html));
            }
        }

        Ok(updates)
    }

    fn migrate_rich_text_asset_paths_to_relative(&mut self) -> Result<()> {
        let project_rows = {
            let mut stmt = self
                .conn
                .prepare("SELECT id, root_path, summary_html FROM projects")?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let mut project_scopes = HashMap::new();
        let mut project_updates = Vec::new();
        for (project_id, root_path_ref, summary_html) in project_rows {
            let project_root = self.decode_path_ref(&root_path_ref);
            let document_paths = self.project_rich_text_document_paths(project_id)?;
            let next_html =
                persist_rich_text_asset_paths(&summary_html, &project_root, &document_paths);
            if next_html != summary_html {
                project_updates.push((project_id, next_html));
            }
            project_scopes.insert(
                project_id,
                RichTextAssetScope {
                    root_path: project_root,
                    document_paths,
                },
            );
        }

        let note_updates = self.collect_project_scoped_rich_text_updates(
            "SELECT id, project_id, content_html FROM notes",
            &project_scopes,
        )?;
        let conclusion_updates = self.collect_project_scoped_rich_text_updates(
            "SELECT id, project_id, content_html FROM conclusions",
            &project_scopes,
        )?;
        let activity_updates = self.collect_project_scoped_rich_text_updates(
            "SELECT id, project_id, brief_html FROM activities",
            &project_scopes,
        )?;

        let workspace_rows = {
            let mut stmt = self
                .conn
                .prepare("SELECT id, content_html FROM workspace_notes")?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let workspace_updates = workspace_rows
            .into_iter()
            .filter_map(|(note_id, content_html)| {
                let recovered_html =
                    recover_moved_workspace_asset_paths(&content_html, &self.workspace_root);
                let next_html = self.persist_workspace_rich_text_html(&recovered_html);
                (next_html != content_html).then_some((note_id, next_html))
            })
            .collect::<Vec<_>>();

        let tx = self.conn.transaction()?;
        apply_rich_text_html_updates(
            &tx,
            "UPDATE projects SET summary_html = ?1 WHERE id = ?2",
            &project_updates,
        )?;
        apply_rich_text_html_updates(
            &tx,
            "UPDATE notes SET content_html = ?1 WHERE id = ?2",
            &note_updates,
        )?;
        apply_rich_text_html_updates(
            &tx,
            "UPDATE conclusions SET content_html = ?1 WHERE id = ?2",
            &conclusion_updates,
        )?;
        apply_rich_text_html_updates(
            &tx,
            "UPDATE activities SET brief_html = ?1 WHERE id = ?2",
            &activity_updates,
        )?;
        apply_rich_text_html_updates(
            &tx,
            "UPDATE workspace_notes SET content_html = ?1 WHERE id = ?2",
            &workspace_updates,
        )?;
        tx.commit()?;
        Ok(())
    }

    fn require_secret_password(&self) -> Result<&str> {
        self.secret_password
            .as_deref()
            .ok_or_else(|| anyhow!("workspace secrets are locked"))
    }

    fn effective_default_binding(&self, role: AiDefaultRole) -> Result<AiCapabilityBindingRecord> {
        let general = self.ai_binding_record(AiDefaultRole::General.capability())?;
        if matches!(role, AiDefaultRole::General) {
            return Ok(general);
        }
        let binding = self.ai_binding_record(role.capability())?;
        Ok(if binding.use_default {
            general
        } else {
            binding
        })
    }

    fn has_usable_default_role(&self, role: AiDefaultRole) -> Result<bool> {
        let effective_binding = self.effective_default_binding(role)?;

        let Some(profile_id) = effective_binding.profile_id else {
            return Ok(false);
        };
        let profile = self.ai_profile_storage(profile_id)?;
        if !profile.enabled
            || !profile.supports_text
            || (role.requires_image() && !profile.supports_image)
        {
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
            let root_path = self.decode_path_ref(&root_path_ref);
            let summary_html = row.get::<_, String>(7)?;
            Ok(ProjectListItem {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                status: row.get(3)?,
                root_path: root_path.to_string_lossy().to_string(),
                summary: row.get(5)?,
                summary_markdown: row.get(6)?,
                summary_html: hydrate_rich_text_asset_paths(&summary_html, &root_path),
                summary_code_language: row.get(8)?,
                is_archived: int_to_bool(row.get::<_, i64>(9)?),
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
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
        let project_documents = self.fetch_project_documents_for_project(input.project_id)?;
        let records = self.fetch_project_notes(input.project_id)?;
        let record_groups = Vec::new(); // deprecated, kept for compatibility
        let unfinished_todos = self.fetch_project_todos(input.project_id, false)?;
        let finished_todos = self.fetch_project_todos(input.project_id, true)?;

        Ok(ProjectPageData {
            project,
            project_documents,
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
        let next_summary_html = self.persist_project_rich_text_html_at_root(
            current.id,
            Path::new(&current.root_path),
            &next_summary_html,
        )?;
        let next_summary_code_language = input
            .summary_code_language
            .as_deref()
            .map(normalize_code_language)
            .unwrap_or_else(|| current.summary_code_language.clone());
        if project_name != current.name {
            self.rename_project_root(&current, &project_name)?;
        }
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
        self.project_record(input.project_id)
    }

    pub fn project_set_archive(&mut self, input: ProjectArchiveInput) -> Result<ProjectRecord> {
        self.conn.execute(
            "UPDATE projects SET is_archived = ?1, updated_at = ?2 WHERE id = ?3",
            params![bool_to_int(input.is_archived), now_iso(), input.project_id],
        )?;
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

        Ok(current)
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
                    now.clone(),
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
        let stored_html = self.persist_project_rich_text_html(input.project_id, &input.html)?;
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
                        stored_html,
                        default_code_language,
                        timestamp,
                        note_id
                    ],
                )?;
                self.replace_note_tags(note_id, &input.tag_ids, &timestamp)?;
                self.touch_project(current.project_id)?;
                self.note_record(note_id)
            }
            None => {
                self.insert_project_note(
                    input.project_id,
                    input.title.as_deref(),
                    input.markdown.as_str(),
                    stored_html.as_str(),
                    default_code_language.as_deref(),
                    &timestamp,
                )?;
                let note_id = self.conn.last_insert_rowid();
                self.replace_note_tags(note_id, &input.tag_ids, &timestamp)?;
                self.touch_project(input.project_id)?;
                self.note_record(note_id)
            }
        }
    }

    pub fn project_record_delete(&mut self, input: ProjectRecordDeleteInput) -> Result<NoteRecord> {
        let current = self.note_record(input.note_id)?;
        self.conn
            .execute("DELETE FROM notes WHERE id = ?1", [input.note_id])?;
        self.touch_project(current.project_id)?;
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
        let stored_html = self.persist_workspace_rich_text_html(&input.html);
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
                        stored_html,
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
                        stored_html,
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
        let stored_html = self.persist_workspace_rich_text_html(&input.html);
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
                        stored_html,
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
                        stored_html,
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
              scope, project_id, content, status, priority, due_date, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, 'unfinished', ?4, ?5, ?6, ?7)
            "#,
            params![
                scope_value,
                input.project_id,
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
        let target_dir = self.document_target_dir(input.project_id)?;

        let file_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| anyhow!("invalid file name"))?
            .to_string();
        self.ensure_document_name_available(input.project_id, &file_name, None)?;
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
              project_id, name, base_name, original_path, managed_path, history_dir_path, storage_mode, mime_type, is_starred, current_version_number, version_count, health, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, ?7, ?8, 1, 1, 'normal', ?9, ?10)
            "#,
            params![
                input.project_id,
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
        let target_dir = self.note_image_target_dir(input.project_id)?;
        let resolved_name =
            self.resolve_internal_document_name(input.project_id, &sanitized_name, &target_dir)?;
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
              project_id, name, base_name, original_path, managed_path, history_dir_path, storage_mode, mime_type, is_starred, current_version_number, version_count, health, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, ?7, 0, 1, 1, 'normal', ?8, ?9)
            "#,
            params![
                input.project_id,
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
        self.document_record(id)
    }

    pub fn document_import_clipboard_image(
        &mut self,
        input: DocumentImportClipboardImageInput,
    ) -> Result<DocumentRecord> {
        self.ensure_project_file_layout(input.project_id)?;
        let timestamp = now_iso();
        let target_dir = self.document_target_dir(input.project_id)?;
        let file_name = sanitize_import_file_name(&input.file_name, &input.mime_type)?;

        self.ensure_document_name_available(input.project_id, &file_name, None)?;

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
              project_id, name, base_name, original_path, managed_path, history_dir_path, storage_mode, mime_type, is_starred, current_version_number, version_count, health, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, ?7, ?8, 1, 1, 'normal', ?9, ?10)
            "#,
            params![
                input.project_id,
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
        self.document_record(id)
    }

    pub fn document_import_clipboard_note_image(
        &mut self,
        input: DocumentImportClipboardNoteImageInput,
    ) -> Result<DocumentRecord> {
        self.ensure_project_file_layout(input.project_id)?;
        let timestamp = now_iso();
        let target_dir = self.note_image_target_dir(input.project_id)?;
        let file_name = sanitize_import_file_name(&input.file_name, &input.mime_type)?;
        let resolved_name =
            self.resolve_internal_document_name(input.project_id, &file_name, &target_dir)?;
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
              project_id, name, base_name, original_path, managed_path, history_dir_path, storage_mode, mime_type, is_starred, current_version_number, version_count, health, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, ?7, 0, 1, 1, 'normal', ?8, ?9)
            "#,
            params![
                input.project_id,
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
        let next_base_name = match input.base_name.as_deref() {
            Some(base_name) => self.normalize_document_base_name(base_name, &current.base_name)?,
            None => current.base_name.clone(),
        };

        if next_base_name != current.base_name {
            self.move_document_storage(&current, &next_base_name)?;
        }

        self.conn.execute(
            "UPDATE documents SET base_name = ?1, is_starred = ?2, updated_at = ?3 WHERE id = ?4",
            params![
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
        self.touch_project(current.project_id)?;
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
        let target_dir = self.document_target_dir(current.project_id)?;
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
        Ok(current)
    }

    pub fn ai_settings_get(&mut self) -> Result<AiSettingsSnapshot> {
        let profiles = self.fetch_ai_profiles().unwrap_or_else(|_| {
            let _ = self.clear_ai_profiles_and_bindings();
            Vec::new()
        });
        // Skill migration can introduce or repair capability bindings, so it must
        // complete before the snapshot reads those bindings.
        let editor_skills = self.ai_editor_skills_get().unwrap_or_else(|_| {
            let _ = self.clear_app_setting(APP_SETTING_KEY_AI_EDITOR_SKILLS);
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
        let has_usable_default = self
            .has_usable_default_role(AiDefaultRole::General)
            .unwrap_or(false);
        let has_usable_image_default = self
            .has_usable_default_role(AiDefaultRole::Image)
            .unwrap_or(false);

        Ok(AiSettingsSnapshot {
            has_usable_default,
            has_usable_image_default,
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

        let mut skills = if let Some(value_json) = stored.as_deref() {
            serde_json::from_str::<Vec<AiEditorSkillRecord>>(value_json)
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
                        show_in_image_menu: false,
                        profile_id: None,
                        sort_order: index as i64 + 1,
                        enabled: action.enabled,
                        created_at: action.created_at,
                        updated_at: action.updated_at,
                    })
                    .collect()
            };
            next_skills
        };

        let image_skill_migrated = self
            .conn
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = ?1",
                params![APP_SETTING_KEY_AI_IMAGE_SKILL_MIGRATED],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .is_some();
        if !image_skill_migrated {
            self.migrate_image_default_binding()?;
            if !skills.iter().any(|skill| skill.id == "extract-image-text") {
                skills.push(default_image_text_extraction_skill(skills.len() as i64 + 1));
            }
            self.persist_ai_editor_skills(&skills)?;
            self.conn.execute(
                "INSERT OR REPLACE INTO app_settings (key, value_json, updated_at) VALUES (?1, 'true', ?2)",
                params![APP_SETTING_KEY_AI_IMAGE_SKILL_MIGRATED, now_iso()],
            )?;
        } else if stored.is_none() {
            self.persist_ai_editor_skills(&skills)?;
        }

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

    fn migrate_image_default_binding(&self) -> Result<()> {
        let existing = self.ai_binding_record("image_default")?;
        if existing.profile_id.is_some() {
            return Ok(());
        }

        let general = self.ai_binding_record("default")?;
        let legacy = self.ai_binding_record("editor_rewrite")?;
        let candidates = [legacy, general];
        let selected = candidates.into_iter().find(|binding| {
            let Some(profile_id) = binding.profile_id else {
                return false;
            };
            self.ai_profile_storage(profile_id)
                .map(|profile| profile.enabled && profile.supports_text && profile.supports_image)
                .unwrap_or(false)
        });
        let Some(selected) = selected else {
            return Ok(());
        };
        self.conn.execute(
            r#"
            INSERT OR IGNORE INTO ai_capability_bindings
              (capability, use_default, profile_id, model, updated_at)
            VALUES ('image_default', 0, ?1, ?2, ?3)
            "#,
            params![selected.profile_id, selected.model, now_iso()],
        )?;
        Ok(())
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
                skill.show_in_image_menu = input.show_in_image_menu;
                skill.profile_id = input.profile_id;
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
                    show_in_image_menu: input.show_in_image_menu,
                    profile_id: input.profile_id,
                    sort_order,
                    enabled: input.enabled,
                    created_at: now.clone(),
                    updated_at: now,
                };
                skills.push(skill.clone());
                skill
            };

        self.validate_image_skill_configuration(&saved)?;
        normalize_ai_editor_skill_sort_orders(&mut skills);
        self.persist_ai_editor_skills(&skills)?;
        Ok(saved)
    }

    fn validate_image_skill_configuration(&self, skill: &AiEditorSkillRecord) -> Result<()> {
        if !skill.enabled || !skill.show_in_image_menu {
            return Ok(());
        }

        let profile = if let Some(profile_id) = skill.profile_id {
            self.ai_profile_storage(profile_id)?
        } else {
            let binding = self.ai_binding_record("image_default")?;
            let profile_id = binding.profile_id.ok_or_else(|| {
                anyhow!("an image default model is required before enabling an image Skill")
            })?;
            self.ai_profile_storage(profile_id)?
        };

        if !profile.enabled || !profile.supports_text || !profile.supports_image {
            return Err(anyhow!(
                "an image Skill requires an enabled profile with text and image capabilities"
            ));
        }
        Ok(())
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

    pub fn ai_editor_rewrite_actions_get(&mut self) -> Result<Vec<AiEditorSkillActionRecord>> {
        let stored = self
            .conn
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = ?1",
                params![APP_SETTING_KEY_AI_EDITOR_REWRITE_ACTIONS],
                |row| row.get::<_, String>(0),
            )
            .optional()?;

        let mut actions = if let Some(value_json) = stored {
            serde_json::from_str::<Vec<AiEditorSkillActionRecord>>(&value_json)
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
        title: Option<&str>,
        markdown: &str,
        html: &str,
        default_code_language: Option<&str>,
        timestamp: &str,
    ) -> Result<()> {
        let has_note_type = self.has_column("notes", "note_type")?;
        let has_activity_id = self.has_column("notes", "activity_id")?;
        let sql = match (has_note_type, has_activity_id) {
            (true, true) => {
                "INSERT INTO notes (project_id, activity_id, note_type, title, content_markdown, content_html, default_code_language, created_at, updated_at) VALUES (?1, NULL, 'note', ?2, ?3, ?4, ?5, ?6, ?7)"
            }
            (true, false) => {
                "INSERT INTO notes (project_id, note_type, title, content_markdown, content_html, default_code_language, created_at, updated_at) VALUES (?1, 'note', ?2, ?3, ?4, ?5, ?6, ?7)"
            }
            (false, true) => {
                "INSERT INTO notes (project_id, activity_id, title, content_markdown, content_html, default_code_language, created_at, updated_at) VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7)"
            }
            (false, false) => {
                "INSERT INTO notes (project_id, title, content_markdown, content_html, default_code_language, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
            }
        };
        self.conn.execute(
            sql,
            params![
                project_id,
                title,
                markdown,
                html,
                default_code_language,
                timestamp,
                timestamp
            ],
        )?;
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
            for binding in self
                .fetch_ai_bindings()?
                .iter()
                .filter(|binding| binding.profile_id == Some(profile_id))
            {
                let invalid = !input.enabled
                    || !input.supports_text
                    || (binding.capability == "image_default" && !input.supports_image);
                if invalid {
                    return Err(anyhow!(
                        "profile is still used by '{}' default role; change the default first",
                        binding.capability
                    ));
                }
            }
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
                    now.clone(),
                    profile_id
                ],
            )?;

            if !input.enabled || !input.supports_text || !input.supports_image {
                let mut skills = self.ai_editor_skills_get()?;
                let mut changed = false;
                for skill in &mut skills {
                    if skill.profile_id == Some(profile_id)
                        && (!input.enabled
                            || !input.supports_text
                            || (skill.show_in_image_menu && !input.supports_image))
                    {
                        skill.profile_id = None;
                        skill.updated_at = now.clone();
                        changed = true;
                    }
                }
                if changed {
                    self.persist_ai_editor_skills(&skills)?;
                }
            }

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

        let mut skills = self.ai_editor_skills_get()?;
        let mut changed = false;
        for skill in &mut skills {
            if skill.profile_id == Some(input.profile_id) {
                skill.profile_id = None;
                skill.updated_at = now_iso();
                changed = true;
            }
        }
        if changed {
            self.persist_ai_editor_skills(&skills)?;
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
            profile_name: input.name.trim().to_string(),
            provider_family: input.provider_family.trim().to_string(),
            base_url: normalize_base_url(&input.base_url),
            api_key,
            model: input.default_model.trim().to_string(),
            supports_text: input.supports_text,
            supports_image: input.supports_image,
        };
        let outcome = ai_provider::test_profile(&profile, input.test_image)?;

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
            let profile = self.ai_profile_storage(profile_id)?;
            if input.capability.trim() == "image_default"
                && (!profile.enabled || !profile.supports_text || !profile.supports_image)
            {
                return Err(anyhow!(
                    "the image default profile must be enabled and support text and images"
                ));
            }
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

    pub fn ai_editor_skill_execute(
        &mut self,
        input: AiEditorSkillInput,
        mut on_stream: impl FnMut(String),
    ) -> Result<AiEditorSkillResult> {
        let result_mode = normalize_ai_editor_skill_result_mode(&input.result_mode)?;
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
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .ok_or_else(|| anyhow!("AI editor skill prompt cannot be empty"))?;

        let is_image =
            input.target_type.as_deref() == Some("image") || input.image_target.is_some();
        let selected_markdown = if is_image {
            "[single image target]"
        } else {
            input
                .expanded_markdown
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| input.selected_text.trim())
        };
        if selected_markdown.is_empty() {
            return Err(anyhow!("selected text cannot be empty"));
        }

        let (profile, used_default_fallback) =
            self.resolve_editor_skill_profile(skill_id.as_deref(), is_image)?;
        let provider_image = if is_image {
            let target = input
                .image_target
                .as_ref()
                .ok_or_else(|| anyhow!("image target is required"))?;
            Some(ai_provider::prepare_provider_image(
                &target.path,
                &target.mime_type,
                &target.signature,
                target.annotation_state.as_deref(),
                &profile.provider_family,
            )?)
        } else {
            None
        };
        let image_target = input.image_target.as_ref();
        let prompt_context = ai_provider::EditorSkillPromptContext {
            document: input.document_context.as_deref(),
            before_markdown: image_target.and_then(|target| target.before_markdown.as_deref()),
            after_markdown: image_target.and_then(|target| target.after_markdown.as_deref()),
            annotation_state: image_target.and_then(|target| target.annotation_state.as_deref()),
        };
        let payload = ai_provider::run_editor_skill(
            &profile,
            &skill_name,
            &skill_prompt,
            &result_mode,
            selected_markdown,
            &input.placeholder_tokens,
            prompt_context,
            provider_image.as_ref(),
            |stream_text| on_stream(stream_text),
        )?;
        let content = normalize_ai_editor_skill_markdown(&payload.content);
        let replacement_markdown = payload
            .replacement_markdown
            .as_deref()
            .map(normalize_ai_editor_skill_markdown)
            .filter(|value| !value.is_empty());
        let answer_markdown = payload
            .answer_markdown
            .as_deref()
            .map(normalize_ai_editor_skill_markdown)
            .filter(|value| !value.is_empty());
        if let Some(replacement) = replacement_markdown.as_deref() {
            validate_rewrite_placeholder_tokens(replacement, &input.placeholder_tokens)?;
        }

        Ok(AiEditorSkillResult {
            skill_id,
            result_mode,
            content,
            replacement_markdown,
            answer_markdown,
            resolved_model: payload.resolved_model,
            resolved_profile_name: Some(profile.profile_name),
            used_default_fallback,
            parse_error: payload.parse_error,
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
            AiJobEnqueueInput::EditorSkill { input, .. } => {
                let rewrite =
                    self.ai_editor_skill_execute(input, |stream_text| on_stream(stream_text))?;
                Ok(AiJobResult::EditorSkill { rewrite })
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
            let title: String = row.get(2)?;
            let title_match_text: String = row.get(3)?;
            let content_match_text: String = row.get(4)?;
            let tag_match_text: String = row.get(5)?;
            let project_name: String = row.get(6)?;
            Ok(WorkspaceSearchCandidate {
                result: WorkspaceSearchResult {
                    kind: "note".to_string(),
                    id: row.get(0)?,
                    scope: None,
                    project_id: Some(row.get(1)?),
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
                updated_at: row.get(7)?,
            })
        })?;
        candidates.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);

        let todo_sql = format!(
            r#"
            SELECT
              t.id,
              t.scope,
              t.project_id,
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
            let content: String = row.get(3)?;
            let progress_text: String = row.get(4)?;
            let tag_match_text: String = row.get(5)?;
            let source: String = row.get(6)?;
            Ok(WorkspaceSearchCandidate {
                result: WorkspaceSearchResult {
                    kind: "todo".to_string(),
                    id: row.get(0)?,
                    scope: Some(scope),
                    project_id: row.get(2)?,
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
                updated_at: row.get(7)?,
            })
        })?;
        candidates.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);

        let document_sql = format!(
            r#"
            SELECT
              d.id,
              d.project_id,
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
            let title: String = row.get(2)?;
            let base_name: String = row.get(3)?;
            let version_name_match_text: String = row.get(4)?;
            let tag_match_text: String = row.get(5)?;
            let project_title: String = row.get(6)?;
            Ok(WorkspaceSearchCandidate {
                result: WorkspaceSearchResult {
                    kind: "document".to_string(),
                    id: row.get(0)?,
                    scope: None,
                    project_id: Some(row.get(1)?),
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
                updated_at: row.get(7)?,
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
                            route: format!("/projects/{project_id}/records/{id}"),
                            focus_id: None,
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
                            route,
                            focus_id: Some(format!("todo-{id}")),
                            managed_path: None,
                        })
                    },
                )
                .optional()
                .map_err(Into::into),
            "document" => {
                let resolved = self
                    .conn
                    .query_row(
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
                        route: build_internal_reference_route(
                            project_id,
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

    fn project_record(&self, project_id: i64) -> Result<ProjectRecord> {
        let mut project = self.conn.query_row(
            r#"
                SELECT id, name, kind, status, root_path, summary, summary_markdown, summary_html,
                  quick_note_code_language, is_archived, created_at, updated_at
                FROM projects WHERE id = ?1
                "#,
            [project_id],
            |row| {
                Ok(ProjectRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    kind: row.get(2)?,
                    status: row.get(3)?,
                    root_path: row.get(4)?,
                    summary: row.get(5)?,
                    summary_markdown: row.get(6)?,
                    summary_html: row.get(7)?,
                    summary_code_language: row.get(8)?,
                    is_archived: int_to_bool(row.get::<_, i64>(9)?),
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                })
            },
        )?;
        let root_path = self.decode_path_ref(&project.root_path);
        project.root_path = root_path.to_string_lossy().to_string();
        project.summary_html = hydrate_rich_text_asset_paths(&project.summary_html, &root_path);
        Ok(project)
    }

    fn note_record(&self, note_id: i64) -> Result<NoteRecord> {
        let tags = self.fetch_note_tags(note_id)?;
        let mut note = self.conn.query_row(
            r#"
                SELECT id, project_id, title, content_markdown, content_html,
                  default_code_language, created_at, updated_at
                FROM notes WHERE id = ?1
                "#,
            [note_id],
            |row| {
                Ok(NoteRecord {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    title: row.get(2)?,
                    content_markdown: row.get(3)?,
                    content_html: row.get(4)?,
                    default_code_language: row.get(5)?,
                    tags: tags.clone(),
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            },
        )?;
        note.content_html =
            self.hydrate_project_rich_text_html(note.project_id, &note.content_html)?;
        Ok(note)
    }

    fn workspace_note_record(&self, note_id: i64) -> Result<WorkspaceRecord> {
        let tags = self.fetch_workspace_note_tags(note_id)?;
        let mut note = self.conn.query_row(
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
        )?;
        note.content_html = self.hydrate_workspace_rich_text_html(&note.content_html);
        Ok(note)
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
              t.id, t.scope, t.project_id, p.name, t.content, t.status, t.priority, t.due_date, t.created_at, t.updated_at
            FROM todos t
            LEFT JOIN projects p ON p.id = t.project_id
            WHERE t.id = ?1
            "#,
            [todo_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
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
            content: base.4,
            status: base.5,
            priority: base.6,
            due_date: base.7,
            tags,
            created_at: base.8,
            updated_at: base.9,
            progresses,
        })
    }

    fn document_record(&self, document_id: i64) -> Result<DocumentRecord> {
        let base = self
            .conn
            .query_row(
                r#"
                SELECT
                  d.id, d.project_id, d.name, d.base_name, d.original_path, d.managed_path,
                  d.history_dir_path, d.storage_mode, d.mime_type, d.is_starred, d.current_version_number,
                  d.version_count, d.health, d.created_at, d.updated_at
                FROM documents d
                WHERE d.id = ?1
                "#,
                [document_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        int_to_bool(row.get::<_, i64>(9)?),
                        row.get::<_, i64>(10)?,
                        row.get::<_, i64>(11)?,
                        row.get::<_, String>(12)?,
                        row.get::<_, String>(13)?,
                        row.get::<_, String>(14)?,
                    ))
                },
            )?;
        let tags = self.fetch_document_tags(document_id)?;
        Ok(DocumentRecord {
            id: base.0,
            project_id: base.1,
            name: base.2,
            base_name: base.3,
            original_path: self.decode_path_ref_to_string(&base.4),
            managed_path: self.decode_path_ref_to_string(&base.5),
            history_dir_path: self.decode_path_ref_to_string(&base.6),
            storage_mode: base.7,
            mime_type: base.8,
            is_starred: base.9,
            current_version_number: base.10,
            version_count: base.11,
            health: base.12,
            tags,
            created_at: base.13,
            updated_at: base.14,
        })
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
            use_default: false,
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

    fn resolve_default_role(&self, role: AiDefaultRole) -> Result<ResolvedAiProfile> {
        let capability = role.capability();
        let effective_binding = self.effective_default_binding(role)?;

        let profile_id = effective_binding
            .profile_id
            .ok_or_else(|| anyhow!("AI capability '{}' is not configured yet", capability))?;
        let profile = self.ai_profile_storage(profile_id)?;
        if !profile.enabled || !profile.supports_text {
            return Err(anyhow!(
                "AI capability '{}' points to a disabled or text-incompatible profile",
                capability
            ));
        }
        if role.requires_image() && !profile.supports_image {
            return Err(anyhow!("AI image default profile does not support images"));
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
            profile_name: profile.name,
            provider_family: profile.provider_family,
            base_url: profile.base_url,
            api_key,
            model: model.to_string(),
            supports_text: profile.supports_text,
            supports_image: profile.supports_image,
        })
    }

    fn resolve_editor_skill_profile(
        &mut self,
        skill_id: Option<&str>,
        is_image: bool,
    ) -> Result<(ResolvedAiProfile, bool)> {
        let override_profile_id = if let Some(skill_id) = skill_id {
            self.ai_editor_skills_get()?
                .into_iter()
                .find(|skill| skill.id == skill_id && skill.enabled)
                .and_then(|skill| skill.profile_id)
        } else {
            None
        };

        if let Some(profile_id) = override_profile_id {
            if let Ok(profile) = self.ai_profile_storage(profile_id) {
                if profile.enabled && profile.supports_text && (!is_image || profile.supports_image)
                {
                    return Ok((self.resolve_profile_by_id(profile_id)?, false));
                }
            }
        }

        let role = if is_image {
            AiDefaultRole::Image
        } else {
            AiDefaultRole::General
        };
        Ok((
            self.resolve_default_role(role)?,
            override_profile_id.is_some(),
        ))
    }

    fn resolve_profile_by_id(&self, profile_id: i64) -> Result<ResolvedAiProfile> {
        let profile = self.ai_profile_storage(profile_id)?;
        if !profile.enabled || !profile.supports_text {
            return Err(anyhow!("AI profile is unavailable"));
        }
        Ok(ResolvedAiProfile {
            profile_name: profile.name,
            provider_family: profile.provider_family,
            base_url: profile.base_url,
            api_key: self.decrypt_api_key_for_profile(profile_id)?,
            model: profile.default_model,
            supports_text: profile.supports_text,
            supports_image: profile.supports_image,
        })
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

    fn document_target_dir(&mut self, project_id: i64) -> Result<PathBuf> {
        let project = self.project_record(project_id)?;
        let project_root = PathBuf::from(&project.root_path);
        fs::create_dir_all(&project_root)?;
        Ok(project_root)
    }

    fn note_image_target_dir(&mut self, project_id: i64) -> Result<PathBuf> {
        let project = self.project_record(project_id)?;
        let project_root = PathBuf::from(&project.root_path);
        fs::create_dir_all(&project_root)?;
        let target_dir = project_root
            .join(WORKSPACE_HIDDEN_DIR_NAME)
            .join(PROJECT_NOTE_ASSET_DIR_NAME)
            .join("project");
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
        base_name: &str,
        exclude_document_id: Option<i64>,
    ) -> Result<bool> {
        self.conn
            .query_row(
                r#"
                SELECT id
                FROM documents
                WHERE project_id = ?1
                  AND base_name = ?2
                  AND id != ?3
                LIMIT 1
                "#,
                params![project_id, base_name, exclude_document_id.unwrap_or(-1)],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map(|row| row.is_some())
            .map_err(Into::into)
    }

    fn ensure_document_name_available(
        &self,
        project_id: i64,
        base_name: &str,
        exclude_document_id: Option<i64>,
    ) -> Result<()> {
        if self.document_name_exists(project_id, base_name, exclude_document_id)? {
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

            if !self.document_name_exists(project_id, &candidate, None)?
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

        let target_dir = self.document_target_dir(document.project_id)?;
        self.ensure_document_name_available(
            document.project_id,
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
        Ok(())
    }

    fn touch_todo_owners(&self, todo: &TodoRecord) -> Result<()> {
        if let Some(project_id) = todo.project_id {
            self.touch_project(project_id)?;
        }
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

    fn migrate_activity_retire_schema(&mut self) -> Result<()> {
        self.migrate_legacy_domain_records(false)
    }

    fn migrate_legacy_domain_records(&mut self, recognize_v13_records: bool) -> Result<()> {
        self.conn
            .execute_batch("SAVEPOINT migrate_legacy_domain_records")?;
        let result = self.migrate_legacy_domain_records_inner(recognize_v13_records);
        match result {
            Ok(()) => {
                self.conn
                    .execute_batch("RELEASE SAVEPOINT migrate_legacy_domain_records")?;
                Ok(())
            }
            Err(error) => {
                if let Err(rollback_error) = self.conn.execute_batch(
                    "ROLLBACK TO SAVEPOINT migrate_legacy_domain_records; RELEASE SAVEPOINT migrate_legacy_domain_records;",
                ) {
                    return Err(error.context(format!(
                        "legacy domain migration rollback also failed: {rollback_error}"
                    )));
                }
                Err(error)
            }
        }
    }

    fn migrate_legacy_domain_records_inner(&mut self, recognize_v13_records: bool) -> Result<()> {
        let timestamp = now_iso();
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id, project_id, title, brief_markdown, brief_html, created_at, updated_at
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
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);

        let mut activity_tags = HashMap::new();
        let mut activity_titles = HashMap::new();
        for (activity_id, project_id, title, brief_markdown, brief_html, created_at, updated_at) in
            activities
        {
            let display_title = if title.trim().is_empty() {
                "未命名".to_string()
            } else {
                title.trim().to_string()
            };
            let tag_id = self.upsert_project_tag_by_label(
                project_id,
                &legacy_activity_source_tag_label(activity_id, &display_title),
                DEFAULT_RECORD_TYPE_COLOR_KEY,
                &timestamp,
            )?;
            activity_tags.insert(activity_id, (project_id, tag_id));
            activity_titles.insert(activity_id, display_title.clone());

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

            let has_brief = !brief_markdown.trim().is_empty() || !brief_html.trim().is_empty();
            let migrated_record_id = self
                .conn
                .query_row(
                    r#"
                    SELECT record_id
                    FROM legacy_domain_record_migrations
                    WHERE legacy_kind = 'activity_brief' AND legacy_id = ?1
                    "#,
                    [activity_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if has_brief && migrated_record_id.is_none() {
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
                let existing_record_id = if recognize_v13_records {
                    self.find_v13_activity_brief_record(
                        activity_id,
                        project_id,
                        &title,
                        &resolved_markdown,
                        &resolved_html,
                    )?
                } else {
                    None
                };
                let record_id = if let Some(record_id) = existing_record_id {
                    record_id
                } else {
                    self.insert_legacy_domain_record(
                        project_id,
                        Some(&display_title),
                        &resolved_markdown,
                        &resolved_html,
                        &created_at,
                        &updated_at,
                    )?
                };
                self.conn.execute(
                    "INSERT OR IGNORE INTO note_tag_links (note_id, tag_id, created_at) VALUES (?1, ?2, ?3)",
                    params![record_id, tag_id, timestamp],
                )?;
                self.conn.execute(
                    r#"
                    INSERT INTO legacy_domain_record_migrations (
                      legacy_kind, legacy_id, record_id, created_at
                    ) VALUES ('activity_brief', ?1, ?2, ?3)
                    "#,
                    params![activity_id, record_id, timestamp],
                )?;
            }
        }

        let mut stmt = self.conn.prepare(
            r#"
            SELECT
              id, project_id, activity_id, content_markdown, content_html, content,
              created_at, updated_at
            FROM conclusions
            ORDER BY project_id ASC, id ASC
            "#,
        )?;
        let conclusions = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);

        for (
            conclusion_id,
            project_id,
            activity_id,
            content_markdown,
            content_html,
            legacy_content,
            created_at,
            updated_at,
        ) in conclusions
        {
            let already_migrated = self
                .conn
                .query_row(
                    r#"
                    SELECT record_id
                    FROM legacy_domain_record_migrations
                    WHERE legacy_kind = 'conclusion' AND legacy_id = ?1
                    "#,
                    [conclusion_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_some();
            if already_migrated {
                continue;
            }

            let markdown = if content_markdown.trim().is_empty() {
                legacy_content
            } else {
                content_markdown
            };
            let html = if content_html.trim().is_empty() {
                rich_text_html_from_markdown(&markdown)
            } else {
                content_html
            };
            let title = activity_id
                .and_then(|id| activity_titles.get(&id))
                .map(|activity_title| format!("迁移的旧结论：{activity_title}"))
                .unwrap_or_else(|| format!("迁移的旧结论 #{conclusion_id}"));
            let tag_id = match activity_id.and_then(|id| activity_tags.get(&id).copied()) {
                Some((activity_project_id, tag_id)) if activity_project_id == project_id => tag_id,
                _ => self.upsert_project_tag_by_label(
                    project_id,
                    "来源: 旧结论",
                    DEFAULT_RECORD_TYPE_COLOR_KEY,
                    &timestamp,
                )?,
            };
            let record_id = self.insert_legacy_domain_record(
                project_id,
                Some(&title),
                &markdown,
                &html,
                &created_at,
                &updated_at,
            )?;
            self.conn.execute(
                "INSERT OR IGNORE INTO note_tag_links (note_id, tag_id, created_at) VALUES (?1, ?2, ?3)",
                params![record_id, tag_id, timestamp],
            )?;
            self.conn.execute(
                r#"
                INSERT INTO legacy_domain_record_migrations (
                  legacy_kind, legacy_id, record_id, created_at
                ) VALUES ('conclusion', ?1, ?2, ?3)
                "#,
                params![conclusion_id, record_id, timestamp],
            )?;
        }

        Ok(())
    }

    fn find_v13_activity_brief_record(
        &self,
        activity_id: i64,
        project_id: i64,
        activity_title: &str,
        markdown: &str,
        html: &str,
    ) -> Result<Option<i64>> {
        let trimmed_title = activity_title.trim();
        let source_label = if trimmed_title.is_empty() {
            format!("来源: 未命名 Activity {activity_id}")
        } else {
            format!("来源: {trimmed_title}")
        };
        let collision_label = format!("{source_label} (#{activity_id})");
        let record_title = (!trimmed_title.is_empty()).then_some(activity_title);

        self.conn
            .query_row(
                r#"
                SELECT note.id
                FROM notes note
                INNER JOIN note_tag_links link ON link.note_id = note.id
                INNER JOIN file_tag_options tag ON tag.id = link.tag_id
                WHERE note.project_id = ?1
                  AND ((?2 IS NULL AND note.title IS NULL) OR note.title = ?2)
                  AND note.content_markdown = ?3
                  AND note.content_html = ?4
                  AND tag.label IN (?5, ?6)
                ORDER BY note.id DESC
                LIMIT 1
                "#,
                params![
                    project_id,
                    record_title,
                    markdown,
                    html,
                    source_label,
                    collision_label
                ],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    fn insert_legacy_domain_record(
        &self,
        project_id: i64,
        title: Option<&str>,
        markdown: &str,
        html: &str,
        created_at: &str,
        updated_at: &str,
    ) -> Result<i64> {
        self.insert_project_note(project_id, title, markdown, html, None, created_at)?;
        let record_id = self.conn.last_insert_rowid();
        self.conn.execute(
            "UPDATE notes SET created_at = ?1, updated_at = ?2 WHERE id = ?3",
            params![created_at, updated_at, record_id],
        )?;
        Ok(record_id)
    }

    fn ensure_system_pending_activity_status(&mut self) -> Result<()> {
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
        Ok(())
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

    fn ensure_legacy_domain_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
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

            CREATE TABLE IF NOT EXISTS legacy_domain_record_migrations (
              legacy_kind TEXT NOT NULL,
              legacy_id INTEGER NOT NULL,
              record_id INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              PRIMARY KEY(legacy_kind, legacy_id),
              FOREIGN KEY(record_id) REFERENCES notes(id) ON DELETE CASCADE
            );
            "#,
        )?;
        Ok(())
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

    fn table_exists(&self, table: &str) -> Result<bool> {
        self.conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                [table],
                |row| row.get(0),
            )
            .map_err(Into::into)
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

fn backup_before_migration(conn: &Connection, workspace_root: &Path) -> Result<Option<PathBuf>> {
    let schema_version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if schema_version >= CURRENT_SCHEMA_VERSION {
        return Ok(None);
    }

    let backup_dir = workspace_root
        .join(WORKSPACE_HIDDEN_DIR_NAME)
        .join("backups");
    fs::create_dir_all(&backup_dir).with_context(|| {
        format!(
            "failed to create workspace backup directory at {}",
            backup_dir.display()
        )
    })?;
    let backup_path = backup_dir.join(format!(
        "workspace-schema-{schema_version}-to-{CURRENT_SCHEMA_VERSION}-{}.sqlite3",
        Utc::now().timestamp_millis()
    ));
    conn.backup(MAIN_DB, &backup_path, None).with_context(|| {
        format!(
            "failed to back up workspace database before migration to schema {CURRENT_SCHEMA_VERSION}"
        )
    })?;
    Ok(Some(backup_path))
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

fn normalize_internal_reference_label(kind: &str, value: &str) -> String {
    let normalized =
        normalize_internal_reference_match_text(&strip_internal_reference_label_tokens(value));
    let fallback = match kind {
        "note" => "记录",
        "todo" => "Todo",
        "document" => "文件",
        _ => "未命名引用",
    };
    let resolved = if normalized.is_empty() {
        fallback.to_string()
    } else {
        normalized
    };

    if kind == "todo" {
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
        if matches!(kind, "note" | "todo" | "document") {
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

fn build_internal_reference_route(project_id: i64, focus_id: &str) -> String {
    format!("/projects/{project_id}?focus={focus_id}")
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

#[derive(Clone, Copy)]
enum RichTextAssetPathMode {
    Persist,
    Hydrate,
}

fn persist_rich_text_asset_paths(
    html: &str,
    base_path: &Path,
    document_paths: &HashMap<i64, PathBuf>,
) -> String {
    transform_rich_text_asset_paths(
        html,
        base_path,
        document_paths,
        RichTextAssetPathMode::Persist,
    )
}

fn hydrate_rich_text_asset_paths(html: &str, base_path: &Path) -> String {
    transform_rich_text_asset_paths(
        html,
        base_path,
        &HashMap::new(),
        RichTextAssetPathMode::Hydrate,
    )
}

fn transform_rich_text_asset_paths(
    html: &str,
    base_path: &Path,
    document_paths: &HashMap<i64, PathBuf>,
    mode: RichTextAssetPathMode,
) -> String {
    let mut attachment_path: Option<String> = None;
    rewrite_html_tags(html, |tag| {
        let lower_tag = tag.to_ascii_lowercase();

        if lower_tag.starts_with("</div") && attachment_path.is_some() {
            attachment_path = None;
            return finalize_rich_text_asset_tag(tag, mode);
        }

        if lower_tag.starts_with("<a") {
            let next_tag = attachment_path
                .as_deref()
                .map(|path| replace_html_attribute_value(tag, "href", path))
                .unwrap_or_else(|| tag.to_string());
            return finalize_rich_text_asset_tag(&next_tag, mode);
        }

        let is_image = lower_tag.starts_with("<img");
        let is_attachment = html_attribute_value(tag, "data-type")
            .is_some_and(|value| value.eq_ignore_ascii_case("attachment"));
        let data_path = html_attribute_value(tag, "data-path");
        let raw_path = data_path.clone().or_else(|| {
            if is_attachment {
                return html_attribute_value(tag, "data-href");
            }
            if is_image {
                return html_attribute_value(tag, "src")
                    .filter(|value| !is_portable_resource_url(&unescape_html_attribute(value)));
            }
            None
        });
        let Some(raw_path) = raw_path else {
            return finalize_rich_text_asset_tag(tag, mode);
        };
        let decoded_raw_path = unescape_html_attribute(&raw_path);
        if is_portable_resource_url(&decoded_raw_path) {
            let escaped_path = escape_html_attribute(&decoded_raw_path);
            let mut next_tag = tag.to_string();
            if is_image && data_path.is_some() {
                let current_src = html_attribute_value(tag, "src")
                    .map(|value| unescape_html_attribute(&value))
                    .unwrap_or_default();
                if current_src.is_empty() || is_nonportable_local_path(&current_src) {
                    next_tag = replace_html_attribute_value(&next_tag, "src", &escaped_path);
                }
            }
            if is_attachment {
                next_tag = replace_html_attribute_value(&next_tag, "data-href", &escaped_path);
                attachment_path = Some(escaped_path);
            }
            return finalize_rich_text_asset_tag(&next_tag, mode);
        }
        let document_id = html_attribute_value(tag, "data-document-id")
            .and_then(|value| value.parse::<i64>().ok());
        let next_path =
            transform_rich_text_asset_path(&raw_path, document_id, base_path, document_paths, mode);
        let path_changed = next_path != unescape_html_attribute(&raw_path);
        let escaped_path = escape_html_attribute(&next_path);
        let mut next_tag = data_path
            .is_some()
            .then(|| replace_html_attribute_value(tag, "data-path", &escaped_path))
            .unwrap_or_else(|| tag.to_string());

        if is_image {
            let current_src = html_attribute_value(tag, "src")
                .map(|value| unescape_html_attribute(&value))
                .unwrap_or_default();
            let should_rewrite_src = if next_path.is_empty() {
                matches!(mode, RichTextAssetPathMode::Persist)
                    && !current_src.is_empty()
                    && !is_portable_resource_url(&current_src)
            } else {
                path_changed || data_path.is_none()
            };
            if should_rewrite_src {
                next_tag = replace_html_attribute_value(&next_tag, "src", &escaped_path);
            }
        }

        if is_attachment {
            let attachment_href = match (mode, next_path.is_empty()) {
                (_, true) => String::new(),
                (RichTextAssetPathMode::Persist, false) => escaped_path,
                (RichTextAssetPathMode::Hydrate, false) => {
                    escape_html_attribute(&file_href_from_path(Path::new(&next_path)))
                }
            };
            next_tag = replace_html_attribute_value(&next_tag, "data-href", &attachment_href);
            attachment_path = Some(attachment_href);
        }

        finalize_rich_text_asset_tag(&next_tag, mode)
    })
}

fn rewrite_html_tags<F>(html: &str, mut rewrite_tag: F) -> String
where
    F: FnMut(&str) -> String,
{
    if html.is_empty() {
        return html.to_string();
    }

    let mut rewritten = String::with_capacity(html.len());
    let mut cursor = 0usize;
    while let Some(tag_offset) = html[cursor..].find('<') {
        let tag_start = cursor + tag_offset;
        rewritten.push_str(&html[cursor..tag_start]);

        let Some(tag_end_offset) = html[tag_start..].find('>') else {
            rewritten.push_str(&html[tag_start..]);
            return rewritten;
        };
        let tag_end = tag_start + tag_end_offset + 1;
        rewritten.push_str(&rewrite_tag(&html[tag_start..tag_end]));
        cursor = tag_end;
    }

    rewritten.push_str(&html[cursor..]);
    rewritten
}

fn finalize_rich_text_asset_tag(tag: &str, mode: RichTextAssetPathMode) -> String {
    if matches!(mode, RichTextAssetPathMode::Persist) {
        sanitize_persisted_rich_text_path_attributes(tag)
    } else {
        tag.to_string()
    }
}

fn sanitize_persisted_rich_text_path_attributes(tag: &str) -> String {
    RICH_TEXT_PATH_ATTRIBUTES
        .into_iter()
        .fold(tag.to_string(), |current, attribute| {
            let Some(value) = html_attribute_value(&current, attribute) else {
                return current;
            };
            let decoded = unescape_html_attribute(&value);
            if !is_nonportable_local_path(&decoded) && !relative_path_escapes_scope(&decoded) {
                return current;
            }
            replace_html_attribute_value(&current, attribute, "")
        })
}

fn transform_rich_text_asset_path(
    raw_path: &str,
    document_id: Option<i64>,
    base_path: &Path,
    document_paths: &HashMap<i64, PathBuf>,
    mode: RichTextAssetPathMode,
) -> String {
    let decoded_path = unescape_html_attribute(raw_path);
    let document_path = document_id.and_then(|id| document_paths.get(&id));

    match mode {
        RichTextAssetPathMode::Persist => {
            if let Some(path) = document_path {
                return relative_asset_path(path, base_path).unwrap_or_default();
            }

            if let Some(relative) = relative_asset_path(Path::new(&decoded_path), base_path) {
                return relative;
            }

            normalize_relative_asset_path(&decoded_path).unwrap_or_default()
        }
        RichTextAssetPathMode::Hydrate => {
            if let Some(path) = document_path {
                return path.to_string_lossy().to_string();
            }

            if let Some(relative) = normalize_relative_asset_path(&decoded_path) {
                return base_path.join(relative).to_string_lossy().to_string();
            }

            decoded_path
        }
    }
}

fn relative_asset_path(path: &Path, base_path: &Path) -> Option<String> {
    let relative = path.strip_prefix(base_path).ok()?;
    normalize_relative_asset_path(&relative.to_string_lossy())
}

fn normalize_relative_asset_path(value: &str) -> Option<String> {
    let normalized = value.trim().replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.starts_with("//")
        || normalized.starts_with("file:")
        || normalized.starts_with("asset:")
        || normalized
            .split('/')
            .next()
            .is_some_and(|segment| segment.contains(':'))
        || normalized
            .as_bytes()
            .get(1)
            .is_some_and(|value| *value == b':')
    {
        return None;
    }

    let mut segments = Vec::new();
    for segment in normalized.split('/') {
        match segment {
            "" | "." => continue,
            ".." => return None,
            value => segments.push(value),
        }
    }

    (!segments.is_empty()).then(|| segments.join("/"))
}

fn is_portable_resource_url(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    normalized.starts_with("data:")
        || normalized.starts_with("https://")
        || normalized.starts_with("http://")
}

fn is_nonportable_local_path(value: &str) -> bool {
    let normalized = value.trim().replace('\\', "/");
    let lower = normalized.to_ascii_lowercase();
    lower.starts_with('/')
        || lower.starts_with("file:")
        || lower.starts_with("asset:")
        || normalized
            .as_bytes()
            .get(1)
            .is_some_and(|value| *value == b':')
}

fn relative_path_escapes_scope(value: &str) -> bool {
    if is_portable_resource_url(value) {
        return false;
    }
    value
        .trim()
        .replace('\\', "/")
        .split('/')
        .any(|segment| segment == "..")
}

fn recover_moved_workspace_asset_paths(html: &str, workspace_root: &Path) -> String {
    rewrite_html_tags(html, |tag| {
        RICH_TEXT_PATH_ATTRIBUTES
            .into_iter()
            .fold(tag.to_string(), |current, attribute| {
                let Some(value) = html_attribute_value(&current, attribute) else {
                    return current;
                };
                let decoded = unescape_html_attribute(&value);
                let Some(relative) =
                    recover_moved_workspace_asset_relative_path(&decoded, workspace_root)
                else {
                    return current;
                };
                let recovered = workspace_root.join(relative);
                replace_html_attribute_value(
                    &current,
                    attribute,
                    &escape_html_attribute(&recovered.to_string_lossy()),
                )
            })
    })
}

fn recover_moved_workspace_asset_relative_path(
    value: &str,
    workspace_root: &Path,
) -> Option<String> {
    if !is_nonportable_local_path(value) {
        return None;
    }

    let normalized = value.trim().replace('\\', "/");
    let managed_prefix =
        format!("{WORKSPACE_HIDDEN_DIR_NAME}/{PROJECT_NOTE_ASSET_DIR_NAME}/workspace/");
    let prefix_start = normalized.find(&managed_prefix)?;
    if prefix_start > 0 && normalized.as_bytes().get(prefix_start - 1) != Some(&b'/') {
        return None;
    }
    let relative = normalize_relative_asset_path(&normalized[prefix_start..])?;
    if !relative.starts_with(&managed_prefix) || !workspace_root.join(&relative).is_file() {
        return None;
    }
    Some(relative)
}

fn html_attribute_value(tag: &str, attribute: &str) -> Option<String> {
    let (value_start, value_end) = html_attribute_value_range(tag, attribute)?;
    Some(tag[value_start..value_end].to_string())
}

fn replace_html_attribute_value(tag: &str, attribute: &str, value: &str) -> String {
    let Some((value_start, value_end)) = html_attribute_value_range(tag, attribute) else {
        return tag.to_string();
    };

    let is_quoted = value_start > 0
        && tag
            .as_bytes()
            .get(value_start - 1)
            .is_some_and(|candidate| *candidate == b'"' || *candidate == b'\'');
    let replacement = if !is_quoted
        && value.bytes().any(|candidate| {
            candidate.is_ascii_whitespace()
                || matches!(candidate, b'"' | b'\'' | b'`' | b'=' | b'<' | b'>')
        }) {
        format!("\"{value}\"")
    } else {
        value.to_string()
    };

    let mut replaced =
        String::with_capacity(tag.len() - (value_end - value_start) + replacement.len());
    replaced.push_str(&tag[..value_start]);
    replaced.push_str(&replacement);
    replaced.push_str(&tag[value_end..]);
    replaced
}

fn html_attribute_value_range(tag: &str, attribute: &str) -> Option<(usize, usize)> {
    let searchable_tag = tag.to_ascii_lowercase();
    let searchable_attribute = attribute.to_ascii_lowercase();
    let bytes = searchable_tag.as_bytes();
    let attribute_bytes = searchable_attribute.as_bytes();
    let mut search_start = 0usize;

    while search_start + attribute_bytes.len() <= bytes.len() {
        let offset = searchable_tag[search_start..].find(&searchable_attribute)?;
        let name_start = search_start + offset;
        let name_end = name_start + attribute_bytes.len();
        let valid_start = name_start == 0
            || bytes[name_start - 1].is_ascii_whitespace()
            || bytes[name_start - 1] == b'<';
        let mut cursor = name_end;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }

        if !valid_start || bytes.get(cursor) != Some(&b'=') {
            search_start = name_end;
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }

        let first_value_byte = *bytes.get(cursor)?;
        if first_value_byte == b'"' || first_value_byte == b'\'' {
            let value_start = cursor + 1;
            let value_end = bytes[value_start..]
                .iter()
                .position(|candidate| *candidate == first_value_byte)
                .map(|offset| value_start + offset)?;
            return Some((value_start, value_end));
        }
        let value_start = cursor;
        let value_end = bytes[value_start..]
            .iter()
            .position(|candidate| candidate.is_ascii_whitespace() || *candidate == b'>')
            .map(|offset| value_start + offset)
            .unwrap_or(bytes.len());
        return Some((value_start, value_end));
    }

    None
}

fn escape_html_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn unescape_html_attribute(value: &str) -> String {
    unescape_numeric_html_entities(value)
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn unescape_numeric_html_entities(value: &str) -> String {
    let mut decoded = String::with_capacity(value.len());
    let mut cursor = 0usize;

    while let Some(offset) = value[cursor..].find("&#") {
        let entity_start = cursor + offset;
        decoded.push_str(&value[cursor..entity_start]);
        let digits_start = entity_start + 2;
        let Some(end_offset) = value[digits_start..].find(';') else {
            decoded.push_str(&value[entity_start..]);
            return decoded;
        };
        let entity_end = digits_start + end_offset;
        let entity = &value[digits_start..entity_end];
        let parsed = entity
            .strip_prefix('x')
            .or_else(|| entity.strip_prefix('X'))
            .and_then(|digits| u32::from_str_radix(digits, 16).ok())
            .or_else(|| entity.parse::<u32>().ok())
            .and_then(char::from_u32);
        if let Some(character) = parsed {
            decoded.push(character);
        } else {
            decoded.push_str(&value[entity_start..=entity_end]);
        }
        cursor = entity_end + 1;
    }

    decoded.push_str(&value[cursor..]);
    decoded
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

fn apply_rich_text_html_updates(
    tx: &Transaction<'_>,
    update_sql: &str,
    updates: &[(i64, String)],
) -> Result<()> {
    for (id, content_html) in updates {
        tx.execute(update_sql, params![content_html, id])?;
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

#[cfg(test)]
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

    fn enable_legacy_domain_fixture_schema(database: &Database) {
        database.ensure_legacy_domain_schema().unwrap();
        for (table, sql) in [
            ("notes", "ALTER TABLE notes ADD COLUMN activity_id INTEGER"),
            ("todos", "ALTER TABLE todos ADD COLUMN activity_id INTEGER"),
            (
                "documents",
                "ALTER TABLE documents ADD COLUMN activity_id INTEGER",
            ),
        ] {
            if !database.has_column(table, "activity_id").unwrap() {
                database.conn.execute(sql, []).unwrap();
            }
        }
    }

    #[test]
    fn fresh_workspace_schema_omits_legacy_domain_tables_and_columns() {
        let (harness, database) = setup_database();
        let db_path = harness.root.join("app.sqlite3");

        for table in [
            "activities",
            "activity_attribute_options",
            "activity_status_options",
            "conclusions",
            "legacy_domain_record_migrations",
        ] {
            assert!(!database.table_exists(table).unwrap(), "unexpected {table}");
        }
        for table in ["notes", "todos", "documents"] {
            assert!(!database.has_column(table, "activity_id").unwrap());
        }
        assert_eq!(database.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        drop(database);

        let reopened = Database::open(&db_path, &harness.workspace_root, None).unwrap();
        for table in [
            "activities",
            "activity_attribute_options",
            "activity_status_options",
            "conclusions",
            "legacy_domain_record_migrations",
        ] {
            assert!(!reopened.table_exists(table).unwrap(), "unexpected {table}");
        }
        for table in ["notes", "todos", "documents"] {
            assert!(!reopened.has_column(table, "activity_id").unwrap());
        }
        assert_eq!(reopened.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn demo_seed_uses_only_current_workspace_domain_objects() {
        let (harness, mut database) = setup_database();

        let summary = database.seed_demo_data(&harness.workspace_root).unwrap();

        assert_eq!(summary.project_count, 3);
        assert_eq!(summary.project_record_count, 3);
        assert_eq!(summary.workspace_record_count, 1);
        assert_eq!(summary.todo_count, 3);
        assert_eq!(summary.file_count, 3);
        assert!(!database.table_exists("activities").unwrap());
        assert!(!database.table_exists("conclusions").unwrap());
    }

    #[test]
    fn opening_an_older_workspace_backs_up_and_preserves_its_database() {
        let (harness, database) = setup_database();
        enable_legacy_domain_fixture_schema(&database);
        let db_path = harness.root.join("app.sqlite3");
        database
            .conn
            .execute_batch(
                r#"
                CREATE TABLE preserved_before_update (value TEXT NOT NULL);
                INSERT INTO preserved_before_update (value) VALUES ('keep me');
                PRAGMA user_version = 18;
                "#,
            )
            .unwrap();
        drop(database);

        let reopened = Database::open(&db_path, &harness.workspace_root, None).unwrap();
        let preserved: String = reopened
            .conn
            .query_row("SELECT value FROM preserved_before_update", [], |row| {
                row.get(0)
            })
            .unwrap();

        expect_workspace_backup(&harness.workspace_root, "keep me");
        assert_eq!(preserved, "keep me");
    }

    #[test]
    fn opening_schema_19_repairs_stale_absolute_rich_text_asset_paths() {
        let (harness, mut database) = setup_database();
        let db_path = harness.root.join("app.sqlite3");
        let project = create_project(&mut database, &harness.workspace_root);
        let image = database
            .document_import_clipboard_note_image(DocumentImportClipboardNoteImageInput {
                project_id: project.id,
                file_name: "legacy.png".to_string(),
                mime_type: "image/png".to_string(),
                data_base64: STANDARD.encode(b"legacy-image"),
            })
            .unwrap();
        let renamed = database
            .project_update(ProjectUpdateInput {
                project_id: project.id,
                name: Some("Alpha Prime".to_string()),
                summary: String::new(),
                summary_markdown: Some(String::new()),
                summary_html: Some(String::new()),
                summary_code_language: None,
                status: Some(project.status.clone()),
            })
            .unwrap();
        let moved_image = database.document_record(image.id).unwrap();
        let stale_html = format!(
            concat!(
                r#"<p><img src="{}" data-path="{}" "#,
                r#"data-mime-type="image/png" data-document-id="{}"></p>"#
            ),
            image.managed_path, image.managed_path, image.id,
        );
        database
            .conn
            .execute(
                "UPDATE projects SET summary_html = ?1 WHERE id = ?2",
                params![stale_html, project.id],
            )
            .unwrap();
        database.set_schema_version(19).unwrap();
        drop(database);

        let reopened = Database::open(
            &db_path,
            &harness.workspace_root,
            Some("test-secret".to_string()),
        )
        .unwrap();
        let stored_html = reopened
            .conn
            .query_row(
                "SELECT summary_html FROM projects WHERE id = ?1",
                [project.id],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        let repaired = reopened.project_record(project.id).unwrap();

        assert_eq!(repaired.root_path, renamed.root_path);
        assert!(stored_html
            .contains(r#"data-path=".project-mind/embedded-note-assets/project/legacy.png""#));
        assert!(!stored_html.contains(&project.root_path));
        assert!(repaired.summary_html.contains(&moved_image.managed_path));
        assert!(!repaired.summary_html.contains(&image.managed_path));
    }

    #[test]
    fn opening_schema_19_recovers_workspace_images_after_the_workspace_moves() {
        let (harness, mut database) = setup_database();
        let db_path = harness.root.join("app.sqlite3");
        let image = database
            .workspace_clipboard_note_image_import(WorkspaceClipboardNoteImageImportInput {
                file_name: "legacy-workspace.png".to_string(),
                mime_type: "image/png".to_string(),
                data_base64: STANDARD.encode(b"legacy-workspace-image"),
            })
            .unwrap();
        let old_workspace_path = Path::new("/old-machine/renamed-workspace")
            .join(WORKSPACE_HIDDEN_DIR_NAME)
            .join(PROJECT_NOTE_ASSET_DIR_NAME)
            .join("workspace")
            .join("legacy-workspace.png");
        let stale_html = format!(
            r#"<p><img src="asset://{}" data-path="{}" data-mime-type="image/png"></p>"#,
            old_workspace_path.to_string_lossy(),
            old_workspace_path.to_string_lossy(),
        );
        let note = database
            .workspace_quick_note_upsert(WorkspaceQuickNoteUpsertInput {
                markdown: "[图片]".to_string(),
                html: "<p>[图片]</p>".to_string(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        database
            .conn
            .execute(
                "UPDATE workspace_notes SET content_html = ?1 WHERE id = ?2",
                params![stale_html, note.id],
            )
            .unwrap();
        database.set_schema_version(19).unwrap();
        drop(database);

        let mut reopened = Database::open(
            &db_path,
            &harness.workspace_root,
            Some("test-secret".to_string()),
        )
        .unwrap();
        let stored_html = reopened
            .conn
            .query_row(
                "SELECT content_html FROM workspace_notes WHERE id = ?1",
                [note.id],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        let hydrated = reopened.workspace_quick_note_get().unwrap().unwrap();

        assert!(Path::new(&image.path).exists());
        assert!(stored_html.contains(
            r#"data-path=".project-mind/embedded-note-assets/workspace/legacy-workspace.png""#
        ));
        assert!(!stored_html.contains("old-machine"));
        assert!(hydrated.content_html.contains(&image.path));
    }

    fn expect_workspace_backup(workspace_root: &Path, expected_value: &str) {
        let backup_dir = workspace_root
            .join(WORKSPACE_HIDDEN_DIR_NAME)
            .join("backups");
        let backup_paths = fs::read_dir(backup_dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(backup_paths.len(), 1);

        let backup = Connection::open(&backup_paths[0]).unwrap();
        let preserved: String = backup
            .query_row("SELECT value FROM preserved_before_update", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(preserved, expected_value);
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

    fn create_todo(
        database: &mut Database,
        project_id: i64,
        content: &str,
        priority: &str,
    ) -> TodoRecord {
        database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Project,
                project_id: Some(project_id),
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
            "content": "Legacy implicit Project Todo",
            "priority": "not_urgent_important",
            "dueDate": null,
            "tagIds": []
        });

        assert!(serde_json::from_value::<TodoCreateInput>(input).is_err());
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
                capability: "default".to_string(),
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
                show_in_image_menu: false,
                profile_id: None,
                sort_order: Some(99),
                enabled: true,
            })
            .unwrap();

        assert_eq!(skill.name, "润色");
        assert_eq!(database.ai_settings_get().unwrap().editor_skills.len(), 6);

        let updated = database
            .ai_editor_skill_upsert(AiEditorSkillUpsertInput {
                id: Some(skill.id.clone()),
                name: "解释".to_string(),
                icon: None,
                description: None,
                prompt: "请翻译成英文".to_string(),
                result_mode: "answer".to_string(),
                show_in_text_menu: false,
                show_in_image_menu: false,
                profile_id: None,
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
        assert_eq!(remaining.len(), 5);
    }

    #[test]
    fn ai_editor_skills_migrate_legacy_rewrite_actions() {
        let (_harness, mut database) = setup_database();
        let action_id = 7;
        database
            .conn
            .execute(
                "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)",
                params![
                    APP_SETTING_KEY_AI_EDITOR_REWRITE_ACTIONS,
                    serde_json::json!([{
                        "id": action_id,
                        "label": "旧动作",
                        "prompt": "请改写当前选区",
                        "enabled": true,
                        "createdAt": "2026-04-06T08:00:00.000Z",
                        "updatedAt": "2026-04-06T08:00:00.000Z"
                    }])
                    .to_string(),
                    now_iso(),
                ],
            )
            .unwrap();

        let skills = database.ai_editor_skills_get().unwrap();
        assert_eq!(skills.len(), 2);
        let migrated = skills
            .iter()
            .find(|skill| skill.id == format!("rewrite-action-{action_id}"))
            .unwrap();
        assert_eq!(migrated.result_mode, "modify");
        assert!(migrated.show_in_text_menu);
        assert!(skills.iter().any(|skill| skill.id == "extract-image-text"));
    }

    #[test]
    fn image_interpretation_settings_seed_ocr_and_keep_legacy_skills_out_of_image_menu() {
        let (_harness, mut database) = setup_database();
        let action_id = 9;
        database
            .conn
            .execute(
                "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)",
                params![
                    APP_SETTING_KEY_AI_EDITOR_REWRITE_ACTIONS,
                    serde_json::json!([{
                        "id": action_id,
                        "label": "旧动作",
                        "prompt": "请改写当前选区",
                        "enabled": true,
                        "createdAt": "2026-04-06T08:00:00.000Z",
                        "updatedAt": "2026-04-06T08:00:00.000Z"
                    }])
                    .to_string(),
                    now_iso(),
                ],
            )
            .unwrap();

        let skills = database.ai_editor_skills_get().unwrap();
        let legacy = skills
            .iter()
            .find(|skill| skill.id == format!("rewrite-action-{action_id}"))
            .unwrap();
        let ocr = skills
            .iter()
            .find(|skill| skill.id == "extract-image-text")
            .unwrap();

        assert!(!legacy.show_in_image_menu);
        assert!(ocr.show_in_image_menu);
        assert!(!ocr.show_in_text_menu);
        assert_eq!(ocr.result_mode, "modify");
        assert_eq!(ocr.profile_id, None);
    }

    #[test]
    fn image_default_migration_prefers_compatible_legacy_editor_binding() {
        let (_harness, mut database) = setup_database();
        let general = database
            .ai_profile_upsert(AiProviderProfileUpsertInput {
                id: None,
                name: "General".to_string(),
                provider_family: "openai_compatible".to_string(),
                base_url: "https://mock.local/v1".to_string(),
                api_key: Some("general-key".to_string()),
                default_model: "general-model".to_string(),
                supports_text: true,
                supports_image: true,
                supports_file: false,
                enabled: true,
            })
            .unwrap();
        let legacy_image = database
            .ai_profile_upsert(AiProviderProfileUpsertInput {
                id: None,
                name: "Legacy image".to_string(),
                provider_family: "gemini_compatible".to_string(),
                base_url: "https://mock.local/v1".to_string(),
                api_key: Some("image-key".to_string()),
                default_model: "image-model".to_string(),
                supports_text: true,
                supports_image: true,
                supports_file: false,
                enabled: true,
            })
            .unwrap();
        database
            .ai_binding_upsert(AiCapabilityBindingUpsertInput {
                capability: "default".to_string(),
                use_default: false,
                profile_id: Some(general.id),
                model: None,
            })
            .unwrap();
        database.conn.execute(
            "INSERT INTO ai_capability_bindings (capability, use_default, profile_id, model, updated_at) VALUES ('editor_rewrite', 0, ?1, 'legacy-image-model', ?2)",
            params![legacy_image.id, now_iso()],
        ).unwrap();

        let settings = database.ai_settings_get().unwrap();
        assert_eq!(
            settings
                .bindings
                .iter()
                .find(|binding| binding.capability == "default")
                .and_then(|binding| binding.profile_id),
            Some(general.id)
        );
        let image_binding = settings
            .bindings
            .iter()
            .find(|binding| binding.capability == "image_default")
            .unwrap();
        assert_eq!(image_binding.profile_id, Some(legacy_image.id));
        assert_eq!(image_binding.model.as_deref(), Some("legacy-image-model"));
        assert!(settings.has_usable_image_default);
    }

    #[test]
    fn image_skill_requires_a_text_and_image_capable_profile() {
        let (_harness, mut database) = setup_database();
        let error = database
            .ai_editor_skill_upsert(AiEditorSkillUpsertInput {
                id: None,
                name: "看图".to_string(),
                icon: None,
                description: None,
                prompt: "描述图片".to_string(),
                result_mode: "answer".to_string(),
                show_in_text_menu: false,
                show_in_image_menu: true,
                profile_id: None,
                sort_order: None,
                enabled: true,
            })
            .unwrap_err();

        assert!(error.to_string().contains("image default"));
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
    fn ai_editor_skill_runs_modify_skill() {
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
                show_in_image_menu: false,
                profile_id: None,
                sort_order: None,
                enabled: true,
            })
            .unwrap();

        let mut streamed = Vec::new();
        let result = database
            .ai_editor_skill_execute(
                AiEditorSkillInput {
                    skill_id: Some(skill.id.clone()),
                    skill_name: Some(skill.name.clone()),
                    prompt: Some(skill.prompt.clone()),
                    result_mode: "modify".to_string(),
                    selected_text: "第一段".to_string(),
                    expanded_markdown: None,
                    placeholder_tokens: Vec::new(),
                    document_context: None,
                    target_type: None,
                    image_target: None,
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
    fn ai_editor_skill_auto_can_return_a_replacement_and_answer() {
        let (_harness, mut database) = setup_database();
        configure_editor_rewrite_profile(&mut database);

        let result = database
            .ai_editor_skill_execute(
                AiEditorSkillInput {
                    skill_id: None,
                    skill_name: Some("AI 编辑".to_string()),
                    prompt: Some("请润色并解释修改原因".to_string()),
                    result_mode: "auto".to_string(),
                    selected_text: "第一段".to_string(),
                    expanded_markdown: None,
                    placeholder_tokens: Vec::new(),
                    document_context: None,
                    target_type: None,
                    image_target: None,
                },
                |_| {},
            )
            .unwrap();

        assert_eq!(result.result_mode, "auto");
        assert!(result.replacement_markdown.is_some());
        assert!(result.answer_markdown.is_some());
    }

    #[test]
    fn ai_editor_skill_placeholder_validator_rejects_missing_tokens() {
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
    fn workspace_todo_can_be_created_without_project_ownership() {
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
                content: "整理跨项目复盘模板".to_string(),
                priority: "not_urgent_important".to_string(),
                due_date: Some("2026-08-01".to_string()),
                tag_ids: vec![workspace_tag.id],
            })
            .unwrap();

        assert_eq!(created.scope, TodoScope::Workspace);
        assert_eq!(created.project_id, None);
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
    fn deleting_project_removes_only_its_project_todos() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let project_todo = create_todo(
            &mut database,
            project.id,
            "随 Project 删除",
            "not_urgent_important",
        );
        let workspace_todo = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Workspace,
                project_id: None,
                content: "保留 Workspace Todo".to_string(),
                priority: "urgent_important".to_string(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();

        database
            .project_delete(ProjectDeleteInput {
                project_id: project.id,
            })
            .unwrap();

        assert!(database.todo_record(project_todo.id).is_err());
        assert_eq!(
            database.todo_record(workspace_todo.id).unwrap().id,
            workspace_todo.id
        );
        assert_eq!(
            database
                .workspace_todo_rail_list()
                .unwrap()
                .into_iter()
                .map(|todo| todo.id)
                .collect::<Vec<_>>(),
            vec![workspace_todo.id]
        );
    }

    #[test]
    fn todo_due_dates_are_stored_separately_from_creation_and_progress_dates() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let todo = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Project,
                project_id: Some(project.id),
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
    fn project_rich_text_assets_are_stored_relative_and_returned_resolved() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let image = database
            .document_import_clipboard_note_image(DocumentImportClipboardNoteImageInput {
                project_id: project.id,
                file_name: "quick-note.png".to_string(),
                mime_type: "image/png".to_string(),
                data_base64: STANDARD.encode(b"quick-note-image"),
            })
            .unwrap();
        let html = format!(
            concat!(
                r#"<p><img src="asset://old" data-path="{}" "#,
                r#"data-mime-type="image/png" data-document-id="{}"></p>"#
            ),
            image.managed_path, image.id,
        );

        let saved = database
            .project_update(ProjectUpdateInput {
                project_id: project.id,
                name: None,
                summary: "[图片]".to_string(),
                summary_markdown: Some("[图片]".to_string()),
                summary_html: Some(html),
                summary_code_language: None,
                status: Some(project.status.clone()),
            })
            .unwrap();
        let stored_html = database
            .conn
            .query_row(
                "SELECT summary_html FROM projects WHERE id = ?1",
                [project.id],
                |row| row.get::<_, String>(0),
            )
            .unwrap();

        assert!(stored_html
            .contains(r#"data-path=".project-mind/embedded-note-assets/project/quick-note.png""#));
        assert!(!stored_html.contains(&project.root_path));
        assert!(saved.summary_html.contains(&image.managed_path));
        let listed = database
            .projects_list(ProjectsListInput {
                include_archived: Some(true),
            })
            .unwrap();
        assert!(listed[0].summary_html.contains(&image.managed_path));
    }

    #[test]
    fn project_rename_keeps_relative_quick_note_and_stale_record_assets_live() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let image = database
            .document_import_clipboard_note_image(DocumentImportClipboardNoteImageInput {
                project_id: project.id,
                file_name: "shared.png".to_string(),
                mime_type: "image/png".to_string(),
                data_base64: STANDARD.encode(b"shared-image"),
            })
            .unwrap();
        let html = format!(
            concat!(
                r#"<p><img src="asset://old" data-path="{}" "#,
                r#"data-mime-type="image/png" data-document-id="{}"></p>"#
            ),
            image.managed_path, image.id,
        );
        let enriched = database
            .project_update(ProjectUpdateInput {
                project_id: project.id,
                name: None,
                summary: "[图片]".to_string(),
                summary_markdown: Some("[图片]".to_string()),
                summary_html: Some(html.clone()),
                summary_code_language: None,
                status: Some(project.status.clone()),
            })
            .unwrap();
        let record = database
            .project_record_upsert(ProjectRecordUpsertInput {
                project_id: project.id,
                note_id: None,
                title: Some("带图记录".to_string()),
                markdown: "[图片]".to_string(),
                html,
                tag_ids: vec![],
                default_code_language: None,
            })
            .unwrap();
        let stale_record_html = record.content_html.clone();
        let stored_quick_note_before = database
            .conn
            .query_row(
                "SELECT summary_html FROM projects WHERE id = ?1",
                [project.id],
                |row| row.get::<_, String>(0),
            )
            .unwrap();

        let renamed = database
            .project_update(ProjectUpdateInput {
                project_id: project.id,
                name: Some("Alpha Prime".to_string()),
                summary: enriched.summary.clone(),
                summary_markdown: Some(enriched.summary_markdown.clone()),
                summary_html: Some(enriched.summary_html.clone()),
                summary_code_language: enriched.summary_code_language.clone(),
                status: Some(enriched.status.clone()),
            })
            .unwrap();
        let moved_image = database.document_record(image.id).unwrap();
        let stored_quick_note_after = database
            .conn
            .query_row(
                "SELECT summary_html FROM projects WHERE id = ?1",
                [project.id],
                |row| row.get::<_, String>(0),
            )
            .unwrap();

        assert_eq!(stored_quick_note_after, stored_quick_note_before);
        assert!(Path::new(&moved_image.managed_path).exists());
        assert!(renamed.summary_html.contains(&moved_image.managed_path));

        let resaved = database
            .project_record_upsert(ProjectRecordUpsertInput {
                project_id: project.id,
                note_id: Some(record.id),
                title: record.title.clone(),
                markdown: record.content_markdown.clone(),
                html: stale_record_html,
                tag_ids: vec![],
                default_code_language: None,
            })
            .unwrap();
        let stored_record_html = database
            .conn
            .query_row(
                "SELECT content_html FROM notes WHERE id = ?1",
                [record.id],
                |row| row.get::<_, String>(0),
            )
            .unwrap();

        assert!(!stored_record_html.contains(&project.root_path));
        assert!(
            stored_record_html.contains(".project-mind/embedded-note-assets/project/shared.png")
        );
        assert!(resaved.content_html.contains(&moved_image.managed_path));
        assert!(!resaved.content_html.contains(&image.managed_path));
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
                content: "Workspace target".to_string(),
                priority: "not_urgent_important".to_string(),
                due_date: None,
                tag_ids: Vec::new(),
            })
            .unwrap();
        let other_todo = create_todo(
            &mut database,
            other_project.id,
            "Other Project target",
            "not_urgent_important",
        );

        let workspace_reference = format!("[[todo:{}|Workspace target]]", workspace_todo.id);
        let other_project_reference = format!("[[todo:{}|Other Project target]]", other_todo.id);

        let workspace_with_reference = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Workspace,
                project_id: None,
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
    fn workspace_rich_text_assets_are_stored_relative_and_returned_resolved() {
        let (_harness, mut database) = setup_database();
        let image = database
            .workspace_clipboard_note_image_import(WorkspaceClipboardNoteImageImportInput {
                file_name: "workspace-note.png".to_string(),
                mime_type: "image/png".to_string(),
                data_base64: STANDARD.encode("workspace-note-image"),
            })
            .unwrap();
        let html = format!(
            r#"<p><img src="asset://old" data-path="{}" data-mime-type="image/png"></p>"#,
            image.path,
        );

        let quick_note = database
            .workspace_quick_note_upsert(WorkspaceQuickNoteUpsertInput {
                markdown: "[图片]".to_string(),
                html: html.clone(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        let record = database
            .workspace_record_upsert(WorkspaceRecordUpsertInput {
                note_id: None,
                title: Some("带图 Workspace Record".to_string()),
                markdown: "[图片]".to_string(),
                html,
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        let stored = database
            .conn
            .prepare("SELECT content_html FROM workspace_notes ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();

        assert_eq!(stored.len(), 2);
        for stored_html in stored {
            assert!(stored_html.contains(
                r#"data-path=".project-mind/embedded-note-assets/workspace/workspace-note.png""#
            ));
            assert!(!stored_html.contains(&image.path));
        }
        assert!(quick_note.content_html.contains(&image.path));
        assert!(record.content_html.contains(&image.path));
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
                source_path: source_path.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: Some(vec![draft_tag.id, review_tag.id]),
            })
            .unwrap();

        let updated = database
            .document_update_meta(DocumentUpdateMetaInput {
                document_id: document.id,
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
    fn persisted_attachment_with_legacy_data_href_uses_a_relative_path() {
        let base_path = Path::new("/workspace/Project");
        let managed_path = base_path.join(".project-mind/embedded-note-assets/brief.pdf");
        let document_paths = HashMap::from([(42, managed_path)]);
        let html = r#"<div data-type="attachment" data-title="brief.pdf" data-href="file:///workspace/Project/.project-mind/embedded-note-assets/brief.pdf" data-document-id="42"><a href="file:///workspace/Project/.project-mind/embedded-note-assets/brief.pdf">brief.pdf</a></div>"#;

        let persisted = persist_rich_text_asset_paths(html, base_path, &document_paths);

        assert_eq!(
            persisted,
            r#"<div data-type="attachment" data-title="brief.pdf" data-href=".project-mind/embedded-note-assets/brief.pdf" data-document-id="42"><a href=".project-mind/embedded-note-assets/brief.pdf">brief.pdf</a></div>"#
        );
    }

    #[test]
    fn persisted_image_without_data_path_uses_its_document_relative_path() {
        let base_path = Path::new("/workspace/Project");
        let managed_path = base_path.join(".project-mind/embedded-note-assets/clip.png");
        let document_paths = HashMap::from([(18, managed_path)]);
        let html = r#"<p><img src="asset:///workspace/Project/.project-mind/embedded-note-assets/clip.png" data-document-id="18" alt="截图" /></p>"#;

        let persisted = persist_rich_text_asset_paths(html, base_path, &document_paths);

        assert_eq!(
            persisted,
            r#"<p><img src=".project-mind/embedded-note-assets/clip.png" data-document-id="18" alt="截图" /></p>"#
        );
    }

    #[test]
    fn persisted_remote_attachment_url_is_not_treated_as_a_filesystem_path() {
        let base_path = Path::new("/workspace/Project");
        let html = r#"<div data-type="attachment" data-title="brief.pdf" data-href="https://example.com/brief.pdf"><a href="https://example.com/brief.pdf">brief.pdf</a></div>"#;

        let persisted = persist_rich_text_asset_paths(html, base_path, &HashMap::new());

        assert_eq!(persisted, html);
    }

    #[test]
    fn persisted_remote_attachment_replaces_a_stale_local_nested_href() {
        let base_path = Path::new("/workspace/Project");
        let html = r#"<div data-type="attachment" data-title="brief.pdf" data-href="https://example.com/brief.pdf"><a href="file:///Users/alex/brief.pdf">brief.pdf</a></div>"#;

        let persisted = persist_rich_text_asset_paths(html, base_path, &HashMap::new());

        assert_eq!(
            persisted,
            r#"<div data-type="attachment" data-title="brief.pdf" data-href="https://example.com/brief.pdf"><a href="https://example.com/brief.pdf">brief.pdf</a></div>"#
        );
    }

    #[test]
    fn persisted_tags_sanitize_every_local_path_attribute() {
        let base_path = Path::new("/workspace/Project");
        let html = concat!(
            r#"<p><a href="file:///Users/alex/private.txt">private</a></p>"#,
            r#"<p><img data-path="https://example.com/image.png" src="asset:///Users/alex/private.png"></p>"#,
        );

        let persisted = persist_rich_text_asset_paths(html, base_path, &HashMap::new());

        assert!(!persisted.contains("file:///"));
        assert!(!persisted.contains("asset:///"));
        assert!(persisted.contains(r#"<a href="">private</a>"#));
        assert!(persisted.contains(
            r#"<img data-path="https://example.com/image.png" src="https://example.com/image.png">"#
        ));
    }

    #[test]
    fn persisted_tags_sanitize_case_insensitive_unquoted_local_paths() {
        let base_path = Path::new("/workspace/Project");
        let html = r#"<P><A HREF=file:///Users/alex/private.txt>private</A></P>"#;

        let persisted = persist_rich_text_asset_paths(html, base_path, &HashMap::new());

        assert_eq!(persisted, r#"<P><A HREF=>private</A></P>"#);
    }

    #[test]
    fn persisted_tags_reject_relative_paths_that_escape_the_scope() {
        let base_path = Path::new("/workspace/Project");
        let html =
            r#"<p><a href="../outside.pdf">outside</a><img src="images/../outside.png"></p>"#;

        let persisted = persist_rich_text_asset_paths(html, base_path, &HashMap::new());

        assert_eq!(persisted, r#"<p><a href="">outside</a><img src=""></p>"#);
    }

    #[test]
    fn persisted_asset_from_another_workspace_is_not_rebound_to_the_current_workspace() {
        let base_path = Path::new("/workspace/Project");
        let html = r#"<p><img src="asset:///other/.project-mind/embedded-note-assets/project/clip.png" data-path="/other/.project-mind/embedded-note-assets/project/clip.png" alt="截图" /></p>"#;

        let persisted = persist_rich_text_asset_paths(html, base_path, &HashMap::new());

        assert!(persisted.contains(r#"data-path="""#));
        assert!(!persisted.contains("/other/"));
        assert!(!persisted.contains(".project-mind/embedded-note-assets/project/clip.png"));
    }

    #[test]
    fn legacy_domain_migration_preserves_source_rows_and_is_idempotent() {
        let (harness, mut database) = setup_database();
        enable_legacy_domain_fixture_schema(&database);
        let db_path = harness.root.join("app.sqlite3");
        let project = create_project(&mut database, &harness.workspace_root);
        let legacy_created_at = "2025-01-02T03:04:05.000Z";
        let legacy_updated_at = "2025-02-03T04:05:06.000Z";
        database
            .conn
            .execute(
                r#"
            INSERT INTO activities (
              project_id, category, title, brief_markdown, brief_html, folder_name,
              activity_time, created_at, updated_at
            ) VALUES (?1, 'legacy', '历史条目', '旧简报正文', '<p>旧简报正文</p>',
              'legacy-entry', ?2, ?2, ?3)
            "#,
                params![project.id, legacy_created_at, legacy_updated_at],
            )
            .unwrap();
        let legacy_activity_id = database.conn.last_insert_rowid();

        // Released schema v13 already converted Activity Briefs. Schema v21 must recognize that
        // Record instead of creating a duplicate, while still migrating legacy rows created later.
        let v13_tag_id = database
            .upsert_project_tag_by_label(
                project.id,
                "来源: 历史条目",
                DEFAULT_RECORD_TYPE_COLOR_KEY,
                legacy_created_at,
            )
            .unwrap();
        let v13_brief_record = database
            .project_record_upsert(ProjectRecordUpsertInput {
                project_id: project.id,
                note_id: None,
                title: Some("历史条目".to_string()),
                markdown: "旧简报正文".to_string(),
                html: "<p>旧简报正文</p>".to_string(),
                tag_ids: vec![v13_tag_id],
                default_code_language: None,
            })
            .unwrap();
        database
            .conn
            .execute(
                "UPDATE notes SET created_at = ?1, updated_at = ?1 WHERE id = ?2",
                params![legacy_created_at, v13_brief_record.id],
            )
            .unwrap();

        let linked_record = database
            .project_record_upsert(ProjectRecordUpsertInput {
                project_id: project.id,
                note_id: None,
                title: Some("已有记录".to_string()),
                markdown: "已有记录正文".to_string(),
                html: "<p>已有记录正文</p>".to_string(),
                tag_ids: vec![],
                default_code_language: None,
            })
            .unwrap();
        let linked_todo = database
            .todo_create(TodoCreateInput {
                scope: TodoScope::Project,
                project_id: Some(project.id),
                content: "已有 Todo".to_string(),
                priority: "not_urgent_important".to_string(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
        let source_path = harness.root.join("legacy.pdf");
        fs::write(&source_path, b"legacy-document").unwrap();
        let linked_document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                source_path: source_path.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        database
            .conn
            .execute(
                "UPDATE notes SET activity_id = ?1 WHERE id = ?2",
                params![legacy_activity_id, linked_record.id],
            )
            .unwrap();
        database
            .conn
            .execute(
                "UPDATE todos SET activity_id = ?1 WHERE id = ?2",
                params![legacy_activity_id, linked_todo.id],
            )
            .unwrap();
        database
            .conn
            .execute(
                "UPDATE documents SET activity_id = ?1 WHERE id = ?2",
                params![legacy_activity_id, linked_document.id],
            )
            .unwrap();
        database
            .conn
            .execute(
                r#"
            INSERT INTO conclusions (
              project_id, activity_id, note_id, content_markdown, content_html, content,
              created_at, updated_at
            ) VALUES (?1, ?2, ?3, '旧结论正文', '<p>旧结论正文</p>', '旧结论正文', ?4, ?5)
            "#,
                params![
                    project.id,
                    legacy_activity_id,
                    linked_record.id,
                    legacy_created_at,
                    legacy_updated_at,
                ],
            )
            .unwrap();
        let legacy_conclusion_id = database.conn.last_insert_rowid();
        database
            .set_schema_version(RICH_TEXT_RELATIVE_ASSET_PATH_SCHEMA_VERSION)
            .unwrap();
        drop(database);

        let mut reopened = Database::open(
            &db_path,
            &harness.workspace_root,
            Some("test-secret".to_string()),
        )
        .unwrap();

        let activity_source: (String, String, String) = reopened
            .conn
            .query_row(
                "SELECT brief_markdown, created_at, updated_at FROM activities WHERE id = ?1",
                [legacy_activity_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            activity_source,
            (
                "旧简报正文".to_string(),
                legacy_created_at.to_string(),
                legacy_updated_at.to_string(),
            )
        );
        let conclusion_source: (String, Option<i64>) = reopened
            .conn
            .query_row(
                "SELECT content_markdown, activity_id FROM conclusions WHERE id = ?1",
                [legacy_conclusion_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            conclusion_source,
            ("旧结论正文".to_string(), Some(legacy_activity_id))
        );
        for (table, id) in [
            ("notes", linked_record.id),
            ("todos", linked_todo.id),
            ("documents", linked_document.id),
        ] {
            let activity_id: Option<i64> = reopened
                .conn
                .query_row(
                    &format!("SELECT activity_id FROM {table} WHERE id = ?1"),
                    [id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(activity_id, Some(legacy_activity_id));
        }

        let migrated_records: Vec<(String, String, String, String)> = {
            let mut stmt = reopened
                .conn
                .prepare(
                    r#"
                SELECT migration.legacy_kind, note.title, note.content_markdown, note.updated_at
                FROM legacy_domain_record_migrations migration
                INNER JOIN notes note ON note.id = migration.record_id
                ORDER BY migration.legacy_kind
                "#,
                )
                .unwrap();
            stmt.query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
        };
        assert_eq!(migrated_records.len(), 2);
        assert!(migrated_records
            .iter()
            .any(
                |(kind, title, markdown, updated_at)| kind == "activity_brief"
                    && title == "历史条目"
                    && markdown == "旧简报正文"
                    && updated_at == legacy_created_at
            ));
        assert!(migrated_records
            .iter()
            .any(|(kind, title, markdown, updated_at)| kind == "conclusion"
                && title == "迁移的旧结论：历史条目"
                && markdown == "旧结论正文"
                && updated_at == legacy_updated_at));
        let mapped_brief_record_id: i64 = reopened
            .conn
            .query_row(
                "SELECT record_id FROM legacy_domain_record_migrations WHERE legacy_kind = 'activity_brief' AND legacy_id = ?1",
                [legacy_activity_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(mapped_brief_record_id, v13_brief_record.id);

        let before_repeat: i64 = reopened
            .conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE project_id = ?1",
                [project.id],
                |row| row.get(0),
            )
            .unwrap();
        reopened.migrate_legacy_domain_records(true).unwrap();
        let after_repeat: i64 = reopened
            .conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE project_id = ?1",
                [project.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(before_repeat, 3);
        assert_eq!(after_repeat, before_repeat);

        let search_results = reopened
            .workspace_search(WorkspaceSearchInput {
                query: "旧结论正文".to_string(),
                include_archived: None,
                project_id: None,
            })
            .unwrap();
        assert!(search_results.iter().any(|result| result.kind == "note"));
        assert!(search_results
            .iter()
            .all(|result| !matches!(result.kind.as_str(), "activity" | "conclusion")));
    }

    #[test]
    fn opening_legacy_workspace_accepts_long_activity_titles() {
        let (harness, mut database) = setup_database();
        enable_legacy_domain_fixture_schema(&database);
        let db_path = harness.root.join("app.sqlite3");
        let project = create_project(&mut database, &harness.workspace_root);
        let long_title =
            "这是一个超过三十二个字符但在旧版中完全合法的 Activity 标题，用来复现升级失败";
        database
            .conn
            .execute(
                r#"
                INSERT INTO activities (
                  project_id, category, title, brief_markdown, brief_html, folder_name,
                  activity_time, created_at, updated_at
                ) VALUES (?1, 'legacy', ?2, '旧简报正文', '<p>旧简报正文</p>',
                  'long-title', ?3, ?3, ?3)
                "#,
                params![project.id, long_title, "2025-03-04T05:06:07.000Z"],
            )
            .unwrap();
        let legacy_activity_id = database.conn.last_insert_rowid();
        database
            .set_schema_version(RICH_TEXT_RELATIVE_ASSET_PATH_SCHEMA_VERSION)
            .unwrap();
        drop(database);

        let reopened = Database::open(&db_path, &harness.workspace_root, None).unwrap();
        let migrated_tag: String = reopened
            .conn
            .query_row(
                "SELECT label FROM file_tag_options WHERE project_id = ?1",
                [project.id],
                |row| row.get(0),
            )
            .unwrap();

        assert!(migrated_tag.chars().count() <= TAG_LABEL_MAX_CHARS);
        assert!(migrated_tag.contains(&format!("#{legacy_activity_id}")));
        let preserved_activity_title: String = reopened
            .conn
            .query_row(
                "SELECT title FROM activities WHERE id = ?1",
                [legacy_activity_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(preserved_activity_title, long_title);
        let migrated_record_title: String = reopened
            .conn
            .query_row(
                "SELECT title FROM notes WHERE project_id = ?1",
                [project.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(migrated_record_title, long_title);
    }

    #[test]
    fn legacy_domain_migration_rolls_back_partial_records_before_retry() {
        let (harness, mut database) = setup_database();
        enable_legacy_domain_fixture_schema(&database);
        let db_path = harness.root.join("app.sqlite3");
        let project = create_project(&mut database, &harness.workspace_root);
        database
            .conn
            .execute(
                r#"
                INSERT INTO activities (
                  project_id, category, title, brief_markdown, brief_html, folder_name,
                  activity_time, created_at, updated_at
                ) VALUES (?1, 'legacy', '原子迁移', '必须只生成一次', '<p>必须只生成一次</p>',
                  'atomic-migration', ?2, ?2, ?2)
                "#,
                params![project.id, "2025-03-04T05:06:07.000Z"],
            )
            .unwrap();
        database
            .conn
            .execute_batch(
                r#"
                CREATE TRIGGER fail_legacy_mapping
                BEFORE INSERT ON legacy_domain_record_migrations
                BEGIN
                  SELECT RAISE(ABORT, 'injected mapping failure');
                END;
                PRAGMA user_version = 20;
                "#,
            )
            .unwrap();
        drop(database);

        assert!(Database::open(&db_path, &harness.workspace_root, None).is_err());

        let raw = Connection::open(&db_path).unwrap();
        let note_count: i64 = raw
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .unwrap();
        let mapping_count: i64 = raw
            .query_row(
                "SELECT COUNT(*) FROM legacy_domain_record_migrations",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let migrated_tag_count: i64 = raw
            .query_row(
                "SELECT COUNT(*) FROM file_tag_options WHERE label LIKE '来源: 旧 Activity %'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((note_count, mapping_count, migrated_tag_count), (0, 0, 0));
        raw.execute("DROP TRIGGER fail_legacy_mapping", []).unwrap();
        drop(raw);

        let reopened = Database::open(&db_path, &harness.workspace_root, None).unwrap();
        let migrated: (i64, i64) = reopened
            .conn
            .query_row(
                r#"
                SELECT
                  (SELECT COUNT(*) FROM notes WHERE project_id = ?1),
                  (SELECT COUNT(*) FROM legacy_domain_record_migrations)
                "#,
                [project.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(migrated, (1, 1));
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
    if normalized.chars().count() > TAG_LABEL_MAX_CHARS {
        return Err(anyhow!("file tag label must be 32 characters or fewer"));
    }
    Ok(normalized.to_string())
}

fn legacy_activity_source_tag_label(activity_id: i64, display_title: &str) -> String {
    let identity = format!("来源: 旧 Activity #{activity_id}");
    let identity_len = identity.chars().count();
    if identity_len >= TAG_LABEL_MAX_CHARS {
        return format!("旧Activity#{activity_id}");
    }

    let separator = " · ";
    let title_budget = TAG_LABEL_MAX_CHARS.saturating_sub(identity_len + separator.chars().count());
    let truncated_title = display_title.chars().take(title_budget).collect::<String>();
    if truncated_title.is_empty() {
        identity
    } else {
        format!("{identity}{separator}{truncated_title}")
    }
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

    if capability == "default" || capability == "image_default" {
        if input.use_default {
            return Err(anyhow!(
                "an AI default role cannot inherit from another role"
            ));
        }
        if input.profile_id.is_none() {
            return Err(anyhow!("an AI default role must choose a profile"));
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
            show_in_image_menu: false,
            profile_id: None,
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
            show_in_image_menu: false,
            profile_id: None,
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
            show_in_image_menu: false,
            profile_id: None,
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
            show_in_image_menu: false,
            profile_id: None,
            sort_order: 4,
            enabled: true,
            created_at: now.clone(),
            updated_at: now,
        },
        default_image_text_extraction_skill(5),
    ]
}

fn default_image_text_extraction_skill(sort_order: i64) -> AiEditorSkillRecord {
    let now = now_iso();
    AiEditorSkillRecord {
        id: "extract-image-text".to_string(),
        name: "文字提取".to_string(),
        icon: Some("🔤".to_string()),
        description: Some("尽量提取图片中的文字并整理为易读正文。".to_string()),
        prompt: "尽量完整提取图片中可见的文字，结合版面关系做合理纠错并整理为易读的 Markdown。不要翻译、解释或摘要；无法辨认的内容请明确标记。".to_string(),
        result_mode: "modify".to_string(),
        show_in_text_menu: false,
        show_in_image_menu: true,
        profile_id: None,
        sort_order,
        enabled: true,
        created_at: now.clone(),
        updated_at: now,
    }
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
        "auto" => Ok("auto".to_string()),
        _ => Err(anyhow!(
            "AI editor skill result mode must be modify, answer, or auto"
        )),
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

fn normalize_ai_editor_skill_markdown(value: &str) -> String {
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
