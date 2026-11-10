use super::*;
use crate::{
    agent::{
        access::{Caller, ScopeGrant},
        models::Scope,
    },
    file_working::{WorkingSaveText, WorkingSession},
};
use std::path::PathBuf;
struct Fixture {
    _temp: tempfile::TempDir,
    db: Database,
    binding: WorkspaceBinding,
    request: RequestContext,
    object: ObjectRef,
    path: PathBuf,
    db_path: PathBuf,
    root: PathBuf,
}
fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let (metadata, paths) = crate::workspace::create_workspace(&root, "password").unwrap();
    let mut db = Database::open(&paths.db_path, &root, None).unwrap();
    db.bind_native_workspace(&metadata.workspace_id).unwrap();
    let project = db
        .project_create(crate::models::ProjectCreateInput {
            name: "Working".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let path = PathBuf::from(project.root_path).join("source.md");
    fs::write(&path, b"original").unwrap();
    let file = db
        .project_file_register(&metadata.workspace_id, project.id, "source.md")
        .unwrap();
    let binding = WorkspaceBinding {
        workspace_id: metadata.workspace_id,
        generation: "open".into(),
    };
    let request = RequestContext {
        binding: binding.clone(),
        request_id: "open".into(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: false,
            project_ids: vec![project.id],
            operations: vec!["source.read".into(), "file.update".into()],
            object_keys: None,
        },
    };
    Fixture {
        _temp: temp,
        db,
        binding,
        request,
        object: file.object,
        path,
        db_path: paths.db_path,
        root,
    }
}
fn session(f: &Fixture) -> (WorkingSession, WorkingStatus) {
    let open =
        f.db.file_working_begin_session(&f.request, &f.binding, &f.object)
            .unwrap();
    (
        WorkingSession {
            object: f.object.clone(),
            session_id: open.session_id,
        },
        open.status,
    )
}
fn save(
    f: &Fixture,
    session: &WorkingSession,
    status: &WorkingStatus,
    text: &str,
    id: &str,
    now: i64,
) -> AgentResult<WorkingStatus> {
    let mut request = f.request.clone();
    request.request_id = id.into();
    let input = WorkingSaveText {
        object: f.object.clone(),
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
        &input,
        text.as_bytes(),
        now,
    )
}
fn history(f: &mut Fixture) -> Vec<crate::models::DocumentVersionRecord> {
    f.db.document_list_versions(crate::models::DocumentListVersionsInput {
        document_id: f.object.id.parse().unwrap(),
    })
    .unwrap()
}
#[test]
fn working_open_reports_original_content_without_new_history() {
    let mut f = fixture();
    let (_, status) = session(&f);
    assert_eq!(status.revision, 0);
    assert_eq!(status.archived_version_number, 1);
    assert!(!status.pending_archive);
    assert_eq!(history(&mut f).len(), 1);
}
#[test]
fn repeated_working_saves_keep_fixed_base_and_only_idle_archive_adds_history() {
    let mut f = fixture();
    let (session, initial) = session(&f);
    let first = save(&f, &session, &initial, "first", "first", 1000).unwrap();
    let second = save(&f, &session, &first, "second", "second", 2000).unwrap();
    assert_eq!(second.revision, 2);
    assert_eq!(second.archived_version_number, 1);
    assert!(second.pending_archive);
    assert_eq!(fs::read(&f.path).unwrap(), b"second");
    assert_eq!(history(&mut f).len(), 1);
    assert_eq!(
        f.db.file_working_session_base(&f.request, &f.binding, &session)
            .unwrap()
            .1,
        b"original"
    );
    assert_eq!(
        f.db.project_file_resolve(&f.object).unwrap().version_number,
        1
    );
    let before =
        f.db.file_working_archive(&f.request, &f.binding, &f.object, 2000 + IDLE_MS - 1, false)
            .unwrap();
    assert!(before.pending_archive);
    assert_eq!(before.archived_version_number, 1);
    let archived =
        f.db.file_working_archive(&f.request, &f.binding, &f.object, 2000 + IDLE_MS, false)
            .unwrap();
    assert!(!archived.pending_archive);
    assert_eq!(archived.archived_version_number, 2);
    let versions = history(&mut f);
    assert_eq!(versions.len(), 2);
    for version in versions {
        assert_eq!(
            fs::read(&version.managed_path).unwrap(),
            if version.version_number == 1 {
                b"original".as_slice()
            } else {
                b"second".as_slice()
            }
        );
    }
    assert_eq!(
        f.db.file_working_archive(
            &f.request,
            &f.binding,
            &f.object,
            2000 + 10 * IDLE_MS,
            false
        )
        .unwrap()
        .archived_version_number,
        2
    );
}
#[test]
fn working_cas_receipts_noop_and_external_changes_preserve_content() {
    let f = fixture();
    let (session, initial) = session(&f);
    let saved = save(&f, &session, &initial, "first", "first", 1000).unwrap();
    assert_eq!(
        save(&f, &session, &initial, "first", "first", 1000)
            .unwrap()
            .revision,
        saved.revision
    );
    assert_eq!(
        save(&f, &session, &initial, "different", "first", 1000)
            .unwrap_err()
            .code,
        ErrorCode::IdempotencyConflict
    );
    assert_eq!(
        save(&f, &session, &initial, "lost", "stale", 2000)
            .unwrap_err()
            .code,
        ErrorCode::RevisionConflict
    );
    let same = save(&f, &session, &saved, "first", "same", 2000).unwrap();
    assert!(same.no_change);
    assert_eq!(same.revision, 1);
    fs::write(&f.path, b"external").unwrap();
    assert_eq!(
        save(&f, &session, &saved, "lost", "external", 2000)
            .unwrap_err()
            .code,
        ErrorCode::FileChangedUnregistered
    );
    assert_eq!(
        f.db.file_working_archive(&f.request, &f.binding, &f.object, 2000 + IDLE_MS, true)
            .unwrap_err()
            .code,
        ErrorCode::FileChangedUnregistered
    );
    assert_eq!(fs::read(&f.path).unwrap(), b"external");
}
#[test]
fn activity_extends_deadline_and_close_restart_catches_up_once() {
    let mut f = fixture();
    let (session, initial) = session(&f);
    let saved = save(&f, &session, &initial, "persisted", "save", 1000).unwrap();
    f.db.file_working_activity(&f.request, &f.binding, &session, 1000 + IDLE_MS - 1)
        .unwrap();
    assert!(f
        .db
        .file_working_due_objects(&f.binding.workspace_id, 1000 + IDLE_MS)
        .unwrap()
        .is_empty());
    f.db.file_working_close(&f.request, &f.binding, &session)
        .unwrap();
    assert_eq!(history(&mut f).len(), 1);
    drop(f.db);
    f.db = Database::open(&f.db_path, &f.root, None).unwrap();
    f.db.bind_native_workspace(&f.binding.workspace_id).unwrap();
    let opened =
        f.db.file_working_begin_session(&f.request, &f.binding, &f.object)
            .unwrap();
    use base64::Engine;
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(opened.base64)
            .unwrap(),
        b"persisted"
    );
    assert_eq!(opened.status.revision, saved.revision);
    assert_eq!(
        f.db.file_working_due_objects(&f.binding.workspace_id, 1000 + 2 * IDLE_MS)
            .unwrap(),
        vec![f.object.clone()]
    );
    let archived =
        f.db.file_working_archive(&f.request, &f.binding, &f.object, 1000 + 2 * IDLE_MS, false)
            .unwrap();
    assert_eq!(archived.archived_version_number, 2);
    assert_eq!(history(&mut f).len(), 2);
    assert!(f
        .db
        .file_working_due_objects(&f.binding.workspace_id, 1000 + 3 * IDLE_MS)
        .unwrap()
        .is_empty());
}
#[test]
fn working_sessions_keep_native_owner_generation_and_ai_handoff_boundaries() {
    let f = fixture();
    let (session, initial) = session(&f);
    save(&f, &session, &initial, "pending", "save", 1000).unwrap();
    assert_eq!(
        f.db.file_working_require_archived(f.object.id.parse().unwrap())
            .unwrap_err()
            .code,
        ErrorCode::RevisionConflict
    );
    let mut forged = session.clone();
    forged.object.scope = Scope::Workspace;
    assert!(f
        .db
        .file_working_session_base(&f.request, &f.binding, &forged)
        .is_err());
    let mut expired = f.request.clone();
    expired.binding.generation = "expired".into();
    assert_eq!(
        f.db.file_working_open_status(&expired, &f.binding, &f.object)
            .unwrap_err()
            .code,
        ErrorCode::WorkspaceChanged
    );
    f.db.file_working_archive(&f.request, &f.binding, &f.object, 1001, true)
        .unwrap();
    f.db.file_working_require_archived(f.object.id.parse().unwrap())
        .unwrap();
}
#[test]
fn legacy_managed_copy_retains_file_identity_live_location_and_existing_history() {
    let mut f = fixture();
    let source = f.root.join("legacy.md");
    fs::write(&source, b"legacy original").unwrap();
    let project = match f.object.scope {
        Scope::Project { project_id } => project_id,
        _ => unreachable!(),
    };
    let legacy =
        f.db.document_import_legacy_fixture(crate::models::DocumentImportInput {
            project_id: Some(project),
            source_path: source.to_string_lossy().into(),
            is_starred: false,
            tag_ids: None,
        })
        .unwrap();
    let registered =
        f.db.document_add_version(crate::models::DocumentAddVersionInput {
            document_id: legacy.id,
            source_path: Some(source.to_string_lossy().into()),
        })
        .unwrap();
    f.object.id = registered.id.to_string();
    f.path = PathBuf::from(&registered.managed_path);
    let original_path = f.path.clone();
    let (session, initial) = session(&f);
    let saved = save(&f, &session, &initial, "legacy updated", "legacy", 1000).unwrap();
    assert_eq!(saved.archived_version_number, 2);
    assert_eq!(history(&mut f).len(), 2);
    assert_eq!(
        f.db.document_record(registered.id).unwrap().managed_path,
        original_path.to_string_lossy()
    );
    let archived =
        f.db.file_working_archive(&f.request, &f.binding, &f.object, 1000 + IDLE_MS, false)
            .unwrap();
    assert_eq!(archived.archived_version_number, 3);
    assert_eq!(fs::read(&original_path).unwrap(), b"legacy updated");
    for version in history(&mut f) {
        assert_eq!(
            fs::read(version.managed_path).unwrap(),
            if version.version_number < 3 {
                b"legacy original".as_slice()
            } else {
                b"legacy updated".as_slice()
            }
        );
    }
}
#[test]
fn schema_39_upgrade_adds_working_storage_without_changing_existing_versions() {
    let mut f = fixture();
    let before = history(&mut f);
    f.db.conn.execute_batch("DROP TABLE file_working_sessions;DROP TABLE file_working_contents;PRAGMA user_version=39;").unwrap();
    drop(f.db);
    f.db = Database::open(&f.db_path, &f.root, None).unwrap();
    f.db.bind_native_workspace(&f.binding.workspace_id).unwrap();
    assert_eq!(
        f.db.schema_version().unwrap(),
        crate::db::CURRENT_SCHEMA_VERSION
    );
    let (_, status) = session(&f);
    assert_eq!(status.archived_version_number, 1);
    let after = history(&mut f);
    assert_eq!(before.len(), after.len());
    assert_eq!(before[0].id, after[0].id);
    assert_eq!(before[0].managed_path, after[0].managed_path);
    assert_eq!(fs::read(&after[0].managed_path).unwrap(), b"original");
}
#[test]
fn explicit_source_read_checkpoints_pending_content_but_background_plans_do_not() {
    let mut f = fixture();
    let (session, initial) = session(&f);
    let saved = save(&f, &session, &initial, "current evidence", "save", 1000).unwrap();
    let mut reader = f.request.clone();
    reader.scope_grant.operations = vec!["source.read".into()];
    let source = crate::source_service::SourceReadTarget {
        object: f.object.clone(),
        revision: None,
        file_version: None,
        record_version: None,
    };
    assert_eq!(
        f.db.source_file_plan(&reader, &f.binding, &source)
            .unwrap_err()
            .code,
        ErrorCode::RevisionConflict
    );
    assert_eq!(history(&mut f).len(), 1);
    f.db.file_working_checkpoint_source(&reader, &f.binding, &f.object)
        .unwrap();
    let fixed = f.db.source_file_plan(&reader, &f.binding, &source).unwrap();
    assert_eq!(fixed.file_version, 2);
    assert_eq!(fixed.registered_hash, saved.content_hash);
    assert_eq!(history(&mut f).len(), 2);
    f.db.file_working_checkpoint_source(&reader, &f.binding, &f.object)
        .unwrap();
    assert_eq!(history(&mut f).len(), 2);
    let next = save(&f, &session, &saved, "continue editing", "next", 2000).unwrap();
    assert_eq!(next.revision, 2);
    assert_eq!(next.archived_version_number, 2);
}
#[test]
fn external_overwrite_keeps_one_readable_last_saved_recovery_copy() {
    use base64::Engine;
    let f = fixture();
    let (session, initial) = session(&f);
    let first = save(&f, &session, &initial, "first", "first", 1000).unwrap();
    save(&f, &session, &first, "latest saved", "second", 2000).unwrap();
    fs::write(&f.path, b"external replacement").unwrap();
    let recovery =
        f.db.file_working_recovery_read(&f.request, &f.binding, &f.object)
            .unwrap();
    assert_eq!(recovery.revision, 2);
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(recovery.base64)
            .unwrap(),
        b"latest saved"
    );
    assert_eq!(fs::read(&f.path).unwrap(), b"external replacement");
}
#[test]
#[ignore = "child process for actual abrupt save interruption"]
fn working_save_crash_child() {
    let root = PathBuf::from(std::env::var("MIND_WORKING_ROOT").unwrap());
    let paths = crate::workspace::workspace_paths(&root);
    let db = Database::open(&paths.db_path, &root, None).unwrap();
    let input: WorkingSaveText =
        serde_json::from_str(&std::env::var("MIND_WORKING_INPUT").unwrap()).unwrap();
    let binding = WorkspaceBinding {
        workspace_id: input.object.workspace_id.clone(),
        generation: "open".into(),
    };
    let project = match input.object.scope {
        Scope::Project { project_id } => vec![project_id],
        _ => vec![],
    };
    let request = RequestContext {
        binding: binding.clone(),
        request_id: "crash-save".into(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: true,
            project_ids: project,
            operations: vec!["source.read".into(), "file.update".into()],
            object_keys: None,
        },
    };
    db.file_working_save(
        &request,
        &binding,
        &WorkingSession {
            object: input.object.clone(),
            session_id: input.session_id.clone(),
        },
        input.expected_revision,
        &input.expected_content_hash,
        &input,
        input.text.as_bytes(),
        1000,
    )
    .unwrap();
    panic!("crash stage was not reached");
}
#[test]
#[cfg(unix)]
fn sigkill_working_replacement_recovers_before_and_after_atomic_receipt() {
    use std::os::unix::process::ExitStatusExt;
    for stage in 1..=4 {
        let mut f = fixture();
        let (session, initial) = session(&f);
        let input = WorkingSaveText {
            object: f.object.clone(),
            session_id: session.session_id.clone(),
            expected_revision: initial.revision,
            expected_content_hash: initial.content_hash.clone(),
            text: "after crash".into(),
        };
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "db::file_working::tests::working_save_crash_child",
                "--ignored",
                "--nocapture",
            ])
            .env("MIND_WORKING_ROOT", &f.root)
            .env("MIND_WORKING_INPUT", serde_json::to_string(&input).unwrap())
            .env("MIND_WORKING_CRASH_STAGE", stage.to_string())
            .output()
            .unwrap();
        assert_eq!(
            output.status.signal(),
            Some(9),
            "stage {stage}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        drop(f.db);
        f.db = Database::open(&f.db_path, &f.root, None).unwrap();
        f.db.bind_native_workspace(&f.binding.workspace_id).unwrap();
        let status =
            f.db.file_working_open_status(&f.request, &f.binding, &f.object)
                .unwrap();
        assert_eq!(status.revision, if stage == 4 { 1 } else { 0 });
        assert_eq!(
            fs::read(&f.path).unwrap(),
            if stage == 4 {
                b"after crash".as_slice()
            } else {
                b"original".as_slice()
            }
        );
        assert_eq!(history(&mut f).len(), 1);
        let saved = save(&f, &session, &initial, "after crash", "crash-save", 1000).unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(fs::read(&f.path).unwrap(), b"after crash");
        assert_eq!(history(&mut f).len(), 1);
    }
}
#[tokio::test]
async fn agent_current_file_read_obtains_a_fixed_checkpoint_without_write_permission() {
    use crate::{
        committed_changes::{CommittedChangePublisher, CommittedChanges},
        source_service::{
            BoundSourceStore, SourceReadInput, SourceReadTarget, SourceReadView, SourceService,
            SourceUtility,
        },
    };
    struct Store<'a> {
        db: &'a Database,
        binding: &'a WorkspaceBinding,
    }
    impl CommittedChangePublisher for Store<'_> {
        fn publish_committed(&self, _: CommittedChanges) {}
    }
    impl BoundSourceStore for Store<'_> {
        fn with_current<T>(
            &self,
            f: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
        ) -> AgentResult<T> {
            f(self.binding, self.db)
        }
    }
    struct Extractor;
    impl SourceUtility for Extractor {
        async fn request(
            &self,
            _: &str,
            _: &str,
            _: &str,
            bytes: &[u8],
        ) -> AgentResult<serde_json::Value> {
            assert_eq!(bytes, b"current evidence");
            Ok(
                serde_json::json!({"state":"ready","coverage":{"complete":true},"reason":null,"chunks":[{"text":"current evidence","locator":{"kind":"paragraph","start":1,"end":1},"range":{"start":0,"end":16}}]}),
            )
        }
    }
    let f = fixture();
    let (session, initial) = session(&f);
    let saved = save(&f, &session, &initial, "current evidence", "save", 1000).unwrap();
    let project = match f.object.scope {
        Scope::Project { project_id } => project_id,
        _ => unreachable!(),
    };
    let grant = "abcdefabcdefabcdefabcdefabcdefab";
    let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    f.db.agent_connection_create(
        &f.binding,
        &crate::agent::connections::ConnectionCreateInput {
            all_projects: false,
            client_label: "Read-only evidence consumer".into(),
            workspace_content: false,
            project_ids: vec![project],
            write_operations: vec![],
        },
        grant,
        token,
    )
    .unwrap();
    let request =
        f.db.agent_connection_authenticate(&f.binding, grant, token, "read-current")
            .unwrap();
    let store = Store {
        db: &f.db,
        binding: &f.binding,
    };
    let input = SourceReadInput {
        source: SourceReadTarget {
            object: f.object.clone(),
            revision: None,
            file_version: None,
            record_version: None,
        },
        view: SourceReadView::Full,
        selection: None,
        cursor: None,
        budget_chars: Some(4000),
    };
    let page = SourceService::new(&store)
        .read_file(&request, &input, &Extractor)
        .await
        .unwrap();
    assert_eq!(page.text, "current evidence");
    assert_eq!(page.source_ref.file_version, Some(2));
    assert_eq!(page.source_ref.revision, saved.content_hash);
    assert_eq!(
        f.db.file_working_open_status(&f.request, &f.binding, &f.object)
            .unwrap()
            .archived_version_number,
        2
    );
}

