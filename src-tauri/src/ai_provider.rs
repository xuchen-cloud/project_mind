use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use reqwest::blocking::{Client, Response};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value};

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
pub struct ProviderTestOutcome {
    pub message: String,
    pub latency_ms: i64,
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

struct ProviderTextResponse {
    text: String,
    resolved_model: Option<String>,
}

fn request_text(
    profile: &ResolvedAiProfile,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<ProviderTextResponse> {
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

fn openai_request(
    client: &Client,
    profile: &ResolvedAiProfile,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<ProviderTextResponse> {
    let url = join_url(&profile.base_url, "chat/completions");
    let response = client
        .post(url)
        .header(AUTHORIZATION, bearer_value(&profile.api_key)?)
        .header(CONTENT_TYPE, "application/json")
        .json(&json!({
            "model": profile.model,
            "temperature": 0.2,
            "max_tokens": 700,
            "messages": [
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": user_prompt }
            ]
        }))
        .send()
        .context("failed to call OpenAI-compatible provider")?;

    let json = parse_json_response(response)?;
    let text = read_openai_content(&json).ok_or_else(|| {
        anyhow!("OpenAI-compatible provider returned an unexpected response shape")
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

fn anthropic_request(
    client: &Client,
    profile: &ResolvedAiProfile,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<ProviderTextResponse> {
    let url = join_url(&profile.base_url, "messages");
    let response = client
        .post(url)
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
        .context("failed to call Claude-compatible provider")?;

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
            anyhow!("Claude-compatible provider returned an unexpected response shape")
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
        .post(url)
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
        .context("failed to call Gemini-compatible provider")?;

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
            anyhow!("Gemini-compatible provider returned an unexpected response shape")
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

fn parse_json_response(response: Response) -> Result<Value> {
    let status = response.status();
    let text = response
        .text()
        .context("failed to read AI provider response body")?;

    if !status.is_success() {
        return Err(anyhow!(
            "AI provider request failed ({}): {}",
            status.as_u16(),
            extract_error_message(&text)
        ));
    }

    serde_json::from_str(&text).context("AI provider returned invalid JSON")
}

fn extract_error_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|json| {
            json.get("error")
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
                })
        })
        .unwrap_or_else(|| body.trim().to_string())
}

fn read_openai_content(json: &Value) -> Option<String> {
    let content = json
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))?;

    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }

    content.as_array().map(|parts| {
        parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n")
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

fn ensure_text_support(profile: &ResolvedAiProfile) -> Result<()> {
    if !profile.supports_text {
        return Err(anyhow!(
            "the selected AI profile does not support text requests"
        ));
    }
    Ok(())
}
