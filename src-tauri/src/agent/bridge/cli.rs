//! Argument handling and JSON output for local bridge commands.
use super::{client::BridgeClient, mcp::MindMcp, registry};
use crate::agent::{
    capabilities::capabilities,
    context::ContextGetInput,
    errors::{AgentError, AgentResult, ApiResponse, ErrorCode},
    models::Scope,
};
use serde_json::{json, Value};
use std::{io::Read, path::PathBuf};

const HELP: &str = "mind — Project Mind local CLI\n\nUsage:\n  mind --version\n  mind capabilities --json\n  mind schema METHOD --json\n  mind doctor --workspace PATH --connection ID --json\n  mind project list --workspace PATH --connection ID --json\n  mind context get (--project ID | --workspace-scope) --workspace PATH --connection ID [--query TEXT] [--budget-chars N] --json\n  mind search QUERY (--project ID | --workspace-scope) --workspace PATH --connection ID [--budget-chars N] --json\n  mind context overview get --input-file PATH|- --workspace PATH --connection ID --json\n  mind knowledge search|get --input-file PATH|- --workspace PATH --connection ID --json\n  mind source search|read --input-file PATH|- --workspace PATH --connection ID --json\n  mind session search --input-file PATH|- --workspace PATH --connection ID --json\n  mind session messages read --input-file PATH|- --workspace PATH --connection ID --json\n  mind record blocks get --input-file PATH|- --workspace PATH --connection ID --json\n  mind record versions list|get|compare --input-file PATH|- --workspace PATH --connection ID --json\n  mind todo get --input-file PATH|- --workspace PATH --connection ID --json\n  mind file versions list|get --input-file PATH|- --workspace PATH --connection ID --json\n  mind file source read --input-file PATH|- --workspace PATH --connection ID --json\n  mind record create|patch|restore --input-file PATH|- --workspace PATH --connection ID --json\n  mind operation get|list|undo|restore-created --input-file PATH|- --workspace PATH --connection ID --json\n  mind mcp serve --workspace PATH --connection ID\n\nUse `mind schema METHOD --json` for the exact input DTO. --input-file - reads JSON from stdin (up to 64 KiB). Write inputs require a stable requestId; reuse the same ID when retrying. If --request-id is provided, it must match the input requestId. Example: mind source read --input-file read.json --workspace ./work --connection ID --json\n";
const MAX_INPUT_BYTES: u64 = 64 * 1024;

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
        return Err(invalid("--input-file exceeds 64 KiB"));
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
        ["record", "create", ..] => ("record.create", &args[2..], None),
        ["record", "patch", ..] => ("record.patch", &args[2..], None),
        ["record", "restore", ..] => ("record.restore", &args[2..], None),
        ["record", "versions", "list", ..] => ("record.versions.list", &args[3..], None),
        ["record", "versions", "get", ..] => ("record.versions.get", &args[3..], None),
        ["record", "versions", "compare", ..] => ("record.versions.compare", &args[3..], None),
        ["todo", "get", ..] => ("todo.get", &args[2..], None),
        ["file", "versions", "list", ..] => ("file.versions.list", &args[3..], None),
        ["file", "versions", "get", ..] => ("file.versions.get", &args[3..], None),
        ["file", "source", "read", ..] => ("file.source.read", &args[3..], None),
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
    let mut request_id = options.request_id.clone().unwrap_or_else(request_id);
    let result = (|| {
        let (workspace, connection) = required_connection(&options)?;
        let method = if command == "search" { "source.search" } else { command };
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
            _ => {
                if !registry::is_registered(method) { return Err(invalid("Unknown bridge method")); }
                reject_scope_options(&options)?;
                read_input(options.input_file.as_deref().ok_or_else(|| invalid("--input-file is required"))?)?
            }
        };
        if command != "doctor" { registry::validate(method, &params)?; }
        if registry::is_read_only(method) == Some(false) {
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
        assert_eq!(parse_input(std::io::Cursor::new(vec![b' '; (MAX_INPUT_BYTES + 1) as usize])).unwrap_err().message, "--input-file exceeds 64 KiB");
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
            vec!["record", "create"], vec!["record", "patch"], vec!["record", "restore"],
            vec!["operation", "undo"], vec!["operation", "restore-created"],
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
}
