//! Bounded directory traversal, independent of source body processing.
use super::models::Scope;
use serde::{Deserialize, Serialize};

/// `directory_complete` proves the metadata directory was traversed while the
/// persistent source-event pending trigger was active. It does not prove bodies
/// were read, knowledge built, or the Overview ready; pending may remain nonzero.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewInventoryProgress {
    pub scope: Scope,
    pub start_seq: u64,
    pub after_kind: String,
    pub after_id: i64,
    pub scanned: u64,
    pub advanced: u16,
    pub directory_complete: bool,
    pub pending_count: u64,
    pub needs_rebuild: bool,
}
