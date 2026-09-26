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
    stop: Option<tokio::sync::oneshot::Sender<()>>,
}

impl LiveParaformerHandle {
    pub fn spawn(
        endpoint: String,
        api_key: String,
        mut microphone: AudioFrameStream,
        mut system: AudioFrameStream,
        epoch_offset_ms: u64,
        preview_enabled: bool,
    ) -> Result<Self> {
        super::paraformer::validate_endpoint(&endpoint)?;
        let (send, results) = mpsc::channel();
        let (stop, shutdown) = tokio::sync::oneshot::channel();
        let preview_enabled = Arc::new(AtomicBool::new(preview_enabled));
        let worker_preview = Arc::clone(&preview_enabled);
        let join = thread::Builder::new()
            .name("voice-paraformer".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()?;
                let outcome = runtime.block_on(async {
                    let connection = run_reconnecting(&endpoint, &api_key, &mut microphone, &mut system,
                        epoch_offset_ms, &send, &worker_preview);
                    tokio::pin!(connection);
                    tokio::select! {
                        result = &mut connection => result,
                        _ = shutdown => tokio::time::timeout(Duration::from_secs(3), &mut connection)
                            .await.context("Paraformer final drain timed out; saved audio retained")?,
                    }
                });
                if let Err(error) = &outcome {
                    let _ = send.send(Err(anyhow!("Paraformer stream failed: {error}")));
                }
                outcome
            })?;
        Ok(Self {
            results,
            join: Some(join),
            preview_enabled,
            stop: Some(stop),
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
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        let joined = self.join.take().expect("joined once").join();
        let mut results: Vec<_> = self.results.try_iter().collect();
        if joined.is_err() {
            results.push(Err(anyhow!("Paraformer thread panicked")));
        }
        results
    }
}

pub(crate) async fn transcribe_saved(
    endpoint: &str,
    api_key: &str,
    samples: &[f32],
    start_ms: u64,
) -> Result<Vec<TranscriptFinal>> {
    use super::capture::{bounded_audio_frames, AudioSource, SourceTimeline};
    if samples.is_empty() || samples.len() > 30 * 16_000 {
        return Err(anyhow!("invalid replay audio length"));
    }
    let count = samples.len().div_ceil(480);
    let (mic, mut microphone) =
        bounded_audio_frames(count).map_err(|error| anyhow!("{error:?}"))?;
    let (sys, mut system) = bounded_audio_frames(count).map_err(|error| anyhow!("{error:?}"))?;
    let mut mic_clock = SourceTimeline::new(AudioSource::Microphone, 0, 0, 16_000, 1)
        .map_err(|error| anyhow!("{error:?}"))?;
    let mut sys_clock = SourceTimeline::new(AudioSource::System, 0, 0, 16_000, 1)
        .map_err(|error| anyhow!("{error:?}"))?;
    // The first stream contains the saved mix; the second is silent.
    for (index, frame) in samples.chunks(480).enumerate() {
        let timestamp = index as u64 * 30_000_000;
        mic.try_push(
            mic_clock
                .stamp(timestamp, frame.to_vec())
                .map_err(|error| anyhow!("{error:?}"))?,
        )
        .map_err(|_| anyhow!("replay queue full"))?;
        sys.try_push(
            sys_clock
                .stamp(timestamp, vec![0.0; frame.len()])
                .map_err(|error| anyhow!("{error:?}"))?,
        )
        .map_err(|_| anyhow!("replay queue full"))?;
    }
    drop(mic);
    drop(sys);
    let (send, receive) = mpsc::channel();
    let mut acknowledged_ms = start_ms;
    run_connection(
        endpoint,
        api_key,
        &mut microphone,
        &mut system,
        start_ms,
        &send,
        &AtomicBool::new(false),
        &mut acknowledged_ms,
    )
    .await?;
    let end_ms = start_ms + samples.len() as u64 / 16;
    let mut results = Vec::new();
    for update in receive.try_iter() {
        if let RecognitionUpdate::Final(mut result) = update? {
            result.end_ms = result.end_ms.min(end_ms);
            if result.start_ms < result.end_ms && !result.text.trim().is_empty() {
                results.push(result);
            }
        }
    }
    results.sort_by_key(|result| (result.start_ms, result.end_ms));
    results.dedup_by(|a, b| a.provider_key == b.provider_key);
    Ok(results)
}

async fn run_reconnecting(
    endpoint: &str,
    api_key: &str,
    microphone: &mut AudioFrameStream,
    system: &mut AudioFrameStream,
    epoch_offset_ms: u64,
    send: &mpsc::Sender<Result<RecognitionUpdate>>,
    preview_enabled: &AtomicBool,
) -> Result<()> {
    let mut acknowledged_ms = epoch_offset_ms;
    for attempt in 0..=5 {
        let result = run_connection(
            endpoint,
            api_key,
            microphone,
            system,
            epoch_offset_ms,
            send,
            preview_enabled,
            &mut acknowledged_ms,
        )
        .await;
        match result {
            Ok(()) => {
                let _ = send.send(Ok(RecognitionUpdate::CloudComplete));
                return Ok(());
            }
            Err(error) => {
                let _ = send.send(Ok(RecognitionUpdate::CloudGap(error.to_string())));
            }
        }
        if attempt == 5 {
            break;
        }
        let backoff = tokio::time::sleep(Duration::from_secs((1_u64 << attempt).min(30)));
        tokio::pin!(backoff);
        // Keep recognition copies bounded while waiting. Raw audio continues to its writers.
        loop {
            tokio::select! {
                _ = &mut backoff => break,
                frame = microphone.next() => if frame.is_none() { return Ok(()); },
                frame = system.next() => if frame.is_none() { return Ok(()); },
            }
        }
    }
    Err(anyhow!("云端重连已达重试上限，音频已保留用于补转写"))
}

async fn run_connection(
    endpoint: &str,
    api_key: &str,
    microphone: &mut AudioFrameStream,
    system: &mut AudioFrameStream,
    epoch_offset_ms: u64,
    send: &mpsc::Sender<Result<RecognitionUpdate>>,
    preview_enabled: &AtomicBool,
    acknowledged_ms: &mut u64,
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
        acknowledged_ms,
    )
    .await
}

