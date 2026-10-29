fn text_patch_input(
    request: &RequestContext,
    target: &RecordTarget,
) -> crate::agent::record_text::RecordTextPatch {
    crate::agent::record_text::RecordTextPatch {
        record: ObjectRef {
            workspace_id: request.binding.workspace_id.clone(),
            scope: target.scope.clone(),
            kind: ObjectKind::Record,
            id: target.record_id.to_string(),
        },
        base_revision: 1,
        request_id: request.request_id.clone(),
        edit: crate::agent::record_text::RecordTextEdit::Replace {
            old_text: "正文".into(),
            new_text: "正文 suffix".into(),
        },
    }
}

#[tokio::test]
async fn text_edit_preview_commit_replay_and_changed_intent_use_native_patch_transaction() {
    let (directory, store, mut utility, mut request, target) = setup();
    let base = RecordDocumentService::new(&store, &utility)
        .head_get(&request, &target)
        .await
        .unwrap();
    utility.projection = suffix_projection(&base.projection);
    request.request_id = "text-edit".into();
    let input = text_patch_input(&request, &target);
    let preview = crate::agent::record_text::RecordTextPreview {
        record: input.record.clone(),
        base_revision: 1,
        edit: input.edit.clone(),
        budget_chars: Some(5),
    };
    let connection = rusqlite::Connection::open(directory.path().join("app.sqlite")).unwrap();
    let receipts = || {
        connection
            .query_row("SELECT count(*) FROM agent_operation_receipts", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
    };
    let before_receipts = receipts();
    let service = RecordDocumentService::new(&store, &utility);
    let result = service
        .text_patch_preview(&request, &preview)
        .await
        .unwrap();
    assert!(result.preview_truncated);
    assert_eq!(result.preview_text.chars().count(), 5);
    assert_eq!(receipts(), before_receipts);
    assert_eq!(store.flush_calls.load(Ordering::Relaxed), 0);
    assert_eq!(
        store
            .db
            .lock()
            .unwrap()
            .record_document_head(&target)
            .unwrap()
            .unwrap()
            .head_revision,
        1
    );
    let saved = service.text_patch(&request, &input).await.unwrap();
    assert_eq!(saved.after_revision, 2);
    assert!(saved.created_block_ids.is_empty());
    assert!(saved.deleted_block_ids.is_empty());
    assert!(saved.receipt.undo_available);
    let calls = utility.calls.load(Ordering::Relaxed);
    *store.flush_error.lock().unwrap() = Some(ErrorCode::EditorReviewPending);
    let replay = service.text_patch(&request, &input).await.unwrap();
    assert_eq!(replay.receipt.operation_id, saved.receipt.operation_id);
    assert_eq!(utility.calls.load(Ordering::Relaxed), calls);
    assert_eq!(store.flush_calls.load(Ordering::Relaxed), 1);
    assert_eq!(receipts(), before_receipts + 1);
    let mut changed = input.clone();
    changed.edit = crate::agent::record_text::RecordTextEdit::Append {
        markdown: "different intent".into(),
    };
    assert_eq!(
        service
            .text_patch(&request, &changed)
            .await
            .unwrap_err()
            .code,
        ErrorCode::IdempotencyConflict
    );
    assert_eq!(utility.calls.load(Ordering::Relaxed), calls);
}

#[tokio::test]
async fn text_edit_rechecks_revision_permission_binding_and_busy_editor() {
    let (_directory, store, mut utility, mut request, target) = setup();
    let base = RecordDocumentService::new(&store, &utility)
        .head_get(&request, &target)
        .await
        .unwrap();
    utility.projection = suffix_projection(&base.projection);
    request.request_id = "text-conflict".into();
    let mut input = text_patch_input(&request, &target);
    input.base_revision = 2;
    assert_eq!(
        RecordDocumentService::new(&store, &utility)
            .text_patch(&request, &input)
            .await
            .unwrap_err()
            .code,
        ErrorCode::RevisionConflict
    );
    input.base_revision = 1;
    request
        .scope_grant
        .operations
        .retain(|op| op != "record.patch");
    assert_eq!(
        RecordDocumentService::new(&store, &utility)
            .text_patch(&request, &input)
            .await
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    request.scope_grant.operations.push("record.patch".into());
    *store.flush_error.lock().unwrap() = Some(ErrorCode::EditorReviewPending);
    assert_eq!(
        RecordDocumentService::new(&store, &utility)
            .text_patch(&request, &input)
            .await
            .unwrap_err()
            .code,
        ErrorCode::EditorReviewPending
    );
    *store.flush_error.lock().unwrap() = None;
    let binding = store.binding.clone();
    utility.on_request = Some(Box::new(move || {
        binding.lock().unwrap().generation = "other-generation".into()
    }));
    assert_eq!(
        RecordDocumentService::new(&store, &utility)
            .text_patch(&request, &input)
            .await
            .unwrap_err()
            .code,
        ErrorCode::WorkspaceChanged
    );
    assert_eq!(
        store
            .db
            .lock()
            .unwrap()
            .record_document_head(&target)
            .unwrap()
            .unwrap()
            .head_revision,
        1
    );
}

#[tokio::test]
async fn text_edit_cannot_overwrite_a_draft_saved_during_flush() {
    let (_directory, store, mut utility, mut request, target) = setup();
    let base = RecordDocumentService::new(&store, &utility)
        .head_get(&request, &target)
        .await
        .unwrap();
    utility.projection = suffix_projection(&base.projection);
    request.request_id = "text-flush-race".into();
    let input = text_patch_input(&request, &target);
    let db = store.db.clone();
    let saved_target = target.clone();
    let projection = utility.projection.clone();
    let workspace = request.binding.workspace_id.clone();
    *store.on_flush.lock().unwrap() = Some(Box::new(move || {
        db.lock()
            .unwrap()
            .record_document_commit(
                "gui",
                "draft-wins",
                &RecordDocumentCommit {
                    target: saved_target.clone(),
                    base_revision: 1,
                    projection: projection.clone(),
                    origin: RecordVersionOrigin::Manual,
                    actor: json!({"kind":"gui"}),
                    edit_session_id: Some("a".repeat(32)),
                },
                &workspace,
            )
            .unwrap();
    }));
    assert_eq!(
        RecordDocumentService::new(&store, &utility)
            .text_patch(&request, &input)
            .await
            .unwrap_err()
            .code,
        ErrorCode::RevisionConflict
    );
    assert_eq!(
        store
            .db
            .lock()
            .unwrap()
            .record_document_head(&target)
            .unwrap()
            .unwrap()
            .head_revision,
        2
    );
}
