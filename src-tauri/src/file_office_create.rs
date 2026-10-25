//! GenOffice creates candidate bytes; the native File importer owns identity,
//! creation receipts and recovery. A retry is keyed by the original HTML, not
//! timestamps or other incidental bytes produced by a second generation.
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::SourceRef,
    },
    db::file_imports::{
        agent_file_generated_payload, validate_agent_file_binary_name, AgentFileCreateInput,
        AgentFileCreateResult,
    },
    file_office::{FileOfficeInput, FileOfficeService},
    file_version_service::BoundFileCommitStore,
    office_worker::{OfficePayload, OfficeUtility},
    source_service::BoundSourceStore,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

pub(crate) async fn create<S: BoundSourceStore + BoundFileCommitStore, W: OfficeUtility>(
    store: &S,
    worker: &W,
    request: &RequestContext,
    project_id: Option<i64>,
    name: &str,
    content: &str,
) -> AgentResult<Value> {
    validate_agent_file_binary_name(project_id, name)?;
    if !std::path::Path::new(name)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("docx"))
        || content.trim().is_empty()
    {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Office creation requires a DOCX name and restricted HTML content",
        ));
    }
    if content.len() > 2 * 1024 * 1024 {
        return Err(AgentError::new(
            ErrorCode::BudgetExceeded,
            "Office creation content exceeds 2 MiB",
        ));
    }
    let input = AgentFileCreateInput {
        project_id,
        safe_name: name.into(),
        utf8_content: String::new(),
    };
    let payload = agent_file_generated_payload(project_id, name, content);
    let previous: Option<AgentFileCreateResult> = store.with_current(|binding, db| {
        db.agent_file_create_authorize(request, binding, &input)?;
        db.agent_operation_replay(
            &request.caller.key(),
            &request.request_id,
            "file.create",
            &payload,
        )
    })?;
    let committed = if let Some(result) = previous {
        result
    } else {
        let candidate = worker
            .request(
                &request.request_id,
                "office.create",
                "docx",
                "",
                OfficePayload::Create(content),
            )
            .await?;
        let encoded = candidate["base64"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                AgentError::new(
                    ErrorCode::RuntimeIncompatible,
                    "Office creation returned no candidate bytes",
                )
            })?;
        if encoded.len() > (crate::file_content::MAX_CONTENT as usize).div_ceil(3) * 4 {
            return Err(AgentError::new(
                ErrorCode::BudgetExceeded,
                "Office candidate exceeds 100 MiB",
            ));
        }
        let bytes = STANDARD.decode(encoded).map_err(|_| {
            AgentError::new(
                ErrorCode::RuntimeIncompatible,
                "Invalid Office candidate encoding",
            )
        })?;
        if bytes.is_empty() || STANDARD.encode(&bytes) != encoded {
            return Err(AgentError::new(
                ErrorCode::RuntimeIncompatible,
                "Office candidate is incomplete",
            ));
        }
        let host = store.gui_commit_host(&request.binding)?;
        let mut db = host.database()?;
        let before = db.committed_change_watermark()?;
        let result = db.agent_file_create_generated_bound(
            request,
            host.binding(),
            project_id,
            name,
            content,
            &bytes,
            host.fence(),
        );
        let changes = db
            .committed_changes_since(host.binding(), &request.request_id, before)
            .unwrap_or_else(|error| {
                eprintln!(
                    "Office create notification capture pending: {}",
                    error.message
                );
                None
            });
        drop(db);
        if let Some(changes) = changes {
            store.publish_committed(changes);
        }
        result?
    };
    // Read the committed fixed version. The generator's preview alone cannot
    // prove that the requested material was persisted.
    let inspected = FileOfficeService::new(store, worker)
        .inspect(
            request,
            &FileOfficeInput {
                object: committed.object.clone(),
                version_number: committed.version_number,
                expected_content_hash: committed.content_hash.clone(),
            },
        )
        .await?;
    let source = SourceRef {
        object: committed.object.clone(),
        revision: committed.content_hash.clone(),
        file_version: Some(committed.version_number),
        record_version: None,
        block_id: None,
        locator: None,
        title: name.into(),
        excerpt: String::new(),
    };
    Ok(json!({"saved":true,"sourceRef":source,"commit":committed,"model":inspected.model}))
}
