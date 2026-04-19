use std::{
    io::{BufRead, BufReader},
    time::Instant,
};

use anyhow::{anyhow, Context, Result};
use reqwest::blocking::{Client, Response};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value};

use crate::models::{AiArtifactSection, AiEditorRewriteContext};

#[derive(Debug, Clone)]
pub struct ResolvedAiProfile {
    pub provider_family: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub supports_text: bool,
}

#[derive(Debug, Clone)]
pub struct SuggestionPayload {
    pub activity_title: Option<String>,
    pub conclusions: Vec<String>,
    pub todos: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ArtifactPayload {
    pub overview: String,
    pub sections: Vec<AiArtifactSection>,
    pub citations: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AnswerPayload {
    pub answer_markdown: String,
    pub citations: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ProviderTestOutcome {
    pub message: String,
    pub latency_ms: i64,
    pub resolved_model: Option<String>,
}

#[derive(Debug, Clone)]
pub struct EditorRewritePayload {
    pub rewritten_markdown: String,
    pub resolved_model: Option<String>,
}

pub fn test_profile(profile: &ResolvedAiProfile) -> Result<ProviderTestOutcome> {
    ensure_text_support(profile)?;

    let started_at = Instant::now();
    let prompt = "Reply with a short plain-text OK to confirm the connection.";
    let response = request_text(profile, minimal_system_prompt(), prompt)?;
    let latency_ms = started_at.elapsed().as_millis().min(i64::MAX as u128) as i64;

    Ok(ProviderTestOutcome {
        message: "连接成功，可用于文本能力".to_string(),
        latency_ms,
        resolved_model: response.resolved_model,
    })
}

pub fn generate_suggestions(
    profile: &ResolvedAiProfile,
    activity_title: &str,
    source_text: &str,
) -> Result<SuggestionPayload> {
    ensure_text_support(profile)?;

    let prompt = suggestion_prompt(activity_title, source_text);
    let response = request_text(profile, suggestion_system_prompt(), &prompt)?;
    normalize_suggestions(&response.text)
}

pub fn generate_artifact(
    profile: &ResolvedAiProfile,
    artifact_name: &str,
    section_titles: &[&str],
    context_text: &str,
) -> Result<ArtifactPayload> {
    ensure_text_support(profile)?;

    let prompt = artifact_prompt(artifact_name, section_titles, context_text);
    let response = request_text(profile, artifact_system_prompt(), &prompt)?;
    normalize_artifact(&response.text)
}

pub fn generate_answer(
    profile: &ResolvedAiProfile,
    scope: &str,
    question: &str,
    context_text: &str,
) -> Result<AnswerPayload> {
    ensure_text_support(profile)?;

    let prompt = answer_prompt(scope, question, context_text);
    let response = request_text(profile, answer_system_prompt(), &prompt)?;
    normalize_answer(&response.text)
}

pub fn rewrite_selection(
    profile: &ResolvedAiProfile,
    action_prompt: &str,
    selected_text: &str,
    expanded_markdown: &str,
    placeholder_tokens: &[String],
    context: Option<&AiEditorRewriteContext>,
    mut on_stream: impl FnMut(String),
) -> Result<EditorRewritePayload> {
    ensure_text_support(profile)?;

    let prompt = rewrite_prompt(
        action_prompt,
        selected_text,
        expanded_markdown,
        placeholder_tokens,
        context,
    );
    let response =
        request_text_streaming(profile, rewrite_system_prompt(), &prompt, &mut on_stream)
            .or_else(|_| {
                let response = request_text(profile, rewrite_system_prompt(), &prompt)?;
                on_stream(response.text.clone());
                Ok::<ProviderTextResponse, anyhow::Error>(response)
            })?;

    Ok(EditorRewritePayload {
        rewritten_markdown: response.text,
        resolved_model: response.resolved_model,
    })
}

struct ProviderTextResponse {
    text: String,
    resolved_model: Option<String>,
}

fn request_text(
    profile: &ResolvedAiProfile,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<ProviderTextResponse> {
    if profile.base_url.contains("mock.local") || profile.base_url.starts_with("mock://") {
        return Ok(ProviderTextResponse {
            text: mock_provider_text(user_prompt),
            resolved_model: Some("mock-model".to_string()),
        });
    }

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .context("failed to initialize AI HTTP client")?;

    match profile.provider_family.as_str() {
        "openai_compatible" => openai_request(&client, profile, system_prompt, user_prompt),
        "anthropic_compatible" => anthropic_request(&client, profile, system_prompt, user_prompt),
        "gemini_compatible" => gemini_request(&client, profile, system_prompt, user_prompt),
        other => Err(anyhow!("unsupported AI provider family: {other}")),
    }
}

fn request_text_streaming(
    profile: &ResolvedAiProfile,
    system_prompt: &str,
    user_prompt: &str,
    on_stream: &mut impl FnMut(String),
) -> Result<ProviderTextResponse> {
    if profile.base_url.contains("mock.local") || profile.base_url.starts_with("mock://") {
        let text = mock_provider_text(user_prompt);
        emit_mock_stream_text(&text, on_stream);
        return Ok(ProviderTextResponse {
            text,
            resolved_model: Some("mock-model".to_string()),
        });
    }

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .context("failed to initialize AI HTTP client")?;

    match profile.provider_family.as_str() {
        "openai_compatible" => openai_request_stream(&client, profile, system_prompt, user_prompt, on_stream),
        "anthropic_compatible" => {
            anthropic_request_stream(&client, profile, system_prompt, user_prompt, on_stream)
        }
        "gemini_compatible" => gemini_request_stream(&client, profile, system_prompt, user_prompt, on_stream),
        other => Err(anyhow!("unsupported AI provider family: {other}")),
    }
}

fn openai_request(
    client: &Client,
    profile: &ResolvedAiProfile,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<ProviderTextResponse> {
    let url = join_url(&profile.base_url, "chat/completions");
    let response = client
        .post(url.clone())
        .header(AUTHORIZATION, bearer_value(&profile.api_key)?)
        .header(CONTENT_TYPE, "application/json")
        .json(&openai_chat_request_body(
            profile,
            system_prompt,
            user_prompt,
        ))
        .send()
        .with_context(|| {
            format!(
                "failed to call OpenAI-compatible provider (endpoint: {url}, model: {})",
                profile.model
            )
        })?;

    let json = parse_json_response(response)?;
    if let Some(text) = read_openai_content(&json) {
        return Ok(ProviderTextResponse {
            text,
            resolved_model: json
                .get("model")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .or_else(|| Some(profile.model.clone())),
        });
    }

    let fallback_error = match openai_responses_request(client, profile, system_prompt, user_prompt)
    {
        Ok(response) => return Ok(response),
        Err(error) => error.to_string(),
    };

    Err(anyhow!(
        concat!(
            "OpenAI-compatible provider returned an unexpected response shape. ",
            "Expected text in choices[0].message.content, choices[0].text, ",
            "output_text, or output[].content[].text. {}; ",
            "/responses fallback failed: {}"
        ),
        describe_json_shape(&json),
        fallback_error
    ))
}

fn openai_responses_request(
    client: &Client,
    profile: &ResolvedAiProfile,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<ProviderTextResponse> {
    let url = join_url(&profile.base_url, "responses");
    let response = client
        .post(url.clone())
        .header(AUTHORIZATION, bearer_value(&profile.api_key)?)
        .header(CONTENT_TYPE, "application/json")
        .json(&openai_responses_request_body(
            profile,
            system_prompt,
            user_prompt,
        ))
        .send()
        .with_context(|| {
            format!(
                "failed to call OpenAI-compatible provider /responses fallback (endpoint: {url}, model: {})",
                profile.model
            )
        })?;

    let json = parse_json_response(response)?;
    let text = read_openai_content(&json).ok_or_else(|| {
        anyhow!(
            concat!(
                "OpenAI-compatible provider /responses fallback returned an unexpected response shape. ",
                "Expected text in choices[0].message.content, choices[0].text, ",
                "output_text, or output[].content[].text. {}"
            ),
            describe_json_shape(&json)
        )
    })?;

    Ok(ProviderTextResponse {
        text,
        resolved_model: json
            .get("model")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| Some(profile.model.clone())),
    })
}

fn openai_chat_request_body(
    profile: &ResolvedAiProfile,
    system_prompt: &str,
    user_prompt: &str,
) -> Value {
    let mut body = json!({
        "model": profile.model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ]
    });

    if let Some(object) = body.as_object_mut() {
        if uses_reasoning_chat_parameters(&profile.model) {
            object.insert("max_completion_tokens".to_string(), json!(700));
        } else {
            object.insert("temperature".to_string(), json!(0.2));
            object.insert("max_tokens".to_string(), json!(700));
        }
    }

    body
}

fn openai_chat_stream_request_body(
    profile: &ResolvedAiProfile,
    system_prompt: &str,
    user_prompt: &str,
) -> Value {
    let mut body = openai_chat_request_body(profile, system_prompt, user_prompt);
    if let Some(object) = body.as_object_mut() {
        object.insert("stream".to_string(), json!(true));
    }
    body
}

fn openai_responses_request_body(
    profile: &ResolvedAiProfile,
    system_prompt: &str,
    user_prompt: &str,
) -> Value {
    json!({
        "model": profile.model,
        "instructions": system_prompt,
        "input": user_prompt,
        "max_output_tokens": 700
    })
}

fn uses_reasoning_chat_parameters(model: &str) -> bool {
    let normalized = model.trim().to_ascii_lowercase();
    matches_model_prefix(&normalized, "gpt-5")
        || matches_model_prefix(&normalized, "o1")
        || matches_model_prefix(&normalized, "o3")
        || matches_model_prefix(&normalized, "o4")
}

fn matches_model_prefix(model: &str, prefix: &str) -> bool {
    model == prefix
        || model.starts_with(&format!("{prefix}-"))
        || model.starts_with(&format!("{prefix}."))
}

fn anthropic_request(
    client: &Client,
    profile: &ResolvedAiProfile,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<ProviderTextResponse> {
    let url = join_url(&profile.base_url, "messages");
    let response = client
        .post(url.clone())
        .header("x-api-key", &profile.api_key)
        .header("anthropic-version", "2023-06-01")
        .header(CONTENT_TYPE, "application/json")
        .json(&json!({
            "model": profile.model,
            "max_tokens": 700,
            "system": system_prompt,
            "messages": [
                { "role": "user", "content": user_prompt }
            ]
        }))
        .send()
        .with_context(|| {
            format!(
                "failed to call Claude-compatible provider (endpoint: {url}, model: {})",
                profile.model
            )
        })?;

    let json = parse_json_response(response)?;
    let text = json
        .get("content")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| {
            anyhow!(
                "Claude-compatible provider returned an unexpected response shape. {}",
                describe_json_shape(&json)
            )
        })?;

    Ok(ProviderTextResponse {
        text,
        resolved_model: json
            .get("model")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| Some(profile.model.clone())),
    })
}

fn gemini_request(
    client: &Client,
    profile: &ResolvedAiProfile,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<ProviderTextResponse> {
    let url = format!(
        "{}/models/{}:generateContent",
        profile.base_url.trim_end_matches('/'),
        profile.model
    );
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-goog-api-key",
        HeaderValue::from_str(&profile.api_key).context("invalid Gemini-compatible API key")?,
    );
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    let response = client
        .post(url.clone())
        .headers(headers)
        .json(&json!({
            "systemInstruction": {
                "parts": [{ "text": system_prompt }]
            },
            "contents": [
                {
                    "role": "user",
                    "parts": [{ "text": user_prompt }]
                }
            ],
            "generationConfig": {
                "temperature": 0.2
            }
        }))
        .send()
        .with_context(|| {
            format!(
                "failed to call Gemini-compatible provider (endpoint: {url}, model: {})",
                profile.model
            )
        })?;

    let json = parse_json_response(response)?;
    let text = json
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first())
        .and_then(|candidate| candidate.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| {
            anyhow!(
                "Gemini-compatible provider returned an unexpected response shape. {}",
                describe_json_shape(&json)
            )
        })?;

    Ok(ProviderTextResponse {
        text,
        resolved_model: json
            .get("modelVersion")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| Some(profile.model.clone())),
    })
}

fn openai_request_stream(
    client: &Client,
    profile: &ResolvedAiProfile,
    system_prompt: &str,
    user_prompt: &str,
    on_stream: &mut impl FnMut(String),
) -> Result<ProviderTextResponse> {
    let url = join_url(&profile.base_url, "chat/completions");
    let response = client
        .post(url.clone())
        .header(AUTHORIZATION, bearer_value(&profile.api_key)?)
        .header(CONTENT_TYPE, "application/json")
        .json(&openai_chat_stream_request_body(
            profile,
            system_prompt,
            user_prompt,
        ))
        .send()
        .with_context(|| {
            format!(
                "failed to call OpenAI-compatible provider streaming endpoint (endpoint: {url}, model: {})",
                profile.model
            )
        })?;

    let mut resolved_model = Some(profile.model.clone());
    let mut text = String::new();

    consume_sse_events(response, |event| {
        if event == "[DONE]" {
            return Ok(());
        }

        let json: Value =
            serde_json::from_str(event).context("failed to parse OpenAI-compatible SSE event")?;
        if resolved_model.is_none() {
            resolved_model = json
                .get("model")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
        }

        let chunk = read_openai_stream_chunk(&json);
        if !chunk.is_empty() {
            text.push_str(&chunk);
            on_stream(text.clone());
        }
        Ok(())
    })?;

    if text.trim().is_empty() {
        return Err(anyhow!(
            "OpenAI-compatible streaming response did not contain any text deltas"
        ));
    }

    Ok(ProviderTextResponse {
        text,
        resolved_model,
    })
}

fn anthropic_request_stream(
    client: &Client,
    profile: &ResolvedAiProfile,
    system_prompt: &str,
    user_prompt: &str,
    on_stream: &mut impl FnMut(String),
) -> Result<ProviderTextResponse> {
    let url = join_url(&profile.base_url, "messages");
    let response = client
        .post(url.clone())
        .header("x-api-key", &profile.api_key)
        .header("anthropic-version", "2023-06-01")
        .header(CONTENT_TYPE, "application/json")
        .json(&json!({
            "model": profile.model,
            "max_tokens": 1500,
            "system": system_prompt,
            "messages": [
                { "role": "user", "content": user_prompt }
            ],
            "stream": true
        }))
        .send()
        .with_context(|| {
            format!(
                "failed to call Claude-compatible provider streaming endpoint (endpoint: {url}, model: {})",
                profile.model
            )
        })?;

    let mut resolved_model = Some(profile.model.clone());
    let mut text = String::new();

    consume_sse_events(response, |event| {
        let json: Value =
            serde_json::from_str(event).context("failed to parse Claude-compatible SSE event")?;
        if resolved_model.is_none() {
            resolved_model = json
                .get("message")
                .and_then(|message| message.get("model"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .or_else(|| {
                    json.get("model")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                });
        }

        let chunk = json
            .get("delta")
            .and_then(|delta| delta.get("text"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !chunk.is_empty() {
            text.push_str(chunk);
            on_stream(text.clone());
        }
        Ok(())
    })?;

    if text.trim().is_empty() {
        return Err(anyhow!(
            "Claude-compatible streaming response did not contain any text deltas"
        ));
    }

    Ok(ProviderTextResponse {
        text,
        resolved_model,
    })
}

fn gemini_request_stream(
    client: &Client,
    profile: &ResolvedAiProfile,
    system_prompt: &str,
    user_prompt: &str,
    on_stream: &mut impl FnMut(String),
) -> Result<ProviderTextResponse> {
    let url = format!(
        "{}/models/{}:streamGenerateContent?alt=sse",
        profile.base_url.trim_end_matches('/'),
        profile.model
    );
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-goog-api-key",
        HeaderValue::from_str(&profile.api_key).context("invalid Gemini-compatible API key")?,
    );
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    let response = client
        .post(url.clone())
        .headers(headers)
        .json(&json!({
            "systemInstruction": {
                "parts": [{ "text": system_prompt }]
            },
            "contents": [
                {
                    "role": "user",
                    "parts": [{ "text": user_prompt }]
                }
            ],
            "generationConfig": {
                "temperature": 0.2
            }
        }))
        .send()
        .with_context(|| {
            format!(
                "failed to call Gemini-compatible provider streaming endpoint (endpoint: {url}, model: {})",
                profile.model
            )
        })?;

    let mut resolved_model = Some(profile.model.clone());
    let mut text = String::new();

    consume_sse_events(response, |event| {
        let json: Value =
            serde_json::from_str(event).context("failed to parse Gemini-compatible SSE event")?;
        if resolved_model.is_none() {
            resolved_model = json
                .get("modelVersion")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
        }

        let chunk = json
            .get("candidates")
            .and_then(Value::as_array)
            .and_then(|candidates| candidates.first())
            .and_then(|candidate| candidate.get("content"))
            .and_then(|content| content.get("parts"))
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default();

        if !chunk.is_empty() {
            text.push_str(&chunk);
            on_stream(text.clone());
        }
        Ok(())
    })?;

    if text.trim().is_empty() {
        return Err(anyhow!(
            "Gemini-compatible streaming response did not contain any text deltas"
        ));
    }

    Ok(ProviderTextResponse {
        text,
        resolved_model,
    })
}

fn parse_json_response(response: Response) -> Result<Value> {
    let status = response.status();
    let request_id = extract_response_request_id(response.headers());
    let text = response
        .text()
        .context("failed to read AI provider response body")?;

    if !status.is_success() {
        let request_id_fragment = request_id
            .as_deref()
            .map(|value| format!(", request_id={value}"))
            .unwrap_or_default();
        return Err(anyhow!(
            "AI provider request failed ({}{}): {}",
            status.as_u16(),
            request_id_fragment,
            extract_error_message(&text)
        ));
    }

    serde_json::from_str(&text).with_context(|| {
        format!(
            "AI provider returned invalid JSON. body preview: {}",
            preview_text(&text, 280)
        )
    })
}

fn consume_sse_events(
    response: Response,
    mut on_event: impl FnMut(&str) -> Result<()>,
) -> Result<()> {
    let status = response.status();
    let request_id = extract_response_request_id(response.headers());
    if !status.is_success() {
        let body = response
            .text()
            .context("failed to read AI provider response body")?;
        let request_id_fragment = request_id
            .as_deref()
            .map(|value| format!(", request_id={value}"))
            .unwrap_or_default();
        return Err(anyhow!(
            "AI provider request failed ({}{}): {}",
            status.as_u16(),
            request_id_fragment,
            extract_error_message(&body)
        ));
    }

    let mut reader = BufReader::new(response);
    let mut line = String::new();
    let mut pending_data = Vec::new();

    loop {
        line.clear();
        let bytes_read = reader
            .read_line(&mut line)
            .context("failed to read AI provider SSE response body")?;
        if bytes_read == 0 {
            if !pending_data.is_empty() {
                on_event(&pending_data.join("\n"))?;
            }
            break;
        }

        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            if !pending_data.is_empty() {
                on_event(&pending_data.join("\n"))?;
                pending_data.clear();
            }
            continue;
        }

        if trimmed.starts_with(':') {
            continue;
        }

        if let Some(data) = trimmed.strip_prefix("data:") {
            pending_data.push(data.trim_start().to_string());
        }
    }

    Ok(())
}

fn extract_error_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|json| {
            let error_object = json.get("error");
            let message = error_object
                .and_then(|error| {
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                        .or_else(|| error.as_str().map(ToOwned::to_owned))
                })
                .or_else(|| {
                    json.get("message")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                });
            let error_code = error_object
                .and_then(|error| error.get("code"))
                .and_then(Value::as_str)
                .or_else(|| json.get("code").and_then(Value::as_str));
            let error_type = error_object
                .and_then(|error| error.get("type"))
                .and_then(Value::as_str)
                .or_else(|| json.get("type").and_then(Value::as_str));
            let request_id = json
                .get("request_id")
                .and_then(Value::as_str)
                .or_else(|| json.get("requestId").and_then(Value::as_str))
                .or_else(|| {
                    error_object
                        .and_then(|error| error.get("request_id"))
                        .and_then(Value::as_str)
                });

            message.map(|message| {
                let mut details = Vec::new();
                if let Some(error_type) = error_type.filter(|value| !value.trim().is_empty()) {
                    details.push(format!("type={error_type}"));
                }
                if let Some(error_code) = error_code.filter(|value| !value.trim().is_empty()) {
                    details.push(format!("code={error_code}"));
                }
                if let Some(request_id) = request_id.filter(|value| !value.trim().is_empty()) {
                    details.push(format!("request_id={request_id}"));
                }

                if details.is_empty() {
                    message
                } else {
                    format!("{message} ({})", details.join(", "))
                }
            })
        })
        .unwrap_or_else(|| preview_text(body, 280))
}

fn read_openai_content(json: &Value) -> Option<String> {
    let mut segments = Vec::new();

    collect_openai_text_segments(json.get("output_text"), &mut segments);

    if let Some(choice) = json
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
    {
        collect_openai_text_segments(
            choice
                .get("message")
                .and_then(|message| message.get("content")),
            &mut segments,
        );
        collect_openai_text_segments(choice.get("text"), &mut segments);
        collect_openai_text_segments(
            choice.get("delta").and_then(|delta| delta.get("content")),
            &mut segments,
        );
    }

    collect_openai_text_segments(json.get("output"), &mut segments);
    collect_openai_text_segments(
        json.get("message")
            .and_then(|message| message.get("content")),
        &mut segments,
    );
    collect_openai_text_segments(json.get("content"), &mut segments);

    if let Some(text) = join_text_segments(segments) {
        return Some(text);
    }

    let mut reasoning_segments = Vec::new();
    collect_openai_reasoning_segments(json.get("output"), &mut reasoning_segments);

    if let Some(choice) = json
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
    {
        collect_openai_reasoning_segments(choice.get("message"), &mut reasoning_segments);
        collect_openai_reasoning_segments(choice.get("delta"), &mut reasoning_segments);
    }

    collect_openai_reasoning_segments(json.get("message"), &mut reasoning_segments);
    collect_openai_reasoning_segments(json.get("content"), &mut reasoning_segments);

    join_text_segments(reasoning_segments)
}

fn read_openai_stream_chunk(json: &Value) -> String {
    let mut segments = Vec::new();

    if let Some(choice) = json
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
    {
        collect_openai_stream_segments(choice.get("delta"), &mut segments);
        collect_openai_stream_segments(choice.get("message"), &mut segments);
        collect_openai_stream_segments(choice.get("text"), &mut segments);
    }

    collect_openai_stream_segments(json.get("delta"), &mut segments);
    collect_openai_stream_segments(json.get("output"), &mut segments);
    collect_openai_stream_segments(json.get("content"), &mut segments);
    collect_openai_stream_segments(json.get("output_text"), &mut segments);

    segments.join("")
}

fn collect_openai_stream_segments(value: Option<&Value>, segments: &mut Vec<String>) {
    let Some(value) = value else {
        return;
    };

    match value {
        Value::String(text) => {
            if !text.is_empty() {
                segments.push(text.to_string());
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_openai_stream_segments(Some(item), segments);
            }
        }
        Value::Object(map) => {
            if let Some(text) = map.get("text").and_then(Value::as_str) {
                if !text.is_empty() {
                    segments.push(text.to_string());
                }
            }
            if let Some(value) = map.get("value") {
                collect_openai_stream_segments(Some(value), segments);
            }
            if let Some(content) = map.get("content") {
                collect_openai_stream_segments(Some(content), segments);
            }
            if let Some(parts) = map.get("parts") {
                collect_openai_stream_segments(Some(parts), segments);
            }
            if let Some(delta) = map.get("delta") {
                collect_openai_stream_segments(Some(delta), segments);
            }
            if let Some(output_text) = map.get("output_text") {
                collect_openai_stream_segments(Some(output_text), segments);
            }
        }
        _ => {}
    }
}

fn collect_openai_text_segments(value: Option<&Value>, segments: &mut Vec<String>) {
    let Some(value) = value else {
        return;
    };

    match value {
        Value::String(text) => push_text_segment(text, segments),
        Value::Array(items) => {
            for item in items {
                collect_openai_text_segments(Some(item), segments);
            }
        }
        Value::Object(map) => {
            if let Some(text) = map.get("text") {
                collect_openai_text_segments(Some(text), segments);
            }
            if let Some(value) = map.get("value") {
                collect_openai_text_segments(Some(value), segments);
            }
            if let Some(content) = map.get("content") {
                collect_openai_text_segments(Some(content), segments);
            }
            if let Some(parts) = map.get("parts") {
                collect_openai_text_segments(Some(parts), segments);
            }
            if let Some(message) = map.get("message") {
                collect_openai_text_segments(Some(message), segments);
            }
            if let Some(delta) = map.get("delta") {
                collect_openai_text_segments(Some(delta), segments);
            }
            if let Some(output) = map.get("output") {
                collect_openai_text_segments(Some(output), segments);
            }
            if let Some(output_text) = map.get("output_text") {
                collect_openai_text_segments(Some(output_text), segments);
            }
        }
        _ => {}
    }
}

fn collect_openai_reasoning_segments(value: Option<&Value>, segments: &mut Vec<String>) {
    let Some(value) = value else {
        return;
    };

    match value {
        Value::Array(items) => {
            for item in items {
                collect_openai_reasoning_segments(Some(item), segments);
            }
        }
        Value::Object(map) => {
            if let Some(reasoning_content) = map.get("reasoning_content") {
                collect_openai_text_segments(Some(reasoning_content), segments);
            }
            if let Some(reasoning) = map.get("reasoning") {
                collect_openai_text_segments(Some(reasoning), segments);
            }
            if let Some(thinking_blocks) = map.get("thinking_blocks") {
                collect_openai_text_segments(Some(thinking_blocks), segments);
            }
            if let Some(provider_specific_fields) = map.get("provider_specific_fields") {
                collect_openai_reasoning_segments(Some(provider_specific_fields), segments);
            }
            if let Some(message) = map.get("message") {
                collect_openai_reasoning_segments(Some(message), segments);
            }
            if let Some(delta) = map.get("delta") {
                collect_openai_reasoning_segments(Some(delta), segments);
            }
            if let Some(content) = map.get("content") {
                collect_openai_reasoning_segments(Some(content), segments);
            }
            if let Some(parts) = map.get("parts") {
                collect_openai_reasoning_segments(Some(parts), segments);
            }
            if let Some(output) = map.get("output") {
                collect_openai_reasoning_segments(Some(output), segments);
            }
        }
        _ => {}
    }
}

fn push_text_segment(text: &str, segments: &mut Vec<String>) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }

    let candidate = trimmed.to_string();
    if !segments.contains(&candidate) {
        segments.push(candidate);
    }
}

