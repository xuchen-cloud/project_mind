//! Durable changes from native GUI business writes share the source identities.
use super::{source_native, Database};
use crate::{
    agent::models::{ObjectKind, ObjectRef, Scope},
    models::*,
};
use anyhow::{anyhow, Result};

#[derive(Clone)]
struct NativeTarget {
    kind: ObjectKind,
    scope: Scope,
    id: i64,
}

/// Preserve the existing rename rollback until the enclosing SQLite commit
/// (including outbox) succeeds. This is not a filesystem crash journal.
pub(super) struct ProjectRootRename {
    original: std::path::PathBuf,
    next: std::path::PathBuf,
    committed: bool,
}
impl ProjectRootRename {
    pub(super) fn new(original: std::path::PathBuf, next: std::path::PathBuf) -> Self {
        Self {
            original,
            next,
            committed: false,
        }
    }
    fn commit(&mut self) {
        self.committed = true;
    }
}
impl Drop for ProjectRootRename {
    fn drop(&mut self) {
        if !self.committed {
            if let Err(error) = std::fs::rename(&self.next, &self.original) {
                eprintln!("Project directory rename rollback failed: {error}");
            }
        }
    }
}

pub(super) struct ProjectRootCreate {
    path: std::path::PathBuf,
    committed: bool,
}
impl ProjectRootCreate {
    pub(super) fn new(path: std::path::PathBuf) -> Self {
        Self {
            path,
            committed: false,
        }
    }
    fn commit(&mut self) {
        self.committed = true;
    }
}
impl Drop for ProjectRootCreate {
    fn drop(&mut self) {
        if !self.committed {
            if let Err(error) = std::fs::remove_dir(&self.path) {
                eprintln!("Project directory creation rollback failed: {error}");
            }
        }
    }
}

/// Catalogue identities before the foreign-key cascade removes ownership. The
/// SQL union never reads bodies and does not reinterpret inline images as Files.
pub(super) fn append_project_deletions(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: Option<&str>,
    project_id: i64,
) -> Result<()> {
    let Some(workspace_id) = workspace_id else {
        return Ok(());
    };
    tx.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at)
        SELECT ?1||'/project:'||?2||'/'||kind||'/'||id,'project:'||?2,'project.delete','deleted',?3 FROM (
          SELECT 'project' AS kind,id FROM projects WHERE id=?2
          UNION ALL SELECT 'quick_note',id FROM projects WHERE id=?2
          UNION ALL SELECT 'record',id FROM notes WHERE project_id=?2
          UNION ALL SELECT 'todo',id FROM todos WHERE project_id=?2
          UNION ALL SELECT 'file',id FROM documents WHERE project_id=?2 AND storage_mode!='managed_note_image'
          UNION ALL SELECT 'transcript',v.id FROM voice_records v JOIN notes n ON n.id=v.project_note_id WHERE n.project_id=?2
        )", rusqlite::params![workspace_id,project_id,super::now_iso()])?;
    Ok(())
}

pub(super) fn append_record_deletions(
    conn: &rusqlite::Connection,
    workspace_id: Option<&str>,
    scope: &Scope,
    record_id: i64,
) -> Result<()> {
    let Some(workspace_id) = workspace_id else {
        return Ok(());
    };
    let object = ObjectRef {
        workspace_id: workspace_id.into(),
        scope: scope.clone(),
        kind: ObjectKind::Record,
        id: record_id.to_string(),
    };
    conn.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES (?1,?2,'record.delete','deleted',?3)",
        rusqlite::params![object.key().map_err(|e| anyhow!(e.message))?,scope.key(),super::now_iso()])?;
    let column = if *scope == Scope::Workspace {
        "workspace_note_id"
    } else {
        "project_note_id"
    };
    conn.execute(&format!("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at)
        SELECT ?1||'/'||?2||'/transcript/'||id,?2,'transcript.delete','deleted',?3 FROM voice_records WHERE {column}=?4"),
        rusqlite::params![workspace_id,scope.key(),super::now_iso(),record_id])?;
    Ok(())
}

