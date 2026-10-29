//! Offline usage and schema discovery, sharing the root command examples.
use super::registry;

pub(super) const HELP: &str = r#"mind — Project Mind local CLI

Find and read:
  mind grep PATTERN            grep-style matching; see mind grep --help
  mind search "火车 排期" [--kind record,file] [--limit 50] [--all]
  mind record|todo|file get ID
  mind record|todo|file|session list [--query TEXT] [--limit 20] [--cursor TOKEN]
  mind record get ID --offset 100 --limit 20
  mind record get ID --format markdown > before.md
  mind contact search '张三'    Workspace address book; see mind contact --help

Edit a Record:
  mind record replace ID --old-text-file old.txt --new-text-file new.txt --base-revision N --request-id ID
  mind record append ID --body-file body.md --base-revision N --request-id ID
  mind record edit ID --before-file before.md --body-file after.md --base-revision N --dry-run
  mind record edit ID --before-file before.md --body-file after.md --base-revision N --request-id ID
  mind contact add --name '张三' --email EMAIL
  mind contact update ID --notes-file notes.txt
  Text edit commands return JSON. --dry-run does not write or require requestId.

Binding:
  --workspace PATH --connection ID (--project ID | --workspace-scope)
  Runtime defaults: PROJECT_MIND_WORKSPACE, PROJECT_MIND_CONNECTION, and either
  PROJECT_MIND_PROJECT_ID or PROJECT_MIND_WORKSPACE_SCOPE=1. Explicit flags win.
  Defaults select an existing authorized connection; they never grant permission.

Output:
  Common reads default to readable text; Record bodies use Markdown with line numbers.
  --format plain (alias cat) writes pipe-friendly content.
  --format json / --json returns one protocol page;
  continue with nextCursor. search --all streams pages and rejects JSON output.
  record get --format markdown writes exact saved Markdown to stdout, with
  headRevision metadata on stderr. --offset / --limit work in every read format.
  File get reads extracted text. Coverage, stale and incomplete warnings remain visible.

Advanced:
  mind -h / --help              This task guide
  mind -V / --version           CLI version
  mind COMMAND --help           Focused examples and options
  mind schema METHOD --json     Exact JSON input contract
  mind capabilities --json      Available methods (offline)
  mind doctor --json            Check the runtime binding
  Options accept --flag=value. -- ends options, allowing a pattern starting with -.
  mind search --kind=record -- --literal-query
  --input-file PATH|- accepts UTF-8 JSON (optional BOM), up to 2 MiB.
  PowerShell: use literal single-quoted Windows paths and UTF-8 files;
  bash heredoc syntax is not supported. Keep --request-id stable for a retry.
"#;

const USAGES: &str = r#"mind — Project Mind local CLI

