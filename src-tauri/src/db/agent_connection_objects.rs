//! Trusted GUI metadata selector for object-limited connection grants.
use super::{agent_operations::io_error, Database};
use crate::agent::{
    connections::{ConnectionObjectOption, ConnectionObjectPage, ConnectionObjectsInput},
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::params;
use serde::{Deserialize, Serialize};

const PAGE_SIZE: usize = 20;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    workspace_id: String,
    scope: Scope,
    query: String,
    kind: String,
    id: i64,
}

fn invalid() -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, "Invalid connection object selector")
}

fn like_pattern(query: &str) -> String {
    let escaped = query.replace('!', "!!").replace('%', "!%").replace('_', "!_");
    format!("%{escaped}%")
}

fn decode_cursor(raw: &str, binding: &WorkspaceBinding, input: &ConnectionObjectsInput) -> AgentResult<(String, i64)> {
    if raw.len() > 2048 { return Err(invalid()); }
    let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| invalid())?;
    let cursor: Cursor = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if cursor.workspace_id != binding.workspace_id || cursor.scope != input.scope || cursor.query != input.query
        || !matches!(cursor.kind.as_str(), "file" | "record") || cursor.id <= 0 {
        return Err(invalid());
    }
    Ok((cursor.kind, cursor.id))
}

// Only current native metadata is selected. Visibility views hide withdrawn
// objects; source policy applies to each selected object.
const PROJECT_SQL: &str = r#"
WITH candidates AS (
 SELECT 'record' kind,n.id id,coalesce(n.title,'') title,
        ?2||'/project:'||?1||'/record/'||n.id object_key
 FROM agent_visible_notes n JOIN projects p ON p.id=n.project_id AND p.is_archived=0
 WHERE n.project_id=?1
 UNION ALL
 SELECT 'file',f.id,f.name,?2||'/project:'||?1||'/file/'||f.id
 FROM agent_visible_files f JOIN projects p ON p.id=f.project_id AND p.is_archived=0
 WHERE f.project_id=?1 AND f.storage_mode!='managed_note_image'
)
SELECT kind,id,substr(title,1,120) FROM candidates c
WHERE title LIKE ?3 ESCAPE '!'
 AND (kind>?4 OR (kind=?4 AND id>?5))
 AND NOT EXISTS(SELECT 1 FROM source_access_policies x WHERE x.object_key=c.object_key AND x.excluded=1)
ORDER BY kind,id LIMIT 21
"#;

const WORKSPACE_SQL: &str = r#"
WITH candidates AS (
 SELECT 'record' kind,n.id id,coalesce(n.title,'') title,
        ?2||'/workspace/record/'||n.id object_key
 FROM agent_visible_workspace_notes n WHERE n.note_kind='workspace_note'
)
SELECT kind,id,substr(title,1,120) FROM candidates c
WHERE title LIKE ?3 ESCAPE '!'
 AND (kind>?4 OR (kind=?4 AND id>?5))
 AND NOT EXISTS(SELECT 1 FROM source_access_policies x WHERE x.object_key=c.object_key AND x.excluded=1)
ORDER BY kind,id LIMIT 21
"#;

impl Database {
    pub fn agent_connection_objects(
        &self,
        binding: &WorkspaceBinding,
        input: &ConnectionObjectsInput,
    ) -> AgentResult<ConnectionObjectPage> {
        if self.native_workspace_id.as_deref() != Some(binding.workspace_id.as_str()) {
            return Err(AgentError::new(ErrorCode::WorkspaceChanged, "Workspace binding is no longer current"));
        }
        input.scope.validate()?;
        if input.query.chars().count() > 200 || input.query.chars().any(char::is_control) {
            return Err(invalid());
        }
        self.source_prepare()?;
        let (after_kind, after_id) = input.cursor.as_deref().map(|cursor| decode_cursor(cursor, binding, input))
            .transpose()?.unwrap_or_default();
        let pattern = like_pattern(&input.query);
        let sql = match &input.scope { Scope::Project { .. } => PROJECT_SQL, Scope::Workspace => WORKSPACE_SQL };
        let project_id = match &input.scope { Scope::Project { project_id } => *project_id, Scope::Workspace => 0 };
        let mut statement = self.conn.prepare(sql).map_err(io_error)?;
        let rows = statement.query_map(params![project_id, binding.workspace_id, pattern, after_kind, after_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?))
        }).map_err(io_error)?;
        let candidates = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(io_error)?;
        let has_more = candidates.len() > PAGE_SIZE;
        let items: Vec<ConnectionObjectOption> = candidates.into_iter().take(PAGE_SIZE).map(|(kind,id,title)| {
            ConnectionObjectOption {
                object: ObjectRef {
                    workspace_id: binding.workspace_id.clone(),
                    scope: input.scope.clone(),
                    kind: if kind == "file" { ObjectKind::File } else { ObjectKind::Record },
                    id: id.to_string(),
                },
                title,
            }
        }).collect();
        let next_cursor = if has_more {
            let last = items.last().expect("full page has a last item");
            let cursor = Cursor {
                workspace_id: binding.workspace_id.clone(),
                scope: input.scope.clone(),
                query: input.query.clone(),
                kind: if last.object.kind == ObjectKind::File { "file" } else { "record" }.into(),
                id: last.object.id.parse().map_err(|_| invalid())?,
            };
            Some(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cursor).map_err(|_| {
                AgentError::new(ErrorCode::IoFailed, "Cannot encode connection object cursor")
            })?))
        } else { None };
        Ok(ConnectionObjectPage { items, next_cursor })
    }
}

#[cfg(test)]
#[path = "agent_connection_objects_tests.rs"]
mod tests;
