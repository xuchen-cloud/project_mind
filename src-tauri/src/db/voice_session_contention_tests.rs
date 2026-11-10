//! Real runtime connections and production draft creation; no audio or GUI.
use super::*;
use rusqlite::ffi;
use std::{
    ffi::{c_void, CStr},
    time::Duration,
};

fn fixture() -> (tempfile::TempDir, Database, Database, i64) {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("voice.sqlite");
    let ordinary = Database::open(&path, root.path(), None).unwrap();
    let project = ordinary
        .project_create(ProjectCreateInput {
            name: "Voice contention".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let voice = Database::open_runtime_connection(&path, root.path(), None).unwrap();
    assert_eq!(
        voice
            .conn
            .query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "delete"
    );
    (root, ordinary, voice, project.id)
}

#[derive(Clone, Copy)]
enum Interleave {
    AfterProjectRead,
    BeforeBegin { same_request: bool },
}

struct Hook {
    other: Database,
    interleave: Interleave,
    fired: bool,
    outcome: Option<Result<(), String>>,
}

// Use SQLite's existing trace API only in tests: rusqlite's optional trace feature
// is not enabled. PROFILE runs after the actual Project SELECT has established
// its read transaction; STMT runs before BEGIN obtains the write reservation.
unsafe extern "C" fn interleave(
    event: u32,
    context: *mut c_void,
    statement: *mut c_void,
    _: *mut c_void,
) -> std::ffi::c_int {
    let hook = &mut *(context as *mut Hook);
    if hook.fired {
        return 0;
    }
    let sql = ffi::sqlite3_sql(statement as *mut ffi::sqlite3_stmt);
    if sql.is_null() {
        return 0;
    }
    let sql = CStr::from_ptr(sql).to_string_lossy();
    let matches = match hook.interleave {
        Interleave::AfterProjectRead => {
            event == ffi::SQLITE_TRACE_PROFILE as u32
                && sql.starts_with("SELECT EXISTS(SELECT 1 FROM projects")
        }
        Interleave::BeforeBegin { .. } => {
            event == ffi::SQLITE_TRACE_STMT as u32 && sql.starts_with("BEGIN")
        }
    };
    if matches {
        hook.fired = true;
        hook.outcome = Some(match hook.interleave {
            Interleave::AfterProjectRead => hook.other.conn.execute_batch(
                "BEGIN IMMEDIATE; UPDATE projects SET summary = 'ordinary writer' WHERE kind = 'normal';"
            ).map_err(|e| e.to_string()),
            Interleave::BeforeBegin { same_request } => hook.other.voice_session_create(
                &RecordTarget::Workspace,
                if same_request { "request" } else { "other-request" },
                "other-session", "Other recording",
            ).map(|_| ()).map_err(|e| e.to_string()),
        });
    }
    0
}

// Unregister borrowed contexts even if a production assertion unwinds.
struct TraceReset(*mut ffi::sqlite3);
impl Drop for TraceReset {
    fn drop(&mut self) {
        unsafe {
            ffi::sqlite3_trace_v2(self.0, 0, None, std::ptr::null_mut());
        }
    }
}
struct BusyReset(*mut ffi::sqlite3);
impl Drop for BusyReset {
    fn drop(&mut self) {
        unsafe {
            ffi::sqlite3_busy_timeout(self.0, 5000);
        }
    }
}

fn create_with_hook(
    voice: &mut Database,
    hook: &mut Hook,
    target: &RecordTarget,
) -> Result<PersistedVoiceSession> {
    // The callback/context live until removal, execute synchronously on this
    // connection's thread, and access only the independent other connection.
    unsafe {
        assert_eq!(
            ffi::sqlite3_trace_v2(
                voice.conn.handle(),
                (ffi::SQLITE_TRACE_STMT | ffi::SQLITE_TRACE_PROFILE) as u32,
                Some(interleave),
                hook as *mut Hook as *mut c_void
            ),
            ffi::SQLITE_OK
        );
    }
    let _reset = TraceReset(unsafe { voice.conn.handle() });
    voice.voice_session_create(target, "request", "session", "Voice draft")
}

fn counts(db: &Database) -> (i64, i64, i64, i64) {
    db.conn.query_row("SELECT (SELECT COUNT(*) FROM notes), (SELECT COUNT(*) FROM workspace_notes), (SELECT COUNT(*) FROM voice_records), (SELECT COUNT(*) FROM recording_sessions)", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap()
}

#[test]
fn project_read_cannot_be_overtaken_by_an_independent_writer() {
    let (_root, ordinary, mut voice, project_id) = fixture();
    let before = counts(&voice);
    let mut hook = Hook {
        other: ordinary,
        interleave: Interleave::AfterProjectRead,
        fired: false,
        outcome: None,
    };
    hook.other.conn.busy_timeout(Duration::ZERO).unwrap();
    let result = create_with_hook(&mut voice, &mut hook, &RecordTarget::Project { project_id });
    assert!(
        hook.fired,
        "must interleave after the production Project read"
    );
    // Release the competing writer even on the red path, then check atomicity.
    if !hook.other.conn.is_autocommit() {
        hook.other.conn.execute_batch("ROLLBACK").unwrap();
    }
    if let Err(error) = &result {
        assert_eq!(
            counts(&voice),
            before,
            "failed start must leave no half draft"
        );
        assert_eq!(
            error
                .downcast_ref::<rusqlite::Error>()
                .unwrap()
                .sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseBusy)
        );
    }
    assert!(
        result.is_ok(),
        "Project SQLite start failed before audio capture: {result:?}"
    );
    assert_eq!(
        hook.outcome.unwrap().unwrap_err(),
        "database is locked",
        "draft must own the write reservation before Project SELECT"
    );
    let session = result.unwrap();
    assert!(session.project_note_id.is_some());
    assert_eq!(session.lifecycle, "preparing");
    assert_eq!(
        counts(&voice),
        (before.0 + 1, before.1, before.2 + 1, before.3 + 1)
    );
}

#[test]
fn workspace_control_has_no_project_read_upgrade() {
    let (_root, ordinary, mut voice, _) = fixture();
    let before = counts(&voice);
    let mut hook = Hook {
        other: ordinary,
        interleave: Interleave::AfterProjectRead,
        fired: false,
        outcome: None,
    };
    let session = create_with_hook(&mut voice, &mut hook, &RecordTarget::Workspace).unwrap();
    assert!(!hook.fired);
    assert!(session.workspace_note_id.is_some());
    assert!(session.project_note_id.is_none());
    assert_eq!(
        counts(&voice),
        (before.0, before.1 + 1, before.2 + 1, before.3 + 1)
    );
}

#[test]
fn request_replay_after_another_connection_wins_admission() {
    let (_root, ordinary, mut voice, _) = fixture();
    let mut hook = Hook {
        other: ordinary,
        interleave: Interleave::BeforeBegin { same_request: true },
        fired: false,
        outcome: None,
    };
    let result = create_with_hook(&mut voice, &mut hook, &RecordTarget::Workspace);
    assert!(hook.fired);
    assert!(hook.outcome.unwrap().is_ok());
    let session = result.expect("same request committed by another connection must replay");
    assert_eq!(session.session_id, "other-session");
    assert_eq!(counts(&voice), (0, 1, 1, 1));
}

#[test]
fn another_connection_winning_admission_keeps_one_recording_owner() {
    let (_root, ordinary, mut voice, _) = fixture();
    let mut hook = Hook {
        other: ordinary,
        interleave: Interleave::BeforeBegin {
            same_request: false,
        },
        fired: false,
        outcome: None,
    };
    let result = create_with_hook(&mut voice, &mut hook, &RecordTarget::Workspace);
    assert!(hook.fired);
    assert!(hook.outcome.unwrap().is_ok());
    assert_eq!(
        result.unwrap_err().to_string(),
        "an unfinished recording session already exists"
    );
    assert_eq!(counts(&voice), (0, 1, 1, 1));
}

#[test]
fn failed_session_insert_rolls_back_both_draft_types_and_can_retry() {
    for project in [false, true] {
        let (_root, ordinary, mut voice, project_id) = fixture();
        let target = if project {
            RecordTarget::Project { project_id }
        } else {
            RecordTarget::Workspace
        };
        let before = counts(&voice);
        ordinary.conn.execute_batch("CREATE TRIGGER fail_voice_start BEFORE INSERT ON recording_sessions BEGIN SELECT RAISE(ABORT, 'injected start failure'); END;").unwrap();
        let error = voice
            .voice_session_create(&target, "retry", "retry-session", "Voice")
            .unwrap_err();
        assert!(error.to_string().contains("injected start failure"));
        assert_eq!(counts(&ordinary), before);
        assert!(voice.voice_session_by_request("retry").unwrap().is_none());
        assert!(voice.conn.is_autocommit());
        ordinary
            .conn
            .execute_batch("DROP TRIGGER fail_voice_start")
            .unwrap();
        let session = voice
            .voice_session_create(&target, "retry", "retry-session", "Voice")
            .unwrap();
        let after = counts(&ordinary);
        let replay = voice
            .voice_session_create(&target, "retry", "ignored-session", "Ignored")
            .unwrap();
        assert_eq!(session.session_id, replay.session_id);
        assert_eq!(counts(&ordinary), after);
        assert!(voice
            .voice_session_create(&target, "second", "second-session", "Second")
            .is_err());
        assert_eq!(counts(&ordinary), after);
    }
}

struct WaitingWriter {
    other: Database,
    waited: bool,
    commit_error: Option<String>,
}

unsafe extern "C" fn release_writer(
    context: *mut c_void,
    attempts: std::ffi::c_int,
) -> std::ffi::c_int {
    let writer = &mut *(context as *mut WaitingWriter);
    writer.waited = true;
    if attempts != 0 {
        return 0;
    }
    writer.commit_error = writer
        .other
        .conn
        .execute_batch("COMMIT")
        .err()
        .map(|e| e.to_string());
    i32::from(writer.commit_error.is_none())
}

#[test]
fn existing_writer_can_commit_before_project_or_workspace_start_reads() {
    for project in [false, true] {
        let (_root, ordinary, mut voice, project_id) = fixture();
        assert_eq!(
            voice
                .conn
                .query_row("PRAGMA busy_timeout", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            5000
        );
        ordinary.conn.execute_batch("BEGIN IMMEDIATE; UPDATE projects SET summary = 'committed before voice' WHERE kind = 'normal';").unwrap();
        let mut writer = WaitingWriter {
            other: ordinary,
            waited: false,
            commit_error: None,
        };
        // Deterministically release a real competing transaction when SQLite
        // invokes its busy handler, without sleeps or scheduler assumptions.
        unsafe {
            assert_eq!(
                ffi::sqlite3_busy_handler(
                    voice.conn.handle(),
                    Some(release_writer),
                    &mut writer as *mut WaitingWriter as *mut c_void
                ),
                ffi::SQLITE_OK
            );
        }
        let reset = BusyReset(unsafe { voice.conn.handle() });
        let target = if project {
            RecordTarget::Project { project_id }
        } else {
            RecordTarget::Workspace
        };
        let result = voice.voice_session_create(&target, "wait", "wait-session", "Voice");
        drop(reset);
        assert!(writer.waited, "SQLite must wait for the existing writer");
        assert_eq!(
            writer.commit_error, None,
            "voice must not hold a read lock while waiting for admission"
        );
        let session = result.unwrap();
        assert_eq!(session.lifecycle, "preparing");
        assert_eq!(
            writer
                .other
                .conn
                .query_row(
                    "SELECT summary FROM projects WHERE id = ?1",
                    [project_id],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "committed before voice"
        );
    }
}

#[test]
fn exhausted_writer_wait_leaves_no_draft_and_allows_explicit_retry() {
    for project in [false, true] {
        let (_root, ordinary, mut voice, project_id) = fixture();
        let target = if project {
            RecordTarget::Project { project_id }
        } else {
            RecordTarget::Workspace
        };
        let before = counts(&voice);
        ordinary.conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        voice.conn.busy_timeout(Duration::ZERO).unwrap();
        let error = voice
            .voice_session_create(&target, "wait", "wait-session", "Voice")
            .unwrap_err();
        assert_eq!(
            error
                .downcast_ref::<rusqlite::Error>()
                .unwrap()
                .sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseBusy)
        );
        assert!(voice.conn.is_autocommit());
        assert_eq!(counts(&ordinary), before);
        ordinary.conn.execute_batch("ROLLBACK").unwrap();
        assert!(voice
            .voice_session_create(&target, "wait", "wait-session", "Voice")
            .is_ok());
    }
}

#[test]
fn nonexistent_project_leaves_no_draft() {
    let (_root, ordinary, mut voice, _) = fixture();
    let before = counts(&ordinary);
    let error = voice
        .voice_session_create(
            &RecordTarget::Project {
                project_id: i64::MAX,
            },
            "missing",
            "missing-session",
            "Voice",
        )
        .unwrap_err();
    assert_eq!(error.to_string(), "Project does not exist");
    assert!(voice.conn.is_autocommit());
    assert_eq!(counts(&ordinary), before);
}
