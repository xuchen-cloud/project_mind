//! Typed current Todo reads used to prepare revision-checked staged outputs.
use super::{models::ObjectRef, tools::object_ref_schema};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TodoGetInput {
    pub target: ObjectRef,
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
