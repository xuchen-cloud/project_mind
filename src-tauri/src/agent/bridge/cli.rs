//! Argument handling and JSON output for local bridge commands.
use super::{client::BridgeClient, mcp::MindMcp, registry};
use crate::agent::{
    capabilities::capabilities,
    context::ContextGetInput,
    errors::{AgentError, AgentResult, ApiResponse, ErrorCode},
    models::Scope,
};
use crate::db::file_imports::{validate_agent_file_create, AgentFileCreateInput};
use serde_json::{json, Value};
use std::{io::Read, path::PathBuf};
#[path = "cli_upload.rs"]
mod cli_upload;

const HELP: &str = "mind — Project Mind local CLI\n\nUsage:\n  mind --version\n  mind capabilities --json\n  mind schema METHOD --json\n  mind doctor --workspace PATH --connection ID --json\n  mind project list --workspace PATH --connection ID --json\n  mind context get (--project ID | --workspace-scope) --workspace PATH --connection ID [--query TEXT] [--budget-chars N] --json\n  mind search QUERY (--project ID | --workspace-scope) --workspace PATH --connection ID [--budget-chars N] --json\n  mind context overview get --input-file PATH|- --workspace PATH --connection ID --json\n  mind knowledge search|get --input-file PATH|- --workspace PATH --connection ID --json\n  mind source search|read --input-file PATH|- --workspace PATH --connection ID --json\n  mind session search --input-file PATH|- --workspace PATH --connection ID --json\n  mind session messages read --input-file PATH|- --workspace PATH --connection ID --json\n  mind record blocks get --input-file PATH|- --workspace PATH --connection ID --json\n  mind record versions list|get|compare --input-file PATH|- --workspace PATH --connection ID --json\n  mind todo get --input-file PATH|- --workspace PATH --connection ID --json\n  mind todo create|update --input-file PATH|- --workspace PATH --connection ID --json\n  mind todo create --body-file PATH|- (--project ID | --workspace-scope) [--priority VALUE] [--due-date YYYY-MM-DD] --request-id ID --workspace PATH --connection ID --json\n  mind todo update --patch-file PATH|- --workspace PATH --connection ID --json\n  mind file versions list|get --input-file PATH|- --workspace PATH --connection ID --json\n  mind file source read --input-file PATH|- --workspace PATH --connection ID --json\n  mind file create|patch|update|restore --input-file PATH|- --workspace PATH --connection ID --json\n  mind file create --name NAME --body-file PATH|- --project ID --request-id ID --workspace PATH --connection ID --json\n  mind file patch --patch-file PATH|- --workspace PATH --connection ID --json\n  mind file content begin|chunk|complete|status --input-file PATH|- --workspace PATH --connection ID --json\n  mind file upload --input-file TARGET.json --body-file PATH --request-id ID --workspace PATH --connection ID --json\n  mind record create|restore --input-file PATH|- --workspace PATH --connection ID --json\n  mind record create --title TITLE --body-file PATH|- (--project ID | --workspace-scope) --request-id ID --workspace PATH --connection ID --json\n  mind record create --title TITLE --body-file PATH|- (--project ID | --workspace-scope) --dry-run [--budget-chars N] --workspace PATH --connection ID --json\n  mind record create --input-file PATH|- --dry-run [--budget-chars N] --workspace PATH --connection ID --json\n  mind record create preview --input-file PATH|- --workspace PATH --connection ID --json\n  mind record patch --patch-file PATH|- --workspace PATH --connection ID --json\n  mind record patch --patch-file PATH|- --dry-run [--budget-chars N] --workspace PATH --connection ID --json\n  mind record patch preview --input-file PATH|- --workspace PATH --connection ID --json\n  mind operation get|list|undo|restore-created --input-file PATH|- --workspace PATH --connection ID --json\n  mind mcp serve --workspace PATH --connection ID\n\nUse `mind schema METHOD --json` for the exact input DTO. --input-file - reads JSON from stdin (up to 2 MiB). Write inputs require a stable requestId; reuse the same ID when retrying. Record create/patch --dry-run preview without writing and may omit mutation requestId; --budget-chars applies only to these previews (1–12000, default 4000). Record Markdown is limited to 1 MiB. --patch-file accepts native RecordPatch JSON for record patch, or the existing wrapped mutation JSON for file patch and todo update; it cannot be combined with --input-file. Body file paths stay local; UTF-8 content is sent to the bound application, and generated JSON is limited to 2 MiB. File upload reads up to 100 MiB locally, sends only bytes, and resumes a staged upload by its stable phase IDs. If status reports an expired stage, it checks the same final file.update receipt; an uncommitted expired upload still fails. If --request-id is provided, it must match the input requestId. Example: mind source read --input-file read.json --workspace ./work --connection ID --json\n";
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
    patch_file: Option<String>,
    body_file: Option<String>,
    name: Option<String>,
    title: Option<String>,
    priority: Option<String>,
    due_date: Option<String>,
    dry_run: bool,
    json: bool,
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
            "--input-file" if options.input_file.is_none() => options.input_file = Some(value.clone()),
            "--patch-file" if options.patch_file.is_none() => options.patch_file = Some(value.clone()),
            "--body-file" if options.body_file.is_none() => options.body_file = Some(value.clone()),
            "--name" if options.name.is_none() => options.name = Some(value.clone()),
            "--title" if options.title.is_none() => options.title = Some(value.clone()),
            "--priority" if options.priority.is_none() => options.priority = Some(value.clone()),
            "--due-date" if options.due_date.is_none() => options.due_date = Some(value.clone()),
            _ => return Err(invalid("Unknown or duplicate option")),
        }
        cursor += 2;
    }
    if !options.json { return Err(invalid("This command requires --json")); }
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

