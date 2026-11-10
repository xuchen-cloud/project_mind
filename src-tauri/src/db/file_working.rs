//! Durable current content, immutable history and fixed GUI editing bases.
//! Filesystem replacement uses the same owned-file primitives and File/Project
//! leases as the native directory journal. Backups exist only until recovery.
use super::{file_versions as files, project_directory_changes::directory_identity, Database};
use crate::{
    agent::{
        access::{Caller, RequestContext},
        errors::{AgentResult, ErrorCode},
        models::{ObjectRef, WorkspaceBinding},
    },
    file_working::{error, WorkingStatus, IDLE_MS},
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
fn io(e: impl std::fmt::Display) -> crate::agent::errors::AgentError {
    error(
        ErrorCode::IoFailed,
        &format!("Cannot persist File working content: {e}"),
    )
}
struct Durable<'a> {
    conn: &'a rusqlite::Connection,
    previous: i64,
}
impl<'a> Durable<'a> {
    fn new(conn: &'a rusqlite::Connection) -> AgentResult<Self> {
        let previous = conn
            .pragma_query_value(None, "synchronous", |r| r.get::<_, i64>(0))
            .map_err(io)?;
        conn.pragma_update(None, "synchronous", previous.max(2))
            .map_err(io)?;
        Ok(Self { conn, previous })
    }
}
impl Drop for Durable<'_> {
    fn drop(&mut self) {
        if let Err(error) = self.conn.pragma_update(None, "synchronous", self.previous) {
            eprintln!("Working File synchronous restore failed: {error}");
        }
    }
}
fn read_bounded(path: &Path, expected_hash: &str) -> AgentResult<Vec<u8>> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let file = crate::source_file_snapshot::open_regular(path)?;
    let before =
        crate::source_file_snapshot::FileStamp::from_metadata(&file.metadata().map_err(io)?);
    let identity = files::identity(&file).map_err(io)?;
    let mut bytes = Vec::new();
    file.take(crate::file_content::MAX_CONTENT + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() as u64 > crate::file_content::MAX_CONTENT {
        return Err(error(
            ErrorCode::BudgetExceeded,
            "File exceeds the 100 MiB editor limit",
        ));
    }
    if format!("sha256:{:x}", Sha256::digest(&bytes)) != expected_hash
        || files::path_identity(path).map_err(io)? != identity
        || crate::source_file_snapshot::FileStamp::from_metadata(
            &fs::symlink_metadata(path).map_err(io)?,
        ) != before
    {
        return Err(error(
            ErrorCode::FileChangedUnregistered,
            "File changed during working content read",
        ));
    }
    Ok(bytes)
}
// Model the existing live/history volume split without treating this as real
// second-volume acceptance. Production still uses the exclusive rename primitive.
#[cfg(test)]
thread_local! {
    static WORKING_TEST_HISTORY_VOLUME: std::cell::RefCell<Option<std::path::PathBuf>> = const { std::cell::RefCell::new(None) };
}
fn working_move(from: &Path, to: &Path) -> anyhow::Result<()> {
    #[cfg(test)]
    WORKING_TEST_HISTORY_VOLUME.with(|volume| -> anyhow::Result<()> {
        if let Some(history) = volume.borrow().as_ref() {
            if from.starts_with(history) != to.starts_with(history) {
                return Err(
                    std::io::Error::from_raw_os_error(if cfg!(windows) { 17 } else { 18 }).into(),
                );
            }
        }
        Ok(())
    })?;
    files::move_exclusive(from, to)
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct State {
    revision: i64,
    hash: String,
    identity: files::FileIdentity,
    activity: Option<i64>,
    pending: bool,
}
pub(super) fn stored_working_revision(value: &str) -> anyhow::Result<i64> {
    Ok(serde_json::from_str::<State>(value)?.revision)
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Placement {
    live_parent: files::FileIdentity,
}
#[derive(Debug, Serialize, Deserialize)]
struct Journal {
    // Existing pending journals stage in immutable history and have no parent
    // identities. Keep that exact layout recoverable during upgrade.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    placement: Option<Placement>,
    object: ObjectRef,
    target: String,
    staged: String,
    backup: String,
    old: State,
    new: State,
}
impl Journal {
    fn check_parents(&self, target: &Path, staged: &Path) -> AgentResult<()> {
        let target_parent = directory_identity(target.parent().unwrap()).map_err(io)?;
        let staging_parent = directory_identity(staged.parent().unwrap()).map_err(io)?;
        if let Some(placement) = &self.placement {
            if target_parent != placement.live_parent || staging_parent != placement.live_parent {
                return Err(error(
                    ErrorCode::FileChangedUnregistered,
                    "Working replacement parent changed; journal retained",
                ));
            }
        }
        Ok(())
    }
}
impl Database {
    pub(crate) fn bind_file_commit_fence(
        &mut self,
        fence: std::sync::Arc<crate::workspace_commit_fence::WorkspaceCommitFence>,
    ) {
        self.file_commit_fence = Some(fence);
    }
    // Call only after acquiring every required lease. Never retain this permit
    // across a global recovery scan or another operation that may wait for File.
    pub(super) fn file_commit_permit(
        &self,
    ) -> AgentResult<Option<std::sync::RwLockReadGuard<'_, bool>>> {
        self.file_commit_fence
            .as_deref()
            .map(|fence| fence.enter())
            .transpose()
    }
    pub(super) fn ensure_file_working_schema(&self) -> anyhow::Result<()> {
        self.ensure_file_flow_schema()?;
        self.conn.execute_batch("CREATE TABLE IF NOT EXISTS file_working_contents(document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,state TEXT NOT NULL CHECK(json_valid(state)),bytes BLOB NOT NULL,journal TEXT CHECK(journal IS NULL OR json_valid(journal))); CREATE TABLE IF NOT EXISTS file_working_sessions(session_id TEXT PRIMARY KEY,document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,generation TEXT NOT NULL,object TEXT NOT NULL,base_hash TEXT NOT NULL,name TEXT NOT NULL,bytes BLOB NOT NULL);")?;
        Ok(())
    }
    fn working_authorize(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
    ) -> AgentResult<crate::models::DocumentRecord> {
        if !matches!(request.caller, Caller::Gui) {
            return Err(error(
                ErrorCode::ScopeDenied,
                "Working sessions require local GUI authority",
            ));
        }
        crate::file_version_service::validate_binding(&request.binding, binding)?;
        self.file_version_registered_target(request, binding, object)
    }
    fn working_state(&self, id: i64) -> AgentResult<Option<State>> {
        self.conn
            .query_row(
                "SELECT state FROM file_working_contents WHERE document_id=?1",
                [id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(io)?
            .map(|s| serde_json::from_str(&s).map_err(io))
            .transpose()
    }
    fn working_status(&self, object: &ObjectRef, s: &State) -> AgentResult<WorkingStatus> {
        let document = self
            .document_record(object.id.parse().map_err(io)?)
            .map_err(io)?;
        Ok(WorkingStatus {
            object: object.clone(),
            revision: s.revision,
            content_hash: s.hash.clone(),
            archived_version_number: document.current_version_number,
            pending_archive: s.pending,
            last_activity_at_ms: s.activity,
            archive_due_at_ms: if s.pending {
                s.activity.map(|t| t.saturating_add(IDLE_MS))
            } else {
                None
            },
            no_change: false,
        })
    }
    fn working_check_disk(&self, path: &Path, s: &State) -> AgentResult<()> {
        if files::path_identity(path).map_err(io)? != s.identity
            || files::checksum(path).map_err(io)? != s.hash
        {
            return Err(error(
                ErrorCode::FileChangedUnregistered,
                "Current File changed outside this working session; reconcile external content",
            ));
        }
        Ok(())
    }
    fn working_initialize_locked(&self, object: &ObjectRef) -> AgentResult<State> {
        let document = self
            .document_record(object.id.parse().map_err(io)?)
            .map_err(io)?;
        let path = Path::new(&document.managed_path);
        files::relative(&self.workspace_root, path).map_err(io)?;
        if let Some(state) = self.working_state(document.id)? {
            let archived:Option<String>=self.conn.query_row("SELECT h.content_hash FROM document_versions v JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1 AND v.version_number=?2",params![document.id,document.current_version_number],|r|r.get(0)).optional().map_err(io)?;
            let live_identity = files::path_identity(path).map_err(io)?;
            let accepted_identity: bool = self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM project_directory_files WHERE document_id=?1 AND state='ready' AND physical_identity=?2)",
                params![document.id, serde_json::to_string(&live_identity).map_err(io)?],
                |row| row.get(0),
            ).map_err(io)?;
            if !state.pending
                && (archived.as_deref() != Some(&state.hash)
                    || (state.identity != live_identity && accepted_identity))
            {
                let next = State {
                    revision: state.revision.checked_add(1).ok_or_else(|| {
                        error(ErrorCode::BudgetExceeded, "Working revision exhausted")
                    })?,
                    hash: archived.ok_or_else(|| {
                        error(ErrorCode::SourceNotReady, "Current history is unregistered")
                    })?,
                    identity: live_identity,
                    activity: None,
                    pending: false,
                };
                self.working_check_disk(path, &next)?;
                let tx = self.conn.unchecked_transaction().map_err(io)?;
                tx.execute(
                    "UPDATE file_working_contents SET state=?1,bytes=?3 WHERE document_id=?2",
                    params![
                        serde_json::to_string(&next).map_err(io)?,
                        document.id,
                        read_bounded(path, &next.hash)?
                    ],
                )
                .map_err(io)?;
                tx.execute(
                    "DELETE FROM file_working_sessions WHERE document_id=?1",
                    [document.id],
                )
                .map_err(io)?;
                self.working_check_disk(path, &next)?;
                tx.commit().map_err(io)?;
                return Ok(next);
            }
            self.working_check_disk(path, &state)?;
            return Ok(state);
        }
        let (stored,hash):(String,String)=self.conn.query_row("SELECT v.managed_path,h.content_hash FROM document_versions v JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1 AND v.version_number=?2",params![document.id,document.current_version_number],|r|Ok((r.get(0)?,r.get(1)?))).map_err(io)?;
        let state = State {
            revision: 0,
            hash,
            identity: files::path_identity(path).map_err(io)?,
            activity: None,
            pending: false,
        };
        self.working_check_disk(path, &state)?;
        // Legacy managed copies keep their existing File ID and original live
        // path. Freeze only an unfrozen historical head before its first edit.
        let retained = self.decode_path_ref(&stored);
        let frozen = if retained == path {
            let history = Path::new(&document.history_dir_path);
            files::create_owned_directories(&self.workspace_root, history).map_err(io)?;
            let snapshot = history.join(files::token());
            let (hash, _, _) =
                files::snapshot_bounded(path, &snapshot, Some(crate::file_content::MAX_CONTENT))
                    .map_err(io)?;
            if hash != state.hash {
                return Err(error(
                    ErrorCode::SourceChanged,
                    "File changed while freezing its existing history",
                ));
            }
            files::sync_directory(history).map_err(io)?;
            Some(snapshot)
        } else {
            None
        };
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(io)?;
        self.working_check_disk(path, &state)?;
        if let Some(snapshot) = frozen {
            tx.execute("UPDATE document_versions SET managed_path=?1 WHERE document_id=?2 AND version_number=?3",params![self.encode_path_ref(&snapshot),document.id,document.current_version_number]).map_err(io)?;
        }
        tx.execute(
            "INSERT INTO file_working_contents(document_id,state,bytes) VALUES (?1,?2,?3)",
            params![
                document.id,
                serde_json::to_string(&state).map_err(io)?,
                read_bounded(path, &state.hash)?
            ],
        )
        .map_err(io)?;
        tx.commit().map_err(io)?;
        Ok(state)
    }
    pub(crate) fn file_working_open_status(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
    ) -> AgentResult<WorkingStatus> {
        let _durable = Durable::new(&self.conn)?;
        let document = self.working_authorize(request, binding, object)?;
        let _locks = self.file_recovery_write_locks(document.id).map_err(io)?;
        let _permit = self.file_commit_permit()?;
        self.working_recover_locked(object)?;
        let state = self.working_initialize_locked(object)?;
        self.working_status(object, &state)
    }
    pub(crate) fn file_working_begin_session(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
    ) -> AgentResult<crate::file_working::WorkingOpened> {
        let _durable = Durable::new(&self.conn)?;
        let document = self.working_authorize(request, binding, object)?;
        let _locks = self.file_recovery_write_locks(document.id).map_err(io)?;
        let _permit = self.file_commit_permit()?;
        self.working_recover_locked(object)?;
        let state = self.working_initialize_locked(object)?;
        let metadata = fs::metadata(&document.managed_path).map_err(io)?;
        if metadata.len() > crate::file_content::MAX_CONTENT {
            return Err(error(
                ErrorCode::BudgetExceeded,
                "File exceeds the 100 MiB editor limit",
            ));
        }
        let bytes = read_bounded(Path::new(&document.managed_path), &state.hash)?;
        self.working_check_disk(Path::new(&document.managed_path), &state)?;
        self.conn
            .execute(
                "DELETE FROM file_working_sessions WHERE generation!=?1",
                [&binding.generation],
            )
            .map_err(io)?;
        let count: i64 = self
            .conn
            .query_row("SELECT count(*) FROM file_working_sessions", [], |r| {
                r.get(0)
            })
            .map_err(io)?;
        if count >= 16 {
            return Err(error(
                ErrorCode::BudgetExceeded,
                "Close an editing session before opening another File",
            ));
        }
        let id = files::token();
        self.conn.execute("INSERT INTO file_working_sessions(session_id,document_id,generation,object,base_hash,name,bytes) VALUES (?1,?2,?3,?4,?5,?6,?7)",params![id,document.id,binding.generation,serde_json::to_string(object).map_err(io)?,state.hash,document.name,bytes]).map_err(io)?;
        use base64::Engine;
        Ok(crate::file_working::WorkingOpened {
            status: self.working_status(object, &state)?,
            session_id: id,
            name: document.name,
            base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            format: None,
            model: None,
        })
    }
    pub(crate) fn file_working_session_name(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &crate::file_working::WorkingSession,
    ) -> AgentResult<String> {
        let document = self.working_authorize(request, binding, &input.object)?;
        let row:Option<(String,String,String)>=self.conn.query_row("SELECT generation,object,name FROM file_working_sessions WHERE session_id=?1 AND document_id=?2",params![input.session_id,document.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(io)?;
        let (generation, object, name) = row.ok_or_else(|| {
            error(
                ErrorCode::RevisionConflict,
                "Editing session expired; reopen the File",
            )
        })?;
        if generation != binding.generation
            || serde_json::from_str::<ObjectRef>(&object).map_err(io)? != input.object
        {
            return Err(error(
                ErrorCode::ScopeDenied,
                "Editing base belongs to another File or Workspace generation",
            ));
        }
        Ok(name)
    }
    pub(crate) fn file_working_session_base(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &crate::file_working::WorkingSession,
    ) -> AgentResult<(String, Vec<u8>)> {
        let name = self.file_working_session_name(request, binding, input)?;
        let bytes = self
            .conn
            .query_row(
                "SELECT bytes FROM file_working_sessions WHERE session_id=?1",
                [&input.session_id],
                |r| r.get(0),
            )
            .map_err(io)?;
        Ok((name, bytes))
    }
    /// Warm view reads authorize the fixed session without copying its BLOB.
    pub(crate) fn file_working_view_metadata(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &crate::file_working::WorkingSession,
    ) -> AgentResult<(String, String, usize)> {
        let name = self.file_working_session_name(request, binding, input)?;
        let (hash, length): (String, i64) = self
            .conn
            .query_row(
                "SELECT base_hash,length(bytes) FROM file_working_sessions WHERE session_id=?1",
                [&input.session_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(io)?;
        let length = usize::try_from(length).map_err(io)?;
        Ok((name, hash, length))
    }
    pub(crate) fn file_working_close(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &crate::file_working::WorkingSession,
    ) -> AgentResult<()> {
        let _permit = self.file_commit_permit()?;
        self.file_working_session_name(request, binding, input)?;
        self.conn
            .execute(
                "DELETE FROM file_working_sessions WHERE session_id=?1",
                [&input.session_id],
            )
            .map_err(io)?;
        Ok(())
    }
    fn working_recovery_check_disk(&self, path: &Path, state: &State) -> AgentResult<()> {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                self.working_check_disk(path, state)
            }
            Ok(_) => Err(error(
                ErrorCode::FileChangedUnregistered,
                "Working recovery artifact changed; journal retained",
            )),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(error(
                ErrorCode::FileChangedUnregistered,
                "Working recovery artifact missing; journal retained",
            )),
            Err(e) => Err(io(e)),
        }
    }
    pub(super) fn working_recover_locked(&self, object: &ObjectRef) -> AgentResult<()> {
        let _durable = Durable::new(&self.conn)?;
        let id: i64 = object.id.parse().map_err(io)?;
        // Authorization may precede a wait for owner/File leases. A move can
        // finish during that gap; even a journal-free replay must recheck scope.
        let actual = self.document_record(id).map_err(io)?;
        if object.scope != super::file_scope::scope(actual.project_id)
            || self.native_workspace_id.as_deref() != Some(object.workspace_id.as_str())
        {
            return Err(error(
                ErrorCode::ScopeDenied,
                "File moved to another owner while waiting for its lease",
            ));
        }
        let pending: Option<String> = self
            .conn
            .query_row(
                "SELECT journal FROM file_working_contents WHERE document_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()
            .map_err(io)?
            .flatten();
        let Some(pending) = pending else {
            return Ok(());
        };
        let journal: Journal = serde_json::from_str(&pending).map_err(io)?;
        let document = self.document_record(id).map_err(io)?;
        let target = self.decode_path_ref(&journal.target);
        let staged = self.decode_path_ref(&journal.staged);
        let backup = self.decode_path_ref(&journal.backup);
        if journal.object != *object || target != Path::new(&document.managed_path) {
            return Err(error(
                ErrorCode::IoFailed,
                "Working replacement journal ownership changed",
            ));
        }
        let staging_parent = if journal.placement.is_some() {
            target.parent().unwrap().to_owned()
        } else {
            document.history_dir_path.into()
        };
        if staged.parent() != Some(staging_parent.as_path())
            || backup.parent() != staged.parent()
            || staged == backup
        {
            return Err(error(
                ErrorCode::IoFailed,
                "Working replacement journal ownership changed",
            ));
        }
        files::relative(&self.workspace_root, &target).map_err(io)?;
        let (new_prefix, old_prefix) = if journal.placement.is_some() {
            (".pm-working-new-", ".pm-working-old-")
        } else {
            ("working-new-", "working-old-")
        };
        for (path, prefix) in [(&staged, new_prefix), (&backup, old_prefix)] {
            files::relative(&self.workspace_root, path).map_err(io)?;
            if !path
                .file_name()
                .and_then(|s| s.to_str())
                .and_then(|s| s.strip_prefix(prefix))
                .is_some_and(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            {
                return Err(error(
                    ErrorCode::IoFailed,
                    "Invalid working replacement path",
                ));
            }
        }
        if staged
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .strip_prefix(new_prefix)
            != backup
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .strip_prefix(old_prefix)
        {
            return Err(error(
                ErrorCode::IoFailed,
                "Working replacement tokens differ",
            ));
        }
        journal.check_parents(&target, &staged)?;
        let current = self
            .working_state(id)?
            .ok_or_else(|| error(ErrorCode::IoFailed, "Working replacement state missing"))?;
        let committed =
            current.revision == journal.new.revision && current.hash == journal.new.hash;
        // State, BLOB and receipt committed atomically. A later external edit
        // does not undo that outcome; cleanup only touches our owned artifacts.
        if !committed {
            if current.revision != journal.old.revision || current.hash != journal.old.hash {
                return Err(error(
                    ErrorCode::RevisionConflict,
                    "Interrupted working revision changed",
                ));
            }
            let target_exists = match fs::symlink_metadata(&target) {
                Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => true,
                Ok(_) => {
                    return Err(error(
                        ErrorCode::FileChangedUnregistered,
                        "Working target is no longer a regular File; journal retained",
                    ))
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
                Err(e) => return Err(io(e)),
            };
            if target_exists {
                let identity = files::path_identity(&target).map_err(io)?;
                if identity == journal.new.identity {
                    self.working_check_disk(&target, &journal.new)?;
                    journal.check_parents(&target, &staged)?;
                    working_move(&target, &staged).map_err(io)?;
                } else {
                    self.working_check_disk(&target, &journal.old)?;
                    if backup.exists() {
                        return Err(error(
                            ErrorCode::FileChangedUnregistered,
                            "Working replacement has two old originals",
                        ));
                    }
                }
            }
            if !target.exists() {
                self.working_recovery_check_disk(&backup, &journal.old)?;
                journal.check_parents(&target, &staged)?;
                working_move(&backup, &target).map_err(io)?;
            }
        }
        for (path, state) in [(&backup, &journal.old), (&staged, &journal.new)] {
            match fs::symlink_metadata(path) {
                Ok(_) => {
                    self.working_recovery_check_disk(path, state)?;
                    journal.check_parents(&target, &staged)?;
                    fs::remove_file(path).map_err(io)?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(io(e)),
            }
        }
        files::sync_directory(target.parent().unwrap()).map_err(io)?;
        files::sync_directory(staged.parent().unwrap()).map_err(io)?;
        journal.check_parents(&target, &staged)?;
        self.conn
            .execute(
                "UPDATE file_working_contents SET journal=NULL WHERE document_id=?1",
                [id],
            )
            .map_err(io)?;
        Ok(())
    }
}
#[cfg(test)]
#[path = "file_working_tests.rs"]
mod tests;

impl Database {
    pub(crate) fn file_working_save<T: Serialize>(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        session: &crate::file_working::WorkingSession,
        expected_revision: i64,
        expected_hash: &str,
        payload: &T,
        bytes: &[u8],
        now: i64,
    ) -> AgentResult<WorkingStatus> {
        let _durable = Durable::new(&self.conn)?;
        use sha2::{Digest, Sha256};
        use std::io::Write;
        if bytes.len() as u64 > crate::file_content::MAX_CONTENT {
            return Err(error(
                ErrorCode::BudgetExceeded,
                "File exceeds the 100 MiB editor limit",
            ));
        }
        let object = &session.object;
        let document = self.working_authorize(request, binding, object)?;
        let _locks = self.file_recovery_write_locks(document.id).map_err(io)?;
        let _permit = self.file_commit_permit()?;
        self.working_recover_locked(object)?;
        // A replay remains available after close, but never bypasses ownership.
        if let Some(saved) = self.agent_operation_replay(
            &request.caller.key(),
            &request.request_id,
            "file.working.save",
            payload,
        )? {
            return Ok(saved);
        }
        self.file_working_session_name(request, binding, session)?;
        let old = self.working_initialize_locked(object)?;
        if expected_revision != old.revision || expected_hash != old.hash {
            return Err(error(
                ErrorCode::RevisionConflict,
                "Working File revision changed; preserve unsaved edits and reopen",
            ));
        }
        let hash = format!("sha256:{:x}", Sha256::digest(bytes));
        if hash == old.hash {
            let mut status = self.working_status(object, &old)?;
            status.no_change = true;
            return self.agent_atomic_operation(
                &request.caller.key(),
                &request.request_id,
                "file.working.save",
                payload,
                |_| Ok((status, None)),
            );
        }
        let target = Path::new(&document.managed_path);
        files::relative(&self.workspace_root, target).map_err(io)?;
        let staging_parent = target.parent().unwrap();
        // An owner move may leave immutable history on the old volume. Only
        // replacement artifacts use live's existing, identity-checked parent,
        // just like directory restore. No extra metadata directory is left to
        // obstruct a later directory move; history rows and bytes never move.
        let placement = Placement {
            live_parent: directory_identity(staging_parent).map_err(io)?,
        };
        working_crash(0);
        let token = files::token();
        let staged = staging_parent.join(format!(".pm-working-new-{token}"));
        let backup = staging_parent.join(format!(".pm-working-old-{token}"));
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staged)
            .map_err(io)?;
        file.write_all(bytes).map_err(io)?;
        file.sync_all().map_err(io)?;
        let archived_hash:Option<String>=self.conn.query_row("SELECT h.content_hash FROM document_versions v JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1 AND v.version_number=?2",params![document.id,document.current_version_number],|r|r.get(0)).optional().map_err(io)?;
        let new = State {
            revision: old
                .revision
                .checked_add(1)
                .ok_or_else(|| error(ErrorCode::BudgetExceeded, "Working revision exhausted"))?,
            hash: hash.clone(),
            identity: files::identity(&file).map_err(io)?,
            activity: Some(old.activity.unwrap_or(now).max(now)),
            pending: archived_hash.as_deref() != Some(&hash),
        };
        drop(file);
        files::sync_directory(&staging_parent).map_err(io)?;
        let journal = Journal {
            placement: Some(placement),
            object: object.clone(),
            target: self.encode_path_ref(target),
            staged: self.encode_path_ref(&staged),
            backup: self.encode_path_ref(&backup),
            old: old.clone(),
            new: new.clone(),
        };
        journal.check_parents(target, &staged)?;
        self.conn
            .execute(
                "UPDATE file_working_contents SET journal=?1 WHERE document_id=?2",
                params![serde_json::to_string(&journal).map_err(io)?, document.id],
            )
            .map_err(io)?;
        working_crash(1);
        let result = (|| {
            self.working_authorize(request, binding, object)?;
            self.working_check_disk(target, &old)?;
            journal.check_parents(target, &staged)?;
            working_move(target, &backup).map_err(io)?;
            files::sync_directory(target.parent().unwrap()).map_err(io)?;
            files::sync_directory(&staging_parent).map_err(io)?;
            working_crash(2);
            self.working_check_disk(&backup, &old)?;
            journal.check_parents(target, &staged)?;
            working_move(&staged, target).map_err(io)?;
            files::sync_directory(target.parent().unwrap()).map_err(io)?;
            files::sync_directory(&staging_parent).map_err(io)?;
            working_crash(3);
            let tx = rusqlite::Transaction::new_unchecked(
                &self.conn,
                rusqlite::TransactionBehavior::Immediate,
            )
            .map_err(io)?;
            self.working_check_disk(target, &new)?;
            journal.check_parents(target, &staged)?;
            self.working_authorize(request, binding, object)?;
            tx.execute(
                "UPDATE file_working_contents SET state=?1,bytes=?3 WHERE document_id=?2",
                params![serde_json::to_string(&new).map_err(io)?, document.id, bytes],
            )
            .map_err(io)?;
            if document.storage_mode == "project_directory" {
                tx.execute("UPDATE project_directory_files SET physical_identity=?1,state='ready',reason=NULL WHERE document_id=?2",params![serde_json::to_string(&new.identity).map_err(io)?,document.id]).map_err(io)?;
            }
            let status = self.working_status(object, &new)?;
            let saved = self.agent_atomic_operation_in_transaction(
                &tx,
                &request.caller.key(),
                &request.request_id,
                "file.working.save",
                payload,
                |_| {
                    Ok((
                        status,
                        Some(super::agent_operations::OperationChange {
                            object_key: object.key()?,
                            scope: object.scope.clone(),
                            revision: format!("working:{}:{}", new.revision, new.hash),
                        }),
                    ))
                },
            )?;
            working_crash(5);
            tx.commit().map_err(io)?;
            working_crash(4);
            Ok(saved)
        })();
        self.working_recover_locked(object)?;
        result
    }
    pub(crate) fn file_working_activity(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &crate::file_working::WorkingSession,
        now: i64,
    ) -> AgentResult<WorkingStatus> {
        let _durable = Durable::new(&self.conn)?;
        self.file_working_session_name(request, binding, input)?;
        let document = self.working_authorize(request, binding, &input.object)?;
        let _project = self
            .file_project_lock(document.project_id, false)
            .map_err(io)?;
        let _file = self.file_version_lock(document.id).map_err(io)?;
        let _permit = self.file_commit_permit()?;
        self.working_recover_locked(&input.object)?;
        self.file_working_session_name(request, binding, input)?;
        let mut state = self
            .working_state(document.id)?
            .ok_or_else(|| error(ErrorCode::SourceNotReady, "Working content is unavailable"))?;
        state.activity = Some(state.activity.unwrap_or(now).max(now));
        self.conn
            .execute(
                "UPDATE file_working_contents SET state=?1 WHERE document_id=?2",
                params![serde_json::to_string(&state).map_err(io)?, document.id],
            )
            .map_err(io)?;
        self.working_status(&input.object, &state)
    }
    fn working_archive_authorize(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
        source_checkpoint: bool,
    ) -> AgentResult<crate::models::DocumentRecord> {
        if !source_checkpoint {
            return self.working_authorize(request, binding, object);
        }
        crate::file_version_service::validate_binding(&request.binding, binding)?;
        let actual = self.source_read_object(request, binding, object)?;
        self.document_record(actual.id.parse().map_err(io)?)
            .map_err(io)
    }
    pub(crate) fn file_working_archive(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
        now: i64,
        force: bool,
    ) -> AgentResult<WorkingStatus> {
        self.working_archive(request, binding, object, now, force, false, None)
    }
    pub(crate) fn file_working_checkpoint_source(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
    ) -> AgentResult<()> {
        self.source_read_object(request, binding, object)?;
        if self
            .working_state(object.id.parse().map_err(io)?)?
            .is_some_and(|s| s.pending)
        {
            self.working_archive(
                request,
                binding,
                object,
                chrono::Utc::now().timestamp_millis(),
                true,
                true,
                None,
            )?;
        }
        Ok(())
    }
    fn working_archive(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
        now: i64,
        force: bool,
        source_checkpoint: bool,
        drop_intent: Option<(&str, &super::file_owner_move::FileMoveBaseline)>,
    ) -> AgentResult<WorkingStatus> {
        let _durable = Durable::new(&self.conn)?;
        let document =
            self.working_archive_authorize(request, binding, object, source_checkpoint)?;
        let _locks = self.file_recovery_write_locks(document.id).map_err(io)?;
        let _permit = self.file_commit_permit()?;
        self.working_recover_locked(object)?;
        if let Some((_, baseline)) = drop_intent {
            let actual = self.move_baseline_locked(document.id)?;
            if actual != *baseline {
                return Err(error(
                    ErrorCode::RevisionConflict,
                    "File changed before Drop archive",
                ));
            }
        }
        let mut state = self.working_initialize_locked(object)?;
        if !state.pending
            || (!force
                && state
                    .activity
                    .is_none_or(|at| at.saturating_add(IDLE_MS) > now))
        {
            if let Some((id, baseline)) = drop_intent {
                self.working_drop_marker(&self.conn, id, baseline)?;
            }
            return self.working_status(object, &state);
        }
        let target = Path::new(&document.managed_path);
        let history = Path::new(&document.history_dir_path);
        files::create_owned_directories(&self.workspace_root, history).map_err(io)?;
        let snapshot = history.join(files::token());
        let (hash, identity, _) =
            files::snapshot_bounded(target, &snapshot, Some(crate::file_content::MAX_CONTENT))
                .map_err(io)?;
        if hash != state.hash || identity != state.identity {
            return Err(error(
                ErrorCode::FileChangedUnregistered,
                "File changed while archiving working content",
            ));
        }
        files::sync_directory(history).map_err(io)?;
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(io)?;
        self.working_archive_authorize(request, binding, object, source_checkpoint)?;
        self.working_check_disk(target, &state)?;
        let version = document
            .current_version_number
            .checked_add(1)
            .filter(|v| *v <= u32::MAX as i64)
            .ok_or_else(|| error(ErrorCode::BudgetExceeded, "File version exhausted"))?;
        let timestamp = super::now_iso();
        tx.execute("INSERT INTO document_versions(document_id,version_number,name,source_path,managed_path,created_at) VALUES (?1,?2,?3,?4,?5,?6)",params![document.id,version,document.name,self.encode_path_ref(target),self.encode_path_ref(&snapshot),timestamp]).map_err(io)?;
        let version_id = tx.last_insert_rowid();
        tx.execute("INSERT INTO source_file_version_hashes(document_version_id,content_hash) VALUES (?1,?2)",params![version_id,state.hash]).map_err(io)?;
        let changed=tx.execute("UPDATE documents SET current_version_number=?1,version_count=version_count+1,updated_at=?2 WHERE id=?3 AND current_version_number=?4",params![version,timestamp,document.id,document.current_version_number]).map_err(io)?;
        if changed != 1 {
            return Err(error(
                ErrorCode::RevisionConflict,
                "History changed before working archive",
            ));
        }
        state.pending = false;
        tx.execute(
            "UPDATE file_working_contents SET state=?1 WHERE document_id=?2",
            params![serde_json::to_string(&state).map_err(io)?, document.id],
        )
        .map_err(io)?;
        tx.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES (?1,?2,'file.working.archive',?3,?4)",params![object.key()?,object.scope.key(),state.hash,timestamp]).map_err(io)?;
        if let Some((id, _)) = drop_intent {
            self.working_drop_marker(
                &tx,
                id,
                &super::file_owner_move::FileMoveBaseline {
                    expected_version: version,
                    expected_working_revision: Some(state.revision),
                    expected_hash: state.hash.clone(),
                },
            )?;
        }
        tx.commit().map_err(io)?;
        self.working_status(object, &state)
    }
    fn working_drop_marker(
        &self,
        conn: &rusqlite::Connection,
        id: &str,
        baseline: &super::file_owner_move::FileMoveBaseline,
    ) -> AgentResult<()> {
        // Legacy managed imports also use working-save replacement. Their directory
        // identity must follow this explicitly verified saved base before Drop replaces it.
        let document_id:i64=conn.query_row("SELECT json_extract(payload,'$.prepare.target.documentId') FROM file_drop_intents WHERE id=?1",[id],|r|r.get(0)).map_err(io)?;
        let doc = self.document_record(document_id).map_err(io)?;
        let physical = match self.working_state(document_id)? {
            Some(state) => state.identity,
            None => files::path_identity(Path::new(&doc.managed_path)).map_err(io)?,
        };
        conn.execute("UPDATE project_directory_files SET physical_identity=?1,state='ready',reason=NULL WHERE document_id=?2",params![serde_json::to_string(&physical).map_err(io)?,document_id]).map_err(io)?;
        let changed = conn.execute("UPDATE file_drop_intents SET payload=json_set(payload,'$.post_archive',json(?2)) WHERE id=?1", params![id,serde_json::to_string(baseline).map_err(io)?]).map_err(io)?;
        if changed != 1 {
            return Err(error(ErrorCode::NotFound, "Drop archive intent missing"));
        }
        Ok(())
    }
    pub(super) fn file_working_drop_archive(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
        intent_id: &str,
        baseline: &super::file_owner_move::FileMoveBaseline,
    ) -> AgentResult<()> {
        if baseline.expected_working_revision.is_some() {
            self.working_archive(
                request,
                binding,
                object,
                chrono::Utc::now().timestamp_millis(),
                true,
                false,
                Some((intent_id, baseline)),
            )?;
        } else {
            let _durable = Durable::new(&self.conn)?;
            self.working_archive_authorize(request, binding, object, false)?;
            let _locks = self
                .file_recovery_write_locks(object.id.parse().map_err(io)?)
                .map_err(io)?;
            let _permit = self.file_commit_permit()?;
            self.working_archive_authorize(request, binding, object, false)?;
            let actual = self.move_baseline_locked(object.id.parse().map_err(io)?)?;
            if actual != *baseline {
                return Err(error(
                    ErrorCode::RevisionConflict,
                    "File changed before Drop archive",
                ));
            }
            self.working_drop_marker(&self.conn, intent_id, baseline)?;
        }
        Ok(())
    }
    /// The native scheduler runs on startup and periodically while a Workspace
    /// is open; deadlines are persisted and never derived from a Tab timer.
    pub(crate) fn file_working_due_objects(
        &self,
        workspace: &str,
        now: i64,
    ) -> AgentResult<Vec<ObjectRef>> {
        let mut stmt=self.conn.prepare("SELECT d.id,d.project_id,w.state FROM file_working_contents w JOIN documents d ON d.id=w.document_id").map_err(io)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<i64>>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(io)?;
        let mut result = Vec::new();
        for row in rows {
            let (id, project, state) = row.map_err(io)?;
            let state: State = serde_json::from_str(&state).map_err(io)?;
            if state.pending
                && state
                    .activity
                    .is_some_and(|at| at.saturating_add(IDLE_MS) <= now)
            {
                result.push(ObjectRef {
                    workspace_id: workspace.into(),
                    scope: super::file_scope::scope(project),
                    kind: crate::agent::models::ObjectKind::File,
                    id: id.to_string(),
                });
            }
        }
        Ok(result)
    }
    pub(crate) fn file_working_recover_pending(&self) -> anyhow::Result<()> {
        let mut statement = self.conn.prepare(
            "SELECT document_id,journal FROM file_working_contents WHERE journal IS NOT NULL",
        )?;
        let rows = statement
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, journal) in rows {
            let journal: Journal = serde_json::from_str(&journal)?;
            let project = self.document_record(id)?.project_id;
            if journal.object.id != id.to_string()
                || journal.object.scope != super::file_scope::scope(project)
                || journal.object.kind != crate::agent::models::ObjectKind::File
                || self
                    .native_workspace_id
                    .as_ref()
                    .is_some_and(|workspace| workspace != &journal.object.workspace_id)
            {
                anyhow::bail!("Working replacement journal object ownership changed");
            }
            let _project = self.file_project_lock(project, false)?;
            let _file = self.file_version_lock(id)?;
            let _permit = self
                .file_commit_permit()
                .map_err(|e| anyhow::anyhow!(e.message))?;
            match self.working_recover_locked(&journal.object) {
                Ok(()) => (),
                Err(e)
                    if matches!(
                        e.code,
                        ErrorCode::FileChangedUnregistered | ErrorCode::RevisionConflict
                    ) =>
                {
                    // Retain evidence and let the target operation surface the
                    // conflict; unrelated Files and Workspace startup can proceed.
                    eprintln!(
                        "Working File {id} recovery conflict; journal retained: {}",
                        e.message
                    );
                }
                Err(e) => return Err(anyhow::anyhow!(e.message)),
            }
        }
        Ok(())
    }
    /// Call under the exclusive owner lease before moving/removing its root.
    pub(super) fn file_working_require_owner_recovered(
        &self,
        project: Option<i64>,
    ) -> AgentResult<()> {
        let unresolved: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM file_working_contents w JOIN documents d ON d.id=w.document_id WHERE d.project_id IS ?1 AND w.journal IS NOT NULL)",
            [project], |row| row.get(0),
        ).map_err(io)?;
        if unresolved {
            return Err(error(ErrorCode::FileChangedUnregistered, "Resolve File working replacement conflicts before moving or removing their owner root"));
        }
        Ok(())
    }
    /// A global scan may retain another File's external conflict. Target writers
    /// must still reject a retained journal while holding that File's lease.
    pub(super) fn file_working_require_recovered(&self, id: i64) -> AgentResult<()> {
        let unresolved: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM file_working_contents WHERE document_id=?1 AND journal IS NOT NULL)",
            [id], |row| row.get(0),
        ).map_err(io)?;
        if unresolved {
            return Err(error(
                ErrorCode::FileChangedUnregistered,
                "Resolve this File's working replacement conflict before another write",
            ));
        }
        Ok(())
    }
    /// Legacy writers must hand off pending GUI content explicitly, before
    /// obtaining a fixed Version CAS. Historical source reads remain unchanged.
    pub(crate) fn file_working_require_archived(&self, id: i64) -> AgentResult<()> {
        self.file_working_require_recovered(id)?;
        if self.working_state(id)?.is_some_and(|s| s.pending) {
            return Err(error(ErrorCode::RevisionConflict,"Unarchived working content exists; archive the File explicitly and reacquire its fixed source before AI edits or restoration"));
        }
        Ok(())
    }
    /// The discovery/resolve path must recognize our own persisted bytes without
    /// turning each successful GUI save into an external-history registration.
    pub(crate) fn file_working_matches_live(&self, object: &ObjectRef) -> anyhow::Result<bool> {
        let id: i64 = object.id.parse()?;
        self.working_recover_locked(object)
            .map_err(|e| anyhow::anyhow!(e.message))?;
        if let Some(state) = self
            .working_state(id)
            .map_err(|e| anyhow::anyhow!(e.message))?
        {
            let doc = self.document_record(id)?;
            let path = Path::new(&doc.managed_path);
            if files::path_identity(path)? == state.identity && files::checksum(path)? == state.hash
            {
                return Ok(true);
            }
            if state.pending {
                return Err(anyhow::anyhow!(
                    "External File change conflicts with unarchived working content"
                ));
            }
        }
        Ok(false)
    }
}
#[cfg(test)]
thread_local! {
    static WORKING_STAGE_HOOK: std::cell::RefCell<Option<Box<dyn Fn(u8)>>> = const { std::cell::RefCell::new(None) };
}
fn working_crash(stage: u8) {
    #[cfg(test)]
    WORKING_STAGE_HOOK.with(|hook| {
        if let Some(callback) = hook.borrow().as_ref() {
            callback(stage);
        }
    });
    #[cfg(test)]
    if std::env::var("MIND_WORKING_CRASH_STAGE")
        .ok()
        .and_then(|s| s.parse::<u8>().ok())
        == Some(stage)
    {
        #[cfg(unix)]
        {
            unsafe extern "C" {
                fn kill(pid: i32, signal: i32) -> i32;
            }
            unsafe {
                kill(std::process::id() as i32, 9);
            }
            loop {
                std::thread::park();
            }
        }
        #[cfg(not(unix))]
        std::process::exit(91);
    }
    #[cfg(not(test))]
    let _ = stage;
}
impl Database {
    pub(crate) fn file_working_save_replay<T: Serialize>(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
        payload: &T,
    ) -> AgentResult<Option<WorkingStatus>> {
        let document = self.working_authorize(request, binding, object)?;
        let _locks = self.file_recovery_write_locks(document.id).map_err(io)?;
        let _permit = self.file_commit_permit()?;
        self.working_recover_locked(object)?;
        self.agent_operation_replay(
            &request.caller.key(),
            &request.request_id,
            "file.working.save",
            payload,
        )
    }
    pub(crate) fn file_working_verify_open(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        session: &crate::file_working::WorkingSession,
        revision: i64,
        hash: &str,
    ) -> AgentResult<()> {
        let current = self.file_working_open_status(request, binding, &session.object)?;
        self.file_working_session_name(request, binding, session)?;
        if current.revision != revision || current.content_hash != hash {
            return Err(error(
                ErrorCode::RevisionConflict,
                "Working File changed during editor inspection; reopen its current content",
            ));
        }
        Ok(())
    }
}
impl Database {
    /// One recovery copy, overwritten by each successful working save. This is
    /// never listed as a File Version and never overwrites external content.
    pub(crate) fn file_working_recovery_read(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
    ) -> AgentResult<crate::file_working::WorkingRecovery> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        use sha2::{Digest, Sha256};
        let document = self.working_authorize(request, binding, object)?;
        let _project = self
            .file_project_lock(document.project_id, false)
            .map_err(io)?;
        let _file = self.file_version_lock(document.id).map_err(io)?;
        let state = self
            .working_state(document.id)?
            .ok_or_else(|| error(ErrorCode::NotFound, "No saved working recovery content"))?;
        let bytes: Vec<u8> = self
            .conn
            .query_row(
                "SELECT bytes FROM file_working_contents WHERE document_id=?1",
                [document.id],
                |r| r.get(0),
            )
            .map_err(io)?;
        if bytes.len() as u64 > crate::file_content::MAX_CONTENT
            || format!("sha256:{:x}", Sha256::digest(&bytes)) != state.hash
        {
            return Err(error(
                ErrorCode::IoFailed,
                "Saved working recovery content failed integrity verification",
            ));
        }
        Ok(crate::file_working::WorkingRecovery {
            object: object.clone(),
            revision: state.revision,
            content_hash: state.hash,
            name: document.name,
            base64: STANDARD.encode(bytes),
        })
    }
}
