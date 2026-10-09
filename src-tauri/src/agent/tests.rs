use super::{
    access::{Caller, RequestContext, ScopeGrant},
    capabilities::capabilities,
    context::{serialized_chars, ContextEntry, ContextGetInput, ReadBudget, ScopeIdentity},
    errors::{AgentResult, ApiResponse, ErrorCode},
    models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
    repository::ContextRepository,
    runtime::RunState,
    service::AgentDomainService,
};
use std::cell::Cell;

fn binding() -> WorkspaceBinding {
    WorkspaceBinding {
        workspace_id: "w1".into(),
        generation: "open-1".into(),
    }
}
fn request() -> RequestContext {
    RequestContext {
        binding: binding(),
        caller: Caller::Connection {
            grant_id: "g1".into(),
        },
        request_id: "r1".into(),
        scope_grant: ScopeGrant {
            object_keys: None,
            workspace_id: "w1".into(),
            workspace_content: false,
            project_ids: vec![7],
            operations: vec!["context.read".into()],
        },
    }
}
struct SpyRepository {
    reads: Cell<usize>,
}
impl ContextRepository for SpyRepository {
    fn scope_identity(&self, scope: &Scope) -> AgentResult<Option<ScopeIdentity>> {
        self.reads.set(self.reads.get() + 1);
        Ok(Some(ScopeIdentity {
            scope: scope.clone(),
            name: "Project".into(),
            archived: false,
        }))
    }
}

#[test]
fn agent_denies_cross_scope_and_stale_workspace_before_storage_access() {
    let repo = SpyRepository {
        reads: Cell::new(0),
    };
    let current = binding();
    let service = AgentDomainService::new(&current, &repo);
    for scope in [Scope::Workspace, Scope::Project { project_id: 8 }] {
        let error = service
            .context_get(
                &request(),
                ContextGetInput {
                    scope,
                    query: None,
                    budget_chars: None,
                },
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ScopeDenied);
    }
    let mut stale = request();
    stale.binding.generation = "previous-open".into();
    let error = service
        .context_get(
            &stale,
            ContextGetInput {
                scope: Scope::Project { project_id: 7 },
                query: None,
                budget_chars: None,
            },
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::WorkspaceChanged);
    assert_eq!(repo.reads.get(), 0);
}

