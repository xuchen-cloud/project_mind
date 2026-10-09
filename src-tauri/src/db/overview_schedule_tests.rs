use super::*;
use crate::models::{ProjectArchiveInput, ProjectCreateInput, ProjectUpdateInput};

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
fn new_batch_resets_its_allowance_without_resetting_workspace_window() {
    let f = fixture();
    let now = at("2026-10-08T12:00:00Z");
    assert!(f
        .db
        .overview_schedule_request(&f.binding, &f.scope, now)
        .unwrap());
    for _ in 0..3 {
        assert!(f
            .db
            .overview_schedule_reserve(&f.binding, &f.scope, "abandoned", 16_000, now)
            .unwrap());
    }
    assert!(!f
        .db
        .overview_schedule_reserve(&f.binding, &f.scope, "abandoned", 1, now)
        .unwrap());
    assert!(f
        .db
        .overview_schedule_reserve(&f.binding, &f.scope, "replacement", 1, now)
        .unwrap());
    let budget = read_budget(&f.db.conn, &f.binding, now).unwrap();
    let schedule = read_schedule(&f.db.conn, &f.binding, &f.scope)
        .unwrap()
        .unwrap();
    assert_eq!(budget.calls, 4);
    assert_eq!(schedule.batch_id.as_deref(), Some("replacement"));
    assert_eq!((schedule.calls, schedule.input_chars), (1, 1));
}

#[test]
fn insufficient_remaining_characters_waits_then_allows_a_new_batch() {
    let f = fixture();
    let now = at("2026-10-08T12:00:00Z");
    assert!(f
        .db
        .overview_schedule_request(&f.binding, &f.scope, now)
        .unwrap());
    assert!(f
        .db
        .overview_schedule_reserve(&f.binding, &f.scope, "too-large", 30_000, now)
        .unwrap());
    assert!(!f
        .db
        .overview_schedule_reserve(&f.binding, &f.scope, "too-large", 19_000, now)
        .unwrap());
    let status =
        f.db.overview_schedule_status(&f.binding, &f.scope, now)
            .unwrap();
    assert!(status.budget_exhausted);
    assert_eq!(status.next_run_at, Some(now + Duration::minutes(20)));
    assert!(f
        .db
        .overview_schedule_next(&f.binding, now)
        .unwrap()
        .is_none());
    let later = now + Duration::minutes(21);
    assert!(
        !f.db
            .overview_schedule_status(&f.binding, &f.scope, later)
            .unwrap()
            .budget_exhausted
    );
    assert_eq!(
        f.db.overview_schedule_next(&f.binding, later).unwrap(),
        Some(f.scope.clone())
    );
    assert!(f
        .db
        .overview_schedule_reserve(&f.binding, &f.scope, "next-window", 19_000, later)
        .unwrap());
}

