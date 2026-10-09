//! Modification undo uses the existing native Record commit and atomic receipt.
use super::{agent_operations::io_error, Database};
use crate::{
    agent::{
        access::{Caller, RequestContext},
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef, WorkspaceBinding},
        operation_batches::{OperationBatchConflictReason, OperationBatchUndoState, OperationUndoBatchInput, OperationUndoGroup},
        operations::*,
    },
    record_documents::{
        RecordDocumentCommit, RecordDocumentProjection, RecordTarget, RecordVersionOrigin,
    },
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn conflict() -> AgentError {
    AgentError::new(
        ErrorCode::UndoConflict,
        "Record changed after this operation; its later work will be retained",
    )
}
fn decode<T: serde::de::DeserializeOwned>(raw: &str) -> AgentResult<T> {
    serde_json::from_str(raw)
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Operation receipt is damaged"))
}
fn id_check(id: &str) -> AgentResult<()> {
    if id.len() != 32
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid("Invalid operation identity"));
    }
    Ok(())
}
fn encode(value: &impl Serialize) -> AgentResult<String> {
    serde_json::to_string(value).map_err(|_| invalid("Invalid operation payload"))
}
fn random_id() -> String {
    let mut bytes = [0; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub(super) fn read_entry(conn: &Connection, id: &str) -> AgentResult<(OperationEntry, String)> {
    id_check(id)?;
    let r = conn.query_row("SELECT operation_id,run_id,request_id,operation,target_ref_json,before_revision,after_revision,before_snapshot_ref,after_snapshot_ref,undo_state,undo_operation_id,created_at,caller_id FROM agent_operation_receipts WHERE operation_id=?1 AND state='committed'", [id], |r| Ok((
        r.get::<_,String>(0)?, r.get::<_,Option<String>>(1)?, r.get::<_,String>(2)?, r.get::<_,String>(3)?,
        r.get::<_,String>(4)?, r.get::<_,Option<i64>>(5)?, r.get::<_,Option<i64>>(6)?,
        r.get::<_,Option<String>>(7)?, r.get::<_,Option<String>>(8)?, r.get::<_,String>(9)?,
        r.get::<_,Option<String>>(10)?, r.get::<_,String>(11)?, r.get::<_,String>(12)?
    ))).optional().map_err(io_error)?.ok_or_else(||AgentError::new(ErrorCode::NotFound,"Operation receipt not found"))?;
    let object: ObjectRef = decode(&r.4)?;
    let recovery = if matches!(
        r.3.as_str(),
        "record.create" | "todo.create" | "file.create"
    ) {
        let state:Option<(bool,i64)> = conn.query_row("SELECT withdrawn_at IS NOT NULL,revision FROM agent_object_withdrawals WHERE object_key=?1 AND creation_operation_id=?2",params![object.key()?,id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(io_error)?;
        Some(OperationRecovery {
            withdrawn: state.as_ref().is_some_and(|s| s.0),
            withdrawal_revision: state.as_ref().map(|s| s.1 as u64),
            restore_available: state.is_some_and(|s| s.0),
        })
    } else {
        None
    };
    let revision = |value: Option<i64>| {
        value
            .map(|v| {
                u64::try_from(v).map_err(|_| {
                    AgentError::new(ErrorCode::IoFailed, "Invalid stored operation revision")
                })
            })
            .transpose()
    };
    Ok((
        OperationEntry {
            operation_id: r.0,
            run_id: r.1,
            request_id: r.2,
            kind: r.3,
            object,
            before_revision: revision(r.5)?,
            after_revision: revision(r.6)?,
            before_snapshot_ref: r.7,
            after_snapshot_ref: r.8,
            undo_state: r.9,
            undo_operation_id: r.10,
            created_at: r.11,
            recovery,
        },
        r.12,
    ))
}
pub(super) fn authorize(
    request: &RequestContext,
    binding: &WorkspaceBinding,
    entry: &OperationEntry,
    caller: &str,
    permission: &str,
) -> AgentResult<()> {
    if entry.object.workspace_id != binding.workspace_id {
        return Err(AgentError::new(
            ErrorCode::ScopeDenied,
            "Operation belongs to another Workspace",
        ));
    }
    request.authorize(binding, &entry.object.scope, permission)?;
    match &request.caller {
        Caller::Gui => Ok(()),
        Caller::BuiltinRun { run_id } if entry.run_id.as_deref() == Some(run_id) => Ok(()),
        Caller::Connection { .. }
            if entry.run_id.is_none() && request.caller.key() == caller => Ok(()),
        _ => Err(AgentError::new(
            ErrorCode::ScopeDenied,
            "Only the owning caller or local interface can access this operation",
        )),
    }
}
fn record_undo_group(
    conn: &Connection,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    input: &OperationUndoBatchInput,
) -> AgentResult<OperationUndoGroup> {
    let mut planned = super::agent_operation_batches::plan(conn, request, binding, input)?;
    if planned.groups.len() != 1 || !planned.excluded_no_change.is_empty() {
        return Err(invalid(
            "Record group undo requires exactly one modified Record chain",
        ));
    }
    let group = planned.groups.remove(0);
    if group.object.kind != ObjectKind::Record
        || group
            .operations
            .iter()
            .any(|entry| entry.kind != "record.patch")
    {
        return Err(AgentError::new(
            ErrorCode::ToolCallUnsupported,
            "Record group undo supports modifications only",
        ));
    }
    match group.undo_state {
        OperationBatchUndoState::Available => {
            if let Some(conflict) = group.conflicts.first() {
                return Err(conflict.error.clone());
            }
        }
        OperationBatchUndoState::Undone => {
            let id = group
                .first()
                .undo_operation_id
                .as_ref()
                .ok_or_else(conflict)?;
            if group
                .operations
                .iter()
                .any(|entry| entry.undo_operation_id.as_ref() != Some(id))
            {
                return Err(conflict());
            }
            // Successful undo remains replayable after subsequent native work.
            if let Some(conflict) = group.conflicts.iter().find(|conflict| {
                conflict.reason != OperationBatchConflictReason::MissingLaterOperation
            }) {
                return Err(conflict.error.clone());
            }
        }
        _ => return Err(conflict()),
    }
    Ok(group)
}
fn record_group_previous(
    conn: &Connection,
    group: &OperationUndoGroup,
) -> AgentResult<Option<RecordUndoResult>> {
    if group.undo_state != OperationBatchUndoState::Undone {
        return Ok(None);
    }
    let id = group
        .first()
        .undo_operation_id
        .as_deref()
        .ok_or_else(conflict)?;
    let raw: String = conn.query_row("SELECT result_json FROM agent_operation_receipts WHERE operation_id=?1 AND operation='record.undo' AND state='committed'", [id], |row| row.get(0)).map_err(io_error)?;
    let result: RecordUndoResult = decode(&raw)?;
    let (original, _) = read_entry(conn, &result.original_operation_id)?;
    if result.operation_id != id
        || result.object != group.object
        || original.object != group.object
        || original.run_id != group.first().run_id
        || original.undo_state != "undone"
        || original.undo_operation_id.as_deref() != Some(id)
    {
        return Err(conflict());
    }
    Ok(Some(result))
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    run_id: String,
    limit: u16,
    after: i64,
    snapshot: i64,
}

impl Database {
    pub(super) fn operation_binding(&self, binding: &WorkspaceBinding) -> AgentResult<()> {
        if self
            .native_workspace_id
            .as_ref()
            .is_some_and(|id| id != &binding.workspace_id)
        {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Operation Workspace is no longer current",
            ));
        }
        Ok(())
    }
    /// Trusted GUI adapters use stored scopes to construct their grant; the
    /// resulting request still goes through the normal authorization methods.
    pub(crate) fn agent_operation_scope(
        &self,
        binding: &WorkspaceBinding,
        id: &str,
    ) -> AgentResult<crate::agent::models::Scope> {
        self.operation_binding(binding)?;
        let (entry, _) = read_entry(&self.conn, id)?;
        if entry.object.workspace_id != binding.workspace_id {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Operation belongs to another Workspace",
            ));
        }
        Ok(entry.object.scope)
    }
    pub(crate) fn agent_operation_run_scopes(
        &self,
        binding: &WorkspaceBinding,
        run_id: &str,
    ) -> AgentResult<Vec<crate::agent::models::Scope>> {
        self.operation_binding(binding)?;
        id_check(run_id)?;
        let mut stmt = self.conn.prepare("SELECT operation_id FROM agent_operation_receipts WHERE run_id=?1 AND operation_id IS NOT NULL AND state='committed'").map_err(io_error)?;
        let ids = stmt
            .query_map([run_id], |r| r.get::<_, String>(0))
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error)?;
        let mut scopes = Vec::new();
        for id in ids {
            let scope = self.agent_operation_scope(binding, &id)?;
            if !scopes.contains(&scope) {
                scopes.push(scope);
            }
        }
        if scopes.is_empty() {
            let key:String = self.conn.query_row("SELECT s.scope_key FROM agent_runs r JOIN agent_sessions s ON s.id=r.session_id WHERE r.id=?1", [run_id], |r| r.get(0)).optional().map_err(io_error)?.ok_or_else(||AgentError::new(ErrorCode::NotFound,"Operation Run not found"))?;
            scopes.push(super::agent_operations::parse_scope_key(&key)?);
        }
        Ok(scopes)
    }
    pub(crate) fn agent_operation_get(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        id: &str,
    ) -> AgentResult<OperationEntry> {
        self.agent_operation_access(request, binding, id, "operation.read")
    }
    pub(crate) fn agent_operation_access(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        id: &str,
        permission: &str,
    ) -> AgentResult<OperationEntry> {
        self.operation_binding(binding)?;
        let (entry, caller) = read_entry(&self.conn, id)?;
        if entry.object.workspace_id != binding.workspace_id {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Operation belongs to another Workspace",
            ));
        }
        if permission == "operation.read"
            && matches!(&request.caller, Caller::BuiltinRun { run_id } if entry.run_id.as_deref()!=Some(run_id.as_str()))
        {
            let run = entry.run_id.as_deref().ok_or_else(|| {
                AgentError::new(ErrorCode::ScopeDenied, "Operation has no owning Run")
            })?;
            super::agent_outputs::authorize_session_run_read(
                self,
                request,
                binding,
                run,
                &entry.object.scope,
                permission,
            )?;
        } else {
            authorize(request, binding, &entry, &caller, permission)?;
        }
        Ok(entry)
    }
    pub(crate) fn agent_operation_list(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &OperationListInput,
    ) -> AgentResult<OperationPage> {
        self.operation_binding(binding)?;
        id_check(&input.run_id)?;
        if input.limit == 0 || input.limit > 50 {
            return Err(invalid("Operation page limit must be 1 to 50"));
        }
        if request.binding != *binding {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Workspace binding is no longer current",
            ));
        }
        if let Caller::BuiltinRun { run_id } = &request.caller {
            if run_id != &input.run_id {
                let scope = self
                    .agent_output_run_scope(&input.run_id)
                    .map_err(|error| {
                        if error.code == ErrorCode::NotFound {
                            AgentError::new(
                                ErrorCode::ScopeDenied,
                                "Operation Run is outside this caller",
                            )
                        } else {
                            error
                        }
                    })?;
                super::agent_outputs::authorize_session_run_read(
                    self,
                    request,
                    binding,
                    &input.run_id,
                    &scope,
                    "operation.read",
                )?;
            }
        }
        if matches!(request.caller, Caller::Connection { .. }) {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Operation Run is outside this caller",
            ));
        }
        // No session join: committed receipts remain accessible after chat deletion.
        let max:i64=self.conn.query_row("SELECT COALESCE(MAX(rowid),0) FROM agent_operation_receipts WHERE run_id=?1 AND operation_id IS NOT NULL",[&input.run_id],|r|r.get(0)).map_err(io_error)?;
        let cursor = if let Some(raw) = &input.cursor {
            if raw.len() > 1024 {
                return Err(invalid("Invalid operation cursor"));
            }
            let c: Cursor = decode(
                &String::from_utf8(
                    URL_SAFE_NO_PAD
                        .decode(raw)
                        .map_err(|_| invalid("Invalid operation cursor"))?,
                )
                .map_err(|_| invalid("Invalid operation cursor"))?,
            )
            .map_err(|_| invalid("Invalid operation cursor"))?;
            if c.run_id != input.run_id
                || c.limit != input.limit
                || c.after < 0
                || c.after > c.snapshot
                || c.snapshot > max
            {
                return Err(invalid("Operation cursor does not match its query"));
            }
            c
        } else {
            Cursor {
                run_id: input.run_id.clone(),
                limit: input.limit,
                after: 0,
                snapshot: max,
            }
        };
        let mut stmt=self.conn.prepare("SELECT rowid,operation_id FROM agent_operation_receipts WHERE run_id=?1 AND operation_id IS NOT NULL AND state='committed' AND rowid>?2 AND rowid<=?3 ORDER BY rowid LIMIT ?4").map_err(io_error)?;
        let rows = stmt
            .query_map(
                params![
                    input.run_id,
                    cursor.after,
                    cursor.snapshot,
                    input.limit as i64 + 1
                ],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
            )
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error)?;
        let mut operations = vec![];
        for (_, id) in rows.iter().take(input.limit as usize) {
            operations.push(self.agent_operation_get(request, binding, id)?);
        }
        // Authorize even an empty page against a persisted receipt, or the
        // actual run scope if it has not committed any business operation.
        let first:Option<String>=self.conn.query_row("SELECT operation_id FROM agent_operation_receipts WHERE run_id=?1 AND operation_id IS NOT NULL AND state='committed' ORDER BY rowid LIMIT 1",[&input.run_id],|r|r.get(0)).optional().map_err(io_error)?;
        if let Some(id) = first {
            self.agent_operation_get(request, binding, &id)?;
        } else {
            let key:String=self.conn.query_row("SELECT s.scope_key FROM agent_runs r JOIN agent_sessions s ON s.id=r.session_id WHERE r.id=?1",[&input.run_id],|r|r.get(0)).optional().map_err(io_error)?.ok_or_else(||AgentError::new(ErrorCode::NotFound,"Operation Run not found"))?;
            request.authorize(
                binding,
                &super::agent_operations::parse_scope_key(&key)?,
                "operation.read",
            )?;
        }
        let next_cursor = if rows.len() > input.limit as usize {
            Some(URL_SAFE_NO_PAD.encode(encode(&Cursor {
                after: rows[input.limit as usize - 1].0,
                ..cursor
            })?))
        } else {
            None
        };
        Ok(OperationPage {
            operations,
            next_cursor,
        })
    }
    pub(crate) fn agent_record_undo_prepare(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &OperationUndoInput,
    ) -> AgentResult<OperationEntry> {
        let entry =
            self.agent_operation_access(request, binding, &input.operation_id, "operation.undo")?;
        if input.expected_head_revision == 0
            || entry.after_revision != Some(input.expected_head_revision)
        {
            return Err(conflict());
        }
        if !matches!(entry.kind.as_str(), "record.patch" | "record.version.restore")
            || entry.object.kind != ObjectKind::Record
            || !matches!(entry.undo_state.as_str(), "available" | "undone")
        {
            return Err(AgentError::new(
                ErrorCode::UndoConflict,
                "This operation has no recoverable Record modification",
            ));
        }
        if entry.before_snapshot_ref.is_none() {
            return Err(conflict());
        }
        Ok(entry)
    }
    pub(crate) fn agent_record_undo_previous(
        &self,
        entry: &OperationEntry,
    ) -> AgentResult<Option<RecordUndoResult>> {
        if let Some(id) = &entry.undo_operation_id {
            let raw:String=self.conn.query_row("SELECT result_json FROM agent_operation_receipts WHERE operation_id=?1 AND operation='record.undo' AND state='committed'",[id],|r|r.get(0)).map_err(io_error)?;
            return decode(&raw).map(Some);
        }
        Ok(None)
    }
    pub(crate) fn agent_record_undo_commit(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &OperationUndoInput,
        projection: &RecordDocumentProjection,
    ) -> AgentResult<RecordUndoResult> {
        let entry = self.agent_record_undo_prepare(request, binding, input)?;
        let target = RecordTarget {
            scope: entry.object.scope.clone(),
            record_id: entry.object.id.parse().map_err(|_| conflict())?,
        };
        let compatibility = self.record_compatibility_html(&target, projection)?;
        self.agent_atomic_operation(&request.caller.key(),&request.request_id,"record.undo",input,|tx|{
            let(entry,caller)=read_entry(tx,&input.operation_id)?;authorize(request,binding,&entry,&caller,"operation.undo")?;
            if let Some(id)=&entry.undo_operation_id{let raw:String=tx.query_row("SELECT result_json FROM agent_operation_receipts WHERE operation_id=?1 AND operation='record.undo' AND state='committed'",[id],|r|r.get(0)).map_err(io_error)?;return Ok((decode(&raw)?,None));}
            if entry.undo_state!="available"||entry.after_revision!=Some(input.expected_head_revision){return Err(conflict());}
            let context:String=tx.query_row("SELECT output_context_json FROM agent_operation_receipts WHERE operation_id=?1",[&input.operation_id],|r|r.get(0)).map_err(io_error)?;let context:Value=decode(&context)?;
            let current=super::record_documents::head_unchecked(tx,&target)?.ok_or_else(conflict)?;
            let metadata=super::record_documents::metadata(tx,&target)?;
            if current.head_revision!=input.expected_head_revision||context["afterBodyHash"].as_str()!=Some(current.projection.body_hash.as_str())||context["afterMetadata"]!=serde_json::to_value(&metadata).map_err(|_|conflict())?||current.edit_session_id.is_some(){return Err(conflict());}
            let before=entry.before_snapshot_ref.as_deref().ok_or_else(conflict)?;
            let historic=self.record_version_get(&target,before)?;
            if historic.projection.body_hash!=projection.body_hash||historic.head_revision!=entry.before_revision.ok_or_else(conflict)?{return Err(conflict());}
            let operation_id = random_id();
            let(saved,change)=Self::record_commit_transaction(tx,&operation_id,&RecordDocumentCommit{target:target.clone(),base_revision:input.expected_head_revision,projection:projection.clone(),origin:RecordVersionOrigin::Restore,actor:json!({"kind":"operation_undo","caller":request.caller.key(),"operationId":input.operation_id}),edit_session_id:None},&compatibility,Some(before),&binding.workspace_id)?;
            let after_version=saved.after_version.ok_or_else(conflict)?;
            let result=RecordUndoResult{operation_id,original_operation_id:input.operation_id.clone(),object:entry.object,head:saved.head,before_version:saved.before_version,after_version};Ok((result,change))
        })
    }
    pub(crate) fn agent_record_undo_group_prepare(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &OperationUndoBatchInput,
    ) -> AgentResult<OperationUndoGroup> {
        self.operation_binding(binding)?;
        record_undo_group(&self.conn, request, binding, input)
    }
    pub(crate) fn agent_record_undo_group_previous(
        &self,
        group: &OperationUndoGroup,
    ) -> AgentResult<Option<RecordUndoResult>> {
        record_group_previous(&self.conn, group)
    }
    pub(crate) fn agent_record_undo_group_commit(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &OperationUndoBatchInput,
        projection: &RecordDocumentProjection,
    ) -> AgentResult<RecordUndoResult> {
        let group = self.agent_record_undo_group_prepare(request, binding, input)?;
        if let Some(previous) = self.agent_record_undo_group_previous(&group)? {
            return Ok(previous);
        }
        let target = RecordTarget {
            scope: group.object.scope.clone(),
            record_id: group.object.id.parse().map_err(|_| conflict())?,
        };
        let compatibility = self.record_compatibility_html(&target, projection)?;
        self.agent_atomic_operation(&request.caller.key(), &request.request_id, "record.undo", input, |tx| {
            let group = record_undo_group(tx, request, binding, input)?;
            if let Some(previous) = record_group_previous(tx, &group)? { return Ok((previous, None)); }
            let first = group.first();
            let tail = group.last();
            let expected = tail.after_revision.ok_or_else(conflict)?;
            let raw: String = tx.query_row("SELECT output_context_json FROM agent_operation_receipts WHERE operation_id=?1", [&tail.operation_id], |row| row.get(0)).map_err(io_error)?;
            let context: Value = decode(&raw)?;
            let current = super::record_documents::head_unchecked(tx, &target)?.ok_or_else(conflict)?;
            let metadata = super::record_documents::metadata(tx, &target)?;
            if current.head_revision != expected || current.edit_session_id.is_some()
                || context["afterBodyHash"].as_str() != Some(current.projection.body_hash.as_str())
                || context["afterMetadata"] != serde_json::to_value(metadata).map_err(|_| conflict())? { return Err(conflict()); }
            let before = first.before_snapshot_ref.as_deref().ok_or_else(conflict)?;
            let historic = self.record_version_get(&target, before)?;
            if historic.head_revision != first.before_revision.ok_or_else(conflict)? || historic.projection.body_hash != projection.body_hash { return Err(conflict()); }
            // Record checkpoints can have distinct IDs for an identical revision.
            let mut previous_hash = None;
            for entry in &group.operations {
                let before = self.record_version_get(&target, entry.before_snapshot_ref.as_deref().ok_or_else(conflict)?)?;
                let after = self.record_version_get(&target, entry.after_snapshot_ref.as_deref().ok_or_else(conflict)?)?;
                if Some(before.head_revision) != entry.before_revision || Some(after.head_revision) != entry.after_revision
                    || previous_hash.as_ref().is_some_and(|hash| hash != &before.projection.body_hash) { return Err(conflict()); }
                previous_hash = Some(after.projection.body_hash);
            }
            if previous_hash.as_deref() != Some(current.projection.body_hash.as_str()) { return Err(conflict()); }
            let operation_id = random_id();
            let (saved, change) = Self::record_commit_transaction(tx, &operation_id, &RecordDocumentCommit {
                target: target.clone(), base_revision: expected, projection: projection.clone(), origin: RecordVersionOrigin::Restore,
                actor: json!({"kind":"operation_undo","caller":request.caller.key(),"operationIds":input.operation_ids}), edit_session_id: None,
            }, &compatibility, Some(before), &binding.workspace_id)?;
            let after_version = if let Some(after) = saved.after_version { after } else {
                let retained = self.record_version_get(&target, &saved.before_version)?;
                if retained.head_revision != saved.head.head_revision || retained.projection.body_hash != saved.head.body_hash { return Err(conflict()); }
                saved.before_version.clone()
            };
            // The ordinary record.undo receipt hook marks the first original.
            // Mark the remaining originals inside this same native transaction.
            for entry in group.operations.iter().skip(1) {
                let changed = tx.execute("UPDATE agent_operation_receipts SET undo_state='undone',undo_operation_id=?1 WHERE operation_id=?2 AND undo_state='available' AND undo_operation_id IS NULL", params![operation_id, entry.operation_id]).map_err(io_error)?;
                if changed != 1 { return Err(conflict()); }
            }
            Ok((RecordUndoResult { operation_id, original_operation_id: first.operation_id.clone(), object: group.object, head: saved.head, before_version: saved.before_version, after_version }, change))
        })
    }
}
/// Called by agent_atomic_operation after its ordinary receipt INSERT. The
/// restore and both ledger changes therefore share the native transaction.
pub(crate) fn agent_record_undo_receipt_committed(
    tx: &Transaction<'_>,
    caller: &str,
    request_id: &str,
    operation: &str,
    result_json: &str,
    workspace_id: Option<&str>,
) -> AgentResult<()> {
    if caller.starts_with("connection:")
        && matches!(operation, "record.create" | "record.patch" | "record.version.restore")
    {
        let workspace_id = workspace_id.ok_or_else(|| AgentError::new(
            ErrorCode::WorkspaceChanged,
            "Connection Record receipt has no bound Workspace",
        ))?;
        let (head, object, id, before_revision, before_snapshot, after_snapshot, undo) =
            match operation {
                "record.create" => {
                    let head: crate::record_documents::RecordCommittedHead = decode(result_json)?;
                    let object = ObjectRef {
                        workspace_id: workspace_id.into(),
                        scope: head.target.scope.clone(),
                        kind: ObjectKind::Record,
                        id: head.target.record_id.to_string(),
                    };
                    (head, object, random_id(), None, None, None, "available")
                }
                "record.patch" => {
                    let result: crate::record_documents::RecordPatchResult = decode(result_json)?;
                    if result.receipt.object.workspace_id != workspace_id
                        || result.receipt.request_id != request_id
                        || result.after_revision != result.head.head_revision
                    {
                        return Err(invalid("Connection Record receipt identity differs"));
                    }
                    let undo = if result.no_change { "unavailable" } else { "available" };
                    (result.head, result.receipt.object, result.receipt.operation_id,
                        Some(result.before_revision), Some(result.before_version),
                        result.after_version, undo)
                }
                _ => {
                    let result: crate::record_documents::RecordCommitResult = decode(result_json)?;
                    let object = ObjectRef {
                        workspace_id: workspace_id.into(),
                        scope: result.head.target.scope.clone(),
                        kind: ObjectKind::Record,
                        id: result.head.target.record_id.to_string(),
                    };
                    let before_revision = if result.no_change { result.head.head_revision } else {
                        result.head.head_revision.checked_sub(1).ok_or_else(conflict)?
                    };
                    let undo = if result.no_change { "unavailable" } else { "available" };
                    (result.head, object, random_id(), Some(before_revision),
                        Some(result.before_version), result.after_version, undo)
                }
            };
        if object.scope != head.target.scope || object.id != head.target.record_id.to_string() {
            return Err(invalid("Connection Record receipt target differs"));
        }
        let after_snapshot = match after_snapshot {
            Some(id) => id,
            None => tx.query_row(
                "SELECT id FROM record_versions WHERE record_key=?1 AND head_revision=?2 AND body_hash=?3 ORDER BY version_number DESC LIMIT 1",
                params![head.target.key()?, head.head_revision as i64, head.body_hash],
                |row| row.get::<_, String>(0),
            ).optional().map_err(io_error)?.ok_or_else(conflict)?,
        };
        let metadata = super::record_documents::metadata(tx, &head.target)?;
        let context = json!({"afterMetadata":metadata,"afterBodyHash":head.body_hash});
        let changed = tx.execute(
            "UPDATE agent_operation_receipts SET operation_id=?1,target_ref_json=?2,before_revision=?3,after_revision=?4,before_snapshot_ref=?5,after_snapshot_ref=?6,output_context_json=?7,undo_state=?8 WHERE caller_id=?9 AND request_id=?10 AND operation=?11 AND state='committed'",
            params![id,encode(&object)?,before_revision.map(|v|v as i64),head.head_revision as i64,before_snapshot,after_snapshot,encode(&context)?,undo,caller,request_id,operation],
        ).map_err(io_error)?;
        if changed != 1 {
            return Err(AgentError::new(ErrorCode::IoFailed, "Connection Record receipt is missing"));
        }
        return Ok(());
    }
    if operation != "record.undo" {
        return Ok(());
    }
    let result: RecordUndoResult = decode(result_json)?;
    // A second request for an already-undone operation can replay its result;
    // only its original undo receipt owns the public operation ID.
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_operation_receipts WHERE operation_id=?1)",
            [&result.operation_id],
            |r| r.get(0),
        )
        .map_err(io_error)?;
    if exists {
        return Ok(());
    }
    let changed=tx.execute("UPDATE agent_operation_receipts SET undo_state='undone',undo_operation_id=?1 WHERE operation_id=?2 AND undo_state='available' AND undo_operation_id IS NULL",params![result.operation_id,result.original_operation_id]).map_err(io_error)?;
    if changed != 1 {
        return Err(conflict());
    }
    tx.execute("UPDATE agent_operation_receipts SET operation_id=?1,run_id=(SELECT run_id FROM agent_operation_receipts WHERE operation_id=?2),target_ref_json=?3,before_revision=(SELECT MAX(after_revision) FROM agent_operation_receipts WHERE undo_operation_id=?1),after_revision=?4,before_snapshot_ref=?5,after_snapshot_ref=?6 WHERE caller_id=?7 AND request_id=?8 AND operation='record.undo'",params![result.operation_id,result.original_operation_id,encode(&result.object)?,result.head.head_revision as i64,result.before_version,result.after_version,caller,request_id]).map_err(io_error)?;
    Ok(())
}

