//! The small public read surface of the local bridge. Schemas come from the
//! same Rust inputs that the bridge deserializes.
use crate::agent::context::ContextGetInput;
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
            description: "Read bounded context for an authorized project or Workspace scope.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(ContextGetInput)).expect("static schema"),
        },
    ]
}

pub fn schema(method: &str) -> Option<Value> {
    registered_methods().into_iter().find(|entry| entry.method == method).map(|entry| entry.parameters)
}

pub fn is_registered(method: &str) -> bool {
    matches!(method, "project.list" | "context.get")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::models::Scope;
    #[test]
    fn registry_contains_only_exposed_reads() {
        assert_eq!(registered_methods().iter().map(|x| x.method).collect::<Vec<_>>(), vec!["project.list", "context.get"]);
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
}
