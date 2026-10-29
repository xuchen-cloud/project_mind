//! Common task-shaped inputs; native bridge validation remains authoritative.
use super::*;

pub(super) fn environment(
    options: &mut Options,
    command: &str,
    get: impl Fn(&str) -> Option<String>,
) -> AgentResult<()> {
    let get = |name: &str| get(name).filter(|value| !value.is_empty());
    if options.workspace.is_none() {
        if let Some(path) = get("PROJECT_MIND_WORKSPACE") {
            options.workspace = Some(path.into());
        }
    }
    if options.connection.is_none() {
        options.connection = get("PROJECT_MIND_CONNECTION");
    }
    // JSON DTOs carry their own scope. Commands without content scope do not
    // accidentally acquire one from a runtime's default project.
    if options.input_file.is_none()
        && options.patch_file.is_none()
        && options.project.is_none()
        && !options.workspace_scope
        && matches!(
            command,
            "context.get"
                | "grep"
                | "search"
                | "source.search"
                | "source.read"
                | "record.get"
                | "todo.get"
                | "file.get"
                | "reference.list"
                | "record.list"
                | "todo.list"
                | "file.list"
                | "session.list"
                | "record.create"
                | "todo.create"
                | "file.create"
                | "record.restore"
                | "file.update"
                | "record.replace"
                | "record.append"
                | "record.edit"
        )
    {
        match (get("PROJECT_MIND_PROJECT_ID"),get("PROJECT_MIND_WORKSPACE_SCOPE")) {
            (Some(_), Some(_)) => return Err(invalid("Choose one environment scope: PROJECT_MIND_PROJECT_ID or PROJECT_MIND_WORKSPACE_SCOPE")),
            (Some(id),None) => {
                let id = id.parse::<i64>().ok().filter(|id| *id > 0).ok_or_else(|| invalid("Invalid PROJECT_MIND_PROJECT_ID"))?;
                options.project = Some(id);
            }
            (None,Some(scope)) => {
                if scope != "1" { return Err(invalid("PROJECT_MIND_WORKSPACE_SCOPE must be 1")); }
                options.workspace_scope = true;
            }
            _ => {}
        }
    }
    Ok(())
}

pub(super) fn validate_options(options: &Options, command: &str) -> AgentResult<()> {
    if options.body_file.is_some()
        && !matches!(
            command,
            "file.upload"
                | "file.create"
                | "todo.create"
                | "record.create"
                | "record.append"
                | "record.edit"
        )
    {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            format!("{command} does not accept --body-file"),
        ));
    }

    if command == "search" && options.input_file.is_some() {
        return Err(invalid(
            "search does not accept --input-file; use source search for a DTO",
        ));
    }
    if options.all && !matches!(command, "search" | "source.search") {
        return Err(invalid("--all is supported by search and source search"));
    }
    if options.all && options.json {
        return Err(invalid(
            "--all cannot accompany JSON output; use one page with --cursor",
        ));
    }
    if options.format.as_deref() == Some("markdown") && command != "record.get" {
        return Err(invalid("--format markdown is supported by record get"));
    }
    if options.old_text_file.is_some() && command != "record.replace"
        || options.new_text_file.is_some() && command != "record.replace"
        || options.before_file.is_some() && command != "record.edit"
    {
        return Err(invalid(
            "Text file options belong to record replace or record edit",
        ));
    }
    if options.version_id.is_some() && command != "record.restore" {
        return Err(invalid("--version is supported by record restore"));
    }
    if options.input_file.is_some()
        && matches!(
            command,
            "source.search" | "source.read" | "file.get" | "todo.get"
        )
        && (options.project.is_some()
            || options.workspace_scope
            || options.object_id.is_some()
            || options.kind.is_some()
            || options.cursor.is_some()
            || options.limit.is_some()
            || options.query.is_some()
            || options.revision.is_some()
            || options.budget_chars.is_some())
    {
        return Err(invalid(
            "--input-file cannot be combined with shorthand options",
        ));
    }
    if command == "todo.get"
        && (options.revision.is_some()
            || options.cursor.is_some()
            || options.budget_chars.is_some())
    {
        return Err(invalid("todo get accepts only ID and scope"));
    }
    if options.project.is_some() && options.workspace_scope {
        return Err(invalid(
            "Choose exactly one of --project or --workspace-scope",
        ));
    }
    Ok(())
}

pub(super) fn object_id<'a>(options: &'a Options, positional: Option<&'a str>) -> AgentResult<i64> {
    if positional.is_some() && options.object_id.is_some() {
        return Err(invalid("Object ID and --id cannot be combined"));
    }
    let value = positional
        .or(options.object_id.as_deref())
        .ok_or_else(|| invalid("Object ID or --id is required"))?;
    value
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(|| invalid("Invalid object ID"))
}

