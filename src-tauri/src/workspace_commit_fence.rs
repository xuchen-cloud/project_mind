//! An old Workspace may finish a commit that already entered its mutation
//! boundary. Preparations that arrive after close/switch must not start one.
//! This lock is independent of selection and database locks: File holders must
//! never reenter those locks while another GUI writer waits for the File lease.
use crate::agent::errors::{AgentError, AgentResult, ErrorCode};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, RwLock, RwLockReadGuard};

pub(crate) struct WorkspaceCommitFence {
    active: Arc<RwLock<bool>>,
    connection_enabled: Option<Arc<AtomicBool>>,
}
impl WorkspaceCommitFence {
    pub(crate) fn new() -> Self {
        Self { active: Arc::new(RwLock::new(true)), connection_enabled: None }
    }
    /// File adapters retain the Workspace fence and check the live bridge
    /// switch at the same commit boundary, without taking App/DB locks.
    pub(crate) fn for_connection(&self, enabled: Arc<AtomicBool>) -> Self {
        Self { active: self.active.clone(), connection_enabled: Some(enabled) }
    }
    pub(crate) fn enter(&self) -> AgentResult<RwLockReadGuard<'_, bool>> {
        let active = self
            .active
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !*active {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "File Workspace was closed or reopened",
            ));
        }
        if self.connection_enabled.as_ref().is_some_and(|enabled| !enabled.load(Ordering::Acquire)) {
            return Err(AgentError::new(ErrorCode::RuntimeUnavailable, "External connections are disabled"));
        }
        Ok(active)
    }
    pub(crate) fn invalidate(&self) {
        // A holder has already begun committing: wait for its durable outcome,
        // then reject any prepared operation that has not entered the boundary.
        *self
            .active
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = false;
    }
    #[cfg(test)]
    pub(crate) fn pause_commit(&self) -> std::sync::RwLockWriteGuard<'_, bool> {
        self.active.write().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc};
    #[test]
    fn workspace_commit_fence_settles_entered_commit_before_close() {
        let fence = Arc::new(WorkspaceCommitFence::new());
        let commit = fence.enter().unwrap();
        let worker_fence = fence.clone();
        let (attempt_tx, attempt_rx) = mpsc::channel();
        let (closed_tx, closed_rx) = mpsc::channel();
        let closing = std::thread::spawn(move || {
            attempt_tx.send(()).unwrap();
            worker_fence.invalidate();
            closed_tx.send(()).unwrap();
        });
        attempt_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        assert!(closed_rx
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err());
        drop(commit);
        closed_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        closing.join().unwrap();
        assert_eq!(fence.enter().unwrap_err().code, ErrorCode::WorkspaceChanged);
        fence.invalidate();
    }
}
