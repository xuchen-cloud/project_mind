//! Opt-in development desktop driver for the shared durable source queue.
//! No public source tools, provider calls, or production worker distribution.
use crate::{
    agent::{
        access::{Caller, RequestContext, ScopeGrant},
        errors::{AgentError, AgentResult, ApiResponse, ErrorCode},
        models::{Scope, WorkspaceBinding},
    },
    db::source_maintenance::{MaintenanceAction, MaintenanceProgress},
    source_service::{BoundSourceStore, SourceIndexBudget, SourceService, SourceUtility},
};
use serde::Deserialize;
use tauri::Manager;

fn enabled() -> bool {
    cfg!(debug_assertions)
        && std::env::var("PROJECT_MIND_SOURCE_INDEXING_DEV").as_deref() == Ok("1")
}
pub(crate) fn request(
    binding: WorkspaceBinding,
    scope: &Scope,
    request_id: String,
) -> RequestContext {
    RequestContext {
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: matches!(scope, Scope::Workspace),
            project_ids: match scope {
                Scope::Project { project_id } => vec![*project_id],
                _ => vec![],
            },
            operations: vec!["settings.write".into(), "source.read".into()],
        },
        binding,
        request_id,
        caller: Caller::Gui,
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MaintenanceInput {
    binding: WorkspaceBinding,
    scope: Scope,
    request_id: String,
    /// None reads progress; selection alone never undoes an explicit cancel.
    action: Option<MaintenanceAction>,
}
#[tauri::command]
pub(crate) fn agent_source_maintenance(
    state: tauri::State<'_, crate::AppState>,
    input: MaintenanceInput,
) -> ApiResponse<Option<MaintenanceProgress>> {
    let result = (|| {
        if !enabled() {
            return Err(AgentError::new(
                ErrorCode::RuntimeUnavailable,
                "Source scheduling is available only in explicit development validation",
            ));
        }
        let request = request(input.binding, &input.scope, input.request_id.clone());
        state.with_current(|binding, db| match input.action {
            Some(action) => db
                .source_maintenance_select(
                    &request,
                    binding,
                    &input.scope,
                    action,
                    chrono::Utc::now(),
                )
                .map(Some),
            None => {
                db.source_maintenance_progress(&request, binding, &input.scope, chrono::Utc::now())
            }
        })
    })();
    ApiResponse::from_result(input.request_id, result)
}

/// Execute at most one job. Short database phases precede and follow every
/// await. Dropping conversion kills its utility process; yielding the retained
/// token makes unfinished work immediately retryable without failure attempts.
pub(crate) async fn step<
    S: BoundSourceStore,
    R: crate::record_document_service::DocumentUtility,
    F: SourceUtility,
>(
    store: &S,
    record: &R,
    file: &F,
) -> AgentResult<bool> {
    let selected =
        store.with_current(
            |binding, db| match db.source_maintenance_selected(binding)? {
                Some(scope)
                    if db.source_maintenance_has_work(binding, &scope, chrono::Utc::now())? =>
                {
                    Ok(Some((binding.clone(), scope)))
                }
                _ => Ok(None),
            },
        )?;
    let Some((binding, scope)) = selected else {
        return Ok(false);
    };
    let request = request(
        binding,
        &scope,
        format!("source-maintenance-{:032x}", rand::random::<u128>()),
    );
    let reservation = store.with_current(|binding, db| {
        db.source_maintenance_reserve(&request, binding, &scope, chrono::Utc::now())
    })?;
    let Some(reservation) = reservation else {
        return Ok(false);
    };
    let service = SourceService::new(store);
    let preparation = (|| {
        // Bounded catalogue/log traversal; cursor and enqueue are transactional.
        service.sync_index_queue(&request, &scope)?;
        service.backfill_index_queue(&request, &scope, 100)?;
        store.with_current(|binding, db| {
            db.source_queue_claim(&request, binding, &scope, chrono::Utc::now())
        })
    })();
    let lease = match preparation {
        Ok(Some(lease)) => lease,
        other => {
            store.with_current(|binding, db| {
                db.source_maintenance_settle(&request, binding, &reservation, Some((0, 0)), true)
            })?;
            return other.map(|_| false);
        }
    };
    let result = {
        let future = service.index_claimed(
            &request,
            &lease,
            SourceIndexBudget {
                max_chars: reservation.chars,
                max_chunks: reservation.chunks,
            },
            record,
            file,
        );
        tokio::pin!(future);
        loop {
            tokio::select! {
                biased;
                result=&mut future=>break Some(result),
                _=tokio::time::sleep(std::time::Duration::from_millis(100))=>{
                    if !store.with_current(|binding,db|db.source_maintenance_continue(&request,binding,&reservation,chrono::Utc::now())).unwrap_or(false) {break None;}
                }
            }
        }
    }; // Drop conversion before releasing its durable lease.
    match result {
        Some(result) => {
            // Index coverage counts unique Unicode characters, not model input.
            // Failed/crashed conversions keep their conservative full charge.
            let usage = if result.is_ok() {
                store
                    .with_current(|binding, db| {
                        db.source_maintenance_index_usage(&request, binding, &lease.object)
                    })
                    .ok()
            } else {
                None
            };
            store.with_current(|binding, db| {
                db.source_maintenance_settle(&request, binding, &reservation, usage, false)
            })?;
            result?;
        }
        None => {
            store.with_current(|binding, db| {
                db.source_queue_finish(
                    &request,
                    binding,
                    &lease,
                    crate::db::source_index_queue::SourceIndexOutcome::Yield,
                    chrono::Utc::now(),
                )
            })?;
            // Cancellation refunds no unknown asynchronous work. It is charged
            // conservatively, and never represented as completed coverage.
            store.with_current(|binding, db| {
                db.source_maintenance_settle(&request, binding, &reservation, None, false)
            })?;
        }
    }
    Ok(true)
}

pub(crate) fn start(app: &tauri::AppHandle) {
    if !enabled() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Resolve/stage/hash-check resources serially before processing work.
        let file = match crate::source_extraction_worker::SourceExtractionWorker::for_app(&app) {
            Ok(file) => file,
            Err(error) => {
                eprintln!("Source maintenance unavailable: {:?}", error.code);
                return;
            }
        };
        let record = crate::record_document_service::AppDocumentUtility(app.clone());
        loop {
            let state = app.state::<crate::AppState>();
            if let Err(error) = step(&*state, &record, &file).await {
                if !matches!(
                    error.code,
                    ErrorCode::WorkspaceNotOpen
                        | ErrorCode::WorkspaceChanged
                        | ErrorCode::ScopeDenied
                        | ErrorCode::NotFound
                ) {
                    eprintln!("Source maintenance: {:?}", error.code);
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    });
}
