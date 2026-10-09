use super::*;
use crate::agent::{
    access::{Caller, ScopeGrant},
    models::{ObjectKind, ObjectRef},
};
use serde_json::json;

#[test]
fn knowledge_namespaces_use_immutable_revision_and_overview_dependency_closure() {
    use crate::{
        agent::{
            context::{EpistemicStatus, OverviewItem, OverviewSection, SourceCoverage, ValidState},
            knowledge::{KnowledgeBodySection, KnowledgeKind, KnowledgeNodeWrite},
            models::SourceRef,
            overview::OverviewPublishInput,
        },
        models::{ProjectCreateInput, TodoCreateInput, TodoScope},
        source_service::SourceReadTarget,
    };
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(
        &root.path().join("knowledge-trace.sqlite"),
        root.path(),
        None,
    )
    .unwrap();
    db.bind_native_workspace("w").unwrap();
    let project = db
        .project_create(ProjectCreateInput {
            name: "trace".into(),
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
        request_id: "trace".into(),
        scope_grant: ScopeGrant {
            object_keys: None,
            workspace_id: "w".into(),
            workspace_content: false,
            project_ids: vec![project.id],
            operations: vec!["source.read".into()],
        },
    };
    let mut sources = Vec::new();
    for name in ["old", "new"] {
        let todo = db
            .todo_create(TodoCreateInput {
                scope: TodoScope::Project,
                project_id: Some(project.id),
                content: name.into(),
                priority: "normal".into(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
        let object = ObjectRef {
            workspace_id: "w".into(),
            scope: scope.clone(),
            kind: ObjectKind::Todo,
            id: todo.id.to_string(),
        };
        let snapshot = db
            .source_native_snapshot(
                &request,
                &binding,
                &SourceReadTarget {
                    object: object.clone(),
                    revision: None,
                    record_version: None,
                    file_version: None,
                },
            )
            .unwrap();
        sources.push(SourceRef {
            object,
            revision: snapshot.revision,
            title: snapshot.title,
            excerpt: name.into(),
            file_version: None,
            record_version: None,
            block_id: None,
            locator: None,
        });
    }
    for (index, source) in sources.iter().enumerate() {
        let coverage = SourceCoverage {
            processed: 1,
            partial: 0,
            excluded: 0,
            unsupported: 0,
            pending: 0,
        };
        let basis = OverviewItem {
            id: "basis".into(),
            section: OverviewSection::Progress,
            text: format!("basis {index}"),
            epistemic_status: EpistemicStatus::Recorded,
            source_refs: vec![source.clone()],
            dependency_item_ids: vec![],
            valid_state: ValidState::Current,
            updated_at: "now".into(),
        };
        let child = OverviewItem {
            id: "child".into(),
            section: OverviewSection::Progress,
            text: format!("child {index}"),
            epistemic_status: EpistemicStatus::Inferred,
            source_refs: vec![],
            dependency_item_ids: vec!["basis".into()],
            valid_state: ValidState::Current,
            updated_at: "now".into(),
        };
        let node = KnowledgeNodeWrite {
            node_id: "topic".into(),
            expected_revision: index as u64,
            kind: KnowledgeKind::Topic,
            title: format!("topic {index}"),
            one_line: "one".into(),
            summary: "summary".into(),
            body_sections: vec![KnowledgeBodySection {
                id: "body".into(),
                title: "body".into(),
                text: "text".into(),
            }],
            aliases: vec![],
            keywords: vec![],
            source_refs: vec![source.clone()],
            epistemic_status: EpistemicStatus::Recorded,
            coverage: coverage.clone(),
            related: vec![],
            session_summary: None,
        };
        let publish = OverviewPublishInput {
            scope: scope.clone(),
            batch_id: format!("trace-{index}"),
            expected_revision: index as u64,
            target_seq: db.committed_change_watermark().unwrap() as u64,
            policy_revision: 0,
            correction_revision: 0,
            upsert_items: vec![basis, child],
            remove_item_ids: vec![],
            settled_object_keys: vec![],
            knowledge_upserts: vec![node],
            knowledge_removes: vec![],
            coverage,
            source_manifest_hash: format!("hash-{index}"),
            model_profile_id: "profile".into(),
        };
        db.agent_overview_publish("gui", &format!("publish-{index}"), "w", &publish, |_, _| {
            Ok(())
        })
        .unwrap();
    }
    for method in ["knowledge.search", "knowledge.get"] {
        let result = if method == "knowledge.search" {
            json!({"scope":scope,"items":[{"nodeId":"node:topic","revision":1,"title":"{\"object\":\"fake\"}"},{"nodeId":"overview:child","revision":1,"snippet":"fake"}]})
        } else {
            json!({"scope":scope,"nodeId":"overview:child","revision":1,"related":[{"nodeId":"node:topic","revision":1,"title":"fake"}],"sourceRefs":[]})
        };
        let found = result_sources(&db, &request, &binding, method, &result).unwrap();
        assert_eq!(found.len(), 2);
        assert!(found.iter().all(|source| source.object == sources[0].object
            && source.revision.as_deref() == Some(sources[0].revision.as_str())));
    }
    let current = result_sources(&db,&request,&binding,"knowledge.search",&json!({"scope":scope,"items":[{"nodeId":"node:topic","revision":2},{"nodeId":"overview:child","revision":2}]})).unwrap();
    assert!(current
        .iter()
        .all(|source| source.object == sources[1].object));
}

#[test]
fn native_fields_ignore_json_embedded_in_titles_and_bodies() {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open(&root.path().join("trace.sqlite"), root.path(), None).unwrap();
    let binding = WorkspaceBinding {
        workspace_id: "w".into(),
        generation: "g".into(),
    };
    let request = RequestContext {
        binding: binding.clone(),
        caller: Caller::Gui,
        request_id: "trace".into(),
        scope_grant: ScopeGrant {
            object_keys: None,
            workspace_id: "w".into(),
            workspace_content: true,
            project_ids: vec![],
            operations: vec![],
        },
    };
    let real = ObjectRef {
        workspace_id: "w".into(),
        scope: Scope::Workspace,
        kind: ObjectKind::Record,
        id: "real".into(),
    };
    let fake = ObjectRef {
        id: "fake".into(),
        ..real.clone()
    };
    let result = json!({"items":[{"sourceRef":{"object":real,"revision":"old-revision","title":format!("{{\"object\":{}}}", serde_json::to_string(&fake).unwrap()),"excerpt":"{\"object\":\"fake\"}","fileVersion":null,"recordVersion":null,"blockId":null,"locator":null}}]});
    let sources = result_sources(&db, &request, &binding, "source.search", &result).unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].object.id, "real");
    assert_eq!(sources[0].revision.as_deref(), Some("old-revision"));
    assert_eq!(
        result_sources(&db, &request, &binding, "unknown.read", &json!({}))
            .unwrap_err()
            .code,
        ErrorCode::SourceNotReady
    );
}
