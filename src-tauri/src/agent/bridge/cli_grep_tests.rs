use super::*;
use crate::agent::{
    errors::{AgentError, ErrorCode},
    models::WorkspaceBinding,
};
use serde_json::{json, Value};
use std::{collections::VecDeque, path::Path};

struct Bridge {
    calls: Vec<(String, Value)>,
    pages: VecDeque<AgentResult<Value>>,
}
impl CliBridge for Bridge {
    fn binding(&mut self, _: &Path, _: &str, _: &str) -> AgentResult<WorkspaceBinding> {
        Ok(WorkspaceBinding {
            workspace_id: "workspace".into(),
            generation: "generation".into(),
        })
    }
    fn call(
        &mut self,
        _: &Path,
        _: &str,
        method: &str,
        params: Value,
        _: &str,
    ) -> AgentResult<Value> {
        self.calls.push((method.into(), params));
        self.pages.pop_front().expect("unexpected bridge read")
    }
}
fn object(kind: &str, id: &str) -> Value {
    json!({"workspaceId":"workspace","scope":{"kind":"project","projectId":7},"kind":kind,"id":id})
}
fn page(kind: &str, id: &str, text: &str, next: Option<&str>) -> Value {
    json!({"sourceRef":{"object":object(kind,id),"revision":"sha256:one","fileVersion":if kind=="file" {Some(1)} else {None},"recordVersion":null,"title":"do not print me","excerpt":""},
        "text":text,"nextCursor":next,"complete":next.is_none(),"rangeComplete":next.is_none(),"headRevision":3})
}
fn bridge(pages: Vec<Value>) -> Bridge {
    Bridge {
        calls: vec![],
        pages: pages.into_iter().map(Ok).collect(),
    }
}
fn args(flags: &[&str]) -> Vec<String> {
    [
        vec![
            "--workspace",
            "/tmp/grep-test",
            "--connection",
            "0123456789abcdef0123456789abcdef",
            "--project",
            "7",
        ],
        flags.to_vec(),
    ]
    .concat()
    .into_iter()
    .map(str::to_owned)
    .collect()
}
fn invoke(flags: &[&str], text: &str) -> CliOutput {
    run(
        &args(flags),
        &mut bridge(vec![page("record", "44", text, None)]),
        None,
    )
}

#[test]
fn literal_regex_and_default_case_have_grep_meaning() {
    let text = "a.b\naXb\nA.B\n";
    assert_eq!(
        invoke(&["-Fn", "a.b", "record:44"], text).stdout,
        "record:44:1:a.b\n"
    );
    assert_eq!(
        invoke(&["-Fin", "a.b", "record:44"], text).stdout,
        "record:44:1:a.b\nrecord:44:3:A.B\n"
    );
    assert_eq!(
        invoke(&["-n", "a.b", "record:44"], text).stdout,
        "record:44:1:a.b\nrecord:44:2:aXb\n"
    );
}

#[test]
fn bre_and_ere_groups_quantifiers_and_literal_punctuation_differ() {
    let text = "aa\na+\na(b)\nab\ncat\ndog\n";
    assert_eq!(
        invoke(&["-x", "a+", "record:44"], text).stdout,
        "record:44:a+\n"
    );
    assert_eq!(
        invoke(&["-Ex", "a+", "record:44"], text).stdout,
        "record:44:aa\n"
    );
    assert_eq!(
        invoke(&["-x", r"a\{2\}", "record:44"], text).stdout,
        "record:44:aa\n"
    );
    assert_eq!(
        invoke(&["-x", r"a\(b\)", "record:44"], text).stdout,
        "record:44:ab\n"
    );
    assert_eq!(
        invoke(&["-E", "cat|dog", "record:44"], text).stdout,
        "record:44:cat\nrecord:44:dog\n"
    );
}

