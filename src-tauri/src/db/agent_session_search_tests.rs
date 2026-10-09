use super::*;
use crate::agent::{
    access::ScopeGrant,
    conversation::{SessionCheckpoint, VerifiedSessionProjection},
};
use rusqlite::Connection;
use serde_json::json;
use std::path::PathBuf;

const SESSION: &str = "11111111111111111111111111111111";
const OTHER: &str = "22222222222222222222222222222222";

fn fixture() -> (Database, RequestContext, WorkspaceBinding) {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn.execute_batch(include_str!("agent_schema.sql"))
        .unwrap();
    conn.execute_batch(include_str!("agent_session_search.sql"))
        .unwrap();
    conn.execute_batch(include_str!("agent_session_search_34.sql"))
        .unwrap();
    let db = Database {
        conn,
        workspace_root: PathBuf::new(),
        secret_password: None,
        native_workspace_id: Some("workspace-a".into()),
    };
    for (id, scope) in [(SESSION, "workspace"), (OTHER, "project:2")] {
        db.conn.execute("INSERT INTO agent_sessions(id,scope_key,title,runtime_id,state,session_path,created_at,updated_at) VALUES (?1,?2,'Search title','builtin-pi','active',?3,'now','now')",params![id,scope,format!(".project-mind/agent/sessions/{id}/session.jsonl")]).unwrap();
    }
    let binding = WorkspaceBinding {
        workspace_id: "workspace-a".into(),
        generation: "one".into(),
    };
    let request = RequestContext {
        binding: binding.clone(),
        request_id: "test".into(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: true,
            project_ids: vec![2],
            operations: vec!["session.read".into(), "session.write".into()],
        },
    };
    (db, request, binding)
}

fn message(
    id: &str,
    ordinal: u64,
    role: MessageRole,
    content: serde_json::Value,
    stop: Option<&str>,
) -> ProjectionMessage {
    ProjectionMessage {
        runtime_entry_id: id.into(),
        ordinal,
        created_at: "2026-10-08T00:00:00Z".into(),
        role,
        content,
        parent_id: None,
        stop_reason: stop.map(str::to_owned),
        usage: None,
        tool_call_id: None,
        tool_name: None,
        is_error: None,
    }
}

fn projection(messages: Vec<ProjectionMessage>, leaf: &str) -> VerifiedSessionProjection {
    let count = messages.len() as u64;
    VerifiedSessionProjection {
        checkpoint: SessionCheckpoint {
            schema_version: 1,
            checksum: format!("sha256:{}", "a".repeat(64)),
            bytes: 500,
            offset: 500,
            leaf_id: Some(leaf.into()),
            entry_count: count,
            message_count: count,
        },
        messages,
    }
}

fn search(
    db: &Database,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    scope: Scope,
    session_id: Option<&str>,
    query: &str,
) -> AgentSessionSearchPage {
    db.agent_session_search(
        request,
        binding,
        &AgentSessionSearchInput {
            scope,
            session_id: session_id.map(str::to_owned),
            query: query.into(),
            after_message_id: None,
            limit: 50,
        },
    )
    .unwrap()
}

#[test]
fn chinese_infix_literal_like_scope_and_role_selection() {
    let (db, r, b) = fixture();
    let messages = vec![
        message(
            "user",
            0,
            MessageRole::User,
            json!([{"type":"text","text":"中文"},{"type":"image","text":"hidden"},{"type":"text","text":"讨论%_结束"}]),
            None,
        ),
        message(
            "thinking",
            1,
            MessageRole::Assistant,
            json!("中文讨论"),
            Some("thinking"),
        ),
        message(
            "stop",
            2,
            MessageRole::Assistant,
            json!("中文讨论"),
            Some("stop"),
        ),
        message(
            "tooluse",
            3,
            MessageRole::Assistant,
            json!("工具中文讨论"),
            Some("toolUse"),
        ),
        message("tool", 4, MessageRole::Tool, json!("中文讨论"), None),
    ];
    db.agent_session_restore_projection(&r, &b, SESSION, &projection(messages, "tool"))
        .unwrap();
    assert_eq!(
        search(&db, &r, &b, Scope::Workspace, None, "文讨")
            .matches
            .len(),
        3
    );
    let literal = search(&db, &r, &b, Scope::Workspace, None, "%_");
    assert_eq!(literal.matches.len(), 1);
    assert_eq!(
        literal.matches[0].content_hash,
        format!("sha256:{:x}", Sha256::digest("中文讨论%_结束".as_bytes()))
    );
    assert_eq!(literal.matches[0].branch_leaf_id, "user");
    assert_eq!(
        search(&db, &r, &b, Scope::Workspace, None, "_")
            .matches
            .len(),
        1
    );
    assert_eq!(
        search(&db, &r, &b, Scope::Project { project_id: 2 }, None, "中文")
            .matches
            .len(),
        0
    );
    assert!(db
        .agent_session_search(
            &r,
            &b,
            &AgentSessionSearchInput {
                scope: Scope::Project { project_id: 2 },
                session_id: Some(SESSION.into()),
                query: "中文".into(),
                after_message_id: None,
                limit: 50
            }
        )
        .is_err());
}

