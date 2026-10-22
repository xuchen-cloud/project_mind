//! Session-specific inputs for the existing bounded Overview maintenance batch.
use crate::{
    agent::{
        access::RequestContext,
        context::OverviewItem,
        errors::{AgentResult, ErrorCode},
        models::{MessageRef, ObjectKind},
        operations::OperationListInput,
        sessions::SessionSummarySegment,
    },
    db::agent_session_model_search::SourceReadRecord,
    overview_generation::{ConversationEvidence, ParsedSessionDelta},
    source_service::{BoundSourceStore, SourceReadTarget},
};

pub(crate) fn input<S: BoundSourceStore>(
    store: &S,
    request: &RequestContext,
    target: &SourceReadTarget,
) -> AgentResult<
    Option<(
        SourceReadRecord,
        ConversationEvidence,
        Option<crate::agent::knowledge::KnowledgeNode>,
    )>,
> {
    if target.object.kind != ObjectKind::SessionMessage {
        return Ok(None);
    }
    store.with_current(|binding, db| {
        let record = match db.source_session_record(request, binding, target) {
            Ok(record) => record,
            // Legacy mixed messages and currently hidden sources have no AI
            // evidence. Mark this batch unavailable, without blocking others.
            Err(error)
                if matches!(error.code, ErrorCode::NotFound | ErrorCode::ObjectWithdrawn) =>
            {
                return Ok(None)
            }
            Err(error) => return Err(error),
        };
        let (run_state, mut operations) = match record.run_id.as_deref() {
            Some(id) => (
                Some(db.agent_run_get(request, binding, id)?.state),
                db.agent_operation_list(
                    request,
                    binding,
                    &OperationListInput {
                        run_id: id.into(),
                        cursor: None,
                        limit: 50,
                    },
                )?
                .operations,
            ),
            None => (None, vec![]),
        };
        let mut visible = Vec::new();
        for operation in operations.drain(..) {
            match db.source_read_object(request, binding, &operation.object) {
                Ok(_) => visible.push(operation),
                Err(error)
                    if matches!(
                        error.code,
                        ErrorCode::NotFound
                            | ErrorCode::ScopeDenied
                            | ErrorCode::ObjectWithdrawn
                            | ErrorCode::SourceNotReady
                    ) =>
                {
                    ()
                }
                Err(error) => return Err(error),
            }
        }
        let mut allowed_supersedes_summary_ids = Vec::new();
        let mut prior_summary = None;
        for node in db.agent_session_summary_list(&record.scope, &record.session_id, 100)? {
            let authorized = crate::source_session_summary::visible(db, request, binding, &node)?;
            if authorized
                && node
                    .source_refs
                    .iter()
                    .any(|source| source.object.kind == ObjectKind::SessionMessage)
            {
                for source in &node.source_refs {
                    if db.agent_session_message_precedes(
                        &record.session_id,
                        &source.object.id,
                        &record.message_id,
                    )? {
                        allowed_supersedes_summary_ids.push(node.node_id.clone());
                        if prior_summary.is_none() {
                            prior_summary = Some(node.clone());
                        }
                        break;
                    }
                }
            }
        }
        let conversation = ConversationEvidence {
            message_ref: MessageRef {
                workspace_id: binding.workspace_id.clone(),
                scope: record.scope.clone(),
                session_id: record.session_id.clone(),
                branch_id: record.runtime_entry_id.clone(),
                message_id: record.message_id.clone(),
                ordinal: record.ordinal,
                content_hash: record.text_hash.clone(),
            },
            role: record.role.clone(),
            run_state,
            operations: visible,
            allowed_supersedes_summary_ids,
        };
        Ok(Some((record, conversation, prior_summary)))
    })
}

pub(crate) fn predecessors<S: BoundSourceStore>(
    store: &S,
    record: &SourceReadRecord,
    items: &[OverviewItem],
) -> AgentResult<Vec<String>> {
    store.with_current(|_, db| {
        let mut ids = Vec::new();
        for item in items {
            for source in &item.source_refs {
                if source.object.kind == ObjectKind::SessionMessage
                    && db.agent_session_message_precedes(
                        &record.session_id,
                        &source.object.id,
                        &record.message_id,
                    )?
                {
                    ids.push(item.id.clone());
                    break;
                }
            }
        }
        Ok(ids)
    })
}

pub(crate) fn segment_batch(
    messages: &[(SourceReadRecord,ConversationEvidence)],
    pages: &[crate::source_service::SourceReadPage],
    cursor: Option<&str>,
    node_id: &str,
    revision: u64,
    summary: &crate::overview_generation::SourceSummaryContent,
    parsed: &ParsedSessionDelta,
) -> AgentResult<SessionSummarySegment> {
    use sha2::{Digest,Sha256};
    let (first,_) = messages.first().ok_or_else(||crate::agent::errors::AgentError::new(ErrorCode::InvalidArgument,"Session batch is empty"))?;
    let (last,_) = messages.last().unwrap();
    let first_page=&pages[0];
    let last_page=pages.last().unwrap();
    let start=crate::source_session_read::history_cursor_offset(cursor,first)? as usize;
    let end=if messages.len()==1 { start+first_page.text.chars().count() } else { last_page.text.chars().count() };
    let split=messages.len()==1 && (start!=0 || end!=first.total_chars as usize);
    let identities=serde_json::to_vec(&messages.iter().map(|(record,_)|(&record.message_id,&record.text_hash)).collect::<Vec<_>>())
        .map_err(|_|crate::agent::errors::AgentError::new(ErrorCode::InvalidArgument,"Cannot encode session source identities"))?;
    let input_hash=format!("sha256:{:x}",Sha256::digest(identities));
    Ok(SessionSummarySegment {
        id:node_id.into(),session_id:first.session_id.clone(),branch_id:last.runtime_entry_id.clone(),revision,
        start_entry_id:first.runtime_entry_id.clone(),end_entry_id:last.runtime_entry_id.clone(),
        start_char:split.then_some(start),end_char:split.then_some(end),
        summary:summary.summary.clone(),topics:summary.keywords.clone(),statements:parsed.statements.clone(),
        artifact_refs:messages.iter().flat_map(|(_,conversation)|conversation.operations.iter()).filter(|operation|parsed.statements.iter().any(|statement|statement.operation_receipt_id.as_deref()==Some(operation.operation_id.as_str()))).map(|operation|operation.object.clone()).collect(),
        supersedes:parsed.supersedes.clone(),input_hash,
    })
}
