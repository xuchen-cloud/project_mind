//! Thin connection adapter for native Record writes and connection receipts.
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::ObjectKind,
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
    fn bind(self, request: &RequestContext) -> AgentResult<T> {
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

pub(crate) async fn execute<S: BoundRecordStore, W: DocumentUtility>(
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
            store.with_current(|binding, db| {
                let entry = db.agent_operation_access(request, binding, &input.operation_id, "operation.undo")?;
                require_record(entry.object.kind)
            })?;
            json!(service.undo_operation(request, &input).await?)
        }
        "operation.restore_created" => {
            let input = decode::<MutationInput<crate::db::agent_record_withdrawals::RecordRestoreInput>>(params)?.bind(request)?;
            let (result, changes) = store.with_current(|binding, db| {
                let entry = db.agent_operation_access(request, binding, &input.creation_operation_id, "operation.restore_created")?;
                require_record(entry.object.kind)?;
                db.source_read_historical_record(request, binding, &entry.object)?;
                capture_committed(binding, db, &request.request_id, || {
                    db.agent_record_creation_restore(request, binding, &input)
                })
            })?;
            if let Some(changes) = changes { store.publish_committed(changes); }
            json!(result?)
        }
        _ => return Err(AgentError::new(ErrorCode::ToolCallUnsupported, "Unknown Record operation")),
    };
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

fn require_record(kind: ObjectKind) -> AgentResult<()> {
    if kind != ObjectKind::Record {
        return Err(AgentError::new(ErrorCode::ToolCallUnsupported, "This connection adapter currently recovers Records only"));
    }
    Ok(())
}