Usage:
  mind --version
  mind capabilities [--verbose] --json
  mind schema METHOD --json
  mind doctor --workspace PATH --connection ID [--verbose] --json
  mind connection status --workspace PATH --connection ID --json
  mind schedule list --workspace PATH --connection ID [--json]
  mind schedule create|update|delete|run --input-file INPUT.json --workspace PATH --connection ID --json
  mind project list --workspace PATH --connection ID [--json]
  mind context get (--project ID | --workspace-scope) --workspace PATH --connection ID [--query TEXT] [--budget-chars N] --json
  mind search (QUERY | --query TEXT) (--project ID | --workspace-scope) [--kind record,file] [--limit N] [--cursor TOKEN | --all] [--budget-chars N] [--format text|plain|json]
  mind context get --input-file PATH|- --workspace PATH --connection ID --json
  mind context overview get --input-file PATH|- --workspace PATH --connection ID --json
  mind knowledge search --input-file PATH|- --workspace PATH --connection ID [--json]
  mind knowledge get --input-file PATH|- --workspace PATH --connection ID --json
  mind source search QUERY (--project ID | --workspace-scope) [--kind record,file] [--limit N] [--cursor TOKEN | --all] [--format text|plain|json]
  mind source search --input-file PATH|- --workspace PATH --connection ID [--json]
  mind source read --kind record|todo|file|quick_note --id ID (--project ID | --workspace-scope) [--revision HASH] [--cursor TOKEN] [--format text|plain|json]
  mind source read --input-file PATH|- --workspace PATH --connection ID [--json]
  mind reference list --kind record|todo|file|quick_note --id ID --direction incoming|outgoing (--project ID | --workspace-scope) [--cursor TOKEN] [--limit N] [--budget-chars N] --workspace PATH --connection ID [--json]
  mind reference list --input-file PATH|- --workspace PATH --connection ID [--json]
  mind record blocks get --input-file PATH|- --workspace PATH --connection ID --json
  mind record get (ID | --id ID) (--project ID | --workspace-scope) [--revision HASH] [--cursor TOKEN] [--budget-chars N] [--offset LINE] [--limit LINES] [--format text|plain|markdown|json] --workspace PATH --connection ID [--json]
  mind todo|file get (ID | --id ID) (--project ID | --workspace-scope) [--format text|plain|json]
  mind record replace (ID | --id ID) --old-text-file OLD --new-text-file NEW --base-revision N (--project ID | --workspace-scope) [--dry-run | --request-id ID]
  mind record append (ID | --id ID) --body-file PATH|- --base-revision N (--project ID | --workspace-scope) [--dry-run | --request-id ID]
  mind record edit (ID | --id ID) --before-file BEFORE.md --body-file AFTER.md --base-revision N (--project ID | --workspace-scope) [--dry-run | --request-id ID]
  mind file|record|todo|session list (--project ID | --workspace-scope) [--limit N] [--cursor TOKEN] [--query TITLE] [--budget-chars N] --workspace PATH --connection ID [--json]
  mind file download --input-file READ.json --out NEW_PATH --workspace PATH --connection ID --json
  mind file create --name NAME --source-file PATH (--project ID | --workspace-scope) --request-id ID --workspace PATH --connection ID --json
  mind file list --input-file PATH|- --workspace PATH --connection ID [--json]
  mind session list --input-file PATH|- --workspace PATH --connection ID [--json]
  mind record list --input-file PATH|- --workspace PATH --connection ID [--json]
  mind record get --input-file PATH|- --workspace PATH --connection ID [--json]
  mind record versions list|get|compare --input-file PATH|- --workspace PATH --connection ID --json
  mind todo get|list --input-file PATH|- --workspace PATH --connection ID --json
  mind todo list --input-file PATH|- --workspace PATH --connection ID [--json]
  mind todo create|update --input-file PATH|- --workspace PATH --connection ID --json
  mind todo create --body-file PATH|- (--project ID | --workspace-scope) [--priority VALUE] [--due-date YYYY-MM-DD] --request-id ID --workspace PATH --connection ID --json
  mind todo update --patch-file PATH|- --workspace PATH --connection ID --json
  mind file versions list|get --input-file PATH|- --workspace PATH --connection ID --json
  mind file source read --input-file PATH|- --workspace PATH --connection ID --json
  mind file create|patch|update|restore --input-file PATH|- --workspace PATH --connection ID --json
  mind file create --name NAME --body-file PATH|- (--project ID | --workspace-scope) --request-id ID --workspace PATH --connection ID --json
  mind file patch --patch-file PATH|- --workspace PATH --connection ID --json
  mind file update --id ID --source-file PATH|- (--project ID | --workspace-scope) --expected-version N --expected-hash SHA256 --request-id ID --workspace PATH --connection ID --json
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
  mind record text patch --input-file PATH|- --json
  mind record text patch preview --input-file PATH|- --json
  mind record patch preview --input-file PATH|- --workspace PATH --connection ID --json
  mind operation get|list|undo|restore-created --input-file PATH|- --workspace PATH --connection ID --json
  mind mcp serve --workspace PATH --connection ID

Binding:
  Supply --workspace PATH and --connection ID, or PROJECT_MIND_WORKSPACE and
  PROJECT_MIND_CONNECTION from the application's authorized runtime.
  Scope: --project ID or --workspace-scope; defaults may come from
  PROJECT_MIND_PROJECT_ID or PROJECT_MIND_WORKSPACE_SCOPE=1. Explicit flags win.
  These defaults select a binding and never grant permission.

