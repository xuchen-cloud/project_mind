use super::*;
use serde_json::json;
fn fixture() -> (tempfile::TempDir, Database, MemoryAccess) {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open(&root.path().join("memory.sqlite"), root.path(), None).unwrap();
    (
        root,
        db,
        MemoryAccess {
            scope: MemoryScope::Workspace,
            origin: MemoryOrigin::User,
            sources: vec![],
        },
    )
}
fn execute(db: &Database, a: &MemoryAccess, v: Value) -> Result<Value, String> {
    db.memory_execute(a, serde_json::from_value(v).unwrap())
}
#[test]
fn memory_facts_remember_patch_null_and_receipt() {
    let (_root, db, a) = fixture();
    let add = json!({"operation":"apply","requestId":"remember","changes":[{"action":"add","scope":{"kind":"workspace"},"category":"preference","content":"优先使用中文","condition":"工作时"}]});
    let saved = execute(&db, &a, add.clone()).unwrap();
    assert_eq!(saved, execute(&db, &a, add).unwrap());
    let f = &saved["facts"][0];
    let changed=execute(&db,&a,json!({"operation":"apply","requestId":"correct","changes":[{"action":"patch","scope":{"kind":"workspace"},"id":f["id"],"expectedRevision":1,"condition":null}]})).unwrap();
    assert!(changed["facts"][0]["condition"].is_null());
    assert_eq!(changed["facts"][0]["content"], "优先使用中文");
}
#[test]
fn memory_facts_user_receipt_cannot_be_used_as_organization_undo() {
    let (_root, db, a) = fixture();
    let saved = execute(&db, &a, json!({"operation":"apply","requestId":"manual-add","changes":[{"action":"add","scope":a.scope,"category":"preference","content":"使用中文"}]})).unwrap();
    let error = execute(
        &db,
        &a,
        json!({"operation":"rollback","requestId":"invalid-undo","rollbackId":saved["receipt"]}),
    )
    .unwrap_err();
    assert!(error.contains("Only automatic organization"));
    let current = execute(&db, &a, json!({"operation":"list","scope":a.scope})).unwrap();
    assert_eq!(current["facts"], saved["facts"]);
}

