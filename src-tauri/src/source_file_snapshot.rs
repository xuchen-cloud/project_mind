//! Bounded bytes for a server-resolved, hash-registered File Version. This
//! kernel grants no access; the shared source service must resolve ownership
//! and current policy before capture, then recheck its binding and version.
use crate::agent::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, Scope},
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
    pub path: PathBuf,
    pub format: FileSourceFormat,
}
#[derive(Debug)]
pub(crate) struct FileByteSnapshot {
    pub bytes: Vec<u8>,
    pub revision: String,
    plan: FileReadPlan,
    stamp: FileStamp,
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
    fn from_metadata(metadata: &Metadata) -> Self {
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
fn open_regular(path: &Path) -> AgentResult<File> {
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
fn open_regular(path: &Path) -> AgentResult<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(io_error)
}
#[cfg(not(any(unix, windows)))]
fn open_regular(_path: &Path) -> AgentResult<File> {
    Err(AgentError::new(
        ErrorCode::RuntimeUnavailable,
        "File snapshots are unsupported on this platform",
    ))
}
fn capture_sync(plan: &FileReadPlan) -> AgentResult<FileByteSnapshot> {
    plan.object.key()?;
    if plan.object.kind != ObjectKind::File
        || !matches!(plan.object.scope, Scope::Project { .. })
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
    let limit = plan.format.byte_limit();
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
    })
}
pub(crate) async fn capture_file(plan: &FileReadPlan) -> AgentResult<FileByteSnapshot> {
    let plan = plan.clone();
    tokio::task::spawn_blocking(move || capture_sync(&plan))
        .await
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "File snapshot task failed"))?
}
pub(crate) async fn verify_file(
    plan: &FileReadPlan,
    snapshot: &FileByteSnapshot,
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
#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::models::{ObjectKind, Scope};
    use sha2::{Digest, Sha256};
    fn plan(path: PathBuf, bytes: &[u8]) -> FileReadPlan {
        FileReadPlan {
            title: "Fixture File".into(),
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
