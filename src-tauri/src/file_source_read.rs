//! Exact UTF-8 source pages from an explicit, registered native File version.
//! No worker, extraction, HTML sanitization or newline/BOM normalization.
use crate::{
    agent::{
        access::{Caller, RequestContext},
        context::serialized_chars,
        errors::{AgentError, AgentResult, ErrorCode},
        file_tools::FileSourceReadInput,
        models::ObjectRef,
    },
    source_file_snapshot::{capture_file_scoped, verify_file, FileReadPlan},
    source_service::{BoundSourceStore, SourceReadTarget},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileSourcePage {
    pub object: ObjectRef,
    pub version_number: u32,
    pub content_hash: String,
    pub title: String,
    pub format: &'static str,
    pub byte_length: usize,
    pub text: String,
    pub start_char: usize,
    pub end_char: usize,
    pub total_chars: usize,
    pub next_cursor: Option<String>,
    pub complete: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    object_key: String,
    version_number: u32,
    content_hash: String,
    offset: usize,
}
fn invalid() -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, "Invalid fixed File source page")
}
fn changed() -> AgentError {
    AgentError::new(
        ErrorCode::SourceChanged,
        "File source version or policy changed during reading",
    )
}
fn budget() -> AgentError {
    AgentError::new(
        ErrorCode::BudgetExceeded,
        "File source metadata exceeds the requested page budget",
    )
}
pub(crate) struct FileSourceReadService<'a, S> {
    store: &'a S,
}
impl<'a, S: BoundSourceStore> FileSourceReadService<'a, S> {
    pub(crate) fn new(store: &'a S) -> Self {
        Self { store }
    }
    pub(crate) async fn read(
        &self,
        request: &RequestContext,
        input: &FileSourceReadInput,
    ) -> AgentResult<FileSourcePage> {
        let limit = input.budget_chars.unwrap_or(4000);
        if input.version_number == 0
            || limit == 0
            || limit > 24000
            || input
                .cursor
                .as_ref()
                .is_some_and(|cursor| cursor.len() > 2048)
        {
            return Err(invalid());
        }
        let source = SourceReadTarget {
            object: input.object.clone(),
            revision: input.expected_content_hash.clone(),
            record_version: None,
            file_version: Some(input.version_number),
        };
        let (plan, scope) = self.store.with_current(|binding, db| {
            let plan = if matches!(request.caller, Caller::Gui) {
                db.source_file_history_plan(request, binding, &source)?
            } else {
                db.source_file_plan(request, binding, &source)?
            };
            Ok((plan, crate::source_file_snapshot::file_read_scope(binding)?))
        })?;
        let format = match std::path::Path::new(&plan.title)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "md" => "markdown",
            "txt" => "text",
            "html" | "htm" => "html",
            _ => {
                return Err(AgentError::new(
                    ErrorCode::SourceNotReady,
                    "Raw source reads support only UTF-8 md/txt/html/htm Files",
                ))
            }
        };
        let key = plan.object.key()?;
        let start = match &input.cursor {
            None => 0,
            Some(value) => {
                let cursor: Cursor =
                    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(value).map_err(|_| invalid())?)
                        .map_err(|_| invalid())?;
                if cursor.object_key != key
                    || cursor.version_number != plan.file_version
                    || cursor.content_hash != plan.registered_hash
                {
                    return Err(changed());
                }
                cursor.offset
            }
        };
        // The existing capture kernel enforces its tested 10 MiB text-file
        // bound, full registered hash, regular-file identity and change stamps.
        let snapshot = capture_file_scoped(&scope, &plan).await?;
        self.recheck(request, &source, &plan)?;
        let (text, total, start_byte) = snapshot.text_position(start)?;
        let boundaries: Vec<usize> = std::iter::once(start_byte)
            .chain(
                text[start_byte..]
                    .char_indices()
                    .take(limit)
                    .map(|(offset, ch)| start_byte + offset + ch.len_utf8()),
            )
            .collect();
        let page = |count: usize| -> AgentResult<FileSourcePage> {
            let end = start + count;
            let next = if end < total {
                Some(
                    URL_SAFE_NO_PAD.encode(
                        serde_json::to_vec(&Cursor {
                            object_key: key.clone(),
                            version_number: plan.file_version,
                            content_hash: plan.registered_hash.clone(),
                            offset: end,
                        })
                        .map_err(|_| invalid())?,
                    ),
                )
            } else {
                None
            };
            Ok(FileSourcePage {
                object: plan.object.clone(),
                version_number: plan.file_version,
                content_hash: plan.registered_hash.clone(),
                title: plan.title.clone(),
                format,
                byte_length: snapshot.bytes.len(),
                text: text[start_byte..boundaries[count]].into(),
                start_char: start,
                end_char: end,
                total_chars: total,
                complete: end == total,
                next_cursor: next,
            })
        };
        let mut low = 0;
        let mut high = boundaries.len() - 1;
        if serialized_chars(&page(high)?)? <= limit {
            low = high;
        }
        while low < high {
            let count = (low + high + 1) / 2;
            if serialized_chars(&page(count)?)? <= limit {
                low = count;
            } else {
                high = count - 1;
            }
        }
        let result = page(low)?;
        if serialized_chars(&result)? > limit || (low == 0 && start < total) {
            return Err(budget());
        }
        verify_file(&plan, &snapshot).await?;
        self.recheck(request, &source, &plan)?;
        Ok(result)
    }
    fn plan(
        &self,
        request: &RequestContext,
        source: &SourceReadTarget,
    ) -> AgentResult<FileReadPlan> {
        self.store.with_current(|binding, db| {
            if matches!(request.caller, Caller::Gui) {
                db.source_file_history_plan(request, binding, source)
            } else {
                db.source_file_plan(request, binding, source)
            }
        })
    }
    fn recheck(
        &self,
        request: &RequestContext,
        source: &SourceReadTarget,
        plan: &FileReadPlan,
    ) -> AgentResult<()> {
        if self.plan(request, source)? != *plan {
            return Err(changed());
        }
        Ok(())
    }
}
