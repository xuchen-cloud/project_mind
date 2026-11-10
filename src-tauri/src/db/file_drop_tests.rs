use super::*;
use crate::agent::access::{Caller, ScopeGrant};
struct Fixture {
    _root: tempfile::TempDir,
    external: tempfile::TempDir,
    db: Database,
    binding: WorkspaceBinding,
    request: RequestContext,
}
fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let (meta, paths) = crate::workspace::create_workspace(root.path(), "password").unwrap();
    let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
    db.bind_file_commit_fence(std::sync::Arc::new(
        crate::workspace_commit_fence::WorkspaceCommitFence::new(),
    ));
    let binding = WorkspaceBinding {
        workspace_id: meta.workspace_id,
        generation: "fixture".into(),
    };
    let request = RequestContext {
        binding: binding.clone(),
        request_id: "drop".into(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: true,
            project_ids: vec![],
            operations: vec![
                "content.create".into(),
                "file.update".into(),
                "source.read".into(),
            ],
            object_keys: None,
        },
    };
    Fixture {
        _root: root,
        external,
        db,
        binding,
        request,
    }
}
struct Trash {
    destination: PathBuf,
    fail: bool,
    calls: std::cell::Cell<usize>,
}
impl SourceTrash for Trash {
    fn trash(&self, p: &Path) -> anyhow::Result<()> {
        self.calls.set(self.calls.get() + 1);
        if self.fail {
            anyhow::bail!("isolated fixture permission denied");
        }
        fs::rename(p, &self.destination)?;
        Ok(())
    }
}
fn trash(f: &Fixture, fail: bool) -> Trash {
    Trash {
        destination: f.external.path().join("trashed"),
        fail,
        calls: std::cell::Cell::new(0),
    }
}
fn source(f: &Fixture, name: &str, bytes: &[u8]) -> PathBuf {
    let p = f.external.path().join(name);
    fs::write(&p, bytes).unwrap();
    p
}
fn new_target(name: &str) -> DropTarget {
    DropTarget::New {
        owner: None,
        name: name.into(),
    }
}
fn update(file: &crate::models::DocumentRecord) -> DropTarget {
    DropTarget::Update {
        document_id: file.id,
        project_id: file.project_id,
        managed_path: file.managed_path.clone(),
        expected_version_number: file.current_version_number as u32,
    }
}
fn import(f: &mut Fixture) -> crate::models::DocumentRecord {
    let p = source(f, "original.md", b"original");
    f.db.document_import(crate::models::DocumentImportInput {
        project_id: None,
        source_path: p.to_string_lossy().into(),
        is_starred: false,
        tag_ids: None,
    })
    .unwrap()
}
#[test]
fn source_replacement_keeps_snapshot_target_and_replacement() {
    let mut f = fixture();
    let p = source(&f, "source.md", b"captured");
    let intent =
        f.db.file_drop_prepare(&f.request, &f.binding, &p, new_target("new.md"))
            .unwrap();
    fs::remove_file(&p).unwrap();
    fs::write(&p, b"replacement").unwrap();
    let adapter = trash(&f, false);
    let result =
        f.db.file_drop_commit(&f.request, &f.binding, &intent.intent_id, &adapter)
            .unwrap();
    assert!(result.cleanup_warning.is_some());
    assert_eq!(fs::read(&p).unwrap(), b"replacement");
    assert_eq!(
        fs::read(
            f.db.document_record(result.document_id)
                .unwrap()
                .managed_path
        )
        .unwrap(),
        b"captured"
    );
    assert_eq!(adapter.calls.get(), 0);
}
#[test]
fn cleanup_permission_failure_preserves_target_source_and_replay() {
    let mut f = fixture();
    let p = source(&f, "source.md", b"captured");
    let intent =
        f.db.file_drop_prepare(&f.request, &f.binding, &p, new_target("new.md"))
            .unwrap();
    let adapter = trash(&f, true);
    let result =
        f.db.file_drop_commit(&f.request, &f.binding, &intent.intent_id, &adapter)
            .unwrap();
    assert!(result
        .cleanup_warning
        .as_ref()
        .unwrap()
        .contains("permission denied"));
    assert_eq!(fs::read(&p).unwrap(), b"captured");
    let replay =
        f.db.file_drop_commit(&f.request, &f.binding, &intent.intent_id, &adapter)
            .unwrap();
    assert_eq!(result.document_id, replay.document_id);
    assert_eq!(adapter.calls.get(), 1);
    assert!(Path::new(
        &f.db
            .document_record(result.document_id)
            .unwrap()
            .managed_path
    )
    .is_file());
}
#[test]
fn no_change_recycles_independent_external_copy_and_never_reimports() {
    let mut f = fixture();
    let file = import(&mut f);
    let p = source(&f, "independent.MD", b"original");
    let intent =
        f.db.file_drop_prepare(&f.request, &f.binding, &p, update(&file))
            .unwrap();
    let adapter = trash(&f, false);
    let result =
        f.db.file_drop_commit(&f.request, &f.binding, &intent.intent_id, &adapter)
            .unwrap();
    assert!(result.no_change);
    assert_eq!(result.version_number, 1);
    assert!(!p.exists());
    let replay_prepare =
        f.db.file_drop_prepare(&f.request, &f.binding, &p, update(&file))
            .unwrap();
    assert_eq!(intent.intent_id, replay_prepare.intent_id);
    let replay =
        f.db.file_drop_commit(&f.request, &f.binding, &intent.intent_id, &adapter)
            .unwrap();
    assert_eq!(replay.document_id, file.id);
    assert_eq!(adapter.calls.get(), 1);
    assert_eq!(
        f.db.document_list_versions(crate::models::DocumentListVersionsInput {
            document_id: file.id
        })
        .unwrap()
        .len(),
        1
    );
}
#[test]
fn managed_and_same_physical_sources_are_never_trashed() {
    for hardlink in [false, true] {
        let mut f = fixture();
        let file = import(&mut f);
        let p = if hardlink {
            let p = f.external.path().join("alias.md");
            fs::hard_link(&file.managed_path, &p).unwrap();
            p
        } else {
            PathBuf::from(&file.managed_path)
        };
        let intent =
            f.db.file_drop_prepare(&f.request, &f.binding, &p, update(&file))
                .unwrap();
        let adapter = trash(&f, false);
        let result =
            f.db.file_drop_commit(&f.request, &f.binding, &intent.intent_id, &adapter)
                .unwrap();
        assert!(result.no_change);
        assert!(result.cleanup_warning.is_some());
        assert!(p.exists());
        assert_eq!(adapter.calls.get(), 0);
    }
}
#[test]
fn symlink_directory_and_format_are_rejected_without_cleanup() {
    let mut f = fixture();
    let file = import(&mut f);
    let adapter = trash(&f, false);
    assert!(f
        .db
        .file_drop_prepare(
            &f.request,
            &f.binding,
            f.external.path(),
            new_target("bad.md")
        )
        .is_err());
    #[cfg(unix)]
    {
        let p = f.external.path().join("link.md");
        std::os::unix::fs::symlink(&file.managed_path, &p).unwrap();
        assert!(f
            .db
            .file_drop_prepare(&f.request, &f.binding, &p, update(&file))
            .is_err());
        assert!(p.symlink_metadata().unwrap().file_type().is_symlink());
    }
    let p = source(&f, "binary.pdf", b"PDF");
    assert_eq!(
        f.db.file_drop_prepare(&f.request, &f.binding, &p, update(&file))
            .unwrap_err()
            .code,
        ErrorCode::InvalidArgument
    );
    assert_eq!(adapter.calls.get(), 0);
    assert!(p.exists());
}
#[test]
fn failed_destination_never_cleans_and_retry_reuses_one_native_receipt() {
    let mut f = fixture();
    let p = source(&f, "source.md", b"captured");
    let intent =
        f.db.file_drop_prepare(&f.request, &f.binding, &p, new_target("new.md"))
            .unwrap();
    let adapter = trash(&f, false);
    f.db.conn.execute_batch("CREATE TRIGGER reject_drop BEFORE INSERT ON document_versions BEGIN SELECT RAISE(ABORT,'fixture SQL failure'); END;").unwrap();
    assert!(f
        .db
        .file_drop_commit(&f.request, &f.binding, &intent.intent_id, &adapter)
        .is_err());
    assert_eq!(fs::read(&p).unwrap(), b"captured");
    assert_eq!(adapter.calls.get(), 0);
    f.db.conn.execute_batch("DROP TRIGGER reject_drop").unwrap();
    let result =
        f.db.file_drop_commit(&f.request, &f.binding, &intent.intent_id, &adapter)
            .unwrap();
    assert!(result.cleanup_warning.is_none());
    assert!(!p.exists());
    assert_eq!(adapter.calls.get(), 1);
}
#[test]
fn partial_success_and_expired_binding_stay_separate() {
    let mut f = fixture();
    let p = source(&f, "first.md", b"first");
    let a =
        f.db.file_drop_prepare(&f.request, &f.binding, &p, new_target("new.md"))
            .unwrap();
    let adapter = trash(&f, false);
    let result =
        f.db.file_drop_commit(&f.request, &f.binding, &a.intent_id, &adapter)
            .unwrap();
    let q = source(&f, "second.md", b"second");
    let mut next = f.request.clone();
    next.request_id = "second".into();
    let b =
        f.db.file_drop_prepare(&next, &f.binding, &q, new_target("new.md"))
            .unwrap();
    assert!(f
        .db
        .file_drop_commit(&next, &f.binding, &b.intent_id, &adapter)
        .is_err());
    assert!(q.exists());
    assert_eq!(
        fs::read(
            f.db.document_record(result.document_id)
                .unwrap()
                .managed_path
        )
        .unwrap(),
        b"first"
    );
    let mut expired = f.binding.clone();
    expired.generation = "reopened".into();
    assert_eq!(
        f.db.file_drop_owner(&expired, &f.request.request_id, &a.intent_id)
            .unwrap_err()
            .code,
        ErrorCode::WorkspaceChanged
    );
    assert_eq!(
        f.db.file_drop_owner(&f.binding, "other-request", &a.intent_id)
            .unwrap_err()
            .code,
        ErrorCode::IdempotencyConflict
    );
}

