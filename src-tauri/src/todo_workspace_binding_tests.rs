//! Real SQLite coverage of the production storage gate without application windows.
use super::*;
use crate::models::TodoScope;
use agent::models::WorkspaceBinding;

fn runtime(root: &Path, generation: &str) -> Arc<WorkspaceRuntime> {
    let (metadata, paths) = workspace::create_workspace(root, "test-password").unwrap();
    open_runtime(metadata, paths, generation)
}

fn open_runtime(
    metadata: WorkspaceMetadata,
    paths: WorkspacePaths,
    generation: &str,
) -> Arc<WorkspaceRuntime> {
    let mut db = Database::open(&paths.db_path, &paths.root_path, None).unwrap();
    db.bind_native_workspace(&metadata.workspace_id).unwrap();
    let secret_state = Arc::new(Mutex::new(None));
    let voice_db =
        Database::open_runtime_connection(&paths.db_path, &paths.root_path, None).unwrap();
    Arc::new(WorkspaceRuntime {
        agent_binding: WorkspaceBinding {
            workspace_id: metadata.workspace_id.clone(),
            generation: generation.into(),
        },
        agent_runs: Mutex::new(Default::default()),
        summary: workspace_summary(&paths.root_path, &metadata),
        metadata,
        ai_jobs: AiJobManager::new(
            paths.db_path.clone(),
            paths.root_path.clone(),
            secret_state.clone(),
            1,
            Arc::new(|_| {}),
        ),
        paths,
        secret_state,
        db: Mutex::new(db),
        file_commit_fence: Arc::new(workspace_commit_fence::WorkspaceCommitFence::new()),
        voice_db: Mutex::new(voice_db),
        voice_minutes_worker: Arc::new(voice::processing::MinutesWorker::default()),
        voice_recovery_running: std::sync::atomic::AtomicBool::new(false),
        voice_recovery_interrupt: std::sync::atomic::AtomicBool::new(true),
        voice_diarization_interrupt: std::sync::atomic::AtomicBool::new(true),
        voice_diarization_process: Arc::new(voice::diarization_process::ProcessOwner::default()),
    })
}

fn run<T>(
    current: &Mutex<Option<Arc<WorkspaceRuntime>>>,
    binding: Option<&WorkspaceBinding>,
    task: impl FnOnce(&mut Database) -> Result<T>,
) -> CommandResult<T> {
    let captured = lock_mutex(current)
        .clone()
        .ok_or("no workspace is currently open")?;
    with_bound_db_storage(current, &captured, binding, task)?
        .0
        .map_err(|e| e.to_string())
}

fn create_input(content: &str, tag_id: i64) -> TodoCreateInput {
    TodoCreateInput {
        scope: TodoScope::Workspace,
        project_id: None,
        content: content.into(),
        priority: "not_urgent_important".into(),
        due_date: None,
        tag_ids: vec![tag_id],
    }
}

fn tag_input(id: Option<i64>, label: &str) -> FileTagOptionUpsertInput {
    FileTagOptionUpsertInput {
        project_id: None,
        id,
        label: label.into(),
        color_key: "blue".into(),
    }
}

fn seed(
    current: &Mutex<Option<Arc<WorkspaceRuntime>>>,
    binding: &WorkspaceBinding,
    name: &str,
) -> (i64, TodoRecord) {
    run(current, Some(binding), |db| {
        db.project_create(ProjectCreateInput {
            name: name.into(),
            summary: None,
            status: None,
        })?;
        let tag = db.file_tag_option_upsert(tag_input(None, name))?;
        let todo = db.todo_create(create_input(name, tag.id))?;
        Ok((tag.id, todo))
    })
    .unwrap()
}

fn snapshot(
    current: &Mutex<Option<Arc<WorkspaceRuntime>>>,
    binding: &WorkspaceBinding,
) -> serde_json::Value {
    run(current, Some(binding), |db| {
        Ok(serde_json::json!({
            "page": db.workspace_page_get()?,
            "tags": db.file_tag_settings_get(FileTagSettingsGetInput { project_id: None })?,
        }))
    })
    .unwrap()
}

