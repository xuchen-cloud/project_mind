//! Task-shaped access to the Workspace address book, independent of content scope.
use super::*;
use std::fmt::Write;

pub(super) const HELP: &str = r#"mind contact — Workspace address book

Usage:
  mind contact search '张三' [--limit 50] [--offset 0]
  mind contact list [--query TEXT] [--limit 50] [--offset 0]
  mind contact get (ID | --id ID)
  mind contact add --name '张三' --nicknames '老张;三哥' --email EMAIL --department '研发'
  mind contact update ID --notes-file notes.txt [--base-revision N]

Search priority: employee ID > email > name > nickname > full pinyin > initials.
Use known text directly; when Chinese spelling is unknown, use pinyin or initials.

Fields: --name --nicknames --notes --notes-file --email --employee-id
        --role --department --pinyin-full --pinyin-abbr
Only supplied fields change. An empty string clears a field; null is invalid.
Name and nickname pinyin is generated and saved by Project Mind automatically.
--pinyin-full and --pinyin-abbr are optional advanced overrides.
--notes and --notes-file are mutually exclusive. Files use UTF-8 (BOM accepted).
create is an alias for add. Writes generate a request ID unless --request-id is
given. Update reads the current revision unless --base-revision is given.
Errors print the request ID and resolved revision; retry the original payload
with both values to retain the same operation identity. No automatic retries.

Binding: --workspace PATH --connection ID, or the corresponding runtime defaults.
Contacts belong to the whole Workspace. --project/--workspace-scope are rejected;
environment content scope defaults are ignored. Independent contact.read/write
permission is required. Contact writes do not support undo.
Output: --format text|plain|cat|json, or --json. Pagination offsets start at 0.
List/search columns: ID, name, email, employee ID, nicknames, department.
Options support --flag=value and -- as the option terminator.
Advanced: --input-file PATH|- accepts the exact native JSON input instead of fields.
Use mind schema contact.list|search|get|create|update --json for native schemas.
"#;

pub(super) fn field_key(flag: &str) -> Option<&'static str> {
    Some(match flag {
        "--name" => "name",
        "--nicknames" => "nicknames",
        "--notes" => "notes",
        "--email" => "email",
        "--employee-id" => "employeeId",
        "--role" => "role",
        "--department" => "department",
        "--pinyin-full" => "pinyinFull",
        "--pinyin-abbr" => "pinyinAbbr",
        _ => return None,
    })
}

fn help(method: &str) -> String {
    format!("{HELP}\nExact input: mind schema {method} --json\n")
}

fn check_options(options: &Options, verb: &str) -> AgentResult<()> {
    for flag in &options.flags {
        if matches!(flag.as_str(), "--project" | "--workspace-scope") {
            return Err(invalid("Contacts use the Workspace address book; --project and --workspace-scope are not supported"));
        }
        let common = matches!(
            flag.as_str(),
            "--workspace"
                | "--connection"
                | "--help"
                | "--version"
                | "--json"
                | "--format"
                | "--input-file"
                | "--request-id"
        );
        let allowed = match verb {
            "list" | "search" => matches!(flag.as_str(), "--query" | "--limit" | "--offset"),
            "get" => flag == "--id",
            "create" => field_key(flag).is_some() || flag == "--notes-file",
            "update" => {
                field_key(flag).is_some()
                    || matches!(flag.as_str(), "--notes-file" | "--id" | "--base-revision")
            }
            _ => false,
        };
        if !common && !allowed {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                format!("contact {verb} does not accept {flag}"),
            ));
        }
    }
    if options.positionals.len() > 1 {
        return Err(invalid(
            "Contact commands accept one ID or query; quote a multiword query",
        ));
    }
    if !options.positionals.is_empty() && !matches!(verb, "search" | "list" | "get" | "update") {
        return Err(invalid(
            "contact add accepts named fields, not positional arguments",
        ));
    }
    if options.json
        && options
            .format
            .as_deref()
            .is_some_and(|format| format != "json")
    {
        return Err(invalid("--json conflicts with a non-JSON --format"));
    }
    if options.format.as_deref() == Some("markdown") {
        return Err(invalid(
            "Contacts support --format text, plain (cat) or json",
        ));
    }
    if options.input_file.is_some()
        && (!options.positionals.is_empty()
            || options.flags.iter().any(|flag| {
                !matches!(
                    flag.as_str(),
                    "--workspace"
                        | "--connection"
                        | "--help"
                        | "--version"
                        | "--json"
                        | "--format"
                        | "--input-file"
                        | "--request-id"
                )
            }))
    {
        return Err(invalid(
            "--input-file cannot accompany contact shorthand fields, ID or pagination",
        ));
    }
    if options.notes_file.is_some() && options.contact_fields.contains_key("notes") {
        return Err(invalid("Choose either --notes or --notes-file"));
    }
    Ok(())
}

