//! Incremental maintenance boundary. No timers/model calls are started by this scaffold.
use super::{
    errors::AgentResult,
    models::{ObjectRef, Scope, WorkspaceBinding},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeOperation {
    Upsert,
    Delete,
    Exclude,
    Restore,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentChange {
    pub binding: WorkspaceBinding,
    pub seq: u64,
    pub object: ObjectRef,
    pub operation: ChangeOperation,
    pub revision: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceBatch {
    pub scope: Scope,
    /// Persisted by the existing job owner, independent of its target watermark.
    pub batch_id: String,
    pub from_seq_exclusive: u64,
    pub through_seq: u64,
    pub previous_overview_revision: Option<u64>,
    pub changes: Vec<ContentChange>,
}

/// Capture a stable watermark; consume pending changes only after publishing knowledge.
/// User jobs have priority; unchanged scopes produce no batch and no model call.
pub trait MaintenanceRepository {
    fn next_batch(&self, scope: &Scope, limit: usize) -> AgentResult<Option<MaintenanceBatch>>;
    fn acknowledge(&mut self, batch: &MaintenanceBatch, published_revision: u64)
        -> AgentResult<()>;
}
