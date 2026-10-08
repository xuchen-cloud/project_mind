//! Withdraw a closed set of newly created objects in one native transaction.
//! Existing histories and reference edges remain; only visibility is withdrawn.
use super::{
    agent_operations::io_error, agent_record_withdrawals::RecordWithdrawalResult, Database,
};
use crate::agent::{
    access::RequestContext,
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, WorkspaceBinding},
    operation_batches::{
        OperationBatchUndoState, OperationUndoBatchInput, OperationUndoBatchItem,
        OperationUndoBatchOutcome, OperationUndoGroup,
    },
    operations::OperationUndoResult,
};
use rusqlite::{Connection, Transaction, TransactionBehavior};
use std::collections::{HashMap, HashSet};

fn check(
    db: &Database,
    conn: &Connection,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    group: &OperationUndoGroup,
) -> AgentResult<Option<RecordWithdrawalResult>> {
    match group.object.kind {
        ObjectKind::Record => {
            super::agent_record_withdrawals::creation_group_check(db, conn, request, binding, group)
        }
        ObjectKind::Todo => {
            super::agent_todo_undo::creation_group_check(db, conn, request, binding, group)
        }
        ObjectKind::File => {
            super::agent_file_undo::creation_group_check(db, conn, request, binding, group)
        }
        _ => Err(AgentError::new(
            ErrorCode::ToolCallUnsupported,
            "Creation recovery supports Record, Todo and File",
        )),
    }
}

#[cfg(test)]
#[path = "agent_creation_batch_tests.rs"]
mod tests;
fn apply(
    db: &Database,
    tx: &Transaction<'_>,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    group: &OperationUndoGroup,
) -> AgentResult<RecordWithdrawalResult> {
    match group.object.kind {
        ObjectKind::Record => {
            super::agent_record_withdrawals::creation_group_apply(db, tx, request, binding, group)
        }
        ObjectKind::Todo => {
            super::agent_todo_undo::creation_group_apply(db, tx, request, binding, group)
        }
        ObjectKind::File => {
            super::agent_file_undo::creation_group_apply(db, tx, request, binding, group)
        }
        _ => Err(AgentError::new(
            ErrorCode::ToolCallUnsupported,
            "Creation recovery supports Record, Todo and File",
        )),
    }
}
fn success(result: RecordWithdrawalResult) -> OperationUndoBatchOutcome {
    let result = match result.object.kind {
        ObjectKind::Record => OperationUndoResult::CreatedRecord(result),
        ObjectKind::Todo => OperationUndoResult::CreatedTodo(result),
        ObjectKind::File => OperationUndoResult::CreatedFile(result),
        _ => unreachable!("validated creation kind"),
    };
    OperationUndoBatchOutcome::Succeeded { result }
}

impl Database {
    /// The service flushes Record editors and holds submission guards first.
    /// Replan and inspect every head/reference after acquiring the writer.
    pub(crate) fn agent_creation_batch_withdraw(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &OperationUndoBatchInput,
    ) -> AgentResult<Vec<OperationUndoBatchItem>> {
        self.operation_binding(binding)?;
        // File recovery acquires filesystem locks before a SQLite writer, as
        // the existing single-object visibility path does. Never reverse it.
        let initial = self.agent_operation_undo_batch_plan(request, binding, input)?;
        let mut files: Vec<_> = initial
            .groups
            .iter()
            .filter(|group| {
                group.creation().is_some()
                    && group.object.kind == ObjectKind::File
                    && group.undo_state == OperationBatchUndoState::Available
                    && group.conflicts.is_empty()
            })
            .collect();
        files.sort_by(|a, b| a.object_key.cmp(&b.object_key));
        let mut file_locks = Vec::new();
        let mut lock_errors = HashMap::new();
        for group in files {
            let id = group.object.id.parse::<i64>().map_err(|_| {
                AgentError::new(ErrorCode::UndoConflict, "Invalid File receipt identity")
            })?;
            match self.file_recovery_write_locks(id) {
                Ok(locks) => file_locks.push(locks),
                Err(_) => {
                    lock_errors.insert(
                        group.object_key.clone(),
                        AgentError::new(
                            ErrorCode::UndoConflict,
                            "File recovery is busy or unavailable; its contents were retained",
                        ),
                    );
                }
            }
        }
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let plan = super::agent_operation_batches::plan(&tx, request, binding, input)?;
        if plan.groups.iter().any(|group| group.creation().is_none()) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Creation batch contains a modification-only group",
            ));
        }
        let mut outcomes: Vec<Option<OperationUndoBatchOutcome>> =
            (0..plan.groups.len()).map(|_| None).collect();
        let mut candidates = HashSet::new();
        let mut incoming = HashMap::new();
        for (index, group) in plan.groups.iter().enumerate() {
            if let Some(error) = lock_errors.remove(&group.object_key) {
                outcomes[index] = Some(OperationUndoBatchOutcome::Failed { error });
                continue;
            }
            match check(self, &tx, request, binding, group) {
                Ok(Some(previous)) => outcomes[index] = Some(success(previous)),
                Err(error) => outcomes[index] = Some(OperationUndoBatchOutcome::Failed { error }),
                Ok(None) => match super::agent_creation_references::incoming_sources(
                    &tx,
                    binding,
                    &group.object,
                ) {
                    Ok(sources) => {
                        candidates.insert(group.object_key.clone());
                        incoming.insert(group.object_key.clone(), sources);
                    }
                    Err(error) => {
                        outcomes[index] = Some(OperationUndoBatchOutcome::Failed { error })
                    }
                },
            }
        }
        // A blocked source stays visible and can in turn block its targets.
        // The remaining closed set naturally includes mutually referring creations.
        loop {
            let blocked: HashSet<String> = candidates
                .iter()
                .filter(|key| {
                    incoming[*key]
                        .iter()
                        .any(|source| !candidates.contains(source))
                })
                .cloned()
                .collect();
            if blocked.is_empty() {
                break;
            }
            for (index, group) in plan.groups.iter().enumerate() {
                if blocked.contains(&group.object_key) {
                    candidates.remove(&group.object_key);
                    outcomes[index] = Some(OperationUndoBatchOutcome::Failed { error: AgentError::new(ErrorCode::UndoConflict, "Other retained objects reference this creation; their work will be preserved") });
                }
            }
        }
        let mut failure = None;
        for (index, group) in plan.groups.iter().enumerate() {
            if !candidates.contains(&group.object_key) {
                continue;
            }
            match apply(self, &tx, request, binding, group) {
                Ok(result) => outcomes[index] = Some(success(result)),
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            }
        }
        if failure.is_some() {
            drop(tx); // No part of this visibility set may survive a failed receipt/outbox.
        } else if let Err(error) = tx.commit() {
            failure = Some(io_error(error));
        }
        if let Some(error) = failure {
            for (index, group) in plan.groups.iter().enumerate() {
                if candidates.contains(&group.object_key) {
                    outcomes[index] = Some(OperationUndoBatchOutcome::Failed {
                        error: error.clone(),
                    });
                }
            }
        }
        Ok(plan
            .groups
            .into_iter()
            .zip(outcomes)
            .map(|(group, outcome)| OperationUndoBatchItem {
                object: group.object,
                operation_ids: group
                    .operations
                    .into_iter()
                    .map(|entry| entry.operation_id)
                    .collect(),
                outcome: outcome.expect("every creation group has an actual outcome"),
            })
            .collect())
    }
}
