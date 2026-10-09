//! Bounded, current native internal-reference navigation for external callers.
use crate::agent::models::ObjectRef;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceDirection {
    Incoming,
    Outgoing,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReferenceListInput {
    pub object: ObjectRef,
    pub direction: ReferenceDirection,
    #[schemars(length(max = 2048))]
    pub cursor: Option<String>,
    #[schemars(range(min = 1, max = 50))]
    pub limit: Option<usize>,
    #[schemars(range(min = 1, max = 12000))]
    pub budget_chars: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceItem {
    pub object: ObjectRef,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceListPage {
    pub object: ObjectRef,
    pub direction: ReferenceDirection,
    pub items: Vec<ReferenceItem>,
    pub next_cursor: Option<String>,
    pub complete: bool,
}