#[cfg(unix)]
#[test]
fn source_directory_permission_failure_keeps_committed_destination() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = fixture();
    let folder = f.external.path().join("locked");
    fs::create_dir(&folder).unwrap();
    let source = folder.join("source.md");
    fs::write(&source, b"permission source").unwrap();
    let intent =
        f.db.file_drop_prepare(&f.request, &f.binding, &source, new_target("permission.md"))
            .unwrap();
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o500)).unwrap();
    let adapter = trash(&f, false);
    let result =
        f.db.file_drop_commit(&f.request, &f.binding, &intent.intent_id, &adapter);
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o700)).unwrap();
    let result = result.unwrap();
    assert!(result.cleanup_warning.is_some());
    assert!(source.exists());
    assert_eq!(adapter.calls.get(), 0);
    assert_eq!(
        fs::read(
            f.db.document_record(result.document_id)
                .unwrap()
                .managed_path
        )
        .unwrap(),
        b"permission source"
    );
}
#[test]
fn history_and_workspace_resource_sources_are_retained() {
    for resource in [false, true] {
        let mut f = fixture();
        let file = import(&mut f);
        let source = if resource {
            let path = f.db.workspace_root.join(".project-mind/media/resource.md");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"resource").unwrap();
            path
        } else {
            let object = ObjectRef {
                workspace_id: f.binding.workspace_id.clone(),
                scope: super::super::file_scope::scope(None),
                kind: ObjectKind::File,
                id: file.id.to_string(),
            };
            f.db.file_working_begin_session(&f.request, &f.binding, &object)
                .unwrap();
            PathBuf::from(
                f.db.document_list_versions(crate::models::DocumentListVersionsInput {
                    document_id: file.id,
                })
                .unwrap()[0]
                    .managed_path
                    .clone(),
            )
        };
        let intent =
            f.db.file_drop_prepare(&f.request, &f.binding, &source, new_target("retained.md"))
                .unwrap();
        let adapter = trash(&f, false);
        let result =
            f.db.file_drop_commit(&f.request, &f.binding, &intent.intent_id, &adapter)
                .unwrap();
        assert!(result.cleanup_warning.is_some());
        assert!(source.exists());
        assert_eq!(adapter.calls.get(), 0);
    }
}

