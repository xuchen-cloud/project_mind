//! The small public read surface of the local bridge. Schemas come from the
//! same Rust inputs that the bridge deserializes.
use crate::{
    agent::{
        connection_operations::ConnectionOperationListInput,
        context::ContextGetInput,
        errors::{AgentError, AgentResult, ErrorCode},
        file_tools::{FileSourceReadInput, FileVersionsGetInput, FileVersionsListInput},
        model_history::ModelHistoryReadInput,
        operations::{OperationGetInput, OperationUndoInput},
        outputs::RecordPatch,
        record_blocks::RecordBlocksInput,
        todo_tools::TodoGetInput,
    },
    agent::bridge::record_writes::MutationInput,
    db::agent_record_withdrawals::RecordRestoreInput as CreatedRecordRestoreInput,
    db::agent_session_model_search::ModelHistorySearchInput,
    knowledge_service::{KnowledgeGetInput, KnowledgeSearchInput},
    overview_service::OverviewReadInput,
    record_version_reads::{RecordVersionsCompareInput, RecordVersionsGetInput, RecordVersionsListInput},
    record_documents::{RecordCreate, RecordRestoreInput},
    source_service::{SourceReadInput, SourceSearchInput},
};
use schemars::{schema_for, JsonSchema};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProjectListInput {}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredMethod {
    pub method: &'static str,
    pub description: &'static str,
    pub read_only: bool,
    pub parameters: Value,
}

pub fn registered_methods() -> Vec<RegisteredMethod> {
    vec![
        RegisteredMethod {
            method: "project.list",
            description: "List projects visible to this connection in the bound Workspace.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(ProjectListInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "context.get",
            description: "Read bounded context for an authorized project or Workspace scope. Optional query narrows the result; budgetChars limits characters.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(ContextGetInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "context.overview.get",
            description: "Read an authorized Project Overview by section or item ID. Reuse nextCursor for continuation; version selects a revision and budgetChars limits each page.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(OverviewReadInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "knowledge.search",
            description: "Search authorized knowledge cards in a scope. Use kinds, limit, cursor and budgetChars to bound a page; source fallback may require source.search.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(KnowledgeSearchInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "knowledge.get",
            description: "Read an authorized knowledge node by nodeId and optional revision. Select view and sectionIds; continue with nextCursor within budgetChars.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(KnowledgeGetInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "source.search",
            description: "Search authorized original sources in a scope, optionally selecting objects or source kinds. Results are checked against current ownership, exclusion and revision; limit and budgetChars bound output.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(SourceSearchInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "source.read",
            description: "Read an authorized source at its current or requested revision. Choose full or range view and optional selection; continue with nextCursor within budgetChars.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(SourceReadInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "session.search",
            description: "Search prior discussion in an authorized scope with session.read. Search text is required; sessionId narrows one session, afterMessageId continues a scan, and limit/budgetChars bound results.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(ModelHistorySearchInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "session.messages.read",
            description: "Read an exact prior message with session.read. Use IDs from session.search and repeat nextCursor to continue the same original message within budgetChars.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(ModelHistoryReadInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "record.blocks.get",
            description: "Read blocks of an authorized Record with source.read. Optionally pin revision or blockId; nextCursor and budgetChars bound the page.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(RecordBlocksInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "todo.get",
            description: "Read one authorized Todo by its object reference with source.read, subject to current scope and visibility.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(TodoGetInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "file.versions.list",
            description: "List retained version metadata for an authorized File with source.read. Use nextCursor to page older versions and limit to bound the list.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(FileVersionsListInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "file.versions.get",
            description: "Read metadata for one retained File version ID with source.read; its version number and hash identify exact historical bytes.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(FileVersionsGetInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "file.source.read",
            description: "Read original UTF-8 bytes of an explicit registered File version with source.read. Version number and optional hash bind the read; cursor and budgetChars page the exact content.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(FileSourceReadInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "record.versions.list",
            description: "List bounded metadata for retained versions of an authorized Record with source.read. Continue with nextCursor and keep each page within budgetChars.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(RecordVersionsListInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "record.versions.get",
            description: "Read one retained Record version's metadata and the precise source.read target for its body; this read does not restore a version.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(RecordVersionsGetInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "record.versions.compare",
            description: "Compare two retained Record revisions by bounded block ID differences. Continue with nextCursor within budgetChars; this read does not restore either version.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(RecordVersionsCompareInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "record.create",
            description: "Create one Record in the explicitly granted scope with content.create. Supply a stable requestId for safe retry; the native service validates document and metadata.",
            read_only: false,
            parameters: serde_json::to_value(schema_for!(MutationInput<RecordCreate>)).expect("static schema"),
        },
        RegisteredMethod {
            method: "record.patch",
            description: "Apply a bounded block patch to an authorized Record with record.patch. Supply baseRevision and stable requestId; the native service checks the current revision.",
            read_only: false,
            parameters: serde_json::to_value(schema_for!(RecordPatch)).expect("static schema"),
        },
        RegisteredMethod {
            method: "record.restore",
            description: "Restore the body of an authorized Record from an exact retained version with record.restore. Supply baseRevision and stable requestId; this creates a new version.",
            read_only: false,
            parameters: serde_json::to_value(schema_for!(MutationInput<RecordRestoreInput>)).expect("static schema"),
        },
        RegisteredMethod {
            method: "operation.get",
            description: "Read one operation receipt owned by this connection with operation.read. This does not grant access to another caller's results.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(OperationGetInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "operation.list",
            description: "List this connection's operation receipts within an authorized scope with operation.read. Cursor, limit and budgetChars bound each page.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(ConnectionOperationListInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "operation.undo",
            description: "Undo one operation owned by this connection with operation.undo. Supply expectedHeadRevision and stable requestId; current heads are checked before commit.",
            read_only: false,
            parameters: serde_json::to_value(schema_for!(MutationInput<OperationUndoInput>)).expect("static schema"),
        },
        RegisteredMethod {
            method: "operation.restore_created",
            description: "Recover this connection's withdrawn newly created Record with the derived operation.restore_created permission. Supply expectedWithdrawalRevision and stable requestId.",
            read_only: false,
            parameters: serde_json::to_value(schema_for!(MutationInput<CreatedRecordRestoreInput>)).expect("static schema"),
        },
    ]
}

