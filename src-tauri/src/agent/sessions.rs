//! SQLite metadata/projections; the Pi SessionManager remains history authority (AI-05).
use super::{
    errors::AgentResult,
    models::{MessageRef, ObjectRef, Scope, SourceRef},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    pub scope: Scope,
    pub title: String,
    pub runtime_id: String,
    pub profile_override_id: Option<String>,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatementKind {
    UserPlan,
    UserDecision,
    AiSuggestion,
    CompletedOperation,
    UserReportedCompletion,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryStatement {
    pub text: String,
    pub kind: StatementKind,
    pub message_refs: Vec<MessageRef>,
    pub source_refs: Vec<SourceRef>,
    pub operation_receipt_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummarySegment {
    pub id: String,
    pub session_id: String,
    pub branch_id: String,
    pub revision: u64,
    pub start_entry_id: String,
    pub end_entry_id: String,
    /// Unicode character offsets in a split message, half-open. Both are None
    /// when the segment consists of complete messages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_char: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_char: Option<usize>,
    /// Human-readable segment body. Kept alongside structured statements.
    pub summary: String,
    pub topics: Vec<String>,
    pub statements: Vec<SummaryStatement>,
    pub artifact_refs: Vec<ObjectRef>,
    pub supersedes: Vec<String>,
    pub input_hash: String,
}

impl SessionSummarySegment {
    pub(crate) fn validate(&self) -> AgentResult<()> {
        use super::errors::{AgentError, ErrorCode};
        let invalid = || AgentError::new(ErrorCode::InvalidArgument, "Invalid session summary segment");
        if self.id.is_empty() || self.session_id.is_empty() || self.branch_id.is_empty()
            || self.start_entry_id.is_empty() || self.end_entry_id.is_empty()
            || self.revision == 0 || self.summary.chars().count() > 2500
            || self.statements.len() > 50 || self.topics.len() > 20
            || !self.input_hash.strip_prefix("sha256:").is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
            || matches!((self.start_char, self.end_char), (Some(start), Some(end)) if start >= end)
            || self.start_char.is_some() != self.end_char.is_some()
        {
            return Err(invalid());
        }
        Ok(())
    }
}

pub trait SessionRepository {
    fn get(&self, session_id: &str) -> AgentResult<Option<AgentSession>>;
    fn create(&mut self, session: &AgentSession) -> AgentResult<()>;
    // Summary persistence will be added with range/branch uniqueness in AI-08.
}
