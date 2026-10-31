use super::*;
const ID: &str = "0123456789abcdef0123456789abcdef";
const OTHER: &str = "fedcba9876543210fedcba9876543210";
fn token() -> String {
    "a".repeat(64)
}
#[test]
fn persistence_overwrite_delete_and_independent_grants() {
    let temp = tempfile::tempdir().unwrap();
    let store = FileCredentialStore::new(temp.path().join("credentials"));
    assert_eq!(store.load_optional(ID).unwrap(), None);
    assert_eq!(store.load(ID).unwrap_err().code, ErrorCode::ScopeDenied);
    store.save(ID, &token()).unwrap();
    store.save(OTHER, &"b".repeat(64)).unwrap();
    let reopened = FileCredentialStore::new(temp.path().join("credentials"));
    assert_eq!(reopened.load(ID).unwrap(), token());
    reopened.save(ID, &"c".repeat(64)).unwrap();
    assert_eq!(store.load(ID).unwrap(), "c".repeat(64));
    store.delete(ID).unwrap();
    store.delete(ID).unwrap();
    assert_eq!(store.load_optional(ID).unwrap(), None);
    assert_eq!(store.load(OTHER).unwrap(), "b".repeat(64));
}
#[test]
fn rejects_invalid_and_malformed_inputs_without_disclosing_tokens() {
    let temp = tempfile::tempdir().unwrap();
    let store = FileCredentialStore::new(temp.path().join("credentials"));
    for id in ["../escape", "", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"] {
        assert_eq!(
            store.save(id, &token()).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
        assert!(store.load_optional(id).is_err());
        assert!(store.delete(id).is_err());
    }
    assert!(store.save(ID, "secret-invalid-token").is_err());
    store.save(ID, &token()).unwrap();
    std::fs::write(store.directory.join(ID), "secret-malformed").unwrap();
    let error = store.load_optional(ID).unwrap_err();
    assert_eq!(error.code, ErrorCode::IoFailed);
    assert!(!error.message.contains("secret-malformed"));
    std::fs::remove_file(store.directory.join(ID)).unwrap();
    std::fs::create_dir(store.directory.join(ID)).unwrap();
    assert!(store.load_optional(ID).is_err());
    assert!(store.save(ID, &token()).is_err());
    assert!(store.delete(ID).is_err());
}
#[cfg(unix)]
#[test]
fn private_permissions_and_symlink_boundaries() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let temp = tempfile::tempdir().unwrap();
    let store = FileCredentialStore::new(temp.path().join("credentials"));
    store.save(ID, &token()).unwrap();
    assert_eq!(
        std::fs::metadata(&store.directory)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(store.directory.join(ID))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    std::fs::set_permissions(
        store.directory.join(ID),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert!(store.load_optional(ID).is_err());
    std::fs::remove_file(store.directory.join(ID)).unwrap();
    let target = temp.path().join("target");
    std::fs::write(&target, token()).unwrap();
    symlink(&target, store.directory.join(ID)).unwrap();
    assert!(store.load_optional(ID).is_err());
    assert!(store.save(ID, &token()).is_err());
    assert!(store.delete(ID).is_err());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), token());
    let linked = temp.path().join("linked");
    symlink(&store.directory, &linked).unwrap();
    assert!(FileCredentialStore::new(linked)
        .load_optional(OTHER)
        .is_err());
    std::fs::set_permissions(&store.directory, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(store.load_optional(OTHER).is_err());
}

#[test]
fn io_failures_are_not_missing_credentials() {
    let temp = tempfile::tempdir().unwrap();
    let blocker = temp.path().join("blocker");
    std::fs::write(&blocker, "file").unwrap();
    let store = FileCredentialStore::new(blocker.join("credentials"));
    assert_eq!(
        store.load_optional(ID).unwrap_err().code,
        ErrorCode::IoFailed
    );
    assert!(store.save(ID, &token()).is_err());
    assert!(store.delete(ID).is_err());
}

#[test]
fn saves_before_application_data_parent_exists() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("missing/app-data/connection-credentials");
    let store = FileCredentialStore::new(&directory);
    assert!(!directory.parent().unwrap().exists());
    assert_eq!(store.load_optional(ID).unwrap(), None);
    store.save(ID, &token()).unwrap();
    assert_eq!(store.load(ID).unwrap(), token());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(directory.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}
