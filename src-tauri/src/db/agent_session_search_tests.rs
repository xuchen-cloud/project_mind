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
    let db = Database {
        conn,
        workspace_root: PathBuf::new(),
        secret_password: None,
        native_workspace_id: Some("workspace-a".into()),
    };
    for (id, scope) in [(SESSION, "workspace"), (OTHER, "project:2")] {
        db.conn.execute("INSERT INTO agent_sessions(id,scope_key,title,runtime_id,state,session_path,created_at,updated_at) VALUES (?1,?2,'Search title','pi','active',?3,'now','now')",params![id,scope,format!(".project-mind/agent/sessions/{id}/session.jsonl")]).unwrap();
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
    assert_eq!(literal.matches[0].branch_leaf_id, "tool");
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
    assert!(search(&db, &r, &b, Scope::Workspace, None, "beta")
        .matches
        .is_empty());
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
fn lazy_backfill_is_bounded_resumable_and_reports_coverage() {
    let (db, r, b) = fixture();
    let messages = (0..205)
        .map(|n| {
            message(
                &format!("entry-{n}"),
                n,
                MessageRole::User,
                json!(format!("needle {n}")),
                None,
            )
        })
        .collect::<Vec<_>>();
    db.agent_session_restore_projection(&r, &b, SESSION, &projection(messages, "entry-204"))
        .unwrap();
    db.conn
        .execute("DELETE FROM agent_session_search_rows", [])
        .unwrap();
    let first = search(&db, &r, &b, Scope::Workspace, None, "needle");
    assert_eq!(first.coverage.backfilled_this_request, 200);
    assert_eq!(first.coverage.remaining_messages, 5);
    assert!(!first.coverage.complete);
    assert!(first.next_cursor.is_none());
    let second = search(&db, &r, &b, Scope::Workspace, None, "needle");
    assert_eq!(second.coverage.backfilled_this_request, 5);
    assert!(second.coverage.complete);
    assert_eq!(second.coverage.indexed_messages, 205);
    assert!(second.next_cursor.is_some());
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
fn damaged_legacy_projection_rolls_back_entire_backfill_batch() {
    let (db, r, b) = fixture();
    db.agent_session_restore_projection(
        &r,
        &b,
        SESSION,
        &projection(
            vec![
                message("first", 0, MessageRole::User, json!("needle first"), None),
                message("second", 1, MessageRole::User, json!("needle second"), None),
            ],
            "second",
        ),
    )
    .unwrap();
    db.conn
        .execute("DELETE FROM agent_session_search_rows", [])
        .unwrap();
    db.conn
        .execute(
            "UPDATE agent_messages SET content_json='{}' WHERE runtime_entry_id='second'",
            [],
        )
        .unwrap();
    assert!(db
        .agent_session_search(
            &r,
            &b,
            &AgentSessionSearchInput {
                scope: Scope::Workspace,
                session_id: None,
                query: "needle".into(),
                after_message_id: None,
                limit: 50
            }
        )
        .is_err());
    let indexed: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM agent_session_search_rows",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(indexed, 0);
}

#[test]
fn schema_32_upgrade_reopens_without_eager_message_reads() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("test.sqlite");
    let db = Database::open(&path, root.path(), None).unwrap();
    assert_eq!(db.schema_version().unwrap(), 33);
    let (_unused, r, b) = fixture();
    db.conn.execute("INSERT INTO agent_sessions(id,scope_key,title,runtime_id,state,session_path,created_at,updated_at) VALUES (?1,'workspace','Old title','pi','active',?2,'now','now')",params![SESSION,format!(".project-mind/agent/sessions/{SESSION}/session.jsonl")]).unwrap();
    db.agent_session_restore_projection(
        &r,
        &b,
        SESSION,
        &projection(
            vec![message(
                "old",
                0,
                MessageRole::User,
                json!("旧库检索%_"),
                None,
            )],
            "old",
        ),
    )
    .unwrap();
    db.conn.execute_batch("DROP TRIGGER agent_session_search_row_delete; DROP TABLE agent_session_search_rows; DROP TABLE agent_session_search_fts; PRAGMA user_version=32;").unwrap();
    drop(db);
    let reopened = Database::open(&path, root.path(), None).unwrap();
    assert_eq!(reopened.schema_version().unwrap(), 33);
    assert_eq!(
        reopened
            .conn
            .query_row("SELECT count(*) FROM agent_session_search_rows", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    let page = search(&reopened, &r, &b, Scope::Workspace, None, "检索");
    assert_eq!(page.matches.len(), 1);
    assert_eq!(page.coverage.backfilled_this_request, 1);
    drop(reopened);
    let reopened = Database::open(&path, root.path(), None).unwrap();
    assert_eq!(reopened.schema_version().unwrap(), 33);
    assert_eq!(
        search(&reopened, &r, &b, Scope::Workspace, None, "检索")
            .coverage
            .backfilled_this_request,
        0
    );
}