fn join_text_segments(segments: Vec<String>) -> Option<String> {
    if segments.is_empty() {
        return None;
    }

    Some(segments.join("\n"))
}

fn describe_json_shape(json: &Value) -> String {
    let mut parts = Vec::new();

    if let Some(keys) = object_keys(json) {
        parts.push(format!("top-level keys: {}", keys.join(", ")));
    }

    if let Some(choice) = json
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
    {
        if let Some(keys) = object_keys(choice) {
            parts.push(format!("choices[0] keys: {}", keys.join(", ")));
        }

        if let Some(content) = choice
            .get("message")
            .and_then(|message| message.get("content"))
        {
            parts.push(format!(
                "choices[0].message.content type: {}",
                value_shape(content)
            ));
        }

        if let Some(reasoning_content) = choice
            .get("message")
            .and_then(|message| message.get("reasoning_content"))
        {
            parts.push(format!(
                "choices[0].message.reasoning_content type: {}",
                value_shape(reasoning_content)
            ));
        }

        if let Some(text) = choice.get("text") {
            parts.push(format!("choices[0].text type: {}", value_shape(text)));
        }
    }

    if let Some(output_text) = json.get("output_text") {
        parts.push(format!("output_text type: {}", value_shape(output_text)));
    }

    if let Some(output) = json.get("output") {
        parts.push(format!("output type: {}", value_shape(output)));
    }

    let preview = serde_json::to_string(json)
        .map(|body| preview_text(&body, 320))
        .unwrap_or_else(|_| "<failed to serialize JSON body>".to_string());
    parts.push(format!("body preview: {preview}"));

    parts.join("; ")
}

