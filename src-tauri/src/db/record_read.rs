//! Read-only current Record snapshots for CLI projection caching (Issue #283).
use super::Database;
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::WorkspaceBinding,
    },
    record_documents::RecordTarget,
    source_service::{SourceFingerprint, SourceReadTarget},
};
use rusqlite::OptionalExtension;

pub(crate) struct RecordReadSnapshot {
    pub fingerprint: SourceFingerprint,
    pub head_revision: u64,
    /// Canonical Markdown, or canonical JSON awaiting projection outside DB locks.
    pub content: Option<String>,
}
fn read_error(_: rusqlite::Error) -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Cannot read Record snapshot")
}
impl Database {
    pub(crate) fn record_read_snapshot(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        source: &SourceReadTarget,
        markdown: bool,
        needs_content: impl FnOnce(&SourceFingerprint, u64) -> bool,
    ) -> AgentResult<RecordReadSnapshot> {
        // Reuse the existing lazy policy initialization, never scan other Records.
        self.source_prepare()?;
        let transaction = self.conn.unchecked_transaction().map_err(read_error)?;
        // Ownership, grants, archive/withdrawal/exclusion, metadata and body hash
        // are observed in the same SQLite read snapshot as headRevision/content.
        let fingerprint = self.source_record_fingerprint(request, binding, source)?;
        let target = RecordTarget {
            scope: fingerprint.object.scope.clone(),
            record_id: fingerprint.object.id.parse().map_err(|_| {
                AgentError::new(ErrorCode::InvalidArgument, "Invalid Record identity")
            })?,
        };
        let key = target.key()?;
        let head_revision: i64 = transaction
            .query_row(
                "SELECT head_revision FROM record_document_heads WHERE record_key=?1",
                [&key],
                |row| row.get(0),
            )
            .optional()
            .map_err(read_error)?
            .ok_or_else(|| {
                AgentError::new(
                    ErrorCode::SourceNotReady,
                    "Record committed document has not been initialized",
                )
            })?;
        let head_revision = head_revision as u64;
        let content =
            if needs_content(&fingerprint, head_revision) {
                Some(transaction.query_row(
                if markdown {
                    "SELECT markdown FROM record_document_heads WHERE record_key=?1"
                } else {
                    "SELECT document_json FROM record_document_heads WHERE record_key=?1"
                },
                [&key], |row| row.get(0),
            ).map_err(read_error)?)
            } else {
                None
            };
        transaction.commit().map_err(read_error)?;
        Ok(RecordReadSnapshot {
            fingerprint,
            head_revision,
            content,
        })
    }
}
