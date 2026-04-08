use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use serde_json::{json, Value};

use crate::{
    ai_provider::{self, ResolvedAiProfile},
    models::{
        AcceptedSuggestionResult, ActivityAttributeOption, ActivityAttributeOptionUpsertInput,
        ActivityCardData, ActivityCreateInput, ActivityDigest, ActivityOptionDeleteInput,
        ActivitySettingsSnapshot, ActivityStatusOption, ActivityStatusOptionUpsertInput,
        ActivityUpdateMetaInput, AiAcceptSuggestionInput, AiCapabilityBindingRecord,
        AiCapabilityBindingUpsertInput, AiGenerateInput, AiProfileTestInput, AiProfileTestResult,
        AiProviderProfileDeleteInput, AiProviderProfileRecord, AiProviderProfileUpsertInput,
        AiSettingsSnapshot, AiSuggestionRecord, ConclusionCreateInput, ConclusionGroup,
        ConclusionListInput, ConclusionRecord, ConclusionUpdateInput, DocumentAddVersionInput,
        DocumentImportInput, DocumentListVersionsInput, DocumentRecord, DocumentRelocateInput,
        DocumentTagRecord, DocumentUpdateMetaInput, DocumentVersionRecord, FileTagOptionDeleteInput,
        FileTagOptionUpsertInput, FileTagRecord, FileTagSettingsSnapshot, NoteRecord,
        NoteUpsertInput, ProjectArchiveInput, ProjectCreateInput, ProjectDashboard, ProjectIdInput,
        ProjectListItem, ProjectOverviewData, ProjectRecord, ProjectUpdateSummaryInput,
        ProjectsListInput, RecordTypeOptionDeleteInput, RecordTypeOptionUpsertInput,
        RecordTypeRecord, RecordTypeSettingsSnapshot, RichTextStyleBlockSettings,
        RichTextStyleSettings, RichTextStyleUpsertInput, TodoAddProgressInput, TodoCreateInput,
        TodoProgressRecord, TodoRecord, TodoUpdateContentInput, TodoUpdatePriorityInput,
        TodoUpdateStatusInput, WorkspaceSearchInput, WorkspaceSearchResult,
    },
    secret_crypto,
};

const TODO_SCHEMA_VERSION: i64 = 2;
const FILE_LAYOUT_SCHEMA_VERSION: i64 = 3;
const DOCUMENT_SCHEMA_VERSION: i64 = 4;
const ACTIVITY_SETTINGS_SCHEMA_VERSION: i64 = 5;
const FILE_TAG_SCHEMA_VERSION: i64 = 6;
const ACTIVITY_ATTRIBUTE_COLOR_SCHEMA_VERSION: i64 = 7;
const ACTIVITY_STATUS_COLOR_SCHEMA_VERSION: i64 = 8;
const RECORD_TYPE_SCHEMA_VERSION: i64 = 8;
const LEGACY_FILE_LAYOUT_VERSION: i64 = 1;
const CURRENT_FILE_LAYOUT_VERSION: i64 = 2;
const AI_CAPABILITIES: [&str; 4] = ["default", "assistant", "summary", "suggestion_generation"];
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
const DEFAULT_RECORD_TYPE_KEY: &str = "quick_note";
const DEFAULT_RECORD_TYPE_LABEL: &str = "原始记录";
const DEFAULT_RECORD_TYPE_COLOR_KEY: &str = "slate";
const DEFAULT_RECORD_TYPE_TEMPLATE_HTML: &str = "<p></p>";
const MEETING_RECORD_TYPE_KEY: &str = "meeting_minutes";
const MEETING_RECORD_TYPE_LABEL: &str = "会议记录";
const MEETING_RECORD_TYPE_COLOR_KEY: &str = "blue";
const MEETING_RECORD_TYPE_TEMPLATE_HTML: &str =
    "<h2>背景</h2><p></p><h2>讨论要点</h2><p></p><h2>初步结论</h2><p></p><h2>行动项</h2><p></p>";
const SYSTEM_ACTIVITY_STATUS_PENDING: &str = "pending";
const SYSTEM_ACTIVITY_STATUS_PENDING_LABEL: &str = "待启动";
const LEGACY_ACTIVITY_STATUS_REVIEW_LABEL: &str = "待复核";
const LEGACY_ACTIVITY_STATUS_ORGANIZED_LABEL: &str = "已整理";
const DEFAULT_ACTIVITY_ATTRIBUTE_COLOR_KEY: &str = "slate";
const DEFAULT_ACTIVITY_STATUS_COLOR_KEY: &str = "amber";
const LEGACY_ACTIVITY_STATUS_REVIEW_COLOR_KEY: &str = "orange";
const LEGACY_ACTIVITY_STATUS_ORGANIZED_COLOR_KEY: &str = "green";

