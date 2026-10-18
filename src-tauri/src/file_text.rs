//! GUI Markdown edits commit through the same native File content boundary.
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::ObjectRef,
    },
    file_version_service::{BoundFileCommitStore, FileVersionCommitResult},
    source_service::BoundSourceStore,
};
use crate::{
    db::project_directory_files::FileBytesInput,
    file_content::{
        FileContentBegin, FileContentService, FileContentUpdate, SystemFileContentClock, MAX_CHUNK,
    },
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
fn phase(request: &RequestContext, name: &str) -> RequestContext {
    let mut next = request.clone();
    next.request_id = format!(
        "text:{:x}:{name}",
        Sha256::digest(request.request_id.as_bytes())
    );
    next
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileTextSaveInput {
    pub object: ObjectRef,
    pub version_number: u32,
    pub expected_content_hash: String,
    pub text: String,
}

pub(crate) fn save<S: BoundSourceStore + BoundFileCommitStore>(
    store: &S,
    request: &RequestContext,
    input: &FileTextSaveInput,
) -> AgentResult<FileVersionCommitResult> {
    let candidate_request = phase(request, "candidate");
    let previous = store.with_current(|binding, db| {
        db.source_read_historical_file(request, binding, &input.object)?;
        db.file_version_registered_target(request, binding, &input.object)?;
        db.agent_operation_replay::<FileContentUpdate>(
            &request.caller.key(),
            &candidate_request.request_id,
            "file.text.candidate",
            input,
        )
    })?;
    let content = FileContentService::new(store, &SystemFileContentClock);
    if let Some(candidate) = previous {
        return content.update(request, &candidate);
    }
    let original = store.with_current(|binding, db| {
        db.project_file_read_source(
            request,
            binding,
            &FileBytesInput {
                object: input.object.clone(),
                version_number: input.version_number,
                expected_content_hash: input.expected_content_hash.clone(),
            },
        )
        .map(|read| read.0)
    })?;
    let extension = std::path::Path::new(&original.name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "md" | "markdown" | "mdown") {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Text editing requires a Markdown File",
        ));
    }
    let original_bytes = STANDARD
        .decode(&original.base64)
        .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Invalid source bytes"))?;
    std::str::from_utf8(&original_bytes).map_err(|_| {
        AgentError::new(ErrorCode::InvalidArgument, "Markdown requires UTF-8 source")
    })?;
    let bytes = input.text.as_bytes();
    if bytes.len() > 10 * 1024 * 1024 {
        return Err(AgentError::new(
            ErrorCode::BudgetExceeded,
            "Markdown exceeds the 10 MiB editor limit",
        ));
    }
    let ticket = content.begin(
        &phase(request, "begin"),
        &FileContentBegin {
            object: input.object.clone(),
            expected_version_number: input.version_number,
            expected_content_hash: input.expected_content_hash.clone(),
            length: bytes.len() as u64,
            content_hash: format!("sha256:{:x}", Sha256::digest(bytes)),
        },
    )?;
    for (index, chunk) in bytes.chunks(MAX_CHUNK).enumerate() {
        content.append(
            &phase(request, &format!("chunk{index}")),
            &ticket.staged_content_id,
            (index * MAX_CHUNK) as u64,
            chunk,
        )?;
    }
    content.finish(&phase(request, "finish"), &ticket.staged_content_id)?;
    let candidate = store.with_current(|binding, db| {
        db.source_read_historical_file(request, binding, &input.object)?;
        db.file_version_registered_target(request, binding, &input.object)?;
        db.agent_atomic_operation(
            &request.caller.key(),
            &candidate_request.request_id,
            "file.text.candidate",
            input,
            |_| {
                Ok((
                    FileContentUpdate {
                        object: input.object.clone(),
                        expected_version_number: input.version_number,
                        expected_content_hash: input.expected_content_hash.clone(),
                        staged_content_id: ticket.staged_content_id,
                    },
                    None,
                ))
            },
        )
    })?;
    content.update(request, &candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{access::Caller, models::WorkspaceBinding},
        committed_changes::{CommittedChangePublisher, CommittedChanges},
        db::{project_directory_files::FileBytesInput, Database},
        file_version_service::FileCommitHost,
        workspace::{create_workspace, WorkspacePaths},
        workspace_commit_fence::WorkspaceCommitFence,
    };
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::{
        path::PathBuf,
        sync::{Arc, Mutex},
    };

    struct Store {
        db: Mutex<Database>,
        binding: WorkspaceBinding,
        paths: WorkspacePaths,
        fence: Arc<WorkspaceCommitFence>,
    }
    impl CommittedChangePublisher for Store {
        fn publish_committed(&self, _: CommittedChanges) {}
    }
    impl BoundSourceStore for Store {
        fn with_current<T>(
            &self,
            f: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
        ) -> AgentResult<T> {
            f(&self.binding, &self.db.lock().unwrap())
        }
    }
    impl BoundFileCommitStore for Store {
        fn gui_commit_host(&self, binding: &WorkspaceBinding) -> AgentResult<FileCommitHost> {
            crate::file_version_service::validate_binding(binding, &self.binding)?;
            Ok(FileCommitHost::for_test(
                self.binding.clone(),
                self.paths.clone(),
                None,
                self.fence.clone(),
            ))
        }
    }
    struct Fixture {
        _temp: tempfile::TempDir,
        store: Store,
        input: FileTextSaveInput,
        path: PathBuf,
    }
    fn fixture(name: &str, bytes: &[u8]) -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let (metadata, paths) = create_workspace(&root, "password").unwrap();
        let mut db = Database::open(&paths.db_path, &root, None).unwrap();
        db.bind_native_workspace(&metadata.workspace_id).unwrap();
        let project = db
            .project_create(crate::models::ProjectCreateInput {
                name: "Markdown".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let path = PathBuf::from(project.root_path).join(name);
        std::fs::write(&path, bytes).unwrap();
        let file = db
            .project_file_register(&metadata.workspace_id, project.id, name)
            .unwrap();
        let binding = WorkspaceBinding {
            workspace_id: metadata.workspace_id,
            generation: "opened".into(),
        };
        Fixture {
            _temp: temp,
            store: Store {
                db: Mutex::new(db),
                binding,
                paths,
                fence: Arc::new(WorkspaceCommitFence::new()),
            },
            input: FileTextSaveInput {
                object: file.object,
                version_number: 1,
                expected_content_hash: file.content_hash.unwrap(),
                text: "\u{feff}# 新标题\r\n\r\n中文 **正文**\r\n".into(),
            },
            path,
        }
    }
    fn request(f: &Fixture, id: &str) -> RequestContext {
        crate::file_office::gui_request(&f.store, &f.store.binding, id, &f.input.object, true)
            .unwrap()
    }
    #[test]
    fn markdown_save_preserves_source_bytes_history_and_replays_receipt() {
        let original = "\u{feff}# 原标题\r\n\r\n中文 **正文**\r\n";
        let f = fixture("source.md", original.as_bytes());
        let saved = save(&f.store, &request(&f, "save"), &f.input).unwrap();
        assert_eq!(saved.receipt.version_number, 2);
        assert_eq!(std::fs::read(&f.path).unwrap(), f.input.text.as_bytes());
        let historical = f
            .store
            .db
            .lock()
            .unwrap()
            .project_file_read_bytes(&FileBytesInput {
                object: f.input.object.clone(),
                version_number: 1,
                expected_content_hash: f.input.expected_content_hash.clone(),
            })
            .unwrap();
        assert_eq!(
            STANDARD.decode(historical.base64).unwrap(),
            original.as_bytes()
        );
        let replay = save(&f.store, &request(&f, "save"), &f.input).unwrap();
        assert_eq!(saved.receipt, replay.receipt);
        let mut changed = f.input.clone();
        changed.text.push('!');
        assert_eq!(
            save(&f.store, &request(&f, "save"), &changed)
                .unwrap_err()
                .code,
            ErrorCode::IdempotencyConflict
        );
        assert_eq!(
            save(&f.store, &request(&f, "stale"), &f.input)
                .unwrap_err()
                .code,
            ErrorCode::RevisionConflict
        );
    }
    #[test]
    fn markdown_save_rejects_changed_disk_and_forged_owner() {
        let f = fixture("source.markdown", b"before");
        std::fs::write(&f.path, b"external").unwrap();
        assert_eq!(
            save(&f.store, &request(&f, "disk"), &f.input)
                .unwrap_err()
                .code,
            ErrorCode::FileChangedUnregistered
        );
        assert_eq!(std::fs::read(&f.path).unwrap(), b"external");
        let mut forged = f.input.object.clone();
        forged.scope = crate::agent::models::Scope::Project { project_id: 999 };
        assert!(crate::file_office::gui_request(
            &f.store,
            &f.store.binding,
            "owner",
            &forged,
            true
        )
        .is_err());
    }
    #[test]
    fn markdown_save_handles_empty_files_and_rejects_non_markdown() {
        let f = fixture("empty.mdown", b"");
        let first = save(&f.store, &request(&f, "empty"), &f.input).unwrap();
        let blank = FileTextSaveInput {
            version_number: 2,
            expected_content_hash: first.receipt.content_hash,
            text: String::new(),
            ..f.input.clone()
        };
        save(&f.store, &request(&f, "clear"), &blank).unwrap();
        assert_eq!(std::fs::read(&f.path).unwrap(), b"");
        let other = fixture("other.html", b"<p>before</p>");
        assert_eq!(
            save(&other.store, &request(&other, "format"), &other.input)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
    }
    #[test]
    fn markdown_save_does_not_trust_read_only_or_expired_workspace_requests() {
        let f = fixture("source.md", b"before");
        let mut denied = request(&f, "readonly");
        denied
            .scope_grant
            .operations
            .retain(|op| op != "file.update");
        assert_eq!(
            save(&f.store, &denied, &f.input).unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        let mut expired = request(&f, "expired");
        expired.binding.generation = "closed".into();
        assert_eq!(
            save(&f.store, &expired, &f.input).unwrap_err().code,
            ErrorCode::WorkspaceChanged
        );
        assert_eq!(std::fs::read(&f.path).unwrap(), b"before");
        assert!(matches!(denied.caller, Caller::Gui));
    }
}
