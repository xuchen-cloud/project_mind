//! Offline usage and schema discovery, sharing the root command examples.
use super::registry;

pub(super) const HELP: &str = r#"mind — Project Mind local CLI

Usage:
  mind --version
  mind capabilities [--verbose] --json
  mind schema METHOD --json
  mind doctor --workspace PATH --connection ID [--verbose] --json
  mind connection status --workspace PATH --connection ID --json
  mind project list --workspace PATH --connection ID --json
  mind context get (--project ID | --workspace-scope) --workspace PATH --connection ID [--query TEXT] [--budget-chars N] --json
  mind search QUERY (--project ID | --workspace-scope) --workspace PATH --connection ID [--budget-chars N] --json
  mind context overview get --input-file PATH|- --workspace PATH --connection ID --json
  mind knowledge search|get --input-file PATH|- --workspace PATH --connection ID --json
  mind source search|read --input-file PATH|- --workspace PATH --connection ID --json
  mind reference list --kind record|todo|file|quick_note --id ID --direction incoming|outgoing (--project ID | --workspace-scope) [--cursor TOKEN] [--limit N] [--budget-chars N] --workspace PATH --connection ID --json
  mind reference list --input-file PATH|- --workspace PATH --connection ID --json
  mind record blocks get --input-file PATH|- --workspace PATH --connection ID --json
  mind record get ID (--project ID | --workspace-scope) [--revision HASH] [--cursor TOKEN] [--budget-chars N] --workspace PATH --connection ID --json
  mind record get --input-file PATH|- --workspace PATH --connection ID --json
  mind record versions list|get|compare --input-file PATH|- --workspace PATH --connection ID --json
  mind todo get|list --input-file PATH|- --workspace PATH --connection ID --json
  mind todo create|update --input-file PATH|- --workspace PATH --connection ID --json
  mind todo create --body-file PATH|- (--project ID | --workspace-scope) [--priority VALUE] [--due-date YYYY-MM-DD] --request-id ID --workspace PATH --connection ID --json
  mind todo update --patch-file PATH|- --workspace PATH --connection ID --json
  mind file versions list|get --input-file PATH|- --workspace PATH --connection ID --json
  mind file source read --input-file PATH|- --workspace PATH --connection ID --json
  mind file create|patch|update|restore --input-file PATH|- --workspace PATH --connection ID --json
  mind file create --name NAME --body-file PATH|- --project ID --request-id ID --workspace PATH --connection ID --json
  mind file patch --patch-file PATH|- --workspace PATH --connection ID --json
  mind file update --id ID --source-file PATH|- --project ID --expected-version N --expected-hash SHA256 --request-id ID --workspace PATH --connection ID --json
  mind file content begin|chunk|complete|status --input-file PATH|- --workspace PATH --connection ID --json
  mind file upload --input-file TARGET.json --body-file PATH --request-id ID --workspace PATH --connection ID --json
  mind record create|restore --input-file PATH|- --workspace PATH --connection ID --json
  mind record restore --id ID --version VERSION_ID --base-revision N (--project ID | --workspace-scope) --request-id ID --workspace PATH --connection ID --json
  mind record create --title TITLE --body-file PATH|- (--project ID | --workspace-scope) --request-id ID --workspace PATH --connection ID --json
  mind record create --title TITLE --body-file PATH|- (--project ID | --workspace-scope) --dry-run [--budget-chars N] --workspace PATH --connection ID --json
  mind record create --input-file PATH|- --dry-run [--budget-chars N] --workspace PATH --connection ID --json
  mind record create preview --input-file PATH|- --workspace PATH --connection ID --json
  mind record patch --patch-file PATH|- --workspace PATH --connection ID --json
  mind record patch --patch-file PATH|- --dry-run [--budget-chars N] --workspace PATH --connection ID --json
  mind record patch preview --input-file PATH|- --workspace PATH --connection ID --json
  mind operation get|list|undo|restore-created --input-file PATH|- --workspace PATH --connection ID --json
  mind mcp serve --workspace PATH --connection ID

Use `mind COMMAND --help` for focused offline help. Use `mind schema METHOD --json` for the exact input DTO. --input-file - reads JSON from stdin (up to 2 MiB). Write inputs require a stable requestId; reuse the same ID when retrying. Record create/patch --dry-run preview without writing and may omit mutation requestId; --budget-chars applies only to these previews (1–12000, default 4000). Record Markdown is limited to 1 MiB. record get reads one bounded body page; pass its nextCursor with --cursor to continue. reference list returns one page (default 20 items, 4000 characters); pass nextCursor with --cursor to continue. --patch-file accepts native RecordPatch JSON for record patch, or the existing wrapped mutation JSON for file patch and todo update; it cannot be combined with --input-file. Body and source file paths stay local; content is sent to the bound application. Text bodies must be UTF-8, and generated JSON is limited to 2 MiB. File update --source-file sends binary content through the existing staged upload. File upload reads up to 100 MiB locally, sends only bytes, and resumes a staged upload by its stable phase IDs. If status reports an expired stage, it checks the same final file.update receipt; an uncommitted expired upload still fails. If --request-id is provided, it must match the input requestId. Example: mind source read --input-file read.json --workspace ./work --connection ID --json
"#;

