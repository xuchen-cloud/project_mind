use super::*;
use crate::agent::{
    access::Caller,
    conversation::{MessageRole, ProjectionMessage, RunPreparation, RunSettlement, SessionCheckpoint, VerifiedSessionProjection},
    runtime::RunState,
};
use crate::source_session_read::{SessionHistoryFragment, SessionHistoryUtility};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

struct History {
    texts: Mutex<HashMap<String, String>>,
    reads: AtomicUsize,
}
impl History {
    fn new() -> Self {
        Self {
            texts: Mutex::new(HashMap::new()),
            reads: AtomicUsize::new(0),
        }
    }
    fn add(&self, message_id: String, text: &str) {
        self.texts.lock().unwrap().insert(message_id, text.into());
    }
}
impl SessionHistoryUtility for History {
    async fn read(
        &self,
        _: &WorkspaceBinding,
        record: &crate::db::agent_session_model_search::SourceReadRecord,
        cursor: Option<&str>,
        _: u32,
    ) -> AgentResult<SessionHistoryFragment> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let text = self
            .texts
            .lock()
            .unwrap()
            .get(&record.message_id)
            .cloned()
            .unwrap();
        let start = crate::agent::model_history::history_cursor_offset(cursor, record)?;
        let rest: String = text.chars().skip(start as usize).collect();
        Ok(SessionHistoryFragment {
            session_id: record.session_id.clone(),
            message_id: record.message_id.clone(),
            runtime_entry_id: record.runtime_entry_id.clone(),
            ordinal: record.ordinal,
            content_hash: record.text_hash.clone(),
            text: rest,
            char_start: start,
            char_end: text.chars().count() as u32,
            total_chars: text.chars().count() as u32,
            next_cursor: None,
        })
    }
}
fn hash(text: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(text.as_bytes()))
}
fn message_id(session: &str, entry: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{session}:{entry}").as_bytes())
    )[..32]
        .into()
}
fn projection(entries: &[(&str, &str)]) -> VerifiedSessionProjection {
    let messages = entries
        .iter()
        .enumerate()
        .map(|(ordinal, (entry, text))| ProjectionMessage {
            runtime_entry_id: (*entry).into(),
            ordinal: ordinal as u64,
            created_at: format!("2026-10-09T00:00:{ordinal:02}Z"),
            role: MessageRole::User,
            content: json!([{"type":"text","text":text}]),
            parent_id: (ordinal > 0).then(|| entries[ordinal - 1].0.into()),
            stop_reason: None,
            usage: None,
            tool_call_id: None,
            tool_name: None,
            is_error: None,
        })
        .collect();
    VerifiedSessionProjection {
        checkpoint: SessionCheckpoint {
            schema_version: 1,
            checksum: hash(&format!("checkpoint-{}", entries.len())),
            bytes: 500,
            offset: 500,
            leaf_id: entries.last().map(|(entry, _)| (*entry).into()),
            entry_count: entries.len() as u64,
            message_count: entries.len() as u64,
        },
        messages,
    }
}
async fn drive(f: &Fixture, model: &MockModel, history: &History, start: usize) {
    for n in start..start + 20 {
        f.store
            .with_current(|binding, db| {
                db.overview_schedule_request(binding, &f.scope, Utc::now())
                    .map(|_| ())
            })
            .unwrap();
        let request = request(
            f.store.binding.clone(),
            &f.scope,
            format!("session-step-{n}"),
        );
        let continued = step(
            &f.store, &request, &f.scope, &NoUtility, &NoUtility, model, history,
        )
        .await
        .unwrap();
        let pending = f
            .store
            .with_current(|binding, db| db.agent_overview_maintenance_status(binding, &f.scope))
            .unwrap()
            .pending_count;
        if pending == 0 && !continued {
            return;
        }
    }
    panic!("Session maintenance did not quiesce");
}
fn three_message_run(f:&Fixture, assistant_stop:bool) -> (String,History) {
    let mut create=request(f.store.binding.clone(),&f.scope,"batch-session-create".into());
    create.scope_grant.operations.extend(["session.write".into(),"run.start".into()]);
    let session=f.store.with_current(|binding,db|db.agent_session_create(&create,binding,&f.scope,"Batch","builtin-pi",None)).unwrap();
    let history=History::new();
    let entries=[("first","用户计划：周四验收"),("second","助手建议先检查数据"),("third","用户更正：周五验收")];
    for (entry,text) in &entries { history.add(message_id(&session.id,entry),text); }
    let mut projected=projection(&entries);
    projected.messages[1].role=MessageRole::Assistant;
    if assistant_stop { projected.messages[1].stop_reason=Some("stop".into()); }
    let run_id="b".repeat(32);
    f.store.with_current(|binding,db| {
        db.agent_run_prepare(&create,binding,&session.id,"batch-turn",&RunPreparation { run_id:run_id.clone(),context_manifest:json!({}) })?;
        db.agent_run_start(&create,binding,&run_id)?;
        let run_request=RequestContext { caller:Caller::BuiltinRun { run_id:run_id.clone() },..create.clone() };
        db.agent_run_provenance_begin(&run_request,binding,&[])?;
        db.agent_run_settle(&run_request,binding,&run_id,&RunSettlement { state:RunState::Completed,runtime_settled:true,projection:Some(projected),usage:None,error_code:None })?;
        Ok(())
    }).unwrap();
    (session.id,history)
}
fn model_response(text: &str, supersedes: &[String]) -> String {
    json!({"upsertItems":[{"id":"session-decision","section":"progress","text":text,"epistemicStatus":"recorded","evidenceIndices":[0],"dependencyItemIds":[]}],"removeItemIds":[],"sourceSummary":{"title":"会话决定","oneLine":text,"summary":text,"bodySections":[{"id":"body","title":"依据","text":text}],"keywords":["决定"]},"sessionStatements":[{"text":text,"kind":"user_decision","operationReceiptId":null}],"supersedesSummaryIds":supersedes}).to_string()
}

