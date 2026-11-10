use super::*;

#[test]
fn g15_version_metadata_defaults_and_important_retention() {
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
    let source = root.path().join("original.md");
    fs::write(&source, b"retained original").unwrap();
    let file = db
        .document_import(DocumentImportInput {
            project_id: None,
            source_path: source.to_string_lossy().into(),
            is_starred: false,
            tag_ids: None,
        })
        .unwrap();
    let version = db.fetch_document_versions(file.id).unwrap().remove(0);
    let wire = serde_json::to_value(&version).unwrap();
    assert_eq!(wire.get("displayName"), Some(&serde_json::Value::Null));
    assert_eq!(wire["isImportant"], false);
    assert_eq!(wire["metadataRevision"], 0);
    db.conn
        .execute(
            "UPDATE document_versions SET is_important=1 WHERE id=?1",
            [version.id],
        )
        .unwrap();
    assert!(db
        .conn
        .execute("DELETE FROM document_versions WHERE id=?1", [version.id])
        .is_err());
    assert!(db
        .conn
        .execute(
            "UPDATE document_versions SET version_number=99 WHERE id=?1",
            [version.id]
        )
        .is_err());
    assert!(db.conn.execute("UPDATE source_file_version_hashes SET content_hash='changed' WHERE document_version_id=?1", [version.id]).is_err());
    assert_eq!(
        fs::read(&version.managed_path).unwrap(),
        b"retained original"
    );
    // Explicit entire File deletion remains the existing supported operation.
    db.document_delete(crate::models::DocumentDeleteInput {
        document_id: file.id,
    })
    .unwrap();
    assert!(db.fetch_document_versions(file.id).unwrap().is_empty());
}

