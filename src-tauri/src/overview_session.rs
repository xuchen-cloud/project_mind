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

pub(crate) fn segment(
    record: &SourceReadRecord,
    cursor: Option<&str>,
    page_text: &str,
    node_id: &str,
    revision: u64,
    summary: &crate::overview_generation::SourceSummaryContent,
    parsed: &ParsedSessionDelta,
    conversation: &ConversationEvidence,
) -> AgentResult<SessionSummarySegment> {
    use sha2::{Digest, Sha256};
    let start = crate::agent::model_history::history_cursor_offset(cursor, record)? as usize;
    let end = start + page_text.chars().count();
    let split = start != 0 || end != record.total_chars as usize;
    Ok(SessionSummarySegment {
        id: node_id.into(),
        session_id: record.session_id.clone(),
        branch_id: record.runtime_entry_id.clone(),
        revision,
        start_entry_id: record.runtime_entry_id.clone(),
        end_entry_id: record.runtime_entry_id.clone(),
        start_char: split.then_some(start),
        end_char: split.then_some(end),
        summary: summary.summary.clone(),
        topics: summary.keywords.clone(),
        statements: parsed.statements.clone(),
        artifact_refs: conversation
            .operations
            .iter()
            .filter(|operation| {
                parsed.statements.iter().any(|statement| {
                    statement.operation_receipt_id.as_deref()
                        == Some(operation.operation_id.as_str())
                })
            })
            .map(|operation| operation.object.clone())
            .collect(),
        supersedes: parsed.supersedes.clone(),
        input_hash: format!(
            "sha256:{:x}",
            Sha256::digest(
                format!("{}:{}:{start}:{end}", record.message_id, record.text_hash).as_bytes()
            )
        ),
    })
}
