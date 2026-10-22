//! One bounded, durable Project knowledge batch. Inventory, reads and model
//! generation use their existing services; only a validated draft is published.
use crate::{
    agent::{
        access::{Caller, RequestContext, ScopeGrant},
        context::{EpistemicStatus, SourceCoverage},
        errors::{AgentError, AgentResult, ErrorCode},
        knowledge::{KnowledgeKind, KnowledgeNode, KnowledgeNodeWrite},
        models::{ObjectKind, Scope, WorkspaceBinding},
        overview::OverviewPublishInput,
    },
    db::{
        overview_maintenance::{
            OverviewInput, OverviewMaintenanceBatch, OverviewSourceProgress, OverviewSourceState,
        },
        Database,
    },
    overview_generation::{AllowedAffectedIds, PromptInput},
    overview_model::OverviewModel,
    overview_service::OverviewService,
    source_service::{
        BoundSourceStore, SourceReadInput, SourceReadTarget, SourceReadView, SourceUtility,
    },
};
use chrono::Utc;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Manager;

pub(crate) fn request(
    binding: WorkspaceBinding,
    scope: &Scope,
    request_id: String,
) -> RequestContext {
    RequestContext {
        scope_grant: ScopeGrant {
            object_keys: None,
            workspace_id: binding.workspace_id.clone(),
            workspace_content: false,
            project_ids: match scope {
                Scope::Project { project_id } => vec![*project_id],
                _ => vec![],
            },
            operations: [
                "settings.read",
                "settings.write",
                "context.read",
                "knowledge.write",
                "source.read",
                "session.read",
                "operation.read",
            ]
            .map(str::to_owned)
            .to_vec(),
        },
        binding,
        request_id,
        caller: Caller::Gui,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverviewMaintenanceView {
    #[serde(flatten)]
    progress: crate::db::overview_maintenance::OverviewMaintenanceStatus,
    #[serde(flatten)]
    schedule: crate::db::overview_schedule::OverviewScheduleStatus,
    #[serde(skip_serializing_if="Option::is_none")]
    project_statuses: Option<Vec<crate::db::overview_maintenance::OverviewProjectStatus>>,
}
pub(crate) fn status<S: BoundSourceStore>(
    store: &S,
    request: &RequestContext,
    scope: &Scope,
) -> AgentResult<OverviewMaintenanceView> {
    store.with_current(|binding, db| {
        request.authorize(binding, scope, "settings.read")?;
        let project_statuses=if matches!(scope,Scope::Workspace) {Some(db.agent_overview_project_statuses(binding)?)} else {None};
        Ok(OverviewMaintenanceView {
            progress: db.agent_overview_maintenance_status(binding, scope)?,
            schedule: db.overview_schedule_status(binding, scope, Utc::now())?,
            project_statuses,
        })
    })
}
pub(crate) fn control<S: BoundSourceStore>(
    store: &S,
    request: &RequestContext,
    scope: &Scope,
    action: &str,
) -> AgentResult<OverviewMaintenanceView> {
    store.with_current(|binding, db| {
        request.authorize(binding, scope, "settings.write")?;
        if !matches!(request.caller, Caller::Gui) {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Knowledge maintenance control belongs to the user",
            ));
        }
        let now = Utc::now();
        match action {
            "cancel" => db.agent_overview_maintenance_cancel(binding, scope, now)?,
            "refresh" | "resume" => {
                if !db.overview_schedule_scope(binding, scope)? {
                    return Err(AgentError::new(
                        ErrorCode::ScopeDenied,
                        "Enable this Project or Workspace assistant first",
                    ));
                }
                db.agent_overview_maintenance_resume(binding, scope, now)?;
                db.overview_schedule_request(binding, scope, now)?;
            }
            _ => {
                return Err(AgentError::new(
                    ErrorCode::InvalidArgument,
                    "Unknown knowledge maintenance action",
                ))
            }
        }
        Ok(())
    })?;
    status(store, request, scope)
}
fn active(
    db: &Database,
    binding: &WorkspaceBinding,
    request: &RequestContext,
    scope: &Scope,
) -> AgentResult<()> {
    request.authorize(binding, scope, "knowledge.write")?;
    let progress = db.agent_overview_maintenance_status(binding, scope)?;
    if progress.cancelled || !db.overview_schedule_scope(binding, scope)? {
        return Err(AgentError::new(
            ErrorCode::Cancelled,
            "Knowledge maintenance is paused",
        ));
    }
    if db.source_foreground_busy()? {
        return Err(AgentError::new(
            ErrorCode::RunBusy,
            "Foreground work has priority",
        ));
    }
    Ok(())
}
fn hash(value: &impl Serialize) -> AgentResult<String> {
    let bytes = serde_json::to_vec(value).map_err(|_| {
        AgentError::new(ErrorCode::InvalidArgument, "Cannot encode knowledge input")
    })?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn memory_nodes<S:BoundSourceStore>(store:&S,scope:&Scope,
    candidates:Vec<crate::overview_generation::ParsedMemoryCandidate>,now:&str)->AgentResult<Vec<KnowledgeNodeWrite>> {
    let mut nodes=Vec::new();
    for candidate in candidates {
        let previous=store.with_current(|_,db|db.agent_knowledge_get(scope,&candidate.node_id,None))?;
        nodes.push(KnowledgeNodeWrite {
            node_id:candidate.node_id,expected_revision:previous.map_or(0,|node|node.revision),
            kind:KnowledgeKind::Memory,title:candidate.title,one_line:candidate.one_line,
            summary:candidate.summary,body_sections:candidate.body_sections,aliases:vec![],
            keywords:candidate.keywords,source_refs:candidate.source_refs,
            published_sources:candidate.published_sources,epistemic_status:EpistemicStatus::Inferred,
            coverage:SourceCoverage {processed:1,partial:0,excluded:0,unsupported:0,pending:0},
            related:vec![],session_summary:None,
            memory:Some(crate::agent::memory::MemoryMetadata {
                category:candidate.category,last_supported_at:now.into(),
            }),
        });
    }
    Ok(nodes)
}

fn prior_memory<S:BoundSourceStore>(store:&S,request:&RequestContext,scope:&Scope,
    inputs:&[OverviewInput])->AgentResult<Vec<KnowledgeNode>> {
    let mut nodes=Vec::new();
    let mut seen=std::collections::HashSet::new();
    for input in inputs {
        let found=store.with_current(|binding,db| {
            let mut visible=Vec::new();
            for mut node in db.agent_overview_memory_for_input(scope,input)? {
                if !db.agent_memory_model_visible(request,binding,&node)? {continue;}
                if db.agent_memory_policy(scope,&node.node_id)?.is_some_and(|policy|
                    policy.confirmation==crate::agent::memory::MemoryConfirmation::UserConfirmed
                    || policy.protected_correction) {
                    node.epistemic_status=EpistemicStatus::UserConfirmed;
                }
                visible.push(node);
            }
            Ok(visible)
        })?;
        for node in found {
            if seen.insert(node.node_id.clone()) {nodes.push(node);}
        }
    }
    if nodes.len()>50 {return Err(AgentError::new(ErrorCode::BudgetExceeded,
        "Existing memories for this source exceed model input budget"));}
    Ok(nodes)
}

/// A document advances one bounded page at a time. Eligible current-branch
/// conversation messages can share one model call and one atomic publication.
/// Every source cursor advances only after that publication exists.
pub(crate) async fn step<
    S: BoundSourceStore,
    R: crate::record_document_service::DocumentUtility,
    F: SourceUtility,
    M: OverviewModel,
    H: crate::source_session_read::SessionHistoryUtility,
>(
    store: &S,
    request: &RequestContext,
    scope: &Scope,
    record: &R,
    file: &F,
    model: &M,
    history: &H,
) -> AgentResult<bool> {
    store.with_current(|binding, db| active(db, binding, request, scope))?;
    if history.advance_index(&request.binding, request, scope).await? {
        return Ok(true);
    }
    if store.with_current(|binding, db| db.agent_session_maintenance_seed(binding, scope, 200))? {
        return Ok(true);
    }
    let service = OverviewService::new(store);
    let inventory_complete = store.with_current(|binding, db| {
        Ok(db
            .agent_overview_maintenance_status(binding, scope)?
            .directory_complete)
    })?;
    if !inventory_complete
        && !service
            .inventory_advance(request, scope, 100)?
            .directory_complete
    {
        return Ok(true);
    }
    let batch = store.with_current(|binding, db| {
        db.agent_overview_maintenance_prepare(binding, scope, Utc::now())
    })?;
    let Some(batch) = batch else {
        store.with_current(|binding, db| {
            db.overview_schedule_finished(binding, scope, false, Utc::now())
        })?;
        return Ok(false);
    };
    let mut batch_request = request.clone();
    batch_request.request_id = format!("overview-{}", batch.batch_id);
    let result = {
        let work = process_batch(store, &batch_request, &batch, record, file, model, history);
        tokio::pin!(work);
        loop {
            tokio::select! {
                biased;
                result = &mut work => break result,
                _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                    if let Err(error) = store.with_current(|binding, db| active(db, binding, request, scope)) { break Err(error); }
                }
            }
        }
    };
    let mut deferred=false;
    if let Err(error) = &result {
        if store.with_current(|binding,db|db.agent_overview_maintenance_reset_changed_memory_epoch(
            binding,scope,&batch.batch_id,Utc::now()))? {
            deferred=true;
        } else if matches!(&batch.source_object,crate::db::overview_maintenance::OverviewInput::Published{..})
            && matches!(error.code,ErrorCode::SourceNotReady|ErrorCode::FileChangedUnregistered) {
            store.with_current(|binding,db| {
                let now=Utc::now();
                db.agent_overview_maintenance_defer_published(binding,scope,&batch.batch_id,error.code,now)?;
                db.overview_schedule_finished(binding,scope,true,now)
            })?;
            deferred=true;
        } else if !matches!(
            error.code,
            ErrorCode::Cancelled
                | ErrorCode::RunBusy
                | ErrorCode::WorkspaceChanged
                | ErrorCode::WorkspaceNotOpen
        ) {
            store.with_current(|binding, db| {
                db.agent_overview_maintenance_fail(
                    binding,
                    scope,
                    &batch.batch_id,
                    error.code,
                    Utc::now(),
                )
            })?;
        }
    }
    if deferred {return Ok(true);}
    result.map(|_| true)
}

