//! One bounded, durable Project knowledge batch. Inventory, reads and model
//! generation use their existing services; only a validated draft is published.
use crate::{
    agent::{
        access::{Caller, RequestContext, ScopeGrant},
        context::{EpistemicStatus, SourceCoverage},
        errors::{AgentError, AgentResult, ErrorCode},
        knowledge::{KnowledgeKind, KnowledgeNodeWrite},
        models::{ObjectKind, Scope, WorkspaceBinding},
        overview::OverviewPublishInput,
        settings::SettingsRepository,
    },
    db::{
        overview_maintenance::{
            OverviewMaintenanceBatch, OverviewSourceProgress, OverviewSourceState,
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
}
pub(crate) fn status<S: BoundSourceStore>(
    store: &S,
    request: &RequestContext,
    scope: &Scope,
) -> AgentResult<OverviewMaintenanceView> {
    store.with_current(|binding, db| {
        request.authorize(binding, scope, "settings.read")?;
        Ok(OverviewMaintenanceView {
            progress: db.agent_overview_maintenance_status(binding, scope)?,
            schedule: db.overview_schedule_status(binding, scope, Utc::now())?,
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
                if !db.agent_settings_get(scope)?.enabled {
                    return Err(AgentError::new(
                        ErrorCode::ScopeDenied,
                        "Enable this Project assistant first",
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
    if progress.cancelled || !db.agent_settings_get(scope)?.enabled {
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

/// One source page per publish keeps model input bounded, including a single
/// large document. Its next cursor is committed only after the version exists.
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
    if let Err(error) = &result {
        if !matches!(
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
    let mut evidence = vec![];
    let mut pages = vec![];
    let mut progress = OverviewSourceProgress {
        object: batch.source_object.clone(),
        read_target: None,
        read_cursor: None,
        state: OverviewSourceState::Processed,
        handled_seq: batch.source.last_seq,
    };
    let conversation_data = if !batch.source.deleted && !batch.source.excluded {
        crate::overview_session::input(store, request, &batch.source_read_target.clone().unwrap_or(SourceReadTarget {
            object: batch.source_object.clone(), revision: None, record_version: None, file_version: None,
        }))?
    } else { None };
    if batch.source.deleted {
        progress.state = OverviewSourceState::Deleted;
    } else if batch.source.excluded {
        progress.state = OverviewSourceState::Excluded;
    } else if batch.source_object.kind == ObjectKind::SessionSummary {
        // Summary policy events are metadata invalidations. Its original
        // messages own generation; never summarize a summary again.
        progress.state = OverviewSourceState::Processed;
    } else if batch.source_object.kind == ObjectKind::SessionMessage && conversation_data.is_none() {
        progress.state = OverviewSourceState::Unsupported;
    } else {
        let target = batch
            .source_read_target
            .clone()
            .unwrap_or(SourceReadTarget {
                object: batch.source_object.clone(),
                revision: None,
                record_version: None,
                file_version: None,
            });
        let input = SourceReadInput {
            source: target,
            view: SourceReadView::Full,
            selection: None,
            cursor: batch.source_cursor.clone(),
            budget_chars: Some(12000),
        };
        let (page, proof) = if batch.source_object.kind == ObjectKind::SessionMessage {
            crate::overview_evidence::capture_session(store, request, &input, history).await?
        } else {
            crate::overview_evidence::capture(store, request, &input, record, file).await?
        };
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
    let publish = if let Some(draft) = &batch.draft {
        draft.clone()
    } else {
        let (mut old, corrections, coverage) = store.with_current(|binding, db| {
            active(db, binding, request, &batch.scope)?;
            Ok((
                db.agent_overview_head(&batch.scope)?,
                db.agent_overview_corrections(&batch.scope)?,
                db.agent_overview_maintenance_coverage(binding, &batch.scope, Some(&progress))?,
            ))
        })?;
        // Keep all IDs for collision checks, but never send hidden historical
        // knowledge back to the model through the previous Overview context.
        let existing_ids = old
            .iter()
            .flat_map(|snapshot| &snapshot.items)
            .map(|item| item.id.clone())
            .collect();
        if !pages.is_empty()
            && batch.source_object.kind != ObjectKind::Project
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
                        .any(|source| source.object == batch.source_object)
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
        let mut publish = OverviewPublishInput {
            scope: batch.scope.clone(),
            batch_id: batch.batch_id.clone(),
            expected_revision: batch.expected_revision,
            target_seq: batch.target_seq,
            policy_revision: batch.policy_revision,
            correction_revision: batch.correction_revision,
            upsert_items: vec![],
            remove_item_ids: vec![],
            settled_object_keys: if progress.state == OverviewSourceState::Partial {
                vec![]
            } else {
                vec![batch.source.object_key.clone()]
            },
            knowledge_upserts: vec![],
            knowledge_removes: vec![],
            coverage,
            source_manifest_hash: hash(&(&batch.source, &progress))?,
            model_profile_id: "native-metadata".into(),
        };
        if pages.is_empty() || (pages[0].complete && pages[0].text.trim().is_empty()) {
            publish.remove_item_ids = allowed.affected_ids.iter().cloned().collect();
            publish.remove_item_ids.sort();
        } else if batch.source_object.kind != ObjectKind::Project
            && !pages[0].text.trim().is_empty()
        {
            let relevant: Vec<_> = old_items
                .iter()
                .filter(|item| allowed.affected_ids.contains(&item.id))
                .cloned()
                .collect();
            let corrections: Vec<_> = corrections
                .items
                .into_iter()
                .filter(|item| !item.deleted)
                .collect();
            let prompt = crate::overview_generation::build_prompt(&PromptInput {
                old_overview: old.as_ref(),
                allowed_ids: &allowed,
                relevant_items: &relevant,
                corrections: &corrections,
                source_pages: &pages,
                prior_source_summary: conversation_data.as_ref().and_then(|(_, _, prior)| prior.as_ref()),
                conversation: conversation_data.as_ref().map(|(_, conversation, _)| conversation),
            })?;
            model.ready()?;
            let reserved = store.with_current(|binding, db| {
                active(db, binding, request, &batch.scope)?;
                db.overview_schedule_reserve(
                    binding,
                    &batch.scope,
                    &batch.batch_id,
                    prompt.chars().count() as u32,
                    Utc::now(),
                )
            })?;
            if !reserved {
                return Err(AgentError::new(
                    ErrorCode::RateLimited,
                    "Knowledge maintenance budget is exhausted",
                ));
            }
            let generated = model.generate(&batch.batch_id, &prompt).await?;
            let refs: Vec<_> = evidence.iter().map(|v| v.reference().clone()).collect();
            let parsed_session = conversation_data.as_ref().map(|(_, conversation, _)| {
                crate::overview_generation::parse_session_delta(&generated.text, &allowed, &refs, &Utc::now().to_rfc3339(), conversation)
            }).transpose()?;
            let delta = if let Some(parsed) = &parsed_session { parsed.overview.clone() } else {
                crate::overview_generation::parse_delta(&generated.text, &allowed, &refs, &Utc::now().to_rfc3339())?
            };
            publish.model_profile_id = generated.model_profile_id;
            publish.upsert_items = delta.upsert_items;
            publish.remove_item_ids = delta.remove_item_ids;
            if let Some(summary) = delta.source_summary {
                // Each retained source page has its own summary; processing page
                // two cannot silently replace the unread knowledge from page one.
                let node_id = format!(
                    "source-{}",
                    hash(&(&batch.source.object_key, &batch.source_cursor))?
                );
                let previous = store
                    .with_current(|_, db| db.agent_knowledge_get(&batch.scope, &node_id, None))?;
                let expected_revision = previous.map_or(0, |v| v.revision);
                let session_summary = match (&conversation_data, &parsed_session) {
                    (Some((record, conversation, _)), Some(parsed)) => Some(crate::overview_session::segment(record, batch.source_cursor.as_deref(), &pages[0].text, &node_id, expected_revision + 1, &summary, parsed, conversation)?),
                    _ => None,
                };
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
                    epistemic_status: EpistemicStatus::Inferred,
                    coverage: SourceCoverage {
                        processed: u64::from(pages[0].complete),
                        partial: u64::from(!pages[0].complete),
                        excluded: 0,
                        unsupported: 0,
                        pending: u64::from(!pages[0].complete),
                    },
                    related: vec![],
                });
            }
        }
        store.with_current(|binding, db| {
            active(db, binding, request, &batch.scope)?;
            db.agent_overview_maintenance_save_draft(
                binding,
                &batch.scope,
                &batch.batch_id,
                &publish,
                &progress,
                Utc::now(),
            )
        })?;
        publish
    };
    service
        .publish_checked(request, &publish, &evidence, |binding, db| {
            active(db, binding, request, &batch.scope)
        })
        .await?;
    complete(store, request, batch)
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
                let request = request(
                    binding.clone(),
                    &scope,
                    format!("overview-inventory-{:032x}", rand::random::<u128>()),
                );
                let model = crate::overview_model::AppOverviewModel::new(app.clone(), binding);
                let runtime = crate::lock_mutex(&state.current_workspace).clone();
                let Some(runtime) = runtime.filter(|runtime| runtime.agent_binding == request.binding) else { continue; };
                let history = crate::agent::model_history::AppSessionHistoryUtility { app: app.clone(), runtime };
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
