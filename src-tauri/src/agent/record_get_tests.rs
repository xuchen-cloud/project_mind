use super::*;
use crate::{
    agent::{
        access::{Caller, ScopeGrant},
        models::{Scope, WorkspaceBinding},
    },
    db::Database,
    models::WorkspaceRecordUpsertInput,
    record_documents::{
        body_hash, RecordDocumentCommit, RecordDocumentProjection, RecordTarget,
        RecordVersionOrigin,
    },
};
use serde_json::json;
use std::sync::Mutex;

struct Store {
    binding: Mutex<WorkspaceBinding>,
    db: Mutex<Database>,
}
impl crate::committed_changes::CommittedChangePublisher for Store {
    fn publish_committed(&self, _: crate::committed_changes::CommittedChanges) {}
}
impl BoundSourceStore for Store {
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        action(&self.binding.lock().unwrap(), &self.db.lock().unwrap())
    }
}
fn projection(text: &str, markdown: &str) -> RecordDocumentProjection {
    let document = json!({"type":"doc","content":[{"type":"paragraph",
        "attrs":{"blockId":"0123456789abcdef0123456789abcdef"},
        "content":[{"type":"text","text":text}]}]});
    RecordDocumentProjection {
        schema_version: 1,
        body_hash: body_hash(&document, &None),
        document,
        html: format!("<p>{text}</p>"),
        markdown: markdown.into(),
        text: text.into(),
        code_language: None,
    }
}
fn fixture(
    text: &str,
    markdown: &str,
) -> (tempfile::TempDir, Store, RequestContext, RecordGetInput) {
    let directory = tempfile::tempdir().unwrap();
    let mut db = Database::open(
        &directory.path().join("record.sqlite"),
        directory.path(),
        None,
    )
    .unwrap();
    let record = db
        .workspace_record_upsert(WorkspaceRecordUpsertInput {
            note_id: None,
            title: Some("Record阅读".into()),
            html: "<p>old</p>".into(),
            markdown: "old".into(),
            default_code_language: None,
            tag_ids: vec![],
        })
        .unwrap();
    let target = RecordTarget {
        scope: Scope::Workspace,
        record_id: record.id,
    };
    db.record_document_initialize(
        "gui",
        "initialize",
        &target,
        &db.record_document_source(&target).unwrap().source_hash,
        &projection(text, markdown),
        "read-tests",
    )
    .unwrap();
    let binding = WorkspaceBinding {
        workspace_id: "read-tests".into(),
        generation: directory.path().display().to_string(),
    };
    let request = RequestContext {
        binding: binding.clone(),
        caller: Caller::Gui,
        request_id: "read-record".into(),
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: true,
            project_ids: vec![],
            operations: vec!["source.read".into()],
            object_keys: None,
        },
    };
    let input = RecordGetInput {
        record: ObjectRef {
            workspace_id: binding.workspace_id.clone(),
            scope: Scope::Workspace,
            kind: ObjectKind::Record,
            id: record.id.to_string(),
        },
        revision: None,
        cursor: None,
        budget_chars: Some(1800),
        format: None,
        offset: None,
        limit: None,
    };
    (
        directory,
        Store {
            binding: Mutex::new(binding),
            db: Mutex::new(db),
        },
        request,
        input,
    )
}
fn commit(store: &Store, input: &RecordGetInput, text: &str, markdown: &str) {
    let target = RecordTarget {
        scope: input.record.scope.clone(),
        record_id: input.record.id.parse().unwrap(),
    };
    let db = store.db.lock().unwrap();
    let head = db.record_document_head(&target).unwrap().unwrap();
    db.record_document_commit(
        "gui",
        "modify",
        &RecordDocumentCommit {
            target,
            base_revision: head.head_revision,
            projection: projection(text, markdown),
            origin: RecordVersionOrigin::Manual,
            actor: json!({"kind":"gui"}),
            edit_session_id: Some("0123456789abcdef0123456789abcdef".into()),
        },
        "read-tests",
    )
    .unwrap();
}
#[test]
fn record_get_direct_window_reuses_version_projection() {
    let text = (1..=10000)
        .map(|line| format!("line {line} 中文🙂\n"))
        .collect::<String>();
    let (_directory, store, request, mut input) = fixture(&text, &text);
    input.offset = Some(9999);
    input.limit = Some(1);
    let page = read(&store, &request, &input).unwrap();
    assert_eq!(page.page.text, "line 9999 中文🙂\n");
    assert!(page.page.range_complete);
    assert!(!page.page.complete);
    assert!(page.page.next_cursor.is_none());
    assert_eq!(page.window.total_lines, 10000);
    assert_eq!(page.window.start_line, 9999);
    assert_eq!(page.window.end_line, 9999);
    let cache_key = key(
        &request,
        &page.page.source_ref.revision,
        page.head_revision,
        &input,
    )
    .unwrap();
    let before = record_read_cache::get(&cache_key).unwrap();
    input.offset = Some(10000);
    let second = read(&store, &request, &input).unwrap();
    assert_eq!(second.page.text, "line 10000 中文🙂\n");
    let after = record_read_cache::get(&cache_key).unwrap();
    assert!(Arc::ptr_eq(&before, &after));
    // A cache hit requests only authorized state, not the canonical JSON body.
    let state = store
        .with_current(|binding, db| {
            db.record_read_snapshot(&request, binding, &source(&input), false, |_, _| false)
        })
        .unwrap();
    assert!(state.content.is_none());
}
#[test]
fn record_get_markdown_is_exact_and_shares_atomic_numeric_baseline() {
    let markdown = "# Title\n\n```rust\nlet x = 1;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n> 引用\n\n[Record](mind://record/2)\n";
    let (_directory, store, request, mut input) =
        fixture("Title\nlet x = 1;\nA B\n1 2\n引用", markdown);
    input.budget_chars = Some(12000);
    let text = read(&store, &request, &input).unwrap();
    input.format = Some(RecordReadFormat::Markdown);
    let page = read(&store, &request, &input).unwrap();
    assert_eq!(page.page.text, markdown);
    assert_ne!(text.page.text, page.page.text);
    assert_eq!(text.head_revision, 1);
    assert_eq!(page.head_revision, 1);
    assert_eq!(text.page.source_ref.revision, page.page.source_ref.revision);
    assert!(page.page.spans.is_empty());
    assert!(page.page.source_ref.block_id.is_none());
    commit(&store, &input, "Changed", "# Changed\n");
    let changed = read(&store, &request, &input).unwrap();
    assert_eq!(changed.head_revision, 2);
    assert_eq!(changed.page.text, "# Changed\n");
    assert_ne!(
        page.page.source_ref.revision,
        changed.page.source_ref.revision
    );
}
#[test]
fn record_get_cursor_pins_format_window_and_revision() {
    let text = "Long 中文🙂 line\n".repeat(1500);
    let (_directory, store, request, mut input) = fixture(&text, &format!("# {text}"));
    input.offset = Some(1000);
    input.limit = Some(200);
    let first = read(&store, &request, &input).unwrap();
    let mut actual = first.page.text.clone();
    input.cursor = first.page.next_cursor.clone();
    assert!(input.cursor.is_some());
    while input.cursor.is_some() {
        let page = read(&store, &request, &input).unwrap();
        assert_eq!(page.head_revision, 1);
        actual.push_str(&page.page.text);
        input.cursor = page.page.next_cursor;
    }
    assert_eq!(actual, "Long 中文🙂 line\n".repeat(200));
    input.cursor = first.page.next_cursor;
    input.format = Some(RecordReadFormat::Markdown);
    assert_eq!(
        read(&store, &request, &input).unwrap_err().code,
        ErrorCode::InvalidArgument
    );
    input.format = None;
    input.offset = Some(1001);
    assert_eq!(
        read(&store, &request, &input).unwrap_err().code,
        ErrorCode::InvalidArgument
    );
    input.offset = Some(1000);
    commit(&store, &input, "New body", "New body");
    assert_eq!(
        read(&store, &request, &input).unwrap_err().code,
        ErrorCode::SourceChanged
    );
}
#[test]
fn record_get_cache_hit_rechecks_grants_exclusion_and_generation() {
    let (_directory, store, mut request, input) = fixture("Secret", "# Secret");
    let page = read(&store, &request, &input).unwrap();
    request.scope_grant.object_keys = Some(vec![]);
    assert_eq!(
        read(&store, &request, &input).unwrap_err().code,
        ErrorCode::ScopeDenied
    );
    request.scope_grant.object_keys = None;
    let old_key = key(&request, &page.page.source_ref.revision, 1, &input).unwrap();
    store.binding.lock().unwrap().generation = "reopened".into();
    assert_eq!(
        read(&store, &request, &input).unwrap_err().code,
        ErrorCode::WorkspaceChanged
    );
    request.binding.generation = "reopened".into();
    let new_key = key(&request, &page.page.source_ref.revision, 1, &input).unwrap();
    assert!(record_read_cache::get(&new_key).is_none());
    assert!(record_read_cache::get(&old_key).is_some());
    assert_eq!(read(&store, &request, &input).unwrap().page.text, "Secret");
    store
        .with_current(|binding, db| {
            db.source_policy_update(
                &RequestContext {
                    scope_grant: ScopeGrant {
                        operations: vec!["settings.write".into()],
                        ..request.scope_grant.clone()
                    },
                    request_id: "exclude-record".into(),
                    ..request.clone()
                },
                binding,
                &crate::source_service::SourcePolicyUpdate {
                    object: input.record.clone(),
                    expected_revision: 0,
                    excluded: true,
                },
            )
        })
        .unwrap();
    assert_eq!(
        read(&store, &request, &input).unwrap_err().code,
        ErrorCode::ScopeDenied
    );
}
#[test]
fn record_get_budget_and_invalid_windows_remain_explicit() {
    let (_directory, store, request, mut input) = fixture("Hello", "# Hello");
    input.budget_chars = Some(10);
    let error = read(&store, &request, &input).unwrap_err();
    assert_eq!(error.code, ErrorCode::BudgetExceeded);
    assert!(
        error.details.unwrap()["minimumBudgetChars"]
            .as_u64()
            .unwrap()
            > 10
    );
    input.budget_chars = Some(1800);
    input.offset = Some(0);
    assert_eq!(
        read(&store, &request, &input).unwrap_err().code,
        ErrorCode::InvalidArgument
    );
    input.offset = Some(10);
    let empty = read(&store, &request, &input).unwrap();
    assert!(empty.page.text.is_empty());
    assert!(empty.page.range_complete);
    assert!(!empty.page.complete);
}
#[test]
fn record_get_default_text_matches_existing_source_read_and_spans() {
    let (_directory, store, request, input) = fixture("Test 中文🙂", "# Test 中文🙂");
    let old = SourceService::new(&store)
        .read(
            &request,
            &crate::source_service::SourceReadInput {
                source: source(&input),
                view: crate::source_service::SourceReadView::Full,
                selection: None,
                cursor: None,
                budget_chars: input.budget_chars,
            },
        )
        .unwrap();
    let new = read(&store, &request, &input).unwrap();
    assert_eq!(
        serde_json::to_value(old).unwrap(),
        serde_json::to_value(new.page).unwrap()
    );

    // Cursor payloads are opaque and page boundaries may differ because the
    // Record response includes extra metadata. Compare reconstructed text and
    // global block/locator spans, using each API's own fixed-revision cursor.
    type GlobalSpan = (usize, usize, Option<String>, String);
    fn collect(
        mut reader: impl FnMut(Option<String>) -> SourceReadPage,
    ) -> (String, Vec<GlobalSpan>) {
        let mut text = String::new();
        let mut spans: Vec<GlobalSpan> = vec![];
        let mut cursor = None;
        for number in 0..256 {
            let page = reader(cursor);
            let base = text.chars().count();
            let count = page.text.chars().count();
            for span in page.spans {
                assert!(span.start < span.end && span.end <= count);
                let locator = serde_json::to_string(&span.locator).unwrap();
                let start = base + span.start;
                let end = base + span.end;
                if let Some(previous) = spans.last_mut().filter(|previous| {
                    previous.1 == start && previous.2 == span.block_id && previous.3 == locator
                }) {
                    previous.1 = end;
                } else {
                    spans.push((start, end, span.block_id, locator));
                }
            }
            text.push_str(&page.text);
            cursor = page.next_cursor;
            if cursor.is_none() {
                assert!(number > 0, "fixture must exercise actual pagination");
                assert!(page.complete && page.range_complete);
                return (text, spans);
            }
            assert!(!page.complete && !page.range_complete);
            assert!(!page.text.is_empty());
        }
        panic!("pagination must make bounded progress");
    }
    let parts = [
        "First 中文🙂 ".repeat(200),
        "Second 行🚄 ".repeat(190),
        "Third 中文段落 ".repeat(170),
    ];
    let expected = parts.join("\n\n");
    let (_paged_directory, paged_store, paged_request, mut paged_input) =
        fixture(&expected, &expected);
    let mut projected = projection(&expected, &expected);
    projected.document = json!({"type":"doc","content":parts.iter().enumerate().map(|(index, text)| {
        json!({"type":"paragraph","attrs":{"blockId":format!("{:032x}",index+1)},
            "content":[{"type":"text","text":text}]})
    }).collect::<Vec<_>>()});
    projected.body_hash = body_hash(&projected.document, &None);
    paged_store
        .db
        .lock()
        .unwrap()
        .record_document_commit(
            "gui",
            "compare-paged-reads",
            &RecordDocumentCommit {
                target: RecordTarget {
                    scope: Scope::Workspace,
                    record_id: paged_input.record.id.parse().unwrap(),
                },
                base_revision: 1,
                projection: projected,
                origin: RecordVersionOrigin::Manual,
                actor: json!({"kind":"gui"}),
                edit_session_id: Some("0123456789abcdef0123456789abcdef".into()),
            },
            "read-tests",
        )
        .unwrap();
    paged_input.budget_chars = Some(1200);
    let mut old_input = crate::source_service::SourceReadInput {
        source: source(&paged_input),
        view: crate::source_service::SourceReadView::Full,
        selection: None,
        cursor: None,
        budget_chars: paged_input.budget_chars,
    };
    let old = collect(|cursor| {
        old_input.cursor = cursor;
        let page = SourceService::new(&paged_store)
            .read(&paged_request, &old_input)
            .unwrap();
        old_input.source.revision = Some(page.source_ref.revision.clone());
        page
    });
    let new = collect(|cursor| {
        paged_input.cursor = cursor;
        let page = read(&paged_store, &paged_request, &paged_input).unwrap();
        paged_input.revision = Some(page.page.source_ref.revision.clone());
        page.page
    });
    assert_eq!(old.0, expected);
    assert_eq!(old, new);
    assert_eq!(new.1.len(), 3);
}

