//! Session message source events share the native change outbox.
use super::{
    agent_operations::{io_error, parse_scope_key},
    Database,
};
use crate::agent::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
};
use chrono::Utc;
use rusqlite::{params, Connection, Transaction, TransactionBehavior};

const UNSEEDED_CONDITION: &str = "r.object_key IS NULL OR r.deleted_at IS NOT NULL OR (r.event_revision!=i.text_hash AND COALESCE((SELECT l.revision FROM agent_change_log l WHERE l.object_key=r.object_key AND l.operation='session.message.index' ORDER BY l.seq DESC LIMIT 1),'')!=i.text_hash)";

fn session_scope(conn: &Connection, session_id: &str) -> AgentResult<Scope> {
    let key: String = conn
        .query_row(
            "SELECT scope_key FROM agent_sessions WHERE id=?1",
            [session_id],
            |r| r.get(0),
        )
        .map_err(io_error)?;
    parse_scope_key(&key)
}
fn object_key(workspace_id: &str, scope: &Scope, message_id: &str) -> AgentResult<String> {
    ObjectRef {
        workspace_id: workspace_id.into(),
        scope: scope.clone(),
        kind: ObjectKind::SessionMessage,
        id: message_id.into(),
    }
    .key()
}
fn append_event(
    tx: &Transaction<'_>,
    workspace_id: &str,
    scope: &Scope,
    message_id: &str,
    revision: &str,
) -> AgentResult<()> {
    tx.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES (?1,?2,?3,?4,?5)",params![object_key(workspace_id,scope,message_id)?,scope.key(),if revision=="deleted" {"session.message.delete"} else {"session.message.index"},revision,Utc::now().to_rfc3339()]).map_err(io_error)?;
    Ok(())
}

pub(super) fn session_message_changed(
    tx: &Transaction<'_>,
    workspace_id: &str,
    session_id: &str,
    message_id: &str,
    text_hash: &str,
) -> AgentResult<()> {
    let scope = session_scope(tx, session_id)?;
    append_event(tx, workspace_id, &scope, message_id, text_hash)
}

pub(super) fn session_messages_deleted(
    tx: &Transaction<'_>,
    workspace_id: &str,
    session_id: &str,
) -> AgentResult<()> {
    let scope = session_scope(tx, session_id)?;
    let ids: Vec<String> = {
        let mut stmt=tx.prepare("SELECT message_id FROM agent_session_search_rows WHERE session_id=?1 AND complete=1").map_err(io_error)?;
        let rows = stmt
            .query_map([session_id], |r| r.get(0))
            .map_err(io_error)?;
        rows.collect::<rusqlite::Result<_>>().map_err(io_error)?
    };
    for id in ids {
        append_event(tx, workspace_id, &scope, &id, "deleted")?;
    }
    Ok(())
}

impl Database {
    /// Both messages must still be present on the same current Pi branch.
    pub(crate) fn agent_session_message_precedes(
        &self,
        session_id: &str,
        older_message_id: &str,
        newer_message_id: &str,
    ) -> AgentResult<bool> {
        self.conn.query_row("SELECT EXISTS(SELECT 1 FROM agent_messages older JOIN agent_messages newer ON newer.session_id=older.session_id WHERE older.session_id=?1 AND older.id=?2 AND newer.id=?3 AND older.ordinal<newer.ordinal)",params![session_id,older_message_id,newer_message_id],|r|r.get(0)).map_err(io_error)
    }

    /// Report unfinished historical scanning or source ingestion without reading bodies.
    pub(crate) fn agent_session_maintenance_pending(&self, scope: &Scope) -> AgentResult<bool> {
        scope.validate()?;
        let workspace_id = self.native_workspace_id.as_deref().ok_or_else(|| {
            AgentError::new(ErrorCode::WorkspaceChanged, "Workspace is not bound")
        })?;
        let scope_key = scope.key();
        let scan_pending:bool=self.conn.query_row("SELECT EXISTS(SELECT 1 FROM agent_sessions s LEFT JOIN agent_session_scan_state st ON st.session_id=s.id WHERE s.scope_key=?1 AND s.runtime_id='builtin-pi' AND s.checkpoint_json IS NOT NULL AND json_extract(s.checkpoint_json,'$.checksum') IS NOT NULL AND (st.session_id IS NULL OR st.checksum!=json_extract(s.checkpoint_json,'$.checksum') OR st.complete=0))",[&scope_key],|r|r.get(0)).map_err(io_error)?;
        if scan_pending {
            return Ok(true);
        }
        let prefix = format!("{workspace_id}/{scope_key}/session_message/");
        self.conn.query_row(&format!("SELECT EXISTS(SELECT 1 FROM agent_session_search_rows i JOIN agent_sessions s ON s.id=i.session_id LEFT JOIN source_registry r ON r.object_key=?2||i.message_id WHERE s.scope_key=?1 AND i.complete=1 AND ({UNSEEDED_CONDITION}))"),params![scope_key,prefix],|r|r.get(0)).map_err(io_error)
    }

    /// Incrementally register complete historical rows with no matching source event.
    pub(crate) fn agent_session_maintenance_seed(
        &self,
        binding: &WorkspaceBinding,
        scope: &Scope,
        limit: u16,
    ) -> AgentResult<bool> {
        if limit == 0 || limit > 200 {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid session seed limit",
            ));
        }
        scope.validate()?;
        if self
            .native_workspace_id
            .as_ref()
            .is_some_and(|id| id != &binding.workspace_id)
        {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Workspace binding changed",
            ));
        }
        self.source_live_scope(scope)?;
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let prefix = format!("{}/{}/session_message/", binding.workspace_id, scope.key());
        let rows: Vec<(String, String)> = {
            let mut stmt=tx.prepare(&format!("SELECT i.message_id,i.text_hash FROM agent_session_search_rows i JOIN agent_sessions s ON s.id=i.session_id LEFT JOIN source_registry r ON r.object_key=?2||i.message_id WHERE s.scope_key=?1 AND i.complete=1 AND ({UNSEEDED_CONDITION}) ORDER BY i.message_id LIMIT ?3")).map_err(io_error)?;
            let found = stmt
                .query_map(params![scope.key(), prefix, i64::from(limit) + 1], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .map_err(io_error)?;
            found.collect::<rusqlite::Result<_>>().map_err(io_error)?
        };
        let has_more = rows.len() > usize::from(limit);
        for (id, hash) in rows.into_iter().take(usize::from(limit)) {
            append_event(&tx, &binding.workspace_id, scope, &id, &hash)?;
        }
        tx.commit().map_err(io_error)?;
        Ok(has_more)
    }
}

#[cfg(test)]
#[path = "agent_session_maintenance_tests.rs"]
mod tests;
