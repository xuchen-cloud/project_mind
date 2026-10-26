use super::*;
use crate::agent::{
    access::ScopeGrant,
    settings::{AgentScopeSettings, SettingsUpdate},
};
use crate::models::{ProjectCreateInput, TodoCreateInput, TodoScope};

fn fixture() -> (tempfile::TempDir, Database, RequestContext, DateTime<Utc>) {
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(&root.path().join("deadline.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace("deadline-workspace").unwrap();
    let mut settings = AgentScopeSettings::defaults(Scope::Workspace);
    settings.enabled = true;
    db.agent_settings_update(
        "gui",
        "enable",
        &SettingsUpdate {
            settings,
            expected_revision: 0,
        },
    )
    .unwrap();
    let binding = WorkspaceBinding {
        workspace_id: "deadline-workspace".into(),
        generation: "one".into(),
    };
    let request = crate::source_maintenance::request(binding, &Scope::Workspace, "deadline".into());
    let now = DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).unwrap();
    db.source_maintenance_select(
        &request,
        &request.binding,
        &Scope::Workspace,
        MaintenanceAction::Activate,
        now,
    )
    .unwrap();
    (root, db, request, now)
}

fn todo(db: &mut Database, scope: &Scope) {
    db.todo_create(TodoCreateInput {
        scope: if matches!(scope, Scope::Workspace) {
            TodoScope::Workspace
        } else {
            TodoScope::Project
        },
        project_id: match scope {
            Scope::Project { project_id } => Some(*project_id),
            _ => None,
        },
        content: "Deadline evidence".into(),
        priority: "not_urgent_important".into(),
        due_date: None,
        tag_ids: vec![],
    })
    .unwrap();
}

fn prepare(db: &Database, request: &RequestContext, scope: &Scope, now: DateTime<Utc>) {
    db.source_queue_sync(request, &request.binding, scope, now)
        .unwrap();
    while db
        .source_queue_backfill(request, &request.binding, scope, 200, now)
        .unwrap()
        .has_more
    {}
}

#[test]
fn source_deadline_waits_for_real_retry_instead_of_polling_pending() {
    let (_root, mut db, request, now) = fixture();
    todo(&mut db, &Scope::Workspace);
    prepare(&db, &request, &Scope::Workspace, now);
    let lease = db
        .source_queue_claim(&request, &request.binding, &Scope::Workspace, now)
        .unwrap()
        .unwrap();
    assert_eq!(
        db.source_maintenance_wake_at(&request.binding, now).unwrap(),
        Some(now + Duration::seconds(90)),
        "a running extraction retains the durable queue lease deadline"
    );
    let failed_at = now + Duration::seconds(8);
    db.source_queue_finish(
        &request,
        &request.binding,
        &lease,
        super::super::source_index_queue::SourceIndexOutcome::Retry,
        failed_at,
    )
    .unwrap();
    assert_eq!(
        db.source_maintenance_wake_at(&request.binding, now)
            .unwrap(),
        Some(failed_at + Duration::milliseconds(500))
    );
}

#[test]
fn source_deadline_covers_other_scope_and_ignores_cancelled_archived_scopes() {
    let (_root, mut db, mut request, now) = fixture();
    let project = db
        .project_create(ProjectCreateInput {
            name: "Other".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let scope = Scope::Project {
        project_id: project.id,
    };
    request.scope_grant = ScopeGrant {
        project_ids: vec![project.id],
        ..request.scope_grant
    };
    todo(&mut db, &scope);
    prepare(&db, &request, &Scope::Workspace, now);
    prepare(&db, &request, &scope, now);
    db.conn.execute("UPDATE agent_jobs SET state='completed' WHERE kind='extract' AND scope_key='workspace'", []).unwrap();
    let ready = now + Duration::seconds(7);
    db.conn
        .execute(
            "UPDATE agent_jobs SET not_before=?1 WHERE kind='extract' AND scope_key=?2",
            params![
                ready.to_rfc3339_opts(SecondsFormat::Millis, true),
                scope.key()
            ],
        )
        .unwrap();
    // Activation of Workspace is only a fair cursor; it cannot hide a Project's retry.
    db.source_maintenance_select(
        &request,
        &request.binding,
        &Scope::Workspace,
        MaintenanceAction::Activate,
        now,
    )
    .unwrap();
    assert_eq!(
        db.source_maintenance_wake_at(&request.binding, now)
            .unwrap(),
        Some(ready)
    );
    db.source_maintenance_select(
        &request,
        &request.binding,
        &scope,
        MaintenanceAction::Cancel,
        now,
    )
    .unwrap();
    assert_eq!(
        db.source_maintenance_wake_at(&request.binding, now)
            .unwrap(),
        None
    );
    db.source_maintenance_select(
        &request,
        &request.binding,
        &scope,
        MaintenanceAction::Resume,
        now,
    )
    .unwrap();
    db.project_set_archive(crate::models::ProjectArchiveInput {
        project_id: project.id,
        is_archived: true,
    })
    .unwrap();
    prepare(&db, &request, &Scope::Workspace, now);
    db.conn.execute("UPDATE agent_jobs SET state='completed' WHERE kind='extract' AND scope_key='workspace'", []).unwrap();
    assert_eq!(
        db.source_maintenance_wake_at(&request.binding, now)
            .unwrap(),
        None
    );
}

#[test]
fn source_deadline_keeps_reservation_expiry_quota_reset_and_reopen_charge() {
    let (root, db, request, now) = fixture();
    let reservation = db
        .source_maintenance_reserve(&request, &request.binding, &Scope::Workspace, now)
        .unwrap()
        .unwrap();
    let expiry = DateTime::from_timestamp(reservation.expires_at, 0).unwrap();
    assert_eq!(
        db.source_maintenance_wake_at(&request.binding, now)
            .unwrap(),
        Some(expiry)
    );
    drop(db);
    let mut db = Database::open(&root.path().join("deadline.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace(&request.binding.workspace_id)
        .unwrap();
    let mut reopened = request.binding.clone();
    reopened.generation = "two".into();
    assert_eq!(
        db.source_maintenance_wake_at(&reopened, now).unwrap(),
        Some(now)
    );
    // Read-only scheduling does not clear the old reservation or refund it.
    assert_eq!(
        db.maintenance_load(&reopened).unwrap().unwrap().chars,
        reservation.chars
    );
    let mut ledger = db.maintenance_load(&request.binding).unwrap().unwrap();
    ledger.chars = BATCH_CHARS;
    db.maintenance_save(&request.binding, &ledger).unwrap();
    assert_eq!(db.source_maintenance_wake_at(&request.binding, now).unwrap(), Some(expiry),
        "reservation cleanup precedes the later quota reset");
    ledger.reservation = None;
    db.maintenance_save(&request.binding, &ledger).unwrap();
    let reset = DateTime::from_timestamp(ledger.started_at + PERIOD_SECONDS, 0).unwrap();
    assert_eq!(
        db.source_maintenance_wake_at(&request.binding, now)
            .unwrap(),
        Some(reset)
    );
    assert_eq!(
        db.source_maintenance_wake_at(&request.binding, reset)
            .unwrap(),
        Some(reset)
    );
}
