#[tokio::test]
async fn connection_create_patch_restore_and_replay_use_native_record_receipts() {
    let (directory, store, mut utility, mut request, _) = setup();
    store.db.lock().unwrap().bind_native_workspace(&request.binding.workspace_id).unwrap();
    request.caller = Caller::Connection { grant_id: "record-writer".into() };
    request.scope_grant.operations.extend([
        "content.create".into(), "source.read".into(), "operation.undo".into(),
        "operation.restore_created".into(), "operation.read".into(),
    ]);
    let baseline = utility.projection.clone();
    let input = crate::record_documents::RecordCreate {
        scope: Scope::Workspace, title: Some("Connection Record".into()), tag_ids: vec![],
        document: baseline.document.clone(), code_language: None,
    };
    // The opaque connection request ID may share the staged-output prefix.
    request.request_id = "output:external-id".into();
    let created = RecordDocumentService::new(&store, &utility).create(&request, &input).await.unwrap();
    assert_eq!(RecordDocumentService::new(&store, &utility).create(&request, &input).await.unwrap().target.record_id, created.target.record_id);
    let receipt = rusqlite::Connection::open(directory.path().join("app.sqlite")).unwrap();
    let (create_id, create_state): (String, String) = receipt.query_row(
        "SELECT operation_id,undo_state FROM agent_operation_receipts WHERE caller_id=?1 AND request_id=?2",
        rusqlite::params![request.caller.key(),request.request_id], |r| Ok((r.get(0)?,r.get(1)?)),
    ).unwrap();
    assert_eq!(create_state, "available");
    request.request_id = "connection-patch".into();
    let patch = append_patch(&request, &created.target, &baseline);
    utility.projection = suffix_projection(&baseline);
    let saved = RecordDocumentService::new(&store, &utility).patch(&request, &patch).await.unwrap();
    assert_eq!(saved.after_revision, 2);
    assert_eq!(RecordDocumentService::new(&store, &utility).patch(&request, &patch).await.unwrap().receipt.operation_id, saved.receipt.operation_id);
    let patch_state: String = receipt.query_row(
        "SELECT undo_state FROM agent_operation_receipts WHERE operation_id=?1",
        [&saved.receipt.operation_id], |r| r.get(0),
    ).unwrap();
    assert_eq!(patch_state, "available");
    request.request_id = "connection-stale-patch".into();
    let mut stale = patch.clone();
    stale.request_id = request.request_id.clone();
    assert_eq!(RecordDocumentService::new(&store, &utility).patch(&request, &stale).await.unwrap_err().code, ErrorCode::RevisionConflict);

    request.request_id = "connection-undo-patch".into();
    utility.projection = baseline.clone();
    let undo = crate::agent::operations::OperationUndoInput {
        operation_id: saved.receipt.operation_id.clone(), expected_head_revision: 2,
    };
    let undone = RecordDocumentService::new(&store, &utility).undo_operation(&request, &undo).await.unwrap();
    assert!(matches!(undone, crate::agent::operations::OperationUndoResult::ModifiedRecord(_)));
    assert!(matches!(RecordDocumentService::new(&store, &utility).undo_operation(&request, &undo).await.unwrap(), crate::agent::operations::OperationUndoResult::ModifiedRecord(_)));

    let after_patch = store.db.lock().unwrap().record_version_get(&created.target, saved.after_version.as_deref().unwrap()).unwrap();
    utility.projection = after_patch.projection;
    request.request_id = "connection-restore-version".into();
    let restore = RecordRestoreInput { target: created.target.clone(), base_revision: 3, version_id: saved.after_version.unwrap() };
    let restored = RecordDocumentService::new(&store, &utility).restore(&request, &restore).await.unwrap();
    assert_eq!(restored.head.head_revision, 4);
    assert_eq!(RecordDocumentService::new(&store, &utility).restore(&request, &restore).await.unwrap().head.head_revision, 4);
    let (restore_id, restore_state): (String, String) = receipt.query_row(
        "SELECT operation_id,undo_state FROM agent_operation_receipts WHERE caller_id=?1 AND request_id=?2",
        rusqlite::params![request.caller.key(),request.request_id], |r| Ok((r.get(0)?,r.get(1)?)),
    ).unwrap();
    assert_eq!(restore_state, "available");
    let metadata_before = store.db.lock().unwrap().record_metadata_get(&created.target).unwrap().revision;
    request.request_id = "connection-undo-restore".into();
    utility.projection = baseline.clone();
    let undo_restore = crate::agent::operations::OperationUndoInput {
        operation_id: restore_id, expected_head_revision: 4,
    };
    let undone_restore = RecordDocumentService::new(&store, &utility).undo_operation(&request, &undo_restore).await.unwrap();
    let crate::agent::operations::OperationUndoResult::ModifiedRecord(undone_restore) = undone_restore else { panic!("expected restore undo") };
    assert_eq!(undone_restore.head.head_revision, 5);
    assert_eq!(undone_restore.head.body_hash, baseline.body_hash);
    assert_eq!(store.db.lock().unwrap().record_metadata_get(&created.target).unwrap().revision, metadata_before);
    assert!(!create_id.is_empty());
}

