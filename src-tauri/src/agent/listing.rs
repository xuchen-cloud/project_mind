//! Shared inventory modes, filters and safe response budgeting.
use super::errors::{AgentError, AgentResult, ErrorCode};
use serde::{Deserialize, Serialize};

#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ListMode {
    #[default]
    Metadata,
    Detail,
}

pub(crate) fn validate_filters(
    ids: &[String],
    title: Option<&str>,
    content: Option<&str>,
) -> AgentResult<()> {
    if ids.len() > 50
        || ids.iter().any(|id| id.is_empty() || id.len() > 128)
        || [title, content]
            .into_iter()
            .flatten()
            .any(|query| query.trim().is_empty() || query.chars().count() > 256)
    {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Invalid list IDs or query (maximum 50 IDs and 256 query characters)",
        ));
    }
    Ok(())
}

pub(crate) fn budget_error(title: &str, object: serde_json::Value, required: usize) -> AgentError {
    AgentError::new(ErrorCode::BudgetExceeded, "List item does not fit the response budget; increase budgetChars or use metadata mode")
        .with_details(serde_json::json!({"title":title.chars().take(120).collect::<String>(),"object":object,"minimumBudgetChars":required}))
}
