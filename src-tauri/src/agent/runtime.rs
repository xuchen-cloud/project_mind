use super::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::WorkspaceBinding,
};
use serde::{Deserialize, Serialize};

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