fn value_shape(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(_) => "boolean".to_string(),
        Value::Number(_) => "number".to_string(),
        Value::String(_) => "string".to_string(),
        Value::Array(items) => format!("array(len={})", items.len()),
        Value::Object(map) => {
            let keys = map.keys().take(5).cloned().collect::<Vec<_>>();
            if keys.is_empty() {
                "object".to_string()
            } else {
                format!("object(keys={})", keys.join(", "))
            }
        }
    }
}

fn object_keys(value: &Value) -> Option<Vec<String>> {
    value
        .as_object()
        .map(|map| map.keys().take(8).cloned().collect::<Vec<_>>())
}

fn preview_text(value: &str, limit: usize) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut preview = collapsed.chars().take(limit).collect::<String>();
    if collapsed.chars().count() > limit {
        preview.push_str("...");
    }
    preview
}

fn extract_response_request_id(headers: &HeaderMap) -> Option<String> {
    ["x-request-id", "request-id", "anthropic-request-id"]
        .into_iter()
        .find_map(|name| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
}

fn join_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

fn bearer_value(api_key: &str) -> Result<HeaderValue> {
    HeaderValue::from_str(&format!("Bearer {}", api_key))
        .context("invalid OpenAI-compatible API key")
}

fn minimal_system_prompt() -> &'static str {
    "You are a connectivity test. Reply with a short plain-text OK only."
}

