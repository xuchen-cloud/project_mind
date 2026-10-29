//! Human output for common reads; bridge JSON remains an untouched single page.
use super::{cli_help, exit_code, CliOutput};
use crate::agent::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::SourceRef,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashSet, fmt::Write};

const MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;
const MAX_RECORD_PAGES: usize = 4096;

pub(super) fn supports(command: &str) -> bool {
    matches!(
        command,
        "search"
            | "source.search"
            | "knowledge.search"
            | "record.get"
            | "todo.get"
            | "file.get"
            | "source.read"
            | "project.list"
            | "file.list"
            | "record.list"
            | "todo.list"
            | "session.list"
            | "schedule.list"
            | "reference.list"
    )
}

fn malformed() -> AgentError {
    AgentError::new(
        ErrorCode::RuntimeIncompatible,
        "Bridge returned an invalid read response",
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordPage {
    source_ref: SourceRef,
    text: String,
    next_cursor: Option<String>,
    complete: bool,
    #[serde(default)]
    range_complete: bool,
    #[serde(default)]
    window: Option<RecordWindow>,
    #[serde(default)]
    head_revision: Option<u64>,
    #[serde(default)]
    extraction: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordWindow {
    offset: usize,
    total_lines: usize,
    start_line: Option<usize>,
    end_line: Option<usize>,
}

#[cfg(test)]
fn record_read(
    params: Value,
    json_output: bool,
    offset: Option<usize>,
    limit: Option<usize>,
    call: impl FnMut(Value) -> AgentResult<Value>,
) -> AgentResult<Value> {
    record_read_with_output(params, json_output, offset, limit, call, None)
}

fn record_header(source: &SourceRef, head_revision: Option<u64>) -> String {
    let mut text = format!(
        "{} {}: {}\nRevision: {}\n",
        match source.object.kind {
            crate::agent::models::ObjectKind::Record => "Record",
            crate::agent::models::ObjectKind::File => "File",
            _ => "Source",
        },
        source.object.id,
        one_line(&source.title, 160),
        source.revision
    );
    if let Some(head) = head_revision {
        writeln!(text, "Head revision: {head}").expect("string output");
    }
    text.push_str("Source text · 1-based line numbers\n");
    text
}

/// Output callbacks are invoked only after validating a complete page's identity,
/// revision and continuation. Errors propagate even after earlier output was emitted.
pub(super) fn record_read_with_output(
    params: Value,
    json_output: bool,
    offset: Option<usize>,
    limit: Option<usize>,
    call: impl FnMut(Value) -> AgentResult<Value>,
    output: Option<&mut dyn FnMut(&str) -> AgentResult<()>>,
) -> AgentResult<Value> {
    streamed_record_read(params, json_output, offset, limit, call, output, false)
}

pub(super) fn record_read_markdown_with_output(
    mut params: Value,
    json_output: bool,
    offset: Option<usize>,
    limit: Option<usize>,
    call: impl FnMut(Value) -> AgentResult<Value>,
    output: Option<&mut dyn FnMut(&str) -> AgentResult<()>>,
) -> AgentResult<Value> {
    if !json_output {
        params["format"] = json!("markdown");
    }
    streamed_record_read(params, json_output, offset, limit, call, output, true)
}

pub(super) fn source_read_with_output(
    params: Value,
    json_output: bool,
    offset: Option<usize>,
    limit: Option<usize>,
    call: impl FnMut(Value) -> AgentResult<Value>,
    output: Option<&mut dyn FnMut(&str) -> AgentResult<()>>,
) -> AgentResult<Value> {
    streamed_record_read(params, json_output, offset, limit, call, output, false)
}

pub(super) fn record_read_plain_with_output(
    mut params: Value,
    json_output: bool,
    offset: Option<usize>,
    limit: Option<usize>,
    call: impl FnMut(Value) -> AgentResult<Value>,
    output: Option<&mut dyn FnMut(&str) -> AgentResult<()>>,
) -> AgentResult<Value> {
    if !json_output {
        params["format"] = json!("text");
    }
    streamed_record_read(params, json_output, offset, limit, call, output, true)
}

pub(super) fn source_read_plain_with_output(
    params: Value,
    json_output: bool,
    offset: Option<usize>,
    limit: Option<usize>,
    call: impl FnMut(Value) -> AgentResult<Value>,
    output: Option<&mut dyn FnMut(&str) -> AgentResult<()>>,
) -> AgentResult<Value> {
    streamed_record_read(params, json_output, offset, limit, call, output, true)
}

fn streamed_record_read(
    params: Value,
    json_output: bool,
    offset: Option<usize>,
    limit: Option<usize>,
    call: impl FnMut(Value) -> AgentResult<Value>,
    output: Option<&mut dyn FnMut(&str) -> AgentResult<()>>,
    plain_output: bool,
) -> AgentResult<Value> {
    match output {
        None => {
            streamed_record_read_inner(params, json_output, offset, limit, call, None, plain_output)
        }
        Some(output) => {
            let mut emitted = false;
            let mut tracking = |text: &str| {
                output(text)?;
                emitted = true;
                Ok(())
            };
            let result = streamed_record_read_inner(
                params,
                json_output,
                offset,
                limit,
                call,
                Some(&mut tracking),
                plain_output,
            );
            result.map_err(|mut error| {
                if emitted {
                    let details = error.details.get_or_insert_with(|| json!({}));
                    if details.is_object() {
                        details["partialOutput"] = json!(true);
                    }
                }
                error
            })
        }
    }
}

fn streamed_record_read_inner(
    mut params: Value,
    json_output: bool,
    offset: Option<usize>,
    limit: Option<usize>,
    mut call: impl FnMut(Value) -> AgentResult<Value>,
    mut output: Option<&mut dyn FnMut(&str) -> AgentResult<()>>,
    plain_output: bool,
) -> AgentResult<Value> {
    if json_output {
        return call(params);
    }
    let source_input = params.get("source");
    let object: crate::agent::models::ObjectRef = serde_json::from_value(
        source_input
            .and_then(|source| source.get("object"))
            .or_else(|| params.get("object"))
            .or_else(|| params.get("record"))
            .cloned()
            .ok_or_else(malformed)?,
    )
    .map_err(|_| malformed())?;
    let requested_revision = source_input
        .and_then(|source| source.get("revision"))
        .or_else(|| params.get("revision"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let expected_file_version = source_input
        .and_then(|source| source.get("fileVersion"))
        .and_then(Value::as_u64);
    let expected_record_version = source_input
        .and_then(|source| source.get("recordVersion"))
        .and_then(Value::as_u64);
    let source_read = source_input.is_some();
    if params.get("budgetChars").is_none_or(Value::is_null) {
        params["budgetChars"] = json!(12000);
    }
    let mut collected = String::new();
    let mut emit = |text: &str| -> AgentResult<()> {
        if let Some(output) = output.as_mut() {
            output(text)
        } else {
            collected.push_str(text);
            Ok(())
        }
    };
    let mut revision = requested_revision;
    let mut head_revision = None;
    let mut source_versions = None;
    let mut metadata = String::new();
    let mut cursors = HashSet::new();
    let mut pending = String::new();
    let mut line_number = 1usize;
    let mut first_line = 1usize;
    let mut bytes = 0;
    let mut shown = 0;
    let window_end = limit.map(|limit| offset.unwrap_or(1).saturating_sub(1).saturating_add(limit));
    for index in 0..MAX_RECORD_PAGES {
        let page: RecordPage =
            serde_json::from_value(call(params.clone())?).map_err(|_| malformed())?;
        if page.source_ref.object != object
            || page.source_ref.revision.is_empty()
            || (expected_file_version.is_some()
                && page.source_ref.file_version.map(u64::from) != expected_file_version)
            || (expected_record_version.is_some()
                && page.source_ref.record_version.map(u64::from) != expected_record_version)
            || (!source_read
                && (page.source_ref.file_version.is_some()
                    || page.source_ref.record_version.is_some()))
        {
            return Err(malformed());
        }
        if revision
            .as_ref()
            .is_some_and(|value| value != &page.source_ref.revision)
            || (index > 0 && head_revision != page.head_revision)
            || source_versions.is_some_and(|versions| {
                versions != (page.source_ref.file_version, page.source_ref.record_version)
            })
        {
            return Err(AgentError::new(
                ErrorCode::SourceChanged,
                "Source revision changed during reading; restart the read",
            ));
        }
        // SourceReadPage explicitly allows an exhausted partial extraction with
        // neither completeness flag set. It is a valid available-text result.
        let extraction_incomplete = source_read
            && page.extraction.as_ref().is_some_and(|extraction| {
                extraction
                    .pointer("/coverage/complete")
                    .and_then(Value::as_bool)
                    == Some(false)
            });
        let finished = page.next_cursor.is_none()
            && (page.complete || page.range_complete || extraction_incomplete);
        if !finished
            && (page.complete
                || page.text.is_empty()
                || page.next_cursor.as_ref().is_none_or(|cursor| {
                    cursor.is_empty() || cursor.len() > 2048 || !cursors.insert(cursor.clone())
                }))
        {
            return Err(malformed());
        }
        bytes += page.text.len();
        if bytes > MAX_RECORD_BYTES {
            return Err(AgentError::new(
                ErrorCode::BudgetExceeded,
                "Source exceeds the 8 MiB read cap; use --json with --cursor",
            ));
        }
        revision = Some(page.source_ref.revision.clone());
        head_revision = page.head_revision;
        source_versions = Some((page.source_ref.file_version, page.source_ref.record_version));
        if index == 0 {
            metadata = record_header(&page.source_ref, page.head_revision)
                .replace("Source text · 1-based line numbers\n", "");
            if !plain_output {
                emit(&record_header(&page.source_ref, page.head_revision))?;
            }
            if let Some(window) = &page.window {
                line_number = window.start_line.unwrap_or(window.offset);
                first_line = line_number;
            }
        }
        // Keep an unfinished line across pages; never duplicate or emit a partial line.
        pending.push_str(&page.text);
        let complete_end = if finished {
            pending.len()
        } else {
            pending.rfind('\n').map_or(0, |end| end + 1)
        };
        let complete = pending[..complete_end].to_owned();
        for fragment in complete.split_inclusive('\n') {
            let in_window = page.window.is_some()
                || (line_number >= offset.unwrap_or(1)
                    && window_end.is_none_or(|end| line_number <= end));
            if in_window {
                if plain_output {
                    emit(fragment)?;
                } else {
                    emit(&format!(
                        "{} | {}\n",
                        line_number,
                        fragment
                            .strip_suffix('\n')
                            .unwrap_or(fragment)
                            .strip_suffix('\r')
                            .unwrap_or(fragment.strip_suffix('\n').unwrap_or(fragment))
                    ))?;
                }
                shown += 1;
            }
            line_number += 1;
        }
        pending.drain(..complete_end);
        if finished || (page.window.is_none() && window_end.is_some_and(|end| line_number > end)) {
            if !plain_output {
                if shown == 0 {
                    emit("(no lines in this window)\n")?;
                }
                if let Some(window) = &page.window {
                    emit(&format!(
                        "Showing lines {}–{} of {}.\n",
                        first_line,
                        window.end_line.unwrap_or(0),
                        window.total_lines
                    ))?;
                } else if finished {
                    if let Some(extraction) = &page.extraction {
                        emit(&format!(
                            "Extraction state: {}{}\n",
                            extraction
                                .get("state")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown"),
                            extraction
                                .get("reason")
                                .and_then(Value::as_str)
                                .map(|reason| format!(" ({reason})"))
                                .unwrap_or_default()
                        ))?;
                    }
                    let label = if page.extraction.as_ref().is_some_and(|extraction| {
                        extraction
                            .pointer("/coverage/complete")
                            .and_then(Value::as_bool)
                            == Some(false)
                    }) {
                        "Available text read; extraction incomplete"
                    } else {
                        "Read complete"
                    };
                    emit(&format!("{label} · {} lines.\n", line_number - 1))?;
                } else {
                    emit("Requested window complete; remaining content was not read.\n")?;
                }
            }
            if plain_output {
                if let Some(window) = &page.window {
                    writeln!(
                        metadata,
                        "Showing lines {}–{} of {}.",
                        first_line,
                        window.end_line.unwrap_or(0),
                        window.total_lines
                    )
                    .expect("string output");
                }
                if let Some(extraction) = &page.extraction {
                    writeln!(
                        metadata,
                        "Extraction state: {}{}",
                        extraction
                            .get("state")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown"),
                        extraction
                            .get("reason")
                            .and_then(Value::as_str)
                            .map(|reason| format!(" ({reason})"))
                            .unwrap_or_default()
                    )
                    .expect("string output");
                    if extraction
                        .pointer("/coverage/complete")
                        .and_then(Value::as_bool)
                        == Some(false)
                    {
                        metadata.push_str(
                            "Extraction incomplete; output contains available text only.\n",
                        );
                    }
                }
            }
            return Ok(if plain_output {
                json!({"stdout":collected,"stderr":metadata})
            } else {
                json!(collected)
            });
        }
        if source_read {
            params["source"]["revision"] = json!(revision);
        } else {
            params["revision"] = json!(revision);
        }
        params["cursor"] = json!(page.next_cursor);
    }
    Err(AgentError::new(
        ErrorCode::BudgetExceeded,
        "Source exceeds the 4096-page cap; use --json with --cursor",
    ))
}

fn one_line(text: &str, max_chars: usize) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = normalized.chars();
    let mut out: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        out.push('…');
    }
    out
}

fn scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn list_text(command: &str, data: &Value, search: bool) -> AgentResult<String> {
    let items = data
        .as_array()
        .or_else(|| data.get("items").and_then(Value::as_array))
        .or_else(|| data.get("projects").and_then(Value::as_array))
        .ok_or_else(malformed)?;
    let total = data.get("totalCount").and_then(Value::as_u64);
    let mut out = match total {
        Some(total) if data.get("countComplete").and_then(Value::as_bool) == Some(false) => {
            format!(
                "{} shown / at least {} known matches (count incomplete)\n",
                items.len(),
                total
            )
        }
        Some(total) => format!("{} shown / {} total\n", items.len(), total),
        None if search => format!("{} results shown\n", items.len()),
        None => format!("{} results\n", items.len()),
    };
    if let Some(count) = data
        .get("unreadableCount")
        .and_then(Value::as_u64)
        .filter(|count| *count > 0)
    {
        writeln!(
            out,
            "Unreadable or incompletely extracted files: {count}; content search may omit matches."
        )
        .expect("string output");
    }
    for item in items {
        let object = item
            .get("object")
            .or_else(|| item.pointer("/sourceRef/object"));
        let kind = object
            .and_then(|v| v.get("kind"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let id = object
            .and_then(|v| v.get("id"))
            .and_then(scalar)
            .or_else(|| item.get("id").and_then(scalar))
            .or_else(|| item.get("nodeId").and_then(scalar))
            .unwrap_or_default();
        let title = ["title", "name", "safeName", "content"]
            .iter()
            .find_map(|key| item.get(*key).and_then(Value::as_str))
            .or_else(|| item.pointer("/sourceRef/title").and_then(Value::as_str))
            .unwrap_or("(untitled)");
        let scope = object.and_then(|v| v.get("scope"));
        let location = match scope.and_then(|v| v.get("kind")).and_then(Value::as_str) {
            Some("workspace") => " · workspace".to_owned(),
            Some("project") => format!(
                " · project {}",
                scope
                    .and_then(|v| v.get("projectId"))
                    .and_then(scalar)
                    .unwrap_or_default()
            ),
            _ => String::new(),
        };
        let status = item
            .get("status")
            .and_then(Value::as_str)
            .map(|s| format!(" [{s}]"))
            .unwrap_or_default();
        let child = item
            .get("childId")
            .and_then(scalar)
            .map(|id| format!("/child:{id}"))
            .unwrap_or_default();
        writeln!(
            out,
            "{}{}{}{}{}  {}",
            kind,
            if kind.is_empty() { "" } else { " " },
            id,
            child,
            location,
            one_line(title, 160) + &status
        )
        .expect("string output");
        if command == "todo.list" {
            if let Some(content) = item.get("content").and_then(Value::as_str) {
                if content.contains('\n') || content.chars().count() > 160 {
                    out.push_str(content);
                    if !content.ends_with('\n') {
                        out.push('\n');
                    }
                }
            }
            for (field, label) in [
                ("dueDate", "Due"),
                ("priority", "Priority"),
                ("parentContent", "Parent Todo"),
            ] {
                if let Some(value) = item.get(field).and_then(scalar) {
                    writeln!(out, "  {label}: {value}").expect("string output");
                }
            }
            if item.get("contentTruncated").and_then(Value::as_bool) == Some(true) {
                out.push_str("  Content truncated; use todo get for the complete Todo.\n");
            }
        }
        if matches!(command, "record.list" | "file.list") {
            if let Some(content) = item.get("content").and_then(Value::as_str) {
                out.push_str(content);
                if !content.ends_with('\n') {
                    out.push('\n');
                }
            }
            content_status(&mut out, item);
        }
        if let Some(excerpt) = item
            .get("excerpt")
            .or_else(|| item.get("snippet"))
            .and_then(Value::as_str)
        {
            if !excerpt.is_empty() {
                writeln!(out, "  {}", one_line(excerpt, 240)).expect("string output");
            }
        }
    }
    if !search {
        if let Some(cursor) = data.get("nextCursor").and_then(Value::as_str) {
            writeln!(out, "More results: --cursor {cursor}").expect("string output");
        } else if data.get("hasMore").and_then(Value::as_bool) == Some(true) {
            out.push_str(
                "More results available; narrow the query or use --json for the exact page.\n",
            );
        }
        if let Some(stale) = data
            .get("staleCount")
            .and_then(Value::as_u64)
            .filter(|count| *count > 0)
        {
            writeln!(out, "Stale sources: {stale}").expect("string output");
        }
    }
    Ok(out)
}

fn content_status(out: &mut String, data: &Value) {
    if data.get("contentComplete").and_then(Value::as_bool) == Some(false) {
        out.push_str("Content incomplete.\n");
    }
    for (field, label) in [
        ("contentState", "Content state"),
        ("contentReason", "Content reason"),
    ] {
        if let Some(value) = data.get(field).and_then(scalar) {
            writeln!(out, "{label}: {value}").expect("string output");
        }
    }
    if let Some(error) = data.get("contentError") {
        if let Ok(error) = serde_json::from_value::<AgentError>(error.clone()) {
            writeln!(out, "Content error: {:?}: {}", error.code, error.message)
                .expect("string output");
            error_hints(out, &error);
        }
    }
}

fn error_hints(out: &mut String, error: &AgentError) {
    if let Some(details) = &error.details {
        if details.get("partialOutput").and_then(Value::as_bool) == Some(true) {
            out.push_str("Output is partial; the read did not complete.\n");
        }
        if let Some(minimum) = details.get("minimumBudgetChars").and_then(Value::as_u64) {
            if minimum <= 12000 {
                writeln!(
                    out,
                    "Use --budget-chars {minimum} or greater (minimumBudgetChars: {minimum})."
                )
                .expect("string output");
            } else {
                writeln!(out, "minimumBudgetChars: {minimum} exceeds the 12000-character page budget; use metadata mode or select a smaller content range.").expect("string output");
            }
        }
        for key in [
            "requestId",
            "method",
            "transportKind",
            "operationId",
            "headRevision",
            "currentRevision",
            "expectedRevision",
            "currentVersionNumber",
            "expectedVersionNumber",
            "currentContentHash",
            "expectedContentHash",
            "bodyHash",
            "reason",
            "format",
        ] {
            if let Some(value) = details.get(key).and_then(scalar) {
                writeln!(out, "{key}: {value}").expect("string output");
            }
        }
        if details.get("writeStateUnknown").and_then(Value::as_bool) == Some(true) {
            out.push_str("Write outcome is unknown. Do not repeat it with a new request ID. Read the target and inspect operation receipts for this request before deciding whether to retry.\n");
        }
        if let Some(action) = details.pointer("/recovery/action").and_then(Value::as_str) {
            match action {
                "office_inspect" => out.push_str("Use office inspect for this File to check its supported Office content.\n"),
                "open_object" => out.push_str("Open the File list in its owning Workspace or Project and choose ‘Register current content and open’ before reading the new version.\n"),
                _ => (),
            }
        }
    }
    if matches!(
        error.code,
        ErrorCode::RevisionConflict
            | ErrorCode::SourceChanged
            | ErrorCode::UndoConflict
            | ErrorCode::FileChangedUnregistered
    ) {
        out.push_str("Read the current target again and rebuild the change against its current revision; do not reuse a stale baseline.\n");
    }
}

fn todo_text(data: &Value) -> AgentResult<String> {
    let snapshot = data.get("snapshot").ok_or_else(malformed)?;
    let content = snapshot
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(malformed)?;
    let mut out = format!(
        "Todo {}\n",
        data.pointer("/object/id")
            .and_then(scalar)
            .unwrap_or_default()
    );
    for key in ["revision", "status", "priority", "dueDate"] {
        if let Some(value) = snapshot
            .get(key)
            .and_then(scalar)
            .or_else(|| data.get(key).and_then(scalar))
        {
            writeln!(out, "{key}: {value}").expect("string output");
        }
    }
    writeln!(out, "{content}").expect("string output");
    if let Some(children) = snapshot.get("children").and_then(Value::as_array) {
        for child in children {
            writeln!(
                out,
                "  Subtask {} [{}] due {}: {}",
                child.get("id").and_then(scalar).unwrap_or_default(),
                child.get("status").and_then(Value::as_str).unwrap_or(""),
                child
                    .get("dueDate")
                    .and_then(Value::as_str)
                    .unwrap_or("undated"),
                child.get("content").and_then(Value::as_str).unwrap_or("")
            )
            .expect("string output");
        }
    }
    Ok(out)
}

fn source_text(data: &Value) -> AgentResult<String> {
    let text = data
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(malformed)?;
    let mut out = String::new();
    if let Some(source) = data.get("sourceRef") {
        writeln!(
            out,
            "{} {}: {}\nRevision: {}",
            source
                .pointer("/object/kind")
                .and_then(Value::as_str)
                .unwrap_or("source"),
            source
                .pointer("/object/id")
                .and_then(scalar)
                .unwrap_or_default(),
            source.get("title").and_then(Value::as_str).unwrap_or(""),
            source.get("revision").and_then(Value::as_str).unwrap_or("")
        )
        .expect("string output");
    }
    out.push_str(text);
    if !text.ends_with('\n') {
        out.push('\n');
    }
    if data.get("complete").and_then(Value::as_bool) == Some(false) {
        out.push_str("Content incomplete.\n");
    }
    if let Some(cursor) = data.get("nextCursor").and_then(Value::as_str) {
        writeln!(out, "More content: --cursor {cursor}").expect("string output");
    }
    if let Some(extraction) = data.get("extraction") {
        writeln!(
            out,
            "Extraction state: {}{}",
            extraction
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("unknown"),
            extraction
                .get("reason")
                .and_then(Value::as_str)
                .map(|reason| format!(" ({reason})"))
                .unwrap_or_default()
        )
        .expect("string output");
    }
    content_status(&mut out, data);
    Ok(out)
}

/// Plain reads retain only content on stdout; diagnostics remain visible on stderr.
pub(super) fn response_plain(command: &str, result: AgentResult<Value>) -> CliOutput {
    let mut rendered = response(command, result.clone());
    if rendered.exit_code != 0 {
        return rendered;
    }
    let data = result.expect("successful rendering");
    if matches!(command, "record.get" | "file.get" | "source.read") {
        if let Some(text) = data.get("text").and_then(Value::as_str) {
            rendered.stdout = text.to_owned();
            if let Some(revision) = data.pointer("/sourceRef/revision").and_then(Value::as_str) {
                writeln!(rendered.stderr, "Revision: {revision}").expect("string output");
            }
            if let Some(extraction) = data.get("extraction") {
                writeln!(
                    rendered.stderr,
                    "Extraction state: {}",
                    extraction
                        .get("state")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                )
                .expect("string output");
                if extraction
                    .pointer("/coverage/complete")
                    .and_then(Value::as_bool)
                    == Some(false)
                {
                    rendered.stderr.push_str("Extraction incomplete.\n");
                }
            }
            if data.get("complete").and_then(Value::as_bool) == Some(false) {
                rendered.stderr.push_str("Content incomplete.\n");
            }
            if let Some(cursor) = data.get("nextCursor").and_then(Value::as_str) {
                writeln!(rendered.stderr, "More content: --cursor {cursor}")
                    .expect("string output");
            }
            content_status(&mut rendered.stderr, &data);
        }
        return rendered;
    }
    if command == "todo.get" {
        let snapshot = &data["snapshot"];
        let mut text = snapshot["content"].as_str().unwrap_or("").to_owned();
        if let Some(children) = snapshot["children"].as_array() {
            for child in children {
                writeln!(text, "\n- {}", child["content"].as_str().unwrap_or(""))
                    .expect("string output");
            }
        }
        rendered.stdout = text;
        for key in ["revision", "bodyHash"] {
            if let Some(value) = data.get(key).and_then(scalar) {
                writeln!(rendered.stderr, "{key}: {value}").expect("string output");
            }
        }
        return rendered;
    }
    let items = data
        .as_array()
        .or_else(|| data.get("items").and_then(Value::as_array))
        .or_else(|| data.get("projects").and_then(Value::as_array))
        .expect("validated list");
    let mut text = String::new();
    for item in items {
        let id = item
            .pointer("/object/id")
            .or_else(|| item.pointer("/sourceRef/object/id"))
            .or_else(|| item.get("id"))
            .or_else(|| item.get("nodeId"))
            .and_then(scalar)
            .unwrap_or_default();
        let title = ["title", "name", "safeName", "content"]
            .iter()
            .find_map(|key| item.get(*key).and_then(Value::as_str))
            .or_else(|| item.pointer("/sourceRef/title").and_then(Value::as_str))
            .unwrap_or("(untitled)");
        writeln!(text, "{id}\t{title}").expect("string output");
        if let Some(body) = item
            .get("content")
            .and_then(Value::as_str)
            .filter(|body| *body != title)
            .or_else(|| {
                item.get("excerpt")
                    .or_else(|| item.get("snippet"))
                    .and_then(Value::as_str)
            })
        {
            text.push_str(body);
            if !body.ends_with('\n') {
                text.push('\n');
            }
        }
        content_status(&mut rendered.stderr, item);
    }
    if data.get("countComplete").and_then(Value::as_bool) == Some(false) {
        rendered
            .stderr
            .push_str("Count incomplete; unreadable files may contain additional matches.\n");
    }
    if let Some(count) = data
        .get("unreadableCount")
        .and_then(Value::as_u64)
        .filter(|count| *count > 0)
    {
        writeln!(
            rendered.stderr,
            "Unreadable or incompletely extracted files: {count}"
        )
        .expect("string output");
    }
    // Inventory continuations are in the decorated stdout; preserve them as diagnostics.
    if !matches!(command, "search" | "source.search" | "knowledge.search") {
        if let Some(cursor) = data.get("nextCursor").and_then(Value::as_str) {
            writeln!(rendered.stderr, "More results: --cursor {cursor}").expect("string output");
        } else if data.get("hasMore").and_then(Value::as_bool) == Some(true) {
            rendered
                .stderr
                .push_str("More results available; narrow the query.\n");
        }
    }
    rendered.stdout = text;
    rendered
}

pub(super) fn response(command: &str, result: AgentResult<Value>) -> CliOutput {
    let search = matches!(command, "search" | "source.search" | "knowledge.search");
    let mut diagnostics = String::new();
    if search {
        if let Ok(data) = &result {
            if command == "knowledge.search"
                && data.get("sourceFallbackRequired").and_then(Value::as_bool) == Some(true)
            {
                diagnostics.push_str("Knowledge results require source lookup (sourceFallbackRequired=true); use mind search to find source body content.\n");
            }
            if let Some(note) = data
                .get("coverageNote")
                .and_then(Value::as_str)
                .filter(|note| !note.is_empty())
            {
                writeln!(diagnostics, "{note}").expect("string output");
            }
            if let Some(cursor) = data.get("nextCursor").and_then(Value::as_str) {
                writeln!(diagnostics, "More results: --cursor {cursor}").expect("string output");
            }
            if data.get("hasMore").and_then(Value::as_bool) == Some(true) {
                diagnostics.push_str("More matches available (hasMore=true); use --cursor with the next cursor, or narrow the query.\n");
            }
            if let Some(stale) = data
                .get("staleCount")
                .and_then(Value::as_u64)
                .filter(|count| *count > 0)
            {
                writeln!(diagnostics, "Stale sources: {stale}").expect("string output");
            }
        }
    }
    if matches!(command, "record.get" | "file.get" | "source.read") {
        if let Ok(data) = &result {
            if let (Some(stdout), Some(stderr)) = (
                data.get("stdout").and_then(Value::as_str),
                data.get("stderr").and_then(Value::as_str),
            ) {
                return CliOutput {
                    stdout: stdout.to_owned(),
                    stderr: stderr.to_owned(),
                    exit_code: 0,
                };
            }
        }
    }
    let rendered = result.and_then(|data| {
        if command == "record.get"
            || (matches!(command, "file.get" | "source.read") && data.is_string())
        {
            data.as_str().map(str::to_owned).ok_or_else(malformed)
        } else {
            match command {
                "todo.get" => todo_text(&data),
                "file.get" | "source.read" => source_text(&data),
                _ => list_text(command, &data, search),
            }
        }
    });
    match rendered {
        Ok(stdout) => CliOutput {
            stdout,
            stderr: diagnostics,
            exit_code: 0,
        },
        Err(error) => {
            let mut stderr = format!(
                "{}: {}\n",
                serde_json::to_value(error.code)
                    .expect("error code")
                    .as_str()
                    .expect("error name"),
                error.message
            );
            error_hints(&mut stderr, &error);
            if error.code == ErrorCode::InvalidArgument {
                stderr.push_str(&cli_help::command(command));
            }
            CliOutput {
                stdout: String::new(),
                stderr,
                exit_code: exit_code(&error),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> Value {
        json!({"object":{"workspaceId":"w","scope":{"kind":"workspace"},"kind":"record","id":"23"}})
    }
    fn page(text: &str, revision: &str, cursor: Option<&str>) -> Value {
        json!({"sourceRef":{"object":params()["object"],"revision":revision,
            "title":"A saved Record","excerpt":"","fileVersion":null,"recordVersion":null,"blockId":null,"locator":null},
            "text":text,"spans":[],"nextCursor":cursor,"complete":cursor.is_none(),"rangeComplete":cursor.is_none()})
    }
    #[test]
    fn text_read_joins_pages_before_numbering_lines_and_preserves_blank_unicode_lines() {
        let mut calls = 0;
        let out = record_read(params(), false, None, None, |request| {
            calls += 1;
            if calls == 1 {
                assert!(request.get("revision").is_none());
                Ok(page("第一", "r1", Some("page2")))
            } else {
                assert_eq!(request["revision"], "r1");
                assert_eq!(request["cursor"], "page2");
                Ok(page("行\n\n第三行\n", "r1", None))
            }
        })
        .unwrap();
        assert_eq!(calls, 2);
        let text = out.as_str().unwrap();
        assert!(text.contains("1 | 第一行\n2 | \n3 | 第三行\n"));
        assert!(!text.contains("4 |"), "{text}");
    }
    #[test]
    fn text_read_rejects_changed_revision_or_object_and_propagates_later_errors() {
        for failure in ["revision", "object", "denied", "unavailable", "changed"] {
            let mut calls = 0;
            let error = record_read(params(), false, None, None, |_| {
                calls += 1;
                if calls == 1 {
                    return Ok(page("private partial", "r1", Some("page2")));
                }
                match failure {
                    "denied" => Err(AgentError::new(ErrorCode::ScopeDenied, "revoked")),
                    "unavailable" => Err(AgentError::new(ErrorCode::RuntimeUnavailable, "closed")),
                    "changed" => Err(AgentError::new(
                        ErrorCode::WorkspaceChanged,
                        "generation changed",
                    )),
                    "revision" => Ok(page("different body", "r2", None)),
                    _ => {
                        let mut value = page("wrong object", "r1", None);
                        value["sourceRef"]["object"]["id"] = json!("24");
                        Ok(value)
                    }
                }
            })
            .unwrap_err();
            let expected = match failure {
                "denied" => ErrorCode::ScopeDenied,
                "unavailable" => ErrorCode::RuntimeUnavailable,
                "changed" => ErrorCode::WorkspaceChanged,
                "revision" => ErrorCode::SourceChanged,
                _ => ErrorCode::RuntimeIncompatible,
            };
            assert_eq!(error.code, expected, "{failure}");
            let out = response("record.get", Err(error));
            assert!(out.stdout.is_empty());
            assert!(!out.stderr.contains("private partial"));
        }
    }
    #[test]
    fn explicit_revision_is_checked_on_the_first_page() {
        let mut input = params();
        input["revision"] = json!("requested");
        assert_eq!(
            record_read(input, false, None, None, |_| Ok(page(
                "body",
                "different",
                None
            )))
            .unwrap_err()
            .code,
            ErrorCode::SourceChanged
        );
    }
    #[test]
    fn total_byte_and_page_caps_and_invalid_continuations_fail_explicitly() {
        let mut calls = 0;
        let error = record_read(params(), false, None, None, |_| {
            calls += 1;
            Ok(page(
                &"x".repeat(MAX_RECORD_BYTES / 2 + 1),
                "r1",
                Some(if calls == 1 { "p2" } else { "p3" }),
            ))
        })
        .unwrap_err();
        assert_eq!(calls, 2);
        assert_eq!(error.code, ErrorCode::BudgetExceeded);
        assert!(error.message.contains("8 MiB"));
        let mut calls = 0;
        let error = record_read(params(), false, None, None, |_| {
            calls += 1;
            Ok(page("x", "r1", Some(&format!("p{calls}"))))
        })
        .unwrap_err();
        assert_eq!(calls, MAX_RECORD_PAGES);
        assert_eq!(error.code, ErrorCode::BudgetExceeded);
        for mode in ["cycle", "empty", "incomplete", "malformed"] {
            let error = record_read(params(), false, None, None, |_| {
                Ok(match mode {
                    "cycle" => page("x", "r1", Some("same-cursor")),
                    "empty" => page("", "r1", Some("next")),
                    "incomplete" => {
                        let mut p = page("x", "r1", None);
                        p["complete"] = json!(false);
                        p["rangeComplete"] = json!(false);
                        p
                    }
                    _ => json!({}),
                })
            })
            .unwrap_err();
            assert_eq!(error.code, ErrorCode::RuntimeIncompatible, "{mode}");
        }
    }
    #[test]
    fn line_windows_keep_original_numbers_and_describe_empty_windows() {
        let input = page("one\ntwo\n三\nfour", "r1", None);
        let read = |offset, limit| {
            record_read(params(), false, offset, limit, |_| Ok(input.clone())).unwrap()
        };
        let out = read(Some(2), Some(2));
        let text = out.as_str().unwrap();
        assert!(text.contains("2 | two\n3 | 三\n"), "{text}");
        assert!(!text.contains("1 | one"));
        assert!(!text.contains("4 | four"));
        assert!(read(Some(usize::MAX), None)
            .as_str()
            .unwrap()
            .contains("no lines in this window"));
        let empty = record_read(params(), false, None, None, |_| Ok(page("", "r1", None))).unwrap();
        assert!(empty.as_str().unwrap().contains("no lines in this window"));
    }
    #[test]
    fn human_record_page_budget_reduces_calls_preserves_explicit_budget_and_leaves_json_untouched()
    {
        let body = "x".repeat(9000);
        for budget in [None, Some(Value::Null), Some(json!(4000))] {
            let mut input = params();
            if let Some(budget) = &budget {
                input["budgetChars"] = budget.clone();
            }
            let expected_budget = if budget == Some(json!(4000)) {
                4000
            } else {
                12000
            };
            let mut calls = 0;
            let mut offset = 0;
            let output = record_read(input.clone(), false, None, None, |request| {
                calls += 1;
                assert_eq!(request["budgetChars"], expected_budget);
                // Reserve room for serialized metadata in this mock bridge page.
                let capacity = request["budgetChars"].as_u64().unwrap() as usize - 1000;
                let end = (offset + capacity).min(body.len());
                let result = page(
                    &body[offset..end],
                    "r1",
                    if end < body.len() {
                        Some(if calls == 1 { "p2" } else { "p3" })
                    } else {
                        None
                    },
                );
                offset = end;
                Ok(result)
            })
            .unwrap();
            assert_eq!(calls, if expected_budget == 12000 { 1 } else { 3 });
            assert!(output.as_str().unwrap().contains(&format!("1 | {body}\n")));

            let original_page = page("one bounded page", "r1", Some("continuation"));
            let mut json_calls = 0;
            let output = record_read(input.clone(), true, None, None, |request| {
                json_calls += 1;
                assert_eq!(request, input);
                Ok(original_page.clone())
            })
            .unwrap();
            assert_eq!(json_calls, 1);
            assert_eq!(output, original_page);
        }
    }
    #[test]
    fn json_read_returns_exactly_one_original_page_even_if_incomplete() {
        let expected = page("one page", "r1", Some("next"));
        let mut calls = 0;
        let out = record_read(params(), true, None, None, |request| {
            calls += 1;
            assert_eq!(request, params());
            Ok(expected.clone())
        })
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(out, expected);
    }
    #[test]
    fn search_shows_coverage_note_only_on_stderr_even_for_no_results() {
        for items in [
            json!([]),
            json!([{"sourceRef":{"object":{"kind":"record","id":"23","scope":{"kind":"workspace"}}},"title":"Saved title","excerpt":"match in body"}]),
        ] {
            let out = response(
                "search",
                Ok(json!({"items":items,"hasMore":false,"staleCount":0,
                "coverageNote":"Records use saved content; other sources may have incomplete index coverage."})),
            );
            assert_eq!(out.exit_code, 0, "{}", out.stderr);
            assert!(out.stderr.contains("Records use saved content"));
            assert!(!out.stdout.contains("index coverage"));
            if items.as_array().unwrap().is_empty() {
                assert_eq!(out.stdout, "0 results shown\n");
            } else {
                assert!(out
                    .stdout
                    .contains("record 23 · workspace  Saved title\n  match in body\n"));
            }
        }
    }
    #[test]
    fn knowledge_search_uses_registered_response_dto_snippets_and_source_fallback() {
        use crate::{
            agent::{context::EpistemicStatus, models::Scope},
            knowledge_service::{KnowledgeSearchCard, KnowledgeSearchPage},
        };
        for empty in [false, true] {
            for fallback in [false, true] {
                let page = KnowledgeSearchPage {
                    scope: Scope::Workspace,
                    items: if empty {
                        vec![]
                    } else {
                        vec![KnowledgeSearchCard {
                            node_id: "knowledge-node".into(),
                            title: "Known topic".into(),
                            snippet: "Actual KnowledgeSearchCard snippet".into(),
                            kind: "fact".into(),
                            revision: 3,
                            stale: false,
                            epistemic_status: EpistemicStatus::Recorded,
                        }]
                    },
                    next_cursor: None,
                    source_fallback_required: fallback,
                };
                let data = serde_json::to_value(page).unwrap();
                assert!(data.get("sourceFallbackRequired").is_some());
                let out = response("knowledge.search", Ok(data));
                assert_eq!(out.exit_code, 0, "{}", out.stderr);
                if empty {
                    assert_eq!(out.stdout, "0 results shown\n");
                } else {
                    assert!(
                        out.stdout.contains(
                            "knowledge-node  Known topic\n  Actual KnowledgeSearchCard snippet\n"
                        ),
                        "{}",
                        out.stdout
                    );
                }
                assert_eq!(out.stderr.contains("sourceFallbackRequired=true"), fallback);
                assert!(!out.stdout.contains("sourceFallbackRequired"));
                if !fallback {
                    assert!(out.stderr.is_empty(), "{}", out.stderr);
                }
            }
        }
    }
    #[test]
    fn inventory_text_shows_scope_counts_continuation_and_action_identity() {
        let out = response(
            "todo.list",
            Ok(
                json!({"items":[{"object":{"kind":"todo","id":"3","scope":{"kind":"project","projectId":7}},
            "childId":9,"content":"Do the thing","status":"unfinished"}],"totalCount":5,"hasMore":true,"nextCursor":"next"}),
            ),
        );
        assert_eq!(out.exit_code, 0);
        assert!(out.stdout.contains("1 shown / 5 total"));
        assert!(out
            .stdout
            .contains("todo 3/child:9 · project 7  Do the thing [unfinished]"));
        assert!(out.stdout.contains("More results: --cursor next"));
        let out = response(
            "record.list",
            Ok(json!({"items":[],"totalCount":12,"hasMore":false})),
        );
        assert_eq!(out.stdout, "0 shown / 12 total\n");
    }
}

#[cfg(test)]
mod window_tests {
    use super::*;
    fn input() -> Value {
        json!({"object":{"workspaceId":"w","scope":{"kind":"workspace"},"kind":"record","id":"23"}})
    }
    fn page(text: &str, cursor: Option<&str>) -> Value {
        json!({"sourceRef":{"object":input()["object"],"revision":"r1","title":"Saved","excerpt":""},
            "text":text,"nextCursor":cursor,"complete":cursor.is_none()})
    }
    #[test]
    fn requested_complete_lines_stop_before_any_later_page_or_failure() {
        let mut calls = 0;
        let out = record_read(input(), false, Some(2), Some(2), |_| {
            calls += 1;
            assert_eq!(calls, 1, "must not request the unread later page");
            Ok(page("one\ntwo\nthree\nunfinished fourth", Some("unread")))
        })
        .unwrap();
        let text = out.as_str().unwrap();
        assert!(text.contains("2 | two\n3 | three\n"), "{text}");
        assert!(!text.contains("unfinished fourth"));
    }
    #[test]
    fn window_crossing_page_boundary_waits_for_the_last_complete_line() {
        let mut calls = 0;
        let out = record_read(input(), false, Some(2), Some(1), |request| {
            calls += 1;
            match calls {
                1 => Ok(page("one\nsec", Some("p2"))),
                2 => {
                    assert_eq!(request["revision"], "r1");
                    Ok(page("ond", Some("p3")))
                }
                3 => {
                    assert_eq!(request["cursor"], "p3");
                    Ok(page("\nthird unfinished", Some("never-read")))
                }
                _ => panic!("window already complete"),
            }
        })
        .unwrap();
        assert_eq!(calls, 3);
        let text = out.as_str().unwrap();
        assert!(text.contains("2 | second\n"), "{text}");
        assert!(!text.contains("third unfinished"));
        assert!(!text.contains("Read complete"));
    }
    #[test]
    fn final_page_completes_a_line_without_newline_and_reports_exact_total() {
        let out = record_read(input(), false, Some(2), Some(1), |_| {
            Ok(page("one\ntwo", None))
        })
        .unwrap();
        let text = out.as_str().unwrap();
        assert!(text.contains("2 | two\n"));
        assert!(!text.contains("3 |"));
    }
    #[test]
    fn current_record_rejects_versioned_source_metadata() {
        for field in ["fileVersion", "recordVersion"] {
            let mut value = page("one\n", Some("next"));
            value["sourceRef"][field] = json!(1);
            let error =
                record_read(input(), false, None, Some(1), |_| Ok(value.clone())).unwrap_err();
            assert_eq!(error.code, ErrorCode::RuntimeIncompatible, "{field}");
        }
    }
    #[test]
    fn search_budget_omission_is_reported_on_stderr_even_without_visible_items() {
        let out = response(
            "search",
            Ok(
                json!({"items":[],"hasMore":true,"staleCount":3,"coverageNote":"Incomplete coverage"}),
            ),
        );
        assert_eq!(out.exit_code, 0);
        assert_eq!(out.stdout, "0 results shown\n");
        assert!(out.stderr.contains("hasMore=true"));
        assert!(out.stderr.contains("Stale sources: 3"));
        assert!(out.stderr.contains("Incomplete coverage"));
        assert!(!out.stdout.contains("hasMore"));
    }
}

#[cfg(test)]
mod usability_tests {
    use super::*;
    use std::cell::RefCell;
    fn params() -> Value {
        json!({"object":{"workspaceId":"w","scope":{"kind":"workspace"},"kind":"record","id":"23"}})
    }
    fn page(text: &str, cursor: Option<&str>) -> Value {
        json!({"sourceRef":{"object":params()["object"],"revision":"r1","title":"Saved","excerpt":""},
            "headRevision":7,"text":text,"nextCursor":cursor,"complete":cursor.is_none(),"rangeComplete":cursor.is_none()})
    }
    #[test]
    fn detail_bodies_and_file_failures_are_visible_without_flattening_or_truncation() {
        let content = format!("第一行\n{}\n最后一行", "x".repeat(500));
        for command in ["record.list", "file.list"] {
            let out = response(
                command,
                Ok(
                    json!({"items":[{"object":{"kind":"file","id":"1"},"title":"Title","content":content,
                "contentComplete":false,"contentError":{"code":"SOURCE_NOT_READY","message":"Unsupported document","retryable":false,
                    "details":{"reason":"unsupported_format","recovery":{"action":"office_inspect"}}}}],
                "totalCount":1,"countComplete":false,"unreadableCount":2}),
                ),
            );
            assert_eq!(out.exit_code, 0);
            assert!(out.stdout.contains(&content));
            assert!(out.stdout.contains("count incomplete"));
            assert!(out
                .stdout
                .contains("Unreadable or incompletely extracted files: 2"));
            assert!(out.stdout.contains("Unsupported document"));
            assert!(out.stdout.contains("office inspect"));
        }
    }
    #[test]
    fn todo_list_and_get_keep_action_context_and_full_content() {
        let out = response(
            "todo.list",
            Ok(
                json!({"items":[{"object":{"kind":"todo","id":"1"},"content":"Ship",
            "childId":9,"parentContent":"Release train","priority":"urgent_important","dueDate":"2026-11-13","contentTruncated":true}]}),
            ),
        );
        for value in [
            "/child:9",
            "Release train",
            "urgent_important",
            "2026-11-13",
            "todo get",
        ] {
            assert!(out.stdout.contains(value), "{value}: {}", out.stdout);
        }
        let body = "paragraph\n".repeat(100);
        let out = response(
            "todo.get",
            Ok(
                json!({"object":{"id":"1"},"revision":4,"snapshot":{"content":body,
            "priority":"urgent_important","status":"unfinished","dueDate":null,
            "children":[{"id":9,"content":"Review","dueDate":"2026-11-13","status":"unfinished"}]}}),
            ),
        );
        assert_eq!(out.exit_code, 0);
        for value in [body.as_str(), "revision: 4", "Subtask 9", "2026-11-13"] {
            assert!(out.stdout.contains(value), "{value}");
        }
    }
    #[test]
    fn error_hints_expose_only_safe_recovery_fields() {
        let error = AgentError::new(ErrorCode::BudgetExceeded, "Budget too small")
            .with_details(json!({"minimumBudgetChars":943,"token":"secret","body":"private body"}));
        let out = response("record.get", Err(error));
        assert_ne!(out.exit_code, 0);
        assert!(out.stderr.contains("--budget-chars 943"));
        assert!(!out.stderr.contains("private body"));
        assert!(!out.stderr.contains("secret"));
        let out = response(
            "record.get",
            Err(AgentError::new(ErrorCode::RevisionConflict, "Changed")
                .with_details(json!({"headRevision":8,"bodyHash":"sha256:abc"}))),
        );
        assert!(out.stderr.contains("headRevision: 8"));
        assert!(out.stderr.contains("Read the current target again"));
    }
    #[test]
    fn streamed_read_emits_complete_lines_before_the_next_request_and_reports_partial_failure() {
        let emitted = RefCell::new(String::new());
        let mut output = |text: &str| {
            emitted.borrow_mut().push_str(text);
            Ok(())
        };
        let mut calls = 0;
        let error = record_read_with_output(
            params(),
            false,
            None,
            None,
            |_| {
                calls += 1;
                if calls == 1 {
                    return Ok(page("first\npartial", Some("p2")));
                }
                assert!(emitted.borrow().contains("1 | first\n"));
                assert!(!emitted.borrow().contains("partial"));
                assert!(!emitted.borrow().contains("Read complete"));
                Err(AgentError::new(ErrorCode::ScopeDenied, "Revoked"))
            },
            Some(&mut output),
        )
        .unwrap_err();
        let out = response("record.get", Err(error));
        assert_ne!(out.exit_code, 0);
        assert!(out.stderr.contains("Output is partial"));
        assert!(out.stdout.is_empty());
    }
    #[test]
    fn markdown_stdout_is_exact_across_pages_with_metadata_on_stderr() {
        let expected = "# 标题\n\n| a | b |\n|---|---|\n| 甲 | 乙 |\n\n尾行";
        for streamed in [false, true] {
            let mut emitted = String::new();
            let mut output = |text: &str| {
                emitted.push_str(text);
                Ok(())
            };
            let mut calls = 0;
            let result = record_read_markdown_with_output(
                params(),
                false,
                None,
                None,
                |input| {
                    calls += 1;
                    assert_eq!(input["format"], "markdown");
                    if calls == 1 {
                        Ok(page("# 标题\n\n| a | b |\n|---", Some("p2")))
                    } else {
                        assert_eq!(input["revision"], "r1");
                        Ok(page("|---|\n| 甲 | 乙 |\n\n尾行", None))
                    }
                },
                if streamed { Some(&mut output) } else { None },
            )
            .unwrap();
            let out = response("record.get", Ok(result));
            assert_eq!(out.exit_code, 0);
            assert_eq!(
                if streamed {
                    emitted.as_str()
                } else {
                    out.stdout.as_str()
                },
                expected
            );
            if streamed {
                assert!(out.stdout.is_empty());
            }
            assert!(out.stderr.contains("Revision: r1"));
            assert!(out.stderr.contains("Head revision: 7"));
        }
    }
    #[test]
    fn server_window_is_not_sliced_again_and_range_completion_is_not_full_completion() {
        let mut input = params();
        input["offset"] = json!(80);
        input["limit"] = json!(1);
        let mut emitted = String::new();
        let mut output = |text: &str| {
            emitted.push_str(text);
            Ok(())
        };
        let result = record_read_with_output(
            input,
            false,
            Some(80),
            Some(1),
            |_| {
                let mut response = page("eighty\n", None);
                response["complete"] = json!(false);
                response["window"] =
                    json!({"offset":80,"limit":1,"totalLines":200,"startLine":80,"endLine":80});
                Ok(response)
            },
            Some(&mut output),
        )
        .unwrap();
        assert_eq!(result, "");
        assert!(emitted.contains("80 | eighty\n"));
        assert!(emitted.contains("Showing lines 80–80 of 200"));
        assert!(!emitted.contains("Read complete"));
    }
    #[test]
    fn file_reads_pin_revision_and_version_and_leave_json_single_page() {
        let mut input = json!({"source":{"object":params()["object"],"revision":null,"fileVersion":2},"view":"full"});
        input["source"]["object"]["kind"] = json!("file");
        let mut calls = 0;
        let result = source_read_with_output(
            input.clone(),
            false,
            None,
            None,
            |request| {
                calls += 1;
                let mut response = page(
                    if calls == 1 { "first\n" } else { "second" },
                    if calls == 1 { Some("p2") } else { None },
                );
                response["sourceRef"]["object"] = input["source"]["object"].clone();
                response["sourceRef"]["fileVersion"] = json!(2);
                if calls > 1 {
                    assert_eq!(request["source"]["revision"], "r1");
                }
                Ok(response)
            },
            None,
        )
        .unwrap();
        assert_eq!(calls, 2);
        assert!(result.as_str().unwrap().contains("2 | second"));
        let expected = page("raw page", Some("p2"));
        let result = source_read_with_output(
            input.clone(),
            true,
            None,
            None,
            |request| {
                assert_eq!(request, input);
                Ok(expected.clone())
            },
            None,
        )
        .unwrap();
        assert_eq!(result, expected);
    }
}

#[cfg(test)]
mod pipe_tests {
    use super::*;
    fn params() -> Value {
        json!({"object":{"workspaceId":"w","scope":{"kind":"workspace"},"kind":"record","id":"23"}})
    }
    fn page(text: &str, cursor: Option<&str>) -> Value {
        json!({"sourceRef":{"object":params()["object"],"revision":"r1","title":"Saved","excerpt":""},
            "text":text,"nextCursor":cursor,"complete":cursor.is_none(),"rangeComplete":cursor.is_none()})
    }
    #[test]
    fn plain_and_markdown_preserve_crlf_across_split_pages_while_text_numbers_lines() {
        for format in ["plain", "markdown", "text"] {
            let mut calls = 0;
            let mut output = String::new();
            let mut emit = |text: &str| {
                output.push_str(text);
                Ok(())
            };
            let call = |input: Value| {
                calls += 1;
                assert_eq!(
                    input["format"],
                    if format == "markdown" {
                        "markdown"
                    } else {
                        "text"
                    }
                );
                if calls == 1 {
                    Ok(page("甲\r", Some("p2")))
                } else if calls == 2 {
                    Ok(page("\n\r\n乙\r", Some("p3")))
                } else {
                    Ok(page("\n尾行", None))
                }
            };
            let mut input = params();
            input["format"] = json!("text");
            let result = match format {
                "plain" => {
                    record_read_plain_with_output(input, false, None, None, call, Some(&mut emit))
                }
                "markdown" => record_read_markdown_with_output(
                    input,
                    false,
                    None,
                    None,
                    call,
                    Some(&mut emit),
                ),
                _ => record_read_with_output(input, false, None, None, call, Some(&mut emit)),
            }
            .unwrap();
            if format == "text" {
                assert!(
                    output.contains("1 | 甲\n2 | \n3 | 乙\n4 | 尾行\n"),
                    "{output:?}"
                );
                assert!(!output.contains('\r'));
            } else {
                assert_eq!(output, "甲\r\n\r\n乙\r\n尾行");
                assert!(result["stderr"].as_str().unwrap().contains("Revision: r1"));
                assert_eq!(result["stdout"], "");
            }
        }
    }
    #[test]
    fn output_failure_stops_fetching_and_does_not_emit_completion() {
        let mut calls = 0;
        let mut accepted = String::new();
        let mut emit = |text: &str| {
            if text.starts_with("1 |") {
                return Err(AgentError::new(ErrorCode::IoFailed, "Output pipe closed")
                    .with_details(json!({"reason":"broken_pipe"})));
            }
            accepted.push_str(text);
            Ok(())
        };
        let error = record_read_with_output(
            params(),
            false,
            None,
            None,
            |_| {
                calls += 1;
                Ok(page("first\nsecond\n", Some("p2")))
            },
            Some(&mut emit),
        )
        .unwrap_err();
        assert_eq!(calls, 1);
        assert!(!accepted.contains("Read complete"));
        assert_eq!(error.details.as_ref().unwrap()["reason"], "broken_pipe");
        assert_eq!(error.details.unwrap()["partialOutput"], true);
    }
    #[test]
    fn plain_list_preserves_content_and_puts_incomplete_warnings_on_stderr() {
        let out = response_plain(
            "file.list",
            Ok(
                json!({"items":[{"object":{"id":"5"},"title":"文档","content":"first\r\nlast",
            "contentComplete":false,"contentState":"partial"}],"totalCount":1,"countComplete":false,"unreadableCount":1,"nextCursor":"more","hasMore":true}),
            ),
        );
        assert_eq!(out.exit_code, 0);
        assert!(out.stdout.contains("first\r\nlast"));
        assert!(!out.stdout.contains("shown"));
        assert!(!out.stdout.contains("incomplete"));
        assert!(out.stderr.contains("Count incomplete"));
        assert!(out.stderr.contains("Content incomplete"));
        assert!(out.stderr.contains("--cursor more"));
    }
    #[test]
    fn human_cursor_continuation_uses_the_server_start_line() {
        let mut input = params();
        input["cursor"] = json!("existing");
        let result = record_read_with_output(
            input,
            false,
            None,
            None,
            |request| {
                assert_eq!(request["cursor"], "existing");
                let mut response = page("line fifty\n", None);
                response["window"] =
                    json!({"offset":1,"limit":null,"totalLines":50,"startLine":50,"endLine":50});
                Ok(response)
            },
            None,
        )
        .unwrap();
        assert!(result.as_str().unwrap().contains("50 | line fifty\n"));
    }
}

#[cfg(test)]
mod native_paging_tests {
    use super::*;
    use crate::{
        agent::models::{ObjectKind, ObjectRef, Scope},
        source_file_read::FileExtractionStatus,
        source_service::{SourceReadInput, SourceReadTarget, SourceReadView},
        source_text_page::{decode_cursor, paginate},
    };

    #[test]
    fn file_and_other_sources_accept_real_paginate_dtos_and_preserve_full_text() {
        for kind in [
            ObjectKind::File,
            ObjectKind::Transcript,
            ObjectKind::SessionMessage,
        ] {
            for incomplete in [false, true] {
                // Only Files carry extraction status. Other source DTOs legitimately
                // omit headRevision/window/extraction, rather than filling nulls.
                if kind != ObjectKind::File && incomplete {
                    continue;
                }
                let object = ObjectRef {
                    workspace_id: "w".into(),
                    scope: Scope::Workspace,
                    kind,
                    id: "23".into(),
                };
                let source = SourceRef {
                    object: object.clone(),
                    revision: "revision-1".into(),
                    file_version: if kind == ObjectKind::File {
                        Some(2)
                    } else {
                        None
                    },
                    record_version: None,
                    block_id: None,
                    locator: None,
                    title: "Saved source".into(),
                    excerpt: String::new(),
                };
                let body = "第一行\r\n\r\n末行\r\n".repeat(50);
                let input = SourceReadInput {
                    source: SourceReadTarget {
                        object,
                        revision: None,
                        record_version: None,
                        file_version: None,
                    },
                    view: SourceReadView::Full,
                    selection: None,
                    cursor: None,
                    budget_chars: Some(800),
                };
                let params = serde_json::to_value(&input).unwrap();
                let mut calls = 0;
                let result = source_read_plain_with_output(
                    params,
                    false,
                    None,
                    None,
                    |request| {
                        calls += 1;
                        let input: SourceReadInput = serde_json::from_value(request).unwrap();
                        if calls > 1 {
                            assert_eq!(input.source.revision.as_deref(), Some("revision-1"));
                        }
                        let extraction = (kind == ObjectKind::File).then(|| FileExtractionStatus {
                            state: if incomplete { "partial" } else { "ready" }.into(),
                            coverage: json!({"complete":!incomplete}),
                            reason: incomplete.then(|| "page_limit".into()),
                        });
                        let page = paginate(
                            &input,
                            source.clone(),
                            &body,
                            &[],
                            decode_cursor(&input)?,
                            extraction,
                        )?;
                        serde_json::to_value(page).map_err(|_| malformed())
                    },
                    None,
                )
                .unwrap();
                assert!(calls > 1, "fixture must exercise real cursors");
                assert_eq!(result["stdout"], body);
                if incomplete {
                    assert!(result["stderr"]
                        .as_str()
                        .unwrap()
                        .contains("Extraction incomplete"));
                    assert!(!result["stderr"].as_str().unwrap().contains("Read complete"));
                }
            }
        }
    }
}
