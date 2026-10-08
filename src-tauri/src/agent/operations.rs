//! Scoped operation history and Record recovery contracts. Authority is supplied
//! by trusted adapters, never by these wire inputs.
use crate::{agent::models::ObjectRef, record_documents::RecordCommittedHead};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OperationGetInput {
    pub operation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OperationListInput {
    pub run_id: String,
    pub cursor: Option<String>,
    #[serde(default = "operation_limit")]
    pub limit: u16,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OperationUndoInput {
    pub operation_id: String,
    pub expected_head_revision: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationEntry {
    pub operation_id: String,
    pub run_id: Option<String>,
    pub request_id: String,
    pub kind: String,
    pub object: ObjectRef,
    pub before_revision: Option<u64>,
    pub after_revision: Option<u64>,
    pub before_snapshot_ref: Option<String>,
    pub after_snapshot_ref: Option<String>,
    pub undo_state: String,
    pub undo_operation_id: Option<String>,
    pub created_at: String,
    pub recovery: Option<OperationRecovery>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationRecovery {
    pub withdrawn: bool,
    pub withdrawal_revision: Option<u64>,
    pub restore_available: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationPage {
    pub operations: Vec<OperationEntry>,
    pub next_cursor: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordUndoResult {
    pub operation_id: String,
    pub original_operation_id: String,
    pub object: ObjectRef,
    pub head: RecordCommittedHead,
    pub before_version: String,
    pub after_version: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TodoUndoResult {
    pub operation_id: String,
    pub original_operation_id: String,
    pub object: ObjectRef,
    pub before_revision: u64,
    pub after_revision: u64,
    pub before_snapshot_ref: String,
    pub after_snapshot_ref: String,
    pub body_hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub(crate) enum OperationUndoResult {
    ModifiedRecord(RecordUndoResult),
    CreatedRecord(crate::db::agent_record_withdrawals::RecordWithdrawalResult),
    ModifiedTodo(TodoUndoResult),
    CreatedTodo(crate::db::agent_record_withdrawals::RecordWithdrawalResult),
}

fn operation_limit() -> u16 {
    50
}
