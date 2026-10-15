//! Record output execution reuses the native document service and its receipts.
//! Staging converts and validates content without flushing editors or saving it.
use super::{
    access::{Caller, RequestContext},
    errors::{AgentError, AgentResult, ErrorCode},
    models::ExecutionMode,
    operations::OperationEntry,
    output_runtime::{OutputUpdateInput, RuntimeOutput, StageRecordInput},
    outputs::OutputIntent,
};
use crate::{
    record_document_service::{
        BoundRecordStore, DocumentUtility, RecordDocumentService, RecordVersionDifference,
    },
    record_documents::{
        record_patch_target, RecordCreate, RecordDocumentProjection, RecordPatchMetadata,
    },
};
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordOutputResult {
    pub output: RuntimeOutput,
    pub receipt: Option<Value>,
    pub operation: Option<OperationEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordOutputPreview {
    pub output_id: String,
    pub revision: u64,
    pub base_revision: u64,
    pub difference: RecordVersionDifference,
}

pub(crate) struct RecordOutputService<'a, S, W> {
    store: &'a S,
    utility: &'a W,
}

fn projection(value: Value) -> AgentResult<RecordDocumentProjection> {
    let projection: RecordDocumentProjection = serde_json::from_value(value).map_err(|_| {
        AgentError::new(
            ErrorCode::RuntimeIncompatible,
            "Invalid Record candidate projection",
        )
    })?;
    projection.validate()?;
    Ok(projection)
}

impl<'a, S: BoundRecordStore, W: DocumentUtility> RecordOutputService<'a, S, W> {
    pub(crate) fn new(store: &'a S, utility: &'a W) -> Self {
        Self { store, utility }
    }

    async fn markdown(
        &self,
        request: &RequestContext,
        markdown: &str,
    ) -> AgentResult<RecordDocumentProjection> {
        projection(
            self.utility
                .request(
                    &request.request_id,
                    "record.initialize",
                    json!({"markdown":markdown}),
                )
                .await?,
        )
    }

    async fn candidate(
        &self,
        request: &RequestContext,
        input: &StageRecordInput,
    ) -> AgentResult<(RecordDocumentProjection, &'static str)> {
        match &input.intent {
            OutputIntent::RecordCreate { markdown, .. } => {
                Ok((self.markdown(request, markdown).await?, "content.create"))
            }
            OutputIntent::RecordPatch { patch } => {
                let base = self.store.with_current(|binding, db| {
                    request.authorize(binding, &patch.record.scope, "record.patch")?;
                    let actual = db
                        .agent_resolve_object(&patch.record, &binding.workspace_id)?
                        .ok_or_else(|| {
                            AgentError::new(ErrorCode::NotFound, "Record target not found")
                        })?;
                    request.authorize_object(binding, &patch.record, &actual, "record.patch")?;
                    db.record_document_head(&record_patch_target(patch)?)?
                        .ok_or_else(|| {
                            AgentError::new(
                                ErrorCode::SourceNotReady,
                                "Record document is not initialized",
                            )
                        })
                })?;
                let mut converted = self.utility.request(&request.request_id, "record.patch", json!({"document":base.projection.document,"codeLanguage":base.projection.code_language,"operations":patch.operations})).await?;
                let _: RecordPatchMetadata = converted
                    .as_object_mut()
                    .and_then(|object| object.remove("patch"))
                    .and_then(|metadata| serde_json::from_value(metadata).ok())
                    .ok_or_else(|| {
                        AgentError::new(
                            ErrorCode::RuntimeIncompatible,
                            "Invalid Record candidate patch metadata",
                        )
                    })?;
                Ok((projection(converted)?, "record.patch"))
            }
            _ => {
                return Err(AgentError::new(
                    ErrorCode::ToolCallUnsupported,
                    "Only Record outputs are supported",
                ))
            }
        }
    }

