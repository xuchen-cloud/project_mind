//! Recoverable visibility changes for Records created by committed Agent outputs.
//! Native contents, immutable versions, assets and reference edges remain intact.
use super::{
    agent_operations::{io_error, OperationChange},
    Database,
};
use crate::{
    agent::{
        access::{Caller, RequestContext},
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
        operation_batches::{OperationBatchUndoState, OperationUndoGroup},
    },
    record_documents::{RecordCommittedHead, RecordTarget},
};
use chrono::Utc;
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Applied only by the formal schema migration, in its existing savepoint.
pub(super) const AGENT_RECORD_WITHDRAWALS_SQL: &str = r#"
CREATE TABLE agent_object_withdrawals (
 object_key TEXT PRIMARY KEY,
 creation_operation_id TEXT NOT NULL,
 withdrawn_at TEXT,
 restore_operation_id TEXT,
 revision INTEGER NOT NULL CHECK(revision>0)
);
CREATE VIEW agent_visible_notes AS
 SELECT n.* FROM notes n WHERE NOT EXISTS (
  SELECT 1 FROM agent_object_withdrawals w WHERE w.withdrawn_at IS NOT NULL
   AND w.object_key GLOB '*/project:'||n.project_id||'/record/'||n.id
 );
CREATE VIEW agent_visible_workspace_notes AS
 SELECT n.* FROM workspace_notes n WHERE n.note_kind!='workspace_note' OR NOT EXISTS (
  SELECT 1 FROM agent_object_withdrawals w WHERE w.withdrawn_at IS NOT NULL
   AND w.object_key GLOB '*/workspace/record/'||n.id
 );
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordWithdrawalInput {
    pub creation_operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordRestoreInput {
    pub creation_operation_id: String,
    pub expected_withdrawal_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordWithdrawalResult {
    pub operation_id: String,
    pub creation_operation_id: String,
    pub object: ObjectRef,
    pub withdrawn: bool,
    pub revision: u64,
}

fn conflict(message: &str) -> AgentError {
    AgentError::new(ErrorCode::UndoConflict, message)
}
fn random_id() -> String {
    let mut value = [0; 16];
    OsRng.fill_bytes(&mut value);
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn decode<T: serde::de::DeserializeOwned>(text: &str) -> AgentResult<T> {
    serde_json::from_str(text)
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Record undo receipt is damaged"))
}

/// Call only after resolving ownership / authorizing scope. This deliberately
/// distinguishes withdrawal from permanent deletion, including legacy GUI paths.
pub(super) fn require_record_visible(conn: &Connection, target: &RecordTarget) -> AgentResult<()> {
    target.key()?;
    let suffix = format!("%/{}/record/{}", target.scope.key(), target.record_id);
    let withdrawn: Option<(String,String,u64)>=conn.query_row("SELECT object_key,creation_operation_id,revision FROM agent_object_withdrawals WHERE object_key LIKE ?1 AND withdrawn_at IS NOT NULL",[suffix],|row|Ok((row.get(0)?,row.get(1)?,row.get::<_,i64>(2)? as u64))).optional().map_err(io_error)?;
    if let Some((object_key, creation_operation_id, revision)) = withdrawn {
        return Err(AgentError::new(ErrorCode::ObjectWithdrawn,"Record has been withdrawn; restore it to use its current contents").with_details(json!({"workspaceId":object_key.split('/').next(),"objectKey":object_key,"creationOperationId":creation_operation_id,"withdrawalRevision":revision,"restoreAvailable":true})));
    }
    Ok(())
}

struct Creation {
    object: ObjectRef,
    head: RecordCommittedHead,
    metadata_revision: String,
    undo_operation_id: Option<String>,
    expected_revision: u64,
    expected_body_hash: String,
    expected_metadata: Option<Value>,
    tail_snapshot: Option<String>,
}
fn creation(
    conn: &Connection,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    input: &RecordWithdrawalInput,
    operation: &str,
) -> AgentResult<Creation> {
    if input.creation_operation_id.len() != 32
        || !input
            .creation_operation_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Invalid creation operation identity",
        ));
    }
    if request.binding != *binding || request.scope_grant.workspace_id != binding.workspace_id {
        return Err(AgentError::new(
            ErrorCode::WorkspaceChanged,
            "Workspace binding is no longer current",
        ));
    }
    let (_caller,run_id,object,head,context,undo_operation_id):(String,Option<String>,String,String,String,Option<String>)=conn.query_row("SELECT caller_id,run_id,target_ref_json,result_json,output_context_json,undo_operation_id FROM agent_operation_receipts WHERE operation_id=?1 AND operation='record.create' AND state='committed' AND undo_state IN ('available','undone')",[&input.creation_operation_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?))).optional().map_err(io_error)?.ok_or_else(||AgentError::new(ErrorCode::NotFound,"Recoverable Record creation receipt is unavailable"))?;
    let object: ObjectRef = decode(&object)?;
    let head: RecordCommittedHead = decode(&head)?;
    if object.kind != ObjectKind::Record
        || object.workspace_id != binding.workspace_id
        || object.scope != head.target.scope
        || object.id != head.target.record_id.to_string()
    {
        return Err(AgentError::new(
            ErrorCode::ScopeDenied,
            "Creation receipt belongs to another object",
        ));
    }
    request.authorize(binding, &object.scope, operation)?;
    match &request.caller {
        Caller::Gui => {}
        Caller::BuiltinRun { run_id: own } if run_id.as_deref() == Some(own.as_str()) => {}
        _ => {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Only the owning Run or local Workspace interface can recover this creation",
            ))
        }
    }
    let context: Value = decode(&context)?;
    let metadata_revision = context
        .get("afterMetadata")
        .and_then(|v| v.get("revision"))
        .and_then(Value::as_str)
        .ok_or_else(|| conflict("Creation metadata baseline is unavailable"))?
        .to_string();
    if context.get("afterBodyHash").and_then(Value::as_str) != Some(head.body_hash.as_str()) {
        return Err(conflict("Creation body baseline is unavailable"));
    }
    // A creation followed by same-Run patches is withdrawn at its actual tail.
    // The inverse receipt retains that baseline for later restore, even after
    // the conversation has been removed.
    let tail: Option<Value> = if let Some(id) = &undo_operation_id {
        let raw: Option<String> = conn.query_row("SELECT output_context_json FROM agent_operation_receipts WHERE operation_id=?1 AND operation='record.withdraw' AND state='committed'", [id], |row| row.get(0)).optional().map_err(io_error)?;
        raw.map(|raw| decode(&raw)).transpose()?
    } else {
        None
    };
    let expected_revision = tail
        .as_ref()
        .and_then(|v| v["tailRevision"].as_u64())
        .unwrap_or(head.head_revision);
    let expected_body_hash = tail
        .as_ref()
        .and_then(|v| v["tailBodyHash"].as_str())
        .unwrap_or(&head.body_hash)
        .to_owned();
    let expected_metadata = tail.as_ref().and_then(|v| v.get("tailMetadata")).cloned();
    let tail_snapshot = tail
        .as_ref()
        .and_then(|v| v["tailSnapshotRef"].as_str())
        .map(str::to_owned);
    if tail.as_ref().is_some_and(|v| {
        v["originalOperationIds"]
            .as_array()
            .is_some_and(|ids| ids.len() > 1)
    }) && (expected_metadata.is_none()
        || tail_snapshot.is_none()
        || tail
            .as_ref()
            .and_then(|v| v["tailBodyHash"].as_str())
            .is_none()
        || tail
            .as_ref()
            .and_then(|v| v["tailRevision"].as_u64())
            .is_none())
    {
        return Err(conflict("Creation chain withdrawal baseline is incomplete"));
    }
    Ok(Creation {
        object,
        head,
        metadata_revision,
        undo_operation_id,
        expected_revision,
        expected_body_hash,
        expected_metadata,
        tail_snapshot,
    })
}

