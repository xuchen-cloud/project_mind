//! Native business fields as sources; no paths or QuickNote body are included
//! in a Project identity snapshot.
use super::Database;
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, WorkspaceBinding},
    },
    source_native::{NativeQuickNoteSnapshot, NativeSourceSnapshot},
    source_service::SourceReadTarget,
};
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};
impl Database {
    pub(crate) fn source_quick_note_snapshot(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &SourceReadTarget,
    ) -> AgentResult<NativeQuickNoteSnapshot> {
        let object = self.source_read_object(request, binding, &input.object)?;
        if object.kind != ObjectKind::QuickNote
            || input.record_version.is_some()
            || input.file_version.is_some()
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid QuickNote source target",
            ));
        }
        let (title, html, markdown, code_language, updated_at): (String,String,String,Option<String>,String) = match object.scope {
            crate::agent::models::Scope::Project {..} => self.conn.query_row(
                "SELECT name,summary_html,summary_markdown,quick_note_code_language,updated_at FROM projects WHERE id=?1",
                [&object.id], |row| Ok((format!("{} · QuickNote（临时想法）", row.get::<_,String>(0)?), row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            ),
            crate::agent::models::Scope::Workspace => self.conn.query_row(
                "SELECT content_html,content_markdown,default_code_language,updated_at FROM workspace_notes WHERE id=?1 AND note_kind='today_quick_note'",
                [&object.id], |row| Ok(("Workspace QuickNote（临时想法）".into(), row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            ),
        }.map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot read committed QuickNote"))?;
        let html = if html.is_empty() {
            super::rich_text_html_from_markdown(&markdown)
        } else {
            html
        };
        let mut tag_ids = vec![];
        if object.scope == crate::agent::models::Scope::Workspace {
            let mut statement = self.conn.prepare("SELECT tag_id FROM workspace_note_tag_links WHERE workspace_note_id=?1 ORDER BY tag_id")
                .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot read QuickNote metadata"))?;
            tag_ids = statement
                .query_map([&object.id], |row| row.get::<_, i64>(0))
                .map_err(|_| {
                    AgentError::new(ErrorCode::IoFailed, "Cannot read QuickNote metadata")
                })?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| {
                    AgentError::new(ErrorCode::IoFailed, "Cannot read QuickNote metadata")
                })?;
        }
        // The durable HTML is already Committed Content with Workspace-relative
        // resources. Redundant Markdown and timestamps do not mint revisions.
        let revision = format!(
            "sha256:{:x}",
            Sha256::digest(
                serde_json::json!({
                    "html":html,"codeLanguage":code_language,"title":title,"tagIds":tag_ids
                })
                .to_string()
            )
        );
        if input
            .revision
            .as_ref()
            .is_some_and(|expected| expected != &revision)
        {
            return Err(AgentError::new(
                ErrorCode::SourceChanged,
                "QuickNote source revision changed",
            ));
        }
        Ok(NativeQuickNoteSnapshot {
            source: NativeSourceSnapshot {
                object,
                revision,
                title,
                paragraphs: vec![],
                locators: vec![],
                updated_at,
            },
            html,
            code_language,
        })
    }
    pub(super) fn source_prune_native_cache(
        &self,
        binding: &WorkspaceBinding,
        scope: &crate::agent::models::Scope,
    ) -> AgentResult<()> {
        let project_id = match scope {
            crate::agent::models::Scope::Project { project_id } => Some(*project_id),
            _ => None,
        };
        self.conn.execute(
            "DELETE FROM source_index_snapshots AS s WHERE s.workspace_id=?1 AND s.scope_key=?2
             AND json_extract(s.object_json,'$.kind')='project'
             AND (s.version!=0 OR NOT EXISTS(SELECT 1 FROM projects p
                 WHERE CAST(p.id AS TEXT)=json_extract(s.object_json,'$.id') AND p.id=?3 AND p.is_archived=0)
                 OR EXISTS(SELECT 1 FROM source_access_policies x WHERE x.object_key=s.object_key AND x.excluded=1))",
            rusqlite::params![binding.workspace_id, scope.key(), project_id],
        ).map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot clean native source cache"))?;
        self.conn.execute(
            "DELETE FROM source_index_snapshots AS s WHERE s.workspace_id=?1 AND s.scope_key=?2
             AND json_extract(s.object_json,'$.kind')='todo'
             AND (s.version!=0 OR NOT EXISTS(SELECT 1 FROM todos t
                 WHERE CAST(t.id AS TEXT)=json_extract(s.object_json,'$.id')
                 AND ((?3 IS NULL AND t.scope='workspace' AND t.project_id IS NULL)
                     OR (t.scope='project' AND t.project_id=?3)))
                 OR EXISTS(SELECT 1 FROM source_access_policies x WHERE x.object_key=s.object_key AND x.excluded=1))",
            rusqlite::params![binding.workspace_id, scope.key(), project_id],
        ).map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot clean Todo source cache"))?;
        self.conn.execute(
            "DELETE FROM source_index_snapshots AS s WHERE s.workspace_id=?1 AND s.scope_key=?2
             AND json_extract(s.object_json,'$.kind')='quick_note'
             AND (s.version!=0 OR NOT ((?3 IS NULL AND EXISTS(SELECT 1 FROM workspace_notes n
                 WHERE CAST(n.id AS TEXT)=json_extract(s.object_json,'$.id') AND n.note_kind='today_quick_note'))
                 OR (?3 IS NOT NULL AND EXISTS(SELECT 1 FROM projects p WHERE p.id=?3 AND p.is_archived=0
                     AND CAST(p.id AS TEXT)=json_extract(s.object_json,'$.id'))))
                 OR EXISTS(SELECT 1 FROM source_access_policies x WHERE x.object_key=s.object_key AND x.excluded=1))",
            rusqlite::params![binding.workspace_id, scope.key(), project_id],
        ).map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot clean QuickNote source cache"))?;
        self.source_prune_transcript_cache(binding, scope)?;
        Ok(())
    }
    pub(crate) fn source_index_native(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        source: &SourceReadTarget,
        cached: &crate::source_search_index::IndexSource,
    ) -> AgentResult<()> {
        let current = self.source_native_snapshot(request, binding, source)?;
        if current.revision != cached.revision {
            return Err(AgentError::new(
                ErrorCode::SourceChanged,
                "Native source changed before indexing",
            ));
        }
        if cached.object != current.object || cached.version.is_some() || !cached.current {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid native index ownership",
            ));
        }
        crate::source_search_index::SourceIndex::prepare(&self.conn)?.replace(cached)
    }
    pub(crate) fn source_native_snapshot(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &SourceReadTarget,
    ) -> AgentResult<NativeSourceSnapshot> {
        if input.object.kind == ObjectKind::Transcript {
            return self.source_transcript_snapshot(request, binding, input);
        }
        if input.object.kind == ObjectKind::QuickNote {
            return Ok(self
                .source_quick_note_snapshot(request, binding, input)?
                .source);
        }
        let object = self.source_read_object(request, binding, &input.object)?;
        if !matches!(object.kind, ObjectKind::Project | ObjectKind::Todo)
            || input.record_version.is_some()
            || input.file_version.is_some()
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid native source target",
            ));
        }
        if object.kind == ObjectKind::Todo {
            let todo = self
                .todo_record(
                    object.id.parse().map_err(|_| {
                        AgentError::new(ErrorCode::InvalidArgument, "Invalid Todo ID")
                    })?,
                )
                .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot read Todo source"))?;
            let mut tag_ids: Vec<_> = todo.tags.iter().map(|tag| tag.id).collect();
            tag_ids.sort_unstable();
            let subtasks: Vec<_> = todo.progresses.iter().map(|subtask| serde_json::json!({
                "id":subtask.id, "content":subtask.content, "status":subtask.status, "dueDate":subtask.due_date,
                "order":subtask.order_index, "date":subtask.progress_date, "completedAt":subtask.completed_at
            })).collect();
            let revision = format!("sha256:{:x}", Sha256::digest(serde_json::json!({
                "content":todo.content,"status":todo.status,"priority":todo.priority,"dueDate":todo.due_date,
                "tagIds":tag_ids, "subtasks":subtasks
            }).to_string()));
            if input
                .revision
                .as_ref()
                .is_some_and(|expected| expected != &revision)
            {
                return Err(AgentError::new(
                    ErrorCode::SourceChanged,
                    "Todo source revision changed",
                ));
            }
            let mut paragraphs = vec![
                format!("待办：{}", todo.content),
                format!("状态：{}", todo.status),
                format!("优先级：{}", todo.priority),
                format!("期限：{}", todo.due_date.as_deref().unwrap_or("未设置")),
            ];
            paragraphs.extend(todo.progresses.iter().map(|subtask| {
                format!(
                    "子任务 {}：{}\n状态：{}\n期限：{}",
                    subtask.id,
                    subtask.content,
                    subtask.status,
                    subtask.due_date.as_deref().unwrap_or("未设置")
                )
            }));
            return Ok(NativeSourceSnapshot {
                object,
                revision,
                title: todo.content,
                paragraphs,
                locators: vec![],
                updated_at: todo.updated_at,
            });
        }
        let row: Option<(String, String, bool, String)> = self
            .conn
            .query_row(
                "SELECT name,status,is_archived,updated_at FROM projects WHERE id=?1",
                [&object.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot read Project source"))?;
        let (name, status, archived, updated_at) = row.ok_or_else(|| {
            AgentError::new(ErrorCode::NotFound, "Project source is no longer present")
        })?;
        let revision = format!(
            "sha256:{:x}",
            Sha256::digest(
                serde_json::json!({"name":name,"status":status,"archived":archived}).to_string()
            )
        );
        if input
            .revision
            .as_ref()
            .is_some_and(|expected| expected != &revision)
        {
            return Err(AgentError::new(
                ErrorCode::SourceChanged,
                "Project source revision changed",
            ));
        }
        Ok(NativeSourceSnapshot {
            object,
            revision,
            title: name.clone(),
            locators: vec![],
            updated_at,
            paragraphs: vec![
                format!("名称：{name}"),
                format!("状态：{status}"),
                format!("归档：{archived}"),
            ],
        })
    }
}
