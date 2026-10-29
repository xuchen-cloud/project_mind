// Included by write_tests to exercise the real authenticated dispatcher/store.
const CONTACTS: &str = "44444444444444444444444444444444";
const CONTACTS_READ: &str = "55555555555555555555555555555555";
#[tokio::test]
#[ignore = "requires the prepared native RecordDocumentWorker runtime"]
async fn prepared_contact_pinyin_matches_names_and_multiple_nicknames() {
    let f = contact_fixture();
    let worker = crate::record_document_worker::RecordDocumentWorker::development().unwrap();
    let original =
        json!({"requestId":"pinyin-add","fields":{"name":"张三","nicknames":"老张;三哥"}});
    let added = f
        .call(
            CONTACTS,
            "pinyin-add",
            "contact.create",
            original.clone(),
            &worker,
        )
        .await
        .unwrap();
    assert_eq!(added["contact"]["pinyinFull"], "zhangsan");
    assert_eq!(added["contact"]["pinyinAbbr"], "zs");
    let id = added["contact"]["id"].as_i64().unwrap();
    for query in [
        "zhangsan",
        "ZHANGSAN",
        "zs",
        "laozhang",
        "lz",
        "sange",
        "sg",
        "zhangsan sg",
    ] {
        let result = f
            .call(
                CONTACTS_READ,
                "pinyin-find",
                "contact.search",
                json!({"query":query}),
                &worker,
            )
            .await
            .unwrap();
        assert_eq!(result["totalCount"], 1, "{query}");
        assert_eq!(result["items"][0]["id"], id);
    }
    assert_eq!(
        f.call(CONTACTS, "pinyin-add", "contact.create", original, &worker)
            .await
            .unwrap(),
        added
    );
    let changed=f.call(CONTACTS,"pinyin-change","contact.update",json!({"id":id,"requestId":"pinyin-change","baseRevision":1,"fields":{"name":"李四","nicknames":"小李"}}),&worker).await.unwrap();
    assert_eq!(changed["contact"]["pinyinFull"], "lisi");
    for (query, count) in [
        ("zhangsan", 0),
        ("laozhang", 0),
        ("sange", 0),
        ("lisi", 1),
        ("ls", 1),
        ("xiaoli", 1),
        ("xl", 1),
    ] {
        let result = f
            .call(
                CONTACTS_READ,
                "pinyin-reread",
                "contact.search",
                json!({"query":query}),
                &worker,
            )
            .await
            .unwrap();
        assert_eq!(result["totalCount"], count, "{query}");
    }
    let aliases=f.call(CONTACTS,"pinyin-alias-only","contact.update",json!({"id":id,"requestId":"pinyin-alias-only","baseRevision":2,"fields":{"nicknames":"小四"}}),&worker).await.unwrap();
    assert_eq!(aliases["contact"]["pinyinFull"], "lisi");
    for (query, count) in [("xiaosi", 1), ("xs", 1), ("xiaoli", 0)] {
        let result = f
            .call(
                CONTACTS_READ,
                "pinyin-alias-find",
                "contact.search",
                json!({"query":query}),
                &worker,
            )
            .await
            .unwrap();
        assert_eq!(result["totalCount"], count, "{query}");
    }
}
fn contact_fixture() -> Fixture {
    let f = Fixture::new();
    for (id, operations) in [
        (CONTACTS, vec!["contact.read", "contact.write"]),
        (CONTACTS_READ, vec!["contact.read"]),
    ] {
        f.store
            .db
            .lock()
            .unwrap()
            .agent_connection_create(
                &f.binding,
                &ConnectionCreateInput {
                    client_label: "Address book fixture".into(),
                    workspace_content: false,
                    all_projects: false,
                    project_ids: vec![f.project_id],
                    write_operations: operations.into_iter().map(str::to_owned).collect(),
                },
                id,
                TOKEN,
            )
            .unwrap();
    }
    f
}
#[tokio::test]
async fn contact_write_rechecks_live_authority_after_pinyin_conversion() {
    let f = contact_fixture();
    let (worker, entered) = DocumentWorker::paused();
    let call = f.call(
        CONTACTS,
        "contact-paused",
        "contact.create",
        json!({"requestId":"contact-paused","fields":{"name":"Test"}}),
        &worker,
    );
    let pause = async {
        entered.await.unwrap();
        f.enabled.store(false, Ordering::Release);
        worker.resume.add_permits(1);
    };
    let (result, ()) = tokio::join!(call, pause);
    assert_eq!(result.unwrap_err().code, ErrorCode::RuntimeUnavailable);
    assert_eq!(
        f.store
            .db
            .lock()
            .unwrap()
            .contact_cli_list("", 50, 0)
            .unwrap()
            .total_count,
        0
    );
    assert_eq!(f.store.published.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn contact_bridge_partial_edits_receipts_search_and_catchup() {
    use crate::agent::changes::{ChangeInput, ChangeRepository};
    let f = contact_fixture();
    let worker = DocumentWorker::ready();
    let input = json!({"requestId":"contact-add","fields":{
        "name":"张三","nicknames":"老张； 三哥;老张","employeeId":"A_100%",
        "email":"Zhang.San@example.com","notes":"He said \"O'Brien\" & $x\n\\\\?\\D:\\商店\\资料",
    }});
    let saved = f
        .call(
            CONTACTS,
            "contact-add",
            "contact.create",
            input.clone(),
            &worker,
        )
        .await
        .unwrap();
    assert_eq!(saved["contact"]["nicknames"], "老张;三哥");
    assert_eq!(saved["contact"]["revision"], 1);
    let id = saved["contact"]["id"].as_i64().unwrap();
    assert_eq!(
        f.call(
            CONTACTS,
            "contact-add",
            "contact.create",
            input.clone(),
            &worker
        )
        .await
        .unwrap(),
        saved
    );
    let mut different = input;
    different["fields"]["name"] = json!("另一个人");
    assert_eq!(
        f.call(
            CONTACTS,
            "contact-add",
            "contact.create",
            different,
            &worker
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::IdempotencyConflict
    );
    for query in [
        "老张",
        "三哥",
        "A_100%",
        "zhang.san@EXAMPLE.com",
        "张三 example.com",
        "O'Brien",
        "\\\\?\\D:\\商店",
    ] {
        let result = f
            .call(
                CONTACTS_READ,
                "find-contact",
                "contact.search",
                json!({"query":query}),
                &worker,
            )
            .await
            .unwrap();
        assert_eq!(result["totalCount"], 1, "{query}");
        assert_eq!(result["items"][0]["id"], id);
    }
    let patch = json!({"id":id,"requestId":"contact-email","baseRevision":1,"fields":{"email":"new@example.com"}});
    let updated = f
        .call(
            CONTACTS,
            "contact-email",
            "contact.update",
            patch.clone(),
            &worker,
        )
        .await
        .unwrap();
    assert_eq!(updated["contact"]["revision"], 2);
    assert_eq!(updated["contact"]["name"], "张三");
    assert_eq!(updated["contact"]["nicknames"], "老张;三哥");
    assert_eq!(updated["contact"]["notes"], saved["contact"]["notes"]);
    assert_eq!(
        f.call(CONTACTS, "contact-email", "contact.update", patch, &worker)
            .await
            .unwrap(),
        updated
    );
    assert_eq!(f.call(CONTACTS,"stale-contact","contact.update",json!({"id":id,"requestId":"stale-contact","baseRevision":1,"fields":{"notes":"overwrite"}}),&worker).await.unwrap_err().code,ErrorCode::RevisionConflict);
    assert_eq!(f.call(CONTACTS_READ,"denied-contact","contact.update",json!({"id":id,"requestId":"denied-contact","baseRevision":2,"fields":{"notes":"overwrite"}}),&worker).await.unwrap_err().code,ErrorCode::ScopeDenied);
    assert_eq!(
        f.call(
            READ_ONLY,
            "denied-read",
            "contact.get",
            json!({"id":id}),
            &worker
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::ScopeDenied
    );
    let read = f
        .call(
            CONTACTS_READ,
            "contact-read",
            "contact.get",
            json!({"id":id}),
            &worker,
        )
        .await
        .unwrap();
    assert_eq!(read, updated["contact"]);
    let db = f.store.db.lock().unwrap();
    let changes = db
        .agent_changes_list(
            &ScopeGrant {
                workspace_id: f.binding.workspace_id.clone(),
                workspace_content: true,
                project_ids: vec![],
                operations: vec!["changes.read".into()],
                object_keys: None,
            },
            &ChangeInput {
                after_seq: 0,
                limit: 200,
            },
        )
        .unwrap();
    let contacts = changes
        .entries
        .iter()
        .filter(|entry| {
            entry
                .object_key
                .ends_with(&format!("/workspace/contact/{id}"))
        })
        .collect::<Vec<_>>();
    assert_eq!(
        contacts.len(),
        2,
        "replays and denied writes produce no extra change"
    );
    assert_eq!(contacts[1].revision, "2");
    assert_eq!(f.store.published.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn contact_bridge_clear_empty_patch_revocation_and_workspace_identity() {
    let f = contact_fixture();
    let worker = DocumentWorker::ready();
    let saved=f.call(CONTACTS,"contact-new","contact.create",json!({"requestId":"contact-new","fields":{"name":"Name","notes":"keep","nicknames":"N"}}),&worker).await.unwrap();
    let id = saved["contact"]["id"].as_i64().unwrap();
    let cleared = f
        .call(
            CONTACTS,
            "contact-clear",
            "contact.update",
            json!({"id":id,"baseRevision":1,"requestId":"contact-clear","fields":{"nicknames":""}}),
            &worker,
        )
        .await
        .unwrap();
    assert_eq!(cleared["contact"]["nicknames"], "");
    assert_eq!(cleared["contact"]["notes"], "keep");
    for fields in [json!({}), json!({"notes":null}), json!({"name":""})] {
        assert_eq!(
            f.call(
                CONTACTS,
                "bad-contact",
                "contact.update",
                json!({"id":id,"baseRevision":2,"requestId":"bad-contact","fields":fields}),
                &worker
            )
            .await
            .unwrap_err()
            .code,
            ErrorCode::InvalidArgument
        );
    }
    assert_eq!(
        f.call(
            CONTACTS_READ,
            "missing-contact",
            "contact.get",
            json!({"id":999999}),
            &worker
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::NotFound
    );
    f.enabled.store(false, Ordering::Release);
    assert_eq!(
        f.call(
            CONTACTS_READ,
            "disabled-contact",
            "contact.list",
            json!({}),
            &worker
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::RuntimeUnavailable
    );
    f.enabled.store(true, Ordering::Release);
    f.store.binding.lock().unwrap().generation = "reopened".into();
    assert_eq!(
        f.call(
            CONTACTS_READ,
            "reopened-contact",
            "contact.list",
            json!({}),
            &worker
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::WorkspaceChanged
    );
}