fn validate_current(conn: &Connection, created: &Creation) -> AgentResult<()> {
    let head = super::record_documents::head_unchecked(conn, &created.head.target)?
        .ok_or_else(|| conflict("Created Record is no longer present"))?;
    let metadata = super::record_documents::metadata_unchecked(conn, &created.head.target)?;
    if head.head_revision != created.expected_revision
        || head.projection.body_hash != created.expected_body_hash
        || (if let Some(expected) = &created.expected_metadata {
            serde_json::to_value(&metadata).map_err(|_| conflict("Invalid Record metadata"))?
                != *expected
        } else {
            metadata.revision != created.metadata_revision
        })
        || head.edit_session_id.is_some()
    {
        return Err(conflict(
            "Record changed after its creation; its later work will be retained",
        ));
    }
    if let Some(snapshot) = &created.tail_snapshot {
        let retained: Option<(i64, String)> = conn
            .query_row(
                "SELECT head_revision,body_hash FROM record_versions WHERE record_key=?1 AND id=?2",
                params![created.head.target.key()?, snapshot],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(io_error)?;
        if !retained.is_some_and(|(revision, hash)| {
            revision as u64 == created.expected_revision && hash == created.expected_body_hash
        }) {
            return Err(conflict("Withdrawn Record tail version is unavailable"));
        }
    }
    Ok(())
}

/// Structured edges are authoritative for native documents and knowledge.
/// Existing GUI Todo / legacy markdown references predate that graph: inspect
/// their actual typed tokens too, rather than mistaking a missing edge for no use.
fn require_no_incoming(conn: &Connection, object: &ObjectRef) -> AgentResult<()> {
    let key = object.key()?;
    let incoming:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM content_reference_edges WHERE target_object_key=?1 AND source_object_key!=?1)",[&key],|row|row.get(0)).map_err(io_error)?;
    if incoming {
        return Err(conflict("Other objects now reference this Record"));
    }
    let mut statement=conn.prepare("SELECT 'todo',id,content FROM todos UNION ALL SELECT 'todo_progress',id,content FROM todo_progresses UNION ALL SELECT 'project',id,summary_markdown FROM projects UNION ALL SELECT 'note',id,content_markdown FROM notes UNION ALL SELECT 'workspace_record',id,content_markdown FROM workspace_notes WHERE note_kind='workspace_note'").map_err(io_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(io_error)?;
    let target_kind = if object.scope == Scope::Workspace {
        "workspace_record"
    } else {
        "note"
    };
    let target_id = object
        .id
        .parse::<i64>()
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid creation identity"))?;
    for row in rows {
        let (kind, id, text) = row.map_err(io_error)?;
        if kind == target_kind && id == target_id {
            continue;
        }
        if super::parse_internal_reference_tokens(&text)
            .iter()
            .any(|(kind, id)| kind == target_kind && *id == target_id)
        {
            return Err(conflict("Other objects now reference this Record"));
        }
    }
    Ok(())
}

fn previous(
    conn: &Connection,
    operation_id: &str,
    operation: &str,
) -> AgentResult<RecordWithdrawalResult> {
    let result:String=conn.query_row("SELECT result_json FROM agent_operation_receipts WHERE operation_id=?1 AND operation=?2 AND state='committed'",params![operation_id,operation],|row|row.get(0)).optional().map_err(io_error)?.ok_or_else(||AgentError::new(ErrorCode::IoFailed,"Committed recovery receipt is missing"))?;
    decode(&result)
}

/// The batch coordinator calls this under its native writer transaction before
/// checking incoming references. A replay is resolved from durable receipts
/// without testing a head that may have changed after successful withdrawal.
pub(super) fn creation_group_check(
    db: &Database,
    conn: &Connection,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    group: &OperationUndoGroup,
) -> AgentResult<Option<RecordWithdrawalResult>> {
    db.operation_binding(binding)?;
    if group.object.kind != ObjectKind::Record
        || group.first().kind != "record.create"
        || group
            .operations
            .iter()
            .skip(1)
            .any(|e| e.kind != "record.patch")
        || group.operations.iter().any(|e| e.object != group.object)
    {
        return Err(conflict("Selected receipts are not a created Record chain"));
    }
    let input = RecordWithdrawalInput {
        creation_operation_id: group.first().operation_id.clone(),
    };
    let created = creation(conn, request, binding, &input, "operation.undo")?;
    if created.object != group.object {
        return Err(conflict("Creation receipt targets another Record"));
    }
    let resolved = db
        .agent_resolve_object(&created.object, &binding.workspace_id)?
        .ok_or_else(|| conflict("Created Record is no longer present"))?;
    request.authorize_object(binding, &created.object, &resolved, "operation.undo")?;
    match group.undo_state {
        OperationBatchUndoState::Undone => {
            let id = created
                .undo_operation_id
                .as_deref()
                .ok_or_else(|| conflict("Withdrawal receipt is missing"))?;
            if group
                .operations
                .iter()
                .any(|e| e.undo_operation_id.as_deref() != Some(id))
            {
                return Err(conflict(
                    "Created Record chain has different inverse receipts",
                ));
            }
            let raw: String = conn.query_row("SELECT output_context_json FROM agent_operation_receipts WHERE operation_id=?1 AND operation='record.withdraw' AND state='committed'", [id], |r| r.get(0)).map_err(io_error)?;
            let context: Value = decode(&raw)?;
            let selected: Vec<&str> = group
                .operations
                .iter()
                .map(|e| e.operation_id.as_str())
                .collect();
            if context["originalOperationIds"] != json!(selected) {
                return Err(conflict(
                    "Withdrawal chain receipt differs from selected originals",
                ));
            }
            let result = previous(conn, id, "record.withdraw")?;
            if result.object != group.object
                || result.creation_operation_id != input.creation_operation_id
                || !result.withdrawn
            {
                return Err(conflict("Withdrawal receipt targets another Record"));
            }
            return Ok(Some(result));
        }
        OperationBatchUndoState::Available => {}
        _ => return Err(conflict("Created Record chain cannot be withdrawn")),
    }
    if let Some(problem) = group.conflicts.first() {
        return Err(problem.error.clone());
    }
    if created.undo_operation_id.is_some() {
        return Err(conflict("Created Record was already withdrawn"));
    }
    let target = &created.head.target;
    let original_context: String = conn
        .query_row(
            "SELECT output_context_json FROM agent_operation_receipts WHERE operation_id=?1",
            [&input.creation_operation_id],
            |r| r.get(0),
        )
        .map_err(io_error)?;
    let original_context: Value = decode(&original_context)?;
    let tail = group.last();
    let tail_context: String = conn
        .query_row(
            "SELECT output_context_json FROM agent_operation_receipts WHERE operation_id=?1",
            [&tail.operation_id],
            |r| r.get(0),
        )
        .map_err(io_error)?;
    let tail_context: Value = decode(&tail_context)?;
    if tail_context["afterMetadata"]["revision"] != original_context["afterMetadata"]["revision"] {
        return Err(conflict(
            "Record metadata changed during the creation chain",
        ));
    }
    let current = super::record_documents::head_unchecked(conn, target)?
        .ok_or_else(|| conflict("Created Record is no longer present"))?;
    let metadata = super::record_documents::metadata_unchecked(conn, target)?;
    if current.head_revision
        != tail
            .after_revision
            .ok_or_else(|| conflict("Tail revision is missing"))?
        || current.projection.body_hash
            != tail_context["afterBodyHash"]
                .as_str()
                .ok_or_else(|| conflict("Tail body baseline is missing"))?
        || serde_json::to_value(metadata).map_err(|_| conflict("Invalid Record metadata"))?
            != tail_context["afterMetadata"]
        || current.edit_session_id.is_some()
    {
        return Err(conflict("Record changed after its creation chain"));
    }
    let mut preceding_hash: Option<String> = None;
    for entry in &group.operations {
        let after = entry
            .after_snapshot_ref
            .as_deref()
            .ok_or_else(|| conflict("Record version baseline is missing"))?;
        let (revision, hash): (i64, String) = conn
            .query_row(
                "SELECT head_revision,body_hash FROM record_versions WHERE record_key=?1 AND id=?2",
                params![target.key()?, after],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(io_error)?
            .ok_or_else(|| conflict("Record version baseline is missing"))?;
        if Some(revision as u64) != entry.after_revision {
            return Err(conflict("Record version revision differs from receipt"));
        }
        if let Some(before_id) = entry.before_snapshot_ref.as_deref() {
            let (before_revision, before_hash): (i64, String) = conn.query_row("SELECT head_revision,body_hash FROM record_versions WHERE record_key=?1 AND id=?2", params![target.key()?,before_id], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(io_error)?.ok_or_else(|| conflict("Previous Record version is missing"))?;
            if Some(before_revision as u64) != entry.before_revision
                || preceding_hash.as_deref() != Some(before_hash.as_str())
            {
                return Err(conflict("Record version chain differs from receipts"));
            }
        } else if entry.operation_id != group.first().operation_id {
            return Err(conflict("Record patch has no previous version"));
        }
        preceding_hash = Some(hash);
    }
    if preceding_hash.as_deref() != Some(current.projection.body_hash.as_str()) {
        return Err(conflict("Record tail body differs from history"));
    }
    Ok(None)
}

pub(super) fn creation_group_apply(
    db: &Database,
    tx: &Transaction<'_>,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    group: &OperationUndoGroup,
) -> AgentResult<RecordWithdrawalResult> {
    let first = group.first();
    let last = group.last();
    let request_id = format!("creationundo:{}:{}", first.operation_id, last.operation_id);
    let payload: Vec<&str> = group
        .operations
        .iter()
        .map(|e| e.operation_id.as_str())
        .collect();
    db.agent_atomic_operation_in_transaction(tx, &request.caller.key(), &request_id, "record.withdraw", &payload, |tx| {
        if let Some(previous) = creation_group_check(db, tx, request, binding, group)? { return Ok((previous, None)); }
        let key = group.object_key.clone();
        let state: Option<String> = tx.query_row("SELECT creation_operation_id FROM agent_object_withdrawals WHERE object_key=?1", [&key], |r| r.get(0)).optional().map_err(io_error)?;
        if state.is_some_and(|id| id != first.operation_id) { return Err(conflict("Another creation owns this recovery state")); }
        let operation_id = random_id();
        let revision: i64 = tx.query_row("SELECT COALESCE(MAX(revision),0)+1 FROM agent_object_withdrawals WHERE object_key=?1", [&key], |r| r.get(0)).map_err(io_error)?;
        tx.execute("INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,restore_operation_id,revision) VALUES (?1,?2,?3,NULL,?4) ON CONFLICT(object_key) DO UPDATE SET withdrawn_at=excluded.withdrawn_at,restore_operation_id=NULL,revision=excluded.revision",params![key,first.operation_id,Utc::now().to_rfc3339(),revision]).map_err(io_error)?;
        for entry in &group.operations {
            let changed = tx.execute("UPDATE agent_operation_receipts SET undo_state='undone',undo_operation_id=?1 WHERE operation_id=?2 AND undo_state='available' AND undo_operation_id IS NULL", params![operation_id,entry.operation_id]).map_err(io_error)?;
            if changed != 1 { return Err(conflict("Created Record chain changed during withdrawal")); }
        }
        let cache_exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_index_snapshots')", [], |r| r.get(0)).map_err(io_error)?;
        if cache_exists { tx.execute("DELETE FROM source_index_snapshots WHERE object_key=?1", [&key]).map_err(io_error)?; }
        tx.execute("UPDATE agent_jobs SET state='cancelled',error=NULL WHERE kind='extract' AND dedupe_key=?1 AND state IN ('queued','running')", [format!("source-index:{key}")]).map_err(io_error)?;
        Ok((RecordWithdrawalResult { operation_id, creation_operation_id: first.operation_id.clone(), object: group.object.clone(), withdrawn: true, revision: revision as u64 }, Some(OperationChange { object_key: key, scope: group.object.scope.clone(), revision: format!("withdrawal:{revision}:withdrawn") })))
    })
}

impl Database {
    pub(crate) fn agent_record_creation_withdraw(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &RecordWithdrawalInput,
    ) -> AgentResult<RecordWithdrawalResult> {
        self.record_creation_visibility(request, binding, input, true, None)
    }
    pub(crate) fn agent_record_creation_restore(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &RecordRestoreInput,
    ) -> AgentResult<RecordWithdrawalResult> {
        self.record_creation_visibility(
            request,
            binding,
            &RecordWithdrawalInput {
                creation_operation_id: input.creation_operation_id.clone(),
            },
            false,
            Some(input.expected_withdrawal_revision),
        )
    }
    fn record_creation_visibility(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &RecordWithdrawalInput,
        withdraw: bool,
        expected_revision: Option<u64>,
    ) -> AgentResult<RecordWithdrawalResult> {
        if self
            .native_workspace_id
            .as_deref()
            .is_some_and(|id| id != binding.workspace_id)
        {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Recovery Workspace is no longer current",
            ));
        }
        let permission = if withdraw {
            "operation.undo"
        } else {
            "operation.restore_created"
        };
        let operation = if withdraw {
            "record.withdraw"
        } else {
            "record.restore"
        };
        // A receipt replay is still an authorized read. The generic atomic
        // helper checks replay before invoking its mutation closure.
        let baseline = creation(&self.conn, request, binding, input, permission)?;
        let resolved = self
            .agent_resolve_object(&baseline.object, &binding.workspace_id)?
            .ok_or_else(|| conflict("Created Record is no longer present"))?;
        request.authorize_object(binding, &baseline.object, &resolved, permission)?;
        self.agent_atomic_operation(&request.caller.key(),&request.request_id,operation,&(input,expected_revision),|tx|{
            let created=creation(tx,request,binding,input,permission)?;
            let resolved=self.agent_resolve_object(&created.object,&binding.workspace_id)?.ok_or_else(||conflict("Created Record is no longer present"))?;
            request.authorize_object(binding,&created.object,&resolved,permission)?;
            let key=created.object.key()?;
            let state:Option<(String,Option<String>,Option<String>,u64)>=tx.query_row("SELECT creation_operation_id,withdrawn_at,restore_operation_id,revision FROM agent_object_withdrawals WHERE object_key=?1",[&key],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get::<_,i64>(3)? as u64))).optional().map_err(io_error)?;
            if let Some((creation_id,_,_,_))=&state {if creation_id!=&input.creation_operation_id {return Err(conflict("Another creation owns this recovery state"));}}
            if withdraw {if let Some(id)=&created.undo_operation_id {return Ok((previous(tx,id,"record.withdraw")?,None));}}
            else if let Some((_,_,Some(id),revision))=&state {if expected_revision!=revision.checked_sub(1) {return Err(conflict("Withdrawal state changed; reload it before restoring"));}return Ok((previous(tx,id,"record.restore")?,None));}
            if !withdraw && expected_revision!=state.as_ref().map(|(_,_,_,revision)|*revision) {return Err(conflict("Withdrawal state changed; reload it before restoring"));}
            validate_current(tx,&created)?;
            if withdraw {require_no_incoming(tx,&created.object)?;}else if !state.as_ref().is_some_and(|(_,at,_,_)|at.is_some()) {return Err(conflict("Record has no committed withdrawal to restore"));}
            let revision=state.map_or(1,|(_,_,_,revision)|revision+1);
            if revision>i64::MAX as u64 {return Err(AgentError::new(ErrorCode::BudgetExceeded,"Withdrawal revision exhausted"));}
            let operation_id=random_id();
            let at=if withdraw {Some(Utc::now().to_rfc3339())}else{None};
            tx.execute("INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,restore_operation_id,revision) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(object_key) DO UPDATE SET withdrawn_at=excluded.withdrawn_at,restore_operation_id=excluded.restore_operation_id,revision=excluded.revision",params![key,input.creation_operation_id,at,if withdraw {None}else{Some(&operation_id)},revision as i64]).map_err(io_error)?;
            if withdraw {tx.execute("UPDATE agent_operation_receipts SET undo_state='undone',undo_operation_id=?1 WHERE operation_id=?2 AND undo_state='available'",params![operation_id,input.creation_operation_id]).map_err(io_error)?;let cache_exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_index_snapshots')",[],|row|row.get(0)).map_err(io_error)?;if cache_exists {tx.execute("DELETE FROM source_index_snapshots WHERE object_key=?1",[&key]).map_err(io_error)?;}tx.execute("UPDATE agent_jobs SET state='cancelled',error=NULL WHERE kind='extract' AND dedupe_key=?1 AND state IN ('queued','running')",[format!("source-index:{key}")]).map_err(io_error)?;}
            let result=RecordWithdrawalResult{operation_id,creation_operation_id:input.creation_operation_id.clone(),object:created.object.clone(),withdrawn:withdraw,revision};
            Ok((result,Some(OperationChange{object_key:key,scope:created.object.scope,revision:format!("withdrawal:{revision}:{}",if withdraw {"withdrawn"}else{"visible"})})))
        })
    }
}

