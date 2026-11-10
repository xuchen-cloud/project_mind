use super::*;
use crate::{
    agent::access::ScopeGrant,
    file_working::{WorkingSaveText, WorkingSession},
    models::{DocumentImportInput, ProjectCreateInput},
};
struct Fixture {
    _root: tempfile::TempDir,
    _external: tempfile::TempDir,
    db: Database,
    binding: WorkspaceBinding,
    request: RequestContext,
    file: crate::models::DocumentRecord,
    owners: Vec<i64>,
}
fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let (meta, paths) = crate::workspace::create_workspace(root.path(), "password").unwrap();
    let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
    let mut owners = Vec::new();
    for name in ["A", "B"] {
        owners.push(
            db.project_create(ProjectCreateInput {
                name: name.into(),
                summary: None,
                status: None,
            })
            .unwrap()
            .id,
        );
    }
    let source = external.path().join("source.md");
    fs::write(&source, b"original").unwrap();
    let file = db
        .document_import(DocumentImportInput {
            project_id: None,
            source_path: source.to_string_lossy().into(),
            is_starred: false,
            tag_ids: None,
        })
        .unwrap();
    let binding = WorkspaceBinding {
        workspace_id: meta.workspace_id,
        generation: "fixture".into(),
    };
    let request = RequestContext {
        binding: binding.clone(),
        request_id: "move".into(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: true,
            project_ids: owners.clone(),
            operations: vec![
                "file.move".into(),
                "file.update".into(),
                "source.read".into(),
            ],
            object_keys: None,
        },
    };
    db.bind_file_commit_fence(std::sync::Arc::new(
        crate::workspace_commit_fence::WorkspaceCommitFence::new(),
    ));
    Fixture {
        _root: root,
        _external: external,
        db,
        binding,
        request,
        file,
        owners,
    }
}
fn object(f: &Fixture, owner: Option<i64>) -> ObjectRef {
    ObjectRef {
        workspace_id: f.binding.workspace_id.clone(),
        scope: super::super::file_scope::scope(owner),
        kind: ObjectKind::File,
        id: f.file.id.to_string(),
    }
}
fn input(f: &Fixture) -> FileOwnerMove {
    let b =
        f.db.file_owner_move_baseline(&f.request, &f.binding, f.file.id, None)
            .unwrap();
    FileOwnerMove {
        document_id: f.file.id,
        source_owner: None,
        target_owner: Some(f.owners[0]),
        expected_version: b.expected_version,
        expected_working_revision: b.expected_working_revision,
        expected_hash: b.expected_hash,
    }
}
#[test]
fn baseline_is_read_only_without_working_or_office() {
    let f = fixture();
    let changes = f.db.conn.total_changes();
    let b =
        f.db.file_owner_move_baseline(&f.request, &f.binding, f.file.id, None)
            .unwrap();
    assert_eq!(b.expected_version, 1);
    assert_eq!(b.expected_working_revision, None);
    assert_eq!(
        b.expected_hash,
        "sha256:0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5"
    );
    assert_eq!(f.db.conn.total_changes(), changes);
    let count: i64 =
        f.db.conn
            .query_row("SELECT count(*) FROM file_working_contents", [], |r| {
                r.get(0)
            })
            .unwrap();
    assert_eq!(count, 0);
}
#[test]
fn saved_pending_working_and_history_survive_and_only_target_sessions_end() {
    let mut f = fixture();
    let old = object(&f, None);
    let opened =
        f.db.file_working_begin_session(&f.request, &f.binding, &old)
            .unwrap();
    let session = WorkingSession {
        object: old.clone(),
        session_id: opened.session_id,
    };
    let save = WorkingSaveText {
        object: old.clone(),
        session_id: session.session_id.clone(),
        expected_revision: opened.status.revision,
        expected_content_hash: opened.status.content_hash.clone(),
        text: "saved working".into(),
    };
    let mut save_request = f.request.clone();
    save_request.request_id = "save".into();
    let status =
        f.db.file_working_save(
            &save_request,
            &f.binding,
            &session,
            opened.status.revision,
            &opened.status.content_hash,
            &save,
            b"saved working",
            100,
        )
        .unwrap();
    let other = f._external.path().join("other.md");
    fs::write(&other, b"other").unwrap();
    let other =
        f.db.document_import(DocumentImportInput {
            project_id: None,
            source_path: other.to_string_lossy().into(),
            is_starred: false,
            tag_ids: None,
        })
        .unwrap();
    let other_object = ObjectRef {
        id: other.id.to_string(),
        ..old.clone()
    };
    let other_open =
        f.db.file_working_begin_session(&f.request, &f.binding, &other_object)
            .unwrap();
    let other_session = WorkingSession {
        object: other_object,
        session_id: other_open.session_id,
    };
    f.db.file_working_close(&f.request, &f.binding, &session)
        .unwrap();
    let before =
        f.db.document_list_versions(crate::models::DocumentListVersionsInput {
            document_id: f.file.id,
        })
        .unwrap();
    let changes = f.db.conn.total_changes();
    let baseline =
        f.db.file_owner_move_baseline(&f.request, &f.binding, f.file.id, None)
            .unwrap();
    assert_eq!(baseline.expected_working_revision, Some(status.revision));
    assert_eq!(baseline.expected_hash, status.content_hash);
    assert_eq!(f.db.conn.total_changes(), changes);
    let reopened =
        f.db.file_working_begin_session(&f.request, &f.binding, &old)
            .unwrap();
    let stale = WorkingSession {
        object: old.clone(),
        session_id: reopened.session_id,
    };
    let move_input = input(&f);
    let result =
        f.db.file_owner_move(&f.request, &f.binding, &move_input)
            .unwrap();
    assert!(result.old_sessions_closed);
    assert_eq!(fs::read(&result.managed_path).unwrap(), b"saved working");
    let after =
        f.db.document_list_versions(crate::models::DocumentListVersionsInput {
            document_id: f.file.id,
        })
        .unwrap();
    assert_eq!(before.len(), after.len());
    for (a, b) in before.iter().zip(after.iter()) {
        assert_eq!(a.id, b.id);
        assert_eq!(a.version_number, b.version_number);
        assert_eq!(a.managed_path, b.managed_path);
        assert_eq!(fs::read(&b.managed_path).unwrap(), b"original");
    }
    assert_eq!(
        f.db.file_working_close(&f.request, &f.binding, &stale)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    let new_object = object(&f, result.project_id);
    let mut canonical_stale = stale;
    canonical_stale.object = new_object.clone();
    assert!(f
        .db
        .file_working_session_base(&f.request, &f.binding, &canonical_stale)
        .is_err());
    assert_eq!(
        f.db.file_working_session_base(&f.request, &f.binding, &other_session)
            .unwrap()
            .1,
        b"other"
    );
    let current =
        f.db.file_working_open_status(&f.request, &f.binding, &new_object)
            .unwrap();
    assert_eq!(current.revision, status.revision);
    assert_eq!(current.content_hash, status.content_hash);
    assert!(current.pending_archive);
}
#[test]
fn stale_replay_scope_and_name_errors_are_structured() {
    let mut f = fixture();
    let good = input(&f);
    let mut stale = good.clone();
    stale.expected_version = 2;
    assert_eq!(
        f.db.file_owner_move(&f.request, &f.binding, &stale)
            .unwrap_err()
            .code,
        ErrorCode::RevisionConflict
    );
    let mut denied = f.request.clone();
    denied.scope_grant.project_ids.clear();
    assert_eq!(
        f.db.file_owner_move(&denied, &f.binding, &good)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    let target =
        f.db.file_scope_root(good.target_owner)
            .unwrap()
            .join(&f.file.name);
    fs::write(&target, b"occupied").unwrap();
    assert_eq!(
        f.db.file_owner_move(&f.request, &f.binding, &good)
            .unwrap_err()
            .code,
        ErrorCode::RevisionConflict
    );
    assert_eq!(fs::read(&target).unwrap(), b"occupied");
    fs::remove_file(&target).unwrap();
    let result = f.db.file_owner_move(&f.request, &f.binding, &good).unwrap();
    let replay = f.db.file_owner_move(&f.request, &f.binding, &good).unwrap();
    assert_eq!(replay.managed_path, result.managed_path);
    stale.expected_hash = good.expected_hash.clone();
    assert_eq!(
        f.db.file_owner_move(&f.request, &f.binding, &stale)
            .unwrap_err()
            .code,
        ErrorCode::IdempotencyConflict
    );
}
#[test]
fn staging_and_sql_failures_recover_without_deleting_replacements() {
    for phase in 1..=4 {
        let mut f = fixture();
        let good = input(&f);
        FAIL_MOVE.with(|v| v.set(phase));
        assert!(f.db.file_owner_move(&f.request, &f.binding, &good).is_err());
        FAIL_MOVE.with(|v| v.set(0));
        f.db.file_owner_move_recover_pending().unwrap();
        let current = f.db.document_record(f.file.id).unwrap();
        assert_eq!(
            current.project_id,
            if phase == 4 { good.target_owner } else { None }
        );
        assert_eq!(fs::read(&current.managed_path).unwrap(), b"original");
        assert_eq!(
            f.db.file_owner_move(&f.request, &f.binding, &good)
                .unwrap()
                .document_id,
            f.file.id
        );
    }
    let mut f = fixture();
    let good = input(&f);
    FAIL_MOVE.with(|v| v.set(2));
    assert!(f.db.file_owner_move(&f.request, &f.binding, &good).is_err());
    FAIL_MOVE.with(|v| v.set(0));
    let target =
        f.db.file_scope_root(good.target_owner)
            .unwrap()
            .join(&f.file.name);
    fs::remove_file(&target).unwrap();
    fs::write(&target, b"replacement").unwrap();
    assert!(f.db.file_owner_move_recover_pending().is_err());
    assert_eq!(fs::read(&target).unwrap(), b"replacement");
    assert_eq!(fs::read(&f.file.managed_path).unwrap(), b"original");
}
#[test]
fn old_reference_reads_current_owner_and_canonical_allowlist() {
    let mut f = fixture();
    let old = object(&f, None);
    let good = input(&f);
    let moved = f.db.file_owner_move(&f.request, &f.binding, &good).unwrap();
    let canonical = object(&f, moved.project_id);
    let target = crate::source_service::SourceReadTarget {
        object: old.clone(),
        revision: None,
        file_version: Some(1),
        record_version: None,
    };
    let mut reader = f.request.clone();
    reader.scope_grant.project_ids.clear();
    assert_eq!(
        f.db.source_file_plan(&reader, &f.binding, &target)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    reader.caller = Caller::Connection {
        grant_id: "trusted-native-CLI-fixture".into(),
    };
    reader.scope_grant.workspace_content = false;
    reader.scope_grant.project_ids = vec![f.owners[0]];
    let plan = f.db.source_file_plan(&reader, &f.binding, &target).unwrap();
    assert_eq!(plan.object, canonical);
    let bytes = crate::source_file_snapshot::capture_file_update(&plan).unwrap();
    assert_eq!(bytes.bytes, b"original");
    reader.scope_grant.object_keys = Some(vec![old.key().unwrap()]);
    assert_eq!(
        f.db.source_file_plan(&reader, &f.binding, &target)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    reader.scope_grant.object_keys = Some(vec![canonical.key().unwrap()]);
    assert_eq!(
        f.db.source_file_plan(&reader, &f.binding, &target)
            .unwrap()
            .object,
        canonical
    );
}
#[test]
fn owner_lease_waits_before_fence_and_rechecks_invalidation() {
    let mut f = fixture();
    let good = input(&f);
    let lease = f.db.file_project_lock(good.target_owner, true).unwrap();
    let fence = f.db.file_commit_fence.clone().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        tx.send(f.db.file_owner_move(&f.request, &f.binding, &good))
            .unwrap();
    });
    assert!(rx
        .recv_timeout(std::time::Duration::from_millis(80))
        .is_err());
    fence.invalidate();
    drop(lease);
    assert_eq!(
        rx.recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .unwrap_err()
            .code,
        ErrorCode::WorkspaceChanged
    );
    worker.join().unwrap();
}

#[test]
fn source_project_lifecycle_cannot_remove_moved_files_retained_history() {
    let mut f = fixture();
    let path = f._external.path().join("retained.md");
    fs::write(&path, b"retained history").unwrap();
    f.file =
        f.db.document_import(DocumentImportInput {
            project_id: Some(f.owners[0]),
            source_path: path.to_string_lossy().into(),
            is_starred: false,
            tag_ids: None,
        })
        .unwrap();
    let old = object(&f, Some(f.owners[0]));
    f.db.file_working_begin_session(&f.request, &f.binding, &old)
        .unwrap();
    let b =
        f.db.file_owner_move_baseline(&f.request, &f.binding, f.file.id, Some(f.owners[0]))
            .unwrap();
    let move_input = FileOwnerMove {
        document_id: f.file.id,
        source_owner: Some(f.owners[0]),
        target_owner: Some(f.owners[1]),
        expected_version: b.expected_version,
        expected_working_revision: b.expected_working_revision,
        expected_hash: b.expected_hash,
    };
    f.db.file_owner_move(&f.request, &f.binding, &move_input)
        .unwrap();
    assert!(
        f.db.project_delete(crate::models::ProjectDeleteInput {
            project_id: f.owners[0]
        })
        .is_err(),
        "source root must not trash another owner's retained history"
    );
    let versions =
        f.db.document_list_versions(crate::models::DocumentListVersionsInput {
            document_id: f.file.id,
        })
        .unwrap();
    assert_eq!(
        fs::read(&versions[0].managed_path).unwrap(),
        b"retained history"
    );
}

#[test]
fn scope_tags_map_without_reusing_ids_and_color_conflict_rolls_back() {
    let mut f = fixture();
    let source =
        f.db.file_tag_option_upsert(crate::models::FileTagOptionUpsertInput {
            project_id: None,
            id: None,
            label: "Review".into(),
            color_key: "blue".into(),
        })
        .unwrap();
    f.db.document_update_meta(crate::models::DocumentUpdateMetaInput {
        document_id: f.file.id,
        base_name: None,
        is_starred: None,
        tag_ids: Some(vec![source.id]),
    })
    .unwrap();
    let mut good = input(&f);
    let result = f.db.file_owner_move(&f.request, &f.binding, &good).unwrap();
    let moved = f.db.document_record(f.file.id).unwrap();
    assert_eq!(moved.tags.len(), 1);
    assert_ne!(moved.tags[0].id, source.id);
    assert_eq!(moved.tags[0].label, "Review");
    assert_eq!(moved.tags[0].color_key, "blue");
    f.db.file_tag_option_upsert(crate::models::FileTagOptionUpsertInput {
        project_id: Some(f.owners[1]),
        id: None,
        label: "Review".into(),
        color_key: "red".into(),
    })
    .unwrap();
    f.request.request_id = "incompatible-color".into();
    good.source_owner = result.project_id;
    good.target_owner = Some(f.owners[1]);
    assert_eq!(
        f.db.file_owner_move(&f.request, &f.binding, &good)
            .unwrap_err()
            .code,
        ErrorCode::RevisionConflict
    );
    f.db.file_owner_move_recover_pending().unwrap();
    assert_eq!(
        f.db.document_record(f.file.id).unwrap().project_id,
        result.project_id
    );
}

#[test]
fn all_versions_and_closed_saved_working_keep_ids_hashes_and_bytes() {
    let mut f = fixture();
    let next = f._external.path().join("next.md");
    fs::write(&next, b"second immutable").unwrap();
    f.db.document_add_version(crate::models::DocumentAddVersionInput {
        document_id: f.file.id,
        source_path: Some(next.to_string_lossy().into()),
    })
    .unwrap();
    let old = object(&f, None);
    let opened =
        f.db.file_working_begin_session(&f.request, &f.binding, &old)
            .unwrap();
    let session = WorkingSession {
        object: old.clone(),
        session_id: opened.session_id,
    };
    let payload = WorkingSaveText {
        object: old.clone(),
        session_id: session.session_id.clone(),
        expected_revision: opened.status.revision,
        expected_content_hash: opened.status.content_hash.clone(),
        text: "latest saved".into(),
    };
    let mut save = f.request.clone();
    save.request_id = "multi-save".into();
    f.db.file_working_save(
        &save,
        &f.binding,
        &session,
        opened.status.revision,
        &opened.status.content_hash,
        &payload,
        b"latest saved",
        100,
    )
    .unwrap();
    f.db.file_working_close(&f.request, &f.binding, &session)
        .unwrap();
    let versions =
        f.db.document_list_versions(crate::models::DocumentListVersionsInput {
            document_id: f.file.id,
        })
        .unwrap();
    let registered:Vec<(i64,i64,String)>=f.db.conn.prepare("SELECT v.id,v.version_number,h.content_hash FROM document_versions v JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1 ORDER BY v.version_number").unwrap().query_map([f.file.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    let b = input(&f);
    let result = f.db.file_owner_move(&f.request, &f.binding, &b).unwrap();
    assert_eq!(fs::read(&result.managed_path).unwrap(), b"latest saved");
    let moved =
        f.db.document_list_versions(crate::models::DocumentListVersionsInput {
            document_id: f.file.id,
        })
        .unwrap();
    assert_eq!(moved.len(), 2);
    for (before, after) in versions.iter().zip(&moved) {
        assert_eq!(before.id, after.id);
        assert_eq!(before.version_number, after.version_number);
        assert_eq!(before.managed_path, after.managed_path);
        assert_eq!(
            fs::read(&after.managed_path).unwrap(),
            if after.version_number == 1 {
                b"original".as_slice()
            } else {
                b"second immutable".as_slice()
            }
        );
    }
    let after:Vec<(i64,i64,String)>=f.db.conn.prepare("SELECT v.id,v.version_number,h.content_hash FROM document_versions v JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1 ORDER BY v.version_number").unwrap().query_map([f.file.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    assert_eq!(after, registered);
}

#[test]
fn replay_without_old_seal_uses_current_owner_grant_and_allowlist_without_writes() {
    let mut f = fixture();
    let good = input(&f);
    assert!(f
        .db
        .file_owner_move_replay(&f.request, &f.binding, &good)
        .unwrap()
        .is_none());
    let result = f.db.file_owner_move(&f.request, &f.binding, &good).unwrap();
    let canonical = object(&f, result.project_id);
    let old = object(&f, None);
    let mut current = f.request.clone();
    current.scope_grant.workspace_content = false;
    current.scope_grant.object_keys = Some(vec![canonical.key().unwrap()]);
    let before = f.db.conn.total_changes();
    let replay =
        f.db.file_owner_move_replay(&current, &f.binding, &good)
            .unwrap()
            .expect("committed move must replay without old owner seal");
    assert_eq!(replay.managed_path, result.managed_path);
    assert_eq!(f.db.conn.total_changes(), before);
    current.scope_grant.object_keys = Some(vec![old.key().unwrap()]);
    assert_eq!(
        f.db.file_owner_move_replay(&current, &f.binding, &good)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    current.scope_grant.object_keys = None;
    current.scope_grant.project_ids.clear();
    current.scope_grant.workspace_content = true;
    assert_eq!(
        f.db.file_owner_move_replay(&current, &f.binding, &good)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
}

#[test]
#[ignore]
fn owner_move_crash_process_fixture() {
    let root = std::env::var_os("MIND_FILE_OWNER_MOVE_CRASH_ROOT")
        .map(std::path::PathBuf::from)
        .unwrap();
    let paths = crate::workspace::workspace_paths(&root);
    let mut db = Database::open(&paths.db_path, &root, None).unwrap();
    let id = std::env::var("MIND_FILE_OWNER_MOVE_CRASH_FILE")
        .unwrap()
        .parse()
        .unwrap();
    let owner = std::env::var("MIND_FILE_OWNER_MOVE_CRASH_OWNER")
        .unwrap()
        .parse()
        .unwrap();
    let workspace = crate::workspace::load_metadata(&root)
        .unwrap()
        .0
        .workspace_id;
    let binding = WorkspaceBinding {
        workspace_id: workspace,
        generation: "fixture".into(),
    };
    let request = RequestContext {
        binding: binding.clone(),
        request_id: "move".into(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: true,
            project_ids: vec![owner],
            operations: vec!["file.move".into()],
            object_keys: None,
        },
    };
    let b = db
        .file_owner_move_baseline(&request, &binding, id, None)
        .unwrap();
    db.file_owner_move(
        &request,
        &binding,
        &FileOwnerMove {
            document_id: id,
            source_owner: None,
            target_owner: Some(owner),
            expected_version: b.expected_version,
            expected_working_revision: b.expected_working_revision,
            expected_hash: b.expected_hash,
        },
    )
    .unwrap();
    panic!("crash hook did not terminate child");
}
#[test]
fn process_death_at_staging_placement_sql_and_receipt_recovers() {
    for phase in 1..=4 {
        let mut f = fixture();
        let good = input(&f);
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "db::file_owner_move::integration_tests::owner_move_crash_process_fixture",
                "--ignored",
                "--nocapture",
            ])
            .env("MIND_FILE_OWNER_MOVE_CRASH_ROOT", f._root.path())
            .env("MIND_FILE_OWNER_MOVE_CRASH_FILE", f.file.id.to_string())
            .env("MIND_FILE_OWNER_MOVE_CRASH_OWNER", f.owners[0].to_string())
            .env("MIND_FILE_OWNER_MOVE_CRASH_STAGE", phase.to_string())
            .output()
            .unwrap();
        assert!(!output.status.success(), "child must die at phase {phase}");
        let paths = crate::workspace::workspace_paths(f._root.path());
        f.db = Database::open(&paths.db_path, f._root.path(), None).unwrap();
        f.db.file_owner_move_recover_pending().unwrap();
        let current = f.db.document_record(f.file.id).unwrap();
        assert_eq!(
            current.project_id,
            if phase == 4 { good.target_owner } else { None }
        );
        assert_eq!(fs::read(&current.managed_path).unwrap(), b"original");
        assert_eq!(
            f.db.file_owner_move(&f.request, &f.binding, &good)
                .unwrap()
                .document_id,
            f.file.id
        );
    }
}

#[test]
fn move_receipt_and_both_scope_changes_commit_once() {
    let mut f = fixture();
    let good = input(&f);
    let before = f.db.committed_change_watermark().unwrap();
    f.db.file_owner_move(&f.request, &f.binding, &good).unwrap();
    let changes =
        f.db.committed_changes_since(&f.binding, &f.request.request_id, before)
            .unwrap()
            .unwrap();
    assert!(changes.changed_refs.contains(&object(&f, None)));
    assert!(changes
        .changed_refs
        .contains(&object(&f, good.target_owner)));
    assert_eq!(changes.changed_refs.len(), 2);
    let after = f.db.committed_change_watermark().unwrap();
    f.db.file_owner_move(&f.request, &f.binding, &good).unwrap();
    assert_eq!(f.db.committed_change_watermark().unwrap(), after);
}
