//! GUI File working content is durable independently of immutable File Versions.
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::ObjectRef,
    },
    file_version_service::BoundFileCommitStore,
    source_service::BoundSourceStore,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub(crate) const IDLE_MS: i64 = 15 * 60 * 1000;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkingObject {
    pub object: ObjectRef,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkingSession {
    pub object: ObjectRef,
    pub session_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkingSaveText {
    pub object: ObjectRef,
    pub session_id: String,
    pub expected_revision: i64,
    pub expected_content_hash: String,
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkingSaveOffice {
    pub object: ObjectRef,
    pub session_id: String,
    pub expected_revision: i64,
    pub expected_content_hash: String,
    pub edits: Vec<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkingStatus {
    pub object: ObjectRef,
    pub revision: i64,
    pub content_hash: String,
    pub archived_version_number: i64,
    pub pending_archive: bool,
    pub last_activity_at_ms: Option<i64>,
    pub archive_due_at_ms: Option<i64>,
    pub no_change: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkingOpened {
    #[serde(flatten)]
    pub status: WorkingStatus,
    pub session_id: String,
    pub name: String,
    pub base64: String,
    pub format: Option<String>,
    pub model: Option<Value>,
}
pub(crate) fn error(code: ErrorCode, message: &str) -> AgentError {
    AgentError::new(code, message)
}

pub(crate) fn with_db<S: BoundSourceStore + BoundFileCommitStore, T>(
    store: &S,
    request: &RequestContext,
    action: impl FnOnce(&crate::db::Database) -> AgentResult<T>,
) -> AgentResult<T> {
    store.with_current(|binding, _| {
        crate::file_version_service::validate_binding(&request.binding, binding)
    })?;
    let host = store.gui_commit_host(&request.binding)?;
    drop(host.fence().enter()?);
    let db = host.database()?;
    let (result, changes) = {
        crate::committed_changes::capture_committed(
            host.binding(),
            &db,
            &request.request_id,
            || action(&db),
        )?
    };
    if let Some(changes) = changes {
        store.publish_committed(changes);
    }
    result
}
pub(crate) async fn open<
    S: BoundSourceStore + BoundFileCommitStore,
    W: crate::office_worker::OfficeUtility,
>(
    store: &S,
    worker: &W,
    request: &RequestContext,
    input: &WorkingObject,
) -> AgentResult<WorkingOpened> {
    let mut opened = with_db(store, request, |db| {
        db.file_working_begin_session(request, &request.binding, &input.object)
    })?;
    let extension = std::path::Path::new(&opened.name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "docx" | "xlsx" | "pptx") {
        let session = WorkingSession {
            object: input.object.clone(),
            session_id: opened.session_id.clone(),
        };
        let _admission = match crate::office_worker::admit_source().await {
            Ok(admission) => admission,
            Err(error) => {
                crate::office_worker::close_view(&request.binding, &opened.session_id);
                let _ = with_db(store, request, |db| {
                    db.file_working_close(request, &request.binding, &session)
                });
                return Err(error);
            }
        };
        let context = with_db(store, request, |db| {
            let (name, hash, length) =
                db.file_working_view_metadata(request, &request.binding, &session)?;
            if name != opened.name || hash != opened.status.content_hash {
                return Err(error(
                    ErrorCode::SourceChanged,
                    "Office initial baseline changed",
                ));
            }
            crate::office_worker::view_baseline_context(
                &request.binding,
                &crate::db::project_directory_files::FileBytesInput {
                    object: input.object.clone(),
                    version_number: 0,
                    expected_content_hash: hash,
                },
                length,
                &opened.session_id,
            )
        });
        let result = match context {
            Ok(context) => {
                worker
                    .view(
                        &context,
                        &request.request_id,
                        &extension,
                        &opened.base64,
                        None,
                    )
                    .await
            }
            Err(error) => Err(error),
        };
        let check = with_db(store, request, |db| {
            db.file_working_verify_open(
                request,
                &request.binding,
                &session,
                opened.status.revision,
                &opened.status.content_hash,
            )
        });
        match result.and_then(|result| {
            check?;
            result
                .get("model")
                .cloned()
                .ok_or_else(|| error(ErrorCode::RuntimeIncompatible, "Office model is missing"))
        }) {
            Ok(model) => {
                opened.model = Some(model);
                opened.format = Some(extension);
                // Office models carry their editor source; keep the private
                // fixed base native rather than sending a second full package.
                opened.base64.clear();
            }
            Err(error) => {
                crate::office_worker::close_view(&request.binding, &opened.session_id);
                let _ = with_db(store, request, |db| {
                    db.file_working_close(request, &request.binding, &session)
                });
                return Err(error);
            }
        }
    }
    Ok(opened)
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkingReadView {
    pub object: ObjectRef,
    pub session_id: String,
    pub read: crate::office_view::OfficeViewRead,
}
pub(crate) async fn read_view<
    S: BoundSourceStore + BoundFileCommitStore,
    W: crate::office_worker::OfficeUtility,
>(
    store: &S,
    worker: &W,
    request: &RequestContext,
    input: &WorkingReadView,
) -> AgentResult<Value> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    input.read.validate()?;
    let _admission = crate::office_worker::admit_source().await?;
    let session = WorkingSession {
        object: input.object.clone(),
        session_id: input.session_id.clone(),
    };
    let (metadata, context) = with_db(store, request, |db| {
        let metadata = db.file_working_view_metadata(request, &request.binding, &session)?;
        if !std::path::Path::new(&metadata.0)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("xlsx"))
        {
            return Err(error(
                ErrorCode::InvalidArgument,
                "Range reads require XLSX",
            ));
        }
        let context = crate::office_worker::view_baseline_context(
            &request.binding,
            &crate::db::project_directory_files::FileBytesInput {
                object: input.object.clone(),
                version_number: 0,
                expected_content_hash: metadata.1.clone(),
            },
            metadata.2,
            &input.session_id,
        )?;
        Ok((metadata, context))
    })?;
    let mut result = worker
        .view(&context, &request.request_id, "xlsx", "", Some(&input.read))
        .await;
    if result.as_ref().is_err_and(|error| {
        error.code == ErrorCode::SourceNotReady
            && error.message == "Office view baseline needs source bytes"
    }) {
        let (_, bytes) = with_db(store, request, |db| {
            db.file_working_session_base(request, &request.binding, &session)
        })?;
        result = worker
            .view(
                &context,
                &request.request_id,
                "xlsx",
                &STANDARD.encode(bytes),
                Some(&input.read),
            )
            .await;
    }
    let after = with_db(store, request, |db| {
        db.file_working_view_metadata(request, &request.binding, &session)
    })?;
    if after != metadata {
        return Err(error(
            ErrorCode::SourceChanged,
            "Office view baseline changed during read",
        ));
    }
    result?.get("result").cloned().ok_or_else(|| {
        error(
            ErrorCode::RuntimeIncompatible,
            "Office range result is missing",
        )
    })
}

pub(crate) fn close<S: BoundSourceStore + BoundFileCommitStore>(
    store: &S,
    request: &RequestContext,
    input: &WorkingSession,
) -> AgentResult<()> {
    with_db(store, request, |db| {
        db.file_working_close(request, &request.binding, input)?;
        crate::office_worker::close_view(&request.binding, &input.session_id);
        Ok(())
    })
}
pub(crate) fn save_text<S: BoundSourceStore + BoundFileCommitStore>(
    store: &S,
    request: &RequestContext,
    input: &WorkingSaveText,
) -> AgentResult<WorkingStatus> {
    if let Some(saved) = with_db(store, request, |db| {
        db.file_working_save_replay(request, &request.binding, &input.object, input)
    })? {
        return Ok(saved);
    }
    let session = WorkingSession {
        object: input.object.clone(),
        session_id: input.session_id.clone(),
    };
    with_db(store, request, |db| {
        let (name, base) = db.file_working_session_base(request, &request.binding, &session)?;
        if !std::path::Path::new(&name)
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| matches!(s.to_ascii_lowercase().as_str(), "md" | "markdown" | "mdown"))
        {
            return Err(error(
                ErrorCode::InvalidArgument,
                "Text editing requires a Markdown File",
            ));
        }
        std::str::from_utf8(&base)
            .map_err(|_| error(ErrorCode::InvalidArgument, "Markdown requires UTF-8 source"))?;
        if input.text.len() > 10 * 1024 * 1024 {
            return Err(error(
                ErrorCode::BudgetExceeded,
                "Markdown exceeds the 10 MiB editor limit",
            ));
        }
        db.file_working_save(
            request,
            &request.binding,
            &session,
            input.expected_revision,
            &input.expected_content_hash,
            input,
            input.text.as_bytes(),
            chrono::Utc::now().timestamp_millis(),
        )
    })
}
pub(crate) async fn save_office<
    S: BoundSourceStore + BoundFileCommitStore,
    W: crate::office_worker::OfficeUtility,
>(
    store: &S,
    worker: &W,
    request: &RequestContext,
    input: &WorkingSaveOffice,
) -> AgentResult<WorkingStatus> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    if let Some(saved) = with_db(store, request, |db| {
        db.file_working_save_replay(request, &request.binding, &input.object, input)
    })? {
        return Ok(saved);
    }
    let _admission = crate::office_worker::admit_source().await?;
    let session = WorkingSession {
        object: input.object.clone(),
        session_id: input.session_id.clone(),
    };
    let (name, base) = with_db(store, request, |db| {
        db.file_working_session_base(request, &request.binding, &session)
    })?;
    let format = std::path::Path::new(&name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(format.as_str(), "docx" | "xlsx" | "pptx") {
        return Err(error(
            ErrorCode::InvalidArgument,
            "Office supports DOCX/XLSX/PPTX only",
        ));
    }
    // The model and cumulative journal always refer to the fixed session base.
    // Working CAS advances independently, so no editor reload is needed.
    let result = worker
        .request(
            &request.request_id,
            "office.edit",
            &format,
            &STANDARD.encode(base),
            crate::office_worker::OfficePayload::Edit(&input.edits),
        )
        .await?;
    let encoded = result
        .get("base64")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            error(
                ErrorCode::RuntimeIncompatible,
                "Office replacement bytes are missing",
            )
        })?;
    if encoded.len() > (crate::file_content::MAX_CONTENT as usize).div_ceil(3) * 4 {
        return Err(error(
            ErrorCode::BudgetExceeded,
            "Office replacement exceeds 100 MiB",
        ));
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| {
        error(
            ErrorCode::RuntimeIncompatible,
            "Office replacement base64 is invalid",
        )
    })?;
    with_db(store, request, |db| {
        db.file_working_save(
            request,
            &request.binding,
            &session,
            input.expected_revision,
            &input.expected_content_hash,
            input,
            &bytes,
            chrono::Utc::now().timestamp_millis(),
        )
    })
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkingRecalculate {
    pub object: ObjectRef,
    pub session_id: String,
    pub recalculation: crate::office_worker::OfficeRecalculation,
}
pub(crate) async fn recalculate<
    S: BoundSourceStore + BoundFileCommitStore,
    W: crate::office_worker::OfficeUtility,
>(
    store: &S,
    worker: &W,
    request: &RequestContext,
    input: &WorkingRecalculate,
) -> AgentResult<crate::office_worker::OfficeRecalculationResult> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    input.recalculation.validate()?;
    let _admission = crate::office_worker::admit_source().await?;
    let session = WorkingSession {
        object: input.object.clone(),
        session_id: input.session_id.clone(),
    };
    let (name, base) = with_db(store, request, |db| {
        db.file_working_session_base(request, &request.binding, &session)
    })?;
    if !std::path::Path::new(&name)
        .extension()
        .is_some_and(|s| s.eq_ignore_ascii_case("xlsx"))
    {
        return Err(error(
            ErrorCode::InvalidArgument,
            "Recalculation requires XLSX",
        ));
    }
    let result = worker
        .request(
            &request.request_id,
            "office.recalculate",
            "xlsx",
            &STANDARD.encode(base),
            crate::office_worker::OfficePayload::Recalculate(&input.recalculation),
        )
        .await;
    with_db(store, request, |db| {
        db.file_working_session_base(request, &request.binding, &session)
    })?;
    let result: crate::office_worker::OfficeRecalculationResult = serde_json::from_value(result?)
        .map_err(|_| {
        error(
            ErrorCode::RuntimeIncompatible,
            "Invalid Office recalculation result",
        )
    })?;
    if result.cells.len() > 100_000
        || result.cells.iter().any(|c| {
            c.sheet_id.is_empty()
                || c.row > 1_048_575
                || c.column > 16_383
                || c.number.is_some_and(|n| !n.is_finite())
        })
    {
        return Err(error(
            ErrorCode::RuntimeIncompatible,
            "Invalid Office recalculation cells",
        ));
    }
    Ok(result)
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkingRecovery {
    pub object: ObjectRef,
    pub revision: i64,
    pub content_hash: String,
    pub name: String,
    pub base64: String,
}