#[test]
fn identical_bytes_from_replaced_physical_source_are_retained() {
    let mut f = fixture();
    let p = source(&f, "source.md", b"captured");
    let intent =
        f.db.file_drop_prepare(&f.request, &f.binding, &p, new_target("new.md"))
            .unwrap();
    let replacement = source(&f, "replacement.md", b"captured");
    fs::rename(replacement, &p).unwrap();
    let adapter = trash(&f, false);
    let result =
        f.db.file_drop_commit(&f.request, &f.binding, &intent.intent_id, &adapter)
            .unwrap();
    assert!(result.cleanup_warning.is_some());
    assert!(p.exists());
    assert_eq!(adapter.calls.get(), 0);
}
#[test]
fn committed_import_receipt_recovers_after_result_write_failure() {
    let mut f = fixture();
    let p = source(&f, "source.md", b"captured");
    let intent =
        f.db.file_drop_prepare(&f.request, &f.binding, &p, new_target("new.md"))
            .unwrap();
    let adapter = trash(&f, false);
    f.db.conn.execute_batch("CREATE TRIGGER reject_drop_result BEFORE UPDATE OF result ON file_drop_intents BEGIN SELECT RAISE(ABORT,'result write failed'); END;").unwrap();
    assert!(f
        .db
        .file_drop_commit(&f.request, &f.binding, &intent.intent_id, &adapter)
        .is_err());
    assert!(p.exists());
    assert_eq!(adapter.calls.get(), 0);
    let before: i64 =
        f.db.conn
            .query_row("SELECT total_changes()", [], |r| r.get(0))
            .unwrap();
    let readonly =
        f.db.file_drop_committed(&f.request, &f.binding, &intent.intent_id)
            .unwrap()
            .unwrap();
    assert!(readonly.cleanup_warning.is_some());
    assert!(p.exists());
    assert_eq!(
        before,
        f.db.conn
            .query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0))
            .unwrap()
    );
    f.db.conn
        .execute_batch("DROP TRIGGER reject_drop_result")
        .unwrap();
    let result =
        f.db.file_drop_commit(&f.request, &f.binding, &intent.intent_id, &adapter)
            .unwrap();
    assert!(result.cleanup_warning.is_none());
    assert_eq!(adapter.calls.get(), 1);
    assert_eq!(
        f.db.conn
            .query_row("SELECT count(*) FROM documents", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn saved_pending_working_is_archived_once_before_drop_and_changed_commit_ends_sessions() {
    let mut f = fixture();
    let file = import(&mut f);
    let session = saved_pending(&mut f, &file);
    let source = source(&f, "next.md", b"dropped bytes");
    let target = update(&file);
    let intent =
        f.db.file_drop_prepare(&f.request, &f.binding, &source, target.clone())
            .unwrap();
    assert_eq!(
        f.db.document_record(file.id)
            .unwrap()
            .current_version_number,
        2,
        "explicit drop prepare must preserve saved working as a version"
    );
    let repeated =
        f.db.file_drop_prepare(&f.request, &f.binding, &source, target)
            .unwrap();
    assert_eq!(intent.intent_id, repeated.intent_id);
    assert_eq!(
        f.db.document_record(file.id)
            .unwrap()
            .current_version_number,
        2
    );
    let adapter = trash(&f, false);
    let result =
        f.db.file_drop_commit(&f.request, &f.binding, &intent.intent_id, &adapter)
            .unwrap();
    assert_eq!(result.version_number, 3);
    assert!(result.old_sessions_closed);
    assert_eq!(
        fs::read(f.db.document_record(file.id).unwrap().managed_path).unwrap(),
        b"dropped bytes"
    );
    assert!(f
        .db
        .file_working_session_base(&f.request, &f.binding, &session)
        .is_err());
    let versions =
        f.db.document_list_versions(crate::models::DocumentListVersionsInput {
            document_id: file.id,
        })
        .unwrap();
    assert_eq!(versions.len(), 3);
    for version in versions {
        let expected = match version.version_number {
            1 => b"original".as_slice(),
            2 => b"saved pending".as_slice(),
            _ => b"dropped bytes".as_slice(),
        };
        assert_eq!(fs::read(version.managed_path).unwrap(), expected);
    }
}

fn saved_pending(
    f: &mut Fixture,
    file: &crate::models::DocumentRecord,
) -> crate::file_working::WorkingSession {
    let object = ObjectRef {
        workspace_id: f.binding.workspace_id.clone(),
        scope: super::super::file_scope::scope(None),
        kind: ObjectKind::File,
        id: file.id.to_string(),
    };
    let open =
        f.db.file_working_begin_session(&f.request, &f.binding, &object)
            .unwrap();
    let session = crate::file_working::WorkingSession {
        object: object.clone(),
        session_id: open.session_id,
    };
    let payload = crate::file_working::WorkingSaveText {
        object: object.clone(),
        session_id: session.session_id.clone(),
        expected_revision: open.status.revision,
        expected_content_hash: open.status.content_hash.clone(),
        text: "saved pending".into(),
    };
    let mut save = f.request.clone();
    save.request_id = "save-before-drop".into();
    f.db.file_working_save(
        &save,
        &f.binding,
        &session,
        open.status.revision,
        &open.status.content_hash,
        &payload,
        b"saved pending",
        100,
    )
    .unwrap();
    session
}

#[test]
fn drop_archive_prepare_receipt_failure_resumes_once_and_commit_failure_keeps_sessions() {
    let mut f = fixture();
    let file = import(&mut f);
    let session = saved_pending(&mut f, &file);
    let p = source(&f, "next.md", b"next");
    f.db.conn.execute_batch("CREATE TRIGGER fail_prepare BEFORE INSERT ON agent_operation_receipts WHEN NEW.operation='file.drop.prepare' BEGIN SELECT RAISE(ABORT,'prepare failure'); END;").unwrap();
    assert!(f
        .db
        .file_drop_prepare(&f.request, &f.binding, &p, update(&file))
        .is_err());
    assert_eq!(
        f.db.document_record(file.id)
            .unwrap()
            .current_version_number,
        2
    );
    assert!(f
        .db
        .file_working_session_base(&f.request, &f.binding, &session)
        .is_ok());
    f.db.conn
        .execute_batch("DROP TRIGGER fail_prepare")
        .unwrap();
    let intent =
        f.db.file_drop_prepare(&f.request, &f.binding, &p, update(&file))
            .unwrap();
    assert_eq!(
        f.db.document_record(file.id)
            .unwrap()
            .current_version_number,
        2
    );
    assert!(f
        .db
        .file_drop_committed(&f.request, &f.binding, &intent.intent_id)
        .unwrap()
        .is_none());
    f.db.conn.execute_batch("CREATE TRIGGER fail_version BEFORE INSERT ON document_versions WHEN NEW.version_number=3 BEGIN SELECT RAISE(ABORT,'version failure'); END;").unwrap();
    let adapter = trash(&f, false);
    assert!(f
        .db
        .file_drop_commit(&f.request, &f.binding, &intent.intent_id, &adapter)
        .is_err());
    assert!(p.exists());
    assert_eq!(adapter.calls.get(), 0);
    assert!(f
        .db
        .file_working_session_base(&f.request, &f.binding, &session)
        .is_ok());
    assert_eq!(
        f.db.document_record(file.id)
            .unwrap()
            .current_version_number,
        2
    );
    f.db.conn
        .execute_batch("DROP TRIGGER fail_version")
        .unwrap();
    let committed =
        f.db.file_drop_commit(&f.request, &f.binding, &intent.intent_id, &adapter)
            .unwrap();
    assert!(committed.old_sessions_closed);
    assert_eq!(committed.version_number, 3);
    let before: i64 =
        f.db.conn
            .query_row("SELECT total_changes()", [], |r| r.get(0))
            .unwrap();
    let replay =
        f.db.file_drop_committed(&f.request, &f.binding, &intent.intent_id)
            .unwrap()
            .unwrap();
    assert_eq!(replay.version_number, 3);
    assert!(replay.old_sessions_closed);
    assert_eq!(
        before,
        f.db.conn
            .query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0))
            .unwrap()
    );
}
#[test]
fn saved_pending_identical_drop_is_no_change_and_keeps_sessions() {
    let mut f = fixture();
    let file = import(&mut f);
    let session = saved_pending(&mut f, &file);
    let p = source(&f, "same.md", b"saved pending");
    let intent =
        f.db.file_drop_prepare(&f.request, &f.binding, &p, update(&file))
            .unwrap();
    let result =
        f.db.file_drop_commit(&f.request, &f.binding, &intent.intent_id, &trash(&f, false))
            .unwrap();
    assert_eq!(result.version_number, 2);
    assert!(result.no_change);
    assert!(!result.old_sessions_closed);
    assert!(f
        .db
        .file_working_session_base(&f.request, &f.binding, &session)
        .is_ok());
    assert!(!p.exists());
}
#[test]
fn drop_prepare_saved_writer_change_fails_cas_without_rearchive() {
    let mut f = fixture();
    let file = import(&mut f);
    let session = saved_pending(&mut f, &file);
    let p = source(&f, "next.md", b"next");
    f.db.conn.execute_batch("CREATE TRIGGER fail_prepare BEFORE INSERT ON agent_operation_receipts WHEN NEW.operation='file.drop.prepare' BEGIN SELECT RAISE(ABORT,'prepare failure'); END;").unwrap();
    assert!(f
        .db
        .file_drop_prepare(&f.request, &f.binding, &p, update(&file))
        .is_err());
    f.db.conn
        .execute_batch("DROP TRIGGER fail_prepare")
        .unwrap();
    let status =
        f.db.file_working_open_status(&f.request, &f.binding, &session.object)
            .unwrap();
    // A later native writer invalidates the captured post-archive authority.
    let mut save = f.request.clone();
    save.request_id = "other-save".into();
    let payload = crate::file_working::WorkingSaveText {
        object: session.object.clone(),
        session_id: session.session_id.clone(),
        expected_revision: status.revision,
        expected_content_hash: status.content_hash.clone(),
        text: "later".into(),
    };
    f.db.file_working_save(
        &save,
        &f.binding,
        &session,
        status.revision,
        &status.content_hash,
        &payload,
        b"later",
        101,
    )
    .unwrap();
    assert_eq!(
        f.db.file_drop_prepare(&f.request, &f.binding, &p, update(&file))
            .unwrap_err()
            .code,
        ErrorCode::RevisionConflict
    );
    assert_eq!(
        f.db.document_record(file.id)
            .unwrap()
            .current_version_number,
        2
    );
    assert!(p.exists());
}

