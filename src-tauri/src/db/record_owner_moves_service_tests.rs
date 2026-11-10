use super::*;
use crate::{
    agent::errors::{AgentError, AgentResult, ErrorCode},
    committed_changes::{CommittedChangePublisher, CommittedChanges},
    record_document_service::{BoundRecordStore, DocumentUtility},
    record_editor_coordination::{
        RecordEditorCoordinator, RecordEditorFlushOutcome, RecordEditorFlushReply,
        RecordEditorRegistration,
    },
    record_owner_moves::{BoundRecordMoveStore, RecordOwnerMoveService},
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
struct Store {
    db: Mutex<Database>,
    binding: WorkspaceBinding,
    editors: Arc<RecordEditorCoordinator>,
    review: AtomicBool,
    late: AtomicBool,
    mutate_baseline: AtomicBool,
    flushed: Mutex<Vec<String>>,
    events: Mutex<Vec<CommittedChanges>>,
    released: Mutex<Vec<crate::record_owner_moves::OwnerMoveReleased>>,
    moved: Mutex<Vec<crate::record_owner_moves::OwnerMoved>>,
}
impl CommittedChangePublisher for Store {
    fn publish_committed(&self, event: CommittedChanges) {
        assert!(self.db.try_lock().is_ok());
        self.events.lock().unwrap().push(event);
    }
}
impl BoundRecordStore for Store {
    async fn flush_editors(
        &self,
        binding: &WorkspaceBinding,
        target: &RecordTarget,
    ) -> AgentResult<()> {
        let windows = ["one", "two", "other", "late"]
            .into_iter()
            .map(String::from)
            .collect();
        self.editors
            .flush(binding, target, &windows, |request| {
                assert!(request.owner_move_request_id.is_some());
                self.flushed.lock().unwrap().push(request.editor_id.clone());
                self.editors.reply(
                    binding,
                    &request.window,
                    &RecordEditorFlushReply {
                        target: request.target.clone(),
                        editor_id: request.editor_id.clone(),
                        flush_id: request.flush_id.clone(),
                        outcome: if self.review.load(Ordering::Acquire) {
                            RecordEditorFlushOutcome::ReviewPending
                        } else {
                            RecordEditorFlushOutcome::Saved
                        },
                    },
                )
            })
            .await?;
        if self.late.load(Ordering::Acquire) {
            // A different Record remains registerable during the target's seal.
            self.editors.register(
                binding,
                "other",
                &RecordEditorRegistration {
                    target: RecordTarget {
                        scope: Scope::Project { project_id: 1 },
                        record_id: 1,
                    },
                    editor_id: "e".repeat(32),
                },
            )?;
            self.editors.register(
                binding,
                "late",
                &RecordEditorRegistration {
                    target: target.clone(),
                    editor_id: "c".repeat(32),
                },
            )?;
        }
        if self.mutate_baseline.load(Ordering::Acquire) {
            self.db
                .lock()
                .unwrap()
                .conn
                .execute(
                    "UPDATE workspace_notes SET title='saved during flush' WHERE id=?1",
                    [target.record_id],
                )
                .unwrap();
        }
        Ok(())
    }
    async fn submission_lock(
        &self,
        binding: &WorkspaceBinding,
        target: &RecordTarget,
    ) -> AgentResult<Option<tokio::sync::OwnedMutexGuard<()>>> {
        self.editors
            .submission_lock(binding, target)
            .await
            .map(Some)
    }
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        action(&self.binding, &self.db.lock().unwrap())
    }
}
impl BoundRecordMoveStore for Store {
    fn seal_owner_move(
        &self,
        binding: &WorkspaceBinding,
        target: &RecordTarget,
        request_id: &str,
    ) -> AgentResult<crate::record_editor_coordination::RecordOwnerMoveSeal> {
        self.editors.seal_owner_move(binding, target, request_id)
    }
    fn publish_move_released(&self, event: crate::record_owner_moves::OwnerMoveReleased) {
        assert!(self.db.try_lock().is_ok());
        let target = RecordTarget {
            scope: event.source.scope.clone(),
            record_id: event.source.id.parse().unwrap(),
        };
        let seal = self
            .editors
            .seal_owner_move(&event.binding, &target, "release-check")
            .unwrap();
        drop(seal);
        self.released.lock().unwrap().push(event);
    }
    fn publish_moved(&self, event: crate::record_owner_moves::OwnerMoved) {
        assert!(self.db.try_lock().is_ok());
        assert!(!event.old_sessions_closed);
        self.moved.lock().unwrap().push(event);
    }

