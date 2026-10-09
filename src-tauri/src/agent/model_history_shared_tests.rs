use super::*;
use crate::{
    agent::{
        access::{Caller, ScopeGrant},
        bridge::{dispatch, protocol::CallInput},
        connections::ConnectionCreateInput,
        models::Scope,
        tools::BoundReadContextStore,
    },
    committed_changes::{CommittedChangePublisher, CommittedChanges},
    db::{agent_session_model_search::SourceReadRecord, Database},
    record_document_service::DocumentUtility,
    source_service::SourceUtility,
};
use serde_json::{json, Value};
use std::sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Mutex};
use tokio::sync::{oneshot, Semaphore};

const SESSION: &str = "11111111111111111111111111111111";
const MESSAGE: &str = "22222222222222222222222222222222";
const GRANT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NO_HISTORY_GRANT: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const NO_HISTORY_TOKEN: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

struct Store {
    binding: Mutex<WorkspaceBinding>,
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
        action(&self.binding.lock().unwrap(), &self.db.lock().unwrap())
    }
}
impl BoundReadContextStore for Store {
    fn with_current_context<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database, &str) -> AgentResult<T>,
    ) -> AgentResult<T> {
        action(&self.binding.lock().unwrap(), &self.db.lock().unwrap(), "Bridge Workspace")
    }
}

struct PiFixture {
    text: String,
    scans: AtomicUsize,
}
impl SessionHistoryUtility for PiFixture {
    async fn scan(&self, _: &WorkspaceBinding, work: &SessionScanWork) -> AgentResult<SessionScanPage> {
        self.scans.fetch_add(1, Ordering::SeqCst);
        Ok(SessionScanPage {
            session_id: work.session_id.clone(),
            checksum: work.checksum.clone(),
            entry_count: 1,
            messages: vec![],
            next_cursor: None,
            complete: true,
        })
    }

    async fn read(
        &self,
        _: &WorkspaceBinding,
        record: &SourceReadRecord,
        cursor: Option<&str>,
        max_chars: u32,
    ) -> AgentResult<SessionHistoryFragment> {
        let start = history_cursor_offset(cursor, record)?;
        let chars: Vec<char> = self.text.chars().collect();
        let end = (start as usize + max_chars as usize).min(chars.len()) as u32;
        Ok(SessionHistoryFragment {
            session_id: record.session_id.clone(),
            message_id: record.message_id.clone(),
            runtime_entry_id: record.runtime_entry_id.clone(),
            ordinal: record.ordinal,
            content_hash: record.text_hash.clone(),
            text: chars[start as usize..end as usize].iter().collect(),
            char_start: start,
            char_end: end,
            total_chars: chars.len() as u32,
            next_cursor: (end < chars.len() as u32).then(|| {
                history_cursor_json(&record.runtime_entry_id, &record.message_id, end).unwrap()
            }),
        })
    }
}

