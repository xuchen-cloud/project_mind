use super::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ExecutionMode, Scope, WorkspaceBinding},
};
use serde::{Deserialize, Serialize};

pub const HOST_PROTOCOL: &str = "mind-agent-host/v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Preparing,
    Running,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}
impl RunState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::Interrupted
        )
    }
    pub fn transition(self, next: Self) -> AgentResult<Self> {
        let allowed = matches!(
            (self, next),
            (
                Self::Preparing,
                Self::Running | Self::Failed | Self::Cancelled | Self::Interrupted
            ) | (
                Self::Running,
                Self::Completed | Self::Failed | Self::Cancelling | Self::Interrupted
            ) | (
                Self::Cancelling,
                Self::Cancelled | Self::Failed | Self::Interrupted
            )
        );
        if !allowed {
            return Err(AgentError::new(
                ErrorCode::InvalidRunTransition,
                "Invalid run transition",
            ));
        }
        Ok(next)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDescriptor {
    pub binding: WorkspaceBinding,
    pub scope: Scope,
    pub session_id: String,
    pub run_id: String,
    pub mode: ExecutionMode,
    pub state: RunState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilities {
    pub structured_events: bool,
    pub tool_bridge: bool,
    pub resume: bool,
    pub cancel: bool,
    pub file_output: bool,
    pub scope_enforced: bool,
}

/// The adapter maps vendor events; only the Host settles persisted run completion.
/// Implementations are supplied after the Pi packaging/security spike (AI-01).
pub trait RuntimeAdapter {
    fn detect(&self) -> AgentResult<()>;
    fn capabilities(&self) -> RuntimeCapabilities;
    fn start(&mut self, run: &RunDescriptor) -> AgentResult<()>;
    fn send(&mut self, run_id: &str, text: &str) -> AgentResult<()>;
    fn cancel(&mut self, run_id: &str) -> AgentResult<()>;
    fn resume(&mut self, session_id: &str) -> AgentResult<()>;
    fn dispose(&mut self) -> AgentResult<()>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RunEventKind {
    #[serde(rename = "run.started")]
    Started,
    #[serde(rename = "text.delta")]
    TextDelta { text: String },
    #[serde(rename = "tool.started")]
    ToolStarted { call_id: String, method: String },
    #[serde(rename = "tool.completed")]
    ToolCompleted { call_id: String },
    #[serde(rename = "message.completed")]
    MessageCompleted { message_id: String },
    #[serde(rename = "run.completed")]
    Completed,
    #[serde(rename = "run.failed")]
    Failed { error: AgentError },
    #[serde(rename = "run.cancelled")]
    Cancelled,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    pub binding: WorkspaceBinding,
    pub session_id: String,
    pub run_id: String,
    pub seq: u64,
    pub event: RunEventKind,
}
