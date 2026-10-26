//! Bounded bytes for a server-resolved, hash-registered File Version. This
//! kernel grants no access; the shared source service must resolve ownership
//! and current policy before capture, then recheck its binding and version.
use crate::agent::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef},
};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata},
    io::Read,
    path::{Path, PathBuf},
    time::SystemTime,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FileSourceFormat {
    Text,
    Markdown,
    Html,
    Pdf,
}
impl FileSourceFormat {
    pub(crate) fn byte_limit(self) -> usize {
        if matches!(self, Self::Pdf) {
            50 * 1024 * 1024
        } else {
            10 * 1024 * 1024
        }
    }
    pub(crate) fn worker_format(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Markdown => "markdown",
            Self::Html => "html",
            Self::Pdf => "pdf",
        }
    }
}
/// Deliberately not Deserialize. A tool cannot supply paths or mint registered
/// version hashes; the authoritative File repository constructs this plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileReadPlan {
    pub object: ObjectRef,
    pub file_version: u32,
    pub registered_hash: String,
    pub title: String,
    pub updated_at: String,
    pub path: PathBuf,
    pub format: FileSourceFormat,
}
#[derive(Debug)]
pub(crate) struct FileByteSnapshot {
    pub bytes: Vec<u8>,
    pub revision: String,
    plan: FileReadPlan,
    stamp: FileStamp,
    cache_permit: Option<tokio::sync::OwnedSemaphorePermit>,
    cache_active: std::sync::Arc<std::sync::atomic::AtomicBool>,
    cache_scope_active: std::sync::Arc<std::sync::atomic::AtomicBool>,
    text_offsets: std::sync::OnceLock<AgentResult<TextOffsets>>,
}
/// A byte verification receipt contains no source body. Search may retain a
/// bounded set of these without retaining up to 50 whole PDF byte buffers.
#[derive(Debug, Clone)]
pub(crate) struct FileVerification {
    revision: String,
    plan: FileReadPlan,
    stamp: FileStamp,
}
#[derive(Debug)]
struct TextOffsets {
    text: String,
    total: usize,
    checkpoints: Vec<(usize, usize)>,
}
impl FileByteSnapshot {
    /// Sparse Unicode offsets avoid a full count and prefix scan for every
    /// raw source page. At most 1023 characters are scanned after a lookup.
    pub(crate) fn text_position(&self, offset: usize) -> AgentResult<(&str, usize, usize)> {
        let index = self
            .text_offsets
            .get_or_init(|| {
                let text = std::str::from_utf8(&self.bytes).map_err(|_| {
                    AgentError::new(
                        ErrorCode::SourceNotReady,
                        "Registered File source is not valid UTF-8",
                    )
                })?;
                let mut checkpoints = Vec::new();
                let mut total = 0;
                for (character, (byte, _)) in text.char_indices().enumerate() {
                    if character % 1024 == 0 {
                        checkpoints.push((character, byte));
                    }
                    total = character + 1;
                }
                if checkpoints.is_empty() {
                    checkpoints.push((0, 0));
                }
                if total > 0 && total % 1024 == 0 {
                    checkpoints.push((total, text.len()));
                }
                Ok(TextOffsets {
                    text: text.to_owned(),
                    total,
                    checkpoints,
                })
            })
            .as_ref()
            .map_err(Clone::clone)?;
        if offset > index.total {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid fixed File source page",
            ));
        }
        let text = index.text.as_str();
        let &(base, byte) = &index.checkpoints[(offset / 1024).min(index.checkpoints.len() - 1)];
        let start = text[byte..]
            .char_indices()
            .nth(offset - base)
            .map(|(at, _)| byte + at)
            .unwrap_or(text.len());
        Ok((text, index.total, start))
    }
    pub(crate) fn cache_is_active(&self) -> bool {
        self.cache_active.load(std::sync::atomic::Ordering::Acquire)
            && self
                .cache_scope_active
                .load(std::sync::atomic::Ordering::Acquire)
    }
    pub(crate) fn verification(&self) -> FileVerification {
        FileVerification {
            revision: self.revision.clone(),
            plan: self.plan.clone(),
            stamp: self.stamp.clone(),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileStamp {
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    changed: (i64, i64),
    #[cfg(windows)]
    created: u64,
}
impl FileStamp {
    pub(crate) fn from_metadata(metadata: &Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        #[cfg(windows)]
        use std::os::windows::fs::MetadataExt;
        Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
            #[cfg(unix)]
            changed: (metadata.ctime(), metadata.ctime_nsec()),
            #[cfg(windows)]
            created: metadata.creation_time(),
        }
    }
}
fn changed() -> AgentError {
    AgentError::new(
        ErrorCode::SourceChanged,
        "File bytes differ from their registered version; register a new version before reading",
    )
    .with_details(serde_json::json!({"state":"changed_unregistered"}))
}
fn io_error(error: std::io::Error) -> AgentError {
    if error.kind() == std::io::ErrorKind::NotFound {
        AgentError::new(
            ErrorCode::SourceNotReady,
            "Registered File bytes are missing",
        )
        .with_details(serde_json::json!({"state":"missing"}))
    } else {
        AgentError::new(ErrorCode::IoFailed, "Cannot read registered File bytes")
    }
}
fn regular(metadata: &Metadata) -> AgentResult<FileStamp> {
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(changed());
    }
    Ok(FileStamp::from_metadata(metadata))
}
#[cfg(unix)]
pub(crate) fn open_regular(path: &Path) -> AgentResult<File> {
    use rustix::fs::{open, Mode, OFlags};
    // NOFOLLOW rejects a last-component symlink swap; NONBLOCK prevents a
    // swapped FIFO from blocking open before the handle type can be checked.
    open(
        path,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|error| io_error(error.into()))
}
#[cfg(windows)]
pub(crate) fn open_regular(path: &Path) -> AgentResult<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(io_error)
}
#[cfg(not(any(unix, windows)))]
pub(crate) fn open_regular(_path: &Path) -> AgentResult<File> {
    Err(AgentError::new(
        ErrorCode::RuntimeUnavailable,
        "File snapshots are unsupported on this platform",
    ))
}
fn capture_sync(plan: &FileReadPlan) -> AgentResult<FileByteSnapshot> {
    capture_sync_bounded(plan, plan.format.byte_limit())
}
pub(crate) fn capture_file_update(plan: &FileReadPlan) -> AgentResult<FileByteSnapshot> {
    capture_sync_bounded(plan, crate::file_text_patch::MAX_FILE_BYTES).map_err(|mut error| {
        if error.code == ErrorCode::SourceChanged {
            error.code = ErrorCode::FileChangedUnregistered;
        }
        error
    })
}
#[cfg(test)]
static CAPTURE_COUNTS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<PathBuf, usize>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
#[cfg(test)]
pub(crate) fn capture_count(path: &Path) -> usize {
    CAPTURE_COUNTS
        .lock()
        .unwrap()
        .get(path)
        .copied()
        .unwrap_or(0)
}
fn capture_sync_bounded(plan: &FileReadPlan, limit: usize) -> AgentResult<FileByteSnapshot> {
    plan.object.key()?;
    if plan.object.kind != ObjectKind::File
        || !plan
            .object
            .id
            .parse::<i64>()
            .ok()
            .is_some_and(|id| id > 0 && id.to_string() == plan.object.id)
        || plan.file_version == 0
        || !plan.path.is_absolute()
        || plan.registered_hash.len() != 71
        || !plan.registered_hash.starts_with("sha256:")
        || !plan.registered_hash.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Invalid server-resolved File snapshot plan",
        ));
    }
    let path_stamp = regular(&fs::symlink_metadata(&plan.path).map_err(io_error)?)?;
    if path_stamp.len > limit as u64 {
        return Err(AgentError::new(
            ErrorCode::BudgetExceeded,
            "File exceeds its extraction byte limit",
        )
        .with_details(serde_json::json!({"state":"too_large"})));
    }
    let mut file = open_regular(&plan.path)?;
    let opened = regular(&file.metadata().map_err(io_error)?)?;
    if opened != path_stamp {
        return Err(changed());
    }
    #[cfg(test)]
    {
        *CAPTURE_COUNTS
            .lock()
            .unwrap()
            .entry(plan.path.clone())
            .or_default() += 1;
    }
    let mut bytes = Vec::with_capacity(opened.len as usize);
    file.by_ref()
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() > limit {
        return Err(AgentError::new(
            ErrorCode::BudgetExceeded,
            "File exceeds its extraction byte limit",
        )
        .with_details(serde_json::json!({"state":"too_large"})));
    }
    let revision = format!("sha256:{:x}", Sha256::digest(&bytes));
    let after = regular(&file.metadata().map_err(io_error)?)?;
    let current = regular(&fs::symlink_metadata(&plan.path).map_err(io_error)?)?;
    if revision != plan.registered_hash
        || after != opened
        || current != opened
        || bytes.len() as u64 != opened.len
    {
        return Err(changed());
    }
    Ok(FileByteSnapshot {
        bytes,
        revision,
        plan: plan.clone(),
        stamp: current,
        cache_permit: None,
        cache_active: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
        cache_scope_active: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
        text_offsets: std::sync::OnceLock::new(),
    })
}
pub(crate) async fn capture_file(plan: &FileReadPlan) -> AgentResult<FileByteSnapshot> {
    let plan = plan.clone();
    tokio::task::spawn_blocking(move || capture_sync(&plan))
        .await
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "File snapshot task failed"))?
}
/// Created while the caller holds its current authorized binding. Closing the
/// Workspace invalidates this token even if no cache entry existed yet.
pub(crate) struct FileReadScope {
    binding: crate::agent::models::WorkspaceBinding,
    active: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
static FILE_SCOPES: std::sync::LazyLock<
    std::sync::Mutex<std::collections::VecDeque<std::sync::Arc<FileReadScope>>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::VecDeque::new()));
