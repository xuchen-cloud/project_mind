//! Read-only session summary projection over immutable knowledge snapshots.
//! The caller applies its existing session/source permission policy.
use super::{agent_operations::io_error, Database};
use crate::agent::overview::validate_id;
use crate::agent::{
    errors::{AgentError, AgentResult, ErrorCode},
    knowledge::{KnowledgeKind, KnowledgeNode},
    models::Scope,
};
use rusqlite::params;

impl Database {
    pub(crate) fn agent_session_summary_get(
        &self,
        scope: &Scope,
        session_id: &str,
        node_id: &str,
        revision: Option<u64>,
    ) -> AgentResult<Option<KnowledgeNode>> {
        let node = self.agent_knowledge_get(scope, node_id, revision)?;
        Ok(node.and_then(|node| {
            if node.kind != KnowledgeKind::SourceSummary {
                return None;
            }
            if node
                .session_summary
                .as_ref()
                .is_some_and(|segment| segment.session_id == session_id)
            {
                Some(node)
            } else {
                None
            }
        }))
    }

    pub(crate) fn agent_session_summary_list(
        &self,
        scope: &Scope,
        session_id: &str,
        limit: u16,
    ) -> AgentResult<Vec<KnowledgeNode>> {
        if session_id.is_empty() || session_id.len() > 128 || limit == 0 || limit > 100 {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid session summary selection",
            ));
        }
        scope.validate()?;
        self.source_live_scope(scope)?;
        self.agent_knowledge_prepare().map_err(|_| {
            AgentError::new(ErrorCode::IoFailed, "Cannot prepare knowledge storage")
        })?;
        // The JSON path is an optimization. Deserialize the immutable snapshot
        // and check scope/session/kind again before returning any payload.
        let mut statement = self.conn.prepare("SELECT v.snapshot_json FROM agent_knowledge_nodes n JOIN agent_knowledge_versions v ON v.scope_key=n.scope_key AND v.node_id=n.node_id AND v.revision=n.current_revision LEFT JOIN agent_session_search_rows m ON m.message_id=json_extract(v.snapshot_json,'$.sourceRefs[0].object.id') AND m.session_id=?2 WHERE n.scope_key=?1 AND n.deleted=0 AND n.kind='source_summary' AND json_extract(v.snapshot_json,'$.sessionSummary.sessionId')=?2 ORDER BY m.ordinal DESC, coalesce(json_extract(v.snapshot_json,'$.sessionSummary.startChar'),0) DESC, n.node_id LIMIT ?3").map_err(io_error)?;
        let rows = statement
            .query_map(params![scope.key(), session_id, limit as i64], |row| {
                row.get::<_, String>(0)
            })
            .map_err(io_error)?;
        let mut result = Vec::new();
        for row in rows {
            let raw = row.map_err(io_error)?;
            let node: KnowledgeNode = serde_json::from_str(&raw).map_err(|_| {
                AgentError::new(ErrorCode::IoFailed, "Invalid stored session summary")
            })?;
            if node.scope == *scope
                && node.kind == KnowledgeKind::SourceSummary
                && node
                    .session_summary
                    .as_ref()
                    .is_some_and(|segment| segment.session_id == session_id)
            {
                result.push(node);
            }
        }
        Ok(result)
    }

    /// Current same-session snapshots that explicitly supersede this segment.
    /// Caller must still apply the live source/session visibility check.
    pub(crate) fn agent_session_summary_successors(
        &self,
        scope: &Scope,
        session_id: &str,
        node_id: &str,
    ) -> AgentResult<Vec<KnowledgeNode>> {
        scope.validate()?;
        validate_id(node_id)?;
        if session_id.is_empty() || session_id.len() > 128 {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid session summary selection",
            ));
        }
        self.source_live_scope(scope)?;
        self.agent_knowledge_prepare().map_err(|_| {
            AgentError::new(ErrorCode::IoFailed, "Cannot prepare knowledge storage")
        })?;
        let mut statement = self.conn.prepare(
            "SELECT v.snapshot_json FROM agent_knowledge_nodes n JOIN agent_knowledge_versions v ON v.scope_key=n.scope_key AND v.node_id=n.node_id AND v.revision=n.current_revision JOIN json_each(v.snapshot_json,'$.sessionSummary.supersedes') j WHERE n.scope_key=?1 AND n.deleted=0 AND n.kind='source_summary' AND json_extract(v.snapshot_json,'$.sessionSummary.sessionId')=?2 AND j.value=?3 ORDER BY n.node_id LIMIT 20"
        ).map_err(io_error)?;
        let rows = statement
            .query_map(params![scope.key(), session_id, node_id], |row| {
                row.get::<_, String>(0)
            })
            .map_err(io_error)?;
        let mut result = Vec::new();
        for row in rows {
            let raw = row.map_err(io_error)?;
            let node: KnowledgeNode = serde_json::from_str(&raw).map_err(|_| {
                AgentError::new(ErrorCode::IoFailed, "Invalid stored session summary")
            })?;
            if node.scope == *scope
                && node.kind == KnowledgeKind::SourceSummary
                && node.session_summary.as_ref().is_some_and(|segment| {
                    segment.session_id == session_id
                        && segment.supersedes.iter().any(|id| id == node_id)
                })
            {
                result.push(node);
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
#[path = "source_session_summary_tests.rs"]
mod source_tests;
