use super::*;

const CONNECTION: &str = "0123456789abcdef0123456789abcdef";
fn args(words: &[&str]) -> Vec<String> {
    let mut args = vec!["contact".into()];
    args.extend(words.iter().map(|value| (*value).to_owned()));
    if !words.contains(&"--") {
        args.extend([
            "--workspace".into(),
            "/tmp".into(),
            "--connection".into(),
            CONNECTION.into(),
        ]);
    } else {
        args.splice(
            2..2,
            [
                "--workspace".into(),
                "/tmp".into(),
                "--connection".into(),
                CONNECTION.into(),
            ],
        );
    }
    args
}

struct Bridge<F>(F);
impl<F: FnMut(&str, Value, &str) -> AgentResult<Value>> CliBridge for Bridge<F> {
    fn binding(&mut self, _: &Path, _: &str, _: &str) -> AgentResult<WorkspaceBinding> {
        panic!("Contact IDs need no content binding lookup")
    }
    fn call(
        &mut self,
        _: &Path,
        connection: &str,
        method: &str,
        params: Value,
        rid: &str,
    ) -> AgentResult<Value> {
        assert_eq!(connection, CONNECTION);
        (self.0)(method, params, rid)
    }
}
fn record() -> Value {
    json!({"id":8,"name":"张三","nicknames":"老张;三哥","email":"a@example.com","employeeId":"E8","notes":"line one\n第二行","role":"开发","department":"产品","pinyinFull":"zhangsan","pinyinAbbr":"zs","revision":7,"createdAt":"now","updatedAt":"now"})
}
fn mutation(rid: &str) -> Value {
    json!({"contact":record(),"operation":{"requestId":rid,"operationId":"op8","method":"contact.create","undoAvailable":false}})
}

#[test]
fn add_generates_one_request_identity_and_preserves_all_literals() {
    let literal = "中文 ' \" ` $() & | ; [] {} * ? ! % # <> = \\?\\D:\\有 空格";
    let mut calls = 0;
    let mut bridge = Bridge(|method: &str, params: Value, rid: &str| {
        calls += 1;
        assert_eq!(method, "contact.create");
        assert_eq!(params["requestId"], rid);
        assert!(rid.starts_with("cli-"));
        assert_eq!(
            params["fields"],
            json!({"name":"张三","nicknames":"老张;三哥","notes":literal,"email":"a@example.com","employeeId":"E8","role":"开发","department":"产品","pinyinFull":"zhangsan","pinyinAbbr":"zs"})
        );
        Ok(mutation(rid))
    });
    let out = run_with_bridge(
        &args(&[
            "add",
            "--name=张三",
            "--nicknames",
            "老张;三哥",
            "--notes",
            literal,
            "--email=a@example.com",
            "--employee-id=E8",
            "--role=开发",
            "--department=产品",
            "--pinyin-full=zhangsan",
            "--pinyin-abbr=zs",
        ]),
        &mut bridge,
    );
    assert_eq!(out.exit_code, 0, "{}", out.stderr);
    assert_eq!(calls, 1);
    assert!(out.stdout.contains("张三") && out.stdout.contains("Notes: line one\n第二行"));
    assert!(out.stderr.contains("Operation: op8") && out.stderr.contains("Request ID: cli-"));
}

#[test]
fn update_reads_current_revision_once_and_only_changes_supplied_fields() {
    let mut calls = Vec::new();
    let mut bridge = Bridge(|method: &str, params: Value, rid: &str| {
        calls.push(method.to_owned());
        assert_eq!(rid, "same-request");
        match method {
            "contact.get" => {
                assert_eq!(params, json!({"id":8}));
                Ok(record())
            }
            "contact.update" => {
                assert_eq!(
                    params,
                    json!({"id":8,"baseRevision":7,"requestId":"same-request","fields":{"email":"","notes":"--literal"}})
                );
                Ok(mutation(rid))
            }
            _ => panic!("unexpected method"),
        }
    });
    let out = run_with_bridge(
        &args(&[
            "update",
            "--id=8",
            "--email=",
            "--notes=--literal",
            "--request-id=same-request",
            "--json",
        ]),
        &mut bridge,
    );
    assert_eq!(out.exit_code, 0, "{}", out.stderr);
    assert_eq!(calls, ["contact.get", "contact.update"]);
    let json: Value = serde_json::from_str(&out.stdout).unwrap();
    assert_eq!(json["data"]["operation"]["requestId"], "same-request");
}

