//! Live local recognition consumes copies of the captured tracks. Raw writers
//! retain their own queues and are never modified by mixing or VAD.
use super::fsmn::FsmnSpeechDetector as SpeechDetector;
use super::{
    capture::{AudioFrame, AudioFrameStream, AudioSource},
    local_asr::{LocalAsrResult, LocalAsrWorker},
    recognition::{SegmenterConfig, UtteranceSegment, UtteranceSegmenter, VadFrame},
    transcript_assembly::SentenceAssembler,
};
use anyhow::{anyhow, Result};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
};

const RATE: u64 = 16_000;
const VAD_FRAME: usize = 480;
const MAX_PENDING_FINALS: usize = 8;
const MAX_TRACK_LAG: usize = 3 * RATE as usize;

#[derive(Clone, Debug)]
pub struct TranscriptFinal {
    pub provider_key: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

pub enum RecognitionUpdate {
    Final(TranscriptFinal),
    Partial(String),
    CloudConnected { start_ms: u64 },
    CloudGap(String),
    CloudComplete,
}

fn local_final(result: LocalAsrResult) -> TranscriptFinal {
    TranscriptFinal {
        provider_key: format!("local:{}", result.start_sample),
        start_ms: result.start_sample * 1_000 / RATE,
        end_ms: result.end_sample * 1_000 / RATE,
        text: result.text,
    }
}

pub struct LiveLocalHandle {
    results: mpsc::Receiver<Result<RecognitionUpdate>>,
    join: Option<thread::JoinHandle<Result<()>>>,
    preview_enabled: Arc<AtomicBool>,
}

impl LiveLocalHandle {
    pub fn spawn(
        worker: LocalAsrWorker,
        microphone: AudioFrameStream,
        system: AudioFrameStream,
        epoch_offset_ms: u64,
        preview_enabled: bool,
    ) -> Result<Self> {
        let (send, results) = mpsc::channel();
        let preview_enabled = Arc::new(AtomicBool::new(preview_enabled));
        let worker_preview = Arc::clone(&preview_enabled);
        let join = thread::Builder::new()
            .name("voice-live-local".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()?;
                let result = runtime.block_on(async {
                    let mut pipeline =
                        Pipeline::new(worker, send.clone(), epoch_offset_ms, worker_preview)?;
                    let mut capture = CaptureReader::new(microphone, system);
                    let capture_result: Result<()> = async {
                        loop {
                            let frame = tokio::select! {
                                frame = capture.next([pipeline.mixer.microphone.end(), pipeline.mixer.system.end()]) => frame,
                                _ = tokio::time::sleep(std::time::Duration::from_millis(20)) => {
                                    pipeline.poll()?;
                                    continue;
                                }
                            };
                            match frame {
                                Some(frame) => pipeline.feed(frame)?,
                                None => break,
                            }
                        }
                        Ok(())
                    }.await;
                    match capture_result {
                        Ok(()) => pipeline.finish(),
                        Err(error) => {
                            // Report overload promptly while retaining every
                            // final accepted before the failed input.
                            let _ = send.send(Err(error));
                            pipeline.finish_accepted()
                        }
                    }
                });
                if let Err(error) = &result {
                    let _ = send.send(Err(anyhow!(error.to_string())));
                }
                result
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
        self.results.try_recv().ok()
    }

    pub fn finish(mut self) -> Vec<Result<RecognitionUpdate>> {
        let joined = self.join.take().expect("joined once").join();
        let mut results: Vec<_> = self.results.try_iter().collect();
        if joined.is_err() {
            results.push(Err(anyhow!("local recognition thread panicked")));
        }
        results
    }
}

pub(crate) struct CaptureReader {
    microphone: AudioFrameStream,
    system: AudioFrameStream,
    microphone_open: bool,
    system_open: bool,
}

impl CaptureReader {
    pub(crate) fn new(microphone: AudioFrameStream, system: AudioFrameStream) -> Self {
        Self {
            microphone,
            system,
            microphone_open: true,
            system_open: true,
        }
    }

    pub(crate) async fn next(&mut self, track_ends: [u64; 2]) -> Option<AudioFrame> {
        while self.microphone_open || self.system_open {
            // Native callback sizes differ between tracks. Equal-probability
            // consumption of ready queues can advance one track by seconds
            // while the other track's matching audio is already queued.
            let microphone_first = track_ends[0] <= track_ends[1];
            let (source, frame) = if microphone_first {
                tokio::select! {
                    biased;
                    frame = self.microphone.next(), if self.microphone_open => (AudioSource::Microphone, frame),
                    frame = self.system.next(), if self.system_open => (AudioSource::System, frame),
                }
            } else {
                tokio::select! {
                    biased;
                    frame = self.system.next(), if self.system_open => (AudioSource::System, frame),
                    frame = self.microphone.next(), if self.microphone_open => (AudioSource::Microphone, frame),
                }
            };
            match (source, frame) {
                (_, Some(frame)) => return Some(frame),
                (AudioSource::Microphone, None) => self.microphone_open = false,
                (AudioSource::System, None) => self.system_open = false,
            }
        }
        None
    }
}

pub(crate) struct Track {
    base: u64,
    samples: VecDeque<f32>,
    seen: bool,
}

impl Track {
    pub(crate) fn new() -> Self {
        Self {
            base: 0,
            samples: VecDeque::new(),
            seen: false,
        }
    }
    pub(crate) fn end(&self) -> u64 {
        self.base + self.samples.len() as u64
    }

    pub(crate) fn push(&mut self, frame: AudioFrame) -> Result<()> {
        if frame.sample_rate == 0 || frame.channels == 0 {
            return Err(anyhow!("invalid captured audio format"));
        }
        let channels = usize::from(frame.channels);
        if !frame.samples.len().is_multiple_of(channels) {
            return Err(anyhow!("incomplete captured audio frame"));
        }
        let start = frame.media_position_ns().saturating_mul(RATE) / 1_000_000_000;
        let frames = frame.samples.len() / channels;
        let output_len = (frames as u64 * RATE / u64::from(frame.sample_rate)) as usize;
        let expected = self.end();
        if self.seen && start > expected.saturating_add(1) {
            return Err(anyhow!("recognition input has an audio gap"));
        }
        if start > expected {
            let gap = (start - expected) as usize;
            if gap > MAX_TRACK_LAG {
                return Err(anyhow!("capture track has a timestamp gap"));
            }
            self.samples.extend(std::iter::repeat_n(0.0, gap));
        }
        let skip = self.end().saturating_sub(start) as usize;
        for index in skip..output_len {
            let input = index * frame.sample_rate as usize / RATE as usize;
            let input = input.min(frames.saturating_sub(1));
            let mono = frame.samples[input * channels..(input + 1) * channels]
                .iter()
                .sum::<f32>()
                / channels as f32;
            self.samples.push_back(mono);
        }
        self.seen = true;
        if self.samples.len() > MAX_TRACK_LAG {
            return Err(anyhow!(
                "local recognition cannot keep up with both capture tracks"
            ));
        }
        Ok(())
    }

