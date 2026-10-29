//! Argument handling and presentation for local bridge commands.
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
#[path = "cli_presentation.rs"]
mod cli_presentation;
#[path = "cli_encoding.rs"]
mod cli_encoding;
#[path = "cli_convenience.rs"]
mod cli_convenience;
#[path = "cli_syntax.rs"]
mod cli_syntax;
#[path = "cli_grep.rs"]
mod cli_grep;
#[path = "cli_contacts.rs"]
mod cli_contacts;

const MAX_INPUT_BYTES: u64 = 2 * 1024 * 1024;

pub struct CliOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Default)]
struct Options {
    flags: std::collections::HashSet<String>,
    positionals: Vec<String>,
    version_info: bool,
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
    offset: Option<usize>,
    format: Option<String>,
    all: bool,
    old_text_file: Option<String>,
    new_text_file: Option<String>,
    before_file: Option<String>,
    dry_run: bool,
    json: bool,
    help: bool,
    verbose: bool,
    contact_fields: serde_json::Map<String, Value>,
    notes_file: Option<String>,
}

fn invalid(message: &'static str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}

fn parse_options(args: &[String]) -> AgentResult<Options> {
    parse_options_context(args, false)
}

fn parse_options_context(args: &[String], contacts: bool) -> AgentResult<Options> {
    let mut options = Options::default();
    let mut cursor = 0;
    while cursor < args.len() {
        let raw = args[cursor].as_str();
        if raw == "--" { options.positionals.extend_from_slice(&args[cursor+1..]);break; }
        if !raw.starts_with('-') || raw == "-" { options.positionals.push(raw.to_owned());cursor+=1;continue; }
        let (flag, attached) = cli_syntax::flag(raw);
        let version_info = flag == "--version" && (raw == "-V" || attached.is_none() && args.get(cursor+1).is_none_or(|next|next.starts_with('-')));
        if !options.flags.insert(flag.to_owned()) { return Err(AgentError::new(ErrorCode::InvalidArgument,format!("Duplicate {flag}"))); }
        if matches!(flag,"--json"|"--workspace-scope"|"--all"|"--help"|"--verbose"|"--dry-run"|"--cli-version") && attached.is_some() {
            return Err(AgentError::new(ErrorCode::InvalidArgument,format!("{flag} does not accept a value")));
        }
        if version_info { options.version_info=true;cursor+=1;continue; }
        if flag == "--all" {
            options.all = true; cursor += 1; continue;
        }
        if flag == "--json" {
            options.json = true;
            cursor += 1;
            continue;
        }
        if flag == "--workspace-scope" {
            options.workspace_scope = true;
            cursor += 1;
            continue;
        }
        if flag == "--dry-run" {
            options.dry_run = true;
            cursor += 1;
            continue;
        }
        if flag == "--help" || flag == "--verbose" {
            let option = if flag == "--help" { &mut options.help } else { &mut options.verbose };
            *option = true;
            cursor += 1;
            continue;
        }
        if !matches!(flag, "--workspace" | "--connection" | "--project" | "--query"
            | "--budget-chars" | "--request-id" | "--input-file" | "--patch-file"
            | "--body-file" | "--name" | "--title" | "--priority" | "--due-date"
            | "--id" | "--version" | "--base-revision" | "--source-file"
            | "--expected-version" | "--expected-hash" | "--revision" | "--cursor"
            | "--kind" | "--direction" | "--limit" | "--offset" | "--out" | "--format" | "--old-text-file" | "--new-text-file" | "--before-file")
            && !(contacts && cli_contacts::field_key(flag).is_some()) && !(contacts && flag == "--notes-file") {
            return Err(AgentError::new(ErrorCode::InvalidArgument, format!("Unknown option: {flag}")));
        }
        let (value, consumed) = match attached {
            Some(value) => (value,1),
            None => {
                let value=args.get(cursor+1).filter(|value| !value.starts_with("--") && !matches!(value.as_str(),"-h"|"-V"))
                    .ok_or_else(||AgentError::new(ErrorCode::InvalidArgument,format!("Missing value for {flag}")))?;
                (value.as_str(),2)
            }
        };
        match flag {
            "--format" => {
                if !matches!(value, "text" | "markdown" | "json" | "plain" | "cat") { return Err(invalid("--format must be text, plain (cat), markdown or json")); }
                options.format = Some(if value == "cat" {"plain"} else {value}.to_owned());
            }
            "--old-text-file" => options.old_text_file = Some(value.to_owned()),
            "--new-text-file" => options.new_text_file = Some(value.to_owned()),
            "--before-file" => options.before_file = Some(value.to_owned()),
            "--workspace" => options.workspace = Some(PathBuf::from(value)),
            "--connection" => options.connection = Some(value.to_owned()),
            "--project" => {
                let id = value.parse::<i64>().map_err(|_| invalid("Invalid project ID"))?;
                if id <= 0 { return Err(invalid("Invalid project ID")); }
                options.project = Some(id);
            }
            "--query" => options.query = Some(value.to_owned()),
            "--budget-chars" => {
                let budget = value.parse::<usize>().map_err(|_| invalid("Invalid character budget"))?;
                if !(1..=12000).contains(&budget) { return Err(invalid("Invalid character budget")); }
                options.budget_chars = Some(budget);
            }
            "--request-id" => {
                if value.is_empty() { return Err(invalid("--request-id must not be empty")); }
                options.request_id = Some(value.to_owned());
            }
            "--out" => options.out = Some(value.to_owned()),
            "--input-file" => options.input_file = Some(value.to_owned()),
            "--patch-file" => options.patch_file = Some(value.to_owned()),
            "--body-file" => options.body_file = Some(value.to_owned()),
            "--name" => options.name = Some(value.to_owned()),
            "--title" => options.title = Some(value.to_owned()),
            "--priority" => options.priority = Some(value.to_owned()),
            "--due-date" => options.due_date = Some(value.to_owned()),
            "--id" => options.object_id = Some(value.to_owned()),
            "--version" => options.version_id = Some(value.to_owned()),
            "--base-revision" => {
                let revision = value.parse::<u64>().map_err(|_| invalid("Invalid base revision"))?;
                if revision == 0 { return Err(invalid("Invalid base revision")); }
                options.base_revision = Some(revision);
            }
            "--source-file" => options.source_file = Some(value.to_owned()),
            "--expected-version" => {
                let version = value.parse::<u32>().map_err(|_| invalid("Invalid expected version"))?;
                if version == 0 { return Err(invalid("Invalid expected version")); }
                options.expected_version = Some(version);
            }
            "--expected-hash" => options.expected_hash = Some(value.to_owned()),
            "--revision" => options.revision = Some(value.to_owned()),
            "--cursor" => options.cursor = Some(value.to_owned()),
            "--kind" => options.kind = Some(value.to_owned()),
            "--direction" => options.direction = Some(value.to_owned()),
            "--limit" => {
                let limit = value.parse::<usize>().map_err(|_| invalid("Invalid reference limit"))?;
                options.limit = Some(limit);
            }
            "--offset" => {
                let offset = value.parse::<usize>().map_err(|_| invalid(if contacts {"Invalid contact offset (must be at least 0)"} else {"Invalid line offset (must be at least 1)"}))?;
                if !contacts && offset == 0 { return Err(invalid("Invalid line offset (must be at least 1)")); }
                options.offset = Some(offset);
            }
            "--notes-file" if contacts => options.notes_file = Some(value.to_owned()),
            _ if contacts && cli_contacts::field_key(flag).is_some() => {
                options.contact_fields.insert(cli_contacts::field_key(flag).expect("contact field").into(),json!(value));
            }
            _ => return Err(AgentError::new(ErrorCode::InvalidArgument,format!("Invalid value for {flag}"))),
        }
        cursor += consumed;
    }
    Ok(options)
}

fn required_connection(options: &Options) -> AgentResult<(&PathBuf, &str)> {
    let workspace = options.workspace.as_ref().ok_or_else(|| invalid("--workspace is required"))?;
    if workspace.as_os_str().is_empty() { return Err(invalid("--workspace must not be empty")); }
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
    cli_encoding::parse_json(&bytes)
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
    read_text_file(path, "--body-file")
}

fn read_text_file(path: &str, flag: &'static str) -> AgentResult<String> {
    let source: Box<dyn Read> = if path == "-" {
        Box::new(std::io::stdin())
    } else {
        Box::new(std::fs::File::open(path).map_err(|_| AgentError::new(ErrorCode::InvalidArgument,format!("Cannot read {flag}")))?)
    };
    let mut bytes = Vec::new();
    source.take(MAX_INPUT_BYTES + 1).read_to_end(&mut bytes)
        .map_err(|_| AgentError::new(ErrorCode::InvalidArgument,format!("Cannot read {flag}")))?;
    if bytes.len() as u64 > MAX_INPUT_BYTES { return Err(AgentError::new(ErrorCode::InvalidArgument,format!("{flag} exceeds 2 MiB"))); }
    cli_encoding::decode_utf8(&bytes).map(str::to_owned)
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
        ("file.get", _) => "source.read",
        ("record.replace" | "record.append" | "record.edit", true) => "record.text.patch.preview",
        ("record.replace" | "record.append" | "record.edit", false) => "record.text.patch",
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
        "revision":options.revision.as_deref(),"cursor":options.cursor.as_deref(),"budgetChars":options.budget_chars,
        "format":if options.format.as_deref()==Some("markdown") || (!options.json && options.format.is_none()) {"markdown"} else {"text"},
        "offset":options.offset,"limit":options.limit})
}