use super::file_version_metadata::VersionMetadataUpdate;
use crate::agent::{
    access::{Caller, RequestContext, ScopeGrant},
    errors::ErrorCode,
    models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
};
fn context(db: &mut Database, id: i64) -> (RequestContext, ObjectRef) {
    db.bind_native_workspace("g15-test").unwrap();
    let binding = WorkspaceBinding {
        workspace_id: "g15-test".into(),
        generation: "open-1".into(),
    };
    let object = ObjectRef {
        workspace_id: binding.workspace_id.clone(),
        scope: Scope::Workspace,
        kind: ObjectKind::File,
        id: id.to_string(),
    };
    (
        RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "metadata-1".into(),
            scope_grant: ScopeGrant {
                workspace_id: binding.workspace_id,
                workspace_content: true,
                project_ids: vec![],
                operations: vec![
                    "source.read".into(),
                    "file.update".into(),
                    "file.version.metadata.update".into(),
                ],
                object_keys: None,
            },
        },
        object,
    )
}
fn import(db: &mut Database, root: &Path, name: &str) -> DocumentRecord {
    let source = root.join(name);
    fs::write(&source, b"retained original").unwrap();
    db.document_import(DocumentImportInput {
        project_id: None,
        source_path: source.to_string_lossy().into(),
        is_starred: false,
        tag_ids: None,
    })
    .unwrap()
}
#[test]
fn g15_metadata_cas_receipt_validation_authorization_and_reopen() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("test.sqlite");
    let mut db = Database::open(&path, root.path(), None).unwrap();
    let file = import(&mut db, root.path(), "source.md");
    let original = db.fetch_document_versions(file.id).unwrap().remove(0);
    let (mut request, object) = context(&mut db, file.id);
    let input = VersionMetadataUpdate {
        object: object.clone(),
        version_id: original.id.to_string(),
        expected_metadata_revision: 0,
        display_name: Some("  评审修改😀  ".into()),
        is_important: true,
    };
    let saved = db
        .file_version_metadata_update(&request, &request.binding, &input)
        .unwrap();
    assert_eq!(saved.display_name.as_deref(), Some("评审修改😀"));
    assert!(saved.is_important);
    assert_eq!(saved.metadata_revision, 1);
    assert_eq!(
        db.file_version_metadata_update(&request, &request.binding, &input)
            .unwrap(),
        saved
    );
    let mut changed = input.clone();
    changed.display_name = Some("new".into());
    assert_eq!(
        db.file_version_metadata_update(&request, &request.binding, &changed)
            .unwrap_err()
            .code,
        ErrorCode::IdempotencyConflict
    );
    request.request_id = "stale".into();
    assert_eq!(
        db.file_version_metadata_update(&request, &request.binding, &changed)
            .unwrap_err()
            .code,
        ErrorCode::RevisionConflict
    );
    let mut reopened = Database::open(&path, root.path(), None).unwrap();
    reopened.bind_native_workspace("g15-test").unwrap();
    let mut replay = request.clone();
    replay.request_id = "metadata-1".into();
    assert_eq!(
        reopened
            .file_version_metadata_update(&replay, &replay.binding, &input)
            .unwrap(),
        saved
    );
    let read = db
        .file_read_version_get(
            &request,
            &request.binding,
            &crate::agent::file_tools::FileVersionsGetInput {
                object: object.clone(),
                version_id: input.version_id.clone(),
            },
        )
        .unwrap();
    assert_eq!(read.version.display_name, saved.display_name);
    assert_eq!(read.version.metadata_revision, 1);
    assert_eq!(read.version.name, original.name);
    assert_eq!(read.version.created_at, original.created_at);
    for bad in ["\n", "a\u{7f}", "a\0", "a\u{85}"] {
        changed.display_name = Some(bad.into());
        changed.expected_metadata_revision = 1;
        assert_eq!(
            db.file_version_metadata_update(&request, &request.binding, &changed)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
    }
    changed.display_name = Some("😀".repeat(201));
    assert_eq!(
        db.file_version_metadata_update(&request, &request.binding, &changed)
            .unwrap_err()
            .code,
        ErrorCode::InvalidArgument
    );
    changed.display_name = Some("😀".repeat(200));
    request.request_id = "unicode-limit".into();
    assert_eq!(
        db.file_version_metadata_update(&request, &request.binding, &changed)
            .unwrap()
            .display_name
            .unwrap()
            .chars()
            .count(),
        200
    );
    changed.expected_metadata_revision = 2;
    changed.display_name = Some(" \u{3000} ".into());
    changed.is_important = false;
    request.request_id = "clear".into();
    let cleared = db
        .file_version_metadata_update(&request, &request.binding, &changed)
        .unwrap();
    assert_eq!(cleared.display_name, None);
    assert!(!cleared.is_important);
    assert_eq!(cleared.metadata_revision, 3);
    assert_eq!(db.fetch_document_versions(file.id).unwrap().len(), 1);
    assert_eq!(
        fs::read(&original.managed_path).unwrap(),
        b"retained original"
    );
    // A no-op has a durable receipt but does not advance revision or publish a change.
    changed.expected_metadata_revision = 3;
    request.request_id = "noop".into();
    let before = db.committed_change_watermark().unwrap();
    assert_eq!(
        db.file_version_metadata_update(&request, &request.binding, &changed)
            .unwrap(),
        cleared
    );
    assert_eq!(db.committed_change_watermark().unwrap(), before);
    let other = import(&mut db, root.path(), "other.md");
    changed.object.id = other.id.to_string();
    request.request_id = "foreign-version".into();
    assert_eq!(
        db.file_version_metadata_update(&request, &request.binding, &changed)
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    changed.object = object.clone();
    let other_binding = WorkspaceBinding {
        generation: "reopened".into(),
        ..request.binding.clone()
    };
    assert_eq!(
        db.file_version_metadata_update(&request, &other_binding, &changed)
            .unwrap_err()
            .code,
        ErrorCode::WorkspaceChanged
    );
    changed.object.scope = Scope::Project { project_id: 999 };
    assert_eq!(
        db.file_version_metadata_update(&request, &request.binding, &changed)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    changed.object = object;
    let mut denied = request.clone();
    denied.scope_grant.operations.clear();
    assert_eq!(
        db.file_version_metadata_update(&denied, &denied.binding, &changed)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    denied = request.clone();
    denied.caller = Caller::BuiltinRun {
        run_id: "run".into(),
    };
    assert_eq!(
        db.file_version_metadata_update(&denied, &denied.binding, &changed)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    // Storage/outbox failure rolls back both metadata and receipt; same request retries.
    db.conn.execute_batch("CREATE TRIGGER fail_g15 BEFORE INSERT ON agent_change_log WHEN NEW.operation='file.version.metadata.update' BEGIN SELECT RAISE(ABORT,'injected outbox failure'); END;").unwrap();
    changed.display_name = Some("retry".into());
    request.request_id = "outbox-fail".into();
    assert_eq!(
        db.file_version_metadata_update(&request, &request.binding, &changed)
            .unwrap_err()
            .code,
        ErrorCode::IoFailed
    );
    assert_eq!(
        db.document_version_record(original.id)
            .unwrap()
            .metadata_revision,
        3
    );
    db.conn.execute_batch("DROP TRIGGER fail_g15").unwrap();
    assert_eq!(
        db.file_version_metadata_update(&request, &request.binding, &changed)
            .unwrap()
            .metadata_revision,
        4
    );
    let count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM agent_change_log WHERE operation='file.version.metadata.update'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 4);
    let fence = std::sync::Arc::new(crate::workspace_commit_fence::WorkspaceCommitFence::new());
    db.bind_file_commit_fence(fence.clone());
    fence.invalidate();
    assert_eq!(
        db.file_version_metadata_update(&request, &request.binding, &changed)
            .unwrap_err()
            .code,
        ErrorCode::WorkspaceChanged
    );
    assert_eq!(
        db.document_version_record(original.id)
            .unwrap()
            .metadata_revision,
        4
    );
}

#[test]
fn g15_important_survives_native_versions_working_archive_and_capacity() {
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
    let file = import(&mut db, root.path(), "first.md");
    let (mut request, object) = context(&mut db, file.id);
    let original = db.fetch_document_versions(file.id).unwrap().remove(0);
    let input = VersionMetadataUpdate {
        object: object.clone(),
        version_id: original.id.to_string(),
        expected_metadata_revision: 0,
        display_name: Some("keep".into()),
        is_important: true,
    };
    db.file_version_metadata_update(&request, &request.binding, &input)
        .unwrap();
    // Managed-copy version insertion relocates the old head without replacing it.
    let next = root.path().join("next.md");
    fs::write(&next, b"second").unwrap();
    db.document_add_version(crate::models::DocumentAddVersionInput {
        document_id: file.id,
        source_path: Some(next.to_string_lossy().into()),
    })
    .unwrap();
    db.document_update_meta(crate::models::DocumentUpdateMetaInput {
        document_id: file.id,
        base_name: Some("renamed.md".into()),
        is_starred: None,
        tag_ids: None,
    })
    .unwrap();
    let retained = db.document_version_record(original.id).unwrap();
    assert!(retained.is_important);
    assert_eq!(retained.display_name.as_deref(), Some("keep"));
    assert_eq!(retained.metadata_revision, 1);
    assert_eq!(retained.version_number, original.version_number);
    assert_eq!(retained.created_at, original.created_at);
    assert_eq!(
        fs::read(&retained.managed_path).unwrap(),
        b"retained original"
    );
    // Working saves and idle/forced archival use immutable snapshots as well.
    let opened = db
        .file_working_begin_session(&request, &request.binding, &object)
        .unwrap();
    let session = crate::file_working::WorkingSession {
        object: object.clone(),
        session_id: opened.session_id,
    };
    request.request_id = "working-save".into();
    let save = crate::file_working::WorkingSaveText {
        object: object.clone(),
        session_id: session.session_id.clone(),
        expected_revision: opened.status.revision,
        expected_content_hash: opened.status.content_hash.clone(),
        text: "third".into(),
    };
    db.file_working_save(
        &request,
        &request.binding,
        &session,
        save.expected_revision,
        &save.expected_content_hash,
        &save,
        b"third",
        1000,
    )
    .unwrap();
    db.file_working_archive(
        &request,
        &request.binding,
        &object,
        1000 + crate::file_working::IDLE_MS,
        false,
    )
    .unwrap();
    let retained = db.document_version_record(original.id).unwrap();
    assert_eq!(
        fs::read(&retained.managed_path).unwrap(),
        b"retained original"
    );
    assert!(retained.is_important);
    assert_eq!(db.fetch_document_versions(file.id).unwrap().len(), 3);
    // Restore through the existing immutable-version insertion service.
    db.document_add_version(crate::models::DocumentAddVersionInput {
        document_id: file.id,
        source_path: Some(retained.managed_path.clone()),
    })
    .unwrap();
    let current = db.document_record(file.id).unwrap();
    assert_eq!(
        fs::read(current.managed_path).unwrap(),
        b"retained original"
    );
    // Exhausted version counters must reject insertion, never evict old history.
    db.conn.execute("UPDATE document_versions SET version_number=?2 WHERE document_id=?1 AND version_number=4",params![file.id,u32::MAX]).unwrap();
    db.conn
        .execute(
            "UPDATE documents SET current_version_number=?2 WHERE id=?1",
            params![file.id, u32::MAX],
        )
        .unwrap();
    fs::write(&next, b"fifth").unwrap();
    assert!(db
        .document_add_version(crate::models::DocumentAddVersionInput {
            document_id: file.id,
            source_path: Some(next.to_string_lossy().into())
        })
        .is_err());
    let retained = db.document_version_record(original.id).unwrap();
    assert_eq!(
        fs::read(&retained.managed_path).unwrap(),
        b"retained original"
    );
    assert_eq!(retained.metadata_revision, 1);
    // REPLACE and hash deletion must not bypass storage protection.
    assert!(db.conn.execute("INSERT OR REPLACE INTO document_versions(id,document_id,version_number,name,source_path,managed_path,created_at) SELECT id,document_id,version_number,name,source_path,managed_path,created_at FROM document_versions WHERE id=?1",[original.id]).is_err());
    assert!(db.conn.execute("UPDATE OR REPLACE document_versions SET version_number=1 WHERE document_id=?1 AND version_number=?2",params![file.id,u32::MAX]).is_err());
    assert!(db
        .conn
        .execute(
            "DELETE FROM source_file_version_hashes WHERE document_version_id=?1",
            [original.id]
        )
        .is_err());
    assert!(db.conn.execute("INSERT OR REPLACE INTO source_file_version_hashes SELECT * FROM source_file_version_hashes WHERE document_version_id=?1",[original.id]).is_err());
    assert_eq!(db.fetch_document_versions(file.id).unwrap().len(), 4);
}

#[test]
fn g15_two_connections_same_revision_cannot_overwrite() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("test.sqlite");
    let mut db = Database::open(&path, root.path(), None).unwrap();
    let file = import(&mut db, root.path(), "source.md");
    let (request, object) = context(&mut db, file.id);
    let version = db.fetch_document_versions(file.id).unwrap().remove(0);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let mut handles = vec![];
    for label in ["one", "two"] {
        let path = path.clone();
        let root = root.path().to_path_buf();
        let mut request = request.clone();
        let object = object.clone();
        let barrier = barrier.clone();
        handles.push(std::thread::spawn(move || {
            let mut db = Database::open_runtime_connection(&path, &root, None).unwrap();
            db.bind_native_workspace("g15-test").unwrap();
            request.request_id = label.into();
            let input = VersionMetadataUpdate {
                object,
                version_id: version.id.to_string(),
                expected_metadata_revision: 0,
                display_name: Some(label.into()),
                is_important: true,
            };
            barrier.wait();
            db.file_version_metadata_update(&request, &request.binding, &input)
        }));
    }
    let results = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results.into_iter().find_map(|r| r.err()).unwrap().code,
        ErrorCode::RevisionConflict
    );
    assert_eq!(
        db.document_version_record(version.id)
            .unwrap()
            .metadata_revision,
        1
    );
}

#[test]
fn g15_upgrade_schema40_preserves_version_bytes_and_defaults() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("test.sqlite");
    let mut db = Database::open(&path, root.path(), None).unwrap();
    let file = import(&mut db, root.path(), "source.md");
    let before = db.fetch_document_versions(file.id).unwrap().remove(0);
    db.conn.execute_batch("DROP TRIGGER important_version_update_replace; DROP TRIGGER important_version_retain; DROP TRIGGER important_version_identity; DROP TRIGGER important_version_replace; DROP TRIGGER important_version_hash_retain; DROP TRIGGER important_version_hash_replace; ALTER TABLE document_versions DROP COLUMN display_name; ALTER TABLE document_versions DROP COLUMN is_important; ALTER TABLE document_versions DROP COLUMN metadata_revision; PRAGMA user_version=40;").unwrap();
    drop(db);
    let db = Database::open(&path, root.path(), None).unwrap();
    let version = db.document_version_record(before.id).unwrap();
    assert_eq!(version.metadata_revision, 0);
    assert_eq!(version.display_name, None);
    assert!(!version.is_important);
    assert_eq!(version.id, before.id);
    assert_eq!(version.version_number, before.version_number);
    assert_eq!(version.name, before.name);
    assert_eq!(version.created_at, before.created_at);
    assert_eq!(
        fs::read(version.managed_path).unwrap(),
        b"retained original"
    );
    assert_eq!(db.schema_version().unwrap(), 41);
}