    pub(crate) fn take_vad_frame(&mut self) -> Option<(u64, Vec<f32>)> {
        if self.samples.len() < VAD_FRAME {
            return None;
        }
        let samples = self.take(VAD_FRAME);
        Some((self.base * 1_000 / RATE, samples))
    }

    fn take(&mut self, count: usize) -> Vec<f32> {
        self.base += count as u64;
        self.samples.drain(..count).collect()
    }
}

pub(crate) struct Mixer {
    microphone: Track,
    system: Track,
    next_sample: u64,
}

impl Mixer {
    pub(crate) fn new() -> Self {
        Self {
            microphone: Track::new(),
            system: Track::new(),
            next_sample: 0,
        }
    }
    pub(crate) fn new_at(start: u64) -> Self {
        let mut mixer = Self::new();
        mixer.microphone.base = start;
        mixer.system.base = start;
        mixer.next_sample = start;
        mixer
    }
    pub(crate) fn finish(&mut self) -> Vec<f32> {
        let count = self.microphone.samples.len().max(self.system.samples.len());
        (0..count)
            .map(|_| {
                (self.microphone.samples.pop_front().unwrap_or(0.0)
                    + self.system.samples.pop_front().unwrap_or(0.0))
                .clamp(-1.0, 1.0)
            })
            .collect()
    }

    pub(crate) fn push(&mut self, frame: AudioFrame) -> Result<Vec<(u64, Vec<f32>)>> {
        match frame.source {
            AudioSource::Microphone => self.microphone.push(frame)?,
            AudioSource::System => self.system.push(frame)?,
        }
        let mut ready = Vec::new();
        while self.microphone.seen
            && self.system.seen
            && self.microphone.samples.len() >= VAD_FRAME
            && self.system.samples.len() >= VAD_FRAME
        {
            let mic = self.microphone.take(VAD_FRAME);
            let system = self.system.take(VAD_FRAME);
            let mixed = mic
                .into_iter()
                .zip(system)
                .map(|(a, b)| (a + b).clamp(-1.0, 1.0))
                .collect();
            ready.push((self.next_sample, mixed));
            self.next_sample += VAD_FRAME as u64;
        }
        Ok(ready)
    }
}

enum InferenceKind {
    Final,
    Preview { generation: u64, end_sample: u64 },
}

struct Inference {
    answer: mpsc::Receiver<Result<LocalAsrResult>>,
    kind: InferenceKind,
    started: std::time::Instant,
}

struct PreviewWork {
    segment: UtteranceSegment,
    generation: u64,
    end_sample: u64,
}

struct Pipeline {
    mixer: Mixer,
    vad: SpeechDetector,
    segmenter: UtteranceSegmenter,
    worker: LocalAsrWorker,
    in_flight: Option<Inference>,
    pending_finals: VecDeque<UtteranceSegment>,
    pending_preview: Option<PreviewWork>,
    preview_generation: u64,
    assembler: SentenceAssembler,
    results: mpsc::Sender<Result<RecognitionUpdate>>,
    epoch_offset_ms: u64,
    last_preview_sample: Option<u64>,
    preview_text: String,
    next_preview_at: std::time::Instant,
    preview_enabled: Arc<AtomicBool>,
}

impl Pipeline {
    fn new(
        worker: LocalAsrWorker,
        results: mpsc::Sender<Result<RecognitionUpdate>>,
        epoch_offset_ms: u64,
        preview_enabled: Arc<AtomicBool>,
    ) -> Result<Self> {
        Ok(Self {
            mixer: Mixer::new(),
            vad: SpeechDetector::new()?,
            segmenter: UtteranceSegmenter::new(RATE as u32, SegmenterConfig::default())
                .map_err(|error| anyhow!("invalid VAD segmenter: {error:?}"))?,
            worker,
            in_flight: None,
            pending_finals: VecDeque::new(),
            pending_preview: None,
            preview_generation: 0,
            assembler: SentenceAssembler::new(),
            results,
            epoch_offset_ms,
            last_preview_sample: None,
            preview_text: String::new(),
            next_preview_at: std::time::Instant::now(),
            preview_enabled,
        })
    }

    fn feed(&mut self, frame: AudioFrame) -> Result<()> {
        self.poll()?;
        for (start_sample, samples) in self.mixer.push(frame)? {
            self.feed_mixed(start_sample, &samples)?;
        }
        Ok(())
    }

    fn feed_mixed(&mut self, start_sample: u64, samples: &[f32]) -> Result<()> {
        let speech = self.vad.is_speech(&samples)?;
        let segments = self
            .segmenter
            .push(VadFrame {
                start_sample,
                samples,
                speech,
            })
            .map_err(|error| anyhow!("local segmentation failed: {error:?}"))?;
        for segment in segments {
            self.submit(segment)?;
        }
        if self.preview_enabled.load(Ordering::Relaxed)
            && std::time::Instant::now() >= self.next_preview_at
        {
            if let Some(preview) = self.segmenter.preview_since(self.last_preview_sample) {
                self.preview(preview)?;
                self.next_preview_at =
                    std::time::Instant::now() + std::time::Duration::from_secs(2);
            }
        }
        Ok(())
    }

    fn submit(&mut self, mut segment: UtteranceSegment) -> Result<()> {
        self.preview_generation += 1;
        self.pending_preview = None;
        self.poll()?;
        if self.pending_finals.len() >= MAX_PENDING_FINALS {
            return Err(anyhow!("local transcription backlog exceeded: final segment queue is full; original source recordings are retained"));
        }
        self.preview_text.clear();
        self.last_preview_sample = None;
        segment.start_sample += self.epoch_offset_ms * RATE / 1_000;
        self.pending_finals.push_back(segment);
        self.dispatch()
    }

