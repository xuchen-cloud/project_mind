use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    thread,
};

use crate::{
    agent::models::WorkspaceBinding,
    db::Database,
    models::{AiJobEnqueueInput, AiJobResult, AiJobSnapshot, AiJobStatus},
};

pub const AI_JOB_EVENT: &str = "ai-job-updated";

type JobEmitter = Arc<dyn Fn(&AiJobSnapshot) + Send + Sync>;

#[cfg(test)]
type TestWorker = Arc<dyn Fn(AiJobEnqueueInput) -> Result<AiJobResult, String> + Send + Sync>;

#[derive(Clone)]
pub struct AiJobManager {
    binding: WorkspaceBinding,
    #[cfg(test)]
    worker: Option<TestWorker>,
    db_path: PathBuf,
    workspace_root: PathBuf,
    secret_state: Arc<Mutex<Option<String>>>,
    emitter: JobEmitter,
    inner: Arc<Mutex<AiJobManagerState>>,
}

struct AiJobManagerState {
    next_id: i64,
    max_concurrency: usize,
    jobs: HashMap<i64, AiJobSnapshot>,
    requests: HashMap<i64, AiJobEnqueueInput>,
    queued_ids: VecDeque<i64>,
    // Physical executions retain their slots even after the visible job is cancelled.
    running_ids: HashSet<i64>,
}

impl AiJobManager {
    pub fn new(
        binding: WorkspaceBinding,
        db_path: PathBuf,
        workspace_root: PathBuf,
        secret_state: Arc<Mutex<Option<String>>>,
        max_concurrency: i64,
        emitter: JobEmitter,
    ) -> Self {
        Self {
            binding,
            #[cfg(test)]
            worker: None,
            db_path,
            workspace_root,
            secret_state,
            emitter,
            inner: Arc::new(Mutex::new(AiJobManagerState {
                next_id: 1,
                max_concurrency: max_concurrency.clamp(1, 4) as usize,
                jobs: HashMap::new(),
                requests: HashMap::new(),
                queued_ids: VecDeque::new(),
                running_ids: HashSet::new(),
            })),
        }
    }

    pub fn enqueue(&self, input: AiJobEnqueueInput) -> AiJobSnapshot {
        let kind = input.kind();
        let target_key = input.target_key().to_string();

        let snapshot = {
            let mut state = lock_state(&self.inner);

            let job_id = state.next_id;
            state.next_id += 1;

            let snapshot = AiJobSnapshot {
                binding: self.binding.clone(),
                id: job_id,
                kind,
                target_key,
                status: AiJobStatus::Queued,
                queued_at: now_iso(),
                started_at: None,
                finished_at: None,
                error_message: None,
                stream_text: None,
                result: None,
            };

            state.jobs.insert(job_id, snapshot.clone());
            state.requests.insert(job_id, input);
            state.queued_ids.push_back(job_id);
            snapshot
        };

        self.emit(&snapshot);
        self.try_start_jobs();
        snapshot
    }

    pub fn get(&self, job_id: i64) -> Option<AiJobSnapshot> {
        lock_state(&self.inner).jobs.get(&job_id).cloned()
    }

    pub fn list_active(&self) -> Vec<AiJobSnapshot> {
        let mut snapshots = lock_state(&self.inner)
            .jobs
            .values()
            .filter(|job| !job.status.is_terminal())
            .cloned()
            .collect::<Vec<_>>();
        snapshots.sort_by_key(|job| job.id);
        snapshots
    }

    pub fn cancel(&self, job_id: i64) -> Option<AiJobSnapshot> {
        let snapshot = {
            let mut state = lock_state(&self.inner);
            let current = state.jobs.get(&job_id)?.clone();
            if current.status.is_terminal() {
                return Some(current);
            }
            state.queued_ids.retain(|candidate| *candidate != job_id);
            state.requests.remove(&job_id);
            let snapshot = state.jobs.get_mut(&job_id)?;
            snapshot.status = AiJobStatus::Cancelled;
            snapshot.finished_at = Some(now_iso());
            snapshot.error_message = None;
            snapshot.clone()
        };
        self.emit(&snapshot);
        self.try_start_jobs();
        Some(snapshot)
    }

    pub fn set_max_concurrency(&self, max_concurrency: i64) {
        {
            let mut state = lock_state(&self.inner);
            state.max_concurrency = max_concurrency.clamp(1, 4) as usize;
        }
        self.try_start_jobs();
    }