async fn process_batch<
    S: BoundSourceStore,
    R: crate::record_document_service::DocumentUtility,
    F: SourceUtility,
    M: OverviewModel,
    H: crate::source_session_read::SessionHistoryUtility,
>(
    store: &S,
    request: &RequestContext,
    batch: &OverviewMaintenanceBatch,
    record: &R,
    file: &F,
    model: &M,
    history: &H,
) -> AgentResult<()> {
    let service = OverviewService::new(store);
    if batch.source_object.published().is_some() {
        return process_published_batch(store,request,batch,model).await;
    }
    let source_object = batch.source_object.raw_object().ok_or_else(|| AgentError::new(ErrorCode::InvalidArgument,"Expected raw Overview input"))?;
    // A crash after publish must not charge another model call or reread a source
    // that may already have changed. The immutable publication proves completion.
    if let Some(draft) = &batch.draft {
        let replay = store.with_current(|_, db| {
            db.agent_overview_replay(&request.caller.key(), &request.request_id, draft)
        })?;
        if replay.is_some() {
            return complete(store, request, batch);
        }
    }
    let mut budget = None;
    let mut page_budget_chars = batch.source_page_budget_chars.unwrap_or(12_000);
    let mut evidence = vec![];
    let mut pages = vec![];
    let mut progress = OverviewSourceProgress {
        object: crate::db::overview_maintenance::OverviewInput::Raw(source_object.clone()),
        read_target: None,
        read_cursor: None,
        state: OverviewSourceState::Processed,
        handled_seq: batch.source.last_seq,
    };
    let conversation_data = if !batch.source.deleted && !batch.source.excluded {
        crate::overview_session::input(store, request, &batch.source_read_target.clone().unwrap_or(SourceReadTarget {
            object: source_object.clone(), revision: None, record_version: None, file_version: None,
        }))?
    } else { None };
    if batch.source.deleted {
        progress.state = OverviewSourceState::Deleted;
    } else if batch.source.excluded {
        progress.state = OverviewSourceState::Excluded;
    } else if source_object.kind == ObjectKind::SessionSummary {
        // Summary policy events are metadata invalidations. Its original
        // messages own generation; never summarize a summary again.
        progress.state = OverviewSourceState::Processed;
    } else if source_object.kind == ObjectKind::SessionMessage && conversation_data.is_none() {
        progress.state = OverviewSourceState::Unsupported;
    } else {
        let target = batch
            .source_read_target
            .clone()
            .unwrap_or(SourceReadTarget {
                object: source_object.clone(),
                revision: None,
                record_version: None,
                file_version: None,
            });
        let input = SourceReadInput {
            source: target,
            view: SourceReadView::Full,
            selection: None,
            cursor: batch.source_cursor.clone(),
            budget_chars: Some(page_budget_chars),
        };
        let (page, proof) = if source_object.kind == ObjectKind::SessionMessage {
            crate::overview_evidence::capture_session(store, request, &input, history).await?
        } else {
            crate::overview_evidence::capture(store, request, &input, record, file).await?
        };
        if batch.draft.is_none() && source_object.kind != ObjectKind::Project
            && !page.text.trim().is_empty() {
            let prepared = model.prepare().await?;
            budget = Some(prepared);
        }
        progress.read_target = Some(SourceReadTarget {
            revision: Some(page.source_ref.revision.clone()),
            ..input.source
        });
        progress.read_cursor = page.next_cursor.clone();
        progress.state = if page.complete {
            OverviewSourceState::Processed
        } else if page.next_cursor.is_some() {
            OverviewSourceState::Partial
        } else {
            OverviewSourceState::Unsupported
        };
        if !page.complete
            && page.next_cursor.is_none()
            && page
                .extraction
                .as_ref()
                .is_some_and(|v| !matches!(v.state.as_str(), "unsupported" | "no_text"))
        {
            return Err(AgentError::new(ErrorCode::SourceNotReady, "Source extraction is incomplete; finish processing it before continuing knowledge maintenance"));
        }
        evidence.push(proof);
        pages.push(page);
    }
    let mut session_data = conversation_data.iter().map(|(record,conversation,_)|(record.clone(),conversation.clone())).collect::<Vec<_>>();
    let mut progresses = vec![progress.clone()];
    let candidates = if batch.draft.is_some() && !batch.sources_frozen {
        vec![]
    } else if !batch.sources_frozen {
        store.with_current(|binding,db|db.agent_overview_message_successors(binding,batch))?
    } else { batch.source_items.clone() };
    let mut candidate_reads = Vec::new();
    if !pages.is_empty() && pages[0].complete && !pages[0].text.trim().is_empty() && !session_data.is_empty() {
        for source in candidates {
            let object = crate::agent::models::ObjectRef {
                workspace_id: request.binding.workspace_id.clone(), scope: batch.scope.clone(),
                kind: ObjectKind::SessionMessage,
                id: source.object_key.rsplit('/').next().unwrap_or_default().into(),
            };
            let target=SourceReadTarget { object:object.clone(), revision:None,record_version:None,file_version:None };
            let Some((record,conversation,_))=crate::overview_session::input(store,request,&target)? else { break; };
            let input=SourceReadInput { source:target,view:SourceReadView::Full,selection:None,cursor:None,
                budget_chars:Some(page_budget_chars) };
            let (page,proof)=crate::overview_evidence::capture_session(store,request,&input,history).await?;
            if !page.complete || page.text.trim().is_empty() { break; }
            let progress=OverviewSourceProgress { object:crate::db::overview_maintenance::OverviewInput::Raw(object),read_target:Some(SourceReadTarget { revision:Some(page.source_ref.revision.clone()),..input.source }),read_cursor:None,state:OverviewSourceState::Processed,handled_seq:source.last_seq };
            candidate_reads.push((source,record,conversation,page,proof,progress));
        }
    }
    if batch.draft.is_some() {
        if candidate_reads.len()!=batch.source_items.len() {
            return Err(AgentError::new(ErrorCode::SourceChanged,"Frozen session batch is no longer readable"));
        }
        for (_,record,conversation,page,proof,next_progress) in candidate_reads.drain(..) {
            session_data.push((record,conversation)); pages.push(page); evidence.push(proof); progresses.push(next_progress);
        }
    }
    let publish = if let Some(draft) = &batch.draft {
        draft.clone()
    } else {
        let (mut old, corrections) = store.with_current(|binding, db| {
            active(db, binding, request, &batch.scope)?;
            Ok((
                db.agent_overview_head(&batch.scope)?,
                db.agent_overview_corrections(&batch.scope)?,
            ))
        })?;
        let mut existing_memory=if pages.is_empty() {Vec::new()} else {
            prior_memory(store,request,&batch.scope,std::slice::from_ref(&batch.source_object))?
        };
        // Keep all IDs for collision checks, but never send hidden historical
        // knowledge back to the model through the previous Overview context.
        let existing_ids = old
            .iter()
            .flat_map(|snapshot| &snapshot.items)
            .map(|item| item.id.clone())
            .collect();
        if !pages.is_empty()
            && source_object.kind != ObjectKind::Project
            && !pages[0].text.trim().is_empty()
        {
            if let Some(snapshot) = &mut old {
                let mut visible = Vec::new();
                for item in &snapshot.items {
                    let mut input = crate::overview_service::OverviewReadInput {
                        scope: batch.scope.clone(),
                        version: Some(snapshot.revision),
                        sections: vec![],
                        item_ids: vec![item.id.clone()],
                        cursor: None,
                        budget_chars: Some(8000),
                    };
                    loop {
                        let page = service.get(request, &input).await?;
                        for part in page.items {
                            if part.text_offset == 0 {
                                visible.push(part.item);
                            } else if let Some(previous) = visible.last_mut() {
                                previous.text.push_str(&part.item.text);
                            }
                        }
                        input.cursor = page.next_cursor;
                        if input.cursor.is_none() {
                            break;
                        }
                    }
                }
                snapshot.items = visible;
            }
        }
        let old_items = old.as_ref().map_or(&[][..], |v| v.items.as_slice());
        let mut allowed = AllowedAffectedIds {
            existing_ids,
            affected_ids: old_items
                .iter()
                .filter(|item| {
                    item.source_refs
                        .iter()
                        .any(|source| source.object == *source_object)
                })
                .map(|item| item.id.clone())
                .collect(),
        };
        if let Some((record, _, _)) = &conversation_data {
            allowed.affected_ids.extend(crate::overview_session::predecessors(store, record, old_items)?);
        }
        loop {
            let before = allowed.affected_ids.len();
            let children: Vec<_> = old_items
                .iter()
                .filter(|item| {
                    item.dependency_item_ids
                        .iter()
                        .any(|id| allowed.affected_ids.contains(id))
                })
                .map(|item| item.id.clone())
                .collect();
            allowed.affected_ids.extend(children);
            if before == allowed.affected_ids.len() {
                break;
            }
        }
        let corrections: Vec<_> = corrections.items.into_iter().filter(|item| !item.deleted).collect();
        if let Some(prepared) = &budget {
            // Measure the entire request, including prior Overview, corrections,
            // source metadata and conversation metadata. Re-read the same cursor
            // until one page fits; a partial first page cannot include successors.
            loop {
                let relevant: Vec<_> = old_items.iter().filter(|item| allowed.affected_ids.contains(&item.id)).cloned().collect();
                let prompt = crate::overview_generation::build_prompt_batch(&PromptInput {
                    old_overview: old.as_ref(), allowed_ids: &allowed, relevant_items: &relevant,
                    corrections: &corrections, source_pages: &pages,
                    prior_source_summary: conversation_data.as_ref().and_then(|(_, _, prior)| prior.as_ref()),
                    prior_memory:&existing_memory,
                    conversation: conversation_data.as_ref().map(|(_, conversation, _)| conversation),
                }, &session_data.iter().map(|(_, conversation)| conversation.clone()).collect::<Vec<_>>());
                match prompt {
                    Ok(value) if prepared.check(&value).is_ok() => break,
                    Err(error) if error.code != ErrorCode::BudgetExceeded => return Err(error),
                    _ => {}
                }
                let current_chars = pages[0].text.chars().count();
                if current_chars <= 1 { return Err(AgentError::new(ErrorCode::BudgetExceeded,
                    "Overview context and source metadata exceed model input budget")); }
                let metadata_chars = crate::agent::context::serialized_chars(&pages[0])?
                    .saturating_sub(current_chars);
                let next_page_budget = metadata_chars + (current_chars / 2).max(1);
                let input = SourceReadInput {
                    source: batch.source_read_target.clone().unwrap_or(SourceReadTarget {
                        object: source_object.clone(), revision: None, record_version: None, file_version: None,
                    }), view: SourceReadView::Full, selection: None, cursor: batch.source_cursor.clone(),
                    budget_chars: Some(next_page_budget),
                };
                page_budget_chars = next_page_budget;
                let (page, proof) = if source_object.kind == ObjectKind::SessionMessage {
                    crate::overview_evidence::capture_session(store, request, &input, history).await?
                } else {
                    crate::overview_evidence::capture(store, request, &input, record, file).await?
                };
                progress.read_target = Some(SourceReadTarget { revision: Some(page.source_ref.revision.clone()), ..input.source });
                progress.read_cursor = page.next_cursor.clone();
                progress.state = if page.complete { OverviewSourceState::Processed }
                    else if page.next_cursor.is_some() { OverviewSourceState::Partial }
                    else { OverviewSourceState::Unsupported };
                pages[0] = page;
                evidence[0] = proof;
                progresses[0] = progress.clone();
                if !pages[0].complete { candidate_reads.clear(); }
            }
        }
        let mut selected_sources = Vec::new();
        for (source,record,conversation,page,proof,next_progress) in candidate_reads {
            pages.push(page);
            session_data.push((record,conversation));
            let mut prospective_allowed=allowed.clone();
            prospective_allowed.affected_ids.extend(old_items.iter().filter(|item|item.source_refs.iter().any(|reference|reference.object==*next_progress.object.raw_object().unwrap())).map(|item|item.id.clone()));
            prospective_allowed.affected_ids.extend(crate::overview_session::predecessors(store,&session_data.last().unwrap().0,old_items)?);
            loop {
                let before=prospective_allowed.affected_ids.len();
                prospective_allowed.affected_ids.extend(old_items.iter().filter(|item|item.dependency_item_ids.iter().any(|id|prospective_allowed.affected_ids.contains(id))).map(|item|item.id.clone()).collect::<Vec<_>>());
                if before==prospective_allowed.affected_ids.len() { break; }
            }
            let prospective_relevant:Vec<_>=old_items.iter().filter(|item|prospective_allowed.affected_ids.contains(&item.id)).cloned().collect();
            let mut prospective_memory=existing_memory.clone();
            for node in prior_memory(store,request,&batch.scope,std::slice::from_ref(&next_progress.object))? {
                if !prospective_memory.iter().any(|old|old.node_id==node.node_id) {prospective_memory.push(node);}
            }
            if prospective_memory.len()>50 {return Err(AgentError::new(ErrorCode::BudgetExceeded,
                "Existing memories for this source exceed model input budget"));}
            let prospective = crate::overview_generation::build_prompt_batch(&PromptInput {
                old_overview:old.as_ref(),allowed_ids:&prospective_allowed,relevant_items:&prospective_relevant,corrections:&corrections,
                source_pages:&pages,prior_source_summary:conversation_data.as_ref().and_then(|(_,_,prior)|prior.as_ref()),
                prior_memory:&prospective_memory,
                conversation:conversation_data.as_ref().map(|(_,conversation,_)|conversation),
            },&session_data.iter().map(|(_,conversation)|conversation.clone()).collect::<Vec<_>>());
            match prospective {
                Ok(prompt) if budget.as_ref().is_some_and(|value| value.check(&prompt).is_ok()) => {
                    existing_memory=prospective_memory;
                    allowed=prospective_allowed; evidence.push(proof); progresses.push(next_progress); selected_sources.push(source);
                }
                Ok(_) => { pages.pop(); session_data.pop(); break; }
                Err(error) if error.code==ErrorCode::BudgetExceeded => { pages.pop(); session_data.pop(); break; }
                Err(error) => return Err(error),
            }
        }
        if !batch.source_items.is_empty() && selected_sources.len()!=batch.source_items.len() {
            return Err(AgentError::new(ErrorCode::SourceChanged,"Frozen session batch is no longer readable"));
        }
        store.with_current(|binding,db|db.agent_overview_maintenance_freeze_sources(binding,&batch.scope,&batch.batch_id,selected_sources.clone(),Utc::now()))?;
        let coverage=store.with_current(|binding,db|db.agent_overview_maintenance_coverage_many(binding,&batch.scope,&progresses))?;
        let mut publish = OverviewPublishInput {
            scope: batch.scope.clone(),
            batch_id: batch.batch_id.clone(),
            expected_revision: batch.expected_revision,
            target_seq: batch.target_seq,
            policy_revision: batch.policy_revision,
            correction_revision: batch.correction_revision,
            expected_memory_epoch: batch.expected_memory_epoch,
            upsert_items: vec![],
            remove_item_ids: vec![],
            settled_object_keys: progresses.iter().filter(|p|p.state!=OverviewSourceState::Partial).map(|p|p.object.key()).collect::<AgentResult<Vec<_>>>()?,
            knowledge_upserts: vec![],
            knowledge_removes: vec![],
            coverage,
            source_manifest_hash: hash(&(&batch.source, &selected_sources, &progresses))?,
            model_profile_id: "native-metadata".into(),
        };
        if pages.is_empty() || (pages[0].complete && pages[0].text.trim().is_empty()) {
            publish.remove_item_ids = allowed.affected_ids.iter().cloned().collect();
            publish.remove_item_ids.sort();
        } else if source_object.kind != ObjectKind::Project
            && !pages[0].text.trim().is_empty()
        {
            let relevant: Vec<_> = old_items
                .iter()
                .filter(|item| allowed.affected_ids.contains(&item.id))
                .cloned()
                .collect();
            let prompt = crate::overview_generation::build_prompt_batch(&PromptInput {
                old_overview: old.as_ref(),
                allowed_ids: &allowed,
                relevant_items: &relevant,
                corrections: &corrections,
                source_pages: &pages,
                prior_source_summary: conversation_data.as_ref().and_then(|(_, _, prior)| prior.as_ref()),
                prior_memory:&existing_memory,
                conversation: conversation_data.as_ref().map(|(_, conversation, _)| conversation),
            },&session_data.iter().map(|(_,conversation)|conversation.clone()).collect::<Vec<_>>())?;
            let budget = budget.as_ref().ok_or_else(|| AgentError::new(ErrorCode::RuntimeIncompatible,
                "Overview model capacity was not prepared"))?;
            budget.check(&prompt)?;
            let reserved = store.with_current(|binding, db| {
                active(db, binding, request, &batch.scope)?;
                db.overview_schedule_reserve(
                    binding,
                    &batch.scope,
                    &batch.batch_id,
                    prompt.len() as u32,
                    Utc::now(),
                )
            })?;
            if !reserved {
                return Err(AgentError::new(
                    ErrorCode::RunBusy,
                    "Knowledge maintenance yielded to foreground work",
                ));
            }
            let generated = model.generate(&batch.batch_id, &prompt, budget).await?;
            let refs: Vec<_> = evidence.iter().map(|v| v.reference().clone()).collect();
            let parsed_session = if session_data.is_empty() { None } else { Some(crate::overview_generation::parse_session_batch_delta(&generated.text,&allowed,&refs,&Utc::now().to_rfc3339(),&session_data.iter().map(|(_,conversation)|conversation.clone()).collect::<Vec<_>>())?) };
            let delta = if let Some(parsed) = &parsed_session { parsed.overview.clone() } else {
                crate::overview_generation::parse_delta(&generated.text, &allowed, &refs, &Utc::now().to_rfc3339())?
            };
            publish.model_profile_id = generated.model_profile_id;
            let memory_candidates=delta.memory_candidates;
            publish.upsert_items = delta.upsert_items;
            publish.remove_item_ids = delta.remove_item_ids;
            if let Some(summary) = delta.source_summary {
                // A document page and a contiguous conversation span each keep
                // their own node, so later pages cannot replace unread knowledge.
                let node_id = format!(
                    "source-{}",
                    if selected_sources.is_empty() {
                        hash(&(&batch.source.object_key, &batch.source_cursor))?
                    } else {
                        hash(&(&batch.source.object_key, &batch.source_cursor, &selected_sources))?
                    }
                );
                let previous = store
                    .with_current(|_, db| db.agent_knowledge_get(&batch.scope, &node_id, None))?;
                let expected_revision = previous.map_or(0, |v| v.revision);
                let session_summary = parsed_session.as_ref().map(|parsed|crate::overview_session::segment_batch(&session_data,&pages,batch.source_cursor.as_deref(),&node_id,expected_revision+1,&summary,parsed)).transpose()?;
                publish.knowledge_upserts.push(KnowledgeNodeWrite {
                    node_id,
                    expected_revision,
                    kind: KnowledgeKind::SourceSummary,
                    session_summary,
                    title: summary.title,
                    one_line: summary.one_line,
                    summary: summary.summary,
                    body_sections: summary.body_sections,
                    aliases: vec![],
                    keywords: summary.keywords,
                    source_refs: refs,
            published_sources: vec![],
                    epistemic_status: EpistemicStatus::Inferred,
                    coverage: SourceCoverage {
                        processed: pages.iter().filter(|page|page.complete).count() as u64,
                        partial: pages.iter().filter(|page|!page.complete).count() as u64,
                        excluded: 0,
                        unsupported: 0,
                        pending: pages.iter().filter(|page|!page.complete).count() as u64,
                    },
                    related: vec![],
                    memory: None,
                });
            }
            publish.knowledge_upserts.extend(memory_nodes(store,&batch.scope,memory_candidates,&Utc::now().to_rfc3339())?);
        }
        store.with_current(|binding, db| {
            active(db, binding, request, &batch.scope)?;
            db.agent_overview_maintenance_save_draft_many(
                binding,
                &batch.scope,
                &batch.batch_id,
                &publish,
                &progresses,
                Some(page_budget_chars),
                Utc::now(),
            )
        })?;
        publish
    };
    service
        .publish_checked(request, &publish, &evidence, |binding, db| {
            active(db, binding, request, &batch.scope)?;
            db.agent_overview_maintenance_validate_sources(request,binding,&batch.scope,&batch.batch_id)
        })
        .await?;
    complete(store, request, batch)
}
async fn process_published_batch<S:BoundSourceStore,M:OverviewModel>(
    store:&S,request:&RequestContext,batch:&OverviewMaintenanceBatch,model:&M)->AgentResult<()> {
    let service=OverviewService::new(store);
    let parent=batch.source_object.published().ok_or_else(||AgentError::new(ErrorCode::InvalidArgument,"Expected published input"))?;
    if let Some(draft)=&batch.draft {
        if store.with_current(|_,db|db.agent_overview_replay(&request.caller.key(),&request.request_id,draft))?.is_some() {
            return complete(store,request,batch);
        }
    }
    let mut proof=if batch.source.deleted || batch.source.excluded {None} else {
        match store.with_current(|binding,db| {
            active(db,binding,request,&batch.scope)?;
            crate::overview_evidence::CapturedPublishedItem::recapture(db,request,binding,parent)
        }) {
            Ok(proof)=>Some(proof),
            Err(error) if matches!(error.code,ErrorCode::SourceChanged|ErrorCode::ScopeDenied|ErrorCode::NotFound|ErrorCode::ObjectWithdrawn)=>None,
            Err(error)=>return Err(error),
        }
    };
    if let Some(captured)=&mut proof {
        match captured.prepare_files(store,request).await {
            Ok(())=>(),
            Err(error) if matches!(error.code,ErrorCode::SourceChanged|ErrorCode::ScopeDenied|ErrorCode::NotFound|ErrorCode::ObjectWithdrawn)=>proof=None,
            Err(error)=>return Err(error),
        }
    }
    let mut progress=batch.next_progress.clone().unwrap_or_else(||OverviewSourceProgress {
        object:batch.source_object.clone(),read_target:None,read_cursor:None,
        state:OverviewSourceState::Processed,handled_seq:batch.source.last_seq});
    let mut page_budget_chars=batch.source_page_budget_chars.unwrap_or(2000);
    let publish=if let Some(draft)=&batch.draft {draft.clone()} else {
        let (old,corrections)=store.with_current(|binding,db| {
            active(db,binding,request,&batch.scope)?;
            Ok((db.agent_overview_head(&batch.scope)?,db.agent_overview_corrections(&batch.scope)?))
        })?;
        let old_items=old.as_ref().map_or(&[][..],|snapshot|snapshot.items.as_slice());
        let mut allowed=AllowedAffectedIds {
            existing_ids:old_items.iter().map(|item|item.id.clone()).collect(),
            affected_ids:old_items.iter().filter(|item|item.published_sources.iter().any(|p|
                p.project_id==parent.project_id && p.item_id==parent.item_id)).map(|item|item.id.clone()).collect(),
        };
        loop {
            let before=allowed.affected_ids.len();
            allowed.affected_ids.extend(old_items.iter().filter(|item|item.dependency_item_ids.iter().any(|id|allowed.affected_ids.contains(id))).map(|item|item.id.clone()).collect::<Vec<_>>());
            if before==allowed.affected_ids.len(){break;}
        }
        let mut prepared=None;
        if let Some(captured)=&proof {
            let mut live_corrections=captured.corrections.clone();
            live_corrections.extend(corrections.items.iter().filter(|c|!c.deleted).cloned());
            let existing_memory=prior_memory(store,request,&batch.scope,std::slice::from_ref(&batch.source_object))?;
            let full_text=&captured.text;
            // Read existing Workspace understanding through the same visibility
            // gate as a user. This gives the model valid cross-Project context
            // without consuming any other Project's raw sources again.
            let mut relevant=Vec::new();
            let mut context_chars=0usize;
            for prior in old_items.iter().take(30) {
                if relevant.len()>=12 || context_chars>=4_000 {break;}
                let page=service.get(request,&crate::overview_service::OverviewReadInput {
                    scope:batch.scope.clone(),version:None,sections:vec![],
                    item_ids:vec![prior.id.clone()],cursor:None,budget_chars:Some(8_000),
                }).await?;
                if let Some(item)=page.items.into_iter().find(|item|item.item.id==prior.id && item.complete &&
                    matches!(item.item.valid_state,crate::agent::context::ValidState::Current)) {
                    let length=item.item.text.chars().count();
                    if context_chars+length<=4_000 {
                        context_chars+=length;relevant.push(item.item);
                    }
                }
            }
            let budget=model.prepare().await?;
            let offset=batch.source_cursor.as_deref().map(|s|s.parse::<usize>().map_err(|_|AgentError::new(ErrorCode::SourceChanged,"Invalid published cursor"))).transpose()?.unwrap_or(0);
            let total=full_text.chars().count();
            if offset>total {return Err(AgentError::new(ErrorCode::SourceChanged,"Published cursor exceeds item text"));}
            let prompt=loop {
                let page:String=full_text.chars().skip(offset).take(page_budget_chars).collect();
                let complete=offset+page.chars().count()>=total;
                let prompt=crate::overview_generation::build_published_prompt(&allowed,&relevant,&live_corrections,&existing_memory,&page,offset,complete)?;
                if budget.check(&prompt).is_ok() {
                    progress.state=if complete {OverviewSourceState::Processed} else {OverviewSourceState::Partial};
                    progress.read_cursor=(!complete).then(||(offset+page.chars().count()).to_string());
                    break prompt;
                }
                if page_budget_chars<=256 && !relevant.is_empty() {
                    relevant.pop();
                    continue;
                }
                if page_budget_chars<=1 {return Err(AgentError::new(ErrorCode::BudgetExceeded,"Published item metadata exceeds model input budget"));}
                page_budget_chars=(page_budget_chars/2).max(1);
            };
            prepared=Some((budget,prompt,relevant));
        }
        let coverage=store.with_current(|binding,db|db.agent_overview_maintenance_coverage_many(binding,&batch.scope,std::slice::from_ref(&progress)))?;
        let mut publish=OverviewPublishInput {scope:batch.scope.clone(),batch_id:batch.batch_id.clone(),
            expected_revision:batch.expected_revision,target_seq:batch.target_seq,
            policy_revision:batch.policy_revision,correction_revision:batch.correction_revision,
            expected_memory_epoch:batch.expected_memory_epoch,
            upsert_items:vec![],remove_item_ids:vec![],settled_object_keys:if progress.state==OverviewSourceState::Partial {vec![]} else {vec![batch.source.object_key.clone()]},
            knowledge_upserts:vec![],knowledge_removes:vec![],coverage,
            source_manifest_hash:hash(&(&batch.source,parent,&progress))?,model_profile_id:"native-metadata".into()};
        if let Some(proof)=&proof {
            // A stale old item must not be reintroduced to the model just to
            // change one parent. The native parent proof is the new evidence.
            let (budget,prompt,relevant)=prepared.ok_or_else(||AgentError::new(ErrorCode::IoFailed,"Published model capacity is missing"))?;
            let reserved=store.with_current(|binding,db| {
                active(db,binding,request,&batch.scope)?;
                db.overview_schedule_reserve(binding,&batch.scope,&batch.batch_id,prompt.len() as u32,Utc::now())
            })?;
            if !reserved {return Err(AgentError::new(ErrorCode::RunBusy,"Knowledge maintenance yielded to foreground work"));}
            let generated=model.generate(&batch.batch_id,&prompt,&budget).await?;
            let delta=crate::overview_generation::parse_published_delta(&generated.text,&allowed,
                std::slice::from_ref(&proof.reference),&Utc::now().to_rfc3339())?;
            let available:std::collections::HashSet<&str>=relevant.iter().map(|item|item.id.as_str())
                .chain(delta.upsert_items.iter().map(|item|item.id.as_str())).collect();
            if delta.upsert_items.iter().flat_map(|item|&item.dependency_item_ids)
                .any(|id|!available.contains(id.as_str())) {
                return Err(AgentError::new(ErrorCode::SourceChanged,"Workspace dependency is not currently visible"));
            }
            publish.model_profile_id=generated.model_profile_id;
            let memory_candidates=delta.memory_candidates;
            publish.upsert_items=delta.upsert_items;publish.remove_item_ids=delta.remove_item_ids;
            if let Some(summary)=delta.source_summary {
                let node_id=format!("{}{}",crate::agent::knowledge::published_node_prefix(parent.project_id,&parent.item_id),batch.source_cursor.as_deref().unwrap_or("0"));
                let previous=store.with_current(|_,db|db.agent_knowledge_get(&batch.scope,&node_id,None))?;
                publish.knowledge_upserts.push(KnowledgeNodeWrite {
                    node_id,expected_revision:previous.map_or(0,|n|n.revision),kind:KnowledgeKind::Topic,
                    title:summary.title,one_line:summary.one_line,summary:summary.summary,
                    body_sections:summary.body_sections,aliases:vec![],keywords:summary.keywords,
                    source_refs:vec![],published_sources:vec![proof.reference.clone()],
                    epistemic_status:EpistemicStatus::Inferred,coverage:SourceCoverage{processed:1,partial:0,excluded:0,unsupported:0,pending:0},
                    related:vec![],session_summary:None,
                    memory:None,
                });
            }
            publish.knowledge_upserts.extend(memory_nodes(store,&batch.scope,memory_candidates,&Utc::now().to_rfc3339())?);
        } else {
            publish.remove_item_ids=allowed.affected_ids.into_iter().collect();publish.remove_item_ids.sort();
            publish.knowledge_removes=store.with_current(|_,db|db.agent_published_knowledge_ids(parent.project_id,&parent.item_id))?;
        }
        store.with_current(|binding,db| {
            active(db,binding,request,&batch.scope)?;
            db.agent_overview_maintenance_save_draft_many(binding,&batch.scope,&batch.batch_id,&publish,
                std::slice::from_ref(&progress),Some(page_budget_chars),Utc::now())
        })?;
        publish
    };
    let proofs:Vec<_>=proof.into_iter().collect();
    service.publish_checked_with_parents(request,&publish,&[],&proofs,|binding,db| {
        active(db,binding,request,&batch.scope)?;
        let head=db.agent_overview_head(&batch.scope)?;
        let existing=head.as_ref().map_or(&[][..],|head|head.items.as_slice());
        let new_ids:std::collections::HashSet<_>=publish.upsert_items.iter().map(|item|item.id.as_str()).collect();
        let stale:std::collections::HashSet<_>=db.agent_overview_stale_items(&binding.workspace_id,&batch.scope)?.into_iter().collect();
        let mut todo:Vec<_>=publish.upsert_items.iter().flat_map(|item|&item.dependency_item_ids).cloned().collect();
        let mut checked=std::collections::HashSet::new();
        while let Some(id)=todo.pop() {
            if !checked.insert(id.clone()) || new_ids.contains(id.as_str()) {continue;}
            let prior=existing.iter().find(|item|item.id==id)
                .ok_or_else(||AgentError::new(ErrorCode::SourceChanged,"Workspace dependency disappeared"))?;
            if stale.contains(&id) || !matches!(prior.valid_state,crate::agent::context::ValidState::Current) {
                return Err(AgentError::new(ErrorCode::SourceChanged,"Workspace dependency is stale"));
            }
            for raw in &prior.source_refs {crate::agent::source_trace::derived_source_visible(db,request,binding,raw)?;}
            for parent in &prior.published_sources {crate::agent::source_trace::published_source_visible(db,request,binding,parent)?;}
            todo.extend(prior.dependency_item_ids.iter().cloned());
        }
        db.agent_overview_maintenance_validate_sources(request,binding,&batch.scope,&batch.batch_id)
    }).await?;
    complete(store,request,batch)
}

