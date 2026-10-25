//! Argument handling and JSON output for local bridge commands.
use super::{client::BridgeClient, mcp::MindMcp, registry};
use crate::agent::{
    capabilities::capabilities,
    context::ContextGetInput,
    errors::{AgentError, AgentResult, ApiResponse, ErrorCode},
    models::{Scope, WorkspaceBinding},
};
use crate::db::file_imports::{validate_agent_file_create, AgentFileCreateInput};
use serde_json::{json, Value};
use std::{
    io::Read,
    path::{Path, PathBuf},
};
#[path = "cli_upload.rs"]
mod cli_upload;
#[path = "cli_help.rs"]
mod cli_help;
use cli_help::HELP;

const MAX_INPUT_BYTES: u64 = 2 * 1024 * 1024;

pub struct CliOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Default)]
struct Options {
    workspace: Option<PathBuf>,
    connection: Option<String>,
    project: Option<i64>,
    workspace_scope: bool,
    query: Option<String>,
    budget_chars: Option<usize>,
    request_id: Option<String>,
    input_file: Option<String>,
    out: Option<String>,
    patch_file: Option<String>,
    body_file: Option<String>,
    name: Option<String>,
    title: Option<String>,
    priority: Option<String>,
    due_date: Option<String>,
    object_id: Option<String>,
    version_id: Option<String>,
    base_revision: Option<u64>,
    source_file: Option<String>,
    expected_version: Option<u32>,
    expected_hash: Option<String>,
    revision: Option<String>,
    cursor: Option<String>,
    kind: Option<String>,
    direction: Option<String>,
    limit: Option<usize>,
    dry_run: bool,
    json: bool,
    help: bool,
    verbose: bool,
}

fn invalid(message: &'static str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}

fn parse_options(args: &[String]) -> AgentResult<Options> {
    let mut options = Options::default();
    let mut cursor = 0;
    while cursor < args.len() {
        let flag = args[cursor].as_str();
        if flag == "--json" {
            if options.json { return Err(invalid("Duplicate --json")); }
            options.json = true;
            cursor += 1;
            continue;
        }
        if flag == "--workspace-scope" {
            if options.workspace_scope { return Err(invalid("Duplicate --workspace-scope")); }
            options.workspace_scope = true;
            cursor += 1;
            continue;
        }
        if flag == "--dry-run" {
            if options.dry_run { return Err(invalid("Duplicate --dry-run")); }
            options.dry_run = true;
            cursor += 1;
            continue;
        }
        if flag == "--help" || flag == "--verbose" {
            let option = if flag == "--help" { &mut options.help } else { &mut options.verbose };
            if *option { return Err(invalid("Duplicate option")); }
            *option = true;
            cursor += 1;
            continue;
        }
        if !matches!(flag, "--workspace" | "--connection" | "--project" | "--query"
            | "--budget-chars" | "--request-id" | "--input-file" | "--patch-file"
            | "--body-file" | "--name" | "--title" | "--priority" | "--due-date"
            | "--id" | "--version" | "--base-revision" | "--source-file"
            | "--expected-version" | "--expected-hash" | "--revision" | "--cursor"
            | "--kind" | "--direction" | "--limit" | "--out") {
            return Err(AgentError::new(ErrorCode::InvalidArgument, format!("Unknown option: {flag}")));
        }
        let value = args.get(cursor + 1).ok_or_else(|| invalid("Missing option value"))?;
        if value.starts_with("--") { return Err(invalid("Missing option value")); }
        match flag {
            "--workspace" if options.workspace.is_none() => options.workspace = Some(PathBuf::from(value)),
            "--connection" if options.connection.is_none() => options.connection = Some(value.clone()),
            "--project" if options.project.is_none() => {
                let id = value.parse::<i64>().map_err(|_| invalid("Invalid project ID"))?;
                if id <= 0 { return Err(invalid("Invalid project ID")); }
                options.project = Some(id);
            }
            "--query" if options.query.is_none() => options.query = Some(value.clone()),
            "--budget-chars" if options.budget_chars.is_none() => {
                let budget = value.parse::<usize>().map_err(|_| invalid("Invalid character budget"))?;
                if !(1..=12000).contains(&budget) { return Err(invalid("Invalid character budget")); }
                options.budget_chars = Some(budget);
            }
            "--request-id" if options.request_id.is_none() && !value.is_empty() => options.request_id = Some(value.clone()),
            "--out" if options.out.is_none() => options.out = Some(value.clone()),
            "--input-file" if options.input_file.is_none() => options.input_file = Some(value.clone()),
            "--patch-file" if options.patch_file.is_none() => options.patch_file = Some(value.clone()),
            "--body-file" if options.body_file.is_none() => options.body_file = Some(value.clone()),
            "--name" if options.name.is_none() => options.name = Some(value.clone()),
            "--title" if options.title.is_none() => options.title = Some(value.clone()),
            "--priority" if options.priority.is_none() => options.priority = Some(value.clone()),
            "--due-date" if options.due_date.is_none() => options.due_date = Some(value.clone()),
            "--id" if options.object_id.is_none() => options.object_id = Some(value.clone()),
            "--version" if options.version_id.is_none() => options.version_id = Some(value.clone()),
            "--base-revision" if options.base_revision.is_none() => {
                let revision = value.parse::<u64>().map_err(|_| invalid("Invalid base revision"))?;
                if revision == 0 { return Err(invalid("Invalid base revision")); }
                options.base_revision = Some(revision);
            }
            "--source-file" if options.source_file.is_none() => options.source_file = Some(value.clone()),
            "--expected-version" if options.expected_version.is_none() => {
                let version = value.parse::<u32>().map_err(|_| invalid("Invalid expected version"))?;
                if version == 0 { return Err(invalid("Invalid expected version")); }
                options.expected_version = Some(version);
            }
            "--expected-hash" if options.expected_hash.is_none() => options.expected_hash = Some(value.clone()),
            "--revision" if options.revision.is_none() => options.revision = Some(value.clone()),
            "--cursor" if options.cursor.is_none() => options.cursor = Some(value.clone()),
            "--kind" if options.kind.is_none() => options.kind = Some(value.clone()),
            "--direction" if options.direction.is_none() => options.direction = Some(value.clone()),
            "--limit" if options.limit.is_none() => {
                let limit = value.parse::<usize>().map_err(|_| invalid("Invalid reference limit"))?;
                if limit > 50 { return Err(invalid("Invalid reference limit")); }
                options.limit = Some(limit);
            }
            _ => return Err(invalid("Unknown or duplicate option")),
        }
        cursor += 2;
    }
    if !options.json && !options.help { return Err(invalid("This command requires --json")); }
    Ok(options)
}

fn required_connection(options: &Options) -> AgentResult<(&PathBuf, &str)> {
    let workspace = options.workspace.as_ref().ok_or_else(|| invalid("--workspace is required"))?;
    let connection = options.connection.as_deref().ok_or_else(|| invalid("--connection is required"))?;
    if connection.len() != 32 || !connection.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid("Invalid connection ID"));
    }
    Ok((workspace, connection))
}

fn exit_code(error: &AgentError) -> i32 {
    match error.code {
        ErrorCode::InvalidArgument | ErrorCode::InvalidPatch => 2,
        ErrorCode::ScopeDenied | ErrorCode::SecretsLocked => 4,
        ErrorCode::WorkspaceNotOpen | ErrorCode::WorkspaceChanged | ErrorCode::RuntimeUnavailable | ErrorCode::RuntimeIncompatible => 3,
        ErrorCode::RevisionConflict | ErrorCode::IdempotencyConflict | ErrorCode::SourceChanged | ErrorCode::FileChangedUnregistered | ErrorCode::UndoConflict | ErrorCode::ObjectWithdrawn => 5,
        ErrorCode::Cancelled => 130,
        _ => 6,
    }
}

fn response(request_id: String, result: AgentResult<Value>) -> CliOutput {
    let code = result.as_ref().err().map(exit_code).unwrap_or(0);
    let diagnostic = result.as_ref().err().map(|error| format!("{}: {}\n", serde_json::to_value(error.code).unwrap().as_str().unwrap(), error.message)).unwrap_or_default();
    CliOutput {
        stdout: format!("{}\n", serde_json::to_string(&ApiResponse::from_result(request_id, result)).expect("response JSON")),
        stderr: diagnostic,
        exit_code: code,
    }
}

fn request_id() -> String { format!("cli-{:032x}", rand::random::<u128>()) }

fn parse_input(source: impl Read) -> AgentResult<Value> {
    let mut bytes = Vec::new();
    source.take(MAX_INPUT_BYTES + 1).read_to_end(&mut bytes)
        .map_err(|_| invalid("Cannot read --input-file"))?;
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err(invalid("--input-file exceeds 2 MiB"));
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid("--input-file must contain valid JSON"))
}

fn read_input(path: &str) -> AgentResult<Value> {
    let source: Box<dyn Read> = if path == "-" {
        Box::new(std::io::stdin())
    } else {
        Box::new(std::fs::File::open(path).map_err(|_| invalid("Cannot read --input-file"))?)
    };
    parse_input(source)
}

fn read_text_body(path: &str) -> AgentResult<String> {
    let source: Box<dyn Read> = if path == "-" {
        Box::new(std::io::stdin())
    } else {
        Box::new(std::fs::File::open(path).map_err(|_| invalid("Cannot read --body-file"))?)
    };
    let mut bytes = Vec::new();
    source.take(MAX_INPUT_BYTES + 1).read_to_end(&mut bytes)
        .map_err(|_| invalid("Cannot read --body-file"))?;
    if bytes.len() as u64 > MAX_INPUT_BYTES { return Err(invalid("--body-file exceeds 2 MiB")); }
    String::from_utf8(bytes).map_err(|_| invalid("--body-file must contain UTF-8 text"))
}

fn bounded_generated_params(params: Value) -> AgentResult<Value> {
    if serde_json::to_vec(&params).expect("generated input JSON").len() as u64 > MAX_INPUT_BYTES {
        return Err(invalid("Generated input exceeds 2 MiB"));
    }
    Ok(params)
}

fn scoped(options: &Options) -> AgentResult<Scope> {
    match (options.project, options.workspace_scope) {
        (Some(project_id), false) => Ok(Scope::Project { project_id }),
        (None, true) => Ok(Scope::Workspace),
        _ => Err(invalid("Choose exactly one of --project or --workspace-scope")),
    }
}

fn reject_scope_options(options: &Options) -> AgentResult<()> {
    if options.project.is_some() || options.workspace_scope || options.query.is_some() || options.budget_chars.is_some() {
        Err(invalid("Scope, query and budget options cannot accompany --input-file"))
    } else {
        Ok(())
    }
}

fn write_request_id(options: &Options, params: &Value) -> AgentResult<String> {
    let payload_id = params.get("requestId").and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .ok_or_else(|| invalid("Write input requires requestId"))?;
    if options.request_id.as_deref().is_some_and(|id| id != payload_id) {
        return Err(invalid("--request-id must match input requestId"));
    }
    Ok(payload_id.to_owned())
}

fn preview_patch_params(mut params: Value, budget_chars: Option<usize>) -> AgentResult<Value> {
    let object = params.as_object_mut().ok_or_else(|| invalid("--patch-file must contain a RecordPatch JSON object"))?;
    object.remove("requestId");
    if let Some(budget) = budget_chars { object.insert("budgetChars".into(), json!(budget)); }
    Ok(params)
}

