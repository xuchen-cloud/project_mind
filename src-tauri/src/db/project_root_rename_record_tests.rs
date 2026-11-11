use super::*;
use crate::record_documents::RecordTarget;
use crate::{
    agent::{
        errors::ErrorCode,
        models::{ObjectKind, ObjectRef, Scope},
    },
    record_documents::*,
};
use serde_json::json;

pub(super) fn initialize_media(
    db: &mut Database,
    project_id: i64,
) -> (RecordTarget, RecordDocumentProjection) {
    let root = db.project_root_path(project_id).unwrap();
    let relative = root
        .strip_prefix(&db.workspace_root)
        .unwrap()
        .to_string_lossy();
    let raw = include_str!("../record_document_projection.fixture.json")
        .replace("assets/图片.png", &format!("{relative}/assets/图片.png"))
        .replace("assets/文件.pdf", &format!("{relative}/assets/文件.pdf"));
    let mut projection: RecordDocumentProjection = serde_json::from_str(&raw).unwrap();
    projection.body_hash = body_hash(&projection.document, &projection.code_language);
    fs::create_dir_all(root.join("assets")).unwrap();
    fs::write(root.join("assets/图片.png"), "retained-image").unwrap();
    fs::write(root.join("assets/文件.pdf"), "retained-attachment").unwrap();
    let record = db
        .project_record_upsert(ProjectRecordUpsertInput {
            project_id,
            note_id: None,
            title: Some("Media".into()),
            markdown: projection.markdown.clone(),
            html: "<p>baseline</p>".into(),
            default_code_language: None,
            tag_ids: vec![],
        })
        .unwrap();
    let target = RecordTarget {
        scope: Scope::Project { project_id },
        record_id: record.id,
    };
    let source = db.record_document_source(&target).unwrap();
    db.record_document_initialize(
        "gui",
        "media-baseline",
        &target,
        &source.source_hash,
        &projection,
        db.native_workspace_id.as_deref().unwrap(),
    )
    .unwrap();
    (target, projection)
}
fn rename(db: &Database, id: i64, name: &str) -> ProjectRecord {
    db.project_update(ProjectUpdateInput {
        project_id: id,
        name: Some(name.into()),
        summary: String::new(),
        summary_markdown: None,
        summary_html: None,
        summary_code_language: None,
        status: None,
    })
    .unwrap()
}

