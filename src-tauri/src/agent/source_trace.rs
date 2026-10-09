//! Provenance from trusted native result fields only. Text and tool arguments
//! are deliberately never inspected for references.
use super::{
    access::{Caller, RequestContext},
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, Scope, SourceRef, WorkspaceBinding},
    output_runtime::OutputState,
};
use crate::{
    agent::context::{AiOverview, PublishedOverviewRef},
    db::{agent_run_provenance::ObservedSource, Database},
    source_service::SourceReadTarget,
};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::HashSet;

fn not_ready() -> AgentError {
    AgentError::new(
        ErrorCode::SourceNotReady,
        "Native result has no traceable source identity",
    )
}
fn field<'a>(value: &'a Value, key: &str) -> AgentResult<&'a Value> {
    value.get(key).ok_or_else(not_ready)
}
fn typed<T: DeserializeOwned>(value: &Value) -> AgentResult<T> {
    serde_json::from_value(value.clone()).map_err(|_| not_ready())
}
fn observed(source: &SourceRef) -> ObservedSource {
    ObservedSource {
        object: source.object.clone(),
        revision: Some(source.revision.clone()),
    }
}
/// Check a derived citation through its message and the original Run's sources.
pub(crate) fn derived_source_visible(
    db: &Database,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    source: &SourceRef,
) -> AgentResult<()> {
    if source.object.kind == ObjectKind::SessionMessage {
        db.source_session_record(
            request,
            binding,
            &SourceReadTarget {
                object: source.object.clone(),
                revision: Some(source.revision.clone()),
                record_version: None,
                file_version: None,
            },
        )?;
    } else {
        db.source_read_object(request, binding, &source.object)?;
    }
    Ok(())
}
/// Resolve a typed published item all the way to its original evidence. The
/// caller may possess Workspace access without access to every Project; the
/// complete mixed-source item is hidden in that case.
pub(crate) fn published_source_visible(
    db: &Database, request: &RequestContext, binding: &WorkspaceBinding,
    parent: &PublishedOverviewRef,
) -> AgentResult<Vec<SourceRef>> {
    let scope = Scope::Project { project_id: parent.project_id };
    request.authorize(binding, &scope, "context.read")?;
    let project=ObjectRef {workspace_id:binding.workspace_id.clone(),scope:scope.clone(),
        kind:ObjectKind::Project,id:parent.project_id.to_string()};
    let mut project_request=request.clone();
    if !project_request.scope_grant.operations.iter().any(|op|op=="source.read") {
        project_request.scope_grant.operations.push("source.read".into());
    }
    db.source_read_object(&project_request,binding,&project)?;
    let sources = db.agent_published_item_verify(parent)?;
    if db.agent_overview_stale_items(&binding.workspace_id,&scope)?.contains(&parent.item_id) {
        return Err(not_ready());
    }
    let mut source_request=request.clone();
    if !source_request.scope_grant.operations.iter().any(|op| op=="source.read") {
        source_request.scope_grant.operations.push("source.read".into());
    }
    for source in &sources { derived_source_visible(db,&source_request,binding,source)?; }
    Ok(sources)
}
/// Flatten message citations once. The Host also uses this before initial L0 begin.
pub(crate) fn expand_sources(
    db: &Database,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    sources: Vec<ObservedSource>,
) -> AgentResult<Vec<ObservedSource>> {
    let mut out = Vec::new();
    for source in sources {
        if source.object.kind == ObjectKind::SessionSummary {
            let revision = source
                .revision
                .as_deref()
                .map(|revision| revision.parse::<u64>().map_err(|_| not_ready()))
                .transpose()?;
            let node = db
                .agent_knowledge_get(&source.object.scope, &source.object.id, revision)?
                .ok_or_else(not_ready)?;
            if !crate::source_session_summary::visible(db, request, binding, &node)? {
                return Err(not_ready());
            }
            out.extend(expand_sources(
                db,
                request,
                binding,
                node.source_refs.iter().map(observed).collect(),
            )?);
        }
        if source.object.kind == ObjectKind::SessionMessage {
            let record = db.source_session_record(
                request,
                binding,
                &SourceReadTarget {
                    object: source.object.clone(),
                    revision: source.revision.clone(),
                    record_version: None,
                    file_version: None,
                },
            )?;
            if record.role == "assistant" {
                let run_id = record.run_id.as_deref().ok_or_else(not_ready)?;
                out.extend(
                    db.agent_run_provenance_sources(request, binding, run_id)?
                        .ok_or_else(not_ready)?,
                );
            }
        }
        out.push(source);
    }
    Ok(out)
}
fn object(value: &Value) -> AgentResult<ObservedSource> {
    Ok(ObservedSource {
        object: typed(value)?,
        revision: None,
    })
}
fn array<'a>(value: &'a Value, key: &str) -> AgentResult<&'a Vec<Value>> {
    field(value, key)?.as_array().ok_or_else(not_ready)
}
fn revision(value: &Value) -> AgentResult<u64> {
    value.as_u64().filter(|n| *n > 0).ok_or_else(not_ready)
}
fn scope(value: &Value) -> AgentResult<Scope> {
    typed(field(value, "scope")?)
}
fn add_knowledge(
    db: &Database,
    request:&RequestContext,
    binding:&WorkspaceBinding,
    scope: &Scope,
    id: &str,
    revision: u64,
    out: &mut Vec<ObservedSource>,
) -> AgentResult<()> {
    if let Some(id) = id.strip_prefix("node:") {
        let node = db
            .agent_knowledge_get(scope, id, Some(revision))?
            .ok_or_else(not_ready)?;
        if node.session_summary.is_some() {
            let source = node.source_refs.first().ok_or_else(not_ready)?;
            let mut object = source.object.clone();
            object.kind = ObjectKind::SessionSummary;
            object.id = node.node_id.clone();
            out.push(ObservedSource {
                object,
                revision: Some(node.revision.to_string()),
            });
        } else {
            out.extend(node.source_refs.iter().map(observed));
            for parent in &node.published_sources {
                out.push(observed_project(binding,parent));
                out.extend(published_source_visible(db,request,binding,parent)?.iter().map(observed));
            }
        }
        return Ok(());
    }
    if let Some(id) = id.strip_prefix("overview:") {
        return add_overview(db,request,binding, scope, revision, vec![id.into()], out);
    }
    Err(not_ready())
}
fn add_overview(
    db: &Database,
    request:&RequestContext,
    binding:&WorkspaceBinding,
    scope: &Scope,
    revision: u64,
    ids: Vec<String>,
    out: &mut Vec<ObservedSource>,
) -> AgentResult<()> {
    let snapshot: AiOverview = db
        .agent_overview_version(scope, revision)?
        .ok_or_else(not_ready)?;
    let mut pending = ids;
    let mut visited = HashSet::new();
    while let Some(id) = pending.pop() {
        if !visited.insert(id.clone()) {
            continue;
        }
        let item = snapshot
            .items
            .iter()
            .find(|item| item.id == id)
            .ok_or_else(not_ready)?;
        out.extend(item.source_refs.iter().map(observed));
        for parent in &item.published_sources {
            out.push(observed_project(binding,parent));
            out.extend(published_source_visible(db,request,binding,parent)?.iter().map(observed));
        }
        pending.extend(item.dependency_item_ids.iter().cloned());
    }
    Ok(())
}
fn observed_project(binding:&WorkspaceBinding,parent:&PublishedOverviewRef)->ObservedSource {
    ObservedSource {object:ObjectRef {workspace_id:binding.workspace_id.clone(),
        scope:Scope::Project{project_id:parent.project_id},kind:ObjectKind::Project,
        id:parent.project_id.to_string()},revision:None}
}
fn output_card(
    db: &Database,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    card: &Value,
    out: &mut Vec<ObservedSource>,
) -> AgentResult<()> {
    let id = field(card, "outputId")?.as_str().ok_or_else(not_ready)?;
    let saved = db.agent_output_get(request, binding, id)?;
    if let Some(object) = saved.object {
        out.push(ObservedSource {
            object,
            revision: None,
        });
    } else if let Caller::BuiltinRun { run_id } = &request.caller {
        if saved.staged.run_id != *run_id {
            out.extend(
                db.agent_run_provenance_sources(request, binding, &saved.staged.run_id)?
                    .ok_or_else(not_ready)?,
            );
        }
    } else if saved.state != OutputState::Staged {
        return Err(not_ready());
    }
    Ok(())
}
fn add_history(
    db: &Database,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    value: &Value,
    out: &mut Vec<ObservedSource>,
) -> AgentResult<()> {
    let source: SourceRef = typed(field(value, "sourceRef")?)?;
    db.agent_model_session_source_record(request, binding, &source)?;
    out.push(observed(&source));
    Ok(())
}
/// Extract every source that the native result actually exposed. Unknown reads
/// fail closed; successful mutation receipts carry no new business body.
pub(super) fn result_sources(
    db: &Database,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    method: &str,
    result: &Value,
) -> AgentResult<Vec<ObservedSource>> {
    let mut out = Vec::new();
    match method {
        "project.list" => {
            for item in array(result, "items")? {
                let id = field(item, "id")?.as_i64().filter(|id| *id > 0)
                    .ok_or_else(not_ready)?;
                let object = ObjectRef { workspace_id: binding.workspace_id.clone(),
                    scope: Scope::Project { project_id: id }, kind: ObjectKind::Project,
                    id: id.to_string() };
                db.source_read_object(request, binding, &object)?;
                out.push(ObservedSource { object, revision: None });
            }
        }
        "context.get" => {} // Captured with the hidden ContextEntry field before encoding.
        "source.search" => {
            for item in array(result, "items")? {
                out.push(observed(&typed(field(item, "sourceRef")?)?));
            }
        }
        "source.read" => out.push(observed(&typed(field(result, "sourceRef")?)?)),
        "record.blocks.get" => {
            let mut source = object(field(result, "record")?)?;
            source.revision = Some(revision(field(result, "headRevision")?)?.to_string());
            out.push(source);
        }
        "file.source.read" => {
            let mut source = object(field(result, "object")?)?;
            source.revision = Some(
                field(result, "contentHash")?
                    .as_str()
                    .ok_or_else(not_ready)?
                    .to_string(),
            );
            out.push(source);
        }
        "todo.get" => {
            let mut source = object(field(result, "object")?)?;
            source.revision = Some(revision(field(result, "revision")?)?.to_string());
            out.push(source);
        }
        "file.versions.list" => {
            let source = object(field(result, "object")?)?;
            for version in array(result, "versions")? {
                let mut item = source.clone();
                item.revision = field(version, "contentHash")?.as_str().map(str::to_string);
                out.push(item);
            }
            if out.is_empty() {
                out.push(source);
            }
        }
        "file.versions.get" => {
            let mut source = object(field(result, "object")?)?;
            source.revision = field(field(result, "version")?, "contentHash")?
                .as_str()
                .map(str::to_string);
            out.push(source);
        }
        "knowledge.search" => {
            let scope = scope(result)?;
            for card in array(result, "items")? {
                add_knowledge(
                    db,
                    request,binding,
                    &scope,
                    field(card, "nodeId")?.as_str().ok_or_else(not_ready)?,
                    revision(field(card, "revision")?)?,
                    &mut out,
                )?;
            }
        }
        "knowledge.get" => {
            let scope = scope(result)?;
            add_knowledge(
                db,
                request,binding,
                &scope,
                field(result, "nodeId")?.as_str().ok_or_else(not_ready)?,
                revision(field(result, "revision")?)?,
                &mut out,
            )?;
            for card in array(result, "related")? {
                add_knowledge(
                    db,
                    request,binding,
                    &scope,
                    field(card, "nodeId")?.as_str().ok_or_else(not_ready)?,
                    revision(field(card, "revision")?)?,
                    &mut out,
                )?;
            }
        }
        "context.overview.get" => {
            if let Some(r) = field(result, "revision")?.as_u64() {
                let ids = array(result, "items")?
                    .iter()
                    .map(|entry| {
                        field(field(entry, "item")?, "id")?
                            .as_str()
                            .map(str::to_string)
                            .ok_or_else(not_ready)
                    })
                    .collect::<AgentResult<Vec<_>>>()?;
                add_overview(db,request,binding, &scope(result)?, r, ids, &mut out)?;
            }
        }
        "output.get" => output_card(db, request, binding, result, &mut out)?,
        "output.list" => {
            for card in array(result, "outputs")? {
                output_card(db, request, binding, card, &mut out)?;
            }
        }
        "operation.get" => out.push(object(field(result, "object")?)?),
        "operation.list" => {
            for entry in array(result, "operations")? {
                out.push(object(field(entry, "object")?)?);
            }
        }
        "session.search" => {
            for entry in array(result, "matches")? {
                add_history(db, request, binding, entry, &mut out)?;
            }
        }
        "session.messages.read" => add_history(db, request, binding, result, &mut out)?,
        "review.decide" => {
            let candidate_run = field(result, "runId")?.as_str().ok_or_else(not_ready)?;
            out.extend(db.agent_run_provenance_sources(request, binding, candidate_run)?.ok_or_else(not_ready)?);
        }
        "output.stage"
        | "output.update"
        | "output.commit"
        | "operation.undo"
        | "operation.restore_created"
        | "file.content.begin"
        | "file.content.chunk"
        | "file.content.complete"
        | "file.content.status" => {}
        _ => return Err(not_ready()),
    }
    expand_sources(db, request, binding, out)
}

#[cfg(test)]
#[path = "source_trace_tests.rs"]
mod tests;
