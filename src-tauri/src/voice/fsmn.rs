//! Fixed, offline FSMN-VAD inference boundary.
use anyhow::{ensure, Result};
use extract_speech::candle_core::Device;
mod frontend;
mod model;
use model::StreamingWindowModel;
#[cfg(test)]
use model::WindowModel;
use std::collections::VecDeque;

// The 1.02 s window covers the four FSMN memory layers. A zero prefix avoids
// treating recurrent-cache startup scores as speech. Evaluate every 90 ms and
// retain all nine final 10 ms scores so brief speech between evaluations survives.
const WINDOW: usize = 16_320;
const FRAME: usize = 480;
const THRESHOLD: f32 = 0.6;

pub struct FsmnSpeechDetector {
    model: Model,
    window: VecDeque<f32>,
    frames_until_inference: usize,
    speech: bool,
    supported_run: u8,
}

enum Model {
    Optimized(StreamingWindowModel),
    #[cfg(test)]
    Baseline(extract_speech::fsmn_vad::FsmnVad),
}

impl Model {
    fn advance(&mut self, samples: usize) {
        match self {
            Self::Optimized(model) => model.advance(samples),
            #[cfg(test)]
            Self::Baseline(_) => {}
        }
    }

    fn speech_probabilities(&mut self, window: &[f32]) -> Result<Vec<f32>> {
        match self {
            Self::Optimized(model) => model.speech_probabilities(window),
            #[cfg(test)]
            Self::Baseline(model) => model.speech_probabilities(window),
        }
    }
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
        let model = StreamingWindowModel::new(directory.path().join("model.onnx"), Device::Cpu)?;
        Ok(Self {
            model: Model::Optimized(model),
            window: VecDeque::from(vec![0.0; WINDOW]),
            frames_until_inference: 0,
            speech: false,
            supported_run: 0,
        })
    }

    #[cfg(test)]
    pub(crate) fn new_baseline() -> Result<Self> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("model.onnx");
        std::fs::write(&path, include_bytes!("../../resources/fsmn/model.onnx"))?;
        std::fs::write(
            directory.path().join("vad.mvn"),
            include_bytes!("../../resources/fsmn/vad.mvn"),
        )?;
        Ok(Self {
            model: Model::Baseline(extract_speech::fsmn_vad::FsmnVad::new(
                path,
                Device::Cpu,
                false,
            )?),
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
        self.model.advance(FRAME);
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

#[cfg(test)]
mod equivalence_tests {
    use super::*;
    use extract_speech::{fsmn_vad::FsmnVad, fsmn_vad_frontend::FsmnVadFrontend};

    pub(super) fn assets() -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("model.onnx"),
            include_bytes!("../../resources/fsmn/model.onnx"),
        )
        .unwrap();
        std::fs::write(
            directory.path().join("vad.mvn"),
            include_bytes!("../../resources/fsmn/vad.mvn"),
        )
        .unwrap();
        directory
    }

    // Include startup, short impulses, sustained signal, quiet recovery and gaps
    // longer than the window. Skipping evaluations must invalidate stale overlap.
    #[test]
    fn overlapping_features_match_fresh_windows_exactly() {
        let assets = assets();
        let path = assets.path().join("model.onnx");
        let baseline = FsmnVadFrontend::from_model_path(&path).unwrap();
        let mut optimized = frontend::WindowFrontend::from_model_path(&path).unwrap();
        let mut window = vec![0.0; WINDOW];
        let mut position = 0usize;
        for step in [1, 3, 1, 9, 40, 2, 3, 34, 1] {
            for _ in 0..step {
                window.rotate_left(FRAME);
                for value in &mut window[WINDOW - FRAME..] {
                    *value = if position < 480 || (position / 480) % 7 == 0 {
                        0.0
                    } else {
                        (position as f32 * 0.073).sin() * 0.03
                    };
                    position += 1;
                }
                optimized.advance(FRAME);
            }
            assert_eq!(
                optimized.extract(&window).unwrap(),
                baseline.extract(&window).unwrap()
            );
        }
    }

    #[test]
    fn cached_constants_preserve_all_window_probabilities() {
        let assets = assets();
        let path = assets.path().join("model.onnx");
        let mut baseline = FsmnVad::new(path.clone(), Device::Cpu, false).unwrap();
        let mut optimized = WindowModel::new(path, Device::Cpu).unwrap();
        let mut window = vec![0.0; WINDOW];
        for round in 0..6 {
            window.rotate_left(FRAME * 3);
            for (index, value) in window[WINDOW - FRAME * 3..].iter_mut().enumerate() {
                *value = if round == 0 || round == 4 {
                    0.0
                } else {
                    ((index + round * FRAME * 3) as f32 * 0.09).sin() * 0.1
                };
            }
            optimized.advance(FRAME * 3);
            assert_eq!(
                optimized.speech_probabilities(&window).unwrap(),
                baseline.speech_probabilities(&window).unwrap()
            );
        }
    }
    #[test]
    fn detector_matches_baseline_across_startup_short_audio_and_quiet_gaps() {
        let mut baseline = FsmnSpeechDetector::new_baseline().unwrap();
        let mut optimized = FsmnSpeechDetector::new().unwrap();
        for frame in 0..90 {
            let mut samples = [0.0; FRAME];
            if (4..6).contains(&frame) || (10..24).contains(&frame) || frame >= 70 {
                for (index, sample) in samples.iter_mut().enumerate() {
                    *sample = ((frame * FRAME + index) as f32 * 0.073).sin() * 0.1;
                }
            } else if frame == 8 {
                samples[100] = 0.9;
            }
            assert_eq!(
                optimized.is_speech(&samples).unwrap(),
                baseline.is_speech(&samples).unwrap(),
                "frame {frame}"
            );
        }
    }
    fn saved_audio() -> Vec<f32> {
        let bytes = std::fs::read(std::env::var("PROJECT_MIND_TEST_MIC_WAV").unwrap()).unwrap();
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(&bytes[8..16], b"WAVEfmt ");
        assert_eq!(&bytes[20..22], &3_u16.to_le_bytes());
        assert_eq!(&bytes[24..28], &48_000_u32.to_le_bytes());
        assert_eq!(&bytes[34..36], &32_u16.to_le_bytes());
        assert_eq!(&bytes[36..40], b"data");
        let channels = usize::from(u16::from_le_bytes(bytes[22..24].try_into().unwrap()));
        assert!((1..=2).contains(&channels));
        bytes[44..]
            .chunks_exact(4 * channels)
            .step_by(3)
            .map(|frame| {
                frame
                    .chunks_exact(4)
                    .map(|sample| f32::from_le_bytes(sample.try_into().unwrap()))
                    .sum::<f32>()
                    / channels as f32
            })
            .collect()
    }

    #[test]
    #[ignore = "read-only isolated VAD benchmark; set PROJECT_MIND_TEST_MIC_WAV and PROJECT_MIND_TEST_FSMN_BACKEND=baseline|optimized; run under external CPU timer"]
    fn measures_saved_audio_detector() {
        let pcm = saved_audio();
        let backend = std::env::var("PROJECT_MIND_TEST_FSMN_BACKEND").unwrap();
        let mut detector = match backend.as_str() {
            "baseline" => FsmnSpeechDetector::new_baseline().unwrap(),
            "optimized" => FsmnSpeechDetector::new().unwrap(),
            "streaming" => FsmnSpeechDetector::new().unwrap(),
            _ => panic!("expected baseline or optimized backend"),
        };
        let mut durations = Vec::new();
        let mut active = 0;
        let started = std::time::Instant::now();
        for frame in pcm.chunks_exact(FRAME) {
            let before = std::time::Instant::now();
            active += usize::from(detector.is_speech(frame).unwrap());
            durations.push(before.elapsed().as_secs_f64() * 1000.0);
        }
        let elapsed = started.elapsed().as_secs_f64();
        durations.sort_by(f64::total_cmp);
        assert!(!durations.is_empty());
        eprintln!("FSMN_PERF backend={backend} frames={} active={active} audio_s={:.3} wall_s={elapsed:.6} p95_ms={:.6} max_ms={:.6}", durations.len(), pcm.len() as f64 / 16_000.0, durations[durations.len() * 95 / 100], durations[durations.len() - 1]);
    }

    #[test]
    #[ignore = "read-only real-audio equivalence; set PROJECT_MIND_TEST_MIC_WAV to a captured 48kHz float WAV"]
    fn saved_audio_preserves_every_probability_and_decision() {
        let pcm = saved_audio();
        let assets = assets();
        let path = assets.path().join("model.onnx");
        let mut baseline = FsmnVad::new(path.clone(), Device::Cpu, false).unwrap();
        let mut optimized = WindowModel::new(path, Device::Cpu).unwrap();
        let mut baseline_detector = FsmnSpeechDetector::new_baseline().unwrap();
        let mut optimized_detector = FsmnSpeechDetector::new().unwrap();
        let mut window = vec![0.0; WINDOW];
        let mut evaluated = 0;
        for (index, frame) in pcm.chunks_exact(FRAME).enumerate() {
            assert_eq!(
                optimized_detector.is_speech(frame).unwrap(),
                baseline_detector.is_speech(frame).unwrap(),
                "decision {index}"
            );
            window.rotate_left(FRAME);
            window[WINDOW - FRAME..].copy_from_slice(frame);
            optimized.advance(FRAME);
            if index % 3 == 0 {
                assert_eq!(
                    optimized.speech_probabilities(&window).unwrap(),
                    baseline.speech_probabilities(&window).unwrap(),
                    "probabilities {index}"
                );
                evaluated += 1;
            }
        }
        assert!(evaluated > 0);
        eprintln!(
            "FSMN_EQUIVALENCE frames={} complete_probability_windows={evaluated} differences=0",
            pcm.len() / FRAME
        );
    }
    #[test]
    #[ignore = "experimental cached FSMN tail equivalence; set PROJECT_MIND_TEST_MIC_WAV"]
    fn saved_audio_streaming_tail_equivalence() {
        let pcm = saved_audio();
        let assets = assets();
        let path = assets.path().join("model.onnx");
        let mut baseline = FsmnVad::new(path.clone(), Device::Cpu, false).unwrap();
        let mut optimized = model::StreamingWindowModel::new(path, Device::Cpu).unwrap();
        let mut baseline_detector = FsmnSpeechDetector::new_baseline().unwrap();
        let mut streaming_detector = FsmnSpeechDetector::new().unwrap();
        let mut window = vec![0.0; WINDOW];
        let mut differences = 0;
        let mut max_difference = 0.0_f32;
        let mut threshold_differences = 0;
        let mut decision_differences = 0;
        for (index, frame) in pcm.chunks_exact(FRAME).enumerate() {
            decision_differences += usize::from(
                baseline_detector.is_speech(frame).unwrap()
                    != streaming_detector.is_speech(frame).unwrap(),
            );
            window.rotate_left(FRAME);
            window[WINDOW - FRAME..].copy_from_slice(frame);
            optimized.advance(FRAME);
            // Exercise 3-, 6-, 9-frame advances and long gaps between evaluation.
            if index % 3 == 0 || (index % 17 == 0 && index % 200 > 40) {
                let expected = baseline.speech_probabilities(&window).unwrap();
                let actual = optimized.speech_probabilities(&window).unwrap();
                for (expected, actual) in expected[91..].iter().zip(actual) {
                    differences += usize::from(*expected != actual);
                    threshold_differences +=
                        usize::from((*expected >= THRESHOLD) != (actual >= THRESHOLD));
                    max_difference = max_difference.max((*expected - actual).abs());
                }
            }
        }
        eprintln!("FSMN_STREAM_EQ probability_differences={differences} max_abs={max_difference} threshold_differences={threshold_differences} decision_differences={decision_differences}");
        assert_eq!(differences, 0);
        assert_eq!(decision_differences, 0);
    }
    #[test]
    fn streaming_tail_matches_full_window_after_short_and_long_gaps() {
        let assets = assets();
        let path = assets.path().join("model.onnx");
        let mut baseline = FsmnVad::new(path.clone(), Device::Cpu, false).unwrap();
        let mut streaming = StreamingWindowModel::new(path, Device::Cpu).unwrap();
        let mut window = vec![0.0; WINDOW];
        let mut position = 0;
        for step in [1, 3, 1, 9, 40, 2, 3, 31, 32, 33, 34, 1] {
            for _ in 0..step {
                window.rotate_left(FRAME);
                for sample in &mut window[WINDOW - FRAME..] {
                    *sample = if position < FRAME || (position / FRAME) % 7 == 0 {
                        0.0
                    } else {
                        (position as f32 * 0.073).sin() * 0.03
                    };
                    position += 1;
                }
                streaming.advance(FRAME);
            }
            let expected = baseline.speech_probabilities(&window).unwrap();
            assert_eq!(
                streaming.speech_probabilities(&window).unwrap(),
                expected[91..]
            );
        }
    }

    #[test]
    fn fixed_graph_has_only_four_causal_nineteen_frame_memories() {
        let assets = assets();
        let graph = candle_onnx::read_file(assets.path().join("model.onnx"))
            .unwrap()
            .graph
            .unwrap();
        let convolutions: Vec<_> = graph
            .node
            .iter()
            .filter(|node| node.op_type == "Conv")
            .collect();
        assert_eq!(convolutions.len(), 4);
        for convolution in convolutions {
            for (name, values) in [
                ("kernel_shape", vec![20, 1]),
                ("dilations", vec![1, 1]),
                ("strides", vec![1, 1]),
                ("pads", vec![0, 0, 0, 0]),
            ] {
                assert_eq!(
                    convolution
                        .attribute
                        .iter()
                        .find(|attribute| attribute.name == name)
                        .unwrap()
                        .ints,
                    values
                );
            }
        }
        for node in graph.node.iter().filter(|node| node.op_type == "Softmax") {
            assert_eq!(
                node.attribute
                    .iter()
                    .find(|attribute| attribute.name == "axis")
                    .unwrap()
                    .i,
                -1
            );
        }
    }
}
