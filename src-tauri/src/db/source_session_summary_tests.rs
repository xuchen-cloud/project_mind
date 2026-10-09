use super::*;
use crate::{
    agent::{
        access::{Caller, RequestContext, ScopeGrant},
        context::{EpistemicStatus, SourceCoverage},
        knowledge::KnowledgeNodeWrite,
        models::{ObjectKind, ObjectRef, Scope, SourceLocator, SourceRef, WorkspaceBinding},
        sessions::SessionSummarySegment,
    },
    committed_changes::{CommittedChangePublisher, CommittedChanges},
    models::ProjectCreateInput,
    source_service::{
        BoundSourceStore, SourceReadInput, SourceReadTarget, SourceReadView, SourceSearchInput,
        SourceService,
    },
    source_session_summary::{read, search, superseded_by},
};
use rusqlite::params;
use sha2::{Digest, Sha256};

struct Store {
    db: Database,
    binding: WorkspaceBinding,
}
impl CommittedChangePublisher for Store {
    fn publish_committed(&self, _: CommittedChanges) {}
}
impl BoundSourceStore for Store {
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        action(&self.binding, &self.db)
    }
}
fn fixture() -> (
    tempfile::TempDir,
    Store,
    RequestContext,
    Scope,
    String,
    String,
) {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open(&root.path().join("summary.sqlite"), root.path(), None).unwrap();
    let project = db
        .project_create(ProjectCreateInput {
            name: "Summary".into(),
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
        caller: Caller::Connection {
            grant_id: "test".into(),
        },
        request_id: "test".into(),
        scope_grant: ScopeGrant {
            workspace_id: "w".into(),
            workspace_content: false,
            project_ids: vec![project.id],
            operations: vec!["source.read".into(), "session.read".into()],
        },
    };
    let session = "11111111111111111111111111111111".to_string();
    let message = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string();
    db.conn.execute("INSERT INTO agent_sessions(id,scope_key,title,runtime_id,state,session_path,checkpoint_json,created_at,updated_at) VALUES (?1,?2,'Discussion','builtin-pi','active',?3,'{\"checksum\":\"sha256:a\"}','now','now')", params![session, scope.key(), format!(".project-mind/agent/sessions/{session}/session.jsonl")]).unwrap();
    let hash = format!("sha256:{:x}", Sha256::digest("讨论".as_bytes()));
    db.conn.execute("INSERT INTO agent_session_search_rows(message_id,session_id,runtime_entry_id,ordinal,role,created_at,text_hash,text,total_chars,complete) VALUES (?1,?2,'entry',0,'user','now',?3,'讨论',2,1)", params![message, session, hash]).unwrap();
    db.agent_knowledge_prepare().unwrap();
    let message_source = SourceRef {
        object: ObjectRef {
            workspace_id: "w".into(),
            scope: scope.clone(),
            kind: ObjectKind::SessionMessage,
            id: message.clone(),
        },
        revision: hash,
        file_version: None,
        record_version: None,
        block_id: None,
        locator: Some(SourceLocator::Messages {
            session_id: session.clone(),
            branch_id: "entry".into(),
            start_message_id: message.clone(),
            end_message_id: message.clone(),
        }),
        title: "讨论".into(),
        excerpt: "讨论".into(),
    };
    let summary = "关于权限管理的讨论。".repeat(210);
    let draft = KnowledgeNodeWrite {
        node_id: "segment-one".into(),
        expected_revision: 0,
        kind: KnowledgeKind::SourceSummary,
        title: "权限管理讨论".into(),
        one_line: "计划与决定".into(),
        summary: summary.clone(),
        body_sections: vec![],
        aliases: vec![],
        keywords: vec!["权限".into()],
        source_refs: vec![message_source],
        epistemic_status: EpistemicStatus::Recorded,
        coverage: SourceCoverage {
            processed: 1,
            partial: 0,
            excluded: 0,
            unsupported: 0,
            pending: 0,
        },
        related: vec![],
        session_summary: Some(SessionSummarySegment {
            id: "segment-one".into(),
            session_id: session.clone(),
            branch_id: "entry".into(),
            revision: 1,
            start_entry_id: "entry".into(),
            end_entry_id: "entry".into(),
            start_char: None,
            end_char: None,
            summary,
            topics: vec!["权限".into()],
            statements: vec![],
            artifact_refs: vec![],
            supersedes: vec![],
            input_hash: format!("sha256:{}", "a".repeat(64)),
        }),
    };
    draft.validate(&scope).unwrap();
    let snapshot = draft.snapshot(&scope, "now".into());
    db.conn.execute("INSERT INTO agent_knowledge_nodes(scope_key,node_id,current_revision,kind,deleted,updated_at) VALUES (?1,'segment-one',1,'source_summary',0,'now')", [scope.key()]).unwrap();
    db.conn.execute("INSERT INTO agent_knowledge_versions(scope_key,node_id,revision,overview_revision,snapshot_json,created_at) VALUES (?1,'segment-one',1,1,?2,'now')", params![scope.key(), serde_json::to_string(&snapshot).unwrap()]).unwrap();
    db.conn.execute("INSERT INTO agent_knowledge_fts(scope_key,node_id,title,aliases,keywords,one_line) VALUES (?1,'segment-one','权限管理讨论','','权限','计划与决定')", [scope.key()]).unwrap();
    (
        root,
        Store { db, binding },
        request,
        scope,
        session,
        message,
    )
}
fn query(scope: Scope, q: &str) -> SourceSearchInput {
    SourceSearchInput {
        scope,
        query: q.into(),
        kinds: vec![ObjectKind::SessionSummary],
        selected: vec![],
        include_history: false,
        limit: Some(8),
        budget_chars: Some(12000),
    }
}
fn target(scope: Scope) -> SourceReadInput {
    SourceReadInput {
        source: SourceReadTarget {
            object: ObjectRef {
                workspace_id: "w".into(),
                scope,
                kind: ObjectKind::SessionSummary,
                id: "segment-one".into(),
            },
            revision: Some("1".into()),
            record_version: None,
            file_version: None,
        },
        view: SourceReadView::Full,
        selection: None,
        cursor: None,
        budget_chars: Some(2400),
    }
}
#[test]
fn chinese_short_word_search_and_fixed_revision_paging() {
    let (_root, store, request, scope, _, _) = fixture();
    let page = search(
        &store.db,
        &request,
        &store.binding,
        &query(scope.clone(), "权限"),
    )
    .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].source_ref.revision, "1");
    assert!(
        matches!(&page.items[0].source_ref.locator, Some(SourceLocator::Messages { start_message_id, end_message_id, .. }) if start_message_id == end_message_id)
    );
    let mut input = target(scope);
    let mut full = String::new();
    let mut pages = 0;
    loop {
        let page = read(&store, &request, &input).unwrap();
        assert!(crate::agent::context::serialized_chars(&page).unwrap() <= 2400);
        full.push_str(&page.text);
        pages += 1;
        input.cursor = page.next_cursor;
        if input.cursor.is_none() {
            break;
        }
        assert!(pages < 20);
    }
    assert!(pages > 1);
    let value: serde_json::Value = serde_json::from_str(&full).unwrap();
    assert_eq!(
        value["sessionId"].as_str(),
        Some("11111111111111111111111111111111")
    );
}
#[test]
fn session_grant_and_original_message_exclusion_hide_current_and_old_summary() {
    let (_root, store, mut request, scope, _, message) = fixture();
    request
        .scope_grant
        .operations
        .retain(|op| op != "session.read");
    assert_eq!(
        search(
            &store.db,
            &request,
            &store.binding,
            &query(scope.clone(), "权限")
        )
        .err()
        .unwrap()
        .code,
        ErrorCode::ScopeDenied
    );
    assert_eq!(
        read(&store, &request, &target(scope.clone()))
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    request.scope_grant.operations.push("session.read".into());
    assert_eq!(
        search(
            &store.db,
            &request,
            &store.binding,
            &query(scope.clone(), "权限")
        )
        .unwrap()
        .items
        .len(),
        1
    );
    let mut newer = store
        .db
        .agent_knowledge_get(&scope, "segment-one", Some(1))
        .unwrap()
        .unwrap();
    newer.revision = 2;
    newer.session_summary.as_mut().unwrap().revision = 2;
    store.db.conn.execute("INSERT INTO agent_knowledge_versions(scope_key,node_id,revision,overview_revision,snapshot_json,created_at) VALUES (?1,'segment-one',2,2,?2,'later')", params![scope.key(), serde_json::to_string(&newer).unwrap()]).unwrap();
    store.db.conn.execute("UPDATE agent_knowledge_nodes SET current_revision=2 WHERE scope_key=?1 AND node_id='segment-one'", [scope.key()]).unwrap();
    let message = ObjectRef {
        workspace_id: "w".into(),
        scope: scope.clone(),
        kind: ObjectKind::SessionMessage,
        id: message,
    };
    store
        .db
        .conn
        .execute(
            "INSERT INTO source_access_policies(object_key,excluded,revision) VALUES (?1,1,1)",
            [message.key().unwrap()],
        )
        .unwrap();
    assert!(search(
        &store.db,
        &request,
        &store.binding,
        &query(scope.clone(), "权限")
    )
    .unwrap()
    .items
    .is_empty());
    assert_eq!(
        read(&store, &request, &target(scope)).unwrap_err().code,
        ErrorCode::ScopeDenied
    );
}

#[test]
fn summary_policy_and_selected_scope_are_enforced() {
    let (_root, store, request, scope, _, _) = fixture();
    let mut selected = query(scope.clone(), "权限");
    selected.selected.push(ObjectRef {
        workspace_id: "w".into(),
        scope: Scope::Workspace,
        kind: ObjectKind::SessionSummary,
        id: "segment-one".into(),
    });
    assert_eq!(
        search(&store.db, &request, &store.binding, &selected)
            .err()
            .unwrap()
            .code,
        ErrorCode::ScopeDenied
    );
    assert_eq!(
        search(
            &store.db,
            &request,
            &store.binding,
            &query(scope.clone(), "权限")
        )
        .unwrap()
        .items
        .len(),
        1
    );
    let summary = ObjectRef {
        workspace_id: "w".into(),
        scope: scope.clone(),
        kind: ObjectKind::SessionSummary,
        id: "segment-one".into(),
    };
    store
        .db
        .conn
        .execute(
            "INSERT INTO source_access_policies(object_key,excluded,revision) VALUES (?1,1,1)",
            [summary.key().unwrap()],
        )
        .unwrap();
    assert!(search(
        &store.db,
        &request,
        &store.binding,
        &query(scope.clone(), "权限")
    )
    .unwrap()
    .items
    .is_empty());
    assert_eq!(
        read(&store, &request, &target(scope)).unwrap_err().code,
        ErrorCode::ScopeDenied
    );
}

#[tokio::test]
async fn default_source_search_includes_authorized_summary_and_skips_it_without_session_grant() {
    let (_root, store, mut request, scope, _, _) = fixture();
    let mut input = query(scope, "权限");
    input.kinds.clear();
    let service = SourceService::new(&store);
    let page = service.search(&request, &input).await.unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(
        page.items[0].source_ref.object.kind,
        ObjectKind::SessionSummary
    );
    request
        .scope_grant
        .operations
        .retain(|op| op != "session.read");
    assert!(service
        .search(&request, &input)
        .await
        .unwrap()
        .items
        .is_empty());
}

#[test]
fn successor_marks_old_summary_only_when_successor_is_visible() {
    let (_root, store, request, scope, _, _) = fixture();
    let mut successor = store
        .db
        .agent_knowledge_get(&scope, "segment-one", None)
        .unwrap()
        .unwrap();
    successor.node_id = "segment-two".into();
    successor.session_summary.as_mut().unwrap().id = "segment-two".into();
    successor.session_summary.as_mut().unwrap().supersedes = vec!["segment-one".into()];
    store.db.conn.execute("INSERT INTO agent_knowledge_nodes(scope_key,node_id,current_revision,kind,deleted,updated_at) VALUES (?1,'segment-two',1,'source_summary',0,'now')", [scope.key()]).unwrap();
    store.db.conn.execute("INSERT INTO agent_knowledge_versions(scope_key,node_id,revision,overview_revision,snapshot_json,created_at) VALUES (?1,'segment-two',1,1,?2,'now')", params![scope.key(), serde_json::to_string(&successor).unwrap()]).unwrap();
    let old = store
        .db
        .agent_knowledge_get(&scope, "segment-one", None)
        .unwrap()
        .unwrap();
    assert_eq!(
        superseded_by(&store.db, &request, &store.binding, &old).unwrap()[0].node_id,
        "segment-two"
    );
    let mut full_input = target(scope.clone());
    full_input.budget_chars = Some(12000);
    let read_old = read(&store, &request, &full_input).unwrap();
    let body: serde_json::Value = serde_json::from_str(&read_old.text).unwrap();
    assert_eq!(
        body["supersededBy"][0]["nodeId"].as_str(),
        Some("segment-two")
    );
    let found = search(
        &store.db,
        &request,
        &store.binding,
        &query(scope.clone(), "权限"),
    )
    .unwrap();
    assert!(found.items[0].excerpt.starts_with("历史结论（已替代）："));
    let mut paged = target(scope.clone());
    let first = read(&store, &request, &paged).unwrap();
    paged.cursor = first.next_cursor;
    assert!(paged.cursor.is_some());
    let hidden = ObjectRef {
        workspace_id: "w".into(),
        scope: scope.clone(),
        kind: ObjectKind::SessionSummary,
        id: "segment-two".into(),
    };
    store
        .db
        .conn
        .execute(
            "INSERT INTO source_access_policies(object_key,excluded,revision) VALUES (?1,1,1)",
            [hidden.key().unwrap()],
        )
        .unwrap();
    assert_eq!(
        read(&store, &request, &paged).unwrap_err().code,
        ErrorCode::SourceChanged
    );
    assert!(superseded_by(&store.db, &request, &store.binding, &old)
        .unwrap()
        .is_empty());
    let read_old = read(&store, &request, &full_input).unwrap();
    let body: serde_json::Value = serde_json::from_str(&read_old.text).unwrap();
    assert!(body["supersededBy"].as_array().unwrap().is_empty());
    assert!(!read_old.text.contains("segment-two"));
}
