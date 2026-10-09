use super::*;
use crate::{agent::access::ScopeGrant, db::Database, source_service::SourcePolicyUpdate};

struct Fixture {
    _root: tempfile::TempDir,
    db: Database,
    conn: rusqlite::Connection,
    request: RequestContext,
    binding: WorkspaceBinding,
    scope: Scope,
}
fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("test.sqlite");
    let db = Database::open(&path, root.path(), None).unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES
         (1,'Project','workspace:project','now','now'),(2,'Other','workspace:other','now','now');
         INSERT INTO notes(id,project_id,title,created_at,updated_at) VALUES (1,1,'Record','now','now');
         INSERT INTO todos(id,scope,project_id,content,priority,created_at,updated_at)
         VALUES (1,'project',1,'Todo','normal','now','now');
         INSERT INTO documents(id,project_id,name,original_path,managed_path,storage_mode,mime_type,created_at,updated_at)
         VALUES (1,1,'File.txt','File.txt','workspace:file.txt','managed_copy','text/plain','now','now');",
    )
    .unwrap();
    let binding = WorkspaceBinding {
        workspace_id: "workspace".into(),
        generation: "generation".into(),
    };
    let request = RequestContext {
        binding: binding.clone(),
        caller: Caller::Gui,
        request_id: "discussion-target".into(),
        scope_grant: ScopeGrant {
            object_keys: None,
            workspace_id: binding.workspace_id.clone(),
            workspace_content: true,
            project_ids: vec![1, 2],
            operations: vec!["source.read".into(), "settings.write".into()],
        },
    };
    Fixture {
        _root: root,
        db,
        conn,
        request,
        binding,
        scope: Scope::Project { project_id: 1 },
    }
}
fn target(f: &Fixture, kind: ObjectKind) -> ObjectRef {
    ObjectRef {
        workspace_id: f.binding.workspace_id.clone(),
        scope: f.scope.clone(),
        kind,
        id: "1".into(),
    }
}

#[test]
fn discussion_target_start_dto_accepts_omission_and_null_without_authority_fields() {
    let data = json!({"sessionId":"a".repeat(32),"clientRequestId":"client","prompt":"Question"});
    assert!(serde_json::from_value::<StartInput>(data.clone())
        .unwrap()
        .discussion_target
        .is_none());
    let mut explicit = data.clone();
    explicit["discussionTarget"] = serde_json::Value::Null;
    assert!(serde_json::from_value::<StartInput>(explicit)
        .unwrap()
        .discussion_target
        .is_none());
    let mut selected = data;
    selected["discussionTarget"] = json!({"workspaceId":"workspace","scope":{"kind":"project","projectId":1},"kind":"record","id":"1"});
    assert!(serde_json::from_value::<StartInput>(selected.clone())
        .unwrap()
        .discussion_target
        .is_some());
    for field in ["revision", "bodyHash", "caller", "scopeGrant", "path"] {
        let mut forged = selected.clone();
        forged["discussionTarget"][field] = json!("forged");
        assert!(serde_json::from_value::<StartInput>(forged).is_err());
    }
}

#[test]
fn discussion_target_resolves_record_todo_file_and_rejects_forged_ownership() {
    let f = fixture();
    assert!(
        validate_discussion_target(&f.db, &f.request, &f.binding, &f.scope, None)
            .unwrap()
            .is_none()
    );
    for kind in [ObjectKind::Record, ObjectKind::Todo, ObjectKind::File] {
        let object = target(&f, kind);
        assert_eq!(
            validate_discussion_target(&f.db, &f.request, &f.binding, &f.scope, Some(&object))
                .unwrap(),
            Some(object.clone())
        );
        let mut forged = object.clone();
        forged.scope = Scope::Project { project_id: 2 };
        // Both projects are granted, so this checks actual ownership rather
        // than merely relying on a narrow project grant.
        assert_eq!(
            validate_discussion_target(&f.db, &f.request, &f.binding, &forged.scope, Some(&forged))
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        let mut wrong_workspace = object.clone();
        wrong_workspace.workspace_id = "other-workspace".into();
        assert_eq!(
            validate_discussion_target(
                &f.db,
                &f.request,
                &f.binding,
                &f.scope,
                Some(&wrong_workspace)
            )
            .unwrap_err()
            .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            validate_discussion_target(&f.db, &f.request, &f.binding,
                &Scope::Workspace, Some(&object)).unwrap(),
            Some(object)
        );
    }
    let other = f.db.project_record_upsert(crate::models::ProjectRecordUpsertInput {
        project_id: 2, note_id: None, title: Some("Other project".into()),
        html: "<p>Other</p>".into(), markdown: "Other".into(),
        default_code_language: None, tag_ids: vec![],
    }).unwrap();
    let other_target = ObjectRef { workspace_id: f.binding.workspace_id.clone(),
        scope: Scope::Project { project_id: 2 }, kind: ObjectKind::Record,
        id: other.id.to_string() };
    assert_eq!(validate_discussion_target(&f.db, &f.request, &f.binding,
        &f.scope, Some(&other_target)).unwrap_err().code, ErrorCode::ScopeDenied);
    assert_eq!(
        validate_discussion_target(
            &f.db,
            &f.request,
            &f.binding,
            &f.scope,
            Some(&target(&f, ObjectKind::Project))
        )
        .unwrap_err()
        .code,
        ErrorCode::InvalidArgument
    );
}

#[test]
fn discussion_target_respects_exclusion_archival_and_withdrawal() {
    let f = fixture();
    for kind in [ObjectKind::Record, ObjectKind::Todo, ObjectKind::File] {
        let object = target(&f, kind);
        let mut policy_request = f.request.clone();
        policy_request.request_id = format!("exclude-{kind:?}");
        f.db.source_policy_update(
            &policy_request,
            &f.binding,
            &SourcePolicyUpdate {
                object: object.clone(),
                expected_revision: 0,
                excluded: true,
            },
        )
        .unwrap();
        assert_eq!(
            validate_discussion_target(&f.db, &f.request, &f.binding, &f.scope, Some(&object))
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        policy_request.request_id = format!("include-{kind:?}");
        f.db.source_policy_update(
            &policy_request,
            &f.binding,
            &SourcePolicyUpdate {
                object: object.clone(),
                expected_revision: 1,
                excluded: false,
            },
        )
        .unwrap();
        f.conn
            .execute("UPDATE projects SET is_archived=1 WHERE id=1", [])
            .unwrap();
        assert_eq!(
            validate_discussion_target(&f.db, &f.request, &f.binding, &f.scope, Some(&object))
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        f.conn
            .execute("UPDATE projects SET is_archived=0 WHERE id=1", [])
            .unwrap();
        f.conn.execute(
            "INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,revision) VALUES (?1,?2,'now',1)",
            rusqlite::params![object.key().unwrap(), "a".repeat(32)],
        ).unwrap();
        assert_eq!(
            validate_discussion_target(&f.db, &f.request, &f.binding, &f.scope, Some(&object))
                .unwrap_err()
                .code,
            ErrorCode::ObjectWithdrawn
        );
    }
}