#[test]
fn native_same_bytes_replacement_reopens_with_new_revision_and_rejects_old_session() {
    let mut f = fixture();
    let (old_session, old) = session(&f);
    let replacement = f.path.with_extension("replacement");
    fs::write(&replacement, b"original").unwrap();
    fs::rename(&replacement, &f.path).unwrap();
    assert_eq!(f.db.project_file_resolve(&f.object).unwrap().state, "ready");
    let (_, current) = session(&f);
    assert!(current.revision > old.revision);
    assert_eq!(current.content_hash, old.content_hash);
    assert_eq!(history(&mut f).len(), 1);
    assert_eq!(
        save(&f, &old_session, &old, "stale", "old-save", 0)
            .unwrap_err()
            .code,
        ErrorCode::RevisionConflict
    );
    let (new_session, current) = session(&f);
    fs::write(&f.path, b"different external content").unwrap();
    assert_eq!(
        save(
            &f,
            &new_session,
            &current,
            "overwrite",
            "stale-different",
            0
        )
        .unwrap_err()
        .code,
        ErrorCode::FileChangedUnregistered
    );
    assert_eq!(fs::read(&f.path).unwrap(), b"different external content");
}

// Build the durable post-journal/pre-rename boundary using the actual journal,
// state and owned files. Recovery executes the production filesystem code.
fn inject_working_journal(f: &Fixture) -> Journal {
    let old =
        f.db.working_state(f.object.id.parse().unwrap())
            .unwrap()
            .unwrap();
    let doc = f.db.document_record(f.object.id.parse().unwrap()).unwrap();
    let nonce = files::token();
    let staged = Path::new(&doc.history_dir_path).join(format!("working-new-{nonce}"));
    let backup = Path::new(&doc.history_dir_path).join(format!("working-old-{nonce}"));
    fs::write(&staged, b"prepared replacement").unwrap();
    let new = State {
        revision: old.revision + 1,
        hash: files::checksum(&staged).unwrap(),
        identity: files::path_identity(&staged).unwrap(),
        activity: Some(1000),
        pending: true,
    };
    let journal = Journal {
        object: f.object.clone(),
        target: f.db.encode_path_ref(&f.path),
        staged: f.db.encode_path_ref(&staged),
        backup: f.db.encode_path_ref(&backup),
        old,
        new,
    };
    f.db.conn
        .execute(
            "UPDATE file_working_contents SET journal=?1 WHERE document_id=?2",
            params![
                serde_json::to_string(&journal).unwrap(),
                f.object.id.parse::<i64>().unwrap()
            ],
        )
        .unwrap();
    journal
}

