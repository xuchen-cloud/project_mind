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
    let token = db
        .project_directory_change_prepare(&binding, Some(project), "source")
        .unwrap()
        .token;
    let input = DirectoryChangeInput {
        binding,
        project_id: Some(project),
        relative_path: "source".into(),
        token,
        name: (std::env::var("MIND_DIRECTORY_CRASH_OPERATION").unwrap() == "rename")
            .then(|| "target".into()),
        confirmed: Some(true),
        request_id: "crash-request".into(),
    };
    db.project_directory_change_with(&input, |source| {
        files::move_exclusive(source, &root.join("fixture-trash"))
    })
    .unwrap();
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