fn reference_list_identity(options: &Options) -> AgentResult<(i64, Scope, &str, &str)> {
    if options.limit.is_some_and(|limit| !(1..=50).contains(&limit)) { return Err(invalid("Invalid reference limit")); }
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
    let result = (|| {
        let mut options = parse_options(args)?;
        for flag in &options.flags {
            if !matches!(flag.as_str(),"--workspace"|"--connection"|"--help"|"--version") {
                return Err(AgentError::new(ErrorCode::InvalidArgument,format!("Unsupported option for mcp serve: {flag}")));
            }
        }
        if !options.positionals.is_empty() { return Err(invalid("mcp serve does not accept positional arguments")); }
        if options.help { print!("{}",cli_help::command("mcp.serve"));return Ok(()); }
        if options.version_info { println!("mind {}",env!("CARGO_PKG_VERSION"));return Ok(()); }
        cli_convenience::environment(&mut options,"mcp.serve",|name|std::env::var(name).ok())?;
        let (workspace,connection)=required_connection(&options)?;
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()
            .map_err(|_| AgentError::new(ErrorCode::RuntimeUnavailable, "Cannot start MCP runtime"))?;
        runtime.block_on(async {
            let server = MindMcp::connect(workspace, connection).await?;
            server.serve_stdio().await.map_err(|_| AgentError::new(ErrorCode::RuntimeUnavailable, "MCP stdio transport failed"))
        })
    })();
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

// A command owns one transport session. Record continuations must never
// rediscover the runtime or reconnect to a different Workspace generation.
trait CliBridge {
    fn binding(&mut self, workspace: &Path, connection: &str, request_id: &str) -> AgentResult<WorkspaceBinding>;
    fn call(&mut self, workspace: &Path, connection: &str, method: &str, params: Value, request_id: &str) -> AgentResult<Value>;
}

#[derive(Default)]
struct LiveBridge(Option<(BridgeClient, WorkspaceBinding)>);

impl CliBridge for LiveBridge {
    fn binding(&mut self, workspace: &Path, connection: &str, request_id: &str) -> AgentResult<WorkspaceBinding> {
        if self.0.is_none() {
            let client = BridgeClient::discover(connection)?;
            let binding = client.connect(connection, workspace, request_id)?;
            self.0 = Some((client, binding));
        }
        Ok(self.0.as_ref().expect("connected session").1.clone())
    }

    fn call(&mut self, workspace: &Path, connection: &str, method: &str, params: Value, request_id: &str) -> AgentResult<Value> {
        self.binding(workspace, connection, request_id)?;
        let (client, binding) = self.0.as_ref().expect("connected session");
        client.call(connection, binding, method, params, request_id)
    }
}

pub fn run(args: &[String]) -> CliOutput {
    run_with_bridge(args, &mut LiveBridge::default())
}

/// Writes completed read pages immediately. Returned stdout contains only output
/// that has not already been delivered to the callback.
pub fn run_streamed(args: &[String], output: &mut dyn FnMut(&str) -> AgentResult<()>) -> CliOutput {
    run_with_bridge_output(args, &mut LiveBridge::default(), Some(output))
}

#[cfg(test)]
fn run_with_bridge_call(
    args: &[String],
    bridge_call: impl FnOnce(&Path, &str, &str, Value, &str) -> AgentResult<Value>,
) -> CliOutput {
    struct SingleCall<F>(Option<F>);
    impl<F: FnOnce(&Path, &str, &str, Value, &str) -> AgentResult<Value>> CliBridge for SingleCall<F> {
        fn binding(&mut self, _: &Path, _: &str, _: &str) -> AgentResult<WorkspaceBinding> {
            Ok(WorkspaceBinding { workspace_id: "test-workspace".into(), generation: "test-generation".into() })
        }
        fn call(&mut self, workspace: &Path, connection: &str, method: &str, params: Value, request_id: &str) -> AgentResult<Value> {
            self.0.take().expect("single bridge call")(workspace, connection, method, params, request_id)
        }
    }
    run_with_bridge(args, &mut SingleCall(Some(bridge_call)))
}

fn run_with_bridge(args: &[String], bridge: &mut impl CliBridge) -> CliOutput {
    run_with_bridge_output(args, bridge, None)
}

fn run_with_bridge_output(args: &[String], bridge: &mut impl CliBridge, mut output: Option<&mut dyn FnMut(&str) -> AgentResult<()>>) -> CliOutput {
    if args.first().is_some_and(|arg| arg == "contact") {
        return cli_contacts::run(&args[1..],bridge);
    }
    if args.first().is_some_and(|arg| arg == "grep") {
        return cli_grep::run(&args[1..],bridge,output.take());
    }
    let words = args.iter().map(String::as_str).collect::<Vec<_>>();
    match words.as_slice() {
        ["--version"] | ["-V"] => return CliOutput { stdout: format!("mind {}\n", env!("CARGO_PKG_VERSION")), stderr: String::new(), exit_code: 0 },
        [] | ["--help"] | ["-h"] | ["help"] => return CliOutput { stdout: HELP.into(), stderr: String::new(), exit_code: 0 },
        ["mcp", "serve", "--help" | "-h"] => return CliOutput { stdout: cli_help::command("mcp.serve"), stderr: String::new(), exit_code: 0 },
        ["mcp", "serve", ..] => return CliOutput { stdout: String::new(), stderr: "MCP serve must own stdio; use the mind executable\n".into(), exit_code: 2 },
        _ => {}
    }
    let (command, option_args) = match words.as_slice() {
        ["capabilities", ..] => ("capabilities", &args[1..]),
        ["schema", ..] => ("schema", &args[1..]),
        ["doctor", ..] => ("doctor", &args[1..]),
        ["connection", "status", ..] => ("connection.status", &args[2..]),
        ["project", "list", ..] => ("project.list", &args[2..]),
        ["context", "get", ..] => ("context.get", &args[2..]),
        ["search", ..] => ("search", &args[1..]),
        ["context", "overview", "get", ..] => ("context.overview.get", &args[3..]),
        ["knowledge", "search", ..] => ("knowledge.search", &args[2..]),
        ["knowledge", "get", ..] => ("knowledge.get", &args[2..]),
        ["source", "search", ..] => ("source.search", &args[2..]),
        ["source", "read", ..] => ("source.read", &args[2..]),
        ["reference", "list", ..] => ("reference.list", &args[2..]),
        ["record", "blocks", "get", ..] => ("record.blocks.get", &args[3..]),
        ["record", "get", ..] => ("record.get", &args[2..]),
        ["record", "create", "preview", ..] => ("record.create.preview", &args[3..]),
        ["record", "create", ..] => ("record.create", &args[2..]),
        ["record", "text", "patch", "preview", ..] => ("record.text.patch.preview", &args[4..]),
        ["record", "text", "patch", ..] => ("record.text.patch", &args[3..]),
        ["record", "patch", "preview", ..] => ("record.patch.preview", &args[3..]),
        ["record", "patch", ..] => ("record.patch", &args[2..]),
        ["record", "restore", ..] => ("record.restore", &args[2..]),
        ["record", "versions", "list", ..] => ("record.versions.list", &args[3..]),
        ["record", "versions", "get", ..] => ("record.versions.get", &args[3..]),
        ["record", "versions", "compare", ..] => ("record.versions.compare", &args[3..]),
        ["record", verb @ ("replace" | "append" | "edit"), ..] => (match *verb { "replace"=>"record.replace", "append"=>"record.append", _=>"record.edit" }, &args[2..]),
        ["file", "get", ..] => ("file.get", &args[2..]),
        ["todo", "get", ..] => ("todo.get", &args[2..]),
        ["file", "bytes", "read", ..] => ("file.bytes.read", &args[3..]),
        ["file", "download", ..] => ("file.bytes.read", &args[2..]),
        ["file", "list", ..] => ("file.list", &args[2..]),
        ["session", "list", ..] => ("session.list", &args[2..]),
        ["schedule", "list", ..] => ("schedule.list", &args[2..]),
        ["schedule", "create", ..] => ("schedule.create", &args[2..]),
        ["schedule", "update", ..] => ("schedule.update", &args[2..]),
        ["schedule", "run", ..] => ("schedule.run", &args[2..]),
        ["schedule", "delete", ..] => ("schedule.delete", &args[2..]),
        ["record", "list", ..] => ("record.list", &args[2..]),
        ["todo", "list", ..] => ("todo.list", &args[2..]),
        ["todo", "create", ..] => ("todo.create", &args[2..]),
        ["todo", "update", ..] => ("todo.update", &args[2..]),
        ["file", "versions", "list", ..] => ("file.versions.list", &args[3..]),
        ["file", "versions", "get", ..] => ("file.versions.get", &args[3..]),
        ["file", "source", "read", ..] => ("file.source.read", &args[3..]),
        ["file", "create", ..] => ("file.create", &args[2..]),
        ["file", "patch", ..] => ("file.patch", &args[2..]),
        ["file", "restore", ..] => ("file.version.restore", &args[2..]),
        ["file", "version", "restore", ..] => ("file.version.restore", &args[3..]),
        ["file", "update", ..] => ("file.update", &args[2..]),
        ["file", "content", "begin", ..] => ("file.content.begin", &args[3..]),
        ["file", "content", "chunk", ..] => ("file.content.chunk", &args[3..]),
        ["file", "content", "complete", ..] => ("file.content.complete", &args[3..]),
        ["file", "content", "status", ..] => ("file.content.status", &args[3..]),
        ["file", "upload", ..] => ("file.upload", &args[2..]),
        ["operation", "get", ..] => ("operation.get", &args[2..]),
        ["operation", "list", ..] => ("operation.list", &args[2..]),
        ["operation", "undo", ..] => ("operation.undo", &args[2..]),
        ["operation", "restore-created", ..] => ("operation.restore_created", &args[2..]),
        _ => {
            if let [path @ .., "--help" | "-h"] = words.as_slice() {
                if let Some(help) = cli_help::group(&path.join(".")) {
                    return CliOutput { stdout: help, stderr: String::new(), exit_code: 0 };
                }
            }
            return response(request_id(), Err(invalid("Unknown command; see mind --help")));
        }
    };
    let mut options = match parse_options(option_args) {
        Ok(options) => options,
        Err(error) => return response(request_id(), Err(error)),
    };
    if options.version_info { return CliOutput{stdout:format!("mind {}\n",env!("CARGO_PKG_VERSION")),stderr:String::new(),exit_code:0}; }
    if options.positionals.len()>1 {
        return response(request_id(),Err(AgentError::new(ErrorCode::InvalidArgument,format!("{command} accepts at most one positional argument; quote a multiword query"))));
    }
    if !options.positionals.is_empty() && !matches!(command,"schema"|"search"|"source.search"|"record.get"|"todo.get"|"file.get"|"record.replace"|"record.append"|"record.edit") {
        return response(request_id(),Err(AgentError::new(ErrorCode::InvalidArgument,format!("{command} does not accept positional arguments"))));
    }
    if options.json && options.format.as_deref().is_some_and(|f| f != "json") {
        return response(request_id(), Err(invalid("--json conflicts with a non-JSON --format")));
    }
    if options.format.as_deref() == Some("json") { options.json = true; }
    if !options.help && !matches!(command,"schema"|"capabilities") {
        if let Err(error) = cli_convenience::environment(&mut options, command, |name| std::env::var(name).ok()) {
            return response(request_id(), Err(error));
        }
    }
    if matches!(command,"record.replace"|"record.append"|"record.edit") && options.format.is_none() {
        options.json = true;
    }
    let positional=options.positionals.first().map(String::as_str);
    let human = !options.json && (cli_presentation::supports(command) || matches!(command,"todo.get"|"file.get"|"source.read"));
    if !options.json && !options.help && !human {
        return response(request_id(), Err(invalid("This command requires --json")));
    }
    if options.verbose && !matches!(command, "capabilities" | "doctor") {
        return response(request_id(), Err(invalid("--verbose is only supported by capabilities and doctor")));
    }
    if options.help {
        return CliOutput { stdout: cli_help::command(command), stderr: String::new(), exit_code: 0 };
    }
    if matches!(command, "capabilities" | "schema") {
        if options.flags.iter().any(|flag| !matches!(flag.as_str(), "--json" | "--verbose" | "--format")) {
            return response(request_id(), Err(invalid("Discovery commands accept only --json and capabilities --verbose")));
        }
        return response(request_id(), if command == "capabilities" {
            Ok(capabilities_data(options.verbose))
        } else {
            positional.and_then(registry::schema).ok_or_else(|| invalid("Unknown bridge method; use mind capabilities --json"))
        });
    }
    if options.input_file.is_some() && !options.positionals.is_empty() {
        return response(request_id(),Err(invalid("Positional query or ID cannot be combined with --input-file")));
    }
    if options.input_file.is_some() && options.patch_file.is_some() {
        return response(request_id(), Err(invalid("--input-file and --patch-file cannot be combined")));
    }
    if options.input_file.is_some() && options.body_file.is_some() && command != "file.upload" {
        return response(request_id(), Err(invalid("--input-file and --body-file cannot be combined")));
    }
    let mut streamed_diagnostics = String::new();
    let text_edit = matches!(command,"record.replace"|"record.append"|"record.edit");
    let restore_flags = options.version_id.is_some() || options.base_revision.is_some();
    let file_update_flags = options.source_file.is_some() || options.expected_version.is_some() || options.expected_hash.is_some();
    let mut request_id = options.request_id.clone().unwrap_or_else(request_id);
    let result = (|| {
        let (workspace, connection) = required_connection(&options)?;
        let inventory = matches!(command, "file.list" | "record.list" | "todo.list" | "session.list");
        if options.out.is_some() && command != "file.bytes.read" { return Err(invalid("--out is only supported by file download")); }
        if command == "file.bytes.read" && options.out.is_none() { return Err(invalid("--out is required for file download")); }
        if restore_flags && command != "record.restore" && !text_edit {
            return Err(invalid("--version and --base-revision are only supported by record restore"));
        }
        if file_update_flags && command != "file.update" && !(command == "file.create" && options.source_file.is_some() && options.expected_hash.is_none() && options.expected_version.is_none()) {
            return Err(invalid("--source-file and expected baseline options are only supported by file update"));
        }
        if options.object_id.is_some() && !matches!(command, "record.get" | "todo.get" | "file.get" | "source.read" | "record.restore" | "file.update" | "reference.list" | "record.replace" | "record.append" | "record.edit") {
            return Err(invalid("--id is only supported by record get, record restore, file update and reference list"));
        }
        if options.revision.is_some() && !matches!(command,"record.get"|"file.get"|"source.read") {
            return Err(invalid("--revision is only supported by record get"));
        }
        if options.cursor.is_some() && !matches!(command, "record.get" | "file.get" | "source.read" | "search" | "source.search" | "reference.list") && !inventory {
            return Err(invalid("--cursor is only supported by record get and reference list"));
        }
        if options.offset.is_some() && command != "record.get" {
            return Err(invalid("--offset is only supported by record get"));
        }
        if command == "record.get" && options.limit == Some(0) {
            return Err(invalid("Invalid line limit (must be at least 1)"));
        }
        if inventory && options.limit.is_some_and(|limit| limit > 50) {
            return Err(invalid("Invalid list limit (maximum 50)"));
        }
        if (options.kind.is_some() && !matches!(command,"search"|"source.search"|"source.read") || options.direction.is_some() || (options.limit.is_some() && !inventory && !matches!(command,"record.get"|"search"|"source.search"))) && command != "reference.list" {
            return Err(invalid("--kind, --direction and --limit are only supported by reference list"));
        }
        if options.input_file.is_some() && (restore_flags || file_update_flags || options.object_id.is_some()) {
            return Err(invalid("--input-file cannot be combined with shorthand object options"));
        }
        if options.patch_file.is_some() && !matches!(command, "record.patch" | "file.patch" | "todo.update") {
            return Err(invalid("--patch-file is only supported by record patch, file patch and todo update"));
        }
        if options.dry_run && !matches!(command, "record.patch" | "record.create") && !text_edit {
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
        cli_convenience::validate_options(&options, command)?;
        if text_edit {
            let id = cli_convenience::object_id(&options, positional)?;
            let binding = bridge.binding(workspace, connection, &request_id)?;
            let params = cli_convenience::text_edit_params(&options, command, id, &binding)?;
            let method = bridge_method(command, options.dry_run);
            registry::validate(method, &params)?;
            if !options.dry_run { request_id = write_request_id(&options, &params)?; }
            return bridge.call(workspace, connection, method, params, &request_id);
        }
        if matches!(command,"todo.get"|"file.get"|"source.read") && options.input_file.is_none() {
            let id = cli_convenience::object_id(&options, positional)?;
            let binding = bridge.binding(workspace, connection, &request_id)?;
            let params = cli_convenience::get_params(&options, command, id, &binding)?;
            let method = bridge_method(command, false);
            registry::validate(method, &params)?;
            if command == "todo.get" { return bridge.call(workspace,connection,method,params,&request_id); }
            return if options.format.as_deref() == Some("plain") {
                cli_presentation::source_read_plain_with_output(params, options.json, None, None, |params| bridge.call(workspace,connection,method,params,&request_id), output.take())
            } else { cli_presentation::source_read_with_output(params, options.json, None, None, |params| bridge.call(workspace,connection,method,params,&request_id), output.take()) };
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
        if command == "record.get" && (positional.is_some() || options.object_id.is_some()) {
            if positional.is_some() && options.object_id.is_some() {
                return Err(invalid("Record ID and --id cannot be combined"));
            }
            if options.body_file.is_some() {
                return Err(invalid("record get does not accept --body-file"));
            }
            if options.input_file.is_some() {
                return Err(invalid("Record ID and --input-file cannot be combined"));
            }
            let (record_id, scope) = record_get_identity(&options, positional.or(options.object_id.as_deref()).expect("record ID"))?;
            let binding = bridge.binding(workspace, connection, &request_id)?;
            let params = record_get_params(&options, record_id, scope, &binding);
            registry::validate("record.get", &params)?;
            return cli_convenience::read_record(&options, params, |params| {
                bridge.call(workspace, connection, "record.get", params, &request_id)
            }, output.take());
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
        let mut params = match command {
            "doctor" | "connection.status" | "project.list" | "schedule.list" => {
                if options.input_file.is_some() || options.project.is_some() || options.workspace_scope || options.query.is_some() || options.budget_chars.is_some() {
                    return Err(invalid("This command accepts only Workspace and connection options"));
                }
                json!({})
            }
            "context.get" => {
                if let Some(path) = options.input_file.as_deref() {
                    reject_scope_options(&options)?;
                    read_input(path)?
                } else {
                    if options.budget_chars.is_some_and(|budget| budget > 3000) { return Err(invalid("Context budget must be at most 3000 characters")); }
                    serde_json::to_value(ContextGetInput { scope: scoped(&options)?, query: options.query.clone(), budget_chars: options.budget_chars }).expect("context input JSON")
                }
            }
            "search" | "source.search" if options.input_file.is_none() => {
                if options.input_file.is_some() { return Err(invalid("search does not accept --input-file; use source search for a DTO")); }
                if positional.is_some() && options.query.is_some() { return Err(invalid("Search QUERY and --query cannot be combined")); }
                cli_convenience::search_params(&options, positional)?
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
            "file.list" | "record.list" | "todo.list" | "session.list" => {
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
        if human && method == "source.search" {
            if let Some(input) = params.as_object_mut() {
                if input.get("budgetChars").is_none_or(Value::is_null) {
                    input.insert("budgetChars".into(), json!(12000));
                }
            }
        }
        if command == "record.patch" && !options.dry_run {
            request_id = write_request_id(&options, &params)?;
        }
        if command == "record.get" && options.input_file.is_some() {
            if !options.json && options.format.is_none() && params.get("format").is_none_or(Value::is_null) { params["format"]=json!("markdown"); }
            if let Some(format) = options.format.as_deref().filter(|f| *f != "json") { params["format"] = json!(format); }
            if let Some(offset) = options.offset { params["offset"] = json!(offset); }
            if let Some(limit) = options.limit { params["limit"] = json!(limit); }
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
        let data = if method == "source.search" && options.all {
            return cli_convenience::search_all(params, options.format.as_deref()==Some("plain"), |params| bridge.call(workspace,connection,method,params,&request_id), output.take(), &mut streamed_diagnostics);
        } else if command == "record.get" {
            cli_convenience::read_record(&options, params, |params| {
                bridge.call(workspace, connection, method, params, &request_id)
            }, output.take())?
        } else if method == "source.read" && human {
            if options.format.as_deref()==Some("plain") {
                cli_presentation::source_read_plain_with_output(params, false, None, None, |params| bridge.call(workspace,connection,method,params,&request_id), output.take())?
            } else { cli_presentation::source_read_with_output(params, false, None, None, |params| bridge.call(workspace,connection,method,params,&request_id), output.take())? }
        } else {
            bridge.call(workspace, connection, method, params, &request_id)?
        };
        if command == "doctor" {
            return Ok(doctor_data(workspace, data, options.verbose));
        }
        if command == "file.bytes.read" {
            return cli_upload::save_download(data, options.out.as_deref().expect("output path"));
        }
        Ok(data)
    })();
    if human {
        let mut out = if options.all && result.is_ok() {
            CliOutput { stdout: result.unwrap().as_str().unwrap_or("").to_owned(), stderr:String::new(), exit_code:0 }
        } else if options.format.as_deref()==Some("plain") { cli_presentation::response_plain(command,result) } else { cli_presentation::response(command, result) };
        out.stderr.insert_str(0, &streamed_diagnostics);
        return out;
    }
    let mut out = response(request_id, result);
    if command == "record.get" && out.exit_code == 2 {
        out.stderr.push_str(&cli_help::command(command));
    }
    out
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
    fn shared_syntax_preserves_literal_shell_characters_and_terminator_queries() {
        let literal = "中文 空格 ' \" ` $ () & | ; [] {} * ? ! % # <> = \\\\?\\D:\\路径";
        for query_args in [vec![format!("--query={literal}")],vec!["--query".into(),literal.into()],vec!["--".into(),literal.into()],vec!["--".into(),"--starts-with-dashes".into()],vec!["--query=--starts-with-dashes".into()]] {
            let mut args=read_args(&["search","--workspace-scope","--format=json"]);
            let expected=if query_args.last().unwrap().starts_with("--query=") {query_args[0].strip_prefix("--query=").unwrap().to_owned()} else {query_args.last().unwrap().to_owned()};
            args.extend(query_args);
            let out=run_with_bridge_call(&args,|_,_,method,params,_| {
                assert_eq!(method,"source.search");assert_eq!(params["query"],expected);Ok(json!({"items":[],"hasMore":false,"staleCount":0}))
            });assert_eq!(out.exit_code,0,"{}",out.stderr);
        }
        for words in [vec!["-h"],vec!["search","-h"],vec!["record","-h"],vec!["-V"],vec!["record","get","-V"],vec!["record","get","--version"]] {
            let out=invoke(&words);assert_eq!(out.exit_code,0,"{words:?}: {}",out.stderr);
        }
        for (words,message) in [
            (vec!["search","--query=a","--query","b"],"Duplicate --query"),
            (vec!["search","--query"],"Missing value for --query"),
            (vec!["search","--all=yes"],"--all does not accept a value"),
            (vec!["search","--","a","b"],"at most one positional argument")
        ] { let out=invoke(&words);assert_eq!(out.exit_code,2);assert!(out.stderr.contains(message),"{}",out.stderr); }
        let out=invoke(&["schema","record.get","--format=json"]);assert_eq!(out.exit_code,0,"{}",out.stderr);
    }
    #[test]
    fn common_get_ids_and_json_line_windows_reach_native_methods() {
        for entity in ["record","todo","file"] {
            for ids in [vec!["44"],vec!["--id","44"]] {
                let mut words=vec![entity,"get"]; words.extend(ids); words.extend(["--workspace-scope","--format","json"]);
                let out=run_with_bridge_call(&read_args(&words),|_,_,method,params,_| {
                    let object=match entity {"todo"=>&params["target"],"file"=>&params["source"]["object"],_=>&params["object"]};
                    assert_eq!(method,if entity=="file" {"source.read".to_string()} else {format!("{entity}.get")});
                    assert_eq!(object["id"],"44");assert_eq!(object["kind"],entity);
                    Ok(json!({"native":"untouched"}))
                });
                assert_eq!(out.exit_code,0,"{}",out.stderr);
                let data:Value=serde_json::from_str(&out.stdout).unwrap();assert_eq!(data["data"]["native"],"untouched");
            }
        }
        let out=run_with_bridge_call(&read_args(&["record","get","44","--workspace-scope","--offset","100","--limit","2","--json"]),|_,_,_,params,_| {
            assert_eq!(params["offset"],100);assert_eq!(params["limit"],2);Ok(json!({"window":"server"}))
        });
        assert_eq!(out.exit_code,0,"{}",out.stderr);
    }
    #[test]
    fn text_edit_shortcuts_dispatch_native_intents_and_preview_without_mutation_id() {
        let root=tempfile::tempdir().unwrap();
        let old=root.path().join("old.txt");let new=root.path().join("new.txt");
        std::fs::write(&old,"旧文字").unwrap();std::fs::write(&new,"新文字").unwrap();
        for (verb,files,kind) in [
            ("replace",vec!["--old-text-file",old.to_str().unwrap(),"--new-text-file",new.to_str().unwrap()],"replace"),
            ("append",vec!["--body-file",new.to_str().unwrap()],"append"),
            ("edit",vec!["--before-file",old.to_str().unwrap(),"--body-file",new.to_str().unwrap()],"markdown")
        ] {
            for preview in [false,true] {
                let mut words=vec!["record",verb,"44","--workspace-scope","--base-revision","7"];
                words.extend(files.clone());
                if preview {words.push("--dry-run");} else {words.extend(["--request-id","edit-1"]);}
                let out=run_with_bridge_call(&read_args(&words),|_,_,method,params,request_id| {
                    assert_eq!(method,if preview {"record.text.patch.preview"} else {"record.text.patch"});
                    assert_eq!(params["record"]["id"],"44");assert_eq!(params["baseRevision"],7);assert_eq!(params["edit"]["kind"],kind);
                    if preview {assert!(params.get("requestId").is_none());} else {assert_eq!(params["requestId"],"edit-1");assert_eq!(request_id,"edit-1");}
                    Ok(json!({"delivered":true}))
                });assert_eq!(out.exit_code,0,"{verb}: {}",out.stderr);
            }
        }
    }
    #[test]
    fn session_list_and_search_shorthand_reach_registered_contracts() {
        let out=run_with_bridge_call(&read_args(&["session","list","--project","7","--query","排期","--cursor","next","--limit","8","--json"]),|_,_,method,params,_| {
            assert_eq!(method,"session.list");assert_eq!(params["titleQuery"],"排期");assert_eq!(params["cursor"],"next");Ok(json!({}))
        });assert_eq!(out.exit_code,0,"{}",out.stderr);
        for command in [vec!["search","火车"],vec!["source","search","火车"]] {
            let mut words=command;words.extend(["--workspace-scope","--kind","record,file","--limit","50","--cursor","next","--json"]);
            let out=run_with_bridge_call(&read_args(&words),|_,_,method,params,_| {
                assert_eq!(method,"source.search");assert_eq!(params["kinds"],json!(["record","file"]));assert_eq!(params["cursor"],"next");Ok(json!({"items":[],"hasMore":false,"staleCount":0}))
            });assert_eq!(out.exit_code,0,"{}",out.stderr);
        }
    }
    #[test]
    fn conflicting_formats_and_all_json_are_rejected_before_io() {
        for words in [vec!["record","get","44","--workspace-scope","--format","markdown","--json"],vec!["search","terms","--workspace-scope","--all","--json"],vec!["todo","get","44","--workspace-scope","--format","markdown"]] {
            let out=run_with_bridge_call(&read_args(&words),|_,_,_,_,_|panic!("must reject before I/O"));assert_eq!(out.exit_code,2,"{}",out.stderr);
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
        assert!(invoke(&["--help"]).stdout.contains("--workspace PATH --connection ID"));
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
        assert!(root.stdout.contains("mind record|todo|file get ID"));
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
        assert!(out.stderr.contains("Missing value for --input-file"));
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
            assert!(out.stderr.contains(if action == "get" {"Object ID or --id is required"} else {"--input-file is required"}), "{action}: {}", out.stderr);
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
        assert!(mixed.stderr.contains("cannot be combined"));
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
        check(&["source", "read", "--id", "1", "--input-file", "x.json"], "cannot be combined");
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
    fn read_args(words: &[&str]) -> Vec<String> {
        words.iter().copied().chain(["--workspace", "/tmp", "--connection", "0123456789abcdef0123456789abcdef"])
            .map(str::to_owned).collect()
    }

    struct PagedBridge {
        binding_calls: usize,
        requests: Vec<(Value, String)>,
    }
    impl CliBridge for PagedBridge {
        fn binding(&mut self, _: &Path, _: &str, _: &str) -> AgentResult<WorkspaceBinding> {
            self.binding_calls += 1;
            assert_eq!(self.binding_calls, 1, "one Workspace binding for the command");
            Ok(WorkspaceBinding { workspace_id: "stable-workspace".into(), generation: "stable-generation".into() })
        }
        fn call(&mut self, _: &Path, _: &str, method: &str, params: Value, request_id: &str) -> AgentResult<Value> {
            assert_eq!(method, "record.get");
            assert_eq!(params["object"]["workspaceId"], "stable-workspace");
            if self.requests.is_empty() {
                assert!(params["cursor"].is_null());
            } else {
                assert_eq!(params["revision"], "stable-revision");
                assert_eq!(params["cursor"], "continuation");
                assert_eq!(self.requests[0].1, request_id);
                assert_eq!(self.requests[0].0["object"], params["object"]);
            }
            let cursor = if self.requests.is_empty() { Some("continuation") } else { None };
            let text = if cursor.is_some() { "first\nsec" } else { "ond\nthird" };
            let out = json!({"sourceRef":{"object":params["object"],"revision":"stable-revision","title":"Saved Record","excerpt":""},
                "text":text,"spans":[],"nextCursor":cursor,"complete":cursor.is_none(),"rangeComplete":cursor.is_none()});
            self.requests.push((params, request_id.to_owned()));
            Ok(out)
        }
    }
    #[test]
    fn default_record_read_and_id_alias_share_one_binding_and_pin_pages() {
        for id_args in [vec!["23"], vec!["--id", "23"]] {
            let mut words = vec!["record", "get"];
            words.extend(id_args);
            words.extend(["--workspace-scope", "--offset", "2", "--limit", "1"]);
            let mut bridge = PagedBridge { binding_calls: 0, requests: vec![] };
            let out = run_with_bridge(&read_args(&words), &mut bridge);
            assert_eq!(out.exit_code, 0, "{}", out.stderr);
            assert_eq!(bridge.binding_calls, 1);
            assert_eq!(bridge.requests.len(), 2);
            assert!(out.stdout.contains("2 | second\n"), "{}", out.stdout);
            assert!(!out.stdout.contains("1 | first"));
        }
    }
    #[test]
    fn json_record_read_retains_single_page_envelope_and_request_id() {
        let mut bridge = PagedBridge { binding_calls: 0, requests: vec![] };
        let out = run_with_bridge(&read_args(&["record", "get", "--id", "23", "--workspace-scope", "--request-id", "exact-page", "--json"]), &mut bridge);
        assert_eq!(out.exit_code, 0, "{}", out.stderr);
        assert_eq!(bridge.requests.len(), 1);
        assert_eq!(bridge.binding_calls, 1);
        let actual: Value = serde_json::from_str(&out.stdout).unwrap();
        let expected = json!({"sourceRef":{"object":bridge.requests[0].0["object"],"revision":"stable-revision","title":"Saved Record","excerpt":""},
            "text":"first\nsec","spans":[],"nextCursor":"continuation","complete":false,"rangeComplete":false});
        assert_eq!(actual, serde_json::to_value(ApiResponse::from_result("exact-page".into(), Ok(expected))).unwrap());
    }
    #[test]
    fn search_query_alias_and_json_have_the_same_method_and_input() {
        for query in [vec!["terms"], vec!["--query", "terms"]] {
            for json in [false, true] {
                let mut words = vec!["search"];
                words.extend(query.clone()); words.push("--workspace-scope");
                if json { words.push("--json"); }
                let out = run_with_bridge_call(&read_args(&words), |_, _, method, params, _| {
                    assert_eq!(method, "source.search");
                    assert_eq!(params, json!({"scope":{"kind":"workspace"},"query":"terms","budgetChars":if json { Value::Null } else { json!(12000) }}));
                    Ok(json!({"items":[],"hasMore":false,"staleCount":0,"coverageNote":"Other sources may have incomplete coverage."}))
                });
                assert_eq!(out.exit_code, 0, "{}", out.stderr);
                if json {
                    let actual: Value = serde_json::from_str(&out.stdout).unwrap();
                    assert_eq!(actual["data"]["coverageNote"], "Other sources may have incomplete coverage.");
                    assert!(out.stderr.is_empty());
                } else {
                    assert_eq!(out.stdout, "0 results shown\n");
                    assert!(out.stderr.contains("incomplete coverage"));
                }
            }
        }
    }
    #[test]
    fn native_lists_default_to_text_without_altering_registered_inputs() {
        for entity in ["record", "todo", "file"] {
            let out = run_with_bridge_call(&read_args(&[entity, "list", "--workspace-scope", "--limit", "0"]), |_, _, method, params, _| {
                assert_eq!(method, format!("{entity}.list"));
                assert_eq!(params["limit"], 0);
                assert_eq!(params["scope"], json!({"kind":"workspace"}));
                Ok(json!({"items":[],"totalCount":17,"hasMore":false,"nextCursor":null,"staleCount":0}))
            });
            assert_eq!(out.exit_code, 0, "{}", out.stderr);
            assert_eq!(out.stdout, "0 shown / 17 total\n");
        }
    }
    #[test]
    fn context_input_file_accepts_exact_dto_and_rejects_mixed_shorthand_before_io() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let expected = json!({"scope":{"kind":"project","projectId":7},"query":"navigation","budgetChars":2000});
        std::fs::write(file.path(), serde_json::to_vec(&expected).unwrap()).unwrap();
        let out = run_with_bridge_call(&read_args(&["context", "get", "--input-file", file.path().to_str().unwrap(), "--json"]), |_, _, method, params, _| {
            assert_eq!(method, "context.get"); assert_eq!(params, expected);
            Ok(json!({"navigation":"existing context response"}))
        });
        assert_eq!(out.exit_code, 0, "{}", out.stderr);
        for option in [vec!["--project", "7"], vec!["--workspace-scope"], vec!["--query", "q"], vec!["--budget-chars", "100"]] {
            let mut words = vec!["context", "get", "--input-file", "-", "--json"];
            words.extend(option);
            let out = run_with_bridge_call(&read_args(&words), |_, _, _, _, _| panic!("must reject before I/O"));
            assert_eq!(out.exit_code, 2);
            assert!(out.stderr.contains("cannot accompany --input-file"));
        }
    }
    #[test]
    fn line_options_and_duplicate_aliases_are_validated_before_bridge_io() {
        for words in [
            vec!["record", "get", "23", "--id", "23", "--workspace-scope"],
            vec!["record", "get", "--id", "23", "--input-file", "-"],
            vec!["record", "get", "23", "--workspace-scope", "--offset", "0"],
            vec!["record", "get", "23", "--workspace-scope", "--limit", "0"],
            vec!["search", "terms", "--query", "terms", "--workspace-scope"],
            vec!["search", "terms", "--offset", "1", "--workspace-scope"],
            vec!["record", "list", "--workspace-scope", "--limit", "51"],
        ] {
            let out = run_with_bridge_call(&read_args(&words), |_, _, _, _, _| panic!("must reject before I/O"));
            assert_eq!(out.exit_code, 2, "{words:?}: {}", out.stderr);
        }
    }
    #[test]
    fn invalid_json_positional_record_id_points_to_record_usage_and_input_file() {
        let out = invoke(&read_args(&["record", "get", "{\"object\":{}}", "--workspace-scope", "--json"])
            .iter().map(String::as_str).collect::<Vec<_>>());
        assert_eq!(out.exit_code, 2);
        assert!(out.stderr.contains("Invalid Record ID"));
        assert!(out.stderr.contains("Usage:"));
        assert!(out.stderr.contains("mind record get (ID | --id ID)"));
        assert!(out.stderr.contains("mind record get --input-file"));
    }

    #[test]
    fn human_search_budget_defaults_preserve_explicit_values_and_validate_non_object_dtos() {
        let out = run_with_bridge_call(&read_args(&["search", "q", "--workspace-scope", "--budget-chars", "2000"]), |_, _, _, params, _| {
            assert_eq!(params["budgetChars"], 2000);
            Ok(json!({"items":[],"hasMore":false,"staleCount":0}))
        });
        assert_eq!(out.exit_code, 0, "{}", out.stderr);
        let file = tempfile::NamedTempFile::new().unwrap();
        for value in [json!([]), json!(null), json!("invalid"), json!(1)] {
            std::fs::write(file.path(), serde_json::to_vec(&value).unwrap()).unwrap();
            let out = run_with_bridge_call(&read_args(&["source", "search", "--input-file", file.path().to_str().unwrap()]),
                |_, _, _, _, _| panic!("invalid DTO must be rejected before I/O"));
            assert_eq!(out.exit_code, 2, "{value}: {}", out.stderr);
        }
        for json in [false, true] {
            for budget in [None, Some(2000)] {
                let mut value = json!({"scope":{"kind":"workspace"},"query":"q"});
                if let Some(budget) = budget { value["budgetChars"] = json!(budget); }
                std::fs::write(file.path(), serde_json::to_vec(&value).unwrap()).unwrap();
                let mut words = vec!["source", "search", "--input-file", file.path().to_str().unwrap()];
                if json { words.push("--json"); }
                let out = run_with_bridge_call(&read_args(&words), |_, _, method, params, _| {
                    assert_eq!(method, "source.search");
                    assert_eq!(params["budgetChars"], budget.map(|budget| json!(budget))
                        .unwrap_or_else(|| if json { Value::Null } else { json!(12000) }));
                    Ok(json!({"items":[],"hasMore":false,"staleCount":0}))
                });
                assert_eq!(out.exit_code, 0, "{}", out.stderr);
            }
        }
    }

}

#[cfg(test)]
#[path = "cli_adapter_tests.rs"]
mod adapter_tests;
