//! Conversation metadata is a projection. Verified Pi JSONL remains history authority.
use super::{
    models::Scope,
    runtime::{RunEvent, RunState},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SESSION_PAGE_MAX: u16 = 100;
pub const MESSAGE_PAGE_MAX: u16 = 50;
pub const EVENT_PAGE_MAX: u16 = 100;
pub const EVENT_RETENTION_MAX: u64 = 1000;
pub const PROJECTION_BYTES_MAX: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Active,
    Archived,
    ReadOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    pub id: String,
    pub scope: Scope,
    pub title: String,
    pub runtime_id: String,
    pub profile_override_id: Option<i64>,
    pub state: SessionState,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCursor {
    pub updated_at: String,
    pub id: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    pub sessions: Vec<SessionMetadata>,
    pub next_cursor: Option<SessionCursor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCheckpoint {
    pub schema_version: u32,
    pub checksum: String,
    pub bytes: u64,
    pub leaf_id: Option<String>,
    pub offset: u64,
    pub entry_count: u64,
    pub message_count: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    User,
    Assistant,
    Tool,
}
impl MessageRole {
    pub(crate) fn sql(&self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Tool => "tool",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionMessage {
    pub runtime_entry_id: String,
    pub ordinal: u64,
    pub created_at: String,
    pub role: MessageRole,
    pub content: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessage {
    pub id: String,
    pub session_id: String,
    pub run_id: Option<String>,
    pub runtime_entry_id: String,
    pub role: MessageRole,
    pub content: Value,
    pub ordinal: u64,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub session: SessionMetadata,
    pub latest_run: Option<StoredRun>,
    pub checkpoint: Option<SessionCheckpoint>,
    pub messages: Vec<ConversationMessage>,
    pub next_ordinal: Option<u64>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRun {
    pub id: String,
    pub session_id: String,
    pub client_request_id: String,
    pub state: RunState,
    pub context_manifest: Value,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub usage: Option<Value>,
    pub error_code: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedRun {
    pub run: StoredRun,
    pub created: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventPage {
    pub events: Vec<RunEvent>,
    pub next_seq: Option<u64>,
    /// Earliest retained sequence; consumers reconcile from messages after a gap.
    pub first_available_seq: Option<u64>,
}

/// Rust Host input only: adapters cannot deserialize caller grants or settle runs.
pub(crate) struct RunPreparation {
    pub run_id: String,
    pub context_manifest: Value,
}
/// Constructed only after Host verifies every Node page against its checkpoint.
/// Content is source-specific codec output; never globally rewrite user text.
pub(crate) struct VerifiedSessionProjection {
    pub checkpoint: SessionCheckpoint,
    pub messages: Vec<ProjectionMessage>,
}
pub(crate) struct RunSettlement {
    pub state: RunState,
    pub runtime_settled: bool,
    pub projection: Option<VerifiedSessionProjection>,
    pub usage: Option<Value>,
    pub error_code: Option<super::errors::ErrorCode>,
}