fn preview_create_params(params: Value, budget_chars: Option<usize>) -> AgentResult<Value> {
    let mut object = params.as_object().ok_or_else(|| invalid("Record create input must be a JSON object"))?.clone();
    if object.keys().any(|key| key != "requestId" && key != "input") {
        return Err(invalid("Record create preview accepts only input and optional requestId"));
    }
    if object.get("requestId").is_some_and(|id| !id.is_string()) {
        return Err(invalid("Record create requestId must be a string"));
    }
    let input = object.remove("input").ok_or_else(|| invalid("Record create preview requires input"))?;
    let mut preview = json!({"input": input});
    if let Some(budget) = budget_chars { preview["budgetChars"] = json!(budget); }
    Ok(preview)
}

fn bridge_method(command: &str, dry_run: bool) -> &str {
    match (command, dry_run) {
        ("doctor", _) => "connection.status",
        ("search", _) => "source.search",
        ("record.patch", true) => "record.patch.preview",
        ("record.create", true) => "record.create.preview",
        _ => command,
    }
}

fn record_create_params(options: &Options) -> AgentResult<Value> {
    if options.name.is_some() || options.query.is_some() || options.priority.is_some() || options.due_date.is_some() {
        return Err(invalid("Record creation accepts --title, scope and --body-file"));
    }
    if !options.dry_run && options.budget_chars.is_some() {
        return Err(invalid("--budget-chars is only supported by record create --dry-run"));
    }
    let scope = scoped(options)?;
    let title = options.title.as_deref().ok_or_else(|| invalid("--title is required for record create"))?;
    let request_id = if options.dry_run { None } else {
        Some(options.request_id.as_deref().ok_or_else(|| invalid("--request-id is required for record create"))?)
    };
    let markdown = read_text_body(options.body_file.as_deref().ok_or_else(|| invalid("--body-file is required"))?)?;
    if markdown.len() > 1024 * 1024 { return Err(invalid("Record Markdown exceeds 1 MiB")); }
    let input = json!({"scope":scope,"title":title,"tagIds":[],"markdown":markdown,"codeLanguage":null});
    if let Some(request_id) = request_id {
        bounded_generated_params(json!({"requestId":request_id,"input":input}))
    } else {
        bounded_generated_params(preview_create_params(json!({"input":input}), options.budget_chars)?)
    }
}

fn stable_request_id(options: &Options) -> AgentResult<&str> {
    options.request_id.as_deref().filter(|id| !id.is_empty() && id.len() <= 128)
        .ok_or_else(|| invalid("--request-id is required and must be at most 128 bytes"))
}

fn positive_object_id(options: &Options) -> AgentResult<i64> {
    let id = options.object_id.as_deref().ok_or_else(|| invalid("--id is required"))?;
    let id = id.parse::<i64>().map_err(|_| invalid("Invalid object ID"))?;
    if id <= 0 { return Err(invalid("Invalid object ID")); }
    Ok(id)
}

fn record_restore_params(options: &Options) -> AgentResult<Value> {
    if options.query.is_some() || options.budget_chars.is_some() {
        return Err(invalid("Record restore does not accept query or budget options"));
    }
    let record_id = positive_object_id(options)?;
    let version = options.version_id.as_deref().ok_or_else(|| invalid("--version is required"))?;
    if version.len() != 32 || !version.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        return Err(invalid("Invalid Record version ID"));
    }
    let base_revision = options.base_revision.ok_or_else(|| invalid("--base-revision is required"))?;
    let scope = scoped(options)?;
    let request_id = stable_request_id(options)?;
    Ok(json!({"requestId":request_id,"input":{"target":{"scope":scope,"recordId":record_id},
        "baseRevision":base_revision,"versionId":version}}))
}

fn file_update_identity(options: &Options) -> AgentResult<(i64, u32, &str, &str)> {
    if options.query.is_some() || options.budget_chars.is_some() {
        return Err(invalid("File update does not accept query or budget options"));
    }
    scoped(options)?;
    let id = positive_object_id(options)?;
    let version = options.expected_version.ok_or_else(|| invalid("--expected-version is required"))?;
    let hash = options.expected_hash.as_deref().ok_or_else(|| invalid("--expected-hash is required"))?;
    if !cli_upload::valid_hash(hash) { return Err(invalid("Invalid expected File hash")); }
    let source = options.source_file.as_deref().ok_or_else(|| invalid("--source-file is required"))?;
    stable_request_id(options)?;
    Ok((id, version, hash, source))
}

fn file_update_target(options: &Options, binding: &WorkspaceBinding) -> AgentResult<cli_upload::FileUploadTargetInput> {
    let (id, version, hash, _) = file_update_identity(options)?;
    cli_upload::decode_target(json!({"object":{
        "workspaceId":binding.workspace_id.clone(),"scope":scoped(options)?,
        "kind":"file","id":id.to_string()},"expectedVersionNumber":version,"expectedContentHash":hash}))
}

fn record_get_identity(options: &Options, id: &str) -> AgentResult<(i64, Scope)> {
    let record_id = id.parse::<i64>().map_err(|_| invalid("Invalid Record ID"))?;
    if record_id <= 0 { return Err(invalid("Invalid Record ID")); }
    if options.query.is_some() { return Err(invalid("record get does not accept --query")); }
    if options.revision.as_deref().is_some_and(|value| value.is_empty() || value.len() > 128) {
        return Err(invalid("Invalid Record revision"));
    }
    if options.cursor.as_deref().is_some_and(|value| value.is_empty() || value.len() > 2048) {
        return Err(invalid("Invalid Record cursor"));
    }
    Ok((record_id, scoped(options)?))
}

fn record_get_params(options: &Options, record_id: i64, scope: Scope, binding: &WorkspaceBinding) -> Value {
    json!({"object":{"workspaceId":binding.workspace_id.clone(),"scope":scope,"kind":"record","id":record_id.to_string()},
        "revision":options.revision.as_deref(),"cursor":options.cursor.as_deref(),"budgetChars":options.budget_chars})
}

fn reference_list_identity(options: &Options) -> AgentResult<(i64, Scope, &str, &str)> {
    if options.limit == Some(0) { return Err(invalid("Invalid reference limit")); }
    if options.query.is_some() { return Err(invalid("reference list does not accept --query")); }
    if options.cursor.as_deref().is_some_and(|value| value.is_empty() || value.len() > 2048) {
        return Err(invalid("Invalid reference cursor"));
    }
    let kind = options.kind.as_deref().ok_or_else(|| invalid("--kind is required"))?;
    if !matches!(kind, "record" | "todo" | "file" | "quick_note") {
        return Err(invalid("--kind must be record, todo, file or quick_note"));
    }
    let direction = options.direction.as_deref().ok_or_else(|| invalid("--direction is required"))?;
    if !matches!(direction, "incoming" | "outgoing") {
        return Err(invalid("--direction must be incoming or outgoing"));
    }
    let id = positive_object_id(options)?;
    let scope = scoped(options)?;
    Ok((id, scope, kind, direction))
}

fn reference_list_params(options: &Options, id: i64, scope: Scope, kind: &str, direction: &str, binding: &WorkspaceBinding) -> Value {
    json!({"object":{"workspaceId":binding.workspace_id.clone(),"scope":scope,"kind":kind,"id":id.to_string()},
        "direction":direction,"cursor":options.cursor.as_deref(),"limit":options.limit.unwrap_or(20),
        "budgetChars":options.budget_chars.unwrap_or(4000)})
}

fn file_create_params(options: &Options) -> AgentResult<Value> {
    if options.query.is_some() || options.budget_chars.is_some()
        || options.priority.is_some() || options.due_date.is_some() {
        return Err(invalid("File creation accepts --project or --workspace-scope, --name and --body-file"));
    }
    let project_id = crate::db::file_scope::owner(&scoped(options)?);
    let safe_name = options.name.clone().ok_or_else(|| invalid("--name is required for file create"))?;
    let request_id = options.request_id.as_deref().ok_or_else(|| invalid("--request-id is required for file create"))?;
    let body = read_text_body(options.body_file.as_deref().ok_or_else(|| invalid("--body-file is required"))?)?;
    let input = AgentFileCreateInput { project_id, safe_name, utf8_content: body };
    validate_agent_file_create(&input)?;
    bounded_generated_params(json!({"requestId": request_id, "input": input}))
}

fn todo_create_params(options: &Options) -> AgentResult<Value> {
    if options.name.is_some() || options.query.is_some() || options.budget_chars.is_some() {
        return Err(invalid("Todo creation accepts scope, --body-file, --priority and --due-date"));
    }
    let scope = scoped(options)?;
    let priority = options.priority.as_deref().unwrap_or("not_urgent_not_important");
    if !crate::agent::outputs::TODO_PRIORITIES.contains(&priority) {
        return Err(invalid("Unsupported Todo priority"));
    }
    if let Some(date) = options.due_date.as_deref() {
        if date.len() != 10 || chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .ok().is_none_or(|parsed| parsed.format("%Y-%m-%d").to_string() != date) {
            return Err(invalid("Todo dates must be explicit valid YYYY-MM-DD values"));
        }
    }
    let request_id = options.request_id.as_deref().ok_or_else(|| invalid("--request-id is required for todo create"))?;
    let content = read_text_body(options.body_file.as_deref().ok_or_else(|| invalid("--body-file is required"))?)?;
    bounded_generated_params(json!({"requestId": request_id, "input": {
        "scope": scope, "content": content, "priority": priority, "dueDate": options.due_date.as_deref(),
        "tagIds": [], "children": []
    }}))
}

/// During MCP serving, stdio owns stdout. Offline help exits before connecting;
/// diagnostics go only to stderr.
pub fn run_mcp(args: &[String]) -> i32 {
    let parsed = (|| {
        let mut workspace = None;
        let mut connection = None;
        let mut cursor = 0;
        let mut help = false;
        while cursor < args.len() {
            let flag = args[cursor].as_str();
            if flag == "--help" {
                if help { return Err(invalid("Duplicate --help")); }
                help = true;
                cursor += 1;
                continue;
            }
            if !matches!(flag, "--workspace" | "--connection") {
                return Err(AgentError::new(ErrorCode::InvalidArgument, format!("Unknown option: {flag}")));
            }
            let value = args.get(cursor + 1).ok_or_else(|| invalid("Missing MCP option value"))?;
            if value.starts_with("--") { return Err(invalid("Missing MCP option value")); }
            match args[cursor].as_str() {
                "--workspace" if workspace.is_none() => workspace = Some(PathBuf::from(value)),
                "--connection" if connection.is_none() => connection = Some(value.clone()),
                _ => return Err(invalid("Unknown or duplicate MCP option")),
            }
            cursor += 2;
        }
        if help { return Ok(None); }
        let workspace = workspace.ok_or_else(|| invalid("--workspace is required"))?;
        let connection = connection.ok_or_else(|| invalid("--connection is required"))?;
        if connection.len() != 32 || !connection.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(invalid("Invalid connection ID"));
        }
        Ok(Some((workspace, connection)))
    })();
    let result = parsed.and_then(|target| {
        let Some((workspace, connection)) = target else {
            print!("{}", cli_help::command("mcp.serve"));
            return Ok(());
        };
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()
            .map_err(|_| AgentError::new(ErrorCode::RuntimeUnavailable, "Cannot start MCP runtime"))?;
        runtime.block_on(async {
            let server = MindMcp::connect(&workspace, &connection).await?;
            server.serve_stdio().await.map_err(|_| AgentError::new(ErrorCode::RuntimeUnavailable, "MCP stdio transport failed"))
        })
    });
    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("{}: {}", serde_json::to_value(error.code).unwrap().as_str().unwrap(), error.message);
            exit_code(&error)
        }
    }
}