fn shorthand(options: &Options, verb: &str) -> AgentResult<Value> {
    let positional = options.positionals.first().map(String::as_str);
    match verb {
        "list" | "search" => {
            if options
                .limit
                .is_some_and(|limit| !(1..=200).contains(&limit))
            {
                return Err(invalid("Contact --limit must be between 1 and 200"));
            }
            if positional.is_some() && options.query.is_some() {
                return Err(invalid(
                    "Query was supplied twice: positional argument and --query",
                ));
            }
            let query = positional.or(options.query.as_deref());
            if query.is_some_and(|query| query.chars().count() > 1000) {
                return Err(invalid("Contact query must be at most 1000 characters"));
            }
            if verb == "search" && query.is_none() {
                return Err(invalid("contact search requires a query"));
            }
            let mut params = json!({});
            if let Some(query) = query {
                params["query"] = json!(query);
            }
            if let Some(limit) = options.limit {
                params["limit"] = json!(limit);
            }
            if let Some(offset) = options.offset {
                params["offset"] = json!(offset);
            }
            Ok(params)
        }
        "get" => Ok(json!({"id":cli_convenience::object_id(options,positional)?})),
        "create" | "update" => {
            let mut fields = options.contact_fields.clone();
            if let Some(name) = &options.name {
                fields.insert("name".into(), json!(name));
            }
            if let Some(path) = &options.notes_file {
                fields.insert("notes".into(), json!(read_text_file(path, "--notes-file")?));
            }
            if verb == "create"
                && !fields
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| !name.trim().is_empty())
            {
                return Err(invalid("contact add requires a nonempty --name"));
            }
            if verb == "update" && fields.is_empty() {
                return Err(invalid("contact update requires at least one field"));
            }
            let mut params = json!({"fields":fields});
            if verb == "update" {
                params["id"] = json!(cli_convenience::object_id(options, positional)?);
                if let Some(revision) = options.base_revision {
                    params["baseRevision"] = json!(revision);
                }
            }
            bounded_generated_params(params)
        }
        _ => Err(invalid("Unknown contact command; see mind contact --help")),
    }
}

fn render_contact(contact: &Value) -> AgentResult<String> {
    if !contact["id"].is_i64() || !contact["name"].is_string() || !contact["revision"].is_u64() {
        return Err(AgentError::new(
            ErrorCode::RuntimeIncompatible,
            "Bridge returned an invalid ContactRecord",
        ));
    }
    let mut out = format!("ID: {}\n", contact["id"]);
    for (key, label) in [
        ("name", "Name"),
        ("nicknames", "Nicknames"),
        ("email", "Email"),
        ("employeeId", "Employee ID"),
        ("role", "Role"),
        ("department", "Department"),
        ("pinyinFull", "Pinyin"),
        ("pinyinAbbr", "Pinyin abbreviation"),
        ("notes", "Notes"),
    ] {
        if let Some(text) = contact[key].as_str().filter(|value| !value.is_empty()) {
            writeln!(out, "{label}: {text}").expect("string output");
        }
    }
    Ok(out)
}