#[test]
fn memory_facts_shared_conclusion_does_not_grant_workspace_original_evidence() {
    let (_root, db, mut a) = fixture();
    db.conn.execute("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES(1,'one','/tmp/one','','')",[]).unwrap();
    a.sources.push(MemorySource {
        kind: "message".into(),
        id: "private-workspace-message".into(),
        scope: MemoryScope::Workspace,
        label: "Workspace".into(),
        excerpt: "PRIVATE_ORIGINAL_CONTEXT".into(),
        session_id: Some("workspace-session".into()),
        message_id: Some("private-workspace-message".into()),
        reference: None,
    });
    let saved = add(&db, &a, "shared", "答复用中文");
    let project = MemoryAccess {
        scope: MemoryScope::Project { project_id: 1 },
        origin: MemoryOrigin::User,
        sources: vec![],
    };
    let listed = execute(
        &db,
        &project,
        json!({"operation":"list","scope":project.scope}),
    )
    .unwrap();
    assert_eq!(listed["facts"][0]["content"], saved["content"]);
    assert_eq!(listed["facts"][0]["sources"], json!([]));
    let own = execute(&db, &a, json!({"operation":"list","scope":a.scope})).unwrap();
    assert_eq!(own["facts"][0]["sources"], saved["sources"]);
}
fn add(db: &Database, a: &MemoryAccess, rid: &str, content: &str) -> Value {
    execute(db,a,json!({"operation":"apply","requestId":rid,"changes":[{"action":"add","scope":a.scope,"category":if a.scope==MemoryScope::Workspace{"preference"}else{"agreement"},"content":content}]})).unwrap()["facts"][0].clone()
}
fn change(
    db: &Database,
    a: &MemoryAccess,
    rid: &str,
    action: &str,
    f: &Value,
) -> Result<Value, String> {
    execute(
        db,
        a,
        json!({"operation":"apply","requestId":rid,"changes":[{"action":action,"scope":f["scope"],"id":f["id"],"expectedRevision":f["revision"]}]}),
    )
}
#[test]
fn memory_facts_atomic_cas_scope_and_payload_binding() {
    let (_root, db, a) = fixture();
    let f = add(&db, &a, "a", "中文");
    assert!(execute(&db,&a,json!({"operation":"apply","requestId":"a","changes":[{"action":"add","scope":a.scope,"category":"preference","content":"别的内容"}]})).unwrap_err().contains("payload"));
    assert!(execute(&db,&a,json!({"operation":"apply","requestId":"atomic","changes":[{"action":"patch","scope":a.scope,"id":f["id"],"expectedRevision":1,"content":"changed"},{"action":"patch","scope":a.scope,"id":"missing","expectedRevision":1,"content":"bad"}]})).is_err());
    let list = execute(&db, &a, json!({"operation":"list","scope":a.scope})).unwrap();
    assert_eq!(list["facts"][0], f);
    db.conn.execute("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES(1,'one','/tmp/one','',''),(2,'two','/tmp/two','','')",[]).unwrap();
    let pa = MemoryAccess {
        scope: MemoryScope::Project { project_id: 1 },
        ..a.clone()
    };
    let pf = add(&db, &pa, "p1", "项目约定");
    let pb = MemoryAccess {
        scope: MemoryScope::Project { project_id: 2 },
        ..a.clone()
    };
    assert!(change(&db, &pb, "cross", "forget", &pf).is_err());
    assert!(execute(
        &db,
        &pa,
        json!({"operation":"list","scope":{"kind":"project","projectId":2}})
    )
    .is_err());
    assert!(execute(&db,&a,json!({"operation":"apply","requestId":"owner","changes":[{"action":"patch","scope":a.scope,"id":pf["id"],"expectedRevision":1,"content":"wrong owner"}]})).is_err());
    assert!(execute(
        &db,
        &a,
        json!({"operation":"list","scope":{"kind":"project","projectId":99}})
    )
    .is_err());
}
#[test]
fn memory_facts_forget_disable_suppress_specific_fact_despite_changed_evidence() {
    let (_root, db, mut a) = fixture();
    a.sources.push(MemorySource {
        kind: "message".into(),
        id: "message-one".into(),
        scope: a.scope.clone(),
        label: "one".into(),
        excerpt: "用中文，示例用 Rust".into(),
        session_id: Some("session".into()),
        message_id: Some("message-one".into()),
        reference: None,
    });
    let f = add(&db, &a, "zh", "用中文");
    let other = add(&db, &a, "rs", "示例用 Rust");
    change(&db, &a, "disable", "disable", &f).unwrap();
    let org = MemoryAccess {
        scope: a.scope.clone(),
        origin: MemoryOrigin::Organization,
        sources: vec![],
    };
    assert!(execute(&db,&org,json!({"operation":"apply","requestId":"recreate","changes":[{"action":"add","scope":a.scope,"category":"preference","content":"用中文"}]})).is_err());
    let out=execute(&db,&org,json!({"operation":"context","scope":a.scope,"query":"","budgetChars":9000,"strategy":"snapshot"})).unwrap();
    assert_eq!(out["facts"][0]["id"], other["id"]);
    assert_eq!(out["suppressed"].as_array().unwrap().len(), 1);
    assert!(change(
        &db,
        &org,
        "org-enable",
        "enable",
        &json!({"scope":a.scope,"id":f["id"],"revision":2})
    )
    .is_err());
    let disabled = json!({"scope":a.scope,"id":f["id"],"revision":2});
    let enabled = change(&db, &a, "enable", "enable", &disabled).unwrap()["facts"][0].clone();
    change(&db, &a, "forget", "forget", &enabled).unwrap();
    assert!(change(
        &db,
        &a,
        "restore",
        "enable",
        &json!({"scope":a.scope,"id":f["id"],"revision":4})
    )
    .is_err());
    add(&db, &a, "explicit-again", "用中文");
}
#[test]
fn memory_facts_merge_undo_whole_unit_locks_and_respects_later_edit() {
    let (_root, db, a) = fixture();
    let f = add(&db, &a, "a", "中文");
    let g = add(&db, &a, "b", "简短");
    let unrelated = add(&db, &a, "c", "无关");
    let org = MemoryAccess {
        origin: MemoryOrigin::Organization,
        ..a.clone()
    };
    let merged=execute(&db,&org,json!({"operation":"apply","requestId":"merge","changes":[{"action":"merge","scope":a.scope,"id":f["id"],"expectedRevision":1,"content":"用简短中文","from":[{"id":g["id"],"expectedRevision":1}]}]})).unwrap();
    assert_eq!(merged["facts"].as_array().unwrap().len(), 2);
    assert!(merged["facts"]
        .as_array()
        .unwrap()
        .iter()
        .all(|f| f["confirmation"] == "inferred"));
    let undo = merged["receipt"].clone();
    let restored = execute(
        &db,
        &a,
        json!({"operation":"rollback","requestId":"undo","rollbackId":undo}),
    )
    .unwrap();
    assert_eq!(restored["facts"].as_array().unwrap().len(), 2);
    assert!(restored["facts"]
        .as_array()
        .unwrap()
        .iter()
        .all(|f| f["locked"] == true
            && f["state"] == "active"
            && f["confirmation"] == "confirmed"));
    let list = execute(&db, &a, json!({"operation":"list","scope":a.scope})).unwrap();
    assert!(list["facts"].as_array().unwrap().contains(&unrelated));
    assert!(change(&db, &org, "protected", "forget", &restored["facts"][0]).is_err());
    let x = add(&db, &a, "x", "旧");
    let organized=execute(&db,&org,json!({"operation":"apply","requestId":"org","changes":[{"action":"patch","scope":a.scope,"id":x["id"],"expectedRevision":1,"content":"新"}]})).unwrap();
    let current = &organized["facts"][0];
    change(&db, &a, "later-forget", "forget", current).unwrap();
    assert!(execute(
        &db,
        &a,
        json!({"operation":"rollback","requestId":"unsafe-undo","rollbackId":organized["receipt"]})
    )
    .is_err());
}
#[test]
fn memory_facts_approval_stale_proposal_and_organization_confirmation() {
    let (_root, db, a) = fixture();
    let f = add(&db, &a, "a", "用中文");
    execute(
        &db,
        &a,
        json!({"operation":"settings","requireApproval":true}),
    )
    .unwrap();
    let org = MemoryAccess {
        origin: MemoryOrigin::Organization,
        ..a.clone()
    };
    let pending=execute(&db,&org,json!({"operation":"apply","requestId":"proposal","changes":[{"action":"patch","scope":a.scope,"id":f["id"],"expectedRevision":1,"content":"用英文"}]})).unwrap();
    assert_eq!(pending["pending"], true);
    assert!(pending["facts"].as_array().unwrap().is_empty());
    let list = execute(&db, &a, json!({"operation":"list","scope":a.scope})).unwrap();
    assert_eq!(list["facts"][0], f);
    change(&db, &a, "edit", "disable", &f).unwrap();
    assert!(execute(
        &db,
        &a,
        json!({"operation":"approve","requestId":"stale","proposalId":pending["proposalId"]})
    )
    .is_err());
    assert!(execute(
        &db,
        &a,
        json!({"operation":"reject","requestId":"reject","proposalId":pending["proposalId"]}),
    )
    .is_err());
    let fresh = add(&db, &a, "fresh", "原始");
    let proposal=execute(&db,&org,json!({"operation":"apply","requestId":"good","changes":[{"action":"patch","scope":a.scope,"id":fresh["id"],"expectedRevision":1,"content":"整理后"}]})).unwrap();
    let approved = execute(
        &db,
        &a,
        json!({"operation":"approve","requestId":"approve","proposalId":proposal["proposalId"]}),
    )
    .unwrap();
    assert_eq!(approved["facts"][0]["confirmation"], "inferred");
}
#[test]
fn memory_facts_context_chinese_ranking_time_conditions_and_budget() {
    let (_root, db, a) = fixture();
    let irrelevant = add(&db, &a, "a", "阅读历史书籍");
    let relevant = add(&db, &a, "b", "开发时优先使用 Rust 示例");
    let expired=execute(&db,&a,json!({"operation":"apply","requestId":"expired","changes":[{"action":"add","scope":a.scope,"category":"preference","content":"旧偏好","condition":"测试时","validTo":"2020-01-01T00:00:00Z"}]})).unwrap();
    let result=execute(&db,&a,json!({"operation":"context","scope":a.scope,"query":"开发 Rust 示例","budgetChars":10000,"strategy":"layered"})).unwrap();
    assert_eq!(result["facts"][0]["id"], relevant["id"]);
    assert!(!result["facts"]
        .as_array()
        .unwrap()
        .contains(&expired["facts"][0]));
    assert!(!result["facts"].as_array().unwrap().contains(&irrelevant));
    let tiny=execute(&db,&a,json!({"operation":"context","scope":a.scope,"query":"","budgetChars":0,"strategy":"snapshot"})).unwrap();
    assert!(tiny["facts"].as_array().unwrap().is_empty());
    assert_eq!(tiny["omittedIds"].as_array().unwrap().len(), 2);
}
#[test]
fn memory_facts_batch_undo_does_not_restore_unrelated_units() {
    let (_root, db, a) = fixture();
    let f = add(&db, &a, "a", "甲");
    let g = add(&db, &a, "b", "乙");
    let other = add(&db, &a, "c", "丙");
    let org = MemoryAccess {
        origin: MemoryOrigin::Organization,
        ..a.clone()
    };
    let out=execute(&db,&org,json!({"operation":"apply","requestId":"batch","changes":[{"action":"merge","scope":a.scope,"id":f["id"],"expectedRevision":1,"content":"甲乙","from":[{"id":g["id"],"expectedRevision":1}]},{"action":"patch","scope":a.scope,"id":other["id"],"expectedRevision":1,"content":"新丙"}]})).unwrap();
    let member = out["facts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == f["id"])
        .unwrap();
    let unaffected = out["facts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == other["id"])
        .unwrap();
    assert_ne!(member["rollbackId"], unaffected["rollbackId"]);
    let undo = execute(
        &db,
        &a,
        json!({"operation":"rollback","requestId":"unit-undo","rollbackId":member["rollbackId"]}),
    )
    .unwrap();
    assert_eq!(undo["facts"].as_array().unwrap().len(), 2);
    let list = execute(&db, &a, json!({"operation":"list","scope":a.scope})).unwrap();
    assert!(list["facts"].as_array().unwrap().contains(unaffected));
}
#[test]
fn memory_facts_source_retention_versions_and_reopen_receipt() {
    let (root, db, mut a) = fixture();
    a.sources.push(MemorySource {
        kind: "file".into(),
        id: "deleted-file".into(),
        scope: a.scope.clone(),
        label: "已删除文件".into(),
        excerpt: "编程示例用 Rust".into(),
        session_id: None,
        message_id: None,
        reference: Some(json!({"revision":"sha256:actual-native-reference"})),
    });
    let f = add(&db, &a, "remember-file", "编程示例用 Rust");
    let patched=execute(&db,&a,json!({"operation":"apply","requestId":"correct-file","changes":[{"action":"patch","scope":a.scope,"id":f["id"],"expectedRevision":1,"condition":"讨论编程时"}]})).unwrap();
    assert_eq!(patched["facts"][0]["sources"], f["sources"]);
    let count: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM memory_fact_versions WHERE fact_id=?1",
            [f["id"].as_str().unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 2);
    drop(db);
    let reopened = Database::open(&root.path().join("memory.sqlite"), root.path(), None).unwrap();
    let context=execute(&reopened,&a,json!({"operation":"context","scope":a.scope,"query":"Rust","budgetChars":9000,"strategy":"snapshot"})).unwrap();
    assert_eq!(context["facts"][0]["condition"], "讨论编程时");
    assert!(context["facts"][0]["sources"]
        .as_array()
        .unwrap()
        .is_empty());
    let replay=execute(&reopened,&a,json!({"operation":"apply","requestId":"correct-file","changes":[{"action":"patch","scope":a.scope,"id":f["id"],"expectedRevision":1,"condition":"讨论编程时"}]})).unwrap();
    assert_eq!(patched, replay);
}
#[test]
fn memory_facts_undo_expiry_and_separate_connection_cas() {
    let (root, db, a) = fixture();
    let f = add(&db, &a, "a", "最初");
    let another = Database::open(&root.path().join("memory.sqlite"), root.path(), None).unwrap();
    let org = MemoryAccess {
        origin: MemoryOrigin::Organization,
        ..a.clone()
    };
    let updated=execute(&another,&org,json!({"operation":"apply","requestId":"org","changes":[{"action":"patch","scope":a.scope,"id":f["id"],"expectedRevision":1,"content":"整理"}]})).unwrap();
    assert!(change(&db, &a, "stale", "forget", &f).is_err());
    db.conn.execute("INSERT INTO memory_fact_operations SELECT 'expired','2020-01-01T00:00:00Z',before_json,after_json,undone FROM memory_fact_operations WHERE id=?1",[updated["receipt"].as_str().unwrap()]).unwrap();
    assert!(execute(
        &db,
        &a,
        json!({"operation":"rollback","requestId":"expired-undo","rollbackId":"expired"})
    )
    .unwrap_err()
    .contains("expired"));
    let undone = execute(
        &db,
        &a,
        json!({"operation":"rollback","requestId":"good-undo","rollbackId":updated["receipt"]}),
    )
    .unwrap();
    assert_eq!(undone["facts"][0]["revision"], 3);
    assert!(execute(
        &db,
        &a,
        json!({"operation":"rollback","requestId":"twice","rollbackId":updated["receipt"]})
    )
    .is_err());
    assert!(execute(&db,&org,json!({"operation":"apply","requestId":"locked-recreate","changes":[{"action":"add","scope":a.scope,"category":"preference","content":"最初"}]})).is_err());
}
#[test]
fn memory_facts_boundary_validation_rolls_back_without_receipt() {
    let (_root, db, a) = fixture();
    let f = add(&db, &a, "a", "条件偏好");
    for (i, fields) in [
        json!({"core":null}),
        json!({"condition":42}),
        json!({"content":null}),
        json!({"validFrom":"later"}),
        json!({"validFrom":"2026-01-02T00:00:00Z","validTo":"2026-01-01T00:00:00Z"}),
        json!({"sources":[]}),
    ]
    .into_iter()
    .enumerate()
    {
        let mut ch = json!({"action":"patch","scope":a.scope,"id":f["id"],"expectedRevision":1});
        ch.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        let rid = format!("invalid-{i}");
        assert!(execute(
            &db,
            &a,
            json!({"operation":"apply","requestId":rid,"changes":[ch]})
        )
        .is_err());
        let n: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM memory_fact_receipts WHERE request_id=?1",
                [rid],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0);
    }
    assert!(execute(&db,&a,json!({"operation":"apply","requestId":"category","changes":[{"action":"add","scope":a.scope,"category":"decision","content":"invalid"}]})).is_err());
}
#[test]
fn memory_facts_real_user_rollback_confirms_restored_version() {
    let (_root, db, a) = fixture();
    let org = MemoryAccess {
        origin: MemoryOrigin::Organization,
        ..a.clone()
    };
    let inferred = add(&db, &org, "inferred", "系统推断");
    assert_eq!(inferred["confirmation"], "inferred");
    let changed=execute(&db,&org,json!({"operation":"apply","requestId":"rewrite","changes":[{"action":"patch","scope":a.scope,"id":inferred["id"],"expectedRevision":1,"content":"另一次推断"}]})).unwrap();
    let restored=execute(&db,&a,json!({"operation":"rollback","requestId":"confirm-restore","rollbackId":changed["facts"][0]["rollbackId"]})).unwrap();
    assert_eq!(restored["facts"][0]["confirmation"], "confirmed");
    assert!(restored["facts"][0]["autoOrganizedAt"].is_null());
    assert!(restored["facts"][0]["rollbackId"].is_null());
}
#[test]
fn memory_facts_workspace_access_cannot_target_projects() {
    let (_root, db, a) = fixture();
    db.conn.execute("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES(1,'one','/one','','')",[]).unwrap();
    let project = json!({"kind":"project","projectId":1});
    for request in [
        json!({"operation":"list","scope":project}),
        json!({"operation":"context","scope":project,"query":"","budgetChars":9000,"strategy":"snapshot"}),
        json!({"operation":"apply","requestId":"workspace-escalate","changes":[{"action":"add","scope":project,"category":"agreement","content":"不能越界"}]}),
    ] {
        assert!(execute(&db, &a, request).is_err());
    }
}
#[test]
fn memory_facts_shared_conclusion_does_not_disclose_other_project_evidence() {
    let (_root, db, a) = fixture();
    db.conn.execute("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES(1,'one','/one','',''),(2,'two','/two','','')",[]).unwrap();
    let p1 = MemoryScope::Project { project_id: 1 };
    let p2 = MemoryScope::Project { project_id: 2 };
    let origin = MemoryAccess {
        scope: p1.clone(),
        origin: MemoryOrigin::User,
        sources: vec![MemorySource {
            kind: "message".into(),
            id: "private-message".into(),
            scope: p1,
            label: "私有来源".into(),
            excerpt: "项目一的私有内容".into(),
            session_id: None,
            message_id: None,
            reference: None,
        }],
    };
    let added=execute(&db,&origin,json!({"operation":"apply","requestId":"shared","changes":[{"action":"add","scope":a.scope,"category":"preference","content":"工作汇报使用中文"}]})).unwrap();
    assert_eq!(added["facts"][0]["sources"].as_array().unwrap().len(), 1);
    let other = MemoryAccess {
        scope: p2.clone(),
        ..a.clone()
    };
    let context=execute(&db,&other,json!({"operation":"context","scope":p2,"query":"","budgetChars":9000,"strategy":"snapshot"})).unwrap();
    assert_eq!(context["facts"][0]["content"], "工作汇报使用中文");
    assert!(context["facts"][0]["sources"]
        .as_array()
        .unwrap()
        .is_empty());
    let changed=execute(&db,&other,json!({"operation":"apply","requestId":"cross-source-edit","changes":[{"action":"patch","scope":a.scope,"id":added["facts"][0]["id"],"expectedRevision":1,"condition":"写汇报时"}]})).unwrap();
    assert!(changed["facts"][0]["sources"]
        .as_array()
        .unwrap()
        .is_empty());
    let own = execute(&db, &origin, json!({"operation":"list","scope":a.scope})).unwrap();
    assert_eq!(own["facts"][0]["sources"].as_array().unwrap().len(), 1);
}

#[test]
fn memory_facts_organization_cannot_patch_or_merge_into_suppressed_conclusion() {
    let (_root, db, a) = fixture();
    let forgotten = add(&db, &a, "forgotten", "不再使用的约定");
    change(&db, &a, "forget", "forget", &forgotten).unwrap();
    let first = add(&db, &a, "first", "仍有效甲");
    let second = add(&db, &a, "second", "仍有效乙");
    let org = MemoryAccess {
        origin: MemoryOrigin::Organization,
        ..a.clone()
    };
    for (rid, change) in [
        (
            "patch-suppressed",
            json!({"action":"patch","scope":a.scope,"id":first["id"],"expectedRevision":1,"content":"不再使用的约定"}),
        ),
        (
            "merge-suppressed",
            json!({"action":"merge","scope":a.scope,"id":first["id"],"expectedRevision":1,"content":"不再使用的约定","from":[{"id":second["id"],"expectedRevision":1}]}),
        ),
    ] {
        assert!(execute(
            &db,
            &org,
            json!({"operation":"apply","requestId":rid,"changes":[change]})
        )
        .is_err());
    }
    let listed = execute(&db, &a, json!({"operation":"list","scope":a.scope})).unwrap();
    assert!(listed["facts"].as_array().unwrap().contains(&first));
    assert!(listed["facts"].as_array().unwrap().contains(&second));
}

#[test]
fn memory_facts_context_never_contains_source_excerpts_and_details_keep_them() {
    let (_root, db, mut a) = fixture();
    a.sources.push(MemorySource {
        kind: "message".into(),
        id: "evidence".into(),
        scope: a.scope.clone(),
        label: "原文".into(),
        excerpt: "只应通过原文读取的私有内容".into(),
        session_id: Some("actual-session".into()),
        message_id: Some("evidence".into()),
        reference: None,
    });
    let fact = add(&db, &a, "remember", "只保存这条结论");
    for strategy in ["snapshot", "layered"] {
        let context=execute(&db,&a,json!({"operation":"context","scope":a.scope,"query":"结论","budgetChars":9000,"strategy":strategy})).unwrap();
        assert_eq!(context["facts"][0]["id"], fact["id"]);
        assert!(context["facts"][0]["sources"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(!serde_json::to_string(&context)
            .unwrap()
            .contains("只应通过原文读取的私有内容"));
    }
    let details = execute(&db, &a, json!({"operation":"list","scope":a.scope})).unwrap();
    assert_eq!(details["facts"][0]["sources"], fact["sources"]);
}

#[test]
fn memory_facts_core_requires_confirmed_unconditional_workspace_version() {
    let (_root, db, a) = fixture();
    let apply_core = |a: &MemoryAccess, rid: &str, condition: Value| {
        execute(&db,a,json!({"operation":"apply","requestId":rid,"changes":[{"action":"add","scope":a.scope,"category":if a.scope==MemoryScope::Workspace{"preference"}else{"agreement"},"content":rid,"condition":condition,"core":true}]})).unwrap()["facts"][0].clone()
    };
    let core = apply_core(&a, "confirmed-core", Value::Null);
    assert_eq!(core["core"], true);
    let conditioned = apply_core(&a, "conditional", json!("写代码时"));
    assert_eq!(conditioned["core"], false);
    let org = MemoryAccess {
        origin: MemoryOrigin::Organization,
        ..a.clone()
    };
    let inferred = apply_core(&org, "inferred-core", Value::Null);
    assert_eq!(inferred["core"], false);
    let changed=execute(&db,&org,json!({"operation":"apply","requestId":"rewrite-core","changes":[{"action":"patch","scope":a.scope,"id":core["id"],"expectedRevision":1,"content":"新的系统归纳"}]})).unwrap();
    assert_eq!(changed["facts"][0]["core"], false);
    db.conn.execute("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES(1,'one','/one','','')",[]).unwrap();
    let project = MemoryAccess {
        scope: MemoryScope::Project { project_id: 1 },
        ..a.clone()
    };
    assert_eq!(
        apply_core(&project, "project-core", Value::Null)["core"],
        false
    );
    let pinned = apply_core(&a, "valid-core", Value::Null);
    let context=execute(&db,&a,json!({"operation":"context","scope":a.scope,"query":"unrelated query","budgetChars":9000,"strategy":"layered"})).unwrap();
    assert_eq!(context["facts"][0]["id"], pinned["id"]);
}

#[test]
fn memory_facts_mutation_obsoletes_only_proposals_with_affected_revisions() {
    let (_root, db, a) = fixture();
    let first = add(&db, &a, "first", "原约定甲");
    let second = add(&db, &a, "second", "原约定乙");
    execute(
        &db,
        &a,
        json!({"operation":"settings","requireApproval":true}),
    )
    .unwrap();
    let org = MemoryAccess {
        origin: MemoryOrigin::Organization,
        ..a.clone()
    };
    let propose = |rid: &str, fact: &Value| {
        execute(&db,&org,json!({"operation":"apply","requestId":rid,"changes":[{"action":"patch","scope":a.scope,"id":fact["id"],"expectedRevision":1,"content":rid}]})).unwrap()
    };
    let stale = propose("proposal-first", &first);
    let unrelated = propose("proposal-second", &second);
    assert!(execute(&db,&a,json!({"operation":"apply","requestId":"failed-edit","changes":[{"action":"patch","scope":a.scope,"id":first["id"],"expectedRevision":1,"content":"临时修改"},{"action":"patch","scope":a.scope,"id":"missing","expectedRevision":1,"content":"失败"}]})).is_err());
    assert_eq!(
        execute(&db, &a, json!({"operation":"list","scope":a.scope})).unwrap()["proposals"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    execute(&db,&a,json!({"operation":"apply","requestId":"user-edit","changes":[{"action":"patch","scope":a.scope,"id":first["id"],"expectedRevision":1,"content":"用户修改"}]})).unwrap();
    let list = execute(&db, &a, json!({"operation":"list","scope":a.scope})).unwrap();
    assert_eq!(list["proposals"].as_array().unwrap().len(), 1);
    assert_eq!(list["proposals"][0]["id"], unrelated["proposalId"]);
    assert!(execute(
        &db,
        &a,
        json!({"operation":"approve","requestId":"approve-stale","proposalId":stale["proposalId"]})
    )
    .is_err());
    assert!(!execute(&db,&a,json!({"operation":"approve","requestId":"approve-unrelated","proposalId":unrelated["proposalId"]})).unwrap()["pending"].as_bool().unwrap());
    let merge=execute(&db,&org,json!({"operation":"apply","requestId":"merge-proposal","changes":[{"action":"merge","scope":a.scope,"id":first["id"],"expectedRevision":2,"content":"合并约定","from":[{"id":second["id"],"expectedRevision":2}]}]})).unwrap();
    execute(&db,&a,json!({"operation":"apply","requestId":"edit-merge-source","changes":[{"action":"disable","scope":a.scope,"id":second["id"],"expectedRevision":2}]})).unwrap();
    assert!(
        execute(&db, &a, json!({"operation":"list","scope":a.scope})).unwrap()["proposals"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(execute(&db,&a,json!({"operation":"approve","requestId":"approve-stale-merge","proposalId":merge["proposalId"]})).is_err());
}
