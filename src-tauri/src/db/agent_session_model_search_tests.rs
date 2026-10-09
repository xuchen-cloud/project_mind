use super::*;
use crate::agent::access::ScopeGrant;
use rusqlite::params;
use sha2::Digest;

const SESSION: &str = "11111111111111111111111111111111";
const OTHER: &str = "22222222222222222222222222222222";

fn fixture() -> (
    tempfile::TempDir,
    Database,
    RequestContext,
    WorkspaceBinding,
) {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
    let binding = WorkspaceBinding {
        workspace_id: "w".into(),
        generation: "g".into(),
    };
    let request = RequestContext {
        binding: binding.clone(),
        caller: Caller::Connection {
            grant_id: "test".into(),
        },
        request_id: "test".into(),
        scope_grant: ScopeGrant {
            object_keys: None,
            workspace_id: "w".into(),
            workspace_content: true,
            project_ids: vec![2],
            operations: vec!["session.read".into()],
        },
    };
    for (id, scope) in [(SESSION, "workspace"), (OTHER, "project:2")] {
        db.conn.execute("INSERT INTO agent_sessions(id,scope_key,title,runtime_id,state,session_path,checkpoint_json,created_at,updated_at) VALUES (?1,?2,'SECRET TITLE','builtin-pi','active',?3,?4,'now','now')",params![id,scope,format!(".project-mind/agent/sessions/{id}/session.jsonl"),r#"{"checksum":"sha256:a"}"#]).unwrap();
        db.conn.execute("INSERT INTO agent_session_scan_state(session_id,checksum,entry_count,complete) VALUES (?1,'sha256:a',1,1)",[id]).unwrap();
    }
    (root, db, request, binding)
}
fn insert(
    db: &Database,
    session: &str,
    id: &str,
    entry: &str,
    role: &str,
    run: Option<&str>,
    text: &str,
) {
    db.conn.execute("INSERT INTO agent_session_search_rows(message_id,session_id,runtime_entry_id,ordinal,role,created_at,run_id,text_hash,text,total_chars,complete) VALUES (?1,?2,?3,0,?4,'now',?5,?6,?7,?8,1)",params![id,session,entry,role,run,format!("sha256:{:x}",sha2::Sha256::digest(text.as_bytes())),text,text.chars().count() as i64]).unwrap();
    db.conn
        .execute(
            "INSERT INTO agent_session_search_fts(message_id,text) VALUES (?1,?2)",
            params![id, text],
        )
        .unwrap();
}
fn input(scope: Scope) -> ModelHistorySearchInput {
    ModelHistorySearchInput {
        scope,
        query: "讨论".into(),
        session_id: None,
        after_message_id: None,
        limit: 8,
        budget_chars: 4000,
    }
}

#[test]
fn scope_grant_and_cursor_cannot_cross_project() {
    let (_root, db, mut request, binding) = fixture();
    let w = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let p = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    insert(&db, SESSION, w, "old-user", "user", None, "中文讨论");
    insert(&db, OTHER, p, "project-user", "user", None, "项目讨论");
    let result = db
        .agent_model_session_search(&request, &binding, &input(Scope::Workspace))
        .unwrap();
    assert_eq!(result.matches.len(), 1);
    assert_eq!(result.matches[0].source_ref.title, "历史讨论");
    assert!(!serde_json::to_string(&result)
        .unwrap()
        .contains("SECRET TITLE"));
    let mut bad = input(Scope::Workspace);
    bad.after_message_id = Some(p.into());
    assert_eq!(
        db.agent_model_session_search(&request, &binding, &bad)
            .unwrap_err()
            .code,
        ErrorCode::InvalidArgument
    );
    request.scope_grant.operations.clear();
    assert_eq!(
        db.agent_model_session_search(&request, &binding, &input(Scope::Workspace))
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    request.scope_grant.operations.push("session.read".into());
    request.scope_grant.project_ids.clear();
    assert_eq!(
        db.agent_model_session_search(&request, &binding, &input(Scope::Project { project_id: 2 }))
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
}

#[test]
fn changed_workspace_binding_is_rejected() {
    let (_root, db, mut request, binding) = fixture();
    request.binding.generation = "other".into();
    assert_eq!(
        db.agent_model_session_search(&request, &binding, &input(Scope::Workspace))
            .unwrap_err()
            .code,
        ErrorCode::WorkspaceChanged
    );
}

#[test]
fn excluded_user_and_unknown_assistant_are_hidden_but_legacy_user_remains() {
    let (_root, db, mut request, binding) = fixture();
    let user = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let assistant = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    insert(
        &db,
        SESSION,
        user,
        "old-branch-user",
        "user",
        None,
        "中文讨论用户",
    );
    insert(
        &db,
        SESSION,
        assistant,
        "old-branch-assistant",
        "assistant",
        None,
        "中文讨论助手",
    );
    let page = db
        .agent_model_session_search(&request, &binding, &input(Scope::Workspace))
        .unwrap();
    assert_eq!(page.matches.len(), 1);
    assert!(page.coverage.complete);
    assert!(page.coverage.has_unavailable_history);
    request.scope_grant.operations.push("source.read".into());
    let assistant_target = crate::source_service::SourceReadTarget {
        object: ObjectRef {
            workspace_id: "w".into(),
            scope: Scope::Workspace,
            kind: ObjectKind::SessionMessage,
            id: assistant.into(),
        },
        revision: None,
        record_version: None,
        file_version: None,
    };
    assert_eq!(
        db.source_session_record(&request, &binding, &assistant_target)
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    assert_eq!(
        page.matches[0]
            .source_ref
            .locator
            .as_ref()
            .and_then(|v| match v {
                SourceLocator::Messages { branch_id, .. } => Some(branch_id.as_str()),
                _ => None,
            }),
        Some("old-branch-user")
    );
    let key = page.matches[0].source_ref.object.key().unwrap();
    db.conn
        .execute(
            "INSERT INTO source_access_policies(object_key,excluded,revision) VALUES (?1,1,1)",
            [key],
        )
        .unwrap();
    assert!(db
        .agent_model_session_search(&request, &binding, &input(Scope::Workspace))
        .unwrap()
        .matches
        .is_empty());
    assert_eq!(
        db.agent_model_session_message_record(&request, &binding, SESSION, user)
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
}

#[test]
fn paging_budget_and_deletion() {
    let (_root, db, request, binding) = fixture();
    let a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    insert(&db, SESSION, a, "old-a", "user", None, "中文讨论一");
    insert(&db, SESSION, b, "old-b", "user", None, "中文讨论二");
    let mut q = input(Scope::Workspace);
    q.limit = 1;
    let first = db
        .agent_model_session_search(&request, &binding, &q)
        .unwrap();
    assert_eq!(first.matches.len(), 1);
    assert_eq!(first.next_cursor.as_deref(), Some(a));
    q.after_message_id = first.next_cursor;
    let second = db
        .agent_model_session_search(&request, &binding, &q)
        .unwrap();
    assert_eq!(second.matches[0].message_id, b);
    q.budget_chars = 1;
    assert_eq!(
        db.agent_model_session_search(&request, &binding, &q)
            .unwrap_err()
            .code,
        ErrorCode::BudgetExceeded
    );
    db.conn
        .execute("DELETE FROM agent_sessions WHERE id=?1", [SESSION])
        .unwrap();
    assert_eq!(
        db.agent_model_session_message_record(&request, &binding, SESSION, b)
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
}

#[test]
fn assistant_inherits_recorded_run_source_exclusion() {
    let (_root, db, request, binding) = fixture();
    let user = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let answer = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let run = "cccccccccccccccccccccccccccccccc";
    insert(
        &db,
        SESSION,
        user,
        "prior-user",
        "user",
        None,
        "中文讨论提问",
    );
    db.conn.execute("INSERT INTO agent_runs(id,session_id,client_request_id,state,context_manifest_json,grant_json,started_at) VALUES (?1,?2,'old','completed','{}','{}','now')",params![run,SESSION]).unwrap();
    insert(
        &db,
        SESSION,
        answer,
        "prior-answer",
        "assistant",
        Some(run),
        "中文讨论回答",
    );
    let source = db
        .agent_model_session_message_record(&request, &binding, SESSION, user)
        .unwrap()
        .source_ref(&binding);
    db.conn
        .execute(
            "INSERT INTO agent_run_provenance(run_id) VALUES (?1)",
            [run],
        )
        .unwrap();
    db.conn.execute("INSERT INTO agent_run_source_dependencies(run_id,object_key,object_json,revision) VALUES (?1,?2,?3,'')",params![run,source.object.key().unwrap(),serde_json::to_string(&source.object).unwrap()]).unwrap();
    assert_eq!(
        db.agent_model_session_search(&request, &binding, &input(Scope::Workspace))
            .unwrap()
            .matches
            .len(),
        2
    );
    db.conn
        .execute(
            "INSERT INTO source_access_policies(object_key,excluded,revision) VALUES (?1,1,1)",
            [source.object.key().unwrap()],
        )
        .unwrap();
    assert!(db
        .agent_model_session_search(&request, &binding, &input(Scope::Workspace))
        .unwrap()
        .matches
        .is_empty());
}
