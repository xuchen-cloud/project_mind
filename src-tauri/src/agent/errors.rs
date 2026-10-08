use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidArgument,
    NotFound,
    ScopeDenied,
    WorkspaceNotOpen,
    WorkspaceChanged,
    RevisionConflict,
    SourceNotReady,
    SourceChanged,
    FileChangedUnregistered,
    StagedContentExpired,
    RunBusy,
    RuntimeUnavailable,
    RuntimeIncompatible,
    InvalidRunTransition,
    BudgetExceeded,
    IdempotencyConflict,
    IoFailed,
    Cancelled,
    ProfileUnavailable,
    SecretsLocked,
    ToolCallUnsupported,
    RateLimited,
    OutputCommitFailed,
    InvalidPatch,
    AmbiguousMatch,
    EditorReviewPending,
    EditorBusy,
    UndoConflict,
    ObjectWithdrawn,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl AgentError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
            details: None,
        }
    }
    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }
}

pub type AgentResult<T> = Result<T, AgentError>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponse<T: Serialize> {
    api_version: u8,
    request_id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<AgentError>,
}

impl<T: Serialize> ApiResponse<T> {
    pub fn from_result(request_id: String, result: AgentResult<T>) -> Self {
        match result {
            Ok(data) => Self {
                api_version: 1,
                request_id,
                ok: true,
                data: Some(data),
                error: None,
            },
            Err(error) => Self {
                api_version: 1,
                request_id,
                ok: false,
                data: None,
                error: Some(error),
            },
        }
    }
}
