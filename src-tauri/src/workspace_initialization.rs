//! Common database startup for desktop opens, recovery and future
//! headless hosts. Opening SQLite alone is not a complete Workspace startup.
use crate::{agent::errors::AgentError, db::Database};
use anyhow::Result;
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
    // Temporary uploads must not prevent opening existing user content. Keep
    // unknown/changed private files for diagnosis rather than deleting them.
    if let Err(error)=crate::file_content::recover_expired(root_path,workspace_id,chrono::Utc::now().timestamp_millis()) {
        eprintln!("File upload recovery pending: {}",error.message);
    }
    // Current writes publish canonical keys, compact receipts and registry
    // entries in the same transaction. Only unfinished writes need recovery;
    // replaying all historical changes here adds work on every normal open.
    let checkpoint_error = db.record_seal_pending_checkpoints(true, workspace_id).err();
    Ok(OpenedWorkspaceDatabase {
        db,
        checkpoint_error,
    })
}
