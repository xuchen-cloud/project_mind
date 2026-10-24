//! Persistent connection grants. The token itself is never stored here.
use super::{now_iso, Database};
use crate::agent::{
    access::{Caller, RequestContext, ScopeGrant},
    connections::{ConnectionCreateInput, ConnectionGrant, ConnectionProject},
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
};
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPage {
    pub items: Vec<ConnectionProject>,
    pub next_cursor: Option<String>,
}

const MAX_PROJECTS: usize = 100;
const MAX_ACTIVE_CONNECTIONS: i64 = 100;
const READ_OPERATIONS: [&str; 2] = ["context.read", "source.read"];
const WRITE_OPERATIONS: [&str; 8] = [
    "content.create",
    "record.patch",
    "record.restore",
    "todo.update",
    "file.update",
    "file.restore",
    "operation.undo",
    "schedule.manage",
];

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredScope {
    workspace_id: String,
    workspace_content: bool,
    project_ids: Vec<i64>,
    #[serde(default)]
    all_projects: bool,
    #[serde(default)]
    objects: Option<Vec<ObjectRef>>,
    token_hash: String,
}

struct StoredGrant {
    id: String,
    client_label: String,
    scope_json: String,
    operations_json: String,
    enabled: bool,
    created_at: String,
    revoked_at: Option<String>,
}

fn io_error(_: impl std::fmt::Display) -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Cannot access connection grants")
}

fn denied() -> AgentError {
    AgentError::new(
        ErrorCode::ScopeDenied,
        "Connection is unavailable or unauthorized",
    )
}

fn decode<T: serde::de::DeserializeOwned>(value: &str) -> AgentResult<T> {
    serde_json::from_str(value).map_err(io_error)
}

fn row_to_stored(row: &Row<'_>) -> rusqlite::Result<StoredGrant> {
    Ok(StoredGrant {
        id: row.get(0)?,
        client_label: row.get(1)?,
        scope_json: row.get(2)?,
        operations_json: row.get(3)?,
        enabled: row.get(4)?,
        created_at: row.get(5)?,
        revoked_at: row.get(6)?,
    })
}

fn public_grant(stored: StoredGrant, scope: StoredScope) -> AgentResult<ConnectionGrant> {
    Ok(ConnectionGrant {
        id: stored.id,
        client_label: stored.client_label,
        workspace_id: scope.workspace_id,
        workspace_content: scope.workspace_content,
        project_ids: scope.project_ids,
        all_projects: scope.all_projects,
        objects: scope.objects,
        operations: decode(&stored.operations_json)?,
        enabled: stored.enabled,
        created_at: stored.created_at,
        revoked_at: stored.revoked_at,
    })
}