#[test]
fn controller_resumes_quota_paused_pending_batch_after_window_and_keeps_manual_cancel() {
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

    // Completed page batches in this Workspace have already spent 19 calls.
    for page in 0..19 {
        assert!(f
            .db
            .overview_schedule_reserve(&f.binding, &f.scope, &format!("prior-page-{page}"), 1, now)
            .unwrap());
        f.db.overview_schedule_finished(&f.binding, &f.scope, true, now)
            .unwrap();
    }
    assert!(f
        .db
        .overview_schedule_reserve(&f.binding, &f.scope, &first.batch_id, 1, now)
        .unwrap());
    assert!(!f
        .db
        .overview_schedule_reserve(&f.binding, &f.scope, &first.batch_id, 1, now)
        .unwrap());
    f.db.agent_overview_maintenance_fail(
        &f.binding,
        &f.scope,
        &first.batch_id,
        ErrorCode::RateLimited,
        now,
    )
    .unwrap();
    f.db.agent_overview_maintenance_resume_waiting(&f.binding, now + Duration::minutes(19))
        .unwrap();
    let paused =
        f.db.agent_overview_maintenance_status(&f.binding, &f.scope)
            .unwrap();
    assert_eq!(paused.error_code, Some(ErrorCode::RateLimited));
    assert_eq!(paused.batch_id.as_deref(), Some(first.batch_id.as_str()));
    assert_eq!(paused.pending_count, pending_before);

    let later = now + Duration::minutes(21);
    f.db.agent_overview_maintenance_resume_waiting(&f.binding, later)
        .unwrap();
    let resumed =
        f.db.agent_overview_maintenance_status(&f.binding, &f.scope)
            .unwrap();
    assert_eq!(resumed.error_code, None);
    assert_eq!(resumed.pending_count, pending_before);
    let next =
        f.db.agent_overview_maintenance_prepare(&f.binding, &f.scope, later)
            .unwrap()
            .unwrap();
    assert_ne!(next.batch_id, first.batch_id);
    assert_eq!(next.source.object_key, first.source.object_key);
    assert_eq!(next.source_cursor, first.source_cursor);
    assert!(f
        .db
        .overview_schedule_reserve(&f.binding, &f.scope, &next.batch_id, 1, later)
        .unwrap());

    f.db.agent_overview_maintenance_cancel(&f.binding, &f.scope, later)
        .unwrap();
    f.db.agent_overview_maintenance_resume_waiting(&f.binding, later + Duration::minutes(21))
        .unwrap();
    let cancelled =
        f.db.agent_overview_maintenance_status(&f.binding, &f.scope)
            .unwrap();
    assert!(cancelled.cancelled);
    assert_eq!(cancelled.batch_id.as_deref(), Some(next.batch_id.as_str()));
    assert!(f
        .db
        .agent_overview_maintenance_prepare(&f.binding, &f.scope, later + Duration::minutes(21))
        .unwrap()
        .is_none());
}

#[test]
fn reservations_survive_reopen_and_recover_at_window_and_batch_boundary() {
    let f = fixture();
    let now = at("2026-10-08T12:00:00Z");
    assert!(f
        .db
        .overview_schedule_request(&f.binding, &f.scope, now)
        .unwrap());
    for _ in 0..3 {
        assert!(f
            .db
            .overview_schedule_reserve(&f.binding, &f.scope, "batch-one", 16_000, now)
            .unwrap());
    }
    assert!(!f
        .db
        .overview_schedule_reserve(&f.binding, &f.scope, "batch-one", 1, now)
        .unwrap());
    let path = f.root.path().join("schedule.sqlite");
    let mut reopened = Database::open(&path, f.root.path(), None).unwrap();
    reopened.bind_native_workspace("schedule-ws").unwrap();
    assert!(
        reopened
            .overview_schedule_status(&f.binding, &f.scope, now)
            .unwrap()
            .budget_exhausted
    );
    reopened
        .overview_schedule_finished(&f.binding, &f.scope, true, now)
        .unwrap();
    assert!(reopened
        .overview_schedule_reserve(&f.binding, &f.scope, "batch-two", 1, now)
        .unwrap());
    // Drive the workspace cap with distinct page batches.
    for page in 0..16 {
        reopened
            .overview_schedule_finished(&f.binding, &f.scope, true, now)
            .unwrap();
        assert!(reopened
            .overview_schedule_reserve(&f.binding, &f.scope, &format!("batch-{page}"), 1, now)
            .unwrap());
    }
    assert!(!reopened
        .overview_schedule_reserve(&f.binding, &f.scope, "batch-15", 1, now)
        .unwrap());
    let waiting = reopened
        .overview_schedule_status(&f.binding, &f.scope, now)
        .unwrap();
    assert!(waiting.budget_exhausted);
    assert_eq!(waiting.next_run_at, Some(now + Duration::minutes(20)));
    let later = now + Duration::minutes(21);
    assert!(
        !reopened
            .overview_schedule_status(&f.binding, &f.scope, later)
            .unwrap()
            .budget_exhausted
    );
    reopened
        .overview_schedule_finished(&f.binding, &f.scope, true, later)
        .unwrap();
    assert!(reopened
        .overview_schedule_reserve(&f.binding, &f.scope, "new-window", 1, later)
        .unwrap());
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
