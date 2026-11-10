//! WP04 compatibility and physical-parent recovery boundaries.
use super::*;
use std::{cell::RefCell, rc::Rc};

fn pending_journal(db: &Database, id: i64) -> Option<String> {
    db.conn
        .query_row(
            "SELECT journal FROM file_working_contents WHERE document_id=?1",
            [id],
            |row| row.get(0),
        )
        .unwrap()
}

fn journal_path(db: &Database, journal: &serde_json::Value, key: &str) -> PathBuf {
    db.decode_path_ref(journal[key].as_str().unwrap())
}

fn legacy_recovery_at(stage: u8) {
    let mut f = fixture();
    let (_, initial) = session(&f);
    let before = history(&mut f);
    let archived: Vec<_> = before
        .iter()
        .map(|version| {
            let path = PathBuf::from(&version.managed_path);
            let bytes = fs::read(&path).unwrap();
            (path, bytes)
        })
        .collect();
    let mut journal = serde_json::to_value(inject_working_journal(&f)).unwrap();
    // Exercise the actual old wire format, rather than placement: null.
    journal.as_object_mut().unwrap().remove("placement");
    assert!(journal.get("placement").is_none());
    let id = f.object.id.parse::<i64>().unwrap();
    f.db.conn
        .execute(
            "UPDATE file_working_contents SET journal=?1 WHERE document_id=?2",
            params![serde_json::to_string(&journal).unwrap(), id],
        )
        .unwrap();
    let target = journal_path(&f.db, &journal, "target");
    let staged = journal_path(&f.db, &journal, "staged");
    let backup = journal_path(&f.db, &journal, "backup");
    // Valid-looking names belonging to another transaction must not be swept.
    let unrelated = staged
        .parent()
        .unwrap()
        .join(format!("working-new-{}", files::token()));
    fs::write(&unrelated, b"unrelated staged bytes").unwrap();
    let outside = tempfile::tempdir().unwrap();
    let external = outside.path().join("external.md");
    fs::write(&external, b"external bytes").unwrap();
    let external_identity = files::path_identity(&external).unwrap();

    if stage >= 2 {
        fs::rename(&target, &backup).unwrap();
    }
    if stage >= 3 {
        fs::rename(&staged, &target).unwrap();
    }
    if stage == 4 {
        // Model the durable state/BLOB commit; receipts are tested by the
        // existing actual SIGKILL suite, not fabricated by this legacy fixture.
        f.db.conn
            .execute(
                "UPDATE file_working_contents SET state=?1,bytes=?2 WHERE document_id=?3",
                params![
                    serde_json::to_string(&journal["new"]).unwrap(),
                    b"prepared replacement".as_slice(),
                    id
                ],
            )
            .unwrap();
        f.db.conn
            .execute(
                "UPDATE project_directory_files SET physical_identity=?1 WHERE document_id=?2",
                params![
                    serde_json::to_string(&journal["new"]["identity"]).unwrap(),
                    id
                ],
            )
            .unwrap();
    }

    // Direct per-object recovery must succeed; global recovery can deliberately
    // isolate conflicts and is therefore insufficient as a success assertion.
    f.db.working_recover_locked(&f.object).unwrap();
    assert!(pending_journal(&f.db, id).is_none());
    let expected = if stage == 4 {
        b"prepared replacement".as_slice()
    } else {
        b"original".as_slice()
    };
    assert_eq!(fs::read(&target).unwrap(), expected);
    assert!(!staged.exists());
    assert!(!backup.exists());
    let status =
        f.db.file_working_open_status(&f.request, &f.binding, &f.object)
            .unwrap();
    assert_eq!(status.revision, initial.revision + i64::from(stage == 4));
    let saved_bytes: Vec<u8> =
        f.db.conn
            .query_row(
                "SELECT bytes FROM file_working_contents WHERE document_id=?1",
                [id],
                |row| row.get(0),
            )
            .unwrap();
    assert_eq!(saved_bytes, expected);
    assert_eq!(
        serde_json::to_value(history(&mut f)).unwrap(),
        serde_json::to_value(before).unwrap()
    );
    for (path, bytes) in archived {
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
    assert_eq!(fs::read(unrelated).unwrap(), b"unrelated staged bytes");
    assert_eq!(fs::read(&external).unwrap(), b"external bytes");
    assert_eq!(files::path_identity(&external).unwrap(), external_identity);
    // A second scan is idempotent and leaves the same external artifacts alone.
    f.db.working_recover_locked(&f.object).unwrap();
    assert_eq!(fs::read(&target).unwrap(), expected);
}

#[test]
fn legacy_journal_without_placement_recovers_prepared() {
    legacy_recovery_at(1);
}

#[test]
fn legacy_journal_without_placement_recovers_original_moved() {
    legacy_recovery_at(2);
}

#[test]
fn legacy_journal_without_placement_recovers_new_placed() {
    legacy_recovery_at(3);
}

#[test]
fn legacy_journal_without_placement_recovers_committed() {
    legacy_recovery_at(4);
}

struct ResetStageHook;
impl Drop for ResetStageHook {
    fn drop(&mut self) {
        WORKING_STAGE_HOOK.with(|hook| *hook.borrow_mut() = None);
    }
}

struct SwapEvidence {
    journal: String,
    target: PathBuf,
    staged: PathBuf,
    backup: PathBuf,
    target_identity: files::FileIdentity,
    staged_identity: files::FileIdentity,
    parked_foreign: PathBuf,
    replacement_foreign: PathBuf,
}

fn swapped_parent_preserves_artifacts(replace_with_symlink: bool) {
    let mut f = moved_fixture();
    let (s, initial) = session(&f);
    let before = history(&mut f);
    let archived: Vec<_> = before
        .iter()
        .map(|v| (v.managed_path.clone(), fs::read(&v.managed_path).unwrap()))
        .collect();
    let root = f.root.clone();
    let db_path = f.db_path.clone();
    let id = f.object.id.parse::<i64>().unwrap();
    let evidence = Rc::new(RefCell::new(None));
    let captured = evidence.clone();
    let _reset = ResetStageHook;
    WORKING_STAGE_HOOK.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move |stage| {
            if stage != 1 {
                return;
            }
            // Read the durable production journal without triggering recovery.
            let db = Database::open_runtime_connection(&db_path, &root, None).unwrap();
            let raw = pending_journal(&db, id).unwrap();
            let journal: serde_json::Value = serde_json::from_str(&raw).unwrap();
            assert!(
                journal["placement"].is_object(),
                "new save must record placement"
            );
            let target = journal_path(&db, &journal, "target");
            let staged = journal_path(&db, &journal, "staged");
            let backup = journal_path(&db, &journal, "backup");
            assert_eq!(backup.parent(), staged.parent());
            let parent = target.parent().unwrap().to_path_buf();
            assert_eq!(staged.parent(), Some(parent.as_path()));
            let parked = parent.with_file_name(format!("parked-parent-{}", files::token()));
            let target_identity = files::path_identity(&target).unwrap();
            let staged_identity = files::path_identity(&staged).unwrap();
            fs::rename(&parent, &parked).unwrap();
            if replace_with_symlink {
                #[cfg(unix)]
                std::os::unix::fs::symlink(&parked, &parent).unwrap();
                #[cfg(not(unix))]
                unreachable!("symlink fixture is Unix-only");
            } else {
                fs::create_dir(&parent).unwrap();
                // Preserve File identities while replacing their physical parent.
                for entry in fs::read_dir(&parked).unwrap() {
                    let entry = entry.unwrap();
                    fs::rename(entry.path(), parent.join(entry.file_name())).unwrap();
                }
            }
            let parked_foreign = parked.join("parked-foreign.md");
            let replacement_foreign = parent.join("replacement-foreign.md");
            fs::write(&parked_foreign, b"foreign in original parent").unwrap();
            fs::write(&replacement_foreign, b"foreign in replacement parent").unwrap();
            assert_eq!(files::path_identity(&target).unwrap(), target_identity);
            assert_eq!(files::path_identity(&staged).unwrap(), staged_identity);
            *captured.borrow_mut() = Some(SwapEvidence {
                journal: raw,
                target,
                staged,
                backup,
                target_identity,
                staged_identity,
                parked_foreign,
                replacement_foreign,
            });
        }));
    });
    let result = save(&f, &s, &initial, "new owned bytes", "parent-swap", 1000);
    drop(_reset);
    assert!(
        result.is_err(),
        "save accepted a physically replaced parent"
    );
    let e = evidence.borrow_mut().take().expect("stage 1 was reached");
    for _ in 0..2 {
        assert!(
            f.db.working_recover_locked(&f.object).is_err(),
            "recovery accepted a replaced parent"
        );
        assert_eq!(
            pending_journal(&f.db, id).as_deref(),
            Some(e.journal.as_str())
        );
        assert_eq!(fs::read(&e.target).unwrap(), b"original");
        assert_eq!(fs::read(&e.staged).unwrap(), b"new owned bytes");
        assert!(!e.backup.exists());
        assert_eq!(files::path_identity(&e.target).unwrap(), e.target_identity);
        assert_eq!(files::path_identity(&e.staged).unwrap(), e.staged_identity);
        assert_eq!(
            fs::read(&e.parked_foreign).unwrap(),
            b"foreign in original parent"
        );
        assert_eq!(
            fs::read(&e.replacement_foreign).unwrap(),
            b"foreign in replacement parent"
        );
    }
    assert_eq!(
        f.db.working_state(id).unwrap().unwrap().revision,
        initial.revision
    );
    assert_eq!(
        serde_json::to_value(history(&mut f)).unwrap(),
        serde_json::to_value(before).unwrap()
    );
    for (path, bytes) in archived {
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}

