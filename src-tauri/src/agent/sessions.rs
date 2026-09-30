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
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub topics: Vec<String>,
    pub statements: Vec<SummaryStatement>,
    pub artifact_refs: Vec<ObjectRef>,
    pub supersedes: Vec<String>,
    pub input_hash: String,
}

pub trait SessionRepository {
    fn get(&self, session_id: &str) -> AgentResult<Option<AgentSession>>;
    fn create(&mut self, session: &AgentSession) -> AgentResult<()>;
    // Summary persistence will be added with range/branch uniqueness in AI-08.
}