fn list_column(value: &Value) -> String {
    value
        .as_str()
        .unwrap_or("")
        .replace('\t', "\\t")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

fn human(verb: &str, data: Value) -> AgentResult<CliOutput> {
    let mut out = CliOutput {
        stdout: String::new(),
        stderr: String::new(),
        exit_code: 0,
    };
    match verb {
        "list" | "search" => {
            let items = data["items"].as_array().ok_or_else(|| {
                AgentError::new(
                    ErrorCode::RuntimeIncompatible,
                    "Bridge returned an invalid contact list",
                )
            })?;
            for item in items {
                let id = item["id"].as_i64().ok_or_else(|| {
                    AgentError::new(
                        ErrorCode::RuntimeIncompatible,
                        "Bridge returned an invalid contact ID",
                    )
                })?;
                // Quote names and escape row/column separators in the remaining fields.
                let name = serde_json::to_string(item["name"].as_str().unwrap_or(""))
                    .expect("string JSON");
                let nicknames = serde_json::to_string(item["nicknames"].as_str().unwrap_or(""))
                    .expect("string JSON");
                writeln!(
                    out.stdout,
                    "{id}\t{name}\t{}\t{}\t{nicknames}\t{}",
                    list_column(&item["email"]),
                    list_column(&item["employeeId"]),
                    list_column(&item["department"])
                )
                .expect("string output");
            }
            writeln!(
                out.stderr,
                "{} of {} contacts",
                items.len(),
                data["totalCount"]
            )
            .expect("string output");
            if data["hasMore"].as_bool() == Some(true) {
                let next = data["nextOffset"].as_u64().ok_or_else(|| {
                    AgentError::new(
                        ErrorCode::RuntimeIncompatible,
                        "Contact list has no nextOffset",
                    )
                })?;
                writeln!(out.stderr, "More contacts: --offset {next}").expect("string output");
            }
        }
        "get" => {
            out.stdout = render_contact(&data)?;
            writeln!(out.stderr, "Revision: {}", data["revision"]).expect("string output");
        }
        "create" | "update" => {
            out.stdout = render_contact(&data["contact"])?;
            writeln!(
                out.stderr,
                "Revision: {}\nOperation: {}\nRequest ID: {}",
                data["contact"]["revision"],
                data["operation"]["operationId"].as_str().unwrap_or(""),
                data["operation"]["requestId"].as_str().unwrap_or("")
            )
            .expect("string output");
        }
        _ => unreachable!(),
    }
    Ok(out)
}

pub(super) fn run(args: &[String], bridge: &mut impl CliBridge) -> CliOutput {
    let Some(verb) = args.first().map(String::as_str) else {
        return CliOutput {
            stdout: HELP.into(),
            stderr: String::new(),
            exit_code: 0,
        };
    };
    if matches!(verb, "--help" | "-h" | "help") {
        return CliOutput {
            stdout: HELP.into(),
            stderr: String::new(),
            exit_code: 0,
        };
    }
    if matches!(verb, "--version" | "-V") {
        return CliOutput {
            stdout: format!("mind {}\n", env!("CARGO_PKG_VERSION")),
            stderr: String::new(),
            exit_code: 0,
        };
    }
    let verb = if verb == "add" { "create" } else { verb };
    if !matches!(verb, "list" | "search" | "get" | "create" | "update") {
        return response(
            request_id(),
            Err(invalid("Unknown contact command; see mind contact --help")),
        );
    }
    let method = format!("contact.{verb}");
    let mut rid = request_id();
    let mut resolved_revision = None;
    let mut json_output = false;
    let mut mutation_started = false;
    let result = (|| {
        let mut options = parse_options_context(&args[1..], true)?;
        json_output = options.json || options.format.as_deref() == Some("json");
        if options.help {
            return Ok(CliOutput {
                stdout: help(&method),
                stderr: String::new(),
                exit_code: 0,
            });
        }
        if options.version_info {
            return Ok(CliOutput {
                stdout: format!("mind {}\n", env!("CARGO_PKG_VERSION")),
                stderr: String::new(),
                exit_code: 0,
            });
        }
        check_options(&options, verb)?;
        cli_convenience::environment(&mut options, "contact", |name| std::env::var(name).ok())?;
        let (workspace, connection) = required_connection(&options)?;
        let mut params = match options.input_file.as_deref() {
            Some(path) => read_input(path)?,
            None => shorthand(&options, verb)?,
        };
        if !params.is_object() {
            return Err(invalid("Contact input must be a JSON object"));
        }
        if let Some(explicit) = options.request_id.as_deref() {
            if params
                .get("requestId")
                .is_some_and(|value| value.as_str() != Some(explicit))
            {
                return Err(invalid("--request-id differs from input requestId"));
            }
            rid = explicit.to_owned();
        } else if let Some(value) = params.get("requestId") {
            rid = value
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| invalid("Invalid contact requestId"))?
                .to_owned();
        }
        if matches!(verb, "create" | "update") {
            params["requestId"] = json!(rid);
            if verb == "update" && params.get("baseRevision").is_none() {
                let id = params
                    .get("id")
                    .cloned()
                    .ok_or_else(|| invalid("contact update requires an ID"))?;
                registry::validate("contact.get", &json!({"id":id}))?;
                let current =
                    bridge.call(workspace, connection, "contact.get", json!({"id":id}), &rid)?;
                let revision = current["revision"]
                    .as_u64()
                    .filter(|revision| *revision > 0)
                    .ok_or_else(|| {
                        AgentError::new(
                            ErrorCode::RuntimeIncompatible,
                            "Contact response is missing its revision",
                        )
                    })?;
                params["baseRevision"] = json!(revision);
            }
            resolved_revision = params.get("baseRevision").and_then(Value::as_u64);
        }
        registry::validate(&method, &params)?;
        mutation_started = matches!(verb, "create" | "update");
        let data = bridge.call(workspace, connection, &method, params, &rid)?;
        if json_output {
            Ok(response(rid.clone(), Ok(data)))
        } else {
            human(verb, data)
        }
    })();
    match result {
        Ok(out) => out,
        Err(error) => {
            let mut out = response(rid.clone(), Err(error));
            if !json_output {
                out.stdout.clear();
            }
            if mutation_started {
                writeln!(out.stderr, "Request ID: {rid}").expect("string output");
                if let Some(revision) = resolved_revision {
                    writeln!(out.stderr, "Base revision: {revision}").expect("string output");
                }
                out.stderr.push_str("If retrying this operation, reuse the request ID, base revision (for update), and original fields.\n");
            }
            out
        }
    }
}

#[cfg(test)]
#[path = "cli_contacts_tests.rs"]
mod tests;
