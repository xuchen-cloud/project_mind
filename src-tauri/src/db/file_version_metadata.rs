//! Version-only metadata; independent from physical File rename journals.
use super::Database;

impl Database {
    // Independent migration so integration can order it alongside directory journals.
    // Columns, protection triggers, and the schema marker commit together.
    pub(super) fn ensure_file_version_metadata_schema(&self) -> anyhow::Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        self.ensure_column("document_versions", "display_name",
            "ALTER TABLE document_versions ADD COLUMN display_name TEXT CHECK(display_name IS NULL OR length(display_name)<=200)")?;
        self.ensure_column("document_versions", "is_important",
            "ALTER TABLE document_versions ADD COLUMN is_important INTEGER NOT NULL DEFAULT 0 CHECK(is_important IN (0,1))")?;
        self.ensure_column("document_versions", "metadata_revision",
            "ALTER TABLE document_versions ADD COLUMN metadata_revision INTEGER NOT NULL DEFAULT 0 CHECK(metadata_revision>=0)")?;
        tx.execute_batch(include_str!("file_version_metadata.sql"))?;
        tx.pragma_update(None, "user_version", 41)?;
        tx.commit()?;
        Ok(())
    }
}

use crate::agent::{
    access::{Caller, RequestContext},
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, WorkspaceBinding},
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
const OPERATION: &str = "file.version.metadata.update";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VersionMetadataUpdate {
    pub object: ObjectRef,
    pub version_id: String,
    pub expected_metadata_revision: i64,
    pub display_name: Option<String>,
    pub is_important: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VersionMetadataResult {
    pub object: ObjectRef,
    pub version_id: String,
    pub display_name: Option<String>,
    pub is_important: bool,
    pub metadata_revision: i64,
}
fn io(error: impl std::fmt::Display) -> AgentError {
    AgentError::new(
        ErrorCode::IoFailed,
        format!("Cannot persist File Version metadata: {error}"),
    )
}
impl Database {
    fn version_metadata_authorize(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &VersionMetadataUpdate,
    ) -> AgentResult<ObjectRef> {
        if !matches!(request.caller, Caller::Gui) {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Version metadata requires local GUI authority",
            ));
        }
        crate::file_version_service::validate_binding(&request.binding, binding)?;
        if self.native_workspace_id.as_deref() != Some(binding.workspace_id.as_str()) {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "File Workspace binding changed",
            ));
        }
        if input.object.kind != ObjectKind::File {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Expected a File object",
            ));
        }
        let object = self.source_resolve_business(request, binding, &input.object, OPERATION)?;
        self.source_live_scope(&object.scope)?;
        let member: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM document_versions WHERE id=?1 AND document_id=?2)",
                params![input.version_id, object.id],
                |r| r.get(0),
            )
            .map_err(io)?;
        if !member {
            return Err(AgentError::new(
                ErrorCode::NotFound,
                "Version is not retained by this File",
            ));
        }
        Ok(object)
    }
    pub(crate) fn file_version_metadata_update(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &VersionMetadataUpdate,
    ) -> AgentResult<VersionMetadataResult> {
        if input.expected_metadata_revision < 0
            || !crate::file_version_restore::valid_version_id(&input.version_id)
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid version metadata baseline",
            ));
        }
        // Check controls before trimming: a newline-only name is invalid, not null.
        if input
            .display_name
            .as_ref()
            .is_some_and(|name| name.chars().any(char::is_control))
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Version display name cannot contain control characters",
            ));
        }
        let name = input
            .display_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned);
        if name.as_ref().is_some_and(|name| name.chars().count() > 200) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Version display name exceeds 200 Unicode characters",
            ));
        }
        let object = self.version_metadata_authorize(request, binding, input)?;
        let id: i64 = object.id.parse().map_err(io)?;
        let _locks = self
            .file_recovery_write_locks(id)
            .map_err(super::file_versions::agent_failure)?;
        let _permit = self.file_commit_permit()?;
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(io)?;
        // Recheck after leases/lifecycle admission/writer acquisition, including
        // receipt replay. Reuse the existing transaction/receipt/outbox kernel.
        self.version_metadata_authorize(request, binding, input)?;
        let result = self.agent_atomic_operation_in_transaction(
            &tx,
            &request.caller.key(),
            &request.request_id,
            OPERATION,
            input,
            |tx| {
                let (old_name, old_important, revision): (Option<String>, bool, i64) = tx
                    .query_row(
                        "SELECT display_name,is_important,metadata_revision FROM document_versions WHERE id=?1 AND document_id=?2",
                        params![input.version_id, id],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .optional()
                    .map_err(io)?
                    .ok_or_else(|| AgentError::new(ErrorCode::NotFound, "Version is no longer retained"))?;
                if revision != input.expected_metadata_revision {
                    return Err(AgentError::new(
                        ErrorCode::RevisionConflict,
                        "Version metadata changed; reload before saving",
                    ));
                }
                let mut result = VersionMetadataResult {
                    object: object.clone(),
                    version_id: input.version_id.clone(),
                    display_name: name.clone(),
                    is_important: input.is_important,
                    metadata_revision: revision,
                };
                if old_name == name && old_important == input.is_important {
                    return Ok((result, None));
                }
                result.metadata_revision = revision.checked_add(1).ok_or_else(|| {
                    AgentError::new(ErrorCode::BudgetExceeded, "Version metadata revision exhausted")
                })?;
                let updated = tx.execute(
                    "UPDATE document_versions SET display_name=?1,is_important=?2,metadata_revision=?3 WHERE id=?4 AND document_id=?5 AND metadata_revision=?6",
                    params![name, input.is_important, result.metadata_revision, input.version_id, id, revision],
                ).map_err(io)?;
                if updated != 1 {
                    return Err(AgentError::new(ErrorCode::RevisionConflict, "Version metadata changed"));
                }
                let change = super::agent_operations::OperationChange {
                    object_key: object.key()?,
                    scope: object.scope.clone(),
                    revision: format!("version:{}:metadata:{}", input.version_id, result.metadata_revision),
                };
                Ok((result, Some(change)))
            },
        )?;
        tx.commit().map_err(io)?;
        Ok(result)
    }
}