#[tokio::test]
async fn session_decision_reads_verified_history_publishes_and_supersedes() {
    let f = fixture();
    let model = MockModel::new();
    warmup(&f, &model).await;
    let before = model.calls();
    let mut session_request = request(f.store.binding.clone(), &f.scope, "session-create".into());
    session_request
        .scope_grant
        .operations
        .push("session.write".into());
    session_request.caller = Caller::Gui;
    let session = f
        .store
        .with_current(|binding, db| {
            db.agent_session_create(
                &session_request,
                binding,
                &f.scope,
                "Decisions",
                "builtin-pi",
                None,
            )
        })
        .unwrap();
    let history = History::new();
    let first = "决定先做旧方案";
    let first_id = message_id(&session.id, "first");
    history.add(first_id.clone(), first);
    f.store
        .with_current(|binding, db| {
            db.agent_session_restore_projection(
                &session_request,
                binding,
                &session.id,
                &projection(&[("first", first)]),
            )
            .map(|_| ())
        })
        .unwrap();
    model.set_response(&model_response(first, &[]));
    drive(&f, &model, &history, 100).await;
    assert_eq!(model.calls(), before + 1);
    assert!(history.reads.load(Ordering::SeqCst) > 0);
    let (old_revision, old_summary) = f
        .store
        .with_current(|_, db| {
            let snapshot = db.agent_overview_head(&f.scope)?.unwrap();
            let summaries = db.agent_session_summary_list(&f.scope, &session.id, 10)?;
            Ok((snapshot.revision, summaries.into_iter().next().unwrap()))
        })
        .unwrap();
    assert_eq!(
        old_summary
            .session_summary
            .as_ref()
            .unwrap()
            .statements
            .len(),
        1
    );
    let calls = model.calls();
    drive(&f, &model, &history, 200).await;
    assert_eq!(model.calls(), calls);
    let second = "决定改用新方案";
    history.add(message_id(&session.id, "second"), second);
    f.store
        .with_current(|binding, db| {
            db.agent_session_restore_projection(
                &session_request,
                binding,
                &session.id,
                &projection(&[("first", first), ("second", second)]),
            )
            .map(|_| ())
        })
        .unwrap();
    model.set_response(&model_response(second, &[old_summary.node_id.clone()]));
    *model.fail.lock().unwrap() = Some(ErrorCode::RuntimeUnavailable);
    let mut failed_batch = None;
    for n in 250..270 {
        f.store
            .with_current(|binding, db| {
                db.overview_schedule_request(binding, &f.scope, Utc::now())
                    .map(|_| ())
            })
            .unwrap();
        let request = request(
            f.store.binding.clone(),
            &f.scope,
            format!("failed-session-{n}"),
        );
        match step(
            &f.store, &request, &f.scope, &NoUtility, &NoUtility, &model, &history,
        )
        .await
        {
            Ok(_) => (),
            Err(error) => {
                assert_eq!(error.code, ErrorCode::RuntimeUnavailable);
                failed_batch = model.batch_ids.lock().unwrap().last().cloned();
                break;
            }
        }
    }
    let failed_batch = failed_batch.expect("model failure must be reached");
    assert_eq!(
        f.store
            .with_current(|_, db| Ok(db.agent_overview_head(&f.scope)?.unwrap().revision))
            .unwrap(),
        old_revision
    );
    control(
        &f.store,
        &request(f.store.binding.clone(), &f.scope, "resume-session".into()),
        &f.scope,
        "resume",
    )
    .unwrap();
    *model.fail.lock().unwrap() = None;
    drive(&f, &model, &history, 300).await;
    assert_eq!(
        model.batch_ids.lock().unwrap().last().unwrap(),
        &failed_batch
    );
    let (current, summaries, old) = f
        .store
        .with_current(|_, db| {
            Ok((
                db.agent_overview_head(&f.scope)?.unwrap(),
                db.agent_session_summary_list(&f.scope, &session.id, 10)?,
                db.agent_overview_version(&f.scope, old_revision)?.unwrap(),
            ))
        })
        .unwrap();
    assert!(current.items.iter().any(|item| item.text == second));
    assert!(old.items.iter().any(|item| item.text == first));
    assert!(summaries.iter().any(|node| node
        .session_summary
        .as_ref()
        .is_some_and(|segment| segment.supersedes.contains(&old_summary.node_id))));
    let read_request = request(f.store.binding.clone(), &f.scope, "old-session-read".into());
    let mut model_read = read_request.clone();
    model_read.caller = Caller::Connection {
        grant_id: "history-fixture".into(),
    };
    let indexed = f
        .store
        .with_current(|binding, db| {
            db.agent_model_session_search(
                &model_read,
                binding,
                &crate::db::agent_session_model_search::ModelHistorySearchInput {
                    scope: f.scope.clone(),
                    query: first.into(),
                    session_id: Some(session.id.clone()),
                    after_message_id: None,
                    limit: 8,
                    budget_chars: 4000,
                },
            )
        })
        .unwrap();
    assert!(indexed
        .matches
        .iter()
        .any(|found| found.message_id == first_id));
    let mut summary_object = old_summary.source_refs[0].object.clone();
    summary_object.kind = crate::agent::models::ObjectKind::SessionSummary;
    summary_object.id = old_summary.node_id.clone();
    SourceService::new(&f.store)
        .set_policy(
            &read_request,
            &SourcePolicyUpdate {
                object: summary_object,
                expected_revision: 0,
                excluded: true,
            },
        )
        .unwrap();
    let newer = summaries
        .iter()
        .find(|node| node.node_id != old_summary.node_id)
        .unwrap();
    let newer_source = &newer.source_refs[0];
    let (_, evidence, prior) = crate::overview_session::input(
        &f.store,
        &read_request,
        &crate::source_service::SourceReadTarget {
            object: newer_source.object.clone(),
            revision: Some(newer_source.revision.clone()),
            record_version: None,
            file_version: None,
        },
    )
    .unwrap()
    .unwrap();
    assert!(!evidence
        .allowed_supersedes_summary_ids
        .contains(&old_summary.node_id));
    assert!(
        prior.is_none(),
        "An excluded summary must not enter the next maintenance prompt"
    );
    let exclude_message_request = request(f.store.binding.clone(), &f.scope, "exclude-original-message".into());
    SourceService::new(&f.store)
        .set_policy(
            &exclude_message_request,
            &SourcePolicyUpdate {
                object: old_summary.source_refs[0].object.clone(),
                expected_revision: 0,
                excluded: true,
            },
        )
        .unwrap();
    let old_page = OverviewService::new(&f.store)
        .get(
            &read_request,
            &crate::overview_service::OverviewReadInput {
                scope: f.scope.clone(),
                version: Some(old_revision),
                sections: vec![],
                item_ids: vec!["session-decision".into()],
                cursor: None,
                budget_chars: Some(8000),
            },
        )
        .await
        .unwrap();
    assert!(old_page.items.is_empty());
    let old_node = crate::knowledge_registry::KnowledgeRegistry::new(&f.store)
        .get(
            &read_request,
            &crate::knowledge_service::KnowledgeGetInput {
                scope: f.scope.clone(),
                node_id: format!("node:{}", old_summary.node_id),
                version: Some(old_summary.revision),
                view: crate::knowledge_service::KnowledgeView::Summary,
                section_ids: vec![],
                cursor: None,
                budget_chars: Some(8000),
            },
        )
        .await;
    assert!(old_node.is_err());
}

