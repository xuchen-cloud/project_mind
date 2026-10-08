//! Selective, source-authorized knowledge reads; related nodes are navigation only.
use crate::{
    agent::{
        access::RequestContext,
        context::{serialized_chars, EpistemicStatus, SourceCoverage, ValidState},
        errors::{AgentError, AgentResult, ErrorCode},
        knowledge::{KnowledgeKind, KnowledgeNode, KnowledgeRelation},
        models::{Scope, SourceRef, WorkspaceBinding},
        overview::validate_id,
        repository::ContextRepository,
        settings::SettingsRepository,
    },
    db::Database,
    overview_evidence::{reference_file_plan, reference_state, FileReferenceProof},
    source_service::BoundSourceStore,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum KnowledgeView {
    Outline,
    #[default]
    Summary,
    Content,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KnowledgeGetInput {
    pub scope: Scope,
    pub node_id: String,
    pub version: Option<u64>,
    #[serde(default)]
    pub view: KnowledgeView,
    #[serde(default)]
    pub section_ids: Vec<String>,
    pub cursor: Option<String>,
    pub budget_chars: Option<usize>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeReadSection {
    pub id: String,
    pub title: String,
    pub text: Option<String>,
    pub text_offset: usize,
    pub complete: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeRelatedCard {
    pub node_id: String,
    pub revision: u64,
    pub kind: String,
    pub title: String,
    pub one_line: String,
    pub relation: KnowledgeRelation,
    pub reason: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeGetPage {
    pub scope: Scope,
    pub node_id: String,
    pub kind: String,
    pub revision: u64,
    pub title: String,
    pub view: KnowledgeView,
    pub summary: Option<String>,
    pub summary_offset: usize,
    pub sections: Vec<KnowledgeReadSection>,
    pub source_refs: Vec<SourceRef>,
    pub related: Vec<KnowledgeRelatedCard>,
    pub coverage: SourceCoverage,
    pub stale: bool,
    pub epistemic_status: EpistemicStatus,
    pub valid_state: ValidState,
    pub next_cursor: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KnowledgeSearchInput {
    pub scope: Scope,
    pub query: String,
    #[serde(default)]
    pub kinds: Vec<KnowledgeKind>,
    pub cursor: Option<String>,
    pub limit: Option<u16>,
    pub budget_chars: Option<usize>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeSearchCard {
    pub node_id: String,
    pub title: String,
    pub snippet: String,
    pub kind: String,
    pub revision: u64,
    pub stale: bool,
    pub epistemic_status: EpistemicStatus,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeSearchPage {
    pub scope: Scope,
    pub items: Vec<KnowledgeSearchCard>,
    pub next_cursor: Option<String>,
    pub source_fallback_required: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadCursor {
    s: Scope,
    n: String,
    r: u64,
    q: String,
    v: String,
    i: usize,
    o: usize,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchCursor {
    s: Scope,
    q: String,
    r: u64,
    a: String,
    h: bool,
}
fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn changed() -> AgentError {
    AgentError::new(
        ErrorCode::SourceChanged,
        "Knowledge or visible evidence changed; restart reading",
    )
}
fn missing() -> AgentError {
    AgentError::new(ErrorCode::NotFound, "Knowledge node is not available")
}
fn unavailable(error: &AgentError) -> bool {
    matches!(
        error.code,
        ErrorCode::NotFound
            | ErrorCode::ObjectWithdrawn
            | ErrorCode::ScopeDenied
            | ErrorCode::SourceNotReady
            | ErrorCode::SourceChanged
            | ErrorCode::FileChangedUnregistered
    )
}
fn hash(value: &impl Serialize) -> AgentResult<String> {
    let bytes = serde_json::to_vec(value).map_err(|_| invalid("Invalid knowledge selection"))?;
    Ok(format!("{:x}", Sha256::digest(bytes))[..32].to_string())
}
fn encode(value: &impl Serialize) -> AgentResult<String> {
    serde_json::to_vec(value)
        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
        .map_err(|_| invalid("Invalid knowledge cursor"))
}
fn decode<T: serde::de::DeserializeOwned>(cursor: &str) -> AgentResult<T> {
    if cursor.len() > 4096 {
        return Err(invalid("Invalid knowledge cursor"));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| invalid("Invalid knowledge cursor"))?;
    serde_json::from_slice(&bytes).map_err(|_| invalid("Invalid knowledge cursor"))
}
fn kind(kind: KnowledgeKind) -> String {
    match kind {
        KnowledgeKind::Topic => "topic",
        KnowledgeKind::Decision => "decision",
        KnowledgeKind::SourceSummary => "source_summary",
    }
    .into()
}
fn authorize(
    db: &Database,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    scope: &Scope,
) -> AgentResult<RequestContext> {
    request.authorize(binding, scope, "context.read")?;
    if !matches!(scope, Scope::Project { .. }) {
        return Err(AgentError::new(
            ErrorCode::SourceNotReady,
            "Workspace knowledge awaits M2",
        ));
    }
    let identity = crate::db::agent::WorkspaceContextRepository {
        db,
        workspace_name: "",
    }
    .scope_identity(scope)?
    .ok_or_else(missing)?;
    if identity.archived {
        return Err(AgentError::new(
            ErrorCode::ScopeDenied,
            "Archived Project knowledge is unavailable",
        ));
    }
    let mut source_request = request.clone();
    if !source_request
        .scope_grant
        .operations
        .iter()
        .any(|op| op == "source.read")
    {
        source_request
            .scope_grant
            .operations
            .push("source.read".into());
    }
    Ok(source_request)
}
fn visible_metadata(
    db: &Database,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    node: &KnowledgeNode,
) -> AgentResult<bool> {
    for reference in &node.source_refs {
        match db.source_read_object(request, binding, &reference.object) {
            Ok(_) => (),
            Err(error) if unavailable(&error) => return Ok(false),
            Err(error) => return Err(error),
        }
    }
    Ok(true)
}
fn dirty(db: &Database, binding: &WorkspaceBinding, node: &KnowledgeNode) -> AgentResult<bool> {
    let (policy, corrections) =
        db.agent_knowledge_baselines(&node.scope, &node.node_id, node.revision)?;
    Ok(matches!(node.valid_state, ValidState::Stale)
        || policy != db.agent_settings_get(&node.scope)?.revision
        || corrections != db.agent_overview_corrections(&node.scope)?.revision
        || !db
            .agent_knowledge_stale_ids(&binding.workspace_id, &node.scope, &[node.node_id.clone()])?
            .is_empty())
}
fn related(
    db: &Database,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    node: &KnowledgeNode,
) -> AgentResult<Vec<KnowledgeRelatedCard>> {
    let mut result = vec![];
    for edge in node.related.iter().take(5) {
        let Some(target) =
            db.agent_knowledge_get(&node.scope, &edge.node_id, Some(edge.revision))?
        else {
            continue;
        };
        if !visible_metadata(db, request, binding, &target)? {
            continue;
        }
        result.push(KnowledgeRelatedCard {
            node_id: format!("node:{}", target.node_id),
            revision: target.revision,
            kind: kind(target.kind),
            title: target.title.chars().take(240).collect(),
            one_line: target.one_line.chars().take(240).collect(),
            relation: edge.relation,
            reason: edge.reason.clone(),
        });
    }
    Ok(result)
}

pub(crate) struct KnowledgeService<'a, S> {
    store: &'a S,
}
impl<'a, S: BoundSourceStore> KnowledgeService<'a, S> {
    pub(crate) fn new(store: &'a S) -> Self {
        Self { store }
    }
    pub(crate) async fn get(
        &self,
        request: &RequestContext,
        input: &KnowledgeGetInput,
    ) -> AgentResult<KnowledgeGetPage> {
        let id = input
            .node_id
            .strip_prefix("node:")
            .unwrap_or(&input.node_id);
        validate_id(id)?;
        if input.version == Some(0)
            || input.version.is_some_and(|v| v > i64::MAX as u64)
            || input.section_ids.len() > 20
        {
            return Err(invalid("Invalid knowledge version or section selection"));
        }
        let mut unique = HashSet::new();
        for section in &input.section_ids {
            validate_id(section)?;
            if !unique.insert(section) {
                return Err(invalid("Duplicate knowledge section"));
            }
        }
        if input.view != KnowledgeView::Content && !input.section_ids.is_empty() {
            return Err(invalid("Section selection requires content view"));
        }
        let default_budget = if input.view == KnowledgeView::Content {
            4000
        } else {
            1200
        };
        let budget = input.budget_chars.unwrap_or(default_budget).min(8000);
        let selection = hash(&(input.version, input.view, &input.section_ids))?;
        let cursor: Option<ReadCursor> = input.cursor.as_deref().map(decode).transpose()?;
        if cursor
            .as_ref()
            .is_some_and(|c| c.s != input.scope || c.n != id || c.q != selection)
        {
            return Err(invalid("Knowledge cursor does not match this read"));
        }
        let (snapshot, plans) = self.store.with_current(|binding, db| {
            let source_request = authorize(db, request, binding, &input.scope)?;
            let node = db
                .agent_knowledge_get(&input.scope, id, input.version)?
                .ok_or_else(missing)?;
            if cursor.as_ref().is_some_and(|c| c.r != node.revision) {
                return Err(changed());
            }
            if !visible_metadata(db, &source_request, binding, &node)? {
                return Err(missing());
            }
            let mut plans = vec![];
            if input.view != KnowledgeView::Outline {
                for reference in &node.source_refs {
                    let plan = reference_file_plan(db, &source_request, binding, reference)
                        .map_err(|error| {
                            if unavailable(&error) {
                                missing()
                            } else {
                                error
                            }
                        })?;
                    if let Some(plan) = plan {
                        if !plans.iter().any(|p| p == &plan) {
                            plans.push(plan);
                        }
                    }
                }
            }
            Ok((node, plans))
        })?;
        let mut proofs = vec![];
        for plan in plans {
            let proof = FileReferenceProof::prepare(plan.clone())
                .await
                .map_err(|error| {
                    if unavailable(&error) {
                        missing()
                    } else {
                        error
                    }
                })?;
            proofs.push((plan, proof));
        }
        self.store.with_current(|binding, db| {
            let source_request = authorize(db, request, binding, &input.scope)?;
            let retained = db
                .agent_knowledge_get(&input.scope, id, input.version)?
                .ok_or_else(missing)?;
            if retained.revision != snapshot.revision {
                return Err(changed());
            }
            if !visible_metadata(db, &source_request, binding, &snapshot)? {
                return Err(missing());
            }
            let mut stale = dirty(db, binding, &snapshot)?;
            if input.view != KnowledgeView::Outline {
                for reference in &snapshot.source_refs {
                    stale |= reference_state(db, &source_request, binding, reference).map_err(
                        |error| {
                            if unavailable(&error) {
                                missing()
                            } else {
                                error
                            }
                        },
                    )?;
                    if let Some(plan) = reference_file_plan(db, &source_request, binding, reference)
                        .map_err(|error| {
                            if unavailable(&error) {
                                missing()
                            } else {
                                error
                            }
                        })?
                    {
                        let Some((_, proof)) =
                            proofs.iter().find(|(captured, _)| captured == &plan)
                        else {
                            return Err(changed());
                        };
                        proof
                            .verify(db, &source_request, binding, reference)
                            .map_err(|error| {
                                if unavailable(&error) {
                                    missing()
                                } else {
                                    error
                                }
                            })?;
                    }
                }
            }
            let cards = related(db, &source_request, binding, &snapshot)?;
            let visibility = hash(&(&snapshot.source_refs, &cards, stale))?;
            if cursor.as_ref().is_some_and(|c| c.v != visibility) {
                return Err(changed());
            }
            project(
                input,
                &snapshot,
                cards,
                stale,
                &selection,
                &visibility,
                cursor.as_ref(),
                budget,
            )
        })
    }
    pub(crate) fn search(
        &self,
        request: &RequestContext,
        input: &KnowledgeSearchInput,
    ) -> AgentResult<KnowledgeSearchPage> {
        self.store
            .with_current(|binding, db| search_current(db, request, binding, input))
    }
}

/// Compose registry authorities under the caller's single current DB fence.
pub(crate) fn search_current(
    db: &Database,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    input: &KnowledgeSearchInput,
) -> AgentResult<KnowledgeSearchPage> {
    if input.query.trim().is_empty() || input.query.chars().count() > 2000 || input.kinds.len() > 3
    {
        return Err(invalid(
            "Knowledge search requires a bounded nonempty query",
        ));
    }
    let limit = input.limit.unwrap_or(8);
    if !(1..=50).contains(&limit) {
        return Err(invalid("Knowledge search limit must be 1–50"));
    }
    let budget = input.budget_chars.unwrap_or(3000).min(3000);
    let selection = hash(&(&input.query, &input.kinds))?;
    let cursor: Option<SearchCursor> = input.cursor.as_deref().map(decode).transpose()?;
    if cursor
        .as_ref()
        .is_some_and(|c| c.s != input.scope || c.q != selection)
    {
        return Err(invalid("Knowledge search cursor does not match this query"));
    }
    let source_request = authorize(db, request, binding, &input.scope)?;
    let revision = db
        .agent_overview_head(&input.scope)?
        .map_or(0, |head| head.revision);
    if cursor.as_ref().is_some_and(|c| c.r != revision) {
        return Err(changed());
    }
    let mut after = cursor.as_ref().map(|c| c.a.clone());
    let mut visible = vec![];
    let mut scanned = 0usize;
    let mut incomplete = false;
    loop {
        let batch_limit = (200 - scanned).min(50) as u16;
        let candidates = db.agent_knowledge_candidates(
            &input.scope,
            &input.query,
            &input.kinds,
            after.as_deref(),
            batch_limit,
        )?;
        let count = candidates.len();
        for node in candidates {
            scanned += 1;
            after = Some(node.node_id.clone());
            if !visible_metadata(db, &source_request, binding, &node)? {
                continue;
            }
            visible.push(KnowledgeSearchCard {
                node_id: format!("node:{}", node.node_id),
                title: node.title.chars().take(240).collect(),
                snippet: node.one_line.chars().take(240).collect(),
                kind: kind(node.kind),
                revision: node.revision,
                stale: dirty(db, binding, &node)?,
                epistemic_status: node.epistemic_status.clone(),
            });
            if visible.len() > usize::from(limit) {
                break;
            }
        }
        if visible.len() > usize::from(limit) || count < usize::from(batch_limit) {
            break;
        }
        if scanned == 200 {
            incomplete = true;
            break;
        }
    }
    let had_visible = cursor.as_ref().is_some_and(|c| c.h) || !visible.is_empty();
    let continuation = |id: String| {
        encode(&SearchCursor {
            s: input.scope.clone(),
            q: selection.clone(),
            r: revision,
            a: id,
            h: had_visible,
        })
    };
    let mut page = KnowledgeSearchPage {
        scope: input.scope.clone(),
        items: vec![],
        next_cursor: None,
        source_fallback_required: !had_visible && !incomplete,
    };
    let total = visible.len();
    if incomplete && visible.is_empty() {
        page.next_cursor = after.clone().map(&continuation).transpose()?;
    }
    for (index, card) in visible.into_iter().take(usize::from(limit)).enumerate() {
        let previous_cursor = page.next_cursor.clone();
        let last_id = card.node_id.strip_prefix("node:").unwrap().to_string();
        page.items.push(card);
        page.next_cursor = if index + 1 < total {
            Some(continuation(last_id)?)
        } else if incomplete {
            after.clone().map(&continuation).transpose()?
        } else {
            None
        };
        if serialized_chars(&page)? > budget {
            page.items.pop();
            page.next_cursor = previous_cursor;
            if page.items.is_empty() {
                return Err(AgentError::new(
                    ErrorCode::BudgetExceeded,
                    "Knowledge search metadata does not fit budget",
                ));
            }
            break;
        }
    }
    if serialized_chars(&page)? > budget {
        return Err(AgentError::new(
            ErrorCode::BudgetExceeded,
            "Knowledge search metadata does not fit budget",
        ));
    }
    Ok(page)
}

fn budget_error() -> AgentError {
    AgentError::new(
        ErrorCode::BudgetExceeded,
        "Knowledge metadata or selected text does not fit budget",
    )
}
fn trim_related(page: &mut KnowledgeGetPage, budget: usize) -> AgentResult<()> {
    while serialized_chars(page)? > budget && !page.related.is_empty() {
        page.related.pop();
    }
    if serialized_chars(page)? > budget {
        return Err(budget_error());
    }
    Ok(())
}
fn project(
    input: &KnowledgeGetInput,
    node: &KnowledgeNode,
    related: Vec<KnowledgeRelatedCard>,
    stale: bool,
    selection: &str,
    visibility: &str,
    cursor: Option<&ReadCursor>,
    budget: usize,
) -> AgentResult<KnowledgeGetPage> {
    let (start, offset) = cursor.map_or((0, 0), |c| (c.i, c.o));
    let next = |index, offset| {
        encode(&ReadCursor {
            s: input.scope.clone(),
            n: node.node_id.clone(),
            r: node.revision,
            q: selection.into(),
            v: visibility.into(),
            i: index,
            o: offset,
        })
    };
    let mut page = KnowledgeGetPage {
        scope: node.scope.clone(),
        node_id: format!("node:{}", node.node_id),
        kind: kind(node.kind),
        revision: node.revision,
        title: node.title.clone(),
        view: input.view,
        summary: None,
        summary_offset: 0,
        sections: vec![],
        source_refs: if input.view == KnowledgeView::Outline {
            vec![]
        } else {
            node.source_refs.clone()
        },
        related,
        coverage: node.coverage.clone(),
        stale,
        epistemic_status: node.epistemic_status.clone(),
        valid_state: if stale && matches!(node.valid_state, ValidState::Current) {
            ValidState::Stale
        } else {
            node.valid_state.clone()
        },
        next_cursor: None,
    };
    if input.view == KnowledgeView::Summary {
        let chars: Vec<char> = node.summary.chars().collect();
        if start != 0 || offset > chars.len() {
            return Err(invalid("Invalid knowledge summary cursor"));
        }
        page.summary_offset = offset;
        let remaining = chars.len() - offset;
        // The terminal page has no cursor, so its serialized cost is not a
        // monotone extension of a partial page. Test it before partial search.
        let mut full = page.clone();
        full.summary = Some(chars[offset..].iter().collect());
        if trim_related(&mut full, budget).is_ok() {
            return Ok(full);
        }
        let minimum = usize::from(remaining > 0);
        page.summary = Some(chars[offset..offset + minimum].iter().collect());
        page.next_cursor = if minimum < remaining {
            Some(next(0, offset + minimum)?)
        } else {
            None
        };
        trim_related(&mut page, budget)?;
        let mut low = minimum;
        let mut high = remaining;
        while low < high {
            let count = low + (high - low + 1) / 2;
            page.summary = Some(chars[offset..offset + count].iter().collect());
            page.next_cursor = if count < remaining {
                Some(next(0, offset + count)?)
            } else {
                None
            };
            if serialized_chars(&page)? <= budget {
                low = count;
            } else {
                high = count - 1;
            }
        }
        page.summary = Some(chars[offset..offset + low].iter().collect());
        page.next_cursor = if low < remaining {
            Some(next(0, offset + low)?)
        } else {
            None
        };
    } else {
        let sections: Vec<_> = node
            .body_sections
            .iter()
            .filter(|section| {
                input.section_ids.is_empty() || input.section_ids.contains(&section.id)
            })
            .collect();
        if input
            .section_ids
            .iter()
            .any(|id| !node.body_sections.iter().any(|section| &section.id == id))
        {
            return Err(invalid("Unknown knowledge section"));
        }
        if start > sections.len()
            || (start == sections.len() && offset != 0)
            || (input.view == KnowledgeView::Outline && offset != 0)
        {
            return Err(invalid("Invalid knowledge section cursor"));
        }
        for (index, section) in sections.iter().enumerate().skip(start) {
            let chars: Vec<char> = section.text.chars().collect();
            let text_offset = if index == start { offset } else { 0 };
            if text_offset > chars.len() {
                return Err(invalid("Invalid knowledge text cursor"));
            }
            let remaining = chars.len() - text_offset;
            let is_outline = input.view == KnowledgeView::Outline;
            let mut full = page.clone();
            full.sections.push(KnowledgeReadSection {
                id: section.id.clone(),
                title: section.title.clone(),
                text: if is_outline {
                    None
                } else {
                    Some(chars[text_offset..].iter().collect())
                },
                text_offset,
                complete: true,
            });
            full.next_cursor = if index + 1 < sections.len() {
                Some(next(index + 1, 0)?)
            } else {
                None
            };
            if trim_related(&mut full, budget).is_ok() {
                page = full;
                continue;
            }
            let minimum = if is_outline {
                0
            } else {
                usize::from(remaining > 0)
            };
            let item = KnowledgeReadSection {
                id: section.id.clone(),
                title: section.title.clone(),
                text: if is_outline {
                    None
                } else {
                    Some(chars[text_offset..text_offset + minimum].iter().collect())
                },
                text_offset,
                complete: is_outline || minimum == remaining,
            };
            let previous_cursor = page.next_cursor.clone();
            page.sections.push(item);
            page.next_cursor = if !is_outline && minimum < remaining {
                Some(next(index, text_offset + minimum)?)
            } else if index + 1 < sections.len() {
                Some(next(index + 1, 0)?)
            } else {
                None
            };
            if page.sections.len() == 1 {
                trim_related(&mut page, budget)?;
            }
            if serialized_chars(&page)? > budget {
                page.sections.pop();
                page.next_cursor = previous_cursor;
                break;
            }
            if !is_outline {
                let mut low = minimum;
                let mut high = remaining;
                while low < high {
                    let count = low + (high - low + 1) / 2;
                    let item = page.sections.last_mut().unwrap();
                    item.text = Some(chars[text_offset..text_offset + count].iter().collect());
                    item.complete = count == remaining;
                    page.next_cursor = if count < remaining {
                        Some(next(index, text_offset + count)?)
                    } else if index + 1 < sections.len() {
                        Some(next(index + 1, 0)?)
                    } else {
                        None
                    };
                    if serialized_chars(&page)? <= budget {
                        low = count;
                    } else {
                        high = count - 1;
                    }
                }
                let item = page.sections.last_mut().unwrap();
                item.text = Some(chars[text_offset..text_offset + low].iter().collect());
                item.complete = low == remaining;
                page.next_cursor = if low < remaining {
                    Some(next(index, text_offset + low)?)
                } else if index + 1 < sections.len() {
                    Some(next(index + 1, 0)?)
                } else {
                    None
                };
                if low < remaining {
                    break;
                }
            }
        }
        trim_related(&mut page, budget)?;
    }
    if serialized_chars(&page)? > budget {
        return Err(budget_error());
    }
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            access::{Caller, ScopeGrant},
            context::EpistemicStatus,
            knowledge::{KnowledgeBodySection, KnowledgeNodeWrite, KnowledgeRelated},
            models::{ObjectKind, ObjectRef},
            overview::OverviewPublishInput,
        },
        committed_changes::{CommittedChangePublisher, CommittedChanges},
        models::{ProjectCreateInput, TodoCreateInput, TodoScope},
        overview_evidence::{capture, CapturedEvidence},
        overview_service::OverviewService,
        record_document_service::DocumentUtility,
        source_service::{
            SourcePolicyUpdate, SourceReadInput, SourceReadTarget, SourceReadView, SourceUtility,
        },
    };
    use std::sync::Mutex;
    struct Store {
        binding: WorkspaceBinding,
        db: Mutex<Database>,
    }
    impl CommittedChangePublisher for Store {
        fn publish_committed(&self, _: CommittedChanges) {}
    }
    impl BoundSourceStore for Store {
        fn with_current<T>(
            &self,
            action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
        ) -> AgentResult<T> {
            action(&self.binding, &self.db.lock().unwrap())
        }
    }
    struct Unused;
    impl DocumentUtility for Unused {
        async fn request(
            &self,
            _: &str,
            _: &str,
            _: serde_json::Value,
        ) -> AgentResult<serde_json::Value> {
            panic!("Todo reads do not convert documents")
        }
    }
    impl SourceUtility for Unused {
        async fn request(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: &[u8],
        ) -> AgentResult<serde_json::Value> {
            panic!("Todo reads do not extract Files")
        }
    }
    struct Fixture {
        _root: tempfile::TempDir,
        store: Store,
        request: RequestContext,
        scope: Scope,
        evidence: Vec<CapturedEvidence>,
    }
    async fn fixture() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(
            &root.path().join("knowledge-read.sqlite"),
            root.path(),
            None,
        )
        .unwrap();
        db.bind_native_workspace("w").unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "真实知识目录".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let mut todo_ids = vec![];
        for index in 0..3 {
            todo_ids.push(
                db.todo_create(TodoCreateInput {
                    scope: TodoScope::Project,
                    project_id: Some(project.id),
                    content: format!("真实证据{index}"),
                    priority: "normal".into(),
                    due_date: None,
                    tag_ids: vec![],
                })
                .unwrap()
                .id,
            );
        }
        let binding = WorkspaceBinding {
            workspace_id: "w".into(),
            generation: "one".into(),
        };
        let scope = Scope::Project {
            project_id: project.id,
        };
        let request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "knowledge-capture".into(),
            scope_grant: ScopeGrant {
                workspace_id: "w".into(),
                workspace_content: false,
                project_ids: vec![project.id],
                operations: vec![
                    "source.read".into(),
                    "context.read".into(),
                    "knowledge.write".into(),
                    "settings.write".into(),
                ],
            },
        };
        let store = Store {
            binding,
            db: Mutex::new(db),
        };
        let mut evidence = vec![];
        for id in todo_ids {
            let input = SourceReadInput {
                source: SourceReadTarget {
                    object: ObjectRef {
                        workspace_id: "w".into(),
                        scope: scope.clone(),
                        kind: ObjectKind::Todo,
                        id: id.to_string(),
                    },
                    revision: None,
                    record_version: None,
                    file_version: None,
                },
                view: SourceReadView::Full,
                selection: None,
                cursor: None,
                budget_chars: Some(2000),
            };
            evidence.push(
                capture(&store, &request, &input, &Unused, &Unused)
                    .await
                    .unwrap()
                    .1,
            );
        }
        Fixture {
            _root: root,
            store,
            request,
            scope,
            evidence,
        }
    }
    fn node(f: &Fixture, id: &str, source: usize) -> KnowledgeNodeWrite {
        KnowledgeNodeWrite {
            node_id: id.into(),
            expected_revision: 0,
            kind: KnowledgeKind::Topic,
            title: format!("云端知识{id}"),
            one_line: "用于理解真实交付的导航".into(),
            summary: "中文摘要与转义\"验证".repeat(100),
            body_sections: vec![
                KnowledgeBodySection {
                    id: "first".into(),
                    title: "选择正文".into(),
                    text: "中文内容🙂需要按Unicode分页".repeat(150),
                },
                KnowledgeBodySection {
                    id: "other".into(),
                    title: "不选择章节".into(),
                    text: "未选章节不能注入".into(),
                },
            ],
            aliases: vec!["计算机系统设计".into()],
            keywords: vec!["检索".into()],
            source_refs: vec![f.evidence[source].reference().clone()],
            epistemic_status: EpistemicStatus::Inferred,
            coverage: SourceCoverage {
                processed: 1,
                partial: 0,
                excluded: 0,
                unsupported: 0,
                pending: 0,
            },
            related: vec![],
        }
    }
    async fn publish(f: &Fixture, nodes: Vec<KnowledgeNodeWrite>, request_id: &str) {
        let (expected_revision, target_seq) = f
            .store
            .with_current(|_, db| {
                Ok((
                    db.agent_overview_head(&f.scope)?.map_or(0, |h| h.revision),
                    db.committed_change_watermark()? as u64,
                ))
            })
            .unwrap();
        let input = OverviewPublishInput {
            scope: f.scope.clone(),
            batch_id: format!("knowledge-batch-{expected_revision}"),
            expected_revision,
            target_seq,
            policy_revision: 0,
            correction_revision: 0,
            upsert_items: vec![],
            remove_item_ids: vec![],
            settled_object_keys: vec![],
            knowledge_upserts: nodes,
            knowledge_removes: vec![],
            coverage: SourceCoverage {
                processed: 1,
                partial: 0,
                excluded: 0,
                unsupported: 0,
                pending: 0,
            },
            source_manifest_hash: "real-fixture".into(),
            model_profile_id: "fixture".into(),
        };
        let mut request = f.request.clone();
        request.request_id = request_id.into();
        OverviewService::new(&f.store)
            .publish(&request, &input, &f.evidence)
            .await
            .unwrap();
    }
    fn input(f: &Fixture, id: &str) -> KnowledgeGetInput {
        KnowledgeGetInput {
            scope: f.scope.clone(),
            node_id: id.into(),
            version: None,
            view: KnowledgeView::Summary,
            section_ids: vec![],
            cursor: None,
            budget_chars: None,
        }
    }
    fn read_request(f: &Fixture) -> RequestContext {
        let mut request = f.request.clone();
        request.scope_grant.operations = vec!["context.read".into()];
        request
    }
    fn exclude(f: &Fixture, source: usize) {
        let mut request = f.request.clone();
        request.request_id = format!("exclude-{source}");
        f.store
            .with_current(|binding, db| {
                db.source_policy_update(
                    &request,
                    binding,
                    &SourcePolicyUpdate {
                        object: f.evidence[source].reference().object.clone(),
                        expected_revision: 0,
                        excluded: true,
                    },
                )
            })
            .unwrap();
    }
    #[tokio::test]
    async fn knowledge_selective_unicode_pages_summary_budget_and_head_cursor() {
        let f = fixture().await;
        let original = node(&f, "a", 0);
        let expected = original.body_sections[0].text.clone();
        publish(&f, vec![original], "publish-one").await;
        let service = KnowledgeService::new(&f.store);
        let request = read_request(&f);
        let summary = service.get(&request, &input(&f, "a")).await.unwrap();
        assert!(serialized_chars(&summary).unwrap() <= 1200);
        assert!(matches!(
            summary.epistemic_status,
            EpistemicStatus::Inferred
        ));
        assert!(summary.sections.is_empty());
        let mut read = input(&f, "a");
        read.view = KnowledgeView::Content;
        read.section_ids = vec!["first".into()];
        read.budget_chars = Some(1400);
        let first = service.get(&request, &read).await.unwrap();
        let first_cursor = first.next_cursor.clone();
        assert!(first_cursor.is_some());
        let mut text = String::new();
        let mut page = first;
        let mut pages = 0;
        loop {
            assert!(serialized_chars(&page).unwrap() <= 1400);
            assert_eq!(page.sections.len(), 1);
            assert_eq!(page.sections[0].id, "first");
            text.push_str(page.sections[0].text.as_deref().unwrap());
            pages += 1;
            assert!(pages < 100);
            let Some(cursor) = page.next_cursor else {
                break;
            };
            read.cursor = Some(cursor);
            page = service.get(&request, &read).await.unwrap();
        }
        assert_eq!(text, expected);
        assert!(pages > 1);
        let mut replacement = node(&f, "a", 0);
        replacement.expected_revision = 1;
        replacement.summary = "新的摘要".into();
        publish(&f, vec![replacement], "publish-two").await;
        let short = service.get(&request, &input(&f, "a")).await.unwrap();
        assert_eq!(short.summary.as_deref(), Some("新的摘要"));
        assert!(short.next_cursor.is_none());
        assert!(serialized_chars(&short).unwrap() <= 1200);
        read.cursor = first_cursor;
        assert_eq!(
            service.get(&request, &read).await.unwrap_err().code,
            ErrorCode::SourceChanged
        );
    }
    #[tokio::test]
    async fn knowledge_alias_chinese_search_filters_and_navigation_never_recurses() {
        let f = fixture().await;
        let mut a = node(&f, "a", 0);
        let mut b = node(&f, "b", 1);
        let c = node(&f, "c", 2);
        a.related = vec![KnowledgeRelated {
            node_id: "b".into(),
            revision: 1,
            relation: KnowledgeRelation::Supports,
            reason: "机密关联理由B".into(),
        }];
        b.related = vec![KnowledgeRelated {
            node_id: "c".into(),
            revision: 1,
            relation: KnowledgeRelation::Related,
            reason: "不能递归的C".into(),
        }];
        b.body_sections[0].text = "绝不能递归注入的B正文".into();
        publish(&f, vec![a, b, c], "publish-navigation").await;
        let service = KnowledgeService::new(&f.store);
        let request = read_request(&f);
        let search = |query: &str| KnowledgeSearchInput {
            scope: f.scope.clone(),
            query: query.into(),
            kinds: vec![],
            cursor: None,
            limit: None,
            budget_chars: None,
        };
        for query in ["系统", "计算机系统", "云"] {
            let page = service.search(&request, &search(query)).unwrap();
            assert_eq!(page.items.len(), 3);
            assert!(serialized_chars(&page).unwrap() <= 3000);
            assert!(!page.source_fallback_required);
        }
        let mut bounded_search = search("云");
        bounded_search.budget_chars = Some(650);
        let mut seen = vec![];
        loop {
            let page = service.search(&request, &bounded_search).unwrap();
            assert!(serialized_chars(&page).unwrap() <= 650);
            seen.extend(page.items.iter().map(|card| card.node_id.clone()));
            let Some(cursor) = page.next_cursor else {
                break;
            };
            bounded_search.cursor = Some(cursor);
        }
        assert_eq!(seen, vec!["node:a", "node:b", "node:c"]);
        let absent = service.search(&request, &search("没有命中词")).unwrap();
        assert!(absent.items.is_empty());
        assert!(absent.source_fallback_required);
        exclude(&f, 2);
        let mut read = input(&f, "a");
        read.budget_chars = Some(8000);
        let page = service.get(&request, &read).await.unwrap();
        assert_eq!(page.related.len(), 1);
        assert_eq!(page.related[0].node_id, "node:b");
        let json = serde_json::to_string(&page).unwrap();
        assert!(!json.contains("绝不能递归注入"));
        assert!(!json.contains("不能递归的C"));
        exclude(&f, 1);
        let page = service.get(&request, &read).await.unwrap();
        assert!(page.related.is_empty());
        assert!(!serde_json::to_string(&page)
            .unwrap()
            .contains("机密关联理由B"));
        let mut historical = input(&f, "b");
        historical.version = Some(1);
        assert_eq!(
            service.get(&request, &historical).await.unwrap_err().code,
            ErrorCode::NotFound
        );
        assert_eq!(
            service.search(&request, &search("云")).unwrap().items.len(),
            1
        );
        exclude(&f, 0);
        for version in [None, Some(1)] {
            read.version = version;
            assert_eq!(
                service.get(&request, &read).await.unwrap_err().code,
                ErrorCode::NotFound
            );
        }
        let page = service.search(&request, &search("云")).unwrap();
        assert!(page.items.is_empty());
        assert!(page.source_fallback_required);
    }
    #[tokio::test]
    async fn knowledge_search_scans_at_most_two_hundred_without_false_fallback_or_skips() {
        let f = fixture().await;
        for batch in 0..11 {
            let mut nodes = vec![];
            for number in batch * 20..((batch + 1) * 20).min(201) {
                let mut n = node(&f, &format!("scan-{number:03}"), 0);
                n.title = "扫描目录".into();
                n.summary.clear();
                n.body_sections.clear();
                nodes.push(n);
            }
            publish(&f, nodes, &format!("publish-scan-{batch}")).await;
        }
        exclude(&f, 0);
        let service = KnowledgeService::new(&f.store);
        let request = read_request(&f);
        let mut search = KnowledgeSearchInput {
            scope: f.scope.clone(),
            query: "扫描".into(),
            kinds: vec![],
            cursor: None,
            limit: None,
            budget_chars: None,
        };
        let first = service.search(&request, &search).unwrap();
        assert!(first.items.is_empty());
        assert!(!first.source_fallback_required);
        let cursor = first.next_cursor.unwrap();
        let decoded: SearchCursor = decode(&cursor).unwrap();
        assert_eq!(decoded.a, "scan-199");
        search.cursor = Some(cursor);
        let end = service.search(&request, &search).unwrap();
        assert!(end.items.is_empty());
        assert!(end.next_cursor.is_none());
        assert!(end.source_fallback_required);
    }
}
