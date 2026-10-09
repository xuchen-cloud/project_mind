//! One durable GUI decision over an exact set; no batch business transaction.
use super::{agent_operations::io_error, agent_outputs::read_output, Database};
use crate::agent::{
    access::{Caller, RequestContext},
    errors::{AgentError, AgentResult, ErrorCode},
    models::WorkspaceBinding,
    output_review::{OutputReviewDecision, OutputReviewInput, OutputReviewResult, ReviewDecision},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewReceipt {
    run_id: String,
    decision: ReviewDecision,
    output_ids: Vec<String>,
}
fn conflict(message: &str) -> AgentError {
    AgentError::new(ErrorCode::RevisionConflict, message)
}
fn current_result(conn: &Connection, receipt: ReviewReceipt) -> AgentResult<OutputReviewResult> {
    Ok(OutputReviewResult {
        run_id: receipt.run_id,
        decision: receipt.decision,
        outputs: receipt
            .output_ids
            .iter()
            .map(|id| read_output(conn, id))
            .collect::<AgentResult<_>>()?,
    })
}
impl Database {
    pub(crate) fn agent_output_review(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &OutputReviewInput,
    ) -> AgentResult<OutputReviewResult> {
        if !matches!(request.caller, Caller::Gui) {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Only the local GUI can decide a review plan",
            ));
        }
        if input.outputs.is_empty()
            || input.outputs.len() > 256
            || input.text.as_ref().is_some_and(|s| s.len() > 4096)
        {
            return Err(AgentError::new(
                ErrorCode::BudgetExceeded,
                "Review requires 1–256 candidates and at most 4096 bytes of user text",
            ));
        }
        let scope = self.agent_output_run_scope(&input.run_id)?;
        let operation = if input.decision == ReviewDecision::Confirm {
            "output.commit"
        } else {
            "output.update"
        };
        request.authorize(binding, &scope, operation)?;
        let grant = self.agent_output_gui_grant_for_run(binding, &input.run_id, &[operation])?;
        RequestContext {
            scope_grant: grant,
            ..request.clone()
        }
        .authorize(binding, &scope, operation)?;
        if let Some(receipt) = self.agent_operation_replay::<ReviewReceipt>(
            &request.caller.key(),
            &request.request_id,
            "output.review",
            input,
        )? {
            return current_result(&self.conn, receipt);
        }
        let receipt=self.agent_atomic_operation(&request.caller.key(),&request.request_id,"output.review",input,|tx| {
            let row:Option<(String,String,String,String)>=tx.query_row("SELECT r.session_id,r.state,json_extract(r.context_manifest_json,'$.mode'),s.state FROM agent_runs r JOIN agent_sessions s ON s.id=r.session_id WHERE r.id=?1",[&input.run_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(io_error)?;
            let(session_id,state,mode,session_state)=row.ok_or_else(||AgentError::new(ErrorCode::NotFound,"Review run not found"))?;
            if mode!="review" || session_state!="active" || !matches!(state.as_str(),"completed"|"failed"|"cancelled"|"interrupted") {
                return Err(AgentError::new(ErrorCode::InvalidRunTransition,"Review waits for the current run to finish"));
            }
            let latest:String=tx.query_row("SELECT id FROM agent_runs WHERE session_id=?1 ORDER BY rowid DESC LIMIT 1",[&session_id],|r|r.get(0)).map_err(io_error)?;
            if latest!=input.run_id {return Err(conflict("Review plan was superseded by another run"));}
            let committing:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM agent_outputs WHERE run_id=?1 AND state='committing')",[&input.run_id],|r|r.get(0)).map_err(io_error)?;
            if committing {return Err(AgentError::new(ErrorCode::OutputCommitFailed,"Wait for the current save to settle before deciding the remaining plan"));}
            let mut seen=HashSet::new();
            for item in &input.outputs {
                if item.expected_revision==0 || item.expected_revision>=i64::MAX as u64 || !seen.insert(item.output_id.as_str()) {return Err(conflict("Review candidates must contain unique IDs and exact positive revisions"));}
            }
            let mut stmt=tx.prepare("SELECT id,revision FROM agent_outputs WHERE run_id=?1 AND state IN ('staged','failed') AND COALESCE(json_extract(payload_json,'$.dismissed'),0)=0 ORDER BY ordinal").map_err(io_error)?;
            let pending=stmt.query_map([&input.run_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?))).map_err(io_error)?.collect::<Result<Vec<_>,_>>().map_err(io_error)?;
            if pending.len()!=input.outputs.len() || pending.iter().any(|(id,rev)|!input.outputs.iter().any(|item|&item.output_id==id && item.expected_revision==*rev as u64)) {return Err(conflict("Review must match the complete current pending plan"));}
            let decision=OutputReviewDecision{request_id:request.request_id.clone(),decision:input.decision,text:input.text.clone(),decided_at:chrono::Utc::now().to_rfc3339()};
            let json=serde_json::to_string(&decision).map_err(|_|AgentError::new(ErrorCode::IoFailed,"Cannot persist review decision"))?;
            for (id,revision) in &pending {
                let changed=if input.decision==ReviewDecision::Cancel {
                    tx.execute("UPDATE agent_outputs SET revision=revision+1,payload_json=json_set(payload_json,'$.reviewDecision',json(?1),'$.dismissed',json('true')) WHERE id=?2 AND revision=?3 AND state IN ('staged','failed') AND COALESCE(json_extract(payload_json,'$.dismissed'),0)=0",params![json,id,revision])
                } else {
                    tx.execute("UPDATE agent_outputs SET payload_json=CASE WHEN json_extract(payload_json,'$.reviewDecision.decision')='confirm' THEN payload_json ELSE json_set(payload_json,'$.reviewDecision',json(?1)) END WHERE id=?2 AND revision=?3 AND state IN ('staged','failed') AND COALESCE(json_extract(payload_json,'$.dismissed'),0)=0",params![json,id,revision])
                }.map_err(io_error)?;
                if changed!=1 {return Err(conflict("Review candidate changed before the decision was saved"));}
            }
            Ok((ReviewReceipt{run_id:input.run_id.clone(),decision:input.decision,output_ids:pending.into_iter().map(|(id,_)|id).collect()},None))
        })?;
        current_result(&self.conn, receipt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            access::ScopeGrant,
            conversation::{RunPreparation, RunSettlement},
            models::{ExecutionMode, Scope},
            output_review::OutputReviewItem,
            output_runtime::{OutputState, OutputUpdateInput, StageRecordInput},
            outputs::OutputIntent,
            runtime::RunState,
        },
        db::file_imports::AgentFileCreateInput,
        workspace_commit_fence::WorkspaceCommitFence,
    };
    struct Fixture {
        root: tempfile::TempDir,
        paths: crate::workspace::WorkspacePaths,
        db: Database,
        binding: WorkspaceBinding,
        gui: RequestContext,
        model: RequestContext,
        session: String,
        run: String,
        project: i64,
    }
    fn fixture() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let (metadata, paths) =
            crate::workspace::create_workspace(root.path(), "password").unwrap();
        let db = Database::open(&paths.db_path, root.path(), None).unwrap();
        let project = db
            .project_create(crate::models::ProjectCreateInput {
                name: "Review plan".into(),
                summary: None,
                status: None,
            })
            .unwrap()
            .id;
        let binding = WorkspaceBinding {
            workspace_id: metadata.workspace_id,
            generation: "review-test".into(),
        };
        let gui = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "review-gui".into(),
            scope_grant: ScopeGrant {
                object_keys: None,
                workspace_id: binding.workspace_id.clone(),
                workspace_content: false,
                project_ids: vec![project],
                operations: [
                    "session.read",
                    "session.write",
                    "run.start",
                    "output.stage",
                    "output.read",
                    "output.update",
                    "output.commit",
                    "content.create",
                    "source.read",
                ]
                .into_iter()
                .map(str::to_owned)
                .collect(),
            },
        };
        let session = db
            .agent_session_create(
                &gui,
                &binding,
                &Scope::Project {
                    project_id: project,
                },
                "Review",
                "pi",
                None,
            )
            .unwrap()
            .id;
        let run = "a".repeat(32);
        db.agent_run_prepare(&gui,&binding,&session,"first-message",&RunPreparation{run_id:run.clone(),context_manifest:serde_json::json!({"scope":Scope::Project{project_id:project},"mode":ExecutionMode::Review})}).unwrap();
        db.agent_run_start(&gui, &binding, &run).unwrap();
        let model = RequestContext {
            caller: Caller::BuiltinRun {
                run_id: run.clone(),
            },
            request_id: "model".into(),
            ..gui.clone()
        };
        Fixture {
            root,
            paths,
            db,
            binding,
            gui,
            model,
            session,
            run,
            project,
        }
    }
    fn stage(f: &Fixture, name: &str) -> crate::agent::output_runtime::RuntimeOutput {
        f.db.agent_output_stage_record(
            &RequestContext {
                request_id: name.into(),
                ..f.model.clone()
            },
            &f.binding,
            &StageRecordInput {
                intent: OutputIntent::FileCreate {
                    project_id: f.project,
                    safe_name: name.into(),
                    utf8_content: format!("body:{name}"),
                },
                sources: vec![],
            },
        )
        .unwrap()
    }
    fn settle(f: &Fixture) {
        f.db.agent_run_settle(
            &f.gui,
            &f.binding,
            &f.run,
            &RunSettlement {
                state: RunState::Failed,
                runtime_settled: true,
                projection: None,
                usage: None,
                error_code: None,
            },
        )
        .unwrap();
    }
    fn input(
        f: &Fixture,
        outputs: &[crate::agent::output_runtime::RuntimeOutput],
        decision: ReviewDecision,
    ) -> OutputReviewInput {
        OutputReviewInput {
            run_id: f.run.clone(),
            outputs: outputs
                .iter()
                .map(|o| OutputReviewItem {
                    output_id: o.staged.id.clone(),
                    expected_revision: o.staged.revision,
                })
                .collect(),
            decision,
            text: Some(
                if decision == ReviewDecision::Confirm {
                    "确认"
                } else {
                    "取消"
                }
                .into(),
            ),
        }
    }
    fn gui(f: &Fixture, id: &str) -> RequestContext {
        RequestContext {
            request_id: id.into(),
            ..f.gui.clone()
        }
    }
    fn prepare_next(
        f: &Fixture,
        run_id: &str,
        message: &str,
    ) -> AgentResult<crate::agent::conversation::PreparedRun> {
        f.db.agent_run_prepare(&f.gui,&f.binding,&f.session,message,&RunPreparation{run_id:run_id.into(),context_manifest:serde_json::json!({"scope":Scope::Project{project_id:f.project},"mode":ExecutionMode::Review})})
    }
    fn commit_file(f: &mut Fixture, id: &str) {
        let prepared =
            f.db.agent_output_commit_prepare(&f.gui, &f.binding, id, 1)
                .unwrap();
        let OutputIntent::FileCreate {
            project_id,
            safe_name,
            utf8_content,
        } = prepared.output.staged.intent
        else {
            panic!("expected File")
        };
        let request = RequestContext {
            request_id: prepared.commit_request_id,
            ..f.gui.clone()
        };
        f.db.agent_file_create_bound(
            &request,
            &f.binding,
            &AgentFileCreateInput {
                project_id,
                safe_name,
                utf8_content,
            },
            &WorkspaceCommitFence::new(),
        )
        .unwrap();
    }
    #[test]
    fn review_exact_set_authority_revision_freeze_and_reopen_replay() {
        let mut f = fixture();
        let one = stage(&f, "one.md");
        let two = stage(&f, "two.md");
        let decision = input(&f, &[two.clone(), one.clone()], ReviewDecision::Confirm);
        assert_eq!(
            f.db.agent_output_review(&f.model, &f.binding, &decision)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            f.db.agent_output_review(&f.gui, &f.binding, &decision)
                .unwrap_err()
                .code,
            ErrorCode::InvalidRunTransition
        );
        settle(&f);
        let mut incomplete = decision.clone();
        incomplete.outputs.pop();
        assert_eq!(
            f.db.agent_output_review(&f.gui, &f.binding, &incomplete)
                .unwrap_err()
                .code,
            ErrorCode::RevisionConflict
        );
        let mut stale = decision.clone();
        stale.outputs[0].expected_revision = 2;
        assert_eq!(
            f.db.agent_output_review(&f.gui, &f.binding, &stale)
                .unwrap_err()
                .code,
            ErrorCode::RevisionConflict
        );
        let mut duplicate = decision.clone();
        duplicate.outputs[0] = duplicate.outputs[1].clone();
        assert_eq!(
            f.db.agent_output_review(&f.gui, &f.binding, &duplicate)
                .unwrap_err()
                .code,
            ErrorCode::RevisionConflict
        );
        let mut too_long = decision.clone();
        too_long.text = Some("é".repeat(2049));
        assert_eq!(
            f.db.agent_output_review(&f.gui, &f.binding, &too_long)
                .unwrap_err()
                .code,
            ErrorCode::BudgetExceeded
        );
        assert!(f
            .db
            .agent_output_get(&f.gui, &f.binding, &one.staged.id)
            .unwrap()
            .review_decision
            .is_none());
        let approved =
            f.db.agent_output_review(&gui(&f, "approve"), &f.binding, &decision)
                .unwrap();
        assert_eq!(approved.outputs[0].staged.id, one.staged.id);
        assert_eq!(approved.outputs[1].staged.id, two.staged.id);
        assert_eq!(approved.outputs[0].staged.revision, 1);
        assert_eq!(approved.outputs[0].state, OutputState::Staged);
        let marked = approved.outputs[0].review_decision.clone().unwrap();
        assert_eq!(marked.text.as_deref(), Some("确认"));
        assert_eq!(marked.request_id, "approve");
        let mut duplicate_click = decision.clone();
        duplicate_click.text = Some("再次确认".into());
        let reused =
            f.db.agent_output_review(&gui(&f, "approve-again"), &f.binding, &duplicate_click)
                .unwrap();
        let preserved = reused.outputs[0].review_decision.as_ref().unwrap();
        assert_eq!(preserved.request_id, marked.request_id);
        assert_eq!(preserved.decided_at, marked.decided_at);
        assert_eq!(preserved.text, marked.text);
        let edit = OutputUpdateInput {
            output_id: one.staged.id.clone(),
            expected_revision: 1,
            candidate: StageRecordInput {
                intent: OutputIntent::FileCreate {
                    project_id: f.project,
                    safe_name: "changed.md".into(),
                    utf8_content: "edited".into(),
                },
                sources: vec![],
            },
        };
        assert_eq!(
            f.db.agent_output_update_validate(&gui(&f, "edit"), &f.binding, &edit)
                .unwrap_err()
                .code,
            ErrorCode::OutputCommitFailed
        );
        assert_eq!(
            f.db.agent_output_update(&gui(&f, "edit"), &f.binding, &edit)
                .unwrap_err()
                .code,
            ErrorCode::OutputCommitFailed
        );
        f.db = Database::open(&f.paths.db_path, f.root.path(), None).unwrap();
        let replay =
            f.db.agent_output_review(&gui(&f, "approve"), &f.binding, &decision)
                .unwrap();
        assert_eq!(
            replay.outputs[0]
                .review_decision
                .as_ref()
                .unwrap()
                .decided_at,
            marked.decided_at
        );
        let mut changed = decision.clone();
        changed.text = Some("different".into());
        assert_eq!(
            f.db.agent_output_review(&gui(&f, "approve"), &f.binding, &changed)
                .unwrap_err()
                .code,
            ErrorCode::IdempotencyConflict
        );
        assert_eq!(
            f.db.conn
                .query_row("SELECT count(*) FROM documents", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn review_partial_success_cancel_remaining_preserves_native_receipt_and_decisions() {
        let mut f = fixture();
        let one = stage(&f, "first.md");
        let two = stage(&f, "second.md");
        let three = stage(&f, "third.md");
        settle(&f);
        let approve = input(
            &f,
            &[one.clone(), two.clone(), three.clone()],
            ReviewDecision::Confirm,
        );
        f.db.agent_output_review(&gui(&f, "approve"), &f.binding, &approve)
            .unwrap();
        commit_file(&mut f, &one.staged.id);
        let prepared =
            f.db.agent_output_commit_prepare(&f.gui, &f.binding, &two.staged.id, 1)
                .unwrap();
        assert!(prepared.output.review_decision.is_some());
        f.db.agent_output_mark_failed(&f.gui, &f.binding, &two.staged.id, 1, ErrorCode::IoFailed)
            .unwrap();
        let actual =
            f.db.agent_output_review(&gui(&f, "approve"), &f.binding, &approve)
                .unwrap();
        assert_eq!(actual.outputs[0].state, OutputState::Committed);
        assert_eq!(actual.outputs[1].state, OutputState::Failed);
        assert_eq!(actual.outputs[2].state, OutputState::Staged);
        let receipt =
            f.db.agent_output_record_receipt(&f.gui, &f.binding, &one.staged.id, 1)
                .unwrap()
                .unwrap();
        let cancel = input(&f, &actual.outputs[1..], ReviewDecision::Cancel);
        let cancelled =
            f.db.agent_output_review(&gui(&f, "cancel"), &f.binding, &cancel)
                .unwrap();
        assert!(cancelled.outputs.iter().all(|o| o.dismissed
            && o.staged.revision == 2
            && o.review_decision.as_ref().unwrap().decision == ReviewDecision::Cancel));
        let replay =
            f.db.agent_output_review(&gui(&f, "cancel"), &f.binding, &cancel)
                .unwrap();
        assert!(replay.outputs.iter().all(|o| o.staged.revision == 2));
        assert_eq!(
            f.db.agent_output_record_receipt(&f.gui, &f.binding, &one.staged.id, 1)
                .unwrap()
                .unwrap(),
            receipt
        );
        assert_eq!(
            f.db.agent_output_get(&f.gui, &f.binding, &one.staged.id)
                .unwrap()
                .review_decision
                .unwrap()
                .decision,
            ReviewDecision::Confirm
        );
        assert!(f
            .db
            .agent_output_commit_prepare(&f.gui, &f.binding, &three.staged.id, 1)
            .is_err());
        let edit = OutputUpdateInput {
            output_id: three.staged.id.clone(),
            expected_revision: 2,
            candidate: StageRecordInput {
                intent: OutputIntent::FileCreate {
                    project_id: f.project,
                    safe_name: "edited.md".into(),
                    utf8_content: "new".into(),
                },
                sources: vec![],
            },
        };
        let edited =
            f.db.agent_output_update(&gui(&f, "edit-after-cancel"), &f.binding, &edit)
                .unwrap();
        assert!(!edited.dismissed);
        assert!(edited.review_decision.is_none());
        assert_eq!(edited.staged.revision, 3);
        assert_eq!(
            f.db.conn
                .query_row("SELECT count(*) FROM documents", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn review_new_run_gate_and_same_session_supersession_are_atomic() {
        let f = fixture();
        let one = stage(&f, "old.md");
        settle(&f);
        f.db.agent_output_review(
            &gui(&f, "approve"),
            &f.binding,
            &input(&f, &[one.clone()], ReviewDecision::Confirm),
        )
        .unwrap();
        f.db.agent_output_commit_prepare(&f.gui, &f.binding, &one.staged.id, 1)
            .unwrap();
        assert_eq!(
            prepare_next(&f, &"b".repeat(32), "next").unwrap_err().code,
            ErrorCode::OutputCommitFailed
        );
        assert_eq!(
            f.db.agent_output_get(&f.gui, &f.binding, &one.staged.id)
                .unwrap()
                .staged
                .revision,
            1
        );
        f.db.agent_output_mark_failed(&f.gui, &f.binding, &one.staged.id, 1, ErrorCode::IoFailed)
            .unwrap();
        f.db.conn.execute_batch("CREATE TRIGGER reject_new_run BEFORE INSERT ON agent_runs BEGIN SELECT RAISE(ABORT,'fixture run insert failure'); END").unwrap();
        assert!(prepare_next(&f, &"b".repeat(32), "next").is_err());
        assert!(
            !f.db
                .agent_output_get(&f.gui, &f.binding, &one.staged.id)
                .unwrap()
                .dismissed
        );
        f.db.conn
            .execute_batch("DROP TRIGGER reject_new_run")
            .unwrap();
        let unrelated_session =
            f.db.agent_session_create(
                &f.gui,
                &f.binding,
                &Scope::Project {
                    project_id: f.project,
                },
                "Other session",
                "pi",
                None,
            )
            .unwrap()
            .id;
        let unrelated_run = "c".repeat(32);
        f.db.agent_run_prepare(&f.gui,&f.binding,&unrelated_session,"other-message",&RunPreparation{run_id:unrelated_run.clone(),context_manifest:serde_json::json!({"scope":Scope::Project{project_id:f.project},"mode":ExecutionMode::Review})}).unwrap();
        f.db.agent_run_start(&f.gui, &f.binding, &unrelated_run)
            .unwrap();
        let unrelated_model = RequestContext {
            caller: Caller::BuiltinRun {
                run_id: unrelated_run.clone(),
            },
            request_id: "other-candidate".into(),
            ..f.gui.clone()
        };
        let unrelated =
            f.db.agent_output_stage_record(
                &unrelated_model,
                &f.binding,
                &StageRecordInput {
                    intent: OutputIntent::FileCreate {
                        project_id: f.project,
                        safe_name: "other.md".into(),
                        utf8_content: "other".into(),
                    },
                    sources: vec![],
                },
            )
            .unwrap();
        f.db.agent_run_settle(
            &f.gui,
            &f.binding,
            &unrelated_run,
            &RunSettlement {
                state: RunState::Failed,
                runtime_settled: true,
                projection: None,
                usage: None,
                error_code: None,
            },
        )
        .unwrap();
        let newer = "0".repeat(32);
        prepare_next(&f, &newer, "next").unwrap();
        let unchanged =
            f.db.agent_output_get(&f.gui, &f.binding, &unrelated.staged.id)
                .unwrap();
        assert!(!unchanged.dismissed);
        assert_eq!(unchanged.staged.revision, 1);
        f.db.conn
            .execute(
                "UPDATE agent_runs SET started_at='2026-10-08T00:00:00Z' WHERE session_id=?1",
                [&f.session],
            )
            .unwrap();
        assert_eq!(
            f.db.agent_session_get(&f.gui, &f.binding, &f.session, None, 50)
                .unwrap()
                .latest_run
                .unwrap()
                .id,
            newer
        );
        let expired =
            f.db.agent_output_get(&f.gui, &f.binding, &one.staged.id)
                .unwrap();
        assert!(expired.dismissed);
        assert_eq!(expired.staged.revision, 2);
        assert_eq!(
            expired.review_decision.unwrap().decision,
            ReviewDecision::Confirm
        );
        assert!(f
            .db
            .agent_output_review(
                &gui(&f, "new-old-approval"),
                &f.binding,
                &input(&f, &[one], ReviewDecision::Confirm)
            )
            .is_err());
    }
    #[test]
    fn review_cancel_and_candidate_edit_share_real_sqlite_cas() {
        let f = fixture();
        let original = stage(&f, "race.md");
        settle(&f);
        let cancel = input(&f, &[original.clone()], ReviewDecision::Cancel);
        let update = OutputUpdateInput {
            output_id: original.staged.id.clone(),
            expected_revision: 1,
            candidate: StageRecordInput {
                intent: OutputIntent::FileCreate {
                    project_id: f.project,
                    safe_name: "race-edited.md".into(),
                    utf8_content: "edited".into(),
                },
                sources: vec![],
            },
        };
        let review_db = Database::open(&f.paths.db_path, f.root.path(), None).unwrap();
        let edit_db = Database::open(&f.paths.db_path, f.root.path(), None).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let left_barrier = barrier.clone();
        let left_request = gui(&f, "cancel-race");
        let left_binding = f.binding.clone();
        let left = std::thread::spawn(move || {
            left_barrier.wait();
            review_db.agent_output_review(&left_request, &left_binding, &cancel)
        });
        let right_barrier = barrier.clone();
        let right_request = gui(&f, "edit-race");
        let right_binding = f.binding.clone();
        let right = std::thread::spawn(move || {
            right_barrier.wait();
            edit_db.agent_output_update(&right_request, &right_binding, &update)
        });
        barrier.wait();
        let left = left.join().unwrap();
        let right = right.join().unwrap();
        assert_ne!(left.is_ok(), right.is_ok());
        assert_eq!(
            if let Err(error) = left {
                error.code
            } else {
                right.unwrap_err().code
            },
            ErrorCode::RevisionConflict
        );
        let actual =
            f.db.agent_output_get(&f.gui, &f.binding, &original.staged.id)
                .unwrap();
        assert_eq!(actual.staged.revision, 2);
    }
    #[test]
    fn review_decision_metadata_and_receipt_roll_back_together() {
        let f = fixture();
        let one = stage(&f, "first.md");
        let two = stage(&f, "second.md");
        settle(&f);
        f.db.conn.execute_batch(&format!("CREATE TRIGGER reject_second_review BEFORE UPDATE ON agent_outputs WHEN NEW.id='{}' BEGIN SELECT RAISE(ABORT,'fixture review failure'); END",two.staged.id)).unwrap();
        let approve = input(&f, &[one.clone(), two.clone()], ReviewDecision::Confirm);
        assert_eq!(
            f.db.agent_output_review(&gui(&f, "rollback-review"), &f.binding, &approve)
                .unwrap_err()
                .code,
            ErrorCode::IoFailed
        );
        assert!(f
            .db
            .agent_output_get(&f.gui, &f.binding, &one.staged.id)
            .unwrap()
            .review_decision
            .is_none());
        assert!(f
            .db
            .agent_output_get(&f.gui, &f.binding, &two.staged.id)
            .unwrap()
            .review_decision
            .is_none());
        assert_eq!(
            f.db.conn
                .query_row(
                    "SELECT count(*) FROM agent_operation_receipts WHERE operation='output.review'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
    fn start_metadata_reader(f: &Fixture) -> RequestContext {
        let id = "b".repeat(32);
        f.db.agent_run_prepare(&f.gui,&f.binding,&f.session,"follow-up-message",&RunPreparation{run_id:id.clone(),context_manifest:serde_json::json!({"scope":Scope::Project{project_id:f.project},"mode":ExecutionMode::ReadOnly})}).unwrap();
        f.db.agent_run_start(&f.gui, &f.binding, &id).unwrap();
        RequestContext {
            caller: Caller::BuiltinRun { run_id: id },
            request_id: "read-prior-status".into(),
            ..f.gui.clone()
        }
    }
    fn metadata_permissions(f: &mut Fixture) {
        f.gui.scope_grant.operations.extend(
            [
                "operation.read",
                "operation.undo",
                "operation.restore_created",
            ]
            .into_iter()
            .map(str::to_owned),
        );
    }
    #[test]
    fn session_metadata_reads_follow_real_gui_commit_withdraw_and_cancel_without_write_authority() {
        let mut f = fixture();
        metadata_permissions(&mut f);
        let saved = stage(&f, "saved.md");
        let remaining = stage(&f, "remaining.md");
        settle(&f);
        f.db.agent_output_review(
            &gui(&f, "approve-old"),
            &f.binding,
            &input(
                &f,
                &[saved.clone(), remaining.clone()],
                ReviewDecision::Confirm,
            ),
        )
        .unwrap();
        commit_file(&mut f, &saved.staged.id);
        let operation =
            f.db.agent_output_record_operation(&f.gui, &f.binding, &saved.staged.id, 1)
                .unwrap()
                .unwrap();
        f.db.agent_file_creation_withdraw(
            &gui(&f, "withdraw-old"),
            &f.binding,
            &crate::db::agent_record_withdrawals::RecordWithdrawalInput {
                creation_operation_id: operation.operation_id.clone(),
            },
        )
        .unwrap();
        f.db.agent_output_review(
            &gui(&f, "cancel-old-remaining"),
            &f.binding,
            &input(&f, &[remaining.clone()], ReviewDecision::Cancel),
        )
        .unwrap();
        let reader = start_metadata_reader(&f);
        let output =
            f.db.agent_output_get(&reader, &f.binding, &saved.staged.id)
                .unwrap();
        assert_eq!(output.state, OutputState::Committed);
        assert_eq!(
            output.review_decision.unwrap().decision,
            ReviewDecision::Confirm
        );
        let actual =
            f.db.agent_operation_get(&reader, &f.binding, &operation.operation_id)
                .unwrap();
        assert_eq!(actual.undo_state, "undone");
        assert!(actual.recovery.unwrap().withdrawn);
        let page =
            f.db.agent_operation_list(
                &reader,
                &f.binding,
                &crate::agent::operations::OperationListInput {
                    run_id: f.run.clone(),
                    cursor: None,
                    limit: 50,
                },
            )
            .unwrap();
        assert!(page
            .operations
            .iter()
            .any(|o| o.operation_id == operation.operation_id));
        assert_eq!(
            f.db.agent_operation_access(
                &reader,
                &f.binding,
                &operation.operation_id,
                "operation.undo"
            )
            .unwrap_err()
            .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            f.db.agent_output_list(&reader, &f.binding, &f.run, None, 50)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            f.db.agent_output_commit_prepare(&reader, &f.binding, &remaining.staged.id, 2)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        let update = OutputUpdateInput {
            output_id: remaining.staged.id.clone(),
            expected_revision: 2,
            candidate: StageRecordInput {
                intent: OutputIntent::FileCreate {
                    project_id: f.project,
                    safe_name: "changed.md".into(),
                    utf8_content: "changed".into(),
                },
                sources: vec![],
            },
        };
        assert_eq!(
            f.db.agent_output_update(&reader, &f.binding, &update)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        let summary =
            f.db.agent_output_decision_summary(&reader, &f.binding)
                .unwrap();
        assert_eq!(summary.outputs.len(), 2);
        assert!(!summary.has_more);
        let cancelled = summary
            .outputs
            .iter()
            .find(|o| o.id == remaining.staged.id)
            .unwrap();
        assert!(cancelled.dismissed);
        assert_eq!(cancelled.revision, 2);
        assert_eq!(cancelled.decision, ReviewDecision::Cancel);
        let serialized = serde_json::to_value(summary).unwrap();
        for item in serialized["outputs"].as_array().unwrap() {
            assert_eq!(item.as_object().unwrap().len(), 6);
            assert!(item.get("intent").is_none());
            assert!(item.get("text").is_none());
        }
    }
    #[test]
    fn session_metadata_reads_reject_cross_session_current_grant_and_stored_grant() {
        let mut f = fixture();
        metadata_permissions(&mut f);
        let old = stage(&f, "old.md");
        settle(&f);
        commit_file(&mut f, &old.staged.id);
        let original =
            f.db.agent_output_record_operation(&f.gui, &f.binding, &old.staged.id, 1)
                .unwrap()
                .unwrap();
        let other_session =
            f.db.agent_session_create(
                &f.gui,
                &f.binding,
                &Scope::Project {
                    project_id: f.project,
                },
                "Other",
                "pi",
                None,
            )
            .unwrap()
            .id;
        let other_run = "c".repeat(32);
        f.db.agent_run_prepare(&f.gui,&f.binding,&other_session,"other-message",&RunPreparation{run_id:other_run.clone(),context_manifest:serde_json::json!({"scope":Scope::Project{project_id:f.project},"mode":ExecutionMode::Review})}).unwrap();
        f.db.agent_run_start(&f.gui, &f.binding, &other_run)
            .unwrap();
        let other_model = RequestContext {
            caller: Caller::BuiltinRun {
                run_id: other_run.clone(),
            },
            request_id: "other-output".into(),
            ..f.gui.clone()
        };
        let other =
            f.db.agent_output_stage_record(
                &other_model,
                &f.binding,
                &StageRecordInput {
                    intent: OutputIntent::FileCreate {
                        project_id: f.project,
                        safe_name: "other.md".into(),
                        utf8_content: "private other".into(),
                    },
                    sources: vec![],
                },
            )
            .unwrap();
        f.db.agent_run_settle(
            &f.gui,
            &f.binding,
            &other_run,
            &RunSettlement {
                state: RunState::Failed,
                runtime_settled: true,
                projection: None,
                usage: None,
                error_code: None,
            },
        )
        .unwrap();
        commit_file(&mut f, &other.staged.id);
        let other_operation =
            f.db.agent_output_record_operation(&f.gui, &f.binding, &other.staged.id, 1)
                .unwrap()
                .unwrap();
        let reader = start_metadata_reader(&f);
        assert_eq!(
            f.db.agent_output_get(&reader, &f.binding, &other.staged.id)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            f.db.agent_operation_get(&reader, &f.binding, &other_operation.operation_id)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            f.db.agent_operation_list(
                &reader,
                &f.binding,
                &crate::agent::operations::OperationListInput {
                    run_id: other_run,
                    cursor: None,
                    limit: 50
                }
            )
            .unwrap_err()
            .code,
            ErrorCode::ScopeDenied
        );
        let mut denied = reader.clone();
        denied.scope_grant.project_ids.clear();
        assert_eq!(
            f.db.agent_output_get(&denied, &f.binding, &old.staged.id)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            f.db.agent_operation_get(&denied, &f.binding, &original.operation_id)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        let mut connection = reader.clone();
        connection.caller = Caller::Connection {
            grant_id: "connection".into(),
        };
        assert_eq!(
            f.db.agent_output_get(&connection, &f.binding, &old.staged.id)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            f.db.agent_operation_get(&connection, &f.binding, &original.operation_id)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        let Caller::BuiltinRun { run_id } = reader.caller.clone() else {
            unreachable!()
        };
        f.db.conn.execute("UPDATE agent_runs SET grant_json=json_set(grant_json,'$.operations',json('[]')) WHERE id=?1",[&run_id]).unwrap();
        assert_eq!(
            f.db.agent_output_get(&reader, &f.binding, &old.staged.id)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            f.db.agent_operation_get(&reader, &f.binding, &original.operation_id)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
    }
    #[test]
    fn session_metadata_summary_is_bounded_and_does_not_encode_candidate_or_user_text() {
        let f = fixture();
        let outputs = (0..21)
            .map(|n| stage(&f, &format!("private-body-{n}.md")))
            .collect::<Vec<_>>();
        settle(&f);
        let mut cancel = input(&f, &outputs, ReviewDecision::Cancel);
        cancel.text = Some("USER_TEXT_MUST_NOT_BECOME_HOST_INSTRUCTION".into());
        f.db.agent_output_review(&gui(&f, "cancel-many"), &f.binding, &cancel)
            .unwrap();
        let reader = start_metadata_reader(&f);
        let summary =
            f.db.agent_output_decision_summary(&reader, &f.binding)
                .unwrap();
        assert_eq!(summary.outputs.len(), 20);
        assert!(summary.has_more);
        let json = serde_json::to_string(&summary).unwrap();
        assert!(!json.contains("private-body"));
        assert!(!json.contains("USER_TEXT_MUST_NOT"));
        assert!(!json.contains("utf8Content"));
        assert!(!json.contains("text"));
        assert!(summary
            .outputs
            .iter()
            .all(|o| o.dismissed && o.decision == ReviewDecision::Cancel));
        assert!(
            f.db.agent_output_get(&reader, &f.binding, &outputs[0].staged.id)
                .unwrap()
                .dismissed
        );
    }
}
