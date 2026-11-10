//! Native source intents: persistence succeeds before independent, verified Trash.
use super::{
    file_owner_move::io,
    file_versions::{self as files, CommittedVersion, GuiFileVersionIntent},
    Database,
};
use crate::agent::{
    access::RequestContext,
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, WorkspaceBinding},
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::{
    fs,
    path::{Path, PathBuf},
};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum DropTarget {
    New {
        owner: Option<i64>,
        name: String,
    },
    Update {
        document_id: i64,
        project_id: Option<i64>,
        managed_path: String,
        expected_version_number: u32,
    },
}
impl DropTarget {
    fn owner(&self) -> Option<i64> {
        match self {
            Self::New { owner, .. } => *owner,
            Self::Update { project_id, .. } => *project_id,
        }
    }
    fn operation(&self) -> &str {
        match self {
            Self::New { .. } => "content.create",
            _ => "file.update",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DropResult {
    pub document_id: i64,
    pub version_number: i64,
    pub content_hash: String,
    pub no_change: bool,
    pub cleanup_warning: Option<String>,
    pub old_sessions_closed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DropPrepared {
    pub intent_id: String,
}
#[derive(Serialize, Deserialize)]
struct PreparePayload {
    binding: WorkspaceBinding,
    source: String,
    target: DropTarget,
}
#[derive(Serialize, Deserialize)]
struct Intent {
    prepare: PreparePayload,
    request_id: String,
    source_identity: files::FileIdentity,
    hash: String,
    staged: String,
    update: Option<GuiFileVersionIntent>,
    quarantine: String,
}
pub(crate) trait SourceTrash {
    fn trash(&self, path: &Path) -> anyhow::Result<()>;
}
pub(crate) struct SystemTrash;
impl SourceTrash for SystemTrash {
    fn trash(&self, path: &Path) -> anyhow::Result<()> {
        trash::delete(path)?;
        Ok(())
    }
}
fn error(code: ErrorCode, message: &str) -> AgentError {
    AgentError::new(code, message)
}
fn equivalent_extension(source: &Path, target: &Path) -> bool {
    fn ext(p: &Path) -> String {
        let s = p
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        match s.as_str() {
            "markdown" => "md".into(),
            "jpeg" => "jpg".into(),
            "tiff" => "tif".into(),
            _ => s,
        }
    }
    let source = ext(source);
    !source.is_empty() && source == ext(target)
}
impl Database {
    /// Trusted wrapper reads this before minting its one-owner GUI grant.
    /// The intent is a locator, not authority; commit repeats binding/request/grant.
    pub(crate) fn file_drop_target(
        &self,
        binding: &WorkspaceBinding,
        request_id: &str,
        intent_id: &str,
    ) -> AgentResult<DropTarget> {
        if self.native_workspace_id.as_deref() != Some(binding.workspace_id.as_str()) {
            return Err(error(ErrorCode::WorkspaceChanged, "Drop Workspace changed"));
        }
        let stored: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT request_id,payload FROM file_drop_intents WHERE id=?1",
                [intent_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(io)?;
        let (request, json) =
            stored.ok_or_else(|| error(ErrorCode::NotFound, "Drop intent does not exist"))?;
        let intent: Intent = serde_json::from_str(&json).map_err(io)?;
        if intent.prepare.binding != *binding {
            return Err(error(ErrorCode::WorkspaceChanged, "Drop binding expired"));
        }
        if request != request_id || intent.request_id != request_id {
            return Err(error(
                ErrorCode::IdempotencyConflict,
                "Drop belongs to another request",
            ));
        }
        Ok(intent.prepare.target)
    }

    pub(crate) fn file_drop_owner(
        &self,
        binding: &WorkspaceBinding,
        request_id: &str,
        intent_id: &str,
    ) -> AgentResult<Option<i64>> {
        Ok(self
            .file_drop_target(binding, request_id, intent_id)?
            .owner())
    }
    fn drop_authorize(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        target: &DropTarget,
    ) -> AgentResult<()> {
        self.file_flow_gui(request, binding)?;
        request.authorize(
            binding,
            &super::file_scope::scope(target.owner()),
            target.operation(),
        )?;
        match target {
            DropTarget::New { .. } => request.require_scope_context()?,
            DropTarget::Update {
                document_id,
                project_id,
                ..
            } => {
                let object = ObjectRef {
                    workspace_id: binding.workspace_id.clone(),
                    scope: super::file_scope::scope(*project_id),
                    kind: ObjectKind::File,
                    id: document_id.to_string(),
                };
                let actual = self
                    .agent_resolve_object(&object, &binding.workspace_id)?
                    .ok_or_else(|| error(ErrorCode::NotFound, "Drop target no longer exists"))?;
                request.authorize_object(binding, &object, &actual, "file.update")?;
            }
        }
        Ok(())
    }
    pub(crate) fn file_drop_prepare(
        &mut self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        source: &Path,
        target: DropTarget,
    ) -> AgentResult<DropPrepared> {
        self.drop_authorize(request, binding, &target)?;
        if !source.is_absolute() {
            return Err(error(
                ErrorCode::InvalidArgument,
                "Drop source must be absolute",
            ));
        }
        // Preserve lexical source in replay payload. A consumed source need not exist.
        let source_string = source
            .to_str()
            .ok_or_else(|| error(ErrorCode::InvalidArgument, "Invalid source encoding"))?
            .to_owned();
        let payload = PreparePayload {
            binding: binding.clone(),
            source: source_string,
            target,
        };
        if let Some(previous) =
            self.agent_operation_replay("gui", &request.request_id, "file.drop.prepare", &payload)?
        {
            let _permit = self.file_commit_permit()?;
            return Ok(previous);
        }
        let prepare_key = format!("{:x}", Sha256::digest(request.request_id.as_bytes()));
        let _prepare_lock = self
            .file_storage_lock(&format!("file-drop-prepare/{prepare_key}"), 1, true)
            .map_err(io)?;
        // Another process may have finished while this caller waited for the request lease.
        if let Some(previous) =
            self.agent_operation_replay("gui", &request.request_id, "file.drop.prepare", &payload)?
        {
            return Ok(previous);
        }
        let pending: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT id,payload FROM file_drop_intents WHERE request_id=?1",
                [&request.request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(io)?;
        let (id, mut stored) = if let Some((id, json)) = pending {
            let value: serde_json::Value = serde_json::from_str(&json).map_err(io)?;
            if value["prepare"] != serde_json::to_value(&payload).map_err(io)? {
                return Err(error(
                    ErrorCode::IdempotencyConflict,
                    "Drop request payload changed",
                ));
            }
            (id, value)
        } else {
            files::regular(source).map_err(io)?;
            if fs::metadata(source).map_err(io)?.len() > crate::file_content::MAX_CONTENT {
                return Err(error(
                    ErrorCode::BudgetExceeded,
                    "Drop source exceeds the 100 MiB import limit",
                ));
            }
            let canonical = source.canonicalize().map_err(io)?;
            if let DropTarget::Update { managed_path, .. } = &payload.target {
                if !equivalent_extension(&canonical, Path::new(managed_path)) {
                    return Err(error(
                        ErrorCode::InvalidArgument,
                        "Drop format is incompatible with target File",
                    ));
                }
            }
            let base = self.workspace_root.join(".project-mind/file-drop-stage");
            files::create_owned_directories(&self.workspace_root, &base).map_err(io)?;
            let id = files::token();
            let staging = base.join(&id);
            fs::create_dir(&staging).map_err(io)?;
            let staged = staging.join("source.bin");
            let captured = (|| -> AgentResult<serde_json::Value> {
                let (hash, source_identity, _) = files::snapshot_bounded(
                    &canonical,
                    &staged,
                    Some(crate::file_content::MAX_CONTENT),
                )
                .map_err(io)?;
                files::sync_directory(&staging).map_err(io)?;
                files::sync_directory(&base).map_err(io)?;
                let baseline = if let DropTarget::Update {
                    document_id,
                    project_id,
                    managed_path,
                    expected_version_number,
                } = &payload.target
                {
                    self.file_version_recover_pending().map_err(io)?;
                    let _owner = self.file_project_lock(*project_id, false).map_err(io)?;
                    let _file = self.file_version_lock(*document_id).map_err(io)?;
                    let _permit = self.file_commit_permit()?;
                    self.drop_authorize(request, binding, &payload.target)?;
                    self.file_version_gui_metadata(&files::GuiFileVersionPrepare {
                        document_id: *document_id,
                        project_id: *project_id,
                        managed_path: managed_path.clone(),
                        expected_version_number: *expected_version_number,
                        source_path: None,
                    })?;
                    Some(self.move_baseline_locked(*document_id)?)
                } else {
                    None
                };
                let intent = Intent {
                    prepare: payload,
                    request_id: request.request_id.clone(),
                    source_identity,
                    hash,
                    staged: files::relative(&self.workspace_root, &staged).map_err(io)?,
                    update: None,
                    quarantine: canonical
                        .parent()
                        .ok_or_else(|| error(ErrorCode::InvalidArgument, "Source has no parent"))?
                        .join(format!(".pm-drop-{id}"))
                        .to_string_lossy()
                        .into(),
                };
                let mut value = serde_json::to_value(&intent).map_err(io)?;
                value["canonical_source"] = serde_json::json!(canonical);
                value["archive_baseline"] = serde_json::to_value(baseline).map_err(io)?;
                let _permit = self.file_commit_permit()?;
                self.drop_write_intent(&id, &request.request_id, &value)?;
                Ok(value)
            })();
            match captured {
                Ok(value) => (id, value),
                Err(error) => {
                    // Only remove an unclaimed snapshot; a persisted intent owns its evidence.
                    let exists: bool = self
                        .conn
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM file_drop_intents WHERE id=?1)",
                            [&id],
                            |r| r.get(0),
                        )
                        .map_err(io)?;
                    if !exists {
                        fs::remove_dir_all(&staging).map_err(io)?;
                    }
                    return Err(error);
                }
            }
        };
        let mut intent: Intent = serde_json::from_value(stored.clone()).map_err(io)?;
        self.drop_authorize(request, binding, &intent.prepare.target)?;
        if let DropTarget::Update {
            document_id,
            project_id,
            managed_path,
            ..
        } = &intent.prepare.target
        {
            if stored.get("post_archive").is_none() {
                let baseline =
                    serde_json::from_value(stored["archive_baseline"].clone()).map_err(io)?;
                let object = ObjectRef {
                    workspace_id: binding.workspace_id.clone(),
                    scope: super::file_scope::scope(*project_id),
                    kind: ObjectKind::File,
                    id: document_id.to_string(),
                };
                self.file_working_drop_archive(request, binding, &object, &id, &baseline)?;
                let json: String = self
                    .conn
                    .query_row(
                        "SELECT payload FROM file_drop_intents WHERE id=?1",
                        [&id],
                        |r| r.get(0),
                    )
                    .map_err(io)?;
                stored = serde_json::from_str(&json).map_err(io)?;
            }
            let baseline: super::file_owner_move::FileMoveBaseline =
                serde_json::from_value(stored["post_archive"].clone()).map_err(io)?;
            let _owner = self.file_project_lock(*project_id, false).map_err(io)?;
            let _file = self.file_version_lock(*document_id).map_err(io)?;
            let _permit = self.file_commit_permit()?;
            self.drop_authorize(request, binding, &intent.prepare.target)?;
            let actual = self.move_baseline_locked(*document_id)?;
            if actual != baseline {
                return Err(error(
                    ErrorCode::RevisionConflict,
                    "File changed after Drop archive",
                ));
            }
            let input = files::GuiFileVersionPrepare {
                document_id: *document_id,
                project_id: *project_id,
                managed_path: managed_path.clone(),
                expected_version_number: baseline.expected_version.try_into().map_err(io)?,
                source_path: Some(
                    files::owned(&self.workspace_root, &intent.staged)
                        .map_err(io)?
                        .to_string_lossy()
                        .into(),
                ),
            };
            let metadata = self.file_version_gui_metadata(&input)?;
            intent.update = Some(GuiFileVersionIntent {
                document_id: *document_id,
                project_id: *project_id,
                managed_path: managed_path.clone(),
                expected_version_number: input.expected_version_number,
                expected_content_hash: baseline.expected_hash,
                registered_content_hash: metadata.registered_content_hash,
                new_content_hash: intent.hash.clone(),
                source_path: input.source_path,
            });
            stored["update"] = serde_json::to_value(&intent.update).map_err(io)?;
        }
        let _permit = self.file_commit_permit()?;
        let synchronous: i64 = self
            .conn
            .pragma_query_value(None, "synchronous", |r| r.get(0))
            .map_err(io)?;
        self.conn
            .pragma_update(None, "synchronous", synchronous.max(2))
            .map_err(io)?;
        let prepared = DropPrepared {
            intent_id: id.clone(),
        };
        let result = self.agent_atomic_operation(
            "gui",
            &request.request_id,
            "file.drop.prepare",
            &intent.prepare,
            |tx| {
                tx.execute(
                    "UPDATE file_drop_intents SET payload=?2 WHERE id=?1",
                    params![id, serde_json::to_string(&stored).map_err(io)?],
                )
                .map_err(io)?;
                Ok((prepared, None))
            },
        );
        self.conn
            .pragma_update(None, "synchronous", synchronous)
            .map_err(io)?;
        result
    }
    fn drop_write_intent(
        &self,
        id: &str,
        request_id: &str,
        value: &serde_json::Value,
    ) -> AgentResult<()> {
        let synchronous: i64 = self
            .conn
            .pragma_query_value(None, "synchronous", |r| r.get(0))
            .map_err(io)?;
        self.conn
            .pragma_update(None, "synchronous", synchronous.max(2))
            .map_err(io)?;
        let result = self
            .conn
            .execute(
                "INSERT INTO file_drop_intents(id,request_id,payload) VALUES(?1,?2,?3)",
                params![id, request_id, serde_json::to_string(value).map_err(io)?],
            )
            .map_err(io);
        self.conn
            .pragma_update(None, "synchronous", synchronous)
            .map_err(io)?;
        result.map(|_| ())
    }
    /// No editor seal: observe only an existing immutable native destination receipt.
    /// Source cleanup is never resumed through this entry point.
    pub(crate) fn file_drop_committed(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        intent_id: &str,
    ) -> AgentResult<Option<DropResult>> {
        self.file_flow_gui(request, binding)?;
        let target = self.file_drop_target(binding, &request.request_id, intent_id)?;
        let (json, previous, cleanup, warning): (String, Option<String>, String, Option<String>) =
            self.conn
                .query_row(
                    "SELECT payload,result,cleanup,warning FROM file_drop_intents WHERE id=?1",
                    [intent_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .map_err(io)?;
        let intent: Intent = serde_json::from_str(&json).map_err(io)?;
        let native_request = format!("drop-{intent_id}");
        let receipt = match &target {
            DropTarget::New { owner, name } => {
                let result:Option<super::file_imports::AgentFileCreateResult>=self.agent_operation_replay("gui",&native_request,"file.create",&serde_json::json!({"dropIntent":intent_id,"contentHash":intent.hash,"owner":owner,"name":name}))?;
                result
                    .map(|r| -> AgentResult<_> {
                        Ok(CommittedVersion {
                            document_id: r.object.id.parse().map_err(io)?,
                            version_number: i64::from(r.version_number),
                            content_hash: r.content_hash,
                            no_change: false,
                        })
                    })
                    .transpose()?
            }
            DropTarget::Update { .. } => {
                if let Some(update) = &intent.update {
                    self.file_version_drop_replay(&native_request, update)?
                } else {
                    None
                }
            }
        };
        let Some(receipt) = receipt else {
            self.drop_authorize(request, binding, &target)?;
            return Ok(None);
        };
        let owner = self
            .document_record(receipt.document_id)
            .map_err(io)?
            .project_id;
        let _owner = self.file_project_lock(owner, false).map_err(io)?;
        let _file = self
            .file_storage_lock("file-version-locks", receipt.document_id, false)
            .map_err(io)?;
        let _permit = self.file_commit_permit()?;
        let current = self.document_record(receipt.document_id).map_err(io)?;
        if current.project_id != owner {
            return Err(error(
                ErrorCode::RevisionConflict,
                "Drop destination moved during replay",
            ));
        }
        let object = ObjectRef {
            workspace_id: binding.workspace_id.clone(),
            scope: super::file_scope::scope(owner),
            kind: ObjectKind::File,
            id: receipt.document_id.to_string(),
        };
        let actual = self
            .agent_resolve_object(&object, &binding.workspace_id)?
            .ok_or_else(|| error(ErrorCode::NotFound, "Drop destination missing"))?;
        request.authorize_object(binding, &object, &actual, target.operation())?;
        let mut result = DropResult {
            document_id: receipt.document_id,
            version_number: receipt.version_number,
            content_hash: receipt.content_hash,
            no_change: receipt.no_change,
            cleanup_warning: None,
            old_sessions_closed: matches!(target, DropTarget::Update { .. }) && !receipt.no_change,
        };
        if let Some(previous) = previous {
            let stored: DropResult = serde_json::from_str(&previous).map_err(io)?;
            if stored.document_id != result.document_id
                || stored.version_number != result.version_number
                || stored.content_hash != result.content_hash
                || stored.no_change != result.no_change
            {
                return Err(io("Drop result does not match native destination receipt"));
            }
        }
        result.cleanup_warning = warning.or_else(|| {
            (cleanup != "done").then(|| {
                "Source cleanup is pending or interrupted; replay did not recycle source".into()
            })
        });
        Ok(Some(result))
    }
    pub(crate) fn file_drop_commit(
        &mut self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        intent_id: &str,
        trash: &impl SourceTrash,
    ) -> AgentResult<DropResult> {
        self.file_flow_gui(request, binding)?;
        if intent_id.len() != 32 || !intent_id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(error(ErrorCode::InvalidArgument, "Invalid drop intent"));
        }
        // Serialize this intent only; destination services acquire their own owner/File
        // leases and recover before fence admission. No global fence is held here.
        let _intent_lock = self
            .file_storage_lock(&format!("file-drop-locks/{intent_id}"), 1, true)
            .map_err(io)?;
        let row: Option<(String, Option<String>, String, Option<String>)> = self
            .conn
            .query_row(
                "SELECT payload,result,cleanup,warning FROM file_drop_intents WHERE id=?1",
                [intent_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(io)?;
        let (json, previous, cleanup, warning) =
            row.ok_or_else(|| error(ErrorCode::NotFound, "Drop intent does not exist"))?;
        let value: serde_json::Value = serde_json::from_str(&json).map_err(io)?;
        let intent: Intent = serde_json::from_value(value.clone()).map_err(io)?;
        let source = PathBuf::from(
            value["canonical_source"]
                .as_str()
                .ok_or_else(|| io("Missing canonical source"))?,
        );
        if &intent.prepare.binding != binding {
            return Err(error(
                ErrorCode::WorkspaceChanged,
                "Drop intent Workspace binding expired",
            ));
        }
        if intent.request_id != request.request_id {
            return Err(error(
                ErrorCode::IdempotencyConflict,
                "Drop belongs to another request",
            ));
        }
        self.drop_authorize(request, binding, &intent.prepare.target)?;
        let mut result: DropResult = if let Some(previous) = previous {
            serde_json::from_str(&previous).map_err(io)?
        } else {
            let staged = files::owned(&self.workspace_root, &intent.staged).map_err(io)?;
            if files::checksum(&staged).map_err(io)? != intent.hash {
                return Err(error(
                    ErrorCode::SourceChanged,
                    "Captured drop source changed",
                ));
            }
            let fence = self.file_commit_fence.clone().ok_or_else(|| {
                error(
                    ErrorCode::WorkspaceChanged,
                    "Drop requires the current Host commit fence",
                )
            })?;
            let mut commit_request = request.clone();
            commit_request.request_id = format!("drop-{intent_id}");
            let receipt = match &intent.prepare.target {
                DropTarget::New { owner, name } => {
                    let file = crate::source_file_snapshot::open_regular(&staged)?;
                    let identity = files::identity(&file).map_err(io)?;
                    let mut bytes = Vec::new();
                    file.take(crate::file_content::MAX_CONTENT + 1)
                        .read_to_end(&mut bytes)
                        .map_err(io)?;
                    if bytes.len() as u64 > crate::file_content::MAX_CONTENT
                        || format!("sha256:{:x}", Sha256::digest(&bytes)) != intent.hash
                        || files::path_identity(&staged).map_err(io)? != identity
                    {
                        return Err(error(
                            ErrorCode::SourceChanged,
                            "Captured drop bytes changed during import read",
                        ));
                    }
                    let created=self.file_drop_import_bound(&commit_request,binding,*owner,name,&bytes,&serde_json::json!({"dropIntent":intent_id,"contentHash":intent.hash,"owner":owner,"name":name}),&fence)?;
                    CommittedVersion {
                        document_id: created.object.id.parse().map_err(io)?,
                        version_number: i64::from(created.version_number),
                        content_hash: created.content_hash,
                        no_change: false,
                    }
                }
                DropTarget::Update { .. } => {
                    self.project_file_drop_bound(
                        &commit_request,
                        binding,
                        intent
                            .update
                            .as_ref()
                            .ok_or_else(|| io("Missing prepared update"))?,
                        &fence,
                    )?
                    .receipt
                }
            };
            let result = DropResult {
                document_id: receipt.document_id,
                version_number: receipt.version_number,
                content_hash: receipt.content_hash,
                no_change: receipt.no_change,
                cleanup_warning: None,
                old_sessions_closed: matches!(intent.prepare.target, DropTarget::Update { .. })
                    && !receipt.no_change,
            };
            let _permit = self.file_commit_permit()?;
            let synchronous: i64 = self
                .conn
                .pragma_query_value(None, "synchronous", |r| r.get(0))
                .map_err(io)?;
            self.conn
                .pragma_update(None, "synchronous", synchronous.max(2))
                .map_err(io)?;
            let saved = self
                .conn
                .execute(
                    "UPDATE file_drop_intents SET result=?2 WHERE id=?1",
                    params![intent_id, serde_json::to_string(&result).map_err(io)?],
                )
                .map_err(io);
            let restored = self
                .conn
                .pragma_update(None, "synchronous", synchronous)
                .map_err(io);
            saved?;
            restored?;
            result
        };
        if cleanup != "pending" {
            result.cleanup_warning=warning.or_else(||if cleanup=="attempted"{Some("Source cleanup was interrupted; inspect retained source/quarantine before retrying".into())}else{None});
            let _permit = self.file_commit_permit()?;
            return Ok(result);
        }
        let cleanup_outcome = self.drop_cleanup(
            request, binding, intent_id, &intent, &source, &result, trash,
        );
        if let Err(e) = cleanup_outcome {
            result.cleanup_warning = Some(e);
        }
        // Captured bytes are no longer required after the destination receipt
        // and result are durable. Replay consumes result, never reimports staging.
        let stage_cleanup = (|| -> AgentResult<()> {
            let staged = files::owned(&self.workspace_root, &intent.staged).map_err(io)?;
            if staged.exists() {
                if files::checksum(&staged).map_err(io)? != intent.hash {
                    return Err(error(
                        ErrorCode::SourceChanged,
                        "Drop staging changed; retained",
                    ));
                }
                fs::remove_file(&staged).map_err(io)?;
            }
            if let Some(parent) = staged.parent() {
                if parent.exists() {
                    fs::remove_dir(parent).map_err(io)?;
                }
            }
            Ok(())
        })();
        if let Err(error) = stage_cleanup {
            let warning = result.cleanup_warning.get_or_insert_with(String::new);
            if !warning.is_empty() {
                warning.push_str("; ");
            }
            warning.push_str(&error.message);
        }
        // Target success is retained even if saving the cleanup warning itself fails.
        let state = if result.cleanup_warning.is_some() {
            "warning"
        } else {
            "done"
        };
        if let Err(e) = self.conn.execute(
            "UPDATE file_drop_intents SET cleanup=?2,warning=?3 WHERE id=?1",
            params![intent_id, state, result.cleanup_warning],
        ) {
            result.cleanup_warning =
                Some(format!("Source cleanup result could not be recorded: {e}"));
        }
        Ok(result)
    }
    fn drop_cleanup(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        id: &str,
        intent: &Intent,
        source: &Path,
        result: &DropResult,
        trash: &impl SourceTrash,
    ) -> Result<(), String> {
        let perform = (|| -> AgentResult<()> {
            self.file_version_recover_pending().map_err(io)?;
            let owner = self
                .document_record(result.document_id)
                .map_err(io)?
                .project_id;
            let _owner = self.file_project_lock(owner, false).map_err(io)?;
            let _file = self.file_version_lock(result.document_id).map_err(io)?;
            let _permit = self.file_commit_permit()?;
            self.drop_authorize(request, binding, &intent.prepare.target)?;
            let current = self.document_record(result.document_id).map_err(io)?;
            if current.project_id != intent.prepare.target.owner() {
                return Err(error(
                    ErrorCode::ScopeDenied,
                    "Drop target owner changed before cleanup",
                ));
            }
            let target = PathBuf::from(&current.managed_path);
            if files::checksum(&target).map_err(io)? != result.content_hash
                || result.content_hash != intent.hash
            {
                return Err(error(
                    ErrorCode::SourceChanged,
                    "Target no longer holds confirmed drop bytes",
                ));
            }
            files::regular(source).map_err(io)?;
            let canonical = source.canonicalize().map_err(io)?;
            let root = self.workspace_root.canonicalize().map_err(io)?;
            if canonical != source || canonical.starts_with(&root) {
                return Err(error(
                    ErrorCode::ScopeDenied,
                    "Workspace-managed source cannot be recycled",
                ));
            }
            if files::path_identity(source).map_err(io)? != intent.source_identity
                || files::checksum(source).map_err(io)? != intent.hash
            {
                return Err(error(
                    ErrorCode::SourceChanged,
                    "Source was replaced after prepare; retained",
                ));
            }
            let paths=self.conn.prepare("SELECT managed_path FROM documents UNION SELECT managed_path FROM document_versions").map_err(io)?.query_map([],|r|r.get::<_,String>(0)).map_err(io)?.collect::<rusqlite::Result<Vec<_>>>().map_err(io)?;
            for path in paths {
                let path = self.decode_path_ref(&path);
                if path.exists()
                    && files::path_identity(&path).map_err(io)? == intent.source_identity
                {
                    return Err(error(
                        ErrorCode::ScopeDenied,
                        "Source aliases managed File content",
                    ));
                }
            }
            let quarantine = Path::new(&intent.quarantine);
            // A durable attempted marker prevents a process crash from repeating Trash.
            let synchronous: i64 = self
                .conn
                .pragma_query_value(None, "synchronous", |r| r.get(0))
                .map_err(io)?;
            self.conn
                .pragma_update(None, "synchronous", synchronous.max(2))
                .map_err(io)?;
            let recorded=self.conn.execute("UPDATE file_drop_intents SET cleanup='attempted' WHERE id=?1 AND cleanup='pending'",[id]).map_err(io);
            let restored = self
                .conn
                .pragma_update(None, "synchronous", synchronous)
                .map_err(io);
            recorded?;
            restored?;
            files::move_exclusive(source, quarantine).map_err(io)?;
            files::sync_directory(source.parent().unwrap()).map_err(io)?;
            let verified = files::path_identity(quarantine).map_err(io)? == intent.source_identity
                && files::checksum(quarantine).map_err(io)? == intent.hash;
            if !verified {
                let _ = files::move_exclusive(quarantine, source);
                return Err(error(
                    ErrorCode::SourceChanged,
                    "Source changed at cleanup; quarantine retained if original path is occupied",
                ));
            }
            if let Err(e) = trash.trash(quarantine) {
                let restored = files::move_exclusive(quarantine, source).map_err(io);
                if let Err(restore) = restored {
                    return Err(io(format!(
                        "{e}; source retained at {}: {}",
                        quarantine.display(),
                        restore.message
                    )));
                }
                return Err(io(format!(
                    "Source Trash failed; original source retained: {e}"
                )));
            }
            files::sync_directory(source.parent().unwrap()).map_err(io)?;
            Ok(())
        })();
        perform.map_err(|e| e.message)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::access::{Caller, ScopeGrant};
    #[test]
    fn prepared_drop_commits_before_isolated_trash() {
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let (meta, paths) = crate::workspace::create_workspace(root.path(), "password").unwrap();
        let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
        let binding = WorkspaceBinding {
            workspace_id: meta.workspace_id,
            generation: "fixture".into(),
        };
        let request = RequestContext {
            binding: binding.clone(),
            request_id: "drop".into(),
            caller: Caller::Gui,
            scope_grant: ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: true,
                project_ids: vec![],
                operations: vec!["content.create".into(), "file.update".into()],
                object_keys: None,
            },
        };
        let source = external.path().join("drop.md");
        std::fs::write(&source, b"drop bytes").unwrap();
        struct FixtureTrash(std::path::PathBuf);
        impl SourceTrash for FixtureTrash {
            fn trash(&self, p: &Path) -> anyhow::Result<()> {
                std::fs::rename(p, &self.0)?;
                Ok(())
            }
        }
        db.bind_file_commit_fence(std::sync::Arc::new(
            crate::workspace_commit_fence::WorkspaceCommitFence::new(),
        ));
        let intent = db
            .file_drop_prepare(
                &request,
                &binding,
                &source,
                DropTarget::New {
                    owner: None,
                    name: "drop.md".into(),
                },
            )
            .unwrap();
        let result = db
            .file_drop_commit(
                &request,
                &binding,
                &intent.intent_id,
                &FixtureTrash(external.path().join("trash.md")),
            )
            .unwrap();
        assert!(result.cleanup_warning.is_none());
        assert!(!source.exists());
        assert_eq!(
            std::fs::read(db.document_record(result.document_id).unwrap().managed_path).unwrap(),
            b"drop bytes"
        );
    }
}
#[cfg(test)]
#[path = "file_drop_tests.rs"]
mod integration_tests;
