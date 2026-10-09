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

const MAX_PROJECTS: usize = 100;
const MAX_ACTIVE_CONNECTIONS: i64 = 100;
const READ_OPERATIONS: [&str; 2] = ["context.read", "source.read"];

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredScope {
    workspace_id: String,
    workspace_content: bool,
    project_ids: Vec<i64>,
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
        operations: decode(&stored.operations_json)?,
        enabled: stored.enabled,
        created_at: stored.created_at,
        revoked_at: stored.revoked_at,
    })
}

fn valid_hex(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|b| b.is_ascii_hexdigit())
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

impl Database {
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
        if !input.workspace_content && input.project_ids.is_empty() {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Select at least one scope",
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
        if input.session_read {
            operations.push("session.read".into());
        }
        let scope = StoredScope {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: input.workspace_content,
            project_ids: projects.clone(),
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
            operations,
            enabled: true,
            created_at,
            revoked_at: None,
        })
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
            || !digest_matches(&scope.token_hash, token)
        {
            return Err(denied());
        }
        Ok(RequestContext {
            binding: binding.clone(),
            scope_grant: ScopeGrant {
                workspace_id: scope.workspace_id,
                workspace_content: scope.workspace_content,
                project_ids: scope.project_ids,
                operations: decode(&stored.operations_json)?,
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
        let mut seen = HashSet::new();
        let mut projects = Vec::new();
        for id in &request.scope_grant.project_ids {
            if !seen.insert(*id) {
                continue;
            }
            request.authorize(binding, &Scope::Project { project_id: *id }, "context.read")?;
            let project = self
                .conn
                .query_row(
                    "SELECT id,name FROM projects WHERE id=?1 AND is_archived=0",
                    [id],
                    |row| {
                        Ok(ConnectionProject {
                            id: row.get(0)?,
                            name: row.get(1)?,
                        })
                    },
                )
                .optional()
                .map_err(io_error)?;
            if let Some(project) = project {
                let object = ObjectRef {
                    workspace_id: binding.workspace_id.clone(),
                    scope: Scope::Project { project_id: *id },
                    kind: ObjectKind::Project,
                    id: id.to_string(),
                };
                match self.source_read_object(request, binding, &object) {
                    Ok(_) => projects.push(project),
                    Err(error)
                        if matches!(error.code, ErrorCode::ScopeDenied | ErrorCode::NotFound) => {}
                    Err(error) => return Err(error),
                }
            }
        }
        Ok(projects)
    }
}

#[cfg(test)]
#[path = "agent_connections_tests.rs"]
mod tests;
