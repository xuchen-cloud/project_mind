use super::*;
use crate::agent::{
    access::{Caller, RequestContext, ScopeGrant},
    conversation::{MessageRole, ProjectionMessage, SessionCheckpoint, VerifiedSessionProjection},
};
use crate::models::ProjectCreateInput;
use rusqlite::params;
use serde_json::json;
use sha2::{Digest, Sha256};

fn setup() -> (
    tempfile::TempDir,
    Database,
    RequestContext,
    WorkspaceBinding,
    Scope,
    String,
) {
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(&root.path().join("workspace.sqlite"), root.path(), None).unwrap();
    let project = db
        .project_create(ProjectCreateInput {
            name: "Alpha".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let scope = Scope::Project {
        project_id: project.id,
    };
    let binding = WorkspaceBinding {
        workspace_id: "w".into(),
        generation: "g".into(),
    };
    let request = RequestContext {
        binding: binding.clone(),
        caller: Caller::Gui,
        request_id: "test".into(),
        scope_grant: ScopeGrant {
            workspace_id: "w".into(),
            workspace_content: true,
            project_ids: vec![project.id],
            operations: vec!["session.read".into(), "session.write".into()],
        },
    };
    let session = db
        .agent_session_create(&request, &binding, &scope, "History", "builtin-pi", None)
        .unwrap();
    (root, db, request, binding, scope, session.id)
}
fn id(session: &str, entry: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{session}:{entry}").as_bytes())
    )[..32]
        .into()
}
fn hash(text: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(text.as_bytes()))
}
fn projection(entry: &str, text: &str) -> VerifiedSessionProjection {
    VerifiedSessionProjection {
        checkpoint: SessionCheckpoint {
            schema_version: 1,
            checksum: hash(entry),
            bytes: 500,
            offset: 500,
            leaf_id: Some(entry.into()),
            entry_count: 1,
            message_count: 1,
        },
        messages: vec![ProjectionMessage {
            runtime_entry_id: entry.into(),
            ordinal: 0,
            created_at: "2026-10-08T00:00:00Z".into(),
            role: MessageRole::User,
            content: json!([{"type":"text","text":text}]),
            parent_id: None,
            stop_reason: None,
            usage: None,
            tool_call_id: None,
            tool_name: None,
            is_error: None,
        }],
    }
}
fn event_count(db: &Database, key: &str) -> i64 {
    db.conn.query_row("SELECT count(*) FROM agent_change_log WHERE object_key=?1 AND operation='session.message.index'",[key],|r|r.get(0)).unwrap()
}
fn key(binding: &WorkspaceBinding, scope: &Scope, id: &str) -> String {
    object_key(&binding.workspace_id, scope, id).unwrap()
}