fn valid_hex(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn object_keys(objects: Option<&[ObjectRef]>) -> AgentResult<Option<Vec<String>>> {
    objects.map(|objects| {
        let mut keys = objects.iter().map(ObjectRef::key).collect::<AgentResult<Vec<_>>>()?;
        keys.sort();
        Ok(keys)
    }).transpose()
}

/// Compare fixed-size SHA-256 hex digests without an early return on mismatch.
fn digest_matches(expected: &str, token: &str) -> bool {
    let actual = format!("{:x}", Sha256::digest(token.as_bytes()));
    let a = expected.as_bytes();
    let b = actual.as_bytes();
    let mut mismatch = a.len() ^ b.len();
    for index in 0..64 {
        mismatch |= usize::from(*a.get(index).unwrap_or(&0) ^ b[index]);
    }
    mismatch == 0
}

/// Rechecks a trusted, previously authenticated connection caller at a native
/// boundary. This cannot authenticate a token or create a new grant.
pub(crate) fn connection_caller_live(
    conn: &rusqlite::Connection,
    caller_id: &str,
    workspace_id: Option<&str>,
) -> AgentResult<()> {
    let Some(id) = caller_id.strip_prefix("connection:") else { return Ok(()); };
    let workspace_id = workspace_id.ok_or_else(|| AgentError::new(
        ErrorCode::WorkspaceChanged, "Workspace binding is no longer current"
    ))?;
    let stored: Option<(String, bool, Option<String>)> = conn.query_row(
        "SELECT scope_grant_json,enabled,revoked_at FROM agent_connection_grants WHERE id=?1",
        [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(io_error)?;
    let Some((scope_json, enabled, revoked_at)) = stored else { return Err(denied()); };
    let scope: StoredScope = decode(&scope_json)?;
    if !enabled || revoked_at.is_some() || scope.workspace_id != workspace_id {
        return Err(denied());
    }
    if scope.objects.is_some() { return Err(denied()); }
    Ok(())
}

impl Database {
    pub(crate) fn agent_active_project_ids(&self) -> AgentResult<Vec<i64>> {
        let mut stmt = self.conn.prepare("SELECT id FROM projects WHERE is_archived=0 ORDER BY id")
            .map_err(io_error)?;
        let rows = stmt.query_map([], |row| row.get(0)).map_err(io_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(io_error)
    }

    pub(crate) fn agent_project_page(
        &self, request: &RequestContext, binding: &WorkspaceBinding,
        cursor: Option<&str>, limit: u32,
    ) -> AgentResult<ProjectPage> {
        self.connection_binding(binding)?;
        if request.binding != *binding || request.scope_grant.workspace_id != binding.workspace_id {
            return Err(AgentError::new(ErrorCode::WorkspaceChanged, "Workspace binding changed"));
        }
        if limit == 0 || limit > 50 {
            return Err(AgentError::new(ErrorCode::InvalidArgument, "Project page limit must be 1–50"));
        }
        let after = match cursor {
            Some(s) => s.parse::<i64>().ok().filter(|n| *n > 0 && n.to_string() == s)
                .ok_or_else(||AgentError::new(ErrorCode::InvalidArgument,"Invalid Project cursor"))?,
            None => 0,
        };
        let ids = serde_json::to_string(&request.scope_grant.project_ids).map_err(io_error)?;
        let mut stmt = self.conn.prepare("SELECT p.id,p.name FROM projects p WHERE p.is_archived=0 AND p.id>?1 AND p.id IN (SELECT value FROM json_each(?2)) ORDER BY p.id")
            .map_err(io_error)?;
        let mut rows = stmt.query(params![after, ids]).map_err(io_error)?;
        let mut items = Vec::new();
        let mut last = after;
        while let Some(row) = rows.next().map_err(io_error)? {
            let project = ConnectionProject { id: row.get(0).map_err(io_error)?, name: row.get(1).map_err(io_error)? };
            let scope = Scope::Project { project_id: project.id };
            request.authorize(binding, &scope, "context.read")?;
            last = project.id;
            let object = ObjectRef { workspace_id: binding.workspace_id.clone(), scope,
                kind: ObjectKind::Project, id: project.id.to_string() };
            let mut metadata_request = request.clone();
            metadata_request.scope_grant.object_keys = None;
            match self.source_read_object(&metadata_request, binding, &object) {
                Ok(_) => { items.push(project); if items.len() > limit as usize { break; } }
                Err(error) if matches!(error.code, ErrorCode::ScopeDenied | ErrorCode::NotFound) => {}
                Err(error) => return Err(error),
            }
        }
        let next_cursor = if items.len() > limit as usize {
            items.pop();
            Some(items.last().map(|p| p.id).unwrap_or(last).to_string())
        } else { None };
        Ok(ProjectPage { items, next_cursor })
    }
    /// Checks the persisted grant and target before native File I/O. Dynamic
    /// all-project grants keep the authenticated request's project snapshot.
    pub(crate) fn agent_connection_require_live(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        scope: &Scope,
        operation: &str,
    ) -> AgentResult<()> {
        request.authorize(binding, scope, operation)?;
        let Caller::Connection { grant_id } = &request.caller else { return Ok(()); };
        self.connection_binding(binding)?;
        connection_caller_live(&self.conn, &request.caller.key(), self.native_workspace_id.as_deref())?;
        let stored = self.stored_connection(grant_id)?.ok_or_else(denied)?;
        let actual: StoredScope = decode(&stored.scope_json)?;
        if actual.objects.is_some() { return Err(denied()); }
        let operations: Vec<String> = decode(&stored.operations_json)?;
        if request.scope_grant.workspace_id != actual.workspace_id
            || request.scope_grant.workspace_content != actual.workspace_content
            || (!actual.all_projects && request.scope_grant.project_ids != actual.project_ids)
            || request.scope_grant.operations != operations
            || request.scope_grant.object_keys != object_keys(actual.objects.as_deref())? {
            return Err(denied());
        }
        if actual.all_projects {
            if let Scope::Project { project_id } = scope {
                let active: bool = self.conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1 AND is_archived=0)",
                    [project_id], |row| row.get(0),
                ).map_err(io_error)?;
                if !active { return Err(denied()); }
            }
        }
        Ok(())
    }
    fn connection_binding(&self, binding: &WorkspaceBinding) -> AgentResult<()> {
        if self.native_workspace_id.as_deref() != Some(binding.workspace_id.as_str()) {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Workspace binding is no longer current",
            ));
        }
        Ok(())
    }

    fn stored_connection(&self, id: &str) -> AgentResult<Option<StoredGrant>> {
        self.conn
            .query_row(
                "SELECT id,client_label,scope_grant_json,operations_json,enabled,created_at,revoked_at FROM agent_connection_grants WHERE id=?1",
                [id],
                row_to_stored,
            )
            .optional()
            .map_err(io_error)
    }

    pub fn agent_connection_create(
        &self,
        binding: &WorkspaceBinding,
        input: &ConnectionCreateInput,
        grant_id: &str,
        token: &str,
    ) -> AgentResult<ConnectionGrant> {
        self.connection_binding(binding)?;
        let label = input.client_label.trim();
        if label.is_empty() || label.chars().count() > 100 || label.chars().any(char::is_control) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid connection label",
            ));
        }
        if !input.workspace_content && !input.all_projects && input.project_ids.is_empty() {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Select at least one scope",
            ));
        }
        if input.all_projects && !input.project_ids.is_empty() {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "allProjects cannot include projectIds",
            ));
        }
        if input.project_ids.len() > MAX_PROJECTS {
            return Err(AgentError::new(
                ErrorCode::BudgetExceeded,
                "Too many connection projects",
            ));
        }
        if !valid_hex(grant_id, 32) || !valid_hex(token, 64) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid connection credential",
            ));
        }
        let mut projects = input.project_ids.clone();
        projects.sort_unstable();
        projects.dedup();
        if projects.iter().any(|id| *id <= 0) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid project ID",
            ));
        }
        let mut operations: Vec<String> = READ_OPERATIONS.iter().map(|s| (*s).into()).collect();
        operations.push("session.read".into());
        let selected: HashSet<&str> = input.write_operations.iter().map(String::as_str).collect();
        if selected.iter().any(|operation| !WRITE_OPERATIONS.contains(operation)) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Unsupported connection operation",
            ));
        }
        if selected.contains("schedule.manage") {
            if !input.workspace_content || !input.all_projects {
                return Err(AgentError::new(
                    ErrorCode::ScopeDenied,
                    "Scheduling requires Workspace and all Projects authorization",
                ));
            }
            operations.push("schedule.read".into());
        }
        if !selected.is_empty() {
            operations.push("operation.read".into());
        }
        for operation in WRITE_OPERATIONS {
            if selected.contains(operation) {
                operations.push(operation.into());
            }
        }
        if selected.contains("operation.undo") {
            operations.push("operation.restore_created".into());
        }
        let scope = StoredScope {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: input.workspace_content,
            project_ids: projects.clone(),
            all_projects: input.all_projects,
            objects: None,
            token_hash: format!("{:x}", Sha256::digest(token.as_bytes())),
        };
        let scope_json = serde_json::to_string(&scope).map_err(io_error)?;
        let operations_json = serde_json::to_string(&operations).map_err(io_error)?;
        let tx = self.conn.unchecked_transaction().map_err(io_error)?;
        for project_id in &projects {
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1 AND is_archived=0)",
                    [project_id],
                    |row| row.get(0),
                )
                .map_err(io_error)?;
            if !exists {
                return Err(AgentError::new(
                    ErrorCode::ScopeDenied,
                    "Project is unavailable",
                ));
            }
        }
        let active: i64 = tx
            .query_row(
                "SELECT count(*) FROM agent_connection_grants WHERE enabled=1",
                [],
                |row| row.get(0),
            )
            .map_err(io_error)?;
        if active >= MAX_ACTIVE_CONNECTIONS {
            return Err(AgentError::new(
                ErrorCode::BudgetExceeded,
                "Too many active connections",
            ));
        }
        let created_at = now_iso();
        tx.execute(
            "INSERT INTO agent_connection_grants(id,client_label,scope_grant_json,operations_json,enabled,created_at,revoked_at) VALUES(?1,?2,?3,?4,1,?5,NULL)",
            params![grant_id,label,scope_json,operations_json,created_at],
        )
        .map_err(io_error)?;
        tx.commit().map_err(io_error)?;
        Ok(ConnectionGrant {
            id: grant_id.into(),
            client_label: label.into(),
            workspace_id: binding.workspace_id.clone(),
            workspace_content: input.workspace_content,
            project_ids: projects,
            all_projects: input.all_projects,
            objects: None,
            operations,
            enabled: true,
            created_at,
            revoked_at: None,
        })
    }

    /// Native provisioning only. Preserve the credential and receipt identity,
    /// and compare the exact previously validated grant before widening it.
    pub(crate) fn agent_connection_upgrade_embedded_workspace_grant(
        &self,
        binding: &WorkspaceBinding,
        previous: &ConnectionGrant,
        token: &str,
        operations: &[String],
    ) -> AgentResult<()> {
        self.connection_binding(binding)?;
        let stored = self.stored_connection(&previous.id)?.ok_or_else(denied)?;
        let mut scope: StoredScope = decode(&stored.scope_json)?;
        let actual = public_grant(
            StoredGrant {
                id: stored.id.clone(),
                client_label: stored.client_label.clone(),
                scope_json: stored.scope_json.clone(),
                operations_json: stored.operations_json.clone(),
                enabled: stored.enabled,
                created_at: stored.created_at.clone(),
                revoked_at: stored.revoked_at.clone(),
            },
            decode(&stored.scope_json)?,
        )?;
        if serde_json::to_value(&actual).map_err(io_error)?
            != serde_json::to_value(previous).map_err(io_error)?
            || scope.workspace_id != binding.workspace_id
            || !scope.workspace_content
            || scope.all_projects
            || !scope.project_ids.is_empty()
            || scope.objects.is_some()
            || !stored.enabled
            || stored.revoked_at.is_some()
            || !digest_matches(&scope.token_hash, token)
        {
            return Err(denied());
        }
        scope.all_projects = true;
        let changed = self.conn.execute(
            "UPDATE agent_connection_grants SET scope_grant_json=?1,operations_json=?2 WHERE id=?3 AND scope_grant_json=?4 AND operations_json=?5 AND client_label=?6 AND created_at=?7 AND enabled=1 AND revoked_at IS NULL",
            params![serde_json::to_string(&scope).map_err(io_error)?, serde_json::to_string(operations).map_err(io_error)?, previous.id, stored.scope_json, stored.operations_json, stored.client_label, stored.created_at],
        ).map_err(io_error)?;
        if changed != 1 {
            return Err(denied());
        }
        Ok(())
    }

    pub fn agent_connection_list(
        &self,
        binding: &WorkspaceBinding,
    ) -> AgentResult<Vec<ConnectionGrant>> {
        self.connection_binding(binding)?;
        let mut statement = self.conn.prepare(
            "SELECT id,client_label,scope_grant_json,operations_json,enabled,created_at,revoked_at FROM agent_connection_grants ORDER BY created_at DESC,id DESC LIMIT 1000",
        ).map_err(io_error)?;
        let rows = statement.query_map([], row_to_stored).map_err(io_error)?;
        let mut grants = Vec::new();
        for row in rows {
            let stored = row.map_err(io_error)?;
            let scope: StoredScope = decode(&stored.scope_json)?;
            if scope.workspace_id == binding.workspace_id {
                grants.push(public_grant(stored, scope)?);
            }
        }
        Ok(grants)
    }

    pub fn agent_connection_revoke(
        &self,
        binding: &WorkspaceBinding,
        id: &str,
    ) -> AgentResult<ConnectionGrant> {
        self.connection_binding(binding)?;
        let stored = self.stored_connection(id)?.ok_or_else(denied)?;
        let scope: StoredScope = decode(&stored.scope_json)?;
        if scope.workspace_id != binding.workspace_id {
            return Err(denied());
        }
        if stored.enabled {
            self.conn.execute(
                "UPDATE agent_connection_grants SET enabled=0,revoked_at=?1 WHERE id=?2 AND enabled=1",
                params![now_iso(), id],
            ).map_err(io_error)?;
        }
        let latest = self.stored_connection(id)?.ok_or_else(denied)?;
        public_grant(latest, scope)
    }

    pub fn agent_connection_authenticate(
        &self,
        binding: &WorkspaceBinding,
        grant_id: &str,
        token: &str,
        request_id: &str,
    ) -> AgentResult<RequestContext> {
        self.connection_binding(binding)?;
        if request_id.is_empty()
            || request_id.len() > 128
            || !valid_hex(grant_id, 32)
            || !valid_hex(token, 64)
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid connection request",
            ));
        }
        let stored = self.stored_connection(grant_id)?.ok_or_else(denied)?;
        let scope: StoredScope = decode(&stored.scope_json)?;
        if scope.workspace_id != binding.workspace_id
            || !stored.enabled
            || stored.revoked_at.is_some()
            || scope.objects.is_some()
            || !digest_matches(&scope.token_hash, token)
        {
            return Err(denied());
        }
        let object_keys = object_keys(scope.objects.as_deref())?;
        let project_ids = if scope.all_projects {
            // Native Workspace identity includes historical Projects; content
            // visibility and archived mutation rules remain with domain services.
            let include_archived = scope.workspace_content
                && crate::agent::bridge::embedded::is_workspace_grant(
                    grant_id,
                    &binding.workspace_id,
                );
            let mut statement = self
                .conn
                .prepare("SELECT id FROM projects WHERE (?1=1 OR is_archived=0) ORDER BY id")
                .map_err(io_error)?;
            let rows = statement
                .query_map([include_archived], |row| row.get(0))
                .map_err(io_error)?;
            rows.collect::<rusqlite::Result<Vec<i64>>>()
                .map_err(io_error)?
        } else {
            scope.project_ids
        };
        Ok(RequestContext {
            binding: binding.clone(),
            scope_grant: ScopeGrant {
                workspace_id: scope.workspace_id,
                workspace_content: scope.workspace_content,
                project_ids,
                operations: decode(&stored.operations_json)?,
                object_keys,
            },
            caller: Caller::Connection {
                grant_id: grant_id.into(),
            },
            request_id: request_id.into(),
        })
    }

    pub fn agent_connection_projects(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
    ) -> AgentResult<Vec<ConnectionProject>> {
        self.connection_binding(binding)?;
        if request.binding != *binding || request.scope_grant.workspace_id != binding.workspace_id {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Workspace binding is no longer current",
            ));
        }
        if !request
            .scope_grant
            .operations
            .iter()
            .any(|op| op == "context.read")
        {
            return Err(denied());
        }
        let selected_parents: Option<HashSet<i64>> = request.scope_grant.object_keys.as_ref().map(|keys| {
            keys.iter().filter_map(|key| {
                let scope = key.split('/').nth(1)?;
                scope.strip_prefix("project:")?.parse::<i64>().ok()
            }).collect()
        });
        let mut filtered = request.clone();
        filtered.scope_grant.project_ids.sort_unstable();
        filtered.scope_grant.project_ids.dedup();
        if let Some(parents) = selected_parents {
            filtered.scope_grant.project_ids.retain(|id| parents.contains(id));
        }
        let mut projects = Vec::new();
        let mut cursor = None;
        loop {
            let page = self.agent_project_page(&filtered, binding, cursor.as_deref(), 50)?;
            projects.extend(page.items);
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        Ok(projects)
    }
}

#[cfg(test)]
#[path = "agent_connections_tests.rs"]
mod tests;
