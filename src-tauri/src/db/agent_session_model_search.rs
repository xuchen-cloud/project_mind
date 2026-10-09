//! Model history access over the independent, verified Pi search projection.
use super::{
    agent_operations::{io_error, parse_scope_key},
    Database,
};
use crate::agent::{
    access::{Caller, RequestContext},
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, Scope, SourceLocator, SourceRef, WorkspaceBinding},
};
use crate::source_service::SourceReadTarget;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

fn default_limit() -> u16 {
    8
}
fn default_budget() -> usize {
    4000
}
fn error(code: ErrorCode, message: &str) -> AgentError {
    AgentError::new(code, message)
}
fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelHistorySearchInput {
    pub scope: Scope,
    pub query: String,
    pub session_id: Option<String>,
    pub after_message_id: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: u16,
    #[serde(default = "default_budget")]
    pub budget_chars: usize,
}

impl ModelHistorySearchInput {
    pub(crate) fn validate(&self) -> AgentResult<()> {
        if self.query.trim().is_empty()
            || self.query.chars().count() > 256
            || !(1..=20).contains(&self.limit)
            || !(1..=12000).contains(&self.budget_chars)
            || self.session_id.as_deref().is_some_and(|id| !valid_id(id))
            || self
                .after_message_id
                .as_deref()
                .is_some_and(|id| !valid_id(id))
        {
            return Err(error(
                ErrorCode::InvalidArgument,
                "Invalid history search request",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "agent_session_model_search_tests.rs"]
mod tests;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelHistorySearchMatch {
    pub session_id: String,
    pub message_id: String,
    pub role: String,
    pub created_at: String,
    pub snippet: String,
    pub source_ref: SourceRef,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelHistorySearchPage {
    pub matches: Vec<ModelHistorySearchMatch>,
    pub next_cursor: Option<String>,
    pub coverage: ModelHistoryCoverage,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelHistoryCoverage {
    pub complete: bool,
    pub has_unavailable_history: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SourceReadRecord {
    pub session_id: String,
    pub message_id: String,
    pub scope: Scope,
    pub runtime_entry_id: String,
    pub ordinal: u64,
    pub text_hash: String,
    pub role: String,
    pub run_id: Option<String>,
    pub total_chars: u32,
}

impl SourceReadRecord {
    pub(crate) fn source_ref(&self, binding: &WorkspaceBinding) -> SourceRef {
        SourceRef {
            object: ObjectRef {
                workspace_id: binding.workspace_id.clone(),
                scope: self.scope.clone(),
                kind: ObjectKind::SessionMessage,
                id: self.message_id.clone(),
            },
            revision: self.text_hash.clone(),
            file_version: None,
            record_version: None,
            block_id: None,
            locator: Some(SourceLocator::Messages {
                session_id: self.session_id.clone(),
                branch_id: self.runtime_entry_id.clone(),
                start_message_id: self.message_id.clone(),
                end_message_id: self.message_id.clone(),
            }),
            title: "历史讨论".into(),
            excerpt: String::new(),
        }
    }
}

impl Database {
    /// Resolve a message from stored ownership, then apply both history and
    /// source grants. GUI maintenance uses this same source policy boundary.
    pub(crate) fn source_session_record(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        target: &SourceReadTarget,
    ) -> AgentResult<SourceReadRecord> {
        if target.object.kind != ObjectKind::SessionMessage
            || target.record_version.is_some()
            || target.file_version.is_some()
        {
            return Err(error(
                ErrorCode::InvalidArgument,
                "Expected a session message source",
            ));
        }
        let session:Option<String>=self.conn.query_row("SELECT session_id FROM agent_session_search_rows WHERE message_id=?1 AND complete=1",[&target.object.id],|r|r.get(0)).optional().map_err(io_error)?;
        let session =
            session.ok_or_else(|| error(ErrorCode::NotFound, "History message not found"))?;
        let record =
            self.agent_model_session_message_record(request, binding, &session, &target.object.id)?;
        request.authorize(binding, &record.scope, "source.read")?;
        if target.object != record.source_ref(binding).object
            || target
                .revision
                .as_ref()
                .is_some_and(|hash| hash != &record.text_hash)
        {
            return Err(error(
                ErrorCode::SourceChanged,
                "History message source changed",
            ));
        }
        Ok(record)
    }
    pub(crate) fn agent_model_session_source_record(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        source: &SourceRef,
    ) -> AgentResult<SourceReadRecord> {
        if source.object.kind != ObjectKind::SessionMessage {
            return Err(error(
                ErrorCode::InvalidArgument,
                "Expected history message source",
            ));
        }
        let session:Option<String>=self.conn.query_row("SELECT session_id FROM agent_session_search_rows WHERE message_id=?1 AND complete=1",[&source.object.id],|r|r.get(0)).optional().map_err(io_error)?;
        let session =
            session.ok_or_else(|| error(ErrorCode::NotFound, "History message not found"))?;
        let record =
            self.agent_model_session_message_record(request, binding, &session, &source.object.id)?;
        if source.revision != record.text_hash
            || source.object != record.source_ref(binding).object
            || serde_json::to_value(source.locator.as_ref()).ok()
                != serde_json::to_value(record.source_ref(binding).locator.as_ref()).ok()
        {
            return Err(error(ErrorCode::SourceNotReady, "History source changed"));
        }
        Ok(record)
    }
    fn model_history_authorize(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        scope: &Scope,
    ) -> AgentResult<()> {
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
        request.authorize(binding, scope, "session.read")
    }

    fn model_history_visible(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        record: &SourceReadRecord,
    ) -> AgentResult<bool> {
        let mut source_request = request.clone();
        if !source_request
            .scope_grant
            .operations
            .iter()
            .any(|op| op == "source.read")
        {
            source_request
                .scope_grant
                .operations
                .push("source.read".into());
        }
        let object = record.source_ref(binding).object;
        match self.source_read_object(&source_request, binding, &object) {
            Ok(_) => (),
            Err(e)
                if matches!(
                    e.code,
                    ErrorCode::NotFound
                        | ErrorCode::ScopeDenied
                        | ErrorCode::ObjectWithdrawn
                        | ErrorCode::SourceNotReady
                ) =>
            {
                return Ok(false)
            }
            Err(e) => return Err(e),
        }
        if record.role == "assistant" {
            let Some(run_id) = record.run_id.as_deref() else {
                return Ok(false);
            };
            return self.agent_run_provenance_visible(request, binding, run_id);
        }
        Ok(record.role == "user")
    }

    pub(crate) fn agent_model_session_message_record(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        session_id: &str,
        message_id: &str,
    ) -> AgentResult<SourceReadRecord> {
        if !valid_id(session_id) || !valid_id(message_id) {
            return Err(error(
                ErrorCode::InvalidArgument,
                "Invalid history identity",
            ));
        }
        let row: Option<(String,String,String,String,String,Option<String>,i64,i64)> = self.conn.query_row(
            "SELECT s.scope_key,i.runtime_entry_id,i.text_hash,i.role,i.session_id,i.run_id,i.total_chars,i.ordinal FROM agent_session_search_rows i JOIN agent_sessions s ON s.id=i.session_id WHERE i.session_id=?1 AND i.message_id=?2 AND i.complete=1 AND s.runtime_id='builtin-pi' AND s.checkpoint_json IS NOT NULL",
            params![session_id,message_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?)),
        ).optional().map_err(io_error)?;
        let (scope_key, entry, hash, role, session, run, total, ordinal) =
            row.ok_or_else(|| error(ErrorCode::NotFound, "History message not found"))?;
        let scope = parse_scope_key(&scope_key)?;
        self.model_history_authorize(request, binding, &scope)?;
        let record = SourceReadRecord {
            session_id: session,
            message_id: message_id.into(),
            scope,
            runtime_entry_id: entry,
            ordinal: ordinal as u64,
            text_hash: hash,
            role,
            run_id: run,
            total_chars: total as u32,
        };
        if !self.model_history_visible(request, binding, &record)? {
            return Err(error(ErrorCode::NotFound, "History message not found"));
        }
        Ok(record)
    }

    pub(crate) fn agent_model_session_search(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &ModelHistorySearchInput,
    ) -> AgentResult<ModelHistorySearchPage> {
        if !matches!(
            request.caller,
            Caller::BuiltinRun { .. } | Caller::Connection { .. }
        ) {
            return Err(error(
                ErrorCode::ScopeDenied,
                "History model search requires a trusted caller",
            ));
        }
        self.model_history_authorize(request, binding, &input.scope)?;
        input.validate()?;
        let scope_key = input.scope.key();
        if let Some(session_id) = input.session_id.as_deref() {
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
                return Err(error(ErrorCode::NotFound, "Session not found"));
            }
        }
        if let Some(cursor) = input.after_message_id.as_deref() {
            let owner:Option<String>=self.conn.query_row("SELECT s.scope_key FROM agent_session_search_rows i JOIN agent_sessions s ON s.id=i.session_id WHERE i.message_id=?1 AND (?2 IS NULL OR i.session_id=?2)",params![cursor,input.session_id],|r|r.get(0)).optional().map_err(io_error)?;
            if owner.as_deref() != Some(scope_key.as_str()) {
                return Err(error(
                    ErrorCode::InvalidArgument,
                    "History cursor is outside scope",
                ));
            }
        }
        let pending:bool=self.conn.query_row("SELECT EXISTS(SELECT 1 FROM agent_sessions s LEFT JOIN agent_session_scan_state st ON st.session_id=s.id WHERE s.scope_key=?1 AND (?2 IS NULL OR s.id=?2) AND s.runtime_id='builtin-pi' AND s.checkpoint_json IS NOT NULL AND (st.session_id IS NULL OR st.checksum!=json_extract(s.checkpoint_json,'$.checksum') OR st.complete=0)) OR EXISTS(SELECT 1 FROM agent_session_search_rows i JOIN agent_sessions s ON s.id=i.session_id WHERE s.scope_key=?1 AND (?2 IS NULL OR s.id=?2) AND i.complete=0)",params![scope_key,input.session_id],|r|r.get(0)).map_err(io_error)?;
        if pending && input.after_message_id.is_some() {
            return Err(error(
                ErrorCode::InvalidArgument,
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
        let predicate = if short {
            "i.text LIKE ?4 ESCAPE '\\'"
        } else {
            "i.message_id IN (SELECT message_id FROM agent_session_search_fts WHERE agent_session_search_fts MATCH ?4)"
        };
        let sql=format!("SELECT i.session_id,i.message_id,i.runtime_entry_id,i.text_hash,i.role,i.run_id,i.total_chars,i.created_at,substr(i.text,CASE WHEN instr(lower(i.text),lower(?6))>40 THEN instr(lower(i.text),lower(?6))-40 ELSE 1 END,240),i.ordinal FROM agent_session_search_rows i JOIN agent_sessions s ON s.id=i.session_id WHERE s.scope_key=?1 AND (?2 IS NULL OR i.session_id=?2) AND s.runtime_id='builtin-pi' AND s.checkpoint_json IS NOT NULL AND i.message_id>?3 AND i.complete=1 AND {predicate} ORDER BY i.message_id LIMIT 201");
        let mut stmt = self.conn.prepare(&sql).map_err(io_error)?;
        let candidates = stmt
            .query_map(
                params![
                    scope_key,
                    input.session_id,
                    input.after_message_id.as_deref().unwrap_or(""),
                    filter,
                    201,
                    query
                ],
                |r| {
                    Ok((
                        SourceReadRecord {
                            session_id: r.get(0)?,
                            message_id: r.get(1)?,
                            runtime_entry_id: r.get(2)?,
                            ordinal: r.get::<_, i64>(9)? as u64,
                            text_hash: r.get(3)?,
                            role: r.get(4)?,
                            run_id: r.get(5)?,
                            total_chars: r.get::<_, i64>(6)? as u32,
                            scope: input.scope.clone(),
                        },
                        r.get::<_, String>(7)?,
                        r.get::<_, String>(8)?,
                    ))
                },
            )
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error)?;
        let mut page = ModelHistorySearchPage {
            matches: Vec::new(),
            next_cursor: None,
            coverage: ModelHistoryCoverage {
                complete: !pending,
                has_unavailable_history: pending,
            },
        };
        let mut unavailable = pending;
        for (index, (record, created_at, snippet)) in candidates.iter().take(200).enumerate() {
            if !self.model_history_visible(request, binding, record)? {
                unavailable = true;
                continue;
            }
            let mut hit = ModelHistorySearchMatch {
                session_id: record.session_id.clone(),
                message_id: record.message_id.clone(),
                role: record.role.clone(),
                created_at: created_at.clone(),
                snippet: snippet.clone(),
                source_ref: record.source_ref(binding),
            };
            hit.snippet = hit.snippet.chars().take(240).collect();
            page.matches.push(hit);
            if serde_json::to_string(&page)
                .map_err(|_| error(ErrorCode::IoFailed, "Cannot encode history search"))?
                .chars()
                .count()
                > input.budget_chars
            {
                page.matches.pop();
                if page.matches.is_empty() {
                    return Err(error(
                        ErrorCode::BudgetExceeded,
                        "History search budget is too small",
                    ));
                }
                page.next_cursor = page.matches.last().map(|m| m.message_id.clone());
                if pending {
                    page.next_cursor = None;
                }
                page.coverage.has_unavailable_history = unavailable;
                page.coverage.complete = !pending;
                if serde_json::to_string(&page)
                    .map_err(|_| error(ErrorCode::IoFailed, "Cannot encode history search"))?
                    .chars()
                    .count()
                    > input.budget_chars
                {
                    return Err(error(
                        ErrorCode::BudgetExceeded,
                        "History search budget is too small",
                    ));
                }
                return Ok(page);
            }
            if page.matches.len() >= input.limit as usize {
                if index + 1 < candidates.len() && !pending {
                    page.next_cursor = Some(record.message_id.clone());
                }
                break;
            }
        }
        if candidates.len() > 200 && page.matches.len() < input.limit as usize && !pending {
            page.next_cursor = candidates.get(199).map(|row| row.0.message_id.clone());
        }
        page.coverage.has_unavailable_history = unavailable;
        page.coverage.complete = !pending;
        if serde_json::to_string(&page)
            .map_err(|_| error(ErrorCode::IoFailed, "Cannot encode history search"))?
            .chars()
            .count()
            > input.budget_chars
        {
            return Err(error(
                ErrorCode::BudgetExceeded,
                "History search budget is too small",
            ));
        }
        Ok(page)
    }
}

#[cfg(test)]
impl Database {
    pub(crate) fn test_insert_session_source(&self, session: &str, message: &str, text: &str) {
        use sha2::{Digest, Sha256};
        self.conn.execute("INSERT INTO agent_sessions(id,scope_key,title,runtime_id,state,session_path,checkpoint_json,created_at,updated_at) VALUES (?1,'workspace','secret','builtin-pi','active',?2,?3,'now','now')",params![session,format!(".project-mind/agent/sessions/{session}/session.jsonl"),r#"{"checksum":"sha256:a"}"#]).unwrap();
        let hash = format!("sha256:{:x}", Sha256::digest(text.as_bytes()));
        self.conn.execute("INSERT INTO agent_session_search_rows(message_id,session_id,runtime_entry_id,ordinal,role,created_at,run_id,text_hash,text,total_chars,complete) VALUES (?1,?2,'old-branch',0,'user','now',NULL,?3,?4,?5,1)",params![message,session,hash,text,text.chars().count() as i64]).unwrap();
    }
    pub(crate) fn test_exclude_session_source(&self, key: &str) {
        self.conn
            .execute(
                "INSERT INTO source_access_policies(object_key,excluded,revision) VALUES (?1,1,1)",
                [key],
            )
            .unwrap();
    }
}
