//! Temporary File upload receipts reuse the existing operation receipt store.
use super::{agent_operations::io_error, Database};
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{Scope, WorkspaceBinding},
    },
    file_content::{FileContentBegin, FileContentTicket},
};
use rusqlite::{params, OptionalExtension};
impl Database {
    pub(crate) fn file_content_begin_replay(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &FileContentBegin,
    ) -> AgentResult<Option<FileContentTicket>> {
        self.file_version_registered_target(request, binding, &input.object)?;
        self.agent_operation_replay(
            &request.caller.key(),
            &request.request_id,
            "file.content.stage.begin",
            input,
        )
    }
    pub(crate) fn file_content_begin_persist(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &FileContentBegin,
        ticket: &FileContentTicket,
    ) -> AgentResult<FileContentTicket> {
        self.file_version_registered_target(request, binding, &input.object)?;
        self.agent_atomic_operation(
            &request.caller.key(),
            &request.request_id,
            "file.content.stage.begin",
            input,
            |tx| {
                check_transaction(tx, input)?;
                Ok((ticket.clone(), None))
            },
        )
    }
}

pub(crate) fn check_transaction(
    tx: &rusqlite::Transaction<'_>,
    input: &FileContentBegin,
) -> AgentResult<()> {
    let project = match input.object.scope {
        Scope::Project { project_id } => project_id,
        _ => {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "File needs a Project",
            ))
        }
    };
    let id: i64 = input
        .object
        .id
        .parse()
        .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Invalid File ID"))?;
    let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM documents d JOIN projects p ON p.id=d.project_id WHERE d.id=?1 AND d.project_id=?2 AND p.is_archived=0 AND d.current_version_number=?3 AND d.storage_mode!='managed_note_image')",params![id,project,input.expected_version_number],|row|row.get(0)).map_err(io_error)?;
    if !valid {
        return Err(AgentError::new(
            ErrorCode::RevisionConflict,
            "File baseline changed before staging",
        ));
    }
    super::file_versions::require_file_source_policy(tx, &input.object)?;
    super::agent_file_undo::require_file_visible(tx, id)?;
    let hash:Option<String>=tx.query_row("SELECT h.content_hash FROM document_versions v JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1 AND v.version_number=?2",params![id,input.expected_version_number],|row|row.get(0)).optional().map_err(io_error)?;
    if hash.as_ref() != Some(&input.expected_content_hash) {
        return Err(AgentError::new(
            ErrorCode::FileChangedUnregistered,
            "File baseline is not registered",
        ));
    }
    Ok(())
}
