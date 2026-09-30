use super::{access::ScopeGrant, errors::AgentResult, models::Scope};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeInput {
    pub after_seq: i64,
    pub limit: u16,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEntry {
    pub seq: i64,
    pub object_key: String,
    pub scope: Scope,
    pub operation: String,
    pub revision: String,
    pub created_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePage {
    pub entries: Vec<ChangeEntry>,
    pub cursor: i64,
    pub has_more: bool,
    pub reset_required: bool,
}
pub trait ChangeRepository {
    fn agent_changes_list(
        &self,
        grant: &ScopeGrant,
        input: &ChangeInput,
    ) -> AgentResult<ChangePage>;
}
