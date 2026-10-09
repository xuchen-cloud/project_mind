//! Thin model/transport read boundary. The Host supplies RequestContext; JSON
//! arguments never construct a caller, binding or grant. Services own source
//! ownership, exclusion, revision checks and response pagination.
use super::{
    access::{Caller, RequestContext},
    context::ContextGetInput,
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, WorkspaceBinding},
    service::AgentDomainService,
};
use crate::{
    db::Database,
    knowledge_service::{KnowledgeGetInput, KnowledgeSearchInput},
    overview_service::OverviewReadInput,
    record_document_service::DocumentUtility,
    source_service::{
        BoundSourceStore, SourceReadInput, SourceSearchInput, SourceService, SourceUtility,
    },
};
use serde::Serialize;
use serde_json::{json, Value};

/// Only L0 needs the Workspace's human-readable name. Keep it in the same
/// current-Workspace database phase, rather than inventing it from a UUID or
/// retaining a repository/database across asynchronous source extraction.
pub(crate) trait BoundReadContextStore: BoundSourceStore {
    fn with_current_context<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database, &str) -> AgentResult<T>,
    ) -> AgentResult<T>;
}
impl BoundReadContextStore for crate::AppState {
    fn with_current_context<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database, &str) -> AgentResult<T>,
    ) -> AgentResult<T> {
        let current = crate::lock_mutex(&self.current_workspace);
        let runtime = current.as_ref().ok_or_else(|| {
            AgentError::new(ErrorCode::WorkspaceNotOpen, "Open a Workspace first")
        })?;
        let db = crate::lock_mutex(&runtime.db);
        action(&runtime.agent_binding, &db, &runtime.summary.display_name)
    }
}

/// Callable shared dispatcher. A scope in JSON is a selector within the Host's
/// grant, never a grant itself. Each service verifies the current binding and
/// resolves object ownership from storage before returning content.
pub(crate) async fn dispatch_read<S, R, F>(
    store: &S,
    record_utility: &R,
    source_utility: &F,
    request: &RequestContext,
    method: &str,
    arguments: Value,
) -> AgentResult<Value>
where
    S: BoundReadContextStore,
    R: DocumentUtility,
    F: SourceUtility,
{
    validate_bounds(method, &arguments)?;
    match method {
        "context.get" => {
            let input: ContextGetInput = decode(arguments)?;
            store.with_current_context(|binding, db, workspace_name| {
                let repository =
                    crate::db::agent::WorkspaceContextRepository { db, workspace_name };
                let entry =
                    AgentDomainService::new(binding, &repository).context_get(request, input)?;
                if matches!(&request.caller, Caller::BuiltinRun { .. }) {
                    let observed = entry
                        .source_refs
                        .iter()
                        .map(|source| crate::db::agent_run_provenance::ObservedSource {
                            object: source.object.clone(),
                            revision: Some(source.revision.clone()),
                        })
                        .collect::<Vec<_>>();
                    let observed = super::source_trace::expand_sources(db, request, binding, observed)?;
                    db.agent_run_provenance_observe(request, binding, &observed)?;
                }
                encode(entry)
            })
        }
        "context.overview.get" => {
            let input: OverviewReadInput = decode(arguments)?;
            encode(
                crate::overview_service::OverviewService::new(store)
                    .get(request, &input)
                    .await?,
            )
        }
        "knowledge.search" => {
            let input: KnowledgeSearchInput = decode(arguments)?;
            encode(
                crate::knowledge_registry::KnowledgeRegistry::new(store).search(request, &input)?,
            )
        }
        "knowledge.get" => {
            let input: KnowledgeGetInput = decode(arguments)?;
            encode(
                crate::knowledge_registry::KnowledgeRegistry::new(store)
                    .get(request, &input)
                    .await?,
            )
        }
        "source.search" => {
            let input: SourceSearchInput = decode(arguments)?;
            encode(SourceService::new(store).search(request, &input).await?)
        }
        "source.read" => {
            let input: SourceReadInput = decode(arguments)?;
            let service = SourceService::new(store);
            let page = match input.source.object.kind {
                ObjectKind::Record => service.read_record(request, &input, record_utility).await?,
                ObjectKind::QuickNote => {
                    service
                        .read_quick_note(request, &input, record_utility)
                        .await?
                }
                ObjectKind::File => service.read_file(request, &input, source_utility).await?,
                ObjectKind::Project | ObjectKind::Todo | ObjectKind::Transcript => {
                    service.read_native(request, &input)?
                }
                ObjectKind::SessionSummary => crate::source_session_summary::read(store, request, &input)?,
                _ => {
                    return Err(AgentError::new(
                        ErrorCode::ToolCallUnsupported,
                        "This source kind has no shared reader",
                    ))
                }
            };
            encode(page)
        }
        _ => Err(AgentError::new(
            ErrorCode::ToolCallUnsupported,
            "Read method is not registered",
        )),
    }
}
fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> AgentResult<T> {
    serde_json::from_value(value).map_err(|_| invalid("Arguments do not match the read input DTO"))
}
fn encode(value: impl Serialize) -> AgentResult<Value> {
    serde_json::to_value(value).map_err(|_| {
        AgentError::new(
            ErrorCode::RuntimeIncompatible,
            "Cannot serialize read result",
        )
    })
}