#[test]
fn project_root_rename_record_media_save_patch_and_history_keep_identity() {
    let root = tempfile::tempdir().unwrap();
    let (metadata, paths) = crate::workspace::create_workspace(root.path(), "password").unwrap();
    let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
    let project = db
        .project_create(ProjectCreateInput {
            name: "Before".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let (target, projection) = initialize_media(&mut db, project.id);
    let baseline = db.record_versions_list(&target, None, 10).unwrap().versions[0]
        .id
        .clone();
    let stored = db.record_version_get(&target, &baseline).unwrap();
    let after = rename(&db, project.id, "After");
    assert_eq!(
        db.record_document_head(&target)
            .unwrap()
            .unwrap()
            .projection
            .body_hash,
        projection.body_hash
    );
    assert_eq!(
        db.record_document_head(&target)
            .unwrap()
            .unwrap()
            .head_revision,
        1
    );
    let html = db
        .record_version_editor_html(&target, &projection)
        .expect("historic media should resolve after Project rename");
    for name in ["图片.png", "文件.pdf"] {
        assert!(html.contains(
            &Path::new(&after.root_path)
                .join("assets")
                .join(name)
                .to_string_lossy()
                .to_string()
        ));
    }
    match db.record_editor_state(&target).unwrap().record {
        RecordEditorRecord::Project(record) => {
            assert!(record.content_html.contains(&after.root_path))
        }
        RecordEditorRecord::Workspace(_) => panic!("Project fixture returned Workspace Record"),
    }
    let portable = db
        .record_document_from_gui(&target, &projection.document)
        .unwrap();
    assert!(portable.to_string().contains("After/assets/"));
    let saved = db
        .record_document_commit(
            "gui",
            "save-after-rename",
            &RecordDocumentCommit {
                target: target.clone(),
                base_revision: 1,
                projection: projection.clone(),
                origin: RecordVersionOrigin::Manual,
                actor: json!({"kind":"gui"}),
                edit_session_id: Some("e".repeat(32)),
            },
            &metadata.workspace_id,
        )
        .unwrap();
    let mut changed = projection.clone();
    changed.document["content"][0]["content"][0]["text"] = json!("Fixture 正文 updated");
    changed.html = changed.html.replace("Fixture 正文", "Fixture 正文 updated");
    changed.markdown = changed
        .markdown
        .replace("Fixture 正文", "Fixture 正文 updated");
    changed.text = changed.text.replace("Fixture 正文", "Fixture 正文 updated");
    changed.body_hash = body_hash(&changed.document, &changed.code_language);
    let patch = crate::agent::outputs::RecordPatch {
        record: ObjectRef {
            workspace_id: metadata.workspace_id.clone(),
            scope: target.scope.clone(),
            kind: ObjectKind::Record,
            id: target.record_id.to_string(),
        },
        base_revision: saved.head.head_revision,
        request_id: "patch-after-rename".into(),
        operations: vec![crate::agent::outputs::BlockEdit::AppendInline {
            block_id: "1".repeat(32),
            expected_block_hash: record_block_hash(&projection.document["content"][0]).unwrap(),
            text: " updated".into(),
        }],
    };
    let patch_metadata = RecordPatchMetadata {
        created_block_ids: vec![],
        deleted_block_ids: vec![],
        normalizations: vec![],
        no_change: false,
    };
    db.record_patch_prepare("run:test", &patch).unwrap();
    db.record_patch_preview_validate(&patch, &changed, &patch_metadata)
        .unwrap();
    db.record_patch_commit(
        "run:test",
        &patch,
        &changed,
        &patch_metadata,
        &metadata.workspace_id,
    )
    .unwrap();
    let current = db.record_document_head(&target).unwrap().unwrap();
    db.record_version_restore(
        "gui",
        "restore-after-rename",
        &RecordRestoreInput {
            target: target.clone(),
            base_revision: current.head_revision,
            version_id: baseline.clone(),
        },
        &metadata.workspace_id,
    )
    .unwrap();
    let again = rename(&db, project.id, "Again");
    let current = db.record_document_head(&target).unwrap().unwrap();
    assert_eq!(current.projection.body_hash, projection.body_hash);
    assert!(db
        .record_version_editor_html(&target, &current.projection)
        .unwrap()
        .contains(&again.root_path));
    let historic = db.record_version_get(&target, &baseline).unwrap();
    assert_eq!(historic.id, stored.id);
    assert_eq!(historic.projection.body_hash, stored.projection.body_hash);
    assert_eq!(historic.projection.document, stored.projection.document);
    assert_eq!(historic.projection.html, stored.projection.html);
    let other = db
        .project_create(ProjectCreateInput {
            name: "Other".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let mut forged = projection.document.clone();
    forged["content"][2]["attrs"]["path"] = json!(format!(
        "{}/assets/图片.png",
        Path::new(&other.root_path)
            .file_name()
            .unwrap()
            .to_string_lossy()
    ));
    assert_eq!(
        db.record_document_from_gui(&target, &forged)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    let mut foreign = projection.clone();
    foreign.document = forged;
    foreign.body_hash = body_hash(&foreign.document, &foreign.code_language);
    assert_eq!(
        db.record_version_editor_html(&target, &foreign)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    #[cfg(unix)]
    {
        let image = Path::new(&again.root_path).join("assets/图片.png");
        let external = tempfile::NamedTempFile::new().unwrap();
        fs::remove_file(&image).unwrap();
        std::os::unix::fs::symlink(external.path(), &image).unwrap();
        assert_eq!(
            db.record_version_editor_html(&target, &projection)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
    }
}

#[test]
fn project_root_rename_upgrade_from_41_preserves_history_and_runtime_access() {
    let root = tempfile::tempdir().unwrap();
    let (_, paths) = crate::workspace::create_workspace(root.path(), "password").unwrap();
    let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
    let project = db
        .project_create(ProjectCreateInput {
            name: "Before".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let (target, projection) = initialize_media(&mut db, project.id);
    let baseline = db.record_versions_list(&target, None, 10).unwrap().versions[0]
        .id
        .clone();
    let before = db.record_version_get(&target, &baseline).unwrap();
    db.conn
        .execute_batch("DROP TABLE record_root_asset_locations; PRAGMA user_version=41;")
        .unwrap();
    drop(db);
    let db = Database::open(&paths.db_path, root.path(), None).unwrap();
    assert_eq!(db.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
    let version = db.record_version_get(&target, &baseline).unwrap();
    assert_eq!(version.id, before.id);
    assert_eq!(version.projection.document, before.projection.document);
    assert_eq!(version.projection.body_hash, before.projection.body_hash);
    rename(&db, project.id, "After");
    assert!(db
        .record_version_editor_html(&target, &projection)
        .unwrap()
        .contains("After"));
    drop(db);
    let db = Database::open_runtime_connection(&paths.db_path, root.path(), None).unwrap();
    assert!(db
        .record_version_editor_html(&target, &projection)
        .unwrap()
        .contains("After"));
}

#[test]
fn project_root_rename_migration_failure_is_atomic_and_retryable() {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
    db.conn.execute_batch("DROP TABLE record_root_asset_locations; PRAGMA user_version=41; CREATE INDEX record_root_asset_locations ON projects(name);").unwrap();
    assert!(db.migrate_project_root_schema().is_err());
    assert_eq!(db.schema_version().unwrap(), 41);
    db.conn
        .execute_batch("DROP INDEX record_root_asset_locations")
        .unwrap();
    db.migrate_project_root_schema().unwrap();
    assert_eq!(db.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
    assert!(db.table_exists("record_root_asset_locations").unwrap());
}

#[test]
fn project_root_rename_record_move_keeps_exact_origin_and_source_root_protection() {
    use crate::{
        agent::access::{Caller, RequestContext, ScopeGrant},
        agent::models::WorkspaceBinding,
        record_owner_moves::RecordOwnerMoveInput,
    };
    let root = tempfile::tempdir().unwrap();
    let (metadata, paths) = crate::workspace::create_workspace(root.path(), "password").unwrap();
    let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
    let project = db
        .project_create(ProjectCreateInput {
            name: "Before".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let (target, projection) = initialize_media(&mut db, project.id);
    let after = rename(&db, project.id, "After");
    let binding = WorkspaceBinding {
        workspace_id: metadata.workspace_id.clone(),
        generation: "fixture".into(),
    };
    let request = RequestContext {
        binding: binding.clone(),
        request_id: "move-after-root-rename".into(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: metadata.workspace_id.clone(),
            workspace_content: true,
            project_ids: vec![project.id],
            operations: vec!["record.move".into(), "source.read".into()],
            object_keys: None,
        },
    };
    let moved = db
        .record_owner_move(
            &request,
            &binding,
            &RecordOwnerMoveInput {
                source: target.clone(),
                destination: Scope::Workspace,
                head_revision: 1,
                body_hash: projection.body_hash.clone(),
                metadata_revision: db.record_metadata_get(&target).unwrap().revision,
            },
        )
        .unwrap();
    let html = db
        .record_version_editor_html(&moved.target, &projection)
        .unwrap();
    assert!(html.contains(&after.root_path));
    assert!(db
        .record_owner_require_unshared_root(Path::new(&after.root_path), Some(project.id))
        .is_err());
    let mut sibling = projection.document.clone();
    sibling["content"][2]["attrs"]["path"] = json!("After/assets/unretained.png");
    assert_eq!(
        db.record_document_from_gui(&moved.target, &sibling)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    assert!(db
        .project_update(ProjectUpdateInput {
            project_id: project.id,
            name: Some("Rejected".into()),
            summary: String::new(),
            summary_markdown: None,
            summary_html: None,
            summary_code_language: None,
            status: None
        })
        .is_err());
    assert!(Path::new(&after.root_path)
        .join("assets/图片.png")
        .is_file());
}

#[tokio::test]
#[ignore = "requires prepared fixed Node runtime and built Record worker"]
async fn project_root_rename_real_worker_saves_new_paths_then_patches_and_restores() {
    let root = tempfile::tempdir().unwrap();
    let (metadata, paths) = crate::workspace::create_workspace(root.path(), "password").unwrap();
    let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
    let project = db
        .project_create(ProjectCreateInput {
            name: "Before".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let (target, original) = initialize_media(&mut db, project.id);
    let baseline = db.record_versions_list(&target, None, 10).unwrap().versions[0]
        .id
        .clone();
    rename(&db, project.id, "After");
    let worker = crate::record_document_worker::RecordDocumentWorker::development().unwrap();
    let portable = db
        .record_document_from_gui(&target, &original.document)
        .unwrap();
    let converted = worker
        .request(
            "save-relocated",
            "record.validate",
            json!({"document":portable,"codeLanguage":original.code_language}),
        )
        .await
        .unwrap();
    let projection: RecordDocumentProjection = serde_json::from_value(converted).unwrap();
    assert!(projection.document.to_string().contains("After/assets/"));
    let saved = db
        .record_document_commit(
            "gui",
            "save-relocated",
            &RecordDocumentCommit {
                target: target.clone(),
                base_revision: 1,
                projection,
                origin: RecordVersionOrigin::Manual,
                actor: json!({"kind":"gui"}),
                edit_session_id: Some("c".repeat(32)),
            },
            &metadata.workspace_id,
        )
        .unwrap();
    // Both the immutable Before references and the newly saved After
    // references must resolve through another physical root change.
    let again = rename(&db, project.id, "Again");
    let saved_projection = db
        .record_document_head(&target)
        .unwrap()
        .unwrap()
        .projection;
    let patch = crate::agent::outputs::RecordPatch {
        record: ObjectRef {
            workspace_id: metadata.workspace_id.clone(),
            scope: target.scope.clone(),
            kind: ObjectKind::Record,
            id: target.record_id.to_string(),
        },
        base_revision: saved.head.head_revision,
        request_id: "patch-relocated".into(),
        operations: vec![crate::agent::outputs::BlockEdit::AppendInline {
            block_id: "1".repeat(32),
            expected_block_hash: record_block_hash(&saved_projection.document["content"][0])
                .unwrap(),
            text: " worker patch".into(),
        }],
    };
    db.record_patch_prepare("run:test", &patch).unwrap();
    let mut converted = worker
        .request(
            "patch-relocated",
            "record.patch",
            json!({"document":saved_projection.document,"codeLanguage":saved_projection.code_language,"operations":patch.operations}),
        )
        .await
        .unwrap();
    let patch_metadata =
        serde_json::from_value(converted.as_object_mut().unwrap().remove("patch").unwrap())
            .unwrap();
    let projection: RecordDocumentProjection = serde_json::from_value(converted).unwrap();
    db.record_patch_preview_validate(&patch, &projection, &patch_metadata)
        .unwrap();
    db.record_patch_commit(
        "run:test",
        &patch,
        &projection,
        &patch_metadata,
        &metadata.workspace_id,
    )
    .unwrap();
    let converted = worker
        .request(
            "restore-relocated",
            "record.validate",
            json!({"document":original.document,"codeLanguage":original.code_language}),
        )
        .await
        .unwrap();
    let historic: RecordDocumentProjection = serde_json::from_value(converted).unwrap();
    assert_eq!(historic.body_hash, original.body_hash);
    let current = db.record_document_head(&target).unwrap().unwrap();
    db.record_version_restore_projection(
        "gui",
        "restore-relocated",
        &RecordRestoreInput {
            target: target.clone(),
            base_revision: current.head_revision,
            version_id: baseline.clone(),
        },
        &historic,
        &metadata.workspace_id,
    )
    .unwrap();
    assert!(db
        .record_version_editor_html(&target, &historic)
        .unwrap()
        .contains(&again.root_path));
    let immutable = db.record_version_get(&target, &baseline).unwrap();
    assert_eq!(immutable.projection.document, original.document);
    assert_eq!(immutable.projection.body_hash, original.body_hash);
}