#[test]
fn new_journal_rejects_live_parent_swap_even_with_same_owned_files() {
    swapped_parent_preserves_artifacts(false);
}

#[test]
#[cfg(unix)]
fn new_journal_rejects_symlink_parent_even_with_same_owned_files() {
    swapped_parent_preserves_artifacts(true);
}

#[test]
fn new_journal_does_not_clobber_foreign_backup_or_staging_occupant() {
    for boundary in [1, 3] {
        let f = moved_fixture();
        let (s, initial) = session(&f);
        let db_path = f.db_path.clone();
        let root = f.root.clone();
        let id = f.object.id.parse::<i64>().unwrap();
        let occupied = Rc::new(RefCell::new(None));
        let captured = occupied.clone();
        let reset = ResetStageHook;
        WORKING_STAGE_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move |stage| {
                if stage == boundary {
                    let db = Database::open_runtime_connection(&db_path, &root, None).unwrap();
                    let raw = pending_journal(&db, id).unwrap();
                    let journal = serde_json::from_str(&raw).unwrap();
                    let key = if boundary == 1 { "backup" } else { "staged" };
                    let path = journal_path(&db, &journal, key);
                    assert!(!path.exists());
                    fs::write(&path, b"external occupant").unwrap();
                    *captured.borrow_mut() = Some((raw, path));
                }
            }));
        });
        assert!(save(&f, &s, &initial, "new owned bytes", "occupied", 1000).is_err());
        drop(reset);
        let (raw, path) = occupied.borrow_mut().take().unwrap();
        assert!(f.db.working_recover_locked(&f.object).is_err());
        assert_eq!(pending_journal(&f.db, id).as_deref(), Some(raw.as_str()));
        assert_eq!(fs::read(&path).unwrap(), b"external occupant");
        assert_eq!(
            fs::read(&f.path).unwrap(),
            if boundary == 1 {
                b"original".as_slice()
            } else {
                b"new owned bytes".as_slice()
            }
        );
        assert_eq!(
            f.db.working_state(id).unwrap().unwrap().revision,
            initial.revision + i64::from(boundary == 3)
        );
        let witness = path.with_extension("preserved");
        fs::rename(&path, &witness).unwrap();
        f.db.working_recover_locked(&f.object).unwrap();
        assert!(pending_journal(&f.db, id).is_none());
        // An occupation after placement does not invalidate the live bytes or
        // the atomic SQL receipt. Cleanup must preserve that committed result.
        assert_eq!(
            fs::read(&f.path).unwrap(),
            if boundary == 3 {
                b"new owned bytes".as_slice()
            } else {
                b"original".as_slice()
            }
        );
        assert_eq!(fs::read(witness).unwrap(), b"external occupant");
        let saved = save(&f, &s, &initial, "new owned bytes", "occupied", 1000).unwrap();
        assert_eq!(saved.revision, initial.revision + 1);
        assert_eq!(fs::read(&f.path).unwrap(), b"new owned bytes");
    }
}

