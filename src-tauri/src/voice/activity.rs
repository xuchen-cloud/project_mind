//! Voice activity is observed independently on the two original source tracks.
use super::{
    capture::{AudioFrame, AudioFrameStream, AudioSource},
    fsmn::FsmnSpeechDetector,
    live_local::{CaptureReader, Track},
};
use anyhow::{anyhow, Result};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
};

pub struct ActivityHandle {
    silent: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    join: thread::JoinHandle<Result<()>>,
}

impl ActivityHandle {
    pub fn spawn(microphone: AudioFrameStream, system: AudioFrameStream) -> Result<Self> {
        let mut detectors = [FsmnSpeechDetector::new()?, FsmnSpeechDetector::new()?];
        let silent = Arc::new(AtomicBool::new(false));
        let failed = Arc::new(AtomicBool::new(false));
        let result_silent = silent.clone();
        let result_failed = failed.clone();
        let join = thread::Builder::new()
            .name("voice-activity".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread().build()?;
                let result = runtime.block_on(async {
                    let mut tracks = [Track::new(), Track::new()];
                    let mut activity = SpeechActivity::default();
                    let mut capture = CaptureReader::new(microphone, system);
                    while let Some(frame) = capture.next([tracks[0].end(), tracks[1].end()]).await {
                        observe_frame(&mut tracks, &mut detectors, &mut activity, frame)?;
                        result_silent.store(activity.should_pause(), Ordering::Relaxed);
                    }
                    Ok(())
                });
                result_failed.store(result.is_err(), Ordering::Relaxed);
                result
            })?;
        Ok(Self {
            silent,
            failed,
            join,
        })
    }
    pub fn should_pause(&self) -> bool {
        self.silent.load(Ordering::Relaxed)
    }
    pub fn failed(&self) -> bool {
        self.failed.load(Ordering::Relaxed)
    }
    pub fn finish(self) -> Result<()> {
        self.join
            .join()
            .map_err(|_| anyhow!("voice activity worker panicked"))?
    }
}

fn observe_frame(
    tracks: &mut [Track; 2],
    detectors: &mut [FsmnSpeechDetector; 2],
    activity: &mut SpeechActivity,
    frame: AudioFrame,
) -> Result<()> {
    let track = if frame.source == AudioSource::Microphone {
        0
    } else {
        1
    };
    tracks[track].push(frame)?;
    while let Some((end_ms, samples)) = tracks[track].take_vad_frame() {
        activity.observe(track, end_ms, detectors[track].is_speech(&samples)?);
    }
    Ok(())
}

#[derive(Default)]
pub struct SpeechActivity {
    observed_ms: [u64; 2],
    last_speech_ms: [u64; 2],
}

