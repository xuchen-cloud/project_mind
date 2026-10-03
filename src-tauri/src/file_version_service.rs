//! File GUI preflight: read a small authoritative snapshot, release storage,
//! hash bytes, then recheck metadata and physical identity before returning.
use crate::{
    agent::{
        errors::{AgentError, AgentResult, ErrorCode},
        models::WorkspaceBinding,
    },
    db::file_versions::{GuiFileVersionIntent, GuiFileVersionMetadata, GuiFileVersionPrepare},
    source_file_snapshot::FileStamp,
};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) trait BoundFileVersionStore {
    fn gui_metadata(
        &self,
        binding: &WorkspaceBinding,
        input: &GuiFileVersionPrepare,
    ) -> AgentResult<GuiFileVersionMetadata>;
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
    AgentError::new(
        ErrorCode::IoFailed,
        "Cannot verify File bytes during preflight",
    )
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
        if &runtime.agent_binding != binding {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "File Workspace was closed or reopened",
            ));
        }
        let db = crate::lock_mutex(&runtime.db);
        db.file_version_gui_metadata(input)
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
    }
    struct Store(Mutex<State>);
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
            Arc::new(Store(Mutex::new(State {
                db,
                binding: binding.clone(),
            }))),
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
}
