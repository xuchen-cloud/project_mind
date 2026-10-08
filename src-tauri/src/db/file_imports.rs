//! Native File import reuses the authoritative File/Version tables.
use super::{
    agent_operations::{io_error, OperationChange},
    file_versions::{
        checksum, create_owned_directories, identity, move_exclusive, owned, path_identity,
        regular, relative, snapshot, sync_directory, token, valid_hash, FileIdentity,
    },
    Database,
};
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
    },
    models::{DocumentImportClipboardImageInput, DocumentImportInput, DocumentRecord},
    workspace_commit_fence::WorkspaceCommitFence,
};
use anyhow::{anyhow, bail, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentFileCreateInput {
    pub project_id: i64,
    pub safe_name: String,
    pub utf8_content: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentFileCreateResult {
    pub operation_id: String,
    pub object: ObjectRef,
    pub version_number: u32,
    pub content_hash: String,
}
/// Pure candidate validation is shared by staging and the native commit entry.
pub(crate) fn validate_agent_file_create(input: &AgentFileCreateInput) -> AgentResult<()> {
    let name = &input.safe_name;
    let base = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            base.strip_prefix(prefix)
                .is_some_and(|n| n.len() == 1 && matches!(n.as_bytes()[0], b'1'..=b'9'))
        });
    let extension = Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if input.project_id <= 0
        || name.is_empty()
        || name.len() > 255
        || name.trim() != name
        || name.ends_with('.')
        || reserved
        || name.chars().any(|c| {
            c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        })
        || Path::new(name).components().count() != 1
        || !matches!(extension.as_str(), "md" | "txt" | "html" | "htm")
    {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Expected one safe .md/.txt/.html/.htm filename in an actual Project",
        ));
    }
    if input.utf8_content.len() > 2 * 1024 * 1024 {
        return Err(AgentError::new(
            ErrorCode::BudgetExceeded,
            "UTF-8 File creation exceeds 2 MiB",
        ));
    }
    Ok(())
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentImportIntent {
    caller_id: String,
    request_id: String,
    payload_hash: String,
    operation_id: String,
}
struct AgentImport<'a> {
    request: &'a RequestContext,
    binding: &'a WorkspaceBinding,
    input: &'a AgentFileCreateInput,
    fence: &'a WorkspaceCommitFence,
}
enum ImportOutcome {
    Gui(DocumentRecord),
    Agent(AgentFileCreateResult),
}
#[derive(Debug)]
struct AgentImportFailure(AgentError);
impl std::fmt::Display for AgentImportFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0.message)
    }
}
impl std::error::Error for AgentImportFailure {}
fn agent_import_error(error: anyhow::Error) -> AgentError {
    error
        .downcast_ref::<AgentImportFailure>()
        .map(|error| error.0.clone())
        .unwrap_or_else(|| {
            AgentError::new(ErrorCode::IoFailed, "Cannot create the managed UTF-8 File")
        })
}
fn import_payload_hash(input: &AgentFileCreateInput) -> AgentResult<String> {
    let value = serde_json::to_value(input)
        .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Invalid File intent"))?;
    let bytes = serde_json::to_vec(&value)
        .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Invalid File intent"))?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

const IMPORT_JOURNALS: &str = ".project-mind/file-import-journal";
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportJournal {
    schema_version: u32,
    workspace_id: Option<String>,
    request_id: String,
    project_id: i64,
    document_id: i64,
    name: String,
    target: String,
    source_ref: String,
    mime_type: String,
    content_hash: String,
    identity: FileIdentity,
    adopt_existing: bool,
    storage_mode: String,
    is_starred: bool,
    tag_ids: Vec<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_intent: Option<AgentImportIntent>,
}
#[derive(Serialize, Deserialize)]
struct ImportReceipt {
    document_id: i64,
    content_hash: String,
}
enum ImportSource {
    File(PathBuf),
    Clipboard { bytes: Vec<u8>, mime_type: String },
    Utf8 { bytes: Vec<u8>, mime_type: String },
}
#[derive(Clone, Copy)]
enum ImportPhase {
    Staged,
    Prepared,
    Placed,
    BeforeSqlCommit,
    Committed,
}
fn import_crash_point(phase: ImportPhase) {
    #[cfg(test)]
    if std::env::var("MIND_FILE_IMPORT_CRASH_STAGE")
        .ok()
        .and_then(|value| value.parse::<u8>().ok())
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
impl Database {
    fn agent_file_create_authorize(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &AgentFileCreateInput,
    ) -> AgentResult<()> {
        if self.native_workspace_id.as_deref() != Some(binding.workspace_id.as_str()) {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "File Workspace binding changed",
            ));
        }
        let object = ObjectRef {
            workspace_id: binding.workspace_id.clone(),
            scope: Scope::Project {
                project_id: input.project_id,
            },
            kind: ObjectKind::Project,
            id: input.project_id.to_string(),
        };
        request.authorize(binding, &object.scope, "content.create")?;
        let actual = self
            .agent_resolve_object(&object, &binding.workspace_id)?
            .ok_or_else(|| AgentError::new(ErrorCode::NotFound, "Project no longer exists"))?;
        request.authorize_object(binding, &object, &actual, "content.create")?;
        self.source_live_scope(&actual.scope)
    }
    pub(crate) fn agent_file_create_bound(
        &mut self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &AgentFileCreateInput,
        fence: &WorkspaceCommitFence,
    ) -> AgentResult<AgentFileCreateResult> {
        validate_agent_file_create(input)?;
        self.agent_file_create_authorize(request, binding, input)?;
        if let Some(previous) = self.agent_operation_replay(
            &request.caller.key(),
            &request.request_id,
            "file.create",
            input,
        )? {
            let _commit = fence.enter()?;
            return Ok(previous);
        }
        let agent = AgentImport {
            request,
            binding,
            input,
            fence,
        };
        let source = ImportSource::Utf8 {
            bytes: input.utf8_content.as_bytes().to_vec(),
            mime_type: mime_guess::from_path(&input.safe_name)
                .first_or_octet_stream()
                .essence_str()
                .to_owned(),
        };
        match self
            .file_import_commit_inner(
                input.project_id,
                input.safe_name.clone(),
                false,
                &[],
                source,
                Some(&agent),
            )
            .map_err(agent_import_error)?
        {
            ImportOutcome::Agent(result) => Ok(result),
            ImportOutcome::Gui(_) => unreachable!("Agent creation carries an intent"),
        }
    }
    /// Reconstruct a pre-registration File for migration/freshness fixtures.
    /// Neither a receipt nor an outbox hash can replace its missing version
    /// registration. Production imports always register their captured bytes.
    #[cfg(test)]
    pub(super) fn document_import_legacy_fixture(
        &mut self,
        input: DocumentImportInput,
    ) -> Result<DocumentRecord> {
        let record = self.document_import(input)?;
        self.conn.execute("DELETE FROM source_file_version_hashes WHERE document_version_id IN (SELECT id FROM document_versions WHERE document_id=?1)", [record.id])?;
        Ok(record)
    }
    fn file_import_clear(&self, directory: &Path) -> Result<()> {
        fs::remove_dir_all(directory)?;
        sync_directory(directory.parent().unwrap())
    }
    fn file_import_recover(&self, directory: &Path, journal: &ImportJournal) -> Result<()> {
        if journal.schema_version != 1
            || journal.workspace_id != self.native_workspace_id
            || journal.project_id <= 0
            || journal.document_id <= 0
            || !valid_hash(&journal.content_hash)
            || journal.request_id.len() != 32
            || !journal
                .request_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || !matches!(
                journal.storage_mode.as_str(),
                "managed_copy" | "managed_existing" | "managed_clipboard"
            )
            || journal.adopt_existing != (journal.storage_mode == "managed_existing")
            || Path::new(&journal.name).components().count() != 1
            || Path::new(&journal.name)
                .file_name()
                .and_then(|name| name.to_str())
                != Some(journal.name.as_str())
        {
            bail!("Invalid File import journal");
        }
        let target = owned(&self.workspace_root, &journal.target)?;
        let committed = if let Some(intent) = &journal.agent_intent {
            if intent.caller_id.is_empty()
                || intent.caller_id.len() > 256
                || intent.request_id.is_empty()
                || intent.request_id.len() > 128
                || !valid_hash(&intent.payload_hash)
                || intent.operation_id.len() != 32
                || !intent
                    .operation_id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || journal.adopt_existing
                || journal.storage_mode != "managed_copy"
                || journal.is_starred
                || !journal.tag_ids.is_empty()
            {
                bail!("Invalid Agent File import journal");
            }
            let row:Option<(String,String,String,Option<String>)>=self.conn.query_row("SELECT payload_hash,operation,state,result_json FROM agent_operation_receipts WHERE caller_id=?1 AND request_id=?2",params![intent.caller_id,intent.request_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
            if let Some((hash, operation, state, result)) = row {
                if hash != intent.payload_hash || operation != "file.create" || state != "committed"
                {
                    bail!("Agent File import receipt identity mismatch; journal retained");
                }
                let result: AgentFileCreateResult = serde_json::from_str(
                    &result.ok_or_else(|| anyhow!("Missing Agent File import result"))?,
                )?;
                if result.operation_id != intent.operation_id
                    || result.object
                        != (ObjectRef {
                            workspace_id: journal
                                .workspace_id
                                .clone()
                                .ok_or_else(|| anyhow!("Missing File Workspace identity"))?,
                            scope: Scope::Project {
                                project_id: journal.project_id,
                            },
                            kind: ObjectKind::File,
                            id: journal.document_id.to_string(),
                        })
                    || result.version_number != 1
                    || result.content_hash != journal.content_hash
                {
                    bail!("Agent File import receipt result mismatch; journal retained");
                }
                true
            } else {
                false
            }
        } else {
            let committed: Option<ImportReceipt> = self
                .agent_operation_replay("gui", &journal.request_id, "file.import", journal)
                .map_err(|error| anyhow!(error.message))?;
            if let Some(receipt) = &committed {
                if receipt.document_id != journal.document_id
                    || receipt.content_hash != journal.content_hash
                {
                    bail!("File import receipt mismatch");
                }
            }
            committed.is_some()
        };
        if committed {
            return self.file_import_clear(directory);
        }
        let project = self.project_record(journal.project_id)?;
        if target != Path::new(&project.root_path).join(&journal.name) {
            bail!("File import target is outside its actual Project");
        }
        if !journal.adopt_existing && target.exists() {
            let referenced: bool = self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM documents WHERE managed_path=?1)",
                [self.encode_path_ref(&target)],
                |row| row.get(0),
            )?;
            if referenced
                || checksum(&target)? != journal.content_hash
                || path_identity(&target)? != journal.identity
            {
                bail!("File import target is occupied; journal retained");
            }
            fs::remove_file(&target)?;
            sync_directory(target.parent().unwrap())?;
        }
        self.file_import_clear(directory)
    }
    pub(super) fn file_import_recover_pending(&self) -> Result<()> {
        let base = self.workspace_root.join(IMPORT_JOURNALS);
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
                bail!("Invalid File import directory");
            }
            let directory = entry.path();
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| anyhow!("Invalid import directory encoding"))?;
            let (id, nonce) = name
                .split_once('-')
                .ok_or_else(|| anyhow!("Invalid import directory"))?;
            let project_id: i64 = id.parse()?;
            if project_id <= 0
                || project_id.to_string() != id
                || nonce.len() != 32
                || !nonce
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            {
                bail!("Invalid import identity");
            }
            // Same lock order as import, including descriptor-less live staging.
            let _project_lock = self.file_project_lock(project_id, false)?;
            let _import_lock = self.file_storage_lock("file-import-locks", project_id, true)?;
            if !directory.exists() {
                continue;
            }
            let descriptor = directory.join("journal.json");
            if !descriptor.exists() {
                self.file_import_clear(&directory)?;
                continue;
            }
            regular(&descriptor)?;
            if fs::metadata(&descriptor)?.len() > 16384 {
                bail!("File import journal exceeds metadata budget");
            }
            let journal: ImportJournal = serde_json::from_slice(&fs::read(&descriptor)?)?;
            if journal.project_id != project_id || journal.request_id != nonce {
                bail!("Import journal identity mismatch");
            }
            self.file_import_recover(&directory, &journal)?;
        }
        Ok(())
    }
    pub fn document_import(&mut self, input: DocumentImportInput) -> Result<DocumentRecord> {
        let source = PathBuf::from(&input.source_path);
        let name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| anyhow!("Invalid File source name"))?
            .to_owned();
        self.file_import_commit(
            input.project_id,
            name,
            input.is_starred,
            input.tag_ids.as_deref().unwrap_or_default(),
            ImportSource::File(source),
        )
    }
    pub fn document_import_clipboard_image(
        &mut self,
        input: DocumentImportClipboardImageInput,
    ) -> Result<DocumentRecord> {
        const MAX_BYTES: usize = 100 * 1024 * 1024;
        let name = super::sanitize_import_file_name(&input.file_name, &input.mime_type)?;
        let encoded = input.data_base64.trim();
        if encoded.len() > MAX_BYTES.div_ceil(3) * 4 {
            bail!("Clipboard File exceeds 100 MiB; use local File import");
        }
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| anyhow!("Invalid clipboard File encoding"))?;
        if bytes.len() > MAX_BYTES {
            bail!("Clipboard File exceeds 100 MiB; use local File import");
        }
        self.file_import_commit(
            input.project_id,
            name,
            input.is_starred,
            input.tag_ids.as_deref().unwrap_or_default(),
            ImportSource::Clipboard {
                bytes,
                mime_type: input.mime_type,
            },
        )
    }
    fn file_import_register_transaction(
        &self,
        tx: &Transaction<'_>,
        journal: &ImportJournal,
        target: &Path,
        history: &Path,
    ) -> AgentResult<(ImportReceipt, Option<OperationChange>)> {
        let document_id = journal.document_id;
        let stamp = super::now_iso();
        use crate::agent::errors::{AgentError, ErrorCode};
        self.ensure_document_name_available(journal.project_id, &journal.name, None)
            .map_err(|_| {
                AgentError::new(
                    ErrorCode::RevisionConflict,
                    "File name changed before registration",
                )
            })?;
        tx.execute(
                        "INSERT INTO documents(id,project_id,name,base_name,original_path,managed_path,history_dir_path,storage_mode,mime_type,is_starred,current_version_number,version_count,health,created_at,updated_at)
                         VALUES (?1,?2,?3,?3,?4,?5,?6,?7,?8,?9,1,1,'normal',?10,?10)",
                        params![document_id, journal.project_id, journal.name,
                            journal.source_ref, self.encode_path_ref(&target),
                            self.encode_path_ref(&history), journal.storage_mode,
                            journal.mime_type, super::bool_to_int(journal.is_starred), stamp],
                    ).map_err(io_error)?;
        tx.execute(
                        "INSERT INTO document_versions(document_id,version_number,name,source_path,managed_path,created_at)
                         VALUES (?1,1,?2,?3,?4,?5)",
                        params![document_id, journal.name, journal.source_ref,
                            self.encode_path_ref(&target), stamp],
                    ).map_err(io_error)?;
        let version_id = tx.last_insert_rowid();
        tx.execute(
                        "INSERT INTO source_file_version_hashes(document_version_id,content_hash) VALUES (?1,?2)",
                        params![version_id, journal.content_hash],
                    ).map_err(io_error)?;
        for tag in &journal.tag_ids {
            self.scoped_file_tag_record(Some(journal.project_id), *tag)
                .map_err(|_| {
                    AgentError::new(
                        ErrorCode::ScopeDenied,
                        "File tag is outside the actual Project",
                    )
                })?;
            tx.execute(
                "INSERT INTO document_tag_links(document_id,tag_id,created_at) VALUES (?1,?2,?3)",
                params![document_id, tag, stamp],
            )
            .map_err(io_error)?;
        }
        tx.execute(
            "UPDATE projects SET updated_at=?1 WHERE id=?2",
            params![stamp, journal.project_id],
        )
        .map_err(io_error)?;
        let change = if let Some(workspace_id) = &journal.workspace_id {
            let object = ObjectRef {
                workspace_id: workspace_id.clone(),
                scope: Scope::Project {
                    project_id: journal.project_id,
                },
                kind: ObjectKind::File,
                id: document_id.to_string(),
            };
            Some(OperationChange {
                object_key: object.key()?,
                scope: object.scope,
                revision: journal.content_hash.clone(),
            })
        } else {
            None
        };
        import_crash_point(ImportPhase::BeforeSqlCommit);
        Ok((
            ImportReceipt {
                document_id,
                content_hash: journal.content_hash.clone(),
            },
            change,
        ))
    }
    fn file_import_commit(
        &mut self,
        project_id: i64,
        name: String,
        is_starred: bool,
        tags: &[i64],
        source: ImportSource,
    ) -> Result<DocumentRecord> {
        match self.file_import_commit_inner(project_id, name, is_starred, tags, source, None)? {
            ImportOutcome::Gui(record) => Ok(record),
            ImportOutcome::Agent(_) => unreachable!("GUI import has no Agent intent"),
        }
    }
    fn file_import_commit_inner(
        &mut self,
        project_id: i64,
        name: String,
        is_starred: bool,
        tags: &[i64],
        source: ImportSource,
        agent: Option<&AgentImport<'_>>,
    ) -> Result<ImportOutcome> {
        self.file_version_recover_pending()?;
        let _project_lock = self.file_project_lock(project_id, false)?;
        let _import_lock = self.file_storage_lock("file-import-locks", project_id, true)?;
        if let Some(agent) = agent {
            self.agent_file_create_authorize(agent.request, agent.binding, agent.input)
                .map_err(AgentImportFailure)?;
            if let Some(previous) = self
                .agent_operation_replay(
                    &agent.request.caller.key(),
                    &agent.request.request_id,
                    "file.create",
                    agent.input,
                )
                .map_err(AgentImportFailure)?
            {
                let _commit = agent.fence.enter().map_err(AgentImportFailure)?;
                return Ok(ImportOutcome::Agent(previous));
            }
        }
        self.ensure_project_file_layout(project_id)?;
        let project = self.project_record(project_id)?;
        if let ImportSource::File(path) = &source {
            regular(path)?;
        }
        self.ensure_document_name_available(project_id, &name, None)
            .map_err(|error| {
                if agent.is_some() {
                    anyhow::Error::new(AgentImportFailure(AgentError::new(
                        ErrorCode::RevisionConflict,
                        "File name is already registered in the actual Project",
                    )))
                } else {
                    error
                }
            })?;
        let target = Path::new(&project.root_path).join(&name);
        let target_ref = relative(&self.workspace_root, &target)?;
        let adopt_existing = matches!(&source, ImportSource::File(path) if path == &target);
        if target.exists() && !adopt_existing {
            if agent.is_some() {
                return Err(AgentImportFailure(AgentError::new(
                    ErrorCode::RevisionConflict,
                    "Target File already exists",
                ))
                .into());
            }
            bail!("Target File already exists");
        }
        let tag_ids = super::normalize_file_tag_ids(tags);
        for tag in &tag_ids {
            self.scoped_file_tag_record(Some(project_id), *tag)?;
        }
        // Existing tables allocate the authoritative File ID. Serialize its
        // reservation across Projects without inserting an uncommitted stub.
        let _identity_lock = self.file_storage_lock("file-import-identities", 1, true)?;
        let last_id: i64 = self.conn.query_row("SELECT MAX(COALESCE((SELECT MAX(id) FROM documents),0),COALESCE((SELECT seq FROM sqlite_sequence WHERE name='documents'),0))", [], |row| row.get(0))?;
        let document_id = last_id
            .checked_add(1)
            .ok_or_else(|| anyhow!("File identity exhausted"))?;
        let history = self.history_dir_path_for(&target, document_id);
        relative(&self.workspace_root, &history)?;
        if history == target || history.exists() {
            bail!("New File history path is already occupied");
        }
        crate::source_search_index::SourceIndex::prepare(&self.conn)
            .map_err(|error| anyhow!(error.message))?;
        let base = self.workspace_root.join(IMPORT_JOURNALS);
        create_owned_directories(&self.workspace_root, &base)?;
        let request_id = token();
        let directory = base.join(format!("{project_id}-{request_id}"));
        fs::create_dir(&directory)?;
        sync_directory(&base)?;
        let prepared = (|| -> Result<ImportJournal> {
            let (content_hash, file_identity, source_ref, mime_type, storage_mode) = match &source {
                ImportSource::File(path) => {
                    let (hash, source_identity, new_identity) =
                        snapshot(path, &directory.join("new.bin"))?;
                    (
                        hash,
                        if adopt_existing {
                            source_identity
                        } else {
                            new_identity
                        },
                        self.encode_path_ref(path),
                        mime_guess::from_path(path)
                            .first_or_octet_stream()
                            .essence_str()
                            .to_owned(),
                        if adopt_existing {
                            "managed_existing"
                        } else {
                            "managed_copy"
                        }
                        .to_owned(),
                    )
                }
                ImportSource::Clipboard { bytes, mime_type }
                | ImportSource::Utf8 { bytes, mime_type } => {
                    let mut output = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(directory.join("new.bin"))?;
                    let mut digest = Sha256::new();
                    for chunk in bytes.chunks(65536) {
                        output.write_all(chunk)?;
                        digest.update(chunk);
                    }
                    output.sync_all()?;
                    (
                        format!("sha256:{:x}", digest.finalize()),
                        identity(&output)?,
                        self.encode_path_ref(&target),
                        mime_type.clone(),
                        if matches!(&source, ImportSource::Utf8 { .. }) {
                            "managed_copy"
                        } else {
                            "managed_clipboard"
                        }
                        .into(),
                    )
                }
            };
            import_crash_point(ImportPhase::Staged);
            let journal = ImportJournal {
                schema_version: 1,
                workspace_id: self.native_workspace_id.clone(),
                request_id,
                project_id,
                document_id,
                name,
                target: target_ref,
                source_ref,
                mime_type,
                content_hash,
                identity: file_identity,
                adopt_existing,
                storage_mode,
                is_starred,
                tag_ids,
                agent_intent: agent
                    .map(|agent| {
                        Ok::<_, AgentError>(AgentImportIntent {
                            caller_id: agent.request.caller.key(),
                            request_id: agent.request.request_id.clone(),
                            payload_hash: import_payload_hash(agent.input)?,
                            operation_id: token(),
                        })
                    })
                    .transpose()
                    .map_err(AgentImportFailure)?,
            };
            let bytes = serde_json::to_vec(&journal)?;
            if bytes.len() > 16384 {
                bail!("File import journal exceeds metadata budget");
            }
            let mut descriptor = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(directory.join("journal.tmp"))?;
            descriptor.write_all(&bytes)?;
            descriptor.sync_all()?;
            drop(descriptor);
            move_exclusive(
                &directory.join("journal.tmp"),
                &directory.join("journal.json"),
            )?;
            sync_directory(&directory)?;
            import_crash_point(ImportPhase::Prepared);
            Ok(journal)
        })();
        let journal = match prepared {
            Ok(journal) => journal,
            Err(error) => {
                let _ = self.file_import_clear(&directory);
                return Err(error);
            }
        };
        let synchronous: i64 = self
            .conn
            .pragma_query_value(None, "synchronous", |row| row.get(0))?;
        self.conn
            .pragma_update(None, "synchronous", synchronous.max(2))?;
        let mut agent_result = None;
        let result = (|| -> Result<()> {
            let _commit = agent
                .map(|agent| agent.fence.enter())
                .transpose()
                .map_err(AgentImportFailure)?;
            if let Some(agent) = agent {
                self.agent_file_create_authorize(agent.request, agent.binding, agent.input)
                    .map_err(AgentImportFailure)?;
            }
            if !journal.adopt_existing {
                move_exclusive(&directory.join("new.bin"), &target)?;
            }
            import_crash_point(ImportPhase::Placed);
            if checksum(&target)? != journal.content_hash
                || path_identity(&target)? != journal.identity
            {
                bail!("Imported File changed before registration");
            }
            if history.exists() {
                bail!("New File history path became occupied before registration");
            }
            if let Some(agent) = agent {
                let intent = journal
                    .agent_intent
                    .as_ref()
                    .expect("Agent creation has a journal intent");
                agent_result = Some(
                    self.agent_atomic_operation(
                        &intent.caller_id,
                        &intent.request_id,
                        "file.create",
                        agent.input,
                        |tx| {
                            self.agent_file_create_authorize(
                                agent.request,
                                agent.binding,
                                agent.input,
                            )?;
                            let (_, change) = self.file_import_register_transaction(
                                tx, &journal, &target, &history,
                            )?;
                            Ok((
                                AgentFileCreateResult {
                                    operation_id: intent.operation_id.clone(),
                                    object: ObjectRef {
                                        workspace_id: agent.binding.workspace_id.clone(),
                                        scope: Scope::Project { project_id },
                                        kind: ObjectKind::File,
                                        id: document_id.to_string(),
                                    },
                                    version_number: 1,
                                    content_hash: journal.content_hash.clone(),
                                },
                                change,
                            ))
                        },
                    )
                    .map_err(AgentImportFailure)?,
                );
            } else {
                self.agent_atomic_operation(
                    "gui",
                    &journal.request_id,
                    "file.import",
                    &journal,
                    |tx| self.file_import_register_transaction(tx, &journal, &target, &history),
                )
                .map_err(|error| anyhow!(error.message))?;
            }
            import_crash_point(ImportPhase::Committed);
            Ok(())
        })();
        if let Err(error) = self.conn.pragma_update(None, "synchronous", synchronous) {
            eprintln!("File import synchronous restore failed: {error}");
        }
        if let Err(error) = result {
            if let Err(recovery) = self.file_import_recover(&directory, &journal) {
                return Err(error.context(format!("File import journal retained: {recovery}")));
            }
            return Err(error);
        }
        if let Err(error) = self.file_import_clear(&directory) {
            eprintln!("Committed File import cleanup pending: {error}");
        }
        if let Some(result) = agent_result {
            Ok(ImportOutcome::Agent(result))
        } else {
            self.document_record(document_id).map(ImportOutcome::Gui)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::Database;
    use crate::models::{DocumentImportInput, ProjectCreateInput};
    use std::fs;
    const BYTES: &[u8] = b"\xef\xbb\xbf<script>original\r\nsource</script>\r\n";

    fn agent_request(workspace_id: &str, project_id: i64) -> super::RequestContext {
        super::RequestContext {
            binding: super::WorkspaceBinding {
                workspace_id: workspace_id.into(),
                generation: "fixture".into(),
            },
            caller: crate::agent::access::Caller::Gui,
            request_id: "agent-original-create-request".into(),
            scope_grant: crate::agent::access::ScopeGrant {
                workspace_id: workspace_id.into(),
                workspace_content: false,
                project_ids: vec![project_id],
                operations: vec!["content.create".into()],
            },
        }
    }
    fn agent_input(project_id: i64) -> super::AgentFileCreateInput {
        super::AgentFileCreateInput {
            project_id,
            safe_name: "source.html".into(),
            utf8_content: String::from_utf8(BYTES.to_vec()).unwrap(),
        }
    }
    #[test]
    fn agent_file_create_replays_original_request_after_reopen_and_reauthorizes() {
        let root = tempfile::tempdir().unwrap();
        let (metadata, paths) =
            crate::workspace::create_workspace(root.path(), "password").unwrap();
        let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
        db.bind_native_workspace(&metadata.workspace_id).unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Agent File".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let request = agent_request(&metadata.workspace_id, project.id);
        let input = agent_input(project.id);
        let fence = super::WorkspaceCommitFence::new();
        let result = db
            .agent_file_create_bound(&request, &request.binding, &input, &fence)
            .unwrap();
        assert_eq!(result.version_number, 1);
        assert_eq!(
            result.content_hash,
            format!("sha256:{:x}", <sha2::Sha256 as sha2::Digest>::digest(BYTES))
        );
        assert_eq!(
            fs::read(std::path::Path::new(&project.root_path).join(&input.safe_name)).unwrap(),
            BYTES
        );
        let before = db.committed_change_watermark().unwrap();
        drop(db);
        let mut db = crate::workspace_initialization::open_workspace_database(
            &paths.db_path,
            root.path(),
            None,
            &metadata.workspace_id,
        )
        .unwrap()
        .db;
        let replay = db
            .agent_file_create_bound(&request, &request.binding, &input, &fence)
            .unwrap();
        assert_eq!(replay.operation_id, result.operation_id);
        assert_eq!(replay.object, result.object);
        assert_eq!(db.committed_change_watermark().unwrap(), before);
        let mut changed = input.clone();
        changed.utf8_content.push('!');
        assert_eq!(
            db.agent_file_create_bound(&request, &request.binding, &changed, &fence)
                .unwrap_err()
                .code,
            super::ErrorCode::IdempotencyConflict
        );
        let mut duplicate = request.clone();
        duplicate.request_id = "distinct-real-request".into();
        assert_eq!(
            db.agent_file_create_bound(&duplicate, &request.binding, &input, &fence)
                .unwrap_err()
                .code,
            super::ErrorCode::RevisionConflict
        );
        assert_eq!(
            fs::read(std::path::Path::new(&project.root_path).join(&input.safe_name)).unwrap(),
            BYTES
        );
        let mut denied = request.clone();
        denied.scope_grant.operations.clear();
        assert_eq!(
            db.agent_file_create_bound(&denied, &request.binding, &input, &fence)
                .unwrap_err()
                .code,
            super::ErrorCode::ScopeDenied
        );
        fence.invalidate();
        assert_eq!(
            db.agent_file_create_bound(&request, &request.binding, &input, &fence)
                .unwrap_err()
                .code,
            super::ErrorCode::WorkspaceChanged
        );
        assert_eq!(
            db.conn
                .query_row("SELECT COUNT(*) FROM documents", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(db.conn.query_row("SELECT COUNT(*) FROM agent_operation_receipts WHERE operation='file.create' AND request_id='agent-original-create-request'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }
    #[test]
    fn agent_file_create_validates_names_byte_budget_and_rolls_back_outbox_failure() {
        use super::{validate_agent_file_create, ErrorCode};
        let mut input = agent_input(1);
        for name in [
            "../bad.md",
            "dir/bad.txt",
            r"dir\bad.txt",
            "bad.exe",
            "CON.md",
            "LPT1.txt",
            "bad?.md",
            "bad.md ",
            "bad:md.txt",
            ".",
        ] {
            input.safe_name = name.into();
            assert_eq!(
                validate_agent_file_create(&input).unwrap_err().code,
                ErrorCode::InvalidArgument,
                "{name}"
            );
        }
        input.safe_name = "valid.md".into();
        input.utf8_content = "é".repeat(1024 * 1024);
        validate_agent_file_create(&input).unwrap();
        input.utf8_content.push('é');
        assert_eq!(
            validate_agent_file_create(&input).unwrap_err().code,
            ErrorCode::BudgetExceeded
        );
        let root = tempfile::tempdir().unwrap();
        let (metadata, paths) =
            crate::workspace::create_workspace(root.path(), "password").unwrap();
        let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
        db.bind_native_workspace(&metadata.workspace_id).unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Rollback".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let request = agent_request(&metadata.workspace_id, project.id);
        let input = agent_input(project.id);
        let fence = super::WorkspaceCommitFence::new();
        let before = db.committed_change_watermark().unwrap();
        let mut denied = request.clone();
        denied.scope_grant.project_ids.clear();
        assert_eq!(
            db.agent_file_create_bound(&denied, &request.binding, &input, &fence)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        db.conn
            .execute(
                "UPDATE projects SET is_archived=1 WHERE id=?1",
                [project.id],
            )
            .unwrap();
        assert_eq!(
            db.agent_file_create_bound(&request, &request.binding, &input, &fence)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        db.conn
            .execute(
                "UPDATE projects SET is_archived=0 WHERE id=?1",
                [project.id],
            )
            .unwrap();
        let mut missing = input.clone();
        missing.project_id = project.id + 100;
        let mut missing_request = request.clone();
        missing_request
            .scope_grant
            .project_ids
            .push(missing.project_id);
        assert_eq!(
            db.agent_file_create_bound(&missing_request, &request.binding, &missing, &fence)
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
        let closed = super::WorkspaceCommitFence::new();
        closed.invalidate();
        assert_eq!(
            db.agent_file_create_bound(&request, &request.binding, &input, &closed)
                .unwrap_err()
                .code,
            ErrorCode::WorkspaceChanged
        );
        assert!(!std::path::Path::new(&project.root_path)
            .join(&input.safe_name)
            .exists());
        db.conn.execute_batch("CREATE TRIGGER reject_agent_file_change BEFORE INSERT ON agent_change_log WHEN NEW.operation='file.create' BEGIN SELECT RAISE(ABORT,'fixture outbox failure'); END;").unwrap();
        assert_eq!(
            db.agent_file_create_bound(&request, &request.binding, &input, &fence)
                .unwrap_err()
                .code,
            ErrorCode::IoFailed
        );
        assert_eq!(
            db.conn
                .query_row("SELECT COUNT(*) FROM documents", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT COUNT(*) FROM agent_operation_receipts WHERE operation='file.create'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(db.committed_change_watermark().unwrap(), before);
        assert!(!std::path::Path::new(&project.root_path)
            .join(&input.safe_name)
            .exists());
        assert_eq!(
            db.conn
                .query_row("SELECT COUNT(*) FROM document_versions", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.conn
                .query_row("SELECT COUNT(*) FROM source_file_version_hashes", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            fs::read_dir(root.path().join(super::IMPORT_JOURNALS))
                .unwrap()
                .count(),
            0
        );
        db.conn
            .execute_batch("DROP TRIGGER reject_agent_file_change")
            .unwrap();
        db.agent_file_create_bound(&request, &request.binding, &input, &fence)
            .unwrap();
    }
    #[test]
    fn agent_file_create_process_crashes_recover_original_request_without_duplicates() {
        for stage in 0..=4 {
            let root = tempfile::tempdir().unwrap();
            let (metadata, paths) =
                crate::workspace::create_workspace(root.path(), "password").unwrap();
            let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
            db.bind_native_workspace(&metadata.workspace_id).unwrap();
            let project = db
                .project_create(ProjectCreateInput {
                    name: "Agent crash".into(),
                    summary: None,
                    status: None,
                })
                .unwrap();
            let before = db.committed_change_watermark().unwrap();
            drop(db);
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "db::file_imports::tests::file_import_crash_process_fixture",
                    "--ignored",
                ])
                .env("MIND_FILE_IMPORT_CRASH_FIXTURE", root.path())
                .env("MIND_FILE_IMPORT_SOURCE_KIND", "agent")
                .env("MIND_FILE_IMPORT_CRASH_STAGE", stage.to_string())
                .output()
                .unwrap();
            assert_crashed(output.status);
            let mut db = crate::workspace_initialization::open_workspace_database(
                &paths.db_path,
                root.path(),
                None,
                &metadata.workspace_id,
            )
            .unwrap()
            .db;
            let committed = i64::from(stage == 4);
            assert_eq!(
                db.conn
                    .query_row("SELECT COUNT(*) FROM documents", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                committed,
                "stage {stage}"
            );
            assert_eq!(db.conn.query_row("SELECT COUNT(*) FROM agent_operation_receipts WHERE operation='file.create'",[],|r|r.get::<_,i64>(0)).unwrap(),committed);
            assert_eq!(db.committed_change_watermark().unwrap(), before + committed);
            assert_eq!(
                fs::read_dir(root.path().join(super::IMPORT_JOURNALS))
                    .unwrap()
                    .count(),
                0
            );
            let request = agent_request(&metadata.workspace_id, project.id);
            let input = agent_input(project.id);
            let fence = super::WorkspaceCommitFence::new();
            let result = db
                .agent_file_create_bound(&request, &request.binding, &input, &fence)
                .unwrap();
            assert_eq!(
                db.agent_file_create_bound(&request, &request.binding, &input, &fence)
                    .unwrap()
                    .operation_id,
                result.operation_id
            );
            assert_eq!(
                db.conn
                    .query_row("SELECT COUNT(*) FROM document_versions", [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(db.conn.query_row("SELECT COUNT(*) FROM agent_operation_receipts WHERE operation='file.create'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
            assert_eq!(db.committed_change_watermark().unwrap(), before + 1);
            assert_eq!(
                fs::read(std::path::Path::new(&project.root_path).join(&input.safe_name)).unwrap(),
                BYTES
            );
        }
    }
    fn assert_crashed(status: std::process::ExitStatus) {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(status.signal(), Some(9));
        }
        #[cfg(not(unix))]
        assert_eq!(status.code(), Some(91));
    }
    #[test]
    #[ignore = "subprocess-only fixture exercised by file_import_process_crashes_recover_without_stub_or_duplicate"]
    fn file_import_crash_process_fixture() {
        let Ok(root) = std::env::var("MIND_FILE_IMPORT_CRASH_FIXTURE") else {
            return;
        };
        let root = std::path::Path::new(&root);
        let (_, paths) = crate::workspace::load_metadata(root).unwrap();
        let mut db = Database::open(&paths.db_path, root, None).unwrap();
        let project_id: i64 = db
            .conn
            .query_row("SELECT id FROM projects", [], |row| row.get(0))
            .unwrap();
        let kind = std::env::var("MIND_FILE_IMPORT_SOURCE_KIND").unwrap();
        if kind == "agent" {
            let (metadata, _) = crate::workspace::load_metadata(root).unwrap();
            db.bind_native_workspace(&metadata.workspace_id).unwrap();
            let request = agent_request(&metadata.workspace_id, project_id);
            db.agent_file_create_bound(
                &request,
                &request.binding,
                &agent_input(project_id),
                &super::WorkspaceCommitFence::new(),
            )
            .unwrap();
        } else if kind == "clipboard" {
            use base64::Engine;
            db.document_import_clipboard_image(crate::models::DocumentImportClipboardImageInput {
                project_id,
                file_name: "capture.png".into(),
                mime_type: "image/png".into(),
                data_base64: base64::engine::general_purpose::STANDARD.encode(BYTES),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        } else {
            let source = if kind == "existing" {
                std::path::PathBuf::from(db.project_record(project_id).unwrap().root_path)
                    .join("source.html")
            } else {
                root.join("source.html")
            };
            db.document_import(DocumentImportInput {
                project_id,
                source_path: source.to_string_lossy().into(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        }
        panic!("File import crash boundary was not reached");
    }

    #[test]
    fn file_import_process_crashes_recover_without_stub_or_duplicate() {
        for kind in ["copy", "existing", "clipboard"] {
            for stage in 0..=4 {
                let root = tempfile::tempdir().unwrap();
                let (metadata, paths) =
                    crate::workspace::create_workspace(root.path(), "password").unwrap();
                let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
                let project = db
                    .project_create(ProjectCreateInput {
                        name: "Import crash".into(),
                        summary: None,
                        status: None,
                    })
                    .unwrap();
                let source = if kind == "existing" {
                    std::path::Path::new(&project.root_path).join("source.html")
                } else {
                    root.path().join("source.html")
                };
                if kind != "clipboard" {
                    fs::write(&source, BYTES).unwrap();
                }
                let before = db.committed_change_watermark().unwrap();
                drop(db);
                let output = std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "db::file_imports::tests::file_import_crash_process_fixture",
                        "--ignored",
                    ])
                    .env("MIND_FILE_IMPORT_CRASH_FIXTURE", root.path())
                    .env("MIND_FILE_IMPORT_SOURCE_KIND", kind)
                    .env("MIND_FILE_IMPORT_CRASH_STAGE", stage.to_string())
                    .output()
                    .unwrap();
                assert_crashed(output.status);
                let db = crate::workspace_initialization::open_workspace_database(
                    &paths.db_path,
                    root.path(),
                    None,
                    &metadata.workspace_id,
                )
                .unwrap()
                .db;
                let count: i64 = db
                    .conn
                    .query_row("SELECT count(*) FROM documents", [], |row| row.get(0))
                    .unwrap();
                let versions: i64 = db
                    .conn
                    .query_row("SELECT count(*) FROM document_versions", [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                assert_eq!(count, i64::from(stage == 4), "{kind} stage {stage}");
                assert_eq!(versions, count);
                assert_eq!(db.committed_change_watermark().unwrap(), before + count);
                let target =
                    std::path::Path::new(&project.root_path).join(if kind == "clipboard" {
                        "capture.png"
                    } else {
                        "source.html"
                    });
                if stage == 4 {
                    use sha2::Digest;
                    let document_id: i64 = db
                        .conn
                        .query_row("SELECT id FROM documents", [], |row| row.get(0))
                        .unwrap();
                    let file = db.document_record(document_id).unwrap();
                    assert_eq!(file.current_version_number, 1);
                    assert_eq!(file.version_count, 1);
                    assert_eq!(fs::read(file.managed_path).unwrap(), BYTES);
                    let hash: String = db
                        .conn
                        .query_row(
                            "SELECT content_hash FROM source_file_version_hashes",
                            [],
                            |row| row.get(0),
                        )
                        .unwrap();
                    assert_eq!(hash, format!("sha256:{:x}", sha2::Sha256::digest(BYTES)));
                    let receipts:i64 = db.conn.query_row("SELECT count(*) FROM agent_operation_receipts WHERE operation='file.import'", [], |row| row.get(0)).unwrap();
                    assert_eq!(receipts, 1);
                } else if kind == "existing" {
                    assert_eq!(fs::read(&target).unwrap(), BYTES);
                } else {
                    assert!(!target.exists());
                }
                if kind != "clipboard" {
                    assert_eq!(
                        fs::read(source).unwrap(),
                        BYTES,
                        "import cannot consume its source"
                    );
                }
                assert_eq!(
                    fs::read_dir(root.path().join(super::IMPORT_JOURNALS))
                        .unwrap()
                        .count(),
                    0
                );
                db.file_version_recover_pending().unwrap();
                assert_eq!(db.committed_change_watermark().unwrap(), before + count);
            }
        }
    }

    #[test]
    fn file_import_recovery_preserves_foreign_same_byte_target() {
        let root = tempfile::tempdir().unwrap();
        let (metadata, paths) =
            crate::workspace::create_workspace(root.path(), "password").unwrap();
        let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Import collision".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        fs::write(root.path().join("source.html"), BYTES).unwrap();
        let before = db.committed_change_watermark().unwrap();
        drop(db);
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "db::file_imports::tests::file_import_crash_process_fixture",
                "--ignored",
            ])
            .env("MIND_FILE_IMPORT_CRASH_FIXTURE", root.path())
            .env("MIND_FILE_IMPORT_SOURCE_KIND", "copy")
            .env("MIND_FILE_IMPORT_CRASH_STAGE", "1")
            .output()
            .unwrap();
        assert_crashed(output.status);
        let target = std::path::Path::new(&project.root_path).join("source.html");
        fs::write(&target, BYTES).unwrap();
        assert!(crate::workspace_initialization::open_workspace_database(
            &paths.db_path,
            root.path(),
            None,
            &metadata.workspace_id
        )
        .is_err());
        assert_eq!(fs::read(&target).unwrap(), BYTES);
        fs::remove_file(&target).unwrap();
        let db = crate::workspace_initialization::open_workspace_database(
            &paths.db_path,
            root.path(),
            None,
            &metadata.workspace_id,
        )
        .unwrap()
        .db;
        assert_eq!(db.committed_change_watermark().unwrap(), before);
        let count: i64 = db
            .conn
            .query_row("SELECT count(*) FROM documents", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn file_import_clipboard_outbox_failure_and_existing_source_keep_bytes() {
        use base64::Engine;
        let root = tempfile::tempdir().unwrap();
        let (_, paths) = crate::workspace::create_workspace(root.path(), "password").unwrap();
        let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Clipboard failure".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let input = crate::models::DocumentImportClipboardImageInput {
            project_id: project.id,
            file_name: "capture.png".into(),
            mime_type: "image/png".into(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(BYTES),
            is_starred: true,
            tag_ids: None,
        };
        let before = db.committed_change_watermark().unwrap();
        db.conn.execute_batch("CREATE TRIGGER fail_import_outbox BEFORE INSERT ON agent_change_log WHEN NEW.operation='file.import' BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
        assert!(db.document_import_clipboard_image(input.clone()).is_err());
        assert!(!std::path::Path::new(&project.root_path)
            .join("capture.png")
            .exists());
        let existing = std::path::Path::new(&project.root_path).join("user.html");
        fs::write(&existing, BYTES).unwrap();
        assert!(db
            .document_import(DocumentImportInput {
                project_id: project.id,
                source_path: existing.to_string_lossy().into(),
                is_starred: false,
                tag_ids: None
            })
            .is_err());
        assert_eq!(fs::read(existing).unwrap(), BYTES);
        assert_eq!(db.committed_change_watermark().unwrap(), before);
        let count: i64 = db
            .conn
            .query_row("SELECT count(*) FROM documents", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        db.conn
            .execute_batch("DROP TRIGGER fail_import_outbox")
            .unwrap();
        let file = db.document_import_clipboard_image(input).unwrap();
        assert_eq!(file.storage_mode, "managed_clipboard");
        assert_eq!(file.original_path, file.managed_path);
        assert!(file.is_starred);
        assert_eq!(fs::read(file.managed_path).unwrap(), BYTES);
        assert_eq!(db.committed_change_watermark().unwrap(), before + 1);
    }

    #[test]
    fn file_import_does_not_claim_an_existing_history_directory() {
        let root = tempfile::tempdir().unwrap();
        let (_, paths) = crate::workspace::create_workspace(root.path(), "password").unwrap();
        let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Foreign history".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let directory = std::path::Path::new(&project.root_path).join(".1.pm-versions");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("user-owned.html"), BYTES).unwrap();
        let source = root.path().join("source.html");
        fs::write(&source, BYTES).unwrap();
        let before = db.committed_change_watermark().unwrap();
        assert!(db
            .document_import(DocumentImportInput {
                project_id: project.id,
                source_path: source.to_string_lossy().into(),
                is_starred: false,
                tag_ids: None
            })
            .is_err());
        assert_eq!(fs::read(directory.join("user-owned.html")).unwrap(), BYTES);
        assert_eq!(fs::read(source).unwrap(), BYTES);
        assert_eq!(db.committed_change_watermark().unwrap(), before);
        let count: i64 = db
            .conn
            .query_row("SELECT count(*) FROM documents", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn file_import_live_staging_recovery_waits_for_namespace_lock() {
        let root = tempfile::tempdir().unwrap();
        let (_, paths) = crate::workspace::create_workspace(root.path(), "password").unwrap();
        let db = Database::open(&paths.db_path, root.path(), None).unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Live import".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let directory = root.path().join(super::IMPORT_JOURNALS).join(format!(
            "{}-{}",
            project.id,
            "2".repeat(32)
        ));
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("new.bin"), BYTES).unwrap();
        let _project = db.file_project_lock(project.id, false).unwrap();
        let guard = db
            .file_storage_lock("file-import-locks", project.id, true)
            .unwrap();
        let thread_root = root.path().to_path_buf();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(move || {
            let (_, paths) = crate::workspace::load_metadata(&thread_root).unwrap();
            let db = Database::open(&paths.db_path, &thread_root, None).unwrap();
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
        assert_eq!(fs::read(directory.join("new.bin")).unwrap(), BYTES);
        drop(guard);
        done_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .unwrap();
        handle.join().unwrap();
        assert!(!directory.exists());
    }

    #[test]
    fn file_import_concurrent_projects_allocate_unique_authoritative_ids() {
        use std::sync::{Arc, Barrier};
        let root = tempfile::tempdir().unwrap();
        let (_, paths) = crate::workspace::create_workspace(root.path(), "password").unwrap();
        let db = Database::open(&paths.db_path, root.path(), None).unwrap();
        let projects = (0..4)
            .map(|index| {
                db.project_create(ProjectCreateInput {
                    name: format!("Parallel import {index}"),
                    summary: None,
                    status: None,
                })
                .unwrap()
            })
            .collect::<Vec<_>>();
        let source = root.path().join("source.html");
        fs::write(&source, BYTES).unwrap();
        let before = db.committed_change_watermark().unwrap();
        let barrier = Arc::new(Barrier::new(projects.len()));
        let handles = projects
            .into_iter()
            .map(|project| {
                let barrier = barrier.clone();
                let root_path = root.path().to_path_buf();
                let source = source.clone();
                std::thread::spawn(move || {
                    let (_, paths) = crate::workspace::load_metadata(&root_path).unwrap();
                    let mut db = Database::open(&paths.db_path, &root_path, None).unwrap();
                    barrier.wait();
                    db.document_import(DocumentImportInput {
                        project_id: project.id,
                        source_path: source.to_string_lossy().into(),
                        is_starred: false,
                        tag_ids: None,
                    })
                })
            })
            .collect::<Vec<_>>();
        let mut ids = Vec::new();
        for handle in handles {
            let document = handle.join().unwrap().unwrap();
            assert_eq!(fs::read(&document.managed_path).unwrap(), BYTES);
            ids.push(document.id);
        }
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 4);
        assert_eq!(db.committed_change_watermark().unwrap(), before + 4);
        let hashes: i64 = db
            .conn
            .query_row(
                "SELECT count(*) FROM source_file_version_hashes",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(hashes, 4);
        assert_eq!(fs::read(source).unwrap(), BYTES);
    }

    #[test]
    fn file_import_capture_contains_only_committed_actual_file() {
        use crate::{
            agent::models::{ObjectKind, Scope, WorkspaceBinding},
            committed_changes::capture_native_committed,
        };
        let root = tempfile::tempdir().unwrap();
        let (metadata, paths) =
            crate::workspace::create_workspace(root.path(), "password").unwrap();
        let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Import notification".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let binding = WorkspaceBinding {
            workspace_id: metadata.workspace_id,
            generation: "current".into(),
        };
        let source = root.path().join("source.html");
        fs::write(&source, BYTES).unwrap();
        let input = DocumentImportInput {
            project_id: project.id,
            source_path: source.to_string_lossy().into(),
            is_starred: false,
            tag_ids: None,
        };
        db.conn.execute_batch("CREATE TRIGGER fail_import_notification BEFORE INSERT ON agent_change_log BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END;").unwrap();
        let (result, changes) =
            capture_native_committed(&binding, &mut db, "failed-import", |db| {
                db.document_import(input.clone())
            })
            .unwrap();
        assert!(result.is_err());
        assert!(changes.is_none());
        db.conn
            .execute_batch("DROP TRIGGER fail_import_notification")
            .unwrap();
        let (result, changes) =
            capture_native_committed(&binding, &mut db, "import", |db| db.document_import(input))
                .unwrap();
        let document = result.unwrap();
        let changes = changes.unwrap();
        assert_eq!(changes.changed_refs.len(), 1);
        let object = &changes.changed_refs[0];
        assert_eq!(object.workspace_id, binding.workspace_id);
        assert_eq!(
            object.scope,
            Scope::Project {
                project_id: project.id
            }
        );
        assert_eq!(object.kind, ObjectKind::File);
        assert_eq!(object.id, document.id.to_string());
        assert!(changes.record_heads.is_empty());
        assert!(db.conn.is_autocommit());
        // GUI emits this capture after with_db releases storage. File guards
        // must also be available by then, even though the DB object is live.
        let lock = db
            .file_storage_lock("file-import-locks", project.id, true)
            .unwrap();
        drop(lock);
    }

    #[test]
    fn file_import_database_failure_leaves_no_stub_or_owned_copy() {
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let (_, paths) = crate::workspace::create_workspace(root.path(), "password").unwrap();
        let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Import failure".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let source = external.path().join("source.html");
        let bytes = b"\xef\xbb\xbf<script>original\r\nsource</script>\r\n";
        fs::write(&source, bytes).unwrap();
        let input = DocumentImportInput {
            project_id: project.id,
            source_path: source.to_string_lossy().into(),
            is_starred: false,
            tag_ids: None,
        };
        let before = db.committed_change_watermark().unwrap();
        db.conn.execute_batch("CREATE TRIGGER fail_file_import BEFORE INSERT ON document_versions BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
        assert!(db.document_import(input.clone()).is_err());
        let count: i64 = db
            .conn
            .query_row("SELECT count(*) FROM documents", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            count, 0,
            "failed import must not leave an authoritative File stub"
        );
        assert!(!std::path::Path::new(&project.root_path)
            .join("source.html")
            .exists());
        assert_eq!(fs::read(source).unwrap(), bytes);
        assert_eq!(db.committed_change_watermark().unwrap(), before);
        db.conn
            .execute_batch("DROP TRIGGER fail_file_import")
            .unwrap();
        let imported = db.document_import(input).unwrap();
        assert_eq!(imported.current_version_number, 1);
        assert_eq!(fs::read(imported.managed_path).unwrap(), bytes);
    }
}
