//! Authoritative File Version descriptors. Paths stay inside native services.
use super::Database;
use crate::{
    agent::{
        access::{Caller, RequestContext},
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef, WorkspaceBinding},
    },
    source_file_snapshot::{FileReadPlan, FileSourceFormat},
    source_service::SourceReadTarget,
};
use rusqlite::{params, OptionalExtension};
fn storage_error(_: rusqlite::Error) -> AgentError {
    AgentError::new(
        ErrorCode::IoFailed,
        "Cannot resolve registered File Version",
    )
}

impl Database {
    pub(super) fn source_prune_file_cache(
        &self,
        binding: &WorkspaceBinding,
        scope: &crate::agent::models::Scope,
    ) -> AgentResult<()> {
        let project_id = match scope {
            crate::agent::models::Scope::Project { project_id } => Some(*project_id),
            _ => None,
        };
        self.conn.execute(
            "DELETE FROM source_index_snapshots AS s
             WHERE s.workspace_id=?1 AND s.scope_key=?2 AND json_extract(s.object_json,'$.kind')='file'
             AND (NOT EXISTS(SELECT 1 FROM agent_visible_files d JOIN document_versions v ON v.document_id=d.id
                 JOIN source_file_version_hashes h ON h.document_version_id=v.id
                 WHERE CAST(d.id AS TEXT)=json_extract(s.object_json,'$.id') AND d.project_id=?3
                 AND d.storage_mode!='managed_note_image' AND v.version_number=s.version AND h.content_hash=s.revision)
                 OR EXISTS(SELECT 1 FROM source_access_policies x WHERE x.object_key=s.object_key AND x.excluded=1))",
            params![binding.workspace_id, scope.key(), project_id],
        ).map_err(storage_error)?;
        self.conn.execute(
            "UPDATE source_index_snapshots AS s SET is_current=EXISTS(SELECT 1 FROM agent_visible_files d
             WHERE CAST(d.id AS TEXT)=json_extract(s.object_json,'$.id') AND d.project_id=?3 AND d.current_version_number=s.version)
             WHERE s.workspace_id=?1 AND s.scope_key=?2 AND json_extract(s.object_json,'$.kind')='file'",
            params![binding.workspace_id, scope.key(), project_id],
        ).map_err(storage_error)?;
        Ok(())
    }
    pub(crate) fn source_file_search_plan(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        source: &SourceReadTarget,
        include_history: bool,
        title: &str,
    ) -> AgentResult<FileReadPlan> {
        let plan = self.source_file_plan(request, binding, source)?;
        let current: bool = self
            .conn
            .query_row(
                "SELECT current_version_number=?2 FROM documents WHERE id=?1",
                params![plan.object.id, plan.file_version],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if (!include_history && !current)
            || title != plan.title.chars().take(1000).collect::<String>()
        {
            return Err(AgentError::new(
                ErrorCode::SourceChanged,
                "File search candidate is no longer current",
            ));
        }
        Ok(plan)
    }
    pub(crate) fn source_index_file(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        source: &SourceReadTarget,
        plan: &FileReadPlan,
        cached: &crate::source_search_index::IndexSource,
    ) -> AgentResult<()> {
        let current = self.source_file_plan(request, binding, source)?;
        if &current != plan {
            return Err(AgentError::new(
                ErrorCode::SourceChanged,
                "File changed before indexing",
            ));
        }
        if cached.object != current.object
            || cached.revision != current.registered_hash
            || cached.version != Some(current.file_version)
            || cached.current != source.file_version.is_none()
            || cached.title != current.title.chars().take(1000).collect::<String>()
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid File index ownership",
            ));
        }
        let index = crate::source_search_index::SourceIndex::prepare(&self.conn)?;
        self.source_prune_file_cache(binding, &source.object.scope)?;
        index.replace(cached)
    }
    pub(crate) fn source_file_plan(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        source: &SourceReadTarget,
    ) -> AgentResult<FileReadPlan> {
        let object = self.source_read_object(request, binding, &source.object)?;
        self.source_file_registered_plan(source, object)
    }
    /// User-directed raw history only. Existing AI plan consumers keep the
    /// ordinary source boundary, including GUI requests made on their behalf.
    pub(crate) fn source_file_history_plan(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        source: &SourceReadTarget,
    ) -> AgentResult<FileReadPlan> {
        if !matches!(request.caller, Caller::Gui) || source.file_version.is_none() {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "GUI history requires an explicit File version",
            ));
        }
        let object = self.source_read_historical_file(request, binding, &source.object)?;
        self.source_file_registered_plan(source, object)
    }
    fn source_file_registered_plan(
        &self,
        source: &SourceReadTarget,
        object: ObjectRef,
    ) -> AgentResult<FileReadPlan> {
        if object.kind != ObjectKind::File
            || source.record_version.is_some()
            || source.file_version == Some(0)
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid File source target",
            ));
        }
        if !self
            .table_exists("source_file_version_hashes")
            .map_err(|_| {
                AgentError::new(ErrorCode::IoFailed, "Cannot inspect File source schema")
            })?
        {
            crate::source_search_index::SourceIndex::prepare(&self.conn)?;
        }
        let id = object
            .id
            .parse::<i64>()
            .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Invalid File identity"))?;
        let row: Option<(u32, String, String, Option<String>, String)> = self
            .conn
            .query_row(
                "SELECT v.version_number,v.managed_path,v.name,h.content_hash,v.created_at
             FROM documents d JOIN document_versions v ON v.document_id=d.id
             LEFT JOIN source_file_version_hashes h ON h.document_version_id=v.id
             WHERE d.id=?1 AND v.version_number=COALESCE(?2,d.current_version_number)",
                params![id, source.file_version],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?;
        let (version, path, name, hash, updated_at) = row.ok_or_else(|| {
            AgentError::new(ErrorCode::NotFound, "File Version is no longer retained")
        })?;
        let hash = hash.ok_or_else(|| {
            AgentError::new(
                ErrorCode::SourceNotReady,
                "File Version hash is not registered",
            ).with_details(serde_json::json!({
                "reason": "unregistered_file_version",
                "object": object,
                "fileVersion": version,
                "recovery": {
                    "action": "open_object",
                    "object": object,
                    "label": "打开文件所在项目",
                    "message": "在文件所在项目的文件列表中，右键选择“登记当前内容并打开”，确认后读取新版本。旧版本仍保留为未经核验的内容。"
                }
            }))
        })?;
        if source
            .revision
            .as_ref()
            .is_some_and(|expected| expected != &hash)
        {
            return Err(AgentError::new(
                ErrorCode::SourceChanged,
                "File Version revision changed",
            ));
        }
        let extension = std::path::Path::new(&name)
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let format = match extension.as_str() {
            "txt" => FileSourceFormat::Text,
            "md" | "markdown" => FileSourceFormat::Markdown,
            "html" | "htm" => FileSourceFormat::Html,
            "pdf" => FileSourceFormat::Pdf,
            _ => {
                return Err(AgentError::new(
                    ErrorCode::SourceNotReady,
                    "File format is not supported for text extraction",
                ))
            }
        };
        Ok(FileReadPlan {
            object,
            file_version: version,
            registered_hash: hash,
            title: name,
            updated_at,
            path: self.decode_path_ref(&path),
            format,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            access::{Caller, ScopeGrant},
            models::{ObjectKind, ObjectRef, Scope},
        },
        models::{DocumentImportInput, ProjectCreateInput},
    };
    struct FileStore {
        db: std::sync::Mutex<Database>,
        binding: std::sync::Mutex<WorkspaceBinding>,
    }
    impl crate::committed_changes::CommittedChangePublisher for FileStore {
        fn publish_committed(&self, _changes: crate::committed_changes::CommittedChanges) {}
    }
    impl crate::source_service::BoundSourceStore for FileStore {
        fn with_current<T>(
            &self,
            action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
        ) -> AgentResult<T> {
            action(&self.binding.lock().unwrap(), &self.db.lock().unwrap())
        }
    }
    fn registered_fixture(
        bytes: &[u8],
        extension: &str,
    ) -> (
        tempfile::TempDir,
        FileStore,
        RequestContext,
        SourceReadTarget,
        crate::models::DocumentRecord,
    ) {
        use sha2::{Digest, Sha256};
        let root = tempfile::tempdir().unwrap();
        let mut db =
            Database::open(&root.path().join("sources.sqlite"), root.path(), None).unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "File reading".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let path = root.path().join(format!("证据资料.{extension}"));
        std::fs::write(&path, bytes).unwrap();
        let file = db
            .document_import(DocumentImportInput {
                project_id: project.id,
                source_path: path.to_string_lossy().into(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        crate::source_search_index::SourceIndex::prepare(&db.conn).unwrap();
        let hash = format!("sha256:{:x}", Sha256::digest(bytes));
        let registered: String = db.conn.query_row("SELECT h.content_hash FROM source_file_version_hashes h JOIN document_versions v ON v.id=h.document_version_id WHERE v.document_id=?1 AND v.version_number=1", [file.id], |row| row.get(0)).unwrap();
        assert_eq!(registered, hash);
        let binding = WorkspaceBinding {
            workspace_id: "file-workspace".into(),
            generation: "opened".into(),
        };
        let request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "read-file-pages".into(),
            scope_grant: ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: false,
                project_ids: vec![project.id],
                operations: vec!["source.read".into()],
            },
        };
        let source = SourceReadTarget {
            object: ObjectRef {
                workspace_id: binding.workspace_id.clone(),
                scope: Scope::Project {
                    project_id: project.id,
                },
                kind: ObjectKind::File,
                id: file.id.to_string(),
            },
            revision: Some(hash),
            record_version: None,
            file_version: None,
        };
        (
            root,
            FileStore {
                db: std::sync::Mutex::new(db),
                binding: std::sync::Mutex::new(binding),
            },
            request,
            source,
            file,
        )
    }
    #[tokio::test]
    async fn source_file_search_rechecks_authority_and_bytes_after_async_capture() {
        use crate::agent::models::SourceLocator;
        use crate::source_search_index::{IndexChunk, IndexCoverage, IndexSource, SourceIndex};
        use crate::source_service::{
            BoundSourceStore, SourcePolicyUpdate, SourceSearchInput, SourceService,
        };
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Changing<'a> {
            inner: &'a FileStore,
            phase: AtomicUsize,
            scenario: &'a str,
            path: &'a str,
            request: &'a RequestContext,
            object: &'a ObjectRef,
        }
        impl crate::committed_changes::CommittedChangePublisher for Changing<'_> {
            fn publish_committed(&self, changes: crate::committed_changes::CommittedChanges) {
                crate::committed_changes::CommittedChangePublisher::publish_committed(
                    self.inner, changes,
                );
            }
        }
        impl BoundSourceStore for Changing<'_> {
            fn with_current<T>(
                &self,
                action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
            ) -> AgentResult<T> {
                if self.phase.fetch_add(1, Ordering::SeqCst) == 2 {
                    match self.scenario {
                        "switch" => {
                            self.inner.binding.lock().unwrap().generation = "reopened".into()
                        }
                        "exclude" => {
                            SourceService::new(self.inner)
                                .set_policy(
                                    self.request,
                                    &SourcePolicyUpdate {
                                        object: self.object.clone(),
                                        expected_revision: 0,
                                        excluded: true,
                                    },
                                )
                                .unwrap();
                        }
                        "edit" => std::fs::write(self.path, b"xyz").unwrap(),
                        _ => unreachable!(),
                    }
                }
                self.inner.with_current(action)
            }
        }
        for scenario in ["switch", "exclude", "edit"] {
            let (_root, store, mut request, source, file) = registered_fixture(b"abc", "txt");
            request.scope_grant.operations.push("settings.write".into());
            {
                let db = store.db.lock().unwrap();
                SourceIndex::prepare(&db.conn)
                    .unwrap()
                    .replace(&IndexSource {
                        object: source.object.clone(),
                        revision: source.revision.clone().unwrap(),
                        title: file.name.clone(),
                        chunks: vec![IndexChunk {
                            text: "abc".into(),
                            locator: SourceLocator::Paragraph { start: 1, end: 1 },
                            block_id: None,
                        }],
                        version: Some(1),
                        current: true,
                        updated_at: "2026-10-01T00:00:00Z".into(),
                        coverage: IndexCoverage {
                            chars: 3,
                            complete: true,
                        },
                    })
                    .unwrap();
            }
            let changing = Changing {
                inner: &store,
                phase: AtomicUsize::new(0),
                scenario,
                path: &file.managed_path,
                request: &request,
                object: &source.object,
            };
            let result = SourceService::new(&changing)
                .search(
                    &request,
                    &SourceSearchInput {
                        scope: source.object.scope.clone(),
                        query: "abc".into(),
                        kinds: vec![],
                        selected: vec![],
                        include_history: false,
                        limit: None,
                        budget_chars: None,
                    },
                )
                .await;
            match scenario {
                "exclude" => {
                    let page = result.unwrap();
                    assert!(page.items.is_empty());
                    assert_eq!(page.stale_count, 0);
                    assert!(!page.has_more);
                }
                "switch" => assert_eq!(result.unwrap_err().code, ErrorCode::WorkspaceChanged),
                _ => assert_eq!(result.unwrap_err().code, ErrorCode::SourceChanged),
            }
        }
    }
    #[tokio::test]
    #[ignore = "requires prepared fixed Node source and Record workers"]
    async fn source_mixed_native_record_file_search_preserves_kinds_before_limiting() {
        use crate::{
            models::{ProjectRecordUpsertInput, ProjectUpdateInput, TodoCreateInput, TodoScope},
            source_service::{SourceIndexBudget, SourceSearchInput, SourceService},
        };
        let (_root, store, request, file, _) = registered_fixture(b"mixed evidence", "txt");
        let project_id = request.scope_grant.project_ids[0];
        let (record, todo) = {
            let mut db = store.db.lock().unwrap();
            db.project_update(ProjectUpdateInput {
                project_id,
                name: None,
                summary: "mixed evidence".into(),
                summary_markdown: None,
                summary_html: None,
                summary_code_language: None,
                status: Some("mixed evidence".into()),
            })
            .unwrap();
            let record = db
                .project_record_upsert(ProjectRecordUpsertInput {
                    project_id,
                    note_id: None,
                    title: Some("mixed evidence".into()),
                    html: "<p>mixed evidence</p>".into(),
                    markdown: "mixed evidence".into(),
                    default_code_language: None,
                    tag_ids: vec![],
                })
                .unwrap();
            let todo = db
                .todo_create(TodoCreateInput {
                    scope: TodoScope::Project,
                    project_id: Some(project_id),
                    content: "mixed evidence".into(),
                    priority: "normal".into(),
                    due_date: None,
                    tag_ids: vec![],
                })
                .unwrap();
            (record, todo)
        };
        let target = |kind, id: i64| SourceReadTarget {
            object: ObjectRef {
                kind,
                id: id.to_string(),
                ..file.object.clone()
            },
            revision: None,
            record_version: None,
            file_version: None,
        };
        let record = target(ObjectKind::Record, record.id);
        let worker = crate::source_extraction_worker::SourceExtractionWorker::bundled(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"),
        )
        .unwrap();
        let converter = crate::record_document_worker::RecordDocumentWorker::development().unwrap();
        let service = SourceService::new(&store);
        service
            .prepare_record(&request, &record, &converter)
            .await
            .unwrap();
        service
            .index_record(&request, &record, SourceIndexBudget::default())
            .unwrap();
        service
            .index_file(&request, &file, SourceIndexBudget::default(), &worker)
            .await
            .unwrap();
        service
            .index_native(
                &request,
                &target(ObjectKind::Project, project_id),
                SourceIndexBudget::default(),
            )
            .unwrap();
        service
            .index_native(
                &request,
                &target(ObjectKind::Todo, todo.id),
                SourceIndexBudget::default(),
            )
            .unwrap();
        service
            .index_quick_note(
                &request,
                &target(ObjectKind::QuickNote, project_id),
                SourceIndexBudget::default(),
                &converter,
            )
            .await
            .unwrap();
        let mut query = SourceSearchInput {
            scope: file.object.scope.clone(),
            query: "mixed evidence".into(),
            kinds: vec![],
            selected: vec![],
            include_history: false,
            limit: None,
            budget_chars: Some(12000),
        };
        let mixed = service.search(&request, &query).await.unwrap();
        assert_eq!(mixed.items.len(), 5);
        assert!(!mixed.has_more);
        for kind in [
            ObjectKind::Record,
            ObjectKind::File,
            ObjectKind::Project,
            ObjectKind::Todo,
            ObjectKind::QuickNote,
        ] {
            query.kinds = vec![kind];
            query.limit = Some(1);
            let filtered = service.search(&request, &query).await.unwrap();
            assert_eq!(filtered.items.len(), 1);
            assert_eq!(filtered.items[0].source_ref.object.kind, kind);
            assert!(!filtered.has_more);
        }
    }
    #[tokio::test]
    async fn source_file_search_prunes_foreign_cache_before_ranking_or_capacity() {
        use crate::agent::models::SourceLocator;
        use crate::source_search_index::{IndexChunk, IndexCoverage, IndexSource, SourceIndex};
        use crate::source_service::{SourceSearchInput, SourceService};
        let (root, store, request, source, file) = registered_fixture(b"abc", "txt");
        {
            let mut db = store.db.lock().unwrap();
            let private = db
                .project_create(ProjectCreateInput {
                    name: "Private".into(),
                    summary: None,
                    status: None,
                })
                .unwrap();
            let path = root.path().join("private.txt");
            std::fs::write(&path, b"abc").unwrap();
            let hidden = db
                .document_import(DocumentImportInput {
                    project_id: private.id,
                    source_path: path.to_string_lossy().into(),
                    is_starred: false,
                    tag_ids: None,
                })
                .unwrap();
            let registered: String = db.conn.query_row("SELECT h.content_hash FROM source_file_version_hashes h JOIN document_versions v ON v.id=h.document_version_id WHERE v.document_id=?1", [hidden.id], |row| row.get(0)).unwrap();
            assert_eq!(Some(registered), source.revision);
            let index = SourceIndex::prepare(&db.conn).unwrap();
            for (id, title) in [(file.id, file.name.clone()), (hidden.id, "abc".into())] {
                index
                    .replace(&IndexSource {
                        object: ObjectRef {
                            id: id.to_string(),
                            ..source.object.clone()
                        },
                        revision: source.revision.clone().unwrap(),
                        title,
                        chunks: vec![IndexChunk {
                            text: "abc".into(),
                            locator: SourceLocator::Paragraph { start: 1, end: 1 },
                            block_id: None,
                        }],
                        version: Some(1),
                        current: true,
                        updated_at: "2026-10-01T00:00:00Z".into(),
                        coverage: IndexCoverage {
                            chars: 3,
                            complete: true,
                        },
                    })
                    .unwrap();
            }
        }
        let service = SourceService::new(&store);
        let page = service
            .search(
                &request,
                &SourceSearchInput {
                    scope: source.object.scope.clone(),
                    query: "abc".into(),
                    kinds: vec![],
                    selected: vec![],
                    include_history: false,
                    limit: Some(1),
                    budget_chars: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].source_ref.object, source.object);
        assert_eq!(page.stale_count, 0);
        assert!(!page.has_more);
        assert_eq!(
            service
                .cache_capacity(&request, &source.object.scope)
                .unwrap()
                .snapshots,
            1
        );
    }
    #[tokio::test]
    async fn source_file_index_budget_history_policy_and_deletion_follow_real_business_versions() {
        use crate::source_service::{
            SourceIndexBudget, SourcePolicyUpdate, SourceSearchInput, SourceService,
        };
        use sha2::{Digest, Sha256};
        let text = format!("old evidence {}", "中".repeat(4000));
        let (root, store, mut request, mut source, file) =
            registered_fixture(text.as_bytes(), "txt");
        request.scope_grant.operations.push("settings.write".into());
        source.revision = None;
        let worker = crate::source_extraction_worker::SourceExtractionWorker::bundled(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"),
        )
        .unwrap();
        let service = SourceService::new(&store);
        let mut query = SourceSearchInput {
            scope: source.object.scope.clone(),
            query: "evidence".into(),
            kinds: vec![],
            selected: vec![],
            include_history: false,
            limit: None,
            budget_chars: None,
        };
        service
            .index_file(
                &request,
                &source,
                SourceIndexBudget {
                    max_chars: 1900,
                    max_chunks: 10000,
                },
                &worker,
            )
            .await
            .unwrap();
        let partial = service.search(&request, &query).await.unwrap();
        assert_eq!(partial.items.len(), 1);
        assert_eq!(partial.items[0].coverage.chars, 1900);
        assert!(!partial.items[0].coverage.complete);
        service
            .index_file(&request, &source, SourceIndexBudget::default(), &worker)
            .await
            .unwrap();
        assert_eq!(
            service
                .cache_capacity(&request, &query.scope)
                .unwrap()
                .snapshots,
            1
        );
        let next_path = root.path().join("next.txt");
        std::fs::write(&next_path, b"new evidence").unwrap();
        {
            let mut db = store.db.lock().unwrap();
            db.document_add_version(crate::models::DocumentAddVersionInput {
                document_id: file.id,
                source_path: Some(next_path.to_string_lossy().into()),
            })
            .unwrap();
            let registered: String = db.conn.query_row("SELECT content_hash FROM source_file_version_hashes h JOIN document_versions v ON v.id=h.document_version_id WHERE v.document_id=?1 AND v.version_number=2", [file.id], |row| row.get(0)).unwrap();
            assert_eq!(
                registered,
                format!("sha256:{:x}", Sha256::digest(b"new evidence"))
            );
        }
        // The old cache stops being current even before the new version is indexed.
        assert!(service
            .search(&request, &query)
            .await
            .unwrap()
            .items
            .is_empty());
        service
            .index_file(&request, &source, SourceIndexBudget::default(), &worker)
            .await
            .unwrap();
        let current = service.search(&request, &query).await.unwrap();
        assert_eq!(current.items.len(), 1);
        assert_eq!(current.items[0].source_ref.file_version, Some(2));
        query.include_history = true;
        let history = service.search(&request, &query).await.unwrap();
        assert_eq!(history.items.len(), 2);
        assert!(history
            .items
            .iter()
            .any(|item| item.source_ref.file_version == Some(1) && item.coverage.complete));
        assert_eq!(
            service
                .cache_capacity(&request, &query.scope)
                .unwrap()
                .snapshots,
            2
        );
        request.request_id = "exclude-indexed-file".into();
        service
            .set_policy(
                &request,
                &SourcePolicyUpdate {
                    object: source.object.clone(),
                    expected_revision: 0,
                    excluded: true,
                },
            )
            .unwrap();
        assert_eq!(
            service
                .cache_capacity(&request, &query.scope)
                .unwrap()
                .content_bytes,
            0
        );
        assert!(service
            .search(&request, &query)
            .await
            .unwrap()
            .items
            .is_empty());
        request.request_id = "include-indexed-file".into();
        service
            .set_policy(
                &request,
                &SourcePolicyUpdate {
                    object: source.object.clone(),
                    expected_revision: 1,
                    excluded: false,
                },
            )
            .unwrap();
        service
            .index_file(&request, &source, SourceIndexBudget::default(), &worker)
            .await
            .unwrap();
        assert_eq!(
            service
                .cache_capacity(&request, &query.scope)
                .unwrap()
                .snapshots,
            1
        );
        store
            .db
            .lock()
            .unwrap()
            .document_delete(crate::models::DocumentDeleteInput {
                document_id: file.id,
            })
            .unwrap();
        assert_eq!(
            service
                .cache_capacity(&request, &query.scope)
                .unwrap()
                .snapshots,
            0
        );
        let deleted = service.search(&request, &query).await.unwrap();
        assert!(deleted.items.is_empty());
        assert_eq!(deleted.stale_count, 0);
        assert!(!deleted.has_more);
    }
    #[tokio::test]
    async fn source_file_index_search_uses_registered_current_version_and_rejects_stale_bytes() {
        use crate::source_service::{SourceIndexBudget, SourceSearchInput, SourceService};
        let (_root, store, request, source, file) = registered_fixture(b"current evidence", "txt");
        let worker = crate::source_extraction_worker::SourceExtractionWorker::bundled(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"),
        )
        .unwrap();
        let service = SourceService::new(&store);
        service
            .index_file(&request, &source, SourceIndexBudget::default(), &worker)
            .await
            .unwrap();
        let query = SourceSearchInput {
            scope: source.object.scope.clone(),
            query: "evidence".into(),
            kinds: vec![],
            selected: vec![],
            include_history: false,
            limit: None,
            budget_chars: None,
        };
        let page = service.search(&request, &query).await.unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].source_ref.file_version, Some(1));
        assert_eq!(
            page.items[0].source_ref.revision,
            source.revision.clone().unwrap()
        );
        assert_eq!(page.items[0].source_ref.object, source.object);
        assert_eq!(page.items[0].source_ref.block_id, None);
        assert!(page.items[0].coverage.complete);
        assert!(crate::agent::context::serialized_chars(&page).unwrap() <= 3000);
        std::fs::write(&file.managed_path, b"changed evidence").unwrap();
        let changed = service.search(&request, &query).await.unwrap();
        assert!(changed.items.is_empty());
        assert_eq!(changed.stale_count, 1);
        assert_eq!(
            service
                .index_file(&request, &source, SourceIndexBudget::default(), &worker)
                .await
                .unwrap_err()
                .code,
            ErrorCode::SourceChanged
        );
    }
    #[tokio::test]
    async fn source_file_read_pages_preserve_unicode_without_repeating_chunk_overlap() {
        use crate::agent::models::SourceLocator;
        use crate::source_service::{
            SourceReadInput, SourceReadView, SourceSelection, SourceService,
        };
        let first = "中🙂证据".repeat(900);
        let text = format!("{first}\n\n后续决定");
        let (_root, store, request, source, file) = registered_fixture(text.as_bytes(), "txt");
        let worker = crate::source_extraction_worker::SourceExtractionWorker::bundled(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"),
        )
        .unwrap();
        let service = SourceService::new(&store);
        let mut input = SourceReadInput {
            source,
            view: SourceReadView::Full,
            selection: None,
            cursor: None,
            budget_chars: Some(1200),
        };
        let mut collected = String::new();
        let mut pages = 0;
        loop {
            let page = service.read_file(&request, &input, &worker).await.unwrap();
            assert!(crate::agent::context::serialized_chars(&page).unwrap() <= 1200);
            assert_eq!(page.source_ref.file_version, Some(1));
            assert_eq!(page.source_ref.record_version, None);
            assert_eq!(page.source_ref.block_id, None);
            assert!(!page.source_ref.title.is_empty());
            assert!(page
                .spans
                .iter()
                .all(|span| span.block_id.is_none() && span.end <= page.text.chars().count()));
            collected.push_str(&page.text);
            pages += 1;
            assert_eq!(page.complete, page.next_cursor.is_none());
            input.cursor = page.next_cursor;
            if input.cursor.is_none() {
                break;
            }
            assert!(pages < 100);
        }
        assert!(pages > 1);
        assert_eq!(collected, text);
        input.view = SourceReadView::Range;
        input.selection = Some(SourceSelection {
            block_id: None,
            locator: Some(SourceLocator::Paragraph { start: 2, end: 2 }),
        });
        let page = service.read_file(&request, &input, &worker).await.unwrap();
        assert_eq!(page.text, "后续决定");
        assert!(!page.complete);
        assert!(page.range_complete);
        std::fs::write(&file.managed_path, "外部改写").unwrap();
        assert_eq!(
            service
                .read_file(&request, &input, &worker)
                .await
                .unwrap_err()
                .code,
            ErrorCode::SourceChanged
        );
    }
    #[tokio::test]
    async fn source_file_service_rejects_results_after_binding_policy_bytes_or_version_change() {
        use crate::source_service::{SourcePolicyUpdate, SourceService, SourceUtility};
        struct Paused<'a> {
            worker: &'a crate::source_extraction_worker::SourceExtractionWorker,
            extracted: tokio::sync::Notify,
            resume: tokio::sync::Notify,
        }
        impl SourceUtility for Paused<'_> {
            async fn request(
                &self,
                workspace: &str,
                id: &str,
                format: &str,
                bytes: &[u8],
            ) -> AgentResult<serde_json::Value> {
                let result = self.worker.request(workspace, id, format, bytes).await;
                self.extracted.notify_one();
                self.resume.notified().await;
                result
            }
        }
        let worker = crate::source_extraction_worker::SourceExtractionWorker::bundled(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"),
        )
        .unwrap();
        for scenario in ["switch", "exclude", "edit", "version"] {
            let (_root, store, mut request, mut source, file) = registered_fixture(b"abc", "txt");
            request.scope_grant.operations.push("settings.write".into());
            source.revision = None;
            let utility = Paused {
                worker: &worker,
                extracted: tokio::sync::Notify::new(),
                resume: tokio::sync::Notify::new(),
            };
            let service = SourceService::new(&store);
            let read = service.extract_file(&request, &source, &utility);
            let intervene = async {
                utility.extracted.notified().await;
                match scenario {
                    "switch" => store.binding.lock().unwrap().generation = "another-open".into(),
                    "exclude" => {
                        let mut policy_request = request.clone();
                        policy_request.request_id = "exclude-file-during-extraction".into();
                        service
                            .set_policy(
                                &policy_request,
                                &SourcePolicyUpdate {
                                    object: source.object.clone(),
                                    expected_revision: 0,
                                    excluded: true,
                                },
                            )
                            .unwrap();
                    }
                    "edit" => std::fs::write(&file.managed_path, b"abd").unwrap(),
                    "version" => {
                        store
                            .db
                            .lock()
                            .unwrap()
                            .document_add_version(crate::models::DocumentAddVersionInput {
                                document_id: file.id,
                                source_path: None,
                            })
                            .unwrap();
                    }
                    _ => unreachable!(),
                }
                utility.resume.notify_one();
            };
            let (result, _) = tokio::time::timeout(std::time::Duration::from_secs(20), async {
                tokio::join!(read, intervene)
            })
            .await
            .unwrap();
            assert_eq!(
                result.unwrap_err().code,
                match scenario {
                    "switch" => ErrorCode::WorkspaceChanged,
                    "exclude" => ErrorCode::ScopeDenied,
                    _ => ErrorCode::SourceChanged,
                },
                "{scenario}"
            );
        }
    }
    #[tokio::test]
    async fn source_file_read_cursor_tracks_version_even_when_registered_bytes_are_equal() {
        use crate::source_service::{
            SourcePolicyUpdate, SourceReadInput, SourceReadView, SourceService,
        };
        let text = "原版本证据".repeat(500);
        let (_root, store, request, source, file) = registered_fixture(text.as_bytes(), "txt");
        let worker = crate::source_extraction_worker::SourceExtractionWorker::bundled(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"),
        )
        .unwrap();
        let service = SourceService::new(&store);
        let mut input = SourceReadInput {
            source,
            view: SourceReadView::Full,
            selection: None,
            cursor: None,
            budget_chars: Some(1200),
        };
        let first = service.read_file(&request, &input, &worker).await.unwrap();
        input.cursor = first.next_cursor;
        assert!(input.cursor.is_some());
        store
            .db
            .lock()
            .unwrap()
            .document_add_version(crate::models::DocumentAddVersionInput {
                document_id: file.id,
                source_path: None,
            })
            .unwrap();
        assert_eq!(
            service
                .read_file(&request, &input, &worker)
                .await
                .unwrap_err()
                .code,
            ErrorCode::SourceChanged
        );
        // Native version registration is now atomic with the head; the equal
        // hash cannot make a cursor for another File Version current again.
        input.cursor = None;
        input.source.file_version = Some(1);
        input.budget_chars = Some(12000);
        let retained = service.read_file(&request, &input, &worker).await.unwrap();
        assert_eq!(retained.text, text);
        assert_eq!(retained.source_ref.file_version, Some(1));
        assert!(retained.complete);
        input.source.file_version = None;
        let current = service.read_file(&request, &input, &worker).await.unwrap();
        assert_eq!(current.text, text);
        assert_eq!(current.source_ref.file_version, Some(2));
        let mut policy_request = request.clone();
        policy_request.request_id = "exclude-file-history".into();
        policy_request
            .scope_grant
            .operations
            .push("settings.write".into());
        service
            .set_policy(
                &policy_request,
                &SourcePolicyUpdate {
                    object: input.source.object.clone(),
                    expected_revision: 0,
                    excluded: true,
                },
            )
            .unwrap();
        for version in [None, Some(1)] {
            input.source.file_version = version;
            assert_eq!(
                service
                    .read_file(&request, &input, &worker)
                    .await
                    .unwrap_err()
                    .code,
                ErrorCode::ScopeDenied
            );
        }
    }
    // Two real PDF pages, one with ASCII text and one without a text layer.
    fn mixed_pdf(text: &str) -> Vec<u8> {
        let stream = format!("BT /F1 12 Tf 20 100 Td ({text}) Tj ET");
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Count 2 /Kids [4 0 R 5 0 R] >>".to_string(),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents 6 0 R >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 7 0 R >>".to_string(),
            format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
            "<< /Length 0 >>\nstream\n\nendstream".to_string(),
        ];
        let mut pdf = "%PDF-1.4\n".to_string();
        let mut offsets = vec![0];
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.push_str(&format!("{} 0 obj\n{object}\nendobj\n", index + 1));
        }
        let xref = pdf.len();
        pdf.push_str("xref\n0 8\n0000000000 65535 f \n");
        for offset in offsets.iter().skip(1) {
            pdf.push_str(&format!("{offset:010} 00000 n \n"));
        }
        pdf.push_str(&format!(
            "trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
        ));
        pdf.into_bytes()
    }
    #[tokio::test]
    async fn source_file_scan_is_discoverable_by_title_and_read_preserves_needs_ocr() {
        use crate::source_service::{
            SourceIndexBudget, SourceReadInput, SourceReadView, SourceSearchInput, SourceService,
        };
        let (_root, store, request, source, _file) = registered_fixture(&mixed_pdf(""), "pdf");
        let worker = crate::source_extraction_worker::SourceExtractionWorker::bundled(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"),
        )
        .unwrap();
        let service = SourceService::new(&store);
        service
            .index_file(&request, &source, SourceIndexBudget::default(), &worker)
            .await
            .unwrap();
        let page = service
            .search(
                &request,
                &SourceSearchInput {
                    scope: source.object.scope.clone(),
                    query: "证据资料".into(),
                    kinds: vec![],
                    selected: vec![],
                    include_history: false,
                    limit: None,
                    budget_chars: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].source_ref.file_version, Some(1));
        assert_eq!(page.items[0].source_ref.object, source.object);
        assert_eq!(page.items[0].excerpt, "");
        assert!(page.items[0].source_ref.locator.is_none());
        assert_eq!(page.items[0].coverage.chars, 0);
        assert!(!page.items[0].coverage.complete);
        let read = service
            .read_file(
                &request,
                &SourceReadInput {
                    source,
                    view: SourceReadView::Full,
                    selection: None,
                    cursor: None,
                    budget_chars: None,
                },
                &worker,
            )
            .await
            .unwrap();
        assert_eq!(read.text, "");
        assert!(read.spans.is_empty());
        assert!(!read.complete);
        assert!(!read.range_complete);
        assert_eq!(read.extraction.unwrap().state, "needs_ocr");
    }
    #[tokio::test]
    async fn source_file_read_reports_partial_pdf_coverage_and_exact_page_character_ranges() {
        use crate::agent::models::SourceLocator;
        use crate::source_service::{
            SourceReadInput, SourceReadView, SourceSelection, SourceService,
        };
        let (_root, store, request, source, _file) =
            registered_fixture(&mixed_pdf("Readable evidence"), "pdf");
        let worker = crate::source_extraction_worker::SourceExtractionWorker::bundled(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"),
        )
        .unwrap();
        let service = SourceService::new(&store);
        let mut input = SourceReadInput {
            source,
            view: SourceReadView::Full,
            selection: None,
            cursor: None,
            budget_chars: None,
        };
        let full = service.read_file(&request, &input, &worker).await.unwrap();
        assert_eq!(full.text, "Readable evidence");
        assert!(!full.complete);
        assert!(!full.range_complete);
        assert!(full.next_cursor.is_none());
        let extraction = full.extraction.unwrap();
        assert_eq!(extraction.state, "partial");
        assert_eq!(extraction.reason.as_deref(), Some("missing_text"));
        assert_eq!(extraction.coverage["totalPages"], 2);
        assert_eq!(extraction.coverage["textPages"], serde_json::json!([1]));
        input.view = SourceReadView::Range;
        input.selection = Some(SourceSelection {
            block_id: None,
            locator: Some(SourceLocator::Page {
                page: 1,
                start: 9,
                end: 17,
            }),
        });
        let range = service.read_file(&request, &input, &worker).await.unwrap();
        assert_eq!(range.text, "evidence");
        assert!(!range.complete);
        assert!(range.range_complete);
        assert!(matches!(
            range.spans[0].locator,
            SourceLocator::Page {
                page: 1,
                start: 9,
                end: 17
            }
        ));
        input.selection = Some(SourceSelection {
            block_id: None,
            locator: Some(SourceLocator::Page {
                page: 2,
                start: 0,
                end: 1,
            }),
        });
        assert_eq!(
            service
                .read_file(&request, &input, &worker)
                .await
                .unwrap_err()
                .code,
            ErrorCode::SourceNotReady
        );
    }
    #[tokio::test]
    async fn source_file_service_extracts_registered_bytes_through_the_fixed_worker() {
        use crate::source_service::SourceService;
        let (_root, store, request, target, file) = registered_fixture(b"abc", "txt");
        let registered = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        let worker = crate::source_extraction_worker::SourceExtractionWorker::bundled(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"),
        )
        .unwrap();
        let result = SourceService::new(&store)
            .extract_file(&request, &target, &worker)
            .await
            .unwrap();
        assert_eq!(result.object, target.object);
        assert_eq!(result.revision, registered);
        assert_eq!(result.file_version, 1);
        assert_eq!(result.data["state"], "ready");
        assert_eq!(result.data["chunks"][0]["text"], "abc");
        assert_eq!(result.data["coverage"]["complete"], true);
        std::fs::write(file.managed_path, b"abd").unwrap();
        assert_eq!(
            SourceService::new(&store)
                .extract_file(&request, &target, &worker)
                .await
                .unwrap_err()
                .code,
            ErrorCode::SourceChanged
        );
    }
    #[tokio::test]
    async fn source_file_plan_reads_only_the_registered_version_hash_and_detects_external_changes()
    {
        use crate::source_service::BoundSourceStore;
        let (_root, store, request, mut target, file) = registered_fixture(b"abc", "txt");
        target.file_version = Some(1);
        let plan = store
            .with_current(|binding, db| db.source_file_plan(&request, binding, &target))
            .unwrap();
        assert_eq!(plan.file_version, 1);
        let snapshot = crate::source_file_snapshot::capture_file(&plan)
            .await
            .unwrap();
        assert_eq!(snapshot.bytes, b"abc");
        std::fs::write(&file.managed_path, b"abd").unwrap();
        assert_eq!(
            crate::source_file_snapshot::capture_file(&plan)
                .await
                .unwrap_err()
                .code,
            ErrorCode::SourceChanged
        );
        target.file_version = Some(2);
        assert_eq!(
            store
                .with_current(|binding, db| db.source_file_plan(&request, binding, &target))
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
    }
    #[test]
    fn source_file_plan_resolves_owner_before_paths_or_registration_state() {
        let root = tempfile::tempdir().unwrap();
        let (metadata, paths) =
            crate::workspace::create_workspace(root.path(), "password").unwrap();
        let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
        db.bind_native_workspace(&metadata.workspace_id).unwrap();
        let mut projects = vec![];
        let mut files = vec![];
        for name in ["Visible", "Private"] {
            let project = db
                .project_create(ProjectCreateInput {
                    name: name.into(),
                    summary: None,
                    status: None,
                })
                .unwrap();
            let source = root.path().join(format!("{name}.txt"));
            std::fs::write(&source, b"abc").unwrap();
            let file = db
                .document_import_legacy_fixture(DocumentImportInput {
                    project_id: project.id,
                    source_path: source.to_string_lossy().into(),
                    is_starred: false,
                    tag_ids: None,
                })
                .unwrap();
            projects.push(project.id);
            files.push(file.id);
        }
        let binding = WorkspaceBinding {
            workspace_id: metadata.workspace_id,
            generation: "opened".into(),
        };
        let request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "read-file".into(),
            scope_grant: ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: false,
                project_ids: vec![projects[0]],
                operations: vec!["source.read".into()],
            },
        };
        let mut source = SourceReadTarget {
            object: ObjectRef {
                workspace_id: binding.workspace_id.clone(),
                scope: Scope::Project {
                    project_id: projects[0],
                },
                kind: ObjectKind::File,
                id: files[1].to_string(),
            },
            revision: None,
            record_version: None,
            file_version: None,
        };
        let denied = db
            .source_file_plan(&request, &binding, &source)
            .unwrap_err();
        assert_eq!(denied.code, ErrorCode::ScopeDenied);
        assert!(
            denied.details.is_none(),
            "Denied sources cannot reveal recovery navigation"
        );
        source.object.id = files[0].to_string();
        let unavailable = db
            .source_file_plan(&request, &binding, &source)
            .unwrap_err();
        assert_eq!(unavailable.code, ErrorCode::SourceNotReady);
        let details = unavailable.details.unwrap();
        assert_eq!(details["reason"], "unregistered_file_version");
        assert_eq!(details["object"], serde_json::json!(source.object));
        assert_eq!(details["fileVersion"], 1);
        assert_eq!(details["recovery"]["action"], "open_object");
        assert_eq!(
            details["recovery"]["object"],
            serde_json::json!(source.object)
        );
        assert!(details["recovery"]["message"]
            .as_str()
            .unwrap()
            .contains("登记当前内容并打开"));
        assert!(!serde_json::to_string(&details)
            .unwrap()
            .contains(root.path().to_str().unwrap()));
        // Reading an unregistered legacy source supplies guidance only; it
        // neither manufactures an old hash nor changes its version history.
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM source_file_version_hashes",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM document_versions WHERE document_id=?1",
                    [files[0]],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );

        // The existing explicit GUI registration creates a new version and a
        // durable source event; repeating that confirmed request is idempotent.
        let file = db.document_record(files[0]).unwrap();
        let intent = db
            .file_version_prepare_gui(&crate::db::file_versions::GuiFileVersionPrepare {
                document_id: file.id,
                project_id: file.project_id,
                managed_path: file.managed_path,
                expected_version_number: 1,
                source_path: None,
            })
            .unwrap();
        assert!(intent.registered_content_hash.is_none());
        let receipt = db
            .file_version_commit_gui(&binding, "confirm-legacy", &intent, true)
            .unwrap();
        assert_eq!(receipt.version_number, 2);
        assert_eq!(
            db.file_version_commit_gui(&binding, "confirm-legacy", &intent, true)
                .unwrap(),
            receipt
        );
        let current = db.source_file_plan(&request, &binding, &source).unwrap();
        assert_eq!(current.file_version, 2);
        assert_eq!(current.registered_hash, receipt.content_hash);
        assert_eq!(db.conn.query_row("SELECT count(*) FROM source_file_version_hashes h JOIN document_versions v ON v.id=h.document_version_id WHERE v.document_id=?1 AND v.version_number=1", [files[0]], |row|row.get::<_,i64>(0)).unwrap(), 0);
        source.file_version = Some(1);
        assert_eq!(
            db.source_file_plan(&request, &binding, &source)
                .unwrap_err()
                .code,
            ErrorCode::SourceNotReady
        );
        source.file_version = None;
        let queue_at = chrono::Utc::now();
        db.source_queue_sync(&request, &binding, &source.object.scope, queue_at)
            .unwrap();
        let queued_state: String = db
            .conn
            .query_row(
                "SELECT state FROM agent_jobs WHERE kind='extract' AND dedupe_key=?1",
                [format!("source-index:{}", source.object.key().unwrap())],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(queued_state, "queued");
        // Project creation is also a valid source job. Equal ready times use
        // random job IDs as a tiebreaker, so consume earlier leases through the
        // real finish API instead of assuming that this File sorts first.
        let pending: i64 = db.conn.query_row(
            "SELECT count(*) FROM agent_jobs WHERE kind='extract' AND state='queued' AND scope_key=?1",
            [source.object.scope.key()],
            |row| row.get(0),
        ).unwrap();
        let claim_at = queue_at + chrono::Duration::seconds(1);
        let mut file_lease = None;
        for _ in 0..pending {
            let lease = db
                .source_queue_claim(&request, &binding, &source.object.scope, claim_at)
                .unwrap()
                .expect("Registered source jobs must be claimable");
            if lease.object == source.object {
                file_lease = Some(lease);
                break;
            }
            assert!(db
                .source_queue_finish(
                    &request,
                    &binding,
                    &lease,
                    crate::db::source_index_queue::SourceIndexOutcome::Completed,
                    claim_at,
                )
                .unwrap());
        }
        assert_eq!(
            file_lease.expect("Registered File must be claimed").object,
            source.object
        );
        let mut switched = binding.clone();
        switched.generation = "switched".into();
        assert_eq!(
            db.source_file_plan(&request, &switched, &source)
                .unwrap_err()
                .code,
            ErrorCode::WorkspaceChanged
        );
    }
}
