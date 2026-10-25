//! External File operations reuse the native upload, version and journal paths.
use super::record_writes::{mutation_result, MutationInput};
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
    },
    file_content::AgentFileCreateRequest,
    file_content::{FileContentService, FileContentUpdate, SystemFileContentClock},
    file_text_patch::FileTextPatch,
    file_version_restore::FileVersionRestore,
    file_version_service::{BoundFileCommitStore, FileVersionService, FilesystemFileReader},
    record_document_service::{BoundRecordStore, DocumentUtility},
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

fn decode<T: DeserializeOwned>(value: Value) -> AgentResult<T> {
    serde_json::from_value(value).map_err(|_| {
        AgentError::new(
            ErrorCode::InvalidArgument,
            "Arguments do not match the method input DTO",
        )
    })
}

pub(crate) async fn execute<S: BoundRecordStore + BoundFileCommitStore, W: DocumentUtility>(
    store: &S,
    worker: &W,
    request: &RequestContext,
    method: &str,
    params: Value,
) -> AgentResult<Value> {
    super::registry::validate(method, &params)?;
    if method.starts_with("file.content.") {
        let input = if method == "file.content.status" {
            params
        } else {
            decode::<MutationInput<Value>>(params)?.bind(request)?
        };
        return crate::agent::output_tools::dispatch_output(store, worker, request, method, input)
            .await;
    }
    let versions = FileVersionService::new(store, &FilesystemFileReader);
    let result = match method {
        "file.create" => {
            let input = decode::<MutationInput<AgentFileCreateRequest>>(params)?.bind(request)?;
            if let AgentFileCreateRequest::Staged(input) = &input {
                let result = FileContentService::new(store, &SystemFileContentClock)
                    .create(request, input)?;
                return mutation_result(store, request, json!(result));
            }
            let AgentFileCreateRequest::Text(input) = input else {
                unreachable!()
            };
            let host = store.gui_commit_host(&request.binding)?;
            let mut db = host.database()?;
            let before = db.committed_change_watermark()?;
            let result = db.agent_file_create_bound(request, host.binding(), &input, host.fence());
            // Publish only durable changes after releasing the runtime DB and
            // native file leases, including a commit with later cleanup failure.
            let changes = db
                .committed_changes_since(host.binding(), &request.request_id, before)
                .unwrap_or_else(|error| {
                    eprintln!(
                        "File creation notification capture pending: {}",
                        error.message
                    );
                    None
                });
            drop(db);
            if let Some(changes) = changes {
                store.publish_committed(changes);
            }
            json!(result?)
        }
        "file.patch" => {
            let input = decode::<MutationInput<FileTextPatch>>(params)?.bind(request)?;
            json!({"receipt":versions.patch_text(request, &input)?.receipt})
        }
        "file.version.restore" => {
            let input = decode::<MutationInput<FileVersionRestore>>(params)?.bind(request)?;
            json!({"receipt":versions.restore_version(request, &input)?.receipt})
        }
        "file.update" => {
            let input = decode::<MutationInput<FileContentUpdate>>(params)?.bind(request)?;
            json!({"receipt":FileContentService::new(store, &SystemFileContentClock).update(request, &input)?.receipt})
        }
        _ => {
            return Err(AgentError::new(
                ErrorCode::ToolCallUnsupported,
                "Unknown File operation",
            ))
        }
    };
    mutation_result(store, request, result)
}
