use super::*;
use crate::models::ProjectCreateInput;
use base64::{engine::general_purpose::STANDARD, Engine};

fn hidden_test_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

// Inject failure after the durable move/metadata intents, independently of
// Unix credentials or filesystem permission overrides.
#[test]
fn directory_file_failed_move_does_not_retry_or_apply_metadata_on_resolve() {
    let (_root, mut db, project, path) = fixture();
    fs::write(path.join("original.txt"), b"original bytes").unwrap();
    let first = db
        .project_file_register("wp1-workspace", project, "original.txt")
        .unwrap();
    FAIL_NEXT_DIRECTORY_MOVE.with(|fail| fail.set(true));
    let result = db.document_update_meta(crate::models::DocumentUpdateMetaInput {
        document_id: first.object.id.parse().unwrap(),
        base_name: Some("renamed.txt".into()),
        is_starred: Some(true),
        tag_ids: Some(vec![]),
    });
    assert!(result.is_err(), "injected move failure must be returned");
    FAIL_NEXT_DIRECTORY_MOVE.with(|fail| assert!(!fail.get(), "real move boundary must consume injection"));
    let pending: i64 = db
        .conn
        .query_row("SELECT COUNT(*) FROM project_directory_moves", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(pending, 0, "a failed move must not be retried by resolve");
    let metadata_pending: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM project_directory_metadata_intents",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(metadata_pending, 0);
    let current = db.project_file_resolve(&first.object).unwrap();
    assert_eq!(current.state, "ready");
    assert_eq!(current.relative_path, "original.txt");
    assert_eq!(current.version_number, first.version_number);
    assert_eq!(bytes(&db, &first), b"original bytes");
    assert_eq!(
        fs::read(path.join("original.txt")).unwrap(),
        b"original bytes"
    );
    assert!(!path.join("renamed.txt").exists());
    assert!(
        !db.document_record(first.object.id.parse().unwrap())
            .unwrap()
            .is_starred
    );
}

#[cfg(windows)]
#[test]
fn directory_file_windows_delete_share_denial_keeps_original_openable() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
    let (_root, mut db, project, path) = fixture();
    fs::write(path.join("资料 original.txt"), b"original bytes").unwrap();
    let first = db
        .project_file_register("wp1-workspace", project, "资料 original.txt")
        .unwrap();
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(path.join("资料 original.txt"))
        .unwrap();
    let result = db.document_update_meta(crate::models::DocumentUpdateMetaInput {
        document_id: first.object.id.parse().unwrap(),
        base_name: Some("renamed.txt".into()),
        is_starred: Some(true),
        tag_ids: Some(vec![]),
    });
    assert!(result.is_err());
    let pending: i64 = db
        .conn
        .query_row("SELECT COUNT(*) FROM project_directory_moves", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(pending, 0);
    let pending: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM project_directory_metadata_intents",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pending, 0);
    for _ in 0..2 {
        let current = db.project_file_resolve(&first.object).unwrap();
        assert_eq!(current.state, "ready");
        assert_eq!(current.relative_path, "资料 original.txt");
        assert_eq!(current.version_number, first.version_number);
        assert_eq!(bytes(&db, &first), b"original bytes");
    }
    drop(held);
    assert_eq!(
        db.project_file_resolve(&first.object)
            .unwrap()
            .relative_path,
        "资料 original.txt"
    );
    assert!(!path.join("renamed.txt").exists());
    assert!(
        !db.document_record(first.object.id.parse().unwrap())
            .unwrap()
            .is_starred
    );
    let renamed = db
        .project_file_rename(
            &first.object,
            "renamed.txt",
            first.version_number,
            first.content_hash.as_deref().unwrap(),
        )
        .unwrap();
    assert_eq!(renamed.relative_path, "renamed.txt");
    assert_eq!(bytes(&db, &first), b"original bytes");
}

#[cfg(windows)]
#[test]
fn directory_file_windows_external_replacement_with_shared_reader_keeps_history() {
    use std::io::Read;
    let (_root, db, project, path) = fixture();
    fs::create_dir(path.join("资料 空格")).unwrap();
    let live = path.join("资料 空格/current.txt");
    fs::write(&live, b"original bytes").unwrap();
    let first = db
        .project_file_register("wp1-workspace", project, "资料 空格/current.txt")
        .unwrap();
    let mut held = crate::source_file_snapshot::open_regular(&live).unwrap();
    fs::write(path.join("replacement.txt"), b"external new bytes").unwrap();
    fs::rename(path.join("replacement.txt"), &live).unwrap();
    let current = db.project_file_resolve(&first.object).unwrap();
    assert_eq!(current.state, "ready");
    assert_eq!(current.version_number, first.version_number + 1);
    assert_eq!(current.object, first.object);
    assert_eq!(bytes(&db, &first), b"original bytes");
    assert_eq!(bytes(&db, &current), b"external new bytes");
    let mut old = Vec::new();
    held.read_to_end(&mut old).unwrap();
    assert_eq!(old, b"original bytes");
    drop(held);
    let again = db.project_file_resolve(&first.object).unwrap();
    assert_eq!(again.version_number, current.version_number);
}

fn fixture() -> (tempfile::TempDir, Database, i64, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace("wp1-workspace").unwrap();
    let project = db
        .project_create(ProjectCreateInput {
            name: "Project files".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let project_root = PathBuf::from(project.root_path);
    (root, db, project.id, project_root)
}
fn bytes(db: &Database, file: &DirectoryFile) -> Vec<u8> {
    STANDARD
        .decode(
            db.project_file_read_bytes(&FileBytesInput {
                object: file.object.clone(),
                version_number: file.version_number,
                expected_content_hash: file.content_hash.clone().unwrap(),
            })
            .unwrap()
            .base64,
        )
        .unwrap()
}

fn import_for_location(db: &mut Database, project: i64, source: &Path) -> ObjectRef {
    let imported = db
        .document_import(crate::models::DocumentImportInput {
            project_id: Some(project),
            source_path: source.to_string_lossy().into_owned(),
            is_starred: false,
            tag_ids: None,
        })
        .unwrap();
    ObjectRef {
        workspace_id: "wp1-workspace".into(),
        scope: Scope::Project {
            project_id: project,
        },
        kind: ObjectKind::File,
        id: imported.id.to_string(),
    }
}

fn legacy_unregistered_fixture() -> (tempfile::TempDir, Database, i64, PathBuf, ObjectRef) {
    let (root, mut db, project, path) = fixture();
    let source = path.join("旧版资料 空格.txt");
    fs::write(&source, b"legacy live bytes").unwrap();
    let imported = db
        .document_import_legacy_fixture(crate::models::DocumentImportInput {
            project_id: Some(project),
            source_path: source.to_string_lossy().into_owned(),
            is_starred: true,
            tag_ids: None,
        })
        .unwrap();
    db.directory_schema().unwrap();
    db.conn
        .execute(
            "DELETE FROM project_directory_files WHERE document_id=?1",
            [imported.id],
        )
        .unwrap();
    let object = ObjectRef {
        workspace_id: "wp1-workspace".into(),
        scope: Scope::Project {
            project_id: project,
        },
        kind: ObjectKind::File,
        id: imported.id.to_string(),
    };
    // Preserve the previously persisted state for explicit reconciliation tests.
    let unresolved = db.directory_state(&object, "ambiguous", "旧版导入文件尚未记录文件身份，请确认当前位置后打开").unwrap();
    assert_eq!(unresolved.state, "ambiguous");
    assert_eq!(unresolved.content_hash, None);
    assert_eq!(
        unresolved.reason.as_deref(),
        Some("旧版导入文件尚未记录文件身份，请确认当前位置后打开")
    );
    (root, db, project, path, object)
}

#[test]
fn legacy_auto_registration_resolves_current_path_and_preserves_history() {
    for registered_hash in [false, true] {
        for empty_identity in [false, true] {
            let (root, mut db, project, path) = fixture();
            let source = path.join("legacy.txt");
            fs::write(&source, b"legacy bytes").unwrap();
            let imported = db
                .document_import(crate::models::DocumentImportInput {
                    project_id: Some(project),
                    source_path: source.to_string_lossy().into_owned(),
                    is_starred: true,
                    tag_ids: None,
                })
                .unwrap();
            db.directory_schema().unwrap();
            db.conn
                .execute(
                    "DELETE FROM project_directory_files WHERE document_id=?1",
                    [imported.id],
                )
                .unwrap();
            if !registered_hash {
                db.conn.execute("DELETE FROM source_file_version_hashes WHERE document_version_id IN (SELECT id FROM document_versions WHERE document_id=?1)", [imported.id]).unwrap();
            }
            let object = ObjectRef {
                workspace_id: "wp1-workspace".into(),
                scope: Scope::Project {
                    project_id: project,
                },
                kind: ObjectKind::File,
                id: imported.id.to_string(),
            };
            if empty_identity {
                db.directory_state(
                    &object,
                    "ambiguous",
                    "旧版导入文件尚未记录文件身份，请确认当前位置后打开",
                )
                .unwrap();
            }
            let old = db
                .document_list_versions(crate::models::DocumentListVersionsInput {
                    document_id: imported.id,
                })
                .unwrap();
            let current = db.project_file_resolve(&object).unwrap();
            assert_eq!(
                current.state, "ready",
                "hash={registered_hash} empty={empty_identity}: {:?}",
                current.reason
            );
            assert_eq!(current.object, object);
            assert_eq!(current.version_number, if registered_hash { 1 } else { 2 });
            assert_eq!(bytes(&db, &current), b"legacy bytes");
            assert_eq!(fs::read(&source).unwrap(), b"legacy bytes");
            let after = db.document_record(imported.id).unwrap();
            assert_eq!(after.managed_path, imported.managed_path);
            assert!(after.is_starred);
            assert_eq!(after.created_at, imported.created_at);
            if !registered_hash {
                assert_eq!(db.directory_hash(imported.id, 1).unwrap(), None);
                let versions = db
                    .document_list_versions(crate::models::DocumentListVersionsInput {
                        document_id: imported.id,
                    })
                    .unwrap();
                assert_eq!(
                    serde_json::to_value(versions.iter().find(|v| v.id == old[0].id).unwrap())
                        .unwrap(),
                    serde_json::to_value(&old[0]).unwrap()
                );
            }
            let observer = rusqlite::Connection::open(root.path().join("test.sqlite")).unwrap();
            let before: i64 = observer
                .query_row("PRAGMA data_version", [], |r| r.get(0))
                .unwrap();
            let again = db.project_file_resolve(&object).unwrap();
            assert_eq!(again.version_number, current.version_number);
            assert_eq!(
                observer
                    .query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                before
            );
        }
    }
}

#[test]
fn legacy_auto_registration_discovery_migrates_multiple_pages_once() {
    let (_root, mut db, project, path) = fixture();
    let mut ids = vec![];
    for i in 0..31 {
        let source = path.join(format!("legacy-{i:02}.txt"));
        fs::write(&source, b"legacy bytes").unwrap();
        let imported = db
            .document_import_legacy_fixture(crate::models::DocumentImportInput {
                project_id: Some(project),
                source_path: source.to_string_lossy().into_owned(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        ids.push(imported.id);
    }
    db.directory_schema().unwrap();
    db.conn
        .execute("DELETE FROM project_directory_files", [])
        .unwrap();
    let mut cursor = None;
    let mut migrated = 0;
    loop {
        let scan = db
            .project_file_scan_new("wp1-workspace", project, cursor.as_deref(), 5)
            .unwrap();
        assert!(scan.failures.is_empty());
        for file in scan.files {
            assert_eq!(file.state, "ready", "{:?}", file.reason);
            assert_eq!(file.version_number, 2);
            migrated += 1;
        }
        cursor = scan.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(migrated, 31);
    let watermark = db.committed_change_watermark().unwrap();
    let scan = db
        .project_file_scan_new("wp1-workspace", project, None, 5)
        .unwrap();
    assert!(scan.files.is_empty());
    assert_eq!(db.committed_change_watermark().unwrap(), watermark);
    for id in ids {
        assert_eq!(db.directory_hash(id, 1).unwrap(), None);
    }
}

#[test]
fn legacy_auto_registration_keeps_content_conflicts_and_foreign_ownership_blocked() {
    let (_root, mut db, project, path) = fixture();
    let source = path.join("known.txt");
    fs::write(&source, b"registered original").unwrap();
    let object = import_for_location(&mut db, project, &source);
    db.directory_schema().unwrap();
    db.conn
        .execute(
            "DELETE FROM project_directory_files WHERE document_id=?1",
            [&object.id],
        )
        .unwrap();
    fs::write(&source, b"changed before migration").unwrap();
    let current = db.project_file_resolve(&object).unwrap();
    assert_eq!(current.state, "ambiguous");
    assert_eq!(current.version_number, 1);
    assert_eq!(
        db.document_record(object.id.parse().unwrap())
            .unwrap()
            .storage_mode,
        "managed_existing"
    );
    assert_eq!(fs::read(&source).unwrap(), b"changed before migration");

    let legacy = path.join("unknown.txt");
    fs::write(&legacy, b"legacy live bytes").unwrap();
    let imported = db
        .document_import_legacy_fixture(crate::models::DocumentImportInput {
            project_id: Some(project),
            source_path: legacy.to_string_lossy().into_owned(),
            is_starred: false,
            tag_ids: None,
        })
        .unwrap();
    db.conn
        .execute(
            "DELETE FROM project_directory_files WHERE document_id=?1",
            [imported.id],
        )
        .unwrap();
    let other = path.join("owned.txt");
    fs::write(&other, b"owned bytes").unwrap();
    db.project_file_register("wp1-workspace", project, "owned.txt")
        .unwrap();
    fs::remove_file(&legacy).unwrap();
    fs::hard_link(&other, &legacy).unwrap();
    let unknown = ObjectRef {
        workspace_id: "wp1-workspace".into(),
        scope: Scope::Project {
            project_id: project,
        },
        kind: ObjectKind::File,
        id: imported.id.to_string(),
    };
    assert_eq!(
        FileServiceError::from_error(db.project_file_resolve(&unknown).unwrap_err()).code,
        "ownership_mismatch"
    );
    assert_eq!(db.directory_hash(imported.id, 1).unwrap(), None);
    assert_eq!(
        db.document_record(imported.id)
            .unwrap()
            .current_version_number,
        1
    );
}

#[test]
fn legacy_auto_registration_supports_workspace_files_and_missing_paths() {
    let (root, mut db, _project, _path) = fixture();
    let source = root.path().join("source.txt");
    fs::write(&source, b"workspace legacy").unwrap();
    let imported = db
        .document_import_legacy_fixture(crate::models::DocumentImportInput {
            project_id: None,
            source_path: source.to_string_lossy().into_owned(),
            is_starred: false,
            tag_ids: None,
        })
        .unwrap();
    db.directory_schema().unwrap();
    db.conn
        .execute(
            "DELETE FROM project_directory_files WHERE document_id=?1",
            [imported.id],
        )
        .unwrap();
    let live = PathBuf::from(&imported.managed_path);
    fs::remove_file(&live).unwrap();
    let object = ObjectRef {
        workspace_id: "wp1-workspace".into(),
        scope: Scope::Workspace,
        kind: ObjectKind::File,
        id: imported.id.to_string(),
    };
    assert_eq!(db.project_file_resolve(&object).unwrap().state, "missing");
    assert_eq!(
        db.document_record(imported.id)
            .unwrap()
            .current_version_number,
        1
    );
    fs::write(&live, b"workspace legacy").unwrap();
    let ready = db.project_file_resolve(&object).unwrap();
    assert_eq!(ready.state, "ready");
    assert_eq!(ready.version_number, 2);
    assert_eq!(bytes(&db, &ready), b"workspace legacy");
    assert_eq!(db.directory_hash(imported.id, 1).unwrap(), None);
}

#[test]
fn imported_file_legacy_registration_freezes_new_version_and_retains_unknown_history_after_reopen()
{
    let (root, mut db, _project, path, object) = legacy_unregistered_fixture();
    let id = object.id.parse::<i64>().unwrap();
    let before = db.document_record(id).unwrap();
    let old_versions = db
        .document_list_versions(crate::models::DocumentListVersionsInput { document_id: id })
        .unwrap();
    let confirmed = db
        .project_file_reconcile(&object, "旧版资料 空格.txt", 1, None, "registration")
        .unwrap();
    assert_eq!(confirmed.state, "ready");
    assert_eq!(confirmed.object, object);
    assert_eq!(confirmed.version_number, 2);
    assert_eq!(
        FileServiceError::from_error(
            db.project_file_reconcile(&object, "旧版资料 空格.txt", 1, None, "registration")
                .unwrap_err()
        )
        .code,
        "revision_conflict"
    );
    assert_eq!(bytes(&db, &confirmed), b"legacy live bytes");
    assert_eq!(
        fs::read(path.join("旧版资料 空格.txt")).unwrap(),
        b"legacy live bytes"
    );
    let after = db.document_record(id).unwrap();
    assert_eq!(after.managed_path, before.managed_path);
    assert_eq!(after.is_starred, before.is_starred);
    assert_eq!(after.created_at, before.created_at);
    assert_eq!(after.version_count, before.version_count + 1);
    let versions = db
        .document_list_versions(crate::models::DocumentListVersionsInput { document_id: id })
        .unwrap();
    assert_eq!(versions.len(), 2);
    let retained = versions
        .iter()
        .find(|v| v.id == old_versions[0].id)
        .unwrap();
    assert_eq!(
        serde_json::to_value(retained).unwrap(),
        serde_json::to_value(&old_versions[0]).unwrap()
    );
    assert_eq!(db.directory_hash(id, 1).unwrap(), None);
    assert_eq!(db.directory_hash(id, 2).unwrap(), confirmed.content_hash);
    assert_eq!(
        FileServiceError::from_error(
            db.project_file_read_bytes(&FileBytesInput {
                object: object.clone(),
                version_number: 1,
                expected_content_hash: confirmed.content_hash.clone().unwrap(),
            })
            .unwrap_err()
        )
        .code,
        "version_unregistered"
    );
    drop(db);
    let mut db = Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace("wp1-workspace").unwrap();
    let reopened = db.project_file_resolve(&object).unwrap();
    assert_eq!(reopened.state, "ready");
    assert_eq!(reopened.version_number, 2);
    assert_eq!(reopened.content_hash, confirmed.content_hash);
    assert_eq!(bytes(&db, &reopened), b"legacy live bytes");
    assert_eq!(db.directory_hash(id, 1).unwrap(), None);
    fs::write(path.join("旧版资料 空格.txt"), b"edited after registration").unwrap();
    assert_eq!(bytes(&db, &reopened), b"legacy live bytes");
    let edited = db.project_file_resolve(&object).unwrap();
    assert_eq!(edited.version_number, 3);
    assert_eq!(bytes(&db, &edited), b"edited after registration");
    assert_eq!(db.directory_hash(id, 1).unwrap(), None);
}

#[test]
fn imported_file_legacy_registration_accepts_absent_identity_record() {
    let (_root, db, _project, _path, object) = legacy_unregistered_fixture();
    db.conn
        .execute(
            "DELETE FROM project_directory_files WHERE document_id=?1",
            [&object.id],
        )
        .unwrap();
    let confirmed = db
        .project_file_reconcile(&object, "旧版资料 空格.txt", 1, None, "registration")
        .unwrap();
    assert_eq!(confirmed.state, "ready");
    assert_eq!(confirmed.version_number, 2);
}

#[test]
fn imported_file_legacy_registration_requires_exact_confirmation_and_current_path() {
    let (_root, db, _project, path, object) = legacy_unregistered_fixture();
    for (hash, confirmation) in [
        (None, ""),
        (None, "other"),
        (None, "location"),
        (None, "replacement"),
        (Some(""), "location"),
        (Some(""), "replacement"),
        (Some(""), "registration"),
    ] {
        let error = db
            .project_file_reconcile(&object, "旧版资料 空格.txt", 1, hash, confirmation)
            .unwrap_err();
        assert_eq!(
            FileServiceError::from_error(error).code,
            "invalid_argument",
            "{hash:?} {confirmation}"
        );
    }
    fs::write(path.join("different.txt"), b"legacy live bytes").unwrap();
    let error = db
        .project_file_reconcile(&object, "different.txt", 1, None, "registration")
        .unwrap_err();
    assert_eq!(FileServiceError::from_error(error).code, "invalid_argument");
    let unchanged = db.document_record(object.id.parse().unwrap()).unwrap();
    assert_eq!(unchanged.current_version_number, 1);
    assert_eq!(unchanged.version_count, 1);
    assert_eq!(db.directory_hash(unchanged.id, 1).unwrap(), None);
    assert_eq!(
        fs::read(path.join("旧版资料 空格.txt")).unwrap(),
        b"legacy live bytes"
    );
}

#[test]
fn imported_file_legacy_registration_rejects_known_identity_or_registered_history() {
    let (_root, mut db, project, path, object) = legacy_unregistered_fixture();
    let id = object.id.parse::<i64>().unwrap();
    let physical = serde_json::to_string(
        &file_versions::path_identity(&path.join("旧版资料 空格.txt")).unwrap(),
    )
    .unwrap();
    db.conn
        .execute(
            "UPDATE project_directory_files SET physical_identity=?1 WHERE document_id=?2",
            params![physical, id],
        )
        .unwrap();
    assert_eq!(
        FileServiceError::from_error(
            db.project_file_reconcile(&object, "旧版资料 空格.txt", 1, None, "registration")
                .unwrap_err()
        )
        .code,
        "invalid_argument"
    );
    db.conn
        .execute(
            "UPDATE project_directory_files SET physical_identity='' WHERE document_id=?1",
            [id],
        )
        .unwrap();
    db.conn
        .execute(
            "UPDATE documents SET storage_mode='project_directory' WHERE id=?1",
            [id],
        )
        .unwrap();
    assert_eq!(
        FileServiceError::from_error(
            db.project_file_reconcile(&object, "旧版资料 空格.txt", 1, None, "registration")
                .unwrap_err()
        )
        .code,
        "invalid_argument"
    );
    fs::write(path.join("known.txt"), b"registered import").unwrap();
    let known = import_for_location(&mut db, project, &path.join("known.txt"));
    db.conn
        .execute(
            "DELETE FROM project_directory_files WHERE document_id=?1",
            [&known.id],
        )
        .unwrap();
    let pending = db.project_file_resolve(&known).unwrap();
    assert_eq!(pending.state, "ready");
    assert!(pending.content_hash.is_some());
    assert_eq!(
        FileServiceError::from_error(
            db.project_file_reconcile(
                &known,
                "known.txt",
                1,
                pending.content_hash.as_deref(),
                "registration"
            )
            .unwrap_err()
        )
        .code,
        "invalid_argument"
    );
    assert_eq!(
        db.project_file_reconcile(
            &known,
            "known.txt",
            1,
            pending.content_hash.as_deref(),
            "location"
        )
        .unwrap()
        .state,
        "ready"
    );
}

#[test]
fn imported_file_legacy_registration_rejects_foreign_physical_owner_and_forged_scope() {
    let (_root, mut db, project, path, object) = legacy_unregistered_fixture();
    let other = db
        .project_create(ProjectCreateInput {
            name: "Other owner".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let owned_path = Path::new(&other.root_path).join("owned.txt");
    fs::write(&owned_path, b"owned content").unwrap();
    let owner = db
        .project_file_register("wp1-workspace", other.id, "owned.txt")
        .unwrap();
    let live = path.join("旧版资料 空格.txt");
    fs::remove_file(&live).unwrap();
    fs::hard_link(&owned_path, &live).unwrap();
    assert_eq!(
        FileServiceError::from_error(
            db.project_file_reconcile(&object, "旧版资料 空格.txt", 1, None, "registration")
                .unwrap_err()
        )
        .code,
        "ownership_mismatch"
    );
    let mut forged = object.clone();
    forged.scope = Scope::Project {
        project_id: other.id,
    };
    assert_eq!(
        FileServiceError::from_error(
            db.project_file_reconcile(&forged, "owned.txt", 1, None, "registration")
                .unwrap_err()
        )
        .code,
        "ownership_mismatch"
    );
    forged.scope = Scope::Project {
        project_id: project,
    };
    forged.workspace_id = "foreign-workspace".into();
    assert_eq!(
        FileServiceError::from_error(
            db.project_file_reconcile(&forged, "旧版资料 空格.txt", 1, None, "registration")
                .unwrap_err()
        )
        .code,
        "ownership_mismatch"
    );
    assert_eq!(bytes(&db, &owner), b"owned content");
    assert_eq!(fs::read(&live).unwrap(), b"owned content");
    assert_eq!(
        db.document_record(object.id.parse().unwrap())
            .unwrap()
            .version_count,
        1
    );
}

#[test]
fn imported_file_legacy_registration_preserves_snapshot_budget_and_pending_move_intents() {
    let (_root, db, _project, path, object) = legacy_unregistered_fixture();
    let id = object.id.parse::<i64>().unwrap();
    let live = path.join("旧版资料 空格.txt");
    fs::OpenOptions::new()
        .write(true)
        .open(&live)
        .unwrap()
        .set_len(crate::file_text_patch::MAX_FILE_BYTES as u64 + 1)
        .unwrap();
    let unavailable = db
        .project_file_reconcile(&object, "旧版资料 空格.txt", 1, None, "registration")
        .unwrap();
    assert_eq!(unavailable.state, "unavailable");
    assert_eq!(unavailable.content_hash, None);
    assert_eq!(unavailable.version_number, 1);
    assert_eq!(db.document_record(id).unwrap().version_count, 1);
    let snapshots: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM document_versions WHERE document_id=?1",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(snapshots, 1);
    fs::write(&live, b"legacy live bytes").unwrap();
    db.conn
        .execute(
            "INSERT INTO project_directory_metadata_intents(document_id,payload) VALUES (?1,'{}')",
            [id],
        )
        .unwrap();
    assert_eq!(
        FileServiceError::from_error(
            db.project_file_reconcile(&object, "旧版资料 空格.txt", 1, None, "registration")
                .unwrap_err()
        )
        .code,
        "ambiguous_identity"
    );
    assert_eq!(
        db.conn
            .query_row(
                "SELECT COUNT(*) FROM project_directory_metadata_intents WHERE document_id=?1",
                [id],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    db.conn
        .execute(
            "DELETE FROM project_directory_metadata_intents WHERE document_id=?1",
            [id],
        )
        .unwrap();
    db.conn.execute("INSERT INTO project_directory_moves(document_id,original_path,target_path,physical_identity,content_hash,version_number) VALUES (?1,?2,?3,'','',1)", params![id, db.encode_path_ref(&live), db.encode_path_ref(&path.join("moved.txt"))]).unwrap();
    assert_eq!(
        FileServiceError::from_error(
            db.project_file_reconcile(&object, "旧版资料 空格.txt", 1, None, "registration")
                .unwrap_err()
        )
        .code,
        "ambiguous_identity"
    );
    assert_eq!(
        db.conn
            .query_row(
                "SELECT COUNT(*) FROM project_directory_moves WHERE document_id=?1",
                [id],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert!(!path.join("moved.txt").exists());
    assert_eq!(db.directory_hash(id, 1).unwrap(), None);
    assert_eq!(fs::read(&live).unwrap(), b"legacy live bytes");
}

#[test]
fn imported_file_legacy_registration_rechecks_stale_version_and_hash_under_file_lock() {
    for changed_hash in [false, true] {
        let (root, db, project, path, object) = legacy_unregistered_fixture();
        let id = object.id.parse::<i64>().unwrap();
        let guard = db.file_version_lock(id).unwrap();
        let thread_root = root.path().to_path_buf();
        let thread_object = object.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut other =
                Database::open(&thread_root.join("test.sqlite"), &thread_root, None).unwrap();
            other.bind_native_workspace("wp1-workspace").unwrap();
            started_tx.send(()).unwrap();
            let result = other
                .project_file_reconcile(
                    &thread_object,
                    "旧版资料 空格.txt",
                    1,
                    None,
                    "registration",
                )
                .map_err(|error| FileServiceError::from_error(error).code);
            done_tx
                .send(result.map(|file| file.version_number))
                .unwrap();
        });
        started_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert!(matches!(
            done_rx.recv_timeout(std::time::Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        if changed_hash {
            let hash = file_versions::checksum(&path.join("旧版资料 空格.txt")).unwrap();
            db.conn.execute("INSERT INTO source_file_version_hashes(document_version_id,content_hash) SELECT id,?1 FROM document_versions WHERE document_id=?2 AND version_number=1", params![hash, id]).unwrap();
        } else {
            db.directory_publish_locked(
                "wp1-workspace",
                Some(project),
                &path.join("旧版资料 空格.txt"),
                &object,
                true,
                Some((1, "")),
                None,
                None,
            )
            .unwrap();
        }
        drop(guard);
        assert_eq!(
            done_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap(),
            Err("revision_conflict")
        );
        worker.join().unwrap();
        assert_eq!(
            fs::read(path.join("旧版资料 空格.txt")).unwrap(),
            b"legacy live bytes"
        );
    }
}

#[test]
fn imported_file_location_first_resolve_freezes_managed_copy_and_adopted_head() {
    for adopted in [false, true] {
        let (root, mut db, project, path) = fixture();
        let source = if adopted {
            path.join("Presentation12.pptx")
        } else {
            root.path().join("Presentation12.pptx")
        };
        fs::write(&source, b"presentation original bytes").unwrap();
        let object = import_for_location(&mut db, project, &source);
        drop(db);
        let mut db = Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("wp1-workspace").unwrap();
        let first = db.project_file_resolve(&object).unwrap();
        assert_eq!(first.state, "ready", "{adopted}: {:?}", first.reason);
        assert_eq!(first.object, object);
        assert_eq!(first.version_number, 1);
        assert_eq!(bytes(&db, &first), b"presentation original bytes");
        fs::write(path.join("replacement.pptx"), b"edited after first opening").unwrap();
        fs::rename(
            path.join("replacement.pptx"),
            path.join("Presentation12.pptx"),
        )
        .unwrap();
        let second = db.project_file_resolve(&object).unwrap();
        assert_eq!(second.state, "ready");
        assert_eq!(second.version_number, 2);
        assert_eq!(bytes(&db, &first), b"presentation original bytes");
        assert_eq!(bytes(&db, &second), b"edited after first opening");
    }
}

#[test]
fn imported_file_location_legacy_identity_is_registered_automatically() {
    let (root, mut db, project, path) = fixture();
    let source = root.path().join("Presentation12.pptx");
    fs::write(&source, b"original bytes").unwrap();
    let object = import_for_location(&mut db, project, &source);
    db.directory_schema().unwrap();
    db.conn
        .execute(
            "DELETE FROM project_directory_files WHERE document_id=?1",
            [object.id.parse::<i64>().unwrap()],
        )
        .unwrap();
    let first = db.project_file_resolve(&object).unwrap();
    assert_eq!(first.state, "ready");
    assert_eq!(first.reason, None);
    assert_eq!(
        db.project_file_register("wp1-workspace", project, "Presentation12.pptx")
            .unwrap()
            .state,
        "ready"
    );
    assert_eq!(first.version_number, 1);
    fs::write(path.join("Presentation12.pptx"), b"updated").unwrap();
    assert_eq!(db.project_file_resolve(&object).unwrap().version_number, 2);
    assert_eq!(bytes(&db, &first), b"original bytes");
}

#[test]
fn imported_file_location_does_not_adopt_replacement_even_with_same_hash() {
    for contents in [
        b"original bytes".as_slice(),
        b"replacement bytes".as_slice(),
    ] {
        let (root, mut db, project, path) = fixture();
        let source = root.path().join("Presentation12.pptx");
        fs::write(&source, b"original bytes").unwrap();
        let object = import_for_location(&mut db, project, &source);
        fs::write(path.join("replacement"), contents).unwrap();
        fs::rename(path.join("replacement"), path.join("Presentation12.pptx")).unwrap();
        let resolved = db.project_file_resolve(&object).unwrap();
        assert_eq!(resolved.state, "ambiguous");
        assert_eq!(resolved.version_number, 1);
        assert_ne!(
            resolved.reason.as_deref(),
            Some("File location has not been checked")
        );
        assert_eq!(
            db.project_file_register("wp1-workspace", project, "Presentation12.pptx")
                .unwrap()
                .state,
            "ambiguous"
        );
    }
}

#[test]
fn imported_file_location_changed_before_first_snapshot_keeps_registered_head() {
    let (root, mut db, project, path) = fixture();
    let source = root.path().join("Presentation12.pptx");
    fs::write(&source, b"original bytes").unwrap();
    let object = import_for_location(&mut db, project, &source);
    fs::write(path.join("Presentation12.pptx"), b"edited before opening").unwrap();
    let resolved = db.project_file_resolve(&object).unwrap();
    assert_eq!(resolved.state, "ambiguous");
    assert!(resolved
        .reason
        .as_deref()
        .unwrap()
        .contains("confirm replacement"));
    assert_eq!(resolved.version_number, 1);
    assert_eq!(
        resolved.content_hash.as_deref(),
        Some(file_versions::checksum(&source).unwrap().as_str())
    );
    assert_eq!(
        db.document_record(object.id.parse().unwrap())
            .unwrap()
            .version_count,
        1
    );
}

#[test]
fn directory_file_register_is_idempotent_keeps_location_and_reads_binary_snapshot() {
    let (_root, mut db, project, path) = fixture();
    fs::write(path.join("data.bin"), [0, 255, 128, 42]).unwrap();
    let first = db
        .project_file_register("wp1-workspace", project, "data.bin")
        .unwrap();
    assert_eq!(first.state, "ready");
    assert_eq!(bytes(&db, &first), [0, 255, 128, 42]);
    let repeated = db
        .project_file_register("wp1-workspace", project, "data.bin")
        .unwrap();
    assert_eq!(first.object, repeated.object);
    assert_eq!(repeated.version_number, 1);
    assert_eq!(fs::read(path.join("data.bin")).unwrap(), [0, 255, 128, 42]);
    fs::write(path.join("copy.bin"), [0, 255, 128, 42]).unwrap();
    let copy = db
        .project_file_register("wp1-workspace", project, "copy.bin")
        .unwrap();
    assert_ne!(copy.object, first.object);
}

#[test]
fn directory_file_external_edits_and_atomic_replacement_keep_old_snapshots() {
    let (_root, mut db, project, path) = fixture();
    fs::write(path.join("note.txt"), b"first").unwrap();
    let first = db
        .project_file_register("wp1-workspace", project, "note.txt")
        .unwrap();
    fs::write(path.join("note.txt"), b"second").unwrap();
    let second = db.project_file_resolve(&first.object).unwrap();
    assert_eq!(second.object, first.object);
    assert_eq!(second.version_number, 2);
    assert_eq!(bytes(&db, &first), b"first");
    assert_eq!(bytes(&db, &second), b"second");
    let before = db
        .document_list_versions(crate::models::DocumentListVersionsInput {
            document_id: first.object.id.parse().unwrap(),
        })
        .unwrap();
    fs::write(path.join("replacement"), b"third").unwrap();
    fs::rename(path.join("replacement"), path.join("note.txt")).unwrap();
    let accepted = db.project_file_resolve(&first.object).unwrap();
    assert_eq!(accepted.state, "ready", "{:?}", accepted.reason);
    assert_eq!(accepted.object, first.object);
    assert_eq!(accepted.version_number, 3);
    assert_eq!(bytes(&db, &first), b"first");
    assert_eq!(bytes(&db, &second), b"second");
    assert_eq!(bytes(&db, &accepted), b"third");
    let after = db
        .document_list_versions(crate::models::DocumentListVersionsInput {
            document_id: first.object.id.parse().unwrap(),
        })
        .unwrap();
    for old in before {
        let retained = after.iter().find(|version| version.id == old.id).unwrap();
        assert_eq!(retained.managed_path, old.managed_path);
    }
    let rejected = db
        .project_file_reconcile(
            &first.object,
            "note.txt",
            second.version_number,
            second.content_hash.as_deref(),
            "replacement",
        )
        .unwrap_err();
    assert_eq!(
        FileServiceError::from_error(rejected).code,
        "revision_conflict"
    );
    assert_eq!(fs::read(path.join("note.txt")).unwrap(), b"third");
}

#[test]
fn directory_file_atomic_replacement_rejects_stale_save_baseline() {
    let (_root, db, project, path) = fixture();
    fs::write(path.join("live.txt"), b"old").unwrap();
    let first = db
        .project_file_register("wp1-workspace", project, "live.txt")
        .unwrap();
    fs::write(path.join("replacement"), b"external").unwrap();
    fs::rename(path.join("replacement"), path.join("live.txt")).unwrap();
    let current = db.project_file_resolve(&first.object).unwrap();
    assert_eq!(current.version_number, 2);
    let staged = path.join("draft.txt");
    fs::write(&staged, b"unsaved draft").unwrap();
    let mut request = restore_request(project);
    request.request_id = "stale-save".into();
    request.scope_grant.operations.push("file.update".into());
    let update = file_versions::FileVersionUpdate {
        object: first.object.clone(),
        expected_version_number: first.version_number,
        expected_content_hash: first.content_hash.clone().unwrap(),
        new_content_hash: file_versions::checksum(&staged).unwrap(),
    };
    let watermark = db.committed_change_watermark().unwrap();
    let error = db
        .project_file_staged_directory_bound(
            &request,
            &request.binding,
            &update,
            "stale-stage",
            &staged,
            &crate::workspace_commit_fence::WorkspaceCommitFence::new(),
            &|| Ok(()),
        )
        .unwrap_err();
    assert_eq!(
        error.code,
        crate::agent::errors::ErrorCode::RevisionConflict
    );
    assert_eq!(fs::read(path.join("live.txt")).unwrap(), b"external");
    assert_eq!(fs::read(staged).unwrap(), b"unsaved draft");
    assert_eq!(db.committed_change_watermark().unwrap(), watermark);
    assert_eq!(bytes(&db, &first), b"old");
    assert_eq!(bytes(&db, &current), b"external");
}

#[test]
fn directory_file_move_and_rename_keep_identity_versions_and_recover_intent() {
    let (_root, mut db, project, path) = fixture();
    fs::write(path.join("old.txt"), b"unchanged").unwrap();
    fs::create_dir(path.join("sub")).unwrap();
    let original = db
        .project_file_register("wp1-workspace", project, "old.txt")
        .unwrap();
    let moved = db
        .project_file_move(
            &original.object,
            "sub/moved.txt",
            1,
            original.content_hash.as_ref().unwrap(),
        )
        .unwrap();
    assert_eq!(moved.object, original.object);
    assert_eq!(moved.version_number, 1);
    assert!(!path.join("old.txt").exists());
    assert_eq!(bytes(&db, &original), b"unchanged");
    let renamed = db
        .project_file_rename(
            &original.object,
            "renamed.txt",
            1,
            original.content_hash.as_ref().unwrap(),
        )
        .unwrap();
    assert_eq!(renamed.relative_path, "sub/renamed.txt");
    assert_eq!(renamed.object, original.object);
    assert_eq!(renamed.version_number, 1);
    // Recovery seam: a committed move intent survives interruption between the
    // physical move and the catalogue update. Resume through normal resolve.
    let identity = serde_json::to_string(
        &file_versions::path_identity(&path.join("sub/renamed.txt")).unwrap(),
    )
    .unwrap();
    db.conn.execute("INSERT INTO project_directory_moves(document_id,original_path,target_path,physical_identity,content_hash,version_number) VALUES (?1,?2,?3,?4,?5,1)",params![original.object.id.parse::<i64>().unwrap(),db.encode_path_ref(&path.join("sub/renamed.txt")),db.encode_path_ref(&path.join("recovered.txt")),identity,original.content_hash]).unwrap();
    file_versions::move_exclusive(&path.join("sub/renamed.txt"), &path.join("recovered.txt"))
        .unwrap();
    let recovered = db.project_file_resolve(&original.object).unwrap();
    assert_eq!(recovered.relative_path, "recovered.txt");
    assert_eq!(recovered.version_number, 1);
    assert_eq!(bytes(&db, &recovered), b"unchanged");
}

#[test]
fn directory_file_scan_is_resumable_reports_exclusions_errors_and_cancellation() {
    let (_root, mut db, project, path) = fixture();
    fs::create_dir(path.join(".project-mind")).unwrap();
    fs::write(path.join(".project-mind/secret"), b"private").unwrap();
    fs::create_dir(path.join("sub")).unwrap();
    fs::write(path.join("a.bin"), [0, 255]).unwrap();
    fs::write(path.join("sub/z.unknown"), b"unsupported preview").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(path.join("a.bin"), path.join("alias")).unwrap();
    let page = db
        .project_file_scan("wp1-workspace", project, None, 1, false)
        .unwrap();
    assert_eq!(page.files.len(), 1);
    assert!(!page.complete);
    assert!(page.excluded.iter().any(|e| e.reason == "internal"));
    let cancelled = db
        .project_file_scan(
            "wp1-workspace",
            project,
            page.next_cursor.as_deref(),
            1,
            true,
        )
        .unwrap();
    assert!(cancelled.cancelled);
    assert!(!cancelled.complete);
    assert!(cancelled.files.is_empty());
    let next = db
        .project_file_scan(
            "wp1-workspace",
            project,
            page.next_cursor.as_deref(),
            10,
            false,
        )
        .unwrap();
    assert!(next.complete);
    assert_eq!(next.files.len(), 1);
    assert_eq!(next.files[0].relative_path, "sub/z.unknown");
    #[cfg(unix)]
    assert!(next.excluded.iter().any(|e| e.reason == "symlink"));
    let repeated = db
        .project_file_scan("wp1-workspace", project, None, 10, false)
        .unwrap();
    assert_eq!(repeated.files[0].object, page.files[0].object);
    // Removing the real root is an error, never an empty successful scan.
    fs::rename(&path, path.with_extension("offline")).unwrap();
    let failed = db
        .project_file_scan("wp1-workspace", project, None, 10, false)
        .unwrap();
    assert!(!failed.failures.is_empty());
    assert!(!failed.complete);
}

#[test]
fn directory_file_budgets_preserve_identity_without_faking_initial_versions() {
    let (_root, db, project, path) = fixture();
    let huge = fs::File::create(path.join("huge.bin")).unwrap();
    huge.set_len(crate::file_text_patch::MAX_FILE_BYTES as u64 + 1)
        .unwrap();
    let unavailable = db
        .project_file_register("wp1-workspace", project, "huge.bin")
        .unwrap();
    assert_eq!(unavailable.state, "unavailable");
    assert_eq!(unavailable.version_number, 0);
    assert_eq!(unavailable.content_hash, None);
    let repeated = db
        .project_file_register("wp1-workspace", project, "huge.bin")
        .unwrap();
    assert_eq!(repeated.object, unavailable.object);
    let large = fs::File::create(path.join("large.bin")).unwrap();
    large.set_len(10 * 1024 * 1024 + 1).unwrap();
    let registered = db
        .project_file_register("wp1-workspace", project, "large.bin")
        .unwrap();
    assert_eq!(registered.state, "ready");
    assert_eq!(registered.version_number, 1);
    let error = db
        .project_file_read_bytes(&FileBytesInput {
            object: registered.object,
            version_number: 1,
            expected_content_hash: registered.content_hash.unwrap(),
        })
        .unwrap_err();
    assert_eq!(FileServiceError::from_error(error).code, "budget_exceeded");
}

#[test]
fn directory_file_existing_metadata_rename_preserves_history_and_applies_tags_atomically() {
    let (_root, db, project, path) = fixture();
    fs::write(path.join("old.txt"), b"first").unwrap();
    let first = db
        .project_file_register("wp1-workspace", project, "old.txt")
        .unwrap();
    fs::write(path.join("old.txt"), b"second").unwrap();
    let second = db.project_file_resolve(&first.object).unwrap();
    let mut db = db;
    let renamed = db
        .document_update_meta(crate::models::DocumentUpdateMetaInput {
            document_id: first.object.id.parse().unwrap(),
            base_name: Some("new.txt".into()),
            is_starred: Some(true),
            tag_ids: Some(vec![]),
        })
        .unwrap();
    assert_eq!(renamed.name, "new.txt");
    assert!(renamed.is_starred);
    assert_eq!(
        db.project_file_resolve(&first.object)
            .unwrap()
            .relative_path,
        "new.txt"
    );
    assert_eq!(bytes(&db, &first), b"first");
    assert_eq!(bytes(&db, &second), b"second");
    assert_eq!(fs::read(path.join("new.txt")).unwrap(), b"second");
    assert!(!path.join("old.txt").exists());
}
#[test]
fn directory_file_fixed_bytes_reject_forged_owner_hash_and_missing_snapshot() {
    let (_root, mut db, project, path) = fixture();
    fs::write(path.join("owned.bin"), [1, 2, 3]).unwrap();
    let file = db
        .project_file_register("wp1-workspace", project, "owned.bin")
        .unwrap();
    let read = |object: ObjectRef, hash: String| FileBytesInput {
        object,
        version_number: 1,
        expected_content_hash: hash,
    };
    let mut forged = file.object.clone();
    forged.workspace_id = "other".into();
    assert_eq!(
        FileServiceError::from_error(
            db.project_file_read_bytes(&read(forged, file.content_hash.clone().unwrap()))
                .unwrap_err()
        )
        .code,
        "ownership_mismatch"
    );
    let other = db
        .project_create(ProjectCreateInput {
            name: "Other".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let mut forged = file.object.clone();
    forged.scope = Scope::Project {
        project_id: other.id,
    };
    assert_eq!(
        FileServiceError::from_error(
            db.project_file_read_bytes(&read(forged, file.content_hash.clone().unwrap()))
                .unwrap_err()
        )
        .code,
        "ownership_mismatch"
    );
    assert_eq!(
        FileServiceError::from_error(
            db.project_file_read_bytes(&read(
                file.object.clone(),
                "sha256:".to_owned() + &"0".repeat(64)
            ))
            .unwrap_err()
        )
        .code,
        "hash_mismatch"
    );
    let versions = db
        .document_list_versions(crate::models::DocumentListVersionsInput {
            document_id: file.object.id.parse().unwrap(),
        })
        .unwrap();
    fs::remove_file(&versions[0].managed_path).unwrap();
    assert_eq!(
        FileServiceError::from_error(
            db.project_file_read_bytes(&read(file.object.clone(), file.content_hash.unwrap()))
                .unwrap_err()
        )
        .code,
        "snapshot_missing"
    );
    assert!(path.join("owned.bin").exists());
}
#[test]
fn directory_file_external_move_is_ambiguous_and_crossproject_physical_ownership_is_rejected() {
    let (_root, mut db, project, path) = fixture();
    fs::write(path.join("old.bin"), b"same").unwrap();
    let file = db
        .project_file_register("wp1-workspace", project, "old.bin")
        .unwrap();
    fs::rename(path.join("old.bin"), path.join("external.bin")).unwrap();
    assert_eq!(
        db.project_file_resolve(&file.object).unwrap().state,
        "missing"
    );
    let candidate = db
        .project_file_register("wp1-workspace", project, "external.bin")
        .unwrap();
    assert_eq!(candidate.object, file.object);
    assert_eq!(candidate.state, "ambiguous");
    let confirmed = db
        .project_file_reconcile(
            &file.object,
            "external.bin",
            1,
            file.content_hash.as_deref(),
            "location",
        )
        .unwrap();
    assert_eq!(confirmed.object, file.object);
    let other = db
        .project_create(ProjectCreateInput {
            name: "Other".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    fs::hard_link(
        path.join("external.bin"),
        Path::new(&other.root_path).join("alias.bin"),
    )
    .unwrap();
    let error = db
        .project_file_register("wp1-workspace", other.id, "alias.bin")
        .unwrap_err();
    assert_eq!(
        FileServiceError::from_error(error).code,
        "ownership_mismatch"
    );
    db.conn
        .execute(
            "UPDATE projects SET root_path=?1 WHERE id=?2",
            params![db.encode_path_ref(&path), other.id],
        )
        .unwrap();
    assert_eq!(
        FileServiceError::from_error(
            db.project_file_register("wp1-workspace", project, "external.bin")
                .unwrap_err()
        )
        .code,
        "ownership_mismatch"
    );
}

#[test]
fn directory_file_related_resources_resolve_from_actual_parent_with_bound_project_checks() {
    let (_root, db, project, path) = fixture();
    fs::create_dir(path.join("docs")).unwrap();
    fs::create_dir(path.join("images")).unwrap();
    fs::write(path.join("docs/note.md"), b"![image](../images/pic.png)").unwrap();
    fs::write(path.join("images/pic.png"), [0, 255, 4]).unwrap();
    let file = db
        .project_file_register("wp1-workspace", project, "docs/note.md")
        .unwrap();
    let resource = db
        .project_file_resolve_related(&file.object, "../images/pic.png?raw=1#anchor")
        .unwrap();
    assert_eq!(resource.relative_path, "images/pic.png");
    assert_eq!(bytes(&db, &resource), [0, 255, 4]);
    for reference in [
        "../../outside",
        "https://example.com/a",
        "data:image/png;base64,a",
        "/images/pic.png",
        "../.project-mind/secrets",
    ] {
        assert!(
            db.project_file_resolve_related(&file.object, reference)
                .is_err(),
            "{reference}"
        );
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(path.join("images/pic.png"), path.join("images/link.png"))
            .unwrap();
        assert!(db
            .project_file_resolve_related(&file.object, "../images/link.png")
            .is_err());
    }
}

#[test]
fn directory_file_model_source_ref_matches_actual_fixed_history_and_enforces_source_policy() {
    use crate::agent::{
        access::{Caller, RequestContext, ScopeGrant},
        models::WorkspaceBinding,
    };
    let (_root, db, project, path) = fixture();
    fs::write(path.join("evidence.txt"), b"model actually read old").unwrap();
    let first = db
        .project_file_register("wp1-workspace", project, "evidence.txt")
        .unwrap();
    fs::write(path.join("evidence.txt"), b"current changed").unwrap();
    db.project_file_resolve(&first.object).unwrap();
    let binding = WorkspaceBinding {
        workspace_id: "wp1-workspace".into(),
        generation: "opened".into(),
    };
    let request = RequestContext {
        binding: binding.clone(),
        caller: Caller::BuiltinRun {
            run_id: "actual-model-read".into(),
        },
        request_id: "read-fixed-history".into(),
        scope_grant: ScopeGrant {
            object_keys: None,
            workspace_id: binding.workspace_id.clone(),
            workspace_content: false,
            project_ids: vec![project],
            operations: vec!["source.read".into()],
        },
    };
    let input = FileBytesInput {
        object: first.object.clone(),
        version_number: 1,
        expected_content_hash: first.content_hash.clone().unwrap(),
    };
    let (read, source) = db
        .project_file_read_source(&request, &binding, &input)
        .unwrap();
    assert_eq!(
        STANDARD.decode(read.base64).unwrap(),
        b"model actually read old"
    );
    assert_eq!(source.object, first.object);
    assert_eq!(source.file_version, Some(1));
    assert_eq!(source.revision, first.content_hash.unwrap());
    db.conn
        .execute(
            "INSERT INTO source_access_policies(object_key,excluded,revision) VALUES (?1,1,1)",
            [input.object.key().unwrap()],
        )
        .unwrap();
    assert!(db
        .project_file_read_source(&request, &binding, &input)
        .is_err());
    let denied = RequestContext {
        scope_grant: ScopeGrant {
            project_ids: vec![],
            ..request.scope_grant.clone()
        },
        ..request
    };
    assert!(db
        .project_file_read_source(&denied, &binding, &input)
        .is_err());
}

#[test]
fn directory_file_delete_unmanages_without_deleting_user_live_bytes_or_snapshots() {
    let (_root, mut db, project, path) = fixture();
    fs::write(path.join("keep.bin"), b"user-owned").unwrap();
    let file = db
        .project_file_register("wp1-workspace", project, "keep.bin")
        .unwrap();
    let versions = db
        .document_list_versions(crate::models::DocumentListVersionsInput {
            document_id: file.object.id.parse().unwrap(),
        })
        .unwrap();
    db.document_delete(crate::models::DocumentDeleteInput {
        document_id: file.object.id.parse().unwrap(),
    })
    .unwrap();
    assert_eq!(fs::read(path.join("keep.bin")).unwrap(), b"user-owned");
    assert_eq!(fs::read(&versions[0].managed_path).unwrap(), b"user-owned");
    assert!(db.project_file_resolve(&file.object).is_err());
}

#[test]
fn directory_file_fixed_reference_blocks_deletion_and_retains_exact_history() {
    let (_root, mut db, project, path) = fixture();
    fs::write(path.join("cited.txt"), b"cited old version").unwrap();
    let file = db
        .project_file_register("wp1-workspace", project, "cited.txt")
        .unwrap();
    fs::write(path.join("cited.txt"), b"latest").unwrap();
    db.project_file_resolve(&file.object).unwrap();
    db.conn.execute("INSERT INTO content_reference_edges(source_object_key,target_object_key,relation,locator_json,target_revision) VALUES ('wp1-workspace/project:1/record/12',?1,'internal_reference','{}',?2)",params![file.object.key().unwrap(),file.content_hash]).unwrap();
    let error = db
        .document_delete(crate::models::DocumentDeleteInput {
            document_id: file.object.id.parse().unwrap(),
        })
        .unwrap_err();
    assert!(error.to_string().contains("fixed content references"));
    assert_eq!(bytes(&db, &file), b"cited old version");
    assert_eq!(fs::read(path.join("cited.txt")).unwrap(), b"latest");
}

fn restore_request(project: i64) -> crate::agent::access::RequestContext {
    use crate::agent::{
        access::{Caller, RequestContext, ScopeGrant},
        models::WorkspaceBinding,
    };
    RequestContext {
        binding: WorkspaceBinding {
            workspace_id: "wp1-workspace".into(),
            generation: "opened".into(),
        },
        caller: Caller::Gui,
        request_id: "restore-history".into(),
        scope_grant: ScopeGrant {
            object_keys: None,
            workspace_id: "wp1-workspace".into(),
            workspace_content: false,
            project_ids: vec![project],
            operations: vec!["source.read".into(), "file.restore".into()],
        },
    }
}

#[test]
fn directory_file_restore_a15_creates_new_head_at_original_location_and_keeps_immutable_history() {
    let (_root, mut db, project, path) = fixture();
    fs::write(path.join("live.bin"), [0, 255, 1]).unwrap();
    let first = db
        .project_file_register("wp1-workspace", project, "live.bin")
        .unwrap();
    fs::write(path.join("live.bin"), [2, 128, 0]).unwrap();
    let second = db.project_file_resolve(&first.object).unwrap();
    let id = first.object.id.parse().unwrap();
    let before = db
        .document_list_versions(crate::models::DocumentListVersionsInput { document_id: id })
        .unwrap();
    let old = before.iter().find(|v| v.version_number == 1).unwrap();
    let input = crate::file_version_restore::FileVersionRestore {
        object: first.object.clone(),
        version_id: old.id.to_string(),
        expected_version_number: 2,
        expected_content_hash: second.content_hash.clone().unwrap(),
    };
    let request = restore_request(project);
    let source = db
        .file_version_restore_source(&request, &request.binding, &input)
        .unwrap();
    let fence = crate::workspace_commit_fence::WorkspaceCommitFence::new();
    let result = db
        .file_version_restore_commit_bound(
            &request,
            &request.binding,
            &input,
            &source,
            &fence,
            &|| Ok(()),
        )
        .unwrap();
    assert_eq!(result.receipt.version_number, 3);
    assert_eq!(fs::read(path.join("live.bin")).unwrap(), [0, 255, 1]);
    let latest = db.project_file_resolve(&first.object).unwrap();
    assert_eq!(latest.object, first.object);
    assert_eq!(latest.relative_path, "live.bin");
    assert_eq!(latest.version_number, 3);
    assert_eq!(bytes(&db, &first), [0, 255, 1]);
    assert_eq!(bytes(&db, &second), [2, 128, 0]);
    let after = db
        .document_list_versions(crate::models::DocumentListVersionsInput { document_id: id })
        .unwrap();
    for old in before {
        let retained = after.iter().find(|v| v.id == old.id).unwrap();
        assert_eq!(retained.managed_path, old.managed_path);
        assert_eq!(retained.name, old.name);
    }
    let replay = db
        .file_version_restore_commit_bound(
            &request,
            &request.binding,
            &input,
            &source,
            &fence,
            &|| Ok(()),
        )
        .unwrap();
    assert!(!replay.committed);
    assert_eq!(replay.receipt.version_number, 3);
    assert_eq!(
        db.project_file_resolve(&first.object)
            .unwrap()
            .version_number,
        3
    );
}

#[test]
fn directory_file_same_bytes_replacement_keeps_registered_snapshot_path() {
    let (_root, mut db, project, path) = fixture();
    fs::write(path.join("live.bin"), b"same").unwrap();
    let first = db
        .project_file_register("wp1-workspace", project, "live.bin")
        .unwrap();
    let before = db
        .document_list_versions(crate::models::DocumentListVersionsInput {
            document_id: first.object.id.parse().unwrap(),
        })
        .unwrap();
    fs::write(path.join("atomic.bin"), b"same").unwrap();
    fs::rename(path.join("atomic.bin"), path.join("live.bin")).unwrap();
    let snapshot_dir = db
        .document_record(first.object.id.parse().unwrap())
        .unwrap()
        .history_dir_path;
    let snapshots = fs::read_dir(&snapshot_dir).unwrap().count();
    let accepted = db.project_file_resolve(&first.object).unwrap();
    assert_eq!(accepted.state, "ready");
    assert_eq!(accepted.version_number, first.version_number);
    assert_eq!(accepted.content_hash, first.content_hash);
    let watermark = db.committed_change_watermark().unwrap();
    for _ in 0..3 {
        assert_eq!(
            db.project_file_resolve(&first.object).unwrap().state,
            "ready"
        );
        assert_eq!(db.committed_change_watermark().unwrap(), watermark);
        assert_eq!(fs::read_dir(&snapshot_dir).unwrap().count(), snapshots);
    }
    let physical: String = db
        .conn
        .query_row(
            "SELECT physical_identity FROM project_directory_files WHERE document_id=?1",
            [first.object.id.parse::<i64>().unwrap()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        physical,
        serde_json::to_string(&file_versions::path_identity(&path.join("live.bin")).unwrap())
            .unwrap()
    );
    assert_eq!(bytes(&db, &first), b"same");
    let after = db
        .document_list_versions(crate::models::DocumentListVersionsInput {
            document_id: first.object.id.parse().unwrap(),
        })
        .unwrap();
    assert_eq!(after[0].managed_path, before[0].managed_path);
}

#[test]
fn directory_file_open_local_uses_only_ready_live_file_and_ignores_preview_budget() {
    let (_root, db, project, path) = fixture();
    fs::File::create(path.join("large.unknown"))
        .unwrap()
        .set_len(10 * 1024 * 1024 + 1)
        .unwrap();
    let file = db
        .project_file_register("wp1-workspace", project, "large.unknown")
        .unwrap();
    db.project_file_open_local_with(&file.object, |actual| {
        assert_eq!(actual, path.join("large.unknown"));
        Ok(())
    })
    .unwrap();
    fs::write(path.join("replacement"), b"foreign").unwrap();
    fs::rename(path.join("replacement"), path.join("large.unknown")).unwrap();
    db.project_file_open_local_with(&file.object, |actual| {
        assert_eq!(actual, path.join("large.unknown"));
        assert_eq!(fs::read(actual).unwrap(), b"foreign");
        Ok(())
    })
    .unwrap();
    assert_eq!(
        db.project_file_resolve(&file.object)
            .unwrap()
            .version_number,
        2
    );
    fs::remove_file(path.join("large.unknown")).unwrap();
    assert!(db
        .project_file_open_local_with(&file.object, |_| panic!(
            "history must not replace missing live file"
        ))
        .is_err());
}

#[test]
fn directory_file_restore_failed_sql_commit_restores_original_live_and_can_retry() {
    let (_root, mut db, project, path) = fixture();
    fs::write(path.join("live.txt"), b"old").unwrap();
    let first = db
        .project_file_register("wp1-workspace", project, "live.txt")
        .unwrap();
    fs::write(path.join("live.txt"), b"current").unwrap();
    let second = db.project_file_resolve(&first.object).unwrap();
    let old = db
        .document_list_versions(crate::models::DocumentListVersionsInput {
            document_id: first.object.id.parse().unwrap(),
        })
        .unwrap()
        .into_iter()
        .find(|v| v.version_number == 1)
        .unwrap();
    let input = crate::file_version_restore::FileVersionRestore {
        object: first.object.clone(),
        version_id: old.id.to_string(),
        expected_version_number: 2,
        expected_content_hash: second.content_hash.clone().unwrap(),
    };
    let request = restore_request(project);
    let source = db
        .file_version_restore_source(&request, &request.binding, &input)
        .unwrap();
    let fence = crate::workspace_commit_fence::WorkspaceCommitFence::new();
    db.conn.execute_batch("CREATE TRIGGER fail_directory_restore BEFORE INSERT ON document_versions WHEN NEW.version_number=3 BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
    assert!(db
        .file_version_restore_commit_bound(
            &request,
            &request.binding,
            &input,
            &source,
            &fence,
            &|| Ok(())
        )
        .is_err());
    assert_eq!(fs::read(path.join("live.txt")).unwrap(), b"current");
    assert_eq!(
        db.project_file_resolve(&first.object)
            .unwrap()
            .version_number,
        2
    );
    assert_eq!(bytes(&db, &first), b"old");
    assert_eq!(bytes(&db, &second), b"current");
    db.conn
        .execute_batch("DROP TRIGGER fail_directory_restore;")
        .unwrap();
    assert_eq!(
        db.file_version_restore_commit_bound(
            &request,
            &request.binding,
            &input,
            &source,
            &fence,
            &|| Ok(())
        )
        .unwrap()
        .receipt
        .version_number,
        3
    );
}

#[test]
fn directory_file_concurrent_registration_keeps_one_identity() {
    let (root, db, project, path) = fixture();
    fs::write(path.join("same.bin"), b"identity").unwrap();
    drop(db);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let root = root.path().canonicalize().unwrap();
            let barrier = barrier.clone();
            let mut db =
                Database::open_runtime_connection(&root.join("test.sqlite"), &root, None).unwrap();
            db.bind_native_workspace("wp1-workspace").unwrap();
            std::thread::spawn(move || {
                barrier.wait();
                db.project_file_register("wp1-workspace", project, "same.bin")
                    .unwrap()
            })
        })
        .collect();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(results[0].object, results[1].object);
    assert_eq!(results[0].version_number, 1);
    assert_eq!(results[1].version_number, 1);
}

#[test]
fn directory_file_retained_agent_json_sources_protect_fixed_history_without_head_edges() {
    for owner in ["evidence", "output"] {
        let (_root, mut db, project, path) = fixture();
        fs::write(path.join("cited.bin"), b"fixed original").unwrap();
        let file = db
            .project_file_register("wp1-workspace", project, "cited.bin")
            .unwrap();
        let source = serde_json::json!({"object":file.object,"revision":file.content_hash,"fileVersion":1,"title":"cited.bin","excerpt":""});
        if owner == "evidence" {
            db.conn.execute("INSERT INTO agent_evidence(id,owner_kind,owner_id,source_ref_json,excerpt) VALUES ('fixed','overview','saved',?1,'')",[source.to_string()]).unwrap();
        } else {
            db.conn.execute_batch("INSERT INTO agent_sessions(id,scope_key,title,runtime_id,state,session_path,created_at,updated_at) VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','project:1','Source','pi','active','.project-mind/agent/sessions/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/session.jsonl','now','now'); INSERT INTO agent_runs(id,session_id,client_request_id,state,context_manifest_json,grant_json,started_at) VALUES ('saved','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','saved','completed','{}','{}','now');").unwrap();
            db.conn.execute("INSERT INTO agent_outputs(id,run_id,ordinal,kind,intent,payload_json,sources_json,state) VALUES ('saved','saved',0,'record','create','{}',?1,'committed')",[serde_json::json!([source]).to_string()]).unwrap();
        }
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM content_reference_edges", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(db
            .document_delete(crate::models::DocumentDeleteInput {
                document_id: file.object.id.parse().unwrap()
            })
            .unwrap_err()
            .to_string()
            .contains("fixed content references"));
        assert_eq!(bytes(&db, &file), b"fixed original");
        // A legacy navigation object without an explicit fixed version is not
        // historical evidence, even when it happens to carry a hash string.
        if owner == "evidence" {
            db.conn.execute("UPDATE agent_evidence SET source_ref_json=json_remove(source_ref_json,'$.fileVersion')",[]).unwrap();
        } else {
            db.conn.execute("UPDATE agent_outputs SET sources_json=json_remove(sources_json,'$[0].fileVersion')",[]).unwrap();
        }
        db.document_delete(crate::models::DocumentDeleteInput {
            document_id: file.object.id.parse().unwrap(),
        })
        .unwrap();
        assert_eq!(fs::read(path.join("cited.bin")).unwrap(), b"fixed original");
    }
}

#[test]
fn directory_file_project_delete_rejects_fixed_references_without_losing_project_or_history() {
    for reference in ["head", "retained_json"] {
        let (_root, mut db, project, path) = fixture();
        fs::write(path.join("cited.bin"), b"historical evidence").unwrap();
        let first = db
            .project_file_register("wp1-workspace", project, "cited.bin")
            .unwrap();
        fs::write(path.join("cited.bin"), b"current evidence").unwrap();
        let second = db.project_file_resolve(&first.object).unwrap();
        let id = first.object.id.parse().unwrap();
        let before = db
            .document_list_versions(crate::models::DocumentListVersionsInput { document_id: id })
            .unwrap();
        if reference == "head" {
            db.conn.execute("INSERT INTO content_reference_edges(source_object_key,target_object_key,relation,target_revision) VALUES ('consumer',?1,'internal_reference',?2)",params![first.object.key().unwrap(),first.content_hash]).unwrap();
        } else {
            let source = serde_json::json!({"object":first.object,"revision":first.content_hash,"fileVersion":1,"title":"cited.bin","excerpt":""});
            db.conn.execute("INSERT INTO agent_evidence(id,owner_kind,owner_id,source_ref_json,excerpt) VALUES ('historical','overview','retained',?1,'')",[source.to_string()]).unwrap();
            assert_eq!(
                db.conn
                    .query_row("SELECT count(*) FROM content_reference_edges", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .unwrap(),
                0
            );
        }
        let watermark = db.committed_change_watermark().unwrap();
        let error = db
            .project_delete(crate::models::ProjectDeleteInput {
                project_id: project,
            })
            .unwrap_err();
        assert!(
            error.to_string().contains("fixed content references"),
            "{error:#}"
        );
        assert_eq!(db.project_record(project).unwrap().id, project);
        assert_eq!(db.document_record(id).unwrap().current_version_number, 2);
        let after = db
            .document_list_versions(crate::models::DocumentListVersionsInput { document_id: id })
            .unwrap();
        assert_eq!(
            serde_json::to_value(&after).unwrap(),
            serde_json::to_value(&before).unwrap()
        );
        assert_eq!(bytes(&db, &first), b"historical evidence");
        assert_eq!(bytes(&db, &second), b"current evidence");
        assert_eq!(
            fs::read(path.join("cited.bin")).unwrap(),
            b"current evidence"
        );
        assert_eq!(db.committed_change_watermark().unwrap(), watermark);
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM project_asset_cleanup WHERE project_id=?1",
                    [project],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
}

#[test]
fn directory_file_project_delete_without_fixed_references_keeps_existing_cleanup_behavior() {
    let (_root, mut db, project, path) = fixture();
    fs::write(path.join("uncited.bin"), b"ordinary file").unwrap();
    let file = db
        .project_file_register("wp1-workspace", project, "uncited.bin")
        .unwrap();
    let id = file.object.id.parse().unwrap();
    let versions = db
        .document_list_versions(crate::models::DocumentListVersionsInput { document_id: id })
        .unwrap();
    assert_eq!(
        db.project_delete(crate::models::ProjectDeleteInput {
            project_id: project
        })
        .unwrap()
        .id,
        project
    );
    assert!(db.project_record(project).is_err());
    assert!(db.document_record(id).is_err());
    assert_eq!(
        db.conn
            .query_row(
                "SELECT count(*) FROM document_versions WHERE document_id=?1",
                [id],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert!(!path.exists());
    assert!(!Path::new(&versions[0].managed_path).exists());
    assert_eq!(
        db.conn
            .query_row(
                "SELECT count(*) FROM project_asset_cleanup WHERE project_id=?1",
                [project],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

const RESTORE_OLD_BYTES: &[u8] = &[0, 255, 1, 13, 10];
const RESTORE_CURRENT_BYTES: &[u8] = &[128, 2, 0, 13, 10];

fn directory_restore_crash_setup() -> (
    tempfile::TempDir,
    DirectoryFile,
    DirectoryFile,
    crate::file_version_restore::FileVersionRestore,
) {
    let (root, mut db, project, path) = fixture();
    fs::write(path.join("live.bin"), RESTORE_OLD_BYTES).unwrap();
    let first = db
        .project_file_register("wp1-workspace", project, "live.bin")
        .unwrap();
    fs::write(path.join("live.bin"), RESTORE_CURRENT_BYTES).unwrap();
    let second = db.project_file_resolve(&first.object).unwrap();
    let versions = db
        .document_list_versions(crate::models::DocumentListVersionsInput {
            document_id: first.object.id.parse().unwrap(),
        })
        .unwrap();
    let input = crate::file_version_restore::FileVersionRestore {
        object: first.object.clone(),
        version_id: versions
            .iter()
            .find(|v| v.version_number == 1)
            .unwrap()
            .id
            .to_string(),
        expected_version_number: 2,
        expected_content_hash: second.content_hash.clone().unwrap(),
    };
    db.conn.execute("INSERT INTO content_reference_edges(source_object_key,target_object_key,relation,target_revision) VALUES ('saved-reference',?1,'internal_reference',?2)",params![first.object.key().unwrap(),first.content_hash]).unwrap();
    fs::write(
        root.path().join(".project-mind/restore-fixture.json"),
        serde_json::to_vec(&input).unwrap(),
    )
    .unwrap();
    (root, first, second, input)
}

fn directory_restore_crash_open(root: &Path) -> Database {
    let opened = crate::workspace_initialization::open_workspace_database(
        &root.join("test.sqlite"),
        root,
        None,
        "wp1-workspace",
    )
    .unwrap();
    assert!(opened.checkpoint_error.is_none());
    opened.db
}

fn directory_restore_crash(root: &Path, stage: u8) {
    let output = hidden_test_command(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "db::project_directory_files::tests::directory_file_restore_crash_process_fixture",
            "--ignored",
            "--nocapture",
        ])
        .env("MIND_DIRECTORY_RESTORE_CRASH_FIXTURE", root)
        .env("MIND_DIRECTORY_RESTORE_CRASH_STAGE", stage.to_string())
        .output()
        .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(
            output.status.signal(),
            Some(9),
            "stage {stage}: must be SIGKILL, not cleanup or panic: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[cfg(not(unix))]
    assert_eq!(
        output.status.code(),
        Some(91),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
#[ignore = "subprocess-only fixture started by directory restore crash tests"]
fn directory_file_restore_crash_process_fixture() {
    let Ok(root) = std::env::var("MIND_DIRECTORY_RESTORE_CRASH_FIXTURE") else {
        return;
    };
    let root = Path::new(&root);
    let input: crate::file_version_restore::FileVersionRestore =
        serde_json::from_slice(&fs::read(root.join(".project-mind/restore-fixture.json")).unwrap())
            .unwrap();
    let mut db = directory_restore_crash_open(root);
    let request = restore_request(file_id(&input.object).unwrap().0.unwrap());
    let source = db
        .file_version_restore_source(&request, &request.binding, &input)
        .unwrap();
    db.file_version_restore_commit_bound(
        &request,
        &request.binding,
        &input,
        &source,
        &crate::workspace_commit_fence::WorkspaceCommitFence::new(),
        &|| Ok(()),
    )
    .unwrap();
    panic!("directory restore crash boundary not reached");
}

#[test]
fn directory_file_restore_process_crashes_recover_all_durable_boundaries_and_retry_once() {
    // 1: journal committed; 2: original moved away; 3: historical live bytes
    // placed before SQL; 4: new version and receipt committed before cleanup.
    for stage in 1..=4 {
        let (root, first, second, input) = directory_restore_crash_setup();
        let mut db = directory_restore_crash_open(root.path());
        let before = db
            .document_list_versions(crate::models::DocumentListVersionsInput {
                document_id: first.object.id.parse().unwrap(),
            })
            .unwrap();
        let watermark = db.committed_change_watermark().unwrap();
        drop(db);
        directory_restore_crash(root.path(), stage);
        let mut db = directory_restore_crash_open(root.path());
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM project_directory_restores", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1,
            "durable intent at stage {stage}"
        );
        let live = root.path().join("Project files/live.bin");
        match stage {
            1 => assert_eq!(fs::read(&live).unwrap(), RESTORE_CURRENT_BYTES),
            2 => assert!(!live.exists()),
            _ => assert_eq!(fs::read(&live).unwrap(), RESTORE_OLD_BYTES),
        }
        let expected_number = if stage == 4 { 3 } else { 2 };
        let recovered = db.project_file_resolve(&first.object).unwrap();
        assert_eq!(recovered.state, "ready", "stage {stage}");
        assert_eq!(recovered.version_number, expected_number, "stage {stage}");
        assert_eq!(bytes(&db, &recovered), fs::read(&live).unwrap());
        assert_eq!(
            fs::read(&live).unwrap(),
            if stage == 4 {
                RESTORE_OLD_BYTES
            } else {
                RESTORE_CURRENT_BYTES
            }
        );
        assert_eq!(
            db.committed_change_watermark().unwrap(),
            watermark + i64::from(stage == 4)
        );
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM project_directory_restores", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let after_recovery = db.committed_change_watermark().unwrap();
        drop(db);
        let mut db = directory_restore_crash_open(root.path());
        assert_eq!(
            db.project_file_resolve(&first.object)
                .unwrap()
                .version_number,
            expected_number
        );
        assert_eq!(db.committed_change_watermark().unwrap(), after_recovery);
        let request = restore_request(file_id(&first.object).unwrap().0.unwrap());
        let source = db
            .file_version_restore_source(&request, &request.binding, &input)
            .unwrap();
        let fence = crate::workspace_commit_fence::WorkspaceCommitFence::new();
        let committed = db
            .file_version_restore_commit_bound(
                &request,
                &request.binding,
                &input,
                &source,
                &fence,
                &|| Ok(()),
            )
            .unwrap();
        assert_eq!(committed.receipt.version_number, 3);
        assert_eq!(committed.committed, stage != 4);
        assert!(
            !db.file_version_restore_commit_bound(
                &request,
                &request.binding,
                &input,
                &source,
                &fence,
                &|| Ok(())
            )
            .unwrap()
            .committed
        );
        let latest = db.project_file_resolve(&first.object).unwrap();
        assert_eq!(latest.version_number, 3);
        assert_eq!(bytes(&db, &latest), RESTORE_OLD_BYTES);
        assert_eq!(fs::read(&live).unwrap(), RESTORE_OLD_BYTES);
        assert_eq!(bytes(&db, &first), RESTORE_OLD_BYTES);
        assert_eq!(bytes(&db, &second), RESTORE_CURRENT_BYTES);
        let versions = db
            .document_list_versions(crate::models::DocumentListVersionsInput {
                document_id: first.object.id.parse().unwrap(),
            })
            .unwrap();
        assert_eq!(versions.len(), 3);
        for original in &before {
            let retained = versions.iter().find(|v| v.id == original.id).unwrap();
            assert_eq!(
                serde_json::to_value(retained).unwrap(),
                serde_json::to_value(original).unwrap()
            );
        }
        assert_eq!(db.conn.query_row("SELECT count(*) FROM agent_operation_receipts WHERE caller_id='gui' AND request_id='restore-history' AND operation='file.version.commit'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(db.conn.query_row("SELECT count(*) FROM content_reference_edges WHERE target_object_key=?1 AND target_revision=?2",params![first.object.key().unwrap(),first.content_hash],|r|r.get::<_,i64>(0)).unwrap(),1);
    }
}

#[test]
fn directory_file_restore_process_crashes_never_overwrite_foreign_live_files() {
    for stage in 2..=4 {
        let (root, first, second, _) = directory_restore_crash_setup();
        directory_restore_crash(root.path(), stage);
        let db = directory_restore_crash_open(root.path());
        let journal: String = db
            .conn
            .query_row("SELECT journal FROM project_directory_restores", [], |r| {
                r.get(0)
            })
            .unwrap();
        let journal: serde_json::Value = serde_json::from_str(&journal).unwrap();
        let backup = db.decode_path_ref(journal["backup"].as_str().unwrap());
        let live = root.path().join("Project files/live.bin");
        if live.exists() {
            fs::rename(&live, root.path().join("Project files/displaced.bin")).unwrap();
        }
        // An uncommitted recovery must not adopt a foreign physical identity.
        // After SQL committed, cleanup can finish before normal same-path
        // reconciliation accepts an external replacement without writing it.
        let foreign_bytes = if stage == 2 {
            RESTORE_CURRENT_BYTES
        } else {
            RESTORE_OLD_BYTES
        };
        fs::write(&live, foreign_bytes).unwrap();
        let identity = file_versions::path_identity(&live).unwrap();
        let expected_state = if stage == 4 { "ready" } else { "ambiguous" };
        assert_eq!(
            db.project_file_resolve(&first.object).unwrap().state,
            expected_state,
            "restore stage {stage}"
        );
        assert_eq!(fs::read(&live).unwrap(), foreign_bytes);
        assert_eq!(file_versions::path_identity(&live).unwrap(), identity);
        assert_eq!(bytes(&db, &first), RESTORE_OLD_BYTES);
        assert_eq!(bytes(&db, &second), RESTORE_CURRENT_BYTES);
        assert_eq!(
            db.document_record(first.object.id.parse().unwrap())
                .unwrap()
                .current_version_number,
            if stage == 4 { 3 } else { 2 }
        );
        if stage < 4 {
            for (hash, confirmation) in [
                (second.content_hash.as_deref(), "replacement"),
                (None, "registration"),
            ] {
                let rejected = db
                    .project_file_reconcile(&first.object, "live.bin", 2, hash, confirmation)
                    .unwrap_err();
                assert_eq!(
                    FileServiceError::from_error(rejected).code,
                    "ambiguous_identity"
                );
            }
            assert_eq!(fs::read(&backup).unwrap(), RESTORE_CURRENT_BYTES);
            assert_eq!(
                db.conn
                    .query_row("SELECT count(*) FROM project_directory_restores", [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                1
            );
        }
        let watermark = db.committed_change_watermark().unwrap();
        drop(db);
        let db = directory_restore_crash_open(root.path());
        assert_eq!(
            db.project_file_resolve(&first.object).unwrap().state,
            expected_state
        );
        assert_eq!(db.committed_change_watermark().unwrap(), watermark);
        assert_eq!(fs::read(&live).unwrap(), foreign_bytes);
        assert_eq!(file_versions::path_identity(&live).unwrap(), identity);
    }
}

#[test]
fn directory_file_restore_process_kill_during_sql_transaction_recovers_and_retries_once() {
    let (root, first, second, input) = directory_restore_crash_setup();
    let ready = root.path().join("restore-ready.marker");
    let resume = root.path().join("restore-resume.marker");
    let mut child = hidden_test_command(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "db::project_directory_files::tests::directory_file_restore_crash_process_fixture",
            "--ignored",
            "--nocapture",
        ])
        .env("MIND_DIRECTORY_RESTORE_CRASH_FIXTURE", root.path())
        .env_remove("MIND_DIRECTORY_RESTORE_CRASH_STAGE")
        .env("MIND_DIRECTORY_RESTORE_PAUSE_STAGE", "3")
        .env("MIND_DIRECTORY_RESTORE_READY", &ready)
        .env("MIND_DIRECTORY_RESTORE_RESUME", &resume)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !ready.exists() {
        if child.try_wait().unwrap().is_some() || std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let output = child.wait_with_output().unwrap();
            panic!(
                "restore handshake failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    // A real SQLite reader holds COMMIT at the exclusive-lock boundary. The
    // newly created rollback journal proves the publisher entered its write
    // transaction, after the historical live bytes were already placed.
    let reader = rusqlite::Connection::open(root.path().join("test.sqlite")).unwrap();
    assert_eq!(
        reader
            .query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "delete"
    );
    reader
        .execute_batch("BEGIN; SELECT count(*) FROM documents;")
        .unwrap();
    let sqlite_journal = root.path().join("test.sqlite-journal");
    assert!(!sqlite_journal.exists());
    fs::write(&resume, b"resume").unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !fs::metadata(&sqlite_journal).is_ok_and(|metadata| metadata.len() > 512) {
        if child.try_wait().unwrap().is_some() || std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let output = child.wait_with_output().unwrap();
            panic!(
                "restore SQL transaction boundary not reached: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    assert_eq!(
        reader
            .query_row(
                "SELECT current_version_number FROM documents WHERE id=?1",
                [first.object.id.parse::<i64>().unwrap()],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        2
    );
    assert_eq!(
        fs::read(root.path().join("Project files/live.bin")).unwrap(),
        RESTORE_OLD_BYTES
    );
    child.kill().unwrap();
    let output = child.wait_with_output().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(output.status.signal(), Some(9));
    }
    #[cfg(not(unix))]
    assert!(!output.status.success());
    reader.execute_batch("ROLLBACK;").unwrap();
    drop(reader);
    let mut db = directory_restore_crash_open(root.path());
    let recovered = db.project_file_resolve(&first.object).unwrap();
    assert_eq!(recovered.state, "ready");
    assert_eq!(recovered.version_number, 2);
    assert_eq!(
        fs::read(root.path().join("Project files/live.bin")).unwrap(),
        RESTORE_CURRENT_BYTES
    );
    assert_eq!(bytes(&db, &first), RESTORE_OLD_BYTES);
    assert_eq!(bytes(&db, &second), RESTORE_CURRENT_BYTES);
    assert_eq!(
        db.conn
            .query_row("SELECT count(*) FROM project_directory_restores", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        db.project_file_resolve(&first.object)
            .unwrap()
            .version_number,
        2
    );
    let request = restore_request(file_id(&first.object).unwrap().0.unwrap());
    let source = db
        .file_version_restore_source(&request, &request.binding, &input)
        .unwrap();
    let fence = crate::workspace_commit_fence::WorkspaceCommitFence::new();
    assert_eq!(
        db.file_version_restore_commit_bound(
            &request,
            &request.binding,
            &input,
            &source,
            &fence,
            &|| Ok(())
        )
        .unwrap()
        .receipt
        .version_number,
        3
    );
    assert!(
        !db.file_version_restore_commit_bound(
            &request,
            &request.binding,
            &input,
            &source,
            &fence,
            &|| Ok(())
        )
        .unwrap()
        .committed
    );
    assert_eq!(
        fs::read(root.path().join("Project files/live.bin")).unwrap(),
        RESTORE_OLD_BYTES
    );
}

#[test]
fn directory_scan_failure_does_not_starve_later_files() {
    let (_root, db, project, path) = fixture();
    // Fail one real registration without relying on OS-specific filenames or
    // permissions. Windows interprets ':' as an alternate data stream.
    fs::write(path.join("a.txt"), b"first file").unwrap();
    fs::write(path.join("z.txt"), b"later business file").unwrap();
    db.conn.execute_batch(
        "CREATE TRIGGER fail_first_scan_entry BEFORE INSERT ON documents \
         WHEN NEW.name='a.txt' BEGIN SELECT RAISE(ABORT,'fixture scan failure'); END;"
    ).unwrap();
    let first = db
        .project_file_scan("wp1-workspace", project, None, 1, false)
        .unwrap();
    assert_eq!(first.failures.len(), 1);
    let second = db
        .project_file_scan(
            "wp1-workspace",
            project,
            first.next_cursor.as_deref(),
            1,
            false,
        )
        .unwrap();
    assert_eq!(
        second.files.len(),
        1,
        "a failed entry must not pin the cursor forever"
    );
    assert_eq!(second.files[0].relative_path, "z.txt");
}

#[test]
fn directory_discovery_keeps_oversized_file_visible_and_continues_without_rewriting() {
    let (_root, db, project, path) = fixture();
    fs::File::create(path.join("a.bin"))
        .unwrap()
        .set_len(100 * 1024 * 1024 + 1)
        .unwrap();
    fs::write(path.join("z.txt"), b"after oversized file").unwrap();
    let first = db
        .project_file_scan_new("wp1-workspace", project, None, 1)
        .unwrap();
    assert_eq!(first.files[0].state, "unavailable");
    assert_eq!(first.files[0].version_number, 0);
    let next = db
        .project_file_scan_new("wp1-workspace", project, first.next_cursor.as_deref(), 1)
        .unwrap();
    assert_eq!(next.files[0].relative_path, "z.txt");
    assert_eq!(next.files[0].state, "ready");
    let changes = db.conn.total_changes();
    let scan = db
        .project_file_scan_new("wp1-workspace", project, None, 100)
        .unwrap();
    assert!(scan.complete);
    assert!(scan.files.is_empty());
    assert_eq!(db.conn.total_changes(), changes);
}

#[test]
fn directory_scan_yields_on_directory_only_trees() {
    let (_root, db, project, path) = fixture();
    for i in 0..150 {
        fs::create_dir(path.join(format!("folder-{i:03}"))).unwrap();
    }
    let mut cursor = None;
    let mut opened = std::collections::HashSet::new();
    let mut entries_read = 0;
    let mut complete = false;
    // Real enumeration and visited-entry budgets are independent. Reading a
    // full 128-entry root batch may defer its first empty child to the next
    // page. Termination stays bounded without assuming precisely two pages.
    for page in 0..4 {
        let scan = db.project_file_scan_new("wp1-workspace", project, cursor.as_deref(), 1).unwrap();
        assert!(scan.files.is_empty());
        assert!(scan.failures.is_empty());
        assert!(scan.entries_read <= 128);
        entries_read += scan.entries_read;
        for directory in scan.opened_directories {
            assert!(opened.insert(directory), "a directory must not be opened twice");
        }
        cursor = scan.next_cursor;
        if cursor.is_none() { complete = scan.complete; break; }
        assert!(!scan.complete);
        if page == 0 { assert!(!opened.is_empty()); }
    }
    assert!(complete, "150 empty directories must finish within four bounded pages");
    assert!(cursor.is_none());
    assert_eq!(entries_read, 150, "root entries must each be read exactly once");
    let expected: std::collections::HashSet<_> = std::iter::once(String::new())
        .chain((0..150).map(|i| format!("folder-{i:03}"))).collect();
    assert_eq!(opened, expected, "every empty directory must be visited exactly once");
}

#[test]
fn directory_discovery_resumes_past_many_known_paths_to_find_a_new_folder() {
    let (_root, db, project, path) = fixture();
    for i in 0..140 {
        fs::write(path.join(format!("file-{i:03}")), b"known").unwrap();
    }
    let mut cursor = None;
    loop {
        let page = db
            .project_file_scan_new("wp1-workspace", project, cursor.as_deref(), 100)
            .unwrap();
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    fs::create_dir(path.join("zz-copied")).unwrap();
    fs::write(path.join("zz-copied/new.txt"), b"new folder file").unwrap();
    let mut found = vec![];
    let mut complete = false;
    for _ in 0..10 {
        let page = db
            .project_file_scan_new("wp1-workspace", project, cursor.as_deref(), 5)
            .unwrap();
        found.extend(page.files);
        cursor = page.next_cursor;
        if cursor.is_none() {
            complete = page.complete;
            break;
        }
    }
    assert!(complete);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].relative_path, "zz-copied/new.txt");
}

#[test]
fn directory_scan_cursor_uses_utf8_order_for_non_bmp_filenames() {
    let (_root, db, project, path) = fixture();
    let names = ["\u{e000}.txt", "\u{10000}.txt"];
    for name in names {
        fs::write(path.join(name), b"unicode name").unwrap();
    }
    let first = db
        .project_file_scan_new("wp1-workspace", project, None, 1)
        .unwrap();
    assert_eq!(first.files[0].relative_path, names[0]);
    let second = db
        .project_file_scan_new("wp1-workspace", project, first.next_cursor.as_deref(), 1)
        .unwrap();
    assert_eq!(second.files[0].relative_path, names[1]);
}

fn ds_store_scan_excludes_metadata(only_new: bool) {
    hidden_scan_excludes_files_and_directories(only_new, false);
}

fn hidden_scan_excludes_files_and_directories(only_new: bool, native: bool) {
    let (_root, db, project, path) = fixture();
    fs::create_dir(path.join("sub")).unwrap();
    for relative in [
        ".DS_Store",
        "sub/.DS_Store",
        ".env",
        "sub/.env",
        "note.txt",
        "sub/note.txt",
    ] {
        fs::write(path.join(relative), relative.as_bytes()).unwrap();
    }
    for directory in [".git/nested", "sub/.cache/nested"] {
        fs::create_dir_all(path.join(directory)).unwrap();
        fs::write(
            path.join(directory).join("ordinary.txt"),
            b"hidden descendant",
        )
        .unwrap();
    }
    #[cfg(any(target_os = "macos", windows))]
    if native {
        fs::write(path.join("native-file.txt"), b"native hidden file").unwrap();
        fs::create_dir_all(path.join("native-folder/nested")).unwrap();
        fs::write(
            path.join("native-folder/nested/ordinary.txt"),
            b"native hidden descendant",
        )
        .unwrap();
        hidden_set_native_attribute(&path.join("native-file.txt"));
        hidden_set_native_attribute(&path.join("native-folder"));
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    assert!(!native);
    let mut cursor = None;
    let mut found = Vec::new();
    let mut complete = false;
    // A small page exercises exclusions across cursor boundaries too.
    for _ in 0..20 {
        let page = if only_new {
            db.project_file_scan_new("wp1-workspace", project, cursor.as_deref(), 1)
        } else {
            db.project_file_scan("wp1-workspace", project, cursor.as_deref(), 1, false)
        }
        .unwrap();
        assert!(page.failures.is_empty(), "{:?}", page.failures);
        found.extend(page.files.into_iter().map(|file| file.relative_path));
        cursor = page.next_cursor;
        if page.complete {
            complete = true;
            break;
        }
        assert!(cursor.is_some());
    }
    assert!(complete, "scan must finish despite excluded metadata");
    found.sort();
    assert_eq!(found, ["note.txt", "sub/note.txt"]);
    let count: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM documents WHERE project_id=?1",
            [project],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        count, 2,
        "hidden files and descendants must not be registered"
    );
    for relative in [".DS_Store", "sub/.DS_Store", ".env", "sub/.env"] {
        assert_eq!(fs::read(path.join(relative)).unwrap(), relative.as_bytes());
    }
}

#[test]
fn ds_store_automatic_scan_excludes_root_and_nested_metadata_keeps_ordinary_files() {
    ds_store_scan_excludes_metadata(true);
}

#[test]
fn ds_store_explicit_scan_excludes_root_and_nested_metadata_keeps_ordinary_files() {
    ds_store_scan_excludes_metadata(false);
}

fn ds_store_register_rejected(relative: &str) {
    hidden_register_and_import_rejected(relative, None);
}

fn hidden_register_and_import_rejected(relative: &str, native: Option<&str>) {
    let (_root, db, project, path) = fixture();
    fs::create_dir(path.join("sub")).unwrap();
    fs::create_dir_all(path.join(relative).parent().unwrap()).unwrap();
    fs::write(path.join(relative), b"Finder metadata").unwrap();
    #[cfg(any(target_os = "macos", windows))]
    if let Some(mark) = native {
        hidden_set_native_attribute(&path.join(mark));
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    assert!(native.is_none());
    let result = db.project_file_register("wp1-workspace", project, relative);
    // Use a separate project so an existing registration cannot make import
    // fail for a duplicate instead of rejecting the metadata at its boundary.
    let (_import_root, mut import_db, import_project, import_path) = fixture();
    fs::create_dir(import_path.join("sub")).unwrap();
    fs::create_dir_all(import_path.join(relative).parent().unwrap()).unwrap();
    fs::write(import_path.join(relative), b"Finder metadata").unwrap();
    #[cfg(any(target_os = "macos", windows))]
    if let Some(mark) = native {
        hidden_set_native_attribute(&import_path.join(mark));
    }
    let imported = import_db.document_import(crate::models::DocumentImportInput {
        project_id: Some(import_project),
        source_path: import_path.join(relative).to_string_lossy().into_owned(),
        is_starred: false,
        tag_ids: None,
    });
    assert_eq!(fs::read(path.join(relative)).unwrap(), b"Finder metadata");
    assert_eq!(
        fs::read(import_path.join(relative)).unwrap(),
        b"Finder metadata"
    );
    assert_eq!(
        (result.is_err(), imported.is_err()),
        (true, true),
        "register and explicit import must both reject metadata: {relative}"
    );
    let count: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM documents WHERE project_id=?1",
            [project],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    let imported_count: i64 = import_db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM documents WHERE project_id=?1",
            [import_project],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(imported_count, 0);
    assert_eq!(fs::read(path.join(relative)).unwrap(), b"Finder metadata");
}

#[test]
fn ds_store_register_rejects_root_metadata() {
    ds_store_register_rejected(".DS_Store");
}

#[test]
fn ds_store_register_rejects_nested_metadata() {
    ds_store_register_rejected("sub/.DS_Store");
}

#[test]
fn ds_store_filter_keeps_ordinary_files_registerable() {
    let (_root, db, project, path) = fixture();
    fs::create_dir(path.join("sub")).unwrap();
    for relative in ["note.txt", "sub/note.txt"] {
        fs::write(path.join(relative), b"business material").unwrap();
        let file = db
            .project_file_register("wp1-workspace", project, relative)
            .unwrap();
        assert_eq!(file.state, "ready");
        assert_eq!(file.relative_path, relative);
        assert_eq!(bytes(&db, &file), b"business material");
    }
}

fn ds_store_legacy_record_hidden_without_deletion(relative: &str) {
    hidden_legacy_record_hidden_without_deletion(relative, None);
}

fn hidden_legacy_record_hidden_without_deletion(relative: &str, native: Option<&str>) {
    let (_root, mut db, project, path) = fixture();
    fs::create_dir(path.join("sub")).unwrap();
    fs::write(path.join("legacy.bin"), b"retained metadata").unwrap();
    let file = db
        .project_file_register("wp1-workspace", project, "legacy.bin")
        .unwrap();
    let id: i64 = file.object.id.parse().unwrap();
    fs::create_dir_all(path.join(relative).parent().unwrap()).unwrap();
    fs::rename(path.join("legacy.bin"), path.join(relative)).unwrap();
    #[cfg(any(target_os = "macos", windows))]
    if let Some(mark) = native {
        hidden_set_native_attribute(&path.join(mark));
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    assert!(native.is_none());
    // Simulate a record made by an older release, without relying on register
    // continuing to accept metadata after the production fix.
    let encoded = db.encode_path_ref(&path.join(relative));
    db.conn.execute(
        "UPDATE documents SET name=?1,base_name=?1,managed_path=?2,original_path=?2 WHERE id=?3",
        params![Path::new(relative).file_name().unwrap().to_str().unwrap(), encoded, id],
    ).unwrap();
    for normal in ["note.txt"] {
        fs::write(path.join(normal), b"keep visible").unwrap();
        db.project_file_register("wp1-workspace", project, normal)
            .unwrap();
    }
    let record_state = |db: &Database| {
        db.conn.query_row(
        "SELECT name,base_name,managed_path,original_path,current_version_number,version_count FROM documents WHERE id=?1",
        [id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?, row.get::<_, i64>(5)?)),
    ).unwrap()
    };
    let before = record_state(&db);
    let versions_before = db
        .document_list_versions(crate::models::DocumentListVersionsInput { document_id: id })
        .unwrap();
    assert_eq!(versions_before.len(), 1);
    assert_eq!(versions_before[0].version_number, 1);
    let page = db
        .project_page_get(crate::models::ProjectIdInput {
            project_id: project,
        })
        .unwrap();
    let after = record_state(&db);
    assert_eq!(
        after, before,
        "hiding must retain the database record and version counters"
    );
    let versions_after = db
        .document_list_versions(crate::models::DocumentListVersionsInput { document_id: id })
        .unwrap();
    assert_eq!(
        serde_json::to_value(&versions_after).unwrap(),
        serde_json::to_value(&versions_before).unwrap()
    );
    assert_eq!(fs::read(path.join(relative)).unwrap(), b"retained metadata");
    assert_eq!(
        fs::read(&versions_after[0].managed_path).unwrap(),
        b"retained metadata"
    );
    let mut names: Vec<_> = page
        .project_documents
        .iter()
        .map(|document| document.name.as_str())
        .collect();
    names.sort();
    assert_eq!(
        names,
        ["note.txt"],
        "legacy metadata must be hidden from Project Files"
    );
}

#[test]
fn ds_store_project_page_hides_legacy_root_record_and_retains_file_and_version() {
    ds_store_legacy_record_hidden_without_deletion(".DS_Store");
}

#[test]
fn ds_store_project_page_hides_legacy_nested_record_and_retains_file_and_version() {
    ds_store_legacy_record_hidden_without_deletion("sub/.DS_Store");
}

#[test]
fn hidden_register_and_import_reject_dot_files_and_hidden_directory_descendants() {
    for relative in [
        ".env",
        "sub/.env",
        ".git/config",
        ".git/nested/ordinary.txt",
        "sub/.cache/ordinary.txt",
    ] {
        hidden_register_and_import_rejected(relative, None);
    }
}

#[test]
fn hidden_project_page_hides_legacy_env_and_preserves_record_and_version() {
    for relative in [".env", "sub/.env"] {
        hidden_legacy_record_hidden_without_deletion(relative, None);
    }
}

#[test]
fn hidden_project_page_hides_legacy_hidden_directory_descendant_and_preserves_record_and_version() {
    hidden_legacy_record_hidden_without_deletion(".git/nested/ordinary.txt", None);
}

#[cfg(any(target_os = "macos", windows))]
fn hidden_set_native_attribute(path: &Path) {
    #[cfg(target_os = "macos")]
    let output = hidden_test_command("chflags")
        .arg("hidden")
        .arg(path)
        .output()
        .unwrap();
    #[cfg(windows)]
    let output = hidden_test_command("attrib")
        .arg("+h")
        .arg(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "could not mark {} hidden: {:?}",
        path.display(),
        output
    );
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn hidden_native_automatic_scan_excludes_files_and_directory_descendants() {
    hidden_scan_excludes_files_and_directories(true, true);
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn hidden_native_explicit_scan_excludes_files_and_directory_descendants() {
    hidden_scan_excludes_files_and_directories(false, true);
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn hidden_native_register_and_import_reject_file_and_directory_descendant() {
    hidden_register_and_import_rejected("native-file.txt", Some("native-file.txt"));
    hidden_register_and_import_rejected("native-folder/nested/ordinary.txt", Some("native-folder"));
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn hidden_native_project_page_hides_legacy_file_and_retains_record_and_version() {
    hidden_legacy_record_hidden_without_deletion("native-file.txt", Some("native-file.txt"));
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn hidden_native_project_page_hides_legacy_directory_descendant_and_retains_record_and_version() {
    hidden_legacy_record_hidden_without_deletion(
        "native-folder/nested/ordinary.txt",
        Some("native-folder"),
    );
}

#[test]
fn directory_file_atomic_replacement_cannot_claim_another_files_physical_identity() {
    for cross_project in [false, true] {
        for owner_missing in [false, true] {
            for same_bytes in [false, true] {
                let (_root, mut db, project, path) = fixture();
                let (owner_project, owner_root) = if cross_project {
                    let other = db
                        .project_create(ProjectCreateInput {
                            name: "Other".into(),
                            summary: None,
                            status: None,
                        })
                        .unwrap();
                    (other.id, PathBuf::from(other.root_path))
                } else {
                    (project, path.clone())
                };
                let live = path.join("target.bin");
                let owner_path = owner_root.join("owner.bin");
                fs::write(&live, b"target").unwrap();
                fs::write(
                    &owner_path,
                    if same_bytes {
                        b"target".as_slice()
                    } else {
                        b"owner".as_slice()
                    },
                )
                .unwrap();
                let target = db
                    .project_file_register("wp1-workspace", project, "target.bin")
                    .unwrap();
                let owner = db
                    .project_file_register("wp1-workspace", owner_project, "owner.bin")
                    .unwrap();
                let versions = db
                    .document_list_versions(crate::models::DocumentListVersionsInput {
                        document_id: target.object.id.parse().unwrap(),
                    })
                    .unwrap();
                if owner_missing {
                    fs::rename(&owner_path, &live).unwrap();
                    assert_eq!(
                        db.project_file_resolve(&owner.object).unwrap().state,
                        "missing"
                    );
                } else {
                    let staged = path.join("replacement.bin");
                    fs::hard_link(&owner_path, &staged).unwrap();
                    fs::rename(&staged, &live).unwrap();
                }
                let error = db.project_file_resolve(&target.object).unwrap_err();
                assert_eq!(FileServiceError::from_error(error).code, "ownership_mismatch",
                    "cross_project={cross_project}, owner_missing={owner_missing}, same_bytes={same_bytes}");
                let after = db
                    .document_list_versions(crate::models::DocumentListVersionsInput {
                        document_id: target.object.id.parse().unwrap(),
                    })
                    .unwrap();
                assert_eq!(after.len(), versions.len());
                assert_eq!(after[0].managed_path, versions[0].managed_path);
                assert_eq!(bytes(&db, &target), b"target");
                assert!(db
                    .project_file_open_local_with(&target.object, |_| panic!(
                        "foreign File must not open"
                    ))
                    .is_err());
            }
        }
    }
}

fn temporary_scan_excludes_editor_files(only_new: bool) {
    let (_root, db, project, path) = fixture();
    fs::create_dir(path.join("sub")).unwrap();
    let excluded = [
        "~$报告.docx",
        "~$表.XLSX",
        "~$slides.pptx",
        "~$无扩展名",
        "scratch.tmp",
        "scratch.TEMP",
        "drawing.~vsdx",
        "#draft#",
        "draft.txt~",
        "_draft.swp",
        "_draft.swo",
        "_draft.swn",
        "Thumbs.db",
        "EHTHUMBS.DB",
        "EhThumbs_Vista.Db",
        "DESKTOP.INI",
        ".env",
        "sub/~$nested.docx",
    ];
    let mut retained = vec![
        "report.docx",
        "sheet.xlsx",
        "slides.pptx",
        "recovery.asd",
        "backup.wbk",
        "backup.xlk",
        "backup.bak",
        "Cargo.lock",
        "package-lock.json",
        "diagram.svg",
        "_diagram.svg",
        "draft.swp",
        "draft.swo",
        "draft.swn",
        "data.tmp/report.docx",
        "~$资料/report.docx",
    ];
    for relative in &retained {
        fs::create_dir_all(path.join(relative).parent().unwrap()).unwrap();
        fs::write(path.join(relative), b"business material").unwrap();
    }
    for relative in excluded {
        fs::write(path.join(relative), b"editor cache").unwrap();
    }
    let mut found = Vec::new();
    let mut cursor = None;
    let mut complete = false;
    for _ in 0..100 {
        let page = if only_new {
            db.project_file_scan_new("wp1-workspace", project, cursor.as_deref(), 3)
        } else {
            db.project_file_scan("wp1-workspace", project, cursor.as_deref(), 3, false)
        }
        .unwrap();
        assert!(page.failures.is_empty(), "{:?}", page.failures);
        found.extend(page.files.into_iter().map(|file| file.relative_path));
        cursor = page.next_cursor;
        if page.complete {
            complete = true;
            break;
        }
        assert!(cursor.is_some());
    }
    assert!(
        complete,
        "temporary exclusions must not stall scan pagination"
    );
    found.sort();
    retained.sort();
    assert_eq!(found, retained);
    let count: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM documents WHERE project_id=?1",
            [project],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count as usize, retained.len());
    for relative in excluded {
        assert_eq!(fs::read(path.join(relative)).unwrap(), b"editor cache");
    }
}

#[test]
fn temporary_automatic_scan_excludes_editor_files_and_keeps_business_files() {
    temporary_scan_excludes_editor_files(true);
}

#[test]
fn temporary_explicit_scan_excludes_editor_files_and_keeps_business_files() {
    temporary_scan_excludes_editor_files(false);
}

#[test]
fn temporary_register_and_import_reject_files_but_accept_directory_descendants() {
    for relative in [
        "~$无扩展名",
        "sub/~$报告.docx",
        "scratch.TEMP",
        "_draft.swp",
    ] {
        hidden_register_and_import_rejected(relative, None);
    }
    let (_root, mut db, project, path) = fixture();
    for (index, directory) in ["data.tmp", "~$资料"].into_iter().enumerate() {
        fs::create_dir(path.join(directory)).unwrap();
        let relative = format!("{directory}/registered.docx");
        fs::write(path.join(&relative), b"business material").unwrap();
        let file = db
            .project_file_register("wp1-workspace", project, &relative)
            .unwrap();
        assert_eq!(file.relative_path, relative);
        assert_eq!(bytes(&db, &file), b"business material");
        let source = path.join(directory).join(format!("imported-{index}.docx"));
        fs::write(&source, b"imported material").unwrap();
        let object = import_for_location(&mut db, project, &source);
        assert_eq!(object.kind, ObjectKind::File);
    }
    let page = db
        .project_page_get(crate::models::ProjectIdInput {
            project_id: project,
        })
        .unwrap();
    assert_eq!(page.project_documents.len(), 4);
}

#[test]
fn temporary_legacy_missing_record_is_hidden_without_deleting_record_or_versions() {
    let (_root, mut db, project, path) = fixture();
    fs::write(path.join("doc.docx"), b"retained snapshot").unwrap();
    let file = db
        .project_file_register("wp1-workspace", project, "doc.docx")
        .unwrap();
    let id: i64 = file.object.id.parse().unwrap();
    // Simulate an older registration without registering a now excluded name.
    let encoded = db.encode_path_ref(&path.join("~$doc.docx"));
    db.conn.execute(
        "UPDATE documents SET name=?1,base_name=?1,managed_path=?2,original_path=?2 WHERE id=?3",
        params!["~$doc.docx", encoded, id],
    ).unwrap();
    fs::rename(path.join("doc.docx"), path.join("~$doc.docx")).unwrap();
    fs::write(path.join("normal.docx"), b"normal snapshot").unwrap();
    let normal = db
        .project_file_register("wp1-workspace", project, "normal.docx")
        .unwrap();
    fs::remove_file(path.join("normal.docx")).unwrap();
    // Actual File access confirms missing health; reading the Project page
    // itself must remain a metadata-only operation.
    assert_eq!(db.project_file_resolve(&normal.object).unwrap().state, "missing");
    let record_state = |db: &Database| {
        db.conn.query_row(
            "SELECT name,base_name,managed_path,original_path,current_version_number,version_count FROM documents WHERE id=?1",
            [id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?, row.get::<_, i64>(5)?)),
        ).unwrap()
    };
    let before = record_state(&db);
    let versions_before = db
        .document_list_versions(crate::models::DocumentListVersionsInput { document_id: id })
        .unwrap();
    assert_eq!(versions_before.len(), 1);
    for missing in [false, true] {
        if missing {
            fs::remove_file(path.join("~$doc.docx")).unwrap();
        }
        let page = db
            .project_page_get(crate::models::ProjectIdInput {
                project_id: project,
            })
            .unwrap();
        assert_eq!(
            page.project_documents.len(),
            1,
            "temporary file missing={missing}"
        );
        assert_eq!(page.project_documents[0].id.to_string(), normal.object.id);
        assert_eq!(page.project_documents[0].health, "missing");
        assert_eq!(record_state(&db), before);
        let versions = db
            .document_list_versions(crate::models::DocumentListVersionsInput { document_id: id })
            .unwrap();
        assert_eq!(
            serde_json::to_value(&versions).unwrap(),
            serde_json::to_value(&versions_before).unwrap()
        );
        assert_eq!(
            fs::read(&versions[0].managed_path).unwrap(),
            b"retained snapshot"
        );
    }
}

fn directory_gui_intent(db: &Database, file: &DirectoryFile) -> file_versions::GuiFileVersionIntent {
    let document = db.document_record(file.object.id.parse().unwrap()).unwrap();
    db.file_version_prepare_gui(&file_versions::GuiFileVersionPrepare {
        document_id: document.id,
        project_id: document.project_id,
        managed_path: document.managed_path,
        expected_version_number: file.version_number,
        source_path: None,
    }).unwrap()
}

#[test]
fn directory_file_gui_registration_snapshots_external_bytes_and_replays_without_live_writes() {
    use crate::agent::{errors::ErrorCode, models::WorkspaceBinding};
    let (_root, mut db, project, path) = fixture();
    let live = path.join("external.md");
    fs::write(&live, b"first retained bytes").unwrap();
    let first = db.project_file_register("wp1-workspace", project, "external.md").unwrap();
    let id = first.object.id.parse().unwrap();
    let original_versions = db.document_list_versions(crate::models::DocumentListVersionsInput { document_id: id }).unwrap();
    fs::write(&live, b"external V2 and later marker").unwrap();
    let external_identity = file_versions::path_identity(&live).unwrap();
    let intent = directory_gui_intent(&db, &first);
    let binding = WorkspaceBinding { workspace_id: "wp1-workspace".into(), generation: "opened".into() };
    assert_eq!(db.file_version_commit_gui(&binding, "needs-confirm", &intent, false).unwrap_err().code,
        ErrorCode::FileChangedUnregistered);
    let committed = db.file_version_commit_gui(&binding, "register-external", &intent, true).unwrap();
    assert_eq!(committed.version_number, 2);
    assert_eq!(committed.content_hash, intent.expected_content_hash);
    assert_eq!(db.document_record(id).unwrap().managed_path, intent.managed_path);
    assert_eq!(fs::read(&live).unwrap(), b"external V2 and later marker");
    assert_eq!(file_versions::path_identity(&live).unwrap(), external_identity);
    assert_eq!(bytes(&db, &first), b"first retained bytes");
    let after = db.document_list_versions(crate::models::DocumentListVersionsInput { document_id: id }).unwrap();
    assert_eq!(after.len(), 2);
    assert_eq!(after.iter().find(|v| v.id == original_versions[0].id).unwrap().managed_path, original_versions[0].managed_path);
    let second = DirectoryFile { version_number: 2, content_hash: Some(committed.content_hash.clone()), ..first };
    assert_eq!(bytes(&db, &second), b"external V2 and later marker");
    let same = directory_gui_intent(&db, &second);
    let unchanged = db.file_version_commit_gui(&binding, "same-content", &same, false).unwrap();
    assert!(unchanged.no_change);
    assert_eq!(unchanged.version_number, 2);
    assert_eq!(db.document_list_versions(crate::models::DocumentListVersionsInput { document_id: id }).unwrap().len(), 2);
    assert_eq!(file_versions::path_identity(&live).unwrap(), external_identity);
    assert_eq!(db.file_version_commit_gui(&binding, "register-external", &intent, false).unwrap_err().code,
        ErrorCode::IdempotencyConflict);
    fs::write(&live, b"newer external V3 must stay untouched").unwrap();
    assert_eq!(db.file_version_commit_gui(&binding, "register-external", &intent, true).unwrap(), committed);
    assert_eq!(db.document_record(id).unwrap().current_version_number, 2);
    assert_eq!(fs::read(&live).unwrap(), b"newer external V3 must stay untouched");
    assert_eq!(bytes(&db, &second), b"external V2 and later marker");
}

#[test]
fn directory_file_gui_registration_rejects_changed_bytes_and_stale_preflight() {
    use crate::agent::{errors::ErrorCode, models::WorkspaceBinding};
    let (_root, mut db, project, path) = fixture();
    let live = path.join("external.md");
    fs::write(&live, b"retained V1").unwrap();
    let first = db.project_file_register("wp1-workspace", project, "external.md").unwrap();
    fs::write(&live, b"external V2").unwrap();
    let intent = directory_gui_intent(&db, &first);
    let binding = WorkspaceBinding { workspace_id: "wp1-workspace".into(), generation: "opened".into() };
    fs::write(&live, b"external V3 after confirmation").unwrap();
    assert_eq!(db.file_version_commit_gui(&binding, "changed-after-preflight", &intent, true).unwrap_err().code,
        ErrorCode::FileChangedUnregistered);
    assert_eq!(db.document_record(intent.document_id).unwrap().current_version_number, 1);
    assert_eq!(bytes(&db, &first), b"retained V1");
    let stale = directory_gui_intent(&db, &first);
    let registered = db.project_file_resolve(&first.object).unwrap();
    assert_eq!(registered.version_number, 2);
    assert_eq!(db.file_version_commit_gui(&binding, "stale-registration", &stale, true).unwrap_err().code,
        ErrorCode::RevisionConflict);
    assert_eq!(fs::read(&live).unwrap(), b"external V3 after confirmation");
    assert_eq!(bytes(&db, &first), b"retained V1");
}

#[test]
fn directory_file_gui_registration_sql_failure_preserves_live_and_history_then_retries() {
    use crate::agent::models::WorkspaceBinding;
    let (_root, mut db, project, path) = fixture();
    let live = path.join("external.md");
    fs::write(&live, b"retained V1").unwrap();
    let first = db.project_file_register("wp1-workspace", project, "external.md").unwrap();
    fs::write(&live, b"external bytes never replaced").unwrap();
    let intent = directory_gui_intent(&db, &first);
    let binding = WorkspaceBinding { workspace_id: "wp1-workspace".into(), generation: "opened".into() };
    db.conn.execute_batch("CREATE TRIGGER fail_gui_registration BEFORE INSERT ON document_versions WHEN NEW.version_number=2 BEGIN SELECT RAISE(ABORT,'injected registration failure'); END;").unwrap();
    assert!(db.file_version_commit_gui(&binding, "retry-registration", &intent, true).is_err());
    assert_eq!(db.document_record(intent.document_id).unwrap().current_version_number, 1);
    assert_eq!(fs::read(&live).unwrap(), b"external bytes never replaced");
    assert_eq!(bytes(&db, &first), b"retained V1");
    db.conn.execute_batch("DROP TRIGGER fail_gui_registration").unwrap();
    let committed = db.file_version_commit_gui(&binding, "retry-registration", &intent, true).unwrap();
    assert_eq!(committed.version_number, 2);
    assert_eq!(fs::read(&live).unwrap(), b"external bytes never replaced");
    assert_eq!(bytes(&db, &first), b"retained V1");
}


#[test]
fn directory_file_version_zero_replacement_requires_confirmation_before_initial_snapshot() {
    for publish_directly in [false, true] {
        let (_root, db, project, path) = fixture();
        let live = path.join("pending.bin");
        fs::File::create(&live).unwrap()
            .set_len(crate::file_text_patch::MAX_FILE_BYTES as u64 + 1).unwrap();
        let pending = db.project_file_register("wp1-workspace", project, "pending.bin").unwrap();
        assert_eq!(pending.version_number, 0);
        fs::write(path.join("new.bin"), b"replacement bytes").unwrap();
        fs::rename(path.join("new.bin"), &live).unwrap();
        let current = if publish_directly {
            db.directory_publish("wp1-workspace", Some(project), &live, &pending.object, false, None).unwrap()
        } else {
            db.project_file_resolve(&pending.object).unwrap()
        };
        assert_eq!(current.state, "ambiguous");
        assert_eq!(current.version_number, 0);
        assert_eq!(current.content_hash, None);
        let versions: i64 = db.conn.query_row("SELECT COUNT(*) FROM document_versions WHERE document_id=?1", [&pending.object.id], |r| r.get(0)).unwrap();
        assert_eq!(versions, 0);
        let confirmed = db.project_file_reconcile(&pending.object, "pending.bin", 0, None, "replacement").unwrap();
        assert_eq!(confirmed.state, "ready");
        assert_eq!(confirmed.version_number, 1);
        assert_eq!(confirmed.object, pending.object);
        assert_eq!(bytes(&db, &confirmed), b"replacement bytes");
    }
}

#[test]
fn directory_file_version_zero_same_physical_file_can_recover_under_budget() {
    let (_root, db, project, path) = fixture();
    let live = path.join("pending.bin");
    fs::File::create(&live).unwrap()
        .set_len(crate::file_text_patch::MAX_FILE_BYTES as u64 + 1).unwrap();
    let pending = db.project_file_register("wp1-workspace", project, "pending.bin").unwrap();
    let physical = file_versions::path_identity(&live).unwrap();
    fs::write(&live, b"same physical file now fits").unwrap();
    assert_eq!(file_versions::path_identity(&live).unwrap(), physical);
    let ready = db.project_file_resolve(&pending.object).unwrap();
    assert_eq!(ready.state, "ready");
    assert_eq!(ready.version_number, 1);
    assert_eq!(ready.object, pending.object);
}


#[test]
fn directory_scan_wide_directory_has_a_real_enumeration_budget_and_reads_once() {
    let (_root, db, project, path) = fixture();
    for i in 0..600 { fs::write(path.join(format!(".excluded-{i:04}")), b"hidden").unwrap(); }
    let mut cursor = None;
    let mut total = 0;
    let mut excluded = std::collections::HashSet::new();
    for _ in 0..16 {
        let scan = db.project_file_scan_new("wp1-workspace", project, cursor.as_deref(), 5).unwrap();
        assert!(scan.entries_read <= 128, "actual read_dir work must yield");
        total += scan.entries_read;
        for entry in scan.excluded { assert!(excluded.insert(entry.relative_path), "entry enumerated twice"); }
        assert!(scan.failures.is_empty());
        cursor = scan.next_cursor;
        if cursor.is_none() { break; }
        let cancelled = db.project_file_scan("wp1-workspace", project, cursor.as_deref(), 5, true).unwrap();
        assert_eq!(cancelled.entries_read, 0);
        assert_eq!(cancelled.next_cursor, cursor);
    }
    assert!(cursor.is_none(), "wide scan must finish");
    assert_eq!(total, 600, "one native enumeration across all pages");
    assert_eq!(excluded.len(), 600);
}

#[test]
fn directory_scan_event_path_does_not_enumerate_unrelated_wide_directories() {
    let (_root, db, project, path) = fixture();
    fs::create_dir(path.join("unrelated")).unwrap();
    for i in 0..300 { fs::write(path.join(format!("unrelated/item-{i:03}")), b"unrelated").unwrap(); }
    fs::write(path.join("new.txt"), b"event bytes").unwrap();
    let first = db.project_file_scan_new_at("wp1-workspace", Some(project), "new.txt", None, 5).unwrap();
    assert_eq!(first.entries_read, 0);
    assert_eq!(first.files.len(), 1);
    assert_eq!(first.files[0].relative_path, "new.txt");
    let repeat = db.project_file_scan_new_at("wp1-workspace", Some(project), "new.txt", None, 5).unwrap();
    assert_eq!(repeat.entries_read, 0);
    assert!(repeat.files.is_empty());
    let count: i64 = db.conn.query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 1);
}

#[test]
fn directory_scan_retained_cursor_rejects_other_modes_scope_and_replays() {
    let (_root, mut db, project, path) = fixture();
    for i in 0..150 { fs::write(path.join(format!(".excluded-{i:03}")), b"hidden").unwrap(); }
    let first = db.project_file_scan_new("wp1-workspace", project, None, 1).unwrap();
    let cursor = first.next_cursor.unwrap();
    let other = db.project_create(ProjectCreateInput { name: "Other scan scope".into(), summary: None, status: None }).unwrap();
    assert_eq!(FileServiceError::from_error(db.project_file_scan_new("wp1-workspace", other.id, Some(&cursor), 1).unwrap_err()).code, "ownership_mismatch");
    assert_eq!(FileServiceError::from_error(db.project_file_scan("wp1-workspace", project, Some(&cursor), 1, false).unwrap_err()).code, "ownership_mismatch");
    let next = db.project_file_scan_new("wp1-workspace", project, Some(&cursor), 1).unwrap();
    assert!(next.complete);
    assert!(db.project_file_scan_new("wp1-workspace", project, Some(&cursor), 1).is_err());
}

#[test]
fn directory_file_claims_detect_unregistered_external_hard_link_identities() {
    let (_root, mut db, project, path) = fixture();
    let other = db.project_create(ProjectCreateInput { name: "External owner".into(), summary: None, status: None }).unwrap();
    let owner_path = PathBuf::from(&other.root_path).join("owner.txt");
    fs::write(&owner_path, b"original owner").unwrap();
    let owner = db.project_file_register("wp1-workspace", other.id, "owner.txt").unwrap();
    let staging = PathBuf::from(&other.root_path).join("new.txt");
    fs::write(&staging, b"unregistered external identity").unwrap();
    fs::rename(&staging, &owner_path).unwrap();
    fs::hard_link(&owner_path, path.join("alias.txt")).unwrap();
    let error = db.project_file_register("wp1-workspace", project, "alias.txt").unwrap_err();
    assert_eq!(FileServiceError::from_error(error).code, "ownership_mismatch");
    assert_eq!(bytes(&db, &owner), b"original owner");
}


#[test]
fn directory_file_claims_preserve_case_aliases_after_external_replacement() {
    let (_root, db, project, path) = fixture();
    for (original, alias) in [("mixed.txt", "MIXED.TXT"), ("Äown.txt", "äOWN.TXT")] {
        fs::write(path.join(original), b"original").unwrap();
        let first = db.project_file_register("wp1-workspace", project, original).unwrap();
        if !path.join(alias).exists() { continue; } // This volume is case sensitive.
        fs::write(path.join("external-replace.bin"), b"external").unwrap();
        fs::rename(path.join("external-replace.bin"), path.join(original)).unwrap();
        let second = db.project_file_register("wp1-workspace", project, alias).unwrap();
        assert_eq!(second.object, first.object);
        assert_eq!(second.version_number, 2);
        assert_eq!(bytes(&db, &first), b"original");
    }
}


#[test]
fn directory_file_bulk_registration_does_not_read_every_registered_identity() {
    let (_root, db, project, path) = fixture();
    CLAIMANT_IDENTITY_READS.with(|reads| reads.set(0));
    for i in 0..200 {
        let name = format!("ordinary-{i:04}.txt");
        fs::write(path.join(&name), b"bounded identity lookup").unwrap();
        let file = db.project_file_register("wp1-workspace", project, &name).unwrap();
        assert_eq!(file.state, "ready");
    }
    CLAIMANT_IDENTITY_READS.with(|reads| assert_eq!(reads.get(), 0,
        "200 ordinary registrations must not reopen existing Files to prove non-aliasing"));
    for (sql, expected_index) in [
        ("SELECT document_id FROM project_directory_files WHERE physical_identity=?1", "idx_directory_file_identity"),
        ("SELECT id FROM documents WHERE storage_mode!='managed_note_image' AND managed_path COLLATE NOCASE IN (?1)", "idx_business_file_managed_path"),
    ] {
        let mut statement = db.conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let plans: Vec<String> = statement.query_map(["absent"], |r| r.get(3)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        assert!(plans.iter().any(|plan| plan.contains(expected_index)), "{plans:?}");
    }
}

#[cfg(unix)]
fn scan_directory_fd_count(directory: &std::path::Path) -> usize {
    let directory = directory.canonicalize().unwrap();
    fs::read_dir("/dev/fd").unwrap().filter_map(|entry| {
        let entry = entry.ok()?;
        #[cfg(target_os = "macos")]
        {
            unsafe extern "C" { fn fcntl(fd: i32, command: i32, ...) -> i32; }
            let fd: i32 = entry.file_name().to_str()?.parse().ok()?;
            let mut bytes = [0i8; 1024];
            if unsafe { fcntl(fd, 50, bytes.as_mut_ptr()) } != 0 { return None; } // F_GETPATH
            let value = unsafe { std::ffi::CStr::from_ptr(bytes.as_ptr()) }.to_str().ok()?;
            Some(std::path::PathBuf::from(value))
        }
        #[cfg(not(target_os = "macos"))]
        { fs::read_link(entry.path()).ok() }
    }).filter(|path| path == &directory).count()
}

#[cfg(unix)]
#[test]
fn directory_scan_exhausted_buffers_release_real_directory_fds() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(directory.path().join("one"), b"one").unwrap();
    let baseline = scan_directory_fd_count(directory.path());
    let mut frames = vec![];
    for _ in 0..40 {
        let mut frame = ScanFrame::new(String::new());
        frame.open(directory.path(), 0).unwrap();
        assert!(frame.fill_batch(&mut 0).is_empty());
        assert!(frame.exhausted);
        assert_eq!(frame.buffered.len(), 1);
        frames.push(frame);
    }
    assert_eq!(scan_directory_fd_count(directory.path()), baseline, "owned names must not retain exhausted ReadDir FDs");
    drop(frames);
}

#[test]
fn directory_scan_open_fd_budget_fails_explicitly_and_releases_frames() {
    let directory = tempfile::tempdir().unwrap();
    let mut frames = vec![];
    for index in 0..MAX_SCAN_OPEN_DIRECTORIES {
        let mut frame = ScanFrame::new(String::new());
        frame.open(directory.path(), index).unwrap();
        frames.push(frame);
    }
    #[cfg(unix)]
    assert_eq!(scan_directory_fd_count(directory.path()), MAX_SCAN_OPEN_DIRECTORIES);
    let mut extra = ScanFrame::new(String::new());
    let error = extra.open(directory.path(), frames.len()).unwrap_err();
    assert_eq!(FileServiceError::from_error(error).code, "scan_fd_budget");
    assert!(extra.entries.is_none());
    drop(frames);
    extra.open(directory.path(), 0).unwrap();
}

#[test]
fn directory_scan_deep_tree_preserves_all_paths_with_bounded_open_fds() {
    let (_root, db, project, root) = fixture();
    let mut path = root.clone();
    for _ in 0..80 {
        fs::write(path.join(".excluded"), b"hidden sibling").unwrap();
        path = path.join("a"); fs::create_dir(&path).unwrap();
    }
    fs::write(path.join("leaf.txt"), b"deep leaf").unwrap();
    let mut cursor = None;
    let mut visited = std::collections::HashSet::new();
    let mut files = vec![];
    let mut reads = 0;
    for _ in 0..32 {
        let scan = db.project_file_scan_new("wp1-workspace", project, cursor.as_deref(), 5).unwrap();
        assert!(scan.failures.is_empty(), "{:?}", scan.failures);
        assert!(scan.entries_read <= 128);
        reads += scan.entries_read;
        for directory in scan.opened_directories { assert!(visited.insert(directory), "directory reopened"); }
        files.extend(scan.files);
        cursor = scan.next_cursor;
        if cursor.is_none() { assert!(scan.complete); break; }
    }
    assert!(cursor.is_none(), "deep scan must terminate within the fixed page bound");
    assert_eq!(visited.len(), 81);
    assert_eq!(reads, 161);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].relative_path, format!("{}leaf.txt", "a/".repeat(80)));
}

#[test]
fn directory_scan_fd_budget_aborts_cursor_without_retaining_partial_frames() {
    let (_root, db, project, root) = fixture();
    fs::create_dir(root.join("nested")).unwrap();
    let scan_id = file_versions::token();
    let position = ScanCursor { workspace_id:"wp1-workspace".into(), project_id:Some(project), scan_id:scan_id.clone(), sequence:0 };
    let cursor = STANDARD.encode(serde_json::to_vec(&position).unwrap());
    let mut stack = vec![];
    for index in 0..MAX_SCAN_OPEN_DIRECTORIES {
        let mut frame = ScanFrame::new(String::new());
        frame.open(&root, index).unwrap();
        stack.push(frame);
    }
    // Model a resumed DFS with 32 still-enumerating ancestors and the next
    // child already in its bounded batch. All handles are real ReadDir FDs.
    stack.last_mut().unwrap().buffered.push_back(ScanEntry {
        name:"nested".into(), kind:fs::metadata(root.join("nested")).unwrap().file_type(),
    });
    SCAN_SESSIONS.lock().unwrap().insert(scan_id.clone(), std::sync::Arc::new(std::sync::Mutex::new(ScanSession {
        root:root.clone(), workspace_id:"wp1-workspace".into(), project_id:Some(project), only_new:true,
        start_relative:String::new(), sequence:0, stack, touched:std::time::Instant::now(),
    })));
    let error = db.project_file_scan_new("wp1-workspace", project, Some(&cursor), 5).unwrap_err();
    let error = FileServiceError::from_error(error);
    assert_eq!(error.code, "scan_fd_budget");
    assert!(error.message.contains("nested"));
    assert!(!SCAN_SESSIONS.lock().unwrap().contains_key(&scan_id), "a failed cursor must release all retained frames");
    #[cfg(unix)]
    assert_eq!(scan_directory_fd_count(&root), 0);
}
