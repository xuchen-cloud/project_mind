use super::*;
use crate::{
    agent::{
        access::{Caller, ScopeGrant},
        models::{ObjectKind, ObjectRef, Scope},
    },
    db::Database,
    source_service::SourceReadTarget,
};
use std::sync::Mutex;

const SESSION: &str = "11111111111111111111111111111111";
const MESSAGE: &str = "22222222222222222222222222222222";
struct Store {
    binding: WorkspaceBinding,
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
        action(&self.binding, &self.db.lock().unwrap())
    }
}
struct Reader {
    text: String,
    changed: bool,
}
impl SessionHistoryUtility for Reader {
    async fn read(
        &self,
        _: &WorkspaceBinding,
        record: &SourceReadRecord,
        cursor: Option<&str>,
        max_chars: u32,
    ) -> AgentResult<SessionHistoryFragment> {
        let start = crate::agent::model_history::history_cursor_offset(cursor, record)?;
        let chars: Vec<char> = self.text.chars().collect();
        let end = (start as usize + max_chars as usize).min(chars.len()) as u32;
        Ok(SessionHistoryFragment {
            session_id: record.session_id.clone(),
            message_id: record.message_id.clone(),
            runtime_entry_id: record.runtime_entry_id.clone(),
            ordinal: record.ordinal,
            content_hash: if self.changed {
                "sha256:changed".into()
            } else {
                record.text_hash.clone()
            },
            text: chars[start as usize..end as usize].iter().collect(),
            char_start: start,
            char_end: end,
            total_chars: chars.len() as u32,
            next_cursor: (end < chars.len() as u32).then(|| {
                crate::agent::model_history::history_cursor_json(
                    &record.runtime_entry_id,
                    &record.message_id,
                    end,
                )
                .unwrap()
            }),
        })
    }
}
struct ExcludingReader<'a> {
    store: &'a Store,
    inner: Reader,
}
impl SessionHistoryUtility for ExcludingReader<'_> {
    async fn read(
        &self,
        binding: &WorkspaceBinding,
        record: &SourceReadRecord,
        cursor: Option<&str>,
        max_chars: u32,
    ) -> AgentResult<SessionHistoryFragment> {
        let page = self.inner.read(binding, record, cursor, max_chars).await?;
        let key = record.source_ref(binding).object.key()?;
        self.store
            .db
            .lock()
            .unwrap()
            .test_exclude_session_source(&key);
        Ok(page)
    }
}
fn fixture(text: &str) -> (tempfile::TempDir, Store, RequestContext, SourceReadInput) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("test.sqlite"), dir.path(), None).unwrap();
    db.test_insert_session_source(SESSION, MESSAGE, text);
    let binding = WorkspaceBinding {
        workspace_id: "w".into(),
        generation: "g".into(),
    };
    let request = RequestContext {
        binding: binding.clone(),
        caller: Caller::Connection {
            grant_id: "g".into(),
        },
        request_id: "r".into(),
        scope_grant: ScopeGrant {
            workspace_id: "w".into(),
            workspace_content: true,
            project_ids: vec![],
            operations: vec!["session.read".into(), "source.read".into()],
        },
    };
    let input = SourceReadInput {
        source: SourceReadTarget {
            object: ObjectRef {
                workspace_id: "w".into(),
                scope: Scope::Workspace,
                kind: ObjectKind::SessionMessage,
                id: MESSAGE.into(),
            },
            revision: None,
            record_version: None,
            file_version: None,
        },
        view: SourceReadView::Full,
        selection: None,
        cursor: None,
        budget_chars: Some(1000),
    };
    (
        dir,
        Store {
            binding,
            db: Mutex::new(db),
        },
        request,
        input,
    )
}

#[tokio::test]
async fn source_page_reads_original_branch_and_rechecks_policy() {
    let text = "原文🙂\n".repeat(800);
    let (_dir, store, request, mut input) = fixture(&text);
    let reader = Reader {
        text: text.clone(),
        changed: false,
    };
    let first = SourceService::new(&store)
        .read_session_result(&request, &input, &reader)
        .await
        .unwrap();
    assert_eq!(
        store
            .with_current(|binding, db| Ok(db
                .source_session_record(&request, binding, &input.source)?
                .ordinal))
            .unwrap(),
        0
    );
    assert!(text.starts_with(&first.page.text));
    assert!(first.char_end < first.total_chars);
    assert!(serde_json::to_string(&first.page).unwrap().chars().count() <= 1000);
    assert_eq!(first.page.source_ref.title, "历史讨论");
    assert!(!serde_json::to_string(&first.page)
        .unwrap()
        .contains("secret"));
    input.cursor = first.page.next_cursor;
    let second = SourceService::new(&store)
        .read_session_result(&request, &input, &reader)
        .await
        .unwrap();
    assert_eq!(second.char_start, first.char_end);
    let key = first.page.source_ref.object.key().unwrap();
    store.db.lock().unwrap().test_exclude_session_source(&key);
    assert!(matches!(
        SourceService::new(&store)
            .read_session(&request, &input, &reader)
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound | ErrorCode::ScopeDenied
    ));
}

#[tokio::test]
async fn changed_original_and_missing_grants_are_rejected() {
    let (_dir, store, mut request, input) = fixture("原始讨论");
    assert_eq!(
        SourceService::new(&store)
            .read_session(
                &request,
                &input,
                &Reader {
                    text: "原始讨论".into(),
                    changed: true
                }
            )
            .await
            .unwrap_err()
            .code,
        ErrorCode::SourceChanged
    );
    request
        .scope_grant
        .operations
        .retain(|op| op != "source.read");
    assert_eq!(
        SourceService::new(&store)
            .read_session(
                &request,
                &input,
                &Reader {
                    text: "原始讨论".into(),
                    changed: false
                }
            )
            .await
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
}

#[tokio::test]
async fn captured_message_evidence_expires_when_source_is_excluded() {
    let (_dir, store, request, input) = fixture("决定：采用旧分支原文");
    let reader = Reader {
        text: "决定：采用旧分支原文".into(),
        changed: false,
    };
    let (page, evidence) =
        crate::overview_evidence::capture_session(&store, &request, &input, &reader)
            .await
            .unwrap();
    assert!(evidence.matches(&page.source_ref));
    store
        .with_current(|binding, db| evidence.verify(db, &request, binding))
        .unwrap();
    let key = page.source_ref.object.key().unwrap();
    store.db.lock().unwrap().test_exclude_session_source(&key);
    assert!(matches!(
        store
            .with_current(|binding, db| evidence.verify(db, &request, binding))
            .unwrap_err()
            .code,
        ErrorCode::NotFound | ErrorCode::ScopeDenied
    ));
}

#[tokio::test]
async fn policy_change_during_original_read_blocks_release() {
    let (_dir, store, request, input) = fixture("外部读取期间变更");
    let reader = ExcludingReader {
        store: &store,
        inner: Reader {
            text: "外部读取期间变更".into(),
            changed: false,
        },
    };
    assert!(matches!(
        SourceService::new(&store)
            .read_session(&request, &input, &reader)
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound | ErrorCode::ScopeDenied
    ));
}
