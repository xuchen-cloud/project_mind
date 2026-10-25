//! Object reads available to a connected client. The existing services own
//! authorization, ownership, version checks and response budgets.
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        file_tools::{FileSourceReadInput, FileVersionsGetInput, FileVersionsListInput},
        record_get::{self, RecordGetInput},
        references::ReferenceListInput,
        record_blocks::{RecordBlocksInput, RecordBlocksService},
        todo_tools::{TodoGetInput, TodoListInput},
    },
    file_source_read::FileSourceReadService,
    record_document_service::DocumentUtility,
    record_version_reads::{
        RecordVersionReadService, RecordVersionsCompareInput, RecordVersionsGetInput,
        RecordVersionsListInput,
    },
    source_service::BoundSourceStore,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

fn decode<T: DeserializeOwned>(arguments: Value) -> AgentResult<T> {
    serde_json::from_value(arguments).map_err(|_| {
        AgentError::new(
            ErrorCode::InvalidArgument,
            "Arguments do not match the object read input",
        )
    })
}

fn encode(result: impl Serialize) -> AgentResult<Value> {
    serde_json::to_value(result).map_err(|_| {
        AgentError::new(
            ErrorCode::RuntimeIncompatible,
            "Cannot serialize object read result",
        )
    })
}

pub(crate) async fn execute<S: BoundSourceStore, W: DocumentUtility, F: crate::source_service::SourceUtility>(
    store: &S,
    request: &RequestContext,
    method: &str,
    arguments: Value,
    utility: &W,
    source_utility: &F,
) -> AgentResult<Value> {
    match method {
        "file.list" => {
            let input: crate::agent::record_list::RecordListInput = decode(arguments)?;
            crate::agent::file_list::list(store, request, &input, source_utility).await
        }
        "record.list" => {
            let input: crate::agent::record_list::RecordListInput = decode(arguments)?;
            store.with_current(|binding, db| encode(db.agent_record_list(request, binding, &input)?))
        }
        "todo.list" => {
            let input: TodoListInput = decode(arguments)?;
            store.with_current(|binding, db| {
                encode(db.agent_todo_list(request, binding, &input)?)
            })
        }
        "reference.list" => {
            let input: ReferenceListInput = decode(arguments)?;
            store.with_current(|binding, db| {
                encode(db.agent_reference_list(request, binding, &input)?)
            })
        }
        "record.get" => {
            let input: RecordGetInput = decode(arguments)?;
            encode(record_get::get(store, request, &input, utility).await?)
        }
        "record.versions.list" => {
            let input: RecordVersionsListInput = decode(arguments)?;
            encode(RecordVersionReadService::new(store, utility).list(request, &input)?)
        }
        "record.versions.get" => {
            let input: RecordVersionsGetInput = decode(arguments)?;
            encode(RecordVersionReadService::new(store, utility).get(request, &input)?)
        }
        "record.versions.compare" => {
            let input: RecordVersionsCompareInput = decode(arguments)?;
            encode(
                RecordVersionReadService::new(store, utility)
                    .compare(request, &input)
                    .await?,
            )
        }
        "record.blocks.get" => {
            let input: RecordBlocksInput = decode(arguments)?;
            encode(RecordBlocksService::new(store).get(request, &input)?)
        }
        "todo.get" => {
            let input: TodoGetInput = decode(arguments)?;
            store.with_current(|binding, db| {
                encode(db.agent_todo_get(request, binding, &input.target)?)
            })
        }
        "file.versions.list" => {
            let input: FileVersionsListInput = decode(arguments)?;
            store.with_current(|binding, db| {
                encode(db.file_read_versions_list(request, binding, &input)?)
            })
        }
        "file.versions.get" => {
            let input: FileVersionsGetInput = decode(arguments)?;
            store.with_current(|binding, db| {
                encode(db.file_read_version_get(request, binding, &input)?)
            })
        }
        "file.bytes.read" => {
            let input: crate::db::project_directory_files::FileBytesInput = decode(arguments)?;
            store.with_current(|binding, db| encode(db.project_file_read_office_source(request, binding, &input)?.0))
        }
        "file.source.read" => {
            let input: FileSourceReadInput = decode(arguments)?;
            encode(
                FileSourceReadService::new(store)
                    .read(request, &input)
                    .await?,
            )
        }
        _ => Err(AgentError::new(
            ErrorCode::ToolCallUnsupported,
            "Object read method is not registered",
        )),
    }
}
