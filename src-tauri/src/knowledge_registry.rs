//! One read registry; Overview items keep their original authority and versions.
use crate::{
    agent::{
        access::RequestContext,
        context::{serialized_chars, AiOverview, OverviewItem, OverviewSection, ValidState},
        errors::{AgentError, AgentResult, ErrorCode},
        models::{Scope, WorkspaceBinding},
        overview::validate_id,
        source_trace::derived_source_visible,
    },
    db::Database,
    knowledge_service::{
        KnowledgeGetInput, KnowledgeGetPage, KnowledgeReadSection, KnowledgeSearchCard,
        KnowledgeSearchInput, KnowledgeSearchPage, KnowledgeService, KnowledgeView,
    },
    overview_service::{OverviewReadInput, OverviewService},
    source_service::BoundSourceStore,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn missing() -> AgentError {
    AgentError::new(ErrorCode::NotFound, "Knowledge entry is unavailable")
}
fn changed() -> AgentError {
    AgentError::new(
        ErrorCode::SourceChanged,
        "Knowledge registry changed; restart reading",
    )
}
fn title(section: &OverviewSection) -> String {
    match section {
        OverviewSection::Profile => "项目定位",
        OverviewSection::Progress => "项目进展",
        OverviewSection::KnowledgeMap => "知识入口",
        OverviewSection::Actions => "行动",
        OverviewSection::OpenQuestions => "待解问题",
    }
    .into()
}
fn encode(value: &impl Serialize) -> AgentResult<String> {
    serde_json::to_vec(value)
        .map(|data| URL_SAFE_NO_PAD.encode(data))
        .map_err(|_| invalid("Invalid registry cursor"))
}
fn decode<T: serde::de::DeserializeOwned>(value: &str) -> AgentResult<T> {
    if value.len() > 8192 {
        return Err(invalid("Invalid registry cursor"));
    }
    serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(value)
            .map_err(|_| invalid("Invalid registry cursor"))?,
    )
    .map_err(|_| invalid("Invalid registry cursor"))
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OverviewCursor {
    view: KnowledgeView,
    inner: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchCursor {
    scope: Scope,
    selection: String,
    revision: u64,
    memory_epoch: u64,
    inner: Option<String>,
    overview_after: Option<String>,
    had_hits: bool,
}

pub(crate) struct KnowledgeRegistry<'a, S> {
    store: &'a S,
}
impl<'a, S: BoundSourceStore> KnowledgeRegistry<'a, S> {
    pub(crate) fn new(store: &'a S) -> Self {
        Self { store }
    }
    fn overview(
        &self,
        request: &RequestContext,
        scope: &Scope,
        version: Option<u64>,
    ) -> AgentResult<Option<(AiOverview, Vec<OverviewItem>)>> {
        self.store
            .with_current(|binding, db| overview_current(db, request, binding, scope, version))
    }

    pub(crate) async fn get(
        &self,
        request: &RequestContext,
        input: &KnowledgeGetInput,
    ) -> AgentResult<KnowledgeGetPage> {
        if input.node_id.starts_with("node:") {
            return KnowledgeService::new(self.store).get(request, input).await;
        }
        let id = input
            .node_id
            .strip_prefix("overview:")
            .ok_or_else(|| invalid("Unknown knowledge entry namespace"))?;
        validate_id(id)?;
        if input.section_ids.iter().any(|id| id != "body")
            || (input.view != KnowledgeView::Content && !input.section_ids.is_empty())
        {
            return Err(invalid("Overview entry has only the body section"));
        }
        let budget = input
            .budget_chars
            .unwrap_or(if input.view == KnowledgeView::Content {
                4000
            } else {
                1200
            })
            .min(8000);
        if input.view == KnowledgeView::Outline {
            if input.cursor.is_some() {
                return Err(invalid("An Overview outline has no body cursor"));
            }
            let (snapshot, items) = self
                .overview(request, &input.scope, input.version)?
                .ok_or_else(missing)?;
            let item = items
                .into_iter()
                .find(|item| item.id == id)
                .ok_or_else(missing)?;
            let page = KnowledgeGetPage {
                scope: input.scope.clone(),
                node_id: input.node_id.clone(),
                kind: "overview_item".into(),
                revision: snapshot.revision,
                title: title(&item.section),
                view: input.view,
                summary: None,
                session_summary: None,
                summary_offset: 0,
                sections: vec![KnowledgeReadSection {
                    id: "body".into(),
                    title: title(&item.section),
                    text: None,
                    text_offset: 0,
                    complete: true,
                }],
                source_refs: vec![],
                published_sources: vec![],
                related: vec![],
                coverage: snapshot.coverage,
                stale: matches!(item.valid_state, ValidState::Stale),
                epistemic_status: item.epistemic_status,
                valid_state: item.valid_state,
                next_cursor: None,
            };
            return bounded(page, budget);
        }
        let cursor: Option<OverviewCursor> = input.cursor.as_deref().map(decode).transpose()?;
        if cursor
            .as_ref()
            .is_some_and(|cursor| cursor.view != input.view)
        {
            return Err(invalid("Overview cursor belongs to another view"));
        }
        // Reserve registry framing before the existing source-verified pager, so
        // no emitted text is subsequently truncated past its authoritative cursor.
        let raw = OverviewService::new(self.store)
            .get(
                request,
                &OverviewReadInput {
                    scope: input.scope.clone(),
                    version: input.version,
                    sections: vec![],
                    item_ids: vec![id.into()],
                    cursor: cursor.map(|cursor| cursor.inner),
                    budget_chars: Some(budget.saturating_sub(256)),
                },
            )
            .await?;
        let read = raw.items.into_iter().next().ok_or_else(missing)?;
        let section_title = title(&read.item.section);
        let summary = if input.view == KnowledgeView::Summary {
            Some(read.item.text.clone())
        } else {
            None
        };
        let sections = if input.view == KnowledgeView::Content {
            vec![KnowledgeReadSection {
                id: "body".into(),
                title: section_title.clone(),
                text: Some(read.item.text.clone()),
                text_offset: read.text_offset,
                complete: read.complete,
            }]
        } else {
            vec![]
        };
        let page = KnowledgeGetPage {
            scope: input.scope.clone(),
            node_id: input.node_id.clone(),
            kind: "overview_item".into(),
            revision: raw.revision.ok_or_else(missing)?,
            title: section_title,
            view: input.view,
            summary,
            session_summary: None,
            summary_offset: if input.view == KnowledgeView::Summary {
                read.text_offset
            } else {
                0
            },
            sections,
            source_refs: read.item.source_refs,
            published_sources: read.item.published_sources,
            related: vec![],
            coverage: raw.coverage.ok_or_else(missing)?,
            stale: raw.stale,
            epistemic_status: read.item.epistemic_status,
            valid_state: read.item.valid_state,
            next_cursor: raw
                .next_cursor
                .map(|inner| {
                    encode(&OverviewCursor {
                        view: input.view,
                        inner,
                    })
                })
                .transpose()?,
        };
        bounded(page, budget)
    }
    pub(crate) fn search(
        &self,
        request: &RequestContext,
        input: &KnowledgeSearchInput,
    ) -> AgentResult<KnowledgeSearchPage> {
        self.store
            .with_current(|binding, db| self.search_current(db, request, binding, input))
    }
    fn search_current(
        &self,
        db: &Database,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &KnowledgeSearchInput,
    ) -> AgentResult<KnowledgeSearchPage> {
        if input.query.trim().is_empty()
            || input.query.chars().count() > 2000
            || input.kinds.len() > 4
        {
            return Err(invalid(
                "Knowledge search requires a bounded nonempty query",
            ));
        }
        let limit = input.limit.unwrap_or(8);
        if !(1..=50).contains(&limit) {
            return Err(invalid("Invalid knowledge search limit"));
        }
        let budget = input.budget_chars.unwrap_or(3000).min(3000);
        let selection = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(&input.query, &input.kinds))
                    .map_err(|_| invalid("Invalid search"))?
            )
        );
        let cursor: Option<SearchCursor> = input.cursor.as_deref().map(decode).transpose()?;
        if cursor
            .as_ref()
            .is_some_and(|c| c.scope != input.scope || c.selection != selection)
        {
            return Err(invalid("Registry cursor belongs to another search"));
        }
        let snapshot = overview_current(db, request, binding, &input.scope, None)?;
        let revision = snapshot
            .as_ref()
            .map_or(0, |(snapshot, _)| snapshot.revision);
        let memory_epoch = db.agent_memory_scope_epoch(&input.scope)?;
        if cursor.as_ref().is_some_and(|c| c.revision != revision || c.memory_epoch != memory_epoch) {
            return Err(changed());
        }
        let prior_hits = cursor.as_ref().is_some_and(|c| c.had_hits);
        let overview_phase = cursor.as_ref().is_some_and(|c| c.overview_after.is_some());
        let mut page = if overview_phase {
            KnowledgeSearchPage {
                scope: input.scope.clone(),
                items: vec![],
                next_cursor: None,
                source_fallback_required: false,
            }
        } else {
            let mut node_input = input.clone();
            node_input.cursor = cursor.as_ref().and_then(|c| c.inner.clone());
            node_input.budget_chars = Some(budget.saturating_sub(512));
            crate::knowledge_service::search_current(db, request, binding, &node_input)?
        };
        if let Some(inner) = page.next_cursor.take() {
            page.next_cursor = Some(encode(&SearchCursor {
                scope: input.scope.clone(),
                selection,
                revision,
                memory_epoch,
                inner: Some(inner),
                overview_after: None,
                had_hits: prior_hits || !page.items.is_empty(),
            })?);
            return bounded_search(page, budget);
        }
        if input.kinds.is_empty() {
            let after = cursor
                .as_ref()
                .and_then(|c| c.overview_after.as_deref())
                .unwrap_or("");
            let query = input.query.trim().to_lowercase();
            let mut items = snapshot.map_or_else(Vec::new, |(_, items)| items);
            items.sort_by(|a, b| a.id.cmp(&b.id));
            let matches: Vec<_> = items
                .into_iter()
                .filter(|item| {
                    item.id.as_str() > after
                        && (item.text.to_lowercase().contains(&query)
                            || title(&item.section).contains(&query))
                })
                .collect();
            let mut last = after.to_string();
            for (index, item) in matches.iter().enumerate() {
                let before = page.items.len();
                if before < limit as usize {
                    page.items.push(KnowledgeSearchCard {
                        node_id: format!("overview:{}", item.id),
                        title: title(&item.section),
                        snippet: item.text.chars().take(240).collect(),
                        kind: "overview_item".into(),
                        revision,
                        stale: matches!(item.valid_state, ValidState::Stale),
                        epistemic_status: item.epistemic_status.clone(),
                    });
                }
                let candidate_last = if before < limit as usize {
                    item.id.clone()
                } else {
                    last.clone()
                };
                page.next_cursor = if before >= limit as usize || index + 1 < matches.len() {
                    Some(encode(&SearchCursor {
                        scope: input.scope.clone(),
                        selection: selection.clone(),
                        revision,
                memory_epoch,
                        inner: None,
                        overview_after: Some(candidate_last.clone()),
                        had_hits: prior_hits || !page.items.is_empty(),
                    })?)
                } else {
                    None
                };
                if before >= limit as usize {
                    break;
                }
                if serialized_chars(&page)? > budget {
                    page.items.pop();
                    page.next_cursor = Some(encode(&SearchCursor {
                        scope: input.scope.clone(),
                        selection: selection.clone(),
                        revision,
                memory_epoch,
                        inner: None,
                        overview_after: Some(last),
                        had_hits: prior_hits || !page.items.is_empty(),
                    })?);
                    if page.items.is_empty() {
                        return Err(AgentError::new(
                            ErrorCode::BudgetExceeded,
                            "Registry card does not fit budget",
                        ));
                    }
                    break;
                }
                last = candidate_last;
            }
        }
        page.source_fallback_required = !prior_hits
            && page.items.is_empty()
            && page.next_cursor.is_none()
            && page.source_fallback_required;
        bounded_search(page, budget)
    }
}
fn overview_current(
    db: &Database,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    scope: &Scope,
    version: Option<u64>,
) -> AgentResult<Option<(AiOverview, Vec<OverviewItem>)>> {
    request.authorize(binding, scope, "context.read")?;
    request.require_scope_context()?;
    let snapshot = match version {
        Some(version) => db.agent_overview_version(scope, version)?,
        None => db.agent_overview_head(scope)?,
    };
    let Some(snapshot) = snapshot else {
        return Ok(None);
    };
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
    let mut hidden = HashSet::new();
    let mut stale: HashSet<_> = db
        .agent_overview_stale_items(&binding.workspace_id, scope)?
        .into_iter()
        .collect();
    for item in &snapshot.items {
        for reference in &item.source_refs {
            match derived_source_visible(db, &source_request, binding, reference) {
                Ok(_) => (),
                Err(error)
                    if matches!(
                        error.code,
                        ErrorCode::NotFound | ErrorCode::ScopeDenied | ErrorCode::SourceNotReady
                            | ErrorCode::SourceChanged | ErrorCode::ObjectWithdrawn
                    ) =>
                {
                    hidden.insert(item.id.clone());
                }
                Err(error) => return Err(error),
            }
        }
    }
    loop {
        let before = (hidden.len(), stale.len());
        for item in &snapshot.items {
            if item
                .dependency_item_ids
                .iter()
                .any(|id| hidden.contains(id))
            {
                hidden.insert(item.id.clone());
            }
            if item.dependency_item_ids.iter().any(|id| stale.contains(id)) {
                stale.insert(item.id.clone());
            }
        }
        if before == (hidden.len(), stale.len()) {
            break;
        }
    }
    let (policy, corrections) = db.agent_overview_version_baselines(scope, snapshot.revision)?;
    let baseline_changed = policy
        != crate::agent::settings::SettingsRepository::agent_settings_get(db, scope)?.revision
        || corrections != db.agent_overview_corrections(scope)?.revision;
    let mut items: Vec<_> = snapshot
        .items
        .iter()
        .filter(|item| !hidden.contains(&item.id))
        .cloned()
        .collect();
    for item in &mut items {
        if (baseline_changed || stale.contains(&item.id))
            && matches!(item.valid_state, ValidState::Current)
        {
            item.valid_state = ValidState::Stale;
        }
    }
    Ok(Some((snapshot, items)))
}
fn bounded(page: KnowledgeGetPage, budget: usize) -> AgentResult<KnowledgeGetPage> {
    if serialized_chars(&page)? > budget {
        return Err(AgentError::new(
            ErrorCode::BudgetExceeded,
            "Registry metadata does not fit budget",
        ));
    }
    Ok(page)
}
fn bounded_search(page: KnowledgeSearchPage, budget: usize) -> AgentResult<KnowledgeSearchPage> {
    if serialized_chars(&page)? > budget {
        return Err(AgentError::new(
            ErrorCode::BudgetExceeded,
            "Registry search does not fit budget",
        ));
    }
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            access::{Caller, ScopeGrant},
            context::ContextGetInput,
            context::{EpistemicStatus, OverviewItem, SourceCoverage},
            knowledge::{KnowledgeBodySection, KnowledgeKind, KnowledgeNodeWrite},
            models::{ObjectKind, ObjectRef, SourceRef, WorkspaceBinding},
            overview::OverviewPublishInput,
            service::AgentDomainService,
        },
        committed_changes::{CommittedChangePublisher, CommittedChanges},
        db::Database,
        models::{ProjectCreateInput, TodoCreateInput, TodoScope},
        source_service::{SourcePolicyUpdate, SourceReadTarget},
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
    fn setup() -> (tempfile::TempDir, Store, RequestContext, Scope, ObjectRef) {
        let root = tempfile::tempdir().unwrap();
        let mut db =
            Database::open(&root.path().join("registry.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("registry-w").unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "知识项目".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let todo = db
            .todo_create(TodoCreateInput {
                scope: TodoScope::Project,
                project_id: Some(project.id),
                content: "真实依据".into(),
                priority: "normal".into(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
        let scope = Scope::Project {
            project_id: project.id,
        };
        let binding = WorkspaceBinding {
            workspace_id: "registry-w".into(),
            generation: "one".into(),
        };
        let request = RequestContext {
            binding: binding.clone(),
            request_id: "registry-read".into(),
            caller: Caller::Gui,
            scope_grant: ScopeGrant {
                object_keys: None,
                workspace_id: binding.workspace_id.clone(),
                workspace_content: false,
                project_ids: vec![project.id],
                operations: vec![
                    "context.read".into(),
                    "source.read".into(),
                    "settings.write".into(),
                ],
            },
        };
        let object = ObjectRef {
            workspace_id: binding.workspace_id.clone(),
            scope: scope.clone(),
            kind: ObjectKind::Todo,
            id: todo.id.to_string(),
        };
        let source = db
            .source_native_snapshot(
                &request,
                &binding,
                &SourceReadTarget {
                    object: object.clone(),
                    revision: None,
                    record_version: None,
                    file_version: None,
                },
            )
            .unwrap();
        let reference = SourceRef {
            object: object.clone(),
            revision: source.revision,
            file_version: None,
            record_version: None,
            block_id: None,
            locator: None,
            title: source.title,
            excerpt: "真实依据".into(),
        };
        let coverage = SourceCoverage {
            processed: 1,
            partial: 0,
            excluded: 0,
            unsupported: 0,
            pending: 0,
        };
        let items = (0..3)
            .map(|n| OverviewItem {
                id: format!("entry-{n}"),
                section: OverviewSection::Progress,
                text: if n == 0 {
                    "统一知识中文正文".repeat(250)
                } else {
                    format!("统一知识条目{n}")
                },
                epistemic_status: EpistemicStatus::Recorded,
                source_refs: vec![reference.clone()],
            published_sources: vec![],
                dependency_item_ids: vec![],
                valid_state: ValidState::Current,
                updated_at: "time".into(),
            })
            .collect();
        let nodes = (0..2)
            .map(|n| KnowledgeNodeWrite {
            memory: None,
                node_id: format!("topic-{n}"),
                expected_revision: 0,
                kind: KnowledgeKind::Topic,
                title: format!("统一知识主题{n}"),
                one_line: "可读取的真实节点".into(),
                summary: "简短的真实知识摘要".into(),
                body_sections: vec![KnowledgeBodySection {
                    id: "body".into(),
                    title: "正文".into(),
                    text: "独立知识正文".into(),
                }],
                aliases: vec![],
                keywords: vec![],
                source_refs: vec![reference.clone()],
            published_sources: vec![],
                epistemic_status: EpistemicStatus::Recorded,
                coverage: coverage.clone(),
                related: vec![],
                session_summary: None,
            })
            .collect();
        let input = OverviewPublishInput {
            expected_memory_epoch: 0,
            scope: scope.clone(),
            batch_id: "registry-batch-0".into(),
            expected_revision: 0,
            target_seq: db.committed_change_watermark().unwrap() as u64,
            policy_revision: 0,
            correction_revision: 0,
            upsert_items: items,
            remove_item_ids: vec![],
            settled_object_keys: vec![],
            knowledge_upserts: nodes,
            knowledge_removes: vec![],
            coverage,
            source_manifest_hash: "test-fixture".into(),
            model_profile_id: "test".into(),
        };
        db.agent_overview_publish("gui", "registry-publish", "registry-w", &input, |_, _| {
            Ok(())
        })
        .unwrap();
        (
            root,
            Store {
                binding,
                db: Mutex::new(db),
            },
            request,
            scope,
            object,
        )
    }
    fn read(scope: &Scope, id: &str) -> KnowledgeGetInput {
        KnowledgeGetInput {
            scope: scope.clone(),
            node_id: id.into(),
            version: None,
            view: KnowledgeView::Summary,
            section_ids: vec![],
            cursor: None,
            budget_chars: None,
        }
    }
    #[tokio::test]
    async fn registry_overview_entry_uses_authority_and_unicode_cursor_without_copying() {
        let (_root, store, request, scope, _) = setup();
        let registry = KnowledgeRegistry::new(&store);
        let mut input = read(&scope, "overview:entry-0");
        input.view = KnowledgeView::Outline;
        let outline = registry.get(&request, &input).await.unwrap();
        assert!(outline.summary.is_none());
        assert!(outline.source_refs.is_empty());
        assert!(outline.sections[0].text.is_none());
        input.view = KnowledgeView::Content;
        input.budget_chars = Some(1800);
        let mut text = String::new();
        loop {
            let page = registry.get(&request, &input).await.unwrap();
            assert!(serialized_chars(&page).unwrap() <= 1800);
            assert_eq!(page.kind, "overview_item");
            text.push_str(page.sections[0].text.as_ref().unwrap());
            input.cursor = page.next_cursor;
            if input.cursor.is_none() {
                break;
            }
        }
        assert_eq!(text, "统一知识中文正文".repeat(250));
        let summary = registry
            .get(&request, &read(&scope, "overview:entry-1"))
            .await
            .unwrap();
        assert!(serialized_chars(&summary).unwrap() <= 1200);
        assert_eq!(summary.summary.as_deref(), Some("统一知识条目1"));
        assert!(store
            .db
            .lock()
            .unwrap()
            .agent_knowledge_get(&scope, "entry-0", None)
            .unwrap()
            .is_none());
    }
    #[test]
    fn registry_search_paginates_real_nodes_then_overview_without_skips_or_duplicates() {
        let (_root, store, request, scope, _) = setup();
        let registry = KnowledgeRegistry::new(&store);
        let mut input = KnowledgeSearchInput {
            scope,
            query: "统一知识".into(),
            kinds: vec![],
            cursor: None,
            limit: Some(1),
            budget_chars: Some(1500),
        };
        let mut ids = vec![];
        loop {
            let page = registry.search(&request, &input).unwrap();
            assert!(serialized_chars(&page).unwrap() <= 1500);
            assert!(!page.source_fallback_required);
            ids.extend(page.items.into_iter().map(|card| card.node_id));
            input.cursor = page.next_cursor;
            if input.cursor.is_none() {
                break;
            }
        }
        assert_eq!(
            ids,
            vec![
                "node:topic-0",
                "node:topic-1",
                "overview:entry-0",
                "overview:entry-1",
                "overview:entry-2"
            ]
        );
        input.query = "不匹配任何内容".into();
        assert!(
            registry
                .search(&request, &input)
                .unwrap()
                .source_fallback_required
        );
    }
    #[tokio::test]
    async fn registry_l0_ids_resolve_and_source_exclusion_hides_both_authorities() {
        let (_root, store, request, scope, object) = setup();
        let registry = KnowledgeRegistry::new(&store);
        let entry = store
            .with_current(|binding, db| {
                let repo = crate::db::agent::WorkspaceContextRepository {
                    db,
                    workspace_name: "workspace",
                };
                AgentDomainService::new(binding, &repo).context_get(
                    &request,
                    ContextGetInput {
                        scope: scope.clone(),
                        query: Some("统一知识".into()),
                        budget_chars: None,
                    },
                )
            })
            .unwrap();
        assert!(!entry.nodes.is_empty());
        for card in entry.nodes {
            let mut input = read(&scope, &card.node_id);
            input.view = KnowledgeView::Outline;
            registry.get(&request, &input).await.unwrap();
        }
        store
            .db
            .lock()
            .unwrap()
            .source_policy_update(
                &request,
                &store.binding,
                &SourcePolicyUpdate {
                    object,
                    expected_revision: 0,
                    excluded: true,
                },
            )
            .unwrap();
        for id in ["node:topic-0", "overview:entry-0"] {
            let mut input = read(&scope, id);
            input.version = Some(1);
            assert_eq!(
                registry.get(&request, &input).await.unwrap_err().code,
                ErrorCode::NotFound
            );
        }
        let page = registry
            .search(
                &request,
                &KnowledgeSearchInput {
                    scope: scope.clone(),
                    query: "统一知识".into(),
                    kinds: vec![],
                    cursor: None,
                    limit: None,
                    budget_chars: None,
                },
            )
            .unwrap();
        assert!(page.items.is_empty());
        assert!(page.source_fallback_required);
        let mut denied = request;
        denied.scope_grant.project_ids.clear();
        assert_eq!(
            registry
                .get(&denied, &read(&scope, "overview:entry-0"))
                .await
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
    }
}
