//! Receipts and change notifications commit with their business mutation.
use super::Database;
use crate::agent::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectRef, Scope},
};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};

pub(crate) struct OperationChange {
    pub object_key: String,
    pub scope: Scope,
    pub revision: String,
}
pub(crate) fn io_error(_: rusqlite::Error) -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Cannot persist agent operation")
}
pub(crate) fn parse_scope_key(key: &str) -> AgentResult<Scope> {
    if key == "workspace" {
        return Ok(Scope::Workspace);
    }
    let scope = Scope::Project {
        project_id: key
            .strip_prefix("project:")
            .and_then(|id| id.parse().ok())
            .ok_or_else(|| AgentError::new(ErrorCode::IoFailed, "Invalid stored scope"))?,
    };
    scope.validate()?;
    Ok(scope)
}

fn operation_hash(
    caller_id: &str,
    request_id: &str,
    payload: &impl Serialize,
) -> AgentResult<String> {
    if caller_id.is_empty()
        || caller_id.len() > 256
        || request_id.is_empty()
        || request_id.len() > 128
    {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Invalid operation identity",
        ));
    }
    let value = serde_json::to_value(payload)
        .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Invalid operation payload"))?;
    // serde_json's default map sorts keys, so wire property order cannot break replay.
    let bytes = serde_json::to_vec(&value)
        .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Invalid operation payload"))?;
    let hash = format!("sha256:{:x}", Sha256::digest(bytes));
    Ok(hash)
}

fn replay<T: DeserializeOwned>(
    conn: &rusqlite::Connection,
    caller_id: &str,
    request_id: &str,
    operation: &str,
    hash: &str,
) -> AgentResult<Option<T>> {
    let previous = conn.query_row("SELECT payload_hash,operation,state,result_json FROM agent_operation_receipts WHERE caller_id=?1 AND request_id=?2", params![caller_id,request_id], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,row.get::<_, Option<String>>(3)?))).optional().map_err(io_error)?;
    if let Some((previous_hash, previous_operation, state, result)) = previous {
        if previous_hash != hash || previous_operation != operation {
            return Err(AgentError::new(
                ErrorCode::IdempotencyConflict,
                "Request ID already belongs to another payload",
            ));
        }
        if state != "committed" {
            return Err(AgentError::new(
                ErrorCode::IoFailed,
                "Operation needs recovery",
            ));
        }
        return serde_json::from_str(&result.unwrap_or_default())
            .map(Some)
            .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid stored receipt"));
    }
    Ok(None)
}

impl Database {
    /// Preflight avoids unnecessary worker conversion. Atomic commit rechecks this
    /// same receipt with the original intent payload, even after ID allocation.
    pub(crate) fn agent_operation_replay<T: DeserializeOwned>(
        &self,
        caller_id: &str,
        request_id: &str,
        operation: &str,
        payload: &impl Serialize,
    ) -> AgentResult<Option<T>> {
        let hash = operation_hash(caller_id, request_id, payload)?;
        replay(&self.conn, caller_id, request_id, operation, &hash)
    }

