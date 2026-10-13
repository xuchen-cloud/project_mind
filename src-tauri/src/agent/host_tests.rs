use super::super::conversation::MessageRole;
use super::*;

#[test]
fn desktop_tool_manifest_is_accepted_by_the_packaged_host_adapter() {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let tools: Vec<_> = read_tool_descriptions().into_iter()
        .chain(super::super::record_write_tools::record_write_tool_descriptions())
        .collect();
    let repository = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut child = Command::new("node").current_dir(repository)
        .args(["--input-type=module", "-e", "import {readFileSync} from 'node:fs'; import {validateToolDescriptors} from './packages/agent-host/src/tool-descriptors.mjs'; validateToolDescriptors(JSON.parse(readFileSync(0,'utf8')));"])
        .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(&serde_json::to_vec(&tools).unwrap()).unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
}

#[test]
fn internal_context_check_does_not_extend_first_progress_deadline() {
    let started = Instant::now();
    let mut last_progress = started;
    let mut progress = false;
    let total_deadline = started + TOTAL_TIMEOUT;
    let first = run_deadline(started, last_progress, progress, total_deadline);
    tool_progress("session.context.check", &mut progress, &mut last_progress, started + Duration::from_secs(40));
    assert_eq!(run_deadline(started, last_progress, progress, total_deadline), first);
    tool_progress("source.search", &mut progress, &mut last_progress, started + Duration::from_secs(41));
    assert!(run_deadline(started, last_progress, progress, total_deadline) > first);
}

