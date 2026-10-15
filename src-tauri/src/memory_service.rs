//! GUI-only management of user-owned long-term memory policy.
use crate::{
    agent::{
        access::{Caller, RequestContext},
        errors::{AgentError, AgentResult, ErrorCode},
        knowledge::{KnowledgeBodySection, KnowledgeNode, KnowledgeNodeWrite},
        memory::{MemoryCategory, MemoryConfirmation, MemorySourceState, MemoryStatus},
        models::{Scope, SourceRef, WorkspaceBinding},
        overview::validate_id,
    },
    db::{agent_operations::io_error, Database},
};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemoryListInput {
    pub scope: Scope,
    pub cursor: Option<String>,
    pub limit: Option<u16>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemoryGetInput {
    pub scope: Scope,
    pub node_id: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemoryCorrection {
    pub title: String,
    pub one_line: String,
    pub summary: String,
    pub body_sections: Vec<KnowledgeBodySection>,
}
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MemoryAction {
    Confirm,
    Correct,
    Disable,
    Reenable,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemoryUpdateInput {
    pub scope: Scope,
    pub node_id: String,
    pub expected_node_revision: u64,
    pub expected_policy_revision: u64,
    pub action: MemoryAction,
    pub correction: Option<MemoryCorrection>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemorySuppressor {
    pub node_id: String,
    pub title: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryCard {
    pub node_id: String,
    pub node_revision: u64,
    pub policy_revision: u64,
    pub category: MemoryCategory,
    pub title: String,
    pub one_line: String,
    pub confirmation: MemoryConfirmation,
    pub status: MemoryStatus,
    pub source_state: MemorySourceState,
    pub last_supported_at: String,
    pub suppressed_by: Vec<MemorySuppressor>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryDetail {
    #[serde(flatten)]
    pub card: MemoryCard,
    pub summary: String,
    pub body_sections: Vec<KnowledgeBodySection>,
    pub source_refs: Vec<SourceRef>,
    pub published_sources: Vec<crate::agent::context::PublishedOverviewRef>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryListPage {
    pub items: Vec<MemoryCard>,
    pub next_cursor: Option<String>,
}

fn denied() -> AgentError {
    AgentError::new(
        ErrorCode::ScopeDenied,
        "Memory management requires the current GUI Workspace",
    )
}
fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn missing() -> AgentError {
    AgentError::new(ErrorCode::NotFound, "Memory node not found")
}
fn changed() -> AgentError {
    AgentError::new(ErrorCode::RevisionConflict, "Memory node or policy changed")
}
fn hidden(code: ErrorCode) -> bool {
    matches!(
        code,
        ErrorCode::NotFound
            | ErrorCode::ScopeDenied
            | ErrorCode::ObjectWithdrawn
            | ErrorCode::SourceNotReady
            | ErrorCode::SourceChanged
    )
}

impl Database {
    fn memory_gui_authorize(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        scope: &Scope,
    ) -> AgentResult<()> {
        if !matches!(request.caller, Caller::Gui) {
            return Err(denied());
        }
        request.authorize(binding, scope, "memory.manage")?;
        if self
            .native_workspace_id
            .as_deref()
            .is_some_and(|id| id != binding.workspace_id)
        {
            return Err(denied());
        }
        scope.validate()?;
        Ok(())
    }
    pub(crate) fn agent_memory_node(
        &self,
        scope: &Scope,
        node_id: &str,
    ) -> AgentResult<KnowledgeNode> {
        let text:Option<String>=self.conn.query_row("SELECT v.snapshot_json FROM agent_knowledge_nodes n JOIN agent_knowledge_versions v ON v.scope_key=n.scope_key AND v.node_id=n.node_id AND v.revision=n.current_revision WHERE n.scope_key=?1 AND n.node_id=?2 AND n.deleted=0 AND n.kind='memory'",
            params![scope.key(),node_id],|r|r.get(0)).optional().map_err(io_error)?;
        serde_json::from_str(&text.ok_or_else(missing)?)
            .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid stored memory node"))
    }
    fn memory_source_state(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        node: &KnowledgeNode,
    ) -> AgentResult<MemorySourceState> {
        let mut project_ids = std::collections::HashSet::new();
        if let Scope::Project { project_id } = &node.scope {
            project_ids.insert(*project_id);
        }
        for source in &node.source_refs {
            if let Scope::Project { project_id } = &source.object.scope {
                project_ids.insert(*project_id);
            }
        }
        for parent in &node.published_sources {
            project_ids.insert(parent.project_id);
        }
        let mut missing_project = false;
        for project_id in project_ids {
            let archived: Option<bool> = self
                .conn
                .query_row(
                    "SELECT is_archived FROM projects WHERE id=?1",
                    [project_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(io_error)?;
            if archived == Some(true) {
                return Ok(MemorySourceState::Archived);
            }
            if archived.is_none() {
                missing_project = true;
            }
        }
        if missing_project {
            return Ok(MemorySourceState::Unavailable);
        }
        let mut read = request.clone();
        if !read
            .scope_grant
            .operations
            .iter()
            .any(|op| op == "source.read")
        {
            read.scope_grant.operations.push("source.read".into());
        }
        for source in &node.source_refs {
            match crate::agent::source_trace::derived_source_visible(self, &read, binding, source) {
                Ok(()) => (),
                Err(error) if hidden(error.code) => return Ok(MemorySourceState::Unavailable),
                Err(error) => return Err(error),
            }
        }
        for parent in &node.published_sources {
            match crate::agent::source_trace::published_source_visible(self, &read, binding, parent)
            {
                Ok(_) => (),
                Err(error) if hidden(error.code) => return Ok(MemorySourceState::Unavailable),
                Err(error) => return Err(error),
            }
        }
        if !self
            .agent_knowledge_stale_ids(&binding.workspace_id, &node.scope, &[node.node_id.clone()])?
            .is_empty()
        {
            return Ok(MemorySourceState::Stale);
        }
        Ok(MemorySourceState::Current)
    }
    fn memory_card(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        node: &KnowledgeNode,
    ) -> AgentResult<MemoryCard> {
        let metadata = node.memory.as_ref().ok_or_else(missing)?;
        let policy = self.agent_memory_policy(&node.scope, &node.node_id)?;
        let owners = self.agent_memory_suppressed_by(&node.scope, node)?;
        let mut suppressed_by = Vec::new();
        for owner in owners {
            if owner == node.node_id {
                continue;
            }
            let title:Option<String>=self.conn.query_row("SELECT json_extract(v.snapshot_json,'$.title') FROM agent_knowledge_nodes n JOIN agent_knowledge_versions v ON v.scope_key=n.scope_key AND v.node_id=n.node_id AND v.revision=n.current_revision WHERE n.scope_key=?1 AND n.node_id=?2",
                params![node.scope.key(),owner],|r|r.get(0)).optional().map_err(io_error)?;
            suppressed_by.push(MemorySuppressor {
                node_id: format!("node:{owner}"),
                title: title.unwrap_or(owner),
            });
        }
        Ok(MemoryCard {
            node_id: format!("node:{}", node.node_id),
            node_revision: node.revision,
            policy_revision: policy.as_ref().map_or(0, |p| p.revision),
            category: metadata.category,
            title: node.title.clone(),
            one_line: node.one_line.clone(),
            confirmation: policy
                .as_ref()
                .map_or(MemoryConfirmation::Inferred, |p| p.confirmation),
            status: policy.as_ref().map_or(MemoryStatus::Enabled, |p| p.status),
            source_state: self.memory_source_state(request, binding, node)?,
            last_supported_at: metadata.last_supported_at.clone(),
            suppressed_by,
        })
    }
    fn memory_detail(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        node: &KnowledgeNode,
    ) -> AgentResult<MemoryDetail> {
        let card = self.memory_card(request, binding, node)?;
        Ok(MemoryDetail {
            card,
            summary: node.summary.clone(),
            body_sections: node.body_sections.clone(),
            source_refs: node.source_refs.clone(),
            published_sources: node.published_sources.clone(),
        })
    }
    pub(crate) fn agent_memory_list(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &MemoryListInput,
    ) -> AgentResult<MemoryListPage> {
        self.memory_gui_authorize(request, binding, &input.scope)?;
        let limit = input.limit.unwrap_or(20);
        if !(1..=50).contains(&limit) {
            return Err(invalid("Invalid memory page limit"));
        }
        let after = match &input.cursor {
            Some(cursor) => Some(
                cursor
                    .strip_prefix("node:")
                    .ok_or_else(|| invalid("Invalid memory cursor"))?,
            ),
            None => None,
        };
        if let Some(after) = after {
            validate_id(after)?;
        }
        let mut stmt=self.conn.prepare("SELECT v.snapshot_json FROM agent_knowledge_nodes n JOIN agent_knowledge_versions v ON v.scope_key=n.scope_key AND v.node_id=n.node_id AND v.revision=n.current_revision WHERE n.scope_key=?1 AND n.kind='memory' AND n.deleted=0 AND n.node_id>?2 ORDER BY n.node_id LIMIT ?3").map_err(io_error)?;
        let texts = stmt
            .query_map(
                params![input.scope.key(), after.unwrap_or(""), i64::from(limit) + 1],
                |r| r.get::<_, String>(0),
            )
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error)?;
        let has_more = texts.len() > limit as usize;
        let mut items = Vec::new();
        for text in texts.into_iter().take(limit as usize) {
            let node: KnowledgeNode = serde_json::from_str(&text)
                .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid memory snapshot"))?;
            items.push(self.memory_card(request, binding, &node)?);
        }
        let next_cursor = has_more
            .then(|| items.last().map(|i| i.node_id.clone()))
            .flatten();
        Ok(MemoryListPage { items, next_cursor })
    }
    pub(crate) fn agent_memory_get(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &MemoryGetInput,
    ) -> AgentResult<MemoryDetail> {
        self.memory_gui_authorize(request, binding, &input.scope)?;
        let id = input
            .node_id
            .strip_prefix("node:")
            .ok_or_else(|| invalid("Invalid memory node ID"))?;
        validate_id(id)?;
        self.memory_detail(request, binding, &self.agent_memory_node(&input.scope, id)?)
    }
    pub(crate) fn agent_memory_update(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &MemoryUpdateInput,
    ) -> AgentResult<MemoryDetail> {
        self.memory_gui_authorize(request, binding, &input.scope)?;
        let id = input
            .node_id
            .strip_prefix("node:")
            .ok_or_else(|| invalid("Invalid memory node ID"))?;
        validate_id(id)?;
        if matches!(input.action, MemoryAction::Correct) != input.correction.is_some() {
            return Err(invalid("Correction payload does not match action"));
        }
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let mut node = self.agent_memory_node(&input.scope, id)?;
        let policy = self.agent_memory_policy(&input.scope, id)?;
        if node.revision != input.expected_node_revision
            || policy.as_ref().map_or(0, |p| p.revision) != input.expected_policy_revision
        {
            return Err(changed());
        }
        let source_state = self.memory_source_state(request, binding, &node)?;
        match input.action {
            MemoryAction::Confirm if source_state != MemorySourceState::Current => {
                return Err(AgentError::new(
                    ErrorCode::SourceNotReady,
                    "Current evidence is required for confirmation",
                ))
            }
            MemoryAction::Correct
                if !matches!(
                    source_state,
                    MemorySourceState::Current | MemorySourceState::Stale
                ) =>
            {
                return Err(AgentError::new(
                    ErrorCode::SourceNotReady,
                    "Memory evidence is unavailable",
                ))
            }
            _ => (),
        }
        let mut confirmation = policy
            .as_ref()
            .map_or(MemoryConfirmation::Inferred, |p| p.confirmation);
        let mut status = policy.as_ref().map_or(MemoryStatus::Enabled, |p| p.status);
        let mut protected_correction = policy.as_ref().is_some_and(|p| p.protected_correction);
        match input.action {
            MemoryAction::Confirm => confirmation = MemoryConfirmation::UserConfirmed,
            MemoryAction::Correct => {
                let correction = input
                    .correction
                    .as_ref()
                    .ok_or_else(|| invalid("Missing correction"))?;
                KnowledgeNodeWrite {
                    node_id: node.node_id.clone(),
                    expected_revision: node.revision,
                    kind: node.kind,
                    title: correction.title.clone(),
                    one_line: correction.one_line.clone(),
                    summary: correction.summary.clone(),
                    body_sections: correction.body_sections.clone(),
                    aliases: node.aliases.clone(),
                    keywords: node.keywords.clone(),
                    source_refs: node.source_refs.clone(),
                    published_sources: node.published_sources.clone(),
                    epistemic_status: node.epistemic_status.clone(),
                    coverage: node.coverage.clone(),
                    related: node.related.clone(),
                    session_summary: node.session_summary.clone(),
                    memory: node.memory.clone(),
                }
                .validate(&input.scope)?;
                let baseline:i64=self.conn.query_row("SELECT overview_revision FROM agent_knowledge_versions WHERE scope_key=?1 AND node_id=?2 AND revision=?3",
                    params![input.scope.key(),id,node.revision as i64],|r|r.get(0)).map_err(io_error)?;
                node.revision += 1;
                node.title = correction.title.clone();
                node.one_line = correction.one_line.clone();
                node.summary = correction.summary.clone();
                node.body_sections = correction.body_sections.clone();
                node.updated_at = Utc::now().to_rfc3339();
                self.conn.execute("INSERT INTO agent_knowledge_versions(scope_key,node_id,revision,overview_revision,snapshot_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
                    params![input.scope.key(),id,node.revision as i64,baseline,serde_json::to_string(&node).map_err(|_|invalid("Invalid memory correction"))?,node.updated_at]).map_err(io_error)?;
                self.conn.execute("UPDATE agent_knowledge_nodes SET current_revision=?3,updated_at=?4 WHERE scope_key=?1 AND node_id=?2",params![input.scope.key(),id,node.revision as i64,node.updated_at]).map_err(io_error)?;
                self.conn
                    .execute(
                        "DELETE FROM agent_knowledge_fts WHERE scope_key=?1 AND node_id=?2",
                        params![input.scope.key(), id],
                    )
                    .map_err(io_error)?;
                self.conn.execute("INSERT INTO agent_knowledge_fts(scope_key,node_id,title,aliases,keywords,one_line) VALUES(?1,?2,?3,?4,?5,?6)",
                    params![input.scope.key(),id,node.title,node.aliases.join("\n"),node.keywords.join("\n"),node.one_line]).map_err(io_error)?;
                confirmation = MemoryConfirmation::UserConfirmed;
                protected_correction = true;
            }
            MemoryAction::Disable => {
                status = MemoryStatus::Disabled;
                self.agent_memory_replace_suppressions(&input.scope, &node, true)?;
            }
            MemoryAction::Reenable => {
                status = MemoryStatus::Enabled;
                self.agent_memory_replace_suppressions(&input.scope, &node, false)?;
            }
        }
        self.agent_memory_policy_save(
            &input.scope,
            id,
            input.expected_policy_revision,
            confirmation,
            status,
            protected_correction,
        )?;
        tx.commit().map_err(io_error)?;
        self.memory_detail(request, binding, &node)
    }
}
