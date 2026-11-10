//! Issue #300 / G08: real Database and filesystem API regressions.
//! The sibling Trash fixture checks native call arguments and retained data;
//! it does not stand in for OS Trash acceptance. Run the ignored test manually
//! to exercise trash::delete. Crash stages live in the separate recovery tests.
use super::*;
use crate::{
    agent::{
        access::{Caller, RequestContext, ScopeGrant},
        file_tools::FileVersionsListInput,
    },
    db::project_directory_files::FileBytesInput,
    file_working::{WorkingSaveText, WorkingSession, WorkingStatus},
    models::ProjectCreateInput,
};
use base64::{engine::general_purpose::STANDARD, Engine};

struct Fixture {
    temp: tempfile::TempDir,
    db: Database,
    db_path: PathBuf,
    workspace: PathBuf,
    root: PathBuf,
    owner: Option<i64>,
    binding: WorkspaceBinding,
    request: RequestContext,
}

fn fixture(project: bool) -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let workspace = workspace.canonicalize().unwrap();
    let (metadata, paths) = crate::workspace::create_workspace(&workspace, "password").unwrap();
    let mut db = Database::open(&paths.db_path, &workspace, None).unwrap();
    db.bind_native_workspace(&metadata.workspace_id).unwrap();
    let owner = project.then(|| {
        db.project_create(ProjectCreateInput {
            name: "Directory changes".into(),
            summary: None,
            status: None,
        })
        .unwrap()
        .id
    });
    let root = db.ensure_file_scope_root(owner).unwrap();
    let binding = WorkspaceBinding {
        workspace_id: metadata.workspace_id,
        generation: "directory-tests".into(),
    };
    let request = RequestContext {
        binding: binding.clone(),
        request_id: "directory-working".into(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: owner.is_none(),
            project_ids: owner.into_iter().collect(),
            operations: vec!["source.read".into(), "file.update".into()],
            object_keys: None,
        },
    };
    Fixture {
        temp,
        db,
        db_path: paths.db_path,
        workspace,
        root,
        owner,
        binding,
        request,
    }
}

fn register(f: &Fixture, relative: &str, bytes: &[u8]) -> ObjectRef {
    let path = f.root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
    f.db.project_file_register(&f.binding.workspace_id, f.owner, relative)
        .unwrap()
        .object
}

fn prepare(f: &Fixture, relative: &str) -> PreparedDirectoryChange {
    f.db.project_directory_change_prepare(&f.binding, f.owner, relative)
        .unwrap()
}

fn input(
    f: &Fixture,
    prepared: &PreparedDirectoryChange,
    name: Option<&str>,
    id: &str,
) -> DirectoryChangeInput {
    DirectoryChangeInput {
        binding: f.binding.clone(),
        project_id: f.owner,
        relative_path: prepared.relative_path.clone(),
        token: prepared.token.clone(),
        name: name.map(str::to_owned),
        confirmed: name.is_none().then_some(true),
        request_id: id.into(),
    }
}

fn rename(f: &Fixture, input: &DirectoryChangeInput) -> Result<DirectoryChangeResult> {
    f.db.project_directory_change_with(input, |_| panic!("rename must not invoke Trash"))
}

fn assert_code<T: std::fmt::Debug>(result: Result<T>, code: &str) {
    assert_eq!(FileServiceError::from_error(result.unwrap_err()).code, code);
}

fn open(f: &Fixture, object: &ObjectRef) -> (WorkingSession, WorkingStatus) {
    let opened =
        f.db.file_working_begin_session(&f.request, &f.binding, object)
            .unwrap();
    (
        WorkingSession {
            object: object.clone(),
            session_id: opened.session_id,
        },
        opened.status,
    )
}

fn save(
    f: &Fixture,
    session: &WorkingSession,
    status: &WorkingStatus,
    text: &str,
    id: &str,
) -> WorkingStatus {
    let mut request = f.request.clone();
    request.request_id = id.into();
    let payload = WorkingSaveText {
        object: session.object.clone(),
        session_id: session.session_id.clone(),
        expected_revision: status.revision,
        expected_content_hash: status.content_hash.clone(),
        text: text.into(),
    };
    f.db.file_working_save(
        &request,
        &f.binding,
        session,
        status.revision,
        &status.content_hash,
        &payload,
        text.as_bytes(),
        1000,
    )
    .unwrap()
}