    /// Invoked under the Workspace DB lock. Returning from the closure commits once;
    /// errors (including outbox failure) roll back mutation and receipt together.
    pub(crate) fn agent_atomic_operation<T: Serialize + DeserializeOwned>(
        &self,
        caller_id: &str,
        request_id: &str,
        operation: &str,
        payload: &impl Serialize,
        apply: impl FnOnce(&Transaction<'_>) -> AgentResult<(T, Option<OperationChange>)>,
    ) -> AgentResult<T> {
        let hash = operation_hash(caller_id, request_id, payload)?;
        let tx = self.conn.unchecked_transaction().map_err(io_error)?;
        if let Some(previous) = replay(&tx, caller_id, request_id, operation, &hash)? {
            return Ok(previous);
        }
        let (result, change) = apply(&tx)?;
        let now = Utc::now().to_rfc3339();
        let result_json = serde_json::to_string(&result)
            .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid operation result"))?;
        tx.execute("INSERT INTO agent_operation_receipts(request_id,caller_id,payload_hash,operation,state,result_json,created_at) VALUES (?1,?2,?3,?4,'committed',?5,?6)", params![request_id,caller_id,hash,operation,result_json,now]).map_err(io_error)?;
        if let Some(change) = change {
            tx.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES (?1,?2,?3,?4,?5)", params![change.object_key,change.scope.key(),operation,change.revision,now]).map_err(io_error)?;
        }
        tx.commit().map_err(io_error)?;
        Ok(result)
    }

    pub(crate) fn agent_resolve_object(
        &self,
        object: &ObjectRef,
        workspace_id: &str,
    ) -> AgentResult<Option<ObjectRef>> {
        use crate::agent::models::ObjectKind;
        object.key()?;
        let numeric_id = || {
            object
                .id
                .parse::<i64>()
                .ok()
                .filter(|id| *id > 0 && id.to_string() == object.id)
                .ok_or_else(|| {
                    AgentError::new(
                        ErrorCode::InvalidArgument,
                        "Expected canonical positive object ID",
                    )
                })
        };
        let project_scope = |sql: &str, id: i64| -> AgentResult<Option<Scope>> {
            self.conn
                .query_row(sql, [id], |row| row.get::<_, Option<i64>>(0))
                .optional()
                .map(|owner| {
                    owner.map(|project_id| {
                        project_id
                            .map_or(Scope::Workspace, |project_id| Scope::Project { project_id })
                    })
                })
                .map_err(io_error)
        };
        let scope = match object.kind {
            ObjectKind::Project => project_scope("SELECT id FROM projects WHERE id=?1", numeric_id()?)?,
            ObjectKind::Record => match object.scope {
                Scope::Workspace => project_scope("SELECT NULL FROM workspace_notes WHERE id=?1 AND note_kind='workspace_note'", numeric_id()?)?,
                Scope::Project { .. } => project_scope("SELECT project_id FROM notes WHERE id=?1", numeric_id()?)?,
            },
            ObjectKind::QuickNote => match object.scope {
                Scope::Workspace => project_scope("SELECT NULL FROM workspace_notes WHERE id=?1 AND note_kind='today_quick_note'", numeric_id()?)?,
                Scope::Project { .. } => project_scope("SELECT id FROM projects WHERE id=?1", numeric_id()?)?,
            },
            ObjectKind::Todo => project_scope("SELECT project_id FROM todos WHERE id=?1", numeric_id()?)?,
            ObjectKind::File => project_scope("SELECT project_id FROM documents WHERE id=?1", numeric_id()?)?,
            ObjectKind::Transcript => project_scope("SELECT notes.project_id FROM voice_records LEFT JOIN notes ON notes.id=voice_records.project_note_id WHERE voice_records.id=?1", numeric_id()?)?,
            ObjectKind::SessionMessage => self.conn.query_row("SELECT s.scope_key FROM agent_messages m JOIN agent_sessions s ON s.id=m.session_id WHERE m.id=?1", [&object.id], |row| row.get::<_, String>(0)).optional().map_err(io_error)?.map(|key| parse_scope_key(&key)).transpose()?,
            ObjectKind::SessionSummary => return Err(AgentError::new(ErrorCode::SourceNotReady, "Session summaries are not available yet")),
        };
        Ok(scope.map(|scope| ObjectRef {
            workspace_id: workspace_id.into(),
            scope,
            kind: object.kind,
            id: object.id.clone(),
        }))
    }
}

impl crate::agent::changes::ChangeRepository for Database {
    fn agent_changes_list(
        &self,
        grant: &crate::agent::access::ScopeGrant,
        input: &crate::agent::changes::ChangeInput,
    ) -> AgentResult<crate::agent::changes::ChangePage> {
        use crate::agent::changes::{ChangeEntry, ChangePage};
        if input.after_seq < 0 || !(1..=200).contains(&input.limit) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid changes cursor or limit",
            ));
        }
        let cutoff = (Utc::now() - chrono::Duration::days(30)).to_rfc3339();
        let (first, max): (Option<i64>, Option<i64>) = self
            .conn
            .query_row(
                "SELECT MIN(CASE WHEN created_at>=?1 THEN seq END),MAX(seq) FROM agent_change_log",
                [&cutoff],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(io_error)?;
        let reset_required = first.is_some_and(|first| input.after_seq < first - 1)
            || (first.is_none() && max.is_some_and(|max| input.after_seq < max));
        let projects = serde_json::to_string(&grant.project_ids)
            .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Invalid grant"))?;
        let mut stmt = self.conn.prepare("SELECT seq,object_key,scope_key,operation,revision,created_at FROM agent_change_log WHERE seq>?1 AND created_at>=?2 AND ((?3 AND scope_key='workspace') OR scope_key IN (SELECT 'project:' || value FROM json_each(?4))) ORDER BY seq LIMIT ?5").map_err(io_error)?;
        let mut entries = stmt
            .query_map(
                params![
                    input.after_seq,
                    cutoff,
                    grant.workspace_content,
                    projects,
                    input.limit + 1
                ],
                |row| {
                    let key: String = row.get(2)?;
                    let scope = parse_scope_key(&key).map_err(|_| rusqlite::Error::InvalidQuery)?;
                    Ok(ChangeEntry {
                        seq: row.get(0)?,
                        object_key: row.get(1)?,
                        scope,
                        operation: row.get(3)?,
                        revision: row.get(4)?,
                        created_at: row.get(5)?,
                    })
                },
            )
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error)?;
        let has_more = entries.len() > usize::from(input.limit);
        entries.truncate(usize::from(input.limit));
        let cursor = if has_more {
            entries.last().map_or(input.after_seq, |entry| entry.seq)
        } else {
            max.unwrap_or(input.after_seq).max(input.after_seq)
        };
        Ok(ChangePage {
            entries,
            cursor,
            has_more,
            reset_required,
        })
    }
}
impl crate::agent::changes::ChangeRepository for super::agent::WorkspaceContextRepository<'_> {
    fn agent_changes_list(
        &self,
        grant: &crate::agent::access::ScopeGrant,
        input: &crate::agent::changes::ChangeInput,
    ) -> AgentResult<crate::agent::changes::ChangePage> {
        self.db.agent_changes_list(grant, input)
    }
}