#[test]
fn stale_a_cannot_read_mutate_delete_or_create_in_real_b_database() {
    let a_root = tempfile::tempdir().unwrap();
    let b_root = tempfile::tempdir().unwrap();
    let a = runtime(a_root.path(), "a-open-1");
    let b = runtime(b_root.path(), "b-open-1");
    let current = Mutex::new(Some(a.clone()));
    let (a_tag, a_todo) = seed(&current, &a.agent_binding, "A");
    let a_before = snapshot(&current, &a.agent_binding);
    *lock_mutex(&current) = Some(b.clone());
    let (b_tag, b_todo) = seed(&current, &b.agent_binding, "B");
    assert_eq!(
        (a_tag, a_todo.id, a_todo.revision),
        (b_tag, b_todo.id, b_todo.revision)
    );
    let before = snapshot(&current, &b.agent_binding);
    macro_rules! rejected {
        ($task:expr) => {{
            let mut entered = false;
            let result = run(&current, Some(&a.agent_binding), |db| {
                entered = true;
                $task(db)
            });
            assert!(result.unwrap_err().contains("Workspace binding changed"));
            assert!(!entered, "stale operation entered storage transaction");
        }};
    }
    rejected!(|db: &mut Database| db.workspace_page_get());
    rejected!(|db: &mut Database| db.projects_list(ProjectsListInput {
        include_archived: Some(false)
    }));
    rejected!(
        |db: &mut Database| db.file_tag_settings_get(FileTagSettingsGetInput { project_id: None })
    );
    rejected!(|db: &mut Database| db.project_page_get(ProjectIdInput { project_id: 1 }));
    rejected!(|db: &mut Database| db.todo_list_open(ProjectIdInput { project_id: 1 }));
    rejected!(
        |db: &mut Database| db.todo_update_status(TodoUpdateStatusInput {
            expected_revision: a_todo.revision,
            todo_id: a_todo.id,
            status: "finished".into()
        })
    );
    rejected!(
        |db: &mut Database| db.todo_update_priority(TodoUpdatePriorityInput {
            expected_revision: a_todo.revision,
            todo_id: a_todo.id,
            priority: "urgent_important".into()
        })
    );
    rejected!(
        |db: &mut Database| db.todo_update_tags(TodoUpdateTagsInput {
            expected_revision: a_todo.revision,
            todo_id: a_todo.id,
            tag_ids: vec![]
        })
    );
    rejected!(
        |db: &mut Database| db.todo_add_progress(TodoAddProgressInput {
            expected_revision: a_todo.revision,
            todo_id: a_todo.id,
            content: "stale progress".into(),
            progress_date: "2026-11-11".into(),
            due_date: None
        })
    );
    rejected!(
        |db: &mut Database| db.todo_update_progress(TodoUpdateProgressInput {
            expected_revision: 1,
            progress_id: 1,
            content: "stale progress".into(),
            progress_date: "2026-11-11".into(),
            due_date: None,
            status: None
        })
    );
    rejected!(
        |db: &mut Database| db.todo_delete_progress(TodoDeleteProgressInput {
            expected_revision: 1,
            progress_id: 1
        })
    );
    rejected!(|db: &mut Database| db.todo_create(create_input("A stale create", a_tag)));
    rejected!(
        |db: &mut Database| db.todo_update_content(TodoUpdateContentInput {
            expected_revision: a_todo.revision,
            todo_id: a_todo.id,
            content: "A stale edit".into(),
            due_date: None,
            tag_ids: vec![a_tag]
        })
    );
    rejected!(|db: &mut Database| db.todo_delete(TodoDeleteInput {
        expected_revision: a_todo.revision,
        todo_id: a_todo.id
    }));
    rejected!(|db: &mut Database| db.file_tag_option_upsert(tag_input(None, "A stale tag")));
    rejected!(
        |db: &mut Database| db.file_tag_option_upsert(tag_input(Some(a_tag), "A stale rename"))
    );
    rejected!(
        |db: &mut Database| db.file_tag_option_delete(FileTagOptionDeleteInput {
            project_id: None,
            tag_id: a_tag
        })
    );
    assert_eq!(snapshot(&current, &b.agent_binding), before);
    // Legacy callers of the shared page commands still have an unbound read.
    assert!(run(&current, None, |db| db.workspace_page_get()).is_ok());
    let updated = run(&current, Some(&b.agent_binding), |db| {
        db.todo_update_content(TodoUpdateContentInput {
            expected_revision: b_todo.revision,
            todo_id: b_todo.id,
            content: "B valid edit".into(),
            due_date: None,
            tag_ids: vec![b_tag],
        })
    })
    .unwrap();
    assert_eq!(updated.content, "B valid edit");
    assert!(updated.revision > b_todo.revision);
    run(&current, Some(&b.agent_binding), |db| {
        db.todo_delete(TodoDeleteInput {
            expected_revision: updated.revision,
            todo_id: updated.id,
        })
    })
    .unwrap();
    run(&current, Some(&b.agent_binding), |db| {
        db.file_tag_option_delete(FileTagOptionDeleteInput {
            project_id: None,
            tag_id: b_tag,
        })
    })
    .unwrap();
    *lock_mutex(&current) = Some(a.clone());
    assert_eq!(snapshot(&current, &a.agent_binding), a_before);
    run(&current, Some(&a.agent_binding), |db| {
        db.todo_update_content(TodoUpdateContentInput {
            expected_revision: a_todo.revision,
            todo_id: a_todo.id,
            content: "A valid edit".into(),
            due_date: None,
            tag_ids: vec![a_tag],
        })
    })
    .unwrap();
}