    fn editor_stamp(
        &self,
        binding: &WorkspaceBinding,
        target: &RecordTarget,
    ) -> AgentResult<Vec<String>> {
        self.editors.move_registration_stamp(binding, target)
    }
    fn with_editor_stamp<T>(
        &self,
        binding: &WorkspaceBinding,
        target: &RecordTarget,
        stamp: &[String],
        action: impl FnOnce() -> AgentResult<T>,
    ) -> AgentResult<T> {
        self.editors
            .with_move_registration_stamp(binding, target, stamp, action)
    }
}
struct NoConversion;
impl DocumentUtility for NoConversion {
    async fn request(
        &self,
        _: &str,
        _: &str,
        _: serde_json::Value,
    ) -> AgentResult<serde_json::Value> {
        Err(AgentError::new(
            ErrorCode::RuntimeUnavailable,
            "No conversion should be required",
        ))
    }
}
#[tokio::test]
async fn g13_cross_window_object_only_barrier_pending_ai_late_registration_and_old_cleanup() {
    let (_dir, db, mut r, source) = setup();
    let mut i = input(&db, &source, Scope::Project { project_id: 1 });
    let store = Store {
        db: Mutex::new(db),
        binding: r.binding.clone(),
        editors: Arc::new(RecordEditorCoordinator::default()),
        review: AtomicBool::new(true),
        late: AtomicBool::new(false),
        mutate_baseline: AtomicBool::new(false),
        flushed: Mutex::new(vec![]),
        events: Mutex::new(vec![]),
        released: Mutex::new(vec![]),
        moved: Mutex::new(vec![]),
    };
    let registrations = [
        ("one", 'a', source.clone()),
        ("two", 'b', source.clone()),
        (
            "other",
            'd',
            RecordTarget {
                scope: Scope::Project { project_id: 1 },
                record_id: 1,
            },
        ),
    ];
    for (window, id, target) in &registrations {
        store
            .editors
            .register(
                &r.binding,
                window,
                &RecordEditorRegistration {
                    target: target.clone(),
                    editor_id: id.to_string().repeat(32),
                },
            )
            .unwrap();
    }
    let svc = RecordOwnerMoveService {
        store: &store,
        utility: &NoConversion,
    };
    assert_eq!(
        svc.move_record(&r, &i).await.unwrap_err().code,
        ErrorCode::EditorReviewPending
    );
    assert!(store
        .db
        .lock()
        .unwrap()
        .record_document_head(&source)
        .unwrap()
        .is_some());
    assert!(store
        .flushed
        .lock()
        .unwrap()
        .iter()
        .all(|id| id != &"d".repeat(32)));
    store.review.store(false, Ordering::Release);
    store.late.store(true, Ordering::Release);
    r.request_id = "late".into();
    assert_eq!(
        svc.move_record(&r, &i).await.unwrap_err().code,
        ErrorCode::EditorBusy
    );
    store.late.store(false, Ordering::Release);
    r.request_id = "cancel".into();
    let guard = store
        .editors
        .submission_lock(&r.binding, &source)
        .await
        .unwrap();
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(10),
        svc.move_record(&r, &i)
    )
    .await
    .is_err());
    drop(guard);
    assert_eq!(store.released.lock().unwrap().len(), 3);
    r.request_id = "flush-cas".into();
    store.mutate_baseline.store(true, Ordering::Release);
    assert_eq!(
        svc.move_record(&r, &i).await.unwrap_err().code,
        ErrorCode::RevisionConflict
    );
    store.mutate_baseline.store(false, Ordering::Release);
    i = input(
        &store.db.lock().unwrap(),
        &source,
        Scope::Project { project_id: 1 },
    );
    r.request_id = "success".into();
    let moved = svc.move_record(&r, &i).await.unwrap();
    assert_eq!(store.released.lock().unwrap().len(), 4);
    assert_eq!(store.moved.lock().unwrap().len(), 1);
    assert_eq!(store.moved.lock().unwrap()[0].operation_id, "success");
    assert_eq!(store.events.lock().unwrap().len(), 1);
    assert_eq!(store.events.lock().unwrap()[0].changed_refs.len(), 2);
    for (window, id, target) in &registrations[..2] {
        let cleanup = RecordEditorRegistration {
            target: target.clone(),
            editor_id: id.to_string().repeat(32),
        };
        store
            .editors
            .unregister(&r.binding, window, &cleanup)
            .unwrap();
        store
            .editors
            .unregister(&r.binding, window, &cleanup)
            .unwrap();
    }
    assert_eq!(
        store
            .db
            .lock()
            .unwrap()
            .record_require_current_location(&source)
            .unwrap_err()
            .code,
        ErrorCode::SourceChanged
    );
    assert_eq!(
        store
            .db
            .lock()
            .unwrap()
            .record_document_head(&moved.target)
            .unwrap()
            .unwrap()
            .head_revision,
        moved.head_revision
    );
}
