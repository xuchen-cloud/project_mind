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
    #[schemars(schema_with = "crate::agent::outputs::todo_priority_schema")]
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

    fn fields(schema: &Value, name: &str) -> Vec<Value> {
        fn visit(value: &Value, name: &str, found: &mut Vec<Value>) {
            if let Some(field) = value.get("properties").and_then(|props| props.get(name)) {
                found.push(field.clone());
            }
            match value {
                Value::Object(map) => for child in map.values() { visit(child, name, found); },
                Value::Array(values) => for child in values { visit(child, name, found); },
                _ => {}
            }
        }
        let mut found = Vec::new();
        visit(schema, name, &mut found);
        found
    }

    #[test]
    fn todo_schemas_expose_native_priority_and_status_enums_with_descriptions() {
        let create = serde_json::to_value(schemars::schema_for!(ConnectionTodoCreateInput)).unwrap();
        let mutations = serde_json::to_value(schemars::schema_for!(TodoMutation)).unwrap();
        for schema in [&create, &mutations] {
            let priorities = fields(schema, "priority");
            assert_eq!(priorities.len(), 1);
            for field in priorities {
                assert_eq!(field["type"], "string");
                assert_eq!(field["enum"], json!([
                    "urgent_important", "urgent_not_important",
                    "not_urgent_important", "not_urgent_not_important"
                ]));
                assert!(!field["description"].as_str().unwrap_or_default().is_empty());
            }
        }
        let statuses = fields(&mutations, "status");
        assert_eq!(statuses.len(), 2);
        for field in statuses {
            assert_eq!(field["type"], "string");
            assert_eq!(field["enum"], json!(["unfinished", "finished"]));
            assert!(!field["description"].as_str().unwrap_or_default().is_empty());
        }
    }

    #[test]
    fn todo_date_schemas_distinguish_legacy_progress_date_from_nullable_deadline() {
        for (schema, progress_count, due_count) in [
            (schemars::schema_for!(ConnectionTodoCreateInput), 1, 2),
            (schemars::schema_for!(TodoNewChild), 1, 1),
            (schemars::schema_for!(TodoMutation), 2, 3),
        ] {
            let schema = serde_json::to_value(schema).unwrap();
            let progress_dates = fields(&schema, "progressDate");
            assert_eq!(progress_dates.len(), progress_count);
            for field in progress_dates {
                assert_eq!(field["type"], "string");
                assert_eq!(field["format"], "date");
                assert_eq!(field["pattern"], "^[0-9]{4}-[0-9]{2}-[0-9]{2}$");
                let description = field["description"].as_str().unwrap_or_default();
                for semantic in ["Legacy", "local", "preserve", "deadline"] {
                    assert!(description.contains(semantic), "Missing {semantic}: {description}");
                }
            }
            let deadlines = due_dates(&schema);
            assert_eq!(deadlines.len(), due_count);
            for field in deadlines {
                assert_eq!(field["type"], json!(["string", "null"]));
                assert_eq!(field["format"], "date");
                assert_eq!(field["pattern"], "^[0-9]{4}-[0-9]{2}-[0-9]{2}$");
                let description = field["description"].as_str().unwrap_or_default();
                for semantic in ["deadline", "null", "YYYY-MM-DD"] {
                    assert!(description.contains(semantic), "Missing {semantic}: {description}");
                }
            }
        }
    }

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