#[test]
fn windows_paths_symbols_leading_dash_and_quotes_are_literal_argv() {
    let path = r"\\?\D:\Onebox\商店 BA\O'Brien\[a] $x & (1)!.txt";
    assert_eq!(
        invoke(&["-Fn", path, "record:44"], &format!("{path}\n")).stdout,
        format!("record:44:1:{path}\n")
    );
    assert_eq!(
        invoke(&["-F", "--", "--help", "record:44"], "--help\n").stdout,
        "record:44:--help\n"
    );
    assert_eq!(
        invoke(&["-Fe--help", "record:44"], "--help\n").stdout,
        "record:44:--help\n"
    );
    assert_eq!(
        invoke(
            &["--fixed-strings", "--regexp=$x & ?*", "record:44"],
            "$x & ?*\n"
        )
        .exit_code,
        0
    );
}

#[test]
fn repeated_patterns_and_pattern_newlines_are_or() {
    let text = "cat\ndog\nbird\n";
    assert_eq!(
        invoke(&["-n", "-e", "cat", "-edog", "record:44"], text).stdout,
        "record:44:1:cat\nrecord:44:2:dog\n"
    );
    assert_eq!(
        invoke(&["-e", "cat\ndog", "record:44"], text).stdout,
        "record:44:cat\nrecord:44:dog\n"
    );
    assert_eq!(
        invoke(&["-e", "", "record:44"], text).stdout,
        "record:44:cat\nrecord:44:dog\nrecord:44:bird\n"
    );
}

#[test]
fn match_counts_invert_limits_and_output_precedence() {
    let text = "yes\nyes\nno\nyes\n";
    assert_eq!(
        invoke(&["-vc", "yes", "record:44"], text).stdout,
        "record:44:1\n"
    );
    assert_eq!(
        invoke(&["-cm2", "yes", "record:44"], text).stdout,
        "record:44:2\n"
    );
    assert_eq!(
        invoke(&["-cln", "yes", "record:44"], text).stdout,
        "record:44\n"
    );
    let quiet = invoke(&["-qlc", "yes", "record:44"], text);
    assert_eq!((quiet.exit_code, quiet.stdout), (0, String::new()));
    assert_eq!(
        invoke(&["-h", "yes", "record:44"], text).stdout,
        "yes\nyes\nyes\n"
    );
}

#[test]
fn no_match_and_read_error_have_grep_exit_status() {
    assert_eq!(invoke(&["missing", "record:44"], "abc\n").exit_code, 1);
    let mut b = bridge(vec![]);
    b.pages.push_back(Err(AgentError::new(
        ErrorCode::SourceNotReady,
        "unsupported Office extraction",
    )));
    let out = run(&args(&["x", "file:5"]), &mut b, None);
    assert_eq!(out.exit_code, 2);
    assert!(out.stderr.contains("unsupported Office extraction"));
    assert!(out.stdout.is_empty());
}

#[test]
fn contexts_merge_and_use_grep_separators() {
    let text = "zero\na\none\nb\ntwo\nthree\nc\nfour\n";
    assert_eq!(invoke(&["-nC1","-e","a","-eb","-ec","record:44"],text).stdout,
        "record:44-1-zero\nrecord:44:2:a\nrecord:44-3-one\nrecord:44:4:b\nrecord:44-5-two\nrecord:44-6-three\nrecord:44:7:c\nrecord:44-8-four\n");
    assert_eq!(
        invoke(&["-nB1", "-e", "a", "-ec", "record:44"], text).stdout,
        "record:44-1-zero\nrecord:44:2:a\n--\nrecord:44-6-three\nrecord:44:7:c\n"
    );
}

#[test]
fn split_lines_bom_crlf_and_no_final_newline_are_processed_once() {
    let mut b = bridge(vec![
        page("record", "44", "\u{feff}fir", Some("c1")),
        page("record", "44", "st\r\nsecond\r", Some("c2")),
        page("record", "44", "\nthird", None),
    ]);
    let out = run(
        &args(&["-Fn", "-e", "first", "-esecond", "-ethird", "record:44"]),
        &mut b,
        None,
    );
    assert_eq!(
        out.stdout,
        "record:44:1:first\nrecord:44:2:second\nrecord:44:3:third\n"
    );
    assert_eq!(b.calls.len(), 3);
    assert_eq!(b.calls[0].0, "record.get");
    assert_eq!(b.calls[0].1["format"], "markdown");
    assert_eq!(b.calls[1].1["revision"], "sha256:one");
    assert_eq!(b.calls[2].1["cursor"], "c2");
}

