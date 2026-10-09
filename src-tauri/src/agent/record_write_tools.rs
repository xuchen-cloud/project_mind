//! Descriptor inventory only. Registering execution/capabilities is a Host decision.
//! JSON node/mark names and attribute whitelists come from the native editor schema.
use super::tools::{
    array, integer, locator_schema, nullable, object, object_ref_schema, scope_schema, text,
    ReadToolDescription,
};
use super::{
    file_tools::{file_intent_schemas, file_schema_definitions, file_tool_descriptions},
    todo_tools::todo_ref_schema,
};
use serde_json::{json, Map, Value};
const SAFE_INTEGER: u64 = 9_007_199_254_740_991;
fn id() -> Value {
    json!({"type":"string","minLength":32,"maxLength":32,"pattern":"^[0-9a-f]{32}$"})
}
fn hash() -> Value {
    json!({"type":"string","minLength":71,"maxLength":71,"pattern":"^sha256:[0-9a-f]{64}$"})
}
fn record() -> Value {
    let mut value = object_ref_schema();
    value["properties"]["kind"] = json!({"type":"string","maxLength":6,"const":"record"});
    value
}
fn enum_string(values: &[&str]) -> Value {
    json!({"type":"string","maxLength":64,"enum":values})
}

fn attribute(name: &str, default: &Value) -> Value {
    if name == "blockId" {
        return json!({"type":"null"});
    } // New nodes receive IDs from the Host.
    if name == "level" {
        return integer(4);
    }
    if matches!(name, "colspan" | "rowspan") {
        return integer(1000);
    }
    if name == "refKind" {
        return enum_string(&["note", "workspace_record", "todo", "document"]);
    }
    if name == "colwidth" {
        return nullable(array(
            json!({"type":"integer","minimum":0,"maximum":1_000_000}),
            100,
        ));
    }
    if matches!(
        name,
        "documentId" | "refId" | "tagId" | "contactId" | "width" | "height"
    ) {
        let max = if matches!(name, "width" | "height") {
            1_000_000
        } else {
            SAFE_INTEGER
        };
        return nullable(
            json!({"anyOf":[integer(max),{"type":"string","minLength":1,"maxLength":16,"pattern":"^[1-9][0-9]*$"}]}),
        );
    }
    if default.is_boolean() {
        json!({"type":"boolean"})
    } else if default.is_number() {
        json!({"type":"number","minimum":0,"maximum":SAFE_INTEGER})
    } else if default.is_string() {
        text(65536)
    } else {
        nullable(text(65536))
    }
}
fn attrs(definition: &Value) -> Value {
    let properties = definition["attrs"]
        .as_object()
        .expect("checked-in editor attribute whitelist")
        .iter()
        .map(|(name, default)| (name.clone(), attribute(name, default)))
        .collect::<Map<_, _>>();
    object(Value::Object(properties), &[])
}

/// Local $defs recursion preserves real table/list depth. The Node policy must
/// allow only '#/$defs/<identifier>' references and inspect each definition once.
fn node_definitions() -> Value {
    let schema: Value = serde_json::from_str(include_str!("../record_document_schema.json"))
        .expect("checked-in editor schema");
    let mark_variants:Vec<_>=schema["marks"].as_array().unwrap().iter().map(|mark|object(json!({"type":{"type":"string","maxLength":32,"const":mark["name"]},"attrs":attrs(mark)}),&["type"])).collect();
    let nodes:Vec<_>=schema["nodes"].as_array().unwrap().iter().filter(|node|node["name"]!="doc").map(|node|{
        let mut properties=json!({"type":{"type":"string","maxLength":32,"const":node["name"]},"attrs":attrs(node),"content":array(json!({"$ref":"#/$defs/BlockInput"}),100),"marks":array(json!({"$ref":"#/$defs/MarkInput"}),if node["attrs"].get("blockId").is_some(){0}else{7})});
        let required=if node["name"]=="text"{properties["text"]=text(65536);vec!["type","text"]}else{vec!["type"]};
        object(properties,&required)
    }).collect();
    json!({"BlockInput":{"oneOf":nodes},"MarkInput":{"oneOf":mark_variants}})
}
fn patch() -> Value {
    let blocks = array(json!({"$ref":"#/$defs/BlockInput"}), 100);
    let operations = vec![
        object(
            json!({"op":{"type":"string","maxLength":32,"const":"replace"},"blockId":id(),"expectedBlockHash":hash(),"block":{"$ref":"#/$defs/BlockInput"}}),
            &["op", "blockId", "expectedBlockHash", "block"],
        ),
        object(
            json!({"op":{"type":"string","maxLength":32,"const":"delete"},"blockId":id(),"expectedBlockHash":hash()}),
            &["op", "blockId", "expectedBlockHash"],
        ),
        object(
            json!({"op":{"type":"string","maxLength":32,"const":"insert_after"},"anchorBlockId":id(),"blocks":blocks}),
            &["op", "anchorBlockId", "blocks"],
        ),
        object(
            json!({"op":{"type":"string","maxLength":32,"const":"append"},"parentBlockId":nullable(id()),"position":enum_string(&["start","end"]),"blocks":blocks}),
            &["op", "parentBlockId", "blocks"],
        ),
        object(
            json!({"op":{"type":"string","maxLength":32,"const":"append_inline"},"blockId":id(),"expectedBlockHash":hash(),"text":text(65536)}),
            &["op", "blockId", "expectedBlockHash", "text"],
        ),
    ];
    object(
        json!({"record":record(),"baseRevision":integer(SAFE_INTEGER),"requestId":text(128),"operations":array(json!({"oneOf":operations}),100)}),
        &["record", "baseRevision", "requestId", "operations"],
    )
}
fn source_ref() -> Value {
    object(
        json!({"object":object_ref_schema(),"revision":text(128),"fileVersion":nullable(integer(u32::MAX.into())),"recordVersion":nullable(integer(u32::MAX.into())),"blockId":nullable(id()),"locator":nullable(locator_schema()),"title":text(1000),"excerpt":text(2000)}),
        &["object", "revision", "title", "excerpt"],
    )
}