fn suggestion_system_prompt() -> &'static str {
    "You extract structured suggestions from project notes. Reply with valid JSON only. Do not wrap the JSON in markdown fences."
}

fn artifact_system_prompt() -> &'static str {
    "You write concise Chinese project summaries from structured local context. Reply with valid JSON only. Do not wrap the JSON in markdown fences."
}

fn answer_system_prompt() -> &'static str {
    "You answer questions from structured local project sources. Reply with valid JSON only. Do not wrap the JSON in markdown fences."
}

fn rewrite_system_prompt() -> &'static str {
    concat!(
        "You rewrite selected rich-text markdown blocks inside a local editor. ",
        "Reply with markdown only. Do not add explanations. Do not wrap the markdown in code fences. ",
        "Any placeholder token provided by the system must be preserved exactly, unchanged, and in the same order."
    )
}

fn suggestion_prompt(activity_title: &str, source_text: &str) -> String {
    format!(
        concat!(
            "Read the activity notes and return one JSON object with this exact shape:\n",
            "{{\"activityTitle\":\"\", \"conclusions\":[], \"todos\":[]}}\n\n",
            "Rules:\n",
            "- activityTitle: a concise improved activity title in Chinese, or an empty string if no better title is needed.\n",
            "- conclusions: 0 to 3 concise Chinese conclusion sentences.\n",
            "- todos: 0 to 3 concise Chinese todo items.\n",
            "- Do not include any fields other than activityTitle, conclusions, todos.\n",
            "- Do not include explanations.\n\n",
            "Current activity title:\n{activity_title}\n\n",
            "Source notes:\n{source_text}"
        ),
        activity_title = if activity_title.trim().is_empty() {
            "(empty)"
        } else {
            activity_title.trim()
        },
        source_text = truncate_chars(source_text, 12000)
    )
}