#[test]
fn quiet_and_list_stop_before_next_page() {
    for flag in ["-q", "-l", "-m1"] {
        let mut b = bridge(vec![page("record", "44", "hit\n", Some("unneeded"))]);
        assert_eq!(
            run(&args(&[flag, "hit", "record:44"]), &mut b, None).exit_code,
            0
        );
        assert_eq!(b.calls.len(), 1);
    }
    let mut b = bridge(vec![]);
    assert_eq!(
        run(&args(&["-m0", "hit", "record:44"]), &mut b, None).exit_code,
        1
    );
    assert!(b.calls.is_empty());
}

#[test]
fn output_failure_stops_further_pages_immediately() {
    let mut b = bridge(vec![page("record", "44", "hit\n", Some("unneeded"))]);
    let mut sink = |_: &str| Err(AgentError::new(ErrorCode::IoFailed, "broken pipe"));
    let out = run(&args(&["hit", "record:44"]), &mut b, Some(&mut sink));
    assert_eq!(out.exit_code, 2);
    assert!(out.stderr.contains("broken pipe"));
    assert_eq!(b.calls.len(), 1);
}

#[test]
fn native_inventory_is_scoped_and_each_object_is_read_without_index() {
    let mut b = bridge(vec![
        json!({"items":[{"object":object("record","44")}],"hasMore":false,"nextCursor":null}),
        page("record", "44", "hit\n", None),
        json!({"items":[{"object":object("file","5")}],"hasMore":false,"nextCursor":null}),
        page("file", "5", "hit\n", None),
    ]);
    let out = run(&args(&["hit"]), &mut b, None);
    assert_eq!(out.stdout, "record:44:hit\nfile:5:hit\n");
    assert_eq!(out.exit_code, 0);
    assert_eq!(
        b.calls.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(),
        vec!["record.list", "record.get", "file.list", "source.read"]
    );
    assert_eq!(
        b.calls[0].1["scope"],
        json!({"kind":"project","projectId":7})
    );
    assert_eq!(b.calls[3].1["view"], "full");
    assert_eq!(b.calls[3].1["source"]["object"], object("file", "5"));
}

#[test]
fn revision_changes_and_incomplete_extraction_are_errors() {
    let mut changed = page("record", "44", "second\n", None);
    changed["sourceRef"]["revision"] = json!("sha256:changed");
    let mut b = bridge(vec![page("record", "44", "first\n", Some("c1")), changed]);
    let out = run(&args(&[".", "record:44"]), &mut b, None);
    assert_eq!(out.exit_code, 2);
    assert_eq!(out.stdout, "record:44:first\n");
    let mut partial = page("file", "5", "", None);
    partial["extraction"] =
        json!({"state":"partial","coverage":{"complete":false},"reason":"page limit"});
    let out = run(&args(&["x", "file:5"]), &mut bridge(vec![partial]), None);
    assert_eq!(out.exit_code, 2);
    assert!(out.stderr.contains("page limit"));
}

#[test]
fn unsupported_regex_features_error_instead_of_changing_meaning() {
    for flags in [
        vec![r"\(a\)\1", "record:44"],
        vec!["-E", r"(a)\1", "record:44"],
        vec!["-E", "(?=x)", "record:44"],
        vec![r"\`x", "record:44"],
        vec!["[", "record:44"],
    ] {
        let out = run(&args(&flags), &mut bridge(vec![]), None);
        assert_eq!(out.exit_code, 2, "{flags:?}");
        assert!(!out.stderr.is_empty());
    }
    // grep's \d is literal d; Rust regex's digit shorthand must not leak in.
    assert_eq!(
        invoke(&["-E", r"\d", "record:44"], "1\nd\n").stdout,
        "record:44:d\n"
    );
}

