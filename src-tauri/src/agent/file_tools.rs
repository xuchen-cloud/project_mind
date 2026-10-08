//! File read/upload wire DTOs and descriptors. Content writes remain outputs.
use super::{
    models::ObjectRef,
    tools::{array, integer, nullable, object, object_ref_schema, text, ReadToolDescription},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
const SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const CONTENT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileSourceReadInput {
    pub object: ObjectRef,
    pub version_number: u32,
    pub expected_content_hash: Option<String>,
    pub cursor: Option<String>,
    pub budget_chars: Option<usize>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileVersionsListInput {
    pub object: ObjectRef,
    pub cursor: Option<u32>,
    pub limit: Option<u16>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileVersionsGetInput {
    pub object: ObjectRef,
    pub version_id: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileVersionMetadata {
    pub id: String,
    pub version_number: u32,
    pub name: String,
    pub created_at: String,
    pub content_hash: Option<String>,
    pub is_current: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileVersionsPage {
    pub object: ObjectRef,
    pub current_version_number: u32,
    pub current_content_hash: Option<String>,
    pub versions: Vec<FileVersionMetadata>,
    pub next_cursor: Option<u32>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileVersionResult {
    pub object: ObjectRef,
    pub current_version_number: u32,
    pub current_content_hash: Option<String>,
    pub version: FileVersionMetadata,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileContentChunkInput {
    pub staged_content_id: String,
    pub offset: u64,
    pub data_base64: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileContentIdInput {
    pub staged_content_id: String,
}
pub(super) fn file_ref_schema() -> Value {
    let mut value = object_ref_schema();
    value["properties"]["kind"] = json!({"type":"string","maxLength":4,"const":"file"});
    value["properties"]["scope"] = object(
        json!({"kind":{"type":"string","maxLength":7,"const":"project"},"projectId":integer(SAFE_INTEGER)}),
        &["kind", "projectId"],
    );
    value
}
fn content_hash() -> Value {
    json!({"type":"string","minLength":71,"maxLength":71,"pattern":"^sha256:[0-9a-f]{64}$"})
}
fn stage_id() -> Value {
    json!({"type":"string","minLength":32,"maxLength":32,"pattern":"^[0-9a-f]{32}$"})
}
fn version_id() -> Value {
    json!({"type":"string","minLength":1,"maxLength":19,"pattern":"^[1-9][0-9]*$"})
}
fn file_reference() -> Value {
    json!({"$ref":"#/$defs/FileObjectRef"})
}
pub(super) fn file_intent_schemas() -> Vec<Value> {
    let mut old_text = text(1024 * 1024);
    old_text["minLength"] = json!(1);
    let edit = object(
        json!({"oldText":old_text,"newText":text(1024*1024),"occurrence":nullable(integer(u32::MAX.into()))}),
        &["oldText", "newText"],
    );
    let mut edits = array(edit, 100);
    edits["minItems"] = json!(1);
    let baseline = || json!({"object":file_reference(),"expectedVersionNumber":integer(u32::MAX.into()),"expectedContentHash":content_hash()});
    let mut edited = baseline();
    edited["edits"] = edits;
    edited["appendText"] = json!({"type":"null"});
    let edited = object(
        edited,
        &[
            "object",
            "expectedVersionNumber",
            "expectedContentHash",
            "edits",
        ],
    );
    let mut appended = baseline();
    appended["edits"] = json!({"type":"null"});
    appended["appendText"] = text(1024 * 1024);
    let appended = object(
        appended,
        &[
            "object",
            "expectedVersionNumber",
            "expectedContentHash",
            "appendText",
        ],
    );
    vec![
        object(
            json!({"intent":{"type":"string","maxLength":32,"const":"file_create"},"projectId":integer(SAFE_INTEGER),"safeName":text(255),"utf8Content":text(CONTENT_BYTES)}),
            &["intent", "projectId", "safeName", "utf8Content"],
        ),
        object(
            json!({"intent":{"type":"string","maxLength":32,"const":"file_update"},"target":file_reference(),"expectedVersion":integer(u32::MAX.into()),"expectedHash":content_hash(),"stagedContentId":stage_id()}),
            &[
                "intent",
                "target",
                "expectedVersion",
                "expectedHash",
                "stagedContentId",
            ],
        ),
        object(
            json!({"intent":{"type":"string","maxLength":32,"const":"file_patch"},"patch":{"oneOf":[edited,appended]}}),
            &["intent", "patch"],
        ),
        object(
            json!({"intent":{"type":"string","maxLength":32,"const":"file_restore"},"restore":object(json!({"object":file_reference(),"versionId":version_id(),"expectedVersionNumber":integer(u32::MAX.into()),"expectedContentHash":content_hash()}), &["object", "versionId", "expectedVersionNumber", "expectedContentHash"])}),
            &["intent", "restore"],
        ),
    ]
}
pub(super) fn file_schema_definitions() -> Value {
    json!({"FileObjectRef":file_ref_schema()})
}
pub(crate) fn file_tool_descriptions() -> Vec<ReadToolDescription> {
    let tool = |method: &'static str, description: &'static str, parameters| ReadToolDescription {
        name: format!("mind_{}", method.replace('.', "_")),
        method,
        description,
        parameters,
    };
    vec![
        tool("file.source.read", "Read raw UTF-8 md/txt/html/htm bytes from one explicit registered File version. Preserve scripts, BOM and newlines. Pages bind to the same version/hash; this is source code, not extracted index text.", object(json!({"object":file_ref_schema(),"versionNumber":integer(u32::MAX.into()),"expectedContentHash":nullable(content_hash()),"cursor":nullable(text(2048)),"budgetChars":nullable(integer(24000))}), &["object", "versionNumber"])),
        tool("file.versions.list", "List authorized retained File version metadata, including registered or unknown hashes, without reading paths or source bytes. Follow nextCursor for older versions.", object(json!({"object":file_ref_schema(),"cursor":nullable(integer(u32::MAX.into())),"limit":nullable(integer(100))}), &["object"])),
        tool("file.versions.get", "Read metadata for one retained File version ID. Use its versionNumber and known contentHash with file.source.read for exact historical text.", object(json!({"object":file_ref_schema(),"versionId":version_id()}), &["object", "versionId"])),
        tool("file.content.begin", "Begin bounded server-owned replacement content upload against an actual File version/hash. This only stages content; save through output.stage file_update after upload completes.", object(json!({"object":file_ref_schema(),"expectedVersionNumber":integer(u32::MAX.into()),"expectedContentHash":content_hash(),"length":{"type":"integer","minimum":0,"maximum":104857600},"contentHash":content_hash()}), &["object", "expectedVersionNumber", "expectedContentHash", "length", "contentHash"])),
        tool("file.content.chunk", "Append one base64-encoded chunk of at most 1 MiB at the exact received byte offset to a server-owned content ticket. This does not save a File version.", object(json!({"stagedContentId":stage_id(),"offset":{"type":"integer","minimum":0,"maximum":104857600},"dataBase64":{"type":"string","minLength":4,"maxLength":1398104,"pattern":"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"}}), &["stagedContentId", "offset", "dataBase64"])),
        tool("file.content.complete", "Verify the staged content length and full hash, making its ticket ready for output.stage file_update. Completion does not commit source changes.", object(json!({"stagedContentId":stage_id()}), &["stagedContentId"])),
        tool("file.content.status", "Read the authorized upload ticket's actual received byte length, readiness and consumption state.", object(json!({"stagedContentId":stage_id()}), &["stagedContentId"])),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_stage_schemas_match_native_intents_and_export_exact_inventory() {
        use crate::agent::outputs::OutputIntent;
        let target = json!({"workspaceId":"workspace","scope":{"kind":"project","projectId":1},"kind":"file","id":"1"});
        let hash = format!("sha256:{}", "a".repeat(64));
        let inputs = vec![
            json!({"intent":"file_create","projectId":1,"safeName":"source.html","utf8Content":"<script>source()</script>\r\n"}),
            json!({"intent":"file_update","target":target,"expectedVersion":1,"expectedHash":hash,"stagedContentId":"b".repeat(32)}),
            json!({"intent":"file_patch","patch":{"object":target,"expectedVersionNumber":1,"expectedContentHash":hash,"edits":[{"oldText":"source","newText":"changed","occurrence":null}],"appendText":null}}),
            json!({"intent":"file_patch","patch":{"object":target,"expectedVersionNumber":1,"expectedContentHash":hash,"edits":null,"appendText":"\r\nappended"}}),
            json!({"intent":"file_restore","restore":{"object":target,"versionId":"2","expectedVersionNumber":1,"expectedContentHash":hash}}),
        ];
        for input in inputs {
            let native: OutputIntent = serde_json::from_value(input.clone()).unwrap();
            assert_eq!(serde_json::to_value(native).unwrap(), input);
        }
        let inventory = crate::agent::record_write_tools::record_write_tool_descriptions();
        assert_eq!(inventory.len(), 17);
        assert!(serde_json::to_vec(&inventory).unwrap().len() <= 65536);
        std::fs::write(
            "/tmp/project-mind-record-write-tools.json",
            serde_json::to_vec_pretty(&inventory).unwrap(),
        )
        .unwrap();
    }
}