/// The log revision marks immutable final delivery, not a SourceRef snapshot.
/// Source reads compute the current full semantic hash under their own budget;
/// appending a final must not reread an ever-growing Transcript on the capture path.
pub(super) fn append_transcript_final(
    conn: &rusqlite::Connection,
    workspace_id: Option<&str>,
    session_id: &str,
    segment_id: &str,
) -> Result<()> {
    let Some(workspace_id) = workspace_id else {
        return Ok(());
    };
    let (voice_id, project_id): (i64,Option<i64>) = conn.query_row(
        "SELECT v.id,n.project_id FROM recording_sessions s JOIN voice_records v ON v.id=s.voice_record_id LEFT JOIN notes n ON n.id=v.project_note_id WHERE s.id=?1",
        [session_id], |r| Ok((r.get(0)?,r.get(1)?)))?;
    let object = ObjectRef {
        workspace_id: workspace_id.into(),
        scope: project_id.map_or(Scope::Workspace, |project_id| Scope::Project { project_id }),
        kind: ObjectKind::Transcript,
        id: voice_id.to_string(),
    };
    use sha2::{Digest, Sha256};
    let revision = format!("final:{:x}", Sha256::digest(segment_id.as_bytes()));
    conn.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES (?1,?2,'transcript.final',?3,?4)",
        rusqlite::params![object.key().map_err(|e| anyhow!(e.message))?,object.scope.key(),revision,super::now_iso()])?;
    Ok(())
}
impl NativeTarget {
    fn todo(todo: &TodoRecord) -> Self {
        Self {
            kind: ObjectKind::Todo,
            scope: todo
                .project_id
                .map_or(Scope::Workspace, |project_id| Scope::Project { project_id }),
            id: todo.id,
        }
    }
    fn workspace_quick_note(id: i64) -> Self {
        Self {
            kind: ObjectKind::QuickNote,
            scope: Scope::Workspace,
            id,
        }
    }
}

impl Database {
    /// Bind once from the real manifest/shared Host initialization. Standalone
    /// SQLite fixtures have no Workspace identity; no synthetic ID is invented.
    pub(crate) fn bind_native_workspace(&mut self, workspace_id: &str) -> Result<()> {
        ObjectRef {
            workspace_id: workspace_id.into(),
            scope: Scope::Workspace,
            kind: ObjectKind::Todo,
            id: "1".into(),
        }
        .key()
        .map_err(|e| anyhow!(e.message))?;
        if self
            .native_workspace_id
            .as_deref()
            .is_some_and(|id| id != workspace_id)
        {
            return Err(anyhow!(
                "Database Workspace identity does not match the Host"
            ));
        }
        self.native_workspace_id = Some(workspace_id.into());
        Ok(())
    }