#[test]
fn windows_pattern_files_preserve_literal_backslashes_quotes_and_unicode() {
    let directory = tempfile::tempdir().unwrap();
    let first = directory.path().join("商店 [a] O'Brien $.txt");
    let second = directory.path().join("more patterns.txt");
    let pattern = r#"\\?\D:\商店\O'Brien\a "$x" & ?*.txt"#;
    std::fs::write(&first, format!("\u{feff}{pattern}\r\n")).unwrap();
    std::fs::write(&second, "second\r\n").unwrap();
    let out = invoke(
        &[
            "-Fnf",
            first.to_str().unwrap(),
            "--file",
            second.to_str().unwrap(),
            "-e",
            "third",
            "record:44",
        ],
        &format!("{pattern}\nsecond\nthird\nno\n"),
    );
    assert_eq!(
        out.stdout,
        format!("record:44:1:{pattern}\nrecord:44:2:second\nrecord:44:3:third\n")
    );
    assert_eq!(out.exit_code, 0);
}

#[test]
fn empty_pattern_file_has_no_patterns_and_blank_line_matches_all() {
    let directory = tempfile::tempdir().unwrap();
    let patterns = directory.path().join("patterns.txt");
    std::fs::write(&patterns, []).unwrap();
    let mut b = bridge(vec![]);
    let out = run(
        &args(&["-Ff", patterns.to_str().unwrap(), "record:44"]),
        &mut b,
        None,
    );
    assert_eq!(out.exit_code, 1);
    assert!(out.stdout.is_empty());
    assert!(b.calls.is_empty());
    assert_eq!(
        invoke(
            &["-Fvf", patterns.to_str().unwrap(), "record:44"],
            "one\ntwo\n"
        )
        .stdout,
        "record:44:one\nrecord:44:two\n"
    );
    std::fs::write(&patterns, b"\r\n").unwrap();
    assert_eq!(
        invoke(
            &[
                "--fixed-strings",
                &format!("--file={}", patterns.display()),
                "record:44"
            ],
            "one\ntwo\n"
        )
        .stdout,
        "record:44:one\nrecord:44:two\n"
    );
    std::fs::write(&patterns, [0xff, 0xfe, b'a', 0]).unwrap();
    let out = run(
        &args(&["-f", patterns.to_str().unwrap(), "record:44"]),
        &mut bridge(vec![]),
        None,
    );
    assert_eq!(out.exit_code, 2);
    assert!(out.stderr.contains("UTF-16"));
}

#[test]
fn limits_and_counts_do_not_read_text_for_zero_max_count() {
    let mut b = bridge(vec![]);
    let out = run(&args(&["-cm0", "x", "record:44"]), &mut b, None);
    assert_eq!(out.stdout, "record:44:0\n");
    assert_eq!(out.exit_code, 1);
    assert!(b.calls.is_empty());
}

#[test]
fn grep_errors_after_matches_are_not_success_except_quiet_mode() {
    for quiet in [false, true] {
        let mut b = bridge(vec![]);
        b.pages.push_back(Err(AgentError::new(
            ErrorCode::SourceNotReady,
            "cannot extract",
        )));
        b.pages.push_back(Ok(page("record", "44", "hit\n", None)));
        let flags = if quiet {
            vec!["-q", "hit", "file:5", "record:44"]
        } else {
            vec!["hit", "file:5", "record:44"]
        };
        let out = run(&args(&flags), &mut b, None);
        assert_eq!(out.exit_code, if quiet { 0 } else { 2 });
        assert!(out.stderr.contains("cannot extract"));
    }
}

#[test]
fn incomplete_line_is_bounded_without_truncation() {
    let long = "a".repeat(MAX_LINE_BYTES);
    let mut b = bridge(vec![
        page("record", "44", &long, Some("c1")),
        page("record", "44", "b", None),
    ]);
    let out = run(&args(&["a", "record:44"]), &mut b, None);
    assert_eq!(out.exit_code, 2);
    assert!(out.stderr.contains("no line was truncated"));
    assert!(out.stdout.is_empty());
}

