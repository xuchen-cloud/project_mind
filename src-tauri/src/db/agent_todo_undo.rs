//! Todo recovery shares native snapshots, the operation receipt and visibility ledger.
//! No business row or immutable snapshot is deleted when a creation is withdrawn.
use super::{
    agent_operations::{io_error, OperationChange},
    agent_record_undo::{authorize, read_entry},
    agent_record_withdrawals::{RecordRestoreInput, RecordWithdrawalInput, RecordWithdrawalResult},
    todo_revisions::{self, TodoSnapshot},
    Database,
};
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
        operation_batches::{OperationBatchUndoState, OperationUndoBatchInput, OperationUndoGroup},
        operations::{OperationEntry, OperationUndoInput, TodoUndoResult},
    },
    models::TodoScope,
};
use chrono::Utc;
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};

/// The formal schema31 migration applies this inside its existing savepoint.
pub(super) const AGENT_TODO_VISIBILITY_SQL: &str = r#"
CREATE VIEW agent_visible_todos AS
 SELECT t.* FROM todos t WHERE NOT EXISTS (
  SELECT 1 FROM agent_object_withdrawals w WHERE w.withdrawn_at IS NOT NULL
   AND w.object_key GLOB '*/'||(CASE t.scope WHEN 'workspace' THEN 'workspace' ELSE 'project:'||t.project_id END)||'/todo/'||t.id
 );
"#;