fn todo_date() -> Value {
    json!({"type":"string","minLength":10,"maxLength":10,"pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"})
}
fn todo_priority() -> Value {
    enum_string(&[
        "urgent_important",
        "urgent_not_important",
        "not_urgent_important",
        "not_urgent_not_important",
    ])
}
fn todo_status() -> Value {
    enum_string(&["unfinished", "finished"])
}
fn todo_create() -> Value {
    let child = object(
        json!({"content":text(12000),"progressDate":todo_date(),"dueDate":nullable(todo_date())}),
        &["content", "progressDate", "dueDate"],
    );
    let mut dedupe_key = text(128);
    dedupe_key["minLength"] = json!(1);
    object(
        json!({"intent":{"type":"string","maxLength":32,"const":"todo_create"},"scope":scope_schema(),"dedupeKey":dedupe_key,"content":text(12000),"priority":todo_priority(),"dueDate":nullable(todo_date()),"tagIds":array(integer(SAFE_INTEGER),100),"children":array(child,100)}),
        &[
            "intent",
            "scope",
            "dedupeKey",
            "content",
            "priority",
            "dueDate",
            "tagIds",
            "children",
        ],
    )
}
fn todo_update() -> Value {
    let change = |kind: &'static str, mut properties: Value, required: &[&str]| {
        properties["change"] = json!({"type":"string","maxLength":32,"const":kind});
        let mut fields = vec!["change"];
        fields.extend_from_slice(required);
        object(properties, &fields)
    };
    let changes = vec![
        change("content", json!({"content":text(12000)}), &["content"]),
        change(
            "deadline",
            json!({"dueDate":nullable(todo_date())}),
            &["dueDate"],
        ),
        change("status", json!({"status":todo_status()}), &["status"]),
        change(
            "priority",
            json!({"priority":todo_priority()}),
            &["priority"],
        ),
        change(
            "tags",
            json!({"tagIds":array(integer(SAFE_INTEGER),100)}),
            &["tagIds"],
        ),
        change(
            "child_create",
            json!({"content":text(12000),"progressDate":todo_date(),"dueDate":nullable(todo_date())}),
            &["content", "progressDate", "dueDate"],
        ),
        change(
            "child_update",
            json!({"childId":integer(SAFE_INTEGER),"content":text(12000),"progressDate":todo_date(),"dueDate":nullable(todo_date()),"status":todo_status()}),
            &["childId", "content", "progressDate", "dueDate", "status"],
        ),
        change(
            "child_delete",
            json!({"childId":integer(SAFE_INTEGER)}),
            &["childId"],
        ),
    ];
    let mut changes = array(json!({"oneOf":changes}), 50);
    changes["minItems"] = json!(1);
    object(
        json!({"intent":{"type":"string","maxLength":32,"const":"todo_update"},"target":todo_ref_schema(),"expectedRevision":integer(SAFE_INTEGER),"changes":changes}),
        &["intent", "target", "expectedRevision", "changes"],
    )
}

