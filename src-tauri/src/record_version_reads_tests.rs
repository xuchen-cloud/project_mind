use super::*;
use crate::{
    agent::{
        access::{Caller, ScopeGrant},
        models::{Scope, WorkspaceBinding},
    },
    committed_changes::{CommittedChangePublisher, CommittedChanges},
    db::Database,
    models::WorkspaceRecordUpsertInput,
    record_documents::{
        body_hash, RecordDocumentCommit, RecordDocumentProjection, RecordVersionOrigin,
    },
    source_service::{SourceReadInput, SourceReadView, SourceService},
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};

struct Store {
    binding: WorkspaceBinding,
    db: Mutex<Database>,
}
impl CommittedChangePublisher for Store {
    fn publish_committed(&self, _: CommittedChanges) {}
}
impl BoundSourceStore for Store {
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        action(&self.binding, &self.db.lock().unwrap())
    }
}
struct CompareUtility {
    before: Value,
    after: Value,
    calls: AtomicUsize,
}
impl DocumentUtility for CompareUtility {
    async fn request(&self, _: &str, method: &str, data: Value) -> AgentResult<Value> {
        assert_eq!(method, "record.compare");
        assert_eq!(data["document"], self.before);
        assert_eq!(data["otherDocument"], self.after);
        self.calls.fetch_add(1, Ordering::SeqCst);
        let added = self.after["content"].as_array().unwrap().iter().skip(1)
            .map(|block| block["attrs"]["blockId"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        Ok(json!({"added":added,"deleted":[],"modified":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],"moved":[]}))
    }
}
fn projection(second: bool) -> RecordDocumentProjection {
    let text = if second { "Beta" } else { "Alpha" };
    let mut content = vec![
        json!({"type":"paragraph","attrs":{"blockId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"content":[{"type":"text","text":text}]}),
    ];
    if second {
        for index in 2..=41 {
            content.push(json!({"type":"paragraph","attrs":{"blockId":format!("{index:032x}")},"content":[{"type":"text","text":format!("Gamma {index}")}]}));
        }
    }
    let document = json!({"type":"doc","content":content});
    let html = if second {
        let mut html = "<p data-block-id=\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\">Beta</p>".to_owned();
        for index in 2..=41 {
            html.push_str(&format!("<p data-block-id=\"{index:032x}\">Gamma {index}</p>"));
        }
        html
    } else {
        "<p data-block-id=\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\">Alpha</p>".into()
    };
    RecordDocumentProjection {
        body_hash: body_hash(&document, &None),
        document,
        html,
        markdown: if second { format!("Beta{}", (2..=41).map(|index| format!("\n\nGamma {index}")).collect::<String>()) } else { "Alpha".into() },
        text: if second { format!("Beta{}", (2..=41).map(|index| format!("\nGamma {index}")).collect::<String>()) } else { "Alpha".into() },
        code_language: None,
        schema_version: 1,
    }
}
fn fixture() -> (
    tempfile::TempDir,
    Store,
    CompareUtility,
    RequestContext,
    ObjectRef,
    Vec<RecordVersionSummary>,
) {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Database::open(&dir.path().join("record.sqlite"), dir.path(), None).unwrap();
    db.bind_native_workspace("w").unwrap();
    let record = db
        .workspace_record_upsert(WorkspaceRecordUpsertInput {
            note_id: None,
            title: Some("Versioned".into()),
            html: "<p>Alpha</p>".into(),
            markdown: "Alpha".into(),
            default_code_language: None,
            tag_ids: vec![],
        })
        .unwrap();
    let target = RecordTarget {
        scope: Scope::Workspace,
        record_id: record.id,
    };
    let first = projection(false);
    let second = projection(true);
    db.record_document_initialize(
        "gui",
        "version-init",
        &target,
        &db.record_document_source(&target).unwrap().source_hash,
        &first,
        "w",
    )
    .unwrap();
    db.record_document_commit(
        "agent",
        "version-next",
        &RecordDocumentCommit {
            target: target.clone(),
            base_revision: 1,
            projection: second.clone(),
            origin: RecordVersionOrigin::Agent,
            actor: json!({"kind":"agent"}),
            edit_session_id: None,
        },
        "w",
    )
    .unwrap();
    let versions = db.record_versions_list(&target, None, 10).unwrap().versions;
    let binding = WorkspaceBinding {
        workspace_id: "w".into(),
        generation: "g".into(),
    };
    let request = RequestContext {
        binding: binding.clone(),
        caller: Caller::Connection {
            grant_id: "grant".into(),
        },
        request_id: "version-read".into(),
        scope_grant: ScopeGrant {
            object_keys: None,
            workspace_id: "w".into(),
            workspace_content: true,
            project_ids: vec![],
            operations: vec!["source.read".into()],
        },
    };
    let object = ObjectRef {
        workspace_id: "w".into(),
        scope: Scope::Workspace,
        kind: ObjectKind::Record,
        id: record.id.to_string(),
    };
    (
        dir,
        Store {
            binding,
            db: Mutex::new(db),
        },
        CompareUtility {
            before: first.document,
            after: second.document,
            calls: AtomicUsize::new(0),
        },
        request,
        object,
        versions,
    )
}

#[tokio::test]
async fn withdrawn_record_blocks_external_version_list_get_and_compare() {
    let (dir, store, utility, request, object, versions) = fixture();
    rusqlite::Connection::open(dir.path().join("record.sqlite")).unwrap().execute(
        "INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,revision) VALUES(?1,?2,'2026-01-02',1)",
        rusqlite::params![object.key().unwrap(), "a".repeat(32)],
    ).unwrap();
    let service = RecordVersionReadService::new(&store, &utility);
    assert_eq!(service.list(&request, &RecordVersionsListInput {
        record: object.clone(), cursor: None, limit: None, budget_chars: None,
    }).unwrap_err().code, ErrorCode::ObjectWithdrawn);
    assert_eq!(service.get(&request, &RecordVersionsGetInput {
        record: object.clone(), version_id: versions[0].id.clone(), budget_chars: None,
    }).unwrap_err().code, ErrorCode::ObjectWithdrawn);
    assert_eq!(service.compare(&request, &RecordVersionsCompareInput {
        record: object, before_version_id: versions[1].id.clone(),
        after_version_id: versions[0].id.clone(), cursor: None, budget_chars: None,
    }).await.unwrap_err().code, ErrorCode::ObjectWithdrawn);
    assert_eq!(utility.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn versions_list_get_and_source_target_are_precise() {
    let (_dir, store, utility, request, object, versions) = fixture();
    let service = RecordVersionReadService::new(&store, &utility);
    let first = service
        .list(
            &request,
            &RecordVersionsListInput {
                record: object.clone(),
                cursor: None,
                limit: Some(1),
                budget_chars: Some(4000),
            },
        )
        .unwrap();
    assert_eq!(first.versions[0].id, versions[0].id);
    assert_eq!(first.next_before, Some(versions[0].version_number));
    let next = service
        .list(
            &request,
            &RecordVersionsListInput {
                record: object.clone(),
                cursor: first.next_before,
                limit: Some(1),
                budget_chars: Some(4000),
            },
        )
        .unwrap();
    assert_eq!(next.versions[0].id, versions[1].id);
    assert!(next.next_before.is_none());
    assert_eq!(
        service
            .list(
                &request,
                &RecordVersionsListInput {
                    record: object.clone(),
                    cursor: None,
                    limit: Some(1),
                    budget_chars: Some(1)
                }
            )
            .unwrap_err()
            .code,
        ErrorCode::BudgetExceeded
    );
    let page = service
        .get(
            &request,
            &RecordVersionsGetInput {
                record: object.clone(),
                version_id: versions[1].id.clone(),
                budget_chars: Some(4000),
            },
        )
        .unwrap();
    assert_eq!(page.version.id, versions[1].id);
    assert_eq!(
        page.source.record_version,
        Some(versions[1].version_number as u32)
    );
    let fingerprint = store
        .with_current(|binding, db| db.source_record_fingerprint(&request, binding, &page.source))
        .unwrap();
    assert_eq!(page.source.revision, Some(fingerprint.revision));
    assert_eq!(utility.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn comparison_pages_native_changes_and_binds_cursor_to_versions() {
    let (_dir, store, utility, request, object, versions) = fixture();
    let service = RecordVersionReadService::new(&store, &utility);
    let before = versions[1].id.clone();
    let after = versions[0].id.clone();
    let full = service
        .compare(
            &request,
            &RecordVersionsCompareInput {
                record: object.clone(),
                before_version_id: before.clone(),
                after_version_id: after.clone(),
                cursor: None,
                budget_chars: Some(4000),
            },
        )
        .await
        .unwrap();
    assert_eq!(full.counts.added, 40);
    assert_eq!(full.counts.modified, 1);
    assert_eq!(full.changes.len(), 41);
    assert_eq!(full.changes[0].kind, "added");
    assert!(full.next_cursor.is_none());
    let exact = service.compare(&request, &RecordVersionsCompareInput {
        record: object.clone(), before_version_id: before.clone(), after_version_id: after.clone(),
        cursor: None, budget_chars: Some(size(&full).unwrap()),
    }).await.unwrap();
    assert_eq!(exact.changes.len(), 41);
    assert!(exact.next_cursor.is_none());
    let one_change_budget = size(&RecordVersionsComparePage {
        object: object.clone(),
        before_version_id: before.clone(),
        after_version_id: after.clone(),
        counts: full.counts.clone(),
        changes: vec![full.changes[0].clone()],
        next_cursor: Some(
            cursor_encode(&CompareCursor {
                object_key: object.key().unwrap(),
                before_version_id: before.clone(),
                after_version_id: after.clone(),
                before_hash: versions[1].body_hash.clone(),
                after_hash: versions[0].body_hash.clone(),
                offset: 1,
            })
            .unwrap(),
        ),
    })
    .unwrap();
    let page_budget = one_change_budget.max(size(&full).unwrap() / 3);
    assert!(page_budget < size(&full).unwrap());
    let first = service
        .compare(
            &request,
            &RecordVersionsCompareInput {
                record: object.clone(),
                before_version_id: before.clone(),
                after_version_id: after.clone(),
                cursor: None,
                budget_chars: Some(page_budget),
            },
        )
        .await
        .unwrap();
    assert!(!first.changes.is_empty());
    assert!(first.changes.len() < 41);
    let mut all = first.changes.iter().map(|change| change.block_id.clone()).collect::<Vec<_>>();
    let mut cursor = first.next_cursor.clone();
    while let Some(next) = cursor {
        let page = service.compare(&request, &RecordVersionsCompareInput {
            record: object.clone(), before_version_id: before.clone(), after_version_id: after.clone(),
            cursor: Some(next), budget_chars: Some(page_budget),
        }).await.unwrap();
        assert!(!page.changes.is_empty());
        all.extend(page.changes.iter().map(|change| change.block_id.clone()));
        cursor = page.next_cursor;
    }
    assert_eq!(all, full.changes.iter().map(|change| change.block_id.clone()).collect::<Vec<_>>());
    let wrong = service
        .compare(
            &request,
            &RecordVersionsCompareInput {
                record: object,
                before_version_id: after,
                after_version_id: before,
                cursor: first.next_cursor,
                budget_chars: Some(4000),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(wrong.code, ErrorCode::InvalidArgument);
    assert!(utility.calls.load(Ordering::SeqCst) >= 4);
}

#[tokio::test]
async fn foreign_scope_and_excluded_record_reject_history() {
    let (_dir, store, utility, request, object, versions) = fixture();
    let service = RecordVersionReadService::new(&store, &utility);
    let foreign = ObjectRef {
        scope: Scope::Project { project_id: 99 },
        ..object.clone()
    };
    assert_eq!(
        service
            .list(
                &request,
                &RecordVersionsListInput {
                    record: foreign,
                    cursor: None,
                    limit: None,
                    budget_chars: None
                }
            )
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    let gui = RequestContext {
        caller: Caller::Gui,
        request_id: "exclude".into(),
        scope_grant: ScopeGrant {
            object_keys: None,
            workspace_id: "w".into(),
            workspace_content: true,
            project_ids: vec![],
            operations: vec!["settings.write".into(), "source.read".into()],
        },
        ..request.clone()
    };
    store
        .db
        .lock()
        .unwrap()
        .source_policy_update(
            &gui,
            &store.binding,
            &crate::source_service::SourcePolicyUpdate {
                object: object.clone(),
                expected_revision: 0,
                excluded: true,
            },
        )
        .unwrap();
    assert_eq!(
        service
            .get(
                &request,
                &RecordVersionsGetInput {
                    record: object.clone(),
                    version_id: versions[0].id.clone(),
                    budget_chars: None
                }
            )
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    assert_eq!(
        service
            .compare(
                &request,
                &RecordVersionsCompareInput {
                    record: object,
                    before_version_id: versions[1].id.clone(),
                    after_version_id: versions[0].id.clone(),
                    cursor: None,
                    budget_chars: None
                }
            )
            .await
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
}

#[tokio::test]
#[ignore = "requires prepared fixed Node runtime and built Record worker"]
async fn packaged_worker_compares_retained_documents_and_source_reads_original() {
    let (_dir, store, _utility, request, object, versions) = fixture();
    let worker = crate::record_document_worker::RecordDocumentWorker::development().unwrap();
    let service = RecordVersionReadService::new(&store, &worker);
    let comparison = service.compare(&request, &RecordVersionsCompareInput {
        record: object.clone(), before_version_id: versions[1].id.clone(),
        after_version_id: versions[0].id.clone(), cursor: None, budget_chars: Some(12000),
    }).await.unwrap();
    assert_eq!(comparison.counts.added, 40);
    assert!(comparison.changes.iter().any(|change| change.kind == "modified" && change.block_id == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    let version = service.get(&request, &RecordVersionsGetInput {
        record: object, version_id: versions[1].id.clone(), budget_chars: Some(4000),
    }).unwrap();
    let source = SourceService::new(&store).read_record(&request, &SourceReadInput {
        source: version.source, view: SourceReadView::Full, selection: None, cursor: None,
        budget_chars: Some(4000),
    }, &worker).await.unwrap();
    assert_eq!(source.text, "Alpha");
}