    fn native_source_state(
        &self,
        workspace_id: &str,
        target: &NativeTarget,
    ) -> Result<Option<(ObjectRef, String)>> {
        let object = ObjectRef {
            workspace_id: workspace_id.into(),
            scope: target.scope.clone(),
            kind: target.kind,
            id: target.id.to_string(),
        };
        let Some(resolved) = self
            .agent_resolve_object(&object, workspace_id)
            .map_err(|e| anyhow!(e.message))?
        else {
            return Ok(None);
        };
        if resolved != object {
            return Err(anyhow!("Native source ownership changed"));
        }
        let revision = match target.kind {
            ObjectKind::Todo => source_native::todo_revision(&self.todo_record(target.id)?),
            ObjectKind::Project => {
                let (name, status, archived): (String, String, bool) = self.conn.query_row(
                    "SELECT name,status,is_archived FROM projects WHERE id=?1",
                    [target.id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?;
                source_native::project_revision(&name, &status, archived)
            }
            ObjectKind::QuickNote => {
                self.source_quick_note_current(object.clone())
                    .map_err(|e| anyhow!(e.message))?
                    .source
                    .revision
            }
            _ => return Err(anyhow!("Unsupported native source mutation")),
        };
        Ok(Some((object, revision)))
    }

    /// Business rows, tags, owner touches and outbox commit once. There is no
    /// transport event here, and these existing DTOs do not promise request replay.
    fn native_source_write<T>(
        &self,
        operation: &str,
        before: Option<NativeTarget>,
        apply: impl FnOnce() -> Result<(T, NativeTarget)>,
    ) -> Result<T> {
        self.native_source_write_many(operation, before.into_iter().collect(), || {
            let (result, target) = apply()?;
            Ok((result, vec![target]))
        })
    }

    fn native_source_write_many<T>(
        &self,
        operation: &str,
        before: Vec<NativeTarget>,
        apply: impl FnOnce() -> Result<(T, Vec<NativeTarget>)>,
    ) -> Result<T> {
        let workspace_id = self.native_workspace_id.as_deref();
        let tx = self.conn.unchecked_transaction()?;
        let mut previous = Vec::new();
        if let Some(id) = workspace_id {
            for target in &before {
                if let Some(state) = self.native_source_state(id, target)? {
                    previous.push(state);
                }
            }
        }
        let (result, targets) = apply()?;
        if let Some(workspace_id) = workspace_id {
            for target in &targets {
                let current = self.native_source_state(workspace_id, target)?;
                let index = previous.iter().position(|(object, _)| {
                    object.kind == target.kind
                        && object.scope == target.scope
                        && object.id == target.id.to_string()
                });
                let previous = index.map(|index| previous.remove(index));
                if previous != current {
                    let (object, revision) = current
                        .or_else(|| previous.map(|(object, _)| (object, "deleted".into())))
                        .ok_or_else(|| anyhow!("Native source disappeared before commit"))?;
                    tx.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES (?1,?2,?3,?4,?5)",
                    rusqlite::params![object.key().map_err(|e| anyhow!(e.message))?,object.scope.key(),operation,revision,super::now_iso()])?;
                }
            }
        }
        tx.commit()?;
        Ok(result)
    }

    pub fn project_update(&self, input: ProjectUpdateInput) -> Result<ProjectRecord> {
        self.file_version_recover_pending()?;
        let _file_project_lock = self.file_project_lock(input.project_id, true)?;
        let targets = vec![
            NativeTarget {
                kind: ObjectKind::Project,
                scope: Scope::Project {
                    project_id: input.project_id,
                },
                id: input.project_id,
            },
            NativeTarget {
                kind: ObjectKind::QuickNote,
                scope: Scope::Project {
                    project_id: input.project_id,
                },
                id: input.project_id,
            },
        ];
        let (result, mut rename) =
            self.native_source_write_many("project.update", targets.clone(), || {
                Ok((self.project_update_native(input)?, targets))
            })?;
        if let Some(rename) = &mut rename {
            rename.commit();
        }
        Ok(result)
    }

    pub fn project_create(&self, input: ProjectCreateInput) -> Result<ProjectRecord> {
        let (result, mut directory) =
            self.native_source_write_many("project.create", vec![], || {
                let (result, directory) = self.project_create_native(input)?;
                let scope = Scope::Project {
                    project_id: result.id,
                };
                let targets = vec![
                    NativeTarget {
                        kind: ObjectKind::Project,
                        scope: scope.clone(),
                        id: result.id,
                    },
                    NativeTarget {
                        kind: ObjectKind::QuickNote,
                        scope,
                        id: result.id,
                    },
                ];
                Ok(((result, directory), targets))
            })?;
        directory.commit();
        Ok(result)
    }

    pub fn todo_create(&self, input: TodoCreateInput) -> Result<TodoRecord> {
        self.native_source_write("todo.create", None, || {
            let result = self.todo_create_native(input)?;
            let target = NativeTarget::todo(&result);
            Ok((result, target))
        })
    }

    pub fn todo_update_content(&self, input: TodoUpdateContentInput) -> Result<TodoRecord> {
        let target = NativeTarget::todo(&self.todo_record(input.todo_id)?);
        self.native_source_write("todo.update", Some(target.clone()), || {
            Ok((self.todo_update_content_native(input)?, target))
        })
    }
    pub fn todo_update_tags(&self, input: TodoUpdateTagsInput) -> Result<TodoRecord> {
        let target = NativeTarget::todo(&self.todo_record(input.todo_id)?);
        self.native_source_write("todo.tags.update", Some(target.clone()), || {
            Ok((self.todo_update_tags_native(input)?, target))
        })
    }
    pub fn todo_update_status(&self, input: TodoUpdateStatusInput) -> Result<TodoRecord> {
        let target = NativeTarget::todo(&self.todo_record(input.todo_id)?);
        self.native_source_write("todo.status.update", Some(target.clone()), || {
            Ok((self.todo_update_status_native(input)?, target))
        })
    }
    pub fn todo_update_priority(&self, input: TodoUpdatePriorityInput) -> Result<TodoRecord> {
        let target = NativeTarget::todo(&self.todo_record(input.todo_id)?);
        self.native_source_write("todo.priority.update", Some(target.clone()), || {
            Ok((self.todo_update_priority_native(input)?, target))
        })
    }
    pub fn todo_add_progress(&self, input: TodoAddProgressInput) -> Result<TodoProgressRecord> {
        let target = NativeTarget::todo(&self.todo_record(input.todo_id)?);
        self.native_source_write("todo.subtask.create", Some(target.clone()), || {
            Ok((self.todo_add_progress_native(input)?, target))
        })
    }
    pub fn todo_update_progress(
        &self,
        input: TodoUpdateProgressInput,
    ) -> Result<TodoProgressRecord> {
        let todo_id = self.todo_progress_record(input.progress_id)?.todo_id;
        let target = NativeTarget::todo(&self.todo_record(todo_id)?);
        self.native_source_write("todo.subtask.update", Some(target.clone()), || {
            Ok((self.todo_update_progress_native(input)?, target))
        })
    }
    pub fn todo_delete_progress(
        &self,
        input: TodoDeleteProgressInput,
    ) -> Result<TodoProgressRecord> {
        let todo_id = self.todo_progress_record(input.progress_id)?.todo_id;
        let target = NativeTarget::todo(&self.todo_record(todo_id)?);
        self.native_source_write("todo.subtask.delete", Some(target.clone()), || {
            Ok((self.todo_delete_progress_native(input)?, target))
        })
    }
    pub fn todo_delete(&self, input: TodoDeleteInput) -> Result<TodoRecord> {
        let target = NativeTarget::todo(&self.todo_record(input.todo_id)?);
        self.native_source_write("todo.delete", Some(target.clone()), || {
            Ok((self.todo_delete_native(input)?, target))
        })
    }
    pub fn workspace_quick_note_upsert(
        &self,
        input: WorkspaceQuickNoteUpsertInput,
    ) -> Result<WorkspaceRecord> {
        let before = self
            .workspace_quick_note_get()?
            .map(|note| NativeTarget::workspace_quick_note(note.id));
        self.native_source_write("quick_note.write", before, || {
            let result = self.workspace_quick_note_upsert_native(input)?;
            let target = NativeTarget::workspace_quick_note(result.id);
            Ok((result, target))
        })
    }
    pub fn project_set_archive(&self, input: ProjectArchiveInput) -> Result<ProjectRecord> {
        self.file_version_recover_pending()?;
        let _file_project_lock = self.file_project_lock(input.project_id, true)?;
        let target = NativeTarget {
            kind: ObjectKind::Project,
            scope: Scope::Project {
                project_id: input.project_id,
            },
            id: input.project_id,
        };
        self.native_source_write("project.archive", Some(target.clone()), || {
            let result = self.project_set_archive_native(input)?;
            if result.is_archived {
                self.conn.execute("UPDATE agent_jobs SET state='cancelled',error=NULL WHERE kind='extract' AND scope_key=?1 AND state IN ('queued','running')", [target.scope.key()])?;
            }
            Ok((result, target))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::Database;
    use super::*;
    use crate::workspace;

    fn workspace_db() -> (tempfile::TempDir, Database, String) {
        let root = tempfile::tempdir().unwrap();
        let (metadata, paths) = workspace::create_workspace(root.path(), "test-password").unwrap();
        let db = Database::open(&paths.db_path, root.path(), None).unwrap();
        (root, db, metadata.workspace_id)
    }

    fn todo_input() -> TodoCreateInput {
        TodoCreateInput {
            scope: TodoScope::Workspace,
            project_id: None,
            content: "first".into(),
            priority: "not_urgent_important".into(),
            due_date: None,
            tag_ids: vec![],
        }
    }

    #[test]
    fn native_todo_write_has_real_identity_and_atomic_outbox() {
        let (_root, db, workspace_id) = workspace_db();
        let todo = db.todo_create(todo_input()).unwrap();
        let (key, revision): (String, String) = db
            .conn
            .query_row(
                "SELECT object_key,revision FROM agent_change_log",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(key, format!("{workspace_id}/workspace/todo/{}", todo.id));
        assert!(revision.starts_with("sha256:"));
        db.conn.execute_batch("CREATE TRIGGER fail_native_outbox BEFORE INSERT ON agent_change_log BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
        assert!(db
            .todo_update_content(TodoUpdateContentInput {
                todo_id: todo.id,
                content: "lost".into(),
                due_date: None,
                tag_ids: vec![]
            })
            .is_err());
        assert_eq!(db.todo_record(todo.id).unwrap().content, "first");
        assert!(db.todo_create(todo_input()).is_err());
        assert!(db
            .todo_delete(TodoDeleteInput { todo_id: todo.id })
            .is_err());
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM todos", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM agent_change_log", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    fn request(workspace_id: &str, project_ids: Vec<i64>) -> crate::agent::access::RequestContext {
        use crate::agent::{access::*, models::WorkspaceBinding};
        RequestContext {
            binding: WorkspaceBinding {
                workspace_id: workspace_id.into(),
                generation: "test-generation".into(),
            },
            caller: Caller::Gui,
            request_id: "native-test".into(),
            scope_grant: ScopeGrant {
                workspace_id: workspace_id.into(),
                workspace_content: true,
                project_ids,
                operations: vec!["source.read".into()],
            },
        }
    }

    fn assert_latest_matches_source(
        db: &Database,
        request: &crate::agent::access::RequestContext,
        kind: ObjectKind,
        scope: Scope,
        id: i64,
    ) {
        let object = ObjectRef {
            workspace_id: request.binding.workspace_id.clone(),
            scope,
            kind,
            id: id.to_string(),
        };
        let snapshot = db
            .source_native_snapshot(
                request,
                &request.binding,
                &crate::source_service::SourceReadTarget {
                    object: object.clone(),
                    revision: None,
                    record_version: None,
                    file_version: None,
                },
            )
            .unwrap();
        let (key, revision): (String, String) = db
            .conn
            .query_row(
                "SELECT object_key,revision FROM agent_change_log ORDER BY seq DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(key, object.key().unwrap());
        assert_eq!(revision, snapshot.revision);
    }

    #[test]
    fn native_todo_subtasks_tags_and_deletion_feed_shared_queue() {
        let (_root, mut db, workspace_id) = workspace_db();
        let req = request(&workspace_id, vec![]);
        let todo = db.todo_create(todo_input()).unwrap();
        let tag = db
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                id: None,
                project_id: None,
                label: "tag".into(),
                color_key: "blue".into(),
            })
            .unwrap();
        db.todo_update_tags(TodoUpdateTagsInput {
            todo_id: todo.id,
            tag_ids: vec![tag.id],
        })
        .unwrap();
        assert_latest_matches_source(&db, &req, ObjectKind::Todo, Scope::Workspace, todo.id);
        db.todo_update_status(TodoUpdateStatusInput {
            todo_id: todo.id,
            status: "finished".into(),
        })
        .unwrap();
        db.todo_update_priority(TodoUpdatePriorityInput {
            todo_id: todo.id,
            priority: "urgent_important".into(),
        })
        .unwrap();
        let subtask = db
            .todo_add_progress(TodoAddProgressInput {
                todo_id: todo.id,
                content: "child".into(),
                progress_date: "2026-10-01".into(),
                due_date: None,
            })
            .unwrap();
        assert_latest_matches_source(&db, &req, ObjectKind::Todo, Scope::Workspace, todo.id);
        db.todo_update_progress(TodoUpdateProgressInput {
            progress_id: subtask.id,
            content: "done".into(),
            progress_date: "2026-10-01".into(),
            due_date: Some("2026-10-02".into()),
            status: Some("finished".into()),
        })
        .unwrap();
        assert_latest_matches_source(&db, &req, ObjectKind::Todo, Scope::Workspace, todo.id);
        db.todo_delete_progress(TodoDeleteProgressInput {
            progress_id: subtask.id,
        })
        .unwrap();
        assert_latest_matches_source(&db, &req, ObjectKind::Todo, Scope::Workspace, todo.id);
        db.source_queue_sync(&req, &req.binding, &Scope::Workspace, chrono::Utc::now())
            .unwrap();
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM agent_jobs WHERE kind='extract' AND state='queued'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        db.todo_delete(TodoDeleteInput { todo_id: todo.id })
            .unwrap();
        db.source_queue_sync(&req, &req.binding, &Scope::Workspace, chrono::Utc::now())
            .unwrap();
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT state FROM agent_jobs WHERE kind='extract'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "cancelled"
        );
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT revision FROM agent_change_log ORDER BY seq DESC LIMIT 1",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "deleted"
        );
    }

    #[test]
    fn native_quick_note_is_not_a_record_and_redundant_markdown_is_no_change() {
        let (_root, db, workspace_id) = workspace_db();
        let req = request(&workspace_id, vec![]);
        let mut input = WorkspaceQuickNoteUpsertInput {
            markdown: "first".into(),
            html: "<p>first</p>".into(),
            default_code_language: None,
            tag_ids: vec![],
        };
        let note = db.workspace_quick_note_upsert(input.clone()).unwrap();
        assert_latest_matches_source(&db, &req, ObjectKind::QuickNote, Scope::Workspace, note.id);
        let watermark = db.committed_change_watermark().unwrap();
        input.markdown = "redundant export".into();
        db.workspace_quick_note_upsert(input.clone()).unwrap();
        assert_eq!(db.committed_change_watermark().unwrap(), watermark);
        db.conn.execute_batch("CREATE TRIGGER fail_native_outbox BEFORE INSERT ON agent_change_log BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
        input.html = "<p>lost</p>".into();
        assert!(db.workspace_quick_note_upsert(input).is_err());
        assert_eq!(
            db.workspace_quick_note_get().unwrap().unwrap().content_html,
            "<p>first</p>"
        );
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM record_document_heads", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn native_archive_and_capture_only_describe_committed_rows() {
        let (_root, mut db, workspace_id) = workspace_db();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Native".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let req = request(&workspace_id, vec![project.id]);
        let (result, event) = crate::committed_changes::capture_native_committed(
            &req.binding,
            &mut db,
            "archive",
            |db| {
                db.project_set_archive(ProjectArchiveInput {
                    project_id: project.id,
                    is_archived: true,
                })
            },
        )
        .unwrap();
        assert!(result.unwrap().is_archived);
        let event = event.unwrap();
        assert_eq!(event.changed_refs.len(), 1);
        assert_eq!(event.changed_refs[0].kind, ObjectKind::Project);
        assert_eq!(event.binding, req.binding);
        assert!(event.record_heads.is_empty());
        let watermark = db.committed_change_watermark().unwrap();
        db.project_set_archive(ProjectArchiveInput {
            project_id: project.id,
            is_archived: true,
        })
        .unwrap();
        assert_eq!(db.committed_change_watermark().unwrap(), watermark);
        db.conn.execute_batch("CREATE TRIGGER fail_native_outbox BEFORE INSERT ON agent_change_log BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
        let (result, event) = crate::committed_changes::capture_native_committed(
            &req.binding,
            &mut db,
            "unarchive",
            |db| {
                db.project_set_archive(ProjectArchiveInput {
                    project_id: project.id,
                    is_archived: false,
                })
            },
        )
        .unwrap();
        assert!(result.is_err());
        assert!(event.is_none());
        assert!(db.project_record(project.id).unwrap().is_archived);
    }

    #[test]
    fn native_project_rename_commits_both_identities_and_restores_directory_on_outbox_failure() {
        let (root, mut db, workspace_id) = workspace_db();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Before".into(),
                summary: Some("quick".into()),
                status: None,
            })
            .unwrap();
        let req = request(&workspace_id, vec![project.id]);
        let input = ProjectUpdateInput {
            project_id: project.id,
            name: Some("After".into()),
            summary: project.summary.clone(),
            summary_markdown: None,
            summary_html: None,
            summary_code_language: None,
            status: None,
        };
        let watermark = db.committed_change_watermark().unwrap();
        db.conn.execute_batch("CREATE TRIGGER fail_native_outbox BEFORE INSERT ON agent_change_log BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
        assert!(db.project_update(input.clone()).is_err());
        assert_eq!(db.project_record(project.id).unwrap().name, "Before");
        assert!(std::path::Path::new(&project.root_path).is_dir());
        assert!(!root
            .path()
            .join(super::super::project_directory_name("After").unwrap())
            .exists());
        assert_eq!(db.committed_change_watermark().unwrap(), watermark);
        db.conn
            .execute_batch("DROP TRIGGER fail_native_outbox")
            .unwrap();
        let (result, event) = crate::committed_changes::capture_native_committed(
            &req.binding,
            &mut db,
            "rename",
            |db| db.project_update(input.clone()),
        )
        .unwrap();
        let result = result.unwrap();
        assert!(!std::path::Path::new(&project.root_path).exists());
        assert!(std::path::Path::new(&result.root_path).is_dir());
        let event = event.unwrap();
        assert_eq!(event.changed_refs.len(), 2);
        assert_eq!(event.changed_refs[0].kind, ObjectKind::Project);
        assert_eq!(event.changed_refs[1].kind, ObjectKind::QuickNote);
        assert_latest_matches_source(
            &db,
            &req,
            ObjectKind::QuickNote,
            Scope::Project {
                project_id: project.id,
            },
            project.id,
        );
        let watermark = db.committed_change_watermark().unwrap();
        db.project_update(input).unwrap();
        assert_eq!(db.committed_change_watermark().unwrap(), watermark);
        let mut input = ProjectUpdateInput {
            project_id: project.id,
            name: None,
            summary: "changed".into(),
            summary_markdown: None,
            summary_html: None,
            summary_code_language: None,
            status: None,
        };
        db.project_update(input.clone()).unwrap();
        assert_eq!(db.committed_change_watermark().unwrap(), watermark + 1);
        assert_latest_matches_source(
            &db,
            &req,
            ObjectKind::QuickNote,
            Scope::Project {
                project_id: project.id,
            },
            project.id,
        );
        input.summary_markdown = Some("redundant".into());
        input.summary_html = Some("<p>changed</p>".into());
        db.project_update(input).unwrap();
        assert_eq!(db.committed_change_watermark().unwrap(), watermark + 1);
    }

    #[test]
    fn native_project_create_and_cascade_delete_roll_back_outbox_failures() {
        let (root, mut db, workspace_id) = workspace_db();
        let input = ProjectCreateInput {
            name: "Cascade".into(),
            summary: None,
            status: None,
        };
        db.conn.execute_batch("CREATE TRIGGER fail_native_outbox BEFORE INSERT ON agent_change_log BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
        assert!(db.project_create(input.clone()).is_err());
        assert!(!root
            .path()
            .join(super::super::project_directory_name("Cascade").unwrap())
            .exists());
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM projects", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        db.conn
            .execute_batch("DROP TRIGGER fail_native_outbox")
            .unwrap();
        let project = db.project_create(input).unwrap();
        let mut input = todo_input();
        input.scope = TodoScope::Project;
        input.project_id = Some(project.id);
        let todo = db.todo_create(input).unwrap();
        let watermark = db.committed_change_watermark().unwrap();
        db.conn.execute_batch("CREATE TRIGGER fail_native_outbox BEFORE INSERT ON agent_change_log BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
        assert!(db
            .project_delete(ProjectDeleteInput {
                project_id: project.id
            })
            .is_err());
        assert!(db.project_record(project.id).is_ok());
        assert!(db.todo_record(todo.id).is_ok());
        assert_eq!(db.committed_change_watermark().unwrap(), watermark);
        db.conn
            .execute_batch("DROP TRIGGER fail_native_outbox")
            .unwrap();
        db.project_delete(ProjectDeleteInput {
            project_id: project.id,
        })
        .unwrap();
        let binding = request(&workspace_id, vec![project.id]).binding;
        let changes = db
            .committed_changes_since(&binding, "delete", watermark)
            .unwrap()
            .unwrap();
        assert_eq!(changes.changed_refs.len(), 3);
        assert!(changes.changed_refs.iter().all(|object| object.scope
            == Scope::Project {
                project_id: project.id
            }));
        assert!(changes
            .changed_refs
            .iter()
            .any(|object| object.kind == ObjectKind::Todo && object.id == todo.id.to_string()));
        assert!(db.todo_record(todo.id).is_err());
        assert!(db.project_record(project.id).is_err());
    }

    #[test]
    fn native_final_uses_voice_id_and_duplicate_delivery_never_relogs() {
        let (_root, mut db, workspace_id) = workspace_db();
        db.workspace_record_upsert(WorkspaceRecordUpsertInput {
            note_id: None,
            title: Some("ordinary".into()),
            markdown: "body".into(),
            html: "<p>body</p>".into(),
            default_code_language: None,
            tag_ids: vec![],
        })
        .unwrap();
        let session = db
            .voice_session_create(
                &crate::voice::contracts::RecordTarget::Workspace,
                "voice-start",
                "native-final",
                "Voice",
            )
            .unwrap();
        let voice_id: i64 = db
            .conn
            .query_row(
                "SELECT voice_record_id FROM recording_sessions WHERE id=?1",
                [&session.session_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_ne!(voice_id, session.workspace_note_id.unwrap());
        let req = request(&workspace_id, vec![]);
        let (result, changes) = crate::committed_changes::capture_native_committed(
            &req.binding,
            &mut db,
            "final",
            |db| {
                db.voice_transcript_append_final(
                    &session.session_id,
                    "one",
                    0,
                    100,
                    "original",
                    None,
                )
            },
        )
        .unwrap();
        let first = result.unwrap();
        let changes = changes.unwrap();
        assert_eq!(changes.changed_refs.len(), 1);
        assert_eq!(changes.changed_refs[0].kind, ObjectKind::Transcript);
        assert_eq!(changes.changed_refs[0].id, voice_id.to_string());
        assert!(changes.record_heads.is_empty());
        let watermark = db.committed_change_watermark().unwrap();
        assert_eq!(
            db.voice_transcript_append_final(&session.session_id, "one", 0, 100, "original", None)
                .unwrap()
                .id,
            first.id
        );
        assert!(db
            .voice_transcript_append_final(&session.session_id, "one", 0, 100, "conflict", None)
            .is_err());
        assert_eq!(db.committed_change_watermark().unwrap(), watermark);
        db.conn.execute_batch("CREATE TRIGGER fail_native_outbox BEFORE INSERT ON agent_change_log BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
        assert!(db
            .voice_transcript_append_final(&session.session_id, "two", 100, 200, "lost", None)
            .is_err());
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM voice_transcript_segments", [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
        assert_eq!(db.committed_change_watermark().unwrap(), watermark);
    }

    #[test]
    fn native_subtask_and_tag_outbox_failures_restore_parent_and_links() {
        let (_root, mut db, _workspace_id) = workspace_db();
        let tag = db
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                id: None,
                project_id: None,
                label: "tag".into(),
                color_key: "blue".into(),
            })
            .unwrap();
        let mut input = todo_input();
        input.tag_ids = vec![tag.id];
        let todo = db.todo_create(input).unwrap();
        let subtask = db
            .todo_add_progress(TodoAddProgressInput {
                todo_id: todo.id,
                content: "child".into(),
                progress_date: "2026-10-01".into(),
                due_date: None,
            })
            .unwrap();
        let before = db.todo_record(todo.id).unwrap();
        let watermark = db.committed_change_watermark().unwrap();
        db.conn.execute_batch("CREATE TRIGGER fail_native_outbox BEFORE INSERT ON agent_change_log BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
        assert!(db
            .todo_update_tags(TodoUpdateTagsInput {
                todo_id: todo.id,
                tag_ids: vec![]
            })
            .is_err());
        assert!(db
            .todo_update_status(TodoUpdateStatusInput {
                todo_id: todo.id,
                status: "finished".into()
            })
            .is_err());
        assert!(db
            .todo_update_priority(TodoUpdatePriorityInput {
                todo_id: todo.id,
                priority: "urgent_important".into()
            })
            .is_err());
        assert!(db
            .todo_add_progress(TodoAddProgressInput {
                todo_id: todo.id,
                content: "lost".into(),
                progress_date: "2026-10-01".into(),
                due_date: None
            })
            .is_err());
        assert!(db
            .todo_update_progress(TodoUpdateProgressInput {
                progress_id: subtask.id,
                content: "lost".into(),
                progress_date: "2026-10-01".into(),
                due_date: None,
                status: Some("finished".into())
            })
            .is_err());
        assert!(db
            .todo_delete_progress(TodoDeleteProgressInput {
                progress_id: subtask.id
            })
            .is_err());
        let after = db.todo_record(todo.id).unwrap();
        assert_eq!(
            source_native::todo_revision(&before),
            source_native::todo_revision(&after)
        );
        assert_eq!(before.updated_at, after.updated_at);
        assert_eq!(db.committed_change_watermark().unwrap(), watermark);
    }
}