#[test]
fn reopen_rejects_old_generation_and_worker_captured_before_switch() {
    let root = tempfile::tempdir().unwrap();
    let a = runtime(root.path(), "open-1");
    let current = Mutex::new(Some(a.clone()));
    seed(&current, &a.agent_binding, "A");
    let old_binding = a.agent_binding.clone();
    let metadata = a.metadata.clone();
    let paths = a.paths.clone();
    *lock_mutex(&current) = None;
    drop(a);
    let reopened = open_runtime(metadata, paths, "open-2");
    *lock_mutex(&current) = Some(reopened.clone());
    let before = snapshot(&current, &reopened.agent_binding);
    let result = run(&current, Some(&old_binding), |db| {
        db.todo_create(create_input("old generation", 1))
    });
    assert!(result.unwrap_err().contains("Workspace binding changed"));
    assert_eq!(snapshot(&current, &reopened.agent_binding), before);
    let other_root = tempfile::tempdir().unwrap();
    let b = runtime(other_root.path(), "b");
    *lock_mutex(&current) = Some(b);
    let result = with_bound_db_storage(&current, &reopened, Some(&reopened.agent_binding), |db| {
        db.todo_create(create_input("queued before switch", 1))
    });
    assert!(result.unwrap_err().contains("Workspace changed"));
    *lock_mutex(&current) = Some(reopened.clone());
    assert_eq!(snapshot(&current, &reopened.agent_binding), before);
    seed(&current, &reopened.agent_binding, "Reopened valid");
}

#[tokio::test]
async fn queued_bound_read_keeps_callers_binding_when_worker_runs_after_switch() {
    let a_root = tempfile::tempdir().unwrap();
    let b_root = tempfile::tempdir().unwrap();
    let a = runtime(a_root.path(), "a");
    let b = runtime(b_root.path(), "b");
    let current = Arc::new(Mutex::new(Some(a.clone())));
    seed(&current, &a.agent_binding, "A");
    *lock_mutex(&current) = Some(b.clone());
    seed(&current, &b.agent_binding, "B");
    let before = snapshot(&current, &b.agent_binding);
    *lock_mutex(&current) = Some(a.clone());
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let worker_current = current.clone();
    let worker = tokio::spawn(spawn_bound_db_worker(
        a.agent_binding.clone(),
        move |binding| {
            started_tx.send(()).unwrap();
            release_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap();
            run(&worker_current, Some(binding), |db| db.workspace_page_get())
        },
    ));
    started_rx.await.unwrap();
    *lock_mutex(&current) = Some(b.clone());
    release_tx.send(()).unwrap();
    assert!(worker
        .await
        .unwrap()
        .unwrap_err()
        .contains("Workspace binding changed"));
    assert_eq!(snapshot(&current, &b.agent_binding), before);
    let worker_current = current.clone();
    let page = spawn_bound_db_worker(b.agent_binding.clone(), move |binding| {
        run(&worker_current, Some(binding), |db| db.workspace_page_get())
    })
    .await
    .unwrap();
    assert_eq!(serde_json::to_value(page).unwrap(), before["page"]);
}