fn artifact_prompt(artifact_name: &str, section_titles: &[&str], context_text: &str) -> String {
    let section_copy = section_titles
        .iter()
        .map(|title| format!("- {title}"))
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        concat!(
            "Read the local project context and return one JSON object with this exact shape:\n",
            "{{\"overview\":\"\", \"sections\":[{{\"title\":\"\", \"items\":[]}}], \"citations\":[]}}\n\n",
            "Rules:\n",
            "- overview: a concise Chinese overview paragraph.\n",
            "- sections: use the required section titles in the same order.\n",
            "- each section contains 0 to 4 concise Chinese bullet items.\n",
            "- citations: 1 to 6 source refs chosen only from the provided source list. Refs must match exactly.\n",
            "- Do not invent refs.\n",
            "- Do not include any fields other than overview, sections, citations.\n",
            "- Do not include explanations.\n\n",
            "Artifact name:\n{artifact_name}\n\n",
            "Required section titles:\n{section_copy}\n\n",
            "Context sources:\n{context_text}"
        ),
        artifact_name = artifact_name.trim(),
        section_copy = section_copy,
        context_text = truncate_chars(context_text, 16000)
    )
}

fn answer_prompt(scope: &str, question: &str, context_text: &str) -> String {
    format!(
        concat!(
            "Read the retrieved local sources and return one JSON object with this exact shape:\n",
            "{{\"answerMarkdown\":\"\", \"citations\":[]}}\n\n",
            "Rules:\n",
            "- answerMarkdown: concise Chinese markdown answering the question.\n",
            "- Only use the provided sources. Do not invent facts.\n",
            "- If evidence is insufficient, answerMarkdown must clearly say the evidence is insufficient.\n",
            "- citations: 0 to 6 source refs chosen only from the provided source list. Refs must match exactly.\n",
            "- Do not include any fields other than answerMarkdown and citations.\n",
            "- Do not include explanations.\n\n",
            "Scope:\n{scope}\n\n",
            "Question:\n{question}\n\n",
            "Retrieved sources:\n{context_text}"
        ),
        scope = scope.trim(),
        question = truncate_chars(question, 1200),
        context_text = truncate_chars(context_text, 16000)
    )
}

