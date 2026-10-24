//! The small public read surface of the local bridge. Schemas come from the
//! same Rust inputs that the bridge deserializes.
use crate::{
    agent::{
        connection_operations::ConnectionOperationListInput,
        connection_todos::{ConnectionTodoCreateInput, ConnectionTodoUpdateInput},
        context::ContextGetInput,
        errors::{AgentError, AgentResult, ErrorCode},
        file_tools::{FileContentChunkInput, FileContentIdInput, FileSourceReadInput, FileVersionsGetInput, FileVersionsListInput},
        operations::{OperationGetInput, OperationUndoInput},
        outputs::RecordPatch,
        record_blocks::RecordBlocksInput,
        record_get::RecordGetInput,
        record_list::RecordListInput,
        references::ReferenceListInput,
        todo_tools::{TodoGetInput, TodoListInput},
    },
    agent::bridge::record_writes::{ConnectionRecordCreate, MutationInput, RecordCreatePreviewInput},
    db::agent_record_withdrawals::RecordRestoreInput as CreatedRecordRestoreInput,
    db::file_imports::AgentFileCreateInput,
    file_content::{FileContentBegin, FileContentUpdate},
    file_text_patch::FileTextPatch,
    file_version_restore::FileVersionRestore,
    knowledge_service::{KnowledgeGetInput, KnowledgeSearchInput},
    overview_service::OverviewReadInput,
    record_version_reads::{RecordVersionsCompareInput, RecordVersionsGetInput, RecordVersionsListInput},
    record_documents::{RecordPatchPreviewInput, RecordRestoreInput},
    source_service::{SourceReadInput, SourceSearchInput},
};
use schemars::{schema_for, JsonSchema};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProjectListInput {}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ConnectionStatusInput {}

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
            method: "connection.status",
            description: "Read this connection's current binding and native scope/operation grants. Embedded executions also report their actual executionMode; external connections report null. This snapshot does not reserve access: each operation rechecks authorization and source visibility.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(ConnectionStatusInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "project.list",
            description: "List projects visible to this connection in the bound Workspace.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(ProjectListInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "context.get",
            description: "Read bounded context for an authorized project or Workspace scope. Optional query narrows the result; budgetChars limits characters.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(ContextGetInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "context.overview.get",
            description: "Read an authorized Project Overview by section or item ID. Reuse nextCursor for continuation; version selects a revision and budgetChars limits each page.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(OverviewReadInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "knowledge.search",
            description: "Search authorized knowledge cards in a scope. Use kinds, limit, cursor and budgetChars to bound a page; source fallback may require source.search.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(KnowledgeSearchInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "knowledge.get",
            description: "Read an authorized knowledge node by nodeId and optional revision. Select view and sectionIds; continue with nextCursor within budgetChars.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(KnowledgeGetInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "source.search",
            description: "Search authorized original sources in a scope, optionally selecting objects or source kinds. Results are checked against current ownership, exclusion and revision; limit and budgetChars bound output.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(SourceSearchInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "source.read",
            description: "Read an authorized source at its current or requested revision. Choose full or range view and optional selection; continue with nextCursor within budgetChars.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(SourceReadInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "reference.list",
            description: "List current native Record, Todo, File and QuickNote links into or out of an authorized object. Hidden endpoints are omitted; continue with nextCursor, restarting if source data changes. File outgoing links are empty.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(ReferenceListInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "record.get",
            description: "Read the current body of an authorized Record with source.read. Use nextCursor and budgetChars for bounded continuation; revision can pin the source.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(RecordGetInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "record.blocks.get",
            description: "Read blocks of an authorized Record with source.read. Optionally pin revision or blockId; nextCursor and budgetChars bound the page.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(RecordBlocksInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "todo.get",
            description: "Read one authorized Todo by its object reference with source.read, subject to current scope and visibility.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(TodoGetInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "file.list",
            description: "List authorized native File metadata; detail mode returns verified extracted text with completeness/status. Filter by ids, titleQuery, contentQuery, tag and all tagIds before pagination. limit:0 counts only. totalCount counts known matches; countComplete=false and unreadableCount disclose incomplete content search. No file paths or binary bytes are returned. Workspace scope has no Files.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(RecordListInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "session.list",
            description: "List real DSH chat Sessions in one authorized scope with session.read. Supports ids, titleQuery/contentQuery substring filters, metadata/detail mode, limit:0 counts, cursor and budgetChars. Detail returns human conversation text (user/assistant/tool), excluding system prompts and non-text attachments. Sessions do not have tags. Restart on SOURCE_CHANGED.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(RecordListInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "record.list",
            description: "List native Records in metadata (default) or detail mode (complete Markdown within budget). Filter by ids, titleQuery/contentQuery substrings, exact tag label or all tagIds. Use limit:0 for counts only. totalCount covers every matching visible Record, independent of pagination; staleCount is zero (no search index). Types are text/voice. updatedAt includes metadata changes; lastEditedAt is the committed body head timestamp or null for legacy Records. Follow nextCursor for inventory; restart on SOURCE_CHANGED. record.get reads bodies.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(RecordListInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "todo.list",
            description: "List current native Todo and Subtask actions in one authorized scope with source.read. Filter each action by its own status and inclusive deadline bounds, or undated. Continue nextCursor until hasMore=false; restart on SOURCE_CHANGED. Filter by ids, titleQuery/contentQuery and inherited tag/tagIds. metadata mode bounds display text; detail returns full action text. totalCount counts all matches; limit:0 counts only.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(TodoListInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "file.versions.list",
            description: "List retained version metadata for an authorized File with source.read. Use nextCursor to page older versions and limit to bound the list.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(FileVersionsListInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "file.versions.get",
            description: "Read metadata for one retained File version ID with source.read; its version number and hash identify exact historical bytes.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(FileVersionsGetInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "file.source.read",
            description: "Read original UTF-8 bytes of an explicit registered File version with source.read. Version number and optional hash bind the read; cursor and budgetChars page the exact content.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(FileSourceReadInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "record.versions.list",
            description: "List bounded metadata for retained versions of an authorized Record with source.read. Continue with nextCursor and keep each page within budgetChars.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(RecordVersionsListInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "record.versions.get",
            description: "Read one retained Record version's metadata and the precise source.read target for its body; this read does not restore a version.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(RecordVersionsGetInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "record.versions.compare",
            description: "Compare two retained Record revisions by bounded block ID differences. Continue with nextCursor within budgetChars; this read does not restore either version.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(RecordVersionsCompareInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "record.create",
            description: "Create one Record in the explicitly granted scope with content.create. Supply a stable requestId for safe retry; the native service validates canonical document or Markdown and metadata.",
            read_only: false,
            parameters: serde_json::to_value(schema_for!(MutationInput<ConnectionRecordCreate>)).expect("static schema"),
        },
        RegisteredMethod {
            method: "record.create.preview",
            description: "Validate and preview a new Record from canonical document or Markdown with content.create permission. budgetChars bounds text; no object, version or receipt is written. Creation revalidates the input.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(RecordCreatePreviewInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "record.patch",
            description: "Apply a bounded block patch to an authorized Record with record.patch. Supply baseRevision and stable requestId; the native service checks the current revision.",
            read_only: false,
            parameters: serde_json::to_value(schema_for!(RecordPatch)).expect("static schema"),
        },
        RegisteredMethod {
            method: "record.patch.preview",
            description: "Preview a block patch against a saved Record with record.patch permission. No editor flush, version or receipt is written. budgetChars bounds preview text; applying the patch rechecks the current revision.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(RecordPatchPreviewInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "record.restore",
            description: "Restore the body of an authorized Record from an exact retained version with record.restore. Supply baseRevision and stable requestId; this creates a new version.",
            read_only: false,
            parameters: serde_json::to_value(schema_for!(MutationInput<RecordRestoreInput>)).expect("static schema"),
        },
        RegisteredMethod {
            method: "operation.get",
            description: "Read one operation receipt owned by this connection with operation.read. This does not grant access to another caller's results.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(OperationGetInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "operation.list",
            description: "List this connection's operation receipts within an authorized scope with operation.read. Cursor, limit and budgetChars bound each page.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(ConnectionOperationListInput)).expect("static schema"),
        },
        RegisteredMethod {
            method: "operation.undo",
            description: "Undo one operation owned by this connection with operation.undo. Supply expectedHeadRevision and stable requestId; current heads are checked before commit.",
            read_only: false,
            parameters: serde_json::to_value(schema_for!(MutationInput<OperationUndoInput>)).expect("static schema"),
        },
        RegisteredMethod {
            method: "operation.restore_created",
            description: "Recover this connection's withdrawn newly created Record with the derived operation.restore_created permission. Supply expectedWithdrawalRevision and stable requestId.",
            read_only: false,
            parameters: serde_json::to_value(schema_for!(MutationInput<CreatedRecordRestoreInput>)).expect("static schema"),
        },
        RegisteredMethod {
            method: "todo.create",
            description: "Create one Todo in an authorized scope with content.create. Supply explicit nullable dates, child actions and a stable requestId; the native service validates the input.",
            read_only: false,
            parameters: serde_json::to_value(schema_for!(MutationInput<ConnectionTodoCreateInput>)).expect("static schema"),
        },
        RegisteredMethod {
            method: "todo.update",
            description: "Update one authorized Todo with todo.update and an expectedRevision. Supply exact changes and a stable requestId; the native service checks revision and ownership.",
            read_only: false,
            parameters: serde_json::to_value(schema_for!(MutationInput<ConnectionTodoUpdateInput>)).expect("static schema"),
        },
        RegisteredMethod {
            method: "file.create",
            description: "Create one UTF-8 File in an authorized Project with content.create. Supply safeName, source text and a stable requestId; the native File importer owns paths and versions.",
            read_only: false,
            parameters: serde_json::to_value(schema_for!(MutationInput<AgentFileCreateInput>)).expect("static schema"),
        },
        RegisteredMethod {
            method: "file.patch",
            description: "Patch exact source text of an authorized File with file.update. Supply expected version and content hash plus a stable requestId; native recovery requestId prefixes are reserved.",
            read_only: false,
            parameters: serde_json::to_value(schema_for!(MutationInput<FileTextPatch>)).expect("static schema"),
        },
        RegisteredMethod {
            method: "file.version.restore",
            description: "Restore an authorized File from one retained version with file.restore. Supply expected version and hash plus a stable requestId; restore creates a new version.",
            read_only: false,
            parameters: serde_json::to_value(schema_for!(MutationInput<FileVersionRestore>)).expect("static schema"),
        },
        RegisteredMethod {
            method: "file.update",
            description: "Commit a fully staged replacement for an authorized File with file.update. Supply the stagedContentId, expected version and hash, and a stable requestId.",
            read_only: false,
            parameters: serde_json::to_value(schema_for!(MutationInput<FileContentUpdate>)).expect("static schema"),
        },
        RegisteredMethod {
            method: "file.content.begin",
            description: "Begin server-owned staging of bounded replacement File bytes. Supply expected version and hashes, exact byte length and stable requestId; this does not commit a File version.",
            read_only: false,
            parameters: serde_json::to_value(schema_for!(MutationInput<FileContentBegin>)).expect("static schema"),
        },
        RegisteredMethod {
            method: "file.content.chunk",
            description: "Append one base64 File chunk at the exact received offset to an authorized stage. Each chunk is at most 1 MiB; supply stable requestId for retry.",
            read_only: false,
            parameters: serde_json::to_value(schema_for!(MutationInput<FileContentChunkInput>)).expect("static schema"),
        },
        RegisteredMethod {
            method: "file.content.complete",
            description: "Verify the staged File length and hash, making the ticket ready for file.update. This does not commit a version; supply stable requestId.",
            read_only: false,
            parameters: serde_json::to_value(schema_for!(MutationInput<FileContentIdInput>)).expect("static schema"),
        },
        RegisteredMethod {
            method: "file.content.status",
            description: "Read an authorized staging ticket's received length, readiness and consumption state by stagedContentId.",
            read_only: true,
            parameters: serde_json::to_value(schema_for!(FileContentIdInput)).expect("static schema"),
        },
    ]
}