#[test]
fn native_conflicting_working_journal_isolates_file_and_preserves_recovery() {
    let mut f = fixture();
    let (a_session, initial) = session(&f);
    save(
        &f,
        &a_session,
        &initial,
        "last durable save",
        "durable",
        1000,
    )
    .unwrap();
    let journal = inject_working_journal(&f);
    fs::write(&f.path, b"external changed A").unwrap();
    let project = match f.object.scope {
        Scope::Project { project_id } => project_id,
        _ => unreachable!(),
    };
    let b_path = f.path.with_file_name("other.md");
    fs::write(&b_path, b"B initial").unwrap();
    let b =
        f.db.project_file_register(&f.binding.workspace_id, project, "other.md")
            .unwrap()
            .object;
    f.db.file_version_recover_pending().unwrap();
    drop(f.db);
    f.db = Database::open(&f.db_path, &f.root, None).unwrap();
    let b_open =
        f.db.file_working_begin_session(&f.request, &f.binding, &b)
            .unwrap();
    let b_session = WorkingSession {
        object: b.clone(),
        session_id: b_open.session_id,
    };
    let mut request = f.request.clone();
    request.request_id = "B save".into();
    f.db.file_working_save(
        &request,
        &f.binding,
        &b_session,
        b_open.status.revision,
        &b_open.status.content_hash,
        &"B save",
        b"B saved",
        2000,
    )
    .unwrap();
    assert_eq!(fs::read(&b_path).unwrap(), b"B saved");
    assert_eq!(
        f.db.file_working_begin_session(&f.request, &f.binding, &f.object)
            .unwrap_err()
            .code,
        ErrorCode::FileChangedUnregistered
    );
    let recovery =
        f.db.file_working_recovery_read(&f.request, &f.binding, &f.object)
            .unwrap();
    use base64::Engine;
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(recovery.base64)
            .unwrap(),
        b"last durable save"
    );
    assert_eq!(fs::read(&f.path).unwrap(), b"external changed A");
    assert!(f.db.decode_path_ref(&journal.staged).exists());
    let pending: bool =
        f.db.conn
            .query_row(
                "SELECT journal IS NOT NULL FROM file_working_contents WHERE document_id=?1",
                [f.object.id.parse::<i64>().unwrap()],
                |r| r.get(0),
            )
            .unwrap();
    assert!(pending);
    assert!(f
        .db
        .file_native_write_locks(f.object.id.parse().unwrap())
        .is_err());
    assert!(f.db.file_native_write_locks(b.id.parse().unwrap()).is_ok());
}

