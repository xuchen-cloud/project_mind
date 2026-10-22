use super::*;
use crate::{
    agent::models::SourceLocator,
    db::memory_facts::{MemoryAccess, MemoryOrigin, MemoryRequest},
    models::{DocumentDeleteInput, ProjectCreateInput},
};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};

struct Fixture {
    _root: tempfile::TempDir,
    db: Database,
    binding: WorkspaceBinding,
    project: i64,
    other_project: i64,
    source: SourceRef,
}
fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(
        &root.path().join("memory-delivery.sqlite"),
        root.path(),
        None,
    )
    .unwrap();
    db.bind_native_workspace("memory-delivery").unwrap();
    let project = db
        .project_create(ProjectCreateInput {
            name: "Original".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let other = db
        .project_create(ProjectCreateInput {
            name: "Other".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    fs::write(
        PathBuf::from(project.root_path).join("source.txt"),
        "真实来源：项目约定使用 Rust",
    )
    .unwrap();
    let file = db
        .project_file_register("memory-delivery", project.id, "source.txt")
        .unwrap();
    Fixture {
        _root: root,
        db,
        binding: WorkspaceBinding {
            workspace_id: "memory-delivery".into(),
            generation: "opened".into(),
        },
        project: project.id,
        other_project: other.id,
        source: SourceRef {
            object: file.object,
            revision: file.content_hash.unwrap(),
            file_version: Some(file.version_number),
            record_version: None,
            block_id: None,
            locator: Some(SourceLocator::Paragraph { start: 1, end: 1 }),
            title: "source.txt".into(),
            excerpt: "真实来源：项目约定使用 Rust".into(),
        },
    }
}
fn scope(f: &Fixture) -> MemoryScope {
    MemoryScope::Project {
        project_id: f.project,
    }
}
fn deliver(f: &Fixture, session: &str) {
    f.db.dsh_record_source_evidence(
        &f.binding,
        f.project,
        session,
        "read-source",
        &format!("{:x}", Sha256::digest("实际发送的原文".as_bytes())),
        &[f.source.clone()],
    )
    .unwrap();
}
fn access(scope: MemoryScope, sources: Vec<MemorySource>) -> MemoryAccess {
    MemoryAccess {
        scope,
        origin: MemoryOrigin::User,
        sources,
    }
}
fn execute(db: &Database, a: &MemoryAccess, request: Value) -> Value {
    db.memory_execute(a, serde_json::from_value::<MemoryRequest>(request).unwrap())
        .unwrap()
}
fn remember(
    f: &Fixture,
    a: &MemoryAccess,
    id: &str,
    content: &str,
    condition: Option<&str>,
) -> Value {
    execute(&f.db,a,json!({"operation":"apply","requestId":id,"changes":[{"action":"add","scope":a.scope,"category":if a.scope==MemoryScope::Workspace{"preference"}else{"agreement"},"content":content,"condition":condition}]}))["facts"][0].clone()
}

#[test]
fn memory_delivery_verified_source_requires_real_same_session_delivery() {
    let f = fixture();
    assert!(f
        .db
        .memory_verified_sources(
            &f.binding,
            &scope(&f),
            "actual/session",
            &[f.source.clone()]
        )
        .is_err());
    deliver(&f, "actual/session");
    assert!(f
        .db
        .memory_verified_sources(&f.binding, &scope(&f), "other/session", &[f.source.clone()])
        .is_err());
    let mut invented = f.source.clone();
    invented.title = "伪造标题".into();
    invented.excerpt = "伪造原文".into();
    let verified =
        f.db.memory_verified_sources(&f.binding, &scope(&f), "actual/session", &[invented])
            .unwrap();
    assert_eq!(verified.len(), 1);
    assert_eq!(verified[0].label, f.source.title);
    assert_eq!(verified[0].excerpt, f.source.excerpt);
    assert_eq!(
        verified[0].reference,
        Some(serde_json::to_value(&f.source).unwrap())
    );
    assert_eq!(
        f.db.memory_source_availability(&f.binding, &verified[0])
            .unwrap(),
        "available"
    );
    for source in [
        SourceRef {
            file_version: Some(99),
            ..f.source.clone()
        },
        SourceRef {
            locator: Some(SourceLocator::Paragraph { start: 2, end: 2 }),
            ..f.source.clone()
        },
        SourceRef {
            revision: format!("sha256:{:x}", Sha256::digest(b"not delivered")),
            ..f.source.clone()
        },
    ] {
        assert!(f
            .db
            .memory_verified_sources(&f.binding, &scope(&f), "actual/session", &[source])
            .is_err());
    }
}

#[test]
fn memory_delivery_verified_sources_reject_claimed_and_actual_foreign_owners() {
    let f = fixture();
    deliver(&f, "actual/session");
    let other = MemoryScope::Project {
        project_id: f.other_project,
    };
    assert!(f
        .db
        .memory_verified_sources(&f.binding, &other, "actual/session", &[f.source.clone()])
        .is_err());
    let mut forged = f.source.clone();
    forged.object.scope = Scope::Project {
        project_id: f.other_project,
    };
    assert!(f
        .db
        .memory_verified_sources(&f.binding, &other, "actual/session", &[forged])
        .is_err());
    let mut foreign = f.source.clone();
    foreign.object.workspace_id = "other-workspace".into();
    assert!(f
        .db
        .memory_verified_sources(&f.binding, &scope(&f), "actual/session", &[foreign])
        .is_err());
    assert!(f
        .db
        .memory_verified_sources(
            &f.binding,
            &MemoryScope::Workspace,
            "actual/session",
            &[f.source.clone()]
        )
        .is_err());
}

#[test]
fn memory_delivery_deleted_source_does_not_remove_usable_conclusion() {
    let mut f = fixture();
    deliver(&f, "actual/session");
    let sources =
        f.db.memory_verified_sources(
            &f.binding,
            &scope(&f),
            "actual/session",
            &[f.source.clone()],
        )
        .unwrap();
    let a = access(scope(&f), sources);
    let saved = remember(
        &f,
        &a,
        "save-conclusion",
        "项目约定使用 Rust",
        Some("实现代码时"),
    );
    // Fixed delivery references correctly protect the actual File. Clean up
    // the obsolete Session evidence owners before exercising real native deletion,
    // as the existing DSH evidence cleanup fixture does.
    assert!(f
        .db
        .document_delete(DocumentDeleteInput {
            document_id: f.source.object.id.parse().unwrap()
        })
        .is_err());
    let owner: String =
        f.db.conn
            .query_row(
                "SELECT owner_id FROM agent_evidence WHERE source_ref_json IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
    f.db.conn
        .execute(
            "DELETE FROM agent_evidence WHERE owner_kind='message' AND owner_id=?1",
            [&owner],
        )
        .unwrap();
    f.db.conn.execute("DELETE FROM content_reference_edges WHERE source_object_key=?1 AND relation='evidence'",[&owner]).unwrap();
    f.db.document_delete(DocumentDeleteInput {
        document_id: f.source.object.id.parse().unwrap(),
    })
    .unwrap();
    assert_eq!(
        f.db.memory_source_availability(&f.binding, &a.sources[0])
            .unwrap(),
        "source_removed"
    );
    let result = execute(
        &f.db,
        &access(scope(&f), vec![]),
        json!({"operation":"context","scope":scope(&f),"query":"代码","budgetChars":9000,"strategy":"snapshot"}),
    );
    assert_eq!(result["facts"][0]["id"], saved["id"]);
    assert_eq!(result["facts"][0]["content"], "项目约定使用 Rust");
    assert_eq!(result["facts"][0]["state"], "active");
    assert_eq!(result["facts"][0]["condition"], "实现代码时");
    assert!(result["facts"][0]["sources"].as_array().unwrap().is_empty());
    assert!(!saved["sources"].as_array().unwrap().is_empty());
    let details = execute(
        &f.db,
        &access(scope(&f), vec![]),
        json!({"operation":"list","scope":scope(&f)}),
    );
    assert_eq!(details["facts"][0]["sources"], saved["sources"]);
    let other = MemoryScope::Project {
        project_id: f.other_project,
    };
    let hidden = execute(
        &f.db,
        &access(other.clone(), vec![]),
        json!({"operation":"context","scope":other,"query":"","budgetChars":9000,"strategy":"snapshot"}),
    );
    assert!(hidden["facts"].as_array().unwrap().is_empty());
}

#[test]
fn memory_delivery_missing_optional_reference_serializes_absent_and_is_unverified() {
    let f = fixture();
    let source = MemorySource {
        kind: "message".into(),
        id: "actual-message".into(),
        scope: scope(&f),
        label: "用户消息".into(),
        excerpt: "请记住".into(),
        session_id: Some("actual/session".into()),
        message_id: Some("actual-message".into()),
        reference: None,
    };
    assert!(serde_json::to_value(&source)
        .unwrap()
        .get("reference")
        .is_none());
    assert_eq!(
        f.db.memory_source_availability(&f.binding, &source)
            .unwrap(),
        "unverified"
    );
    let mut value = serde_json::to_value(source).unwrap();
    value["reference"] = Value::Null;
    let decoded: MemorySource = serde_json::from_value(value).unwrap();
    assert!(decoded.reference.is_none());
    assert_eq!(
        f.db.memory_source_availability(&f.binding, &decoded)
            .unwrap(),
        "unverified"
    );
}

#[test]
fn memory_delivery_adoption_preserves_requested_immutable_revision_after_patch() {
    let f = fixture();
    let a = access(scope(&f), vec![]);
    let original = remember(&f, &a, "remember", "原始约定", Some("原始条件"));
    let mut snapshot = execute(
        &f.db,
        &a,
        json!({"operation":"context","scope":scope(&f),"query":"","budgetChars":9000,"strategy":"snapshot"}),
    );
    execute(
        &f.db,
        &a,
        json!({"operation":"apply","requestId":"correct","changes":[{"action":"patch","scope":scope(&f),"id":original["id"],"expectedRevision":1,"content":"后续修订","condition":"后续条件"}]}),
    );
    snapshot["facts"][0]["content"] = json!("宿主传入内容不能替换原生版本");
    f.db.memory_adoption_record(&scope(&f), "actual/session", "actual/request", &snapshot)
        .unwrap();
    let adopted =
        f.db.memory_adoption_get(&scope(&f), "actual/session")
            .unwrap()
            .unwrap();
    assert_eq!(adopted["requestId"], "actual/request");
    assert_eq!(
        adopted["snapshot"]["facts"][0]["content"],
        original["content"]
    );
    assert_eq!(adopted["snapshot"]["facts"][0]["revision"], 1);
    assert_eq!(adopted["snapshot"]["facts"][0]["condition"], "原始条件");
    let current = execute(&f.db, &a, json!({"operation":"list","scope":scope(&f)}));
    assert_eq!(current["facts"][0]["revision"], 2);
    assert_eq!(current["facts"][0]["content"], "后续修订");
    assert!(f
        .db
        .memory_adoption_get(
            &MemoryScope::Project {
                project_id: f.other_project
            },
            "actual/session"
        )
        .unwrap()
        .is_none());
    assert!(f
        .db
        .memory_adoption_get(&scope(&f), "different/session")
        .unwrap()
        .is_none());
}

#[test]
fn memory_delivery_adoption_rejects_foreign_actual_owner_and_unknown_revision() {
    let f = fixture();
    let own = access(scope(&f), vec![]);
    let original = remember(&f, &own, "remember", "项目私有约定", None);
    let other = MemoryScope::Project {
        project_id: f.other_project,
    };
    let mut forged = original.clone();
    forged["scope"] = json!({"kind":"workspace"});
    assert!(f
        .db
        .memory_adoption_record(&other, "s", "foreign", &json!({"facts":[forged.clone()]}))
        .is_err());
    assert!(f
        .db
        .memory_adoption_record(
            &MemoryScope::Workspace,
            "s",
            "workspace-escape",
            &json!({"facts":[forged]})
        )
        .is_err());
    let mut invalid = original;
    invalid["revision"] = json!(999);
    assert!(f
        .db
        .memory_adoption_record(
            &scope(&f),
            "s",
            "missing-version",
            &json!({"facts":[invalid]})
        )
        .is_err());
    assert!(f.db.memory_adoption_get(&other, "s").unwrap().is_none());
    assert!(f.db.memory_adoption_get(&scope(&f), "s").unwrap().is_none());
}

#[test]
fn memory_delivery_adoption_history_keeps_each_turn_step_and_original_versions() {
    let f = fixture();
    let a = access(scope(&f), vec![]);
    let original = remember(&f, &a, "remember-history", "第一版", Some("仅甲场景"));
    let first = json!({"turn":1,"step":1,"facts":[{"id":original["id"],"revision":1,"condition":"伪造条件"}],"omittedIds":["not-loaded"]});
    f.db.memory_adoption_record(&scope(&f), "session", "request-1", &first)
        .unwrap();
    execute(
        &f.db,
        &a,
        json!({"operation":"apply","requestId":"patch-history","changes":[{"action":"patch","scope":scope(&f),"id":original["id"],"expectedRevision":1,"content":"第二版","condition":"仅乙场景"}]}),
    );
    let second =
        json!({"turn":1,"step":2,"facts":[{"id":original["id"],"revision":2}],"omittedIds":[]});
    f.db.memory_adoption_record(&scope(&f), "session", "request-2", &second)
        .unwrap();
    let third = json!({"turn":2,"step":1,"facts":[],"omittedIds":[]});
    f.db.memory_adoption_record(&scope(&f), "session", "request-3", &third)
        .unwrap();
    // A repeated request ID cannot rewrite accepted evidence.
    f.db.memory_adoption_record(&scope(&f), "session", "request-1", &third)
        .unwrap();
    execute(
        &f.db,
        &a,
        json!({"operation":"apply","requestId":"forget-history","changes":[{"action":"forget","scope":scope(&f),"id":original["id"],"expectedRevision":2}]}),
    );
    let history =
        f.db.memory_adoptions_for_turn(&scope(&f), "session", 1)
            .unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0]["snapshot"]["facts"][0]["content"], "第一版");
    assert_eq!(history[0]["snapshot"]["facts"][0]["condition"], "仅甲场景");
    assert_eq!(history[0]["snapshot"]["omittedIds"], json!(["not-loaded"]));
    assert_eq!(history[1]["snapshot"]["facts"][0]["content"], "第二版");
    assert_eq!(
        f.db.memory_adoptions_for_turn(&scope(&f), "session", 2)
            .unwrap()
            .len(),
        1
    );
    assert!(f
        .db
        .memory_adoptions_for_turn(
            &MemoryScope::Project {
                project_id: f.other_project
            },
            "session",
            1
        )
        .unwrap()
        .is_empty());
    assert!(f
        .db
        .memory_adoptions_for_turn(&scope(&f), "other-session", 1)
        .unwrap()
        .is_empty());
    assert!(execute(&f.db,&a,json!({"operation":"context","scope":scope(&f),"query":"","budgetChars":9000,"strategy":"snapshot"}))["facts"].as_array().unwrap().is_empty());
}
