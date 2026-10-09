//! Connection-owned receipt listing, independent of Run and chat lifetimes.
use super::{agent_operations::io_error, agent_record_undo::read_entry, Database};
use crate::agent::{
    access::{Caller, RequestContext},
    connection_operations::ConnectionOperationListInput,
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, Scope, WorkspaceBinding},
    operations::{OperationEntry, OperationPage},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    caller_id: String,
    workspace_id: String,
    generation: String,
    scope: Scope,
    limit: u16,
    budget_chars: usize,
    after: i64,
    snapshot: i64,
}

fn invalid() -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, "Invalid connection operation page")
}

fn size(page: &OperationPage) -> AgentResult<usize> {
    serde_json::to_string(page)
        .map(|value| value.chars().count())
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot encode operation page"))
}

fn visible(db: &Database, request: &RequestContext, binding: &WorkspaceBinding, entry: &OperationEntry) -> AgentResult<bool> {
    if !matches!(entry.object.kind, ObjectKind::Record | ObjectKind::Todo | ObjectKind::File) {
        return Ok(false);
    }
    let visibility = if entry.object.kind == ObjectKind::Record {
        db.source_read_historical_record(request, binding, &entry.object)
    } else {
        db.source_read_object(request, binding, &entry.object)
    };
    match visibility {
        Ok(_) => Ok(true),
        Err(error) if matches!(error.code, ErrorCode::ScopeDenied | ErrorCode::NotFound | ErrorCode::ObjectWithdrawn) => Ok(false),
        Err(error) => Err(error),
    }
}

impl Database {
    pub(crate) fn agent_connection_operation_get(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        id: &str,
    ) -> AgentResult<OperationEntry> {
        if !matches!(request.caller, Caller::Connection { .. }) {
            return Err(AgentError::new(ErrorCode::ScopeDenied, "Only a connection may read its operations"));
        }
        let entry = self.agent_operation_access(request, binding, id, "operation.read")?;
        if !visible(self, request, binding, &entry)? {
            return Err(AgentError::new(ErrorCode::ScopeDenied, "Operation source is unavailable"));
        }
        Ok(entry)
    }

    pub(crate) fn agent_connection_operation_for_request(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
    ) -> AgentResult<OperationEntry> {
        if !matches!(request.caller, Caller::Connection { .. }) {
            return Err(AgentError::new(ErrorCode::ScopeDenied, "Only a connection may read its operations"));
        }
        self.operation_binding(binding)?;
        let id: Option<String> = self.conn.query_row(
            "SELECT operation_id FROM agent_operation_receipts WHERE caller_id=?1 AND request_id=?2 AND state='committed' AND operation_id IS NOT NULL",
            params![request.caller.key(), request.request_id],
            |row| row.get(0),
        ).optional().map_err(io_error)?;
        let id = id.ok_or_else(|| AgentError::new(ErrorCode::IoFailed, "Committed connection operation receipt is missing"))?;
        self.agent_operation_access(request, binding, &id, "operation.read")
    }

    pub(crate) fn agent_connection_operation_list(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &ConnectionOperationListInput,
    ) -> AgentResult<OperationPage> {
        self.operation_binding(binding)?;
        let Caller::Connection { .. } = &request.caller else {
            return Err(AgentError::new(ErrorCode::ScopeDenied, "Only a connection may list its operations"));
        };
        request.authorize(binding, &input.scope, "operation.read")?;
        let budget = input.budget_chars.unwrap_or(4000);
        if !(1..=50).contains(&input.limit) || !(1..=12000).contains(&budget) {
            return Err(invalid());
        }
        let caller_id = request.caller.key();
        let snapshot: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(rowid),0) FROM agent_operation_receipts WHERE caller_id=?1 AND operation_id IS NOT NULL AND state='committed'",
            [&caller_id], |row| row.get(0),
        ).map_err(io_error)?;
        let mut cursor = if let Some(raw) = &input.cursor {
            if raw.len() > 2048 { return Err(invalid()); }
            let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| invalid())?;
            let value: Cursor = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
            if value.caller_id != caller_id || value.workspace_id != binding.workspace_id
                || value.generation != binding.generation || value.scope != input.scope
                || value.limit != input.limit || value.budget_chars != budget
                || value.after < 0 || value.after > value.snapshot || value.snapshot > snapshot {
                return Err(invalid());
            }
            value
        } else {
            Cursor {
                caller_id: caller_id.clone(), workspace_id: binding.workspace_id.clone(),
                generation: binding.generation.clone(), scope: input.scope.clone(),
                limit: input.limit, budget_chars: budget, after: 0, snapshot,
            }
        };
        let mut statement = self.conn.prepare(
            "SELECT rowid,operation_id FROM agent_operation_receipts WHERE caller_id=?1 AND operation_id IS NOT NULL AND state='committed' AND rowid>?2 AND rowid<=?3 ORDER BY rowid"
        ).map_err(io_error)?;
        let mut rows = statement.query(params![caller_id, cursor.after, cursor.snapshot]).map_err(io_error)?;
        let mut page = OperationPage { operations: Vec::new(), next_cursor: None };
        let mut included_rows = Vec::new();
        let mut more = false;
        while let Some(row) = rows.next().map_err(io_error)? {
            let rowid: i64 = row.get(0).map_err(io_error)?;
            let id: String = row.get(1).map_err(io_error)?;
            let (entry, stored_caller) = read_entry(&self.conn, &id)?;
            if stored_caller != caller_id || entry.object.workspace_id != binding.workspace_id
                || entry.object.scope != input.scope { continue; }
            let entry = self.agent_operation_access(request, binding, &id, "operation.read")?;
            if !visible(self, request, binding, &entry)? { continue; }
            if page.operations.len() == usize::from(input.limit) {
                more = true;
                break;
            }
            page.operations.push(entry);
            if size(&page)? > budget {
                page.operations.pop();
                if page.operations.is_empty() {
                    return Err(AgentError::new(ErrorCode::BudgetExceeded, "Operation entry exceeds page budget"));
                }
                more = true;
                break;
            }
            included_rows.push(rowid);
        }
        if more {
            loop {
                cursor.after = *included_rows.last().ok_or_else(|| AgentError::new(
                    ErrorCode::BudgetExceeded, "Operation entry and cursor exceed page budget"
                ))?;
                page.next_cursor = Some(URL_SAFE_NO_PAD.encode(
                    serde_json::to_vec(&cursor).map_err(|_| invalid())?
                ));
                if size(&page)? <= budget { break; }
                page.operations.pop();
                included_rows.pop();
            }
        }
        if size(&page)? > budget {
            return Err(AgentError::new(ErrorCode::BudgetExceeded, "Operation page exceeds budget"));
        }
        Ok(page)
    }
}

#[cfg(test)]
#[path = "agent_connection_operations_tests.rs"]
mod tests;
