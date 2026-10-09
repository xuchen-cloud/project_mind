use super::*;
use crate::{
    agent::{
        access::{Caller, ScopeGrant},
        models::{ObjectRef, Scope},
    },
    committed_changes::{CommittedChangePublisher, CommittedChanges},
    models::WorkspaceRecordUpsertInput,
    record_documents::{body_hash, RecordDocumentProjection, RecordTarget},
    source_service::{SourceIndexBudget, SourceReadTarget},
};
use std::sync::Mutex;

struct Store {
    binding: Mutex<WorkspaceBinding>,
    db: Mutex<Database>,
}
impl CommittedChangePublisher for Store {
    fn publish_committed(&self, _changes: CommittedChanges) {}
}
impl BoundSourceStore for Store {
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        action(&self.binding.lock().unwrap(), &self.db.lock().unwrap())
    }
}
impl BoundReadContextStore for Store {
    fn with_current_context<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database, &str) -> AgentResult<T>,
    ) -> AgentResult<T> {
        action(
            &self.binding.lock().unwrap(),
            &self.db.lock().unwrap(),
            "Trusted workspace name",
        )
    }
}
struct NoUtility;
impl DocumentUtility for NoUtility {
    async fn request(&self, _request_id: &str, _method: &str, _data: Value) -> AgentResult<Value> {
        panic!("Initialized Record reads do not need conversion")
    }
}
impl SourceUtility for NoUtility {
    async fn request(
        &self,
        _workspace_id: &str,
        _request_id: &str,
        _format: &str,
        _bytes: &[u8],
    ) -> AgentResult<Value> {
        panic!("These source reads do not need File extraction")
    }
}
fn fixture(project_scope: bool) -> (tempfile::TempDir, Store, RequestContext, SourceReadInput) {
    let directory = tempfile::tempdir().unwrap();
    let mut db = Database::open(
        &directory.path().join("tools.sqlite"),
        directory.path(),
        None,
    )
    .unwrap();
    let (scope, record_id) = if project_scope {
        let project = db
            .project_create(crate::models::ProjectCreateInput {
                name: "Trusted project name".into(),
                summary: None,
                status: Some("active".into()),
            })
            .unwrap();
        let record = db
            .project_record_upsert(crate::models::ProjectRecordUpsertInput {
                project_id: project.id,
                note_id: None,
                title: Some("Evidence".into()),
                html: "<p>evidence</p>".into(),
                markdown: "evidence".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        (
            Scope::Project {
                project_id: project.id,
            },
            record.id,
        )
    } else {
        let record = db
            .workspace_record_upsert(WorkspaceRecordUpsertInput {
                note_id: None,
                title: Some("Evidence".into()),
                html: "<p>evidence</p>".into(),
                markdown: "evidence".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        (Scope::Workspace, record.id)
    };
    let target = RecordTarget {
        scope: scope.clone(),
        record_id,
    };
    let text = "Shared source evidence. ".repeat(200);
    let document = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"1234567890abcdef1234567890abcdef"},"content":[{"type":"text","text":text}]}]});
    let projection = RecordDocumentProjection {
        schema_version: 1,
        body_hash: body_hash(&document, &None),
        document,
        html: format!("<p>{text}</p>"),
        markdown: text.clone(),
        text,
        code_language: None,
    };
    db.record_document_initialize(
        "gui",
        "initialize-tools",
        &target,
        &db.record_document_source(&target).unwrap().source_hash,
        &projection,
        "tools-workspace",
    )
    .unwrap();
    let binding = WorkspaceBinding {
        workspace_id: "tools-workspace".into(),
        generation: "generation-1".into(),
    };
    let request = RequestContext {
        binding: binding.clone(),
        caller: Caller::BuiltinRun {
            run_id: "read-run".into(),
        },
        request_id: "read-tools".into(),
        scope_grant: ScopeGrant {
            object_keys: None,
            workspace_id: binding.workspace_id.clone(),
            workspace_content: true,
            project_ids: match scope {
                Scope::Project { project_id } => vec![project_id],
                _ => vec![],
            },
            operations: vec!["source.read".into(), "context.read".into()],
        },
    };
    let input = SourceReadInput {
        source: SourceReadTarget {
            object: ObjectRef {
                workspace_id: binding.workspace_id.clone(),
                scope,
                kind: ObjectKind::Record,
                id: record_id.to_string(),
            },
            revision: None,
            record_version: None,
            file_version: None,
        },
        view: crate::source_service::SourceReadView::Full,
        selection: None,
        cursor: None,
        budget_chars: Some(1800),
    };
    (
        directory,
        Store {
            binding: Mutex::new(binding),
            db: Mutex::new(db),
        },
        request,
        input,
    )
}
async fn call(
    store: &Store,
    request: &RequestContext,
    method: &str,
    arguments: Value,
) -> AgentResult<Value> {
    dispatch_read(store, &NoUtility, &NoUtility, request, method, arguments).await
}