#[test]
fn moved_legacy_prepared_journal_recovers_on_startup_without_cross_volume_rename() {
    struct ResetVolume;
    impl Drop for ResetVolume {
        fn drop(&mut self) {
            WORKING_TEST_HISTORY_VOLUME.with(|volume| *volume.borrow_mut() = None);
        }
    }
    let mut f = moved_fixture();
    let (_, initial) = session(&f);
    let before = history(&mut f);
    let journal = inject_working_journal(&f);
    let history_dir =
        f.db.decode_path_ref(&journal.staged)
            .parent()
            .unwrap()
            .to_owned();
    WORKING_TEST_HISTORY_VOLUME.with(|volume| *volume.borrow_mut() = Some(history_dir));
    let _reset = ResetVolume;
    drop(f.db);
    f.db = Database::open(&f.db_path, &f.root, None).unwrap();
    f.db.bind_native_workspace(&f.binding.workspace_id).unwrap();
    assert!(pending_journal(&f.db, f.object.id.parse().unwrap()).is_none());
    assert!(!f.db.decode_path_ref(&journal.staged).exists());
    assert_eq!(fs::read(&f.path).unwrap(), b"original");
    let reopened =
        f.db.file_working_open_status(&f.request, &f.binding, &f.object)
            .unwrap();
    assert_eq!(reopened.revision, initial.revision);
    assert_eq!(
        serde_json::to_value(history(&mut f)).unwrap(),
        serde_json::to_value(before).unwrap()
    );
}
