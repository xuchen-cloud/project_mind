use super::*;
use crate::{
    agent::{context::SourceCoverage, overview::OverviewPublishInput},
    models::{ProjectCreateInput, ProjectUpdateInput},
};

struct Fixture {
    root: tempfile::TempDir,
    db: Database,
    binding: WorkspaceBinding,
    scope: Scope,
    project_id: i64,
}
fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let mut db =
        Database::open(&root.path().join("maintenance.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace("w").unwrap();
    let project = db
        .project_create(ProjectCreateInput {
            name: "Maintenance".into(),
            summary: Some("Human note".into()),
            status: None,
        })
        .unwrap();
    db.agent_overviews_prepare().unwrap();
    Fixture {
        root,
        db,
        binding: WorkspaceBinding {
            workspace_id: "w".into(),
            generation: "one".into(),
        },
        scope: Scope::Project {
            project_id: project.id,
        },
        project_id: project.id,
    }
}
fn later(f: &Fixture, n: usize) {
    f.db.project_update(ProjectUpdateInput {
        project_id: f.project_id,
        name: None,
        summary: format!("Manual update {n}"),
        summary_markdown: None,
        summary_html: None,
        summary_code_language: None,
        status: None,
    })
    .unwrap();
}
fn progress(
    batch: &OverviewMaintenanceBatch,
    state: OverviewSourceState,
    cursor: Option<&str>,
) -> OverviewSourceProgress {
    OverviewSourceProgress {
        object: batch.source_object.clone(),
        read_target: cursor.map(|_| SourceReadTarget {
            object: batch.source_object.raw_object().unwrap().clone(),
            revision: Some("semantic-revision".into()),
            record_version: None,
            file_version: None,
        }),
        read_cursor: cursor.map(str::to_owned),
        state,
        handled_seq: batch.source.last_seq,
    }
}
fn publish_input(
    f: &Fixture,
    batch: &OverviewMaintenanceBatch,
    progress: &OverviewSourceProgress,
) -> OverviewPublishInput {
    OverviewPublishInput {
        scope: f.scope.clone(),
        batch_id: batch.batch_id.clone(),
        expected_revision: batch.expected_revision,
        target_seq: batch.target_seq,
        policy_revision: batch.policy_revision,
        correction_revision: batch.correction_revision,
        upsert_items: vec![],
        remove_item_ids: vec![],
        settled_object_keys: if progress.state == OverviewSourceState::Partial {
            vec![]
        } else {
            vec![batch.source.object_key.clone()]
        },
        knowledge_upserts: vec![],
        knowledge_removes: vec![],
        coverage: f
            .db
            .agent_overview_maintenance_coverage(&f.binding, &f.scope, Some(progress))
            .unwrap(),
        source_manifest_hash: "manifest".into(),
        model_profile_id: "test-profile".into(),
    }
}
fn publish(f: &Fixture, batch: &OverviewMaintenanceBatch, input: &OverviewPublishInput) {
    f.db.agent_overview_publish(
        "gui",
        &format!("overview-{}", batch.batch_id),
        "w",
        input,
        |_, _| Ok(()),
    )
    .unwrap();
}
fn prepare(f: &Fixture) -> OverviewMaintenanceBatch {
    f.db.agent_overview_maintenance_prepare(&f.binding, &f.scope, Utc::now())
        .unwrap()
        .unwrap()
}

#[test]
fn pending_order_resumes_partial_then_uses_native_goal_pins_and_active_todo() {
    let f = fixture();
    let seq: i64 =
        f.db.conn
            .query_row("SELECT MAX(seq) FROM agent_change_log", [], |r| r.get(0))
            .unwrap();
    f.db.conn
        .execute(
            "DELETE FROM agent_overview_pending WHERE scope_key=?1",
            [f.scope.key()],
        )
        .unwrap();
    let add_record = |title: &str| {
        f.db.conn.execute("INSERT INTO notes(project_id,title,created_at,updated_at) VALUES (?1,?2,'now','now')",
            params![f.project_id,title]).unwrap();
        f.db.conn.last_insert_rowid()
    };
    let goal_id = add_record("Goal");
    let other_id = add_record("Other");
    let other_second_id = add_record("Another");
    let add_todo = |status: &str| {
        f.db.conn
            .execute(
                "INSERT INTO todos(scope,project_id,content,status,priority,created_at,updated_at)
            VALUES ('project',?1,'Action',?2,'not_urgent_important','now','now')",
                params![f.project_id, status],
            )
            .unwrap();
        f.db.conn.last_insert_rowid()
    };
    let pinned_id = add_todo("finished");
    let active_id = add_todo("unfinished");
    let key = |kind: ObjectKind, id: i64| {
        ObjectRef {
            workspace_id: f.binding.workspace_id.clone(),
            scope: f.scope.clone(),
            kind,
            id: id.to_string(),
        }
        .key()
        .unwrap()
    };
    let goal = key(ObjectKind::Record, goal_id);
    let other = key(ObjectKind::Record, other_id);
    let other_second = key(ObjectKind::Record, other_second_id);
    let pinned = key(ObjectKind::Todo, pinned_id);
    let active = key(ObjectKind::Todo, active_id);
    let partial = key(ObjectKind::File, 99);
    for object_key in [&goal, &other, &other_second, &pinned, &active, &partial] {
        f.db.conn.execute("INSERT INTO agent_overview_pending(scope_key,object_key,first_seq,last_seq,operation,latest_revision,deleted,excluded)
            VALUES (?1,?2,?3,?3,'test.changed','1',0,0)",
            params![f.scope.key(),object_key,seq]).unwrap();
    }
    let partial_progress = OverviewSourceProgress {
        object: OverviewInput::Raw(ObjectRef {
            workspace_id: f.binding.workspace_id.clone(),
            scope: f.scope.clone(),
            kind: ObjectKind::File,
            id: "99".into(),
        }),
        read_target: None,
        read_cursor: Some("page-2".into()),
        state: OverviewSourceState::Partial,
        handled_seq: seq as u64,
    };
    f.db.conn.execute("INSERT INTO agent_jobs(id,kind,scope_key,dedupe_key,state,attempt,not_before,payload_json)
        VALUES (?1,'overview',?2,?1,'completed',0,'now',?3)",
        params![format!("overview-source:{partial}"),f.scope.key(),serde_json::to_string(&partial_progress).unwrap()]).unwrap();
    let mut settings = f.db.agent_settings_get(&f.scope).unwrap();
    settings.goal_record_id = Some(goal_id);
    settings.pinned_refs = vec![ObjectRef {
        workspace_id: f.binding.workspace_id.clone(),
        scope: f.scope.clone(),
        kind: ObjectKind::Todo,
        id: pinned_id.to_string(),
    }];
    f.db.conn
        .execute(
            "INSERT INTO agent_scope_settings(scope_key,goal_record_id,pinned_refs_json)
        VALUES (?1,?2,?3)",
            params![
                f.scope.key(),
                goal_id,
                serde_json::to_string(&settings.pinned_refs).unwrap()
            ],
        )
        .unwrap();

    for expected in [&partial, &goal, &pinned, &active, &other, &other_second] {
        let batch = prepare(&f);
        assert_eq!(&batch.source.object_key, expected);
        if expected == &partial {
            assert_eq!(batch.source_cursor.as_deref(), Some("page-2"));
        }
        f.db.conn
            .execute(
                "DELETE FROM agent_overview_pending WHERE scope_key=?1 AND object_key=?2",
                params![f.scope.key(), expected],
            )
            .unwrap();
        f.db.conn
            .execute(
                "DELETE FROM agent_jobs WHERE dedupe_key=?1",
                [format!("overview-maintenance:{}", f.scope.key())],
            )
            .unwrap();
    }
    // A settled goal remains configured but cannot create another source batch.
    assert!(f
        .db
        .agent_overview_maintenance_prepare(&f.binding, &f.scope, Utc::now())
        .unwrap()
        .is_none());
}

#[test]
fn cursor_survives_reopen_and_same_target_continues_before_fifty_later_changes() {
    let mut f = fixture();
    let first = prepare(&f);
    let first_progress = progress(&first, OverviewSourceState::Partial, Some("next-page"));
    let first_input = publish_input(&f, &first, &first_progress);
    f.db.agent_overview_maintenance_save_draft(
        &f.binding,
        &f.scope,
        &first.batch_id,
        &first_input,
        &first_progress,
        Utc::now(),
    )
    .unwrap();
    publish(&f, &first, &first_input);
    f.db.agent_overview_maintenance_complete(&f.binding, &f.scope, &first.batch_id, Utc::now())
        .unwrap();
    let path = f.root.path().join("maintenance.sqlite");
    f.db = Database::open(&path, f.root.path(), None).unwrap();
    f.db.bind_native_workspace("w").unwrap();
    let second = prepare(&f);
    assert_ne!(first.batch_id, second.batch_id);
    assert_eq!(second.target_seq, first.target_seq);
    assert_eq!(second.source.object_key, first.source.object_key);
    assert_eq!(second.source_cursor.as_deref(), Some("next-page"));
    assert_eq!(
        second
            .source_read_target
            .as_ref()
            .and_then(|t| t.revision.as_deref()),
        Some("semantic-revision")
    );
    for n in 0..50 {
        later(&f, n);
    }
    assert_eq!(prepare(&f).batch_id, second.batch_id);
    let status =
        f.db.agent_overview_maintenance_status(&f.binding, &f.scope)
            .unwrap();
    assert_eq!(
        status.pending_count, 2,
        "fifty native changes coalesce by source"
    );
    assert_eq!(status.coverage.processed, 0);
    assert!(status.coverage.pending > 0);
    let complete = progress(&second, OverviewSourceState::Processed, None);
    let input = publish_input(&f, &second, &complete);
    f.db.agent_overview_maintenance_save_draft(
        &f.binding,
        &f.scope,
        &second.batch_id,
        &input,
        &complete,
        Utc::now(),
    )
    .unwrap();
    publish(&f, &second, &input);
    f.db.agent_overview_maintenance_complete(&f.binding, &f.scope, &second.batch_id, Utc::now())
        .unwrap();
    let next = prepare(&f);
    assert_ne!(next.batch_id, second.batch_id);
    assert!(next.target_seq > second.target_seq);
    assert!(next.source_cursor.is_none());
    assert_eq!(next.source_object.raw_object().unwrap().kind, ObjectKind::QuickNote);
    assert!(
        next.source.last_seq > second.target_seq,
        "the later native Quick Note change remains pending after the old Project source settles"
    );
}

#[test]
fn published_draft_replays_after_crash_then_complete_and_cancel_resume_preserve_work() {
    let mut f = fixture();
    let first = prepare(&f);
    let processed = progress(&first, OverviewSourceState::Processed, None);
    let input = publish_input(&f, &first, &processed);
    f.db.agent_overview_maintenance_save_draft(
        &f.binding,
        &f.scope,
        &first.batch_id,
        &input,
        &processed,
        Utc::now(),
    )
    .unwrap();
    publish(&f, &first, &input);
    let path = f.root.path().join("maintenance.sqlite");
    f.db = Database::open(&path, f.root.path(), None).unwrap();
    f.db.bind_native_workspace("w").unwrap();
    let retry = prepare(&f);
    assert_eq!(retry.batch_id, first.batch_id);
    let draft = retry.draft.unwrap();
    assert!(f
        .db
        .agent_overview_replay("gui", &format!("overview-{}", first.batch_id), &draft)
        .unwrap()
        .is_some());
    let status =
        f.db.agent_overview_maintenance_complete(&f.binding, &f.scope, &first.batch_id, Utc::now())
            .unwrap();
    assert_eq!(status.coverage.processed, 1);
    assert!(status.batch_id.is_none());
    let next = prepare(&f);
    f.db.agent_overview_maintenance_cancel(&f.binding, &f.scope, Utc::now())
        .unwrap();
    assert!(f
        .db
        .agent_overview_maintenance_prepare(&f.binding, &f.scope, Utc::now())
        .unwrap()
        .is_none());
    assert_eq!(
        f.db.agent_overview_maintenance_status(&f.binding, &f.scope)
            .unwrap()
            .batch_id
            .as_deref(),
        Some(next.batch_id.as_str())
    );
    f.db.agent_overview_maintenance_resume(&f.binding, &f.scope, Utc::now())
        .unwrap();
    assert_eq!(prepare(&f).batch_id, next.batch_id);
}

#[test]
fn source_change_discards_unpublished_draft_but_io_pause_keeps_current_batch() {
    let f = fixture();
    let first = prepare(&f);
    f.db.agent_overview_maintenance_fail(
        &f.binding,
        &f.scope,
        &first.batch_id,
        ErrorCode::IoFailed,
        Utc::now(),
    )
    .unwrap();
    assert!(f
        .db
        .agent_overview_maintenance_prepare(&f.binding, &f.scope, Utc::now())
        .unwrap()
        .is_none());
    f.db.agent_overview_maintenance_resume(&f.binding, &f.scope, Utc::now())
        .unwrap();
    assert_eq!(prepare(&f).batch_id, first.batch_id);
    f.db.agent_overview_maintenance_fail(
        &f.binding,
        &f.scope,
        &first.batch_id,
        ErrorCode::SourceChanged,
        Utc::now(),
    )
    .unwrap();
    f.db.agent_overview_maintenance_resume(&f.binding, &f.scope, Utc::now())
        .unwrap();
    let retry = prepare(&f);
    assert_ne!(retry.batch_id, first.batch_id);
    assert_eq!(retry.source.object_key, first.source.object_key);
}

#[test]
fn status_counts_inventory_source_without_registry_and_never_claims_body_complete() {
    let f = fixture();
    let batch = prepare(&f);
    f.db.conn
        .execute(
            "DELETE FROM source_registry WHERE object_key=?1",
            [&batch.source.object_key],
        )
        .unwrap();
    let preview =
        f.db.agent_overview_maintenance_coverage(
            &f.binding,
            &f.scope,
            Some(&progress(&batch, OverviewSourceState::Processed, None)),
        )
        .unwrap();
    assert_eq!(preview.processed, 1);
    let status =
        f.db.agent_overview_maintenance_status(&f.binding, &f.scope)
            .unwrap();
    assert_eq!(status.coverage.processed, 0);
    assert!(status.coverage.pending > 0);
    assert!(!status.directory_complete);
    let _: SourceCoverage = preview;
}

#[test]
fn profile_resume_is_idle_without_paused_workers_and_requires_verified_secret() {
    let mut f = fixture();
    let now = Utc::now();
    f.db.agent_overview_maintenance_resume_waiting(&f.binding, now)
        .unwrap();
    f.db.conn
        .execute(
            "INSERT INTO agent_scope_settings(scope_key,enabled) VALUES (?1,1)",
            [f.scope.key()],
        )
        .unwrap();
    let batch = prepare(&f);
    f.db.agent_overview_maintenance_fail(
        &f.binding,
        &f.scope,
        &batch.batch_id,
        ErrorCode::ProfileUnavailable,
        now,
    )
    .unwrap();
    f.db.agent_overview_maintenance_resume_waiting(&f.binding, now)
        .unwrap();
    assert_eq!(
        f.db.agent_overview_maintenance_status(&f.binding, &f.scope)
            .unwrap()
            .error_code,
        Some(ErrorCode::ProfileUnavailable)
    );
    let secret = crate::secret_crypto::encrypt_secret("test-key", "workspace-password").unwrap();
    f.db.secret_password = Some("workspace-password".into());
    f.db.conn
        .execute(
            "INSERT INTO ai_provider_profiles
        (name,provider_family,base_url,api_key_ciphertext,api_key_nonce,api_key_salt,api_key_last4,
         default_model,supports_text,supports_image,supports_file,enabled,created_at,updated_at)
        VALUES ('Overview','openai_compatible','https://fixture.invalid/v1',?1,?2,?3,?4,
            'test-model',1,0,0,1,'now','now')",
            params![
                secret.ciphertext_b64,
                secret.nonce_b64,
                secret.salt_b64,
                secret.last4
            ],
        )
        .unwrap();
    let profile_id = f.db.conn.last_insert_rowid();
    f.db.conn
        .execute(
            "INSERT INTO ai_capability_bindings(capability,use_default,profile_id,model,updated_at)
        VALUES ('default',0,?1,NULL,'now') ON CONFLICT(capability) DO UPDATE SET
        use_default=0,profile_id=excluded.profile_id,model=NULL",
            [profile_id],
        )
        .unwrap();
    f.db.agent_overview_maintenance_resume_waiting(&f.binding, now)
        .unwrap();
    assert_eq!(
        f.db.agent_overview_maintenance_status(&f.binding, &f.scope)
            .unwrap()
            .error_code,
        Some(ErrorCode::ProfileUnavailable),
        "unverified profile stays paused"
    );
    let fingerprint = f.db.agent_resolve_profile(None).unwrap().fingerprint;
    f.db.agent_profile_record_verification(&fingerprint)
        .unwrap();
    f.db.agent_overview_maintenance_resume_waiting(&f.binding, now)
        .unwrap();
    let status =
        f.db.agent_overview_maintenance_status(&f.binding, &f.scope)
            .unwrap();
    assert_eq!(status.error_code, None);
    assert_eq!(status.batch_id.as_deref(), Some(batch.batch_id.as_str()));
    let scheduled: bool =
        f.db.conn
            .query_row(
                "SELECT json_extract(payload_json,'$.active') FROM agent_jobs
        WHERE dedupe_key=?1 AND kind='maintenance'",
                [format!(
                    "overview-schedule:{}/{}",
                    f.binding.workspace_id,
                    f.scope.key()
                )],
                |row| row.get(0),
            )
            .unwrap();
    assert!(scheduled);
}

#[test]
fn legacy_session_quota_does_not_block_undrafted_batch_or_draft_replay() {
    let f=fixture();
    let now=DateTime::parse_from_rfc3339("2026-10-08T12:00:00Z").unwrap().with_timezone(&Utc);
    f.db.conn.execute("DELETE FROM agent_overview_pending WHERE scope_key=?1",[f.scope.key()]).unwrap();
    let key=format!("{}/{}/session_message/{}",f.binding.workspace_id,f.scope.key(),"a".repeat(32));
    f.db.conn.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES (?1,?2,'session.message.index','hash','now')",params![key,f.scope.key()]).unwrap();
    let batch=f.db.agent_overview_maintenance_prepare(&f.binding,&f.scope,now).unwrap().unwrap();
    assert_eq!(batch.source_object.raw_object().unwrap().kind,ObjectKind::SessionMessage);
    let quota_key=format!("overview-session-daily:{}/{}",f.binding.workspace_id,f.scope.key());
    let payload=serde_json::json!({"date":"2026-10-08","calls":5}).to_string();
    f.db.conn.execute("INSERT INTO agent_jobs(id,kind,scope_key,dedupe_key,state,not_before,payload_json) VALUES (?1,'maintenance',?2,?1,'completed','now',?3)",params![quota_key,f.scope.key(),payload]).unwrap();
    assert_eq!(f.db.agent_overview_maintenance_prepare(&f.binding,&f.scope,now).unwrap().unwrap().batch_id,batch.batch_id);
    assert_eq!(read_ledger(&f.db.conn,&f.scope).unwrap().batch.unwrap().batch_id,batch.batch_id);
    let handled=progress(&batch,OverviewSourceState::Processed,None);
    let draft=publish_input(&f,&batch,&handled);
    f.db.agent_overview_maintenance_save_draft(&f.binding,&f.scope,&batch.batch_id,&draft,&handled,now).unwrap();
    let replay=f.db.agent_overview_maintenance_prepare(&f.binding,&f.scope,now).unwrap().unwrap();
    assert_eq!(replay.batch_id,batch.batch_id);
    assert!(replay.draft.is_some());
}
