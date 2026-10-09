use super::Database;
use crate::agent::{
    access::{Caller, RequestContext, ScopeGrant},
    errors::ErrorCode,
    models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
};
use crate::db::agent_session_search::AgentSessionSearchInput;
use crate::source_service::SourcePolicyUpdate;
use rusqlite::params;

const WORKSPACE_SESSION: &str = "11111111111111111111111111111111";
const PROJECT_SESSION: &str = "22222222222222222222222222222222";
const WORKSPACE_OLD: &str = "33333333333333333333333333333333";
const PROJECT_OLD: &str = "44444444444444444444444444444444";
const PROJECT_CURRENT: &str = "55555555555555555555555555555555";

fn fixture() -> (
    tempfile::TempDir,
    Database,
    WorkspaceBinding,
    RequestContext,
) {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open(&root.path().join("app.sqlite"), root.path(), None).unwrap();
    db.conn.execute("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES (2,'Project','workspace:project','now','now')", []).unwrap();
    for (id, scope) in [
        (WORKSPACE_SESSION, "workspace"),
        (PROJECT_SESSION, "project:2"),
    ] {
        db.conn.execute("INSERT INTO agent_sessions(id,scope_key,title,runtime_id,state,session_path,created_at,updated_at) VALUES (?1,?2,'History','builtin-pi','active',?3,'now','now')", params![id,scope,format!(".project-mind/agent/sessions/{id}/session.jsonl")]).unwrap();
    }
    db.conn.execute("INSERT INTO agent_messages(id,session_id,runtime_entry_id,role,content_json,state,ordinal,created_at) VALUES (?1,?2,'current','user','\"current\"','complete',0,'now')", params![PROJECT_CURRENT,PROJECT_SESSION]).unwrap();
    for (id, session, text) in [
        (WORKSPACE_OLD, WORKSPACE_SESSION, "old workspace discussion"),
        (PROJECT_OLD, PROJECT_SESSION, "old project discussion"),
    ] {
        db.conn.execute("INSERT INTO agent_session_search_rows(message_id,session_id,runtime_entry_id,ordinal,role,created_at,text_hash,text,total_chars,complete) VALUES (?1,?2,?3,1,'user','now','sha256:test',?4,?5,1)",params![id,session,format!("old-{id}"),text,text.chars().count() as i64]).unwrap();
        db.conn
            .execute(
                "INSERT INTO agent_session_search_fts(message_id,text) VALUES (?1,?2)",
                params![id, text],
            )
            .unwrap();
    }
    let binding = WorkspaceBinding {
        workspace_id: "workspace-a".into(),
        generation: "one".into(),
    };
    let request = RequestContext {
        binding: binding.clone(),
        request_id: "policy-old-message".into(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: true,
            project_ids: vec![2],
            operations: vec![
                "source.read".into(),
                "session.read".into(),
                "settings.write".into(),
            ],
        },
    };
    (root, db, binding, request)
}

fn message(binding: &WorkspaceBinding, scope: Scope, id: &str) -> ObjectRef {
    ObjectRef {
        workspace_id: binding.workspace_id.clone(),
        scope,
        kind: ObjectKind::SessionMessage,
        id: id.into(),
    }
}

#[test]
fn session_message_resolves_current_and_historical_branch_actual_scope() {
    let (_root, db, binding, _gui) = fixture();
    for (id, expected) in [
        (PROJECT_CURRENT, Scope::Project { project_id: 2 }),
        (PROJECT_OLD, Scope::Project { project_id: 2 }),
        (WORKSPACE_OLD, Scope::Workspace),
    ] {
        let claimed = message(&binding, Scope::Workspace, id);
        assert_eq!(
            db.agent_resolve_object(&claimed, &binding.workspace_id)
                .unwrap()
                .unwrap()
                .scope,
            expected
        );
    }
    assert_eq!(
        db.conn
            .query_row(
                "SELECT count(*) FROM agent_messages WHERE id=?1",
                [PROJECT_OLD],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn session_message_rejects_forged_project_and_workspace_source_scopes() {
    let (_root, db, binding, gui) = fixture();
    for forged in [
        message(&binding, Scope::Workspace, PROJECT_OLD),
        message(&binding, Scope::Project { project_id: 2 }, WORKSPACE_OLD),
    ] {
        assert_eq!(
            db.source_read_object(&gui, &binding, &forged)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
    }
    let true_owner = message(&binding, Scope::Project { project_id: 2 }, PROJECT_OLD);
    assert_eq!(
        db.source_read_object(&gui, &binding, &true_owner).unwrap(),
        true_owner
    );
    let mut without_session_read = gui.clone();
    without_session_read
        .scope_grant
        .operations
        .retain(|operation| operation != "session.read");
    assert_eq!(
        db.source_read_object(&without_session_read, &binding, &true_owner)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
}

#[test]
fn excluded_session_message_blocks_ai_source_but_remains_in_gui_history() {
    let (_root, db, binding, gui) = fixture();
    let object = message(&binding, Scope::Project { project_id: 2 }, PROJECT_OLD);
    let ai = RequestContext {
        caller: Caller::BuiltinRun {
            run_id: "run-1".into(),
        },
        request_id: "ai-read".into(),
        ..gui.clone()
    };
    assert_eq!(
        db.source_read_object(&ai, &binding, &object).unwrap(),
        object
    );
    db.source_policy_update(
        &gui,
        &binding,
        &SourcePolicyUpdate {
            object: object.clone(),
            expected_revision: 0,
            excluded: true,
        },
    )
    .unwrap();
    assert_eq!(
        db.source_read_object(&ai, &binding, &object)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    let history = db
        .agent_session_search(
            &gui,
            &binding,
            &AgentSessionSearchInput {
                scope: Scope::Project { project_id: 2 },
                session_id: Some(PROJECT_SESSION.into()),
                query: "old project".into(),
                after_message_id: None,
                limit: 10,
            },
        )
        .unwrap();
    assert_eq!(
        history
            .matches
            .iter()
            .map(|hit| hit.message_id.as_str())
            .collect::<Vec<_>>(),
        vec![PROJECT_OLD]
    );
}

#[test]
fn deleted_session_messages_no_longer_resolve() {
    let (_root, db, binding, gui) = fixture();
    let old = message(&binding, Scope::Project { project_id: 2 }, PROJECT_OLD);
    let current = message(&binding, Scope::Project { project_id: 2 }, PROJECT_CURRENT);
    db.conn
        .execute("DELETE FROM agent_sessions WHERE id=?1", [PROJECT_SESSION])
        .unwrap();
    for object in [&old, &current] {
        assert_eq!(
            db.agent_resolve_object(object, &binding.workspace_id)
                .unwrap(),
            None
        );
        assert_eq!(
            db.source_read_object(&gui, &binding, object)
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
    }
}
