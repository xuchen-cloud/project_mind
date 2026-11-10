//! Cross-owner movement. History paths remain immutable; only live head is copied.
use super::{file_versions as files, Database};
use crate::agent::{
    access::{Caller, RequestContext},
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileOwnerMove {
    pub document_id: i64,
    pub source_owner: Option<i64>,
    pub target_owner: Option<i64>,
    pub expected_version: i64,
    pub expected_working_revision: Option<i64>,
    pub expected_hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileOwnerMoveResult {
    pub document_id: i64,
    pub project_id: Option<i64>,
    pub managed_path: String,
    pub operation_id: String,
    pub source_scope: Scope,
    pub target_scope: Scope,
    pub old_sessions_closed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileMoveBaseline {
    pub expected_version: i64,
    pub expected_working_revision: Option<i64>,
    pub expected_hash: String,
}
#[derive(Serialize, Deserialize)]
struct Payload {
    binding: WorkspaceBinding,
    input: FileOwnerMove,
}
#[derive(Serialize, Deserialize)]
struct Journal {
    schema_version: u32,
    retired: String,
    payload: Payload,
    request_id: String,
    source: String,
    target: String,
    staging: String,
    source_identity: files::FileIdentity,
    target_identity: files::FileIdentity,
}
pub(super) fn io(e: impl std::fmt::Display) -> AgentError {
    AgentError::new(ErrorCode::IoFailed, format!("Native File flow failed: {e}"))
}
fn denied(message: &str) -> AgentError {
    AgentError::new(ErrorCode::ScopeDenied, message)
}
fn conflict(message: &str) -> AgentError {
    AgentError::new(ErrorCode::RevisionConflict, message)
}
#[cfg(test)]
thread_local! {pub(super) static FAIL_MOVE:std::cell::Cell<u8>=const {std::cell::Cell::new(0)};}
fn fail(phase: u8) -> AgentResult<()> {
    #[cfg(test)]
    if std::env::var("MIND_FILE_OWNER_MOVE_CRASH_STAGE")
        .ok()
        .and_then(|value| value.parse::<u8>().ok())
        == Some(phase)
    {
        #[cfg(unix)]
        {
            unsafe extern "C" {
                fn kill(pid: i32, signal: i32) -> i32;
            }
            unsafe {
                kill(std::process::id() as i32, 9);
            }
        }
        std::process::exit(91);
    }
    #[cfg(test)]
    if FAIL_MOVE.with(|v| v.get() == phase) {
        return Err(io(format!("injected move failure {phase}")));
    }
    let _ = phase;
    Ok(())
}
impl Database {
    /// Historical paths are immutable. A root lifecycle operation must not
    /// rename/trash snapshots now belonging to a different File owner.
    pub(crate) fn file_owner_require_unshared_root(
        &self,
        root: &Path,
        owner: Option<i64>,
    ) -> anyhow::Result<()> {
        let mut statement=self.conn.prepare("SELECT d.id,d.managed_path,d.history_dir_path FROM documents d WHERE d.project_id IS NOT ?1 UNION ALL SELECT d.id,v.managed_path,'' FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE d.project_id IS NOT ?1")?;
        for row in statement.query_map([owner], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })? {
            let (id, managed, history) = row?;
            for path in [managed, history] {
                if !path.is_empty() && self.decode_path_ref(&path).starts_with(root) {
                    anyhow::bail!("This directory retains history for moved File {id}; preserve or relocate that history before renaming or recycling the directory");
                }
            }
        }
        Ok(())
    }
    pub(super) fn ensure_file_flow_schema(&self) -> anyhow::Result<()> {
        self.conn.execute_batch("CREATE TABLE IF NOT EXISTS file_owner_move_journals(id TEXT PRIMARY KEY,document_id INTEGER NOT NULL UNIQUE,payload TEXT NOT NULL CHECK(json_valid(payload))); CREATE TABLE IF NOT EXISTS file_owner_aliases(document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,scope_key TEXT NOT NULL,PRIMARY KEY(document_id,scope_key)); CREATE TABLE IF NOT EXISTS file_drop_intents(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL CHECK(json_valid(payload)),result TEXT CHECK(result IS NULL OR json_valid(result)),cleanup TEXT NOT NULL DEFAULT 'pending',warning TEXT);")?;
        Ok(())
    }
    pub(super) fn file_flow_gui(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
    ) -> AgentResult<()> {
        crate::file_version_service::validate_binding(&request.binding, binding)?;
        if self.native_workspace_id.as_deref() != Some(&binding.workspace_id) {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "File Workspace changed",
            ));
        }
        if !matches!(request.caller, Caller::Gui) {
            return Err(denied("File lifecycle changes require GUI authority"));
        }
        Ok(())
    }
    /// Read aliases identify one stable File, never grant its former scope.
    pub(super) fn file_resolve_read_alias(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        claimed: &ObjectRef,
    ) -> AgentResult<ObjectRef> {
        if claimed.workspace_id != binding.workspace_id
            || self
                .native_workspace_id
                .as_deref()
                .is_some_and(|id| id != binding.workspace_id)
        {
            return Err(denied("File reference belongs to another Workspace"));
        }
        let canonical = self
            .agent_resolve_object(claimed, &binding.workspace_id)?
            .ok_or_else(|| AgentError::new(ErrorCode::NotFound, "File no longer exists"))?;
        let id = canonical.id.parse::<i64>().map_err(io)?;
        if self.document_record(id).map_err(io)?.storage_mode == "managed_note_image" {
            return Err(denied("Record resources are not File references"));
        }
        if claimed.scope != canonical.scope {
            let alias:bool=self.conn.query_row("SELECT EXISTS(SELECT 1 FROM file_owner_aliases WHERE document_id=?1 AND scope_key=?2)",params![id,claimed.scope.key()],|r|r.get(0)).map_err(io)?;
            if !alias {
                return Err(denied("File reference is not a prior owner locator"));
            }
        }
        request.authorize_object(binding, &canonical, &canonical, "source.read")?;
        Ok(canonical)
    }
    fn move_object(&self, binding: &WorkspaceBinding, id: i64, owner: Option<i64>) -> ObjectRef {
        ObjectRef {
            workspace_id: binding.workspace_id.clone(),
            scope: super::file_scope::scope(owner),
            kind: ObjectKind::File,
            id: id.to_string(),
        }
    }
    fn move_authorize(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        id: i64,
        owner: Option<i64>,
    ) -> AgentResult<crate::models::DocumentRecord> {
        self.file_flow_gui(request, binding)?;
        let object = self.move_object(binding, id, owner);
        object.key()?;
        let actual = self
            .agent_resolve_object(&object, &binding.workspace_id)?
            .ok_or_else(|| AgentError::new(ErrorCode::NotFound, "File no longer exists"))?;
        request.authorize_object(binding, &object, &actual, "file.move")?;
        super::agent_file_undo::require_file_visible(&self.conn, id)?;
        let doc = self.document_record(id).map_err(io)?;
        if doc.storage_mode == "managed_note_image" {
            return Err(denied("Record resources cannot move as Files"));
        }
        Ok(doc)
    }
    pub(super) fn move_baseline_locked(&self, id: i64) -> AgentResult<FileMoveBaseline> {
        let doc = self.document_record(id).map_err(io)?;
        let state: Option<(String, Option<String>)> = self
            .conn
            .query_row(
                "SELECT state,journal FROM file_working_contents WHERE document_id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(io)?;
        let pending: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM file_owner_move_journals WHERE document_id=?1)",
                [id],
                |r| r.get(0),
            )
            .map_err(io)?;
        // Restore journals retain the original owner and live path. A read-only
        // baseline cannot migrate that recovery obligation to another owner.
        let pending_restore = self
            .table_exists("project_directory_restores")
            .map_err(io)?
            && self
                .conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM project_directory_restores WHERE document_id=?1)",
                    [id],
                    |r| r.get::<_, bool>(0),
                )
                .map_err(io)?;
        if pending || pending_restore || state.as_ref().is_some_and(|(_, j)| j.is_some()) {
            return Err(AgentError::new(
                ErrorCode::SourceNotReady,
                "File recovery must finish before moving",
            ));
        }
        let (revision, hash) = if let Some((state, _)) = state {
            let value: serde_json::Value = serde_json::from_str(&state).map_err(io)?;
            (
                Some(
                    value["revision"]
                        .as_i64()
                        .ok_or_else(|| io("Invalid working revision"))?,
                ),
                value["hash"]
                    .as_str()
                    .ok_or_else(|| io("Invalid working hash"))?
                    .to_owned(),
            )
        } else {
            let hash=self.conn.query_row("SELECT h.content_hash FROM document_versions v JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1 AND v.version_number=?2",params![id,doc.current_version_number],|r|r.get::<_,String>(0)).optional().map_err(io)?.ok_or_else(||AgentError::new(ErrorCode::SourceNotReady,"File head hash is unregistered"))?;
            (None, hash)
        };
        if !files::valid_hash(&hash) {
            return Err(io("Invalid File hash"));
        }
        if files::checksum(Path::new(&doc.managed_path)).map_err(io)? != hash {
            return Err(AgentError::new(
                ErrorCode::FileChangedUnregistered,
                "File was externally modified",
            ));
        }
        Ok(FileMoveBaseline {
            expected_version: doc.current_version_number,
            expected_working_revision: revision,
            expected_hash: hash,
        })
    }
    pub(crate) fn file_owner_move_baseline(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        document_id: i64,
        source_owner: Option<i64>,
    ) -> AgentResult<FileMoveBaseline> {
        self.move_authorize(request, binding, document_id, source_owner)?;
        let _owner = self.file_project_lock(source_owner, false).map_err(io)?;
        let _file = self
            .file_storage_lock("file-version-locks", document_id, false)
            .map_err(io)?;
        let _permit = self.file_commit_permit()?;
        self.move_authorize(request, binding, document_id, source_owner)?;
        self.move_baseline_locked(document_id)
    }
    pub(crate) fn file_owner_move_replay(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &FileOwnerMove,
    ) -> AgentResult<Option<FileOwnerMoveResult>> {
        self.file_flow_gui(request, binding)?;
        let owner = self
            .document_record(input.document_id)
            .map_err(io)?
            .project_id;
        let _owner = self.file_project_lock(owner, false).map_err(io)?;
        let _file = self
            .file_storage_lock("file-version-locks", input.document_id, false)
            .map_err(io)?;
        let _permit = self.file_commit_permit()?;
        self.move_authorize(request, binding, input.document_id, owner)?;
        self.agent_operation_replay(
            "gui",
            &request.request_id,
            "file.owner.move",
            &Payload {
                binding: binding.clone(),
                input: input.clone(),
            },
        )
    }
    pub(crate) fn file_owner_move(
        &mut self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &FileOwnerMove,
    ) -> AgentResult<FileOwnerMoveResult> {
        self.file_flow_gui(request, binding)?;
        request.authorize(
            binding,
            &super::file_scope::scope(input.source_owner),
            "file.move",
        )?;
        request.authorize(
            binding,
            &super::file_scope::scope(input.target_owner),
            "file.move",
        )?;
        if input.document_id <= 0
            || input.source_owner == input.target_owner
            || !files::valid_hash(&input.expected_hash)
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid File owner move",
            ));
        }
        self.file_version_recover_pending().map_err(io)?;
        let mut owners = vec![input.source_owner, input.target_owner];
        owners.sort();
        owners.dedup();
        let _owners = owners
            .into_iter()
            .map(|id| self.file_project_lock(id, true))
            .collect::<anyhow::Result<Vec<_>>>()
            .map_err(io)?;
        let _file = self.file_version_lock(input.document_id).map_err(io)?;
        let _permit = self.file_commit_permit()?;
        let payload = Payload {
            binding: binding.clone(),
            input: input.clone(),
        };
        if let Some(previous) =
            self.agent_operation_replay("gui", &request.request_id, "file.owner.move", &payload)?
        {
            let doc = self.document_record(input.document_id).map_err(io)?;
            request.authorize(
                binding,
                &super::file_scope::scope(doc.project_id),
                "file.move",
            )?;
            request.require_object_allowed(&self.move_object(binding, doc.id, doc.project_id))?;
            return Ok(previous);
        }
        let doc = self.move_authorize(request, binding, input.document_id, input.source_owner)?;
        if self.file_scope_archived(input.source_owner).map_err(io)? {
            return Err(denied("Archived source cannot be moved"));
        }
        if self.file_scope_archived(input.target_owner).map_err(io)? {
            return Err(denied("Target Project is archived"));
        }
        let target_root = self
            .ensure_file_scope_root(input.target_owner)
            .map_err(io)?;
        let baseline = self.move_baseline_locked(doc.id)?;
        if baseline
            != (FileMoveBaseline {
                expected_version: input.expected_version,
                expected_working_revision: input.expected_working_revision,
                expected_hash: input.expected_hash.clone(),
            })
        {
            return Err(conflict("File changed after save barrier"));
        }
        self.ensure_document_name_available(input.target_owner, &doc.base_name, None)
            .map_err(|_| conflict("Target File name is occupied"))?;
        let target = target_root.join(&doc.name);
        if target.symlink_metadata().is_ok() {
            return Err(conflict("Target File path is occupied"));
        }
        let source = Path::new(&doc.managed_path);
        let source_ref = files::relative(&self.workspace_root, source).map_err(io)?;
        let target_ref = files::relative(&self.workspace_root, &target).map_err(io)?;
        let token = files::token();
        let staging = target_root.join(format!(".pm-owner-move-{token}"));
        let (hash, source_identity, target_identity) =
            files::snapshot_bounded(source, &staging, None).map_err(io)?;
        if hash != input.expected_hash {
            fs::remove_file(&staging).map_err(io)?;
            return Err(conflict("File changed during copy"));
        }
        files::sync_directory(&target_root).map_err(io)?;
        let journal = Journal {
            schema_version: 1,
            retired: files::relative(
                &self.workspace_root,
                &source
                    .parent()
                    .unwrap()
                    .join(format!(".pm-owner-retire-{token}")),
            )
            .map_err(io)?,
            payload,
            request_id: request.request_id.clone(),
            source: source_ref,
            target: target_ref,
            staging: files::relative(&self.workspace_root, &staging).map_err(io)?,
            source_identity,
            target_identity,
        };
        let synchronous: i64 = self
            .conn
            .pragma_query_value(None, "synchronous", |r| r.get(0))
            .map_err(io)?;
        self.conn
            .pragma_update(None, "synchronous", synchronous.max(2))
            .map_err(io)?;
        let outcome = (|| {
            self.conn
                .execute(
                    "INSERT INTO file_owner_move_journals(id,document_id,payload) VALUES(?1,?2,?3)",
                    params![token, doc.id, serde_json::to_string(&journal).map_err(io)?],
                )
                .map_err(io)?;
            fail(1)?;
            files::move_exclusive(&staging, &target).map_err(io)?;
            files::sync_directory(&target_root).map_err(io)?;
            fail(2)?;
            if files::path_identity(source).map_err(io)? != journal.source_identity
                || files::checksum(source).map_err(io)? != input.expected_hash
                || files::path_identity(&target).map_err(io)? != journal.target_identity
                || files::checksum(&target).map_err(io)? != input.expected_hash
            {
                return Err(conflict(
                    "File changed during placement; recovery evidence retained",
                ));
            }
            let source_object = self.move_object(binding, doc.id, input.source_owner);
            let target_object = self.move_object(binding, doc.id, input.target_owner);
            let result = FileOwnerMoveResult {
                document_id: doc.id,
                project_id: input.target_owner,
                managed_path: target.to_string_lossy().into(),
                operation_id: request.request_id.clone(),
                source_scope: source_object.scope.clone(),
                target_scope: target_object.scope.clone(),
                old_sessions_closed: true,
            };
            let source_key = source_object.key()?;
            let target_key = target_object.key()?;
            let target_path = self.encode_path_ref(&target);
            let old_path = self.encode_path_ref(source);
            let stamp = super::now_iso();
            self.agent_atomic_operation(
                "gui", &request.request_id, "file.owner.move", &journal.payload,
                |tx| {
                    let count = tx.execute(
                        "UPDATE documents SET project_id=?1,managed_path=?2,
                         original_path=CASE WHEN original_path=?3 THEN ?2 ELSE original_path END,
                         updated_at=?4 WHERE id=?5 AND project_id IS ?6
                         AND current_version_number=?7 AND managed_path=?3",
                        params![input.target_owner,target_path,old_path,stamp,doc.id,
                            input.source_owner,input.expected_version],
                    ).map_err(io)?;
                    if count != 1 { return Err(conflict("File owner changed before commit")); }
                    tx.execute("UPDATE document_versions SET managed_path=?1 WHERE document_id=?2 AND managed_path=?3",
                        params![target_path,doc.id,old_path]).map_err(io)?;
                    // Tag definitions may be edited independently of this File.
                    // Read their current label/color under the same SQL writer.
                    let source_tags = tx.prepare(
                        "SELECT t.label,t.color_key,t.project_id FROM document_tag_links l
                         JOIN file_tag_options t ON t.id=l.tag_id WHERE l.document_id=?1",
                    ).map_err(io)?.query_map([doc.id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<i64>>(2)?)))
                        .map_err(io)?.collect::<rusqlite::Result<Vec<_>>>().map_err(io)?;
                    let mut tags = Vec::new();
                    for (label,color,owner) in source_tags {
                        if owner != input.source_owner {return Err(denied("File Tag belongs to another owner"));}
                        let existing:Option<(i64,String)> = tx.query_row(
                            "SELECT id,color_key FROM file_tag_options WHERE project_id IS ?1 AND label=?2 COLLATE NOCASE",
                            params![input.target_owner,label],|r|Ok((r.get(0)?,r.get(1)?)),
                        ).optional().map_err(io)?;
                        let id = if let Some((id,target_color)) = existing {
                            if target_color != color {return Err(conflict("Target Tag has incompatible color"));}
                            id
                        } else {
                            tx.execute("INSERT INTO file_tag_options(project_id,label,color_key,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)",
                                params![input.target_owner,label,color,stamp]).map_err(io)?;
                            tx.last_insert_rowid()
                        };
                        tags.push(id);
                    }
                    tx.execute("DELETE FROM document_tag_links WHERE document_id=?1",[doc.id]).map_err(io)?;
                    for tag in tags {
                        tx.execute("INSERT INTO document_tag_links(document_id,tag_id,created_at) VALUES(?1,?2,?3)",params![doc.id,tag,stamp]).map_err(io)?;
                    }
                    let identity = serde_json::to_string(&journal.target_identity).map_err(io)?;
                    tx.execute("UPDATE file_working_contents SET state=json_set(state,'$.identity',json(?2)) WHERE document_id=?1",
                        params![doc.id,identity]).map_err(io)?;
                    tx.execute("DELETE FROM file_working_sessions WHERE document_id=?1",[doc.id]).map_err(io)?;
                    tx.execute("UPDATE project_directory_files SET physical_identity=?2,state='ready',reason=NULL WHERE document_id=?1",
                        params![doc.id,identity]).map_err(io)?;
                    tx.execute("INSERT OR IGNORE INTO file_owner_aliases(document_id,scope_key) VALUES(?1,?2)",params![doc.id,source_object.scope.key()]).map_err(io)?;
                    tx.execute("UPDATE source_access_policies SET object_key=?2 WHERE object_key=?1",params![source_key,target_key]).map_err(io)?;
                    tx.execute("DELETE FROM source_index_snapshots WHERE object_key=?1",[&source_key]).map_err(io)?;
                    for (key,scope) in [(&source_key,&source_object.scope),(&target_key,&target_object.scope)] {
                        tx.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES(?1,?2,'file.owner.move',?3,?4)",
                            params![key,scope.key(),input.expected_hash,stamp]).map_err(io)?;
                    }
                    tx.execute("UPDATE projects SET updated_at=?1 WHERE id IN (?2,?3)",params![stamp,input.source_owner,input.target_owner]).map_err(io)?;
                    fail(3)?;
                    Ok((result,None))
                },
            )
        })();
        if let Err(e) = self.conn.pragma_update(None, "synchronous", synchronous) {
            return Err(io(e));
        }
        let result = outcome?;
        fail(4)?;
        // A committed result remains successful if duplicate-source cleanup needs retry.
        if let Err(e) = self.move_recover_locked(&token, &journal) {
            eprintln!("File move committed; recovery retained: {e}");
        }
        Ok(result)
    }
    fn move_recover_locked(&self, id: &str, j: &Journal) -> anyhow::Result<()> {
        use anyhow::{anyhow, bail};
        if j.schema_version != 1
            || !files::valid_hash(&j.payload.input.expected_hash)
            || j.payload.input.document_id <= 0
            || j.payload.input.source_owner == j.payload.input.target_owner
            || self.native_workspace_id.as_deref() != Some(&j.payload.binding.workspace_id)
        {
            bail!("Move journal belongs to another Workspace");
        }
        let source = files::owned(&self.workspace_root, &j.source)?;
        let target = files::owned(&self.workspace_root, &j.target)?;
        let staging = files::owned(&self.workspace_root, &j.staging)?;
        let retired = files::owned(&self.workspace_root, &j.retired)?;
        if source == target
            || staging.parent() != target.parent()
            || retired.parent() != source.parent()
            || staging.file_name().and_then(|v| v.to_str())
                != Some(format!(".pm-owner-move-{id}").as_str())
            || retired.file_name().and_then(|v| v.to_str())
                != Some(format!(".pm-owner-retire-{id}").as_str())
        {
            bail!("Invalid File move journal paths");
        }
        let committed: Option<FileOwnerMoveResult> = self
            .agent_operation_replay("gui", &j.request_id, "file.owner.move", &j.payload)
            .map_err(|e| anyhow!(e.message))?;
        let check = |p: &Path, identity: &files::FileIdentity| -> anyhow::Result<()> {
            if files::path_identity(p)? != *identity
                || files::checksum(p)? != j.payload.input.expected_hash
            {
                bail!("Move path changed; journal retained");
            }
            Ok(())
        };
        if committed.is_some() {
            check(&target, &j.target_identity)?;
            if source.symlink_metadata().is_ok() {
                check(&source, &j.source_identity)?;
                files::move_exclusive(&source, &retired)?;
                files::sync_directory(source.parent().unwrap())?;
            }
            if retired.symlink_metadata().is_ok() {
                if let Err(error) = check(&retired, &j.source_identity) {
                    let _ = files::move_exclusive(&retired, &source);
                    return Err(error);
                }
                fs::remove_file(&retired)?;
                files::sync_directory(retired.parent().unwrap())?;
            }
        } else if target.symlink_metadata().is_ok() {
            check(&target, &j.target_identity)?;
            fs::remove_file(&target)?;
            files::sync_directory(target.parent().unwrap())?;
        }
        if staging.symlink_metadata().is_ok() {
            check(&staging, &j.target_identity)?;
            fs::remove_file(&staging)?;
            files::sync_directory(staging.parent().unwrap())?;
        }
        self.conn
            .execute("DELETE FROM file_owner_move_journals WHERE id=?1", [id])?;
        Ok(())
    }
    pub(crate) fn file_owner_move_recover_pending(&self) -> anyhow::Result<()> {
        let entries = self
            .conn
            .prepare("SELECT id,payload FROM file_owner_move_journals")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, json) in entries {
            let j: Journal = serde_json::from_str(&json)?;
            let mut owners = vec![j.payload.input.source_owner, j.payload.input.target_owner];
            owners.sort();
            owners.dedup();
            let _owners = owners
                .into_iter()
                .map(|id| self.file_project_lock(id, true))
                .collect::<anyhow::Result<Vec<_>>>()?;
            let _file = self.file_version_lock(j.payload.input.document_id)?;
            if !self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM file_owner_move_journals WHERE id=?1)",
                [&id],
                |r| r.get::<_, bool>(0),
            )? {
                continue;
            }
            let _permit = self
                .file_commit_permit()
                .map_err(|e| anyhow::anyhow!(e.message))?;
            self.move_recover_locked(&id, &j)?;
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::access::{Caller, ScopeGrant},
        models::{DocumentImportInput, ProjectCreateInput},
    };
    use std::fs;
    #[test]
    fn three_directions_preserve_identity_and_history() {
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let (meta, paths) = crate::workspace::create_workspace(root.path(), "password").unwrap();
        let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
        let mut owners = vec![None];
        for name in ["A", "B"] {
            owners.push(Some(
                db.project_create(ProjectCreateInput {
                    name: name.into(),
                    summary: None,
                    status: None,
                })
                .unwrap()
                .id,
            ));
        }
        let source = external.path().join("test.md");
        fs::write(&source, b"original").unwrap();
        let file = db
            .document_import(DocumentImportInput {
                project_id: None,
                source_path: source.to_string_lossy().into(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        let binding = WorkspaceBinding {
            workspace_id: meta.workspace_id,
            generation: "fixture".into(),
        };
        let mut request = RequestContext {
            binding: binding.clone(),
            request_id: "move".into(),
            caller: Caller::Gui,
            scope_grant: ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: true,
                project_ids: owners.iter().flatten().copied().collect(),
                operations: vec!["file.move".into()],
                object_keys: None,
            },
        };
        for (index, (from, to)) in [(None, owners[1]), (owners[1], owners[2]), (owners[2], None)]
            .into_iter()
            .enumerate()
        {
            request.request_id = format!("move-{index}");
            let input = FileOwnerMove {
                document_id: file.id,
                source_owner: from,
                target_owner: to,
                expected_version: 1,
                expected_working_revision: None,
                expected_hash: super::super::file_versions::checksum(&source).unwrap(),
            };
            assert_eq!(
                db.file_owner_move(&request, &binding, &input)
                    .unwrap()
                    .document_id,
                file.id
            );
            let moved = db.document_record(file.id).unwrap();
            assert_eq!(moved.project_id, to);
            assert_eq!(fs::read(moved.managed_path).unwrap(), b"original");
            assert_eq!(moved.history_dir_path, file.history_dir_path);
        }
    }
}
#[cfg(test)]
#[path = "file_owner_move_tests.rs"]
mod integration_tests;
