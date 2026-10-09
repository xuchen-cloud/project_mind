//! Persistent, flat provenance for Host-observed native runs.
use super::{
    agent_operations::{io_error, parse_scope_key},
    Database,
};
use crate::agent::{
    access::{Caller, RequestContext},
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ObservedSource {
    pub object: ObjectRef,
    pub revision: Option<String>,
}

fn error(code: ErrorCode, message: &str) -> AgentError {
    AgentError::new(code, message)
}
fn own_run(request: &RequestContext) -> AgentResult<&str> {
    match &request.caller {
        Caller::BuiltinRun { run_id } => Ok(run_id),
        _ => Err(error(
            ErrorCode::ScopeDenied,
            "Native provenance requires the owning Run",
        )),
    }
}
fn run_session(conn: &Connection, run_id: &str) -> AgentResult<(String, Scope, String)> {
    let row: (String, String, String) = conn.query_row(
        "SELECT r.session_id,s.scope_key,r.state FROM agent_runs r JOIN agent_sessions s ON s.id=r.session_id WHERE r.id=?1",
        [run_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).optional().map_err(io_error)?.ok_or_else(|| error(ErrorCode::NotFound, "Run not found"))?;
    Ok((row.0, parse_scope_key(&row.1)?, row.2))
}
fn observed(conn: &Connection, run_id: &str) -> AgentResult<Option<Vec<ObservedSource>>> {
    let began: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_run_provenance WHERE run_id=?1)",
            [run_id],
            |r| r.get(0),
        )
        .map_err(io_error)?;
    if !began {
        return Ok(None);
    }
    let mut stmt = conn.prepare("SELECT object_key,object_json,revision FROM agent_run_source_dependencies WHERE run_id=?1 ORDER BY object_key,revision").map_err(io_error)?;
    let rows = stmt
        .query_map([run_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(io_error)?;
    rows.map(|row| {
        let (key, json, revision) = row.map_err(io_error)?;
        let object: ObjectRef = serde_json::from_str(&json)
            .map_err(|_| error(ErrorCode::IoFailed, "Invalid stored source reference"))?;
        if object
            .key()
            .map_err(|_| error(ErrorCode::IoFailed, "Invalid stored source reference"))?
            != key
        {
            return Err(error(
                ErrorCode::IoFailed,
                "Stored source identity mismatch",
            ));
        }
        Ok(ObservedSource {
            object,
            revision: if revision.is_empty() {
                None
            } else {
                Some(revision)
            },
        })
    })
    .collect::<AgentResult<Vec<_>>>()
    .map(Some)
}
fn is_hidden(code: ErrorCode) -> bool {
    matches!(
        code,
        ErrorCode::NotFound
            | ErrorCode::ScopeDenied
            | ErrorCode::ObjectWithdrawn
            | ErrorCode::SourceNotReady
    )
}
impl Database {
    fn provenance_read_request(&self, request: &RequestContext) -> RequestContext {
        let mut read = request.clone();
        if !read
            .scope_grant
            .operations
            .iter()
            .any(|op| op == "source.read")
        {
            read.scope_grant.operations.push("source.read".into());
        }
        read
    }
    fn provenance_authorize_run(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        run_id: &str,
    ) -> AgentResult<(String, Scope, String)> {
        let (session, scope, state) = run_session(&self.conn, run_id)?;
        if self
            .native_workspace_id
            .as_ref()
            .is_some_and(|id| id != &binding.workspace_id)
        {
            return Err(error(
                ErrorCode::WorkspaceChanged,
                "Workspace binding changed",
            ));
        }
        request.authorize(binding, &scope, "session.read")?;
        Ok((session, scope, state))
    }
    fn provenance_store(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        sources: &[ObservedSource],
        begin: bool,
    ) -> AgentResult<()> {
        let run_id = own_run(request)?;
        if self
            .native_workspace_id
            .as_ref()
            .is_some_and(|id| id != &binding.workspace_id)
        {
            return Err(error(
                ErrorCode::WorkspaceChanged,
                "Workspace binding changed",
            ));
        }
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let (_, scope, state) = run_session(&tx, run_id)?;
        request.authorize(binding, &scope, "run.start")?;
        if state != "preparing" && state != "running" {
            return Err(error(
                ErrorCode::InvalidRunTransition,
                "Run is no longer active",
            ));
        }
        if begin {
            tx.execute(
                "INSERT OR IGNORE INTO agent_run_provenance(run_id) VALUES (?1)",
                [run_id],
            )
            .map_err(io_error)?;
        } else if observed(&tx, run_id)?.is_none() {
            return Err(error(
                ErrorCode::SourceNotReady,
                "Run provenance has not begun",
            ));
        }
        let read = self.provenance_read_request(request);
        for source in sources {
            if source.revision.as_deref().is_some_and(str::is_empty) {
                return Err(error(ErrorCode::InvalidArgument, "Empty source revision"));
            }
            let resolved = self.source_read_object(&read, binding, &source.object)?;
            let key = resolved.key()?;
            let json = serde_json::to_string(&resolved)
                .map_err(|_| error(ErrorCode::IoFailed, "Cannot encode source reference"))?;
            tx.execute("INSERT OR IGNORE INTO agent_run_source_dependencies(run_id,object_key,object_json,revision) VALUES (?1,?2,?3,?4)",params![run_id,key,json,source.revision.as_deref().unwrap_or("")]).map_err(io_error)?;
        }
        tx.commit().map_err(io_error)
    }
    pub(crate) fn agent_run_provenance_begin(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        sources: &[ObservedSource],
    ) -> AgentResult<()> {
        self.provenance_store(request, binding, sources, true)
    }
    pub(crate) fn agent_run_provenance_observe(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        sources: &[ObservedSource],
    ) -> AgentResult<()> {
        self.provenance_store(request, binding, sources, false)
    }
    pub(crate) fn agent_run_provenance_sources(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        run_id: &str,
    ) -> AgentResult<Option<Vec<ObservedSource>>> {
        self.provenance_authorize_run(request, binding, run_id)?;
        observed(&self.conn, run_id)
    }
    /// Checks a set of stored references against current ownership and policy.
    pub(crate) fn agent_run_provenance_sources_visible(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        sources: &[ObservedSource],
    ) -> AgentResult<bool> {
        let read = self.provenance_read_request(request);
        for source in sources {
            match self.source_read_object(&read, binding, &source.object) {
                Ok(_) => (),
                Err(err) if is_hidden(err.code) => return Ok(false),
                Err(err) => return Err(err),
            }
        }
        Ok(true)
    }
    pub(crate) fn agent_run_provenance_visible(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        run_id: &str,
    ) -> AgentResult<bool> {
        match self.provenance_authorize_run(request, binding, run_id) {
            Ok(_) => (),
            Err(err) if is_hidden(err.code) => return Ok(false),
            Err(err) => return Err(err),
        }
        let Some(sources) = observed(&self.conn, run_id)? else {
            return Ok(false);
        };
        self.agent_run_provenance_sources_visible(request, binding, &sources)
    }
    pub(crate) fn agent_run_context_check(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        candidate_entry_ids: &[String],
    ) -> AgentResult<Vec<String>> {
        let current_id = own_run(request)?;
        if candidate_entry_ids.len() > 10_000
            || candidate_entry_ids
                .iter()
                .any(|id| id.is_empty() || id.len() > 128)
        {
            return Err(error(
                ErrorCode::InvalidArgument,
                "Invalid context message identities",
            ));
        }
        let mut seen = HashSet::new();
        let candidates: Vec<&str> = candidate_entry_ids
            .iter()
            .map(String::as_str)
            .filter(|id| seen.insert(*id))
            .collect();
        let candidates_json = serde_json::to_string(&candidates).map_err(|_| {
            error(
                ErrorCode::InvalidArgument,
                "Invalid context message identities",
            )
        })?;
        if self
            .native_workspace_id
            .as_ref()
            .is_some_and(|id| id != &binding.workspace_id)
        {
            return Err(error(
                ErrorCode::WorkspaceChanged,
                "Workspace binding changed",
            ));
        }
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let (session, scope, state) = run_session(&tx, current_id)?;
        request.authorize(binding, &scope, "session.read")?;
        request.authorize(binding, &scope, "run.start")?;
        if state != "preparing" && state != "running" {
            return Err(error(
                ErrorCode::InvalidRunTransition,
                "Run is no longer active",
            ));
        }
        let Some(current_sources) = observed(&tx, current_id)? else {
            return Err(error(
                ErrorCode::SourceNotReady,
                "Run provenance has not begun",
            ));
        };
        if !self.agent_run_provenance_sources_visible(request, binding, &current_sources)? {
            return Err(error(
                ErrorCode::ScopeDenied,
                "Run source is no longer visible",
            ));
        }
        let rows: Vec<(String, String, Option<String>, String)> = {
            let mut stmt=tx.prepare("SELECT id,role,run_id,runtime_entry_id FROM agent_messages WHERE session_id=?1 AND runtime_entry_id IN (SELECT value FROM json_each(?2)) ORDER BY ordinal").map_err(io_error)?;
            let rows = stmt
                .query_map(params![session, candidates_json], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })
                .map_err(io_error)?;
            rows.collect::<rusqlite::Result<_>>().map_err(io_error)?
        };
        let read = self.provenance_read_request(request);
        let mut allowed = Vec::new();
        for (message_id, role, source_run, entry) in rows {
            let message_source = ObservedSource {
                object: ObjectRef {
                    workspace_id: binding.workspace_id.clone(),
                    scope: scope.clone(),
                    kind: ObjectKind::SessionMessage,
                    id: message_id,
                },
                revision: None,
            };
            if role == "user" {
                if self.agent_run_provenance_sources_visible(
                    &read,
                    binding,
                    std::slice::from_ref(&message_source),
                )? {
                    allowed.push(entry);
                    self.provenance_insert(&tx, current_id, &message_source)?;
                }
                continue;
            }
            if role != "assistant" && role != "tool" {
                return Err(error(ErrorCode::IoFailed, "Invalid stored message role"));
            }
            let Some(source_run) = source_run else {
                continue;
            };
            if source_run == current_id {
                continue;
            }
            let Some(sources) = observed(&tx, &source_run)? else {
                continue;
            };
            if !self.agent_run_provenance_sources_visible(&read, binding, &sources)? {
                continue;
            }
            if !self.agent_run_provenance_sources_visible(
                &read,
                binding,
                std::slice::from_ref(&message_source),
            )? {
                continue;
            }
            if role == "assistant" {
                self.provenance_insert(&tx, current_id, &message_source)?;
            }
            for source in &sources {
                self.provenance_insert(&tx, current_id, source)?;
            }
            allowed.push(entry);
        }
        tx.commit().map_err(io_error)?;
        Ok(allowed)
    }
    fn provenance_insert(
        &self,
        tx: &Transaction<'_>,
        run_id: &str,
        source: &ObservedSource,
    ) -> AgentResult<()> {
        tx.execute("INSERT OR IGNORE INTO agent_run_source_dependencies(run_id,object_key,object_json,revision) VALUES (?1,?2,?3,?4)",params![run_id,source.object.key()?,serde_json::to_string(&source.object).map_err(|_|error(ErrorCode::IoFailed,"Cannot encode source reference"))?,source.revision.as_deref().unwrap_or("")]).map_err(io_error)?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "agent_run_provenance_tests.rs"]
mod tests;
