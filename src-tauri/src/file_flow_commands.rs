//! Trusted GUI adapters for native owner movement and receipt-bound drop intents.
//! File I/O uses the current Host's runtime connection, outside the AppState DB lock.
use crate::db::{
    file_drop::{DropPrepared, DropResult, DropTarget, SystemTrash},
    file_owner_move::{FileMoveBaseline, FileOwnerMove, FileOwnerMoveResult},
};
use crate::{
    agent::{
        access::{Caller, RequestContext, ScopeGrant},
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef, WorkspaceBinding},
    },
    committed_changes::CommittedChangePublisher,
    file_editor_coordination::OwnerMoved,
    file_version_service::BoundFileCommitStore,
    AppState,
};
use serde::Serialize;
use tauri::{Emitter, Manager, Webview};

fn caller_scope(caller: &Webview, owner: Option<i64>) -> AgentResult<()> {
    crate::project_directory::authorize_caller(caller, owner)
        .map_err(|message| AgentError::new(ErrorCode::ScopeDenied, message))
}

fn gui_request(
    binding: &WorkspaceBinding,
    request_id: &str,
    owners: &[Option<i64>],
    operations: &[&str],
) -> AgentResult<RequestContext> {
    if request_id.is_empty() || request_id.len() > 128 {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Invalid File operation identity",
        ));
    }
    if owners.iter().flatten().any(|id| *id <= 0) {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Invalid File owner",
        ));
    }
    let mut project_ids: Vec<_> = owners.iter().flatten().copied().collect();
    project_ids.sort_unstable();
    project_ids.dedup();
    Ok(RequestContext {
        binding: binding.clone(),
        request_id: request_id.into(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: owners.contains(&None),
            project_ids,
            operations: operations
                .iter()
                .map(|operation| (*operation).into())
                .collect(),
            object_keys: None,
        },
    })
}

async fn native_task<T: Send + 'static>(
    app: tauri::AppHandle,
    binding: WorkspaceBinding,
    request_id: String,
    action: impl FnOnce(&mut crate::db::Database, &WorkspaceBinding, &str) -> AgentResult<T>
        + Send
        + 'static,
) -> AgentResult<T> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let host = state.gui_commit_host(&binding)?;
        let mut db = host.database()?;
        let before = db.committed_change_watermark()?;
        let result = action(&mut db, &binding, &request_id);
        // A notification read/delivery failure cannot replace a committed receipt.
        match db.committed_changes_since(&binding, &request_id, before) {
            Ok(Some(changes)) => state.publish_committed(changes),
            Ok(None) => {}
            Err(error) => eprintln!("File flow notification capture failed: {}", error.message),
        }
        result
    })
    .await
    .unwrap_or_else(|_| {
        Err(AgentError::new(
            ErrorCode::IoFailed,
            "File operation task failed",
        ))
    })
}