    fn preview(&mut self, mut segment: UtteranceSegment) -> Result<()> {
        let end_sample = segment.end_sample();
        segment.start_sample += self.epoch_offset_ms * RATE / 1_000;
        // Keep only the newest preview. Its watermark is based on the last
        // accepted result, so replacing queued work does not skip unheard audio.
        self.pending_preview = Some(PreviewWork {
            segment,
            generation: self.preview_generation,
            end_sample,
        });
        self.dispatch()
    }

    fn dispatch(&mut self) -> Result<()> {
        if self.in_flight.is_some() {
            return Ok(());
        }
        let work = if let Some(segment) = self.pending_finals.pop_front() {
            Some((segment, InferenceKind::Final))
        } else if self.preview_enabled.load(Ordering::Relaxed)
            && std::time::Instant::now() >= self.next_preview_at
        {
            self.pending_preview.take().map(|preview| {
                (
                    preview.segment,
                    InferenceKind::Preview {
                        generation: preview.generation,
                        end_sample: preview.end_sample,
                    },
                )
            })
        } else {
            if !self.preview_enabled.load(Ordering::Relaxed) {
                self.pending_preview = None;
            }
            None
        };
        if let Some((segment, kind)) = work {
            self.in_flight = Some(Inference {
                answer: self.worker.submit(segment)?,
                kind,
                started: std::time::Instant::now(),
            });
        }
        Ok(())
    }

    fn poll(&mut self) -> Result<()> {
        let result = match self.in_flight.as_ref() {
            Some(work) => match work.answer.try_recv() {
                Ok(result) => Some(result),
                Err(mpsc::TryRecvError::Empty) => None,
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err(anyhow!("SenseVoice worker closed"))
                }
            },
            None => None,
        };
        if let Some(result) = result {
            let work = self
                .in_flight
                .take()
                .expect("result has an in-flight request");
            self.accept(work, result)?;
        }
        self.dispatch()
    }

    fn accept(&mut self, work: Inference, result: Result<LocalAsrResult>) -> Result<()> {
        match work.kind {
            InferenceKind::Final => match result {
                Ok(result) => {
                    for sentence in self.assembler.push(result) {
                        self.results
                            .send(Ok(RecognitionUpdate::Final(local_final(sentence))))
                            .map_err(|_| anyhow!("Transcript receiver closed"))?;
                    }
                    if self.preview_enabled.load(Ordering::Relaxed) {
                        self.results
                            .send(Ok(RecognitionUpdate::Partial(
                                self.assembler.preview_text(""),
                            )))
                            .map_err(|_| anyhow!("Transcript receiver closed"))?;
                    }
                }
                Err(error) => self
                    .results
                    .send(Err(error))
                    .map_err(|_| anyhow!("Transcript receiver closed"))?,
            },
            InferenceKind::Preview {
                generation,
                end_sample,
            } => {
                self.next_preview_at = self
                    .next_preview_at
                    .max(std::time::Instant::now() + work.started.elapsed().saturating_mul(3));
                // A finalized utterance invalidates its provisional text.
                if generation == self.preview_generation
                    && self.preview_enabled.load(Ordering::Relaxed)
                {
                    let result = result?;
                    self.last_preview_sample = Some(end_sample);
                    // Queued candidates were cut from the old watermark. A
                    // subsequent audio frame recomputes them from this result.
                    self.pending_preview = None;
                    self.preview_text = super::transcript_assembly::merge_preview_text(
                        &self.preview_text,
                        &result.text,
                    );
                    self.results
                        .send(Ok(RecognitionUpdate::Partial(
                            self.assembler.preview_text(&self.preview_text),
                        )))
                        .map_err(|_| anyhow!("Transcript receiver closed"))?;
                } else if let Err(error) = result {
                    // Invalidating captions does not hide an inference failure.
                    self.results
                        .send(Err(error))
                        .map_err(|_| anyhow!("Transcript receiver closed"))?;
                }
            }
        }
        Ok(())
    }

    fn finish(mut self) -> Result<()> {
        self.preview_enabled.store(false, Ordering::Relaxed);
        self.pending_preview = None;
        self.preview_generation += 1;
        let finalization: Result<()> = (|| {
            let tail_start = self.mixer.next_sample;
            let tail = self.mixer.finish();
            for (index, samples) in tail.chunks(VAD_FRAME).enumerate() {
                let mut padded = samples.to_vec();
                padded.resize(VAD_FRAME, 0.0);
                self.feed_mixed(tail_start + (index * VAD_FRAME) as u64, &padded)?;
            }
            if let Some(segment) = self.segmenter.flush() {
                self.submit(segment)?;
            }
            Ok(())
        })();
        let drained = self.finish_accepted();
        match (finalization, drained) {
            (Ok(()), result) | (result, Ok(())) => result,
            (Err(error), Err(drain_error)) => Err(anyhow!(
                "{error}; draining accepted Transcript also failed: {drain_error}"
            )),
        }
    }

