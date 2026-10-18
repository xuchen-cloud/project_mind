//! GUI and model Office adapters share fixed File reads and server-owned stages.
use crate::{
    agent::{
        access::{Caller, RequestContext, ScopeGrant},
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectRef, Scope, WorkspaceBinding},
    },
    db::project_directory_files::{FileBytesInput, FileBytesResult},
    file_content::{
        FileContentBegin, FileContentService, FileContentUpdate, SystemFileContentClock, MAX_CHUNK,
        MAX_CONTENT,
    },
    file_version_service::{BoundFileCommitStore, FileVersionCommitResult},
    office_worker::{OfficePayload, OfficeRecalculation, OfficeRecalculationResult, OfficeUtility},
    source_service::BoundSourceStore,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileOfficeInput {
    pub object: ObjectRef,
    pub version_number: u32,
    pub expected_content_hash: String,
}
impl FileOfficeInput {
    fn bytes_input(&self) -> FileBytesInput {
        FileBytesInput {
            object: self.object.clone(),
            version_number: self.version_number,
            expected_content_hash: self.expected_content_hash.clone(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileOfficeEditInput {
    pub object: ObjectRef,
    pub version_number: u32,
    pub expected_content_hash: String,
    pub edits: Vec<Value>,
}
impl FileOfficeEditInput {
    pub(crate) fn baseline(&self) -> FileOfficeInput {
        FileOfficeInput {
            object: self.object.clone(),
            version_number: self.version_number,
            expected_content_hash: self.expected_content_hash.clone(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileOfficeRecalculateInput {
    pub object: ObjectRef,
    pub version_number: u32,
    pub expected_content_hash: String,
    pub recalculation: OfficeRecalculation,
}
impl FileOfficeRecalculateInput {
    fn baseline(&self) -> FileOfficeInput {
        FileOfficeInput {
            object: self.object.clone(),
            version_number: self.version_number,
            expected_content_hash: self.expected_content_hash.clone(),
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileOfficeInspection {
    pub object: ObjectRef,
    pub version_number: u32,
    pub content_hash: String,
    pub format: String,
    pub model: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileOfficeCandidate {
    pub target: ObjectRef,
    pub expected_version: u32,
    pub expected_hash: String,
    pub staged_content_id: String,
    pub model: Value,
}
impl FileOfficeCandidate {
    pub(crate) fn update(&self) -> FileContentUpdate {
        FileContentUpdate {
            object: self.target.clone(),
            expected_version_number: self.expected_version,
            expected_content_hash: self.expected_hash.clone(),
            staged_content_id: self.staged_content_id.clone(),
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileOfficeSaved {
    pub object: ObjectRef,
    pub version_number: i64,
    pub content_hash: String,
    pub model: Value,
    pub commit: FileVersionCommitResult,
}

/// GUI grants are derived from actual ownership, never the claimed Project.
pub(crate) fn gui_request<S: BoundSourceStore>(
    store: &S,
    binding: &WorkspaceBinding,
    id: &str,
    object: &ObjectRef,
    save: bool,
) -> AgentResult<RequestContext> {
    store.with_current(|current, db| {
        crate::file_version_service::validate_binding(binding, current)?;
        if id.is_empty() || id.len() > 128 {
            return Err(error(
                ErrorCode::InvalidArgument,
                "Invalid Office request identity",
            ));
        }
        let actual = db
            .agent_resolve_object(object, &current.workspace_id)?
            .ok_or_else(|| error(ErrorCode::NotFound, "File is no longer present"))?;
        if &actual != object {
            return Err(error(
                ErrorCode::ScopeDenied,
                "File belongs to another owner",
            ));
        }
        let (workspace_content, project_ids) = match actual.scope {
            Scope::Workspace => (true, vec![]),
            Scope::Project { project_id } => (false, vec![project_id]),
        };
        let mut operations = vec!["source.read".into()];
        if save {
            operations.push("file.update".into());
        }
        Ok(RequestContext {
            binding: current.clone(),
            request_id: id.into(),
            caller: Caller::Gui,
            scope_grant: ScopeGrant {
                workspace_id: current.workspace_id.clone(),
                workspace_content,
                project_ids,
                operations,
                object_keys: None,
            },
        })
    })
}
fn error(code: ErrorCode, message: &str) -> AgentError {
    AgentError::new(code, message)
}
fn phase(request: &RequestContext, name: &str) -> RequestContext {
    let mut phase = request.clone();
    phase.request_id = format!(
        "office:{:x}:{name}",
        Sha256::digest(request.request_id.as_bytes())
    );
    phase
}
fn format(name: &str) -> AgentResult<String> {
    let format = std::path::Path::new(name)
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(format.as_str(), "docx" | "xlsx" | "pptx") {
        return Err(error(
            ErrorCode::InvalidArgument,
            "Office supports DOCX/XLSX/PPTX only",
        ));
    }
    Ok(format)
}
pub(crate) struct FileOfficeService<'a, S, W> {
    store: &'a S,
    worker: &'a W,
}
impl<'a, S: BoundSourceStore + BoundFileCommitStore, W: OfficeUtility> FileOfficeService<'a, S, W> {
    pub(crate) fn new(store: &'a S, worker: &'a W) -> Self {
        Self { store, worker }
    }
    pub(crate) async fn recalculate(
        &self,
        request: &RequestContext,
        input: &FileOfficeRecalculateInput,
    ) -> AgentResult<OfficeRecalculationResult> {
        input.recalculation.validate()?;
        let baseline = input.baseline();
        let bytes = self.read(request, &baseline)?;
        if format(&bytes.name)? != "xlsx" {
            return Err(error(
                ErrorCode::InvalidArgument,
                "Recalculation requires an XLSX File",
            ));
        }
        let result = self
            .worker
            .request(
                &request.request_id,
                "office.recalculate",
                "xlsx",
                &bytes.base64,
                OfficePayload::Recalculate(&input.recalculation),
            )
            .await?;
        // As for inspection, re-authorize and verify the exact retained baseline.
        self.read(request, &baseline)?;
        let result: OfficeRecalculationResult = serde_json::from_value(result).map_err(|_| {
            error(
                ErrorCode::RuntimeIncompatible,
                "Invalid Office recalculation result",
            )
        })?;
        if result.cells.len() > 100_000
            || result.cells.iter().any(|cell| {
                cell.sheet_id.is_empty()
                    || cell.row > 1_048_575
                    || cell.column > 16_383
                    || cell.number.is_some_and(|n| !n.is_finite())
            })
        {
            return Err(error(
                ErrorCode::RuntimeIncompatible,
                "Invalid Office recalculation cells",
            ));
        }
        Ok(result)
    }
    fn read(
        &self,
        request: &RequestContext,
        input: &FileOfficeInput,
    ) -> AgentResult<FileBytesResult> {
        self.store.with_current(|binding, db| {
            db.project_file_read_office_source(request, binding, &input.bytes_input())
                .map(|x| x.0)
        })
    }
    fn latest(&self, request: &RequestContext, input: &FileOfficeInput) -> AgentResult<()> {
        self.store.with_current(|binding, db| {
            let target = db.file_version_registered_target(request, binding, &input.object)?;
            if target.current_version_number != i64::from(input.version_number) {
                return Err(error(
                    ErrorCode::RevisionConflict,
                    "Historical Office versions are read-only; select the latest File baseline",
                ));
            }
            let metadata =
                db.file_version_gui_metadata(&crate::db::file_versions::GuiFileVersionPrepare {
                    document_id: target.id,
                    project_id: target.project_id,
                    managed_path: target.managed_path.clone(),
                    expected_version_number: input.version_number,
                    source_path: None,
                })?;
            if metadata.registered_content_hash.as_deref()
                != Some(input.expected_content_hash.as_str())
            {
                return Err(error(
                    ErrorCode::RevisionConflict,
                    "Office File baseline hash changed",
                ));
            }
            use crate::file_version_service::FilesystemFileReader;
            if FilesystemFileReader
                .capture_original(std::path::Path::new(&target.managed_path))?
                .content_hash()
                != input.expected_content_hash
            {
                return Err(error(
                    ErrorCode::FileChangedUnregistered,
                    "Office File changed on disk",
                ));
            }
            Ok(())
        })
    }
    pub(crate) async fn inspect(
        &self,
        request: &RequestContext,
        input: &FileOfficeInput,
    ) -> AgentResult<FileOfficeInspection> {
        let bytes = self.read(request, input)?;
        let format = format(&bytes.name)?;
        let result = self
            .worker
            .request(
                &request.request_id,
                "office.inspect",
                &format,
                &bytes.base64,
                OfficePayload::Inspect,
            )
            .await?;
        // Async work releases storage: recheck binding, owner, policy and bytes.
        self.read(request, input)?;
        Ok(FileOfficeInspection {
            object: bytes.object,
            version_number: bytes.version_number,
            content_hash: bytes.content_hash,
            format,
            model: result
                .get("model")
                .cloned()
                .ok_or_else(|| error(ErrorCode::RuntimeIncompatible, "Office model is missing"))?,
        })
    }
    async fn prepare_edit(
        &self,
        request: &RequestContext,
        input: &FileOfficeEditInput,
    ) -> AgentResult<FileOfficeCandidate> {
        let candidate_request = phase(request, "candidate");
        let previous = self.store.with_current(|binding, db| {
            db.source_read_historical_file(request, binding, &input.object)?;
            db.file_version_registered_target(request, binding, &input.object)?;
            db.agent_operation_replay::<FileOfficeCandidate>(
                &request.caller.key(),
                &candidate_request.request_id,
                "file.office.candidate",
                input,
            )
        })?;
        if let Some(previous) = previous {
            return Ok(previous);
        }
        let baseline = input.baseline();
        self.latest(request, &baseline)?;
        let original = self.read(request, &baseline)?;
        let format = format(&original.name)?;
        let result = self
            .worker
            .request(
                &request.request_id,
                "office.edit",
                &format,
                &original.base64,
                OfficePayload::Edit(&input.edits),
            )
            .await?;
        self.latest(request, &baseline)?;
        self.read(request, &baseline)?;
        let encoded = result
            .get("base64")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                error(
                    ErrorCode::RuntimeIncompatible,
                    "Office replacement bytes are missing",
                )
            })?;
        if encoded.len() > (MAX_CONTENT as usize).div_ceil(3) * 4 {
            return Err(error(
                ErrorCode::BudgetExceeded,
                "Office replacement exceeds 100 MiB",
            ));
        }
        let bytes = STANDARD.decode(encoded).map_err(|_| {
            error(
                ErrorCode::RuntimeIncompatible,
                "Office replacement base64 is invalid",
            )
        })?;
        if bytes.len() as u64 > MAX_CONTENT {
            return Err(error(
                ErrorCode::BudgetExceeded,
                "Office replacement exceeds 100 MiB",
            ));
        }
        let model = result.get("model").cloned().ok_or_else(|| {
            error(
                ErrorCode::RuntimeIncompatible,
                "Office replacement model is missing",
            )
        })?;
        let content = FileContentService::new(self.store, &SystemFileContentClock);
        let ticket = content.begin(
            &phase(request, "begin"),
            &FileContentBegin {
                object: input.object.clone(),
                expected_version_number: input.version_number,
                expected_content_hash: input.expected_content_hash.clone(),
                length: bytes.len() as u64,
                content_hash: format!("sha256:{:x}", Sha256::digest(&bytes)),
            },
        )?;
        for (index, chunk) in bytes.chunks(MAX_CHUNK).enumerate() {
            content.append(
                &phase(request, &format!("chunk{index}")),
                &ticket.staged_content_id,
                (index * MAX_CHUNK) as u64,
                chunk,
            )?;
        }
        content.finish(&phase(request, "finish"), &ticket.staged_content_id)?;
        let candidate = FileOfficeCandidate {
            target: input.object.clone(),
            expected_version: input.version_number,
            expected_hash: input.expected_content_hash.clone(),
            staged_content_id: ticket.staged_content_id,
            model,
        };
        self.store.with_current(|binding, db| {
            db.source_read_historical_file(request, binding, &input.object)?;
            db.file_version_registered_target(request, binding, &input.object)?;
            db.agent_atomic_operation(
                &request.caller.key(),
                &candidate_request.request_id,
                "file.office.candidate",
                input,
                |_| Ok((candidate, None)),
            )
        })
    }
    pub(crate) async fn save(
        &self,
        request: &RequestContext,
        input: &FileOfficeEditInput,
    ) -> AgentResult<FileOfficeSaved> {
        let candidate = self.prepare_edit(request, input).await?;
        let commit = FileContentService::new(self.store, &SystemFileContentClock)
            .update(request, &candidate.update())?;
        Ok(FileOfficeSaved {
            object: candidate.target,
            version_number: commit.receipt.version_number,
            content_hash: commit.receipt.content_hash.clone(),
            model: candidate.model,
            commit,
        })
    }
}

#[cfg(test)]
#[path = "file_office_tests.rs"]
mod tests;