#[tauri::command]
pub(crate) async fn file_owner_move_baseline(
    caller: Webview,
    state: tauri::State<'_, AppState>,
    binding: WorkspaceBinding,
    document_id: i64,
    source_owner: Option<i64>,
) -> AgentResult<FileMoveBaseline> {
    caller_scope(&caller, source_owner)?;
    let request_id = format!("move-baseline:{:032x}", rand::random::<u128>());
    native_task(
        state.app_handle.clone(),
        binding,
        request_id,
        move |db, binding, id| {
            let request = gui_request(binding, id, &[source_owner], &["file.move"])?;
            db.file_owner_move_baseline(&request, binding, document_id, source_owner)
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn file_owner_move(
    caller: Webview,
    state: tauri::State<'_, AppState>,
    binding: WorkspaceBinding,
    request_id: String,
    input: FileOwnerMove,
) -> AgentResult<FileOwnerMoveResult> {
    caller_scope(&caller, input.source_owner)?;
    let app = state.app_handle.clone();
    let window = caller.label().to_owned();
    let coordinator = state.file_editors.clone();
    native_task(app.clone(), binding, request_id, move |db, binding, id| {
        let source = file_object(binding, input.document_id, input.source_owner);
        let actual = db
            .agent_resolve_object(&source, &binding.workspace_id)?
            .ok_or_else(|| AgentError::new(ErrorCode::NotFound, "File is no longer present"))?;
        if !coordinator.can_confirm(binding, &source, id, &window)? {
            caller_scope(&caller, crate::db::file_scope::owner(&actual.scope))?;
        }
        let mut request = gui_request(
            binding,
            id,
            &[input.source_owner, input.target_owner],
            &["file.move"],
        )?;
        request.scope_grant.object_keys = Some(vec![
            source.key()?,
            file_object(binding, input.document_id, input.target_owner).key()?,
        ]);
        // A lost IPC response must only replay the durable result; it cannot need
        // the seal already consumed by the original, successful move.
        if let Some(result) = db.file_owner_move_replay(&request, binding, &input)? {
            return Ok(result);
        }
        let guard = coordinator.take(binding, &source, id, &window)?;
        let result = db.file_owner_move(&request, binding, &input)?;
        guard.committed();
        emit_moved(&app, binding, id, source, &result);
        Ok(result)
    })
    .await
}

fn file_object(binding: &WorkspaceBinding, document_id: i64, owner: Option<i64>) -> ObjectRef {
    ObjectRef {
        workspace_id: binding.workspace_id.clone(),
        scope: crate::db::file_scope::scope(owner),
        kind: ObjectKind::File,
        id: document_id.to_string(),
    }
}
fn emit_moved(
    app: &tauri::AppHandle,
    binding: &WorkspaceBinding,
    id: &str,
    source: ObjectRef,
    result: &FileOwnerMoveResult,
) {
    let event = OwnerMoved {
        binding: binding.clone(),
        operation_id: id.into(),
        source,
        target: file_object(binding, result.document_id, result.project_id),
        old_sessions_closed: result.old_sessions_closed,
    };
    if let Err(error) = app.emit("content:owner-moved", event) {
        eprintln!("File move event delivery failed: {error}");
    }
}
fn drop_object(binding: &WorkspaceBinding, target: &DropTarget) -> Option<ObjectRef> {
    match target {
        DropTarget::Update {
            document_id,
            project_id,
            ..
        } => Some(file_object(binding, *document_id, *project_id)),
        _ => None,
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileReplaced {
    binding: WorkspaceBinding,
    operation_id: String,
    object: ObjectRef,
    version_number: i64,
    content_hash: String,
    no_change: bool,
    old_sessions_closed: bool,
}
fn emit_replaced(
    app: &tauri::AppHandle,
    binding: &WorkspaceBinding,
    id: &str,
    object: Option<ObjectRef>,
    result: &DropResult,
) {
    if let Some(object) = object {
        let event = FileReplaced {
            binding: binding.clone(),
            operation_id: id.into(),
            object,
            version_number: result.version_number,
            content_hash: result.content_hash.clone(),
            no_change: result.no_change,
            old_sessions_closed: result.old_sessions_closed,
        };
        if let Err(error) = app.emit("content:file-replaced", event) {
            eprintln!("File replacement event delivery failed: {error}");
        }
    }
}

fn drop_owner(target: &DropTarget) -> Option<i64> {
    match target {
        DropTarget::New { owner, .. } => *owner,
        DropTarget::Update { project_id, .. } => *project_id,
    }
}

#[tauri::command]
pub(crate) async fn file_drop_prepare(
    caller: Webview,
    state: tauri::State<'_, AppState>,
    binding: WorkspaceBinding,
    request_id: String,
    source_path: String,
    target: DropTarget,
) -> AgentResult<DropPrepared> {
    let owner = drop_owner(&target);
    caller_scope(&caller, owner)?;
    let coordinator = state.file_editors.clone();
    let window = caller.label().to_owned();
    native_task(
        state.app_handle.clone(),
        binding,
        request_id,
        move |db, binding, id| {
            let request = gui_request(binding, id, &[owner], &["content.create", "file.update"])?;
            let guard = drop_object(binding, &target)
                .map(|object| coordinator.take(binding, &object, id, &window))
                .transpose()?;
            let result = db.file_drop_prepare(
                &request,
                binding,
                std::path::Path::new(&source_path),
                target,
            )?;
            if let Some(guard) = guard {
                guard.prepared()?;
            }
            Ok(result)
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn file_drop_commit(
    caller: Webview,
    state: tauri::State<'_, AppState>,
    binding: WorkspaceBinding,
    request_id: String,
    intent_id: String,
) -> AgentResult<DropResult> {
    let app = state.app_handle.clone();
    let coordinator = state.file_editors.clone();
    let window = caller.label().to_owned();
    native_task(app.clone(), binding, request_id, move |db, binding, id| {
        // Grant and seal derive from the verified persisted intent, never a new
        // frontend target or an arbitrary cleanup path.
        let target = db.file_drop_target(binding, id, &intent_id)?;
        let owner = drop_owner(&target);
        caller_scope(&caller, owner)?;
        let request = gui_request(binding, id, &[owner], &["content.create", "file.update"])?;
        let object = drop_object(binding, &target);
        if let Some(result) = db.file_drop_committed(&request, binding, &intent_id)? {
            // Receipt confirmation must not reload a later editor or discard its
            // newer unsaved input. Only the original commit emits replacement.
            return Ok(result);
        }
        let guard = object
            .as_ref()
            .map(|object| coordinator.take(binding, object, id, &window))
            .transpose()?;
        let result = db.file_drop_commit(&request, binding, &intent_id, &SystemTrash)?;
        if let Some(guard) = guard {
            guard.committed();
        }
        emit_replaced(&app, binding, id, object, &result);
        Ok(result)
    })
    .await
}
