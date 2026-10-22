//! Fact identities and immutable versions for native Workspace / Project memory.
use super::Database;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum MemoryScope {
    Workspace,
    Project {
        #[serde(rename = "projectId")]
        project_id: i64,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemorySource {
    pub kind: String,
    pub id: String,
    pub scope: MemoryScope,
    pub label: String,
    pub excerpt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<Value>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MemoryOrigin {
    User,
    Organization,
}
#[derive(Debug, Clone, Serialize)]
pub struct MemoryAccess {
    pub scope: MemoryScope,
    pub origin: MemoryOrigin,
    pub sources: Vec<MemorySource>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub enum MemoryRequest {
    List {
        scope: MemoryScope,
        #[serde(default, rename = "includeInactive")]
        include_inactive: bool,
    },
    Context {
        scope: MemoryScope,
        query: String,
        #[serde(rename = "budgetChars")]
        budget_chars: usize,
        strategy: String,
    },
    Apply {
        #[serde(rename = "requestId")]
        request_id: String,
        changes: Vec<Value>,
    },
    Rollback {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "rollbackId")]
        rollback_id: String,
    },
    Approve {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "proposalId")]
        proposal_id: String,
    },
    Reject {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "proposalId")]
        proposal_id: String,
    },
    Settings {
        #[serde(rename = "requireApproval")]
        require_approval: bool,
    },
}
impl Database {
    pub fn memory_execute(
        &self,
        access: &MemoryAccess,
        request: MemoryRequest,
    ) -> Result<Value, String> {
        store::execute(self, access, request).map(|result| store::project_result(access, result))
    }
    pub(super) fn ensure_memory_fact_schema(&self) -> Result<(), String> {
        store::schema(&self.conn)
    }
}
#[cfg(test)]
#[path = "memory_facts_tests.rs"]
mod tests;

#[path = "memory_facts_store.rs"]
mod store;