fn conflict() -> AgentError {
    AgentError::new(
        ErrorCode::UndoConflict,
        "Todo changed or is now referenced; its later work will be retained",
    )
}
fn decode<T: DeserializeOwned>(raw: &str) -> AgentResult<T> {
    serde_json::from_str(raw)
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Todo recovery receipt is damaged"))
}
fn encode(value: &impl Serialize) -> AgentResult<String> {
    serde_json::to_string(value)
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot encode Todo recovery receipt"))
}
fn random_id() -> String {
    let mut bytes = [0; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn todo_id(object: &ObjectRef) -> AgentResult<i64> {
    object.key()?;
    if object.kind != ObjectKind::Todo {
        return Err(conflict());
    }
    object
        .id
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0 && id.to_string() == object.id)
        .ok_or_else(conflict)
}
fn snapshot_scope(snapshot: &TodoSnapshot) -> AgentResult<Scope> {
    match (snapshot.scope, snapshot.project_id) {
        (TodoScope::Workspace, None) => Ok(Scope::Workspace),
        (TodoScope::Project, Some(project_id)) if project_id > 0 => {
            Ok(Scope::Project { project_id })
        }
        _ => Err(conflict()),
    }
}
fn retained(conn: &Connection, id: &str, todo_id: i64, revision: u64) -> AgentResult<TodoSnapshot> {
    let snapshot = todo_revisions::retained_snapshot(conn, id)?;
    let identity: (i64, i64) = conn
        .query_row(
            "SELECT todo_id,revision FROM todo_revision_snapshots WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(io_error)?;
    if identity != (todo_id, i64::try_from(revision).map_err(|_| conflict())?) {
        return Err(conflict());
    }
    Ok(snapshot)
}

/// Call after resolving and authorizing the actual owner, as with Record visibility.
pub(super) fn require_todo_visible(conn: &Connection, todo_id: i64) -> AgentResult<()> {
    if todo_id <= 0 {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Todo ID must be positive",
        ));
    }
    let scope: (String, Option<i64>) = conn
        .query_row(
            "SELECT scope,project_id FROM todos WHERE id=?1",
            [todo_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(io_error)?
        .ok_or_else(|| AgentError::new(ErrorCode::NotFound, "Todo is no longer present"))?;
    let scope = match (scope.0.as_str(), scope.1) {
        ("workspace", None) => Scope::Workspace,
        ("project", Some(project_id)) if project_id > 0 => Scope::Project { project_id },
        _ => {
            return Err(AgentError::new(
                ErrorCode::IoFailed,
                "Todo ownership is damaged",
            ))
        }
    };
    let state: Option<(String, String, i64)> = conn.query_row("SELECT object_key,creation_operation_id,revision FROM agent_object_withdrawals WHERE object_key LIKE ?1 AND withdrawn_at IS NOT NULL", [format!("%/{}/todo/{todo_id}", scope.key())], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional().map_err(io_error)?;
    if let Some((key, creation, revision)) = state {
        return Err(AgentError::new(ErrorCode::ObjectWithdrawn, "Todo has been withdrawn; restore it to use its current contents").with_details(json!({"workspaceId":key.split('/').next(),"objectKey":key,"creationOperationId":creation,"withdrawalRevision":revision,"restoreAvailable":true})));
    }
    Ok(())
}

/// Receipt columns, its native result, the live head and actual business fields
/// must agree. Same-body manual writes still conflict on revision/snapshot ID.
fn baseline(
    conn: &Connection,
    entry: &OperationEntry,
) -> AgentResult<(todo_revisions::TodoRevisionHead, TodoSnapshot)> {
    let id = todo_id(&entry.object)?;
    let revision = entry.after_revision.ok_or_else(conflict)?;
    let after = entry.after_snapshot_ref.as_deref().ok_or_else(conflict)?;
    let (context, result): (String, String) = conn.query_row("SELECT output_context_json,result_json FROM agent_operation_receipts WHERE operation_id=?1", [&entry.operation_id], |row| Ok((row.get(0)?, row.get(1)?))).map_err(io_error)?;
    let context: Value = decode(&context)?;
    let result: Value = decode(&result)?;
    let object: ObjectRef =
        serde_json::from_value(result["object"].clone()).map_err(|_| conflict())?;
    let hash = context["afterBodyHash"].as_str().ok_or_else(conflict)?;
    if object != entry.object
        || result["afterRevision"].as_u64() != Some(revision)
        || result["afterSnapshotRef"].as_str() != Some(after)
        || result["bodyHash"].as_str() != Some(hash)
    {
        return Err(conflict());
    }
    let head = todo_revisions::head(conn, id)?;
    if head.revision != revision || head.snapshot_ref != after || head.body_hash != hash {
        return Err(conflict());
    }
    let actual = todo_revisions::snapshot(conn, id)?;
    let snapshot = retained(conn, after, id, revision)?;
    if actual != snapshot || snapshot_scope(&actual)? != entry.object.scope {
        return Err(conflict());
    }
    Ok((head, snapshot))
}
fn authorize_entry(
    conn: &Connection,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    id: &str,
    permission: &str,
) -> AgentResult<OperationEntry> {
    let (entry, caller) = read_entry(conn, id)?;
    authorize(request, binding, &entry, &caller, permission)?;
    super::agent_record_undo::receipt_scope_active(conn, &entry.object.scope)?;
    todo_id(&entry.object)?;
    Ok(entry)
}
fn previous<T: DeserializeOwned>(conn: &Connection, id: &str, operation: &str) -> AgentResult<T> {
    let result: String = conn.query_row("SELECT result_json FROM agent_operation_receipts WHERE operation_id=?1 AND operation=?2 AND state='committed'", params![id, operation], |row| row.get(0)).optional().map_err(io_error)?.ok_or_else(|| AgentError::new(ErrorCode::IoFailed, "Todo recovery receipt is missing"))?;
    decode(&result)
}

/// Invalid IDs, foreign runs and scope are checked by the shared planner before
/// interpreting any receipt state. This executor intentionally excludes creation.
fn todo_undo_group_plan(
    conn: &Connection,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    input: &OperationUndoBatchInput,
) -> AgentResult<OperationUndoGroup> {
    let mut planned = super::agent_operation_batches::plan(conn, request, binding, input)?;
    if planned.groups.len() != 1 || !planned.excluded_no_change.is_empty() {
        return Err(conflict());
    }
    let group = planned.groups.remove(0);
    if group.object.kind != ObjectKind::Todo
        || group.object_key != group.object.key()?
        || group
            .operations
            .iter()
            .any(|entry| entry.kind != "todo.update")
    {
        return Err(conflict());
    }
    Ok(group)
}

/// Durable success is read before live-head/structural checks: subsequent native
/// work cannot invalidate an already committed undo result. Mixed states conflict.
fn todo_undo_group_previous(
    conn: &Connection,
    group: &OperationUndoGroup,
) -> AgentResult<Option<TodoUndoResult>> {
    if group.undo_state == OperationBatchUndoState::Undone {
        let id = group
            .first()
            .undo_operation_id
            .as_deref()
            .ok_or_else(conflict)?;
        if group
            .operations
            .iter()
            .any(|entry| entry.undo_operation_id.as_deref() != Some(id))
        {
            return Err(conflict());
        }
        let result: TodoUndoResult = previous(conn, id, "todo.undo")?;
        if result.object != group.object {
            return Err(conflict());
        }
        Ok(Some(result))
    } else if group.undo_state != OperationBatchUndoState::Available {
        Err(conflict())
    } else {
        Ok(None)
    }
}

fn require_no_incoming(conn: &Connection, object: &ObjectRef) -> AgentResult<()> {
    let id = todo_id(object)?;
    let key = object.key()?;
    let edges: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM content_reference_edges WHERE target_object_key=?1 AND source_object_key!=?1)", [&key], |row| row.get(0)).map_err(io_error)?;
    if edges {
        return Err(conflict());
    }
    let mut statement = conn.prepare("SELECT id AS owner,content FROM todos UNION ALL SELECT todo_id,content FROM todo_progresses UNION ALL SELECT NULL,summary_markdown FROM projects UNION ALL SELECT NULL,content_markdown FROM notes UNION ALL SELECT NULL,content_markdown FROM workspace_notes").map_err(io_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(io_error)?;
    for row in rows {
        let (owner, content) = row.map_err(io_error)?;
        if owner == Some(id) {
            continue;
        }
        if super::parse_internal_reference_tokens(&content)
            .iter()
            .any(|(kind, target)| kind == "todo" && *target == id)
        {
            return Err(conflict());
        }
    }
    Ok(())
}

const CREATION_UNDO_PREFIX: &str = "creationundo:";

fn creation_group_id(group: &OperationUndoGroup) -> String {
    format!(
        "{CREATION_UNDO_PREFIX}{}:{}",
        group.first().operation_id,
        group.last().operation_id
    )
}

/// Check the complete original chain before any visibility change. The batch
/// coordinator checks incoming references against its whole selected set.
pub(super) fn creation_group_check(
    db: &Database,
    conn: &Connection,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    group: &OperationUndoGroup,
) -> AgentResult<Option<RecordWithdrawalResult>> {
    db.operation_binding(binding)?;
    let first = group.operations.first().ok_or_else(conflict)?;
    if group.object.kind != ObjectKind::Todo
        || first.kind != "todo.create"
        || group
            .operations
            .iter()
            .skip(1)
            .any(|entry| entry.kind != "todo.update")
        || group
            .operations
            .iter()
            .any(|entry| entry.object != group.object || entry.run_id != first.run_id)
    {
        return Err(conflict());
    }
    for entry in &group.operations {
        let actual = authorize_entry(
            conn,
            request,
            binding,
            &entry.operation_id,
            "operation.undo",
        )?;
        if actual.object != group.object
            || actual.run_id != first.run_id
            || actual.kind != entry.kind
            || actual.before_revision != entry.before_revision
            || actual.after_revision != entry.after_revision
            || actual.before_snapshot_ref != entry.before_snapshot_ref
            || actual.after_snapshot_ref != entry.after_snapshot_ref
        {
            return Err(conflict());
        }
    }
    if group.undo_state == OperationBatchUndoState::Undone {
        let inverse = first.undo_operation_id.as_deref().ok_or_else(conflict)?;
        if group
            .operations
            .iter()
            .any(|entry| entry.undo_operation_id.as_deref() != Some(inverse))
        {
            return Err(conflict());
        }
        let result: RecordWithdrawalResult = previous(conn, inverse, "todo.withdraw")?;
        if result.operation_id != inverse
            || result.creation_operation_id != first.operation_id
            || result.object != group.object
            || !result.withdrawn
        {
            return Err(conflict());
        }
        let context: String = conn
            .query_row(
                "SELECT output_context_json FROM agent_operation_receipts WHERE operation_id=?1",
                [inverse],
                |row| row.get(0),
            )
            .map_err(io_error)?;
        let context: Value = decode(&context)?;
        if let Some(ids) = context["originalOperationIds"].as_array() {
            let selected: Vec<&str> = group
                .operations
                .iter()
                .map(|entry| entry.operation_id.as_str())
                .collect();
            if ids
                .iter()
                .map(Value::as_str)
                .collect::<Option<Vec<_>>>()
                .as_deref()
                != Some(selected.as_slice())
            {
                return Err(conflict());
            }
        } else if group.operations.len() != 1 {
            return Err(conflict());
        }
        return Ok(Some(result));
    }
    if group.undo_state != OperationBatchUndoState::Available || !group.conflicts.is_empty() {
        return Err(conflict());
    }
    for (index, entry) in group.operations.iter().enumerate() {
        let revision = entry.after_revision.ok_or_else(conflict)?;
        let snapshot_ref = entry.after_snapshot_ref.as_deref().ok_or_else(conflict)?;
        retained(conn, snapshot_ref, todo_id(&group.object)?, revision)?;
        if index == 0 {
            if entry.before_revision.is_some() || entry.before_snapshot_ref.is_some() {
                return Err(conflict());
            }
        } else {
            let prior = &group.operations[index - 1];
            if entry.before_revision != prior.after_revision
                || entry.before_snapshot_ref != prior.after_snapshot_ref
            {
                return Err(conflict());
            }
            if entry
                .before_revision
                .and_then(|revision| revision.checked_add(1))
                != Some(revision)
            {
                return Err(conflict());
            }
        }
        let (context, result): (String, String) = conn.query_row("SELECT output_context_json,result_json FROM agent_operation_receipts WHERE operation_id=?1", [&entry.operation_id], |row| Ok((row.get(0)?, row.get(1)?))).map_err(io_error)?;
        let context: Value = decode(&context)?;
        let result: Value = decode(&result)?;
        if result["object"] != json!(entry.object)
            || result["afterRevision"].as_u64() != Some(revision)
            || result["afterSnapshotRef"].as_str() != Some(snapshot_ref)
            || result["bodyHash"] != context["afterBodyHash"]
            || !result["bodyHash"].is_string()
        {
            return Err(conflict());
        }
    }
    baseline(conn, group.last())?;
    require_todo_visible(conn, todo_id(&group.object)?)?;
    let existing: Option<String> = conn
        .query_row(
            "SELECT creation_operation_id FROM agent_object_withdrawals WHERE object_key=?1",
            [&group.object_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(io_error)?;
    if existing
        .as_ref()
        .is_some_and(|id| id != &first.operation_id)
    {
        return Err(conflict());
    }
    Ok(None)
}

/// Called inside the coordinator's reserved native transaction after all group
/// and incoming dependency checks. The atomic helper finalizes receipt/outbox.
pub(super) fn creation_group_apply(
    db: &Database,
    tx: &Transaction<'_>,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    group: &OperationUndoGroup,
) -> AgentResult<RecordWithdrawalResult> {
    let request_id = creation_group_id(group);
    let original_ids: Vec<&str> = group
        .operations
        .iter()
        .map(|entry| entry.operation_id.as_str())
        .collect();
    db.agent_atomic_operation_in_transaction(tx, &request.caller.key(), &request_id, "todo.withdraw", &original_ids, |tx| {
    if let Some(result) = creation_group_check(db, tx, request, binding, group)? { return Ok((result, None)); }
    let first = group.first();
    let key = group.object.key()?;
    let revision: i64 = tx.query_row("SELECT revision FROM agent_object_withdrawals WHERE object_key=?1", [&key], |row| row.get(0)).optional().map_err(io_error)?.unwrap_or(0);
    let revision = revision.checked_add(1).filter(|value| *value > 0).ok_or_else(|| AgentError::new(ErrorCode::BudgetExceeded, "Todo withdrawal revision exhausted"))?;
    let operation_id = random_id();
    tx.execute("INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,restore_operation_id,revision) VALUES (?1,?2,?3,NULL,?4) ON CONFLICT(object_key) DO UPDATE SET withdrawn_at=excluded.withdrawn_at,restore_operation_id=NULL,revision=excluded.revision", params![key,first.operation_id,Utc::now().to_rfc3339(),revision]).map_err(io_error)?;
    for entry in &group.operations {
        let changed = tx.execute("UPDATE agent_operation_receipts SET undo_state='undone',undo_operation_id=?1 WHERE operation_id=?2 AND undo_state='available' AND undo_operation_id IS NULL", params![operation_id,entry.operation_id]).map_err(io_error)?;
        if changed != 1 { return Err(conflict()); }
    }
    let cache_exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_index_snapshots')", [], |row| row.get(0)).map_err(io_error)?;
    if cache_exists { tx.execute("DELETE FROM source_index_snapshots WHERE object_key=?1", [&key]).map_err(io_error)?; }
    tx.execute("UPDATE agent_jobs SET state='cancelled',error=NULL WHERE kind='extract' AND dedupe_key=?1 AND state IN ('queued','running')", [format!("source-index:{key}")]).map_err(io_error)?;
    db.touch_todo_owners(&db.todo_record_unchecked(todo_id(&group.object)?).map_err(|_| conflict())?).map_err(|_| conflict())?;
    let result = RecordWithdrawalResult { operation_id, creation_operation_id: first.operation_id.clone(), object: group.object.clone(), withdrawn: true, revision: revision as u64 };
    Ok((result, Some(OperationChange { object_key: key, scope: group.object.scope.clone(), revision: format!("withdrawal:{revision}:withdrawn") })))
    })
}

impl Database {
    fn authorize_todo_restore_references(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        before: &TodoSnapshot,
        after: &TodoSnapshot,
    ) -> AgentResult<()> {
        let validate = |content: &str, existing: Option<&str>| -> AgentResult<()> {
            self.validate_todo_internal_references(
                before.scope,
                before.project_id,
                content,
                existing,
            )
            .map_err(|_| conflict())?;
            for (kind, id) in super::parse_internal_reference_tokens(content) {
                let resolved = self
                    .internal_reference_resolve(crate::models::InternalReferenceResolveInput {
                        kind,
                        id,
                    })
                    .map_err(|_| conflict())?
                    .ok_or_else(conflict)?;
                let scope = match (resolved.scope, resolved.project_id) {
                    (TodoScope::Workspace, None) => Scope::Workspace,
                    (TodoScope::Project, Some(project_id)) => Scope::Project { project_id },
                    _ => return Err(conflict()),
                };
                request.authorize(binding, &scope, "operation.undo")?;
            }
            Ok(())
        };
        validate(&before.content, Some(&after.content))?;
        for child in &before.children {
            validate(
                &child.content,
                after
                    .children
                    .iter()
                    .find(|current| current.id == child.id)
                    .map(|current| current.content.as_str()),
            )?;
        }
        Ok(())
    }
    pub(crate) fn agent_todo_undo(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &OperationUndoInput,
    ) -> AgentResult<TodoUndoResult> {
        self.operation_binding(binding)?;
        let entry = authorize_entry(
            &self.conn,
            request,
            binding,
            &input.operation_id,
            "operation.undo",
        )?;
        if entry.kind != "todo.update"
            || input.expected_head_revision == 0
            || entry.after_revision != Some(input.expected_head_revision)
            || !matches!(entry.undo_state.as_str(), "available" | "undone")
        {
            return Err(conflict());
        }
        if let Some(id) = &entry.undo_operation_id {
            return previous(&self.conn, id, "todo.undo");
        }
        self.agent_atomic_operation(
            &request.caller.key(),
            &request.request_id,
            "todo.undo",
            input,
            |tx| {
                let entry =
                    authorize_entry(tx, request, binding, &input.operation_id, "operation.undo")?;
                if let Some(id) = &entry.undo_operation_id {
                    return Ok((previous(tx, id, "todo.undo")?, None));
                }
                if entry.undo_state != "available"
                    || entry.kind != "todo.update"
                    || entry.after_revision != Some(input.expected_head_revision)
                {
                    return Err(conflict());
                }
                self.apply_todo_undo_restore(tx, request, binding, std::slice::from_ref(&entry))
            },
        )
    }

    /// One native restore for a complete modification chain on one actual Todo.
    /// Planning is repeated after acquiring the atomic writer reservation.
    pub(crate) fn agent_todo_undo_group(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &OperationUndoBatchInput,
    ) -> AgentResult<TodoUndoResult> {
        self.operation_binding(binding)?;
        let group = todo_undo_group_plan(&self.conn, request, binding, input)?;
        if let Some(result) = todo_undo_group_previous(&self.conn, &group)? {
            return Ok(result);
        }
        self.agent_atomic_operation(
            &request.caller.key(),
            &request.request_id,
            "todo.undo",
            input,
            |tx| {
                let group = todo_undo_group_plan(tx, request, binding, input)?;
                if let Some(result) = todo_undo_group_previous(tx, &group)? {
                    return Ok((result, None));
                }
                if group.undo_state != OperationBatchUndoState::Available
                    || !group.conflicts.is_empty()
                {
                    return Err(conflict());
                }
                self.apply_todo_undo_restore(tx, request, binding, &group.operations)
            },
        )
    }

    /// Shared by single and group undo: restore native fields/children once,
    /// create one canonical revision, then atomically link every original receipt.
    fn apply_todo_undo_restore(
        &self,
        tx: &Transaction<'_>,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        entries: &[OperationEntry],
    ) -> AgentResult<(TodoUndoResult, Option<OperationChange>)> {
        let first = entries.first().ok_or_else(conflict)?;
        let tail = entries.last().ok_or_else(conflict)?;
        let (head, after) = baseline(tx, tail)?;
        let id = todo_id(&first.object)?;
        require_todo_visible(tx, id)?;
        let before_ref = first.before_snapshot_ref.as_deref().ok_or_else(conflict)?;
        let before = retained(
            tx,
            before_ref,
            id,
            first.before_revision.ok_or_else(conflict)?,
        )?;
        if snapshot_scope(&before)? != first.object.scope
            || before.scope != after.scope
            || before.project_id != after.project_id
        {
            return Err(conflict());
        }
        self.authorize_todo_restore_references(request, binding, &before, &after)?;
        // Preserve IDs and all native child evidence. A child ID now owned by
        // another Todo cannot be taken back during recovery.
        for child in &before.children {
            let owner: Option<i64> = tx
                .query_row(
                    "SELECT todo_id FROM todo_progresses WHERE id=?1",
                    [child.id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(io_error)?;
            if owner.is_some_and(|owner| owner != id) {
                return Err(conflict());
            }
        }
        self.validated_todo_tag_ids(before.project_id, &before.tag_ids)
            .map_err(|_| conflict())?;
        let at = Utc::now().to_rfc3339();
        tx.execute("UPDATE todos SET content=?1,status=?2,priority=?3,due_date=?4,updated_at=?5 WHERE id=?6", params![before.content, before.status, before.priority, before.due_date, at, id]).map_err(io_error)?;
        tx.execute("DELETE FROM todo_tag_links WHERE todo_id=?1", [id])
            .map_err(io_error)?;
        for tag in &before.tag_ids {
            tx.execute(
                "INSERT INTO todo_tag_links(todo_id,tag_id,created_at) VALUES (?1,?2,?3)",
                params![id, tag, at],
            )
            .map_err(io_error)?;
        }
        tx.execute("DELETE FROM todo_progresses WHERE todo_id=?1", [id])
            .map_err(io_error)?;
        for child in &before.children {
            tx.execute("INSERT INTO todo_progresses(id,todo_id,content,status,progress_date,due_date,completed_at,order_index,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![child.id,id,child.content,child.status,child.progress_date,child.due_date,child.completed_at,child.order_index,child.created_at]).map_err(io_error)?;
        }
        let operation_id = random_id();
        let saved = todo_revisions::commit(tx, id, head.revision, Some(&operation_id))?;
        self.touch_todo_owners(&self.todo_record_unchecked(id).map_err(|_| conflict())?)
            .map_err(|_| conflict())?;
        let result = TodoUndoResult {
            operation_id: operation_id.clone(),
            original_operation_id: first.operation_id.clone(),
            object: first.object.clone(),
            before_revision: head.revision,
            after_revision: saved.revision,
            before_snapshot_ref: head.snapshot_ref,
            after_snapshot_ref: saved.snapshot_ref,
            body_hash: saved.body_hash.clone(),
        };
        for entry in entries {
            let changed = tx.execute("UPDATE agent_operation_receipts SET undo_state='undone',undo_operation_id=?1 WHERE operation_id=?2 AND undo_state='available' AND undo_operation_id IS NULL", params![operation_id, entry.operation_id]).map_err(io_error)?;
            if changed != 1 {
                return Err(conflict());
            }
        }
        Ok((
            result,
            Some(OperationChange {
                object_key: first.object.key()?,
                scope: first.object.scope.clone(),
                revision: saved.body_hash,
            }),
        ))
    }

    pub(crate) fn agent_todo_creation_withdraw(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &RecordWithdrawalInput,
    ) -> AgentResult<RecordWithdrawalResult> {
        self.todo_creation_visibility(request, binding, input, None)
    }
    pub(crate) fn agent_todo_creation_restore(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &RecordRestoreInput,
    ) -> AgentResult<RecordWithdrawalResult> {
        self.todo_creation_visibility(
            request,
            binding,
            &RecordWithdrawalInput {
                creation_operation_id: input.creation_operation_id.clone(),
            },
            Some(input.expected_withdrawal_revision),
        )
    }
    fn todo_creation_visibility(
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
            "todo.withdraw"
        } else {
            "todo.restore"
        };
        let entry = authorize_entry(
            &self.conn,
            request,
            binding,
            &input.creation_operation_id,
            permission,
        )?;
        if entry.kind != "todo.create"
            || !matches!(entry.undo_state.as_str(), "available" | "undone")
        {
            return Err(conflict());
        }
        self.agent_atomic_operation(&request.caller.key(), &request.request_id, operation, &(input, expected), |tx| {
            let entry = authorize_entry(tx, request, binding, &input.creation_operation_id, permission)?;
            if entry.kind != "todo.create" { return Err(conflict()); }
            let key = entry.object.key()?;
            let state: Option<(String, bool, Option<String>, i64)> = tx.query_row("SELECT creation_operation_id,withdrawn_at IS NOT NULL,restore_operation_id,revision FROM agent_object_withdrawals WHERE object_key=?1", [&key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).optional().map_err(io_error)?;
            if state.as_ref().is_some_and(|state| state.0 != input.creation_operation_id) { return Err(conflict()); }
            if withdraw {
                if let Some(id) = &entry.undo_operation_id { return Ok((previous(tx, id, "todo.withdraw")?, None)); }
                if entry.undo_state != "available" { return Err(conflict()); }
            } else {
                let Some(state) = &state else { return Err(conflict()); };
                if let Some(id) = &state.2 {
                    if expected != u64::try_from(state.3).ok().and_then(|revision| revision.checked_sub(1)) { return Err(conflict()); }
                    return Ok((previous(tx, id, "todo.restore")?, None));
                }
                if !state.1 || expected != u64::try_from(state.3).ok() { return Err(conflict()); }
            }
            if withdraw {
                baseline(tx, &entry)?;
            } else if let Some(inverse_id) = &entry.undo_operation_id {
                let context: String = tx.query_row("SELECT output_context_json FROM agent_operation_receipts WHERE operation_id=?1 AND operation='todo.withdraw'", [inverse_id], |row| row.get(0)).map_err(io_error)?;
                let context: Value = decode(&context)?;
                if let Some(ids) = context["originalOperationIds"].as_array() {
                    if ids.first().and_then(Value::as_str) != Some(entry.operation_id.as_str()) { return Err(conflict()); }
                    for original in ids {
                        let original_id = original.as_str().ok_or_else(conflict)?;
                        let original = authorize_entry(tx, request, binding, original_id, permission)?;
                        if original.object != entry.object || original.undo_operation_id.as_deref() != Some(inverse_id) { return Err(conflict()); }
                    }
                    let tail_id = ids.last().and_then(Value::as_str).ok_or_else(conflict)?;
                    let tail = authorize_entry(tx, request, binding, tail_id, permission)?;
                    if tail.object != entry.object || tail.undo_operation_id.as_deref() != Some(inverse_id) { return Err(conflict()); }
                    let (head, _) = baseline(tx, &tail)?;
                    if context["tailBaseline"] != json!({"revision":head.revision,"snapshotRef":head.snapshot_ref,"bodyHash":head.body_hash}) { return Err(conflict()); }
                } else {
                    baseline(tx, &entry)?;
                }
            } else {
                baseline(tx, &entry)?;
            }
            if withdraw { require_no_incoming(tx, &entry.object)?; }
            let revision = state.as_ref().map_or(Some(1), |state| state.3.checked_add(1)).filter(|revision| *revision > 0).ok_or_else(|| AgentError::new(ErrorCode::BudgetExceeded, "Todo withdrawal revision exhausted"))?;
            let operation_id = random_id();
            let at = if withdraw { Some(Utc::now().to_rfc3339()) } else { None };
            tx.execute("INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,restore_operation_id,revision) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(object_key) DO UPDATE SET withdrawn_at=excluded.withdrawn_at,restore_operation_id=excluded.restore_operation_id,revision=excluded.revision", params![key,input.creation_operation_id,at,if withdraw {None}else{Some(&operation_id)},revision]).map_err(io_error)?;
            if withdraw {
                let changed = tx.execute("UPDATE agent_operation_receipts SET undo_state='undone',undo_operation_id=?1 WHERE operation_id=?2 AND undo_state='available' AND undo_operation_id IS NULL", params![operation_id,input.creation_operation_id]).map_err(io_error)?;
                if changed != 1 { return Err(conflict()); }
                let cache_exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_index_snapshots')", [], |row| row.get(0)).map_err(io_error)?;
                if cache_exists { tx.execute("DELETE FROM source_index_snapshots WHERE object_key=?1", [&key]).map_err(io_error)?; }
                tx.execute("UPDATE agent_jobs SET state='cancelled',error=NULL WHERE kind='extract' AND dedupe_key=?1 AND state IN ('queued','running')", [format!("source-index:{key}")]).map_err(io_error)?;
            }
            self.touch_todo_owners(&self.todo_record_unchecked(todo_id(&entry.object)?).map_err(|_| conflict())?).map_err(|_| conflict())?;
            let result = RecordWithdrawalResult { operation_id, creation_operation_id: input.creation_operation_id.clone(), object: entry.object.clone(), withdrawn: withdraw, revision: revision as u64 };
            Ok((result, Some(OperationChange { object_key: key, scope: entry.object.scope, revision: format!("withdrawal:{revision}:{}", if withdraw {"withdrawn"} else {"visible"}) })))
        })
    }
}

/// The atomic operation owner calls this after inserting the ordinary receipt.
pub(crate) fn agent_todo_recovery_receipt_committed(
    tx: &Transaction<'_>,
    caller: &str,
    request_id: &str,
    operation: &str,
    result_json: &str,
) -> AgentResult<()> {
    if operation == "todo.undo" {
        let result: TodoUndoResult = decode(result_json)?;
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_operation_receipts WHERE operation_id=?1)",
                [&result.operation_id],
                |row| row.get(0),
            )
            .map_err(io_error)?;
        if exists {
            return Ok(());
        }
        let changed = tx.execute("UPDATE agent_operation_receipts SET operation_id=?1,run_id=(SELECT run_id FROM agent_operation_receipts WHERE operation_id=?2),target_ref_json=?3,before_revision=?4,after_revision=?5,before_snapshot_ref=?6,after_snapshot_ref=?7,output_context_json=?8,undo_state='unavailable' WHERE caller_id=?9 AND request_id=?10 AND operation=?11 AND NOT EXISTS(SELECT 1 FROM agent_operation_receipts WHERE operation_id=?1)", params![result.operation_id,result.original_operation_id,encode(&result.object)?,result.before_revision as i64,result.after_revision as i64,result.before_snapshot_ref,result.after_snapshot_ref,encode(&json!({"originalOperationId":result.original_operation_id,"afterBodyHash":result.body_hash}))?,caller,request_id,operation]).map_err(io_error)?;
        if changed != 1 {
            return Err(AgentError::new(
                ErrorCode::IoFailed,
                "Todo recovery receipt could not be finalized",
            ));
        }
    } else if matches!(operation, "todo.withdraw" | "todo.restore") {
        let result: RecordWithdrawalResult = decode(result_json)?;
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_operation_receipts WHERE operation_id=?1)",
                [&result.operation_id],
                |row| row.get(0),
            )
            .map_err(io_error)?;
        if exists {
            return Ok(());
        }
        let mut context = json!({"creationOperationId":result.creation_operation_id,"withdrawn":result.withdrawn,"withdrawalRevision":result.revision});
        if operation == "todo.withdraw" && request_id.starts_with(CREATION_UNDO_PREFIX) {
            let mut stmt = tx.prepare("SELECT operation_id,after_revision,after_snapshot_ref FROM agent_operation_receipts WHERE undo_operation_id=?1 AND undo_state='undone' ORDER BY rowid").map_err(io_error)?;
            let originals = stmt
                .query_map([&result.operation_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(io_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(io_error)?;
            let first = originals.first().ok_or_else(conflict)?;
            let tail = originals.last().ok_or_else(conflict)?;
            if first.0 != result.creation_operation_id
                || request_id != format!("{CREATION_UNDO_PREFIX}{}:{}", first.0, tail.0)
            {
                return Err(conflict());
            }
            let tail_entry = read_entry(tx, &tail.0)?.0;
            let (head, _) = baseline(tx, &tail_entry)?;
            if head.revision != u64::try_from(tail.1).map_err(|_| conflict())?
                || head.snapshot_ref != tail.2
            {
                return Err(conflict());
            }
            context["originalOperationIds"] =
                json!(originals.iter().map(|entry| &entry.0).collect::<Vec<_>>());
            context["tailBaseline"] = json!({"revision":head.revision,"snapshotRef":head.snapshot_ref,"bodyHash":head.body_hash});
        }
        let changed = tx.execute("UPDATE agent_operation_receipts SET operation_id=?1,run_id=(SELECT run_id FROM agent_operation_receipts WHERE operation_id=?2),target_ref_json=?3,before_revision=(SELECT after_revision FROM agent_operation_receipts WHERE operation_id=?2),after_revision=(SELECT after_revision FROM agent_operation_receipts WHERE operation_id=?2),before_snapshot_ref=(SELECT after_snapshot_ref FROM agent_operation_receipts WHERE operation_id=?2),after_snapshot_ref=(SELECT after_snapshot_ref FROM agent_operation_receipts WHERE operation_id=?2),output_context_json=?4,undo_state='unavailable' WHERE caller_id=?5 AND request_id=?6 AND operation=?7 AND NOT EXISTS(SELECT 1 FROM agent_operation_receipts WHERE operation_id=?1)", params![result.operation_id,result.creation_operation_id,encode(&result.object)?,encode(&context)?,caller,request_id,operation]).map_err(io_error)?;
        if changed != 1 {
            return Err(AgentError::new(
                ErrorCode::IoFailed,
                "Todo recovery receipt could not be finalized",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "agent_todo_undo_tests.rs"]
mod tests;