fn checkpoint(count: u64) -> SessionCheckpoint {
    SessionCheckpoint {
        schema_version: 1,
        checksum: format!("sha256:{}", "a".repeat(64)),
        bytes: 1000,
        offset: 1000,
        leaf_id: Some("leaf".into()),
        entry_count: count + 1,
        message_count: count,
    }
}
fn message(ordinal: u64) -> ProjectionMessage {
    ProjectionMessage {
        runtime_entry_id: format!("entry-{ordinal}"),
        ordinal,
        created_at: "2026-10-08T00:00:00Z".into(),
        role: MessageRole::User,
        content: json!("literal /original/workspace text"),
        parent_id: None,
        stop_reason: None,
        usage: None,
        tool_call_id: None,
        tool_name: None,
        is_error: None,
    }
}
fn page(offset: u64, count: u64, total: u64) -> ProjectionPage {
    ProjectionPage {
        session_id: "session".into(),
        checksum: checkpoint(total).checksum,
        offset,
        messages: (offset..offset + count).map(message).collect(),
        next_offset: (offset + count < total).then_some(offset + count),
        total,
    }
}
#[test]
fn agent_host_projection_pages_require_committed_binding_order_and_complete_coverage() {
    let mut collector = ProjectionCollector::new(checkpoint(3)).unwrap();
    assert!(!collector.append("session", page(0, 2, 3)).unwrap());
    assert!(collector.append("session", page(2, 1, 3)).unwrap());
    let projection = collector.finish();
    assert_eq!(projection.messages.len(), 3);
    assert_eq!(
        projection.messages[0].content,
        json!("literal /original/workspace text")
    );
    for invalid in 0..5 {
        let mut collector = ProjectionCollector::new(checkpoint(3)).unwrap();
        let mut input = page(0, 2, 3);
        match invalid {
            0 => input.checksum = "wrong".into(),
            1 => input.session_id = "other".into(),
            2 => input.offset = 1,
            3 => input.messages[1].runtime_entry_id = input.messages[0].runtime_entry_id.clone(),
            _ => input.next_offset = None,
        }
        assert!(collector.append("session", input).is_err());
    }
    assert!(ProjectionCollector::new(SessionCheckpoint {
        offset: 1,
        ..checkpoint(0)
    })
    .is_err());
    let mut empty = ProjectionCollector::new(checkpoint(0)).unwrap();
    assert!(empty.append("session", page(0, 0, 0)).unwrap());
}
#[test]
fn agent_host_wire_rejects_stale_runs_nonmonotonic_events_and_unbound_tools() {
    let frame = json!({"protocolVersion":HOST_PROTOCOL,"sessionId":"session","runId":"run","seq":1,"type":"run.started","data":{}});
    let mut wire = WireRun {
        session_id: "session",
        run_id: "run",
        seq: 0,
    };
    assert_eq!(wire.event(&frame).unwrap().0, "run.started");
    assert!(wire.event(&frame).is_err());
    let mut other = frame.clone();
    other["seq"] = json!(2);
    other["runId"] = json!("stale");
    assert!(wire.event(&other).is_err());
    let tool = json!({"protocolVersion":HOST_PROTOCOL,"sessionId":"session","runId":"run","requestId":"call","data":{"payload":{"scope":{"kind":"project","projectId":1}}}});
    assert!(wire.tool(&tool).is_ok());
    let mut legacy = tool.clone();
    legacy["data"]["payload"] = json!("JSON-string wrapper");
    assert!(wire.tool(&legacy).is_err());
    let mut stale = tool;
    stale["sessionId"] = json!("other");
    assert!(wire.tool(&stale).is_err());
}
#[test]
fn agent_host_responses_do_not_reflect_provider_errors_and_usage_is_bounded() {
    let frame = json!({"protocolVersion":HOST_PROTOCOL,"requestId":"open","ok":false,"error":{"code":"SECRETS_LOCKED","message":"private-key"}});
    let error = response(frame, "open").unwrap_err();
    assert_eq!(error.code, ErrorCode::SecretsLocked);
    assert!(!error.message.contains("private-key"));
    assert!(usage(Some(
        &json!({"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":3})
    ))
    .is_ok());
    assert!(usage(Some(
        &json!({"input":-1,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":1})
    ))
    .is_err());
}

#[test]
fn agent_host_read_budget_accumulates_l0_and_multiple_tools_and_clamps_only_valid_arguments() {
    let mut reads = super::super::context::ReadBudget::new(None);
    reads
        .charge(&json!({"scope":"project","nodes":[]}))
        .unwrap();
    reads.charge(&json!("a".repeat(11000))).unwrap();
    reads.charge(&json!("b".repeat(11000))).unwrap();
    let remaining = reads.remaining();
    assert!(remaining < 2000);
    let clipped = bounded_read_arguments(
        "source.read",
        json!({"view":"full","budgetChars":12000}),
        &reads,
    )
    .unwrap();
    assert_eq!(clipped["budgetChars"], json!(remaining));
    assert_eq!(clipped["view"], "full");
    let original = json!({"budgetChars":900000});
    assert_eq!(
        bounded_read_arguments("source.read", original.clone(), &reads).unwrap(),
        original
    );
    assert_eq!(
        reads
            .charge(&json!("x".repeat(remaining)))
            .unwrap_err()
            .code,
        ErrorCode::BudgetExceeded
    );
}

#[test]
fn agent_host_read_budget_counts_unicode_characters_and_metadata_without_partial_result_leaks() {
    let mut reads = super::super::context::ReadBudget::new(Some(30));
    let result = json!({"text":"中文🧭"});
    reads.charge(&result).unwrap();
    assert_eq!(
        reads.remaining(),
        30 - serde_json::to_string(&result).unwrap().chars().count()
    );
    let before = reads.remaining();
    assert!(reads
        .charge(&json!({"text":"一".repeat(30),"sourceRef":"record:1"}))
        .is_err());
    assert_eq!(reads.remaining(), before);
    let mut exhausted = super::super::context::ReadBudget::new(Some(2));
    exhausted.charge(&json!("")).unwrap();
    assert_eq!(
        bounded_read_arguments(
            "context.get",
            json!({"scope":{"kind":"project","projectId":1}}),
            &exhausted
        )
        .unwrap_err()
        .code,
        ErrorCode::BudgetExceeded
    );
}
