//! Relocation repairs registered identical bytes; it cannot replace a version.
use super::{
    agent_operations::{io_error, OperationChange},
    file_versions::{
        checksum, create_owned_directories, move_exclusive, owned, path_identity, regular,
        relative, snapshot, sync_directory, token, valid_hash, FileIdentity,
    },
    Database,
};
use crate::{
    agent::{
        errors::{AgentError, ErrorCode},
        models::{ObjectKind, ObjectRef},
    },
    models::{DocumentRecord, DocumentRelocateInput},
};
use anyhow::{anyhow, bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};
const JOURNALS: &str = ".project-mind/file-relocate-journal";
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RelocateJournal {
    schema_version: u32,
    workspace_id: Option<String>,
    request_id: String,
    document_id: i64,
    project_id: Option<i64>,
    version_id: i64,
    version: i64,
    target: String,
    old_source_ref: String,
    old_version_source_ref: String,
    new_source_ref: String,
    content_hash: String,
    repair_missing: bool,
    current_identity: Option<FileIdentity>,
    new_identity: FileIdentity,
}
#[derive(Serialize, Deserialize)]
struct RelocateReceipt {
    document_id: i64,
    version: i64,
    content_hash: String,
}
#[derive(Clone, Copy)]
enum RelocatePhase {
    Staged,
    Prepared,
    Placed,
    BeforeSqlCommit,
    Committed,
}
fn crash_point(phase: RelocatePhase) {
    #[cfg(test)]
    if std::env::var("MIND_FILE_RELOCATE_CRASH_STAGE")
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
fn nonce(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}
fn unregistered(message: &str) -> anyhow::Error {
    anyhow!("FILE_CHANGED_UNREGISTERED: {message}")
}
impl Database {
    fn file_relocate_clear(&self, directory: &Path) -> Result<()> {
        fs::remove_dir_all(directory)?;
        sync_directory(directory.parent().unwrap())
    }
    fn file_relocate_recover(&self, directory: &Path, journal: &RelocateJournal) -> Result<()> {
        if journal.schema_version != 1
            || journal.workspace_id != self.native_workspace_id
            || !nonce(&journal.request_id)
            || journal.document_id <= 0
            || journal.project_id.is_some_and(|id| id <= 0)
            || journal.version_id <= 0
            || journal.version <= 0
            || journal.version > u32::MAX as i64
            || !valid_hash(&journal.content_hash)
            || journal.repair_missing == journal.current_identity.is_some()
        {
            bail!("Invalid File relocation journal");
        }
        let target = owned(&self.workspace_root, &journal.target)?;
        let receipt: Option<RelocateReceipt> = self
            .agent_operation_replay("gui", &journal.request_id, "file.relocate", journal)
            .map_err(|e| anyhow!(e.message))?;
        if let Some(receipt) = receipt {
            if receipt.document_id != journal.document_id
                || receipt.version != journal.version
                || receipt.content_hash != journal.content_hash
            {
                bail!("File relocation receipt mismatch");
            }
            return self.file_relocate_clear(directory);
        }
        let current = self.document_record(journal.document_id)?;
        let hash: Option<String> = self
            .conn
            .query_row(
                "SELECT content_hash FROM source_file_version_hashes WHERE document_version_id=?1",
                [journal.version_id],
                |r| r.get(0),
            )
            .optional()?;
        let version: (i64,i64,String,String)=self.conn.query_row("SELECT document_id,version_number,managed_path,source_path FROM document_versions WHERE id=?1",[journal.version_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
        if current.project_id != journal.project_id
            || current.current_version_number != journal.version
            || Path::new(&current.managed_path) != target
            || self.encode_path_ref(Path::new(&current.original_path)) != journal.old_source_ref
            || hash.as_deref() != Some(&journal.content_hash)
            || version.0 != journal.document_id
            || version.1 != journal.version
            || self.decode_path_ref(&version.2) != target
            || version.3 != journal.old_version_source_ref
        {
            bail!("File changed before relocation recovery; journal retained");
        }
        if journal.repair_missing && target.exists() {
            if path_identity(&target)? != journal.new_identity
                || checksum(&target)? != journal.content_hash
            {
                bail!("File relocation target is occupied; journal retained");
            }
            fs::remove_file(&target)?;
            sync_directory(target.parent().unwrap())?;
        }
        // A healthy head was never moved or overwritten by relocation.
        self.file_relocate_clear(directory)
    }
    pub(super) fn file_relocate_recover_pending(&self) -> Result<()> {
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
                bail!("Invalid relocation journal directory");
            }
            let directory = entry.path();
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| anyhow!("Invalid relocation journal encoding"))?;
            let (id, request_id) = name
                .split_once('-')
                .ok_or_else(|| anyhow!("Invalid relocation journal name"))?;
            let document_id: i64 = id.parse()?;
            if document_id <= 0 || document_id.to_string() != id || !nonce(request_id) {
                bail!("Invalid relocation journal identity");
            }
            let project_id: Option<Option<i64>> = self
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
                self.file_relocate_clear(&directory)?;
                continue;
            }
            regular(&descriptor)?;
            if fs::metadata(&descriptor)?.len() > 16384 {
                bail!("File relocation journal exceeds metadata budget");
            }
            let journal: RelocateJournal = serde_json::from_slice(&fs::read(&descriptor)?)?;
            if journal.document_id != document_id || journal.request_id != request_id {
                bail!("File relocation journal identity mismatch");
            }
            self.file_relocate_recover(&directory, &journal)?;
        }
        Ok(())
    }
    pub fn document_relocate(&mut self, input: DocumentRelocateInput) -> Result<DocumentRecord> {
        let _locks = self.file_native_write_locks(input.document_id)?;
        let current = self.document_record(input.document_id)?;
        self.ensure_project_file_layout(current.project_id)?;
        let current = self.document_record(input.document_id)?;
        if current.current_version_number <= 0 || current.current_version_number > u32::MAX as i64 {
            bail!("Invalid File Version for relocation");
        }
        crate::source_search_index::SourceIndex::prepare(&self.conn)
            .map_err(|e| anyhow!(e.message))?;
        let (version_id, version_source_ref, hash, version_path): (i64,String,Option<String>,String) = self.conn.query_row(
            "SELECT v.id,v.source_path,h.content_hash,v.managed_path
             FROM document_versions v LEFT JOIN source_file_version_hashes h ON h.document_version_id=v.id
             WHERE v.document_id=?1 AND v.version_number=?2", params![current.id,current.current_version_number],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
        if self.decode_path_ref(&version_path) != Path::new(&current.managed_path) {
            bail!("File head and version paths disagree");
        }
        let hash=hash.filter(|hash|valid_hash(hash)).ok_or_else(||unregistered("This version has no registered original bytes; relocation cannot identify a historical original"))?;
        let target = Path::new(&current.managed_path);
        let target_ref = relative(&self.workspace_root, target)?;
        let missing = !target.exists();
        let current_identity = if missing {
            None
        } else {
            if checksum(target)? != hash {
                return Err(unregistered("Current File was externally changed; preserve it and register an explicit new version"));
            }
            Some(path_identity(target)?)
        };
        let source = Path::new(&input.new_source_path);
        regular(source)?;
        let new_source_ref = self.encode_path_ref(source);
        let base = self.workspace_root.join(JOURNALS);
        create_owned_directories(&self.workspace_root, &base)?;
        let request_id = token();
        let directory = base.join(format!("{}-{request_id}", current.id));
        fs::create_dir(&directory)?;
        sync_directory(&base)?;
        let prepared = (|| -> Result<Option<RelocateJournal>> {
            let (captured, _, new_identity) = snapshot(source, &directory.join("new.bin"))?;
            if captured != hash {
                return Err(unregistered("Relocation bytes do not match this version; changed content must use the new-version workflow"));
            }
            crash_point(RelocatePhase::Staged);
            let old_source_ref = self.encode_path_ref(Path::new(&current.original_path));
            if !missing
                && old_source_ref == new_source_ref
                && version_source_ref == new_source_ref
                && current.health == "normal"
            {
                if checksum(target)? != hash
                    || path_identity(target)? != *current_identity.as_ref().unwrap()
                {
                    return Err(unregistered(
                        "Current File changed during relocation preflight",
                    ));
                }
                return Ok(None);
            }
            let journal = RelocateJournal {
                schema_version: 1,
                workspace_id: self.native_workspace_id.clone(),
                request_id,
                document_id: current.id,
                project_id: current.project_id,
                version_id,
                version: current.current_version_number,
                target: target_ref,
                old_source_ref,
                old_version_source_ref: version_source_ref,
                new_source_ref,
                content_hash: hash,
                repair_missing: missing,
                current_identity,
                new_identity,
            };
            let bytes = serde_json::to_vec(&journal)?;
            if bytes.len() > 16384 {
                bail!("File relocation journal exceeds metadata budget");
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
            crash_point(RelocatePhase::Prepared);
            Ok(Some(journal))
        })();
        let journal = match prepared {
            Ok(Some(journal)) => journal,
            Ok(None) => {
                self.file_relocate_clear(&directory)?;
                return Ok(current);
            }
            Err(error) => {
                let _ = self.file_relocate_clear(&directory);
                return Err(error);
            }
        };
        let synchronous: i64 = self
            .conn
            .pragma_query_value(None, "synchronous", |r| r.get(0))?;
        self.conn
            .pragma_update(None, "synchronous", synchronous.max(2))?;
        let result = (|| -> Result<()> {
            if journal.repair_missing {
                move_exclusive(&directory.join("new.bin"), target)?;
            }
            crash_point(RelocatePhase::Placed);
            let expected = if journal.repair_missing {
                &journal.new_identity
            } else {
                journal.current_identity.as_ref().unwrap()
            };
            if checksum(target)? != journal.content_hash || path_identity(target)? != *expected {
                return Err(unregistered(
                    "File changed during relocation; user bytes were preserved",
                ));
            }
            let stamp = super::now_iso();
            self.agent_atomic_operation(
                "gui", &journal.request_id, "file.relocate", &journal,
                |tx| {
                    let unchanged: bool = tx.query_row(
                        "SELECT project_id IS ?2 AND current_version_number=?3 AND managed_path=?4 AND original_path=?5 FROM documents WHERE id=?1",
                        params![current.id, current.project_id, journal.version,
                            self.encode_path_ref(target), journal.old_source_ref],
                        |r| r.get(0),
                    ).map_err(io_error)?;
                    if !unchanged {
                        return Err(AgentError::new(ErrorCode::RevisionConflict,
                            "File changed before relocation commit"));
                    }
                    let registered: Option<String> = tx.query_row(
                        "SELECT content_hash FROM source_file_version_hashes WHERE document_version_id=?1",
                        [version_id], |r| r.get(0),
                    ).optional().map_err(io_error)?;
                    if registered.as_deref() != Some(journal.content_hash.as_str()) {
                        return Err(AgentError::new(ErrorCode::FileChangedUnregistered,
                            "File baseline changed before relocation commit"));
                    }
                    tx.execute(
                        "UPDATE documents SET original_path=?1,health='normal',updated_at=?2 WHERE id=?3",
                        params![journal.new_source_ref, stamp, current.id],
                    ).map_err(io_error)?;
                    let count = tx.execute(
                        "UPDATE document_versions SET source_path=?1
                         WHERE id=?2 AND document_id=?3 AND version_number=?4 AND source_path=?5 AND managed_path=?6",
                        params![journal.new_source_ref, version_id, current.id,
                            journal.version, journal.old_version_source_ref, self.encode_path_ref(target)],
                    ).map_err(io_error)?;
                    if count != 1 {
                        return Err(AgentError::new(ErrorCode::RevisionConflict,
                            "File Version source changed before relocation commit"));
                    }
                    tx.execute("UPDATE projects SET updated_at=?1 WHERE id=?2",
                        params![stamp, current.project_id]).map_err(io_error)?;
                    let change = if let Some(workspace_id) = &journal.workspace_id {
                        let object = ObjectRef {
                            workspace_id: workspace_id.clone(),
                            scope: super::file_scope::scope(current.project_id),
                            kind: ObjectKind::File, id: current.id.to_string(),
                        };
                        Some(OperationChange {object_key: object.key()?,
                            scope: object.scope, revision: journal.content_hash.clone()})
                    } else {None};
                    crash_point(RelocatePhase::BeforeSqlCommit);
                    Ok((RelocateReceipt {document_id: current.id, version: journal.version,
                        content_hash: journal.content_hash.clone()}, change))
                },
            ).map_err(|e| anyhow!(e.message))?;
            crash_point(RelocatePhase::Committed);
            Ok(())
        })();
        if let Err(error) = self.conn.pragma_update(None, "synchronous", synchronous) {
            eprintln!("File relocation synchronous restore failed: {error}");
        }
        if let Err(error) = result {
            if let Err(recovery) = self.file_relocate_recover(&directory, &journal) {
                return Err(anyhow!("{error}; relocation journal retained: {recovery}"));
            }
            return Err(error);
        }
        if let Err(error) = self.file_relocate_clear(&directory) {
            eprintln!("Committed File relocation cleanup pending: {error}");
        }
        self.document_record(current.id)
    }
}

#[cfg(test)]
mod tests {
    use super::super::Database;
    use crate::models::{DocumentImportInput, DocumentRelocateInput, ProjectCreateInput};
    use std::{fs, path::Path};
    fn fixture(root: &Path, legacy: bool) -> (Database, crate::models::DocumentRecord) {
        let (_, paths) = crate::workspace::create_workspace(root, "password").unwrap();
        let mut db = Database::open(&paths.db_path, root, None).unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Relocate".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let source = root.join("original.txt");
        fs::write(&source, b"original\r\n").unwrap();
        let input = DocumentImportInput {
            project_id: Some(project.id),
            source_path: source.to_string_lossy().into(),
            is_starred: false,
            tag_ids: None,
        };
        let file = if legacy {
            db.document_import_legacy_fixture(input)
        } else {
            db.document_import(input)
        }
        .unwrap();
        (db, file)
    }
    fn crash(root: &Path, stage: u8) {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "db::file_relocations::tests::file_relocate_crash_process_fixture",
                "--ignored",
            ])
            .env("MIND_FILE_RELOCATE_CRASH_FIXTURE", root)
            .env("MIND_FILE_RELOCATE_CRASH_STAGE", stage.to_string())
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
    #[ignore = "subprocess-only fixture started by File relocation recovery tests"]
    fn file_relocate_crash_process_fixture() {
        let Ok(root) = std::env::var("MIND_FILE_RELOCATE_CRASH_FIXTURE") else {
            return;
        };
        let root = Path::new(&root);
        let (_, paths) = crate::workspace::load_metadata(root).unwrap();
        let mut db = Database::open(&paths.db_path, root, None).unwrap();
        let id = db
            .conn
            .query_row("SELECT id FROM documents", [], |r| r.get(0))
            .unwrap();
        db.document_relocate(DocumentRelocateInput {
            document_id: id,
            new_source_path: root.join("located.txt").to_string_lossy().into(),
        })
        .unwrap();
        panic!("relocation crash boundary not reached");
    }
    #[test]
    fn file_relocate_process_crashes_restore_missing_head_or_commit_identical_version() {
        for missing in [false, true] {
            for stage in 0..=4 {
                let root = tempfile::tempdir().unwrap();
                let (db, file) = fixture(root.path(), false);
                fs::write(root.path().join("located.txt"), b"original\r\n").unwrap();
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
                let current = db.document_record(file.id).unwrap();
                assert_eq!(current.current_version_number, 1);
                assert_eq!(current.version_count, 1);
                assert_eq!(current.id, file.id);
                let expected = if stage == 4 {
                    root.path().join("located.txt")
                } else {
                    root.path().join("original.txt")
                };
                assert_eq!(Path::new(&current.original_path), expected);
                if missing && stage < 4 {
                    assert!(!Path::new(&current.managed_path).exists());
                } else {
                    assert_eq!(fs::read(&current.managed_path).unwrap(), b"original\r\n");
                }
                let version = db.fetch_document_versions(file.id).unwrap().remove(0);
                assert_eq!(Path::new(&version.source_path), expected);
                let hashes: i64 = db
                    .conn
                    .query_row("SELECT count(*) FROM source_file_version_hashes", [], |r| {
                        r.get(0)
                    })
                    .unwrap();
                assert_eq!(hashes, 1);
                assert_eq!(
                    db.committed_change_watermark().unwrap(),
                    before + i64::from(stage == 4)
                );
                db.file_version_recover_pending().unwrap();
                assert_eq!(
                    db.committed_change_watermark().unwrap(),
                    before + i64::from(stage == 4)
                );
                assert_eq!(
                    fs::read(root.path().join("located.txt")).unwrap(),
                    b"original\r\n"
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
    fn file_relocate_outbox_failure_keeps_missing_state_and_external_edit_is_preserved() {
        for missing in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let (mut db, file) = fixture(root.path(), false);
            let source = root.path().join("located.txt");
            fs::write(&source, b"original\r\n").unwrap();
            if missing {
                fs::remove_file(&file.managed_path).unwrap();
            }
            let before = db.committed_change_watermark().unwrap();
            db.conn.execute_batch("CREATE TRIGGER fail_relocate_outbox BEFORE INSERT ON agent_change_log BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END;").unwrap();
            let input = DocumentRelocateInput {
                document_id: file.id,
                new_source_path: source.to_string_lossy().into(),
            };
            assert!(db.document_relocate(input.clone()).is_err());
            assert_eq!(
                db.document_record(file.id).unwrap().original_path,
                file.original_path
            );
            assert_eq!(Path::new(&file.managed_path).exists(), !missing);
            assert_eq!(db.committed_change_watermark().unwrap(), before);
            db.conn
                .execute_batch("DROP TRIGGER fail_relocate_outbox")
                .unwrap();
            fs::write(&file.managed_path, b"user external edit\r\n").unwrap();
            let error = db.document_relocate(input).unwrap_err();
            assert!(error.to_string().contains("FILE_CHANGED_UNREGISTERED"));
            assert_eq!(
                fs::read(&file.managed_path).unwrap(),
                b"user external edit\r\n"
            );
            assert_eq!(db.committed_change_watermark().unwrap(), before);
        }
    }
    #[test]
    fn file_relocate_recovery_preserves_foreign_same_byte_copy() {
        let root = tempfile::tempdir().unwrap();
        let (db, file) = fixture(root.path(), false);
        fs::write(root.path().join("located.txt"), b"original\r\n").unwrap();
        fs::remove_file(&file.managed_path).unwrap();
        let before = db.committed_change_watermark().unwrap();
        drop(db);
        crash(root.path(), 2);
        let held = root.path().join("owned-repair.txt");
        fs::rename(&file.managed_path, &held).unwrap();
        fs::write(&file.managed_path, b"original\r\n").unwrap();
        let (metadata, paths) = crate::workspace::load_metadata(root.path()).unwrap();
        assert!(crate::workspace_initialization::open_workspace_database(
            &paths.db_path,
            root.path(),
            None,
            &metadata.workspace_id
        )
        .is_err());
        assert_eq!(fs::read(&file.managed_path).unwrap(), b"original\r\n");
        fs::remove_file(&file.managed_path).unwrap();
        fs::rename(&held, &file.managed_path).unwrap();
        let db = crate::workspace_initialization::open_workspace_database(
            &paths.db_path,
            root.path(),
            None,
            &metadata.workspace_id,
        )
        .unwrap()
        .db;
        assert!(!Path::new(&file.managed_path).exists());
        assert_eq!(db.committed_change_watermark().unwrap(), before);
    }
    #[test]
    fn file_relocate_same_location_and_bytes_has_no_change() {
        let root = tempfile::tempdir().unwrap();
        let (mut db, file) = fixture(root.path(), false);
        let before = db.committed_change_watermark().unwrap();
        let result = db
            .document_relocate(DocumentRelocateInput {
                document_id: file.id,
                new_source_path: file.original_path.clone(),
            })
            .unwrap();
        assert_eq!(result.current_version_number, 1);
        assert_eq!(result.original_path, file.original_path);
        assert_eq!(db.committed_change_watermark().unwrap(), before);
        let receipts: i64 = db
            .conn
            .query_row(
                "SELECT count(*) FROM agent_operation_receipts WHERE operation='file.relocate'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(receipts, 0);
    }

    #[test]
    fn file_relocate_recovery_waits_for_live_staging_lock() {
        let root = tempfile::tempdir().unwrap();
        let (db, file) = fixture(root.path(), false);
        let directory =
            root.path()
                .join(super::JOURNALS)
                .join(format!("{}-{}", file.id, "5".repeat(32)));
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("new.bin"), b"preparing").unwrap();
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
        assert_eq!(fs::read(directory.join("new.bin")).unwrap(), b"preparing");
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
    fn file_relocate_different_or_unregistered_bytes_cannot_replace_version() {
        for legacy in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let (mut db, file) = fixture(root.path(), legacy);
            let source = root.path().join("other.txt");
            fs::write(&source, b"replacement\r\n").unwrap();
            let before = db.committed_change_watermark().unwrap();
            assert!(db
                .document_relocate(DocumentRelocateInput {
                    document_id: file.id,
                    new_source_path: source.to_string_lossy().into()
                })
                .is_err());
            assert_eq!(fs::read(&file.managed_path).unwrap(), b"original\r\n");
            assert_eq!(
                db.document_record(file.id).unwrap().original_path,
                file.original_path
            );
            assert_eq!(db.committed_change_watermark().unwrap(), before);
            fs::write(&source, b"original\r\n").unwrap();
            if legacy {
                assert!(db
                    .document_relocate(DocumentRelocateInput {
                        document_id: file.id,
                        new_source_path: source.to_string_lossy().into()
                    })
                    .is_err());
            }
        }
    }
}