    fn finish_accepted(mut self) -> Result<()> {
        // EOF waits for durable finals, but discards replaceable captions.
        self.preview_generation += 1;
        self.pending_preview = None;
        while self.in_flight.is_some() || !self.pending_finals.is_empty() {
            self.dispatch()?;
            if let Some(work) = self.in_flight.take() {
                let result = work
                    .answer
                    .recv()
                    .map_err(|_| anyhow!("SenseVoice worker closed while draining Transcript"))?;
                self.accept(work, result)?;
            }
        }
        if let Some(sentence) = self.assembler.finish() {
            self.results
                .send(Ok(RecognitionUpdate::Final(local_final(sentence))))
                .map_err(|_| anyhow!("Transcript receiver closed"))?;
        }
        self.results
            .send(Ok(RecognitionUpdate::Partial(String::new())))
            .map_err(|_| anyhow!("Transcript receiver closed"))?;
        self.worker.shutdown_and_wait()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::capture::SourceTimeline;

    fn callback_frames(
        source: AudioSource,
        sample_rate: u32,
        channels: u16,
        start_sample: u64,
        samples: &[f32],
        callback_samples: usize,
    ) -> Vec<AudioFrame> {
        let mut timeline = SourceTimeline::new(source, 1, 0, sample_rate, channels).unwrap();
        let mut consumed = 0;
        samples
            .chunks(callback_samples * usize::from(channels))
            .map(|chunk| {
                let captured_at =
                    (start_sample + consumed) * 1_000_000_000 / u64::from(sample_rate);
                let frame = timeline.stamp(captured_at, chunk.to_vec()).unwrap();
                consumed += (chunk.len() / usize::from(channels)) as u64;
                frame
            })
            .collect()
    }

    fn interleave_callbacks(mut frames: Vec<AudioFrame>) -> Vec<AudioFrame> {
        frames.sort_by_key(|frame| {
            frame.media_position_ns()
                + (frame.samples.len() / usize::from(frame.channels)) as u64 * 1_000_000_000
                    / u64::from(frame.sample_rate)
        });
        frames
    }

    #[test]
    fn slow_recognition_does_not_block_capture_pipeline_and_drains_at_eof() {
        let worker = LocalAsrWorker::for_test(|segment| {
            thread::sleep(std::time::Duration::from_millis(200));
            Ok(LocalAsrResult {
                start_sample: segment.start_sample,
                end_sample: segment.end_sample(),
                text: "保留转写。".into(),
                forced_split: false,
            })
        });
        let (send, results) = mpsc::channel();
        let mut pipeline =
            Pipeline::new(worker, send, 0, Arc::new(AtomicBool::new(false))).unwrap();
        let started = std::time::Instant::now();
        pipeline
            .submit(UtteranceSegment {
                start_sample: 0,
                samples: vec![0.0; 16000],
                forced_split: false,
            })
            .unwrap();
        let elapsed = started.elapsed();
        pipeline.finish().unwrap();
        assert!(
            elapsed < std::time::Duration::from_millis(100),
            "capture blocked for {elapsed:?}"
        );
        let updates = results.try_iter().map(Result::unwrap).collect::<Vec<_>>();
        assert!(updates.iter().any(|update| matches!(update, RecognitionUpdate::Final(result) if result.text == "保留转写。")));
    }

    #[test]
    #[ignore = "requires private float WAV speech fixture; set PROJECT_MIND_TEST_MIC_WAV"]
    fn slow_asr_keeps_live_capture_queues_consuming_and_finishes_transcript() {
        let (rate, channels, samples) = private_speech_fixture(36);
        let mut first = true;
        let (started_send, started_receive) = mpsc::channel();
        let worker = LocalAsrWorker::for_test(move |segment| {
            if first {
                first = false;
                started_send.send(()).unwrap();
                thread::sleep(std::time::Duration::from_secs(6));
            }
            Ok(LocalAsrResult {
                start_sample: segment.start_sample,
                end_sample: segment.end_sample(),
                text: "保留转写。".into(),
                forced_split: segment.forced_split,
            })
        });
        let (mic_send, microphone) = super::super::capture::bounded_audio_frames(256).unwrap();
        let (sys_send, system) = super::super::capture::bounded_audio_frames(256).unwrap();
        let handle = LiveLocalHandle::spawn(worker, microphone, system, 0, true).unwrap();
        let mut mic = SourceTimeline::new(AudioSource::Microphone, 0, 0, rate, channels).unwrap();
        let mut sys = SourceTimeline::new(AudioSource::System, 0, 0, rate, channels).unwrap();
        let mut capture_error = None;
        let mut live_updates = Vec::new();
        let started = std::time::Instant::now();
        for (index, chunk) in samples
            .chunks(rate as usize / 100 * usize::from(channels))
            .enumerate()
        {
            let deadline = started + std::time::Duration::from_millis(index as u64 * 10);
            if let Some(wait) = deadline.checked_duration_since(std::time::Instant::now()) {
                thread::sleep(wait);
            }
            while let Some(update) = handle.try_result() {
                live_updates.push(update);
            }
            // The first utterance can end before its six-second preview
            // finishes. Keep recording through the adaptive cooldown, until
            // a later utterance can publish captions; never weaken that check.
            if index >= 1_200
                && live_updates.iter().any(|update| {
                    matches!(update,
                Ok(RecognitionUpdate::Partial(text)) if !text.is_empty())
                })
            {
                break;
            }
            let captured_at_ns = index as u64 * 10_000_000;
            let mic_frame = mic.stamp(captured_at_ns, chunk.to_vec()).unwrap();
            let sys_frame = sys.stamp(captured_at_ns, vec![0.0; chunk.len()]).unwrap();
            if let Err(error) = mic_send
                .try_push(mic_frame)
                .and_then(|_| sys_send.try_push(sys_frame))
            {
                capture_error = Some(error);
                break;
            }
        }
        drop((mic_send, sys_send));
        let had_live_caption = live_updates.iter().any(
            |update| matches!(update, Ok(RecognitionUpdate::Partial(text)) if !text.is_empty()),
        );
        live_updates.extend(handle.finish());
        let updates = live_updates;
        assert!(
            had_live_caption,
            "slow preview must remain visible while recording is open"
        );
        assert!(
            started_receive.try_recv().is_ok(),
            "fixture must start an ASR task"
        );
        assert!(
            capture_error.is_none(),
            "capture overflowed while ASR was slow: {capture_error:?}"
        );
        let updates = updates.into_iter().map(Result::unwrap).collect::<Vec<_>>();
        let finals = updates
            .iter()
            .filter_map(|update| match update {
                RecognitionUpdate::Final(result) => Some(result),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(
            !finals.is_empty(),
            "EOF must publish the accepted Transcript"
        );
        assert!(
            finals.last().unwrap().end_ms > 8_000,
            "late speech must survive the slow task"
        );
        assert!(finals
            .windows(2)
            .all(|pair| pair[0].start_ms <= pair[1].start_ms));
    }

    #[test]
    fn transcription_overload_preserves_all_accepted_finals_in_order() {
        let (release, wait) = mpsc::channel();
        let mut first = true;
        let worker = LocalAsrWorker::for_test(move |segment| {
            if first {
                first = false;
                wait.recv().unwrap();
            }
            Ok(LocalAsrResult {
                start_sample: segment.start_sample,
                end_sample: segment.end_sample(),
                text: format!("片段{}。", segment.start_sample / RATE),
                forced_split: false,
            })
        });
        let (send, results) = mpsc::channel();
        let mut pipeline =
            Pipeline::new(worker, send, 0, Arc::new(AtomicBool::new(false))).unwrap();
        for index in 0..9 {
            pipeline
                .submit(UtteranceSegment {
                    start_sample: index * RATE,
                    samples: vec![0.0; 160],
                    forced_split: false,
                })
                .unwrap();
        }
        let error = pipeline
            .submit(UtteranceSegment {
                start_sample: 9 * RATE,
                samples: vec![0.0; 160],
                forced_split: false,
            })
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("local transcription backlog exceeded"));
        release.send(()).unwrap();
        pipeline.finish_accepted().unwrap();
        let finals = results
            .try_iter()
            .map(Result::unwrap)
            .filter_map(|update| match update {
                RecognitionUpdate::Final(result) => Some(result.text),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            finals,
            [
                "片段0。",
                "片段1。",
                "片段2。",
                "片段3。",
                "片段4。",
                "片段5。",
                "片段6。",
                "片段7。",
                "片段8。"
            ]
        );
    }

    #[test]
    fn finals_preempt_queued_previews_and_stale_preview_text_is_not_published() {
        let (release, wait) = mpsc::channel();
        let (started, starts) = mpsc::channel();
        let mut first = true;
        let worker = LocalAsrWorker::for_test(move |segment| {
            started.send(segment.start_sample).unwrap();
            if first {
                first = false;
                wait.recv().unwrap();
            }
            Ok(LocalAsrResult {
                start_sample: segment.start_sample,
                end_sample: segment.end_sample(),
                text: if segment.start_sample == 0 {
                    "过期字幕。".into()
                } else {
                    "最终转写。".into()
                },
                forced_split: false,
            })
        });
        let (send, results) = mpsc::channel();
        let mut pipeline = Pipeline::new(worker, send, 0, Arc::new(AtomicBool::new(true))).unwrap();
        pipeline
            .preview(UtteranceSegment {
                start_sample: 0,
                samples: vec![0.0; 160],
                forced_split: false,
            })
            .unwrap();
        assert_eq!(starts.recv().unwrap(), 0);
        pipeline
            .preview(UtteranceSegment {
                start_sample: 160,
                samples: vec![0.0; 160],
                forced_split: false,
            })
            .unwrap();
        pipeline
            .submit(UtteranceSegment {
                start_sample: RATE,
                samples: vec![0.0; 160],
                forced_split: false,
            })
            .unwrap();
        release.send(()).unwrap();
        pipeline.finish().unwrap();
        assert_eq!(starts.try_iter().collect::<Vec<_>>(), [RATE]);
        let updates = results.try_iter().map(Result::unwrap).collect::<Vec<_>>();
        assert!(!updates.iter().any(
            |update| matches!(update, RecognitionUpdate::Partial(text) if text.contains("过期"))
        ));
        assert!(updates.iter().any(|update| matches!(update, RecognitionUpdate::Final(result) if result.text == "最终转写。")));
    }

    #[test]
    fn slow_preview_cooldown_keeps_only_the_latest_pending_preview() {
        let (release, wait) = mpsc::channel();
        let (started, starts) = mpsc::channel();
        let mut first = true;
        let worker = LocalAsrWorker::for_test(move |segment| {
            started.send(segment.start_sample).unwrap();
            if first {
                first = false;
                wait.recv().unwrap();
            }
            Ok(LocalAsrResult {
                start_sample: segment.start_sample,
                end_sample: segment.end_sample(),
                text: format!("字幕{}。", segment.start_sample),
                forced_split: false,
            })
        });
        let (send, results) = mpsc::channel();
        let mut pipeline = Pipeline::new(worker, send, 0, Arc::new(AtomicBool::new(true))).unwrap();
        for start_sample in [0, 160, 320] {
            pipeline
                .preview(UtteranceSegment {
                    start_sample,
                    samples: vec![0.0; 160],
                    forced_split: false,
                })
                .unwrap();
        }
        assert_eq!(starts.recv().unwrap(), 0);
        thread::sleep(std::time::Duration::from_millis(40));
        release.send(()).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while pipeline.in_flight.is_some() {
            pipeline.poll().unwrap();
            assert!(std::time::Instant::now() < deadline);
            thread::sleep(std::time::Duration::from_millis(1));
        }
        assert!(
            starts.try_recv().is_err(),
            "queued preview must respect inference cooldown"
        );
        assert!(results.try_iter().any(|update| matches!(update.unwrap(), RecognitionUpdate::Partial(text) if text == "字幕0。")), "a slower preview must remain publishable within its utterance");
        for start_sample in [480, 640] {
            pipeline
                .preview(UtteranceSegment {
                    start_sample,
                    samples: vec![0.0; 160],
                    forced_split: false,
                })
                .unwrap();
        }
        while starts.try_recv().is_err() {
            pipeline.poll().unwrap();
            assert!(std::time::Instant::now() < deadline);
            thread::sleep(std::time::Duration::from_millis(1));
        }
        while pipeline.in_flight.is_some() {
            pipeline.poll().unwrap();
            assert!(std::time::Instant::now() < deadline);
            thread::sleep(std::time::Duration::from_millis(1));
        }
        assert!(results.try_iter().any(|update| matches!(update.unwrap(), RecognitionUpdate::Partial(text) if text.contains("字幕640。") && !text.contains("字幕480。"))));
        assert!(
            starts.try_recv().is_err(),
            "intermediate preview must be replaced"
        );
        pipeline.finish().unwrap();
    }

    fn private_speech_fixture(seconds: usize) -> (u32, u16, Vec<f32>) {
        let bytes = std::fs::read(std::env::var("PROJECT_MIND_TEST_MIC_WAV").unwrap()).unwrap();
        assert_eq!(&bytes[20..22], &3_u16.to_le_bytes());
        let channels = u16::from_le_bytes(bytes[22..24].try_into().unwrap());
        let rate = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
        let samples = bytes[44..]
            .chunks_exact(4)
            .map(|sample| f32::from_le_bytes(sample.try_into().unwrap()))
            .take(rate as usize * usize::from(channels) * seconds)
            .collect::<Vec<_>>();
        (rate, channels, samples)
    }

    #[test]
    #[ignore = "requires private float WAV speech fixture; set PROJECT_MIND_TEST_MIC_WAV"]
    fn live_input_failure_is_reported_before_slow_accepted_finals_finish() {
        let (rate, channels, samples) = private_speech_fixture(12);
        let (started, starts) = mpsc::channel();
        let mut first = true;
        let worker = LocalAsrWorker::for_test(move |segment| {
            if first {
                first = false;
                started.send(()).unwrap();
                thread::sleep(std::time::Duration::from_secs(6));
            }
            Ok(LocalAsrResult {
                start_sample: segment.start_sample,
                end_sample: segment.end_sample(),
                text: "已接受的转写。".into(),
                forced_split: segment.forced_split,
            })
        });
        let (mic_send, microphone) = super::super::capture::bounded_audio_frames(4096).unwrap();
        let (sys_send, system) = super::super::capture::bounded_audio_frames(4096).unwrap();
        let handle = LiveLocalHandle::spawn(worker, microphone, system, 0, true).unwrap();
        let mut mic = SourceTimeline::new(AudioSource::Microphone, 0, 0, rate, channels).unwrap();
        let mut sys = SourceTimeline::new(AudioSource::System, 0, 0, rate, channels).unwrap();
        for (index, chunk) in samples
            .chunks(rate as usize / 100 * usize::from(channels))
            .enumerate()
        {
            let captured_at_ns = index as u64 * 10_000_000;
            mic_send
                .try_push(mic.stamp(captured_at_ns, chunk.to_vec()).unwrap())
                .unwrap();
            sys_send
                .try_push(sys.stamp(captured_at_ns, vec![0.0; chunk.len()]).unwrap())
                .unwrap();
        }
        let mut invalid = mic
            .stamp(
                12_000_000_000,
                vec![0.0; rate as usize / 100 * usize::from(channels)],
            )
            .unwrap();
        invalid.sample_rate = 0;
        mic_send.try_push(invalid).unwrap();
        starts
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("speech fixture starts slow ASR");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        let mut updates = Vec::new();
        let mut early_error = false;
        while std::time::Instant::now() < deadline && !early_error {
            if let Some(update) = handle.try_result() {
                early_error = update.as_ref().is_err_and(|error| {
                    error.to_string().contains("invalid captured audio format")
                });
                updates.push(update);
            } else {
                thread::sleep(std::time::Duration::from_millis(1));
            }
        }
        drop((mic_send, sys_send));
        updates.extend(handle.finish());
        assert!(
            early_error,
            "input failure must be reported without waiting six seconds for ASR"
        );
        assert_eq!(
            updates.iter().filter(|update| update.is_err()).count(),
            1,
            "do not duplicate the original failure"
        );
        assert!(updates.into_iter().any(|update| matches!(update, Ok(RecognitionUpdate::Final(result)) if result.end_ms > 8_000)), "accepted final speech must be drained after input failure");
    }

    #[test]
    fn native_callback_sizes_and_initial_offsets_remain_contiguous() {
        // Native capture does not deliver 16 kHz VAD-sized callbacks. These
        // fractional conversion boundaries and offsets come from device audio.
        for (sample_rate, microphone_callback) in [(48_000, 512), (48_000, 1024), (44_100, 512)] {
            let microphone = vec![0.25; sample_rate as usize * 4];
            let system = vec![0.0; 48_000 * 4 * 2];
            let mut frames = callback_frames(
                AudioSource::Microphone,
                sample_rate,
                1,
                22195 * u64::from(sample_rate) / 48_000,
                &microphone,
                microphone_callback,
            );
            frames.extend(callback_frames(
                AudioSource::System,
                48_000,
                2,
                14464,
                &system,
                480,
            ));
            let mut mixer = Mixer::new();
            let mut mixed_samples = 0;
            for frame in interleave_callbacks(frames) {
                let position_ms = frame.media_position_ns() / 1_000_000;
                let source = frame.source;
                let ready = mixer.push(frame).unwrap_or_else(|error| {
                    panic!("{sample_rate} Hz, callback {microphone_callback}, {source:?} at {position_ms} ms: {error}")
                });
                mixed_samples += ready.len() * VAD_FRAME;
            }
            mixed_samples += mixer.finish().len();
            assert!(mixed_samples >= RATE as usize * 4);
        }
    }

    #[test]
    fn backlogged_native_callbacks_do_not_exceed_track_lag() {
        let microphone = vec![0.0; 48_000 * 20];
        let system = vec![0.0; 48_000 * 20 * 2];
        let microphone =
            callback_frames(AudioSource::Microphone, 48_000, 1, 22195, &microphone, 1024);
        let system = callback_frames(AudioSource::System, 48_000, 2, 14464, &system, 480);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (mic_send, mic) = super::super::capture::bounded_audio_frames(4096).unwrap();
            let (sys_send, sys) = super::super::capture::bounded_audio_frames(4096).unwrap();
            for frame in microphone {
                mic_send.try_push(frame).unwrap();
            }
            for frame in system {
                sys_send.try_push(frame).unwrap();
            }
            drop(mic_send);
            drop(sys_send);
            let mut mixer = Mixer::new();
            let mut capture = CaptureReader::new(mic, sys);
            while let Some(frame) = capture
                .next([mixer.microphone.end(), mixer.system.end()])
                .await
            {
                let position = frame.media_position_ns() / 1_000_000;
                let source = frame.source;
                mixer.push(frame).unwrap_or_else(|error| {
                    panic!("backlogged {source:?} at {position} ms: {error}")
                });
            }
        });
    }

    #[test]
    fn shared_capture_reader_balances_media_progress_after_each_activity_callback() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (mic_send, mic) = super::super::capture::bounded_audio_frames(1024).unwrap();
            let (sys_send, sys) = super::super::capture::bounded_audio_frames(1024).unwrap();
            for frame in callback_frames(
                AudioSource::Microphone,
                48_000,
                1,
                0,
                &vec![0.0; 48_000 * 4],
                1024,
            ) {
                mic_send.try_push(frame).unwrap();
            }
            for frame in callback_frames(
                AudioSource::System,
                48_000,
                2,
                0,
                &vec![0.0; 48_000 * 4 * 2],
                480,
            ) {
                sys_send.try_push(frame).unwrap();
            }
            drop((mic_send, sys_send));
            let mut capture = CaptureReader::new(mic, sys);
            let mut tracks = [Track::new(), Track::new()];
            while let Some(frame) = capture.next([tracks[0].end(), tracks[1].end()]).await {
                let track = usize::from(frame.source == AudioSource::System);
                tracks[track].push(frame).unwrap();
                // Activity drains its own VAD frames after each callback, so
                // queue fairness must use total media progress, not buffer size.
                while tracks[track].take_vad_frame().is_some() {}
                assert!(
                    tracks[0].end().abs_diff(tracks[1].end()) <= 342,
                    "ready tracks drifted beyond one microphone callback: {:?}",
                    [tracks[0].end(), tracks[1].end()]
                );
            }
            assert!(tracks.iter().all(|track| track.end() >= 63_999));
        });
    }

    #[test]
    fn shared_capture_reader_drains_remaining_source_after_other_source_eof() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (mic_send, mic) = super::super::capture::bounded_audio_frames(256).unwrap();
            let (sys_send, sys) = super::super::capture::bounded_audio_frames(256).unwrap();
            for frame in callback_frames(
                AudioSource::Microphone,
                48_000,
                1,
                0,
                &vec![0.0; 48_000],
                1024,
            ) {
                mic_send.try_push(frame).unwrap();
            }
            for frame in callback_frames(
                AudioSource::System,
                48_000,
                2,
                0,
                &vec![0.0; 48_000 * 2 * 2],
                480,
            ) {
                sys_send.try_push(frame).unwrap();
            }
            drop((mic_send, sys_send));
            let mut capture = CaptureReader::new(mic, sys);
            let mut tracks = [Track::new(), Track::new()];
            let mut callbacks = [0; 2];
            while let Some(frame) = capture.next([tracks[0].end(), tracks[1].end()]).await {
                let track = usize::from(frame.source == AudioSource::System);
                callbacks[track] += 1;
                tracks[track].push(frame).unwrap();
                while tracks[track].take_vad_frame().is_some() {}
            }
            assert_eq!(callbacks, [47, 200]);
            assert!(tracks[0].end() >= 15_999);
            assert!(tracks[1].end() >= 31_999);
        });
    }

    #[test]
    fn missing_capture_track_still_reaches_the_lag_limit() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (mic_send, mic) = super::super::capture::bounded_audio_frames(256).unwrap();
            let (_sys_send, sys) = super::super::capture::bounded_audio_frames(256).unwrap();
            for frame in callback_frames(
                AudioSource::Microphone,
                48_000,
                1,
                0,
                &vec![0.0; 48_000 * 4],
                1024,
            ) {
                mic_send.try_push(frame).unwrap();
            }
            drop(mic_send);
            let mut mixer = Mixer::new();
            let mut capture = CaptureReader::new(mic, sys);
            while let Some(frame) = capture
                .next([mixer.microphone.end(), mixer.system.end()])
                .await
            {
                if let Err(error) = mixer.push(frame) {
                    assert_eq!(
                        error.to_string(),
                        "local recognition cannot keep up with both capture tracks"
                    );
                    return;
                }
            }
            panic!("a missing source must retain the track lag bound");
        });
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires private read-only WAV fixtures and verified model; set PROJECT_MIND_TEST_MIC_WAV, PROJECT_MIND_TEST_SYSTEM_WAV, PROJECT_MIND_TEST_MODEL_DIR"]
    fn replays_saved_native_callbacks_through_live_pipeline() {
        fn read_track(variable: &str, source: AudioSource, callback: usize) -> Vec<AudioFrame> {
            let path = std::path::PathBuf::from(std::env::var(variable).expect(variable));
            let bytes = std::fs::read(&path).unwrap();
            assert_eq!(&bytes[..4], b"RIFF");
            assert_eq!(&bytes[8..16], b"WAVEfmt ");
            assert_eq!(&bytes[20..22], &3_u16.to_le_bytes());
            assert_eq!(&bytes[36..40], b"data");
            let channels = u16::from_le_bytes(bytes[22..24].try_into().unwrap());
            let rate = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
            let start = path
                .file_stem()
                .unwrap()
                .to_str()
                .unwrap()
                .rsplit('-')
                .next()
                .unwrap()
                .parse()
                .unwrap();
            let samples = bytes[44..]
                .chunks_exact(4)
                .map(|value| f32::from_le_bytes(value.try_into().unwrap()))
                .collect::<Vec<_>>();
            callback_frames(source, rate, channels, start, &samples, callback)
        }
        let mut frames = read_track("PROJECT_MIND_TEST_MIC_WAV", AudioSource::Microphone, 1024);
        frames.extend(read_track(
            "PROJECT_MIND_TEST_SYSTEM_WAV",
            AudioSource::System,
            480,
        ));
        let frames = interleave_callbacks(frames);
        let backlogged_frames = frames.clone();
        let mut mixer = Mixer::new();
        for frame in &frames {
            mixer.push(frame.clone()).unwrap_or_else(|error| {
                panic!(
                    "mixer {:?} at {} ms: {error}",
                    frame.source,
                    frame.media_position_ns() / 1_000_000
                )
            });
        }
        eprintln!("Mixer consumed {} native callbacks", frames.len());

        let source =
            std::path::PathBuf::from(std::env::var("PROJECT_MIND_TEST_MODEL_DIR").unwrap());
        let cache = tempfile::tempdir().unwrap();
        let models = cache.path().join("voice-models");
        std::fs::create_dir(&models).unwrap();
        std::os::unix::fs::symlink(
            &source,
            models.join(super::super::model_package::PACKAGE_ID),
        )
        .unwrap();
        let worker = LocalAsrWorker::start(cache.path()).unwrap();
        let (send, results) = mpsc::channel();
        let mut pipeline = Pipeline::new(worker, send, 0, Arc::new(AtomicBool::new(true))).unwrap();
        let mut final_count = 0;
        let mut final_end_ms = 0;
        let mut partial_count = 0;
        let started = std::time::Instant::now();
        for frame in frames {
            let position = frame.media_position_ns() / 1_000_000;
            pipeline
                .feed(frame)
                .unwrap_or_else(|error| panic!("pipeline at {position} ms: {error}"));
            for result in results.try_iter() {
                match result.unwrap() {
                    RecognitionUpdate::Final(result) => {
                        final_count += 1;
                        final_end_ms = final_end_ms.max(result.end_ms);
                    }
                    RecognitionUpdate::Partial(text) if !text.is_empty() => partial_count += 1,
                    _ => (),
                }
            }
        }
        pipeline.finish().unwrap();
        for result in results.try_iter() {
            if let RecognitionUpdate::Final(result) = result.unwrap() {
                final_count += 1;
                final_end_ms = final_end_ms.max(result.end_ms);
            }
        }
        eprintln!(
            "Pipeline finished in {:?}; final count {final_count}, partial count {partial_count}",
            started.elapsed()
        );
        assert!(
            final_count > 0,
            "recorded speech must produce durable final results"
        );
        assert!(final_end_ms > 20_000, "recognition stopped before sustained recorded speech ended: final end {final_end_ms} ms");

        // Both queues can be ready while synchronous preview inference runs.
        // Exercise the product consumer rather than only ordered Pipeline::feed.
        let (mic_send, microphone) = super::super::capture::bounded_audio_frames(4096).unwrap();
        let (sys_send, system) = super::super::capture::bounded_audio_frames(4096).unwrap();
        for frame in backlogged_frames {
            match frame.source {
                AudioSource::Microphone => mic_send.try_push(frame).unwrap(),
                AudioSource::System => sys_send.try_push(frame).unwrap(),
            }
        }
        drop(mic_send);
        drop(sys_send);
        let handle = LiveLocalHandle::spawn(
            LocalAsrWorker::start(cache.path()).unwrap(),
            microphone,
            system,
            0,
            true,
        )
        .unwrap();
        let mut live_final_end_ms = 0;
        for update in handle.finish() {
            match update.unwrap_or_else(|error| panic!("backlogged live handle: {error}")) {
                RecognitionUpdate::Final(result) => {
                    live_final_end_ms = live_final_end_ms.max(result.end_ms)
                }
                _ => (),
            }
        }
        assert!(
            live_final_end_ms > 20_000,
            "backlogged live recognition stopped at {live_final_end_ms} ms"
        );
    }

    #[test]
    fn quiet_clicks_do_not_reach_preview_or_transcription() {
        for (spacing, offset) in [(7, 0), (20, 0), (40, 0), (7, 100), (7, 430)] {
            let mut detector = SpeechDetector::new().unwrap();
            let mut segmenter =
                UtteranceSegmenter::new(RATE as u32, SegmenterConfig::default()).unwrap();
            let mut seed = 17_u32;
            for frame in 0..400 {
                let samples = (0..VAD_FRAME)
                    .map(|index| {
                        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                        let noise = (seed as i32 as f32) / i32::MAX as f32;
                        let position = (frame * VAD_FRAME + index + spacing * VAD_FRAME - offset)
                            % (spacing * VAD_FRAME);
                        let click = if position < 128 {
                            0.04 * (1.0 - position as f32 / 128.0)
                        } else {
                            0.0
                        };
                        noise * (0.00005 + click)
                    })
                    .collect::<Vec<_>>();
                let speech = detector.is_speech(&samples).unwrap();
                let segments = segmenter
                    .push(VadFrame {
                        start_sample: (frame * VAD_FRAME) as u64,
                        samples: &samples,
                        speech,
                    })
                    .unwrap();
                assert!(
                    segments.is_empty(),
                    "click spacing {spacing}, frame {frame}"
                );
                assert!(
                    segmenter.preview().is_none(),
                    "click preview at frame {frame}"
                );
            }
            assert!(segmenter.flush().is_none());
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "requires verified external SenseVoice package and zh.wav; set PROJECT_MIND_TEST_MODEL_DIR"]
    fn live_mixed_capture_generates_chinese_transcript() {
        use sherpa_onnx::Wave;
        let source =
            std::path::PathBuf::from(std::env::var("PROJECT_MIND_TEST_MODEL_DIR").unwrap());
        let cache = tempfile::tempdir().unwrap();
        let models = cache.path().join("voice-models");
        std::fs::create_dir(&models).unwrap();
        std::os::unix::fs::symlink(
            &source,
            models.join(super::super::model_package::PACKAGE_ID),
        )
        .unwrap();
        let wave = Wave::read(source.join("test_wavs/zh.wav").to_str().unwrap()).unwrap();
        // Include quiet speech so noise suppression cannot pass by muting input.
        for (preview_enabled, gain) in [(true, 1.0), (false, 1.0), (true, 0.05)] {
            let worker = LocalAsrWorker::start(cache.path()).unwrap();
            let (send, results) = mpsc::channel();
            let mut pipeline =
                Pipeline::new(worker, send, 0, Arc::new(AtomicBool::new(preview_enabled))).unwrap();
            let mut mic = SourceTimeline::new(AudioSource::Microphone, 0, 0, 16_000, 1).unwrap();
            let mut system = SourceTimeline::new(AudioSource::System, 0, 0, 16_000, 1).unwrap();
            for chunk in wave.samples().chunks(VAD_FRAME) {
                let microphone = mic
                    .stamp(0, chunk.iter().map(|sample| sample * gain).collect())
                    .unwrap();
                let speaker = system.stamp(0, vec![0.0; chunk.len()]).unwrap();
                pipeline.feed(microphone).unwrap();
                pipeline.feed(speaker).unwrap();
            }
            pipeline.finish().unwrap();
            let updates = results.try_iter().map(Result::unwrap).collect::<Vec<_>>();
            // Offline replay can reach EOF before provisional inference
            // completes. Disabled captions must still remain disabled.
            if !preview_enabled {
                assert!(!updates.iter().any(
                    |update| matches!(update, RecognitionUpdate::Partial(text) if !text.is_empty())
                ));
            }
            let transcript = updates
                .into_iter()
                .filter_map(|result| match result {
                    RecognitionUpdate::Final(result) => Some(result.text),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("");
            assert!(
                transcript.contains("时间") && transcript.contains("早上9点至下午5点"),
                "gain {gain}: {transcript}"
            );
        }
    }

    #[test]
    fn aligns_two_tracks_before_mixing_without_mutating_original_frames() {
        let mut mixer = Mixer::new();
        let mut mic = SourceTimeline::new(AudioSource::Microphone, 0, 0, 16_000, 1).unwrap();
        let mut system = SourceTimeline::new(AudioSource::System, 0, 0, 16_000, 1).unwrap();
        let microphone = mic.stamp(0, vec![0.25; VAD_FRAME]).unwrap();
        let system_audio = system.stamp(0, vec![0.5; VAD_FRAME]).unwrap();
        assert_eq!(mixer.push(microphone).unwrap().len(), 0);
        let ready = mixer.push(system_audio).unwrap();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].0, 0);
        assert!(ready[0]
            .1
            .iter()
            .all(|sample| (*sample - 0.75).abs() < 1e-6));
    }
}
