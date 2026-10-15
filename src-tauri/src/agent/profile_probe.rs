//! One explicit paid diagnostic, using the same packaged SDK/JSONL path as a
//! conversation. The command owner alone records a Profile verification receipt.
use super::{
    errors::{AgentError, AgentResult, ErrorCode},
    process::{HostProcess, PackagedAgentRuntime},
    runtime::HOST_PROTOCOL,
};
use crate::ai_provider::ResolvedAiProfile;
use rand::RngCore;
use serde_json::{json, Value};
use std::{collections::HashSet, fs, path::Path, time::Duration};
use tokio::{sync::watch, time::Instant};

const PROBE_SECONDS: u64 = 60;
const CLEANUP_SECONDS: u64 = 5;

fn id() -> String {
    let mut bytes = [0_u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn invalid() -> AgentError {
    AgentError::new(
        ErrorCode::RuntimeIncompatible,
        "Profile probe protocol is incompatible",
    )
}
fn unsupported() -> AgentError {
    AgentError::new(
        ErrorCode::ToolCallUnsupported,
        "Profile tool round trip was not verified",
    )
}
fn cancelled() -> AgentError {
    AgentError::new(ErrorCode::Cancelled, "Profile probe was cancelled")
}
fn failed_io() -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Cannot settle Profile probe")
}
async fn cancellation(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            return;
        }
    }
}
fn request(request_id: &str, method: &str, data: Value) -> Value {
    json!({"protocolVersion":HOST_PROTOCOL,"requestId":request_id,"method":method,"data":data})
}
fn response(frame: &Value, request_id: &str) -> AgentResult<()> {
    if frame["protocolVersion"] != HOST_PROTOCOL || frame["requestId"] != request_id {
        return Err(invalid());
    }
    match frame["ok"].as_bool() {
        Some(true) if frame["data"].is_object() => Ok(()),
        Some(false) => {
            // Server messages may contain sensitive Profile data. Use fixed errors.
            let code = match frame["error"]["code"].as_str() {
                Some("PROFILE_UNAVAILABLE") => ErrorCode::ProfileUnavailable,
                Some("SECRETS_LOCKED") => ErrorCode::SecretsLocked,
                Some("TOOL_CALL_UNSUPPORTED") => ErrorCode::ToolCallUnsupported,
                Some("RATE_LIMITED") => ErrorCode::RateLimited,
                Some("RUNTIME_UNAVAILABLE") => ErrorCode::RuntimeUnavailable,
                _ => ErrorCode::RuntimeIncompatible,
            };
            Err(AgentError::new(code, "Cannot open Profile tool probe"))
        }
        _ => Err(invalid()),
    }
}
async fn call(
    host: &mut HostProcess,
    request_id: &str,
    method: &str,
    data: Value,
) -> AgentResult<()> {
    host.send(&request(request_id, method, data)).await?;
    let frame = host.next_frame().await?.ok_or_else(invalid)?;
    response(&frame, request_id)
}

