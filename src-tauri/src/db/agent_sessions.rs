//! Bounded SQLite metadata and projections of Host-verified Pi SessionManager history.
use super::{
    agent_operations::{io_error, parse_scope_key},
    Database,
};
use crate::agent::{
    access::{Caller, RequestContext},
    conversation::*,
    errors::{AgentError, AgentResult, ErrorCode},
    models::{Scope, WorkspaceBinding},
    runtime::{RunEvent, RunEventKind, RunState},
};
use chrono::Utc;
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn validate_id(id: &str) -> AgentResult<()> {
    if id.len() != 32
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid("Invalid conversation identity"));
    }
    Ok(())
}
fn random_id() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn limit_check(limit: u16, max: u16) -> AgentResult<()> {
    if limit == 0 || limit > max {
        return Err(invalid("Pagination limit is outside its bound"));
    }
    Ok(())
}
fn json_string(value: &impl serde::Serialize) -> AgentResult<String> {
    serde_json::to_string(value).map_err(|_| invalid("Invalid conversation payload"))
}
fn stored_json(raw: &str) -> AgentResult<Value> {
    serde_json::from_str(raw)
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid stored conversation payload"))
}
fn state_sql(state: RunState) -> &'static str {
    match state {
        RunState::Preparing => "preparing",
        RunState::Running => "running",
        RunState::Cancelling => "cancelling",
        RunState::Completed => "completed",
        RunState::Failed => "failed",
        RunState::Cancelled => "cancelled",
        RunState::Interrupted => "interrupted",
    }
}
fn host_only(request: &RequestContext, run_id: Option<&str>) -> AgentResult<()> {
    match &request.caller {
        Caller::Gui => Ok(()),
        Caller::BuiltinRun { run_id: bound } if run_id == Some(bound.as_str()) => Ok(()),
        _ => Err(AgentError::new(
            ErrorCode::ScopeDenied,
            "Conversation lifecycle is owned by the trusted Host",
        )),
    }
}
fn read_session(conn: &Connection, id: &str) -> AgentResult<SessionMetadata> {
    validate_id(id)?;
    let row=conn.query_row("SELECT id,scope_key,title,runtime_id,profile_override_id,state,created_at,updated_at FROM agent_sessions WHERE id=?1",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,Option<i64>>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?,r.get::<_,String>(7)?))).optional().map_err(io_error)?.ok_or_else(||AgentError::new(ErrorCode::NotFound,"Session not found"))?;
    let state = match row.5.as_str() {
        "active" => SessionState::Active,
        "archived" => SessionState::Archived,
        "read_only" => SessionState::ReadOnly,
        _ => {
            return Err(AgentError::new(
                ErrorCode::IoFailed,
                "Invalid stored session state",
            ))
        }
    };
    Ok(SessionMetadata {
        id: row.0,
        scope: parse_scope_key(&row.1)?,
        title: row.2,
        runtime_id: row.3,
        profile_override_id: row.4,
        state,
        created_at: row.6,
        updated_at: row.7,
    })
}
fn read_run(conn: &Connection, id: &str) -> AgentResult<StoredRun> {
    validate_id(id)?;
    let row=conn.query_row("SELECT id,session_id,client_request_id,state,context_manifest_json,started_at,finished_at,usage_json,error_code FROM agent_runs WHERE id=?1",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,Option<String>>(7)?,r.get::<_,Option<String>>(8)?))).optional().map_err(io_error)?.ok_or_else(||AgentError::new(ErrorCode::NotFound,"Run not found"))?;
    let state = serde_json::from_value(json!(row.3))
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid stored run state"))?;
    Ok(StoredRun {
        id: row.0,
        session_id: row.1,
        client_request_id: row.2,
        state,
        context_manifest: stored_json(&row.4)?,
        started_at: row.5,
        finished_at: row.6,
        usage: row.7.as_deref().map(stored_json).transpose()?,
        error_code: row.8,
    })
}
fn projection_validate(projection: &VerifiedSessionProjection) -> AgentResult<()> {
    let cp = &projection.checkpoint;
    if cp.schema_version != 1
        || cp.offset != cp.bytes
        || cp.bytes > PROJECTION_BYTES_MAX as u64
        || cp.message_count != projection.messages.len() as u64
        || cp.message_count > cp.entry_count
        || cp.checksum.len() != 71
        || !cp.checksum.starts_with("sha256:")
        || !cp.checksum[7..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid("Invalid verified checkpoint"));
    }
    if cp
        .leaf_id
        .as_ref()
        .is_some_and(|id| id.is_empty() || id.len() > 128)
    {
        return Err(invalid("Invalid checkpoint leaf"));
    }
    let mut identities = HashSet::new();
    let mut size = 0usize;
    for (ordinal, message) in projection.messages.iter().enumerate() {
        if message.ordinal != ordinal as u64
            || message.runtime_entry_id.is_empty()
            || message.runtime_entry_id.len() > 128
            || !identities.insert(&message.runtime_entry_id)
            || chrono::DateTime::parse_from_rfc3339(&message.created_at).is_err()
        {
            return Err(invalid("Invalid verified message identity or ordering"));
        }
        size = size.saturating_add(json_string(message)?.len());
        if size > PROJECTION_BYTES_MAX {
            return Err(AgentError::new(
                ErrorCode::BudgetExceeded,
                "Conversation projection exceeds history budget",
            ));
        }
    }
    Ok(())
}
fn projection_write(
    tx: &Transaction<'_>,
    session_id: &str,
    run_id: Option<&str>,
    projection: &VerifiedSessionProjection,
) -> AgentResult<()> {
    // Rebuild the current branch projection; identity is derived solely from Pi entry identity.
    // Preserve run attribution and original message IDs on a verified resume/rebuild.
    let mut previous = std::collections::HashMap::new();
    {
        let mut stmt = tx
            .prepare("SELECT runtime_entry_id,id,run_id FROM agent_messages WHERE session_id=?1")
            .map_err(io_error)?;
        let rows = stmt
            .query_map([session_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(io_error)?;
        for row in rows {
            let (entry, id, run) = row.map_err(io_error)?;
            previous.insert(entry, (id, run));
        }
    }
    // Temporarily move ordinals so branch reordering cannot collide with the unique index.
    tx.execute(
        "UPDATE agent_messages SET ordinal=ordinal+1000000000 WHERE session_id=?1",
        [session_id],
    )
    .map_err(io_error)?;
    for message in &projection.messages {
        let (id, attribution) = previous
            .remove(&message.runtime_entry_id)
            .unwrap_or_else(|| {
                (
                    format!(
                        "{:x}",
                        Sha256::digest(
                            format!("{session_id}:{}", message.runtime_entry_id).as_bytes()
                        )
                    )[..32]
                        .to_owned(),
                    run_id.map(str::to_owned),
                )
            });
        tx.execute("INSERT INTO agent_messages(id,session_id,run_id,runtime_entry_id,role,content_json,state,ordinal,created_at) VALUES (?1,?2,?3,?4,?5,?6,'complete',?7,?8) ON CONFLICT(session_id,runtime_entry_id) DO UPDATE SET role=excluded.role,content_json=excluded.content_json,state='complete',ordinal=excluded.ordinal,created_at=excluded.created_at",params![id,session_id,attribution,message.runtime_entry_id,message.role.sql(),json_string(message)?,message.ordinal as i64,message.created_at]).map_err(io_error)?;
    }
    for (_, (id, _)) in previous {
        tx.execute("DELETE FROM agent_messages WHERE id=?1", [id])
            .map_err(io_error)?;
    }
    tx.execute(
        "UPDATE agent_sessions SET checkpoint_json=?2,updated_at=?3 WHERE id=?1",
        params![
            session_id,
            json_string(&projection.checkpoint)?,
            Utc::now().to_rfc3339()
        ],
    )
    .map_err(io_error)?;
    Ok(())
}
impl Database {
    fn conversation_authorize(
        &self,
        request: &RequestContext,
        current: &WorkspaceBinding,
        scope: &Scope,
        operation: &str,
    ) -> AgentResult<()> {
        if self
            .native_workspace_id
            .as_ref()
            .is_some_and(|id| id != &current.workspace_id)
        {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Conversation database belongs to another Workspace",
            ));
        }
        request.authorize(current, scope, operation)
    }
    fn conversation_session(
        &self,
        request: &RequestContext,
        current: &WorkspaceBinding,
        id: &str,
        operation: &str,
    ) -> AgentResult<SessionMetadata> {
        let session = read_session(&self.conn, id)?;
        self.conversation_authorize(request, current, &session.scope, operation)?;
        Ok(session)
    }
    fn conversation_run(
        &self,
        request: &RequestContext,
        current: &WorkspaceBinding,
        id: &str,
        operation: &str,
    ) -> AgentResult<StoredRun> {
        let run = read_run(&self.conn, id)?;
        self.conversation_session(request, current, &run.session_id, operation)?;
        Ok(run)
    }
    /// Narrow trusted local GUI adapter: scope comes from the stored session,
    /// never from an object-ID command's arguments. Connections do not use this.
    pub(crate) fn agent_gui_session_request(
        &self,
        binding: &WorkspaceBinding,
        current: &WorkspaceBinding,
        request_id: &str,
        session_id: &str,
        operations: &[&str],
    ) -> AgentResult<RequestContext> {
        let mut request = RequestContext {
            binding: binding.clone(),
            request_id: request_id.into(),
            caller: Caller::Gui,
            scope_grant: crate::agent::access::ScopeGrant {
                workspace_id: current.workspace_id.clone(),
                workspace_content: true,
                project_ids: vec![],
                operations: vec!["session.read".into(), "session.write".into()],
            },
        };
        self.conversation_authorize(&request, current, &Scope::Workspace, "session.read")?;
        let scope = read_session(&self.conn, session_id)?.scope;
        request.scope_grant.workspace_content = matches!(scope, Scope::Workspace);
        request.scope_grant.project_ids = match scope {
            Scope::Project { project_id } => vec![project_id],
            _ => vec![],
        };
        request.scope_grant.operations = operations
            .iter()
            .map(|operation| (*operation).into())
            .collect();
        Ok(request)
    }
    pub(crate) fn agent_gui_run_request(
        &self,
        binding: &WorkspaceBinding,
        current: &WorkspaceBinding,
        request_id: &str,
        run_id: &str,
        operations: &[&str],
    ) -> AgentResult<RequestContext> {
        // Verify generation before resolving an ID in this Workspace database.
        if binding != current
            || self
                .native_workspace_id
                .as_ref()
                .is_some_and(|id| id != &current.workspace_id)
        {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Workspace binding changed",
            ));
        }
        if request_id.is_empty() || request_id.len() > 128 {
            return Err(invalid("requestId must contain 1–128 bytes"));
        }
        let run = read_run(&self.conn, run_id)?;
        self.agent_gui_session_request(binding, current, request_id, &run.session_id, operations)
    }
    pub(crate) fn agent_session_create(
        &self,
        request: &RequestContext,
        current: &WorkspaceBinding,
        scope: &Scope,
        title: &str,
        runtime_id: &str,
        profile_override_id: Option<i64>,
    ) -> AgentResult<SessionMetadata> {
        self.conversation_authorize(request, current, scope, "session.write")?;
        if title.trim().is_empty()
            || title.chars().count() > 200
            || runtime_id.is_empty()
            || runtime_id.len() > 64
            || profile_override_id.is_some_and(|id| id <= 0)
        {
            return Err(invalid("Invalid session metadata"));
        }
        let id = random_id();
        let now = Utc::now().to_rfc3339();
        self.conn.execute("INSERT INTO agent_sessions(id,scope_key,title,runtime_id,profile_override_id,state,session_path,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,'active',?6,?7,?7)",params![id,scope.key(),title,runtime_id,profile_override_id,format!(".project-mind/agent/sessions/{id}/session.jsonl"),now]).map_err(io_error)?;
        read_session(&self.conn, &id)
    }
    pub(crate) fn agent_sessions_list(
        &self,
        request: &RequestContext,
        current: &WorkspaceBinding,
        scope: &Scope,
        cursor: Option<&SessionCursor>,
        limit: u16,
    ) -> AgentResult<SessionPage> {
        self.conversation_authorize(request, current, scope, "session.read")?;
        limit_check(limit, SESSION_PAGE_MAX)?;
        if let Some(c) = cursor {
            validate_id(&c.id)?;
            if chrono::DateTime::parse_from_rfc3339(&c.updated_at).is_err() {
                return Err(invalid("Invalid session cursor"));
            }
        }
        let mut stmt=self.conn.prepare("SELECT id FROM agent_sessions WHERE scope_key=?1 AND (?2 IS NULL OR updated_at<?2 OR (updated_at=?2 AND id<?3)) ORDER BY updated_at DESC,id DESC LIMIT ?4").map_err(io_error)?;
        let ids = stmt
            .query_map(
                params![
                    scope.key(),
                    cursor.map(|c| &c.updated_at),
                    cursor.map(|c| &c.id),
                    limit as u32 + 1
                ],
                |r| r.get::<_, String>(0),
            )
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error)?;
        let more = ids.len() > limit as usize;
        let sessions = ids
            .into_iter()
            .take(limit as usize)
            .map(|id| read_session(&self.conn, &id))
            .collect::<AgentResult<Vec<_>>>()?;
        let next_cursor = if more {
            sessions.last().map(|s| SessionCursor {
                updated_at: s.updated_at.clone(),
                id: s.id.clone(),
            })
        } else {
            None
        };
        Ok(SessionPage {
            sessions,
            next_cursor,
        })
    }
    pub(crate) fn agent_session_get(
        &self,
        request: &RequestContext,
        current: &WorkspaceBinding,
        id: &str,
        after_ordinal: Option<u64>,
        limit: u16,
    ) -> AgentResult<SessionSnapshot> {
        let session = self.conversation_session(request, current, id, "session.read")?;
        limit_check(limit, MESSAGE_PAGE_MAX)?;
        if after_ordinal.is_some_and(|n| n > i64::MAX as u64) {
            return Err(invalid("Invalid message cursor"));
        }
        let raw: Option<String> = self
            .conn
            .query_row(
                "SELECT checkpoint_json FROM agent_sessions WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(io_error)?;
        let checkpoint = raw
            .map(|raw| {
                serde_json::from_str(&raw)
                    .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid stored checkpoint"))
            })
            .transpose()?;
        let mut stmt=self.conn.prepare("SELECT id,run_id,runtime_entry_id,role,content_json,ordinal,created_at FROM agent_messages WHERE session_id=?1 AND ordinal>?2 ORDER BY ordinal LIMIT ?3").map_err(io_error)?;
        let rows = stmt
            .query_map(
                params![id, after_ordinal.map_or(-1, |n| n as i64), limit as u32 + 1],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, i64>(5)?,
                        r.get::<_, String>(6)?,
                    ))
                },
            )
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error)?;
        let more = rows.len() > limit as usize;
        let messages = rows
            .into_iter()
            .take(limit as usize)
            .map(|r| {
                let projection: ProjectionMessage = serde_json::from_str(&r.4).map_err(|_| {
                    AgentError::new(ErrorCode::IoFailed, "Invalid stored message projection")
                })?;
                Ok(ConversationMessage {
                    id: r.0,
                    session_id: id.to_owned(),
                    run_id: r.1,
                    runtime_entry_id: r.2,
                    role: serde_json::from_value(json!(r.3)).map_err(|_| {
                        AgentError::new(ErrorCode::IoFailed, "Invalid message role")
                    })?,
                    content: projection.content,
                    parent_id: projection.parent_id,
                    stop_reason: projection.stop_reason,
                    usage: projection.usage,
                    tool_call_id: projection.tool_call_id,
                    tool_name: projection.tool_name,
                    is_error: projection.is_error,
                    ordinal: r.5 as u64,
                    created_at: r.6,
                })
            })
            .collect::<AgentResult<Vec<_>>>()?;
        let next_ordinal = if more {
            messages.last().map(|m| m.ordinal)
        } else {
            None
        };
        let latest_run_id: Option<String> = self.conn.query_row(
            "SELECT id FROM agent_runs WHERE session_id=?1 ORDER BY state IN ('preparing','running','cancelling') DESC,started_at DESC,id DESC LIMIT 1",
            [id], |row| row.get(0),
        ).optional().map_err(io_error)?;
        let latest_run = latest_run_id
            .map(|id| read_run(&self.conn, &id))
            .transpose()?;
        Ok(SessionSnapshot {
            session,
            latest_run,
            checkpoint,
            messages,
            next_ordinal,
        })
    }
    pub(crate) fn agent_session_archive(
        &self,
        request: &RequestContext,
        current: &WorkspaceBinding,
        id: &str,
        archived: bool,
    ) -> AgentResult<SessionMetadata> {
        self.conversation_session(request, current, id, "session.write")?;
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let session = read_session(&tx, id)?;
        if session.state == SessionState::ReadOnly {
            return Err(AgentError::new(
                ErrorCode::RuntimeUnavailable,
                "Damaged session remains read only",
            ));
        }
        let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM agent_runs WHERE session_id=?1 AND state IN ('preparing','running','cancelling'))",[id],|r|r.get(0)).map_err(io_error)?;
        if active {
            return Err(AgentError::new(
                ErrorCode::RunBusy,
                "Session has an active run",
            ));
        }
        tx.execute(
            "UPDATE agent_sessions SET state=?2,updated_at=?3 WHERE id=?1",
            params![
                id,
                if archived { "archived" } else { "active" },
                Utc::now().to_rfc3339()
            ],
        )
        .map_err(io_error)?;
        let result = read_session(&tx, id)?;
        tx.commit().map_err(io_error)?;
        Ok(result)
    }
    pub(crate) fn agent_session_delete(
        &self,
        request: &RequestContext,
        current: &WorkspaceBinding,
        id: &str,
    ) -> AgentResult<bool> {
        self.conversation_session(request, current, id, "session.write")?;
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM agent_runs WHERE session_id=?1 AND state IN ('preparing','running','cancelling'))",[id],|r|r.get(0)).map_err(io_error)?;
        if active {
            return Err(AgentError::new(
                ErrorCode::RunBusy,
                "Session has an active run",
            ));
        }
        // Receipts deliberately have no session FK and survive this cascade.
        let deleted = tx
            .execute("DELETE FROM agent_sessions WHERE id=?1", [id])
            .map_err(io_error)?
            == 1;
        tx.commit().map_err(io_error)?;
        Ok(deleted)
    }
    pub(crate) fn agent_run_prepare(
        &self,
        request: &RequestContext,
        current: &WorkspaceBinding,
        session_id: &str,
        client_request_id: &str,
        preparation: &RunPreparation,
    ) -> AgentResult<PreparedRun> {
        self.conversation_session(request, current, session_id, "run.start")?;
        host_only(request, None)?;
        validate_id(&preparation.run_id)?;
        if client_request_id.is_empty() || client_request_id.len() > 128 {
            return Err(invalid("Invalid client request identity"));
        }
        let manifest = json_string(&preparation.context_manifest)?;
        if manifest.len() > 1024 * 1024 {
            return Err(invalid("Context manifest exceeds budget"));
        }
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let previous = tx
            .query_row(
                "SELECT id FROM agent_runs WHERE session_id=?1 AND client_request_id=?2",
                params![session_id, client_request_id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(io_error)?;
        if let Some(id) = previous {
            let run = read_run(&tx, &id)?;
            if run.context_manifest != preparation.context_manifest {
                return Err(AgentError::new(
                    ErrorCode::IdempotencyConflict,
                    "Client request identity was reused with different input",
                ));
            }
            return Ok(PreparedRun {
                run,
                created: false,
            });
        }
        if read_session(&tx, session_id)?.state != SessionState::Active {
            return Err(AgentError::new(
                ErrorCode::InvalidRunTransition,
                "Session cannot accept a new run",
            ));
        }
        let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM agent_runs WHERE state IN ('preparing','running','cancelling'))",[],|r|r.get(0)).map_err(io_error)?;
        if active {
            return Err(AgentError::new(
                ErrorCode::RunBusy,
                "Workspace already has an active run",
            ));
        }
        let grant = json!({"workspaceId":request.scope_grant.workspace_id,"workspaceContent":request.scope_grant.workspace_content,"projectIds":request.scope_grant.project_ids,"operations":request.scope_grant.operations});
        tx.execute("INSERT INTO agent_runs(id,session_id,client_request_id,state,context_manifest_json,grant_json,started_at) VALUES (?1,?2,?3,'preparing',?4,?5,?6)",params![preparation.run_id,session_id,client_request_id,manifest,json_string(&grant)?,Utc::now().to_rfc3339()]).map_err(io_error)?;
        let run = read_run(&tx, &preparation.run_id)?;
        tx.commit().map_err(io_error)?;
        Ok(PreparedRun { run, created: true })
    }
    pub(crate) fn agent_run_get(
        &self,
        request: &RequestContext,
        current: &WorkspaceBinding,
        id: &str,
    ) -> AgentResult<StoredRun> {
        self.conversation_run(request, current, id, "session.read")
    }
    fn conversation_transition(
        &self,
        request: &RequestContext,
        current: &WorkspaceBinding,
        id: &str,
        next: RunState,
        operation: &str,
    ) -> AgentResult<StoredRun> {
        let run = self.conversation_run(request, current, id, operation)?;
        host_only(request, Some(id))?;
        run.state.transition(next)?;
        let changed = self
            .conn
            .execute(
                "UPDATE agent_runs SET state=?2 WHERE id=?1 AND state=?3",
                params![id, state_sql(next), state_sql(run.state)],
            )
            .map_err(io_error)?;
        if changed != 1 {
            return Err(AgentError::new(
                ErrorCode::InvalidRunTransition,
                "Run state changed",
            ));
        }
        read_run(&self.conn, id)
    }
    pub(crate) fn agent_run_start(
        &self,
        request: &RequestContext,
        current: &WorkspaceBinding,
        id: &str,
    ) -> AgentResult<StoredRun> {
        self.conversation_transition(request, current, id, RunState::Running, "run.start")
    }
    pub(crate) fn agent_run_mark_cancelling(
        &self,
        request: &RequestContext,
        current: &WorkspaceBinding,
        id: &str,
    ) -> AgentResult<StoredRun> {
        self.conversation_transition(request, current, id, RunState::Cancelling, "run.cancel")
    }
    pub(crate) fn agent_run_settle(
        &self,
        request: &RequestContext,
        current: &WorkspaceBinding,
        id: &str,
        settlement: &RunSettlement,
    ) -> AgentResult<StoredRun> {
        self.conversation_run(request, current, id, "run.start")?;
        host_only(request, Some(id))?;
        if !settlement.state.is_terminal() {
            return Err(invalid("Settlement must be terminal"));
        }
        if settlement.state == RunState::Completed
            && (!settlement.runtime_settled || settlement.projection.is_none())
        {
            return Err(AgentError::new(
                ErrorCode::InvalidRunTransition,
                "Completion requires settled runtime and verified history",
            ));
        }
        if let Some(projection) = &settlement.projection {
            projection_validate(projection)?;
        }
        let usage = settlement.usage.as_ref().map(json_string).transpose()?;
        if usage.as_ref().is_some_and(|raw| raw.len() > 16384) {
            return Err(invalid("Invalid run usage"));
        }
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let run = read_run(&tx, id)?;
        run.state.transition(settlement.state)?;
        if let Some(projection) = &settlement.projection {
            projection_write(&tx, &run.session_id, Some(id), projection)?;
        }
        let error = settlement.error_code.map(|code| {
            serde_json::to_value(code)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned()
        });
        tx.execute(
            "UPDATE agent_runs SET state=?2,finished_at=?3,usage_json=?4,error_code=?5 WHERE id=?1",
            params![
                id,
                state_sql(settlement.state),
                Utc::now().to_rfc3339(),
                usage,
                error
            ],
        )
        .map_err(io_error)?;
        let result = read_run(&tx, id)?;
        tx.commit().map_err(io_error)?;
        Ok(result)
    }
    pub(crate) fn agent_session_restore_projection(
        &self,
        request: &RequestContext,
        current: &WorkspaceBinding,
        id: &str,
        projection: &VerifiedSessionProjection,
    ) -> AgentResult<()> {
        self.conversation_session(request, current, id, "session.write")?;
        host_only(request, None)?;
        projection_validate(projection)?;
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM agent_runs WHERE session_id=?1 AND state IN ('preparing','running','cancelling'))",[id],|r|r.get(0)).map_err(io_error)?;
        if active {
            return Err(AgentError::new(
                ErrorCode::RunBusy,
                "Cannot rebuild history during an active run",
            ));
        }
        projection_write(&tx, id, None, projection)?;
        tx.commit().map_err(io_error)
    }
    pub(crate) fn agent_session_mark_read_only(
        &self,
        request: &RequestContext,
        current: &WorkspaceBinding,
        id: &str,
    ) -> AgentResult<()> {
        self.conversation_session(request, current, id, "session.write")?;
        host_only(request, None)?;
        self.conn
            .execute(
                "UPDATE agent_sessions SET state='read_only',updated_at=?2 WHERE id=?1",
                params![id, Utc::now().to_rfc3339()],
            )
            .map_err(io_error)?;
        Ok(())
    }
    pub(crate) fn agent_run_event_append(
        &self,
        request: &RequestContext,
        current: &WorkspaceBinding,
        id: &str,
        event: &RunEventKind,
    ) -> AgentResult<RunEvent> {
        let run = self.conversation_run(request, current, id, "run.start")?;
        host_only(request, Some(id))?;
        // Provider failures can carry environment paths or request headers. Only the
        // public code survives; source text deltas remain untouched.
        let event = match event {
            RunEventKind::Failed { error } => RunEventKind::Failed {
                error: AgentError::new(error.code, "Agent run failed"),
            },
            other => other.clone(),
        };
        let raw = json_string(&event)?;
        if raw.len() > 65536 {
            return Err(AgentError::new(
                ErrorCode::BudgetExceeded,
                "Run event exceeds budget",
            ));
        }
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let state = read_run(&tx, id)?.state;
        let event_matches_state = match &event {
            RunEventKind::Started => state == RunState::Running,
            RunEventKind::Completed => state == RunState::Completed,
            RunEventKind::Failed { .. } => state == RunState::Failed,
            RunEventKind::Cancelled => state == RunState::Cancelled,
            _ => matches!(state, RunState::Running | RunState::Cancelling),
        };
        if !event_matches_state {
            return Err(AgentError::new(
                ErrorCode::InvalidRunTransition,
                "Run event does not match persisted lifecycle state",
            ));
        }
        let seq: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(seq),0) FROM agent_run_events WHERE run_id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(io_error)?;
        let seq = seq.checked_add(1).ok_or_else(|| {
            AgentError::new(ErrorCode::BudgetExceeded, "Run event sequence exhausted")
        })?;
        tx.execute(
            "INSERT INTO agent_run_events(run_id,seq,event_json,created_at) VALUES (?1,?2,?3,?4)",
            params![id, seq, raw, Utc::now().to_rfc3339()],
        )
        .map_err(io_error)?;
        if seq > EVENT_RETENTION_MAX as i64 {
            tx.execute(
                "DELETE FROM agent_run_events WHERE run_id=?1 AND seq<=?2",
                params![id, seq - EVENT_RETENTION_MAX as i64],
            )
            .map_err(io_error)?;
        }
        tx.commit().map_err(io_error)?;
        Ok(RunEvent {
            binding: current.clone(),
            session_id: run.session_id,
            run_id: id.to_owned(),
            seq: seq as u64,
            event,
        })
    }
    pub(crate) fn agent_run_events_list(
        &self,
        request: &RequestContext,
        current: &WorkspaceBinding,
        id: &str,
        after_seq: u64,
        limit: u16,
    ) -> AgentResult<RunEventPage> {
        let run = self.conversation_run(request, current, id, "session.read")?;
        limit_check(limit, EVENT_PAGE_MAX)?;
        if after_seq > i64::MAX as u64 {
            return Err(invalid("Invalid event cursor"));
        }
        let first_available_seq = self
            .conn
            .query_row(
                "SELECT MIN(seq) FROM agent_run_events WHERE run_id=?1",
                [id],
                |r| r.get::<_, Option<i64>>(0),
            )
            .map_err(io_error)?
            .map(|seq| seq as u64);
        let mut stmt=self.conn.prepare("SELECT seq,event_json FROM agent_run_events WHERE run_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3").map_err(io_error)?;
        let rows = stmt
            .query_map(params![id, after_seq as i64, i64::from(limit) + 1], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error)?;
        let more = rows.len() > limit as usize;
        let events = rows
            .into_iter()
            .take(limit as usize)
            .map(|(seq, raw)| {
                Ok(RunEvent {
                    binding: current.clone(),
                    session_id: run.session_id.clone(),
                    run_id: id.to_owned(),
                    seq: seq as u64,
                    event: serde_json::from_str(&raw).map_err(|_| {
                        AgentError::new(ErrorCode::IoFailed, "Invalid stored run event")
                    })?,
                })
            })
            .collect::<AgentResult<Vec<_>>>()?;
        let next_seq = if more {
            events.last().map(|e| e.seq)
        } else {
            None
        };
        Ok(RunEventPage {
            events,
            next_seq,
            first_available_seq,
        })
    }
    /// Only the newly created Workspace runtime calls this local startup adapter.
    /// Grants are drawn from actual orphan session scopes, never all Projects.
    pub(crate) fn agent_gui_interrupt_orphans(
        &self,
        current: &WorkspaceBinding,
    ) -> AgentResult<usize> {
        let mut stmt = self.conn.prepare("SELECT DISTINCT s.scope_key FROM agent_runs r JOIN agent_sessions s ON s.id=r.session_id WHERE r.state IN ('preparing','running','cancelling')").map_err(io_error)?;
        let keys = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error)?;
        drop(stmt);
        let mut workspace_content = false;
        let mut project_ids = Vec::new();
        for key in keys {
            match parse_scope_key(&key)? {
                Scope::Workspace => workspace_content = true,
                Scope::Project { project_id } => project_ids.push(project_id),
            }
        }
        let request = RequestContext {
            binding: current.clone(),
            request_id: "agent-startup-recovery".into(),
            caller: Caller::Gui,
            scope_grant: crate::agent::access::ScopeGrant {
                workspace_id: current.workspace_id.clone(),
                workspace_content,
                project_ids,
                operations: vec!["run.start".into()],
            },
        };
        self.agent_runs_interrupt_orphans(&request, current)
    }
    /// Called on Workspace reopen with the new trusted GUI grant; never resumes an old run.
    pub(crate) fn agent_runs_interrupt_orphans(
        &self,
        request: &RequestContext,
        current: &WorkspaceBinding,
    ) -> AgentResult<usize> {
        host_only(request, None)?;
        if request.binding != *current
            || self
                .native_workspace_id
                .as_ref()
                .is_some_and(|id| id != &current.workspace_id)
        {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Workspace binding changed",
            ));
        }
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let mut stmt=tx.prepare("SELECT r.id,s.scope_key FROM agent_runs r JOIN agent_sessions s ON s.id=r.session_id WHERE r.state IN ('preparing','running','cancelling')").map_err(io_error)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error)?;
        drop(stmt);
        for (_, scope) in &rows {
            self.conversation_authorize(request, current, &parse_scope_key(scope)?, "run.start")?;
        }
        let count=tx.execute("UPDATE agent_runs SET state='interrupted',finished_at=?1,error_code='RUNTIME_UNAVAILABLE' WHERE state IN ('preparing','running','cancelling')",[Utc::now().to_rfc3339()]).map_err(io_error)?;
        tx.commit().map_err(io_error)?;
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::access::ScopeGrant;
    use std::path::PathBuf;

    fn setup() -> (Database, RequestContext, WorkspaceBinding) {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn.execute_batch(include_str!("agent_schema.sql"))
            .unwrap();
        let db = Database {
            conn,
            workspace_root: PathBuf::new(),
            secret_password: None,
            native_workspace_id: Some("workspace-a".into()),
        };
        let binding = WorkspaceBinding {
            workspace_id: "workspace-a".into(),
            generation: "generation-1".into(),
        };
        let request = RequestContext {
            binding: binding.clone(),
            scope_grant: ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: true,
                project_ids: vec![1, 2],
                operations: vec![
                    "session.read".into(),
                    "session.write".into(),
                    "run.start".into(),
                    "run.cancel".into(),
                ],
            },
            caller: Caller::Gui,
            request_id: "test".into(),
        };
        (db, request, binding)
    }
    fn session(
        db: &Database,
        r: &RequestContext,
        b: &WorkspaceBinding,
        scope: Scope,
    ) -> SessionMetadata {
        db.agent_session_create(r, b, &scope, "Conversation", "pi", None)
            .unwrap()
    }
    fn prepare(
        db: &Database,
        r: &RequestContext,
        b: &WorkspaceBinding,
        s: &SessionMetadata,
        request: &str,
    ) -> StoredRun {
        db.agent_run_prepare(
            r,
            b,
            &s.id,
            request,
            &RunPreparation {
                run_id: random_id(),
                context_manifest: json!({"inputHash":request}),
            },
        )
        .unwrap()
        .run
    }
    fn projection(count: usize) -> VerifiedSessionProjection {
        VerifiedSessionProjection {
            checkpoint: SessionCheckpoint {
                schema_version: 1,
                checksum: format!("sha256:{}", "a".repeat(64)),
                bytes: 500,
                offset: 500,
                leaf_id: Some(format!("entry-{count}")),
                entry_count: count as u64,
                message_count: count as u64,
            },
            messages: (0..count)
                .map(|n| ProjectionMessage {
                    runtime_entry_id: format!("entry-{n}"),
                    ordinal: n as u64,
                    created_at: "2026-10-08T00:00:00Z".into(),
                    role: match n % 3 {
                        0 => MessageRole::User,
                        1 => MessageRole::Assistant,
                        _ => MessageRole::Tool,
                    },
                    content: json!([{ "type":"text","text":format!("message {n}") }]),
                    parent_id: None,
                    stop_reason: None,
                    usage: None,
                    tool_call_id: None,
                    tool_name: None,
                    is_error: None,
                })
                .collect(),
        }
    }
    fn settlement(state: RunState, p: Option<VerifiedSessionProjection>) -> RunSettlement {
        RunSettlement {
            state,
            runtime_settled: true,
            projection: p,
            usage: None,
            error_code: None,
        }
    }

    #[test]
    fn session_and_run_reads_resolve_actual_scope_and_binding() {
        let (db, mut r, b) = setup();
        let s = session(&db, &r, &b, Scope::Project { project_id: 2 });
        let run = prepare(&db, &r, &b, &s, "original");
        r.scope_grant.project_ids = vec![1];
        assert_eq!(
            db.agent_session_get(&r, &b, &s.id, None, 10)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            db.agent_run_get(&r, &b, &run.id).unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            db.agent_run_events_list(&r, &b, &run.id, 0, 10)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            db.agent_session_delete(&r, &b, &s.id).unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        let changed = WorkspaceBinding {
            generation: "new".into(),
            ..b
        };
        assert_eq!(
            db.agent_sessions_list(&r, &changed, &Scope::Workspace, None, 10)
                .unwrap_err()
                .code,
            ErrorCode::WorkspaceChanged
        );
    }
    #[test]
    fn duplicate_request_reuses_run_before_busy_and_conflicting_input_is_rejected() {
        let (db, r, b) = setup();
        let s = session(&db, &r, &b, Scope::Workspace);
        let other = session(&db, &r, &b, Scope::Project { project_id: 1 });
        let run = prepare(&db, &r, &b, &s, "same");
        // Reopening the panel can recover and cancel a run even before its
        // first message is projected; another session must not see that run.
        let reopened = db.agent_session_get(&r, &b, &s.id, None, 1).unwrap();
        assert!(reopened.messages.is_empty());
        assert_eq!(reopened.latest_run.unwrap().id, run.id);
        assert!(db
            .agent_session_get(&r, &b, &other.id, None, 1)
            .unwrap()
            .latest_run
            .is_none());
        let duplicate = db
            .agent_run_prepare(
                &r,
                &b,
                &s.id,
                "same",
                &RunPreparation {
                    run_id: random_id(),
                    context_manifest: json!({"inputHash":"same"}),
                },
            )
            .unwrap();
        assert!(!duplicate.created);
        assert_eq!(duplicate.run.id, run.id);
        assert_eq!(
            db.agent_run_prepare(
                &r,
                &b,
                &s.id,
                "same",
                &RunPreparation {
                    run_id: random_id(),
                    context_manifest: json!({"inputHash":"changed"})
                }
            )
            .err()
            .unwrap()
            .code,
            ErrorCode::IdempotencyConflict
        );
        assert_eq!(
            db.agent_run_prepare(
                &r,
                &b,
                &other.id,
                "new",
                &RunPreparation {
                    run_id: random_id(),
                    context_manifest: json!({})
                }
            )
            .err()
            .unwrap()
            .code,
            ErrorCode::RunBusy
        );
        assert_eq!(
            db.agent_session_archive(&r, &b, &s.id, true)
                .unwrap_err()
                .code,
            ErrorCode::RunBusy
        );
        assert_eq!(
            db.agent_session_delete(&r, &b, &s.id).unwrap_err().code,
            ErrorCode::RunBusy
        );
    }
    #[test]
    fn completion_requires_settled_history_and_terminal_runs_cannot_restart() {
        let (db, r, b) = setup();
        let s = session(&db, &r, &b, Scope::Workspace);
        let run = prepare(&db, &r, &b, &s, "run");
        db.agent_run_start(&r, &b, &run.id).unwrap();
        assert_eq!(
            db.agent_run_settle(&r, &b, &run.id, &settlement(RunState::Completed, None))
                .unwrap_err()
                .code,
            ErrorCode::InvalidRunTransition
        );
        let mut unsettled = settlement(RunState::Completed, Some(projection(3)));
        unsettled.runtime_settled = false;
        assert_eq!(
            db.agent_run_settle(&r, &b, &run.id, &unsettled)
                .unwrap_err()
                .code,
            ErrorCode::InvalidRunTransition
        );
        assert_eq!(
            db.agent_run_get(&r, &b, &run.id).unwrap().state,
            RunState::Running
        );
        assert_eq!(
            db.agent_run_event_append(&r, &b, &run.id, &RunEventKind::Completed)
                .unwrap_err()
                .code,
            ErrorCode::InvalidRunTransition
        );
        db.agent_run_settle(
            &r,
            &b,
            &run.id,
            &settlement(RunState::Completed, Some(projection(3))),
        )
        .unwrap();
        assert_eq!(
            db.agent_run_start(&r, &b, &run.id).unwrap_err().code,
            ErrorCode::InvalidRunTransition
        );
        assert_eq!(
            db.agent_run_settle(&r, &b, &run.id, &settlement(RunState::Failed, None))
                .unwrap_err()
                .code,
            ErrorCode::InvalidRunTransition
        );
    }
    #[test]
    fn resume_projection_keeps_ids_run_attribution_and_all_roles() {
        let (db, r, b) = setup();
        let s = session(&db, &r, &b, Scope::Workspace);
        let run = prepare(&db, &r, &b, &s, "run");
        db.agent_run_start(&r, &b, &run.id).unwrap();
        db.agent_run_settle(
            &r,
            &b,
            &run.id,
            &settlement(RunState::Completed, Some(projection(3))),
        )
        .unwrap();
        let original = db.agent_session_get(&r, &b, &s.id, None, 50).unwrap();
        db.agent_session_restore_projection(&r, &b, &s.id, &projection(4))
            .unwrap();
        let restored = db.agent_session_get(&r, &b, &s.id, None, 50).unwrap();
        assert_eq!(restored.messages.len(), 4);
        for (old, new) in original.messages.iter().zip(&restored.messages) {
            assert_eq!(old.id, new.id);
            assert_eq!(old.runtime_entry_id, new.runtime_entry_id);
            assert_eq!(new.run_id.as_deref(), Some(run.id.as_str()));
        }
        assert_eq!(restored.messages[0].role, MessageRole::User);
        assert_eq!(restored.messages[1].role, MessageRole::Assistant);
        assert_eq!(restored.messages[2].role, MessageRole::Tool);
        let mut corrupt = projection(4);
        corrupt.messages[1].runtime_entry_id = "entry-0".into();
        assert_eq!(
            db.agent_session_restore_projection(&r, &b, &s.id, &corrupt)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            db.agent_session_get(&r, &b, &s.id, None, 50)
                .unwrap()
                .checkpoint
                .unwrap()
                .message_count,
            4
        );
    }
    #[test]
    fn sessions_messages_and_events_have_bounded_deterministic_pages() {
        let (db, r, b) = setup();
        for _ in 0..7 {
            session(&db, &r, &b, Scope::Workspace);
        }
        db.conn
            .execute(
                "UPDATE agent_sessions SET updated_at='2026-10-08T00:00:00Z'",
                [],
            )
            .unwrap();
        let mut cursor = None;
        let mut ids = HashSet::new();
        loop {
            let page = db
                .agent_sessions_list(&r, &b, &Scope::Workspace, cursor.as_ref(), 2)
                .unwrap();
            assert!(page.sessions.len() <= 2);
            for s in page.sessions {
                assert!(ids.insert(s.id));
            }
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(ids.len(), 7);
        assert_eq!(
            db.agent_sessions_list(&r, &b, &Scope::Workspace, None, 101)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        let s = read_session(&db.conn, ids.iter().next().unwrap()).unwrap();
        db.agent_session_restore_projection(&r, &b, &s.id, &projection(51))
            .unwrap();
        let first = db.agent_session_get(&r, &b, &s.id, None, 50).unwrap();
        assert_eq!(first.messages.len(), 50);
        assert_eq!(first.next_ordinal, Some(49));
        let last = db
            .agent_session_get(&r, &b, &s.id, first.next_ordinal, 50)
            .unwrap();
        assert_eq!(last.messages.len(), 1);
        assert!(last.next_ordinal.is_none());
        assert_eq!(
            db.agent_session_get(&r, &b, &s.id, None, 51)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        let run = prepare(&db, &r, &b, &s, "events");
        db.agent_run_start(&r, &b, &run.id).unwrap();
        for _ in 0..1003 {
            db.agent_run_event_append(
                &r,
                &b,
                &run.id,
                &RunEventKind::TextDelta { text: "x".into() },
            )
            .unwrap();
        }
        let page = db.agent_run_events_list(&r, &b, &run.id, 0, 100).unwrap();
        assert_eq!(page.first_available_seq, Some(4));
        assert_eq!(page.events.len(), 100);
        assert_eq!(page.next_seq, Some(103));
        assert_eq!(
            db.conn
                .query_row("SELECT COUNT(*) FROM agent_run_events", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1000
        );
        assert_eq!(
            db.agent_run_events_list(&r, &b, &run.id, 0, 101)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
    }
    #[test]
    fn reopen_interrupts_orphans_and_deletion_preserves_receipts() {
        let (mut db, mut r, mut b) = setup();
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("sessions.sqlite");
        db.conn = Connection::open(&path).unwrap();
        db.conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        db.conn
            .execute_batch(include_str!("agent_schema.sql"))
            .unwrap();
        let s = session(&db, &r, &b, Scope::Workspace);
        let run = prepare(&db, &r, &b, &s, "interrupted");
        drop(db);
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let db = Database {
            conn,
            workspace_root: root.path().to_owned(),
            secret_password: None,
            native_workspace_id: Some("workspace-a".into()),
        };
        b.generation = "reopened-generation".into();
        r.binding = b.clone();
        assert_eq!(db.agent_gui_interrupt_orphans(&b).unwrap(), 1);
        assert_eq!(
            db.agent_run_get(&r, &b, &run.id).unwrap().state,
            RunState::Interrupted
        );
        assert_eq!(db.agent_runs_interrupt_orphans(&r, &b).unwrap(), 0);
        db.conn.execute("INSERT INTO agent_operation_receipts(request_id,caller_id,payload_hash,operation,state,result_json,created_at) VALUES ('receipt','gui','hash','content.create','committed','{}','now')",[]).unwrap();
        db.agent_session_restore_projection(&r, &b, &s.id, &projection(3))
            .unwrap();
        db.agent_session_delete(&r, &b, &s.id).unwrap();
        for table in [
            "agent_sessions",
            "agent_runs",
            "agent_messages",
            "agent_run_events",
        ] {
            assert_eq!(
                db.conn
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        assert_eq!(
            db.conn
                .query_row("SELECT COUNT(*) FROM agent_operation_receipts", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
        prepare(&db, &r, &b, &session(&db, &r, &b, Scope::Workspace), "new");
    }
    #[test]
    fn gui_adapter_grants_only_resolved_scope_and_requested_operations() {
        let (db, r, b) = setup();
        let s = session(&db, &r, &b, Scope::Project { project_id: 2 });
        let run = prepare(&db, &r, &b, &s, "scope");
        let request = db
            .agent_gui_run_request(&b, &b, "local", &run.id, &["session.read", "run.cancel"])
            .unwrap();
        assert!(!request.scope_grant.workspace_content);
        assert_eq!(request.scope_grant.project_ids, vec![2]);
        assert_eq!(
            request.scope_grant.operations,
            vec!["session.read", "run.cancel"]
        );
        assert_eq!(
            db.agent_run_start(&request, &b, &run.id).unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            db.agent_session_get(&request, &b, &s.id, None, 50)
                .unwrap()
                .session
                .id,
            s.id
        );
    }
    #[test]
    fn failed_event_storage_excludes_provider_details_and_host_paths() {
        let (db, r, b) = setup();
        let s = session(&db, &r, &b, Scope::Workspace);
        let run = prepare(&db, &r, &b, &s, "failure");
        db.agent_run_settle(&r, &b, &run.id, &settlement(RunState::Failed, None))
            .unwrap();
        db.agent_run_event_append(
            &r,
            &b,
            &run.id,
            &RunEventKind::Failed {
                error: AgentError::new(
                    ErrorCode::RuntimeUnavailable,
                    "/private/host/config secret",
                )
                .with_details(json!({"authorization":"Bearer secret"})),
            },
        )
        .unwrap();
        let raw: String = db
            .conn
            .query_row(
                "SELECT event_json FROM agent_run_events WHERE run_id=?1",
                [&run.id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!raw.contains("secret"));
        assert!(!raw.contains("/private"));
        assert!(!raw.contains("authorization"));
    }
    #[test]
    fn connection_cannot_mint_verified_projection_or_settle_a_run() {
        let (db, mut r, b) = setup();
        let s = session(&db, &r, &b, Scope::Workspace);
        let run = prepare(&db, &r, &b, &s, "run");
        r.caller = Caller::Connection {
            grant_id: "connection".into(),
        };
        assert_eq!(
            db.agent_session_restore_projection(&r, &b, &s.id, &projection(3))
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            db.agent_run_settle(&r, &b, &run.id, &settlement(RunState::Cancelled, None))
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
    }
}
