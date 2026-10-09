use super::*;
use crate::models::{ProjectArchiveInput, ProjectCreateInput, ProjectUpdateInput};
use rusqlite::params;

struct Fixture {
    root: tempfile::TempDir,
    db: Database,
    binding: WorkspaceBinding,
    scope: Scope,
}
fn at(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .unwrap()
        .with_timezone(&Utc)
}
fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(&root.path().join("schedule.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace("schedule-ws").unwrap();
    let id = db
        .project_create(ProjectCreateInput {
            name: "Scheduled".into(),
            summary: None,
            status: None,
        })
        .unwrap()
        .id;
    let scope = Scope::Project { project_id: id };
    db.conn.execute("INSERT INTO agent_scope_settings(scope_key,enabled,overview_local_time,overview_timezone) VALUES (?1,1,'03:00','UTC')", [scope.key()]).unwrap();
    db.agent_overviews_prepare().unwrap();
    db.conn
        .execute(
            "DELETE FROM agent_overview_pending WHERE scope_key=?1",
            [scope.key()],
        )
        .unwrap();
    db.conn.execute("INSERT INTO agent_overview_pending_state(scope_key,needs_rebuild) VALUES (?1,0) ON CONFLICT(scope_key) DO UPDATE SET needs_rebuild=0", [scope.key()]).unwrap();
    Fixture {
        root,
        db,
        binding: WorkspaceBinding {
            workspace_id: "schedule-ws".into(),
            generation: "one".into(),
        },
        scope,
    }
}
fn dirty(f: &Fixture) {
    f.db.conn
        .execute(
            "UPDATE agent_overview_pending_state SET needs_rebuild=1 WHERE scope_key=?1",
            [f.scope.key()],
        )
        .unwrap();
}

#[test]
fn saving_schedule_retimes_future_due_and_survives_reopen() {
    use crate::agent::settings::SettingsUpdate;
    let f = fixture();
    let now = Utc::now();
    f.db.overview_schedule_next(&f.binding, now).unwrap();
    f.db.overview_schedule_finished(&f.binding, &f.scope, false, now).unwrap();
    let old_due = f.db.overview_schedule_status(&f.binding, &f.scope, now).unwrap().next_run_at.unwrap();
    let mut settings = f.db.agent_settings_get(&f.scope).unwrap();
    settings.overview_interval_hours = 48;
    settings.overview_timezone = "Asia/Shanghai".into();
    let expected_revision = settings.revision;
    let saved = f.db.agent_settings_update("schedule-test", "retime", &SettingsUpdate { settings, expected_revision }).unwrap();
    assert_eq!(saved.overview_interval_hours, 48);
    let due = f.db.overview_schedule_status(&f.binding, &f.scope, Utc::now()).unwrap().next_run_at.unwrap();
    assert_ne!(due, old_due);
    let local = due.with_timezone(&chrono_tz::Asia::Shanghai);
    assert_eq!(local.format("%H:%M").to_string(), "03:00");
    assert_eq!(local.date_naive(), now.with_timezone(&chrono_tz::Asia::Shanghai).date_naive() + chrono::Duration::days(2));
    let root = f.root.path().to_path_buf();
    drop(f.db);
    let mut reopened = Database::open(&root.join("schedule.sqlite"), &root, None).unwrap();
    reopened.bind_native_workspace("schedule-ws").unwrap();
    assert_eq!(reopened.agent_settings_get(&f.scope).unwrap().overview_timezone, "Asia/Shanghai");
    assert_eq!(reopened.overview_schedule_status(&f.binding, &f.scope, Utc::now()).unwrap().next_run_at, Some(due));
}

#[test]
fn zero_dirty_skips_model_and_missed_days_coalesce_to_one_due_cycle() {
    for interval in [24, 48] {
        let f = fixture();
        let now = at("2026-10-08T12:00:00Z");
        f.db.conn
            .execute(
                "UPDATE agent_scope_settings SET overview_interval_hours=?1 WHERE scope_key=?2",
                params![interval, f.scope.key()],
            )
            .unwrap();
        assert_eq!(
            f.db.overview_schedule_next(&f.binding, now).unwrap(),
            Some(f.scope.clone())
        );
        f.db.overview_schedule_finished(&f.binding, &f.scope, false, now)
            .unwrap();
        assert!(f
            .db
            .overview_schedule_next(&f.binding, now)
            .unwrap()
            .is_none());
        let status =
            f.db.overview_schedule_status(&f.binding, &f.scope, now)
                .unwrap();
        assert_eq!(
            status.next_run_at.unwrap(),
            at(if interval == 24 {
                "2026-10-09T03:00:00Z"
            } else {
                "2026-10-10T03:00:00Z"
            })
        );
        dirty(&f);
        let late = at("2026-10-20T12:00:00Z");
        assert_eq!(
            f.db.overview_schedule_next(&f.binding, late).unwrap(),
            Some(f.scope.clone())
        );
        f.db.overview_schedule_finished(&f.binding, &f.scope, false, late)
            .unwrap();
        assert!(f
            .db
            .overview_schedule_next(&f.binding, late)
            .unwrap()
            .is_none());
        assert_eq!(
            f.db.overview_schedule_status(&f.binding, &f.scope, late)
                .unwrap()
                .next_run_at
                .unwrap(),
            at(if interval == 24 {
                "2026-10-21T03:00:00Z"
            } else {
                "2026-10-22T03:00:00Z"
            })
        );
    }
}

#[test]
fn foreground_and_archived_project_block_selection() {
    let f = fixture();
    dirty(&f);
    let now = at("2026-10-08T12:00:00Z");
    f.db.conn.execute("INSERT INTO agent_sessions(id,scope_key,title,runtime_id,state,session_path,created_at,updated_at) VALUES (?1,?2,'busy','pi','active',?3,?4,?4)", params!["a".repeat(32),f.scope.key(),format!(".project-mind/agent/sessions/{}/session.jsonl","a".repeat(32)),stamp(now)]).unwrap();
    f.db.conn.execute("INSERT INTO agent_runs(id,session_id,client_request_id,state,context_manifest_json,grant_json,started_at) VALUES (?1,?2,'busy','running','{}','{}',?3)", params!["b".repeat(32),"a".repeat(32),stamp(now)]).unwrap();
    assert!(f
        .db
        .overview_schedule_next(&f.binding, now)
        .unwrap()
        .is_none());
    assert!(
        f.db.overview_schedule_status(&f.binding, &f.scope, now)
            .unwrap()
            .foreground_busy
    );
    f.db.conn
        .execute(
            "UPDATE agent_runs SET state='completed' WHERE id=?1",
            ["b".repeat(32)],
        )
        .unwrap();
    assert_eq!(
        f.db.overview_schedule_next(&f.binding, now).unwrap(),
        Some(f.scope.clone())
    );
    f.db.project_set_archive(ProjectArchiveInput {
        project_id: match &f.scope {
            Scope::Project { project_id } => *project_id,
            _ => unreachable!(),
        },
        is_archived: true,
    })
    .unwrap();
    assert!(f
        .db
        .overview_schedule_next(&f.binding, now)
        .unwrap()
        .is_none());
}

#[test]
fn paused_scope_does_not_starve_another_due_project() {
    let f = fixture();
    let now = at("2026-10-08T12:00:00Z");
    dirty(&f);
    let second_id =
        f.db.project_create(ProjectCreateInput {
            name: "Second".into(),
            summary: None,
            status: None,
        })
        .unwrap()
        .id;
    let second = Scope::Project {
        project_id: second_id,
    };
    f.db.conn
        .execute(
            "INSERT INTO agent_scope_settings(scope_key,enabled) VALUES (?1,1)",
            [second.key()],
        )
        .unwrap();
    f.db.conn.execute("INSERT INTO agent_jobs(id,kind,scope_key,dedupe_key,state,not_before,payload_json) VALUES (?1,'overview',?2,?1,'failed',?3,'{}')", params![worker_key(&f.scope),f.scope.key(),stamp(now)]).unwrap();
    assert_eq!(
        f.db.overview_schedule_next(&f.binding, now).unwrap(),
        Some(second)
    );
}

#[test]
fn persisted_running_worker_is_selected_after_restart() {
    let f = fixture();
    let now = at("2026-10-08T12:00:00Z");
    dirty(&f);
    f.db.conn.execute("INSERT INTO agent_jobs(id,kind,scope_key,dedupe_key,state,not_before,payload_json) VALUES (?1,'overview',?2,?1,'running',?3,'{}')", params![worker_key(&f.scope),f.scope.key(),stamp(now)]).unwrap();
    let path = f.root.path().join("schedule.sqlite");
    let mut reopened = Database::open(&path, f.root.path(), None).unwrap();
    reopened.bind_native_workspace("schedule-ws").unwrap();
    assert_eq!(
        reopened.overview_schedule_next(&f.binding, now).unwrap(),
        Some(f.scope)
    );
}

#[test]
fn repeated_attempts_have_only_a_per_request_input_boundary() {
    let f = fixture();
    let now = at("2026-10-08T12:00:00Z");
    f.db.overview_schedule_request(&f.binding, &f.scope, now)
        .unwrap();
    for _ in 0..6 {
        assert!(f
            .db
            .overview_schedule_reserve(&f.binding, &f.scope, "same-batch", 30_000, now)
            .unwrap());
    }
    assert!(f
        .db
        .overview_schedule_reserve(&f.binding, &f.scope, "replacement", 48_000, now)
        .unwrap());
    assert_eq!(
        f.db.overview_schedule_reserve(&f.binding, &f.scope, "replacement", 48_001, now)
            .unwrap_err()
            .code,
        ErrorCode::BudgetExceeded
    );
    let schedule = read_schedule(&f.db.conn, &f.binding, &f.scope)
        .unwrap()
        .unwrap();
    assert_eq!(schedule.batch_id.as_deref(), Some("replacement"));
    assert!(
        !f.db
            .overview_schedule_status(&f.binding, &f.scope, now)
            .unwrap()
            .budget_exhausted
    );
}

#[test]
fn controller_keeps_failed_batch_until_manual_resume_and_preserves_pending() {
    let f = fixture();
    let now = at("2026-10-08T12:00:00Z");
    let project_id = match &f.scope {
        Scope::Project { project_id } => *project_id,
        _ => unreachable!(),
    };
    f.db.project_update(ProjectUpdateInput {
        project_id,
        name: None,
        summary: "Pending Overview source".into(),
        summary_markdown: None,
        summary_html: None,
        summary_code_language: None,
        status: None,
    })
    .unwrap();
    assert!(f
        .db
        .overview_schedule_request(&f.binding, &f.scope, now)
        .unwrap());
    let first =
        f.db.agent_overview_maintenance_prepare(&f.binding, &f.scope, now)
            .unwrap()
            .unwrap();
    let pending_before =
        f.db.agent_overview_maintenance_status(&f.binding, &f.scope)
            .unwrap()
            .pending_count;
    assert!(pending_before > 0);

    for attempt in 0..6 {
        assert!(f
            .db
            .overview_schedule_reserve(&f.binding, &f.scope, &first.batch_id, 30_000, now)
            .unwrap());
        f.db.agent_overview_maintenance_fail(
            &f.binding,
            &f.scope,
            &first.batch_id,
            ErrorCode::IoFailed,
            now,
        )
        .unwrap();
        f.db.agent_overview_maintenance_resume_waiting(&f.binding, now + Duration::minutes(21))
            .unwrap();
        let paused =
            f.db.agent_overview_maintenance_status(&f.binding, &f.scope)
                .unwrap();
        assert_eq!(paused.error_code, Some(ErrorCode::IoFailed));
        assert_eq!(paused.pending_count, pending_before);
        assert!(f
            .db
            .agent_overview_maintenance_prepare(&f.binding, &f.scope, now)
            .unwrap()
            .is_none());
        f.db.agent_overview_maintenance_resume(
            &f.binding,
            &f.scope,
            now + Duration::minutes(attempt),
        )
        .unwrap();
        assert_eq!(
            f.db.agent_overview_maintenance_prepare(&f.binding, &f.scope, now)
                .unwrap()
                .unwrap()
                .batch_id,
            first.batch_id
        );
    }
    let next =
        f.db.agent_overview_maintenance_prepare(&f.binding, &f.scope, now)
            .unwrap()
            .unwrap();
    assert_eq!(next.source.object_key, first.source.object_key);
    assert_eq!(next.source_cursor, first.source_cursor);
    let later = now + Duration::minutes(21);
    f.db.agent_overview_maintenance_cancel(&f.binding, &f.scope, later)
        .unwrap();
    f.db.agent_overview_maintenance_resume_waiting(&f.binding, later + Duration::minutes(21))
        .unwrap();
    let cancelled =
        f.db.agent_overview_maintenance_status(&f.binding, &f.scope)
            .unwrap();
    assert!(cancelled.cancelled);
    assert_eq!(cancelled.batch_id.as_deref(), Some(first.batch_id.as_str()));
    assert!(f
        .db
        .agent_overview_maintenance_prepare(&f.binding, &f.scope, later + Duration::minutes(21))
        .unwrap()
        .is_none());
}

#[test]
fn reservations_survive_reopen_and_old_window_wait_does_not_block_new_batch() {
    let f = fixture();
    let now = at("2026-10-08T12:00:00Z");
    assert!(f
        .db
        .overview_schedule_request(&f.binding, &f.scope, now)
        .unwrap());
    for _ in 0..6 {
        assert!(f
            .db
            .overview_schedule_reserve(&f.binding, &f.scope, "batch-one", 30_000, now)
            .unwrap());
    }
    let path = f.root.path().join("schedule.sqlite");
    let mut reopened = Database::open(&path, f.root.path(), None).unwrap();
    reopened.bind_native_workspace("schedule-ws").unwrap();
    assert!(
        !reopened
            .overview_schedule_status(&f.binding, &f.scope, now)
            .unwrap()
            .budget_exhausted
    );
    let mut legacy = read_schedule(&reopened.conn, &f.binding, &f.scope)
        .unwrap()
        .unwrap();
    legacy.wait_until = now.timestamp() + 86_400;
    save_schedule(&reopened.conn, &f.binding, &f.scope, &legacy, now).unwrap();
    assert_eq!(
        reopened.overview_schedule_next(&f.binding, now).unwrap(),
        Some(f.scope.clone())
    );
    reopened
        .overview_schedule_finished(&f.binding, &f.scope, true, now)
        .unwrap();
    assert!(reopened
        .overview_schedule_reserve(&f.binding, &f.scope, "batch-two", 1, now)
        .unwrap());
    // Many successful batches can continue on the same day after a restart.
    for page in 0..24 {
        reopened
            .overview_schedule_finished(&f.binding, &f.scope, true, now)
            .unwrap();
        assert!(reopened
            .overview_schedule_reserve(&f.binding, &f.scope, &format!("batch-{page}"), 1, now)
            .unwrap());
    }
    let status = reopened
        .overview_schedule_status(&f.binding, &f.scope, now)
        .unwrap();
    assert!(!status.budget_exhausted);
    reopened
        .overview_schedule_finished(&f.binding, &f.scope, true, now)
        .unwrap();
    assert_eq!(
        reopened.overview_schedule_next(&f.binding, now).unwrap(),
        Some(f.scope.clone())
    );
}

#[test]
fn local_slots_handle_dst_fold_and_gap() {
    let zone: chrono_tz::Tz = "America/New_York".parse().unwrap();
    assert_eq!(
        local_slot(
            NaiveDate::from_ymd_opt(2026, 11, 1).unwrap(),
            NaiveTime::from_hms_opt(1, 30, 0).unwrap(),
            zone
        )
        .unwrap(),
        at("2026-11-01T05:30:00Z")
    );
    assert_eq!(
        local_slot(
            NaiveDate::from_ymd_opt(2026, 3, 8).unwrap(),
            NaiveTime::from_hms_opt(2, 30, 0).unwrap(),
            zone
        )
        .unwrap(),
        at("2026-03-08T07:00:00Z")
    );
}

#[test]
fn clean_overview_schedules_unscanned_and_unseeded_history_only_until_caught_up() {
    let f = fixture();
    let first = at("2026-10-08T12:00:00Z");
    assert_eq!(
        f.db.overview_schedule_next(&f.binding, first).unwrap(),
        Some(f.scope.clone())
    );
    f.db.overview_schedule_finished(&f.binding, &f.scope, false, first)
        .unwrap();
    let session = "c".repeat(32);
    let checksum = format!("sha256:{}", "a".repeat(64));
    let checkpoint = serde_json::json!({"checksum":checksum,"entryCount":1}).to_string();
    f.db.conn.execute("INSERT INTO agent_sessions(id,scope_key,title,runtime_id,state,session_path,checkpoint_json,created_at,updated_at) VALUES (?1,?2,'Old history','builtin-pi','active',?3,?4,'now','now')",params![session,f.scope.key(),format!(".project-mind/agent/sessions/{session}/session.jsonl"),checkpoint]).unwrap();
    assert!(f.db.agent_session_maintenance_pending(&f.scope).unwrap());
    let scan_due = at("2026-10-09T12:00:00Z");
    assert_eq!(
        f.db.overview_schedule_next(&f.binding, scan_due).unwrap(),
        Some(f.scope.clone())
    );
    f.db.conn.execute("INSERT INTO agent_session_scan_state(session_id,checksum,entry_count,complete) VALUES (?1,?2,1,1)",params![session,checksum]).unwrap();
    f.db.overview_schedule_finished(&f.binding, &f.scope, false, scan_due)
        .unwrap();
    let clean_due = at("2026-10-10T12:00:00Z");
    assert!(f
        .db
        .overview_schedule_next(&f.binding, clean_due)
        .unwrap()
        .is_none());
    let message_id = "d".repeat(32);
    let text_hash = format!("sha256:{}", "b".repeat(64));
    f.db.conn.execute("INSERT INTO agent_session_search_rows(message_id,session_id,runtime_entry_id,ordinal,role,created_at,text_hash,text,total_chars,complete) VALUES (?1,?2,'old-entry',0,'user','now',?3,'legacy',6,1)",params![message_id,session,text_hash]).unwrap();
    assert!(f.db.agent_session_maintenance_pending(&f.scope).unwrap());
    let seed_due = at("2026-10-11T12:00:00Z");
    assert_eq!(
        f.db.overview_schedule_next(&f.binding, seed_due).unwrap(),
        Some(f.scope.clone())
    );
    assert!(!f
        .db
        .agent_session_maintenance_seed(&f.binding, &f.scope, 200)
        .unwrap());
    assert!(!f.db.agent_session_maintenance_pending(&f.scope).unwrap());
    f.db.conn
        .execute(
            "DELETE FROM agent_overview_pending WHERE scope_key=?1",
            [f.scope.key()],
        )
        .unwrap();
    f.db.conn
        .execute(
            "UPDATE agent_overview_pending_state SET needs_rebuild=0 WHERE scope_key=?1",
            [f.scope.key()],
        )
        .unwrap();
    f.db.overview_schedule_finished(&f.binding, &f.scope, false, seed_due)
        .unwrap();
    assert!(f
        .db
        .overview_schedule_next(&f.binding, at("2026-10-12T12:00:00Z"))
        .unwrap()
        .is_none());
}

fn session_pending(f: &Fixture, message_id: &str, revision: &str) {
    let key = format!(
        "{}/{}/session_message/{message_id}",
        f.binding.workspace_id,
        f.scope.key()
    );
    f.db.conn.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES (?1,?2,'session.message.index',?3,'now')",params![key,f.scope.key(),revision]).unwrap();
}

#[test]
fn session_summary_has_no_daily_cap_and_ignores_legacy_quota_row() {
    let f = fixture();
    f.db.conn
        .execute(
            "DELETE FROM agent_overview_pending WHERE scope_key=?1",
            [f.scope.key()],
        )
        .unwrap();
    session_pending(&f, &"a".repeat(32), "hash");
    let now = at("2026-10-08T12:00:00Z");
    let legacy_key = format!(
        "overview-session-daily:{}/{}",
        f.binding.workspace_id,
        f.scope.key()
    );
    f.db.conn.execute("INSERT INTO agent_jobs(id,kind,scope_key,dedupe_key,state,not_before,payload_json) VALUES (?1,'maintenance',?2,?1,'completed','now','{\"date\":\"2026-10-08\",\"calls\":5}')", params![legacy_key, f.scope.key()]).unwrap();
    f.db.overview_schedule_request(&f.binding, &f.scope, now)
        .unwrap();
    let batch =
        f.db.agent_overview_maintenance_prepare(&f.binding, &f.scope, now)
            .unwrap()
            .unwrap();
    assert_eq!(
        batch.source_object.kind,
        crate::agent::models::ObjectKind::SessionMessage
    );
    for page in 0..25 {
        assert!(f
            .db
            .overview_schedule_reserve(
                &f.binding,
                &f.scope,
                &format!("session-page-{page}"),
                1,
                now
            )
            .unwrap());
        f.db.overview_schedule_finished(&f.binding, &f.scope, true, now)
            .unwrap();
    }
    assert!(f
        .db
        .agent_overview_maintenance_prepare(&f.binding, &f.scope, now)
        .unwrap()
        .is_some());
    assert!(
        !f.db
            .overview_schedule_status(&f.binding, &f.scope, now)
            .unwrap()
            .budget_exhausted
    );
}

#[test]
fn shared_legacy_workspace_window_does_not_block_another_project() {
    let f = fixture();
    let now = at("2026-10-08T12:00:00Z");
    let second_id =
        f.db.project_create(ProjectCreateInput {
            name: "Second".into(),
            summary: None,
            status: None,
        })
        .unwrap()
        .id;
    let second = Scope::Project {
        project_id: second_id,
    };
    f.db.conn
        .execute(
            "INSERT INTO agent_scope_settings(scope_key,enabled) VALUES (?1,1)",
            [second.key()],
        )
        .unwrap();
    let legacy_key = format!("overview-budget:{}", f.binding.workspace_id);
    f.db.conn.execute("INSERT INTO agent_jobs(id,kind,scope_key,dedupe_key,state,not_before,payload_json) VALUES (?1,'maintenance','workspace',?1,'completed','now','{\"windowStart\":0,\"calls\":20}')", [legacy_key]).unwrap();
    f.db.overview_schedule_request(&f.binding, &f.scope, now)
        .unwrap();
    f.db.overview_schedule_request(&f.binding, &second, now)
        .unwrap();
    assert_eq!(
        f.db.overview_schedule_next(&f.binding, now).unwrap(),
        Some(f.scope.clone())
    );
    for page in 0..21 {
        assert!(f
            .db
            .overview_schedule_reserve(&f.binding, &f.scope, &format!("page-{page}"), 1, now)
            .unwrap());
        f.db.overview_schedule_finished(&f.binding, &f.scope, true, now)
            .unwrap();
    }
    assert_eq!(
        f.db.overview_schedule_next(&f.binding, now).unwrap(),
        Some(second.clone())
    );
    assert!(f
        .db
        .overview_schedule_reserve(&f.binding, &second, "new-content", 1, now)
        .unwrap());
}
