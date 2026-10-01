//! Authoritative File Version descriptors. Paths stay inside native services.
use super::Database;
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, WorkspaceBinding},
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
    pub(crate) fn source_file_plan(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        source: &SourceReadTarget,
    ) -> AgentResult<FileReadPlan> {
        let object =
            self.source_resolve_business(request, binding, &source.object, "source.read")?;
        if object.kind != ObjectKind::File
            || source.record_version.is_some()
            || source.file_version == Some(0)
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid File source target",
            ));
        }
        self.source_live_scope(&object.scope)?;
        self.source_prepare()?;
        let excluded: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM source_access_policies WHERE object_key=?1 AND excluded=1)",
            [object.key()?],
            |row| row.get(0),
        ).map_err(storage_error)?;
        if excluded {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Source is excluded from AI access",
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
        let row: Option<(u32, String, String, Option<String>)> = self
            .conn
            .query_row(
                "SELECT v.version_number,v.managed_path,v.name,h.content_hash
             FROM documents d JOIN document_versions v ON v.document_id=d.id
             LEFT JOIN source_file_version_hashes h ON h.document_version_id=v.id
             WHERE d.id=?1 AND v.version_number=COALESCE(?2,d.current_version_number)",
                params![id, source.file_version],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(storage_error)?;
        let (version, path, name, hash) = row.ok_or_else(|| {
            AgentError::new(ErrorCode::NotFound, "File Version is no longer retained")
        })?;
        let hash = hash.ok_or_else(|| {
            AgentError::new(
                ErrorCode::SourceNotReady,
                "File Version hash is not registered",
            )
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
        db.conn.execute("INSERT INTO source_file_version_hashes(document_version_id,content_hash) SELECT id,?1 FROM document_versions WHERE document_id=?2 AND version_number=1",params![hash,file.id]).unwrap();
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
        use crate::source_service::{
            BoundSourceStore, SourcePolicyUpdate, SourceService, SourceUtility,
        };
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
            ErrorCode::SourceNotReady
        );
        {
            let db = store.db.lock().unwrap();
            db.conn.execute("INSERT INTO source_file_version_hashes(document_version_id,content_hash) SELECT id,?1 FROM document_versions WHERE document_id=?2 AND version_number=2",params![input.source.revision,file.id]).unwrap();
        }
        assert_eq!(
            service
                .read_file(&request, &input, &worker)
                .await
                .unwrap_err()
                .code,
            ErrorCode::SourceChanged
        );
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
    fn mixed_pdf() -> Vec<u8> {
        let stream = "BT /F1 12 Tf 20 100 Td (Readable evidence) Tj ET";
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
    async fn source_file_read_reports_partial_pdf_coverage_and_exact_page_character_ranges() {
        use crate::agent::models::SourceLocator;
        use crate::source_service::{
            SourceReadInput, SourceReadView, SourceSelection, SourceService,
        };
        let (_root, store, request, source, _file) = registered_fixture(&mixed_pdf(), "pdf");
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
        let mut db =
            Database::open(&root.path().join("sources.sqlite"), root.path(), None).unwrap();
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
                .document_import(DocumentImportInput {
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
            workspace_id: "file-workspace".into(),
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
        assert_eq!(
            db.source_file_plan(&request, &binding, &source)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        source.object.id = files[0].to_string();
        assert_eq!(
            db.source_file_plan(&request, &binding, &source)
                .unwrap_err()
                .code,
            ErrorCode::SourceNotReady
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
