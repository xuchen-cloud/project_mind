use super::*;
use crate::agent::{access::ScopeGrant, conversation::RunPreparation};
use serde_json::json;

fn setup() -> (
    tempfile::TempDir,
    Database,
    RequestContext,
    WorkspaceBinding,
    String,
    String,
) {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open(&root.path().join("workspace.sqlite"), root.path(), None).unwrap();
    let binding = WorkspaceBinding {
        workspace_id: "w".into(),
        generation: "g".into(),
    };
    let gui = RequestContext {
        binding: binding.clone(),
        request_id: "gui".into(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            object_keys: None,
            workspace_id: "w".into(),
            workspace_content: true,
            project_ids: vec![],
            operations: ["session.read", "session.write", "run.start", "source.read"]
                .map(str::to_owned)
                .to_vec(),
        },
    };
    let session = db
        .agent_session_create(
            &gui,
            &binding,
            &Scope::Workspace,
            "Conversation",
            "pi",
            None,
        )
        .unwrap();
    let run_id = "a".repeat(32);
    db.agent_run_prepare(
        &gui,
        &binding,
        &session.id,
        "first",
        &RunPreparation {
            run_id: run_id.clone(),
            context_manifest: json!({}),
        },
    )
    .unwrap();
    let run = RequestContext {
        caller: Caller::BuiltinRun {
            run_id: run_id.clone(),
        },
        request_id: "run".into(),
        ..gui
    };
    (root, db, run, binding, session.id, run_id)
}
fn message(
    db: &Database,
    session: &str,
    id: &str,
    role: &str,
    run: Option<&str>,
    ordinal: i64,
) -> ObservedSource {
    db.conn.execute("INSERT INTO agent_messages(id,session_id,run_id,runtime_entry_id,role,content_json,state,ordinal,created_at) VALUES (?1,?2,?3,?4,?5,'{}','complete',?6,'now')",params![id,session,run,format!("entry-{ordinal}"),role,ordinal]).unwrap();
    ObservedSource {
        object: ObjectRef {
            workspace_id: "w".into(),
            scope: Scope::Workspace,
            kind: ObjectKind::SessionMessage,
            id: id.into(),
        },
        revision: None,
    }
}
#[test]
fn begin_is_owned_idempotent_and_exclusion_hides_run() {
    let (_root, db, run, binding, session, run_id) = setup();
    let source = message(&db, &session, &"b".repeat(32), "user", None, 0);
    db.agent_run_provenance_begin(&run, &binding, std::slice::from_ref(&source))
        .unwrap();
    db.agent_run_provenance_begin(&run, &binding, &[]).unwrap();
    assert_eq!(
        db.agent_run_provenance_sources(&run, &binding, &run_id)
            .unwrap(),
        Some(vec![source.clone()])
    );
    let mut alien = run.clone();
    alien.caller = Caller::Gui;
    assert_eq!(
        db.agent_run_provenance_observe(&alien, &binding, &[])
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    db.conn
        .execute(
            "INSERT INTO source_access_policies(object_key,excluded,revision) VALUES (?1,1,1)",
            [source.object.key().unwrap()],
        )
        .unwrap();
    assert!(!db
        .agent_run_provenance_visible(&run, &binding, &run_id)
        .unwrap());
    assert_eq!(
        db.agent_run_context_check(&run, &binding, &["entry-0".into(), "entry-1".into()])
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    db.conn
        .execute("DELETE FROM source_access_policies", [])
        .unwrap();
    db.conn
        .execute(
            "DELETE FROM agent_messages WHERE id=?1",
            [&source.object.id],
        )
        .unwrap();
    assert!(!db
        .agent_run_provenance_visible(&run, &binding, &run_id)
        .unwrap());
}
#[test]
fn legacy_assistant_is_omitted_and_legacy_user_retained() {
    let (_root, db, run, binding, session, _run_id) = setup();
    let _user = message(&db, &session, &"b".repeat(32), "user", None, 0);
    let _assistant = message(&db, &session, &"c".repeat(32), "assistant", None, 1);
    db.agent_run_provenance_begin(&run, &binding, &[]).unwrap();
    assert_eq!(
        db.agent_run_context_check(&run, &binding, &["entry-0".into(), "entry-1".into()])
            .unwrap(),
        vec!["entry-0"]
    );
    assert_eq!(
        db.agent_run_provenance_sources(&run, &binding, &"a".repeat(32))
            .unwrap()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn historical_dependencies_are_copied_and_cascade_with_session() {
    let (_root, db, run, binding, session, run_id) = setup();
    let prior = "d".repeat(32);
    db.conn.execute("INSERT INTO agent_runs(id,session_id,client_request_id,state,context_manifest_json,grant_json,started_at) VALUES (?1,?2,'old','completed','{}','{}','now')",params![prior,session]).unwrap();
    let source = message(&db, &session, &"b".repeat(32), "user", None, 0);
    let answer = message(&db, &session, &"c".repeat(32), "assistant", Some(&prior), 1);
    db.conn
        .execute(
            "INSERT INTO agent_run_provenance(run_id) VALUES (?1)",
            [&prior],
        )
        .unwrap();
    db.conn.execute("INSERT INTO agent_run_source_dependencies(run_id,object_key,object_json,revision) VALUES (?1,?2,?3,'')",params![prior,source.object.key().unwrap(),serde_json::to_string(&source.object).unwrap()]).unwrap();
    db.agent_run_provenance_begin(&run, &binding, &[]).unwrap();
    assert_eq!(
        db.agent_run_context_check(&run, &binding, &["entry-0".into(), "entry-1".into()])
            .unwrap(),
        vec!["entry-0", "entry-1"]
    );
    let inherited = db
        .agent_run_provenance_sources(&run, &binding, &run_id)
        .unwrap()
        .unwrap();
    assert!(inherited.contains(&source));
    assert!(inherited.contains(&answer));
    db.conn
        .execute(
            "INSERT INTO source_access_policies(object_key,excluded,revision) VALUES (?1,1,1)",
            [source.object.key().unwrap()],
        )
        .unwrap();
    assert!(!db
        .agent_run_provenance_visible(&run, &binding, &run_id)
        .unwrap());
    assert_eq!(
        db.agent_run_context_check(&run, &binding, &["entry-0".into(), "entry-1".into()])
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    db.conn
        .execute("DELETE FROM agent_sessions WHERE id=?1", [session])
        .unwrap();
    let count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM agent_run_source_dependencies",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}
#[test]
fn schema_reopens_at_35() {
    let (root, db, _, _, _, _) = setup();
    assert_eq!(db.schema_version().unwrap(), 35);
    drop(db);
    let reopened =
        Database::open(&root.path().join("workspace.sqlite"), root.path(), None).unwrap();
    assert_eq!(reopened.schema_version().unwrap(), 35);
}

#[test]
fn schema_34_upgrades_to_35() {
    let (root, db, _, _, _, _) = setup();
    db.conn.execute_batch("DROP TABLE agent_run_source_dependencies; DROP TABLE agent_run_provenance; PRAGMA user_version=34;").unwrap();
    drop(db);
    let upgraded =
        Database::open(&root.path().join("workspace.sqlite"), root.path(), None).unwrap();
    assert_eq!(upgraded.schema_version().unwrap(), 35);
    assert!(upgraded.table_exists("agent_run_provenance").unwrap());
}

#[test]
fn candidate_subset_only_inherits_read_history() {
    let (_root, db, run, binding, session, run_id) = setup();
    let prior = "d".repeat(32);
    db.conn.execute("INSERT INTO agent_runs(id,session_id,client_request_id,state,context_manifest_json,grant_json,started_at) VALUES (?1,?2,'old','completed','{}','{}','now')",params![prior,session]).unwrap();
    let first = message(&db, &session, &"b".repeat(32), "user", None, 0);
    let unread = message(&db, &session, &"c".repeat(32), "user", None, 1);
    let _answer = message(&db, &session, &"e".repeat(32), "assistant", Some(&prior), 2);
    db.conn
        .execute(
            "INSERT INTO agent_run_provenance(run_id) VALUES (?1)",
            [&prior],
        )
        .unwrap();
    db.conn.execute("INSERT INTO agent_run_source_dependencies(run_id,object_key,object_json,revision) VALUES (?1,?2,?3,'')",params![prior,unread.object.key().unwrap(),serde_json::to_string(&unread.object).unwrap()]).unwrap();
    db.agent_run_provenance_begin(&run, &binding, &[]).unwrap();
    assert_eq!(
        db.agent_run_context_check(
            &run,
            &binding,
            &["entry-0".into(), "unknown".into(), "entry-0".into()]
        )
        .unwrap(),
        vec!["entry-0"]
    );
    assert_eq!(
        db.agent_run_provenance_sources(&run, &binding, &run_id)
            .unwrap(),
        Some(vec![first])
    );
    db.conn
        .execute(
            "INSERT INTO source_access_policies(object_key,excluded,revision) VALUES (?1,1,1)",
            [unread.object.key().unwrap()],
        )
        .unwrap();
    assert!(db
        .agent_run_provenance_visible(&run, &binding, &run_id)
        .unwrap());
}

#[test]
fn excluded_tool_message_is_omitted_without_inheritance() {
    let (_root, db, run, binding, session, run_id) = setup();
    let prior = "d".repeat(32);
    db.conn.execute("INSERT INTO agent_runs(id,session_id,client_request_id,state,context_manifest_json,grant_json,started_at) VALUES (?1,?2,'old','completed','{}','{}','now')",params![prior,session]).unwrap();
    let resource = message(&db, &session, &"b".repeat(32), "user", None, 0);
    let tool = message(&db, &session, &"c".repeat(32), "tool", Some(&prior), 1);
    db.conn
        .execute(
            "INSERT INTO agent_run_provenance(run_id) VALUES (?1)",
            [&prior],
        )
        .unwrap();
    db.conn.execute("INSERT INTO agent_run_source_dependencies(run_id,object_key,object_json,revision) VALUES (?1,?2,?3,'')",params![prior,resource.object.key().unwrap(),serde_json::to_string(&resource.object).unwrap()]).unwrap();
    db.conn
        .execute(
            "INSERT INTO source_access_policies(object_key,excluded,revision) VALUES (?1,1,1)",
            [tool.object.key().unwrap()],
        )
        .unwrap();
    db.agent_run_provenance_begin(&run, &binding, &[]).unwrap();
    assert!(db
        .agent_run_context_check(&run, &binding, &["entry-1".into()])
        .unwrap()
        .is_empty());
    assert!(db
        .agent_run_provenance_sources(&run, &binding, &run_id)
        .unwrap()
        .unwrap()
        .is_empty());
}
