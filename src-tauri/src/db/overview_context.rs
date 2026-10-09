//! L0 reads independent identity and a short authorized Overview positioning.
//! Source checks inspect ownership/policy metadata, never bodies or File bytes.
use crate::{
    agent::{
        access::RequestContext,
        context::{
            ContextEntry, ContextGetInput, KnowledgeCard, KnowledgeStatus, OverviewSection,
            ScopeIdentity, ValidState,
        },
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind,ObjectRef,Scope,SourceRef, WorkspaceBinding},
        source_trace::derived_source_visible,
        settings::SettingsRepository,
    },
    db::Database,
};
use std::collections::HashSet;

fn hidden_source(error: &AgentError) -> bool {
    matches!(
        error.code,
        ErrorCode::NotFound
            | ErrorCode::ObjectWithdrawn
            | ErrorCode::ScopeDenied
            | ErrorCode::SourceNotReady
            | ErrorCode::SourceChanged
    )
}
impl Database {
    pub(crate) fn agent_overview_context_entry(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &ContextGetInput,
        identity: ScopeIdentity,
    ) -> AgentResult<ContextEntry> {
        request.authorize(binding, &input.scope, "context.read")?;
        if self
            .native_workspace_id
            .as_deref()
            .is_some_and(|id| id != binding.workspace_id)
        {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Context Workspace is no longer current",
            ));
        }
        // Workspace has no Overview until M2. Archived identity stays readable,
        // while its derived knowledge and source content remain unavailable.
        if matches!(input.scope, Scope::Workspace) || identity.archived {
            return ContextEntry::not_built(identity, input.budget_chars);
        }
        let Some(snapshot) = self.agent_overview_head(&input.scope)? else {
            return ContextEntry::not_built(identity, input.budget_chars);
        };
        // Trusted implementation-only operation: preserve every original scope
        // grant while reusing source metadata authorization for derived content.
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
        let mut stale: HashSet<String> = self
            .agent_overview_stale_items(&binding.workspace_id, &input.scope)?
            .into_iter()
            .collect();
        for item in &snapshot.items {
            for reference in &item.source_refs {
                match derived_source_visible(self, &source_request, binding, reference) {
                    Ok(_) => (),
                    Err(error) if hidden_source(&error) => {
                        hidden.insert(item.id.clone());
                    }
                    Err(error) => return Err(error),
                }
            }
            if matches!(item.valid_state, ValidState::Stale) {
                stale.insert(item.id.clone());
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
        let (published_policy, published_corrections) =
            self.agent_overview_version_baselines(&input.scope, snapshot.revision)?;
        let baseline_changed = published_policy != self.agent_settings_get(&input.scope)?.revision
            || published_corrections != self.agent_overview_corrections(&input.scope)?.revision;
        let pending = self.agent_overview_pending_status(&input.scope)?;
        let profile = snapshot.items.iter().find(|item| {
            matches!(item.section, OverviewSection::Profile) && !hidden.contains(&item.id)
        });
        let query = input.query.as_deref().unwrap_or("");
        let mut cards = Vec::new();
        // A bounded candidate page; authorization precedes every visible title.
        let candidates = self.agent_knowledge_candidates(&input.scope, query, &[], None, 50)?;
        let candidate_ids: Vec<_> = candidates.iter().map(|node| node.node_id.clone()).collect();
        let node_stale =
            self.agent_knowledge_stale_ids(&binding.workspace_id, &input.scope, &candidate_ids)?;
        let mut extra_nodes = false;
        let candidate_sources: std::collections::HashMap<_, _> = candidates
            .iter()
            .map(|node| {
                let mut refs=node.source_refs.clone();
                if node.session_summary.is_some() {
                    refs.push(SourceRef {object:ObjectRef {workspace_id:binding.workspace_id.clone(),scope:node.scope.clone(),kind:ObjectKind::SessionSummary,id:node.node_id.clone()},revision:node.revision.to_string(),file_version:None,record_version:None,block_id:None,locator:None,title:String::new(),excerpt:String::new()});
                }
                (format!("node:{}",node.node_id),refs)
            })
            .collect();
        for node in candidates {
            let mut visible = true;
            if node.session_summary.is_some() {
                match request.authorize(binding,&node.scope,"session.read") {
                    Ok(())=>(),
                    Err(error) if hidden_source(&error)=>visible=false,
                    Err(error)=>return Err(error),
                }
                if visible {
                    let object=ObjectRef {workspace_id:binding.workspace_id.clone(),scope:node.scope.clone(),kind:ObjectKind::SessionSummary,id:node.node_id.clone()};
                    match self.source_read_object(&source_request,binding,&object) {
                        Ok(_)=>(),
                        Err(error) if hidden_source(&error)=>visible=false,
                        Err(error)=>return Err(error),
                    }
                }
            }
            if !visible {continue;}
            for reference in &node.source_refs {
                match derived_source_visible(self, &source_request, binding, reference) {
                    Ok(_) => (),
                    Err(error) if hidden_source(&error) => {
                        visible = false;
                        break;
                    }
                    Err(error) => return Err(error),
                }
            }
            if !visible {
                continue;
            }
            if cards.len() == 8 {
                extra_nodes = true;
                break;
            }
            cards.push(KnowledgeCard {
                node_id: format!("node:{}", node.node_id),
                title: node.title,
                one_line: node.one_line.chars().take(240).collect(),
            });
        }
        let query_lower = query.to_lowercase();
        for item in snapshot
            .items
            .iter()
            .filter(|item| !hidden.contains(&item.id))
        {
            if !query.is_empty() && !item.text.to_lowercase().contains(&query_lower) {
                continue;
            }
            if cards.len() == 8 {
                extra_nodes = true;
                break;
            }
            let title = match item.section {
                OverviewSection::Profile => "项目定位",
                OverviewSection::Progress => "项目进展",
                OverviewSection::KnowledgeMap => "知识入口",
                OverviewSection::Actions => "行动",
                OverviewSection::OpenQuestions => "待解问题",
            };
            cards.push(KnowledgeCard {
                node_id: format!("overview:{}", item.id),
                title: title.into(),
                one_line: item.text.chars().take(240).collect(),
            });
        }
        let mut coverage = snapshot.coverage.clone();
        coverage.pending = pending.pending_count;
        let is_stale = baseline_changed
            || pending.pending_count > 0
            || !stale.is_empty()
            || !hidden.is_empty()
            || !node_stale.is_empty();
        let entry = ContextEntry {
            identity,
            status: if is_stale {
                KnowledgeStatus::Stale
            } else {
                KnowledgeStatus::Partial
            },
            overview_updated_at: Some(snapshot.built_at),
            positioning: profile.map(|item| item.text.clone()),
            coverage: Some(coverage),
            nodes: cards,
            // Even when the profile fits, the complete Overview is a separate
            // selective read; an incomplete manifest never advertises readiness.
            has_more: pending.needs_rebuild
                || extra_nodes
                || snapshot.items.len() > usize::from(profile.is_some()),
            available_reads: vec![
                "context.overview.get".into(),
                "knowledge.get".into(),
                "knowledge.search".into(),
            ],
            source_refs: vec![],
        };
        let mut entry = entry.bounded(input.budget_chars)?;
        // Collect after bounding: removed cards and an entirely removed positioning
        // have not been exposed to the Run.
        let mut selected = Vec::new();
        if entry
            .positioning
            .as_ref()
            .is_some_and(|text| !text.is_empty())
        {
            if let Some(profile) = profile {
                selected.push(profile.id.clone());
            }
        }
        for card in &entry.nodes {
            if let Some(id) = card.node_id.strip_prefix("overview:") {
                selected.push(id.to_string());
            } else if let Some(refs) = candidate_sources.get(&card.node_id) {
                entry.source_refs.extend(refs.iter().cloned());
            }
        }
        let mut seen = HashSet::new();
        while let Some(id) = selected.pop() {
            if !seen.insert(id.clone()) {
                continue;
            }
            if let Some(item) = snapshot.items.iter().find(|item| item.id == id) {
                entry.source_refs.extend(item.source_refs.iter().cloned());
                selected.extend(item.dependency_item_ids.iter().cloned());
            }
        }
        Ok(entry)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            access::{Caller, ScopeGrant},
            context::{serialized_chars, EpistemicStatus, OverviewItem, SourceCoverage},
            models::{ObjectKind, ObjectRef, SourceRef},
            overview::OverviewPublishInput,
            service::AgentDomainService,
        },
        db::agent::WorkspaceContextRepository,
        models::{
            ProjectCreateInput, TodoCreateInput, TodoDeleteInput, TodoScope, TodoUpdateContentInput,
        },
        source_service::{SourcePolicyUpdate, SourceReadTarget},
    };
    struct Fixture {
        _root: tempfile::TempDir,
        db: Database,
        binding: WorkspaceBinding,
        request: RequestContext,
        input: ContextGetInput,
        source: SourceRef,
        todo_id: i64,
    }
    fn fixture() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("l0.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("w").unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "独立项目名称".into(),
                summary: Some("不能作为定位的用户速记".into()),
                status: None,
            })
            .unwrap();
        let todo = db
            .todo_create(TodoCreateInput {
                scope: TodoScope::Project,
                project_id: Some(project.id),
                content: "私有待办依据".into(),
                priority: "normal".into(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
        db.source_registry_prepare().unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "w".into(),
            generation: "one".into(),
        };
        let request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "l0-read".into(),
            scope_grant: ScopeGrant {
                object_keys: None,
                workspace_id: "w".into(),
                workspace_content: true,
                project_ids: vec![project.id],
                operations: vec!["context.read".into()],
            },
        };
        let mut authorized = request.clone();
        authorized.scope_grant.operations.push("source.read".into());
        let object = ObjectRef {
            workspace_id: "w".into(),
            scope: Scope::Project {
                project_id: project.id,
            },
            kind: ObjectKind::Todo,
            id: todo.id.to_string(),
        };
        let native = db
            .source_native_snapshot(
                &authorized,
                &binding,
                &SourceReadTarget {
                    object: object.clone(),
                    revision: None,
                    record_version: None,
                    file_version: None,
                },
            )
            .unwrap();
        let source = SourceRef {
            object,
            revision: native.revision,
            file_version: None,
            record_version: None,
            block_id: None,
            locator: None,
            title: native.title,
            excerpt: "私有待办依据".into(),
        };
        Fixture {
            _root: root,
            db,
            binding,
            request,
            input: ContextGetInput {
                scope: Scope::Project {
                    project_id: project.id,
                },
                query: None,
                budget_chars: None,
            },
            source,
            todo_id: todo.id,
        }
    }
    fn publish(f: &Fixture) {
        let basis = OverviewItem {
            id: "basis".into(),
            section: OverviewSection::Progress,
            text: "私有进展不得泄露".into(),
            epistemic_status: EpistemicStatus::Recorded,
            source_refs: vec![f.source.clone()],
            dependency_item_ids: vec![],
            valid_state: ValidState::Current,
            updated_at: "time".into(),
        };
        let profile = OverviewItem {
            id: "profile".into(),
            section: OverviewSection::Profile,
            text: "中文定位用于验证入口预算".repeat(60),
            epistemic_status: EpistemicStatus::Inferred,
            source_refs: vec![],
            dependency_item_ids: vec!["basis".into()],
            valid_state: ValidState::Current,
            updated_at: "time".into(),
        };
        let input = OverviewPublishInput {
            scope: f.input.scope.clone(),
            batch_id: "context-batch-0".into(),
            expected_revision: 0,
            target_seq: f.db.committed_change_watermark().unwrap() as u64,
            policy_revision: 0,
            correction_revision: 0,
            upsert_items: vec![basis, profile],
            remove_item_ids: vec![],
            settled_object_keys: vec![],
            knowledge_upserts: vec![],
            knowledge_removes: vec![],
            coverage: SourceCoverage {
                processed: 1,
                partial: 0,
                excluded: 0,
                unsupported: 0,
                pending: 0,
            },
            source_manifest_hash: "bounded-fixture".into(),
            model_profile_id: "profile".into(),
        };
        f.db.agent_overview_publish("gui", "l0-publish", "w", &input, |_, _| Ok(()))
            .unwrap();
    }
    fn get(f: &Fixture, request: &RequestContext, input: ContextGetInput) -> ContextEntry {
        let repo = WorkspaceContextRepository {
            db: &f.db,
            workspace_name: "Workspace",
        };
        AgentDomainService::new(&f.binding, &repo)
            .context_get(request, input)
            .unwrap()
    }
    #[test]
    #[ignore = "manual E16 published knowledge status latency"]
    fn e16_published_knowledge_status_latency() {
        let f = fixture();
        publish(&f);
        let mut times = Vec::with_capacity(100);
        for index in 0..110 {
            let started = std::time::Instant::now();
            let entry = get(&f, &f.request, f.input.clone());
            assert!(!matches!(entry.status, KnowledgeStatus::NotBuilt));
            assert!(!entry.nodes.is_empty() || entry.positioning.is_some());
            if index >= 10 { times.push(started.elapsed().as_micros()); }
        }
        times.sort_unstable();
        eprintln!("E16 published knowledge status p50={}us p95={}us max={}us warmup=10 samples=100", times[49], times[94], times[99]);
        assert!(times[94] <= 200_000);
    }
    #[test]
    fn l0_no_overview_keeps_independent_identity_and_not_built() {
        let f = fixture();
        let entry = get(&f, &f.request, f.input.clone());
        assert!(matches!(entry.status, KnowledgeStatus::NotBuilt));
        assert_eq!(entry.identity.name, "独立项目名称");
        assert!(entry.positioning.is_none());
        assert!(entry.nodes.is_empty());
        assert!(entry.available_reads.is_empty());
    }
    #[test]
    fn l0_context_read_authorizes_derived_positioning_and_serialized_chinese_budget() {
        let f = fixture();
        publish(&f);
        let mut input = f.input.clone();
        input.budget_chars = Some(550);
        let entry = get(&f, &f.request, input);
        assert!(entry
            .positioning
            .as_ref()
            .is_some_and(|text| !text.is_empty() && text.chars().count() <= 300));
        assert!(serialized_chars(&entry).unwrap() <= 550);
        assert!(entry.has_more);
        assert!(entry
            .nodes
            .iter()
            .all(|card| card.node_id.starts_with("overview:")));
        assert_eq!(
            entry.available_reads,
            vec!["context.overview.get", "knowledge.get", "knowledge.search"]
        );
        assert!(!matches!(entry.status, KnowledgeStatus::Ready));
        let mut denied_scope = f.request.clone();
        denied_scope.scope_grant.project_ids.clear();
        let repo = WorkspaceContextRepository {
            db: &f.db,
            workspace_name: "Workspace",
        };
        assert_eq!(
            AgentDomainService::new(&f.binding, &repo)
                .context_get(&denied_scope, f.input.clone())
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        // Source grants are not modified or exposed to the caller.
        assert_eq!(f.request.scope_grant.operations, vec!["context.read"]);
    }
    #[test]
    fn l0_trace_keeps_profile_dependency_after_card_is_trimmed() {
        let f = fixture();
        publish(&f);
        let mut input = f.input.clone();
        input.budget_chars = Some(550);
        let entry = get(&f, &f.request, input);
        assert!(entry.positioning.is_some());
        assert_eq!(entry.source_refs.len(), 1);
        assert_eq!(entry.source_refs[0].object, f.source.object);
        assert!(!serde_json::to_string(&entry)
            .unwrap()
            .contains("sourceRefs"));
    }
    #[test]
    fn l0_trace_omits_sources_when_all_derived_text_is_trimmed() {
        let f = fixture();
        publish(&f);
        let mut found = false;
        for budget in 300..550 {
            let mut input = f.input.clone();
            input.budget_chars = Some(budget);
            let Ok(entry) = f.db.agent_overview_context_entry(
                &f.request,
                &f.binding,
                &input,
                ScopeIdentity {
                    scope: input.scope.clone(),
                    name: "独立项目名称".into(),
                    archived: false,
                },
            ) else {
                continue;
            };
            if entry.positioning.is_none() && entry.nodes.is_empty() {
                assert!(entry.source_refs.is_empty());
                found = true;
                break;
            }
        }
        assert!(found);
    }
    #[test]
    fn derived_message_visibility_follows_original_run_source_policy() {
        use crate::agent::models::SourceLocator;
        use rusqlite::params;
        use sha2::{Digest, Sha256};
        let f = fixture();
        let session = "11111111111111111111111111111111";
        let run = "22222222222222222222222222222222";
        let message = "33333333333333333333333333333333";
        let body = "助手据旧来源形成的结论";
        let hash = format!("sha256:{:x}", Sha256::digest(body.as_bytes()));
        f.db.conn.execute("INSERT INTO agent_sessions(id,scope_key,title,runtime_id,state,session_path,checkpoint_json,created_at,updated_at) VALUES (?1,?2,'session','builtin-pi','active',?3,'{}','now','now')", params![session,f.input.scope.key(),format!(".project-mind/agent/sessions/{session}/session.jsonl")]).unwrap();
        f.db.conn.execute("INSERT INTO agent_runs(id,session_id,client_request_id,state,context_manifest_json,grant_json,started_at) VALUES (?1,?2,'old','completed','{}','{}','now')", params![run,session]).unwrap();
        f.db.conn.execute("INSERT INTO agent_session_search_rows(message_id,session_id,runtime_entry_id,ordinal,role,created_at,run_id,text_hash,text,total_chars,complete) VALUES (?1,?2,'branch',0,'assistant','now',?3,?4,?5,?6,1)",params![message,session,run,hash,body,body.chars().count() as i64]).unwrap();
        f.db.conn.execute("INSERT INTO agent_run_provenance(run_id) VALUES (?1)",[run]).unwrap();
        f.db.conn.execute("INSERT INTO agent_run_source_dependencies(run_id,object_key,object_json,revision) VALUES (?1,?2,?3,?4)",params![run,f.source.object.key().unwrap(),serde_json::to_string(&f.source.object).unwrap(),f.source.revision]).unwrap();
        let message_ref = SourceRef { object: ObjectRef { workspace_id: "w".into(), scope: f.input.scope.clone(), kind: ObjectKind::SessionMessage, id: message.into() }, revision: hash, file_version: None, record_version: None, block_id: None, locator: Some(SourceLocator::Messages { session_id: session.into(), branch_id: "branch".into(), start_message_id: message.into(), end_message_id: message.into() }), title: "历史讨论".into(), excerpt: String::new() };
        let mut request = f.request.clone();
        request.scope_grant.operations.extend(["session.read".into(),"source.read".into()]);
        assert!(derived_source_visible(&f.db,&request,&f.binding,&message_ref).is_ok());
        let deps = crate::agent::source_trace::expand_sources(&f.db,&request,&f.binding,vec![crate::db::agent_run_provenance::ObservedSource {object: message_ref.object.clone(),revision: Some(message_ref.revision.clone())}]).unwrap();
        assert_eq!(deps.len(),2);
        assert_eq!(deps[0].object,f.source.object);
        f.db.conn.execute("INSERT INTO source_access_policies(object_key,excluded,revision) VALUES (?1,1,1)",[f.source.object.key().unwrap()]).unwrap();
        assert!(derived_source_visible(&f.db,&request,&f.binding,&message_ref).is_err());
        f.db.conn.execute("DELETE FROM source_access_policies WHERE object_key=?1",[f.source.object.key().unwrap()]).unwrap();
        f.db.conn.execute("UPDATE agent_session_search_rows SET text_hash='sha256:new' WHERE message_id=?1",[message]).unwrap();
        assert_eq!(derived_source_visible(&f.db,&request,&f.binding,&message_ref).unwrap_err().code,ErrorCode::SourceChanged);
    }
    #[test]
    fn l0_deleted_source_hides_dependent_positioning() {
        let f = fixture();
        publish(&f);
        f.db.todo_delete(TodoDeleteInput {
            expected_revision: f.db.todo_record(f.todo_id).unwrap().revision,
            todo_id: f.todo_id,
        })
        .unwrap();
        let entry = get(&f, &f.request, f.input.clone());
        assert!(entry.positioning.is_none());
        assert!(matches!(entry.status, KnowledgeStatus::Stale));
        assert!(!serde_json::to_string(&entry).unwrap().contains("私有"));
    }
    #[test]
    fn l0_exclusion_hides_source_and_dependent_profile_and_dirty_marks_stale() {
        let f = fixture();
        publish(&f);
        assert!(f
            .db
            .agent_overview_stale_items("w", &f.input.scope)
            .unwrap()
            .is_empty());
        f.db.todo_update_content(TodoUpdateContentInput {
            expected_revision: f.db.todo_record(f.todo_id).unwrap().revision,
            todo_id: f.todo_id,
            content: "变更后的依据".into(),
            due_date: None,
            tag_ids: vec![],
        })
        .unwrap();
        let dirty_ids =
            f.db.agent_overview_stale_items("w", &f.input.scope)
                .unwrap();
        assert!(dirty_ids.iter().any(|id| id == "basis"));
        let dirty = get(&f, &f.request, f.input.clone());
        assert!(matches!(dirty.status, KnowledgeStatus::Stale));
        let mut settings_request = f.request.clone();
        settings_request
            .scope_grant
            .operations
            .push("settings.write".into());
        settings_request.request_id = "l0-exclude".into();
        f.db.source_policy_update(
            &settings_request,
            &f.binding,
            &SourcePolicyUpdate {
                object: f.source.object.clone(),
                expected_revision: 0,
                excluded: true,
            },
        )
        .unwrap();
        let hidden = get(&f, &f.request, f.input.clone());
        assert!(hidden.positioning.is_none());
        assert!(!serde_json::to_string(&hidden).unwrap().contains("私有"));
    }
}
