//! Record document contracts. The utility worker owns editor conversion; Rust
//! independently validates bounded structure, stable IDs and portable references.
use crate::agent::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::Scope,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    sync::OnceLock,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordTarget {
    pub scope: Scope,
    pub record_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordMetadata {
    pub title: Option<String>,
    pub tag_ids: Vec<i64>,
    pub revision: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordMetadataUpdate {
    pub target: RecordTarget,
    pub expected_revision: String,
    pub title: Option<String>,
    pub tag_ids: Vec<i64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordMetadataNewTag {
    pub label: String,
    pub color_key: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordMetadataApply {
    pub metadata: RecordMetadataUpdate,
    pub new_tags: Vec<RecordMetadataNewTag>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordCreate {
    pub scope: Scope,
    pub title: Option<String>,
    pub tag_ids: Vec<i64>,
    pub document: Value,
    pub code_language: Option<String>,
}

#[derive(Serialize)]
#[serde(untagged)]
pub(crate) enum RecordEditorRecord {
    Project(crate::models::NoteRecord),
    Workspace(crate::models::WorkspaceRecord),
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordEditorState {
    pub head: RecordDocumentHead,
    pub metadata: RecordMetadata,
    pub record: RecordEditorRecord,
}
impl RecordTarget {
    pub fn key(&self) -> AgentResult<String> {
        self.scope.validate()?;
        if self.record_id <= 0 {
            return Err(invalid("Record ID must be positive"));
        }
        Ok(format!("{}:{}", self.scope.key(), self.record_id))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordDocumentProjection {
    pub schema_version: u32,
    pub document: Value,
    pub html: String,
    pub markdown: String,
    pub text: String,
    pub code_language: Option<String>,
    pub body_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordDocumentHead {
    pub target: RecordTarget,
    pub head_revision: u64,
    pub projection: RecordDocumentProjection,
    pub edit_session_id: Option<String>,
    pub checkpoint_due_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordLegacySource {
    pub html: String,
    pub markdown: String,
    pub code_language: Option<String>,
    pub title: Option<String>,
    pub source_hash: String,
    pub asset_base_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RecordVersionOrigin {
    Baseline,
    Manual,
    Agent,
    EditorAi,
    QuickNote,
    Restore,
    Import,
}
impl RecordVersionOrigin {
    pub fn key(&self) -> &'static str {
        match self {
            Self::Baseline => "baseline",
            Self::Manual => "manual",
            Self::Agent => "agent",
            Self::EditorAi => "editor_ai",
            Self::QuickNote => "quick_note",
            Self::Restore => "restore",
            Self::Import => "import",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordDocumentCommit {
    pub target: RecordTarget,
    pub base_revision: u64,
    pub projection: RecordDocumentProjection,
    pub origin: RecordVersionOrigin,
    pub actor: Value,
    pub edit_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordCommitResult {
    pub head: RecordDocumentHead,
    pub no_change: bool,
    pub before_version: String,
    pub after_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<RecordMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordQuickNoteTransfer {
    pub scope: Scope,
    pub record_id: Option<i64>,
    pub base_revision: Option<u64>,
    pub metadata_revision: Option<String>,
    pub expected_markdown: String,
    pub title: Option<String>,
    pub tag_ids: Vec<i64>,
}

#[derive(Debug, Clone)]
pub(crate) struct RecordQuickNoteSource {
    pub quick_note_id: Option<i64>,
    pub html: String,
    pub markdown: String,
    pub code_language: Option<String>,
    pub asset_base_path: Option<String>,
    pub source_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordCheckpointInput {
    pub target: RecordTarget,
    pub base_revision: u64,
    pub reason: RecordCheckpointReason,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RecordCheckpointReason {
    Due,
    LeaveEditor,
    OpenHistory,
    Shutdown,
    Recovery,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordCheckpointResult {
    pub head: RecordDocumentHead,
    pub version_id: Option<String>,
    pub checkpointed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordVersion {
    pub id: String,
    pub version_number: u64,
    pub head_revision: u64,
    pub projection: RecordDocumentProjection,
    pub title_snapshot: Option<String>,
    pub origin: RecordVersionOrigin,
    pub actor: Value,
    pub operation_id: String,
    pub restored_from_version_id: Option<String>,
    pub created_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordVersionSummary {
    pub id: String,
    pub version_number: u64,
    pub head_revision: u64,
    pub title_snapshot: Option<String>,
    pub body_hash: String,
    pub origin: RecordVersionOrigin,
    pub created_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordVersionPage {
    pub versions: Vec<RecordVersionSummary>,
    pub next_before: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordRestoreInput {
    pub target: RecordTarget,
    pub base_revision: u64,
    pub version_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordVersionCapacity {
    pub version_count: u64,
    pub snapshot_bytes: u64,
    pub retained_asset_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordPatchMetadata {
    pub created_block_ids: Vec<String>,
    pub deleted_block_ids: Vec<String>,
    pub normalizations: Vec<RecordPatchNormalization>,
    pub no_change: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordPatchNormalization {
    pub kind: String,
    pub block_id: Option<String>,
}
pub(crate) enum RecordPatchPreparation {
    Replay(RecordPatchResult),
    Base(RecordDocumentHead),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordPatchResult {
    pub head: RecordDocumentHead,
    pub before_revision: u64,
    pub after_revision: u64,
    pub created_block_ids: Vec<String>,
    pub deleted_block_ids: Vec<String>,
    pub normalizations: Vec<RecordPatchNormalization>,
    pub before_version: String,
    pub after_version: Option<String>,
    pub changed_refs: Vec<crate::agent::models::ObjectRef>,
    pub receipt: crate::agent::outputs::OperationReceipt,
    pub no_change: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditorSchema {
    schema_version: u32,
    nodes: Vec<EditorType>,
    marks: Vec<EditorType>,
}
#[derive(Deserialize)]
struct EditorType {
    name: String,
    attrs: BTreeMap<String, Value>,
    content: Option<String>,
    group: Option<String>,
}

pub(crate) fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidPatch, message)
}
pub(crate) fn body_hash(document: &Value, language: &Option<String>) -> String {
    format!(
        "sha256:{:x}",
        Sha256::digest(
            serde_json::to_vec(&json!({ "codeLanguage": language, "document": document }))
                .expect("JSON values serialize")
        )
    )
}
fn schema() -> &'static EditorSchema {
    static SCHEMA: OnceLock<EditorSchema> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        serde_json::from_str(include_str!("record_document_schema.json"))
            .expect("validated editor schema fixture")
    })
}
fn stable_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
pub(crate) fn relative_asset(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains(['\\', ':', '\0'])
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

impl RecordDocumentProjection {
    pub fn validate(&self) -> AgentResult<Vec<String>> {
        if self.schema_version != schema().schema_version {
            return Err(invalid("Unsupported Record document schema"));
        }
        if self.html.len() > 4 * 1024 * 1024
            || self.markdown.len() > 4 * 1024 * 1024
            || self.text.len() > 4 * 1024 * 1024
            || serde_json::to_vec(&self.document)
                .map_err(|_| invalid("Invalid document"))?
                .len()
                > 1024 * 1024
        {
            return Err(invalid("Record document exceeds size limit"));
        }
        if self.code_language.as_ref().is_some_and(|language| {
            language.len() > 64
                || language.trim().to_lowercase() != *language
                || language.is_empty()
        }) {
            return Err(invalid("Invalid canonical code language"));
        }
        let mut ids = HashSet::new();
        let mut assets = HashSet::new();
        let mut count = 0;
        validate_node(
            &self.document,
            None,
            0,
            &mut ids,
            &mut assets,
            &mut count,
            true,
        )?;
        if self.document.get("type").and_then(Value::as_str) != Some("doc")
            || body_hash(&self.document, &self.code_language) != self.body_hash
        {
            return Err(invalid("Record body checksum or root differs"));
        }
        let mut assets: Vec<_> = assets.into_iter().collect();
        assets.sort();
        Ok(assets)
    }
}

fn validate_attrs(value: Option<&Value>, ty: &EditorType) -> AgentResult<()> {
    let Some(value) = value else {
        return Ok(());
    };
    let attrs = value
        .as_object()
        .ok_or_else(|| invalid("Invalid node attributes"))?;
    for (name, value) in attrs {
        let default = ty
            .attrs
            .get(name)
            .ok_or_else(|| invalid("Unknown editor attribute"))?;
        let scalar =
            value.is_null() || value.is_string() || value.is_boolean() || value.is_number();
        let widths = name == "colwidth"
            && value.as_array().is_some_and(|widths| {
                widths.len() <= 1000
                    && widths
                        .iter()
                        .all(|width| width.as_u64().is_some_and(|width| width <= 1_000_000))
            });
        if !scalar && !widths {
            return Err(invalid("Invalid editor attribute value"));
        }
        if (default.is_boolean() && !value.is_boolean())
            || (default.is_number() && !value.is_number())
            || (default.is_string() && !value.is_string())
        {
            return Err(invalid("Invalid editor attribute type"));
        }
        if matches!(name.as_str(), "colspan" | "rowspan")
            && !value
                .as_u64()
                .is_some_and(|span| (1..=1000).contains(&span))
        {
            return Err(invalid("Invalid table span"));
        }
        if name == "level" && !value.as_u64().is_some_and(|level| (1..=4).contains(&level)) {
            return Err(invalid("Invalid heading level"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> RecordDocumentProjection {
        serde_json::from_str(include_str!("record_document_projection.fixture.json")).unwrap()
    }
    #[test]
    fn record_projection_matches_worker_hash_and_keeps_managed_assets_portable() {
        let projection = fixture();
        assert_eq!(
            projection.validate().unwrap(),
            vec!["assets/图片.png", "assets/文件.pdf"]
        );
        assert!(!projection.html.contains("/Users/"));
    }
    #[test]
    fn record_projection_rejects_lost_ids_unknown_fields_and_invalid_editor_structure() {
        let mut projection = fixture();
        projection.document["content"][1]["attrs"]["blockId"] =
            projection.document["content"][0]["attrs"]["blockId"].clone();
        assert_eq!(
            projection.validate().unwrap_err().code,
            ErrorCode::InvalidPatch
        );
        let mut projection = fixture();
        projection.document["content"][0]["attrs"]["unknown"] = json!("preserve");
        assert_eq!(
            projection.validate().unwrap_err().code,
            ErrorCode::InvalidPatch
        );
        let mut projection = fixture();
        projection.document["content"][0]["type"] = json!("listItem");
        assert_eq!(
            projection.validate().unwrap_err().code,
            ErrorCode::InvalidPatch
        );
        let mut projection = fixture();
        projection.document["content"][2]["attrs"]["path"] = json!("../outside.png");
        assert_eq!(
            projection.validate().unwrap_err().code,
            ErrorCode::InvalidPatch
        );
    }
}

fn validate_node(
    node: &Value,
    parent: Option<&str>,
    depth: usize,
    ids: &mut HashSet<String>,
    assets: &mut HashSet<String>,
    count: &mut usize,
    canonical: bool,
) -> AgentResult<()> {
    *count += 1;
    if depth > 64 || *count > 50_000 {
        return Err(invalid("Invalid document depth or node count"));
    }
    let object = node.as_object().ok_or_else(|| invalid("Invalid node"))?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "type" | "attrs" | "content" | "marks" | "text"
        )
    }) {
        return Err(invalid("Unknown node field"));
    }
    let name = node
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("Invalid node type"))?;
    let ty = schema()
        .nodes
        .iter()
        .find(|ty| ty.name == name)
        .ok_or_else(|| invalid("Unknown editor node"))?;
    if parent.is_some() && name == "doc" {
        return Err(invalid("Nested document root"));
    }
    validate_attrs(node.get("attrs"), ty)?;
    if ty.attrs.contains_key("blockId") {
        let supplied = node
            .pointer("/attrs/blockId")
            .filter(|value| !value.is_null());
        if canonical {
            let id = supplied
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("Missing stable block ID"))?;
            if !stable_id(id) || !ids.insert(id.to_string()) {
                return Err(invalid("Invalid or duplicate stable block ID"));
            }
        } else if supplied.is_some() {
            return Err(invalid("New block IDs must be allocated by the Host"));
        }
    }
    if let Some(marks) = node.get("marks") {
        let marks = marks.as_array().ok_or_else(|| invalid("Invalid marks"))?;
        if !marks.is_empty() && (ty.attrs.contains_key("blockId") || parent == Some("codeBlock")) {
            return Err(invalid("Marks are not allowed on this node"));
        }
        let mut names = HashSet::new();
        for mark in marks {
            let object = mark.as_object().ok_or_else(|| invalid("Invalid mark"))?;
            if object.keys().any(|key| key != "type" && key != "attrs") {
                return Err(invalid("Unknown mark field"));
            }
            let name = mark
                .get("type")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("Invalid mark type"))?;
            if !names.insert(name) {
                return Err(invalid("Duplicate mark"));
            }
            let ty = schema()
                .marks
                .iter()
                .find(|ty| ty.name == name)
                .ok_or_else(|| invalid("Unknown mark"))?;
            validate_attrs(mark.get("attrs"), ty)?;
        }
    }
    if name == "text" {
        if !node
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.is_empty())
            || node.get("content").is_some()
        {
            return Err(invalid("Invalid text node"));
        }
    } else if node.get("text").is_some() {
        return Err(invalid("Unexpected text field"));
    }
    let content: &[Value] = match node.get("content") {
        Some(value) => value
            .as_array()
            .ok_or_else(|| invalid("Invalid node content"))?,
        None => &[],
    };
    fn child_name(child: &Value) -> &str {
        child.get("type").and_then(Value::as_str).unwrap_or("")
    }
    let is_block = |child: &Value| {
        schema().nodes.iter().any(|ty| {
            ty.name == child_name(child)
                && ty
                    .group
                    .as_ref()
                    .is_some_and(|group| group.split_whitespace().any(|group| group == "block"))
        })
    };
    let is_inline = |child: &Value| {
        matches!(
            child_name(child),
            "text" | "hardBreak" | "internalReference" | "contactMention" | "tagMention"
        )
    };
    let valid_content = match ty.content.as_deref() {
        None => content.is_empty(),
        Some("inline*") => content.iter().all(is_inline),
        Some("text*") => content.iter().all(|child| child_name(child) == "text"),
        Some("block+") => !content.is_empty() && content.iter().all(is_block),
        Some("listItem+") => {
            !content.is_empty() && content.iter().all(|child| child_name(child) == "listItem")
        }
        Some("taskItem+") => {
            !content.is_empty() && content.iter().all(|child| child_name(child) == "taskItem")
        }
        Some("tableRow+") => {
            !content.is_empty() && content.iter().all(|child| child_name(child) == "tableRow")
        }
        Some("(tableCell | tableHeader)*") => {
            !content.is_empty()
                && content
                    .iter()
                    .all(|child| matches!(child_name(child), "tableCell" | "tableHeader"))
        }
        Some("paragraph block*") => {
            !content.is_empty()
                && child_name(&content[0]) == "paragraph"
                && content.iter().all(is_block)
        }
        _ => false,
    };
    if !valid_content {
        return Err(invalid("Invalid editor content structure"));
    }
    if matches!(name, "image" | "attachment") {
        if let Some(path) = node.pointer("/attrs/path").filter(|value| !value.is_null()) {
            let path = path
                .as_str()
                .filter(|path| relative_asset(path))
                .ok_or_else(|| invalid("Invalid managed asset path"))?;
            assets.insert(path.to_string());
            let url = if name == "image" {
                "/attrs/src"
            } else {
                "/attrs/href"
            };
            if canonical && node.pointer(url).is_some_and(|value| !value.is_null()) {
                return Err(invalid("Managed asset has a local display URL"));
            }
        } else if name == "image"
            && !node
                .pointer("/attrs/src")
                .and_then(Value::as_str)
                .is_some_and(|url| {
                    url.get(..8)
                        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
                        || url
                            .get(..7)
                            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://"))
                })
        {
            return Err(invalid(
                "Image requires a portable managed path or remote source",
            ));
        }
    }
    if name == "attachment" && node.pointer("/attrs/path").is_none_or(Value::is_null) {
        if let Some(href) = node.pointer("/attrs/href").filter(|value| !value.is_null()) {
            if !href.as_str().is_some_and(|href| {
                href.starts_with('#')
                    || href
                        .get(..8)
                        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
                    || href
                        .get(..7)
                        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://"))
            }) {
                return Err(invalid(
                    "Managed attachment requires an explicit retained path",
                ));
            }
        }
    }
    for child in content {
        validate_node(child, Some(name), depth + 1, ids, assets, count, canonical)?;
    }
    Ok(())
}

pub(crate) fn record_patch_target(
    patch: &crate::agent::outputs::RecordPatch,
) -> AgentResult<RecordTarget> {
    use crate::agent::models::ObjectKind;
    patch.record.key()?;
    if patch.record.kind != ObjectKind::Record {
        return Err(invalid("Only editable Record bodies support block patches"));
    }
    let record_id = patch
        .record
        .id
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0 && id.to_string() == patch.record.id)
        .ok_or_else(|| invalid("Record requires a canonical positive ID"))?;
    if patch.base_revision == 0
        || patch.base_revision > i64::MAX as u64
        || patch.request_id.is_empty()
        || patch.request_id.len() > 128
    {
        return Err(invalid("Invalid patch revision or request identity"));
    }
    Ok(RecordTarget {
        scope: patch.record.scope.clone(),
        record_id,
    })
}

fn block_map(document: &Value) -> BTreeMap<String, (&Value, Option<String>)> {
    fn visit<'a>(
        node: &'a Value,
        parent: Option<String>,
        result: &mut BTreeMap<String, (&'a Value, Option<String>)>,
    ) {
        let id = node
            .pointer("/attrs/blockId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(id) = &id {
            result.insert(id.clone(), (node, parent.clone()));
        }
        if let Some(children) = node.get("content").and_then(Value::as_array) {
            for child in children {
                visit(child, id.clone().or_else(|| parent.clone()), result);
            }
        }
    }
    let mut result = BTreeMap::new();
    visit(document, None, &mut result);
    result
}
pub(crate) fn document_block_ids(document: &Value) -> Vec<String> {
    block_map(document).into_keys().collect()
}

pub(crate) fn validate_record_patch(
    patch: &crate::agent::outputs::RecordPatch,
    head: &RecordDocumentHead,
) -> AgentResult<()> {
    use crate::agent::outputs::{BlockEdit, BlockInput};
    let target = record_patch_target(patch)?;
    if target.key()? != head.target.key()? {
        return Err(invalid("Patch targets another Record"));
    }
    if patch.operations.is_empty()
        || patch.operations.len() > 100
        || serde_json::to_vec(patch)
            .map_err(|_| invalid("Invalid patch data"))?
            .len()
            > 1024 * 1024
    {
        return Err(invalid("Invalid patch size or operation count"));
    }
    head.projection.validate()?;
    let blocks = block_map(&head.projection.document);
    let mut targets = HashSet::new();
    let mut inserted = Vec::<&BlockInput>::new();
    for operation in &patch.operations {
        let (target, expected) = match operation {
            BlockEdit::Replace {
                block_id,
                expected_block_hash,
                block,
            } => {
                inserted.push(block);
                (Some(block_id), Some(expected_block_hash))
            }
            BlockEdit::Delete {
                block_id,
                expected_block_hash,
            }
            | BlockEdit::AppendInline {
                block_id,
                expected_block_hash,
                ..
            } => (Some(block_id), Some(expected_block_hash)),
            BlockEdit::InsertAfter {
                anchor_block_id,
                blocks,
            } => {
                if blocks.is_empty() {
                    return Err(invalid("Empty block insertion"));
                }
                inserted.extend(blocks);
                (Some(anchor_block_id), None)
            }
            BlockEdit::Append {
                parent_block_id,
                blocks,
                ..
            } => {
                if blocks.is_empty() {
                    return Err(invalid("Empty block insertion"));
                }
                inserted.extend(blocks);
                (parent_block_id.as_ref(), None)
            }
        };
        let key = target.map(String::as_str).unwrap_or("document");
        if !targets.insert(key.to_string()) {
            return Err(invalid("Duplicate patch target"));
        }
        if let Some(id) = target {
            let (node, _) = blocks
                .get(id)
                .ok_or_else(|| invalid("Unknown block anchor"))?;
            if let Some(expected) = expected {
                let hash = format!(
                    "sha256:{:x}",
                    Sha256::digest(serde_json::to_vec(node).map_err(|_| invalid("Invalid block"))?)
                );
                if &hash != expected {
                    return Err(invalid("Block hash differs from base snapshot"));
                }
            }
            if matches!(operation, BlockEdit::AppendInline { .. })
                && !matches!(
                    node.get("type").and_then(Value::as_str),
                    Some("paragraph" | "heading" | "codeBlock")
                )
            {
                return Err(invalid("Invalid inline append target"));
            }
        }
    }
    for id in &targets {
        let mut parent = blocks.get(id).and_then(|(_, parent)| parent.as_ref());
        while let Some(id) = parent {
            if targets.contains(id) {
                return Err(invalid("Overlapping ancestor and descendant patch targets"));
            }
            parent = blocks.get(id).and_then(|(_, parent)| parent.as_ref());
        }
    }
    let mut count = 0;
    for block in inserted {
        let value = serde_json::to_value(block).map_err(|_| invalid("Invalid inserted block"))?;
        let ty = schema()
            .nodes
            .iter()
            .find(|ty| ty.name == block.node_type)
            .ok_or_else(|| invalid("Unknown inserted block type"))?;
        if !ty.attrs.contains_key("blockId") {
            return Err(invalid("Insertion requires addressable blocks"));
        }
        validate_node(
            &value,
            None,
            0,
            &mut HashSet::new(),
            &mut HashSet::new(),
            &mut count,
            false,
        )?;
    }
    Ok(())
}
