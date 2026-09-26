//! Fixed, offline FSMN-VAD inference boundary.
use anyhow::{ensure, Result};
use extract_speech::{candle_core::Device, fsmn_vad::FsmnVad};
use std::collections::VecDeque;

// The 1.02 s window covers the four FSMN memory layers. A zero prefix avoids
// treating recurrent-cache startup scores as speech. Evaluate every 90 ms and
// retain all nine final 10 ms scores so brief speech between evaluations survives.
const WINDOW: usize = 16_320;
const FRAME: usize = 480;
const THRESHOLD: f32 = 0.6;

pub struct FsmnSpeechDetector {
    model: FsmnVad,
    window: VecDeque<f32>,
    frames_until_inference: usize,
    speech: bool,
    supported_run: u8,
}

impl FsmnSpeechDetector {
    pub fn new() -> Result<Self> {
        let directory = tempfile::tempdir()?;
        std::fs::write(
            directory.path().join("model.onnx"),
            include_bytes!("../../resources/fsmn/model.onnx"),
        )?;
        std::fs::write(
            directory.path().join("vad.mvn"),
            include_bytes!("../../resources/fsmn/vad.mvn"),
        )?;
        let model = FsmnVad::new(directory.path().join("model.onnx"), Device::Cpu, false)?;
        Ok(Self {
            model,
            window: VecDeque::from(vec![0.0; WINDOW]),
            frames_until_inference: 0,
            speech: false,
            supported_run: 0,
        })
    }

    /// Consume 30 ms of 16 kHz mono PCM. Only this copy is analyzed; raw tracks
    /// are owned by the independent writers.
    pub fn is_speech(&mut self, samples: &[f32]) -> Result<bool> {
        ensure!(
            samples.len() == FRAME,
            "FSMN-VAD expects a 30 ms 16 kHz frame"
        );
        self.window.drain(..FRAME);
        self.window.extend(samples.iter().copied());
        // Isolated impulses and numerical silence cannot extend speech evidence.
        // The model still decides speech; this gate only rejects unsupported clicks.
        let supported = samples
            .chunks(160)
            .filter(|chunk| {
                chunk.iter().map(|sample| sample * sample).sum::<f32>() / chunk.len() as f32
                    >= 0.0005_f32.powi(2)
            })
            .count();
        if supported < 2 {
            self.supported_run = 0;
            self.frames_until_inference = 0;
            return Ok(false);
        }
        if self.frames_until_inference == 0 {
            let probabilities = self
                .model
                .speech_probabilities(self.window.make_contiguous())?;
            self.speech = probabilities
                .iter()
                .rev()
                .take(9)
                .any(|probability| *probability >= THRESHOLD);
            self.frames_until_inference = 3;
        }
        self.frames_until_inference -= 1;
        self.supported_run = if self.speech && supported >= 2 {
            (self.supported_run + 1).min(2)
        } else {
            0
        };
        Ok(self.supported_run >= 2)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_fsmn_model_rejects_silence_including_startup() {
        let mut detector = FsmnSpeechDetector::new().unwrap();
        for _ in 0..12 {
            assert!(!detector.is_speech(&[0.0; 480]).unwrap());
        }
    }
}
