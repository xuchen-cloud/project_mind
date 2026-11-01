//! Bounded replay of durable gaps. Live capture interrupts replay without losing progress.
use crate::{db::CloudGap, lock_mutex, WorkspaceRuntime};
use anyhow::{anyhow, Result};
use std::{
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

#[derive(Clone)]
pub(crate) struct SavedChunk {
    pub path: std::path::PathBuf,
    pub source: String,
    pub start_sample: u64,
    pub sample_count: u64,
    pub sample_rate: u32,
    pub channels: u16,
}

pub(crate) fn read_mix(chunks: &[SavedChunk], start_ms: u64, end_ms: u64) -> Result<Vec<f32>> {
    if end_ms <= start_ms || end_ms - start_ms > 30_000 {
        return Err(anyhow!("invalid replay interval"));
    }
    let mut mixed = vec![0_f32; ((end_ms - start_ms) * 16) as usize];
    let mut covered = [vec![false; mixed.len()], vec![false; mixed.len()]];
    for (source, name) in ["microphone", "system"].iter().enumerate() {
        let track = chunks
            .iter()
            .filter(|chunk| chunk.source == *name)
            .collect::<Vec<_>>();
        if track.is_empty() {
            return Err(anyhow!("saved audio source manifest is missing"));
        }
        let first = track
            .iter()
            .map(|c| c.start_sample as f64 / c.sample_rate as f64)
            .fold(f64::INFINITY, f64::min);
        let last = track
            .iter()
            .map(|c| (c.start_sample + c.sample_count) as f64 / c.sample_rate as f64)
            .fold(0.0_f64, f64::max);
        for (index, value) in covered[source].iter_mut().enumerate() {
            let time = start_ms as f64 / 1000.0 + index as f64 / 16000.0;
            // A source's known callback lifetime can begin/end between the two
            // tracks. Only that exterior is silence; internal missing data fails.
            *value = time < first || time >= last;
        }
    }
    for chunk in chunks {
        let source = match chunk.source.as_str() {
            "microphone" => 0,
            "system" => 1,
            _ => return Err(anyhow!("unknown saved audio source")),
        };
        if chunk.sample_rate == 0 || chunk.channels == 0 {
            return Err(anyhow!("invalid saved audio format"));
        }
        let start = start_ms * u64::from(chunk.sample_rate) / 1000;
        let end = end_ms * u64::from(chunk.sample_rate) / 1000;
        let first = start.max(chunk.start_sample);
        let last = end.min(chunk.start_sample + chunk.sample_count);
        if first >= last {
            continue;
        }
        let mut file = std::fs::File::open(&chunk.path)?;
        let mut header = [0; 44];
        file.read_exact(&mut header)?;
        if &header[..4] != b"RIFF"
            || &header[8..16] != b"WAVEfmt "
            || header[20..22] != 3_u16.to_le_bytes()
            || header[22..24] != chunk.channels.to_le_bytes()
            || header[24..28] != chunk.sample_rate.to_le_bytes()
            || &header[36..40] != b"data"
        {
            return Err(anyhow!("unsupported saved WAV"));
        }
        let stride = u64::from(chunk.channels) * 4;
        let data_size = chunk
            .sample_count
            .checked_mul(stride)
            .ok_or_else(|| anyhow!("saved WAV size overflow"))?;
        if file.metadata()?.len() != 44 + data_size
            || u64::from(u32::from_le_bytes(header[40..44].try_into().unwrap())) != data_size
        {
            return Err(anyhow!("saved WAV length does not match manifest"));
        }
        file.seek(SeekFrom::Start(44 + (first - chunk.start_sample) * stride))?;
        let mut bytes = vec![0; ((last - first) * stride) as usize];
        file.read_exact(&mut bytes)?;
        let mono: Vec<f32> = bytes
            .chunks_exact(stride as usize)
            .map(|frame| {
                frame
                    .chunks_exact(4)
                    .map(|sample| f32::from_le_bytes(sample.try_into().unwrap()))
                    .sum::<f32>()
                    / f32::from(chunk.channels)
            })
            .collect();
        for (index, output) in mixed.iter_mut().enumerate() {
            let position = (start_ms as f64 / 1000.0 + index as f64 / 16000.0)
                * f64::from(chunk.sample_rate)
                - first as f64;
            if position < 0.0 || position >= mono.len() as f64 {
                continue;
            }
            let left = position as usize;
            let fraction = (position - left as f64) as f32;
            let value = mono[left] + (mono[(left + 1).min(mono.len() - 1)] - mono[left]) * fraction;
            if !value.is_finite() {
                return Err(anyhow!("non-finite saved audio"));
            }
            *output += value;
            covered[source][index] = true;
        }
    }
    if covered.iter().flatten().any(|value| !value) {
        return Err(anyhow!("saved audio source has an uncovered interval"));
    }
    for value in &mut mixed {
        *value = value.clamp(-1.0, 1.0);
    }
    Ok(mixed)
}

pub(crate) fn managed_path(root: &Path, relative: &str) -> Result<std::path::PathBuf> {
    let path = root.join(relative).canonicalize()?;
    if !path.starts_with(root.join(super::storage::VOICE_ASSET_DIR).canonicalize()?) {
        return Err(anyhow!("saved audio escaped voice assets"));
    }
    Ok(path)
}

pub(crate) fn kick(workspace: Arc<WorkspaceRuntime>, handle: tauri::AppHandle) {
    if workspace
        .voice_recovery_running
        .swap(true, Ordering::AcqRel)
    {
        return;
    }
    std::thread::spawn(move || {
        let outcome = recover_one(&workspace, &handle);
        if let Err(error) = outcome {
            eprintln!("voice recovery worker: {error}");
        }
        workspace
            .voice_recovery_running
            .store(false, Ordering::Release);
        super::supervision::wake();
    });
}

fn recover_one(workspace: &WorkspaceRuntime, handle: &tauri::AppHandle) -> Result<()> {
    if workspace.voice_recovery_interrupt.load(Ordering::Acquire) {
        return Ok(());
    }
    let Some(gap) =
        lock_mutex(&workspace.db).voice_cloud_claim(chrono::Utc::now().timestamp_millis())?
    else {
        return Ok(());
    };
    let result = replay(workspace, &gap);
    match result {
        Ok(Some(batch)) => {
            let (result, changes) = {
                use tauri::Manager;
                let state = handle.state::<crate::AppState>();
                let current = lock_mutex(&state.current_workspace);
                if workspace.voice_recovery_interrupt.load(Ordering::Acquire)
                    || !current
                        .as_ref()
                        .is_some_and(|current| current.agent_binding == workspace.agent_binding)
                {
                    lock_mutex(&workspace.db).voice_cloud_release(&gap, None, 0)?;
                    return Ok(());
                }
                let mut db = lock_mutex(&workspace.db);
                crate::committed_changes::capture_native_committed(
                    &workspace.agent_binding,
                    &mut db,
                    "voice-recovery",
                    |db| {
                        db.voice_cloud_commit_state(
                            &gap,
                            batch.end_ms,
                            &batch.results,
                            batch.local_state.as_ref(),
                        )
                    },
                )?
            };
            if let Some(changes) = changes {
                crate::committed_changes::publish_to(handle, changes);
            }
            result?;
            workspace.kick_voice_minutes();
        }
        Ok(None) => lock_mutex(&workspace.db).voice_cloud_release(&gap, None, 0)?,
        Err(error)
            if error.is::<ReplayInterrupted>()
                || workspace.voice_recovery_interrupt.load(Ordering::Acquire) =>
        {
            lock_mutex(&workspace.db).voice_cloud_release(&gap, None, 0)?
        }
        Err(error) => lock_mutex(&workspace.db).voice_cloud_release(
            &gap,
            Some(&error.to_string()),
            chrono::Utc::now().timestamp_millis(),
        )?,
    }
    Ok(())
}

fn replay(workspace: &WorkspaceRuntime, gap: &CloudGap) -> Result<Option<ReplayBatch>> {
    let end = gap
        .end_ms
        .ok_or_else(|| anyhow!("unsealed recovery interval"))?
        .min(gap.cursor_ms + 30_000);
    let (key, chunks) = {
        let db = lock_mutex(&workspace.db);
        (
            if gap.backend == crate::db::RecoveryBackend::Paraformer {
                db.voice_credential_from_ai_profile(gap.credential_profile_id)?
            } else {
                String::new()
            },
            db.voice_cloud_audio(gap)?,
        )
    };
    if gap.backend == crate::db::RecoveryBackend::SenseVoice {
        return replay_local(workspace, gap, &chunks);
    }
    let samples = read_mix(
        &chunks,
        gap.cursor_ms.saturating_sub(gap.epoch_offset_ms),
        end.saturating_sub(gap.epoch_offset_ms),
    )?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        let connection = super::live_paraformer::transcribe_saved(&gap.endpoint, &key, &samples, gap.cursor_ms);
        tokio::pin!(connection);
        let timeout = tokio::time::sleep(Duration::from_secs(90));
        tokio::pin!(timeout);
        loop {
            tokio::select! {
                result = &mut connection => return result.map(|results| Some(ReplayBatch { end_ms: end, results, local_state: None })),
                _ = &mut timeout => return Err(anyhow!("补转写请求超时")),
                _ = tokio::time::sleep(Duration::from_millis(100)) => {
                    if workspace.voice_recovery_interrupt.load(Ordering::Acquire) { return Ok(None); }
                }
            }
        }
    })
}

