//! File Version commit/recovery kernel. Native GUI delegates here; registered
//! CAS/receipts include GUI preflight; the GUI service uses an existing Host
//! connection and Workspace commit fence. Upload/registered adapters are pending.
//! Uses existing documents/document_versions and preserves unknown old hashes.
use super::{
    agent_operations::{io_error, OperationChange},
    Database,
};
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
    },
    models::{DocumentAddVersionInput, DocumentRecord},
};
use anyhow::{anyhow, bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

const JOURNALS: &str = ".project-mind/file-version-journal";
/// Internal intent: adapters resolve uploads to an owned path separately. No
/// capability or remote path-reading endpoint is registered by this kernel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileVersionUpdate {
    pub object: ObjectRef,
    pub expected_version_number: u32,
    pub expected_content_hash: String,
    pub new_content_hash: String,
}
/// Trusted local GUI intent. Physical bytes are frozen by hash at preflight;
/// unknown/externally changed bytes require an explicit registration decision.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GuiFileVersionPrepare {
    pub document_id: i64,
    pub project_id: i64,
    pub managed_path: String,
    pub expected_version_number: u32,
    pub source_path: Option<String>,
}
/// Authoritative metadata only; capturing this snapshot does not read bytes or
/// acquire filesystem leases. The service rechecks it after hashing outside DB.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GuiFileVersionMetadata {
    pub input: GuiFileVersionPrepare,
    pub workspace_root: PathBuf,
    pub registered_content_hash: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GuiFileVersionIntent {
    pub document_id: i64,
    pub project_id: i64,
    pub managed_path: String,
    pub expected_version_number: u32,
    pub expected_content_hash: String,
    pub registered_content_hash: Option<String>,
    pub new_content_hash: String,
    pub source_path: Option<String>,
}
fn agent_failure(error: anyhow::Error) -> AgentError {
    match error.downcast::<CommitFailure>() {
        Ok(failure) => failure.0,
        Err(_) => AgentError::new(ErrorCode::IoFailed, "Cannot prepare or commit File Version"),
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum CommitPayload {
    Native {
        document_id: i64,
        new_hash: String,
    },
    Registered {
        update: FileVersionUpdate,
    },
    RegisteredText {
        object: ObjectRef,
        expected_version_number: u32,
        expected_content_hash: String,
        patch_hash: String,
    },
    RegisteredStage {
        object: ObjectRef,
        expected_version_number: u32,
        expected_content_hash: String,
        staged_content_id: String,
    },
    RegisteredRestore {
        object: ObjectRef,
        expected_version_number: u32,
        expected_content_hash: String,
        version_id: String,
    },
    NativeCas {
        intent: GuiFileVersionIntent,
        register_current_bytes: bool,
    },
}
pub(super) fn registered_payload(
    update: &FileVersionUpdate,
    patch_hash: Option<&str>,
    stage_id: Option<&str>,
    restore: Option<&crate::file_version_restore::FileVersionRestore>,
) -> CommitPayload {
    if let Some(input) = restore {
        return CommitPayload::RegisteredRestore {
            object: update.object.clone(),
            expected_version_number: update.expected_version_number,
            expected_content_hash: update.expected_content_hash.clone(),
            version_id: input.version_id.clone(),
        };
    }
    if let Some(stage_id) = stage_id {
        return CommitPayload::RegisteredStage {
            object: update.object.clone(),
            expected_version_number: update.expected_version_number,
            expected_content_hash: update.expected_content_hash.clone(),
            staged_content_id: stage_id.into(),
        };
    }
    match patch_hash {
        Some(patch_hash) => CommitPayload::RegisteredText {
            object: update.object.clone(),
            expected_version_number: update.expected_version_number,
            expected_content_hash: update.expected_content_hash.clone(),
            patch_hash: patch_hash.into(),
        },
        None => CommitPayload::Registered {
            update: update.clone(),
        },
    }
}
#[derive(Debug)]
struct CommitFailure(AgentError);
impl std::fmt::Display for CommitFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0.message)
    }
}
impl std::error::Error for CommitFailure {}
fn conflict(code: ErrorCode, message: &str) -> anyhow::Error {
    CommitFailure(AgentError::new(code, message)).into()
}
/// Shared source policy at native File preflight and writer boundaries.
pub(crate) fn require_file_source_policy(conn: &rusqlite::Connection, object: &ObjectRef) -> AgentResult<()> {
    let Scope::Project { project_id } = object.scope else {
        return Err(AgentError::new(ErrorCode::ScopeDenied, "File Project is unavailable"));
    };
    let project = ObjectRef {
        workspace_id: object.workspace_id.clone(), scope: object.scope.clone(),
        kind: ObjectKind::Project, id: project_id.to_string(),
    };
    let excluded: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM source_access_policies WHERE object_key IN (?1,?2) AND excluded=1)",
        params![object.key()?, project.key()?], |row| row.get(0),
    ).map_err(io_error)?;
    if excluded {
        return Err(AgentError::new(ErrorCode::ScopeDenied, "File or Project is excluded from AI access"));
    }
    Ok(())
}
pub(crate) fn valid_hash(hash: &str) -> bool {
    hash.strip_prefix("sha256:").is_some_and(|value| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FileIdentity {
    device: u64,
    file: u64,
}
#[cfg(unix)]
pub(crate) fn identity(file: &File) -> Result<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok(FileIdentity {
        device: metadata.dev(),
        file: metadata.ino(),
    })
}
#[cfg(windows)]
pub(crate) fn identity(file: &File) -> Result<FileIdentity> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let id = FileIdentity {
        device: information.dwVolumeSerialNumber as u64,
        file: ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64,
    };
    if id.file == 0 {
        bail!("Filesystem cannot provide File recovery identity");
    }
    Ok(id)
}
#[cfg(not(any(unix, windows)))]
pub(crate) fn identity(_file: &File) -> Result<FileIdentity> {
    bail!("File identity is unsupported")
}
pub(crate) fn path_identity(path: &Path) -> Result<FileIdentity> {
    regular(path)?;
    identity(
        &crate::source_file_snapshot::open_regular(path).map_err(|error| anyhow!(error.message))?,
    )
}
#[derive(Clone, Copy)]
enum CommitPhase {
    Staged,
    Prepared,
    Archived,
    Placed,
    BeforeSqlCommit,
    Committed,
}
fn crash_point(phase: CommitPhase) {
    #[cfg(test)]
    if std::env::var("MIND_FILE_VERSION_PAUSE_STAGE")
        .ok()
        .and_then(|value| value.parse::<u8>().ok())
        == Some(phase as u8)
    {
        let ready = std::env::var("MIND_FILE_VERSION_READY").unwrap();
        let resume = std::env::var("MIND_FILE_VERSION_RESUME").unwrap();
        fs::write(ready, b"ready").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while !Path::new(&resume).exists() {
            if std::time::Instant::now() >= deadline {
                std::process::exit(92);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    #[cfg(test)]
    if let Ok(stage) = std::env::var("MIND_FILE_VERSION_CRASH_STAGE") {
        if stage.parse::<u8>().ok() == Some(phase as u8) {
            #[cfg(unix)]
            {
                // SIGKILL cannot run Rust destructors, libc exit handlers or
                // application cleanup. Exercise SQLite/FS startup recovery.
                unsafe extern "C" {
                    fn kill(pid: i32, signal: i32) -> i32;
                }
                unsafe {
                    kill(std::process::id() as i32, 9);
                }
            }
            std::process::exit(91);
        }
    }
    #[cfg(not(test))]
    let _ = phase;
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    schema_version: u32,
    workspace_id: Option<String>,
    request_id: String,
    journal_id: String,
    caller_id: String,
    payload: CommitPayload,
    document_id: i64,
    project_id: i64,
    expected_version: i64,
    next_version: i64,
    original: String,
    archive: String,
    next: String,
    // Captured current bytes are a recovery checksum, NOT a historical hash.
    original_captured_hash: String,
    original_identity: FileIdentity,
    new_identity: FileIdentity,
    new_hash: String,
    source_path_ref: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommittedVersion {
    pub document_id: i64,
    pub version_number: i64,
    pub content_hash: String,
    pub no_change: bool,
}
/// Per-invocation state; never persisted in the stable operation receipt.
#[derive(Debug)]
pub(crate) struct FileVersionCommitOutcome {
    pub receipt: CommittedVersion,
    pub committed: bool,
}
impl FileVersionCommitOutcome {
    fn replay(receipt: CommittedVersion) -> Self {
        Self {
            receipt,
            committed: false,
        }
    }
}
pub(crate) fn token() -> String {
    format!("{:032x}", rand::random::<u128>())
}
pub(crate) fn regular(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("File Version requires a regular file");
    }
    Ok(())
}
pub(crate) fn checksum(path: &Path) -> Result<String> {
    regular(path)?;
    let mut input =
        crate::source_file_snapshot::open_regular(path).map_err(|error| anyhow!(error.message))?;
    if !input.metadata()?.is_file() || input.metadata()?.file_type().is_symlink() {
        bail!("File handle is not a regular file");
    }
    let before = crate::source_file_snapshot::FileStamp::from_metadata(&input.metadata()?);
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    if before != crate::source_file_snapshot::FileStamp::from_metadata(&input.metadata()?)
        || before
            != crate::source_file_snapshot::FileStamp::from_metadata(&fs::symlink_metadata(path)?)
        || identity(&input)? != path_identity(path)?
    {
        bail!("File changed during checksum verification");
    }
    Ok(format!("sha256:{:x}", digest.finalize()))
}
pub(super) fn snapshot(
    source: &Path,
    destination: &Path,
) -> Result<(String, FileIdentity, FileIdentity)> {
    snapshot_bounded(source, destination, None)
}
pub(super) fn snapshot_bounded(
    source: &Path,
    destination: &Path,
    byte_limit: Option<u64>,
) -> Result<(String, FileIdentity, FileIdentity)> {
    regular(source)?;
    let mut input = crate::source_file_snapshot::open_regular(source)
        .map_err(|error| anyhow!(error.message))?;
    if !input.metadata()?.is_file() || input.metadata()?.file_type().is_symlink() {
        bail!("File handle is not a regular file");
    }
    let before = crate::source_file_snapshot::FileStamp::from_metadata(&input.metadata()?);
    if byte_limit.is_some_and(|limit| {
        input
            .metadata()
            .map_or(true, |metadata| metadata.len() > limit)
    }) {
        return Err(conflict(
            ErrorCode::BudgetExceeded,
            "Staged File exceeds its byte budget",
        ));
    }
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 65536];
    let mut total = 0_u64;
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or_else(|| conflict(ErrorCode::BudgetExceeded, "File byte count overflow"))?;
        if byte_limit.is_some_and(|limit| total > limit) {
            return Err(conflict(
                ErrorCode::BudgetExceeded,
                "Staged File exceeds its byte budget",
            ));
        }
        output.write_all(&buffer[..count])?;
        digest.update(&buffer[..count]);
    }
    output.sync_all()?;
    if before != crate::source_file_snapshot::FileStamp::from_metadata(&input.metadata()?)
        || before
            != crate::source_file_snapshot::FileStamp::from_metadata(&fs::symlink_metadata(source)?)
        || identity(&input)? != path_identity(source)?
    {
        bail!("File changed while preparing its version");
    }
    Ok((
        format!("sha256:{:x}", digest.finalize()),
        identity(&input)?,
        identity(&output)?,
    ))
}
#[cfg(unix)]
pub(crate) fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}
// Windows durable moves use MOVEFILE_WRITE_THROUGH; directory handles do not
// support FlushFileBuffers portably. Real package crash acceptance is pending.
#[cfg(windows)]
pub(crate) fn sync_directory(_path: &Path) -> Result<()> {
    Ok(())
}
#[cfg(not(any(unix, windows)))]
pub(crate) fn sync_directory(_path: &Path) -> Result<()> {
    bail!("File journal durability is unsupported")
}
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn move_exclusive(from: &Path, to: &Path) -> Result<()> {
    rustix::fs::renameat_with(
        rustix::fs::CWD,
        from,
        rustix::fs::CWD,
        to,
        rustix::fs::RenameFlags::NOREPLACE,
    )?;
    sync_directory(
        from.parent()
            .ok_or_else(|| anyhow!("Missing move parent"))?,
    )?;
    if from.parent() != to.parent() {
        sync_directory(to.parent().unwrap())?;
    }
    Ok(())
}
#[cfg(windows)]
pub(crate) fn move_exclusive(from: &Path, to: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn move_exclusive(_from: &Path, _to: &Path) -> Result<()> {
    bail!("Exclusive File moves are unsupported")
}
pub(crate) fn relative(root: &Path, path: &Path) -> Result<String> {
    let relative = path.strip_prefix(root)?;
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        bail!("Invalid managed File path");
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                bail!("Managed File path contains a symlink")
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
    }
    relative
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("Invalid managed File path encoding"))
}
pub(crate) fn create_owned_directories(root: &Path, path: &Path) -> Result<()> {
    let relative_path = relative(root, path)?;
    let mut parent = root.to_path_buf();
    for component in Path::new(&relative_path).components() {
        let next = parent.join(component);
        if !next.exists() {
            match fs::create_dir(&next) {
                Ok(()) => (),
                // Independent connections may initialize the same lock or
                // journal parent. Validate its type below rather than failing
                // a legitimate writer or trusting a raced-in symlink.
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
                Err(error) => return Err(error.into()),
            }
            sync_directory(&parent)?;
        }
        if !fs::symlink_metadata(&next)?.is_dir() {
            bail!("Invalid managed directory");
        }
        parent = next;
    }
    Ok(())
}
pub(super) fn owned(root: &Path, value: &str) -> Result<PathBuf> {
    let path = root.join(value);
    if relative(root, &path)? != value {
        bail!("Invalid File journal path");
    }
    Ok(path)
}
impl Database {
    pub(super) fn file_version_lock(&self, document_id: i64) -> Result<File> {
        self.file_storage_lock("file-version-locks", document_id, true)
    }
    /// Lock order is Project, File, SQLite transaction. Project directory and
    /// Archive writers take the Project lock exclusively; Files take it shared.
    pub(super) fn file_project_lock(&self, project_id: i64, exclusive: bool) -> Result<File> {
        self.file_storage_lock("file-project-locks", project_id, exclusive)
    }
    pub(super) fn file_native_write_locks(&self, document_id: i64) -> Result<(File, File)> {
        let locks = self.file_recovery_write_locks(document_id)?;
        super::agent_file_undo::require_file_visible(&self.conn, document_id)
            .map_err(CommitFailure)?;
        Ok(locks)
    }
    pub(super) fn file_recovery_write_locks(&self, document_id: i64) -> Result<(File, File)> {
        self.file_version_recover_pending()?;
        let project_id: i64 = self.conn.query_row(
            "SELECT project_id FROM documents WHERE id=?1",
            [document_id],
            |row| row.get(0),
        )?;
        let project = self.file_project_lock(project_id, false)?;
        let file = self.file_version_lock(document_id)?;
        Ok((project, file))
    }
    pub(super) fn file_storage_lock(
        &self,
        directory: &str,
        object_id: i64,
        exclusive: bool,
    ) -> Result<File> {
        use fs2::FileExt;
        if object_id <= 0 {
            bail!("Invalid File identity");
        }
        let base = self.workspace_root.join(".project-mind").join(directory);
        create_owned_directories(&self.workspace_root, &base)?;
        let path = base.join(format!("{object_id}.lock"));
        if path.exists() {
            regular(&path)?;
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(
                (rustix::fs::OFlags::NOFOLLOW
                    | rustix::fs::OFlags::NONBLOCK
                    | rustix::fs::OFlags::CLOEXEC)
                    .bits() as i32,
            );
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(
                windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
            );
        }
        let lock = options.open(&path)?;
        if !lock.metadata()?.is_file() || lock.metadata()?.file_type().is_symlink() {
            bail!("Invalid File lock handle");
        }
        if exclusive {
            lock.lock_exclusive()?;
        } else {
            FileExt::lock_shared(&lock)?;
        }
        Ok(lock)
    }
    fn file_journal_paths(&self, journal: &Journal) -> Result<(PathBuf, PathBuf, PathBuf)> {
        if journal.schema_version != 1
            || journal.workspace_id != self.native_workspace_id
            || journal.document_id <= 0
            || journal.project_id <= 0
            || journal.expected_version <= 0
            || journal.next_version
                != journal
                    .expected_version
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("File version overflow"))?
            || journal.next_version > u32::MAX as i64
            || journal.caller_id.is_empty()
            || journal.caller_id.len() > 256
            || journal.request_id.is_empty()
            || journal.request_id.len() > 128
            || !valid_hash(&journal.original_captured_hash)
            || !valid_hash(&journal.new_hash)
            || journal.journal_id.len() != 32
            || !journal
                .journal_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            bail!("Invalid File journal identity");
        }
        match &journal.payload {
            CommitPayload::Native {
                document_id,
                new_hash,
            } if journal.caller_id == "gui"
                && *document_id == journal.document_id
                && new_hash == &journal.new_hash =>
            {
                ()
            }
            CommitPayload::Registered { update }
                if update.object.workspace_id
                    == journal.workspace_id.as_deref().unwrap_or_default()
                    && update.object.kind == ObjectKind::File
                    && update.object.scope
                        == (Scope::Project {
                            project_id: journal.project_id,
                        })
                    && update.object.id == journal.document_id.to_string()
                    && i64::from(update.expected_version_number) == journal.expected_version
                    && update.expected_content_hash == journal.original_captured_hash
                    && update.new_content_hash == journal.new_hash =>
            {
                ()
            }
            CommitPayload::RegisteredText {
                object,
                expected_version_number,
                expected_content_hash,
                patch_hash,
            } if object.workspace_id == journal.workspace_id.as_deref().unwrap_or_default()
                && object.kind == ObjectKind::File
                && object.scope
                    == (Scope::Project {
                        project_id: journal.project_id,
                    })
                && object.id == journal.document_id.to_string()
                && i64::from(*expected_version_number) == journal.expected_version
                && expected_content_hash == &journal.original_captured_hash
                && valid_hash(patch_hash) =>
            {
                ()
            }
            CommitPayload::RegisteredStage {
                object,
                expected_version_number,
                expected_content_hash,
                staged_content_id,
            } if object.workspace_id == journal.workspace_id.as_deref().unwrap_or_default()
                && object.kind == ObjectKind::File
                && object.scope
                    == (Scope::Project {
                        project_id: journal.project_id,
                    })
                && object.id == journal.document_id.to_string()
                && i64::from(*expected_version_number) == journal.expected_version
                && expected_content_hash == &journal.original_captured_hash
                && crate::file_content::valid_stage_id(staged_content_id) =>
            {
                ()
            }
            CommitPayload::RegisteredRestore {
                object,
                expected_version_number,
                expected_content_hash,
                version_id,
            } if object.workspace_id == journal.workspace_id.as_deref().unwrap_or_default()
                && object.kind == ObjectKind::File
                && object.scope
                    == (Scope::Project {
                        project_id: journal.project_id,
                    })
                && object.id == journal.document_id.to_string()
                && i64::from(*expected_version_number) == journal.expected_version
                && expected_content_hash == &journal.original_captured_hash
                && crate::file_version_restore::valid_version_id(version_id) =>
            {
                ()
            }
            CommitPayload::NativeCas { intent, .. }
                if journal.caller_id == "gui"
                    && intent.document_id == journal.document_id
                    && intent.project_id == journal.project_id
                    && i64::from(intent.expected_version_number) == journal.expected_version
                    && intent.expected_content_hash == journal.original_captured_hash
                    && intent.new_content_hash == journal.new_hash
                    && relative(&self.workspace_root, Path::new(&intent.managed_path))?
                        == journal.original =>
            {
                ()
            }
            _ => bail!("File journal intent mismatch"),
        }
        let original = owned(&self.workspace_root, &journal.original)?;
        let archive = owned(&self.workspace_root, &journal.archive)?;
        let next = owned(&self.workspace_root, &journal.next)?;
        if original == archive || original == next || archive == next {
            bail!("File journal paths overlap");
        }
        Ok((original, archive, next))
    }
    fn file_journal_clear(&self, directory: &Path) -> Result<()> {
        fs::remove_dir_all(directory)?;
        sync_directory(directory.parent().unwrap())
    }
    fn file_journal_recover(&self, directory: &Path, journal: &Journal) -> Result<()> {
        let (original, archive, next) = self.file_journal_paths(journal)?;
        let committed: Option<CommittedVersion> = match self.agent_operation_replay(
            &journal.caller_id,
            &journal.request_id,
            "file.version.commit",
            &journal.payload,
        ) {
            Ok(receipt) => receipt,
            // A different operation may win this caller/request while File
            // preparation runs outside storage. Its receipt proves *our* SQL
            // transaction did not commit. Preserve it and restore only the
            // journal-owned bytes, with the metadata/identity checks below.
            Err(error) if error.code == ErrorCode::IdempotencyConflict => None,
            Err(error) => return Err(anyhow!(error.message)),
        };
        if let Some(committed) = committed {
            if committed.document_id != journal.document_id
                || committed.content_hash != journal.new_hash
                || committed.version_number
                    != if committed.no_change {
                        journal.expected_version
                    } else {
                        journal.next_version
                    }
            {
                bail!("File commit receipt mismatch; journal retained");
            }
            // SQL commit is durable; never undo it based on a missing cleanup.
            self.file_journal_clear(directory)?;
            return Ok(());
        }
        let current = self.document_record(journal.document_id)?;
        if current.project_id != journal.project_id
            || current.current_version_number != journal.expected_version
            || Path::new(&current.managed_path) != original
        {
            bail!("File metadata changed before recovery; journal retained");
        }
        let expected_archive = PathBuf::from(&current.history_dir_path).join(
            super::versioned_file_name(&current.base_name, current.current_version_number),
        );
        let expected_next = PathBuf::from(self.project_record(current.project_id)?.root_path).join(
            super::versioned_file_name(&current.base_name, journal.next_version),
        );
        if archive != expected_archive || next != expected_next {
            bail!("File journal differs from owned version paths");
        }
        if !original.exists() {
            if archive.exists() {
                if checksum(&archive)? != journal.original_captured_hash
                    || path_identity(&archive)? != journal.original_identity
                {
                    bail!("Archived File bytes changed; journal retained");
                }
                move_exclusive(&archive, &original)?;
            } else {
                if checksum(&directory.join("original.bin"))? != journal.original_captured_hash {
                    bail!("File recovery snapshot changed");
                }
                snapshot(&directory.join("original.bin"), &original)?;
                sync_directory(original.parent().unwrap())?;
            }
        } else if checksum(&original)? != journal.original_captured_hash {
            bail!("Current File bytes changed; journal retained");
        }
        if next.exists() {
            if checksum(&next)? != journal.new_hash || path_identity(&next)? != journal.new_identity
            {
                bail!("New File bytes changed; journal retained");
            }
            fs::remove_file(&next)?;
            sync_directory(next.parent().unwrap())?;
        }
        if archive.exists() {
            // Exclusive rename cannot leave both original and archive. This is
            // a foreign collision even when bytes match; never delete it.
            bail!("Archived File path is occupied; journal retained");
        }
        self.file_journal_clear(directory)
    }
    pub(crate) fn file_version_recover_pending(&self) -> Result<()> {
        self.file_import_recover_pending()?;
        self.file_metadata_recover_pending()?;
        self.file_delete_recover_pending()?;
        self.file_relocate_recover_pending()?;
        let base = self.workspace_root.join(JOURNALS);
        if !base.exists() {
            return Ok(());
        }
        relative(&self.workspace_root, &base)?;
        for entry in fs::read_dir(&base)? {
            let entry = entry?;
            let directory = entry.path();
            let kind = match entry.file_type() {
                Ok(kind) => kind,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            if !kind.is_dir() || kind.is_symlink() {
                bail!("Invalid File journal directory");
            }
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| anyhow!("Invalid File journal name"))?;
            let (id, request_id) = name
                .split_once('-')
                .ok_or_else(|| anyhow!("Invalid File journal name"))?;
            let document_id: i64 = id.parse()?;
            if document_id <= 0
                || document_id.to_string() != id
                || request_id.len() != 32
                || !request_id
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            {
                bail!("Invalid File journal name");
            }
            // Staging may still be in progress in another database connection.
            // The directory identity lets recovery acquire its lock even before
            // the atomic descriptor exists, so it cannot delete live snapshots.
            let project_id: Option<i64> = self
                .conn
                .query_row(
                    "SELECT project_id FROM documents WHERE id=?1",
                    [document_id],
                    |row| row.get(0),
                )
                .optional()?;
            let _project_lock = project_id
                .map(|id| self.file_project_lock(id, false))
                .transpose()?;
            let _lock = self.file_version_lock(document_id)?;
            if !directory.exists() {
                continue;
            }
            let descriptor = directory.join("journal.json");
            if !descriptor.exists() {
                self.file_journal_clear(&directory)?;
                continue;
            }
            regular(&descriptor)?;
            if fs::metadata(&descriptor)?.len() > 16384 {
                bail!("File journal exceeds metadata budget");
            }
            let journal: Journal = serde_json::from_slice(&fs::read(&descriptor)?)?;
            if journal.journal_id != request_id || journal.document_id != document_id {
                bail!("File journal token mismatch");
            }
            self.file_journal_recover(&directory, &journal)?;
        }
        Ok(())
    }
    pub(crate) fn file_version_committed_path(
        &self,
        receipt: &CommittedVersion,
    ) -> Result<Option<String>> {
        let stored: Option<String> = self.conn.query_row(
            "SELECT managed_path FROM document_versions WHERE document_id=?1 AND version_number=?2",
            params![receipt.document_id, receipt.version_number], |row| row.get(0)).optional()?;
        Ok(stored.map(|path| self.decode_path_ref_to_string(&path)))
    }
    pub(crate) fn file_version_gui_metadata(
        &self,
        input: &GuiFileVersionPrepare,
    ) -> AgentResult<GuiFileVersionMetadata> {
        (|| -> Result<_> {
            if input.document_id <= 0 || input.project_id <= 0 || input.expected_version_number == 0 {
                return Err(conflict(ErrorCode::InvalidArgument, "Invalid File Version target"));
            }
            super::agent_file_undo::require_file_visible(&self.conn, input.document_id).map_err(CommitFailure)?;
            let current = self.document_record(input.document_id).map_err(|error| {
                if matches!(error.downcast_ref::<rusqlite::Error>(), Some(rusqlite::Error::QueryReturnedNoRows)) {
                    conflict(ErrorCode::NotFound, "File no longer exists")
                } else { error }
            })?;
            if current.project_id != input.project_id || current.managed_path != input.managed_path
                || current.current_version_number != i64::from(input.expected_version_number)
                || current.storage_mode == "managed_note_image" {
                return Err(conflict(ErrorCode::RevisionConflict, "File changed since it was displayed"));
            }
            if self.project_record(current.project_id)?.is_archived {
                return Err(conflict(ErrorCode::ScopeDenied, "Archived Project is outside the active write scope"));
            }
            crate::source_search_index::SourceIndex::prepare(&self.conn).map_err(CommitFailure)?;
            let known = self.conn.query_row("SELECT h.content_hash FROM document_versions v JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1 AND v.version_number=?2", params![current.id, current.current_version_number], |row| row.get(0)).optional()?;
            Ok(GuiFileVersionMetadata {
                input: input.clone(),
                workspace_root: self.workspace_root.clone(),
                registered_content_hash: known,
            })
        })().map_err(agent_failure)
    }
    /// Kernel fixtures need frozen intents without a desktop host. Production
    /// preflight goes through FileVersionService, which releases host locks.
    #[cfg(test)]
    pub(crate) fn file_version_prepare_gui(
        &self,
        input: &GuiFileVersionPrepare,
    ) -> AgentResult<GuiFileVersionIntent> {
        let metadata = self.file_version_gui_metadata(input)?;
        relative(&metadata.workspace_root, Path::new(&input.managed_path))
            .map_err(agent_failure)?;
        let expected_content_hash =
            checksum(Path::new(&input.managed_path)).map_err(agent_failure)?;
        let new_content_hash = input
            .source_path
            .as_deref()
            .map(|path| checksum(Path::new(path)).map_err(agent_failure))
            .transpose()?
            .unwrap_or_else(|| expected_content_hash.clone());
        Ok(GuiFileVersionIntent {
            document_id: input.document_id,
            project_id: input.project_id,
            managed_path: input.managed_path.clone(),
            expected_version_number: input.expected_version_number,
            expected_content_hash,
            registered_content_hash: metadata.registered_content_hash,
            new_content_hash,
            source_path: input.source_path.clone(),
        })
    }
    #[cfg(test)]
    pub(crate) fn file_version_commit_gui(
        &mut self,
        binding: &WorkspaceBinding,
        request_id: &str,
        intent: &GuiFileVersionIntent,
        register_current_bytes: bool,
    ) -> AgentResult<CommittedVersion> {
        self.file_version_commit_gui_bound(
            binding,
            request_id,
            intent,
            register_current_bytes,
            &crate::workspace_commit_fence::WorkspaceCommitFence::new(),
        )
        .map(|outcome| outcome.receipt)
    }
    pub(crate) fn file_version_commit_gui_bound(
        &mut self,
        binding: &WorkspaceBinding,
        request_id: &str,
        intent: &GuiFileVersionIntent,
        register_current_bytes: bool,
        fence: &crate::workspace_commit_fence::WorkspaceCommitFence,
    ) -> AgentResult<FileVersionCommitOutcome> {
        (|| -> Result<_> {
            if self.native_workspace_id.as_deref() != Some(binding.workspace_id.as_str()) {
                return Err(conflict(
                    ErrorCode::WorkspaceChanged,
                    "File Workspace binding changed",
                ));
            }
            if request_id.is_empty()
                || request_id.len() > 128
                || intent.document_id <= 0
                || intent.project_id <= 0
                || intent.expected_version_number == 0
                || !valid_hash(&intent.expected_content_hash)
                || !valid_hash(&intent.new_content_hash)
                || intent
                    .registered_content_hash
                    .as_ref()
                    .is_some_and(|hash| !valid_hash(hash))
            {
                return Err(conflict(
                    ErrorCode::InvalidArgument,
                    "Invalid GUI File Version intent",
                ));
            }
            self.file_version_commit(
                DocumentAddVersionInput {
                    document_id: intent.document_id,
                    source_path: intent.source_path.clone(),
                },
                None,
                Some((request_id, intent, register_current_bytes)),
                Some(fence),
                None,
                None,
                None,
            )
        })()
        .map_err(agent_failure)
    }
    #[cfg(test)]
    pub fn document_add_version(
        &mut self,
        input: DocumentAddVersionInput,
    ) -> Result<DocumentRecord> {
        let id = input.document_id;
        self.file_version_commit(input, None, None, None, None, None, None)?;
        self.document_record(id)
    }

    pub(crate) fn file_version_registered_target(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
    ) -> AgentResult<DocumentRecord> {
        self.file_version_target_for(request, binding, object, "file.update")
    }
    pub(crate) fn file_version_recovery_target(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
    ) -> AgentResult<DocumentRecord> {
        self.file_version_target_for(request, binding, object, "operation.undo")
    }
    pub(crate) fn file_version_recovery_target_hidden(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
        operation: &str,
    ) -> AgentResult<DocumentRecord> {
        self.file_version_target_scope(request, binding, object, operation)
    }
    fn file_version_target_for(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
        operation: &str,
    ) -> AgentResult<DocumentRecord> {
        let target = self.file_version_target_scope(request, binding, object, operation)?;
        super::agent_file_undo::require_file_visible(&self.conn, target.id)?;
        Ok(target)
    }
    fn file_version_target_scope(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
        operation: &str,
    ) -> AgentResult<DocumentRecord> {
        object.key()?;
        if object.kind != ObjectKind::File {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Expected a File target",
            ));
        }
        if self.native_workspace_id.as_deref() != Some(binding.workspace_id.as_str()) {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "File Workspace binding changed",
            ));
        }
        let actual = self
            .agent_resolve_object(object, &binding.workspace_id)?
            .ok_or_else(|| AgentError::new(ErrorCode::NotFound, "File no longer exists"))?;
        let operation = if operation == "file.restore"
            && super::agent_file_undo::file_undo_authorize_target(
                &self.conn, request, binding, object,
            )? {
            "operation.undo"
        } else {
            operation
        };
        request.authorize_object(binding, object, &actual, operation)?;
        self.agent_connection_require_live(request, binding, &actual.scope, operation)?;
        self.source_live_scope(&actual.scope)?;
        self.source_prepare()?;
        require_file_source_policy(&self.conn, &actual)?;
        self.document_record(
            actual
                .id
                .parse()
                .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Invalid File ID"))?,
        )
        .map_err(agent_failure)
    }
    pub(crate) fn file_version_patch_replay(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        update: &FileVersionUpdate,
        patch_hash: &str,
    ) -> AgentResult<Option<CommittedVersion>> {
        let target = self.file_version_registered_target(request, binding, &update.object)?;
        // An old path may be temporarily absent between archive and SQL. Wait
        // for any writer to settle before deciding whether its receipt exists.
        let _project = self
            .file_project_lock(target.project_id, false)
            .map_err(agent_failure)?;
        let _file = self.file_version_lock(target.id).map_err(agent_failure)?;
        self.file_version_registered_target(request, binding, &update.object)?;
        self.agent_operation_replay(
            &request.caller.key(),
            &request.request_id,
            "file.version.commit",
            &registered_payload(update, Some(patch_hash), None, None),
        )
    }
    pub(crate) fn file_version_patch_registered_bound(
        &mut self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        update: &FileVersionUpdate,
        patch_hash: &str,
        bytes: &[u8],
        fence: &crate::workspace_commit_fence::WorkspaceCommitFence,
    ) -> AgentResult<FileVersionCommitOutcome> {
        self.file_version_registered_target(request, binding, &update.object)?;
        if update.expected_version_number == 0
            || !valid_hash(&update.expected_content_hash)
            || !valid_hash(&update.new_content_hash)
            || !valid_hash(patch_hash)
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid File patch baseline",
            ));
        }
        if bytes.len() > crate::file_text_patch::MAX_FILE_BYTES {
            return Err(AgentError::new(
                ErrorCode::BudgetExceeded,
                "File patch exceeds 100 MiB",
            ));
        }
        if format!("sha256:{:x}", Sha256::digest(bytes)) != update.new_content_hash {
            return Err(AgentError::new(
                ErrorCode::InvalidPatch,
                "File patch result hash mismatch",
            ));
        }
        self.file_version_commit(
            DocumentAddVersionInput {
                document_id: update
                    .object
                    .id
                    .parse()
                    .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Invalid File ID"))?,
                source_path: None,
            },
            Some((request, update)),
            None,
            Some(fence),
            Some((patch_hash, bytes)),
            None,
            None,
        )
        .map_err(agent_failure)
    }
    pub(crate) fn file_version_staged_replay(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &crate::file_content::FileContentUpdate,
    ) -> AgentResult<Option<CommittedVersion>> {
        let target = self.file_version_registered_target(request, binding, &input.object)?;
        let _project = self
            .file_project_lock(target.project_id, false)
            .map_err(agent_failure)?;
        let _file = self.file_version_lock(target.id).map_err(agent_failure)?;
        self.file_version_registered_target(request, binding, &input.object)?;
        let update = FileVersionUpdate {
            object: input.object.clone(),
            expected_version_number: input.expected_version_number,
            expected_content_hash: input.expected_content_hash.clone(),
            new_content_hash: input.expected_content_hash.clone(),
        };
        self.agent_operation_replay(
            &request.caller.key(),
            &request.request_id,
            "file.version.commit",
            &registered_payload(&update, None, Some(&input.staged_content_id), None),
        )
    }
    pub(crate) fn file_version_staged_commit_bound(
        &mut self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        update: &FileVersionUpdate,
        stage_id: &str,
        source: &Path,
        fence: &crate::workspace_commit_fence::WorkspaceCommitFence,
        precommit: &dyn Fn() -> AgentResult<()>,
    ) -> AgentResult<FileVersionCommitOutcome> {
        self.file_version_registered_target(request, binding, &update.object)?;
        if update.expected_version_number == 0
            || !valid_hash(&update.expected_content_hash)
            || !valid_hash(&update.new_content_hash)
            || !crate::file_content::valid_stage_id(stage_id)
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid staged File update",
            ));
        }
        let relative = relative(&self.workspace_root, source).map_err(agent_failure)?;
        let parent = Path::new(".project-mind")
            .join("file-content-stage")
            .join(stage_id);
        if Path::new(&relative).parent() != Some(parent.as_path())
            || !crate::file_content::valid_blob_name(
                source
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default(),
            )
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "File update requires owned staged bytes",
            ));
        }
        if self.project_file_is_directory(&update.object).map_err(agent_failure)? {
            return self.project_file_staged_directory_bound(request,binding,update,stage_id,source,fence,precommit);
        }
        self.file_version_commit(
            DocumentAddVersionInput {
                document_id: update
                    .object
                    .id
                    .parse()
                    .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Invalid File ID"))?,
                source_path: Some(source.to_string_lossy().into()),
            },
            Some((request, update)),
            None,
            Some(fence),
            None,
            Some((stage_id, precommit)),
            None,
        )
        .map_err(agent_failure)
    }
    pub(crate) fn file_version_restore_replay(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &crate::file_version_restore::FileVersionRestore,
    ) -> AgentResult<Option<CommittedVersion>> {
        input.validate()?;
        super::agent_file_undo::file_undo_validate_restore(&self.conn, request, binding, input)?;
        let target =
            self.file_version_target_for(request, binding, &input.object, "file.restore")?;
        let _project = self
            .file_project_lock(target.project_id, false)
            .map_err(agent_failure)?;
        let _file = self.file_version_lock(target.id).map_err(agent_failure)?;
        self.file_version_target_for(request, binding, &input.object, "file.restore")?;
        let update = FileVersionUpdate {
            object: input.object.clone(),
            expected_version_number: input.expected_version_number,
            expected_content_hash: input.expected_content_hash.clone(),
            new_content_hash: input.expected_content_hash.clone(),
        };
        self.agent_operation_replay(
            &request.caller.key(),
            &request.request_id,
            "file.version.commit",
            &registered_payload(&update, None, None, Some(input)),
        )
    }
    pub(crate) fn file_version_restore_source(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &crate::file_version_restore::FileVersionRestore,
    ) -> AgentResult<crate::file_version_restore::FileRestoreSource> {
        input.validate()?;
        super::agent_file_undo::file_undo_validate_restore(&self.conn, request, binding, input)?;
        let target =
            self.file_version_target_for(request, binding, &input.object, "file.restore")?;
        let id: i64 = input
            .version_id
            .parse()
            .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Invalid File Version ID"))?;
        let row:Option<(i64,String,String,Option<String>)>=self.conn.query_row("SELECT v.version_number,v.managed_path,v.source_path,h.content_hash FROM document_versions v LEFT JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.id=?1 AND v.document_id=?2",params![id,target.id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional().map_err(io_error)?;
        let (number, managed_ref, source_ref, hash) = row.ok_or_else(|| {
            AgentError::new(
                ErrorCode::NotFound,
                "File Version is unavailable in this scope",
            )
        })?;
        let content_hash = hash.ok_or_else(|| {
            AgentError::new(
                ErrorCode::FileChangedUnregistered,
                "Historical File Version has no registered original bytes",
            )
        })?;
        let version_number = u32::try_from(number)
            .ok()
            .filter(|n| *n > 0 && i64::from(*n) <= target.current_version_number)
            .ok_or_else(|| {
                AgentError::new(ErrorCode::IoFailed, "Invalid historical File Version")
            })?;
        if !valid_hash(&content_hash) {
            return Err(AgentError::new(
                ErrorCode::IoFailed,
                "Invalid historical File registration",
            ));
        }
        let managed_path = PathBuf::from(self.decode_path_ref(&managed_ref));
        relative(&self.workspace_root, &managed_path).map_err(agent_failure)?;
        Ok(crate::file_version_restore::FileRestoreSource {
            version_id: id,
            version_number,
            managed_path,
            managed_ref,
            content_hash,
            source_ref,
        })
    }
    pub(crate) fn file_version_restore_commit_bound(
        &mut self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &crate::file_version_restore::FileVersionRestore,
        source: &crate::file_version_restore::FileRestoreSource,
        fence: &crate::workspace_commit_fence::WorkspaceCommitFence,
        precommit: &dyn Fn() -> AgentResult<()>,
    ) -> AgentResult<FileVersionCommitOutcome> {
        input.validate()?;
        if self.file_version_restore_source(request, binding, input)? != *source {
            return Err(AgentError::new(
                ErrorCode::RevisionConflict,
                "Historical File Version metadata changed during preparation",
            ));
        }
        let update = FileVersionUpdate {
            object: input.object.clone(),
            expected_version_number: input.expected_version_number,
            expected_content_hash: input.expected_content_hash.clone(),
            new_content_hash: source.content_hash.clone(),
        };
        if self.document_record(input.object.id.parse().map_err(|_|AgentError::new(ErrorCode::InvalidArgument,"Invalid File ID"))?).map_err(agent_failure)?.storage_mode == "project_directory" {
            return self.project_file_restore_bound(request,binding,input,source,fence,precommit);
        }
        self.file_version_commit(
            DocumentAddVersionInput {
                document_id: input
                    .object
                    .id
                    .parse()
                    .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Invalid File ID"))?,
                source_path: Some(source.managed_path.to_string_lossy().into()),
            },
            Some((request, &update)),
            None,
            Some(fence),
            None,
            None,
            Some((input, precommit)),
        )
        .map_err(agent_failure)
    }
    #[cfg(test)]
    pub(crate) fn file_version_update_registered(
        &mut self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        update: &FileVersionUpdate,
        staged_path: &Path,
    ) -> AgentResult<CommittedVersion> {
        let result = (|| -> Result<CommittedVersion> {
            update.object.key().map_err(CommitFailure)?;
            if update.object.kind != ObjectKind::File
                || update.expected_version_number == 0
                || !valid_hash(&update.expected_content_hash)
                || !valid_hash(&update.new_content_hash)
            {
                return Err(conflict(
                    ErrorCode::InvalidArgument,
                    "Invalid File update baseline",
                ));
            }
            if self.native_workspace_id.as_deref() != Some(binding.workspace_id.as_str()) {
                return Err(conflict(
                    ErrorCode::WorkspaceChanged,
                    "File Workspace binding changed",
                ));
            }
            let actual = self
                .agent_resolve_object(&update.object, &binding.workspace_id)
                .map_err(CommitFailure)?
                .ok_or_else(|| conflict(ErrorCode::NotFound, "File no longer exists"))?;
            request
                .authorize_object(binding, &update.object, &actual, "file.update")
                .map_err(CommitFailure)?;
            let id: i64 = actual.id.parse()?;
            let archived: bool = self.conn.query_row("SELECT p.is_archived FROM documents d JOIN projects p ON p.id=d.project_id WHERE d.id=?1 AND d.storage_mode != 'managed_note_image'", [id], |row| row.get(0))?;
            if archived {
                return Err(conflict(
                    ErrorCode::ScopeDenied,
                    "Archived Project is outside the active write scope",
                ));
            }
            let payload = CommitPayload::Registered {
                update: update.clone(),
            };
            if let Some(receipt) = self
                .agent_operation_replay(
                    &request.caller.key(),
                    &request.request_id,
                    "file.version.commit",
                    &payload,
                )
                .map_err(CommitFailure)?
            {
                return Ok(receipt);
            }
            // Server-owned staging only; future upload adapters never forward
            // a caller-supplied local path to this service.
            let relative_path = relative(&self.workspace_root, staged_path)?;
            if !Path::new(&relative_path)
                .starts_with(Path::new(".project-mind").join("file-content-stage"))
                || Path::new(&relative_path).components().count() < 3
            {
                return Err(conflict(
                    ErrorCode::InvalidArgument,
                    "File update requires bounded owned staging",
                ));
            }
            if fs::metadata(staged_path)?.len() > 100 * 1024 * 1024 {
                return Err(conflict(
                    ErrorCode::BudgetExceeded,
                    "Staged File exceeds 100 MiB",
                ));
            }
            self.file_version_commit(
                DocumentAddVersionInput {
                    document_id: id,
                    source_path: Some(staged_path.to_string_lossy().into()),
                },
                Some((request, update)),
                None,
                None,
                None,
                None,
                None,
            )
            .map(|outcome| outcome.receipt)
        })();
        result.map_err(|error| match error.downcast::<CommitFailure>() {
            Ok(failure) => failure.0,
            Err(_) => AgentError::new(ErrorCode::IoFailed, "Cannot commit File Version"),
        })
    }

    fn file_version_commit(
        &mut self,
        input: DocumentAddVersionInput,
        registered: Option<(&RequestContext, &FileVersionUpdate)>,
        gui: Option<(&str, &GuiFileVersionIntent, bool)>,
        fence: Option<&crate::workspace_commit_fence::WorkspaceCommitFence>,
        patch: Option<(&str, &[u8])>,
        stage: Option<(&str, &dyn Fn() -> AgentResult<()>)>,
        restore: Option<(
            &crate::file_version_restore::FileVersionRestore,
            &dyn Fn() -> AgentResult<()>,
        )>,
    ) -> Result<FileVersionCommitOutcome> {
        if restore.is_some() && (registered.is_none() || patch.is_some() || stage.is_some()) {
            bail!("Invalid registered restore intent");
        }
        let operation = if restore.is_some() {
            "file.restore"
        } else {
            "file.update"
        };
        let stage_id = stage.map(|(id, _)| id);
        self.file_version_recover_pending()?;
        let project_id: i64 = self.conn.query_row(
            "SELECT project_id FROM documents WHERE id=?1",
            [input.document_id],
            |row| row.get(0),
        )?;
        let _project_lock = self.file_project_lock(project_id, false)?;
        let _lock = self.file_version_lock(input.document_id)?;
        super::agent_file_undo::require_file_visible(&self.conn, input.document_id)
            .map_err(CommitFailure)?;
        if let Some((request, update)) = registered {
            let binding = &request.binding;
            self.file_version_target_for(request, binding, &update.object, operation)
                .map_err(CommitFailure)?;
            // Another connection may have committed this exact request while
            // we waited for the File lock. Replay before checking the old CAS.
            if let Some(receipt) = self
                .agent_operation_replay(
                    &request.caller.key(),
                    &request.request_id,
                    "file.version.commit",
                    &registered_payload(
                        update,
                        patch.map(|(hash, _)| hash),
                        stage_id,
                        restore.map(|(input, _)| input),
                    ),
                )
                .map_err(CommitFailure)?
            {
                let _commit = fence
                    .map(|fence| fence.enter())
                    .transpose()
                    .map_err(CommitFailure)?;
                return Ok(FileVersionCommitOutcome::replay(receipt));
            }
        }
        if let Some((request_id, intent, register_current_bytes)) = gui {
            if let Some(receipt) = self
                .agent_operation_replay(
                    "gui",
                    request_id,
                    "file.version.commit",
                    &CommitPayload::NativeCas {
                        intent: intent.clone(),
                        register_current_bytes,
                    },
                )
                .map_err(CommitFailure)?
            {
                let _commit = fence
                    .map(|fence| fence.enter())
                    .transpose()
                    .map_err(CommitFailure)?;
                return Ok(FileVersionCommitOutcome::replay(receipt));
            }
        }
        if registered.is_none() && gui.is_none() {
            self.ensure_project_file_layout(project_id)?;
        }
        let restore_source = if let Some((restore, _)) = restore {
            let (request, update) = registered.expect("restore needs registered target");
            let source = self
                .file_version_restore_source(request, &request.binding, restore)
                .map_err(CommitFailure)?;
            if input.source_path.as_deref() != source.managed_path.to_str()
                || source.content_hash != update.new_content_hash
            {
                return Err(conflict(
                    ErrorCode::SourceChanged,
                    "Historical File Version changed before preparation",
                ));
            }
            Some(source)
        } else {
            None
        };
        let current = self.document_record(input.document_id)?;
        if current.current_version_number <= 0 || current.version_count <= 0 {
            bail!("Invalid stored File Version metadata");
        }
        if current.storage_mode == "managed_note_image" {
            bail!("Inline assets are not File Versions");
        }
        if current.storage_mode == "project_directory" {
            return Err(conflict(ErrorCode::ScopeDenied,"Directory File updates must use the directory service; managed-copy commits cannot relocate its live path or immutable snapshots"));
        }
        let original = PathBuf::from(&current.managed_path);
        if let Some((_, update)) = registered {
            if self.project_record(current.project_id)?.is_archived {
                return Err(conflict(
                    ErrorCode::ScopeDenied,
                    "Project was archived before File commit",
                ));
            }
            if current.current_version_number != i64::from(update.expected_version_number) {
                return Err(conflict(
                    ErrorCode::RevisionConflict,
                    "File Version changed before commit",
                ));
            }
            crate::source_search_index::SourceIndex::prepare(&self.conn).map_err(CommitFailure)?;
            let known: Option<String> = self.conn.query_row("SELECT h.content_hash FROM document_versions v JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1 AND v.version_number=?2", params![current.id, current.current_version_number], |row| row.get(0)).optional()?;
            let known = known.ok_or_else(|| {
                conflict(
                    ErrorCode::FileChangedUnregistered,
                    "File baseline is not registered",
                )
            })?;
            if known != update.expected_content_hash {
                return Err(conflict(
                    ErrorCode::RevisionConflict,
                    "File baseline hash changed before commit",
                ));
            }
            if checksum(&original)? != update.expected_content_hash {
                return Err(conflict(
                    ErrorCode::FileChangedUnregistered,
                    "File bytes are not the registered baseline; register a new version first",
                ));
            }
        }
        if let Some((_, intent, register_current_bytes)) = gui {
            if current.project_id != intent.project_id
                || current.managed_path != intent.managed_path
                || current.current_version_number != i64::from(intent.expected_version_number)
            {
                return Err(conflict(
                    ErrorCode::RevisionConflict,
                    "File Version or location changed before GUI commit",
                ));
            }
            if self.project_record(current.project_id)?.is_archived {
                return Err(conflict(
                    ErrorCode::ScopeDenied,
                    "Project was archived before File commit",
                ));
            }
            crate::source_search_index::SourceIndex::prepare(&self.conn).map_err(CommitFailure)?;
            let known: Option<String> = self.conn.query_row("SELECT h.content_hash FROM document_versions v JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1 AND v.version_number=?2", params![current.id, current.current_version_number], |row| row.get(0)).optional()?;
            if known != intent.registered_content_hash {
                return Err(conflict(
                    ErrorCode::RevisionConflict,
                    "File registration changed before GUI commit",
                ));
            }
            if checksum(&original)? != intent.expected_content_hash {
                return Err(conflict(
                    ErrorCode::FileChangedUnregistered,
                    "File bytes changed after GUI preflight",
                ));
            }
            if known.as_ref() != Some(&intent.expected_content_hash) && !register_current_bytes {
                return Err(conflict(
                    ErrorCode::FileChangedUnregistered,
                    "Confirm registration of current File bytes first",
                ));
            }
        }
        // No filesystem mutation is needed for a registered identical body.
        // Settle its durable receipt before deriving any next-version paths or
        // incrementing the counter; foreign next paths and u32::MAX are irrelevant.
        let no_change = registered
            .is_some_and(|(_, update)| update.new_content_hash == update.expected_content_hash)
            || gui.is_some_and(|(_, intent, _)| {
                intent.registered_content_hash.as_ref() == Some(&intent.expected_content_hash)
                    && intent.new_content_hash == intent.expected_content_hash
            });
        if no_change {
            let (caller_id, request_id, expected_hash, payload) = match (registered, gui) {
                (Some((request, update)), _) => (
                    request.caller.key(),
                    request.request_id.as_str(),
                    &update.new_content_hash,
                    registered_payload(
                        update,
                        patch.map(|(hash, _)| hash),
                        stage_id,
                        restore.map(|(input, _)| input),
                    ),
                ),
                (_, Some((request_id, intent, register_current_bytes))) => (
                    "gui".into(),
                    request_id,
                    &intent.new_content_hash,
                    CommitPayload::NativeCas {
                        intent: intent.clone(),
                        register_current_bytes,
                    },
                ),
                _ => unreachable!("noChange requires a registered intent"),
            };
            let source = input
                .source_path
                .as_deref()
                .map(PathBuf::from)
                .unwrap_or_else(|| original.clone());
            if checksum(&source)? != *expected_hash {
                return Err(conflict(
                    ErrorCode::SourceChanged,
                    "Selected bytes changed before no-change commit",
                ));
            }
            if let Some((_, validate)) = stage {
                validate().map_err(CommitFailure)?;
            }
            if let Some((_, validate)) = restore {
                validate().map_err(CommitFailure)?;
            }
            let _commit = fence
                .map(|fence| fence.enter())
                .transpose()
                .map_err(CommitFailure)?;
            let synchronous: i64 = self
                .conn
                .pragma_query_value(None, "synchronous", |row| row.get(0))?;
            self.conn
                .pragma_update(None, "synchronous", synchronous.max(2))?;
            let result = self.agent_atomic_operation(&caller_id, request_id, "file.version.commit", &payload, |tx| {
                if let Some(source)=&restore_source {crate::file_version_restore::check_source_transaction(tx,source,current.id)?;}
                if let Some((_, update)) = registered {
                    require_file_source_policy(tx, &update.object)?;
                }
                let unchanged: bool = tx.query_row(
                    "SELECT current_version_number=?2 AND project_id=?3 AND managed_path=?4 FROM documents WHERE id=?1",
                    params![current.id, current.current_version_number, current.project_id, self.encode_path_ref(&original)], |row| row.get(0)).map_err(io_error)?;
                if !unchanged {
                    return Err(AgentError::new(ErrorCode::RevisionConflict, "File Version changed before no-change commit"));
                }
                if checksum(&original).map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot verify File baseline"))? != *expected_hash {
                    return Err(AgentError::new(ErrorCode::FileChangedUnregistered, "File bytes changed before no-change commit"));
                }
                Ok((CommittedVersion { document_id: current.id, version_number: current.current_version_number,
                    content_hash: expected_hash.clone(), no_change: true }, None))
            }).map_err(CommitFailure);
            if let Err(error) = self.conn.pragma_update(None, "synchronous", synchronous) {
                eprintln!("No-change File synchronous restore failed: {error}");
            }
            return result
                .map(FileVersionCommitOutcome::replay)
                .map_err(Into::into);
        }
        let archive = PathBuf::from(&current.history_dir_path).join(super::versioned_file_name(
            &current.base_name,
            current.current_version_number,
        ));
        let next_version = current
            .current_version_number
            .checked_add(1)
            .filter(|number| *number <= u32::MAX as i64)
            .ok_or_else(|| anyhow!("File version overflow"))?;
        let next_name = super::versioned_file_name(&current.base_name, next_version);
        let next =
            PathBuf::from(self.project_record(current.project_id)?.root_path).join(&next_name);
        // Validate ownership before making directories or touching bytes.
        let original_ref = relative(&self.workspace_root, &original)?;
        let archive_ref = relative(&self.workspace_root, &archive)?;
        let next_ref = relative(&self.workspace_root, &next)?;
        if archive.exists() || next.exists() {
            bail!("Target File Version already exists");
        }
        let source = input
            .source_path
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| original.clone());
        if registered.is_none()
            && input.source_path.is_some()
            && source
                .extension()
                .map(|extension| extension.to_ascii_lowercase())
                != Path::new(&current.base_name)
                    .extension()
                    .map(|extension| extension.to_ascii_lowercase())
        {
            bail!("A File Version must preserve its existing file type");
        }
        let source_ref = if let Some(source) = &restore_source {
            source.source_ref.clone()
        } else if registered.is_none() && input.source_path.is_some() {
            self.encode_path_ref(&source)
        } else {
            self.document_version_source_path_ref(current.id, current.current_version_number)?
        };
        let base = self.workspace_root.join(JOURNALS);
        relative(&self.workspace_root, &base)?;
        create_owned_directories(&self.workspace_root, &base)?;
        let journal_id = token();
        let request_id = registered.map_or_else(
            || {
                gui.map_or_else(
                    || journal_id.clone(),
                    |(request_id, _, _)| request_id.to_owned(),
                )
            },
            |(request, _)| request.request_id.clone(),
        );
        let caller_id =
            registered.map_or_else(|| "gui".into(), |(request, _)| request.caller.key());
        let directory = base.join(format!("{}-{journal_id}", current.id));
        fs::create_dir(&directory)?;
        sync_directory(&base)?;
        let prepared = (|| -> Result<Journal> {
            let (old_hash, original_identity, _) =
                snapshot(&original, &directory.join("original.bin"))?;
            let (new_hash, new_identity) = if let Some((_, bytes)) = patch {
                let mut output = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(directory.join("new.bin"))?;
                output.write_all(bytes)?;
                output.sync_all()?;
                (
                    format!("sha256:{:x}", Sha256::digest(bytes)),
                    identity(&output)?,
                )
            } else {
                let (hash, _, identity) = snapshot_bounded(
                    &source,
                    &directory.join("new.bin"),
                    registered
                        .filter(|_| restore.is_none())
                        .map(|_| 100 * 1024 * 1024),
                )?;
                (hash, identity)
            };
            if let Some((_, update)) = registered {
                if old_hash != update.expected_content_hash {
                    return Err(conflict(
                        ErrorCode::FileChangedUnregistered,
                        "File changed during version preparation",
                    ));
                }
                if new_hash != update.new_content_hash {
                    return Err(conflict(
                        ErrorCode::SourceChanged,
                        "Staged File bytes changed before commit",
                    ));
                }
            }
            if let Some((_, intent, _)) = gui {
                if old_hash != intent.expected_content_hash {
                    return Err(conflict(
                        ErrorCode::FileChangedUnregistered,
                        "File changed during GUI preparation",
                    ));
                }
                if new_hash != intent.new_content_hash {
                    return Err(conflict(
                        ErrorCode::SourceChanged,
                        "Selected bytes changed after GUI preflight",
                    ));
                }
            }
            crash_point(CommitPhase::Staged);
            let payload = registered.map_or_else(
                || {
                    gui.map_or_else(
                        || CommitPayload::Native {
                            document_id: current.id,
                            new_hash: new_hash.clone(),
                        },
                        |(_, intent, register_current_bytes)| CommitPayload::NativeCas {
                            intent: intent.clone(),
                            register_current_bytes,
                        },
                    )
                },
                |(_, update)| {
                    registered_payload(
                        update,
                        patch.map(|(hash, _)| hash),
                        stage_id,
                        restore.map(|(input, _)| input),
                    )
                },
            );
            let journal = Journal {
                schema_version: 1,
                workspace_id: self.native_workspace_id.clone(),
                request_id,
                journal_id,
                caller_id,
                payload,
                document_id: current.id,
                project_id: current.project_id,
                expected_version: current.current_version_number,
                next_version,
                original: original_ref,
                archive: archive_ref,
                next: next_ref,
                original_captured_hash: old_hash,
                original_identity,
                new_identity,
                new_hash,
                source_path_ref: source_ref,
            };
            let bytes = serde_json::to_vec(&journal)?;
            if bytes.len() > 16384 {
                bail!("File journal exceeds metadata budget");
            }
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(directory.join("journal.tmp"))?;
            output.write_all(&bytes)?;
            output.sync_all()?;
            drop(output);
            move_exclusive(
                &directory.join("journal.tmp"),
                &directory.join("journal.json"),
            )?;
            sync_directory(&directory)?;
            crash_point(CommitPhase::Prepared);
            Ok(journal)
        })();
        let journal = match prepared {
            Ok(journal) => journal,
            Err(error) => {
                let _ = self.file_journal_clear(&directory);
                return Err(error);
            }
        };
        crate::source_search_index::SourceIndex::prepare(&self.conn)
            .map_err(|error| anyhow!(error.message))?;
        let synchronous: i64 = self
            .conn
            .pragma_query_value(None, "synchronous", |row| row.get(0))?;
        self.conn
            .pragma_update(None, "synchronous", synchronous.max(2))?;
        let result = (|| -> Result<FileVersionCommitOutcome> {
            if let Some((_, validate)) = stage {
                validate().map_err(CommitFailure)?;
            }
            if let Some((_, validate)) = restore {
                validate().map_err(CommitFailure)?;
            }
            let _commit = fence
                .map(|fence| fence.enter())
                .transpose()
                .map_err(CommitFailure)?;
            if checksum(&original)? != journal.original_captured_hash {
                return Err(conflict(
                    ErrorCode::FileChangedUnregistered,
                    "Current File changed before commit",
                ));
            }
            if path_identity(&original)? != journal.original_identity {
                return Err(conflict(
                    ErrorCode::SourceChanged,
                    "File snapshot changed before commit",
                ));
            }
            create_owned_directories(&self.workspace_root, archive.parent().unwrap())?;
            relative(&self.workspace_root, &archive)?;
            move_exclusive(&original, &archive)?;
            crash_point(CommitPhase::Archived);
            move_exclusive(&directory.join("new.bin"), &next)?;
            crash_point(CommitPhase::Placed);
            if checksum(&archive)? != journal.original_captured_hash
                || path_identity(&archive)? != journal.original_identity
            {
                return Err(conflict(
                    ErrorCode::FileChangedUnregistered,
                    "Archived File changed during commit",
                ));
            }
            if checksum(&next)? != journal.new_hash || path_identity(&next)? != journal.new_identity
            {
                return Err(conflict(
                    ErrorCode::SourceChanged,
                    "New File bytes changed during commit",
                ));
            }
            let stamp = super::now_iso();
            let mut committed = false;
            let receipt = self.agent_atomic_operation(
                &journal.caller_id,
                &journal.request_id,
                "file.version.commit",
                &journal.payload,
                |tx| {
                    if let Some(source)=&restore_source {crate::file_version_restore::check_source_transaction(tx,source,current.id)?;}
                    let head: i64 = tx.query_row(
                        "SELECT current_version_number FROM documents WHERE id=?1",
                        [current.id], |row| row.get(0),
                    ).map_err(io_error)?;
                    if head != journal.expected_version {
                        return Err(AgentError::new(ErrorCode::RevisionConflict, "File Version changed before commit"));
                    }
                    if let Some((_, update)) = registered {
                        require_file_source_policy(tx, &update.object)?;
                    }
                    let unchanged: bool = tx.query_row(
                        "SELECT project_id=?2 AND managed_path=?3 AND history_dir_path=?4 AND base_name=?5 FROM documents WHERE id=?1",
                        params![current.id, current.project_id, self.encode_path_ref(&original), self.encode_path_ref(Path::new(&current.history_dir_path)), current.base_name],
                        |row| row.get(0),
                    ).map_err(io_error)?;
                    if !unchanged {
                        return Err(AgentError::new(ErrorCode::RevisionConflict, "File metadata changed before commit"));
                    }
                    tx.execute(
                        "UPDATE documents SET name=?1,original_path=?2,managed_path=?3,storage_mode='managed_copy',current_version_number=?4,version_count=version_count+1,updated_at=?5 WHERE id=?6",
                        params![next_name, journal.source_path_ref, self.encode_path_ref(&next), next_version, stamp, current.id],
                    ).map_err(io_error)?;
                    tx.execute(
                        "UPDATE document_versions SET name=?1,managed_path=?2 WHERE document_id=?3 AND version_number=?4",
                        params![super::versioned_file_name(&current.base_name, current.current_version_number), self.encode_path_ref(&archive), current.id, current.current_version_number],
                    ).map_err(io_error)?;
                    tx.execute(
                        "INSERT INTO document_versions(document_id,version_number,name,source_path,managed_path,created_at) VALUES (?1,?2,?3,?4,?5,?6)",
                        params![current.id, next_version, next_name, journal.source_path_ref, self.encode_path_ref(&next), stamp],
                    ).map_err(io_error)?;
                    let version_id = tx.last_insert_rowid();
                    tx.execute(
                        "INSERT INTO source_file_version_hashes(document_version_id,content_hash) VALUES (?1,?2)",
                        params![version_id, journal.new_hash],
                    ).map_err(io_error)?;
                    tx.execute(
                        "UPDATE projects SET updated_at=?1 WHERE id=?2",
                        params![stamp, current.project_id],
                    ).map_err(io_error)?;
                    let change = if let Some(workspace_id) = &journal.workspace_id {
                        let object = ObjectRef {
                            workspace_id: workspace_id.clone(),
                            scope: Scope::Project { project_id: current.project_id },
                            kind: ObjectKind::File,
                            id: current.id.to_string(),
                        };
                        Some(OperationChange {
                            object_key: object.key()?,
                            scope: object.scope,
                            revision: journal.new_hash.clone(),
                        })
                    } else { None };
                    committed = true;
                    crash_point(CommitPhase::BeforeSqlCommit);
                    Ok((CommittedVersion {
                        document_id: current.id,
                        version_number: next_version,
                        content_hash: journal.new_hash.clone(),
                        no_change: false,
                    }, change))
                },
            ).map_err(CommitFailure)?;
            crash_point(CommitPhase::Committed);
            Ok(FileVersionCommitOutcome { receipt, committed })
        })();
        if let Err(error) = self.conn.pragma_update(None, "synchronous", synchronous) {
            eprintln!("File commit synchronous setting restore failed: {error}");
        }
        match result {
            Ok(receipt) => {
                if let Err(error) = self.file_journal_clear(&directory) {
                    eprintln!("Committed File Version cleanup pending: {error}");
                }
                Ok(receipt)
            }
            Err(error) => {
                if let Err(recovery) = self.file_journal_recover(&directory, &journal) {
                    if let Some(failure) = error.downcast_ref::<CommitFailure>() {
                        return Err(CommitFailure(
                            failure
                                .0
                                .clone()
                                .with_details(serde_json::json!({"recoveryPending":true})),
                        )
                        .into());
                    }
                    return Err(anyhow!("{error}; File journal retained: {recovery}"));
                }
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::Database;
    use crate::models::{DocumentAddVersionInput, DocumentImportInput, ProjectCreateInput};
    use sha2::Digest;
    use std::fs;
    fn assert_crashed(status: std::process::ExitStatus) {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(
                status.signal(),
                Some(9),
                "must be a real SIGKILL, not graceful exit"
            );
        }
        #[cfg(not(unix))]
        assert_eq!(status.code(), Some(91));
    }

    struct RegisteredFixture {
        root: tempfile::TempDir,
        db: Database,
        binding: crate::agent::models::WorkspaceBinding,
        request: crate::agent::access::RequestContext,
        update: super::FileVersionUpdate,
        document: crate::models::DocumentRecord,
        staged: std::path::PathBuf,
    }
    fn hash(bytes: &[u8]) -> String {
        format!("sha256:{:x}", sha2::Sha256::digest(bytes))
    }
    fn registered_fixture(new_bytes: &[u8]) -> RegisteredFixture {
        use crate::agent::{
            models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
        };
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
                name: "Registered File".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let original = root.path().join("report.html");
        fs::write(&original, b"unknown legacy").unwrap();
        let first = db
            .document_import_legacy_fixture(DocumentImportInput {
                project_id: project.id,
                source_path: original.to_string_lossy().into(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        let baseline = root.path().join("baseline.html");
        fs::write(
            &baseline,
            b"\xef\xbb\xbf<script>registered\r\nsource</script>\r\n",
        )
        .unwrap();
        let document = db
            .document_add_version(DocumentAddVersionInput {
                document_id: first.id,
                source_path: Some(baseline.to_string_lossy().into()),
            })
            .unwrap();
        let binding = WorkspaceBinding {
            workspace_id: metadata.workspace_id,
            generation: "real-open".into(),
        };
        let grant_id = "abcdefabcdefabcdefabcdefabcdefab";
        let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        db.agent_connection_create(&binding, &crate::agent::connections::ConnectionCreateInput {
            all_projects: false,
            client_label: "File writer fixture".into(), workspace_content: false,
            project_ids: vec![project.id],
            write_operations: vec!["file.update".into()],
        }, grant_id, token).unwrap();
        let request = db.agent_connection_authenticate(&binding, grant_id, token, "save-version").unwrap();
        let directory = root.path().join(".project-mind/file-content-stage/fixture");
        fs::create_dir_all(&directory).unwrap();
        let staged = directory.join("bytes.bin");
        fs::write(&staged, new_bytes).unwrap();
        let update = super::FileVersionUpdate {
            object: ObjectRef {
                workspace_id: binding.workspace_id.clone(),
                scope: Scope::Project {
                    project_id: project.id,
                },
                kind: ObjectKind::File,
                id: document.id.to_string(),
            },
            expected_version_number: 2,
            expected_content_hash: hash(&fs::read(&document.managed_path).unwrap()),
            new_content_hash: hash(new_bytes),
        };
        RegisteredFixture {
            root,
            db,
            binding,
            request,
            update,
            document,
            staged,
        }
    }

    #[test]
    fn file_version_registered_cas_replay_and_immutable_history() {
        let new_bytes = b"\xef\xbb\xbf<script>updated\r\nsource</script>\r\n";
        let mut fixture = registered_fixture(new_bytes);
        let before = fixture.db.committed_change_watermark().unwrap();
        let receipt = fixture
            .db
            .file_version_update_registered(
                &fixture.request,
                &fixture.binding,
                &fixture.update,
                &fixture.staged,
            )
            .unwrap();
        assert_eq!(receipt.version_number, 3);
        assert!(!receipt.no_change);
        assert_eq!(receipt.content_hash, hash(new_bytes));
        let current = fixture.db.document_record(fixture.document.id).unwrap();
        assert_eq!(current.id, fixture.document.id);
        assert_eq!(fs::read(&current.managed_path).unwrap(), new_bytes);
        assert_eq!(fixture.db.committed_change_watermark().unwrap(), before + 1);
        let old = fixture
            .db
            .fetch_document_versions(current.id)
            .unwrap()
            .into_iter()
            .find(|version| version.version_number == 2)
            .unwrap();
        let old_bytes = fs::read(&old.managed_path).unwrap();
        assert_eq!(hash(&old_bytes), fixture.update.expected_content_hash);
        fs::remove_file(&fixture.staged).unwrap();
        assert_eq!(
            fixture
                .db
                .file_version_update_registered(
                    &fixture.request,
                    &fixture.binding,
                    &fixture.update,
                    &fixture.staged
                )
                .unwrap(),
            receipt,
            "retry uses its durable receipt even after staging disappears"
        );
        assert_eq!(fixture.db.committed_change_watermark().unwrap(), before + 1);

        let mut request = fixture.request.clone();
        request.request_id = "use-archived-bytes".into();
        let mut update = fixture.update.clone();
        update.expected_version_number = 3;
        update.expected_content_hash = receipt.content_hash.clone();
        update.new_content_hash = hash(&old_bytes);
        fs::copy(&old.managed_path, &fixture.staged).unwrap();
        let restored_bytes = fixture
            .db
            .file_version_update_registered(&request, &fixture.binding, &update, &fixture.staged)
            .unwrap();
        assert_eq!(restored_bytes.version_number, 4);
        assert_eq!(
            fs::read(&old.managed_path).unwrap(),
            old_bytes,
            "using history as input must preserve its path and bytes"
        );
        assert_eq!(
            fixture
                .db
                .file_version_update_registered(
                    &fixture.request,
                    &fixture.binding,
                    &fixture.update,
                    &fixture.staged
                )
                .unwrap(),
            receipt,
            "older receipt stays stable after another version commits"
        );
        assert_eq!(
            fixture
                .db
                .file_version_update_registered(
                    &fixture.request,
                    &fixture.binding,
                    &update,
                    &fixture.staged
                )
                .unwrap_err()
                .code,
            super::ErrorCode::IdempotencyConflict
        );
        assert_eq!(
            fixture
                .db
                .file_version_update_registered(
                    &{
                        let mut denied = fixture.request.clone();
                        denied.scope_grant.operations.clear();
                        denied
                    },
                    &fixture.binding,
                    &fixture.update,
                    &fixture.staged
                )
                .unwrap_err()
                .code,
            super::ErrorCode::ScopeDenied,
            "replay still requires current authorization"
        );
    }

    fn gui_intent(fixture: &mut RegisteredFixture) -> super::GuiFileVersionIntent {
        fixture.staged = {
            let selected = fixture.root.path().join("picked.html");
            fs::write(&selected, fs::read(&fixture.staged).unwrap()).unwrap();
            selected
        };
        fixture
            .db
            .file_version_prepare_gui(&super::GuiFileVersionPrepare {
                document_id: fixture.document.id,
                project_id: fixture.document.project_id,
                managed_path: fixture.document.managed_path.clone(),
                expected_version_number: fixture.document.current_version_number as u32,
                source_path: Some(fixture.staged.to_string_lossy().into()),
            })
            .unwrap()
    }
    #[test]
    fn file_version_gui_cas_replay_and_unknown_registration() {
        let mut fixture = registered_fixture(b"GUI new bytes");
        let intent = gui_intent(&mut fixture);
        let result = fixture
            .db
            .file_version_commit_gui(&fixture.binding, "gui-save", &intent, false)
            .unwrap();
        assert_eq!(result.version_number, 3);
        let replay = fixture
            .db
            .file_version_commit_gui(&fixture.binding, "gui-save", &intent, false)
            .unwrap();
        assert_eq!(result, replay);
        let mut changed = intent.clone();
        changed.new_content_hash = hash(b"different intent");
        assert!(fixture
            .db
            .file_version_commit_gui(&fixture.binding, "gui-save", &changed, false)
            .is_err());
        assert!(fixture
            .db
            .file_version_commit_gui(&fixture.binding, "stale-save", &intent, false)
            .is_err());
        let head = fixture.db.document_record(fixture.document.id).unwrap();
        fs::write(&head.managed_path, b"external edits").unwrap();
        let intent = fixture
            .db
            .file_version_prepare_gui(&super::GuiFileVersionPrepare {
                document_id: head.id,
                project_id: head.project_id,
                managed_path: head.managed_path.clone(),
                expected_version_number: 3,
                source_path: None,
            })
            .unwrap();
        assert_ne!(
            intent.registered_content_hash.as_ref(),
            Some(&intent.expected_content_hash)
        );
        assert!(fixture
            .db
            .file_version_commit_gui(&fixture.binding, "register", &intent, false)
            .is_err());
        let result = fixture
            .db
            .file_version_commit_gui(&fixture.binding, "register", &intent, true)
            .unwrap();
        assert_eq!(result.version_number, 4);
        assert!(!result.no_change);
        let old_hash: String = fixture.db.conn.query_row("SELECT h.content_hash FROM document_versions v JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1 AND v.version_number=3", [head.id], |row| row.get(0)).unwrap();
        assert_eq!(old_hash, hash(b"GUI new bytes"));
    }
    #[test]
    fn file_version_gui_no_change_and_frozen_bytes_fences() {
        let mut fixture = registered_fixture(b"unused");
        let mut prepare = super::GuiFileVersionPrepare {
            document_id: fixture.document.id,
            project_id: fixture.document.project_id,
            managed_path: fixture.document.managed_path.clone(),
            expected_version_number: 2,
            source_path: None,
        };
        let intent = fixture.db.file_version_prepare_gui(&prepare).unwrap();
        let seq = fixture.db.committed_change_watermark().unwrap();
        let result = fixture
            .db
            .file_version_commit_gui(&fixture.binding, "open-existing", &intent, false)
            .unwrap();
        assert!(result.no_change);
        assert_eq!(result.version_number, 2);
        assert_eq!(fixture.db.committed_change_watermark().unwrap(), seq);
        fs::write(&fixture.document.managed_path, b"later external edit").unwrap();
        assert!(fixture
            .db
            .file_version_commit_gui(&fixture.binding, "stale-bytes", &intent, true)
            .is_err());
        assert_eq!(
            fs::read(&fixture.document.managed_path).unwrap(),
            b"later external edit"
        );
        prepare.project_id += 1;
        assert!(fixture.db.file_version_prepare_gui(&prepare).is_err());
        prepare.project_id -= 1;
        prepare.managed_path.push_str(".other-workspace");
        assert!(fixture.db.file_version_prepare_gui(&prepare).is_err());
    }
    #[test]
    fn file_version_registered_no_change_has_receipt_without_version_or_event() {
        let bytes = b"\xef\xbb\xbf<script>registered\r\nsource</script>\r\n";
        let mut fixture = registered_fixture(bytes);
        let before = fixture.db.committed_change_watermark().unwrap();
        let receipt = fixture
            .db
            .file_version_update_registered(
                &fixture.request,
                &fixture.binding,
                &fixture.update,
                &fixture.staged,
            )
            .unwrap();
        assert!(receipt.no_change);
        assert_eq!(receipt.version_number, 2);
        assert_eq!(
            fixture
                .db
                .document_record(fixture.document.id)
                .unwrap()
                .version_count,
            2
        );
        assert_eq!(fixture.db.committed_change_watermark().unwrap(), before);
        fs::remove_file(&fixture.staged).unwrap();
        assert_eq!(
            fixture
                .db
                .file_version_update_registered(
                    &fixture.request,
                    &fixture.binding,
                    &fixture.update,
                    &fixture.staged
                )
                .unwrap(),
            receipt
        );
        assert!(!std::path::Path::new(&fixture.document.history_dir_path)
            .join("report_v2.html")
            .exists());
        assert_eq!(
            fs::read_dir(fixture.root.path().join(super::JOURNALS))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn file_version_registered_rejects_changed_bytes_baseline_scope_and_generation() {
        let mut fixture = registered_fixture(b"updated source");
        let before = fixture.db.committed_change_watermark().unwrap();
        let mut wrong = fixture.update.clone();
        wrong.expected_version_number = 1;
        assert_eq!(
            fixture
                .db
                .file_version_update_registered(
                    &fixture.request,
                    &fixture.binding,
                    &wrong,
                    &fixture.staged
                )
                .unwrap_err()
                .code,
            super::ErrorCode::RevisionConflict
        );
        wrong = fixture.update.clone();
        wrong.expected_content_hash = hash(b"wrong baseline");
        assert_eq!(
            fixture
                .db
                .file_version_update_registered(
                    &fixture.request,
                    &fixture.binding,
                    &wrong,
                    &fixture.staged
                )
                .unwrap_err()
                .code,
            super::ErrorCode::RevisionConflict
        );
        wrong = fixture.update.clone();
        wrong.object.scope = crate::agent::models::Scope::Project {
            project_id: fixture.document.project_id + 1,
        };
        assert_eq!(
            fixture
                .db
                .file_version_update_registered(
                    &fixture.request,
                    &fixture.binding,
                    &wrong,
                    &fixture.staged
                )
                .unwrap_err()
                .code,
            super::ErrorCode::ScopeDenied
        );
        let mut binding = fixture.binding.clone();
        binding.generation = "reopened".into();
        assert_eq!(
            fixture
                .db
                .file_version_update_registered(
                    &fixture.request,
                    &binding,
                    &fixture.update,
                    &fixture.staged
                )
                .unwrap_err()
                .code,
            super::ErrorCode::WorkspaceChanged
        );
        fs::write(&fixture.document.managed_path, b"external unknown bytes").unwrap();
        assert_eq!(
            fixture
                .db
                .file_version_update_registered(
                    &fixture.request,
                    &fixture.binding,
                    &fixture.update,
                    &fixture.staged
                )
                .unwrap_err()
                .code,
            super::ErrorCode::FileChangedUnregistered
        );
        assert_eq!(
            fs::read(&fixture.document.managed_path).unwrap(),
            b"external unknown bytes"
        );
        assert_eq!(fixture.db.committed_change_watermark().unwrap(), before);
        assert_eq!(
            fixture
                .db
                .document_record(fixture.document.id)
                .unwrap()
                .current_version_number,
            2
        );
    }

    #[test]
    fn file_version_registered_sql_failure_rolls_back_and_same_request_retries() {
        let mut fixture = registered_fixture(b"updated source");
        let before = fixture.db.committed_change_watermark().unwrap();
        fixture.db.conn.execute_batch("CREATE TRIGGER fail_file_outbox BEFORE INSERT ON agent_change_log WHEN NEW.operation='file.version.commit' BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
        assert_eq!(
            fixture
                .db
                .file_version_update_registered(
                    &fixture.request,
                    &fixture.binding,
                    &fixture.update,
                    &fixture.staged
                )
                .unwrap_err()
                .code,
            super::ErrorCode::IoFailed
        );
        assert_eq!(
            fixture
                .db
                .document_record(fixture.document.id)
                .unwrap()
                .current_version_number,
            2
        );
        assert_eq!(
            hash(&fs::read(&fixture.document.managed_path).unwrap()),
            fixture.update.expected_content_hash
        );
        assert_eq!(fixture.db.committed_change_watermark().unwrap(), before);
        let receipts: i64 = fixture.db.conn.query_row("SELECT count(*) FROM agent_operation_receipts WHERE caller_id='connection:abcdefabcdefabcdefabcdefabcdefab'", [], |row| row.get(0)).unwrap();
        assert_eq!(receipts, 0);
        fixture
            .db
            .conn
            .execute_batch("DROP TRIGGER fail_file_outbox")
            .unwrap();
        assert_eq!(
            fixture
                .db
                .file_version_update_registered(
                    &fixture.request,
                    &fixture.binding,
                    &fixture.update,
                    &fixture.staged
                )
                .unwrap()
                .version_number,
            3
        );
        assert_eq!(fixture.db.committed_change_watermark().unwrap(), before + 1);
    }

    #[test]
    fn file_version_recovery_preserves_foreign_same_byte_collisions() {
        for archive_collision in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let external = tempfile::tempdir().unwrap();
            let (metadata, paths) =
                crate::workspace::create_workspace(root.path(), "password").unwrap();
            let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
            let project = db
                .project_create(ProjectCreateInput {
                    name: "Collision context".into(),
                    summary: None,
                    status: None,
                })
                .unwrap();
            let old_bytes = b"<h1>original</h1>\r\n";
            let new_bytes = b"<script>same new bytes</script>\r\n";
            let original = external.path().join("report.html");
            fs::write(&original, old_bytes).unwrap();
            let document = db
                .document_import_legacy_fixture(DocumentImportInput {
                    project_id: project.id,
                    source_path: original.to_string_lossy().into(),
                    is_starred: false,
                    tag_ids: None,
                })
                .unwrap();
            fs::write(root.path().join("replacement.html"), new_bytes).unwrap();
            let before = db.committed_change_watermark().unwrap();
            drop(db);
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "db::file_versions::tests::file_version_crash_process_fixture",
                    "--ignored",
                ])
                .env("MIND_FILE_VERSION_CRASH_FIXTURE", root.path())
                .env("MIND_FILE_VERSION_CRASH_STAGE", "1")
                .output()
                .unwrap();
            assert_crashed(output.status);
            let directory = fs::read_dir(root.path().join(super::JOURNALS))
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path();
            let journal: super::Journal =
                serde_json::from_slice(&fs::read(directory.join("journal.json")).unwrap()).unwrap();
            let foreign = root.path().join(if archive_collision {
                &journal.archive
            } else {
                &journal.next
            });
            fs::create_dir_all(foreign.parent().unwrap()).unwrap();
            let bytes: &[u8] = if archive_collision {
                old_bytes
            } else {
                new_bytes
            };
            fs::write(&foreign, bytes).unwrap();
            assert!(
                crate::workspace_initialization::open_workspace_database(
                    &paths.db_path,
                    root.path(),
                    None,
                    &metadata.workspace_id,
                )
                .is_err(),
                "foreign collision must remain actionable"
            );
            assert_eq!(
                fs::read(&foreign).unwrap(),
                bytes,
                "recovery must not delete an unrelated file with the same hash"
            );
            assert_eq!(fs::read(&document.managed_path).unwrap(), old_bytes);
            assert!(directory.join("journal.json").exists());
            // Once the caller resolves the collision, the retained journal can
            // finish recovery without a new version or success notification.
            fs::remove_file(foreign).unwrap();
            let opened = crate::workspace_initialization::open_workspace_database(
                &paths.db_path,
                root.path(),
                None,
                &metadata.workspace_id,
            )
            .unwrap();
            assert_eq!(
                opened
                    .db
                    .document_record(document.id)
                    .unwrap()
                    .current_version_number,
                1
            );
            assert_eq!(opened.db.committed_change_watermark().unwrap(), before);
            assert!(!directory.exists());
        }
    }

    #[test]
    fn file_version_database_failure_keeps_head_and_current_bytes_unchanged() {
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let (metadata, paths) =
            crate::workspace::create_workspace(root.path(), "password").unwrap();
        let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
        assert!(!metadata.workspace_id.is_empty());
        let project = db
            .project_create(ProjectCreateInput {
                name: "File context".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let original = external.path().join("report.html");
        fs::write(&original, b"<h1>original</h1>\r\n").unwrap();
        let document = db
            .document_import_legacy_fixture(DocumentImportInput {
                project_id: project.id,
                source_path: original.to_string_lossy().into(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        let next = external.path().join("replacement.html");
        fs::write(&next, b"<script>kept as File source</script>\r\n").unwrap();
        db.conn.execute_batch("CREATE TRIGGER fail_file_version BEFORE INSERT ON document_versions WHEN NEW.version_number=2 BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
        assert!(db
            .document_add_version(DocumentAddVersionInput {
                document_id: document.id,
                source_path: Some(next.to_string_lossy().into())
            })
            .is_err());
        let after = db.document_record(document.id).unwrap();
        assert_eq!(
            after.current_version_number, 1,
            "failed version must not advance the head"
        );
        assert_eq!(after.managed_path, document.managed_path);
        assert_eq!(
            fs::read(&document.managed_path).unwrap(),
            b"<h1>original</h1>\r\n"
        );
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM document_versions WHERE document_id=?1",
                    [document.id],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            fs::read(&next).unwrap(),
            b"<script>kept as File source</script>\r\n"
        );
    }
    #[test]
    #[ignore = "subprocess-only crash fixture, exercised by file_version_recovers_every_process_crash_boundary"]
    fn file_version_crash_process_fixture() {
        let Ok(root) = std::env::var("MIND_FILE_VERSION_CRASH_FIXTURE") else {
            return;
        };
        let root = std::path::Path::new(&root);
        let (_, paths) = crate::workspace::load_metadata(root).unwrap();
        let mut db = Database::open(&paths.db_path, root, None).unwrap();
        let id: i64 = db
            .conn
            .query_row("SELECT id FROM documents", [], |row| row.get(0))
            .unwrap();
        if std::env::var_os("MIND_FILE_VERSION_GUI_CRASH").is_some() {
            let (metadata, _) = crate::workspace::load_metadata(root).unwrap();
            let document = db.document_record(id).unwrap();
            let intent = db
                .file_version_prepare_gui(&super::GuiFileVersionPrepare {
                    document_id: id,
                    project_id: document.project_id,
                    managed_path: document.managed_path,
                    expected_version_number: document.current_version_number as u32,
                    source_path: Some(root.join("picked.html").to_string_lossy().into()),
                })
                .unwrap();
            db.file_version_commit_gui(
                &super::WorkspaceBinding {
                    workspace_id: metadata.workspace_id,
                    generation: "real-open".into(),
                },
                "gui-crash-save",
                &intent,
                false,
            )
            .unwrap();
        } else if std::env::var_os("MIND_FILE_VERSION_REGISTERED_CRASH").is_some() {
            use crate::agent::{
                models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
            };
            let (metadata, _) = crate::workspace::load_metadata(root).unwrap();
            let document = db.document_record(id).unwrap();
            let binding = WorkspaceBinding {
                workspace_id: metadata.workspace_id,
                generation: "real-open".into(),
            };
            db.bind_native_workspace(&binding.workspace_id).unwrap();
            let request = db.agent_connection_authenticate(
                &binding, "abcdefabcdefabcdefabcdefabcdefab",
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                "save-version",
            ).unwrap();
            let staged = root.join(".project-mind/file-content-stage/fixture/bytes.bin");
            let update = super::FileVersionUpdate {
                object: ObjectRef {
                    workspace_id: binding.workspace_id.clone(),
                    scope: Scope::Project {
                        project_id: document.project_id,
                    },
                    kind: ObjectKind::File,
                    id: id.to_string(),
                },
                expected_version_number: 2,
                expected_content_hash: hash(&fs::read(&document.managed_path).unwrap()),
                new_content_hash: hash(&fs::read(&staged).unwrap()),
            };
            let result = db.file_version_update_registered(&request, &binding, &update, &staged);
            if std::env::var_os("MIND_FILE_VERSION_EXPECT_EXTERNAL_CONFLICT").is_some() {
                let error = result.unwrap_err();
                assert_eq!(error.code, super::ErrorCode::FileChangedUnregistered);
                assert_eq!(
                    error.details,
                    Some(serde_json::json!({"recoveryPending":true}))
                );
                return;
            }
            result.unwrap();
        } else {
            db.document_add_version(DocumentAddVersionInput {
                document_id: id,
                source_path: Some(root.join("replacement.html").to_string_lossy().into()),
            })
            .unwrap();
        }
        panic!("crash boundary was not reached");
    }

    #[test]
    fn file_version_gui_recovers_process_crashes_and_retry_once() {
        for stage in 0..=5 {
            let mut fixture = registered_fixture(b"GUI crash-safe bytes");
            let intent = gui_intent(&mut fixture);
            let before = fixture.db.committed_change_watermark().unwrap();
            let root = fixture.root;
            let binding = fixture.binding;
            drop(fixture.db);
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "db::file_versions::tests::file_version_crash_process_fixture",
                    "--ignored",
                ])
                .env("MIND_FILE_VERSION_CRASH_FIXTURE", root.path())
                .env("MIND_FILE_VERSION_GUI_CRASH", "1")
                .env("MIND_FILE_VERSION_CRASH_STAGE", stage.to_string())
                .output()
                .unwrap();
            assert_crashed(output.status);
            let (_, paths) = crate::workspace::load_metadata(root.path()).unwrap();
            let mut db = crate::workspace_initialization::open_workspace_database(
                &paths.db_path,
                root.path(),
                None,
                &binding.workspace_id,
            )
            .unwrap()
            .db;
            assert_eq!(
                db.document_record(intent.document_id)
                    .unwrap()
                    .current_version_number,
                if stage < 5 { 2 } else { 3 }
            );
            let result = db
                .file_version_commit_gui(&binding, "gui-crash-save", &intent, false)
                .unwrap();
            assert_eq!(result.version_number, 3);
            assert_eq!(db.committed_change_watermark().unwrap(), before + 1);
            assert_eq!(db.conn.query_row("SELECT count(*) FROM agent_operation_receipts WHERE request_id='gui-crash-save'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
            assert_eq!(
                fs::read(db.file_version_committed_path(&result).unwrap().unwrap()).unwrap(),
                b"GUI crash-safe bytes"
            );
        }
    }
    #[test]
    fn file_version_gui_two_connections_replay_one_version() {
        let mut fixture = registered_fixture(b"GUI concurrent bytes");
        let intent = gui_intent(&mut fixture);
        let (_, paths) = crate::workspace::load_metadata(fixture.root.path()).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let root = fixture.root.path().to_path_buf();
                let path = paths.db_path.clone();
                let binding = fixture.binding.clone();
                let intent = intent.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let mut db = Database::open(&path, &root, None).unwrap();
                    barrier.wait();
                    db.file_version_commit_gui(&binding, "gui-concurrent", &intent, false)
                        .unwrap()
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results[0], results[1]);
        assert_eq!(
            fixture
                .db
                .document_record(intent.document_id)
                .unwrap()
                .current_version_number,
            3
        );
        assert_eq!(fixture.db.conn.query_row("SELECT count(*) FROM agent_operation_receipts WHERE request_id='gui-concurrent'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }
    #[test]
    fn file_version_gui_no_change_ignores_foreign_next_paths_and_counter_limit() {
        let mut fixture = registered_fixture(b"unused");
        let next =
            std::path::Path::new(&fixture.document.managed_path).with_file_name("report_v3.html");
        fs::write(&next, b"foreign file").unwrap();
        let mut prepare = super::GuiFileVersionPrepare {
            document_id: fixture.document.id,
            project_id: fixture.document.project_id,
            managed_path: fixture.document.managed_path.clone(),
            expected_version_number: 2,
            source_path: None,
        };
        let intent = fixture.db.file_version_prepare_gui(&prepare).unwrap();
        assert!(
            fixture
                .db
                .file_version_commit_gui(&fixture.binding, "foreign-next-no-change", &intent, false)
                .unwrap()
                .no_change
        );
        assert_eq!(fs::read(next).unwrap(), b"foreign file");
        fixture
            .db
            .conn
            .execute(
                "UPDATE documents SET current_version_number=?2 WHERE id=?1",
                rusqlite::params![prepare.document_id, u32::MAX],
            )
            .unwrap();
        fixture.db.conn.execute("UPDATE document_versions SET version_number=?2 WHERE document_id=?1 AND version_number=2", rusqlite::params![prepare.document_id, u32::MAX]).unwrap();
        prepare.expected_version_number = u32::MAX;
        let intent = fixture.db.file_version_prepare_gui(&prepare).unwrap();
        let receipt = fixture
            .db
            .file_version_commit_gui(&fixture.binding, "max-no-change", &intent, false)
            .unwrap();
        assert!(receipt.no_change);
        assert_eq!(receipt.version_number, i64::from(u32::MAX));
    }
    #[test]
    fn file_version_gui_outbox_failure_rolls_back_and_archive_refuses_commit() {
        let mut fixture = registered_fixture(b"GUI rollback bytes");
        let intent = gui_intent(&mut fixture);
        let before = fixture.db.committed_change_watermark().unwrap();
        let old_bytes = fs::read(&intent.managed_path).unwrap();
        fixture.db.conn.execute_batch("CREATE TRIGGER fail_gui_file_outbox BEFORE INSERT ON agent_change_log WHEN NEW.operation='file.version.commit' BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END;").unwrap();
        assert!(fixture
            .db
            .file_version_commit_gui(&fixture.binding, "gui-rollback", &intent, false)
            .is_err());
        assert_eq!(fixture.db.committed_change_watermark().unwrap(), before);
        assert_eq!(
            fixture
                .db
                .document_record(intent.document_id)
                .unwrap()
                .current_version_number,
            2
        );
        assert_eq!(fs::read(&intent.managed_path).unwrap(), old_bytes);
        assert_eq!(
            fixture
                .db
                .conn
                .query_row(
                    "SELECT count(*) FROM agent_operation_receipts WHERE request_id='gui-rollback'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        fixture
            .db
            .conn
            .execute_batch("DROP TRIGGER fail_gui_file_outbox")
            .unwrap();
        fixture
            .db
            .project_set_archive(crate::models::ProjectArchiveInput {
                project_id: intent.project_id,
                is_archived: true,
            })
            .unwrap();
        assert_eq!(
            fixture
                .db
                .file_version_commit_gui(&fixture.binding, "gui-archived", &intent, false)
                .unwrap_err()
                .code,
            super::ErrorCode::ScopeDenied
        );
        assert_eq!(fs::read(&intent.managed_path).unwrap(), old_bytes);
    }
    #[test]
    fn file_version_gui_rejects_changed_source_and_preserves_unknown_old_hash() {
        let mut fixture = registered_fixture(b"GUI selected bytes");
        let intent = gui_intent(&mut fixture);
        fs::write(&fixture.staged, b"changed selection").unwrap();
        assert_eq!(
            fixture
                .db
                .file_version_commit_gui(&fixture.binding, "source-changed", &intent, false)
                .unwrap_err()
                .code,
            super::ErrorCode::SourceChanged
        );
        assert_eq!(
            fixture
                .db
                .document_record(intent.document_id)
                .unwrap()
                .current_version_number,
            2
        );
        fixture.db.conn.execute("DELETE FROM source_file_version_hashes WHERE document_version_id IN (SELECT id FROM document_versions WHERE document_id=?1)", [intent.document_id]).unwrap();
        let intent = fixture
            .db
            .file_version_prepare_gui(&super::GuiFileVersionPrepare {
                document_id: intent.document_id,
                project_id: intent.project_id,
                managed_path: intent.managed_path,
                expected_version_number: 2,
                source_path: None,
            })
            .unwrap();
        assert!(intent.registered_content_hash.is_none());
        assert_eq!(
            fixture
                .db
                .file_version_commit_gui(&fixture.binding, "unknown-declined", &intent, false)
                .unwrap_err()
                .code,
            super::ErrorCode::FileChangedUnregistered
        );
        let receipt = fixture
            .db
            .file_version_commit_gui(&fixture.binding, "unknown-accepted", &intent, true)
            .unwrap();
        assert_eq!(receipt.version_number, 3);
        assert!(!receipt.no_change);
        assert_eq!(fixture.db.conn.query_row("SELECT count(*) FROM source_file_version_hashes h JOIN document_versions v ON h.document_version_id=v.id WHERE v.document_id=?1 AND v.version_number<3", [intent.document_id], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }
    #[test]
    fn file_version_registered_recovers_process_crashes_and_retry_once() {
        for stage in 0..=5 {
            let new_bytes = b"\xef\xbb\xbf<script>crash-safe\r\nnew version</script>\r\n";
            let fixture = registered_fixture(new_bytes);
            let before = fixture.db.committed_change_watermark().unwrap();
            let root = fixture.root;
            let document = fixture.document;
            let update = fixture.update;
            let request = fixture.request;
            let binding = fixture.binding;
            let staged = fixture.staged;
            drop(fixture.db);
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "db::file_versions::tests::file_version_crash_process_fixture",
                    "--ignored",
                ])
                .env("MIND_FILE_VERSION_CRASH_FIXTURE", root.path())
                .env("MIND_FILE_VERSION_REGISTERED_CRASH", "1")
                .env("MIND_FILE_VERSION_CRASH_STAGE", stage.to_string())
                .output()
                .unwrap();
            assert_crashed(output.status);
            let (_, paths) = crate::workspace::load_metadata(root.path()).unwrap();
            let mut db = crate::workspace_initialization::open_workspace_database(
                &paths.db_path,
                root.path(),
                None,
                &binding.workspace_id,
            )
            .unwrap()
            .db;
            let recovered = db.document_record(document.id).unwrap();
            assert_eq!(
                recovered.current_version_number,
                if stage < 5 { 2 } else { 3 }
            );
            assert_eq!(
                hash(&fs::read(&recovered.managed_path).unwrap()),
                if stage < 5 {
                    update.expected_content_hash.clone()
                } else {
                    update.new_content_hash.clone()
                }
            );
            assert_eq!(
                db.committed_change_watermark().unwrap(),
                before + i64::from(stage == 5)
            );
            let receipt = db
                .file_version_update_registered(&request, &binding, &update, &staged)
                .unwrap();
            assert_eq!(receipt.version_number, 3);
            assert!(!receipt.no_change);
            assert_eq!(db.document_record(document.id).unwrap().version_count, 3);
            assert_eq!(
                db.committed_change_watermark().unwrap(),
                before + 1,
                "recovery/retry must commit at most one event"
            );
            let receipts:i64 = db.conn.query_row("SELECT count(*) FROM agent_operation_receipts WHERE caller_id='connection:abcdefabcdefabcdefabcdefabcdefab' AND request_id='save-version'", [], |row| row.get(0)).unwrap();
            assert_eq!(receipts, 1);
            let old = db
                .fetch_document_versions(document.id)
                .unwrap()
                .into_iter()
                .find(|version| version.version_number == 2)
                .unwrap();
            assert_eq!(
                hash(&fs::read(old.managed_path).unwrap()),
                update.expected_content_hash
            );
            assert_eq!(fs::read(staged).unwrap(), new_bytes);
            assert_eq!(
                fs::read_dir(root.path().join(super::JOURNALS))
                    .unwrap()
                    .count(),
                0
            );
        }
    }

    #[test]
    fn file_version_recovery_waits_for_live_staging_lock() {
        let fixture = registered_fixture(b"new bytes");
        let directory = fixture.root.path().join(super::JOURNALS).join(format!(
            "{}-{}",
            fixture.document.id,
            "1".repeat(32)
        ));
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("new.bin"), b"live staging").unwrap();
        let guard = fixture.db.file_version_lock(fixture.document.id).unwrap();
        let root = fixture.root.path().to_path_buf();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(move || {
            let (_, paths) = crate::workspace::load_metadata(&root).unwrap();
            let db = Database::open(&paths.db_path, &root, None).unwrap();
            started_tx.send(()).unwrap();
            done_tx.send(db.file_version_recover_pending()).unwrap();
        });
        started_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert!(matches!(
            done_rx.recv_timeout(std::time::Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        assert_eq!(
            fs::read(directory.join("new.bin")).unwrap(),
            b"live staging"
        );
        drop(guard);
        done_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .unwrap();
        handle.join().unwrap();
        assert!(!directory.exists());
    }

    #[test]
    fn file_version_registered_staging_bounds_and_hash_fail_before_mutation() {
        let mut fixture = registered_fixture(b"new bytes");
        let before = fixture.db.committed_change_watermark().unwrap();
        fs::write(&fixture.staged, b"different staged bytes").unwrap();
        assert_eq!(
            fixture
                .db
                .file_version_update_registered(
                    &fixture.request,
                    &fixture.binding,
                    &fixture.update,
                    &fixture.staged
                )
                .unwrap_err()
                .code,
            super::ErrorCode::SourceChanged
        );
        assert_eq!(
            fixture
                .db
                .document_record(fixture.document.id)
                .unwrap()
                .current_version_number,
            2
        );
        let outside = fixture.root.path().join("outside.bin");
        fs::write(&outside, b"new bytes").unwrap();
        assert_eq!(
            fixture
                .db
                .file_version_update_registered(
                    &fixture.request,
                    &fixture.binding,
                    &fixture.update,
                    &outside
                )
                .unwrap_err()
                .code,
            super::ErrorCode::InvalidArgument
        );
        let output = fs::OpenOptions::new()
            .write(true)
            .open(&fixture.staged)
            .unwrap();
        output.set_len(100 * 1024 * 1024 + 1).unwrap();
        drop(output);
        assert_eq!(
            fixture
                .db
                .file_version_update_registered(
                    &fixture.request,
                    &fixture.binding,
                    &fixture.update,
                    &fixture.staged
                )
                .unwrap_err()
                .code,
            super::ErrorCode::BudgetExceeded
        );
        assert_eq!(fixture.db.committed_change_watermark().unwrap(), before);
        assert_eq!(
            hash(&fs::read(&fixture.document.managed_path).unwrap()),
            fixture.update.expected_content_hash
        );
    }

    #[test]
    fn file_version_registered_concurrent_same_request_has_one_commit() {
        let bytes = vec![b'x'; 2 * 1024 * 1024];
        let fixture = registered_fixture(&bytes);
        let before = fixture.db.committed_change_watermark().unwrap();
        drop(fixture.db);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let mut handles = Vec::new();
        for _ in 0..2 {
            let root = fixture.root.path().to_path_buf();
            let binding = fixture.binding.clone();
            let request = fixture.request.clone();
            let update = fixture.update.clone();
            let staged = fixture.staged.clone();
            let barrier = barrier.clone();
            // Initialize connections before the barrier; the concurrent seam
            // under test is the File commit, not Workspace startup migrations.
            let (_, paths) = crate::workspace::load_metadata(&root).unwrap();
            let mut db = Database::open(&paths.db_path, &root, None).unwrap();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                db.file_version_update_registered(&request, &binding, &update, &staged)
            }));
        }
        barrier.wait();
        let receipts: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap().unwrap())
            .collect();
        assert_eq!(receipts[0], receipts[1]);
        assert_eq!(receipts[0].version_number, 3);
        let (_, paths) = crate::workspace::load_metadata(fixture.root.path()).unwrap();
        let db = crate::workspace_initialization::open_workspace_database(
            &paths.db_path,
            fixture.root.path(),
            None,
            &fixture.binding.workspace_id,
        )
        .unwrap()
        .db;
        assert_eq!(
            db.document_record(fixture.document.id)
                .unwrap()
                .version_count,
            3
        );
        assert_eq!(db.committed_change_watermark().unwrap(), before + 1);
    }

    #[test]
    fn file_version_project_writes_wait_and_preserve_authoritative_paths() {
        for action in ["rename", "archive", "delete"] {
            let mut fixture = registered_fixture(b"new bytes");
            let guard = fixture
                .db
                .file_project_lock(fixture.document.project_id, false)
                .unwrap();
            let root = fixture.root.path().to_path_buf();
            let project_id = fixture.document.project_id;
            let (started_tx, started_rx) = std::sync::mpsc::channel();
            let (done_tx, done_rx) = std::sync::mpsc::channel();
            let handle = std::thread::spawn(move || {
                let (_, paths) = crate::workspace::load_metadata(&root).unwrap();
                let mut db = Database::open(&paths.db_path, &root, None).unwrap();
                started_tx.send(()).unwrap();
                let result = match action {
                    "rename" => db.project_update(crate::models::ProjectUpdateInput {
                        project_id,
                        name: Some("Renamed context".into()),
                        summary: String::new(),
                        summary_markdown: None,
                        summary_html: None,
                        summary_code_language: None,
                        status: None,
                    }),
                    "archive" => db.project_set_archive(crate::models::ProjectArchiveInput {
                        project_id,
                        is_archived: true,
                    }),
                    _ => db.project_delete(crate::models::ProjectDeleteInput { project_id }),
                };
                done_tx.send(result).unwrap();
            });
            started_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            assert!(matches!(
                done_rx.recv_timeout(std::time::Duration::from_millis(100)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ));
            assert_eq!(
                hash(&fs::read(&fixture.document.managed_path).unwrap()),
                fixture.update.expected_content_hash
            );
            assert!(!fixture.db.project_record(project_id).unwrap().is_archived);
            drop(guard);
            let project = done_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap()
                .unwrap();
            handle.join().unwrap();
            let result = fixture.db.file_version_update_registered(
                &fixture.request,
                &fixture.binding,
                &fixture.update,
                &fixture.staged,
            );
            match action {
                "rename" => {
                    assert_eq!(result.unwrap().version_number, 3);
                    let current = fixture.db.document_record(fixture.document.id).unwrap();
                    assert!(
                        std::path::Path::new(&current.managed_path).starts_with(&project.root_path)
                    );
                    let old = fixture
                        .db
                        .fetch_document_versions(current.id)
                        .unwrap()
                        .into_iter()
                        .find(|version| version.version_number == 2)
                        .unwrap();
                    assert!(std::path::Path::new(&old.managed_path).starts_with(&project.root_path));
                    assert_eq!(
                        hash(&fs::read(old.managed_path).unwrap()),
                        fixture.update.expected_content_hash
                    );
                }
                "archive" => assert_eq!(result.unwrap_err().code, super::ErrorCode::ScopeDenied),
                _ => assert_eq!(result.unwrap_err().code, super::ErrorCode::NotFound),
            }
        }
    }

    #[test]
    fn file_version_registered_never_promotes_unknown_existing_bytes() {
        let mut fixture = registered_fixture(b"new bytes");
        let source = fixture.root.path().join("unknown-existing.html");
        fs::write(&source, b"unknown current bytes").unwrap();
        let unknown = fixture
            .db
            .document_import_legacy_fixture(DocumentImportInput {
                project_id: fixture.document.project_id,
                source_path: source.to_string_lossy().into(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        let mut update = fixture.update.clone();
        update.object.id = unknown.id.to_string();
        update.expected_version_number = 1;
        update.expected_content_hash = hash(b"unknown current bytes");
        let before = fixture.db.committed_change_watermark().unwrap();
        assert_eq!(
            fixture
                .db
                .file_version_update_registered(
                    &fixture.request,
                    &fixture.binding,
                    &update,
                    &fixture.staged
                )
                .unwrap_err()
                .code,
            super::ErrorCode::FileChangedUnregistered
        );
        assert_eq!(
            fixture
                .db
                .document_record(unknown.id)
                .unwrap()
                .current_version_number,
            1
        );
        assert_eq!(
            fs::read(unknown.managed_path).unwrap(),
            b"unknown current bytes"
        );
        let hashes:i64 = fixture.db.conn.query_row("SELECT count(*) FROM source_file_version_hashes h JOIN document_versions v ON v.id=h.document_version_id WHERE v.document_id=?1", [unknown.id], |row| row.get(0)).unwrap();
        assert_eq!(hashes, 0);
        assert_eq!(fixture.db.committed_change_watermark().unwrap(), before);
    }

    #[test]
    fn file_version_registered_preserves_external_edit_after_journal_preparation() {
        let fixture = registered_fixture(b"new version bytes");
        let before = fixture.db.committed_change_watermark().unwrap();
        drop(fixture.db);
        let ready = fixture.root.path().join("ready.marker");
        let resume = fixture.root.path().join("resume.marker");
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "db::file_versions::tests::file_version_crash_process_fixture",
                "--ignored",
            ])
            .env("MIND_FILE_VERSION_CRASH_FIXTURE", fixture.root.path())
            .env("MIND_FILE_VERSION_REGISTERED_CRASH", "1")
            .env("MIND_FILE_VERSION_EXPECT_EXTERNAL_CONFLICT", "1")
            .env("MIND_FILE_VERSION_PAUSE_STAGE", "1")
            .env("MIND_FILE_VERSION_READY", &ready)
            .env("MIND_FILE_VERSION_RESUME", &resume)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !ready.exists() {
            if child.try_wait().unwrap().is_some() || std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let output = child.wait_with_output().unwrap();
                panic!(
                    "File preparation handshake failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let user_bytes = b"external edit after read; must not be overwritten";
        fs::write(&fixture.document.managed_path, user_bytes).unwrap();
        fs::write(&resume, b"resume").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let (_, paths) = crate::workspace::load_metadata(fixture.root.path()).unwrap();
        let db = Database::open(&paths.db_path, fixture.root.path(), None).unwrap();
        assert_eq!(
            db.document_record(fixture.document.id)
                .unwrap()
                .current_version_number,
            2
        );
        assert_eq!(
            fs::read(&fixture.document.managed_path).unwrap(),
            user_bytes
        );
        assert_eq!(db.committed_change_watermark().unwrap(), before);
        assert_eq!(fs::read(&fixture.staged).unwrap(), b"new version bytes");
        assert_eq!(
            fs::read_dir(fixture.root.path().join(super::JOURNALS))
                .unwrap()
                .count(),
            1
        );
        assert!(
            db.file_version_recover_pending().is_err(),
            "unregistered user bytes need explicit conflict resolution"
        );
        assert_eq!(
            fs::read(&fixture.document.managed_path).unwrap(),
            user_bytes
        );
    }
    #[test]
    fn file_version_recovers_every_process_crash_boundary() {
        for stage in 0..=5 {
            let root = tempfile::tempdir().unwrap();
            let external = tempfile::tempdir().unwrap();
            let (metadata, paths) =
                crate::workspace::create_workspace(root.path(), "password").unwrap();
            let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
            let project = db
                .project_create(ProjectCreateInput {
                    name: "Crash context".into(),
                    summary: None,
                    status: None,
                })
                .unwrap();
            let original = external.path().join("report.html");
            fs::write(&original, b"<h1>original</h1>\r\n").unwrap();
            let document = db
                .document_import_legacy_fixture(DocumentImportInput {
                    project_id: project.id,
                    source_path: original.to_string_lossy().into(),
                    is_starred: false,
                    tag_ids: None,
                })
                .unwrap();
            let new_bytes = b"<script>kept as File source</script>\r\n";
            fs::write(root.path().join("replacement.html"), new_bytes).unwrap();
            let before = db.committed_change_watermark().unwrap();
            drop(db);
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "db::file_versions::tests::file_version_crash_process_fixture",
                    "--ignored",
                    "--nocapture",
                ])
                .env("MIND_FILE_VERSION_CRASH_FIXTURE", root.path())
                .env("MIND_FILE_VERSION_CRASH_STAGE", stage.to_string())
                .output()
                .unwrap();
            eprintln!(
                "File version crash stage {stage}: {}; stdout: {}; stderr: {}",
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert_crashed(output.status);
            let opened = crate::workspace_initialization::open_workspace_database(
                &paths.db_path,
                root.path(),
                None,
                &metadata.workspace_id,
            )
            .unwrap();
            let db = opened.db;
            let after = db.document_record(document.id).unwrap();
            if stage < 5 {
                assert_eq!(after.current_version_number, 1, "stage {stage}");
                assert_eq!(
                    fs::read(&after.managed_path).unwrap(),
                    b"<h1>original</h1>\r\n"
                );
                assert_eq!(db.committed_change_watermark().unwrap(), before);
                assert_eq!(
                    db.conn
                        .query_row("SELECT count(*) FROM document_versions", [], |row| row
                            .get::<_, i64>(0))
                        .unwrap(),
                    1
                );
            } else {
                assert_eq!(after.current_version_number, 2);
                assert_eq!(after.id, document.id);
                assert_eq!(fs::read(&after.managed_path).unwrap(), new_bytes);
                let versions = db.fetch_document_versions(document.id).unwrap();
                assert_eq!(versions.len(), 2);
                let old = versions
                    .iter()
                    .find(|version| version.version_number == 1)
                    .unwrap();
                assert_eq!(
                    fs::read(&old.managed_path).unwrap(),
                    b"<h1>original</h1>\r\n"
                );
                let known_old:i64=db.conn.query_row("SELECT count(*) FROM source_file_version_hashes WHERE document_version_id=?1",[old.id],|row|row.get(0)).unwrap();
                assert_eq!(
                    known_old, 0,
                    "unknown old bytes must not become registered history"
                );
                let new = versions
                    .iter()
                    .find(|version| version.version_number == 2)
                    .unwrap();
                let hash:String=db.conn.query_row("SELECT content_hash FROM source_file_version_hashes WHERE document_version_id=?1",[new.id],|row|row.get(0)).unwrap();
                assert_eq!(
                    hash,
                    format!("sha256:{:x}", sha2::Sha256::digest(new_bytes))
                );
                assert_eq!(db.committed_change_watermark().unwrap(), before + 1);
                assert_eq!(db.conn.query_row("SELECT count(*) FROM agent_operation_receipts WHERE operation='file.version.commit'",[],|row|row.get::<_,i64>(0)).unwrap(),1);
            }
            assert_eq!(
                fs::read(root.path().join("replacement.html")).unwrap(),
                new_bytes
            );
            assert_eq!(
                fs::read_dir(root.path().join(super::JOURNALS))
                    .unwrap()
                    .count(),
                0
            );
            db.file_version_recover_pending().unwrap();
            assert_eq!(
                db.document_record(document.id)
                    .unwrap()
                    .current_version_number,
                after.current_version_number
            );
        }
    }
}
