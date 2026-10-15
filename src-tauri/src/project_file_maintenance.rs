//! Native Project File discovery, independent of page selection and AI settings.
use crate::{
    agent::{
        errors::{AgentError, AgentResult, ErrorCode},
        models::WorkspaceBinding,
    },
    committed_changes::capture_committed,
    source_service::BoundSourceStore,
};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use tauri::Manager;

const POLL_INTERVAL: Duration = Duration::from_secs(5);
const PAGE_FILES: u32 = 5;

struct ProjectProgress {
    cursor: Option<String>,
    next_poll: Instant,
    error: Option<String>,
    round: u64,
}
#[derive(Default)]
struct Driver {
    binding: Option<WorkspaceBinding>,
    after_project: i64,
    projects: HashMap<i64, ProjectProgress>,
    round: u64,
    unfinished_round: bool,
}
fn io_error(error: anyhow::Error) -> AgentError {
    AgentError::new(ErrorCode::IoFailed, format!("{error:#}"))
}
impl Driver {
    /// One bounded page in one Project, then rotate. The store holds the current
    /// binding and storage locks together, so even same-directory reopen cannot
    /// commit a page using the previous generation's cursor.
    fn step(&mut self, store: &impl BoundSourceStore, now: Instant) -> AgentResult<bool> {
        let (busy, changes) = store.with_current(|binding, db| {
            if self.binding.as_ref() != Some(binding) {
                *self = Self { binding: Some(binding.clone()), ..Self::default() };
            }
            let Some(project) = db.project_file_scan_next_project(self.after_project).map_err(io_error)? else {
                self.after_project = 0;
                self.projects.retain(|_, p| p.round == self.round);
                self.round += 1;
                return Ok((std::mem::take(&mut self.unfinished_round), None));
            };
            self.after_project = project;
            let progress = self.projects.entry(project).or_insert_with(|| ProjectProgress {
                cursor: None, next_poll: now, error: None, round: self.round,
            });
            progress.round = self.round;
            if now < progress.next_poll {
                self.unfinished_round |= progress.cursor.is_some();
                return Ok((true, None));
            }
            let captured = capture_committed(binding, db, "project-file-discovery", || {
                db.project_file_scan_new(&binding.workspace_id, project, progress.cursor.as_deref(), PAGE_FILES)
                    .map_err(io_error)
            });
            let (result, changes) = match captured {
                Ok(result) => result,
                Err(error) => (Err(error), None),
            };
            let mut errors = vec![];
            progress.cursor = match result {
                Ok(scan) => {
                    for failure in scan.failures {
                        errors.push(format!("{}: {}", failure.relative_path, failure.reason));
                    }
                    for file in scan.files.into_iter().filter(|f| f.state != "ready") {
                        errors.push(format!("{} [{}]: {}", file.relative_path, file.state,
                            file.reason.as_deref().unwrap_or("File is not ready")));
                    }
                    scan.next_cursor
                }
                Err(error) => {
                    errors.push(error.message);
                    None
                }
            };
            let error = (!errors.is_empty()).then(|| errors.join("; "));
            // Retain the last reported reason across successful pages, so one
            // inaccessible entry does not log again on every discovery pass.
            if let Some(error) = error {
                if progress.error.as_ref() != Some(&error) {
                    eprintln!("Project File discovery workspace={} generation={} project={project}: {error}",
                        binding.workspace_id, binding.generation);
                    progress.error = Some(error);
                }
            }
            progress.next_poll = if progress.cursor.is_some() { now } else { now + POLL_INTERVAL };
            self.unfinished_round |= progress.cursor.is_some();
            Ok((true, changes))
        })?;
        if let Some(changes) = changes {
            store.publish_committed(changes);
        }
        Ok(busy)
    }
}