// Bounds advertised to models are enforced at this boundary as well. Existing
// services retain their semantic validation and serialized response budgets.
fn validate_bounds(method: &str, arguments: &Value) -> AgentResult<()> {
    let (max_budget, max_query, max_cursor) = match method {
        "context.get" => (3000, 2000, 0),
        "context.overview.get" => (8000, 0, 2048),
        "knowledge.search" => (3000, 2000, 8192),
        "knowledge.get" => (8000, 0, 8192),
        "source.search" => (12000, 256, 0),
        "source.read" => (12000, 0, 2048),
        _ => {
            return Err(AgentError::new(
                ErrorCode::ToolCallUnsupported,
                "Read method is not registered",
            ))
        }
    };
    let fields = arguments
        .as_object()
        .ok_or_else(|| invalid("Read arguments must be an object"))?;
    for (key, max) in [
        ("budgetChars", max_budget),
        ("limit", 50),
        ("version", 9_007_199_254_740_991),
    ] {
        if let Some(value) = fields.get(key).filter(|value| !value.is_null()) {
            if !value
                .as_u64()
                .is_some_and(|value| value > 0 && value <= max)
            {
                return Err(invalid("Read numeric argument exceeds its declared bounds"));
            }
        }
    }
    for (key, max) in [
        ("query", max_query),
        ("cursor", max_cursor),
        ("nodeId", 128),
    ] {
        if let Some(value) = fields.get(key).filter(|value| !value.is_null()) {
            if !value
                .as_str()
                .is_some_and(|value| value.chars().count() <= max)
            {
                return Err(invalid("Read string argument exceeds its declared bounds"));
            }
        }
    }
    for (key, max) in [
        ("kinds", if method == "source.search" { 7 } else { 3 }),
        ("selected", 50),
        ("sections", 5),
        ("itemIds", 100),
        ("sectionIds", 20),
    ] {
        if let Some(value) = fields.get(key) {
            if !value.as_array().is_some_and(|value| value.len() <= max) {
                return Err(invalid("Read selection exceeds its declared bounds"));
            }
        }
    }
    for key in ["itemIds", "sectionIds"] {
        if let Some(values) = fields.get(key).and_then(Value::as_array) {
            if values
                .iter()
                .any(|value| !value.as_str().is_some_and(|id| id.chars().count() <= 128))
            {
                return Err(invalid("Read identifier exceeds its declared bounds"));
            }
        }
    }
    let mut scopes = vec![];
    if let Some(scope) = fields.get("scope") {
        scopes.push(scope);
    }
    if let Some(scope) = arguments.pointer("/source/object/scope") {
        scopes.push(scope);
    }
    if let Some(selected) = fields.get("selected").and_then(Value::as_array) {
        scopes.extend(selected.iter().filter_map(|object| object.get("scope")));
    }
    for scope in scopes {
        if let Some(project) = scope.get("projectId") {
            if !project
                .as_u64()
                .is_some_and(|id| id > 0 && id <= 9_007_199_254_740_991)
            {
                return Err(invalid(
                    "Project selector must be an exact positive JSON integer",
                ));
            }
        }
    }
    if let Some(revision) = arguments
        .pointer("/source/revision")
        .filter(|value| !value.is_null())
    {
        if !revision
            .as_str()
            .is_some_and(|value| value.chars().count() <= 128)
        {
            return Err(invalid("Source revision exceeds its declared bounds"));
        }
    }
    if let Some(locator) = arguments
        .pointer("/selection/locator")
        .filter(|value| !value.is_null())
    {
        // SourceLocator is also an output type and permits extra fields during
        // serde decoding. Enforce the model input schema at this one boundary.
        let locator = locator
            .as_object()
            .ok_or_else(|| invalid("Invalid source locator"))?;
        let allowed: &[&str] = match locator.get("kind").and_then(Value::as_str) {
            Some("paragraph") => &["kind", "start", "end"],
            Some("page") => &["kind", "page", "start", "end"],
            Some("time") => &["kind", "startMs", "endMs"],
            _ => return Err(invalid("This locator kind has no shared source reader")),
        };
        if locator.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err(invalid("Unknown source locator field"));
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadToolDescription {
    pub name: String,
    pub method: &'static str,
    pub description: &'static str,
    pub parameters: Value,
}
pub(super) fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
pub(super) fn nullable(schema: Value) -> Value {
    json!({"anyOf":[schema,{"type":"null"}]})
}
pub(super) fn text(max: usize) -> Value {
    json!({"type":"string","maxLength":max})
}
pub(super) fn integer(max: u64) -> Value {
    json!({"type":"integer","minimum":1,"maximum":max})
}
pub(super) fn array(items: Value, max: usize) -> Value {
    json!({"type":"array","items":items,"maxItems":max})
}
pub(super) fn scope_schema() -> Value {
    json!({"oneOf":[object(json!({"kind":{"type":"string","maxLength":9,"const":"workspace"}}), &["kind"]),object(json!({"kind":{"type":"string","maxLength":7,"const":"project"},"projectId":integer(9_007_199_254_740_991)}), &["kind","projectId"])]})
}
fn source_kinds() -> Value {
    json!({"type":"string","maxLength":32,"enum":["project","quick_note","record","todo","file","transcript","session_summary"]})
}
pub(super) fn object_ref_schema() -> Value {
    let identity =
        json!({"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"});
    object(
        json!({"workspaceId":identity,"scope":scope_schema(),"kind":source_kinds(),"id":identity}),
        &["workspaceId", "scope", "kind", "id"],
    )
}
pub(super) fn locator_schema() -> Value {
    let paragraph = object(
        json!({"kind":{"type":"string","maxLength":9,"const":"paragraph"},"start":integer(u32::MAX.into()),"end":integer(u32::MAX.into())}),
        &["kind", "start", "end"],
    );
    let page = object(
        json!({"kind":{"type":"string","maxLength":9,"const":"page"},"page":integer(u32::MAX.into()),"start":{"type":"integer","minimum":0,"maximum":u32::MAX},"end":integer(u32::MAX.into())}),
        &["kind", "page", "start", "end"],
    );
    let time_value = json!({"type":"integer","minimum":0,"maximum":9_007_199_254_740_991u64});
    let time = object(
        json!({"kind":{"type":"string","maxLength":9,"const":"time"},"startMs":time_value,"endMs":time_value}),
        &["kind", "startMs", "endMs"],
    );
    json!({"oneOf":[paragraph,page,time]})
}

/// Only callable shared read services appear here. Capability readiness and
/// transport registration remain the Host/adapter's responsibility.
pub(crate) fn read_tool_descriptions() -> Vec<ReadToolDescription> {
    let scope = scope_schema();
    let version = nullable(integer(9_007_199_254_740_991));
    let id = text(128);
    let sections = json!({"type":"string","maxLength":32,"enum":["profile","progress","knowledgeMap","actions","openQuestions"]});
    let knowledge_kinds =
        json!({"type":"string","maxLength":32,"enum":["topic","decision","source_summary"]});
    let mut result = vec![];
    let mut add = |name: &'static str, description, properties, required: &[&str]| {
        result.push(ReadToolDescription {
            name: format!("mind_{}", name.replace('.', "_")),
            method: name,
            description,
            parameters: object(properties, required),
        });
    };
    add("context.get", "Read bounded scope identity and knowledge navigation before opening source bodies. Scope must be within the Host grant.", json!({"scope":scope,"query":nullable(text(2000)),"budgetChars":nullable(integer(3000))}), &["scope"]);
    add("context.overview.get", "Read Overview directory by default; select sections or itemIds for bounded content, and reuse nextCursor for continuation.", json!({"scope":scope,"version":version,"sections":array(sections,5),"itemIds":array(id.clone(),100),"cursor":nullable(text(2048)),"budgetChars":nullable(integer(8000))}), &["scope"]);
    add("knowledge.search", "Search authorized knowledge cards. If sourceFallbackRequired is true, use source.search to find original evidence.", json!({"scope":scope,"query":text(2000),"kinds":array(knowledge_kinds,3),"cursor":nullable(text(8192)),"limit":nullable(integer(50)),"budgetChars":nullable(integer(3000))}), &["scope","query"]);
    add("knowledge.get", "Read a node: or overview: navigation ID. Default view is summary; use content and sectionIds for selective bounded reading.", json!({"scope":scope,"nodeId":id,"version":version,"view":{"type":"string","maxLength":32,"enum":["outline","summary","content"]},"sectionIds":array(text(128),20),"cursor":nullable(text(8192)),"budgetChars":nullable(integer(8000))}), &["scope","nodeId"]);
    add("source.search", "Search indexed original sources and session summary segments in a granted scope, optionally limited to selected objects. Results are rechecked against actual source ownership, policy and revisions.", json!({"scope":scope,"query":text(256),"kinds":array(source_kinds(),7),"selected":array(object_ref_schema(),50),"includeHistory":{"type":"boolean"},"limit":nullable(integer(50)),"budgetChars":nullable(integer(12000))}), &["scope","query"]);
    let target = object(
        json!({"object":object_ref_schema(),"revision":nullable(text(128)),"recordVersion":nullable(integer(u32::MAX.into())),"fileVersion":nullable(integer(u32::MAX.into()))}),
        &["object"],
    );
    let selection = object(
        json!({"blockId":nullable(json!({"type":"string","minLength":32,"maxLength":32,"pattern":"^[0-9a-f]{32}$"})),"locator":nullable(locator_schema())}),
        &[],
    );
    add("source.read", "Read original evidence with fixed-revision pagination. Full view omits selection; range view requires a blockId or source locator. Reuse sourceRef and nextCursor when continuing; source metadata may report unsupported or incomplete extraction.", json!({"source":target,"view":{"type":"string","maxLength":32,"enum":["full","range"]},"selection":nullable(selection),"cursor":nullable(text(2048)),"budgetChars":nullable(integer(12000))}), &["source","view"]);
    add("session.search", "Find authorized earlier user and assistant discussion in this scope. Results can be incomplete; use nextCursor for continuation and session.messages.read to verify original wording.", json!({"scope":scope,"query":text(256),"sessionId":nullable(text(32)),"afterMessageId":nullable(text(32)),"limit":integer(20),"budgetChars":integer(12000)}), &["scope","query"]);
    let history_cursor = object(
        json!({"branchId":text(128),"fromMessageId":nullable(text(32)),"toMessageId":nullable(text(32)),"messageId":text(32),"charOffset":{"type":"integer","minimum":0,"maximum":u32::MAX}}),
        &["branchId", "messageId", "charOffset"],
    );
    add("session.messages.read", "Read an authorized exact historical message from Pi history. Use sessionId/messageId returned by session.search. Long originals return nextCursor; reuse it unchanged to continue.", json!({"sessionId":text(32),"messageId":text(32),"cursor":nullable(history_cursor),"budgetChars":integer(12000)}), &["sessionId","messageId"]);
    result
}

#[cfg(test)]
#[path = "tools_tests.rs"]
mod tests;