#[test]
fn agent_object_scope_cannot_be_forged_and_restore_is_a_separate_permission() {
    let claimed = ObjectRef {
        workspace_id: "w1".into(),
        scope: Scope::Project { project_id: 7 },
        kind: ObjectKind::Record,
        id: "1".into(),
    };
    let actual = ObjectRef {
        scope: Scope::Project { project_id: 8 },
        ..claimed.clone()
    };
    assert_eq!(
        request()
            .authorize_object(&binding(), &claimed, &actual, "context.read")
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    let mut patch_grant = request();
    patch_grant
        .scope_grant
        .operations
        .push("record.patch".into());
    assert!(patch_grant
        .authorize_object(&binding(), &claimed, &claimed, "record.patch")
        .is_ok());
    assert_eq!(
        patch_grant
            .authorize_object(&binding(), &claimed, &claimed, "record.restore")
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
}

#[test]
fn agent_l0_is_small_and_never_invents_a_built_overview() {
    let repo = SpyRepository {
        reads: Cell::new(0),
    };
    let current = binding();
    let entry = AgentDomainService::new(&current, &repo)
        .context_get(
            &request(),
            ContextGetInput {
                scope: Scope::Project { project_id: 7 },
                query: Some("之前讨论了什么".into()),
                budget_chars: None,
            },
        )
        .unwrap();
    let data = serde_json::to_value(entry).unwrap();
    assert_eq!(data["status"], "not_built");
    assert!(data["positioning"].is_null());
    assert_eq!(data["nodes"], serde_json::json!([]));
    assert_eq!(repo.reads.get(), 1);
    assert!(serialized_chars(&data).unwrap() <= 2000);
}

#[test]
fn agent_budget_counts_unicode_and_json_escaping_and_rejects_impossible_budget() {
    let entry = ContextEntry::not_built(
        ScopeIdentity {
            scope: Scope::Project { project_id: 7 },
            name: "中😀\"\\".repeat(4000),
            archived: false,
        },
        Some(300),
    )
    .unwrap();
    assert!(serialized_chars(&entry).unwrap() <= 300);
    assert!(entry.has_more);
    assert!(ContextEntry::not_built(entry.identity, Some(1)).is_err());
    let mut budget = ReadBudget::new(Some(6));
    budget.charge(&"😀中").unwrap(); // JSON quotes count; emoji is one Unicode scalar.
    assert_eq!(budget.remaining(), 2);
    assert_eq!(
        budget.charge(&"x").unwrap_err().code,
        ErrorCode::BudgetExceeded
    );
    assert_eq!(budget.remaining(), 2);
}

#[test]
fn agent_terminal_runs_cannot_resume_or_complete_after_cancellation() {
    for terminal in [
        RunState::Completed,
        RunState::Failed,
        RunState::Cancelled,
        RunState::Interrupted,
    ] {
        assert!(terminal.is_terminal());
        for next in [RunState::Preparing, RunState::Running, RunState::Completed] {
            assert!(terminal.transition(next).is_err());
        }
    }
    assert!(RunState::Running.transition(RunState::Cancelled).is_err());
    assert_eq!(
        RunState::Running
            .transition(RunState::Cancelling)
            .unwrap()
            .transition(RunState::Cancelled)
            .unwrap(),
        RunState::Cancelled
    );
    assert!(RunState::Cancelling
        .transition(RunState::Completed)
        .is_err());
}

#[test]
fn agent_response_uses_boolean_discriminator_and_reports_native_write_availability() {
    let response = ApiResponse::from_result("r1".into(), Ok("ready"));
    let json = serde_json::to_value(response).unwrap();
    assert_eq!(json["ok"], true);
    assert_eq!(json["apiVersion"], 1);
    assert!(json.get("error").is_none());
    let failure: ApiResponse<()> = ApiResponse::from_result(
        "r1".into(),
        Err(super::errors::AgentError::new(
            ErrorCode::ScopeDenied,
            "Denied",
        )),
    );
    let json = serde_json::to_value(failure).unwrap();
    assert_eq!(json["ok"], false);
    assert!(json.get("data").is_none());
    assert_eq!(json["error"]["code"], "SCOPE_DENIED");
    assert!(capabilities()
        .iter()
        .filter(|cap| cap.implemented)
        .all(|cap| cap.read_only
            || matches!(
                cap.permission,
                "settings.write"
                    | "session.write"
                    | "run.start"
                    | "run.cancel"
                    | "output.stage"
                    | "output.update"
                    | "output.commit"
                    | "content.create"
                    | "record.patch"
                    | "record.restore"
                    | "file.update"
                    | "file.restore"
                    | "todo.update"
                    | "operation.undo"
                    | "operation.restore_created"
            )));
    for method in [
        "record.create", "record.patch", "record.restore", "file.create", "file.patch",
        "file.update", "file.version.restore", "todo.create", "todo.update",
    ] {
        let capability = capabilities().into_iter().find(|cap| cap.method == method).unwrap();
        assert!(capability.implemented, "{method} uses the native mutation service");
        assert!(!capability.read_only, "{method} must not be advertised as a read");
    }
    for method in ["reference.list", "context.overview.refresh", "session.summary.get"] {
        assert!(!capabilities().iter().find(|cap| cap.method == method).unwrap().implemented);
    }
    for method in [
        "output.stage",
        "output.update",
        "output.dismiss",
        "output.commit",
        "operation.undo",
        "operation.restore_created",
    ] {
        let capability = capabilities()
            .into_iter()
            .find(|cap| cap.method == method)
            .unwrap();
        assert!(
            capability.implemented
                && !capability.read_only
                && capability.delivery.ends_with(":Record/Todo/File")
        );
    }
    let todo_get = capabilities()
        .into_iter()
        .find(|cap| cap.method == "todo.get")
        .unwrap();
    assert!(todo_get.implemented && todo_get.read_only);
    assert_eq!(todo_get.permission, "source.read");
    assert_eq!(todo_get.delivery, "AI-19:Todo");
}

#[test]
fn agent_wire_types_preserve_explicit_scope_and_versioned_block_operations() {
    use super::{
        context::OverviewSection,
        outputs::{BlockEdit, RecordPatch},
        runtime::{RunEvent, RunEventKind},
    };
    let patch: RecordPatch = serde_json::from_value(serde_json::json!({
        "record": { "workspaceId": "w1", "scope": { "kind": "project", "projectId": 7 }, "kind": "record", "id": "42" },
        "baseRevision": 3, "requestId": "patch-1", "operations": [
            { "op": "append_inline", "blockId": "block-1", "expectedBlockHash": "sha256:base", "text": "补充" },
            { "op": "delete", "blockId": "block-2", "expectedBlockHash": "sha256:other" }
        ]
    })).unwrap();
    assert_eq!(patch.base_revision, 3);
    assert!(matches!(
        patch.operations[0],
        BlockEdit::AppendInline { .. }
    ));
    assert!(serde_json::from_value::<Scope>(
        serde_json::json!({ "kind": "project", "projectId": 7, "grantAll": true })
    )
    .is_err());
    let event = RunEvent {
        binding: binding(),
        session_id: "s1".into(),
        run_id: "r1".into(),
        seq: 1,
        event: RunEventKind::ToolStarted {
            call_id: "t1".into(),
            method: "source.read".into(),
        },
    };
    let json = serde_json::to_value(event).unwrap();
    assert_eq!(json["event"]["type"], "tool.started");
    assert_eq!(json["event"]["data"]["callId"], "t1");
    assert_eq!(
        serde_json::to_value(OverviewSection::KnowledgeMap).unwrap(),
        "knowledgeMap"
    );
}