pub(crate) fn file_read_scope(
    binding: &crate::agent::models::WorkspaceBinding,
) -> AgentResult<std::sync::Arc<FileReadScope>> {
    let mut scopes = FILE_SCOPES.lock().map_err(|_| cache_busy())?;
    scopes.retain(|scope| {
        let keep = scope.binding.workspace_id != binding.workspace_id || scope.binding == *binding;
        if !keep {
            scope
                .active
                .store(false, std::sync::atomic::Ordering::Release);
        }
        keep
    });
    if let Some(scope) = scopes.iter().find(|scope| scope.binding == *binding) {
        return Ok(scope.clone());
    }
    if scopes.len() == 16 {
        let index = scopes
            .iter()
            .position(|scope| std::sync::Arc::strong_count(scope) == 1)
            .ok_or_else(cache_busy)?;
        scopes[index]
            .active
            .store(false, std::sync::atomic::Ordering::Release);
        scopes.remove(index);
    }
    let scope = std::sync::Arc::new(FileReadScope {
        binding: binding.clone(),
        active: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
    });
    scopes.push_back(scope.clone());
    Ok(scope)
}
// These caches grant no access. Callers resolve a fresh authorized plan before
// lookup and recheck it after asynchronous work. File stamps are the same
// proof already used by verify_file_receipt; Windows always reads and hashes.
const SNAPSHOT_ENTRIES: usize = 128;
const SNAPSHOT_BYTES: usize = 256 * 1024 * 1024;
const CACHE_IDLE: std::time::Duration = std::time::Duration::from_secs(60);
static SNAPSHOT_QUOTA: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(SNAPSHOT_BYTES)));
#[derive(Default)]
struct SnapshotState {
    bytes: Option<std::sync::Arc<FileByteSnapshot>>,
    receipt: Option<FileVerification>,
}
struct ScopedSnapshot {
    binding: crate::agent::models::WorkspaceBinding,
    plan: FileReadPlan,
    state: tokio::sync::Mutex<SnapshotState>,
    active: std::sync::Arc<std::sync::atomic::AtomicBool>,
    scope_active: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
static SNAPSHOTS: std::sync::LazyLock<
    std::sync::Mutex<
        std::collections::VecDeque<(std::time::Instant, std::sync::Arc<ScopedSnapshot>)>,
    >,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::VecDeque::new()));
