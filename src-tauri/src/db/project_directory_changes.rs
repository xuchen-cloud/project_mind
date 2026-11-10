//! Whole-directory GUI mutations. IDs, history and working recovery bytes survive.
//! The owner lease covers membership/session checks through filesystem and SQL.
use super::{file_versions as files, project_directory_files::FileServiceError, Database};
use crate::agent::models::{ObjectKind, ObjectRef, WorkspaceBinding};
use anyhow::{anyhow, bail, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const JOURNALS: &str = ".project-mind/directory-change-journal";
const FILE_LIMIT: usize = 4096;
const ENTRY_LIMIT: usize = 100_000;
const INTENT_LIMIT: usize = 8 * 1024 * 1024;
#[derive(Clone, Copy)]
enum DirectoryPhase {
    Prepared,
    HistoryRetained,
    Moved,
    Committed,
}
fn crash_point(phase: DirectoryPhase) {
    #[cfg(all(test, unix))]
    if matches!(phase, DirectoryPhase::HistoryRetained) {
        if let Some(parent) = std::env::var_os("MIND_DIRECTORY_SWAP_PARENT") {
            let parent = PathBuf::from(parent);
            let retained = parent.with_file_name("fault-retained-owner");
            fs::rename(&parent, &retained).unwrap();
            std::os::unix::fs::symlink(&retained, &parent).unwrap();
        }
    }
    #[cfg(test)]
    if std::env::var("MIND_DIRECTORY_CRASH_STAGE")
        .ok()
        .and_then(|v| v.parse::<u8>().ok())
        == Some(phase as u8)
    {
        std::process::exit(91);
    }
    #[cfg(not(test))]
    let _ = phase;
}
fn failure(code: &'static str, message: &str) -> anyhow::Error {
    FileServiceError {
        code,
        message: message.into(),
    }
    .into()
}
fn digest(value: &impl Serialize) -> Result<String> {
    Ok(format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(value)?)
    ))
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreparedFile {
    pub file_id: i64,
    pub revision: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedDirectoryChange {
    pub token: String,
    pub identity_token: String,
    pub relative_path: String,
    pub files: Vec<PreparedFile>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DirectoryChangeInput {
    pub binding: WorkspaceBinding,
    pub project_id: Option<i64>,
    pub relative_path: String,
    pub token: String,
    pub name: Option<String>,
    pub confirmed: Option<bool>,
    pub request_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectoryChangeResult {
    pub relative_path: Option<String>,
    pub file_ids: Vec<i64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Member {
    id: i64,
    project: Option<i64>,
    managed: String,
    history: String,
    original: String,
    version: i64,
    working: Option<String>,
    physical: Option<String>,
    versions: Vec<MemberVersion>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct MemberVersion {
    id: i64,
    path: String,
    hash: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    input: DirectoryChangeInput,
    source: String,
    target: Option<String>,
    root: String,
    root_identity: files::FileIdentity,
    parent_identity: files::FileIdentity,
    identity: files::FileIdentity,
    members: Vec<Member>,
}
impl Intent {
    fn operation(&self) -> &'static str {
        if self.target.is_some() {
            "file.directory.rename"
        } else {
            "file.directory.delete"
        }
    }
    fn result(&self) -> DirectoryChangeResult {
        DirectoryChangeResult {
            relative_path: self.target.as_ref().map(|_| {
                let parent = self.input.relative_path.rsplit_once('/').map(|v| v.0);
                match parent {
                    Some(parent) => format!("{parent}/{}", self.input.name.as_deref().unwrap()),
                    None => self.input.name.clone().unwrap(),
                }
            }),
            file_ids: self.members.iter().map(|m| m.id).collect(),
        }
    }
}

// The receipt must be durable before removing the filesystem intent. Keep this
// connection's previous setting, including when commit/recovery returns early.
struct DirectoryDurability<'a>(&'a rusqlite::Connection, i64);
impl<'a> DirectoryDurability<'a> {
    fn new(conn: &'a rusqlite::Connection) -> Result<Self> {
        let previous = conn.pragma_query_value(None, "synchronous", |r| r.get(0))?;
        conn.pragma_update(None, "synchronous", i64::max(previous, 2))?;
        Ok(Self(conn, previous))
    }
}
impl Drop for DirectoryDurability<'_> {
    fn drop(&mut self) {
        if let Err(error) = self.0.pragma_update(None, "synchronous", self.1) {
            eprintln!("Directory synchronous restore failed: {error}");
        }
    }
}

fn directory_identity(path: &Path) -> Result<files::FileIdentity> {
    let metadata = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(failure("invalid_path", "目录或其祖先不能是重解析点"));
        }
    }
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(failure("invalid_path", "目录或其祖先不能是符号链接"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(
            (rustix::fs::OFlags::DIRECTORY
                | rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::CLOEXEC)
                .bits() as i32,
        );
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        options.custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    }
    files::identity(&options.open(path)?)
}
fn directory_ancestors(root: &Path, path: &Path) -> Result<()> {
    directory_identity(root)?;
    let relative = path.strip_prefix(root)?;
    let mut current = root.to_owned();
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            bail!("Invalid directory ancestor");
        }
        current.push(component);
        directory_identity(&current)?;
    }
    Ok(())
}
fn recovery_path_error(error: anyhow::Error) -> anyhow::Error {
    if error.downcast_ref::<std::io::Error>().is_some_and(|e| {
        matches!(
            e.kind(),
            std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
        )
    }) || error
        .downcast_ref::<FileServiceError>()
        .is_some_and(|e| e.code == "invalid_path")
    {
        failure(
            "revision_conflict",
            "目录或祖先已被外部替换，恢复材料已保留",
        )
    } else {
        error
    }
}
fn present(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}
fn clear(directory: &Path) -> Result<()> {
    fs::remove_file(directory.join("intent.json"))?;
    files::sync_directory(directory)?;
    fs::remove_dir(directory)?;
    files::sync_directory(directory.parent().unwrap())
}
fn lock_error(error: anyhow::Error) -> anyhow::Error {
    if error.downcast_ref::<std::io::Error>().is_some_and(|e| {
        e.kind() == std::io::ErrorKind::WouldBlock
            || e.raw_os_error() == fs2::lock_contended_error().raw_os_error()
    }) {
        failure("revision_conflict", "目录内有文件操作正在进行，请稍后重试")
    } else {
        error
    }
}
fn read_intent(path: &Path) -> Result<Option<Intent>> {
    let mut options = OpenOptions::new();
    options.read(true);
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
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    // Another owner may finish and remove its journal after enumeration. Once
    // open, retain the descriptor through validation and parsing.
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        bail!("Directory intent must be a regular file");
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            bail!("Directory intent cannot be a reparse point");
        }
    }
    let mut bytes = Vec::new();
    file.take(INTENT_LIMIT as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > INTENT_LIMIT {
        bail!("Directory intent exceeds budget");
    }
    Ok(Some(serde_json::from_slice(&bytes)?))
}
impl Database {
    pub(super) fn directory_require_file_no_pending(
        &self,
        document: &crate::models::DocumentRecord,
    ) -> Result<()> {
        self.directory_require_no_pending_for(
            Path::new(&document.managed_path),
            document.project_id,
            Some(document.id),
        )
    }
    // Preparation is read-only. Unresolved paths remain blocked even when the
    // global recovery pass can continue opening unrelated Workspace content.
    pub(super) fn directory_require_no_pending(
        &self,
        source: &Path,
        project: Option<i64>,
    ) -> Result<()> {
        self.directory_require_no_pending_for(source, project, None)
    }
    fn directory_require_no_pending_for(
        &self,
        source: &Path,
        project: Option<i64>,
        file_id: Option<i64>,
    ) -> Result<()> {
        let base = self.workspace_root.join(JOURNALS);
        if !present(&base)? {
            return Ok(());
        }
        files::relative(&self.workspace_root, &base)?;
        for entry in fs::read_dir(base)? {
            let path = entry?.path().join("intent.json");
            files::relative(&self.workspace_root, &path)?;
            let Some(intent) = read_intent(&path)? else {
                continue;
            };
            if intent.input.project_id != project {
                continue;
            }
            let pending_source = self.decode_path_ref(&intent.source);
            let overlaps = |other: &Path| source.starts_with(other) || other.starts_with(source);
            if file_id.is_some_and(|id| intent.members.iter().any(|member| member.id == id))
                || overlaps(&pending_source)
                || intent
                    .target
                    .as_ref()
                    .is_some_and(|p| overlaps(&self.decode_path_ref(p)))
            {
                return Err(failure(
                    "revision_conflict",
                    "此目录有尚未恢复的操作，恢复材料已保留，请先处理路径冲突",
                ));
            }
        }
        Ok(())
    }
    fn directory_retained_history(&self, intent: &Intent, member: &Member) -> Result<PathBuf> {
        let key = digest(&intent.input)?;
        Ok(self
            .workspace_root
            .join(".project-mind/directory-history")
            .join(key.strip_prefix("sha256:").unwrap())
            .join(member.id.to_string()))
    }
    fn directory_retain_versions(&self, intent: &Intent, copy: bool) -> Result<()> {
        let source = self.decode_path_ref(&intent.source);
        for member in &intent.members {
            let retained = self.directory_retained_history(intent, member)?;
            for version in &member.versions {
                let original = self.decode_path_ref(&version.path);
                if !original.starts_with(&source) {
                    continue;
                }
                let target = retained.join(version.id.to_string());
                files::relative(&self.workspace_root, &original)?;
                files::relative(&self.workspace_root, &target)?;
                let hash = if copy {
                    files::create_owned_directories(&self.workspace_root, &retained)?;
                    if present(&target)? {
                        // Repeating an aborted request may already have copied
                        // these immutable bytes. Never overwrite that evidence.
                        let hash = files::checksum(&target)?;
                        if files::checksum(&original)? != hash {
                            return Err(failure(
                                "revision_conflict",
                                "已保留的历史版本与原件不同，恢复材料已保留",
                            ));
                        }
                        hash
                    } else {
                        let (hash, _, _) = files::snapshot(&original, &target)?;
                        files::sync_directory(&retained)?;
                        hash
                    }
                } else {
                    files::checksum(&target)?
                };
                if version
                    .hash
                    .as_ref()
                    .is_some_and(|expected| *expected != hash)
                {
                    return Err(failure(
                        "revision_conflict",
                        "历史版本已变化，未移动目录且保留恢复材料",
                    ));
                }
            }
        }
        Ok(())
    }
    // These are deliberately nonblocking: adapters hold the lifecycle fence.
    // A competing writer may need that fence before releasing its File lease.
    fn directory_owner_lease(&self, project: Option<i64>) -> Result<File> {
        let (directory, id) = project.map_or(("file-project-locks/workspace", 1), |id| {
            ("file-project-locks", id)
        });
        self.file_storage_try_lock(directory, id)
            .map_err(lock_error)
    }
    fn directory_member_leases(&self, members: &[Member]) -> Result<Vec<File>> {
        members
            .iter()
            .map(|m| {
                self.file_storage_try_lock("file-version-locks", m.id)
                    .map_err(lock_error)
            })
            .collect()
    }
    fn directory_change_source(
        &self,
        binding: &WorkspaceBinding,
        project: Option<i64>,
        relative: &str,
    ) -> Result<(PathBuf, PathBuf)> {
        if self.native_workspace_id.as_deref() != Some(&binding.workspace_id) {
            return Err(failure("ownership_mismatch", "Workspace 已变更"));
        }
        if relative.is_empty()
            || relative.contains(['\\', ':', '\0'])
            || relative
                .split('/')
                .any(|v| v.is_empty() || v == "." || v == ".." || v.starts_with('.'))
        {
            return Err(failure(
                "invalid_path",
                "只能修改所属目录内的普通文件夹，不能修改根目录或系统目录",
            ));
        }
        if self.file_scope_archived(project)? {
            return Err(failure("ownership_mismatch", "归档项目不可修改"));
        }
        let root = self.file_scope_root(project)?;
        directory_identity(&root)?;
        let source = root.join(relative);
        files::relative(&self.workspace_root, &source)?;
        directory_ancestors(&self.workspace_root, source.parent().unwrap())?;
        if super::project_directory_files::excluded_project_path(&root, &source)? {
            return Err(failure("invalid_path", "不能修改隐藏或系统目录"));
        }
        directory_identity(&source).map_err(|e| {
            if e.downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            {
                failure("original_missing", "目录不存在，请刷新后重试")
            } else {
                e
            }
        })?;
        Ok((root, source))
    }
    // SQL selects path metadata only, never content or recovery BLOBs. Include
    // legacy path refs too; their decoded paths obey the same owner boundary.
    fn directory_members(&self, source: &Path, project: Option<i64>) -> Result<Vec<Member>> {
        let has_directory_table: bool = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_directory_files')", [], |r| r.get(0))?;
        let prefixes = [
            self.encode_path_ref(source),
            format!("absolute:{}", source.display()),
            source.to_string_lossy().into_owned(),
        ];
        let mut ids = std::collections::BTreeSet::new();
        for prefix in prefixes {
            let like = format!(
                "{}/%",
                prefix
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            );
            let mut stmt = self.conn.prepare("SELECT id FROM documents WHERE managed_path=?1 OR managed_path LIKE ?2 ESCAPE '\\' OR history_dir_path LIKE ?2 ESCAPE '\\' OR original_path LIKE ?2 ESCAPE '\\' ORDER BY id LIMIT ?3")?;
            for id in stmt.query_map(params![prefix, like, (FILE_LIMIT + 1) as i64], |r| {
                r.get::<_, i64>(0)
            })? {
                ids.insert(id?);
            }
        }
        if ids.len() > FILE_LIMIT {
            return Err(failure(
                "budget_exceeded",
                "目录内已登记文件过多，请分批处理",
            ));
        }
        let mut members = Vec::new();
        for id in ids {
            let mut member = self.conn.query_row(if has_directory_table { "SELECT d.id,d.project_id,d.managed_path,d.history_dir_path,d.original_path,d.current_version_number,w.state,f.physical_identity FROM documents d LEFT JOIN file_working_contents w ON w.document_id=d.id LEFT JOIN project_directory_files f ON f.document_id=d.id WHERE d.id=?1" } else { "SELECT d.id,d.project_id,d.managed_path,d.history_dir_path,d.original_path,d.current_version_number,w.state,NULL FROM documents d LEFT JOIN file_working_contents w ON w.document_id=d.id WHERE d.id=?1" }, [id], |r| Ok(Member { id:r.get(0)?, project:r.get(1)?, managed:r.get(2)?, history:r.get(3)?, original:r.get(4)?, version:r.get(5)?, working:r.get(6)?, physical:r.get(7)?, versions: Vec::new() }))?;
            let managed = self.decode_path_ref(&member.managed);
            let history = self.decode_path_ref(&member.history);
            let original = self.decode_path_ref(&member.original);
            if ![&managed, &history, &original]
                .iter()
                .any(|p| p.starts_with(source))
            {
                continue;
            }
            if member.project != project {
                return Err(failure(
                    "ownership_mismatch",
                    "目录包含其他作用域的文件或历史路径",
                ));
            }
            // A member is immutable metadata, not an editor buffer; JSON order
            // in the stored state is stable across these two reads.
            member.managed = self.encode_path_ref(&managed);
            member.history = self.encode_path_ref(&history);
            member.original = self.encode_path_ref(&original);
            let mut stmt = self.conn.prepare("SELECT v.id,v.managed_path,h.content_hash FROM document_versions v LEFT JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1 ORDER BY v.id LIMIT 100001")?;
            member.versions = stmt
                .query_map([id], |r| {
                    Ok(MemberVersion {
                        id: r.get(0)?,
                        path: r.get(1)?,
                        hash: r.get(2)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if member.versions.len() > ENTRY_LIMIT {
                return Err(failure("budget_exceeded", "历史版本过多，请分批处理"));
            }
            members.push(member);
        }
        Ok(members)
    }
    fn directory_require_closed(&self, members: &[Member], generation: &str) -> Result<()> {
        for member in members {
            let active: bool = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM file_working_sessions WHERE document_id=?1 AND generation=?2)", params![member.id, generation], |r| r.get(0))?;
            if active {
                return Err(failure(
                    "active_editors",
                    "请先关闭此目录内正在编辑的文件（包括独立窗口），保存完成后重试",
                ));
            }
            let pending: bool = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM file_working_contents WHERE document_id=?1 AND journal IS NOT NULL)", [member.id], |r| r.get(0))?;
            if pending {
                return Err(failure(
                    "revision_conflict",
                    "目录内有文件保存尚待恢复，请先恢复文件",
                ));
            }
            if member.physical.is_some() {
                let pending: bool = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM project_directory_moves WHERE document_id=?1 UNION ALL SELECT 1 FROM project_directory_metadata_intents WHERE document_id=?1)", [member.id], |r| r.get(0))?;
                if pending {
                    return Err(failure("revision_conflict", "目录内有文件路径操作尚待恢复"));
                }
            }
        }
        Ok(())
    }
    fn directory_prepared_locked(
        &self,
        binding: &WorkspaceBinding,
        project: Option<i64>,
        relative: &str,
    ) -> Result<(PreparedDirectoryChange, Vec<Member>, PathBuf, PathBuf)> {
        let (root, source) = self.directory_change_source(binding, project, relative)?;
        // A moved object's immutable history/resources may still live here.
        // This runs for both menu preparation and the final fenced recheck.
        self.file_owner_require_unshared_root(&source, project)?;
        self.record_owner_require_unshared_root(&source, project)?;
        let before = directory_identity(&source)?;
        let members = self.directory_members(&source, project)?;
        self.directory_require_closed(&members, &binding.generation)?;
        files::relative(&self.workspace_root, &source)?;
        if directory_identity(&source)? != before {
            return Err(failure("revision_conflict", "目录身份已变化，请重新确认"));
        }
        let root_identity = directory_identity(&root)?;
        let parent_identity = directory_identity(source.parent().unwrap())?;
        let identity_token = digest(&(&root_identity, &parent_identity, &before))?;
        let token = digest(&(
            binding,
            project,
            relative,
            &root_identity,
            &parent_identity,
            &before,
            &members,
        ))?;
        let files = members
            .iter()
            .map(|m| {
                let revision = m
                    .working
                    .as_deref()
                    .map(super::file_working::stored_working_revision)
                    .transpose()?
                    .unwrap_or(m.version);
                Ok(PreparedFile {
                    file_id: m.id,
                    revision,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok((
            PreparedDirectoryChange {
                token,
                identity_token,
                relative_path: relative.into(),
                files,
            },
            members,
            root,
            source,
        ))
    }
    pub(crate) fn project_directory_change_prepare(
        &self,
        binding: &WorkspaceBinding,
        project: Option<i64>,
        relative: &str,
    ) -> Result<PreparedDirectoryChange> {
        let _owner = self.directory_owner_lease(project)?;
        let (_, source) = self.directory_change_source(binding, project, relative)?;
        self.directory_require_no_pending(&source, project)?;
        Ok(self
            .directory_prepared_locked(binding, project, relative)?
            .0)
    }
    // Do not follow links in the tree. A symlink entry moves with its parent,
    // whereas a symlink source/ancestor is rejected by relative()/identity().
    fn directory_check_tree(&self, source: &Path, members: &[Member]) -> Result<()> {
        let histories: HashSet<PathBuf> = members
            .iter()
            .map(|m| self.decode_path_ref(&m.history))
            .collect();
        let mut stack = vec![source.to_owned()];
        let mut count = 0;
        while let Some(path) = stack.pop() {
            files::relative(&self.workspace_root, &path)?;
            for entry in fs::read_dir(path)? {
                let entry = entry?;
                count += 1;
                if count > ENTRY_LIMIT {
                    return Err(failure("budget_exceeded", "目录项过多，请分批处理"));
                }
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.eq_ignore_ascii_case(".project-mind")
                    || (name.ends_with(".pm-versions") && !histories.contains(&entry.path()))
                {
                    return Err(failure(
                        "ownership_mismatch",
                        "目录包含受保护或不属于当前文件的应用元数据",
                    ));
                }
                let kind = entry.file_type()?;
                let descend = kind.is_dir() && !kind.is_symlink();
                #[cfg(windows)]
                let descend = {
                    use std::os::windows::fs::MetadataExt;
                    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
                    descend
                        && fs::symlink_metadata(entry.path())?.file_attributes()
                            & FILE_ATTRIBUTE_REPARSE_POINT
                            == 0
                };
                if descend {
                    stack.push(entry.path());
                }
            }
        }
        Ok(())
    }
    fn directory_persist_intent(&self, intent: &Intent) -> Result<PathBuf> {
        let bytes = serde_json::to_vec(intent)?;
        if bytes.len() > INTENT_LIMIT {
            return Err(failure("budget_exceeded", "目录恢复资料过大，请分批处理"));
        }
        let base = self.workspace_root.join(JOURNALS);
        files::create_owned_directories(&self.workspace_root, &base)?;
        let directory = base.join(format!("{:032x}", rand::random::<u128>()));
        fs::create_dir(&directory)?;
        files::sync_directory(&base)?;
        let path = directory.join("intent.next");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        files::move_exclusive(&path, &directory.join("intent.json"))?;
        files::sync_directory(&directory)?;
        Ok(directory)
    }
    fn directory_validate_intent(&self, intent: &Intent) -> Result<(PathBuf, Option<PathBuf>)> {
        if self.native_workspace_id.as_deref() != Some(&intent.input.binding.workspace_id)
            || intent.members.len() > FILE_LIMIT
            || intent.input.request_id.is_empty()
            || intent.input.request_id.len() > 128
        {
            bail!("Invalid directory intent identity");
        }
        let root = self.decode_path_ref(&intent.root);
        let source = self.decode_path_ref(&intent.source);
        // Distinguish external path replacement from storage/intent corruption.
        // Check ancestors before helpers which reject links as a generic error.
        directory_ancestors(
            &self.workspace_root,
            source
                .parent()
                .ok_or_else(|| anyhow!("Invalid directory source"))?,
        )
        .map_err(recovery_path_error)?;
        if self.file_scope_root(intent.input.project_id)? != root
            || intent.input.relative_path.is_empty()
            || intent
                .input
                .relative_path
                .split('/')
                .any(|v| v.is_empty() || v.starts_with('.') || v.contains(['\\', ':', '\0']))
            || intent.input.project_id.is_some_and(|id| id <= 0)
            || intent
                .members
                .iter()
                .any(|m| m.id <= 0 || m.project != intent.input.project_id)
            || intent
                .members
                .windows(2)
                .any(|pair| pair[0].id >= pair[1].id)
            || digest(&(
                &intent.input.binding,
                intent.input.project_id,
                &intent.input.relative_path,
                &intent.root_identity,
                &intent.parent_identity,
                &intent.identity,
                &intent.members,
            ))? != intent.input.token
            || (intent.target.is_none() && intent.input.confirmed != Some(true))
        {
            bail!("Invalid directory intent ownership or token");
        }
        files::relative(&self.workspace_root, &root)?;
        // The final entry may legitimately be missing after rename or Trash.
        if present(&source)? {
            directory_identity(&source).map_err(recovery_path_error)?;
        }
        files::relative(&root, &source)?;
        if source != root.join(&intent.input.relative_path)
            || directory_identity(&root)? != intent.root_identity
            || directory_identity(source.parent().unwrap())? != intent.parent_identity
        {
            return Err(failure(
                "revision_conflict",
                "目录根或父目录身份已变化，恢复材料已保留",
            ));
        }
        let target = intent.target.as_ref().map(|s| self.decode_path_ref(s));
        if let Some(target) = &target {
            if present(target)? {
                directory_identity(target).map_err(recovery_path_error)?;
            }
            files::relative(&root, target)?;
            if source.parent() != target.parent()
                || target.file_name().and_then(|n| n.to_str()) != intent.input.name.as_deref()
            {
                bail!("Invalid directory rename target");
            }
        }
        Ok((source, target))
    }
    fn directory_commit_intent(&self, intent: &Intent) -> Result<DirectoryChangeResult> {
        let _durable = DirectoryDurability::new(&self.conn)?;
        let source = self.decode_path_ref(&intent.source);
        let target = intent.target.as_ref().map(|p| self.decode_path_ref(p));
        let result = intent.result();
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        // The intent remains until this transaction and its receipt are durable.
        let current = self.directory_members(&source, intent.input.project_id)?;
        if current != intent.members {
            return Err(failure(
                "revision_conflict",
                "目录文件集合或版本已变化，恢复材料已保留",
            ));
        }
        for member in &intent.members {
            if let Some(target) = &target {
                let rebase =
                    |value: &str| self.rewrite_path_ref_prefix_if_within(value, &source, target);
                tx.execute("UPDATE documents SET managed_path=?1,history_dir_path=?2,original_path=?3,updated_at=?4 WHERE id=?5", params![rebase(&member.managed),rebase(&member.history),rebase(&member.original),super::now_iso(),member.id])?;
                let versions = {
                    let mut stmt = tx.prepare("SELECT id,managed_path,source_path FROM document_versions WHERE document_id=?1")?;
                    let rows = stmt
                        .query_map([member.id], |r| {
                            Ok((
                                r.get::<_, i64>(0)?,
                                r.get::<_, String>(1)?,
                                r.get::<_, String>(2)?,
                            ))
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    rows
                };
                for (id, managed, original) in versions {
                    tx.execute(
                        "UPDATE document_versions SET managed_path=?1,source_path=?2 WHERE id=?3",
                        params![rebase(&managed), rebase(&original), id],
                    )?;
                }
            } else {
                let retained = self.directory_retained_history(intent, member)?;
                if self.decode_path_ref(&member.history).starts_with(&source) {
                    tx.execute(
                        "UPDATE documents SET history_dir_path=?1 WHERE id=?2",
                        params![self.encode_path_ref(&retained), member.id],
                    )?;
                }
                for version in &member.versions {
                    if self.decode_path_ref(&version.path).starts_with(&source) {
                        tx.execute(
                            "UPDATE document_versions SET managed_path=?1 WHERE id=?2",
                            params![
                                self.encode_path_ref(&retained.join(version.id.to_string())),
                                version.id
                            ],
                        )?;
                    }
                }
                if self.decode_path_ref(&member.managed).starts_with(&source) {
                    tx.execute(
                        "UPDATE documents SET health='missing',updated_at=?1 WHERE id=?2",
                        params![super::now_iso(), member.id],
                    )?;
                    if member.physical.is_some() {
                        tx.execute("UPDATE project_directory_files SET state='missing',reason='original_missing' WHERE document_id=?1", [member.id])?;
                    }
                }
            }
            let object = ObjectRef {
                workspace_id: intent.input.binding.workspace_id.clone(),
                scope: super::file_scope::scope(intent.input.project_id),
                kind: ObjectKind::File,
                id: member.id.to_string(),
            };
            tx.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES (?1,?2,?3,?4,?5)", params![object.key().map_err(|e| anyhow!(e.message))?,object.scope.key(),intent.operation(),intent.input.token,super::now_iso()])?;
        }
        let result = self
            .agent_atomic_operation_in_transaction(
                &tx,
                "gui",
                &intent.input.request_id,
                intent.operation(),
                &intent.input,
                |_| Ok((result, None)),
            )
            .map_err(|e| anyhow!(e.message))?;
        tx.commit()?;
        Ok(result)
    }
    fn directory_recover_locked(&self, directory: &Path, intent: &Intent) -> Result<()> {
        let committed = self
            .agent_operation_replay::<DirectoryChangeResult>(
                "gui",
                &intent.input.request_id,
                intent.operation(),
                &intent.input,
            )
            .map_err(|e| anyhow!(e.message))?
            .is_some();
        // A durable receipt is authoritative. Later external changes cannot
        // authorize another filesystem mutation or obstruct intent cleanup.
        if committed {
            return clear(directory);
        }
        let (source, target) = self.directory_validate_intent(intent)?;
        if let Some(target) = target {
            match (present(&source)?, present(&target)?) {
                (true, false)
                    if directory_identity(&source).map_err(recovery_path_error)?
                        == intent.identity =>
                {
                    ()
                }
                (false, true)
                    if directory_identity(&target).map_err(recovery_path_error)?
                        == intent.identity =>
                {
                    files::move_exclusive(&target, &source)?
                }
                _ => {
                    return Err(failure(
                        "revision_conflict",
                        "中断的目录改名发生路径冲突，恢复材料已保留",
                    ))
                }
            }
        } else {
            if present(&source)? {
                if directory_identity(&source).map_err(recovery_path_error)? != intent.identity {
                    return Err(failure(
                        "revision_conflict",
                        "删除后的路径被其他目录占用，恢复材料已保留",
                    ));
                }
                // Intent reached disk, but Trash did not remove the original.
            } else {
                // Trash is irreversible to this process. Preserve all DB File
                // identities/history and finish only missing flags + receipt.
                self.directory_retain_versions(intent, false)?;
                self.directory_commit_intent(intent)?;
            }
        }
        clear(directory)
    }
    pub(crate) fn project_directory_recover_pending(
        &self,
        project: Option<Option<i64>>,
    ) -> Result<()> {
        let base = self.workspace_root.join(JOURNALS);
        if !present(&base)? {
            return Ok(());
        }
        files::relative(&self.workspace_root, &base)?;
        for entry in fs::read_dir(&base)? {
            let entry = entry?;
            let directory = entry.path();
            files::relative(&self.workspace_root, &directory)?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            if name.len() != 32
                || !name.bytes().all(|b| b.is_ascii_hexdigit())
                || !file_type.is_dir()
            {
                bail!("Invalid directory journal");
            }
            let path = directory.join("intent.json");
            let Some(intent) = read_intent(&path)? else {
                // Crash before durable intent: no filesystem mutation occurred.
                // A writer may still be publishing its intent. An orphan
                // here has never moved business data and needs no recovery.
                continue;
            };
            if project.is_some_and(|project| project != intent.input.project_id) {
                continue;
            }
            let recovered = (|| -> Result<()> {
                let _owner = self.directory_owner_lease(intent.input.project_id)?;
                // The owner lease also prevents a second recovery from clearing it.
                if !present(&path)? {
                    return Ok(());
                }
                let _files = self.directory_member_leases(&intent.members)?;
                let _permit = self
                    .file_commit_permit()
                    .map_err(|error| anyhow!(error.message))?;
                self.directory_recover_locked(&directory, &intent)
            })();
            if let Err(error) = recovered {
                if error
                    .downcast_ref::<FileServiceError>()
                    .is_some_and(|error| error.code == "revision_conflict")
                {
                    eprintln!(
                        "Directory recovery retained at {}: {error:#}",
                        directory.display()
                    );
                } else {
                    return Err(error);
                }
            }
        }
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn project_directory_change_with(
        &self,
        input: &DirectoryChangeInput,
        trash: impl FnOnce(&Path) -> Result<()>,
    ) -> Result<DirectoryChangeResult> {
        self.project_directory_change_fenced_with(input, trash, || Ok(()))
    }
    pub(crate) fn project_directory_change_fenced_with<G>(
        &self,
        input: &DirectoryChangeInput,
        trash: impl FnOnce(&Path) -> Result<()>,
        enter_fence: impl FnOnce() -> Result<G>,
    ) -> Result<DirectoryChangeResult> {
        if input.request_id.is_empty() || input.request_id.len() > 128 {
            return Err(failure("invalid_path", "无效请求标识"));
        }
        let operation = if input.name.is_some() {
            "file.directory.rename"
        } else {
            "file.directory.delete"
        };
        if self.native_workspace_id.as_deref() != Some(&input.binding.workspace_id) {
            return Err(failure("ownership_mismatch", "Workspace 已变更"));
        }
        if self.file_scope_archived(input.project_id)? {
            return Err(failure("ownership_mismatch", "归档项目不可修改"));
        }
        self.project_directory_recover_pending(Some(input.project_id))?;
        let _owner = self.directory_owner_lease(input.project_id)?;
        if let Some(result) = self
            .agent_operation_replay("gui", &input.request_id, operation, input)
            .map_err(|e| anyhow!(e.message))?
        {
            return Ok(result);
        }
        let (_, source) =
            self.directory_change_source(&input.binding, input.project_id, &input.relative_path)?;
        self.directory_require_no_pending(&source, input.project_id)?;
        let (prepared, members, root, source) =
            self.directory_prepared_locked(&input.binding, input.project_id, &input.relative_path)?;
        let _files = self.directory_member_leases(&members)?;
        // Recovery and all storage leases precede lifecycle admission. Closing
        // a Workspace can drain admitted writers without waiting on its fence.
        let _permit = enter_fence()?;
        if prepared.token != input.token {
            return Err(failure(
                "revision_conflict",
                "目录身份或文件集合已变化，请重新确认",
            ));
        }
        let target = if let Some(name) = &input.name {
            if name.trim() != name
                || name.is_empty()
                || name.starts_with('.')
                || name.contains(['/', '\\', ':', '\0'])
                || name == ".."
                || name.ends_with(['.', ' '])
            {
                return Err(failure("invalid_path", "文件夹名称必须是单个普通名称"));
            }
            let target = source.parent().unwrap().join(name);
            files::relative(&self.workspace_root, &target)?;
            self.directory_require_no_pending(&target, input.project_id)?;
            if present(&target)? {
                return Err(failure("revision_conflict", "同名文件夹或文件已存在"));
            }
            Some(target)
        } else {
            if input.confirmed != Some(true) {
                return Err(failure(
                    "confirmation_required",
                    "请确认将整个目录（包括未登记内容）移入系统回收站",
                ));
            }
            None
        };
        self.directory_check_tree(&source, &members)?;
        // The tree walk is external I/O: recheck the source and all CAS metadata.
        let fresh =
            self.directory_prepared_locked(&input.binding, input.project_id, &input.relative_path)?;
        if fresh.0.token != input.token {
            return Err(failure(
                "revision_conflict",
                "目录在操作前发生变化，请重新确认",
            ));
        }
        let intent = Intent {
            input: input.clone(),
            source: self.encode_path_ref(&source),
            target: target.as_ref().map(|p| self.encode_path_ref(p)),
            root: self.encode_path_ref(&root),
            root_identity: directory_identity(&root)?,
            parent_identity: directory_identity(source.parent().unwrap())?,
            identity: directory_identity(&source)?,
            members,
        };
        let directory = self.directory_persist_intent(&intent)?;
        crash_point(DirectoryPhase::Prepared);
        let outcome = (|| {
            self.directory_validate_intent(&intent)?;
            if target.is_none() {
                self.directory_retain_versions(&intent, true)?;
            }
            crash_point(DirectoryPhase::HistoryRetained);
            // Retaining history crosses filesystem I/O; its ancestor path may
            // have changed while the original directory identity stayed equal.
            self.directory_validate_intent(&intent)?;
            if directory_identity(&source)? != intent.identity {
                return Err(failure("revision_conflict", "目录身份已变化"));
            }
            if let Some(target) = &target {
                files::move_exclusive(&source, target)?;
            } else {
                trash(&source)?;
                files::sync_directory(source.parent().unwrap())?;
            }
            crash_point(DirectoryPhase::Moved);
            let (source, target) = self.directory_validate_intent(&intent)?;
            if let Some(target) = target {
                if present(&source)? || directory_identity(&target)? != intent.identity {
                    return Err(failure("revision_conflict", "改名后的目录发生冲突"));
                }
            } else if present(&source)? {
                return Err(failure(
                    "revision_conflict",
                    "目录尚未移入回收站或已被其他目录占用",
                ));
            }
            if intent.target.is_none() {
                self.directory_retain_versions(&intent, false)?;
            }
            let result = self.directory_commit_intent(&intent)?;
            crash_point(DirectoryPhase::Committed);
            if let Err(error) = clear(&directory) {
                eprintln!("Committed directory cleanup pending: {error:#}");
            }
            Ok(result)
        })();
        if outcome.is_err() {
            if let Err(error) = self.directory_recover_locked(&directory, &intent) {
                eprintln!("Directory recovery retained materials: {error}");
            }
            if let Some(result) = self
                .agent_operation_replay("gui", &input.request_id, operation, input)
                .map_err(|e| anyhow!(e.message))?
            {
                return Ok(result);
            }
        }
        outcome
    }
}

#[cfg(test)]
#[path = "project_directory_changes_recovery_tests.rs"]
mod recovery_tests;
#[cfg(test)]
#[path = "project_directory_changes_tests.rs"]
mod tests;
