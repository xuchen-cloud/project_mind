//! GUI candidates over the current, Host-verified Pi projection. Pi JSONL remains
//! the authority for opening a result at its checkpoint branch anchor.
use super::{agent_operations::io_error, Database};
use crate::agent::{
    access::{Caller, RequestContext},
    conversation::{MessageRole, ProjectionMessage},
    errors::{AgentError, AgentResult, ErrorCode},
    models::{Scope, WorkspaceBinding},
};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const BACKFILL_MESSAGES_MAX: usize = 200;
const BACKFILL_BYTES_MAX: usize = 2 * 1024 * 1024;
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSessionSearchPage {
    pub matches: Vec<AgentSessionSearchHit>,
    pub next_cursor: Option<String>,
    pub coverage: AgentSessionSearchCoverage,
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

fn index_message(
    tx: &Transaction<'_>,
    message_id: &str,
    message: &ProjectionMessage,
) -> AgentResult<()> {
    let text = text_of(message);
    let hash = text
        .as_ref()
        .map(|value| format!("sha256:{:x}", Sha256::digest(value.as_bytes())));
    let old: Option<(Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT text_hash,text FROM agent_session_search_rows WHERE message_id=?1",
            [message_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(io_error)?;
    if old.as_ref() == Some(&(hash.clone(), text.clone())) {
        return Ok(());
    }
    tx.execute(
        "INSERT INTO agent_session_search_rows(message_id,text_hash,text) VALUES (?1,?2,?3) ON CONFLICT(message_id) DO UPDATE SET text_hash=excluded.text_hash,text=excluded.text",
        params![message_id, hash, text],
    )
    .map_err(io_error)?;
    tx.execute(
        "DELETE FROM agent_session_search_fts WHERE message_id=?1",
        [message_id],
    )
    .map_err(io_error)?;
    if let Some(text) = text {
        tx.execute(
            "INSERT INTO agent_session_search_fts(message_id,text) VALUES (?1,?2)",
            params![message_id, text],
        )
        .map_err(io_error)?;
    }
    Ok(())
}

pub(super) fn projection_index_message(
    tx: &Transaction<'_>,
    message_id: &str,
    message: &ProjectionMessage,
) -> AgentResult<()> {
    index_message(tx, message_id, message)
}

fn backfill(tx: &Transaction<'_>, scope_key: &str, session_id: Option<&str>) -> AgentResult<u16> {
    let mut pending = Vec::new();
    let mut bytes = 0usize;
    {
        let mut stmt = tx.prepare(
            "SELECT m.id,m.content_json FROM agent_messages m JOIN agent_sessions s ON s.id=m.session_id LEFT JOIN agent_session_search_rows i ON i.message_id=m.id WHERE s.scope_key=?1 AND (?2 IS NULL OR s.id=?2) AND m.state='complete' AND s.checkpoint_json IS NOT NULL AND json_extract(s.checkpoint_json,'$.leafId') IS NOT NULL AND i.message_id IS NULL ORDER BY m.id LIMIT ?3",
        ).map_err(io_error)?;
        let mut rows = stmt
            .query(params![scope_key, session_id, BACKFILL_MESSAGES_MAX as i64])
            .map_err(io_error)?;
        while let Some(row) = rows.next().map_err(io_error)? {
            let id: String = row.get(0).map_err(io_error)?;
            let json: String = row.get(1).map_err(io_error)?;
            bytes = bytes.saturating_add(json.len());
            pending.push((id, json));
            if bytes >= BACKFILL_BYTES_MAX {
                break;
            }
        }
    }
    for (id, json) in &pending {
        let message: ProjectionMessage = serde_json::from_str(json).map_err(|_| {
            AgentError::new(
                ErrorCode::IoFailed,
                "Invalid stored conversation projection",
            )
        })?;
        index_message(tx, id, &message)?;
    }
    Ok(pending.len() as u16)
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
        input.scope.validate()?;
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
        request.authorize(current, &input.scope, "session.read")?;
        if !(1..=50).contains(&input.limit)
            || input.query.trim().is_empty()
            || input.query.chars().count() > 256
            || input.session_id.as_deref().is_some_and(|id| !id_valid(id))
            || input
                .after_message_id
                .as_deref()
                .is_some_and(|id| !id_valid(id))
        {
            return Err(invalid("Invalid history search request"));
        }
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
        let backfilled = backfill(&tx, &scope_key, input.session_id.as_deref())?;
        let (indexed, remaining): (i64, i64) = tx.query_row(
            "SELECT count(i.message_id),count(*)-count(i.message_id) FROM agent_messages m JOIN agent_sessions s ON s.id=m.session_id LEFT JOIN agent_session_search_rows i ON i.message_id=m.id WHERE s.scope_key=?1 AND (?2 IS NULL OR s.id=?2) AND m.state='complete' AND s.checkpoint_json IS NOT NULL AND json_extract(s.checkpoint_json,'$.leafId') IS NOT NULL",
            params![scope_key,input.session_id], |r| Ok((r.get(0)?,r.get(1)?)),
        ).map_err(io_error)?;
        if input.after_message_id.is_some() && (remaining != 0 || backfilled != 0) {
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
            "m.id IN (SELECT message_id FROM agent_session_search_fts WHERE agent_session_search_fts MATCH ?4)"
        };
        // SQLite substr counts Unicode code points; at most 50 × 240 excerpt
        // characters cross the DB boundary even for very long messages.
        let sql = format!("SELECT s.id,m.id,m.runtime_entry_id,m.ordinal,m.role,m.created_at,i.text_hash,substr(i.text,CASE WHEN instr(lower(i.text),lower(?6))>40 THEN instr(lower(i.text),lower(?6))-40 ELSE 1 END,{SNIPPET_CHARS_MAX}),json_extract(s.checkpoint_json,'$.leafId'),s.title FROM agent_session_search_rows i JOIN agent_messages m ON m.id=i.message_id JOIN agent_sessions s ON s.id=m.session_id WHERE s.scope_key=?1 AND (?2 IS NULL OR s.id=?2) AND m.id>?3 AND m.state='complete' AND s.checkpoint_json IS NOT NULL AND json_extract(s.checkpoint_json,'$.leafId') IS NOT NULL AND {match_sql} ORDER BY m.id LIMIT ?5");
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
        let next_cursor =
            (more && remaining == 0).then(|| matches.last().unwrap().message_id.clone());
        drop(stmt);
        tx.commit().map_err(io_error)?;
        Ok(AgentSessionSearchPage {
            matches,
            next_cursor,
            coverage: AgentSessionSearchCoverage {
                indexed_messages: indexed as u64,
                remaining_messages: remaining as u64,
                backfilled_this_request: backfilled,
                complete: remaining == 0,
            },
        })
    }
}

#[cfg(test)]
#[path = "agent_session_search_tests.rs"]
mod tests;