#[test]
fn g15_directory_file_rename_and_reconciliation_preserve_metadata() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("test.sqlite");
    let mut db = Database::open(&path, root.path(), None).unwrap();
    db.bind_native_workspace("g15-test").unwrap();
    fs::create_dir_all(root.path().join("files")).unwrap();
    fs::write(root.path().join("files/registered.md"), b"original").unwrap();
    let file = db
        .project_file_register("g15-test", None, "registered.md")
        .unwrap();
    let id = file.object.id.parse().unwrap();
    let (request, object) = context(&mut db, id);
    let original = db.fetch_document_versions(id).unwrap().remove(0);
    let input = VersionMetadataUpdate {
        object: object.clone(),
        version_id: original.id.to_string(),
        expected_metadata_revision: 0,
        display_name: Some("registered important".into()),
        is_important: true,
    };
    db.file_version_metadata_update(&request, &request.binding, &input)
        .unwrap();
    db.project_file_rename(
        &object,
        "renamed.md",
        file.version_number,
        file.content_hash.as_deref().unwrap(),
    )
    .unwrap();
    fs::write(root.path().join("files/renamed.md"), b"updated externally").unwrap();
    db.project_file_register("g15-test", None, "renamed.md")
        .unwrap();
    let versions = db.fetch_document_versions(id).unwrap();
    assert_eq!(versions.len(), 2);
    let retained = db.document_version_record(original.id).unwrap();
    assert!(retained.is_important);
    assert_eq!(
        retained.display_name.as_deref(),
        Some("registered important")
    );
    assert_eq!(retained.metadata_revision, 1);
    assert_eq!(retained.name, original.name);
    assert_eq!(retained.created_at, original.created_at);
    assert_eq!(fs::read(retained.managed_path).unwrap(), b"original");
}