pub(crate) fn record_write_tool_descriptions() -> Vec<ReadToolDescription> {
    let mut result = vec![];
    let mut add = |method: &'static str, description: &'static str, parameters| {
        result.push(ReadToolDescription {
            name: format!("mind_{}", method.replace('.', "_")),
            method,
            description,
            parameters,
        })
    };
    add("record.blocks.get","Read complete committed Record blocks, stable IDs and hashes for safe patch preparation. Pagination stays at one head revision. An oversized block returns child IDs instead of truncated writable content.",object(json!({"record":record(),"revision":nullable(integer(SAFE_INTEGER)),"blockId":nullable(id()),"cursor":nullable(text(2048)),"budgetChars":nullable(integer(12000))}),&["record"]));
    add("todo.get", "Read the actual current Todo revision, body hash and complete native fields, including child IDs. Use these values before staging a Todo update; reading never initializes or writes a Todo.", object(json!({"target":todo_ref_schema()}), &["target"]));
    let create = object(
        json!({"intent":{"type":"string","maxLength":32,"const":"record_create"},"scope":scope_schema(),"title":text(1000),"markdown":text(65536)}),
        &["intent", "scope", "title", "markdown"],
    );
    let patch = object(
        json!({"intent":{"type":"string","maxLength":32,"const":"record_patch"},"patch":patch()}),
        &["intent", "patch"],
    );
    let mut stage = object(
        json!({"intent":{"oneOf":[create,patch,todo_create(),todo_update()]},"sources":array(source_ref(),20)}),
        &["intent", "sources"],
    );
    stage["$defs"] = node_definitions();
    stage["properties"]["intent"]["oneOf"]
        .as_array_mut()
        .unwrap()
        .extend(file_intent_schemas());
    stage["$defs"]
        .as_object_mut()
        .unwrap()
        .extend(file_schema_definitions().as_object().unwrap().clone());
    add("output.stage","Stage a validated Record, Todo or File creation/update/restore. Read actual revisions, IDs and raw File version hashes before updates. Todo creation uses a stable dedupeKey within this Run. File replacements require a completed upload ticket. Collaborate commits and returns its real receipt; review stages for local confirmation. Run and mode come from the Host.",stage);
    add(
        "output.get",
        "Read compact proposal or committed execution metadata authorized to this Run. Read object contents through scoped object read tools; this response does not return full staged File bodies.",
        object(json!({"outputId":id()}), &["outputId"]),
    );
    add(
        "output.list",
        "List outputs of the Host-bound current Run; follow nextCursor for continuation.",
        object(
            json!({"cursor":nullable(text(8192)),"limit":integer(50)}),
            &[],
        ),
    );
    add("output.commit","Commit the expected candidate revision using its native Record, Todo or File transaction. A saved output always returns its committed object and receipt.",object(json!({"outputId":id(),"expectedRevision":integer(SAFE_INTEGER)}),&["outputId","expectedRevision"]));
    add("review.decide", "Decide the complete pending review plan after a later user message in this session. Confirm executes each candidate through its native save; cancel discards it; revise retires the old plan before staging a replacement. Questions need no decision. Copy the exact candidate IDs and revisions from pendingReviewPlans.", object(json!({"runId":id(),"outputs":array(object(json!({"outputId":id(),"expectedRevision":integer(SAFE_INTEGER)}), &["outputId","expectedRevision"]),256),"decision":enum_string(&["confirm","cancel","revise"])}), &["runId","outputs","decision"]));
    add(
        "operation.get",
        "Read a real committed operation receipt within the current scope and caller authority.",
        object(json!({"operationId":id()}), &["operationId"]),
    );
    add("operation.list","List scoped committed operation receipts for an authorized Run, including completed work after cancellation.",object(json!({"runId":id(),"cursor":nullable(text(2048)),"limit":integer(50)}),&["runId"]));
    add("operation.undo","Undo one original operation using its retained native baseline. expectedHeadRevision must still match; later edits or external references cause UndoConflict.",object(json!({"operationId":id(),"expectedHeadRevision":integer(SAFE_INTEGER)}),&["operationId","expectedHeadRevision"]));
    add("operation.restore_created","Restore an originally created Record, Todo or File at its current withdrawal revision, preserving the same object ID and retained history.",object(json!({"creationOperationId":id(),"expectedWithdrawalRevision":integer(SAFE_INTEGER)}),&["creationOperationId","expectedWithdrawalRevision"]));
    result.extend(file_tool_descriptions());
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn todo_stage_schemas_match_native_intents_and_require_nullable_dates() {
        use crate::agent::outputs::OutputIntent;
        let create_schema = todo_create();
        let create = json!({"intent":"todo_create","scope":{"kind":"workspace"},"dedupeKey":"send-report","content":"Send report","priority":"not_urgent_important","dueDate":null,"tagIds":[],"children":[{"content":"Review report","progressDate":"2026-10-08","dueDate":null}]});
        let parsed: OutputIntent = serde_json::from_value(create.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), create);
        assert_eq!(create_schema["properties"]["dedupeKey"]["minLength"], 1);
        for field in ["dueDate", "dedupeKey"] {
            assert!(create_schema["required"]
                .as_array()
                .unwrap()
                .contains(&json!(field)));
            let mut missing = create.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<OutputIntent>(missing).is_err());
        }
        let mut missing_child_date = create.clone();
        missing_child_date["children"][0]
            .as_object_mut()
            .unwrap()
            .remove("dueDate");
        assert!(serde_json::from_value::<OutputIntent>(missing_child_date).is_err());
        let child = &create_schema["properties"]["children"]["items"];
        assert!(child["required"]
            .as_array()
            .unwrap()
            .contains(&json!("dueDate")));

        let target =
            json!({"workspaceId":"workspace","scope":{"kind":"workspace"},"kind":"todo","id":"1"});
        let mutations = vec![
            json!({"change":"content","content":"Send final report"}),
            json!({"change":"deadline","dueDate":null}),
            json!({"change":"status","status":"finished"}),
            json!({"change":"priority","priority":"urgent_important"}),
            json!({"change":"tags","tagIds":[1]}),
            json!({"change":"child_create","content":"Send draft","progressDate":"2026-10-08","dueDate":null}),
            json!({"change":"child_update","childId":2,"content":"Review draft","progressDate":"2026-10-08","dueDate":null,"status":"unfinished"}),
            json!({"change":"child_delete","childId":3}),
        ];
        let schema = todo_update();
        let variants = schema["properties"]["changes"]["items"]["oneOf"]
            .as_array()
            .unwrap();
        assert_eq!(variants.len(), mutations.len());
        assert_eq!(schema["properties"]["changes"]["minItems"], 1);
        assert_eq!(schema["properties"]["changes"]["maxItems"], 50);
        for mutation in mutations {
            let variant = variants
                .iter()
                .find(|variant| variant["properties"]["change"]["const"] == mutation["change"])
                .unwrap();
            assert_eq!(
                variant["properties"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .collect::<Vec<_>>(),
                mutation.as_object().unwrap().keys().collect::<Vec<_>>()
            );
            let update = json!({"intent":"todo_update","target":target,"expectedRevision":2,"changes":[mutation]});
            let parsed: OutputIntent = serde_json::from_value(update.clone()).unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap(), update);
            if mutation.get("dueDate").is_some() {
                assert!(variant["required"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("dueDate")));
                let mut missing = update;
                missing["changes"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("dueDate");
                assert!(serde_json::from_value::<OutputIntent>(missing).is_err());
            }
        }
    }

    #[test]
    fn record_write_schemas_reuse_editor_whitelists_and_bound_recursive_inputs() {
        let descriptions = record_write_tool_descriptions();
        assert_eq!(descriptions.len(), 18);
        let stage = &descriptions
            .iter()
            .find(|tool| tool.method == "output.stage")
            .unwrap()
            .parameters;
        assert!(stage["properties"].get("runId").is_none());
        let editor: Value =
            serde_json::from_str(include_str!("../record_document_schema.json")).unwrap();
        let variants = stage["$defs"]["BlockInput"]["oneOf"].as_array().unwrap();
        assert_eq!(
            variants.len() + 1,
            editor["nodes"].as_array().unwrap().len()
        );
        for variant in variants {
            let kind = &variant["properties"]["type"]["const"];
            let native = editor["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|node| &node["name"] == kind)
                .unwrap();
            let properties = variant["properties"]["attrs"]["properties"]
                .as_object()
                .unwrap();
            assert_eq!(
                properties.keys().collect::<Vec<_>>(),
                native["attrs"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .collect::<Vec<_>>()
            );
            assert_eq!(
                variant["properties"]["content"]["items"]["$ref"],
                "#/$defs/BlockInput"
            );
            assert_eq!(
                variant["properties"]["attrs"]["additionalProperties"],
                false
            );
        }
        let json = serde_json::to_vec_pretty(&descriptions).unwrap();
        assert!(serde_json::to_vec(&descriptions).unwrap().len() <= 65536);
        // Shared artifact for the parent to validate these exact Rust schemas
        // against the executable Node descriptor policy after this serial test.
        std::fs::write("/tmp/project-mind-record-write-tools.json", json).unwrap();
    }
}