#[test]
fn native_committed_journal_cleanup_replays_receipt_after_external_change() {
    let f = fixture();
    let (s, initial) = session(&f);
    let target = f.path.clone();
    WORKING_STAGE_HOOK.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move |stage| {
            if stage == 4 {
                fs::write(&target, b"later external content").unwrap();
            }
        }))
    });
    let result = save(&f, &s, &initial, "committed", "saved-receipt", 1000);
    WORKING_STAGE_HOOK.with(|hook| *hook.borrow_mut() = None);
    let saved = result.unwrap();
    f.db.file_working_recover_pending().unwrap();
    assert_eq!(
        save(&f, &s, &initial, "committed", "saved-receipt", 1000)
            .unwrap()
            .revision,
        saved.revision
    );
    assert_eq!(fs::read(&f.path).unwrap(), b"later external content");
    let pending: bool =
        f.db.conn
            .query_row(
                "SELECT journal IS NOT NULL FROM file_working_contents WHERE document_id=?1",
                [f.object.id.parse::<i64>().unwrap()],
                |r| r.get(0),
            )
            .unwrap();
    assert!(!pending);
    let recovery =
        f.db.file_working_recovery_read(&f.request, &f.binding, &f.object)
            .unwrap();
    use base64::Engine;
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(recovery.base64)
            .unwrap(),
        b"committed"
    );
}

