//! Paraformer realtime-v2 event contract. Transport must enforce this gate
//! before sending PCM and must persist Final events by provider key.
use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, Message},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParaformerEvent {
    Started,
    Partial {
        start_ms: u64,
        text: String,
    },
    Final {
        provider_key: String,
        start_ms: u64,
        end_ms: u64,
        text: String,
    },
    Finished,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    AwaitingStart,
    Streaming,
    Finishing,
    Finished,
    Failed,
}

pub struct ParaformerTask {
    task_id: String,
    phase: Phase,
}

impl ParaformerTask {
    pub fn new(task_id: String) -> Result<Self> {
        if task_id.is_empty() || task_id.len() > 128 {
            return Err(anyhow!("invalid Paraformer task ID"));
        }
        Ok(Self {
            task_id,
            phase: Phase::AwaitingStart,
        })
    }

    pub fn run_task(&self) -> Value {
        json!({
            "header": {"action": "run-task", "task_id": self.task_id, "streaming": "duplex"},
            "payload": {
                "task_group": "audio", "task": "asr", "function": "recognition",
                "model": "paraformer-realtime-v2",
                "parameters": {"format": "pcm", "sample_rate": 16000, "heartbeat": true},
                "input": {}
            }
        })
    }

    pub fn can_send_audio(&self) -> bool {
        self.phase == Phase::Streaming
    }

    pub fn finish_task(&mut self) -> Result<Value> {
        if self.phase != Phase::Streaming {
            return Err(anyhow!("Paraformer task is not streaming"));
        }
        self.phase = Phase::Finishing;
        Ok(
            json!({"header": {"action": "finish-task", "task_id": self.task_id, "streaming": "duplex"}, "payload": {"input": {}}}),
        )
    }

    pub fn accept_event(&mut self, raw: &str) -> Result<Option<ParaformerEvent>> {
        let value: Value = serde_json::from_str(raw)?;
        let header = value
            .get("header")
            .ok_or_else(|| anyhow!("missing Paraformer event header"))?;
        if header.get("task_id").and_then(Value::as_str) != Some(self.task_id.as_str()) {
            return Err(anyhow!("Paraformer event belongs to another task"));
        }
        let event = header
            .get("event")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("missing Paraformer event name"))?;
        match event {
            "task-started" if self.phase == Phase::AwaitingStart => {
                self.phase = Phase::Streaming;
                Ok(Some(ParaformerEvent::Started))
            }
            "result-generated" if matches!(self.phase, Phase::Streaming | Phase::Finishing) => {
                let sentence = &value["payload"]["output"]["sentence"];
                if sentence.get("heartbeat").and_then(Value::as_bool) == Some(true) {
                    return Ok(None);
                }
                let text = sentence
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("missing Paraformer text"))?
                    .trim();
                if text.is_empty() {
                    return Ok(None);
                }
                let start_ms = sentence
                    .get("begin_time")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| anyhow!("missing Paraformer begin_time"))?;
                let final_sentence = sentence
                    .get("sentence_end")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| anyhow!("missing Paraformer sentence_end"))?;
                if !final_sentence {
                    return Ok(Some(ParaformerEvent::Partial {
                        start_ms,
                        text: text.into(),
                    }));
                }
                // The documented final event can have end_time=null; the last
                // word timestamp is the only grounded fallback in that case.
                let end_ms = sentence
                    .get("end_time")
                    .and_then(Value::as_u64)
                    .or_else(|| {
                        sentence
                            .get("words")?
                            .as_array()?
                            .iter()
                            .rev()
                            .find_map(|word| word.get("end_time")?.as_u64())
                    })
                    .ok_or_else(|| anyhow!("Paraformer final has no end timestamp"))?;
                if end_ms <= start_ms {
                    return Err(anyhow!("invalid Paraformer sentence range"));
                }
                Ok(Some(ParaformerEvent::Final {
                    provider_key: format!("{}:{start_ms}", self.task_id),
                    start_ms,
                    end_ms,
                    text: text.into(),
                }))
            }
            "task-finished" if self.phase == Phase::Finishing => {
                self.phase = Phase::Finished;
                Ok(Some(ParaformerEvent::Finished))
            }
            "task-failed" => {
                self.phase = Phase::Failed;
                let code = header
                    .get("error_code")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                Err(anyhow!("Paraformer task failed: {code}"))
            }
            _ => Err(anyhow!(
                "unexpected Paraformer event {event} in {:?}",
                self.phase
            )),
        }
    }
}

fn validate_endpoint(endpoint: &str) -> Result<()> {
    let url = reqwest::Url::parse(endpoint).context("invalid Paraformer endpoint")?;
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("Paraformer endpoint has no host"))?;
    if url.scheme() != "wss"
        || !(host == "dashscope.aliyuncs.com" || host.ends_with(".cn-beijing.maas.aliyuncs.com"))
        || url.path() != "/api-ws/v1/inference"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(anyhow!(
            "Paraformer endpoint must use the official Beijing WSS API"
        ));
    }
    Ok(())
}

/// Validates the encrypted credential against the actual provider handshake
/// and finish flow. The key is only placed in the WebSocket handshake header.
pub async fn test_connection(endpoint: &str, api_key: &str) -> Result<()> {
    validate_endpoint(endpoint)?;
    run_connection_probe(endpoint, api_key).await
}

