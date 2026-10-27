//! Serialize lazy startup restoration with explicit Workspace transitions.
use crate::{lock_mutex, CommandResult};
use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

#[derive(Clone)]
pub(crate) struct WorkspaceStartup(Arc<StartupState>);

struct StartupState {
    transition: tokio::sync::Mutex<()>,
    restore_pending: AtomicBool,
    restore_error: Mutex<Option<String>>,
}

impl Default for WorkspaceStartup {
    fn default() -> Self {
        Self(Arc::new(StartupState {
            transition: tokio::sync::Mutex::new(()),
            restore_pending: AtomicBool::new(true),
            restore_error: Mutex::new(None),
        }))
    }
}

impl WorkspaceStartup {
    pub(crate) async fn status<T, R, RF, S, SF>(&self, restore: R, snapshot: S) -> CommandResult<T>
    where
        T: Send + 'static,
        R: FnOnce() -> RF + Send + 'static,
        RF: Future<Output = CommandResult<()>> + Send + 'static,
        S: FnOnce() -> SF + Send + 'static,
        SF: Future<Output = CommandResult<T>> + Send + 'static,
    {
        let state = self.0.clone();
        // Keep the lock until blocking IO completes even if the requesting
        // command future is dropped. Dropping this handle does not stop the task.
        tokio::spawn(async move {
            let _transition = state.transition.lock().await;
            if state.restore_pending.swap(false, Ordering::SeqCst) {
                if let Err(error) = restore().await {
                    *lock_mutex(&state.restore_error) = Some(error);
                }
            }
            let error = lock_mutex(&state.restore_error).clone();
            if let Some(error) = error {
                return Err(error);
            }
            snapshot().await
        })
        .await
        .map_err(|error| error.to_string())?
    }

    pub(crate) async fn manual<T, C, CF>(&self, change: C) -> CommandResult<T>
    where
        T: Send + 'static,
        C: FnOnce() -> CF + Send + 'static,
        CF: Future<Output = CommandResult<T>> + Send + 'static,
    {
        // Retire a restore that has not started before joining the transition
        // queue. An already running restore completes before this manual action.
        self.0.restore_pending.store(false, Ordering::SeqCst);
        let state = self.0.clone();
        tokio::spawn(async move {
            let _transition = state.transition.lock().await;
            *lock_mutex(&state.restore_error) = None;
            change().await
        })
        .await
        .map_err(|error| error.to_string())?
    }
}

#[cfg(test)]
#[path = "workspace_startup_tests.rs"]
mod tests;