pub fn schema(method: &str) -> Option<Value> {
    registered_methods().into_iter().find(|entry| entry.method == method).map(|entry| entry.parameters)
}

pub fn is_registered(method: &str) -> bool {
    is_read_only(method).is_some()
}

pub fn is_read_only(method: &str) -> Option<bool> {
    match method {
        "connection.status" | "project.list" | "context.get" | "context.overview.get" | "knowledge.search"
        | "knowledge.get" | "source.search" | "source.read"
        | "reference.list" | "record.get" | "record.blocks.get" | "todo.get" | "todo.list" | "record.list" | "file.list" | "session.list"
        | "file.versions.list" | "file.versions.get" | "file.source.read"
        | "record.versions.list" | "record.versions.get" | "record.versions.compare"
        | "operation.get" | "operation.list" | "file.content.status" | "record.patch.preview" | "record.create.preview" => Some(true),
        "record.create" | "record.patch" | "record.restore" | "operation.undo"
        | "operation.restore_created" | "todo.create" | "todo.update"
        | "file.create" | "file.patch" | "file.version.restore" | "file.update"
        | "file.content.begin" | "file.content.chunk" | "file.content.complete" => Some(false),
        _ => None,
    }
}

/// Validate exactly the DTO that dispatch will consume, plus the shared read
/// bounds used by the built-in tool adapter.
pub fn validate(method: &str, parameters: &Value) -> AgentResult<()> {
    fn decode<T: serde::de::DeserializeOwned>(parameters: &Value) -> AgentResult<()> {
        serde_json::from_value::<T>(parameters.clone())
            .map(|_| ())
            .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Arguments do not match the method input DTO"))
    }
    if method == "record.get" {
        crate::agent::tools::validate_bounds("source.read", parameters)?;
    } else if matches!(method, "context.get" | "context.overview.get" | "knowledge.search" | "knowledge.get" | "source.search" | "source.read") {
        crate::agent::tools::validate_bounds(method, parameters)?;
    }
    let decoded = match method {
        "connection.status" => decode::<ConnectionStatusInput>(parameters),
        "project.list" => decode::<ProjectListInput>(parameters),
        "context.get" => decode::<ContextGetInput>(parameters),
        "context.overview.get" => decode::<OverviewReadInput>(parameters),
        "knowledge.search" => decode::<KnowledgeSearchInput>(parameters),
        "knowledge.get" => decode::<KnowledgeGetInput>(parameters),
        "source.search" => decode::<SourceSearchInput>(parameters),
        "source.read" => decode::<SourceReadInput>(parameters),
        "reference.list" => decode::<ReferenceListInput>(parameters),
        "record.get" => decode::<RecordGetInput>(parameters),
        "record.blocks.get" => decode::<RecordBlocksInput>(parameters),
        "todo.get" => decode::<TodoGetInput>(parameters),
        "record.list" | "file.list" | "session.list" => decode::<RecordListInput>(parameters),
        "todo.list" => decode::<TodoListInput>(parameters),
        "file.versions.list" => decode::<FileVersionsListInput>(parameters),
        "file.versions.get" => decode::<FileVersionsGetInput>(parameters),
        "file.source.read" => decode::<FileSourceReadInput>(parameters),
        "record.versions.list" => decode::<RecordVersionsListInput>(parameters),
        "record.versions.get" => decode::<RecordVersionsGetInput>(parameters),
        "record.versions.compare" => decode::<RecordVersionsCompareInput>(parameters),
        "record.create" => decode::<MutationInput<ConnectionRecordCreate>>(parameters),
        "record.create.preview" => decode::<RecordCreatePreviewInput>(parameters),
        "record.patch" => decode::<RecordPatch>(parameters),
        "record.patch.preview" => decode::<RecordPatchPreviewInput>(parameters),
        "record.restore" => decode::<MutationInput<RecordRestoreInput>>(parameters),
        "operation.get" => decode::<OperationGetInput>(parameters),
        "operation.list" => decode::<ConnectionOperationListInput>(parameters),
        "operation.undo" => decode::<MutationInput<OperationUndoInput>>(parameters),
        "operation.restore_created" => decode::<MutationInput<CreatedRecordRestoreInput>>(parameters),
        "todo.create" => decode::<MutationInput<ConnectionTodoCreateInput>>(parameters),
        "todo.update" => decode::<MutationInput<ConnectionTodoUpdateInput>>(parameters),
        "file.create" => decode::<MutationInput<AgentFileCreateInput>>(parameters),
        "file.patch" => decode::<MutationInput<FileTextPatch>>(parameters),
        "file.version.restore" => decode::<MutationInput<FileVersionRestore>>(parameters),
        "file.update" => decode::<MutationInput<FileContentUpdate>>(parameters),
        "file.content.begin" => decode::<MutationInput<FileContentBegin>>(parameters),
        "file.content.chunk" => decode::<MutationInput<FileContentChunkInput>>(parameters),
        "file.content.complete" => decode::<MutationInput<FileContentIdInput>>(parameters),
        "file.content.status" => decode::<FileContentIdInput>(parameters),
        _ => Err(AgentError::new(ErrorCode::ToolCallUnsupported, "Method is not registered")),
    };
    decoded?;
    if is_read_only(method) == Some(false)
        && !parameters
            .get("requestId")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty() && id.len() <= 128)
    {
        return Err(AgentError::new(ErrorCode::InvalidArgument, "Invalid mutation requestId"));
    }
    if method.starts_with("file.")
        && is_read_only(method) == Some(false)
        && parameters
            .get("requestId")
            .and_then(Value::as_str)
            .is_some_and(|id| {
                ["fileundo:", "filechainundo:", "creationundo:"]
                    .iter()
                    .any(|prefix| id.starts_with(prefix))
            })
    {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "File mutation requestId uses a reserved recovery prefix",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::models::Scope;
    #[test]
    fn registry_contains_only_exposed_methods() {
        assert_eq!(registered_methods().iter().map(|x| x.method).collect::<Vec<_>>(), vec![
            "connection.status", "project.list", "context.get", "context.overview.get", "knowledge.search",
            "knowledge.get", "source.search", "source.read",
            "reference.list", "record.get", "record.blocks.get", "todo.get", "file.list", "session.list", "record.list", "todo.list",
            "file.versions.list", "file.versions.get", "file.source.read",
            "record.versions.list", "record.versions.get", "record.versions.compare",
            "record.create", "record.create.preview", "record.patch", "record.patch.preview", "record.restore", "operation.get",
            "operation.list", "operation.undo", "operation.restore_created",
            "todo.create", "todo.update",
            "file.create", "file.patch", "file.version.restore", "file.update",
            "file.content.begin", "file.content.chunk", "file.content.complete",
            "file.content.status",
        ]);
        assert!(registered_methods().iter().all(|entry| is_read_only(entry.method) == Some(entry.read_only)));
        for method in ["session.search", "session.messages.read", "session.read", "session.create", "run.start", "run.cancel"] {
            assert!(!is_registered(method), "{method}");
            assert!(schema(method).is_none(), "{method}");
            assert_eq!(validate(method, &serde_json::json!({})).unwrap_err().code, ErrorCode::ToolCallUnsupported);
        }

        assert_eq!(is_read_only("record.patch"), Some(false));
        assert_eq!(is_read_only("operation.list"), Some(true));
        assert_eq!(is_read_only("file.content.begin"), Some(false));
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

    #[test]
    fn expanded_schemas_follow_the_deserialized_inputs() {
        let scope = serde_json::json!({"kind":"project","projectId":1});
        let object = serde_json::json!({"workspaceId":"workspace-a","scope":scope,"kind":"project","id":"1"});
        let cases = [
            ("context.overview.get", serde_json::json!({"scope":scope,"sections":["profile"],"budgetChars":4000})),
            ("knowledge.search", serde_json::json!({"scope":scope,"query":"research","limit":8})),
            ("knowledge.get", serde_json::json!({"scope":scope,"nodeId":"node:topic","view":"summary"})),
            ("source.search", serde_json::json!({"scope":scope,"query":"research","selected":[object]})),
            ("source.read", serde_json::json!({"source":{"object":object},"view":"full"})),
        ];
        for (method, value) in cases {
            validate(method, &value).unwrap();
            let schema = schema(method).unwrap();
            let fields = schema["properties"].as_object().unwrap();
            assert!(value.as_object().unwrap().keys().all(|name| fields.contains_key(name)), "{method}");
            assert_eq!(schema["additionalProperties"], false, "{method}");
        }
    }

    #[test]
    fn registry_rejects_unknown_fields_and_shared_bounds() {
        assert_eq!(validate("project.list", &serde_json::json!({"limit":1})).unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(validate("knowledge.search", &serde_json::json!({"scope":{"kind":"workspace"},"query":"x","budgetChars":3001})).unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(validate("source.search", &serde_json::json!({"scope":{"kind":"workspace"},"query":"x","selected":[{"kind":"project"}]})).unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(validate("record.create", &serde_json::json!({})).unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(validate("file.update", &serde_json::json!({})).unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(validate("file.delete", &serde_json::json!({})).unwrap_err().code, ErrorCode::ToolCallUnsupported);
    }

    #[test]
    fn second_read_batch_schemas_use_real_dtos() {
        let scope = serde_json::json!({"kind":"project","projectId":1});
        let object = |kind| serde_json::json!({"workspaceId":"workspace-a","scope":scope,"kind":kind,"id":"1"});
        let cases = [
            ("reference.list", serde_json::json!({"object":object("record"),"direction":"incoming","limit":20,"budgetChars":4000})),
            ("record.get", serde_json::json!({"object":object("record"),"budgetChars":4000})),
            ("record.blocks.get", serde_json::json!({"object":object("record"),"budgetChars":4000})),
            ("todo.get", serde_json::json!({"target":object("todo")})),
            ("file.versions.list", serde_json::json!({"object":object("file"),"limit":10})),
            ("file.versions.get", serde_json::json!({"object":object("file"),"versionId":"version-1"})),
            ("file.source.read", serde_json::json!({"object":object("file"),"versionNumber":1,"budgetChars":4000})),
        ];
        for (method, value) in cases {
            validate(method, &value).unwrap();
            let schema = schema(method).unwrap();
            assert_eq!(schema["additionalProperties"], false, "{method}");
            let fields = schema["properties"].as_object().unwrap();
            assert!(value.as_object().unwrap().keys().all(|name| fields.contains_key(name)), "{method}");
        }
        assert_eq!(validate("file.versions.list", &serde_json::json!({"object":object("file"),"path":"/tmp/file"})).unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(validate("reference.list", &serde_json::json!({"object":object("record"),"direction":"sideways"})).unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(validate("reference.list", &serde_json::json!({"object":object("record"),"direction":"outgoing","includeKnowledge":true})).unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(is_read_only("reference.list"), Some(true));
        assert_eq!(validate("record.get", &serde_json::json!({"object":object("record"),"recordVersion":1})).unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(validate("record.get", &serde_json::json!({"object":object("record"),"budgetChars":12001})).unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(is_read_only("record.get"), Some(true));
        assert!(!is_registered("record.delete"));
        assert!(!is_registered("file.delete"));
    }

    #[test]
    fn record_version_schemas_follow_the_real_read_inputs() {
        let record = serde_json::json!({
            "workspaceId":"workspace-a",
            "scope":{"kind":"project","projectId":1},
            "kind":"record",
            "id":"1"
        });
        let before = "a".repeat(32);
        let after = "b".repeat(32);
        let cases = [
            ("record.versions.list", serde_json::json!({"object":record,"limit":8,"budgetChars":4000})),
            ("record.versions.get", serde_json::json!({"object":record,"versionId":before,"budgetChars":4000})),
            ("record.versions.compare", serde_json::json!({"object":record,"beforeVersionId":before,"afterVersionId":after,"budgetChars":4000})),
        ];
        for (method, value) in cases {
            validate(method, &value).unwrap();
            let schema = schema(method).unwrap();
            assert_eq!(schema["additionalProperties"], false, "{method}");
            let fields = schema["properties"].as_object().unwrap();
            assert!(value.as_object().unwrap().keys().all(|name| fields.contains_key(name)), "{method}");
        }
        assert_eq!(validate("record.versions.get", &serde_json::json!({"object":record,"versionId":before,"restore":true})).unwrap_err().code, ErrorCode::InvalidArgument);
        assert!(!is_registered("file.delete"));
    }

    #[test]
    fn write_schemas_are_native_and_require_stable_request_identity() {
        for method in [
            "reference.list", "record.get", "record.create", "record.create.preview", "record.patch", "record.patch.preview", "record.restore", "operation.get",
            "operation.list", "operation.undo", "operation.restore_created",
            "todo.create", "todo.update",
            "file.create", "file.patch", "file.version.restore", "file.update",
            "file.content.begin", "file.content.chunk", "file.content.complete",
            "file.content.status",
        ] {
            let schema = schema(method).unwrap();
            assert_eq!(schema["additionalProperties"], false, "{method}");
            assert!(schema["properties"].is_object(), "{method}");
        }
        let patch = |request_id: Value| serde_json::json!({
            "record":{"workspaceId":"workspace-a","scope":{"kind":"project","projectId":1},"kind":"record","id":"1"},
            "baseRevision":1,
            "requestId":request_id,
            "operations":[]
        });
        assert!(validate("record.patch", &patch(serde_json::json!("stable-1"))).is_ok());
        for bad in [serde_json::json!(""), serde_json::json!("x".repeat(129)), serde_json::json!(7)] {
            assert_eq!(validate("record.patch", &patch(bad)).unwrap_err().code, ErrorCode::InvalidArgument);
        }
        let mut missing = patch(serde_json::json!("stable-1"));
        missing.as_object_mut().unwrap().remove("requestId");
        assert_eq!(validate("record.patch", &missing).unwrap_err().code, ErrorCode::InvalidArgument);
        assert!(!is_registered("file.delete"));
    }

    #[test]
    fn record_creation_accepts_one_content_format_and_preview_has_no_mutation_id() {
        let input = serde_json::json!({"scope":{"kind":"workspace"},"title":"Plan","tagIds":[],"markdown":"# Plan","codeLanguage":null});
        validate("record.create", &serde_json::json!({"requestId":"stable", "input":input})).unwrap();
        validate("record.create.preview", &serde_json::json!({"input":input})).unwrap();
        let mut ambiguous = input.clone();
        ambiguous["document"] = serde_json::json!({"type":"doc","content":[]});
        assert!(validate("record.create.preview", &serde_json::json!({"input":ambiguous})).is_err());
        assert!(validate("record.create.preview", &serde_json::json!({"input":input,"requestId":"write-id"})).is_err());
        assert_eq!(is_read_only("record.create.preview"), Some(true));
    }

    #[test]
    fn todo_write_schemas_require_native_fields_and_stable_identity() {
        let scope = serde_json::json!({"kind":"project","projectId":1});
        let target = serde_json::json!({
            "workspaceId":"workspace-a","scope":scope,"kind":"todo","id":"1"
        });
        let create = serde_json::json!({
            "requestId":"todo-create-1",
            "input":{"scope":scope,"content":"Follow up","priority":"normal",
                "dueDate":null,"tagIds":[],"children":[]}
        });
        let update = serde_json::json!({
            "requestId":"todo-update-1",
            "input":{"target":target,"expectedRevision":1,
                "changes":[{"change":"deadline","dueDate":null}]}
        });
        for (method, value) in [("todo.create", &create), ("todo.update", &update)] {
            assert_eq!(is_read_only(method), Some(false));
            validate(method, value).unwrap();
            let schema = schema(method).unwrap();
            assert_eq!(schema["additionalProperties"], false);
            assert!(schema["properties"]["requestId"].is_object());
            assert!(schema["properties"]["input"].is_object());
        }
        let mut without_date = create.clone();
        without_date["input"].as_object_mut().unwrap().remove("dueDate");
        assert_eq!(validate("todo.create", &without_date).unwrap_err().code, ErrorCode::InvalidArgument);
        let mut without_children = create.clone();
        without_children["input"].as_object_mut().unwrap().remove("children");
        assert_eq!(validate("todo.create", &without_children).unwrap_err().code, ErrorCode::InvalidArgument);
        let mut without_revision = update.clone();
        without_revision["input"].as_object_mut().unwrap().remove("expectedRevision");
        assert_eq!(validate("todo.update", &without_revision).unwrap_err().code, ErrorCode::InvalidArgument);
        let mut unknown = update.clone();
        unknown["input"]["runId"] = serde_json::json!("forged");
        assert_eq!(validate("todo.update", &unknown).unwrap_err().code, ErrorCode::InvalidArgument);
    }

    #[test]
    fn file_schemas_use_native_dtos_and_exact_transport_fields() {
        let file = serde_json::json!({
            "workspaceId":"workspace-a","scope":{"kind":"project","projectId":1},
            "kind":"file","id":"1"
        });
        let hash = format!("sha256:{}", "a".repeat(64));
        let stage = "b".repeat(32);
        let cases = [
            ("file.create", serde_json::json!({"requestId":"file-create-1","input":{
                "projectId":1,"safeName":"notes.txt","utf8Content":"Original text"}})),
            ("file.patch", serde_json::json!({"requestId":"file-patch-1","input":{
                "object":file,"expectedVersionNumber":1,"expectedContentHash":hash,
                "edits":null,"appendText":" next"}})),
            ("file.version.restore", serde_json::json!({"requestId":"file-restore-1","input":{
                "object":file,"versionId":"1","expectedVersionNumber":2,"expectedContentHash":hash}})),
            ("file.update", serde_json::json!({"requestId":"file-update-1","input":{
                "object":file,"expectedVersionNumber":1,"expectedContentHash":hash,
                "stagedContentId":stage}})),
            ("file.content.begin", serde_json::json!({"requestId":"file-begin-1","input":{
                "object":file,"expectedVersionNumber":1,"expectedContentHash":hash,
                "length":3,"contentHash":hash}})),
            ("file.content.chunk", serde_json::json!({"requestId":"file-chunk-1","input":{
                "stagedContentId":stage,"offset":0,"dataBase64":"YWJj"}})),
            ("file.content.complete", serde_json::json!({"requestId":"file-complete-1","input":{
                "stagedContentId":stage}})),
            ("file.content.status", serde_json::json!({"stagedContentId":stage})),
        ];
        for (method, value) in cases {
            validate(method, &value).unwrap();
            let schema = schema(method).unwrap();
            assert_eq!(schema["additionalProperties"], false, "{method}");
            assert_eq!(is_read_only(method), Some(method == "file.content.status"));
            assert!(value.as_object().unwrap().keys().all(|name| schema["properties"].get(name).is_some()), "{method}");
        }
        assert_eq!(validate("file.content.chunk", &serde_json::json!({"requestId":"x","input":{"stagedContentId":stage,"offset":0,"bytesBase64":"YWJj"}})).unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(validate("file.content.status", &serde_json::json!({"stagedContentId":stage,"requestId":"forged"})).unwrap_err().code, ErrorCode::InvalidArgument);
    }

    #[test]
    fn file_mutations_reject_native_recovery_request_ids() {
        let patch = |request_id: &str| serde_json::json!({
            "requestId":request_id,
            "input":{
                "object":{"workspaceId":"workspace-a","scope":{"kind":"project","projectId":1},"kind":"file","id":"1"},
                "expectedVersionNumber":1,
                "expectedContentHash":format!("sha256:{}", "a".repeat(64)),
                "edits":null,
                "appendText":" next"
            }
        });
        for id in ["fileundo:old", "filechainundo:old", "creationundo:old"] {
            assert_eq!(validate("file.patch", &patch(id)).unwrap_err().code, ErrorCode::InvalidArgument);
        }
        assert!(validate("file.patch", &patch("file-patch-1")).is_ok());
        assert!(validate("file.patch", &patch("output:prior-receipt")).is_ok());
    }
}
