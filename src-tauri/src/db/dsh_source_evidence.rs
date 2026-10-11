//! Evidence for successful deliveries by the real DSH runtime. Session/request
//! authorization belongs to the bridge; this service never creates Pi messages.
use super::{
    file_versions,
    project_directory_files::{FileBytesInput, FileServiceError},
    Database,
};
use crate::agent::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, Scope, SourceLocator, SourceRef, WorkspaceBinding},
};
use rusqlite::{params, Transaction, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

// Bound the combined serialized rows before opening the persistence transaction.
const MAX_EVIDENCE_BYTES: usize = 1024 * 1024;

fn storage_error(_: rusqlite::Error) -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Cannot persist DSH source evidence")
}
fn conflict() -> AgentError {
    AgentError::new(
        ErrorCode::IdempotencyConflict,
        "DSH delivery evidence differs from its persisted payload",
    )
}
fn identity(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}
fn json(value: &impl serde::Serialize) -> AgentResult<String> {
    serde_json::to_string(value)
        .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Invalid DSH evidence payload"))
}

impl Database {
    /// Call only after the exact final projection was successfully delivered to
    /// the model. The caller binds the real DSH Session, message/tool/request
    /// delivery ID and live runtime generation to the trusted Workspace/Project.
    /// `projection_hash` is the lowercase 64-digit SHA-256 of that final UTF-8
    /// projection; SourceRef revisions use the native `sha256:` prefix.
    /// Workspace generation is checked by the caller and is deliberately absent
    /// from the durable identity so reopening does not duplicate a delivery.
    /// Up to 128 refs, 1,000 title / 2,000 excerpt characters per ref and 1 MiB
    /// combined serialized evidence/locator/excerpt bytes are accepted.
    /// DSH owners have no Pi Session/message FK. The existing fixed-reference
    /// retention query protects Files by target key/revision regardless of this
    /// owner namespace; deleting a Session never cascades into a File.
    pub(crate) fn dsh_record_source_evidence(
        &self,
        binding: &WorkspaceBinding,
        project_id: i64,
        session_id: &str,
        delivery_id: &str,
        projection_hash: &str,
        source_refs: &[SourceRef],
    ) -> AgentResult<()> {
        let scope = Scope::Project { project_id };
        scope.validate()?;
        if !identity(session_id)
            || !identity(delivery_id)
            || !identity(&binding.generation)
            || projection_hash.len() != 64
            || !file_versions::valid_hash(&format!("sha256:{projection_hash}"))
            || source_refs.is_empty()
            || source_refs.len() > 128
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid DSH delivery context or digest",
            ));
        }
        if self.native_workspace_id.as_deref() != Some(&binding.workspace_id) {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "DSH evidence Workspace is no longer current",
            ));
        }
        let namespace = json(&(&binding.workspace_id, project_id, session_id, delivery_id))?;
        let owner = format!(
            "{}/{}/dsh_delivery/{:x}",
            binding.workspace_id,
            scope.key(),
            Sha256::digest(namespace.as_bytes())
        );
        let mut evidence = Vec::with_capacity(source_refs.len());
        let mut edges = BTreeSet::new();
        let mut payload_bytes = 0;
        for (ordinal, source) in source_refs.iter().enumerate() {
            let target = source.object.key()?;
            if source.object.workspace_id != binding.workspace_id || source.object.scope != scope {
                return Err(AgentError::new(
                    ErrorCode::ScopeDenied,
                    "DSH evidence source belongs to another scope",
                ));
            }
            if source.object.kind != ObjectKind::File
                || source.file_version.unwrap_or(0) == 0
                || !file_versions::valid_hash(&source.revision)
                || source.record_version.is_some()
                || source.block_id.is_some()
                || source.title.chars().count() > 1000
                || source.excerpt.chars().count() > 2000
                || !match &source.locator {
                    None => true,
                    Some(SourceLocator::Line { start, end } | SourceLocator::Paragraph { start, end }) => *start > 0 && end >= start,
                    Some(SourceLocator::Page { page, start, end }) => {
                        *page > 0 && end > start
                    }
                    _ => false,
                }
            {
                return Err(AgentError::new(
                    ErrorCode::InvalidArgument,
                    "DSH evidence requires a fixed File version and hash",
                ));
            }
            let source_json = json(source)?;
            let locator = json(&serde_json::json!({
                "sourceRef": source, "sessionId": session_id,
                "deliveryId": delivery_id, "projectionHash": projection_hash,
            }))?;
            payload_bytes += source_json.len() + locator.len() + source.excerpt.len();
            if payload_bytes > MAX_EVIDENCE_BYTES {
                return Err(AgentError::new(
                    ErrorCode::BudgetExceeded,
                    "DSH evidence exceeds its serialized byte budget",
                ));
            }
            evidence.push((
                format!("{owner}/{ordinal}"),
                source_json,
                source.excerpt.clone(),
            ));
            edges.insert((target, locator, source.revision.clone()));
        }
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let stored_evidence: Vec<(String, String, String)> = tx.prepare(
            "SELECT id,source_ref_json,excerpt FROM agent_evidence WHERE owner_kind='message' AND owner_id=?1 ORDER BY id"
        ).map_err(storage_error)?.query_map([&owner], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(storage_error)?.collect::<Result<_, _>>().map_err(storage_error)?;
        let stored_edges: BTreeSet<(String, String, String)> = tx.prepare(
            "SELECT target_object_key,locator_json,COALESCE(target_revision,'') FROM content_reference_edges WHERE source_object_key=?1 AND relation='evidence'"
        ).map_err(storage_error)?.query_map([&owner], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(storage_error)?.collect::<Result<_, _>>().map_err(storage_error)?;
        evidence.sort();
        let exists = !stored_evidence.is_empty() || !stored_edges.is_empty();
        if exists && (stored_evidence != evidence || stored_edges != edges) {
            return Err(conflict());
        }
        if exists {
            // The original transaction already proved the retained bytes. Replay
            // returns its durable success even if the source later becomes unavailable.
            return tx.commit().map_err(storage_error);
        }
        // Revalidate immutable snapshot bytes inside the same transaction as the
        // references. This reads retained versions, never resolves live content.
        for source in source_refs {
            self.project_file_read_bytes(&FileBytesInput {
                object: source.object.clone(),
                version_number: source.file_version.unwrap(),
                expected_content_hash: source.revision.clone(),
            })
            .map_err(|error| {
                let error = FileServiceError::from_error(error);
                let code = match error.code {
                    "ownership_mismatch" => ErrorCode::ScopeDenied,
                    "hash_mismatch" | "source_changed" => ErrorCode::SourceChanged,
                    "snapshot_missing" | "version_unregistered" => ErrorCode::SourceNotReady,
                    "invalid_argument" => ErrorCode::InvalidArgument,
                    "budget_exceeded" => ErrorCode::BudgetExceeded,
                    _ => ErrorCode::IoFailed,
                };
                AgentError::new(code, error.message)
                    .with_details(serde_json::json!({"reason": error.code}))
            })?;
        }
        for (id, source, excerpt) in &evidence {
            tx.execute("INSERT INTO agent_evidence(id,owner_kind,owner_id,source_ref_json,excerpt) VALUES(?1,'message',?2,?3,?4)",
                    params![id, owner, source, excerpt]).map_err(storage_error)?;
        }
        for (target, locator, revision) in &edges {
            tx.execute("INSERT INTO content_reference_edges(source_object_key,target_object_key,relation,locator_json,target_revision) VALUES(?1,?2,'evidence',?3,?4)",
                    params![owner, target, locator, revision]).map_err(storage_error)?;
        }
        tx.commit().map_err(storage_error)
    }
}

#[cfg(test)]
#[path = "dsh_source_evidence_tests.rs"]
mod tests;
