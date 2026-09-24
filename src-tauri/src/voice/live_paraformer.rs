//! Paraformer streaming transport for the mixed 16 kHz recognition branch.
use super::{
    capture::AudioFrameStream,
    live_local::{Mixer, RecognitionUpdate, TranscriptFinal},
    paraformer::{ParaformerEvent, ParaformerTask},
};
use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, Message},
    WebSocketStream,
};

pub struct LiveParaformerHandle {
    results: mpsc::Receiver<Result<RecognitionUpdate>>,
    join: Option<thread::JoinHandle<Result<()>>>,
    preview_enabled: Arc<AtomicBool>,
}

impl LiveParaformerHandle {
    pub fn spawn(
        endpoint: String,
        api_key: String,
        microphone: AudioFrameStream,
        system: AudioFrameStream,
        epoch_offset_ms: u64,
        preview_enabled: bool,
    ) -> Result<Self> {
        let (send, results) = mpsc::channel();
        let preview_enabled = Arc::new(AtomicBool::new(preview_enabled));
        let worker_preview = Arc::clone(&preview_enabled);
        let join = thread::Builder::new()
            .name("voice-paraformer".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()?;
                let outcome = runtime.block_on(run_connection(
                    &endpoint,
                    &api_key,
                    microphone,
                    system,
                    epoch_offset_ms,
                    &send,
                    &worker_preview,
                ));
                if let Err(error) = &outcome {
                    let _ = send.send(Err(anyhow!("Paraformer stream failed: {error}")));
                }
                outcome
            })?;
        Ok(Self {
            results,
            join: Some(join),
            preview_enabled,
        })
    }

    pub fn set_preview_enabled(&self, enabled: bool) {
        self.preview_enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn try_result(&self) -> Option<Result<RecognitionUpdate>> {
        while let Ok(result) = self.results.try_recv() {
            if matches!(result, Ok(RecognitionUpdate::Partial(_)))
                && !self.preview_enabled.load(Ordering::Relaxed)
            {
                continue;
            }
            return Some(result);
        }
        None
    }

    pub fn finish(mut self) -> Vec<Result<RecognitionUpdate>> {
        let joined = self.join.take().expect("joined once").join();
        let mut results: Vec<_> = self.results.try_iter().collect();
        if joined.is_err() {
            results.push(Err(anyhow!("Paraformer thread panicked")));
        }
        results
    }
}

async fn run_connection(
    endpoint: &str,
    api_key: &str,
    microphone: AudioFrameStream,
    system: AudioFrameStream,
    epoch_offset_ms: u64,
    send: &mpsc::Sender<Result<RecognitionUpdate>>,
    preview_enabled: &AtomicBool,
) -> Result<()> {
    super::paraformer::validate_endpoint(endpoint)?;
    if api_key.trim().is_empty() {
        return Err(anyhow!("Paraformer API key is empty"));
    }
    let mut request = endpoint.into_client_request()?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {api_key}"))?,
    );
    let (socket, _) = tokio::time::timeout(Duration::from_secs(10), connect_async(request))
        .await
        .context("Paraformer handshake timed out")??;
    stream_session(
        socket,
        microphone,
        system,
        epoch_offset_ms,
        send,
        preview_enabled,
    )
    .await
}

async fn stream_session<S>(
    mut socket: WebSocketStream<S>,
    mut microphone: AudioFrameStream,
    mut system: AudioFrameStream,
    epoch_offset_ms: u64,
    send: &mpsc::Sender<Result<RecognitionUpdate>>,
    preview_enabled: &AtomicBool,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let task_id = format!("{:032x}", rand::random::<u128>());
    let mut task = ParaformerTask::new(task_id)?;
    socket
        .send(Message::Text(task.run_task().to_string().into()))
        .await?;
    loop {
        let event = tokio::time::timeout(Duration::from_secs(15), socket.next())
            .await
            .context("Paraformer start timed out")?
            .ok_or_else(|| anyhow!("Paraformer closed before start"))??;
        if accept_message(event, &mut task, epoch_offset_ms, send, preview_enabled)? {
            break;
        }
    }
    let mut mixer = Mixer::new();
    let mut microphone_open = true;
    let mut system_open = true;
    while microphone_open || system_open {
        tokio::select! {
            frame = microphone.next(), if microphone_open => match frame {
                Some(frame) => send_audio(&mut socket, &mut mixer, frame).await?,
                None => microphone_open = false,
            },
            frame = system.next(), if system_open => match frame {
                Some(frame) => send_audio(&mut socket, &mut mixer, frame).await?,
                None => system_open = false,
            },
            event = socket.next() => {
                let message = event.ok_or_else(|| anyhow!("Paraformer stream disconnected"))??;
                accept_message(message, &mut task, epoch_offset_ms, send, preview_enabled)?;
            }
        }
    }
    socket
        .send(Message::Text(task.finish_task()?.to_string().into()))
        .await?;
    loop {
        let event = tokio::time::timeout(Duration::from_secs(15), socket.next())
            .await
            .context("Paraformer final drain timed out")?
            .ok_or_else(|| anyhow!("Paraformer closed before finish"))??;
        if accept_message(event, &mut task, epoch_offset_ms, send, preview_enabled)? {
            break;
        }
    }
    let _ = socket.close(None).await;
    Ok(())
}

async fn send_audio<S>(
    socket: &mut WebSocketStream<S>,
    mixer: &mut Mixer,
    frame: super::capture::AudioFrame,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    for (_, samples) in mixer.push(frame)? {
        let mut pcm = Vec::with_capacity(samples.len() * 2);
        for sample in samples {
            pcm.extend_from_slice(&((sample * 32767.0) as i16).to_le_bytes());
        }
        socket.send(Message::Binary(pcm.into())).await?;
    }
    Ok(())
}