#[test]
fn inventory_continuations_keep_actual_object_scope_and_revision() {
    let mut b = bridge(vec![
        json!({"items":[{"object":object("record","44")}],"hasMore":true,"nextCursor":"list-c1"}),
        json!({"items":[{"object":object("record","45")}],"hasMore":false,"nextCursor":null}),
        page("record", "44", "hit\n", None),
        page("record", "45", "hit\n", None),
    ]);
    let out = run(&args(&["--kind=record", "hit"]), &mut b, None);
    assert_eq!(out.exit_code, 0);
    assert_eq!(out.stdout, "record:44:hit\nrecord:45:hit\n");
    assert_eq!(b.calls[1].1["cursor"], "list-c1");
    assert_eq!(b.calls[3].1["object"], object("record", "45"));
}

#[test]
fn grep_bracket_classes_and_anchors_match_grep_rules() {
    let text = "ab\na^b\na$b\na(b)\n12\nx\n\\\n";
    assert_eq!(
        invoke(&["a^b", "record:44"], text).stdout,
        "record:44:a^b\n"
    );
    assert_eq!(
        invoke(&["a$b", "record:44"], text).stdout,
        "record:44:a$b\n"
    );
    assert_eq!(
        invoke(&["-E", "^[[:digit:]]+$", "record:44"], text).stdout,
        "record:44:12\n"
    );
    assert_eq!(
        invoke(&["-E", r"[\d]", "record:44"], text).stdout,
        "record:44:\\\n"
    );
    assert_eq!(
        invoke(&["^*a", "record:44"], "*a\na\n").stdout,
        "record:44:*a\n"
    );
}

#[test]
fn file_continuation_uses_native_cursor_selection_without_changing_version_fields() {
    struct NativeFile {
        calls: usize,
        text: String,
    }
    impl CliBridge for NativeFile {
        fn binding(&mut self, _: &Path, _: &str, _: &str) -> AgentResult<WorkspaceBinding> {
            Ok(WorkspaceBinding {
                workspace_id: "workspace".into(),
                generation: "generation".into(),
            })
        }
        fn call(
            &mut self,
            _: &Path,
            _: &str,
            method: &str,
            params: Value,
            _: &str,
        ) -> AgentResult<Value> {
            assert_eq!(method, "source.read");
            self.calls += 1;
            let input: crate::source_service::SourceReadInput =
                serde_json::from_value(params).unwrap();
            let cursor = crate::source_text_page::decode_cursor(&input)?;
            let source: SourceRef =
                serde_json::from_value(page("file", "5", "", None)["sourceRef"].clone()).unwrap();
            let page =
                crate::source_text_page::paginate(&input, source, &self.text, &[], cursor, None)?;
            Ok(serde_json::to_value(page).unwrap())
        }
    }
    let mut b = NativeFile {
        calls: 0,
        text: format!("{}\nlast hit\n", "noise ".repeat(4000)),
    };
    let out = run(&args(&["-Fn", "hit", "file:5"]), &mut b, None);
    assert_eq!(out.exit_code, 0, "{}", out.stderr);
    assert_eq!(out.stdout, "file:5:2:last hit\n");
    assert!(b.calls > 1);
}

#[test]
fn incomplete_extraction_terminal_range_is_visible_but_returns_error() {
    for range_complete in [false, true] {
        let mut partial = page("file", "5", "available hit\n", None);
        partial["complete"] = json!(false);
        partial["rangeComplete"] = json!(range_complete);
        partial["extraction"] =
            json!({"state":"partial","coverage":{"complete":false},"reason":"page limit"});
        let out = run(
            &args(&["hit", "file:5"]),
            &mut bridge(vec![partial.clone()]),
            None,
        );
        assert_eq!(out.stdout, "file:5:available hit\n");
        assert_eq!(out.exit_code, 2);
        assert!(out.stderr.contains("page limit"));
        assert!(!out.stderr.contains("Invalid grep read response"));
        let quiet = run(
            &args(&["-q", "hit", "file:5"]),
            &mut bridge(vec![partial]),
            None,
        );
        assert_eq!(quiet.exit_code, 0);
    }
}