/// Retain the worker and its result receiver until native inference returns.
/// A timeout invalidates its result, but cannot free its lease for overlapping retry.
#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct LocalReplayState {
    pub scan_ms: u64,
    segmenter: super::recognition::UtteranceSegmenter,
    assembler: super::transcript_assembly::SentenceAssembler,
}

pub(crate) struct ReplayBatch {
    pub end_ms: u64,
    pub results: Vec<super::live_local::TranscriptFinal>,
    pub local_state: Option<LocalReplayState>,
}

fn replay_local(
    workspace: &WorkspaceRuntime,
    gap: &CloudGap,
    chunks: &[SavedChunk],
) -> Result<Option<ReplayBatch>> {
    replay_local_with(
        gap,
        chunks,
        &crate::default_app_data_dir()?,
        &workspace.voice_recovery_interrupt,
    )
}

pub(crate) fn replay_local_with(
    gap: &CloudGap,
    chunks: &[SavedChunk],
    cache: &Path,
    interrupt: &std::sync::atomic::AtomicBool,
) -> Result<Option<ReplayBatch>> {
    use super::{
        recognition::{SegmenterConfig, UtteranceSegmenter, VadFrame},
        transcript_assembly::SentenceAssembler,
    };
    if interrupt.load(Ordering::Acquire) {
        return Ok(None);
    }
    let mut state = match &gap.local_state {
        Some(json) => {
            if json.len() > 5_000_000 {
                return Err(anyhow!("local replay checkpoint exceeds budget"));
            }
            serde_json::from_str::<LocalReplayState>(json)?
        }
        None => LocalReplayState {
            scan_ms: gap.cursor_ms,
            segmenter: UtteranceSegmenter::new(16_000, SegmenterConfig::default())
                .map_err(|error| anyhow!("invalid replay segmenter: {error:?}"))?,
            assembler: SentenceAssembler::new(),
        },
    };
    let limit = gap
        .end_ms
        .ok_or_else(|| anyhow!("unsealed recovery interval"))?;
    if state.scan_ms < gap.cursor_ms || state.scan_ms >= limit {
        return Err(anyhow!("invalid local scan checkpoint"));
    }
    if gap.local_state.is_some()
        && (!state
            .segmenter
            .checkpoint_valid(gap.start_ms * 16, state.scan_ms * 16)
            || !state
                .assembler
                .checkpoint_valid(gap.start_ms * 16, state.scan_ms * 16))
    {
        return Err(anyhow!("invalid bounded local replay checkpoint"));
    }
    let scan_start = state.scan_ms;
    let end = limit.min(scan_start + 30_000);
    let offset = gap.epoch_offset_ms;
    let mut vad = super::fsmn::FsmnSpeechDetector::new()?;
    // Every durable block uses the same bounded VAD warmup, including without
    // restart. The fixed-window detector never requires prefix ASR inference.
    let warm_start = scan_start.saturating_sub(1080).max(gap.start_ms);
    if warm_start < scan_start {
        let warm = read_mix(
            chunks,
            warm_start.saturating_sub(offset),
            scan_start.saturating_sub(offset),
        )?;
        for frame in warm.chunks_exact(480) {
            vad.is_speech(frame)?;
        }
    }
    let samples = read_mix(
        chunks,
        scan_start.saturating_sub(offset),
        end.saturating_sub(offset),
    )?;
    let worker = super::local_asr::LocalAsrWorker::start(cache)?;
    if interrupt.load(Ordering::Acquire) {
        return Ok(None);
    }
    let mut completed = Vec::new();
    for (index, frame) in samples.chunks(480).enumerate() {
        if interrupt.load(Ordering::Acquire) {
            return Ok(None);
        }
        let start_sample = scan_start * 16 + (index * 480) as u64;
        let mut padded = [0.0; 480];
        padded[..frame.len()].copy_from_slice(frame);
        let speech = vad.is_speech(&padded)?;
        let segments = state
            .segmenter
            .push(VadFrame {
                start_sample,
                samples: frame,
                speech,
            })
            .map_err(|error| anyhow!("replay segmentation: {error:?}"))?;
        for segment in segments {
            let result = infer_retained(&worker, segment, interrupt)?;
            if interrupt.load(Ordering::Acquire) {
                return Ok(None);
            }
            completed.extend(state.assembler.push(result));
        }
    }
    state.scan_ms = end;
    if end == limit {
        if let Some(segment) = state.segmenter.flush() {
            completed.extend(
                state
                    .assembler
                    .push(infer_retained(&worker, segment, interrupt)?),
            );
        }
        if let Some(tail) = state.assembler.finish() {
            completed.push(tail);
        }
    }
    if interrupt.load(Ordering::Acquire) {
        return Ok(None);
    }
    let frontier = state
        .segmenter
        .pending_start()
        .into_iter()
        .chain(state.assembler.pending_start())
        .min()
        .map(|sample| sample / 16)
        .unwrap_or(end)
        .max(gap.cursor_ms)
        .min(end);
    let results = completed
        .into_iter()
        .filter(|r| !r.text.trim().is_empty())
        .map(|r| super::live_local::TranscriptFinal {
            provider_key: format!("recovery:{}:{}:{}", gap.id, scan_start, r.start_sample),
            start_ms: r.start_sample / 16,
            end_ms: (r.end_sample / 16).min(end),
            text: r.text,
        })
        .collect();
    Ok(Some(ReplayBatch {
        end_ms: if end == limit { end } else { frontier },
        results,
        local_state: Some(state),
    }))
}