pub struct Database {
    conn: Connection,
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

impl Database {
    pub fn open(db_path: &Path) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!("failed to create app data dir at {}", parent.display())
            })?;
        }

        let conn = Connection::open(db_path)
            .with_context(|| format!("failed to open sqlite at {}", db_path.display()))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let mut db = Self { conn };
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
              file_layout_version INTEGER NOT NULL DEFAULT 1,
              summary TEXT NOT NULL DEFAULT '',
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

            CREATE TABLE IF NOT EXISTS conclusions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_id INTEGER NOT NULL,
              activity_id INTEGER,
              note_id INTEGER,
              content_markdown TEXT NOT NULL DEFAULT '',
              content_html TEXT NOT NULL DEFAULT '',
              content TEXT NOT NULL,
              promoted_to_project INTEGER NOT NULL DEFAULT 0,
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
            "file_layout_version",
            "ALTER TABLE projects ADD COLUMN file_layout_version INTEGER NOT NULL DEFAULT 1",
        )?;
        self.ensure_column(
            "activities",
            "folder_name",
            "ALTER TABLE activities ADD COLUMN folder_name TEXT NOT NULL DEFAULT ''",
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
            "#,
        )?;
        self.backfill_file_layout_metadata()?;
        Ok(())
    }

    pub fn projects_list(&mut self, input: ProjectsListInput) -> Result<Vec<ProjectListItem>> {
        let include_archived = input.include_archived.unwrap_or(false);
        let sql = format!(
            r#"
            SELECT
              p.id, p.name, p.status, p.root_path, p.file_layout_version, p.summary, p.is_archived, p.created_at, p.updated_at,
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
            Ok(ProjectListItem {
                id: row.get(0)?,
                name: row.get(1)?,
                status: row.get(2)?,
                root_path: row.get(3)?,
                file_layout_version: row.get(4)?,
                summary: row.get(5)?,
                is_archived: int_to_bool(row.get::<_, i64>(6)?),
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
                activity_count: row.get(9)?,
                unorganized_count: row.get(10)?,
                open_todo_count: row.get(11)?,
            })
        })?;

        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn project_create(&mut self, input: ProjectCreateInput) -> Result<ProjectRecord> {
        let timestamp = now_iso();
        let base = PathBuf::from(input.workspace_root.trim());
        if !base.exists() {
            return Err(anyhow!("workspace root does not exist"));
        }

        let project_name = input.name.trim();
        if project_name.is_empty() {
            return Err(anyhow!("project name is required"));
        }

        let project_dir_name = normalize_windows_safe_component(project_name);
        if project_dir_name.is_empty() {
            return Err(anyhow!("project name must contain at least one usable character"));
        }

        let project_dir = base.join(project_dir_name);
        if project_dir.exists() {
            return Err(anyhow!(
                "project folder already exists at {}",
                project_dir.display()
            ));
        }
        fs::create_dir_all(&project_dir)?;

        self.conn.execute(
            r#"
            INSERT INTO projects (name, status, root_path, file_layout_version, summary, is_archived, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7)
            "#,
            params![
                project_name,
                input.status.unwrap_or_else(|| "active".to_string()),
                project_dir.to_string_lossy().to_string(),
                CURRENT_FILE_LAYOUT_VERSION,
                input.summary.unwrap_or_default(),
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
            None => current.name,
        };
        self.conn.execute(
            "UPDATE projects SET name = ?1, summary = ?2, status = ?3, updated_at = ?4 WHERE id = ?5",
            params![
                project_name,
                input.summary,
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

    pub fn activity_create(&mut self, input: ActivityCreateInput) -> Result<ActivityCardData> {
        self.ensure_project_file_layout(input.project_id)?;
        let timestamp = now_iso();
        let activity_title = input.title.unwrap_or_default();
        let attribute_option = match input.attribute_option_id {
            Some(option_id) => Some(self.activity_attribute_option_record(option_id)?),
            None => None,
        };
        let pending_status = self.pending_activity_status_option()?;
        self.conn.execute(
            r#"
            INSERT INTO activities (
              project_id, category, attribute_option_id, title, folder_name, activity_time, is_pinned,
              is_expanded, organize_status, status_option_id, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, '', ?5, 0, 0, ?6, NULL, ?7, ?8)
            "#,
            params![
                input.project_id,
                attribute_option
                    .as_ref()
                    .map(|option| option.label.as_str())
                    .unwrap_or(""),
                input.attribute_option_id,
                activity_title,
                input.activity_time,
                legacy_organize_status_for_system(pending_status.is_system),
                timestamp,
                timestamp
            ],
        )?;
        let activity_id = self.conn.last_insert_rowid();
        let project = self.project_record(input.project_id)?;
        let folder_name = self.default_activity_folder_name(&activity_title, activity_id);
        self.create_activity_directory(&project.root_path, &folder_name)?;
        self.conn.execute(
            "UPDATE activities SET folder_name = ?1 WHERE id = ?2",
            params![folder_name, activity_id],
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
        let next_title = input.title.unwrap_or_else(|| current.title.clone());
        let next_activity_time = input
            .activity_time
            .unwrap_or_else(|| current.activity_time.clone());
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
                category = ?2,
                attribute_option_id = ?3,
                activity_time = ?4,
                is_pinned = ?5,
                is_expanded = ?6,
                organize_status = ?7,
                status_option_id = ?8,
                updated_at = ?9
            WHERE id = ?10
            "#,
            params![
                next_title,
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
        self.touch_project(current.project_id)?;
        self.activity_card(input.activity_id)
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

    pub fn file_tag_option_upsert(&mut self, input: FileTagOptionUpsertInput) -> Result<FileTagRecord> {
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
        self.conn
            .execute("DELETE FROM file_tag_options WHERE id = ?1", params![input.tag_id])?;
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

    pub fn conclusion_create(&mut self, input: ConclusionCreateInput) -> Result<ConclusionRecord> {
        let timestamp = now_iso();
        self.conn.execute(
            r#"
            INSERT INTO conclusions (
              project_id, activity_id, note_id, content_markdown, content_html, content, promoted_to_project, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                input.project_id,
                input.activity_id,
                input.note_id,
                input.markdown,
                input.html,
                input.markdown,
                bool_to_int(input.promoted_to_project),
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
                ORDER BY updated_at DESC
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
                updated_at = ?5
            WHERE id = ?6
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
                source.to_string_lossy().to_string(),
                managed_path.to_string_lossy().to_string(),
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
            params![history_dir.to_string_lossy().to_string(), id],
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
                source.to_string_lossy().to_string(),
                managed_path.to_string_lossy().to_string(),
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
                new_source.to_string_lossy().to_string(),
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
                new_source.to_string_lossy().to_string(),
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
        let source = PathBuf::from(&input.source_path);
        if !source.exists() {
            return Err(anyhow!("version source file does not exist"));
        }

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

        if source == current_path {
            return Err(anyhow!(
                "cannot add a version from the current managed file"
            ));
        }
        if next_path.exists() && next_path != source {
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

        let storage_mode = match self.materialize_file_for_target(
            Path::new(&project.root_path),
            &source,
            &next_path,
        ) {
            Ok(storage_mode) => storage_mode,
            Err(error) => {
                let _ = fs::rename(&previous_history_path, &current_path);
                return Err(error);
            }
        };

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
                source.to_string_lossy().to_string(),
                next_path.to_string_lossy().to_string(),
                storage_mode,
                next_version_number,
                current.version_count + 1,
                timestamp,
                input.document_id
            ],
        )?;
        self.conn.execute(
            r#"
            UPDATE document_versions
            SET name = ?1, managed_path = ?2
            WHERE document_id = ?3 AND version_number = ?4
            "#,
            params![
                previous_version_name,
                previous_history_path.to_string_lossy().to_string(),
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
                source.to_string_lossy().to_string(),
                next_path.to_string_lossy().to_string(),
                timestamp
            ],
        )?;

        self.touch_project(current.project_id)?;
        if let Some(activity_id) = current.activity_id {
            self.touch_activity(activity_id)?;
        }
        self.document_record(input.document_id)
    }

    pub fn ai_generate_note_suggestions(
        &mut self,
        input: AiGenerateInput,
    ) -> Result<Vec<AiSuggestionRecord>> {
        let (activity_title, source_text) =
            self.ai_source(input.project_id, input.activity_id, input.note_id)?;
        let profile = self.resolve_profile_for_capability("suggestion_generation")?;
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

        for content in payload.todos.iter().take(3) {
            self.insert_ai_suggestion(
                input.project_id,
                Some(input.activity_id),
                input.note_id,
                "todo",
                "待办候选",
                content,
                json!({
                    "content": content,
                    "priority": "not_urgent_important"
                }),
                &timestamp,
            )?;
        }

        self.fetch_ai_suggestions(Some(input.activity_id))
    }

    pub fn ai_accept_suggestion(
        &mut self,
        input: AiAcceptSuggestionInput,
    ) -> Result<AcceptedSuggestionResult> {
        let suggestion = self.ai_suggestion_record(input.suggestion_id)?;
        let timestamp = now_iso();

        let entity_kind;
        let entity_id;
        match suggestion.suggestion_type.as_str() {
            "activity_title" => {
                let proposed_title = suggestion
                    .payload
                    .get("proposedTitle")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("missing proposedTitle"))?;
                let activity_id = suggestion
                    .activity_id
                    .ok_or_else(|| anyhow!("title suggestion requires activity"))?;
                self.ensure_project_file_layout(suggestion.project_id)?;
                let current = self.activity_row(activity_id)?;
                self.rename_activity_folder(activity_id, &current, proposed_title, &timestamp)?;
                self.conn.execute(
                    "UPDATE activities SET title = ?1, updated_at = ?2 WHERE id = ?3",
                    params![proposed_title, timestamp, activity_id],
                )?;
                entity_kind = "activity".to_string();
                entity_id = activity_id;
            }
            "conclusion" => {
                let content = suggestion
                    .payload
                    .get("content")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("missing conclusion content"))?;
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
                            suggestion
                                .payload
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
                let content = suggestion
                    .payload
                    .get("content")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("missing todo content"))?;
                let priority = suggestion
                    .payload
                    .get("priority")
                    .and_then(Value::as_str)
                    .unwrap_or("not_urgent_important");
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

        self.conn.execute(
            "UPDATE ai_suggestions SET status = 'accepted', accepted_at = ?1 WHERE id = ?2",
            params![timestamp, input.suggestion_id],
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

    pub fn ai_settings_get(&mut self) -> Result<AiSettingsSnapshot> {
        let profiles = self.fetch_ai_profiles()?;
        let bindings = self.fetch_ai_bindings()?;

        Ok(AiSettingsSnapshot {
            has_usable_default: self.resolve_profile_for_capability("default").is_ok(),
            profiles,
            bindings,
            security_mode: "device_bound_encrypted".to_string(),
        })
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
            Some(api_key) => Some(secret_crypto::encrypt_secret(api_key)?),
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

        let mut results = Vec::new();

        let project_sql = format!(
            "SELECT p.id, p.name, p.summary FROM projects p WHERE (p.name LIKE ?1 OR p.summary LIKE ?1){} ORDER BY p.updated_at DESC LIMIT 5",
            project_filter
        );
        let mut stmt = self.conn.prepare(&project_sql)?;
        let rows = stmt.query_map([pattern.as_str()], |row| {
            Ok(WorkspaceSearchResult {
                kind: "project".to_string(),
                id: row.get(0)?,
                project_id: row.get(0)?,
                activity_id: None,
                title: row.get(1)?,
                subtitle: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                matched_text: query.to_string(),
            })
        })?;
        results.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);

        let activity_sql = format!(
            r#"
            SELECT a.id, a.project_id, a.title, COALESCE(ao.label, ''), p.name
            FROM activities a
            INNER JOIN projects p ON p.id = a.project_id
            LEFT JOIN activity_attribute_options ao ON ao.id = a.attribute_option_id
            WHERE (a.title LIKE ?1 OR COALESCE(ao.label, '') LIKE ?1 OR a.category LIKE ?1) {}
            ORDER BY a.updated_at DESC
            LIMIT 5
            "#,
            project_filter
        );
        let mut stmt = self.conn.prepare(&activity_sql)?;
        let rows = stmt.query_map([pattern.as_str()], |row| {
            let attribute_label: String = row.get(3)?;
            let project_name: String = row.get(4)?;
            Ok(WorkspaceSearchResult {
                kind: "activity".to_string(),
                id: row.get(0)?,
                project_id: row.get(1)?,
                activity_id: row.get(0)?,
                title: row.get(2)?,
                subtitle: if attribute_label.trim().is_empty() {
                    project_name
                } else {
                    format!("{} · {}", project_name, attribute_label)
                },
                matched_text: query.to_string(),
            })
        })?;
        results.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);

        let conclusion_sql = format!(
            r#"
            SELECT
              c.id,
              c.project_id,
              c.activity_id,
              COALESCE(NULLIF(c.content_markdown, ''), c.content),
              COALESCE(a.title, p.name)
            FROM conclusions c
            INNER JOIN projects p ON p.id = c.project_id
            LEFT JOIN activities a ON a.id = c.activity_id
            WHERE COALESCE(NULLIF(c.content_markdown, ''), c.content) LIKE ?1 {}
            ORDER BY c.updated_at DESC
            LIMIT 5
            "#,
            project_filter
        );
        let mut stmt = self.conn.prepare(&conclusion_sql)?;
        let rows = stmt.query_map([pattern.as_str()], |row| {
            let content: String = row.get(3)?;
            Ok(WorkspaceSearchResult {
                kind: "conclusion".to_string(),
                id: row.get(0)?,
                project_id: row.get(1)?,
                activity_id: row.get(2)?,
                title: truncate_text(&content, 72),
                subtitle: row.get::<_, String>(4)?,
                matched_text: query.to_string(),
            })
        })?;
        results.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);

        let todo_sql = format!(
            r#"
            SELECT t.id, t.project_id, t.activity_id, t.content, COALESCE(a.title, p.name)
            FROM todos t
            INNER JOIN projects p ON p.id = t.project_id
            LEFT JOIN activities a ON a.id = t.activity_id
            WHERE t.content LIKE ?1 {}
            ORDER BY t.updated_at DESC
            LIMIT 5
            "#,
            project_filter
        );
        let mut stmt = self.conn.prepare(&todo_sql)?;
        let rows = stmt.query_map([pattern.as_str()], |row| {
            let content: String = row.get(3)?;
            Ok(WorkspaceSearchResult {
                kind: "todo".to_string(),
                id: row.get(0)?,
                project_id: row.get(1)?,
                activity_id: row.get(2)?,
                title: truncate_text(&content, 72),
                subtitle: row.get::<_, String>(4)?,
                matched_text: query.to_string(),
            })
        })?;
        results.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);

        let document_sql = format!(
            r#"
            SELECT d.id, d.project_id, d.activity_id, d.name, COALESCE(a.title, p.name)
            FROM documents d
            INNER JOIN projects p ON p.id = d.project_id
            LEFT JOIN activities a ON a.id = d.activity_id
            WHERE d.name LIKE ?1 {}
            ORDER BY d.updated_at DESC
            LIMIT 5
            "#,
            project_filter
        );
        let mut stmt = self.conn.prepare(&document_sql)?;
        let rows = stmt.query_map([pattern.as_str()], |row| {
            Ok(WorkspaceSearchResult {
                kind: "document".to_string(),
                id: row.get(0)?,
                project_id: row.get(1)?,
                activity_id: row.get(2)?,
                title: row.get(3)?,
                subtitle: row.get(4)?,
                matched_text: query.to_string(),
            })
        })?;
        results.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);

        Ok(results)
    }

    fn project_record(&self, project_id: i64) -> Result<ProjectRecord> {
        self.conn
            .query_row(
                r#"
                SELECT id, name, status, root_path, file_layout_version, summary, is_archived, created_at, updated_at
                FROM projects WHERE id = ?1
                "#,
                [project_id],
                |row| {
                    Ok(ProjectRecord {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        status: row.get(2)?,
                        root_path: row.get(3)?,
                        file_layout_version: row.get(4)?,
                        summary: row.get(5)?,
                        is_archived: int_to_bool(row.get::<_, i64>(6)?),
                        created_at: row.get(7)?,
                        updated_at: row.get(8)?,
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
                  project_id, attribute_option_id, title, activity_time, status_option_id,
                  is_pinned, is_expanded, folder_name
                FROM activities WHERE id = ?1
                "#,
                [activity_id],
                |row| {
                    Ok(ActivityFsRecord {
                        project_id: row.get(0)?,
                        attribute_option_id: row.get(1)?,
                        title: row.get(2)?,
                        activity_time: row.get(3)?,
                        status_option_id: row.get(4)?,
                        is_pinned: int_to_bool(row.get::<_, i64>(5)?),
                        is_expanded: int_to_bool(row.get::<_, i64>(6)?),
                        folder_name: row.get(7)?,
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
                        source_activity_title: row.get(7)?,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
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
              t.id, t.project_id, t.activity_id, t.content, t.status, t.priority, t.created_at, t.updated_at
            FROM todos t
            WHERE t.id = ?1
            "#,
            [todo_id],
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
                ))
            },
        )?;
        let progresses = self.fetch_todo_progresses(todo_id)?;
        Ok(TodoRecord {
            id: base.0,
            project_id: base.1,
            activity_id: base.2,
            content: base.3,
            status: base.4,
            priority: base.5,
            created_at: base.6,
            updated_at: base.7,
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
            original_path: base.5,
            managed_path: base.6,
            history_dir_path: base.7,
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
            "SELECT id FROM conclusions WHERE activity_id = ?1 ORDER BY updated_at DESC",
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

    fn fetch_documents(&self, activity_id: i64) -> Result<Vec<DocumentRecord>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM documents WHERE activity_id = ?1 ORDER BY updated_at DESC")?;
        let ids = stmt
            .query_map([activity_id], |row| row.get::<_, i64>(0))?
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
            "SELECT id FROM documents WHERE project_id = ?1 AND is_starred = 1 ORDER BY updated_at DESC"
        } else {
            "SELECT id FROM documents WHERE project_id = ?1 ORDER BY updated_at DESC"
        };
        let mut stmt = self.conn.prepare(query)?;
        let ids = stmt
            .query_map([project_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().map(|id| self.document_record(id)).collect()
    }

    fn fetch_project_documents_for_project(&self, project_id: i64) -> Result<Vec<DocumentRecord>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id
            FROM documents
            WHERE project_id = ?1
              AND (activity_id IS NULL OR is_starred = 1)
            ORDER BY updated_at DESC
            LIMIT 18
            "#,
        )?;
        let ids = stmt
            .query_map([project_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().map(|id| self.document_record(id)).collect()
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
                    Ok(DocumentVersionRecord {
                        id: row.get(0)?,
                        document_id: row.get(1)?,
                        version_number: row.get(2)?,
                        name: row.get(3)?,
                        source_path: row.get(4)?,
                        managed_path: row.get(5)?,
                        created_at: row.get(6)?,
                    })
                },
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
            .query_row("SELECT COUNT(*) FROM record_type_options", [], |row| row.get(0))
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
            "UPDATE projects SET file_layout_version = ?1 WHERE file_layout_version < 1",
            params![LEGACY_FILE_LAYOUT_VERSION],
        )?;
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

    fn ensure_project_file_layout(&mut self, project_id: i64) -> Result<()> {
        let project = self.project_record(project_id)?;
        if project.file_layout_version >= CURRENT_FILE_LAYOUT_VERSION {
            return Ok(());
        }
        self.migrate_project_file_layout(&project)
    }

    fn migrate_project_file_layout(&mut self, project: &ProjectRecord) -> Result<()> {
        let project_root = PathBuf::from(&project.root_path);
        let legacy_documents_dir = project_root.join("documents");
        fs::create_dir_all(&project_root)?;

        let mut activity_stmt = self
            .conn
            .prepare("SELECT id, title FROM activities WHERE project_id = ?1 ORDER BY id ASC")?;
        let activities = activity_stmt
            .query_map([project.id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(activity_stmt);

        let mut seen_folders = HashSet::new();
        let mut activity_folders = Vec::new();
        for (activity_id, title) in activities {
            let folder_name = self.default_activity_folder_name(&title, activity_id);
            if !seen_folders.insert(folder_name.clone()) {
                return Err(anyhow!(
                    "legacy project migration failed because multiple activities map to the same folder name: {}",
                    folder_name
                ));
            }

            let activity_dir = project_root.join(&folder_name);
            if activity_dir.exists() {
                return Err(anyhow!(
                    "legacy project migration failed because target activity folder already exists: {}",
                    activity_dir.display()
                ));
            }

            activity_folders.push((activity_id, folder_name, activity_dir));
        }

        let mut document_stmt = self
            .conn
            .prepare("SELECT id FROM documents WHERE project_id = ?1 ORDER BY id ASC")?;
        let document_ids = document_stmt
            .query_map([project.id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(document_stmt);
        let documents = document_ids
            .into_iter()
            .map(|document_id| self.document_record(document_id))
            .collect::<Result<Vec<_>>>()?;

        let mut planned_targets = HashSet::new();
        let mut document_updates = Vec::new();
        for document in &documents {
            let target_dir = if let Some(activity_id) = document.activity_id {
                let (_, _, activity_dir) = activity_folders
                    .iter()
                    .find(|(candidate_id, _, _)| *candidate_id == activity_id)
                    .ok_or_else(|| {
                        anyhow!("activity for document {} was not found", document.id)
                    })?;
                activity_dir.clone()
            } else {
                project_root.clone()
            };
            let target_path = target_dir.join(&document.name);
            let current_path = PathBuf::from(&document.managed_path);
            if target_path.exists() && target_path != current_path {
                return Err(anyhow!(
                    "legacy project migration failed because target file already exists: {}",
                    target_path.display()
                ));
            }
            let target_key = target_path.to_string_lossy().to_string();
            if !planned_targets.insert(target_key.clone()) {
                return Err(anyhow!(
                    "legacy project migration failed because multiple documents would resolve to {}",
                    target_key
                ));
            }

            document_updates.push((
                document.clone(),
                target_path.clone(),
                self.history_dir_path_for(&target_path, document.id),
            ));
        }

        let mut created_dirs = Vec::new();
        for (_, _, activity_dir) in &activity_folders {
            fs::create_dir_all(activity_dir)?;
            created_dirs.push(activity_dir.clone());
        }

        let mut moved_files = Vec::new();
        for (document, target_path, _) in &document_updates {
            let current_path = PathBuf::from(&document.managed_path);
            if current_path.exists() && current_path != *target_path {
                if let Some(parent) = target_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                if let Err(error) = fs::rename(&current_path, target_path) {
                    for (from, to) in moved_files.iter().rev() {
                        let _ = fs::rename(to, from);
                    }
                    for created_dir in created_dirs.iter().rev() {
                        let _ = fs::remove_dir(created_dir);
                    }
                    return Err(anyhow!(
                        "legacy project migration failed while moving {} to {}: {}",
                        current_path.display(),
                        target_path.display(),
                        error
                    ));
                }
                moved_files.push((current_path, target_path.clone()));
            }
        }

        let timestamp = now_iso();
        let tx = self.conn.transaction()?;
        for (activity_id, folder_name, _) in &activity_folders {
            tx.execute(
                "UPDATE activities SET folder_name = ?1 WHERE id = ?2",
                params![folder_name, activity_id],
            )?;
        }
        for (document, target_path, history_dir) in &document_updates {
            tx.execute(
                r#"
                UPDATE documents
                SET name = ?1,
                    base_name = ?2,
                    managed_path = ?3,
                    history_dir_path = ?4,
                    current_version_number = 1,
                    version_count = 1
                WHERE id = ?5
                "#,
                params![
                    document.name,
                    document.name,
                    target_path.to_string_lossy().to_string(),
                    history_dir.to_string_lossy().to_string(),
                    document.id
                ],
            )?;
            tx.execute(
                "DELETE FROM document_versions WHERE document_id = ?1",
                params![document.id],
            )?;
            tx.execute(
                r#"
                INSERT INTO document_versions (
                  document_id, version_number, name, source_path, managed_path, created_at
                )
                VALUES (?1, 1, ?2, ?3, ?4, ?5)
                "#,
                params![
                    document.id,
                    document.name,
                    document.original_path,
                    target_path.to_string_lossy().to_string(),
                    document.created_at
                ],
            )?;
        }
        tx.execute(
            "UPDATE projects SET file_layout_version = ?1, updated_at = ?2 WHERE id = ?3",
            params![CURRENT_FILE_LAYOUT_VERSION, timestamp, project.id],
        )?;
        if let Err(error) = tx.commit() {
            for (from, to) in moved_files.iter().rev() {
                let _ = fs::rename(to, from);
            }
            for created_dir in created_dirs.iter().rev() {
                let _ = fs::remove_dir(created_dir);
            }
            return Err(error.into());
        }

        if legacy_documents_dir.exists() {
            let _ = fs::remove_dir(&legacy_documents_dir);
        }

        Ok(())
    }

    fn default_activity_folder_name(&self, title: &str, activity_id: i64) -> String {
        let raw = if title.trim().is_empty() {
            format!("未命名 Activity {}", activity_id)
        } else {
            title.trim().to_string()
        };

        let sanitized = normalize_windows_safe_component(&raw);

        if sanitized.is_empty() {
            normalize_windows_safe_component(&format!("未命名 Activity {}", activity_id))
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

    fn ensure_document_name_available(
        &self,
        project_id: i64,
        activity_id: Option<i64>,
        base_name: &str,
        exclude_document_id: Option<i64>,
    ) -> Result<()> {
        let duplicate = self
            .conn
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
            .optional()?;

        if duplicate.is_some() {
            return Err(anyhow!(
                "a file named '{}' already exists in the target location; rename it or add a new version instead",
                base_name
            ));
        }

        Ok(())
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
                final_path,
            });
        }

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
                    next_current_path.to_string_lossy().to_string(),
                    next_history_dir.to_string_lossy().to_string(),
                    document.id
                ],
            )?;

            for plan in &plans {
                tx.execute(
                    "UPDATE document_versions SET name = ?1, managed_path = ?2 WHERE id = ?3",
                    params![
                        plan.final_name,
                        plan.final_path.to_string_lossy().to_string(),
                        plan.version_id
                    ],
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
            let (_, next_current_path, next_history_dir) = next_document_paths
                .iter()
                .find(|(document_id, _, _)| *document_id == document.id)
                .cloned()
                .ok_or_else(|| anyhow!("missing path update for document {}", document.id))?;
            tx.execute(
                "UPDATE documents SET managed_path = ?1, history_dir_path = ?2 WHERE id = ?3",
                params![
                    next_current_path.to_string_lossy().to_string(),
                    next_history_dir.to_string_lossy().to_string(),
                    document.id
                ],
            )?;
            let versions = document_versions
                .iter()
                .find(|(document_id, _)| *document_id == document.id)
                .map(|(_, versions)| versions.clone())
                .unwrap_or_default();
            for version in versions {
                let file_name = Path::new(&version.managed_path)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| version.name.clone());
                let next_version_path = if version.version_number == document.current_version_number
                {
                    next_dir.join(file_name)
                } else {
                    next_history_dir.join(file_name)
                };
                tx.execute(
                    "UPDATE document_versions SET managed_path = ?1 WHERE id = ?2",
                    params![next_version_path.to_string_lossy().to_string(), version.id],
                )?;
            }
        }

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
            "SELECT id FROM conclusions WHERE project_id = ?1 AND activity_id IS NULL ORDER BY updated_at DESC",
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
                "SELECT id FROM conclusions WHERE project_id = ?1 AND activity_id = ?2 ORDER BY updated_at DESC",
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
                activity_title: if activity_title.trim().is_empty() {
                    "Untitled Activity".to_string()
                } else {
                    activity_title
                },
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
              (SELECT COUNT(*) FROM documents d WHERE d.activity_id = a.id) AS document_count,
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
                    row.get::<_, i64>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    int_to_bool(row.get::<_, i64>(10)?),
                    int_to_bool(row.get::<_, i64>(11)?),
                    int_to_bool(row.get::<_, i64>(12)?),
                    row.get::<_, String>(13)?,
                    row.get::<_, String>(14)?,
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
            activity_time: base.6.clone(),
            status_option_id: base.7,
            status_label: base.8.clone(),
            status_color_key: base.9.clone(),
            status_needs_attention: base.10,
            is_pinned: base.11,
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
            activity_time: base.6,
            status_option_id: base.7,
            status_label: base.8,
            status_color_key: base.9,
            status_needs_attention: base.10,
            is_pinned: base.11,
            is_expanded: base.12,
            created_at: base.13,
            updated_at: base.14,
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
            "SELECT id FROM conclusions WHERE project_id = ?1 AND promoted_to_project = 1 ORDER BY updated_at DESC LIMIT 8"
        } else {
            "SELECT id FROM conclusions WHERE project_id = ?1 ORDER BY updated_at DESC"
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

        for (id, managed_path, health) in rows {
            let exists = Path::new(&managed_path).exists();
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
        self.touch_project(project_id)
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
            .or_else(|| rows.iter().find(|(_, _, is_default)| *is_default).map(|(id, _, _)| *id))
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

fn truncate_text(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{}...", truncated)
    } else {
        truncated
    }
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
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or(value);
    let extension = path.extension().and_then(|value| value.to_str());

    match extension {
        Some(extension) if !extension.is_empty() => format!("{stem}{suffix}.{extension}"),
        _ => format!("{stem}{suffix}"),
    }
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
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    struct TestHarness {
        root: PathBuf,
        workspace_root: PathBuf,
    }

    impl Drop for TestHarness {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn setup_database() -> (TestHarness, Database) {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("project-mind-db-test-{unique}"));
        let workspace_root = root.join("workspace");
        fs::create_dir_all(&workspace_root).unwrap();
        let database = Database::open(&root.join("app.sqlite3")).unwrap();

        (
            TestHarness {
                root,
                workspace_root,
            },
            database,
        )
    }

    fn create_project(database: &mut Database, workspace_root: &Path) -> ProjectRecord {
        database
            .project_create(ProjectCreateInput {
                name: "Alpha".to_string(),
                summary: None,
                status: None,
                workspace_root: workspace_root.to_string_lossy().to_string(),
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

    #[test]
    fn windows_safe_component_normalizes_reserved_names() {
        assert_eq!(normalize_windows_safe_component("CON"), "CON_");
        assert_eq!(normalize_windows_safe_component("NUL.txt"), "NUL_.txt");
        assert_eq!(normalize_windows_safe_component(" report. "), "report");
        assert_eq!(normalize_windows_safe_component("bad\u{0007}name"), "bad_name");
        assert_eq!(normalize_windows_safe_component(".env"), ".env");
    }

    #[test]
    fn project_create_uses_windows_safe_directory_name() {
        let (harness, mut database) = setup_database();
        let project = database
            .project_create(ProjectCreateInput {
                name: "CON".to_string(),
                summary: None,
                status: None,
                workspace_root: harness.workspace_root.to_string_lossy().to_string(),
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
    fn project_update_summary_can_rename_project_and_refresh_updated_at() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);

        thread::sleep(Duration::from_millis(5));

        let updated = database
            .project_update_summary(ProjectUpdateSummaryInput {
                project_id: project.id,
                name: Some("Alpha Prime".to_string()),
                summary: "最新项目简介".to_string(),
                status: Some("active".to_string()),
            })
            .unwrap();

        assert_eq!(updated.id, project.id);
        assert_eq!(updated.name, "Alpha Prime");
        assert_eq!(updated.summary, "最新项目简介");
        assert_ne!(updated.updated_at, project.updated_at);

        let refreshed = database.project_record(project.id).unwrap();
        assert_eq!(refreshed.name, "Alpha Prime");
        assert_eq!(refreshed.summary, "最新项目简介");
        assert_eq!(refreshed.updated_at, updated.updated_at);
    }

    #[test]
    fn legacy_activity_settings_migration_backfills_existing_rows() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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

        let mut database = Database::open(&db_path).unwrap();
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
            .any(|option| option.label == "LEGAL" && option.color_key == DEFAULT_ACTIVITY_ATTRIBUTE_COLOR_KEY));
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
        assert_eq!(activities[0].status_color_key, LEGACY_ACTIVITY_STATUS_ORGANIZED_COLOR_KEY);
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
        assert_eq!(refreshed.status_color_key, DEFAULT_ACTIVITY_STATUS_COLOR_KEY);
        assert!(refreshed.status_needs_attention);
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

        assert_eq!(settings.body.font_preset, "workspace_sans");
        assert_eq!(settings.body.font_size_px, 14);
        assert_eq!(settings.body.line_height, 1.6);
        assert_eq!(settings.body.paragraph_spacing_before_px, 12);
        assert_eq!(settings.body.paragraph_spacing_after_px, 0);
        assert_eq!(settings.headings.h1_size_px, 24);
        assert_eq!(settings.headings.h2_size_px, 20);
        assert_eq!(settings.headings.h3_size_px, 16);
        assert_eq!(settings.list.font_preset, "workspace_sans");
    }

    #[test]
    fn rich_text_style_upsert_round_trips_saved_values() {
        let (_harness, mut database) = setup_database();

        let saved = database
            .rich_text_style_upsert(RichTextStyleSettings {
                body: RichTextStyleBlockSettings {
                    font_preset: "work_sans".to_string(),
                    font_size_px: 15,
                    line_height: 1.7,
                    paragraph_spacing_before_px: 14,
                    paragraph_spacing_after_px: 2,
                },
                headings: crate::models::RichTextHeadingStyleSettings {
                    font_preset: "source_serif".to_string(),
                    line_height: 1.3,
                    paragraph_spacing_before_px: 10,
                    paragraph_spacing_after_px: 4,
                    h1_size_px: 28,
                    h2_size_px: 22,
                    h3_size_px: 18,
                },
                list: RichTextStyleBlockSettings {
                    font_preset: "noto_sans_sc".to_string(),
                    font_size_px: 15,
                    line_height: 1.65,
                    paragraph_spacing_before_px: 10,
                    paragraph_spacing_after_px: 3,
                },
            })
            .unwrap();
        let loaded = database.rich_text_style_get().unwrap();

        assert_eq!(loaded.body.font_preset, "work_sans");
        assert_eq!(loaded.body.font_size_px, 15);
        assert_eq!(loaded.headings.font_preset, "source_serif");
        assert_eq!(loaded.headings.h1_size_px, 28);
        assert_eq!(loaded.list.font_preset, "noto_sans_sc");
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

        assert_eq!(settings.body.paragraph_spacing_before_px, 12);
        assert_eq!(settings.body.paragraph_spacing_after_px, 0);
        assert_eq!(settings.headings.paragraph_spacing_before_px, 10);
        assert_eq!(settings.headings.paragraph_spacing_after_px, 0);
        assert_eq!(settings.list.paragraph_spacing_before_px, 8);
        assert_eq!(settings.list.paragraph_spacing_after_px, 0);
    }

    #[test]
    fn migration_adds_app_settings_without_affecting_ai_profiles() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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

        let mut database = Database::open(&db_path).unwrap();
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

        let old_folder = PathBuf::from(&project.root_path).join("Kickoff");
        let updated_activity = database
            .activity_update_meta(ActivityUpdateMetaInput {
                activity_id: activity.id,
                title: Some("Review Final".to_string()),
                attribute_option_id: None,
                clear_attribute_option: None,
                activity_time: None,
                is_pinned: None,
                is_expanded: None,
                status_option_id: None,
            })
            .unwrap();
        let updated_document = database.document_record(document.id).unwrap();

        assert_eq!(updated_activity.title, "Review Final");
        assert!(!old_folder.exists());
        assert!(updated_document.managed_path.contains("Review Final"));
        assert!(Path::new(&updated_document.managed_path).exists());
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
                source_path: source_v2.to_string_lossy().to_string(),
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
                source_path: source_v2.to_string_lossy().to_string(),
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
    fn legacy_project_layout_migrates_on_project_access() {
        let (harness, mut database) = setup_database();
        let project = create_project(&mut database, &harness.workspace_root);
        let activity = create_activity(&mut database, project.id, "Kickoff");

        let external_source = harness.root.join("brief-source.pdf");
        fs::write(&external_source, b"brief").unwrap();
        let document = database
            .document_import(DocumentImportInput {
                project_id: project.id,
                activity_id: Some(activity.id),
                source_path: external_source.to_string_lossy().to_string(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();

        let legacy_dir = PathBuf::from(&project.root_path).join("documents");
        fs::create_dir_all(&legacy_dir).unwrap();
        let legacy_path = legacy_dir.join(&document.name);
        fs::rename(&document.managed_path, &legacy_path).unwrap();
        let activity_dir = PathBuf::from(&project.root_path).join("Kickoff");
        let _ = fs::remove_dir(&activity_dir);

        database
            .conn
            .execute(
                "UPDATE projects SET file_layout_version = 1 WHERE id = ?1",
                params![project.id],
            )
            .unwrap();
        database
            .conn
            .execute(
                "UPDATE activities SET folder_name = '' WHERE id = ?1",
                params![activity.id],
            )
            .unwrap();
        database
            .conn
            .execute(
                "UPDATE documents SET base_name = '', managed_path = ?1, history_dir_path = '' WHERE id = ?2",
                params![legacy_path.to_string_lossy().to_string(), document.id],
            )
            .unwrap();
        database
            .conn
            .execute(
                "DELETE FROM document_versions WHERE document_id = ?1",
                params![document.id],
            )
            .unwrap();

        let overview = database
            .project_get_overview(ProjectIdInput {
                project_id: project.id,
            })
            .unwrap();
        let migrated_document = database.document_record(document.id).unwrap();
        let versions = database
            .document_list_versions(DocumentListVersionsInput {
                document_id: document.id,
            })
            .unwrap();

        assert_eq!(
            overview.project.file_layout_version,
            CURRENT_FILE_LAYOUT_VERSION
        );
        assert_eq!(migrated_document.base_name, document.name);
        assert!(migrated_document.managed_path.contains("Kickoff"));
        assert!(Path::new(&migrated_document.managed_path).exists());
        assert_eq!(versions.len(), 1);
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

        assert!(error.to_string().contains("file tag color is not supported"));
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
        assert!(snapshot
            .record_types
            .iter()
            .filter(|record_type| record_type.is_default)
            .count()
            == 1);
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
        let reopened = Database::open(&harness.root.join("app.sqlite3")).unwrap();

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
            font_preset: "workspace_sans".to_string(),
            font_size_px: 14,
            line_height: 1.6,
            paragraph_spacing_before_px: 12,
            paragraph_spacing_after_px: 0,
        },
        headings: crate::models::RichTextHeadingStyleSettings {
            font_preset: "workspace_sans".to_string(),
            line_height: 1.35,
            paragraph_spacing_before_px: 12,
            paragraph_spacing_after_px: 0,
            h1_size_px: 24,
            h2_size_px: 20,
            h3_size_px: 16,
        },
        list: RichTextStyleBlockSettings {
            font_preset: "workspace_sans".to_string(),
            font_size_px: 14,
            line_height: 1.6,
            paragraph_spacing_before_px: 12,
            paragraph_spacing_after_px: 0,
        },
    }
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

    if !object.contains_key("paragraphSpacingBeforePx") {
        object.insert("paragraphSpacingBeforePx".to_string(), json!(legacy_spacing));
    }

    if !object.contains_key("paragraphSpacingAfterPx") {
        object.insert("paragraphSpacingAfterPx".to_string(), json!(0));
    }

    Ok(())
}

fn normalize_rich_text_style_heading_value(value: Option<&mut Value>) -> Result<()> {
    normalize_rich_text_style_block_value(value)
}

fn validate_rich_text_style_settings(settings: &RichTextStyleSettings) -> Result<()> {
    validate_rich_text_style_block(&settings.body, "body")?;
    validate_rich_text_font_preset(&settings.headings.font_preset, "headings.fontPreset")?;

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
    validate_rich_text_font_preset(&settings.font_preset, &format!("{prefix}.fontPreset"))?;
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

fn validate_rich_text_font_preset(value: &str, field: &str) -> Result<()> {
    if !RICH_TEXT_FONT_PRESETS.contains(&value) {
        return Err(anyhow!("{field} is not a supported font preset"));
    }
    Ok(())
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

    normalized.trim_matches(|ch| ch == '_' || ch == '-').to_string()
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

fn normalize_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn nullable_trimmed(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}
