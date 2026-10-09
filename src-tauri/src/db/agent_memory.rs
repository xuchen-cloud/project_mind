//! User-owned memory policy. Knowledge snapshots remain the only body store.
use super::{agent_operations::io_error, Database};
use crate::agent::{
    access::RequestContext,
    errors::{AgentError, AgentResult, ErrorCode},
    knowledge::{KnowledgeNode, KnowledgeNodeWrite},
    memory::{MemoryCategory, MemoryConfirmation, MemoryStatus},
    models::{ObjectKind, Scope, WorkspaceBinding},
    overview::validate_id,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryPolicySnapshot {
    pub revision: u64,
    pub confirmation: MemoryConfirmation,
    pub status: MemoryStatus,
    pub protected_correction: bool,
}

fn conflict() -> AgentError {
    AgentError::new(ErrorCode::RevisionConflict, "Memory policy changed")
}
fn category_key(value: MemoryCategory) -> AgentResult<String> {
    serde_json::to_value(value)
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid memory category"))?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| AgentError::new(ErrorCode::IoFailed, "Invalid memory category"))
}

impl Database {
    pub(crate) fn agent_memory_scope_epoch(&self, scope: &Scope) -> AgentResult<u64> {
        scope.validate()?;
        Ok(self
            .conn
            .query_row(
                "SELECT revision FROM agent_memory_scope_epochs WHERE scope_key=?1",
                [scope.key()],
                |r| r.get::<_, i64>(0),
            )
            .optional()
            .map_err(io_error)?
            .unwrap_or(0) as u64)
    }
    pub(crate) fn agent_memory_require_scope_epoch(
        &self,
        scope: &Scope,
        expected: u64,
    ) -> AgentResult<()> {
        if self.agent_memory_scope_epoch(scope)? != expected {
            return Err(conflict());
        }
        Ok(())
    }
    pub(crate) fn agent_memory_policy(
        &self,
        scope: &Scope,
        node_id: &str,
    ) -> AgentResult<Option<MemoryPolicySnapshot>> {
        scope.validate()?;
        validate_id(node_id)?;
        self.conn.query_row("SELECT revision,confirmation,status,protected_correction FROM agent_memory_policy WHERE scope_key=?1 AND node_id=?2",
            params![scope.key(),node_id],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?)))
            .optional().map_err(io_error)?.map(|(revision,confirmation,status,protected_correction)| {
                Ok(MemoryPolicySnapshot {revision:revision as u64,
                    confirmation:serde_json::from_str(&format!("\"{confirmation}\"")).map_err(|_|AgentError::new(ErrorCode::IoFailed,"Invalid memory confirmation"))?,
                    status:serde_json::from_str(&format!("\"{status}\"")).map_err(|_|AgentError::new(ErrorCode::IoFailed,"Invalid memory status"))?,
                    protected_correction:protected_correction != 0})
            }).transpose()
    }
    pub(crate) fn agent_memory_current_revision(
        &self,
        scope: &Scope,
        node_id: &str,
    ) -> AgentResult<Option<u64>> {
        Ok(self.conn.query_row("SELECT current_revision FROM agent_knowledge_nodes WHERE scope_key=?1 AND node_id=?2 AND deleted=0",
            params![scope.key(),node_id],|r|r.get::<_,i64>(0)).optional().map_err(io_error)?.map(|n|n as u64))
    }
    pub(crate) fn agent_memory_source_keys(
        &self,
        node: &KnowledgeNode,
    ) -> AgentResult<Vec<String>> {
        let mut keys: Vec<String> = Vec::new();
        let mut originals: Vec<crate::agent::models::SourceRef> = node.source_refs.clone();
        for parent in &node.published_sources {
            // A disabled, stale node still suppresses its captured original evidence.
            // Walk the immutable parent version, not the now-changed current item.
            let text:Option<String>=self.conn.query_row("SELECT snapshot_json FROM agent_overview_versions WHERE scope_key=?1 AND revision=?2",
                params![Scope::Project{project_id:parent.project_id}.key(),parent.revision as i64],|r|r.get(0)).optional().map_err(io_error)?;
            let snapshot: crate::agent::context::AiOverview =
                serde_json::from_str(&text.ok_or_else(|| {
                    AgentError::new(
                        ErrorCode::SourceChanged,
                        "Published source version disappeared",
                    )
                })?)
                .map_err(|_| {
                    AgentError::new(ErrorCode::IoFailed, "Invalid published source version")
                })?;
            let mut pending = vec![parent.item_id.clone()];
            let mut seen = std::collections::HashSet::new();
            while let Some(id) = pending.pop() {
                if !seen.insert(id.clone()) {
                    continue;
                }
                let item = snapshot
                    .items
                    .iter()
                    .find(|item| item.id == id)
                    .ok_or_else(|| {
                        AgentError::new(
                            ErrorCode::SourceChanged,
                            "Published source item disappeared",
                        )
                    })?;
                originals.extend(item.source_refs.iter().cloned());
                pending.extend(item.dependency_item_ids.iter().cloned());
            }
        }
        for source in originals {
            keys.push(source.object.key()?);
            if source.object.kind == ObjectKind::SessionMessage {
                let run_id: Option<String> = self
                    .conn
                    .query_row(
                        "SELECT run_id FROM agent_messages WHERE id=?1 AND role='assistant'",
                        [&source.object.id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(io_error)?
                    .flatten();
                if let Some(run_id) = run_id {
                    keys.extend(self.agent_run_raw_source_keys(&run_id)?);
                }
            }
        }
        keys.sort();
        keys.dedup();
        Ok(keys)
    }
    pub(crate) fn agent_memory_suppressed_by(
        &self,
        scope: &Scope,
        node: &KnowledgeNode,
    ) -> AgentResult<Vec<String>> {
        let Some(memory) = &node.memory else {
            return Ok(vec![]);
        };
        let keys = self.agent_memory_source_keys(node)?;
        let category = category_key(memory.category)?;
        self.agent_memory_suppressed_by_keys(scope, &category, &keys)
    }
    fn agent_memory_suppressed_by_keys(
        &self,
        scope: &Scope,
        category: &str,
        keys: &[String],
    ) -> AgentResult<Vec<String>> {
        let mut owners = vec![];
        for key in keys {
            let mut stmt=self.conn.prepare("SELECT owner_node_id FROM agent_memory_suppressions WHERE scope_key=?1 AND category=?2 AND source_key=?3 ORDER BY owner_node_id").map_err(io_error)?;
            owners.extend(
                stmt.query_map(params![scope.key(), category, key], |r| {
                    r.get::<_, String>(0)
                })
                .map_err(io_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(io_error)?,
            );
        }
        owners.sort();
        owners.dedup();
        Ok(owners)
    }
    pub(crate) fn agent_memory_suppressed_write(
        &self,
        scope: &Scope,
        node: &KnowledgeNodeWrite,
    ) -> AgentResult<bool> {
        let saved = node.snapshot(scope, String::new());
        let keys = self.agent_memory_source_keys(&saved)?;
        if keys.is_empty() {
            return Ok(true);
        }
        let category = category_key(node.memory.as_ref().ok_or_else(|| {
            AgentError::new(ErrorCode::InvalidArgument, "Not a memory node")
        })?.category)?;
        Ok(!self.agent_memory_suppressed_by_keys(scope, &category, &keys)?.is_empty())
    }
    pub(crate) fn agent_memory_model_visible(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        node: &KnowledgeNode,
    ) -> AgentResult<bool> {
        if node.memory.is_none() {
            return Ok(true);
        }
        if self.agent_memory_current_revision(&node.scope, &node.node_id)? != Some(node.revision) {
            return Ok(false);
        }
        if self
            .agent_memory_policy(&node.scope, &node.node_id)?
            .is_some_and(|p| p.status == MemoryStatus::Disabled)
        {
            return Ok(false);
        }
        if !self
            .agent_memory_suppressed_by(&node.scope, node)?
            .is_empty()
        {
            return Ok(false);
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
                Err(error) if hidden(error.code) => return Ok(false),
                Err(error) => return Err(error),
            }
        }
        for parent in &node.published_sources {
            match crate::agent::source_trace::published_source_visible(self, &read, binding, parent)
            {
                Ok(_) => (),
                Err(error) if hidden(error.code) => return Ok(false),
                Err(error) => return Err(error),
            }
        }
        Ok(true)
    }
    pub(crate) fn agent_memory_proof_visible(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        scope: &Scope,
        node_id: &str,
        node_revision: u64,
        policy_revision: u64,
    ) -> AgentResult<bool> {
        if self.agent_memory_current_revision(scope, node_id)? != Some(node_revision) {
            return Ok(false);
        }
        if self
            .agent_memory_policy(scope, node_id)?
            .map_or(0, |p| p.revision)
            != policy_revision
        {
            return Ok(false);
        }
        let node = match self.agent_knowledge_get(scope, node_id, Some(node_revision)) {
            Ok(Some(node)) => node,
            Ok(None) => return Ok(false),
            Err(error) if hidden(error.code) => return Ok(false),
            Err(error) => return Err(error),
        };
        self.agent_memory_model_visible(request, binding, &node)
    }
    pub(crate) fn agent_memory_bump_epoch(&self, scope: &Scope) -> AgentResult<u64> {
        self.conn.execute("INSERT INTO agent_memory_scope_epochs(scope_key,revision) VALUES(?1,1) ON CONFLICT(scope_key) DO UPDATE SET revision=revision+1",[scope.key()]).map_err(io_error)?;
        self.agent_memory_scope_epoch(scope)
    }
    pub(crate) fn agent_memory_policy_save(
        &self,
        scope: &Scope,
        node_id: &str,
        expected: u64,
        confirmation: MemoryConfirmation,
        status: MemoryStatus,
        protected_correction: bool,
    ) -> AgentResult<u64> {
        let current = self
            .agent_memory_policy(scope, node_id)?
            .map_or(0, |p| p.revision);
        if current != expected {
            return Err(conflict());
        }
        let revision = current + 1;
        let confirmation = serde_json::to_value(confirmation)
            .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid confirmation"))?;
        let status = serde_json::to_value(status)
            .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid status"))?;
        self.conn.execute("INSERT INTO agent_memory_policy(scope_key,node_id,revision,confirmation,status,protected_correction) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(scope_key,node_id) DO UPDATE SET revision=excluded.revision,confirmation=excluded.confirmation,status=excluded.status,protected_correction=excluded.protected_correction",
            params![scope.key(),node_id,revision as i64,confirmation.as_str(),status.as_str(),protected_correction as i64]).map_err(io_error)?;
        self.agent_memory_bump_epoch(scope)?;
        Ok(revision)
    }
    pub(crate) fn agent_memory_replace_suppressions(
        &self,
        scope: &Scope,
        node: &KnowledgeNode,
        disable: bool,
    ) -> AgentResult<()> {
        self.conn
            .execute(
                "DELETE FROM agent_memory_suppressions WHERE scope_key=?1 AND owner_node_id=?2",
                params![scope.key(), node.node_id],
            )
            .map_err(io_error)?;
        if disable {
            let category = category_key(
                node.memory
                    .as_ref()
                    .ok_or_else(|| {
                        AgentError::new(ErrorCode::InvalidArgument, "Not a memory node")
                    })?
                    .category,
            )?;
            for key in self.agent_memory_source_keys(node)? {
                self.conn.execute("INSERT INTO agent_memory_suppressions(scope_key,owner_node_id,category,source_key) VALUES(?1,?2,?3,?4)",params![scope.key(),node.node_id,category,key]).map_err(io_error)?;
            }
        }
        Ok(())
    }
    pub(crate) fn agent_memory_index_sources(&self, node: &KnowledgeNode) -> AgentResult<()> {
        self.conn
            .execute(
                "DELETE FROM agent_memory_node_sources WHERE scope_key=?1 AND node_id=?2",
                params![node.scope.key(), node.node_id],
            )
            .map_err(io_error)?;
        if let Some(metadata) = &node.memory {
            let category = category_key(metadata.category)?;
            for key in self.agent_memory_source_keys(node)? {
                self.conn.execute("INSERT INTO agent_memory_node_sources(scope_key,node_id,category,source_key) VALUES(?1,?2,?3,?4)",params![node.scope.key(),node.node_id,category,key]).map_err(io_error)?;
            }
        }
        Ok(())
    }
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