#[test]
fn changed_drop_keeps_directory_file_name_live_path_and_old_version_bytes() {
    let mut f = fixture();
    let file = import(&mut f);
    let object = ObjectRef {
        workspace_id: f.binding.workspace_id.clone(),
        scope: super::super::file_scope::scope(None),
        kind: ObjectKind::File,
        id: file.id.to_string(),
    };
    f.db.project_file_resolve(&object).unwrap();
    let directory = f.db.document_record(file.id).unwrap();
    assert_eq!(directory.storage_mode, "project_directory");
    let before =
        f.db.document_list_versions(crate::models::DocumentListVersionsInput {
            document_id: file.id,
        })
        .unwrap();
    let p = source(&f, "different.md", b"new body");
    let prepared =
        f.db.file_drop_prepare(&f.request, &f.binding, &p, update(&directory))
            .unwrap();
    let result =
        f.db.file_drop_commit(
            &f.request,
            &f.binding,
            &prepared.intent_id,
            &trash(&f, false),
        )
        .unwrap();
    assert_eq!(result.version_number, 2);
    let after = f.db.document_record(file.id).unwrap();
    assert_eq!(after.managed_path, directory.managed_path);
    assert_eq!(after.name, directory.name);
    assert_eq!(fs::read(&after.managed_path).unwrap(), b"new body");
    for version in before {
        assert_eq!(fs::read(&version.managed_path).unwrap(), b"original");
    }
    assert!(f.db.project_file_resolve(&object).is_ok());
}