fn cli_path(command: &str) -> String {
    match command {
        "file.version.restore" => "file restore".into(),
        "operation.restore_created" => "operation restore-created".into(),
        _ => command.replace('.', " "),
    }
}

/// Select relevant examples and expand grouped verbs (such as get|list).
/// The root help remains the single source for shorthand options and aliases.
fn usages(command: &str) -> Vec<String> {
    let path = cli_path(command);
    let words = path.split_whitespace().collect::<Vec<_>>();
    HELP.lines()
        .filter_map(|line| {
            let usage = line.strip_prefix("  mind ")?;
            let tokens = usage.split_whitespace().collect::<Vec<_>>();
            if tokens.len() < words.len()
                || !words
                    .iter()
                    .zip(&tokens)
                    .all(|(word, token)| token.split('|').any(|alternative| alternative == *word))
            {
                return None;
            }
            Some(format!(
                "  mind {} {}",
                path,
                tokens[words.len()..].join(" ")
            ))
        })
        .collect()
}

pub(super) fn group(command: &str) -> Option<String> {
    let usages = usages(command);
    if usages.is_empty() {
        return None;
    }
    Some(format!(
        "mind {}\n\nUsage:\n{}\n\nUse a subcommand's --help for details and schema pointers.\n",
        cli_path(command),
        usages.join("\n")
    ))
}

pub(super) fn command(command: &str) -> String {
    let path = cli_path(command);
    let usage = usages(command).join("\n");
    let mut out = format!("mind {path}\n\nUsage:\n{usage}\n");
    match command {
        "capabilities" => out.push_str("\nLists available bridge methods (method, description, readOnly). --verbose includes input schemas and shared capabilities.\nUse `mind schema METHOD --json` for one method's exact input DTO.\n"),
        "doctor" => out.push_str("\nConnects and queries connection.status. Returns connected, binding, canonical workspacePath, authorization and executionMode. --verbose only adds bridgeMethods with input schemas.\nThis is a current authorization snapshot; every business call is reauthorized. authorization.operations lists native permissions, not method names. A null executionMode means no built-in execution mode information; it implies neither read-only nor unrestricted access.\n"),
        "connection.status" => out.push_str("\nReturns the live grant's current authorization snapshot: binding, authorization (workspaceContent, projectIds, operations, objectKeys) and executionMode. operations lists native permissions, not method names. objectKeys=null means no object-key restriction. executionMode is null, read-only, workspace-write or danger-full-access; null means no built-in execution mode information and implies neither read-only nor unrestricted access. Every business call is reauthorized.\nUse `mind schema connection.status --json` for the exact input DTO (an empty object; extra fields are rejected).\n"),
        "schema" => out.push_str("\nPrints one bridge method's exact input JSON schema without connecting. Discover methods with `mind capabilities --json`.\n"),
        "mcp.serve" => out.push_str("\nServes MCP over stdio using the bound Workspace and connection.\n"),
        "file.upload" => out.push_str("\nUploads local bytes (up to 100 MiB) through staged content and file.update.\nTARGET.json contains object, expectedVersionNumber and expectedContentHash; --request-id supplies the stable mutation ID.\nSee `mind schema file.content.begin --json` and `mind schema file.update --json` for the related bridge DTOs.\n--input-file - reads target JSON from stdin (up to 2 MiB). Target JSON and body cannot both use stdin.\n"),
        _ => {
            let method = match command {
                "search" => "source.search",
                _ => command,
            };
            if let Some(entry) = registry::registered_methods().into_iter().find(|entry| entry.method == method) {
                out.push_str(&format!("\n{}\n", entry.description));
                if !entry.read_only {
                    out.push_str("Write inputs require a stable requestId; reuse it when retrying. --request-id must match the input requestId.\n");
                }
            }
            out.push_str(&format!("\nUse `mind schema {method} --json` for the exact input DTO.\n"));
            if matches!(command, "record.create" | "record.patch") {
                out.push_str(&format!("Use `mind schema {command}.preview --json` for --dry-run (no write or mutation requestId required).\n"));
            }
            if usage.contains("--input-file") {
                out.push_str("--input-file - reads JSON from stdin (up to 2 MiB).\n");
            }
            if command == "todo.create" {
                out.push_str(&format!("--priority accepts {} (default not_urgent_not_important).\n", crate::agent::outputs::TODO_PRIORITIES.join(", ")));
            }
        }
    }
    out
}
