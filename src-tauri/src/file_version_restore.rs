//! Trusted restore input identifies an existing File Version; it supplies no
//! paths or byte payloads, and requires file.restore independently of update.
use crate::{
    agent::{
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef},
    },
    db::file_versions::valid_hash,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileVersionRestore {
    pub object: ObjectRef,
    pub version_id: String,
    pub expected_version_number: u32,
    pub expected_content_hash: String,
}
pub(crate) fn valid_version_id(value: &str) -> bool {
    value
        .parse::<i64>()
        .is_ok_and(|id| id > 0 && id.to_string() == value)
}
impl FileVersionRestore {
    pub(crate) fn validate(&self) -> AgentResult<()> {
        self.object.key()?;
        if self.object.kind != ObjectKind::File
            || !valid_version_id(&self.version_id)
            || self.expected_version_number == 0
            || !valid_hash(&self.expected_content_hash)
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid File restore baseline or version",
            ));
        }
        Ok(())
    }
}
/// Server resolved only; no Deserialize and no caller-provided historical path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileRestoreSource {
    pub version_id: i64,
    pub version_number: u32,
    pub managed_path: PathBuf,
    pub managed_ref: String,
    pub content_hash: String,
    pub source_ref: String,
}
pub(crate) fn check_source_transaction(
    tx: &rusqlite::Transaction<'_>,
    source: &FileRestoreSource,
    document_id: i64,
) -> AgentResult<()> {
    let matches: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM document_versions v
             JOIN source_file_version_hashes h ON h.document_version_id=v.id
             WHERE v.id=?1 AND v.document_id=?2 AND v.version_number=?3
             AND v.managed_path=?4 AND h.content_hash=?5)",
            rusqlite::params![
                source.version_id,
                document_id,
                source.version_number,
                source.managed_ref,
                source.content_hash
            ],
            |row| row.get(0),
        )
        .map_err(|_| {
            AgentError::new(ErrorCode::IoFailed, "Cannot validate historical File Version")
        })?;
    if !matches {
        return Err(AgentError::new(
            ErrorCode::SourceChanged,
            "Historical File Version registration changed",
        ));
    }
    Ok(())
}
