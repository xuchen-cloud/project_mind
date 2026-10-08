//! File recovery retains every managed byte/version and uses native CAS receipts.
use super::{
    agent_operations::{io_error, OperationChange},
    agent_record_undo::{authorize, read_entry},
    agent_record_withdrawals::{RecordRestoreInput, RecordWithdrawalInput, RecordWithdrawalResult},
    file_versions::{self, CommittedVersion},
    Database,
};
use crate::{
    agent::{
        access::{RequestContext, ScopeGrant},
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
        operation_batches::{OperationBatchUndoState, OperationUndoBatchInput, OperationUndoGroup},
        operations::{FileUndoResult, OperationEntry, OperationUndoInput},
    },
    file_version_restore::FileVersionRestore,
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub(super) const FILE_VISIBILITY_VIEW_SQL: &str = r#"
CREATE VIEW agent_visible_files AS SELECT d.* FROM documents d WHERE NOT EXISTS (
 SELECT 1 FROM agent_object_withdrawals w WHERE w.withdrawn_at IS NOT NULL
 AND w.object_key GLOB '*/project:'||d.project_id||'/file/'||d.id
);
"#;
pub(crate) const FILE_UNDO_REQUEST_PREFIX: &str = "fileundo:";
pub(crate) const FILE_CHAIN_UNDO_REQUEST_PREFIX: &str = "filechainundo:";
pub(crate) const FILE_CREATION_UNDO_REQUEST_PREFIX: &str = "creationundo:";
fn conflict() -> AgentError {
    AgentError::new(
        ErrorCode::UndoConflict,
        "File changed after this operation; its later work will be retained",
    )
}
fn decode<T: DeserializeOwned>(value: &str) -> AgentResult<T> {
    serde_json::from_str(value)
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "File recovery receipt is damaged"))
}
fn encode(value: &impl Serialize) -> AgentResult<String> {
    serde_json::to_string(value)
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot encode File recovery receipt"))
}
fn file_id(object: &ObjectRef) -> AgentResult<i64> {
    object.key()?;
    if object.kind != ObjectKind::File || !matches!(object.scope, Scope::Project { .. }) {
        return Err(conflict());
    }
    object
        .id
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0 && id.to_string() == object.id)
        .ok_or_else(conflict)
}
pub(super) fn require_file_visible(conn: &Connection, id: i64) -> AgentResult<()> {
    let project: i64 = conn
        .query_row(
            "SELECT project_id FROM documents WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(io_error)?
        .ok_or_else(|| AgentError::new(ErrorCode::NotFound, "File is no longer present"))?;
    let state:Option<(String,String,i64)>=conn.query_row("SELECT object_key,creation_operation_id,revision FROM agent_object_withdrawals WHERE object_key LIKE ?1 AND withdrawn_at IS NOT NULL",[format!("%/project:{project}/file/{id}")],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(io_error)?;
    if let Some((key, creation, revision)) = state {
        return Err(AgentError::new(ErrorCode::ObjectWithdrawn,"File has been withdrawn; restore it to use its current contents").with_details(json!({"workspaceId":key.split('/').next(),"objectKey":key,"creationOperationId":creation,"withdrawalRevision":revision,"restoreAvailable":true})));
    }
    Ok(())
}
/// Encoded paths remain private receipt evidence, never part of operation DTOs.
pub(crate) fn agent_file_creation_metadata(conn: &Connection, id: i64) -> AgentResult<Value> {
    let mut value:Value=conn.query_row("SELECT id,project_id,base_name,name,storage_mode,managed_path,history_dir_path,updated_at,is_starred,mime_type,health,created_at FROM documents WHERE id=?1",[id],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"projectId":r.get::<_,i64>(1)?,"baseName":r.get::<_,String>(2)?,"name":r.get::<_,String>(3)?,"storageMode":r.get::<_,String>(4)?,"managedPath":r.get::<_,String>(5)?,"historyDirPath":r.get::<_,String>(6)?,"updatedAt":r.get::<_,String>(7)?,"isStarred":r.get::<_,i64>(8)?!=0,"mimeType":r.get::<_,String>(9)?,"health":r.get::<_,String>(10)?,"createdAt":r.get::<_,String>(11)?}))).map_err(io_error)?;
    let mut statement = conn
        .prepare("SELECT tag_id FROM document_tag_links WHERE document_id=?1 ORDER BY tag_id")
        .map_err(io_error)?;
    let ids = statement
        .query_map([id], |r| r.get::<_, i64>(0))
        .map_err(io_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io_error)?;
    value["tagIds"] = json!(ids);
    Ok(value)
}
fn entry(
    conn: &Connection,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    id: &str,
    permission: &str,
) -> AgentResult<OperationEntry> {
    let (entry, caller) = read_entry(conn, id)?;
    authorize(request, binding, &entry, &caller, permission)?;
    file_id(&entry.object)?;
    Ok(entry)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredGrant {
    workspace_id: String,
    workspace_content: bool,
    project_ids: Vec<i64>,
    operations: Vec<String>,
}
/// The actual retained run grant is independent of session visibility/lifetime.
fn original_authority(
    conn: &Connection,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    entry: &OperationEntry,
) -> AgentResult<()> {
    let Some(run_id) = &entry.run_id else {
        return Ok(());
    };
    let raw:String=conn.query_row("SELECT output_context_json FROM agent_operation_receipts WHERE operation_id=?1 AND run_id=?2",params![entry.operation_id,run_id],|r|r.get(0)).map_err(io_error)?;
    let context: Value = decode(&raw)?;
    let grant: StoredGrant =
        serde_json::from_value(context["originalGrant"].clone()).map_err(|_| {
            AgentError::new(
                ErrorCode::ScopeDenied,
                "Original File authority is unavailable",
            )
        })?;
    if !matches!(
        context["originalMode"].as_str(),
        Some("review" | "collaborate")
    ) {
        return Err(AgentError::new(
            ErrorCode::ScopeDenied,
            "Original Run cannot recover a write",
        ));
    }
    let captured = RequestContext {
        binding: request.binding.clone(),
        caller: request.caller.clone(),
        request_id: request.request_id.clone(),
        scope_grant: ScopeGrant {
            workspace_id: grant.workspace_id,
            workspace_content: grant.workspace_content,
            project_ids: grant.project_ids,
            operations: grant.operations,
        },
    };
    let permission = if entry.kind == "file.create" {
        "content.create"
    } else if captured
        .scope_grant
        .operations
        .iter()
        .any(|op| op == "file.update")
    {
        "file.update"
    } else {
        "file.restore"
    };
    captured.authorize(binding, &entry.object.scope, permission)
}
fn registered_version(
    conn: &Connection,
    object: &ObjectRef,
    version_id: &str,
    number: u64,
) -> AgentResult<(String, String)> {
    let id = file_id(object)?;
    let row:Option<(i64,String,String)>=conn.query_row("SELECT v.version_number,h.content_hash,v.managed_path FROM document_versions v JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.id=?1 AND v.document_id=?2",params![version_id,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(io_error)?;
    let (actual, hash, path) = row.ok_or_else(conflict)?;
    if u64::try_from(actual).ok() != Some(number) || !file_versions::valid_hash(&hash) {
        return Err(conflict());
    }
    Ok((hash, path))
}
fn baseline(conn: &Connection, entry: &OperationEntry) -> AgentResult<String> {
    let id = file_id(&entry.object)?;
    let number = entry.after_revision.ok_or_else(conflict)?;
    let version = entry.after_snapshot_ref.as_deref().ok_or_else(conflict)?;
    let (current, project): (i64, i64) = conn
        .query_row(
            "SELECT current_version_number,project_id FROM documents WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(io_error)?
        .ok_or_else(conflict)?;
    if u64::try_from(current).ok() != Some(number)
        || entry.object.scope
            != (Scope::Project {
                project_id: project,
            })
    {
        return Err(conflict());
    }
    let (hash, _) = registered_version(conn, &entry.object, version, number)?;
    let(context,result):(String,String)=conn.query_row("SELECT output_context_json,result_json FROM agent_operation_receipts WHERE operation_id=?1",[&entry.operation_id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(io_error)?;
    let context: Value = decode(&context)?;
    let result: Value = decode(&result)?;
    if context["afterBodyHash"].as_str() != Some(hash.as_str())
        || result["contentHash"].as_str() != Some(hash.as_str())
        || result["versionNumber"].as_u64() != Some(number)
    {
        return Err(conflict());
    }
    if entry.kind == "file.create"
        && context["afterMetadata"] != agent_file_creation_metadata(conn, id)?
    {
        return Err(conflict());
    }
    Ok(hash)
}

fn visibility_baseline(
    conn: &Connection,
    created: &OperationEntry,
) -> AgentResult<(String, String)> {
    let Some(inverse_id) = &created.undo_operation_id else {
        return Ok((
            baseline(conn, created)?,
            created.after_snapshot_ref.clone().ok_or_else(conflict)?,
        ));
    };
    let raw: String = conn
        .query_row(
            "SELECT output_context_json FROM agent_operation_receipts WHERE operation_id=?1",
            [inverse_id],
            |r| r.get(0),
        )
        .map_err(io_error)?;
    let context: Value = decode(&raw)?;
    if context["recovery"] != "file.creation_undo" {
        return Ok((
            baseline(conn, created)?,
            created.after_snapshot_ref.clone().ok_or_else(conflict)?,
        ));
    }
    let tail_id = context["tailOperationId"].as_str().ok_or_else(conflict)?;
    let (tail, _) = read_entry(conn, tail_id)?;
    if tail.object != created.object || tail.run_id != created.run_id {
        return Err(conflict());
    }
    let hash = baseline(conn, &tail)?;
    let metadata = agent_file_creation_metadata(conn, file_id(&created.object)?)?;
    let created_context: String = conn
        .query_row(
            "SELECT output_context_json FROM agent_operation_receipts WHERE operation_id=?1",
            [&created.operation_id],
            |r| r.get(0),
        )
        .map_err(io_error)?;
    let created_context: Value = decode(&created_context)?;
    if context["tailBodyHash"].as_str() != Some(hash.as_str())
        || context["tailVersionNumber"].as_u64() != tail.after_revision
        || context["tailVersionId"].as_str() != tail.after_snapshot_ref.as_deref()
        || stable_creation_metadata(created_context["afterMetadata"].clone())
            != stable_creation_metadata(metadata.clone())
        || ["name", "managedPath", "updatedAt"]
            .iter()
            .any(|key| context["tailMetadata"][key] != metadata[*key])
    {
        return Err(conflict());
    }
    Ok((hash, tail.after_snapshot_ref.ok_or_else(conflict)?))
}
fn no_incoming(conn: &Connection, object: &ObjectRef) -> AgentResult<()> {
    let key = object.key()?;
    let id = file_id(object)?;
    let edges:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM content_reference_edges WHERE target_object_key=?1 AND source_object_key!=?1)",[key],|r|r.get(0)).map_err(io_error)?;
    if edges {
        return Err(conflict());
    }
    let mut statement=conn.prepare("SELECT content FROM todos UNION ALL SELECT content FROM todo_progresses UNION ALL SELECT summary_markdown FROM projects UNION ALL SELECT content_markdown FROM notes UNION ALL SELECT content_markdown FROM workspace_notes").map_err(io_error)?;
    for row in statement
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(io_error)?
    {
        if super::parse_internal_reference_tokens(&row.map_err(io_error)?)
            .iter()
            .any(|(kind, target)| kind == "document" && *target == id)
        {
            return Err(conflict());
        }
    }
    Ok(())
}
fn previous<T: DeserializeOwned>(conn: &Connection, id: &str) -> AgentResult<T> {
    let raw:String=conn.query_row("SELECT result_json FROM agent_operation_receipts WHERE operation_id=?1 AND state='committed'",[id],|r|r.get(0)).map_err(io_error)?;
    decode(&raw)
}

fn stable_creation_metadata(mut value: Value) -> Value {
    if let Some(map) = value.as_object_mut() {
        for key in ["name", "managedPath", "updatedAt", "health"] {
            map.remove(key);
        }
    }
    value
}

/// Validate the complete native creation/version chain while the caller owns
/// the writer boundary. Incoming references are checked by the batch caller.
pub(super) fn creation_group_check(
    db: &Database,
    conn: &Connection,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    group: &OperationUndoGroup,
) -> AgentResult<Option<RecordWithdrawalResult>> {
    let created = group.first();
    if created.kind != "file.create"
        || group.object != created.object
        || group.operations.is_empty()
    {
        return Err(conflict());
    }
    let id = file_id(&created.object)?;
    let mut previous_entry: Option<&OperationEntry> = None;
    let mut inverse: Option<&str> = None;
    for (index, original) in group.operations.iter().enumerate() {
        if original.object != created.object
            || original.run_id.is_none()
            || original.run_id != created.run_id
            || (index == 0 && original.kind != "file.create")
            || (index > 0 && original.kind != "file.version.commit")
            || !matches!(original.undo_state.as_str(), "available" | "undone")
        {
            return Err(conflict());
        }
        let (actual, caller) = read_entry(conn, &original.operation_id)?;
        if actual.operation_id != original.operation_id
            || actual.object != original.object
            || actual.run_id != original.run_id
            || actual.undo_state != original.undo_state
            || actual.undo_operation_id != original.undo_operation_id
            || actual.before_revision != original.before_revision
            || actual.after_revision != original.after_revision
            || actual.before_snapshot_ref != original.before_snapshot_ref
            || actual.after_snapshot_ref != original.after_snapshot_ref
        {
            return Err(conflict());
        }
        authorize(request, binding, original, &caller, "operation.undo")?;
        original_authority(conn, request, binding, original)?;
        if index == 0 {
            if original.before_revision.is_some()
                || original.before_snapshot_ref.is_some()
                || original.after_revision != Some(1)
            {
                return Err(conflict());
            }
            inverse = original.undo_operation_id.as_deref();
        } else {
            let prior = previous_entry.ok_or_else(conflict)?;
            if original.before_revision != prior.after_revision
                || original.before_snapshot_ref != prior.after_snapshot_ref
            {
                return Err(conflict());
            }
            let before = original
                .before_snapshot_ref
                .as_deref()
                .ok_or_else(conflict)?;
            registered_version(
                conn,
                &original.object,
                before,
                original.before_revision.ok_or_else(conflict)?,
            )?;
        }
        if original.undo_operation_id.as_deref() != inverse
            || (original.undo_state == "undone") != inverse.is_some()
        {
            return Err(conflict());
        }
        let number = original.after_revision.ok_or_else(conflict)?;
        if index > 0 && original.before_revision.and_then(|n| n.checked_add(1)) != Some(number) {
            return Err(conflict());
        }
        let after = original
            .after_snapshot_ref
            .as_deref()
            .ok_or_else(conflict)?;
        let (hash, _) = registered_version(conn, &original.object, after, number)?;
        let (raw, result): (String, String) = conn.query_row(
            "SELECT output_context_json,result_json FROM agent_operation_receipts WHERE operation_id=?1 AND state='committed'",
            [&original.operation_id], |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(io_error)?;
        let context: Value = decode(&raw)?;
        let result: Value = decode(&result)?;
        if context["afterBodyHash"].as_str() != Some(hash.as_str())
            || result["contentHash"].as_str() != Some(hash.as_str())
            || result["versionNumber"].as_u64() != Some(number)
            || (index > 0 && (context["noChange"] == true || result["noChange"] == true))
        {
            return Err(conflict());
        }
        previous_entry = Some(original);
    }
    let tail = group.last();
    let key = created.object.key()?;
    let state: Option<(String, bool)> = conn.query_row(
        "SELECT creation_operation_id,withdrawn_at IS NOT NULL FROM agent_object_withdrawals WHERE object_key=?1",
        [&key], |r| Ok((r.get(0)?,r.get(1)?)),
    ).optional().map_err(io_error)?;
    if state.as_ref().is_some_and(|s| s.0 != created.operation_id) {
        return Err(conflict());
    }
    if let Some(inverse_id) = inverse {
        let raw: String = conn
            .query_row(
                "SELECT output_context_json FROM agent_operation_receipts WHERE operation_id=?1",
                [inverse_id],
                |r| r.get(0),
            )
            .map_err(io_error)?;
        let context: Value = decode(&raw)?;
        let ids: Vec<&str> = group
            .operations
            .iter()
            .map(|e| e.operation_id.as_str())
            .collect();
        if context["recovery"] != "file.creation_undo"
            || context["originalOperationIds"] != json!(ids)
            || context["tailOperationId"].as_str() != Some(tail.operation_id.as_str())
        {
            return Err(conflict());
        }
        return Ok(Some(previous(conn, inverse_id)?));
    }
    if let Some(issue) = group.conflicts.first() {
        return Err(issue.error.clone());
    }
    if state.as_ref().is_some_and(|s| s.1) {
        return Err(conflict());
    }
    let target = db.file_version_recovery_target_hidden(
        request,
        binding,
        &created.object,
        "operation.undo",
    )?;
    let current = agent_file_creation_metadata(conn, id)?;
    let created_context: String = conn
        .query_row(
            "SELECT output_context_json FROM agent_operation_receipts WHERE operation_id=?1",
            [&created.operation_id],
            |r| r.get(0),
        )
        .map_err(io_error)?;
    let created_context: Value = decode(&created_context)?;
    if stable_creation_metadata(created_context["afterMetadata"].clone())
        != stable_creation_metadata(current.clone())
    {
        return Err(conflict());
    }
    let tail_context: String = conn
        .query_row(
            "SELECT output_context_json FROM agent_operation_receipts WHERE operation_id=?1",
            [&tail.operation_id],
            |r| r.get(0),
        )
        .map_err(io_error)?;
    let tail_context: Value = decode(&tail_context)?;
    if current["projectId"] != json!(target.project_id)
        || current["updatedAt"] != tail_context["afterMetadata"]["updatedAt"]
        || current["name"] != tail_context["afterMetadata"]["name"]
        || current["managedPath"] != tail_context["afterMetadata"]["managedPath"]
    {
        return Err(conflict());
    }
    let (hash, _) = registered_version(
        conn,
        &tail.object,
        tail.after_snapshot_ref.as_deref().ok_or_else(conflict)?,
        tail.after_revision.ok_or_else(conflict)?,
    )?;
    let current_version: i64 = conn
        .query_row(
            "SELECT current_version_number FROM documents WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(io_error)?;
    if u64::try_from(current_version).ok() != tail.after_revision {
        return Err(conflict());
    }
    let path = Path::new(&target.managed_path);
    file_versions::relative(&db.workspace_root, path).map_err(|_| conflict())?;
    if file_versions::checksum(path).map_err(|_| conflict())? != hash {
        return Err(AgentError::new(
            ErrorCode::FileChangedUnregistered,
            "File bytes changed outside the registered version chain",
        ));
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
    if let Some(saved) = creation_group_check(db, tx, request, binding, group)? {
        return Ok(saved);
    }
    let created = group.first();
    let tail = group.last();
    let request_id = format!(
        "{FILE_CREATION_UNDO_REQUEST_PREFIX}{}:{}",
        created.operation_id, tail.operation_id
    );
    let ids: Vec<&str> = group
        .operations
        .iter()
        .map(|entry| entry.operation_id.as_str())
        .collect();
    let result = db.agent_atomic_operation_in_transaction(
        tx,
        &request.caller.key(),
        &request_id,
        "file.withdraw",
        &ids,
        |tx| {
            let target = db.file_version_recovery_target_hidden(request, binding, &created.object, "operation.undo")?;
            let key = created.object.key()?;
            let state: Option<(String, i64)> = tx.query_row(
                "SELECT creation_operation_id,revision FROM agent_object_withdrawals WHERE object_key=?1",
                [&key], |r| Ok((r.get(0)?, r.get(1)?)),
            ).optional().map_err(io_error)?;
            if state.as_ref().is_some_and(|s| s.0 != created.operation_id) { return Err(conflict()); }
            let revision = state.as_ref().map_or(Some(1), |s| s.1.checked_add(1))
                .filter(|value| *value > 0)
                .ok_or_else(|| AgentError::new(ErrorCode::BudgetExceeded, "File withdrawal revision exhausted"))?;
            let operation_id = file_versions::token();
            tx.execute(
                "INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,restore_operation_id,revision) VALUES (?1,?2,?3,NULL,?4) ON CONFLICT(object_key) DO UPDATE SET withdrawn_at=excluded.withdrawn_at,restore_operation_id=NULL,revision=excluded.revision",
                params![key, created.operation_id, Utc::now().to_rfc3339(), revision],
            ).map_err(io_error)?;
            for original in &group.operations {
                let changed = tx.execute(
                    "UPDATE agent_operation_receipts SET undo_state='undone',undo_operation_id=?1 WHERE operation_id=?2 AND undo_state='available' AND undo_operation_id IS NULL",
                    params![operation_id, original.operation_id],
                ).map_err(io_error)?;
                if changed != 1 { return Err(conflict()); }
            }
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='source_index_snapshots' AND type='table')",
                [], |r| r.get(0),
            ).map_err(io_error)?;
            if exists {
                tx.execute("DELETE FROM source_index_snapshots WHERE object_key=?1", [&key]).map_err(io_error)?;
            }
            tx.execute(
                "UPDATE agent_jobs SET state='cancelled',error=NULL WHERE kind='extract' AND dedupe_key=?1 AND state IN ('queued','running')",
                [format!("source-index:{key}")],
            ).map_err(io_error)?;
            tx.execute("UPDATE projects SET updated_at=?1 WHERE id=?2", params![Utc::now().to_rfc3339(), target.project_id]).map_err(io_error)?;
            let result = RecordWithdrawalResult {
                operation_id,
                creation_operation_id: created.operation_id.clone(),
                object: created.object.clone(),
                withdrawn: true,
                revision: revision as u64,
            };
            Ok((result, Some(OperationChange {
                object_key: key,
                scope: created.object.scope.clone(),
                revision: format!("withdrawal:{revision}:withdrawn"),
            })))
        },
    )?;
    // The native visibility hook has finalized this receipt. Attach the group
    // baseline in the same writer transaction for durable restore and replay.
    let (tail_hash, _) = registered_version(
        tx,
        &tail.object,
        tail.after_snapshot_ref.as_deref().ok_or_else(conflict)?,
        tail.after_revision.ok_or_else(conflict)?,
    )?;
    let metadata = agent_file_creation_metadata(tx, file_id(&tail.object)?)?;
    let context = json!({
        "recovery": "file.creation_undo",
        "creationOperationId": created.operation_id,
        "originalOperationIds": ids,
        "tailOperationId": tail.operation_id,
        "tailVersionNumber": tail.after_revision,
        "tailVersionId": tail.after_snapshot_ref,
        "tailBodyHash": tail_hash,
        "tailMetadata": metadata,
        "withdrawn": true,
        "withdrawalRevision": result.revision,
    });
    let changed = tx.execute(
        "UPDATE agent_operation_receipts SET output_context_json=?1,before_revision=?2,after_revision=?2,before_snapshot_ref=?3,after_snapshot_ref=?3 WHERE operation_id=?4 AND operation='file.withdraw'",
        params![encode(&context)?, tail.after_revision.map(|n| n as i64), tail.after_snapshot_ref, result.operation_id],
    ).map_err(io_error)?;
    if changed != 1 {
        return Err(conflict());
    }
    Ok(result)
}

fn chain_ids(request_id: &str) -> AgentResult<Option<(&str, &str)>> {
    let Some(suffix) = request_id.strip_prefix(FILE_CHAIN_UNDO_REQUEST_PREFIX) else {
        return Ok(None);
    };
    let (first, last) = suffix.split_once(':').ok_or_else(conflict)?;
    let valid = |id: &str| {
        id.len() == 32
            && id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    if !valid(first) || !valid(last) {
        return Err(conflict());
    }
    Ok(Some((first, last)))
}

/// Rebuild the original chain from its actual receipt insertion sequence.
/// This remains available to native journal settlement without another ledger.
fn chain(conn: &Connection, first_id: &str, last_id: &str) -> AgentResult<Vec<OperationEntry>> {
    let (first, _) = read_entry(conn, first_id)?;
    let (last, _) = read_entry(conn, last_id)?;
    file_id(&first.object)?;
    if first.object != last.object || first.run_id.is_none() || first.run_id != last.run_id {
        return Err(conflict());
    }
    let sequence = |id: &str| {
        conn.query_row(
            "SELECT rowid FROM agent_operation_receipts WHERE operation_id=?1",
            [id],
            |r| r.get::<_, i64>(0),
        )
        .map_err(io_error)
    };
    let first_row = sequence(first_id)?;
    let last_row = sequence(last_id)?;
    if last_row < first_row {
        return Err(conflict());
    }
    let object = serde_json::to_value(&first.object).map_err(|_| conflict())?;
    let mut stmt = conn.prepare("SELECT operation_id,request_id,output_context_json FROM agent_operation_receipts WHERE state='committed' AND operation_id IS NOT NULL AND rowid BETWEEN ?1 AND ?2 AND json_extract(target_ref_json,'$.workspaceId')=?3 AND json_extract(target_ref_json,'$.kind')='file' AND json_extract(target_ref_json,'$.id')=?4 AND json_extract(target_ref_json,'$.scope.kind')='project' AND json_extract(target_ref_json,'$.scope.projectId')=?5 ORDER BY rowid").map_err(io_error)?;
    let rows = stmt
        .query_map(
            params![
                first_row,
                last_row,
                first.object.workspace_id,
                first.object.id,
                object["scope"]["projectId"].as_i64()
            ],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(io_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(io_error)?;
    let mut operations: Vec<OperationEntry> = Vec::new();
    for (id, request_id, raw_context) in rows {
        let context: Value = decode(&raw_context)?;
        if context["recovery"].is_string()
            || request_id.starts_with(FILE_UNDO_REQUEST_PREFIX)
            || request_id.starts_with(FILE_CHAIN_UNDO_REQUEST_PREFIX)
        {
            return Err(conflict());
        }
        let (entry, _) = read_entry(conn, &id)?;
        if entry.kind != "file.version.commit"
            || entry.object != first.object
            || entry.run_id != first.run_id
        {
            return Err(conflict());
        }
        if entry.before_revision == entry.after_revision && entry.undo_state == "unavailable" {
            continue;
        }
        if !matches!(entry.undo_state.as_str(), "available" | "undone")
            || entry.before_revision.and_then(|v| v.checked_add(1)) != entry.after_revision
        {
            return Err(conflict());
        }
        let before = entry.before_snapshot_ref.as_deref().ok_or_else(conflict)?;
        let after = entry.after_snapshot_ref.as_deref().ok_or_else(conflict)?;
        registered_version(
            conn,
            &entry.object,
            before,
            entry.before_revision.ok_or_else(conflict)?,
        )?;
        let (hash, _) = registered_version(
            conn,
            &entry.object,
            after,
            entry.after_revision.ok_or_else(conflict)?,
        )?;
        let result: CommittedVersion = previous(conn, &id)?;
        if result.no_change
            || result.document_id != file_id(&entry.object)?
            || u64::try_from(result.version_number).ok() != entry.after_revision
            || result.content_hash != hash
            || context["afterBodyHash"].as_str() != Some(hash.as_str())
        {
            return Err(conflict());
        }
        if let Some(previous) = operations.last() {
            if previous.after_revision != entry.before_revision
                || previous.after_snapshot_ref != entry.before_snapshot_ref
            {
                return Err(conflict());
            }
        }
        operations.push(entry);
    }
    if operations.first().map(|e| e.operation_id.as_str()) != Some(first_id)
        || operations.last().map(|e| e.operation_id.as_str()) != Some(last_id)
    {
        return Err(conflict());
    }
    Ok(operations)
}

fn authorize_chain(
    conn: &Connection,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    operations: &[OperationEntry],
) -> AgentResult<()> {
    for original in operations {
        let (_, caller) = read_entry(conn, &original.operation_id)?;
        authorize(request, binding, original, &caller, "operation.undo")?;
        original_authority(conn, request, binding, original)?;
    }
    let first = operations.first().ok_or_else(conflict)?;
    let undone = first.undo_operation_id.as_deref();
    if undone.is_some() != (first.undo_state == "undone")
        || operations
            .iter()
            .any(|e| e.undo_operation_id.as_deref() != undone || e.undo_state != first.undo_state)
    {
        return Err(conflict());
    }
    if undone.is_none() {
        let last = operations.last().ok_or_else(conflict)?;
        baseline(conn, last)?;
        let raw: String = conn
            .query_row(
                "SELECT output_context_json FROM agent_operation_receipts WHERE operation_id=?1",
                [&last.operation_id],
                |r| r.get(0),
            )
            .map_err(io_error)?;
        let context: Value = decode(&raw)?;
        if context["afterMetadata"] != agent_file_creation_metadata(conn, file_id(&last.object)?)? {
            return Err(conflict());
        }
    }
    Ok(())
}

impl Database {
    pub(crate) fn agent_file_undo_group_prepare(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &OperationUndoBatchInput,
    ) -> AgentResult<(Vec<OperationEntry>, Option<FileUndoResult>)> {
        let plan = self.agent_operation_undo_batch_plan(request, binding, input)?;
        if plan.groups.len() != 1 {
            return Err(conflict());
        }
        let group = &plan.groups[0];
        if group.object.kind != ObjectKind::File
            || group.creation().is_some()
            || !matches!(
                group.undo_state,
                OperationBatchUndoState::Available | OperationBatchUndoState::Undone
            )
        {
            return Err(conflict());
        }
        let operations = chain(
            &self.conn,
            &group.first().operation_id,
            &group.last().operation_id,
        )?;
        if operations
            .iter()
            .map(|e| &e.operation_id)
            .ne(group.operations.iter().map(|e| &e.operation_id))
        {
            return Err(conflict());
        }
        authorize_chain(&self.conn, request, binding, &operations)?;
        let first = operations.first().ok_or_else(conflict)?;
        self.file_version_recovery_target(request, binding, &first.object)?;
        if let Some(undo) = &first.undo_operation_id {
            return Ok((
                operations.clone(),
                Some(self.agent_file_undo_result(first, undo)?),
            ));
        }
        if let Some(conflict) = group.conflicts.first() {
            return Err(conflict.error.clone());
        }
        let last = operations.last().ok_or_else(conflict)?;
        let target = self.file_version_recovery_target(request, binding, &last.object)?;
        let hash = baseline(&self.conn, last)?;
        if file_versions::checksum(Path::new(&target.managed_path)).map_err(|_| conflict())? != hash
        {
            return Err(AgentError::new(
                ErrorCode::FileChangedUnregistered,
                "File bytes changed outside the registered version chain",
            ));
        }
        Ok((operations, None))
    }
    pub(crate) fn agent_file_undo_group_restore_input(
        &self,
        first: &OperationEntry,
        last: &OperationEntry,
    ) -> AgentResult<FileVersionRestore> {
        let hash = baseline(&self.conn, last)?;
        let version_id = first.before_snapshot_ref.clone().ok_or_else(conflict)?;
        registered_version(
            &self.conn,
            &first.object,
            &version_id,
            first.before_revision.ok_or_else(conflict)?,
        )?;
        Ok(FileVersionRestore {
            object: first.object.clone(),
            version_id,
            expected_version_number: u32::try_from(last.after_revision.ok_or_else(conflict)?)
                .map_err(|_| conflict())?,
            expected_content_hash: hash,
        })
    }
    pub(crate) fn agent_file_undo_prepare(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &OperationUndoInput,
    ) -> AgentResult<(OperationEntry, Option<FileUndoResult>)> {
        self.operation_binding(binding)?;
        let entry = entry(
            &self.conn,
            request,
            binding,
            &input.operation_id,
            "operation.undo",
        )?;
        if entry.kind != "file.version.commit"
            || entry.after_revision != Some(input.expected_head_revision)
            || input.expected_head_revision == 0
            || !matches!(entry.undo_state.as_str(), "available" | "undone")
            || entry.before_revision == entry.after_revision
        {
            return Err(conflict());
        }
        original_authority(&self.conn, request, binding, &entry)?;
        let target = self.file_version_recovery_target(request, binding, &entry.object)?;
        if let Some(op) = &entry.undo_operation_id {
            return Ok((
                entry.clone(),
                Some(self.agent_file_undo_result(&entry, op)?),
            ));
        }
        let hash = baseline(&self.conn, &entry)?;
        if file_versions::checksum(Path::new(&target.managed_path)).map_err(|_| conflict())? != hash
        {
            return Err(AgentError::new(
                ErrorCode::FileChangedUnregistered,
                "File bytes changed outside the registered version chain",
            ));
        }
        Ok((entry, None))
    }
    pub(crate) fn agent_file_undo_restore_input(
        &self,
        entry: &OperationEntry,
    ) -> AgentResult<FileVersionRestore> {
        let hash = baseline(&self.conn, entry)?;
        let version = entry.before_snapshot_ref.clone().ok_or_else(conflict)?;
        registered_version(
            &self.conn,
            &entry.object,
            &version,
            entry.before_revision.ok_or_else(conflict)?,
        )?;
        Ok(FileVersionRestore {
            object: entry.object.clone(),
            version_id: version,
            expected_version_number: u32::try_from(entry.after_revision.ok_or_else(conflict)?)
                .map_err(|_| conflict())?,
            expected_content_hash: hash,
        })
    }
    pub(crate) fn agent_file_undo_result(
        &self,
        original: &OperationEntry,
        undo_id: &str,
    ) -> AgentResult<FileUndoResult> {
        let (saved, _) = read_entry(&self.conn, undo_id)?;
        let receipt: CommittedVersion = previous(&self.conn, undo_id)?;
        let context: String = self
            .conn
            .query_row(
                "SELECT output_context_json FROM agent_operation_receipts WHERE operation_id=?1",
                [undo_id],
                |r| r.get(0),
            )
            .map_err(io_error)?;
        let context: Value = decode(&context)?;
        let group_member = context["recovery"] == "file.chain_undo"
            && context["originalOperationIds"]
                .as_array()
                .is_some_and(|ids| {
                    ids.iter()
                        .any(|id| id.as_str() == Some(original.operation_id.as_str()))
                });
        if saved.object != original.object
            || !group_member
                && (saved.before_revision != original.after_revision || receipt.no_change)
            || u64::try_from(receipt.version_number).ok() != saved.after_revision
        {
            return Err(conflict());
        }
        Ok(FileUndoResult {
            operation_id: saved.operation_id,
            original_operation_id: original.operation_id.clone(),
            object: saved.object,
            before_version_number: u32::try_from(saved.before_revision.ok_or_else(conflict)?)
                .map_err(|_| conflict())?,
            after_version_number: u32::try_from(saved.after_revision.ok_or_else(conflict)?)
                .map_err(|_| conflict())?,
            before_version_id: saved.before_snapshot_ref.ok_or_else(conflict)?,
            after_version_id: saved.after_snapshot_ref.ok_or_else(conflict)?,
            content_hash: receipt.content_hash,
        })
    }
    pub(crate) fn agent_file_creation_withdraw(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &RecordWithdrawalInput,
    ) -> AgentResult<RecordWithdrawalResult> {
        self.file_creation_visibility(request, binding, input, None)
    }
    pub(crate) fn agent_file_creation_restore(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &RecordRestoreInput,
    ) -> AgentResult<RecordWithdrawalResult> {
        self.file_creation_visibility(
            request,
            binding,
            &RecordWithdrawalInput {
                creation_operation_id: input.creation_operation_id.clone(),
            },
            Some(input.expected_withdrawal_revision),
        )
    }
    fn file_creation_visibility(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &RecordWithdrawalInput,
        expected: Option<u64>,
    ) -> AgentResult<RecordWithdrawalResult> {
        self.operation_binding(binding)?;
        let withdraw = expected.is_none();
        let permission = if withdraw {
            "operation.undo"
        } else {
            "operation.restore_created"
        };
        let operation = if withdraw {
            "file.withdraw"
        } else {
            "file.restore_created"
        };
        let created = entry(
            &self.conn,
            request,
            binding,
            &input.creation_operation_id,
            permission,
        )?;
        if created.kind != "file.create"
            || !matches!(created.undo_state.as_str(), "available" | "undone")
        {
            return Err(conflict());
        }
        original_authority(&self.conn, request, binding, &created)?;
        self.file_version_recovery_target_hidden(request, binding, &created.object, permission)?;
        let id = file_id(&created.object)?;
        let _locks = self.file_recovery_write_locks(id).map_err(|_| conflict())?;
        self.agent_atomic_operation(&request.caller.key(),&request.request_id,operation,&(input,expected),|tx|{
 let created=entry(tx,request,binding,&input.creation_operation_id,permission)?;original_authority(tx,request,binding,&created)?;
 let target=self.file_version_recovery_target_hidden(request,binding,&created.object,permission)?;
 let key=created.object.key()?;
 let state:Option<(String,bool,Option<String>,i64)>=tx.query_row("SELECT creation_operation_id,withdrawn_at IS NOT NULL,restore_operation_id,revision FROM agent_object_withdrawals WHERE object_key=?1",[&key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(io_error)?;
 if state.as_ref().is_some_and(|row|row.0!=created.operation_id){return Err(conflict());}
 if withdraw {if let Some(previous_id)=&created.undo_operation_id{return Ok((previous(tx,previous_id)?,None));}if created.undo_state!="available"{return Err(conflict());}}
 else {let row=state.as_ref().ok_or_else(conflict)?;if let Some(previous_id)=&row.2{if expected!=u64::try_from(row.3).ok().and_then(|value|value.checked_sub(1)){return Err(conflict());}return Ok((previous(tx,previous_id)?,None));}if !row.1||expected!=u64::try_from(row.3).ok(){return Err(conflict());}}
 let (hash,_tail_version)=visibility_baseline(tx,&created)?;
 let path=PathBuf::from(&target.managed_path);file_versions::relative(&self.workspace_root,&path).map_err(|_|conflict())?;
 if file_versions::checksum(&path).map_err(|_|conflict())?!=hash{return Err(AgentError::new(ErrorCode::FileChangedUnregistered,"File bytes changed outside the registered version chain"));}
 if withdraw{no_incoming(tx,&created.object)?;}
 let revision=state.as_ref().map_or(Some(1),|row|row.3.checked_add(1)).filter(|value|*value>0).ok_or_else(||AgentError::new(ErrorCode::BudgetExceeded,"File withdrawal revision exhausted"))?;
 let operation_id=file_versions::token();
 tx.execute("INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,restore_operation_id,revision) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(object_key) DO UPDATE SET withdrawn_at=excluded.withdrawn_at,restore_operation_id=excluded.restore_operation_id,revision=excluded.revision",params![key,created.operation_id,if withdraw{Some(Utc::now().to_rfc3339())}else{None},if withdraw{None}else{Some(&operation_id)},revision]).map_err(io_error)?;
 if withdraw{let changed=tx.execute("UPDATE agent_operation_receipts SET undo_state='undone',undo_operation_id=?1 WHERE operation_id=?2 AND undo_state='available' AND undo_operation_id IS NULL",params![operation_id,created.operation_id]).map_err(io_error)?;if changed!=1{return Err(conflict());}
 let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='source_index_snapshots' AND type='table')",[],|r|r.get(0)).map_err(io_error)?;if exists{tx.execute("DELETE FROM source_index_snapshots WHERE object_key=?1",[&key]).map_err(io_error)?;}
 tx.execute("UPDATE agent_jobs SET state='cancelled',error=NULL WHERE kind='extract' AND dedupe_key=?1 AND state IN ('queued','running')",[format!("source-index:{key}")]).map_err(io_error)?;}
 tx.execute("UPDATE projects SET updated_at=?1 WHERE id=?2",params![Utc::now().to_rfc3339(),target.project_id]).map_err(io_error)?;
 let result=RecordWithdrawalResult{operation_id,creation_operation_id:created.operation_id,object:created.object.clone(),withdrawn:withdraw,revision:revision as u64};Ok((result,Some(OperationChange{object_key:key,scope:created.object.scope,revision:format!("withdrawal:{revision}:{}",if withdraw{"withdrawn"}else{"visible"})})))
 })
    }
}
/// Kernel-only authority: the stable request is useful only with its real
/// original receipt and exact derived restore payload. It cannot restore an
/// arbitrary version by supplying the prefix.
pub(crate) fn file_undo_authorize_target(
    conn: &Connection,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    object: &ObjectRef,
) -> AgentResult<bool> {
    if let Some((first, last)) = chain_ids(&request.request_id)? {
        let operations = chain(conn, first, last)?;
        if operations.first().ok_or_else(conflict)?.object != *object {
            return Err(conflict());
        }
        authorize_chain(conn, request, binding, &operations)?;
        return Ok(true);
    }
    let Some(id) = request.request_id.strip_prefix(FILE_UNDO_REQUEST_PREFIX) else {
        return Ok(false);
    };
    let original = entry(conn, request, binding, id, "operation.undo")?;
    if original.kind != "file.version.commit"
        || original.object != *object
        || !matches!(original.undo_state.as_str(), "available" | "undone")
        || original.before_revision == original.after_revision
    {
        return Err(conflict());
    }
    original_authority(conn, request, binding, &original)?;
    Ok(true)
}
pub(crate) fn file_undo_validate_restore(
    conn: &Connection,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    input: &FileVersionRestore,
) -> AgentResult<()> {
    if let Some((first_id, last_id)) = chain_ids(&request.request_id)? {
        file_undo_authorize_target(conn, request, binding, &input.object)?;
        let operations = chain(conn, first_id, last_id)?;
        let first = operations.first().ok_or_else(conflict)?;
        let last = operations.last().ok_or_else(conflict)?;
        let (hash, _) = registered_version(
            conn,
            &last.object,
            last.after_snapshot_ref.as_deref().ok_or_else(conflict)?,
            last.after_revision.ok_or_else(conflict)?,
        )?;
        if first.before_snapshot_ref.as_deref() != Some(input.version_id.as_str())
            || last.after_revision != Some(u64::from(input.expected_version_number))
            || hash != input.expected_content_hash
        {
            return Err(conflict());
        }
        return Ok(());
    }
    let Some(id) = request.request_id.strip_prefix(FILE_UNDO_REQUEST_PREFIX) else {
        return Ok(());
    };
    file_undo_authorize_target(conn, request, binding, &input.object)?;
    let (original, _) = read_entry(conn, id)?;
    let (after_hash, _) = registered_version(
        conn,
        &original.object,
        original
            .after_snapshot_ref
            .as_deref()
            .ok_or_else(conflict)?,
        original.after_revision.ok_or_else(conflict)?,
    )?;
    if original.before_snapshot_ref.as_deref() != Some(input.version_id.as_str())
        || original.after_revision != Some(u64::from(input.expected_version_number))
        || after_hash != input.expected_content_hash
    {
        return Err(conflict());
    }
    Ok(())
}
/// Called inside native receipt transaction before the outbox. Any failure
/// rolls back the ledger, CAS/version SQL and native journal-owned bytes.
pub(crate) fn agent_file_recovery_receipt_committed(
    tx: &Transaction<'_>,
    caller: &str,
    request_id: &str,
    operation: &str,
    result_json: &str,
) -> AgentResult<()> {
    if operation == "file.version.commit" {
        if let Some((first_id, last_id)) = chain_ids(request_id)? {
            let operations = chain(tx, first_id, last_id)?;
            let first = operations.first().ok_or_else(conflict)?;
            let last = operations.last().ok_or_else(conflict)?;
            if operations
                .iter()
                .any(|e| e.undo_state != "available" || e.undo_operation_id.is_some())
            {
                return Err(conflict());
            }
            let result: CommittedVersion = decode(result_json)?;
            let before_revision = first.before_revision.ok_or_else(conflict)?;
            let before_ref = first.before_snapshot_ref.as_deref().ok_or_else(conflict)?;
            let (before_hash, _) =
                registered_version(tx, &first.object, before_ref, before_revision)?;
            let tail_revision = last.after_revision.ok_or_else(conflict)?;
            let tail_ref = last.after_snapshot_ref.as_deref().ok_or_else(conflict)?;
            let (tail_hash, _) = registered_version(tx, &last.object, tail_ref, tail_revision)?;
            let expected_revision = if result.no_change {
                tail_revision
            } else {
                tail_revision.checked_add(1).ok_or_else(conflict)?
            };
            if result.document_id != file_id(&first.object)?
                || u64::try_from(result.version_number).ok() != Some(expected_revision)
                || result.content_hash != before_hash
                || result.no_change != (before_hash == tail_hash)
            {
                return Err(conflict());
            }
            let after_id: i64 = tx
                .query_row(
                    "SELECT id FROM document_versions WHERE document_id=?1 AND version_number=?2",
                    params![result.document_id, result.version_number],
                    |r| r.get(0),
                )
                .map_err(io_error)?;
            let (registered_hash, _) =
                registered_version(tx, &first.object, &after_id.to_string(), expected_revision)?;
            if registered_hash != result.content_hash {
                return Err(conflict());
            }
            // The ordinary native receipt hook has allocated this committed
            // operation identity in the same transaction, including no-change.
            let undo_id: String = tx.query_row("SELECT operation_id FROM agent_operation_receipts WHERE caller_id=?1 AND request_id=?2 AND operation=?3 AND state='committed' AND result_json=?4", params![caller,request_id,operation,result_json], |r| r.get(0)).map_err(io_error)?;
            for original in &operations {
                let changed = tx.execute("UPDATE agent_operation_receipts SET undo_state='undone',undo_operation_id=?1 WHERE operation_id=?2 AND undo_state='available' AND undo_operation_id IS NULL", params![undo_id,original.operation_id]).map_err(io_error)?;
                if changed != 1 {
                    return Err(conflict());
                }
            }
            let ids: Vec<&str> = operations.iter().map(|e| e.operation_id.as_str()).collect();
            let context = json!({"recovery":"file.chain_undo","originalOperationIds":ids,"afterBodyHash":result.content_hash,"noChange":result.no_change});
            let changed = tx.execute("UPDATE agent_operation_receipts SET run_id=?1,target_ref_json=?2,before_revision=?3,after_revision=?4,before_snapshot_ref=?5,after_snapshot_ref=?6,output_context_json=?7,undo_state='unavailable' WHERE operation_id=?8 AND caller_id=?9 AND request_id=?10 AND operation=?11", params![first.run_id,encode(&first.object)?,tail_revision as i64,result.version_number,tail_ref,after_id.to_string(),encode(&context)?,undo_id,caller,request_id,operation]).map_err(io_error)?;
            if changed != 1 {
                return Err(AgentError::new(
                    ErrorCode::IoFailed,
                    "File group undo receipt could not be finalized",
                ));
            }
            return Ok(());
        }
        let Some(original_id) = request_id.strip_prefix(FILE_UNDO_REQUEST_PREFIX) else {
            return Ok(());
        };
        let (original, _) = read_entry(tx, original_id)?;
        let result: CommittedVersion = decode(result_json)?;
        if original.kind != "file.version.commit"
            || original.undo_state != "available"
            || result.no_change
            || result.document_id != file_id(&original.object)?
            || Some(result.version_number as u64)
                != original.after_revision.and_then(|v| v.checked_add(1))
        {
            return Err(conflict());
        }
        let before_ref = original
            .before_snapshot_ref
            .as_deref()
            .ok_or_else(conflict)?;
        let (before_hash, _) = registered_version(
            tx,
            &original.object,
            before_ref,
            original.before_revision.ok_or_else(conflict)?,
        )?;
        if result.content_hash != before_hash {
            return Err(conflict());
        }
        let after_id: i64 = tx
            .query_row(
                "SELECT id FROM document_versions WHERE document_id=?1 AND version_number=?2",
                params![result.document_id, result.version_number],
                |r| r.get(0),
            )
            .map_err(io_error)?;
        let op = file_versions::token();
        let changed=tx.execute("UPDATE agent_operation_receipts SET undo_state='undone',undo_operation_id=?1 WHERE operation_id=?2 AND undo_state='available' AND undo_operation_id IS NULL",params![op,original_id]).map_err(io_error)?;
        if changed != 1 {
            return Err(conflict());
        }
        let changed=tx.execute("UPDATE agent_operation_receipts SET operation_id=?1,run_id=?2,target_ref_json=?3,before_revision=?4,after_revision=?5,before_snapshot_ref=?6,after_snapshot_ref=?7,output_context_json=?8,undo_state='unavailable' WHERE caller_id=?9 AND request_id=?10 AND operation=?11",params![op,original.run_id,encode(&original.object)?,original.after_revision.map(|v|v as i64),result.version_number,original.after_snapshot_ref,after_id.to_string(),encode(&json!({"originalOperationId":original_id,"afterBodyHash":result.content_hash,"recovery":"file.undo"}))?,caller,request_id,operation]).map_err(io_error)?;
        if changed != 1 {
            return Err(AgentError::new(
                ErrorCode::IoFailed,
                "File undo receipt could not be finalized",
            ));
        }
    } else if matches!(operation, "file.withdraw" | "file.restore_created") {
        let result: RecordWithdrawalResult = decode(result_json)?;
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
        let changed=tx.execute("UPDATE agent_operation_receipts SET operation_id=?1,run_id=(SELECT run_id FROM agent_operation_receipts WHERE operation_id=?2),target_ref_json=?3,before_revision=(SELECT after_revision FROM agent_operation_receipts WHERE operation_id=?2),after_revision=(SELECT after_revision FROM agent_operation_receipts WHERE operation_id=?2),before_snapshot_ref=(SELECT after_snapshot_ref FROM agent_operation_receipts WHERE operation_id=?2),after_snapshot_ref=(SELECT after_snapshot_ref FROM agent_operation_receipts WHERE operation_id=?2),output_context_json=?4,undo_state='unavailable' WHERE caller_id=?5 AND request_id=?6 AND operation=?7",params![result.operation_id,result.creation_operation_id,encode(&result.object)?,encode(&json!({"creationOperationId":result.creation_operation_id,"withdrawn":result.withdrawn,"withdrawalRevision":result.revision}))?,caller,request_id,operation]).map_err(io_error)?;
        if changed != 1 {
            return Err(AgentError::new(
                ErrorCode::IoFailed,
                "File visibility receipt could not be finalized",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "agent_file_undo_tests.rs"]
mod tests;
