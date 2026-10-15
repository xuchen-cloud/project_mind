//! Session summary source adapter over immutable knowledge node revisions.
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        knowledge::{KnowledgeKind, KnowledgeNode},
        models::{ObjectKind, ObjectRef, SourceLocator, SourceRef, WorkspaceBinding},
        source_trace::derived_source_visible,
    },
    db::Database,
    source_search_index::{IndexCoverage, SearchCandidate, SearchPage},
    source_service::{
        BoundSourceStore, SourceReadInput, SourceReadPage, SourceReadView, SourceSearchInput,
    },
};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SupersedingSummary {
    pub node_id: String,
    pub revision: u64,
}

fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn unavailable(code: ErrorCode) -> bool {
    matches!(
        code,
        ErrorCode::NotFound
            | ErrorCode::ScopeDenied
            | ErrorCode::ObjectWithdrawn
            | ErrorCode::SourceNotReady
            | ErrorCode::SourceChanged
            | ErrorCode::FileChangedUnregistered
    )
}
fn object(binding: &WorkspaceBinding, node: &KnowledgeNode) -> ObjectRef {
    ObjectRef {
        workspace_id: binding.workspace_id.clone(),
        scope: node.scope.clone(),
        kind: ObjectKind::SessionSummary,
        id: node.node_id.clone(),
    }
}
fn reference(binding: &WorkspaceBinding, node: &KnowledgeNode) -> SourceRef {
    let locator = node.source_refs.first().and_then(|first| {
        let SourceLocator::Messages {
            session_id,
            branch_id,
            start_message_id,
            ..
        } = first.locator.as_ref()?
        else {
            return None;
        };
        let end = node.source_refs.last()?.locator.as_ref()?;
        let SourceLocator::Messages {
            session_id: last_session,
            branch_id: last_branch,
            end_message_id,
            ..
        } = end
        else {
            return None;
        };
        (session_id == last_session && branch_id == last_branch).then(|| SourceLocator::Messages {
            session_id: session_id.clone(),
            branch_id: branch_id.clone(),
            start_message_id: start_message_id.clone(),
            end_message_id: end_message_id.clone(),
        })
    });
    SourceRef {
        object: object(binding, node),
        revision: node.revision.to_string(),
        file_version: None,
        record_version: None,
        block_id: None,
        locator,
        title: node.title.clone(),
        excerpt: node.one_line.clone(),
    }
}
pub(crate) fn visible(
    db: &Database,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    node: &KnowledgeNode,
) -> AgentResult<bool> {
    if node.kind != KnowledgeKind::SourceSummary || node.session_summary.is_none() {
        return Ok(false);
    }
    request.authorize(binding, &node.scope, "source.read")?;
    request.authorize(binding, &node.scope, "session.read")?;
    match db.source_read_object(request, binding, &object(binding, node)) {
        Ok(_) => (),
        Err(error) if unavailable(error.code) => return Ok(false),
        Err(error) => return Err(error),
    }
    for source in node.source_refs.iter().chain(
        node.session_summary
            .as_ref()
            .unwrap()
            .statements
            .iter()
            .flat_map(|s| s.source_refs.iter()),
    ) {
        match derived_source_visible(db, request, binding, source) {
            Ok(_) => (),
            Err(error) if unavailable(error.code) => return Ok(false),
            Err(error) => return Err(error),
        }
    }
    Ok(true)
}

pub(crate) fn superseded_by(
    db: &Database,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    node: &KnowledgeNode,
) -> AgentResult<Vec<SupersedingSummary>> {
    let Some(segment) = node.session_summary.as_ref() else {
        return Ok(vec![]);
    };
    if !visible(db, request, binding, node)? {
        return Err(AgentError::new(
            ErrorCode::ScopeDenied,
            "Session summary evidence is unavailable",
        ));
    }
    let successors =
        db.agent_session_summary_successors(&node.scope, &segment.session_id, &node.node_id)?;
    let mut visible_successors = Vec::new();
    for successor in successors {
        if visible(db, request, binding, &successor)? {
            visible_successors.push(SupersedingSummary {
                node_id: successor.node_id,
                revision: successor.revision,
            });
        }
    }
    Ok(visible_successors)
}