#[test]
fn record_get_cache_does_not_bypass_withdrawal_or_deletion() {
    let (directory, store, request, input) = fixture("Withdrawn secret", "# Withdrawn secret");
    read(&store, &request, &input).unwrap();
    let connection = rusqlite::Connection::open(directory.path().join("record.sqlite")).unwrap();
    connection.execute("INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,revision) VALUES (?1,'creation','2026-10-29',1)",
        [input.record.key().unwrap()]).unwrap();
    assert_eq!(
        read(&store, &request, &input).unwrap_err().code,
        ErrorCode::ObjectWithdrawn
    );
    connection
        .execute(
            "DELETE FROM workspace_notes WHERE id=?1",
            [input.record.id.parse::<i64>().unwrap()],
        )
        .unwrap();
    assert_eq!(
        read(&store, &request, &input).unwrap_err().code,
        ErrorCode::NotFound
    );
}
#[test]
fn record_get_snapshot_head_revision_and_markdown_are_atomic_against_external_writer() {
    let (directory, store, request, input) = fixture("Before", "# Before\n");
    let writer = rusqlite::Connection::open(directory.path().join("record.sqlite")).unwrap();
    writer.pragma_update(None, "journal_mode", "WAL").unwrap();
    let initial = read(&store, &request, &input).unwrap();
    let new = projection("After", "# After\n");
    let state = store.with_current(|binding, db| {
        db.record_read_snapshot(&request, binding, &source(&input), true, |_, head_revision| {
            assert_eq!(head_revision, 1);
            let update = writer.unchecked_transaction().unwrap();
            update.execute("UPDATE record_document_heads SET head_revision=2,body_hash=?1,document_json=?2,markdown=?3,html=?4,text=?5",
                rusqlite::params![new.body_hash,new.document.to_string(),new.markdown,new.html,new.text]).unwrap();
            update.execute("UPDATE workspace_notes SET title='After title' WHERE id=?1",
                [input.record.id.parse::<i64>().unwrap()]).unwrap();
            update.commit().unwrap();
            true
        })
    }).unwrap();
    assert_eq!(state.head_revision, 1);
    assert_eq!(state.fingerprint.revision, initial.page.source_ref.revision);
    assert_eq!(state.content.as_deref(), Some("# Before\n"));
    assert_eq!(state.fingerprint.title, "Record阅读");
    let fresh = store
        .with_current(|binding, db| {
            db.record_read_snapshot(&request, binding, &source(&input), true, |_, _| true)
        })
        .unwrap();
    assert_eq!(fresh.head_revision, 2);
    assert_eq!(fresh.content.as_deref(), Some("# After\n"));
    assert_eq!(fresh.fingerprint.title, "After title");
    assert_ne!(fresh.fingerprint.revision, initial.page.source_ref.revision);
}

#[test]
fn record_get_rechecks_after_projection_before_returning_a_page() {
    struct ChangedAfterSnapshot {
        store: Store,
        input: RecordGetInput,
        calls: std::sync::atomic::AtomicUsize,
    }
    impl crate::committed_changes::CommittedChangePublisher for ChangedAfterSnapshot {
        fn publish_committed(&self, _: crate::committed_changes::CommittedChanges) {}
    }
    impl BoundSourceStore for ChangedAfterSnapshot {
        fn with_current<T>(
            &self,
            action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
        ) -> AgentResult<T> {
            let result = self.store.with_current(action)?;
            if self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                commit(&self.store, &self.input, "New version", "# New version");
            }
            Ok(result)
        }
    }
    let (_directory, store, request, input) = fixture("Old version", "# Old version");
    let changing = ChangedAfterSnapshot {
        store,
        input: input.clone(),
        calls: std::sync::atomic::AtomicUsize::new(0),
    };
    assert_eq!(
        read(&changing, &request, &input).unwrap_err().code,
        ErrorCode::SourceChanged
    );
    let fresh = read(&changing, &request, &input).unwrap();
    assert_eq!(fresh.head_revision, 2);
    assert_eq!(fresh.page.text, "New version");
}