fn fixture() -> (tempfile::TempDir, Store, RequestContext, PiFixture) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.sqlite");
    let mut db = Database::open(&path, dir.path(), None).unwrap();
    db.bind_native_workspace("w").unwrap();
    let text = "原始讨论🙂 决定继续".to_owned();
    db.test_insert_session_source(SESSION, MESSAGE, &text);
    rusqlite::Connection::open(&path).unwrap().execute(
        "UPDATE agent_sessions SET checkpoint_json=?1 WHERE id=?2",
        rusqlite::params![r#"{"checksum":"sha256:a","entryCount":1}"#, SESSION],
    ).unwrap();
    let binding = WorkspaceBinding { workspace_id: "w".into(), generation: "g".into() };
    for (grant_id, token) in [(GRANT, TOKEN), (NO_HISTORY_GRANT, NO_HISTORY_TOKEN)] {
        db.agent_connection_create(&binding, &ConnectionCreateInput {
            all_projects: false,
            client_label: "History test".into(), workspace_content: true, project_ids: vec![], write_operations: vec![],
        }, grant_id, token).unwrap();
    }
    // Simulate an existing read-only grant created before session history was automatic.
    rusqlite::Connection::open(&path).unwrap().execute("UPDATE agent_connection_grants SET operations_json=?1 WHERE id=?2",
        rusqlite::params![r#"["context.read","source.read"]"#, NO_HISTORY_GRANT]).unwrap();
    let request = RequestContext {
        binding: binding.clone(),
        caller: Caller::Connection { grant_id: "grant".into() },
        request_id: "history-test".into(),
        scope_grant: ScopeGrant {
            object_keys: None,
            workspace_id: "w".into(),
            workspace_content: true,
            project_ids: vec![],
            operations: vec!["session.read".into()],
        },
    };
    (dir, Store { binding: Mutex::new(binding), db: Mutex::new(db) }, request, PiFixture { text, scans: AtomicUsize::new(0) })
}

fn search_input() -> ModelHistorySearchInput {
    ModelHistorySearchInput {
        scope: Scope::Workspace,
        query: "原".into(),
        session_id: Some(SESSION.into()),
        after_message_id: None,
        limit: 8,
        budget_chars: 4000,
    }
}

struct UnusedDocument;
impl DocumentUtility for UnusedDocument {
    async fn request(&self, _: &str, _: &str, _: Value) -> AgentResult<Value> {
        panic!("history reads do not convert documents")
    }
}
struct UnusedSource;
impl SourceUtility for UnusedSource {
    async fn request(&self, _: &str, _: &str, _: &str, _: &[u8]) -> AgentResult<Value> {
        panic!("history reads do not extract files")
    }
}

fn call(store: &Store, grant_id: &str, request_id: &str, method: &str, params: Value) -> CallInput {
    CallInput {
        instance_id: "history-instance".into(),
        grant_id: grant_id.into(),
        request_id: request_id.into(),
        binding: store.binding.lock().unwrap().clone(),
        method: method.into(),
        params,
    }
}

async fn bridge_call<H: SessionHistoryUtility>(
    store: &Store,
    history: &H,
    token: &str,
    input: CallInput,
) -> AgentResult<Value> {
    let enabled = std::sync::Arc::new(AtomicBool::new(true));
    dispatch::execute(store, &enabled, token, input, &UnusedDocument, &UnusedSource, history).await
}

struct PausedScan<'a> {
    inner: &'a PiFixture,
    entered: Mutex<Option<oneshot::Sender<()>>>,
    resume: Semaphore,
}
impl SessionHistoryUtility for PausedScan<'_> {
    async fn scan(&self, binding: &WorkspaceBinding, work: &SessionScanWork) -> AgentResult<SessionScanPage> {
        if let Some(entered) = self.entered.lock().unwrap().take() { let _ = entered.send(()); }
        self.resume.acquire().await.unwrap().forget();
        self.inner.scan(binding, work).await
    }
    async fn read(&self, binding: &WorkspaceBinding, record: &SourceReadRecord, cursor: Option<&str>, max_chars: u32) -> AgentResult<SessionHistoryFragment> {
        self.inner.read(binding, record, cursor, max_chars).await
    }
}

#[tokio::test]
async fn shared_search_scans_then_returns_real_index_hit_and_original() {
    let (_dir, store, request, pi) = fixture();
    let found = search_with_store(&store, &pi, &request, &search_input()).await.unwrap();
    assert_eq!(pi.scans.load(Ordering::SeqCst), 1);
    assert_eq!(found.matches.len(), 1);
    assert_eq!(found.matches[0].message_id, MESSAGE);
    assert!(found.coverage.complete);
    assert!(!advance_index_with_store(&store, &pi, &request, &Scope::Workspace, Some(SESSION)).await.unwrap());
    let page = read_with_store(&store, &pi, &request, &ModelHistoryReadInput {
        session_id: SESSION.into(), message_id: MESSAGE.into(), cursor: None, budget_chars: 1000,
    }).await.unwrap();
    assert_eq!(page.text, pi.text);
    assert_eq!(page.source_ref.object.id, MESSAGE);
    assert_eq!(page.char_end, pi.text.chars().count() as u32);
}

#[tokio::test]
async fn shared_history_enforces_session_permission_and_scope() {
    let (_dir, store, mut request, pi) = fixture();
    request.scope_grant.operations.clear();
    assert_eq!(search_with_store(&store, &pi, &request, &search_input()).await.unwrap_err().code, ErrorCode::ScopeDenied);
    assert_eq!(read_with_store(&store, &pi, &request, &ModelHistoryReadInput {
        session_id: SESSION.into(), message_id: MESSAGE.into(), cursor: None, budget_chars: 1000,
    }).await.unwrap_err().code, ErrorCode::ScopeDenied);
    request.scope_grant.operations.push("session.read".into());
    request.scope_grant.workspace_content = false;
    assert_eq!(search_with_store(&store, &pi, &request, &search_input()).await.unwrap_err().code, ErrorCode::ScopeDenied);
}

