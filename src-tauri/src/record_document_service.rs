//! Shared Record operations. Every database phase resolves the *current* binding;
//! utility work must never keep an old Workspace database alive across a switch.
use crate::{
    agent::{
        access::{Caller, RequestContext},
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef, WorkspaceBinding},
    },
    db::Database,
    record_documents::{
        record_patch_target, RecordCheckpointInput, RecordCheckpointResult, RecordCommitResult,
        RecordCommittedHead, RecordDocumentCommit, RecordDocumentHead, RecordDocumentProjection,
        RecordEditorState, RecordMetadata, RecordMetadataUpdate, RecordPatchMetadata,
        RecordPatchPreparation, RecordPatchResult, RecordQuickNoteTransfer, RecordRestoreInput,
        RecordTarget, RecordVersion, RecordVersionCapacity, RecordVersionOrigin, RecordVersionPage,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Adapters submit the committed tree only. HTML, Markdown and text come from
/// the shared converter; title and tags use independent metadata operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordBodySave {
    pub target: RecordTarget,
    pub base_revision: u64,
    pub document: Value,
    pub code_language: Option<String>,
    pub origin: RecordSaveOrigin,
    pub edit_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<RecordMetadataUpdate>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RecordSaveOrigin {
    Manual,
    EditorAi,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RecordVersionDifference {
    pub added: Vec<String>,
    pub deleted: Vec<String>,
    pub modified: Vec<String>,
    pub moved: Vec<String>,
}

pub(crate) trait BoundRecordStore {
    /// Required for every adapter, including headless entry points. An adapter
    /// may acknowledge no live editors, but cannot silently omit coordination.
    fn flush_editors(
        &self,
        binding: &WorkspaceBinding,
        target: &RecordTarget,
    ) -> impl std::future::Future<Output = AgentResult<()>> + Send;
    fn submission_lock(
        &self,
        binding: &WorkspaceBinding,
        target: &RecordTarget,
    ) -> impl std::future::Future<Output = AgentResult<Option<tokio::sync::OwnedMutexGuard<()>>>> + Send;
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T>;
}
pub(crate) trait DocumentUtility {
    fn request(
        &self,
        request_id: &str,
        method: &str,
        data: Value,
    ) -> impl std::future::Future<Output = AgentResult<Value>> + Send;
}

/// Resolve process resources only for document conversion. Metadata-only calls
/// stay independent of the utility process's availability.
pub(crate) struct AppDocumentUtility(pub tauri::AppHandle);
impl DocumentUtility for AppDocumentUtility {
    async fn request(&self, request_id: &str, method: &str, data: Value) -> AgentResult<Value> {
        crate::record_document_worker::RecordDocumentWorker::for_app(&self.0)?
            .request(request_id, method, data)
            .await
    }
}
pub(crate) struct RecordDocumentService<'a, S, W> {
    store: &'a S,
    utility: &'a W,
}
impl<'a, S: BoundRecordStore, W: DocumentUtility> RecordDocumentService<'a, S, W> {
    pub(crate) fn new(store: &'a S, utility: &'a W) -> Self {
        Self { store, utility }
    }
    /// Called inside the authorized database phase immediately before commit.
    /// Workspace access alone cannot mint references into ungranted Projects.
    fn authorize_references(
        request: &RequestContext,
        db: &Database,
        document: &Value,
        operation: &str,
    ) -> AgentResult<()> {
        // The trusted Workspace GUI already offers references across Projects.
        // Remote and built-in callers must carry each Project's explicit grant.
        if matches!(request.caller, Caller::Gui) && request.scope_grant.workspace_content {
            return Ok(());
        }
        for scope in db.record_reference_scopes(document)? {
            request.authorize(&request.binding, &scope, operation)?;
        }
        Ok(())
    }
    pub(crate) fn authorize_target(
        &self,
        request: &RequestContext,
        target: &RecordTarget,
        operation: &str,
    ) -> AgentResult<()> {
        self.access(request, target, operation, |_| Ok(()))
    }
    pub(crate) async fn flush_editors(
        &self,
        request: &RequestContext,
        target: &RecordTarget,
        operation: &str,
    ) -> AgentResult<()> {
        self.authorize_target(request, target, operation)?;
        self.store.flush_editors(&request.binding, target).await?;
        // The acknowledgement may arrive after a Workspace switch. Never keep
        // the previous database or authorization alive across this await.
        self.authorize_target(request, target, operation)
    }
    pub(crate) async fn create(
        &self,
        request: &RequestContext,
        input: &crate::record_documents::RecordCreate,
    ) -> AgentResult<RecordCommittedHead> {
        if !matches!(request.caller, Caller::Gui) {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Record creation requires the local editor",
            ));
        }
        let (previous, portable) = self.store.with_current(|binding, db| {
            request.authorize(binding, &input.scope, "record.write")?;
            request.authorize(binding, &input.scope, "record.metadata.write")?;
            let previous = db.agent_operation_replay(
                &request.caller.key(),
                &request.request_id,
                "record.create",
                input,
            )?;
            if previous.is_some() {
                return Ok((previous, None));
            }
            Ok((
                None,
                Some(db.record_document_scope_from_gui(&input.scope, &input.document)?),
            ))
        })?;
        if let Some(previous) = previous {
            return Ok(previous);
        }
        let converted = self
            .utility
            .request(
                &request.request_id,
                "record.create",
                json!({"document":portable,"codeLanguage":input.code_language}),
            )
            .await?;
        let projection: RecordDocumentProjection =
            serde_json::from_value(converted).map_err(|_| {
                AgentError::new(
                    ErrorCode::RuntimeIncompatible,
                    "Invalid new Record projection",
                )
            })?;
        projection.validate()?;
        self.store.with_current(|binding, db| {
            request.authorize(binding, &input.scope, "record.write")?;
            request.authorize(binding, &input.scope, "record.metadata.write")?;
            Self::authorize_references(request, db, &projection.document, "record.write")?;
            db.record_create(
                &request.caller.key(),
                &request.request_id,
                input,
                &projection,
                &request.binding.workspace_id,
            )
        })
    }
    pub(crate) async fn quick_note_transfer(
        &self,
        request: &RequestContext,
        input: &RecordQuickNoteTransfer,
    ) -> AgentResult<RecordCommitResult> {
        if !matches!(request.caller, Caller::Gui) {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "QuickNote transfer requires the local editor",
            ));
        }
        let (replayed, quick, previous) = self.store.with_current(|binding, db| {
            request.authorize(binding, &input.scope, "record.quick_note.write")?;
            request.authorize(binding, &input.scope, "record.write")?;
            request.authorize(binding, &input.scope, "record.metadata.write")?;
            let replayed: Option<RecordCommitResult> = db.agent_operation_replay(
                &request.caller.key(),
                &request.request_id,
                "record.quick_note.transfer",
                input,
            )?;
            if replayed.is_some() {
                return Ok((replayed, None, None));
            }
            let quick = db.record_quick_note_source(&input.scope)?;
            if input.expected_markdown.trim().is_empty()
                || quick.markdown != input.expected_markdown
            {
                return Err(AgentError::new(
                    ErrorCode::SourceChanged,
                    "QuickNote changed before transfer",
                ));
            }
            let previous = if let Some(record_id) = input.record_id {
                let claimed = ObjectRef {
                    workspace_id: binding.workspace_id.clone(),
                    scope: input.scope.clone(),
                    kind: ObjectKind::Record,
                    id: record_id.to_string(),
                };
                let actual = db
                    .agent_resolve_object(&claimed, &binding.workspace_id)?
                    .ok_or_else(|| AgentError::new(ErrorCode::NotFound, "Record is missing"))?;
                request.authorize_object(binding, &claimed, &actual, "record.write")?;
                let target = crate::record_documents::RecordTarget {
                    scope: input.scope.clone(),
                    record_id,
                };
                let head = db.record_document_head(&target)?.ok_or_else(|| {
                    AgentError::new(
                        ErrorCode::SourceNotReady,
                        "Open the Record to initialize its document",
                    )
                })?;
                if input.base_revision != Some(head.head_revision) {
                    return Err(AgentError::new(
                        ErrorCode::RevisionConflict,
                        "Record changed before QuickNote append",
                    )
                    .with_details(json!({"headRevision":head.head_revision})));
                }
                Some(head)
            } else {
                None
            };
            Ok((None, Some(quick), previous))
        })?;
        if let Some(replayed) = replayed {
            return Ok(replayed);
        }
        let quick = quick.ok_or_else(|| {
            AgentError::new(
                ErrorCode::RuntimeIncompatible,
                "QuickNote source is missing",
            )
        })?;
        let converted = self.utility.request(&request.request_id,"record.initialize",json!({"html":quick.html,"assetBasePath":quick.asset_base_path,"codeLanguage":quick.code_language})).await?;
        let initial: RecordDocumentProjection =
            serde_json::from_value(converted).map_err(|_| {
                AgentError::new(
                    ErrorCode::RuntimeIncompatible,
                    "Invalid QuickNote utility projection",
                )
            })?;
        initial.validate()?;
        let (projection, empty) = if let Some(previous) = previous {
            let mut blocks = initial.document.get("content").cloned().ok_or_else(|| {
                AgentError::new(ErrorCode::InvalidPatch, "QuickNote has no document blocks")
            })?;
            fn strip_ids(value: &mut Value) {
                if let Some(attrs) = value.get_mut("attrs").and_then(Value::as_object_mut) {
                    attrs.remove("blockId");
                }
                if let Some(children) = value.get_mut("content").and_then(Value::as_array_mut) {
                    for child in children {
                        strip_ids(child);
                    }
                }
            }
            for block in blocks.as_array_mut().ok_or_else(|| {
                AgentError::new(ErrorCode::InvalidPatch, "Invalid QuickNote blocks")
            })? {
                strip_ids(block);
            }
            let mut converted = self.utility.request(&request.request_id,"record.patch",json!({"document":previous.projection.document,"codeLanguage":previous.projection.code_language,"operations":[{"op":"append","parentBlockId":null,"blocks":blocks}]})).await?;
            converted
                .as_object_mut()
                .ok_or_else(|| {
                    AgentError::new(
                        ErrorCode::RuntimeIncompatible,
                        "Invalid QuickNote append projection",
                    )
                })?
                .remove("patch");
            let projection = serde_json::from_value(converted).map_err(|_| {
                AgentError::new(
                    ErrorCode::RuntimeIncompatible,
                    "Invalid QuickNote append projection",
                )
            })?;
            (projection, None)
        } else {
            let converted = self
                .utility
                .request(
                    &request.request_id,
                    "record.initialize",
                    json!({"html":"<p></p>","codeLanguage":quick.code_language}),
                )
                .await?;
            let empty = serde_json::from_value(converted).map_err(|_| {
                AgentError::new(
                    ErrorCode::RuntimeIncompatible,
                    "Invalid empty Record projection",
                )
            })?;
            (initial, Some(empty))
        };
        let _submission = if let Some(record_id) = input.record_id {
            let target = RecordTarget {
                scope: input.scope.clone(),
                record_id,
            };
            self.flush_editors(request, &target, "record.write").await?;
            self.store
                .submission_lock(&request.binding, &target)
                .await?
        } else {
            None
        };
        self.store.with_current(|binding, db| {
            request.authorize(binding, &input.scope, "record.quick_note.write")?;
            request.authorize(binding, &input.scope, "record.write")?;
            request.authorize(binding, &input.scope, "record.metadata.write")?;
            Self::authorize_references(request, db, &projection.document, "record.write")?;
            db.record_quick_note_transfer(
                &request.caller.key(),
                &request.request_id,
                input,
                &quick.source_hash,
                &projection,
                empty.as_ref(),
                &request.binding.workspace_id,
            )
        })
    }
    fn access<T>(
        &self,
        request: &RequestContext,
        target: &RecordTarget,
        operation: &str,
        action: impl FnOnce(&Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        target.key()?;
        self.store.with_current(|binding, db| {
            request.authorize(binding, &target.scope, operation)?;
            let claimed = ObjectRef {
                workspace_id: request.binding.workspace_id.clone(),
                scope: target.scope.clone(),
                kind: ObjectKind::Record,
                id: target.record_id.to_string(),
            };
            let actual = db
                .agent_resolve_object(&claimed, &binding.workspace_id)?
                .ok_or_else(|| AgentError::new(ErrorCode::NotFound, "Record is missing"))?;
            request.authorize_object(binding, &claimed, &actual, operation)?;
            action(db)
        })
    }
    pub(crate) async fn head_get(
        &self,
        request: &RequestContext,
        target: &RecordTarget,
    ) -> AgentResult<RecordDocumentHead> {
        let (current, source) = self.access(request, target, "record.read", |db| {
            Ok((
                db.record_document_head(target)?,
                db.record_document_source(target)?,
            ))
        })?;
        if let Some(current) = current {
            return Ok(current);
        }
        if !matches!(request.caller, Caller::Gui) {
            return Err(AgentError::new(
                ErrorCode::SourceNotReady,
                "Open the Record in Mind to initialize its document",
            ));
        }
        let converted = self.utility.request(&request.request_id, "record.initialize", json!({"html":source.html,"assetBasePath":source.asset_base_path,"codeLanguage":source.code_language})).await?;
        let projection: RecordDocumentProjection =
            serde_json::from_value(converted).map_err(|_| {
                AgentError::new(
                    ErrorCode::RuntimeIncompatible,
                    "Invalid document utility projection",
                )
            })?;
        projection.validate()?;
        self.access(request, target, "record.read", |db| {
            Self::authorize_references(request, db, &projection.document, "record.read")?;
            db.record_document_initialize(
                &request.caller.key(),
                &request.request_id,
                target,
                &source.source_hash,
                &projection,
                &request.binding.workspace_id,
            )?;
            db.record_document_head(target)?
                .ok_or_else(|| AgentError::new(ErrorCode::NotFound, "Record is missing"))
        })
    }
    pub(crate) async fn editor_get(
        &self,
        request: &RequestContext,
        target: &RecordTarget,
    ) -> AgentResult<RecordEditorState> {
        self.head_get(request, target).await?;
        self.access(request, target, "record.read", |db| {
            db.record_editor_state(target)
        })
    }
    pub(crate) fn metadata_update(
        &self,
        request: &RequestContext,
        input: &RecordMetadataUpdate,
    ) -> AgentResult<RecordMetadata> {
        if !matches!(request.caller, Caller::Gui) {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Metadata saves require the local editor",
            ));
        }
        self.access(request, &input.target, "record.metadata.write", |db| {
            db.record_metadata_update(
                &request.caller.key(),
                &request.request_id,
                input,
                &request.binding.workspace_id,
            )
        })
    }
    pub(crate) fn metadata_get(
        &self,
        request: &RequestContext,
        target: &RecordTarget,
    ) -> AgentResult<RecordMetadata> {
        self.access(request, target, "record.read", |db| {
            db.record_metadata_get(target)
        })
    }
    pub(crate) fn metadata_apply(
        &self,
        request: &RequestContext,
        input: &crate::record_documents::RecordMetadataApply,
    ) -> AgentResult<RecordMetadata> {
        if !matches!(request.caller, Caller::Gui) {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "AI metadata requires the local editor",
            ));
        }
        self.access(
            request,
            &input.metadata.target,
            "record.metadata.write",
            |db| {
                db.record_metadata_apply(
                    &request.caller.key(),
                    &request.request_id,
                    input,
                    &request.binding.workspace_id,
                )
            },
        )
    }
    pub(crate) async fn save(
        &self,
        request: &RequestContext,
        input: &RecordBodySave,
    ) -> AgentResult<RecordCommitResult> {
        if !matches!(request.caller, Caller::Gui) {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Full document saves require the local editor",
            ));
        }
        if let Some(metadata) = &input.metadata {
            if metadata.target.key()? != input.target.key()? {
                return Err(AgentError::new(
                    ErrorCode::InvalidArgument,
                    "Metadata target differs from the body target",
                ));
            }
            self.access(request, &input.target, "record.metadata.write", |_| Ok(()))?;
        }
        let (previous, portable) = self.access(request, &input.target, "record.write", |db| {
            let previous = db.agent_operation_replay(
                &request.caller.key(),
                &request.request_id,
                "record.document.commit",
                input,
            )?;
            if previous.is_some() {
                return Ok((previous, None));
            }
            {
                let current = db.record_document_head(&input.target)?.ok_or_else(|| {
                    AgentError::new(
                        ErrorCode::SourceNotReady,
                        "Initialize the Record document first",
                    )
                })?;
                if input.base_revision != current.head_revision {
                    return Err(AgentError::new(
                        ErrorCode::RevisionConflict,
                        "Record changed before save",
                    )
                    .with_details(json!({"headRevision":current.head_revision})));
                }
            }
            Ok((
                None,
                Some(db.record_document_from_gui(&input.target, &input.document)?),
            ))
        })?;
        if let Some(previous) = previous {
            return Ok(previous);
        }
        let converted = self
            .utility
            .request(
                &request.request_id,
                "record.validate",
                json!({"document":portable,"codeLanguage":input.code_language}),
            )
            .await?;
        let projection: RecordDocumentProjection =
            serde_json::from_value(converted).map_err(|_| {
                AgentError::new(
                    ErrorCode::RuntimeIncompatible,
                    "Invalid document utility projection",
                )
            })?;
        projection.validate()?;
        let commit = RecordDocumentCommit {
            target: input.target.clone(),
            base_revision: input.base_revision,
            projection,
            origin: match input.origin {
                RecordSaveOrigin::Manual => RecordVersionOrigin::Manual,
                RecordSaveOrigin::EditorAi => RecordVersionOrigin::EditorAi,
            },
            actor: json!({"kind":"gui"}),
            edit_session_id: input.edit_session_id.clone(),
        };
        let _submission = self
            .store
            .submission_lock(&request.binding, &input.target)
            .await?;
        self.access(request, &input.target, "record.write", |db| {
            Self::authorize_references(request, db, &commit.projection.document, "record.write")?;
            db.record_document_commit_intent(
                &request.caller.key(),
                &request.request_id,
                &commit,
                input,
                input.metadata.as_ref(),
                &request.binding.workspace_id,
            )
        })
    }
    pub(crate) async fn patch(
        &self,
        request: &RequestContext,
        patch: &crate::agent::outputs::RecordPatch,
    ) -> AgentResult<RecordPatchResult> {
        let target = record_patch_target(patch)?;
        if patch.request_id != request.request_id
            || patch.record.workspace_id != request.binding.workspace_id
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Patch identity does not match the request",
            ));
        }
        let base = self.access(request, &target, "record.patch", |db| {
            db.record_patch_prepare(&request.caller.key(), patch)
        })?;
        let base = match base {
            RecordPatchPreparation::Replay(previous) => return Ok(previous),
            RecordPatchPreparation::Base(base) => base,
        };
        let mut converted = self.utility.request(&request.request_id, "record.patch", json!({"document":base.projection.document,"codeLanguage":base.projection.code_language,"operations":patch.operations})).await?;
        let metadata: RecordPatchMetadata = converted
            .as_object_mut()
            .and_then(|object| object.remove("patch"))
            .and_then(|metadata| serde_json::from_value(metadata).ok())
            .ok_or_else(|| {
                AgentError::new(
                    ErrorCode::RuntimeIncompatible,
                    "Invalid document utility patch metadata",
                )
            })?;
        let projection: RecordDocumentProjection =
            serde_json::from_value(converted).map_err(|_| {
                AgentError::new(
                    ErrorCode::RuntimeIncompatible,
                    "Invalid document utility projection",
                )
            })?;
        projection.validate()?;
        // Coordinate after pure conversion and before the submission lock:
        // editor autosave needs that same lock to flush its committed draft.
        self.flush_editors(request, &target, "record.patch").await?;
        let _submission = self
            .store
            .submission_lock(&request.binding, &target)
            .await?;
        self.access(request, &target, "record.patch", |db| {
            Self::authorize_references(request, db, &projection.document, "record.patch")?;
            db.record_patch_commit(
                &request.caller.key(),
                patch,
                &projection,
                &metadata,
                &request.binding.workspace_id,
            )
        })
    }
    pub(crate) fn versions_list(
        &self,
        request: &RequestContext,
        target: &RecordTarget,
        before: Option<u64>,
        limit: u32,
    ) -> AgentResult<RecordVersionPage> {
        self.access(request, target, "record.read", |db| {
            db.record_versions_list(target, before, limit)
        })
    }
    async fn regenerated_version(
        &self,
        request: &RequestContext,
        target: &RecordTarget,
        id: &str,
        operation: &str,
    ) -> AgentResult<RecordVersion> {
        let mut version = self.access(request, target, operation, |db| {
            db.record_version_get(target, id)
        })?;
        let converted = self.utility.request(&request.request_id, "record.validate", json!({"document":version.projection.document,"codeLanguage":version.projection.code_language})).await?;
        let projection: RecordDocumentProjection =
            serde_json::from_value(converted).map_err(|_| {
                AgentError::new(
                    ErrorCode::RuntimeIncompatible,
                    "Invalid document utility projection",
                )
            })?;
        projection.validate()?;
        if projection.body_hash != version.projection.body_hash {
            return Err(AgentError::new(
                ErrorCode::RuntimeIncompatible,
                "Historic document differs after conversion",
            ));
        }
        // Regenerate caches from the historic tree, never restore arbitrary HTML.
        version.projection = projection;
        self.access(request, target, operation, |_| Ok(version))
    }
    pub(crate) async fn version_get(
        &self,
        request: &RequestContext,
        target: &RecordTarget,
        id: &str,
    ) -> AgentResult<RecordVersion> {
        self.regenerated_version(request, target, id, "record.read")
            .await
    }
    pub(crate) async fn restore(
        &self,
        request: &RequestContext,
        input: &RecordRestoreInput,
    ) -> AgentResult<RecordCommitResult> {
        let previous = self.access(request, &input.target, "record.restore", |db| {
            db.agent_operation_replay(
                &request.caller.key(),
                &request.request_id,
                "record.version.restore",
                input,
            )
        })?;
        if let Some(previous) = previous {
            return Ok(previous);
        }
        let version = self
            .regenerated_version(request, &input.target, &input.version_id, "record.restore")
            .await?;
        self.flush_editors(request, &input.target, "record.restore")
            .await?;
        let _submission = self
            .store
            .submission_lock(&request.binding, &input.target)
            .await?;
        self.access(request, &input.target, "record.restore", |db| {
            Self::authorize_references(
                request,
                db,
                &version.projection.document,
                "record.restore",
            )?;
            db.record_version_restore_projection(
                &request.caller.key(),
                &request.request_id,
                input,
                &version.projection,
                &request.binding.workspace_id,
            )
        })
    }
    pub(crate) async fn version_preview(
        &self,
        request: &RequestContext,
        target: &RecordTarget,
        version_id: &str,
    ) -> AgentResult<(RecordVersion, String)> {
        let version = self.version_get(request, target, version_id).await?;
        let html = self.access(request, target, "record.read", |db| {
            db.record_version_editor_html(target, &version.projection)
        })?;
        Ok((version, html))
    }
    pub(crate) fn capacity(
        &self,
        request: &RequestContext,
        target: &RecordTarget,
    ) -> AgentResult<RecordVersionCapacity> {
        self.access(request, target, "record.read", |db| {
            db.record_version_capacity(target)
        })
    }
    pub(crate) fn checkpoint(
        &self,
        request: &RequestContext,
        input: &RecordCheckpointInput,
    ) -> AgentResult<RecordCheckpointResult> {
        if !matches!(request.caller, Caller::Gui) {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Editor checkpoints require the local editor",
            ));
        }
        self.access(request, &input.target, "record.write", |db| {
            db.record_document_checkpoint(
                &request.caller.key(),
                &request.request_id,
                input,
                &request.binding.workspace_id,
            )
        })
    }
    pub(crate) async fn versions_compare(
        &self,
        request: &RequestContext,
        target: &RecordTarget,
        before_id: &str,
        after_id: &str,
    ) -> AgentResult<RecordVersionDifference> {
        let (before, after) = self.access(request, target, "record.read", |db| {
            Ok((
                db.record_version_get(target, before_id)?,
                db.record_version_get(target, after_id)?,
            ))
        })?;
        let converted = self.utility.request(&request.request_id, "record.compare", json!({"document":before.projection.document,"otherDocument":after.projection.document})).await?;
        let difference: RecordVersionDifference =
            serde_json::from_value(converted).map_err(|_| {
                AgentError::new(
                    ErrorCode::RuntimeIncompatible,
                    "Invalid document utility comparison",
                )
            })?;
        self.access(request, target, "record.read", |_| Ok(difference))
    }
}

