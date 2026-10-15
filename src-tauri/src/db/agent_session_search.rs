//! GUI candidates over Host-verified Pi history, including historical branches. Pi JSONL remains
//! the authority for opening a result at its checkpoint branch anchor.
use super::{
    agent_operations::{io_error, parse_scope_key},
    Database,
};
use crate::agent::{
    access::{Caller, RequestContext},
    conversation::{MessageRole, ProjectionMessage},
    errors::{AgentError, AgentResult, ErrorCode},
    models::{Scope, WorkspaceBinding},
};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const SNIPPET_CHARS_MAX: usize = 240;
fn default_search_limit() -> u16 {
    20
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSessionSearchInput {
    pub scope: Scope,
    pub session_id: Option<String>,
    pub query: String,
    pub after_message_id: Option<String>,
    #[serde(default = "default_search_limit")]
    pub limit: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSessionSearchHit {
    pub session_id: String,
    pub message_id: String,
    pub runtime_entry_id: String,
    pub ordinal: u64,
    pub role: MessageRole,
    pub created_at: String,
    pub content_hash: String,
    pub branch_leaf_id: String,
    pub snippet: String,
    pub session_title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSessionSearchCoverage {
    pub indexed_messages: u64,
    pub remaining_messages: u64,
    pub backfilled_this_request: u16,
    pub complete: bool,
    pub pending_sessions: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSessionSearchPage {
    pub matches: Vec<AgentSessionSearchHit>,
    pub next_cursor: Option<String>,
    pub coverage: AgentSessionSearchCoverage,
}

impl AgentSessionSearchInput {
    pub(crate) fn validate(&self) -> AgentResult<()> {
        if !(1..=50).contains(&self.limit)
            || self.query.trim().is_empty()
            || self.query.chars().count() > 256
            || self.session_id.as_deref().is_some_and(|id| !id_valid(id))
            || self
                .after_message_id
                .as_deref()
                .is_some_and(|id| !id_valid(id))
        {
            return Err(invalid("Invalid history search request"));
        }
        Ok(())
    }
}

fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}

fn id_valid(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

// Identical text selection and part concatenation to session-history.mjs textOf.
fn text_of(message: &ProjectionMessage) -> Option<String> {
    if message.role != MessageRole::User
        && (message.role != MessageRole::Assistant
            || !matches!(message.stop_reason.as_deref(), Some("stop" | "toolUse")))
    {
        return None;
    }
    if let Some(text) = message.content.as_str() {
        return (!text.is_empty()).then(|| text.to_owned());
    }
    let parts = message.content.as_array()?;
    let text: String = parts
        .iter()
        .filter_map(|part| {
            (part.get("type").and_then(|v| v.as_str()) == Some("text"))
                .then(|| part.get("text").and_then(|v| v.as_str()))
                .flatten()
        })
        .collect();
    (!text.is_empty()).then_some(text)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScanCursor {
    pub entry_offset: u64,
    pub char_offset: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionScanWork {
    pub session_id: String,
    pub checksum: String,
    pub cursor: Option<ScanCursor>,
    pub previous_checkpoint: Option<ScanCheckpoint>,
    #[serde(skip)]
    expected_state: Option<ScanState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScanCheckpoint {
    pub checksum: String,
    pub entry_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ScanState {
    checksum: String,
    entry_count: u64,
    cursor: Option<ScanCursor>,
    complete: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionScanMessage {
    pub message_id: String,
    pub runtime_entry_id: String,
    pub branch_id: String,
    pub ordinal: u64,
    pub role: MessageRole,
    pub created_at: String,
    pub text: String,
    pub content_hash: String,
    pub char_start: u32,
    pub char_end: u32,
    pub total_chars: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionScanPage {
    pub session_id: String,
    pub checksum: String,
    pub entry_count: u64,
    pub messages: Vec<SessionScanMessage>,
    pub next_cursor: Option<ScanCursor>,
    pub complete: bool,
}

fn checkpoint_checksum(checkpoint: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(checkpoint)
        .ok()?
        .get("checksum")?
        .as_str()
        .map(str::to_owned)
}

fn authorize_index(
    db: &Database,
    request: &RequestContext,
    current: &WorkspaceBinding,
    scope: &Scope,
) -> AgentResult<()> {
    scope.validate()?;
    if db
        .native_workspace_id
        .as_ref()
        .is_some_and(|id| id != &current.workspace_id)
    {
        return Err(AgentError::new(
            ErrorCode::WorkspaceChanged,
            "Conversation database belongs to another Workspace",
        ));
    }
    request.authorize(current, scope, "session.read")
}

fn index_message(
    tx: &Transaction<'_>,
    workspace_id: &str,
    session_id: &str,
    message_id: &str,
    message: &ProjectionMessage,
) -> AgentResult<()> {
    let Some(text) = text_of(message) else {
        tx.execute(
            "DELETE FROM agent_session_search_rows WHERE message_id=?1",
            [message_id],
        )
        .map_err(io_error)?;
        return Ok(());
    };
    let hash = format!("sha256:{:x}", Sha256::digest(text.as_bytes()));
    let current_run_id: Option<String> = tx
        .query_row(
            "SELECT run_id FROM agent_messages WHERE id=?1 AND session_id=?2",
            params![message_id, session_id],
            |r| r.get(0),
        )
        .map_err(io_error)?;
    let old: Option<(String,String,i64,String,String,i64,String,String,Option<String>)> = tx.query_row(
        "SELECT text_hash,text,complete,session_id,runtime_entry_id,ordinal,created_at,role,run_id FROM agent_session_search_rows WHERE message_id=?1",[message_id],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?)),
    ).optional().map_err(io_error)?;
    if let Some((
        old_hash,
        old_text,
        complete,
        old_session,
        old_entry,
        old_ordinal,
        old_created,
        old_role,
        old_run_id,
    )) = &old
    {
        if old_hash == &hash && old_text == &text && *complete == 1 {
            if old_session != session_id
                || old_entry != &message.runtime_entry_id
                || *old_ordinal != message.ordinal as i64
                || old_created != &message.created_at
                || old_role != message.role.sql()
                || old_run_id.is_none() && current_run_id.is_some()
            {
                tx.execute("UPDATE agent_session_search_rows SET session_id=?2,runtime_entry_id=?3,ordinal=?4,role=?5,created_at=?6,run_id=?7 WHERE message_id=?1",params![message_id,session_id,message.runtime_entry_id,message.ordinal as i64,message.role.sql(),message.created_at,old_run_id.as_ref().or(current_run_id.as_ref())]).map_err(io_error)?;
            }
            return Ok(());
        }
    }
    let run_id = old
        .as_ref()
        .and_then(|row| row.8.as_ref())
        .or(current_run_id.as_ref());
    tx.execute("INSERT INTO agent_session_search_rows(message_id,session_id,runtime_entry_id,ordinal,role,created_at,run_id,text_hash,text,total_chars,complete) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1) ON CONFLICT(message_id) DO UPDATE SET session_id=excluded.session_id,runtime_entry_id=excluded.runtime_entry_id,ordinal=excluded.ordinal,role=excluded.role,created_at=excluded.created_at,run_id=excluded.run_id,text_hash=excluded.text_hash,text=excluded.text,total_chars=excluded.total_chars,complete=1",
        params![message_id,session_id,message.runtime_entry_id,message.ordinal as i64,message.role.sql(),message.created_at,run_id,hash,text,text.chars().count() as i64]).map_err(io_error)?;
    tx.execute(
        "DELETE FROM agent_session_search_fts WHERE message_id=?1",
        [message_id],
    )
    .map_err(io_error)?;
    tx.execute(
        "INSERT INTO agent_session_search_fts(message_id,text) VALUES (?1,?2)",
        params![message_id, text],
    )
    .map_err(io_error)?;
    super::agent_session_maintenance::session_message_changed(tx,workspace_id,session_id,message_id,&hash)?;
    Ok(())
}

pub(super) fn projection_index_message(
    tx: &Transaction<'_>,
    workspace_id: &str,
    session_id: &str,
    message_id: &str,
    message: &ProjectionMessage,
) -> AgentResult<()> {
    index_message(tx, workspace_id, session_id, message_id, message)
}

impl Database {
    /// Trusted GUI search only. The adapter must resolve the current Workspace
    /// binding; this method enforces its session.read grant and stored scope.
    pub(crate) fn agent_session_search(
        &self,
        request: &RequestContext,
        current: &WorkspaceBinding,
        input: &AgentSessionSearchInput,
    ) -> AgentResult<AgentSessionSearchPage> {
        if !matches!(request.caller, Caller::Gui) {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "History search is GUI only",
            ));
        }
        authorize_index(self, request, current, &input.scope)?;
        input.validate()?;
        let scope_key = input.scope.key();
        if let Some(session_id) = &input.session_id {
            let owner: Option<String> = self
                .conn
                .query_row(
                    "SELECT scope_key FROM agent_sessions WHERE id=?1",
                    [session_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(io_error)?;
            if owner.as_deref() != Some(scope_key.as_str()) {
                return Err(AgentError::new(ErrorCode::NotFound, "Session not found"));
            }
        }
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let (indexed, remaining): (i64, i64) = tx.query_row(
            "SELECT count(*) FILTER (WHERE i.complete=1),count(*) FILTER (WHERE i.complete=0) FROM agent_session_search_rows i JOIN agent_sessions s ON s.id=i.session_id WHERE s.scope_key=?1 AND (?2 IS NULL OR s.id=?2)",
            params![scope_key,input.session_id], |r| Ok((r.get(0)?,r.get(1)?)),
        ).map_err(io_error)?;
        let pending: i64 = tx.query_row("SELECT count(*) FROM agent_sessions s LEFT JOIN agent_session_scan_state st ON st.session_id=s.id WHERE s.scope_key=?1 AND (?2 IS NULL OR s.id=?2) AND s.runtime_id='builtin-pi' AND s.checkpoint_json IS NOT NULL AND (st.session_id IS NULL OR st.checksum!=json_extract(s.checkpoint_json,'$.checksum') OR st.complete=0)",params![scope_key,input.session_id],|r|r.get(0)).map_err(io_error)?;
        if input.after_message_id.is_some() && (remaining != 0 || pending != 0) {
            return Err(invalid(
                "History index changed; restart search from the first page",
            ));
        }
        let query = input.query.trim();
        let short = query.chars().count() < 3;
        let filter = if short {
            format!(
                "%{}%",
                query
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            )
        } else {
            format!("\"{}\"", query.replace('"', "\"\""))
        };
        let match_sql = if short {
            "i.text LIKE ?4 ESCAPE '\\'"
        } else {
            "i.message_id IN (SELECT message_id FROM agent_session_search_fts WHERE agent_session_search_fts MATCH ?4)"
        };
        // SQLite substr counts Unicode code points; at most 50 × 240 excerpt
        // characters cross the DB boundary even for very long messages.
        let sql = format!("SELECT s.id,i.message_id,i.runtime_entry_id,i.ordinal,i.role,i.created_at,i.text_hash,substr(i.text,CASE WHEN instr(lower(i.text),lower(?6))>40 THEN instr(lower(i.text),lower(?6))-40 ELSE 1 END,{SNIPPET_CHARS_MAX}),i.runtime_entry_id,s.title FROM agent_session_search_rows i JOIN agent_sessions s ON s.id=i.session_id WHERE s.scope_key=?1 AND (?2 IS NULL OR s.id=?2) AND i.message_id>?3 AND i.complete=1 AND {match_sql} ORDER BY i.message_id LIMIT ?5");
        let mut stmt = tx.prepare(&sql).map_err(io_error)?;
        let mut matches = stmt
            .query_map(
                params![
                    scope_key,
                    input.session_id,
                    input.after_message_id.as_deref().unwrap_or(""),
                    filter,
                    input.limit as i64 + 1,
                    query
                ],
                |r| {
                    Ok(AgentSessionSearchHit {
                        session_id: r.get(0)?,
                        message_id: r.get(1)?,
                        runtime_entry_id: r.get(2)?,
                        ordinal: r.get::<_, i64>(3)? as u64,
                        role: match r.get::<_, String>(4)?.as_str() {
                            "user" => MessageRole::User,
                            "assistant" => MessageRole::Assistant,
                            _ => MessageRole::Tool,
                        },
                        created_at: r.get(5)?,
                        content_hash: r.get(6)?,
                        branch_leaf_id: r.get(8)?,
                        snippet: r.get(7)?,
                        session_title: r.get(9)?,
                    })
                },
            )
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error)?;
        let more = matches.len() > input.limit as usize;
        matches.truncate(input.limit as usize);
        let next_cursor = (more && remaining == 0 && pending == 0)
            .then(|| matches.last().unwrap().message_id.clone());
        drop(stmt);
        tx.commit().map_err(io_error)?;
        Ok(AgentSessionSearchPage {
            matches,
            next_cursor,
            coverage: AgentSessionSearchCoverage {
                indexed_messages: indexed as u64,
                remaining_messages: remaining as u64,
                backfilled_this_request: 0,
                complete: remaining == 0 && pending == 0,
                pending_sessions: pending as u64,
            },
        })
    }
}

impl Database {
    pub(crate) fn agent_session_scan_work(
        &self,
        request: &RequestContext,
        current: &WorkspaceBinding,
        scope: &Scope,
        session_id: Option<&str>,
    ) -> AgentResult<Option<SessionScanWork>> {
        authorize_index(self, request, current, scope)?;
        if session_id.is_some_and(|id| !id_valid(id)) {
            return Err(invalid("Invalid session ID"));
        }
        let scope_key = scope.key();
        if let Some(id) = session_id {
            let owner: Option<String> = self
                .conn
                .query_row(
                    "SELECT scope_key FROM agent_sessions WHERE id=?1",
                    [id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(io_error)?;
            if owner.as_deref() != Some(scope_key.as_str()) {
                return Err(AgentError::new(ErrorCode::NotFound, "Session not found"));
            }
        }
        // A model tool may scan its own settled checkpoint while its current
        // run waits for the tool response. Other active sessions stay deferred.
        let own_run = match &request.caller {
            Caller::BuiltinRun { run_id } => Some(run_id.as_str()),
            _ => None,
        };
        let row: Option<(String,String,Option<String>,Option<i64>,Option<String>,Option<i64>)> = self.conn.query_row(
            "SELECT s.id,json_extract(s.checkpoint_json,'$.checksum'),st.checksum,st.entry_count,st.cursor_json,st.complete FROM agent_sessions s LEFT JOIN agent_session_scan_state st ON st.session_id=s.id WHERE s.scope_key=?1 AND (?2 IS NULL OR s.id=?2) AND s.runtime_id='builtin-pi' AND s.checkpoint_json IS NOT NULL AND json_extract(s.checkpoint_json,'$.checksum') IS NOT NULL AND (st.session_id IS NULL OR st.checksum!=json_extract(s.checkpoint_json,'$.checksum') OR st.complete=0) AND NOT EXISTS(SELECT 1 FROM agent_runs r WHERE r.session_id=s.id AND r.state IN ('preparing','running','cancelling') AND (?3 IS NULL OR r.id!=?3 OR r.state='cancelling')) ORDER BY s.updated_at DESC,s.id LIMIT 1",
            params![scope_key,session_id,own_run],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)),
        ).optional().map_err(io_error)?;
        row.map(
            |(session_id, checksum, old_checksum, old_count, old_cursor, old_complete)| {
                let state = old_checksum
                    .map(|checksum| -> AgentResult<ScanState> {
                        Ok(ScanState {
                            checksum,
                            entry_count: old_count.unwrap_or(0) as u64,
                            cursor: old_cursor
                                .map(|v| {
                                    serde_json::from_str(&v).map_err(|_| {
                                        AgentError::new(ErrorCode::IoFailed, "Invalid scan cursor")
                                    })
                                })
                                .transpose()?,
                            complete: old_complete.unwrap_or(0) != 0,
                        })
                    })
                    .transpose()?;
                let changed = state.as_ref().is_some_and(|st| st.checksum != checksum);
                let cursor = state.as_ref().and_then(|st| {
                    if st.complete {
                        Some(ScanCursor {
                            entry_offset: st.entry_count,
                            char_offset: 0,
                        })
                    } else {
                        st.cursor.clone()
                    }
                });
                Ok(SessionScanWork {
                    session_id,
                    checksum,
                    cursor,
                    previous_checkpoint: changed
                        .then(|| {
                            state.as_ref().map(|st| ScanCheckpoint {
                                checksum: st.checksum.clone(),
                                entry_count: st.entry_count,
                            })
                        })
                        .flatten(),
                    expected_state: state,
                })
            },
        )
        .transpose()
    }

    pub(crate) fn agent_session_scan_commit(
        &self,
        request: &RequestContext,
        current: &WorkspaceBinding,
        work: &SessionScanWork,
        page: &SessionScanPage,
    ) -> AgentResult<()> {
        if !id_valid(&work.session_id) {
            return Err(invalid("Invalid session ID"));
        }
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let session: Option<(String, String, Option<String>)> = tx
            .query_row(
                "SELECT scope_key,runtime_id,checkpoint_json FROM agent_sessions WHERE id=?1",
                [&work.session_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(io_error)?;
        let Some((scope_key, runtime_id, checkpoint)) = session else {
            return Err(AgentError::new(ErrorCode::NotFound, "Session not found"));
        };
        let scope = parse_scope_key(&scope_key)?;
        authorize_index(self, request, current, &scope)?;
        if runtime_id != "builtin-pi"
            || checkpoint
                .as_deref()
                .and_then(checkpoint_checksum)
                .as_deref()
                != Some(work.checksum.as_str())
        {
            return Err(AgentError::new(
                ErrorCode::RevisionConflict,
                "Session checkpoint changed",
            ));
        }
        let state: Option<ScanState> = tx.query_row(
            "SELECT checksum,entry_count,cursor_json,complete FROM agent_session_scan_state WHERE session_id=?1",[&work.session_id],
            |r| { let cursor:Option<String>=r.get(2)?; Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,cursor,r.get::<_,i64>(3)?)) },
        ).optional().map_err(io_error)?.map(|(checksum,entry_count,cursor,complete)| -> AgentResult<ScanState> {
            Ok(ScanState { checksum,entry_count:entry_count as u64,cursor:cursor.map(|v|serde_json::from_str(&v).map_err(|_|AgentError::new(ErrorCode::IoFailed,"Invalid scan cursor"))).transpose()?,complete:complete!=0 })
        }).transpose()?;
        if state != work.expected_state {
            return Err(AgentError::new(
                ErrorCode::RevisionConflict,
                "Session scan advanced",
            ));
        }
        let own_run = match &request.caller {
            Caller::BuiltinRun { run_id } => Some(run_id.as_str()),
            _ => None,
        };
        let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM agent_runs WHERE session_id=?1 AND state IN ('preparing','running','cancelling') AND (?2 IS NULL OR id!=?2 OR state='cancelling'))",params![work.session_id,own_run],|r|r.get(0)).map_err(io_error)?;
        if active {
            return Err(AgentError::new(
                ErrorCode::RevisionConflict,
                "Session run started during scan",
            ));
        }
        if work
            .previous_checkpoint
            .as_ref()
            .map(|v| (&v.checksum, v.entry_count))
            != state
                .as_ref()
                .filter(|v| v.checksum != work.checksum)
                .map(|v| (&v.checksum, v.entry_count))
        {
            return Err(invalid("Invalid previous scan checkpoint"));
        }
        if page.session_id != work.session_id
            || page.checksum != work.checksum
            || page.messages.len() > 200
            || page.complete != page.next_cursor.is_none()
            || page.next_cursor.as_ref().is_some_and(|cursor| {
                cursor.entry_offset >= page.entry_count
                    || (cursor.entry_offset, cursor.char_offset)
                        <= work
                            .cursor
                            .as_ref()
                            .map(|old| (old.entry_offset, old.char_offset))
                            .unwrap_or((0, 0))
            })
        {
            return Err(invalid("Invalid session scan page"));
        }
        let entry_count = checkpoint
            .as_deref()
            .and_then(|v| serde_json::from_str::<serde_json::Value>(v).ok())
            .and_then(|v| v.get("entryCount").and_then(|v| v.as_u64()))
            .ok_or_else(|| invalid("Invalid session checkpoint"))?;
        if page.entry_count != entry_count {
            return Err(AgentError::new(
                ErrorCode::RevisionConflict,
                "Session scan entry count changed",
            ));
        }
        let mut total_chars = 0usize;
        for message in &page.messages {
            let chars = message.text.chars().count();
            total_chars = total_chars.saturating_add(chars);
            let expected_id = format!(
                "{:x}",
                Sha256::digest(
                    format!("{}:{}", work.session_id, message.runtime_entry_id).as_bytes()
                )
            );
            if total_chars > 262_144
                || chars == 0
                || !id_valid(&message.message_id)
                || message.message_id != expected_id[..32]
                || message.runtime_entry_id.is_empty()
                || message.runtime_entry_id.len() > 128
                || message.branch_id != message.runtime_entry_id
                || !matches!(message.role, MessageRole::User | MessageRole::Assistant)
                || message.created_at.is_empty()
                || message.ordinal >= entry_count
                || message.char_end < message.char_start
                || message.char_end > message.total_chars
                || (message.char_end - message.char_start) as usize != chars
                || message.content_hash.len() != 71
                || !message.content_hash.starts_with("sha256:")
                || !message.content_hash[7..]
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit())
            {
                return Err(invalid("Invalid session scan fragment"));
            }
            let old: Option<(String,String,String,i64,String,String,i64,i64)> = tx.query_row(
                "SELECT session_id,runtime_entry_id,text_hash,ordinal,role,text,total_chars,complete FROM agent_session_search_rows WHERE message_id=?1",[&message.message_id],
                |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?)),
            ).optional().map_err(io_error)?;
            if let Some((session, entry, hash, ordinal, role, text, total, complete)) = &old {
                if session != &work.session_id
                    || entry != &message.runtime_entry_id
                    || hash != &message.content_hash
                    || *ordinal != message.ordinal as i64
                    || role != message.role.sql()
                    || *total != message.total_chars as i64
                {
                    return Err(invalid("Conflicting session scan fragment"));
                }
                if *complete != 0 {
                    continue;
                }
                if text.chars().count() != message.char_start as usize {
                    return Err(invalid("Nonconsecutive scan fragment"));
                }
            } else if message.char_start != 0 {
                return Err(invalid("Scan fragment has no prefix"));
            }
            let mut text = old.map(|row| row.5).unwrap_or_default();
            text.push_str(&message.text);
            let complete = message.char_end == message.total_chars;
            if complete
                && message.content_hash != format!("sha256:{:x}", Sha256::digest(text.as_bytes()))
            {
                return Err(invalid("Session scan content hash mismatch"));
            }
            tx.execute("INSERT INTO agent_session_search_rows(message_id,session_id,runtime_entry_id,ordinal,role,created_at,text_hash,text,total_chars,complete) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(message_id) DO UPDATE SET text=excluded.text,complete=excluded.complete",
                params![message.message_id,work.session_id,message.runtime_entry_id,message.ordinal as i64,message.role.sql(),message.created_at,message.content_hash,text,message.total_chars as i64,complete as i64]).map_err(io_error)?;
            if complete {
                tx.execute(
                    "INSERT INTO agent_session_search_fts(message_id,text) VALUES (?1,?2)",
                    params![message.message_id, text],
                )
                .map_err(io_error)?;
                super::agent_session_maintenance::session_message_changed(&tx,&current.workspace_id,&work.session_id,&message.message_id,&message.content_hash)?;
            }
        }
        if page.complete {
            let partial: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM agent_session_search_rows WHERE session_id=?1 AND complete=0)",[&work.session_id],|r|r.get(0)).map_err(io_error)?;
            if partial {
                return Err(invalid("Session scan ended with incomplete text"));
            }
        }
        let next_json = page
            .next_cursor
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|_| invalid("Invalid scan cursor"))?;
        tx.execute("INSERT INTO agent_session_scan_state(session_id,checksum,entry_count,cursor_json,complete) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(session_id) DO UPDATE SET checksum=excluded.checksum,entry_count=excluded.entry_count,cursor_json=excluded.cursor_json,complete=excluded.complete",
            params![work.session_id,work.checksum,page.entry_count as i64,next_json,page.complete as i64]).map_err(io_error)?;
        tx.commit().map_err(io_error)
    }
}

#[cfg(test)]
#[path = "agent_session_search_tests.rs"]
mod tests;
