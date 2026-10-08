use super::*;
use crate::{
    agent::{
        access::{Caller, ScopeGrant},
        conversation::RunPreparation,
        models::{ObjectKind, ObjectRef, Scope, SourceRef, WorkspaceBinding},
        output_runtime::OutputState,
        outputs::{BlockEdit, BlockInput, RecordPatch},
    },
    committed_changes::{CommittedChangePublisher, CommittedChanges},
    db::Database,
    record_documents::{
        RecordCommittedHead, RecordDocumentCommit, RecordTarget, RecordVersionOrigin,
    },
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};

struct Store {
    binding: Mutex<WorkspaceBinding>,
    db: Arc<Mutex<Database>>,
    events: Mutex<Vec<CommittedChanges>>,
    on_flush: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}
impl CommittedChangePublisher for Store {
    fn publish_committed(&self, changes: CommittedChanges) {
        assert!(self.db.try_lock().is_ok());
        self.events.lock().unwrap().push(changes);
    }
}
impl BoundRecordStore for Store {
    async fn flush_editors(&self, _: &WorkspaceBinding, _: &RecordTarget) -> AgentResult<()> {
        if let Some(callback) = self.on_flush.lock().unwrap().as_ref() {
            callback();
        }
        Ok(())
    }
    async fn submission_lock(
        &self,
        _: &WorkspaceBinding,
        _: &RecordTarget,
    ) -> AgentResult<Option<tokio::sync::OwnedMutexGuard<()>>> {
        Ok(None)
    }
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        action(&self.binding.lock().unwrap(), &self.db.lock().unwrap())
    }
}
struct Utility {
    calls: AtomicUsize,
    projection: RecordDocumentProjection,
    error: Option<ErrorCode>,
}
impl DocumentUtility for Utility {
    async fn request(&self, _: &str, method: &str, data: Value) -> AgentResult<Value> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        if let Some(error) = self.error {
            return Err(AgentError::new(error, "Converter unavailable"));
        }
        if method == "record.initialize" {
            assert!(data["markdown"].is_string());
        }
        let mut value = serde_json::to_value(&self.projection).unwrap();
        if method == "record.patch" {
            value["patch"] = json!({"createdBlockIds":[],"deletedBlockIds":[],"normalizations":[],"noChange":false});
        }
        Ok(value)
    }
}
fn projection_fixture() -> RecordDocumentProjection {
    let mut projection: RecordDocumentProjection =
        serde_json::from_str(include_str!("../record_document_projection.fixture.json")).unwrap();
    projection.document["content"] = json!([projection.document["content"][0].clone()]);
    projection.html = "<p><strong>Fixture 正文</strong></p>".into();
    projection.markdown = "**Fixture 正文**".into();
    projection.text = "Fixture 正文".into();
    projection.body_hash =
        crate::record_documents::body_hash(&projection.document, &projection.code_language);
    projection
}
fn setup(
    mode: ExecutionMode,
) -> (
    tempfile::TempDir,
    Store,
    Utility,
    RequestContext,
    RequestContext,
) {
    let directory = tempfile::tempdir().unwrap();
    let mut db = Database::open(
        &directory.path().join("outputs.sqlite"),
        directory.path(),
        None,
    )
    .unwrap();
    let binding = WorkspaceBinding {
        workspace_id: "workspace-test".into(),
        generation: "generation-1".into(),
    };
    db.bind_native_workspace(&binding.workspace_id).unwrap();
    let gui = RequestContext {
        binding: binding.clone(),
        caller: Caller::Gui,
        request_id: "create-session".into(),
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: true,
            project_ids: vec![],
            operations: [
                "session.read",
                "session.write",
                "run.start",
                "output.stage",
                "output.read",
                "output.update",
                "output.commit",
                "content.create",
                "record.patch",
                "record.read",
                "record.write",
                "record.metadata.write",
                "source.read",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        },
    };
    let session = db
        .agent_session_create(&gui, &binding, &Scope::Workspace, "Outputs", "pi", None)
        .unwrap();
    let run = db
        .agent_run_prepare(
            &gui,
            &binding,
            &session.id,
            "run-original",
            &RunPreparation {
                run_id: "a".repeat(32),
                context_manifest: json!({"scope":Scope::Workspace,"mode":mode}),
            },
        )
        .unwrap()
        .run;
    db.agent_run_start(&gui, &binding, &run.id).unwrap();
    let mut builtin = gui.clone();
    builtin.caller = Caller::BuiltinRun { run_id: run.id };
    builtin.request_id = "stage-original".into();
    let utility = Utility {
        calls: AtomicUsize::new(0),
        projection: projection_fixture(),
        error: None,
    };
    (
        directory,
        Store {
            binding: Mutex::new(binding),
            db: Arc::new(Mutex::new(db)),
            events: Mutex::new(vec![]),
            on_flush: Mutex::new(None),
        },
        utility,
        builtin,
        gui,
    )
}
fn candidate() -> StageRecordInput {
    StageRecordInput {
        intent: OutputIntent::RecordCreate {
            scope: Scope::Workspace,
            title: "成果".into(),
            markdown: "**Fixture 正文**".into(),
        },
        sources: vec![],
    }
}
fn record_count(store: &Store) -> usize {
    store
        .db
        .lock()
        .unwrap()
        .workspace_record_list()
        .unwrap()
        .len()
}
fn output_count(store: &Store, request: &RequestContext) -> usize {
    let Caller::BuiltinRun { run_id } = &request.caller else {
        panic!("Expected builtin fixture");
    };
    store
        .with_current(|binding, db| db.agent_output_list(request, binding, run_id, None, 50))
        .unwrap()
        .outputs
        .len()
}