impl SpeechActivity {
    pub fn observe(&mut self, track: usize, end_ms: u64, speech: bool) {
        self.observed_ms[track] = self.observed_ms[track].max(end_ms);
        if speech {
            self.last_speech_ms[track] = self.last_speech_ms[track].max(end_ms);
        }
    }
    pub fn should_pause(&self) -> bool {
        self.observed_ms
            .iter()
            .copied()
            .min()
            .unwrap_or(0)
            .saturating_sub(self.last_speech_ms.iter().copied().max().unwrap_or(0))
            >= 300_000
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ReplayTrack {
        source: AudioSource,
        rate: u32,
        channels: u16,
        start: u64,
        samples: Vec<f32>,
    }

    fn read_replay_track(variable: &str, source: AudioSource) -> ReplayTrack {
        let path = std::path::PathBuf::from(std::env::var(variable).expect(variable));
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(&bytes[8..16], b"WAVEfmt ");
        assert_eq!(&bytes[20..22], &3_u16.to_le_bytes());
        assert_eq!(&bytes[36..40], b"data");
        ReplayTrack {
            source,
            rate: u32::from_le_bytes(bytes[24..28].try_into().unwrap()),
            channels: u16::from_le_bytes(bytes[22..24].try_into().unwrap()),
            start: path
                .file_stem()
                .unwrap()
                .to_str()
                .unwrap()
                .rsplit('-')
                .next()
                .unwrap()
                .parse()
                .unwrap_or(0),
            samples: bytes[44..]
                .chunks_exact(4)
                .map(|value| f32::from_le_bytes(value.try_into().unwrap()))
                .collect(),
        }
    }

    fn replay_setting(name: &str, default: usize) -> usize {
        let value = std::env::var(name)
            .map(|value| value.parse::<usize>().unwrap())
            .unwrap_or(default);
        assert!(value > 0, "{name} must be positive");
        value
    }

    #[test]
    #[ignore = "read-only private WAV performance measurement; set PROJECT_MIND_TEST_MIC_WAV and PROJECT_MIND_TEST_SYSTEM_WAV"]
    fn measures_saved_audio_fsmn_throughput() {
        for track in [
            read_replay_track("PROJECT_MIND_TEST_MIC_WAV", AudioSource::Microphone),
            read_replay_track("PROJECT_MIND_TEST_SYSTEM_WAV", AudioSource::System),
        ] {
            assert_eq!(track.rate, 48_000);
            let channels = usize::from(track.channels);
            let mono: Vec<f32> = track
                .samples
                .chunks_exact(channels)
                .take(15 * track.rate as usize)
                .step_by(3)
                .map(|frame| frame.iter().sum::<f32>() / channels as f32)
                .collect();
            let mut detector = FsmnSpeechDetector::new().unwrap();
            let mut timings = Vec::new();
            let mut active = 0;
            let mut supported = 0;
            let started = std::time::Instant::now();
            for frame in mono.chunks_exact(480) {
                supported += usize::from(
                    frame
                        .chunks_exact(160)
                        .filter(|chunk| {
                            chunk.iter().map(|v| v * v).sum::<f32>() / 160.0 >= 0.0005_f32.powi(2)
                        })
                        .count()
                        >= 2,
                );
                let before = std::time::Instant::now();
                active += usize::from(detector.is_speech(frame).unwrap());
                timings.push(before.elapsed().as_secs_f64() * 1000.0);
            }
            let elapsed = started.elapsed().as_secs_f64();
            timings.sort_by(f64::total_cmp);
            eprintln!("ACTIVITY_PERF source={:?} audio_s={:.3} frames={} supported={} active={} wall_s={elapsed:.3} rtf={:.3} frame_ms_min={:.3} p50={:.3} p95={:.3} max={:.3}", track.source, mono.len() as f64 / 16_000.0, timings.len(), supported, active, elapsed / (mono.len() as f64 / 16_000.0), timings[0], timings[timings.len()/2], timings[timings.len()*95/100], timings[timings.len()-1]);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "read-only private WAV real-time activity and ASR replay; set PROJECT_MIND_TEST_MIC_WAV, PROJECT_MIND_TEST_SYSTEM_WAV, PROJECT_MIND_TEST_MODEL_DIR"]
    fn replays_saved_audio_activity_with_live_local_at_capture_rate() {
        use crate::voice::{
            capture::{bounded_audio_frames, SourceTimeline},
            live_local::{LiveLocalHandle, RecognitionUpdate},
            local_asr::LocalAsrWorker,
        };
        use sha2::{Digest, Sha256};
        let queue_capacity = replay_setting("PROJECT_MIND_TEST_QUEUE_CAPACITY", 1024);
        let mic_callback = replay_setting("PROJECT_MIND_TEST_MIC_CALLBACK", 1024);
        let system_callback = replay_setting("PROJECT_MIND_TEST_SYSTEM_CALLBACK", 480);
        let both_voiced = std::env::var_os("PROJECT_MIND_TEST_BOTH_VOICED").is_some();
        let mut frames = Vec::new();
        let mut input_hasher = Sha256::new();
        for (mut track, callback) in [
            (
                read_replay_track("PROJECT_MIND_TEST_MIC_WAV", AudioSource::Microphone),
                mic_callback,
            ),
            (
                read_replay_track("PROJECT_MIND_TEST_SYSTEM_WAV", AudioSource::System),
                system_callback,
            ),
        ] {
            // Duplicate the real voiced microphone onto the system source to exercise
            // microphone, system and mixed recognition concurrently. Original WAVs stay read-only.
            if both_voiced && track.source == AudioSource::System {
                track = read_replay_track("PROJECT_MIND_TEST_MIC_WAV", AudioSource::System);
            }
            input_hasher.update(track.rate.to_le_bytes());
            input_hasher.update(track.channels.to_le_bytes());
            input_hasher.update(track.start.to_le_bytes());
            for sample in &track.samples {
                input_hasher.update(sample.to_le_bytes());
            }
            let mut timeline =
                SourceTimeline::new(track.source, 1, 0, track.rate, track.channels).unwrap();
            let mut consumed = 0;
            for chunk in track.samples.chunks(callback * usize::from(track.channels)) {
                let at = (track.start + consumed) * 1_000_000_000 / u64::from(track.rate);
                let frame = timeline.stamp(at, chunk.to_vec()).unwrap();
                consumed += (chunk.len() / usize::from(track.channels)) as u64;
                let end = frame.media_position_ns()
                    + chunk.len() as u64 / u64::from(track.channels) * 1_000_000_000
                        / u64::from(track.rate);
                frames.push((end, frame));
            }
        }
        frames.sort_by_key(|(end, _)| *end);
        let expected_callbacks = frames.len();
        let expected_end_ms = frames.last().unwrap().0 / 1_000_000;
        let input_hash = format!("{:x}", input_hasher.finalize());
        let cache = tempfile::tempdir().unwrap();
        let models = cache.path().join("voice-models");
        std::fs::create_dir(&models).unwrap();
        std::os::unix::fs::symlink(
            std::env::var("PROJECT_MIND_TEST_MODEL_DIR").unwrap(),
            models.join(crate::voice::model_package::PACKAGE_ID),
        )
        .unwrap();
        let (activity_mic_send, activity_mic) = bounded_audio_frames(queue_capacity).unwrap();
        let (activity_sys_send, activity_sys) = bounded_audio_frames(queue_capacity).unwrap();
        let (live_mic_send, live_mic) = bounded_audio_frames(queue_capacity).unwrap();
        let (live_sys_send, live_sys) = bounded_audio_frames(queue_capacity).unwrap();
        let activity_only = std::env::var_os("PROJECT_MIND_TEST_ACTIVITY_ONLY").is_some();
        let live = if activity_only {
            None
        } else {
            Some(
                LiveLocalHandle::spawn(
                    LocalAsrWorker::start(cache.path()).unwrap(),
                    live_mic,
                    live_sys,
                    0,
                    true,
                )
                .unwrap(),
            )
        };
        let activity = ActivityHandle::spawn(activity_mic, activity_sys).unwrap();
        let started = std::time::Instant::now();
        let mut submitted = 0;
        let mut activity_ingress_error = None;
        let mut live_ingress_error = None;
        let mut failed_at = None;
        for (end, frame) in frames {
            let due = std::time::Duration::from_nanos(end);
            if let Some(wait) = due.checked_sub(started.elapsed()) {
                thread::sleep(wait);
            }
            let (activity_sink, live_sink) = if frame.source == AudioSource::Microphone {
                (&activity_mic_send, &live_mic_send)
            } else {
                (&activity_sys_send, &live_sys_send)
            };
            if let Err(error) = activity_sink.try_push(frame.clone()) {
                activity_ingress_error = Some((
                    frame.source,
                    end / 1_000_000,
                    match error {
                        crate::voice::capture::AudioIngressError::Backpressure(_) => "backpressure",
                        crate::voice::capture::AudioIngressError::Closed(_) => "closed",
                    },
                ));
                break;
            }
            if !activity_only {
                if let Err(error) = live_sink.try_push(frame) {
                    live_ingress_error = Some((
                        end / 1_000_000,
                        match error {
                            crate::voice::capture::AudioIngressError::Backpressure(_) => {
                                "backpressure"
                            }
                            crate::voice::capture::AudioIngressError::Closed(_) => "closed",
                        },
                    ));
                    break;
                }
            }
            submitted += 1;
            if activity.failed() {
                failed_at = Some(end / 1_000_000);
                break;
            }
        }
        drop((
            activity_mic_send,
            activity_sys_send,
            live_mic_send,
            live_sys_send,
        ));
        let feed_wall = started.elapsed();
        let failed = activity.failed();
        let activity_result = activity.finish();
        let activity_wall = started.elapsed();
        let mut final_count = 0;
        let mut final_end = 0;
        let mut live_errors = Vec::new();
        let mut transcript_hasher = Sha256::new();
        let mut boundaries = Vec::new();
        let mut private_finals = Vec::new();
        for update in live.map(LiveLocalHandle::finish).unwrap_or_default() {
            match update {
                Ok(RecognitionUpdate::Final(value)) => {
                    final_count += 1;
                    final_end = final_end.max(value.end_ms);
                    boundaries.push((value.start_ms, value.end_ms));
                    let record = serde_json::json!({
                        "provider_key": value.provider_key,
                        "start_ms": value.start_ms,
                        "end_ms": value.end_ms,
                        "text": value.text,
                    });
                    let encoded = serde_json::to_vec(&record).unwrap();
                    transcript_hasher.update((encoded.len() as u64).to_le_bytes());
                    transcript_hasher.update(encoded);
                    private_finals.push(record);
                }
                Err(error) => live_errors.push(error.to_string()),
                _ => (),
            }
        }
        if let Some(path) = std::env::var_os("PROJECT_MIND_TEST_FINALS_JSON") {
            // Caller must choose a local temporary destination; never use workspace Transcript files.
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)
                .unwrap();
            output
                .write_all(&serde_json::to_vec(&private_finals).unwrap())
                .unwrap();
        }
        eprintln!("REPLAY_INTEGRITY queue_capacity={queue_capacity} mic_callback={mic_callback} system_callback={system_callback} both_voiced={both_voiced} expected_callbacks={expected_callbacks} accepted_callbacks={submitted} expected_end_ms={expected_end_ms} input_sha256={input_hash} transcript_sha256={:x} boundaries={boundaries:?}", transcript_hasher.finalize());
        eprintln!("ACTIVITY_REPLAY activity_only={activity_only} submitted={submitted} feed_wall_s={:.3} activity_finish_wall_s={:.3} total_wall_s={:.3} failed={failed} failed_at_ms={failed_at:?} activity_ingress={activity_ingress_error:?} live_ingress={live_ingress_error:?} activity_result={activity_result:?} finals={final_count} final_end_ms={final_end} live_errors={live_errors:?}", feed_wall.as_secs_f64(), activity_wall.as_secs_f64(), started.elapsed().as_secs_f64());
        assert_eq!(
            submitted, expected_callbacks,
            "replay must deliver every input callback"
        );
        assert!(
            !failed && failed_at.is_none(),
            "activity worker failed during replay"
        );
        if !activity_only {
            assert!(
                final_count > 0,
                "voiced fixture must produce final transcript"
            );
        }
        assert!(
            activity_result.is_ok(),
            "activity replay failed: {activity_result:?}"
        );
        assert!(
            activity_ingress_error.is_none() && live_ingress_error.is_none(),
            "production queue rejected audio"
        );
        assert!(
            live_errors.is_empty(),
            "live replay failed: {live_errors:?}"
        );
    }

    #[test]
    fn both_tracks_need_five_minutes_of_observed_silence_and_speech_resets_the_clock() {
        let mut activity = SpeechActivity::default();
        activity.observe(0, 300_000, false);
        assert!(!activity.should_pause()); // No system audio observation is not silence.
        activity.observe(1, 300_000, false);
        assert!(activity.should_pause());
        activity.observe(0, 300_001, true);
        activity.observe(1, 600_000, false);
        assert!(!activity.should_pause());
        activity.observe(0, 600_001, false);
        assert!(!activity.should_pause());
        activity.observe(1, 600_001, false);
        assert!(activity.should_pause());
    }
}
