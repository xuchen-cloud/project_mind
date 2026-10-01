//! File metadata and all-version rename share a durable filesystem/SQL boundary.
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
    models::{DocumentRecord, DocumentUpdateMetaInput},
};
use anyhow::{anyhow, bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

const JOURNALS: &str = ".project-mind/file-metadata-journal";
const MAX_JOURNAL_BYTES: u64 = 1024 * 1024;
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct MetadataState {
    project_id: i64,
    base_name: String,
    name: String,
    managed: String,
    history: String,
    storage_mode: String,
    current_version: i64,
    version_count: i64,
    starred: bool,
    tags: Vec<i64>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct VersionMove {
    id: i64,
    number: i64,
    old_name: String,
    original: String,
    next_name: String,
    next: String,
    captured_hash: Option<String>,
    identity: Option<FileIdentity>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MetadataJournal {
    schema_version: u32,
    workspace_id: Option<String>,
    request_id: String,
    document_id: i64,
    old: MetadataState,
    base_name: String,
    starred: bool,
    tags: Vec<i64>,
    moves: Vec<VersionMove>,
}
#[derive(Serialize, Deserialize)]
struct MetadataReceipt {
    document_id: i64,
    revision: String,
}
#[derive(Clone, Copy)]
enum MetadataPhase {
    Prepared,
    FirstTemporary,
    Temporary,
    FirstPlaced,
    Placed,
    BeforeSqlCommit,
    Committed,
}
fn crash_point(phase: MetadataPhase) {
    #[cfg(test)]
    if std::env::var("MIND_FILE_METADATA_CRASH_STAGE")
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
        && Path::new(value).file_name().and_then(|name| name.to_str()) == Some(value)
}
fn nonce(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}
impl Database {
    fn file_metadata_state(&self, record: &DocumentRecord) -> Result<MetadataState> {
        Ok(MetadataState {
            project_id: record.project_id,
            base_name: record.base_name.clone(),
            name: record.name.clone(),
            managed: relative(&self.workspace_root, Path::new(&record.managed_path))?,
            history: relative(&self.workspace_root, Path::new(&record.history_dir_path))?,
            storage_mode: record.storage_mode.clone(),
            current_version: record.current_version_number,
            version_count: record.version_count,
            starred: record.is_starred,
            tags: super::normalize_file_tag_ids(
                &record.tags.iter().map(|tag| tag.id).collect::<Vec<_>>(),
            ),
        })
    }
    fn metadata_temporary(directory: &Path, plan: &VersionMove) -> PathBuf {
        directory.join(format!("{}.bin", plan.id))
    }
    fn file_metadata_clear(&self, directory: &Path) -> Result<()> {
        fs::remove_dir_all(directory)?;
        sync_directory(directory.parent().unwrap())
    }
    fn file_metadata_validate(&self, journal: &MetadataJournal) -> Result<()> {
        if journal.schema_version != 1
            || journal.workspace_id != self.native_workspace_id
            || journal.document_id <= 0
            || journal.old.project_id <= 0
            || !nonce(&journal.request_id)
            || !component(&journal.base_name)
            || journal.old.current_version <= 0
            || journal.old.version_count <= 0
            || !component(&journal.old.base_name)
            || !component(&journal.old.name)
            || journal.moves.len() as i64 != journal.old.version_count
        {
            bail!("Invalid File metadata journal");
        }
        let old_head = owned(&self.workspace_root, &journal.old.managed)?;
        let history = owned(&self.workspace_root, &journal.old.history)?;
        let mut ids = HashSet::new();
        let mut numbers = HashSet::new();
        let mut originals = HashSet::new();
        let mut destinations = HashSet::new();
        for plan in &journal.moves {
            let original = owned(&self.workspace_root, &plan.original)?;
            let next = owned(&self.workspace_root, &plan.next)?;
            let expected_parent = if plan.number == journal.old.current_version {
                old_head.parent().unwrap()
            } else {
                history.as_path()
            };
            if plan.id <= 0
                || plan.number <= 0
                || plan.number > journal.old.current_version
                || !ids.insert(plan.id)
                || !numbers.insert(plan.number)
                || !originals.insert(&plan.original)
                || !destinations.insert(&plan.next)
                || !component(&plan.old_name)
                || original != expected_parent.join(&plan.old_name)
                || (plan.number == journal.old.current_version && original != old_head)
                || plan.next_name != super::versioned_file_name(&journal.base_name, plan.number)
                || next != expected_parent.join(&plan.next_name)
                || plan.captured_hash.is_some() != plan.identity.is_some()
                || plan
                    .captured_hash
                    .as_ref()
                    .is_some_and(|hash| !valid_hash(hash))
            {
                bail!("Invalid File metadata version move");
            }
        }
        if !numbers.contains(&journal.old.current_version) {
            bail!("Missing File metadata head");
        }
        Ok(())
    }
    fn file_metadata_recover(&self, directory: &Path, journal: &MetadataJournal) -> Result<()> {
        self.file_metadata_validate(journal)?;
        let receipt: Option<MetadataReceipt> = self
            .agent_operation_replay("gui", &journal.request_id, "file.metadata", journal)
            .map_err(|e| anyhow!(e.message))?;
        if let Some(receipt) = receipt {
            let revision = format!(
                "metadata:{:x}",
                Sha256::digest(serde_json::to_vec(journal)?)
            );
            if receipt.document_id != journal.document_id || receipt.revision != revision {
                bail!("File metadata receipt mismatch");
            }
            return self.file_metadata_clear(directory);
        }
        let current = self.document_record(journal.document_id)?;
        if self.file_metadata_state(&current)? != journal.old {
            bail!("File metadata changed; journal retained");
        }
        // Locate every owned file before modifying anything. Two-phase recovery
        // also supports overlapping old/new names and interrupted recovery.
        let mut locations = Vec::new();
        for plan in &journal.moves {
            if plan.original == plan.next || plan.identity.is_none() {
                continue;
            }
            let original = owned(&self.workspace_root, &plan.original)?;
            let next = owned(&self.workspace_root, &plan.next)?;
            let temporary = Self::metadata_temporary(directory, plan);
            let mut matches = Vec::new();
            for path in [&original, &next, &temporary] {
                if path.exists() && path_identity(path).ok().as_ref() == plan.identity.as_ref() {
                    if checksum(path)? != *plan.captured_hash.as_ref().unwrap() {
                        bail!("File bytes changed; metadata journal retained");
                    }
                    matches.push(path.clone());
                }
            }
            if matches.len() != 1 {
                bail!("File move ownership is ambiguous; journal retained");
            }
            locations.push((matches.remove(0), temporary, original));
        }
        for (current, temporary, _) in &locations {
            if current != temporary {
                move_exclusive(current, temporary)?;
            }
        }
        for (_, temporary, original) in &locations {
            move_exclusive(temporary, original)?;
        }
        self.file_metadata_clear(directory)
    }
    pub(super) fn file_metadata_recover_pending(&self) -> Result<()> {
        let base = self.workspace_root.join(JOURNALS);
        if !base.exists() {
            return Ok(());
        }
        relative(&self.workspace_root, &base)?;
        for entry in fs::read_dir(&base)? {
            let entry = entry?;
            let kind = match entry.file_type() {
                Ok(kind) => kind,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            if !kind.is_dir() || kind.is_symlink() {
                bail!("Invalid metadata journal directory");
            }
            let directory = entry.path();
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| anyhow!("Invalid metadata journal encoding"))?;
            let (id, request_id) = name
                .split_once('-')
                .ok_or_else(|| anyhow!("Invalid metadata journal name"))?;
            let document_id: i64 = id.parse()?;
            if document_id <= 0 || document_id.to_string() != id || !nonce(request_id) {
                bail!("Invalid metadata journal identity");
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
                self.file_metadata_clear(&directory)?;
                continue;
            }
            regular(&descriptor)?;
            if fs::metadata(&descriptor)?.len() > MAX_JOURNAL_BYTES {
                bail!("File metadata journal exceeds budget");
            }
            let journal: MetadataJournal = serde_json::from_slice(&fs::read(&descriptor)?)?;
            if journal.document_id != document_id || journal.request_id != request_id {
                bail!("Metadata journal identity mismatch");
            }
            self.file_metadata_recover(&directory, &journal)?;
        }
        Ok(())
    }
    pub fn document_update_meta(
        &mut self,
        input: DocumentUpdateMetaInput,
    ) -> Result<DocumentRecord> {
        let _locks = self.file_native_write_locks(input.document_id)?;
        let current = self.document_record(input.document_id)?;
        self.ensure_project_file_layout(current.project_id)?;
        let current = self.document_record(input.document_id)?;
        let old = self.file_metadata_state(&current)?;
        let base_name = input
            .base_name
            .as_deref()
            .map(|name| self.normalize_document_base_name(name, &current.base_name))
            .transpose()?
            .unwrap_or_else(|| current.base_name.clone());
        let starred = input.is_starred.unwrap_or(current.is_starred);
        let tags = input
            .tag_ids
            .as_deref()
            .map(super::normalize_file_tag_ids)
            .unwrap_or_else(|| old.tags.clone());
        for tag in &tags {
            self.scoped_file_tag_record(Some(current.project_id), *tag)?;
        }
        if base_name == old.base_name && starred == old.starred && tags == old.tags {
            return Ok(current);
        }
        self.ensure_document_name_available(current.project_id, &base_name, Some(current.id))?;
        let request_id = token();
        let base = self.workspace_root.join(JOURNALS);
        create_owned_directories(&self.workspace_root, &base)?;
        let directory = base.join(format!("{}-{request_id}", current.id));
        fs::create_dir(&directory)?;
        sync_directory(&base)?;
        let prepared = (|| -> Result<MetadataJournal> {
            let versions = self.fetch_document_versions(current.id)?;
            let known = versions
                .iter()
                .map(|v| PathBuf::from(&v.managed_path))
                .collect::<HashSet<_>>();
            let mut moves = Vec::new();
            let mut identities = HashSet::new();
            for version in versions {
                let original = PathBuf::from(&version.managed_path);
                let next_name = super::versioned_file_name(&base_name, version.version_number);
                let next = original.with_file_name(&next_name);
                if next.exists() && !known.contains(&next) {
                    bail!("Rename destination is occupied");
                }
                let (captured_hash, file_identity) = if original != next && original.exists() {
                    let hash = checksum(&original)?;
                    let id = path_identity(&original)?;
                    if !identities.insert(serde_json::to_string(&id)?) {
                        bail!("File versions share a physical file; rename refused");
                    }
                    (Some(hash), Some(id))
                } else {
                    (None, None)
                };
                moves.push(VersionMove {
                    id: version.id,
                    number: version.version_number,
                    old_name: version.name,
                    original: relative(&self.workspace_root, &original)?,
                    next_name,
                    next: relative(&self.workspace_root, &next)?,
                    captured_hash,
                    identity: file_identity,
                });
            }
            let journal = MetadataJournal {
                schema_version: 1,
                workspace_id: self.native_workspace_id.clone(),
                request_id,
                document_id: current.id,
                old,
                base_name,
                starred,
                tags,
                moves,
            };
            self.file_metadata_validate(&journal)?;
            let bytes = serde_json::to_vec(&journal)?;
            if bytes.len() as u64 > MAX_JOURNAL_BYTES {
                bail!("File metadata journal exceeds budget");
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
            crash_point(MetadataPhase::Prepared);
            Ok(journal)
        })();
        let journal = match prepared {
            Ok(journal) => journal,
            Err(error) => {
                let _ = self.file_metadata_clear(&directory);
                return Err(error);
            }
        };
        let synchronous: i64 = self
            .conn
            .pragma_query_value(None, "synchronous", |r| r.get(0))?;
        self.conn
            .pragma_update(None, "synchronous", synchronous.max(2))?;
        let result = (|| -> Result<()> {
            for plan in &journal.moves {
                if let Some(id) = &plan.identity {
                    let original = owned(&self.workspace_root, &plan.original)?;
                    if path_identity(&original)? != *id
                        || checksum(&original)? != *plan.captured_hash.as_ref().unwrap()
                    {
                        bail!("File changed before metadata commit");
                    }
                    move_exclusive(&original, &Self::metadata_temporary(&directory, plan))?;
                    crash_point(MetadataPhase::FirstTemporary);
                }
            }
            crash_point(MetadataPhase::Temporary);
            for plan in &journal.moves {
                if plan.identity.is_some() {
                    move_exclusive(
                        &Self::metadata_temporary(&directory, plan),
                        &owned(&self.workspace_root, &plan.next)?,
                    )?;
                    crash_point(MetadataPhase::FirstPlaced);
                }
            }
            crash_point(MetadataPhase::Placed);
            for plan in &journal.moves {
                if plan.original == plan.next {
                    continue;
                }
                let next = owned(&self.workspace_root, &plan.next)?;
                if let Some(id) = &plan.identity {
                    if path_identity(&next)? != *id
                        || checksum(&next)? != *plan.captured_hash.as_ref().unwrap()
                    {
                        bail!("Renamed File changed before metadata registration");
                    }
                } else if next.exists() {
                    bail!("Missing File Version destination became occupied");
                }
            }
            let revision = format!(
                "metadata:{:x}",
                Sha256::digest(serde_json::to_vec(&journal)?)
            );
            let head = journal
                .moves
                .iter()
                .find(|plan| plan.number == journal.old.current_version)
                .unwrap();
            let stamp = super::now_iso();
            self.agent_atomic_operation(
                "gui", &journal.request_id, "file.metadata", &journal,
                |tx| {
                    let record = self.document_record(current.id).map_err(|_| {
                        AgentError::new(ErrorCode::RevisionConflict,
                            "File was deleted before metadata commit")
                    })?;
                    let state = self.file_metadata_state(&record).map_err(|_| {
                        AgentError::new(ErrorCode::RevisionConflict, "File path changed")
                    })?;
                    if state != journal.old {
                        return Err(AgentError::new(ErrorCode::RevisionConflict,
                            "File metadata changed before commit"));
                    }
                    self.ensure_document_name_available(current.project_id,
                        &journal.base_name, Some(current.id)).map_err(|_| {
                        AgentError::new(ErrorCode::RevisionConflict,
                            "File name became unavailable")
                    })?;
                    tx.execute(
                        "UPDATE documents SET name=?1,base_name=?2,managed_path=?3,is_starred=?4,updated_at=?5 WHERE id=?6",
                        params![head.next_name, journal.base_name,
                            self.encode_path_ref(&self.workspace_root.join(&head.next)),
                            super::bool_to_int(journal.starred), stamp, current.id],
                    ).map_err(io_error)?;
                    for plan in &journal.moves {
                        let count = tx.execute(
                            "UPDATE document_versions SET name=?1,managed_path=?2
                             WHERE id=?3 AND document_id=?4 AND version_number=?5 AND name=?6 AND managed_path=?7",
                            params![plan.next_name,
                                self.encode_path_ref(&self.workspace_root.join(&plan.next)),
                                plan.id, current.id, plan.number, plan.old_name,
                                self.encode_path_ref(&self.workspace_root.join(&plan.original))],
                        ).map_err(io_error)?;
                        if count != 1 {
                            return Err(AgentError::new(ErrorCode::RevisionConflict,
                                "File Version metadata changed"));
                        }
                    }
                    for tag in &journal.tags {
                        self.scoped_file_tag_record(Some(current.project_id), *tag)
                            .map_err(|_| AgentError::new(ErrorCode::ScopeDenied,
                                "File tag is outside actual Project"))?;
                    }
                    tx.execute("DELETE FROM document_tag_links WHERE document_id=?1",
                        [current.id]).map_err(io_error)?;
                    for tag in &journal.tags {
                        tx.execute(
                            "INSERT INTO document_tag_links(document_id,tag_id,created_at) VALUES (?1,?2,?3)",
                            params![current.id, tag, stamp],
                        ).map_err(io_error)?;
                    }
                    tx.execute("UPDATE projects SET updated_at=?1 WHERE id=?2",
                        params![stamp, current.project_id]).map_err(io_error)?;
                    let change = if journal.old.storage_mode != "managed_note_image" {
                        if let Some(workspace_id) = &journal.workspace_id {
                            let object = ObjectRef {
                                workspace_id: workspace_id.clone(),
                                scope: Scope::Project {project_id: current.project_id},
                                kind: ObjectKind::File, id: current.id.to_string(),
                            };
                            Some(OperationChange {object_key: object.key()?,
                                scope: object.scope, revision: revision.clone()})
                        } else {None}
                    } else {None};
                    crash_point(MetadataPhase::BeforeSqlCommit);
                    Ok((MetadataReceipt {document_id: current.id,
                        revision: revision.clone()}, change))
                },
            ).map_err(|e| anyhow!(e.message))?;
            crash_point(MetadataPhase::Committed);
            Ok(())
        })();
        if let Err(error) = self.conn.pragma_update(None, "synchronous", synchronous) {
            eprintln!("File metadata synchronous restore failed: {error}");
        }
        if let Err(error) = result {
            if let Err(recovery) = self.file_metadata_recover(&directory, &journal) {
                return Err(anyhow!("{error}; metadata journal retained: {recovery}"));
            }
            return Err(error);
        }
        if let Err(error) = self.file_metadata_clear(&directory) {
            eprintln!("Committed File metadata cleanup pending: {error}");
        }
        self.document_record(current.id)
    }
}

#[cfg(test)]
mod tests {
    use super::super::Database;
    use crate::models::{
        DocumentAddVersionInput, DocumentImportInput, DocumentUpdateMetaInput, ProjectCreateInput,
    };
    use std::{fs, path::Path};

    fn fixture(root: &Path, missing_middle: bool) -> (Database, crate::models::DocumentRecord) {
        let (_, paths) = crate::workspace::create_workspace(root, "password").unwrap();
        let mut db = Database::open(&paths.db_path, root, None).unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Rename crash".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let source = root.join("original.txt");
        fs::write(&source, b"v1\r\n").unwrap();
        let mut file = db
            .document_import_legacy_fixture(DocumentImportInput {
                project_id: project.id,
                source_path: source.to_string_lossy().into(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        for bytes in [b"v2\r\n", b"v3\r\n"] {
            fs::write(&source, bytes).unwrap();
            file = db
                .document_add_version(DocumentAddVersionInput {
                    document_id: file.id,
                    source_path: Some(source.to_string_lossy().into()),
                })
                .unwrap();
        }
        if missing_middle {
            fs::remove_file(Path::new(&file.history_dir_path).join("original_v2.txt")).unwrap();
        }
        (db, file)
    }
    fn crash(root: &Path, stage: u8, name: &str) {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "db::file_metadata::tests::file_metadata_crash_process_fixture",
                "--ignored",
            ])
            .env("MIND_FILE_METADATA_CRASH_FIXTURE", root)
            .env("MIND_FILE_METADATA_CRASH_STAGE", stage.to_string())
            .env("MIND_FILE_METADATA_NEW_NAME", name)
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
    #[ignore = "subprocess-only fixture started by metadata crash/recovery tests"]
    fn file_metadata_crash_process_fixture() {
        let Ok(root) = std::env::var("MIND_FILE_METADATA_CRASH_FIXTURE") else {
            return;
        };
        let root = Path::new(&root);
        let (_, paths) = crate::workspace::load_metadata(root).unwrap();
        let mut db = Database::open(&paths.db_path, root, None).unwrap();
        let id = db
            .conn
            .query_row("SELECT id FROM documents", [], |row| row.get(0))
            .unwrap();
        db.document_update_meta(DocumentUpdateMetaInput {
            document_id: id,
            base_name: Some(std::env::var("MIND_FILE_METADATA_NEW_NAME").unwrap()),
            is_starred: Some(true),
            tag_ids: None,
        })
        .unwrap();
        panic!("metadata crash boundary not reached");
    }
    #[test]
    fn file_metadata_process_crashes_restore_missing_and_overlapping_versions() {
        for (missing, name) in [(true, "renamed.txt"), (false, "original_v2.txt")] {
            for stage in 0..=6 {
                let root = tempfile::tempdir().unwrap();
                let (db, file) = fixture(root.path(), missing);
                let before = db.committed_change_watermark().unwrap();
                drop(db);
                crash(root.path(), stage, name);
                let (metadata, paths) = crate::workspace::load_metadata(root.path()).unwrap();
                let db = crate::workspace_initialization::open_workspace_database(
                    &paths.db_path,
                    root.path(),
                    None,
                    &metadata.workspace_id,
                )
                .unwrap()
                .db;
                let record = db.document_record(file.id).unwrap();
                let expected = if stage == 6 { name } else { "original.txt" };
                assert_eq!(record.base_name, expected);
                assert_eq!(record.is_starred, stage == 6);
                assert_eq!(record.id, file.id);
                assert_eq!(record.version_count, 3);
                assert_eq!(record.current_version_number, 3);
                for version in db.fetch_document_versions(file.id).unwrap() {
                    assert_eq!(
                        version.name,
                        super::super::versioned_file_name(expected, version.version_number)
                    );
                    if missing && version.version_number == 2 {
                        assert!(!Path::new(&version.managed_path).exists());
                    } else {
                        assert_eq!(
                            fs::read(version.managed_path).unwrap(),
                            format!("v{}\r\n", version.version_number).as_bytes()
                        );
                    }
                }
                assert_eq!(
                    db.committed_change_watermark().unwrap(),
                    before + i64::from(stage == 6)
                );
                let hashes: i64 = db
                    .conn
                    .query_row("SELECT count(*) FROM source_file_version_hashes", [], |r| {
                        r.get(0)
                    })
                    .unwrap();
                assert_eq!(hashes, 2, "rename must not register unknown v1 bytes");
                db.file_version_recover_pending().unwrap();
                assert_eq!(
                    db.committed_change_watermark().unwrap(),
                    before + i64::from(stage == 6)
                );
                assert_eq!(
                    fs::read(root.path().join("original.txt")).unwrap(),
                    b"v3\r\n"
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
    fn file_metadata_recovery_preserves_foreign_original_even_with_same_bytes() {
        let root = tempfile::tempdir().unwrap();
        let (db, file) = fixture(root.path(), false);
        let before = db.committed_change_watermark().unwrap();
        drop(db);
        crash(root.path(), 2, "renamed.txt");
        fs::write(&file.managed_path, b"v3\r\n").unwrap();
        let (metadata, paths) = crate::workspace::load_metadata(root.path()).unwrap();
        assert!(crate::workspace_initialization::open_workspace_database(
            &paths.db_path,
            root.path(),
            None,
            &metadata.workspace_id
        )
        .is_err());
        assert_eq!(fs::read(&file.managed_path).unwrap(), b"v3\r\n");
        fs::remove_file(&file.managed_path).unwrap();
        let db = crate::workspace_initialization::open_workspace_database(
            &paths.db_path,
            root.path(),
            None,
            &metadata.workspace_id,
        )
        .unwrap()
        .db;
        assert_eq!(
            db.document_record(file.id).unwrap().base_name,
            "original.txt"
        );
        assert_eq!(fs::read(&file.managed_path).unwrap(), b"v3\r\n");
        assert_eq!(db.committed_change_watermark().unwrap(), before);
    }
    #[test]
    fn file_metadata_tags_no_change_and_scope_use_actual_registration() {
        use crate::models::FileTagOptionUpsertInput;
        let root = tempfile::tempdir().unwrap();
        let (mut db, file) = fixture(root.path(), false);
        let tag = db
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                project_id: Some(file.project_id),
                id: None,
                label: "Useful".into(),
                color_key: "blue".into(),
            })
            .unwrap();
        let foreign = db
            .project_create(ProjectCreateInput {
                name: "Foreign".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let foreign_tag = db
            .file_tag_option_upsert(FileTagOptionUpsertInput {
                project_id: Some(foreign.id),
                id: None,
                label: "Forbidden".into(),
                color_key: "blue".into(),
            })
            .unwrap();
        let before = db.committed_change_watermark().unwrap();
        assert!(db
            .document_update_meta(DocumentUpdateMetaInput {
                document_id: file.id,
                base_name: Some("renamed.txt".into()),
                is_starred: Some(true),
                tag_ids: Some(vec![foreign_tag.id])
            })
            .is_err());
        assert_eq!(
            db.document_record(file.id).unwrap().base_name,
            file.base_name
        );
        assert_eq!(db.committed_change_watermark().unwrap(), before);
        let input = DocumentUpdateMetaInput {
            document_id: file.id,
            base_name: None,
            is_starred: Some(true),
            tag_ids: Some(vec![tag.id, tag.id]),
        };
        let result = db.document_update_meta(input.clone()).unwrap();
        assert_eq!(result.tags.len(), 1);
        assert!(result.is_starred);
        assert_eq!(result.base_name, file.base_name);
        assert_eq!(db.committed_change_watermark().unwrap(), before + 1);
        let receipt_count: i64 = db
            .conn
            .query_row("SELECT count(*) FROM agent_operation_receipts", [], |r| {
                r.get(0)
            })
            .unwrap();
        db.document_update_meta(input).unwrap();
        assert_eq!(db.committed_change_watermark().unwrap(), before + 1);
        let after: i64 = db
            .conn
            .query_row("SELECT count(*) FROM agent_operation_receipts", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(after, receipt_count);
        assert_eq!(fs::read(&file.managed_path).unwrap(), b"v3\r\n");
    }

    #[test]
    fn file_metadata_recovery_waits_for_live_file_lock_before_staging_cleanup() {
        let root = tempfile::tempdir().unwrap();
        let (db, file) = fixture(root.path(), false);
        let directory =
            root.path()
                .join(super::JOURNALS)
                .join(format!("{}-{}", file.id, "3".repeat(32)));
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
    fn file_metadata_outbox_failure_restores_all_versions_and_metadata() {
        let root = tempfile::tempdir().unwrap();
        let (_, paths) = crate::workspace::create_workspace(root.path(), "password").unwrap();
        let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Metadata".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let source = root.path().join("original.txt");
        fs::write(&source, b"old\r\n").unwrap();
        let file = db
            .document_import(DocumentImportInput {
                project_id: project.id,
                source_path: source.to_string_lossy().into(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        fs::write(&source, b"new\r\n").unwrap();
        let file = db
            .document_add_version(DocumentAddVersionInput {
                document_id: file.id,
                source_path: Some(source.to_string_lossy().into()),
            })
            .unwrap();
        let before = db.committed_change_watermark().unwrap();
        db.conn.execute_batch("CREATE TRIGGER fail_file_metadata BEFORE INSERT ON agent_change_log BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END;").unwrap();
        assert!(db
            .document_update_meta(DocumentUpdateMetaInput {
                document_id: file.id,
                base_name: Some("renamed.txt".into()),
                is_starred: Some(true),
                tag_ids: None
            })
            .is_err());
        let current = db.document_record(file.id).unwrap();
        assert_eq!(current.base_name, file.base_name);
        assert!(!current.is_starred);
        assert_eq!(fs::read(&current.managed_path).unwrap(), b"new\r\n");
        assert_eq!(
            fs::read(Path::new(&current.history_dir_path).join("original.txt")).unwrap(),
            b"old\r\n"
        );
        assert!(!Path::new(&project.root_path)
            .join("renamed_v2.txt")
            .exists());
        assert_eq!(db.committed_change_watermark().unwrap(), before);
    }
}