#[tokio::test]
async fn record_output_collaborate_commits_once_and_replays_actual_receipt() {
    let (_directory, store, utility, request, _) = setup(ExecutionMode::Collaborate);
    let service = RecordOutputService::new(&store, &utility);
    let saved = service
        .stage_and_execute(&request, &candidate())
        .await
        .unwrap();
    assert!(matches!(saved.output.state, OutputState::Committed));
    assert!(saved.receipt.is_some());
    assert_eq!(record_count(&store), 1);
    let head: RecordCommittedHead = serde_json::from_value(saved.receipt.clone().unwrap()).unwrap();
    assert_eq!(
        store
            .db
            .lock()
            .unwrap()
            .record_version_capacity(&head.target)
            .unwrap()
            .version_count,
        1
    );
    let calls = utility.calls.load(Ordering::Relaxed);
    let again = service
        .stage_and_execute(&request, &candidate())
        .await
        .unwrap();
    assert_eq!(saved.output.staged.id, again.output.staged.id);
    assert_eq!(saved.receipt, again.receipt);
    assert_eq!(utility.calls.load(Ordering::Relaxed), calls);
    assert_eq!(record_count(&store), 1);
    assert_eq!(store.events.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn record_output_review_stages_without_writing_and_gui_commits() {
    let (_directory, store, utility, request, gui) = setup(ExecutionMode::Review);
    let service = RecordOutputService::new(&store, &utility);
    let staged = service
        .stage_and_execute(&request, &candidate())
        .await
        .unwrap();
    assert!(matches!(staged.output.state, OutputState::Staged));
    assert!(staged.receipt.is_none());
    assert_eq!(record_count(&store), 0);
    assert_eq!(
        service
            .commit_record(&request, &staged.output.staged.id, 1)
            .await
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    let saved = service
        .commit_record(&gui, &staged.output.staged.id, 1)
        .await
        .unwrap();
    assert!(matches!(saved.output.state, OutputState::Committed));
    assert_eq!(record_count(&store), 1);
}

#[tokio::test]
async fn record_output_gui_update_validates_before_cas_and_replays_without_conversion() {
    let (_directory, store, mut utility, request, mut gui) = setup(ExecutionMode::Review);
    let staged = RecordOutputService::new(&store, &utility)
        .stage_record(&request, &candidate())
        .await
        .unwrap();
    gui.request_id = "update-original".into();
    let mut updated = candidate();
    if let OutputIntent::RecordCreate { title, .. } = &mut updated.intent {
        *title = "Edited outcome".into();
    }
    let input = OutputUpdateInput {
        output_id: staged.staged.id.clone(),
        expected_revision: 1,
        candidate: updated,
    };
    utility.error = Some(ErrorCode::RuntimeUnavailable);
    assert_eq!(
        RecordOutputService::new(&store, &utility)
            .update_record(&gui, &input)
            .await
            .unwrap_err()
            .code,
        ErrorCode::RuntimeUnavailable
    );
    assert_eq!(
        store
            .with_current(|binding, db| db.agent_output_get(&gui, binding, &staged.staged.id))
            .unwrap()
            .staged
            .revision,
        1
    );
    utility.error = None;
    let updated = RecordOutputService::new(&store, &utility)
        .update_record(&gui, &input)
        .await
        .unwrap();
    assert_eq!(updated.staged.revision, 2);
    assert_eq!(record_count(&store), 0);
    let calls = utility.calls.load(Ordering::Relaxed);
    let replay = RecordOutputService::new(&store, &utility)
        .update_record(&gui, &input)
        .await
        .unwrap();
    assert_eq!(replay.staged.revision, 2);
    assert_eq!(utility.calls.load(Ordering::Relaxed), calls);
    let saved = RecordOutputService::new(&store, &utility)
        .commit_record(&gui, &staged.staged.id, 2)
        .await
        .unwrap();
    assert!(matches!(saved.output.state, OutputState::Committed));
    assert_eq!(record_count(&store), 1);
    assert!(saved.operation.is_some());
}

#[tokio::test]
async fn record_output_readonly_or_source_write_grant_cannot_stage() {
    let (_directory, store, utility, request, _) = setup(ExecutionMode::ReadOnly);
    assert_eq!(
        RecordOutputService::new(&store, &utility)
            .stage_record(&request, &candidate())
            .await
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    assert_eq!(utility.calls.load(Ordering::Relaxed), 0);
    assert_eq!(output_count(&store, &request), 0);
    let (_directory, store, utility, request, _) = setup(ExecutionMode::Collaborate);
    let mut foreign = candidate();
    if let OutputIntent::RecordCreate { scope, .. } = &mut foreign.intent {
        *scope = Scope::Project { project_id: 123 };
    }
    assert_eq!(
        RecordOutputService::new(&store, &utility)
            .stage_record(&request, &foreign)
            .await
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    let mut citations = candidate();
    citations.sources.push(SourceRef {
        object: ObjectRef {
            workspace_id: request.binding.workspace_id.clone(),
            scope: Scope::Project { project_id: 123 },
            kind: ObjectKind::Record,
            id: "7".into(),
        },
        revision: format!("sha256:{}", "b".repeat(64)),
        title: "Foreign".into(),
        excerpt: String::new(),
        block_id: None,
        record_version: None,
        file_version: None,
        locator: None,
    });
    assert_eq!(
        RecordOutputService::new(&store, &utility)
            .stage_record(&request, &citations)
            .await
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    assert_eq!(utility.calls.load(Ordering::Relaxed), 0);
    assert_eq!(record_count(&store), 0);
}

#[tokio::test]
async fn record_output_canonical_reference_cannot_expand_frozen_run_grant() {
    let (_directory, store, mut utility, mut request, _) = setup(ExecutionMode::Collaborate);
    let (project, record) = {
        let mut db = store.db.lock().unwrap();
        let project = db
            .project_create(crate::models::ProjectCreateInput {
                name: "Later granted project".into(),
                summary: None,
                status: Some("active".into()),
            })
            .unwrap();
        let record = db
            .project_record_upsert(crate::models::ProjectRecordUpsertInput {
                project_id: project.id,
                note_id: None,
                title: Some("Foreign source".into()),
                html: "<p>Source</p>".into(),
                markdown: "Source".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        (project.id, record.id)
    };
    request.scope_grant.project_ids.push(project);
    utility.projection.document["content"][0]["content"] = json!([{"type":"internalReference","attrs":{"refKind":"note","refId":record,"label":"Foreign source"}}]);
    utility.projection.body_hash = crate::record_documents::body_hash(
        &utility.projection.document,
        &utility.projection.code_language,
    );
    assert_eq!(
        RecordOutputService::new(&store, &utility)
            .stage_record(&request, &candidate())
            .await
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    assert_eq!(record_count(&store), 0);
    assert_eq!(output_count(&store, &request), 0);
}

#[tokio::test]
async fn record_output_worker_failure_marks_failed_without_saving() {
    let (_directory, store, mut utility, request, _) = setup(ExecutionMode::Collaborate);
    let staged = RecordOutputService::new(&store, &utility)
        .stage_record(&request, &candidate())
        .await
        .unwrap();
    utility.error = Some(ErrorCode::RuntimeUnavailable);
    assert_eq!(
        RecordOutputService::new(&store, &utility)
            .commit_record(&request, &staged.staged.id, 1)
            .await
            .unwrap_err()
            .code,
        ErrorCode::RuntimeUnavailable
    );
    let failed = store
        .with_current(|binding, db| db.agent_output_get(&request, binding, &staged.staged.id))
        .unwrap();
    assert!(matches!(failed.state, OutputState::Failed));
    assert_eq!(failed.error_code, Some(ErrorCode::RuntimeUnavailable));
    assert_eq!(record_count(&store), 0);
}

#[tokio::test]
async fn record_output_patch_flush_cas_conflict_preserves_editor_save_and_marks_failed() {
    let (_directory, store, mut utility, request, _) = setup(ExecutionMode::Collaborate);
    let initial = store
        .with_current(|_, db| {
            db.record_create(
                "gui",
                "fixture-create",
                &RecordCreate {
                    scope: Scope::Workspace,
                    title: Some("Existing".into()),
                    tag_ids: vec![],
                    document: utility.projection.document.clone(),
                    code_language: utility.projection.code_language.clone(),
                },
                &utility.projection,
                &request.binding.workspace_id,
            )
        })
        .unwrap();
    let patch = RecordPatch {
        record: ObjectRef {
            workspace_id: request.binding.workspace_id.clone(),
            scope: Scope::Workspace,
            kind: ObjectKind::Record,
            id: initial.target.record_id.to_string(),
        },
        base_revision: 1,
        request_id: "untrusted-model-request".into(),
        operations: vec![BlockEdit::Append {
            parent_block_id: None,
            position: None,
            blocks: vec![BlockInput {
                node_type: "paragraph".into(),
                attrs: Default::default(),
                content: vec![],
                text: None,
                marks: vec![],
            }],
        }],
    };
    let staged = RecordOutputService::new(&store, &utility)
        .stage_record(
            &request,
            &StageRecordInput {
                intent: OutputIntent::RecordPatch { patch },
                sources: vec![],
            },
        )
        .await
        .unwrap();
    utility.projection.document["content"][0]["content"][0]["text"] = json!("Editor draft");
    utility.projection.html = "<p><strong>Editor draft</strong></p>".into();
    utility.projection.markdown = "**Editor draft**".into();
    utility.projection.text = "Editor draft".into();
    utility.projection.body_hash = crate::record_documents::body_hash(
        &utility.projection.document,
        &utility.projection.code_language,
    );
    let draft = RecordDocumentCommit {
        target: initial.target.clone(),
        base_revision: 1,
        projection: utility.projection.clone(),
        origin: RecordVersionOrigin::Manual,
        actor: json!({"kind":"gui"}),
        edit_session_id: Some("c".repeat(32)),
    };
    let db = store.db.clone();
    let workspace = request.binding.workspace_id.clone();
    *store.on_flush.lock().unwrap() = Some(Box::new(move || {
        db.lock()
            .unwrap()
            .record_document_commit("gui", "editor-flush", &draft, &workspace)
            .unwrap();
    }));
    assert_eq!(
        RecordOutputService::new(&store, &utility)
            .commit_record(&request, &staged.staged.id, 1)
            .await
            .unwrap_err()
            .code,
        ErrorCode::RevisionConflict
    );
    let failed = store
        .with_current(|binding, db| db.agent_output_get(&request, binding, &staged.staged.id))
        .unwrap();
    assert!(matches!(failed.state, OutputState::Failed));
    assert_eq!(failed.error_code, Some(ErrorCode::RevisionConflict));
    let current = store
        .db
        .lock()
        .unwrap()
        .record_document_head(&initial.target)
        .unwrap()
        .unwrap();
    assert_eq!(current.head_revision, 2);
    assert_eq!(current.projection.text, "Editor draft");
    assert_eq!(output_count(&store, &request), 1);
    assert!(store
        .with_current(|binding, db| db.agent_output_record_receipt(
            &request,
            binding,
            &staged.staged.id,
            1
        ))
        .unwrap()
        .is_none());
    assert_eq!(
        store
            .db
            .lock()
            .unwrap()
            .record_version_capacity(&initial.target)
            .unwrap()
            .receipt_count,
        2
    ); // fixture create and editor save; failed native patch adds no receipt.
}

struct PreviewUtility<'a> {
    projection: RecordDocumentProjection,
    base: Value,
    calls: Mutex<Vec<String>>,
    during_compare: Option<Box<dyn Fn() + Send + Sync + 'a>>,
}
impl DocumentUtility for PreviewUtility<'_> {
    async fn request(&self, _: &str, method: &str, data: Value) -> AgentResult<Value> {
        self.calls.lock().unwrap().push(method.into());
        if method == "record.compare" {
            assert_eq!(data["document"], self.base);
            assert_eq!(data["otherDocument"], self.projection.document);
            if let Some(callback) = &self.during_compare {
                callback();
            }
            return Ok(json!({"added":[],"deleted":[],"modified":["1".repeat(32)],"moved":[]}));
        }
        assert_eq!(method, "record.patch");
        assert_eq!(data["document"], self.base);
        let mut projection = serde_json::to_value(&self.projection).unwrap();
        projection["patch"] =
            json!({"createdBlockIds":[],"deletedBlockIds":[],"normalizations":[],"noChange":false});
        Ok(projection)
    }
}

async fn preview_fixture() -> (
    tempfile::TempDir,
    Store,
    Utility,
    RequestContext,
    RecordCommittedHead,
    RuntimeOutput,
    StageRecordInput,
) {
    use sha2::{Digest, Sha256};
    let (directory, store, mut utility, builtin, gui) = setup(ExecutionMode::Review);
    let initial = store
        .with_current(|_, db| {
            db.record_create(
                "gui",
                "fixture-create",
                &RecordCreate {
                    scope: Scope::Workspace,
                    title: Some("Existing".into()),
                    tag_ids: vec![],
                    document: utility.projection.document.clone(),
                    code_language: utility.projection.code_language.clone(),
                },
                &utility.projection,
                &builtin.binding.workspace_id,
            )
        })
        .unwrap();
    let expected_block_hash = format!(
        "sha256:{:x}",
        Sha256::digest(utility.projection.document["content"][0].to_string())
    );
    utility.projection.document["content"][0]["content"][0]["text"] = json!("Fixture 正文 suffix");
    utility.projection.html = "<p><strong>Fixture 正文 suffix</strong></p>".into();
    utility.projection.markdown = "**Fixture 正文 suffix**".into();
    utility.projection.text = "Fixture 正文 suffix".into();
    utility.projection.body_hash = crate::record_documents::body_hash(
        &utility.projection.document,
        &utility.projection.code_language,
    );
    let input = StageRecordInput {
        intent: OutputIntent::RecordPatch {
            patch: RecordPatch {
                record: ObjectRef {
                    workspace_id: builtin.binding.workspace_id.clone(),
                    scope: Scope::Workspace,
                    kind: ObjectKind::Record,
                    id: initial.target.record_id.to_string(),
                },
                base_revision: 1,
                request_id: "model-proposal".into(),
                operations: vec![BlockEdit::AppendInline {
                    block_id: "1".repeat(32),
                    expected_block_hash,
                    text: " suffix".into(),
                }],
            },
        },
        sources: vec![],
    };
    let output = RecordOutputService::new(&store, &utility)
        .stage_record(&builtin, &input)
        .await
        .unwrap();
    (directory, store, utility, gui, initial, output, input)
}

#[tokio::test]
async fn record_output_preview_compares_actual_base_and_validated_candidate_without_saving() {
    let (_directory, store, utility, gui, initial, output, _) = preview_fixture().await;
    let before = store
        .db
        .lock()
        .unwrap()
        .record_document_head(&initial.target)
        .unwrap()
        .unwrap();
    let preview_utility = PreviewUtility {
        projection: utility.projection,
        base: before.projection.document.clone(),
        calls: Mutex::new(vec![]),
        during_compare: None,
    };
    *store.on_flush.lock().unwrap() = Some(Box::new(|| panic!("Preview must not flush editors")));
    let preview = RecordOutputService::new(&store, &preview_utility)
        .preview_record(&gui, &output.staged.id, 1)
        .await
        .unwrap();
    assert_eq!(preview.output_id, output.staged.id);
    assert_eq!(preview.revision, 1);
    assert_eq!(preview.base_revision, 1);
    assert_eq!(preview.difference.modified, vec!["1".repeat(32)]);
    assert!(
        preview.difference.added.is_empty()
            && preview.difference.deleted.is_empty()
            && preview.difference.moved.is_empty()
    );
    assert_eq!(
        *preview_utility.calls.lock().unwrap(),
        vec!["record.patch", "record.compare"]
    );
    let current = store
        .db
        .lock()
        .unwrap()
        .record_document_head(&initial.target)
        .unwrap()
        .unwrap();
    assert_eq!(current.head_revision, before.head_revision);
    assert_eq!(current.projection.document, before.projection.document);
    assert_eq!(
        store
            .db
            .lock()
            .unwrap()
            .record_version_capacity(&initial.target)
            .unwrap()
            .version_count,
        1
    );
    assert!(matches!(
        store
            .with_current(|binding, db| db.agent_output_get(&gui, binding, &output.staged.id))
            .unwrap()
            .state,
        OutputState::Staged
    ));
    assert!(store.events.lock().unwrap().is_empty());
}

#[tokio::test]
async fn record_output_preview_rejects_concurrent_base_output_or_binding_changes_without_writing() {
    for race in ["base", "output", "binding"] {
        let (_directory, store, utility, gui, initial, output, input) = preview_fixture().await;
        let before = store
            .db
            .lock()
            .unwrap()
            .record_document_head(&initial.target)
            .unwrap()
            .unwrap();
        let mut action = gui.clone();
        action.request_id = format!("race-{race}");
        let draft = RecordDocumentCommit {
            target: initial.target.clone(),
            base_revision: 1,
            projection: utility.projection.clone(),
            origin: RecordVersionOrigin::Manual,
            actor: json!({"kind":"gui"}),
            edit_session_id: Some("e".repeat(32)),
        };
        let update = OutputUpdateInput {
            output_id: output.staged.id.clone(),
            expected_revision: 1,
            candidate: input,
        };
        let preview_utility = PreviewUtility {
            projection: utility.projection,
            base: before.projection.document.clone(),
            calls: Mutex::new(vec![]),
            during_compare: Some(Box::new(|| match race {
                "base" => {
                    store
                        .db
                        .lock()
                        .unwrap()
                        .record_document_commit(
                            "gui",
                            "concurrent-editor",
                            &draft,
                            &gui.binding.workspace_id,
                        )
                        .unwrap();
                }
                "output" => {
                    store
                        .with_current(|binding, db| {
                            db.agent_output_update(&action, binding, &update)
                        })
                        .unwrap();
                }
                _ => {
                    store.binding.lock().unwrap().generation = "generation-2".into();
                }
            })),
        };
        *store.on_flush.lock().unwrap() =
            Some(Box::new(|| panic!("Preview must not flush editors")));
        let failure = RecordOutputService::new(&store, &preview_utility)
            .preview_record(&gui, &output.staged.id, 1)
            .await
            .unwrap_err();
        assert_eq!(
            failure.code,
            if race == "binding" {
                ErrorCode::WorkspaceChanged
            } else {
                ErrorCode::RevisionConflict
            }
        );
        let current = store
            .db
            .lock()
            .unwrap()
            .record_document_head(&initial.target)
            .unwrap()
            .unwrap();
        assert_eq!(current.head_revision, if race == "base" { 2 } else { 1 });
        assert_eq!(
            current.projection.document,
            if race == "base" {
                draft.projection.document.clone()
            } else {
                before.projection.document.clone()
            }
        );
        assert_eq!(record_count(&store), 1);
        assert!(store.events.lock().unwrap().is_empty());
    }
}
