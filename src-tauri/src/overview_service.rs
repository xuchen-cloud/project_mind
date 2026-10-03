//! Internal deterministic Overview service. Source text remains in its original
//! repositories; derived bodies are visible only while their sources are allowed.
use crate::{
    agent::{
        access::{Caller, RequestContext},
        context::{
            serialized_chars, AiOverview, OverviewItem, OverviewSection, SourceCoverage, ValidState,
        },
        errors::{AgentError, AgentResult, ErrorCode},
        models::{Scope, WorkspaceBinding},
        overview::{
            OverviewCorrectionDelete, OverviewCorrectionUpsert, OverviewCorrections,
            OverviewPublishInput,
        },
        repository::ContextRepository,
    },
    db::Database,
    overview_evidence::{
        reference_file_plan, reference_state, CapturedEvidence, FileReferenceProof,
    },
    source_service::BoundSourceStore,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OverviewReadInput {
    pub scope: Scope,
    pub version: Option<u64>,
    #[serde(default)]
    pub sections: Vec<OverviewSection>,
    #[serde(default)]
    pub item_ids: Vec<String>,
    pub cursor: Option<String>,
    pub budget_chars: Option<usize>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverviewDirectoryEntry {
    pub section: OverviewSection,
    pub count: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverviewReadItem {
    pub item: OverviewItem,
    pub text_offset: usize,
    pub complete: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverviewReadPage {
    pub scope: Scope,
    pub revision: Option<u64>,
    pub sections: Vec<OverviewDirectoryEntry>,
    pub items: Vec<OverviewReadItem>,
    pub stale: bool,
    pub coverage: Option<SourceCoverage>,
    pub as_of_seq: u64,
    pub pending_count: u64,
    pub needs_rebuild: bool,
    pub correction_revision: u64,
    pub next_cursor: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    scope: Scope,
    revision: u64,
    selection: String,
    visibility: String,
    item: usize,
    offset: usize,
}
fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn changed() -> AgentError {
    AgentError::new(
        ErrorCode::SourceChanged,
        "Overview or its visible evidence changed; restart reading",
    )
}
fn hash(value: &impl Serialize) -> AgentResult<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(value).map_err(|_| invalid("Invalid Overview selection"))?
        )
    ))
}
fn authorize(
    db: &Database,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    scope: &Scope,
    operation: &str,
) -> AgentResult<()> {
    request.authorize(binding, scope, operation)?;
    if !matches!(scope, Scope::Project { .. }) {
        return Err(AgentError::new(
            ErrorCode::SourceNotReady,
            "Workspace Overview is supplied by M2",
        ));
    }
    let identity = crate::db::agent::WorkspaceContextRepository {
        db,
        workspace_name: "",
    }
    .scope_identity(scope)?
    .ok_or_else(|| AgentError::new(ErrorCode::NotFound, "Overview scope no longer exists"))?;
    if identity.archived {
        return Err(AgentError::new(
            ErrorCode::ScopeDenied,
            "Archived Project is outside the active AI scope",
        ));
    }
    Ok(())
}
fn unavailable(error: &AgentError) -> bool {
    matches!(
        error.code,
        ErrorCode::ScopeDenied
            | ErrorCode::NotFound
            | ErrorCode::SourceNotReady
            | ErrorCode::SourceChanged
            | ErrorCode::FileChangedUnregistered
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverviewPublishReceipt {
    pub scope: Scope,
    pub revision: u64,
    pub as_of_seq: u64,
}
impl From<AiOverview> for OverviewPublishReceipt {
    fn from(value: AiOverview) -> Self {
        Self {
            scope: value.scope,
            revision: value.revision,
            as_of_seq: value.as_of_seq,
        }
    }
}
pub(crate) struct OverviewService<'a, S> {
    store: &'a S,
}
impl<'a, S: BoundSourceStore> OverviewService<'a, S> {
    pub(crate) fn new(store: &'a S) -> Self {
        Self { store }
    }
    /// A maintenance caller fixes targetSeq on its first page. This metadata
    /// ledger survives log pruning; reading it never acknowledges a change.
    pub(crate) fn pending(
        &self,
        request: &RequestContext,
        scope: &Scope,
        target_seq: Option<u64>,
        after_key: Option<&str>,
        limit: u16,
    ) -> AgentResult<crate::agent::overview::OverviewPendingPage> {
        self.store.with_current(|binding, db| {
            authorize(db, request, binding, scope, "knowledge.write")?;
            if after_key.is_some() && target_seq.is_none() {
                return Err(invalid(
                    "A pending continuation requires its original targetSeq",
                ));
            }
            let target_seq = match target_seq {
                Some(seq) => seq,
                None => db.committed_change_watermark()? as u64,
            };
            db.agent_overview_pending_page(scope, target_seq, after_key, limit)
        })
    }
    pub(crate) async fn publish(
        &self,
        request: &RequestContext,
        input: &OverviewPublishInput,
        evidence: &[CapturedEvidence],
    ) -> AgentResult<OverviewPublishReceipt> {
        input.validate()?;
        let replay = self.store.with_current(|binding, db| {
            authorize(db, request, binding, &input.scope, "knowledge.write")?;
            let prefix = format!("{}/{}/", binding.workspace_id, input.scope.key());
            if input
                .settled_object_keys
                .iter()
                .any(|key| !key.starts_with(&prefix))
            {
                return Err(AgentError::new(
                    ErrorCode::ScopeDenied,
                    "Pending object is outside this Workspace",
                ));
            }
            db.agent_overview_replay(&request.caller.key(), &request.request_id, input)
        })?;
        if let Some(receipt) = replay {
            return Ok(receipt.into());
        }
        for reference in input.upsert_items.iter().flat_map(|item| &item.source_refs) {
            let captured = evidence
                .iter()
                .find(|captured| captured.matches(reference))
                .ok_or_else(|| {
                    invalid("Overview evidence must be returned by a source read in this operation")
                })?;
            captured.verify_file().await?;
        }
        let (result, changes) = self.store.with_current(|binding, db| {
            authorize(db, request, binding, &input.scope, "knowledge.write")?;
            crate::committed_changes::capture_committed(binding, db, &request.request_id, || {
                db.agent_overview_publish(
                    &request.caller.key(),
                    &request.request_id,
                    &binding.workspace_id,
                    input,
                    |db, items| {
                        for reference in items.iter().flat_map(|item| &item.source_refs) {
                            evidence
                                .iter()
                                .find(|captured| captured.matches(reference))
                                .ok_or_else(|| invalid("Missing captured Overview evidence"))?
                                .verify(db, request, binding)?;
                        }
                        Ok(())
                    },
                )
            })
        })?;
        if let Some(changes) = changes {
            self.store.publish_committed(changes);
        }
        result.map(Into::into)
    }
    pub(crate) fn corrections(
        &self,
        request: &RequestContext,
        scope: &Scope,
    ) -> AgentResult<OverviewCorrections> {
        self.store.with_current(|binding, db| {
            authorize(db, request, binding, scope, "settings.read")?;
            if !matches!(request.caller, Caller::Gui) {
                return Err(AgentError::new(
                    ErrorCode::ScopeDenied,
                    "User corrections require the trusted GUI",
                ));
            }
            db.agent_overview_corrections(scope)
        })
    }
    pub(crate) fn correction_upsert(
        &self,
        request: &RequestContext,
        input: &OverviewCorrectionUpsert,
    ) -> AgentResult<OverviewCorrections> {
        self.write_correction(request, &input.scope, |db| {
            db.agent_overview_correction_upsert(&request.caller.key(), &request.request_id, input)
        })
    }
    pub(crate) fn correction_delete(
        &self,
        request: &RequestContext,
        input: &OverviewCorrectionDelete,
    ) -> AgentResult<OverviewCorrections> {
        self.write_correction(request, &input.scope, |db| {
            db.agent_overview_correction_delete(&request.caller.key(), &request.request_id, input)
        })
    }
    fn write_correction<T>(
        &self,
        request: &RequestContext,
        scope: &Scope,
        action: impl FnOnce(&Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        let (result, changes) = self.store.with_current(|binding, db| {
            authorize(db, request, binding, scope, "settings.write")?;
            if !matches!(request.caller, Caller::Gui) {
                return Err(AgentError::new(
                    ErrorCode::ScopeDenied,
                    "Only the user can change Overview corrections",
                ));
            }
            crate::committed_changes::capture_committed(binding, db, &request.request_id, || {
                action(db)
            })
        })?;
        if let Some(changes) = changes {
            self.store.publish_committed(changes);
        }
        result
    }
    pub(crate) async fn get(
        &self,
        request: &RequestContext,
        input: &OverviewReadInput,
    ) -> AgentResult<OverviewReadPage> {
        let budget = input.budget_chars.unwrap_or(4000).min(8000);
        if budget == 0
            || input.version == Some(0)
            || input.item_ids.len() > 100
            || input.sections.len() > 5
        {
            return Err(invalid("Invalid Overview selection or budget"));
        }
        let cursor: Option<Cursor> = input
            .cursor
            .as_ref()
            .map(|value| {
                if value.len() > 2048 {
                    return Err(invalid("Invalid Overview cursor"));
                }
                serde_json::from_slice(
                    &URL_SAFE_NO_PAD
                        .decode(value)
                        .map_err(|_| invalid("Invalid Overview cursor"))?,
                )
                .map_err(|_| invalid("Invalid Overview cursor"))
            })
            .transpose()?;
        let snapshot = self.store.with_current(|binding, db| {
            authorize(db, request, binding, &input.scope, "context.read")?;
            match input.version {
                Some(version) => db.agent_overview_version(&input.scope, version),
                None => db.agent_overview_head(&input.scope),
            }
        })?;
        let Some(snapshot) = snapshot else {
            if input.version.is_some() {
                return Err(AgentError::new(
                    ErrorCode::NotFound,
                    "Overview version is unavailable",
                ));
            }
            if cursor.is_some() {
                return Err(changed());
            }
            let (correction_revision, pending) = self.store.with_current(|binding, db| {
                authorize(db, request, binding, &input.scope, "context.read")?;
                Ok((
                    db.agent_overview_corrections(&input.scope)?.revision,
                    db.agent_overview_pending_status(&input.scope)?,
                ))
            })?;
            let page = OverviewReadPage {
                scope: input.scope.clone(),
                revision: None,
                sections: vec![],
                items: vec![],
                stale: false,
                coverage: None,
                as_of_seq: 0,
                pending_count: pending.pending_count,
                needs_rebuild: pending.needs_rebuild,
                correction_revision,
                next_cursor: None,
            };
            ensure_budget(&page, budget)?;
            return Ok(page);
        };
        let mut wanted: HashSet<String> = snapshot
            .items
            .iter()
            .filter(|item| {
                input.item_ids.contains(&item.id)
                    || input
                        .sections
                        .iter()
                        .any(|section| same_section(&item.section, section))
            })
            .map(|item| item.id.clone())
            .collect();
        loop {
            let before = wanted.len();
            for item in &snapshot.items {
                if wanted.contains(&item.id) {
                    wanted.extend(item.dependency_item_ids.iter().cloned());
                }
            }
            if before == wanted.len() {
                break;
            }
        }
        // context.read authorizes derived knowledge, not a public source tool.
        // Reuse the source verifier internally without widening the caller's
        // scopes or returning the verifier's original content to that caller.
        let mut read_request = request.clone();
        if !read_request
            .scope_grant
            .operations
            .iter()
            .any(|operation| operation == "source.read")
        {
            read_request
                .scope_grant
                .operations
                .push("source.read".into());
        }
        // Filesystem checks are outside the database lock. Each proof is checked
        // against the same retained version again inside the final read phase.
        let mut proofs = Vec::new();
        let mut unavailable_files = HashSet::new();
        for reference in snapshot
            .items
            .iter()
            .filter(|item| wanted.contains(&item.id))
            .flat_map(|item| &item.source_refs)
        {
            let key = hash(&(
                &reference.object,
                &reference.revision,
                reference.record_version,
                reference.file_version,
            ))?;
            if proofs
                .iter()
                .any(|(existing, _): &(String, FileReferenceProof)| existing == &key)
                || unavailable_files.contains(&key)
            {
                continue;
            }
            let plan = self.store.with_current(|binding, db| {
                authorize(db, request, binding, &input.scope, "context.read")?;
                reference_file_plan(db, &read_request, binding, reference)
            });
            match plan {
                Ok(Some(plan)) => match FileReferenceProof::prepare(plan).await {
                    Ok(proof) => proofs.push((key, proof)),
                    Err(error) if unavailable(&error) => {
                        unavailable_files.insert(key);
                    }
                    Err(error) => return Err(error),
                },
                Ok(None) => (),
                Err(error) if unavailable(&error) => {
                    unavailable_files.insert(key);
                }
                Err(error) => return Err(error),
            }
        }
        self.store.with_current(|binding, db| {
            authorize(db, request, binding, &input.scope, "context.read")?;
            if input.version.is_none()
                && db
                    .agent_overview_head(&input.scope)?
                    .is_none_or(|head| head.revision != snapshot.revision)
            {
                return Err(changed());
            }
            let corrections = db.agent_overview_corrections(&input.scope)?;
            let mut hidden = HashSet::new();
            let mut stale: HashSet<String> = db
                .agent_overview_stale_items(&binding.workspace_id, &input.scope)?
                .into_iter()
                .collect();
            for item in &snapshot.items {
                for reference in &item.source_refs {
                    let key = hash(&(
                        &reference.object,
                        &reference.revision,
                        reference.record_version,
                        reference.file_version,
                    ))?;
                    if unavailable_files.contains(&key) {
                        hidden.insert(item.id.clone());
                        continue;
                    }
                    let state = if wanted.contains(&item.id) {
                        reference_state(db, &read_request, binding, reference)
                    } else {
                        db.source_read_object(&read_request, binding, &reference.object)
                            .map(|_| false)
                    };
                    let state = state.and_then(|stale| {
                        if let Some((_, proof)) =
                            proofs.iter().find(|(candidate, _)| candidate == &key)
                        {
                            proof.verify(db, &read_request, binding, reference)?;
                        }
                        Ok(stale)
                    });
                    match state {
                        Ok(true) => {
                            stale.insert(item.id.clone());
                        }
                        Ok(false) => (),
                        Err(error) if unavailable(&error) => {
                            hidden.insert(item.id.clone());
                        }
                        Err(error) => return Err(error),
                    }
                }
            }
            // At most 100 validated items; propagate only IDs, never recursively
            // load bodies or follow arbitrary related resources.
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
            let mut visible: Vec<_> = snapshot
                .items
                .iter()
                .filter(|item| !hidden.contains(&item.id))
                .cloned()
                .collect();
            let (published_policy, published_corrections) =
                db.agent_overview_version_baselines(&input.scope, snapshot.revision)?;
            let policy_changed = published_corrections != corrections.revision
                || published_policy
                    != crate::agent::settings::SettingsRepository::agent_settings_get(
                        db,
                        &input.scope,
                    )?
                    .revision;
            for item in &mut visible {
                if stale.contains(&item.id)
                    || (policy_changed && matches!(item.valid_state, ValidState::Current))
                {
                    item.valid_state = ValidState::Stale;
                }
            }
            let pending = db.agent_overview_pending_status(&input.scope)?;
            let mut snapshot = snapshot.clone();
            snapshot.pending_count = pending.pending_count;
            snapshot.coverage.pending = pending.pending_count;
            let mut page = project(
                input,
                &snapshot,
                visible,
                corrections.revision,
                pending.needs_rebuild,
                cursor,
                budget,
            )?;
            page.stale |= policy_changed || pending.pending_count > 0;
            ensure_budget(&page, budget)?;
            Ok(page)
        })
    }
}
fn ensure_budget(page: &OverviewReadPage, budget: usize) -> AgentResult<()> {
    if serialized_chars(page)? > budget {
        return Err(AgentError::new(
            ErrorCode::BudgetExceeded,
            "Overview metadata does not fit the read budget",
        ));
    }
    Ok(())
}
fn project(
    input: &OverviewReadInput,
    snapshot: &AiOverview,
    visible: Vec<OverviewItem>,
    correction_revision: u64,
    needs_rebuild: bool,
    cursor: Option<Cursor>,
    budget: usize,
) -> AgentResult<OverviewReadPage> {
    let selection = hash(&(&input.sections, &input.item_ids, input.version))?;
    let visibility = hash(&(&visible, correction_revision))?;
    let mut page = OverviewReadPage {
        scope: input.scope.clone(),
        revision: Some(snapshot.revision),
        sections: vec![],
        items: vec![],
        stale: visible
            .iter()
            .any(|item| matches!(item.valid_state, ValidState::Stale)),
        coverage: Some(snapshot.coverage.clone()),
        as_of_seq: snapshot.as_of_seq,
        pending_count: snapshot.pending_count,
        needs_rebuild,
        correction_revision,
        next_cursor: None,
    };
    for section in [
        OverviewSection::Profile,
        OverviewSection::Progress,
        OverviewSection::KnowledgeMap,
        OverviewSection::Actions,
        OverviewSection::OpenQuestions,
    ] {
        let count = visible
            .iter()
            .filter(|item| same_section(&item.section, &section))
            .count();
        if count > 0 {
            page.sections
                .push(OverviewDirectoryEntry { section, count });
        }
    }
    if input.sections.is_empty() && input.item_ids.is_empty() {
        if cursor.is_some() {
            return Err(invalid("An Overview directory has no body cursor"));
        }
        ensure_budget(&page, budget)?;
        return Ok(page);
    }
    let selected: Vec<_> = visible
        .into_iter()
        .filter(|item| {
            input.item_ids.contains(&item.id)
                || input
                    .sections
                    .iter()
                    .any(|section| same_section(&item.section, section))
        })
        .collect();
    let (index, offset) = match cursor {
        Some(cursor) => {
            if cursor.scope != input.scope || cursor.selection != selection {
                return Err(invalid("Overview cursor belongs to another selection"));
            }
            if cursor.revision != snapshot.revision || cursor.visibility != visibility {
                return Err(changed());
            }
            if cursor.item >= selected.len() {
                return Err(invalid("Overview cursor is out of range"));
            }
            (cursor.item, cursor.offset)
        }
        None => (0, 0),
    };
    let Some(item) = selected.get(index) else {
        ensure_budget(&page, budget)?;
        return Ok(page);
    };
    let chars: Vec<char> = item.text.chars().collect();
    if offset > chars.len() || (offset == chars.len() && offset != 0) {
        return Err(invalid("Overview text cursor is out of range"));
    }
    let make = |count: usize| -> AgentResult<(OverviewReadItem, Option<String>)> {
        let end = offset + count;
        let mut partial = item.clone();
        partial.text = chars[offset..end].iter().collect();
        let next = if end < chars.len() {
            Some((index, end))
        } else if index + 1 < selected.len() {
            Some((index + 1, 0))
        } else {
            None
        };
        let next_cursor = next
            .map(|(item, offset)| {
                serde_json::to_vec(&Cursor {
                    scope: input.scope.clone(),
                    revision: snapshot.revision,
                    selection: selection.clone(),
                    visibility: visibility.clone(),
                    item,
                    offset,
                })
                .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
                .map_err(|_| invalid("Cannot encode Overview cursor"))
            })
            .transpose()?;
        Ok((
            OverviewReadItem {
                item: partial,
                text_offset: offset,
                complete: end == chars.len(),
            },
            next_cursor,
        ))
    };
    let (mut low, mut high) = (0, chars.len() - offset);
    while low < high {
        let middle = (low + high + 1) / 2;
        let (item, next) = make(middle)?;
        page.items = vec![item];
        page.next_cursor = next;
        if serialized_chars(&page)? <= budget {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    let (item, next) = make(low)?;
    page.items = vec![item];
    page.next_cursor = next;
    if low == 0 && offset < chars.len() {
        return Err(AgentError::new(
            ErrorCode::BudgetExceeded,
            "Overview evidence metadata leaves no room for text",
        ));
    }
    ensure_budget(&page, budget)?;
    Ok(page)
}
fn same_section(left: &OverviewSection, right: &OverviewSection) -> bool {
    std::mem::discriminant(left) == std::mem::discriminant(right)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            access::ScopeGrant,
            context::EpistemicStatus,
            models::{ObjectKind, ObjectRef},
        },
        committed_changes::{CommittedChangePublisher, CommittedChanges},
        models::{ProjectCreateInput, TodoCreateInput, TodoScope, TodoUpdateContentInput},
        record_document_service::DocumentUtility,
        source_service::{
            SourceReadInput, SourceReadTarget, SourceReadView, SourceService, SourceUtility,
        },
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    };
    struct Store {
        binding: WorkspaceBinding,
        db: Mutex<Database>,
        notifications: AtomicUsize,
    }
    impl CommittedChangePublisher for Store {
        fn publish_committed(&self, _: CommittedChanges) {
            assert!(
                self.db.try_lock().is_ok(),
                "notify after releasing database lock"
            );
            self.notifications.fetch_add(1, Ordering::SeqCst);
        }
    }
    impl BoundSourceStore for Store {
        fn with_current<T>(
            &self,
            action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
        ) -> AgentResult<T> {
            action(&self.binding, &self.db.lock().unwrap())
        }
    }
    struct Utility;
    impl DocumentUtility for Utility {
        async fn request(
            &self,
            _: &str,
            _: &str,
            _: serde_json::Value,
        ) -> AgentResult<serde_json::Value> {
            panic!("native fixture must not convert Record bodies")
        }
    }
    impl SourceUtility for Utility {
        async fn request(
            &self,
            _: &str,
            _: &str,
            _: &str,
            bytes: &[u8],
        ) -> AgentResult<serde_json::Value> {
            let text = std::str::from_utf8(bytes).unwrap();
            Ok(
                serde_json::json!({"state":"ready","coverage":{"complete":true,"chars":text.chars().count()},"reason":null,"chunks":[{"text":text,"range":{"start":0,"end":text.chars().count()},"locator":{"kind":"paragraph","start":1,"end":1}}]}),
            )
        }
    }
    fn setup() -> (tempfile::TempDir, Store, RequestContext, SourceReadInput) {
        let root = tempfile::tempdir().unwrap();
        let mut db =
            Database::open(&root.path().join("overview.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("overview-workspace").unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Overview project".into(),
                summary: Some("用户QuickNote不能被概览覆盖".into()),
                status: None,
            })
            .unwrap();
        let todo = db
            .todo_create(TodoCreateInput {
                scope: TodoScope::Project,
                project_id: Some(project.id),
                content: "真实来源任务".into(),
                priority: "normal".into(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "overview-workspace".into(),
            generation: "open-one".into(),
        };
        let request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "publish-one".into(),
            scope_grant: ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: false,
                project_ids: vec![project.id],
                operations: [
                    "context.read",
                    "knowledge.write",
                    "source.read",
                    "settings.read",
                    "settings.write",
                ]
                .map(String::from)
                .to_vec(),
            },
        };
        let input = SourceReadInput {
            source: SourceReadTarget {
                object: ObjectRef {
                    workspace_id: binding.workspace_id.clone(),
                    scope: Scope::Project {
                        project_id: project.id,
                    },
                    kind: ObjectKind::Todo,
                    id: todo.id.to_string(),
                },
                revision: None,
                record_version: None,
                file_version: None,
            },
            view: SourceReadView::Full,
            selection: None,
            cursor: None,
            budget_chars: None,
        };
        (
            root,
            Store {
                binding,
                db: Mutex::new(db),
                notifications: AtomicUsize::new(0),
            },
            request,
            input,
        )
    }
    async fn candidate(
        store: &Store,
        request: &RequestContext,
        source: &SourceReadInput,
    ) -> (OverviewPublishInput, Vec<CapturedEvidence>) {
        let (_, captured) =
            crate::overview_evidence::capture(store, request, source, &Utility, &Utility)
                .await
                .unwrap();
        let input = OverviewPublishInput {
            scope: source.source.object.scope.clone(),
            expected_revision: 0,
            target_seq: store
                .db
                .lock()
                .unwrap()
                .committed_change_watermark()
                .unwrap() as u64,
            policy_revision: 0,
            correction_revision: 0,
            upsert_items: vec![OverviewItem {
                id: "progress-one".into(),
                section: OverviewSection::Progress,
                text: "基于实际任务的进展".into(),
                epistemic_status: EpistemicStatus::Recorded,
                source_refs: vec![captured.reference().clone()],
                dependency_item_ids: vec![],
                valid_state: ValidState::Current,
                updated_at: "2026-10-03T00:00:00Z".into(),
            }],
            remove_item_ids: vec![],
            settled_object_keys: vec![],
            coverage: SourceCoverage {
                processed: 1,
                partial: 0,
                excluded: 0,
                unsupported: 0,
                pending: 1,
            },
            source_manifest_hash: format!("sha256:{}", "a".repeat(64)),
            model_profile_id: "deterministic-test".into(),
        };
        (input, vec![captured])
    }
    fn selection(scope: &Scope, body: bool) -> OverviewReadInput {
        OverviewReadInput {
            scope: scope.clone(),
            version: None,
            sections: if body {
                vec![OverviewSection::Progress]
            } else {
                vec![]
            },
            item_ids: vec![],
            cursor: None,
            budget_chars: None,
        }
    }
    fn edit(store: &Store, input: &SourceReadInput) {
        store
            .db
            .lock()
            .unwrap()
            .todo_update_content(TodoUpdateContentInput {
                todo_id: input.source.object.id.parse().unwrap(),
                content: "后来变更的来源".into(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
    }
    #[tokio::test]
    async fn overview_service_directory_is_body_free_and_selected_unicode_pages_are_exact() {
        let (_root, store, request, source) = setup();
        let (mut input, evidence) = candidate(&store, &request, &source).await;
        input.upsert_items[0].text = "🙂中文完整内容".repeat(300);
        let service = OverviewService::new(&store);
        let receipt = service.publish(&request, &input, &evidence).await.unwrap();
        assert_eq!(receipt.revision, 1);
        let mut reader = request.clone();
        reader.scope_grant.operations = vec!["context.read".into()];
        let directory = service
            .get(&reader, &selection(&input.scope, false))
            .await
            .unwrap();
        assert_eq!(directory.sections.len(), 1);
        assert!(directory.items.is_empty());
        assert!(!serde_json::to_string(&directory).unwrap().contains("基于"));
        let mut read = selection(&input.scope, true);
        read.budget_chars = Some(1800);
        let mut text = String::new();
        loop {
            let page = service.get(&reader, &read).await.unwrap();
            assert!(serialized_chars(&page).unwrap() <= 1800);
            text.push_str(&page.items[0].item.text);
            read.cursor = page.next_cursor;
            if read.cursor.is_none() {
                break;
            }
        }
        assert_eq!(text, input.upsert_items[0].text);
        assert_eq!(store.notifications.load(Ordering::SeqCst), 1);
        reader.scope_grant.project_ids.clear();
        assert_eq!(
            service
                .get(&reader, &selection(&input.scope, true))
                .await
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
    }
    #[tokio::test]
    async fn overview_service_rejects_forged_and_changed_evidence_before_publication() {
        let (_root, store, request, source) = setup();
        let (mut input, evidence) = candidate(&store, &request, &source).await;
        let service = OverviewService::new(&store);
        let original = input.upsert_items[0].source_refs[0].excerpt.clone();
        input.upsert_items[0].source_refs[0].excerpt = "伪造摘录".into();
        assert_eq!(
            service
                .publish(&request, &input, &evidence)
                .await
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        input.upsert_items[0].source_refs[0].excerpt = original;
        edit(&store, &source);
        assert_eq!(
            service
                .publish(&request, &input, &evidence)
                .await
                .unwrap_err()
                .code,
            ErrorCode::SourceChanged
        );
        assert!(store
            .db
            .lock()
            .unwrap()
            .agent_overview_head(&input.scope)
            .unwrap()
            .is_none());
        assert_eq!(store.notifications.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn overview_service_source_changes_stale_but_exclusion_hides_transitive_body() {
        let (_root, store, mut request, source) = setup();
        let (mut input, evidence) = candidate(&store, &request, &source).await;
        let mut dependent = input.upsert_items[0].clone();
        dependent.id = "dependent".into();
        dependent.source_refs.clear();
        dependent.dependency_item_ids = vec!["progress-one".into()];
        input.upsert_items.push(dependent);
        let service = OverviewService::new(&store);
        service.publish(&request, &input, &evidence).await.unwrap();
        edit(&store, &source);
        let page = service
            .get(&request, &selection(&input.scope, true))
            .await
            .unwrap();
        assert!(page.stale);
        assert!(matches!(page.items[0].item.valid_state, ValidState::Stale));
        request.request_id = "exclude".into();
        SourceService::new(&store)
            .set_policy(
                &request,
                &crate::source_service::SourcePolicyUpdate {
                    object: source.source.object.clone(),
                    expected_revision: 0,
                    excluded: true,
                },
            )
            .unwrap();
        let page = service
            .get(&request, &selection(&input.scope, true))
            .await
            .unwrap();
        assert!(page.items.is_empty());
        assert!(page.sections.is_empty());
        let mut historical = selection(&input.scope, true);
        historical.version = Some(1);
        assert!(service
            .get(&request, &historical)
            .await
            .unwrap()
            .items
            .is_empty());
    }
    #[tokio::test]
    async fn overview_service_replay_returns_only_receipt_after_source_exclusion() {
        let (_root, store, request, source) = setup();
        let (input, evidence) = candidate(&store, &request, &source).await;
        let service = OverviewService::new(&store);
        let first = service.publish(&request, &input, &evidence).await.unwrap();
        let mut policy = request.clone();
        policy.request_id = "exclude".into();
        SourceService::new(&store)
            .set_policy(
                &policy,
                &crate::source_service::SourcePolicyUpdate {
                    object: source.source.object.clone(),
                    expected_revision: 0,
                    excluded: true,
                },
            )
            .unwrap();
        let replay = service.publish(&request, &input, &[]).await.unwrap();
        assert_eq!(replay.revision, first.revision);
        let wire = serde_json::to_value(replay).unwrap();
        assert_eq!(wire.as_object().unwrap().len(), 3);
        assert!(wire.get("items").is_none());
    }
    #[tokio::test]
    async fn overview_service_corrections_are_gui_owned_and_make_prior_snapshot_stale() {
        let (_root, store, mut request, source) = setup();
        let (input, evidence) = candidate(&store, &request, &source).await;
        let service = OverviewService::new(&store);
        service.publish(&request, &input, &evidence).await.unwrap();
        request.request_id = "user-correction".into();
        let correction = OverviewCorrectionUpsert {
            scope: input.scope.clone(),
            id: "correction".into(),
            item_id: Some("progress-one".into()),
            text: "这是计划，不是已完成".into(),
            expected_revision: 0,
        };
        let mut model = request.clone();
        model.caller = Caller::BuiltinRun {
            run_id: "fixture".into(),
        };
        assert_eq!(
            service
                .correction_upsert(&model, &correction)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        service.correction_upsert(&request, &correction).unwrap();
        let page = service
            .get(&request, &selection(&input.scope, true))
            .await
            .unwrap();
        assert!(page.stale);
        assert!(matches!(page.items[0].item.valid_state, ValidState::Stale));
        assert_eq!(page.correction_revision, 1);
        assert_eq!(
            service.corrections(&request, &input.scope).unwrap().items[0].text,
            correction.text
        );
        let mut historical = selection(&input.scope, true);
        historical.version = Some(1);
        assert_eq!(
            service
                .get(&request, &historical)
                .await
                .unwrap()
                .correction_revision,
            1
        );
    }
    #[tokio::test]
    async fn overview_service_file_capture_detects_external_bytes_and_directory_does_not_hash() {
        let (root, store, request, mut source) = setup();
        let selected = root.path().join("source.txt");
        std::fs::write(&selected, "原始已登记材料").unwrap();
        let Scope::Project { project_id } = source.source.object.scope else {
            panic!()
        };
        let file = store
            .db
            .lock()
            .unwrap()
            .document_import(crate::models::DocumentImportInput {
                project_id,
                source_path: selected.to_string_lossy().into(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        source.source.object.kind = ObjectKind::File;
        source.source.object.id = file.id.to_string();
        let (input, evidence) = candidate(&store, &request, &source).await;
        let service = OverviewService::new(&store);
        service.publish(&request, &input, &evidence).await.unwrap();
        std::fs::write(&file.managed_path, "外部覆盖的未知字节").unwrap();
        let directory = service
            .get(&request, &selection(&input.scope, false))
            .await
            .unwrap();
        assert_eq!(directory.sections.len(), 1);
        assert!(directory.items.is_empty());
        assert!(service
            .get(&request, &selection(&input.scope, true))
            .await
            .unwrap()
            .items
            .is_empty());
        let mut retry = request.clone();
        retry.request_id = "stale-evidence".into();
        let mut next = input;
        next.expected_revision = 1;
        next.target_seq = store
            .db
            .lock()
            .unwrap()
            .committed_change_watermark()
            .unwrap() as u64;
        assert!(matches!(
            service
                .publish(&retry, &next, &evidence)
                .await
                .unwrap_err()
                .code,
            ErrorCode::SourceChanged | ErrorCode::FileChangedUnregistered
        ));
    }
    #[tokio::test]
    async fn overview_service_pending_is_bound_and_only_publication_consumes_it() {
        let (_root, store, request, source) = setup();
        let service = OverviewService::new(&store);
        let scope = &source.source.object.scope;
        let before = service.pending(&request, scope, None, None, 200).unwrap();
        assert!(before.needs_rebuild);
        assert!(before.pending_count > 0);
        let again = service
            .pending(&request, scope, Some(before.target_seq), None, 200)
            .unwrap();
        assert_eq!(again.pending_count, before.pending_count);
        assert_eq!(
            service
                .pending(&request, scope, None, Some("continuation"), 200)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        let (mut input, evidence) = candidate(&store, &request, &source).await;
        input.settled_object_keys = before
            .items
            .iter()
            .map(|item| item.object_key.clone())
            .collect();
        let mut wrong = input.clone();
        wrong.settled_object_keys = vec![format!("other/{}/todo/1", scope.key())];
        assert_eq!(
            service
                .publish(&request, &wrong, &evidence)
                .await
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        let mut old = request.clone();
        old.binding.generation = "old-generation".into();
        assert_eq!(
            service
                .pending(&old, scope, None, None, 200)
                .unwrap_err()
                .code,
            ErrorCode::WorkspaceChanged
        );
        service.publish(&request, &input, &evidence).await.unwrap();
        let after = service.pending(&request, scope, None, None, 200).unwrap();
        assert_eq!(after.pending_count, 0);
        assert!(
            after.needs_rebuild,
            "acknowledged events do not prove initial inventory completeness"
        );
        let directory = service
            .get(&request, &selection(scope, false))
            .await
            .unwrap();
        assert_eq!(directory.pending_count, 0);
        assert!(directory.needs_rebuild);
        assert_eq!(directory.coverage.unwrap().pending, 0);
    }
}