#[tokio::test]
async fn contiguous_conversation_is_one_verified_summary_batch() {
    let f=fixture();
    let model=MockModel::new();
    warmup(&f,&model).await;
    let before=model.calls();
    let (session_id,history)=three_message_run(&f,true);
    model.set_response(&json!({
        "upsertItems":[],"removeItemIds":[],
        "sourceSummary":{"title":"讨论验收","oneLine":"周五验收","summary":"先计划周四，随后更正为周五。","bodySections":[],"keywords":["验收"]},
        "sessionStatements":[
            {"text":"计划周四验收","kind":"user_plan","evidenceIndex":0},
            {"text":"建议检查数据","kind":"ai_suggestion","evidenceIndex":1},
            {"text":"更正为周五验收","kind":"user_decision","evidenceIndex":2}
        ]
    }).to_string());
    drive(&f,&model,&history,500).await;
    assert_eq!(model.calls(),before+1);
    let (coverage,summaries)=f.store.with_current(|binding,db|Ok((db.agent_overview_maintenance_status(binding,&f.scope)?.coverage,db.agent_session_summary_list(&f.scope,&session_id,10)?))).unwrap();
    assert!(coverage.processed>=3);
    let node=summaries.iter().find(|node|node.source_refs.len()==3).expect("one summary spans all three messages");
    let segment=node.session_summary.as_ref().unwrap();
    assert_eq!(segment.start_entry_id,"first");
    assert_eq!(segment.end_entry_id,"third");
    assert_eq!(segment.statements.len(),3);
    for (statement,entry) in segment.statements.iter().zip(["first","second","third"]) {
        assert_eq!(statement.message_refs[0].message_id,message_id(&session_id,entry));
        assert_eq!(statement.message_refs[0].branch_id,entry);
    }
    drive(&f,&model,&history,600).await;
    assert_eq!(model.calls(),before+1);
}