fn capabilities_data(verbose: bool) -> Value {
    let methods = registry::registered_methods();
    if verbose {
        json!({"sharedCapabilities": capabilities(), "bridgeMethods": methods})
    } else {
        json!({"bridgeMethods": methods.into_iter().map(|entry| json!({
            "method": entry.method, "description": entry.description, "readOnly": entry.read_only
        })).collect::<Vec<_>>()})
    }
}

fn doctor_data(workspace: &Path, status: Value, verbose: bool) -> Value {
    let mut data = json!({"connected": true, "binding": status["binding"],
        "workspacePath": workspace, "authorization": status["authorization"],
        "executionMode": status["executionMode"]});
    if verbose { data["bridgeMethods"] = json!(registry::registered_methods()); }
    data
}

pub fn run(args: &[String]) -> CliOutput {
    run_with_bridge_call(args, |workspace, connection, method, params, request_id| {
        let client = BridgeClient::discover(connection)?;
        let binding = client.connect(connection, workspace, request_id)?;
        client.call(connection, &binding, method, params, request_id)
    })
}

fn run_with_bridge_call(
    args: &[String],
    bridge_call: impl FnOnce(&Path, &str, &str, Value, &str) -> AgentResult<Value>,
) -> CliOutput {
    let words = args.iter().map(String::as_str).collect::<Vec<_>>();
    match words.as_slice() {
        ["--version"] => return CliOutput { stdout: format!("mind {}\n", env!("CARGO_PKG_VERSION")), stderr: String::new(), exit_code: 0 },
        [] | ["--help"] | ["help"] => return CliOutput { stdout: HELP.into(), stderr: String::new(), exit_code: 0 },
        ["mcp", "serve", "--help"] => return CliOutput { stdout: cli_help::command("mcp.serve"), stderr: String::new(), exit_code: 0 },
        ["mcp", "serve", ..] => return CliOutput { stdout: String::new(), stderr: "MCP serve must own stdio; use the mind executable\n".into(), exit_code: 2 },
        _ => {}
    }
    let (command, option_args, positional) = match words.as_slice() {
        ["capabilities", ..] => ("capabilities", &args[1..], None),
        ["schema", method, ..] if !method.starts_with("--") => ("schema", &args[2..], Some(*method)),
        ["schema", ..] => ("schema", &args[1..], None),
        ["doctor", ..] => ("doctor", &args[1..], None),
        ["connection", "status", ..] => ("connection.status", &args[2..], None),
        ["project", "list", ..] => ("project.list", &args[2..], None),
        ["context", "get", ..] => ("context.get", &args[2..], None),
        ["search", query, ..] if !query.starts_with("--") => ("search", &args[2..], Some(*query)),
        ["search", ..] => ("search", &args[1..], None),
        ["context", "overview", "get", ..] => ("context.overview.get", &args[3..], None),
        ["knowledge", "search", ..] => ("knowledge.search", &args[2..], None),
        ["knowledge", "get", ..] => ("knowledge.get", &args[2..], None),
        ["source", "search", ..] => ("source.search", &args[2..], None),
        ["source", "read", ..] => ("source.read", &args[2..], None),
        ["reference", "list", ..] => ("reference.list", &args[2..], None),
        ["record", "blocks", "get", ..] => ("record.blocks.get", &args[3..], None),
        ["record", "get", id, ..] if !id.starts_with("--") => ("record.get", &args[3..], Some(*id)),
        ["record", "get", ..] => ("record.get", &args[2..], None),
        ["record", "create", "preview", ..] => ("record.create.preview", &args[3..], None),
        ["record", "create", ..] => ("record.create", &args[2..], None),
        ["record", "patch", "preview", ..] => ("record.patch.preview", &args[3..], None),
        ["record", "patch", ..] => ("record.patch", &args[2..], None),
        ["record", "restore", ..] => ("record.restore", &args[2..], None),
        ["record", "versions", "list", ..] => ("record.versions.list", &args[3..], None),
        ["record", "versions", "get", ..] => ("record.versions.get", &args[3..], None),
        ["record", "versions", "compare", ..] => ("record.versions.compare", &args[3..], None),
        ["todo", "get", ..] => ("todo.get", &args[2..], None),
        ["file", "bytes", "read", ..] => ("file.bytes.read", &args[3..], None),
        ["file", "download", ..] => ("file.bytes.read", &args[2..], None),
        ["file", "list", ..] => ("file.list", &args[2..], None),
        ["session", "list", ..] => ("session.list", &args[2..], None),
        ["schedule", "list", ..] => ("schedule.list", &args[2..], None),
        ["schedule", "create", ..] => ("schedule.create", &args[2..], None),
        ["schedule", "update", ..] => ("schedule.update", &args[2..], None),
        ["schedule", "run", ..] => ("schedule.run", &args[2..], None),
        ["schedule", "delete", ..] => ("schedule.delete", &args[2..], None),
        ["record", "list", ..] => ("record.list", &args[2..], None),
        ["todo", "list", ..] => ("todo.list", &args[2..], None),
        ["todo", "create", ..] => ("todo.create", &args[2..], None),
        ["todo", "update", ..] => ("todo.update", &args[2..], None),
        ["file", "versions", "list", ..] => ("file.versions.list", &args[3..], None),
        ["file", "versions", "get", ..] => ("file.versions.get", &args[3..], None),
        ["file", "source", "read", ..] => ("file.source.read", &args[3..], None),
        ["file", "create", ..] => ("file.create", &args[2..], None),
        ["file", "patch", ..] => ("file.patch", &args[2..], None),
        ["file", "restore", ..] => ("file.version.restore", &args[2..], None),
        ["file", "version", "restore", ..] => ("file.version.restore", &args[3..], None),
        ["file", "update", ..] => ("file.update", &args[2..], None),
        ["file", "content", "begin", ..] => ("file.content.begin", &args[3..], None),
        ["file", "content", "chunk", ..] => ("file.content.chunk", &args[3..], None),
        ["file", "content", "complete", ..] => ("file.content.complete", &args[3..], None),
        ["file", "content", "status", ..] => ("file.content.status", &args[3..], None),
        ["file", "upload", ..] => ("file.upload", &args[2..], None),
        ["operation", "get", ..] => ("operation.get", &args[2..], None),
        ["operation", "list", ..] => ("operation.list", &args[2..], None),
        ["operation", "undo", ..] => ("operation.undo", &args[2..], None),
        ["operation", "restore-created", ..] => ("operation.restore_created", &args[2..], None),
        _ => {
            if let [path @ .., "--help"] = words.as_slice() {
                if let Some(help) = cli_help::group(&path.join(".")) {
                    return CliOutput { stdout: help, stderr: String::new(), exit_code: 0 };
                }
            }
            return response(request_id(), Err(invalid("Unknown command; see mind --help")));
        }
    };
    let options = match parse_options(option_args) {
        Ok(options) => options,
        Err(error) => return response(request_id(), Err(error)),
    };
    if options.verbose && !matches!(command, "capabilities" | "doctor") {
        return response(request_id(), Err(invalid("--verbose is only supported by capabilities and doctor")));
    }
    if options.help {
        return CliOutput { stdout: cli_help::command(command), stderr: String::new(), exit_code: 0 };
    }
    if matches!(command, "capabilities" | "schema") {
        if option_args.iter().any(|arg| !matches!(arg.as_str(), "--json" | "--verbose")) {
            return response(request_id(), Err(invalid("Discovery commands accept only --json and capabilities --verbose")));
        }
        return response(request_id(), if command == "capabilities" {
            Ok(capabilities_data(options.verbose))
        } else {
            positional.and_then(registry::schema).ok_or_else(|| invalid("Unknown bridge method; use mind capabilities --json"))
        });
    }
    if options.input_file.is_some() && options.patch_file.is_some() {
        return response(request_id(), Err(invalid("--input-file and --patch-file cannot be combined")));
    }
    if options.input_file.is_some() && options.body_file.is_some() && command != "file.upload" {
        return response(request_id(), Err(invalid("--input-file and --body-file cannot be combined")));
    }
    let restore_flags = options.version_id.is_some() || options.base_revision.is_some();
    let file_update_flags = options.source_file.is_some() || options.expected_version.is_some() || options.expected_hash.is_some();
    let mut request_id = options.request_id.clone().unwrap_or_else(request_id);
    let result = (|| {
        let (workspace, connection) = required_connection(&options)?;
        let inventory = matches!(command, "file.list" | "record.list" | "todo.list");
        if options.out.is_some() && command != "file.bytes.read" { return Err(invalid("--out is only supported by file download")); }
        if command == "file.bytes.read" && options.out.is_none() { return Err(invalid("--out is required for file download")); }
        if restore_flags && command != "record.restore" {
            return Err(invalid("--version and --base-revision are only supported by record restore"));
        }
        if file_update_flags && command != "file.update" && !(command == "file.create" && options.source_file.is_some() && options.expected_hash.is_none() && options.expected_version.is_none()) {
            return Err(invalid("--source-file and expected baseline options are only supported by file update"));
        }
        if options.object_id.is_some() && !matches!(command, "record.restore" | "file.update" | "reference.list") {
            return Err(invalid("--id is only supported by record restore, file update and reference list"));
        }
        if options.revision.is_some() && command != "record.get" {
            return Err(invalid("--revision is only supported by record get"));
        }
        if options.cursor.is_some() && !matches!(command, "record.get" | "reference.list") && !inventory {
            return Err(invalid("--cursor is only supported by record get and reference list"));
        }
        if (options.kind.is_some() || options.direction.is_some() || (options.limit.is_some() && !inventory)) && command != "reference.list" {
            return Err(invalid("--kind, --direction and --limit are only supported by reference list"));
        }
        if options.input_file.is_some() && (restore_flags || file_update_flags || options.object_id.is_some()) {
            return Err(invalid("--input-file cannot be combined with shorthand object options"));
        }
        if options.patch_file.is_some() && !matches!(command, "record.patch" | "file.patch" | "todo.update") {
            return Err(invalid("--patch-file is only supported by record patch, file patch and todo update"));
        }
        if options.dry_run && !matches!(command, "record.patch" | "record.create") {
            return Err(invalid("--dry-run is only supported by record patch or record create"));
        }
        if options.title.is_some() && command != "record.create" {
            return Err(invalid("--title is only supported by record create"));
        }
        if options.name.is_some() && command != "file.create"
            || (options.priority.is_some() || options.due_date.is_some()) && command != "todo.create" {
            return Err(invalid("Creation options are only supported by file create or todo create"));
        }
        if options.input_file.is_some() && matches!(command, "file.create" | "todo.create" | "record.create")
            && (options.name.is_some() || options.title.is_some() || options.priority.is_some() || options.due_date.is_some()) {
            return Err(invalid("Creation options cannot accompany --input-file"));
        }
        if matches!(command, "file.create" | "todo.create" | "record.create") && options.body_file.is_none() && options.source_file.is_none()
            && (options.name.is_some() || options.title.is_some() || options.priority.is_some() || options.due_date.is_some()) {
            return Err(invalid("--body-file is required with creation options"));
        }
        if command == "file.create" && options.source_file.is_some() {
            if options.input_file.is_some() || options.body_file.is_some() || options.patch_file.is_some() {
                return Err(invalid("--source-file cannot be combined with other input files"));
            }
            let scope = scoped(&options)?;
            let project = match scope { Scope::Project { project_id } => Some(project_id), Scope::Workspace => None };
            let name = options.name.as_deref().ok_or_else(|| invalid("--name is required for binary file create"))?;
            if options.query.is_some() || options.budget_chars.is_some() { return Err(invalid("Binary file create does not accept query or budget")); }
            request_id = stable_request_id(&options)?.to_owned();
            let bytes = cli_upload::read_file(options.source_file.as_deref().expect("source"))?;
            let client = BridgeClient::discover(connection)?;
            let binding = client.connect(connection, workspace, &request_id)?;
            let transport = cli_upload::LiveTransport { client: &client, grant_id: connection, binding: &binding };
            return cli_upload::upload_create(&transport, json!({"workspaceId":binding.workspace_id,"projectId":project,"safeName":name}), &bytes, &request_id);
        }
        if command == "file.upload" {
            reject_scope_options(&options)?;
            let target_path = options.input_file.as_deref().ok_or_else(|| invalid("--input-file is required"))?;
            let body_path = options.body_file.as_deref().ok_or_else(|| invalid("--body-file is required"))?;
            if target_path == "-" && body_path == "-" { return Err(invalid("Target JSON and body cannot both use stdin")); }
            request_id = options.request_id.clone().ok_or_else(|| invalid("--request-id is required for file upload"))?;
            if request_id.is_empty() || request_id.len() > 128 { return Err(invalid("Invalid File upload request ID")); }
            let target_json = read_input(target_path)?;
            let create_target = target_json.get("createTarget").cloned();
            if create_target.is_some() && target_json.as_object().is_none_or(|v| v.len() != 1) {
                return Err(invalid("Create upload target accepts only createTarget"));
            }
            let target = if create_target.is_none() { Some(cli_upload::decode_target(target_json)?) } else { None };
            let bytes = cli_upload::read_file(body_path)?;
            let client = BridgeClient::discover(connection)?;
            let binding = client.connect(connection, workspace, &request_id)?;
            let transport = cli_upload::LiveTransport { client: &client, grant_id: connection, binding: &binding };
            return if let Some(create_target) = create_target {
                cli_upload::upload_create(&transport, create_target, &bytes, &request_id)
            } else { cli_upload::upload(&transport, target.expect("existing target"), &bytes, &request_id) };
        }
        if command == "file.update" && (options.object_id.is_some() || file_update_flags) {
            if options.body_file.is_some() || options.patch_file.is_some() {
                return Err(invalid("File update shorthand uses --source-file, not --body-file or --patch-file"));
            }
            let (_, _, _, source) = file_update_identity(&options)?;
            request_id = stable_request_id(&options)?.to_owned();
            let bytes = cli_upload::read_file(source)?;
            let client = BridgeClient::discover(connection)?;
            let binding = client.connect(connection, workspace, &request_id)?;
            let target = file_update_target(&options, &binding)?;
            let transport = cli_upload::LiveTransport { client: &client, grant_id: connection, binding: &binding };
            return cli_upload::upload(&transport, target, &bytes, &request_id);
        }
        if command == "record.get" && positional.is_some() {
            if options.body_file.is_some() {
                return Err(invalid("record get does not accept --body-file"));
            }
            if options.input_file.is_some() {
                return Err(invalid("Record ID and --input-file cannot be combined"));
            }
            let (record_id, scope) = record_get_identity(&options, positional.expect("record ID"))?;
            let client = BridgeClient::discover(connection)?;
            let binding = client.connect(connection, workspace, &request_id)?;
            let params = record_get_params(&options, record_id, scope, &binding);
            registry::validate("record.get", &params)?;
            return client.call(connection, &binding, "record.get", params, &request_id);
        }
        if command == "reference.list" && options.input_file.is_none() {
            if options.body_file.is_some() { return Err(invalid("reference list does not accept --body-file")); }
            let (id, scope, kind, direction) = reference_list_identity(&options)?;
            let client = BridgeClient::discover(connection)?;
            let binding = client.connect(connection, workspace, &request_id)?;
            let params = reference_list_params(&options, id, scope, kind, direction, &binding);
            registry::validate("reference.list", &params)?;
            return client.call(connection, &binding, "reference.list", params, &request_id);
        }
        if options.body_file.is_some() && !matches!(command, "file.create" | "todo.create" | "record.create") {
            return Err(invalid("--body-file is only supported by file upload, file create, todo create and record create"));
        }
        let method = bridge_method(command, options.dry_run);
        let params = match command {
            "doctor" | "connection.status" | "project.list" | "schedule.list" => {
                if options.input_file.is_some() || options.project.is_some() || options.workspace_scope || options.query.is_some() || options.budget_chars.is_some() {
                    return Err(invalid("This command accepts only Workspace and connection options"));
                }
                json!({})
            }
            "context.get" => {
                if options.input_file.is_some() { return Err(invalid("context get uses --project or --workspace-scope, not --input-file")); }
                if options.budget_chars.is_some_and(|budget| budget > 3000) { return Err(invalid("Context budget must be at most 3000 characters")); }
                serde_json::to_value(ContextGetInput { scope: scoped(&options)?, query: options.query.clone(), budget_chars: options.budget_chars }).expect("context input JSON")
            }
            "search" => {
                if options.input_file.is_some() || options.query.is_some() { return Err(invalid("search uses its positional query, not --query or --input-file")); }
                json!({"scope":scoped(&options)?,"query":positional.ok_or_else(|| invalid("Search query is required"))?,"budgetChars":options.budget_chars})
            }
            "record.get" => {
                if options.project.is_some() || options.workspace_scope || options.revision.is_some()
                    || options.cursor.is_some() || options.budget_chars.is_some() || options.query.is_some() {
                    return Err(invalid("Record get --input-file cannot be combined with scope, revision, cursor, query or budget options"));
                }
                read_input(options.input_file.as_deref().ok_or_else(|| invalid("Record ID or --input-file is required"))?)?
            }
            "reference.list" => {
                if options.project.is_some() || options.workspace_scope || options.object_id.is_some()
                    || options.kind.is_some() || options.direction.is_some() || options.cursor.is_some()
                    || options.limit.is_some() || options.budget_chars.is_some() || options.query.is_some() {
                    return Err(invalid("reference list --input-file cannot be combined with shorthand options"));
                }
                read_input(options.input_file.as_deref().ok_or_else(|| invalid("--input-file is required"))?)?
            }
            "file.list" | "record.list" | "todo.list" => {
                if options.input_file.is_none() && options.project.is_none() && !options.workspace_scope {
                    return Err(invalid("--input-file is required unless list shorthand supplies --project or --workspace-scope"));
                }
                if let Some(path) = options.input_file.as_deref() {
                    if options.project.is_some() || options.workspace_scope || options.query.is_some()
                        || options.limit.is_some() || options.cursor.is_some() || options.budget_chars.is_some() {
                        return Err(invalid("Shorthand scope, query, cursor and limit options cannot accompany --input-file"));
                    }
                    read_input(path)?
                } else {
                    if options.cursor.as_ref().is_some_and(|v| v.len() > 2048) { return Err(invalid("Invalid list cursor")); }
                    let mut params = json!({"scope":scoped(&options)?,"limit":options.limit.unwrap_or(20),
                        "cursor":options.cursor,"budgetChars":options.budget_chars.unwrap_or(4000)});
                    if let Some(query) = &options.query { params["titleQuery"] = json!(query); }
                    params
                }
            }
            "file.create" if options.body_file.is_some() => file_create_params(&options)?,
            "todo.create" if options.body_file.is_some() => todo_create_params(&options)?,
            "record.create" if options.body_file.is_some() => record_create_params(&options)?,
            "record.restore" if options.object_id.is_some() || restore_flags => record_restore_params(&options)?,
            _ => {
                if !registry::is_registered(method) { return Err(invalid("Unknown bridge method")); }
                if command == "record.patch" {
                    if options.project.is_some() || options.workspace_scope || options.query.is_some() {
                        return Err(invalid("Scope and query options cannot accompany record patch"));
                    }
                    if !options.dry_run && options.budget_chars.is_some() {
                        return Err(invalid("--budget-chars is only supported by record patch --dry-run"));
                    }
                    let source = options.patch_file.as_deref().or(options.input_file.as_deref())
                        .ok_or_else(|| invalid("--patch-file or --input-file is required"))?;
                    let params = read_input(source)?;
                    if options.dry_run { preview_patch_params(params, options.budget_chars)? } else { params }
                } else if command == "record.create" {
                    if options.project.is_some() || options.workspace_scope || options.query.is_some() {
                        return Err(invalid("Scope and query options cannot accompany --input-file"));
                    }
                    if !options.dry_run && options.budget_chars.is_some() {
                        return Err(invalid("--budget-chars is only supported by record create --dry-run"));
                    }
                    let params = read_input(options.input_file.as_deref().ok_or_else(|| invalid("--input-file is required"))?)?;
                    if options.dry_run { preview_create_params(params, options.budget_chars)? } else { params }
                } else {
                    let source = options.patch_file.as_deref().or(options.input_file.as_deref())
                        .ok_or_else(|| AgentError::new(ErrorCode::InvalidArgument,
                            format!("--input-file is required for {command}; use mind {} --help for its JSON input contract", command.replace('.', " "))))?;
                    reject_scope_options(&options)?;
                    read_input(source)?
                }
            }
        };
        if command == "record.patch" && !options.dry_run {
            request_id = write_request_id(&options, &params)?;
        }
        registry::validate(method, &params)?;
        if registry::is_read_only(method) == Some(false) && command != "record.patch" {
            request_id = write_request_id(&options, &params)?;
        }
        // Keep the same canonical path for connect and doctor output. Connect
        // still checks the path and the server verifies its Workspace binding.
        let canonical_workspace = if command == "doctor" {
            Some(workspace.canonicalize().map_err(|_| AgentError::new(
                ErrorCode::WorkspaceNotOpen, "Workspace path is unavailable"))?)
        } else { None };
        let workspace = canonical_workspace.as_deref().unwrap_or(workspace.as_path());
        let data = bridge_call(workspace, connection, method, params, &request_id)?;
        if command == "doctor" {
            return Ok(doctor_data(workspace, data, options.verbose));
        }
        if command == "file.bytes.read" {
            return cli_upload::save_download(data, options.out.as_deref().expect("output path"));
        }
        Ok(data)
    })();
    response(request_id, result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn invoke(args: &[&str]) -> CliOutput { run(&args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>()) }
    #[test]
    fn inventory_shorthand_and_json_use_identical_registered_contracts() {
        for entity in ["file", "record", "todo"] {
            let args = [entity,"list","--workspace-scope","--limit","7","--cursor","next",
                "--workspace","/tmp","--connection","0123456789abcdef0123456789abcdef","--json"]
                .map(str::to_owned);
            let out = run_with_bridge_call(&args, |_,_,method,params,_| {
                assert_eq!(method, format!("{entity}.list"));
                assert_eq!(params["scope"], json!({"kind":"workspace"}));
                assert_eq!(params["limit"], 7);
                assert_eq!(params["cursor"], "next");
                Ok(json!({}))
            });
            assert_eq!(out.exit_code, 0, "{}", out.stderr);
        }
    }
    #[test]
    fn download_writes_verified_bytes_and_omits_base64() {
        use base64::Engine;
        use sha2::{Digest, Sha256};
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("result.docx");
        let bytes = b"fixed binary bytes";
        let data = json!({"base64":base64::engine::general_purpose::STANDARD.encode(bytes),
            "byteLength":bytes.len(),"contentHash":format!("sha256:{:x}",Sha256::digest(bytes)),"mime":"application/octet-stream"});
        let saved = cli_upload::save_download(data.clone(), path.to_str().unwrap()).unwrap();
        assert!(saved.get("base64").is_none());
        assert_eq!(std::fs::read(&path).unwrap(),bytes);
        assert_eq!(cli_upload::save_download(data,path.to_str().unwrap()).unwrap_err().code,ErrorCode::IoFailed);
    }
    #[test]
    fn schedule_commands_publish_help_and_exact_schema_without_connecting() {
        for verb in ["list", "create", "update", "delete", "run"] {
            let output = invoke(&["schedule", verb, "--help"]);
            assert_eq!(output.exit_code, 0, "{}", output.stderr);
            assert!(output.stdout.contains(&format!("mind schema schedule.{verb} --json")));
            let schema = invoke(&["schema", &format!("schedule.{verb}"), "--json"]);
            assert_eq!(schema.exit_code, 0, "{}", schema.stderr);
            let value: Value = serde_json::from_str(&schema.stdout).unwrap();
            assert_eq!(value["ok"], true);
        }
        assert!(invoke(&["schedule", "--help"]).stdout.contains("mind schedule create"));
    }
    #[test]
    fn schedule_commands_route_real_cli_inputs_and_stable_request_ids() {
        let root = tempfile::tempdir().unwrap();
        let input_file = root.path().join("task.json");
        let task = json!({"title":"日报","prompt":"汇总项目","sessionId":"real-session","enabled":true,
            "rule":{"kind":"weeks","startDate":"2026-10-26","time":"09:00","interval":2,"weekdays":[1,3]}});
        for (verb, input) in [("create", task.clone()), ("update", json!({"id":"task","task":task})), ("delete", json!({"id":"task"})), ("run", json!({"id":"task"}))] {
            let params = json!({"requestId":"stable:cli-request","input":input});
            std::fs::write(&input_file, serde_json::to_vec(&params).unwrap()).unwrap();
            let args = ["schedule", verb, "--input-file", input_file.to_str().unwrap(), "--workspace", root.path().to_str().unwrap(),
                "--connection", "0123456789abcdef0123456789abcdef", "--json"].into_iter().map(str::to_owned).collect::<Vec<_>>();
            let output = run_with_bridge_call(&args, |_, _, method, actual, request_id| {
                assert_eq!(method, format!("schedule.{verb}"));
                assert_eq!(actual, params);
                assert_eq!(request_id, "stable:cli-request");
                Ok(json!({"id":"task"}))
            });
            assert_eq!(output.exit_code, 0, "{}", output.stdout);
        }
        let args = ["schedule", "list", "--workspace", root.path().to_str().unwrap(), "--connection", "0123456789abcdef0123456789abcdef", "--json"]
            .into_iter().map(str::to_owned).collect::<Vec<_>>();
        let output = run_with_bridge_call(&args, |_, _, method, actual, _| {
            assert_eq!(method, "schedule.list");
            assert_eq!(actual, json!({}));
            Ok(json!([]))
        });
        assert_eq!(output.exit_code, 0, "{}", output.stdout);
    }
    #[test]
    fn connection_status_help_is_offline_and_explains_snapshot_limits() {
        let out = invoke(&["connection", "status", "--help"]);
        assert_eq!(out.exit_code, 0, "{}", out.stderr);
        assert!(out.stdout.contains("mind schema connection.status --json"));
        assert!(out.stdout.contains("snapshot"));
        assert!(out.stdout.contains("reauthorized"));
        assert!(out.stdout.contains("native permissions"));
        assert!(out.stdout.contains("null"));
        let group = invoke(&["connection", "--help"]);
        assert_eq!(group.exit_code, 0, "{}", group.stderr);
        assert!(group.stdout.contains("mind connection status"));
        assert!(invoke(&["--help"]).stdout.contains("mind connection status --workspace PATH --connection ID --json"));
        let doctor = invoke(&["doctor", "--help"]);
        assert!(doctor.stdout.contains("workspacePath"));
        assert!(doctor.stdout.contains("snapshot"));
        assert!(doctor.stdout.contains("reauthorized"));
    }
    #[test]
    fn subcommand_help_is_offline_and_points_to_its_schema() {
        for method in [
            "todo.create", "todo.get", "todo.update", "todo.list", "record.list", "record.get",
            "record.create", "record.patch", "record.patch.preview", "record.restore",
            "record.versions.compare", "file.upload", "file.version.restore",
            "context.overview.get", "source.read", "reference.list", "operation.restore-created",
        ] {
            let mut args = method.split('.').collect::<Vec<_>>();
            args.push("--help");
            let out = invoke(&args);
            assert_eq!(out.exit_code, 0, "{method}: {}", out.stderr);
            assert!(out.stderr.is_empty(), "{method}");
            assert!(out.stdout.contains("Usage:"), "{method}: {}", out.stdout);
            let schema = match method {
                "file.upload" => "file.content.begin",
                "operation.restore-created" => "operation.restore_created",
                _ => method,
            };
            assert!(out.stdout.contains(&format!("mind schema {schema} --json")), "{method}: {}", out.stdout);
            assert!(out.stdout.len() < 3500, "{method}: help should be concise");
        }
        // Help must not open even stdin or a nonexistent mutation input.
        for source in ["-", "/nonexistent/mind-help-input.json"] {
            let out = invoke(&["todo", "create", "--input-file", source, "--help", "--json"]);
            assert_eq!(out.exit_code, 0, "{}", out.stderr);
        }
        for group in ["todo", "record", "file"] {
            let out = invoke(&[group, "--help"]);
            assert_eq!(out.exit_code, 0, "{}", out.stderr);
            assert!(out.stdout.contains(&format!("mind {group}")));
        }
        let root = invoke(&["--help"]);
        assert!(root.stdout.contains("mind todo get|list --input-file PATH|-"));
        let todo = invoke(&["todo", "--help"]);
        assert!(todo.stdout.contains("list"));
        assert_eq!(invoke(&["invented", "--help"]).exit_code, 2);
    }
    #[test]
    fn unknown_flags_are_reported_before_reading_option_values() {
        for command in [vec!["todo", "create"], vec!["record", "get"], vec!["capabilities"], vec!["doctor"]] {
            for tail in [vec!["--bogus"], vec!["--bogus", "--json"], vec!["--bogus", "value", "--json"]] {
                let mut args = command.clone();
                args.extend(tail);
                let out = invoke(&args);
                assert_eq!(out.exit_code, 2);
                assert!(out.stderr.contains("Unknown option: --bogus"), "{args:?}: {}", out.stderr);
                assert!(!out.stderr.contains("Missing option value"));
            }
        }
        let out = invoke(&["todo", "get", "--input-file"]);
        assert!(out.stderr.contains("Missing option value"));
    }
    #[test]
    fn capabilities_default_is_compact_and_verbose_preserves_full_catalog() {
        let compact = invoke(&["capabilities", "--json"]);
        assert_eq!(compact.exit_code, 0);
        let compact: Value = serde_json::from_str(&compact.stdout).unwrap();
        assert_eq!(compact["ok"], true);
        let data = compact["data"].as_object().unwrap();
        assert_eq!(data.len(), 1);
        let methods = data["bridgeMethods"].as_array().unwrap();
        assert!(!methods.is_empty());
        for method in methods {
            assert_eq!(method.as_object().unwrap().len(), 3, "{method}");
            assert!(method["method"].is_string());
            assert!(method["description"].is_string());
            assert!(method["readOnly"].is_boolean());
        }
        for args in [["capabilities", "--verbose", "--json"], ["capabilities", "--json", "--verbose"]] {
            let verbose = invoke(&args);
            assert_eq!(verbose.exit_code, 0, "{}", verbose.stderr);
            let verbose: Value = serde_json::from_str(&verbose.stdout).unwrap();
            assert_eq!(verbose["data"]["bridgeMethods"], serde_json::to_value(registry::registered_methods()).unwrap());
            assert_eq!(verbose["data"]["sharedCapabilities"], serde_json::to_value(capabilities()).unwrap());
            assert_eq!(verbose["data"]["bridgeMethods"].as_array().unwrap().len(), methods.len());
        }
    }
    #[test]
    fn doctor_reports_current_authorization_and_canonical_workspace() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("child")).unwrap();
        let workspace = root.path().join("child/..");
        let canonical = root.path().canonicalize().unwrap();
        for (mode, object_keys) in [
            (Value::Null, Value::Null),
            (json!("read-only"), json!([])),
            (json!("workspace-write"), json!(["selected-record"])),
            (json!("danger-full-access"), Value::Null),
        ] {
            let status = json!({"binding":{"workspaceId":"bound-workspace","generation":"g"},
                "authorization":{"workspaceContent":false,"projectIds":[7],"operations":["source.read"],"objectKeys":object_keys},
                "executionMode":mode,"token":"private-token","grantToken":"private-grant"});
            let mut compact = None;
            for verbose in [false, true] {
                let mut args = vec!["doctor", "--workspace", workspace.to_str().unwrap(),
                    "--connection", "0123456789abcdef0123456789abcdef", "--json"];
                if verbose { args.push("--verbose"); }
                let args = args.into_iter().map(str::to_owned).collect::<Vec<_>>();
                let out = run_with_bridge_call(&args, |path, _, method, params, _| {
                    assert_eq!(path, canonical);
                    assert_eq!(method, "connection.status");
                    assert_eq!(params, json!({}));
                    Ok(status.clone())
                });
                assert_eq!(out.exit_code, 0, "{}", out.stderr);
                let mut data = serde_json::from_str::<Value>(&out.stdout).unwrap()["data"].clone();
                if verbose {
                    assert_eq!(data.as_object_mut().unwrap().remove("bridgeMethods").unwrap(),
                        serde_json::to_value(registry::registered_methods()).unwrap());
                    assert_eq!(Some(&data), compact.as_ref());
                } else {
                    assert_eq!(data, json!({"connected":true,"binding":{"workspaceId":"bound-workspace","generation":"g"},
                        "workspacePath":canonical,"authorization":{"workspaceContent":false,"projectIds":[7],"operations":["source.read"],"objectKeys":object_keys},
                        "executionMode":mode}));
                    compact = Some(data);
                }
            }
        }
    }
    #[test]
    fn connection_status_routes_empty_input_and_preserves_status() {
        let root = tempfile::tempdir().unwrap();
        let args = ["connection", "status", "--workspace", root.path().to_str().unwrap(),
            "--connection", "0123456789abcdef0123456789abcdef", "--json"]
            .into_iter().map(str::to_owned).collect::<Vec<_>>();
        let expected = json!({"binding":{"workspaceId":"w","generation":"g"},
            "authorization":{"workspaceContent":true,"projectIds":[],"operations":[],"objectKeys":null},"executionMode":null});
        let out = run_with_bridge_call(&args, |_, connection, method, params, _| {
            assert_eq!(connection, "0123456789abcdef0123456789abcdef");
            assert_eq!(method, "connection.status");
            assert_eq!(params, json!({}));
            Ok(expected.clone())
        });
        assert_eq!(out.exit_code, 0, "{}", out.stderr);
        assert_eq!(serde_json::from_str::<Value>(&out.stdout).unwrap()["data"], expected);
    }
    #[test]
    fn connection_status_rejects_business_input_before_bridge_io() {
        for flag in [vec!["--input-file", "-"], vec!["--project", "7"],
            vec!["--workspace-scope"], vec!["--query", "text"], vec!["--budget-chars", "100"]] {
            let mut args = vec!["connection", "status", "--workspace", "/tmp",
                "--connection", "0123456789abcdef0123456789abcdef", "--json"];
            args.extend(flag);
            let args = args.into_iter().map(str::to_owned).collect::<Vec<_>>();
            let out = run_with_bridge_call(&args, |_, _, _, _, _| panic!("unexpected bridge I/O"));
            assert_eq!(out.exit_code, 2, "{}", out.stderr);
            assert!(out.stderr.contains("accepts only Workspace and connection options"));
        }
    }
    #[test]
    fn doctor_and_connection_status_propagate_status_query_failures() {
        let root = tempfile::tempdir().unwrap();
        for command in [vec!["doctor"], vec!["connection", "status"]] {
            for (code, exit, name) in [(ErrorCode::ScopeDenied, 4, "SCOPE_DENIED"),
                (ErrorCode::RuntimeUnavailable, 3, "RUNTIME_UNAVAILABLE"),
                (ErrorCode::ToolCallUnsupported, 6, "TOOL_CALL_UNSUPPORTED")] {
                let mut args = command.clone();
                args.extend(["--workspace", root.path().to_str().unwrap(),
                    "--connection", "0123456789abcdef0123456789abcdef", "--json"]);
                let args = args.into_iter().map(str::to_owned).collect::<Vec<_>>();
                let out = run_with_bridge_call(&args, |_, _, method, _, _| {
                    assert_eq!(method, "connection.status");
                    Err(AgentError::new(code, "Status query failed"))
                });
                assert_eq!(out.exit_code, exit, "{}", out.stderr);
                let response: Value = serde_json::from_str(&out.stdout).unwrap();
                assert_eq!(response["ok"], false);
                assert_eq!(response["error"]["code"], name);
                assert_eq!(response["error"]["message"], "Status query failed");
                assert!(response.get("data").is_none());
            }
        }
    }
    #[test]
    fn verbose_is_explicitly_limited_to_discovery_commands() {
        let out = invoke(&["todo", "get", "--verbose", "--json"]);
        assert_eq!(out.exit_code, 2);
        assert!(out.stderr.contains("--verbose is only supported by capabilities and doctor"), "{}", out.stderr);
    }
    #[test]
    fn todo_list_routes_input_file_through_registered_validation() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), br#"{"unexpected":"field"}"#).unwrap();
        for action in ["get", "list"] {
            let out = invoke(&["todo", action, "--input-file", file.path().to_str().unwrap(),
                "--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"]);
            assert_eq!(out.exit_code, 2);
            assert!(out.stderr.contains("method input DTO"), "{action}: {}", out.stderr);
            let out = invoke(&["todo", action, "--workspace", "/tmp",
                "--connection", "0123456789abcdef0123456789abcdef", "--json"]);
            assert!(out.stderr.contains("--input-file is required"), "{action}: {}", out.stderr);
        }
    }
    #[test]
    fn todo_list_accepts_registered_dto_and_rejects_mixed_scope_flags() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let params = json!({"scope":{"kind":"workspace"},"status":"unfinished",
            "dueFrom":"2026-10-01","dueTo":"2026-10-31","includeChildren":true,
            "limit":20,"budgetChars":4000});
        registry::validate("todo.list", &params).unwrap();
        std::fs::write(file.path(), serde_json::to_vec(&params).unwrap()).unwrap();
        let args = ["todo", "list", "--input-file", file.path().to_str().unwrap(),
            "--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"];
        let out = invoke(&args);
        assert_ne!(out.exit_code, 2, "{}", out.stderr);
        let mut mixed = args.to_vec();
        mixed.push("--workspace-scope");
        let out = invoke(&mixed);
        assert_eq!(out.exit_code, 2);
        assert!(out.stderr.contains("cannot accompany --input-file"), "{}", out.stderr);
        // The same bounded JSON reader services --input-file - for list and get.
        assert_eq!(parse_input(std::io::Cursor::new(serde_json::to_vec(&params).unwrap())).unwrap(), params);
    }
    #[test]
    fn record_list_accepts_registered_dto_and_rejects_mixed_scope_flags() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let params = json!({"scope":{"kind":"workspace"},"tag":"Topic","tagIds":[1],
            "limit":20,"budgetChars":4000});
        registry::validate("record.list", &params).unwrap();
        std::fs::write(file.path(), serde_json::to_vec(&params).unwrap()).unwrap();
        let args = ["record", "list", "--input-file", file.path().to_str().unwrap(),
            "--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"];
        let out = invoke(&args);
        assert_ne!(out.exit_code, 2, "{}", out.stderr);
        let mut mixed = args.to_vec();
        mixed.push("--workspace-scope");
        let out = invoke(&mixed);
        assert_eq!(out.exit_code, 2);
        assert!(out.stderr.contains("cannot accompany --input-file"), "{}", out.stderr);
        // The same bounded JSON reader services --input-file - for list and get.
        assert_eq!(parse_input(std::io::Cursor::new(serde_json::to_vec(&params).unwrap())).unwrap(), params);
    }
    #[test]
    fn all_registered_methods_have_focused_offline_help() {
        for entry in registry::registered_methods() {
            let path = entry.method.replace('_', "-");
            let mut args = path.split('.').collect::<Vec<_>>();
            args.push("--help");
            let out = invoke(&args);
            assert_eq!(out.exit_code, 0, "{}: {}", entry.method, out.stderr);
            assert!(out.stdout.lines().any(|line| line.starts_with("  mind ")), "{}: {}", entry.method, out.stdout);
            assert!(out.stdout.contains(&format!("mind schema {} --json", entry.method)), "{}: {}", entry.method, out.stdout);
        }
        for command in ["capabilities", "doctor", "schema", "search"] {
            let out = invoke(&[command, "--help"]);
            assert_eq!(out.exit_code, 0, "{command}: {}", out.stderr);
            assert!(out.stdout.contains("Usage:"));
        }
        let out = invoke(&["record", "get", "23", "--help"]);
        assert_eq!(out.exit_code, 0, "{}", out.stderr);
        assert!(out.stdout.contains("mind schema record.get --json"));
        let out = invoke(&["doctor", "--verbose", "--json"]);
        assert!(out.stderr.contains("--workspace is required"), "{}", out.stderr);
    }
    #[test]
    fn standalone_mcp_help_does_not_connect() {
        let out = invoke(&["mcp", "serve", "--help"]);
        assert_eq!(out.exit_code, 0);
        assert!(out.stdout.contains("mind mcp serve"));
        assert_eq!(run_mcp(&["--help".into()]), 0);
    }
    #[test]
    fn malformed_options_are_json_and_exit_two() {
        for args in [
            vec!["project", "list", "--json", "--workspace", "/tmp"],
            vec!["context", "get", "--project", "0", "--json"],
            vec!["schema", "run.start", "--json"],
        ] {
            let out = invoke(&args);
            assert_eq!(out.exit_code, 2);
            let json: Value = serde_json::from_str(&out.stdout).unwrap();
            assert_eq!(json["ok"], false);
            assert_eq!(json["error"]["code"], "INVALID_ARGUMENT");
        }
    }
    #[test]
    fn mcp_never_writes_protocol_stdout() {
        let out = invoke(&["mcp", "serve"]);
        assert_eq!(out.exit_code, 2);
        assert!(out.stdout.is_empty());
    }
    #[test]
    fn missing_and_duplicate_options_explain_the_problem() {
        let missing = invoke(&["project", "list", "--workspace", "/tmp", "--json"]);
        assert_eq!(missing.exit_code, 2);
        assert_eq!(serde_json::from_str::<Value>(&missing.stdout).unwrap()["error"]["message"], "--connection is required");
        assert!(missing.stderr.contains("--connection is required"));

        let duplicate = invoke(&["project", "list", "--json", "--json"]);
        assert_eq!(duplicate.exit_code, 2);
        assert_eq!(serde_json::from_str::<Value>(&duplicate.stdout).unwrap()["error"]["message"], "Duplicate --json");
        assert!(duplicate.stderr.contains("Duplicate --json"));
    }
    #[test]
    fn context_requires_one_scope_before_connecting() {
        let out = invoke(&["context", "get", "--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"]);
        assert_eq!(out.exit_code, 2);
        assert_eq!(serde_json::from_str::<Value>(&out.stdout).unwrap()["error"]["code"], "INVALID_ARGUMENT");
    }
    #[test]
    fn input_file_is_bounded_json() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), br#"{"scope":{"kind":"workspace"},"query":"needle"}"#).unwrap();
        let input = read_input(file.path().to_str().unwrap()).unwrap();
        registry::validate("source.search", &input).unwrap();
        assert_eq!(parse_input(std::io::Cursor::new(Vec::<u8>::new())).unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(parse_input(std::io::Cursor::new(vec![b' '; (MAX_INPUT_BYTES + 1) as usize])).unwrap_err().message, "--input-file exceeds 2 MiB");
    }
    #[test]
    fn input_file_commands_validate_before_discovery() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), br#"{"invented":"field"}"#).unwrap();
        let args = ["file", "source", "read", "--input-file", file.path().to_str().unwrap(), "--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"];
        let out = invoke(&args);
        assert_eq!(out.exit_code, 2);
        assert!(out.stderr.contains("method input DTO"));
        let mixed = invoke(&["source", "read", "--input-file", file.path().to_str().unwrap(), "--project", "1", "--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"]);
        assert_eq!(mixed.exit_code, 2);
        assert!(mixed.stderr.contains("cannot accompany --input-file"));
    }
    #[test]
    fn shorthand_search_uses_source_search_bounds() {
        let query = "q".repeat(257);
        let args = ["search", query.as_str(), "--project", "1", "--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--budget-chars", "12000", "--json"];
        let out = invoke(&args);
        assert_eq!(out.exit_code, 2);
        assert!(out.stderr.contains("declared bounds"));
    }
    #[test]
    fn record_history_commands_route_to_their_registered_dtos() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), br#"{"unexpected":"field"}"#).unwrap();
        for subcommand in ["list", "get", "compare"] {
            let args = ["record", "versions", subcommand, "--input-file", file.path().to_str().unwrap(), "--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"];
            let out = invoke(&args);
            assert_eq!(out.exit_code, 2, "{subcommand}");
            assert!(out.stderr.contains("method input DTO"), "{subcommand}");
        }
    }
    #[test]
    fn write_request_id_is_stable_and_must_match_override() {
        let input = json!({"requestId":"stable-operation-1","input":{}});
        assert_eq!(write_request_id(&Options::default(), &input).unwrap(), "stable-operation-1");
        let matched = Options { request_id: Some("stable-operation-1".into()), ..Options::default() };
        assert_eq!(write_request_id(&matched, &input).unwrap(), "stable-operation-1");
        let mismatched = Options { request_id: Some("different".into()), ..Options::default() };
        assert_eq!(write_request_id(&mismatched, &input).unwrap_err().message, "--request-id must match input requestId");
        assert_eq!(write_request_id(&Options::default(), &json!({"input":{}})).unwrap_err().message, "Write input requires requestId");
    }
    #[test]
    fn write_commands_require_an_input_file_before_connection() {
        for words in [
            vec!["record", "create"], vec!["record", "restore"],
            vec!["operation", "undo"], vec!["operation", "restore-created"],
            vec!["todo", "create"], vec!["todo", "update"],
        ] {
            let mut args = words;
            args.extend(["--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"]);
            let out = invoke(&args);
            assert_eq!(out.exit_code, 2);
            assert!(out.stderr.contains("--input-file is required"));
        }
    }
    #[test]
    fn write_override_mismatch_is_rejected_before_discovery() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), br#"{"requestId":"stable-1","input":{"scope":{"kind":"workspace"},"title":null,"tagIds":[],"document":{},"codeLanguage":null}}"#).unwrap();
        let args = ["record", "create", "--input-file", file.path().to_str().unwrap(), "--request-id", "different", "--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"];
        let out = invoke(&args);
        assert_eq!(out.exit_code, 2);
        assert!(out.stderr.contains("must match input requestId"));
    }
    #[test]
    fn upload_requires_body_and_stable_identity_before_connecting() {
        let missing = invoke(&["file", "upload", "--input-file", "target.json", "--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"]);
        assert_eq!(missing.exit_code, 2);
        assert!(missing.stderr.contains("--body-file is required"));
        let missing_id = invoke(&["file", "upload", "--input-file", "target.json", "--body-file", "body.bin", "--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"]);
        assert_eq!(missing_id.exit_code, 2);
        assert!(missing_id.stderr.contains("--request-id is required"));
    }

    #[test]
    fn patch_preview_removes_mutation_identity_and_cannot_route_to_write() {
        assert_eq!(bridge_method("record.patch", true), "record.patch.preview");
        assert_eq!(bridge_method("record.patch", false), "record.patch");
        assert_eq!(bridge_method("record.patch.preview", false), "record.patch.preview");
        let input = json!({"record":{"workspaceId":"w","scope":{"kind":"workspace"},"kind":"record","id":"r"},"baseRevision":1,"operations":[],"requestId":"stable-1"});
        let preview = preview_patch_params(input.clone(), Some(12000)).unwrap();
        assert!(preview.get("requestId").is_none());
        assert_eq!(preview["budgetChars"], 12000);
        registry::validate("record.patch.preview", &preview).unwrap();
        assert_eq!(input["requestId"], "stable-1");
        assert!(preview_patch_params(json!([]), None).is_err());
    }
    #[test]
    fn patch_flags_are_explicit_and_never_silently_ignored() {
        let common = ["--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"];
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), br#"{"record":{"workspaceId":"w","scope":{"kind":"workspace"},"kind":"record","id":"r"},"baseRevision":1,"operations":[],"requestId":"stable-1"}"#).unwrap();
        let path = file.path().to_str().unwrap();
        let check = |words: &[&str], expected: &str| {
            let mut args = words.to_vec();
            args.extend(common);
            let out = invoke(&args);
            assert_eq!(out.exit_code, 2, "{words:?}: {}", out.stderr);
            assert!(out.stderr.contains(expected), "{words:?}: {}", out.stderr);
        };
        check(&["record", "patch", "--patch-file", path, "--input-file", path], "cannot be combined");
        check(&["record", "create", "--patch-file", path], "only supported by record patch");
        check(&["record", "patch", "preview", "--dry-run", "--input-file", path], "only supported by record patch");
        check(&["record", "patch", "--patch-file", path, "--budget-chars", "100"], "only supported by record patch --dry-run");
        check(&["record", "patch", "--patch-file", path, "--project", "1"], "Scope and query options");
        check(&["record", "patch", "--patch-file", path, "--request-id", "different"], "must match input requestId");
        check(&["record", "patch", "--patch-file", path, "--dry-run", "--budget-chars", "12001"], "Invalid character budget");
    }
    #[test]
    fn patch_file_requires_stable_id_for_writes_but_not_preview() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), br#"{"record":{"workspaceId":"w","scope":{"kind":"workspace"},"kind":"record","id":"r"},"baseRevision":1,"operations":[]}"#).unwrap();
        let path = file.path().to_str().unwrap();
        let common = ["--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"];
        let mut write_args = vec!["record", "patch", "--patch-file", path];
        write_args.extend(common);
        let write = invoke(&write_args);
        assert_eq!(write.exit_code, 2);
        assert!(write.stderr.contains("requestId"));
        let mut preview_args = vec!["record", "patch", "--patch-file", path, "--dry-run"];
        preview_args.extend(common);
        let preview = invoke(&preview_args);
        assert_ne!(preview.exit_code, 2, "{}", preview.stderr);
        let mut explicit_preview_args = vec!["record", "patch", "preview", "--input-file", path];
        explicit_preview_args.extend(common);
        let explicit_preview = invoke(&explicit_preview_args);
        assert_ne!(explicit_preview.exit_code, 2, "{}", explicit_preview.stderr);
    }
    #[test]
    fn convenient_file_and_todo_creation_use_native_dtos_and_preserve_text() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let body = "line 1\n`$HOME` $(touch never) \\ path\n";
        std::fs::write(file.path(), body).unwrap();
        let path = file.path().to_str().unwrap().to_owned();
        let file_options = Options {
            project: Some(7), name: Some("notes.md".into()), body_file: Some(path.clone()),
            request_id: Some("file-stable".into()), ..Options::default()
        };
        let file_params = file_create_params(&file_options).unwrap();
        assert_eq!(file_params["input"]["utf8Content"], body);
        assert_eq!(file_params["input"]["safeName"], "notes.md");
        registry::validate("file.create", &file_params).unwrap();
        let todo_options = Options {
            workspace_scope: true, body_file: Some(path), request_id: Some("todo-stable".into()),
            ..Options::default()
        };
        let todo_params = todo_create_params(&todo_options).unwrap();
        assert_eq!(todo_params["input"]["content"], body);
        assert_eq!(todo_params["input"]["priority"], "not_urgent_not_important");
        assert!(todo_params["input"]["dueDate"].is_null());
        assert_eq!(todo_params["input"]["tagIds"], json!([]));
        assert_eq!(todo_params["input"]["children"], json!([]));
        registry::validate("todo.create", &todo_params).unwrap();
    }
    #[test]
    fn creation_flags_and_json_input_are_mutually_exclusive() {
        let common = ["--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"];
        let check = |words: &[&str], expected: &str| {
            let mut args = words.to_vec();
            args.extend(common);
            let out = invoke(&args);
            assert_eq!(out.exit_code, 2, "{words:?}: {}", out.stderr);
            assert!(out.stderr.contains(expected), "{words:?}: {}", out.stderr);
        };
        check(&["file", "create", "--input-file", "input.json", "--body-file", "text.md"], "cannot be combined");
        check(&["todo", "create", "--input-file", "input.json", "--priority", "urgent_important"], "cannot accompany --input-file");
        check(&["file", "create", "--input-file", "input.json", "--name", "notes.md"], "cannot accompany --input-file");
        check(&["file", "create", "--body-file", "text.md", "--project", "1", "--request-id", "stable"], "--name is required");
        check(&["todo", "create", "--body-file", "text.md", "--workspace-scope", "--request-id", "stable", "--priority", "normal"], "Unsupported Todo priority");
        check(&["todo", "create", "--body-file", "text.md", "--workspace-scope", "--request-id", "stable", "--due-date", "2026-02-30"], "valid YYYY-MM-DD");
        check(&["source", "read", "--input-file", "input.json", "--name", "notes.md"], "Creation options");
    }
    #[test]
    fn generated_text_payload_is_bounded_after_json_escaping() {
        let params = json!({"input":{"utf8Content":"\\".repeat(1_100_000)}});
        assert_eq!(bounded_generated_params(params).unwrap_err().message, "Generated input exceeds 2 MiB");
    }
    #[test]
    fn patch_file_alias_keeps_existing_mutation_wrapper() {
        let common = ["--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"];
        let cases = [
            ("file", "patch", json!({"requestId":"stable-file","input":{
                "object":{"workspaceId":"w","scope":{"kind":"project","projectId":1},"kind":"file","id":"1"},
                "expectedVersionNumber":1,"expectedContentHash":format!("sha256:{}", "0".repeat(64)),
                "edits":null,"appendText":"hello"}})),
            ("todo", "update", json!({"requestId":"stable-todo","input":{
                "target":{"workspaceId":"w","scope":{"kind":"workspace"},"kind":"todo","id":"1"},
                "expectedRevision":1,"changes":[]}})),
        ];
        for (entity, action, params) in cases {
            let file = tempfile::NamedTempFile::new().unwrap();
            std::fs::write(file.path(), serde_json::to_vec(&params).unwrap()).unwrap();
            let path = file.path().to_str().unwrap();
            let mut args = vec![entity, action, "--patch-file", path];
            args.extend(common);
            let out = invoke(&args);
            assert_ne!(out.exit_code, 2, "{}", out.stderr);
        }
    }
    #[test]
    fn record_create_body_builds_native_markdown_and_preview_without_mutation_id() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let markdown = "# Title\n`$HOME` $(touch never) \\ literal\n";
        std::fs::write(file.path(), markdown).unwrap();
        let body_file = file.path().to_str().unwrap().to_owned();
        let options = Options { workspace_scope: true, title: Some("A note".into()),
            body_file: Some(body_file), request_id: Some("record-stable".into()), ..Options::default() };
        let write = record_create_params(&options).unwrap();
        assert_eq!(write["requestId"], "record-stable");
        assert_eq!(write["input"]["markdown"], markdown);
        assert_eq!(write["input"]["tagIds"], json!([]));
        assert!(write["input"]["codeLanguage"].is_null());
        registry::validate("record.create", &write).unwrap();
        let preview_options = Options { dry_run: true, budget_chars: Some(12000), request_id: None, ..options };
        let preview = record_create_params(&preview_options).unwrap();
        assert_eq!(bridge_method("record.create", true), "record.create.preview");
        assert!(preview.get("requestId").is_none());
        assert_eq!(preview["budgetChars"], 12000);
        assert_eq!(preview["input"]["markdown"], markdown);
        registry::validate("record.create.preview", &preview).unwrap();
    }
    #[test]
    fn record_create_wrapper_preview_preserves_input_and_rejects_unknown_fields() {
        let input = json!({"scope":{"kind":"workspace"},"title":"Native","tagIds":[],
            "markdown":"hello","codeLanguage":null});
        let preview = preview_create_params(json!({"requestId":"stable","input":input.clone()}), Some(4000)).unwrap();
        assert_eq!(preview["input"]["markdown"], "hello");
        assert_eq!(preview["budgetChars"], 4000);
        assert!(preview.get("requestId").is_none());
        registry::validate("record.create.preview", &preview).unwrap();
        assert!(preview_create_params(json!({"input":input.clone(),"surprise":true}), None).is_err());
        assert!(preview_create_params(json!({"input":input,"requestId":5}), None).is_err());
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), serde_json::to_vec(&json!({"input":preview["input"]})).unwrap()).unwrap();
        let args = ["record", "create", "--input-file", file.path().to_str().unwrap(), "--dry-run",
            "--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"];
        let out = invoke(&args);
        assert_ne!(out.exit_code, 2, "{}", out.stderr);
        std::fs::write(file.path(), serde_json::to_vec(&preview).unwrap()).unwrap();
        let args = ["record", "create", "preview", "--input-file", file.path().to_str().unwrap(),
            "--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"];
        let out = invoke(&args);
        assert_ne!(out.exit_code, 2, "{}", out.stderr);
    }
    #[test]
    fn record_create_flags_are_explicit_and_markdown_is_bounded() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), "# note").unwrap();
        let path = file.path().to_str().unwrap();
        let common = ["--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"];
        let check = |words: &[&str], expected: &str| {
            let mut args = words.to_vec();
            args.extend(common);
            let out = invoke(&args);
            assert_eq!(out.exit_code, 2, "{words:?}: {}", out.stderr);
            assert!(out.stderr.contains(expected), "{words:?}: {}", out.stderr);
        };
        check(&["record", "create", "--input-file", path, "--body-file", path], "cannot be combined");
        check(&["record", "create", "--input-file", path, "--title", "Note"], "cannot accompany --input-file");
        check(&["record", "create", "--title", "Note", "--workspace-scope"], "--body-file is required");
        check(&["record", "create", "--title", "Note", "--body-file", path, "--workspace-scope", "--budget-chars", "4000"], "only supported by record create --dry-run");
        check(&["record", "create", "preview", "--input-file", path, "--dry-run"], "only supported by record patch or record create");
        check(&["todo", "create", "--input-file", path, "--title", "Note"], "--title is only supported by record create");
        let large = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(large.path(), vec![b'x'; 1024 * 1024 + 1]).unwrap();
        let options = Options { workspace_scope: true, title: Some("Note".into()), dry_run: true,
            body_file: Some(large.path().to_str().unwrap().into()), ..Options::default() };
        assert_eq!(record_create_params(&options).unwrap_err().message, "Record Markdown exceeds 1 MiB");
    }
    #[test]
    fn record_restore_shorthand_builds_existing_mutation_dto() {
        let options = Options { object_id: Some("17".into()), version_id: Some("a".repeat(32)),
            base_revision: Some(4), project: Some(3), request_id: Some("restore-stable".into()),
            ..Options::default() };
        let params = record_restore_params(&options).unwrap();
        assert_eq!(params["requestId"], "restore-stable");
        assert_eq!(params["input"]["target"], json!({"scope":{"kind":"project","projectId":3},"recordId":17}));
        assert_eq!(params["input"]["baseRevision"], 4);
        assert_eq!(params["input"]["versionId"], "a".repeat(32));
        registry::validate("record.restore", &params).unwrap();
        assert_eq!(record_restore_params(&Options { version_id: Some("1".into()), ..options }).unwrap_err().message,
            "Invalid Record version ID");
    }
    #[test]
    fn file_update_target_uses_connected_workspace_identity() {
        let options = Options { object_id: Some("9".into()), project: Some(3), expected_version: Some(2),
            expected_hash: Some(format!("sha256:{}", "0".repeat(64))), source_file: Some("local.bin".into()),
            request_id: Some("file-stable".into()), ..Options::default() };
        let binding = WorkspaceBinding { workspace_id: "bound-workspace".into(), generation: "g".into() };
        let target = serde_json::to_value(file_update_target(&options, &binding).unwrap()).unwrap();
        assert_eq!(target["object"]["workspaceId"], "bound-workspace");
        assert_eq!(target["object"]["scope"], json!({"kind":"project","projectId":3}));
        assert_eq!(target["object"]["id"], "9");
        assert!(target.to_string().find("local.bin").is_none());
        let invalid_hash = Options { expected_hash: Some("bad".into()), ..options };
        assert_eq!(file_update_identity(&invalid_hash).unwrap_err().message, "Invalid expected File hash");
    }
    #[test]
    fn restore_and_file_update_reject_missing_or_mixed_shorthand_flags() {
        let common = ["--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"];
        let check = |words: &[&str], expected: &str| {
            let mut args = words.to_vec();
            args.extend(common);
            let out = invoke(&args);
            assert_eq!(out.exit_code, 2, "{words:?}: {}", out.stderr);
            assert!(out.stderr.contains(expected), "{words:?}: {}", out.stderr);
        };
        check(&["record", "restore", "--id", "1", "--workspace-scope", "--request-id", "stable"], "--version is required");
        check(&["record", "restore", "--id", "1", "--version", "a", "--base-revision", "1", "--workspace-scope", "--request-id", "stable"], "Invalid Record version ID");
        check(&["record", "restore", "--id", "1", "--version", "a", "--base-revision", "0", "--workspace-scope", "--request-id", "stable"], "Invalid base revision");
        check(&["record", "restore", "--id", "1", "--input-file", "x.json"], "cannot be combined");
        check(&["file", "update", "--id", "1", "--project", "1", "--source-file", "x.bin", "--request-id", "stable"], "--expected-version is required");
        check(&["file", "update", "--id", "1", "--input-file", "x.json"], "cannot be combined");
        check(&["file", "update", "--id", "1", "--project", "1", "--expected-version", "1", "--expected-hash", "bad", "--source-file", "x.bin", "--request-id", "stable"], "Invalid expected File hash");
        check(&["source", "read", "--id", "1", "--input-file", "x.json"], "--id is only supported");
        check(&["record", "restore", "--source-file", "x.bin"], "only supported by file update");
    }
    #[test]
    fn record_get_uses_bound_workspace_and_body_page_dto() {
        let options = Options { project: Some(7), revision: Some("sha256:abc".into()),
            cursor: Some("page-2".into()), budget_chars: Some(12000), ..Options::default() };
        let (id, scope) = record_get_identity(&options, "23").unwrap();
        let binding = WorkspaceBinding { workspace_id: "bound-workspace".into(), generation: "generation".into() };
        let params = record_get_params(&options, id, scope, &binding);
        assert_eq!(params["object"], json!({"workspaceId":"bound-workspace","scope":{"kind":"project","projectId":7},"kind":"record","id":"23"}));
        assert_eq!(params["revision"], "sha256:abc");
        assert_eq!(params["cursor"], "page-2");
        assert_eq!(params["budgetChars"], 12000);
        registry::validate("record.get", &params).unwrap();
        assert_eq!(record_get_identity(&options, "0").unwrap_err().message, "Invalid Record ID");
    }
    #[test]
    fn record_get_rejects_mixed_modes_and_invalid_bounds_before_connecting() {
        let common = ["--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"];
        let check = |words: &[&str], expected: &str| {
            let mut args = words.to_vec();
            args.extend(common);
            let out = invoke(&args);
            assert_eq!(out.exit_code, 2, "{words:?}: {}", out.stderr);
            assert!(out.stderr.contains(expected), "{words:?}: {}", out.stderr);
        };
        check(&["record", "get", "0", "--project", "1"], "Invalid Record ID");
        check(&["record", "get", "23"], "Choose exactly one");
        check(&["record", "get", "23", "--project", "1", "--workspace-scope"], "Choose exactly one");
        check(&["record", "get", "23", "--project", "1", "--input-file", "input.json"], "cannot be combined");
        check(&["record", "get", "23", "--project", "1", "--body-file", "body.txt"], "does not accept --body-file");
        check(&["record", "get", "--input-file", "input.json", "--project", "1"], "cannot be combined");
        check(&["record", "get", "--input-file", "input.json", "--revision", "r"], "cannot be combined");
        check(&["record", "get", "23", "--project", "1", "--revision", &"x".repeat(129)], "Invalid Record revision");
        check(&["record", "get", "23", "--project", "1", "--cursor", &"x".repeat(2049)], "Invalid Record cursor");
        check(&["record", "get", "23", "--project", "1", "--budget-chars", "12001"], "Invalid character budget");
        check(&["record", "get", "23", "--project", "1", "--source-file", "x.bin"], "only supported by file update");
        check(&["record", "get", "23", "--project", "1", "--dry-run"], "only supported by record patch or record create");
        check(&["record", "get"], "Record ID or --input-file is required");
    }
    #[test]
    fn record_get_input_file_accepts_exact_registered_dto() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let params = json!({"record":{"workspaceId":"w","scope":{"kind":"workspace"},"kind":"record","id":"23"},
            "revision":null,"cursor":null,"budgetChars":4000});
        std::fs::write(file.path(), serde_json::to_vec(&params).unwrap()).unwrap();
        let args = ["record", "get", "--input-file", file.path().to_str().unwrap(),
            "--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"];
        let out = invoke(&args);
        assert_ne!(out.exit_code, 2, "{}", out.stderr);
    }
    #[test]
    fn reference_list_shorthand_builds_bound_dto_and_defaults() {
        let options = Options { object_id: Some("42".into()), kind: Some("record".into()),
            direction: Some("incoming".into()), project: Some(7), ..Options::default() };
        let (id, scope, kind, direction) = reference_list_identity(&options).unwrap();
        let binding = WorkspaceBinding { workspace_id: "bound-workspace".into(), generation: "g".into() };
        let params = reference_list_params(&options, id, scope, kind, direction, &binding);
        assert_eq!(params["object"], json!({"workspaceId":"bound-workspace","scope":{"kind":"project","projectId":7},"kind":"record","id":"42"}));
        assert_eq!(params["direction"], "incoming");
        assert_eq!(params["limit"], 20);
        assert_eq!(params["budgetChars"], 4000);
        assert!(params["cursor"].is_null());
        registry::validate("reference.list", &params).unwrap();
        let custom = Options { limit: Some(50), budget_chars: Some(12000), cursor: Some("next".into()), ..options };
        let (id, scope, kind, direction) = reference_list_identity(&custom).unwrap();
        let params = reference_list_params(&custom, id, scope, kind, direction, &binding);
        assert_eq!(params["limit"], 50);
        assert_eq!(params["budgetChars"], 12000);
        assert_eq!(params["cursor"], "next");
    }
    #[test]
    fn reference_list_rejects_unsupported_kind_scope_and_mixed_flags() {
        let common = ["--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"];
        let check = |words: &[&str], expected: &str| {
            let mut args = words.to_vec();
            args.extend(common);
            let out = invoke(&args);
            assert_eq!(out.exit_code, 2, "{words:?}: {}", out.stderr);
            assert!(out.stderr.contains(expected), "{words:?}: {}", out.stderr);
        };
        check(&["reference", "list", "--id", "1", "--direction", "incoming", "--project", "1"], "--kind is required");
        check(&["reference", "list", "--kind", "other", "--id", "1", "--direction", "incoming", "--project", "1"], "--kind must be");
        check(&["reference", "list", "--kind", "record", "--id", "0", "--direction", "incoming", "--project", "1"], "Invalid object ID");
        check(&["reference", "list", "--kind", "record", "--id", "1", "--direction", "both", "--project", "1"], "--direction must be");
        check(&["reference", "list", "--kind", "record", "--id", "1", "--direction", "incoming"], "Choose exactly one");
        check(&["reference", "list", "--kind", "record", "--id", "1", "--direction", "incoming", "--project", "1", "--limit", "51"], "Invalid reference limit");
        check(&["reference", "list", "--kind", "record", "--id", "1", "--direction", "incoming", "--project", "1", "--cursor", &"x".repeat(2049)], "Invalid reference cursor");
        check(&["reference", "list", "--input-file", "refs.json", "--kind", "record"], "cannot be combined");
        check(&["reference", "list", "--input-file", "refs.json", "--limit", "10"], "cannot be combined");
        check(&["record", "get", "1", "--project", "1", "--kind", "record"], "only supported by reference list");
        check(&["reference", "list", "--kind", "record", "--id", "1", "--direction", "incoming", "--project", "1", "--revision", "r"], "--revision is only supported by record get");
    }
    #[test]
    fn reference_list_input_file_accepts_registered_dto() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let params = json!({"object":{"workspaceId":"w","scope":{"kind":"workspace"},"kind":"todo","id":"9"},
            "direction":"outgoing","cursor":null,"limit":10,"budgetChars":3000});
        std::fs::write(file.path(), serde_json::to_vec(&params).unwrap()).unwrap();
        let args = ["reference", "list", "--input-file", file.path().to_str().unwrap(),
            "--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef", "--json"];
        let out = invoke(&args);
        assert_ne!(out.exit_code, 2, "{}", out.stderr);
    }
}
