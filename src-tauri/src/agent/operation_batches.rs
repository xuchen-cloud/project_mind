//! GUI batch planning preserves native receipt evidence; it never mutates heads.
use super::{errors::AgentError, models::ObjectRef, operations::OperationEntry};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OperationUndoBatchInput {
    pub run_id: String,
    pub operation_ids: Vec<String>,
}
#[derive(Debug, Clone)]
pub(crate) struct OperationUndoBatchPlan {
    pub run_id: String,
    pub groups: Vec<OperationUndoGroup>,
    pub excluded_no_change: Vec<OperationEntry>,
}
#[derive(Debug, Clone)]
pub(crate) struct OperationUndoGroup {
    pub object: ObjectRef,
    pub object_key: String,
    /// Original receipts, ordered by their durable SQLite insertion sequence.
    pub operations: Vec<OperationEntry>,
    pub undo_state: OperationBatchUndoState,
    /// Structural conflicts only. Absence does not prove the current head matches.
    pub conflicts: Vec<OperationBatchConflict>,
}
impl OperationUndoGroup {
    pub(crate) fn first(&self) -> &OperationEntry {
        self.operations.first().expect("nonempty receipt group")
    }
    pub(crate) fn last(&self) -> &OperationEntry {
        self.operations.last().expect("nonempty receipt group")
    }
    pub(crate) fn creation(&self) -> Option<&OperationEntry> {
        matches!(
            self.first().kind.as_str(),
            "record.create" | "todo.create" | "file.create"
        )
        .then(|| self.first())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OperationBatchUndoState {
    Available,
    Undone,
    Mixed,
    Unavailable,
}
#[derive(Debug, Clone)]
pub(crate) struct OperationBatchConflict {
    pub reason: OperationBatchConflictReason,
    pub operation_ids: Vec<String>,
    pub error: AgentError,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OperationBatchConflictReason {
    UnsupportedKind,
    IncompleteBaseline,
    CreationBoundary,
    RevisionGap,
    SnapshotGap,
    MissingInterveningOperation,
    MissingLaterOperation,
}