fn cache_busy() -> AgentError {
    AgentError::new(
        ErrorCode::RunBusy,
        "Source snapshot cache is at its active byte or entry budget",
    )
}
pub(crate) fn invalidate_file_cache(
    binding: &crate::agent::models::WorkspaceBinding,
    object: &ObjectRef,
) {
    if let Ok(mut entries) = SNAPSHOTS.lock() {
        entries.retain(|(_, entry)| {
            let keep = &entry.binding != binding || &entry.plan.object != object;
            if !keep {
                entry
                    .active
                    .store(false, std::sync::atomic::Ordering::Release);
            }
            keep
        });
    }
}
pub(crate) fn clear_binding(binding: &crate::agent::models::WorkspaceBinding) {
    if let Ok(mut scopes) = FILE_SCOPES.lock() {
        scopes.retain(|scope| {
            if scope.binding == *binding {
                scope
                    .active
                    .store(false, std::sync::atomic::Ordering::Release);
                false
            } else {
                true
            }
        });
    }
    if let Ok(mut entries) = SNAPSHOTS.lock() {
        entries.retain(|(_, entry)| {
            if &entry.binding == binding {
                entry
                    .active
                    .store(false, std::sync::atomic::Ordering::Release);
                false
            } else {
                true
            }
        });
    }
}
fn scoped_snapshot(
    scope: &FileReadScope,
    plan: &FileReadPlan,
) -> AgentResult<std::sync::Arc<ScopedSnapshot>> {
    let binding = &scope.binding;
    if binding.workspace_id != plan.object.workspace_id || binding.generation.is_empty() {
        return Err(AgentError::new(
            ErrorCode::WorkspaceChanged,
            "Source cache requires its current Workspace generation",
        ));
    }
    let mut entries = SNAPSHOTS.lock().map_err(|_| cache_busy())?;
    if !scope.active.load(std::sync::atomic::Ordering::Acquire) {
        return Err(AgentError::new(
            ErrorCode::WorkspaceChanged,
            "Source read generation closed before capture",
        ));
    }
    let now = std::time::Instant::now();
    entries.retain(|(used, entry)| {
        // A different generation can never reuse old data, including when the
        // same Workspace was reopened with an identical on-disk path.
        let same_generation =
            entry.binding.workspace_id != binding.workspace_id || entry.binding == *binding;
        if !same_generation {
            entry
                .active
                .store(false, std::sync::atomic::Ordering::Release);
        }
        same_generation
            && entry.active.load(std::sync::atomic::Ordering::Acquire)
            && entry
                .scope_active
                .load(std::sync::atomic::Ordering::Acquire)
            && (now.duration_since(*used) < CACHE_IDLE || std::sync::Arc::strong_count(entry) > 1)
    });
    if let Some(index) = entries
        .iter()
        .position(|(_, entry)| entry.binding == *binding && entry.plan == *plan)
    {
        let (_, entry) = entries.remove(index).unwrap();
        entries.push_back((now, entry.clone()));
        return Ok(entry);
    }
    if entries.len() == SNAPSHOT_ENTRIES {
        let index = entries
            .iter()
            .position(|(_, entry)| std::sync::Arc::strong_count(entry) == 1)
            .ok_or_else(cache_busy)?;
        entries.remove(index);
    }
    let entry = std::sync::Arc::new(ScopedSnapshot {
        binding: binding.clone(),
        plan: plan.clone(),
        state: tokio::sync::Mutex::new(SnapshotState::default()),
        active: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
        scope_active: scope.active.clone(),
    });
    entries.push_back((now, entry.clone()));
    Ok(entry)
}
fn snapshot_permit(plan: &FileReadPlan, length: usize) -> AgentResult<tokio::sync::OwnedSemaphorePermit> {
    // read_to_end may grow its Vec beyond len while checking EOF. Reserve twice
    // the captured file length; text also reserves a validated UTF-8 copy and sparse
    // offsets before allocating bytes.
    // The permit follows the Arc, so evicting a still-used snapshot cannot
    // silently release the budget while its body remains alive.
    let factor = if plan.format == FileSourceFormat::Pdf {
        2
    } else {
        3
    };
    let charge = (factor * length + 1024 * 1024) as u32;
    if let Ok(permit) = SNAPSHOT_QUOTA.clone().try_acquire_many_owned(charge) {
        return Ok(permit);
    }
    let entries = SNAPSHOTS.lock().map_err(|_| cache_busy())?;
    for (_, entry) in entries.iter() {
        if let Ok(mut state) = entry.state.try_lock() {
            if state
                .bytes
                .as_ref()
                .is_some_and(|bytes| std::sync::Arc::strong_count(bytes) == 1)
            {
                state.bytes = None; // Retain the small verification proof for search.
            }
        }
        if let Ok(permit) = SNAPSHOT_QUOTA.clone().try_acquire_many_owned(charge) {
            return Ok(permit);
        }
    }
    Err(cache_busy())
}
async fn current_stamp(plan: &FileReadPlan) -> AgentResult<FileStamp> {
    let path = plan.path.clone();
    tokio::task::spawn_blocking(move || regular(&fs::symlink_metadata(path).map_err(io_error)?))
        .await
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "File stamp task failed"))?
}
async fn capture_scoped_entry(
    entry: &ScopedSnapshot,
    state: &mut SnapshotState,
) -> AgentResult<std::sync::Arc<FileByteSnapshot>> {
    if !entry.active.load(std::sync::atomic::Ordering::Acquire)
        || !entry
            .scope_active
            .load(std::sync::atomic::Ordering::Acquire)
    {
        return Err(AgentError::new(
            ErrorCode::WorkspaceChanged,
            "Source cache generation is no longer active",
        ));
    }
    let current = match current_stamp(&entry.plan).await {
        Ok(stamp) => stamp,
        Err(error) => {
            state.bytes = None;
            state.receipt = None;
            return Err(error);
        }
    };
    if !cfg!(windows)
        && state
            .receipt
            .as_ref()
            .is_some_and(|receipt| receipt.stamp == current)
    {
        if let Some(bytes) = &state.bytes {
            return Ok(bytes.clone());
        }
    }
    state.bytes = None;
    state.receipt = None;
    if current.len > entry.plan.format.byte_limit() as u64 {
        return Err(AgentError::new(ErrorCode::BudgetExceeded, "File exceeds its extraction byte limit")
            .with_details(serde_json::json!({"state":"too_large"})));
    }
    let length = current.len as usize;
    let permit = snapshot_permit(&entry.plan, length)?;
    let plan = entry.plan.clone();
    // A cancelled await does not cancel spawn_blocking. Keep the permit inside
    // that task so its allocation remains charged until it actually finishes.
    let mut snapshot = tokio::task::spawn_blocking(move || {
        // A file that grows after reservation cannot consume uncharged bytes.
        let mut snapshot = capture_sync_bounded(&plan, length).map_err(|error| {
            if error.code == ErrorCode::BudgetExceeded { changed() } else { error }
        })?;
        snapshot.cache_permit = Some(permit);
        Ok::<_, AgentError>(snapshot)
    })
    .await
    .map_err(|_| AgentError::new(ErrorCode::IoFailed, "File snapshot task failed"))??;
    snapshot.cache_active = entry.active.clone();
    snapshot.cache_scope_active = entry.scope_active.clone();
    if !entry.active.load(std::sync::atomic::Ordering::Acquire)
        || !entry
            .scope_active
            .load(std::sync::atomic::Ordering::Acquire)
    {
        return Err(AgentError::new(
            ErrorCode::WorkspaceChanged,
            "Source cache generation closed during capture",
        ));
    }
    let snapshot = std::sync::Arc::new(snapshot);
    state.receipt = Some(snapshot.verification());
    state.bytes = Some(snapshot.clone());
    Ok(snapshot)
}
pub(crate) async fn capture_file_scoped(
    scope: &FileReadScope,
    plan: &FileReadPlan,
) -> AgentResult<std::sync::Arc<FileByteSnapshot>> {
    let entry = scoped_snapshot(scope, plan)?;
    let mut state = entry.state.lock().await;
    capture_scoped_entry(&entry, &mut state).await
}
pub(crate) async fn verification_scoped(
    scope: &FileReadScope,
    plan: &FileReadPlan,
) -> AgentResult<FileVerification> {
    let entry = scoped_snapshot(scope, plan)?;
    let mut state = entry.state.lock().await;
    if !cfg!(windows) {
        let current = current_stamp(plan).await?;
        if let Some(receipt) = state
            .receipt
            .as_ref()
            .filter(|receipt| receipt.stamp == current)
        {
            return Ok(receipt.clone());
        }
    }
    Ok(capture_scoped_entry(&entry, &mut state)
        .await?
        .verification())
}
pub(crate) async fn verify_file(
    plan: &FileReadPlan,
    snapshot: &FileByteSnapshot,
) -> AgentResult<()> {
    verify_file_receipt(plan, &snapshot.verification()).await
}
pub(crate) async fn verify_file_receipt(
    plan: &FileReadPlan,
    snapshot: &FileVerification,
) -> AgentResult<()> {
    if plan != &snapshot.plan || plan.registered_hash != snapshot.revision {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "File verification requires its captured plan",
        ));
    }
    let plan = plan.clone();
    let stamp = snapshot.stamp.clone();
    tokio::task::spawn_blocking(move || {
        let current = regular(&fs::symlink_metadata(&plan.path).map_err(io_error)?)?;
        if current != stamp || cfg!(windows) {
            // Rehash changed stat information; touching or replacing a file
            // with identical bytes does not create a different File Version.
            // Windows timestamps can be restored without a Unix-style ctime;
            // always rehash there before returning extracted evidence.
            capture_sync(&plan)?;
        }
        Ok(())
    })
    .await
    .map_err(|_| AgentError::new(ErrorCode::IoFailed, "File verification task failed"))?
}
// Count-based cache regressions share fixed process-wide budgets; keep their
// assertions independent of the test runner's scheduling.
#[cfg(test)]
pub(crate) static CACHE_TEST_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::models::{ObjectKind, Scope};
    use sha2::{Digest, Sha256};
    fn plan(path: PathBuf, bytes: &[u8]) -> FileReadPlan {
        FileReadPlan {
            title: "Fixture File".into(),
            updated_at: "2026-10-01T00:00:00Z".into(),
            object: ObjectRef {
                workspace_id: "file-workspace".into(),
                scope: Scope::Project { project_id: 7 },
                kind: ObjectKind::File,
                id: "42".into(),
            },
            file_version: 3,
            registered_hash: format!("sha256:{:x}", Sha256::digest(bytes)),
            path,
            format: FileSourceFormat::Text,
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn source_snapshot_cache_unicode_index_close_and_mutation_are_checked() {
        let _gate = CACHE_TEST_GATE.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("unicode.txt");
        let text = "中🙂a\r\n".repeat(3000);
        fs::write(&path, text.as_bytes()).unwrap();
        let plan = plan(path.clone(), text.as_bytes());
        let binding = crate::agent::models::WorkspaceBinding {
            workspace_id: plan.object.workspace_id.clone(),
            generation: dir.path().display().to_string(),
        };
        let scope = file_read_scope(&binding).unwrap();
        let snapshot = capture_file_scoped(&scope, &plan).await.unwrap();
        for offset in [0, 1, 1023, 1024, 5000, text.chars().count()] {
            let (actual, total, byte) = snapshot.text_position(offset).unwrap();
            assert_eq!(total, text.chars().count());
            assert_eq!(
                actual[byte..].chars().collect::<String>(),
                text.chars().skip(offset).collect::<String>()
            );
        }
        assert!(snapshot.text_position(text.chars().count() + 1).is_err());
        #[cfg(unix)]
        {
            let stamp = fs::metadata(&path).unwrap().modified().unwrap();
            fs::write(&path, text.replacen('a', "b", 1).as_bytes()).unwrap();
            File::open(&path)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(stamp))
                .unwrap();
            assert_eq!(
                capture_file_scoped(&scope, &plan).await.unwrap_err().code,
                ErrorCode::SourceChanged
            );
        }
        // A still-used allocation may outlive its LRU entry. Close must
        // invalidate that allocation too, and cannot release its quota early.
        let permits = SNAPSHOT_QUOTA.available_permits();
        SNAPSHOTS
            .lock()
            .unwrap()
            .retain(|(_, entry)| entry.binding != binding);
        assert_eq!(SNAPSHOT_QUOTA.available_permits(), permits);
        clear_binding(&binding);
        assert!(!snapshot.cache_is_active());
        assert!(
            matches!(capture_file_scoped(&scope,&plan).await,Err(error) if error.code==ErrorCode::WorkspaceChanged)
        );
        // Scope obtained before close, even without a byte-cache entry, cannot
        // repopulate a closed generation after the native lifecycle cleanup.
        assert!(SNAPSHOTS
            .lock()
            .unwrap()
            .iter()
            .all(|(_, entry)| entry.binding != binding));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn source_snapshot_cache_inflight_reads_and_search_proofs_avoid_rehash_after_byte_eviction(
    ) {
        let _gate = CACHE_TEST_GATE.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let mut plans = vec![];
        let binding = crate::agent::models::WorkspaceBinding {
            workspace_id: "file-workspace".into(),
            generation: dir.path().display().to_string(),
        };
        let scope = file_read_scope(&binding).unwrap();
        for i in 0..12 {
            let path = dir.path().join(format!("{i}.txt"));
            fs::write(&path, b"evidence").unwrap();
            plans.push(plan(path, b"evidence"));
        }
        let (a, b, c) = tokio::join!(
            capture_file_scoped(&scope, &plans[0]),
            capture_file_scoped(&scope, &plans[0]),
            capture_file_scoped(&scope, &plans[0])
        );
        let a = a.unwrap();
        assert!(std::sync::Arc::ptr_eq(&a, &b.unwrap()));
        assert!(std::sync::Arc::ptr_eq(&a, &c.unwrap()));
        drop(a);
        for plan in &plans[1..] {
            drop(capture_file_scoped(&scope, plan).await.unwrap());
        }
        // Exercise a body eviction without reserving the process-wide quota
        // away from unrelated parallel database tests.
        let entry = scoped_snapshot(&scope, &plans[0]).unwrap();
        {
            let mut state = entry.state.lock().await;
            assert!(state.receipt.is_some());
            state.bytes = None;
        }
        for _ in 0..100 {
            verification_scoped(&scope, &plans[0]).await.unwrap();
        }
        assert_eq!(
            capture_count(&plans[0].path),
            1,
            "search retains a small verified stamp after byte buffers are evicted"
        );
        let old = plans[0].path.with_extension("moved");
        fs::rename(&plans[0].path, &old).unwrap();
        assert_eq!(
            verification_scoped(&scope, &plans[0])
                .await
                .unwrap_err()
                .code,
            ErrorCode::SourceNotReady
        );
        fs::rename(old, &plans[0].path).unwrap();
        verification_scoped(&scope, &plans[0]).await.unwrap();
        assert!(capture_count(&plans[0].path) >= 2);
        clear_binding(&binding);
    }
    #[tokio::test]
    async fn small_pdf_snapshots_reserve_actual_bytes_and_growth_cannot_exceed_reservation() {
        let _gate = CACHE_TEST_GATE.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let binding = crate::agent::models::WorkspaceBinding {
            workspace_id: format!("small-pdf-{:032x}", rand::random::<u128>()),
            generation: "open".into(),
        };
        let scope = file_read_scope(&binding).unwrap();
        let bytes = vec![b'p'; 1024];
        let mut held = Vec::new();
        for i in 0..16 {
            let path = dir.path().join(format!("{i}.pdf"));
            fs::write(&path, &bytes).unwrap();
            let mut plan = plan(path, &bytes);
            plan.object.workspace_id = binding.workspace_id.clone();
            plan.format = FileSourceFormat::Pdf;
            let snapshot = capture_file_scoped(&scope, &plan).await.unwrap();
            assert_eq!(snapshot.cache_permit.as_ref().unwrap().num_permits(), 2 * bytes.len() + 1024 * 1024);
            held.push(snapshot);
        }
        let plan = &held[0].plan;
        fs::write(&plan.path, vec![b'p'; bytes.len() + 1]).unwrap();
        assert_eq!(capture_sync_bounded(plan, bytes.len()).unwrap_err().code, ErrorCode::BudgetExceeded);
        clear_binding(&binding);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn source_snapshot_cache_reuses_one_capture_for_one_hundred_pages() {
        let _gate = CACHE_TEST_GATE.lock().await;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("pages.txt");
        let bytes = "中文🙂 evidence".repeat(10000).into_bytes();
        fs::write(&path, &bytes).unwrap();
        let plan = plan(path, &bytes);
        let binding = crate::agent::models::WorkspaceBinding {
            workspace_id: plan.object.workspace_id.clone(),
            generation: "open-1".into(),
        };
        let scope = file_read_scope(&binding).unwrap();
        let first = capture_file_scoped(&scope, &plan).await.unwrap();
        for _ in 0..100 {
            let next = capture_file_scoped(&scope, &plan).await.unwrap();
            assert!(
                std::sync::Arc::ptr_eq(&first, &next),
                "unchanged pages must share the verified byte allocation"
            );
        }
    }
    #[tokio::test]
    async fn source_file_snapshot_matches_registered_bytes_and_rejects_external_same_size_change() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("登记 资料.txt");
        let original = "版本一 evidence".as_bytes();
        std::fs::write(&path, original).unwrap();
        let plan = plan(path.clone(), original);
        let captured = capture_file(&plan).await.unwrap();
        assert_eq!(captured.bytes, original);
        assert_eq!(captured.revision, plan.registered_hash);
        std::fs::write(&path, "版本二 evidence".as_bytes()).unwrap();
        let error = capture_file(&plan).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::SourceChanged);
        assert_eq!(error.details.unwrap()["state"], "changed_unregistered");
    }
    #[tokio::test]
    async fn source_file_snapshot_is_rechecked_after_extraction() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("current.txt");
        let original = b"registered first";
        fs::write(&path, original).unwrap();
        let plan = plan(path.clone(), original);
        let snapshot = capture_file(&plan).await.unwrap();
        verify_file(&plan, &snapshot).await.unwrap();
        fs::write(&path, b"unregistered new").unwrap();
        assert_eq!(
            verify_file(&plan, &snapshot).await.unwrap_err().code,
            ErrorCode::SourceChanged
        );
        // A timestamp change alone does not change the registered bytes.
        fs::write(&path, original).unwrap();
        verify_file(&plan, &snapshot).await.unwrap();
        fs::remove_file(&path).unwrap();
        assert_eq!(
            verify_file(&plan, &snapshot).await.unwrap_err().code,
            ErrorCode::SourceNotReady
        );
    }
    #[tokio::test]
    async fn source_file_snapshot_requires_canonical_business_identity() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("registered.txt");
        fs::write(&path, b"abc").unwrap();
        let original = plan(path, b"abc");
        for id in ["0", "-1", "042", "alias", "9223372036854775808"] {
            let mut invalid = original.clone();
            invalid.object.id = id.into();
            assert_eq!(
                capture_file(&invalid).await.unwrap_err().code,
                ErrorCode::InvalidArgument,
                "{id}"
            );
        }
    }
    #[tokio::test]
    async fn source_file_snapshot_bounds_bytes_and_rejects_missing_or_nonregular_paths() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large.txt");
        let file = File::create(&path).unwrap();
        file.set_len(10 * 1024 * 1024 + 1).unwrap();
        for format in [
            FileSourceFormat::Text,
            FileSourceFormat::Markdown,
            FileSourceFormat::Html,
        ] {
            let mut large = plan(path.clone(), b"");
            large.format = format;
            let error = capture_file(&large).await.unwrap_err();
            assert_eq!(error.code, ErrorCode::BudgetExceeded);
            assert_eq!(error.details.unwrap()["state"], "too_large");
        }
        file.set_len(50 * 1024 * 1024 + 1).unwrap();
        let mut pdf = plan(path, b"");
        pdf.format = FileSourceFormat::Pdf;
        assert_eq!(
            capture_file(&pdf).await.unwrap_err().code,
            ErrorCode::BudgetExceeded
        );
        let missing = plan(directory.path().join("missing.txt"), b"");
        let error = capture_file(&missing).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::SourceNotReady);
        assert_eq!(error.details.unwrap()["state"], "missing");
        assert_eq!(
            capture_file(&plan(directory.path().into(), b""))
                .await
                .unwrap_err()
                .code,
            ErrorCode::SourceChanged
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let target = directory.path().join("actual.txt");
            fs::write(&target, b"abc").unwrap();
            let link = directory.path().join("link.txt");
            symlink(target, &link).unwrap();
            assert_eq!(
                capture_file(&plan(link, b"abc")).await.unwrap_err().code,
                ErrorCode::SourceChanged
            );
            let socket = directory.path().join("socket.txt");
            let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
            assert_eq!(
                tokio::time::timeout(
                    std::time::Duration::from_secs(1),
                    capture_file(&plan(socket, b""))
                )
                .await
                .unwrap()
                .unwrap_err()
                .code,
                ErrorCode::SourceChanged
            );
        }
    }
}
