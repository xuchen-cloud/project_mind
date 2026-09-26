//! Voice activity is observed independently on the two original source tracks.
use super::{
    capture::{AudioFrame, AudioFrameStream, AudioSource},
    fsmn::FsmnSpeechDetector,
    live_local::Track,
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
    pub fn spawn(mut microphone: AudioFrameStream, mut system: AudioFrameStream) -> Result<Self> {
        let mut detectors = [FsmnSpeechDetector::new()?, FsmnSpeechDetector::new()?];
        let silent = Arc::new(AtomicBool::new(false));
        let failed = Arc::new(AtomicBool::new(false));
        let result_silent = silent.clone();
        let result_failed = failed.clone();
        let join = thread::Builder::new().name("voice-activity".into()).spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread().build()?;
            let result = runtime.block_on(async {
                let mut tracks = [Track::new(), Track::new()];
                let mut activity = SpeechActivity::default();
                let mut mic_open = true;
                let mut system_open = true;
                while mic_open || system_open {
                    let frame = tokio::select! {
                        frame = microphone.next(), if mic_open => { if frame.is_none() { mic_open = false; } frame },
                        frame = system.next(), if system_open => { if frame.is_none() { system_open = false; } frame },
                    };
                    if let Some(frame) = frame {
                        observe_frame(&mut tracks, &mut detectors, &mut activity, frame)?;
                        result_silent.store(activity.should_pause(), Ordering::Relaxed);
                    }
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
