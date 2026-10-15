//! Original-location restoration for directory Files. A durable intent protects
//! both the replaced live bytes and the staged historical bytes. Version rows
//! and the existing registered receipt commit together; recovery never changes
//! a historical path or removes a referenced snapshot.
use super::*;
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::WorkspaceBinding,
    },
    db::file_versions::{CommittedVersion, FileVersionCommitOutcome, FileVersionUpdate},
    file_version_restore::{FileRestoreSource, FileVersionRestore},
    workspace_commit_fence::WorkspaceCommitFence,
};

#[cfg(test)]
#[derive(Clone, Copy)]
enum RestorePhase {
    JournalDurable = 1,
    OriginalArchived,
    HistoricalPlaced,
    Committed,
}

#[cfg(test)]
fn crash_point(phase: RestorePhase) {
    // Reuse the File fixture's ready/resume handshake so a parent can hold a
    // real SQLite read lease and SIGKILL a writer before COMMIT completes.
    if std::env::var("MIND_DIRECTORY_RESTORE_PAUSE_STAGE")
        .ok()
        .and_then(|stage| stage.parse::<u8>().ok())
        == Some(phase as u8)
    {
        let ready = std::env::var("MIND_DIRECTORY_RESTORE_READY").unwrap();
        let resume = std::env::var("MIND_DIRECTORY_RESTORE_RESUME").unwrap();
        fs::write(ready, b"ready").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while !Path::new(&resume).exists() {
            if std::time::Instant::now() >= deadline {
                std::process::exit(92);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    if std::env::var("MIND_DIRECTORY_RESTORE_CRASH_STAGE")
        .ok()
        .and_then(|stage| stage.parse::<u8>().ok())
        != Some(phase as u8)
    {
        return;
    }
    #[cfg(unix)]
    {
        // Match the existing File crash fixture: SIGKILL runs neither Rust
        // destructors nor application cleanup, leaving SQLite/FS recovery real.
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        unsafe {
            kill(std::process::id() as i32, 9);
        }
    }
    std::process::exit(91);
}


/// The original-location journal covers restore and server-owned uploads.
/// Untagged DTOs preserve existing durable restore journals exactly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub(super) enum DirectoryReplaceInput {
    Restore(FileVersionRestore),
    Staged(crate::file_content::FileContentUpdate),
}
impl DirectoryReplaceInput {
    fn object(&self)->&ObjectRef { match self { Self::Restore(x)=>&x.object,Self::Staged(x)=>&x.object } }
    fn version(&self)->u32 { match self { Self::Restore(x)=>x.expected_version_number,Self::Staged(x)=>x.expected_version_number } }
    fn hash(&self)->&str { match self { Self::Restore(x)=>&x.expected_content_hash,Self::Staged(x)=>&x.expected_content_hash } }
    pub(super) fn restore(&self)->Option<&FileVersionRestore> { if let Self::Restore(x)=self {Some(x)} else {None} }
    pub(super) fn staged(&self)->Option<&crate::file_content::FileContentUpdate> { if let Self::Staged(x)=self {Some(x)} else {None} }
    pub(super) fn payload(&self,new_hash:&str)->file_versions::CommitPayload {
        let update=FileVersionUpdate {object:self.object().clone(),expected_version_number:self.version(),expected_content_hash:self.hash().into(),new_content_hash:new_hash.into()};
        file_versions::registered_payload(&update,None,self.staged().map(|x|x.staged_content_id.as_str()),self.restore())
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RestoreJournal {
    input: DirectoryReplaceInput,
    caller: String,
    request_id: String,
    target: String,
    staged: String,
    backup: String,
    original_identity: file_versions::FileIdentity,
    new_identity: file_versions::FileIdentity,
    new_hash: String,
}
fn error(error: anyhow::Error) -> AgentError {
    let error = FileServiceError::from_error(error);
    let code = match error.code {
        "revision_conflict" => ErrorCode::RevisionConflict,
        "ownership_mismatch" => ErrorCode::ScopeDenied,
        "source_changed" | "hash_mismatch" => ErrorCode::SourceChanged,
        "ambiguous_identity" => ErrorCode::FileChangedUnregistered,
        "budget_exceeded" => ErrorCode::BudgetExceeded,
        _ => ErrorCode::IoFailed,
    };
    AgentError::new(code, error.message)
}
impl Database {
    fn directory_restore_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS project_directory_restores (
            document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
            journal TEXT NOT NULL CHECK(json_valid(journal)));",
        )?;
        Ok(())
    }
    fn directory_restore_paths(
        &self,
        journal: &RestoreJournal,
    ) -> Result<(PathBuf, PathBuf, PathBuf)> {
        let (document, root) = self.directory_target(journal.input.object())?;
        let target = self.decode_path_ref(&journal.target);
        let staged = self.decode_path_ref(&journal.staged);
        let backup = self.decode_path_ref(&journal.backup);
        let history = Path::new(&document.history_dir_path);
        if target != Path::new(&document.managed_path)
            || staged.parent() != Some(history)
            || backup.parent() != Some(history)
            || staged == backup
        {
            return Err(failure(
                "ambiguous_identity",
                "Restore intent locations no longer belong to this File",
            ));
        }
        business_path(
            &root,
            &file_versions::relative(&root, &target)?.replace('\\', "/"),
        )?;
        for (path, prefix) in [(&staged, "restore-new-"), (&backup, "restore-old-")] {
            file_versions::relative(&self.workspace_root, path)?;
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            if !name.strip_prefix(prefix).is_some_and(|token| {
                token.len() == 32 && token.bytes().all(|b| b.is_ascii_hexdigit())
            }) {
                return Err(failure(
                    "ambiguous_identity",
                    "Invalid restore staging ownership",
                ));
            }
        }
        Ok((target, staged, backup))
    }
    fn directory_restore_remove_owned(
        &self,
        path: &Path,
        identity: &file_versions::FileIdentity,
        hash: &str,
    ) -> Result<()> {
        match fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
            Ok(_) => (),
        }
        if file_versions::path_identity(path)? != *identity
            || file_versions::checksum(path)? != hash
        {
            return Err(failure(
                "ambiguous_identity",
                "Restore staging contains foreign or changed bytes; intent retained",
            ));
        }
        fs::remove_file(path)?;
        file_versions::sync_directory(path.parent().unwrap())
    }
    pub(in crate::db) fn directory_restore_recover_locked(&self, object: &ObjectRef) -> Result<()> {
        self.directory_restore_schema()?;
        let (_, id) = file_id(object)?;
        let pending: Option<String> = self
            .conn
            .query_row(
                "SELECT journal FROM project_directory_restores WHERE document_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(pending) = pending else {
            return Ok(());
        };
        let journal: RestoreJournal = serde_json::from_str(&pending)?;
        if journal.input.object() != object {
            return Err(failure(
                "ownership_mismatch",
                "Restore intent belongs to another File",
            ));
        }
        let (target, staged, backup) = self.directory_restore_paths(&journal)?;
        let payload = journal.input.payload(&journal.new_hash);
        let receipt: Option<CommittedVersion> = self
            .agent_operation_replay(
                &journal.caller,
                &journal.request_id,
                "file.version.commit",
                &payload,
            )
            .map_err(|e| anyhow!(e.message))?;
        if receipt.is_none() {
            self.directory_baseline(
                object,
                journal.input.version(),
                journal.input.hash(),
            )?;
            // Roll back only our own replacement. A foreign file at the live
            // location stays untouched and requires explicit reconciliation.
            match file_versions::path_identity(&target) {
                Ok(identity) if identity == journal.new_identity => {
                    if file_versions::checksum(&target)? != journal.new_hash {
                        return Err(failure(
                            "ambiguous_identity",
                            "Restored live bytes changed before commit; intent retained",
                        ));
                    }
                    file_versions::move_exclusive(&target, &staged)?;
                }
                Ok(identity) if identity == journal.original_identity => {
                    if backup.exists()
                        || file_versions::checksum(&target)? != journal.input.hash()
                    {
                        return Err(failure(
                            "ambiguous_identity",
                            "Original live bytes changed during interrupted restore",
                        ));
                    }
                }
                Ok(_) => {
                    return Err(failure(
                        "ambiguous_identity",
                        "Foreign live bytes occupy the restore target",
                    ))
                }
                Err(error)
                    if fs::symlink_metadata(&target)
                        .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
                {
                    let _ = error;
                }
                Err(error) => return Err(error),
            }
            if !target.exists() {
                if file_versions::path_identity(&backup)? != journal.original_identity
                    || file_versions::checksum(&backup)? != journal.input.hash()
                {
                    return Err(failure(
                        "ambiguous_identity",
                        "Original restore backup changed",
                    ));
                }
                file_versions::move_exclusive(&backup, &target)?;
                file_versions::sync_directory(target.parent().unwrap())?;
                file_versions::sync_directory(backup.parent().unwrap())?;
            }
        }
        self.directory_restore_remove_owned(
            &backup,
            &journal.original_identity,
            journal.input.hash(),
        )?;
        self.directory_restore_remove_owned(&staged, &journal.new_identity, &journal.new_hash)?;
        self.conn.execute(
            "DELETE FROM project_directory_restores WHERE document_id=?1",
            [id],
        )?;
        Ok(())
    }
    pub(super) fn directory_restore_recover(&self, object: &ObjectRef) -> Result<()> {
        let (project, id) = file_id(object)?;
        let _project = self.file_project_lock(project, false)?;
        let _file = self.file_version_lock(id)?;
        self.directory_restore_recover_locked(object)
    }
    pub(crate) fn project_file_restore_bound(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &FileVersionRestore,
        source: &FileRestoreSource,
        fence: &WorkspaceCommitFence,
        precommit: &dyn Fn() -> AgentResult<()>,
    ) -> AgentResult<FileVersionCommitOutcome> {
        input.validate()?;
        self.directory_replace_bound(request,binding,&DirectoryReplaceInput::Restore(input.clone()),&source.managed_path,&source.content_hash,Some(source),fence,precommit)
    }
    pub(crate) fn project_file_staged_directory_bound(
        &self,request:&RequestContext,binding:&WorkspaceBinding,update:&FileVersionUpdate,stage_id:&str,source:&Path,
        fence:&WorkspaceCommitFence,precommit:&dyn Fn()->AgentResult<()>,
    )->AgentResult<FileVersionCommitOutcome> {
        let input=DirectoryReplaceInput::Staged(crate::file_content::FileContentUpdate {object:update.object.clone(),expected_version_number:update.expected_version_number,expected_content_hash:update.expected_content_hash.clone(),staged_content_id:stage_id.into()});
        self.directory_replace_bound(request,binding,&input,source,&update.new_content_hash,None,fence,precommit)
    }
    fn directory_replace_authorize(
        &self,request:&RequestContext,binding:&WorkspaceBinding,input:&DirectoryReplaceInput,historical:Option<&FileRestoreSource>,
    )->AgentResult<()> {
        if let Some(restore)=input.restore() {
            if &self.file_version_restore_source(request,binding,restore)?!=historical.unwrap() {return Err(AgentError::new(ErrorCode::RevisionConflict,"Historical source changed during replacement"));}
        } else { self.file_version_registered_target(request,binding,input.object())?; }
        Ok(())
    }
    fn directory_replace_bound(
        &self,request:&RequestContext,binding:&WorkspaceBinding,input:&DirectoryReplaceInput,source:&Path,new_hash:&str,
        historical:Option<&FileRestoreSource>,fence:&WorkspaceCommitFence,precommit:&dyn Fn()->AgentResult<()>,
    )->AgentResult<FileVersionCommitOutcome> {

        let (project, id) = file_id(input.object()).map_err(error)?;
        let _project = self.file_project_lock(project, false).map_err(error)?;
        let _file = self.file_version_lock(id).map_err(error)?;
        self.directory_restore_recover_locked(input.object())
            .map_err(error)?;
        self.directory_replace_authorize(request,binding,input,historical)?;
        let payload = input.payload(new_hash);
        if let Some(receipt) = self.agent_operation_replay(
            &request.caller.key(),
            &request.request_id,
            "file.version.commit",
            &payload,
        )? {
            return Ok(FileVersionCommitOutcome {
                receipt,
                committed: false,
            });
        }
        let current = self
            .directory_baseline(
                input.object(),
                input.version(),
                input.hash(),
            )
            .map_err(error)?;
        let target = PathBuf::from(&current.managed_path);
        let physical: file_versions::FileIdentity = serde_json::from_str(
            &self
                .conn
                .query_row(
                    "SELECT physical_identity FROM project_directory_files WHERE document_id=?1",
                    [id],
                    |r| r.get::<_, String>(0),
                )
                .map_err(|e| AgentError::new(ErrorCode::IoFailed, e.to_string()))?,
        )
        .map_err(|e| AgentError::new(ErrorCode::IoFailed, e.to_string()))?;
        if file_versions::path_identity(&target).map_err(error)? != physical
            || file_versions::checksum(&target).map_err(error)? != input.hash()
        {
            return Err(AgentError::new(
                ErrorCode::FileChangedUnregistered,
                "Register or confirm current live bytes before restoration",
            ));
        }
        if new_hash == input.hash() {
            precommit()?;
            let _permit = fence.enter()?;
            let receipt = CommittedVersion {
                document_id: id,
                version_number: current.current_version_number,
                content_hash: new_hash.to_owned(),
                no_change: true,
            };
            let receipt = self.agent_atomic_operation(
                &request.caller.key(),
                &request.request_id,
                "file.version.commit",
                &payload,
                |_| Ok((receipt, None)),
            )?;
            return Ok(FileVersionCommitOutcome {
                receipt,
                committed: true,
            });
        }
        let history = Path::new(&current.history_dir_path);
        file_versions::create_owned_directories(&self.workspace_root, history).map_err(error)?;
        let nonce = file_versions::token();
        let staged = history.join(format!("restore-new-{nonce}"));
        let backup = history.join(format!("restore-old-{nonce}"));
        let (hash, _, new_identity) = file_versions::snapshot_bounded(
            source,
            &staged,
            Some(crate::file_text_patch::MAX_FILE_BYTES as u64),
        )
        .map_err(error)?;
        if hash != new_hash {
            return Err(AgentError::new(
                ErrorCode::SourceChanged,
                "Historical snapshot no longer matches its registered hash",
            ));
        }
        file_versions::sync_directory(history).map_err(error)?;
        precommit()?;
        let journal = RestoreJournal {
            input: input.clone(),
            caller: request.caller.key(),
            request_id: request.request_id.clone(),
            target: self.encode_path_ref(&target),
            staged: self.encode_path_ref(&staged),
            backup: self.encode_path_ref(&backup),
            original_identity: physical.clone(),
            new_identity,
            new_hash: hash.clone(),
        };
        self.conn
            .execute(
                "INSERT INTO project_directory_restores(document_id,journal) VALUES (?1,?2)",
                params![
                    id,
                    serde_json::to_string(&journal)
                        .map_err(|e| AgentError::new(ErrorCode::IoFailed, e.to_string()))?
                ],
            )
            .map_err(|e| AgentError::new(ErrorCode::IoFailed, e.to_string()))?;
        #[cfg(test)]
        crash_point(RestorePhase::JournalDurable);
        let result = (|| -> AgentResult<FileVersionCommitOutcome> {
            let _permit = fence.enter()?;
            self.directory_replace_authorize(request,binding,input,historical)?;
            self.directory_baseline(
                input.object(),
                input.version(),
                input.hash(),
            )
            .map_err(error)?;
            if file_versions::path_identity(&target).map_err(error)? != physical
                || file_versions::checksum(&target).map_err(error)? != input.hash()
            {
                return Err(AgentError::new(
                    ErrorCode::FileChangedUnregistered,
                    "Current live File changed before restoration",
                ));
            }
            file_versions::move_exclusive(&target, &backup).map_err(error)?;
            file_versions::sync_directory(target.parent().unwrap()).map_err(error)?;
            file_versions::sync_directory(history).map_err(error)?;
            #[cfg(test)]
            crash_point(RestorePhase::OriginalArchived);
            if file_versions::path_identity(&backup).map_err(error)? != physical
                || file_versions::checksum(&backup).map_err(error)? != input.hash()
            {
                return Err(AgentError::new(
                    ErrorCode::FileChangedUnregistered,
                    "Current File changed during replacement",
                ));
            }
            file_versions::move_exclusive(&staged, &target).map_err(error)?;
            file_versions::sync_directory(target.parent().unwrap()).map_err(error)?;
            file_versions::sync_directory(history).map_err(error)?;
            #[cfg(test)]
            crash_point(RestorePhase::HistoricalPlaced);
            precommit()?;
            let published = self
                .directory_publish_locked(
                    &binding.workspace_id,
                    project,
                    &target,
                    input.object(),
                    true,
                    Some((input.version(), input.hash())),
                    Some((request, input)),
                )
                .map_err(error)?;
            if published.state != "ready" {
                return Err(AgentError::new(
                    ErrorCode::SourceNotReady,
                    "Restored bytes did not form a registered version",
                ));
            }
            #[cfg(test)]
            crash_point(RestorePhase::Committed);
            let receipt = self
                .agent_operation_replay(
                    &request.caller.key(),
                    &request.request_id,
                    "file.version.commit",
                    &payload,
                )?
                .ok_or_else(|| {
                    AgentError::new(
                        ErrorCode::IoFailed,
                        "Restoration receipt missing after commit",
                    )
                })?;
            Ok(FileVersionCommitOutcome {
                receipt,
                committed: true,
            })
        })();
        match self.directory_restore_recover_locked(input.object()) {
            Ok(()) => result,
            Err(recovery) => Err(AgentError::new(
                ErrorCode::IoFailed,
                format!("Restore recovery requires attention: {recovery:#}"),
            )),
        }
    }
}