#[tokio::test]
async fn shared_read_dispatcher_knowledge_miss_falls_back_to_real_source_evidence() {
    let (_directory, store, request, input) = fixture(true);
    SourceService::new(&store)
        .index_record(&request, &input.source, SourceIndexBudget::default())
        .unwrap();
    let miss = call(
        &store,
        &request,
        "knowledge.search",
        json!({"scope":input.source.object.scope,"query":"evidence"}),
    )
    .await
    .unwrap();
    assert_eq!(miss["sourceFallbackRequired"], true);
    let found = call(
        &store,
        &request,
        "source.search",
        json!({"scope":input.source.object.scope,"query":"evidence"}),
    )
    .await
    .unwrap();
    assert_eq!(found["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        found["items"][0]["sourceRef"]["object"],
        json!(input.source.object)
    );
    let page = call(&store, &request, "source.read", json!(input))
        .await
        .unwrap();
    assert!(page["text"]
        .as_str()
        .unwrap()
        .starts_with("Shared source evidence."));
    assert_eq!(
        page["sourceRef"]["revision"],
        found["items"][0]["sourceRef"]["revision"]
    );
    assert!(page["nextCursor"].is_string());
    assert!(super::super::context::serialized_chars(&page).unwrap() <= 1800);
    let mut next = input;
    next.cursor = page["nextCursor"].as_str().map(str::to_owned);
    next.source.revision = page["sourceRef"]["revision"].as_str().map(str::to_owned);
    let continuation = call(&store, &request, "source.read", json!(next))
        .await
        .unwrap();
    assert_eq!(
        continuation["sourceRef"]["revision"],
        page["sourceRef"]["revision"]
    );
    assert_ne!(continuation["nextCursor"], page["nextCursor"]);
}

#[tokio::test]
async fn shared_read_dispatcher_preserves_host_grant_real_ownership_and_binding() {
    let (_directory, store, request, mut input) = fixture(false);
    let workspace_page = call(&store, &request, "source.read", json!(input))
        .await
        .unwrap();
    assert_eq!(
        workspace_page["sourceRef"]["object"],
        json!(input.source.object)
    );
    let mut denied = request.clone();
    denied.scope_grant.workspace_content = false;
    assert_eq!(
        call(&store, &denied, "source.read", json!(input))
            .await
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    assert_eq!(
        call(
            &store,
            &request,
            "source.search",
            json!({"scope":{"kind":"project","projectId":123},"query":"evidence"})
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::ScopeDenied
    );
    let project = store
        .db
        .lock()
        .unwrap()
        .project_create(crate::models::ProjectCreateInput {
            name: "Stored project".into(),
            summary: None,
            status: Some("active".into()),
        })
        .unwrap();
    let original_object = input.source.object.clone();
    input.source.object = ObjectRef {
        scope: Scope::Project { project_id: 123 },
        kind: ObjectKind::Project,
        id: project.id.to_string(),
        ..original_object.clone()
    };
    let mut claimed = denied.clone();
    claimed.scope_grant.project_ids.push(123);
    assert_eq!(
        call(&store, &claimed, "source.read", json!(input))
            .await
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    input.source.object = original_object;
    store.binding.lock().unwrap().generation = "generation-2".into();
    assert_eq!(
        call(&store, &request, "source.read", json!(input))
            .await
            .unwrap_err()
            .code,
        ErrorCode::WorkspaceChanged
    );
}

#[tokio::test]
async fn shared_read_dispatcher_l0_uses_trusted_workspace_name_and_rejects_argument_authority() {
    let (_directory, store, request, input) = fixture(true);
    let mut request = request;
    request.caller = Caller::Gui;
    let entry = call(
        &store,
        &request,
        "context.get",
        json!({"scope":input.source.object.scope}),
    )
    .await
    .unwrap();
    assert_eq!(entry["identity"]["name"], "Trusted project name");
    assert_eq!(entry["status"], "not_built");
    let overview = call(
        &store,
        &request,
        "context.overview.get",
        json!({"scope":input.source.object.scope}),
    )
    .await
    .unwrap();
    assert_eq!(overview["revision"], Value::Null);
    assert!(overview["items"].as_array().unwrap().is_empty());
    let missing = call(
        &store,
        &request,
        "knowledge.get",
        json!({"scope":input.source.object.scope,"nodeId":"node:missing"}),
    )
    .await
    .unwrap_err();
    assert_eq!(missing.code, ErrorCode::NotFound);
    let workspace_identity = call(
        &store,
        &request,
        "context.get",
        json!({"scope":{"kind":"workspace"}}),
    )
    .await
    .unwrap();
    assert_eq!(
        workspace_identity["identity"]["name"],
        "Trusted workspace name"
    );
    for (method, args) in [
        (
            "context.overview.get",
            json!({"scope":{"kind":"workspace"}}),
        ),
        (
            "knowledge.search",
            json!({"scope":{"kind":"workspace"},"query":"evidence"}),
        ),
    ] {
        assert_eq!(
            call(&store, &request, method, args).await.unwrap_err().code,
            ErrorCode::SourceNotReady
        );
    }
    for args in [
        json!({"scope":{"kind":"workspace"},"scopeGrant":{"workspaceContent":true}}),
        json!({"scope":{"kind":"workspace"},"budgetChars":3001}),
        json!({"scope":{"kind":"workspace"},"budgetChars":0}),
    ] {
        assert_eq!(
            call(&store, &request, "context.get", args)
                .await
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
    }
    assert_eq!(
        call(&store, &request, "record.versions.get", json!(input))
            .await
            .unwrap_err()
            .code,
        ErrorCode::ToolCallUnsupported
    );
}

#[test]
fn shared_read_dispatcher_descriptors_expose_only_callable_bounded_dtos() {
    let tools = read_tool_descriptions();
    let source = tools
        .iter()
        .find(|tool| tool.method == "source.read")
        .unwrap();
    assert_eq!(source.name, "mind_source_read");
    assert_eq!(source.parameters["additionalProperties"], false);
    assert_eq!(
        source.parameters["properties"]["budgetChars"]["anyOf"][0]["maximum"],
        12000
    );
    assert!(source.parameters["properties"].get("scopeGrant").is_none());
    let search = tools
        .iter()
        .find(|tool| tool.method == "source.search")
        .unwrap();
    assert_eq!(search.parameters["properties"]["query"]["maxLength"], 256);
    assert_eq!(search.parameters["properties"]["selected"]["maxItems"], 50);
}