/// Returns true on the protocol's started or finished event.
fn accept_message(
    message: Message,
    task: &mut ParaformerTask,
    epoch_offset_ms: u64,
    send: &mpsc::Sender<Result<RecognitionUpdate>>,
    preview_enabled: &AtomicBool,
) -> Result<bool> {
    match message {
        Message::Text(text) => match task.accept_event(text.as_str())? {
            Some(ParaformerEvent::Started | ParaformerEvent::Finished) => Ok(true),
            Some(ParaformerEvent::Partial { text, .. }) => {
                if preview_enabled.load(Ordering::Relaxed) {
                    send.send(Ok(RecognitionUpdate::Partial(text)))
                        .map_err(|_| anyhow!("Transcript receiver closed"))?;
                }
                Ok(false)
            }
            Some(ParaformerEvent::Final {
                provider_key,
                start_ms,
                end_ms,
                text,
            }) => {
                send.send(Ok(RecognitionUpdate::Final(TranscriptFinal {
                    provider_key: format!("cloud:{provider_key}"),
                    start_ms: epoch_offset_ms + start_ms,
                    end_ms: epoch_offset_ms + end_ms,
                    text,
                })))
                .map_err(|_| anyhow!("Transcript receiver closed"))?;
                if preview_enabled.load(Ordering::Relaxed) {
                    send.send(Ok(RecognitionUpdate::Partial(String::new())))
                        .map_err(|_| anyhow!("Transcript receiver closed"))?;
                }
                Ok(false)
            }
            None => Ok(false),
        },
        Message::Close(_) => Err(anyhow!("Paraformer closed before task completed")),
        _ => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::capture::{bounded_audio_frames, AudioSource, SourceTimeline};
    use serde_json::{json, Value};

    #[test]
    fn preview_switch_hides_only_cloud_interim_results() {
        let (sender, results) = mpsc::channel();
        let handle = LiveParaformerHandle {
            results,
            join: None,
            preview_enabled: Arc::new(AtomicBool::new(false)),
        };
        sender
            .send(Ok(RecognitionUpdate::Partial("临时".into())))
            .unwrap();
        sender
            .send(Ok(RecognitionUpdate::Final(TranscriptFinal {
                provider_key: "cloud:one".into(),
                start_ms: 0,
                end_ms: 500,
                text: "正式。".into(),
            })))
            .unwrap();
        assert!(
            matches!(handle.try_result(), Some(Ok(RecognitionUpdate::Final(final_result))) if final_result.text == "正式。")
        );
        handle.set_preview_enabled(true);
        sender
            .send(Ok(RecognitionUpdate::Partial("新的临时字幕".into())))
            .unwrap();
        assert!(
            matches!(handle.try_result(), Some(Ok(RecognitionUpdate::Partial(text))) if text == "新的临时字幕")
        );
    }

    #[tokio::test]
    async fn streamed_pcm_produces_interim_and_final_transcript() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let run: Value =
                serde_json::from_str(&socket.next().await.unwrap().unwrap().into_text().unwrap())
                    .unwrap();
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
            let pcm = socket.next().await.unwrap().unwrap();
            assert!(pcm.is_binary());
            assert_eq!(pcm.into_data().len(), 960);
            socket.send(Message::Text(json!({"header": {"task_id": task_id, "event": "result-generated"}, "payload": {"output": {"sentence": {"begin_time": 0, "end_time": null, "text": "你好", "sentence_end": false}}}}).to_string().into())).await.unwrap();
            socket.send(Message::Text(json!({"header": {"task_id": task_id, "event": "result-generated"}, "payload": {"output": {"sentence": {"begin_time": 0, "end_time": 500, "text": "你好。", "sentence_end": true}}}}).to_string().into())).await.unwrap();
            let finish: Value =
                serde_json::from_str(&socket.next().await.unwrap().unwrap().into_text().unwrap())
                    .unwrap();
            assert_eq!(finish["header"]["action"], "finish-task");
            socket.send(Message::Text(json!({"header": {"task_id": task_id, "event": "task-finished"}, "payload": {}}).to_string().into())).await.unwrap();
        });
        let (mic_sink, mic_stream) = bounded_audio_frames(2).unwrap();
        let (system_sink, system_stream) = bounded_audio_frames(2).unwrap();
        let mut microphone = SourceTimeline::new(AudioSource::Microphone, 0, 0, 16_000, 1).unwrap();
        let mut system = SourceTimeline::new(AudioSource::System, 0, 0, 16_000, 1).unwrap();
        mic_sink
            .try_push(microphone.stamp(0, vec![0.2; 480]).unwrap())
            .unwrap();
        system_sink
            .try_push(system.stamp(0, vec![0.1; 480]).unwrap())
            .unwrap();
        drop(mic_sink);
        drop(system_sink);
        let (sender, receiver) = mpsc::channel();
        let (socket, _) = connect_async(format!("ws://{address}")).await.unwrap();
        tokio::time::timeout(
            Duration::from_secs(5),
            stream_session(
                socket,
                mic_stream,
                system_stream,
                1_000,
                &sender,
                &AtomicBool::new(true),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        server.await.unwrap();
        let results: Vec<_> = receiver.try_iter().map(Result::unwrap).collect();
        assert!(results
            .iter()
            .any(|result| matches!(result, RecognitionUpdate::Partial(text) if text == "你好")));
        assert!(results.iter().any(|result| matches!(result, RecognitionUpdate::Final(final_result) if final_result.text == "你好。" && final_result.start_ms == 1_000 && final_result.end_ms == 1_500)));
    }
}