struct Evidence {
    session_id: String,
    run_id: String,
    challenge: String,
    nonce: String,
    last_seq: u64,
    started: bool,
    calls: HashSet<String>,
    final_has_nonce: bool,
}
enum Step {
    Continue,
    ToolResult(Value),
    Verified,
}
impl Evidence {
    fn new() -> Self {
        Self {
            session_id: id(),
            run_id: id(),
            challenge: id(),
            nonce: id(),
            last_seq: 0,
            started: false,
            calls: HashSet::new(),
            final_has_nonce: false,
        }
    }
    fn accept(&mut self, frame: &Value) -> AgentResult<Step> {
        if frame["protocolVersion"] != HOST_PROTOCOL
            || frame["sessionId"] != self.session_id
            || frame["runId"] != self.run_id
        {
            return Err(invalid());
        }
        if frame["method"] == "tool.call" {
            let request_id = frame["requestId"].as_str().ok_or_else(invalid)?;
            if !self.started
                || request_id.len() != 32
                || !request_id
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                || self.calls.contains(request_id)
                || frame["data"]["method"] != "source.read"
                || frame["data"]["payload"] != json!({"challenge":self.challenge})
                || frame["data"]["toolCallId"]
                    .as_str()
                    .is_none_or(|value| value.is_empty() || value.len() > 128)
            {
                return Err(invalid());
            }
            if self.calls.len() >= 30 {
                return Err(AgentError::new(
                    ErrorCode::BudgetExceeded,
                    "Profile probe exceeded tool budget",
                ));
            }
            self.calls.insert(request_id.to_owned());
            return Ok(Step::ToolResult(request(
                request_id,
                "tool.result",
                json!({
                    "sessionId":self.session_id,"runId":self.run_id,"result":{"nonce":self.nonce},
                }),
            )));
        }
        let seq = frame["seq"].as_u64().ok_or_else(invalid)?;
        if seq != self.last_seq + 1 {
            return Err(invalid());
        }
        self.last_seq = seq;
        match frame["type"].as_str() {
            Some("run.started") if !self.started && seq == 1 => self.started = true,
            Some("message.completed") if self.started => {
                let data = &frame["data"];
                if data["role"] == "assistant" {
                    self.final_has_nonce = !self.calls.is_empty()
                        && data["stopReason"] == "stop"
                        && data["content"].as_array().is_some_and(|content| {
                            content.iter().any(|part| {
                                part["type"] == "text"
                                    && part["text"]
                                        .as_str()
                                        .is_some_and(|text| text.contains(&self.nonce))
                            })
                        });
                }
            }
            Some("run.completed") if self.started => {
                // run.completed means the Host observed agent_settled and saved
                // its checkpoint; a start acknowledgement or delta cannot pass.
                if !self.final_has_nonce || self.calls.is_empty() {
                    return Err(unsupported());
                }
                if !frame["data"]["checkpoint"].is_object() {
                    return Err(invalid());
                }
                return Ok(Step::Verified);
            }
            Some("run.failed") => return Err(unsupported()),
            Some("run.cancelled") => return Err(cancelled()),
            Some("text.delta" | "tool.started" | "tool.completed") if self.started => {}
            _ => return Err(invalid()),
        }
        Ok(Step::Continue)
    }
}

async fn round_trip(
    host: &mut HostProcess,
    root: &Path,
    profile: ResolvedAiProfile,
    evidence: &mut Evidence,
) -> AgentResult<()> {
    let system_prompt = format!(
        "You are running a Profile tool-calling diagnostic. Call the sole tool mind_probe_nonce exactly once with {{\"challenge\":\"{}\"}}. After the tool responds, output its nonce verbatim as your final answer. Do not invent a nonce. Do not perform any other action.",
        evidence.challenge,
    );
    call(host, &id(), "initialize", json!({
        "workspaceRoot":root,"systemPrompt":system_prompt,
        "tools":[{"name":"mind_probe_nonce","method":"source.read",
            "description":"Diagnostic only: return a nonce for the supplied challenge; reads no Workspace content.",
            "parameters":{"type":"object","properties":{"challenge":{"type":"string","maxLength":32}},
                "required":["challenge"],"additionalProperties":false}}],
    })).await?;
    call(host, &id(), "session.open", json!({
        "sessionId":evidence.session_id,"apiKey":profile.api_key,
        // This internal diagnostic is the one entry allowed to test an unverified
        // Profile. It does not establish a receipt until the round trip succeeds.
        "toolCallingVerified":true,"modelId":profile.model,
        "profile":{"providerFamily":profile.provider_family,"enabled":true,"supportsText":profile.supports_text,
            "baseUrl":profile.base_url,"defaultModel":profile.model,"maxTokens":256},
    })).await?;
    call(host, &id(), "run.start", json!({
        "sessionId":evidence.session_id,"runId":evidence.run_id,
        "prompt":"Perform the diagnostic tool call now, then return only the nonce you receive.",
    })).await?;
    loop {
        let frame = host.next_frame().await?.ok_or_else(invalid)?;
        match evidence.accept(&frame)? {
            Step::Continue => {}
            Step::ToolResult(result) => host.send(&result).await?,
            Step::Verified => return Ok(()),
        }
    }
}