#[tokio::test]
async fn connection_creation_withdraw_restore_requires_exact_owner_and_replays_when_withdrawn() {
    let (directory, store, utility, mut request, _) = setup();
    store.db.lock().unwrap().bind_native_workspace(&request.binding.workspace_id).unwrap();
    request.caller = Caller::Connection { grant_id: "owner".into() };
    request.scope_grant.operations.extend(["content.create".into(), "source.read".into(),
        "operation.undo".into(), "operation.restore_created".into()]);
    let input = crate::record_documents::RecordCreate {
        scope: Scope::Workspace, title: Some("Withdraw me".into()), tag_ids: vec![],
        document: utility.projection.document.clone(), code_language: None,
    };
    request.request_id = "owner-create".into();
    let created = RecordDocumentService::new(&store, &utility).create(&request, &input).await.unwrap();
    let create_id: String = rusqlite::Connection::open(directory.path().join("app.sqlite")).unwrap()
        .query_row("SELECT operation_id FROM agent_operation_receipts WHERE caller_id=?1 AND request_id=?2",
            rusqlite::params![request.caller.key(), request.request_id], |r|r.get(0)).unwrap();
    let mut other = request.clone();
    other.caller = Caller::Connection { grant_id: "other".into() };
    other.request_id = "other-undo".into();
    let undo = crate::agent::operations::OperationUndoInput { operation_id: create_id.clone(), expected_head_revision: 1 };
    assert_eq!(RecordDocumentService::new(&store, &utility).undo_operation(&other, &undo).await.unwrap_err().code, ErrorCode::ScopeDenied);
    let object = ObjectRef {
        workspace_id: request.binding.workspace_id.clone(), scope: created.target.scope.clone(),
        kind: ObjectKind::Record, id: created.target.record_id.to_string(),
    };
    store.db.lock().unwrap().source_read_object(&request, &request.binding, &object).unwrap();
    let sql = rusqlite::Connection::open(directory.path().join("app.sqlite")).unwrap();
    sql.execute("INSERT INTO source_access_policies(object_key,excluded,revision) VALUES (?1,1,1)", [object.key().unwrap()]).unwrap();
    request.request_id = "owner-policy-blocked-undo".into();
    assert_eq!(RecordDocumentService::new(&store, &utility).undo_operation(&request, &undo).await.unwrap_err().code, ErrorCode::ScopeDenied);
    sql.execute("UPDATE source_access_policies SET excluded=0,revision=2 WHERE object_key=?1", [object.key().unwrap()]).unwrap();
    request.request_id = "owner-undo".into();
    let withdrawn = RecordDocumentService::new(&store, &utility).undo_operation(&request, &undo).await.unwrap();
    let crate::agent::operations::OperationUndoResult::CreatedRecord(withdrawn) = withdrawn else { panic!("expected creation withdrawal") };
    assert!(withdrawn.withdrawn);
    sql.execute("UPDATE source_access_policies SET excluded=1,revision=3 WHERE object_key=?1", [object.key().unwrap()]).unwrap();
    assert!(matches!(RecordDocumentService::new(&store, &utility).undo_operation(&request, &undo).await.unwrap(), crate::agent::operations::OperationUndoResult::CreatedRecord(_)));
    assert_eq!(RecordDocumentService::new(&store, &utility).authorize_target(&request, &created.target, "record.patch").unwrap_err().code, ErrorCode::ObjectWithdrawn);
    request.request_id = "owner-restore-created".into();
    let restored = store.db.lock().unwrap().agent_record_creation_restore(
        &request, &request.binding,
        &crate::db::agent_record_withdrawals::RecordRestoreInput {
            creation_operation_id: create_id, expected_withdrawal_revision: withdrawn.revision,
        },
    ).unwrap();
    assert!(!restored.withdrawn);
}