fn object(
    options: &Options,
    kind: &str,
    id: i64,
    binding: &WorkspaceBinding,
) -> AgentResult<Value> {
    Ok(
        json!({"workspaceId":binding.workspace_id,"scope":scoped(options)?,"kind":kind,"id":id.to_string()}),
    )
}

pub(super) fn get_params(
    options: &Options,
    command: &str,
    id: i64,
    binding: &WorkspaceBinding,
) -> AgentResult<Value> {
    if options.query.is_some() {
        return Err(invalid("get does not accept --query"));
    }
    let kind = match command {
        "todo.get" => "todo",
        "file.get" => "file",
        _ => options
            .kind
            .as_deref()
            .ok_or_else(|| invalid("source read requires --kind"))?,
    };
    if command == "todo.get" {
        return Ok(json!({"target":object(options,kind,id,binding)?}));
    }
    Ok(
        json!({"source":{"object":object(options,kind,id,binding)?,"revision":options.revision,"recordVersion":null,"fileVersion":null},"view":"full","selection":null,"cursor":options.cursor,"budgetChars":options.budget_chars}),
    )
}

pub(super) fn search_params(options: &Options, positional: Option<&str>) -> AgentResult<Value> {
    if positional.is_some() && options.query.is_some() {
        return Err(invalid("Search QUERY and --query cannot be combined"));
    }
    let mut params = json!({"scope":scoped(options)?,"query":positional.or(options.query.as_deref()).ok_or_else(|| invalid("Search query is required"))?,"budgetChars":options.budget_chars});
    if let Some(limit) = options.limit {
        if !(1..=50).contains(&limit) {
            return Err(invalid("Search --limit must be 1–50"));
        }
        params["limit"] = json!(limit);
    }
    if let Some(cursor) = &options.cursor {
        params["cursor"] = json!(cursor);
    }
    if let Some(kinds) = &options.kind {
        let kinds = kinds.split(',').map(str::trim).collect::<Vec<_>>();
        if kinds.iter().any(|kind| kind.is_empty()) {
            return Err(invalid("--kind requires a kind or comma-separated kinds"));
        }
        params["kinds"] = json!(kinds);
    }
    Ok(params)
}

pub(super) fn text_edit_params(
    options: &Options,
    command: &str,
    id: i64,
    binding: &WorkspaceBinding,
) -> AgentResult<Value> {
    if options.query.is_some()
        || options.cursor.is_some()
        || options.limit.is_some()
        || options.revision.is_some()
    {
        return Err(invalid(
            "Text edits accept ID, scope, base revision and text files",
        ));
    }
    if !options.dry_run && options.budget_chars.is_some() {
        return Err(invalid("--budget-chars is only supported with --dry-run"));
    }
    let paths: Vec<&str> = [
        options.old_text_file.as_deref(),
        options.new_text_file.as_deref(),
        options.before_file.as_deref(),
        options.body_file.as_deref(),
    ]
    .into_iter()
    .flatten()
    .collect();
    if paths.iter().filter(|p| **p == "-").count() > 1 {
        return Err(invalid("Only one text file may read stdin"));
    }
    if options.input_file.is_some() || options.patch_file.is_some() {
        return Err(invalid(
            "Text edit shortcuts use text files, not JSON input",
        ));
    }
    let edit = match command {
        "record.replace" => {
            if options.body_file.is_some() {
                return Err(invalid(
                    "record replace uses --old-text-file and --new-text-file",
                ));
            }
            json!({"kind":"replace","oldText":read_text_body(options.old_text_file.as_deref().ok_or_else(|| invalid("--old-text-file is required"))?)?,"newText":read_text_body(options.new_text_file.as_deref().ok_or_else(|| invalid("--new-text-file is required"))?)?})
        }
        "record.append" => {
            json!({"kind":"append","markdown":read_text_body(options.body_file.as_deref().ok_or_else(|| invalid("--body-file is required"))?)?})
        }
        "record.edit" => {
            json!({"kind":"markdown","beforeMarkdown":read_text_body(options.before_file.as_deref().ok_or_else(|| invalid("--before-file is required"))?)?,"afterMarkdown":read_text_body(options.body_file.as_deref().ok_or_else(|| invalid("--body-file is required"))?)?})
        }
        _ => unreachable!(),
    };
    let mut params = json!({"record":object(options,"record",id,binding)?,"baseRevision":options.base_revision.ok_or_else(|| invalid("--base-revision is required"))?,"edit":edit});
    if options.dry_run {
        if let Some(budget) = options.budget_chars {
            params["budgetChars"] = json!(budget);
        }
    } else {
        params["requestId"] = json!(stable_request_id(options)?);
    }
    bounded_generated_params(params)
}

