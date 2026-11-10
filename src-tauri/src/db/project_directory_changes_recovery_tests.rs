use super::*;
use crate::models::ProjectCreateInput;

fn setup() -> (tempfile::TempDir, Database, WorkspaceBinding, i64, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let (metadata, paths) = crate::workspace::create_workspace(&root, "fixture").unwrap();
    let mut db = Database::open(&paths.db_path, &root, None).unwrap();
    let project = db
        .project_create(ProjectCreateInput {
            name: "Folders".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let binding = WorkspaceBinding {
        workspace_id: metadata.workspace_id,
        generation: "fixture".into(),
    };
    let folder = PathBuf::from(project.root_path).join("source");
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("known.md"), b"retained history").unwrap();
    fs::write(folder.join("unmanaged.bin"), b"ordinary contents").unwrap();
    db.project_file_register(&binding.workspace_id, project.id, "source/known.md")
        .unwrap();
    (temp, db, binding, project.id, folder)
}
fn crash(root: &Path, phase: u8, operation: &str) {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "db::project_directory_changes::recovery_tests::directory_change_crash_fixture",
            "--ignored",
            "--test-threads=1",
        ])
        .env("MIND_DIRECTORY_CRASH_ROOT", root)
        .env("MIND_DIRECTORY_CRASH_STAGE", phase.to_string())
        .env("MIND_DIRECTORY_CRASH_OPERATION", operation)
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(91),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
#[test]
#[ignore = "child fixture, invoked by process crash tests"]
fn directory_change_crash_fixture() {
    let root = PathBuf::from(std::env::var_os("MIND_DIRECTORY_CRASH_ROOT").unwrap());
    let (metadata, paths) = crate::workspace::load_metadata(&root).unwrap();
    let db = Database::open(&paths.db_path, &root, None).unwrap();
    let project = db.file_project_ids().unwrap()[0];
    let binding = WorkspaceBinding {
        workspace_id: metadata.workspace_id,
        generation: "fixture".into(),
    };
    let operation = std::env::var("MIND_DIRECTORY_CRASH_OPERATION").unwrap();
    let navigation = operation == "navigation-file";
    let relative = if navigation {
        "source/known.md"
    } else {
        "source"
    };
    let token = if navigation {
        db.project_navigation_trash_prepare(&binding, Some(project), relative)
            .unwrap()
            .prepared
            .token
    } else {
        db.project_directory_change_prepare(&binding, Some(project), relative)
            .unwrap()
            .token
    };
    let input = DirectoryChangeInput {
        binding,
        project_id: Some(project),
        relative_path: relative.into(),
        token,
        name: (operation == "rename").then(|| "target".into()),
        confirmed: Some(true),
        request_id: "crash-request".into(),
    };
    let trash = |source: &Path| files::move_exclusive(source, &root.join("fixture-trash"));
    let result = if navigation {
        db.project_navigation_trash_with(&input, trash)
    } else {
        db.project_directory_change_with(&input, trash)
    };
    if std::env::var_os("MIND_DIRECTORY_SWAP_PARENT").is_some() {
        let error = result.unwrap_err();
        assert_eq!(
            error.downcast_ref::<FileServiceError>().unwrap().code,
            "revision_conflict"
        );
        assert!(!root.join("fixture-trash").exists());
        return;
    }
    result.unwrap();
    panic!("crash hook did not execute");
}
#[test]
fn directory_rename_recovers_all_process_crash_boundaries() {
    for phase in 0..=3 {
        let (_temp, db, binding, owner, source) = setup();
        let root = db.workspace_root.clone();
        let file = db
            .project_file_register(&binding.workspace_id, owner, "source/known.md")
            .unwrap();
        let id: i64 = file.object.id.parse().unwrap();
        let version_before: (i64, i64, String) = db.conn.query_row("SELECT v.id,v.version_number,h.content_hash FROM document_versions v JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1", [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        let db_path = crate::workspace::workspace_paths(&root).db_path;
        drop(db);
        crash(&root, phase, "rename");
        let db = Database::open(&db_path, &root, None).unwrap();
        let target = source.with_file_name("target");
        assert_eq!(source.exists(), phase < 3);
        assert_eq!(target.exists(), phase == 3);
        let record = db.document_record(id).unwrap();
        let expected = if phase == 3 { &target } else { &source };
        assert_eq!(Path::new(&record.managed_path), expected.join("known.md"));
        assert_eq!(fs::read(&record.managed_path).unwrap(), b"retained history");
        let version_after: (i64, i64, String) = db.conn.query_row("SELECT v.id,v.version_number,h.content_hash FROM document_versions v JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1", [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(version_before, version_after);
        assert!(fs::read_dir(root.join(JOURNALS)).unwrap().next().is_none());
    }
}

#[test]
fn directory_recovery_obeys_bound_workspace_fence_before_rollback() {
    let (_temp, mut db, _binding, _owner, source) = setup();
    let root = db.workspace_root.clone();
    crash(&root, 2, "rename");
    let target = source.with_file_name("target");
    let fence = std::sync::Arc::new(crate::workspace_commit_fence::WorkspaceCommitFence::new());
    fence.invalidate();
    db.bind_file_commit_fence(fence);
    assert!(db.project_directory_recover_pending(None).is_err());
    assert!(!source.exists());
    assert!(target.exists());
    assert_eq!(fs::read_dir(root.join(JOURNALS)).unwrap().count(), 1);

    db.bind_file_commit_fence(std::sync::Arc::new(
        crate::workspace_commit_fence::WorkspaceCommitFence::new(),
    ));
    db.project_directory_recover_pending(None).unwrap();
    assert!(source.exists());
    assert!(!target.exists());
    assert!(fs::read_dir(root.join(JOURNALS)).unwrap().next().is_none());
}
#[test]
fn directory_trash_recovers_all_process_crash_boundaries_with_readable_history() {
    for phase in 0..=3 {
        let (_temp, db, binding, owner, source) = setup();
        let root = db.workspace_root.clone();
        let file = db
            .project_file_register(&binding.workspace_id, owner, "source/known.md")
            .unwrap();
        let id: i64 = file.object.id.parse().unwrap();
        let db_path = crate::workspace::workspace_paths(&root).db_path;
        drop(db);
        crash(&root, phase, "trash");
        let db = Database::open(&db_path, &root, None).unwrap();
        assert_eq!(source.exists(), phase < 2);
        let record = db.document_record(id).unwrap();
        assert_eq!(record.health, if phase < 2 { "normal" } else { "missing" });
        let snapshot: String = db
            .conn
            .query_row(
                "SELECT managed_path FROM document_versions WHERE document_id=?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            fs::read(db.decode_path_ref(&snapshot)).unwrap(),
            b"retained history"
        );
        if phase >= 2 {
            assert_eq!(
                fs::read(root.join("fixture-trash/unmanaged.bin")).unwrap(),
                b"ordinary contents"
            );
        }
        assert!(fs::read_dir(root.join(JOURNALS)).unwrap().next().is_none());
    }
}
#[test]
fn directory_conflicting_recovery_keeps_evidence_and_allows_unrelated_folder() {
    let (_temp, db, binding, owner, source) = setup();
    let root = db.workspace_root.clone();
    let db_path = crate::workspace::workspace_paths(&root).db_path;
    drop(db);
    crash(&root, 2, "rename");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("foreign.txt"), b"replacement").unwrap();
    let db = Database::open(&db_path, &root, None).unwrap();
    assert!(db
        .project_file_register(&binding.workspace_id, owner, "source/foreign.txt")
        .is_err());
    assert!(db
        .project_file_register(&binding.workspace_id, owner, "target/known.md")
        .is_err());
    assert_eq!(
        db.conn
            .query_row("SELECT count(*) FROM documents", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(db
        .project_directory_change_prepare(&binding, Some(owner), "source")
        .is_err());
    fs::create_dir(source.with_file_name("unrelated")).unwrap();
    let token = db
        .project_directory_change_prepare(&binding, Some(owner), "unrelated")
        .unwrap()
        .token;
    let input = DirectoryChangeInput {
        binding,
        project_id: Some(owner),
        relative_path: "unrelated".into(),
        token,
        name: Some("usable".into()),
        confirmed: None,
        request_id: "unrelated".into(),
    };
    db.project_directory_change_with(&input, |_| panic!("rename must not trash"))
        .unwrap();
    assert!(source.with_file_name("usable").is_dir());
    assert_eq!(
        fs::read(source.join("foreign.txt")).unwrap(),
        b"replacement"
    );
    assert!(source.with_file_name("target").join("known.md").is_file());
    assert_eq!(fs::read_dir(root.join(JOURNALS)).unwrap().count(), 1);
}

#[test]
fn directory_recovery_external_file_or_missing_ancestor_keeps_workspace_available() {
    for variant in ["source-file", "target-file", "missing-parent"] {
        let (_temp, db, _binding, _owner, source) = setup();
        let root = db.workspace_root.clone();
        let db_path = crate::workspace::workspace_paths(&root).db_path;
        drop(db);
        crash(&root, 2, "rename");
        let target = source.with_file_name("target");
        match variant {
            "source-file" => fs::write(&source, b"foreign occupant").unwrap(),
            "target-file" => {
                fs::rename(&target, root.join("retained-target")).unwrap();
                fs::write(&target, b"foreign target").unwrap();
            }
            _ => fs::rename(source.parent().unwrap(), root.join("retained-owner")).unwrap(),
        }
        let mut db = Database::open(&db_path, &root, None).unwrap();
        assert_eq!(fs::read_dir(root.join(JOURNALS)).unwrap().count(), 1);
        let unrelated = db
            .project_create(ProjectCreateInput {
                name: "Usable".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        fs::write(Path::new(&unrelated.root_path).join("safe.md"), b"safe").unwrap();
        let workspace = db.native_workspace_id.as_ref().unwrap();
        assert_eq!(
            db.project_file_register(workspace, unrelated.id, "safe.md")
                .unwrap()
                .state,
            "ready"
        );
    }
}

#[test]
fn directory_storage_contention_returns_without_entering_lifecycle_fence() {
    let (_temp, db, binding, owner, source) = setup();
    let token = db
        .project_directory_change_prepare(&binding, Some(owner), "source")
        .unwrap()
        .token;
    let input = DirectoryChangeInput {
        binding: binding.clone(),
        project_id: Some(owner),
        relative_path: "source".into(),
        token,
        name: Some("target".into()),
        confirmed: None,
        request_id: "contended".into(),
    };
    let held = db.file_project_lock(owner, false).unwrap();
    let root = db.workspace_root.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let mut conn = Database::open_runtime_connection(
            &crate::workspace::workspace_paths(&root).db_path,
            &root,
            None,
        )
        .unwrap();
        conn.bind_native_workspace(&binding.workspace_id).unwrap();
        let result = conn.project_directory_change_fenced_with(
            &input,
            |_| panic!("must not trash"),
            || -> Result<()> { panic!("must not enter fence while owner is busy") },
        );
        sender
            .send(
                result
                    .unwrap_err()
                    .downcast::<FileServiceError>()
                    .unwrap()
                    .code,
            )
            .unwrap();
    });
    let result = receiver.recv_timeout(std::time::Duration::from_secs(2));
    drop(held);
    worker.join().unwrap();
    assert_eq!(result.unwrap(), "revision_conflict");
    assert!(source.exists());
}

#[test]
fn directory_closed_workspace_cannot_mutate_after_storage_admission() {
    let (_temp, db, binding, owner, source) = setup();
    let token = db
        .project_directory_change_prepare(&binding, Some(owner), "source")
        .unwrap()
        .token;
    let input = DirectoryChangeInput {
        binding,
        project_id: Some(owner),
        relative_path: "source".into(),
        token,
        name: Some("target".into()),
        confirmed: None,
        request_id: "fence-closed".into(),
    };
    let result = db.project_directory_change_fenced_with(
        &input,
        |_| panic!("must not trash"),
        || -> Result<()> { bail!("Workspace is closed") },
    );
    assert!(result.is_err());
    assert!(source.join("known.md").exists());
    assert!(!source.with_file_name("target").exists());
    assert!(!db.workspace_root.join(JOURNALS).exists());
}

#[cfg(unix)]
#[test]
fn directory_recovery_external_links_are_local_conflicts() {
    use std::os::unix::fs::symlink;
    for variant in ["source", "target", "parent"] {
        let (_temp, db, _binding, _owner, source) = setup();
        let root = db.workspace_root.clone();
        let db_path = crate::workspace::workspace_paths(&root).db_path;
        drop(db);
        crash(&root, 2, "rename");
        let target = source.with_file_name("target");
        let retained = root.join("retained-external");
        match variant {
            "source" => symlink(&target, &source).unwrap(),
            "target" => {
                fs::rename(&target, &retained).unwrap();
                symlink(&retained, &target).unwrap();
            }
            _ => {
                fs::rename(source.parent().unwrap(), &retained).unwrap();
                symlink(&retained, source.parent().unwrap()).unwrap();
            }
        }
        let mut db = Database::open(&db_path, &root, None).unwrap();
        assert_eq!(fs::read_dir(root.join(JOURNALS)).unwrap().count(), 1);
        assert!(db.workspace_page_get().is_ok());
    }
}

#[test]
fn directory_pending_history_blocks_a_file_whose_original_has_moved_outside() {
    let (_temp, db, binding, owner, source) = setup();
    let file = db
        .project_file_register(&binding.workspace_id, owner, "source/known.md")
        .unwrap();
    db.project_file_move(
        &file.object,
        "outside.md",
        1,
        file.content_hash.as_ref().unwrap(),
    )
    .unwrap();
    let id: i64 = file.object.id.parse().unwrap();
    let before = db.document_record(id).unwrap();
    assert!(Path::new(&before.history_dir_path).starts_with(&source));
    let root = db.workspace_root.clone();
    let db_path = crate::workspace::workspace_paths(&root).db_path;
    drop(db);
    crash(&root, 2, "rename");
    fs::create_dir(&source).unwrap();
    let db = Database::open(&db_path, &root, None).unwrap();
    let request = crate::agent::access::RequestContext {
        binding: binding.clone(),
        request_id: "blocked-history".into(),
        caller: crate::agent::access::Caller::Gui,
        scope_grant: crate::agent::access::ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: false,
            project_ids: vec![owner],
            operations: vec!["source.read".into(), "file.update".into()],
            object_keys: None,
        },
    };
    assert!(db
        .file_working_begin_session(&request, &binding, &file.object)
        .is_err());
    assert_eq!(fs::read(&before.managed_path).unwrap(), b"retained history");
    assert_eq!(fs::read_dir(root.join(JOURNALS)).unwrap().count(), 1);
}

#[test]
fn directory_rename_cannot_enter_either_missing_path_of_a_pending_journal() {
    let (_temp, db, binding, owner, source) = setup();
    let root = db.workspace_root.clone();
    let db_path = crate::workspace::workspace_paths(&root).db_path;
    drop(db);
    crash(&root, 2, "rename");
    fs::rename(
        source.with_file_name("target"),
        root.join("retained-external"),
    )
    .unwrap();
    let db = Database::open(&db_path, &root, None).unwrap();
    let unrelated = source.with_file_name("unrelated");
    fs::create_dir(&unrelated).unwrap();
    let token = db
        .project_directory_change_prepare(&binding, Some(owner), "unrelated")
        .unwrap()
        .token;
    for name in ["source", "target"] {
        let input = DirectoryChangeInput {
            binding: binding.clone(),
            project_id: Some(owner),
            relative_path: "unrelated".into(),
            token: token.clone(),
            name: Some(name.into()),
            confirmed: None,
            request_id: format!("blocked-target-{name}"),
        };
        assert!(db
            .project_directory_change_with(&input, |_| panic!("rename must not trash"))
            .is_err());
        assert!(unrelated.is_dir());
        assert!(!source.with_file_name(name).exists());
    }
    assert_eq!(fs::read_dir(root.join(JOURNALS)).unwrap().count(), 1);
}

#[test]
fn directory_journal_cleaned_after_enumeration_is_not_a_read_failure() {
    let (_temp, db, _binding, _owner, _source) = setup();
    let root = db.workspace_root.clone();
    crash(&root, 0, "rename");
    let directory = fs::read_dir(root.join(JOURNALS))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let path = directory.join("intent.json");
    assert!(read_intent(&path).unwrap().is_some());
    let cleaner = std::thread::spawn(move || clear(&directory).unwrap());
    cleaner.join().unwrap();
    assert!(read_intent(&path).unwrap().is_none());
    db.project_directory_recover_pending(None).unwrap();
    db.directory_require_no_pending(&root.join("unrelated"), None)
        .unwrap();
}

#[cfg(unix)]
#[test]
fn directory_trash_retained_history_parent_swap_preserves_original_and_intent() {
    let (_temp, db, _binding, _owner, source) = setup();
    let root = db.workspace_root.clone();
    let db_path = crate::workspace::workspace_paths(&root).db_path;
    drop(db);
    crash(&root, 1, "trash");
    let retained = root.join("external-parent");
    fs::rename(source.parent().unwrap(), &retained).unwrap();
    std::os::unix::fs::symlink(&retained, source.parent().unwrap()).unwrap();
    let db = Database::open(&db_path, &root, None).unwrap();
    assert_eq!(
        fs::read(retained.join("source/known.md")).unwrap(),
        b"retained history"
    );
    assert_eq!(fs::read_dir(root.join(JOURNALS)).unwrap().count(), 1);
    assert!(!root.join("fixture-trash").exists());
    assert!(db
        .workspace_root
        .join(".project-mind/directory-history")
        .is_dir());
}

#[cfg(unix)]
#[test]
fn directory_live_trash_rejects_parent_swap_after_retaining_history() {
    let (_temp, db, _binding, _owner, source) = setup();
    let root = db.workspace_root.clone();
    drop(db);
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "db::project_directory_changes::recovery_tests::directory_change_crash_fixture",
            "--ignored",
            "--test-threads=1",
        ])
        .env("MIND_DIRECTORY_CRASH_ROOT", &root)
        .env("MIND_DIRECTORY_CRASH_OPERATION", "trash")
        .env_remove("MIND_DIRECTORY_CRASH_STAGE")
        .env("MIND_DIRECTORY_SWAP_PARENT", source.parent().unwrap())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read(root.join("fault-retained-owner/source/known.md")).unwrap(),
        b"retained history"
    );
    assert_eq!(fs::read_dir(root.join(JOURNALS)).unwrap().count(), 1);
    assert!(!root.join("fixture-trash").exists());
}

#[test]
fn navigation_file_trash_recovers_all_process_crashes_with_source_backed_history() {
    for phase in 0..=3 {
        let (_temp, db, binding, owner, folder) = setup();
        let source = folder.join("known.md");
        let root = db.workspace_root.clone();
        let object = db
            .project_file_register(&binding.workspace_id, owner, "source/known.md")
            .unwrap()
            .object;
        let id: i64 = object.id.parse().unwrap();
        db.conn
            .execute(
                "UPDATE document_versions SET managed_path=?1 WHERE document_id=?2",
                params![db.encode_path_ref(&source), id],
            )
            .unwrap();
        let before: (i64, i64, String) = db.conn.query_row("SELECT v.id,v.version_number,h.content_hash FROM document_versions v JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        let prepared = db
            .project_navigation_trash_prepare(&binding, Some(owner), "source/known.md")
            .unwrap();
        let input = DirectoryChangeInput {
            binding,
            project_id: Some(owner),
            relative_path: "source/known.md".into(),
            token: prepared.prepared.token,
            name: None,
            confirmed: Some(true),
            request_id: "crash-request".into(),
        };
        let db_path = crate::workspace::workspace_paths(&root).db_path;
        drop(db);
        crash(&root, phase, "navigation-file");
        let db = Database::open(&db_path, &root, None).unwrap();
        assert_eq!(source.exists(), phase < 2);
        assert!(folder.join("unmanaged.bin").exists());
        if phase >= 2 {
            fs::remove_file(root.join("fixture-trash")).unwrap();
        }
        let record = db.document_record(id).unwrap();
        assert_eq!(record.health, if phase < 2 { "normal" } else { "missing" });
        let after: (i64, i64, String, String) = db.conn.query_row("SELECT v.id,v.version_number,h.content_hash,v.managed_path FROM document_versions v JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap();
        assert_eq!((after.0, after.1, after.2), before);
        assert_eq!(
            fs::read(db.decode_path_ref(&after.3)).unwrap(),
            b"retained history"
        );
        assert!(fs::read_dir(root.join(JOURNALS)).unwrap().next().is_none());
        if phase >= 2 {
            assert_eq!(
                db.project_navigation_trash_with(&input, |_| panic!(
                    "recovery receipt must replay"
                ))
                .unwrap()
                .file_ids,
                vec![id]
            );
        }
    }
}

#[test]
fn navigation_file_journal_guards_replacement_folder_file_and_ancestor_entry_points() {
    let (_temp, db, binding, owner, folder) = setup();
    let root = db.workspace_root.clone();
    let db_path = crate::workspace::workspace_paths(&root).db_path;
    let object = db
        .project_file_register(&binding.workspace_id, owner, "source/known.md")
        .unwrap()
        .object;
    let hash = db
        .project_file_resolve(&object)
        .unwrap()
        .content_hash
        .unwrap();
    drop(db);
    crash(&root, 2, "navigation-file");
    let source = folder.join("known.md");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("foreign.md"), b"replacement folder").unwrap();
    let db = Database::open(&db_path, &root, None).unwrap();
    assert!(db
        .project_navigation_trash_prepare(&binding, Some(owner), "source/known.md")
        .is_err());
    assert!(db
        .project_directory_change_prepare(&binding, Some(owner), "source")
        .is_err());
    assert!(db
        .project_file_register(&binding.workspace_id, owner, "source/known.md/foreign.md")
        .is_err());
    assert!(db
        .project_file_move(&object, "elsewhere.md", 1, &hash)
        .is_err());
    let request = crate::agent::access::RequestContext {
        binding: binding.clone(),
        request_id: "pending-file-session".into(),
        caller: crate::agent::access::Caller::Gui,
        scope_grant: crate::agent::access::ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: false,
            project_ids: vec![owner],
            operations: vec!["source.read".into(), "file.update".into()],
            object_keys: None,
        },
    };
    assert!(db
        .file_working_begin_session(&request, &binding, &object)
        .is_err());
    assert_eq!(fs::read_dir(root.join(JOURNALS)).unwrap().count(), 1);
    assert_eq!(
        fs::read(source.join("foreign.md")).unwrap(),
        b"replacement folder"
    );
    assert_eq!(
        fs::read(root.join("fixture-trash")).unwrap(),
        b"retained history"
    );
    assert!(db
        .project_file_register(&binding.workspace_id, owner, "source/unmanaged.bin")
        .is_ok());
}

#[test]
fn navigation_file_recovery_retains_conflicts_for_replaced_file_and_parent() {
    for variant in ["file", "parent"] {
        let (_temp, db, _binding, owner, folder) = setup();
        let root = db.workspace_root.clone();
        let db_path = crate::workspace::workspace_paths(&root).db_path;
        drop(db);
        crash(&root, 1, "navigation-file");
        if variant == "file" {
            fs::rename(folder.join("known.md"), root.join("retained-original")).unwrap();
            fs::write(folder.join("known.md"), b"replacement file").unwrap();
        } else {
            fs::rename(&folder, root.join("retained-parent")).unwrap();
            fs::write(&folder, b"replacement ancestor").unwrap();
        }
        let db = Database::open(&db_path, &root, None).unwrap();
        assert_eq!(fs::read_dir(root.join(JOURNALS)).unwrap().count(), 1);
        assert!(db
            .directory_require_no_pending(&folder, Some(owner))
            .is_err());
        assert!(!db.workspace_root.join("fixture-trash").exists());
    }
}

#[test]
fn directory_recovery_reads_legacy_journal_without_source_kind_or_navigation_flag() {
    let (_temp, db, _binding, _owner, source) = setup();
    let root = db.workspace_root.clone();
    let db_path = crate::workspace::workspace_paths(&root).db_path;
    drop(db);
    crash(&root, 2, "rename");
    let path = fs::read_dir(root.join(JOURNALS))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
        .join("intent.json");
    let mut json: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    json.as_object_mut().unwrap().remove("source_kind");
    json.as_object_mut().unwrap().remove("navigation_trash");
    fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();
    Database::open(&db_path, &root, None).unwrap();
    assert!(source.join("known.md").exists());
    assert!(!source.with_file_name("target").exists());
    assert!(!path.exists());
}

#[test]
fn navigation_file_crash_recovery_keeps_saved_working_blob_and_immutable_versions() {
    use crate::agent::access::{Caller, RequestContext, ScopeGrant};
    use crate::file_working::{WorkingSaveText, WorkingSession};
    for phase in 0..=3 {
        let (_temp, db, binding, owner, folder) = setup();
        let root = db.workspace_root.clone();
        let object = db
            .project_file_register(&binding.workspace_id, owner, "source/known.md")
            .unwrap()
            .object;
        let request = RequestContext {
            binding: binding.clone(),
            request_id: "working-before-crash".into(),
            caller: Caller::Gui,
            scope_grant: ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: false,
                project_ids: vec![owner],
                operations: vec!["source.read".into(), "file.update".into()],
                object_keys: None,
            },
        };
        let opened = db
            .file_working_begin_session(&request, &binding, &object)
            .unwrap();
        let session = WorkingSession {
            object: object.clone(),
            session_id: opened.session_id,
        };
        let payload = WorkingSaveText {
            object: object.clone(),
            session_id: session.session_id.clone(),
            expected_revision: opened.status.revision,
            expected_content_hash: opened.status.content_hash.clone(),
            text: "saved working recovery bytes".into(),
        };
        db.file_working_save(
            &request,
            &binding,
            &session,
            opened.status.revision,
            &opened.status.content_hash,
            &payload,
            payload.text.as_bytes(),
            1000,
        )
        .unwrap();
        db.file_working_close(&request, &binding, &session).unwrap();
        let working: (String, Vec<u8>, Option<String>) = db
            .conn
            .query_row(
                "SELECT state,bytes,journal FROM file_working_contents WHERE document_id=?1",
                [&object.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        let version: (i64, i64, String, String) = db.conn.query_row("SELECT v.id,v.version_number,h.content_hash,v.managed_path FROM document_versions v JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1", [&object.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap();
        let db_path = crate::workspace::workspace_paths(&root).db_path;
        drop(db);
        crash(&root, phase, "navigation-file");
        let db = Database::open(&db_path, &root, None).unwrap();
        let after: (String, Vec<u8>, Option<String>) = db
            .conn
            .query_row(
                "SELECT state,bytes,journal FROM file_working_contents WHERE document_id=?1",
                [&object.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(after, working);
        let version_after: (i64, i64, String, String) = db.conn.query_row("SELECT v.id,v.version_number,h.content_hash,v.managed_path FROM document_versions v JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1", [&object.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap();
        assert_eq!(version_after, version);
        assert_eq!(
            fs::read(db.decode_path_ref(&version_after.3)).unwrap(),
            b"retained history"
        );
        if phase >= 2 {
            assert_eq!(
                fs::read(root.join("fixture-trash")).unwrap(),
                b"saved working recovery bytes"
            );
        } else {
            assert_eq!(
                fs::read(folder.join("known.md")).unwrap(),
                b"saved working recovery bytes"
            );
        }
    }
}