async fn next_unacknowledged(
    stream: &mut AudioFrameStream,
    offset_ms: u64,
    acknowledged_ms: u64,
) -> Option<super::capture::AudioFrame> {
    while let Some(frame) = stream.next().await {
        if offset_ms + frame.media_position_ns() / 1_000_000 >= acknowledged_ms {
            return Some(frame);
        }
    }
    None
}

async fn stream_session<S>(
    mut socket: WebSocketStream<S>,
    microphone: &mut AudioFrameStream,
    system: &mut AudioFrameStream,
    epoch_offset_ms: u64,
    send: &mpsc::Sender<Result<RecognitionUpdate>>,
    preview_enabled: &AtomicBool,
    acknowledged_ms: &mut u64,
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
        if accept_message(
            event,
            &mut task,
            epoch_offset_ms,
            send,
            preview_enabled,
            acknowledged_ms,
        )? {
            break;
        }
    }
    let (first_mic, first_system) = tokio::join!(
        next_unacknowledged(microphone, epoch_offset_ms, *acknowledged_ms),
        next_unacknowledged(system, epoch_offset_ms, *acknowledged_ms)
    );
    let first = [first_mic, first_system];
    if first.iter().all(Option::is_none) {
        return Err(anyhow!("no new audio available after reconnect"));
    }
    let base_ns = first
        .iter()
        .flatten()
        .map(|frame| frame.media_position_ns())
        .min()
        .unwrap_or(0);
    let stream_offset_ms = epoch_offset_ms + base_ns / 1_000_000;
    let _ = send.send(Ok(RecognitionUpdate::CloudConnected {
        start_ms: stream_offset_ms,
    }));
    let mut mixer = Mixer::new_at(base_ns.saturating_mul(16_000) / 1_000_000_000);
    let microphone_open = first[0].is_some();
    let system_open = first[1].is_some();
    for frame in first.into_iter().flatten() {
        send_audio(&mut socket, &mut mixer, frame).await?;
    }
    let mut microphone_open = microphone_open;
    let mut system_open = system_open;
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
                accept_message(message, &mut task, stream_offset_ms, send, preview_enabled, acknowledged_ms)?;
            }
        }
    }
    let tail = mixer.finish();
    if !tail.is_empty() {
        let pcm: Vec<u8> = tail
            .into_iter()
            .flat_map(|sample| ((sample * 32767.0) as i16).to_le_bytes())
            .collect();
        socket.send(Message::Binary(pcm.into())).await?;
    }
    socket
        .send(Message::Text(task.finish_task()?.to_string().into()))
        .await?;
    loop {
        let event = tokio::time::timeout(Duration::from_secs(15), socket.next())
            .await
            .context("Paraformer final drain timed out")?
            .ok_or_else(|| anyhow!("Paraformer closed before finish"))??;
        if accept_message(
            event,
            &mut task,
            stream_offset_ms,
            send,
            preview_enabled,
            acknowledged_ms,
        )? {
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
    acknowledged_ms: &mut u64,
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
                provider_key: _,
                start_ms,
                end_ms,
                text,
            }) => {
                send.send(Ok(RecognitionUpdate::Final(TranscriptFinal {
                    provider_key: format!(
                        "cloud:{}:{}",
                        epoch_offset_ms + start_ms,
                        epoch_offset_ms + end_ms
                    ),
                    start_ms: epoch_offset_ms + start_ms,
                    end_ms: epoch_offset_ms + end_ms,
                    text,
                })))
                .map_err(|_| anyhow!("Transcript receiver closed"))?;
                *acknowledged_ms = (*acknowledged_ms).max(epoch_offset_ms + end_ms);
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
            stop: None,
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
    async fn reconnect_skips_audio_already_acknowledged_on_the_original_timeline() {
        let (sink, mut stream) = bounded_audio_frames(3).unwrap();
        let mut timeline = SourceTimeline::new(AudioSource::Microphone, 1, 0, 16_000, 1).unwrap();
        for _ in 0..3 {
            sink.try_push(timeline.stamp(0, vec![0.2; 480]).unwrap())
                .unwrap();
        }
        drop(sink);
        let frame = next_unacknowledged(&mut stream, 1000, 1050).await.unwrap();
        assert_eq!(frame.media_position_ns(), 60_000_000);
        assert!(next_unacknowledged(&mut stream, 1000, 1060).await.is_none());
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
            let tail = socket.next().await.unwrap().unwrap();
            assert_eq!(
                tail.into_data().len(),
                2,
                "the last sample must precede finish-task"
            );
            let finish: Value =
                serde_json::from_str(&socket.next().await.unwrap().unwrap().into_text().unwrap())
                    .unwrap();
            assert_eq!(finish["header"]["action"], "finish-task");
            socket.send(Message::Text(json!({"header": {"task_id": task_id, "event": "task-finished"}, "payload": {}}).to_string().into())).await.unwrap();
        });
        let (mic_sink, mut mic_stream) = bounded_audio_frames(2).unwrap();
        let (system_sink, mut system_stream) = bounded_audio_frames(2).unwrap();
        let mut microphone = SourceTimeline::new(AudioSource::Microphone, 0, 0, 16_000, 1).unwrap();
        let mut system = SourceTimeline::new(AudioSource::System, 0, 0, 16_000, 1).unwrap();
        mic_sink
            .try_push(microphone.stamp(0, vec![0.2; 481]).unwrap())
            .unwrap();
        system_sink
            .try_push(system.stamp(0, vec![0.1; 481]).unwrap())
            .unwrap();
        drop(mic_sink);
        drop(system_sink);
        let (sender, receiver) = mpsc::channel();
        let (socket, _) = connect_async(format!("ws://{address}")).await.unwrap();
        tokio::time::timeout(
            Duration::from_secs(5),
            stream_session(
                socket,
                &mut mic_stream,
                &mut system_stream,
                1_000,
                &sender,
                &AtomicBool::new(true),
                &mut 1_000,
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