async fn run_connection_probe(endpoint: &str, api_key: &str) -> Result<()> {
    if api_key.trim().is_empty() {
        return Err(anyhow!("Paraformer API key is empty"));
    }
    let mut request = endpoint.into_client_request()?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {api_key}"))?,
    );
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(10), connect_async(request))
        .await
        .context("Paraformer handshake timed out")??;
    let task_id = format!(
        "{:08x}-{:04x}-4{:03x}-a{:03x}-{:012x}",
        rand::random::<u32>(),
        rand::random::<u16>(),
        rand::random::<u16>() & 0x0fff,
        rand::random::<u16>() & 0x0fff,
        rand::random::<u64>() & 0x0000_ffff_ffff_ffff
    );
    let mut task = ParaformerTask::new(task_id)?;
    socket
        .send(Message::Text(task.run_task().to_string().into()))
        .await?;
    let started = read_event(&mut socket, &mut task).await?;
    if started != ParaformerEvent::Started {
        return Err(anyhow!("Paraformer did not start"));
    }
    // A short silent PCM buffer exercises the required binary audio path.
    socket
        .send(Message::Binary(vec![0_u8; 3_200].into()))
        .await?;
    socket
        .send(Message::Text(task.finish_task()?.to_string().into()))
        .await?;
    loop {
        if read_event(&mut socket, &mut task).await? == ParaformerEvent::Finished {
            break;
        }
    }
    let _ = socket.close(None).await;
    Ok(())
}

async fn read_event(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    task: &mut ParaformerTask,
) -> Result<ParaformerEvent> {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(15), socket.next())
            .await
            .context("Paraformer event timed out")?
            .ok_or_else(|| anyhow!("Paraformer connection closed before task finished"))??;
        match message {
            Message::Text(text) => {
                if let Some(event) = task.accept_event(text.as_str())? {
                    return Ok(event);
                }
            }
            Message::Close(_) => {
                return Err(anyhow!("Paraformer connection closed before task finished"))
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_start_final_timestamp_and_finish() {
        let mut task = ParaformerTask::new("task-1".into()).unwrap();
        assert!(!task.can_send_audio());
        assert!(task.finish_task().is_err());
        assert_eq!(
            task.run_task()["payload"]["model"],
            "paraformer-realtime-v2"
        );
        assert_eq!(
            task.accept_event(
                r#"{"header":{"task_id":"task-1","event":"task-started"},"payload":{}}"#
            )
            .unwrap(),
            Some(ParaformerEvent::Started)
        );
        assert!(task.can_send_audio());
        assert_eq!(task.accept_event(r#"{"header":{"task_id":"task-1","event":"result-generated"},"payload":{"output":{"sentence":{"begin_time":170,"end_time":null,"text":"测试","sentence_end":false}}}}"#).unwrap(), Some(ParaformerEvent::Partial { start_ms: 170, text: "测试".into() }));
        assert_eq!(task.accept_event(r#"{"header":{"task_id":"task-1","event":"result-generated"},"payload":{"output":{"sentence":{"begin_time":170,"end_time":null,"text":"测试。","sentence_end":true,"words":[{"end_time":920}]}}}}"#).unwrap(), Some(ParaformerEvent::Final { provider_key: "task-1:170".into(), start_ms: 170, end_ms: 920, text: "测试。".into() }));
        assert_eq!(
            task.finish_task().unwrap()["header"]["action"],
            "finish-task"
        );
        assert!(!task.can_send_audio());
        assert_eq!(
            task.accept_event(
                r#"{"header":{"task_id":"task-1","event":"task-finished"},"payload":{}}"#
            )
            .unwrap(),
            Some(ParaformerEvent::Finished)
        );
        assert!(task
            .accept_event(r#"{"header":{"task_id":"task-1","event":"task-started"},"payload":{}}"#)
            .is_err());
    }

    #[test]
    fn rejects_other_task_and_failure_without_consuming_audio() {
        let mut task = ParaformerTask::new("task-1".into()).unwrap();
        assert!(task
            .accept_event(r#"{"header":{"task_id":"other","event":"task-started"}}"#)
            .is_err());
        assert!(task.accept_event(r#"{"header":{"task_id":"task-1","event":"task-failed","error_code":"Unauthorized"}}"#).is_err());
        assert!(!task.can_send_audio());
    }

    #[test]
    fn endpoint_rejects_insecure_or_foreign_hosts_before_credentials_are_used() {
        assert!(validate_endpoint("wss://dashscope.aliyuncs.com/api-ws/v1/inference").is_ok());
        assert!(validate_endpoint(
            "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference"
        )
        .is_ok());
        assert!(validate_endpoint("ws://dashscope.aliyuncs.com/api-ws/v1/inference").is_err());
        assert!(
            validate_endpoint("wss://dashscope.aliyuncs.com.evil.test/api-ws/v1/inference")
                .is_err()
        );
    }

    #[tokio::test]
    async fn websocket_probe_waits_for_start_sends_pcm_and_drains_finish() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let run = socket.next().await.unwrap().unwrap().into_text().unwrap();
            let run: Value = serde_json::from_str(&run).unwrap();
            assert_eq!(run["header"]["action"], "run-task");
            let task_id = run["header"]["task_id"].as_str().unwrap();
            socket
                .send(Message::Text(
                    json!({"header": {"task_id": task_id, "event": "task-started"}, "payload": {}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            let audio = socket.next().await.unwrap().unwrap();
            assert_eq!(audio.into_data().len(), 3_200);
            let finish = socket.next().await.unwrap().unwrap().into_text().unwrap();
            let finish: Value = serde_json::from_str(&finish).unwrap();
            assert_eq!(finish["header"]["action"], "finish-task");
            socket.send(Message::Text(json!({"header": {"task_id": task_id, "event": "task-finished"}, "payload": {}}).to_string().into())).await.unwrap();
        });
        run_connection_probe(&endpoint, "test-key").await.unwrap();
        server.await.unwrap();
    }
}