#[test]
fn native_working_waiting_on_real_file_lease_does_not_block_workspace_close() {
    use crate::{
        committed_changes::{CommittedChangePublisher, CommittedChanges},
        file_version_service::{BoundFileCommitStore, FileCommitHost},
        source_service::BoundSourceStore,
        workspace_commit_fence::WorkspaceCommitFence,
    };
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    struct Store {
        root: PathBuf,
        db_path: PathBuf,
        binding: WorkspaceBinding,
        fence: Arc<WorkspaceCommitFence>,
    }
    impl CommittedChangePublisher for Store {
        fn publish_committed(&self, _: CommittedChanges) {}
    }
    impl BoundSourceStore for Store {
        fn with_current<T>(
            &self,
            action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
        ) -> AgentResult<T> {
            let db = Database::open_runtime_connection(&self.db_path, &self.root, None).unwrap();
            action(&self.binding, &db)
        }
    }
    impl BoundFileCommitStore for Store {
        fn gui_commit_host(&self, _: &WorkspaceBinding) -> AgentResult<FileCommitHost> {
            Ok(FileCommitHost::for_test(
                self.binding.clone(),
                crate::workspace::workspace_paths(&self.root),
                None,
                self.fence.clone(),
            ))
        }
    }
    let f = fixture();
    let _ = session(&f);
    let fence = Arc::new(WorkspaceCommitFence::new());
    // Version preparation owns the actual Project/File lease before admission.
    let project =
        f.db.file_project_lock(
            match f.object.scope {
                Scope::Project { project_id } => Some(project_id),
                _ => None,
            },
            false,
        )
        .unwrap();
    let file =
        f.db.file_version_lock(f.object.id.parse().unwrap())
            .unwrap();
    let store = Store {
        root: f.root.clone(),
        db_path: f.db_path.clone(),
        binding: f.binding.clone(),
        fence: fence.clone(),
    };
    let request = f.request.clone();
    let object = f.object.clone();
    let (attempt_tx, attempt_rx) = mpsc::channel();
    let working = std::thread::spawn(move || {
        files::FILE_LEASE_ATTEMPT.with(|hook| *hook.borrow_mut() = Some(attempt_tx));
        crate::file_working::with_db(&store, &request, |db| {
            db.file_working_open_status(&request, &request.binding, &object)
        })
    });
    attempt_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    let (close_tx, close_rx) = mpsc::channel();
    let closing_fence = fence.clone();
    let closing = std::thread::spawn(move || {
        closing_fence.invalidate();
        close_tx.send(()).unwrap();
    });
    let closed_without_file = close_rx.recv_timeout(Duration::from_secs(1)).is_ok();
    // On regression release the real lease before failing, so no orphan thread
    // can hang the runner. In the fixed order version admission rejects at once.
    if closed_without_file {
        assert_eq!(fence.enter().unwrap_err().code, ErrorCode::WorkspaceChanged);
    }
    drop(file);
    drop(project);
    let working_result = working.join().unwrap();
    closing.join().unwrap();
    assert!(
        closed_without_file,
        "working held the fence while waiting for a real File lease"
    );
    assert_eq!(
        working_result.unwrap_err().code,
        ErrorCode::WorkspaceChanged
    );
}

