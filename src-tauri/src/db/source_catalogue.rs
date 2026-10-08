//! One metadata-only source catalogue shared by indexing and Overview inventory.
use super::{agent_operations::io_error, Database};
use crate::agent::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::Scope,
};
use rusqlite::params;

impl Database {
    pub(crate) fn agent_source_catalogue_page(
        &self,
        workspace_id: &str,
        scope: &Scope,
        after_kind: &str,
        after_id: i64,
        limit: u16,
        include_excluded: bool,
    ) -> AgentResult<Vec<(String, i64, bool)>> {
        scope.validate()?;
        self.source_live_scope(scope)?;
        if workspace_id.is_empty()
            || workspace_id.len() > 128
            || !workspace_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid Workspace identity",
            ));
        }
        if self
            .native_workspace_id
            .as_deref()
            .is_some_and(|id| id != workspace_id)
        {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Source catalogue Workspace is no longer current",
            ));
        }
        if !(1..=201).contains(&limit)
            || after_id < 0
            || (!after_kind.is_empty()
                && ![
                    "file",
                    "project",
                    "quick_note",
                    "record",
                    "todo",
                    "transcript",
                ]
                .contains(&after_kind))
            || (after_kind.is_empty() && after_id != 0)
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid source catalogue page",
            ));
        }
        self.source_prepare()?;
        let project_id = match scope {
            Scope::Project { project_id } => Some(*project_id),
            _ => None,
        };
        let mut statement=self.conn.prepare("WITH catalogue(kind,id) AS (
            SELECT 'record',id FROM agent_visible_workspace_notes WHERE ?1 IS NULL AND note_kind='workspace_note'
            UNION ALL SELECT 'quick_note',id FROM workspace_notes WHERE ?1 IS NULL AND note_kind='today_quick_note'
            UNION ALL SELECT 'todo',id FROM agent_visible_todos WHERE (?1 IS NULL AND scope='workspace' AND project_id IS NULL) OR (scope='project' AND project_id=?1)
            UNION ALL SELECT 'project',id FROM projects WHERE id=?1 AND is_archived=0
            UNION ALL SELECT 'quick_note',id FROM projects WHERE id=?1 AND is_archived=0
            UNION ALL SELECT 'record',id FROM agent_visible_notes WHERE project_id=?1
            UNION ALL SELECT 'file',id FROM documents WHERE project_id=?1 AND storage_mode!='managed_note_image'
            UNION ALL SELECT 'transcript',v.id FROM voice_records v LEFT JOIN agent_visible_notes n ON n.id=v.project_note_id LEFT JOIN agent_visible_workspace_notes w ON w.id=v.workspace_note_id WHERE (?1 IS NULL AND w.id IS NOT NULL) OR n.project_id=?1
            ), owned AS (SELECT kind,id,EXISTS(SELECT 1 FROM source_access_policies x WHERE x.object_key=?4 || '/' || ?5 || '/' || kind || '/' || CAST(id AS TEXT) AND x.excluded=1) AS excluded FROM catalogue)
            SELECT kind,id,excluded FROM owned WHERE (kind>?2 OR (kind=?2 AND id>?3)) AND (?7 OR excluded=0) ORDER BY kind,id LIMIT ?6").map_err(io_error)?;
        let result = statement
            .query_map(
                params![
                    project_id,
                    after_kind,
                    after_id,
                    workspace_id,
                    scope.key(),
                    limit,
                    include_excluded
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, bool>(2)?,
                    ))
                },
            )
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error);
        result
    }
}
