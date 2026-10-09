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
        }.into(),
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
            [&source.raw_object().unwrap().id],
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
fn schema_34_upgrades_to_35() {
    let (root, db, _, _, _, _) = setup();
    super::super::agent_memory_schema::remove_agent_memory_schema_fixture(&db);
    db.conn.execute_batch("DROP TABLE agent_run_source_dependencies; DROP TABLE agent_run_provenance; PRAGMA user_version=34;").unwrap();
    drop(db);
    let upgraded =
        Database::open(&root.path().join("workspace.sqlite"), root.path(), None).unwrap();
    assert_eq!(upgraded.schema_version().unwrap(), super::super::CURRENT_SCHEMA_VERSION);
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

#[test]
fn memory_policy_invalidates_l0_run_proof_without_removing_original_source() {
    use crate::agent::{
        context::{ContextGetInput, EpistemicStatus, SourceCoverage},
        knowledge::{KnowledgeKind, KnowledgeNodeWrite},
        memory::{MemoryCategory, MemoryMetadata},
        models::SourceRef,
        overview::OverviewPublishInput,
        repository::ContextRepository,
    };
    use crate::db::memory_service::{MemoryAction, MemoryUpdateInput};
    let (_root, mut db, mut run, binding, _, run_id) = setup();
    db.bind_native_workspace("w").unwrap();
    run.scope_grant.operations.extend(["context.read".into(), "memory.manage".into()]);
    let todo = db.todo_create(crate::models::TodoCreateInput {
        scope: crate::models::TodoScope::Workspace, project_id: None,
        content: "Prefer concise reports".into(), priority: "normal".into(), due_date: None, tag_ids: vec![],
    }).unwrap();
    let object = ObjectRef { workspace_id: "w".into(), scope: Scope::Workspace,
        kind: ObjectKind::Todo, id: todo.id.to_string() };
    let raw = db.source_native_snapshot(&run, &binding, &crate::source_service::SourceReadTarget {
        object: object.clone(), revision: None, record_version: None, file_version: None,
    }).unwrap();
    let source = SourceRef { object: object.clone(), revision: raw.revision,
        title: "Preference evidence".into(), excerpt: String::new(), file_version: None,
        record_version: None, block_id: None, locator: None };
    let coverage = SourceCoverage { processed: 1, partial: 0, pending: 0, excluded: 0, unsupported: 0 };
    let node = KnowledgeNodeWrite {
        node_id: "memory-preference".into(), expected_revision: 0, kind: KnowledgeKind::Memory,
        memory: Some(MemoryMetadata { category: MemoryCategory::Preference,
            last_supported_at: "2026-10-09T00:00:00Z".into() }),
        title: "Report style".into(), one_line: "Prefer concise reports".into(), summary: "Concise reports".into(),
        body_sections: vec![], aliases: vec![], keywords: vec![], source_refs: vec![source],
        published_sources: vec![], epistemic_status: EpistemicStatus::Inferred,
        coverage: coverage.clone(), related: vec![], session_summary: None,
    };
    db.agent_overview_publish("gui", "memory-proof-publish", "w", &OverviewPublishInput {
        scope: Scope::Workspace, batch_id: "memory-proof".into(), expected_revision: 0,
        target_seq: db.committed_change_watermark().unwrap() as u64,
        policy_revision: 0, correction_revision: 0, expected_memory_epoch: 0,
        upsert_items: vec![], remove_item_ids: vec![], settled_object_keys: vec![],
        knowledge_upserts: vec![node], knowledge_removes: vec![], coverage,
        source_manifest_hash: "memory-proof".into(), model_profile_id: "fixture".into(),
    }, |_, _| Ok(())).unwrap();
    let repository = crate::db::agent::WorkspaceContextRepository { db: &db, workspace_name: "Workspace" };
    let identity = repository.scope_identity(&Scope::Workspace).unwrap().unwrap();
    let entry = db.agent_overview_context_entry(&run, &binding,
        &ContextGetInput { scope: Scope::Workspace, query: None, budget_chars: Some(2000) }, identity).unwrap();
    assert!(entry.nodes.iter().any(|n| n.node_id == "node:memory-preference"));
    assert!(entry.derived_sources.iter().any(|s| matches!(s.object, ObservedIdentity::Memory { .. })));
    db.agent_run_provenance_begin(&run, &binding, &entry.derived_sources).unwrap();
    assert!(db.agent_run_provenance_visible(&run, &binding, &run_id).unwrap());
    let gui = RequestContext { caller: Caller::Gui, ..run.clone() };
    db.agent_memory_update(&gui, &binding, &MemoryUpdateInput {
        scope: Scope::Workspace, node_id: "node:memory-preference".into(),
        expected_node_revision: 1, expected_policy_revision: 0,
        action: MemoryAction::Disable, correction: None,
    }).unwrap();
    assert!(db.source_read_object(&run, &binding, &object).is_ok());
    assert!(!db.agent_run_provenance_visible(&run, &binding, &run_id).unwrap());
    let stored = db.agent_run_provenance_sources(&run, &binding, &run_id).unwrap().unwrap();
    assert!(stored.iter().any(|s| s.raw_object() == Some(&object)));
    assert!(stored.iter().any(|s| matches!(s.object, ObservedIdentity::Memory { .. })));
    db.agent_memory_update(&gui, &binding, &MemoryUpdateInput {
        scope: Scope::Workspace, node_id: "node:memory-preference".into(),
        expected_node_revision: 1, expected_policy_revision: 1,
        action: MemoryAction::Reenable, correction: None,
    }).unwrap();
    // The old Run observed the old user policy. Re-enabling requires a fresh read.
    assert!(!db.agent_run_provenance_visible(&run, &binding, &run_id).unwrap());
}

#[test]
fn workspace_l0_retains_published_parent_proof_after_bounding() {
    use crate::agent::{context::{ContextGetInput, EpistemicStatus, OverviewItem, OverviewSection, SourceCoverage, ValidState},
        overview::{OverviewPublishInput, OverviewCorrectionUpsert}, repository::ContextRepository};
    let (_root, mut db, mut run, binding, _, run_id) = setup();
    db.bind_native_workspace("w").unwrap();
    let project = db.project_create(crate::models::ProjectCreateInput { name: "Parent".into(), summary: None, status: None }).unwrap();
    run.scope_grant.project_ids.push(project.id);
    run.scope_grant.operations.push("context.read".into());
    let item = |id: &str| OverviewItem { id: id.into(), section: OverviewSection::Profile,
        text: "Reusable understanding".into(), epistemic_status: EpistemicStatus::Inferred,
        source_refs: vec![], published_sources: vec![], dependency_item_ids: vec![],
        valid_state: ValidState::Current, updated_at: "now".into() };
    let publish = |scope: Scope, id: &str, items: Vec<OverviewItem>| {
        db.agent_overview_publish("gui", id, "w", &OverviewPublishInput {
            scope, batch_id: id.into(), expected_revision: 0,
            target_seq: db.committed_change_watermark().unwrap() as u64,
            policy_revision: 0, correction_revision: 0, expected_memory_epoch: 0,
            upsert_items: items, remove_item_ids: vec![], settled_object_keys: vec![],
            knowledge_upserts: vec![], knowledge_removes: vec![],
            coverage: SourceCoverage { processed: 1, partial: 0, pending: 0, excluded: 0, unsupported: 0 },
            source_manifest_hash: id.into(), model_profile_id: "fixture".into(),
        }, |_, _| Ok(())).unwrap();
    };
    let project_scope = Scope::Project { project_id: project.id };
    publish(project_scope.clone(), "parent-publish", vec![item("parent")]);
    let parent = db.agent_published_item_capture(project.id, "parent").unwrap().0;
    let mut workspace_item = item("workspace-understanding");
    workspace_item.published_sources = vec![parent];
    publish(Scope::Workspace, "workspace-publish", vec![workspace_item]);
    let repository = crate::db::agent::WorkspaceContextRepository { db: &db, workspace_name: "Workspace" };
    let identity = repository.scope_identity(&Scope::Workspace).unwrap().unwrap();
    let entry = db.agent_overview_context_entry(&run, &binding,
        &ContextGetInput { scope: Scope::Workspace, query: None, budget_chars: Some(2000) }, identity).unwrap();
    assert!(entry.positioning.is_some());
    assert!(entry.derived_sources.iter().any(|s| matches!(s.object, ObservedIdentity::Published { .. })));
    db.agent_run_provenance_begin(&run, &binding, &entry.derived_sources).unwrap();
    assert!(db.agent_run_provenance_visible(&run, &binding, &run_id).unwrap());
    db.agent_overview_correction_upsert("gui", "correct-parent", &OverviewCorrectionUpsert {
        scope: project_scope, id: "correction".into(), item_id: Some("parent".into()),
        text: "The earlier interpretation was wrong".into(), expected_revision: 0,
    }).unwrap();
    assert!(!db.agent_run_provenance_visible(&run, &binding, &run_id).unwrap());
}