    fn try_start_jobs(&self) {
        loop {
            let next_job = {
                let mut state = lock_state(&self.inner);
                if state.running_ids.len() >= state.max_concurrency {
                    None
                } else {
                    let Some(job_id) = state.queued_ids.pop_front() else {
                        return;
                    };
                    let Some(request) = state.requests.get(&job_id).cloned() else {
                        continue;
                    };
                    state.running_ids.insert(job_id);
                    let Some(snapshot) = state.jobs.get_mut(&job_id) else {
                        state.running_ids.remove(&job_id);
                        continue;
                    };
                    snapshot.status = AiJobStatus::Running;
                    snapshot.started_at = Some(now_iso());
                    snapshot.error_message = None;
                    snapshot.stream_text = None;
                    snapshot.result = None;
                    Some((job_id, request, snapshot.clone()))
                }
            };

            let Some((job_id, request, running_snapshot)) = next_job else {
                break;
            };

            self.emit(&running_snapshot);

            let manager = self.clone();
            thread::spawn(move || {
                let result = manager.execute_job(job_id, request);
                manager.finish(job_id, result);
            });
        }
    }

    fn execute_job(&self, job_id: i64, request: AiJobEnqueueInput) -> Result<AiJobResult, String> {
        #[cfg(test)]
        if let Some(worker) = &self.worker {
            return worker(request);
        }

        let secret_password = lock_secret_state(&self.secret_state).clone();
        Database::open(&self.db_path, &self.workspace_root, secret_password)
            .and_then(|mut db| {
                db.execute_ai_job_with_progress(request, |stream_text| {
                    self.update_stream_text(job_id, stream_text);
                })
            })
            .map_err(|error| error.to_string())
    }

    fn finish(&self, job_id: i64, result: Result<AiJobResult, String>) {
        let snapshot = {
            let mut state = lock_state(&self.inner);
            // Execution has returned: release the physical slot regardless of the UI status.
            state.running_ids.remove(&job_id);
            state.requests.remove(&job_id);
            state.jobs.get_mut(&job_id).and_then(|snapshot| {
                if snapshot.status == AiJobStatus::Cancelled {
                    return None;
                }
                snapshot.finished_at = Some(now_iso());
                match result {
                    Ok(result) => {
                        snapshot.status = AiJobStatus::Succeeded;
                        snapshot.error_message = None;
                        if let AiJobResult::EditorSkill { rewrite } = &result {
                            snapshot.stream_text = Some(rewrite.content.clone());
                        }
                        snapshot.result = Some(result);
                    }
                    Err(error_message) => {
                        snapshot.status = AiJobStatus::Failed;
                        snapshot.error_message = Some(error_message);
                        snapshot.result = None;
                    }
                }
                Some(snapshot.clone())
            })
        };

        if let Some(snapshot) = snapshot {
            self.emit(&snapshot);
        }
        // Cancelled executions also unblock queued work when they finally return.
        self.try_start_jobs();
    }

    fn update_stream_text(&self, job_id: i64, stream_text: String) {
        let snapshot = {
            let mut state = lock_state(&self.inner);
            let Some(snapshot) = state.jobs.get_mut(&job_id) else {
                return;
            };
            if snapshot.status != AiJobStatus::Running {
                return;
            }
            if snapshot.stream_text.as_deref() == Some(stream_text.as_str()) {
                return;
            }
            snapshot.stream_text = Some(stream_text);
            snapshot.clone()
        };

        self.emit(&snapshot);
    }

    fn emit(&self, snapshot: &AiJobSnapshot) {
        (self.emitter)(snapshot);
    }
}