#[test]
fn native_record_inventory_survives_its_own_legacy_reads_beyond_one_page() {
    use crate::{
        agent::{
            access::{Caller, RequestContext, ScopeGrant},
            record_get::{self, RecordGetInput},
            record_list::RecordListInput,
        },
        db::Database,
        models::WorkspaceRecordUpsertInput,
        record_documents::{body_hash, RecordDocumentProjection},
        source_service::BoundSourceStore,
    };
    use std::sync::Mutex;
    struct Store {
        db: Mutex<Database>,
        binding: WorkspaceBinding,
    }
    impl crate::committed_changes::CommittedChangePublisher for Store {
        fn publish_committed(&self, _: crate::committed_changes::CommittedChanges) {}
    }
    impl BoundSourceStore for Store {
        fn with_current<T>(
            &self,
            action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
        ) -> AgentResult<T> {
            action(&self.binding, &self.db.lock().unwrap())
        }
    }
    struct Utility;
    impl crate::record_document_service::DocumentUtility for Utility {
        async fn request(&self, _: &str, method: &str, _: Value) -> AgentResult<Value> {
            assert_eq!(method, "record.initialize");
            let document = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"0123456789abcdef0123456789abcdef"},"content":[{"type":"text","text":"hit"}]}]});
            Ok(serde_json::to_value(RecordDocumentProjection {
                body_hash: body_hash(&document, &None),
                document,
                schema_version: 1,
                html: "<p>hit</p>".into(),
                markdown: "hit".into(),
                text: "hit".into(),
                code_language: None,
            })
            .unwrap())
        }
    }
    struct NativeRecords {
        store: Store,
        request: RequestContext,
        pages: usize,
        reads: usize,
    }
    impl CliBridge for NativeRecords {
        fn binding(&mut self, _: &Path, _: &str, _: &str) -> AgentResult<WorkspaceBinding> {
            Ok(self.store.binding.clone())
        }
        fn call(
            &mut self,
            _: &Path,
            _: &str,
            method: &str,
            params: Value,
            _: &str,
        ) -> AgentResult<Value> {
            match method {
                "record.list" => {
                    self.pages += 1;
                    let input: RecordListInput = serde_json::from_value(params).unwrap();
                    let page = self.store.with_current(|binding, db| {
                        db.agent_record_list(&self.request, binding, &input)
                    })?;
                    Ok(serde_json::to_value(page).unwrap())
                }
                "record.get" => {
                    self.reads += 1;
                    let input: RecordGetInput = serde_json::from_value(params).unwrap();
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .unwrap();
                    let page = runtime.block_on(record_get::get(
                        &self.store,
                        &self.request,
                        &input,
                        &Utility,
                    ))?;
                    Ok(serde_json::to_value(page).unwrap())
                }
                _ => panic!("unexpected {method}"),
            }
        }
    }
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(&root.path().join("grep.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace("workspace").unwrap();
    for index in 0..60 {
        db.workspace_record_upsert(WorkspaceRecordUpsertInput {
            note_id: None,
            title: Some(format!("legacy {index}")),
            html: "<p>hit</p>".into(),
            markdown: "hit".into(),
            default_code_language: None,
            tag_ids: vec![],
        })
        .unwrap();
    }
    let binding = WorkspaceBinding {
        workspace_id: "workspace".into(),
        generation: root.path().display().to_string(),
    };
    let request = RequestContext {
        binding: binding.clone(),
        caller: Caller::Gui,
        request_id: "grep-native".into(),
        scope_grant: ScopeGrant {
            workspace_id: "workspace".into(),
            workspace_content: true,
            project_ids: vec![],
            operations: vec!["source.read".into()],
            object_keys: None,
        },
    };
    let mut b = NativeRecords {
        store: Store {
            db: Mutex::new(db),
            binding,
        },
        request,
        pages: 0,
        reads: 0,
    };
    let mut flags = args(&[]);
    flags.truncate(4);
    flags.extend(
        ["--workspace-scope", "--kind", "record", "hit"]
            .into_iter()
            .map(str::to_owned),
    );
    let out = run(&flags, &mut b, None);
    assert_eq!(out.exit_code, 0, "{}", out.stderr);
    assert_eq!(out.stdout.lines().count(), 60);
    assert_eq!(b.reads, 60);
    assert!(b.pages > 1);
}
