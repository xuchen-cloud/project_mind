//! A connection lists only its own committed operation receipts in a selected scope.
use super::models::Scope;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

fn default_limit() -> u16 { 20 }

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectionOperationListInput {
    pub scope: Scope,
    #[schemars(length(max = 2048))]
    pub cursor: Option<String>,
    #[serde(default = "default_limit")]
    #[schemars(range(min = 1, max = 50))]
    pub limit: u16,
    #[schemars(range(min = 1, max = 12000))]
    pub budget_chars: Option<usize>,
}