Common tasks:
  mind search "火车 排期" --kind record,file --all
  mind record get 44
  mind todo get 12
  mind file get 9
  mind session list --query "排期" --limit 20
  mind record get 44 --format markdown > before.md
  mind record edit 44 --before-file before.md --body-file after.md --base-revision 7 --dry-run
  mind record edit 44 --before-file before.md --body-file after.md --base-revision 7 --request-id edit-44-1
  Examples use runtime binding/scope defaults; otherwise pass the binding and scope flags.

Output and continuation:
  Common reads default to text. --format json (or --json) preserves one bridge
  response page; continue with its nextCursor. search --all streams every page;
  --all with JSON is rejected. Search coverage and stale warnings go to stderr.
  record get --offset LINE --limit LINES selects a server-side window in every
  output format. --format markdown writes the exact persisted projection to
  stdout and revision metadata to stderr, suitable for redirecting to a file.
  file get reads extracted current File text; file source read returns source
  bytes via its JSON contract. context get provides navigation and summaries.

Advanced:
  mind COMMAND --help gives focused usage; mind schema METHOD --json gives the
  exact DTO. --input-file PATH|- reads UTF-8 JSON up to 2 MiB; UTF-8 BOM accepted.
  PowerShell: use literal single-quoted Windows paths. Bash heredoc syntax is
  not supported by PowerShell; a UTF-8 input file works in both shells.
  Writes require a stable requestId; reuse it for the same operation. Record
  text edits require --base-revision from record get metadata; --dry-run previews
  without writing and accepts --budget-chars. Text bodies must be UTF-8.
  Binary upload supports up to 100 MiB; file download requires a new output path.

"#;

fn cli_path(command: &str) -> String {
    match command {
        "file.bytes.read" => "file download".into(),
        "file.version.restore" => "file restore".into(),
        "operation.restore_created" => "operation restore-created".into(),
        _ => command.replace('.', " "),
    }
}

/// Select relevant examples and expand grouped verbs (such as get|list).
/// The usage catalog includes advanced DTO commands without expanding root help.
fn usages(command: &str) -> Vec<String> {
    let path = cli_path(command);
    let words = path.split_whitespace().collect::<Vec<_>>();
    USAGES.lines()
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
                "file.get" => "source.read",
                "record.replace" | "record.append" | "record.edit" => "record.text.patch",
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
    if command == "record.get" {
        out.push_str("\nReads committed content, streaming pages at one revision. Default human output numbers canonical Markdown lines and preserves tables. --format text selects the source text projection with line numbers; --format markdown writes the exact saved Markdown to stdout and metadata to stderr. --format json/--json returns one original bridge page. --offset (1-based) and --limit apply server-side in every format. Pass --cursor to continue one page. Reads are bounded to 8 MiB / 4096 pages.\n");
    }
    if matches!(command,"record.replace"|"record.append"|"record.edit") {
        out.push_str("\nUse the headRevision from record get as --base-revision. --dry-run previews without writing or requiring --request-id; commits require a stable --request-id. record edit compares before.md with the saved projection before applying after.md. Text files accept UTF-8 with optional BOM. These commands return a JSON response by default.\n");
    }
    if matches!(command,"search"|"source.search") {
        out.push_str("\nWhitespace-separated literal keywords match within each document. --kind accepts one kind or a comma-separated list. --limit is 1–50 per page. Pass nextCursor with --cursor, or use --all to stream all pages. --all rejects JSON; JSON remains one response page. Coverage/stale warnings remain on stderr.\n");
    }
    if command == "file.get" {
        out.push_str("\nReads the current File's extracted full text, streaming bounded pages. Use file source read for original source bytes.\n");
    }
    if command == "context.get" {
        out.push_str("\nContext navigation and summaries, not body search. Use `mind search QUERY` for source body content. --input-file accepts the registered context.get DTO and cannot accompany shorthand scope/query/budget options.\n");
    }
    if command != "record.get" && super::cli_presentation::supports(command) {
        out.push_str("\nCommon search/list commands default to concise text; human source search defaults to budgetChars=12000 unless explicitly set. Search coverage, hasMore and stale counts go to stderr; --json preserves the exact single-page response envelope.\n");
    }
    out
}
