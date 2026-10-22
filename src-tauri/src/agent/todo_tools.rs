//! Typed current Todo reads used to prepare revision-checked staged outputs.
use super::{models::ObjectRef, tools::object_ref_schema};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TodoGetInput {
    pub target: ObjectRef,
}

/// List current actions in exactly one authorized scope. Parent and child
/// actions are filtered independently using their own status and deadline.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TodoListInput {
    pub scope: super::models::Scope,
    /// Omit to include both unfinished and finished actions.
    #[serde(default)]
    #[schemars(schema_with = "optional_status_schema")]
    pub status: Option<String>,
    /// Inclusive earliest deadline, YYYY-MM-DD. Omit for no lower bound. Date bounds exclude undated actions.
    #[serde(default)]
    #[schemars(schema_with = "optional_date_schema")]
    pub due_from: Option<String>,
    /// Inclusive latest deadline, YYYY-MM-DD. Omit for no upper bound.
    #[serde(default)]
    #[schemars(schema_with = "optional_date_schema")]
    pub due_to: Option<String>,
    /// Only actions with no deadline; incompatible with dueFrom/dueTo.
    #[serde(default)]
    pub undated: bool,
    /// Include independently filtered Subtasks. Their deadlines are not inherited.
    #[serde(default = "include_children")]
    pub include_children: bool,
    /// Continue the same filters and authorization. Restart if sources changed.
    #[schemars(length(max = 2048))]
    pub cursor: Option<String>,
    /// Maximum actions per page, 1–50; defaults to 20.
    #[schemars(range(min = 1, max = 50))]
    pub limit: Option<usize>,
    /// Maximum serialized page characters, 1–12000; defaults to 4000. A smaller budget may return fewer items or BUDGET_EXCEEDED.
    #[schemars(range(min = 1, max = 12000))]
    pub budget_chars: Option<usize>,
}

fn include_children() -> bool {
    true
}
fn optional_status_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    let mut schema = super::outputs::todo_status_schema(generator);
    schema.insert("type".into(), json!(["string", "null"]));
    let values: Vec<Value> = super::outputs::TODO_STATUSES
        .iter()
        .map(|value| json!(value))
        .chain(std::iter::once(Value::Null))
        .collect();
    schema.insert("enum".into(), json!(values));
    schema
}
fn optional_date_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    serde_json::from_value(
        json!({"type":["string","null"],"format":"date","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"}),
    )
    .expect("date schema")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TodoListItem {
    /// Native parent Todo target, including for a Subtask.
    pub object: ObjectRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_id: Option<i64>,
    pub revision: u64,
    /// Bounded display text. Use todo.get for the complete native snapshot.
    pub content: String,
    pub content_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_content: Option<String>,
    pub status: String,
    /// Subtasks use their parent Todo's priority.
    pub priority: String,
    pub due_date: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TodoListPage {
    pub scope: super::models::Scope,
    pub items: Vec<TodoListItem>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

pub(super) fn todo_ref_schema() -> Value {
    let mut value = object_ref_schema();
    value["properties"]["kind"] = json!({"type":"string","maxLength":4,"const":"todo"});
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_schema_and_runtime_accept_scope_only_with_documented_defaults() {
        let schema = serde_json::to_value(schemars::schema_for!(TodoListInput)).unwrap();
        assert_eq!(schema["required"], json!(["scope"]));
        let input: TodoListInput = serde_json::from_value(json!({"scope":{"kind":"workspace"}})).unwrap();
        assert!(input.status.is_none() && input.due_from.is_none() && input.due_to.is_none());
        assert!(input.include_children);
        assert!(!input.undated);
        assert_eq!(schema["properties"]["includeChildren"]["default"], true);
        assert_eq!(schema["properties"]["undated"]["default"], false);
    }

    #[test]
    fn todo_get_input_requires_a_real_target_and_rejects_extra_fields() {
        let target =
            json!({"workspaceId":"workspace","scope":{"kind":"workspace"},"kind":"todo","id":"1"});
        let input: TodoGetInput = serde_json::from_value(json!({"target":target})).unwrap();
        assert_eq!(input.target.id, "1");
        assert!(serde_json::from_value::<TodoGetInput>(json!({})).is_err());
        assert!(serde_json::from_value::<TodoGetInput>(
            json!({"target":target,"runId":"external"})
        )
        .is_err());
        assert!(
            serde_json::from_value::<TodoGetInput>(json!({"target":target,"budgetChars":1}))
                .is_err()
        );
    }
}
