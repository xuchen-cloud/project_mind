use super::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::{Scope, SourceRef},
};
use serde::{Deserialize, Serialize};

pub const CONTEXT_DEFAULT_CHARS: usize = 2_000;
pub const CONTEXT_MAX_CHARS: usize = 3_000;
pub const RUN_DEFAULT_CHARS: usize = 24_000;
pub const RUN_MAX_CHARS: usize = 60_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextGetInput {
    pub scope: Scope,
    pub query: Option<String>,
    pub budget_chars: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OverviewSection {
    Profile,
    Progress,
    KnowledgeMap,
    Actions,
    OpenQuestions,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EpistemicStatus {
    Recorded,
    UserConfirmed,
    Inferred,
    Unknown,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidState {
    Current,
    Stale,
    Disputed,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewItem {
    pub id: String,
    pub section: OverviewSection,
    pub text: String,
    pub epistemic_status: EpistemicStatus,
    pub source_refs: Vec<SourceRef>,
    pub dependency_item_ids: Vec<String>,
    pub valid_state: ValidState,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCoverage {
    pub processed: u64,
    pub partial: u64,
    pub excluded: u64,
    pub unsupported: u64,
    pub pending: u64,
}

/// AI-maintained knowledge only. Never mapped to projects.summary or workspace_notes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiOverview {
    pub scope: Scope,
    pub revision: u64,
    pub schema_version: u32,
    pub items: Vec<OverviewItem>,
    pub as_of_seq: u64,
    pub source_manifest_hash: String,
    pub built_at: String,
    pub coverage: SourceCoverage,
    pub pending_count: u64,
    pub model_profile_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeIdentity {
    pub scope: Scope,
    pub name: String,
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeStatus {
    NotBuilt,
    Partial,
    Ready,
    Stale,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCard {
    pub node_id: String,
    pub title: String,
    pub one_line: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextEntry {
    pub identity: ScopeIdentity,
    pub status: KnowledgeStatus,
    pub overview_updated_at: Option<String>,
    pub positioning: Option<String>,
    pub coverage: Option<SourceCoverage>,
    pub nodes: Vec<KnowledgeCard>,
    pub has_more: bool,
    /// Only methods that are implemented and authorized may appear here.
    pub available_reads: Vec<String>,
}

impl ContextEntry {
    pub fn not_built(identity: ScopeIdentity, budget_chars: Option<usize>) -> AgentResult<Self> {
        let budget = budget_chars
            .unwrap_or(CONTEXT_DEFAULT_CHARS)
            .min(CONTEXT_MAX_CHARS);
        let truncated = identity.name.chars().count() > 300;
        let identity = ScopeIdentity {
            name: identity.name.chars().take(300).collect(),
            ..identity
        };
        let mut entry = Self {
            identity,
            status: KnowledgeStatus::NotBuilt,
            overview_updated_at: None,
            positioning: None,
            coverage: None,
            nodes: vec![],
            has_more: truncated,
            available_reads: vec![],
        };
        // Account for the serialized data, including escaped text and metadata.
        while serialized_chars(&entry)? > budget {
            if entry.identity.name.pop().is_none() {
                return Err(AgentError::new(
                    ErrorCode::InvalidArgument,
                    "budgetChars cannot fit entry metadata",
                ));
            }
            entry.has_more = true;
        }
        Ok(entry)
    }
}

pub fn serialized_chars(value: &impl Serialize) -> AgentResult<usize> {
    serde_json::to_string(value)
        .map(|text| text.chars().count())
        .map_err(|_| {
            AgentError::new(
                ErrorCode::InvalidArgument,
                "Cannot serialize bounded content",
            )
        })
}

/// Character accounting is independent of the model's token-window accounting.
pub struct ReadBudget {
    limit: usize,
    used: usize,
}
impl ReadBudget {
    pub fn new(limit: Option<usize>) -> Self {
        Self {
            limit: limit.unwrap_or(RUN_DEFAULT_CHARS).min(RUN_MAX_CHARS),
            used: 0,
        }
    }
    pub fn charge(&mut self, data: &impl Serialize) -> AgentResult<()> {
        let chars = serialized_chars(data)?;
        if chars > self.limit.saturating_sub(self.used) {
            return Err(AgentError::new(
                ErrorCode::BudgetExceeded,
                "Run read budget exhausted",
            ));
        }
        self.used += chars;
        Ok(())
    }
    pub fn remaining(&self) -> usize {
        self.limit - self.used
    }
}
