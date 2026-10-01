use super::errors::{AgentError, AgentResult, ErrorCode};
use serde::{Deserialize, Serialize};

/// Time locators cross JSON into JavaScript and must remain exact integers.
pub(crate) const MAX_SAFE_SOURCE_TIME_MS: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Scope {
    Workspace,
    Project {
        #[serde(rename = "projectId")]
        project_id: i64,
    },
}

impl Scope {
    pub fn key(&self) -> String {
        match self {
            Self::Workspace => "workspace".into(),
            Self::Project { project_id } => format!("project:{project_id}"),
        }
    }
    pub fn validate(&self) -> AgentResult<()> {
        if matches!(self, Self::Project { project_id } if *project_id <= 0) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "projectId must be positive",
            ));
        }
        Ok(())
    }
}

/// Generation changes on every open, including reopening the same Workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceBinding {
    pub workspace_id: String,
    pub generation: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObjectKind {
    Project,
    QuickNote,
    Record,
    Todo,
    File,
    Transcript,
    SessionSummary,
    SessionMessage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectRef {
    pub workspace_id: String,
    pub scope: Scope,
    pub kind: ObjectKind,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SourceLocator {
    Paragraph {
        start: u32,
        end: u32,
    },
    Page {
        page: u32,
        start: u32,
        end: u32,
    },
    Time {
        start_ms: u64,
        end_ms: u64,
    },
    Messages {
        session_id: String,
        branch_id: String,
        start_message_id: String,
        end_message_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    pub object: ObjectRef,
    pub revision: String,
    pub file_version: Option<u32>,
    pub record_version: Option<u32>,
    pub block_id: Option<String>,
    pub locator: Option<SourceLocator>,
    pub title: String,
    pub excerpt: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    Collaborate,
    Review,
    ReadOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRef {
    pub workspace_id: String,
    pub scope: Scope,
    pub session_id: String,
    pub branch_id: String,
    pub message_id: String,
    pub ordinal: u64,
    pub content_hash: String,
}

impl ObjectRef {
    pub fn key(&self) -> AgentResult<String> {
        self.scope.validate()?;
        for part in [&self.workspace_id, &self.id] {
            if part.is_empty()
                || part.len() > 128
                || !part
                    .bytes()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'-' | b'_'))
            {
                return Err(AgentError::new(
                    ErrorCode::InvalidArgument,
                    "Invalid object identity",
                ));
            }
        }
        let kind = serde_json::to_value(self.kind)
            .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Invalid object kind"))?;
        Ok(format!(
            "{}/{}/{}/{}",
            self.workspace_id,
            self.scope.key(),
            kind.as_str().unwrap(),
            self.id
        ))
    }
}
