use super::*;

#[test]
fn workspace_chat_is_owned_by_main_window_and_distinct_from_projects() {
    assert!(authorize_scope_label("main", None).is_ok());
    assert!(authorize_scope_label("main", Some(7)).is_ok());
    assert!(authorize_scope_label("project-7", Some(7)).is_ok());
    assert!(authorize_scope_label("project-7", None).is_err());
    assert!(authorize_scope_label("project-7", Some(8)).is_err());
    assert!(authorize_scope_label("other", None).is_err());
    assert!(authorize_scope_label("main", Some(0)).is_err());
    assert!(authorize_scope_label("main", Some(-1)).is_err());
}

#[test]
fn workspace_history_is_stable_separate_and_preserves_existing_project_paths() {
    let data = tempfile::tempdir().unwrap();
    let workspace = runtime_data_directory(data.path(), "workspace-a", None).unwrap();
    let project = runtime_data_directory(data.path(), "workspace-a", Some(7)).unwrap();
    assert_eq!(
        workspace,
        data.path().join("projects/workspace-a/workspace")
    );
    assert_eq!(project, data.path().join("projects/workspace-a/7"));
    assert_eq!(
        project,
        project_data_directory(data.path(), "workspace-a", 7).unwrap()
    );
    assert_ne!(
        workspace,
        runtime_data_directory(data.path(), "workspace-b", None).unwrap()
    );
    assert!(runtime_data_directory(data.path(), "../escape", None).is_err());
    assert!(runtime_data_directory(data.path(), "workspace-a", Some(0)).is_err());
}

#[test]
fn workspace_identity_uses_workspace_directory_and_registered_project_file_ownership() {
    let root = tempfile::tempdir().unwrap();
    let identity = Identity {
        workspace_id: "workspace-a".into(),
        workspace_generation: "open-a".into(),
        root: root.path().to_path_buf(),
        fingerprint: "model-a".into(),
        context: AssistantContext::Workspace {
            directory: root.path().to_path_buf(),
        },
    };
    assert_eq!(identity.project_id(), None);
    assert_eq!(identity.directory(), root.path());
    assert!(identity.project().is_err());
    let mut db = crate::db::Database::open(&root.path().join("workspace.sqlite"), root.path(), None)
        .unwrap();
    db.bind_native_workspace("workspace-a").unwrap();
    let project = db.project_create(crate::models::ProjectCreateInput {
        name: "Registered".into(), summary: None, status: None,
    }).unwrap();
    let file = std::path::Path::new(&project.root_path).join("file.txt");
    std::fs::write(&file, "registered Project content").unwrap();
    let binding = crate::agent::models::WorkspaceBinding {
        workspace_id: "workspace-a".into(),
        generation: "open-a".into(),
    };
    assert!(source_file_input(&db, &identity, &binding, file.to_str(), None).is_ok());
    assert!(source_file_input(&db, &identity, &binding, Some("unknown-project/file.txt"), None).is_err());
    assert!(identity.matches_workspace(&binding, root.path()));
    assert!(!identity.matches_workspace(
        &crate::agent::models::WorkspaceBinding {
            generation: "open-b".into(),
            ..binding
        },
        root.path()
    ));
}

#[cfg(unix)]
#[test]
fn workspace_directory_alias_is_resolved_and_retargeting_invalidates_the_runtime() {
    let root = tempfile::tempdir().unwrap();
    let first = root.path().join("first");
    let second = root.path().join("second");
    let alias = root.path().join("workspace");
    std::fs::create_dir(&first).unwrap();
    std::fs::create_dir(&second).unwrap();
    std::os::unix::fs::symlink(&first, &alias).unwrap();
    let identity = Identity {
        workspace_id: "workspace-a".into(),
        workspace_generation: "open-a".into(),
        root: alias.clone(),
        fingerprint: "model-a".into(),
        context: AssistantContext::Workspace {
            directory: alias.canonicalize().unwrap(),
        },
    };
    let mut db = crate::db::Database::open(&first.join("workspace.sqlite"), &first, None).unwrap();
    assert!(identity.validate_context(&mut db, &alias).is_ok());
    std::fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink(&second, &alias).unwrap();
    assert!(identity.validate_context(&mut db, &alias).is_err());
}
