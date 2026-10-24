//! Receipt-only planning. Each native group executor must still check live CAS,
//! metadata, immutable snapshots and dependencies under its own writer boundary.
use super::{
    agent_operations::io_error,
    agent_record_undo::{authorize, read_entry},
    Database,
};
use crate::agent::{
    access::{Caller, RequestContext},
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, WorkspaceBinding},
    operation_batches::*,
    operations::OperationEntry,
};
use rusqlite::{params, Transaction, TransactionBehavior};
use std::collections::{HashMap, HashSet};
struct Receipt {
    sequence: i64,
    entry: OperationEntry,
    recovery: bool,
}
fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn supported(entry: &OperationEntry, recovery: bool) -> bool {
    !recovery
        && matches!(
            (&entry.object.kind, entry.kind.as_str()),
            (ObjectKind::Record, "record.create" | "record.patch")
                | (ObjectKind::Todo, "todo.create" | "todo.update")
                | (ObjectKind::File, "file.create" | "file.version.commit")
        )
}
fn no_change(entry: &OperationEntry) -> bool {
    entry.undo_state == "unavailable"
        && entry.before_revision.is_some()
        && entry.before_revision == entry.after_revision
}
fn add_conflict(
    group: &mut OperationUndoGroup,
    reason: OperationBatchConflictReason,
    ids: Vec<String>,
    message: &str,
) {
    let code = if reason == OperationBatchConflictReason::UnsupportedKind {
        ErrorCode::ToolCallUnsupported
    } else {
        ErrorCode::UndoConflict
    };
    group.conflicts.push(OperationBatchConflict {
        reason,
        operation_ids: ids,
        error: AgentError::new(code, message),
    });
}
fn undo_state(entries: &[OperationEntry]) -> OperationBatchUndoState {
    if entries.iter().all(|e| e.undo_state == "available") {
        OperationBatchUndoState::Available
    } else if entries.iter().all(|e| e.undo_state == "undone") {
        OperationBatchUndoState::Undone
    } else if entries.iter().all(|e| e.undo_state == "unavailable") {
        OperationBatchUndoState::Unavailable
    } else {
        OperationBatchUndoState::Mixed
    }
}
impl Database {
    pub(crate) fn agent_operation_undo_batch_plan(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &OperationUndoBatchInput,
    ) -> AgentResult<OperationUndoBatchPlan> {
        self.operation_binding(binding)?;
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Deferred)
            .map_err(io_error)?;
        plan(&tx, request, binding, input)
    }
}
/// Caller supplies a stable read or native writer transaction; never opens a nested transaction.
pub(super) fn plan(
    conn: &rusqlite::Connection,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    input: &OperationUndoBatchInput,
) -> AgentResult<OperationUndoBatchPlan> {
    if !matches!(request.caller, Caller::Gui) {
        return Err(AgentError::new(
            ErrorCode::ScopeDenied,
            "Batch undo belongs to the local interface",
        ));
    }
    if !valid_id(&input.run_id)
        || input.operation_ids.is_empty()
        || input.operation_ids.len() > 256
        || input.operation_ids.iter().any(|id| !valid_id(id))
    {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Batch undo requires one actual Run and 1–256 operation IDs",
        ));
    }
    let selected: HashSet<&str> = input.operation_ids.iter().map(String::as_str).collect();
    if selected.len() != input.operation_ids.len() {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Batch undo operation IDs must be unique",
        ));
    }
    // No run/session join: original business receipts survive chat deletion.
    let mut receipts = Vec::with_capacity(input.operation_ids.len());
    for id in &input.operation_ids {
        let (entry, caller) = read_entry(conn, id)?;
        if entry.run_id.as_deref() != Some(input.run_id.as_str()) {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Batch operations must belong to the same actual Run",
            ));
        }
        authorize(request, binding, &entry, &caller, "operation.undo")?;
        let(sequence,recovery):(i64,bool)=conn.query_row("SELECT rowid,(COALESCE(json_extract(output_context_json,'$.recovery') IN ('file.undo','file.chain_undo'),0) OR instr(request_id,'fileundo:')=1 OR instr(request_id,'filechainundo:')=1) FROM agent_operation_receipts WHERE operation_id=?1 AND state='committed'",[id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(io_error)?;
        receipts.push(Receipt {
            sequence,
            entry,
            recovery,
        });
    }
    receipts.sort_by_key(|r| r.sequence);
    let mut plan = OperationUndoBatchPlan {
        run_id: input.run_id.clone(),
        groups: vec![],
        excluded_no_change: vec![],
    };
    let mut indices = HashMap::new();
    let mut bounds: HashMap<String, (i64, i64)> = HashMap::new();
    for receipt in receipts {
        if supported(&receipt.entry, receipt.recovery) && no_change(&receipt.entry) {
            plan.excluded_no_change.push(receipt.entry);
            continue;
        }
        let key = receipt.entry.object.key()?;
        let index = if let Some(index) = indices.get(&key) {
            *index
        } else {
            let index = plan.groups.len();
            indices.insert(key.clone(), index);
            bounds.insert(key.clone(), (receipt.sequence, receipt.sequence));
            plan.groups.push(OperationUndoGroup {
                object: receipt.entry.object.clone(),
                object_key: key.clone(),
                operations: vec![],
                undo_state: OperationBatchUndoState::Unavailable,
                conflicts: vec![],
            });
            index
        };
        bounds.get_mut(&key).unwrap().1 = receipt.sequence;
        let group = &mut plan.groups[index];
        if !supported(&receipt.entry, receipt.recovery) {
            add_conflict(
                group,
                OperationBatchConflictReason::UnsupportedKind,
                vec![receipt.entry.operation_id.clone()],
                "This receipt is not an original Record, Todo or File business operation",
            );
        }
        group.operations.push(receipt.entry);
    }
    for group in &mut plan.groups {
        group.undo_state = undo_state(&group.operations);
        let entries = group.operations.clone();
        for (index, entry) in entries.iter().enumerate() {
            let creation = matches!(
                entry.kind.as_str(),
                "record.create" | "todo.create" | "file.create"
            );
            if creation && index != 0 {
                add_conflict(
                    group,
                    OperationBatchConflictReason::CreationBoundary,
                    vec![entry.operation_id.clone()],
                    "Object creation must begin the selected native operation chain",
                );
            }
            let snapshot_valid =
                |value: &Option<String>| value.as_ref().is_some_and(|v| !v.is_empty());
            if entry.after_revision.is_none_or(|v| v == 0)
                || !snapshot_valid(&entry.after_snapshot_ref)
                || (!creation
                    && (entry.before_revision.is_none_or(|v| v == 0)
                        || !snapshot_valid(&entry.before_snapshot_ref)
                        || entry.after_revision <= entry.before_revision))
                || (creation
                    && (entry.before_revision.is_some() || entry.before_snapshot_ref.is_some()))
            {
                add_conflict(
                    group,
                    OperationBatchConflictReason::IncompleteBaseline,
                    vec![entry.operation_id.clone()],
                    "Native receipt is missing its immutable revision baseline",
                );
            }
            if let Some(previous) = index.checked_sub(1).map(|i| &entries[i]) {
                if previous.after_revision != entry.before_revision {
                    add_conflict(
                        group,
                        OperationBatchConflictReason::RevisionGap,
                        vec![previous.operation_id.clone(), entry.operation_id.clone()],
                        "Selected operations do not form a continuous native revision chain",
                    );
                } else if group.object.kind != ObjectKind::Record
                    && previous.after_snapshot_ref != entry.before_snapshot_ref
                {
                    add_conflict(
                        group,
                        OperationBatchConflictReason::SnapshotGap,
                        vec![previous.operation_id.clone(), entry.operation_id.clone()],
                        "Immutable Todo or File snapshots differ at the same revision boundary",
                    );
                }
            }
        }
        let (first, last) = bounds[&group.object_key];
        let object = serde_json::to_value(&group.object)
            .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot inspect receipt identity"))?;
        let mut stmt=conn.prepare("SELECT rowid,operation_id FROM agent_operation_receipts WHERE state='committed' AND operation_id IS NOT NULL AND rowid>?1 AND json_extract(target_ref_json,'$.workspaceId')=?2 AND json_extract(target_ref_json,'$.kind')=?3 AND json_extract(target_ref_json,'$.id')=?4 AND json_extract(target_ref_json,'$.scope.kind')=?5 AND json_extract(target_ref_json,'$.scope.projectId') IS ?6 ORDER BY rowid").map_err(io_error)?;
        let rows = stmt
            .query_map(
                params![
                    first,
                    object["workspaceId"].as_str(),
                    object["kind"].as_str(),
                    object["id"].as_str(),
                    object["scope"]["kind"].as_str(),
                    object["scope"]["projectId"].as_i64()
                ],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
            )
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error)?;
        let inverse_ids: HashSet<&str> = entries
            .iter()
            .filter_map(|e| e.undo_operation_id.as_deref())
            .collect();
        for (sequence, id) in rows {
            if selected.contains(id.as_str()) || inverse_ids.contains(id.as_str()) {
                continue;
            }
            let recovery: bool=conn.query_row("SELECT COALESCE(json_extract(output_context_json,'$.recovery') IN ('file.undo','file.chain_undo'),0) OR instr(request_id,'fileundo:')=1 OR instr(request_id,'filechainundo:')=1 FROM agent_operation_receipts WHERE operation_id=?1",[&id],|row|row.get(0)).map_err(io_error)?;
            if recovery {
                continue;
            }
            let (entry, _) = read_entry(conn, &id)?;
            // Visibility receipts and no-change actions do not advance a head.
            if no_change(&entry) {
                continue;
            }
            if entry.before_revision == entry.after_revision {
                continue;
            }
            add_conflict(
                group,
                if sequence <= last {
                    OperationBatchConflictReason::MissingInterveningOperation
                } else {
                    OperationBatchConflictReason::MissingLaterOperation
                },
                vec![id],
                "A later native modification to this object is outside the selected chain",
            );
        }
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            access::ScopeGrant,
            conversation::{RunPreparation, RunSettlement},
            models::{ExecutionMode, ObjectRef, Scope},
            output_review::{OutputReviewInput, OutputReviewItem, ReviewDecision},
            output_runtime::StageRecordInput,
            outputs::OutputIntent,
            runtime::RunState,
        },
        db::file_imports::AgentFileCreateInput,
        workspace_commit_fence::WorkspaceCommitFence,
    };
    struct Fixture {
        _root: tempfile::TempDir,
        db: Database,
        binding: WorkspaceBinding,
        request: RequestContext,
        run: String,
        session: String,
        project: i64,
        native: OperationEntry,
    }
    fn fixture() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let (metadata, paths) =
            crate::workspace::create_workspace(root.path(), "password").unwrap();
        let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
        let project = db
            .project_create(crate::models::ProjectCreateInput {
                name: "Batch receipts".into(),
                summary: None,
                status: None,
            })
            .unwrap()
            .id;
        let binding = WorkspaceBinding {
            workspace_id: metadata.workspace_id,
            generation: "batch-test".into(),
        };
        let request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "batch-request".into(),
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
                    "operation.read",
                    "operation.undo",
                ]
                .into_iter()
                .map(str::to_owned)
                .collect(),
            },
        };
        let session = db
            .agent_session_create(
                &request,
                &binding,
                &Scope::Project {
                    project_id: project,
                },
                "Batch",
                "pi",
                None,
            )
            .unwrap()
            .id;
        let run = "a".repeat(32);
        db.agent_run_prepare(&request,&binding,&session,"user-message",&RunPreparation{run_id:run.clone(),context_manifest:serde_json::json!({"scope":Scope::Project{project_id:project},"mode":ExecutionMode::Review})}).unwrap();
        db.agent_run_start(&request, &binding, &run).unwrap();
        let model = RequestContext {
            caller: Caller::BuiltinRun {
                run_id: run.clone(),
            },
            request_id: "stage-file".into(),
            ..request.clone()
        };
        let staged = db
            .agent_output_stage_record(
                &model,
                &binding,
                &StageRecordInput {
                    intent: OutputIntent::FileCreate {
                        project_id: Some(project),
                        safe_name: "actual.md".into(),
                        utf8_content: "native bytes".into(),
                    },
                    sources: vec![],
                },
            )
            .unwrap();
        db.agent_run_settle(
            &request,
            &binding,
            &run,
            &RunSettlement {
                state: RunState::Failed,
                runtime_settled: true,
                projection: None,
                usage: None,
                error_code: None,
            },
        )
        .unwrap();
        let review = RequestContext {
            request_id: "approve-file".into(),
            ..request.clone()
        };
        db.agent_output_review(
            &review,
            &binding,
            &OutputReviewInput {
                run_id: run.clone(),
                outputs: vec![OutputReviewItem {
                    output_id: staged.staged.id.clone(),
                    expected_revision: 1,
                }],
                decision: ReviewDecision::Confirm,
                text: None,
            },
        )
        .unwrap();
        let prepared = db
            .agent_output_commit_prepare(&request, &binding, &staged.staged.id, 1)
            .unwrap();
        let native_request = RequestContext {
            request_id: prepared.commit_request_id,
            ..request.clone()
        };
        db.agent_file_create_bound(
            &native_request,
            &binding,
            &AgentFileCreateInput {
                project_id: Some(project),
                safe_name: "actual.md".into(),
                utf8_content: "native bytes".into(),
            },
            &WorkspaceCommitFence::new(),
        )
        .unwrap();
        let native = db
            .agent_output_record_operation(&request, &binding, &staged.staged.id, 1)
            .unwrap()
            .unwrap();
        Fixture {
            _root: root,
            db,
            binding,
            request,
            run,
            session,
            project,
            native,
        }
    }
    fn object(f: &Fixture, kind: ObjectKind, id: &str) -> ObjectRef {
        ObjectRef {
            workspace_id: f.binding.workspace_id.clone(),
            scope: Scope::Project {
                project_id: f.project,
            },
            kind,
            id: id.into(),
        }
    }
    /// Persist receipt fixtures in the real formal table; no in-memory entry sorting.
    fn receipt(
        f: &Fixture,
        id: &str,
        object: &ObjectRef,
        kind: &str,
        before: Option<u64>,
        after: u64,
        before_snapshot: Option<&str>,
        after_snapshot: &str,
        state: &str,
    ) {
        f.db.conn.execute("INSERT INTO agent_operation_receipts(request_id,caller_id,payload_hash,operation,state,result_json,created_at,operation_id,run_id,target_ref_json,before_revision,after_revision,before_snapshot_ref,after_snapshot_ref,output_context_json,undo_state) VALUES (?1,'gui',?2,?3,'committed','{}','2030-01-01T00:00:00+00:00',?4,?5,?6,?7,?8,?9,?10,'{}',?11)",params![format!("fixture:{id}"),format!("sha256:{}","1".repeat(64)),kind,id,f.run,serde_json::to_string(object).unwrap(),before.map(|v|v as i64),after as i64,before_snapshot,after_snapshot,state]).unwrap();
    }
    fn input(f: &Fixture, ids: &[&str]) -> OperationUndoBatchInput {
        OperationUndoBatchInput {
            run_id: f.run.clone(),
            operation_ids: ids.iter().map(|id| (*id).into()).collect(),
        }
    }
    fn conflicts(group: &OperationUndoGroup, reason: OperationBatchConflictReason) -> bool {
        group.conflicts.iter().any(|c| c.reason == reason)
    }
    #[test]
    fn batch_planner_real_native_receipt_survives_run_deletion_and_reuses_writer_transaction() {
        let f = fixture();
        let operation_id = f.native.operation_id.clone();
        f.db.agent_session_delete(&f.request, &f.binding, &f.session)
            .unwrap();
        let before = f.db.committed_change_watermark().unwrap();
        let batch = input(&f, &[&operation_id]);
        let planned =
            f.db.agent_operation_undo_batch_plan(&f.request, &f.binding, &batch)
                .unwrap();
        assert_eq!(planned.run_id, f.run);
        assert_eq!(planned.groups.len(), 1);
        assert_eq!(
            planned.groups[0].creation().unwrap().operation_id,
            operation_id
        );
        assert!(planned.groups[0].conflicts.is_empty());
        let tx = Transaction::new_unchecked(&f.db.conn, TransactionBehavior::Immediate).unwrap();
        assert_eq!(
            plan(&tx, &f.request, &f.binding, &batch).unwrap().groups[0]
                .first()
                .operation_id,
            operation_id
        );
        drop(tx);
        assert_eq!(f.db.committed_change_watermark().unwrap(), before);
        assert_eq!(
            f.db.agent_operation_get(&f.request, &f.binding, &operation_id)
                .unwrap()
                .undo_state,
            "available"
        );
    }
    #[test]
    fn batch_planner_uses_sqlite_order_record_action_boundaries_and_excludes_no_change() {
        let f = fixture();
        let record = object(&f, ObjectKind::Record, "10");
        let todo = object(&f, ObjectKind::Todo, "10");
        let created = "f".repeat(32);
        let changed = "1".repeat(32);
        let todo_created = "8".repeat(32);
        let todo_changed = "7".repeat(32);
        let unchanged = "e".repeat(32);
        receipt(
            &f,
            &created,
            &record,
            "record.create",
            None,
            1,
            None,
            "record-created-v1",
            "available",
        );
        receipt(
            &f,
            &todo_created,
            &todo,
            "todo.create",
            None,
            3,
            None,
            "todo-v3",
            "available",
        );
        receipt(
            &f,
            &changed,
            &record,
            "record.patch",
            Some(1),
            2,
            Some("different-action-checkpoint-v1"),
            "record-v2",
            "available",
        );
        receipt(
            &f,
            &todo_changed,
            &todo,
            "todo.update",
            Some(3),
            4,
            Some("todo-v3"),
            "todo-v4",
            "available",
        );
        receipt(
            &f,
            &unchanged,
            &record,
            "record.patch",
            Some(2),
            2,
            Some("record-v2"),
            "record-v2",
            "unavailable",
        );
        let planned =
            f.db.agent_operation_undo_batch_plan(
                &f.request,
                &f.binding,
                &input(
                    &f,
                    &[&todo_changed, &changed, &unchanged, &created, &todo_created],
                ),
            )
            .unwrap();
        assert_eq!(planned.groups.len(), 2);
        let group = &planned.groups[0];
        assert_eq!(group.object, record);
        assert_eq!(group.first().operation_id, created);
        assert_eq!(group.last().operation_id, changed);
        assert_eq!(
            group.operations[0].created_at,
            group.operations[1].created_at
        );
        assert!(group.conflicts.is_empty());
        assert_eq!(group.undo_state, OperationBatchUndoState::Available);
        assert_eq!(
            planned.groups[1].creation().unwrap().operation_id,
            todo_created
        );
        assert!(planned.groups[1].conflicts.is_empty());
        assert_eq!(planned.excluded_no_change[0].operation_id, unchanged);
    }
    #[test]
    fn batch_planner_reports_revision_gaps_and_omitted_intervening_or_later_receipts() {
        let f = fixture();
        let record = object(&f, ObjectKind::Record, "11");
        let ids = (1..=4).map(|n| format!("{n:032x}")).collect::<Vec<_>>();
        for (n, id) in ids.iter().enumerate() {
            receipt(
                &f,
                id,
                &record,
                "record.patch",
                Some(n as u64 + 1),
                n as u64 + 2,
                Some(&format!("before{n}")),
                &format!("after{n}"),
                "available",
            );
        }
        f.db.conn
            .execute(
                "UPDATE agent_operation_receipts SET run_id=?1 WHERE operation_id=?2",
                params!["b".repeat(32), ids[3]],
            )
            .unwrap();
        let planned =
            f.db.agent_operation_undo_batch_plan(
                &f.request,
                &f.binding,
                &input(&f, &[&ids[2], &ids[0]]),
            )
            .unwrap();
        let group = &planned.groups[0];
        assert!(conflicts(group, OperationBatchConflictReason::RevisionGap));
        assert!(conflicts(
            group,
            OperationBatchConflictReason::MissingInterveningOperation
        ));
        assert!(conflicts(
            group,
            OperationBatchConflictReason::MissingLaterOperation
        ));
        assert!(group
            .conflicts
            .iter()
            .any(|c| c.operation_ids == vec![ids[1].clone()]));
        assert!(group
            .conflicts
            .iter()
            .any(|c| c.operation_ids == vec![ids[3].clone()]));
    }
    #[test]
    fn batch_planner_preserves_mixed_state_and_checks_immutable_snapshot_boundaries() {
        let f = fixture();
        let todo = object(&f, ObjectKind::Todo, "12");
        let one = "1".repeat(32);
        let two = "2".repeat(32);
        receipt(
            &f,
            &one,
            &todo,
            "todo.update",
            Some(1),
            2,
            Some("todo-v1"),
            "todo-v2",
            "undone",
        );
        receipt(
            &f,
            &two,
            &todo,
            "todo.update",
            Some(2),
            3,
            Some("wrong-v2"),
            "todo-v3",
            "available",
        );
        let planned =
            f.db.agent_operation_undo_batch_plan(&f.request, &f.binding, &input(&f, &[&two, &one]))
                .unwrap();
        let group = &planned.groups[0];
        assert_eq!(group.undo_state, OperationBatchUndoState::Mixed);
        assert_eq!(group.first().undo_state, "undone");
        assert_eq!(group.last().undo_state, "available");
        assert!(conflicts(group, OperationBatchConflictReason::SnapshotGap));
        let unknown = "3".repeat(32);
        receipt(
            &f,
            &unknown,
            &object(&f, ObjectKind::Record, "13"),
            "record.undo",
            Some(2),
            3,
            Some("r2"),
            "r3",
            "unavailable",
        );
        let planned =
            f.db.agent_operation_undo_batch_plan(&f.request, &f.binding, &input(&f, &[&unknown]))
                .unwrap();
        assert!(conflicts(
            &planned.groups[0],
            OperationBatchConflictReason::UnsupportedKind
        ));
        assert_eq!(
            planned.groups[0].conflicts[0].error.code,
            ErrorCode::ToolCallUnsupported
        );
    }
    #[test]
    fn batch_planner_file_recovery_is_management_and_never_an_original_business_receipt() {
        let f = fixture();
        let file = object(&f, ObjectKind::File, "99");
        let original = "1".repeat(32);
        let recovery = "2".repeat(32);
        let chain = "3".repeat(32);
        receipt(
            &f,
            &original,
            &file,
            "file.version.commit",
            Some(1),
            2,
            Some("1"),
            "2",
            "available",
        );
        receipt(
            &f,
            &recovery,
            &file,
            "file.version.commit",
            Some(2),
            3,
            Some("2"),
            "3",
            "unavailable",
        );
        receipt(
            &f,
            &chain,
            &file,
            "file.version.commit",
            Some(3),
            4,
            Some("3"),
            "4",
            "unavailable",
        );
        f.db.conn.execute("UPDATE agent_operation_receipts SET request_id=?1,output_context_json=?2 WHERE operation_id=?3",params![format!("fileundo:{original}"),"{\"recovery\":\"file.undo\"}",recovery]).unwrap();
        f.db.conn.execute("UPDATE agent_operation_receipts SET request_id=?1,output_context_json=?2 WHERE operation_id=?3",params![format!("filechainundo:{original}:{original}"),"{\"recovery\":\"file.chain_undo\"}",chain]).unwrap();
        let planned =
            f.db.agent_operation_undo_batch_plan(&f.request, &f.binding, &input(&f, &[&original]))
                .unwrap();
        assert!(planned.groups[0].conflicts.is_empty());
        let selected =
            f.db.agent_operation_undo_batch_plan(&f.request, &f.binding, &input(&f, &[&recovery]))
                .unwrap();
        assert!(conflicts(
            &selected.groups[0],
            OperationBatchConflictReason::UnsupportedKind
        ));
    }
    #[test]
    fn batch_planner_rejects_foreign_runs_unknown_ids_permissions_and_invalid_input() {
        let f = fixture();
        let native = f.native.operation_id.as_str();
        let mut batch = input(&f, &[native]);
        batch.operation_ids.push(native.into());
        assert_eq!(
            f.db.agent_operation_undo_batch_plan(&f.request, &f.binding, &batch)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        batch = input(&f, &[native]);
        batch.run_id = "b".repeat(32);
        assert_eq!(
            f.db.agent_operation_undo_batch_plan(&f.request, &f.binding, &batch)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            f.db.agent_operation_undo_batch_plan(
                &f.request,
                &f.binding,
                &input(&f, &[&"0".repeat(32)])
            )
            .unwrap_err()
            .code,
            ErrorCode::NotFound
        );
        let mut denied = f.request.clone();
        denied.scope_grant.project_ids.clear();
        assert_eq!(
            f.db.agent_operation_undo_batch_plan(&denied, &f.binding, &input(&f, &[native]))
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        denied = f.request.clone();
        denied.caller = Caller::BuiltinRun {
            run_id: f.run.clone(),
        };
        assert_eq!(
            f.db.agent_operation_undo_batch_plan(&denied, &f.binding, &input(&f, &[native]))
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        denied = f.request.clone();
        denied.request_id.clear();
        assert_eq!(
            f.db.agent_operation_undo_batch_plan(&denied, &f.binding, &input(&f, &[native]))
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
    }
}
