//! G13 Record-only owner moves. Integration owns handler/schema-version wiring.
use crate::{
    agent::{
        access::{Caller, RequestContext, ScopeGrant},
        errors::{AgentError, AgentResult, ApiResponse, ErrorCode},
        models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
    },
    record_document_service::{BoundRecordStore, DocumentUtility},
    record_documents::{RecordDocumentProjection, RecordTarget},
};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordOwnerMoveInput {
    pub source: RecordTarget,
    pub destination: Scope,
    pub head_revision: u64,
    pub body_hash: String,
    pub metadata_revision: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordOwnerMoveResult {
    pub logical_id: String,
    pub source: RecordTarget,
    pub target: RecordTarget,
    pub operation_id: String,
    pub head_revision: u64,
    pub body_hash: String,
    pub metadata_revision: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordLocation {
    pub logical_id: Option<String>,
    pub target: RecordTarget,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnerMoveReleased {
    pub binding: WorkspaceBinding,
    pub operation_id: String,
    pub source: ObjectRef,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnerMoved {
    pub binding: WorkspaceBinding,
    pub operation_id: String,
    pub source: ObjectRef,
    pub target: ObjectRef,
    pub old_sessions_closed: bool,
}
fn object(binding: &WorkspaceBinding, target: &RecordTarget) -> ObjectRef {
    ObjectRef {
        workspace_id: binding.workspace_id.clone(),
        scope: target.scope.clone(),
        kind: ObjectKind::Record,
        id: target.record_id.to_string(),
    }
}
pub(crate) trait BoundRecordMoveStore: BoundRecordStore {
    fn seal_owner_move(
        &self,
        binding: &WorkspaceBinding,
        target: &RecordTarget,
        request_id: &str,
    ) -> AgentResult<crate::record_editor_coordination::RecordOwnerMoveSeal>;
    fn publish_move_released(&self, event: OwnerMoveReleased);
    fn publish_moved(&self, event: OwnerMoved);
    fn editor_stamp(
        &self,
        binding: &WorkspaceBinding,
        target: &RecordTarget,
    ) -> AgentResult<Vec<String>>;
    fn with_editor_stamp<T>(
        &self,
        binding: &WorkspaceBinding,
        target: &RecordTarget,
        stamp: &[String],
        action: impl FnOnce() -> AgentResult<T>,
    ) -> AgentResult<T>;
}
/// Cancellation/errors release only this target, after releasing its native seal.
struct MoveLifecycle<'a, S: BoundRecordMoveStore> {
    store: &'a S,
    seal: Option<crate::record_editor_coordination::RecordOwnerMoveSeal>,
    release: OwnerMoveReleased,
    succeeded: bool,
}
impl<S: BoundRecordMoveStore> Drop for MoveLifecycle<'_, S> {
    fn drop(&mut self) {
        drop(self.seal.take());
        if !self.succeeded {
            self.store.publish_move_released(self.release.clone());
        }
    }
}
pub(crate) struct RecordOwnerMoveService<'a, S, W> {
    pub store: &'a S,
    pub utility: &'a W,
}
impl<S: BoundRecordMoveStore, W: DocumentUtility> RecordOwnerMoveService<'_, S, W> {
    pub(crate) async fn move_record(
        &self,
        request: &RequestContext,
        input: &RecordOwnerMoveInput,
    ) -> AgentResult<RecordOwnerMoveResult> {
        if let Some(result) = self
            .store
            .with_current(|binding, db| db.record_owner_move_replay(request, binding, input))?
        {
            return Ok(result);
        }
        self.store.with_current(|binding, db| {
            db.record_owner_move_prepare(request, binding, input)
                .map(|_| ())
        })?;
        let seal =
            self.store
                .seal_owner_move(&request.binding, &input.source, &request.request_id)?;
        let mut lifecycle = MoveLifecycle {
            store: self.store,
            seal: Some(seal),
            release: OwnerMoveReleased {
                binding: request.binding.clone(),
                operation_id: request.request_id.clone(),
                source: object(&request.binding, &input.source),
            },
            succeeded: false,
        };
        let outcome: AgentResult<_> = async {
            let stamp = self.store.editor_stamp(&request.binding, &input.source)?;
            // Only this object's registered windows. No owner lease/fence/SQL across this await.
            self.store
                .flush_editors(&request.binding, &input.source)
                .await?;
            let _submission = self
                .store
                .submission_lock(&request.binding, &input.source)
                .await?;
            let plan = self.store.with_current(|binding, db| {
                db.record_owner_move_prepare(request, binding, input)
            })?;
            let converted = if plan.needs_projection {
                let value = self
                    .utility
                    .request(
                        &request.request_id,
                        "record.validate",
                        json!({"document":plan.document,"codeLanguage":plan.code_language}),
                    )
                    .await?;
                let projection: RecordDocumentProjection =
                    serde_json::from_value(value).map_err(|_| {
                        AgentError::new(
                            ErrorCode::RuntimeIncompatible,
                            "Invalid canonical Tag mapping result",
                        )
                    })?;
                projection.validate()?;
                Some(projection)
            } else {
                None
            };
            let (result, changes) =
                self.store
                    .with_editor_stamp(&request.binding, &input.source, &stamp, || {
                        self.store.with_current(|binding, db| {
                            crate::committed_changes::capture_committed(
                                binding,
                                db,
                                &request.request_id,
                                || {
                                    db.record_owner_move_commit(
                                        request,
                                        binding,
                                        input,
                                        &plan,
                                        converted.as_ref(),
                                    )
                                },
                            )
                        })
                    })?;
            result.map(|result| (result, changes))
        }
        .await;
        let (result, changes) = outcome?;
        lifecycle.succeeded = true;
        drop(lifecycle);
        if let Some(changes) = changes {
            self.store.publish_committed(changes);
        }
        self.store.publish_moved(OwnerMoved {
            binding: request.binding.clone(),
            operation_id: request.request_id.clone(),
            source: object(&request.binding, &result.source),
            target: object(&request.binding, &result.target),
            old_sessions_closed: false,
        });
        Ok(result)
    }
}
impl BoundRecordMoveStore for crate::AppState {
    fn seal_owner_move(
        &self,
        binding: &WorkspaceBinding,
        target: &RecordTarget,
        request_id: &str,
    ) -> AgentResult<crate::record_editor_coordination::RecordOwnerMoveSeal> {
        self.record_editors
            .seal_owner_move(binding, target, request_id)
    }
    fn publish_move_released(&self, event: OwnerMoveReleased) {
        use tauri::Emitter;
        if let Err(error) = self.app_handle.emit("content:owner-move-released", event) {
            eprintln!("Record move release notification failed: {error}");
        }
    }
    fn publish_moved(&self, event: OwnerMoved) {
        use tauri::Emitter;
        if let Err(error) = self.app_handle.emit("content:owner-moved", event) {
            eprintln!("Record move notification failed: {error}");
        }
    }
    fn editor_stamp(
        &self,
        binding: &WorkspaceBinding,
        target: &RecordTarget,
    ) -> AgentResult<Vec<String>> {
        self.record_editors.move_registration_stamp(binding, target)
    }
    fn with_editor_stamp<T>(
        &self,
        binding: &WorkspaceBinding,
        target: &RecordTarget,
        stamp: &[String],
        action: impl FnOnce() -> AgentResult<T>,
    ) -> AgentResult<T> {
        self.record_editors
            .with_move_registration_stamp(binding, target, stamp, action)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordOwnerMoveCommandInput {
    binding: WorkspaceBinding,
    request_id: String,
    data: RecordOwnerMoveInput,
}
/// Source-window authority comes from the frozen flow. A matching receipt is read-only;
/// fresh aliases cannot turn that flow into a capability for the new owner.
pub(crate) fn gui_move_request(
    binding: &WorkspaceBinding,
    request_id: &str,
    input: &RecordOwnerMoveInput,
    authorize_origin: impl FnOnce(&Scope) -> AgentResult<()>,
    resolve_source: impl FnOnce() -> AgentResult<(RecordTarget, bool)>,
) -> AgentResult<RequestContext> {
    authorize_origin(&input.source.scope)?;
    let (actual, has_receipt) = resolve_source()?;
    if !has_receipt && actual.key()? != input.source.key()? {
        return Err(AgentError::new(
            ErrorCode::SourceChanged,
            "Record has moved; reopen its current location",
        )
        .with_details(json!({"target":actual})));
    }
    let source_key = actual.object_key(&binding.workspace_id)?;
    let mut scopes = vec![input.source.scope.clone(), input.destination.clone()];
    scopes.dedup();
    Ok(RequestContext {
        binding: binding.clone(),
        request_id: request_id.into(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: scopes.contains(&Scope::Workspace),
            project_ids: scopes
                .iter()
                .filter_map(|s| match s {
                    Scope::Project { project_id } => Some(*project_id),
                    _ => None,
                })
                .collect(),
            operations: vec!["record.move".into()],
            object_keys: Some(vec![source_key]),
        },
    })
}
#[tauri::command]
pub(crate) async fn record_owner_move(
    state: tauri::State<'_, crate::AppState>,
    caller: tauri::Webview,
    input: RecordOwnerMoveCommandInput,
) -> Result<ApiResponse<RecordOwnerMoveResult>, String> {
    let result = async {
        let request = gui_move_request(
            &input.binding,
            &input.request_id,
            &input.data,
            |scope| {
                let project = match scope {
                    Scope::Workspace => None,
                    Scope::Project { project_id } => Some(*project_id),
                };
                crate::project_directory::authorize_caller(&caller, project)
                    .map_err(|message| AgentError::new(ErrorCode::ScopeDenied, message))
            },
            || {
                crate::record_document_service::BoundRecordStore::with_current(
                    &*state,
                    |binding, db| {
                        if *binding != input.binding {
                            return Err(AgentError::new(
                                ErrorCode::WorkspaceChanged,
                                "Workspace binding is no longer current",
                            ));
                        }
                        let actual = db.record_resolve_location(&input.data.source)?.target;
                        let has_receipt = db.record_owner_move_gui_receipt_exists(
                            binding,
                            &input.request_id,
                            &input.data,
                        )?;
                        Ok((actual, has_receipt))
                    },
                )
            },
        )?;
        let utility = crate::record_document_service::AppDocumentUtility(state.app_handle.clone());
        RecordOwnerMoveService {
            store: &*state,
            utility: &utility,
        }
        .move_record(&request, &input.data)
        .await
    }
    .await;
    Ok(ApiResponse::from_result(input.request_id, result))
}
