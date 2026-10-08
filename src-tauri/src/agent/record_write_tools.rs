//! Descriptor inventory only. Registering execution/capabilities is a Host decision.
//! JSON node/mark names and attribute whitelists come from the native editor schema.
use super::tools::{
    array, integer, locator_schema, nullable, object, object_ref_schema, scope_schema, text,
    ReadToolDescription,
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
    let create = object(
        json!({"intent":{"type":"string","maxLength":32,"const":"record_create"},"scope":scope_schema(),"title":text(1000),"markdown":text(65536)}),
        &["intent", "scope", "title", "markdown"],
    );
    let patch = object(
        json!({"intent":{"type":"string","maxLength":32,"const":"record_patch"},"patch":patch()}),
        &["intent", "patch"],
    );
    let mut stage = object(
        json!({"intent":{"oneOf":[create,patch]},"sources":array(source_ref(),20)}),
        &["intent", "sources"],
    );
    stage["$defs"] = node_definitions();
    add("output.stage","Create a validated Record candidate or apply a bounded native block patch. The current Run and execution mode come from the Host: collaborate commits and returns the real receipt; review stages for later local commit.",stage);
    add(
        "output.get",
        "Read one candidate or committed output authorized to the current Run.",
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
    add("output.commit","Commit the expected candidate revision using its native Record transaction. A saved output always returns its committed object and receipt.",object(json!({"outputId":id(),"expectedRevision":integer(SAFE_INTEGER)}),&["outputId","expectedRevision"]));
    add(
        "operation.get",
        "Read a real committed operation receipt within the current scope and caller authority.",
        object(json!({"operationId":id()}), &["operationId"]),
    );
    add("operation.list","List scoped committed operation receipts for an authorized Run, including completed work after cancellation.",object(json!({"runId":id(),"cursor":nullable(text(2048)),"limit":integer(50)}),&["runId"]));
    add("operation.undo","Undo one original operation using its retained native baseline. expectedHeadRevision must still match; later edits or external references cause UndoConflict.",object(json!({"operationId":id(),"expectedHeadRevision":integer(SAFE_INTEGER)}),&["operationId","expectedHeadRevision"]));
    add("operation.restore_created","Restore an originally created Record at the current withdrawal revision, preserving the same Record ID and its history.",object(json!({"creationOperationId":id(),"expectedWithdrawalRevision":integer(SAFE_INTEGER)}),&["creationOperationId","expectedWithdrawalRevision"]));
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn record_write_schemas_reuse_editor_whitelists_and_bound_recursive_inputs() {
        let descriptions = record_write_tool_descriptions();
        assert_eq!(descriptions.len(), 9);
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
        assert!(json.len() < 100_000);
        // Shared artifact for the parent to validate these exact Rust schemas
        // against the executable Node descriptor policy after this serial test.
        std::fs::write("/tmp/project-mind-record-write-tools.json", json).unwrap();
    }
}