#[tokio::test]
async fn frozen_conversation_draft_replays_without_regeneration() {
    let f=fixture(); let model=MockModel::new(); warmup(&f,&model).await;
    let before=model.calls();
    let (session_id,history)=three_message_run(&f,true);
    model.set_response(&json!({"upsertItems":[],"removeItemIds":[],"sourceSummary":{"title":"段摘要","oneLine":"讨论验收","summary":"先计划后更正","bodySections":[],"keywords":[]}}).to_string());
    *model.fail.lock().unwrap()=Some(ErrorCode::RuntimeUnavailable);
    let mut failed_batch=None;
    for n in 700..720 {
        f.store.with_current(|binding,db|db.overview_schedule_request(binding,&f.scope,Utc::now()).map(|_|())).unwrap();
        let result=step(&f.store,&request(f.store.binding.clone(),&f.scope,format!("freeze-{n}")),&f.scope,&NoUtility,&NoUtility,&model,&history).await;
        if let Err(error)=result {
            assert_eq!(error.code,ErrorCode::RuntimeUnavailable);
            failed_batch=model.batch_ids.lock().unwrap().last().cloned(); break;
        }
    }
    let failed_batch=failed_batch.expect("batch reached model");
    control(&f.store,&request(f.store.binding.clone(),&f.scope,"resume-frozen".into()),&f.scope,"resume").unwrap();
    let frozen=f.store.with_current(|binding,db|db.agent_overview_maintenance_prepare(binding,&f.scope,Utc::now())).unwrap().unwrap();
    assert_eq!(frozen.source_items.len(),2);
    assert!(frozen.sources_frozen);
    let draft_request=request(f.store.binding.clone(),&f.scope,"draft-messages".into());
    f.store.with_current(|binding,db| {
        let mut refs=Vec::new(); let mut progresses=Vec::new();
        for source in std::iter::once(&frozen.source).chain(&frozen.source_items) {
            let object=crate::agent::models::ObjectRef { workspace_id:binding.workspace_id.clone(),scope:f.scope.clone(),kind:ObjectKind::SessionMessage,id:source.object_key.rsplit('/').next().unwrap().into() };
            let target=crate::source_service::SourceReadTarget { object:object.clone(),revision:None,record_version:None,file_version:None };
            let record=db.source_session_record(&draft_request,binding,&target)?;
            refs.push(record.source_ref(binding));
            progresses.push(OverviewSourceProgress { object:crate::db::overview_maintenance::OverviewInput::Raw(object),read_target:Some(crate::source_service::SourceReadTarget { revision:Some(record.text_hash),..target }),read_cursor:None,state:OverviewSourceState::Processed,handled_seq:source.last_seq });
        }
        let coverage=db.agent_overview_maintenance_coverage_many(binding,&f.scope,&progresses)?;
        db.agent_overview_maintenance_save_draft_many(binding,&f.scope,&frozen.batch_id,&crate::agent::overview::OverviewPublishInput {
            expected_memory_epoch: 0,
            scope:f.scope.clone(),batch_id:frozen.batch_id.clone(),expected_revision:frozen.expected_revision,target_seq:frozen.target_seq,policy_revision:frozen.policy_revision,correction_revision:frozen.correction_revision,
            upsert_items:vec![crate::agent::context::OverviewItem { id:"draft-cited".into(),section:crate::agent::context::OverviewSection::Progress,text:"三条讨论已有依据".into(),epistemic_status:EpistemicStatus::Recorded,source_refs:refs,
            published_sources: vec![],dependency_item_ids:vec![],valid_state:crate::agent::context::ValidState::Current,updated_at:Utc::now().to_rfc3339() }],
            remove_item_ids:vec![],settled_object_keys:std::iter::once(&frozen.source).chain(&frozen.source_items).map(|source|source.object_key.clone()).collect(),
            knowledge_upserts:vec![],knowledge_removes:vec![],coverage,source_manifest_hash:"test-frozen-draft".into(),model_profile_id:"mock-profile".into(),
        },&progresses,None,Utc::now())
    }).unwrap();
    drive(&f,&model,&history,800).await;
    assert_eq!(model.calls(),before+1,"saved draft must publish without another model call");
    assert_eq!(model.batch_ids.lock().unwrap().last().unwrap(),&failed_batch);
    let (head,status)=f.store.with_current(|binding,db|Ok((db.agent_overview_head(&f.scope)?.unwrap(),db.agent_overview_maintenance_status(binding,&f.scope)?))).unwrap();
    assert!(head.items.iter().any(|item|item.id=="draft-cited" && item.source_refs.len()==3));
    assert_eq!(status.pending_count,0);
    assert!(!session_id.is_empty());
}

#[tokio::test]
async fn unavailable_assistant_breaks_contiguous_batch() {
    let f=fixture(); let model=MockModel::new(); warmup(&f,&model).await;
    let before=model.calls();
    let (_session_id,history)=three_message_run(&f,false);
    drive(&f,&model,&history,900).await;
    assert_eq!(model.calls(),before+2,"the two user messages are processed separately across an unavailable assistant");
}
