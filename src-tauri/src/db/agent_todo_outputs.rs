//! Agent Todo candidates use the native Todo validators and mutation helpers.
//! One atomic receipt owns the complete group and its immutable revision pair.
use super::{
    agent_operations::{io_error, OperationChange},
    todo_revisions, Database,
};
use crate::{
    agent::{
        access::{Caller, RequestContext},
        connection_todos::{ConnectionTodoCreateInput, ConnectionTodoUpdateInput},
        context::serialized_chars,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
        outputs::{OutputIntent, TodoMutation, TodoNewChild},
    },
    models::{
        InternalReferenceResolveInput, TodoAddProgressInput, TodoCreateInput,
        TodoDeleteProgressInput, TodoScope, TodoUpdateContentInput, TodoUpdatePriorityInput,
        TodoUpdateProgressInput, TodoUpdateStatusInput, TodoUpdateTagsInput,
    },
};
use chrono::NaiveDate;
use rand::RngCore;
use rusqlite::{params, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TodoCommittedResult {
    pub operation_id: String,
    pub object: ObjectRef,
    pub before_revision: Option<u64>,
    pub after_revision: u64,
    pub before_snapshot_ref: Option<String>,
    pub after_snapshot_ref: String,
    pub body_hash: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TodoReadResult {
    pub object: ObjectRef,
    pub revision: u64,
    pub body_hash: String,
    pub snapshot: todo_revisions::TodoSnapshot,
}
fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn denied() -> AgentError {
    AgentError::new(
        ErrorCode::ScopeDenied,
        "Todo candidate is outside the authorized scope",
    )
}
fn native_error(error: anyhow::Error) -> AgentError {
    serde_json::from_str(&error.to_string()).unwrap_or_else(|_| {
        AgentError::new(ErrorCode::IoFailed, "Cannot apply native Todo mutation")
    })
}
fn id(object: &ObjectRef) -> AgentResult<i64> {
    object.key()?;
    if object.kind != ObjectKind::Todo {
        return Err(invalid("Expected a Todo target"));
    }
    object
        .id
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0 && id.to_string() == object.id)
        .ok_or_else(|| invalid("Expected a canonical Todo identity"))
}
fn native_scope(scope: &Scope) -> (TodoScope, Option<i64>) {
    match scope {
        Scope::Workspace => (TodoScope::Workspace, None),
        Scope::Project { project_id } => (TodoScope::Project, Some(*project_id)),
    }
}
fn content(value: &str) -> AgentResult<()> {
    if value.trim().is_empty() || value.chars().count() > 12000 || value.contains('\0') {
        return Err(invalid("Todo content must contain 1 to 12000 characters"));
    }
    Ok(())
}
fn date(value: &str) -> AgentResult<()> {
    if value.len() != 10
        || NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .ok()
            .is_none_or(|date| date.format("%Y-%m-%d").to_string() != value)
    {
        return Err(invalid(
            "Todo dates must be explicit valid YYYY-MM-DD values",
        ));
    }
    Ok(())
}
fn deadline(value: &Option<String>) -> AgentResult<()> {
    if let Some(value) = value {
        date(value)?;
    }
    Ok(())
}
fn status(value: &str) -> AgentResult<()> {
    if !matches!(value, "unfinished" | "finished") {
        return Err(invalid("Unsupported Todo status"));
    }
    Ok(())
}
fn priority(value: &str) -> AgentResult<()> {
    if !matches!(
        value,
        "urgent_important"
            | "urgent_not_important"
            | "not_urgent_important"
            | "not_urgent_not_important"
    ) {
        return Err(invalid("Unsupported Todo priority"));
    }
    Ok(())
}
fn tags(values: &[i64]) -> AgentResult<()> {
    if values.len() > 100 || values.iter().any(|id| *id <= 0) {
        return Err(invalid("Todo tags exceed the native field budget"));
    }
    Ok(())
}
fn child(value: &TodoNewChild) -> AgentResult<()> {
    content(&value.content)?;
    date(&value.progress_date)?;
    deadline(&value.due_date)
}
impl Database {
    pub(crate) fn agent_todo_get(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        target: &ObjectRef,
    ) -> AgentResult<TodoReadResult> {
        let todo_id = id(target)?;
        let object = self.source_read_object(request, binding, target)?;
        let head = todo_revisions::head(&self.conn, todo_id)?;
        let result = TodoReadResult {
            object,
            revision: head.revision,
            body_hash: head.body_hash,
            snapshot: todo_revisions::snapshot(&self.conn, todo_id)?,
        };
        if serialized_chars(&result)? > 12000 {
            return Err(AgentError::new(
                ErrorCode::BudgetExceeded,
                "Todo including its children exceeds the read budget",
            ));
        }
        Ok(result)
    }
    fn todo_candidate_content(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        captured: &RequestContext,
        scope: &Scope,
        value: &str,
        existing: Option<&str>,
    ) -> AgentResult<()> {
        content(value)?;
        let (native, project) = native_scope(scope);
        self.validate_todo_internal_references(native, project, value, existing)
            .map_err(|_| denied())?;
        let retained = existing
            .map(super::parse_internal_reference_tokens)
            .unwrap_or_default();
        for (kind, id) in super::parse_internal_reference_tokens(value) {
            let resolved = self
                .internal_reference_resolve(InternalReferenceResolveInput {
                    kind: kind.clone(),
                    id,
                })
                .map_err(native_error)?
                .ok_or_else(denied)?;
            let ref_scope = match resolved.project_id {
                Some(project_id) => Scope::Project { project_id },
                None => Scope::Workspace,
            };
            request.authorize(binding, &ref_scope, "source.read")?;
            captured.authorize(binding, &ref_scope, "source.read")?;
            if !retained.contains(&(kind.clone(), id)) {
                let object = ObjectRef {
                    workspace_id: binding.workspace_id.clone(),
                    scope: ref_scope,
                    kind: match kind.as_str() {
                        "note" | "workspace_record" => ObjectKind::Record,
                        "todo" => ObjectKind::Todo,
                        "document" => ObjectKind::File,
                        _ => return Err(denied()),
                    },
                    id: id.to_string(),
                };
                self.source_read_object(request, binding, &object)?;
            }
        }
        Ok(())
    }
    pub(super) fn agent_todo_validate_candidate(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        scope: &Scope,
        captured: &RequestContext,
        intent: &OutputIntent,
    ) -> AgentResult<()> {
        match intent {
            OutputIntent::TodoCreate {
                content: value,
                priority: p,
                due_date,
                tag_ids,
                children,
                dedupe_key,
                ..
            } => {
                if dedupe_key.is_empty() || dedupe_key.len() > 128 || children.len() > 100 {
                    return Err(invalid("Todo creation exceeds its action or child budget"));
                }
                priority(p)?;
                deadline(due_date)?;
                tags(tag_ids)?;
                self.validated_todo_tag_ids(native_scope(scope).1, tag_ids)
                    .map_err(|_| denied())?;
                self.todo_candidate_content(request, binding, captured, scope, value, None)?;
                for value in children {
                    child(value)?;
                    self.todo_candidate_content(
                        request,
                        binding,
                        captured,
                        scope,
                        &value.content,
                        None,
                    )?;
                }
            }
            OutputIntent::TodoUpdate {
                target,
                expected_revision,
                changes,
            } => {
                if changes.is_empty() || changes.len() > 50 {
                    return Err(invalid("Todo changes must contain 1 to 50 mutations"));
                }
                let todo_id = id(target)?;
                let resolved = self.source_read_object(request, binding, target)?;
                request.authorize_object(binding, target, &resolved, "todo.update")?;
                captured.authorize(binding, &resolved.scope, "todo.update")?;
                captured.authorize(binding, &resolved.scope, "source.read")?;
                todo_revisions::require_expected_revision(&self.conn, todo_id, *expected_revision)?;
                let current = todo_revisions::snapshot(&self.conn, todo_id)?;
                let mut live: std::collections::HashSet<i64> =
                    current.children.iter().map(|child| child.id).collect();
                for change in changes {
                    match change {
                        TodoMutation::Content { content: value } => self.todo_candidate_content(
                            request,
                            binding,
                            captured,
                            scope,
                            value,
                            Some(&current.content),
                        )?,
                        TodoMutation::Deadline { due_date } => deadline(due_date)?,
                        TodoMutation::Status { status: value } => status(value)?,
                        TodoMutation::Priority { priority: value } => priority(value)?,
                        TodoMutation::Tags { tag_ids } => {
                            tags(tag_ids)?;
                            self.validated_todo_tag_ids(current.project_id, tag_ids)
                                .map_err(|_| denied())?;
                        }
                        TodoMutation::ChildCreate {
                            content: value,
                            progress_date,
                            due_date,
                        } => {
                            content(value)?;
                            date(progress_date)?;
                            deadline(due_date)?;
                            self.todo_candidate_content(
                                request, binding, captured, scope, value, None,
                            )?;
                        }
                        TodoMutation::ChildUpdate {
                            child_id,
                            content: value,
                            progress_date,
                            due_date,
                            status: value_status,
                        } => {
                            let previous = current
                                .children
                                .iter()
                                .find(|child| child.id == *child_id)
                                .filter(|_| live.contains(child_id))
                                .ok_or_else(denied)?;
                            content(value)?;
                            date(progress_date)?;
                            deadline(due_date)?;
                            status(value_status)?;
                            self.todo_candidate_content(
                                request,
                                binding,
                                captured,
                                scope,
                                value,
                                Some(&previous.content),
                            )?;
                        }
                        TodoMutation::ChildDelete { child_id } => {
                            if !live.remove(child_id) {
                                return Err(denied());
                            }
                        }
                    }
                }
            }
            _ => {
                return Err(AgentError::new(
                    ErrorCode::ToolCallUnsupported,
                    "Expected a Todo output intent",
                ))
            }
        }
        Ok(())
    }
    pub(crate) fn agent_todo_output_commit(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        output_id: &str,
        revision: u64,
    ) -> AgentResult<TodoCommittedResult> {
        if let Some(previous) =
            self.agent_output_record_receipt(request, binding, output_id, revision)?
        {
            return serde_json::from_value(previous)
                .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid native Todo receipt"));
        }
        // Repeat prepare under the caller's current binding. The native callback
        // rechecks the committing state in the same transaction as its receipt.
        let prepared = self.agent_output_commit_prepare(request, binding, output_id, revision)?;
        let operation = match &prepared.output.staged.intent {
            OutputIntent::TodoCreate { .. } => "todo.create",
            OutputIntent::TodoUpdate { .. } => "todo.update",
            _ => {
                return Err(AgentError::new(
                    ErrorCode::ToolCallUnsupported,
                    "Expected a Todo candidate",
                ))
            }
        };
        let intent = prepared.output.staged.intent;
        self.agent_atomic_operation(&request.caller.key(),&prepared.commit_request_id,operation,&intent,|tx| {
            self.agent_output_commit_validate(request,binding,output_id,revision)?;
            self.apply_todo_intent(tx, binding, &intent)
        })
    }
    fn apply_todo_intent(
        &self,
        tx: &Transaction<'_>,
        binding: &WorkspaceBinding,
        intent: &OutputIntent,
    ) -> AgentResult<(TodoCommittedResult, Option<OperationChange>)> {
        let mut bytes=[0u8;16];rand::thread_rng().fill_bytes(&mut bytes);let operation_id:String=bytes.iter().map(|byte|format!("{byte:02x}")).collect();
        let (todo_id,before,head)=match intent {
            OutputIntent::TodoCreate{scope,content,priority,due_date,tag_ids,children,..}=>{
                let (native,project_id)=native_scope(scope);
                let created=self.todo_create_native(TodoCreateInput{scope:native,project_id,content:content.clone(),priority:priority.clone(),due_date:due_date.clone(),tag_ids:tag_ids.clone()}).map_err(native_error)?;
                for child in children {self.todo_add_progress_native(TodoAddProgressInput{todo_id:created.id,content:child.content.clone(),progress_date:child.progress_date.clone(),due_date:child.due_date.clone(),expected_revision:1}).map_err(native_error)?;}
                let head=if children.is_empty(){todo_revisions::head(tx,created.id)?}else{todo_revisions::commit(tx,created.id,1,Some(&operation_id))?};
                tx.execute("UPDATE todo_revision_snapshots SET operation_id=?1 WHERE id=?2 AND operation_id IS NULL",params![operation_id,head.snapshot_ref]).map_err(io_error)?;
                (created.id,None,head)
            },
            OutputIntent::TodoUpdate{target,expected_revision,changes}=>{
                let todo_id=id(target)?;let before=todo_revisions::require_expected_revision(tx,todo_id,*expected_revision)?;
                for change in changes {self.apply_todo_mutation(todo_id,*expected_revision,change)?;}
                let head=todo_revisions::commit(tx,todo_id,*expected_revision,Some(&operation_id))?;
                (todo_id,Some(before),head)
            },
            _=>return Err(AgentError::new(ErrorCode::ToolCallUnsupported,"Expected a Todo candidate")),
        };
        let scope=match intent {OutputIntent::TodoCreate{scope,..}=>scope.clone(),OutputIntent::TodoUpdate{target,..}=>target.scope.clone(),_=>unreachable!()};
        let object=ObjectRef{workspace_id:binding.workspace_id.clone(),scope:scope.clone(),kind:ObjectKind::Todo,id:todo_id.to_string()};
        let result=TodoCommittedResult{operation_id,object:object.clone(),before_revision:before.as_ref().map(|head|head.revision),after_revision:head.revision,before_snapshot_ref:before.map(|head|head.snapshot_ref),after_snapshot_ref:head.snapshot_ref,body_hash:head.body_hash};
        Ok((result,Some(OperationChange{object_key:object.key()?,scope,revision:head.revision.to_string()})))
    }
    pub(crate) fn agent_connection_todo_create(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &ConnectionTodoCreateInput,
    ) -> AgentResult<TodoCommittedResult> {
        self.operation_binding(binding)?;
        if !matches!(request.caller, Caller::Connection { .. }) {
            return Err(denied());
        }
        request.authorize(binding, &input.scope, "content.create")?;
        if let Some(previous) = self.agent_operation_replay(
            &request.caller.key(), &request.request_id, "todo.create", input,
        )? {
            return Ok(previous);
        }
        let intent = OutputIntent::TodoCreate {
            scope: input.scope.clone(), content: input.content.clone(),
            priority: input.priority.clone(), due_date: input.due_date.clone(),
            tag_ids: input.tag_ids.clone(), children: input.children.clone(),
            dedupe_key: request.request_id.clone(),
        };
        let validate = |db: &Database| -> AgentResult<()> {
            request.authorize(binding, &input.scope, "content.create")?;
            if let Scope::Project { project_id } = &input.scope {
                db.source_read_object(request, binding, &ObjectRef {
                    workspace_id: binding.workspace_id.clone(),
                    scope: input.scope.clone(), kind: ObjectKind::Project,
                    id: project_id.to_string(),
                })?;
            }
            db.agent_todo_validate_candidate(request, binding, &input.scope, request, &intent)
        };
        validate(self)?;
        self.agent_atomic_operation(&request.caller.key(), &request.request_id,
            "todo.create", input, |tx| {
                validate(self)?;
                self.apply_todo_intent(tx, binding, &intent)
            })
    }
    pub(crate) fn agent_connection_todo_update(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &ConnectionTodoUpdateInput,
    ) -> AgentResult<TodoCommittedResult> {
        self.operation_binding(binding)?;
        if !matches!(request.caller, Caller::Connection { .. }) {
            return Err(denied());
        }
        id(&input.target)?;
        request.authorize(binding, &input.target.scope, "todo.update")?;
        self.source_read_object(request, binding, &input.target)?;
        if let Some(previous) = self.agent_operation_replay(
            &request.caller.key(), &request.request_id, "todo.update", input,
        )? {
            return Ok(previous);
        }
        let intent = OutputIntent::TodoUpdate {
            target: input.target.clone(), expected_revision: input.expected_revision,
            changes: input.changes.clone(),
        };
        let validate = |db: &Database| -> AgentResult<()> {
            request.authorize(binding, &input.target.scope, "todo.update")?;
            db.agent_todo_validate_candidate(request, binding, &input.target.scope, request, &intent)
        };
        validate(self)?;
        self.agent_atomic_operation(&request.caller.key(), &request.request_id,
            "todo.update", input, |tx| {
                validate(self)?;
                self.apply_todo_intent(tx, binding, &intent)
            })
    }
    fn apply_todo_mutation(
        &self,
        todo_id: i64,
        expected: u64,
        change: &TodoMutation,
    ) -> AgentResult<()> {
        match change {
            TodoMutation::Content { content } => {
                let current = self.todo_record_unchecked(todo_id).map_err(native_error)?;
                self.todo_update_content_native(TodoUpdateContentInput {
                    todo_id,
                    content: content.clone(),
                    due_date: current.due_date,
                    tag_ids: current.tags.iter().map(|tag| tag.id).collect(),
                    expected_revision: expected,
                })
                .map_err(native_error)?;
            }
            TodoMutation::Deadline { due_date } => {
                let current = self.todo_record_unchecked(todo_id).map_err(native_error)?;
                self.todo_update_content_native(TodoUpdateContentInput {
                    todo_id,
                    content: current.content,
                    due_date: due_date.clone(),
                    tag_ids: current.tags.iter().map(|tag| tag.id).collect(),
                    expected_revision: expected,
                })
                .map_err(native_error)?;
            }
            TodoMutation::Status { status } => {
                self.todo_update_status_native(TodoUpdateStatusInput {
                    todo_id,
                    status: status.clone(),
                    expected_revision: expected,
                })
                .map_err(native_error)?;
            }
            TodoMutation::Priority { priority } => {
                self.todo_update_priority_native(TodoUpdatePriorityInput {
                    todo_id,
                    priority: priority.clone(),
                    expected_revision: expected,
                })
                .map_err(native_error)?;
            }
            TodoMutation::Tags { tag_ids } => {
                self.todo_update_tags_native(TodoUpdateTagsInput {
                    todo_id,
                    tag_ids: tag_ids.clone(),
                    expected_revision: expected,
                })
                .map_err(native_error)?;
            }
            TodoMutation::ChildCreate {
                content,
                progress_date,
                due_date,
            } => {
                self.todo_add_progress_native(TodoAddProgressInput {
                    todo_id,
                    content: content.clone(),
                    progress_date: progress_date.clone(),
                    due_date: due_date.clone(),
                    expected_revision: expected,
                })
                .map_err(native_error)?;
            }
            TodoMutation::ChildUpdate {
                child_id,
                content,
                progress_date,
                due_date,
                status,
            } => {
                let actual = self
                    .todo_progress_record_unchecked(*child_id)
                    .map_err(native_error)?;
                if actual.todo_id != todo_id {
                    return Err(denied());
                }
                self.todo_update_progress_native(TodoUpdateProgressInput {
                    progress_id: *child_id,
                    content: content.clone(),
                    progress_date: progress_date.clone(),
                    due_date: due_date.clone(),
                    status: Some(status.clone()),
                    expected_revision: expected,
                })
                .map_err(native_error)?;
            }
            TodoMutation::ChildDelete { child_id } => {
                let actual = self
                    .todo_progress_record_unchecked(*child_id)
                    .map_err(native_error)?;
                if actual.todo_id != todo_id {
                    return Err(denied());
                }
                self.todo_delete_progress_native(TodoDeleteProgressInput {
                    progress_id: *child_id,
                    expected_revision: expected,
                })
                .map_err(native_error)?;
            }
        }
        Ok(())
    }
}

fn validate_committed_todo(
    tx: &Transaction<'_>,
    result: &TodoCommittedResult,
    operation: &str,
) -> AgentResult<()> {
    let todo_id = id(&result.object)?;
    let head = todo_revisions::head(tx, todo_id)?;
    if result.after_revision != head.revision
        || result.after_snapshot_ref != head.snapshot_ref
        || result.body_hash != head.body_hash
        || result.operation_id.len() != 32
        || !result.operation_id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(AgentError::new(ErrorCode::OutputCommitFailed,"Todo result differs from its native revision"));
    }
    if let Some(before) = &result.before_snapshot_ref {
        let existing: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM todo_revision_snapshots WHERE id=?1 AND todo_id=?2 AND revision=?3)",
            params![before,todo_id,result.before_revision.map(|v|v as i64)],
            |row|row.get(0),
        ).map_err(io_error)?;
        if !existing || result.before_revision.and_then(|v|v.checked_add(1)) != Some(result.after_revision) {
            return Err(denied());
        }
    } else if result.before_revision.is_some() || operation != "todo.create" {
        return Err(denied());
    }
    Ok(())
}

