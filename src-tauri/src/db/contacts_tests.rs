use super::*;
use crate::models::WorkspaceSearchInput;
use std::collections::HashSet;

fn database() -> (tempfile::TempDir, Database) {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open(&root.path().join("contacts.sqlite"), root.path(), None).unwrap();
    (root, db)
}
fn fields(name: &str) -> ContactFields {
    ContactFields {
        name: Some(name.into()),
        ..Default::default()
    }
}
fn gui(id: Option<i64>, revision: Option<u64>) -> ContactUpsertInput {
    ContactUpsertInput {
        id,
        base_revision: revision,
        name: "Alice".into(),
        pinyin_full: None,
        pinyin_abbr: None,
        email: None,
        employee_id: None,
        role: None,
        department: None,
        nicknames: None,
        nickname_pinyin: None,
        notes: None,
    }
}
#[test]
fn contact_partial_cas_noop_and_transaction_rollback() {
    let (_root, mut db) = database();
    let created = create(
        &db.conn,
        &ContactFields {
            nicknames: Some(" 阿里 ；Alice;阿里;; x,y|z ".into()),
            notes: Some("first line\n第二行".into()),
            email: Some("a@example.com".into()),
            ..fields("Alice")
        },
    )
    .unwrap();
    assert_eq!(created.nicknames, "阿里;Alice;x,y|z");
    assert_eq!(created.revision, 1);
    assert_eq!(
        serde_json::from_value::<ContactRecord>(serde_json::to_value(&created).unwrap()).unwrap(),
        created
    );
    let patch: ContactFields = serde_json::from_value(serde_json::json!({"email":""})).unwrap();
    let updated = update(&db.conn, created.id, 1, &patch).unwrap();
    assert_eq!(updated.notes, created.notes);
    assert_eq!(updated.nicknames, created.nicknames);
    assert_eq!(updated.email, "");
    assert_eq!(updated.revision, 2);
    let noop = update(&db.conn, created.id, 2, &patch).unwrap();
    assert_eq!(noop, updated);
    let stale = update(
        &db.conn,
        created.id,
        1,
        &ContactFields {
            notes: Some("stale".into()),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(stale.code, ErrorCode::RevisionConflict);
    assert_eq!(stale.details.unwrap()["currentRevision"], 2);
    assert_eq!(get(&db.conn, created.id).unwrap(), updated);
    assert_eq!(
        update(&db.conn, created.id, 2, &Default::default())
            .unwrap_err()
            .code,
        ErrorCode::InvalidArgument
    );
    {
        let transaction = db.conn.transaction().unwrap();
        update(
            &transaction,
            created.id,
            2,
            &ContactFields {
                notes: Some("rolled back".into()),
                ..Default::default()
            },
        )
        .unwrap();
        create(&transaction, &fields("rolled back person")).unwrap();
    }
    assert_eq!(get(&db.conn, created.id).unwrap(), updated);
    assert_eq!(search(&db.conn, "", 50, 0).unwrap().total_count, 1);
    let cleared = update(
        &db.conn,
        created.id,
        2,
        &ContactFields {
            nicknames: Some("".into()),
            notes: Some("".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(cleared.revision, 3);
    assert_eq!(cleared.notes, "");
    assert_eq!(cleared.nicknames, "");
}
#[test]
fn contact_gui_baseline_rejects_cli_changes_and_legacy_preserves_new_fields() {
    let (_root, mut db) = database();
    let created = db.contact_upsert(gui(None, None)).unwrap();
    let saved = update(
        &db.conn,
        created.id,
        1,
        &ContactFields {
            nicknames: Some("new alias".into()),
            notes: Some("CLI notes".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let mut draft = gui(Some(created.id), Some(created.revision));
    draft.nicknames = Some("old alias".into());
    let error = db.contact_upsert(draft).unwrap_err().to_string();
    assert!(error.starts_with("REVISION_CONFLICT:"));
    assert!(error.contains("currentRevision=2"));
    assert_eq!(get(&db.conn, created.id).unwrap(), saved);
    let legacy = db.contact_upsert(gui(Some(created.id), None)).unwrap();
    assert_eq!(legacy, saved); // omitted new fields and same legacy fields are a no-op
    let mut fresh = gui(Some(created.id), Some(saved.revision));
    fresh.notes = Some("GUI notes".into());
    let result = db.contact_upsert(fresh).unwrap();
    assert_eq!(result.revision, 3);
    assert_eq!(result.nicknames, saved.nicknames);
}
#[test]
fn contact_search_terms_across_fields_literals_unicode_and_all_pages() {
    let (_root, mut db) = database();
    let created = create(
        &db.conn,
        &ContactFields {
            email: Some("alice@EXAMPLE.com".into()),
            employee_id: Some("E_007".into()),
            department: Some("平台".into()),
            role: Some("Owner".into()),
            pinyin_full: Some("aLiCe".into()),
            pinyin_abbr: Some("AL".into()),
            nicknames: Some("小爱;ÖZI".into()),
            notes: Some("排期 100% C:\\Work\n第二行".into()),
            ..fields("爱丽丝")
        },
    )
    .unwrap();
    for query in [
        "小爱 平台",
        "ALICE E_007",
        "owner example.com",
        "özi 第二行",
        "100% C:\\Work",
        "AL",
    ] {
        let page = search(&db.conn, query, 50, 0).unwrap();
        assert_eq!(
            page.items.iter().map(|v| v.id).collect::<Vec<_>>(),
            vec![created.id],
            "{query}"
        );
        let gui = db
            .contact_search(ContactSearchInput {
                query: query.into(),
                limit: None,
            })
            .unwrap();
        assert_eq!(gui, page.items);
        let global = db
            .workspace_search(WorkspaceSearchInput {
                query: query.into(),
                include_archived: None,
                project_id: None,
            })
            .unwrap();
        assert!(
            global
                .iter()
                .any(|item| item.kind == "contact" && item.id == created.id),
            "global query: {query}"
        );
    }
    for query in ["missing", "100_", "E%007", "爱丽丝 absent"] {
        assert!(
            search(&db.conn, query, 50, 0).unwrap().items.is_empty(),
            "{query}"
        );
    }
    for index in 0..124 {
        create(&db.conn, &fields(&format!("person {index}"))).unwrap();
    }
    let mut seen = HashSet::new();
    let mut offset = 0;
    let mut ordered = Vec::new();
    loop {
        let page = search(&db.conn, "", 17, offset).unwrap();
        assert_eq!(page.total_count, 125);
        for item in page.items {
            assert!(seen.insert(item.id));
            ordered.push(item.id);
        }
        match page.next_offset {
            Some(next) => {
                assert!(page.has_more);
                assert!(next > offset);
                offset = next;
            }
            None => {
                assert!(!page.has_more);
                break;
            }
        }
    }
    assert_eq!(seen.len(), 125);
    assert_eq!(
        ordered,
        db.contact_list()
            .unwrap()
            .iter()
            .map(|v| v.id)
            .collect::<Vec<_>>()
    );
    assert!(search(&db.conn, "", 17, usize::MAX)
        .unwrap()
        .items
        .is_empty());
}
#[test]
fn contact_limits_empty_patch_unknown_fields_and_missing_record() {
    let (_root, mut db) = database();
    assert_eq!(
        create(&db.conn, &Default::default()).unwrap_err().code,
        ErrorCode::InvalidArgument
    );
    assert!(serde_json::from_value::<ContactFields>(serde_json::json!({"bogus":"x"})).is_err());
    for field in [
        "name",
        "pinyinFull",
        "pinyinAbbr",
        "email",
        "employeeId",
        "role",
        "department",
        "nicknames",
        "notes",
    ] {
        let mut value = serde_json::json!({"name":"张三"});
        value[field] = serde_json::Value::Null;
        assert!(
            serde_json::from_value::<ContactFields>(value).is_err(),
            "{field}"
        );
    }
    let serialized = serde_json::to_value(fields("张三")).unwrap();
    assert_eq!(serialized, serde_json::json!({"name":"张三"}));
    assert_eq!(
        serde_json::from_value::<ContactFields>(serialized)
            .unwrap()
            .name
            .as_deref(),
        Some("张三")
    );
    let schema = serde_json::to_value(schemars::schema_for!(ContactFields)).unwrap();
    assert!(schema.get("required").is_none());
    for field in ["name", "nicknames", "notes"] {
        assert_eq!(schema["properties"][field]["type"], "string");
    }
    assert_eq!(
        get(&db.conn, 0).unwrap_err().code,
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        update(&db.conn, 1, 0, &fields("x")).unwrap_err().code,
        ErrorCode::InvalidArgument
    );
    assert_eq!(get(&db.conn, 100).unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(
        update(&db.conn, 100, 1, &fields("x")).unwrap_err().code,
        ErrorCode::NotFound
    );
    for (nick, notes, valid) in [
        ("中".repeat(1000), "文".repeat(10000), true),
        ("中".repeat(1001), "".into(), false),
        ("".into(), "文".repeat(10001), false),
    ] {
        let result = create(
            &db.conn,
            &ContactFields {
                nicknames: Some(nick),
                notes: Some(notes),
                ..fields("valid")
            },
        );
        assert_eq!(result.is_ok(), valid);
    }
    let baseline = create(
        &db.conn,
        &ContactFields {
            nickname_pinyin: Some("a".repeat(8192)),
            ..fields("nickname budget")
        },
    )
    .unwrap();
    let oversized = ContactFields {
        nickname_pinyin: Some("a".repeat(8193)),
        ..Default::default()
    };
    assert_eq!(
        update(&db.conn, baseline.id, 1, &oversized)
            .unwrap_err()
            .code,
        ErrorCode::InvalidArgument
    );
    assert_eq!(get(&db.conn, baseline.id).unwrap(), baseline);
    let mut oversized_gui = gui(Some(baseline.id), Some(1));
    oversized_gui.nickname_pinyin = oversized.nickname_pinyin;
    assert!(db
        .contact_upsert(oversized_gui)
        .unwrap_err()
        .to_string()
        .contains("8192"));
    assert_eq!(get(&db.conn, baseline.id).unwrap(), baseline);
    for limit in [0, 201] {
        assert_eq!(
            search(&db.conn, "", limit, 0).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
    }
}
#[test]
fn contact_schema_38_upgrade_retains_existing_contact_and_defaults() {
    let (root, db) = database();
    let original = create(&db.conn, &fields("old contact")).unwrap();
    db.conn.execute_batch("ALTER TABLE contacts DROP COLUMN nicknames; ALTER TABLE contacts DROP COLUMN notes; ALTER TABLE contacts DROP COLUMN nickname_pinyin; ALTER TABLE contacts DROP COLUMN revision; PRAGMA user_version=38;").unwrap();
    drop(db);
    let reopened = Database::open(&root.path().join("contacts.sqlite"), root.path(), None).unwrap();
    assert_eq!(get(&reopened.conn, original.id).unwrap(), original);
    assert_eq!(
        reopened.schema_version().unwrap(),
        super::super::CURRENT_SCHEMA_VERSION
    );
    let changed = update(
        &reopened.conn,
        original.id,
        1,
        &ContactFields {
            notes: Some("new notes".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(changed.revision, 2);
}
#[test]
fn contact_two_connections_reject_stale_revision_even_for_noop() {
    let (root, db) = database();
    let original = create(&db.conn, &fields("Alice")).unwrap();
    let other = Connection::open(root.path().join("contacts.sqlite")).unwrap();
    let latest = update(
        &other,
        original.id,
        1,
        &ContactFields {
            notes: Some("external".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let stale = update(&db.conn, original.id, 1, &fields("Alice")).unwrap_err();
    assert_eq!(stale.code, ErrorCode::RevisionConflict);
    assert_eq!(get(&db.conn, original.id).unwrap(), latest);
}

#[test]
fn contact_rename_refreshes_only_omitted_pinyin_and_preserves_other_fields() {
    let (_root, db) = database();
    let original = create(
        &db.conn,
        &ContactFields {
            pinyin_full: Some("zhangsan".into()),
            pinyin_abbr: Some("zs".into()),
            notes: Some("keep".into()),
            ..fields("张三")
        },
    )
    .unwrap();
    let same = update(&db.conn, original.id, 1, &fields(" 张三 ")).unwrap();
    assert_eq!(same, original);
    let renamed = update(&db.conn, original.id, 1, &fields("李四")).unwrap();
    assert_eq!(renamed.pinyin_full, "");
    assert_eq!(renamed.pinyin_abbr, "");
    assert_eq!(renamed.notes, "keep");
    assert!(search(&db.conn, "zhangsan", 10, 0)
        .unwrap()
        .items
        .is_empty());
    let explicit = update(
        &db.conn,
        original.id,
        2,
        &ContactFields {
            pinyin_full: Some("WANGWU".into()),
            pinyin_abbr: Some("WW".into()),
            ..fields("王五")
        },
    )
    .unwrap();
    assert_eq!(explicit.pinyin_full, "wangwu");
    assert_eq!(explicit.pinyin_abbr, "ww");
    let ascii = update(
        &db.conn,
        original.id,
        3,
        &ContactFields {
            pinyin_abbr: Some("BC".into()),
            ..fields("Bob Chen")
        },
    )
    .unwrap();
    assert_eq!(ascii.pinyin_full, "bobchen");
    assert_eq!(ascii.pinyin_abbr, "bc");
    assert_eq!(ascii.notes, "keep");
}

#[test]
fn contact_schema_38_migration_authorizer_rejects_unrelated_business_reads_or_writes() {
    use rusqlite::ffi;
    use std::{
        ffi::CStr,
        os::raw::{c_char, c_int, c_void},
    };
    // Deny even reads of non-contact business tables: the previous migration
    // would scan/backfill these. SQLite's ALTER internals access its catalog and
    // pragma_quick_check while validating the new column constraint.
    unsafe extern "C" fn contact_only(
        _: *mut c_void,
        action: c_int,
        first: *const c_char,
        second: *const c_char,
        _db: *const c_char,
        _trigger: *const c_char,
    ) -> c_int {
        let arg = if action == ffi::SQLITE_ALTER_TABLE {
            second
        } else {
            first
        };
        let table = if arg.is_null() {
            ""
        } else {
            unsafe { CStr::from_ptr(arg) }.to_str().unwrap_or("")
        };
        if matches!(
            action,
            ffi::SQLITE_READ
                | ffi::SQLITE_UPDATE
                | ffi::SQLITE_INSERT
                | ffi::SQLITE_DELETE
                | ffi::SQLITE_ALTER_TABLE
        ) && table != "contacts"
            && !table.starts_with("sqlite_")
            && table != "pragma_quick_check"
        {
            return ffi::SQLITE_DENY;
        }
        ffi::SQLITE_OK
    }
    let (_root, mut db) = database();
    db.conn.execute_batch("INSERT INTO projects(id,name,root_path,summary_markdown,summary_html,created_at,updated_at) VALUES(1,'untouched','workspace:untouched','keep summary','','before','before');
        INSERT INTO workspace_notes(id,title,content_markdown,content_html,created_at,updated_at) VALUES(1,'keep','keep body','<p>keep body</p>','before','before');
        INSERT INTO record_document_heads(record_key,workspace_note_id,head_revision,document_json,html,markdown,text,body_hash,schema_version,updated_at)
        VALUES('workspace/record/1',1,7,'{}','<p>keep body</p>','keep body','keep body','keep-hash',1,'before');
        ALTER TABLE contacts DROP COLUMN nicknames;
        ALTER TABLE contacts DROP COLUMN notes; ALTER TABLE contacts DROP COLUMN nickname_pinyin;
        ALTER TABLE contacts DROP COLUMN revision;
        PRAGMA user_version=38;").unwrap();
    let installed = unsafe {
        ffi::sqlite3_set_authorizer(db.conn.handle(), Some(contact_only), std::ptr::null_mut())
    };
    assert_eq!(installed, ffi::SQLITE_OK);
    let result = db.migrate();
    unsafe {
        ffi::sqlite3_set_authorizer(db.conn.handle(), None, std::ptr::null_mut());
    }
    result.unwrap();
    assert_eq!(db.schema_version().unwrap(), 39);
    let summary: (String, String, String) = db
        .conn
        .query_row(
            "SELECT summary_markdown,summary_html,updated_at FROM projects WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(summary, ("keep summary".into(), "".into(), "before".into()));
    let head: (i64,String,String,String)=db.conn.query_row("SELECT head_revision,markdown,body_hash,updated_at FROM record_document_heads WHERE record_key='workspace/record/1'",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).unwrap();
    assert_eq!(
        head,
        (7, "keep body".into(), "keep-hash".into(), "before".into())
    );
    let body: (String, String, String) = db
        .conn
        .query_row(
            "SELECT content_markdown,content_html,updated_at FROM workspace_notes WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        body,
        (
            "keep body".into(),
            "<p>keep body</p>".into(),
            "before".into()
        )
    );
}

#[test]
fn contact_nickname_pinyin_is_internal_searchable_and_cleared_only_on_rename() {
    let (_root, mut db) = database();
    let created = create(
        &db.conn,
        &ContactFields {
            nicknames: Some("老张;三哥".into()),
            nickname_pinyin: Some("laozhang lz sange sg".into()),
            notes: Some("keep".into()),
            ..fields("张三")
        },
    )
    .unwrap();
    for query in ["LAOZHANG", "lz", "sg", "sange keep"] {
        assert_eq!(
            search(&db.conn, query, 50, 0).unwrap().items[0].id,
            created.id
        );
        assert_eq!(
            db.contact_search(ContactSearchInput {
                query: query.into(),
                limit: None
            })
            .unwrap()[0]
                .id,
            created.id
        );
        let global = db
            .workspace_search(WorkspaceSearchInput {
                query: query.into(),
                include_archived: None,
                project_id: None,
            })
            .unwrap();
        assert!(
            global
                .iter()
                .any(|item| item.kind == "contact" && item.id == created.id),
            "{query}"
        );
    }
    let json = serde_json::to_value(&created).unwrap();
    assert!(json.get("nicknamePinyin").is_none());
    assert!(json.get("nickname_pinyin").is_none());
    let schema = serde_json::to_value(schemars::schema_for!(ContactFields)).unwrap();
    assert!(schema["properties"].get("nicknamePinyin").is_none());
    for field in ["nicknamePinyin", "nickname_pinyin"] {
        let mut json = serde_json::json!({"name":"张三"});
        json[field] = serde_json::json!("spoof");
        assert!(
            serde_json::from_value::<ContactFields>(json).is_err(),
            "{field}"
        );
    }
    let unchanged = update(
        &db.conn,
        created.id,
        1,
        &ContactFields {
            nicknames: Some("老张； 三哥;老张".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(unchanged, created);
    let other = update(
        &db.conn,
        created.id,
        1,
        &ContactFields {
            notes: Some("new notes".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(other.nickname_pinyin, created.nickname_pinyin);
    let renamed = update(
        &db.conn,
        created.id,
        2,
        &ContactFields {
            nicknames: Some("老李".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(renamed.nickname_pinyin, "");
    assert!(search(&db.conn, "laozhang", 50, 0)
        .unwrap()
        .items
        .is_empty());
    let mut input = gui(Some(created.id), Some(3));
    input.nicknames = Some("老王".into());
    input.nickname_pinyin = Some("laowang lw".into());
    let saved = db.contact_upsert(input).unwrap();
    assert_eq!(saved.nickname_pinyin, "laowang lw");
    assert_eq!(saved.revision, 4);
    assert_eq!(
        search(&db.conn, "lw", 50, 0).unwrap().items[0].id,
        created.id
    );
}

#[test]
fn contact_empty_search_keeps_creation_order_instead_of_ranking_empty_pinyin() {
    let (_root, db) = database();
    let older = create(&db.conn, &fields("无拼音")).unwrap();
    let newer = create(&db.conn, &fields("Alice")).unwrap();
    db.conn
        .execute("UPDATE contacts SET created_at='same-time'", [])
        .unwrap();
    let page = search(&db.conn, " ", 50, 0).unwrap();
    assert_eq!(
        page.items.iter().map(|item| item.id).collect::<Vec<_>>(),
        vec![newer.id, older.id]
    );
}

#[test]
fn contact_search_absolute_field_priority_beats_match_strength_in_all_entrypoints() {
    let (_root, mut db) = database();
    let cases = [
        ContactFields {
            employee_id: Some("x-probe-z".into()),
            ..fields("employee")
        },
        ContactFields {
            email: Some("probe".into()),
            ..fields("email")
        },
        fields("probe"),
        ContactFields {
            nicknames: Some("probe".into()),
            ..fields("nickname")
        },
        ContactFields {
            pinyin_full: Some("probe".into()),
            ..fields("full name")
        },
        ContactFields {
            nickname_pinyin: Some("probe p".into()),
            ..fields("full alias")
        },
        ContactFields {
            pinyin_abbr: Some("probe".into()),
            ..fields("abbr name")
        },
        ContactFields {
            nickname_pinyin: Some("unrelated probe".into()),
            ..fields("abbr alias")
        },
        ContactFields {
            department: Some("probe".into()),
            ..fields("department")
        },
        ContactFields {
            role: Some("probe".into()),
            ..fields("role")
        },
        ContactFields {
            notes: Some("probe".into()),
            ..fields("notes")
        },
    ];
    let mut ids = Vec::new();
    for fields in cases {
        ids.push(create(&db.conn, &fields).unwrap().id);
    }
    // Reverse-priority creation makes an accidental timestamp-only order fail.
    db.conn
        .execute(
            "UPDATE contacts SET created_at='same',updated_at='same'",
            [],
        )
        .unwrap();
    let expected = vec![
        ids[0], ids[1], ids[2], ids[3], ids[5], ids[4], ids[7], ids[6], ids[10], ids[9], ids[8],
    ];
    let all = search(&db.conn, "probe", 50, 0).unwrap();
    assert_eq!(
        all.items.iter().map(|item| item.id).collect::<Vec<_>>(),
        expected
    );
    let gui = db
        .contact_search(ContactSearchInput {
            query: "probe".into(),
            limit: Some(50),
        })
        .unwrap();
    assert_eq!(gui, all.items);
    let global = db
        .workspace_search(WorkspaceSearchInput {
            query: "probe".into(),
            include_archived: None,
            project_id: None,
        })
        .unwrap();
    assert_eq!(
        global
            .into_iter()
            .filter(|item| item.kind == "contact")
            .map(|item| item.id)
            .collect::<Vec<_>>(),
        // Global search preserves its existing ID ASC tie; contact list uses DESC.
        ids
    );
    let first = search(&db.conn, "probe", 4, 0).unwrap();
    let second = search(&db.conn, "probe", 4, first.next_offset.unwrap()).unwrap();
    assert_eq!(
        first
            .items
            .into_iter()
            .chain(second.items)
            .map(|item| item.id)
            .collect::<Vec<_>>(),
        expected[..8]
    );
}

#[test]
fn contact_search_match_strength_is_within_field_and_and_filter_stays_cross_field() {
    let (_root, mut db) = database();
    let exact = create(
        &db.conn,
        &ContactFields {
            employee_id: Some("probe".into()),
            department: Some("Platform".into()),
            ..fields("exact")
        },
    )
    .unwrap();
    let prefix = create(
        &db.conn,
        &ContactFields {
            employee_id: Some("probe-7".into()),
            department: Some("Platform".into()),
            ..fields("prefix")
        },
    )
    .unwrap();
    let contains = create(
        &db.conn,
        &ContactFields {
            employee_id: Some("7-probe-7".into()),
            role: Some("Platform".into()),
            ..fields("contains")
        },
    )
    .unwrap();
    let weaker = create(
        &db.conn,
        &ContactFields {
            email: Some("probe".into()),
            notes: Some("Platform".into()),
            ..fields("weaker")
        },
    )
    .unwrap();
    create(
        &db.conn,
        &ContactFields {
            employee_id: Some("probe".into()),
            ..fields("excluded")
        },
    )
    .unwrap();
    let expected = vec![exact.id, prefix.id, contains.id, weaker.id];
    let page = search(&db.conn, "PROBE platform", 50, 0).unwrap();
    assert_eq!(
        page.items.iter().map(|item| item.id).collect::<Vec<_>>(),
        expected
    );
    let global = db
        .workspace_search(WorkspaceSearchInput {
            query: "PROBE platform".into(),
            include_archived: None,
            project_id: None,
        })
        .unwrap();
    assert_eq!(
        global
            .into_iter()
            .filter(|item| item.kind == "contact")
            .map(|item| item.id)
            .collect::<Vec<_>>(),
        expected
    );
    // Unicode whitespace uses the same nonempty terms in filtering and ranking.
    let unicode_query = "PROBE\u{2003}platform";
    assert_eq!(
        search(&db.conn, unicode_query, 50, 0)
            .unwrap()
            .items
            .iter()
            .map(|item| item.id)
            .collect::<Vec<_>>(),
        expected
    );
    let unicode_global = db
        .workspace_search(WorkspaceSearchInput {
            query: unicode_query.into(),
            include_archived: None,
            project_id: None,
        })
        .unwrap();
    assert_eq!(
        unicode_global
            .into_iter()
            .filter(|item| item.kind == "contact")
            .map(|item| item.id)
            .collect::<Vec<_>>(),
        expected
    );
    assert!(db
        .workspace_search(WorkspaceSearchInput {
            query: " \u{2003} ".into(),
            include_archived: None,
            project_id: None
        })
        .unwrap()
        .is_empty());
    let changed = update(
        &db.conn,
        weaker.id,
        1,
        &ContactFields {
            department: Some("Security".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(changed.department, "Security");
    assert_eq!(
        search(&db.conn, "probe Security", 50, 0).unwrap().items[0].id,
        weaker.id
    );
}

#[test]
fn contact_nickname_pinyin_pairs_keep_full_before_abbr_even_after_empty_or_duplicate_aliases() {
    let (_root, db) = database();
    let full = create(
        &db.conn,
        &ContactFields {
            nickname_pinyin: Some("a a laozhang lz probe p".into()),
            ..fields("full")
        },
    )
    .unwrap();
    let abbr = create(
        &db.conn,
        &ContactFields {
            nickname_pinyin: Some("a a unrelated probe".into()),
            ..fields("abbr")
        },
    )
    .unwrap();
    let truncated_full = create(
        &db.conn,
        &ContactFields {
            nickname_pinyin: Some("a a probe".into()),
            ..fields("truncated")
        },
    )
    .unwrap();
    assert_eq!(search_rank(&full, "probe").unwrap().field_priority, 4);
    assert_eq!(search_rank(&abbr, "probe").unwrap().field_priority, 5);
    assert_eq!(
        search_rank(&truncated_full, "probe")
            .unwrap()
            .field_priority,
        4
    );
    assert_eq!(
        search(&db.conn, "probe", 50, 0)
            .unwrap()
            .items
            .iter()
            .map(|item| item.id)
            .collect::<Vec<_>>(),
        vec![truncated_full.id, full.id, abbr.id]
    );
}
