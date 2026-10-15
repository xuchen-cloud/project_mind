//! File execution uses a current Host connection for long byte IO. The GUI
//! database lock is used only for candidate metadata and authority checks.
use super::{
    access::{Caller, RequestContext},
    errors::{AgentError, AgentResult, ErrorCode},
    models::ExecutionMode,
    output_runtime::{OutputUpdateInput, RuntimeOutput, StageRecordInput},
    outputs::OutputIntent,
    record_outputs::RecordOutputResult,
};
use crate::{
    committed_changes::capture_committed,
    db::agent_record_withdrawals::{
        RecordRestoreInput, RecordWithdrawalInput, RecordWithdrawalResult,
    },
    file_content::{FileContentService, FileContentUpdate, SystemFileContentClock},
    file_version_service::{
        BoundFileCommitStore, FileBytesReader, FileVersionService, FilesystemFileReader,
    },
    record_document_service::BoundRecordStore,
    source_service::SourceReadTarget,
};
fn file(intent: &OutputIntent) -> AgentResult<()> {
    if matches!(
        intent,
        OutputIntent::FileCreate { .. }
            | OutputIntent::FileUpdate { .. }
            | OutputIntent::FilePatch { .. }
            | OutputIntent::FileRestore { .. }
    ) {
        Ok(())
    } else {
        Err(AgentError::new(
            ErrorCode::ToolCallUnsupported,
            "Expected a File candidate",
        ))
    }
}
fn uploaded(intent: &OutputIntent) -> Option<FileContentUpdate> {
    if let OutputIntent::FileUpdate {
        target,
        expected_version,
        expected_hash,
        staged_content_id,
    } = intent
    {
        Some(FileContentUpdate {
            object: target.clone(),
            expected_version_number: *expected_version,
            expected_content_hash: expected_hash.clone(),
            staged_content_id: staged_content_id.clone(),
        })
    } else {
        None
    }
}
pub(crate) struct FileOutputService<'a, S> {
    store: &'a S,
}
impl<'a, S: BoundRecordStore + BoundFileCommitStore> FileOutputService<'a, S> {
    pub(crate) fn new(store: &'a S) -> Self {
        Self { store }
    }
    fn preflight(
        &self,
        request: &RequestContext,
        input: &StageRecordInput,
        run_id: &str,
        operation: &str,
    ) -> AgentResult<()> {
        let host = self.store.gui_commit_host(&request.binding)?;
        let db = host.database()?;
        match &input.intent {
            OutputIntent::FilePatch { patch } => {
                let plan = db.source_file_plan(
                    request,
                    host.binding(),
                    &SourceReadTarget {
                        object: patch.object.clone(),
                        revision: None,
                        file_version: None,
                        record_version: None,
                    },
                )?;
                if plan.file_version != patch.expected_version_number
                    || plan.registered_hash != patch.expected_content_hash
                {
                    return Err(AgentError::new(
                        ErrorCode::RevisionConflict,
                        "File patch baseline changed",
                    ));
                }
                let captured = FilesystemFileReader.capture_update(&plan)?;
                let extension = plan
                    .path
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if !matches!(extension.as_str(), "md" | "txt" | "html" | "htm") {
                    return Err(AgentError::new(
                        ErrorCode::InvalidPatch,
                        "File patch supports UTF-8 md/txt/html/htm source only",
                    ));
                }
                crate::file_text_patch::apply(
                    &captured.bytes,
                    patch.edits.as_deref(),
                    patch.append_text.as_deref(),
                )?;
            }
            OutputIntent::FileRestore { restore } => {
                let source = db.file_version_restore_source(request, host.binding(), restore)?;
                // Capture with the existing no-follow exact-byte reader. The
                // restore kernel verifies this retained source again at commit.
                let historical = FilesystemFileReader.capture(&source.managed_path)?;
                if historical.content_hash() != source.content_hash {
                    return Err(AgentError::new(
                        ErrorCode::SourceChanged,
                        "Historical File bytes differ from the registered version",
                    ));
                }
            }
            OutputIntent::FileUpdate { .. } => {
                let owner =
                    db.agent_output_file_upload_owner(request, host.binding(), run_id, operation)?;
                FileContentService::new(self.store, &SystemFileContentClock)
                    .validate_output_stage(request, &uploaded(&input.intent).unwrap(), &owner)?;
            }
            OutputIntent::FileCreate { .. } => {}
            _ => file(&input.intent)?,
        }
        Ok(())
    }
    pub(crate) fn stage_and_execute(
        &self,
        request: &RequestContext,
        input: &StageRecordInput,
    ) -> AgentResult<RecordOutputResult> {
        file(&input.intent)?;
        let previous = self
            .store
            .with_current(|binding, db| db.agent_output_stage_validate(request, binding, input))?;
        let output = if let Some(previous) = previous {
            previous
        } else {
            let Caller::BuiltinRun { run_id } = &request.caller else {
                return Err(AgentError::new(
                    ErrorCode::ScopeDenied,
                    "Only a bound run can stage a File",
                ));
            };
            self.preflight(request, input, run_id, "output.stage")?;
            self.store
                .with_current(|binding, db| db.agent_output_stage_record(request, binding, input))?
        };
        if output.mode == ExecutionMode::Collaborate {
            self.commit_file(request, &output.staged.id, output.staged.revision)
        } else {
            Ok(RecordOutputResult {
                output,
                receipt: None,
                operation: None,
            })
        }
    }
    pub(crate) fn update_file(
        &self,
        request: &RequestContext,
        input: &OutputUpdateInput,
    ) -> AgentResult<RuntimeOutput> {
        file(&input.candidate.intent)?;
        let previous = self
            .store
            .with_current(|binding, db| db.agent_output_update_validate(request, binding, input))?;
        if previous.staged.revision != input.expected_revision {
            return Ok(previous);
        }
        self.preflight(
            request,
            &input.candidate,
            &previous.staged.run_id,
            "output.update",
        )?;
        self.store
            .with_current(|binding, db| db.agent_output_update(request, binding, input))
    }
    pub(crate) fn commit_file(
        &self,
        request: &RequestContext,
        id: &str,
        revision: u64,
    ) -> AgentResult<RecordOutputResult> {
        let host = self.store.gui_commit_host(&request.binding)?;
        let mut db = host.database()?;
        file(
            &db.agent_output_get(request, host.binding(), id)?
                .staged
                .intent,
        )?;
        if let Some(receipt) =
            db.agent_output_record_receipt(request, host.binding(), id, revision)?
        {
            return Ok(RecordOutputResult {
                output: db.agent_output_get(request, host.binding(), id)?,
                receipt: Some(receipt),
                operation: db.agent_output_record_operation(
                    request,
                    host.binding(),
                    id,
                    revision,
                )?,
            });
        }
        let prepared = db.agent_output_commit_prepare(request, host.binding(), id, revision)?;
        file(&prepared.output.staged.intent)?;
        let mut native = request.clone();
        native.request_id = prepared.commit_request_id;
        // Native services own the existing file journal and filesystem leases.
        // Their atomic callback binds this result to the approved candidate.
        let saved = match &prepared.output.staged.intent {
            OutputIntent::FileCreate {
                project_id,
                safe_name,
                utf8_content,
            } => {
                let before = db.committed_change_watermark()?;
                let result = db.agent_file_create_bound(
                    &native,
                    host.binding(),
                    &crate::db::file_imports::AgentFileCreateInput {
                        project_id: *project_id,
                        safe_name: safe_name.clone(),
                        utf8_content: utf8_content.clone(),
                    },
                    host.fence(),
                );
                let changes = db
                    .committed_changes_since(host.binding(), &native.request_id, before)
                    .ok()
                    .flatten();
                if let Some(changes) = changes {
                    self.store.publish_committed(changes);
                }
                result.map(|_| ())
            }
            OutputIntent::FilePatch { patch } => {
                FileVersionService::new(self.store, &FilesystemFileReader)
                    .patch_text(&native, patch)
                    .map(|_| ())
            }
            OutputIntent::FileRestore { restore } => {
                FileVersionService::new(self.store, &FilesystemFileReader)
                    .restore_version(&native, restore)
                    .map(|_| ())
            }
            OutputIntent::FileUpdate { .. } => {
                FileContentService::new(self.store, &SystemFileContentClock)
                    .update_output(&native, &uploaded(&prepared.output.staged.intent).unwrap())
                    .map(|_| ())
            }
            _ => unreachable!(),
        };
        if let Err(error) = saved {
            if db
                .agent_output_record_receipt(request, host.binding(), id, revision)?
                .is_none()
            {
                let _ =
                    db.agent_output_mark_failed(request, host.binding(), id, revision, error.code);
                return Err(error);
            }
        }
        let receipt = db
            .agent_output_record_receipt(request, host.binding(), id, revision)?
            .ok_or_else(|| {
                AgentError::new(
                    ErrorCode::OutputCommitFailed,
                    "File save has no native receipt",
                )
            })?;
        Ok(RecordOutputResult {
            output: db.agent_output_get(request, host.binding(), id)?,
            receipt: Some(receipt),
            operation: db.agent_output_record_operation(request, host.binding(), id, revision)?,
        })
    }
}
pub(crate) fn withdraw_created_file<S: BoundFileCommitStore>(
    store: &S,
    request: &RequestContext,
    input: &RecordWithdrawalInput,
) -> AgentResult<RecordWithdrawalResult> {
    let host = store.gui_commit_host(&request.binding)?;
    let db = host.database()?;
    let permit = host.fence().enter()?;
    let (result, changes) = capture_committed(host.binding(), &db, &request.request_id, || {
        db.agent_file_creation_withdraw(request, host.binding(), input)
    })?;
    drop(db);
    drop(permit);
    if let Some(changes) = changes {
        store.publish_committed(changes);
    }
    result
}
pub(crate) fn restore_created_file<S: BoundFileCommitStore>(
    store: &S,
    request: &RequestContext,
    input: &RecordRestoreInput,
) -> AgentResult<RecordWithdrawalResult> {
    let host = store.gui_commit_host(&request.binding)?;
    let db = host.database()?;
    let permit = host.fence().enter()?;
    let (result, changes) = capture_committed(host.binding(), &db, &request.request_id, || {
        db.agent_file_creation_restore(request, host.binding(), input)
    })?;
    drop(db);
    drop(permit);
    if let Some(changes) = changes {
        store.publish_committed(changes);
    }
    result
}
