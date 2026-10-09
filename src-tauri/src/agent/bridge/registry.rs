//! The small public read surface of the local bridge. Schemas come from the
//! same Rust inputs that the bridge deserializes.
use crate::{
    agent::{
        context::ContextGetInput,
        errors::{AgentError, AgentResult, ErrorCode},
        file_tools::{FileSourceReadInput, FileVersionsGetInput, FileVersionsListInput},
        model_history::ModelHistoryReadInput,
        record_blocks::RecordBlocksInput,
        todo_tools::TodoGetInput,
    },
    db::agent_session_model_search::ModelHistorySearchInput,
    knowledge_service::{KnowledgeGetInput, KnowledgeSearchInput},
    overview_service::OverviewReadInput,
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
    ]
}

pub fn schema(method: &str) -> Option<Value> {
    registered_methods().into_iter().find(|entry| entry.method == method).map(|entry| entry.parameters)
}

pub fn is_registered(method: &str) -> bool {
    matches!(method, "project.list" | "context.get" | "context.overview.get" | "knowledge.search" | "knowledge.get" | "source.search" | "source.read" | "session.search" | "session.messages.read" | "record.blocks.get" | "todo.get" | "file.versions.list" | "file.versions.get" | "file.source.read")
}

/// Validate exactly the DTO that dispatch will consume, plus the shared read
/// bounds used by the built-in tool adapter.
pub fn validate(method: &str, parameters: &Value) -> AgentResult<()> {
    fn decode<T: serde::de::DeserializeOwned>(parameters: &Value) -> AgentResult<()> {
        serde_json::from_value::<T>(parameters.clone())
            .map(|_| ())
            .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Arguments do not match the read input DTO"))
    }
    if matches!(method, "context.get" | "context.overview.get" | "knowledge.search" | "knowledge.get" | "source.search" | "source.read") {
        crate::agent::tools::validate_bounds(method, parameters)?;
    }
    match method {
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
        _ => Err(AgentError::new(ErrorCode::ToolCallUnsupported, "Read method is not registered")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::models::Scope;
    #[test]
    fn registry_contains_only_exposed_reads() {
        assert_eq!(registered_methods().iter().map(|x| x.method).collect::<Vec<_>>(), vec![
            "project.list", "context.get", "context.overview.get", "knowledge.search",
            "knowledge.get", "source.search", "source.read", "session.search",
            "session.messages.read", "record.blocks.get", "todo.get",
            "file.versions.list", "file.versions.get", "file.source.read",
        ]);
        assert!(registered_methods().iter().all(|entry| entry.read_only));
        assert!(!is_registered("record.create"));
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
        assert_eq!(validate("record.create", &serde_json::json!({})).unwrap_err().code, ErrorCode::ToolCallUnsupported);
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
        assert!(!is_registered("record.restore"));
        assert!(!is_registered("file.content.begin"));
    }
}
