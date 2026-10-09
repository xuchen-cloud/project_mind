//! Thin connection adapter for native content writes and connection receipts.
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        operations::{OperationGetInput, OperationUndoInput},
        outputs::RecordPatch,
    },
    committed_changes::capture_committed,
    record_document_service::{BoundRecordStore, DocumentUtility, RecordDocumentService},
    record_documents::{RecordCreate, RecordRestoreInput},
};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MutationInput<T> {
    #[schemars(length(min = 1, max = 128))]
    pub request_id: String,
    pub input: T,
}

impl<T> MutationInput<T> {
    pub(super) fn bind(self, request: &RequestContext) -> AgentResult<T> {
        if self.request_id != request.request_id {
            return Err(AgentError::new(ErrorCode::InvalidArgument, "Write requestId differs from request identity"));
        }
        Ok(self.input)
    }
}

fn decode<T: DeserializeOwned>(value: Value) -> AgentResult<T> {
    serde_json::from_value(value).map_err(|_| {
        AgentError::new(ErrorCode::InvalidArgument, "Arguments do not match the method input DTO")
    })
}

pub(crate) async fn execute<S: BoundRecordStore + crate::file_version_service::BoundFileCommitStore, W: DocumentUtility>(
    store: &S,
    worker: &W,
    request: &RequestContext,
    method: &str,
    params: Value,
) -> AgentResult<Value> {
    super::registry::validate(method, &params)?;
    let service = RecordDocumentService::new(store, worker);
    let result = match method {
        "record.create" => {
            let input = decode::<MutationInput<RecordCreate>>(params)?.bind(request)?;
            json!(service.create(request, &input).await?)
        }
        "record.patch" => {
            let input: RecordPatch = decode(params)?;
            json!(service.patch(request, &input).await?)
        }
        "record.restore" => {
            let input = decode::<MutationInput<RecordRestoreInput>>(params)?.bind(request)?;
            json!(service.restore(request, &input).await?)
        }
        "todo.create" | "todo.update" => {
            let (result, changes) = store.with_current(|binding, db| {
                capture_committed(binding, db, &request.request_id, || {
                    if method == "todo.create" {
                        let input = decode::<MutationInput<crate::agent::connection_todos::ConnectionTodoCreateInput>>(params)?.bind(request)?;
                        db.agent_connection_todo_create(request, binding, &input)
                    } else {
                        let input = decode::<MutationInput<crate::agent::connection_todos::ConnectionTodoUpdateInput>>(params)?.bind(request)?;
                        db.agent_connection_todo_update(request, binding, &input)
                    }
                })
            })?;
            if let Some(changes) = changes { store.publish_committed(changes); }
            json!(result?)
        }
        "operation.get" => {
            let input: OperationGetInput = decode(params)?;
            return store.with_current(|binding, db| {
                Ok(json!(db.agent_connection_operation_get(request, binding, &input.operation_id)?))
            });
        }
        "operation.list" => {
            let input = decode(params)?;
            return store.with_current(|binding, db| {
                Ok(json!(db.agent_connection_operation_list(request, binding, &input)?))
            });
        }
        "operation.undo" => {
            let input = decode::<MutationInput<OperationUndoInput>>(params)?.bind(request)?;
            json!(crate::agent::output_service::undo(store, worker, request, &input).await?)
        }
        "operation.restore_created" => {
            let input = decode::<MutationInput<crate::db::agent_record_withdrawals::RecordRestoreInput>>(params)?.bind(request)?;
            json!(crate::agent::output_service::restore(store, request, &input)?)
        }
        _ => return Err(AgentError::new(ErrorCode::ToolCallUnsupported, "Unknown Record operation")),
    };
    mutation_result(store, request, result)
}

pub(super) fn mutation_result<S: BoundRecordStore>(store: &S, request: &RequestContext, result: Value) -> AgentResult<Value> {
    let operation = store.with_current(|binding, db| {
        // Recovery may return the already committed inverse operation even
        // when requested again with a fresh request ID.
        if let Some(id) = result.get("operationId").and_then(Value::as_str) {
            db.agent_operation_get(request, binding, id)
        } else {
            db.agent_connection_operation_for_request(request, binding)
        }
    })?;
    Ok(json!({"result":result,"operation":operation}))
}