pub fn schema(method: &str) -> Option<Value> {
    registered_methods().into_iter().find(|entry| entry.method == method).map(|entry| entry.parameters)
}

pub fn is_registered(method: &str) -> bool {
    is_read_only(method).is_some()
}

pub fn is_read_only(method: &str) -> Option<bool> {
    match method {
        "project.list" | "context.get" | "context.overview.get" | "knowledge.search"
        | "knowledge.get" | "source.search" | "source.read" | "session.search"
        | "session.messages.read" | "record.blocks.get" | "todo.get"
        | "file.versions.list" | "file.versions.get" | "file.source.read"
        | "record.versions.list" | "record.versions.get" | "record.versions.compare"
        | "operation.get" | "operation.list" => Some(true),
        "record.create" | "record.patch" | "record.restore" | "operation.undo"
        | "operation.restore_created" => Some(false),
        _ => None,
    }
}

/// Validate exactly the DTO that dispatch will consume, plus the shared read
/// bounds used by the built-in tool adapter.
pub fn validate(method: &str, parameters: &Value) -> AgentResult<()> {
    fn decode<T: serde::de::DeserializeOwned>(parameters: &Value) -> AgentResult<()> {
        serde_json::from_value::<T>(parameters.clone())
            .map(|_| ())
            .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Arguments do not match the method input DTO"))
    }
    if matches!(method, "context.get" | "context.overview.get" | "knowledge.search" | "knowledge.get" | "source.search" | "source.read") {
        crate::agent::tools::validate_bounds(method, parameters)?;
    }
    let decoded = match method {
        "project.list" => decode::<ProjectListInput>(parameters),
        "context.get" => decode::<ContextGetInput>(parameters),
        "context.overview.get" => decode::<OverviewReadInput>(parameters),
        "knowledge.search" => decode::<KnowledgeSearchInput>(parameters),
        "knowledge.get" => decode::<KnowledgeGetInput>(parameters),
        "source.search" => decode::<SourceSearchInput>(parameters),
        "source.read" => decode::<SourceReadInput>(parameters),
        "session.search" => {
            let input: ModelHistorySearchInput = serde_json::from_value(parameters.clone())
                .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Arguments do not match the read input DTO"))?;
            input.validate()
        }
        "session.messages.read" => decode::<ModelHistoryReadInput>(parameters),
        "record.blocks.get" => decode::<RecordBlocksInput>(parameters),
        "todo.get" => decode::<TodoGetInput>(parameters),
        "file.versions.list" => decode::<FileVersionsListInput>(parameters),
        "file.versions.get" => decode::<FileVersionsGetInput>(parameters),
        "file.source.read" => decode::<FileSourceReadInput>(parameters),
        "record.versions.list" => decode::<RecordVersionsListInput>(parameters),
        "record.versions.get" => decode::<RecordVersionsGetInput>(parameters),
        "record.versions.compare" => decode::<RecordVersionsCompareInput>(parameters),
        "record.create" => decode::<MutationInput<RecordCreate>>(parameters),
        "record.patch" => decode::<RecordPatch>(parameters),
        "record.restore" => decode::<MutationInput<RecordRestoreInput>>(parameters),
        "operation.get" => decode::<OperationGetInput>(parameters),
        "operation.list" => decode::<ConnectionOperationListInput>(parameters),
        "operation.undo" => decode::<MutationInput<OperationUndoInput>>(parameters),
        "operation.restore_created" => decode::<MutationInput<CreatedRecordRestoreInput>>(parameters),
        _ => Err(AgentError::new(ErrorCode::ToolCallUnsupported, "Method is not registered")),
    };
    decoded?;
    if is_read_only(method) == Some(false)
        && !parameters
            .get("requestId")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty() && id.len() <= 128)
    {
        return Err(AgentError::new(ErrorCode::InvalidArgument, "Invalid mutation requestId"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::models::Scope;
    #[test]
    fn registry_contains_only_exposed_methods() {
        assert_eq!(registered_methods().iter().map(|x| x.method).collect::<Vec<_>>(), vec![
            "project.list", "context.get", "context.overview.get", "knowledge.search",
            "knowledge.get", "source.search", "source.read", "session.search",
            "session.messages.read", "record.blocks.get", "todo.get",
            "file.versions.list", "file.versions.get", "file.source.read",
            "record.versions.list", "record.versions.get", "record.versions.compare",
            "record.create", "record.patch", "record.restore", "operation.get",
            "operation.list", "operation.undo", "operation.restore_created",
        ]);
        assert_eq!(registered_methods().len(), 24);
        assert!(registered_methods().iter().all(|entry| is_read_only(entry.method) == Some(entry.read_only)));
        assert_eq!(is_read_only("record.patch"), Some(false));
        assert_eq!(is_read_only("operation.list"), Some(true));
        assert_eq!(is_read_only("file.content.begin"), None);
        assert!(!is_registered("run.start"));
    }
    #[test]
    fn dto_and_schema_use_same_public_fields() {
        let value = serde_json::to_value(ContextGetInput {
            scope: Scope::Project { project_id: 1 }, query: None, budget_chars: Some(2000),
        }).unwrap();
        let properties = schema("context.get").unwrap();
        let fields = properties["properties"].as_object().unwrap();
        assert!(value.as_object().unwrap().keys().all(|name| fields.contains_key(name)));
        let project_schema = schema("project.list").unwrap();
        assert_eq!(project_schema["type"], "object");
        assert_eq!(project_schema["additionalProperties"], false);
        assert!(serde_json::from_value::<ProjectListInput>(serde_json::json!({"scope":"forged"})).is_err());
    }

    #[test]
    fn expanded_schemas_follow_the_deserialized_inputs() {
        let scope = serde_json::json!({"kind":"project","projectId":1});
        let object = serde_json::json!({"workspaceId":"workspace-a","scope":scope,"kind":"project","id":"1"});
        let cases = [
            ("context.overview.get", serde_json::json!({"scope":scope,"sections":["profile"],"budgetChars":4000})),
            ("knowledge.search", serde_json::json!({"scope":scope,"query":"research","limit":8})),
            ("knowledge.get", serde_json::json!({"scope":scope,"nodeId":"node:topic","view":"summary"})),
            ("source.search", serde_json::json!({"scope":scope,"query":"research","selected":[object]})),
            ("source.read", serde_json::json!({"source":{"object":object},"view":"full"})),
        ];
        for (method, value) in cases {
            validate(method, &value).unwrap();
            let schema = schema(method).unwrap();
            let fields = schema["properties"].as_object().unwrap();
            assert!(value.as_object().unwrap().keys().all(|name| fields.contains_key(name)), "{method}");
            assert_eq!(schema["additionalProperties"], false, "{method}");
        }
    }

    #[test]
    fn registry_rejects_unknown_fields_and_shared_bounds() {
        assert_eq!(validate("project.list", &serde_json::json!({"limit":1})).unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(validate("knowledge.search", &serde_json::json!({"scope":{"kind":"workspace"},"query":"x","budgetChars":3001})).unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(validate("source.search", &serde_json::json!({"scope":{"kind":"workspace"},"query":"x","selected":[{"kind":"project"}]})).unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(validate("record.create", &serde_json::json!({})).unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(validate("file.update", &serde_json::json!({})).unwrap_err().code, ErrorCode::ToolCallUnsupported);
    }

    #[test]
    fn second_read_batch_schemas_use_real_dtos() {
        let scope = serde_json::json!({"kind":"project","projectId":1});
        let object = |kind| serde_json::json!({"workspaceId":"workspace-a","scope":scope,"kind":kind,"id":"1"});
        let id = "0123456789abcdef0123456789abcdef";
        let cases = [
            ("session.search", serde_json::json!({"scope":scope,"query":"earlier decision"})),
            ("session.messages.read", serde_json::json!({"sessionId":id,"messageId":id})),
            ("record.blocks.get", serde_json::json!({"record":object("record"),"budgetChars":4000})),
            ("todo.get", serde_json::json!({"target":object("todo")})),
            ("file.versions.list", serde_json::json!({"object":object("file"),"limit":10})),
            ("file.versions.get", serde_json::json!({"object":object("file"),"versionId":"version-1"})),
            ("file.source.read", serde_json::json!({"object":object("file"),"versionNumber":1,"budgetChars":4000})),
        ];
        for (method, value) in cases {
            validate(method, &value).unwrap();
            let schema = schema(method).unwrap();
            assert_eq!(schema["additionalProperties"], false, "{method}");
            let fields = schema["properties"].as_object().unwrap();
            assert!(value.as_object().unwrap().keys().all(|name| fields.contains_key(name)), "{method}");
        }
        assert_eq!(validate("session.search", &serde_json::json!({"scope":scope,"query":"  "})).unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(validate("session.search", &serde_json::json!({"scope":scope,"query":"x","limit":21})).unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(validate("file.versions.list", &serde_json::json!({"object":object("file"),"path":"/tmp/file"})).unwrap_err().code, ErrorCode::InvalidArgument);
        assert!(!is_registered("record.delete"));
        assert!(!is_registered("file.content.begin"));
    }

    #[test]
    fn record_version_schemas_follow_the_real_read_inputs() {
        let record = serde_json::json!({
            "workspaceId":"workspace-a",
            "scope":{"kind":"project","projectId":1},
            "kind":"record",
            "id":"1"
        });
        let before = "a".repeat(32);
        let after = "b".repeat(32);
        let cases = [
            ("record.versions.list", serde_json::json!({"record":record,"limit":8,"budgetChars":4000})),
            ("record.versions.get", serde_json::json!({"record":record,"versionId":before,"budgetChars":4000})),
            ("record.versions.compare", serde_json::json!({"record":record,"beforeVersionId":before,"afterVersionId":after,"budgetChars":4000})),
        ];
        for (method, value) in cases {
            validate(method, &value).unwrap();
            let schema = schema(method).unwrap();
            assert_eq!(schema["additionalProperties"], false, "{method}");
            let fields = schema["properties"].as_object().unwrap();
            assert!(value.as_object().unwrap().keys().all(|name| fields.contains_key(name)), "{method}");
        }
        assert_eq!(validate("record.versions.get", &serde_json::json!({"record":record,"versionId":before,"restore":true})).unwrap_err().code, ErrorCode::InvalidArgument);
        assert!(!is_registered("file.update"));
    }

    #[test]
    fn write_schemas_are_native_and_require_stable_request_identity() {
        for method in [
            "record.create", "record.patch", "record.restore", "operation.get",
            "operation.list", "operation.undo", "operation.restore_created",
        ] {
            let schema = schema(method).unwrap();
            assert_eq!(schema["additionalProperties"], false, "{method}");
            assert!(schema["properties"].is_object(), "{method}");
        }
        let patch = |request_id: Value| serde_json::json!({
            "record":{"workspaceId":"workspace-a","scope":{"kind":"project","projectId":1},"kind":"record","id":"1"},
            "baseRevision":1,
            "requestId":request_id,
            "operations":[]
        });
        assert!(validate("record.patch", &patch(serde_json::json!("stable-1"))).is_ok());
        for bad in [serde_json::json!(""), serde_json::json!("x".repeat(129)), serde_json::json!(7)] {
            assert_eq!(validate("record.patch", &patch(bad)).unwrap_err().code, ErrorCode::InvalidArgument);
        }
        let mut missing = patch(serde_json::json!("stable-1"));
        missing.as_object_mut().unwrap().remove("requestId");
        assert_eq!(validate("record.patch", &missing).unwrap_err().code, ErrorCode::InvalidArgument);
        assert!(!is_registered("file.content.begin"));
    }
}
