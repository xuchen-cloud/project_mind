use super::*;
use crate::{
    agent::{
        access::{Caller, ScopeGrant},
        models::Scope,
    },
    db::Database,
    source_service::{SourceReadInput, SourceReadTarget, SourceReadView, SourceService},
};
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};

const SESSION: &str = "11111111111111111111111111111111";
const ENTRY: &str = "old-branch";
const TIME: &str = "2026-10-22T00:00:00.000Z";
struct Store {
    binding: WorkspaceBinding,
    db: Mutex<Database>,
    calls: AtomicUsize,
    switch_at: AtomicUsize,
}
impl crate::committed_changes::CommittedChangePublisher for Store {
    fn publish_committed(&self, _: crate::committed_changes::CommittedChanges) {}
}
impl BoundSourceStore for Store {
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        let mut current = self.binding.clone();
        if self.calls.fetch_add(1, Ordering::SeqCst) >= self.switch_at.load(Ordering::SeqCst) {
            current.generation = "changed-generation".into();
        }
        action(&current, &self.db.lock().unwrap())
    }
}
struct Fixture {
    temp: tempfile::TempDir,
    store: Store,
    request: RequestContext,
    record: SourceReadRecord,
    checkpoint: SessionCheckpoint,
    bytes: Vec<u8>,
}
impl Fixture {
    fn new(text: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("archive.sqlite"), temp.path(), None).unwrap();
        let message = format!(
            "{:x}",
            Sha256::digest(format!("{SESSION}:{ENTRY}").as_bytes())
        )[..32]
            .to_owned();
        db.test_insert_session_source(SESSION, &message, text);
        // This is the original v3 JSONL tree, including a tool result, a model
        // entry and a different current leaf. The indexed source's branch is
        // still readable even though it is not the active checkpoint branch.
        let entries = [
            json!({"type":"session","version":3,"id":SESSION,"timestamp":TIME,"cwd":"workspace:."}),
            json!({"type":"model_change","id":"model-1","parentId":null,"timestamp":TIME,"provider":"fixture","modelId":"fixture"}),
            json!({"type":"message","id":"tool-1","parentId":"model-1","timestamp":TIME,"message":{"role":"toolResult","content":[{"type":"text","text":"tool text must not be returned"}]}}),
            json!({"type":"message","id":ENTRY,"parentId":"tool-1","timestamp":TIME,"message":{"role":"user","content":[{"type":"image","data":"not-readable-as-text"},{"type":"text","text":text}]}}),
            json!({"type":"message","id":"assistant-1","parentId":ENTRY,"timestamp":TIME,"message":{"role":"assistant","stopReason":"stop","content":[{"type":"thinking","thinking":"private reasoning"},{"type":"text","text":"archived answer"}]}}),
            json!({"type":"message","id":"current-leaf","parentId":"model-1","timestamp":TIME,"message":{"role":"user","content":"other branch"}}),
        ];
        let bytes = (entries
            .iter()
            .map(|entry| serde_json::to_string(entry).unwrap())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n")
            .into_bytes();
        let checkpoint = SessionCheckpoint {
            schema_version: 1,
            checksum: hash(&bytes),
            bytes: bytes.len() as u64,
            offset: bytes.len() as u64,
            leaf_id: Some("current-leaf".into()),
            entry_count: 5,
            message_count: 1,
        };
        let directory = temp
            .path()
            .join(format!(".project-mind/agent/sessions/{SESSION}"));
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("session.jsonl"), &bytes).unwrap();
        fs::write(
            directory.join("checkpoint.json"),
            serde_json::to_vec(&checkpoint).unwrap(),
        )
        .unwrap();
        let conn = rusqlite::Connection::open(temp.path().join("archive.sqlite")).unwrap();
        conn.execute(
            "UPDATE agent_sessions SET checkpoint_json=?1,state='archived' WHERE id=?2",
            rusqlite::params![serde_json::to_string(&checkpoint).unwrap(), SESSION],
        )
        .unwrap();
        conn.execute(
            "UPDATE agent_session_search_rows SET ordinal=1 WHERE message_id=?1",
            [&message],
        )
        .unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "w".into(),
            generation: "g".into(),
        };
        let request = RequestContext {
            binding: binding.clone(),
            request_id: "archival-read".into(),
            caller: Caller::Gui,
            scope_grant: ScopeGrant {
                workspace_id: "w".into(),
                workspace_content: true,
                project_ids: vec![],
                operations: vec!["session.read".into(), "source.read".into()],
                object_keys: None,
            },
        };
        let record = db
            .agent_model_session_message_record(&request, &binding, SESSION, &message)
            .unwrap();
        Self {
            temp,
            store: Store {
                binding,
                db: Mutex::new(db),
                calls: AtomicUsize::new(0),
                switch_at: AtomicUsize::new(usize::MAX),
            },
            request,
            record,
            checkpoint,
            bytes,
        }
    }
    fn reader(&self) -> ArchivalHistory<'_, Store> {
        ArchivalHistory::new(&self.store, &self.request, self.temp.path().to_owned())
    }
    fn path(&self, name: &str) -> PathBuf {
        self.temp
            .path()
            .join(format!(".project-mind/agent/sessions/{SESSION}/{name}"))
    }
}
fn error_code(result: AgentResult<SessionHistoryFragment>) -> ErrorCode {
    result.err().expect("read must fail").code
}

