//! Human output for common reads; bridge JSON remains an untouched single page.
use super::{cli_help, exit_code, CliOutput};
use crate::agent::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::SourceRef,
    record_get::RecordGetInput,
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
}

pub(super) fn record_read(
    mut params: Value,
    json_output: bool,
    offset: Option<usize>,
    limit: Option<usize>,
    mut call: impl FnMut(Value) -> AgentResult<Value>,
) -> AgentResult<Value> {
    if json_output {
        return call(params);
    }
    let input: RecordGetInput = serde_json::from_value(params.clone()).map_err(|_| malformed())?;
    if input.budget_chars.is_none() {
        params["budgetChars"] = json!(12000);
    }
    if input.cursor.is_some() {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "--cursor requires --json for record get; use --offset for a text line window",
        ));
    }
    let mut revision = input.revision;
    let mut body = String::new();
    let mut cursors = HashSet::new();
    let mut complete_lines = 0;
    let window_end = limit.map(|limit| offset.unwrap_or(1).saturating_sub(1).saturating_add(limit));
    for _ in 0..MAX_RECORD_PAGES {
        let page: RecordPage =
            serde_json::from_value(call(params.clone())?).map_err(|_| malformed())?;
        if page.source_ref.object != input.record
            || page.source_ref.revision.is_empty()
            || page.source_ref.file_version.is_some()
            || page.source_ref.record_version.is_some()
        {
            return Err(malformed());
        }
        if revision
            .as_deref()
            .is_some_and(|revision| revision != page.source_ref.revision)
        {
            return Err(AgentError::new(
                ErrorCode::SourceChanged,
                "Record revision changed during reading; restart record get",
            ));
        }
        revision = Some(page.source_ref.revision.clone());
        if page.text.len() > MAX_RECORD_BYTES - body.len() {
            return Err(AgentError::new(ErrorCode::BudgetExceeded,
                "Record text exceeds the 8 MiB total read cap; use --json with --cursor for bounded pages"));
        }
        complete_lines += page.text.bytes().filter(|byte| *byte == b'\n').count();
        body.push_str(&page.text);
        match page.next_cursor {
            None if page.complete => {
                return Ok(json!(record_text(
                    &page.source_ref,
                    &body,
                    offset.unwrap_or(1),
                    limit,
                    true
                )));
            }
            Some(cursor)
                if !page.complete
                    && !page.text.is_empty()
                    && !cursor.is_empty()
                    && cursor.len() <= 2048 =>
            {
                if !cursors.insert(cursor.clone()) {
                    return Err(malformed());
                }
                if window_end.is_some_and(|end| complete_lines >= end) {
                    return Ok(json!(record_text(
                        &page.source_ref,
                        &body,
                        offset.unwrap_or(1),
                        limit,
                        false
                    )));
                }
                params["revision"] = json!(revision);
                params["cursor"] = json!(cursor);
            }
            _ => return Err(malformed()),
        }
    }
    Err(AgentError::new(ErrorCode::BudgetExceeded,
        "Record exceeds the 4096-page total read cap; increase --budget-chars or use --json with --cursor"))
}

fn record_text(
    source: &SourceRef,
    body: &str,
    offset: usize,
    limit: Option<usize>,
    complete: bool,
) -> String {
    let total = if complete {
        body.lines().count()
    } else {
        body.bytes().filter(|byte| *byte == b'\n').count()
    };
    let count = if complete {
        total.to_string()
    } else {
        format!("at least {total}")
    };
    let mut out = format!(
        "Record {}: {}\nRevision: {}\nSource text · {} lines · 1-based line numbers\n",
        source.object.id,
        one_line(&source.title, 160),
        source.revision,
        count
    );
    let mut shown = 0;
    for (index, line) in body
        .lines()
        .enumerate()
        .skip(offset - 1)
        .take(limit.unwrap_or(usize::MAX))
    {
        writeln!(out, "{} | {}", index + 1, line).expect("string output");
        shown += 1;
    }
    if shown == 0 {
        out.push_str(if total == 0 {
            "(empty body)\n"
        } else {
            "(no lines in this window)\n"
        });
    } else if !complete {
        writeln!(
            out,
            "Showing lines {}–{}; total unknown (stopped at requested window).",
            offset,
            offset + shown - 1
        )
        .expect("string output");
    } else if offset > 1 || shown < total {
        writeln!(
            out,
            "Showing lines {}–{} of {}.",
            offset,
            offset + shown - 1,
            total
        )
        .expect("string output");
    }
    out
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

fn list_text(data: &Value, search: bool) -> AgentResult<String> {
    let items = data
        .as_array()
        .or_else(|| data.get("items").and_then(Value::as_array))
        .or_else(|| data.get("projects").and_then(Value::as_array))
        .ok_or_else(malformed)?;
    let total = data.get("totalCount").and_then(Value::as_u64);
    let mut out = match total {
        Some(total) => format!("{} shown / {} total\n", items.len(), total),
        None if search => format!("{} results shown\n", items.len()),
        None => format!("{} results\n", items.len()),
    };
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
                writeln!(
                    diagnostics,
                    "More results: set cursor in --input-file to {cursor}"
                )
                .expect("string output");
            }
            if data.get("hasMore").and_then(Value::as_bool) == Some(true) {
                diagnostics.push_str("More matches available (hasMore=true); narrow the query or increase --budget-chars (max 12000).\n");
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
    let rendered = result.and_then(|data| {
        if command == "record.get" {
            data.as_str().map(str::to_owned).ok_or_else(malformed)
        } else {
            list_text(&data, search)
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
        assert!(text.contains("Source text · 3 lines · 1-based line numbers"));
        assert!(text.ends_with("1 | 第一行\n2 | \n3 | 第三行\n"), "{text}");
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
        assert!(
            text.contains("2 | two\n3 | 三\nShowing lines 2–3 of 4.\n"),
            "{text}"
        );
        assert!(!text.contains("1 | one"));
        assert!(!text.contains("4 | four"));
        assert!(read(Some(usize::MAX), None)
            .as_str()
            .unwrap()
            .contains("no lines in this window"));
        let empty = record_read(params(), false, None, None, |_| Ok(page("", "r1", None))).unwrap();
        assert!(empty.as_str().unwrap().contains("empty body"));
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
        assert!(text.contains("Source text · at least 3 lines"));
        assert!(
            text.contains("2 | two\n3 | three\nShowing lines 2–3; total unknown"),
            "{text}"
        );
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
        assert!(text.contains("total unknown"));
    }
    #[test]
    fn final_page_completes_a_line_without_newline_and_reports_exact_total() {
        let out = record_read(input(), false, Some(2), Some(1), |_| {
            Ok(page("one\ntwo", None))
        })
        .unwrap();
        let text = out.as_str().unwrap();
        assert!(text.contains("2 lines · 1-based"));
        assert!(text.ends_with("2 | two\nShowing lines 2–2 of 2.\n"));
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
