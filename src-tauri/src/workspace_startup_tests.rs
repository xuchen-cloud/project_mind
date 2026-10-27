use super::*;
use std::sync::atomic::AtomicUsize;

#[tokio::test(flavor = "current_thread")]
async fn queued_navigation_read_rejects_workspace_switch_or_reopen_with_same_project_id() {
    use crate::{
        agent::models::WorkspaceBinding, require_workspace_binding, spawn_bound_db_worker,
    };
    for changed_workspace in [false, true] {
        let original = WorkspaceBinding {
            workspace_id: "first".into(),
            generation: "open-1".into(),
        };
        // Project IDs alone cannot distinguish these navigation targets.
        let current = Arc::new(Mutex::new((original.clone(), (1_i64, "original project"))));
        let selected = current.clone();
        let reads = Arc::new(AtomicUsize::new(0));
        let worker_reads = reads.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let queued = tokio::spawn(async move {
            spawn_bound_db_worker(original, move |expected| {
                started_tx.send(()).unwrap();
                release_rx
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                let current = lock_mutex(&selected);
                require_workspace_binding(expected, &current.0)?;
                worker_reads.fetch_add(1, Ordering::SeqCst);
                Ok(current.1 .1)
            })
            .await
        });
        started_rx.await.unwrap();
        *lock_mutex(&current) = (
            WorkspaceBinding {
                workspace_id: if changed_workspace { "second" } else { "first" }.into(),
                generation: "open-2".into(),
            },
            (1, "replacement project"),
        );
        release_tx.send(()).unwrap();
        assert!(queued
            .await
            .unwrap()
            .unwrap_err()
            .contains("Workspace binding changed"));
        assert_eq!(reads.load(Ordering::SeqCst), 0);
    }
    let binding = WorkspaceBinding {
        workspace_id: "first".into(),
        generation: "open-1".into(),
    };
    let expected = binding.clone();
    assert_eq!(
        spawn_bound_db_worker(binding, move |actual| {
            require_workspace_binding(&expected, actual)?;
            Ok("unchanged project")
        })
        .await
        .unwrap(),
        "unchanged project"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn manual_action_cancels_pending_automatic_restore() {
    let startup = WorkspaceStartup::default();
    let calls = Arc::new(AtomicUsize::new(0));
    startup.manual(|| async { Ok(()) }).await.unwrap();
    let restore_calls = calls.clone();
    let snapshot = startup
        .status(
            move || async move {
                restore_calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
            || async { Ok("manual workspace") },
        )
        .await
        .unwrap();
    assert_eq!(snapshot, "manual workspace");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn manual_action_retires_automatic_restore_already_waiting_for_transition_lock() {
    let startup = WorkspaceStartup::default();
    let held = startup.0.transition.lock().await;
    let pending = startup.clone();
    let status = tokio::spawn(async move {
        pending
            .status(
                || async { panic!("queued automatic restore was retired") },
                || async { Ok(()) },
            )
            .await
    });
    tokio::task::yield_now().await;
    let explicit = startup.clone();
    let manual = tokio::spawn(async move { explicit.manual(|| async { Ok(()) }).await });
    tokio::task::yield_now().await;
    assert!(!startup.0.restore_pending.load(Ordering::SeqCst));
    drop(held);
    status.await.unwrap().unwrap();
    manual.await.unwrap().unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn inflight_restore_finishes_before_manual_and_manual_wins() {
    let startup = WorkspaceStartup::default();
    let value = Arc::new(Mutex::new("closed"));
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let restoring = startup.clone();
    let auto_value = value.clone();
    let snapshot_value = value.clone();
    let auto = tokio::spawn(async move {
        restoring
            .status(
                move || async move {
                    started_tx.send(()).unwrap();
                    release_rx.await.unwrap();
                    *lock_mutex(&auto_value) = "auto";
                    Ok(())
                },
                move || async move { Ok(*lock_mutex(&snapshot_value)) },
            )
            .await
    });
    started_rx.await.unwrap();
    let manual_value = value.clone();
    let manual_startup = startup.clone();
    let (attempt_tx, attempt_rx) = tokio::sync::oneshot::channel();
    let manual = tokio::spawn(async move {
        attempt_tx.send(()).unwrap();
        manual_startup
            .manual(move || async move {
                assert_eq!(*lock_mutex(&manual_value), "auto");
                *lock_mutex(&manual_value) = "manual";
                Ok(())
            })
            .await
    });
    attempt_rx.await.unwrap();
    assert!(!manual.is_finished());
    assert_eq!(*lock_mutex(&value), "closed");
    release_tx.send(()).unwrap();
    assert_eq!(auto.await.unwrap().unwrap(), "auto");
    manual.await.unwrap().unwrap();
    assert_eq!(*lock_mutex(&value), "manual");
}

#[tokio::test(flavor = "current_thread")]
async fn repeated_status_calls_share_one_completed_restore() {
    let startup = WorkspaceStartup::default();
    let calls = Arc::new(AtomicUsize::new(0));
    let ready = Arc::new(AtomicBool::new(false));
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let restoring = startup.clone();
    let auto_calls = calls.clone();
    let auto_ready = ready.clone();
    let snapshot_ready = ready.clone();
    let first = tokio::spawn(async move {
        restoring
            .status(
                move || async move {
                    auto_calls.fetch_add(1, Ordering::SeqCst);
                    started_tx.send(()).unwrap();
                    release_rx.await.unwrap();
                    auto_ready.store(true, Ordering::SeqCst);
                    Ok(())
                },
                move || async move { Ok(snapshot_ready.load(Ordering::SeqCst)) },
            )
            .await
    });
    started_rx.await.unwrap();
    let waiting = startup.clone();
    let waiting_calls = calls.clone();
    let waiting_ready = ready.clone();
    let second = tokio::spawn(async move {
        waiting
            .status(
                move || async move {
                    waiting_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
                move || async move { Ok(waiting_ready.load(Ordering::SeqCst)) },
            )
            .await
    });
    tokio::task::yield_now().await;
    assert!(!second.is_finished());
    release_tx.send(()).unwrap();
    assert!(first.await.unwrap().unwrap());
    assert!(second.await.unwrap().unwrap());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn restore_error_is_reported_to_all_status_callers_until_manual_action() {
    let startup = WorkspaceStartup::default();
    assert_eq!(
        startup
            .status(
                || async { Err("missing Workspace metadata".into()) },
                || async { Ok(()) }
            )
            .await
            .unwrap_err(),
        "missing Workspace metadata"
    );
    assert_eq!(
        startup
            .status(
                || async { panic!("must not restore twice") },
                || async { Ok(()) }
            )
            .await
            .unwrap_err(),
        "missing Workspace metadata"
    );
    startup.manual(|| async { Ok(()) }).await.unwrap();
    startup
        .status(
            || async { panic!("manual action retired restore") },
            || async { Ok(()) },
        )
        .await
        .unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn cancelling_request_keeps_transition_locked_until_blocking_mutation_finishes() {
    // Both automatic recovery and explicit open/close can outlive an IPC
    // requester. Neither may release serialization while blocking IO runs.
    for automatic in [true, false] {
        let startup = WorkspaceStartup::default();
        let completed = Arc::new(AtomicBool::new(false));
        let worker_completed = completed.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let mutation = move || async move {
            tokio::task::spawn_blocking(move || {
                started_tx.send(()).unwrap();
                release_rx
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                worker_completed.store(true, Ordering::SeqCst);
                Ok(())
            })
            .await
            .unwrap()
        };
        let requester_startup = startup.clone();
        let requester = tokio::spawn(async move {
            if automatic {
                requester_startup
                    .status(mutation, || async { Ok(()) })
                    .await
            } else {
                requester_startup.manual(mutation).await
            }
        });
        started_rx.await.unwrap();
        requester.abort();
        assert!(requester.await.unwrap_err().is_cancelled());

        let waiting_completed = completed.clone();
        let waiting_startup = startup.clone();
        let (attempt_tx, attempt_rx) = tokio::sync::oneshot::channel();
        let waiting = tokio::spawn(async move {
            attempt_tx.send(()).unwrap();
            waiting_startup
                .manual(move || async move {
                    assert!(
                        waiting_completed.load(Ordering::SeqCst),
                        "a following transition overlapped unfinished blocking IO"
                    );
                    Ok(())
                })
                .await
        });
        attempt_rx.await.unwrap();
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        assert!(!completed.load(Ordering::SeqCst));
        release_tx.send(()).unwrap();
        waiting.await.unwrap().unwrap();
    }
}