#[tokio::test]
async fn archived_jsonl_reads_unicode_pages_on_the_indexed_historical_branch() {
    let text = "甲😀e\u{301}乙\n尾";
    let f = Fixture::new(text);
    let reader = f.reader();
    let mut cursor = None;
    let mut result = String::new();
    let mut offset = 0;
    loop {
        let fragment = reader
            .read(&f.store.binding, &f.record, cursor.as_deref(), 2)
            .await
            .unwrap();
        assert_eq!(fragment.ordinal, 1); // The tool result participates in branch ordering.
        assert_eq!(fragment.char_start, offset);
        assert!(fragment.text.chars().count() <= 2);
        assert_eq!(fragment.content_hash, hash(text.as_bytes()));
        offset = fragment.char_end;
        result.push_str(&fragment.text);
        cursor = fragment.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(result, text);
    assert_eq!(offset, text.chars().count() as u32);
    assert_eq!(fs::read(f.path("session.jsonl")).unwrap(), f.bytes);
    assert_eq!(
        fs::read_dir(f.path("")).unwrap().count(),
        2,
        "archive reads create no files"
    );
}

#[tokio::test]
async fn archived_jsonl_source_service_retains_bounded_pagination_and_source_receipts() {
    let text = "原始😀材料".repeat(400);
    let f = Fixture::new(&text);
    let mut input = SourceReadInput {
        source: SourceReadTarget {
            object: f.record.source_ref(&f.store.binding).object,
            revision: Some(f.record.text_hash.clone()),
            record_version: None,
            file_version: None,
        },
        view: SourceReadView::Full,
        selection: None,
        cursor: None,
        budget_chars: Some(1000),
    };
    let reader = f.reader();
    let mut result = String::new();
    loop {
        let page = SourceService::new(&f.store)
            .read_session(&f.request, &input, &reader)
            .await
            .unwrap();
        assert_eq!(page.source_ref.revision, f.record.text_hash);
        assert!(serde_json::to_string(&page).unwrap().chars().count() <= 1000);
        result.push_str(&page.text);
        input.cursor = page.next_cursor;
        if input.cursor.is_none() {
            assert!(page.complete);
            break;
        }
    }
    assert_eq!(result, text);
}

#[tokio::test]
async fn archive_rejects_changed_bytes_disk_receipt_or_indexed_identity() {
    let f = Fixture::new("original😀text");
    let reader = f.reader();
    reader
        .read(&f.store.binding, &f.record, None, 3)
        .await
        .unwrap();
    let mut bytes = f.bytes.clone();
    bytes.push(b'\n');
    fs::write(f.path("session.jsonl"), bytes).unwrap();
    assert_eq!(
        error_code(reader.read(&f.store.binding, &f.record, None, 3).await),
        ErrorCode::SourceChanged
    );
    fs::write(f.path("session.jsonl"), &f.bytes).unwrap();
    let mut cp = f.checkpoint.clone();
    cp.leaf_id = Some(ENTRY.into());
    fs::write(f.path("checkpoint.json"), serde_json::to_vec(&cp).unwrap()).unwrap();
    assert_eq!(
        error_code(reader.read(&f.store.binding, &f.record, None, 3).await),
        ErrorCode::SourceChanged
    );
    for mutate in 0..4 {
        let mut record = f.record.clone();
        match mutate {
            0 => record.text_hash = hash(b"different"),
            1 => record.role = "assistant".into(),
            2 => record.ordinal += 1,
            _ => record.total_chars += 1,
        }
        assert_eq!(
            error_code(decode(
                &f.bytes,
                &f.checkpoint,
                &record,
                0,
                3,
                Instant::now() + READ_TIME
            )),
            ErrorCode::SourceChanged
        );
    }
}

#[tokio::test]
async fn archive_rechecks_binding_and_scope_and_rejects_forged_cursors() {
    let mut f = Fixture::new("existing text");
    let mut binding = f.store.binding.clone();
    binding.generation = "other".into();
    assert_eq!(
        error_code(f.reader().read(&binding, &f.record, None, 3).await),
        ErrorCode::WorkspaceChanged
    );
    f.request.scope_grant.workspace_content = false;
    assert_eq!(
        error_code(f.reader().read(&f.store.binding, &f.record, None, 3).await),
        ErrorCode::ScopeDenied
    );
    f.request.scope_grant.workspace_content = true;
    let mut record = f.record.clone();
    record.scope = Scope::Project { project_id: 99 };
    assert_eq!(
        error_code(f.reader().read(&f.store.binding, &record, None, 3).await),
        ErrorCode::ScopeDenied
    );
    let cursor = history_cursor_json("another-branch", &f.record.message_id, 1).unwrap();
    assert_eq!(
        error_code(
            f.reader()
                .read(&f.store.binding, &f.record, Some(&cursor), 3)
                .await
        ),
        ErrorCode::InvalidArgument
    );
    f.store.calls.store(0, Ordering::SeqCst);
    f.store.switch_at.store(1, Ordering::SeqCst);
    assert_eq!(
        error_code(f.reader().read(&f.store.binding, &f.record, None, 3).await),
        ErrorCode::WorkspaceChanged
    );
}

#[tokio::test]
async fn archive_respects_excluded_sources_without_reading_the_jsonl() {
    let f = Fixture::new("private text");
    let key = f.record.source_ref(&f.store.binding).object.key().unwrap();
    f.store.db.lock().unwrap().test_exclude_session_source(&key);
    fs::remove_file(f.path("session.jsonl")).unwrap();
    assert_eq!(
        error_code(f.reader().read(&f.store.binding, &f.record, None, 3).await),
        ErrorCode::NotFound
    );
}

#[cfg(unix)]
#[tokio::test]
async fn archive_rejects_symlink_escapes_without_creating_sessions() {
    let f = Fixture::new("existing text");
    fs::remove_file(f.path("session.jsonl")).unwrap();
    std::os::unix::fs::symlink(
        f.temp.path().join("archive.sqlite"),
        f.path("session.jsonl"),
    )
    .unwrap();
    assert_eq!(
        error_code(f.reader().read(&f.store.binding, &f.record, None, 3).await),
        ErrorCode::ScopeDenied
    );
    assert_eq!(
        archive_directory(f.temp.path(), "../escape")
            .err()
            .unwrap()
            .code,
        ErrorCode::ScopeDenied
    );
    assert_eq!(
        archive_directory(f.temp.path(), &"2".repeat(32))
            .err()
            .unwrap()
            .code,
        ErrorCode::SourceNotReady
    );
}

#[test]
fn archive_preserves_original_role_and_text_only_projection_rules() {
    assert_eq!(
        text_of(
            &json!({"role":"assistant","stopReason":"stop","content":[{"type":"thinking","thinking":"secret"},{"type":"text","text":"answer"}]})
        ),
        "answer"
    );
    for message in [
        json!({"role":"toolResult","content":"secret"}),
        json!({"role":"assistant","stopReason":"error","content":"partial"}),
    ] {
        assert!(text_of(&message).is_empty());
    }
    let f = Fixture::new("text");
    let mut cp = f.checkpoint.clone();
    cp.entry_count += 1;
    assert_eq!(
        error_code(decode(
            &f.bytes,
            &cp,
            &f.record,
            0,
            3,
            Instant::now() + READ_TIME
        )),
        ErrorCode::RuntimeIncompatible
    );
}