#[tokio::test]
async fn connection_creation_checks_live_project_and_referenced_source_policy() {
    let (directory, store, mut utility, mut request, _) = setup();
    store.db.lock().unwrap().bind_native_workspace(&request.binding.workspace_id).unwrap();
    request.caller = Caller::Connection { grant_id: "policy-writer".into() };
    request.scope_grant.operations.extend(["content.create".into(), "source.read".into(), "record.patch".into()]);
    let (project_id, referenced_id) = {
        let mut db = store.db.lock().unwrap();
        let project = db.project_create(crate::models::ProjectCreateInput {
            name: "Policy project".into(), summary: None, status: None,
        }).unwrap();
        let record = db.project_record_upsert(crate::models::ProjectRecordUpsertInput {
            project_id: project.id, note_id: None, title: Some("Hidden source".into()),
            markdown: "Reference".into(), html: "<p>Reference</p>".into(),
            default_code_language: None, tag_ids: vec![],
        }).unwrap();
        (project.id, record.id)
    };
    request.scope_grant.project_ids.push(project_id);
    let mut input = crate::record_documents::RecordCreate {
        scope: Scope::Project { project_id }, title: Some("New".into()), tag_ids: vec![],
        document: utility.projection.document.clone(), code_language: None,
    };
    request.request_id = "archived-create".into();
    let sql = rusqlite::Connection::open(directory.path().join("app.sqlite")).unwrap();
    sql.execute("UPDATE projects SET is_archived=1 WHERE id=?1", [project_id]).unwrap();
    assert_eq!(RecordDocumentService::new(&store, &utility).create(&request, &input).await.unwrap_err().code, ErrorCode::ScopeDenied);
    assert_eq!(utility.calls.load(Ordering::Relaxed), 0);
    sql.execute("UPDATE projects SET is_archived=0 WHERE id=?1", [project_id]).unwrap();
    input.scope = Scope::Workspace;
    input.document["content"][0]["content"] = json!([{
        "type":"internalReference", "attrs":{"refKind":"note","refId":referenced_id,"label":"Hidden source"}
    }]);
    utility.projection.document = input.document.clone();
    utility.projection.body_hash = crate::record_documents::body_hash(
        &input.document, &utility.projection.code_language,
    );
    let referenced = ObjectRef {
        workspace_id: request.binding.workspace_id.clone(), scope: Scope::Project { project_id },
        kind: ObjectKind::Record, id: referenced_id.to_string(),
    };
    // The first policy read creates the native policy table if needed.
    store.db.lock().unwrap().source_read_object(&request, &request.binding, &referenced).unwrap();
    sql.execute("INSERT INTO source_access_policies(object_key,excluded,revision) VALUES (?1,1,1)", [referenced.key().unwrap()]).unwrap();
    request.request_id = "excluded-reference-create".into();
    assert_eq!(RecordDocumentService::new(&store, &utility).create(&request, &input).await.unwrap_err().code, ErrorCode::ScopeDenied);
    request.request_id = "excluded-target-patch".into();
    let patch = append_patch(&request, &RecordTarget { scope: Scope::Project { project_id }, record_id: referenced_id }, &utility.projection);
    assert_eq!(RecordDocumentService::new(&store, &utility).patch(&request, &patch).await.unwrap_err().code, ErrorCode::ScopeDenied);
}