#[test]
fn explicit_revision_skips_get_and_failed_mutation_retains_retry_identity() {
    let mut calls = 0;
    let mut bridge = Bridge(|method: &str, params: Value, _: &str| {
        calls += 1;
        assert_eq!(method, "contact.update");
        assert_eq!(params["baseRevision"], 4);
        Err(AgentError::new(ErrorCode::RuntimeUnavailable, "Timed out"))
    });
    let out = run_with_bridge(
        &args(&[
            "update",
            "8",
            "--notes=",
            "--base-revision=4",
            "--request-id=retry-this",
        ]),
        &mut bridge,
    );
    assert_eq!(calls, 1);
    assert_eq!(out.exit_code, 3);
    assert!(out.stdout.is_empty());
    assert!(
        out.stderr.contains("Request ID: retry-this") && out.stderr.contains("Base revision: 4")
    );
}

#[test]
fn queries_support_equals_terminator_and_zero_based_pagination() {
    for words in [
        vec!["search", "--query=--张三 [] $x"],
        vec!["search", "--", "--张三 [] $x"],
        vec!["list", "--query=--张三 [] $x", "--offset=0", "--limit=200"],
    ] {
        let mut bridge = Bridge(|method: &str, params: Value, _: &str| {
            assert!(matches!(method, "contact.search" | "contact.list"));
            assert_eq!(params["query"], "--张三 [] $x");
            if method == "contact.list" {
                assert_eq!(params["offset"], 0);
                assert_eq!(params["limit"], 200);
            }
            Ok(json!({"items":[record()],"totalCount":300,"hasMore":true,"nextOffset":200}))
        });
        let out = run_with_bridge(&args(&words), &mut bridge);
        assert_eq!(out.exit_code, 0, "{}", out.stderr);
        assert_eq!(
            out.stdout,
            "8\t\"张三\"\ta@example.com\tE8\t\"老张;三哥\"\t产品\n"
        );
        assert!(out.stderr.contains("--offset 200"));
    }
}

#[test]
fn human_list_quotes_nicknames_and_keeps_an_empty_department_column() {
    let mut item = record();
    item["nicknames"] = json!("老张; \"三哥\"\t旧名\n新名");
    item["department"] = json!("");
    for verb in ["list", "search"] {
        let out = human(verb, json!({"items":[item],"totalCount":1,"hasMore":false})).unwrap();
        assert_eq!(
            out.stdout,
            "8\t\"张三\"\ta@example.com\tE8\t\"老张; \\\"三哥\\\"\\t旧名\\n新名\"\t\n"
        );
        assert_eq!(out.stdout.lines().count(), 1);
        assert_eq!(out.stdout.trim_end_matches('\n').split('\t').count(), 6);
    }
}

#[test]
fn human_list_escapes_separators_in_plain_columns_and_preserves_other_literals() {
    let mut item = record();
    item["email"] = json!("a\tb\r\nc@example.com");
    item["employeeId"] = json!("E\n8\r9\t10");
    item["department"] = json!("产品\t部门\r\n\\n ' \" ` $() & | ; [] {} * ? ! % # <> =");
    for verb in ["list", "search"] {
        let out = human(verb, json!({"items":[item],"totalCount":1,"hasMore":false})).unwrap();
        assert_eq!(out.stdout,"8\t\"张三\"\ta\\tb\\r\\nc@example.com\tE\\n8\\r9\\t10\t\"老张;三哥\"\t产品\\t部门\\r\\n\\n ' \" ` $() & | ; [] {} * ? ! % # <> =\n");
        assert_eq!(out.stdout.lines().count(), 1);
        assert_eq!(out.stdout.trim_end_matches('\n').split('\t').count(), 6);
        assert!(!out.stdout.contains('\r'));
    }
    assert_eq!(list_column(&json!("a@example.com")), "a@example.com");
    assert_eq!(list_column(&json!("E8")), "E8");
    assert_eq!(list_column(&json!("")), "");
}

