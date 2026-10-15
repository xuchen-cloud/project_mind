//! Direct connection Todo inputs. Authority comes from the bound request,
//! never from these wire values.
use super::{models::{ObjectRef, Scope}, outputs::{TodoMutation, TodoNewChild}};
use serde::{Deserialize, Serialize};

fn required_date<'de, D: serde::Deserializer<'de>>(value: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(value)
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectionTodoCreateInput {
    pub scope: Scope,
    pub content: String,
    pub priority: String,
    #[serde(deserialize_with = "required_date")]
    #[schemars(required, schema_with = "crate::agent::outputs::nullable_due_date_schema")]
    pub due_date: Option<String>,
    pub tag_ids: Vec<i64>,
    pub children: Vec<TodoNewChild>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectionTodoUpdateInput {
    pub target: ObjectRef,
    pub expected_revision: u64,
    pub changes: Vec<TodoMutation>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn due_dates(schema: &Value) -> Vec<Value> {
        fn visit(value: &Value, found: &mut Vec<Value>) {
            if let Some(properties) = value.get("properties") {
                if let Some(due_date) = properties.get("dueDate") {
                    assert!(value["required"].as_array().is_some_and(|required| required.contains(&json!("dueDate"))));
                    found.push(due_date.clone());
                }
            }
            match value {
                Value::Object(map) => for child in map.values() { visit(child, found); },
                Value::Array(values) => for child in values { visit(child, found); },
                _ => {}
            }
        }
        let mut found = Vec::new();
        visit(schema, &mut found);
        found
    }
    fn assert_required_nullable(schema: &Value, count: usize) {
        let fields = due_dates(schema);
        assert_eq!(fields.len(), count);
        for field in fields {
            let types = field["type"].as_array().expect("nullable dueDate type union");
            assert!(types.contains(&json!("string")));
            assert!(types.contains(&json!("null")));
        }
    }
    #[test]
    fn due_dates_are_required_and_nullable_in_connection_and_mutation_schemas() {
        assert_required_nullable(&serde_json::to_value(schemars::schema_for!(ConnectionTodoCreateInput)).unwrap(), 2);
        assert_required_nullable(&serde_json::to_value(schemars::schema_for!(TodoNewChild)).unwrap(), 1);
        assert_required_nullable(&serde_json::to_value(schemars::schema_for!(TodoMutation)).unwrap(), 3);
        assert!(serde_json::from_value::<ConnectionTodoCreateInput>(json!({
            "scope":{"kind":"workspace"},"content":"x","priority":"urgent_important", "tagIds":[],"children":[]
        })).is_err());
        assert!(serde_json::from_value::<ConnectionTodoCreateInput>(json!({
            "scope":{"kind":"workspace"},"content":"x","priority":"urgent_important", "dueDate":null,"tagIds":[],"children":[]
        })).is_ok());
        assert!(serde_json::from_value::<TodoNewChild>(json!({"content":"x","progressDate":"2026-10-09"})).is_err());
        for change in [
            json!({"change":"deadline"}),
            json!({"change":"child_create","content":"x","progressDate":"2026-10-09"}),
            json!({"change":"child_update","childId":1,"content":"x","progressDate":"2026-10-09","status":"unfinished"}),
        ] {
            assert!(serde_json::from_value::<TodoMutation>(change).is_err());
        }
    }
}