fn rewrite_prompt(
    action_prompt: &str,
    selected_text: &str,
    expanded_markdown: &str,
    placeholder_tokens: &[String],
    context: Option<&AiEditorRewriteContext>,
) -> String {
    let placeholder_rules = if placeholder_tokens.is_empty() {
        "- No placeholder tokens are present.".to_string()
    } else {
        placeholder_tokens
            .iter()
            .map(|token| format!("- Preserve this token exactly: {token}"))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let context_text = context
        .map(render_editor_rewrite_context)
        .unwrap_or_else(|| "scope=unknown".to_string());

    format!(
        concat!(
            "User-configured rewrite instruction:\n",
            "{action_prompt}\n\n",
            "Exact original selection:\n",
            "{selected_text}\n\n",
            "Expanded markdown block(s) to rewrite:\n",
            "{expanded_markdown}\n\n",
            "Editor context:\n",
            "{context_text}\n\n",
            "Placeholder preservation rules:\n",
            "{placeholder_rules}\n\n",
            "Return only the rewritten markdown for the expanded block(s)."
        ),
        action_prompt = truncate_chars(action_prompt.trim(), 4000),
        selected_text = truncate_chars(selected_text, 4000),
        expanded_markdown = truncate_chars(expanded_markdown, 20000),
        context_text = context_text,
        placeholder_rules = placeholder_rules
    )
}

fn render_editor_rewrite_context(context: &AiEditorRewriteContext) -> String {
    let mut parts = vec![format!("scope={}", context.scope.trim())];

    if let Some(project_id) = context.project_id {
        parts.push(format!("project_id={project_id}"));
    }
    if let Some(activity_id) = context.activity_id {
        parts.push(format!("activity_id={activity_id}"));
    }
    if let Some(note_id) = context.note_id {
        parts.push(format!("note_id={note_id}"));
    }
    if let Some(workspace_note_id) = context.workspace_note_id {
        parts.push(format!("workspace_note_id={workspace_note_id}"));
    }
    if let Some(source_label) = context
        .source_label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        parts.push(format!("source_label={source_label}"));
    }

    parts.join(", ")
}

fn normalize_suggestions(raw_text: &str) -> Result<SuggestionPayload> {
    let json = extract_json_object(raw_text)?;

    let activity_title = json
        .get("activityTitle")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let conclusions: Vec<String> = collect_string_array(json.get("conclusions"))
        .into_iter()
        .take(3)
        .collect();
    let todos: Vec<String> = collect_string_array(json.get("todos"))
        .into_iter()
        .take(3)
        .collect();

    if activity_title.is_none() && conclusions.is_empty() && todos.is_empty() {
        return Err(anyhow!(
            "AI provider returned JSON, but no usable suggestions were found"
        ));
    }

    Ok(SuggestionPayload {
        activity_title,
        conclusions,
        todos,
    })
}

fn normalize_artifact(raw_text: &str) -> Result<ArtifactPayload> {
    let json = extract_json_object(raw_text)?;
    let overview = json
        .get("overview")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow!("AI provider returned JSON, but overview is empty"))?;
    let sections = json
        .get("sections")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let title = item
                        .get("title")
                        .and_then(Value::as_str)?
                        .trim()
                        .to_string();
                    if title.is_empty() {
                        return None;
                    }
                    let section_items = collect_string_array(item.get("items"));
                    Some(AiArtifactSection {
                        title,
                        items: section_items.into_iter().take(4).collect(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let citations = collect_string_array(json.get("citations"))
        .into_iter()
        .take(6)
        .collect::<Vec<_>>();

    if sections.is_empty() {
        return Err(anyhow!(
            "AI provider returned JSON, but no usable artifact sections were found"
        ));
    }

    Ok(ArtifactPayload {
        overview,
        sections,
        citations,
    })
}

fn normalize_answer(raw_text: &str) -> Result<AnswerPayload> {
    let json = extract_json_object(raw_text)?;
    let answer_markdown = json
        .get("answerMarkdown")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow!("AI provider returned JSON, but answerMarkdown is empty"))?;
    let citations = collect_string_array(json.get("citations"))
        .into_iter()
        .take(6)
        .collect::<Vec<_>>();

    Ok(AnswerPayload {
        answer_markdown,
        citations,
    })
}

fn collect_string_array(value: Option<&Value>) -> Vec<String> {
    let items = match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>(),
        Some(Value::String(item)) if !item.trim().is_empty() => vec![item.trim().to_string()],
        _ => Vec::new(),
    };

    let mut unique = Vec::new();
    for item in items {
        if !unique.contains(&item) {
            unique.push(item);
        }
    }
    unique
}