#[tokio::test]
async fn bridge_connection_search_and_original_read_use_persistent_session_grant() {
    let (_dir, store, _request, pi) = fixture();
    let search = json!({"scope":{"kind":"workspace"},"query":"原","sessionId":SESSION,"budgetChars":4000});
    let found = bridge_call(&store, &pi, TOKEN, call(&store, GRANT, "bridge-search", "session.search", search.clone())).await.unwrap();
    assert_eq!(found["matches"][0]["messageId"], MESSAGE);
    let read = json!({"sessionId":SESSION,"messageId":MESSAGE,"budgetChars":1000});
    let original = bridge_call(&store, &pi, TOKEN, call(&store, GRANT, "bridge-read", "session.messages.read", read.clone())).await.unwrap();
    assert_eq!(original["text"], pi.text);
    assert_eq!(original["sourceRef"]["object"]["id"], MESSAGE);

    assert_eq!(bridge_call(&store, &pi, NO_HISTORY_TOKEN,
        call(&store, NO_HISTORY_GRANT, "bridge-no-history-search", "session.search", search)
    ).await.unwrap_err().code, ErrorCode::ScopeDenied);
    assert_eq!(bridge_call(&store, &pi, NO_HISTORY_TOKEN,
        call(&store, NO_HISTORY_GRANT, "bridge-no-history-read", "session.messages.read", read)
    ).await.unwrap_err().code, ErrorCode::ScopeDenied);
}

#[tokio::test]
async fn revoked_connection_during_scan_cannot_release_history() {
    let (_dir, store, _request, pi) = fixture();
    let (entered_tx, entered_rx) = oneshot::channel();
    let paused = PausedScan { inner: &pi, entered: Mutex::new(Some(entered_tx)), resume: Semaphore::new(0) };
    let input = call(&store, GRANT, "bridge-revoked-scan", "session.search",
        json!({"scope":{"kind":"workspace"},"query":"原","sessionId":SESSION}));
    let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(
            bridge_call(&store, &paused, TOKEN, input),
            async {
                entered_rx.await.unwrap();
                let binding = store.binding.lock().unwrap();
                store.db.lock().unwrap().agent_connection_revoke(&binding, GRANT).unwrap();
                paused.resume.add_permits(1);
            }
        )
    }).await.unwrap();
    assert_eq!(result.unwrap_err().code, ErrorCode::ScopeDenied);
}

#[tokio::test]
async fn workspace_switch_during_scan_rejects_fixed_binding() {
    let (_dir, store, _request, pi) = fixture();
    let (entered_tx, entered_rx) = oneshot::channel();
    let paused = PausedScan { inner: &pi, entered: Mutex::new(Some(entered_tx)), resume: Semaphore::new(0) };
    let input = call(&store, GRANT, "bridge-changed-scan", "session.search",
        json!({"scope":{"kind":"workspace"},"query":"原","sessionId":SESSION}));
    let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(
            bridge_call(&store, &paused, TOKEN, input),
            async {
                entered_rx.await.unwrap();
                store.binding.lock().unwrap().generation = "g2".into();
                paused.resume.add_permits(1);
            }
        )
    }).await.unwrap();
    assert_eq!(result.unwrap_err().code, ErrorCode::WorkspaceChanged);
}

impl crate::record_document_service::BoundRecordStore for Store {
    async fn flush_editors(&self, _: &WorkspaceBinding, _: &crate::record_documents::RecordTarget) -> AgentResult<()> { Ok(()) }
    async fn submission_lock(&self, _: &WorkspaceBinding, _: &crate::record_documents::RecordTarget) -> AgentResult<Option<tokio::sync::OwnedMutexGuard<()>>> { Ok(None) }
    fn with_current<T>(&self, action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>) -> AgentResult<T> {
        BoundSourceStore::with_current(self, action)
    }
}

impl crate::file_version_service::BoundFileCommitStore for Store {
    fn gui_commit_host(&self, _: &WorkspaceBinding) -> AgentResult<crate::file_version_service::FileCommitHost> {
        panic!("History fixture does not perform File mutations")
    }
}
