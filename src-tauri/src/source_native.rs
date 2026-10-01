//! Native Project fields use the same source budget/cursor contract as text
//! documents while retaining their own semantic revision and ownership.
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectRef, SourceLocator, SourceRef},
    },
    source_service::{
        BoundSourceStore, SourceIndexBudget, SourceReadInput, SourceReadPage, SourceReadTarget,
        SourceReadView, SourceService,
    },
};
pub(crate) struct NativeSourceSnapshot {
    pub object: ObjectRef,
    pub revision: String,
    pub title: String,
    pub paragraphs: Vec<String>,
    pub updated_at: String,
}
fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
pub(crate) struct NativeQuickNoteSnapshot {
    pub source: NativeSourceSnapshot,
    pub html: String,
    pub code_language: Option<String>,
}
fn index_snapshot(
    snapshot: NativeSourceSnapshot,
    budget: SourceIndexBudget,
) -> AgentResult<crate::source_search_index::IndexSource> {
    use crate::source_search_index::{IndexChunk, IndexCoverage, IndexSource};
    let max_chars = budget.max_chars.min(2 * 1024 * 1024);
    let max_chunks = budget.max_chunks.min(10000);
    if max_chars == 0 || max_chunks == 0 {
        return Err(invalid("Source index budgets must be positive"));
    }
    let mut chunks = vec![];
    let mut unique_chars = 0;
    let mut complete = true;
    'paragraphs: for (index, paragraph) in snapshot.paragraphs.iter().enumerate() {
        let characters: Vec<char> = paragraph.chars().collect();
        if characters.is_empty() {
            continue;
        }
        let allowed = characters.len().min(max_chars - unique_chars);
        if allowed == 0 {
            complete = false;
            break;
        }
        let mut offset = 0;
        let mut covered = 0;
        while offset < allowed {
            if chunks.len() == max_chunks {
                complete = false;
                break 'paragraphs;
            }
            let end = (offset + 1800).min(allowed);
            chunks.push(IndexChunk {
                text: characters[offset..end].iter().collect(),
                locator: SourceLocator::Paragraph {
                    start: index as u32 + 1,
                    end: index as u32 + 1,
                },
                block_id: None,
            });
            unique_chars += end - covered;
            covered = end;
            if end == allowed {
                break;
            }
            offset = end - 200;
        }
        if allowed < characters.len() {
            complete = false;
            break;
        }
    }
    let cached = IndexSource {
        object: snapshot.object,
        revision: snapshot.revision,
        title: snapshot.title.chars().take(1000).collect(),
        chunks,
        version: None,
        updated_at: snapshot.updated_at,
        current: true,
        coverage: IndexCoverage {
            chars: unique_chars as u32,
            complete,
        },
    };
    Ok(cached)
}
fn validate_read(input: &SourceReadInput) -> AgentResult<Option<(u32, u32)>> {
    if input.budget_chars == Some(0)
        || input.source.revision.as_ref().is_some_and(|revision| {
            revision.len() != 71
                || !revision.starts_with("sha256:")
                || !revision.as_bytes()[7..]
                    .iter()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
        })
    {
        return Err(invalid("Invalid native source revision or budget"));
    }
    let range = match (input.view, &input.selection) {
        (SourceReadView::Full, None) => None,
        (SourceReadView::Range, Some(selection)) if selection.block_id.is_none() => {
            match &selection.locator {
                Some(SourceLocator::Paragraph { start, end }) if *start > 0 && end >= start => {
                    Some((*start, *end))
                }
                _ => return Err(invalid("Choose a native source paragraph range")),
            }
        }
        _ => {
            return Err(invalid(
                "Choose an explicit full view or native source range",
            ))
        }
    };
    Ok(range)
}
fn read_snapshot(
    input: &SourceReadInput,
    snapshot: &NativeSourceSnapshot,
) -> AgentResult<SourceReadPage> {
    let range = validate_read(input)?;
    let cursor = crate::source_text_page::decode_cursor(input)?;
    if range.is_some_and(|(_, end)| end as usize > snapshot.paragraphs.len()) {
        return Err(invalid("Paragraph range exceeds native source fields"));
    }
    let mut text = String::new();
    let mut spans = vec![];
    let mut chars = 0;
    for (index, paragraph) in snapshot.paragraphs.iter().enumerate() {
        let number = index as u32 + 1;
        if range.is_some_and(|(start, end)| number < start || number > end) {
            continue;
        }
        if !text.is_empty() {
            text.push_str("\n\n");
            chars += 2;
        }
        let start = chars;
        chars += paragraph.chars().count();
        text.push_str(paragraph);
        spans.push(crate::source_text_page::TextSpan {
            start,
            end: chars,
            block_id: None,
            locator: SourceLocator::Paragraph {
                start: number,
                end: number,
            },
        });
    }
    crate::source_text_page::paginate(
        input,
        SourceRef {
            object: snapshot.object.clone(),
            revision: snapshot.revision.clone(),
            title: snapshot.title.clone(),
            file_version: None,
            record_version: None,
            block_id: None,
            locator: None,
            excerpt: String::new(),
        },
        &text,
        &spans,
        cursor,
        None,
    )
}

