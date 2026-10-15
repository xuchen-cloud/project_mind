//! Commit notifications are hints backed by the durable change log. Shared
//! services publish after releasing storage locks; transports only deliver them.
use crate::{
    agent::models::{ObjectRef, WorkspaceBinding},
    record_documents::RecordTarget,
};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordHeadChange {
    pub binding: WorkspaceBinding,
    pub target: RecordTarget,
    pub request_id: String,
    pub head_revision: Option<u64>,
    pub metadata_revision: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommittedChanges {
    pub binding: WorkspaceBinding,
    pub request_id: String,
    pub seq: i64,
    pub changed_refs: Vec<ObjectRef>,
    pub reset_required: bool,
    #[serde(skip)]
    pub record_heads: Vec<RecordHeadChange>,
}
/// Capture the durable outbox under the same storage lock as the action. Once
/// the action commits, a notification read failure must not change its receipt;
/// consumers can still recover the authoritative log on focus/reconnect.
pub(crate) fn capture_committed<T>(
    binding: &WorkspaceBinding,
    db: &crate::db::Database,
    request_id: &str,
    action: impl FnOnce() -> crate::agent::errors::AgentResult<T>,
) -> crate::agent::errors::AgentResult<(
    crate::agent::errors::AgentResult<T>,
    Option<CommittedChanges>,
)> {
    let before = db.committed_change_watermark()?;
    let result = action();
    let changes = match db.committed_changes_since(binding, request_id, before) {
        Ok(changes) => changes,
        Err(error) => {
            eprintln!(
                "Committed change notification capture failed: {}",
                error.message
            );
            None
        }
    };
    Ok((result, changes))
}
/// Native GUI DTOs use anyhow and mutable database access. Capture committed
/// rows even when an action reports a later cleanup error; never publish rows
/// from a rolled-back transaction, or turn notification failure into write failure.
pub(crate) fn capture_native_committed<T>(
    binding: &WorkspaceBinding,
    db: &mut crate::db::Database,
    request_id: &str,
    action: impl FnOnce(&mut crate::db::Database) -> anyhow::Result<T>,
) -> anyhow::Result<(anyhow::Result<T>, Option<CommittedChanges>)> {
    let before = db.committed_change_watermark().map_err(|e| anyhow::anyhow!(e.message))?;
    let result = action(db);
    let changes = match db.committed_changes_since(binding, request_id, before) {
        Ok(changes) => changes,
        Err(error) => {
            eprintln!("Committed change notification capture failed: {}", error.message);
            None
        }
    };
    Ok((result, changes))
}

pub(crate) trait CommittedChangePublisher {
    /// Delivery failure cannot undo a successful transaction. Consumers recover
    /// via changes.list, including after a lost notification or app restart.
    fn publish_committed(&self, changes: CommittedChanges);
}
impl CommittedChangePublisher for crate::AppState {
    fn publish_committed(&self, changes: CommittedChanges) {
        publish_to(&self.app_handle, changes);
    }
}

pub(crate) fn publish_to(handle: &tauri::AppHandle, changes: CommittedChanges) {
    use tauri::Emitter;
    for head in &changes.record_heads {
        let _ = handle.emit("record:head-changed", head);
    }
    let _ = handle.emit("mind:changed", &changes);
}
