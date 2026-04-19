use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    thread,
};

use crate::{
    db::Database,
    models::{AiJobEnqueueInput, AiJobKind, AiJobResult, AiJobSnapshot, AiJobStatus},
};

pub const AI_JOB_EVENT: &str = "ai-job-updated";

type JobEmitter = Arc<dyn Fn(&AiJobSnapshot) + Send + Sync>;

#[derive(Clone)]
pub struct AiJobManager {
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
    running_ids: HashSet<i64>,
}

impl AiJobManager {
    pub fn new(
        db_path: PathBuf,
        workspace_root: PathBuf,
        secret_state: Arc<Mutex<Option<String>>>,
        max_concurrency: i64,
        emitter: JobEmitter,
    ) -> Self {
        Self {
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

            if kind == AiJobKind::ArtifactRefresh {
                if let Some(existing) = state
                    .jobs
                    .values()
                    .find(|job| {
                        job.kind == kind
                            && job.target_key == target_key
                            && !job.status.is_terminal()
                    })
                    .cloned()
                {
                    return existing;
                }
            }

            let job_id = state.next_id;
            state.next_id += 1;

            let snapshot = AiJobSnapshot {
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
                let secret_password = {
                    let guard = lock_secret_state(&manager.secret_state);
                    guard.clone()
                };
                let result =
                    Database::open(&manager.db_path, &manager.workspace_root, secret_password)
                        .and_then(|mut db| {
                            db.execute_ai_job_with_progress(request, |stream_text| {
                                manager.update_stream_text(job_id, stream_text);
                            })
                        });
                match result {
                    Ok(result) => manager.finish_success(job_id, result),
                    Err(error) => manager.finish_error(job_id, error.to_string()),
                }
            });
        }
    }

    fn finish_success(&self, job_id: i64, result: AiJobResult) {
        let snapshot = {
            let mut state = lock_state(&self.inner);
            state.running_ids.remove(&job_id);
            state.requests.remove(&job_id);
            let Some(snapshot) = state.jobs.get_mut(&job_id) else {
                return;
            };
            snapshot.status = AiJobStatus::Succeeded;
            snapshot.finished_at = Some(now_iso());
            snapshot.error_message = None;
            if let AiJobResult::EditorRewrite { rewrite } = &result {
                snapshot.stream_text = Some(rewrite.rewritten_markdown.clone());
            }
            snapshot.result = Some(result);
            snapshot.clone()
        };

        self.emit(&snapshot);
        self.try_start_jobs();
    }

    fn finish_error(&self, job_id: i64, error_message: String) {
        let snapshot = {
            let mut state = lock_state(&self.inner);
            state.running_ids.remove(&job_id);
            state.requests.remove(&job_id);
            let Some(snapshot) = state.jobs.get_mut(&job_id) else {
                return;
            };
            snapshot.status = AiJobStatus::Failed;
            snapshot.finished_at = Some(now_iso());
            snapshot.error_message = Some(error_message);
            snapshot.result = None;
            snapshot.clone()
        };

        self.emit(&snapshot);
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
        fs,
        path::PathBuf,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        },
        thread,
        time::{Duration, Instant},
    };

    use anyhow::Result;

    use super::AiJobManager;
    use crate::{
        db::Database,
        models::{
            AiExecutionSettings, AiJobEnqueueInput, AiJobStatus, AiProfileTestInput,
            AiProviderProfileUpsertInput,
        },
    };

    fn temp_db_path(name: &str) -> PathBuf {
        let root = std::env::temp_dir()
            .join("project_mind_ai_jobs_tests")
            .join(format!("{}_{}", name, super::now_iso().replace(':', "-")));
        fs::create_dir_all(&root).unwrap();
        root.join("app.sqlite3")
    }

    fn seed_mock_profile(db: &mut Database) -> Result<()> {
        let profile = db.ai_profile_upsert(AiProviderProfileUpsertInput {
            id: None,
            name: "Mock".to_string(),
            provider_family: "openai_compatible".to_string(),
            base_url: "https://mock.local/v1".to_string(),
            api_key: Some("mock-key".to_string()),
            default_model: "mock-model".to_string(),
            supports_text: true,
            supports_image: false,
            supports_file: false,
            enabled: true,
        })?;
        db.ai_binding_upsert(crate::models::AiCapabilityBindingUpsertInput {
            capability: "default".to_string(),
            use_default: false,
            profile_id: Some(profile.id),
            model: Some("mock-model".to_string()),
        })?;
        Ok(())
    }

    #[test]
    fn list_active_shows_queued_and_running_jobs() {
        let db_path = temp_db_path("active_jobs");
        let root = db_path.parent().unwrap().to_path_buf();
        let workspace_root = root.join("workspace");
        fs::create_dir_all(&workspace_root).unwrap();
        let mut db = Database::open(&db_path, &workspace_root, Some("secret".to_string())).unwrap();
        db.ai_execution_settings_upsert(AiExecutionSettings { max_concurrency: 1 })
            .unwrap();
        seed_mock_profile(&mut db).unwrap();
        drop(db);

        let emitted = Arc::new(AtomicUsize::new(0));
        let emitter_count = emitted.clone();
        let manager = AiJobManager::new(
            db_path,
            workspace_root,
            Arc::new(Mutex::new(Some("secret".to_string()))),
            1,
            Arc::new(move |_| {
                emitter_count.fetch_add(1, Ordering::Relaxed);
            }),
        );

        let first = manager.enqueue(AiJobEnqueueInput::ProfileTest {
            target_key: "profile-test:1".to_string(),
            input: AiProfileTestInput {
                id: Some(1),
                name: "Mock".to_string(),
                provider_family: "openai_compatible".to_string(),
                base_url: "https://mock.local/v1".to_string(),
                api_key: None,
                default_model: "mock-model".to_string(),
                supports_text: true,
                supports_image: false,
                supports_file: false,
                enabled: true,
            },
        });
        let second = manager.enqueue(AiJobEnqueueInput::ProfileTest {
            target_key: "profile-test:2".to_string(),
            input: AiProfileTestInput {
                id: Some(1),
                name: "Mock".to_string(),
                provider_family: "openai_compatible".to_string(),
                base_url: "https://mock.local/v1".to_string(),
                api_key: None,
                default_model: "mock-model".to_string(),
                supports_text: true,
                supports_image: false,
                supports_file: false,
                enabled: true,
            },
        });

        let started = Instant::now();
        loop {
            let jobs = manager.list_active();
            if jobs
                .iter()
                .any(|job| job.id == first.id && job.status == AiJobStatus::Running)
                && jobs
                    .iter()
                    .any(|job| job.id == second.id && job.status == AiJobStatus::Queued)
            {
                break;
            }

            assert!(started.elapsed() < Duration::from_secs(5));
            thread::sleep(Duration::from_millis(20));
        }

        assert!(emitted.load(Ordering::Relaxed) >= 2);
    }
}