fn cleanup(root: &Path, session_id: &str) -> AgentResult<()> {
    let mut path = root.to_owned();
    for component in [".project-mind", "agent", "sessions", session_id] {
        path.push(component);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            _ => return Err(failed_io()),
        }
    }
    fs::remove_dir_all(path).map_err(|_| failed_io())
}

pub(crate) async fn verify(
    app: &tauri::AppHandle,
    root: &Path,
    profile: ResolvedAiProfile,
    mut cancel: watch::Receiver<bool>,
) -> AgentResult<()> {
    let deadline = Instant::now() + Duration::from_secs(PROBE_SECONDS);
    let app = app.clone();
    let runtime = tokio::select! {
        biased;
        _ = cancellation(&mut cancel) => return Err(cancelled()),
        _ = tokio::time::sleep_until(deadline) => return Err(AgentError::new(ErrorCode::BudgetExceeded,"Profile probe timed out")),
        result = tokio::task::spawn_blocking(move || PackagedAgentRuntime::for_app(&app)) => result.map_err(|_| failed_io())??,
    };
    verify_with_runtime(runtime, root, profile, cancel, deadline).await
}

async fn verify_with_runtime(
    runtime: PackagedAgentRuntime,
    root: &Path,
    profile: ResolvedAiProfile,
    mut cancel: watch::Receiver<bool>,
    deadline: Instant,
) -> AgentResult<()> {
    let root = root.canonicalize().map_err(|_| failed_io())?;
    let mut evidence = Evidence::new();
    let mut host = tokio::select! {
        biased;
        _ = cancellation(&mut cancel) => return Err(cancelled()),
        _ = tokio::time::sleep_until(deadline) => return Err(AgentError::new(ErrorCode::BudgetExceeded,"Profile probe timed out")),
        result = runtime.spawn_for_profile(&root, true, &profile) => result?,
    };
    let result = tokio::select! {
        biased;
        _ = cancellation(&mut cancel) => Err(cancelled()),
        _ = tokio::time::sleep_until(deadline) => Err(AgentError::new(ErrorCode::BudgetExceeded,"Profile probe timed out")),
        result = round_trip(&mut host, &root, profile, &mut evidence) => result,
    };
    let settled = tokio::time::timeout(Duration::from_secs(CLEANUP_SECONDS), async {
        if result.is_err() {
            host.send(&request(
                &id(),
                "run.cancel",
                json!({"sessionId":evidence.session_id,"runId":evidence.run_id}),
            ))
            .await?;
        }
        host.send(&request(&id(), "shutdown", json!({}))).await?;
        host.shutdown().await
    })
    .await;
    let termination = if matches!(settled, Ok(Ok(()))) {
        Ok(())
    } else {
        host.kill().await
    };
    drop(host);
    let cleanup = cleanup(&root, &evidence.session_id);
    result.and(termination).and(cleanup)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn provider_request(stream: &mut tokio::net::TcpStream) -> Value {
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 4096];
        let header_end = loop {
            let count = stream.read(&mut chunk).await.unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&chunk[..count]);
            assert!(bytes.len() < 1024 * 1024);
            if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                break end + 4;
            }
        };
        let headers = std::str::from_utf8(&bytes[..header_end]).unwrap();
        assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.1\r\n"));
        assert!(headers
            .to_ascii_lowercase()
            .contains("authorization: bearer fixture-only-key"));
        let length: usize = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse().unwrap())
            })
            .expect("SDK request declares its content length");
        assert!(length < 1024 * 1024);
        while bytes.len() < header_end + length {
            let count = stream.read(&mut chunk).await.unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&chunk[..count]);
        }
        serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap()
    }

    async fn provider_response(stream: &mut tokio::net::TcpStream, delta: Value, finish: &str) {
        let mut body = String::new();
        for (delta, finish_reason) in [(delta, Value::Null), (json!({}), json!(finish))] {
            body.push_str(&format!("data: {}\n\n", json!({
                "id":"probe-fixture","object":"chat.completion.chunk","created":1,"model":"fixture",
                "choices":[{"index":0,"delta":delta,"finish_reason":finish_reason}],
            })));
        }
        body.push_str("data: [DONE]\n\n");
        let headers = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
        stream.write_all(headers.as_bytes()).await.unwrap();
        stream.write_all(body.as_bytes()).await.unwrap();
        stream.shutdown().await.unwrap();
    }
    fn event(evidence: &Evidence, seq: u64, kind: &str, data: Value) -> Value {
        json!({"protocolVersion":HOST_PROTOCOL,"sessionId":evidence.session_id,"runId":evidence.run_id,
            "seq":seq,"type":kind,"data":data})
    }
    fn tool(evidence: &Evidence, request_id: &str) -> Value {
        json!({"protocolVersion":HOST_PROTOCOL,"sessionId":evidence.session_id,"runId":evidence.run_id,
            "requestId":request_id,"method":"tool.call","data":{"method":"source.read",
                "toolCallId":"provider-call","payload":{"challenge":evidence.challenge}}})
    }
    fn start(evidence: &mut Evidence) {
        evidence
            .accept(&event(evidence, 1, "run.started", json!({})))
            .unwrap();
    }

    #[test]
    fn profile_probe_requires_real_tool_result_final_message_and_settled_terminal() {
        let mut evidence = Evidence::new();
        start(&mut evidence);
        let request_id = id();
        let Step::ToolResult(result) = evidence.accept(&tool(&evidence, &request_id)).unwrap()
        else {
            panic!("tool result expected")
        };
        assert_eq!(result["requestId"], request_id);
        assert_eq!(result["data"]["result"]["nonce"], evidence.nonce);
        let message = event(
            &evidence,
            2,
            "message.completed",
            json!({"role":"assistant","stopReason":"stop",
            "content":[{"type":"text","text":evidence.nonce}]}),
        );
        assert!(matches!(evidence.accept(&message).unwrap(), Step::Continue));
        assert!(matches!(
            evidence
                .accept(&event(
                    &evidence,
                    3,
                    "run.completed",
                    json!({"checkpoint":{"checksum":"fixture"}})
                ))
                .unwrap(),
            Step::Verified
        ));
        let mut no_tool = Evidence::new();
        start(&mut no_tool);
        assert_eq!(
            no_tool
                .accept(&event(
                    &no_tool,
                    2,
                    "run.completed",
                    json!({"checkpoint":{}})
                ))
                .err()
                .unwrap()
                .code,
            ErrorCode::ToolCallUnsupported
        );
    }

    #[test]
    fn profile_probe_rejects_wrong_binding_raw_arguments_and_duplicate_calls() {
        let mut evidence = Evidence::new();
        start(&mut evidence);
        let valid = tool(&evidence, &id());
        for (key, value) in [
            ("sessionId", json!(id())),
            ("runId", json!(id())),
            ("requestId", json!("invalid")),
        ] {
            let mut changed = valid.clone();
            changed[key] = value;
            assert!(evidence.accept(&changed).is_err());
        }
        for payload in [
            json!({"challenge":"wrong"}),
            json!({"challenge":evidence.challenge,"path":"private"}),
            json!(evidence.challenge),
        ] {
            let mut changed = tool(&evidence, &id());
            changed["data"]["payload"] = payload;
            assert!(evidence.accept(&changed).is_err());
        }
        let valid = tool(&evidence, &id());
        assert!(matches!(
            evidence.accept(&valid).unwrap(),
            Step::ToolResult(_)
        ));
        assert!(evidence.accept(&valid).is_err());
    }

    #[test]
    fn profile_probe_rejects_delta_only_success_and_scrubs_remote_errors() {
        let mut evidence = Evidence::new();
        start(&mut evidence);
        evidence.accept(&tool(&evidence, &id())).unwrap();
        evidence
            .accept(&event(
                &evidence,
                2,
                "text.delta",
                json!({"text":evidence.nonce}),
            ))
            .unwrap();
        assert!(evidence
            .accept(&event(
                &evidence,
                3,
                "run.completed",
                json!({"checkpoint":{}})
            ))
            .is_err());
        let request_id = id();
        let error = response(
            &json!({"protocolVersion":HOST_PROTOCOL,"requestId":request_id,"ok":false,
            "error":{"code":"RATE_LIMITED","message":"secret-provider-key"}}),
            &request_id,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::RateLimited);
        assert!(!error.message.contains("secret"));
    }

    #[test]
    fn profile_probe_removes_only_its_private_session() {
        let root = tempfile::tempdir().unwrap();
        let session_id = id();
        let sessions = root.path().join(".project-mind/agent/sessions");
        fs::create_dir_all(sessions.join(&session_id)).unwrap();
        fs::create_dir_all(sessions.join("keep")).unwrap();
        fs::write(sessions.join(&session_id).join("session.jsonl"), "fixture").unwrap();
        cleanup(root.path(), &session_id).unwrap();
        assert!(!sessions.join(&session_id).exists());
        assert!(sessions.join("keep").exists());
    }

    #[tokio::test]
    #[ignore = "requires staged packaged Pi resources and pinned Node; run explicitly"]
    async fn profile_probe_packaged_sdk_performs_nonce_tool_roundtrip_and_cleans_history() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let provider = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let first = provider_request(&mut stream).await;
            let tools = first["tools"].as_array().unwrap();
            assert_eq!(tools.len(), 1);
            assert_eq!(tools[0]["function"]["name"], "mind_probe_nonce");
            assert_eq!(
                tools[0]["function"]["parameters"]["additionalProperties"],
                false
            );
            assert_eq!(
                tools[0]["function"]["parameters"]["required"],
                json!(["challenge"])
            );
            let system = first["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|message| message["role"] == "system")
                .unwrap()["content"]
                .as_str()
                .unwrap();
            let challenge = system
                .split("{\"challenge\":\"")
                .nth(1)
                .unwrap()
                .split('"')
                .next()
                .unwrap();
            assert_eq!(challenge.len(), 32);
            assert!(!serde_json::to_string(&first)
                .unwrap()
                .contains("business-private-content"));
            provider_response(&mut stream, json!({"role":"assistant","tool_calls":[{
                "index":0,"id":"probe-call","type":"function","function":{"name":"mind_probe_nonce",
                    "arguments":serde_json::to_string(&json!({"challenge":challenge})).unwrap()},
            }]}), "tool_calls").await;
            let (mut stream, _) = listener.accept().await.unwrap();
            let second = provider_request(&mut stream).await;
            let result = second["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|message| message["role"] == "tool")
                .expect("SDK must receive actual Rust tool result");
            assert_eq!(result["tool_call_id"], "probe-call");
            let result: Value = serde_json::from_str(result["content"].as_str().unwrap()).unwrap();
            let nonce = result["nonce"].as_str().unwrap();
            assert_eq!(nonce.len(), 32);
            assert!(!serde_json::to_string(&first).unwrap().contains(nonce));
            provider_response(
                &mut stream,
                json!({"role":"assistant","content":nonce}),
                "stop",
            )
            .await;
            (first, second)
        });
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("private.txt"), "business-private-content").unwrap();
        let sessions = root.path().join(".project-mind/agent/sessions");
        fs::create_dir_all(sessions.join("keep")).unwrap();
        let runtime =
            PackagedAgentRuntime::bundled(&Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"))
                .unwrap();
        let profile = ResolvedAiProfile {
            profile_name: "fixture".into(),
            provider_family: "openai_compatible".into(),
            base_url: format!("http://{address}/v1"),
            api_key: "fixture-only-key".into(),
            model: "fixture".into(),
            supports_text: true,
            supports_image: false,
            network: Default::default(),
        };
        let (_sender, cancel) = watch::channel(false);
        tokio::time::timeout(
            Duration::from_secs(30),
            verify_with_runtime(
                runtime,
                root.path(),
                profile,
                cancel,
                Instant::now() + Duration::from_secs(PROBE_SECONDS),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        let (_first, second) = provider.await.unwrap();
        assert!(!serde_json::to_string(&second)
            .unwrap()
            .contains("business-private-content"));
        assert_eq!(
            fs::read_to_string(root.path().join("private.txt")).unwrap(),
            "business-private-content"
        );
        let remaining: Vec<_> = fs::read_dir(sessions)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(remaining, vec![std::ffi::OsString::from("keep")]);
    }
}
