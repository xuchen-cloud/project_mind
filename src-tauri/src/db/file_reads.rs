//! Read-only projections of the existing native File Version tables.
use super::Database;
use crate::agent::{
    access::RequestContext,
    context::serialized_chars,
    errors::{AgentError, AgentResult, ErrorCode},
    file_tools::{
        FileVersionMetadata, FileVersionResult, FileVersionsGetInput, FileVersionsListInput,
        FileVersionsPage,
    },
    models::{ObjectKind, ObjectRef, WorkspaceBinding},
};
use rusqlite::{params, OptionalExtension};

fn io(_: rusqlite::Error) -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Cannot read retained File versions")
}
fn identity(object: &ObjectRef) -> AgentResult<i64> {
    if object.kind != ObjectKind::File {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Expected a File object",
        ));
    }
    object
        .id
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0 && id.to_string() == object.id)
        .ok_or_else(|| AgentError::new(ErrorCode::InvalidArgument, "Invalid File identity"))
}
fn metadata(row: &rusqlite::Row<'_>) -> rusqlite::Result<FileVersionMetadata> {
    Ok(FileVersionMetadata {
        id: row.get::<_, i64>(0)?.to_string(),
        version_number: row.get(1)?,
        name: row.get(2)?,
        created_at: row.get(3)?,
        content_hash: row.get(4)?,
        is_current: row.get(5)?,
    })
}
fn registered(hash: &Option<String>) -> AgentResult<()> {
    if hash
        .as_ref()
        .is_some_and(|hash| !super::file_versions::valid_hash(hash))
    {
        return Err(AgentError::new(
            ErrorCode::IoFailed,
            "Stored File version hash is invalid",
        ));
    }
    Ok(())
}
/// Server-owned native preflight; paths never enter a public read DTO.
pub(crate) struct GuiFileHistoryRestorePlan {
    pub input: super::file_versions::GuiFileVersionPrepare,
    pub historical_content_hash: String,
}
impl Database {
    pub(crate) fn file_read_gui_restore_plan(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &crate::file_version_restore::FileVersionRestore,
    ) -> AgentResult<GuiFileHistoryRestorePlan> {
        if !matches!(request.caller, crate::agent::access::Caller::Gui) {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Local File history restoration requires the GUI caller",
            ));
        }
        input.validate()?;
        let object = self.source_read_historical_file(request, binding, &input.object)?;
        request.authorize_object(binding, &input.object, &object, "file.restore")?;
        let document = self.document_record(identity(&object)?).map_err(|_| {
            AgentError::new(ErrorCode::IoFailed, "Cannot read native File ownership")
        })?;
        let version = self
            .document_version_record(input.version_id.parse().map_err(|_| {
                AgentError::new(ErrorCode::InvalidArgument, "Invalid File version ID")
            })?)
            .map_err(|_| {
                AgentError::new(
                    ErrorCode::NotFound,
                    "Historical File version is no longer retained",
                )
            })?;
        if version.document_id != document.id {
            return Err(AgentError::new(
                ErrorCode::NotFound,
                "Historical File version belongs to another object",
            ));
        }
        let hash: Option<String> = self
            .conn
            .query_row(
                "SELECT content_hash FROM source_file_version_hashes WHERE document_version_id=?1",
                [version.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(io)?;
        registered(&hash)?;
        let hash = hash.ok_or_else(|| {
            AgentError::new(
                ErrorCode::SourceNotReady,
                "Historical File version hash is not registered",
            )
        })?;
        super::file_versions::relative(
            &self.workspace_root,
            std::path::Path::new(&version.managed_path),
        )
        .map_err(|_| {
            AgentError::new(
                ErrorCode::ScopeDenied,
                "Historical File bytes are outside their managed Workspace",
            )
        })?;
        Ok(GuiFileHistoryRestorePlan {
            input: super::file_versions::GuiFileVersionPrepare {
                document_id: document.id,
                project_id: document.project_id,
                managed_path: document.managed_path,
                expected_version_number: input.expected_version_number,
                source_path: Some(version.managed_path),
            },
            historical_content_hash: hash,
        })
    }
    fn file_read_current(&self, id: i64) -> AgentResult<(u32, Option<String>)> {
        self.conn.query_row("SELECT d.current_version_number,h.content_hash FROM documents d LEFT JOIN document_versions v ON v.document_id=d.id AND v.version_number=d.current_version_number LEFT JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE d.id=?1",[id],|row|Ok((row.get(0)?,row.get(1)?))).map_err(io)
    }
    pub(crate) fn file_read_versions_list(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &FileVersionsListInput,
    ) -> AgentResult<FileVersionsPage> {
        let object = if matches!(request.caller, crate::agent::access::Caller::Gui) {
            self.source_read_historical_file(request, binding, &input.object)?
        } else {
            self.source_read_object(request, binding, &input.object)?
        };
        let id = identity(&object)?;
        let limit = input.limit.unwrap_or(50);
        if !(1..=100).contains(&limit) || input.cursor == Some(0) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid File versions page",
            ));
        }
        let (current_version_number, current_content_hash) = self.file_read_current(id)?;
        registered(&current_content_hash)?;
        let mut query=self.conn.prepare("SELECT v.id,v.version_number,v.name,v.created_at,h.content_hash,v.version_number=?3 FROM document_versions v LEFT JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1 AND (?2 IS NULL OR v.version_number<?2) ORDER BY v.version_number DESC LIMIT ?4").map_err(io)?;
        let mut versions = query
            .query_map(
                params![
                    id,
                    input.cursor,
                    current_version_number,
                    u32::from(limit) + 1
                ],
                metadata,
            )
            .map_err(io)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io)?;
        for version in &versions {
            registered(&version.content_hash)?;
        }
        let more = versions.len() > usize::from(limit);
        versions.truncate(usize::from(limit));
        let mut page = FileVersionsPage {
            object,
            current_version_number,
            current_content_hash,
            next_cursor: if more {
                versions.last().map(|v| v.version_number)
            } else {
                None
            },
            versions,
        };
        while serialized_chars(&page)? > 24000 {
            page.versions.pop();
            if page.versions.is_empty() {
                return Err(AgentError::new(
                    ErrorCode::BudgetExceeded,
                    "File version metadata exceeds the read budget",
                ));
            }
            page.next_cursor = page.versions.last().map(|v| v.version_number);
        }
        Ok(page)
    }
    pub(crate) fn file_read_version_get(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &FileVersionsGetInput,
    ) -> AgentResult<FileVersionResult> {
        let object = self.source_read_historical_file(request, binding, &input.object)?;
        let id = identity(&object)?;
        if !crate::file_version_restore::valid_version_id(&input.version_id) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid File version ID",
            ));
        }
        let (current_version_number, current_content_hash) = self.file_read_current(id)?;
        registered(&current_content_hash)?;
        let version=self.conn.query_row("SELECT v.id,v.version_number,v.name,v.created_at,h.content_hash,v.version_number=?3 FROM document_versions v LEFT JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1 AND v.id=?2",params![id,input.version_id,current_version_number],metadata).optional().map_err(io)?.ok_or_else(||AgentError::new(ErrorCode::NotFound,"File Version is no longer retained"))?;
        registered(&version.content_hash)?;
        let result = FileVersionResult {
            object,
            current_version_number,
            current_content_hash,
            version,
        };
        if serialized_chars(&result)? > 24000 {
            return Err(AgentError::new(
                ErrorCode::BudgetExceeded,
                "File version metadata exceeds the read budget",
            ));
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            access::{Caller, ScopeGrant},
            file_tools::FileSourceReadInput,
            models::Scope,
        },
        file_source_read::FileSourceReadService,
        models::{DocumentImportInput, ProjectCreateInput},
        source_service::{BoundSourceStore, SourcePolicyUpdate},
    };
    use base64::Engine;
    use std::sync::Mutex;
    struct Store {
        db: Mutex<Database>,
        binding: WorkspaceBinding,
    }
    impl crate::committed_changes::CommittedChangePublisher for Store {
        fn publish_committed(&self, _changes: crate::committed_changes::CommittedChanges) {}
    }
    impl BoundSourceStore for Store {
        fn with_current<T>(
            &self,
            action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
        ) -> AgentResult<T> {
            action(&self.binding, &self.db.lock().unwrap())
        }
    }
    struct Fixture {
        _root: tempfile::TempDir,
        store: Store,
        request: RequestContext,
        input: FileSourceReadInput,
        path: std::path::PathBuf,
    }
    fn fixture(bytes: &[u8]) -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("files.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("file-read-test").unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Raw File reads".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let path = root.path().join("source.html");
        std::fs::write(&path, bytes).unwrap();
        let file = db
            .document_import(DocumentImportInput {
                project_id: project.id,
                source_path: path.to_string_lossy().into(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "file-read-test".into(),
            generation: "one".into(),
        };
        let object = ObjectRef {
            workspace_id: binding.workspace_id.clone(),
            scope: Scope::Project {
                project_id: project.id,
            },
            kind: ObjectKind::File,
            id: file.id.to_string(),
        };
        let request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "read-files".into(),
            scope_grant: ScopeGrant {
                object_keys: None,
                workspace_id: binding.workspace_id.clone(),
                workspace_content: false,
                project_ids: vec![project.id],
                operations: vec![
                    "source.read".into(),
                    "file.update".into(),
                    "settings.write".into(),
                ],
            },
        };
        let hash = super::super::file_versions::checksum(std::path::Path::new(&file.managed_path))
            .unwrap();
        Fixture {
            _root: root,
            store: Store {
                db: Mutex::new(db),
                binding,
            },
            request,
            input: FileSourceReadInput {
                object,
                version_number: 1,
                expected_content_hash: Some(hash),
                cursor: None,
                budget_chars: Some(1200),
            },
            path: file.managed_path.into(),
        }
    }
    #[tokio::test]
    async fn file_source_pages_preserve_raw_html_bom_scripts_unicode_and_newlines() {
        let text = format!(
            "\u{feff}<script>window.x = '<actual>';</script>\r\n{}\r\n",
            "中<&>\"\n".repeat(800)
        );
        let mut f = fixture(text.as_bytes());
        let service = FileSourceReadService::new(&f.store);
        let writes = f.store.db.lock().unwrap().conn.total_changes();
        let mut restored = String::new();
        let mut pages = 0;
        loop {
            let page = service.read(&f.request, &f.input).await.unwrap();
            assert!(serialized_chars(&page).unwrap() <= 1200);
            assert_eq!(page.byte_length, text.len());
            assert_eq!(page.total_chars, text.chars().count());
            assert_eq!(page.start_char, restored.chars().count());
            assert_eq!(page.format, "html");
            restored.push_str(&page.text);
            pages += 1;
            assert_eq!(page.end_char, restored.chars().count());
            if page.complete {
                assert!(page.next_cursor.is_none());
                break;
            }
            assert!(!page.text.is_empty());
            f.input.cursor = page.next_cursor;
        }
        assert!(pages > 1);
        assert_eq!(restored, text);
        assert_eq!(f.store.db.lock().unwrap().conn.total_changes(), writes);
    }
    #[tokio::test]
    async fn file_source_fixed_history_is_independent_of_current_version_and_hash_bound() {
        let f = fixture(b"<script>original()</script>\r\n");
        let original = FileSourceReadService::new(&f.store)
            .read(&f.request, &f.input)
            .await
            .unwrap();
        let directory = f
            ._root
            .path()
            .join(".project-mind/file-content-stage/read-fixture");
        std::fs::create_dir_all(&directory).unwrap();
        let staged = directory.join("replacement.html");
        std::fs::write(&staged, b"<script>current()</script>\n").unwrap();
        let update = super::super::file_versions::FileVersionUpdate {
            object: f.input.object.clone(),
            expected_version_number: 1,
            expected_content_hash: original.content_hash.clone(),
            new_content_hash: super::super::file_versions::checksum(&staged).unwrap(),
        };
        f.store
            .db
            .lock()
            .unwrap()
            .file_version_update_registered(&f.request, &f.store.binding, &update, &staged)
            .unwrap();
        let old = FileSourceReadService::new(&f.store)
            .read(&f.request, &f.input)
            .await
            .unwrap();
        assert_eq!(old.text, original.text);
        let page = f
            .store
            .with_current(|binding, db| {
                db.file_read_versions_list(
                    &f.request,
                    binding,
                    &FileVersionsListInput {
                        object: f.input.object.clone(),
                        cursor: None,
                        limit: Some(1),
                    },
                )
            })
            .unwrap();
        assert_eq!(page.current_version_number, 2);
        assert_eq!(page.versions[0].version_number, 2);
        assert!(page.versions[0].is_current);
        assert_eq!(page.next_cursor, Some(2));
        assert_eq!(
            page.current_content_hash.as_deref(),
            Some(update.new_content_hash.as_str())
        );
        let older = f
            .store
            .with_current(|binding, db| {
                db.file_read_versions_list(
                    &f.request,
                    binding,
                    &FileVersionsListInput {
                        object: f.input.object.clone(),
                        cursor: page.next_cursor,
                        limit: Some(1),
                    },
                )
            })
            .unwrap();
        assert_eq!(older.versions[0].version_number, 1);
        assert!(!older.versions[0].is_current);
        let metadata = f
            .store
            .with_current(|binding, db| {
                db.file_read_version_get(
                    &f.request,
                    binding,
                    &FileVersionsGetInput {
                        object: f.input.object.clone(),
                        version_id: older.versions[0].id.clone(),
                    },
                )
            })
            .unwrap();
        assert_eq!(
            metadata.version.content_hash.as_deref(),
            Some(original.content_hash.as_str())
        );
        let mut current = f.input.clone();
        current.version_number = 2;
        current.expected_content_hash = Some(update.new_content_hash);
        assert_eq!(
            FileSourceReadService::new(&f.store)
                .read(&f.request, &current)
                .await
                .unwrap()
                .text,
            "<script>current()</script>\n"
        );
        current.expected_content_hash = Some(original.content_hash);
        assert_eq!(
            FileSourceReadService::new(&f.store)
                .read(&f.request, &current)
                .await
                .unwrap_err()
                .code,
            ErrorCode::SourceChanged
        );
    }
    #[tokio::test]
    async fn file_source_gui_history_retains_access_while_ai_policy_still_rejects_excluded_and_archived(
    ) {
        let f = fixture(b"original");
        let service = FileSourceReadService::new(&f.store);
        let mut denied = f.request.clone();
        denied.scope_grant.operations.clear();
        assert_eq!(
            service.read(&denied, &f.input).await.unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        let mut foreign = f.input.clone();
        foreign.object.scope = Scope::Project { project_id: 999 };
        assert_eq!(
            service.read(&f.request, &foreign).await.unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        std::fs::write(&f.path, b"changed!").unwrap();
        assert_eq!(
            service.read(&f.request, &f.input).await.unwrap_err().code,
            ErrorCode::SourceChanged
        );
        std::fs::write(&f.path, b"original").unwrap();
        let mut policy_request = f.request.clone();
        policy_request.request_id = "exclude-source".into();
        f.store
            .with_current(|binding, db| {
                db.source_policy_update(
                    &policy_request,
                    binding,
                    &SourcePolicyUpdate {
                        object: f.input.object.clone(),
                        expected_revision: 0,
                        excluded: true,
                    },
                )
            })
            .unwrap();
        assert_eq!(
            service.read(&f.request, &f.input).await.unwrap().text,
            "original"
        );
        let mut model = f.request.clone();
        model.caller = Caller::BuiltinRun {
            run_id: "a".repeat(32),
        };
        assert_eq!(
            service.read(&model, &f.input).await.unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        let list = FileVersionsListInput {
            object: f.input.object.clone(),
            cursor: None,
            limit: None,
        };
        let metadata = f
            .store
            .with_current(|binding, db| db.file_read_versions_list(&f.request, binding, &list))
            .unwrap();
        assert_eq!(metadata.versions.len(), 1);
        assert_eq!(
            f.store
                .with_current(|binding, db| db.file_read_versions_list(&model, binding, &list))
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        let get = FileVersionsGetInput {
            object: f.input.object.clone(),
            version_id: metadata.versions[0].id.clone(),
        };
        assert!(f
            .store
            .with_current(|binding, db| db.file_read_version_get(&f.request, binding, &get))
            .is_ok());
        assert_eq!(
            f.store
                .with_current(|binding, db| db.file_read_version_get(&model, binding, &get))
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        policy_request.request_id = "include-source".into();
        f.store
            .with_current(|binding, db| {
                db.source_policy_update(
                    &policy_request,
                    binding,
                    &SourcePolicyUpdate {
                        object: f.input.object.clone(),
                        expected_revision: 1,
                        excluded: false,
                    },
                )
            })
            .unwrap();
        f.store
            .db
            .lock()
            .unwrap()
            .conn
            .execute("UPDATE projects SET is_archived=1", [])
            .unwrap();
        assert_eq!(
            service.read(&f.request, &f.input).await.unwrap().text,
            "original"
        );
        assert_eq!(
            service.read(&model, &f.input).await.unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        assert!(f
            .store
            .with_current(|binding, db| db.file_read_versions_list(&f.request, binding, &list))
            .is_ok());
        assert_eq!(
            f.store
                .with_current(|binding, db| db.file_read_versions_list(&model, binding, &list))
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        f.store
            .db
            .lock()
            .unwrap()
            .conn
            .execute("DELETE FROM source_file_version_hashes", [])
            .unwrap();
        assert_eq!(
            service.read(&f.request, &f.input).await.unwrap_err().code,
            ErrorCode::SourceNotReady
        );
        let metadata = f
            .store
            .with_current(|binding, db| {
                db.file_read_versions_list(
                    &f.request,
                    binding,
                    &FileVersionsListInput {
                        object: f.input.object.clone(),
                        cursor: None,
                        limit: None,
                    },
                )
            })
            .unwrap();
        assert!(metadata.current_content_hash.is_none());
        assert!(metadata.versions[0].content_hash.is_none());
    }
    #[tokio::test]
    async fn file_source_cursor_cannot_cross_versions_or_registered_hashes() {
        let f = fixture("中".repeat(4000).as_bytes());
        let first = FileSourceReadService::new(&f.store)
            .read(&f.request, &f.input)
            .await
            .unwrap();
        let mut cursor: serde_json::Value = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(first.next_cursor.as_ref().unwrap())
                .unwrap(),
        )
        .unwrap();
        cursor["versionNumber"] = serde_json::json!(2);
        let mut input = f.input.clone();
        input.cursor = Some(
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&cursor).unwrap()),
        );
        assert_eq!(
            FileSourceReadService::new(&f.store)
                .read(&f.request, &input)
                .await
                .unwrap_err()
                .code,
            ErrorCode::SourceChanged
        );
    }
}
