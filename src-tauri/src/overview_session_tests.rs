use super::*;
use crate::agent::{
    access::Caller,
    conversation::{MessageRole, ProjectionMessage, SessionCheckpoint, VerifiedSessionProjection},
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
