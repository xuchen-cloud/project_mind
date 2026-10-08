//! Shared Record output/operation dispatch. Authority is supplied by the Host;
//! tool arguments never choose a caller, Workspace binding, grant or run mode.
use super::{
    access::{Caller, RequestContext},
    errors::{AgentError, AgentResult, ErrorCode},
    operations::{OperationGetInput, OperationListInput, OperationUndoInput},
    output_commands::{OutputCommitInput, OutputGetInput},
    output_runtime::{OutputUpdateInput, RuntimeOutput, StageRecordInput},
    outputs::OutputIntent,
    record_outputs::{RecordOutputResult, RecordOutputService},
};
use crate::{
    committed_changes::capture_committed,
    db::agent_record_withdrawals::RecordRestoreInput,
    record_document_service::{BoundRecordStore, DocumentUtility, RecordDocumentService},
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};

fn decode<T: DeserializeOwned>(value: Value) -> AgentResult<T> {
    serde_json::from_value(value).map_err(|_| {
        AgentError::new(
            ErrorCode::InvalidArgument,
            "Arguments do not match the output input DTO",
        )
    })
}
fn encode(value: impl Serialize) -> AgentResult<Value> {
    serde_json::to_value(value).map_err(|_| {
        AgentError::new(
            ErrorCode::RuntimeIncompatible,
            "Cannot serialize output result",
        )
    })
}
fn card(output: &RuntimeOutput) -> Value {
    let title = match &output.staged.intent {
        OutputIntent::RecordCreate { title, .. } => title.clone(),
        OutputIntent::RecordPatch { patch } => format!("Record {}", patch.record.id),
        _ => String::new(),
    };
    json!({"outputId":output.staged.id,"revision":output.staged.revision,"ordinal":output.staged.ordinal,"state":output.state,"mode":output.mode,"title":title,"object":output.object,"sourceCount":output.staged.sources.len(),"errorCode":output.error_code})
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelOutputListInput {
    cursor: Option<String>,
    #[serde(default = "page_limit")]
    limit: u16,
}
fn page_limit() -> u16 {
    50
}
fn saved(result: RecordOutputResult) -> AgentResult<Value> {
    let operation = result.operation;
    let mut reply = card(&result.output);
    reply["operationId"] = operation
        .as_ref()
        .map_or(Value::Null, |operation| json!(operation.operation_id));
    reply["undoAvailable"] = json!(operation
        .as_ref()
        .is_some_and(|operation| operation.undo_state == "available"));
    // Native Record results contain heads, immutable version IDs and patch
    // normalizations, never the generated document or Markdown.
    if let Some(receipt) = result.receipt {
        if let Some(normalizations) = receipt.get("normalizations") {
            reply["normalizations"] = normalizations.clone();
        }
        reply["receipt"] = receipt;
    }
    Ok(reply)
}

pub(crate) async fn dispatch_output<S: BoundRecordStore, R: DocumentUtility>(
    store: &S,
    utility: &R,
    request: &RequestContext,
    method: &str,
    arguments: Value,
) -> AgentResult<Value> {
    if serde_json::to_vec(&arguments)
        .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Invalid output arguments"))?
        .len()
        > 1024 * 1024
    {
        return Err(AgentError::new(
            ErrorCode::BudgetExceeded,
            "Output arguments exceed tool budget",
        ));
    }
    match method {
        "output.stage" => {
            let input: StageRecordInput = decode(arguments)?;
            saved(
                RecordOutputService::new(store, utility)
                    .stage_and_execute(request, &input)
                    .await?,
            )
        }
        "output.get" => {
            let input: OutputGetInput = decode(arguments)?;
            store.with_current(|binding, db| {
                encode(db.agent_output_get(request, binding, &input.output_id)?)
            })
        }
        "output.list" => {
            let input: ModelOutputListInput = decode(arguments)?;
            let Caller::BuiltinRun { run_id } = &request.caller else {
                return Err(AgentError::new(
                    ErrorCode::ScopeDenied,
                    "Model output listing belongs to its own run",
                ));
            };
            store.with_current(|binding, db| {
                let page = db.agent_output_list(request, binding, run_id, input.cursor.as_deref(), input.limit)?;
                Ok(json!({"outputs":page.outputs.iter().map(card).collect::<Vec<_>>(),"nextCursor":page.next_cursor}))
            })
        }
        "output.update" => {
            let input: OutputUpdateInput = decode(arguments)?;
            let output = RecordOutputService::new(store, utility)
                .update_record(request, &input)
                .await?;
            Ok(card(&output))
        }
        "output.commit" => {
            let input: OutputCommitInput = decode(arguments)?;
            saved(
                RecordOutputService::new(store, utility)
                    .commit_record(request, &input.output_id, input.expected_revision)
                    .await?,
            )
        }
        "operation.get" => {
            let input: OperationGetInput = decode(arguments)?;
            store.with_current(|binding, db| {
                encode(db.agent_operation_get(request, binding, &input.operation_id)?)
            })
        }
        "operation.list" => {
            let input: OperationListInput = decode(arguments)?;
            store.with_current(|binding, db| {
                encode(db.agent_operation_list(request, binding, &input)?)
            })
        }
        "operation.undo" => {
            let input: OperationUndoInput = decode(arguments)?;
            encode(
                RecordDocumentService::new(store, utility)
                    .undo_operation(request, &input)
                    .await?,
            )
        }
        "operation.restore_created" => {
            let input: RecordRestoreInput = decode(arguments)?;
            let (result, changes) = store.with_current(|binding, db| {
                capture_committed(binding, db, &request.request_id, || {
                    db.agent_record_creation_restore(request, binding, &input)
                })
            })?;
            if let Some(changes) = changes {
                store.publish_committed(changes);
            }
            encode(result?)
        }
        _ => Err(AgentError::new(
            ErrorCode::ToolCallUnsupported,
            "Output method is not registered",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            access::{Caller, ScopeGrant},
            conversation::RunPreparation,
            models::{ExecutionMode, ObjectRef, Scope, WorkspaceBinding},
            record_blocks::{get_record_blocks, RecordBlocksInput},
        },
        committed_changes::{CommittedChangePublisher, CommittedChanges},
        db::Database,
        record_documents::{body_hash, RecordDocumentProjection, RecordTarget},
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    };
    const BLOCK: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    struct Store {
        binding: WorkspaceBinding,
        db: Mutex<Database>,
        published: Mutex<Vec<CommittedChanges>>,
    }
    impl CommittedChangePublisher for Store {
        fn publish_committed(&self, changes: CommittedChanges) {
            assert!(self.db.try_lock().is_ok());
            self.published.lock().unwrap().push(changes);
        }
    }
    impl BoundRecordStore for Store {
        async fn flush_editors(&self, _: &WorkspaceBinding, _: &RecordTarget) -> AgentResult<()> {
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
            action(&self.binding, &self.db.lock().unwrap())
        }
    }
    struct Utility {
        calls: AtomicUsize,
        fail: Option<ErrorCode>,
    }
    fn projected(document: Value) -> RecordDocumentProjection {
        let text = document["content"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_owned();
        RecordDocumentProjection {
            schema_version: 1,
            body_hash: body_hash(&document, &None),
            document,
            html: format!("<p data-block-id=\"{BLOCK}\">{text}</p>"),
            markdown: text.clone(),
            text,
            code_language: None,
        }
    }
    impl DocumentUtility for Utility {
        async fn request(&self, _: &str, method: &str, data: Value) -> AgentResult<Value> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            if let Some(code) = self.fail {
                return Err(AgentError::new(code, "Fixture converter failure"));
            }
            let mut document = if method == "record.initialize" {
                json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":BLOCK},"content":[{"type":"text","text":data["markdown"]}]}]})
            } else {
                data["document"].clone()
            };
            if method == "record.patch" {
                assert_eq!(data["operations"][0]["op"], "append_inline");
                assert_eq!(data["operations"][0]["blockId"], BLOCK);
                let text = format!(
                    "{}{}",
                    document["content"][0]["content"][0]["text"]
                        .as_str()
                        .unwrap(),
                    data["operations"][0]["text"].as_str().unwrap()
                );
                document["content"][0]["content"][0]["text"] = json!(text);
            }
            let mut result = serde_json::to_value(projected(document)).unwrap();
            if method == "record.patch" {
                result["patch"] = json!({"createdBlockIds":[],"deletedBlockIds":[],"normalizations":[],"noChange":false});
            }
            Ok(result)
        }
    }
    fn fixture(
        mode: ExecutionMode,
    ) -> (
        tempfile::TempDir,
        Store,
        Utility,
        RequestContext,
        RequestContext,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(&dir.path().join("app.sqlite"), dir.path(), None).unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "workspace-tools".into(),
            generation: "generation".into(),
        };
        db.bind_native_workspace(&binding.workspace_id).unwrap();
        let gui = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "gui".into(),
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
                    "source.read",
                    "content.create",
                    "record.patch",
                    "record.read",
                    "record.write",
                    "record.metadata.write",
                    "operation.read",
                    "operation.undo",
                    "operation.restore_created",
                ]
                .into_iter()
                .map(str::to_owned)
                .collect(),
            },
        };
        let session = db
            .agent_session_create(&gui, &binding, &Scope::Workspace, "Fixture", "pi", None)
            .unwrap();
        let run = db
            .agent_run_prepare(
                &gui,
                &binding,
                &session.id,
                "request",
                &RunPreparation {
                    run_id: "1".repeat(32),
                    context_manifest: json!({"scope":Scope::Workspace,"mode":mode}),
                },
            )
            .unwrap()
            .run;
        db.agent_run_start(&gui, &binding, &run.id).unwrap();
        let builtin = RequestContext {
            caller: Caller::BuiltinRun { run_id: run.id },
            request_id: "first-stage".into(),
            ..gui.clone()
        };
        (
            dir,
            Store {
                binding,
                db: Mutex::new(db),
                published: Mutex::new(vec![]),
            },
            Utility {
                calls: AtomicUsize::new(0),
                fail: None,
            },
            builtin,
            gui,
        )
    }
    fn stage() -> Value {
        json!({"intent":{"intent":"record_create","scope":{"kind":"workspace"},"title":"Generated","markdown":"Body"},"sources":[]})
    }
    #[tokio::test]
    async fn output_tools_real_create_receipt_withdraw_restore_and_compact_replay() {
        let (_dir, store, utility, mut builtin, _gui) = fixture(ExecutionMode::Collaborate);
        let input = stage();
        let reply = dispatch_output(&store, &utility, &builtin, "output.stage", input.clone())
            .await
            .unwrap();
        assert_eq!(reply["state"], "committed");
        assert_eq!(reply["undoAvailable"], true);
        assert_eq!(reply["operationId"].as_str().unwrap().len(), 32);
        assert!(reply.get("intent").is_none());
        assert!(reply.get("markdown").is_none());
        assert!(reply.get("document").is_none());
        let calls = utility.calls.load(Ordering::Relaxed);
        let again = dispatch_output(&store, &utility, &builtin, "output.stage", input)
            .await
            .unwrap();
        assert_eq!(again["operationId"], reply["operationId"]);
        assert_eq!(again["object"], reply["object"]);
        assert_eq!(utility.calls.load(Ordering::Relaxed), calls);
        builtin.request_id = "get-receipt".into();
        let operation = dispatch_output(
            &store,
            &utility,
            &builtin,
            "operation.get",
            json!({"operationId":reply["operationId"]}),
        )
        .await
        .unwrap();
        assert_eq!(operation["kind"], "record.create");
        assert!(operation["afterSnapshotRef"].is_string());
        builtin.request_id = "undo-create".into();
        let undo = dispatch_output(
            &store,
            &utility,
            &builtin,
            "operation.undo",
            json!({"operationId":reply["operationId"],"expectedHeadRevision":1}),
        )
        .await
        .unwrap();
        assert_eq!(undo["withdrawn"], true);
        builtin.request_id = "restore-create".into();
        let restored=dispatch_output(&store,&utility,&builtin,"operation.restore_created",json!({"creationOperationId":reply["operationId"],"expectedWithdrawalRevision":undo["revision"]})).await.unwrap();
        assert_eq!(restored["withdrawn"], false);
        assert_eq!(restored["object"], reply["object"]);
        assert!(!store.published.lock().unwrap().is_empty());
        let object: ObjectRef = serde_json::from_value(reply["object"].clone()).unwrap();
        store
            .with_current(|_, db| {
                let target = RecordTarget {
                    scope: object.scope.clone(),
                    record_id: object.id.parse().unwrap(),
                };
                let head = db.record_document_head(&target)?.unwrap();
                assert_eq!(head.head_revision, 1);
                assert_eq!(head.projection.text, "Body");
                assert_eq!(db.record_version_capacity(&target)?.version_count, 1);
                Ok(())
            })
            .unwrap();
    }
    #[tokio::test]
    async fn output_tools_second_round_patch_uses_real_block_hash_and_native_undo() {
        let (_dir, store, utility, mut builtin, _gui) = fixture(ExecutionMode::Collaborate);
        let created = dispatch_output(&store, &utility, &builtin, "output.stage", stage())
            .await
            .unwrap();
        let object: ObjectRef = serde_json::from_value(created["object"].clone()).unwrap();
        let blocks = store
            .with_current(|binding, db| {
                get_record_blocks(
                    db,
                    &builtin,
                    binding,
                    &RecordBlocksInput {
                        record: object.clone(),
                        revision: Some(1),
                        block_id: None,
                        cursor: None,
                        budget_chars: Some(4000),
                    },
                )
            })
            .unwrap();
        let identity = &blocks.items[0].tree[0];
        builtin.request_id = "patch-stage".into();
        let patched=dispatch_output(&store,&utility,&builtin,"output.stage",json!({"intent":{"intent":"record_patch","patch":{"record":object,"baseRevision":blocks.head_revision,"requestId":"model-cannot-mint-commit","operations":[{"op":"append_inline","blockId":identity.block_id,"expectedBlockHash":identity.block_hash,"text":" revised"}]}},"sources":[]})).await.unwrap();
        assert_eq!(patched["state"], "committed");
        assert_eq!(patched["receipt"]["afterRevision"], 2);
        assert!(patched["normalizations"].is_array());
        assert_eq!(
            patched["operationId"],
            patched["receipt"]["receipt"]["operationId"]
        );
        builtin.request_id = "undo-patch".into();
        let undo = dispatch_output(
            &store,
            &utility,
            &builtin,
            "operation.undo",
            json!({"operationId":patched["operationId"],"expectedHeadRevision":2}),
        )
        .await
        .unwrap();
        assert_eq!(undo["head"]["headRevision"], 3);
        store
            .with_current(|_, db| {
                let target = RecordTarget {
                    scope: object.scope.clone(),
                    record_id: object.id.parse().unwrap(),
                };
                let head = db.record_document_head(&target)?.unwrap();
                assert_eq!(head.projection.text, "Body");
                assert_eq!(db.record_version_capacity(&target)?.version_count, 3);
                Ok(())
            })
            .unwrap();
        builtin.request_id = "undo-create-after-edit".into();
        assert_eq!(
            dispatch_output(
                &store,
                &utility,
                &builtin,
                "operation.undo",
                json!({"operationId":created["operationId"],"expectedHeadRevision":1})
            )
            .await
            .unwrap_err()
            .code,
            ErrorCode::UndoConflict
        );
    }
    #[tokio::test]
    async fn output_tools_readonly_review_and_strict_model_authority_boundaries() {
        let (_dir, store, utility, builtin, _gui) = fixture(ExecutionMode::ReadOnly);
        assert_eq!(
            dispatch_output(&store, &utility, &builtin, "output.stage", stage())
                .await
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(utility.calls.load(Ordering::Relaxed), 0);
        let (_dir, store, utility, mut builtin, gui) = fixture(ExecutionMode::Review);
        let mut injected = stage();
        injected["runId"] = json!("2".repeat(32));
        assert_eq!(
            dispatch_output(&store, &utility, &builtin, "output.stage", injected)
                .await
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        let reply = dispatch_output(&store, &utility, &builtin, "output.stage", stage())
            .await
            .unwrap();
        assert_eq!(reply["state"], "staged");
        assert!(reply["object"].is_null());
        assert!(reply["operationId"].is_null());
        assert!(store.published.lock().unwrap().is_empty());
        let id = reply["outputId"].clone();
        builtin.request_id = "review-model-commit".into();
        assert_eq!(
            dispatch_output(
                &store,
                &utility,
                &builtin,
                "output.commit",
                json!({"outputId":id,"expectedRevision":1})
            )
            .await
            .unwrap_err()
            .code,
            ErrorCode::ScopeDenied
        );
        let list = dispatch_output(
            &store,
            &utility,
            &builtin,
            "output.list",
            json!({"cursor":null,"limit":50}),
        )
        .await
        .unwrap();
        assert_eq!(list["outputs"].as_array().unwrap().len(), 1);
        assert!(list.to_string().find("markdown").is_none());
        let committed = dispatch_output(
            &store,
            &utility,
            &gui,
            "output.commit",
            json!({"outputId":id,"expectedRevision":1}),
        )
        .await
        .unwrap();
        assert_eq!(committed["state"], "committed");
        assert_eq!(dispatch_output(&store,&utility,&builtin,"output.stage",json!({"intent":{"intent":"todo_create","scope":{"kind":"workspace"},"content":"Todo"},"sources":[]})).await.unwrap_err().code,ErrorCode::ToolCallUnsupported);
    }
    #[tokio::test]
    async fn output_tools_preserves_converter_error_code_without_success_ack() {
        let (_dir, store, mut utility, builtin, _gui) = fixture(ExecutionMode::Collaborate);
        utility.fail = Some(ErrorCode::RuntimeUnavailable);
        assert_eq!(
            dispatch_output(&store, &utility, &builtin, "output.stage", stage())
                .await
                .unwrap_err()
                .code,
            ErrorCode::RuntimeUnavailable
        );
        let outputs = dispatch_output(
            &store,
            &utility,
            &builtin,
            "output.list",
            json!({"limit":50}),
        )
        .await
        .unwrap();
        assert!(outputs["outputs"].as_array().unwrap().is_empty());
        assert!(store.published.lock().unwrap().is_empty());
    }
}