#[test]
fn malformed_or_content_scoped_options_never_call_bridge() {
    for words in [
        vec!["list", "--project=1"],
        vec!["get", "8", "--workspace-scope"],
        vec!["list", "--limit=201"],
        vec!["list", "--limit=0"],
        vec!["search", "a", "--query=b"],
        vec!["get", "8", "--id=8"],
        vec!["update", "8"],
        vec!["add", "--name=张", "--notes=x", "--notes-file=x"],
        vec!["list", "--offset=0", "--offset=1"],
        vec!["get", "--", "--8"],
        vec!["add", "--name="],
        vec!["list", "--input-file=-", "--query=x"],
    ] {
        let mut bridge = Bridge(|_: &str, _: Value, _: &str| -> AgentResult<Value> {
            panic!("invalid input must not connect: {words:?}")
        });
        let out = run_with_bridge(&args(&words), &mut bridge);
        assert_eq!(out.exit_code, 2, "{words:?}: {}", out.stderr);
    }
}

#[test]
fn contact_environment_ignores_project_even_when_both_content_defaults_are_set() {
    let mut options = parse_options_context(&[], true).unwrap();
    cli_convenience::environment(&mut options, "contact", |key| match key {
        "PROJECT_MIND_WORKSPACE" => Some("\\\\?\\D:\\中文 空间".into()),
        "PROJECT_MIND_CONNECTION" => Some(CONNECTION.into()),
        "PROJECT_MIND_PROJECT_ID" => Some("invalid".into()),
        "PROJECT_MIND_WORKSPACE_SCOPE" => Some("1".into()),
        _ => None,
    })
    .unwrap();
    assert!(options.project.is_none() && !options.workspace_scope);
    assert_eq!(
        options.workspace.unwrap(),
        PathBuf::from("\\\\?\\D:\\中文 空间")
    );
}

#[test]
fn notes_file_accepts_utf8_bom_and_rejects_utf16_before_writing() {
    let dir = std::env::temp_dir().join(format!("contact-cli-{}", request_id()));
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join("备注 空间.txt");
    std::fs::write(&path, b"\xef\xbb\xbfline 1\r\nline 2").unwrap();
    let mut bridge = Bridge(|_: &str, params: Value, rid: &str| {
        assert_eq!(params["fields"]["notes"], "line 1\r\nline 2");
        Ok(mutation(rid))
    });
    let out = run_with_bridge(
        &args(&["add", "--name=张三", "--notes-file", path.to_str().unwrap()]),
        &mut bridge,
    );
    assert_eq!(out.exit_code, 0, "{}", out.stderr);
    std::fs::write(&path, [0xff, 0xfe, b'a', 0]).unwrap();
    let mut bridge = Bridge(|_: &str, _: Value, _: &str| -> AgentResult<Value> {
        panic!("UTF16 must fail before a write")
    });
    let out = run_with_bridge(
        &args(&["add", "--name=张三", "--notes-file", path.to_str().unwrap()]),
        &mut bridge,
    );
    assert_eq!(out.exit_code, 2);
    assert!(out.stderr.contains("UTF-16"));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn json_input_uses_native_dto_and_rejects_null_fields() {
    let path = std::env::temp_dir().join(format!("contact-{}.json", request_id()));
    for (name, expected) in [(json!("张三"), 0), (Value::Null, 2)] {
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({"requestId":"native-request","fields":{"name":name}}))
                .unwrap(),
        )
        .unwrap();
        let mut bridge = Bridge(|method: &str, params: Value, rid: &str| {
            assert_eq!(expected, 0);
            assert_eq!(method, "contact.create");
            assert_eq!(rid, "native-request");
            assert_eq!(params["fields"], json!({"name":"张三"}));
            Ok(mutation(rid))
        });
        let out = run_with_bridge(
            &args(&[
                "create",
                "--input-file",
                path.to_str().unwrap(),
                "--format=json",
            ]),
            &mut bridge,
        );
        assert_eq!(out.exit_code, expected, "{}", out.stderr);
    }
    std::fs::remove_file(path).unwrap();
}
