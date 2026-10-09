//! The small public read surface of the local bridge. Schemas come from the
//! same Rust inputs that the bridge deserializes.
use crate::{
    agent::{
        context::ContextGetInput,
        errors::{AgentError, AgentResult, ErrorCode},
    },
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
    ]
}

pub fn schema(method: &str) -> Option<Value> {
    registered_methods().into_iter().find(|entry| entry.method == method).map(|entry| entry.parameters)
}

pub fn is_registered(method: &str) -> bool {
    matches!(method, "project.list" | "context.get" | "context.overview.get" | "knowledge.search" | "knowledge.get" | "source.search" | "source.read")
}

/// Validate exactly the DTO that dispatch will consume, plus the shared read
/// bounds used by the built-in tool adapter.
pub fn validate(method: &str, parameters: &Value) -> AgentResult<()> {
    fn decode<T: serde::de::DeserializeOwned>(parameters: &Value) -> AgentResult<()> {
        serde_json::from_value::<T>(parameters.clone())
            .map(|_| ())
            .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Arguments do not match the read input DTO"))
    }
    if method != "project.list" {
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
            "knowledge.get", "source.search", "source.read",
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
}
