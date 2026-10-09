//! Source-grounded knowledge snapshots published with their Overview revision.
use super::{
    context::{EpistemicStatus, SourceCoverage, ValidState},
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, Scope, SourceLocator, SourceRef},
    memory::MemoryMetadata,
    overview::{invalid, validate_id},
    sessions::SessionSummarySegment,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub(crate) fn published_node_prefix(project_id: i64, item_id: &str) -> String {
    let digest = Sha256::digest(format!("{project_id}:{item_id}").as_bytes());
    format!("published-{digest:x}-")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeKind {
    Topic,
    Decision,
    SourceSummary,
    Memory,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeRelation {
    Related,
    Supports,
    Contradicts,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeBodySection {
    pub id: String,
    pub title: String,
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeRelated {
    pub node_id: String,
    pub revision: u64,
    pub relation: KnowledgeRelation,
    pub reason: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeNodeWrite {
    pub node_id: String,
    pub expected_revision: u64,
    pub kind: KnowledgeKind,
    pub title: String,
    pub one_line: String,
    pub summary: String,
    pub body_sections: Vec<KnowledgeBodySection>,
    pub aliases: Vec<String>,
    pub keywords: Vec<String>,
    pub source_refs: Vec<SourceRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub published_sources: Vec<super::context::PublishedOverviewRef>,
    pub epistemic_status: EpistemicStatus,
    pub coverage: SourceCoverage,
    pub related: Vec<KnowledgeRelated>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_summary: Option<SessionSummarySegment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<MemoryMetadata>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeNode {
    pub node_id: String,
    pub scope: Scope,
    pub revision: u64,
    pub kind: KnowledgeKind,
    pub title: String,
    pub one_line: String,
    pub summary: String,
    pub body_sections: Vec<KnowledgeBodySection>,
    pub aliases: Vec<String>,
    pub keywords: Vec<String>,
    pub source_refs: Vec<SourceRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub published_sources: Vec<super::context::PublishedOverviewRef>,
    pub epistemic_status: EpistemicStatus,
    pub coverage: SourceCoverage,
    pub related: Vec<KnowledgeRelated>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_summary: Option<SessionSummarySegment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<MemoryMetadata>,
    pub updated_at: String,
    pub valid_state: ValidState,
}
impl KnowledgeNodeWrite {
    pub(crate) fn text_chars(&self) -> usize {
        self.title.chars().count()
            + self.one_line.chars().count()
            + self.summary.chars().count()
            + self
                .body_sections
                .iter()
                .map(|s| s.title.chars().count() + s.text.chars().count())
                .sum::<usize>()
            + self
                .aliases
                .iter()
                .chain(&self.keywords)
                .map(|s| s.chars().count())
                .sum::<usize>()
            + self
                .related
                .iter()
                .map(|r| r.reason.chars().count())
                .sum::<usize>()
            + self.session_summary.as_ref().map_or(0, |segment| segment.summary.chars().count() + segment.statements.iter().map(|statement| statement.text.chars().count()).sum::<usize>())
    }
    pub(crate) fn validate(&self, scope: &Scope) -> AgentResult<()> {
        validate_id(&self.node_id)?;
        if self.expected_revision >= i64::MAX as u64
            || self.title.is_empty()
            || self.title.chars().count() > 200
            || self.one_line.chars().count() > 300
            || self.summary.chars().count() > (if self.session_summary.is_some() { 2500 } else { 2000 })
            || self.body_sections.len() > 20
            || self.aliases.len() > 20
            || self.keywords.len() > 20
            || self.related.len() > 5
            || self.source_refs.len() > (if self.session_summary.is_some() { 256 } else { 20 })
            || self.published_sources.len() > 20
        {
            return Err(invalid("Knowledge metadata exceeds bounds"));
        }
        if self.summary.chars().count()
            + self
                .body_sections
                .iter()
                .map(|s| s.text.chars().count())
                .sum::<usize>()
            > 8000
        {
            return Err(AgentError::new(
                ErrorCode::BudgetExceeded,
                "Knowledge body exceeds storage budget",
            ));
        }
        if matches!(self.epistemic_status, EpistemicStatus::UserConfirmed) {
            return Err(invalid("Model knowledge cannot assert user_confirmed"));
        }
        if (self.kind == KnowledgeKind::Memory) != self.memory.is_some()
            || self.memory.as_ref().is_some_and(|memory| {
                memory.last_supported_at.is_empty()
                    || memory.last_supported_at.len() > 64
                    || chrono::DateTime::parse_from_rfc3339(&memory.last_supported_at).is_err()
            })
        {
            return Err(invalid("Invalid memory metadata"));
        }
        if self.kind == KnowledgeKind::Memory && self.source_refs.is_empty() && self.published_sources.is_empty() {
            return Err(invalid("Memory requires native source evidence"));
        }
        if matches!(self.epistemic_status, EpistemicStatus::Recorded) && self.source_refs.is_empty() && self.published_sources.is_empty()
        {
            return Err(invalid(
                "Recorded knowledge requires direct source evidence",
            ));
        }
        let mut sections = HashSet::new();
        for section in &self.body_sections {
            validate_id(&section.id)?;
            if !sections.insert(&section.id) || section.title.chars().count() > 200 {
                return Err(invalid("Invalid knowledge body section"));
            }
        }
        if self
            .aliases
            .iter()
            .chain(&self.keywords)
            .any(|s| s.is_empty() || s.chars().count() > 100)
        {
            return Err(invalid("Knowledge search metadata exceeds bounds"));
        }
        for source in &self.source_refs {
            source.object.key()?;
            if &source.object.scope != scope
                || source.revision.is_empty()
                || source.revision.len() > 128
                || source.title.chars().count() > 1000
                || source.excerpt.chars().count() > 2000
                || serde_json::to_string(source)
                    .map_err(|_| invalid("Invalid source reference"))?
                    .chars()
                    .count()
                    > 5000
            {
                return Err(invalid("Knowledge source metadata exceeds bounds or scope"));
            }
        }
        if matches!(scope, Scope::Project { .. }) && !self.published_sources.is_empty() {
            return Err(invalid("Project knowledge cannot cite published items"));
        }
        for reference in &self.published_sources {
            super::overview::validate_published_ref(reference)?;
        }
        if self.kind == KnowledgeKind::SourceSummary && self.session_summary.is_none() {
            let sources = self
                .source_refs
                .iter()
                .map(|s| s.object.key())
                .collect::<AgentResult<HashSet<_>>>()?;
            if sources.len() != 1 {
                return Err(invalid("Source summary requires one source object"));
            }
        }
        if let Some(segment) = &self.session_summary {
            if self.kind != KnowledgeKind::SourceSummary || self.source_refs.is_empty() || segment.summary != self.summary
                || segment.id != self.node_id || segment.revision != self.expected_revision + 1
                || segment.statements.iter().any(|statement| {
                    statement.message_refs.is_empty() || statement.message_refs.iter().any(|message| {
                        message.scope != *scope || message.session_id != segment.session_id
                            || !statement.source_refs.iter().any(|source| {
                                source.object.kind == ObjectKind::SessionMessage
                                    && source.object.id == message.message_id
                                    && source.object.workspace_id == message.workspace_id
                                    && source.object.scope == message.scope
                                    && source.revision == message.content_hash
                                    && self.source_refs.iter().any(|node_source| node_source.object == source.object && node_source.revision == source.revision
                                        && matches!(&node_source.locator, Some(SourceLocator::Messages {session_id, branch_id, start_message_id, end_message_id})
                                            if session_id == &message.session_id && branch_id == &message.branch_id
                                            && start_message_id == &message.message_id && end_message_id == &message.message_id))
                                    && matches!(&source.locator, Some(SourceLocator::Messages {session_id, branch_id, start_message_id, end_message_id})
                                        if session_id == &message.session_id && branch_id == &message.branch_id
                                        && start_message_id == &message.message_id && end_message_id == &message.message_id)
                            })
                    })
                })
                || self.source_refs.iter().any(|source| source.object.kind != ObjectKind::SessionMessage
                    || !matches!(&source.locator, Some(SourceLocator::Messages {session_id, ..})
                        if session_id == &segment.session_id))
                || !matches!(self.source_refs.last().and_then(|source| source.locator.as_ref()),
                    Some(SourceLocator::Messages { branch_id, .. }) if branch_id == &segment.branch_id)
            {
                return Err(invalid("Invalid session summary knowledge node"));
            }
            segment.validate()?;
        }
        let mut related = HashSet::new();
        for edge in &self.related {
            validate_id(&edge.node_id)?;
            if edge.node_id == self.node_id
                || edge.revision == 0
                || edge.revision > i64::MAX as u64
                || edge.reason.chars().count() > 240
                || !related.insert((&edge.node_id, edge.revision))
            {
                return Err(invalid("Invalid related knowledge navigation"));
            }
        }
        Ok(())
    }
    pub(crate) fn snapshot(&self, scope: &Scope, updated_at: String) -> KnowledgeNode {
        KnowledgeNode {
            node_id: self.node_id.clone(),
            scope: scope.clone(),
            revision: self.expected_revision + 1,
            kind: self.kind,
            title: self.title.clone(),
            one_line: self.one_line.clone(),
            summary: self.summary.clone(),
            body_sections: self.body_sections.clone(),
            aliases: self.aliases.clone(),
            keywords: self.keywords.clone(),
            source_refs: self.source_refs.clone(),
            published_sources: self.published_sources.clone(),
            epistemic_status: self.epistemic_status.clone(),
            coverage: self.coverage.clone(),
            related: self.related.clone(),
            session_summary: self.session_summary.clone(),
            memory: self.memory.clone(),
            updated_at,
            valid_state: ValidState::Current,
        }
    }
}
pub(crate) fn validate_knowledge_batch(
    scope: &Scope,
    upserts: &[KnowledgeNodeWrite],
    removes: &[String],
) -> AgentResult<()> {
    if upserts.len() > 20
        || removes.len() > 20
        || upserts.iter().map(|n| n.text_chars()).sum::<usize>() > 48000
    {
        return Err(AgentError::new(
            ErrorCode::BudgetExceeded,
            "Knowledge publish batch exceeds budget",
        ));
    }
    let mut ids = HashSet::new();
    for node in upserts {
        node.validate(scope)?;
        if !ids.insert(&node.node_id) {
            return Err(invalid("Duplicate knowledge mutation"));
        }
    }
    for id in removes {
        validate_id(id)?;
        if !ids.insert(id) {
            return Err(invalid("Duplicate or overlapping knowledge mutation"));
        }
    }
    Ok(())
}
