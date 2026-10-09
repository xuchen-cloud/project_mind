//! Argument handling and JSON output for the first local CLI read commands.
use super::{client::BridgeClient, registry};
use crate::agent::{
    capabilities::capabilities,
    context::ContextGetInput,
    errors::{AgentError, AgentResult, ApiResponse, ErrorCode},
    models::Scope,
};
use serde_json::{json, Value};
use std::path::PathBuf;

const HELP: &str = "mind — Project Mind local CLI\n\nUsage:\n  mind --version\n  mind capabilities --json\n  mind schema project.list|context.get --json\n  mind doctor --workspace PATH --connection ID --json\n  mind project list --workspace PATH --connection ID --json\n  mind context get (--project ID | --workspace-scope) --workspace PATH --connection ID [--query TEXT] [--budget-chars N] --json\n\nMCP serve is not implemented yet.\n";

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
                if !(1..=3000).contains(&budget) { return Err(invalid("Invalid character budget")); }
                options.budget_chars = Some(budget);
            }
            "--request-id" if options.request_id.is_none() && !value.is_empty() => options.request_id = Some(value.clone()),
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

pub fn run(args: &[String]) -> CliOutput {
    let words = args.iter().map(String::as_str).collect::<Vec<_>>();
    match words.as_slice() {
        ["--version"] => return CliOutput { stdout: format!("mind {}\n", env!("CARGO_PKG_VERSION")), stderr: String::new(), exit_code: 0 },
        [] | ["--help"] | ["help"] => return CliOutput { stdout: HELP.into(), stderr: String::new(), exit_code: 0 },
        ["mcp", "serve", ..] => return CliOutput { stdout: String::new(), stderr: "RUNTIME_UNAVAILABLE: MCP transport is not implemented\n".into(), exit_code: 3 },
        _ => {}
    }
    if words.as_slice() == ["capabilities", "--json"] {
        return response(request_id(), Ok(json!({"sharedCapabilities": capabilities(), "bridgeMethods": registry::registered_methods()})));
    }
    if let ["schema", method, "--json"] = words.as_slice() {
        return response(request_id(), registry::schema(method).ok_or_else(|| invalid("Unknown bridge method")));
    }
    let (command, option_args) = match words.as_slice() {
        ["doctor", ..] => ("doctor", &args[1..]),
        ["project", "list", ..] => ("project.list", &args[2..]),
        ["context", "get", ..] => ("context.get", &args[2..]),
        _ => return response(request_id(), Err(invalid("Unknown command; see mind --help"))),
    };
    let options = match parse_options(option_args) {
        Ok(options) => options,
        Err(error) => return response(request_id(), Err(error)),
    };
    let request_id = options.request_id.clone().unwrap_or_else(request_id);
    let result = (|| {
        let (workspace, connection) = required_connection(&options)?;
        if command != "context.get" && (options.project.is_some() || options.workspace_scope || options.query.is_some() || options.budget_chars.is_some()) {
            return Err(invalid("Scope and context options require context get"));
        }
        let params = if command == "context.get" {
            let scope = match (options.project, options.workspace_scope) {
                (Some(project_id), false) => Scope::Project { project_id },
                (None, true) => Scope::Workspace,
                _ => return Err(invalid("Choose exactly one of --project or --workspace-scope")),
            };
            serde_json::to_value(ContextGetInput { scope, query: options.query.clone(), budget_chars: options.budget_chars }).expect("context input JSON")
        } else { json!({}) };
        let client = BridgeClient::discover(connection)?;
        let binding = client.connect(connection, workspace, &request_id)?;
        if command == "doctor" {
            return Ok(json!({"connected":true,"binding":binding,"bridgeMethods":registry::registered_methods()}));
        }
        client.call(connection, &binding, command, params, &request_id)
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
        assert_eq!(out.exit_code, 3);
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
}