#[test]
fn native_global_working_recovery_does_not_hide_invalid_journal() {
    let f = fixture();
    let _ = session(&f);
    f.db.conn
        .execute(
            "UPDATE file_working_contents SET journal='{}' WHERE document_id=?1",
            [f.object.id.parse::<i64>().unwrap()],
        )
        .unwrap();
    assert!(f.db.file_working_recover_pending().is_err());
}

#[test]
fn native_external_write_after_durable_journal_keeps_actual_save_uncommitted() {
    let f = fixture();
    let (s, initial) = session(&f);
    let target = f.path.clone();
    WORKING_STAGE_HOOK.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move |stage| {
            if stage == 1 {
                fs::write(&target, b"external during save").unwrap();
            }
        }))
    });
    let result = save(
        &f,
        &s,
        &initial,
        "must not overwrite external",
        "interrupted",
        1000,
    );
    WORKING_STAGE_HOOK.with(|hook| *hook.borrow_mut() = None);
    assert_eq!(result.unwrap_err().code, ErrorCode::FileChangedUnregistered);
    assert_eq!(fs::read(&f.path).unwrap(), b"external during save");
    let bytes: Vec<u8> =
        f.db.conn
            .query_row(
                "SELECT bytes FROM file_working_contents WHERE document_id=?1",
                [f.object.id.parse::<i64>().unwrap()],
                |r| r.get(0),
            )
            .unwrap();
    assert_eq!(bytes, b"original");
    let receipt: Option<WorkingStatus> =
        f.db.agent_operation_replay(
            "gui",
            "interrupted",
            "file.working.save",
            &WorkingSaveText {
                object: f.object.clone(),
                session_id: s.session_id,
                expected_revision: initial.revision,
                expected_content_hash: initial.content_hash,
                text: "must not overwrite external".into(),
            },
        )
        .unwrap();
    assert!(receipt.is_none());
    f.db.file_working_recover_pending().unwrap();
    assert_eq!(
        f.db.file_working_require_archived(f.object.id.parse().unwrap())
            .unwrap_err()
            .code,
        ErrorCode::FileChangedUnregistered
    );
}

