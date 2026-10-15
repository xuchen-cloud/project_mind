//! Current Record body reads reuse the source service's bounded pages.
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef},
    },
    record_document_service::DocumentUtility,
    source_service::{
        BoundSourceStore, SourceReadInput, SourceReadPage, SourceReadTarget, SourceReadView,
        SourceService,
    },
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordGetInput {
    pub record: ObjectRef,
    #[schemars(length(max = 128))]
    pub revision: Option<String>,
    #[schemars(length(max = 2048))]
    pub cursor: Option<String>,
    #[schemars(range(min = 1, max = 12000))]
    pub budget_chars: Option<usize>,
}

pub(crate) async fn get<S: BoundSourceStore, W: DocumentUtility>(
    store: &S,
    request: &RequestContext,
    input: &RecordGetInput,
    utility: &W,
) -> AgentResult<SourceReadPage> {
    if input.record.kind != ObjectKind::Record {
        return Err(AgentError::new(ErrorCode::InvalidArgument, "Expected a Record target"));
    }
    SourceService::new(store).read_record(request, &SourceReadInput {
        source: SourceReadTarget {
            object: input.record.clone(),
            revision: input.revision.clone(),
            record_version: None,
            file_version: None,
        },
        view: SourceReadView::Full,
        selection: None,
        cursor: input.cursor.clone(),
        budget_chars: input.budget_chars,
    }, utility).await
}
