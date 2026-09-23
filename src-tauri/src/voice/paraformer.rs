//! Paraformer realtime-v2 event contract. Transport must enforce this gate
//! before sending PCM and must persist Final events by provider key.
use anyhow::{anyhow, Result};
use serde_json::{json, Value};

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
}
