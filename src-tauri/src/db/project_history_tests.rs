use super::*;
use crate::agent::{
    context::{EpistemicStatus, OverviewItem, OverviewSection, SourceCoverage, ValidState},
    models::Scope,
    overview::OverviewPublishInput,
};
use crate::db::memory_facts::{MemoryOrigin, MemoryRequest};
use crate::models::ProjectCreateInput;
fn fixture() -> (tempfile::TempDir, Database, MemoryAccess) {
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(&root.path().join("history.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace("w").unwrap();
    let p = db
        .project_create(ProjectCreateInput {
            name: "history".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    db.source_registry_prepare().unwrap();
    (
        root,
        db,
        MemoryAccess {
            scope: MemoryScope::Project { project_id: p.id },
            origin: MemoryOrigin::User,
            sources: vec![],
        },
    )
}
fn item(id: &str, text: &str) -> OverviewItem {
    OverviewItem {
        id: id.into(),
        text: text.into(),
        section: OverviewSection::Profile,
        epistemic_status: EpistemicStatus::Inferred,
        source_refs: vec![],
        published_sources: vec![],
        dependency_item_ids: vec![],
        valid_state: ValidState::Current,
        updated_at: "metadata".into(),
    }
}
fn publish(
    db: &Database,
    a: &MemoryAccess,
    rev: u64,
    items: Vec<OverviewItem>,
    remove: Vec<String>,
) {
    let scope = match a.scope {
        MemoryScope::Workspace => Scope::Workspace,
        MemoryScope::Project { project_id } => Scope::Project { project_id },
    };
    let p = OverviewPublishInput {
        scope: scope.clone(),
        batch_id: format!("batch-{rev}"),
        expected_revision: rev,
        target_seq: db.committed_change_watermark().unwrap() as u64,
        policy_revision: 0,
        correction_revision: 0,
        expected_memory_epoch: 0,
        upsert_items: items,
        remove_item_ids: remove,
        settled_object_keys: vec![],
        knowledge_upserts: vec![],
        knowledge_removes: vec![],
        coverage: SourceCoverage {
            processed: 0,
            partial: 0,
            excluded: 0,
            unsupported: 0,
            pending: 0,
        },
        source_manifest_hash: "manifest".into(),
        model_profile_id: "profile".into(),
    };
    db.agent_overview_publish(
        "gui",
        &format!("publish-{}-{rev}", scope.key()),
        "w",
        &p,
        |_, _| Ok(()),
    )
    .unwrap();
}
fn execute(db: &Database, a: &MemoryAccess, v: Value) -> Value {
    db.memory_execute(a, serde_json::from_value::<MemoryRequest>(v).unwrap())
        .unwrap()
}
#[test]
fn project_history_published_changes_ignore_metadata_and_whitespace() {
    let (_root, db, a) = fixture();
    publish(
        &db,
        &a,
        0,
        vec![item("a", "先做原型"), item("b", "保留备份")],
        vec![],
    );
    let mut same = item("a", " 先做原型 \n");
    same.updated_at = "later".into();
    publish(&db, &a, 1, vec![same], vec![]);
    publish(&db, &a, 2, vec![item("a", "先验证需求")], vec!["b".into()]);
    let out = db.memory_project_history(&a, "", None, 30, 20000).unwrap();
    assert_eq!(out["historical"], true);
    let events = out["events"].as_array().unwrap();
    assert_eq!(events.len(), 4);
    assert_eq!(events[2]["kind"], "changed");
    assert_eq!(events[2]["before"]["text"], " 先做原型 \n");
    assert_eq!(events[2]["after"]["text"], "先验证需求");
    assert_eq!(events[3]["kind"], "removed");
    assert!(out["nextCursor"].is_null());
}

#[test]
fn project_history_retains_changes_to_fact_effective_dates() {
    let (_root, db, a) = fixture();
    let saved = execute(
        &db,
        &a,
        json!({"operation":"apply","requestId":"initial-date","changes":[{"action":"add","scope":a.scope,"category":"decision","content":"采用方案乙","validFrom":"2026-10-01T00:00:00Z"}]}),
    );
    execute(
        &db,
        &a,
        json!({"operation":"apply","requestId":"change-date","changes":[{"action":"patch","scope":a.scope,"id":saved["facts"][0]["id"],"expectedRevision":1,"validFrom":"2026-11-01T00:00:00Z"}]}),
    );
    let history = db.memory_project_history(&a, "", None, 20, 20000).unwrap();
    assert_eq!(history["events"].as_array().unwrap().len(), 2);
    assert_eq!(history["events"][1]["kind"], "changed");
    assert_eq!(
        history["events"][1]["before"]["validFrom"],
        "2026-10-01T00:00:00Z"
    );
    assert_eq!(
        history["events"][1]["after"]["validFrom"],
        "2026-11-01T00:00:00Z"
    );
}

#[test]
fn project_history_pagination_retains_same_revision_items_and_budget_boundary() {
    let (_root, db, a) = fixture();
    publish(
        &db,
        &a,
        0,
        vec![item("a", "first"), item("b", "second"), item("c", "third")],
        vec![],
    );
    let full = db.memory_project_history(&a, "", None, 100, 20000).unwrap();
    let tiny = db.memory_project_history(&a, "", None, 1, 0).unwrap();
    assert_eq!(tiny["events"], json!([]));
    assert!(tiny["requiredBudgetChars"].as_u64().unwrap() > 0);
    let mut cursor = tiny["nextCursor"].as_str().map(str::to_owned);
    // Later publications are outside this cursor's captured immutable bounds.
    publish(&db, &a, 1, vec![item("d", "later")], vec![]);
    let mut collected = vec![];
    while let Some(c) = cursor {
        let page = db
            .memory_project_history(&a, "", Some(&c), 1, 20000)
            .unwrap();
        collected.extend(page["events"].as_array().unwrap().clone());
        cursor = page["nextCursor"].as_str().map(str::to_owned);
    }
    assert_eq!(Value::Array(collected), full["events"]);
    assert_eq!(
        db.memory_project_history(&a, "later", None, 10, 20000)
            .unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn project_history_scope_denial_and_query_bound_cursor() {
    let (_root, db, a) = fixture();
    publish(
        &db,
        &a,
        0,
        vec![item("a", "private"), item("b", "second")],
        vec![],
    );
    let page = db.memory_project_history(&a, "", None, 1, 20000).unwrap();
    let cursor = page["nextCursor"].as_str().unwrap();
    let workspace = MemoryAccess {
        scope: MemoryScope::Workspace,
        ..a.clone()
    };
    assert!(db
        .memory_project_history(&workspace, "", None, 10, 20000)
        .is_err());
    let missing = MemoryAccess {
        scope: MemoryScope::Project { project_id: 999 },
        ..a.clone()
    };
    assert!(db
        .memory_project_history(&missing, "", None, 10, 20000)
        .is_err());
    let p = db
        .project_create(ProjectCreateInput {
            name: "other".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let other = MemoryAccess {
        scope: MemoryScope::Project { project_id: p.id },
        ..a.clone()
    };
    publish(
        &db,
        &other,
        0,
        vec![item("foreign", "FOREIGN PROJECT TEXT")],
        vec![],
    );
    publish(
        &db,
        &workspace,
        0,
        vec![item("workspace", "WORKSPACE TEXT")],
        vec![],
    );
    assert!(!db
        .memory_project_history(&a, "", None, 10, 20000)
        .unwrap()
        .to_string()
        .contains("FOREIGN PROJECT TEXT"));
    assert!(!db
        .memory_project_history(&a, "", None, 10, 20000)
        .unwrap()
        .to_string()
        .contains("WORKSPACE TEXT"));
    assert_eq!(
        db.memory_project_history(&other, "private", None, 10, 20000)
            .unwrap()["events"],
        json!([])
    );
    assert!(db
        .memory_project_history(&other, "", Some(cursor), 10, 20000)
        .is_err());
    assert!(db
        .memory_project_history(&a, "private", Some(cursor), 10, 20000)
        .is_err());
    assert!(db
        .memory_project_history(&a, "", Some("invalid"), 10, 20000)
        .is_err());
    assert!(db.memory_project_history(&a, "", None, 0, 20000).is_err());
}
#[test]
fn project_history_memory_condition_state_and_forgotten_disabled_exclusion() {
    let (_root, db, a) = fixture();
    let saved=execute(&db,&a,json!({"operation":"apply","requestId":"remember","changes":[{"action":"add","scope":a.scope,"category":"decision","content":"使用 Rust","condition":"服务端"}]}))["facts"][0].clone();
    execute(
        &db,
        &a,
        json!({"operation":"apply","requestId":"correct","changes":[{"action":"patch","scope":a.scope,"id":saved["id"],"expectedRevision":1,"content":"使用 Go","condition":null}]}),
    );
    let out = db.memory_project_history(&a, "", None, 30, 20000).unwrap();
    let events = out["events"].as_array().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[1]["kind"], "changed");
    assert_eq!(events[1]["before"]["condition"], "服务端");
    assert!(events[1]["after"]["condition"].is_null());
    execute(
        &db,
        &a,
        json!({"operation":"apply","requestId":"lock-only","changes":[{"action":"patch","scope":a.scope,"id":saved["id"],"expectedRevision":2,"core":false}]}),
    );
    assert_eq!(
        db.memory_project_history(&a, "", None, 30, 20000).unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    execute(
        &db,
        &a,
        json!({"operation":"apply","requestId":"disable","changes":[{"action":"disable","scope":a.scope,"id":saved["id"],"expectedRevision":3}]}),
    );
    assert_eq!(
        db.memory_project_history(&a, "", None, 30, 20000).unwrap()["events"],
        json!([])
    );
    execute(
        &db,
        &a,
        json!({"operation":"apply","requestId":"enable","changes":[{"action":"enable","scope":a.scope,"id":saved["id"],"expectedRevision":4}]}),
    );
    let restored = db.memory_project_history(&a, "", None, 30, 20000).unwrap();
    assert_eq!(restored["events"][2]["kind"], "state");
    assert_eq!(restored["events"][3]["kind"], "state");
    execute(
        &db,
        &a,
        json!({"operation":"apply","requestId":"forget","changes":[{"action":"forget","scope":a.scope,"id":saved["id"],"expectedRevision":5}]}),
    );
    assert_eq!(
        db.memory_project_history(&a, "Rust", None, 30, 20000)
            .unwrap()["events"],
        json!([])
    );
}
#[test]
fn project_history_source_deletion_preserves_conclusion_without_excerpts() {
    use crate::agent::models::{SourceLocator, SourceRef};
    use crate::db::memory_facts::MemorySource;
    use crate::models::DocumentDeleteInput;
    let (_root, mut db, mut a) = fixture();
    let MemoryScope::Project { project_id } = a.scope else {
        panic!()
    };
    let project = db.project_record(project_id).unwrap();
    std::fs::write(
        std::path::PathBuf::from(project.root_path).join("source.txt"),
        "RAW PRIVATE EVIDENCE",
    )
    .unwrap();
    let file = db
        .project_file_register("w", project_id, "source.txt")
        .unwrap();
    let reference = SourceRef {
        object: file.object,
        revision: file.content_hash.unwrap(),
        file_version: Some(file.version_number),
        record_version: None,
        block_id: None,
        locator: Some(SourceLocator::Paragraph { start: 1, end: 1 }),
        title: "source.txt".into(),
        excerpt: "RAW PRIVATE EVIDENCE".into(),
    };
    a.sources.push(MemorySource {
        kind: "file".into(),
        id: reference.object.id.clone(),
        scope: a.scope.clone(),
        label: "source.txt".into(),
        excerpt: "RAW PRIVATE EVIDENCE".into(),
        session_id: None,
        message_id: None,
        reference: Some(serde_json::to_value(&reference).unwrap()),
    });
    execute(
        &db,
        &a,
        json!({"operation":"apply","requestId":"save","changes":[{"action":"add","scope":a.scope,"category":"agreement","content":"保留结论"}]}),
    );
    let overview = item("overview", "项目当前理解");
    publish(&db, &a, 0, vec![overview], vec![]);
    let before = db.memory_project_history(&a, "", None, 30, 20000).unwrap();
    assert!(!before.to_string().contains("RAW PRIVATE EVIDENCE"));
    assert!(!before.to_string().contains("excerpt"));
    assert_eq!(
        before["events"][0]["sources"][0]["object"]["id"],
        reference.object.id
    );
    db.document_delete(DocumentDeleteInput {
        document_id: reference.object.id.parse().unwrap(),
    })
    .unwrap();
    let after = db.memory_project_history(&a, "", None, 30, 20000).unwrap();
    assert_eq!(after, before);
}

#[test]
fn project_history_noise_pages_are_bounded_and_resume_without_losing_later_change() {
    let (_root, db, a) = fixture();
    let items: Vec<_> = (0..100)
        .map(|i| item(&format!("item-{i:03}"), "same"))
        .collect();
    publish(&db, &a, 0, items.clone(), vec![]);
    let mut metadata = items;
    for i in &mut metadata {
        i.updated_at = "new timestamp".into();
    }
    publish(&db, &a, 1, metadata, vec![]);
    publish(&db, &a, 2, vec![item("item-000", "new conclusion")], vec![]);
    let first = db
        .memory_project_history(&a, "new conclusion", None, 100, 20000)
        .unwrap();
    assert_eq!(first["events"], json!([]));
    let mut cursor = first["nextCursor"].as_str().map(str::to_owned);
    let mut found = Vec::new();
    let mut pages = 0;
    while let Some(c) = cursor {
        pages += 1;
        assert!(pages < 10);
        let next = db
            .memory_project_history(&a, "new conclusion", Some(&c), 100, 20000)
            .unwrap();
        found.extend(next["events"].as_array().unwrap().clone());
        cursor = next["nextCursor"].as_str().map(str::to_owned);
    }
    assert_eq!(found.len(), 1);
    assert_eq!(found[0]["id"], "item-000");
}
#[test]
fn project_history_excludes_legacy_claimed_scope_with_actual_foreign_source_owner() {
    use crate::agent::models::SourceRef;
    let (_root, mut db, a) = fixture();
    let other = db
        .project_create(ProjectCreateInput {
            name: "foreign".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    std::fs::write(
        std::path::PathBuf::from(other.root_path).join("foreign.txt"),
        "foreign evidence",
    )
    .unwrap();
    let file = db
        .project_file_register("w", other.id, "foreign.txt")
        .unwrap();
    let mut object = file.object;
    let MemoryScope::Project { project_id } = a.scope else {
        panic!()
    };
    object.scope = Scope::Project { project_id };
    // Reproduce an old publication whose saved claim differs from current
    // native ownership. Publication still uses the real immutable version API.
    let source = SourceRef {
        object,
        revision: file.content_hash.unwrap(),
        file_version: Some(file.version_number),
        record_version: None,
        block_id: None,
        locator: None,
        title: "foreign.txt".into(),
        excerpt: "foreign evidence".into(),
    };
    let mut old = item("legacy", "FOREIGN DERIVED CONCLUSION");
    old.source_refs.push(source);
    publish(&db, &a, 0, vec![old], vec![]);
    assert_eq!(
        db.memory_project_history(&a, "", None, 10, 20000).unwrap()["events"],
        json!([])
    );
}
