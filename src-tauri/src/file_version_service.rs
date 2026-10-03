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
impl FileCommitHost {
    pub(crate) fn database(&self) -> AgentResult<crate::db::Database> {
        let mut db = crate::db::Database::open_runtime_connection(&self.paths.db_path, &self.paths.root_path,
            self.secret_password.clone()).map_err(file_io)?;
        db.bind_native_workspace(&self.binding.workspace_id).map_err(file_io)?;
        Ok(db)
    }
    pub(crate) fn binding(&self) -> &WorkspaceBinding { &self.binding }
    pub(crate) fn root(&self) -> &Path { &self.paths.root_path }
    pub(crate) fn fence(&self) -> &crate::workspace_commit_fence::WorkspaceCommitFence { &self.fence }
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
    fn capture_update(
        &self,
        plan: &crate::source_file_snapshot::FileReadPlan,
    ) -> AgentResult<crate::source_file_snapshot::FileByteSnapshot> {
        crate::source_file_snapshot::capture_file_update(plan)
    }
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
impl<'a, S: BoundFileCommitStore, R: FileBytesReader> FileVersionService<'a, S, R> {
    pub(crate) fn restore_version(
        &self,
        request: &crate::agent::access::RequestContext,
        input: &crate::file_version_restore::FileVersionRestore,
    ) -> AgentResult<FileVersionCommitResult> {
        input.validate()?;
        let host = self.store.gui_commit_host(&request.binding)?;
        let mut db = host.database()?;
        if let Some(receipt) = db.file_version_restore_replay(request, host.binding(), input)? {
            let _permit = host.fence().enter()?;
            let version_path = db.file_version_committed_path(&receipt).ok().flatten();
            return Ok(FileVersionCommitResult {
                receipt,
                version_path,
            });
        }
        let before = db.committed_change_watermark()?;
        let mut committed = false;
        let result = (|| {
            let source = db.file_version_restore_source(request, host.binding(), input)?;
            let historical = self.reader.capture(&source.managed_path)?;
            if historical.hash != source.content_hash {
                return Err(AgentError::new(
                    ErrorCode::SourceChanged,
                    "Historical File bytes do not match their registered version",
                ));
            }
            let outcome = db.file_version_restore_commit_bound(
                request,
                host.binding(),
                input,
                &source,
                host.fence(),
                &|| historical.verify(),
            )?;
            committed = outcome.committed;
            let receipt = outcome.receipt;
            let version_path = db.file_version_committed_path(&receipt).ok().flatten();
            Ok(FileVersionCommitResult {
                receipt,
                version_path,
            })
        })();
        let result = match result {
            Err(error) => match db.file_version_restore_replay(request, host.binding(), input)? {
                Some(receipt) => {
                    let _permit = host.fence().enter()?;
                    let version_path = db.file_version_committed_path(&receipt).ok().flatten();
                    Ok(FileVersionCommitResult {
                        receipt,
                        version_path,
                    })
                }
                None => Err(error),
            },
            success => success,
        };
        let changes = if committed && result.is_ok() {
            db.committed_changes_since(host.binding(), &request.request_id, before)
                .unwrap_or_else(|error| {
                    eprintln!(
                        "File restore notification capture pending: {}",
                        error.message
                    );
                    None
                })
        } else {
            None
        };
        drop(db);
        if let Some(changes) = changes {
            self.store.publish_committed(changes);
        }
        result
    }
    pub(crate) fn patch_text(
        &self,
        request: &crate::agent::access::RequestContext,
        patch: &crate::file_text_patch::FileTextPatch,
    ) -> AgentResult<FileVersionCommitResult> {
        use crate::{
            db::file_versions::FileVersionUpdate,
            source_file_snapshot::{FileReadPlan, FileSourceFormat},
        };
        use sha2::{Digest, Sha256};
        let host = self.store.gui_commit_host(&request.binding)?;
        let patch_hash = patch.validate()?;
        let mut db = crate::db::Database::open_runtime_connection(
            &host.paths.db_path,
            &host.paths.root_path,
            host.secret_password,
        )
        .map_err(file_io)?;
        db.bind_native_workspace(&host.binding.workspace_id)
            .map_err(file_io)?;
        let mut update = FileVersionUpdate {
            object: patch.object.clone(),
            expected_version_number: patch.expected_version_number,
            expected_content_hash: patch.expected_content_hash.clone(),
            new_content_hash: patch.expected_content_hash.clone(),
        };
        // Reauthorize first, then replay before resolving the now-later head or
        // reading bytes. A receipt belongs to the full patch, not just its output.
        if let Some(receipt) =
            db.file_version_patch_replay(request, &host.binding, &update, &patch_hash)?
        {
            let _commit = host.fence.enter()?;
            let version_path = db.file_version_committed_path(&receipt).ok().flatten();
            return Ok(FileVersionCommitResult {
                receipt,
                version_path,
            });
        }
        let before = db.committed_change_watermark()?;
        let mut committed = false;
        let result = (|| {
            let target =
                db.file_version_registered_target(request, &host.binding, &patch.object)?;
            let format = match Path::new(&target.base_name)
                .extension()
                .and_then(|s| s.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref()
            {
                Some("txt") => FileSourceFormat::Text,
                Some("md") => FileSourceFormat::Markdown,
                Some("html" | "htm") => FileSourceFormat::Html,
                _ => {
                    return Err(AgentError::new(
                        ErrorCode::InvalidPatch,
                        "File patch supports UTF-8 md/txt/html/htm source only",
                    ))
                }
            };
            let input = GuiFileVersionPrepare {
                document_id: target.id,
                project_id: target.project_id,
                managed_path: target.managed_path.clone(),
                expected_version_number: patch.expected_version_number,
                source_path: None,
            };
            let metadata = db.file_version_gui_metadata(&input)?;
            let hash = metadata.registered_content_hash.as_ref().ok_or_else(|| {
                AgentError::new(
                    ErrorCode::FileChangedUnregistered,
                    "Register current File bytes before patching",
                )
            })?;
            if hash != &patch.expected_content_hash {
                return Err(AgentError::new(
                    ErrorCode::RevisionConflict,
                    "File patch baseline hash changed",
                ));
            }
            crate::db::file_versions::relative(
                &host.paths.root_path,
                Path::new(&input.managed_path),
            )
            .map_err(file_io)?;
            let plan = FileReadPlan {
                object: patch.object.clone(),
                file_version: patch.expected_version_number,
                registered_hash: hash.clone(),
                title: target.name,
                updated_at: target.updated_at,
                path: PathBuf::from(&target.managed_path),
                format,
            };
            // No current Workspace or GUI database locks are held. Capture exact
            // registered bytes using the existing bounded, no-follow reader.
            let base = self.reader.capture_update(&plan)?;
            let bytes = crate::file_text_patch::apply(
                &base.bytes,
                patch.edits.as_deref(),
                patch.append_text.as_deref(),
            )?;
            drop(base);
            db.file_version_registered_target(request, &host.binding, &patch.object)?;
            if db.file_version_gui_metadata(&input)? != metadata {
                return Err(AgentError::new(
                    ErrorCode::RevisionConflict,
                    "File metadata changed while preparing patch",
                ));
            }
            update.new_content_hash = format!("sha256:{:x}", Sha256::digest(&bytes));
            let outcome = db.file_version_patch_registered_bound(
                request,
                &host.binding,
                &update,
                &patch_hash,
                &bytes,
                &host.fence,
            )?;
            committed = outcome.committed;
            let receipt = outcome.receipt;
            // A later head is not this operation's result. Preserve the actual
            // receipt if path lookup fails after durable SQL commit.
            let version_path = db.file_version_committed_path(&receipt).ok().flatten();
            Ok(FileVersionCommitResult {
                receipt,
                version_path,
            })
        })();
        // Another identical call can settle after our first replay lookup but
        // before snapshot/CAS recheck. Reauthorize and recover that durable receipt.
        let result = match result {
            Err(error) => {
                match db.file_version_patch_replay(request, &host.binding, &update, &patch_hash) {
                    Ok(Some(receipt)) => host.fence.enter().map(|_commit| {
                        let version_path = db.file_version_committed_path(&receipt).ok().flatten();
                        FileVersionCommitResult {
                            receipt,
                            version_path,
                        }
                    }),
                    Ok(None) => {
                        let target = db.file_version_registered_target(
                            request,
                            &host.binding,
                            &patch.object,
                        )?;
                        if target.current_version_number != i64::from(patch.expected_version_number)
                        {
                            Err(AgentError::new(
                                ErrorCode::RevisionConflict,
                                "File Version changed while preparing patch",
                            ))
                        } else {
                            Err(error)
                        }
                    }
                    Err(error) => Err(error),
                }
            }
            success => success,
        };
        let changes = if committed && result.is_ok()
        {
            db.committed_changes_since(&host.binding, &request.request_id, before)
                .unwrap_or_else(|error| {
                    eprintln!("File patch notification capture failed: {}", error.message);
                    None
                })
        } else {
            None
        };
        drop(db);
        if let Some(changes) = changes {
            self.store.publish_committed(changes);
        }
        result
    }
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
        let changes = if result.as_ref().is_ok_and(|outcome| outcome.committed) {
            match db.committed_changes_since(&host.binding, request_id, before) {
                Ok(changes) => changes,
                Err(error) => {
                    eprintln!("File notification capture failed: {}", error.message);
                    None
                }
            }
        } else {
            None
        };
        let result = result.map(|outcome| {
            let receipt = outcome.receipt;
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
                // Another legitimate writer may take its lease immediately
                // after our commit releases it. Bounded waiting still detects
                // an own lease retained across this synchronous publisher.
                let deadline=std::time::Instant::now()+std::time::Duration::from_secs(5);
                loop {
                    match fs2::FileExt::try_lock_exclusive(&lock) {
                        Ok(())=>break,
                        Err(error) if error.kind()==std::io::ErrorKind::WouldBlock && std::time::Instant::now()<deadline=>std::thread::sleep(std::time::Duration::from_millis(1)),
                        Err(error)=>panic!("publish after File lease release: {error}"),
                    }
                }
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
        fixture_bytes("input.txt", b"registered bytes\r\n")
    }
    fn fixture_bytes(
        name: &str,
        bytes: &[u8],
    ) -> (
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
        let source = root.path().join(name);
        fs::write(&source, bytes).unwrap();
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
        assert_eq!(store.1.load(std::sync::atomic::Ordering::Relaxed), 2);
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
    fn version_count(store: &Store, document_id: i64) -> i64 {
        let state = store.0.lock().unwrap();
        rusqlite::Connection::open(&state.paths.db_path)
            .unwrap()
            .query_row(
                "SELECT version_count FROM documents WHERE id=?1",
                [document_id],
                |row| row.get(0),
            )
            .unwrap()
    }
    fn patch_request(
        binding: &WorkspaceBinding,
        input: &GuiFileVersionPrepare,
    ) -> (
        crate::agent::access::RequestContext,
        crate::file_text_patch::FileTextPatch,
    ) {
        use crate::agent::{
            access::{Caller, RequestContext, ScopeGrant},
            models::{ObjectKind, ObjectRef, Scope},
        };
        let request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "exact-patch".into(),
            scope_grant: ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: false,
                project_ids: vec![input.project_id],
                operations: vec!["file.update".into()],
            },
        };
        let patch = crate::file_text_patch::FileTextPatch {
            object: ObjectRef {
                workspace_id: binding.workspace_id.clone(),
                scope: Scope::Project {
                    project_id: input.project_id,
                },
                kind: ObjectKind::File,
                id: input.document_id.to_string(),
            },
            expected_version_number: 1,
            expected_content_hash: crate::db::file_versions::checksum(Path::new(
                &input.managed_path,
            ))
            .unwrap(),
            edits: None,
            append_text: Some("tail\n".into()),
        };
        (request, patch)
    }
    #[test]
    fn file_patch_service_commits_exact_source_and_preserves_registered_history() {
        let original = "\u{feff}<script>const 名称='old';\r\n</script>\r\n";
        let (_root, store, binding, input) = fixture_bytes("report.html", original.as_bytes());
        let (request, mut patch) = patch_request(&binding, &input);
        patch.append_text = None;
        patch.edits = Some(vec![crate::file_text_patch::TextEdit {
            old_text: "old".into(),
            new_text: "新值".into(),
            occurrence: None,
        }]);
        let service = FileVersionService::new(store.as_ref(), &FilesystemFileReader);
        let result = service.patch_text(&request, &patch).unwrap();
        assert_eq!(result.receipt.document_id, input.document_id);
        assert_eq!(result.receipt.version_number, 2);
        assert_eq!(
            fs::read(result.version_path.unwrap()).unwrap(),
            original.replace("old", "新值").as_bytes()
        );
        let state = store.0.lock().unwrap();
        let history = state
            .db
            .file_version_committed_path(&CommittedVersion {
                document_id: input.document_id,
                version_number: 1,
                content_hash: patch.expected_content_hash.clone(),
                no_change: false,
            })
            .unwrap()
            .unwrap();
        assert_eq!(fs::read(history).unwrap(), original.as_bytes());
        let registered: String = rusqlite::Connection::open(&state.paths.db_path).unwrap().query_row("SELECT h.content_hash FROM source_file_version_hashes h JOIN document_versions v ON h.document_version_id=v.id WHERE v.document_id=?1 AND v.version_number=1", [input.document_id], |row| row.get(0)).unwrap();
        assert_eq!(registered, patch.expected_content_hash);
        assert_eq!(store.1.load(std::sync::atomic::Ordering::Relaxed), 1);
    }
    #[test]
    fn file_patch_service_replays_original_receipt_after_later_version_and_rejects_equal_output_different_patch(
    ) {
        let (_root, store, binding, input) = fixture();
        let (request, patch) = patch_request(&binding, &input);
        let service = FileVersionService::new(store.as_ref(), &FilesystemFileReader);
        let first = service.patch_text(&request, &patch).unwrap();
        let mut later_request = request.clone();
        later_request.request_id = "later-patch".into();
        let mut later = patch.clone();
        later.expected_version_number = 2;
        later.expected_content_hash = first.receipt.content_hash.clone();
        later.append_text = Some("later".into());
        service.patch_text(&later_request, &later).unwrap();
        let replay = service.patch_text(&request, &patch).unwrap();
        assert_eq!(replay.receipt, first.receipt);
        assert_eq!(
            fs::read(replay.version_path.unwrap()).unwrap(),
            b"registered bytes\r\ntail\n"
        );
        let mut different = patch.clone();
        different.append_text = None;
        different.edits = Some(vec![crate::file_text_patch::TextEdit {
            old_text: "bytes\r\n".into(),
            new_text: "bytes\r\ntail\n".into(),
            occurrence: None,
        }]);
        assert_eq!(
            service.patch_text(&request, &different).unwrap_err().code,
            ErrorCode::IdempotencyConflict
        );
        assert_eq!(version_count(&store, input.document_id), 3);
        assert_eq!(store.1.load(std::sync::atomic::Ordering::Relaxed), 2);
    }
    #[test]
    fn file_patch_service_no_change_has_stable_receipt_without_outbox_or_journal() {
        let (root, store, binding, input) = fixture();
        let (request, mut patch) = patch_request(&binding, &input);
        patch.append_text = Some(String::new());
        let before = store
            .0
            .lock()
            .unwrap()
            .db
            .committed_change_watermark()
            .unwrap();
        let service = FileVersionService::new(store.as_ref(), &FilesystemFileReader);
        let result = service.patch_text(&request, &patch).unwrap();
        assert!(result.receipt.no_change);
        assert_eq!(result.receipt.version_number, 1);
        assert_eq!(
            service.patch_text(&request, &patch).unwrap().receipt,
            result.receipt
        );
        let state = store.0.lock().unwrap();
        assert_eq!(state.db.committed_change_watermark().unwrap(), before);
        assert_eq!(
            rusqlite::Connection::open(&state.paths.db_path)
                .unwrap()
                .query_row(
                    "SELECT version_count FROM documents WHERE id=?1",
                    [input.document_id],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert!(!root
            .path()
            .join(".project-mind/file-version-journal")
            .exists());
        assert_eq!(store.1.load(std::sync::atomic::Ordering::Relaxed), 0);
    }
    #[test]
    fn file_patch_service_rejects_unknown_or_external_bytes_and_non_utf8_or_wrong_format() {
        for (name, bytes, code) in [
            ("data.pdf", b"abc".as_slice(), ErrorCode::InvalidPatch),
            ("data.txt", &[0xff], ErrorCode::InvalidPatch),
        ] {
            let (_root, store, binding, input) = fixture_bytes(name, bytes);
            let (request, patch) = patch_request(&binding, &input);
            assert_eq!(
                FileVersionService::new(store.as_ref(), &FilesystemFileReader)
                    .patch_text(&request, &patch)
                    .unwrap_err()
                    .code,
                code
            );
            assert_eq!(version_count(&store, input.document_id), 1);
        }
        let (_root, store, binding, input) = fixture();
        let (request, patch) = patch_request(&binding, &input);
        let service = FileVersionService::new(store.as_ref(), &FilesystemFileReader);
        fs::write(&input.managed_path, b"external bytes").unwrap();
        assert_eq!(
            service.patch_text(&request, &patch).unwrap_err().code,
            ErrorCode::FileChangedUnregistered
        );
        assert_eq!(fs::read(&input.managed_path).unwrap(), b"external bytes");
        rusqlite::Connection::open(&store.0.lock().unwrap().paths.db_path)
            .unwrap()
            .execute("DELETE FROM source_file_version_hashes", [])
            .unwrap();
        assert_eq!(
            service.patch_text(&request, &patch).unwrap_err().code,
            ErrorCode::FileChangedUnregistered
        );
        assert_eq!(version_count(&store, input.document_id), 1);
    }
    #[test]
    fn file_patch_service_checks_real_owner_write_grant_archive_exclusion_and_generation() {
        let (_root, store, binding, input) = fixture();
        let (request, patch) = patch_request(&binding, &input);
        let service = FileVersionService::new(store.as_ref(), &FilesystemFileReader);
        let mut denied = request.clone();
        denied.scope_grant.operations = vec!["source.read".into()];
        assert_eq!(
            service.patch_text(&denied, &patch).unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        let mut forged = patch.clone();
        forged.object.scope = crate::agent::models::Scope::Project {
            project_id: input.project_id + 1,
        };
        assert_eq!(
            service.patch_text(&request, &forged).unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        let mut policy_request = request.clone();
        policy_request.request_id = "exclude".into();
        policy_request.scope_grant.operations = vec!["settings.write".into()];
        store
            .0
            .lock()
            .unwrap()
            .db
            .source_policy_update(
                &policy_request,
                &binding,
                &crate::source_service::SourcePolicyUpdate {
                    object: patch.object.clone(),
                    expected_revision: 0,
                    excluded: true,
                },
            )
            .unwrap();
        assert_eq!(
            service.patch_text(&request, &patch).unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        policy_request.request_id = "include".into();
        store
            .0
            .lock()
            .unwrap()
            .db
            .source_policy_update(
                &policy_request,
                &binding,
                &crate::source_service::SourcePolicyUpdate {
                    object: patch.object.clone(),
                    expected_revision: 1,
                    excluded: false,
                },
            )
            .unwrap();
        store
            .0
            .lock()
            .unwrap()
            .db
            .project_set_archive(ProjectArchiveInput {
                project_id: input.project_id,
                is_archived: true,
            })
            .unwrap();
        assert_eq!(
            service.patch_text(&request, &patch).unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        store.0.lock().unwrap().binding.generation = "reopen".into();
        assert_eq!(
            service.patch_text(&request, &patch).unwrap_err().code,
            ErrorCode::WorkspaceChanged
        );
        assert_eq!(version_count(&store, input.document_id), 1);
    }

    #[test]
    fn file_patch_service_outbox_failure_restores_original_then_retries_once() {
        let (root, store, binding, input) = fixture();
        let (request, patch) = patch_request(&binding, &input);
        let conn = rusqlite::Connection::open(&store.0.lock().unwrap().paths.db_path).unwrap();
        conn.execute_batch("CREATE TRIGGER reject_patch_outbox BEFORE INSERT ON agent_change_log WHEN NEW.operation='file.version.commit' BEGIN SELECT RAISE(ABORT,'outbox failed'); END;").unwrap();
        let before = store
            .0
            .lock()
            .unwrap()
            .db
            .committed_change_watermark()
            .unwrap();
        let service = FileVersionService::new(store.as_ref(), &FilesystemFileReader);
        assert_eq!(
            service.patch_text(&request, &patch).unwrap_err().code,
            ErrorCode::IoFailed
        );
        assert_eq!(
            fs::read(&input.managed_path).unwrap(),
            b"registered bytes\r\n"
        );
        assert_eq!(version_count(&store, input.document_id), 1);
        assert_eq!(
            store
                .0
                .lock()
                .unwrap()
                .db
                .committed_change_watermark()
                .unwrap(),
            before
        );
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM agent_operation_receipts WHERE request_id='exact-patch'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            fs::read_dir(root.path().join(".project-mind/file-version-journal"))
                .unwrap()
                .count(),
            0
        );
        assert_eq!(store.1.load(std::sync::atomic::Ordering::Relaxed), 0);
        conn.execute_batch("DROP TRIGGER reject_patch_outbox")
            .unwrap();
        assert_eq!(
            service
                .patch_text(&request, &patch)
                .unwrap()
                .receipt
                .version_number,
            2
        );
        assert_eq!(
            service
                .patch_text(&request, &patch)
                .unwrap()
                .receipt
                .version_number,
            2
        );
        assert_eq!(version_count(&store, input.document_id), 2);
    }
    #[test]
    fn file_patch_service_prepared_close_or_exclusion_rolls_back_and_replay_checks_fence() {
        for close in [false, true] {
            let (root, store, binding, input) = fixture();
            let (request, patch) = patch_request(&binding, &input);
            let fence = store.0.lock().unwrap().fence.clone();
            let mut paused = fence.pause_commit();
            let worker_store = store.clone();
            let worker_request = request.clone();
            let worker_patch = patch.clone();
            let worker = std::thread::spawn(move || {
                FileVersionService::new(worker_store.as_ref(), &FilesystemFileReader)
                    .patch_text(&worker_request, &worker_patch)
            });
            wait_prepared_journal(root.path());
            let state = store
                .0
                .try_lock()
                .expect("patch must release GUI storage while preparing");
            if !close {
                let mut settings = request.clone();
                settings.request_id = "exclude-during-patch".into();
                settings.scope_grant.operations = vec!["settings.write".into()];
                state
                    .db
                    .source_policy_update(
                        &settings,
                        &binding,
                        &crate::source_service::SourcePolicyUpdate {
                            object: patch.object.clone(),
                            expected_revision: 0,
                            excluded: true,
                        },
                    )
                    .unwrap();
            }
            drop(state);
            if close {
                *paused = false;
            }
            drop(paused);
            assert_eq!(
                worker.join().unwrap().unwrap_err().code,
                if close {
                    ErrorCode::WorkspaceChanged
                } else {
                    ErrorCode::ScopeDenied
                }
            );
            assert_eq!(
                fs::read(&input.managed_path).unwrap(),
                b"registered bytes\r\n"
            );
            assert_eq!(version_count(&store, input.document_id), 1);
            assert_eq!(store.1.load(std::sync::atomic::Ordering::Relaxed), 0);
            assert_eq!(
                fs::read_dir(root.path().join(".project-mind/file-version-journal"))
                    .unwrap()
                    .count(),
                0
            );
        }
        let (_root, store, binding, input) = fixture();
        let (request, patch) = patch_request(&binding, &input);
        let service = FileVersionService::new(store.as_ref(), &FilesystemFileReader);
        service.patch_text(&request, &patch).unwrap();
        store.0.lock().unwrap().fence.invalidate();
        assert_eq!(
            service.patch_text(&request, &patch).unwrap_err().code,
            ErrorCode::WorkspaceChanged
        );
    }
    #[test]
    fn file_patch_service_stale_version_and_hash_do_not_modify_current_bytes() {
        let (_root, store, binding, input) = fixture();
        let (mut request, patch) = patch_request(&binding, &input);
        let service = FileVersionService::new(store.as_ref(), &FilesystemFileReader);
        let first = service.patch_text(&request, &patch).unwrap();
        request.request_id = "stale-version".into();
        assert_eq!(
            service.patch_text(&request, &patch).unwrap_err().code,
            ErrorCode::RevisionConflict
        );
        let mut stale_hash = patch.clone();
        stale_hash.expected_version_number = 2;
        request.request_id = "stale-hash".into();
        assert_eq!(
            service.patch_text(&request, &stale_hash).unwrap_err().code,
            ErrorCode::RevisionConflict
        );
        assert_eq!(
            fs::read(first.version_path.unwrap()).unwrap(),
            b"registered bytes\r\ntail\n"
        );
        assert_eq!(version_count(&store, input.document_id), 2);
    }
    #[test]
    fn file_patch_service_concurrent_same_request_returns_one_version() {
        let (_root, store, binding, input) = fixture();
        let (request, patch) = patch_request(&binding, &input);
        struct SynchronizedReader(Arc<std::sync::Barrier>);
        impl FileBytesReader for SynchronizedReader {
            fn capture(&self, path: &Path) -> AgentResult<FileHashSnapshot> {
                let snapshot = FilesystemFileReader.capture(path)?;
                self.0.wait();
                Ok(snapshot)
            }
        }
        let snapshots = Arc::new(std::sync::Barrier::new(2));
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let store = store.clone();
            let barrier = barrier.clone();
            let request = request.clone();
            let patch = patch.clone();
            let snapshots = snapshots.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                FileVersionService::new(store.as_ref(), &SynchronizedReader(snapshots))
                    .patch_text(&request, &patch)
            }));
        }
        for worker in workers {
            assert_eq!(worker.join().unwrap().unwrap().receipt.version_number, 2);
        }
        assert_eq!(version_count(&store, input.document_id), 2);
        assert_eq!(store.1.load(std::sync::atomic::Ordering::Relaxed), 1);
    }

    #[test]
    fn file_patch_service_late_same_request_replays_after_snapshot_metadata_changed() {
        struct PausingPatchReader(mpsc::Sender<()>, Mutex<mpsc::Receiver<()>>);
        impl FileBytesReader for PausingPatchReader {
            fn capture(&self, path: &Path) -> AgentResult<FileHashSnapshot> {
                FilesystemFileReader.capture(path)
            }
            fn capture_update(
                &self,
                plan: &crate::source_file_snapshot::FileReadPlan,
            ) -> AgentResult<crate::source_file_snapshot::FileByteSnapshot> {
                let snapshot = crate::source_file_snapshot::capture_file_update(plan)?;
                self.0.send(()).unwrap();
                self.1
                    .lock()
                    .unwrap()
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                Ok(snapshot)
            }
        }
        let (_root, store, binding, input) = fixture();
        let (request, patch) = patch_request(&binding, &input);
        let (captured_tx, captured_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let worker_store = store.clone();
        let worker_request = request.clone();
        let worker_patch = patch.clone();
        let worker = std::thread::spawn(move || {
            FileVersionService::new(
                worker_store.as_ref(),
                &PausingPatchReader(captured_tx, Mutex::new(resume_rx)),
            )
            .patch_text(&worker_request, &worker_patch)
        });
        captured_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let committed = FileVersionService::new(store.as_ref(), &FilesystemFileReader)
            .patch_text(&request, &patch)
            .unwrap();
        resume_tx.send(()).unwrap();
        assert_eq!(worker.join().unwrap().unwrap().receipt, committed.receipt);
        assert_eq!(version_count(&store, input.document_id), 2);
    }

    #[test]
    #[ignore = "child process fixture invoked by File patch crash parent"]
    fn file_patch_crash_process_fixture() {
        let Some(root) = std::env::var_os("MIND_FILE_PATCH_CRASH_FIXTURE") else {
            return;
        };
        let root = Path::new(&root);
        let (metadata, paths) = crate::workspace::load_metadata(root).unwrap();
        let db = crate::workspace_initialization::open_workspace_database(
            &paths.db_path,
            root,
            None,
            &metadata.workspace_id,
        )
        .unwrap()
        .db;
        let patch: crate::file_text_patch::FileTextPatch =
            serde_json::from_slice(&fs::read(root.join("patch.fixture.json")).unwrap()).unwrap();
        let binding = WorkspaceBinding {
            workspace_id: metadata.workspace_id,
            generation: "fixture-open".into(),
        };
        let request = crate::agent::access::RequestContext {
            binding: binding.clone(),
            caller: crate::agent::access::Caller::Gui,
            request_id: "exact-patch".into(),
            scope_grant: crate::agent::access::ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: false,
                project_ids: vec![match patch.object.scope {
                    crate::agent::models::Scope::Project { project_id } => project_id,
                    _ => panic!("File needs Project"),
                }],
                operations: vec!["file.update".into()],
            },
        };
        let store = Store(
            Mutex::new(State {
                binding,
                db,
                paths,
                fence: Arc::new(crate::workspace_commit_fence::WorkspaceCommitFence::new()),
            }),
            std::sync::atomic::AtomicUsize::new(0),
        );
        FileVersionService::new(&store, &FilesystemFileReader)
            .patch_text(&request, &patch)
            .unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn file_patch_service_recovers_six_actual_process_kills_and_retries_once() {
        use std::os::unix::process::ExitStatusExt;
        for stage in 0..=5 {
            let (root, store, binding, input) = fixture();
            let (mut request, patch) = patch_request(&binding, &input);
            let before = store
                .0
                .lock()
                .unwrap()
                .db
                .committed_change_watermark()
                .unwrap();
            fs::write(
                root.path().join("patch.fixture.json"),
                serde_json::to_vec(&patch).unwrap(),
            )
            .unwrap();
            drop(store);
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "file_version_service::tests::file_patch_crash_process_fixture",
                    "--ignored",
                ])
                .env("MIND_FILE_PATCH_CRASH_FIXTURE", root.path())
                .env("MIND_FILE_VERSION_CRASH_STAGE", stage.to_string())
                .output()
                .unwrap();
            assert_eq!(
                output.status.signal(),
                Some(9),
                "actual SIGKILL at stage {stage}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let (metadata, paths) = crate::workspace::load_metadata(root.path()).unwrap();
            let db = crate::workspace_initialization::open_workspace_database(
                &paths.db_path,
                root.path(),
                None,
                &metadata.workspace_id,
            )
            .unwrap()
            .db;
            let binding = WorkspaceBinding {
                generation: "recovered-open".into(),
                ..binding
            };
            request.binding = binding.clone();
            let store = Store(
                Mutex::new(State {
                    db,
                    paths,
                    binding,
                    fence: Arc::new(crate::workspace_commit_fence::WorkspaceCommitFence::new()),
                }),
                std::sync::atomic::AtomicUsize::new(0),
            );
            assert_eq!(
                version_count(&store, input.document_id),
                if stage < 5 { 1 } else { 2 }
            );
            assert_eq!(
                store
                    .0
                    .lock()
                    .unwrap()
                    .db
                    .committed_change_watermark()
                    .unwrap(),
                before + i64::from(stage == 5)
            );
            if stage < 5 {
                assert_eq!(
                    fs::read(&input.managed_path).unwrap(),
                    b"registered bytes\r\n"
                );
            }
            let service = FileVersionService::new(&store, &FilesystemFileReader);
            let receipt = service.patch_text(&request, &patch).unwrap().receipt;
            assert_eq!(receipt.version_number, 2);
            assert_eq!(
                service.patch_text(&request, &patch).unwrap().receipt,
                receipt
            );
            assert_eq!(version_count(&store, input.document_id), 2);
            assert_eq!(
                store
                    .0
                    .lock()
                    .unwrap()
                    .db
                    .committed_change_watermark()
                    .unwrap(),
                before + 1
            );
            let versions = store
                .0
                .lock()
                .unwrap()
                .db
                .document_list_versions(crate::models::DocumentListVersionsInput {
                    document_id: input.document_id,
                })
                .unwrap();
            let old = versions.iter().find(|v| v.version_number == 1).unwrap();
            let new = versions.iter().find(|v| v.version_number == 2).unwrap();
            assert_eq!(
                fs::read(&old.managed_path).unwrap(),
                b"registered bytes\r\n"
            );
            assert_eq!(
                fs::read(&new.managed_path).unwrap(),
                b"registered bytes\r\ntail\n"
            );
            assert_eq!(
                fs::read_dir(root.path().join(".project-mind/file-version-journal"))
                    .unwrap()
                    .count(),
                0
            );
        }
    }
    struct UploadClock(std::sync::atomic::AtomicI64);
    impl crate::file_content::FileContentClock for UploadClock {
        fn now_ms(&self) -> AgentResult<i64> {
            Ok(self.0.load(std::sync::atomic::Ordering::Relaxed))
        }
    }
    fn upload_input(
        binding: &WorkspaceBinding,
        input: &GuiFileVersionPrepare,
        bytes: &[u8],
    ) -> (
        crate::agent::access::RequestContext,
        crate::file_content::FileContentBegin,
    ) {
        use sha2::{Digest, Sha256};
        let (mut request, patch) = patch_request(binding, input);
        request.request_id = "upload-begin".into();
        (
            request,
            crate::file_content::FileContentBegin {
                object: patch.object,
                expected_version_number: 1,
                expected_content_hash: patch.expected_content_hash,
                length: bytes.len() as u64,
                content_hash: format!("sha256:{:x}", Sha256::digest(bytes)),
            },
        )
    }
    fn upload_update(
        input: &crate::file_content::FileContentBegin,
        ticket: &crate::file_content::FileContentTicket,
    ) -> crate::file_content::FileContentUpdate {
        crate::file_content::FileContentUpdate {
            object: input.object.clone(),
            expected_version_number: input.expected_version_number,
            expected_content_hash: input.expected_content_hash.clone(),
            staged_content_id: ticket.staged_content_id.clone(),
        }
    }
    #[test]
    fn file_upload_binary_chunks_seal_commit_same_file_and_replay_after_expiry() {
        let old = b"PK\x03\x04original docx bytes\x00\xff";
        let new = b"PK\x03\x04new docx bytes\x00\xfe";
        let (_root, store, binding, input) = fixture_bytes("report.docx", old);
        let (mut request, begin) = upload_input(&binding, &input, new);
        let clock = UploadClock(std::sync::atomic::AtomicI64::new(1000));
        let service = crate::file_content::FileContentService::new(store.as_ref(), &clock);
        let ticket = service.begin(&request, &begin).unwrap();
        assert_eq!(service.begin(&request, &begin).unwrap(), ticket);
        assert_eq!(ticket.expires_at_ms, 601000);
        request.request_id = "chunk-1".into();
        assert_eq!(
            service
                .append(&request, &ticket.staged_content_id, 0, &new[..8])
                .unwrap()
                .received_length,
            8
        );
        assert_eq!(
            service
                .append(&request, &ticket.staged_content_id, 0, &new[..8])
                .unwrap()
                .received_length,
            8
        );
        request.request_id = "chunk-2".into();
        assert_eq!(
            service
                .append(&request, &ticket.staged_content_id, 8, &new[8..])
                .unwrap()
                .received_length,
            new.len() as u64
        );
        assert!(
            !service
                .status(&request, &ticket.staged_content_id)
                .unwrap()
                .ready
        );
        request.request_id = "seal".into();
        assert!(
            service
                .finish(&request, &ticket.staged_content_id)
                .unwrap()
                .ready
        );
        assert!(
            service
                .finish(&request, &ticket.staged_content_id)
                .unwrap()
                .ready
        );
        assert_eq!(version_count(&store, input.document_id), 1);
        request.request_id = "upload-commit".into();
        let update = upload_update(&begin, &ticket);
        let result = service.update(&request, &update).unwrap();
        assert_eq!(result.receipt.document_id, input.document_id);
        assert_eq!(result.receipt.version_number, 2);
        assert_eq!(fs::read(result.version_path.unwrap()).unwrap(), new);
        let versions = store
            .0
            .lock()
            .unwrap()
            .db
            .document_list_versions(crate::models::DocumentListVersionsInput {
                document_id: input.document_id,
            })
            .unwrap();
        let original = versions.iter().find(|v| v.version_number == 1).unwrap();
        assert_eq!(fs::read(&original.managed_path).unwrap(), old);
        assert!(versions
            .iter()
            .all(|v| Path::new(&v.managed_path).extension().unwrap() == "docx"));
        clock.0.store(601000, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(
            service.update(&request, &update).unwrap().receipt,
            result.receipt
        );
        request.request_id = "other-commit".into();
        assert!(service.update(&request, &update).is_err());
        assert_eq!(version_count(&store, input.document_id), 2);
    }
    #[test]
    fn file_upload_rejects_overflow_chunk_order_incomplete_hash_and_payload_conflicts() {
        let (_root, store, binding, input) = fixture();
        let (mut request, begin) = upload_input(&binding, &input, b"abcdef");
        let clock = UploadClock(std::sync::atomic::AtomicI64::new(1000));
        let service = crate::file_content::FileContentService::new(store.as_ref(), &clock);
        let mut oversized = begin.clone();
        oversized.length = crate::file_content::MAX_CONTENT + 1;
        assert_eq!(
            service.begin(&request, &oversized).unwrap_err().code,
            ErrorCode::BudgetExceeded
        );
        let ticket = service.begin(&request, &begin).unwrap();
        assert_eq!(
            service.begin(&request, &oversized).unwrap_err().code,
            ErrorCode::BudgetExceeded
        );
        request.request_id = "chunk".into();
        assert_eq!(
            service
                .append(
                    &request,
                    &ticket.staged_content_id,
                    0,
                    &vec![b'x'; crate::file_content::MAX_CHUNK + 1]
                )
                .unwrap_err()
                .code,
            ErrorCode::BudgetExceeded
        );
        assert_eq!(
            service
                .append(&request, &ticket.staged_content_id, 2, b"ab")
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            service
                .append(&request, &ticket.staged_content_id, u64::MAX, b"ab")
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            service
                .append(&request, &ticket.staged_content_id, 0, b"")
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        service
            .append(&request, &ticket.staged_content_id, 0, b"abc")
            .unwrap();
        assert_eq!(
            service
                .append(&request, &ticket.staged_content_id, 0, b"xyz")
                .unwrap_err()
                .code,
            ErrorCode::IdempotencyConflict
        );
        request.request_id = "seal-incomplete".into();
        assert_eq!(
            service
                .finish(&request, &ticket.staged_content_id)
                .unwrap_err()
                .code,
            ErrorCode::SourceNotReady
        );
        request.request_id = "rest".into();
        service
            .append(&request, &ticket.staged_content_id, 3, b"deg")
            .unwrap();
        request.request_id = "seal-bad-hash".into();
        assert_eq!(
            service
                .finish(&request, &ticket.staged_content_id)
                .unwrap_err()
                .code,
            ErrorCode::SourceChanged
        );
        assert_eq!(version_count(&store, input.document_id), 1);
    }
    #[test]
    fn file_upload_expiry_and_caller_scope_fences_never_mutate_file() {
        let (_root, store, binding, input) = fixture();
        let (mut request, begin) = upload_input(&binding, &input, b"new bytes");
        let clock = UploadClock(std::sync::atomic::AtomicI64::new(1000));
        let service = crate::file_content::FileContentService::new(store.as_ref(), &clock);
        let ticket = service.begin(&request, &begin).unwrap();
        request.request_id = "chunk".into();
        let mut other = request.clone();
        other.caller = crate::agent::access::Caller::Connection {
            grant_id: "other-owner".into(),
        };
        assert_eq!(
            service
                .append(&other, &ticket.staged_content_id, 0, b"new bytes")
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        let mut changed_scope = request.clone();
        changed_scope
            .scope_grant
            .project_ids
            .push(input.project_id + 1);
        assert_eq!(
            service
                .append(&changed_scope, &ticket.staged_content_id, 0, b"new bytes")
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        clock.0.store(601000, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(
            service
                .append(&request, &ticket.staged_content_id, 0, b"new bytes")
                .unwrap_err()
                .code,
            ErrorCode::StagedContentExpired
        );
        assert_eq!(
            service
                .finish(&request, &ticket.staged_content_id)
                .unwrap_err()
                .code,
            ErrorCode::StagedContentExpired
        );
        request.request_id = "expired-commit".into();
        assert_eq!(
            service
                .update(&request, &upload_update(&begin, &ticket))
                .unwrap_err()
                .code,
            ErrorCode::StagedContentExpired
        );
        assert_eq!(version_count(&store, input.document_id), 1);
        assert_eq!(
            fs::read(&input.managed_path).unwrap(),
            b"registered bytes\r\n"
        );
    }
    #[test]
    fn file_upload_no_change_consumes_stage_once_and_unregistered_or_external_baselines_are_rejected(
    ) {
        let (_root, store, binding, input) = fixture();
        let bytes = b"registered bytes\r\n";
        let (mut request, begin) = upload_input(&binding, &input, bytes);
        let clock = UploadClock(std::sync::atomic::AtomicI64::new(1000));
        let service = crate::file_content::FileContentService::new(store.as_ref(), &clock);
        let ticket = service.begin(&request, &begin).unwrap();
        request.request_id = "chunk".into();
        service
            .append(&request, &ticket.staged_content_id, 0, bytes)
            .unwrap();
        request.request_id = "seal".into();
        service.finish(&request, &ticket.staged_content_id).unwrap();
        let before = store
            .0
            .lock()
            .unwrap()
            .db
            .committed_change_watermark()
            .unwrap();
        request.request_id = "no-change-commit".into();
        let update = upload_update(&begin, &ticket);
        let receipt = service.update(&request, &update).unwrap().receipt;
        assert!(receipt.no_change);
        assert_eq!(receipt.version_number, 1);
        assert_eq!(service.update(&request, &update).unwrap().receipt, receipt);
        request.request_id = "reuse-content".into();
        assert_eq!(
            service.update(&request, &update).unwrap_err().code,
            ErrorCode::IdempotencyConflict
        );
        assert_eq!(
            store
                .0
                .lock()
                .unwrap()
                .db
                .committed_change_watermark()
                .unwrap(),
            before
        );
        assert_eq!(store.1.load(std::sync::atomic::Ordering::Relaxed), 0);
        request.request_id = "changed-baseline".into();
        fs::write(&input.managed_path, b"external edited").unwrap();
        assert_eq!(
            service.begin(&request, &begin).unwrap_err().code,
            ErrorCode::FileChangedUnregistered
        );
        rusqlite::Connection::open(&store.0.lock().unwrap().paths.db_path)
            .unwrap()
            .execute("DELETE FROM source_file_version_hashes", [])
            .unwrap();
        assert_eq!(
            service.begin(&request, &begin).unwrap_err().code,
            ErrorCode::FileChangedUnregistered
        );
    }

    #[test]
    fn file_upload_empty_content_quota_expiry_and_foreign_files_are_preserved() {
        let (root, store, binding, input) = fixture();
        let (mut request, begin) = upload_input(&binding, &input, b"");
        let clock = UploadClock(std::sync::atomic::AtomicI64::new(1000));
        let service = crate::file_content::FileContentService::new(store.as_ref(), &clock);
        let ticket = service.begin(&request, &begin).unwrap();
        request.request_id = "empty-seal".into();
        assert!(
            service
                .finish(&request, &ticket.staged_content_id)
                .unwrap()
                .ready
        );
        request.request_id = "empty-commit".into();
        let result = service
            .update(&request, &upload_update(&begin, &ticket))
            .unwrap();
        assert_eq!(fs::read(result.version_path.unwrap()).unwrap(), b"");
        let mut next = begin.clone();
        next.expected_version_number = 2;
        next.expected_content_hash = begin.content_hash.clone();
        let mut tickets = Vec::new();
        for n in 0..4 {
            request.request_id = format!("begin-{n}");
            tickets.push(service.begin(&request, &next).unwrap());
        }
        request.request_id = "over-quota".into();
        assert_eq!(
            service.begin(&request, &next).unwrap_err().code,
            ErrorCode::BudgetExceeded
        );
        let dir = root
            .path()
            .join(".project-mind/file-content-stage")
            .join(&tickets[0].staged_content_id);
        fs::write(dir.join("foreign-user-file"), b"must remain").unwrap();
        clock.0.store(601000, std::sync::atomic::Ordering::Relaxed);
        let replacement = service.begin(&request, &next).unwrap();
        assert_eq!(replacement.expires_at_ms, 1201000);
        assert_eq!(
            fs::read(dir.join("foreign-user-file")).unwrap(),
            b"must remain"
        );
        assert_eq!(version_count(&store, input.document_id), 2);
    }
    #[test]
    fn file_upload_rechecks_expiry_after_file_preparation_and_can_retry_same_commit() {
        struct ExpiresDuringPreparation(std::sync::atomic::AtomicUsize);
        impl crate::file_content::FileContentClock for ExpiresDuringPreparation {
            fn now_ms(&self) -> AgentResult<i64> {
                Ok(
                    if self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed) == 0 {
                        1000
                    } else {
                        601000
                    },
                )
            }
        }
        let (_root, store, binding, input) = fixture();
        let (mut request, begin) = upload_input(&binding, &input, b"updated bytes");
        let clock = UploadClock(std::sync::atomic::AtomicI64::new(1000));
        let service = crate::file_content::FileContentService::new(store.as_ref(), &clock);
        let ticket = service.begin(&request, &begin).unwrap();
        request.request_id = "chunk".into();
        service
            .append(&request, &ticket.staged_content_id, 0, b"updated bytes")
            .unwrap();
        request.request_id = "seal".into();
        service.finish(&request, &ticket.staged_content_id).unwrap();
        request.request_id = "commit".into();
        let update = upload_update(&begin, &ticket);
        let expires = ExpiresDuringPreparation(std::sync::atomic::AtomicUsize::new(0));
        assert_eq!(
            crate::file_content::FileContentService::new(store.as_ref(), &expires)
                .update(&request, &update)
                .unwrap_err()
                .code,
            ErrorCode::StagedContentExpired
        );
        assert_eq!(version_count(&store, input.document_id), 1);
        assert_eq!(
            fs::read(&input.managed_path).unwrap(),
            b"registered bytes\r\n"
        );
        assert_eq!(
            service
                .update(&request, &update)
                .unwrap()
                .receipt
                .version_number,
            2
        );
    }
    #[test]
    fn file_upload_scope_exclusion_archive_and_generation_changes_are_checked_each_call() {
        let (_root, store, binding, input) = fixture();
        let (mut request, begin) = upload_input(&binding, &input, b"updated bytes");
        let clock = UploadClock(std::sync::atomic::AtomicI64::new(1000));
        let service = crate::file_content::FileContentService::new(store.as_ref(), &clock);
        let ticket = service.begin(&request, &begin).unwrap();
        request.request_id = "chunk".into();
        let mut stale = request.clone();
        stale.binding.generation = "old-generation".into();
        assert_eq!(
            service
                .append(&stale, &ticket.staged_content_id, 0, b"updated bytes")
                .unwrap_err()
                .code,
            ErrorCode::WorkspaceChanged
        );
        let dbpath = store.0.lock().unwrap().paths.db_path.clone();
        let connection = rusqlite::Connection::open(dbpath).unwrap();
        connection
            .execute(
                "UPDATE projects SET is_archived=1 WHERE id=?1",
                [input.project_id],
            )
            .unwrap();
        assert!(service
            .append(&request, &ticket.staged_content_id, 0, b"updated bytes")
            .is_err());
        connection
            .execute(
                "UPDATE projects SET is_archived=0 WHERE id=?1",
                [input.project_id],
            )
            .unwrap();
        service
            .append(&request, &ticket.staged_content_id, 0, b"updated bytes")
            .unwrap();
        request.request_id = "seal".into();
        service.finish(&request, &ticket.staged_content_id).unwrap();
        connection.execute("INSERT OR REPLACE INTO source_access_policies(object_key,excluded,revision) VALUES(?1,1,1)",[begin.object.key().unwrap()]).unwrap();
        request.request_id = "commit".into();
        assert_eq!(
            service
                .update(&request, &upload_update(&begin, &ticket))
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(version_count(&store, input.document_id), 1);
    }
    #[cfg(unix)]
    #[test]
    fn file_upload_same_bytes_replaced_by_foreign_inode_are_rejected_and_never_cleaned() {
        let (root, store, binding, input) = fixture();
        let (mut request, begin) = upload_input(&binding, &input, b"updated bytes");
        let clock = UploadClock(std::sync::atomic::AtomicI64::new(1000));
        let service = crate::file_content::FileContentService::new(store.as_ref(), &clock);
        let ticket = service.begin(&request, &begin).unwrap();
        request.request_id = "chunk".into();
        service
            .append(&request, &ticket.staged_content_id, 0, b"updated bytes")
            .unwrap();
        let dir = root
            .path()
            .join(".project-mind/file-content-stage")
            .join(&ticket.staged_content_id);
        let blob = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.extension().is_some_and(|e| e == "bin"))
            .unwrap();
        let foreign = dir.join("foreign-temp");
        fs::write(&foreign, b"updated bytes").unwrap();
        fs::rename(&foreign, &blob).unwrap();
        request.request_id = "seal".into();
        assert_eq!(
            service
                .finish(&request, &ticket.staged_content_id)
                .unwrap_err()
                .code,
            ErrorCode::SourceChanged
        );
        assert!(
            crate::file_content::recover_expired(root.path(), &binding.workspace_id, 601000)
                .is_err()
        );
        assert_eq!(fs::read(&blob).unwrap(), b"updated bytes");
        // Foreign data occupies one bounded slot, but does not prevent other
        // expired owned uploads from being reclaimed or a new upload starting.
        request.request_id = "another-begin".into();
        let another = service.begin(&request, &begin).unwrap();
        clock.0.store(601000, std::sync::atomic::Ordering::Relaxed);
        request.request_id = "fresh-begin".into();
        service.begin(&request, &begin).unwrap();
        assert!(!root
            .path()
            .join(".project-mind/file-content-stage")
            .join(&another.staged_content_id)
            .exists());
        assert_eq!(fs::read(&blob).unwrap(), b"updated bytes");
        assert_eq!(version_count(&store, input.document_id), 1);
    }
    #[test]
    fn file_upload_concurrent_commit_retries_return_one_receipt_and_one_version() {
        let (_root, store, binding, input) = fixture();
        let (mut request, begin) = upload_input(&binding, &input, b"updated bytes");
        let clock = Arc::new(UploadClock(std::sync::atomic::AtomicI64::new(1000)));
        let service = crate::file_content::FileContentService::new(store.as_ref(), clock.as_ref());
        let ticket = service.begin(&request, &begin).unwrap();
        request.request_id = "chunk".into();
        service
            .append(&request, &ticket.staged_content_id, 0, b"updated bytes")
            .unwrap();
        request.request_id = "seal".into();
        service.finish(&request, &ticket.staged_content_id).unwrap();
        request.request_id = "commit".into();
        let update = upload_update(&begin, &ticket);
        let barrier = Arc::new(std::sync::Barrier::new(5));
        let mut workers = Vec::new();
        for _ in 0..4 {
            let store = store.clone();
            let clock = clock.clone();
            let request = request.clone();
            let update = update.clone();
            let barrier = barrier.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                crate::file_content::FileContentService::new(store.as_ref(), clock.as_ref())
                    .update(&request, &update)
            }));
        }
        barrier.wait();
        let receipts: Vec<_> = workers
            .into_iter()
            .map(|w| w.join().unwrap().unwrap().receipt)
            .collect();
        assert!(receipts.iter().all(|r| r == &receipts[0]));
        assert_eq!(version_count(&store, input.document_id), 2);
        assert_eq!(store.1.load(std::sync::atomic::Ordering::Relaxed), 1);
    }
    #[test]
    #[ignore = "child process fixture invoked by File upload recovery parent"]
    fn file_upload_crash_process_fixture() {
        let Some(root) = std::env::var_os("MIND_FILE_UPLOAD_CRASH_FIXTURE") else {
            return;
        };
        let root = Path::new(&root);
        let (metadata, paths) = crate::workspace::load_metadata(root).unwrap();
        let db = crate::workspace_initialization::open_workspace_database(
            &paths.db_path,
            root,
            None,
            &metadata.workspace_id,
        )
        .unwrap()
        .db;
        let begin: crate::file_content::FileContentBegin =
            serde_json::from_slice(&fs::read(root.join("upload.fixture.json")).unwrap()).unwrap();
        let binding = WorkspaceBinding {
            workspace_id: metadata.workspace_id,
            generation: "child-open".into(),
        };
        let request = crate::agent::access::RequestContext {
            binding: binding.clone(),
            caller: crate::agent::access::Caller::Gui,
            request_id: "upload-begin".into(),
            scope_grant: crate::agent::access::ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: false,
                project_ids: vec![match begin.object.scope {
                    crate::agent::models::Scope::Project { project_id } => project_id,
                    _ => panic!(),
                }],
                operations: vec!["file.update".into()],
            },
        };
        let store = Store(
            Mutex::new(State {
                binding,
                db,
                paths,
                fence: Arc::new(crate::workspace_commit_fence::WorkspaceCommitFence::new()),
            }),
            std::sync::atomic::AtomicUsize::new(0),
        );
        complete_upload_fixture(&store, request, &begin);
    }
    fn complete_upload_fixture(
        store: &Store,
        mut request: crate::agent::access::RequestContext,
        begin: &crate::file_content::FileContentBegin,
    ) -> crate::db::file_versions::CommittedVersion {
        let service = crate::file_content::FileContentService::new(
            store,
            &crate::file_content::SystemFileContentClock,
        );
        let ticket = service.begin(&request, begin).unwrap();
        request.request_id = "upload-commit".into();
        let update = upload_update(begin, &ticket);
        if let Ok(receipt) = service.update(&request, &update) {
            return receipt.receipt;
        }
        request.request_id = "chunk".into();
        service
            .append(&request, &ticket.staged_content_id, 0, b"updated bytes")
            .unwrap();
        request.request_id = "seal".into();
        service.finish(&request, &ticket.staged_content_id).unwrap();
        request.request_id = "upload-commit".into();
        service.update(&request, &update).unwrap().receipt
    }
    #[cfg(unix)]
    #[test]
    fn file_upload_recovers_eight_upload_and_six_version_actual_process_kills() {
        use std::os::unix::process::ExitStatusExt;
        for (hook, limit) in [
            ("MIND_FILE_CONTENT_CRASH_STAGE", 8),
            ("MIND_FILE_VERSION_CRASH_STAGE", 6),
        ] {
            for stage in 0..limit {
                let (root, store, binding, input) = fixture();
                let (mut request, begin) = upload_input(&binding, &input, b"updated bytes");
                let before = store
                    .0
                    .lock()
                    .unwrap()
                    .db
                    .committed_change_watermark()
                    .unwrap();
                fs::write(
                    root.path().join("upload.fixture.json"),
                    serde_json::to_vec(&begin).unwrap(),
                )
                .unwrap();
                drop(store);
                let output = std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "file_version_service::tests::file_upload_crash_process_fixture",
                        "--ignored",
                    ])
                    .env("MIND_FILE_UPLOAD_CRASH_FIXTURE", root.path())
                    .env(hook, stage.to_string())
                    .output()
                    .unwrap();
                assert_eq!(
                    output.status.signal(),
                    Some(9),
                    "{hook} {stage}: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                let (metadata, paths) = crate::workspace::load_metadata(root.path()).unwrap();
                let db = crate::workspace_initialization::open_workspace_database(
                    &paths.db_path,
                    root.path(),
                    None,
                    &metadata.workspace_id,
                )
                .unwrap()
                .db;
                let binding = WorkspaceBinding {
                    generation: "recovered-open".into(),
                    ..binding
                };
                request.binding = binding.clone();
                let store = Store(
                    Mutex::new(State {
                        binding,
                        db,
                        paths,
                        fence: Arc::new(crate::workspace_commit_fence::WorkspaceCommitFence::new()),
                    }),
                    std::sync::atomic::AtomicUsize::new(0),
                );
                let committed = hook == "MIND_FILE_CONTENT_CRASH_STAGE" && stage == 7
                    || hook == "MIND_FILE_VERSION_CRASH_STAGE" && stage == 5;
                assert_eq!(
                    version_count(&store, input.document_id),
                    if committed { 2 } else { 1 }
                );
                request.request_id = "upload-begin".into();
                let receipt = complete_upload_fixture(&store, request.clone(), &begin);
                assert_eq!(receipt.version_number, 2);
                assert_eq!(complete_upload_fixture(&store, request, &begin), receipt);
                assert_eq!(version_count(&store, input.document_id), 2);
                assert_eq!(
                    store
                        .0
                        .lock()
                        .unwrap()
                        .db
                        .committed_change_watermark()
                        .unwrap(),
                    before + 1
                );
                let versions = store
                    .0
                    .lock()
                    .unwrap()
                    .db
                    .document_list_versions(crate::models::DocumentListVersionsInput {
                        document_id: input.document_id,
                    })
                    .unwrap();
                assert_eq!(
                    fs::read(
                        &versions
                            .iter()
                            .find(|v| v.version_number == 1)
                            .unwrap()
                            .managed_path
                    )
                    .unwrap(),
                    b"registered bytes\r\n"
                );
                assert_eq!(
                    fs::read(
                        &versions
                            .iter()
                            .find(|v| v.version_number == 2)
                            .unwrap()
                            .managed_path
                    )
                    .unwrap(),
                    b"updated bytes"
                );
            }
        }
    }

    #[test]
    fn file_upload_accepts_one_mib_chunks_and_enforces_manifest_chunk_budget() {
        let (_root, store, binding, input) = fixture();
        let bytes = vec![0xff; crate::file_content::MAX_CHUNK];
        let (mut request, begin) = upload_input(&binding, &input, &bytes);
        let clock = UploadClock(std::sync::atomic::AtomicI64::new(1000));
        let service = crate::file_content::FileContentService::new(store.as_ref(), &clock);
        let ticket = service.begin(&request, &begin).unwrap();
        request.request_id = "chunk".into();
        assert_eq!(
            service
                .append(&request, &ticket.staged_content_id, 0, &bytes)
                .unwrap()
                .received_length,
            crate::file_content::MAX_CHUNK as u64
        );
        request.request_id = "seal".into();
        assert!(
            service
                .finish(&request, &ticket.staged_content_id)
                .unwrap()
                .ready
        );
        let mut max = begin.clone();
        max.length = crate::file_content::MAX_CONTENT;
        request.request_id = "max-begin".into();
        let ticket = service.begin(&request, &max).unwrap();
        request.request_id = "tiny-chunk".into();
        assert_eq!(
            service
                .append(&request, &ticket.staged_content_id, 0, b"x")
                .unwrap_err()
                .code,
            ErrorCode::BudgetExceeded
        );
        let data = vec![b'x'; 101];
        let (_, small) = upload_input(&binding, &input, &data);
        request.request_id = "small-begin".into();
        let ticket = service.begin(&request, &small).unwrap();
        for offset in 0..99 {
            request.request_id = format!("small-{offset}");
            service
                .append(&request, &ticket.staged_content_id, offset, b"x")
                .unwrap();
        }
        request.request_id = "last-tiny".into();
        assert_eq!(
            service
                .append(&request, &ticket.staged_content_id, 99, b"x")
                .unwrap_err()
                .code,
            ErrorCode::BudgetExceeded
        );
        request.request_id = "last-two".into();
        service
            .append(&request, &ticket.staged_content_id, 99, b"xx")
            .unwrap();
        request.request_id = "small-seal".into();
        assert!(
            service
                .finish(&request, &ticket.staged_content_id)
                .unwrap()
                .ready
        );
        assert_eq!(version_count(&store, input.document_id), 1);
    }
    #[test]
    fn file_upload_begin_payload_conflicts_and_path_parameters_are_rejected() {
        let (_root, store, binding, input) = fixture();
        let (request, begin) = upload_input(&binding, &input, b"new bytes");
        let clock = UploadClock(std::sync::atomic::AtomicI64::new(1000));
        let service = crate::file_content::FileContentService::new(store.as_ref(), &clock);
        service.begin(&request, &begin).unwrap();
        let mut altered = begin.clone();
        altered.length += 1;
        assert_eq!(
            service.begin(&request, &altered).unwrap_err().code,
            ErrorCode::IdempotencyConflict
        );
        let mut value = serde_json::to_value(&begin).unwrap();
        value["sourcePath"] = serde_json::json!("/host/private-file");
        assert!(serde_json::from_value::<crate::file_content::FileContentBegin>(value).is_err());
        let update = crate::file_content::FileContentUpdate {
            object: begin.object,
            expected_version_number: 1,
            expected_content_hash: begin.expected_content_hash,
            staged_content_id: "../escape".into(),
        };
        assert_eq!(
            service.update(&request, &update).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
    }
    #[test]
    fn file_upload_shared_workspace_reopen_expires_owned_bytes_and_keeps_user_file() {
        let (root, store, binding, input) = fixture();
        let (mut request, begin) = upload_input(&binding, &input, b"new bytes");
        let clock = UploadClock(std::sync::atomic::AtomicI64::new(1000));
        let service = crate::file_content::FileContentService::new(store.as_ref(), &clock);
        let ticket = service.begin(&request, &begin).unwrap();
        request.request_id = "chunk".into();
        service
            .append(&request, &ticket.staged_content_id, 0, b"new bytes")
            .unwrap();
        let dir = root
            .path()
            .join(".project-mind/file-content-stage")
            .join(&ticket.staged_content_id);
        fs::write(dir.join("user-data"), b"preserve").unwrap();
        let paths = store.0.lock().unwrap().paths.clone();
        let mut opened = crate::workspace_initialization::open_workspace_database(
            &paths.db_path,
            root.path(),
            None,
            &binding.workspace_id,
        )
        .unwrap();
        assert_eq!(
            opened
                .db
                .document_list_versions(crate::models::DocumentListVersionsInput {
                    document_id: input.document_id
                })
                .unwrap()
                .len(),
            1
        );
        assert_eq!(fs::read(dir.join("user-data")).unwrap(), b"preserve");
        assert!(!fs::read_dir(&dir).unwrap().any(|e| e
            .unwrap()
            .path()
            .extension()
            .is_some_and(|e| e == "bin")));
        assert_eq!(
            fs::read(&input.managed_path).unwrap(),
            b"registered bytes\r\n"
        );
    }
    #[test]
    fn file_upload_wrong_declared_hash_expires_without_blocking_later_uploads() {
        let (root, store, binding, input) = fixture();
        let (mut request, begin) = upload_input(&binding, &input, b"abcdef");
        let clock = UploadClock(std::sync::atomic::AtomicI64::new(1000));
        let service = crate::file_content::FileContentService::new(store.as_ref(), &clock);
        let ticket = service.begin(&request, &begin).unwrap();
        request.request_id = "bad-bytes".into();
        service
            .append(&request, &ticket.staged_content_id, 0, b"abcdeg")
            .unwrap();
        request.request_id = "bad-seal".into();
        assert_eq!(
            service
                .finish(&request, &ticket.staged_content_id)
                .unwrap_err()
                .code,
            ErrorCode::SourceChanged
        );
        clock.0.store(601000, std::sync::atomic::Ordering::Relaxed);
        request.request_id = "fresh-begin".into();
        let next = service.begin(&request, &begin).unwrap();
        assert_ne!(next.staged_content_id, ticket.staged_content_id);
        assert!(!root
            .path()
            .join(".project-mind/file-content-stage")
            .join(&ticket.staged_content_id)
            .exists());
        assert_eq!(version_count(&store, input.document_id), 1);
    }
    fn file_restore_case(
        name: &str,
        original: &[u8],
        new: &[u8],
    ) -> (
        tempfile::TempDir,
        Arc<Store>,
        WorkspaceBinding,
        GuiFileVersionPrepare,
        crate::agent::access::RequestContext,
        crate::file_version_restore::FileVersionRestore,
    ) {
        let (root, store, binding, input) = fixture_bytes(name, original);
        let (mut request, patch) = patch_request(&binding, &input);
        request.request_id = "restore-v1".into();
        request.scope_grant.operations = vec!["file.restore".into()];
        let selected = root.path().join(name);
        fs::write(&selected, new).unwrap();
        let gui = GuiFileVersionPrepare {
            source_path: Some(selected.to_string_lossy().into()),
            ..input.clone()
        };
        let service = FileVersionService::new(store.as_ref(), &FilesystemFileReader);
        let intent = service.prepare_gui(&binding, &gui).unwrap();
        let receipt = service
            .commit_gui(&binding, "make-v2", &intent, false)
            .unwrap()
            .receipt;
        let versions = store
            .0
            .lock()
            .unwrap()
            .db
            .document_list_versions(crate::models::DocumentListVersionsInput {
                document_id: input.document_id,
            })
            .unwrap();

        let restore = crate::file_version_restore::FileVersionRestore {
            object: patch.object,
            version_id: versions
                .iter()
                .find(|v| v.version_number == 1)
                .unwrap()
                .id
                .to_string(),
            expected_version_number: 2,
            expected_content_hash: receipt.content_hash,
        };
        (root, store, binding, input, request, restore)
    }
    #[test]
    fn file_restore_binary_history_becomes_new_version_and_preserves_original_paths() {
        let old = b"PK\x03\x04historical bytes\x00\xff";
        let new = b"PK\x03\x04latest bytes\x00\xfe";
        let (_root, store, _binding, input, request, restore) =
            file_restore_case("report.docx", old, new);
        let service = FileVersionService::new(store.as_ref(), &FilesystemFileReader);
        let before = store
            .0
            .lock()
            .unwrap()
            .db
            .document_list_versions(crate::models::DocumentListVersionsInput {
                document_id: input.document_id,
            })
            .unwrap();
        let historical = before
            .iter()
            .find(|v| v.version_number == 1)
            .unwrap()
            .managed_path
            .clone();
        let result = service.restore_version(&request, &restore).unwrap();
        assert_eq!(result.receipt.version_number, 3);
        assert!(!result.receipt.no_change);
        assert_eq!(fs::read(result.version_path.unwrap()).unwrap(), old);
        assert_eq!(fs::read(&historical).unwrap(), old);
        let after = store
            .0
            .lock()
            .unwrap()
            .db
            .document_list_versions(crate::models::DocumentListVersionsInput {
                document_id: input.document_id,
            })
            .unwrap();
        assert_eq!(
            after
                .iter()
                .find(|v| v.version_number == 1)
                .unwrap()
                .managed_path,
            historical
        );
        assert_eq!(
            fs::read(
                &after
                    .iter()
                    .find(|v| v.version_number == 2)
                    .unwrap()
                    .managed_path
            )
            .unwrap(),
            new
        );
        assert!(after.iter().all(|v| v.document_id == input.document_id
            && Path::new(&v.managed_path).extension().unwrap() == "docx"));
        assert_eq!(
            service.restore_version(&request, &restore).unwrap().receipt,
            result.receipt
        );
        assert_eq!(version_count(&store, input.document_id), 3);
    }
    #[test]
    fn file_restore_requires_separate_permission_and_same_bytes_return_no_change() {
        let (_root, store, binding, input) = fixture();
        let (mut request, patch) = patch_request(&binding, &input);
        request.request_id = "restore-current".into();
        let version = store
            .0
            .lock()
            .unwrap()
            .db
            .document_list_versions(crate::models::DocumentListVersionsInput {
                document_id: input.document_id,
            })
            .unwrap()
            .remove(0);
        let restore = crate::file_version_restore::FileVersionRestore {
            object: patch.object,
            version_id: version.id.to_string(),
            expected_version_number: 1,
            expected_content_hash: patch.expected_content_hash,
        };
        let service = FileVersionService::new(store.as_ref(), &FilesystemFileReader);
        assert_eq!(
            service
                .restore_version(&request, &restore)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        request.scope_grant.operations = vec!["file.restore".into()];
        let before = store
            .0
            .lock()
            .unwrap()
            .db
            .committed_change_watermark()
            .unwrap();
        let result = service.restore_version(&request, &restore).unwrap();
        assert!(result.receipt.no_change);
        assert_eq!(result.receipt.version_number, 1);
        assert_eq!(
            service.restore_version(&request, &restore).unwrap().receipt,
            result.receipt
        );
        assert_eq!(
            store
                .0
                .lock()
                .unwrap()
                .db
                .committed_change_watermark()
                .unwrap(),
            before
        );
        assert_eq!(store.1.load(std::sync::atomic::Ordering::Relaxed), 0);
        let altered = crate::file_version_restore::FileVersionRestore {
            version_id: "999999".into(),
            ..restore
        };
        assert_eq!(
            service
                .restore_version(&request, &altered)
                .unwrap_err()
                .code,
            ErrorCode::IdempotencyConflict
        );
    }
    #[test]
    fn file_restore_rejects_unknown_or_changed_historical_bytes_without_new_versions() {
        for remove_registration in [false, true] {
            let (_root, store, _binding, input, request, restore) =
                file_restore_case("input.txt", b"original", b"new");
            let versions = store
                .0
                .lock()
                .unwrap()
                .db
                .document_list_versions(crate::models::DocumentListVersionsInput {
                    document_id: input.document_id,
                })
                .unwrap();
            let old = versions.iter().find(|v| v.version_number == 1).unwrap();
            if remove_registration {
                rusqlite::Connection::open(&store.0.lock().unwrap().paths.db_path)
                    .unwrap()
                    .execute(
                        "DELETE FROM source_file_version_hashes WHERE document_version_id=?1",
                        [old.id],
                    )
                    .unwrap();
            } else {
                fs::write(&old.managed_path, b"unknown external historical edit").unwrap();
            }
            let before = store
                .0
                .lock()
                .unwrap()
                .db
                .committed_change_watermark()
                .unwrap();
            let error = FileVersionService::new(store.as_ref(), &FilesystemFileReader)
                .restore_version(&request, &restore)
                .unwrap_err();
            assert_eq!(
                error.code,
                if remove_registration {
                    ErrorCode::FileChangedUnregistered
                } else {
                    ErrorCode::SourceChanged
                }
            );
            assert_eq!(version_count(&store, input.document_id), 2);
            assert_eq!(
                store
                    .0
                    .lock()
                    .unwrap()
                    .db
                    .committed_change_watermark()
                    .unwrap(),
                before
            );
            assert_eq!(
                fs::read(
                    &versions
                        .iter()
                        .find(|v| v.version_number == 2)
                        .unwrap()
                        .managed_path
                )
                .unwrap(),
                b"new"
            );
        }
    }

    #[test]
    fn file_restore_replays_original_receipt_after_later_version_and_rejects_new_payload() {
        let (root, store, binding, input, mut request, restore) =
            file_restore_case("report.txt", b"v1", b"v2");
        let service = FileVersionService::new(store.as_ref(), &FilesystemFileReader);
        let restored = service.restore_version(&request, &restore).unwrap().receipt;
        let versions = store
            .0
            .lock()
            .unwrap()
            .db
            .document_list_versions(crate::models::DocumentListVersionsInput {
                document_id: input.document_id,
            })
            .unwrap();
        let current = versions.iter().find(|v| v.version_number == 3).unwrap();
        let selected = root.path().join("new.txt");
        fs::write(&selected, b"v4").unwrap();
        let gui = GuiFileVersionPrepare {
            expected_version_number: 4 - 1,
            managed_path: current.managed_path.clone(),
            source_path: Some(selected.to_string_lossy().into()),
            ..input.clone()
        };
        let intent = service.prepare_gui(&binding, &gui).unwrap();
        service
            .commit_gui(&binding, "make-v4", &intent, false)
            .unwrap();
        let replay = service.restore_version(&request, &restore).unwrap();
        assert_eq!(replay.receipt, restored);
        assert_eq!(fs::read(replay.version_path.unwrap()).unwrap(), b"v1");
        let altered = crate::file_version_restore::FileVersionRestore {
            version_id: versions
                .iter()
                .find(|v| v.version_number == 2)
                .unwrap()
                .id
                .to_string(),
            ..restore.clone()
        };
        assert_eq!(
            service
                .restore_version(&request, &altered)
                .unwrap_err()
                .code,
            ErrorCode::IdempotencyConflict
        );
        request.request_id = "new-stale-restore".into();
        assert_eq!(
            service
                .restore_version(&request, &restore)
                .unwrap_err()
                .code,
            ErrorCode::RevisionConflict
        );
        assert_eq!(version_count(&store, input.document_id), 4);
    }
    #[test]
    fn file_restore_concurrent_same_request_creates_one_version_and_notification() {
        let (_root, store, _binding, input, request, restore) =
            file_restore_case("input.txt", b"v1", b"v2");
        struct SynchronizedReader(Arc<std::sync::Barrier>);
        impl FileBytesReader for SynchronizedReader {
            fn capture(&self, path: &Path) -> AgentResult<FileHashSnapshot> {
                let snapshot = FilesystemFileReader.capture(path)?;
                self.0.wait();
                Ok(snapshot)
            }
        }
        let snapshots = Arc::new(std::sync::Barrier::new(3));
        let notifications = store.1.load(std::sync::atomic::Ordering::Relaxed);
        let barrier = Arc::new(std::sync::Barrier::new(4));
        let mut workers = Vec::new();
        for _ in 0..3 {
            let store = store.clone();
            let request = request.clone();
            let restore = restore.clone();
            let barrier = barrier.clone();
            let snapshots = snapshots.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                FileVersionService::new(store.as_ref(), &SynchronizedReader(snapshots))
                    .restore_version(&request, &restore)
            }));
        }
        barrier.wait();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap().unwrap().receipt)
            .collect();
        assert!(results.iter().all(|receipt| receipt == &results[0]));
        assert_eq!(version_count(&store, input.document_id), 3);
        assert_eq!(
            store.1.load(std::sync::atomic::Ordering::Relaxed),
            notifications + 1
        );
    }
    #[test]
    fn file_restore_rechecks_scope_archive_exclusion_and_binding_after_snapshot() {
        struct ChangingReader<'a> {
            store: &'a Store,
            object: crate::agent::models::ObjectRef,
            action: u8,
        }
        impl FileBytesReader for ChangingReader<'_> {
            fn capture(&self, path: &Path) -> AgentResult<FileHashSnapshot> {
                let snapshot = FilesystemFileReader.capture(path)?;
                let state = self.store.0.lock().unwrap();
                let connection = rusqlite::Connection::open(&state.paths.db_path).unwrap();
                match self.action {
                    0 => {
                        connection.execute("INSERT OR REPLACE INTO source_access_policies(object_key,excluded,revision) VALUES(?1,1,1)",[self.object.key().unwrap()]).unwrap();
                    }
                    1 => {
                        let crate::agent::models::Scope::Project { project_id } = self.object.scope
                        else {
                            panic!()
                        };
                        connection
                            .execute(
                                "UPDATE projects SET is_archived=1 WHERE id=?1",
                                [project_id],
                            )
                            .unwrap();
                    }
                    2 => {
                        state.fence.invalidate();
                    }
                    _ => {
                        fs::write(path, b"changed original history").unwrap();
                    }
                }
                Ok(snapshot)
            }
        }
        for action in 0..4 {
            let (_root, store, _binding, input, request, restore) =
                file_restore_case("input.txt", b"v1", b"v2");
            let before = store
                .0
                .lock()
                .unwrap()
                .db
                .committed_change_watermark()
                .unwrap();
            let reader = ChangingReader {
                store: store.as_ref(),
                object: restore.object.clone(),
                action,
            };
            let error = FileVersionService::new(store.as_ref(), &reader)
                .restore_version(&request, &restore)
                .unwrap_err();
            assert_eq!(
                error.code,
                match action {
                    0 | 1 => ErrorCode::ScopeDenied,
                    2 => ErrorCode::WorkspaceChanged,
                    _ => ErrorCode::SourceChanged,
                }
            );
            assert_eq!(version_count(&store, input.document_id), 2);
            assert_eq!(
                store
                    .0
                    .lock()
                    .unwrap()
                    .db
                    .committed_change_watermark()
                    .unwrap(),
                before
            );
        }
    }
    #[test]
    fn file_restore_transaction_rejects_late_exclusion_or_lost_history_registration() {
        for exclude in [false, true] {
            let (root, store, binding, input, request, restore) =
                file_restore_case("input.txt", b"v1", b"v2");
            let host = store.gui_commit_host(&binding).unwrap();
            let mut db = host.database().unwrap();
            let source = db
                .file_version_restore_source(&request, &binding, &restore)
                .unwrap();
            let before = db.committed_change_watermark().unwrap();
            let callback = || {
                let connection =
                    rusqlite::Connection::open(&store.0.lock().unwrap().paths.db_path).unwrap();
                if exclude {
                    connection.execute("INSERT OR REPLACE INTO source_access_policies(object_key,excluded,revision) VALUES(?1,1,1)",[restore.object.key().unwrap()]).unwrap();
                } else {
                    connection
                        .execute(
                            "DELETE FROM source_file_version_hashes WHERE document_version_id=?1",
                            [source.version_id],
                        )
                        .unwrap();
                }
                Ok(())
            };
            let error = db
                .file_version_restore_commit_bound(
                    &request,
                    &binding,
                    &restore,
                    &source,
                    host.fence(),
                    &callback,
                )
                .unwrap_err();
            assert_eq!(
                error.code,
                if exclude {
                    ErrorCode::ScopeDenied
                } else {
                    ErrorCode::SourceChanged
                }
            );
            assert_eq!(version_count(&store, input.document_id), 2);
            assert_eq!(db.committed_change_watermark().unwrap(), before);
            let versions = store
                .0
                .lock()
                .unwrap()
                .db
                .document_list_versions(crate::models::DocumentListVersionsInput {
                    document_id: input.document_id,
                })
                .unwrap();
            assert_eq!(
                fs::read(
                    &versions
                        .iter()
                        .find(|v| v.version_number == 1)
                        .unwrap()
                        .managed_path
                )
                .unwrap(),
                b"v1"
            );
            assert_eq!(
                fs::read(
                    &versions
                        .iter()
                        .find(|v| v.version_number == 2)
                        .unwrap()
                        .managed_path
                )
                .unwrap(),
                b"v2"
            );
            assert_eq!(
                fs::read_dir(root.path().join(".project-mind/file-version-journal"))
                    .unwrap()
                    .count(),
                0
            );
        }
    }
    #[test]
    fn file_restore_resolves_real_version_owner_and_refuses_remote_paths() {
        let (root, store, binding, input, mut request, restore) =
            file_restore_case("input.txt", b"v1", b"v2");
        let selected = root.path().join("another.txt");
        fs::write(&selected, b"another File").unwrap();
        let foreign = store
            .0
            .lock()
            .unwrap()
            .db
            .document_import(DocumentImportInput {
                project_id: input.project_id,
                source_path: selected.to_string_lossy().into(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        let version = store
            .0
            .lock()
            .unwrap()
            .db
            .document_list_versions(crate::models::DocumentListVersionsInput {
                document_id: foreign.id,
            })
            .unwrap()
            .remove(0);
        request.request_id = "foreign-version".into();
        let foreign_input = crate::file_version_restore::FileVersionRestore {
            version_id: version.id.to_string(),
            ..restore.clone()
        };
        assert_eq!(
            FileVersionService::new(store.as_ref(), &FilesystemFileReader)
                .restore_version(&request, &foreign_input)
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
        let mut altered = request.clone();
        altered.binding.generation = "stale".into();
        assert_eq!(
            FileVersionService::new(store.as_ref(), &FilesystemFileReader)
                .restore_version(&altered, &restore)
                .unwrap_err()
                .code,
            ErrorCode::WorkspaceChanged
        );
        let mut value = serde_json::to_value(&restore).unwrap();
        value["sourcePath"] = serde_json::json!("/host/private");
        assert!(
            serde_json::from_value::<crate::file_version_restore::FileVersionRestore>(value)
                .is_err()
        );
        for invalid in ["0", "01", "+1", "1e3", "../history", "9223372036854775808"] {
            let input = crate::file_version_restore::FileVersionRestore {
                version_id: invalid.into(),
                ..restore.clone()
            };
            assert_eq!(
                FileVersionService::new(store.as_ref(), &FilesystemFileReader)
                    .restore_version(&request, &input)
                    .unwrap_err()
                    .code,
                ErrorCode::InvalidArgument
            );
        }
        assert_eq!(version_count(&store, input.document_id), 2);
        assert_eq!(binding, store.0.lock().unwrap().binding);
    }
    #[test]
    #[ignore = "child process fixture invoked by File restore recovery parent"]
    fn file_restore_crash_process_fixture() {
        let Some(root) = std::env::var_os("MIND_FILE_RESTORE_CRASH_FIXTURE") else {
            return;
        };
        let root = Path::new(&root);
        let (metadata, paths) = crate::workspace::load_metadata(root).unwrap();
        let db = crate::workspace_initialization::open_workspace_database(
            &paths.db_path,
            root,
            None,
            &metadata.workspace_id,
        )
        .unwrap()
        .db;
        let restore: crate::file_version_restore::FileVersionRestore =
            serde_json::from_slice(&fs::read(root.join("restore.fixture.json")).unwrap()).unwrap();
        let binding = WorkspaceBinding {
            workspace_id: metadata.workspace_id,
            generation: "child-open".into(),
        };
        let request = crate::agent::access::RequestContext {
            binding: binding.clone(),
            caller: crate::agent::access::Caller::Gui,
            request_id: "restore-v1".into(),
            scope_grant: crate::agent::access::ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: false,
                project_ids: vec![match restore.object.scope {
                    crate::agent::models::Scope::Project { project_id } => project_id,
                    _ => panic!(),
                }],
                operations: vec!["file.restore".into()],
            },
        };
        let store = Store(
            Mutex::new(State {
                binding,
                db,
                paths,
                fence: Arc::new(crate::workspace_commit_fence::WorkspaceCommitFence::new()),
            }),
            std::sync::atomic::AtomicUsize::new(0),
        );
        FileVersionService::new(&store, &FilesystemFileReader)
            .restore_version(&request, &restore)
            .unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn file_restore_recovers_six_actual_process_kills_without_moving_original_history() {
        use std::os::unix::process::ExitStatusExt;
        for stage in 0..6 {
            let (root, store, binding, input, mut request, restore) =
                file_restore_case("input.txt", b"v1", b"v2");
            let before = store
                .0
                .lock()
                .unwrap()
                .db
                .committed_change_watermark()
                .unwrap();
            let original = store
                .0
                .lock()
                .unwrap()
                .db
                .document_list_versions(crate::models::DocumentListVersionsInput {
                    document_id: input.document_id,
                })
                .unwrap()
                .into_iter()
                .find(|v| v.version_number == 1)
                .unwrap()
                .managed_path;
            fs::write(
                root.path().join("restore.fixture.json"),
                serde_json::to_vec(&restore).unwrap(),
            )
            .unwrap();
            drop(store);
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "file_version_service::tests::file_restore_crash_process_fixture",
                    "--ignored",
                ])
                .env("MIND_FILE_RESTORE_CRASH_FIXTURE", root.path())
                .env("MIND_FILE_VERSION_CRASH_STAGE", stage.to_string())
                .output()
                .unwrap();
            assert_eq!(
                output.status.signal(),
                Some(9),
                "stage {stage}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let (metadata, paths) = crate::workspace::load_metadata(root.path()).unwrap();
            let db = crate::workspace_initialization::open_workspace_database(
                &paths.db_path,
                root.path(),
                None,
                &metadata.workspace_id,
            )
            .unwrap()
            .db;
            let binding = WorkspaceBinding {
                generation: "recovered-open".into(),
                ..binding
            };
            request.binding = binding.clone();
            let store = Store(
                Mutex::new(State {
                    binding,
                    db,
                    paths,
                    fence: Arc::new(crate::workspace_commit_fence::WorkspaceCommitFence::new()),
                }),
                std::sync::atomic::AtomicUsize::new(0),
            );
            assert_eq!(
                version_count(&store, input.document_id),
                if stage == 5 { 3 } else { 2 }
            );
            assert_eq!(fs::read(&original).unwrap(), b"v1");
            let service = FileVersionService::new(&store, &FilesystemFileReader);
            let receipt = service.restore_version(&request, &restore).unwrap().receipt;
            assert_eq!(receipt.version_number, 3);
            assert_eq!(
                service.restore_version(&request, &restore).unwrap().receipt,
                receipt
            );
            assert_eq!(version_count(&store, input.document_id), 3);
            assert_eq!(
                store
                    .0
                    .lock()
                    .unwrap()
                    .db
                    .committed_change_watermark()
                    .unwrap(),
                before + 1
            );
            assert_eq!(fs::read(&original).unwrap(), b"v1");
            let versions = store
                .0
                .lock()
                .unwrap()
                .db
                .document_list_versions(crate::models::DocumentListVersionsInput {
                    document_id: input.document_id,
                })
                .unwrap();
            assert_eq!(
                fs::read(
                    &versions
                        .iter()
                        .find(|v| v.version_number == 2)
                        .unwrap()
                        .managed_path
                )
                .unwrap(),
                b"v2"
            );
            assert_eq!(
                fs::read(
                    &versions
                        .iter()
                        .find(|v| v.version_number == 3)
                        .unwrap()
                        .managed_path
                )
                .unwrap(),
                b"v1"
            );
        }
    }
}