    pub(crate) async fn stage_record(
        &self,
        request: &RequestContext,
        input: &StageRecordInput,
    ) -> AgentResult<RuntimeOutput> {
        if let Some(previous) = self
            .store
            .with_current(|binding, db| db.agent_output_stage_validate(request, binding, input))?
        {
            return Ok(previous);
        }
        let (candidate, operation) = self.candidate(request, input).await?;
        self.store.with_current(|binding, db| {
            // Conversion can await a worker while the Workspace or run changes.
            db.agent_output_stage_validate(request, binding, input)?;
            let Caller::BuiltinRun { run_id } = &request.caller else {
                return Err(AgentError::new(
                    ErrorCode::ScopeDenied,
                    "Staging requires a trusted run",
                ));
            };
            db.agent_output_validate_document(
                request,
                binding,
                run_id,
                &candidate.document,
                operation,
            )?;
            if let OutputIntent::RecordCreate { scope, .. } = &input.intent {
                db.record_document_scope_from_gui(scope, &candidate.document)?;
            }
            db.agent_output_stage_record(request, binding, input)
        })
    }

    pub(crate) async fn update_record(
        &self,
        request: &RequestContext,
        input: &OutputUpdateInput,
    ) -> AgentResult<RuntimeOutput> {
        let previous = self
            .store
            .with_current(|binding, db| db.agent_output_update_validate(request, binding, input))?;
        if previous.staged.revision != input.expected_revision {
            return Ok(previous);
        }
        let (candidate, operation) = self.candidate(request, &input.candidate).await?;
        self.store.with_current(|binding, db| {
            db.agent_output_update_validate(request, binding, input)?;
            db.agent_output_validate_document(
                request,
                binding,
                &previous.staged.run_id,
                &candidate.document,
                operation,
            )?;
            if let OutputIntent::RecordCreate { scope, .. } = &input.candidate.intent {
                db.record_document_scope_from_gui(scope, &candidate.document)?;
            }
            db.agent_output_update(request, binding, input)
        })
    }

    pub(crate) async fn stage_and_execute(
        &self,
        request: &RequestContext,
        input: &StageRecordInput,
    ) -> AgentResult<RecordOutputResult> {
        let output = self.stage_record(request, input).await?;
        if output.mode == ExecutionMode::Collaborate {
            self.commit_record(request, &output.staged.id, output.staged.revision)
                .await
        } else {
            Ok(RecordOutputResult {
                output,
                receipt: None,
                operation: None,
            })
        }
    }

    pub(crate) async fn preview_record(
        &self,
        request: &RequestContext,
        id: &str,
        expected_revision: u64,
    ) -> AgentResult<RecordOutputPreview> {
        let (output, base) = self.store.with_current(|binding, db| {
            let output =
                db.agent_output_preview_validate(request, binding, id, expected_revision)?;
            let OutputIntent::RecordPatch { patch } = &output.staged.intent else {
                return Err(AgentError::new(
                    ErrorCode::ToolCallUnsupported,
                    "Only Record patches have a base comparison",
                ));
            };
            let base = db
                .record_document_head(&record_patch_target(patch)?)?
                .ok_or_else(|| {
                    AgentError::new(
                        ErrorCode::SourceNotReady,
                        "Record document is not initialized",
                    )
                })?;
            Ok((output, base))
        })?;
        let input = StageRecordInput {
            intent: output.staged.intent.clone(),
            sources: output.staged.sources.clone(),
        };
        let (candidate, operation) = self.candidate(request, &input).await?;
        self.store.with_current(|binding, db| {
            db.agent_output_preview_validate(request, binding, id, expected_revision)?;
            db.agent_output_validate_document(
                request,
                binding,
                &output.staged.run_id,
                &candidate.document,
                operation,
            )
        })?;
        let compared = self
            .utility
            .request(
                &request.request_id,
                "record.compare",
                json!({"document":base.projection.document,"otherDocument":candidate.document}),
            )
            .await?;
        let difference: RecordVersionDifference =
            serde_json::from_value(compared).map_err(|_| {
                AgentError::new(
                    ErrorCode::RuntimeIncompatible,
                    "Invalid Record preview comparison",
                )
            })?;
        self.store.with_current(|binding, db| {
            // Both awaited conversions can race a GUI edit or Workspace switch.
            db.agent_output_preview_validate(request, binding, id, expected_revision)?;
            db.agent_output_validate_document(
                request,
                binding,
                &output.staged.run_id,
                &candidate.document,
                operation,
            )?;
            Ok(RecordOutputPreview {
                output_id: id.into(),
                revision: expected_revision,
                base_revision: base.head_revision,
                difference,
            })
        })
    }

