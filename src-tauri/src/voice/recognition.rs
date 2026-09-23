//! Recognition pipeline boundaries — VR-08, VR-09, VR-10.
//!
//! The segmenter consumes decisions from a real VAD adapter. It never guesses
//! speech from amplitude and never changes the original source tracks.
// TODO: connect mixed capture to FSMN-VAD ONNX; one model state per stream/epoch.
// TODO: SenseVoice model packages, native ONNX worker, tokenizer and ITN.
// TODO: Paraformer WS handshake, provider finals and bounded gap backfill.

use std::collections::VecDeque;

#[derive(Debug)]
pub struct TranscriptSegment {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub language: Option<String>,
}

/// A real VAD model's decision over contiguous mono PCM.
pub struct VadFrame<'a> {
    pub start_sample: u64,
    pub samples: &'a [f32],
    pub speech: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct SegmenterConfig {
    pub pre_roll_ms: u32,
    pub tail_ms: u32,
    pub min_speech_ms: u32,
    pub max_segment_ms: u32,
    pub overlap_ms: u32,
}

impl Default for SegmenterConfig {
    fn default() -> Self {
        Self {
            pre_roll_ms: 250,
            tail_ms: 750,
            min_speech_ms: 100,
            max_segment_ms: 25_000,
            overlap_ms: 300,
        }
    }
}

#[derive(Debug, PartialEq)]
pub struct UtteranceSegment {
    pub start_sample: u64,
    pub samples: Vec<f32>,
    pub forced_split: bool,
}