#[derive(Debug)]
struct ReplayInterrupted;
impl std::fmt::Display for ReplayInterrupted {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("local replay interrupted")
    }
}
impl std::error::Error for ReplayInterrupted {}

fn infer_retained(
    worker: &super::local_asr::LocalAsrWorker,
    segment: super::recognition::UtteranceSegment,
    interrupt: &std::sync::atomic::AtomicBool,
) -> Result<super::local_asr::LocalAsrResult> {
    infer_retained_with_timeout(worker, segment, interrupt, Duration::from_secs(90))
}

fn infer_retained_with_timeout(
    worker: &super::local_asr::LocalAsrWorker,
    segment: super::recognition::UtteranceSegment,
    interrupt: &std::sync::atomic::AtomicBool,
    timeout: Duration,
) -> Result<super::local_asr::LocalAsrResult> {
    let answer = worker.submit(segment)?;
    let started = std::time::Instant::now();
    let mut interrupted = false;
    loop {
        interrupted |= interrupt.load(Ordering::Acquire);
        match answer.recv_timeout(Duration::from_millis(100)) {
            Ok(result) => {
                if started.elapsed() >= timeout {
                    return Err(anyhow!("本地补转写请求超时"));
                }
                if interrupted {
                    return Err(anyhow!(ReplayInterrupted));
                }
                return result;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(anyhow!("本地补转写工作线程已退出"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_timeout_and_interruption_retain_work_until_actual_completion() {
        use super::super::{
            local_asr::{LocalAsrResult, LocalAsrWorker},
            recognition::UtteranceSegment,
        };
        use std::sync::atomic::AtomicBool;
        for timeout_case in [false, true] {
            let interrupt = Arc::new(AtomicBool::new(!timeout_case));
            let worker_interrupt = interrupt.clone();
            let worker = LocalAsrWorker::for_test(move |segment| {
                if !timeout_case {
                    worker_interrupt.store(true, Ordering::Release);
                }
                std::thread::sleep(Duration::from_millis(150));
                worker_interrupt.store(false, Ordering::Release);
                std::thread::sleep(Duration::from_millis(50));
                Ok(LocalAsrResult {
                    start_sample: 0,
                    end_sample: segment.end_sample(),
                    text: "synthetic".into(),
                    forced_split: false,
                })
            });
            let started = std::time::Instant::now();
            let error = infer_retained_with_timeout(
                &worker,
                UtteranceSegment {
                    start_sample: 0,
                    samples: vec![0.0; 480],
                    forced_split: false,
                },
                &interrupt,
                if timeout_case {
                    Duration::from_millis(10)
                } else {
                    Duration::from_secs(5)
                },
            )
            .unwrap_err();
            assert!(started.elapsed() >= Duration::from_millis(200));
            assert!(!interrupt.load(Ordering::Acquire));
            if !timeout_case {
                assert!(
                    error.is::<ReplayInterrupted>(),
                    "latched cancellation cannot become a retry failure"
                );
            } else {
                assert!(error.to_string().contains("超时"));
            }
            worker.shutdown_and_wait().unwrap();
        }
    }

    #[test]
    fn checkpoint_preserves_forced_segment_overlap_and_sentence_assembly() {
        fn run(restart: bool) -> Vec<(u64, u64, String)> {
            use super::super::{
                local_asr::LocalAsrResult,
                recognition::{SegmenterConfig, UtteranceSegmenter, VadFrame},
                transcript_assembly::SentenceAssembler,
            };
            let mut state = LocalReplayState {
                scan_ms: 0,
                segmenter: UtteranceSegmenter::new(16_000, SegmenterConfig::default()).unwrap(),
                assembler: SentenceAssembler::new(),
            };
            let mut output = Vec::new();
            for index in 0..1500 {
                let segments = state
                    .segmenter
                    .push(VadFrame {
                        start_sample: index * 480,
                        samples: &[0.2; 480],
                        speech: index < 1200,
                    })
                    .unwrap();
                for segment in segments {
                    output.extend(state.assembler.push(LocalAsrResult {
                        start_sample: segment.start_sample,
                        end_sample: segment.end_sample(),
                        text: format!("continued phrase {}", segment.start_sample),
                        forced_split: segment.forced_split,
                    }));
                }
                if index == 999 {
                    state.scan_ms = 30_000;
                    assert!(state.segmenter.checkpoint_valid(0, 480_000));
                    assert!(state.assembler.checkpoint_valid(0, 480_000));
                    if restart {
                        state =
                            serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
                    }
                }
            }
            if let Some(segment) = state.segmenter.flush() {
                output.extend(state.assembler.push(LocalAsrResult {
                    start_sample: segment.start_sample,
                    end_sample: segment.end_sample(),
                    text: "last phrase".into(),
                    forced_split: segment.forced_split,
                }));
            }
            if let Some(tail) = state.assembler.finish() {
                output.push(tail);
            }
            output
                .into_iter()
                .map(|r| (r.start_sample, r.end_sample, r.text))
                .collect()
        }
        let full = run(false);
        assert!(!full.is_empty());
        assert_eq!(full, run(true));
    }

    #[test]
    fn replay_reads_only_requested_interval_across_chunks() {
        let root = tempfile::tempdir().unwrap();
        let mut chunks = Vec::new();
        for index in 0..2 {
            let path = root.path().join(format!("{index}.wav"));
            let mut bytes = vec![0; 44];
            bytes[..4].copy_from_slice(b"RIFF");
            bytes[8..16].copy_from_slice(b"WAVEfmt ");
            bytes[20..22].copy_from_slice(&3_u16.to_le_bytes());
            bytes[22..24].copy_from_slice(&1_u16.to_le_bytes());
            bytes[24..28].copy_from_slice(&16000_u32.to_le_bytes());
            bytes[36..40].copy_from_slice(b"data");
            bytes[40..44].copy_from_slice(&64000_u32.to_le_bytes());
            for _ in 0..16000 {
                bytes.extend_from_slice(&(0.2 + index as f32 * 0.2).to_le_bytes());
            }
            std::fs::write(&path, bytes).unwrap();
            for source in ["microphone", "system"] {
                chunks.push(SavedChunk {
                    path: path.clone(),
                    source: source.into(),
                    start_sample: index * 16000,
                    sample_count: 16000,
                    sample_rate: 16000,
                    channels: 1,
                });
            }
        }
        let mixed = read_mix(&chunks, 500, 1500).unwrap();
        assert_eq!(mixed.len(), 16000);
        assert!((mixed[0] - 0.4).abs() < 0.0001);
        assert!((mixed[12000] - 0.8).abs() < 0.0001);
        let mut hole = chunks.clone();
        hole[2].start_sample += 1600;
        assert!(
            read_mix(&hole, 500, 1500).is_err(),
            "internal missing audio cannot become recovered silence"
        );
        assert!(
            read_mix(&chunks[..1], 0, 500).is_err(),
            "one source cannot silently replace dual capture"
        );
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&chunks[0].path)
            .unwrap();
        file.set_len(48).unwrap();
        assert!(
            read_mix(&chunks, 0, 500).is_err(),
            "truncated manifest must not advance recovery"
        );
    }
}
