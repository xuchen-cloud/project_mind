//! Deterministic Overview snapshots and independent, unmodified user corrections.
use super::{
    context::{EpistemicStatus, OverviewItem, SourceCoverage},
    errors::{AgentError, AgentResult, ErrorCode},
    models::Scope,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverviewPublishInput {
    pub scope: Scope,
    pub expected_revision: u64,
    pub target_seq: u64,
    pub policy_revision: u64,
    pub correction_revision: u64,
    pub upsert_items: Vec<OverviewItem>,
    pub remove_item_ids: Vec<String>,
    pub coverage: SourceCoverage,
    pub source_manifest_hash: String,
    pub model_profile_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewCorrection {
    pub id: String,
    pub scope: Scope,
    pub item_id: Option<String>,
    pub text: String,
    pub revision: u64,
    pub deleted: bool,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewCorrections {
    pub scope: Scope,
    pub revision: u64,
    pub items: Vec<OverviewCorrection>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverviewCorrectionUpsert {
    pub scope: Scope,
    pub id: String,
    pub item_id: Option<String>,
    pub text: String,
    pub expected_revision: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverviewCorrectionDelete {
    pub scope: Scope,
    pub id: String,
    pub expected_revision: u64,
}

pub(crate) fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
pub(crate) fn validate_id(id: &str) -> AgentResult<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err(invalid("Invalid Overview item/correction ID"));
    }
    Ok(())
}
impl OverviewPublishInput {
    pub(crate) fn validate(&self) -> AgentResult<()> {
        self.scope.validate()?;
        if [
            self.expected_revision,
            self.target_seq,
            self.policy_revision,
            self.correction_revision,
        ]
        .iter()
        .any(|v| *v >= i64::MAX as u64)
        {
            return Err(invalid("Invalid Overview revision"));
        }
        if self.upsert_items.len() > 100
            || self.remove_item_ids.len() > 100
            || self.source_manifest_hash.len() > 128
            || self.source_manifest_hash.is_empty()
            || self.model_profile_id.is_empty()
            || self.model_profile_id.len() > 128
        {
            return Err(invalid("Overview metadata exceeds bounds"));
        }
        let mut ids = HashSet::new();
        for item in &self.upsert_items {
            validate_id(&item.id)?;
            if !ids.insert(&item.id) {
                return Err(invalid("Duplicate Overview item ID"));
            }
            if matches!(item.epistemic_status, EpistemicStatus::UserConfirmed) {
                return Err(invalid("Model output cannot assert user_confirmed"));
            }
            if matches!(item.epistemic_status, EpistemicStatus::Recorded)
                && item.source_refs.is_empty()
                && item.dependency_item_ids.is_empty()
            {
                return Err(invalid("Recorded Overview items require evidence"));
            }
            if item.source_refs.len() > 20
                || item.dependency_item_ids.len() > 20
                || item.updated_at.len() > 64
            {
                return Err(invalid("Overview item metadata exceeds bounds"));
            }
            for id in &item.dependency_item_ids {
                validate_id(id)?;
            }
            for source in &item.source_refs {
                source.object.key()?;
                if source.object.scope != self.scope
                    || source.revision.len() > 128
                    || source.title.chars().count() > 1000
                    || source.excerpt.chars().count() > 2000
                    || serde_json::to_string(source)
                        .map_err(|_| invalid("Invalid source reference"))?
                        .chars()
                        .count()
                        > 5000
                {
                    return Err(invalid("Overview source metadata exceeds bounds or scope"));
                }
            }
        }
        for id in &self.remove_item_ids {
            validate_id(id)?;
            if !ids.insert(id) {
                return Err(invalid("Repeated or overlapping Overview item mutation"));
            }
        }
        Ok(())
    }
}
pub(crate) fn validate_snapshot(items: &[OverviewItem]) -> AgentResult<()> {
    if items.len() > 100 || items.iter().map(|i| i.text.chars().count()).sum::<usize>() > 8000 {
        return Err(AgentError::new(
            ErrorCode::BudgetExceeded,
            "Project Overview exceeds storage budget",
        ));
    }
    let ids: HashSet<_> = items.iter().map(|i| &i.id).collect();
    if ids.len() != items.len()
        || items.iter().any(|i| {
            i.dependency_item_ids
                .iter()
                .any(|id| !ids.contains(id) || id == &i.id)
        })
    {
        return Err(invalid("Dangling or self Overview item dependency"));
    }
    // Bounded closure detects cycles without introducing a generic graph engine.
    for item in items {
        let mut pending = item.dependency_item_ids.clone();
        let mut visited = HashSet::new();
        let mut has_evidence = !item.source_refs.is_empty();
        while let Some(id) = pending.pop() {
            if id == item.id {
                return Err(invalid("Cyclic Overview item dependency"));
            }
            if visited.insert(id.clone()) {
                if let Some(parent) = items.iter().find(|i| i.id == id) {
                    has_evidence |= !parent.source_refs.is_empty();
                    pending.extend(parent.dependency_item_ids.clone());
                }
            }
        }
        if matches!(item.epistemic_status, EpistemicStatus::Recorded) && !has_evidence {
            return Err(invalid(
                "Recorded Overview dependency chain has no original evidence",
            ));
        }
    }
    Ok(())
}