fn close(f: &Fixture, session: &WorkingSession) {
    f.db.file_working_close(&f.request, &f.binding, session)
        .unwrap();
}

fn working_bytes(f: &Fixture, object: &ObjectRef) -> (String, Vec<u8>, Option<String>) {
    f.db.conn
        .query_row(
            "SELECT state,bytes,journal FROM file_working_contents WHERE document_id=?1",
            [&object.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
}

#[derive(Debug, PartialEq, Eq)]
struct RetainedVersion {
    id: String,
    number: u32,
    hash: String,
    bytes: Vec<u8>,
}

fn versions(f: &Fixture, object: &ObjectRef) -> Vec<RetainedVersion> {
    let page =
        f.db.file_read_versions_list(
            &f.request,
            &f.binding,
            &FileVersionsListInput {
                object: object.clone(),
                cursor: None,
                limit: Some(100),
            },
        )
        .unwrap();
    assert!(page.next_cursor.is_none());
    page.versions
        .into_iter()
        .map(|version| {
            let hash = version.content_hash.unwrap();
            let bytes =
                f.db.project_file_read_bytes(&FileBytesInput {
                    object: object.clone(),
                    version_number: version.version_number,
                    expected_content_hash: hash.clone(),
                })
                .unwrap();
            RetainedVersion {
                id: version.id,
                number: version.version_number,
                hash,
                bytes: STANDARD.decode(bytes.base64).unwrap(),
            }
        })
        .collect()
}

// Two immutable versions plus distinct, saved but unarchived current bytes.
fn rich_file(f: &Fixture) -> (ObjectRef, WorkingStatus) {
    let object = register(f, "folder/nested/note.md", b"version one");
    let (session, initial) = open(f, &object);
    save(f, &session, &initial, "version two", "save-v2");
    let archived =
        f.db.file_working_archive(&f.request, &f.binding, &object, 2000, true)
            .unwrap();
    assert_eq!(archived.archived_version_number, 2);
    let current = save(
        f,
        &session,
        &archived,
        "working bytes not archived",
        "save-working",
    );
    assert!(current.pending_archive);
    close(f, &session);
    (object, current)
}

fn count(f: &Fixture, table: &str) -> i64 {
    f.db.conn
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

#[test]
fn g13_directory_changes_preserve_history_after_file_owner_move() {
    let mut f = fixture(true);
    let (object, _) = rich_file(&f);
    let prepared = prepare(&f, "folder");
    let before = versions(&f, &object);
    let destination = f.db.project_create(ProjectCreateInput {
        name: "Moved file owner".into(),
        summary: None,
        status: None,
    }).unwrap().id;
    let mut request = f.request.clone();
    request.request_id = "directory-file-owner-move".into();
    request.scope_grant.project_ids.push(destination);
    request.scope_grant.operations.push("file.move".into());
    let id = object.id.parse().unwrap();
    let baseline = f.db.file_owner_move_baseline(&request, &f.binding, id, f.owner).unwrap();
    f.db.file_owner_move(&request, &f.binding, &crate::db::file_owner_move::FileOwnerMove {
        document_id: id,
        source_owner: f.owner,
        target_owner: Some(destination),
        expected_version: baseline.expected_version,
        expected_working_revision: baseline.expected_working_revision,
        expected_hash: baseline.expected_hash,
    }).unwrap();
    assert!(f.db.project_directory_change_prepare(&f.binding, f.owner, "folder").is_err());
    for name in [Some("renamed"), None] {
        let change = input(&f, &prepared, name, "stale-directory-after-move");
        assert!(f.db.project_directory_change_with(&change, |_| panic!("retained history must not reach Trash")).is_err());
    }
    assert!(f.root.join("folder").exists());
    assert!(!f.root.join("renamed").exists());
    f.request = request;
    let moved = ObjectRef {
        scope: crate::agent::models::Scope::Project { project_id: destination },
        ..object
    };
    // Moving can archive the saved working head; every earlier version stays byte-exact.
    let after = versions(&f, &moved);
    for version in before {
        assert!(after.contains(&version));
    }
}

fn reopen(f: &mut Fixture) {
    // Release the old connection before opening a replacement.
    let replacement = Database::open(&f.db_path, &f.workspace, None).unwrap();
    f.db = replacement;
    f.db.bind_native_workspace(&f.binding.workspace_id).unwrap();
}

#[test]
fn directory_changes_empty_database_can_prepare_and_rename_unregistered_folder_for_both_owners() {
    for project in [false, true] {
        let f = fixture(project);
        fs::create_dir_all(f.root.join("folder/nested")).unwrap();
        fs::write(
            f.root.join("folder/nested/unregistered.txt"),
            b"unregistered",
        )
        .unwrap();
        assert_eq!(count(&f, "documents"), 0);
        let prepared = prepare(&f, "folder");
        assert!(prepared.files.is_empty());
        assert!(!prepared.identity_token.is_empty());
        let result = rename(&f, &input(&f, &prepared, Some("renamed"), "empty-rename")).unwrap();
        assert_eq!(result.relative_path.as_deref(), Some("renamed"));
        assert!(result.file_ids.is_empty());
        assert!(!f.root.join("folder").exists());
        assert_eq!(
            fs::read(f.root.join("renamed/nested/unregistered.txt")).unwrap(),
            b"unregistered"
        );
        assert_eq!(count(&f, "documents"), 0);
    }
}

#[test]
fn directory_changes_prepare_does_not_recover_journal_or_mutate_business_data() {
    let f = fixture(true);
    let (object, _) = rich_file(&f);
    let snapshots = || {
        f.db.conn.prepare("SELECT id,version_number,managed_path FROM document_versions WHERE document_id=?1 ORDER BY id").unwrap()
            .query_map([&object.id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))).unwrap()
            .map(|row| { let (id, version, path) = row.unwrap(); let bytes = fs::read(f.db.decode_path_ref(&path)).unwrap(); (id, version, path, bytes) }).collect::<Vec<_>>()
    };
    let before_versions = snapshots();
    let before_working = working_bytes(&f, &object);
    let before_changes = count(&f, "agent_change_log");
    let before_receipts = count(&f, "agent_operation_receipts");
    let before_document = f.db.document_record(object.id.parse().unwrap()).unwrap();
    let before_writes: i64 =
        f.db.conn
            .query_row("SELECT total_changes()", [], |r| r.get(0))
            .unwrap();
    let first = prepare(&f, "folder");
    let second = prepare(&f, "folder");
    assert_eq!(first.token, second.token);
    assert_eq!(first.files, second.files);
    // A real pending journal entry, deliberately unreadable as an intent.
    // Read-only prepare must reject malformed evidence without recovering or
    // clearing it. Creating lock metadata is allowed.
    let journal = f
        .workspace
        .join(JOURNALS)
        .join("0123456789abcdef0123456789abcdef");
    fs::create_dir_all(&journal).unwrap();
    fs::write(journal.join("intent.json"), b"pending recovery evidence").unwrap();
    assert!(f
        .db
        .project_directory_change_prepare(&f.binding, f.owner, "folder")
        .is_err());
    let after_writes: i64 =
        f.db.conn
            .query_row("SELECT total_changes()", [], |r| r.get(0))
            .unwrap();
    assert_eq!(
        after_writes, before_writes,
        "prepare must not write DB rows"
    );
    assert_eq!(snapshots(), before_versions);
    assert_eq!(working_bytes(&f, &object), before_working);
    assert_eq!(count(&f, "agent_change_log"), before_changes);
    assert_eq!(count(&f, "agent_operation_receipts"), before_receipts);
    let after = f.db.document_record(object.id.parse().unwrap()).unwrap();
    assert_eq!(after.managed_path, before_document.managed_path);
    assert_eq!(after.history_dir_path, before_document.history_dir_path);
    assert_eq!(after.updated_at, before_document.updated_at);
    assert_eq!(
        fs::read(f.root.join("folder/nested/note.md")).unwrap(),
        b"working bytes not archived"
    );
    assert_eq!(
        fs::read(journal.join("intent.json")).unwrap(),
        b"pending recovery evidence"
    );
}

#[test]
fn directory_changes_rename_preserves_ids_versions_hashes_and_working_bytes_after_reopen() {
    for project in [false, true] {
        let mut f = fixture(project);
        let (object, current) = rich_file(&f);
        fs::write(f.root.join("folder/unregistered.bin"), b"not registered").unwrap();
        let before_versions = versions(&f, &object);
        let before_working = working_bytes(&f, &object);
        let before = f.db.project_file_resolve(&object).unwrap();
        let prepared = prepare(&f, "folder");
        assert_eq!(
            prepared.files,
            vec![PreparedFile {
                file_id: object.id.parse().unwrap(),
                revision: current.revision
            }]
        );
        let result = rename(
            &f,
            &input(&f, &prepared, Some("资料 renamed"), "rename-rich"),
        )
        .unwrap();
        assert_eq!(result.file_ids, vec![object.id.parse::<i64>().unwrap()]);
        assert_eq!(result.relative_path.as_deref(), Some("资料 renamed"));
        assert!(!f.root.join("folder").exists());
        assert_eq!(
            fs::read(f.root.join("资料 renamed/unregistered.bin")).unwrap(),
            b"not registered"
        );
        reopen(&mut f);
        let after = f.db.project_file_resolve(&object).unwrap();
        assert_eq!(after.object, before.object);
        assert_eq!(after.relative_path, "资料 renamed/nested/note.md");
        assert_eq!(after.version_number, before.version_number);
        assert_eq!(after.content_hash, before.content_hash);
        assert_eq!(versions(&f, &object), before_versions);
        assert_eq!(working_bytes(&f, &object), before_working);
        let recovered =
            f.db.file_working_recovery_read(&f.request, &f.binding, &object)
                .unwrap();
        assert_eq!(recovered.revision, current.revision);
        assert_eq!(recovered.content_hash, current.content_hash);
        assert_eq!(
            STANDARD.decode(recovered.base64).unwrap(),
            b"working bytes not archived"
        );
        let opened =
            f.db.file_working_begin_session(&f.request, &f.binding, &object)
                .unwrap();
        assert_eq!(opened.status.revision, current.revision);
        assert_eq!(
            STANDARD.decode(opened.base64).unwrap(),
            b"working bytes not archived"
        );
    }
}

#[test]
fn directory_changes_trash_receives_original_directory_and_retains_readable_history_for_both_owners(
) {
    for project in [false, true] {
        let mut f = fixture(project);
        let (object, current) = rich_file(&f);
        fs::write(f.root.join("folder/unregistered.bin"), b"not registered").unwrap();
        let before_versions = versions(&f, &object);
        let before_working = working_bytes(&f, &object);
        let prepared = prepare(&f, "folder");
        let payload = input(&f, &prepared, None, "trash-rich");
        let source = f.root.join("folder");
        let sibling_trash = f.temp.path().join("trash-fixture");
        let result =
            f.db.project_directory_change_with(&payload, |path| {
                assert_eq!(path, source, "OS must receive the original business path");
                assert_eq!(fs::read(path.join("unregistered.bin"))?, b"not registered");
                assert_eq!(
                    fs::read(path.join("nested/note.md"))?,
                    b"working bytes not archived"
                );
                fs::rename(path, &sibling_trash)?;
                Ok(())
            })
            .unwrap();
        assert_eq!(result.relative_path, None);
        assert_eq!(result.file_ids, vec![object.id.parse::<i64>().unwrap()]);
        assert!(!source.exists());
        assert_eq!(
            fs::read(sibling_trash.join("unregistered.bin")).unwrap(),
            b"not registered"
        );
        // Erase the simulated OS copy: history must be independently retained
        // inside the Workspace rather than accidentally read from that copy.
        fs::remove_dir_all(&sibling_trash).unwrap();
        reopen(&mut f);
        assert_eq!(count(&f, "documents"), 1);
        let document = f.db.document_record(object.id.parse().unwrap()).unwrap();
        assert_eq!(document.project_id, f.owner);
        assert_eq!(document.current_version_number, 2);
        assert_eq!(document.health, "missing");
        assert_eq!(f.db.project_file_resolve(&object).unwrap().state, "missing");
        assert_eq!(
            versions(&f, &object),
            before_versions,
            "Trash must preserve readable immutable version bytes, IDs and hashes"
        );
        assert_eq!(working_bytes(&f, &object), before_working);
        let recovery =
            f.db.file_working_recovery_read(&f.request, &f.binding, &object)
                .unwrap();
        assert_eq!(recovery.revision, current.revision);
        assert_eq!(recovery.content_hash, current.content_hash);
        assert_eq!(
            STANDARD.decode(recovery.base64).unwrap(),
            b"working bytes not archived"
        );
    }
}

#[test]
fn directory_changes_trash_without_confirmation_never_calls_os_or_changes_bytes() {
    let f = fixture(true);
    let (object, _) = rich_file(&f);
    let prepared = prepare(&f, "folder");
    let before = working_bytes(&f, &object);
    let histories = versions(&f, &object);
    let receipts = count(&f, "agent_operation_receipts");
    for confirmed in [None, Some(false)] {
        let mut payload = input(&f, &prepared, None, "unconfirmed");
        payload.confirmed = confirmed;
        assert_code(
            f.db.project_directory_change_with(&payload, |_| panic!("unconfirmed Trash")),
            "confirmation_required",
        );
    }
    assert_eq!(working_bytes(&f, &object), before);
    assert_eq!(versions(&f, &object), histories);
    assert_eq!(count(&f, "agent_operation_receipts"), receipts);
    assert!(f.root.join("folder/nested/note.md").exists());
}

#[test]
fn directory_changes_active_session_blocks_prepare_rename_and_trash_without_losing_saved_or_base_bytes(
) {
    let f = fixture(true);
    let object = register(&f, "folder/note.md", b"session base");
    let prepared = prepare(&f, "folder");
    let (session, initial) = open(&f, &object);
    let saved = save(&f, &session, &initial, "saved working bytes", "active-save");
    let before = working_bytes(&f, &object);
    assert_code(
        f.db.project_directory_change_prepare(&f.binding, f.owner, "folder"),
        "active_editors",
    );
    assert_code(
        rename(&f, &input(&f, &prepared, Some("renamed"), "active-rename")),
        "active_editors",
    );
    assert_code(
        f.db.project_directory_change_with(&input(&f, &prepared, None, "active-trash"), |_| {
            panic!("active editor Trash")
        }),
        "active_editors",
    );
    assert_eq!(working_bytes(&f, &object), before);
    assert_eq!(
        f.db.file_working_session_base(&f.request, &f.binding, &session)
            .unwrap()
            .1,
        b"session base"
    );
    assert_eq!(
        fs::read(f.root.join("folder/note.md")).unwrap(),
        b"saved working bytes"
    );
    // The rejected operation leaves the session usable for the next save.
    let next = save(&f, &session, &saved, "subsequent save", "active-save-again");
    assert_eq!(next.revision, saved.revision + 1);
    close(&f, &session);
    let fresh = prepare(&f, "folder");
    rename(&f, &input(&f, &fresh, Some("renamed"), "closed-rename")).unwrap();
    assert_eq!(
        fs::read(f.root.join("renamed/note.md")).unwrap(),
        b"subsequent save"
    );
}

#[test]
fn directory_changes_stale_token_rejects_new_members_and_working_revisions() {
    for change_revision in [false, true] {
        let f = fixture(true);
        let object = register(&f, "folder/note.md", b"original");
        let prepared = prepare(&f, "folder");
        if change_revision {
            let (session, status) = open(&f, &object);
            save(&f, &session, &status, "new working revision", "stale-save");
            close(&f, &session);
        } else {
            register(&f, "folder/new.md", b"new member");
        }
        let fresh = prepare(&f, "folder");
        assert_ne!(fresh.token, prepared.token);
        assert_code(
            rename(&f, &input(&f, &prepared, Some("renamed"), "stale-rename")),
            "revision_conflict",
        );
        assert_code(
            f.db.project_directory_change_with(&input(&f, &prepared, None, "stale-trash"), |_| {
                panic!("stale Trash")
            }),
            "revision_conflict",
        );
        assert!(f.root.join("folder/note.md").exists());
        assert!(!f.root.join("renamed").exists());
    }
}

#[test]
fn directory_changes_same_path_replacement_rejects_old_identity_token() {
    let f = fixture(false);
    fs::create_dir(f.root.join("folder")).unwrap();
    fs::write(f.root.join("folder/original.txt"), b"original").unwrap();
    let prepared = prepare(&f, "folder");
    fs::rename(f.root.join("folder"), f.root.join("displaced")).unwrap();
    fs::create_dir(f.root.join("folder")).unwrap();
    fs::write(f.root.join("folder/new.txt"), b"replacement").unwrap();
    assert_ne!(
        prepare(&f, "folder").identity_token,
        prepared.identity_token
    );
    assert_code(
        rename(&f, &input(&f, &prepared, Some("renamed"), "replaced")),
        "revision_conflict",
    );
    assert_eq!(
        fs::read(f.root.join("folder/new.txt")).unwrap(),
        b"replacement"
    );
    assert_eq!(
        fs::read(f.root.join("displaced/original.txt")).unwrap(),
        b"original"
    );
}

#[test]
fn directory_changes_repeated_rename_replays_receipt_and_changed_payload_is_rejected() {
    let f = fixture(true);
    let object = register(&f, "folder/note.md", b"original");
    let prepared = prepare(&f, "folder");
    let payload = input(&f, &prepared, Some("renamed"), "rename-once");
    let first = rename(&f, &payload).unwrap();
    let changes = count(&f, "agent_change_log");
    let receipts = count(&f, "agent_operation_receipts");
    assert_eq!(rename(&f, &payload).unwrap(), first);
    assert_eq!(count(&f, "agent_change_log"), changes);
    assert_eq!(count(&f, "agent_operation_receipts"), receipts);
    let mut changed = payload.clone();
    changed.name = Some("different".into());
    assert!(rename(&f, &changed).is_err());
    assert_eq!(
        f.db.project_file_resolve(&object).unwrap().relative_path,
        "renamed/note.md"
    );
    assert!(!f.root.join("different").exists());
}

#[test]
fn directory_changes_repeated_trash_calls_os_once_even_when_source_has_been_recreated() {
    let f = fixture(false);
    let object = register(&f, "folder/note.md", b"original");
    let histories = versions(&f, &object);
    let prepared = prepare(&f, "folder");
    let payload = input(&f, &prepared, None, "trash-once");
    let sibling = f.temp.path().join("trash-fixture");
    let first =
        f.db.project_directory_change_with(&payload, |path| {
            fs::rename(path, &sibling)?;
            Ok(())
        })
        .unwrap();
    fs::create_dir(f.root.join("folder")).unwrap();
    fs::write(f.root.join("folder/new.txt"), b"new occupant").unwrap();
    let changes = count(&f, "agent_change_log");
    let receipts = count(&f, "agent_operation_receipts");
    assert_eq!(
        f.db.project_directory_change_with(&payload, |_| panic!("replayed Trash"))
            .unwrap(),
        first
    );
    assert_eq!(count(&f, "agent_change_log"), changes);
    assert_eq!(count(&f, "agent_operation_receipts"), receipts);
    assert_eq!(
        fs::read(f.root.join("folder/new.txt")).unwrap(),
        b"new occupant"
    );
    assert_eq!(versions(&f, &object), histories);
    let mut changed = payload.clone();
    changed.confirmed = Some(false);
    assert!(f
        .db
        .project_directory_change_with(&changed, |_| panic!("conflicting replay"))
        .is_err());
}

#[test]
fn directory_changes_foreign_workspace_or_member_owner_is_rejected() {
    let mut f = fixture(true);
    let object = register(&f, "folder/note.md", b"original");
    let prepared = prepare(&f, "folder");
    let mut binding = f.binding.clone();
    binding.workspace_id = "another-workspace".into();
    assert_code(
        f.db.project_directory_change_prepare(&binding, f.owner, "folder"),
        "ownership_mismatch",
    );
    let mut payload = input(&f, &prepared, Some("renamed"), "foreign-workspace");
    payload.binding = binding;
    assert_code(rename(&f, &payload), "ownership_mismatch");
    let other =
        f.db.project_create(ProjectCreateInput {
            name: "Other owner".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    // A legacy/corrupt path claim must not authorize mutating another owner's File.
    f.db.conn
        .execute(
            "UPDATE documents SET project_id=?1 WHERE id=?2",
            params![other.id, object.id],
        )
        .unwrap();
    assert_code(
        f.db.project_directory_change_prepare(&f.binding, f.owner, "folder"),
        "ownership_mismatch",
    );
    assert_code(
        rename(&f, &input(&f, &prepared, Some("renamed"), "foreign-owner")),
        "ownership_mismatch",
    );
    assert_eq!(
        fs::read(f.root.join("folder/note.md")).unwrap(),
        b"original"
    );
}

#[test]
fn directory_changes_hidden_root_escape_and_invalid_names_are_rejected() {
    let f = fixture(true);
    fs::create_dir_all(f.root.join("folder/nested")).unwrap();
    fs::create_dir_all(f.root.join(".hidden/nested")).unwrap();
    for relative in [
        "",
        ".",
        "..",
        "../folder",
        "/folder",
        "folder/../nested",
        "folder//nested",
        "folder\\nested",
        ".hidden",
        ".hidden/nested",
        "folder/.project-mind",
        "folder/",
    ] {
        assert_code(
            f.db.project_directory_change_prepare(&f.binding, f.owner, relative),
            "invalid_path",
        );
    }
    let prepared = prepare(&f, "folder");
    for name in [
        "",
        ".hidden",
        "..",
        "../escape",
        "nested/name",
        "back\\slash",
        "drive:name",
        "leading ",
        " trailing",
        "trailing.",
    ] {
        assert_code(
            rename(&f, &input(&f, &prepared, Some(name), "invalid-name")),
            "invalid_path",
        );
    }
    assert!(f.root.join("folder/nested").is_dir());
}

#[test]
fn directory_changes_existing_file_or_directory_target_is_never_overwritten() {
    let f = fixture(false);
    fs::create_dir(f.root.join("folder")).unwrap();
    fs::write(f.root.join("folder/original.txt"), b"original").unwrap();
    fs::create_dir(f.root.join("occupied-dir")).unwrap();
    fs::write(f.root.join("occupied-dir/keep.txt"), b"keep directory").unwrap();
    fs::write(f.root.join("occupied-file"), b"keep file").unwrap();
    let prepared = prepare(&f, "folder");
    for target in ["folder", "occupied-dir", "occupied-file"] {
        assert_code(
            rename(&f, &input(&f, &prepared, Some(target), "conflict")),
            "revision_conflict",
        );
    }
    assert_eq!(
        fs::read(f.root.join("occupied-dir/keep.txt")).unwrap(),
        b"keep directory"
    );
    assert_eq!(
        fs::read(f.root.join("occupied-file")).unwrap(),
        b"keep file"
    );
    assert_eq!(
        fs::read(f.root.join("folder/original.txt")).unwrap(),
        b"original"
    );
}

#[test]
fn directory_changes_unowned_hidden_history_or_app_metadata_blocks_rename_and_trash() {
    for protected in [".project-mind", ".foreign.pm-versions"] {
        let f = fixture(true);
        register(&f, "folder/note.md", b"original");
        fs::create_dir(f.root.join("folder").join(protected)).unwrap();
        fs::write(
            f.root.join("folder").join(protected).join("evidence"),
            b"protected",
        )
        .unwrap();
        let prepared = prepare(&f, "folder");
        assert_code(
            rename(
                &f,
                &input(&f, &prepared, Some("renamed"), "protected-rename"),
            ),
            "ownership_mismatch",
        );
        assert_code(
            f.db.project_directory_change_with(
                &input(&f, &prepared, None, "protected-trash"),
                |_| panic!("protected metadata Trash"),
            ),
            "ownership_mismatch",
        );
        assert_eq!(
            fs::read(f.root.join("folder").join(protected).join("evidence")).unwrap(),
            b"protected"
        );
    }
}

#[cfg(unix)]
#[test]
fn directory_changes_symlink_source_ancestor_and_target_are_rejected_without_touching_outside() {
    use std::os::unix::fs::symlink;
    let f = fixture(true);
    let outside = f.temp.path().join("outside");
    fs::create_dir_all(outside.join("nested")).unwrap();
    fs::write(outside.join("nested/keep.txt"), b"outside bytes").unwrap();
    symlink(&outside, f.root.join("link")).unwrap();
    for source in ["link", "link/nested"] {
        assert!(f
            .db
            .project_directory_change_prepare(&f.binding, f.owner, source)
            .is_err());
    }
    fs::create_dir(f.root.join("folder")).unwrap();
    symlink(&outside, f.root.join("occupied-link")).unwrap();
    let prepared = prepare(&f, "folder");
    assert!(rename(
        &f,
        &input(&f, &prepared, Some("occupied-link"), "symlink-target")
    )
    .is_err());
    assert_eq!(
        fs::read(outside.join("nested/keep.txt")).unwrap(),
        b"outside bytes"
    );
    assert!(f.root.join("folder").is_dir());
}

#[cfg(unix)]
#[test]
fn directory_changes_contained_symlink_moves_as_entry_without_following_its_target() {
    use std::os::unix::fs::symlink;
    let f = fixture(false);
    fs::create_dir(f.root.join("folder")).unwrap();
    let outside = f.temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("keep.txt"), b"outside bytes").unwrap();
    symlink(&outside, f.root.join("folder/link")).unwrap();
    let prepared = prepare(&f, "folder");
    rename(&f, &input(&f, &prepared, Some("renamed"), "contained-link")).unwrap();
    assert_eq!(fs::read_link(f.root.join("renamed/link")).unwrap(), outside);
    assert_eq!(
        fs::read(outside.join("keep.txt")).unwrap(),
        b"outside bytes"
    );
}

#[test]
#[ignore = "manual OS Trash acceptance; sends only a uniquely named temporary fixture to the system Trash"]
fn directory_changes_real_os_trash_keeps_registered_history_readable() {
    let mut f = fixture(true);
    let (object, _) = rich_file(&f);
    fs::write(
        f.root.join("folder/unregistered.bin"),
        b"unregistered OS fixture",
    )
    .unwrap();
    let histories = versions(&f, &object);
    let prepared = prepare(&f, "folder");
    let original = f.root.join("folder");
    f.db.project_directory_change_with(&input(&f, &prepared, None, "real-os-trash"), |path| {
        assert_eq!(path, original);
        trash::delete(path).map_err(|e| anyhow!(e))
    })
    .unwrap();
    assert!(!original.exists());
    reopen(&mut f);
    assert_eq!(f.db.project_file_resolve(&object).unwrap().state, "missing");
    assert_eq!(versions(&f, &object), histories);
}

#[test]
fn directory_changes_corrupt_working_revision_is_not_replaced_by_archived_version() {
    let f = fixture(true);
    let (object, _) = rich_file(&f);
    f.db.conn.execute("UPDATE file_working_contents SET state=json_set(state,'$.revision','corrupt') WHERE document_id=?1", [&object.id]).unwrap();
    assert!(f
        .db
        .project_directory_change_prepare(&f.binding, f.owner, "folder")
        .is_err());
    assert_eq!(
        fs::read(f.root.join("folder/nested/note.md")).unwrap(),
        b"working bytes not archived"
    );
}
