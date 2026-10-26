//! Native Project File discovery, independent of page selection and AI settings.
use crate::{
    agent::{
        errors::{AgentError, AgentResult, ErrorCode},
        models::WorkspaceBinding,
    },
    committed_changes::capture_committed,
    source_service::BoundSourceStore,
};
use notify::{
    event::{MetadataKind, ModifyKind},
    Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

const POLL_INTERVAL: Duration = Duration::from_secs(5);
const PAGE_FILES: u32 = 5;

#[derive(Default)]
struct Pending {
    dirty: bool,
    full_scan: bool,
    directory_dirty: bool,
    directory_full_scope: bool,
    directory_paths: HashSet<String>,
    paths: HashSet<String>,
    error: Option<String>,
    invalidated: bool,
}
impl Pending {
    fn record_event(&mut self, root: &Path, event: &Event) -> bool {
        if !business_event(root, event) { return false; }
        self.dirty = true;
        self.directory_dirty = true;
        if event.need_rescan() || event.paths.is_empty() {
            self.full_scan = true;
            self.directory_full_scope = true;
        } else {
            for path in &event.paths {
                let mut single = event.clone();
                single.paths = vec![path.clone()];
                if !business_event(root, &single) { continue; }
                let Ok(relative_path) = path.strip_prefix(root) else { continue; };
                let Some(relative) = relative_path.to_str() else {
                    self.full_scan = true; self.directory_full_scope = true; break;
                };
                #[cfg(windows)]
                let relative = relative.replace('\\', "/");
                #[cfg(not(windows))]
                let relative = relative.to_owned();
                if relative.is_empty() {
                    self.full_scan = true; self.directory_full_scope = true; break;
                }
                if !self.directory_full_scope {
                    let parent = relative.rsplit_once('/').map_or("", |(parent, _)| parent);
                    self.directory_paths.insert(parent.to_owned());
                    // Entry additions/removals/renames may affect an expanded
                    // directory itself as well as its parent's child listing.
                    if path.is_dir() || matches!(event.kind,
                        EventKind::Create(notify::event::CreateKind::Folder)
                        | EventKind::Remove(notify::event::RemoveKind::Folder)
                        | EventKind::Modify(ModifyKind::Name(_)))
                    {
                        self.directory_paths.insert(relative.clone());
                    }
                    if self.directory_paths.len() > 256 { self.directory_full_scope = true; }
                }
                if !self.full_scan {
                    // Discovery coalesces subtrees independently from the UI's
                    // exact branch hints; a root branch hint is not a full scan.
                    if self.paths.iter().any(|parent| relative == *parent || relative.starts_with(&format!("{parent}/"))) { continue; }
                    self.paths.retain(|child| !child.starts_with(&format!("{relative}/")));
                    self.paths.insert(relative);
                    if self.paths.len() > 256 {
                        self.full_scan = true; self.directory_full_scope = true; break;
                    }
                }
            }
        }
        if self.full_scan { self.paths.clear(); }
        if self.directory_full_scope { self.directory_paths.clear(); }
        true
    }
}
fn merge_directory_notice(
    notices: &mut HashMap<Option<i64>, Option<HashSet<String>>>,
    scope: Option<i64>, paths: Option<HashSet<String>>,
) {
    use std::collections::hash_map::Entry;
    match notices.entry(scope) {
        Entry::Vacant(entry) => { entry.insert(paths); }
        Entry::Occupied(mut entry) => {
            if let (Some(current), Some(paths)) = (entry.get_mut().as_mut(), paths) {
                current.extend(paths);
                if current.len() > 256 { *entry.get_mut() = None; }
            } else { *entry.get_mut() = None; }
        }
    }
}
#[derive(Hash, PartialEq, Eq)]
struct DiscoveryFailure {
    path: String,
    state: String,
    reason: String,
}
impl DiscoveryFailure {
    fn message(&self) -> String {
        if self.state.is_empty() {
            format!("{}: {}", self.path, self.reason)
        } else {
            format!("{} [{}]: {}", self.path, self.state, self.reason)
        }
    }
}
struct ProjectProgress {
    root: Option<PathBuf>,
    watcher: Option<RecommendedWatcher>,
    pending: Arc<Mutex<Pending>>,
    watch_error: Option<String>,
    cursor: Option<String>,
    scan_path: Option<String>,
    errors: HashSet<DiscoveryFailure>,
    scan_errors: HashSet<DiscoveryFailure>,
}
impl Default for ProjectProgress {
    fn default() -> Self {
        Self {
            root: None,
            watcher: None,
            pending: Arc::new(Mutex::new(Pending {
                dirty: true,
                full_scan: true,
                ..Pending::default()
            })),
            watch_error: None,
            cursor: None,
            scan_path: None,
            errors: HashSet::new(),
            scan_errors: HashSet::new(),
        }
    }
}
impl Drop for ProjectProgress {
    fn drop(&mut self) {
        if let Some(cursor) = &self.cursor {
            crate::db::project_directory_files::discard_scan_cursor(cursor);
        }
    }
}
#[derive(Default)]
struct Driver {
    binding: Option<WorkspaceBinding>,
    projects: HashMap<Option<i64>, ProjectProgress>,
    scopes: Vec<Option<i64>>,
    next_scope: usize,
    next_catalogue: Option<Instant>,
    wake: Arc<tokio::sync::Notify>,
    directory_notices: HashMap<Option<i64>, Option<HashSet<String>>>,
    #[cfg(test)]
    scanned_pages: HashMap<Option<i64>, usize>,
}
fn io_error(error: anyhow::Error) -> AgentError {
    AgentError::new(ErrorCode::IoFailed, format!("{error:#}"))
}
/// Ignore reads and internal writes, including directory timestamps caused by
/// snapshot creation. Native backends deliver entry changes separately.
fn business_event(root: &Path, event: &Event) -> bool {
    if matches!(
        event.kind,
        EventKind::Access(_)
            | EventKind::Modify(ModifyKind::Metadata(
                MetadataKind::AccessTime | MetadataKind::WriteTime
            ))
    ) {
        return false;
    }
    if event.need_rescan() {
        return true;
    }
    event.paths.iter().any(|path| {
        let Ok(relative) = path.strip_prefix(root) else {
            return false;
        };
        if relative.components().any(|part| {
            part.as_os_str()
                .to_str()
                .is_some_and(|name| name.starts_with('.') || name.ends_with(".pm-versions"))
        }) {
            return false;
        }
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(crate::project_file_exclusions::is_temporary_file_name)
        {
            return false;
        }
        match crate::db::project_directory_files::excluded_project_path(root, path) {
            Ok(true) => return false,
            // Missing entries still have their surviving ancestors checked.
            // Other I/O errors must wake discovery so the scan reports them.
            Err(_) => return true,
            Ok(false) => {}
        }
        if (relative.as_os_str().is_empty() || path.is_dir())
            && matches!(
                event.kind,
                EventKind::Modify(
                    ModifyKind::Any | ModifyKind::Data(_) | ModifyKind::Metadata(MetadataKind::Any)
                )
            )
        {
            return false;
        }
        !relative.as_os_str().is_empty()
            || matches!(
                event.kind,
                EventKind::Create(_)
                    | EventKind::Remove(_)
                    | EventKind::Modify(
                        ModifyKind::Name(_) | ModifyKind::Metadata(MetadataKind::Permissions)
                    )
            )
    })
}
impl Driver {
    /// Catalogue checks never enumerate file trees. Each scope is subscribed
    /// before its initial scan; subsequent scans require a native dirty event.
    fn refresh_catalogue(
        &mut self,
        binding: &WorkspaceBinding,
        db: &crate::db::Database,
        now: Instant,
        report: &mut impl FnMut(&WorkspaceBinding, Option<i64>, &str),
    ) -> AgentResult<()> {
        let catalogue = db
            .project_file_discovery_catalogue(&binding.workspace_id)
            .map_err(io_error)?;
        let scopes: Vec<_> = catalogue.iter().map(|(scope, _)| *scope).collect();
        let active: HashSet<_> = scopes.iter().copied().collect();
        self.projects.retain(|scope, _| active.contains(scope));
        for (scope, root) in catalogue {
            let progress = self.projects.entry(scope).or_default();
            if progress.root.as_ref() == Some(&root) && progress.watcher.is_some() {
                continue;
            }
            if progress.root.as_ref() != Some(&root) {
                let mut next = ProjectProgress::default();
                next.root = Some(root);
                *progress = next;
            }
            let subscribed = (|| -> anyhow::Result<()> {
                let root = db.project_file_discovery_root(&binding.workspace_id, scope)?;
                // Canonical paths match native events on macOS (/var versus
                // /private/var). Canonicalization also reports a missing root.
                let watched_root = root.canonicalize()?;
                let pending = Arc::clone(&progress.pending);
                let wake = Arc::clone(&self.wake);
                let callback_root = watched_root.clone();
                let mut watcher =
                    notify::recommended_watcher(move |event: notify::Result<Event>| {
                        let mut pending = pending.lock().unwrap();
                        let changed = match event {
                            Ok(event) => {
                                let changed = pending.record_event(&callback_root, &event);
                                pending.invalidated |=
                                    event.paths.iter().any(|path| path == &callback_root)
                                        && matches!(
                                            event.kind,
                                            EventKind::Remove(_)
                                                | EventKind::Modify(ModifyKind::Name(_))
                                        );
                                changed || pending.invalidated
                            }
                            Err(error) => {
                                pending.error = Some(error.to_string());
                                pending.invalidated = true;
                                true
                            }
                        };
                        if changed {
                            wake.notify_one();
                        }
                    })?;
                watcher.watch(&watched_root, RecursiveMode::Recursive)?;
                progress.watcher = Some(watcher);
                // Recover the gap if the root was unavailable on initial setup.
                {
                    let mut pending = progress.pending.lock().unwrap();
                    pending.dirty = true;
                    pending.full_scan = true;
                    pending.paths.clear();
                }
                Ok(())
            })();
            match subscribed {
                Ok(()) => {
                    progress.watch_error = None;
                }
                Err(error) => {
                    let error = format!("Watch setup failed: {error:#}");
                    if progress.watch_error.as_ref() != Some(&error) {
                        report(binding, scope, &error);
                        progress.watch_error = Some(error);
                    }
                }
            }
        }
        self.scopes = scopes;
        self.next_scope %= self.scopes.len();
        self.next_catalogue = Some(now + POLL_INTERVAL);
        Ok(())
    }
    fn step(&mut self, store: &impl BoundSourceStore, now: Instant) -> AgentResult<bool> {
        self.step_with_report(store, now, |binding, project, error| {
            eprintln!(
                "Project File discovery workspace={} generation={} project={project:?}: {error}",
                binding.workspace_id, binding.generation
            );
        })
    }
    fn step_with_report(
        &mut self,
        store: &impl BoundSourceStore,
        now: Instant,
        mut report: impl FnMut(&WorkspaceBinding, Option<i64>, &str),
    ) -> AgentResult<bool> {
        let outcome = store.with_current(|binding, db| {
            if self.binding.as_ref() != Some(binding) {
                *self = Self {
                    binding: Some(binding.clone()),
                    ..Self::default()
                };
            }
            for (&scope, progress) in &mut self.projects {
                let (invalidated, error, directory_dirty, directory_full_scope, directory_paths) = {
                    let mut pending = progress.pending.lock().unwrap();
                    (
                        std::mem::take(&mut pending.invalidated),
                        pending.error.take(),
                        std::mem::take(&mut pending.directory_dirty),
                        std::mem::take(&mut pending.directory_full_scope),
                        std::mem::take(&mut pending.directory_paths),
                    )
                };
                if directory_dirty {
                    merge_directory_notice(&mut self.directory_notices, scope, (!directory_full_scope).then_some(directory_paths));
                }
                if let Some(error) = error {
                    let error = format!("Watch failed: {error}");
                    if progress.watch_error.as_ref() != Some(&error) {
                        report(binding, scope, &error);
                        progress.watch_error = Some(error);
                    }
                }
                if invalidated {
                    progress.watcher = None;
                    if let Some(cursor) = progress.cursor.take() {
                        crate::db::project_directory_files::discard_scan_cursor(&cursor);
                    }
                    progress.scan_path = None;
                    let mut pending = progress.pending.lock().unwrap();
                    pending.dirty = true;
                    pending.full_scan = true;
                    pending.paths.clear();
                }
            }
            if self.next_catalogue.is_none_or(|due| now >= due) {
                self.refresh_catalogue(binding, db, now, &mut report)?;
            }
            for offset in 0..self.scopes.len() {
                let index = (self.next_scope + offset) % self.scopes.len();
                let project = self.scopes[index];
                let progress = self.projects.get_mut(&project).unwrap();
                {
                    let mut pending = progress.pending.lock().unwrap();
                    if progress.cursor.is_none() {
                        if !pending.dirty {
                            continue;
                        }
                        // Events arriving during any page remain queued for a
                        // subsequent targeted pass, including already-read dirs.
                        if pending.full_scan {
                            pending.full_scan = false;
                            pending.paths.clear();
                            progress.scan_path = None;
                            pending.dirty = false;
                        } else {
                            progress.scan_path = pending.paths.iter().next().cloned();
                            if let Some(path) = &progress.scan_path {
                                pending.paths.remove(path);
                            }
                            pending.dirty = !pending.paths.is_empty();
                        }
                        progress.scan_errors.clear();
                    }
                }
                #[cfg(test)]
                {
                    *self.scanned_pages.entry(project).or_default() += 1;
                }
                let captured = capture_committed(binding, db, "project-file-discovery", || {
                    let scan = if let Some(path) = &progress.scan_path {
                        db.project_file_scan_new_at(&binding.workspace_id, project, path, progress.cursor.as_deref(), PAGE_FILES)
                    } else {
                        db.project_file_scan_new(&binding.workspace_id, project, progress.cursor.as_deref(), PAGE_FILES)
                    };
                    scan.map_err(|error| {
                        let error = crate::db::project_directory_files::FileServiceError::from_error(error);
                        if matches!(error.code, "scan_capacity" | "scan_expired") {
                            let mut pending = progress.pending.lock().unwrap();
                            pending.dirty = true;
                            if let Some(path) = &progress.scan_path { pending.paths.insert(path.clone()); }
                            else { pending.full_scan = true; }
                        }
                        io_error(anyhow::anyhow!(error.message))
                    })
                });
                let (result, changes) = match captured {
                    Ok(result) => result,
                    Err(error) => (Err(error), None),
                };
                let mut errors = vec![];
                progress.cursor = match result {
                    Ok(scan) => {
                        for failure in scan.failures {
                            errors.push(DiscoveryFailure {
                                path: failure.relative_path,
                                state: String::new(),
                                reason: failure.reason,
                            });
                        }
                        for file in scan.files.into_iter().filter(|f| f.state != "ready") {
                            errors.push(DiscoveryFailure {
                                path: file.relative_path,
                                state: file.state,
                                reason: file.reason.unwrap_or_else(|| "File is not ready".into()),
                            });
                        }
                        scan.next_cursor
                    }
                    Err(error) => {
                        errors.push(DiscoveryFailure {
                            path: String::new(),
                            state: "scan".into(),
                            reason: error.message,
                        });
                        None
                    }
                };
                for error in errors {
                    if !progress.errors.contains(&error) && !progress.scan_errors.contains(&error) {
                        report(binding, project, &error.message());
                    }
                    progress.scan_errors.insert(error);
                }
                if progress.cursor.is_none() {
                    // Keep only this complete scan's failures, so recovery
                    // rearms reporting without retaining an unbounded history.
                    if let Some(path) = &progress.scan_path {
                        progress.errors.retain(|error| error.path != *path && !error.path.starts_with(&format!("{path}/")));
                        progress.errors.extend(std::mem::take(&mut progress.scan_errors));
                    } else {
                        progress.errors = std::mem::take(&mut progress.scan_errors);
                    }
                }
                self.next_scope = (index + 1) % self.scopes.len();
                let busy = self
                    .projects
                    .values()
                    .any(|p| p.cursor.is_some() || p.pending.lock().unwrap().dirty);
                return Ok((busy, changes));
            }
            Ok((false, None))
        });
        let (busy, changes) = match outcome {
            Ok(outcome) => outcome,
            Err(error) => {
                if error.code == ErrorCode::WorkspaceNotOpen {
                    *self = Self::default();
                }
                return Err(error);
            }
        };
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
            // A notification is a UI invalidation hint, including empty-dir
            // edits. Emit after with_current released DB/workspace locks.
            if let Some(binding) = driver.binding.as_ref() {
                for (project, paths) in std::mem::take(&mut driver.directory_notices) {
                    let mut payload = serde_json::json!({"binding": binding, "projectId": project});
                    if let Some(paths) = paths {
                        let mut paths: Vec<_> = paths.into_iter().collect();
                        paths.sort();
                        payload["relativePaths"] = serde_json::json!(paths);
                    }
                    if let Err(error) = app.emit("mind:project-directory-dirty", payload) {
                        eprintln!("Cannot publish directory dirty notification: {error}");
                    }
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
            let wake = Arc::clone(&driver.wake);
            tokio::select! {
                _ = tokio::time::sleep(if busy { Duration::from_millis(250) } else { POLL_INTERVAL }) => {},
                _ = wake.notified() => {},
            }
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
    fn wait_for_native_dirty(driver: &Driver, scope: Option<i64>) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !driver.projects[&scope].pending.lock().unwrap().dirty {
            assert!(
                Instant::now() < deadline,
                "native event was not delivered for {scope:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn drain(driver: &mut Driver, store: &Store, now: Instant) {
        for _ in 0..512 {
            if !driver.step(store, now).unwrap() {
                return;
            }
        }
        panic!("dirty scopes did not finish their bounded scans");
    }
    fn finish_project_scan(
        driver: &mut Driver,
        store: &Store,
        project: i64,
        now: Instant,
        reports: &mut Vec<String>,
    ) {
        let before = driver
            .scanned_pages
            .get(&Some(project))
            .copied()
            .unwrap_or(0);
        for _ in 0..512 {
            driver
                .step_with_report(store, now, |_, owner, error| {
                    if owner == Some(project) {
                        reports.push(error.to_owned());
                    }
                })
                .unwrap();
            if driver
                .scanned_pages
                .get(&Some(project))
                .copied()
                .unwrap_or(0)
                > before
                && driver
                    .projects
                    .get(&Some(project))
                    .is_some_and(|p| p.cursor.is_none() && !p.pending.lock().unwrap().dirty)
            {
                return;
            }
        }
        panic!("Project discovery did not finish its bounded pages");
    }
    #[test]
    fn event_paths_coalesce_without_marking_the_whole_scope_dirty() {
        use notify::event::{CreateKind, DataChange};
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("copied")).unwrap();
        let mut pending = Pending::default();
        let event = Event::new(EventKind::Create(CreateKind::File)).add_path(root.path().join("copied/new.txt"));
        assert!(pending.record_event(root.path(), &event));
        assert!(pending.record_event(root.path(), &event));
        assert!(!pending.full_scan);
        assert!(pending.directory_dirty, "empty directory changes must invalidate the UI too");
        assert_eq!(pending.paths.len(), 1);
        assert_eq!(pending.directory_paths, HashSet::from(["copied".to_string()]));
        let directory = Event::new(EventKind::Create(CreateKind::Folder)).add_path(root.path().join("copied"));
        pending.record_event(root.path(), &directory);
        assert_eq!(pending.paths, HashSet::from(["copied".to_string()]));
        let modified = Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content))).add_path(root.path().join("copied/new.txt"));
        pending.record_event(root.path(), &modified);
        assert!(!pending.full_scan);
        assert_eq!(pending.paths.len(), 1);
        let root_change = Event::new(EventKind::Remove(notify::event::RemoveKind::Folder)).add_path(root.path().to_path_buf());
        pending.record_event(root.path(), &root_change);
        assert!(pending.full_scan);
        assert!(pending.directory_full_scope);
        assert!(pending.directory_paths.is_empty());
        assert!(pending.paths.is_empty());
    }

    #[test]
    fn directory_hints_merge_exact_branches_and_only_overflow_to_full_scope() {
        use notify::event::{DataChange, ModifyKind};
        let root = tempfile::tempdir().unwrap();
        let mut pending = Pending::default();
        for path in ["a/nested/file.txt", "a/nested/other.txt", "b/file.txt"] {
            let event = Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content))).add_path(root.path().join(path));
            pending.record_event(root.path(), &event);
        }
        assert_eq!(pending.directory_paths, HashSet::from(["a/nested".to_string(), "b".to_string()]));
        assert!(!pending.directory_full_scope);
        let mut notices = HashMap::new();
        merge_directory_notice(&mut notices, Some(7), Some(pending.directory_paths));
        merge_directory_notice(&mut notices, Some(7), Some(HashSet::from(["a/nested".into(), "c".into()])));
        assert_eq!(notices[&Some(7)].as_ref().unwrap().len(), 3);
        merge_directory_notice(&mut notices, Some(7), Some((0..257).map(|i| format!("wide-{i}")).collect()));
        assert!(notices[&Some(7)].is_none());
        merge_directory_notice(&mut notices, Some(7), Some(HashSet::from(["later".into()])));
        assert!(notices[&Some(7)].is_none(), "a later narrow event cannot erase full-scope invalidation");
        merge_directory_notice(&mut notices, Some(8), Some(HashSet::from(["separate".into()])));
        assert!(notices[&Some(8)].is_some());
    }

    #[test]
    fn empty_directory_events_publish_scope_hints_without_business_writes() {
        let (_root, store, projects) = fixture();
        let project = projects[0].id;
        let path = Path::new(&projects[0].root_path);
        let now = Instant::now();
        let mut driver = Driver::default();
        drain(&mut driver, &store, now);
        driver.directory_notices.clear();
        let before = store.current.lock().unwrap().1.committed_change_watermark().unwrap();
        fs::create_dir(path.join("empty-event-directory")).unwrap();
        wait_for_native_dirty(&driver, Some(project));
        drain(&mut driver, &store, now);
        assert_eq!(driver.directory_notices.keys().copied().collect::<HashSet<_>>(), HashSet::from([Some(project)]));
        assert!(driver.directory_notices[&Some(project)].as_ref().unwrap().contains(""));
        assert_eq!(store.current.lock().unwrap().1.committed_change_watermark().unwrap(), before);
        driver.directory_notices.clear();
        fs::remove_dir(path.join("empty-event-directory")).unwrap();
        wait_for_native_dirty(&driver, Some(project));
        drain(&mut driver, &store, now);
        assert_eq!(driver.directory_notices.keys().copied().collect::<HashSet<_>>(), HashSet::from([Some(project)]));
        assert!(driver.directory_notices[&Some(project)].as_ref().unwrap().contains(""));
        assert_eq!(store.current.lock().unwrap().1.committed_change_watermark().unwrap(), before);
    }

    #[test]
    fn driver_finishes_initial_pages_then_never_rescans_static_scopes() {
        let (_root, store, projects) = fixture();
        let project = projects[0].id;
        let path = std::path::Path::new(&projects[0].root_path);
        // Empty directories keep even an unchanged scan paginated by the
        // enumeration budget; known Files alone no longer consume file slots.
        for i in 0..260 {
            fs::create_dir(path.join(format!("{i:03}"))).unwrap();
        }
        fs::write(path.join("000/new.txt"), b"first page change").unwrap();
        let mut driver = Driver::default();
        let now = Instant::now();
        let mut reports = vec![];
        driver.step(&store, now).unwrap();
        assert!(driver.projects[&Some(project)].cursor.is_some());
        finish_project_scan(&mut driver, &store, project, now, &mut reports);

        while driver.step(&store, now).unwrap() {}
        let scanned = driver.scanned_pages.clone();
        fs::read(path.join("000/new.txt")).unwrap();
        fs::write(path.join(".hidden-log"), b"internal write").unwrap();
        fs::write(path.join("pending.tmp"), b"temporary write").unwrap();
        for hour in 1..=4 {
            let later = now + Duration::from_secs(hour * 3600);
            while driver.step(&store, later).unwrap() {}
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            driver
                .step(&store, now + Duration::from_secs(4 * 3600))
                .unwrap();
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            driver.scanned_pages, scanned,
            "catalogue checks must never enumerate a static file tree again"
        );
    }
    #[test]
    fn driver_native_events_preserve_mid_scan_changes_and_only_wake_the_affected_scope() {
        let (_root, store, projects) = fixture();
        let first = std::path::Path::new(&projects[0].root_path);
        let second = std::path::Path::new(&projects[1].root_path);
        for i in 0..260 {
            fs::create_dir(first.join(format!("{i:03}"))).unwrap();
        }
        let now = Instant::now();
        let mut driver = Driver::default();
        driver.step(&store, now).unwrap();
        assert!(driver.projects[&Some(projects[0].id)].cursor.is_some());
        // This directory was already enumerated by the first page. Only a
        // second full pass can discover this real native event's new File.
        fs::write(first.join("000/during.txt"), b"during scan").unwrap();
        wait_for_native_dirty(&driver, Some(projects[0].id));
        drain(&mut driver, &store, now);
        assert_eq!(
            store
                .current
                .lock()
                .unwrap()
                .1
                .project_page_get(crate::models::ProjectIdInput {
                    project_id: projects[0].id,
                })
                .unwrap()
                .project_documents[0]
                .name,
            "during.txt"
        );

        let scanned = driver.scanned_pages.clone();
        fs::write(second.join("created.txt"), b"created").unwrap();
        wait_for_native_dirty(&driver, Some(projects[1].id));
        drain(&mut driver, &store, now);
        assert_eq!(
            driver.scanned_pages[&Some(projects[0].id)],
            scanned[&Some(projects[0].id)]
        );
        assert_eq!(driver.scanned_pages[&None], scanned[&None]);
        assert!(driver.scanned_pages[&Some(projects[1].id)] > scanned[&Some(projects[1].id)]);

        fs::write(second.join("pending.tmp"), b"renamed into view").unwrap();
        fs::rename(second.join("pending.tmp"), second.join("renamed.txt")).unwrap();
        wait_for_native_dirty(&driver, Some(projects[1].id));
        drain(&mut driver, &store, now);
        assert_eq!(
            store
                .current
                .lock()
                .unwrap()
                .1
                .project_page_get(crate::models::ProjectIdInput {
                    project_id: projects[1].id,
                })
                .unwrap()
                .project_documents
                .len(),
            2
        );

        let before_mutation = driver.scanned_pages[&Some(projects[1].id)];
        fs::write(second.join("created.txt"), b"visible mutation").unwrap();
        wait_for_native_dirty(&driver, Some(projects[1].id));
        drain(&mut driver, &store, now);
        assert!(driver.scanned_pages[&Some(projects[1].id)] > before_mutation);
    }
    #[test]
    fn driver_catalogue_discovers_new_projects_and_workspace_files_and_removes_archived_watches() {
        let (root, store, projects) = fixture();
        let mut driver = Driver::default();
        let now = Instant::now();
        drain(&mut driver, &store, now);
        let scanned = driver.scanned_pages.clone();
        let old_signal = Arc::downgrade(&driver.projects[&Some(projects[0].id)].pending);
        let new_project = {
            let mut current = store.current.lock().unwrap();
            current
                .1
                .project_set_archive(crate::models::ProjectArchiveInput {
                    project_id: projects[0].id,
                    is_archived: true,
                })
                .unwrap();
            current
                .1
                .project_create(ProjectCreateInput {
                    name: "New Project".into(),
                    summary: None,
                    status: None,
                })
                .unwrap()
        };
        fs::write(
            std::path::Path::new(&new_project.root_path).join("new.txt"),
            b"new project",
        )
        .unwrap();
        fs::write(root.path().join("files/workspace.txt"), b"workspace file").unwrap();
        wait_for_native_dirty(&driver, None);
        drain(&mut driver, &store, now + POLL_INTERVAL);
        assert!(!driver.projects.contains_key(&Some(projects[0].id)));
        assert!(
            old_signal.upgrade().is_none(),
            "archived scope's native callback must be cancelled"
        );
        assert_eq!(
            driver.scanned_pages[&Some(projects[1].id)],
            scanned[&Some(projects[1].id)]
        );
        assert_eq!(
            store
                .current
                .lock()
                .unwrap()
                .1
                .project_page_get(crate::models::ProjectIdInput {
                    project_id: new_project.id,
                })
                .unwrap()
                .project_documents[0]
                .name,
            "new.txt"
        );
        assert_eq!(
            store
                .current
                .lock()
                .unwrap()
                .1
                .workspace_page_get()
                .unwrap()
                .workspace_documents[0]
                .name,
            "workspace.txt"
        );
    }
    #[test]
    fn driver_reinstalls_a_native_watch_after_its_root_disappears_and_returns() {
        let (_root, store, projects) = fixture();
        let path = std::path::Path::new(&projects[0].root_path);
        let offline = path.with_extension("offline");
        let mut driver = Driver::default();
        let now = Instant::now();
        drain(&mut driver, &store, now);
        fs::rename(path, &offline).unwrap();
        wait_for_native_dirty(&driver, Some(projects[0].id));
        drain(&mut driver, &store, now + POLL_INTERVAL);
        assert!(driver.projects[&Some(projects[0].id)].watcher.is_none());
        let scanned = driver.scanned_pages.clone();
        for minute in 1..=3 {
            drain(&mut driver, &store, now + Duration::from_secs(minute * 60));
        }
        assert_eq!(
            driver.scanned_pages, scanned,
            "watch setup failures must not cause repeated tree scans"
        );
        fs::rename(&offline, path).unwrap();
        fs::write(path.join("recovered.txt"), b"while subscription was absent").unwrap();
        drain(&mut driver, &store, now + Duration::from_secs(240));
        assert!(driver.projects[&Some(projects[0].id)].watcher.is_some());
        assert_eq!(
            store
                .current
                .lock()
                .unwrap()
                .1
                .project_page_get(crate::models::ProjectIdInput {
                    project_id: projects[0].id,
                })
                .unwrap()
                .project_documents[0]
                .name,
            "recovered.txt"
        );
    }
    #[cfg(unix)]
    #[test]
    fn driver_reports_each_persistent_directory_failure_once_across_pages_and_scans() {
        let (_root, store, projects) = fixture();
        let project = projects[0].id;
        let path = std::path::Path::new(&projects[0].root_path);
        for i in 0..260 {
            // Unix permits backslashes in names, while the real business path
            // validator rejects them. These deterministic failures survive
            // discovery and do not rely on permissions or legacy DB rows.
            let name = if [0, 130, 259].contains(&i) {
                format!("{i:03}\\invalid")
            } else {
                format!("{i:03}")
            };
            fs::create_dir(path.join(name)).unwrap();
        }
        let mut driver = Driver::default();
        let now = Instant::now();
        let mut reports = vec![];
        finish_project_scan(&mut driver, &store, project, now, &mut reports);
        assert_eq!(
            reports.len(),
            3,
            "fixture must report three independent real failures"
        );
        fs::write(path.join("wake.txt"), b"first wake").unwrap();
        wait_for_native_dirty(&driver, Some(project));
        finish_project_scan(
            &mut driver,
            &store,
            project,
            now + Duration::from_secs(60),
            &mut reports,
        );
        assert_eq!(
            reports.len(),
            3,
            "different page aggregates must not re-report persistent failures"
        );

        for i in [0, 130, 259] {
            fs::remove_dir(path.join(format!("{i:03}\\invalid"))).unwrap();
        }
        wait_for_native_dirty(&driver, Some(project));
        finish_project_scan(
            &mut driver,
            &store,
            project,
            now + Duration::from_secs(120),
            &mut reports,
        );
        assert!(driver.projects[&Some(project)].errors.is_empty(), "all three removed failure paths must be cleared before recurrence");
        for i in [0, 130, 259] {
            fs::create_dir(path.join(format!("{i:03}\\invalid"))).unwrap();
        }
        wait_for_native_dirty(&driver, Some(project));
        finish_project_scan(
            &mut driver,
            &store,
            project,
            now + Duration::from_secs(180),
            &mut reports,
        );
        assert_eq!(
            reports.len(),
            6,
            "resolved failures must be reported if they recur"
        );
    }
    #[tokio::test]
    async fn workspace_discovery_uses_only_files_root_and_shared_source_catalogue() {
        use crate::agent::{
            access::{Caller, RequestContext, ScopeGrant},
            models::{ObjectKind, Scope},
        };
        let (root, store, _) = fixture();
        fs::create_dir(root.path().join("files")).unwrap();
        fs::write(
            root.path().join("files/copied.md"),
            b"uniqueworkspacecontenttoken",
        )
        .unwrap();
        fs::write(root.path().join("never-register.md"), b"private root bytes").unwrap();
        let mut driver = Driver::default();
        for _ in 0..8 {
            driver.step(&store, Instant::now()).unwrap();
        }
        let mut current = store.current.lock().unwrap();
        let binding = current.0.clone();
        let page = current.1.workspace_page_get().unwrap();
        assert_eq!(page.workspace_documents.len(), 1);
        let id = page.workspace_documents[0].id.to_string();
        assert_eq!(page.workspace_documents[0].name, "copied.md");
        drop(current);
        assert!(store
            .events
            .lock()
            .unwrap()
            .iter()
            .flat_map(|event| &event.changed_refs)
            .any(|object| object.scope == Scope::Workspace
                && object.kind == ObjectKind::File
                && object.id == id));
        let request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "workspace-file-index".into(),
            scope_grant: ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: true,
                project_ids: vec![],
                object_keys: None,
                operations: vec!["source.read".into()],
            },
        };
        let service = crate::source_service::SourceService::new(&store);
        let progress = service
            .backfill_index_queue(&request, &Scope::Workspace, 200)
            .unwrap();
        assert!(progress.queued >= 1);
        let file_worker = crate::source_extraction_worker::SourceExtractionWorker::bundled(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"),
        )
        .unwrap();
        let record_worker =
            crate::record_document_worker::RecordDocumentWorker::development().unwrap();
        let mut indexed_file = false;
        for _ in 0..3 {
            if let Some(object) = service
                .index_next_queued(
                    &request,
                    &Scope::Workspace,
                    crate::source_service::SourceIndexBudget::default(),
                    &record_worker,
                    &file_worker,
                )
                .await
                .unwrap()
            {
                indexed_file |= object.kind == ObjectKind::File && object.id == id;
            }
        }
        assert!(
            indexed_file,
            "Workspace File must participate in the shared source catalogue"
        );
        let input = serde_json::from_value(serde_json::json!({"scope":{"kind":"workspace"},"query":"uniqueworkspacecontenttoken","kinds":["file"]})).unwrap();
        let found = service.search(&request, &input).await.unwrap();
        assert!(found
            .items
            .iter()
            .any(|item| item.source_ref.object.id == id
                && item.source_ref.object.scope == Scope::Workspace));
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
