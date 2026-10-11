use super::*;
use crate::{
    db::Database,
    models::ProjectCreateInput,
    record_documents::{
        body_hash, RecordCheckpointInput, RecordCheckpointReason, RecordCreate,
        RecordDocumentCommit, RecordDocumentProjection, RecordVersionOrigin,
    },
};
use std::{fs, path::PathBuf};
const WORKSPACE: &str = "reference-workspace";
fn fixture() -> (tempfile::TempDir, Database, Scope, Value) {
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace(WORKSPACE).unwrap();
    let project = db
        .project_create(ProjectCreateInput {
            name: "Evidence".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    fs::write(
        PathBuf::from(&project.root_path).join("evidence.txt"),
        b"first evidence",
    )
    .unwrap();
    let file = db
        .project_file_register(WORKSPACE, project.id, "evidence.txt")
        .unwrap();
    let source = json!({"object":file.object,"revision":file.content_hash.unwrap(),"fileVersion":file.version_number,
        "recordVersion":null,"blockId":null,"locator":{"kind":"paragraph","start":1,"end":2},"title":"evidence.txt","excerpt":"first evidence"});
    let document = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"a".repeat(32)},"content":[
        {"type":"internalReference","attrs":{"refKind":"document","refId":source["object"]["id"],"label":"Evidence","sourceRef":source}}]}]});
    (
        root,
        db,
        Scope::Project {
            project_id: project.id,
        },
        document,
    )
}
fn source_mut(document: &mut Value) -> &mut Value {
    &mut document["content"][0]["content"][0]["attrs"]["sourceRef"]
}
fn projection(document: Value) -> RecordDocumentProjection {
    RecordDocumentProjection {
        schema_version: 1,
        body_hash: body_hash(&document, &None),
        document,
        html: "<p>Evidence</p>".into(),
        markdown: "Evidence".into(),
        text: "Evidence".into(),
        code_language: None,
    }
}
#[test]
fn fixed_file_locator_accepts_zero_based_page_offsets_and_one_based_lines() {
    let (_root, db, scope, document) = fixture();
    for locator in [
        json!({"kind":"line","start":1,"end":3}),
        json!({"kind":"page","page":2,"start":0,"end":19}),
    ] {
        let mut valid = document.clone();
        source_mut(&mut valid)["locator"] = locator;
        projection(valid.clone()).validate().unwrap();
        validate_references(&db.conn, &scope, &valid, &Default::default(), WORKSPACE).unwrap();
    }
    for locator in [
        json!({"kind":"line","start":0,"end":3}),
        json!({"kind":"paragraph","start":0,"end":3}),
        json!({"kind":"line","start":3,"end":2}),
        json!({"kind":"page","page":0,"start":0,"end":19}),
        json!({"kind":"page","page":2,"start":-1,"end":19}),
        json!({"kind":"page","page":2,"start":19,"end":0}),
        json!({"kind":"page","page":2,"start":0,"end":0}),
        json!({"kind":"page","page":2,"start":19,"end":19}),
    ] {
        let mut invalid = document.clone();
        source_mut(&mut invalid)["locator"] = locator;
        assert!(projection(invalid.clone()).validate().is_err());
        assert!(validate_references(&db.conn, &scope, &invalid, &Default::default(), WORKSPACE).is_err());
    }
}
#[test]
fn fixed_file_references_validate_actual_workspace_project_version_and_hash() {
    let (_root, db, scope, document) = fixture();
    validate_references(&db.conn, &scope, &document, &Default::default(), WORKSPACE).unwrap();
    for (field, value) in [
        ("revision", json!(format!("sha256:{}", "b".repeat(64)))),
        ("fileVersion", json!(99)),
    ] {
        let mut forged = document.clone();
        source_mut(&mut forged)[field] = value;
        assert_eq!(
            validate_references(&db.conn, &scope, &forged, &Default::default(), WORKSPACE)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
    }
    let mut forged = document.clone();
    source_mut(&mut forged)["object"]["workspaceId"] = json!("other-workspace");
    assert_eq!(
        validate_references(&db.conn, &scope, &forged, &Default::default(), WORKSPACE)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    let mut forged = document.clone();
    source_mut(&mut forged)["object"]["scope"]["projectId"] = json!(999);
    assert_eq!(
        validate_references(
            &db.conn,
            &Scope::Workspace,
            &forged,
            &Default::default(),
            WORKSPACE
        )
        .unwrap_err()
        .code,
        ErrorCode::ScopeDenied
    );
    let mut forged = document.clone();
    source_mut(&mut forged)["object"]["id"] = json!("999");
    assert_eq!(
        validate_references(&db.conn, &scope, &forged, &Default::default(), WORKSPACE)
            .unwrap_err()
            .code,
        ErrorCode::InvalidPatch
    );
}
#[test]
fn fixed_evidence_cas_rejection_leaves_body_and_edges_unchanged() {
    let (_root, db, scope, document) = fixture();
    let p = projection(document.clone());
    p.validate().unwrap();
    let input = RecordCreate {
        scope: scope.clone(),
        title: Some("Evidence Record".into()),
        tag_ids: vec![],
        document: document.clone(),
        code_language: None,
    };
    let head = db
        .record_create("gui", "create-evidence", &input, &p, WORKSPACE)
        .unwrap();
    let edges = || {
        db.conn.query_row("SELECT target_revision,locator_json FROM content_reference_edges WHERE relation='internal_reference'",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap()
    };
    let before = edges();
    assert_eq!(
        before.0,
        document["content"][0]["content"][0]["attrs"]["sourceRef"]["revision"]
            .as_str()
            .unwrap()
    );
    let locator: Value = serde_json::from_str(&before.1).unwrap();
    assert_eq!(
        locator["sourceRef"],
        document["content"][0]["content"][0]["attrs"]["sourceRef"]
    );
    let mut forged = document.clone();
    source_mut(&mut forged)["revision"] = json!(format!("sha256:{}", "b".repeat(64)));
    let commit = RecordDocumentCommit {
        target: head.target.clone(),
        base_revision: head.head_revision,
        projection: projection(forged),
        origin: RecordVersionOrigin::Manual,
        actor: json!({"kind":"gui"}),
        edit_session_id: Some("c".repeat(32)),
    };
    assert_eq!(
        db.record_document_commit("gui", "forge-evidence", &commit, WORKSPACE)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    assert_eq!(
        db.record_document_head(&head.target)
            .unwrap()
            .unwrap()
            .head_revision,
        head.head_revision
    );
    assert_eq!(edges(), before);
    let mut stale = commit;
    stale.base_revision = 2;
    stale.projection = p;
    assert_eq!(
        db.record_document_commit("gui", "stale-evidence", &stale, WORKSPACE)
            .unwrap_err()
            .code,
        ErrorCode::RevisionConflict
    );
    assert_eq!(edges(), before);
}
#[test]
fn fixed_evidence_survives_update_and_deleted_target_without_permitting_forged_retention() {
    let (_root, mut db, scope, document) = fixture();
    let retained = reference_identities(&document).unwrap();
    let target = RecordTarget {
        scope: scope.clone(),
        record_id: 88,
    };
    write_reference_edges(&db.conn, &target, &document, WORKSPACE).unwrap();
    let source = source_mut(&mut document.clone()).clone();
    let object: ObjectRef = serde_json::from_value(source["object"].clone()).unwrap();
    let file = db.document_record(object.id.parse().unwrap()).unwrap();
    fs::write(&file.managed_path, b"later evidence").unwrap();
    db.project_file_resolve(&object).unwrap();
    let edges = validate_references(&db.conn, &scope, &document, &retained, WORKSPACE).unwrap();
    assert_eq!(edges[0].2.as_deref(), source["revision"].as_str());
    db.conn
        .execute(
            "DELETE FROM documents WHERE id=?1",
            [object.id.parse::<i64>().unwrap()],
        )
        .unwrap();
    write_reference_edges(&db.conn, &target, &document, WORKSPACE).unwrap();
    assert_eq!(
        db.conn
            .query_row(
                "SELECT count(*) FROM content_reference_edges WHERE target_revision IS NOT NULL",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    validate_references(&db.conn, &scope, &document, &retained, WORKSPACE).unwrap();
    let mut forged = document.clone();
    source_mut(&mut forged)["fileVersion"] = json!(99);
    assert_eq!(
        validate_references(&db.conn, &scope, &forged, &retained, WORKSPACE)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    assert_eq!(
        validate_references(&db.conn, &scope, &document, &Default::default(), WORKSPACE)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    let mut legacy = document.clone();
    legacy["content"][0]["content"][0]["attrs"]
        .as_object_mut()
        .unwrap()
        .remove("sourceRef");
    assert_eq!(
        validate_references(&db.conn, &scope, &legacy, &retained, WORKSPACE)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
}
#[test]
fn old_file_references_remain_navigation_without_fabricated_revision() {
    let (_root, db, scope, mut document) = fixture();
    document["content"][0]["content"][0]["attrs"]
        .as_object_mut()
        .unwrap()
        .remove("sourceRef");
    let edges =
        validate_references(&db.conn, &scope, &document, &Default::default(), WORKSPACE).unwrap();
    assert!(edges[0].2.is_none());
    assert!(serde_json::from_str::<Value>(&edges[0].1)
        .unwrap()
        .get("sourceRef")
        .is_none());
}

#[test]
fn committed_missing_evidence_remains_saved_and_authorized_by_its_original_project() {
    let (_root, db, scope, document) = fixture();
    let initial = projection(document.clone());
    let input = RecordCreate {
        scope: scope.clone(),
        title: None,
        tag_ids: vec![],
        document: document.clone(),
        code_language: None,
    };
    let head = db
        .record_create("gui", "retained-create", &input, &initial, WORKSPACE)
        .unwrap();
    let object: ObjectRef = serde_json::from_value(
        document["content"][0]["content"][0]["attrs"]["sourceRef"]["object"].clone(),
    )
    .unwrap();
    db.conn
        .execute(
            "DELETE FROM documents WHERE id=?1",
            [object.id.parse::<i64>().unwrap()],
        )
        .unwrap();
    let mut changed = document.clone();
    changed["content"][0]["content"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"text","text":" Later edit"}));
    let commit = RecordDocumentCommit {
        target: head.target.clone(),
        base_revision: head.head_revision,
        projection: projection(changed),
        origin: RecordVersionOrigin::Manual,
        actor: json!({"kind":"gui"}),
        edit_session_id: Some("d".repeat(32)),
    };
    let saved = db
        .record_document_commit("gui", "retained-save", &commit, WORKSPACE)
        .unwrap();
    assert_eq!(saved.head.head_revision, head.head_revision + 1);
    assert_eq!(db.record_reference_scopes(&document).unwrap(), vec![scope]);
    assert_eq!(
        db.record_reference_objects(&document, WORKSPACE).unwrap(),
        vec![object]
    );
    assert_eq!(
        db.conn
            .query_row(
                "SELECT count(*) FROM content_reference_edges WHERE target_revision IS NOT NULL",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

#[test]
fn canonical_source_attributes_reject_invalid_versions_kind_hash_and_locator() {
    let (_root, _db, _scope, document) = fixture();
    for (field, value) in [
        ("fileVersion", json!(0)),
        ("recordVersion", json!(1)),
        ("revision", json!("unknown")),
        ("locator", json!({"kind":"time","startMs":0,"endMs":10})),
        ("title", json!("x".repeat(1001))),
    ] {
        let mut invalid = document.clone();
        source_mut(&mut invalid)[field] = value;
        assert_eq!(
            projection(invalid).validate().unwrap_err().code,
            ErrorCode::InvalidPatch
        );
    }
    let mut wrong_kind = document.clone();
    wrong_kind["content"][0]["content"][0]["attrs"]["refKind"] = json!("note");
    assert_eq!(
        projection(wrong_kind).validate().unwrap_err().code,
        ErrorCode::InvalidPatch
    );
}

#[test]
fn checkpoint_retains_fixed_file_source_in_snapshot_after_head_reference_is_removed() {
    use crate::db::project_directory_files::FileBytesInput;
    use base64::{engine::general_purpose::STANDARD, Engine};
    let (_root, mut db, scope, cited_document) = fixture();
    let original_source = cited_document["content"][0]["content"][0]["attrs"]["sourceRef"].clone();
    let file: ObjectRef = serde_json::from_value(original_source["object"].clone()).unwrap();
    let mut uncited_document = cited_document.clone();
    uncited_document["content"][0]["content"] = json!([{"type":"text","text":"Before citation"}]);
    let create = RecordCreate {
        scope: scope.clone(),
        title: Some("Historical evidence".into()),
        tag_ids: vec![],
        document: uncited_document.clone(),
        code_language: None,
    };
    let initial = db
        .record_create(
            "gui",
            "history-create",
            &create,
            &projection(uncited_document.clone()),
            WORKSPACE,
        )
        .unwrap();
    let cite = RecordDocumentCommit {
        target: initial.target.clone(),
        base_revision: initial.head_revision,
        projection: projection(cited_document.clone()),
        origin: RecordVersionOrigin::Manual,
        actor: json!({"kind":"gui"}),
        edit_session_id: Some("e".repeat(32)),
    };
    let cited = db
        .record_document_commit("gui", "history-cite", &cite, WORKSPACE)
        .unwrap();
    let checkpoint = db
        .record_document_checkpoint(
            "gui",
            "history-checkpoint",
            &RecordCheckpointInput {
                target: initial.target.clone(),
                base_revision: cited.head.head_revision,
                reason: RecordCheckpointReason::LeaveEditor,
            },
            WORKSPACE,
        )
        .unwrap();
    assert!(checkpoint.checkpointed);
    let version_id = checkpoint.version_id.unwrap();
    let historic = db.record_version_get(&initial.target, &version_id).unwrap();
    assert_eq!(historic.projection.document, cited_document);
    assert_eq!(historic.projection.body_hash, cite.projection.body_hash);

    // Advance the File, then remove its citation from the Record's current head.
    // The immutable checkpoint must still cite the exact old bytes, not v2.
    let current_file = db.document_record(file.id.parse().unwrap()).unwrap();
    fs::write(&current_file.managed_path, b"later evidence").unwrap();
    let latest = db.project_file_resolve(&file).unwrap();
    assert_eq!(latest.version_number, 2);
    uncited_document["content"][0]["content"] = json!([{"type":"text","text":"Citation removed"}]);
    let remove = RecordDocumentCommit {
        target: initial.target.clone(),
        base_revision: checkpoint.head.head_revision,
        projection: projection(uncited_document),
        origin: RecordVersionOrigin::Manual,
        actor: json!({"kind":"gui"}),
        edit_session_id: Some("f".repeat(32)),
    };
    let removed = db
        .record_document_commit("gui", "history-remove", &remove, WORKSPACE)
        .unwrap();
    db.record_document_checkpoint(
        "gui",
        "history-uncited-checkpoint",
        &RecordCheckpointInput {
            target: initial.target.clone(),
            base_revision: removed.head.head_revision,
            reason: RecordCheckpointReason::LeaveEditor,
        },
        WORKSPACE,
    )
    .unwrap();
    assert!(reference_identities(
        &db.record_document_head(&initial.target)
            .unwrap()
            .unwrap()
            .projection
            .document
    )
    .unwrap()
    .is_empty());
    let source_key = ObjectRef {
        workspace_id: WORKSPACE.into(),
        scope: scope.clone(),
        kind: ObjectKind::Record,
        id: initial.target.record_id.to_string(),
    }
    .key()
    .unwrap();
    assert_eq!(db.conn.query_row("SELECT count(*) FROM content_reference_edges WHERE source_object_key=?1 AND relation='internal_reference'",
        [&source_key], |row| row.get::<_, i64>(0)).unwrap(), 0);

    // The real deletion entry must honor historical evidence even though the
    // current Record no longer contains a citation or an incoming head edge.
    let deletion = db
        .document_delete(crate::models::DocumentDeleteInput {
            document_id: file.id.parse().unwrap(),
        })
        .unwrap_err();
    assert!(
        deletion.to_string().contains("fixed content references"),
        "unexpected deletion failure: {deletion:#}"
    );
    assert_eq!(
        db.document_record(file.id.parse().unwrap())
            .unwrap()
            .current_version_number,
        2
    );

    // WP1 can inspect retained version JSON directly; this deliberately does
    // not depend on current-head edges or a second checkpoint/source index.
    let retained = |workspace: &str, project: i64, file_id: &str, version: u32, hash: &str| {
        let mut query = db
            .conn
            .prepare(
                "SELECT v.id,json_extract(node.value,'$.attrs.sourceRef')
             FROM record_versions v JOIN json_tree(v.document_snapshot) node
             WHERE node.type='object'
               AND json_extract(node.value,'$.type')='internalReference'
               AND json_extract(node.value,'$.attrs.refKind')='document'
               AND json_extract(node.value,'$.attrs.sourceRef.object.kind')='file'
               AND json_extract(node.value,'$.attrs.sourceRef.object.scope.kind')='project'
               AND json_extract(node.value,'$.attrs.sourceRef.object.workspaceId')=?1
               AND json_extract(node.value,'$.attrs.sourceRef.object.scope.projectId')=?2
               AND json_extract(node.value,'$.attrs.sourceRef.object.id')=?3
               AND json_extract(node.value,'$.attrs.sourceRef.fileVersion')=?4
               AND json_extract(node.value,'$.attrs.sourceRef.revision')=?5",
            )
            .unwrap();
        query
            .query_map(params![workspace, project, file_id, version, hash], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    let project = match scope {
        Scope::Project { project_id } => project_id,
        _ => unreachable!(),
    };
    let hash = original_source["revision"].as_str().unwrap();
    let sources = retained(WORKSPACE, project, &file.id, 1, hash);
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].0, version_id);
    assert_eq!(
        serde_json::from_str::<Value>(&sources[0].1).unwrap(),
        original_source
    );
    assert!(retained("other-workspace", project, &file.id, 1, hash).is_empty());
    assert!(retained(WORKSPACE, project + 1, &file.id, 1, hash).is_empty());
    assert!(retained(WORKSPACE, project, "99999", 1, hash).is_empty());
    assert!(retained(WORKSPACE, project, &file.id, 2, hash).is_empty());
    assert!(retained(
        WORKSPACE,
        project,
        &file.id,
        1,
        latest.content_hash.as_deref().unwrap()
    )
    .is_empty());
    let bytes = db
        .project_file_read_bytes(&FileBytesInput {
            object: file.clone(),
            version_number: 1,
            expected_content_hash: hash.into(),
        })
        .unwrap();
    assert_eq!(STANDARD.decode(bytes.base64).unwrap(), b"first evidence");

    // Removing the retained version removes this retention reason atomically
    // with the existing snapshot row; no separate source-edge cleanup is needed.
    let tx = db.conn.unchecked_transaction().unwrap();
    tx.execute("DELETE FROM record_versions WHERE id=?1", [&version_id])
        .unwrap();
    tx.commit().unwrap();
    assert!(retained(WORKSPACE, project, &file.id, 1, hash).is_empty());
}
