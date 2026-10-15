//! Bounded server-owned File content staging. No public adapter or path input.
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::ObjectRef,
    },
    db::{
        file_versions::{self as files, FileIdentity, FileVersionUpdate, GuiFileVersionPrepare},
        Database,
    },
    file_version_service::{BoundFileCommitStore, FileVersionCommitResult},
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

pub(crate) const MAX_CONTENT: u64 = 100 * 1024 * 1024;
pub(crate) const MAX_CHUNK: usize = 1024 * 1024;
const TTL_MS: i64 = 600_000;
const MAX_STAGES: usize = 4;
const MAX_CHUNKS: usize = 100;
const MAX_MANIFEST: u64 = 65536;
const MAX_GENERATIONS: usize = 210;
const MAX_STAGE_ENTRIES: usize = 512;
const MAX_REGISTRY_ENTRIES: usize = 64;
const STAGES: &str = ".project-mind/file-content-stage";
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileContentBegin {
    pub object: ObjectRef,
    pub expected_version_number: u32,
    pub expected_content_hash: String,
    pub length: u64,
    pub content_hash: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileContentTicket {
    pub staged_content_id: String,
    pub length: u64,
    pub content_hash: String,
    pub expires_at_ms: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileContentStatus {
    pub ticket: FileContentTicket,
    pub received_length: u64,
    pub ready: bool,
    pub consumed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileContentUpdate {
    pub object: ObjectRef,
    pub expected_version_number: u32,
    pub expected_content_hash: String,
    pub staged_content_id: String,
}
pub(crate) trait FileContentClock {
    fn now_ms(&self) -> AgentResult<i64>;
}
pub(crate) struct SystemFileContentClock;
impl FileContentClock for SystemFileContentClock {
    fn now_ms(&self) -> AgentResult<i64> {
        Ok(chrono::Utc::now().timestamp_millis())
    }
}
pub(crate) struct FileContentService<'a, S, C> {
    store: &'a S,
    clock: &'a C,
}
fn error(code: ErrorCode, message: &str) -> AgentError {
    AgentError::new(code, message)
}
fn io(_: impl std::fmt::Display) -> AgentError {
    error(
        ErrorCode::IoFailed,
        "Cannot prepare or recover staged File content",
    )
}
fn expired() -> AgentError {
    error(
        ErrorCode::StagedContentExpired,
        "Staged File content is unavailable or expired",
    )
}
fn hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
pub(crate) fn valid_stage_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) fn valid_blob_name(name: &str) -> bool {
    name.strip_prefix("blob-")
        .and_then(|s| s.strip_suffix(".bin"))
        .is_some_and(valid_stage_id)
}
fn identity_name() -> String {
    format!("blob-{}.bin", files::token())
}
fn scope_hash(request: &RequestContext) -> AgentResult<String> {
    let mut projects = request.scope_grant.project_ids.clone();
    projects.sort_unstable();
    projects.dedup();
    let mut operations = request.scope_grant.operations.clone();
    operations.sort();
    operations.dedup();
    let bytes=serde_json::to_vec(&serde_json::json!({"workspace":request.scope_grant.workspace_id,
        "workspaceContent":request.scope_grant.workspace_content,"projects":projects,"operations":operations})).map_err(io)?;
    Ok(hash(&bytes))
}
impl FileContentBegin {
    fn validate(&self) -> AgentResult<()> {
        self.object.key()?;
        if self.object.kind != crate::agent::models::ObjectKind::File
            || self.expected_version_number == 0
            || !files::valid_hash(&self.expected_content_hash)
            || !files::valid_hash(&self.content_hash)
        {
            return Err(error(
                ErrorCode::InvalidArgument,
                "Invalid File upload baseline",
            ));
        }
        if self.length > MAX_CONTENT {
            return Err(error(
                ErrorCode::BudgetExceeded,
                "File upload exceeds 100 MiB",
            ));
        }
        Ok(())
    }
}
impl FileContentUpdate {
    fn validate(&self) -> AgentResult<()> {
        self.object.key()?;
        if self.expected_version_number == 0
            || !files::valid_hash(&self.expected_content_hash)
            || !valid_stage_id(&self.staged_content_id)
        {
            return Err(error(
                ErrorCode::InvalidArgument,
                "Invalid staged File update",
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Blob {
    name: String,
    len: u64,
    hash: String,
    identity: FileIdentity,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Chunk {
    offset: u64,
    request_id: String,
    blob: Blob,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Pending {
    Chunk { chunk: Chunk },
    Assembly { request_id: String, blob: Blob },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema: u8,
    ticket: FileContentTicket,
    begin: FileContentBegin,
    begin_request_id: String,
    caller: String,
    grant_hash: String,
    created_ms: i64,
    chunks: Vec<Chunk>,
    pending: Option<Pending>,
    assembled: Option<Blob>,
    commit_request_id: Option<String>,
    retired: bool,
}
impl Manifest {
    fn status(&self) -> FileContentStatus {
        FileContentStatus {
            ticket: self.ticket.clone(),
            received_length: self.chunks.iter().map(|c| c.blob.len).sum(),
            ready: self.assembled.is_some() && !self.retired,
            consumed: self.retired,
        }
    }
    fn alive(&self, now: i64) -> AgentResult<()> {
        if now < self.created_ms || now >= self.ticket.expires_at_ms {
            return Err(expired());
        }
        Ok(())
    }
    fn owner(&self, request: &RequestContext) -> AgentResult<()> {
        if self.caller != request.caller.key()
            || self.grant_hash != scope_hash(request)?
            || self.begin.object.workspace_id != request.binding.workspace_id
        {
            return Err(error(
                ErrorCode::ScopeDenied,
                "Staged File content is outside the caller scope",
            ));
        }
        Ok(())
    }
    fn validate(&self, id: &str) -> AgentResult<()> {
        self.begin.validate().map_err(|_| io("invalid manifest"))?;
        if self.schema != 1
            || self.ticket.staged_content_id != id
            || self.ticket.length != self.begin.length
            || self.ticket.content_hash != self.begin.content_hash
            || self.created_ms < 0
            || self.created_ms.checked_add(TTL_MS) != Some(self.ticket.expires_at_ms)
            || self.ticket.expires_at_ms > 9_007_199_254_740_991
            || self.caller.is_empty()
            || self.caller.len() > 256
            || !files::valid_hash(&self.grant_hash)
            || self.begin_request_id.is_empty()
            || self.begin_request_id.len() > 128
            || self.chunks.len() > MAX_CHUNKS
        {
            return Err(io("invalid manifest"));
        }
        let mut names = std::collections::HashSet::new();
        let mut offset = 0u64;
        let mut validate_blob = |blob: &Blob, limit: u64| -> AgentResult<()> {
            if !valid_blob_name(&blob.name)
                || !files::valid_hash(&blob.hash)
                || blob.len > limit
                || !names.insert(blob.name.clone())
            {
                return Err(io("invalid blob"));
            }
            Ok(())
        };
        for chunk in &self.chunks {
            validate_blob(&chunk.blob, MAX_CHUNK as u64)?;
            if chunk.offset != offset
                || chunk.blob.len == 0
                || chunk.request_id.is_empty()
                || chunk.request_id.len() > 128
            {
                return Err(io("invalid chunk"));
            }
            offset = offset
                .checked_add(chunk.blob.len)
                .ok_or_else(|| io("invalid length"))?;
        }
        if offset > self.ticket.length {
            return Err(io("invalid length"));
        }
        match &self.pending {
            Some(Pending::Chunk { chunk }) => {
                validate_blob(&chunk.blob, MAX_CHUNK as u64)?;
                if chunk.offset != offset
                    || chunk.blob.len == 0
                    || chunk.request_id.is_empty()
                    || chunk.request_id.len() > 128
                    || offset
                        .checked_add(chunk.blob.len)
                        .is_none_or(|n| n > self.ticket.length)
                {
                    return Err(io("invalid pending chunk"));
                }
            }
            Some(Pending::Assembly { request_id, blob }) => {
                validate_blob(blob, MAX_CONTENT)?;
                if request_id.is_empty()
                    || request_id.len() > 128
                    || blob.len != self.ticket.length
                    || blob.hash != self.ticket.content_hash
                    || offset != self.ticket.length
                {
                    return Err(io("invalid assembly"));
                }
            }
            None => (),
        }
        if let Some(blob) = &self.assembled {
            validate_blob(blob, MAX_CONTENT)?;
            if blob.len != self.ticket.length
                || blob.hash != self.ticket.content_hash
                || offset != self.ticket.length
                || self.pending.is_some()
            {
                return Err(io("invalid ready content"));
            }
        }
        if self
            .commit_request_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 128)
        {
            return Err(io("invalid commit reservation"));
        }
        Ok(())
    }
}
#[derive(Serialize)]
struct ChunkPayload<'a> {
    staged_content_id: &'a str,
    offset: u64,
    length: u64,
    content_hash: &'a str,
}
struct Stage {
    directory: PathBuf,
    _lock: File,
    generation: u32,
    manifest: Manifest,
    metadata: Vec<(PathBuf, FileIdentity, String)>,
}
fn readonly_lock(path: &Path) -> AgentResult<File> {
    files::regular(path).map_err(io)?;
    let before = files::path_identity(path).map_err(io)?;
    let file = crate::source_file_snapshot::open_regular(path)?;
    file.lock_exclusive().map_err(io)?;
    if files::identity(&file).map_err(io)? != before
        || files::path_identity(path).map_err(io)? != before
    {
        return Err(io("lock rebound"));
    }
    Ok(file)
}
fn create_lock(path: &Path) -> AgentResult<()> {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file.sync_all().map_err(io),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(io(e)),
    }
}
fn registry_lock(root: &Path) -> AgentResult<File> {
    let base = root.join(STAGES);
    files::create_owned_directories(root, &base).map_err(io)?;
    let path = base.join("registry.lock");
    create_lock(&path)?;
    readonly_lock(&path)
}
fn manifest_generation(name: &str) -> Option<u32> {
    let value = name.strip_prefix("manifest-")?.strip_suffix(".json")?;
    if value.len() != 8 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}
impl Stage {
    fn open(root: &Path, id: &str) -> AgentResult<Self> {
        if !valid_stage_id(id) {
            return Err(error(
                ErrorCode::InvalidArgument,
                "Invalid staged content ID",
            ));
        }
        let directory = root.join(STAGES).join(id);
        files::relative(root, &directory).map_err(io)?;
        if !directory.exists() {
            return Err(expired());
        }
        let lock = readonly_lock(&directory.join("stage.lock"))?;
        Self::load(directory, lock, id)
    }
    fn load(directory: PathBuf, lock: File, id: &str) -> AgentResult<Self> {
        let lock_identity = files::identity(&lock).map_err(io)?;
        if files::path_identity(&directory.join("stage.lock")).map_err(io)? != lock_identity {
            return Err(io("lock rebound"));
        }
        let mut generations = Vec::new();
        for (count, entry) in fs::read_dir(&directory).map_err(io)?.enumerate() {
            if count >= MAX_STAGE_ENTRIES {
                return Err(error(
                    ErrorCode::BudgetExceeded,
                    "File staging directory requires bounded recovery",
                ));
            }
            let entry = entry.map_err(io)?;
            if let Some(generation) = entry.file_name().to_str().and_then(manifest_generation) {
                generations.push(generation);
            }
            if generations.len() > MAX_GENERATIONS {
                return Err(io("too many manifests"));
            }
        }
        let generation = *generations.iter().max().ok_or_else(expired)?;
        let path = directory.join(format!("manifest-{generation:08}.json"));
        let mut file = crate::source_file_snapshot::open_regular(&path)?;
        if file.metadata().map_err(io)?.len() > MAX_MANIFEST {
            return Err(io("oversized manifest"));
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(MAX_MANIFEST + 1)
            .read_to_end(&mut bytes)
            .map_err(io)?;
        if bytes.len() as u64 > MAX_MANIFEST {
            return Err(io("oversized manifest"));
        }
        let manifest: Manifest = serde_json::from_slice(&bytes).map_err(io)?;
        manifest.validate(id)?;
        let mut metadata = Vec::new();
        for old_generation in generations {
            let old_path = directory.join(format!("manifest-{old_generation:08}.json"));
            let mut old_file = crate::source_file_snapshot::open_regular(&old_path)?;
            let old_identity = files::identity(&old_file).map_err(io)?;
            let mut old_bytes = Vec::new();
            Read::by_ref(&mut old_file)
                .take(MAX_MANIFEST + 1)
                .read_to_end(&mut old_bytes)
                .map_err(io)?;
            if old_bytes.len() as u64 > MAX_MANIFEST {
                return Err(io("oversized history"));
            }
            let old: Manifest = serde_json::from_slice(&old_bytes).map_err(io)?;
            old.validate(id)?;
            if old.ticket != manifest.ticket
                || old.caller != manifest.caller
                || old.grant_hash != manifest.grant_hash
                || old.begin_request_id != manifest.begin_request_id
                || old.created_ms != manifest.created_ms
                || serde_json::to_value(&old.begin).map_err(io)?
                    != serde_json::to_value(&manifest.begin).map_err(io)?
                || files::path_identity(&old_path).map_err(io)? != old_identity
            {
                return Err(io("foreign metadata"));
            }
            metadata.push((old_path, old_identity, hash(&old_bytes)));
        }
        Ok(Self {
            directory,
            _lock: lock,
            generation,
            manifest,
            metadata,
        })
    }
    fn publish(&mut self) -> AgentResult<()> {
        self.manifest
            .validate(&self.manifest.ticket.staged_content_id)?;
        let next = self
            .generation
            .checked_add(1)
            .filter(|n| (*n as usize) <= MAX_GENERATIONS)
            .ok_or_else(|| io("manifest budget"))?;
        let bytes = serde_json::to_vec(&self.manifest).map_err(io)?;
        if bytes.len() as u64 > MAX_MANIFEST {
            return Err(io("oversized manifest"));
        }
        let temp = self
            .directory
            .join(format!("manifest-tmp-{}", files::token()));
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(io)?;
        output.write_all(&bytes).map_err(io)?;
        output.sync_all().map_err(io)?;
        drop(output);
        let identity = files::path_identity(&temp).map_err(io)?;
        let final_path = self.directory.join(format!("manifest-{next:08}.json"));
        files::move_exclusive(&temp, &final_path).map_err(io)?;
        files::sync_directory(&self.directory).map_err(io)?;
        self.generation = next;
        self.metadata.push((final_path, identity, hash(&bytes)));
        Ok(())
    }
    fn empty_blob(&self, len: u64, hash: String) -> AgentResult<(Blob, File)> {
        let name = identity_name();
        let path = self.directory.join(&name);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(io)?;
        file.sync_all().map_err(io)?;
        files::sync_directory(&self.directory).map_err(io)?;
        let blob = Blob {
            name,
            len,
            hash,
            identity: files::identity(&file).map_err(io)?,
        };
        Ok((blob, file))
    }
    fn check(
        &self,
        db: &Database,
        request: &RequestContext,
        binding: &crate::agent::models::WorkspaceBinding,
        now: i64,
    ) -> AgentResult<()> {
        self.check_owned(db, request, binding, now, request)
    }
    fn check_owned(
        &self,
        db: &Database,
        request: &RequestContext,
        binding: &crate::agent::models::WorkspaceBinding,
        now: i64,
        owner: &RequestContext,
    ) -> AgentResult<()> {
        self.manifest.owner(owner)?;
        self.manifest.alive(now)?;
        db.file_version_registered_target(request, binding, &self.manifest.begin.object)?;
        let mut begin_request = owner.clone();
        begin_request.request_id = self.manifest.begin_request_id.clone();
        if db
            .file_content_begin_replay(&begin_request, binding, &self.manifest.begin)?
            .as_ref()
            != Some(&self.manifest.ticket)
        {
            return Err(error(
                ErrorCode::SourceNotReady,
                "Retry upload begin before sending content",
            ));
        }
        Ok(())
    }
    fn recover_receipted(&mut self, db: &Database) -> AgentResult<()> {
        let Some(pending) = self.manifest.pending.clone() else {
            return Ok(());
        };
        let committed = match &pending {
            Pending::Chunk { chunk } => {
                let payload = ChunkPayload {
                    staged_content_id: &self.manifest.ticket.staged_content_id,
                    offset: chunk.offset,
                    length: chunk.blob.len,
                    content_hash: &chunk.blob.hash,
                };
                db.agent_operation_replay::<FileContentStatus>(
                    &self.manifest.caller,
                    &chunk.request_id,
                    "file.content.stage.chunk",
                    &payload,
                )?
                .is_some()
            }
            Pending::Assembly { request_id, .. } => db
                .agent_operation_replay::<FileContentStatus>(
                    &self.manifest.caller,
                    request_id,
                    "file.content.stage.finish",
                    &self.manifest.ticket.staged_content_id,
                )?
                .is_some(),
        };
        if committed {
            let blob = match &pending {
                Pending::Chunk { chunk } => &chunk.blob,
                Pending::Assembly { blob, .. } => blob,
            };
            verify_blob(&self.directory, blob)?;
            match pending {
                Pending::Chunk { chunk } => self.manifest.chunks.push(chunk),
                Pending::Assembly { blob, .. } => self.manifest.assembled = Some(blob),
            }
            self.manifest.pending = None;
            self.publish()?;
        }
        Ok(())
    }
}
fn verify_blob(directory: &Path, blob: &Blob) -> AgentResult<()> {
    let path = directory.join(&blob.name);
    let mut file = crate::source_file_snapshot::open_regular(&path)?;
    let before =
        crate::source_file_snapshot::FileStamp::from_metadata(&file.metadata().map_err(io)?);
    if files::identity(&file).map_err(io)? != blob.identity
        || files::path_identity(&path).map_err(io)? != blob.identity
        || file.metadata().map_err(io)?.len() != blob.len
    {
        return Err(error(ErrorCode::SourceChanged, "Staged File bytes changed"));
    }
    let mut digest = Sha256::new();
    let mut reader = Read::by_ref(&mut file).take(blob.len + 1);
    let mut total = 0u64;
    let mut buffer = [0; 65536];
    loop {
        let count = reader.read(&mut buffer).map_err(io)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
        total += count as u64;
    }
    if total != blob.len
        || format!("sha256:{:x}", digest.finalize()) != blob.hash
        || before
            != crate::source_file_snapshot::FileStamp::from_metadata(&file.metadata().map_err(io)?)
        || before
            != crate::source_file_snapshot::FileStamp::from_metadata(
                &fs::symlink_metadata(&path).map_err(io)?,
            )
        || files::path_identity(&path).map_err(io)? != blob.identity
    {
        return Err(error(ErrorCode::SourceChanged, "Staged File bytes changed"));
    }
    Ok(())
}

#[cfg(unix)]
fn open_write(path: &Path) -> AgentResult<File> {
    use rustix::fs::{open, Mode, OFlags};
    open(
        path,
        OFlags::RDWR | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map(File::from)
    .map_err(io)
}
#[cfg(windows)]
fn open_write(path: &Path) -> AgentResult<File> {
    use std::os::windows::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(io)
}
#[cfg(not(any(unix, windows)))]
fn open_write(_: &Path) -> AgentResult<File> {
    Err(error(
        ErrorCode::RuntimeUnavailable,
        "File staging is unsupported",
    ))
}
fn owned_partial(directory: &Path, blob: &Blob) -> AgentResult<File> {
    let path = directory.join(&blob.name);
    let file = open_write(&path)?;
    if !file.metadata().map_err(io)?.is_file()
        || files::identity(&file).map_err(io)? != blob.identity
        || files::path_identity(&path).map_err(io)? != blob.identity
        || file.metadata().map_err(io)?.len() > blob.len
    {
        return Err(io("staged file rebound"));
    }
    Ok(file)
}
fn append_owned(file: &mut File, bytes: &[u8]) -> AgentResult<()> {
    let length = file.metadata().map_err(io)?.len() as usize;
    if length > bytes.len() {
        return Err(io("invalid partial length"));
    }
    let mut existing = Vec::with_capacity(length);
    file.seek(SeekFrom::Start(0)).map_err(io)?;
    Read::by_ref(file)
        .take(length as u64)
        .read_to_end(&mut existing)
        .map_err(io)?;
    if existing != bytes[..length] {
        return Err(error(
            ErrorCode::SourceChanged,
            "Partial staged bytes changed",
        ));
    }
    file.seek(SeekFrom::End(0)).map_err(io)?;
    file.write_all(&bytes[length..]).map_err(io)?;
    file.sync_all().map_err(io)
}
impl<'a, S: BoundFileCommitStore, C: FileContentClock> FileContentService<'a, S, C> {
    pub(crate) fn new(store: &'a S, clock: &'a C) -> Self {
        Self { store, clock }
    }
    fn now(&self) -> AgentResult<i64> {
        let now = self.clock.now_ms()?;
        if now < 0
            || now
                .checked_add(TTL_MS)
                .is_none_or(|n| n > 9_007_199_254_740_991)
        {
            return Err(error(ErrorCode::InvalidArgument, "Invalid upload clock"));
        }
        Ok(now)
    }
    pub(crate) fn begin(
        &self,
        request: &RequestContext,
        input: &FileContentBegin,
    ) -> AgentResult<FileContentTicket> {
        input.validate()?;
        let host = self.store.gui_commit_host(&request.binding)?;
        let db = host.database()?;
        if let Some(ticket) = db.file_content_begin_replay(request, host.binding(), input)? {
            let _permit = host.fence().enter()?;
            return Ok(ticket);
        }
        let target = db.file_version_registered_target(request, host.binding(), &input.object)?;
        let metadata = db.file_version_gui_metadata(&GuiFileVersionPrepare {
            document_id: target.id,
            project_id: target.project_id,
            managed_path: target.managed_path.clone(),
            expected_version_number: input.expected_version_number,
            source_path: None,
        })?;
        let registered = metadata.registered_content_hash.ok_or_else(|| {
            error(
                ErrorCode::FileChangedUnregistered,
                "Register current File bytes before uploading",
            )
        })?;
        if registered != input.expected_content_hash {
            return Err(error(
                ErrorCode::RevisionConflict,
                "File baseline hash changed",
            ));
        }
        files::relative(host.root(), Path::new(&target.managed_path)).map_err(io)?;
        if files::checksum(Path::new(&target.managed_path)).map_err(io)?
            != input.expected_content_hash
        {
            return Err(error(
                ErrorCode::FileChangedUnregistered,
                "File bytes differ from the registered baseline",
            ));
        }
        let now = self.now()?;
        let _permit = host.fence().enter()?;
        let _registry = registry_lock(host.root())?;
        if let Err(error) = sweep_locked(host.root(), &request.binding.workspace_id, now) {
            if error.code == ErrorCode::BudgetExceeded {
                return Err(error);
            }
            // One changed private stage must not deny all new uploads. It
            // remains counted against the bounded quota and is never erased.
            eprintln!("File upload cleanup pending: {}", error.message);
        }
        // Retry a begin whose metadata reached disk before its SQLite receipt.
        let mut count = 0;
        for (count_entry, entry) in fs::read_dir(host.root().join(STAGES))
            .map_err(io)?
            .enumerate()
        {
            if count_entry >= MAX_REGISTRY_ENTRIES {
                return Err(error(
                    ErrorCode::BudgetExceeded,
                    "File registry requires bounded recovery",
                ));
            }
            let entry = entry.map_err(io)?;
            let Some(id) = entry
                .file_name()
                .to_str()
                .filter(|s| valid_stage_id(s))
                .map(str::to_owned)
            else {
                continue;
            };
            count += 1;
            let stage = match Stage::open(host.root(), &id) {
                Ok(stage) => stage,
                Err(_) => continue,
            };
            if stage.manifest.caller == request.caller.key()
                && stage.manifest.begin_request_id == request.request_id
            {
                if serde_json::to_value(&stage.manifest.begin).map_err(io)?
                    != serde_json::to_value(input).map_err(io)?
                {
                    return Err(error(
                        ErrorCode::IdempotencyConflict,
                        "Upload request already belongs to another payload",
                    ));
                }
                stage.manifest.owner(request)?;
                stage.manifest.alive(now)?;
                return db.file_content_begin_persist(
                    request,
                    host.binding(),
                    input,
                    &stage.manifest.ticket,
                );
            }
        }
        if count >= MAX_STAGES {
            return Err(error(
                ErrorCode::BudgetExceeded,
                "Workspace has four pending File uploads; finish or expire them first",
            ));
        }
        let id = files::token();
        let directory = host.root().join(STAGES).join(&id);
        fs::create_dir(&directory).map_err(io)?;
        files::sync_directory(directory.parent().unwrap()).map_err(io)?;
        create_lock(&directory.join("stage.lock"))?;
        let lock = readonly_lock(&directory.join("stage.lock"))?;
        let ticket = FileContentTicket {
            staged_content_id: id,
            length: input.length,
            content_hash: input.content_hash.clone(),
            expires_at_ms: now + TTL_MS,
        };
        let mut stage = Stage {
            directory,
            _lock: lock,
            generation: 0,
            metadata: Vec::new(),
            manifest: Manifest {
                schema: 1,
                ticket: ticket.clone(),
                begin: input.clone(),
                begin_request_id: request.request_id.clone(),
                caller: request.caller.key(),
                grant_hash: scope_hash(request)?,
                created_ms: now,
                chunks: Vec::new(),
                pending: None,
                assembled: None,
                commit_request_id: None,
                retired: false,
            },
        };
        stage.publish()?;
        db.file_content_begin_persist(request, host.binding(), input, &ticket)
    }
    pub(crate) fn append(
        &self,
        request: &RequestContext,
        id: &str,
        offset: u64,
        bytes: &[u8],
    ) -> AgentResult<FileContentStatus> {
        if bytes.len() > MAX_CHUNK {
            return Err(error(
                ErrorCode::BudgetExceeded,
                "File chunks are limited to 1 MiB",
            ));
        }
        if bytes.is_empty() {
            return Err(error(
                ErrorCode::InvalidArgument,
                "Upload chunk must not be empty",
            ));
        }
        let host = self.store.gui_commit_host(&request.binding)?;
        let db = host.database()?;
        let mut stage = Stage::open(host.root(), id)?;
        stage.check(&db, request, host.binding(), self.now()?)?;
        {
            let _permit = host.fence().enter()?;
            stage.recover_receipted(&db)?;
        }
        let digest = hash(bytes);
        let payload = ChunkPayload {
            staged_content_id: id,
            offset,
            length: bytes.len() as u64,
            content_hash: &digest,
        };
        if let Some(status) = db.agent_operation_replay(
            &request.caller.key(),
            &request.request_id,
            "file.content.stage.chunk",
            &payload,
        )? {
            return Ok(status);
        }
        if let Some(chunk) = stage.manifest.chunks.iter().find(|c| c.offset == offset) {
            if chunk.blob.len != bytes.len() as u64 || chunk.blob.hash != digest {
                return Err(error(
                    ErrorCode::IdempotencyConflict,
                    "Chunk offset already has different bytes",
                ));
            }
            verify_blob(&stage.directory, &chunk.blob)?;
            let _permit = host.fence().enter()?;
            return db.agent_atomic_operation(
                &request.caller.key(),
                &request.request_id,
                "file.content.stage.chunk",
                &payload,
                |tx| {
                    crate::db::file_content::check_transaction(tx, &stage.manifest.begin)?;
                    Ok((stage.manifest.status(), None))
                },
            );
        }
        if stage.manifest.retired
            || stage.manifest.assembled.is_some()
            || stage.manifest.commit_request_id.is_some()
        {
            return Err(error(
                ErrorCode::IdempotencyConflict,
                "Staged File content is already sealed or consumed",
            ));
        }
        let received = stage.manifest.status().received_length;
        if offset != received
            || offset
                .checked_add(bytes.len() as u64)
                .is_none_or(|n| n > stage.manifest.ticket.length)
        {
            return Err(error(
                ErrorCode::InvalidArgument,
                "Chunk must append at the next offset within the declared length",
            ));
        }
        if stage.manifest.chunks.len() >= MAX_CHUNKS
            || stage.manifest.ticket.length - (offset + bytes.len() as u64)
                > (MAX_CHUNKS - stage.manifest.chunks.len() - 1) as u64 * MAX_CHUNK as u64
        {
            return Err(error(
                ErrorCode::BudgetExceeded,
                "File upload requires at most 100 chunks",
            ));
        }
        let chunk = match &stage.manifest.pending {
            Some(Pending::Chunk { chunk })
                if chunk.offset == offset
                    && chunk.blob.len == bytes.len() as u64
                    && chunk.blob.hash == digest
                    && chunk.request_id == request.request_id =>
            {
                chunk.clone()
            }
            Some(_) => {
                return Err(error(
                    ErrorCode::IdempotencyConflict,
                    "Another upload operation needs recovery",
                ))
            }
            None => {
                let _permit = host.fence().enter()?;
                let (blob, file) = stage.empty_blob(bytes.len() as u64, digest.clone())?;
                drop(file);
                let chunk = Chunk {
                    offset,
                    request_id: request.request_id.clone(),
                    blob,
                };
                stage.manifest.pending = Some(Pending::Chunk {
                    chunk: chunk.clone(),
                });
                stage.publish()?;
                crash_point(0);
                chunk
            }
        };
        let mut file = owned_partial(&stage.directory, &chunk.blob)?;
        append_owned(&mut file, bytes)?;
        drop(file);
        verify_blob(&stage.directory, &chunk.blob)?;
        crash_point(1);
        stage.manifest.alive(self.now()?)?;
        let _permit = host.fence().enter()?;
        let mut after = stage.manifest.clone();
        after.chunks.push(chunk);
        after.pending = None;
        let result = db.agent_atomic_operation(
            &request.caller.key(),
            &request.request_id,
            "file.content.stage.chunk",
            &payload,
            |tx| {
                crate::db::file_content::check_transaction(tx, &stage.manifest.begin)?;
                Ok((after.status(), None))
            },
        )?;
        crash_point(2);
        stage.manifest = after;
        stage.publish()?;
        Ok(result)
    }
    pub(crate) fn finish(
        &self,
        request: &RequestContext,
        id: &str,
    ) -> AgentResult<FileContentStatus> {
        let host = self.store.gui_commit_host(&request.binding)?;
        let db = host.database()?;
        let mut stage = Stage::open(host.root(), id)?;
        stage.check(&db, request, host.binding(), self.now()?)?;
        {
            let _permit = host.fence().enter()?;
            stage.recover_receipted(&db)?;
        }
        if let Some(result) = db.agent_operation_replay(
            &request.caller.key(),
            &request.request_id,
            "file.content.stage.finish",
            &id,
        )? {
            return Ok(result);
        }
        if stage.manifest.retired || stage.manifest.commit_request_id.is_some() {
            return Err(error(
                ErrorCode::IdempotencyConflict,
                "Upload content is already consumed",
            ));
        }
        if stage.manifest.assembled.is_some() {
            let _permit = host.fence().enter()?;
            return db.agent_atomic_operation(
                &request.caller.key(),
                &request.request_id,
                "file.content.stage.finish",
                &id,
                |tx| {
                    crate::db::file_content::check_transaction(tx, &stage.manifest.begin)?;
                    Ok((stage.manifest.status(), None))
                },
            );
        }
        if stage.manifest.status().received_length != stage.manifest.ticket.length {
            return Err(error(
                ErrorCode::SourceNotReady,
                "Upload length is incomplete",
            ));
        }
        let blob = match &stage.manifest.pending {
            Some(Pending::Assembly { request_id, blob }) if request_id == &request.request_id => {
                blob.clone()
            }
            Some(_) => {
                return Err(error(
                    ErrorCode::IdempotencyConflict,
                    "Another upload operation needs recovery",
                ))
            }
            None => {
                let _permit = host.fence().enter()?;
                let (blob, file) = stage.empty_blob(
                    stage.manifest.ticket.length,
                    stage.manifest.ticket.content_hash.clone(),
                )?;
                drop(file);
                stage.manifest.pending = Some(Pending::Assembly {
                    request_id: request.request_id.clone(),
                    blob: blob.clone(),
                });
                stage.publish()?;
                crash_point(3);
                blob
            }
        };
        let mut output = owned_partial(&stage.directory, &blob)?;
        let existing = output.metadata().map_err(io)?.len();
        let mut offset = 0u64;
        let mut digest = Sha256::new();
        for chunk in &stage.manifest.chunks {
            verify_blob(&stage.directory, &chunk.blob)?;
            let mut file =
                crate::source_file_snapshot::open_regular(&stage.directory.join(&chunk.blob.name))?;
            let mut bytes = Vec::new();
            Read::by_ref(&mut file)
                .take(MAX_CHUNK as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(io)?;
            if bytes.len() as u64 != chunk.blob.len || hash(&bytes) != chunk.blob.hash {
                return Err(error(
                    ErrorCode::SourceChanged,
                    "Upload chunk changed while assembling",
                ));
            }
            digest.update(&bytes);
            let prefix = existing.saturating_sub(offset).min(bytes.len() as u64) as usize;
            if prefix > 0 {
                let mut prior = vec![0; prefix];
                output.seek(SeekFrom::Start(offset)).map_err(io)?;
                output.read_exact(&mut prior).map_err(io)?;
                if prior != bytes[..prefix] {
                    return Err(error(
                        ErrorCode::SourceChanged,
                        "Partial assembled bytes changed",
                    ));
                }
            }
            if prefix < bytes.len() {
                output.seek(SeekFrom::End(0)).map_err(io)?;
                output.write_all(&bytes[prefix..]).map_err(io)?;
            }
            offset += bytes.len() as u64;
        }
        output.sync_all().map_err(io)?;
        drop(output);
        if offset != blob.len || format!("sha256:{:x}", digest.finalize()) != blob.hash {
            return Err(error(
                ErrorCode::SourceChanged,
                "Upload SHA-256 does not match the declared bytes",
            ));
        }
        verify_blob(&stage.directory, &blob)?;
        crash_point(4);
        stage.manifest.alive(self.now()?)?;
        let _permit = host.fence().enter()?;
        let mut after = stage.manifest.clone();
        after.assembled = Some(blob);
        after.pending = None;
        let result = db.agent_atomic_operation(
            &request.caller.key(),
            &request.request_id,
            "file.content.stage.finish",
            &id,
            |tx| {
                crate::db::file_content::check_transaction(tx, &stage.manifest.begin)?;
                Ok((after.status(), None))
            },
        )?;
        crash_point(5);
        stage.manifest = after;
        stage.publish()?;
        Ok(result)
    }
    pub(crate) fn status(
        &self,
        request: &RequestContext,
        id: &str,
    ) -> AgentResult<FileContentStatus> {
        let host = self.store.gui_commit_host(&request.binding)?;
        let db = host.database()?;
        let mut stage = Stage::open(host.root(), id)?;
        stage.check(&db, request, host.binding(), self.now()?)?;
        let _permit = host.fence().enter()?;
        stage.recover_receipted(&db)?;
        Ok(stage.manifest.status())
    }
    pub(crate) fn update(
        &self,
        request: &RequestContext,
        input: &FileContentUpdate,
    ) -> AgentResult<FileVersionCommitResult> {
        self.update_owned(request, input, false)
    }
    /// Adoption exists only for an already approved File output. Current GUI
    /// authority still controls the native write; the frozen run proves ownership.
    pub(crate) fn update_output(
        &self,
        request: &RequestContext,
        input: &FileContentUpdate,
    ) -> AgentResult<FileVersionCommitResult> {
        self.update_owned(request, input, true)
    }
    pub(crate) fn validate_output_stage(
        &self,
        request: &RequestContext,
        input: &FileContentUpdate,
        owner: &RequestContext,
    ) -> AgentResult<()> {
        input.validate()?;
        let host = self.store.gui_commit_host(&request.binding)?;
        let db = host.database()?;
        let stage = Stage::open(host.root(), &input.staged_content_id)?;
        stage.check_owned(&db, request, host.binding(), self.now()?, owner)?;
        if input.object != stage.manifest.begin.object
            || input.expected_version_number != stage.manifest.begin.expected_version_number
            || input.expected_content_hash != stage.manifest.begin.expected_content_hash
        {
            return Err(error(
                ErrorCode::ScopeDenied,
                "Upload belongs to a different File baseline",
            ));
        }
        if stage.manifest.retired || stage.manifest.commit_request_id.is_some() {
            return Err(error(
                ErrorCode::IdempotencyConflict,
                "Upload content is already consumed",
            ));
        }
        let blob = stage.manifest.assembled.as_ref().ok_or_else(|| {
            error(
                ErrorCode::SourceNotReady,
                "Seal uploaded bytes before staging a candidate",
            )
        })?;
        verify_blob(&stage.directory, blob)
    }
    fn update_owned(
        &self,
        request: &RequestContext,
        input: &FileContentUpdate,
        output: bool,
    ) -> AgentResult<FileVersionCommitResult> {
        input.validate()?;
        let host = self.store.gui_commit_host(&request.binding)?;
        let mut db = host.database()?;
        if let Some(receipt) = db.file_version_staged_replay(request, host.binding(), input)? {
            let _permit = host.fence().enter()?;
            let version_path = db.file_version_committed_path(&receipt).ok().flatten();
            return Ok(FileVersionCommitResult {
                receipt,
                version_path,
            });
        }
        let before = db.committed_change_watermark()?;
        let owner = if output {
            Some(db.agent_output_file_update_owner(request, host.binding(), input)?)
        } else {
            None
        };
        let opened = Stage::open(host.root(), &input.staged_content_id);
        // A concurrent retry may have settled and retired the stage while this
        // caller waited. The durable version receipt is authoritative.
        if let Some(receipt) = db.file_version_staged_replay(request, host.binding(), input)? {
            let _permit = host.fence().enter()?;
            let version_path = db.file_version_committed_path(&receipt).ok().flatten();
            return Ok(FileVersionCommitResult {
                receipt,
                version_path,
            });
        }
        let mut stage = opened?;
        stage.check_owned(
            &db,
            request,
            host.binding(),
            self.now()?,
            owner.as_ref().unwrap_or(request),
        )?;
        {
            let _permit = host.fence().enter()?;
            stage.recover_receipted(&db)?;
        }
        if input.object != stage.manifest.begin.object
            || input.expected_version_number != stage.manifest.begin.expected_version_number
            || input.expected_content_hash != stage.manifest.begin.expected_content_hash
        {
            return Err(error(
                ErrorCode::ScopeDenied,
                "Upload belongs to a different File baseline",
            ));
        }
        if stage
            .manifest
            .commit_request_id
            .as_ref()
            .is_some_and(|id| id != &request.request_id)
            || stage.manifest.retired
        {
            return Err(error(
                ErrorCode::IdempotencyConflict,
                "Staged content is bound to one commit request",
            ));
        }
        let blob = stage
            .manifest
            .assembled
            .as_ref()
            .ok_or_else(|| {
                error(
                    ErrorCode::SourceNotReady,
                    "Seal uploaded bytes before File commit",
                )
            })?
            .clone();
        verify_blob(&stage.directory, &blob)?;
        if stage.manifest.commit_request_id.is_none() {
            let _permit = host.fence().enter()?;
            stage.manifest.commit_request_id = Some(request.request_id.clone());
            stage.publish()?;
        }
        crash_point(6);
        let update = FileVersionUpdate {
            object: input.object.clone(),
            expected_version_number: input.expected_version_number,
            expected_content_hash: input.expected_content_hash.clone(),
            new_content_hash: blob.hash,
        };
        let result = db.file_version_staged_commit_bound(
            request,
            host.binding(),
            &update,
            &input.staged_content_id,
            &stage.directory.join(&blob.name),
            host.fence(),
            &|| stage.manifest.alive(self.now()?),
        );
        let committed = result.as_ref().is_ok_and(|outcome| outcome.committed);
        let result = result.map(|outcome| {
            let receipt = outcome.receipt;
            crash_point(7);
            let version_path = db.file_version_committed_path(&receipt).ok().flatten();
            stage.manifest.retired = true;
            if let Err(error) = stage.publish().and_then(|_| cleanup_blobs(&stage)) {
                eprintln!("Committed upload cleanup pending: {}", error.message);
            }
            FileVersionCommitResult {
                receipt,
                version_path,
            }
        });
        let changes = if committed && result.is_ok() {
            db.committed_changes_since(host.binding(), &request.request_id, before)
                .unwrap_or_else(|e| {
                    eprintln!("File upload notification capture failed: {}", e.message);
                    None
                })
        } else {
            None
        };
        drop(stage);
        drop(db);
        if let Some(changes) = changes {
            self.store.publish_committed(changes);
        }
        result
    }
}
fn cleanup_blobs(stage: &Stage) -> AgentResult<()> {
    let mut blobs: Vec<(&Blob, bool)> = stage
        .manifest
        .chunks
        .iter()
        .map(|c| (&c.blob, true))
        .collect();
    if let Some(blob) = &stage.manifest.assembled {
        blobs.push((blob, true));
    }
    match &stage.manifest.pending {
        Some(Pending::Chunk { chunk }) => blobs.push((&chunk.blob, false)),
        Some(Pending::Assembly { blob, .. }) => blobs.push((blob, false)),
        None => (),
    }
    for (blob, complete) in blobs {
        let path = stage.directory.join(&blob.name);
        if !path.exists() {
            continue;
        }
        if files::path_identity(&path).map_err(io)? != blob.identity {
            return Err(io("foreign staged bytes"));
        }
        let length = fs::metadata(&path).map_err(io)?.len();
        if length > blob.len {
            return Err(io("foreign staged length"));
        }
        if complete {
            verify_blob(&stage.directory, blob)?;
        }
        fs::remove_file(&path).map_err(io)?;
    }
    files::sync_directory(&stage.directory).map_err(io)
}
fn sweep_locked(root: &Path, workspace_id: &str, now: i64) -> AgentResult<()> {
    let mut directories = Vec::new();
    for (count, entry) in fs::read_dir(root.join(STAGES)).map_err(io)?.enumerate() {
        if count >= MAX_REGISTRY_ENTRIES {
            return Err(error(
                ErrorCode::BudgetExceeded,
                "File registry requires bounded recovery",
            ));
        }
        let entry = entry.map_err(io)?;
        if entry.file_name().to_str().is_some_and(valid_stage_id) {
            directories.push(entry.path());
        }
        if directories.len() > MAX_STAGES + 1 {
            return Err(error(
                ErrorCode::BudgetExceeded,
                "File staging needs bounded recovery",
            ));
        }
    }
    let mut failure = None;
    for directory in directories {
        let result = (|| -> AgentResult<()> {
            files::relative(root, &directory).map_err(io)?;
            let path = directory.join("stage.lock");
            if !path.exists() {
                return Ok(());
            }
            let lock = crate::source_file_snapshot::open_regular(&path)?;
            match lock.try_lock_exclusive() {
                Ok(()) => (),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
                Err(e) => return Err(io(e)),
            }
            let id = directory.file_name().unwrap().to_str().unwrap();
            let mut stage = match Stage::load(directory.clone(), lock, id) {
                Ok(stage) => stage,
                Err(e) if e.code == ErrorCode::StagedContentExpired => return Ok(()),
                Err(_) => return Ok(()),
            };
            if stage.manifest.begin.object.workspace_id != workspace_id {
                return Ok(());
            }
            if stage.manifest.retired || stage.manifest.alive(now).is_err() {
                if !stage.manifest.retired {
                    stage.manifest.retired = true;
                    stage.publish()?;
                }
                cleanup_blobs(&stage)?;
                let entries = fs::read_dir(&directory)
                    .map_err(io)?
                    .take(MAX_STAGE_ENTRIES + 1)
                    .map(|e| e.map(|e| e.path()))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(io)?;
                if entries.len() > MAX_STAGE_ENTRIES {
                    return Err(error(
                        ErrorCode::BudgetExceeded,
                        "File staging directory requires bounded recovery",
                    ));
                }
                // Preserve unknown data or interrupted metadata temporaries for
                // diagnostics. Never recursively erase a private directory.
                if entries.iter().any(|p| {
                    p.file_name().and_then(|s| s.to_str()).is_none_or(|name| {
                        name != "stage.lock" && manifest_generation(name).is_none()
                    })
                }) {
                    return Ok(());
                }
                for (entry, identity, digest) in &stage.metadata {
                    if files::path_identity(entry).map_err(io)? != *identity
                        || files::checksum(entry).map_err(io)? != *digest
                    {
                        return Err(io("foreign metadata"));
                    }
                }
                if entries.len() != stage.metadata.len() + 1
                    || files::path_identity(&path).map_err(io)?
                        != files::identity(&stage._lock).map_err(io)?
                {
                    return Err(io("foreign stage lock"));
                }
                for (entry, _, _) in &stage.metadata {
                    fs::remove_file(entry).map_err(io)?;
                }
                fs::remove_file(&path).map_err(io)?;
                drop(stage);
                fs::remove_dir(&directory).map_err(io)?;
                files::sync_directory(directory.parent().unwrap()).map_err(io)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            if failure.is_none() {
                failure = Some(error);
            }
        }
    }
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(())
}
pub(crate) fn recover_expired(root: &Path, workspace_id: &str, now: i64) -> AgentResult<()> {
    let base = root.join(STAGES);
    if !base.exists() {
        return Ok(());
    }
    let _lock = registry_lock(root)?;
    sweep_locked(root, workspace_id, now)
}
fn crash_point(stage: u8) {
    #[cfg(test)]
    if std::env::var("MIND_FILE_CONTENT_CRASH_STAGE")
        .ok()
        .and_then(|s| s.parse().ok())
        == Some(stage)
    {
        #[cfg(unix)]
        {
            unsafe extern "C" {
                fn kill(pid: i32, signal: i32) -> i32;
            }
            let result = unsafe { kill(std::process::id() as i32, 9) };
            assert_eq!(
                result,
                0,
                "Cannot kill crash fixture: {}",
                std::io::Error::last_os_error()
            );
            // Wait for SIGKILL instead of letting exit() win on another thread.
            loop {
                std::thread::park();
            }
        }
        #[cfg(not(unix))]
        std::process::exit(93);
    }
    #[cfg(not(test))]
    let _ = stage;
}