    pub(crate) async fn commit_record(
        &self,
        request: &RequestContext,
        id: &str,
        expected_revision: u64,
    ) -> AgentResult<RecordOutputResult> {
        // A committed retry must not reconvert Markdown and allocate fresh block IDs.
        if let Some(receipt) = self.store.with_current(|binding, db| {
            db.agent_output_record_receipt(request, binding, id, expected_revision)
        })? {
            let output = self
                .store
                .with_current(|binding, db| db.agent_output_get(request, binding, id))?;
            return Ok(RecordOutputResult {
                output,
                receipt: Some(receipt),
                operation: self.store.with_current(|binding, db| {
                    db.agent_output_record_operation(request, binding, id, expected_revision)
                })?,
            });
        }
        let prepared = self.store.with_current(|binding, db| {
            db.agent_output_commit_prepare(request, binding, id, expected_revision)
        })?;
        let mut native = request.clone();
        native.request_id = prepared.commit_request_id;
        let documents = RecordDocumentService::new(self.store, self.utility);
        let save: AgentResult<()> = async {
            match &prepared.output.staged.intent {
                OutputIntent::RecordCreate {
                    scope,
                    title,
                    markdown,
                } => {
                    let candidate = self.markdown(&native, markdown).await?;
                    self.store.with_current(|binding, db| {
                        db.agent_output_validate_document(
                            &native,
                            binding,
                            &prepared.output.staged.run_id,
                            &candidate.document,
                            "content.create",
                        )
                    })?;
                    documents
                        .create(
                            &native,
                            &RecordCreate {
                                scope: scope.clone(),
                                title: Some(title.clone()),
                                tag_ids: vec![],
                                document: candidate.document,
                                code_language: candidate.code_language,
                            },
                        )
                        .await?;
                }
                OutputIntent::RecordPatch { patch } => {
                    let mut patch = patch.clone();
                    patch.request_id = native.request_id.clone();
                    documents.patch(&native, &patch).await?;
                }
                _ => {
                    return Err(AgentError::new(
                        ErrorCode::ToolCallUnsupported,
                        "Only Record outputs are supported",
                    ))
                }
            }
            Ok(())
        }
        .await;
        if let Err(error) = save {
            // A native save may already have committed. Never rewrite that state
            // to failed, including when an acknowledgement is interrupted.
            let settlement = self.store.with_current(|binding, db| {
                if let Some(receipt) =
                    db.agent_output_record_receipt(request, binding, id, expected_revision)?
                {
                    return Ok(Some(RecordOutputResult {
                        output: db.agent_output_get(request, binding, id)?,
                        receipt: Some(receipt),
                        operation: db.agent_output_record_operation(
                            request,
                            binding,
                            id,
                            expected_revision,
                        )?,
                    }));
                } else {
                    db.agent_output_mark_failed(
                        request,
                        binding,
                        id,
                        expected_revision,
                        error.code,
                    )?;
                }
                Ok(None)
            });
            match settlement {
                Ok(Some(saved)) => return Ok(saved),
                Err(_) => eprintln!("Assistant Record output failure could not be persisted"),
                Ok(None) => {}
            }
            return Err(error);
        }
        self.store.with_current(|binding, db| {
            let receipt = db
                .agent_output_record_receipt(request, binding, id, expected_revision)?
                .ok_or_else(|| {
                    AgentError::new(
                        ErrorCode::OutputCommitFailed,
                        "Native Record save has no committed output receipt",
                    )
                })?;
            let output = db.agent_output_get(request, binding, id)?;
            Ok(RecordOutputResult {
                output,
                receipt: Some(receipt),
                operation: db.agent_output_record_operation(
                    request,
                    binding,
                    id,
                    expected_revision,
                )?,
            })
        })
    }
}

#[cfg(test)]
#[path = "record_outputs_tests.rs"]
mod tests;
