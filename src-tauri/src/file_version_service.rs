//! Shared native GUI File versions. Preflight releases storage for hashing;
//! commits use another connection to the current Host's existing database and
//! enter its lifecycle fence before mutating managed bytes or saving a receipt.
use crate::{
    agent::{
        errors::{AgentError, AgentResult, ErrorCode},
        models::WorkspaceBinding,
    },
    committed_changes::CommittedChangePublisher,
    db::file_versions::{
        CommittedVersion, GuiFileVersionIntent, GuiFileVersionMetadata, GuiFileVersionPrepare,
    },
    source_file_snapshot::FileStamp,
};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

pub(crate) fn validate_binding(
    expected: &WorkspaceBinding,
    current: &WorkspaceBinding,
) -> AgentResult<()> {
    if expected != current {
        return Err(AgentError::new(
            ErrorCode::WorkspaceChanged,
            "File Workspace was closed or reopened",
        ));
    }
    Ok(())
}
pub(crate) trait BoundFileVersionStore {
    fn gui_metadata(
        &self,
        binding: &WorkspaceBinding,
        input: &GuiFileVersionPrepare,
    ) -> AgentResult<GuiFileVersionMetadata>;
}
/// The current Host grants a connection to the existing Workspace database,
/// not a second Host or version store. No filesystem lease is held at capture.
pub(crate) struct FileCommitHost {
    binding: WorkspaceBinding,
    paths: crate::workspace::WorkspacePaths,
    secret_password: Option<String>,
    fence: Arc<crate::workspace_commit_fence::WorkspaceCommitFence>,
}
pub(crate) trait BoundFileCommitStore: CommittedChangePublisher {
    fn gui_commit_host(&self, binding: &WorkspaceBinding) -> AgentResult<FileCommitHost>;
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileVersionCommitResult {
    pub receipt: CommittedVersion,
    pub version_path: Option<String>,
}
pub(crate) trait FileBytesReader {
    fn capture(&self, path: &Path) -> AgentResult<FileHashSnapshot>;
}
pub(crate) struct FileHashSnapshot {
    path: PathBuf,
    hash: String,
    stamp: FileStamp,
    identity: crate::db::file_versions::FileIdentity,
}
fn file_io(_: impl std::fmt::Display) -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Cannot prepare or commit File Version")
}
impl FileHashSnapshot {
    fn verify(&self) -> AgentResult<()> {
        let metadata = fs::symlink_metadata(&self.path).map_err(file_io)?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || FileStamp::from_metadata(&metadata) != self.stamp
            || crate::db::file_versions::path_identity(&self.path).map_err(file_io)?
                != self.identity
        {
            return Err(AgentError::new(
                ErrorCode::SourceChanged,
                "File changed during preflight",
            ));
        }
        Ok(())
    }
}
pub(crate) struct FilesystemFileReader;
impl FileBytesReader for FilesystemFileReader {
    fn capture(&self, path: &Path) -> AgentResult<FileHashSnapshot> {
        let stamp = FileStamp::from_metadata(&fs::symlink_metadata(path).map_err(file_io)?);
        let identity = crate::db::file_versions::path_identity(path).map_err(file_io)?;
        let hash = crate::db::file_versions::checksum(path).map_err(file_io)?;
        let result = FileHashSnapshot {
            path: path.to_owned(),
            hash,
            stamp,
            identity,
        };
        result.verify()?;
        Ok(result)
    }
}
pub(crate) struct FileVersionService<'a, S, R> {
    store: &'a S,
    reader: &'a R,
}
impl<'a, S: BoundFileVersionStore, R: FileBytesReader> FileVersionService<'a, S, R> {
    pub(crate) fn new(store: &'a S, reader: &'a R) -> Self {
        Self { store, reader }
    }
    pub(crate) fn prepare_gui(
        &self,
        binding: &WorkspaceBinding,
        input: &GuiFileVersionPrepare,
    ) -> AgentResult<GuiFileVersionIntent> {
        let before = self.store.gui_metadata(binding, input)?;
        // The store call has returned: neither DB nor Workspace selection lock
        // is held during file IO. No File lease is held while reentering DB.
        crate::db::file_versions::relative(
            &before.workspace_root,
            Path::new(&before.input.managed_path),
        )
        .map_err(file_io)?;
        let original = self.reader.capture(Path::new(&before.input.managed_path))?;
        let selected = before
            .input
            .source_path
            .as_deref()
            .map(|path| self.reader.capture(Path::new(path)))
            .transpose()?;
        let after = self.store.gui_metadata(binding, input)?;
        if before != after {
            return Err(AgentError::new(
                ErrorCode::RevisionConflict,
                "File metadata changed during preflight",
            ));
        }
        // A parent can be rebound to a symlink while retaining the same final
        // inode and bytes. Recheck the managed path, not just the final file.
        crate::db::file_versions::relative(
            &before.workspace_root,
            Path::new(&before.input.managed_path),
        )
        .map_err(file_io)?;
        original.verify()?;
        if let Some(selected) = &selected {
            selected.verify()?;
        }
        Ok(GuiFileVersionIntent {
            document_id: input.document_id,
            project_id: input.project_id,
            managed_path: input.managed_path.clone(),
            expected_version_number: input.expected_version_number,
            registered_content_hash: before.registered_content_hash,
            new_content_hash: selected
                .map_or_else(|| original.hash.clone(), |selected| selected.hash),
            expected_content_hash: original.hash,
            source_path: input.source_path.clone(),
        })
    }
}
impl BoundFileVersionStore for crate::AppState {
    fn gui_metadata(
        &self,
        binding: &WorkspaceBinding,
        input: &GuiFileVersionPrepare,
    ) -> AgentResult<GuiFileVersionMetadata> {
        let current = crate::lock_mutex(&self.current_workspace);
        let runtime = current.as_ref().ok_or_else(|| {
            AgentError::new(ErrorCode::WorkspaceNotOpen, "Open a Workspace first")
        })?;
        validate_binding(binding, &runtime.agent_binding)?;
        let db = crate::lock_mutex(&runtime.db);
        db.file_version_gui_metadata(input)
    }
}
impl BoundFileCommitStore for crate::AppState {
    fn gui_commit_host(&self, binding: &WorkspaceBinding) -> AgentResult<FileCommitHost> {
        let current = crate::lock_mutex(&self.current_workspace);
        let runtime = current.as_ref().ok_or_else(|| {
            AgentError::new(ErrorCode::WorkspaceNotOpen, "Open a Workspace first")
        })?;
        validate_binding(binding, &runtime.agent_binding)?;
        let secret_password = crate::lock_mutex(&runtime.secret_state).clone();
        Ok(FileCommitHost {
            binding: runtime.agent_binding.clone(),
            paths: runtime.paths.clone(),
            secret_password,
            fence: runtime.file_commit_fence.clone(),
        })
    }
}
impl<'a, S: BoundFileCommitStore, R> FileVersionService<'a, S, R> {
    pub(crate) fn commit_gui(
        &self,
        binding: &WorkspaceBinding,
        request_id: &str,
        intent: &GuiFileVersionIntent,
        register_current_bytes: bool,
    ) -> AgentResult<FileVersionCommitResult> {
        let host = self.store.gui_commit_host(binding)?;
        // Never reacquire current_workspace or runtime.db while holding File
        // leases: Project GUI writers may own those locks and wait for us.
        let mut db = crate::db::Database::open_runtime_connection(
            &host.paths.db_path,
            &host.paths.root_path,
            host.secret_password,
        )
        .map_err(file_io)?;
        db.bind_native_workspace(&host.binding.workspace_id)
            .map_err(file_io)?;
        let before = db.committed_change_watermark()?;
        let result = db.file_version_commit_gui_bound(
            &host.binding,
            request_id,
            intent,
            register_current_bytes,
            &host.fence,
        );
        let changes = match db.committed_changes_since(&host.binding, request_id, before) {
            Ok(changes) => changes,
            Err(error) => {
                eprintln!("File notification capture failed: {}", error.message);
                None
            }
        };
        let result = result.map(|receipt| {
            let version_path = db
                .file_version_committed_path(&receipt)
                .unwrap_or_else(|error| {
                    eprintln!("Committed File path lookup failed: {error}");
                    None
                });
            FileVersionCommitResult {
                receipt,
                version_path,
            }
        });
        drop(db);
        if let Some(changes) = changes {
            self.store.publish_committed(changes);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        db::Database,
        models::{DocumentImportInput, ProjectArchiveInput, ProjectCreateInput},
    };
    use std::sync::{mpsc, Arc, Mutex};
    struct State {
        binding: WorkspaceBinding,
        db: Database,
        paths: crate::workspace::WorkspacePaths,
        fence: Arc<crate::workspace_commit_fence::WorkspaceCommitFence>,
    }
    struct Store(Mutex<State>, std::sync::atomic::AtomicUsize);
    impl CommittedChangePublisher for Store {
        fn publish_committed(&self, changes: crate::committed_changes::CommittedChanges) {
            // An unrelated GUI writer may still own storage. Reenter only
            // after File leases have gone, so its Project wait cannot deadlock.
            let state = self.0.lock().unwrap();
            for object in &changes.changed_refs {
                if object.kind != crate::agent::models::ObjectKind::File {
                    continue;
                }
                let lock_path = state
                    .paths
                    .hidden_dir
                    .join("file-version-locks")
                    .join(format!("{}.lock", object.id));
                let lock = fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(lock_path)
                    .unwrap();
                fs2::FileExt::try_lock_exclusive(&lock).expect("publish after File lease release");
            }
            self.1.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
    impl BoundFileCommitStore for Store {
        fn gui_commit_host(&self, binding: &WorkspaceBinding) -> AgentResult<FileCommitHost> {
            let state = self.0.lock().unwrap();
            if &state.binding != binding {
                return Err(AgentError::new(ErrorCode::WorkspaceChanged, "reopened"));
            }
            Ok(FileCommitHost {
                binding: state.binding.clone(),
                paths: state.paths.clone(),
                secret_password: None,
                fence: state.fence.clone(),
            })
        }
    }
    impl BoundFileVersionStore for Store {
        fn gui_metadata(
            &self,
            binding: &WorkspaceBinding,
            input: &GuiFileVersionPrepare,
        ) -> AgentResult<GuiFileVersionMetadata> {
            let state = self.0.lock().unwrap();
            if &state.binding != binding {
                return Err(AgentError::new(ErrorCode::WorkspaceChanged, "reopened"));
            }
            state.db.file_version_gui_metadata(input)
        }
    }
    fn fixture() -> (
        tempfile::TempDir,
        Arc<Store>,
        WorkspaceBinding,
        GuiFileVersionPrepare,
    ) {
        let root = tempfile::tempdir().unwrap();
        let (metadata, paths) =
            crate::workspace::create_workspace(root.path(), "password").unwrap();
        let mut db = crate::workspace_initialization::open_workspace_database(
            &paths.db_path,
            root.path(),
            None,
            &metadata.workspace_id,
        )
        .unwrap()
        .db;
        let project = db
            .project_create(ProjectCreateInput {
                name: "File preflight".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let source = root.path().join("input.txt");
        fs::write(&source, b"registered bytes\r\n").unwrap();
        let document = db
            .document_import(DocumentImportInput {
                project_id: project.id,
                source_path: source.to_string_lossy().into(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        let input = GuiFileVersionPrepare {
            document_id: document.id,
            project_id: project.id,
            managed_path: document.managed_path,
            expected_version_number: 1,
            source_path: None,
        };
        let binding = WorkspaceBinding {
            workspace_id: metadata.workspace_id,
            generation: "open-1".into(),
        };
        (
            root,
            Arc::new(Store(
                Mutex::new(State {
                    db,
                    binding: binding.clone(),
                    paths,
                    fence: Arc::new(crate::workspace_commit_fence::WorkspaceCommitFence::new()),
                }),
                std::sync::atomic::AtomicUsize::new(0),
            )),
            binding,
            input,
        )
    }
    struct PausingReader {
        pause_path: PathBuf,
        captured: mpsc::Sender<()>,
        resume: Mutex<mpsc::Receiver<()>>,
    }
    impl FileBytesReader for PausingReader {
        fn capture(&self, path: &Path) -> AgentResult<FileHashSnapshot> {
            let snapshot = FilesystemFileReader.capture(path)?;
            if path != self.pause_path {
                return Ok(snapshot);
            }
            self.captured.send(()).unwrap();
            self.resume
                .lock()
                .unwrap()
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            Ok(snapshot)
        }
    }
    #[test]
    fn file_preflight_hash_releases_db_and_refuses_archive_during_io() {
        let (_root, store, binding, input) = fixture();
        let (captured_tx, captured_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let reader = PausingReader {
            pause_path: PathBuf::from(&input.managed_path),
            captured: captured_tx,
            resume: Mutex::new(resume_rx),
        };
        let worker_store = store.clone();
        let worker_binding = binding.clone();
        let worker_input = input.clone();
        let worker = std::thread::spawn(move || {
            FileVersionService::new(&*worker_store, &reader)
                .prepare_gui(&worker_binding, &worker_input)
        });
        captured_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let (written_tx, written_rx) = mpsc::channel();
        let writer_store = store.clone();
        let writer = std::thread::spawn(move || {
            writer_store
                .0
                .lock()
                .unwrap()
                .db
                .project_set_archive(ProjectArchiveInput {
                    project_id: input.project_id,
                    is_archived: true,
                })
                .unwrap();
            written_tx.send(()).unwrap();
        });
        let completed = written_rx.recv_timeout(std::time::Duration::from_secs(1));
        resume_tx.send(()).unwrap();
        writer.join().unwrap();
        assert!(
            completed.is_ok(),
            "a real Project writer must finish while File hashing is paused"
        );
        assert_eq!(
            worker.join().unwrap().unwrap_err().code,
            ErrorCode::ScopeDenied
        );
    }
    #[test]
    fn file_preflight_rejects_same_workspace_reopen_during_hash() {
        let (_root, store, binding, input) = fixture();
        let (captured_tx, captured_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let reader = PausingReader {
            pause_path: PathBuf::from(&input.managed_path),
            captured: captured_tx,
            resume: Mutex::new(resume_rx),
        };
        let worker_store = store.clone();
        let worker = std::thread::spawn(move || {
            FileVersionService::new(&*worker_store, &reader).prepare_gui(&binding, &input)
        });
        captured_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        store.0.lock().unwrap().binding.generation = "open-2".into();
        resume_tx.send(()).unwrap();
        assert_eq!(
            worker.join().unwrap().unwrap_err().code,
            ErrorCode::WorkspaceChanged
        );
    }
    #[test]
    fn file_preflight_rejects_physical_changes_and_freezes_real_hashes() {
        let (_root, store, binding, input) = fixture();
        let intent = FileVersionService::new(&*store, &FilesystemFileReader)
            .prepare_gui(&binding, &input)
            .unwrap();
        assert_eq!(
            intent.registered_content_hash.as_ref(),
            Some(&intent.expected_content_hash)
        );
        assert_eq!(intent.new_content_hash, intent.expected_content_hash);
        let (captured_tx, captured_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let reader = PausingReader {
            pause_path: PathBuf::from(&input.managed_path),
            captured: captured_tx,
            resume: Mutex::new(resume_rx),
        };
        let worker_store = store.clone();
        let path = input.managed_path.clone();
        let worker = std::thread::spawn(move || {
            FileVersionService::new(&*worker_store, &reader).prepare_gui(&binding, &input)
        });
        captured_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        fs::write(&path, b"edited after hash").unwrap();
        resume_tx.send(()).unwrap();
        assert_eq!(
            worker.join().unwrap().unwrap_err().code,
            ErrorCode::SourceChanged
        );
        assert_eq!(fs::read(path).unwrap(), b"edited after hash");
    }
    fn paused_preflight(
        store: Arc<Store>,
        binding: WorkspaceBinding,
        input: GuiFileVersionPrepare,
        pause_path: PathBuf,
    ) -> (
        std::thread::JoinHandle<AgentResult<GuiFileVersionIntent>>,
        mpsc::Sender<()>,
    ) {
        let (captured_tx, captured_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let reader = PausingReader {
            pause_path,
            captured: captured_tx,
            resume: Mutex::new(resume_rx),
        };
        let worker = std::thread::spawn(move || {
            FileVersionService::new(&*store, &reader).prepare_gui(&binding, &input)
        });
        captured_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        (worker, resume_tx)
    }
    #[test]
    fn file_preflight_rejects_native_delete_and_rename_after_hash() {
        for delete in [false, true] {
            let (_root, store, binding, input) = fixture();
            let (worker, resume) = paused_preflight(
                store.clone(),
                binding,
                input.clone(),
                PathBuf::from(&input.managed_path),
            );
            let mut state = store.0.lock().unwrap();
            if delete {
                state
                    .db
                    .document_delete(crate::models::DocumentDeleteInput {
                        document_id: input.document_id,
                    })
                    .unwrap();
            } else {
                state
                    .db
                    .document_update_meta(crate::models::DocumentUpdateMetaInput {
                        document_id: input.document_id,
                        base_name: Some("Renamed File".into()),
                        is_starred: None,
                        tag_ids: None,
                    })
                    .unwrap();
            }
            drop(state);
            resume.send(()).unwrap();
            assert_eq!(
                worker.join().unwrap().unwrap_err().code,
                if delete {
                    ErrorCode::NotFound
                } else {
                    ErrorCode::RevisionConflict
                }
            );
        }
    }
    #[test]
    fn file_preflight_rejects_changed_selected_bytes() {
        let (root, store, binding, mut input) = fixture();
        let selected = root.path().join("selected.txt");
        fs::write(&selected, b"selected bytes").unwrap();
        input.source_path = Some(selected.to_string_lossy().into());
        let intent = FileVersionService::new(&*store, &FilesystemFileReader)
            .prepare_gui(&binding, &input)
            .unwrap();
        assert_ne!(intent.new_content_hash, intent.expected_content_hash);
        assert_eq!(
            intent.new_content_hash,
            crate::db::file_versions::checksum(&selected).unwrap()
        );
        let (worker, resume) = paused_preflight(store, binding, input, selected.clone());
        fs::write(&selected, b"different selected bytes").unwrap();
        resume.send(()).unwrap();
        assert_eq!(
            worker.join().unwrap().unwrap_err().code,
            ErrorCode::SourceChanged
        );
    }
    #[test]
    fn file_preflight_rejects_same_bytes_from_foreign_physical_file() {
        let (root, store, binding, input) = fixture();
        let path = PathBuf::from(&input.managed_path);
        let bytes = fs::read(&path).unwrap();
        let (worker, resume) = paused_preflight(store, binding, input, path.clone());
        fs::rename(&path, root.path().join("old-physical-file.txt")).unwrap();
        fs::write(&path, &bytes).unwrap();
        resume.send(()).unwrap();
        assert_eq!(
            worker.join().unwrap().unwrap_err().code,
            ErrorCode::SourceChanged
        );
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    #[test]
    fn file_preflight_does_not_register_unknown_legacy_bytes() {
        let (root, store, binding, input) = fixture();
        let conn =
            rusqlite::Connection::open(crate::workspace::workspace_paths(root.path()).db_path)
                .unwrap();
        conn.execute("DELETE FROM source_file_version_hashes", [])
            .unwrap();
        let intent = FileVersionService::new(&*store, &FilesystemFileReader)
            .prepare_gui(&binding, &input)
            .unwrap();
        assert!(intent.registered_content_hash.is_none());
        assert_eq!(intent.new_content_hash, intent.expected_content_hash);
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM source_file_version_hashes",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            count, 0,
            "preflight must not pass off current legacy bytes as a registered original"
        );
    }
    #[cfg(unix)]
    #[test]
    fn file_preflight_rejects_rebound_managed_parent_after_hash() {
        let (root, store, binding, input) = fixture();
        let path = PathBuf::from(&input.managed_path);
        let parent = path.parent().unwrap().to_owned();
        assert_ne!(parent, root.path());
        let (worker, resume) = paused_preflight(store, binding, input, path.clone());
        let moved = root.path().join("moved-managed-parent");
        fs::rename(&parent, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &parent).unwrap();
        resume.send(()).unwrap();
        assert_eq!(
            worker.join().unwrap().unwrap_err().code,
            ErrorCode::IoFailed
        );
        assert_eq!(fs::read(path).unwrap(), b"registered bytes\r\n");
    }
    fn version_intent(
        root: &Path,
        store: &Store,
        binding: &WorkspaceBinding,
        mut input: GuiFileVersionPrepare,
    ) -> GuiFileVersionIntent {
        let selected = root.join("picked.txt");
        fs::write(&selected, b"new version bytes").unwrap();
        input.source_path = Some(selected.to_string_lossy().into());
        FileVersionService::new(store, &FilesystemFileReader)
            .prepare_gui(binding, &input)
            .unwrap()
    }
    fn wait_prepared_journal(root: &Path) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if fs::read_dir(root.join(".project-mind/file-version-journal")).is_ok_and(|entries| {
                entries
                    .flatten()
                    .any(|entry| entry.path().join("journal.json").is_file())
            }) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("File must finish preparation while the Workspace commit fence is paused");
    }
    #[test]
    fn file_service_commit_preserves_history_and_stable_receipt() {
        let (root, store, binding, input) = fixture();
        let intent = version_intent(root.path(), &store, &binding, input.clone());
        let service = FileVersionService::new(&*store, &FilesystemFileReader);
        let committed = service
            .commit_gui(&binding, "service-save", &intent, false)
            .unwrap();
        assert_eq!(committed.receipt.document_id, input.document_id);
        assert_eq!(committed.receipt.version_number, 2);
        assert_eq!(
            fs::read(committed.version_path.as_ref().unwrap()).unwrap(),
            b"new version bytes"
        );
        assert_eq!(store.1.load(std::sync::atomic::Ordering::Relaxed), 1);
        let versions = store
            .0
            .lock()
            .unwrap()
            .db
            .document_list_versions(crate::models::DocumentListVersionsInput {
                document_id: input.document_id,
            })
            .unwrap();
        assert_eq!(versions.len(), 2);
        let original = versions
            .iter()
            .find(|version| version.version_number == 1)
            .unwrap();
        assert_eq!(
            fs::read(&original.managed_path).unwrap(),
            b"registered bytes\r\n"
        );
        let next_input = GuiFileVersionPrepare {
            expected_version_number: 2,
            managed_path: committed.version_path.unwrap(),
            source_path: None,
            ..input
        };
        fs::write(root.path().join("picked.txt"), b"third version").unwrap();
        let mut next_input = next_input;
        next_input.source_path = Some(root.path().join("picked.txt").to_string_lossy().into());
        let next_intent = service.prepare_gui(&binding, &next_input).unwrap();
        assert_eq!(
            service
                .commit_gui(&binding, "service-next", &next_intent, false)
                .unwrap()
                .receipt
                .version_number,
            3
        );
        let replay = service
            .commit_gui(&binding, "service-save", &intent, false)
            .unwrap();
        assert_eq!(replay.receipt, committed.receipt);
        assert_eq!(
            fs::read(replay.version_path.unwrap()).unwrap(),
            b"new version bytes"
        );
    }
    #[test]
    fn file_service_no_change_and_replay_obey_workspace_fence() {
        let (_root, store, binding, input) = fixture();
        let service = FileVersionService::new(&*store, &FilesystemFileReader);
        let intent = service.prepare_gui(&binding, &input).unwrap();
        let receipt = service
            .commit_gui(&binding, "service-no-change", &intent, false)
            .unwrap()
            .receipt;
        assert!(receipt.no_change);
        assert_eq!(receipt.version_number, 1);
        assert_eq!(
            service
                .commit_gui(&binding, "service-no-change", &intent, false)
                .unwrap()
                .receipt,
            receipt
        );
        assert_eq!(store.1.load(std::sync::atomic::Ordering::Relaxed), 0);
        store.0.lock().unwrap().fence.invalidate();
        for request_id in ["service-no-change", "closed-no-change"] {
            assert_eq!(
                service
                    .commit_gui(&binding, request_id, &intent, false)
                    .unwrap_err()
                    .code,
                ErrorCode::WorkspaceChanged
            );
        }
    }
    #[test]
    fn file_service_prepared_cancel_releases_db_and_project_lock_order() {
        let (root, store, binding, input) = fixture();
        let intent = version_intent(root.path(), &store, &binding, input.clone());
        let fence = store.0.lock().unwrap().fence.clone();
        let mut paused = fence.pause_commit();
        let worker_store = store.clone();
        let worker_binding = binding.clone();
        let worker = std::thread::spawn(move || {
            FileVersionService::new(&*worker_store, &FilesystemFileReader).commit_gui(
                &worker_binding,
                "cancel-prepared",
                &intent,
                false,
            )
        });
        wait_prepared_journal(root.path());
        // This is the GUI's real connection, not the File service connection.
        let state = store
            .0
            .try_lock()
            .expect("preparation must release the GUI storage lock");
        let todo = state
            .db
            .todo_create(crate::models::TodoCreateInput {
                scope: crate::models::TodoScope::Workspace,
                project_id: None,
                content: "write during File IO".into(),
                priority: "normal".into(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
        assert!(todo.id > 0);
        drop(state);
        let (waiting_tx, waiting_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let writer_store = store.clone();
        let project_id = input.project_id;
        let writer = std::thread::spawn(move || {
            let mut state = writer_store.0.lock().unwrap();
            waiting_tx.send(()).unwrap();
            state
                .db
                .project_set_archive(ProjectArchiveInput {
                    project_id,
                    is_archived: true,
                })
                .unwrap();
            done_tx.send(()).unwrap();
        });
        waiting_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        assert!(
            done_rx
                .recv_timeout(std::time::Duration::from_millis(50))
                .is_err(),
            "Project writer must be waiting on the actual File Project lease"
        );
        *paused = false;
        drop(paused);
        done_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("File completion must not reenter GUI storage while Project holds it");
        writer.join().unwrap();
        assert_eq!(
            worker.join().unwrap().unwrap_err().code,
            ErrorCode::WorkspaceChanged
        );
        assert_eq!(
            fs::read(&input.managed_path).unwrap(),
            b"registered bytes\r\n"
        );
        let conn =
            rusqlite::Connection::open(store.0.lock().unwrap().paths.db_path.clone()).unwrap();
        let versions: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM document_versions WHERE document_id=?1",
                [input.document_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(versions, 1);
        let pending = fs::read_dir(root.path().join(".project-mind/file-version-journal"))
            .unwrap()
            .count();
        assert_eq!(pending, 0);
    }
    #[test]
    fn file_service_never_creates_or_migrates_host_database() {
        let (root, store, binding, input) = fixture();
        let service = FileVersionService::new(&*store, &FilesystemFileReader);
        let intent = service.prepare_gui(&binding, &input).unwrap();
        let original_path = store.0.lock().unwrap().paths.db_path.clone();
        let missing_path = root.path().join("missing-host.sqlite");
        store.0.lock().unwrap().paths.db_path = missing_path.clone();
        assert_eq!(
            service
                .commit_gui(&binding, "missing-host", &intent, false)
                .unwrap_err()
                .code,
            ErrorCode::IoFailed
        );
        assert!(
            !missing_path.exists(),
            "File operations cannot create a second database"
        );
        fs::write(&missing_path, b"").unwrap();
        assert_eq!(
            service
                .commit_gui(&binding, "empty-host", &intent, false)
                .unwrap_err()
                .code,
            ErrorCode::IoFailed
        );
        assert_eq!(fs::metadata(&missing_path).unwrap().len(), 0);
        store.0.lock().unwrap().paths.db_path = original_path.clone();
        let conn = rusqlite::Connection::open(original_path).unwrap();
        conn.pragma_update(None, "user_version", 27).unwrap();
        assert_eq!(
            service
                .commit_gui(&binding, "old-schema", &intent, false)
                .unwrap_err()
                .code,
            ErrorCode::IoFailed
        );
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(
            version, 27,
            "only the Workspace initialization entry performs migrations"
        );
        assert_eq!(
            fs::read(input.managed_path).unwrap(),
            b"registered bytes\r\n"
        );
    }
    #[test]
    fn file_service_rejects_same_workspace_reopen_before_connection() {
        let (root, store, binding, input) = fixture();
        let service = FileVersionService::new(&*store, &FilesystemFileReader);
        let intent = service.prepare_gui(&binding, &input).unwrap();
        store.0.lock().unwrap().binding.generation = "open-2".into();
        assert_eq!(
            service
                .commit_gui(&binding, "queued-old-workspace", &intent, false)
                .unwrap_err()
                .code,
            ErrorCode::WorkspaceChanged
        );
        assert!(!root
            .path()
            .join(".project-mind/file-version-journal")
            .exists());
        assert_eq!(
            fs::read(input.managed_path).unwrap(),
            b"registered bytes\r\n"
        );
    }
    #[test]
    fn file_service_late_request_id_collision_restores_owned_bytes() {
        use crate::agent::instructions::{InstructionRepository, InstructionUpsert};
        let (root, store, binding, input) = fixture();
        let intent = version_intent(root.path(), &store, &binding, input.clone());
        let fence = store.0.lock().unwrap().fence.clone();
        let paused = fence.pause_commit();
        let worker_store = store.clone();
        let worker = std::thread::spawn(move || {
            FileVersionService::new(&*worker_store, &FilesystemFileReader).commit_gui(
                &binding,
                "late-request-id",
                &intent,
                false,
            )
        });
        wait_prepared_journal(root.path());
        // Another real domain operation can settle this caller/request while
        // File IO is outside the GUI database lock. Its receipt is not ours.
        let instruction = store
            .0
            .lock()
            .unwrap()
            .db
            .agent_instruction_upsert(
                "gui",
                "late-request-id",
                &InstructionUpsert {
                    id: None,
                    scope: crate::agent::models::Scope::Workspace,
                    text: "Keep the prior File original".into(),
                    enabled: true,
                    expected_revision: 0,
                },
            )
            .unwrap();
        drop(paused);
        assert_eq!(
            worker.join().unwrap().unwrap_err().code,
            ErrorCode::IdempotencyConflict
        );
        assert_eq!(
            fs::read(&input.managed_path).unwrap(),
            b"registered bytes\r\n"
        );
        let state = store.0.lock().unwrap();
        assert_eq!(
            state
                .db
                .agent_instructions_list(&crate::agent::models::Scope::Workspace, None, 100)
                .unwrap()[0]
                .id,
            instruction.id
        );
        let conn = rusqlite::Connection::open(&state.paths.db_path).unwrap();
        let versions: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM document_versions WHERE document_id=?1",
                [input.document_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(versions, 1);
        assert_eq!(
            fs::read_dir(root.path().join(".project-mind/file-version-journal"))
                .unwrap()
                .count(),
            0
        );
    }
}
