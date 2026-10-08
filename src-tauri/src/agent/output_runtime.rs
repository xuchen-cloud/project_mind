//! Record output staging contracts. A prepared commit has not changed business content.
use super::models::SourceRef;
use super::{
    models::{ExecutionMode, ObjectRef},
    outputs::{OutputIntent, StagedOutput},
};
use serde::{Deserialize, Serialize};

pub(crate) const OUTPUT_PAGE_MAX: u16 = 50;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StageRecordInput {
    pub intent: OutputIntent,
    pub sources: Vec<SourceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OutputState {
    Staged,
    Committing,
    Committed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeOutput {
    #[serde(flatten)]
    pub staged: StagedOutput,
    pub state: OutputState,
    pub object: Option<ObjectRef>,
    pub mode: ExecutionMode,
    /// GUI decision stored separately from the native commit state.
    #[serde(default)]
    pub dismissed: bool,
    pub error_code: Option<super::errors::ErrorCode>,
    /// Ordered with sources. A legal retained citation may already differ from
    /// its current source; preserving it must not silently replace the evidence.
    pub source_changed: Vec<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OutputUpdateInput {
    pub output_id: String,
    pub expected_revision: u64,
    pub candidate: StageRecordInput,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutputPage {
    pub outputs: Vec<RuntimeOutput>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedOutputCommit {
    pub output: RuntimeOutput,
    pub commit_request_id: String,
    pub mode: ExecutionMode,
}
