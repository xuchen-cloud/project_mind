//! Common database startup for desktop opens, password reopens and future
//! headless hosts. Opening SQLite alone is not a complete Workspace startup.
use crate::{agent::errors::AgentError, db::Database};
use anyhow::{anyhow, Result};
use std::path::Path;

pub(crate) struct OpenedWorkspaceDatabase {
    pub db: Database,
    /// Recovery diagnostics are recoverable: the latest autosave remains the
    /// authoritative head even when sealing its historical checkpoint fails.
    pub checkpoint_error: Option<AgentError>,
}

pub(crate) fn open_workspace_database(
    db_path: &Path,
    root_path: &Path,
    secret_password: Option<String>,
    workspace_id: &str,
) -> Result<OpenedWorkspaceDatabase> {
    let mut db = Database::open(db_path, root_path, secret_password)?;
    db.bind_native_workspace(workspace_id)?;
    db.file_version_recover_pending()?;
    db.record_migrate_operation_keys(workspace_id)
        .map_err(|error| anyhow!(error.message))?;
    db.source_registry_reconcile()?;
    db.record_compact_operation_receipts()
        .map_err(|error| anyhow!(error.message))?;
    let checkpoint_error = db.record_seal_pending_checkpoints(true, workspace_id).err();
    Ok(OpenedWorkspaceDatabase {
        db,
        checkpoint_error,
    })
}
