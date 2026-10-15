//! Live editor registration and a bounded, acknowledged flush before external writes.
use crate::{
    agent::{
        errors::{AgentError, AgentResult, ErrorCode},
        models::WorkspaceBinding,
    },
    record_documents::RecordTarget,
};
use futures_util::{stream::FuturesUnordered, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::{oneshot, OwnedMutexGuard};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordEditorRegistration {
    pub target: RecordTarget,
    pub editor_id: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordEditorFlushRequest {
    pub binding: WorkspaceBinding,
    pub target: RecordTarget,
    pub editor_id: String,
    pub flush_id: String,
    #[serde(skip)]
    pub window: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordEditorFlushReply {
    pub target: RecordTarget,
    pub editor_id: String,
    pub flush_id: String,
    pub outcome: RecordEditorFlushOutcome,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RecordEditorFlushOutcome {
    Saved,
    ReviewPending,
    Busy,
}
struct Registered {
    binding: WorkspaceBinding,
    target: RecordTarget,
    window: String,
}
struct Pending {
    request: RecordEditorFlushRequest,
    sender: oneshot::Sender<RecordEditorFlushOutcome>,
}
#[derive(Default)]
struct Registry {
    editors: BTreeMap<String, Registered>,
    pending: HashMap<String, Pending>,
}
struct CutCredit {
    binding: WorkspaceBinding,
    target: String,
    consumed: bool,
}
#[derive(Default)]
struct CutRegistry {
    credits: HashMap<String, CutCredit>,
    order: VecDeque<String>,
}
#[derive(Default)]
pub(crate) struct RecordEditorCoordinator {
    registry: Mutex<Registry>,
    locks: Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>,
    cuts: Mutex<CutRegistry>,
}
fn key(binding: &WorkspaceBinding, target: &RecordTarget) -> AgentResult<String> {
    Ok(format!(
        "{}:{}:{}",
        binding.workspace_id,
        binding.generation,
        target.key()?
    ))
}
fn valid_editor_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}
impl RecordEditorCoordinator {
    pub(crate) fn register_cut(
        &self,
        binding: &WorkspaceBinding,
        target: &RecordTarget,
        token: &str,
    ) -> AgentResult<()> {
        validate_cut_token(token)?;
        let target = target.key()?;
        let mut cuts = crate::lock_mutex(&self.cuts);
        if let Some(existing) = cuts.credits.get(token) {
            if existing.binding != *binding || existing.target != target {
                return Err(AgentError::new(
                    ErrorCode::ScopeDenied,
                    "Cut identity belongs to another Record",
                ));
            }
            // A repeated registration cannot turn an already used credit back on.
            return Ok(());
        }
        cuts.credits.insert(
            token.into(),
            CutCredit {
                binding: binding.clone(),
                target,
                consumed: false,
            },
        );
        cuts.order.push_back(token.into());
        while cuts.order.len() > 512 {
            if let Some(expired) = cuts.order.pop_front() {
                cuts.credits.remove(&expired);
            }
        }
        Ok(())
    }
    pub(crate) fn claim_cut(
        &self,
        binding: &WorkspaceBinding,
        target: &RecordTarget,
        token: &str,
    ) -> AgentResult<bool> {
        validate_cut_token(token)?;
        let target = target.key()?;
        let mut cuts = crate::lock_mutex(&self.cuts);
        let Some(credit) = cuts.credits.get_mut(token) else {
            return Ok(false);
        };
        if credit.binding != *binding || credit.consumed {
            return Ok(false);
        }
        credit.consumed = true;
        Ok(credit.target == target)
    }
    pub(crate) fn register(
        &self,
        binding: &WorkspaceBinding,
        window: &str,
        input: &RecordEditorRegistration,
    ) -> AgentResult<()> {
        input.target.key()?;
        if !valid_editor_id(&input.editor_id) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid editor identity",
            ));
        }
        let mut registry = crate::lock_mutex(&self.registry);
        if registry
            .editors
            .get(&input.editor_id)
            .is_some_and(|existing| existing.window != window || existing.binding != *binding)
        {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Editor belongs to another window",
            ));
        }
        registry.editors.insert(
            input.editor_id.clone(),
            Registered {
                binding: binding.clone(),
                target: input.target.clone(),
                window: window.into(),
            },
        );
        Ok(())
    }
    pub(crate) fn unregister(
        &self,
        binding: &WorkspaceBinding,
        window: &str,
        input: &RecordEditorRegistration,
    ) -> AgentResult<()> {
        let mut registry = crate::lock_mutex(&self.registry);
        if let Some(existing) = registry.editors.get(&input.editor_id) {
            if existing.window != window
                || existing.binding != *binding
                || existing.target.key()? != input.target.key()?
            {
                return Err(AgentError::new(
                    ErrorCode::ScopeDenied,
                    "Editor belongs to another window",
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
        input: &RecordEditorFlushReply,
    ) -> AgentResult<()> {
        let mut registry = crate::lock_mutex(&self.registry);
        let Some(pending) = registry.pending.get(&input.flush_id) else {
            return Ok(());
        };
        if pending.request.binding != *binding
            || pending.request.window != window
            || pending.request.editor_id != input.editor_id
            || pending.request.target.key()? != input.target.key()?
        {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Flush reply belongs to another editor",
            ));
        }
        if let Some(pending) = registry.pending.remove(&input.flush_id) {
            let _ = pending.sender.send(input.outcome);
        }
        Ok(())
    }
    pub(crate) async fn submission_lock(
        &self,
        binding: &WorkspaceBinding,
        target: &RecordTarget,
    ) -> AgentResult<OwnedMutexGuard<()>> {
        let lock = {
            let mut locks = crate::lock_mutex(&self.locks);
            locks.retain(|_, lock| lock.strong_count() > 0);
            let key = key(binding, target)?;
            let lock = locks
                .get(&key)
                .and_then(Weak::upgrade)
                .unwrap_or_else(|| Arc::new(tokio::sync::Mutex::new(())));
            locks.insert(key, Arc::downgrade(&lock));
            lock
        };
        Ok(lock.lock_owned().await)
    }
    pub(crate) async fn flush(
        self: &Arc<Self>,
        binding: &WorkspaceBinding,
        target: &RecordTarget,
        live_windows: &HashSet<String>,
        emit: impl Fn(&RecordEditorFlushRequest) -> AgentResult<()>,
    ) -> AgentResult<()> {
        self.flush_timeout(binding, target, live_windows, Duration::from_secs(2), emit)
            .await
    }
    async fn flush_timeout(
        self: &Arc<Self>,
        binding: &WorkspaceBinding,
        target: &RecordTarget,
        live_windows: &HashSet<String>,
        timeout: Duration,
        emit: impl Fn(&RecordEditorFlushRequest) -> AgentResult<()>,
    ) -> AgentResult<()> {
        let target_key = target.key()?;
        let mut requests = Vec::new();
        let mut receivers = Vec::new();
        let mut pending = Vec::new();
        {
            let mut registry = crate::lock_mutex(&self.registry);
            registry.editors.retain(|_, editor| {
                editor.binding == *binding && live_windows.contains(&editor.window)
            });
            for (editor_id, editor) in &registry.editors {
                if editor.target.key()? != target_key {
                    continue;
                }
                let (sender, receiver) = oneshot::channel();
                let request = RecordEditorFlushRequest {
                    binding: binding.clone(),
                    target: target.clone(),
                    editor_id: editor_id.clone(),
                    flush_id: format!("{:032x}", rand::random::<u128>()),
                    window: editor.window.clone(),
                };
                requests.push(request.clone());
                pending.push(Pending { request, sender });
                receivers.push(receiver);
            }
            // Register every response channel before emitting any request.
            for pending in pending {
                registry
                    .pending
                    .insert(pending.request.flush_id.clone(), pending);
            }
        }
        let _cleanup = PendingCleanup {
            coordinator: self.clone(),
            ids: requests
                .iter()
                .map(|request| request.flush_id.clone())
                .collect(),
        };
        for request in &requests {
            emit(request)?;
        }
        let result = tokio::time::timeout(timeout, async {
            let mut responses: FuturesUnordered<_> = receivers.into_iter().collect();
            while let Some(response) = responses.next().await {
                match response {
                    Ok(RecordEditorFlushOutcome::Saved) => (),
                    Ok(RecordEditorFlushOutcome::ReviewPending) => {
                        return Err(AgentError::new(
                            ErrorCode::EditorReviewPending,
                            "请先接受或取消记录中待确认的 AI 内容",
                        ))
                    }
                    _ => {
                        return Err(AgentError::new(
                            ErrorCode::EditorBusy,
                            "记录编辑窗口未能完成保存，草稿已保留",
                        ))
                    }
                }
            }
            Ok(())
        })
        .await;
        result.unwrap_or_else(|_| {
            Err(AgentError::new(
                ErrorCode::EditorBusy,
                "记录编辑窗口在两秒内未响应，草稿已保留",
            ))
        })
    }
}

fn validate_cut_token(token: &str) -> AgentResult<()> {
    if token.len() != 36
        || !token.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
            }
        })
    {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Invalid clipboard cut identity",
        ));
    }
    Ok(())
}
struct PendingCleanup {
    coordinator: Arc<RecordEditorCoordinator>,
    ids: Vec<String>,
}
impl Drop for PendingCleanup {
    fn drop(&mut self) {
        let mut registry = crate::lock_mutex(&self.coordinator.registry);
        for id in &self.ids {
            registry.pending.remove(id);
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
    fn target() -> RecordTarget {
        RecordTarget {
            scope: Scope::Workspace,
            record_id: 7,
        }
    }
    fn registration(id: char) -> RecordEditorRegistration {
        RecordEditorRegistration {
            target: target(),
            editor_id: id.to_string().repeat(32),
        }
    }
    #[test]
    fn cut_credits_are_shared_between_windows_and_consumed_atomically_once() {
        let coordinator = Arc::new(RecordEditorCoordinator::default());
        let token = "11111111-1111-4111-8111-111111111111";
        coordinator
            .register_cut(&binding(), &target(), token)
            .unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let coordinator = coordinator.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    coordinator.claim_cut(&binding(), &target(), token).unwrap()
                })
            })
            .collect();
        assert_eq!(
            threads
                .into_iter()
                .filter_map(|thread| thread.join().unwrap().then_some(()))
                .count(),
            1
        );
        coordinator
            .register_cut(&binding(), &target(), token)
            .unwrap();
        assert!(!coordinator.claim_cut(&binding(), &target(), token).unwrap());
    }
    #[test]
    fn foreign_record_paste_consumes_cut_without_granting_move_identity() {
        let coordinator = RecordEditorCoordinator::default();
        let token = "22222222-2222-4222-8222-222222222222";
        coordinator
            .register_cut(&binding(), &target(), token)
            .unwrap();
        let other = RecordTarget {
            record_id: 8,
            ..target()
        };
        assert!(!coordinator.claim_cut(&binding(), &other, token).unwrap());
        assert!(!coordinator.claim_cut(&binding(), &target(), token).unwrap());
        assert!(!coordinator
            .claim_cut(
                &binding(),
                &target(),
                "33333333-3333-4333-8333-333333333333"
            )
            .unwrap());
        assert!(coordinator
            .claim_cut(&binding(), &target(), "malformed")
            .is_err());
    }
    #[test]
    fn workspace_reopen_and_credit_eviction_never_regrant_old_cut_identity() {
        let coordinator = RecordEditorCoordinator::default();
        let first = "44444444-4444-4444-8444-444444444444";
        coordinator
            .register_cut(&binding(), &target(), first)
            .unwrap();
        let reopened = WorkspaceBinding {
            generation: "reopened".into(),
            ..binding()
        };
        assert!(!coordinator.claim_cut(&reopened, &target(), first).unwrap());
        for number in 0..512 {
            coordinator
                .register_cut(
                    &binding(),
                    &target(),
                    &format!("{number:08x}-5555-4555-8555-555555555555"),
                )
                .unwrap();
        }
        assert!(!coordinator.claim_cut(&binding(), &target(), first).unwrap());
    }
    #[tokio::test]
    async fn flush_waits_for_every_matching_window_and_rejects_pending_ai() {
        let coordinator = Arc::new(RecordEditorCoordinator::default());
        coordinator
            .register(&binding(), "main", &registration('a'))
            .unwrap();
        coordinator
            .register(&binding(), "project-1", &registration('b'))
            .unwrap();
        let windows = HashSet::from(["main".into(), "project-1".into()]);
        let result = coordinator
            .flush(&binding(), &target(), &windows, |request| {
                coordinator.reply(
                    &binding(),
                    &request.window,
                    &RecordEditorFlushReply {
                        target: target(),
                        editor_id: request.editor_id.clone(),
                        flush_id: request.flush_id.clone(),
                        outcome: if request.window == "main" {
                            RecordEditorFlushOutcome::Saved
                        } else {
                            RecordEditorFlushOutcome::ReviewPending
                        },
                    },
                )
            })
            .await;
        assert_eq!(result.unwrap_err().code, ErrorCode::EditorReviewPending);
        assert!(crate::lock_mutex(&coordinator.registry).pending.is_empty());
        coordinator
            .flush(&binding(), &target(), &windows, |request| {
                coordinator.reply(
                    &binding(),
                    &request.window,
                    &RecordEditorFlushReply {
                        target: target(),
                        editor_id: request.editor_id.clone(),
                        flush_id: request.flush_id.clone(),
                        outcome: RecordEditorFlushOutcome::Saved,
                    },
                )
            })
            .await
            .unwrap();
        // Both editors remain registered for subsequent operations.
        assert_eq!(crate::lock_mutex(&coordinator.registry).editors.len(), 2);
    }
    #[tokio::test]
    async fn stale_windows_are_pruned_but_unresponsive_live_windows_block_and_cleanup() {
        let coordinator = Arc::new(RecordEditorCoordinator::default());
        coordinator
            .register(&binding(), "closed", &registration('a'))
            .unwrap();
        coordinator
            .register(&binding(), "main", &registration('b'))
            .unwrap();
        let result = coordinator
            .flush_timeout(
                &binding(),
                &target(),
                &HashSet::from(["main".into()]),
                Duration::from_millis(5),
                |_| Ok(()),
            )
            .await;
        assert_eq!(result.unwrap_err().code, ErrorCode::EditorBusy);
        let registry = crate::lock_mutex(&coordinator.registry);
        assert_eq!(registry.editors.len(), 1);
        assert!(registry.pending.is_empty());
    }
    #[tokio::test]
    async fn foreign_window_cannot_spoof_a_flush_reply() {
        let coordinator = Arc::new(RecordEditorCoordinator::default());
        coordinator
            .register(&binding(), "main", &registration('a'))
            .unwrap();
        let result = coordinator
            .flush_timeout(
                &binding(),
                &target(),
                &HashSet::from(["main".into()]),
                Duration::from_millis(5),
                |request| {
                    let reply = RecordEditorFlushReply {
                        target: target(),
                        editor_id: request.editor_id.clone(),
                        flush_id: request.flush_id.clone(),
                        outcome: RecordEditorFlushOutcome::Saved,
                    };
                    assert_eq!(
                        coordinator
                            .reply(&binding(), "other", &reply)
                            .unwrap_err()
                            .code,
                        ErrorCode::ScopeDenied
                    );
                    Ok(())
                },
            )
            .await;
        assert_eq!(result.unwrap_err().code, ErrorCode::EditorBusy);
    }
    #[tokio::test]
    async fn submissions_share_a_target_lock_and_release_it_on_drop() {
        let coordinator = Arc::new(RecordEditorCoordinator::default());
        let first = coordinator
            .submission_lock(&binding(), &target())
            .await
            .unwrap();
        let binding = binding();
        let target = target();
        let second = coordinator.submission_lock(&binding, &target);
        assert!(tokio::time::timeout(Duration::from_millis(5), second)
            .await
            .is_err());
        drop(first);
        coordinator
            .submission_lock(&binding, &target)
            .await
            .unwrap();
    }
}
