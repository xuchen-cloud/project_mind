//! Project directory Files retain their real location. Only immutable bytes are
//! stored in the existing document_versions / source_file_version_hashes tables.
use super::{file_versions, Database};
use crate::agent::models::{ObjectKind, ObjectRef, Scope};
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileServiceError {
    pub code: &'static str,
    pub message: String,
}
impl std::fmt::Display for FileServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for FileServiceError {}
impl FileServiceError {
    pub(crate) fn from_error(error: anyhow::Error) -> Self {
        match error.downcast::<Self>() {
            Ok(error) => error,
            Err(error) => Self {
                code: "io_failed",
                message: format!("{error:#}"),
            },
        }
    }
}
fn failure(code: &'static str, message: &str) -> anyhow::Error {
    FileServiceError {
        code,
        message: message.into(),
    }
    .into()
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectoryFile {
    pub object: ObjectRef,
    pub relative_path: String,
    pub name: String,
    pub version_number: u32,
    pub content_hash: Option<String>,
    pub state: String,
    pub reason: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
struct DirectoryMetadata {
    starred: bool,
    tags: Vec<i64>,
}
const MAX_SCAN_OPEN_DIRECTORIES: usize = 32;
const MAX_GLOBAL_SCAN_OPEN_DIRECTORIES: usize = 128;
static SCAN_OPEN_DIRECTORIES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
struct ScanFdPermit;
impl ScanFdPermit {
    fn acquire() -> Result<Self> {
        use std::sync::atomic::Ordering;
        SCAN_OPEN_DIRECTORIES.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count|
            (count < MAX_GLOBAL_SCAN_OPEN_DIRECTORIES).then_some(count + 1))
            .map_err(|_| failure("scan_fd_budget", "Directory scans reached the global 128-handle budget; finish another scan and start again"))?;
        Ok(Self)
    }
}
impl Drop for ScanFdPermit {
    fn drop(&mut self) { SCAN_OPEN_DIRECTORIES.fetch_sub(1, std::sync::atomic::Ordering::SeqCst); }
}
struct ScanEntry {
    name: String,
    kind: fs::FileType,
}
struct ScanFrame {
    relative_path: String,
    entries: Option<fs::ReadDir>,
    // Unix DirEntry can own a reference to ReadDir's fd. Store only owned
    // names/types so exhausted parents release their fd before descending.
    buffered: std::collections::VecDeque<ScanEntry>,
    exhausted: bool,
    permit: Option<ScanFdPermit>,
}
impl ScanFrame {
    fn new(relative_path: String) -> Self {
        Self { relative_path, entries: None, buffered: Default::default(), exhausted: false, permit: None }
    }
    fn open(&mut self, directory: &Path, open_in_scan: usize) -> Result<()> {
        if open_in_scan >= MAX_SCAN_OPEN_DIRECTORIES {
            return Err(failure("scan_fd_budget", "Directory scan reached its 32-handle budget; nested wide directories require a narrower subtree scan"));
        }
        let permit = ScanFdPermit::acquire()?;
        self.entries = Some(fs::read_dir(directory)?);
        self.permit = Some(permit);
        Ok(())
    }
    fn fill_batch(&mut self, entries_read: &mut usize) -> Vec<ScanFailure> {
        let mut failures = vec![];
        let mut batch = std::collections::BTreeMap::new();
        while *entries_read < 128 {
            match self.entries.as_mut().unwrap().next() {
                Some(Ok(entry)) => {
                    *entries_read += 1;
                    if let Some(name) = entry.file_name().to_str() {
                        match entry.file_type() {
                            Ok(kind) => { batch.insert(name.to_owned(), ScanEntry { name: name.to_owned(), kind }); }
                            Err(error) => failures.push(ScanFailure { relative_path: if self.relative_path.is_empty() { name.into() } else { format!("{}/{name}", self.relative_path) }, reason: error.to_string() }),
                        }
                    } else {
                        failures.push(ScanFailure { relative_path: self.relative_path.clone(), reason: "Filename is not UTF-8".into() });
                    }
                }
                Some(Err(error)) => {
                    *entries_read += 1;
                    failures.push(ScanFailure { relative_path: self.relative_path.clone(), reason: error.to_string() });
                }
                None => {
                    self.exhausted = true;
                    self.entries.take(); self.permit.take();
                    break;
                }
            }
        }
        self.buffered.extend(batch.into_values());
        failures
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScanCursor {
    workspace_id: String,
    project_id: Option<i64>,
    scan_id: String,
    sequence: u64,
}
struct ScanSession {
    root: PathBuf,
    workspace_id: String,
    project_id: Option<i64>,
    only_new: bool,
    start_relative: String,
    sequence: u64,
    stack: Vec<ScanFrame>,
    touched: std::time::Instant,
}
// ReadDir owns the native enumeration position across pages. Only bounded
// batches (128 owned entries per frame, depth <=256) are retained. Open handles
// are capped at 32 per scan and 128 globally. Abandoned GUI
// cursors expire; maintenance explicitly drops cursors when a scope is removed.
static SCAN_SESSIONS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::Mutex<ScanSession>>>>> =
    std::sync::LazyLock::new(Default::default);

pub(crate) fn discard_scan_cursor(cursor: &str) {
    use base64::{engine::general_purpose::STANDARD, Engine};
    if let Ok(bytes) = STANDARD.decode(cursor) {
        if let Ok(cursor) = serde_json::from_slice::<ScanCursor>(&bytes) {
            SCAN_SESSIONS.lock().unwrap().remove(&cursor.scan_id);
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanFailure {
    pub relative_path: String,
    pub reason: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanExcluded {
    pub relative_path: String,
    pub reason: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectoryScan {
    pub files: Vec<DirectoryFile>,
    pub failures: Vec<ScanFailure>,
    pub excluded: Vec<ScanExcluded>,
    pub next_cursor: Option<String>,
    pub complete: bool,
    pub cancelled: bool,
    #[cfg(test)]
    pub entries_read: usize,
    #[cfg(test)]
    pub opened_directories: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileBytesInput {
    pub object: ObjectRef,
    pub version_number: u32,
    pub expected_content_hash: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileBytesResult {
    pub object: ObjectRef,
    pub version_number: u32,
    pub content_hash: String,
    pub name: String,
    pub mime: String,
    pub byte_length: usize,
    pub base64: String,
}

fn file_id(object: &ObjectRef) -> Result<(Option<i64>, i64)> {
    let project_id = super::file_scope::owner(&object.scope);
    let id = object
        .id
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0 && id.to_string() == object.id);
    if object.kind != ObjectKind::File || project_id.is_some_and(|id| id <= 0) || id.is_none() {
        return Err(failure("invalid_argument", "Invalid File identity"));
    }
    Ok((project_id, id.unwrap()))
}
pub(crate) fn byte_limit(name: &str) -> usize {
    if Path::new(name)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
    {
        50 * 1024 * 1024
    } else {
        10 * 1024 * 1024
    }
}
pub(crate) fn excluded_component(name: &str) -> bool {
    name.starts_with('.')
}

pub(crate) fn hidden_metadata(metadata: &fs::Metadata) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        const UF_HIDDEN: u32 = 0x00008000;
        metadata.st_flags() & UF_HIDDEN != 0
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_HIDDEN;
        metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = metadata;
        false
    }
}

/// Evaluate only components inside the Project, including hidden ancestors.
/// Temporary filename patterns apply to Files, not ordinary directories.
/// Missing business Files retain missing-health handling; temporary names stay excluded.
pub(crate) fn excluded_project_path(root: &Path, path: &Path) -> Result<bool> {
    let relative = path.strip_prefix(root)?;
    if relative.components().any(|part| {
        part.as_os_str()
            .to_str()
            .is_some_and(excluded_component)
    }) {
        return Ok(true);
    }
    let mut current = root.to_path_buf();
    for part in relative.components() {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if hidden_metadata(&metadata) => return Ok(true),
            Ok(metadata) if current == path && metadata.is_dir() => return Ok(false),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(relative.file_name().and_then(|name| name.to_str()).is_some_and(
        crate::project_file_exclusions::is_temporary_file_name,
    ))
}
fn business_path(root: &Path, relative: &str) -> Result<PathBuf> {
    if relative.is_empty()
        || relative.contains(['\\', ':', '\0'])
        || relative
            .split('/')
            .any(|part| part.is_empty() || (matches!(part, "." | "..") || excluded_component(part)))
    {
        return Err(failure(
            "invalid_path",
            "Expected a visible business File path inside the Project; hidden and temporary entries are excluded",
        ));
    }
    if fs::symlink_metadata(root)?.file_type().is_symlink() {
        return Err(failure("invalid_path", "Project root cannot be a symlink"));
    }
    let path = root.join(relative);
    file_versions::relative(root, &path)?;
    if excluded_project_path(root, &path)? {
        return Err(failure("invalid_path", "Hidden and temporary entries are excluded from project Files"));
    }
    Ok(path)
}
fn physical_alias_possible(path: &Path) -> Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(fs::metadata(path)?.nlink() > 1)
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
        let file = crate::source_file_snapshot::open_regular(path).map_err(|e| anyhow!(e.message))?;
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(information.nNumberOfLinks > 1)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Ok(true)
    }
}

#[cfg(test)]
thread_local! {
    static FAIL_NEXT_DIRECTORY_MOVE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static CLAIMANT_IDENTITY_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
fn candidate_physical_identity(path: &Path) -> Result<file_versions::FileIdentity> {
    #[cfg(test)]
    CLAIMANT_IDENTITY_READS.with(|reads| reads.set(reads.get() + 1));
    file_versions::path_identity(path)
}
fn directory_move_exclusive(original: &Path, target: &Path) -> Result<()> {
    #[cfg(test)]
    if FAIL_NEXT_DIRECTORY_MOVE.with(|fail| fail.replace(false)) {
        return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "injected move denial").into());
    }
    file_versions::move_exclusive(original, target)
}

impl Database {
    pub(super) fn directory_schema(&self) -> Result<()> {
        self.conn.execute_batch("CREATE TABLE IF NOT EXISTS project_directory_files (
            document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
            physical_identity TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'ready', reason TEXT);
            CREATE TABLE IF NOT EXISTS project_directory_moves (
            document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
            original_path TEXT NOT NULL, target_path TEXT NOT NULL,
            physical_identity TEXT NOT NULL, content_hash TEXT NOT NULL, version_number INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS project_directory_metadata_intents (
            document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
            payload TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_project_directory_discovery_path
            ON documents(project_id,managed_path) WHERE storage_mode='project_directory';
            CREATE INDEX IF NOT EXISTS idx_directory_file_identity ON project_directory_files(physical_identity);
            CREATE INDEX IF NOT EXISTS idx_business_file_managed_path ON documents(managed_path COLLATE NOCASE) WHERE storage_mode!='managed_note_image';
            CREATE INDEX IF NOT EXISTS idx_business_file_unicode_path ON documents(id) WHERE storage_mode!='managed_note_image' AND managed_path GLOB '*[^ -~]*';
            CREATE INDEX IF NOT EXISTS idx_business_legacy_file_path ON documents(id) WHERE storage_mode NOT IN ('managed_note_image','project_directory');")?;
        crate::source_search_index::SourceIndex::prepare(&self.conn)
            .map_err(|e| anyhow!(e.message))?;
        Ok(())
    }
    fn directory_owner(&self, workspace: &str, project: Option<i64>) -> Result<PathBuf> {
        if self.native_workspace_id.as_deref() != Some(workspace) {
            return Err(failure(
                "ownership_mismatch",
                "Workspace is no longer current",
            ));
        }
        if self.file_scope_archived(project)? { return Err(failure("ownership_mismatch", "Project is archived")); }
        let root = self.file_scope_root(project)
            .map_err(|error| failure("ownership_mismatch", &error.to_string()))?;
        if project.is_none() {
            file_versions::create_owned_directories(&self.workspace_root, &root)?;
        }
        Ok(root)
    }
    pub(crate) fn project_file_discovery_root(
        &self,
        workspace: &str,
        project: Option<i64>,
    ) -> Result<PathBuf> {
        self.directory_owner(workspace, project)
    }
    /// The idle catalogue reads SQLite only. Filesystem ownership validation is
    /// deferred to a new/changed subscription and each actual scan page.
    pub(crate) fn project_file_discovery_catalogue(
        &self,
        workspace: &str,
    ) -> Result<Vec<(Option<i64>, PathBuf)>> {
        if self.native_workspace_id.as_deref() != Some(workspace) {
            return Err(failure("ownership_mismatch", "Workspace is no longer current"));
        }
        let mut statement = self.conn.prepare(
            "SELECT id,root_path FROM projects WHERE is_archived=0 ORDER BY id",
        )?;
        let mut roots = statement
            .query_map([], |row| Ok((Some(row.get::<_, i64>(0)?), row.get::<_, String>(1)?)))?
            .map(|row| {
                row.map(|(project, path)| (project, self.decode_path_ref(&path)))
                    .map_err(Into::into)
            })
            .collect::<Result<Vec<_>>>()?;
        roots.push((None, self.workspace_root.join("files")));
        Ok(roots)
    }
    pub(crate) fn project_file_is_directory(&self, object: &ObjectRef) -> Result<bool> {
        Ok(self.directory_target(object)?.0.storage_mode == "project_directory")
    }
    fn directory_target(
        &self,
        object: &ObjectRef,
    ) -> Result<(crate::models::DocumentRecord, PathBuf)> {
        let (project, id) = file_id(object)?;
        let root = self.directory_owner(&object.workspace_id, project)?;
        super::agent_file_undo::require_file_visible(&self.conn, id)
            .map_err(|e| failure("ownership_mismatch", &e.message))?;
        let document = self
            .document_record(id)
            .map_err(|_| failure("ownership_mismatch", "File no longer exists"))?;
        if document.project_id != project || document.storage_mode == "managed_note_image" {
            return Err(failure(
                "ownership_mismatch",
                "File belongs to another Project",
            ));
        }
        Ok((document, root))
    }
    fn directory_hash(&self, id: i64, version: i64) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT h.content_hash FROM document_versions v JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1 AND v.version_number=?2", params![id,version], |row| row.get(0)).optional()?)
    }
    /// Automatic same-path replacement is safe only after history owns an
    /// independent immutable head. Pending v0 identities remain authoritative.
    fn directory_has_frozen_head(&self, document: &crate::models::DocumentRecord) -> Result<bool> {
        if document.storage_mode != "project_directory" || document.current_version_number <= 0 {
            return Ok(false);
        }
        let head: Option<(String, String)> = self.conn.query_row(
            "SELECT v.managed_path,h.content_hash FROM document_versions v JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1 AND v.version_number=?2",
            params![document.id, document.current_version_number], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        let Some((stored, hash)) = head else { return Ok(false) };
        let snapshot = self.decode_path_ref(&stored);
        if !file_versions::valid_hash(&hash) || snapshot == Path::new(&document.managed_path) {
            return Ok(false);
        }
        file_versions::relative(&self.workspace_root, &snapshot)?;
        match fs::symlink_metadata(&snapshot) {
            Ok(metadata) => Ok(metadata.is_file() && !metadata.file_type().is_symlink()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
    fn directory_projection(&self, object: &ObjectRef) -> Result<DirectoryFile> {
        let (document, root) = self.directory_target(object)?;
        let path = Path::new(&document.managed_path);
        let relative = path
            .strip_prefix(&root)
            .map_err(|_| failure("ownership_mismatch", "File is outside its Project"))?
            .to_str()
            .ok_or_else(|| failure("invalid_path", "File path is not UTF-8"))?
            .replace('\\', "/");
        let state: Option<(String, Option<String>)> = self
            .conn
            .query_row(
                "SELECT state,reason FROM project_directory_files WHERE document_id=?1",
                [document.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (state, reason) = state.unwrap_or((
            "unavailable".into(),
            Some("File location has not been checked".into()),
        ));
        Ok(DirectoryFile {
            object: object.clone(),
            relative_path: relative,
            name: document.name,
            version_number: document.current_version_number.try_into()?,
            content_hash: self.directory_hash(document.id, document.current_version_number)?,
            state,
            reason,
        })
    }
    fn directory_change(
        &self,
        tx: &rusqlite::Transaction<'_>,
        object: &ObjectRef,
        operation: &str,
        revision: &str,
    ) -> Result<()> {
        tx.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES (?1,?2,?3,?4,?5)",params![object.key().map_err(|e| anyhow!(e.message))?, object.scope.key(),operation,revision,super::now_iso()])?;
        Ok(())
    }
    fn directory_state(
        &self,
        object: &ObjectRef,
        state: &str,
        reason: &str,
    ) -> Result<DirectoryFile> {
        let (_, id) = file_id(object)?;
        let old: Option<(String, Option<String>)> = self
            .conn
            .query_row(
                "SELECT state,reason FROM project_directory_files WHERE document_id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if old
            .as_ref()
            .is_some_and(|(old, why)| old == state && why.as_deref() == Some(reason))
        {
            return self.directory_projection(object);
        }
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            // Legacy imports have no recorded physical identity. An empty
            // identity remains untrusted until successful registration.
            "INSERT INTO project_directory_files(document_id,physical_identity,state,reason) VALUES (?3,'',?1,?2) ON CONFLICT(document_id) DO UPDATE SET state=excluded.state,reason=excluded.reason",
            params![state, reason, id],
        )?;
        tx.execute(
            "UPDATE documents SET health=?1 WHERE id=?2",
            params![
                if state == "missing" {
                    "missing"
                } else if state == "unavailable" {
                    "unavailable"
                } else {
                    "changed"
                },
                id
            ],
        )?;
        self.directory_change(&tx, object, "file.directory.state", state)?;
        tx.commit()?;
        self.directory_projection(object)
    }
    pub(crate) fn project_file_register(
        &self,
        workspace: &str,
        project: impl Into<Option<i64>>,
        relative: &str,
    ) -> Result<DirectoryFile> {
        let project = project.into();
        self.directory_schema()?;
        let root = self.directory_owner(workspace, project)?;
        let path = business_path(&root, relative)?;
        let _project_lock = self.file_project_lock(project, false)?;
        let identity_lock = self.file_storage_lock("file-import-identities", 1, true)?;
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_file() {
            return Err(failure("invalid_path", "Only ordinary business Files can be registered"));
        }
        let current_identity = file_versions::path_identity(&path)?;
        let claims = self.directory_claimants(&path, None)?;
        let mut existing = None;
        let mut relocated = None;
        for (id, owner, stored) in claims {
            if owner != project {
                return Err(failure("ownership_mismatch", "Physical File is already owned by another Project"));
            }
            let candidate = self.decode_path_ref(&stored);
            if candidate == path || file_versions::path_identity(&candidate).ok().as_ref() == Some(&current_identity) {
                existing = Some(id);
            } else {
                relocated = Some(id);
            }
        }
        if existing.is_none() {
            if let Some(id) = relocated {
                let object = ObjectRef {
                    workspace_id: workspace.into(), scope: super::file_scope::scope(project),
                    kind: ObjectKind::File, id: id.to_string(),
                };
                return self.directory_state(&object, "ambiguous", &format!("Possible external relocation to {relative}; confirm identity explicitly"));
            }
        }
        let object = existing.map(|id| ObjectRef {
            workspace_id: workspace.into(),
            scope: super::file_scope::scope(project),
            kind: ObjectKind::File,
            id: id.to_string(),
        });
        if let Some(object) = object {
            drop(identity_lock);
            if let Err(error) = self.directory_restore_recover(&object) {
                return self.directory_state(&object, "ambiguous", &error.to_string());
            }
            if let Err(error) = self.directory_recover_move(&object) {
                return self.directory_state(&object, "ambiguous", &error.to_string());
            }
            return self.directory_refresh(&object);
        }
        // Reserve the existing business identity first. Failure to capture bytes
        // leaves a visible File with no registered version, never a fake v1.
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let timestamp = super::now_iso();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| failure("invalid_path", "Filename is not UTF-8"))?;
        let encoded = self.encode_path_ref(&path);
        tx.execute("INSERT INTO documents(project_id,name,base_name,original_path,managed_path,history_dir_path,storage_mode,mime_type,current_version_number,version_count,health,created_at,updated_at) VALUES (?1,?2,?2,?3,?3,'','project_directory',?4,0,0,'unavailable',?5,?5)",params![project,name,encoded,mime_guess::from_path(&path).first_or_octet_stream().essence_str(),timestamp])?;
        let id = tx.last_insert_rowid();
        let history = self.history_dir_path_for(&path, id);
        if history.exists() {
            return Err(failure(
                "target_exists",
                "File history directory is already occupied",
            ));
        }
        tx.execute(
            "UPDATE documents SET history_dir_path=?1 WHERE id=?2",
            params![self.encode_path_ref(&history), id],
        )?;
        tx.execute("INSERT INTO project_directory_files(document_id,physical_identity,state,reason) VALUES (?1,?2,'unavailable','Initial snapshot pending')",params![id,serde_json::to_string(&current_identity)?])?;
        let object = ObjectRef {
            workspace_id: workspace.into(),
            scope: super::file_scope::scope(project),
            kind: ObjectKind::File,
            id: id.to_string(),
        };
        self.directory_change(&tx, &object, "file.directory.pending", "unavailable")?;
        tx.commit()?;
        drop(identity_lock);
        match self.directory_publish(workspace, project, &path, &object, false, None) {
            Ok(file) => Ok(file),
            Err(error) => self.directory_state(
                &object,
                "unavailable",
                &format!("Initial snapshot failed: {error:#}"),
            ),
        }
    }
    // Snapshot is durable before SQLite references it. An interrupted capture
    // can leave an unreferenced snapshot, never a committed missing version.
    fn directory_publish(
        &self,
        workspace: &str,
        project: Option<i64>,
        path: &Path,
        existing: &ObjectRef,
        replacement: bool,
        baseline: Option<(u32, &str)>,
    ) -> Result<DirectoryFile> {
        let root = self.directory_owner(workspace, project)?;
        let relative = file_versions::relative(&root, path)?.replace('\\', "/");
        business_path(&root, &relative)?;
        let _file_lock = self.file_version_lock(existing.id.parse::<i64>()?)?;
        self.directory_publish_locked(
            workspace,
            project,
            path,
            existing,
            replacement,
            baseline,
            None,
            None,
        )
    }
    fn directory_publish_locked(
        &self,
        workspace: &str,
        project: Option<i64>,
        path: &Path,
        existing: &ObjectRef,
        replacement: bool,
        baseline: Option<(u32, &str)>,
        receipt: Option<(
            &crate::agent::access::RequestContext,
            &restore::DirectoryReplaceInput,
        )>,
        gui: Option<(&str, &file_versions::GuiFileVersionIntent, bool)>,
    ) -> Result<DirectoryFile> {
        let _identity_lock = self.file_storage_lock("file-import-identities", 1, true)?;
        let root = self.directory_owner(workspace, project)?;
        let relative = file_versions::relative(&root, path)?.replace('\\', "/");
        business_path(&root, &relative)?;
        if let Some((version, hash)) = baseline {
            self.directory_baseline(existing, version, hash)?;
        }
        let restore_source = receipt
            .and_then(|(request, input)| input.restore().map(|input|(request,input)))
            .map(|(request, input)| {
                self.file_version_restore_source(request, &request.binding, input)
                    .map_err(|e| anyhow!(e.message))
            })
            .transpose()?;
        let (document, _) = self.directory_target(existing)?;
        if fs::metadata(path)?.len() > crate::file_text_patch::MAX_FILE_BYTES as u64 {
            return self.directory_state(
                existing,
                "unavailable",
                "File exceeds the existing 100 MiB snapshot budget; version is not registered",
            );
        }
        if !replacement && !self.directory_has_frozen_head(&document)? {
            let known: Option<String> = self.conn.query_row(
                "SELECT physical_identity FROM project_directory_files WHERE document_id=?1", [document.id], |r| r.get(0),
            ).optional()?;
            let physical = serde_json::to_string(&file_versions::path_identity(path)?)?;
            if known.as_deref().filter(|value| !value.is_empty()).is_some_and(|value| value != physical) {
                return self.directory_state(existing, "ambiguous", "Physical identity changed; confirm replacement or relocation");
            }
        }
        let snapshots = PathBuf::from(&document.history_dir_path);
        file_versions::create_owned_directories(&self.workspace_root, &snapshots)?;
        let snapshot = snapshots.join(file_versions::token());
        let (hash, physical, _) = file_versions::snapshot_bounded(
            path,
            &snapshot,
            Some(crate::file_text_patch::MAX_FILE_BYTES as u64),
        )?;
        file_versions::sync_directory(&snapshots)?;
        business_path(&root, &relative)?;
        let previous_hash = self.directory_hash(document.id, document.current_version_number)?;
        if let Some((_, intent, _)) = gui {
            if hash != intent.expected_content_hash {
                return Err(failure("source_changed", "File changed after GUI preflight"));
            }
        }
        // An imported head still points at live bytes. Do not register a new
        // version while silently treating changed bytes as its frozen history.
        if !replacement
            && document.storage_mode != "project_directory"
            && previous_hash.as_ref() != Some(&hash)
        {
            return self.directory_state(
                existing,
                "ambiguous",
                "Imported File changed before its first snapshot; confirm replacement",
            );
        }
        if !replacement {
            let known: Option<String> = self
                .conn
                .query_row(
                    "SELECT physical_identity FROM project_directory_files WHERE document_id=?1",
                    [document.id],
                    |r| r.get(0),
                )
                .optional()?;
            let captured_identity = serde_json::to_string(&physical)?;
            // Legacy imports may bootstrap a missing identity only after the
            // captured bytes matched their registered hash above.
            if (document.storage_mode == "project_directory"
                && known.as_deref().is_none_or(str::is_empty))
                || (!self.directory_has_frozen_head(&document)?
                    && known.as_deref().filter(|value| !value.is_empty())
                        .is_some_and(|value| value != captured_identity))
            {
                return self.directory_state(
                    existing,
                    "ambiguous",
                    "Physical identity changed; confirm replacement or relocation",
                );
            }
        }
        let new_version = if previous_hash.as_ref() == Some(&hash) {
            document.current_version_number
        } else {
            document
                .current_version_number
                .checked_add(1)
                .filter(|v| *v <= u32::MAX as i64)
                .ok_or_else(|| failure("budget_exceeded", "File version number exhausted"))?
        };
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| failure("invalid_path", "Filename is not UTF-8"))?;
        let encoded_path = self.encode_path_ref(path);
        let encoded_snapshot = self.encode_path_ref(&snapshot);
        let timestamp = super::now_iso();
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        self.directory_unclaimed(path, existing)?;
        if let Some((_, intent, _)) = gui {
            let (current, _) = self.directory_target(existing)?;
            if current.managed_path != intent.managed_path
                || current.current_version_number != i64::from(intent.expected_version_number)
                || self.directory_hash(current.id, current.current_version_number)? != intent.registered_content_hash
            {
                return Err(failure("revision_conflict", "File registration changed during GUI snapshot"));
            }
        }
        if let Some(source) = &restore_source {
            crate::file_version_restore::check_source_transaction(&tx, source, document.id)
                .map_err(|e| anyhow!(e.message))?;
            if source.content_hash != hash {
                return Err(failure(
                    "source_changed",
                    "Restored bytes differ from the fixed historical source",
                ));
            }
        }
        if let Some((_, input))=receipt {
            if let Some(staged)=input.staged() {
                crate::db::file_content::check_transaction(&tx,&crate::file_content::FileContentBeginInput::Existing(crate::file_content::FileContentBegin {object:staged.object.clone(),expected_version_number:staged.expected_version_number,expected_content_hash:staged.expected_content_hash.clone(),length:0,content_hash:hash.clone()})).map_err(|e|anyhow!(e.message))?;
            }
        }
        let changed = tx.execute("UPDATE documents SET name=?1,base_name=?1,managed_path=?2,storage_mode='project_directory',current_version_number=?3,version_count=version_count+?4,health='normal',updated_at=?5 WHERE id=?6 AND current_version_number=?7",params![name,encoded_path,new_version, i64::from(new_version!=document.current_version_number),timestamp,document.id,document.current_version_number])?;
        if changed != 1 {
            return Err(failure(
                "revision_conflict",
                "File head changed during registration",
            ));
        }
        let id = document.id;
        let object = ObjectRef {
            workspace_id: workspace.into(),
            scope: super::file_scope::scope(project),
            kind: ObjectKind::File,
            id: id.to_string(),
        };
        if document.current_version_number == new_version
            && document.storage_mode != "project_directory"
        {
            // Known imported head: retain its ID/hash while freezing its bytes.
            tx.execute("UPDATE document_versions SET managed_path=?1 WHERE document_id=?2 AND version_number=?3",params![encoded_snapshot,id,new_version])?;
        } else if document.current_version_number != new_version {
            tx.execute("INSERT INTO document_versions(document_id,version_number,name,source_path,managed_path,created_at) VALUES (?1,?2,?3,?4,?5,?6)",params![id,new_version,name,encoded_path,encoded_snapshot,timestamp])?;
            let version_id = tx.last_insert_rowid();
            tx.execute("INSERT INTO source_file_version_hashes(document_version_id,content_hash) VALUES (?1,?2)",params![version_id,hash])?;
        }
        tx.execute("INSERT INTO project_directory_files(document_id,physical_identity,state,reason) VALUES (?1,?2,'ready',NULL) ON CONFLICT(document_id) DO UPDATE SET physical_identity=excluded.physical_identity,state='ready',reason=NULL",params![id,serde_json::to_string(&physical)?])?;
        if file_versions::path_identity(path)? != physical || file_versions::checksum(path)? != hash
        {
            return Err(failure(
                "source_changed",
                "File changed during registration",
            ));
        }
        business_path(&root, &relative)?;
        if replacement {
            tx.execute(
                "DELETE FROM project_directory_moves WHERE document_id=?1",
                [id],
            )?;
            tx.execute(
                "DELETE FROM project_directory_metadata_intents WHERE document_id=?1",
                [id],
            )?;
        }
        self.directory_change(&tx, &object, "file.directory.register", &hash)?;
        if let Some((request, input)) = receipt {
            let payload = input.payload(&hash);
            let committed = file_versions::CommittedVersion {
                document_id: id,
                version_number: new_version,
                content_hash: hash.clone(),
                no_change: new_version == document.current_version_number,
            };
            self.agent_atomic_operation_in_transaction(
                &tx,
                &request.caller.key(),
                &request.request_id,
                "file.version.commit",
                &payload,
                |_| Ok((committed, None)),
            )
            .map_err(|error| anyhow!(error.message))?;
        }
        if let Some((request_id, intent, register_current_bytes)) = gui {
            let payload = file_versions::CommitPayload::NativeCas { intent: intent.clone(), register_current_bytes };
            let committed = file_versions::CommittedVersion { document_id: id, version_number: new_version,
                content_hash: hash.clone(), no_change: new_version == document.current_version_number };
            self.agent_atomic_operation_in_transaction(&tx, "gui", request_id, "file.version.commit", &payload,
                |_| Ok((committed, None))).map_err(|error| anyhow!(error.message))?;
        }
        tx.commit()?;
        self.directory_projection(&object)
    }
    /// Called by the GUI version kernel while its Project/File leases and
    /// workspace fence are held. Only the immutable snapshot is written.
    pub(super) fn project_file_register_gui_locked(
        &self,
        workspace: &str,
        intent: &file_versions::GuiFileVersionIntent,
        request_id: &str,
        register_current_bytes: bool,
    ) -> crate::agent::errors::AgentResult<file_versions::FileVersionCommitOutcome> {
        use crate::agent::errors::{AgentError, ErrorCode};
        let object = ObjectRef { workspace_id: workspace.into(), scope: super::file_scope::scope(intent.project_id),
            kind: ObjectKind::File, id: intent.document_id.to_string() };
        let file = self.directory_publish_locked(workspace, intent.project_id, Path::new(&intent.managed_path),
            &object, true, None, None, Some((request_id, intent, register_current_bytes)))
            .map_err(|error| {
                let error = FileServiceError::from_error(error);
                let code = match error.code {
                    "revision_conflict" => ErrorCode::RevisionConflict,
                    "source_changed" => ErrorCode::FileChangedUnregistered,
                    "ownership_mismatch" => ErrorCode::ScopeDenied,
                    _ => ErrorCode::IoFailed,
                };
                AgentError::new(code, error.message)
            })?;
        if file.state != "ready" {
            return Err(AgentError::new(ErrorCode::SourceNotReady, "Current File bytes could not form a registered version"));
        }
        Ok(file_versions::FileVersionCommitOutcome { committed: true,
            receipt: file_versions::CommittedVersion { document_id: intent.document_id, version_number: i64::from(file.version_number),
                content_hash: file.content_hash.expect("ready directory File has a registered hash"),
                no_change: file.version_number == intent.expected_version_number } })
    }
    fn directory_refresh(&self, object: &ObjectRef) -> Result<DirectoryFile> {
        let (project, id) = file_id(object)?;
        let _project_lock = self.file_project_lock(project, false)?;
        let _file_lock = self.file_version_lock(id)?;
        let (document, root) = self.directory_target(object)?;
        let path = PathBuf::from(&document.managed_path);
        let relative = path
            .strip_prefix(&root)?
            .to_str()
            .ok_or_else(|| failure("invalid_path", "Path is not UTF-8"))?
            .replace('\\', "/");
        if let Err(error) = fs::symlink_metadata(&path) {
            return self.directory_state(
                object,
                if error.kind() == std::io::ErrorKind::NotFound {
                    "missing"
                } else {
                    "unavailable"
                },
                &error.to_string(),
            );
        }
        if let Err(error) = business_path(&root, &relative) {
            return self.directory_state(object, "unavailable", &error.to_string());
        }
        let identity = serde_json::to_string(&file_versions::path_identity(&path)?)?;
        let known: Option<String> = self
            .conn
            .query_row(
                "SELECT physical_identity FROM project_directory_files WHERE document_id=?1",
                [document.id],
                |r| r.get(0),
            )
            .optional()?;
        if fs::metadata(&path)?.len() > crate::file_text_patch::MAX_FILE_BYTES as u64 {
            return self.directory_state(
                object,
                "unavailable",
                "File exceeds the existing 100 MiB snapshot budget; version is not registered",
            );
        }
        if document.storage_mode != "project_directory"
            && known.as_deref().is_none_or(str::is_empty)
        {
            let pending: bool = self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM project_directory_moves WHERE document_id=?1 UNION ALL SELECT 1 FROM project_directory_metadata_intents WHERE document_id=?1)",
                [id], |row| row.get(0),
            )?;
            if pending {
                return self.directory_state(
                    object, "ambiguous",
                    "Pending File move must be resolved before initial registration",
                );
            }
            let previous_hash = self.directory_hash(id, document.current_version_number)?;
            // Bootstrap only the existing legacy path. A known hash retains its
            // version; unknown historical bytes stay unknown and get a new head.
            return self.directory_publish_locked(
                &object.workspace_id, project, &path, object, previous_hash.is_none(),
                Some((document.current_version_number.try_into()?, previous_hash.as_deref().unwrap_or(""))),
                None, None,
            );
        }
        if known.as_deref().is_none_or(str::is_empty)
            || (!self.directory_has_frozen_head(&document)? && known.as_deref() != Some(&identity))
        {
            return self.directory_state(
                object, "ambiguous", "Physical identity changed; confirm replacement or relocation",
            );
        }
        let hash = file_versions::checksum(&path)?;
        if document.storage_mode != "project_directory" {
            return self.directory_publish_locked(
                &object.workspace_id,
                document.project_id,
                &path,
                object,
                false,
                None,
                None,
                None,
            );
        }
        if self
            .directory_hash(document.id, document.current_version_number)?
            .as_ref()
            == Some(&hash)
        {
            let old: (String, Option<String>) = self.conn.query_row(
                "SELECT state,reason FROM project_directory_files WHERE document_id=?1",
                [document.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            if known.as_deref() == Some(&identity)
                && old.0 == "ready"
                && old.1.is_none()
                && document.health == "normal"
            {
                if serde_json::to_string(&file_versions::path_identity(&path)?)? != identity {
                    return Err(failure(
                        "source_changed",
                        "File changed during registration",
                    ));
                }
                return self.directory_projection(object);
            }
            let _identity_lock = self.file_storage_lock("file-import-identities", 1, true)?;
            let tx = rusqlite::Transaction::new_unchecked(
                &self.conn,
                rusqlite::TransactionBehavior::Immediate,
            )?;
            self.directory_unclaimed(&path, object)?;
            tx.execute("UPDATE project_directory_files SET physical_identity=?2,state='ready',reason=NULL WHERE document_id=?1",params![document.id,identity])?;
            tx.execute(
                "UPDATE documents SET health='normal' WHERE id=?1",
                [document.id],
            )?;
            self.directory_change(&tx, object, "file.directory.state", "ready")?;
            if serde_json::to_string(&file_versions::path_identity(&path)?)? != identity
                || file_versions::checksum(&path)? != hash
            {
                return Err(failure(
                    "source_changed",
                    "File changed during registration",
                ));
            }
            business_path(&root, &relative)?;
            tx.commit()?;
            return self.directory_projection(object);
        }
        self.directory_publish_locked(
            &object.workspace_id,
            document.project_id,
            &path,
            object,
            false,
            None,
            None,
            None,
        )
    }
    pub(crate) fn project_file_resolve(&self, object: &ObjectRef) -> Result<DirectoryFile> {
        self.directory_schema()?;
        self.directory_target(object)?;
        if let Err(error) = self.directory_restore_recover(object) {
            return self.directory_state(object, "ambiguous", &error.to_string());
        }
        if let Err(error) = self.directory_recover_move(object) {
            return self.directory_state(object, "ambiguous", &error.to_string());
        }
        self.directory_refresh(object)
    }

    pub(crate) fn project_file_open_local_with(
        &self,
        object: &ObjectRef,
        open: impl FnOnce(&Path) -> Result<()>,
    ) -> Result<()> {
        let current = self.project_file_resolve(object)?;
        if current.state != "ready" {
            return Err(failure(
                "source_not_ready",
                "Current File must be ready before opening locally",
            ));
        }
        let (project, id) = file_id(object)?;
        let _project = self.file_project_lock(project, false)?;
        let _file = self.file_version_lock(id)?;
        let (document, root) = self.directory_target(object)?;
        self.directory_baseline(
            object,
            current.version_number,
            current.content_hash.as_deref().unwrap(),
        )?;
        let path = business_path(&root, &current.relative_path)?;
        if path != Path::new(&document.managed_path) {
            return Err(failure(
                "revision_conflict",
                "Current File location changed before local opening",
            ));
        }
        let known: String = self.conn.query_row(
            "SELECT physical_identity FROM project_directory_files WHERE document_id=?1",
            [id],
            |row| row.get(0),
        )?;
        if serde_json::to_string(&file_versions::path_identity(&path)?)? != known
            || file_versions::checksum(&path)? != current.content_hash.unwrap()
        {
            return Err(failure(
                "source_changed",
                "Current File changed before local opening",
            ));
        }
        open(&path)
    }

    fn directory_baseline(
        &self,
        object: &ObjectRef,
        version: u32,
        hash: &str,
    ) -> Result<crate::models::DocumentRecord> {
        let (document, _) = self.directory_target(object)?;
        if document.current_version_number != i64::from(version)
            || self
                .directory_hash(document.id, document.current_version_number)?
                .as_deref()
                .unwrap_or("")
                != hash
        {
            return Err(failure(
                "revision_conflict",
                "File version/hash changed before the operation",
            ));
        }
        Ok(document)
    }
    /// An ordinary single-link file cannot alias another live path. Query
    /// retained identities and ASCII paths by index. Actual hard links, Unicode
    /// aliases and unregistered legacy imports retain live-path verification.
    fn directory_claimants(&self, path: &Path, excluding: Option<i64>) -> Result<Vec<(i64, Option<i64>, String)>> {
        let target_identity = match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_file() => Some(serde_json::to_string(&file_versions::path_identity(path)?)?),
            Ok(_) => None,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let mut claims: std::collections::BTreeMap<i64, (Option<i64>, String)> = std::collections::BTreeMap::new();
        let encoded = self.encode_path_ref(path);
        let plain = path.to_string_lossy();
        let absolute = format!("{}{}", super::ABSOLUTE_PATH_PREFIX, plain);
        let mut statement = self.conn.prepare(
            "SELECT id,project_id,managed_path FROM documents WHERE storage_mode!='managed_note_image' AND managed_path COLLATE NOCASE IN (?1,?2,?3)")?;
        for row in statement.query_map(params![encoded, plain, absolute], |r| Ok((r.get::<_, i64>(0)?,r.get::<_, Option<i64>>(1)?,r.get::<_, String>(2)?)))? {
            let (id, owner, stored) = row?;
            if Some(id) == excluding { continue; }
            let candidate = self.decode_path_ref(&stored);
            // NOCASE locates ASCII aliases on Windows/macOS. On a sensitive
            // filesystem equally spelled variants may still be distinct Files.
            if candidate == path || target_identity.as_ref().is_some_and(|identity|
                candidate_physical_identity(&candidate).ok().and_then(|value| serde_json::to_string(&value).ok()).as_ref() == Some(identity))
            {
                claims.insert(id, (owner, stored));
            }
        }
        if let Some(identity) = &target_identity {
            let mut statement = self.conn.prepare(
                "SELECT d.id,d.project_id,d.managed_path FROM project_directory_files f JOIN documents d ON d.id=f.document_id WHERE f.physical_identity=?1 AND d.storage_mode!='managed_note_image'")?;
            for row in statement.query_map([identity], |r| Ok((r.get::<_, i64>(0)?,r.get::<_, Option<i64>>(1)?,r.get::<_, String>(2)?)))? {
                let (id, owner, stored) = row?;
                if Some(id) != excluding { claims.insert(id, (owner, stored)); }
            }
            let candidates = if physical_alias_possible(path)? {
                "SELECT id,project_id,managed_path FROM documents WHERE storage_mode!='managed_note_image'"
            } else {
                // Unicode spelling/normalization aliases and legacy imports
                // without a recorded identity cannot use the ASCII path index.
                // Check that subset; ordinary registered Files stay indexed.
                "SELECT id,project_id,managed_path FROM documents WHERE storage_mode!='managed_note_image' AND managed_path GLOB '*[^ -~]*'
                 UNION SELECT d.id,d.project_id,d.managed_path FROM documents d LEFT JOIN project_directory_files f ON f.document_id=d.id WHERE d.storage_mode NOT IN ('managed_note_image','project_directory') AND (f.document_id IS NULL OR f.physical_identity='')"
            };
            let mut statement = self.conn.prepare(candidates)?;
            for row in statement.query_map([], |r| Ok((r.get::<_, i64>(0)?,r.get::<_, Option<i64>>(1)?,r.get::<_, String>(2)?)))? {
                let (id, owner, stored) = row?;
                if Some(id) == excluding || claims.contains_key(&id) { continue; }
                let candidate = self.decode_path_ref(&stored);
                if candidate_physical_identity(&candidate).ok()
                    .and_then(|value| serde_json::to_string(&value).ok()).as_ref() == Some(identity)
                {
                    claims.insert(id, (owner, stored));
                }
            }
        }
        Ok(claims.into_iter().map(|(id,(owner,path))| (id,owner,path)).collect())
    }
    fn directory_unclaimed(&self, path: &Path, object: &ObjectRef) -> Result<()> {
        let (_, id) = file_id(object)?;
        if !self.directory_claimants(path, Some(id))?.is_empty() {
            return Err(failure("ownership_mismatch", "Selected physical target is registered to another File"));
        }
        Ok(())
    }
    pub(crate) fn project_file_reconcile(
        &self,
        object: &ObjectRef,
        relative: &str,
        version: u32,
        hash: Option<&str>,
        confirmation: &str,
    ) -> Result<DirectoryFile> {
        self.directory_schema()?;
        let (project, id) = file_id(object)?;
        let _project_lock = self.file_project_lock(project, false)?;
        let _file_lock = self.file_version_lock(id)?;
        self.directory_restore_recover_locked(object)?;
        let document = self.directory_baseline(object, version, hash.unwrap_or(""))?;
        let root = self.directory_owner(&object.workspace_id, project)?;
        let path = business_path(&root, relative)?;
        if confirmation == "registration" {
            let known: Option<String> = self
                .conn
                .query_row(
                    "SELECT physical_identity FROM project_directory_files WHERE document_id=?1",
                    [id],
                    |row| row.get(0),
                )
                .optional()?;
            // Missing historical registration cannot establish old bytes. Only
            // explicit confirmation of this legacy File's current location may
            // freeze the live content as a new version; never backfill history.
            if hash.is_some()
                || document.storage_mode == "project_directory"
                || !known.as_deref().is_none_or(str::is_empty)
                || path != Path::new(&document.managed_path)
            {
                return Err(failure(
                    "invalid_argument",
                    "Initial registration requires an unregistered legacy File at its current location",
                ));
            }
            let pending: bool = self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM project_directory_moves WHERE document_id=?1 UNION ALL SELECT 1 FROM project_directory_metadata_intents WHERE document_id=?1)",
                [id], |row| row.get(0),
            )?;
            if pending {
                return Err(failure(
                    "ambiguous_identity",
                    "Pending File move must be resolved before initial registration",
                ));
            }
        } else if matches!(confirmation, "location" | "replacement") {
            let pending_directory_replacement = confirmation == "replacement"
                && document.storage_mode == "project_directory"
                && version == 0 && hash.is_none();
            if hash.is_none_or(str::is_empty) && !pending_directory_replacement {
                return Err(failure(
                    "invalid_argument",
                    "An unregistered File requires explicit initial registration or replacement confirmation",
                ));
            }
        } else {
            return Err(failure(
                "invalid_argument",
                "Explicit location, replacement or registration confirmation is required",
            ));
        }
        self.directory_unclaimed(&path, object)?;
        if confirmation == "location" && Some(file_versions::checksum(&path)?.as_str()) != hash {
            return Err(failure(
                "hash_mismatch",
                "Relocation cannot replace registered content; explicitly confirm replacement",
            ));
        }
        self.directory_publish_locked(
            &object.workspace_id,
            project,
            &path,
            object,
            true,
            Some((version, hash.unwrap_or(""))),
            None,
            None,
        )
    }

    fn directory_finish_move(
        &self,
        object: &ObjectRef,
        original: &Path,
        target: &Path,
        physical: &str,
        version: u32,
        hash: &str,
    ) -> Result<()> {
        let (document, root) = self.directory_target(object)?;
        self.directory_baseline(object, version, hash)?;
        if Path::new(&document.managed_path) != original {
            return Err(failure(
                "revision_conflict",
                "File location changed while moving",
            ));
        }
        let relative = file_versions::relative(&root, target)?.replace('\\', "/");
        business_path(&root, &relative)?;
        if serde_json::to_string(&file_versions::path_identity(target)?)? != physical
            || file_versions::checksum(target)? != hash
        {
            return Err(failure(
                "ambiguous_identity",
                "Moved target no longer matches the recorded File",
            ));
        }
        let name = target
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or_else(|| failure("invalid_path", "Filename is not UTF-8"))?;
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        self.directory_unclaimed(target, object)?;
        let changed=tx.execute("UPDATE documents SET managed_path=?1,name=?2,base_name=?2,mime_type=?3,health='normal',updated_at=?4 WHERE id=?5 AND current_version_number=?6 AND managed_path=?7",params![self.encode_path_ref(target),name,mime_guess::from_path(target).first_or_octet_stream().essence_str(),super::now_iso(),document.id,version,self.encode_path_ref(original)])?;
        if changed != 1 {
            return Err(failure("revision_conflict", "File changed while moving"));
        }
        tx.execute(
            "UPDATE project_directory_files SET state='ready',reason=NULL WHERE document_id=?1",
            [document.id],
        )?;
        let pending: Option<String> = tx
            .query_row(
                "SELECT payload FROM project_directory_metadata_intents WHERE document_id=?1",
                [document.id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(pending) = pending {
            self.directory_apply_metadata(&tx, object, &serde_json::from_str(&pending)?)?;
        }
        tx.execute(
            "DELETE FROM project_directory_metadata_intents WHERE document_id=?1",
            [document.id],
        )?;
        tx.execute(
            "DELETE FROM project_directory_moves WHERE document_id=?1",
            [document.id],
        )?;
        self.directory_change(&tx, object, "file.directory.move", hash)?;
        tx.commit()?;
        Ok(())
    }
    fn directory_recover_move(&self, object: &ObjectRef) -> Result<()> {
        let (project, id) = file_id(object)?;
        let _project_lock = self.file_project_lock(project, false)?;
        let _file_lock = self.file_version_lock(id)?;
        let pending: Option<(String,String,String,String,u32)>=self.conn.query_row("SELECT original_path,target_path,physical_identity,content_hash,version_number FROM project_directory_moves WHERE document_id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
        let Some((old, next, physical, hash, version)) = pending else {
            return Ok(());
        };
        let (_, root) = self.directory_target(object)?;
        let old = self.decode_path_ref(&old);
        let next = self.decode_path_ref(&next);
        for path in [&old, &next] {
            let relative = file_versions::relative(&root, path)?.replace('\\', "/");
            business_path(&root, &relative)?;
        }
        self.directory_baseline(object, version, &hash)?;
        let old_exists = fs::symlink_metadata(&old).is_ok();
        let next_exists = fs::symlink_metadata(&next).is_ok();
        if old_exists && !next_exists {
            if serde_json::to_string(&file_versions::path_identity(&old)?)? != physical
                || file_versions::checksum(&old)? != hash
            {
                return Err(failure(
                    "ambiguous_identity",
                    "Interrupted move source changed; confirmation required",
                ));
            }
            file_versions::move_exclusive(&old, &next)?;
            file_versions::sync_directory(old.parent().unwrap())?;
            file_versions::sync_directory(next.parent().unwrap())?;
        } else if old_exists || !next_exists {
            return Err(failure(
                "ambiguous_identity",
                "Interrupted move locations cannot be identified safely",
            ));
        }
        self.directory_finish_move(object, &old, &next, &physical, version, &hash)
    }
    pub(crate) fn project_file_move(
        &self,
        object: &ObjectRef,
        relative: &str,
        version: u32,
        hash: &str,
    ) -> Result<DirectoryFile> {
        self.directory_move(object, relative, version, hash, None)
    }
    fn directory_move(
        &self,
        object: &ObjectRef,
        relative: &str,
        version: u32,
        hash: &str,
        metadata: Option<&crate::models::DocumentUpdateMetaInput>,
    ) -> Result<DirectoryFile> {
        self.directory_schema()?;
        self.directory_restore_recover(object)?;
        self.directory_recover_move(object)?;
        let (project, id) = file_id(object)?;
        let _project_lock = self.file_project_lock(project, false)?;
        let _file_lock = self.file_version_lock(id)?;
        let document = self.directory_baseline(object, version, hash)?;
        let root = self.directory_owner(&object.workspace_id, project)?;
        let original = PathBuf::from(&document.managed_path);
        let target = business_path(&root, relative)?;
        self.directory_unclaimed(&target, object)?;
        if original == target {
            return self.directory_projection(object);
        }
        if fs::symlink_metadata(&target).is_ok() {
            return Err(failure(
                "target_exists",
                "Move cannot overwrite another file",
            ));
        }
        if !target.parent().is_some_and(|p| p.is_dir()) {
            return Err(failure("invalid_path", "Move target directory must exist"));
        }
        let known: String = self.conn.query_row(
            "SELECT physical_identity FROM project_directory_files WHERE document_id=?1",
            [id],
            |r| r.get(0),
        )?;
        let original_relative = file_versions::relative(&root, &original)?.replace('\\', "/");
        business_path(&root, &original_relative)?;
        if serde_json::to_string(&file_versions::path_identity(&original)?)? != known
            || file_versions::checksum(&original)? != hash
        {
            return Err(failure(
                "ambiguous_identity",
                "Register or confirm current File before moving",
            ));
        }
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        self.directory_baseline(object, version, hash)?;
        tx.execute("INSERT INTO project_directory_moves(document_id,original_path,target_path,physical_identity,content_hash,version_number) VALUES (?1,?2,?3,?4,?5,?6)",params![id,self.encode_path_ref(&original),self.encode_path_ref(&target),known,hash,version])?;
        if let Some(input) = metadata {
            let metadata = DirectoryMetadata {
                starred: input.is_starred.unwrap_or(document.is_starred),
                tags: input
                    .tag_ids
                    .as_deref()
                    .map(super::normalize_file_tag_ids)
                    .unwrap_or_else(|| document.tags.iter().map(|tag| tag.id).collect()),
            };
            for tag in &metadata.tags {
                self.scoped_file_tag_record(project, *tag)?;
            }
            tx.execute("INSERT INTO project_directory_metadata_intents(document_id,payload) VALUES (?1,?2)",params![id,serde_json::to_string(&metadata)?])?;
        }
        tx.commit()?;
        if let Err(error) = directory_move_exclusive(&original, &target) {
            // A denied Windows delete-share (or directory permission) can
            // reject the move after its intent was persisted. Cancel only
            // when both paths prove the move never took place. Otherwise the
            // move or its durability flush may have succeeded: keep recovery.
            if fs::symlink_metadata(&target)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                && file_versions::path_identity(&original)
                    .and_then(|identity| Ok(serde_json::to_string(&identity)?))
                    .ok()
                    .as_deref()
                    == Some(known.as_str())
                && file_versions::checksum(&original).ok().as_deref() == Some(hash)
            {
                let tx = rusqlite::Transaction::new_unchecked(
                    &self.conn,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                tx.execute(
                    "DELETE FROM project_directory_metadata_intents WHERE document_id=?1",
                    [id],
                )?;
                tx.execute(
                    "DELETE FROM project_directory_moves WHERE document_id=?1",
                    [id],
                )?;
                tx.commit()?;
            }
            return Err(error);
        }
        file_versions::sync_directory(original.parent().unwrap())?;
        file_versions::sync_directory(target.parent().unwrap())?;
        self.directory_finish_move(object, &original, &target, &known, version, hash)?;
        self.directory_projection(object)
    }
    pub(crate) fn project_file_rename(
        &self,
        object: &ObjectRef,
        name: &str,
        version: u32,
        hash: &str,
    ) -> Result<DirectoryFile> {
        if name.is_empty() || name.contains('/') {
            return Err(failure("invalid_path", "Rename requires one filename"));
        }
        self.directory_schema()?;
        self.directory_recover_move(object)?;
        let (_, root) = self.directory_target(object)?;
        let document = self.directory_baseline(object, version, hash)?;
        let target = Path::new(&document.managed_path)
            .parent()
            .unwrap()
            .join(name);
        let relative = target
            .strip_prefix(&root)?
            .to_str()
            .ok_or_else(|| failure("invalid_path", "Filename is not UTF-8"))?
            .replace('\\', "/");
        self.project_file_move(object, &relative, version, hash)
    }

    fn directory_apply_metadata(
        &self,
        tx: &rusqlite::Transaction<'_>,
        object: &ObjectRef,
        metadata: &DirectoryMetadata,
    ) -> Result<()> {
        let (project, id) = file_id(object)?;
        for tag in &metadata.tags {
            self.scoped_file_tag_record(project, *tag)?;
        }
        tx.execute(
            "UPDATE documents SET is_starred=?1,updated_at=?2 WHERE id=?3",
            params![metadata.starred, super::now_iso(), id],
        )?;
        tx.execute("DELETE FROM document_tag_links WHERE document_id=?1", [id])?;
        for tag in &metadata.tags {
            tx.execute(
                "INSERT INTO document_tag_links(document_id,tag_id,created_at) VALUES (?1,?2,?3)",
                params![id, tag, super::now_iso()],
            )?;
        }
        Ok(())
    }
    pub(crate) fn project_file_update_meta(
        &self,
        input: &crate::models::DocumentUpdateMetaInput,
    ) -> Result<crate::models::DocumentRecord> {
        self.directory_schema()?;
        let document = self.document_record(input.document_id)?;
        let workspace = self
            .native_workspace_id
            .as_deref()
            .ok_or_else(|| failure("ownership_mismatch", "Workspace is not bound"))?;
        let object = ObjectRef {
            workspace_id: workspace.into(),
            scope: super::file_scope::scope(document.project_id),
            kind: ObjectKind::File,
            id: document.id.to_string(),
        };
        self.directory_target(&object)?;
        self.directory_restore_recover(&object)?;
        self.directory_recover_move(&object)?;
        let document = self.document_record(input.document_id)?;
        let metadata = DirectoryMetadata {
            starred: input.is_starred.unwrap_or(document.is_starred),
            tags: input
                .tag_ids
                .as_deref()
                .map(super::normalize_file_tag_ids)
                .unwrap_or_else(|| document.tags.iter().map(|tag| tag.id).collect()),
        };
        for tag in &metadata.tags {
            self.scoped_file_tag_record(document.project_id, *tag)?;
        }
        let name = input
            .base_name
            .as_deref()
            .map(|name| self.normalize_document_base_name(name, &document.base_name))
            .transpose()?
            .unwrap_or(document.name.clone());
        if name != document.name {
            let target = Path::new(&document.managed_path)
                .parent()
                .unwrap()
                .join(&name);
            let root = self.directory_owner(workspace, document.project_id)?;
            let relative = target
                .strip_prefix(root)?
                .to_str()
                .ok_or_else(|| failure("invalid_path", "Filename is not UTF-8"))?
                .replace('\\', "/");
            let hash = self
                .directory_hash(document.id, document.current_version_number)?
                .ok_or_else(|| {
                    failure(
                        "version_unregistered",
                        "File requires a registered version before rename",
                    )
                })?;
            self.directory_move(
                &object,
                &relative,
                document.current_version_number.try_into()?,
                &hash,
                Some(input),
            )?;
        } else {
            let _locks = self.file_native_write_locks(document.id)?;
            let current = self.document_record(document.id)?;
            let metadata = DirectoryMetadata {
                starred: input.is_starred.unwrap_or(current.is_starred),
                tags: input
                    .tag_ids
                    .as_deref()
                    .map(super::normalize_file_tag_ids)
                    .unwrap_or_else(|| current.tags.iter().map(|tag| tag.id).collect()),
            };
            let tx = rusqlite::Transaction::new_unchecked(
                &self.conn,
                rusqlite::TransactionBehavior::Immediate,
            )?;
            self.directory_apply_metadata(&tx, &object, &metadata)?;
            self.directory_change(
                &tx,
                &object,
                "file.directory.metadata",
                &format!("metadata:{}", super::now_iso()),
            )?;
            tx.commit()?;
        }
        self.document_record(document.id)
    }
    /// Discovery only: already registered paths retain their identity and head.
    /// Explicit reads/resolves remain responsible for external content changes.
    pub(crate) fn project_file_scan_new(
        &self,
        workspace: &str,
        project: impl Into<Option<i64>>,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<DirectoryScan> {
        let project = project.into();
        self.project_file_scan_page(workspace, project, cursor, limit, false, true, "")
    }
    pub(crate) fn project_file_scan(
        &self,
        workspace: &str,
        project: impl Into<Option<i64>>,
        cursor: Option<&str>,
        limit: u32,
        cancelled: bool,
    ) -> Result<DirectoryScan> {
        let project = project.into();
        self.project_file_scan_page(workspace, project, cursor, limit, cancelled, false, "")
    }
    /// Native event paths are revalidated at the business boundary. A File
    /// event does no directory enumeration; directory copies scan that subtree.
    pub(crate) fn project_file_scan_new_at(
        &self, workspace: &str, project: Option<i64>, relative: &str,
        cursor: Option<&str>, limit: u32,
    ) -> Result<DirectoryScan> {
        self.directory_schema()?;
        let root = self.directory_owner(workspace, project)?;
        if cursor.is_some() {
            return self.project_file_scan_page(workspace, project, cursor, limit, false, true, relative);
        }
        let mut result = DirectoryScan {
            files: vec![], failures: vec![], excluded: vec![], next_cursor: None,
            complete: true, cancelled: false,
            #[cfg(test)]
            entries_read: 0,
            #[cfg(test)]
            opened_directories: vec![],
        };
        // A removed event path can also be a formerly invalid business name.
        // Prove containment/no symlinks before testing absence, then clear its
        // old discovery failure. Existing entries still face business_path.
        let candidate = root.join(relative);
        file_versions::relative(&root, &candidate)?;
        if fs::symlink_metadata(&candidate).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound) {
            return Ok(result);
        }
        let path = match business_path(&root, relative) {
            Ok(path) => path,
            Err(error) => {
                result.failures.push(ScanFailure { relative_path: relative.into(), reason: error.to_string() });
                result.complete = false;
                return Ok(result);
            }
        };
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(result),
            Err(error) => return Err(error.into()),
        };
        if metadata.is_dir() {
            return self.project_file_scan_page(workspace, project, None, limit, false, true, relative);
        }
        if !metadata.is_file() { return Ok(result); }
        let known: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM documents WHERE project_id IS ?1 AND managed_path=?2 AND storage_mode='project_directory')",
            params![project, self.encode_path_ref(&path)], |r| r.get(0),
        )?;
        if !known {
            match self.project_file_register(workspace, project, relative) {
                Ok(file) => result.files.push(file),
                Err(error) => {
                    result.failures.push(ScanFailure { relative_path: relative.into(), reason: format!("{error:#}") });
                    result.complete = false;
                }
            }
        }
        Ok(result)
    }
    fn project_file_scan_page(
        &self,
        workspace: &str,
        project: Option<i64>,
        cursor: Option<&str>,
        limit: u32,
        cancelled: bool,
        only_new: bool,
        start_relative: &str,
    ) -> Result<DirectoryScan> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        if !(1..=100).contains(&limit) {
            return Err(failure(
                "invalid_argument",
                "Scan page limit must be 1..100",
            ));
        }
        self.directory_schema()?;
        let root = self.directory_owner(workspace, project)?;
        let position = if let Some(cursor) = cursor {
            if cursor.len() > 1024 {
                return Err(failure("invalid_argument", "Scan cursor exceeds its budget"));
            }
            let decoded = STANDARD.decode(cursor).map_err(|_| failure("invalid_argument", "Invalid scan cursor"))?;
            let position: ScanCursor = serde_json::from_slice(&decoded).map_err(|_| failure("invalid_argument", "Invalid scan cursor"))?;
            if position.workspace_id != workspace || position.project_id != project {
                return Err(failure("ownership_mismatch", "Scan cursor belongs to another scope"));
            }
            position
        } else {
            ScanCursor { workspace_id: workspace.into(), project_id: project, scan_id: file_versions::token(), sequence: 0 }
        };
        let mut result = DirectoryScan {
            files: vec![], failures: vec![], excluded: vec![], next_cursor: None,
            complete: false, cancelled,
            #[cfg(test)]
            entries_read: 0,
            #[cfg(test)]
            opened_directories: vec![],
        };
        if cancelled {
            // Cancellation performs no enumeration. The same position remains
            // resumable until explicitly discarded or its bounded lease expires.
            result.next_cursor = cursor.map(str::to_owned);
            return Ok(result);
        }
        let session = {
            let mut sessions = SCAN_SESSIONS.lock().unwrap();
            sessions.retain(|_, session| session.lock().unwrap().touched.elapsed() < std::time::Duration::from_secs(600));
            if cursor.is_none() {
                if sessions.len() >= 64 {
                    return Err(failure("scan_capacity", "Too many active directory scans; finish an existing scan first"));
                }
                sessions.insert(position.scan_id.clone(), std::sync::Arc::new(std::sync::Mutex::new(ScanSession {
                    root: root.clone(), workspace_id: workspace.into(), project_id: project, only_new, start_relative: start_relative.into(), sequence: 0,
                    stack: vec![ScanFrame::new(start_relative.into())], touched: std::time::Instant::now(),
                })));
            }
            sessions.get(&position.scan_id).cloned().ok_or_else(|| failure("scan_expired", "Directory scan expired; start again"))?
        };
        let mut progress = session.lock().unwrap();
        if progress.root != root || progress.workspace_id != workspace || progress.project_id != project || progress.only_new != only_new || progress.start_relative != start_relative {
            return Err(failure("ownership_mismatch", "Scan cursor belongs to another scope or mode"));
        }
        if progress.sequence != position.sequence {
            return Err(failure("invalid_argument", "Scan cursor was already consumed"));
        }
        progress.touched = std::time::Instant::now();
        let mut processed = 0;
        let mut snapshot_bytes = 0u64;
        let mut visited = 0;
        let mut entries_read = 0;
        let mut terminal_error = None;
        // The filesystem enumeration budget is independent from returned Files.
        // A continuation consumes the existing ReadDir, never restarts read_dir.
        while processed < limit && visited < 128 {
            let open_in_scan = progress.stack.iter().filter(|frame| frame.entries.is_some()).count();
            let Some(frame) = progress.stack.last_mut() else { break; };
            let frame_relative = frame.relative_path.clone();
            let directory = if frame_relative.is_empty() { Ok(root.clone()) } else { business_path(&root, &frame_relative) };
            let directory = match directory {
                Ok(directory) => directory,
                Err(error) => {
                    result.failures.push(ScanFailure { relative_path: frame_relative, reason: error.to_string() });
                    progress.stack.pop(); visited += 1; continue;
                }
            };
            if frame.entries.is_none() && !frame.exhausted {
                let entries = file_versions::relative(&self.workspace_root, &directory)
                    .and_then(|_| frame.open(&directory, open_in_scan));
                match entries {
                    Ok(()) => {
                        #[cfg(test)]
                        result.opened_directories.push(frame_relative.clone());
                    }
                    Err(error) => {
                        if error.downcast_ref::<FileServiceError>().is_some_and(|failure| failure.code == "scan_fd_budget") {
                            terminal_error = Some(failure("scan_fd_budget", &format!("Directory scan at {frame_relative}: {error}")));
                            break;
                        }
                        result.failures.push(ScanFailure { relative_path: frame_relative, reason: error.to_string() });
                        progress.stack.pop();
                        visited += 1;
                        continue;
                    }
                }
            }
            if frame.buffered.is_empty() && !frame.exhausted {
                if entries_read == 128 { break; }
                result.failures.extend(frame.fill_batch(&mut entries_read));
            }
            let Some(entry) = frame.buffered.pop_front() else {
                if frame.exhausted { progress.stack.pop(); continue; }
                break;
            };
            visited += 1;
            let name = entry.name.clone();
            let relative = if frame_relative.is_empty() { name.clone() } else { format!("{frame_relative}/{name}") };
            let kind = entry.kind;
            if excluded_component(&name) {
                result.excluded.push(ScanExcluded {
                    relative_path: relative,
                    reason: if name == ".project-mind" || name.ends_with(".pm-versions") {
                        "internal"
                    } else {
                        "hidden"
                    }
                    .into(),
                });
                continue;
            }
            if kind.is_file() && crate::project_file_exclusions::is_temporary_file_name(&name) {
                result.excluded.push(ScanExcluded {
                    relative_path: relative,
                    reason: "temporary".into(),
                });
                continue;
            }
            if kind.is_symlink() {
                result.excluded.push(ScanExcluded {
                    relative_path: relative,
                    reason: "symlink".into(),
                });
                continue;
            }
            match fs::symlink_metadata(root.join(&relative)) {
                Ok(metadata) if hidden_metadata(&metadata) => {
                    result.excluded.push(ScanExcluded {
                        relative_path: relative,
                        reason: "hidden".into(),
                    });
                    continue;
                }
                Ok(_) => {}
                Err(error) => {
                    result.failures.push(ScanFailure {
                        relative_path: relative,
                        reason: error.to_string(),
                    });
                    continue;
                }
            }
            if kind.is_dir() {
                if let Err(error) = business_path(&root, &relative) {
                    result.failures.push(ScanFailure {
                        relative_path: relative,
                        reason: error.to_string(),
                    });
                    continue;
                }
                if progress.stack.len() >= 256 {
                    result.failures.push(ScanFailure {
                        relative_path: relative,
                        reason: "Directory exceeds the scan depth budget".into(),
                    });
                    continue;
                }
                progress.stack.push(ScanFrame::new(relative));
                continue;
            }
            if !kind.is_file() {
                result.excluded.push(ScanExcluded {
                    relative_path: relative,
                    reason: "special".into(),
                });
                continue;
            }
            if only_new && self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM documents WHERE project_id IS ?1 AND managed_path=?2 AND storage_mode='project_directory')",
                params![project, self.encode_path_ref(&root.join(&relative))], |r| r.get::<_, bool>(0),
            )? {
                continue;
            }
            if only_new {
                // Five small Files may share a page; large snapshots yield once
                // the existing per-File byte budget has been charged. Oversized
                // Files cost no snapshot bytes and still become visible failures.
                let max_bytes = crate::file_text_patch::MAX_FILE_BYTES as u64;
                let bytes = fs::metadata(root.join(&relative)).map(|m| m.len()).unwrap_or(0);
                let charge = if bytes <= max_bytes { bytes } else { 0 };
                if processed > 0 && snapshot_bytes + charge > max_bytes {
                    progress.stack.last_mut().unwrap().buffered.push_front(entry);
                    break;
                }
                snapshot_bytes += charge;
            }
            processed += 1;
            match self.project_file_register(workspace, project, &relative) {
                Ok(file) => result.files.push(file),
                Err(error) => {
                    result.failures.push(ScanFailure {
                        relative_path: relative.clone(),
                        reason: format!("{error:#}"),
                    });
                    // Advance past this failed File; a later full pass retries it.
                }
            }
        }
        if terminal_error.is_some() { progress.stack.clear(); }
        result.complete = progress.stack.is_empty() && result.failures.is_empty() && terminal_error.is_none();
        #[cfg(test)]
        { result.entries_read = entries_read; }
        let finished = progress.stack.is_empty();
        if !finished {
            progress.sequence += 1;
            let next = ScanCursor { workspace_id: workspace.into(), project_id: project, scan_id: position.scan_id.clone(), sequence: progress.sequence };
            result.next_cursor = Some(STANDARD.encode(serde_json::to_vec(&next)?));
        }
        // Registry -> session is the only nested lock order; release the session
        // before removing it so other scan requests cannot deadlock cleanup.
        drop(progress);
        if finished { SCAN_SESSIONS.lock().unwrap().remove(&position.scan_id); }
        if let Some(error) = terminal_error { return Err(error); }
        Ok(result)
    }
    pub(crate) fn project_file_resolve_related(
        &self,
        object: &ObjectRef,
        reference: &str,
    ) -> Result<DirectoryFile> {
        let current = self.project_file_resolve(object)?;
        if current.state != "ready" {
            return Err(failure(
                "source_not_ready",
                "Confirm the current File identity before resolving related resources",
            ));
        }
        let (document, root) = self.directory_target(object)?;
        let path_part = reference.split(['?', '#']).next().unwrap_or_default();
        let decoded = percent_encoding::percent_decode_str(path_part)
            .decode_utf8()
            .map_err(|_| failure("invalid_path", "Resource URL path is not UTF-8"))?;
        if decoded.is_empty() || decoded.starts_with('/') || decoded.contains([':', '\\', '\0']) {
            return Err(failure(
                "invalid_path",
                "Related resource must be a relative Project URL path",
            ));
        }
        let base = Path::new(&document.managed_path)
            .parent()
            .unwrap()
            .strip_prefix(&root)?;
        let mut components: Vec<String> = base
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        for part in decoded.split('/') {
            match part {
                "" | "." => (),
                ".." => {
                    if components.pop().is_none() {
                        return Err(failure(
                            "ownership_mismatch",
                            "Related resource escapes the Project",
                        ));
                    }
                }
                name => components.push(name.into()),
            }
        }
        let relative = components.join("/");
        business_path(&root, &relative)?;
        let (project, _) = file_id(object)?;
        self.project_file_register(&object.workspace_id, project, &relative)
    }
    /// WP5's model read seam: authorize with the existing AI source policy and
    /// return a SourceRef describing the exact bytes delivered in this call.
    /// The tool hook must persist this SourceRef only after successful delivery.
    pub(crate) fn project_file_read_source(
        &self,
        request: &crate::agent::access::RequestContext,
        binding: &crate::agent::models::WorkspaceBinding,
        input: &FileBytesInput,
    ) -> crate::agent::errors::AgentResult<(FileBytesResult, crate::agent::models::SourceRef)> {
        self.project_file_read_source_bounded(request, binding, input, None)
    }
    pub(crate) fn project_file_office_plan(
        &self,
        request: &crate::agent::access::RequestContext,
        binding: &crate::agent::models::WorkspaceBinding,
        input: &FileBytesInput,
    ) -> crate::agent::errors::AgentResult<crate::file_office::reads::OfficeReadPlan> {
        use crate::agent::errors::{AgentError, ErrorCode};
        let actual = self.source_read_historical_file(request, binding, &input.object)?;
        request.authorize_object(binding, &input.object, &actual, "source.read")?;
        let fail = |message| AgentError::new(ErrorCode::SourceNotReady, message);
        if input.version_number == 0 || !file_versions::valid_hash(&input.expected_content_hash) {
            return Err(AgentError::new(ErrorCode::InvalidArgument, "Invalid fixed Office version/hash"));
        }
        let (document, _) = self.directory_target(&input.object).map_err(|_| fail("Office File is unavailable"))?;
        let retained: Option<(String, String, Option<String>)> = self.conn.query_row(
            "SELECT v.managed_path,v.name,h.content_hash FROM document_versions v LEFT JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1 AND v.version_number=?2",
            params![document.id, input.version_number], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional().map_err(|_| fail("Cannot resolve Office File Version"))?;
        let (path, name, hash) = retained.ok_or_else(|| fail("Office File Version is no longer retained"))?;
        let hash = hash.ok_or_else(|| fail("Historical Office hash is unknown"))?;
        if hash != input.expected_content_hash {
            return Err(AgentError::new(ErrorCode::SourceChanged, "Office File Version hash differs from registration"));
        }
        Ok(crate::file_office::reads::OfficeReadPlan {
            input: input.clone(), root: self.workspace_root.clone(), path: self.decode_path_ref(&path), name,
        })
    }
    fn project_file_read_source_bounded(
        &self,
        request: &crate::agent::access::RequestContext,
        binding: &crate::agent::models::WorkspaceBinding,
        input: &FileBytesInput,
        limit: Option<usize>,
    ) -> crate::agent::errors::AgentResult<(FileBytesResult, crate::agent::models::SourceRef)> {
        use crate::agent::errors::{AgentError, ErrorCode};
        let actual = self.source_read_historical_file(request, binding, &input.object)?;
        request.authorize_object(binding, &input.object, &actual, "source.read")?;
        let bytes = self.project_file_read_bytes_bounded(input, limit).map_err(|error| {
            let error = FileServiceError::from_error(error);
            let code = match error.code {
                "ownership_mismatch" => ErrorCode::ScopeDenied,
                "budget_exceeded" => ErrorCode::BudgetExceeded,
                "hash_mismatch" => ErrorCode::SourceChanged,
                "snapshot_missing" | "version_unregistered" => ErrorCode::SourceNotReady,
                "invalid_argument" => ErrorCode::InvalidArgument,
                _ => ErrorCode::IoFailed,
            };
            AgentError::new(code, error.message)
                .with_details(serde_json::json!({"reason":error.code}))
        })?;
        let source = crate::agent::models::SourceRef {
            object: bytes.object.clone(),
            revision: bytes.content_hash.clone(),
            file_version: Some(bytes.version_number),
            record_version: None,
            block_id: None,
            locator: None,
            title: bytes.name.clone(),
            excerpt: String::new(),
        };
        Ok((bytes, source))
    }
    pub(crate) fn project_file_read_bytes(
        &self,
        input: &FileBytesInput,
    ) -> Result<FileBytesResult> {
        self.project_file_read_bytes_bounded(input, None)
    }
    fn project_file_read_bytes_bounded(
        &self,
        input: &FileBytesInput,
        limit: Option<usize>,
    ) -> Result<FileBytesResult> {
        use crate::source_file_snapshot::{open_regular, FileStamp};
        use base64::{engine::general_purpose::STANDARD, Engine};
        use sha2::{Digest, Sha256};
        self.directory_schema()?;
        let (document, _) = self.directory_target(&input.object)?;
        if input.version_number == 0 || !file_versions::valid_hash(&input.expected_content_hash) {
            return Err(failure("invalid_argument", "Invalid fixed version/hash"));
        }
        let retained: Option<(String,String,Option<String>)> = self.conn.query_row("SELECT v.managed_path,v.name,h.content_hash FROM document_versions v LEFT JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1 AND v.version_number=?2",params![document.id,input.version_number],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let (path, name, hash) = retained
            .ok_or_else(|| failure("snapshot_missing", "File Version is no longer retained"))?;
        let hash =
            hash.ok_or_else(|| failure("version_unregistered", "Historical File hash is unknown"))?;
        if hash != input.expected_content_hash {
            return Err(failure(
                "hash_mismatch",
                "Requested File Version hash differs from registration",
            ));
        }
        let path = self.decode_path_ref(&path);
        file_versions::relative(&self.workspace_root, &path)?;
        let metadata = fs::symlink_metadata(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                failure(
                    "snapshot_missing",
                    "Retained File Version bytes are missing",
                )
            } else {
                e.into()
            }
        })?;
        if !metadata.is_file() {
            return Err(failure(
                "snapshot_missing",
                "Retained File Version is not a regular file",
            ));
        }
        let limit = limit.unwrap_or_else(|| byte_limit(&name));
        if metadata.len() > limit as u64 {
            return Err(failure(
                "budget_exceeded",
                "File exceeds its existing preview byte budget",
            ));
        }
        let stamp = FileStamp::from_metadata(&metadata);
        let mut file = open_regular(&path).map_err(|e| failure("io_failed", &e.message))?;
        if FileStamp::from_metadata(&file.metadata()?) != stamp {
            return Err(failure("source_changed", "Snapshot changed while opening"));
        }
        let mut bytes = Vec::new();
        file.by_ref()
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > limit {
            return Err(failure(
                "budget_exceeded",
                "File exceeds its existing preview byte budget",
            ));
        }
        if FileStamp::from_metadata(&file.metadata()?) != stamp
            || FileStamp::from_metadata(&fs::symlink_metadata(&path)?) != stamp
            || format!("sha256:{:x}", Sha256::digest(&bytes)) != hash
        {
            return Err(failure(
                "hash_mismatch",
                "Retained bytes differ from the requested File Version",
            ));
        }
        file_versions::relative(&self.workspace_root, &path)?;
        Ok(FileBytesResult {
            object: input.object.clone(),
            version_number: input.version_number,
            content_hash: hash,
            mime: mime_guess::from_path(&name)
                .first_or_octet_stream()
                .essence_str()
                .into(),
            name,
            byte_length: bytes.len(),
            base64: STANDARD.encode(bytes),
        })
    }
}
#[cfg(test)]
#[path = "project_directory_files_tests.rs"]
mod tests;

#[path = "project_directory_files_restore.rs"]
mod restore;
