//! Text and Markdown edits share the native Record patch commit boundary.
use super::*;
use crate::agent::record_text::{RecordMutation, RecordTextPatch, RecordTextPreview};

impl<S: BoundRecordStore, W: DocumentUtility> RecordDocumentService<'_, S, W> {
    async fn convert_text_patch(
        &self,
        request: &RequestContext,
        base: &RecordDocumentHead,
        input: &RecordTextPatch,
    ) -> AgentResult<(RecordDocumentProjection, RecordPatchMetadata)> {
        let converted = self
            .utility
            .request(
                &request.request_id,
                "record.text.patch",
                json!({
                    "document":base.projection.document,
                    "codeLanguage":base.projection.code_language,
                    "edit":input.edit,
                }),
            )
            .await?;
        Self::decode_patch_projection(converted)
    }

    pub(crate) async fn text_patch(
        &self,
        request: &RequestContext,
        input: &RecordTextPatch,
    ) -> AgentResult<RecordPatchResult> {
        let edit = RecordMutation::Text(input);
        let target = edit.target()?;
        if input.request_id != request.request_id
            || input.record.workspace_id != request.binding.workspace_id
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Record edit identity does not match the request",
            ));
        }
        let base = self.access(request, &target, "record.patch", |db| {
            db.record_mutation_prepare(&request.caller.key(), edit)
        })?;
        let base = match base {
            RecordPatchPreparation::Replay(previous) => return Ok(previous),
            RecordPatchPreparation::Base(base) => base,
        };
        let (projection, metadata) = self.convert_text_patch(request, &base, input).await?;
        self.commit_converted_patch(request, edit, &projection, &metadata)
            .await
    }

    pub(crate) async fn text_patch_preview(
        &self,
        request: &RequestContext,
        input: &RecordTextPreview,
    ) -> AgentResult<RecordPatchPreview> {
        let budget = input.budget_chars.unwrap_or(4000);
        if !(1..=12000).contains(&budget) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid preview character budget",
            ));
        }
        let intent = RecordTextPatch {
            record: input.record.clone(),
            base_revision: input.base_revision,
            request_id: request.request_id.clone(),
            edit: input.edit.clone(),
        };
        let edit = RecordMutation::Text(&intent);
        let target = edit.target()?;
        if input.record.workspace_id != request.binding.workspace_id {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Record edit identity does not match the request",
            ));
        }
        let base = self.access(request, &target, "record.patch", |db| {
            db.record_mutation_preview_base(edit)
        })?;
        let (projection, metadata) = self.convert_text_patch(request, &base, &intent).await?;
        self.access(request, &target, "record.patch", |db| {
            Self::authorize_references(request, db, &projection.document, "record.patch")?;
            db.record_mutation_preview_validate(edit, &projection, &metadata)
        })?;
        let full_text_chars = projection.text.chars().count();
        Ok(RecordPatchPreview {
            target,
            base_revision: input.base_revision,
            base_body_hash: base.projection.body_hash,
            created_block_count: metadata.created_block_ids.len(),
            deleted_block_count: metadata.deleted_block_ids.len(),
            normalization_count: metadata.normalizations.len(),
            no_change: metadata.no_change,
            preview_text: projection.text.chars().take(budget).collect(),
            preview_truncated: full_text_chars > budget,
            full_text_chars,
        })
    }
}