/// Runs immediately after the original atomic receipt INSERT, before outbox.
pub(crate) fn agent_todo_output_receipt_committed(
    tx: &Transaction<'_>,
    caller: &str,
    request_id: &str,
    operation: &str,
    result_json: &str,
) -> AgentResult<()> {
    if caller.starts_with("connection:") && matches!(operation, "todo.create" | "todo.update") {
        let result: TodoCommittedResult = serde_json::from_str(result_json)
            .map_err(|_| AgentError::new(ErrorCode::IoFailed,"Invalid native Todo result"))?;
        validate_committed_todo(tx, &result, operation)?;
        let context = json!({"afterBodyHash":result.body_hash});
        let changed = tx.execute(
            "UPDATE agent_operation_receipts SET operation_id=?1,target_ref_json=?2,before_revision=?3,after_revision=?4,before_snapshot_ref=?5,after_snapshot_ref=?6,output_context_json=?7,undo_state='available' WHERE caller_id=?8 AND request_id=?9 AND operation=?10 AND state='committed' AND result_json=?11",
            params![result.operation_id,serde_json::to_string(&result.object).map_err(|_|invalid("Invalid Todo target"))?,result.before_revision.map(|v|v as i64),result.after_revision as i64,result.before_snapshot_ref,result.after_snapshot_ref,context.to_string(),caller,request_id,operation,result_json],
        ).map_err(io_error)?;
        if changed != 1 {
            return Err(AgentError::new(ErrorCode::IoFailed,"Connection Todo receipt is missing"));
        }
        return Ok(());
    }
    if !matches!(operation, "todo.create" | "todo.update") || !request_id.starts_with("output:") {
        return Ok(());
    }
    let (output, grant) =
        super::agent_outputs::agent_output_todo_binding(tx, caller, request_id, operation)?;
    let result: TodoCommittedResult = serde_json::from_str(result_json)
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid native Todo result"))?;
    let scope = match &output.staged.intent {
        OutputIntent::TodoCreate { scope, .. } => scope,
        OutputIntent::TodoUpdate {
            target,
            expected_revision,
            ..
        } => {
            if target != &result.object || Some(*expected_revision) != result.before_revision {
                return Err(denied());
            }
            &target.scope
        }
        _ => return Err(denied()),
    };
    if result.object.workspace_id != grant.workspace_id || &result.object.scope != scope {
        return Err(denied());
    }
    validate_committed_todo(tx, &result, operation)?;
    let context = json!({"outputId":output.staged.id,"outputRevision":output.staged.revision,"mode":output.mode,"sources":output.staged.sources,"sourceChanged":output.source_changed,"afterBodyHash":result.body_hash});
    let context =
        serde_json::to_string(&context).map_err(|_| invalid("Invalid Todo output context"))?;
    if context.len() > 256 * 1024 {
        return Err(invalid("Todo output receipt context exceeds budget"));
    }
    let changed=tx.execute("UPDATE agent_operation_receipts SET operation_id=?1,run_id=?2,target_ref_json=?3,before_revision=?4,after_revision=?5,before_snapshot_ref=?6,after_snapshot_ref=?7,output_context_json=?8,undo_state='available' WHERE caller_id=?9 AND request_id=?10 AND operation=?11 AND state='committed' AND result_json=?12",params![result.operation_id,output.staged.run_id,serde_json::to_string(&result.object).map_err(|_|invalid("Invalid Todo target"))?,result.before_revision.map(|v|v as i64),result.after_revision as i64,result.before_snapshot_ref,result.after_snapshot_ref,context,caller,request_id,operation,result_json]).map_err(io_error)?;
    if changed != 1 {
        return Err(AgentError::new(
            ErrorCode::OutputCommitFailed,
            "Native Todo receipt is missing",
        ));
    }
    let changed=tx.execute("UPDATE agent_outputs SET state='committed',object_ref_json=?1 WHERE id=?2 AND revision=?3 AND state='committing'",params![serde_json::to_string(&result.object).map_err(|_|invalid("Invalid Todo target"))?,output.staged.id,output.staged.revision as i64]).map_err(io_error)?;
    if changed != 1 {
        return Err(AgentError::new(
            ErrorCode::RevisionConflict,
            "Todo output changed before native settlement",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "agent_connection_todo_tests.rs"]
mod connection_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{
        access::{Caller, ScopeGrant},
        models::ExecutionMode,
        output_runtime::{OutputState, OutputUpdateInput, RuntimeOutput, StageRecordInput},
    };
    const SESSION: &str = "11111111111111111111111111111111";
    const RUN: &str = "22222222222222222222222222222222";
    struct Fixture {
        root: tempfile::TempDir,
        db: Database,
        request: RequestContext,
    }
    fn fixture(mode: ExecutionMode) -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("todos.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("todo-test").unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "todo-test".into(),
            generation: "one".into(),
        };
        let grant = ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: true,
            project_ids: vec![],
            operations: [
                "output.stage",
                "output.read",
                "output.update",
                "output.commit",
                "source.read",
                "content.create",
                "todo.update",
                "operation.read",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        };
        let request = RequestContext {
            binding,
            scope_grant: grant.clone(),
            caller: Caller::BuiltinRun { run_id: RUN.into() },
            request_id: "stage-create".into(),
        };
        db.conn.execute("INSERT INTO agent_sessions(id,scope_key,title,runtime_id,state,session_path,created_at,updated_at) VALUES (?1,'workspace','Todo fixture','pi','active',?2,'now','now')",params![SESSION,format!(".project-mind/agent/sessions/{SESSION}/session.jsonl")]).unwrap();
        db.conn.execute("INSERT INTO agent_runs(id,session_id,client_request_id,state,context_manifest_json,grant_json,started_at) VALUES (?1,?2,'message','running',?3,?4,'now')",params![RUN,SESSION,json!({"scope":Scope::Workspace,"mode":mode}).to_string(),grant_json(&grant)]).unwrap();
        Fixture { root, db, request }
    }
    fn create(children: bool) -> StageRecordInput {
        StageRecordInput {
            sources: vec![],
            intent: OutputIntent::TodoCreate {
                scope: Scope::Workspace,
                content: "Plan the delivery".into(),
                priority: "urgent_important".into(),
                due_date: Some("2026-12-01".into()),
                tag_ids: vec![],
                dedupe_key: "delivery-action".into(),
                children: if children {
                    vec![TodoNewChild {
                        content: "Check the evidence".into(),
                        progress_date: "2026-10-08".into(),
                        due_date: None,
                    }]
                } else {
                    vec![]
                },
            },
        }
    }
    fn count(db: &Database, table: &str) -> i64 {
        db.conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }
    fn grant_json(grant: &ScopeGrant) -> String {
        json!({"workspaceId":grant.workspace_id,"workspaceContent":grant.workspace_content,"projectIds":grant.project_ids,"operations":grant.operations}).to_string()
    }
    fn stage(f: &Fixture, candidate: &StageRecordInput) -> RuntimeOutput {
        f.db.agent_output_stage_record(&f.request, &f.request.binding, candidate)
            .unwrap()
    }
    fn commit(f: &Fixture, output: &RuntimeOutput) -> TodoCommittedResult {
        f.db.agent_todo_output_commit(
            &f.request,
            &f.request.binding,
            &output.staged.id,
            output.staged.revision,
        )
        .unwrap()
    }
    #[test]
    fn todo_output_native_group_has_complete_final_snapshot_and_one_revision_commit() {
        let mut f = fixture(ExecutionMode::Collaborate);
        let staged = stage(&f, &create(true));
        assert_eq!(count(&f.db, "todos"), 0);
        let created = commit(&f, &staged);
        assert_eq!(created.before_revision, None);
        assert_eq!(created.after_revision, 2);
        let todo_id = id(&created.object).unwrap();
        let before =
            todo_revisions::retained_snapshot(&f.db.conn, &created.after_snapshot_ref).unwrap();
        assert_eq!(before.children.len(), 1);
        assert_eq!(before.children[0].progress_date, "2026-10-08");
        assert_eq!(before.children[0].due_date, None);
        f.request.request_id = "stage-update".into();
        let candidate = StageRecordInput {
            sources: vec![],
            intent: OutputIntent::TodoUpdate {
                target: created.object.clone(),
                expected_revision: created.after_revision,
                changes: vec![
                    TodoMutation::Content {
                        content: "Updated plan".into(),
                    },
                    TodoMutation::Deadline { due_date: None },
                    TodoMutation::Priority {
                        priority: "not_urgent_important".into(),
                    },
                    TodoMutation::Status {
                        status: "finished".into(),
                    },
                    TodoMutation::Tags { tag_ids: vec![] },
                    TodoMutation::ChildUpdate {
                        child_id: before.children[0].id,
                        content: "Evidence checked".into(),
                        progress_date: "2026-10-09".into(),
                        due_date: Some("2026-11-02".into()),
                        status: "finished".into(),
                    },
                    TodoMutation::ChildCreate {
                        content: "Ship".into(),
                        progress_date: "2026-10-10".into(),
                        due_date: None,
                    },
                ],
            },
        };
        let updated = commit(&f, &stage(&f, &candidate));
        assert_eq!(updated.before_revision, Some(2));
        assert_eq!(updated.after_revision, 3);
        assert_eq!(
            updated.before_snapshot_ref,
            Some(created.after_snapshot_ref.clone())
        );
        let after = todo_revisions::snapshot(&f.db.conn, todo_id).unwrap();
        assert_eq!(after.content, "Updated plan");
        assert_eq!(after.status, "finished");
        assert_eq!(after.priority, "not_urgent_important");
        assert_eq!(after.due_date, None);
        assert_eq!(after.children.len(), 2);
        assert_eq!(after.children[0].id, before.children[0].id);
        assert_eq!(after.children[0].status, "finished");
        assert_eq!(
            todo_revisions::retained_snapshot(&f.db.conn, &created.after_snapshot_ref).unwrap(),
            before
        );
        let entry =
            f.db.agent_operation_get(&f.request, &f.request.binding, &updated.operation_id)
                .unwrap();
        assert_eq!(entry.kind, "todo.update");
        assert_eq!(entry.before_revision, Some(2));
        assert_eq!(entry.after_revision, Some(3));
        assert_eq!(entry.undo_state, "available");
        let update_outbox: i64 =
            f.db.conn
                .query_row(
                    "SELECT COUNT(*) FROM agent_change_log WHERE operation='todo.update'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
        assert_eq!(update_outbox, 1);
        f.request.request_id = "delete-child".into();
        let delete = StageRecordInput {
            sources: vec![],
            intent: OutputIntent::TodoUpdate {
                target: created.object,
                expected_revision: 3,
                changes: vec![TodoMutation::ChildDelete {
                    child_id: before.children[0].id,
                }],
            },
        };
        assert_eq!(commit(&f, &stage(&f, &delete)).after_revision, 4);
        let after_delete = todo_revisions::snapshot(&f.db.conn, todo_id).unwrap();
        assert_eq!(after_delete.children.len(), 1);
        assert_eq!(after_delete.children[0].content, "Ship");
    }
    #[test]
    fn todo_output_action_dedupe_and_request_receipts_survive_reopen() {
        let mut f = fixture(ExecutionMode::Collaborate);
        let candidate = create(false);
        let original = stage(&f, &candidate);
        let native = commit(&f, &original);
        f.request.request_id = "second-tool-request".into();
        let repeated = stage(&f, &candidate);
        assert_eq!(repeated.staged.id, original.staged.id);
        assert_eq!(commit(&f, &repeated).operation_id, native.operation_id);
        assert_eq!(count(&f.db, "todos"), 1);
        assert_eq!(count(&f.db, "agent_outputs"), 1);
        let mut changed = candidate.clone();
        if let OutputIntent::TodoCreate { content, .. } = &mut changed.intent {
            *content = "Different body".into();
        }
        f.request.request_id = "third-tool-request".into();
        assert_eq!(
            f.db.agent_output_stage_record(&f.request, &f.request.binding, &changed)
                .unwrap_err()
                .code,
            ErrorCode::IdempotencyConflict
        );
        if let OutputIntent::TodoCreate { dedupe_key, .. } = &mut changed.intent {
            *dedupe_key = "new-action-key".into();
        }
        f.request.request_id = "second-tool-request".into();
        assert_eq!(
            f.db.agent_output_stage_record(&f.request, &f.request.binding, &changed)
                .unwrap_err()
                .code,
            ErrorCode::IdempotencyConflict
        );
        f.db = Database::open(&f.root.path().join("todos.sqlite"), f.root.path(), None).unwrap();
        f.request.request_id = "after-reopen".into();
        assert_eq!(stage(&f, &candidate).staged.id, original.staged.id);
        assert_eq!(commit(&f, &original).operation_id, native.operation_id);
        assert_eq!(count(&f.db, "todos"), 1);
        assert_eq!(count(&f.db, "todo_revision_snapshots"), 1);
    }
    #[test]
    fn todo_output_modes_grants_and_candidate_identity_remain_frozen() {
        let readonly = fixture(ExecutionMode::ReadOnly);
        assert_eq!(
            readonly
                .db
                .agent_output_stage_record(
                    &readonly.request,
                    &readonly.request.binding,
                    &create(false)
                )
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(count(&readonly.db, "agent_outputs"), 0);
        let mut review = fixture(ExecutionMode::Review);
        let staged = stage(&review, &create(false));
        assert_eq!(
            review
                .db
                .agent_todo_output_commit(
                    &review.request,
                    &review.request.binding,
                    &staged.staged.id,
                    1
                )
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(count(&review.db, "todos"), 0);
        review.request.caller = Caller::Gui;
        let mut edited = create(false);
        if let OutputIntent::TodoCreate { dedupe_key, .. } = &mut edited.intent {
            *dedupe_key = "replacement-key".into();
        }
        let input = OutputUpdateInput {
            output_id: staged.staged.id.clone(),
            expected_revision: 1,
            candidate: edited,
        };
        assert_eq!(
            review
                .db
                .agent_output_update_validate(&review.request, &review.request.binding, &input)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        let created = commit(&review, &staged);
        assert_eq!(created.after_revision, 1);
        assert_eq!(count(&review.db, "todos"), 1);
        let frozen = fixture(ExecutionMode::Collaborate);
        let mut grant = frozen.request.scope_grant.clone();
        grant
            .operations
            .retain(|operation| operation != "content.create");
        frozen
            .db
            .conn
            .execute(
                "UPDATE agent_runs SET grant_json=?1 WHERE id=?2",
                params![grant_json(&grant), RUN],
            )
            .unwrap();
        assert_eq!(
            frozen
                .db
                .agent_output_stage_record(&frozen.request, &frozen.request.binding, &create(false))
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(count(&frozen.db, "todos"), 0);
    }
    #[test]
    fn todo_output_manual_revision_policy_and_foreign_child_are_rejected() {
        let mut f = fixture(ExecutionMode::Collaborate);
        let created = commit(&f, &stage(&f, &create(true)));
        let candidate = StageRecordInput {
            sources: vec![],
            intent: OutputIntent::TodoUpdate {
                target: created.object.clone(),
                expected_revision: created.after_revision,
                changes: vec![TodoMutation::Content {
                    content: "Agent candidate".into(),
                }],
            },
        };
        f.request.request_id = "stage-cas".into();
        let staged = stage(&f, &candidate);
        f.db.todo_update_status(TodoUpdateStatusInput {
            todo_id: id(&created.object).unwrap(),
            expected_revision: created.after_revision,
            status: "finished".into(),
        })
        .unwrap();
        assert_eq!(
            f.db.agent_todo_output_commit(&f.request, &f.request.binding, &staged.staged.id, 1)
                .unwrap_err()
                .code,
            ErrorCode::RevisionConflict
        );
        assert_eq!(
            todo_revisions::snapshot(&f.db.conn, id(&created.object).unwrap())
                .unwrap()
                .content,
            "Plan the delivery"
        );
        let mut current = candidate;
        if let OutputIntent::TodoUpdate {
            expected_revision, ..
        } = &mut current.intent
        {
            *expected_revision = 3;
        }
        f.db.conn
            .execute(
                "INSERT INTO source_access_policies(object_key,excluded,revision) VALUES (?1,1,1)",
                [created.object.key().unwrap()],
            )
            .unwrap();
        f.request.request_id = "excluded-target".into();
        assert_eq!(
            f.db.agent_output_stage_record(&f.request, &f.request.binding, &current)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        f.db.conn
            .execute(
                "DELETE FROM source_access_policies WHERE object_key=?1",
                [created.object.key().unwrap()],
            )
            .unwrap();
        let other =
            f.db.todo_create(TodoCreateInput {
                scope: TodoScope::Workspace,
                project_id: None,
                content: "Other parent".into(),
                priority: "urgent_important".into(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
        let foreign =
            f.db.todo_add_progress(TodoAddProgressInput {
                todo_id: other.id,
                expected_revision: other.revision,
                content: "Other child".into(),
                progress_date: "2026-10-08".into(),
                due_date: None,
            })
            .unwrap();
        if let OutputIntent::TodoUpdate { changes, .. } = &mut current.intent {
            *changes = vec![TodoMutation::ChildDelete {
                child_id: foreign.id,
            }];
        }
        f.request.request_id = "foreign-child".into();
        assert_eq!(
            f.db.agent_output_stage_record(&f.request, &f.request.binding, &current)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            f.db.todo_progress_record_unchecked(foreign.id)
                .unwrap()
                .content,
            "Other child"
        );
    }
    #[test]
    fn todo_output_native_outbox_failure_rolls_back_business_receipt_and_stage() {
        let f = fixture(ExecutionMode::Collaborate);
        let staged = stage(&f, &create(true));
        let receipts = count(&f.db, "agent_operation_receipts");
        f.db.conn.execute_batch("CREATE TRIGGER fail_todo_output_outbox BEFORE INSERT ON agent_change_log WHEN NEW.operation='todo.create' BEGIN SELECT RAISE(ABORT,'fixture outbox failure'); END;").unwrap();
        assert_eq!(
            f.db.agent_todo_output_commit(&f.request, &f.request.binding, &staged.staged.id, 1)
                .unwrap_err()
                .code,
            ErrorCode::IoFailed
        );
        assert_eq!(count(&f.db, "todos"), 0);
        assert_eq!(count(&f.db, "todo_progresses"), 0);
        assert_eq!(count(&f.db, "todo_revision_heads"), 0);
        assert_eq!(count(&f.db, "todo_revision_snapshots"), 0);
        assert_eq!(count(&f.db, "agent_operation_receipts"), receipts);
        assert_eq!(
            f.db.agent_output_get(&f.request, &f.request.binding, &staged.staged.id)
                .unwrap()
                .state,
            OutputState::Committing
        );
        f.db.conn
            .execute_batch("DROP TRIGGER fail_todo_output_outbox")
            .unwrap();
        assert_eq!(commit(&f, &staged).after_revision, 2);
        assert_eq!(count(&f.db, "todos"), 1);
    }
    #[test]
    fn todo_output_nullable_dates_are_required_and_read_budget_never_truncates() {
        let mut wire = serde_json::to_value(create(false).intent).unwrap();
        wire.as_object_mut().unwrap().remove("dueDate");
        assert!(serde_json::from_value::<OutputIntent>(wire).is_err());
        assert!(serde_json::from_value::<TodoMutation>(json!({"change":"deadline"})).is_err());
        assert!(serde_json::from_value::<TodoNewChild>(
            json!({"content":"Child","progressDate":"2026-10-08"})
        )
        .is_err());
        let f = fixture(ExecutionMode::Collaborate);
        let mut invalid_candidate = create(false);
        if let OutputIntent::TodoCreate { due_date, .. } = &mut invalid_candidate.intent {
            *due_date = Some("2026-02-30".into());
        }
        assert_eq!(
            f.db.agent_output_stage_record(&f.request, &f.request.binding, &invalid_candidate)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        assert_eq!(count(&f.db, "agent_outputs"), 0);
        let large =
            f.db.todo_create(TodoCreateInput {
                scope: TodoScope::Workspace,
                project_id: None,
                content: "a".repeat(12000),
                priority: "urgent_important".into(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
        let target = ObjectRef {
            workspace_id: f.request.binding.workspace_id.clone(),
            scope: Scope::Workspace,
            kind: ObjectKind::Todo,
            id: large.id.to_string(),
        };
        assert_eq!(
            f.db.agent_todo_get(&f.request, &f.request.binding, &target)
                .unwrap_err()
                .code,
            ErrorCode::BudgetExceeded
        );
        assert_eq!(
            f.db.todo_record_unchecked(large.id).unwrap().content.len(),
            12000
        );
    }
}