pub(super) fn read_record(
    options: &Options,
    params: Value,
    call: impl FnMut(Value) -> AgentResult<Value>,
    output: Option<&mut dyn FnMut(&str) -> AgentResult<()>>,
) -> AgentResult<Value> {
    if options.format.as_deref() == Some("plain") {
        cli_presentation::record_read_plain_with_output(
            params,
            options.json,
            options.offset,
            options.limit,
            call,
            output,
        )
    } else if options.format.as_deref() == Some("markdown") {
        cli_presentation::record_read_markdown_with_output(
            params,
            options.json,
            options.offset,
            options.limit,
            call,
            output,
        )
    } else {
        cli_presentation::record_read_with_output(
            params,
            options.json,
            options.offset,
            options.limit,
            call,
            output,
        )
    }
}

pub(super) fn search_all(
    mut params: Value,
    plain: bool,
    mut call: impl FnMut(Value) -> AgentResult<Value>,
    mut output: Option<&mut dyn FnMut(&str) -> AgentResult<()>>,
    diagnostics: &mut String,
) -> AgentResult<Value> {
    let mut buffered = String::new();
    let mut previous_cursor = params
        .get("cursor")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut coverage_reported = false;
    let mut max_stale = 0;
    let mut emitted = false;
    let result = (|| loop {
        let mut page = call(params.clone())?;
        let more = page
            .get("hasMore")
            .and_then(Value::as_bool)
            .ok_or_else(|| invalid("Search response is missing hasMore"))?;
        let next = page
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if more
            && next
                .as_ref()
                .is_none_or(|s| s.is_empty() || Some(s) == previous_cursor.as_ref())
        {
            return Err(AgentError::new(
                ErrorCode::RuntimeIncompatible,
                "Search has more results but no advancing nextCursor",
            ));
        }
        if !coverage_reported {
            if let Some(note) = page
                .get("coverageNote")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                diagnostics.push_str(note);
                diagnostics.push('\n');
                coverage_reported = true;
            }
        }
        max_stale = max_stale.max(page.get("staleCount").and_then(Value::as_u64).unwrap_or(0));
        // Already following the continuation. Keep only actionable warnings,
        // rather than buffering a cursor hint for every page.
        if let Some(page) = page.as_object_mut() {
            page.remove("nextCursor");
            page.remove("coverageNote");
            page.insert("hasMore".into(), json!(false));
            page.insert("staleCount".into(), json!(0));
        }
        let out = if plain {
            cli_presentation::response_plain("source.search", Ok(page))
        } else {
            cli_presentation::response("source.search", Ok(page))
        };
        if out.exit_code != 0 {
            return Err(AgentError::new(
                ErrorCode::RuntimeIncompatible,
                "Cannot render search page",
            ));
        }
        if let Some(output) = output.as_deref_mut() {
            output(&out.stdout)?;
            emitted = true;
        } else {
            buffered.push_str(&out.stdout);
        }
        if !more {
            return Ok(json!(buffered));
        }
        let next = next.expect("validated continuation");
        params["cursor"] = json!(next);
        previous_cursor = Some(next);
    })();
    if max_stale > 0 {
        diagnostics.push_str(&format!(
            "Stale sources: {max_stale} (maximum reported across pages)\n"
        ));
    }
    result.map_err(|mut error: AgentError| {
        if emitted {
            if let Some(details) = error
                .details
                .get_or_insert_with(|| json!({}))
                .as_object_mut()
            {
                details.insert("partialOutput".into(), json!(true));
            }
        }
        error
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, collections::HashMap};

    #[test]
    fn environment_only_fills_missing_binding_and_shorthand_scope() {
        let env = HashMap::from([
            ("PROJECT_MIND_WORKSPACE", "\\\\?\\D:\\中文 资料"),
            (
                "PROJECT_MIND_CONNECTION",
                "0123456789abcdef0123456789abcdef",
            ),
            ("PROJECT_MIND_PROJECT_ID", "7"),
        ]);
        let lookup = |name: &str| env.get(name).map(|s| s.to_string());
        let mut opts = Options::default();
        environment(&mut opts, "record.get", lookup).unwrap();
        assert_eq!(opts.workspace, Some(PathBuf::from("\\\\?\\D:\\中文 资料")));
        assert_eq!(opts.project, Some(7));
        required_connection(&opts).unwrap();
        let mut explicit = Options {
            workspace: Some("/explicit".into()),
            connection: Some("a".repeat(32)),
            workspace_scope: true,
            ..Options::default()
        };
        environment(&mut explicit, "record.get", lookup).unwrap();
        assert_eq!(explicit.workspace, Some("/explicit".into()));
        assert_eq!(explicit.project, None);
        assert!(explicit.workspace_scope);
        let mut dto = Options {
            input_file: Some("input.json".into()),
            ..Options::default()
        };
        environment(&mut dto, "record.get", lookup).unwrap();
        assert_eq!(dto.project, None);
        let mut cleared = Options::default();
        environment(&mut cleared, "record.get", |name| match name {
            "PROJECT_MIND_PROJECT_ID" => Some("7".into()),
            "PROJECT_MIND_WORKSPACE_SCOPE" => Some("".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(cleared.project, Some(7));
        assert!(!cleared.workspace_scope);
        let mut discovery = Options::default();
        environment(&mut discovery, "doctor", lookup).unwrap();
        assert_eq!(discovery.project, None);
        for env in [
            HashMap::from([("PROJECT_MIND_PROJECT_ID", "0")]),
            HashMap::from([("PROJECT_MIND_WORKSPACE_SCOPE", "false")]),
            HashMap::from([
                ("PROJECT_MIND_PROJECT_ID", "7"),
                ("PROJECT_MIND_WORKSPACE_SCOPE", "1"),
            ]),
        ] {
            assert!(environment(&mut Options::default(), "record.get", |key| env
                .get(key)
                .map(|s| s.to_string()))
            .is_err());
        }
    }

    #[test]
    fn search_filters_and_current_file_full_read_have_native_shapes() {
        let opts = Options {
            workspace_scope: true,
            kind: Some("record,file".into()),
            limit: Some(50),
            cursor: Some("opaque".into()),
            ..Options::default()
        };
        let params = search_params(&opts, Some("火车 排期")).unwrap();
        assert_eq!(params["kinds"], json!(["record", "file"]));
        assert_eq!(params["cursor"], "opaque");
        assert_eq!(params["limit"], 50);
        let binding = WorkspaceBinding {
            workspace_id: "workspace".into(),
            generation: "generation".into(),
        };
        let params = get_params(
            &Options {
                workspace_scope: true,
                ..Options::default()
            },
            "file.get",
            9,
            &binding,
        )
        .unwrap();
        assert_eq!(params["source"]["object"]["kind"], "file");
        assert_eq!(params["view"], "full");
        assert!(params["source"]["fileVersion"].is_null());
        registry::validate("source.read", &params).unwrap();
    }

    #[test]
    fn all_search_emits_first_page_before_requesting_the_second_and_retains_warnings() {
        let written = Cell::new(false);
        let calls = Cell::new(0);
        let mut body = String::new();
        let mut output = |text: &str| {
            written.set(true);
            body.push_str(text);
            Ok(())
        };
        let mut diagnostics = String::new();
        let result=search_all(json!({"scope":{"kind":"workspace"},"query":"火车"}),false,|params| {
            let page=calls.get(); calls.set(page+1);
            if page==1 { assert!(written.get());assert_eq!(params["cursor"],"next"); }
            Ok(json!({"items":[],"hasMore":page==0,"nextCursor":if page==0 {Some("next")} else {None},"coverageNote":"coverage incomplete","staleCount":1}))
        },Some(&mut output),&mut diagnostics).unwrap();
        assert_eq!(result, "");
        assert_eq!(calls.get(), 2);
        assert_eq!(body.matches("0 results shown").count(), 2);
        assert_eq!(diagnostics.matches("coverage incomplete").count(), 1);
        assert!(diagnostics.contains("Stale sources: 1"));
    }

    #[test]
    fn text_edit_shortcuts_preserve_utf8_and_revision_without_block_ids() {
        let root = tempfile::tempdir().unwrap();
        let before = root.path().join("before.md");
        let after = root.path().join("after.md");
        std::fs::write(&before, "# 火车\n\n旧内容\n").unwrap();
        std::fs::write(
            &after,
            [&[0xef, 0xbb, 0xbf], "# 火车\n\n新内容\n".as_bytes()].concat(),
        )
        .unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "workspace".into(),
            generation: "generation".into(),
        };
        let mut options = Options {
            workspace_scope: true,
            base_revision: Some(7),
            request_id: Some("edit-1".into()),
            before_file: Some(before.to_str().unwrap().into()),
            body_file: Some(after.to_str().unwrap().into()),
            ..Options::default()
        };
        let params = text_edit_params(&options, "record.edit", 44, &binding).unwrap();
        assert_eq!(params["baseRevision"], 7);
        assert_eq!(params["requestId"], "edit-1");
        assert_eq!(params["edit"]["kind"], "markdown");
        assert_eq!(params["edit"]["afterMarkdown"], "# 火车\n\n新内容\n");
        assert!(params.get("blockId").is_none());
        options.dry_run = true;
        options.budget_chars = Some(4000);
        let preview = text_edit_params(&options, "record.edit", 44, &binding).unwrap();
        assert!(preview.get("requestId").is_none());
        assert_eq!(preview["budgetChars"], 4000);
        options.before_file = Some("-".into());
        options.body_file = Some("-".into());
        assert!(text_edit_params(&options, "record.edit", 44, &binding)
            .unwrap_err()
            .message
            .contains("stdin"));
    }
}
