// Included inside source_service::tests to reuse the real bound database fixture.
fn paging_query() -> SourceSearchInput {
    SourceSearchInput {
        scope: Scope::Workspace,
        query: "needle.txt".into(),
        kinds: vec![ObjectKind::Record],
        selected: vec![],
        include_history: false,
        limit: Some(50),
        budget_chars: Some(12000),
        cursor: None,
    }
}
fn paging_records(store: &Store, count: usize) {
    let mut db = store.db.lock().unwrap();
    for index in 0..count {
        let record = db
            .workspace_record_upsert(WorkspaceRecordUpsertInput {
                note_id: None,
                title: Some(format!("Record {index}")),
                html: "<p>needle.txt</p>".into(),
                markdown: "needle.txt".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        let target = RecordTarget {
            scope: Scope::Workspace,
            record_id: record.id,
        };
        let document = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":format!("{:032x}",index+1)},"content":[{"type":"text","text":"needle.txt"}]}]});
        let projection = RecordDocumentProjection {
            schema_version: 1,
            body_hash: body_hash(&document, &None),
            document,
            html: "<p>needle.txt</p>".into(),
            markdown: "needle.txt".into(),
            text: "needle.txt".into(),
            code_language: None,
        };
        db.record_document_initialize(
            "gui",
            &format!("paging-{index}"),
            &target,
            &db.record_document_source(&target).unwrap().source_hash,
            &projection,
            "source-workspace",
        )
        .unwrap();
    }
}
fn paging_file(root: &std::path::Path, store: &Store, request: &RequestContext) -> ObjectRef {
    use crate::source_search_index::{IndexChunk, IndexCoverage, IndexSource};
    use sha2::{Digest, Sha256};
    let bytes = b"needle.txt alpha\nbeta";
    let path = root.join("needle.txt");
    std::fs::write(&path, bytes).unwrap();
    let mut db = store.db.lock().unwrap();
    let file = db
        .document_import(crate::models::DocumentImportInput {
            project_id: None,
            source_path: path.to_string_lossy().into_owned(),
            is_starred: false,
            tag_ids: None,
        })
        .unwrap();
    let object = ObjectRef {
        workspace_id: request.binding.workspace_id.clone(),
        scope: Scope::Workspace,
        kind: ObjectKind::File,
        id: file.id.to_string(),
    };
    let target = SourceReadTarget {
        object: object.clone(),
        revision: None,
        record_version: None,
        file_version: None,
    };
    let plan = db
        .source_file_plan(request, &request.binding, &target)
        .unwrap();
    db.source_index_file(
        request,
        &request.binding,
        &target,
        &plan,
        &IndexSource {
            object: object.clone(),
            revision: format!("sha256:{:x}", Sha256::digest(bytes)),
            title: file.name,
            chunks: vec![
                IndexChunk {
                    text: "needle.txt alpha".into(),
                    locator: SourceLocator::Page {
                        page: 1,
                        start: 0,
                        end: 16,
                    },
                    block_id: None,
                },
                IndexChunk {
                    text: "beta".into(),
                    locator: SourceLocator::Page {
                        page: 2,
                        start: 0,
                        end: 4,
                    },
                    block_id: None,
                },
            ],
            version: Some(1),
            updated_at: file.updated_at,
            current: true,
            coverage: IndexCoverage {
                chars: 20,
                complete: true,
            },
        },
    )
    .unwrap();
    object
}
#[tokio::test]
async fn source_search_cursor_traverses_over_fifty_mixed_sources_without_loss_under_budget() {
    let (root, store, request, _) = fixture("needle.txt");
    paging_records(&store, 124);
    let file = paging_file(root.path(), &store, &request);
    let mut query = paging_query();
    query.kinds = vec![ObjectKind::Record, ObjectKind::File];
    // A matching File is ranked together with 125 Records before LIMIT.
    let first = SourceService::new(&store)
        .search(&request, &query)
        .await
        .unwrap();
    assert_eq!(first.items[0].source_ref.object, file);
    assert!(first.has_more && first.next_cursor.is_some());
    let mut all = Vec::new();
    let mut pages = 0;
    query.budget_chars = Some(2000);
    loop {
        let page = SourceService::new(&store)
            .search(&request, &query)
            .await
            .unwrap();
        assert_eq!(page.has_more, page.next_cursor.is_some());
        assert!(crate::agent::context::serialized_chars(&page).unwrap() <= 2000);
        all.extend(page.items.iter().map(|i| {
            (
                i.object_key.clone(),
                i.source_ref.file_version,
                i.source_ref.record_version,
            )
        }));
        pages += 1;
        assert!(pages <= 130, "cursor did not progress");
        query.cursor = page.next_cursor;
        if query.cursor.is_none() {
            break;
        }
        // Page size may change without invalidating the search snapshot.
        query.limit = Some(if pages % 2 == 0 { 1 } else { 50 });
    }
    assert!(pages > 3);
    assert_eq!(all.len(), 126);
    assert_eq!(
        all.iter().collect::<std::collections::HashSet<_>>().len(),
        126
    );
}
#[tokio::test]
async fn source_search_cursor_binds_query_visibility_and_versions() {
    let (_root, store, request, input) = fixture("needle.txt");
    paging_records(&store, 2);
    let mut query = paging_query();
    query.limit = Some(1);
    query.cursor = SourceService::new(&store)
        .search(&request, &query)
        .await
        .unwrap()
        .next_cursor;
    assert!(query.cursor.is_some());
    let service = SourceService::new(&store);
    let mut changed = query.clone();
    changed.query = "other".into();
    assert_eq!(
        service.search(&request, &changed).await.unwrap_err().code,
        ErrorCode::SourceChanged
    );
    let mut changed = query.clone();
    changed.kinds = vec![ObjectKind::File];
    assert_eq!(
        service.search(&request, &changed).await.unwrap_err().code,
        ErrorCode::SourceChanged
    );
    let mut changed = query.clone();
    changed.include_history = true;
    assert_eq!(
        service.search(&request, &changed).await.unwrap_err().code,
        ErrorCode::SourceChanged
    );
    let mut changed = query.clone();
    changed.selected = vec![input.source.object.clone()];
    assert_eq!(
        service.search(&request, &changed).await.unwrap_err().code,
        ErrorCode::SourceChanged
    );
    let mut changed = query.clone();
    changed.scope = Scope::Project { project_id: 1 };
    assert_eq!(
        service.search(&request, &changed).await.unwrap_err().code,
        ErrorCode::SourceChanged
    );
    let mut narrowed = request.clone();
    narrowed.scope_grant.object_keys = Some(vec![]);
    assert_eq!(
        service.search(&narrowed, &query).await.unwrap_err().code,
        ErrorCode::SourceChanged
    );
    let mut revoked = request.clone();
    revoked.scope_grant.operations.clear();
    assert_eq!(
        service.search(&revoked, &query).await.unwrap_err().code,
        ErrorCode::SourceChanged
    );
    let mut caller = request.clone();
    caller.caller = Caller::Connection {
        grant_id: "other".into(),
    };
    assert_eq!(
        service.search(&caller, &query).await.unwrap_err().code,
        ErrorCode::SourceChanged
    );
    // A normal native metadata edit invalidates even pages whose own items did not change.
    store
        .db
        .lock()
        .unwrap()
        .workspace_record_metadata_apply(crate::models::WorkspaceRecordMetadataApplyInput {
            note_id: input.source.object.id.parse().unwrap(),
            title: "new title".into(),
            expected_updated_at: None,
            expected_title: None,
            tag_ids: vec![],
            new_tags: vec![],
        })
        .unwrap();
    assert_eq!(
        service.search(&request, &query).await.unwrap_err().code,
        ErrorCode::SourceChanged
    );
}
#[tokio::test]
async fn source_search_cursor_rejects_reopen_and_reports_minimum_budget() {
    let (_root, store, request, _) = fixture("needle.txt");
    paging_records(&store, 2);
    let mut query = paging_query();
    query.limit = Some(1);
    query.cursor = SourceService::new(&store)
        .search(&request, &query)
        .await
        .unwrap()
        .next_cursor;
    query.budget_chars = Some(1);
    let error = SourceService::new(&store)
        .search(&request, &query)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::BudgetExceeded);
    assert!(
        error.details.unwrap()["minimumBudgetChars"]
            .as_u64()
            .unwrap()
            > 1
    );
    query.budget_chars = Some(12000);
    assert!(SourceService::new(&store)
        .search(&request, &query)
        .await
        .is_ok());
    store.binding.lock().unwrap().generation = "reopened".into();
    assert_eq!(
        SourceService::new(&store)
            .search(&request, &query)
            .await
            .unwrap_err()
            .code,
        ErrorCode::SourceChanged
    );
}
#[test]
fn source_search_cursor_schema_is_optional_and_old_inputs_decode() {
    let input: SourceSearchInput =
        serde_json::from_value(json!({"scope":{"kind":"workspace"},"query":"q"})).unwrap();
    assert!(input.cursor.is_none());
    let schema = serde_json::to_value(schemars::schema_for!(SourceSearchInput)).unwrap();
    assert!(!schema["required"]
        .as_array()
        .unwrap()
        .contains(&json!("cursor")));
}

#[tokio::test]
async fn source_search_cursor_can_continue_after_a_page_of_stale_evidence() {
    let (_root, store, request, _) = fixture("needle.txt");
    let todo = store
        .db
        .lock()
        .unwrap()
        .todo_create(crate::models::TodoCreateInput {
            scope: crate::models::TodoScope::Workspace,
            project_id: None,
            content: "needle.txt".into(),
            priority: "normal".into(),
            due_date: None,
            tag_ids: vec![],
        })
        .unwrap();
    let target = SourceReadTarget {
        object: ObjectRef {
            workspace_id: request.binding.workspace_id.clone(),
            scope: Scope::Workspace,
            kind: ObjectKind::Todo,
            id: todo.id.to_string(),
        },
        revision: None,
        record_version: None,
        file_version: None,
    };
    SourceService::new(&store)
        .index_native(&request, &target, SourceIndexBudget::default())
        .unwrap();
    store
        .db
        .lock()
        .unwrap()
        .todo_update_content(crate::models::TodoUpdateContentInput {
            expected_revision: todo.revision,
            todo_id: todo.id,
            content: "changed".into(),
            due_date: None,
            tag_ids: vec![],
        })
        .unwrap();
    let mut query = paging_query();
    query.kinds = vec![ObjectKind::Record, ObjectKind::Todo];
    query.limit = Some(1);
    let page = SourceService::new(&store)
        .search(&request, &query)
        .await
        .unwrap();
    assert!(page.items.is_empty());
    assert_eq!(page.stale_count, 1);
    assert!(page.has_more);
    query.cursor = page.next_cursor;
    assert!(query.cursor.is_some());
    let next = SourceService::new(&store)
        .search(&request, &query)
        .await
        .unwrap();
    assert_eq!(next.items.len(), 1);
    assert_eq!(next.items[0].source_ref.object.kind, ObjectKind::Record);
    assert!(!next.has_more);
    assert!(next.next_cursor.is_none());
}