#[test]
fn projection_change_registers_once_and_branch_switch_preserves_source() {
    let (_root, db, r, b, scope, session) = setup();
    let message_id = id(&session, "one");
    let source = key(&b, &scope, &message_id);
    db.agent_session_restore_projection(&r, &b, &session, &projection("one", "first"))
        .unwrap();
    assert_eq!(event_count(&db, &source), 1);
    assert_eq!(
        db.conn
            .query_row(
                "SELECT count(*) FROM agent_overview_pending WHERE object_key=?1",
                [&source],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    db.agent_session_restore_projection(&r, &b, &session, &projection("one", "first"))
        .unwrap();
    assert_eq!(event_count(&db, &source), 1);
    db.agent_session_restore_projection(&r, &b, &session, &projection("one", "second"))
        .unwrap();
    assert_eq!(event_count(&db, &source), 2);
    let empty = VerifiedSessionProjection {
        checkpoint: SessionCheckpoint {
            schema_version: 1,
            checksum: hash("other"),
            bytes: 500,
            offset: 500,
            leaf_id: Some("other".into()),
            entry_count: 0,
            message_count: 0,
        },
        messages: vec![],
    };
    db.agent_session_restore_projection(&r, &b, &session, &empty)
        .unwrap();
    assert_eq!(event_count(&db, &source), 2);
    assert_eq!(
        db.conn
            .query_row(
                "SELECT deleted_at FROM source_registry WHERE object_key=?1",
                [&source],
                |row| row.get::<_, Option<String>>(0)
            )
            .unwrap(),
        None
    );
}

#[test]
fn completed_scan_fragment_registers_then_session_delete_tombstones() {
    use crate::db::agent_session_search::{ScanCursor, SessionScanMessage, SessionScanPage};
    let (_root, db, r, b, scope, session) = setup();
    db.agent_session_restore_projection(&r, &b, &session, &projection("current", "current"))
        .unwrap();
    let old_id = id(&session, "old");
    let old_key = key(&b, &scope, &old_id);
    let work = db
        .agent_session_scan_work(&r, &b, &scope, Some(&session))
        .unwrap()
        .unwrap();
    let fragment = |start: u32, end: u32, text: &str| SessionScanMessage {
        message_id: old_id.clone(),
        runtime_entry_id: "old".into(),
        branch_id: "old".into(),
        ordinal: 0,
        role: MessageRole::User,
        created_at: "2026-10-08T00:00:00Z".into(),
        content_hash: hash("older"),
        text: text.into(),
        char_start: start,
        char_end: end,
        total_chars: 5,
    };
    db.agent_session_scan_commit(
        &r,
        &b,
        &work,
        &SessionScanPage {
            session_id: session.clone(),
            checksum: work.checksum.clone(),
            entry_count: 1,
            messages: vec![fragment(0, 2, "ol")],
            next_cursor: Some(ScanCursor {
                entry_offset: 0,
                char_offset: 2,
            }),
            complete: false,
        },
    )
    .unwrap();
    assert_eq!(event_count(&db, &old_key), 0);
    let resumed = db
        .agent_session_scan_work(&r, &b, &scope, Some(&session))
        .unwrap()
        .unwrap();
    db.agent_session_scan_commit(
        &r,
        &b,
        &resumed,
        &SessionScanPage {
            session_id: session.clone(),
            checksum: resumed.checksum.clone(),
            entry_count: 1,
            messages: vec![fragment(2, 5, "der")],
            next_cursor: None,
            complete: true,
        },
    )
    .unwrap();
    assert_eq!(event_count(&db, &old_key), 1);
    db.agent_session_delete(&r, &b, &session).unwrap();
    assert_eq!(
        db.conn
            .query_row(
                "SELECT event_revision FROM source_registry WHERE object_key=?1",
                [&old_key],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "deleted"
    );
    assert_eq!(
        db.conn
            .query_row(
                "SELECT deleted FROM agent_overview_pending WHERE object_key=?1",
                [&old_key],
                |row| row.get::<_, bool>(0)
            )
            .unwrap(),
        true
    );
}

#[test]
fn seed_uses_registry_hash_and_stays_bounded() {
    let (_root, db, _r, b, scope, session) = setup();
    for (entry, text) in [("first", "a"), ("second", "b")] {
        db.conn.execute("INSERT INTO agent_session_search_rows(message_id,session_id,runtime_entry_id,ordinal,role,created_at,text_hash,text,total_chars,complete) VALUES (?1,?2,?3,0,'user','now',?4,?5,1,1)",params![id(&session,entry),session,entry,hash(text),text]).unwrap();
    }
    assert!(db.agent_session_maintenance_seed(&b, &scope, 1).unwrap());
    assert!(!db.agent_session_maintenance_seed(&b, &scope, 1).unwrap());
    let count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM agent_change_log WHERE operation='session.message.index'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 2);
    assert!(!db.agent_session_maintenance_seed(&b, &scope, 1).unwrap());
    let after: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM agent_change_log WHERE operation='session.message.index'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(after, count);
}

#[test]
fn precedes_requires_both_messages_on_current_branch() {
    let (_root, db, r, b, _scope, session) = setup();
    let mut branch = projection("older", "before");
    let mut newer = branch.messages[0].clone();
    newer.runtime_entry_id = "newer".into();
    newer.ordinal = 1;
    newer.content = json!([{"type":"text","text":"after"}]);
    branch.messages.push(newer);
    branch.checkpoint.entry_count = 2;
    branch.checkpoint.message_count = 2;
    db.agent_session_restore_projection(&r, &b, &session, &branch)
        .unwrap();
    let older_id = id(&session, "older");
    let newer_id = id(&session, "newer");
    assert!(db
        .agent_session_message_precedes(&session, &older_id, &newer_id)
        .unwrap());
    assert!(!db
        .agent_session_message_precedes(&session, &newer_id, &older_id)
        .unwrap());
    db.agent_session_restore_projection(&r, &b, &session, &projection("newer", "after"))
        .unwrap();
    assert!(!db
        .agent_session_message_precedes(&session, &older_id, &newer_id)
        .unwrap());
}

#[test]
fn policy_revision_does_not_reseed_unchanged_message() {
    let (_root, db, r, b, scope, session) = setup();
    let message_id = id(&session, "one");
    let source = key(&b, &scope, &message_id);
    db.agent_session_restore_projection(&r, &b, &session, &projection("one", "same"))
        .unwrap();
    db.conn.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES (?1,?2,'source.policy.update','policy-revision','now')",params![source,scope.key()]).unwrap();
    assert_eq!(
        db.conn
            .query_row(
                "SELECT event_revision FROM source_registry WHERE object_key=?1",
                [&source],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "policy-revision"
    );
    assert!(!db.agent_session_maintenance_seed(&b, &scope, 200).unwrap());
    assert!(!db.agent_session_maintenance_seed(&b, &scope, 200).unwrap());
    assert_eq!(event_count(&db, &source), 1);
}