impl BoundRecordStore for crate::AppState {
    async fn flush_editors(
        &self,
        binding: &WorkspaceBinding,
        target: &RecordTarget,
    ) -> AgentResult<()> {
        use tauri::{Emitter, Manager};
        let windows = self.app_handle.webview_windows().into_keys().collect();
        self.record_editors
            .flush(binding, target, &windows, |flush| {
                self.app_handle
                    .emit_to(&flush.window, "record:flush-request", flush)
                    .map_err(|_| {
                        AgentError::new(ErrorCode::EditorBusy, "无法联系记录编辑窗口，草稿已保留")
                    })
            })
            .await
    }
    async fn submission_lock(
        &self,
        binding: &WorkspaceBinding,
        target: &RecordTarget,
    ) -> AgentResult<Option<tokio::sync::OwnedMutexGuard<()>>> {
        self.record_editors
            .submission_lock(binding, target)
            .await
            .map(Some)
    }
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        let current = crate::lock_mutex(&self.current_workspace);
        let runtime = current.as_ref().ok_or_else(|| {
            AgentError::new(ErrorCode::WorkspaceNotOpen, "Open a Workspace first")
        })?;
        // No await occurs while these locks are held. Reopening even the same
        // directory replaces this generation and rejects stale conversions.
        let db = crate::lock_mutex(&runtime.db);
        action(&runtime.agent_binding, &db)
    }
}
impl DocumentUtility for crate::record_document_worker::RecordDocumentWorker {
    async fn request(&self, request_id: &str, method: &str, data: Value) -> AgentResult<Value> {
        self.request(request_id, method, data).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            access::{Caller, ScopeGrant},
            errors::ErrorCode,
            models::Scope,
        },
        models::WorkspaceRecordUpsertInput,
        record_documents::RecordDocumentProjection,
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };

    struct Store {
        binding: Arc<Mutex<WorkspaceBinding>>,
        db: Arc<Mutex<Database>>,
        flush_calls: AtomicUsize,
        flush_error: Mutex<Option<ErrorCode>>,
        on_flush: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
    }
    impl BoundRecordStore for Store {
        async fn flush_editors(
            &self,
            _binding: &WorkspaceBinding,
            _target: &RecordTarget,
        ) -> AgentResult<()> {
            self.flush_calls.fetch_add(1, Ordering::Relaxed);
            if let Some(code) = *self.flush_error.lock().unwrap() {
                return Err(AgentError::new(code, "Editor refused the write"));
            }
            if let Some(callback) = self.on_flush.lock().unwrap().as_ref() {
                callback();
            }
            Ok(())
        }
        async fn submission_lock(
            &self,
            _binding: &WorkspaceBinding,
            _target: &RecordTarget,
        ) -> AgentResult<Option<tokio::sync::OwnedMutexGuard<()>>> {
            Ok(None)
        }
        fn with_current<T>(
            &self,
            action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
        ) -> AgentResult<T> {
            let binding = self.binding.lock().unwrap();
            action(&binding, &self.db.lock().unwrap())
        }
    }
    struct Utility {
        calls: AtomicUsize,
        projection: RecordDocumentProjection,
        on_request: Option<Box<dyn Fn() + Send + Sync>>,
    }
    impl DocumentUtility for Utility {
        async fn request(&self, _id: &str, method: &str, _data: Value) -> AgentResult<Value> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            if let Some(callback) = &self.on_request {
                callback();
            }
            let mut result = serde_json::to_value(&self.projection).unwrap();
            if method == "record.patch" {
                result["patch"] = json!({"createdBlockIds":[],"deletedBlockIds":[],"normalizations":[],"noChange":false});
            }
            Ok(result)
        }
    }
    fn setup() -> (
        tempfile::TempDir,
        Store,
        Utility,
        RequestContext,
        RecordTarget,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let mut db =
            Database::open(&directory.path().join("app.sqlite"), directory.path(), None).unwrap();
        let projection: RecordDocumentProjection =
            serde_json::from_str(include_str!("record_document_projection.fixture.json")).unwrap();
        let record = db
            .workspace_record_upsert(WorkspaceRecordUpsertInput {
                note_id: None,
                title: Some("Keep title".into()),
                html: "<p>Fixture 正文</p>".into(),
                markdown: "Fixture 正文".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "workspace-test".into(),
            generation: "generation-1".into(),
        };
        let request = RequestContext {
            binding: binding.clone(),
            request_id: "open-record".into(),
            caller: Caller::Gui,
            scope_grant: ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: true,
                project_ids: vec![],
                operations: vec![
                    "record.read".into(),
                    "record.patch".into(),
                    "record.write".into(),
                    "record.restore".into(),
                ],
            },
        };
        (
            directory,
            Store {
                binding: Arc::new(Mutex::new(binding)),
                db: Arc::new(Mutex::new(db)),
                flush_calls: AtomicUsize::new(0),
                flush_error: Mutex::new(None),
                on_flush: Mutex::new(None),
            },
            Utility {
                calls: AtomicUsize::new(0),
                projection,
                on_request: None,
            },
            request,
            RecordTarget {
                scope: Scope::Workspace,
                record_id: record.id,
            },
        )
    }
    #[tokio::test]
    async fn workspace_patch_cannot_add_references_to_an_ungranted_project() {
        let (_directory, store, mut utility, mut request, target) = setup();
        RecordDocumentService::new(&store, &utility)
            .head_get(&request, &target)
            .await
            .unwrap();
        let (project_id, record_id) = {
            let mut db = store.db.lock().unwrap();
            let project = db
                .project_create(crate::models::ProjectCreateInput {
                    name: "Private Project".into(),
                    summary: None,
                    status: None,
                })
                .unwrap();
            let record = db
                .project_record_upsert(crate::models::ProjectRecordUpsertInput {
                    project_id: project.id,
                    note_id: None,
                    title: Some("Reference target".into()),
                    markdown: "Target".into(),
                    html: "<p>Target</p>".into(),
                    default_code_language: None,
                    tag_ids: vec![],
                })
                .unwrap();
            (project.id, record.id)
        };
        utility.projection.document["content"][0]["content"] = json!([{"type":"internalReference","attrs":{"refKind":"note","refId":record_id,"label":"Reference target"}}]);
        utility.projection.body_hash = crate::record_documents::body_hash(
            &utility.projection.document,
            &utility.projection.code_language,
        );
        request.caller = Caller::Connection {
            grant_id: "workspace-only".into(),
        };
        request.request_id = "ungranted-reference".into();
        let patch = serde_json::from_value(json!({"record":ObjectRef {workspace_id:request.binding.workspace_id.clone(),scope:target.scope.clone(),kind:ObjectKind::Record,id:target.record_id.to_string()},"baseRevision":1,"requestId":request.request_id,"operations":[{"op":"append","parentBlockId":null,"blocks":[{"type":"paragraph","content":[{"type":"internalReference","attrs":{"refKind":"note","refId":record_id,"label":"Reference target"}}]}]}]})).unwrap();
        assert_eq!(
            RecordDocumentService::new(&store, &utility)
                .patch(&request, &patch)
                .await
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        let db = store.db.lock().unwrap();
        assert_eq!(
            db.record_document_head(&target)
                .unwrap()
                .unwrap()
                .head_revision,
            1
        );
        request.scope_grant.project_ids.push(project_id);
        RecordDocumentService::<Store, Utility>::authorize_references(
            &request,
            &db,
            &utility.projection.document,
            "record.patch",
        )
        .unwrap();
    }
    #[tokio::test]
    async fn record_service_creation_rechecks_binding_after_conversion() {
        let (_directory, store, mut utility, mut request, _target) = setup();
        request
            .scope_grant
            .operations
            .push("record.metadata.write".into());
        let binding = store.binding.clone();
        utility.on_request = Some(Box::new(move || {
            binding.lock().unwrap().generation = "reopened".into()
        }));
        let count = || {
            store
                .db
                .lock()
                .unwrap()
                .workspace_page_get()
                .unwrap()
                .records
                .len()
        };
        let before = count();
        let input = crate::record_documents::RecordCreate {
            scope: Scope::Workspace,
            title: Some("New".into()),
            tag_ids: vec![],
            document: utility.projection.document.clone(),
            code_language: None,
        };
        assert_eq!(
            RecordDocumentService::new(&store, &utility)
                .create(&request, &input)
                .await
                .unwrap_err()
                .code,
            ErrorCode::WorkspaceChanged
        );
        assert_eq!(count(), before);
    }
    #[tokio::test]
    #[ignore = "requires prepared fixed Node runtime and built Record worker"]
    async fn record_service_creation_owns_fresh_ids_and_replays_without_a_duplicate() {
        let (_directory, store, _utility, mut request, target) = setup();
        request
            .scope_grant
            .operations
            .push("record.metadata.write".into());
        let utility = crate::record_document_worker::RecordDocumentWorker::development().unwrap();
        let service = RecordDocumentService::new(&store, &utility);
        let source = service.editor_get(&request, &target).await.unwrap();
        let input = crate::record_documents::RecordCreate {
            scope: Scope::Workspace,
            title: Some("Copy".into()),
            tag_ids: vec![],
            document: source.head.projection.document.clone(),
            code_language: None,
        };
        request.request_id = "create-copy".into();
        let created = service.create(&request, &input).await.unwrap();
        let replay = service.create(&request, &input).await.unwrap();
        assert_eq!(created.target.record_id, replay.target.record_id);
        assert_ne!(
            store
                .db
                .lock()
                .unwrap()
                .record_document_head(&created.target)
                .unwrap()
                .unwrap()
                .projection
                .document["content"][0]["attrs"]["blockId"],
            source.head.projection.document["content"][0]["attrs"]["blockId"]
        );
        assert_eq!(
            store
                .db
                .lock()
                .unwrap()
                .record_document_head(&created.target)
                .unwrap()
                .unwrap()
                .projection
                .markdown,
            source.head.projection.markdown
        );
        assert_eq!(
            store
                .db
                .lock()
                .unwrap()
                .workspace_page_get()
                .unwrap()
                .records
                .len(),
            2
        );
    }
    #[tokio::test]
    #[ignore = "requires prepared fixed Node runtime and built Record worker"]
    async fn record_service_quick_note_transfer_preserves_anchors_and_replays_without_reappending()
    {
        let (_directory, store, _utility, mut request, target) = setup();
        request.scope_grant.operations.extend([
            "record.quick_note.write".into(),
            "record.metadata.write".into(),
        ]);
        let utility = crate::record_document_worker::RecordDocumentWorker::development().unwrap();
        let service = RecordDocumentService::new(&store, &utility);
        let baseline = service.editor_get(&request, &target).await.unwrap();
        let first_id = baseline.head.projection.document["content"][0]["attrs"]["blockId"].clone();
        store
            .db
            .lock()
            .unwrap()
            .workspace_quick_note_upsert(crate::models::WorkspaceQuickNoteUpsertInput {
                markdown: "Captured idea".into(),
                html: "<p>Captured idea</p>".into(),
                default_code_language: Some("python".into()),
                tag_ids: vec![],
            })
            .unwrap();
        request.request_id = "actual-quick-append".into();
        let input = RecordQuickNoteTransfer {
            scope: target.scope.clone(),
            record_id: Some(target.record_id),
            base_revision: Some(1),
            metadata_revision: Some(baseline.metadata.revision),
            expected_markdown: "Captured idea".into(),
            title: None,
            tag_ids: vec![],
        };
        let saved = service.quick_note_transfer(&request, &input).await.unwrap();
        assert_eq!(saved.head.head_revision, 2);
        assert_eq!(
            store
                .db
                .lock()
                .unwrap()
                .record_document_head(&saved.head.target)
                .unwrap()
                .unwrap()
                .projection
                .document["content"][0]["attrs"]["blockId"],
            first_id
        );
        assert_eq!(
            store
                .db
                .lock()
                .unwrap()
                .record_document_head(&saved.head.target)
                .unwrap()
                .unwrap()
                .projection
                .text,
            "Fixture 正文\n\nCaptured idea"
        );
        assert!(store
            .db
            .lock()
            .unwrap()
            .record_document_head(&saved.head.target)
            .unwrap()
            .unwrap()
            .projection
            .code_language
            .is_none());
        *store.flush_error.lock().unwrap() = Some(ErrorCode::EditorReviewPending);
        let replayed = service.quick_note_transfer(&request, &input).await.unwrap();
        assert_eq!(replayed.head.head_revision, 2);
        assert_eq!(replayed.after_version, saved.after_version);
        assert_eq!(store.flush_calls.load(Ordering::Relaxed), 1);
        assert!(store
            .db
            .lock()
            .unwrap()
            .workspace_quick_note_get()
            .unwrap()
            .unwrap()
            .content_markdown
            .is_empty());
        store
            .db
            .lock()
            .unwrap()
            .workspace_quick_note_upsert(crate::models::WorkspaceQuickNoteUpsertInput {
                markdown: "New idea".into(),
                html: "<p>New idea</p>".into(),
                default_code_language: Some("python".into()),
                tag_ids: vec![],
            })
            .unwrap();
        request.request_id = "actual-quick-new".into();
        let input = RecordQuickNoteTransfer {
            scope: target.scope.clone(),
            record_id: None,
            base_revision: None,
            metadata_revision: None,
            expected_markdown: "New idea".into(),
            title: Some("Saved idea".into()),
            tag_ids: vec![],
        };
        let saved = service.quick_note_transfer(&request, &input).await.unwrap();
        assert_ne!(saved.head.target.record_id, target.record_id);
        assert_eq!(
            store
                .db
                .lock()
                .unwrap()
                .record_document_head(&saved.head.target)
                .unwrap()
                .unwrap()
                .projection
                .text,
            "New idea"
        );
        assert_eq!(
            store
                .db
                .lock()
                .unwrap()
                .record_document_head(&saved.head.target)
                .unwrap()
                .unwrap()
                .projection
                .code_language
                .as_deref(),
            Some("python")
        );
        assert_eq!(saved.head.head_revision, 2);
        assert_eq!(
            store
                .db
                .lock()
                .unwrap()
                .record_versions_list(&saved.head.target, None, 10)
                .unwrap()
                .versions
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn stale_workspace_binding_is_rejected_before_conversion_or_baseline_write() {
        let (_directory, store, utility, mut request, target) = setup();
        request.binding.generation = "old-generation".into();
        let error = RecordDocumentService::new(&store, &utility)
            .head_get(&request, &target)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::WorkspaceChanged);
        assert_eq!(utility.calls.load(Ordering::Relaxed), 0);
        assert!(store
            .db
            .lock()
            .unwrap()
            .record_document_head(&target)
            .unwrap()
            .is_none());
    }
    #[tokio::test]
    async fn workspace_switch_during_conversion_preserves_the_unconverted_record() {
        let (_directory, store, mut utility, request, target) = setup();
        let binding = store.binding.clone();
        utility.on_request = Some(Box::new(move || {
            binding.lock().unwrap().generation = "generation-2".into()
        }));
        let error = RecordDocumentService::new(&store, &utility)
            .head_get(&request, &target)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::WorkspaceChanged);
        assert_eq!(utility.calls.load(Ordering::Relaxed), 1);
        let db = store.db.lock().unwrap();
        assert!(db.record_document_head(&target).unwrap().is_none());
        assert_eq!(
            db.record_document_source(&target).unwrap().html,
            "<p>Fixture 正文</p>"
        );
    }
    #[tokio::test]
    async fn baseline_conversion_does_not_overwrite_a_concurrent_legacy_edit() {
        let (_directory, store, mut utility, request, target) = setup();
        let db = store.db.clone();
        let record_id = target.record_id;
        utility.on_request = Some(Box::new(move || {
            db.lock()
                .unwrap()
                .workspace_record_upsert(WorkspaceRecordUpsertInput {
                    note_id: Some(record_id),
                    title: Some("Keep title".into()),
                    html: "<p>Concurrent edit</p>".into(),
                    markdown: "Concurrent edit".into(),
                    default_code_language: None,
                    tag_ids: vec![],
                })
                .unwrap();
        }));
        let error = RecordDocumentService::new(&store, &utility)
            .head_get(&request, &target)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::RevisionConflict);
        let db = store.db.lock().unwrap();
        assert!(db.record_document_head(&target).unwrap().is_none());
        assert_eq!(
            db.record_document_source(&target).unwrap().html,
            "<p>Concurrent edit</p>"
        );
    }
    #[tokio::test]
    async fn concurrent_body_commit_during_conversion_rejects_the_stale_editor_save() {
        let (_directory, store, mut utility, mut request, target) = setup();
        RecordDocumentService::new(&store, &utility)
            .head_get(&request, &target)
            .await
            .unwrap();
        let mut concurrent = utility.projection.clone();
        concurrent.document["content"][0]["content"][0]["text"] = json!("Concurrent body");
        concurrent.html = concurrent.html.replace("Fixture 正文", "Concurrent body");
        concurrent.markdown = concurrent
            .markdown
            .replace("Fixture 正文", "Concurrent body");
        concurrent.text = concurrent.text.replace("Fixture 正文", "Concurrent body");
        concurrent.body_hash =
            crate::record_documents::body_hash(&concurrent.document, &concurrent.code_language);
        let input = RecordBodySave {
            target: target.clone(),
            base_revision: 1,
            document: utility.projection.document.clone(),
            code_language: utility.projection.code_language.clone(),
            origin: RecordSaveOrigin::Manual,
            edit_session_id: Some("c".repeat(32)),
            metadata: None,
        };
        let db = store.db.clone();
        let concurrent_target = target.clone();
        utility.on_request = Some(Box::new(move || {
            db.lock()
                .unwrap()
                .record_document_commit(
                    "run:other",
                    "concurrent",
                    &RecordDocumentCommit {
                        target: concurrent_target.clone(),
                        base_revision: 1,
                        projection: concurrent.clone(),
                        origin: RecordVersionOrigin::Agent,
                        actor: json!({"kind":"agent"}),
                        edit_session_id: None,
                    },
                    "workspace-test",
                )
                .unwrap();
        }));
        request.request_id = "stale-save".into();
        assert_eq!(
            RecordDocumentService::new(&store, &utility)
                .save(&request, &input)
                .await
                .unwrap_err()
                .code,
            ErrorCode::RevisionConflict
        );
        let db = store.db.lock().unwrap();
        let head = db.record_document_head(&target).unwrap().unwrap();
        assert_eq!(head.head_revision, 2);
        assert_eq!(
            head.projection.document["content"][0]["content"][0]["text"],
            "Concurrent body"
        );
        assert_eq!(
            db.record_version_capacity(&target).unwrap().version_count,
            2
        );
    }
    #[tokio::test]
    async fn combined_editor_save_rolls_back_body_when_metadata_changes_during_conversion() {
        let (_directory, store, mut utility, mut request, target) = setup();
        RecordDocumentService::new(&store, &utility)
            .head_get(&request, &target)
            .await
            .unwrap();
        let original = utility.projection.clone();
        utility.projection.document["content"][0]["content"][0]["text"] = json!("Candidate body");
        utility.projection.html = utility
            .projection
            .html
            .replace("Fixture 正文", "Candidate body");
        utility.projection.markdown = utility
            .projection
            .markdown
            .replace("Fixture 正文", "Candidate body");
        utility.projection.text = utility
            .projection
            .text
            .replace("Fixture 正文", "Candidate body");
        utility.projection.body_hash = crate::record_documents::body_hash(
            &utility.projection.document,
            &utility.projection.code_language,
        );
        let before = store
            .db
            .lock()
            .unwrap()
            .record_metadata_get(&target)
            .unwrap();
        let metadata = RecordMetadataUpdate {
            target: target.clone(),
            expected_revision: before.revision,
            title: Some("Candidate title".into()),
            tag_ids: vec![],
        };
        let input = RecordBodySave {
            target: target.clone(),
            base_revision: 1,
            document: utility.projection.document.clone(),
            code_language: utility.projection.code_language.clone(),
            origin: RecordSaveOrigin::Manual,
            edit_session_id: Some("c".repeat(32)),
            metadata: Some(metadata.clone()),
        };
        let db = store.db.clone();
        utility.on_request = Some(Box::new(move || {
            let mut other = metadata.clone();
            other.title = Some("Other header".into());
            db.lock()
                .unwrap()
                .record_metadata_update("gui", "other-header", &other, "workspace-test")
                .unwrap();
        }));
        request.request_id = "combined-stale".into();
        request
            .scope_grant
            .operations
            .push("record.metadata.write".into());
        assert_eq!(
            RecordDocumentService::new(&store, &utility)
                .save(&request, &input)
                .await
                .unwrap_err()
                .code,
            ErrorCode::RevisionConflict
        );
        let db = store.db.lock().unwrap();
        let head = db.record_document_head(&target).unwrap().unwrap();
        assert_eq!(head.head_revision, 1);
        assert_eq!(head.projection.body_hash, original.body_hash);
        assert_eq!(
            db.record_metadata_get(&target).unwrap().title.as_deref(),
            Some("Other header")
        );
        assert_eq!(
            db.record_version_capacity(&target).unwrap().version_count,
            1
        );
    }
    #[tokio::test]
    async fn body_save_replays_original_request_without_reconverting_or_overwriting_title() {
        let (_directory, store, mut utility, mut request, target) = setup();
        let initial = RecordDocumentService::new(&store, &utility)
            .head_get(&request, &target)
            .await
            .unwrap();
        utility.projection.document["content"][0]["content"][0]["text"] = json!("Saved正文");
        utility.projection.html = utility.projection.html.replace("Fixture 正文", "Saved正文");
        utility.projection.markdown = utility
            .projection
            .markdown
            .replace("Fixture 正文", "Saved正文");
        utility.projection.text = utility.projection.text.replace("Fixture 正文", "Saved正文");
        utility.projection.body_hash = crate::record_documents::body_hash(
            &utility.projection.document,
            &utility.projection.code_language,
        );
        request.request_id = "save-body".into();
        let input = RecordBodySave {
            target: target.clone(),
            base_revision: initial.head_revision,
            document: utility.projection.document.clone(),
            code_language: utility.projection.code_language.clone(),
            origin: RecordSaveOrigin::Manual,
            edit_session_id: Some("a".repeat(32)),
            metadata: None,
        };
        let service = RecordDocumentService::new(&store, &utility);
        let saved = service.save(&request, &input).await.unwrap();
        assert_eq!(saved.head.head_revision, 2);
        let replay = service.save(&request, &input).await.unwrap();
        assert_eq!(replay.head.head_revision, 2);
        assert_eq!(utility.calls.load(Ordering::Relaxed), 2);
        assert_eq!(
            store
                .db
                .lock()
                .unwrap()
                .record_document_source(&target)
                .unwrap()
                .title
                .as_deref(),
            Some("Keep title")
        );
        let mut other = input.clone();
        other.code_language = Some("python".into());
        assert_eq!(
            service.save(&request, &other).await.unwrap_err().code,
            ErrorCode::IdempotencyConflict
        );
        assert_eq!(utility.calls.load(Ordering::Relaxed), 2);
    }
    #[tokio::test]
    async fn agent_patch_replays_receipt_without_rerunning_the_utility() {
        use crate::agent::{
            models::{ObjectKind, ObjectRef},
            outputs::{BlockEdit, RecordPatch},
        };
        let (_directory, store, mut utility, mut request, target) = setup();
        RecordDocumentService::new(&store, &utility)
            .head_get(&request, &target)
            .await
            .unwrap();
        let expected_block_hash = {
            use sha2::{Digest, Sha256};
            format!(
                "sha256:{:x}",
                Sha256::digest(utility.projection.document["content"][0].to_string())
            )
        };
        utility.projection.document["content"][0]["content"][0]["text"] =
            json!("Fixture 正文 suffix");
        utility.projection.html = utility
            .projection
            .html
            .replace("Fixture 正文", "Fixture 正文 suffix");
        utility.projection.markdown = utility
            .projection
            .markdown
            .replace("Fixture 正文", "Fixture 正文 suffix");
        utility.projection.text = utility
            .projection
            .text
            .replace("Fixture 正文", "Fixture 正文 suffix");
        utility.projection.body_hash = crate::record_documents::body_hash(
            &utility.projection.document,
            &utility.projection.code_language,
        );
        request.caller = Caller::BuiltinRun {
            run_id: "patch-run".into(),
        };
        request.request_id = "patch-1".into();
        let patch = RecordPatch {
            record: ObjectRef {
                workspace_id: request.binding.workspace_id.clone(),
                scope: target.scope.clone(),
                kind: ObjectKind::Record,
                id: target.record_id.to_string(),
            },
            base_revision: 1,
            request_id: request.request_id.clone(),
            operations: vec![BlockEdit::AppendInline {
                block_id: "1".repeat(32),
                expected_block_hash,
                text: " suffix".into(),
            }],
        };
        let service = RecordDocumentService::new(&store, &utility);
        let saved = service.patch(&request, &patch).await.unwrap();
        assert_eq!(saved.after_revision, 2);
        assert!(saved.receipt.undo_available);
        *store.flush_error.lock().unwrap() = Some(ErrorCode::EditorReviewPending);
        let replay = service.patch(&request, &patch).await.unwrap();
        assert_eq!(replay.receipt.operation_id, saved.receipt.operation_id);
        assert_eq!(utility.calls.load(Ordering::Relaxed), 2);
        assert_eq!(store.flush_calls.load(Ordering::Relaxed), 1);
    }
    fn append_patch(
        request: &RequestContext,
        target: &RecordTarget,
        projection: &RecordDocumentProjection,
    ) -> crate::agent::outputs::RecordPatch {
        use crate::agent::outputs::{BlockEdit, RecordPatch};
        use sha2::{Digest, Sha256};
        RecordPatch {
            record: ObjectRef {
                workspace_id: request.binding.workspace_id.clone(),
                scope: target.scope.clone(),
                kind: ObjectKind::Record,
                id: target.record_id.to_string(),
            },
            base_revision: 1,
            request_id: request.request_id.clone(),
            operations: vec![BlockEdit::AppendInline {
                block_id: "1".repeat(32),
                expected_block_hash: format!(
                    "sha256:{:x}",
                    Sha256::digest(projection.document["content"][0].to_string())
                ),
                text: " suffix".into(),
            }],
        }
    }
    fn suffix_projection(projection: &RecordDocumentProjection) -> RecordDocumentProjection {
        let mut result = projection.clone();
        result.document["content"][0]["content"][0]["text"] = json!("Fixture 正文 suffix");
        result.html = result.html.replace("Fixture 正文", "Fixture 正文 suffix");
        result.markdown = result
            .markdown
            .replace("Fixture 正文", "Fixture 正文 suffix");
        result.text = result.text.replace("Fixture 正文", "Fixture 正文 suffix");
        result.body_hash =
            crate::record_documents::body_hash(&result.document, &result.code_language);
        result
    }
    #[tokio::test]
    async fn shared_record_patch_requires_editor_acknowledgement_before_writing() {
        for code in [ErrorCode::EditorReviewPending, ErrorCode::EditorBusy] {
            let (_directory, store, mut utility, mut request, target) = setup();
            RecordDocumentService::new(&store, &utility)
                .head_get(&request, &target)
                .await
                .unwrap();
            request.request_id = "blocked-patch".into();
            request.caller = Caller::BuiltinRun {
                run_id: "run".into(),
            };
            *store.flush_error.lock().unwrap() = Some(code);
            let patch = append_patch(&request, &target, &utility.projection);
            utility.projection = suffix_projection(&utility.projection);
            let service = RecordDocumentService::new(&store, &utility);
            assert_eq!(
                service.patch(&request, &patch).await.unwrap_err().code,
                code
            );
            assert_eq!(store.flush_calls.load(Ordering::Relaxed), 1);
            let db = store.db.lock().unwrap();
            assert_eq!(
                db.record_document_head(&target)
                    .unwrap()
                    .unwrap()
                    .head_revision,
                1
            );
            assert_eq!(
                db.record_version_capacity(&target).unwrap().version_count,
                1
            );
            assert!(db
                .agent_operation_replay::<RecordPatchResult>(
                    &request.caller.key(),
                    &request.request_id,
                    "record.patch",
                    &patch,
                )
                .unwrap()
                .is_none());
        }
    }
    #[tokio::test]
    async fn shared_record_patch_preserves_draft_saved_by_editor_flush() {
        let (_directory, store, mut utility, mut request, target) = setup();
        RecordDocumentService::new(&store, &utility)
            .head_get(&request, &target)
            .await
            .unwrap();
        request.request_id = "patch-after-draft".into();
        let patch = append_patch(&request, &target, &utility.projection);
        let draft = RecordDocumentCommit {
            target: target.clone(),
            base_revision: 1,
            projection: suffix_projection(&utility.projection),
            origin: RecordVersionOrigin::Manual,
            actor: json!({"kind":"gui"}),
            edit_session_id: Some("a".repeat(32)),
        };
        utility.projection = draft.projection.clone();
        let db = store.db.clone();
        *store.on_flush.lock().unwrap() = Some(Box::new(move || {
            db.lock()
                .unwrap()
                .record_document_commit("gui", "editor-flush", &draft, "workspace-test")
                .unwrap();
        }));
        assert_eq!(
            RecordDocumentService::new(&store, &utility)
                .patch(&request, &patch)
                .await
                .unwrap_err()
                .code,
            ErrorCode::RevisionConflict
        );
        let db = store.db.lock().unwrap();
        let current = db.record_document_head(&target).unwrap().unwrap();
        assert_eq!(current.head_revision, 2);
        assert_eq!(current.projection.text, utility.projection.text);
        assert_eq!(
            db.record_version_capacity(&target).unwrap().receipt_count,
            2
        );
        assert!(db
            .agent_operation_replay::<RecordPatchResult>(
                &request.caller.key(),
                &request.request_id,
                "record.patch",
                &patch
            )
            .unwrap()
            .is_none());
    }
    #[tokio::test]
    async fn shared_record_patch_rechecks_workspace_after_editor_flush() {
        let (_directory, store, mut utility, mut request, target) = setup();
        RecordDocumentService::new(&store, &utility)
            .head_get(&request, &target)
            .await
            .unwrap();
        request.request_id = "patch-before-switch".into();
        let patch = append_patch(&request, &target, &utility.projection);
        utility.projection = suffix_projection(&utility.projection);
        let binding = store.binding.clone();
        *store.on_flush.lock().unwrap() = Some(Box::new(move || {
            binding.lock().unwrap().generation = "generation-2".into();
        }));
        assert_eq!(
            RecordDocumentService::new(&store, &utility)
                .patch(&request, &patch)
                .await
                .unwrap_err()
                .code,
            ErrorCode::WorkspaceChanged
        );
        assert_eq!(
            store
                .db
                .lock()
                .unwrap()
                .record_document_head(&target)
                .unwrap()
                .unwrap()
                .head_revision,
            1
        );
    }
    #[tokio::test]
    async fn shared_record_restore_and_quick_note_respect_pending_editor_review() {
        let (_directory, store, utility, mut request, target) = setup();
        request.scope_grant.operations.extend([
            "record.quick_note.write".into(),
            "record.metadata.write".into(),
        ]);
        let service = RecordDocumentService::new(&store, &utility);
        let baseline = service.editor_get(&request, &target).await.unwrap();
        let version = service
            .versions_list(&request, &target, None, 1)
            .unwrap()
            .versions[0]
            .id
            .clone();
        *store.flush_error.lock().unwrap() = Some(ErrorCode::EditorReviewPending);
        request.request_id = "blocked-restore".into();
        let restore = RecordRestoreInput {
            target: target.clone(),
            version_id: version,
            base_revision: 1,
        };
        assert_eq!(
            service.restore(&request, &restore).await.unwrap_err().code,
            ErrorCode::EditorReviewPending
        );
        store
            .db
            .lock()
            .unwrap()
            .workspace_quick_note_upsert(crate::models::WorkspaceQuickNoteUpsertInput {
                markdown: "Captured idea".into(),
                html: "<p>Captured idea</p>".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        request.request_id = "blocked-quick-note".into();
        let transfer = RecordQuickNoteTransfer {
            scope: target.scope.clone(),
            record_id: Some(target.record_id),
            base_revision: Some(1),
            metadata_revision: Some(baseline.metadata.revision),
            expected_markdown: "Captured idea".into(),
            title: None,
            tag_ids: vec![],
        };
        assert_eq!(
            service
                .quick_note_transfer(&request, &transfer)
                .await
                .unwrap_err()
                .code,
            ErrorCode::EditorReviewPending
        );
        assert_eq!(store.flush_calls.load(Ordering::Relaxed), 2);
        let db = store.db.lock().unwrap();
        assert_eq!(
            db.record_document_head(&target)
                .unwrap()
                .unwrap()
                .head_revision,
            1
        );
        assert_eq!(
            db.record_quick_note_source(&target.scope).unwrap().markdown,
            "Captured idea"
        );
        assert_eq!(
            db.record_version_capacity(&target).unwrap().receipt_count,
            1
        );
    }
    #[tokio::test]
    #[ignore = "requires the prepared fixed Node runtime and built Record worker"]
    async fn record_service_runs_real_conversion_save_and_patch_with_one_version_chain() {
        use crate::agent::outputs::{BlockEdit, RecordPatch};
        use sha2::{Digest, Sha256};
        let (_directory, store, _utility, mut request, target) = setup();
        let utility = crate::record_document_worker::RecordDocumentWorker::development().unwrap();
        let service = RecordDocumentService::new(&store, &utility);
        let baseline = service.head_get(&request, &target).await.unwrap();
        let id = baseline.projection.document["content"][0]["attrs"]["blockId"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut document = baseline.projection.document.clone();
        document["content"][0]["content"][0]["text"] = json!("Manual change");
        request.request_id = "actual-save".into();
        let input = RecordBodySave {
            target: target.clone(),
            base_revision: 1,
            document,
            code_language: None,
            origin: RecordSaveOrigin::Manual,
            edit_session_id: Some("b".repeat(32)),
            metadata: None,
        };
        let saved = service.save(&request, &input).await.unwrap();
        assert_eq!(saved.head.head_revision, 2);
        assert_eq!(
            store
                .db
                .lock()
                .unwrap()
                .record_document_head(&saved.head.target)
                .unwrap()
                .unwrap()
                .projection
                .markdown,
            "Manual change"
        );
        request.request_id = "actual-checkpoint".into();
        let checkpoint = service
            .checkpoint(
                &request,
                &RecordCheckpointInput {
                    target: target.clone(),
                    base_revision: 2,
                    reason: crate::record_documents::RecordCheckpointReason::LeaveEditor,
                },
            )
            .unwrap();
        assert!(checkpoint.checkpointed);
        assert_eq!(checkpoint.head.head_revision, 2);
        assert_eq!(
            service.capacity(&request, &target).unwrap().version_count,
            2
        );
        request.caller = Caller::BuiltinRun {
            run_id: "actual-run".into(),
        };
        request.request_id = "actual-patch".into();
        let patch = RecordPatch {
            record: ObjectRef {
                workspace_id: request.binding.workspace_id.clone(),
                scope: target.scope.clone(),
                kind: ObjectKind::Record,
                id: target.record_id.to_string(),
            },
            base_revision: 2,
            request_id: request.request_id.clone(),
            operations: vec![BlockEdit::AppendInline {
                block_id: id.clone(),
                expected_block_hash: format!(
                    "sha256:{:x}",
                    Sha256::digest(
                        store
                            .db
                            .lock()
                            .unwrap()
                            .record_document_head(&saved.head.target)
                            .unwrap()
                            .unwrap()
                            .projection
                            .document["content"][0]
                            .to_string()
                    )
                ),
                text: " with agent".into(),
            }],
        };
        let result = service.patch(&request, &patch).await.unwrap();
        assert_eq!(result.after_revision, 3);
        assert_eq!(
            store
                .db
                .lock()
                .unwrap()
                .record_document_head(&result.head.target)
                .unwrap()
                .unwrap()
                .projection
                .markdown,
            "Manual change with agent"
        );
        assert_eq!(
            store
                .db
                .lock()
                .unwrap()
                .record_document_head(&result.head.target)
                .unwrap()
                .unwrap()
                .projection
                .document["content"][0]["attrs"]["blockId"],
            id
        );
        assert_eq!(
            store
                .db
                .lock()
                .unwrap()
                .record_version_capacity(&target)
                .unwrap()
                .version_count,
            3
        );
        let mut invalid = patch.clone();
        invalid.request_id = "stale-patch".into();
        request.request_id = invalid.request_id.clone();
        assert_eq!(
            service.patch(&request, &invalid).await.unwrap_err().code,
            ErrorCode::RevisionConflict
        );
        assert_eq!(
            store
                .db
                .lock()
                .unwrap()
                .record_document_head(&target)
                .unwrap()
                .unwrap()
                .head_revision,
            3
        );
        let versions = service.versions_list(&request, &target, None, 20).unwrap();
        let baseline_id = versions.versions.last().unwrap().id.clone();
        let difference = service
            .versions_compare(&request, &target, &baseline_id, &versions.versions[0].id)
            .await
            .unwrap();
        assert_eq!(difference.modified, vec![id]);
        assert!(
            difference.added.is_empty()
                && difference.deleted.is_empty()
                && difference.moved.is_empty()
        );
        let historic = service
            .version_get(&request, &target, &baseline_id)
            .await
            .unwrap();
        assert_eq!(historic.projection.document, baseline.projection.document);
        request.request_id = "actual-restore".into();
        let restore = crate::record_documents::RecordRestoreInput {
            target: target.clone(),
            base_revision: 3,
            version_id: baseline_id,
        };
        let restored = service.restore(&request, &restore).await.unwrap();
        assert_eq!(restored.head.head_revision, 4);
        assert_eq!(
            store
                .db
                .lock()
                .unwrap()
                .record_document_head(&restored.head.target)
                .unwrap()
                .unwrap()
                .projection
                .document,
            baseline.projection.document
        );
        assert_eq!(
            store
                .db
                .lock()
                .unwrap()
                .record_document_head(&restored.head.target)
                .unwrap()
                .unwrap()
                .projection
                .markdown,
            "Fixture 正文"
        );
        let flushes = store.flush_calls.load(Ordering::Relaxed);
        *store.flush_error.lock().unwrap() = Some(ErrorCode::EditorReviewPending);
        let retry = service.restore(&request, &restore).await.unwrap();
        assert_eq!(retry.after_version, restored.after_version);
        assert_eq!(store.flush_calls.load(Ordering::Relaxed), flushes);
        assert_eq!(
            service
                .versions_list(&request, &target, None, 20)
                .unwrap()
                .versions
                .len(),
            4
        );
        assert_eq!(
            service.capacity(&request, &target).unwrap().version_count,
            4
        );
    }
}
