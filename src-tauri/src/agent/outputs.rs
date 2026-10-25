//! Write contracts only: no writes enabled until CAS, versions and receipts are wired.
use super::{
    errors::AgentResult,
    models::{ObjectRef, Scope, SourceRef},
};
use serde::{Deserialize, Serialize};

/// Canonical editor node input. AI-16 supplies the shared whitelist validator;
/// these DTOs alone do not make a node safe to write.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlockInput {
    #[serde(rename = "type")]
    pub node_type: String,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub attrs: serde_json::Map<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub content: Vec<BlockInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub marks: Vec<MarkInput>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MarkInput {
    #[serde(rename = "type")]
    pub mark_type: String,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub attrs: serde_json::Map<String, serde_json::Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AppendPosition {
    Start,
    End,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "op",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BlockEdit {
    Replace {
        block_id: String,
        expected_block_hash: String,
        block: BlockInput,
    },
    Delete {
        block_id: String,
        expected_block_hash: String,
    },
    InsertAfter {
        anchor_block_id: String,
        blocks: Vec<BlockInput>,
    },
    Append {
        parent_block_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        position: Option<AppendPosition>,
        blocks: Vec<BlockInput>,
    },
    AppendInline {
        block_id: String,
        expected_block_hash: String,
        text: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordPatch {
    pub record: ObjectRef,
    pub base_revision: u64,
    pub request_id: String,
    pub operations: Vec<BlockEdit>,
}

// Nullable dates are explicit in the Agent wire contract: missing fields must
// never silently clear a deadline. A supplied JSON null remains valid.
fn required_date<'de, D: serde::Deserializer<'de>>(value: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(value)
}
pub(crate) const TODO_PRIORITIES: &[&str] = &[
    "urgent_important",
    "urgent_not_important",
    "not_urgent_important",
    "not_urgent_not_important",
];
pub(crate) const TODO_STATUSES: &[&str] = &["unfinished", "finished"];

pub(crate) fn todo_priority_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    let mut schema = <String as schemars::JsonSchema>::json_schema(generator);
    schema.insert("enum".into(), serde_json::json!(TODO_PRIORITIES));
    schema.insert("description".into(), serde_json::json!(
        "Todo priority by urgency and importance: urgent_important, urgent_not_important, not_urgent_important, or not_urgent_not_important."
    ));
    schema
}

pub(crate) fn todo_status_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    let mut schema = <String as schemars::JsonSchema>::json_schema(generator);
    schema.insert("enum".into(), serde_json::json!(TODO_STATUSES));
    schema.insert("description".into(), serde_json::json!(
        "Todo or child completion status: unfinished for open work, finished for completed work."
    ));
    schema
}

fn progress_date_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    let mut schema = <String as schemars::JsonSchema>::json_schema(generator);
    schema.insert("format".into(), serde_json::json!("date"));
    schema.insert("pattern".into(), serde_json::json!("^[0-9]{4}-[0-9]{2}-[0-9]{2}$"));
    schema.insert("description".into(), serde_json::json!(
        "Legacy child record date as a valid YYYY-MM-DD calendar date. The UI uses the local date on creation and preserves the existing date on edit. Native writes store the supplied date separately from the deadline and completion timestamp."
    ));
    schema
}

pub(crate) fn nullable_due_date_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    let mut schema = <Option<String> as schemars::JsonSchema>::json_schema(generator);
    schema.insert("format".into(), serde_json::json!("date"));
    schema.insert("pattern".into(), serde_json::json!("^[0-9]{4}-[0-9]{2}-[0-9]{2}$"));
    schema.insert("description".into(), serde_json::json!(
        "Todo or child deadline as a valid YYYY-MM-DD calendar date. Required field: null means no deadline on creation and clears the deadline on update; omission is invalid."
    ));
    schema
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TodoNewChild {
    pub content: String,
    #[schemars(schema_with = "progress_date_schema")]
    pub progress_date: String,
    #[serde(deserialize_with = "required_date")]
    #[schemars(required, schema_with = "nullable_due_date_schema")]
    pub due_date: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "change",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TodoMutation {
    Content {
        content: String,
    },
    Deadline {
        #[serde(deserialize_with = "required_date")]
        #[schemars(required, schema_with = "nullable_due_date_schema")]
        due_date: Option<String>,
    },
    Status {
        #[schemars(schema_with = "todo_status_schema")]
        status: String,
    },
    Priority {
        #[schemars(schema_with = "todo_priority_schema")]
        priority: String,
    },
    Tags {
        tag_ids: Vec<i64>,
    },
    ChildCreate {
        content: String,
        #[schemars(schema_with = "progress_date_schema")]
        progress_date: String,
        #[serde(deserialize_with = "required_date")]
        #[schemars(required, schema_with = "nullable_due_date_schema")]
        due_date: Option<String>,
    },
    ChildUpdate {
        child_id: i64,
        content: String,
        #[schemars(schema_with = "progress_date_schema")]
        progress_date: String,
        #[serde(deserialize_with = "required_date")]
        #[schemars(required, schema_with = "nullable_due_date_schema")]
        due_date: Option<String>,
        #[schemars(schema_with = "todo_status_schema")]
        status: String,
    },
    ChildDelete {
        child_id: i64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "intent",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OutputIntent {
    RecordCreate {
        scope: Scope,
        title: String,
        markdown: String,
    },
    RecordPatch {
        patch: RecordPatch,
    },
    FileCreate {
        project_id: Option<i64>,
        safe_name: String,
        utf8_content: String,
    },
    FileUpdate {
        target: ObjectRef,
        expected_version: u32,
        expected_hash: String,
        staged_content_id: String,
    },
    FilePatch {
        patch: crate::file_text_patch::FileTextPatch,
    },
    FileRestore {
        restore: crate::file_version_restore::FileVersionRestore,
    },
    TodoCreate {
        scope: Scope,
        content: String,
        priority: String,
        #[serde(deserialize_with = "required_date")]
        due_date: Option<String>,
        tag_ids: Vec<i64>,
        children: Vec<TodoNewChild>,
        dedupe_key: String,
    },
    TodoUpdate {
        target: ObjectRef,
        expected_revision: u64,
        changes: Vec<TodoMutation>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedOutput {
    pub id: String,
    pub run_id: String,
    pub ordinal: u32,
    pub revision: u64,
    pub intent: OutputIntent,
    pub sources: Vec<SourceRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInput {
    pub output_id: String,
    pub expected_output_revision: u64,
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationReceipt {
    pub operation_id: String,
    pub request_id: String,
    pub object: ObjectRef,
    pub result_revision: String,
    pub file_version: Option<u32>,
    pub undo_available: bool,
}

/// Implementations reuse existing File Version storage; stage never mutates business content.
/// All methods must validate scope and expected revisions in the shared domain service.
pub trait OutputRepository {
    fn stage(&mut self, output: &StagedOutput) -> AgentResult<()>;
    fn get_staged(&self, id: &str) -> AgentResult<Option<StagedOutput>>;
    fn receipt(&self, caller_id: &str, request_id: &str) -> AgentResult<Option<OperationReceipt>>;
}