/// The atomic-operation owner invokes this after inserting the ordinary receipt.
pub(super) fn agent_record_withdrawal_receipt_committed(
    tx: &rusqlite::Transaction<'_>,
    caller: &str,
    request_id: &str,
    operation: &str,
    result_json: &str,
) -> AgentResult<()> {
    if !matches!(operation, "record.withdraw" | "record.restore") {
        return Ok(());
    }
    let result: RecordWithdrawalResult = decode(result_json)?;
    let originals: Vec<(String, Option<i64>, Option<String>, String)> = if operation
        == "record.withdraw"
    {
        tx.prepare("SELECT operation_id,after_revision,after_snapshot_ref,output_context_json FROM agent_operation_receipts WHERE undo_operation_id=?1 ORDER BY rowid")
            .map_err(io_error)?.query_map([&result.operation_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))
            .map_err(io_error)?.collect::<Result<_,_>>().map_err(io_error)?
    } else {
        Vec::new()
    };
    let tail = originals.last();
    let tail_context: Option<Value> = tail.map(|(_, _, _, raw)| decode(raw)).transpose()?;
    let context = json!({
        "creationOperationId":result.creation_operation_id,
        "withdrawn":result.withdrawn,
        "withdrawalRevision":result.revision,
        "originalOperationIds":originals.iter().map(|(id,_,_,_)|id).collect::<Vec<_>>(),
        "tailRevision":tail.and_then(|(_,rev,_,_)|*rev),
        "tailSnapshotRef":tail.and_then(|(_,_,snapshot,_)|snapshot.as_deref()),
        "tailBodyHash":tail_context.as_ref().and_then(|v|v["afterBodyHash"].as_str()),
        "tailMetadata":tail_context.as_ref().and_then(|v|v.get("afterMetadata")),
    });
    tx.execute("UPDATE agent_operation_receipts SET operation_id=?1,target_ref_json=?2,run_id=(SELECT run_id FROM agent_operation_receipts WHERE operation_id=?6),before_revision=(SELECT after_revision FROM agent_operation_receipts WHERE operation_id=?6),after_revision=(SELECT after_revision FROM agent_operation_receipts WHERE operation_id=?6),output_context_json=?7,undo_state='unavailable' WHERE caller_id=?3 AND request_id=?4 AND operation=?5 AND NOT EXISTS(SELECT 1 FROM agent_operation_receipts WHERE operation_id=?1)",params![result.operation_id,serde_json::to_string(&result.object).map_err(|_|AgentError::new(ErrorCode::IoFailed,"Invalid recovery object"))?,caller,request_id,operation,result.creation_operation_id,context.to_string()]).map_err(io_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            access::ScopeGrant, conversation::RunPreparation, output_runtime::StageRecordInput,
            outputs::OutputIntent,
        },
        models::{
            ProjectCreateInput, TodoCreateInput, TodoScope, WorkspaceQuickNoteUpsertInput,
            WorkspaceRecordUpsertInput, WorkspaceSearchInput,
        },
        record_documents::{body_hash, RecordCreate, RecordDocumentProjection},
        source_service::SourceReadTarget,
    };

    pub(super) struct Fixture {
        _root: tempfile::TempDir,
        pub(super) db: Database,
        pub(super) request: RequestContext,
        pub(super) binding: WorkspaceBinding,
        pub(super) input: RecordWithdrawalInput,
        pub(super) target: RecordTarget,
        session_id: String,
        version_id: String,
    }
    pub(super) fn fixture(scope: Scope) -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("undo.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("undo-workspace").unwrap();
        // This is the formal migration entry, not lazy schema creation.
        db.ensure_agent_output_schema().unwrap();
        if let Scope::Project { project_id } = scope {
            let project = db
                .project_create(ProjectCreateInput {
                    name: "Project".into(),
                    summary: None,
                    status: None,
                })
                .unwrap();
            assert_eq!(project.id, project_id);
        }
        let binding = WorkspaceBinding {
            workspace_id: "undo-workspace".into(),
            generation: "one".into(),
        };
        let mut request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "prepare".into(),
            scope_grant: ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: true,
                project_ids: vec![1],
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
                    "operation.restore_created",
                ]
                .into_iter()
                .map(String::from)
                .collect(),
            },
        };
        let session = db
            .agent_session_create(&request, &binding, &scope, "Creation", "pi", None)
            .unwrap();
        let run_id = "1234567890abcdef1234567890abcdef".to_string();
        db.agent_run_prepare(
            &request,
            &binding,
            &session.id,
            "creation",
            &RunPreparation {
                run_id: run_id.clone(),
                context_manifest: json!({"scope":scope,"mode":"collaborate"}),
            },
        )
        .unwrap();
        db.agent_run_start(&request, &binding, &run_id).unwrap();
        request.caller = Caller::BuiltinRun { run_id };
        request.request_id = "stage".into();
        let title = "Withdraw fixture";
        let text = "Unicode 撤回可恢复正文";
        let document = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"content":[{"type":"text","text":text}]}]});
        let projection = RecordDocumentProjection {
            schema_version: 1,
            body_hash: body_hash(&document, &None),
            document: document.clone(),
            html: format!("<p data-block-id=\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\">{text}</p>"),
            markdown: text.into(),
            text: text.into(),
            code_language: None,
        };
        let staged = db
            .agent_output_stage_record(
                &request,
                &binding,
                &StageRecordInput {
                    intent: OutputIntent::RecordCreate {
                        scope: scope.clone(),
                        title: title.into(),
                        markdown: text.into(),
                    },
                    sources: vec![],
                },
            )
            .unwrap();
        let prepared = db
            .agent_output_commit_prepare(&request, &binding, &staged.staged.id, 1)
            .unwrap();
        let saved = db
            .record_create(
                &request.caller.key(),
                &prepared.commit_request_id,
                &RecordCreate {
                    scope,
                    title: Some(title.into()),
                    tag_ids: vec![],
                    document,
                    code_language: None,
                },
                &projection,
                &binding.workspace_id,
            )
            .unwrap();
        let (operation_id,version_id)=db.conn.query_row("SELECT operation_id,after_snapshot_ref FROM agent_operation_receipts WHERE caller_id=?1 AND request_id=?2",params![request.caller.key(),prepared.commit_request_id],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
        request.caller = Caller::Gui;
        request.request_id = "withdraw".into();
        Fixture {
            _root: root,
            db,
            request,
            binding,
            input: RecordWithdrawalInput {
                creation_operation_id: operation_id,
            },
            target: saved.target,
            session_id: session.id,
            version_id,
        }
    }
    fn restore_input(f: &Fixture) -> RecordRestoreInput {
        RecordRestoreInput {
            creation_operation_id: f.input.creation_operation_id.clone(),
            expected_withdrawal_revision: 1,
        }
    }

    #[test]
    fn agent_record_withdrawal_hides_current_reads_preserves_history_and_restores_same_id() {
        let mut f = fixture(Scope::Workspace);
        f.db.workspace_quick_note_upsert(WorkspaceQuickNoteUpsertInput {
            html: "<p>visible quick</p>".into(),
            markdown: "visible quick".into(),
            default_code_language: None,
            tag_ids: vec![],
        })
        .unwrap();
        let result =
            f.db.agent_record_creation_withdraw(&f.request, &f.binding, &f.input)
                .unwrap();
        assert!(result.withdrawn);
        assert!(f.db.workspace_record_list().unwrap().is_empty());
        assert_eq!(
            f.db.conn
                .query_row(
                    "SELECT count(*) FROM workspace_notes WHERE note_kind='workspace_note'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert!(f.db.workspace_quick_note_get().unwrap().is_some());
        assert_eq!(
            f.db.record_document_head(&f.target).unwrap_err().code,
            ErrorCode::ObjectWithdrawn
        );
        assert_eq!(
            f.db.source_read_object(&f.request, &f.binding, &result.object)
                .unwrap_err()
                .code,
            ErrorCode::ObjectWithdrawn
        );
        assert_eq!(
            f.db.record_version_get(&f.target, &f.version_id)
                .unwrap()
                .projection
                .body_hash,
            f.db.record_versions_list(&f.target, None, 10)
                .unwrap()
                .versions[0]
                .body_hash
        );
        assert!(f
            .db
            .source_record_snapshot(
                &f.request,
                &f.binding,
                &SourceReadTarget {
                    object: result.object.clone(),
                    revision: None,
                    record_version: Some(1),
                    file_version: None
                }
            )
            .is_ok());
        let search =
            f.db.workspace_search(WorkspaceSearchInput {
                query: "撤回可恢复".into(),
                include_archived: None,
                project_id: None,
            })
            .unwrap();
        assert!(search.is_empty());
        f.request.request_id = "restore".into();
        assert_eq!(
            f.db.agent_record_creation_restore(
                &f.request,
                &f.binding,
                &RecordRestoreInput {
                    creation_operation_id: f.input.creation_operation_id.clone(),
                    expected_withdrawal_revision: 0
                }
            )
            .unwrap_err()
            .code,
            ErrorCode::UndoConflict
        );
        // GUI recovery uses the current withdrawal revision; no front-end body baseline.
        let restored =
            f.db.agent_record_creation_restore(
                &f.request,
                &f.binding,
                &RecordRestoreInput {
                    creation_operation_id: f.input.creation_operation_id.clone(),
                    expected_withdrawal_revision: result.revision,
                },
            )
            .unwrap();
        assert!(!restored.withdrawn);
        assert_eq!(restored.object.id, f.target.record_id.to_string());
        assert_eq!(f.db.workspace_record_list().unwrap().len(), 1);
        let operations: Vec<String> =
            f.db.conn
                .prepare("SELECT operation FROM agent_change_log WHERE object_key=?1 ORDER BY seq")
                .unwrap()
                .query_map([result.object.key().unwrap()], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
        assert!(operations.ends_with(&["record.withdraw".into(), "record.restore".into()]));
        assert_eq!(
            f.db.conn
                .query_row(
                    "SELECT deleted_at IS NULL FROM source_registry WHERE object_key=?1",
                    [result.object.key().unwrap()],
                    |row| row.get::<_, bool>(0)
                )
                .unwrap(),
            true
        );
    }

    #[test]
    fn agent_record_withdrawal_checks_body_metadata_and_actual_incoming_uses() {
        for change in ["head", "metadata", "edge", "todo", "legacy"] {
            let mut f = fixture(Scope::Workspace);
            match change {
                "head" => {
                    f.db.conn
                        .execute(
                            "UPDATE record_document_heads SET head_revision=head_revision+1",
                            [],
                        )
                        .unwrap();
                }
                "metadata" => {
                    f.db.conn
                        .execute(
                            "UPDATE workspace_notes SET title='Human change' WHERE id=?1",
                            [f.target.record_id],
                        )
                        .unwrap();
                }
                "edge" => {
                    f.db.conn.execute("INSERT INTO content_reference_edges(source_object_key,target_object_key,relation) VALUES ('undo-workspace/workspace/todo/100',?1,'internal_reference')",[f.target.object_key(&f.binding.workspace_id).unwrap()]).unwrap();
                }
                "todo" => {
                    f.db.todo_create(TodoCreateInput {
                        scope: TodoScope::Workspace,
                        project_id: None,
                        content: format!("[[workspace_record:{}|Creation]]", f.target.record_id),
                        priority: "normal".into(),
                        due_date: None,
                        tag_ids: vec![],
                    })
                    .unwrap();
                }
                "legacy" => {
                    f.db.workspace_record_upsert(WorkspaceRecordUpsertInput {
                        note_id: None,
                        title: Some("New reference".into()),
                        html: "<p>linked</p>".into(),
                        markdown: format!("[[workspace_record:{}|Creation]]", f.target.record_id),
                        default_code_language: None,
                        tag_ids: vec![],
                    })
                    .unwrap();
                }
                _ => unreachable!(),
            }
            assert_eq!(
                f.db.agent_record_creation_withdraw(&f.request, &f.binding, &f.input)
                    .unwrap_err()
                    .code,
                ErrorCode::UndoConflict,
                "{change}"
            );
            assert_eq!(
                f.db.conn
                    .query_row("SELECT count(*) FROM agent_object_withdrawals", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .unwrap(),
                0
            );
        }
    }

    #[test]
    fn agent_record_withdrawal_replays_receipts_and_survives_session_deletion() {
        let mut f = fixture(Scope::Project { project_id: 1 });
        let first =
            f.db.agent_record_creation_withdraw(&f.request, &f.binding, &f.input)
                .unwrap();
        f.request.request_id = "different-withdraw-request".into();
        assert_eq!(
            f.db.agent_record_creation_withdraw(&f.request, &f.binding, &f.input)
                .unwrap()
                .operation_id,
            first.operation_id
        );
        assert!(f.db.fetch_project_notes(1).unwrap().is_empty());
        f.db.conn
            .execute("UPDATE agent_runs SET state='interrupted'", [])
            .unwrap();
        f.db.agent_session_delete(&f.request, &f.binding, &f.session_id)
            .unwrap();
        f.request.request_id = "restore".into();
        let restored =
            f.db.agent_record_creation_restore(&f.request, &f.binding, &restore_input(&f))
                .unwrap();
        f.request.request_id = "restore-again".into();
        assert_eq!(
            f.db.agent_record_creation_restore(&f.request, &f.binding, &restore_input(&f))
                .unwrap()
                .operation_id,
            restored.operation_id
        );
        assert_eq!(f.db.fetch_project_notes(1).unwrap().len(), 1);
        assert_eq!(
            f.db.agent_record_creation_restore(
                &f.request,
                &f.binding,
                &RecordRestoreInput {
                    creation_operation_id: f.input.creation_operation_id.clone(),
                    expected_withdrawal_revision: 2
                }
            )
            .unwrap_err()
            .code,
            ErrorCode::IdempotencyConflict
        );
        assert_eq!(f.db.conn.query_row("SELECT count(*) FROM agent_change_log WHERE operation IN ('record.withdraw','record.restore')",[],|row|row.get::<_,i64>(0)).unwrap(),2);
    }

    #[test]
    fn agent_record_withdrawal_uses_current_binding_and_original_owner() {
        let mut f = fixture(Scope::Workspace);
        f.request.caller = Caller::BuiltinRun {
            run_id: "abcdef1234567890abcdef1234567890".into(),
        };
        assert_eq!(
            f.db.agent_record_creation_withdraw(&f.request, &f.binding, &f.input)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        f.request.caller = Caller::Gui;
        f.request.binding.generation = "stale".into();
        assert_eq!(
            f.db.agent_record_creation_withdraw(&f.request, &f.binding, &f.input)
                .unwrap_err()
                .code,
            ErrorCode::WorkspaceChanged
        );
        f.request.binding = f.binding.clone();
        f.request.scope_grant.workspace_content = false;
        assert_eq!(
            f.db.agent_record_creation_withdraw(&f.request, &f.binding, &f.input)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
    }

    #[test]
    fn agent_record_withdrawal_outbox_failure_rolls_back_visibility_and_undo_receipt() {
        let f = fixture(Scope::Workspace);
        f.db.conn.execute_batch("CREATE TRIGGER fail_withdrawal_outbox BEFORE INSERT ON agent_change_log WHEN NEW.operation='record.withdraw' BEGIN SELECT RAISE(ABORT,'fixture outbox failure'); END").unwrap();
        assert_eq!(
            f.db.agent_record_creation_withdraw(&f.request, &f.binding, &f.input)
                .unwrap_err()
                .code,
            ErrorCode::IoFailed
        );
        assert!(f.db.record_document_head(&f.target).unwrap().is_some());
        assert_eq!(
            f.db.conn
                .query_row("SELECT count(*) FROM agent_object_withdrawals", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        assert_eq!(
            f.db.conn
                .query_row(
                    "SELECT undo_state FROM agent_operation_receipts WHERE operation_id=?1",
                    [f.input.creation_operation_id],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "available"
        );
    }
}

#[cfg(test)]
#[path = "agent_record_withdrawals_group_tests.rs"]
mod group_tests;
