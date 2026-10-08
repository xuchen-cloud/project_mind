//! Thin trusted File recovery adapter; the native version journal owns byte IO.
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        operations::{FileUndoResult, OperationUndoInput},
    },
    db::agent_file_undo::FILE_UNDO_REQUEST_PREFIX,
    file_version_service::{BoundFileCommitStore, FileVersionService, FilesystemFileReader},
};

pub(crate) fn undo_file<S: BoundFileCommitStore>(
    store: &S,
    request: &RequestContext,
    input: &OperationUndoInput,
) -> AgentResult<FileUndoResult> {
    let host = store.gui_commit_host(&request.binding)?;
    let db = host.database()?;
    let (entry, previous) = db.agent_file_undo_prepare(request, host.binding(), input)?;
    if let Some(previous) = previous {
        return Ok(previous);
    }
    let restore = db.agent_file_undo_restore_input(&entry)?;
    drop(db);
    let mut trusted = request.clone();
    trusted.request_id = format!("{FILE_UNDO_REQUEST_PREFIX}{}", entry.operation_id);
    // No file.restore grant is added. The kernel verifies this exact original
    // receipt and restore payload and authorizes operation.undo on its real owner.
    FileVersionService::new(store, &FilesystemFileReader).restore_version(&trusted, &restore)?;
    // Native success is already durable. A later Workspace close must not
    // turn its committed receipt into an apparent failed undo.
    let db = host.database()?;
    let (_, previous) = db.agent_file_undo_prepare(request, host.binding(), input)?;
    previous.ok_or_else(|| {
        AgentError::new(
            ErrorCode::IoFailed,
            "Committed File undo receipt is unavailable",
        )
    })
}