#[test]
fn native_close_waits_for_actual_working_save_already_in_commit() {
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    let f = fixture();
    let (s, initial) = session(&f);
    let fence = Arc::new(crate::workspace_commit_fence::WorkspaceCommitFence::new());
    let paths = crate::workspace::workspace_paths(&f.root);
    let host = crate::file_version_service::FileCommitHost::for_test(
        f.binding.clone(),
        paths,
        None,
        fence.clone(),
    );
    let request = f.request.clone();
    let binding = f.binding.clone();
    let (prepared_tx, prepared_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let db = host.database().unwrap();
        WORKING_STAGE_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move |stage| {
                if stage == 1 {
                    prepared_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
                }
            }))
        });
        db.file_working_save(
            &request,
            &binding,
            &s,
            initial.revision,
            &initial.content_hash,
            &"entered-save",
            b"entered commit",
            1000,
        )
    });
    prepared_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    let (attempt_tx, attempt_rx) = mpsc::channel();
    let (closed_tx, closed_rx) = mpsc::channel();
    let closing_fence = fence.clone();
    let closer = std::thread::spawn(move || {
        attempt_tx.send(()).unwrap();
        closing_fence.invalidate();
        closed_tx.send(()).unwrap();
    });
    attempt_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(closed_rx.recv_timeout(Duration::from_millis(50)).is_err());
    release_tx.send(()).unwrap();
    let saved = worker.join().unwrap().unwrap();
    closed_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    closer.join().unwrap();
    assert_eq!(saved.revision, 1);
    assert_eq!(fs::read(&f.path).unwrap(), b"entered commit");
    let replay: Option<WorkingStatus> =
        f.db.agent_operation_replay("gui", "open", "file.working.save", &"entered-save")
            .unwrap();
    assert_eq!(replay.unwrap().revision, saved.revision);
    assert_eq!(fence.enter().unwrap_err().code, ErrorCode::WorkspaceChanged);
}
