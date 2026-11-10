//! A move freezes only the registered instances of one File until its terminal event.
use crate::agent::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, WorkspaceBinding},
};
use futures_util::{stream::FuturesUnordered, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::oneshot;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileEditorRegistration {
    pub object: ObjectRef,
    pub editor_id: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileEditorFlushRequest {
    pub binding: WorkspaceBinding,
    pub object: ObjectRef,
    pub editor_id: String,
    pub flush_id: String,
    pub operation_id: String,
    #[serde(skip)]
    pub window: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileEditorFlushReply {
    pub object: ObjectRef,
    pub editor_id: String,
    pub flush_id: String,
    pub outcome: FileEditorFlushOutcome,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FileEditorFlushOutcome {
    Saved,
    Busy,
    Failed,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnerMoveReleased {
    pub binding: WorkspaceBinding,
    pub operation_id: String,
    pub source: ObjectRef,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnerMoved {
    pub binding: WorkspaceBinding,
    pub operation_id: String,
    pub source: ObjectRef,
    pub target: ObjectRef,
    pub old_sessions_closed: bool,
}
struct Editor {
    binding: WorkspaceBinding,
    object: ObjectRef,
    window: String,
}
struct Pending {
    request: FileEditorFlushRequest,
    sender: oneshot::Sender<FileEditorFlushOutcome>,
}
#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Preparing,
    Prepared,
    Moving,
}
struct Seal {
    event: OwnerMoveReleased,
    window: String,
    phase: Phase,
    nonce: String,
    release: Arc<dyn Fn(OwnerMoveReleased) + Send + Sync>,
}
#[derive(Default)]
struct Registry {
    editors: BTreeMap<String, Editor>,
    pending: HashMap<String, Pending>,
    seals: HashMap<String, Seal>,
}
#[derive(Default)]
pub(crate) struct FileEditorCoordinator {
    registry: Mutex<Registry>,
}
fn denied(message: &str) -> AgentError {
    AgentError::new(ErrorCode::ScopeDenied, message)
}
fn busy(message: &str) -> AgentError {
    AgentError::new(ErrorCode::EditorBusy, message)
}
fn key(binding: &WorkspaceBinding, object: &ObjectRef) -> AgentResult<String> {
    if object.kind != ObjectKind::File || object.workspace_id != binding.workspace_id {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Expected a File in the bound Workspace",
        ));
    }
    Ok(format!("{}:{}", binding.generation, object.key()?))
}
fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|x| x.is_ascii_hexdigit())
}
impl FileEditorCoordinator {
    pub(crate) fn register(
        &self,
        binding: &WorkspaceBinding,
        window: &str,
        input: &FileEditorRegistration,
    ) -> AgentResult<()> {
        let target = key(binding, &input.object)?;
        if !valid_id(&input.editor_id) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid File editor identity",
            ));
        }
        let mut registry = crate::lock_mutex(&self.registry);
        if registry.seals.contains_key(&target) {
            return Err(busy("File is being moved; retry opening after the move"));
        }
        if registry.editors.get(&input.editor_id).is_some_and(|e| {
            e.binding != *binding || e.window != window || e.object != input.object
        }) {
            return Err(denied(
                "File editor identity belongs to another registration",
            ));
        }
        registry.editors.insert(
            input.editor_id.clone(),
            Editor {
                binding: binding.clone(),
                object: input.object.clone(),
                window: window.into(),
            },
        );
        Ok(())
    }
    pub(crate) fn unregister(
        &self,
        binding: &WorkspaceBinding,
        window: &str,
        input: &FileEditorRegistration,
    ) -> AgentResult<()> {
        key(binding, &input.object)?;
        let mut registry = crate::lock_mutex(&self.registry);
        if let Some(e) = registry.editors.get(&input.editor_id) {
            if e.binding != *binding || e.window != window || e.object != input.object {
                return Err(denied(
                    "File editor cleanup belongs to another registration",
                ));
            }
            registry.editors.remove(&input.editor_id);
        }
        Ok(())
    }
    pub(crate) fn reply(
        &self,
        binding: &WorkspaceBinding,
        window: &str,
        input: &FileEditorFlushReply,
    ) -> AgentResult<()> {
        key(binding, &input.object)?;
        let mut registry = crate::lock_mutex(&self.registry);
        let Some(p) = registry.pending.get(&input.flush_id) else {
            return Ok(());
        };
        if p.request.binding != *binding
            || p.request.window != window
            || p.request.object != input.object
            || p.request.editor_id != input.editor_id
        {
            return Err(denied("File flush reply belongs to another editor"));
        }
        if let Some(p) = registry.pending.remove(&input.flush_id) {
            let _ = p.sender.send(input.outcome);
        }
        Ok(())
    }
    fn remove(
        &self,
        target: &str,
        operation: &str,
        nonce: Option<&str>,
        allow_moving: bool,
        notify: bool,
    ) -> bool {
        let seal = {
            let mut registry = crate::lock_mutex(&self.registry);
            let Some(seal) = registry.seals.get(target) else {
                return false;
            };
            if seal.event.operation_id != operation
                || nonce.is_some_and(|nonce| nonce != seal.nonce)
                || (!allow_moving && seal.phase == Phase::Moving)
            {
                return false;
            }
            let event = seal.event.clone();
            registry.pending.retain(|_, p| {
                !(p.request.binding == event.binding
                    && p.request.object == event.source
                    && p.request.operation_id == operation)
            });
            registry.seals.remove(target)
        };
        if let Some(seal) = seal {
            if notify {
                (seal.release)(seal.event);
            }
            return true;
        }
        false
    }
    pub(crate) fn release(
        &self,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
        operation: &str,
        window: &str,
    ) -> AgentResult<()> {
        let target = key(binding, object)?;
        let nonce = {
            let registry = crate::lock_mutex(&self.registry);
            if let Some(seal) = registry.seals.get(&target) {
                if seal.event.operation_id != operation || seal.window != window {
                    return Err(denied(
                        "Move cancellation belongs to another window or operation",
                    ));
                }
                if seal.phase == Phase::Moving {
                    return Err(busy("Native File move is already in progress"));
                }
                seal.nonce.clone()
            } else {
                return Ok(());
            }
        };
        self.remove(&target, operation, Some(&nonce), false, true);
        Ok(())
    }
    pub(crate) fn take(
        self: &Arc<Self>,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
        operation: &str,
        window: &str,
    ) -> AgentResult<FileMoveGuard> {
        let target = key(binding, object)?;
        let mut registry = crate::lock_mutex(&self.registry);
        let seal = registry
            .seals
            .get_mut(&target)
            .ok_or_else(|| busy("Prepare the File editors before moving"))?;
        if seal.event.operation_id != operation || seal.window != window {
            return Err(denied(
                "Prepared File move belongs to another window or operation",
            ));
        }
        if seal.phase != Phase::Prepared {
            return Err(busy("File editors have not finished saving"));
        }
        seal.phase = Phase::Moving;
        Ok(FileMoveGuard {
            coordinator: self.clone(),
            target,
            operation: operation.into(),
            nonce: seal.nonce.clone(),
            notify: true,
        })
    }
    pub(crate) async fn prepare(
        self: &Arc<Self>,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
        operation: &str,
        window: &str,
        live_windows: &HashSet<String>,
        emit: impl Fn(&FileEditorFlushRequest) -> AgentResult<()>,
        release: Arc<dyn Fn(OwnerMoveReleased) + Send + Sync>,
    ) -> AgentResult<()> {
        self.prepare_timeout(
            binding,
            object,
            operation,
            window,
            live_windows,
            Duration::from_secs(15),
            Duration::from_secs(60),
            emit,
            release,
        )
        .await
    }
    async fn prepare_timeout(
        self: &Arc<Self>,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
        operation: &str,
        window: &str,
        live_windows: &HashSet<String>,
        timeout: Duration,
        expiry: Duration,
        emit: impl Fn(&FileEditorFlushRequest) -> AgentResult<()>,
        release: Arc<dyn Fn(OwnerMoveReleased) + Send + Sync>,
    ) -> AgentResult<()> {
        let target = key(binding, object)?;
        if operation.is_empty() || operation.len() > 128 {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid File move identity",
            ));
        }
        let nonce = format!("{:032x}", rand::random::<u128>());
        let (requests, receivers) = {
            let mut registry = crate::lock_mutex(&self.registry);
            if let Some(seal) = registry.seals.get(&target) {
                if seal.event.operation_id == operation
                    && seal.window == window
                    && seal.phase == Phase::Prepared
                {
                    return Ok(());
                }
                return Err(busy("Another File move is in progress"));
            }
            registry.seals.insert(
                target.clone(),
                Seal {
                    event: OwnerMoveReleased {
                        binding: binding.clone(),
                        operation_id: operation.into(),
                        source: object.clone(),
                    },
                    window: window.into(),
                    phase: Phase::Preparing,
                    nonce: nonce.clone(),
                    release,
                },
            );
            registry
                .editors
                .retain(|_, e| e.binding == *binding && live_windows.contains(&e.window));
            let mut requests = Vec::new();
            let mut receivers = Vec::new();
            let mut channels = Vec::new();
            for (editor_id, e) in &registry.editors {
                if e.object != *object {
                    continue;
                }
                let (sender, receiver) = oneshot::channel();
                let request = FileEditorFlushRequest {
                    binding: binding.clone(),
                    object: object.clone(),
                    editor_id: editor_id.clone(),
                    flush_id: format!("{:032x}", rand::random::<u128>()),
                    operation_id: operation.into(),
                    window: e.window.clone(),
                };
                requests.push(request.clone());
                receivers.push(receiver);
                channels.push(Pending { request, sender });
            }
            for pending in channels {
                registry
                    .pending
                    .insert(pending.request.flush_id.clone(), pending);
            }
            (requests, receivers)
        };
        let mut cleanup = FileMoveGuard {
            coordinator: self.clone(),
            target: target.clone(),
            operation: operation.into(),
            nonce: nonce.clone(),
            notify: true,
        };
        for request in &requests {
            emit(request)?;
        }
        let responses = tokio::time::timeout(timeout, async {
            let mut receivers: FuturesUnordered<_> = receivers.into_iter().collect();
            while let Some(response) = receivers.next().await {
                if !matches!(response, Ok(FileEditorFlushOutcome::Saved)) {
                    return Err(busy("File editor could not save; all drafts were retained"));
                }
            }
            Ok(())
        })
        .await
        .map_err(|_| busy("File editor did not respond; all drafts were retained"))?;
        responses?;
        {
            let mut registry = crate::lock_mutex(&self.registry);
            let seal = registry
                .seals
                .get_mut(&target)
                .ok_or_else(|| busy("File move preparation was cancelled"))?;
            if seal.event.operation_id != operation || seal.nonce != nonce {
                return Err(busy("File move preparation changed"));
            }
            seal.phase = Phase::Prepared;
        }
        // Transfer ownership from the async preparation to the pending native move.
        cleanup.notify = false;
        drop(cleanup);
        self.expire_prepared(target, operation.to_owned(), nonce, expiry);
        Ok(())
    }
    fn expire_prepared(
        self: &Arc<Self>,
        target: String,
        operation: String,
        nonce: String,
        expiry: Duration,
    ) {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::time::sleep(expiry).await;
            if let Some(coordinator) = weak.upgrade() {
                coordinator.remove(&target, &operation, Some(&nonce), false, true);
            }
        });
    }
}
pub(crate) struct FileMoveGuard {
    coordinator: Arc<FileEditorCoordinator>,
    target: String,
    operation: String,
    nonce: String,
    notify: bool,
}
impl FileMoveGuard {
    // Drop prepare may archive saved working content. Keep the same object frozen
    // while the caller waits to commit its persisted intent, with a fresh expiry.
    pub(crate) fn prepared(self) -> AgentResult<()> {
        self.prepared_timeout(Duration::from_secs(60))
    }
    fn prepared_timeout(mut self, expiry: Duration) -> AgentResult<()> {
        let nonce = format!("{:032x}", rand::random::<u128>());
        {
            let mut registry = crate::lock_mutex(&self.coordinator.registry);
            let seal = registry
                .seals
                .get_mut(&self.target)
                .ok_or_else(|| busy("File preparation no longer exists"))?;
            if seal.event.operation_id != self.operation
                || seal.nonce != self.nonce
                || seal.phase != Phase::Moving
            {
                return Err(busy("File preparation changed"));
            }
            seal.phase = Phase::Prepared;
            seal.nonce = nonce.clone();
        }
        self.notify = false;
        self.coordinator.expire_prepared(
            self.target.clone(),
            self.operation.clone(),
            nonce,
            expiry,
        );
        Ok(())
    }
    pub(crate) fn committed(mut self) {
        self.coordinator.remove(
            &self.target,
            &self.operation,
            Some(&self.nonce),
            true,
            false,
        );
        self.notify = false;
    }
}
impl Drop for FileMoveGuard {
    fn drop(&mut self) {
        if self.notify {
            self.coordinator
                .remove(&self.target, &self.operation, Some(&self.nonce), true, true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::models::Scope;
    fn binding() -> WorkspaceBinding {
        WorkspaceBinding {
            workspace_id: "workspace".into(),
            generation: "opened".into(),
        }
    }
    fn object(id: &str) -> ObjectRef {
        ObjectRef {
            workspace_id: "workspace".into(),
            scope: Scope::Workspace,
            kind: ObjectKind::File,
            id: id.into(),
        }
    }
    fn registration(id: char, file: &str) -> FileEditorRegistration {
        FileEditorRegistration {
            object: object(file),
            editor_id: id.to_string().repeat(32),
        }
    }
    fn windows() -> HashSet<String> {
        HashSet::from(["main".into(), "project-1".into()])
    }
    fn saved(c: &FileEditorCoordinator, r: &FileEditorFlushRequest) -> AgentResult<()> {
        c.reply(
            &r.binding,
            &r.window,
            &FileEditorFlushReply {
                object: r.object.clone(),
                editor_id: r.editor_id.clone(),
                flush_id: r.flush_id.clone(),
                outcome: FileEditorFlushOutcome::Saved,
            },
        )
    }
    fn releases() -> (
        Arc<Mutex<Vec<OwnerMoveReleased>>>,
        Arc<dyn Fn(OwnerMoveReleased) + Send + Sync>,
    ) {
        let values = Arc::new(Mutex::new(Vec::new()));
        let copy = values.clone();
        (
            values,
            Arc::new(move |event| crate::lock_mutex(&copy).push(event)),
        )
    }
    #[tokio::test]
    async fn move_saves_only_target_instances_and_seals_after_ack_until_terminal() {
        let c = Arc::new(FileEditorCoordinator::default());
        c.register(&binding(), "main", &registration('a', "7"))
            .unwrap();
        c.register(&binding(), "project-1", &registration('b', "7"))
            .unwrap();
        c.register(&binding(), "main", &registration('c', "8"))
            .unwrap();
        let seen = Mutex::new(Vec::new());
        let (events, release) = releases();
        c.prepare(
            &binding(),
            &object("7"),
            "move",
            "main",
            &windows(),
            |r| {
                crate::lock_mutex(&seen).push((r.object.id.clone(), r.editor_id.clone()));
                assert_eq!(
                    c.register(&binding(), "main", &registration('d', "7"))
                        .unwrap_err()
                        .code,
                    ErrorCode::EditorBusy
                );
                saved(&c, r)
            },
            release,
        )
        .await
        .unwrap();
        assert_eq!(crate::lock_mutex(&seen).len(), 2);
        assert!(crate::lock_mutex(&seen).iter().all(|r| r.0 == "7"));
        assert_eq!(
            c.register(&binding(), "main", &registration('d', "7"))
                .unwrap_err()
                .code,
            ErrorCode::EditorBusy
        );
        c.register(&binding(), "main", &registration('e', "8"))
            .unwrap();
        assert_eq!(
            c.release(&binding(), &object("7"), "move", "project-1")
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert!(c
            .take(&binding(), &object("7"), "move", "project-1")
            .is_err());
        let moving = c.take(&binding(), &object("7"), "move", "main").unwrap();
        assert_eq!(
            c.release(&binding(), &object("7"), "move", "main")
                .unwrap_err()
                .code,
            ErrorCode::EditorBusy
        );
        assert!(c
            .register(&binding(), "main", &registration('d', "7"))
            .is_err());
        drop(moving);
        assert_eq!(crate::lock_mutex(&events).len(), 1);
        c.register(&binding(), "main", &registration('d', "7"))
            .unwrap();
        assert_eq!(crate::lock_mutex(&c.registry).editors.len(), 5);
    }
    #[tokio::test]
    async fn failed_or_silent_target_preserves_registrations_and_releases_only_target() {
        let c = Arc::new(FileEditorCoordinator::default());
        c.register(&binding(), "main", &registration('a', "7"))
            .unwrap();
        c.register(&binding(), "main", &registration('b', "8"))
            .unwrap();
        let (events, release) = releases();
        let failure = c
            .prepare(
                &binding(),
                &object("7"),
                "failed",
                "main",
                &windows(),
                |r| {
                    c.reply(
                        &r.binding,
                        &r.window,
                        &FileEditorFlushReply {
                            object: r.object.clone(),
                            editor_id: r.editor_id.clone(),
                            flush_id: r.flush_id.clone(),
                            outcome: FileEditorFlushOutcome::Failed,
                        },
                    )
                },
                release.clone(),
            )
            .await;
        assert_eq!(failure.unwrap_err().code, ErrorCode::EditorBusy);
        let timeout = c
            .prepare_timeout(
                &binding(),
                &object("7"),
                "silent",
                "main",
                &windows(),
                Duration::ZERO,
                Duration::from_secs(60),
                |_| Ok(()),
                release,
            )
            .await;
        assert_eq!(timeout.unwrap_err().code, ErrorCode::EditorBusy);
        let registry = crate::lock_mutex(&c.registry);
        assert_eq!(registry.editors.len(), 2);
        assert!(registry.pending.is_empty());
        assert!(registry.seals.is_empty());
        let events = crate::lock_mutex(&events);
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|e| e.source == object("7")));
    }
    #[tokio::test]
    async fn foreign_window_generation_object_or_editor_cannot_ack() {
        let c = Arc::new(FileEditorCoordinator::default());
        c.register(&binding(), "main", &registration('a', "7"))
            .unwrap();
        let (_, release) = releases();
        c.prepare(
            &binding(),
            &object("7"),
            "move",
            "main",
            &windows(),
            |r| {
                let mut reply = FileEditorFlushReply {
                    object: r.object.clone(),
                    editor_id: r.editor_id.clone(),
                    flush_id: r.flush_id.clone(),
                    outcome: FileEditorFlushOutcome::Saved,
                };
                assert_eq!(
                    c.reply(&binding(), "project-1", &reply).unwrap_err().code,
                    ErrorCode::ScopeDenied
                );
                let stale = WorkspaceBinding {
                    generation: "old".into(),
                    ..binding()
                };
                assert_eq!(
                    c.reply(&stale, "main", &reply).unwrap_err().code,
                    ErrorCode::ScopeDenied
                );
                reply.object = object("8");
                assert!(c.reply(&binding(), "main", &reply).is_err());
                reply.object = object("7");
                reply.editor_id = "b".repeat(32);
                assert!(c.reply(&binding(), "main", &reply).is_err());
                saved(&c, r)
            },
            release,
        )
        .await
        .unwrap();
        let mut record = object("7");
        record.kind = ObjectKind::Record;
        assert_eq!(
            c.register(
                &binding(),
                "main",
                &FileEditorRegistration {
                    object: record,
                    editor_id: "f".repeat(32)
                }
            )
            .unwrap_err()
            .code,
            ErrorCode::InvalidArgument
        );
        c.release(&binding(), &object("7"), "move", "main").unwrap();
    }
    #[tokio::test]
    async fn cancelled_preparation_cannot_remove_new_seal_with_same_operation() {
        let c = Arc::new(FileEditorCoordinator::default());
        c.register(&binding(), "main", &registration('a', "7"))
            .unwrap();
        let binding = binding();
        let object = object("7");
        let windows = windows();
        let (_, release) = releases();
        let first = c.prepare(
            &binding,
            &object,
            "retry",
            "main",
            &windows,
            |_| Ok(()),
            release.clone(),
        );
        futures_util::pin_mut!(first);
        assert!(futures_util::poll!(first.as_mut()).is_pending());
        c.release(&binding, &object, "retry", "main").unwrap();
        c.prepare(
            &binding,
            &object,
            "retry",
            "main",
            &windows,
            |r| saved(&c, r),
            release,
        )
        .await
        .unwrap();
        assert_eq!(first.await.unwrap_err().code, ErrorCode::EditorBusy);
        c.take(&binding, &object, "retry", "main")
            .unwrap()
            .committed();
    }
    #[tokio::test]
    async fn drop_prepare_rearms_without_old_expiry_or_guard_releasing_new_seal() {
        let c = Arc::new(FileEditorCoordinator::default());
        let (events, release) = releases();
        c.prepare_timeout(
            &binding(),
            &object("7"),
            "drop",
            "main",
            &windows(),
            Duration::from_secs(1),
            Duration::ZERO,
            |_| Ok(()),
            release,
        )
        .await
        .unwrap();
        let moving = c.take(&binding(), &object("7"), "drop", "main").unwrap();
        let old_nonce = moving.nonce.clone();
        moving.prepared_timeout(Duration::from_secs(60)).unwrap();
        // Deterministically execute the old timer's removal after rearming.
        assert!(!c.remove(
            &key(&binding(), &object("7")).unwrap(),
            "drop",
            Some(&old_nonce),
            false,
            true
        ));
        assert!(crate::lock_mutex(&events).is_empty());
        assert_eq!(
            c.register(&binding(), "main", &registration('a', "7"))
                .unwrap_err()
                .code,
            ErrorCode::EditorBusy
        );
        let commit = c.take(&binding(), &object("7"), "drop", "main").unwrap();
        commit.committed();
        assert!(crate::lock_mutex(&events).is_empty());
        c.register(&binding(), "main", &registration('a', "7"))
            .unwrap();

        let (_, release) = releases();
        c.prepare(
            &binding(),
            &object("8"),
            "abandoned",
            "main",
            &windows(),
            |_| Ok(()),
            release,
        )
        .await
        .unwrap();
        let moving = c
            .take(&binding(), &object("8"), "abandoned", "main")
            .unwrap();
        moving.prepared_timeout(Duration::ZERO).unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;
        c.register(&binding(), "main", &registration('b', "8"))
            .unwrap();
    }
    #[tokio::test]
    async fn committed_move_suppresses_abort_and_expiry_does_not_interrupt_active_move() {
        let c = Arc::new(FileEditorCoordinator::default());
        let (events, release) = releases();
        c.prepare_timeout(
            &binding(),
            &object("7"),
            "move",
            "main",
            &windows(),
            Duration::from_secs(1),
            Duration::ZERO,
            |_| Ok(()),
            release,
        )
        .await
        .unwrap();
        let moving = c.take(&binding(), &object("7"), "move", "main").unwrap();
        tokio::task::yield_now().await;
        assert!(crate::lock_mutex(&events).is_empty());
        assert!(c
            .register(&binding(), "main", &registration('a', "7"))
            .is_err());
        moving.committed();
        assert!(crate::lock_mutex(&events).is_empty());
        c.register(&binding(), "main", &registration('a', "7"))
            .unwrap();
        c.unregister(&binding(), "project-1", &registration('a', "7"))
            .unwrap_err();
        c.unregister(&binding(), "main", &registration('a', "7"))
            .unwrap();
        c.unregister(&binding(), "main", &registration('a', "7"))
            .unwrap();
    }
}