pub(crate) fn search(
    db: &Database,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    input: &SourceSearchInput,
) -> AgentResult<SearchPage> {
    request.authorize(binding, &input.scope, "source.read")?;
    request.authorize(binding, &input.scope, "session.read")?;
    if input.query.trim().is_empty() || input.query.chars().count() > 256 {
        return Err(invalid("Session summary search requires a bounded query"));
    }
    let limit = input.limit.unwrap_or(8);
    if !(1..=50).contains(&limit) {
        return Err(invalid("Invalid source search limit"));
    }
    for selected in &input.selected {
        if selected.workspace_id != binding.workspace_id || selected.scope != input.scope {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Selected source is outside this search scope",
            ));
        }
        selected.key()?;
    }
    let selected: Vec<_> = input
        .selected
        .iter()
        .filter(|o| o.kind == ObjectKind::SessionSummary)
        .collect();
    let explicit_selection = !input.selected.is_empty();
    let mut items = Vec::new();
    let mut after = None;
    let mut scanned = 0;
    loop {
        let batch = (200 - scanned).min(50) as u16;
        if batch == 0 {
            break;
        }
        let nodes = db.agent_knowledge_candidates(
            &input.scope,
            &input.query,
            &[KnowledgeKind::SourceSummary],
            after.as_deref(),
            batch,
        )?;
        let count = nodes.len();
        for node in nodes {
            scanned += 1;
            after = Some(node.node_id.clone());
            if node.session_summary.is_none()
                || (explicit_selection && !selected.iter().any(|o| o.id == node.node_id))
                || !visible(db, request, binding, &node)?
            {
                continue;
            }
            let mut source_ref = reference(binding, &node);
            let superseded = !superseded_by(db, request, binding, &node)?.is_empty();
            let excerpt = if superseded {
                format!("历史结论（已替代）：{}", node.one_line)
            } else {
                node.one_line.clone()
            };
            source_ref.excerpt = excerpt.chars().take(2000).collect();
            items.push(SearchCandidate {
                object_key: source_ref.object.key()?,
                title: node.title.chars().take(1000).collect(),
                excerpt: source_ref.excerpt.clone(),
                score: 1.0,
                source_ref,
                coverage: IndexCoverage {
                    chars: node.summary.chars().count() as u32,
                    complete: true,
                },
            });
            if items.len() > limit {
                break;
            }
        }
        if items.len() > limit || count < batch as usize {
            break;
        }
    }
    let has_more = items.len() > limit || scanned == 200;
    items.truncate(limit);
    Ok(SearchPage { items, has_more })
}

pub(crate) fn read<S: BoundSourceStore>(
    store: &S,
    request: &RequestContext,
    input: &SourceReadInput,
) -> AgentResult<SourceReadPage> {
    if input.source.object.kind != ObjectKind::SessionSummary
        || input.view != SourceReadView::Full
        || input.selection.is_some()
        || input.source.file_version.is_some()
        || input.source.record_version.is_some()
    {
        return Err(invalid("Session summary requires a full source read"));
    }
    let revision = input
        .source
        .revision
        .as_ref()
        .map(|s| {
            s.parse::<u64>()
                .ok()
                .filter(|v| *v > 0)
                .ok_or_else(|| invalid("Invalid session summary revision"))
        })
        .transpose()?;
    let node = store.with_current(|binding, db| {
        db.source_read_object(request, binding, &input.source.object)?;
        let node = db
            .agent_knowledge_get(
                &input.source.object.scope,
                &input.source.object.id,
                revision,
            )?
            .ok_or_else(|| AgentError::new(ErrorCode::NotFound, "Session summary not found"))?;
        if !visible(db, request, binding, &node)? {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Session summary evidence is unavailable",
            ));
        }
        let superseded = superseded_by(db, request, binding, &node)?;
        Ok((node, binding.clone(), superseded))
    })?;
    let (node, binding, superseded) = node;
    let mut value = serde_json::to_value(node.session_summary.as_ref().unwrap())
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot encode session summary"))?;
    value.as_object_mut().unwrap().insert(
        "supersededBy".into(),
        serde_json::to_value(&superseded).map_err(|_| {
            AgentError::new(ErrorCode::IoFailed, "Cannot encode session successors")
        })?,
    );
    let text = serde_json::to_string(&value)
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot encode session summary"))?;
    let body_hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    let inner_cursor = input
        .cursor
        .as_ref()
        .map(|cursor| {
            let (expected, inner) = cursor
                .split_once(':')
                .ok_or_else(|| invalid("Invalid session summary cursor"))?;
            if expected.len() != 64
                || !expected.bytes().all(|byte| byte.is_ascii_hexdigit())
                || inner.is_empty()
            {
                return Err(invalid("Invalid session summary cursor"));
            }
            if expected != body_hash {
                return Err(AgentError::new(
                    ErrorCode::SourceChanged,
                    "Session summary successor state changed",
                ));
            }
            Ok(inner.to_string())
        })
        .transpose()?;
    let mut inner_input = input.clone();
    inner_input.cursor = inner_cursor;
    let budget = input.budget_chars.unwrap_or(4000).min(12000);
    inner_input.budget_chars = Some(
        budget
            .checked_sub(65)
            .filter(|budget| *budget > 0)
            .ok_or_else(|| {
                AgentError::new(
                    ErrorCode::BudgetExceeded,
                    "Session summary read budget is too small",
                )
            })?,
    );
    let mut page = crate::source_text_page::paginate(
        &inner_input,
        reference(&binding, &node),
        &text,
        &[],
        crate::source_text_page::decode_cursor(&inner_input)?,
        None,
    )?;
    page.next_cursor = page
        .next_cursor
        .take()
        .map(|cursor| format!("{body_hash}:{cursor}"));
    store.with_current(|current, db| {
        db.source_read_object(request, current, &input.source.object)?;
        let verified = db
            .agent_knowledge_get(&node.scope, &node.node_id, Some(node.revision))?
            .ok_or_else(|| AgentError::new(ErrorCode::SourceChanged, "Session summary changed"))?;
        if !visible(db, request, current, &verified)? {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Session summary evidence is unavailable",
            ));
        }
        if superseded_by(db, request, current, &verified)? != superseded {
            return Err(AgentError::new(
                ErrorCode::SourceChanged,
                "Session summary successor state changed",
            ));
        }
        Ok(page)
    })
}