fn file_create_params(options: &Options) -> AgentResult<Value> {
    if options.workspace_scope || options.query.is_some() || options.budget_chars.is_some()
        || options.priority.is_some() || options.due_date.is_some() {
        return Err(invalid("File creation accepts --project, --name and --body-file"));
    }
    let project_id = options.project.ok_or_else(|| invalid("--project is required for file create"))?;
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
    if !matches!(priority, "urgent_important" | "urgent_not_important" | "not_urgent_important" | "not_urgent_not_important") {
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

/// Stdio owns stdout for its entire lifetime. Diagnostics go only to stderr.
pub fn run_mcp(args: &[String]) -> i32 {
    let parsed = (|| {
        let mut workspace = None;
        let mut connection = None;
        let mut cursor = 0;
        while cursor < args.len() {
            let value = args.get(cursor + 1).ok_or_else(|| invalid("Missing MCP option value"))?;
            if value.starts_with("--") { return Err(invalid("Missing MCP option value")); }
            match args[cursor].as_str() {
                "--workspace" if workspace.is_none() => workspace = Some(PathBuf::from(value)),
                "--connection" if connection.is_none() => connection = Some(value.clone()),
                _ => return Err(invalid("Unknown or duplicate MCP option")),
            }
            cursor += 2;
        }
        let workspace = workspace.ok_or_else(|| invalid("--workspace is required"))?;
        let connection = connection.ok_or_else(|| invalid("--connection is required"))?;
        if connection.len() != 32 || !connection.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(invalid("Invalid connection ID"));
        }
        Ok((workspace, connection))
    })();
    let result = parsed.and_then(|(workspace, connection)| {
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

pub fn run(args: &[String]) -> CliOutput {
    let words = args.iter().map(String::as_str).collect::<Vec<_>>();
    match words.as_slice() {
        ["--version"] => return CliOutput { stdout: format!("mind {}\n", env!("CARGO_PKG_VERSION")), stderr: String::new(), exit_code: 0 },
        [] | ["--help"] | ["help"] => return CliOutput { stdout: HELP.into(), stderr: String::new(), exit_code: 0 },
        ["mcp", "serve", ..] => return CliOutput { stdout: String::new(), stderr: "MCP serve must own stdio; use the mind executable\n".into(), exit_code: 2 },
        _ => {}
    }
    if words.as_slice() == ["capabilities", "--json"] {
        return response(request_id(), Ok(json!({"sharedCapabilities": capabilities(), "bridgeMethods": registry::registered_methods()})));
    }
    if let ["schema", method, "--json"] = words.as_slice() {
        return response(request_id(), registry::schema(method).ok_or_else(|| invalid("Unknown bridge method")));
    }
    let (command, option_args, search_query) = match words.as_slice() {
        ["doctor", ..] => ("doctor", &args[1..], None),
        ["project", "list", ..] => ("project.list", &args[2..], None),
        ["context", "get", ..] => ("context.get", &args[2..], None),
        ["search", query, ..] if !query.starts_with("--") => ("search", &args[2..], Some(*query)),
        ["context", "overview", "get", ..] => ("context.overview.get", &args[3..], None),
        ["knowledge", "search", ..] => ("knowledge.search", &args[2..], None),
        ["knowledge", "get", ..] => ("knowledge.get", &args[2..], None),
        ["source", "search", ..] => ("source.search", &args[2..], None),
        ["source", "read", ..] => ("source.read", &args[2..], None),
        ["session", "search", ..] => ("session.search", &args[2..], None),
        ["session", "messages", "read", ..] => ("session.messages.read", &args[3..], None),
        ["record", "blocks", "get", ..] => ("record.blocks.get", &args[3..], None),
        ["record", "create", "preview", ..] => ("record.create.preview", &args[3..], None),
        ["record", "create", ..] => ("record.create", &args[2..], None),
        ["record", "patch", "preview", ..] => ("record.patch.preview", &args[3..], None),
        ["record", "patch", ..] => ("record.patch", &args[2..], None),
        ["record", "restore", ..] => ("record.restore", &args[2..], None),
        ["record", "versions", "list", ..] => ("record.versions.list", &args[3..], None),
        ["record", "versions", "get", ..] => ("record.versions.get", &args[3..], None),
        ["record", "versions", "compare", ..] => ("record.versions.compare", &args[3..], None),
        ["todo", "get", ..] => ("todo.get", &args[2..], None),
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
        _ => return response(request_id(), Err(invalid("Unknown command; see mind --help"))),
    };
    let options = match parse_options(option_args) {
        Ok(options) => options,
        Err(error) => return response(request_id(), Err(error)),
    };
    if options.input_file.is_some() && options.patch_file.is_some() {
        return response(request_id(), Err(invalid("--input-file and --patch-file cannot be combined")));
    }
    if options.input_file.is_some() && options.body_file.is_some() && command != "file.upload" {
        return response(request_id(), Err(invalid("--input-file and --body-file cannot be combined")));
    }
    let mut request_id = options.request_id.clone().unwrap_or_else(request_id);
    let result = (|| {
        let (workspace, connection) = required_connection(&options)?;
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
        if matches!(command, "file.create" | "todo.create" | "record.create") && options.body_file.is_none()
            && (options.name.is_some() || options.title.is_some() || options.priority.is_some() || options.due_date.is_some()) {
            return Err(invalid("--body-file is required with creation options"));
        }
        if command == "file.upload" {
            reject_scope_options(&options)?;
            let target_path = options.input_file.as_deref().ok_or_else(|| invalid("--input-file is required"))?;
            let body_path = options.body_file.as_deref().ok_or_else(|| invalid("--body-file is required"))?;
            if target_path == "-" && body_path == "-" { return Err(invalid("Target JSON and body cannot both use stdin")); }
            request_id = options.request_id.clone().ok_or_else(|| invalid("--request-id is required for file upload"))?;
            if request_id.is_empty() || request_id.len() > 128 { return Err(invalid("Invalid File upload request ID")); }
            let target = cli_upload::decode_target(read_input(target_path)?)?;
            let bytes = cli_upload::read_body(body_path)?;
            let client = BridgeClient::discover(connection)?;
            let binding = client.connect(connection, workspace, &request_id)?;
            let transport = cli_upload::LiveTransport { client: &client, grant_id: connection, binding: &binding };
            return cli_upload::upload(&transport, target, &bytes, &request_id);
        }
        if options.body_file.is_some() && !matches!(command, "file.create" | "todo.create" | "record.create") {
            return Err(invalid("--body-file is only supported by file upload, file create, todo create and record create"));
        }
        let method = bridge_method(command, options.dry_run);
        let params = match command {
            "doctor" | "project.list" => {
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
                json!({"scope":scoped(&options)?,"query":search_query.expect("search query"),"budgetChars":options.budget_chars})
            }
            "file.create" if options.body_file.is_some() => file_create_params(&options)?,
            "todo.create" if options.body_file.is_some() => todo_create_params(&options)?,
            "record.create" if options.body_file.is_some() => record_create_params(&options)?,
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
                    reject_scope_options(&options)?;
                    read_input(options.patch_file.as_deref().or(options.input_file.as_deref())
                        .ok_or_else(|| invalid("--input-file is required"))?)?
                }
            }
        };
        if command == "record.patch" && !options.dry_run {
            request_id = write_request_id(&options, &params)?;
        }
        if command != "doctor" { registry::validate(method, &params)?; }
        if registry::is_read_only(method) == Some(false) && command != "record.patch" {
            request_id = write_request_id(&options, &params)?;
        }
        let client = BridgeClient::discover(connection)?;
        let binding = client.connect(connection, workspace, &request_id)?;
        if command == "doctor" {
            return Ok(json!({"connected":true,"binding":binding,"bridgeMethods":registry::registered_methods()}));
        }
        client.call(connection, &binding, method, params, &request_id)
    })();
    response(request_id, result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn invoke(args: &[&str]) -> CliOutput { run(&args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>()) }
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
}