fn lock_state(inner: &Arc<Mutex<AiJobManagerState>>) -> MutexGuard<'_, AiJobManagerState> {
    match inner.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn lock_secret_state(inner: &Arc<Mutex<Option<String>>>) -> MutexGuard<'_, Option<String>> {
    match inner.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc::{self, Receiver, Sender},
            Arc, Mutex,
        },
        thread,
        time::{Duration, Instant},
    };

    use super::{lock_state, AiJobManager};
    use crate::{
        agent::models::WorkspaceBinding,
        models::{
            AiJobEnqueueInput, AiJobResult, AiJobSnapshot, AiJobStatus, AiProfileTestInput,
            AiProfileTestResult,
        },
    };

    const TIMEOUT: Duration = Duration::from_secs(5);

    struct StartedWorker {
        target_key: String,
        finish: Sender<bool>,
    }

    struct ControlledWorkers {
        started: Receiver<StartedWorker>,
        events: Receiver<AiJobSnapshot>,
        active: Arc<AtomicUsize>,
        peak: Arc<AtomicUsize>,
    }

    fn binding() -> WorkspaceBinding {
        WorkspaceBinding {
            workspace_id: "worker-test-workspace".into(),
            generation: "worker-test-generation".into(),
        }
    }

    fn controlled_manager(limit: i64) -> (AiJobManager, ControlledWorkers) {
        let (started_tx, started) = mpsc::channel();
        let (events_tx, events) = mpsc::channel();
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut manager = AiJobManager::new(
            binding(),
            "unused-test.sqlite3".into(),
            "unused-test-workspace".into(),
            Arc::new(Mutex::new(None)),
            limit,
            Arc::new(move |snapshot| {
                let _ = events_tx.send(snapshot.clone());
            }),
        );
        let worker_active = active.clone();
        let worker_peak = peak.clone();
        manager.worker = Some(Arc::new(move |request| {
            let count = worker_active.fetch_add(1, Ordering::SeqCst) + 1;
            worker_peak.fetch_max(count, Ordering::SeqCst);
            let (finish, outcome) = mpsc::channel();
            let _ = started_tx.send(StartedWorker {
                target_key: request.target_key().to_string(),
                finish,
            });
            let success = outcome.recv().unwrap_or(false);
            worker_active.fetch_sub(1, Ordering::SeqCst);
            if success {
                Ok(AiJobResult::ProfileTest {
                    test_result: AiProfileTestResult {
                        success: true,
                        message: "controlled success".into(),
                        latency_ms: None,
                        resolved_model: None,
                    },
                })
            } else {
                Err("controlled failure".into())
            }
        }));
        (
            manager,
            ControlledWorkers {
                started,
                events,
                active,
                peak,
            },
        )
    }

    fn input(key: &str) -> AiJobEnqueueInput {
        AiJobEnqueueInput::ProfileTest {
            target_key: key.into(),
            input: AiProfileTestInput {
                id: None,
                name: "Controlled worker".into(),
                provider_family: "openai_compatible".into(),
                base_url: "https://never-called.invalid/v1".into(),
                api_key: None,
                default_model: "controlled".into(),
                supports_text: true,
                supports_image: false,
                supports_file: false,
                enabled: true,
                test_image: false,
            },
        }
    }

    impl ControlledWorkers {
        fn next(&self, key: &str) -> StartedWorker {
            let worker = self
                .started
                .recv_timeout(TIMEOUT)
                .expect("worker did not start");
            assert_eq!(worker.target_key, key);
            worker
        }

        fn terminal(&self, job_id: i64, expected: AiJobStatus) -> AiJobSnapshot {
            let deadline = Instant::now() + TIMEOUT;
            loop {
                let snapshot = self
                    .events
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .expect("terminal snapshot not emitted");
                assert_eq!(snapshot.binding, binding());
                if snapshot.id == job_id && snapshot.status.is_terminal() {
                    assert_eq!(snapshot.status, expected);
                    return snapshot;
                }
            }
        }

        fn drained(&self, manager: &AiJobManager, limit: usize) {
            let deadline = Instant::now() + TIMEOUT;
            loop {
                let state = lock_state(&manager.inner);
                if state.running_ids.is_empty() && state.requests.is_empty() {
                    break;
                }
                drop(state);
                assert!(
                    Instant::now() < deadline,
                    "workers did not release their slots"
                );
                thread::yield_now();
            }
            assert_eq!(self.active.load(Ordering::SeqCst), 0);
            assert!(self.peak.load(Ordering::SeqCst) <= limit);
            assert!(manager.list_active().is_empty());
            assert!(self.started.try_recv().is_err());
        }
    }

    #[test]
    fn cancelled_worker_retains_slot_until_success_or_error_at_limits_one_and_four() {
        for limit in [1, 4] {
            for success in [true, false] {
                let (manager, workers) = controlled_manager(limit);
                let mut blockers = Vec::new();
                for index in 0..limit {
                    let key = format!("blocked-{index}");
                    let job = manager.enqueue(input(&key));
                    blockers.push((job.id, workers.next(&key)));
                }
                let already_queued = manager.enqueue(input("before-cancel"));
                let (cancelled_id, cancelled_worker) = blockers.remove(0);
                let cancelled = manager.cancel(cancelled_id).unwrap();
                assert_eq!(cancelled.status, AiJobStatus::Cancelled);
                assert!(!manager
                    .list_active()
                    .iter()
                    .any(|job| job.id == cancelled_id));
                // A late stream chunk cannot revive the cancelled snapshot.
                manager.update_stream_text(cancelled_id, "late chunk".into());
                assert!(manager.get(cancelled_id).unwrap().stream_text.is_none());

                let next = manager.enqueue(input("after-cancel"));
                assert_eq!(
                    manager.get(next.id).unwrap().status,
                    AiJobStatus::Queued,
                    "a cancelled physical worker must still consume its slot"
                );
                assert_eq!(workers.active.load(Ordering::SeqCst), limit as usize);
                cancelled_worker.finish.send(success).unwrap();
                let queued_worker = workers.next("before-cancel");
                assert_eq!(manager.get(next.id).unwrap().status, AiJobStatus::Queued);
                let still_cancelled = manager.get(cancelled_id).unwrap();
                assert_eq!(still_cancelled.status, AiJobStatus::Cancelled);
                assert_eq!(still_cancelled.finished_at, cancelled.finished_at);
                assert!(still_cancelled.result.is_none());
                assert!(still_cancelled.error_message.is_none());
                queued_worker.finish.send(true).unwrap();
                workers.terminal(already_queued.id, AiJobStatus::Succeeded);
                workers.next("after-cancel").finish.send(true).unwrap();
                workers.terminal(next.id, AiJobStatus::Succeeded);
                for (id, worker) in blockers {
                    worker.finish.send(true).unwrap();
                    workers.terminal(id, AiJobStatus::Succeeded);
                }
                workers.drained(&manager, limit as usize);
            }
        }
    }

    #[test]
    fn repeated_cancel_and_enqueue_never_exceeds_physical_budget() {
        for limit in [1, 4] {
            let (manager, workers) = controlled_manager(limit);
            let mut running = Vec::new();
            for index in 0..limit {
                let key = format!("initial-{index}");
                let job = manager.enqueue(input(&key));
                running.push((job.id, workers.next(&key)));
            }
            for iteration in 0..16 {
                let (id, worker) = running.remove(0);
                manager.cancel(id).unwrap();
                manager.cancel(id).unwrap();
                let key = format!("replacement-{iteration}");
                let replacement = manager.enqueue(input(&key));
                assert_eq!(
                    manager.get(replacement.id).unwrap().status,
                    AiJobStatus::Queued
                );
                worker.finish.send(iteration % 2 == 0).unwrap();
                running.push((replacement.id, workers.next(&key)));
                assert!(workers.peak.load(Ordering::SeqCst) <= limit as usize);
            }
            for (id, worker) in running {
                worker.finish.send(true).unwrap();
                workers.terminal(id, AiJobStatus::Succeeded);
            }
            workers.drained(&manager, limit as usize);
        }
    }

    #[test]
    fn success_and_error_release_slots_and_start_queued_jobs() {
        for success in [true, false] {
            let (manager, workers) = controlled_manager(1);
            let first = manager.enqueue(input("first"));
            let first_worker = workers.next("first");
            let next = manager.enqueue(input("next"));
            assert_eq!(manager.list_active().len(), 2);
            assert_eq!(manager.get(next.id).unwrap().status, AiJobStatus::Queued);
            first_worker.finish.send(success).unwrap();
            let terminal = workers.terminal(
                first.id,
                if success {
                    AiJobStatus::Succeeded
                } else {
                    AiJobStatus::Failed
                },
            );
            assert_eq!(terminal.result.is_some(), success);
            assert_eq!(
                terminal.error_message.as_deref(),
                if success {
                    None
                } else {
                    Some("controlled failure")
                }
            );
            workers.next("next").finish.send(true).unwrap();
            workers.terminal(next.id, AiJobStatus::Succeeded);
            workers.drained(&manager, 1);
        }
    }

    #[test]
    fn cancelling_queued_job_never_executes_it() {
        let (manager, workers) = controlled_manager(1);
        let first = manager.enqueue(input("first"));
        let first_worker = workers.next("first");
        let cancelled = manager.enqueue(input("queued-cancel"));
        let next = manager.enqueue(input("next"));
        assert_eq!(
            manager.cancel(cancelled.id).unwrap().status,
            AiJobStatus::Cancelled
        );
        assert_eq!(manager.list_active().len(), 2);
        first_worker.finish.send(true).unwrap();
        workers.terminal(first.id, AiJobStatus::Succeeded);
        workers.next("next").finish.send(true).unwrap();
        workers.terminal(next.id, AiJobStatus::Succeeded);
        assert_eq!(
            manager.get(cancelled.id).unwrap().status,
            AiJobStatus::Cancelled
        );
        workers.drained(&manager, 1);
    }
}