#[test]
fn projection_replacement_deletion_and_failure_roll_back_index() {
    let (db, r, b) = fixture();
    let first = projection(
        vec![message(
            "one",
            0,
            MessageRole::User,
            json!("alpha 原文"),
            None,
        )],
        "one",
    );
    db.agent_session_restore_projection(&r, &b, SESSION, &first)
        .unwrap();
    let hit = &search(&db, &r, &b, Scope::Workspace, None, "alpha").matches[0];
    let stable_id = hit.message_id.clone();
    let stable_hash = hit.content_hash.clone();
    db.agent_session_restore_projection(&r, &b, SESSION, &first)
        .unwrap();
    assert_eq!(
        search(&db, &r, &b, Scope::Workspace, None, "alpha").matches[0].content_hash,
        stable_hash
    );
    let changed = projection(
        vec![message(
            "one",
            0,
            MessageRole::User,
            json!("beta 原文"),
            None,
        )],
        "one",
    );
    db.conn.execute_batch("CREATE TRIGGER reject_search_update BEFORE UPDATE ON agent_session_search_rows BEGIN SELECT RAISE(ABORT,'index failed'); END;").unwrap();
    assert!(db
        .agent_session_restore_projection(&r, &b, SESSION, &changed)
        .is_err());
    assert_eq!(
        search(&db, &r, &b, Scope::Workspace, None, "alpha").matches[0].message_id,
        stable_id
    );
    db.conn
        .execute_batch("DROP TRIGGER reject_search_update")
        .unwrap();
    db.agent_session_restore_projection(&r, &b, SESSION, &changed)
        .unwrap();
    assert!(search(&db, &r, &b, Scope::Workspace, None, "alpha")
        .matches
        .is_empty());
    assert_eq!(
        search(&db, &r, &b, Scope::Workspace, None, "beta").matches[0].message_id,
        stable_id
    );
    db.agent_session_restore_projection(
        &r,
        &b,
        SESSION,
        &projection(
            vec![message("two", 0, MessageRole::User, json!("gamma"), None)],
            "two",
        ),
    )
    .unwrap();
    assert_eq!(
        search(&db, &r, &b, Scope::Workspace, None, "beta")
            .matches
            .len(),
        1
    );
    db.conn
        .execute("DELETE FROM agent_sessions WHERE id=?1", [SESSION])
        .unwrap();
    let count: i64 = db
        .conn
        .query_row("SELECT count(*) FROM agent_session_search_fts", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn current_projection_does_not_claim_tree_complete() {
    let (db, r, b) = fixture();
    db.agent_session_restore_projection(
        &r,
        &b,
        SESSION,
        &projection(
            vec![message("one", 0, MessageRole::User, json!("needle"), None)],
            "one",
        ),
    )
    .unwrap();
    let page = search(&db, &r, &b, Scope::Workspace, None, "needle");
    assert_eq!(page.matches.len(), 1);
    assert!(!page.coverage.complete);
    assert_eq!(page.coverage.pending_sessions, 1);
    let work = db
        .agent_session_scan_work(&r, &b, &Scope::Workspace, Some(SESSION))
        .unwrap()
        .unwrap();
    let text = "needle";
    db.agent_session_scan_commit(
        &r,
        &b,
        &work,
        &SessionScanPage {
            session_id: SESSION.into(),
            checksum: work.checksum.clone(),
            entry_count: 1,
            messages: vec![SessionScanMessage {
                message_id: page.matches[0].message_id.clone(),
                runtime_entry_id: "one".into(),
                branch_id: "one".into(),
                ordinal: 0,
                role: MessageRole::User,
                created_at: "2026-10-08T00:00:00Z".into(),
                text: text.into(),
                content_hash: format!("sha256:{:x}", Sha256::digest(text.as_bytes())),
                char_start: 0,
                char_end: 6,
                total_chars: 6,
            }],
            next_cursor: None,
            complete: true,
        },
    )
    .unwrap();
    assert!(
        search(&db, &r, &b, Scope::Workspace, None, "needle")
            .coverage
            .complete
    );
}

#[test]
fn search_requires_gui_current_binding_and_session_read() {
    let (db, mut r, b) = fixture();
    let input = AgentSessionSearchInput {
        scope: Scope::Workspace,
        session_id: None,
        query: "needle".into(),
        after_message_id: None,
        limit: 20,
    };
    r.scope_grant
        .operations
        .retain(|operation| operation != "session.read");
    assert_eq!(
        db.agent_session_search(&r, &b, &input).unwrap_err().code,
        ErrorCode::ScopeDenied
    );
    r.scope_grant.operations.push("session.read".into());
    let changed = WorkspaceBinding {
        generation: "next".into(),
        ..b.clone()
    };
    assert_eq!(
        db.agent_session_search(&r, &changed, &input)
            .unwrap_err()
            .code,
        ErrorCode::WorkspaceChanged
    );
    r.caller = Caller::BuiltinRun {
        run_id: "run".into(),
    };
    assert_eq!(
        db.agent_session_search(&r, &b, &input).unwrap_err().code,
        ErrorCode::ScopeDenied
    );
    let decoded: AgentSessionSearchInput =
        serde_json::from_value(json!({"scope":{"kind":"workspace"},"query":"needle"})).unwrap();
    assert_eq!(decoded.limit, 20);
}

#[test]
fn complete_keyset_pages_once_and_snippets_obey_unicode_budget() {
    let (db, r, b) = fixture();
    let messages = (0..52)
        .map(|n| {
            message(
                &format!("entry-{n}"),
                n,
                MessageRole::User,
                json!(format!("{} needle {}", "界".repeat(300), n)),
                None,
            )
        })
        .collect();
    db.agent_session_restore_projection(&r, &b, SESSION, &projection(messages, "entry-51"))
        .unwrap();
    let work = db
        .agent_session_scan_work(&r, &b, &Scope::Workspace, Some(SESSION))
        .unwrap()
        .unwrap();
    let fragments = (0..52)
        .map(|n| {
            let entry = format!("entry-{n}");
            let text = format!("{} needle {}", "界".repeat(300), n);
            let count = text.chars().count() as u32;
            SessionScanMessage {
                message_id: format!(
                    "{:x}",
                    Sha256::digest(format!("{SESSION}:{entry}").as_bytes())
                )[..32]
                    .into(),
                runtime_entry_id: entry.clone(),
                branch_id: entry,
                ordinal: n,
                role: MessageRole::User,
                created_at: "2026-10-08T00:00:00Z".into(),
                content_hash: format!("sha256:{:x}", Sha256::digest(text.as_bytes())),
                text,
                char_start: 0,
                char_end: count,
                total_chars: count,
            }
        })
        .collect();
    db.agent_session_scan_commit(
        &r,
        &b,
        &work,
        &SessionScanPage {
            session_id: SESSION.into(),
            checksum: work.checksum.clone(),
            entry_count: 52,
            messages: fragments,
            next_cursor: None,
            complete: true,
        },
    )
    .unwrap();
    let mut after = None;
    let mut ids = std::collections::HashSet::new();
    loop {
        let page = db
            .agent_session_search(
                &r,
                &b,
                &AgentSessionSearchInput {
                    scope: Scope::Workspace,
                    session_id: None,
                    query: "needle".into(),
                    after_message_id: after,
                    limit: 50,
                },
            )
            .unwrap();
        assert!(page.coverage.complete);
        assert!(
            page.matches
                .iter()
                .map(|hit| hit.snippet.chars().count())
                .sum::<usize>()
                <= 12_000
        );
        for hit in &page.matches {
            assert!(ids.insert(hit.message_id.clone()));
        }
        if page.next_cursor.is_none() {
            break;
        }
        after = page.next_cursor;
    }
    assert_eq!(ids.len(), 52);
}

#[test]
fn schema_33_upgrade_reopens_and_preserves_index() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("test.sqlite");
    let db = Database::open(&path, root.path(), None).unwrap();
    let (_unused, r, b) = fixture();
    db.conn.execute("INSERT INTO agent_sessions(id,scope_key,title,runtime_id,state,session_path,created_at,updated_at) VALUES (?1,'workspace','Old title','builtin-pi','active',?2,'now','now')",params![SESSION,format!(".project-mind/agent/sessions/{SESSION}/session.jsonl")]).unwrap();
    db.agent_session_restore_projection(
        &r,
        &b,
        SESSION,
        &projection(
            vec![message(
                "old",
                0,
                MessageRole::User,
                json!("检索前缀\u{0}🙂文"),
                None,
            )],
            "old",
        ),
    )
    .unwrap();
    db.conn.execute("INSERT INTO agent_runs(id,session_id,client_request_id,state,context_manifest_json,grant_json,started_at) VALUES ('legacy-run',?1,'legacy-request','completed','{}','{}','now')",[SESSION]).unwrap();
    db.conn
        .execute(
            "UPDATE agent_messages SET run_id='legacy-run' WHERE session_id=?1",
            [SESSION],
        )
        .unwrap();
    db.conn.execute_batch("DROP TABLE agent_session_scan_state; DROP INDEX agent_session_search_rows_session; DROP TRIGGER agent_session_search_row_delete; DROP TABLE agent_session_search_rows; DROP TABLE agent_session_search_fts;").unwrap();
    db.conn
        .execute_batch(include_str!("agent_session_search.sql"))
        .unwrap();
    let legacy_text = "检索前缀\u{0}🙂文";
    db.conn.execute("INSERT INTO agent_session_search_rows(message_id,text_hash,text) SELECT id,?1,?2 FROM agent_messages",params![format!("sha256:{:x}",Sha256::digest(legacy_text.as_bytes())),legacy_text]).unwrap();
    db.conn.execute_batch("PRAGMA user_version=33").unwrap();
    drop(db);
    let reopened = Database::open(&path, root.path(), None).unwrap();
    assert_eq!(reopened.schema_version().unwrap(), 34);
    assert_eq!(
        reopened
            .conn
            .query_row(
                "SELECT total_chars FROM agent_session_search_rows",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        "检索前缀\u{0}🙂文".chars().count() as i64
    );
    assert_eq!(
        reopened
            .conn
            .query_row("SELECT run_id FROM agent_session_search_rows", [], |row| {
                row.get::<_, Option<String>>(0)
            })
            .unwrap()
            .as_deref(),
        Some("legacy-run")
    );
    assert_eq!(
        search(&reopened, &r, &b, Scope::Workspace, None, "检索")
            .matches
            .len(),
        1
    );
    drop(reopened);
    let again = Database::open(&path, root.path(), None).unwrap();
    assert_eq!(
        search(&again, &r, &b, Scope::Workspace, None, "检索")
            .matches
            .len(),
        1
    );
}

#[test]
fn partial_unicode_resume_hash_and_atomic_rejection() {
    let (db, r, b) = fixture();
    db.agent_session_restore_projection(&r, &b, SESSION, &projection(vec![], "entry"))
        .unwrap();
    // The verified checkpoint includes one tree entry, outside the current branch.
    db.conn.execute("UPDATE agent_sessions SET checkpoint_json=json_set(checkpoint_json,'$.entryCount',1) WHERE id=?1",[SESSION]).unwrap();
    let work = db
        .agent_session_scan_work(&r, &b, &Scope::Workspace, Some(SESSION))
        .unwrap()
        .unwrap();
    let full = "甲😀乙";
    let hash = format!("sha256:{:x}", Sha256::digest(full.as_bytes()));
    let id = format!(
        "{:x}",
        Sha256::digest(format!("{SESSION}:entry").as_bytes())
    )[..32]
        .to_owned();
    let fragment = |text: &str, start, end| SessionScanMessage {
        message_id: id.clone(),
        runtime_entry_id: "entry".into(),
        branch_id: "entry".into(),
        ordinal: 0,
        role: MessageRole::User,
        created_at: "now".into(),
        text: text.into(),
        content_hash: hash.clone(),
        char_start: start,
        char_end: end,
        total_chars: 3,
    };
    db.agent_session_scan_commit(
        &r,
        &b,
        &work,
        &SessionScanPage {
            session_id: SESSION.into(),
            checksum: work.checksum.clone(),
            entry_count: 1,
            messages: vec![fragment("甲😀", 0, 2)],
            next_cursor: Some(ScanCursor {
                entry_offset: 0,
                char_offset: 2,
            }),
            complete: false,
        },
    )
    .unwrap();
    assert!(search(&db, &r, &b, Scope::Workspace, None, "甲")
        .matches
        .is_empty());
    assert_eq!(
        db.agent_session_scan_commit(
            &r,
            &b,
            &work,
            &SessionScanPage {
                session_id: SESSION.into(),
                checksum: work.checksum.clone(),
                entry_count: 1,
                messages: vec![],
                next_cursor: Some(ScanCursor {
                    entry_offset: 1,
                    char_offset: 0
                }),
                complete: false
            }
        )
        .unwrap_err()
        .code,
        ErrorCode::RevisionConflict
    );
    let next = db
        .agent_session_scan_work(&r, &b, &Scope::Workspace, Some(SESSION))
        .unwrap()
        .unwrap();
    assert_eq!(
        next.cursor,
        Some(ScanCursor {
            entry_offset: 0,
            char_offset: 2
        })
    );
    assert!(db
        .agent_session_scan_commit(
            &r,
            &b,
            &next,
            &SessionScanPage {
                session_id: SESSION.into(),
                checksum: next.checksum.clone(),
                entry_count: 1,
                messages: vec![fragment("错", 2, 3)],
                next_cursor: None,
                complete: true
            }
        )
        .is_err());
    assert!(search(&db, &r, &b, Scope::Workspace, None, "甲")
        .matches
        .is_empty());
    db.agent_session_scan_commit(
        &r,
        &b,
        &next,
        &SessionScanPage {
            session_id: SESSION.into(),
            checksum: next.checksum.clone(),
            entry_count: 1,
            messages: vec![fragment("乙", 2, 3)],
            next_cursor: None,
            complete: true,
        },
    )
    .unwrap();
    assert_eq!(
        search(&db, &r, &b, Scope::Workspace, None, "😀乙")
            .matches
            .len(),
        1
    );
}

#[test]
fn scan_rejects_checkpoint_change_and_session_deletion() {
    let (db, r, b) = fixture();
    db.agent_session_restore_projection(&r, &b, SESSION, &projection(vec![], "entry"))
        .unwrap();
    let work = db
        .agent_session_scan_work(&r, &b, &Scope::Workspace, Some(SESSION))
        .unwrap()
        .unwrap();
    db.conn.execute("UPDATE agent_sessions SET checkpoint_json=json_set(checkpoint_json,'$.checksum',?2) WHERE id=?1",params![SESSION,format!("sha256:{}","b".repeat(64))]).unwrap();
    let page = SessionScanPage {
        session_id: SESSION.into(),
        checksum: work.checksum.clone(),
        entry_count: 0,
        messages: vec![],
        next_cursor: None,
        complete: true,
    };
    assert_eq!(
        db.agent_session_scan_commit(&r, &b, &work, &page)
            .unwrap_err()
            .code,
        ErrorCode::RevisionConflict
    );
    db.conn
        .execute("DELETE FROM agent_sessions WHERE id=?1", [SESSION])
        .unwrap();
    assert_eq!(
        db.agent_session_scan_commit(&r, &b, &work, &page)
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
}

#[test]
fn nonsearchable_projection_messages_do_not_hold_coverage_open() {
    let (db, r, b) = fixture();
    let messages = vec![
        message("tool", 0, MessageRole::Tool, json!("hidden"), None),
        message(
            "failed",
            1,
            MessageRole::Assistant,
            json!("hidden"),
            Some("error"),
        ),
        message(
            "thinking",
            2,
            MessageRole::Assistant,
            json!("hidden"),
            Some("thinking"),
        ),
    ];
    db.agent_session_restore_projection(&r, &b, SESSION, &projection(messages, "thinking"))
        .unwrap();
    let work = db
        .agent_session_scan_work(&r, &b, &Scope::Workspace, Some(SESSION))
        .unwrap()
        .unwrap();
    db.agent_session_scan_commit(
        &r,
        &b,
        &work,
        &SessionScanPage {
            session_id: SESSION.into(),
            checksum: work.checksum.clone(),
            entry_count: 3,
            messages: vec![],
            next_cursor: None,
            complete: true,
        },
    )
    .unwrap();
    let page = search(&db, &r, &b, Scope::Workspace, None, "hidden");
    assert!(page.matches.is_empty());
    assert_eq!(page.coverage.remaining_messages, 0);
    assert_eq!(page.coverage.pending_sessions, 0);
    assert!(page.coverage.complete);
}

#[test]
fn identical_projection_does_not_write_index_and_failed_revision_removes_it() {
    let (db, r, b) = fixture();
    let good = projection(
        vec![message(
            "one",
            0,
            MessageRole::Assistant,
            json!("needle"),
            Some("stop"),
        )],
        "one",
    );
    db.agent_session_restore_projection(&r, &b, SESSION, &good)
        .unwrap();
    db.conn.execute_batch("CREATE TRIGGER forbid_same_update BEFORE UPDATE ON agent_session_search_rows BEGIN SELECT RAISE(ABORT,'unexpected update'); END; CREATE TRIGGER forbid_same_insert BEFORE INSERT ON agent_session_search_rows BEGIN SELECT RAISE(ABORT,'unexpected index insert'); END;").unwrap();
    db.agent_session_restore_projection(&r, &b, SESSION, &good)
        .unwrap();
    db.conn
        .execute_batch("DROP TRIGGER forbid_same_update; DROP TRIGGER forbid_same_insert")
        .unwrap();
    db.agent_session_restore_projection(
        &r,
        &b,
        SESSION,
        &projection(
            vec![message(
                "one",
                0,
                MessageRole::Assistant,
                json!("needle"),
                Some("error"),
            )],
            "one",
        ),
    )
    .unwrap();
    assert!(search(&db, &r, &b, Scope::Workspace, None, "needle")
        .matches
        .is_empty());
}

#[test]
fn empty_scan_page_must_advance_within_entries() {
    let (db, r, b) = fixture();
    db.agent_session_restore_projection(&r, &b, SESSION, &projection(vec![], "entry"))
        .unwrap();
    db.conn.execute("UPDATE agent_sessions SET checkpoint_json=json_set(checkpoint_json,'$.entryCount',2) WHERE id=?1",[SESSION]).unwrap();
    let work = db
        .agent_session_scan_work(&r, &b, &Scope::Workspace, Some(SESSION))
        .unwrap()
        .unwrap();
    for cursor in [
        ScanCursor {
            entry_offset: 0,
            char_offset: 0,
        },
        ScanCursor {
            entry_offset: 2,
            char_offset: 0,
        },
        ScanCursor {
            entry_offset: 2,
            char_offset: 1,
        },
    ] {
        assert!(db
            .agent_session_scan_commit(
                &r,
                &b,
                &work,
                &SessionScanPage {
                    session_id: SESSION.into(),
                    checksum: work.checksum.clone(),
                    entry_count: 2,
                    messages: vec![],
                    next_cursor: Some(cursor),
                    complete: false
                }
            )
            .is_err());
    }
    db.agent_session_scan_commit(
        &r,
        &b,
        &work,
        &SessionScanPage {
            session_id: SESSION.into(),
            checksum: work.checksum.clone(),
            entry_count: 2,
            messages: vec![],
            next_cursor: Some(ScanCursor {
                entry_offset: 1,
                char_offset: 0,
            }),
            complete: false,
        },
    )
    .unwrap();
}
