//! CLI-to-bridge acceptance seams. Transport and native services are tested by
//! their owners; these tests exercise parsed arguments, method DTOs and sinks.
use super::*;
use std::{cell::Cell, rc::Rc};

fn args(words: &[&str]) -> Vec<String> {
    words
        .iter()
        .copied()
        .chain([
            "--workspace",
            "/tmp",
            "--connection",
            "0123456789abcdef0123456789abcdef",
        ])
        .map(str::to_owned)
        .collect()
}

struct ReadBridge {
    calls: usize,
    emitted: Rc<Cell<bool>>,
    markdown: bool,
}
impl CliBridge for ReadBridge {
    fn binding(&mut self, _: &Path, _: &str, _: &str) -> AgentResult<WorkspaceBinding> {
        Ok(WorkspaceBinding {
            workspace_id: "adapter-workspace".into(),
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
        assert_eq!(method, "record.get");
        assert_eq!(
            params["format"],
            if self.markdown { "markdown" } else { "text" }
        );
        assert_eq!(params["offset"], 47);
        assert_eq!(params["limit"], 2);
        if self.calls == 1 {
            assert!(
                self.emitted.get(),
                "the first page must be written before requesting another page"
            );
            assert_eq!(params["cursor"], "next");
            assert_eq!(params["revision"], "stable-revision");
        }
        let first = self.calls == 0;
        self.calls += 1;
        Ok(
            json!({"sourceRef":{"object":params["object"],"revision":"stable-revision","title":"Record","excerpt":""},
            "text":if first {"# first\r\n"} else {"second\r\n"},"spans":[],
            "nextCursor":if first {Some("next")} else {None},"complete":false,"rangeComplete":!first,
            "headRevision":7,"format":if self.markdown {"markdown"} else {"text"},
            "window":{"offset":47,"limit":2,"totalLines":100,"startLine":if first {47} else {48},"endLine":if first {47} else {48}}}),
        )
    }
}

#[test]
fn record_formats_stream_server_window_without_reslicing_or_stdout_metadata() {
    for format in ["text", "plain", "cat", "markdown"] {
        let emitted = Rc::new(Cell::new(false));
        let mut bridge = ReadBridge {
            calls: 0,
            emitted: emitted.clone(),
            markdown: format == "markdown",
        };
        let mut stdout = String::new();
        let mut sink = |chunk: &str| {
            if chunk.contains("first") {
                emitted.set(true);
            }
            stdout.push_str(chunk);
            Ok(())
        };
        let out = run_with_bridge_output(
            &args(&[
                "record",
                "get",
                "44",
                "--workspace-scope",
                "--offset=47",
                "--limit=2",
                "--format",
                format,
            ]),
            &mut bridge,
            Some(&mut sink),
        );
        assert_eq!(out.exit_code, 0, "{format}: {}", out.stderr);
        assert_eq!(bridge.calls, 2);
        assert!(
            out.stdout.is_empty(),
            "streamed output must not be duplicated"
        );
        if format == "text" {
            assert!(stdout.contains("47 | # first\n48 | second\n"), "{stdout}");
        } else {
            assert_eq!(stdout, "# first\r\nsecond\r\n");
            assert!(out.stderr.contains("Head revision: 7"), "{}", out.stderr);
            assert!(!stdout.contains("revision"));
        }
    }
}

#[test]
fn json_record_window_is_one_original_page_and_does_not_write_stream_sink() {
    let mut bridge = ReadBridge {
        calls: 0,
        emitted: Rc::new(Cell::new(false)),
        markdown: false,
    };
    let mut sink =
        |_: &str| -> AgentResult<()> { panic!("JSON must remain one buffered envelope") };
    let out = run_with_bridge_output(
        &args(&[
            "record",
            "get",
            "--id=44",
            "--workspace-scope",
            "--offset=47",
            "--limit=2",
            "--format=json",
        ]),
        &mut bridge,
        Some(&mut sink),
    );
    assert_eq!(out.exit_code, 0, "{}", out.stderr);
    assert_eq!(bridge.calls, 1);
    let response: Value = serde_json::from_str(&out.stdout).unwrap();
    assert_eq!(response["data"]["text"], "# first\r\n");
    assert_eq!(response["data"]["headRevision"], 7);
    assert_eq!(response["data"]["nextCursor"], "next");
}

struct SearchBridge {
    calls: usize,
    emitted: Rc<Cell<bool>>,
    fail_second: bool,
}
impl CliBridge for SearchBridge {
    fn binding(&mut self, _: &Path, _: &str, _: &str) -> AgentResult<WorkspaceBinding> {
        unreachable!("source search has a scope DTO")
    }
    fn call(
        &mut self,
        _: &Path,
        _: &str,
        method: &str,
        params: Value,
        _: &str,
    ) -> AgentResult<Value> {
        assert_eq!(method, "source.search");
        assert_eq!(params["kinds"], json!(["record", "file"]));
        assert_eq!(params["limit"], 1);
        assert_eq!(params["budgetChars"], 12000);
        let first = self.calls == 0;
        self.calls += 1;
        if !first {
            assert!(self.emitted.get());
            assert_eq!(params["cursor"], "next");
            if self.fail_second {
                return Err(AgentError::new(ErrorCode::SourceChanged, "source changed"));
            }
        }
        Ok(
            json!({"items":[],"hasMore":first,"nextCursor":if first {Some("next")} else {None},
            "coverageNote":"File coverage incomplete","staleCount":3}),
        )
    }
}

#[test]
fn all_search_adapter_streams_and_preserves_warnings_and_partial_failures() {
    for fail_second in [false, true] {
        let emitted = Rc::new(Cell::new(false));
        let mut bridge = SearchBridge {
            calls: 0,
            emitted: emitted.clone(),
            fail_second,
        };
        let mut stdout = String::new();
        let mut sink = |chunk: &str| {
            emitted.set(true);
            stdout.push_str(chunk);
            Ok(())
        };
        let out = run_with_bridge_output(
            &args(&[
                "search",
                "terms",
                "--workspace-scope",
                "--kind=record,file",
                "--limit=1",
                "--all",
            ]),
            &mut bridge,
            Some(&mut sink),
        );
        assert_eq!(bridge.calls, 2);
        assert!(out.stdout.is_empty());
        assert!(out.stderr.contains("File coverage incomplete"));
        assert!(out.stderr.contains("Stale sources: 3"));
        assert_eq!(
            out.exit_code,
            if fail_second { 5 } else { 0 },
            "{}",
            out.stderr
        );
        assert_eq!(
            stdout.matches("0 results shown").count(),
            if fail_second { 1 } else { 2 }
        );
        if fail_second {
            assert!(out.stderr.contains("partial"), "{}", out.stderr);
        }
    }
}

#[test]
fn default_record_human_preserves_table_rows_while_json_keeps_text_protocol() {
    struct TableBridge;
    impl CliBridge for TableBridge {
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
            assert_eq!(method, "record.get");
            let markdown = params["format"] == "markdown";
            Ok(
                json!({"sourceRef":{"object":params["object"],"revision":"stable","title":"火车时刻表","excerpt":""},
                "text":if markdown {"| 版本 | 中国站上线 | 国际站上线 |\n| --- | --- | --- |\n| MKP 11.11.0 | 11月13日 | 11月20日 |\n"} else {"legacy text projection"},
                "format":params["format"],"headRevision":7,"nextCursor":null,"complete":true,"rangeComplete":true,
                "window":{"offset":1,"limit":null,"startLine":1,"endLine":if markdown{3}else{1},"totalLines":if markdown{3}else{1}}}),
            )
        }
    }
    let out = run_with_bridge(
        &args(&["record", "get", "44", "--workspace-scope"]),
        &mut TableBridge,
    );
    assert_eq!(out.exit_code, 0, "{}", out.stderr);
    assert!(
        out.stdout
            .contains("1 | | 版本 | 中国站上线 | 国际站上线 |"),
        "{}",
        out.stdout
    );
    assert!(out
        .stdout
        .contains("3 | | MKP 11.11.0 | 11月13日 | 11月20日 |"));
    let out = run_with_bridge(
        &args(&["record", "get", "44", "--workspace-scope", "--json"]),
        &mut TableBridge,
    );
    let json: Value = serde_json::from_str(&out.stdout).unwrap();
    assert_eq!(json["data"]["format"], "text");
    assert_eq!(json["data"]["text"], "legacy text projection");
}
