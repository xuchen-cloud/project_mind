use super::*;
use std::process::Command;

fn update(id: i64) -> ProjectUpdateInput {
    ProjectUpdateInput {
        project_id: id,
        name: Some("After".into()),
        summary: String::new(),
        summary_markdown: None,
        summary_html: None,
        summary_code_language: None,
        status: None,
    }
}

#[test]
#[ignore = "subprocess helper"]
fn project_root_rename_crash_child() {
    let root = PathBuf::from(std::env::var_os("MIND_PROJECT_ROOT_FIXTURE").unwrap());
    let (_, paths) = crate::workspace::load_metadata(&root).unwrap();
    let db = Database::open(&paths.db_path, &root, None).unwrap();
    db.project_update(update(1)).unwrap();
}

#[test]
fn project_root_rename_recovers_after_real_kill() {
    for stage in [0, 1, 2, 3, 4] {
        let root = tempfile::tempdir().unwrap();
        let (_, paths) = crate::workspace::create_workspace(root.path(), "test-password").unwrap();
        let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Before".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        fs::write(
            Path::new(&project.root_path).join("sentinel"),
            "original bytes",
        )
        .unwrap();
        let external = tempfile::tempdir().unwrap();
        let source = external.path().join("file.md");
        fs::write(&source, "registered bytes").unwrap();
        let file = db
            .document_import(DocumentImportInput {
                project_id: Some(project.id),
                source_path: source.to_string_lossy().into(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        let versions_before = db.fetch_document_versions(file.id).unwrap();
        let (target, media) =
            super::project_root_rename_record_tests::initialize_media(&mut db, project.id);
        let hashes_before: Vec<(i64, String)> = db.conn.prepare("SELECT document_version_id,content_hash FROM source_file_version_hashes ORDER BY document_version_id").unwrap().query_map([], |r| Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        let watermark = db.committed_change_watermark().unwrap();
        drop(db);
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "db::project_root_rename_recovery_tests::project_root_rename_crash_child",
                "--ignored",
            ])
            .env("MIND_PROJECT_ROOT_FIXTURE", root.path())
            .env("MIND_PROJECT_ROOT_CRASH_STAGE", stage.to_string())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(status.signal(), Some(9));
        }
        let db = Database::open(&paths.db_path, root.path(), None).unwrap();
        let actual = db.project_record(project.id).unwrap();
        assert!(
            Path::new(&actual.root_path).is_dir(),
            "stage {stage}: DB root missing after reopen"
        );
        assert_eq!(
            fs::read_to_string(Path::new(&actual.root_path).join("sentinel")).unwrap(),
            "original bytes"
        );
        assert_eq!(actual.name, if stage == 4 { "After" } else { "Before" });
        assert_eq!(
            db.committed_change_watermark().unwrap(),
            watermark + if stage == 4 { 2 } else { 0 }
        );
        let file_after = db.document_record(file.id).unwrap();
        assert!(Path::new(&file_after.managed_path).starts_with(&actual.root_path));
        assert_eq!(
            fs::read_to_string(&file_after.managed_path).unwrap(),
            "registered bytes"
        );
        let versions_after = db.fetch_document_versions(file.id).unwrap();
        assert_eq!(versions_after.len(), versions_before.len());
        for (before, after) in versions_before.iter().zip(&versions_after) {
            assert_eq!(before.id, after.id);
            assert_eq!(before.version_number, after.version_number);
            assert_eq!(fs::read(&after.managed_path).unwrap(), b"registered bytes");
        }
        let hashes_after: Vec<(i64, String)> = db.conn.prepare("SELECT document_version_id,content_hash FROM source_file_version_hashes ORDER BY document_version_id").unwrap().query_map([], |r| Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        assert_eq!(hashes_before, hashes_after);
        let head = db.record_document_head(&target).unwrap().unwrap();
        assert_eq!(head.projection.body_hash, media.body_hash);
        let html = db
            .record_version_editor_html(&target, &head.projection)
            .unwrap();
        assert!(html.contains(
            &Path::new(&actual.root_path)
                .join("assets/图片.png")
                .to_string_lossy()
                .to_string()
        ));
        assert_eq!(
            fs::read_to_string(Path::new(&actual.root_path).join("assets/文件.pdf")).unwrap(),
            "retained-attachment"
        );
        let mut foreign = media.document.clone();
        foreign["content"][2]["attrs"]["path"] = serde_json::json!("Other/assets/foreign.png");
        assert_eq!(
            db.record_document_from_gui(&target, &foreign)
                .unwrap_err()
                .code,
            crate::agent::errors::ErrorCode::ScopeDenied
        );
        // Recovery is idempotent across another open.
        drop(db);
        assert_eq!(
            Database::open(&paths.db_path, root.path(), None)
                .unwrap()
                .project_record(project.id)
                .unwrap()
                .name,
            actual.name
        );
    }
}

#[test]
fn project_root_rename_recovery_preserves_external_occupant() {
    let root = tempfile::tempdir().unwrap();
    let (_, paths) = crate::workspace::create_workspace(root.path(), "test-password").unwrap();
    let db = Database::open(&paths.db_path, root.path(), None).unwrap();
    let project = db
        .project_create(ProjectCreateInput {
            name: "Before".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    fs::write(
        Path::new(&project.root_path).join("sentinel"),
        "original bytes",
    )
    .unwrap();
    drop(db);
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "db::project_root_rename_recovery_tests::project_root_rename_crash_child",
            "--ignored",
        ])
        .env("MIND_PROJECT_ROOT_FIXTURE", root.path())
        .env("MIND_PROJECT_ROOT_CRASH_STAGE", "2")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(!status.success());
    fs::create_dir(&project.root_path).unwrap();
    fs::write(
        Path::new(&project.root_path).join("external"),
        "do not overwrite",
    )
    .unwrap();
    assert!(
        Database::open(&paths.db_path, root.path(), None).is_err(),
        "a conflicting root must retain recovery evidence and refuse opening"
    );
    assert_eq!(
        fs::read_to_string(Path::new(&project.root_path).join("external")).unwrap(),
        "do not overwrite"
    );
    let moved = root.path().join(project_directory_name("After").unwrap());
    assert_eq!(
        fs::read_to_string(moved.join("sentinel")).unwrap(),
        "original bytes"
    );
    // Remove only this fixture's known external occupant, then retry recovery.
    fs::remove_file(Path::new(&project.root_path).join("external")).unwrap();
    fs::remove_dir(&project.root_path).unwrap();
    let db = Database::open(&paths.db_path, root.path(), None).unwrap();
    assert!(Path::new(&db.project_record(project.id).unwrap().root_path)
        .join("sentinel")
        .is_file());
}

#[test]
fn project_root_rename_closed_workspace_cannot_mutate_directory() {
    let root = tempfile::tempdir().unwrap();
    let (_, paths) = crate::workspace::create_workspace(root.path(), "test-password").unwrap();
    let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
    let project = db
        .project_create(ProjectCreateInput {
            name: "Before".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let fence = std::sync::Arc::new(crate::workspace_commit_fence::WorkspaceCommitFence::new());
    db.bind_file_commit_fence(fence.clone());
    fence.invalidate();
    assert!(db.project_update(update(project.id)).is_err());
    assert!(Path::new(&project.root_path).is_dir());
    assert_eq!(db.project_record(project.id).unwrap().name, "Before");
}
