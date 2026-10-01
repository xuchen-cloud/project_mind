//! File tombstones and owned asset cleanup share durable deletion receipts.
use super::{
    agent_operations::{io_error, OperationChange},
    file_versions::{
        checksum, create_owned_directories, move_exclusive, owned, path_identity, regular,
        relative, sync_directory, token, valid_hash, FileIdentity,
    },
    Database,
};
use crate::{
    agent::{
        errors::{AgentError, ErrorCode},
        models::{ObjectKind, ObjectRef, Scope},
    },
    models::{DocumentDeleteInput, DocumentRecord},
};
use anyhow::{anyhow, bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
const JOURNALS: &str = ".project-mind/file-delete-journal";
const MAX_JOURNAL_BYTES: u64 = 1024 * 1024;
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct DeleteState {
    project_id: i64,
    managed: String,
    history: String,
    name: String,
    base_name: String,
    storage_mode: String,
    current_version: i64,
    version_count: i64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteAsset {
    id: i64,
    number: i64,
    name: String,
    original: String,
    captured_hash: Option<String>,
    identity: Option<FileIdentity>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteJournal {
    schema_version: u32,
    workspace_id: Option<String>,
    request_id: String,
    document_id: i64,
    old: DeleteState,
    assets: Vec<DeleteAsset>,
}
#[derive(Serialize, Deserialize)]
struct DeleteReceipt {
    document_id: i64,
    deleted: bool,
}
#[derive(Clone, Copy)]
enum DeletePhase {
    Prepared,
    FirstStaged,
    Staged,
    BeforeSqlCommit,
    Committed,
    FirstCleaned,
    Cleaned,
}
fn crash_point(phase: DeletePhase) {
    #[cfg(test)]
    if std::env::var("MIND_FILE_DELETE_CRASH_STAGE")
        .ok()
        .and_then(|v| v.parse::<u8>().ok())
        == Some(phase as u8)
    {
        #[cfg(unix)]
        {
            unsafe extern "C" {
                fn kill(pid: i32, signal: i32) -> i32;
            }
            unsafe {
                kill(std::process::id() as i32, 9);
            }
        }
        std::process::exit(91);
    }
    #[cfg(not(test))]
    let _ = phase;
}
fn component(value: &str) -> bool {
    Path::new(value).components().count() == 1
        && Path::new(value).file_name().and_then(|n| n.to_str()) == Some(value)
}
fn nonce(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}
impl Database {
    fn file_delete_state(&self, record: &DocumentRecord) -> Result<DeleteState> {
        Ok(DeleteState {
            project_id: record.project_id,
            managed: relative(&self.workspace_root, Path::new(&record.managed_path))?,
            history: relative(&self.workspace_root, Path::new(&record.history_dir_path))?,
            name: record.name.clone(),
            base_name: record.base_name.clone(),
            storage_mode: record.storage_mode.clone(),
            current_version: record.current_version_number,
            version_count: record.version_count,
        })
    }
    fn file_delete_staged(directory: &Path, asset: &DeleteAsset) -> PathBuf {
        directory.join(asset.id.to_string()).join(&asset.name)
    }
    fn file_delete_clear(&self, directory: &Path, journal: &DeleteJournal) -> Result<()> {
        // Never recursively remove a journal containing an unexpected asset.
        for asset in &journal.assets {
            let slot = directory.join(asset.id.to_string());
            if slot.exists() {
                fs::remove_dir(&slot)?;
            }
        }
        let unexpected = fs::read_dir(directory)?
            .any(|entry| entry.map_or(true, |entry| entry.file_name() != "journal.json"));
        if unexpected {
            bail!("Unexpected File deletion staging data; journal retained");
        }
        fs::remove_file(directory.join("journal.json"))?;
        fs::remove_dir(directory)?;
        sync_directory(directory.parent().unwrap())
    }
    fn file_delete_validate(&self, journal: &DeleteJournal) -> Result<()> {
        if journal.schema_version != 1
            || journal.workspace_id != self.native_workspace_id
            || journal.document_id <= 0
            || journal.old.project_id <= 0
            || !nonce(&journal.request_id)
            || journal.old.current_version <= 0
            || journal.old.version_count <= 0
            || journal.assets.len() as i64 != journal.old.version_count
            || !component(&journal.old.name)
            || !component(&journal.old.base_name)
        {
            bail!("Invalid File deletion journal");
        }
        let managed = owned(&self.workspace_root, &journal.old.managed)?;
        let history = owned(&self.workspace_root, &journal.old.history)?;
        let mut ids = HashSet::new();
        let mut numbers = HashSet::new();
        let mut paths = HashSet::new();
        for asset in &journal.assets {
            let original = owned(&self.workspace_root, &asset.original)?;
            let expected = if asset.number == journal.old.current_version {
                managed.clone()
            } else {
                history.join(&asset.name)
            };
            if asset.id <= 0
                || asset.number <= 0
                || asset.number > journal.old.current_version
                || !component(&asset.name)
                || !ids.insert(asset.id)
                || !numbers.insert(asset.number)
                || !paths.insert(&asset.original)
                || original != expected
                || original.file_name().and_then(|n| n.to_str()) != Some(asset.name.as_str())
                || asset.captured_hash.is_some() != asset.identity.is_some()
                || asset
                    .captured_hash
                    .as_ref()
                    .is_some_and(|hash| !valid_hash(hash))
            {
                bail!("Invalid File deletion asset");
            }
        }
        if !numbers.contains(&journal.old.current_version) {
            bail!("File deletion head is missing");
        }
        Ok(())
    }
    fn file_delete_cleanup_committed(
        &self,
        directory: &Path,
        journal: &DeleteJournal,
    ) -> Result<()> {
        // Partial cleanup can be retried. Only captured physical files may be
        // trashed; a replacement with identical bytes is still foreign.
        for asset in &journal.assets {
            let staged = Self::file_delete_staged(directory, asset);
            relative(&self.workspace_root, &staged)?;
            if staged.exists()
                && (asset.identity.is_none()
                    || path_identity(&staged)? != *asset.identity.as_ref().unwrap()
                    || checksum(&staged)? != asset.captured_hash.as_deref().unwrap_or_default())
            {
                bail!("File deletion staging ownership changed; journal retained");
            }
        }
        for asset in &journal.assets {
            let staged = Self::file_delete_staged(directory, asset);
            if staged.exists() {
                super::move_paths_to_trash(&[staged])?;
                sync_directory(&directory.join(asset.id.to_string()))?;
                crash_point(DeletePhase::FirstCleaned);
            }
        }
        let history = owned(&self.workspace_root, &journal.old.history)?;
        if history.exists() {
            // Keep user-owned entries that are not authoritative File Versions.
            match fs::remove_dir(&history) {
                Ok(()) => sync_directory(history.parent().unwrap())?,
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::DirectoryNotEmpty | std::io::ErrorKind::NotFound
                    ) =>
                {
                    ()
                }
                Err(error) => return Err(error.into()),
            }
        }
        self.file_delete_clear(directory, journal)
    }
    fn file_delete_recover(&self, directory: &Path, journal: &DeleteJournal) -> Result<()> {
        self.file_delete_validate(journal)?;
        let receipt: Option<DeleteReceipt> = self
            .agent_operation_replay("gui", &journal.request_id, "file.delete", journal)
            .map_err(|e| anyhow!(e.message))?;
        if let Some(receipt) = receipt {
            if receipt.document_id != journal.document_id || !receipt.deleted {
                bail!("File deletion receipt mismatch");
            }
            return self.file_delete_cleanup_committed(directory, journal);
        }
        let current = self.document_record(journal.document_id)?;
        if self.file_delete_state(&current)? != journal.old {
            bail!("File changed before deletion recovery; journal retained");
        }
        let versions = self.fetch_document_versions(journal.document_id)?;
        if versions.len() != journal.assets.len()
            || journal.assets.iter().any(|asset| {
                !versions.iter().any(|version| {
                    version.id == asset.id
                        && version.version_number == asset.number
                        && version.name == asset.name
                        && Path::new(&version.managed_path)
                            == self.workspace_root.join(&asset.original)
                })
            })
        {
            bail!("File Versions changed before deletion recovery; journal retained");
        }
        let mut moves = Vec::new();
        for asset in &journal.assets {
            let Some(id) = &asset.identity else {
                continue;
            };
            let original = owned(&self.workspace_root, &asset.original)?;
            let staged = Self::file_delete_staged(directory, asset);
            relative(&self.workspace_root, &staged)?;
            let original_owned =
                original.exists() && path_identity(&original).ok().as_ref() == Some(id);
            let staged_owned = staged.exists() && path_identity(&staged).ok().as_ref() == Some(id);
            if original_owned == staged_owned {
                bail!("File deletion ownership is ambiguous; journal retained");
            }
            let location = if original_owned { &original } else { &staged };
            if checksum(location)? != *asset.captured_hash.as_ref().unwrap() {
                bail!("File bytes changed; deletion journal retained");
            }
            if staged_owned {
                if original.exists() {
                    bail!("Original File path is occupied; journal retained");
                }
                moves.push((staged, original));
            }
        }
        for (staged, original) in moves {
            move_exclusive(&staged, &original)?;
        }
        self.file_delete_clear(directory, journal)
    }
    pub(super) fn file_delete_recover_pending(&self) -> Result<()> {
        let base = self.workspace_root.join(JOURNALS);
        if !base.exists() {
            return Ok(());
        }
        relative(&self.workspace_root, &base)?;
        for entry in fs::read_dir(&base)? {
            let entry = entry?;
            let kind = match entry.file_type() {
                Ok(kind) => kind,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
            };
            if !kind.is_dir() || kind.is_symlink() {
                bail!("Invalid deletion journal directory");
            }
            let directory = entry.path();
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| anyhow!("Invalid deletion journal encoding"))?;
            let (id, request_id) = name
                .split_once('-')
                .ok_or_else(|| anyhow!("Invalid deletion journal name"))?;
            let document_id: i64 = id.parse()?;
            if document_id <= 0 || document_id.to_string() != id || !nonce(request_id) {
                bail!("Invalid deletion journal identity");
            }
            let project_id: Option<i64> = self
                .conn
                .query_row(
                    "SELECT project_id FROM documents WHERE id=?1",
                    [document_id],
                    |r| r.get(0),
                )
                .optional()?;
            let _project = project_id
                .map(|id| self.file_project_lock(id, false))
                .transpose()?;
            let _file = self.file_storage_lock("file-version-locks", document_id, true)?;
            if !directory.exists() {
                continue;
            }
            let descriptor = directory.join("journal.json");
            if !descriptor.exists() {
                fs::remove_dir_all(&directory)?;
                sync_directory(&base)?;
                continue;
            }
            regular(&descriptor)?;
            if fs::metadata(&descriptor)?.len() > MAX_JOURNAL_BYTES {
                bail!("File deletion journal exceeds budget");
            }
            let journal: DeleteJournal = serde_json::from_slice(&fs::read(&descriptor)?)?;
            if journal.document_id != document_id || journal.request_id != request_id {
                bail!("File deletion journal identity mismatch");
            }
            self.file_delete_recover(&directory, &journal)?;
        }
        Ok(())
    }
    pub fn document_delete(&mut self, input: DocumentDeleteInput) -> Result<DocumentRecord> {
        let _locks = self.file_native_write_locks(input.document_id)?;
        let current = self.document_record(input.document_id)?;
        self.ensure_project_file_layout(current.project_id)?;
        let current = self.document_record(input.document_id)?;
        let old = self.file_delete_state(&current)?;
        let request_id = token();
        let base = self.workspace_root.join(JOURNALS);
        create_owned_directories(&self.workspace_root, &base)?;
        let directory = base.join(format!("{}-{request_id}", current.id));
        fs::create_dir(&directory)?;
        sync_directory(&base)?;
        let prepared = (|| -> Result<DeleteJournal> {
            let mut assets = Vec::new();
            let mut identities = HashSet::new();
            for version in self.fetch_document_versions(current.id)? {
                let original = Path::new(&version.managed_path);
                let (captured_hash, file_identity) = if original.exists() {
                    let hash = checksum(original)?;
                    let id = path_identity(original)?;
                    if !identities.insert(serde_json::to_string(&id)?) {
                        bail!("File versions share a physical file; deletion refused");
                    }
                    (Some(hash), Some(id))
                } else {
                    (None, None)
                };
                assets.push(DeleteAsset {
                    id: version.id,
                    number: version.version_number,
                    name: version.name,
                    original: relative(&self.workspace_root, original)?,
                    captured_hash,
                    identity: file_identity,
                });
                create_owned_directories(
                    &self.workspace_root,
                    &directory.join(version.id.to_string()),
                )?;
            }
            let journal = DeleteJournal {
                schema_version: 1,
                workspace_id: self.native_workspace_id.clone(),
                request_id,
                document_id: current.id,
                old,
                assets,
            };
            self.file_delete_validate(&journal)?;
            let bytes = serde_json::to_vec(&journal)?;
            if bytes.len() as u64 > MAX_JOURNAL_BYTES {
                bail!("File deletion journal exceeds budget");
            }
            let mut output = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(directory.join("journal.tmp"))?;
            output.write_all(&bytes)?;
            output.sync_all()?;
            drop(output);
            move_exclusive(
                &directory.join("journal.tmp"),
                &directory.join("journal.json"),
            )?;
            sync_directory(&directory)?;
            crash_point(DeletePhase::Prepared);
            Ok(journal)
        })();
        let journal = match prepared {
            Ok(journal) => journal,
            Err(error) => {
                let _ = fs::remove_dir_all(&directory);
                let _ = sync_directory(&base);
                return Err(error);
            }
        };
        let synchronous: i64 = self
            .conn
            .pragma_query_value(None, "synchronous", |r| r.get(0))?;
        self.conn
            .pragma_update(None, "synchronous", synchronous.max(2))?;
        let result = (|| -> Result<()> {
            for asset in &journal.assets {
                if let Some(id) = &asset.identity {
                    let original = owned(&self.workspace_root, &asset.original)?;
                    if path_identity(&original)? != *id
                        || checksum(&original)? != *asset.captured_hash.as_ref().unwrap()
                    {
                        bail!("File changed before deletion commit");
                    }
                    move_exclusive(&original, &Self::file_delete_staged(&directory, asset))?;
                    crash_point(DeletePhase::FirstStaged);
                }
            }
            crash_point(DeletePhase::Staged);
            for asset in &journal.assets {
                if owned(&self.workspace_root, &asset.original)?.exists() {
                    bail!("File deletion original became occupied");
                }
                if let Some(id) = &asset.identity {
                    let staged = Self::file_delete_staged(&directory, asset);
                    if path_identity(&staged)? != *id
                        || checksum(&staged)? != *asset.captured_hash.as_ref().unwrap()
                    {
                        bail!("File deletion bytes changed before commit");
                    }
                }
            }
            let stamp = super::now_iso();
            self.agent_atomic_operation(
                "gui",
                &journal.request_id,
                "file.delete",
                &journal,
                |tx| {
                    let record = self.document_record(current.id).map_err(|_| {
                        AgentError::new(
                            ErrorCode::RevisionConflict,
                            "File changed before deletion commit",
                        )
                    })?;
                    if self.file_delete_state(&record).map_err(|_| {
                        AgentError::new(ErrorCode::RevisionConflict, "File paths changed")
                    })? != journal.old
                    {
                        return Err(AgentError::new(
                            ErrorCode::RevisionConflict,
                            "File metadata changed before deletion",
                        ));
                    }
                    tx.execute("DELETE FROM documents WHERE id=?1", [current.id])
                        .map_err(io_error)?;
                    tx.execute(
                        "UPDATE projects SET updated_at=?1 WHERE id=?2",
                        params![stamp, current.project_id],
                    )
                    .map_err(io_error)?;
                    let change = if journal.old.storage_mode != "managed_note_image" {
                        if let Some(workspace_id) = &journal.workspace_id {
                            let object = ObjectRef {
                                workspace_id: workspace_id.clone(),
                                scope: Scope::Project {
                                    project_id: current.project_id,
                                },
                                kind: ObjectKind::File,
                                id: current.id.to_string(),
                            };
                            Some(OperationChange {
                                object_key: object.key()?,
                                scope: object.scope,
                                revision: "deleted".into(),
                            })
                        } else {
                            None
                        }
                    } else {
                        None
                    };
                    crash_point(DeletePhase::BeforeSqlCommit);
                    Ok((
                        DeleteReceipt {
                            document_id: current.id,
                            deleted: true,
                        },
                        change,
                    ))
                },
            )
            .map_err(|e| anyhow!(e.message))?;
            crash_point(DeletePhase::Committed);
            Ok(())
        })();
        if let Err(error) = self.conn.pragma_update(None, "synchronous", synchronous) {
            eprintln!("File deletion synchronous restore failed: {error}");
        }
        if let Err(error) = result {
            if let Err(recovery) = self.file_delete_recover(&directory, &journal) {
                return Err(anyhow!("{error}; deletion journal retained: {recovery}"));
            }
            return Err(error);
        }
        // The durable logical deletion already committed. Cleanup failure must
        // not pretend the File still exists or discard its recoverable journal.
        if let Err(error) = self.file_delete_cleanup_committed(&directory, &journal) {
            eprintln!("Committed File deletion cleanup pending: {error}");
        }
        crash_point(DeletePhase::Cleaned);
        Ok(current)
    }
}

#[cfg(test)]
mod tests {
    use super::super::Database;
    use crate::models::{
        DocumentAddVersionInput, DocumentDeleteInput, DocumentImportInput, ProjectCreateInput,
    };
    use std::{fs, path::Path};
    fn fixture(root: &Path) -> (Database, crate::models::DocumentRecord) {
        let (_, paths) = crate::workspace::create_workspace(root, "password").unwrap();
        let mut db = Database::open(&paths.db_path, root, None).unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Delete".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let source = root.join("original.txt");
        fs::write(&source, b"v1\r\n").unwrap();
        let file = db
            .document_import(DocumentImportInput {
                project_id: project.id,
                source_path: source.to_string_lossy().into(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        fs::write(&source, b"v2\r\n").unwrap();
        let file = db
            .document_add_version(DocumentAddVersionInput {
                document_id: file.id,
                source_path: Some(source.to_string_lossy().into()),
            })
            .unwrap();
        (db, file)
    }
    fn crash(root: &Path, stage: u8) {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "db::file_deletions::tests::file_delete_crash_process_fixture",
                "--ignored",
            ])
            .env("MIND_FILE_DELETE_CRASH_FIXTURE", root)
            .env("MIND_FILE_DELETE_CRASH_STAGE", stage.to_string())
            .output()
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(
                output.status.signal(),
                Some(9),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        #[cfg(not(unix))]
        assert_eq!(output.status.code(), Some(91));
    }
    #[test]
    #[ignore = "subprocess-only fixture started by File deletion crash tests"]
    fn file_delete_crash_process_fixture() {
        let Ok(root) = std::env::var("MIND_FILE_DELETE_CRASH_FIXTURE") else {
            return;
        };
        let root = Path::new(&root);
        let (_, paths) = crate::workspace::load_metadata(root).unwrap();
        let mut db = Database::open(&paths.db_path, root, None).unwrap();
        let id = db
            .conn
            .query_row("SELECT id FROM documents", [], |r| r.get(0))
            .unwrap();
        db.document_delete(DocumentDeleteInput { document_id: id })
            .unwrap();
        panic!("deletion crash boundary not reached");
    }
    #[test]
    fn file_delete_process_crashes_restore_or_finish_and_preserve_unowned_history() {
        for missing in [false, true] {
            for stage in 0..=6 {
                let root = tempfile::tempdir().unwrap();
                let (db, file) = fixture(root.path());
                fs::write(
                    Path::new(&file.history_dir_path).join("user-owned.txt"),
                    b"keep this",
                )
                .unwrap();
                if missing {
                    fs::remove_file(&file.managed_path).unwrap();
                }
                let before = db.committed_change_watermark().unwrap();
                drop(db);
                crash(root.path(), stage);
                let (metadata, paths) = crate::workspace::load_metadata(root.path()).unwrap();
                let db = crate::workspace_initialization::open_workspace_database(
                    &paths.db_path,
                    root.path(),
                    None,
                    &metadata.workspace_id,
                )
                .unwrap()
                .db;
                if stage < 4 {
                    let current = db.document_record(file.id).unwrap();
                    assert_eq!(current.current_version_number, 2);
                    if missing {
                        assert!(!Path::new(&file.managed_path).exists());
                    } else {
                        assert_eq!(fs::read(&file.managed_path).unwrap(), b"v2\r\n");
                    }
                    assert_eq!(
                        fs::read(Path::new(&file.history_dir_path).join("original.txt")).unwrap(),
                        b"v1\r\n"
                    );
                } else {
                    assert!(db.document_record(file.id).is_err());
                    assert!(!Path::new(&file.managed_path).exists());
                    assert!(!Path::new(&file.history_dir_path)
                        .join("original.txt")
                        .exists());
                    let deleted:bool=db.conn.query_row("SELECT deleted_at IS NOT NULL FROM source_registry WHERE object_key=?1",
                        [format!("{}/project:{}/file/{}",metadata.workspace_id,file.project_id,file.id)],|r|r.get(0)).unwrap();
                    assert!(deleted);
                }
                let hashes: i64 = db
                    .conn
                    .query_row("SELECT count(*) FROM source_file_version_hashes", [], |r| {
                        r.get(0)
                    })
                    .unwrap();
                assert_eq!(hashes, if stage < 4 { 2 } else { 0 });
                assert_eq!(
                    fs::read(Path::new(&file.history_dir_path).join("user-owned.txt")).unwrap(),
                    b"keep this"
                );
                assert_eq!(
                    fs::read(root.path().join("original.txt")).unwrap(),
                    b"v2\r\n"
                );
                assert_eq!(
                    db.committed_change_watermark().unwrap(),
                    before + i64::from(stage >= 4)
                );
                db.file_version_recover_pending().unwrap();
                assert_eq!(
                    db.committed_change_watermark().unwrap(),
                    before + i64::from(stage >= 4)
                );
                assert_eq!(
                    fs::read_dir(root.path().join(super::JOURNALS))
                        .unwrap()
                        .count(),
                    0
                );
            }
        }
    }
    #[test]
    fn file_delete_recovery_never_overwrites_foreign_same_byte_original() {
        let root = tempfile::tempdir().unwrap();
        let (db, file) = fixture(root.path());
        let before = db.committed_change_watermark().unwrap();
        drop(db);
        crash(root.path(), 2);
        fs::write(&file.managed_path, b"v2\r\n").unwrap();
        let (metadata, paths) = crate::workspace::load_metadata(root.path()).unwrap();
        assert!(crate::workspace_initialization::open_workspace_database(
            &paths.db_path,
            root.path(),
            None,
            &metadata.workspace_id
        )
        .is_err());
        assert_eq!(fs::read(&file.managed_path).unwrap(), b"v2\r\n");
        fs::remove_file(&file.managed_path).unwrap();
        let db = crate::workspace_initialization::open_workspace_database(
            &paths.db_path,
            root.path(),
            None,
            &metadata.workspace_id,
        )
        .unwrap()
        .db;
        assert_eq!(fs::read(&file.managed_path).unwrap(), b"v2\r\n");
        assert_eq!(db.committed_change_watermark().unwrap(), before);
    }
    #[test]
    fn file_delete_committed_cleanup_preserves_replaced_staging() {
        let root = tempfile::tempdir().unwrap();
        let (db, file) = fixture(root.path());
        drop(db);
        crash(root.path(), 4);
        let directory = fs::read_dir(root.path().join(super::JOURNALS))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let journal: super::DeleteJournal =
            serde_json::from_slice(&fs::read(directory.join("journal.json")).unwrap()).unwrap();
        let asset = journal
            .assets
            .iter()
            .find(|asset| asset.number == 2)
            .unwrap();
        let staged = Database::file_delete_staged(&directory, asset);
        let held = root.path().join("held-owned-version.txt");
        fs::rename(&staged, &held).unwrap();
        fs::write(&staged, b"v2\r\n").unwrap();
        let (metadata, paths) = crate::workspace::load_metadata(root.path()).unwrap();
        assert!(crate::workspace_initialization::open_workspace_database(
            &paths.db_path,
            root.path(),
            None,
            &metadata.workspace_id
        )
        .is_err());
        assert_eq!(fs::read(&staged).unwrap(), b"v2\r\n");
        assert!(directory.join("journal.json").exists());
        fs::remove_file(&staged).unwrap();
        fs::rename(&held, &staged).unwrap();
        let db = crate::workspace_initialization::open_workspace_database(
            &paths.db_path,
            root.path(),
            None,
            &metadata.workspace_id,
        )
        .unwrap()
        .db;
        assert!(db.document_record(file.id).is_err());
        assert!(!directory.exists());
        assert_eq!(
            fs::read(root.path().join("original.txt")).unwrap(),
            b"v2\r\n"
        );
    }
    #[test]
    fn file_delete_outbox_failure_rolls_back_jobs_and_success_tombstone_survives_log_prune() {
        use crate::{
            agent::{
                access::{Caller, RequestContext, ScopeGrant},
                models::{ObjectKind, Scope, WorkspaceBinding},
            },
            committed_changes::capture_native_committed,
        };
        let root = tempfile::tempdir().unwrap();
        let (mut db, file) = fixture(root.path());
        let metadata = crate::workspace::load_metadata(root.path()).unwrap().0;
        let binding = WorkspaceBinding {
            workspace_id: metadata.workspace_id.clone(),
            generation: "current".into(),
        };
        let scope = Scope::Project {
            project_id: file.project_id,
        };
        let request = RequestContext {
            binding: binding.clone(),
            request_id: "queue".into(),
            caller: Caller::Gui,
            scope_grant: ScopeGrant {
                workspace_id: metadata.workspace_id.clone(),
                workspace_content: false,
                project_ids: vec![file.project_id],
                operations: vec!["source.read".into()],
            },
        };
        db.source_queue_sync(&request, &binding, &scope, chrono::Utc::now())
            .unwrap();
        let key = format!(
            "{}/project:{}/file/{}",
            metadata.workspace_id, file.project_id, file.id
        );
        let dedupe = format!("source-index:{key}");
        let queued: String = db
            .conn
            .query_row(
                "SELECT state FROM agent_jobs WHERE dedupe_key=?1",
                [&dedupe],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(queued, "queued");
        db.conn.execute_batch("CREATE TRIGGER fail_delete_outbox BEFORE INSERT ON agent_change_log BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END;").unwrap();
        let input = DocumentDeleteInput {
            document_id: file.id,
        };
        let (result, changes) =
            capture_native_committed(&binding, &mut db, "failed-delete", |db| {
                db.document_delete(input.clone())
            })
            .unwrap();
        assert!(result.is_err());
        assert!(changes.is_none());
        assert!(db.document_record(file.id).is_ok());
        let queued: String = db
            .conn
            .query_row(
                "SELECT state FROM agent_jobs WHERE dedupe_key=?1",
                [&dedupe],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(queued, "queued");
        assert_eq!(fs::read(&file.managed_path).unwrap(), b"v2\r\n");
        db.conn
            .execute_batch("DROP TRIGGER fail_delete_outbox")
            .unwrap();
        let (result, changes) =
            capture_native_committed(&binding, &mut db, "delete", |db| db.document_delete(input))
                .unwrap();
        assert_eq!(result.unwrap().id, file.id);
        let changes = changes.unwrap();
        assert_eq!(changes.changed_refs.len(), 1);
        assert_eq!(changes.changed_refs[0].kind, ObjectKind::File);
        assert_eq!(changes.changed_refs[0].id, file.id.to_string());
        assert_eq!(changes.changed_refs[0].scope, scope);
        let cancelled: String = db
            .conn
            .query_row(
                "SELECT state FROM agent_jobs WHERE dedupe_key=?1",
                [&dedupe],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cancelled, "cancelled");
        db.conn.execute("DELETE FROM agent_change_log", []).unwrap();
        drop(db);
        let (_, paths) = crate::workspace::load_metadata(root.path()).unwrap();
        let db = crate::workspace_initialization::open_workspace_database(
            &paths.db_path,
            root.path(),
            None,
            &metadata.workspace_id,
        )
        .unwrap()
        .db;
        let deleted: bool = db
            .conn
            .query_row(
                "SELECT deleted_at IS NOT NULL FROM source_registry WHERE object_key=?1",
                [&key],
                |r| r.get(0),
            )
            .unwrap();
        assert!(deleted);
    }

    #[test]
    fn file_delete_recovery_waits_for_live_staging_lock() {
        let root = tempfile::tempdir().unwrap();
        let (db, file) = fixture(root.path());
        let directory =
            root.path()
                .join(super::JOURNALS)
                .join(format!("{}-{}", file.id, "4".repeat(32)));
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("journal.tmp"), b"preparing").unwrap();
        let project = db.file_project_lock(file.project_id, false).unwrap();
        let guard = db
            .file_storage_lock("file-version-locks", file.id, true)
            .unwrap();
        let path = root.path().to_path_buf();
        let (start_tx, start_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let (_, paths) = crate::workspace::load_metadata(&path).unwrap();
            let db = Database::open(&paths.db_path, &path, None).unwrap();
            start_tx.send(()).unwrap();
            done_tx.send(db.file_version_recover_pending()).unwrap();
        });
        start_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert!(matches!(
            done_rx.recv_timeout(std::time::Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        assert_eq!(
            fs::read(directory.join("journal.tmp")).unwrap(),
            b"preparing"
        );
        drop(guard);
        drop(project);
        done_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .unwrap();
        thread.join().unwrap();
        assert!(!directory.exists());
    }

    #[test]
    fn file_delete_sql_failure_keeps_original_and_historical_bytes() {
        let root = tempfile::tempdir().unwrap();
        let (mut db, file) = fixture(root.path());
        let before = db.committed_change_watermark().unwrap();
        db.conn.execute_batch("CREATE TRIGGER fail_file_delete BEFORE DELETE ON documents BEGIN SELECT RAISE(ABORT,'cannot delete File'); END;").unwrap();
        assert!(db
            .document_delete(DocumentDeleteInput {
                document_id: file.id
            })
            .is_err());
        assert_eq!(
            db.document_record(file.id).unwrap().current_version_number,
            2
        );
        assert_eq!(fs::read(&file.managed_path).unwrap(), b"v2\r\n");
        assert_eq!(
            fs::read(Path::new(&file.history_dir_path).join("original.txt")).unwrap(),
            b"v1\r\n"
        );
        assert_eq!(db.committed_change_watermark().unwrap(), before);
    }
}