impl<'a, S: BoundSourceStore> SourceService<'a, S> {
    pub(crate) fn index_native(
        &self,
        request: &RequestContext,
        source: &SourceReadTarget,
        budget: SourceIndexBudget,
    ) -> AgentResult<()> {
        if !matches!(
            source.object.kind,
            crate::agent::models::ObjectKind::Project | crate::agent::models::ObjectKind::Todo
        ) {
            return Err(invalid("Choose a Project or Todo native source"));
        }
        let snapshot = self
            .store
            .with_current(|binding, db| db.source_native_snapshot(request, binding, source))?;
        let cached = index_snapshot(snapshot, budget)?;
        self.store
            .with_current(|binding, db| db.source_index_native(request, binding, source, &cached))
    }
    pub(crate) fn read_native(
        &self,
        request: &RequestContext,
        input: &SourceReadInput,
    ) -> AgentResult<SourceReadPage> {
        validate_read(input)?;
        if !matches!(
            input.source.object.kind,
            crate::agent::models::ObjectKind::Project | crate::agent::models::ObjectKind::Todo
        ) {
            return Err(invalid("Choose a Project or Todo native source"));
        }
        let snapshot = self.store.with_current(|binding, db| {
            db.source_native_snapshot(request, binding, &input.source)
        })?;
        let page = read_snapshot(input, &snapshot)?;
        self.verify_native(request, &input.source, &snapshot.revision)?;
        Ok(page)
    }
    fn verify_native(
        &self,
        request: &RequestContext,
        source: &SourceReadTarget,
        revision: &str,
    ) -> AgentResult<()> {
        self.store.with_current(|binding, db| {
            let current = db.source_native_snapshot(request, binding, source)?;
            if current.revision != revision {
                return Err(AgentError::new(
                    ErrorCode::SourceChanged,
                    "Native source changed during reading",
                ));
            }
            Ok(())
        })
    }
    async fn convert_quick_note<W: crate::record_document_service::DocumentUtility>(
        &self,
        request: &RequestContext,
        source: &SourceReadTarget,
        utility: &W,
    ) -> AgentResult<NativeSourceSnapshot> {
        let raw = self
            .store
            .with_current(|binding, db| db.source_quick_note_snapshot(request, binding, source))?;
        // Convert a read-only copy of persisted Committed Content outside the
        // DB lock. Generated block IDs are temporary and never become evidence.
        let data = utility
            .request(
                &request.request_id,
                "record.initialize",
                serde_json::json!({
                    "html":raw.html, "codeLanguage":raw.code_language
                }),
            )
            .await?;
        let projection: crate::record_documents::RecordDocumentProjection =
            serde_json::from_value(data).map_err(|_| {
                AgentError::new(
                    ErrorCode::RuntimeIncompatible,
                    "Invalid QuickNote projection",
                )
            })?;
        projection.validate()?;
        let paragraphs = crate::source_service::committed_paragraphs(&projection.document)?;
        self.verify_native(request, source, &raw.source.revision)?;
        Ok(NativeSourceSnapshot {
            paragraphs,
            ..raw.source
        })
    }
    pub(crate) async fn read_quick_note<W: crate::record_document_service::DocumentUtility>(
        &self,
        request: &RequestContext,
        input: &SourceReadInput,
        utility: &W,
    ) -> AgentResult<SourceReadPage> {
        validate_read(input)?;
        crate::source_text_page::decode_cursor(input)?;
        let snapshot = self
            .convert_quick_note(request, &input.source, utility)
            .await?;
        let page = read_snapshot(input, &snapshot)?;
        self.verify_native(request, &input.source, &snapshot.revision)?;
        Ok(page)
    }
    pub(crate) async fn index_quick_note<W: crate::record_document_service::DocumentUtility>(
        &self,
        request: &RequestContext,
        source: &SourceReadTarget,
        budget: SourceIndexBudget,
        utility: &W,
    ) -> AgentResult<()> {
        if budget.max_chars == 0 || budget.max_chunks == 0 {
            return Err(invalid("Source index budgets must be positive"));
        }
        let snapshot = self.convert_quick_note(request, source, utility).await?;
        let cached = index_snapshot(snapshot, budget)?;
        self.store
            .with_current(|binding, db| db.source_index_native(request, binding, source, &cached))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            access::{Caller, ScopeGrant},
            models::{ObjectKind, Scope, WorkspaceBinding},
        },
        db::Database,
        models::{ProjectCreateInput, ProjectUpdateInput},
        source_service::{SourceIndexBudget, SourceReadTarget, SourceSearchInput},
    };
    use std::sync::Mutex;
    struct Store {
        binding: Mutex<WorkspaceBinding>,
        db: Mutex<Database>,
    }
    impl BoundSourceStore for Store {
        fn with_current<T>(
            &self,
            action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
        ) -> AgentResult<T> {
            action(&self.binding.lock().unwrap(), &self.db.lock().unwrap())
        }
    }
    fn fixture() -> (tempfile::TempDir, Store, RequestContext, SourceReadInput) {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("native.sqlite"), root.path(), None).unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "原生项目验收".into(),
                summary: Some("私有缓冲区".into()),
                status: Some("active".into()),
            })
            .unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "native-workspace".into(),
            generation: "first-open".into(),
        };
        let request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "native-test".into(),
            scope_grant: ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: true,
                project_ids: vec![project.id],
                operations: vec!["source.read".into(), "settings.write".into()],
            },
        };
        let input = SourceReadInput {
            source: SourceReadTarget {
                object: ObjectRef {
                    workspace_id: binding.workspace_id.clone(),
                    scope: Scope::Project {
                        project_id: project.id,
                    },
                    kind: ObjectKind::Project,
                    id: project.id.to_string(),
                },
                revision: None,
                record_version: None,
                file_version: None,
            },
            view: SourceReadView::Full,
            selection: None,
            cursor: None,
            budget_chars: None,
        };
        (
            root,
            Store {
                binding: Mutex::new(binding),
                db: Mutex::new(db),
            },
            request,
            input,
        )
    }
    fn search(input: &SourceReadInput, query: &str) -> SourceSearchInput {
        SourceSearchInput {
            scope: input.source.object.scope.clone(),
            query: query.into(),
            kinds: vec![],
            selected: vec![],
            include_history: true,
            limit: None,
            budget_chars: None,
        }
    }
    #[tokio::test]
    async fn source_project_index_search_tracks_semantic_changes_without_retaining_native_history()
    {
        let (_root, store, request, input) = fixture();
        let service = SourceService::new(&store);
        service
            .index_native(&request, &input.source, SourceIndexBudget::default())
            .unwrap();
        let found = service
            .search(&request, &search(&input, "原生项目验收"))
            .await
            .unwrap();
        assert_eq!(found.items.len(), 1);
        assert_eq!(found.items[0].source_ref.object, input.source.object);
        assert!(found.items[0].source_ref.block_id.is_none());
        assert!(found.items[0].source_ref.record_version.is_none());
        assert!(found.items[0].source_ref.file_version.is_none());
        assert!(service
            .search(&request, &search(&input, "私有缓冲区"))
            .await
            .unwrap()
            .items
            .is_empty());
        for state in ["review", "done", "active"] {
            store
                .db
                .lock()
                .unwrap()
                .project_update(ProjectUpdateInput {
                    project_id: input.source.object.id.parse().unwrap(),
                    name: None,
                    summary: "新的私有缓冲".into(),
                    summary_markdown: None,
                    summary_html: None,
                    summary_code_language: None,
                    status: Some(state.into()),
                })
                .unwrap();
            let stale = service
                .search(&request, &search(&input, "原生项目验收"))
                .await
                .unwrap();
            assert!(stale.items.is_empty());
            assert_eq!(stale.stale_count, 1);
            service
                .index_native(&request, &input.source, SourceIndexBudget::default())
                .unwrap();
            let current = service.read(&request, &input).unwrap();
            let found = service
                .search(&request, &search(&input, state))
                .await
                .unwrap();
            assert_eq!(found.items.len(), 1);
            assert_eq!(
                found.items[0].source_ref.revision,
                current.source_ref.revision
            );
            assert!(found.items[0].coverage.complete);
            let capacity = service
                .cache_capacity(&request, &input.source.object.scope)
                .unwrap();
            assert_eq!(capacity.objects, 1);
            assert_eq!(capacity.snapshots, 1);
        }
    }
    #[tokio::test]
    async fn source_project_kind_filter_runs_before_result_limit() {
        let (_root, store, request, input) = fixture();
        let service = SourceService::new(&store);
        service
            .index_native(&request, &input.source, SourceIndexBudget::default())
            .unwrap();
        let query: SourceSearchInput = serde_json::from_value(serde_json::json!({
            "scope": input.source.object.scope, "query": "原生项目验收", "limit": 1,
            "kinds": ["record"]
        }))
        .unwrap();
        let found = service.search(&request, &query).await.unwrap();
        assert!(found.items.is_empty());
        assert!(!found.has_more);
    }

    #[test]
    fn source_project_reads_enforce_owner_grants_generation_and_native_selection() {
        use crate::{
            models::ProjectArchiveInput,
            source_service::{SourcePolicyUpdate, SourceSelection},
        };
        let (_root, store, request, input) = fixture();
        let service = SourceService::new(&store);
        let mut forged = input.clone();
        forged.source.object.scope = Scope::Workspace;
        assert_eq!(
            service.read(&request, &forged).unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        let mut denied = request.clone();
        denied.scope_grant.project_ids.clear();
        assert_eq!(
            service.read(&denied, &input).unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        for file in [false, true] {
            let mut version = input.clone();
            if file {
                version.source.file_version = Some(1);
            } else {
                version.source.record_version = Some(1);
            }
            assert_eq!(
                service.read(&request, &version).unwrap_err().code,
                ErrorCode::InvalidArgument
            );
        }
        let mut range = input.clone();
        range.view = SourceReadView::Range;
        range.selection = Some(SourceSelection {
            block_id: None,
            locator: Some(SourceLocator::Paragraph { start: 2, end: 2 }),
        });
        let page = service.read(&request, &range).unwrap();
        assert_eq!(page.text, "状态：active");
        assert!(page.range_complete);
        assert!(!page.complete);
        range.selection.as_mut().unwrap().block_id =
            Some("1234567890abcdef1234567890abcdef".into());
        assert_eq!(
            service.read(&request, &range).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
        range.selection.as_mut().unwrap().block_id = None;
        range.selection.as_mut().unwrap().locator =
            Some(SourceLocator::Paragraph { start: 4, end: 4 });
        assert_eq!(
            service.read(&request, &range).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
        service
            .set_policy(
                &request,
                &SourcePolicyUpdate {
                    object: input.source.object.clone(),
                    expected_revision: 0,
                    excluded: true,
                },
            )
            .unwrap();
        assert_eq!(
            service.read(&request, &input).unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            service
                .cache_capacity(&request, &input.source.object.scope)
                .unwrap()
                .snapshots,
            0
        );
        let mut restore_request = request.clone();
        restore_request.request_id = "restore-access".into();
        service
            .set_policy(
                &restore_request,
                &SourcePolicyUpdate {
                    object: input.source.object.clone(),
                    expected_revision: 1,
                    excluded: false,
                },
            )
            .unwrap();
        store
            .db
            .lock()
            .unwrap()
            .project_set_archive(ProjectArchiveInput {
                project_id: input.source.object.id.parse().unwrap(),
                is_archived: true,
            })
            .unwrap();
        assert_eq!(
            service.read(&request, &input).unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            service
                .index_native(&request, &input.source, SourceIndexBudget::default())
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        store.binding.lock().unwrap().generation = "reopened".into();
        assert_eq!(
            service.read(&request, &input).unwrap_err().code,
            ErrorCode::WorkspaceChanged
        );
    }
    #[test]
    fn source_project_unicode_paging_and_index_budget_report_actual_coverage() {
        let (_root, store, request, mut input) = fixture();
        let status = "状态🙂".repeat(1800);
        store
            .db
            .lock()
            .unwrap()
            .project_update(ProjectUpdateInput {
                project_id: input.source.object.id.parse().unwrap(),
                name: None,
                summary: "buffer".into(),
                summary_markdown: None,
                summary_html: None,
                summary_code_language: None,
                status: Some(status),
            })
            .unwrap();
        let service = SourceService::new(&store);
        input.budget_chars = Some(1600);
        let expected = service
            .read(
                &request,
                &SourceReadInput {
                    budget_chars: Some(12000),
                    ..input.clone()
                },
            )
            .unwrap()
            .text;
        let mut actual = String::new();
        loop {
            let page = service.read(&request, &input).unwrap();
            assert!(crate::agent::context::serialized_chars(&page).unwrap() <= 1600);
            actual.push_str(&page.text);
            if page.complete {
                assert!(page.next_cursor.is_none());
                break;
            }
            input.cursor = page.next_cursor;
        }
        assert_eq!(actual, expected);
        service
            .index_native(
                &request,
                &input.source,
                SourceIndexBudget {
                    max_chars: 1900,
                    max_chunks: 10000,
                },
            )
            .unwrap();
        assert_eq!(
            service
                .cache_capacity(&request, &input.source.object.scope)
                .unwrap()
                .snapshots,
            1
        );
    }

    #[tokio::test]
    async fn source_todo_includes_current_subtasks_and_expires_evidence_on_subtask_changes() {
        use crate::models::{
            TodoAddProgressInput, TodoCreateInput, TodoScope, TodoUpdateProgressInput,
        };
        let (_root, store, request, mut input) = fixture();
        let todo = store
            .db
            .lock()
            .unwrap()
            .todo_create(TodoCreateInput {
                scope: TodoScope::Project,
                project_id: Some(input.source.object.id.parse().unwrap()),
                content: "核对交付证据".into(),
                priority: "high".into(),
                due_date: Some("2026-10-03".into()),
                tag_ids: vec![],
            })
            .unwrap();
        let subtask = store
            .db
            .lock()
            .unwrap()
            .todo_add_progress(TodoAddProgressInput {
                todo_id: todo.id,
                content: "补齐子任务验证".into(),
                progress_date: "2026-10-01".into(),
                due_date: Some("2026-10-02".into()),
            })
            .unwrap();
        input.source.object.kind = ObjectKind::Todo;
        input.source.object.id = todo.id.to_string();
        let service = SourceService::new(&store);
        let before = service.read(&request, &input).unwrap();
        assert!(before.text.contains("核对交付证据"));
        assert!(before.text.contains("补齐子任务验证"));
        assert!(before.text.contains("2026-10-02"));
        service
            .index_native(&request, &input.source, SourceIndexBudget::default())
            .unwrap();
        assert_eq!(
            service
                .search(&request, &search(&input, "子任务验证"))
                .await
                .unwrap()
                .items
                .len(),
            1
        );
        store
            .db
            .lock()
            .unwrap()
            .todo_update_progress(TodoUpdateProgressInput {
                progress_id: subtask.id,
                content: "验证已补齐".into(),
                progress_date: "2026-10-01".into(),
                due_date: None,
                status: Some("finished".into()),
            })
            .unwrap();
        input.source.revision = Some(before.source_ref.revision);
        assert_eq!(
            service.read(&request, &input).unwrap_err().code,
            ErrorCode::SourceChanged
        );
        let stale = service
            .search(&request, &search(&input, "子任务验证"))
            .await
            .unwrap();
        assert!(stale.items.is_empty());
        assert_eq!(stale.stale_count, 1);
        input.source.revision = None;
        service
            .index_native(&request, &input.source, SourceIndexBudget::default())
            .unwrap();
        let current = service.read(&request, &input).unwrap();
        assert!(current.text.contains("finished"));
        assert!(!current.text.contains("2026-10-02"));
        assert_eq!(
            service
                .cache_capacity(&request, &input.source.object.scope)
                .unwrap()
                .snapshots,
            1
        );
        assert!(current.spans.iter().all(|span| span.block_id.is_none()));
    }

    #[tokio::test]
    #[ignore = "requires the prepared fixed Node runtime and built Record worker"]
    async fn source_quick_note_reads_committed_buffers_without_record_versions_or_overview_writes()
    {
        use crate::models::WorkspaceQuickNoteUpsertInput;
        let (_root, store, request, mut input) = fixture();
        let worker = crate::record_document_worker::RecordDocumentWorker::development().unwrap();
        let service = SourceService::new(&store);
        input.source.object.kind = ObjectKind::QuickNote;
        let project = service
            .read_quick_note(&request, &input, &worker)
            .await
            .unwrap();
        assert_eq!(project.text, "私有缓冲区");
        assert!(project.source_ref.title.contains("临时想法"));
        assert!(project.source_ref.record_version.is_none());
        assert!(project.source_ref.file_version.is_none());
        assert!(project.spans.iter().all(|span| span.block_id.is_none()));
        service
            .index_quick_note(
                &request,
                &input.source,
                SourceIndexBudget::default(),
                &worker,
            )
            .await
            .unwrap();
        assert_eq!(
            service
                .search(&request, &search(&input, "私有缓冲区"))
                .await
                .unwrap()
                .items
                .len(),
            1
        );
        let quick = store
            .db
            .lock()
            .unwrap()
            .workspace_quick_note_upsert(WorkspaceQuickNoteUpsertInput {
                html: "<h2>待整理想法</h2><p>中文🙂 <strong>原始缓冲</strong></p>".into(),
                markdown: "无关旧投影".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        input.source.object.scope = Scope::Workspace;
        input.source.object.id = quick.id.to_string();
        let workspace = service
            .read_quick_note(&request, &input, &worker)
            .await
            .unwrap();
        assert_eq!(workspace.text, "待整理想法\n\n中文🙂 原始缓冲");
        service
            .index_quick_note(
                &request,
                &input.source,
                SourceIndexBudget::default(),
                &worker,
            )
            .await
            .unwrap();
        let found = service
            .search(&request, &search(&input, "原始缓冲"))
            .await
            .unwrap();
        assert_eq!(found.items.len(), 1);
        assert_eq!(found.items[0].source_ref.object.kind, ObjectKind::QuickNote);
        assert_eq!(
            found.items[0].source_ref.revision,
            workspace.source_ref.revision
        );
        let current = store
            .db
            .lock()
            .unwrap()
            .workspace_quick_note_get()
            .unwrap()
            .unwrap();
        assert_eq!(current.content_markdown, "无关旧投影");
        input.source.object.kind = ObjectKind::Record;
        assert_eq!(
            service.read(&request, &input).unwrap_err().code,
            ErrorCode::NotFound
        );
    }
    #[test]
    fn source_workspace_todo_is_not_a_project_todo_and_deleted_cache_is_pruned() {
        use crate::models::{TodoCreateInput, TodoDeleteInput, TodoScope};
        let (_root, store, request, mut input) = fixture();
        let todo = store
            .db
            .lock()
            .unwrap()
            .todo_create(TodoCreateInput {
                scope: TodoScope::Workspace,
                project_id: None,
                content: "工作区行动".into(),
                priority: "normal".into(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
        input.source.object.kind = ObjectKind::Todo;
        input.source.object.id = todo.id.to_string();
        let service = SourceService::new(&store);
        assert_eq!(
            service.read(&request, &input).unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        input.source.object.scope = Scope::Workspace;
        let page = service.read(&request, &input).unwrap();
        assert!(page.text.contains("工作区行动"));
        service
            .index_native(&request, &input.source, SourceIndexBudget::default())
            .unwrap();
        assert_eq!(
            service
                .cache_capacity(&request, &Scope::Workspace)
                .unwrap()
                .snapshots,
            1
        );
        store
            .db
            .lock()
            .unwrap()
            .todo_delete(TodoDeleteInput { todo_id: todo.id })
            .unwrap();
        assert_eq!(
            service.read(&request, &input).unwrap_err().code,
            ErrorCode::NotFound
        );
        assert_eq!(
            service
                .cache_capacity(&request, &Scope::Workspace)
                .unwrap()
                .snapshots,
            0
        );
    }
    #[tokio::test]
    #[ignore = "requires the prepared fixed Node runtime and built Record worker"]
    async fn source_quick_note_conversion_rechecks_binding_policy_and_committed_html() {
        use crate::{record_document_service::DocumentUtility, source_service::SourcePolicyUpdate};
        struct Paused {
            ready: tokio::sync::Notify,
            resume: tokio::sync::Notify,
        }
        impl DocumentUtility for Paused {
            async fn request(
                &self,
                id: &str,
                method: &str,
                data: serde_json::Value,
            ) -> AgentResult<serde_json::Value> {
                let converted = crate::record_document_worker::RecordDocumentWorker::development()?
                    .request(id, method, data)
                    .await?;
                self.ready.notify_one();
                self.resume.notified().await;
                Ok(converted)
            }
        }
        for scenario in ["switch", "exclude", "edit"] {
            let (_root, store, request, mut input) = fixture();
            input.source.object.kind = ObjectKind::QuickNote;
            let paused = Paused {
                ready: tokio::sync::Notify::new(),
                resume: tokio::sync::Notify::new(),
            };
            let service = SourceService::new(&store);
            let read = service.read_quick_note(&request, &input, &paused);
            let intervene = async {
                paused.ready.notified().await;
                match scenario {
                    "switch" => store.binding.lock().unwrap().generation = "reopened".into(),
                    "exclude" => {
                        service
                            .set_policy(
                                &request,
                                &SourcePolicyUpdate {
                                    object: input.source.object.clone(),
                                    expected_revision: 0,
                                    excluded: true,
                                },
                            )
                            .unwrap();
                    }
                    _ => {
                        store
                            .db
                            .lock()
                            .unwrap()
                            .project_update(ProjectUpdateInput {
                                project_id: input.source.object.id.parse().unwrap(),
                                name: None,
                                summary: "新保存缓冲".into(),
                                summary_markdown: None,
                                summary_html: None,
                                summary_code_language: None,
                                status: None,
                            })
                            .unwrap();
                    }
                }
                paused.resume.notify_one();
            };
            let (result, _) = tokio::time::timeout(std::time::Duration::from_secs(20), async {
                tokio::join!(read, intervene)
            })
            .await
            .unwrap();
            let expected = match scenario {
                "switch" => ErrorCode::WorkspaceChanged,
                "exclude" => ErrorCode::ScopeDenied,
                _ => ErrorCode::SourceChanged,
            };
            assert_eq!(result.unwrap_err().code, expected, "{scenario}");
        }
    }
    #[tokio::test]
    async fn source_native_reads_index_commits_and_search_recheck_after_projection() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Changing<'a> {
            inner: &'a Store,
            phase: AtomicUsize,
            change_at: usize,
            project_id: i64,
        }
        impl BoundSourceStore for Changing<'_> {
            fn with_current<T>(
                &self,
                action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
            ) -> AgentResult<T> {
                if self.phase.fetch_add(1, Ordering::SeqCst) == self.change_at {
                    self.inner
                        .db
                        .lock()
                        .unwrap()
                        .project_update(ProjectUpdateInput {
                            project_id: self.project_id,
                            name: None,
                            summary: "buffer".into(),
                            summary_markdown: None,
                            summary_html: None,
                            summary_code_language: None,
                            status: Some("later".into()),
                        })
                        .unwrap();
                }
                self.inner.with_current(action)
            }
        }
        for operation in ["read", "index", "search"] {
            let (_root, store, request, input) = fixture();
            SourceService::new(&store)
                .index_native(&request, &input.source, SourceIndexBudget::default())
                .unwrap();
            let changing = Changing {
                inner: &store,
                phase: AtomicUsize::new(0),
                change_at: if operation == "search" { 2 } else { 1 },
                project_id: input.source.object.id.parse().unwrap(),
            };
            let service = SourceService::new(&changing);
            let result = match operation {
                "read" => service.read(&request, &input).map(|_| ()),
                "index" => {
                    service.index_native(&request, &input.source, SourceIndexBudget::default())
                }
                _ => service
                    .search(&request, &search(&input, "原生项目验收"))
                    .await
                    .map(|_| ()),
            };
            assert_eq!(
                result.unwrap_err().code,
                ErrorCode::SourceChanged,
                "{operation}"
            );
        }
    }
}
