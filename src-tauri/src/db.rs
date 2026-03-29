use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::{
    mock_ai,
    models::{
        AcceptedSuggestionResult, ActivityCardData, ActivityCreateInput, ActivityDigest,
        ActivityUpdateMetaInput, AiAcceptSuggestionInput, AiGenerateInput, AiSuggestionRecord,
        ConclusionCreateInput, ConclusionGroup, ConclusionListInput, ConclusionRecord,
        ConclusionUpdateInput, DocumentImportInput, DocumentRecord, DocumentRelocateInput,
        DocumentUpdateMetaInput, NoteAppendQuickInput, NoteRecord, NoteUpsertMinutesInput,
        ProjectArchiveInput, ProjectCreateInput, ProjectDashboard, ProjectIdInput, ProjectListItem,
        ProjectOverviewData, ProjectRecord, ProjectUpdateSummaryInput, ProjectsListInput,
        TodoAddProgressInput, TodoCreateInput, TodoProgressRecord, TodoRecord,
        TodoUpdateStatusInput, WorkspaceSearchInput, WorkspaceSearchResult,
    },
};

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn open(db_path: &Path) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create app data dir at {}", parent.display()))?;
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
              summary TEXT NOT NULL DEFAULT '',
              is_archived INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS activities (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_id INTEGER NOT NULL,
              category TEXT NOT NULL,
              title TEXT NOT NULL DEFAULT '',
              activity_time TEXT NOT NULL,
              is_pinned INTEGER NOT NULL DEFAULT 0,
              is_expanded INTEGER NOT NULL DEFAULT 0,
              organize_status TEXT NOT NULL DEFAULT 'needs_review',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
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
              source_note_id INTEGER,
              title TEXT NOT NULL,
              description TEXT,
              status TEXT NOT NULL DEFAULT 'todo',
              priority TEXT NOT NULL DEFAULT 'medium',
              due_date TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
              FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE SET NULL,
              FOREIGN KEY(source_note_id) REFERENCES notes(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS todo_progresses (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              todo_id INTEGER NOT NULL,
              content TEXT NOT NULL,
              status_snapshot TEXT NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY(todo_id) REFERENCES todos(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS documents (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_id INTEGER NOT NULL,
              activity_id INTEGER,
              name TEXT NOT NULL,
              original_path TEXT NOT NULL,
              managed_path TEXT NOT NULL,
              storage_mode TEXT NOT NULL,
              mime_type TEXT NOT NULL,
              role TEXT NOT NULL,
              is_starred INTEGER NOT NULL DEFAULT 0,
              promoted_to_project INTEGER NOT NULL DEFAULT 0,
              health TEXT NOT NULL DEFAULT 'normal',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
              FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE SET NULL
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

            "#,
        )?;
        self.ensure_column(
            "projects",
            "is_archived",
            "ALTER TABLE projects ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0",
        )?;
        self.ensure_column(
            "documents",
            "promoted_to_project",
            "ALTER TABLE documents ADD COLUMN promoted_to_project INTEGER NOT NULL DEFAULT 0",
        )?;
        self.conn.execute(
            "UPDATE activities SET organize_status = 'needs_review' WHERE organize_status = 'unorganized'",
            [],
        )?;
        self.conn.execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS idx_projects_archived_updated ON projects(is_archived, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_activities_project_time ON activities(project_id, activity_time DESC);
            CREATE INDEX IF NOT EXISTS idx_notes_activity ON notes(activity_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_conclusions_project ON conclusions(project_id, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project_id, status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_documents_project_promoted ON documents(project_id, promoted_to_project, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_ai_suggestions_activity ON ai_suggestions(activity_id, status, created_at DESC);
            "#,
        )?;
        Ok(())
    }

    pub fn projects_list(&mut self, input: ProjectsListInput) -> Result<Vec<ProjectListItem>> {
        let include_archived = input.include_archived.unwrap_or(false);
        let sql = format!(
            r#"
            SELECT
              p.id, p.name, p.status, p.root_path, p.summary, p.is_archived, p.created_at, p.updated_at,
              (SELECT COUNT(*) FROM activities a WHERE a.project_id = p.id) AS activity_count,
              (SELECT COUNT(*) FROM activities a WHERE a.project_id = p.id AND a.organize_status = 'needs_review') AS unorganized_count,
              (SELECT COUNT(*) FROM todos t WHERE t.project_id = p.id AND t.status IN ('todo', 'doing', 'blocked')) AS open_todo_count
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
                summary: row.get(4)?,
                is_archived: int_to_bool(row.get::<_, i64>(5)?),
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                activity_count: row.get(8)?,
                unorganized_count: row.get(9)?,
                open_todo_count: row.get(10)?,
            })
        })?;

        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
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

        let project_dir = base.join(project_name);
        fs::create_dir_all(project_dir.join("documents"))?;

        self.conn.execute(
            r#"
            INSERT INTO projects (name, status, root_path, summary, is_archived, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)
            "#,
            params![
                project_name,
                input.status.unwrap_or_else(|| "active".to_string()),
                project_dir.to_string_lossy().to_string(),
                input.summary.unwrap_or_default(),
                timestamp,
                timestamp
            ],
        )?;

        let id = self.conn.last_insert_rowid();
        self.project_record(id)
    }

    pub fn project_get_overview(&mut self, input: ProjectIdInput) -> Result<ProjectOverviewData> {
        self.refresh_document_health(input.project_id)?;
        let project = self.project_record(input.project_id)?;
        let activity_feed = self.activity_digests(input.project_id, None)?;
        let key_documents = self.fetch_key_documents_for_project(input.project_id)?;
        let conclusion_groups = self.fetch_conclusion_groups(input.project_id)?;
        let unfinished_todos = self.fetch_project_todos(input.project_id, false)?;
        let finished_todos = self.fetch_project_todos(input.project_id, true)?;

        Ok(ProjectOverviewData {
            project,
            activity_feed,
            key_documents,
            conclusion_groups,
            unfinished_todos,
            finished_todos,
        })
    }

    pub fn project_get_dashboard(&mut self, input: ProjectIdInput) -> Result<ProjectDashboard> {
        self.refresh_document_health(input.project_id)?;

        let project = self.project_record(input.project_id)?;
        let key_conclusions = self.list_project_conclusions(input.project_id, true)?;
        let open_todos = self.todo_list_open(input.clone())?;
        let starred_documents = self.fetch_documents_for_project(input.project_id, true)?;
        let recent_activities = self.activity_digests(input.project_id, Some(6))?;
        let unorganized_count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM activities WHERE project_id = ?1 AND organize_status = 'needs_review'",
            [input.project_id],
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

    pub fn project_update_summary(&mut self, input: ProjectUpdateSummaryInput) -> Result<ProjectRecord> {
        let current = self.project_record(input.project_id)?;
        self.conn.execute(
            "UPDATE projects SET summary = ?1, status = ?2, updated_at = ?3 WHERE id = ?4",
            params![
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
        let timestamp = now_iso();
        self.conn.execute(
            r#"
            INSERT INTO activities (
              project_id, category, title, activity_time, is_pinned, is_expanded, organize_status, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, 0, 0, 'needs_review', ?5, ?6)
            "#,
            params![
                input.project_id,
                input.category,
                input.title.unwrap_or_default(),
                input.activity_time,
                timestamp,
                timestamp
            ],
        )?;
        let activity_id = self.conn.last_insert_rowid();
        self.touch_project(input.project_id)?;
        self.activity_card(activity_id)
    }

    pub fn activity_list(&mut self, input: ProjectIdInput) -> Result<Vec<ActivityCardData>> {
        self.refresh_document_health(input.project_id)?;
        let mut stmt = self.conn.prepare(
            "SELECT id FROM activities WHERE project_id = ?1 ORDER BY activity_time DESC, updated_at DESC",
        )?;
        let ids = stmt
            .query_map([input.project_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        ids.into_iter().map(|id| self.activity_card(id)).collect()
    }

    pub fn activity_update_meta(&mut self, input: ActivityUpdateMetaInput) -> Result<ActivityCardData> {
        let current = self.activity_row(input.activity_id)?;
        let next_status = input
            .organize_status
            .map(normalize_review_status)
            .unwrap_or(current.6);
        self.conn.execute(
            r#"
            UPDATE activities
            SET title = ?1,
                category = ?2,
                activity_time = ?3,
                is_pinned = ?4,
                is_expanded = ?5,
                organize_status = ?6,
                updated_at = ?7
            WHERE id = ?8
            "#,
            params![
                input.title.unwrap_or(current.2),
                input.category.unwrap_or(current.1),
                input.activity_time.unwrap_or(current.3),
                bool_to_int(input.is_pinned.unwrap_or(current.4)),
                bool_to_int(input.is_expanded.unwrap_or(current.5)),
                next_status,
                now_iso(),
                input.activity_id
            ],
        )?;
        self.touch_project(current.0)?;
        self.activity_card(input.activity_id)
    }

    pub fn note_append_quick(&mut self, input: NoteAppendQuickInput) -> Result<NoteRecord> {
        let timestamp = now_iso();
        self.conn.execute(
            r#"
            INSERT INTO notes (
              project_id, activity_id, note_type, title, content_markdown, content_html, created_at, updated_at
            )
            VALUES (?1, ?2, 'quick_note', ?3, ?4, ?5, ?6, ?7)
            "#,
            params![
                input.project_id,
                input.activity_id,
                input.title,
                input.content,
                input.content,
                timestamp,
                timestamp
            ],
        )?;
        let note_id = self.conn.last_insert_rowid();
        self.touch_activity(input.activity_id)?;
        self.note_record(note_id)
    }

    pub fn note_upsert_minutes(&mut self, input: NoteUpsertMinutesInput) -> Result<NoteRecord> {
        let timestamp = now_iso();
        match input.note_id {
            Some(note_id) => {
                self.conn.execute(
                    r#"
                    UPDATE notes
                    SET title = ?1, content_markdown = ?2, content_html = ?3, updated_at = ?4
                    WHERE id = ?5
                    "#,
                    params![input.title, input.markdown, input.html, timestamp, note_id],
                )?;
                self.touch_activity(input.activity_id)?;
                self.note_record(note_id)
            }
            None => {
                self.conn.execute(
                    r#"
                    INSERT INTO notes (
                      project_id, activity_id, note_type, title, content_markdown, content_html, created_at, updated_at
                    )
                    VALUES (?1, ?2, 'meeting_minutes', ?3, ?4, ?5, ?6, ?7)
                    "#,
                    params![
                        input.project_id,
                        input.activity_id,
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
              project_id, activity_id, note_id, content, promoted_to_project, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            "#,
            params![
                input.project_id,
                input.activity_id,
                input.note_id,
                input.content,
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
                .query_map(params![input.project_id, activity_id], |row| row.get::<_, i64>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            ids.into_iter().map(|id| self.conclusion_record(id)).collect()
        } else {
            self.list_project_conclusions(input.project_id, false)
        }
    }

    pub fn conclusion_update(&mut self, input: ConclusionUpdateInput) -> Result<ConclusionRecord> {
        let current = self.conclusion_record(input.conclusion_id)?;
        self.conn.execute(
            r#"
            UPDATE conclusions
            SET content = ?1,
                promoted_to_project = ?2,
                updated_at = ?3
            WHERE id = ?4
            "#,
            params![
                input.content,
                bool_to_int(input.promoted_to_project.unwrap_or(current.promoted_to_project)),
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
              project_id, activity_id, source_note_id, title, description, status, priority, due_date, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            "#,
            params![
                input.project_id,
                input.activity_id,
                input.source_note_id,
                input.title,
                input.description,
                input.status.unwrap_or_else(|| "todo".to_string()),
                input.priority.unwrap_or_else(|| "medium".to_string()),
                input.due_date,
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

    pub fn todo_add_progress(&mut self, input: TodoAddProgressInput) -> Result<TodoProgressRecord> {
        let timestamp = now_iso();
        let todo = self.todo_record(input.todo_id)?;
        self.conn.execute(
            r#"
            INSERT INTO todo_progresses (todo_id, content, status_snapshot, created_at)
            VALUES (?1, ?2, ?3, ?4)
            "#,
            params![input.todo_id, input.content, input.status_snapshot, timestamp],
        )?;
        self.conn.execute(
            "UPDATE todos SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![input.status_snapshot, now_iso(), input.todo_id],
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
            WHERE project_id = ?1 AND status IN ('todo', 'doing', 'blocked')
            ORDER BY updated_at DESC
            "#,
        )?;
        let ids = stmt
            .query_map([input.project_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().map(|id| self.todo_record(id)).collect()
    }

    pub fn document_import(&mut self, input: DocumentImportInput) -> Result<DocumentRecord> {
        let timestamp = now_iso();
        let source = PathBuf::from(&input.source_path);
        if !source.exists() {
            return Err(anyhow!("source file does not exist"));
        }

        let project = self.project_record(input.project_id)?;
        let documents_dir = PathBuf::from(&project.root_path).join("documents");
        fs::create_dir_all(&documents_dir)?;

        let file_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| anyhow!("invalid file name"))?
            .to_string();
        let managed_name = unique_file_name(&file_name);
        let managed_path = documents_dir.join(managed_name);
        fs::copy(&source, &managed_path)
            .with_context(|| format!("failed to copy file from {}", source.display()))?;

        let mime = mime_guess::from_path(&source)
            .first_or_octet_stream()
            .essence_str()
            .to_string();

        self.conn.execute(
            r#"
            INSERT INTO documents (
              project_id, activity_id, name, original_path, managed_path, storage_mode, mime_type, role, is_starred, promoted_to_project, health, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, 'managed_copy', ?6, ?7, ?8, ?9, 'normal', ?10, ?11)
            "#,
            params![
                input.project_id,
                input.activity_id,
                file_name,
                source.to_string_lossy().to_string(),
                managed_path.to_string_lossy().to_string(),
                mime,
                input.role,
                bool_to_int(input.is_starred),
                bool_to_int(
                    input
                        .promoted_to_project
                        .unwrap_or(input.activity_id.is_none())
                ),
                timestamp,
                timestamp
            ],
        )?;
        let id = self.conn.last_insert_rowid();
        self.touch_project(input.project_id)?;
        if let Some(activity_id) = input.activity_id {
            self.touch_activity(activity_id)?;
        }
        self.document_record(id)
    }

    pub fn document_update_meta(&mut self, input: DocumentUpdateMetaInput) -> Result<DocumentRecord> {
        let current = self.document_record(input.document_id)?;
        self.conn.execute(
            "UPDATE documents SET role = ?1, is_starred = ?2, promoted_to_project = ?3, updated_at = ?4 WHERE id = ?5",
            params![
                input.role.unwrap_or(current.role),
                bool_to_int(input.is_starred.unwrap_or(current.is_starred)),
                bool_to_int(
                    input
                        .promoted_to_project
                        .unwrap_or(current.promoted_to_project)
                ),
                now_iso(),
                input.document_id
            ],
        )?;
        self.touch_project(current.project_id)?;
        if let Some(activity_id) = current.activity_id {
            self.touch_activity(activity_id)?;
        }
        self.document_record(input.document_id)
    }

    pub fn document_relocate(&mut self, input: DocumentRelocateInput) -> Result<DocumentRecord> {
        let current = self.document_record(input.document_id)?;
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
        self.touch_project(current.project_id)?;
        self.document_record(input.document_id)
    }

    pub fn ai_generate_note_suggestions(&mut self, input: AiGenerateInput) -> Result<Vec<AiSuggestionRecord>> {
        let (activity_title, source_text) = self.ai_source(input.project_id, input.activity_id, input.note_id)?;
        self.conn.execute(
            "DELETE FROM ai_suggestions WHERE project_id = ?1 AND activity_id = ?2 AND status = 'pending'",
            params![input.project_id, input.activity_id],
        )?;

        let drafts = mock_ai::generate(&activity_title, &source_text);
        let timestamp = now_iso();

        for draft in drafts {
            self.conn.execute(
                r#"
                INSERT INTO ai_suggestions (
                  project_id, activity_id, note_id, suggestion_type, title, preview, payload_json, status, created_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8)
                "#,
                params![
                    input.project_id,
                    input.activity_id,
                    input.note_id,
                    draft.suggestion_type,
                    draft.title,
                    draft.preview,
                    draft.payload.to_string(),
                    timestamp
                ],
            )?;
        }

        self.fetch_ai_suggestions(Some(input.activity_id))
    }

    pub fn ai_accept_suggestion(&mut self, input: AiAcceptSuggestionInput) -> Result<AcceptedSuggestionResult> {
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
                      project_id, activity_id, note_id, content, promoted_to_project, created_at, updated_at
                    )
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                    "#,
                    params![
                        suggestion.project_id,
                        suggestion.activity_id,
                        suggestion.note_id,
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
                let title = suggestion
                    .payload
                    .get("title")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("missing todo title"))?;
                let description = suggestion
                    .payload
                    .get("description")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
                let priority = suggestion
                    .payload
                    .get("priority")
                    .and_then(Value::as_str)
                    .unwrap_or("medium");
                self.conn.execute(
                    r#"
                    INSERT INTO todos (
                      project_id, activity_id, source_note_id, title, description, status, priority, created_at, updated_at
                    )
                    VALUES (?1, ?2, ?3, ?4, ?5, 'todo', ?6, ?7, ?8)
                    "#,
                    params![
                        suggestion.project_id,
                        suggestion.activity_id,
                        suggestion.note_id,
                        title,
                        description,
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

    pub fn workspace_search(&mut self, input: WorkspaceSearchInput) -> Result<Vec<WorkspaceSearchResult>> {
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
            SELECT a.id, a.project_id, a.title, a.category, p.name
            FROM activities a
            INNER JOIN projects p ON p.id = a.project_id
            WHERE (a.title LIKE ?1 OR a.category LIKE ?1) {}
            ORDER BY a.updated_at DESC
            LIMIT 5
            "#,
            project_filter
        );
        let mut stmt = self.conn.prepare(&activity_sql)?;
        let rows = stmt.query_map([pattern.as_str()], |row| {
            let category: String = row.get(3)?;
            let project_name: String = row.get(4)?;
            Ok(WorkspaceSearchResult {
                kind: "activity".to_string(),
                id: row.get(0)?,
                project_id: row.get(1)?,
                activity_id: row.get(0)?,
                title: row.get(2)?,
                subtitle: format!("{} · {}", project_name, category.to_uppercase()),
                matched_text: query.to_string(),
            })
        })?;
        results.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);

        let conclusion_sql = format!(
            r#"
            SELECT c.id, c.project_id, c.activity_id, c.content, COALESCE(a.title, p.name)
            FROM conclusions c
            INNER JOIN projects p ON p.id = c.project_id
            LEFT JOIN activities a ON a.id = c.activity_id
            WHERE c.content LIKE ?1 {}
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
            SELECT t.id, t.project_id, t.activity_id, t.title, COALESCE(t.description, ''), COALESCE(a.title, p.name)
            FROM todos t
            INNER JOIN projects p ON p.id = t.project_id
            LEFT JOIN activities a ON a.id = t.activity_id
            WHERE (t.title LIKE ?1 OR COALESCE(t.description, '') LIKE ?1) {}
            ORDER BY t.updated_at DESC
            LIMIT 5
            "#,
            project_filter
        );
        let mut stmt = self.conn.prepare(&todo_sql)?;
        let rows = stmt.query_map([pattern.as_str()], |row| {
            let title: String = row.get(3)?;
            let description: String = row.get(4)?;
            Ok(WorkspaceSearchResult {
                kind: "todo".to_string(),
                id: row.get(0)?,
                project_id: row.get(1)?,
                activity_id: row.get(2)?,
                title,
                subtitle: if description.is_empty() {
                    row.get::<_, String>(5)?
                } else {
                    truncate_text(&description, 72)
                },
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
                SELECT id, name, status, root_path, summary, is_archived, created_at, updated_at
                FROM projects WHERE id = ?1
                "#,
                [project_id],
                |row| {
                    Ok(ProjectRecord {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        status: row.get(2)?,
                        root_path: row.get(3)?,
                        summary: row.get(4)?,
                        is_archived: int_to_bool(row.get::<_, i64>(5)?),
                        created_at: row.get(6)?,
                        updated_at: row.get(7)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    fn activity_row(&self, activity_id: i64) -> Result<(i64, String, String, String, bool, bool, String)> {
        self.conn
            .query_row(
                r#"
                SELECT project_id, category, title, activity_time, is_pinned, is_expanded, organize_status
                FROM activities WHERE id = ?1
                "#,
                [activity_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        int_to_bool(row.get::<_, i64>(4)?),
                        int_to_bool(row.get::<_, i64>(5)?),
                        normalize_review_status(row.get::<_, String>(6)?),
                    ))
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
                  c.id, c.project_id, c.activity_id, c.note_id, c.content, c.promoted_to_project,
                  a.title, c.created_at, c.updated_at
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
                        content: row.get(4)?,
                        promoted_to_project: int_to_bool(row.get::<_, i64>(5)?),
                        source_activity_title: row.get(6)?,
                        created_at: row.get(7)?,
                        updated_at: row.get(8)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    fn todo_progress_record(&self, progress_id: i64) -> Result<TodoProgressRecord> {
        self.conn
            .query_row(
                r#"
                SELECT id, todo_id, content, status_snapshot, created_at
                FROM todo_progresses WHERE id = ?1
                "#,
                [progress_id],
                |row| {
                    Ok(TodoProgressRecord {
                        id: row.get(0)?,
                        todo_id: row.get(1)?,
                        content: row.get(2)?,
                        status_snapshot: row.get(3)?,
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
              t.id, t.project_id, t.activity_id, t.source_note_id, t.title, t.description, t.status,
              t.priority, t.due_date, t.created_at, t.updated_at, a.title
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
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, Option<String>>(11)?,
                ))
            },
        )?;
        let progresses = self.fetch_todo_progresses(todo_id)?;
        Ok(TodoRecord {
            id: base.0,
            project_id: base.1,
            activity_id: base.2,
            source_note_id: base.3,
            title: base.4,
            description: base.5,
            status: base.6,
            priority: base.7,
            due_date: base.8,
            created_at: base.9,
            updated_at: base.10,
            source_activity_title: base.11,
            progresses,
        })
    }

    fn document_record(&self, document_id: i64) -> Result<DocumentRecord> {
        self.conn
            .query_row(
                r#"
                SELECT
                  d.id, d.project_id, d.activity_id, d.name, d.original_path, d.managed_path, d.storage_mode,
                  d.mime_type, d.role, d.is_starred, d.promoted_to_project, d.health, a.title, d.created_at, d.updated_at
                FROM documents d
                LEFT JOIN activities a ON a.id = d.activity_id
                WHERE d.id = ?1
                "#,
                [document_id],
                |row| {
                    Ok(DocumentRecord {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        activity_id: row.get(2)?,
                        name: row.get(3)?,
                        original_path: row.get(4)?,
                        managed_path: row.get(5)?,
                        storage_mode: row.get(6)?,
                        mime_type: row.get(7)?,
                        role: row.get(8)?,
                        is_starred: int_to_bool(row.get::<_, i64>(9)?),
                        promoted_to_project: int_to_bool(row.get::<_, i64>(10)?),
                        health: row.get(11)?,
                        source_activity_title: row.get(12)?,
                        created_at: row.get(13)?,
                        updated_at: row.get(14)?,
                    })
                },
            )
            .map_err(Into::into)
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

    fn fetch_notes(&self, activity_id: i64) -> Result<Vec<NoteRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM notes WHERE activity_id = ?1 ORDER BY created_at DESC",
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
        ids.into_iter().map(|id| self.conclusion_record(id)).collect()
    }

    fn fetch_todos_for_activity(&self, activity_id: i64) -> Result<Vec<TodoRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM todos WHERE activity_id = ?1 ORDER BY updated_at DESC",
        )?;
        let ids = stmt
            .query_map([activity_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().map(|id| self.todo_record(id)).collect()
    }

    fn fetch_todo_progresses(&self, todo_id: i64) -> Result<Vec<TodoProgressRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM todo_progresses WHERE todo_id = ?1 ORDER BY created_at DESC",
        )?;
        let ids = stmt
            .query_map([todo_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().map(|id| self.todo_progress_record(id)).collect()
    }

    fn fetch_documents(&self, activity_id: i64) -> Result<Vec<DocumentRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM documents WHERE activity_id = ?1 ORDER BY updated_at DESC",
        )?;
        let ids = stmt
            .query_map([activity_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().map(|id| self.document_record(id)).collect()
    }

    fn fetch_documents_for_project(&self, project_id: i64, starred_only: bool) -> Result<Vec<DocumentRecord>> {
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

    fn fetch_key_documents_for_project(&self, project_id: i64) -> Result<Vec<DocumentRecord>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id
            FROM documents
            WHERE project_id = ?1
              AND (activity_id IS NULL OR promoted_to_project = 1)
            ORDER BY updated_at DESC
            LIMIT 18
            "#,
        )?;
        let ids = stmt
            .query_map([project_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().map(|id| self.document_record(id)).collect()
    }

    fn fetch_project_todos(&self, project_id: i64, finished: bool) -> Result<Vec<TodoRecord>> {
        let query = if finished {
            "SELECT id FROM todos WHERE project_id = ?1 AND status IN ('done', 'cancelled') ORDER BY updated_at DESC"
        } else {
            "SELECT id FROM todos WHERE project_id = ?1 AND status IN ('todo', 'doing', 'blocked') ORDER BY updated_at DESC"
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
        ids.into_iter().map(|id| self.ai_suggestion_record(id)).collect()
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
              a.id, a.project_id, a.category, a.title, a.activity_time, a.organize_status, a.is_pinned,
              (SELECT COUNT(*) FROM notes n WHERE n.activity_id = a.id) AS note_count,
              (SELECT COUNT(*) FROM conclusions c WHERE c.activity_id = a.id) AS conclusion_count,
              (SELECT COUNT(*) FROM todos t WHERE t.activity_id = a.id) AS todo_count,
              (SELECT COUNT(*) FROM documents d WHERE d.activity_id = a.id) AS document_count,
              (SELECT COUNT(*) FROM todos t WHERE t.activity_id = a.id AND t.status IN ('done', 'cancelled')) AS completed_todo_count,
              (SELECT COUNT(*) FROM todos t WHERE t.activity_id = a.id) AS total_todo_count,
              EXISTS(SELECT 1 FROM todos t WHERE t.activity_id = a.id AND t.status IN ('todo', 'doing', 'blocked')) AS has_open_todos
            FROM activities a
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
              id, project_id, category, title, activity_time, is_pinned, is_expanded,
              organize_status, created_at, updated_at
            FROM activities WHERE id = ?1
            "#,
            [activity_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    int_to_bool(row.get::<_, i64>(5)?),
                    int_to_bool(row.get::<_, i64>(6)?),
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
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
            category: base.2.clone(),
            title: base.3.clone(),
            activity_time: base.4.clone(),
            review_status: normalize_review_status(base.7.clone()),
            organize_status: normalize_review_status(base.7.clone()),
            is_pinned: base.5,
            note_count: notes.len() as i64,
            conclusion_count: conclusions.len() as i64,
            todo_count: todos.len() as i64,
            document_count: documents.len() as i64,
            completed_todo_count: todos
                .iter()
                .filter(|todo| matches!(todo.status.as_str(), "done" | "cancelled"))
                .count() as i64,
            total_todo_count: todos.len() as i64,
            has_open_todos: todos
                .iter()
                .any(|todo| matches!(todo.status.as_str(), "todo" | "doing" | "blocked")),
        };

        Ok(ActivityCardData {
            id: base.0,
            project_id: base.1,
            category: base.2,
            title: base.3,
            activity_time: base.4,
            is_pinned: base.5,
            is_expanded: base.6,
            organize_status: normalize_review_status(base.7),
            created_at: base.8,
            updated_at: base.9,
            digest,
            notes,
            conclusions,
            todos,
            documents,
            ai_suggestions,
        })
    }

    fn list_project_conclusions(&self, project_id: i64, promoted_only: bool) -> Result<Vec<ConclusionRecord>> {
        let query = if promoted_only {
            "SELECT id FROM conclusions WHERE project_id = ?1 AND promoted_to_project = 1 ORDER BY updated_at DESC LIMIT 8"
        } else {
            "SELECT id FROM conclusions WHERE project_id = ?1 ORDER BY updated_at DESC"
        };
        let mut stmt = self.conn.prepare(query)?;
        let ids = stmt
            .query_map([project_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().map(|id| self.conclusion_record(id)).collect()
    }

    fn ai_source(&self, project_id: i64, activity_id: i64, note_id: Option<i64>) -> Result<(String, String)> {
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
        let mut stmt = self.conn.prepare(
            "SELECT id, managed_path, health FROM documents WHERE project_id = ?1",
        )?;
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

    fn ensure_column(&self, table: &str, column: &str, sql: &str) -> Result<()> {
        let pragma = format!("PRAGMA table_info({})", table);
        let mut stmt = self.conn.prepare(&pragma)?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if !columns.iter().any(|existing| existing == column) {
            self.conn.execute(sql, [])?;
        }
        Ok(())
    }
}

fn activity_digest_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ActivityDigest> {
    let organize_status = normalize_review_status(row.get(5)?);
    Ok(ActivityDigest {
        id: row.get(0)?,
        project_id: row.get(1)?,
        category: row.get(2)?,
        title: row.get(3)?,
        activity_time: row.get(4)?,
        review_status: organize_status.clone(),
        organize_status,
        is_pinned: int_to_bool(row.get::<_, i64>(6)?),
        note_count: row.get(7)?,
        conclusion_count: row.get(8)?,
        todo_count: row.get(9)?,
        document_count: row.get(10)?,
        completed_todo_count: row.get(11)?,
        total_todo_count: row.get(12)?,
        has_open_todos: int_to_bool(row.get::<_, i64>(13)?),
    })
}

fn normalize_review_status(value: String) -> String {
    if value == "unorganized" {
        "needs_review".to_string()
    } else {
        value
    }
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

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn unique_file_name(name: &str) -> String {
    let clean = name
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => ch,
        })
        .collect::<String>();
    format!("{}-{}", Utc::now().timestamp_millis(), clean)
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