fn extract_json_object(raw_text: &str) -> Result<Value> {
    let trimmed = raw_text.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Ok(value);
    }

    let bytes = trimmed.as_bytes();
    for start in 0..bytes.len() {
        if bytes[start] != b'{' {
            continue;
        }
        let mut depth = 0_i64;
        for end in start..bytes.len() {
            match bytes[end] {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        let candidate = &trimmed[start..=end];
                        if let Ok(value) = serde_json::from_str::<Value>(candidate) {
                            return Ok(value);
                        }
                        break;
                    }
                }
                _ => {}
            }
        }
    }

    Err(anyhow!("AI provider did not return valid JSON"))
}

fn truncate_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn mock_provider_text(user_prompt: &str) -> String {
    if user_prompt.contains("\"activityTitle\"") {
        return serde_json::to_string(&json!({
            "activityTitle": "",
            "conclusions": ["确认当前阶段目标与约束"],
            "todos": ["整理本次活动结论并同步下一步"]
        }))
        .unwrap_or_else(|_| {
            "{\"activityTitle\":\"\",\"conclusions\":[],\"todos\":[]}".to_string()
        });
    }

    if user_prompt.contains("\"overview\"") && user_prompt.contains("\"sections\"") {
        let refs = extract_mock_refs(user_prompt);
        let section_titles = extract_section_titles(user_prompt);
        let sections = section_titles
            .into_iter()
            .map(|title| {
                let items = match title.as_str() {
                    "关键结论" => vec!["AI 已从当前上下文整理出一组关键判断".to_string()],
                    "未决问题 / 风险" | "阻塞" | "等待 / 阻塞项" => {
                        vec!["仍需补充进一步确认或外部反馈".to_string()]
                    }
                    "优先做的 3 件事" => vec![
                        "先处理最紧急且影响最大的待办".to_string(),
                        "同步最近活动产生的关键变化".to_string(),
                        "确认下一步责任人与时点".to_string(),
                    ],
                    _ => vec!["建议继续围绕当前重点推进并更新进展".to_string()],
                };

                json!({
                    "title": title,
                    "items": items,
                })
            })
            .collect::<Vec<_>>();

        return serde_json::to_string(&json!({
            "overview": "AI 已基于当前本地上下文整理出一版概览，方便快速判断当前状态与下一步。",
            "sections": sections,
            "citations": refs.into_iter().take(4).collect::<Vec<_>>()
        }))
        .unwrap_or_else(|_| {
            "{\"overview\":\"mock\",\"sections\":[],\"citations\":[]}".to_string()
        });
    }

    if user_prompt.contains("\"answerMarkdown\"") && user_prompt.contains("Retrieved sources:") {
        let refs = extract_mock_refs(user_prompt);
        return serde_json::to_string(&json!({
            "answerMarkdown": "基于当前检索到的本地资料，最相关的信息已经整理在下面的引用里，可先从这些对象继续确认细节。",
            "citations": refs.into_iter().take(3).collect::<Vec<_>>()
        }))
        .unwrap_or_else(|_| "{\"answerMarkdown\":\"mock\",\"citations\":[]}".to_string());
    }

    if user_prompt.contains("Expanded markdown block(s) to rewrite:") {
        let expanded_markdown =
            extract_mock_section(user_prompt, "Expanded markdown block(s) to rewrite:");
        let selection = extract_mock_section(user_prompt, "Exact original selection:");
        let rewritten = if expanded_markdown.trim().is_empty() {
            selection.trim().to_string()
        } else {
            expanded_markdown
                .lines()
                .map(|line| {
                    if line.trim().is_empty() {
                        String::new()
                    } else if line.contains("PM_TOKEN_") {
                        line.to_string()
                    } else if line.starts_with('#') || line.starts_with('-') || line.starts_with('*') {
                        format!("{line}（已按要求优化表达）")
                    } else {
                        format!("{line}（已按要求优化表达）")
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        return rewritten;
    }

    "OK".to_string()
}

fn emit_mock_stream_text(value: &str, on_stream: &mut impl FnMut(String)) {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.is_empty() {
        on_stream(String::new());
        return;
    }

    let mut built = String::new();
    for chunk in chars.chunks(24) {
        built.extend(chunk.iter().copied());
        on_stream(built.clone());
    }
}

fn extract_mock_refs(user_prompt: &str) -> Vec<String> {
    let mut refs = Vec::new();
    for line in user_prompt.lines() {
        let trimmed = line.trim();
        if let Some((candidate, _)) = trimmed.split_once(" | ") {
            let is_valid = !candidate.is_empty()
                && candidate
                    .chars()
                    .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '-');
            let candidate_owned = candidate.to_string();
            if is_valid && !refs.contains(&candidate_owned) {
                refs.push(candidate_owned);
            }
        }
    }
    refs
}

fn extract_mock_section(user_prompt: &str, heading: &str) -> String {
    let Some(start) = user_prompt.find(heading) else {
        return String::new();
    };
    let rest = &user_prompt[start + heading.len()..];
    let trimmed = rest.trim_start_matches('\n');
    let next_headings = [
        "\n\nExact original selection:",
        "\n\nExpanded markdown block(s) to rewrite:",
        "\n\nEditor context:",
        "\n\nPlaceholder preservation rules:",
        "\n\nReturn only the rewritten markdown for the expanded block(s).",
    ];
    let end = next_headings
        .iter()
        .filter_map(|candidate| trimmed.find(candidate))
        .min()
        .unwrap_or(trimmed.len());
    trimmed[..end].trim().to_string()
}

fn extract_section_titles(user_prompt: &str) -> Vec<String> {
    let mut titles = Vec::new();
    let mut collecting = false;
    for line in user_prompt.lines() {
        let trimmed = line.trim();
        if trimmed == "Required section titles:" {
            collecting = true;
            continue;
        }
        if collecting {
            if trimmed.is_empty() {
                break;
            }
            if let Some(title) = trimmed.strip_prefix("- ") {
                titles.push(title.trim().to_string());
            }
        }
    }
    titles
}

fn ensure_text_support(profile: &ResolvedAiProfile) -> Result<()> {
    if !profile.supports_text {
        return Err(anyhow!(
            "the selected AI profile does not support text requests"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        describe_json_shape, extract_error_message, openai_chat_request_body, read_openai_content,
        uses_reasoning_chat_parameters, ResolvedAiProfile,
    };
    use serde_json::json;

    #[test]
    fn reads_openai_chat_completion_string_content() {
        let json = json!({
            "choices": [
                {
                    "message": {
                        "content": "Hello from chat completions"
                    }
                }
            ]
        });

        assert_eq!(
            read_openai_content(&json).as_deref(),
            Some("Hello from chat completions")
        );
    }

    #[test]
    fn reads_openai_chat_completion_content_parts() {
        let json = json!({
            "choices": [
                {
                    "message": {
                        "content": [
                            { "type": "text", "text": "First part" },
                            { "type": "text", "text": "Second part" }
                        ]
                    }
                }
            ]
        });

        assert_eq!(
            read_openai_content(&json).as_deref(),
            Some("First part\nSecond part")
        );
    }

    #[test]
    fn reads_legacy_openai_completion_text() {
        let json = json!({
            "choices": [
                {
                    "text": "Legacy completion payload"
                }
            ]
        });

        assert_eq!(
            read_openai_content(&json).as_deref(),
            Some("Legacy completion payload")
        );
    }

    #[test]
    fn reads_responses_api_output_text() {
        let json = json!({
            "output_text": "Hello from responses"
        });

        assert_eq!(
            read_openai_content(&json).as_deref(),
            Some("Hello from responses")
        );
    }

    #[test]
    fn reads_responses_api_output_parts() {
        let json = json!({
            "output": [
                {
                    "type": "message",
                    "content": [
                        { "type": "output_text", "text": "Structured response" },
                        { "type": "output_text", "text": "Second line" }
                    ]
                }
            ]
        });

        assert_eq!(
            read_openai_content(&json).as_deref(),
            Some("Structured response\nSecond line")
        );
    }

    #[test]
    fn reads_message_content_objects_with_value_field() {
        let json = json!({
            "choices": [
                {
                    "message": {
                        "content": {
                            "type": "text",
                            "text": {
                                "value": "Nested text value"
                            }
                        }
                    }
                }
            ]
        });

        assert_eq!(
            read_openai_content(&json).as_deref(),
            Some("Nested text value")
        );
    }

    #[test]
    fn reads_reasoning_content_when_message_content_is_null() {
        let json = json!({
            "choices": [
                {
                    "message": {
                        "content": null,
                        "reasoning_content": "Reasoning fallback text"
                    }
                }
            ]
        });

        assert_eq!(
            read_openai_content(&json).as_deref(),
            Some("Reasoning fallback text")
        );
    }

    #[test]
    fn reads_provider_specific_reasoning_content_when_message_content_is_null() {
        let json = json!({
            "choices": [
                {
                    "message": {
                        "content": null,
                        "provider_specific_fields": {
                            "reasoning_content": "Proxy reasoning text"
                        }
                    }
                }
            ]
        });

        assert_eq!(
            read_openai_content(&json).as_deref(),
            Some("Proxy reasoning text")
        );
    }

    #[test]
    fn uses_reasoning_chat_parameters_for_gpt5_and_o_series_models() {
        assert!(uses_reasoning_chat_parameters("gpt-5.4"));
        assert!(uses_reasoning_chat_parameters("gpt-5-mini"));
        assert!(uses_reasoning_chat_parameters("o3-mini"));
        assert!(!uses_reasoning_chat_parameters("gpt-4.1-mini"));
    }

    #[test]
    fn builds_reasoning_chat_request_with_max_completion_tokens() {
        let body =
            openai_chat_request_body(&test_profile("gpt-5.4"), "system prompt", "user prompt");

        assert_eq!(body.get("temperature"), None);
        assert_eq!(
            body.get("max_completion_tokens")
                .and_then(|value| value.as_i64()),
            Some(700)
        );
        assert_eq!(body.get("max_tokens"), None);
    }

    #[test]
    fn builds_standard_chat_request_with_temperature_and_max_tokens() {
        let body = openai_chat_request_body(
            &test_profile("gpt-4.1-mini"),
            "system prompt",
            "user prompt",
        );

        assert_eq!(
            body.get("temperature").and_then(|value| value.as_f64()),
            Some(0.2)
        );
        assert_eq!(body.get("max_completion_tokens"), None);
        assert_eq!(
            body.get("max_tokens").and_then(|value| value.as_i64()),
            Some(700)
        );
    }

    #[test]
    fn extracts_provider_error_details_from_json_body() {
        let body = json!({
            "error": {
                "message": "Model not found",
                "type": "invalid_request_error",
                "code": "model_not_found"
            },
            "request_id": "req_123"
        });

        let message = extract_error_message(&body.to_string());

        assert!(message.contains("Model not found"));
        assert!(message.contains("type=invalid_request_error"));
        assert!(message.contains("code=model_not_found"));
        assert!(message.contains("request_id=req_123"));
    }

    #[test]
    fn describes_json_shape_for_unexpected_provider_payloads() {
        let json = json!({
            "object": "response",
            "output": [
                {
                    "type": "message",
                    "content": [
                        { "type": "refusal", "reason": "safety" }
                    ]
                }
            ]
        });

        let summary = describe_json_shape(&json);

        assert!(summary.contains("top-level keys: object, output"));
        assert!(summary.contains("output type: array(len=1)"));
        assert!(summary.contains("body preview:"));
    }

    fn test_profile(model: &str) -> ResolvedAiProfile {
        ResolvedAiProfile {
            provider_family: "openai_compatible".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            api_key: "test-key".to_string(),
            model: model.to_string(),
            supports_text: true,
        }
    }
}