fn complete<S: BoundSourceStore>(
    store: &S,
    request: &RequestContext,
    batch: &OverviewMaintenanceBatch,
) -> AgentResult<()> {
    store.with_current(|binding, db| {
        request.authorize(binding, &batch.scope, "knowledge.write")?;
        let progress = db.agent_overview_maintenance_complete(
            binding,
            &batch.scope,
            &batch.batch_id,
            Utc::now(),
        )?;
        db.overview_schedule_finished(
            binding,
            &batch.scope,
            progress.pending_count > 0 || !progress.directory_complete,
            Utc::now(),
        )
    })
}

pub(crate) fn start(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let file = match crate::source_extraction_worker::SourceExtractionWorker::for_app(&app) {
            Ok(file) => file,
            Err(error) => {
                eprintln!("Knowledge maintenance unavailable: {:?}", error.code);
                return;
            }
        };
        let record = crate::record_document_service::AppDocumentUtility(app.clone());
        loop {
            let state = app.state::<crate::AppState>();
            let selected = state.with_current(|binding, db| {
                db.agent_overview_maintenance_resume_waiting(binding, Utc::now())?;
                Ok(db
                    .overview_schedule_next(binding, Utc::now())?
                    .map(|scope| (binding.clone(), scope)))
            });
            if let Ok(Some((binding, scope))) = selected {
                let mut request = request(
                    binding.clone(),
                    &scope,
                    format!("overview-inventory-{:032x}", rand::random::<u128>()),
                );
                if matches!(scope,Scope::Workspace) {
                    let granted=(*state).with_current(|binding,db| {
                        if binding!=&request.binding {return Err(AgentError::new(ErrorCode::WorkspaceChanged,"Workspace changed"));}
                        db.agent_active_project_ids()
                    });
                    let Ok(project_ids)=granted else {continue};
                    request.scope_grant.workspace_content=true;
                    request.scope_grant.project_ids=project_ids;
                }
                let model = crate::overview_model::AppOverviewModel::new(app.clone(), binding);
                let runtime = crate::lock_mutex(&state.current_workspace).clone();
                let Some(runtime) = runtime.filter(|runtime| runtime.agent_binding == request.binding) else { continue; };
                let history = crate::source_session_read::archival::ArchivalHistory::new(
                    &*state, &request, runtime.paths.root_path.clone());
                if let Err(error) = step(&*state, &request, &scope, &record, &file, &model, &history).await {
                    if !matches!(
                        error.code,
                        ErrorCode::Cancelled
                            | ErrorCode::RunBusy
                            | ErrorCode::WorkspaceChanged
                            | ErrorCode::WorkspaceNotOpen
                    ) {
                        eprintln!("Knowledge maintenance paused: {:?}", error.code);
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
}

#[cfg(test)]
#[path = "overview_maintenance_tests.rs"]
mod tests;