impl UtteranceSegment {
    pub fn end_sample(&self) -> u64 {
        self.start_sample + self.samples.len() as u64
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum SegmenterError {
    InvalidConfig,
    EmptyFrame,
    DiscontinuousFrame,
    OversizedFrame,
    PositionOverflow,
}

struct ActiveUtterance {
    start_sample: u64,
    samples: Vec<f32>,
    speech_samples: usize,
    trailing_silence: usize,
}

/// Frame-aligned segmentation. Create a fresh instance for every capture epoch.
pub struct UtteranceSegmenter {
    pre_roll_samples: usize,
    tail_samples: usize,
    min_speech_samples: usize,
    max_samples: usize,
    overlap_samples: usize,
    expected_sample: Option<u64>,
    pre_roll: VecDeque<f32>,
    active: Option<ActiveUtterance>,
}

impl UtteranceSegmenter {
    pub fn new(sample_rate: u32, config: SegmenterConfig) -> Result<Self, SegmenterError> {
        let samples = |ms: u32| (u64::from(sample_rate) * u64::from(ms) / 1_000) as usize;
        let max_samples = samples(config.max_segment_ms);
        let pre_roll_samples = samples(config.pre_roll_ms);
        let overlap_samples = samples(config.overlap_ms);
        if sample_rate == 0
            || max_samples == 0
            || samples(config.tail_ms) == 0
            || samples(config.min_speech_ms) == 0
            || pre_roll_samples + overlap_samples >= max_samples
        {
            return Err(SegmenterError::InvalidConfig);
        }
        Ok(Self {
            pre_roll_samples,
            tail_samples: samples(config.tail_ms),
            min_speech_samples: samples(config.min_speech_ms),
            max_samples,
            overlap_samples,
            expected_sample: None,
            pre_roll: VecDeque::with_capacity(pre_roll_samples),
            active: None,
        })
    }

    /// Returns completed segments when an endpoint or safe maximum is reached.
    pub fn push(&mut self, frame: VadFrame<'_>) -> Result<Vec<UtteranceSegment>, SegmenterError> {
        if frame.samples.is_empty() {
            return Err(SegmenterError::EmptyFrame);
        }
        if frame.samples.len() > self.max_samples - self.pre_roll_samples {
            return Err(SegmenterError::OversizedFrame);
        }
        if self
            .expected_sample
            .is_some_and(|next| next != frame.start_sample)
        {
            return Err(SegmenterError::DiscontinuousFrame);
        }
        self.expected_sample = Some(
            frame
                .start_sample
                .checked_add(frame.samples.len() as u64)
                .ok_or(SegmenterError::PositionOverflow)?,
        );

        if self.active.is_none() {
            if !frame.speech {
                self.retain_pre_roll(frame.samples);
                return Ok(Vec::new());
            }
            let start_sample = frame.start_sample - self.pre_roll.len() as u64;
            self.active = Some(ActiveUtterance {
                start_sample,
                samples: self.pre_roll.drain(..).collect(),
                speech_samples: 0,
                trailing_silence: 0,
            });
        }

        let mut completed = Vec::new();
        let active = self.active.as_ref().expect("started above");
        if active.samples.len() + frame.samples.len() > self.max_samples {
            let overlap = active.samples.len().min(self.overlap_samples);
            let continuation = active.samples[active.samples.len() - overlap..].to_vec();
            let old = self.active.take().expect("active segment");
            let trailing_silence = old.trailing_silence.min(overlap);
            if let Some(segment) = Self::finish(old, self.min_speech_samples, true) {
                completed.push(segment);
            }
            self.active = Some(ActiveUtterance {
                start_sample: frame.start_sample - overlap as u64,
                samples: continuation,
                speech_samples: overlap - trailing_silence,
                trailing_silence,
            });
        }
        let active = self.active.as_mut().expect("active segment");
        active.samples.extend_from_slice(frame.samples);
        if frame.speech {
            active.speech_samples += frame.samples.len();
            active.trailing_silence = 0;
        } else {
            active.trailing_silence += frame.samples.len();
            if active.trailing_silence >= self.tail_samples {
                let old = self.active.take().expect("active segment");
                self.retain_pre_roll(frame.samples);
                if let Some(segment) = Self::finish(old, self.min_speech_samples, false) {
                    completed.push(segment);
                }
                return Ok(completed);
            }
        }
        Ok(completed)
    }

    /// Pause/end drains speech; pure silence cannot create a Transcript.
    pub fn flush(&mut self) -> Option<UtteranceSegment> {
        self.pre_roll.clear();
        self.expected_sample = None;
        self.active
            .take()
            .and_then(|active| Self::finish(active, self.min_speech_samples, false))
    }

    fn retain_pre_roll(&mut self, samples: &[f32]) {
        self.pre_roll.extend(samples.iter().copied());
        while self.pre_roll.len() > self.pre_roll_samples {
            self.pre_roll.pop_front();
        }
    }

    fn finish(
        active: ActiveUtterance,
        min_speech_samples: usize,
        forced_split: bool,
    ) -> Option<UtteranceSegment> {
        (active.speech_samples >= min_speech_samples).then_some(UtteranceSegment {
            start_sample: active.start_sample,
            samples: active.samples,
            forced_split,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> SegmenterConfig {
        SegmenterConfig {
            pre_roll_ms: 20,
            tail_ms: 30,
            min_speech_ms: 20,
            max_segment_ms: 100,
            overlap_ms: 10,
        }
    }

    fn push(segmenter: &mut UtteranceSegmenter, at: u64, speech: bool) -> Option<UtteranceSegment> {
        segmenter
            .push(VadFrame {
                start_sample: at,
                samples: &[0.5; 10],
                speech,
            })
            .unwrap()
            .into_iter()
            .next()
    }

    #[test]
    fn retains_pre_roll_and_tail_without_emitting_pure_silence() {
        let mut segmenter = UtteranceSegmenter::new(1_000, config()).unwrap();
        for at in (0..100).step_by(10) {
            assert!(push(&mut segmenter, at, false).is_none());
        }
        assert!(segmenter.flush().is_none());
        for at in (100..150).step_by(10) {
            assert!(push(&mut segmenter, at, at >= 120).is_none());
        }
        assert!(push(&mut segmenter, 150, false).is_none());
        assert!(push(&mut segmenter, 160, false).is_none());
        let segment = push(&mut segmenter, 170, false).unwrap();
        assert_eq!(segment.start_sample, 100);
        assert_eq!(segment.end_sample(), 180);
        assert!(!segment.forced_split);
    }

    #[test]
    fn force_split_stays_within_model_limit_and_keeps_overlap() {
        let mut segmenter = UtteranceSegmenter::new(1_000, config()).unwrap();
        let mut first = None;
        for at in (0..110).step_by(10) {
            first = push(&mut segmenter, at, true).or(first);
        }
        let first = first.unwrap();
        assert_eq!(first.start_sample, 0);
        assert_eq!(first.end_sample(), 100);
        assert!(first.forced_split);
        let second = segmenter.flush().unwrap();
        assert_eq!(second.start_sample, 90);
        assert_eq!(second.end_sample(), 110);
    }

    #[test]
    fn rejects_gaps_without_inserting_fake_silence() {
        let mut segmenter = UtteranceSegmenter::new(1_000, config()).unwrap();
        push(&mut segmenter, 0, true);
        push(&mut segmenter, 10, true);
        assert_eq!(
            segmenter.push(VadFrame {
                start_sample: 30,
                samples: &[0.0; 10],
                speech: false
            }),
            Err(SegmenterError::DiscontinuousFrame)
        );
        assert_eq!(segmenter.flush().unwrap().end_sample(), 20);
    }
}
