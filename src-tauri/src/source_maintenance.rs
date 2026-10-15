//! Desktop driver for the shared durable source queue. The persisted scope
//! assistant setting controls indexing; this driver makes no model calls.
use crate::{
    agent::{
        access::{Caller, RequestContext, ScopeGrant},
        errors::{AgentResult, ApiResponse, ErrorCode},
        models::{Scope, WorkspaceBinding},
    },
    db::source_maintenance::{MaintenanceAction, MaintenanceProgress},
    source_service::{BoundSourceStore, SourceIndexBudget, SourceService, SourceUtility},
};
use serde::Deserialize;
use tauri::Manager;

pub(crate) fn request(
    binding: WorkspaceBinding,
    scope: &Scope,
    request_id: String,
) -> RequestContext {
    RequestContext {
        scope_grant: ScopeGrant {
            object_keys: None,
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
    let selected = store.with_current(|binding, db| {
        Ok(db.source_maintenance_next(binding, chrono::Utc::now())?
            .map(|scope| (binding.clone(), scope)))
    })?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::settings::{AgentScopeSettings, SettingsRepository, SettingsUpdate},
        db::Database,
        models::{ProjectCreateInput, TodoCreateInput, TodoScope},
        source_service::SourceSearchInput,
    };
    use serde_json::Value;
    use std::sync::Mutex;

    struct Store {
        db: Mutex<Database>,
        binding: WorkspaceBinding,
    }
    impl crate::committed_changes::CommittedChangePublisher for Store {
        fn publish_committed(&self, _: crate::committed_changes::CommittedChanges) {
            assert!(self.db.try_lock().is_ok());
        }
    }
    impl BoundSourceStore for Store {
        fn with_current<T>(
            &self,
            action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
        ) -> AgentResult<T> {
            action(&self.binding, &self.db.lock().unwrap())
        }
    }
    struct NoUtility;
    impl crate::record_document_service::DocumentUtility for NoUtility {
        async fn request(&self, _: &str, _: &str, _: Value) -> AgentResult<Value> {
            panic!("Native Todo indexing does not need document conversion")
        }
    }
    impl SourceUtility for NoUtility {
        async fn request(&self, _: &str, _: &str, _: &str, _: &[u8]) -> AgentResult<Value> {
            panic!("Native Todo indexing does not need File extraction")
        }
    }
    fn add_todo(db: &mut Database, content: &str) {
        db.todo_create(TodoCreateInput {
            scope: TodoScope::Workspace,
            project_id: None,
            content: content.into(),
            priority: "not_urgent_important".into(),
            due_date: None,
            tag_ids: vec![],
        })
        .unwrap();
    }
    fn add_project_todo(db: &mut Database, project_id: i64, content: &str) {
        db.todo_create(TodoCreateInput {
            scope: TodoScope::Project,
            project_id: Some(project_id),
            content: content.into(),
            priority: "not_urgent_important".into(),
            due_date: None,
            tag_ids: vec![],
        }).unwrap();
    }
    fn set_enabled(db: &Database, enabled: bool, request_id: &str) {
        let mut settings = db.agent_settings_get(&Scope::Workspace).unwrap();
        let revision = settings.revision;
        settings.enabled = enabled;
        db.agent_settings_update(
            "gui",
            request_id,
            &SettingsUpdate {
                settings,
                expected_revision: revision,
            },
        )
        .unwrap();
    }
    fn progress(store: &Store, request: &RequestContext) -> MaintenanceProgress {
        store
            .with_current(|binding, db| {
                db.source_maintenance_progress(
                    request,
                    binding,
                    &Scope::Workspace,
                    chrono::Utc::now(),
                )
            })
            .unwrap()
            .unwrap()
    }
    #[tokio::test]
    async fn source_maintenance_production_setting_controls_real_indexing_and_preserves_cancel() {
        let root = tempfile::tempdir().unwrap();
        let mut db =
            Database::open(&root.path().join("maintenance.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("maintenance-workspace").unwrap();
        add_todo(&mut db, "Enabled evidence");
        let binding = WorkspaceBinding {
            workspace_id: "maintenance-workspace".into(),
            generation: "generation-1".into(),
        };
        let request = request(binding.clone(), &Scope::Workspace, "select".into());
        db.source_maintenance_select(
            &request,
            &binding,
            &Scope::Workspace,
            MaintenanceAction::Activate,
            chrono::Utc::now(),
        )
        .unwrap();
        assert_eq!(
            db.agent_settings_get(&Scope::Workspace).unwrap(),
            AgentScopeSettings::defaults(Scope::Workspace)
        );
        let store = Store {
            db: Mutex::new(db),
            binding,
        };
        assert!(!step(&store, &NoUtility, &NoUtility).await.unwrap());
        assert_eq!(progress(&store, &request).attempted_jobs, 0);
        assert_eq!(progress(&store, &request).charged_chars, 0);
        assert_eq!(progress(&store, &request).pending_jobs, 0);

        set_enabled(&store.db.lock().unwrap(), true, "enable");
        assert!(step(&store, &NoUtility, &NoUtility).await.unwrap());
        let search = SourceSearchInput {
            scope: Scope::Workspace,
            query: "evidence".into(),
            kinds: vec![],
            selected: vec![],
            include_history: false,
            limit: None,
            budget_chars: None,
        };
        assert_eq!(
            SourceService::new(&store)
                .search(&request, &search)
                .await
                .unwrap()
                .items
                .len(),
            1
        );

        set_enabled(&store.db.lock().unwrap(), false, "disable");
        add_todo(&mut store.db.lock().unwrap(), "Deferred evidence");
        let jobs = progress(&store, &request).attempted_jobs;
        let charged = progress(&store, &request).charged_chars;
        assert!(!step(&store, &NoUtility, &NoUtility).await.unwrap());
        assert_eq!(progress(&store, &request).attempted_jobs, jobs);
        assert_eq!(progress(&store, &request).charged_chars, charged);
        let mut deferred = search;
        deferred.query = "Deferred".into();
        assert!(SourceService::new(&store)
            .search(&request, &deferred)
            .await
            .unwrap()
            .items
            .is_empty());

        set_enabled(&store.db.lock().unwrap(), true, "reenable");
        assert!(step(&store, &NoUtility, &NoUtility).await.unwrap());
        assert_eq!(
            SourceService::new(&store)
                .search(&request, &deferred)
                .await
                .unwrap()
                .items
                .len(),
            1
        );
        store
            .with_current(|binding, db| {
                db.source_maintenance_select(
                    &request,
                    binding,
                    &Scope::Workspace,
                    MaintenanceAction::Cancel,
                    chrono::Utc::now(),
                )?;
                db.source_maintenance_select(
                    &request,
                    binding,
                    &Scope::Workspace,
                    MaintenanceAction::Activate,
                    chrono::Utc::now(),
                )
            })
            .unwrap();
        assert!(progress(&store, &request).cancelled);
        assert!(!step(&store, &NoUtility, &NoUtility).await.unwrap());
    }
    #[tokio::test]
    async fn workspace_enable_indexes_direct_and_unenabled_project_without_page_activation() {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("maintenance.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("w").unwrap();
        let project_id = db.project_create(ProjectCreateInput { name: "Project".into(), summary: None, status: None }).unwrap().id;
        let project = Scope::Project { project_id };
        add_todo(&mut db, "Direct alpha");
        add_project_todo(&mut db, project_id, "Project beta");
        let binding = WorkspaceBinding { workspace_id: "w".into(), generation: "g1".into() };
        let store = Store { db: Mutex::new(db), binding: binding.clone() };
        set_enabled(&store.db.lock().unwrap(), true, "enable");
        assert!(!store.db.lock().unwrap().agent_settings_get(&project).unwrap().enabled);
        assert!(step(&store, &NoUtility, &NoUtility).await.unwrap());
        assert_eq!(store.with_current(|b, db| db.source_maintenance_selected(b)).unwrap(), Some(Scope::Workspace));
        assert!(step(&store, &NoUtility, &NoUtility).await.unwrap());
        assert_eq!(store.with_current(|b, db| db.source_maintenance_selected(b)).unwrap(), Some(project.clone()));
        for _ in 0..12 {
            let request = request(binding.clone(), &project, "search-project".into());
            let found = SourceService::new(&store).search(&request, &SourceSearchInput {
                scope: project.clone(), query: "Project beta".into(), kinds: vec![], selected: vec![],
                include_history: false, limit: None, budget_chars: None,
            }).await.unwrap().items.len();
            if found == 1 { break; }
            assert!(step(&store, &NoUtility, &NoUtility).await.unwrap());
        }
        for (scope, query) in [(Scope::Workspace, "Direct alpha"), (project.clone(), "Project beta")] {
            let request = request(binding.clone(), &scope, "search".into());
            let result = SourceService::new(&store).search(&request, &SourceSearchInput {
                scope, query: query.into(), kinds: vec![], selected: vec![],
                include_history: false, limit: None, budget_chars: None,
            }).await.unwrap();
            assert_eq!(result.items.len(), 1);
        }
        assert!(!store.db.lock().unwrap().agent_settings_get(&project).unwrap().enabled);
    }
    #[tokio::test]
    async fn cancelling_one_scope_leaves_other_scope_running_and_survives_reopen() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("maintenance.sqlite");
        let mut db = Database::open(&path, root.path(), None).unwrap();
        db.bind_native_workspace("w").unwrap();
        let project_id = db.project_create(ProjectCreateInput { name: "Project".into(), summary: None, status: None }).unwrap().id;
        let project = Scope::Project { project_id };
        add_todo(&mut db, "Direct paused");
        add_project_todo(&mut db, project_id, "Project active");
        let binding = WorkspaceBinding { workspace_id: "w".into(), generation: "g1".into() };
        let workspace_request = request(binding.clone(), &Scope::Workspace, "cancel".into());
        set_enabled(&db, true, "enable");
        db.source_maintenance_select(&workspace_request, &binding, &Scope::Workspace, MaintenanceAction::Cancel, chrono::Utc::now()).unwrap();
        let store = Store { db: Mutex::new(db), binding: binding.clone() };
        assert!(step(&store, &NoUtility, &NoUtility).await.unwrap());
        assert_eq!(store.with_current(|b, db| db.source_maintenance_selected(b)).unwrap(), Some(project.clone()));
        for _ in 0..12 {
            if !step(&store, &NoUtility, &NoUtility).await.unwrap() { break; }
            assert_eq!(store.with_current(|b, db| db.source_maintenance_selected(b)).unwrap(), Some(project.clone()));
        }
        drop(store);
        let mut reopened = Database::open(&path, root.path(), None).unwrap();
        reopened.bind_native_workspace("w").unwrap();
        let store = Store { db: Mutex::new(reopened), binding: WorkspaceBinding { workspace_id: "w".into(), generation: "g2".into() } };
        let reopened_request = request(store.binding.clone(), &Scope::Workspace, "reopen".into());
        assert!(progress(&store, &reopened_request).cancelled);
        assert_ne!(store.with_current(|b, db| db.source_maintenance_next(b, chrono::Utc::now())).unwrap(), Some(Scope::Workspace));
    }
}
