//! File metadata inventory. No paths or file bytes cross this boundary.
use super::{agent_operations::io_error, Database};
use crate::agent::{
    access::RequestContext,
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
    record_list::RecordListInput,
};
use rusqlite::params;
use serde_json::{json, Value};

impl Database {
    pub(crate) fn agent_session_inventory_authorize(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        scope: &Scope,
    ) -> AgentResult<()> {
        request.authorize(binding, scope, "session.read")?;
        request.require_scope_context()?;
        self.source_live_scope(scope)?;
        if self
            .native_workspace_id
            .as_deref()
            .is_some_and(|id| id != binding.workspace_id)
        {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Session Workspace changed",
            ));
        }
        Ok(())
    }
    pub(crate) fn agent_file_inventory(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &RecordListInput,
    ) -> AgentResult<(i64, Vec<Value>)> {
        request.authorize(binding, &input.scope, "source.read")?;
        self.source_live_scope(&input.scope)?;
        self.source_prepare()?;
        if self
            .native_workspace_id
            .as_deref()
            .is_some_and(|id| id != binding.workspace_id)
        {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "File Workspace changed",
            ));
        }
        let seq = self
            .conn
            .query_row(
                "SELECT total_changes() + data_version FROM pragma_data_version",
                [],
                |r| r.get(0),
            )
            .map_err(io_error)?;
        let Scope::Project { project_id } = input.scope else {
            return Ok((seq, vec![]));
        };
        let objects = request
            .scope_grant
            .object_keys
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot encode grant"))?;
        let ids = serde_json::to_string(&input.ids).expect("IDs serialize");
        let tags = serde_json::to_string(&input.tag_ids).expect("tag IDs serialize");
        let mut stmt=self.conn.prepare(r#"
            SELECT d.id,d.name,d.mime_type,d.current_version_number,d.created_at,d.updated_at,d.health
            FROM agent_visible_files d WHERE d.project_id=?1 AND d.storage_mode!='managed_note_image'
            AND (?2 IS NULL OR ?3||'/'||?4||'/file/'||d.id IN (SELECT value FROM json_each(?2)))
            AND NOT EXISTS(SELECT 1 FROM source_access_policies p WHERE p.object_key=?3||'/'||?4||'/file/'||d.id AND p.excluded=1)
            AND (json_array_length(?5)=0 OR CAST(d.id AS TEXT) IN (SELECT value FROM json_each(?5)))
            AND (?6 IS NULL OR instr(lower(d.name),lower(?6))>0)
            AND (?7 IS NULL OR EXISTS(SELECT 1 FROM document_tag_links l JOIN file_tag_options t ON t.id=l.tag_id WHERE l.document_id=d.id AND t.label=?7))
            AND NOT EXISTS(SELECT 1 FROM json_each(?8) wanted WHERE NOT EXISTS(SELECT 1 FROM document_tag_links l WHERE l.document_id=d.id AND l.tag_id=wanted.value))
            ORDER BY d.id
        "#).map_err(io_error)?;
        let rows = stmt
            .query_map(
                params![
                    project_id,
                    objects,
                    binding.workspace_id,
                    input.scope.key(),
                    ids,
                    input.title_query,
                    input.tag,
                    tags
                ],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, String>(6)?,
                    ))
                },
            )
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error)?;
        let mut items = vec![];
        for (id, title, mime, version, created, updated, health) in rows {
            let object = ObjectRef {
                workspace_id: binding.workspace_id.clone(),
                scope: input.scope.clone(),
                kind: ObjectKind::File,
                id: id.to_string(),
            };
            self.source_read_object(request, binding, &object)?;
            let tags = self
                .fetch_document_tags(id)
                .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot read File tags"))?;
            items.push(json!({"object":object,"title":title,"mimeType":mime,"currentVersionNumber":version,"createdAt":created,"updatedAt":updated,"health":health,"tags":tags}));
        }
        Ok((seq, items))
    }
}