#[cfg(test)]
#[path = "agent_record_undo_group_tests.rs"]
mod group_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            access::ScopeGrant,
            conversation::RunPreparation,
            models::Scope,
            output_runtime::StageRecordInput,
            outputs::{OutputIntent, RecordPatch},
        },
        record_documents::{body_hash, RecordCreate, RecordMetadataUpdate, RecordPatchMetadata},
    };
    pub(super) struct Fixture {
        _root: tempfile::TempDir,
        pub(super) db: Database,
        pub(super) request: RequestContext,
        pub(super) binding: WorkspaceBinding,
        pub(super) input: OperationUndoInput,
        pub(super) target: RecordTarget,
        pub(super) before: RecordDocumentProjection,
        session: String,
        pub(super) run: String,
    }
    pub(super) fn projection(extra: bool) -> RecordDocumentProjection {
        let mut content = vec![
            json!({"type":"paragraph","attrs":{"blockId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"content":[{"type":"text","text":"Before 保留"}]}),
        ];
        if extra {
            content.push(json!({"type":"paragraph","attrs":{"blockId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"content":[{"type":"text","text":"Added"}]}));
        }
        let document = json!({"type":"doc","content":content});
        RecordDocumentProjection {
            schema_version: 1,
            body_hash: body_hash(&document, &None),
            document,
            html: if extra {
                "<p data-block-id=\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\">Before 保留</p><p data-block-id=\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\">Added</p>".into()
            } else {
                "<p data-block-id=\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\">Before 保留</p>".into()
            },
            markdown: if extra {
                "Before 保留\n\nAdded".into()
            } else {
                "Before 保留".into()
            },
            text: if extra {
                "Before 保留\nAdded".into()
            } else {
                "Before 保留".into()
            },
            code_language: None,
        }
    }
    pub(super) fn fixture() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("undo.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("undo-workspace").unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "undo-workspace".into(),
            generation: "one".into(),
        };
        let mut request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "session".into(),
            scope_grant: ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: true,
                project_ids: vec![],
                operations: [
                    "session.read",
                    "session.write",
                    "run.start",
                    "run.cancel",
                    "output.stage",
                    "output.commit",
                    "content.create",
                    "record.patch",
                    "source.read",
                    "operation.read",
                    "operation.undo",
                ]
                .into_iter()
                .map(String::from)
                .collect(),
            },
        };
        let session = db
            .agent_session_create(&request, &binding, &Scope::Workspace, "Undo", "pi", None)
            .unwrap();
        let run = "1234567890abcdef1234567890abcdef".to_string();
        db.agent_run_prepare(
            &request,
            &binding,
            &session.id,
            "modify",
            &RunPreparation {
                run_id: run.clone(),
                context_manifest: json!({"scope":Scope::Workspace,"mode":"collaborate"}),
            },
        )
        .unwrap();
        db.agent_run_start(&request, &binding, &run).unwrap();
        let before = projection(false);
        let head = db
            .record_create(
                "gui",
                "create-original",
                &RecordCreate {
                    scope: Scope::Workspace,
                    title: Some("Original".into()),
                    tag_ids: vec![],
                    document: before.document.clone(),
                    code_language: None,
                },
                &before,
                &binding.workspace_id,
            )
            .unwrap();
        let object = ObjectRef {
            workspace_id: binding.workspace_id.clone(),
            scope: Scope::Workspace,
            kind: ObjectKind::Record,
            id: head.target.record_id.to_string(),
        };
        request.caller = Caller::BuiltinRun {
            run_id: run.clone(),
        };
        request.request_id = "stage".into();
        let operation:crate::agent::outputs::BlockEdit=serde_json::from_value(json!({"op":"append","parentBlockId":null,"blocks":[{"type":"paragraph","content":[{"type":"text","text":"Added"}]}]})).unwrap();
        let patch = RecordPatch {
            record: object,
            base_revision: head.head_revision,
            request_id: "candidate".into(),
            operations: vec![operation],
        };
        let staged = db
            .agent_output_stage_record(
                &request,
                &binding,
                &StageRecordInput {
                    intent: OutputIntent::RecordPatch { patch },
                    sources: vec![],
                },
            )
            .unwrap();
        let prepared = db
            .agent_output_commit_prepare(&request, &binding, &staged.staged.id, 1)
            .unwrap();
        let OutputIntent::RecordPatch { mut patch } = prepared.output.staged.intent else {
            panic!("patch intent")
        };
        patch.request_id = prepared.commit_request_id;
        let saved = db
            .record_patch_commit(
                &request.caller.key(),
                &patch,
                &projection(true),
                &RecordPatchMetadata {
                    created_block_ids: vec!["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into()],
                    deleted_block_ids: vec![],
                    normalizations: vec![],
                    no_change: false,
                },
                &binding.workspace_id,
            )
            .unwrap();
        let input = OperationUndoInput {
            operation_id: saved.receipt.operation_id,
            expected_head_revision: saved.after_revision,
        };
        request.caller = Caller::Gui;
        request.request_id = "undo-one".into();
        Fixture {
            _root: root,
            db,
            request,
            binding,
            input,
            target: head.target,
            before,
            session: session.id,
            run,
        }
    }
    pub(super) fn versions(f: &Fixture) -> i64 {
        f.db.conn
            .query_row(
                "SELECT COUNT(*) FROM record_versions WHERE record_key=?1",
                [f.target.key().unwrap()],
                |r| r.get(0),
            )
            .unwrap()
    }
    #[test]
    fn record_undo_creates_native_version_and_retries_keep_original_receipt() {
        let mut f = fixture();
        let count = versions(&f);
        let result =
            f.db.agent_record_undo_commit(&f.request, &f.binding, &f.input, &f.before)
                .unwrap();
        assert_eq!(
            result.head.head_revision,
            f.input.expected_head_revision + 1
        );
        assert_eq!(result.head.body_hash, f.before.body_hash);
        assert!(versions(&f) > count);
        let after = versions(&f);
        assert_eq!(
            f.db.agent_record_undo_commit(&f.request, &f.binding, &f.input, &f.before)
                .unwrap()
                .operation_id,
            result.operation_id
        );
        f.request.request_id = "undo-again".into();
        assert_eq!(
            f.db.agent_record_undo_commit(&f.request, &f.binding, &f.input, &f.before)
                .unwrap()
                .operation_id,
            result.operation_id
        );
        assert_eq!(versions(&f), after);
        let original =
            f.db.agent_operation_get(&f.request, &f.binding, &f.input.operation_id)
                .unwrap();
        assert_eq!(original.undo_state, "undone");
        assert_eq!(
            original.undo_operation_id,
            Some(result.operation_id.clone())
        );
        let undo =
            f.db.agent_operation_get(&f.request, &f.binding, &result.operation_id)
                .unwrap();
        assert_eq!(undo.run_id, Some(f.run));
        assert_eq!(undo.after_revision, Some(result.head.head_revision));
        assert_eq!(undo.before_revision, Some(f.input.expected_head_revision));
        assert_eq!(
            f.db.record_version_get(&f.target, &result.after_version)
                .unwrap()
                .operation_id,
            result.operation_id
        );
    }
    #[test]
    fn record_undo_conflicts_on_later_head_or_metadata_without_new_receipt() {
        for body in [false, true] {
            let f = fixture();
            let count = versions(&f);
            if body {
                f.db.conn.execute("UPDATE record_document_heads SET head_revision=head_revision+1 WHERE record_key=?1",[f.target.key().unwrap()]).unwrap();
            } else {
                let metadata = f.db.record_metadata_get(&f.target).unwrap();
                f.db.record_metadata_update(
                    "gui",
                    "manual-title",
                    &RecordMetadataUpdate {
                        target: f.target.clone(),
                        expected_revision: metadata.revision,
                        title: Some("Later title".into()),
                        tag_ids: vec![],
                    },
                    &f.binding.workspace_id,
                )
                .unwrap();
            }
            assert_eq!(
                f.db.agent_record_undo_commit(&f.request, &f.binding, &f.input, &f.before)
                    .unwrap_err()
                    .code,
                ErrorCode::UndoConflict
            );
            assert_eq!(versions(&f), count);
            assert_eq!(
                f.db.agent_operation_get(&f.request, &f.binding, &f.input.operation_id)
                    .unwrap()
                    .undo_state,
                "available"
            );
            let exists:bool=f.db.conn.query_row("SELECT EXISTS(SELECT 1 FROM agent_operation_receipts WHERE caller_id='gui' AND request_id='undo-one')",[],|r|r.get(0)).unwrap();
            assert!(!exists);
        }
    }
    #[test]
    fn record_undo_is_atomic_when_receipt_hook_fails() {
        let f = fixture();
        let count = versions(&f);
        f.db.conn.execute_batch("CREATE TRIGGER block_undo BEFORE UPDATE OF undo_state ON agent_operation_receipts WHEN NEW.undo_state='undone' BEGIN SELECT RAISE(ABORT,'receipt failure'); END").unwrap();
        assert!(f
            .db
            .agent_record_undo_commit(&f.request, &f.binding, &f.input, &f.before)
            .is_err());
        assert_eq!(versions(&f), count);
        assert_eq!(
            f.db.record_document_head(&f.target)
                .unwrap()
                .unwrap()
                .head_revision,
            f.input.expected_head_revision
        );
        assert_eq!(
            f.db.agent_operation_get(&f.request, &f.binding, &f.input.operation_id)
                .unwrap()
                .undo_state,
            "available"
        );
    }
    #[test]
    fn operation_history_survives_session_delete_and_rejects_foreign_callers() {
        let mut f = fixture();
        f.db.conn
            .execute(
                "UPDATE agent_runs SET state='interrupted' WHERE id=?1",
                [&f.run],
            )
            .unwrap();
        assert!(f
            .db
            .agent_session_delete(&f.request, &f.binding, &f.session)
            .unwrap());
        let page =
            f.db.agent_operation_list(
                &f.request,
                &f.binding,
                &OperationListInput {
                    run_id: f.run.clone(),
                    cursor: None,
                    limit: 1,
                },
            )
            .unwrap();
        assert_eq!(page.operations.len(), 1);
        assert_eq!(page.operations[0].operation_id, f.input.operation_id);
        assert_eq!(
            f.db.agent_operation_run_scopes(&f.binding, &f.run).unwrap(),
            vec![Scope::Workspace]
        );
        let result =
            f.db.agent_record_undo_commit(&f.request, &f.binding, &f.input, &f.before)
                .unwrap();
        assert_eq!(result.head.body_hash, f.before.body_hash);
        f.request.caller = Caller::BuiltinRun {
            run_id: f.run.clone(),
        };
        assert!(f
            .db
            .agent_operation_get(&f.request, &f.binding, &f.input.operation_id)
            .is_ok());
        assert!(f
            .db
            .agent_operation_get(&f.request, &f.binding, &result.operation_id)
            .is_ok());
        f.request.caller = Caller::BuiltinRun {
            run_id: "ffffffffffffffffffffffffffffffff".into(),
        };
        assert_eq!(
            f.db.agent_operation_get(&f.request, &f.binding, &f.input.operation_id)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        f.request.caller = Caller::Connection {
            grant_id: "connection".into(),
        };
        assert_eq!(
            f.db.agent_operation_get(&f.request, &f.binding, &f.input.operation_id)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
    }
    #[test]
    fn operation_pages_are_bounded_and_cursor_tied_to_run_and_limit() {
        let f = fixture();
        f.db.agent_record_undo_commit(&f.request, &f.binding, &f.input, &f.before)
            .unwrap();
        let mut input = OperationListInput {
            run_id: f.run.clone(),
            cursor: None,
            limit: 1,
        };
        let page =
            f.db.agent_operation_list(&f.request, &f.binding, &input)
                .unwrap();
        assert!(page.next_cursor.is_some());
        input.cursor = page.next_cursor;
        let second =
            f.db.agent_operation_list(&f.request, &f.binding, &input)
                .unwrap();
        assert_eq!(second.operations.len(), 1);
        assert_ne!(
            page.operations[0].operation_id,
            second.operations[0].operation_id
        );
        input.limit = 2;
        assert_eq!(
            f.db.agent_operation_list(&f.request, &f.binding, &input)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        input.cursor = None;
        input.limit = 51;
        assert_eq!(
            f.db.agent_operation_list(&f.request, &f.binding, &input)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
    }
}