pub(crate) fn start(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut driver = Driver::default();
        let mut last_error = None;
        loop {
            let handle = app.clone();
            // Directory enumeration, hashing and SQLite are synchronous. Keep
            // them off the async executor; at most one page is in flight.
            let joined = tauri::async_runtime::spawn_blocking(move || {
                let state = handle.state::<crate::AppState>();
                let result = driver.step(&*state, Instant::now());
                (driver, result)
            })
            .await;
            let result;
            match joined {
                Ok((next, outcome)) => {
                    driver = next;
                    result = outcome;
                }
                Err(error) => {
                    eprintln!("Project File discovery worker stopped: {error}");
                    return;
                }
            }
            let busy = match result {
                Ok(busy) => {
                    last_error = None;
                    busy
                }
                Err(error) if error.code == ErrorCode::WorkspaceNotOpen => false,
                Err(error) => {
                    if last_error.as_ref() != Some(&error.message) {
                        eprintln!("Project File discovery: {}", error.message);
                        last_error = Some(error.message);
                    }
                    false
                }
            };
            tokio::time::sleep(if busy {
                Duration::from_millis(250)
            } else {
                POLL_INTERVAL
            })
            .await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        committed_changes::{CommittedChangePublisher, CommittedChanges},
        db::Database,
        models::ProjectCreateInput,
    };
    use std::{fs, sync::Mutex};

    struct Store {
        current: Mutex<(WorkspaceBinding, Database)>,
        events: Mutex<Vec<CommittedChanges>>,
    }
    impl CommittedChangePublisher for Store {
        fn publish_committed(&self, changes: CommittedChanges) {
            assert!(
                self.current.try_lock().is_ok(),
                "publish after releasing storage"
            );
            self.events.lock().unwrap().push(changes);
        }
    }
    impl BoundSourceStore for Store {
        fn with_current<T>(
            &self,
            action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
        ) -> AgentResult<T> {
            let guard = self.current.lock().unwrap();
            action(&guard.0, &guard.1)
        }
    }
    fn fixture() -> (tempfile::TempDir, Store, Vec<crate::models::ProjectRecord>) {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("w").unwrap();
        let projects = ["First", "Second"]
            .into_iter()
            .map(|name| {
                db.project_create(ProjectCreateInput {
                    name: name.into(),
                    summary: None,
                    status: None,
                })
                .unwrap()
            })
            .collect();
        let store = Store {
            current: Mutex::new((
                WorkspaceBinding {
                    workspace_id: "w".into(),
                    generation: "g1".into(),
                },
                db,
            )),
            events: Mutex::new(vec![]),
        };
        (root, store, projects)
    }
    #[test]
    fn background_discovers_copied_folders_fairly_without_ai_and_idle_passes_do_not_write() {
        let (root, store, projects) = fixture();
        let first = std::path::Path::new(&projects[0].root_path).join("copied");
        fs::create_dir(&first).unwrap();
        for i in 0..12 {
            let name = format!("{i:02}.txt");
            fs::write(first.join(&name), &name).unwrap();
        }
        fs::write(
            std::path::Path::new(&projects[1].root_path).join("other.bin"),
            b"other",
        )
        .unwrap();
        let mut driver = Driver::default();
        let now = Instant::now();
        driver.step(&store, now).unwrap();
        driver.step(&store, now).unwrap();
        let events = store.events.lock().unwrap();
        assert!(
            events.iter().flat_map(|e| &e.changed_refs).any(|r| r.scope
                == crate::agent::models::Scope::Project {
                    project_id: projects[1].id
                }),
            "second Project must progress before first finishes"
        );
        drop(events);
        for _ in 0..16 {
            driver.step(&store, now).unwrap();
        }
        let events = store.events.lock().unwrap();
        let refs: std::collections::HashSet<_> = events
            .iter()
            .flat_map(|e| &e.changed_refs)
            .map(|r| r.key().unwrap())
            .collect();
        assert_eq!(refs.len(), 13);
        let count = events.len();
        drop(events);
        let observer = rusqlite::Connection::open(root.path().join("test.sqlite")).unwrap();
        let before: i64 = observer
            .query_row("PRAGMA data_version", [], |r| r.get(0))
            .unwrap();
        // Known paths are not rehashed: an external modification stays on its
        // existing head until the ordinary explicit resolve checks its identity.
        fs::write(first.join("00.txt"), b"externally changed").unwrap();
        for _ in 0..16 {
            driver.step(&store, now + Duration::from_secs(10)).unwrap();
        }
        assert_eq!(
            observer
                .query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            before
        );
        assert_eq!(store.events.lock().unwrap().len(), count);
    }
    #[test]
    fn reopening_same_workspace_discards_old_project_cursors() {
        let (_root, store, projects) = fixture();
        let path = std::path::Path::new(&projects[0].root_path);
        for name in [
            "a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt", "g.txt",
        ] {
            fs::write(path.join(name), name).unwrap();
        }
        let now = Instant::now();
        let mut driver = Driver::default();
        driver.step(&store, now).unwrap();
        assert!(!store.events.lock().unwrap().is_empty());
        fs::write(path.join("0.txt"), b"new generation").unwrap();
        store.current.lock().unwrap().0.generation = "g2".into();
        store.events.lock().unwrap().clear();
        driver.step(&store, now).unwrap();
        let events = store.events.lock().unwrap();
        let change = events.last().unwrap();
        assert_eq!(change.binding.generation, "g2");
        let id: i64 = change.changed_refs[0].id.parse().unwrap();
        assert_eq!(
            store
                .current
                .lock()
                .unwrap()
                .1
                .project_page_get(crate::models::ProjectIdInput {
                    project_id: projects[0].id
                })
                .unwrap()
                .project_documents
                .into_iter()
                .find(|file| file.id == id)
                .unwrap()
                .name,
            "0.txt"
        );
    }
    #[test]
    fn unavailable_project_does_not_block_discovery_in_other_projects() {
        let (_root, store, projects) = fixture();
        fs::rename(
            &projects[0].root_path,
            format!("{}.offline", projects[0].root_path),
        )
        .unwrap();
        fs::write(
            std::path::Path::new(&projects[1].root_path).join("visible.txt"),
            b"next",
        )
        .unwrap();
        let now = Instant::now();
        let mut driver = Driver::default();
        driver.step(&store, now).unwrap();
        driver.step(&store, now).unwrap();
        let events = store.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].changed_refs[0].scope,
            crate::agent::models::Scope::Project {
                project_id: projects[1].id
            }
        );
    }
}
