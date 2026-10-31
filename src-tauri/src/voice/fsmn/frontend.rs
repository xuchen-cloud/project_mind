// Feature calculation follows extract-speech 0.9.1, Copyright (c) 2026 Yehor Smoliakov.
// Adapted under MIT; see LICENSE.extract-speech. Retains exact LFR edges.
//! FSMN-VAD feature extraction.

use std::{fs, path::Path};

use anyhow::{Context, Result};
use kaldi_native_fbank::{
    fbank::{FbankComputer, FbankOptions},
    window::{extract_window, num_frames, Window},
};

pub const FEATURE_DIM: usize = 400;
const N_MELS: usize = 80;
const LFR_M: usize = 5;
const SAMPLE_RATE: f32 = 16_000.0;

pub struct WindowFrontend {
    means: Vec<f32>,
    scales: Vec<f32>,
    computer: FbankComputer,
    window_function: Option<Window>,
    filterbank: Vec<Vec<f32>>,
    normalized: Vec<f32>,
    advanced: usize,
}

impl WindowFrontend {
    /// Loads the CMVN sidecar data located next to an FSMN model.
    ///
    /// # Errors
    ///
    /// Returns an error if the sidecar is missing, unreadable, or malformed.
    pub fn from_model_path(model_path: &Path) -> Result<Self> {
        let model_dir = model_path.parent().unwrap_or_else(|| Path::new("."));
        let cmvn_path = model_dir.join("vad.mvn");
        let contents = fs::read_to_string(&cmvn_path)
            .with_context(|| format!("failed to read CMVN file {}", cmvn_path.display()))?;
        let means = parse_coefficients(&contents, "<AddShift>")?;
        let scales = parse_coefficients(&contents, "<Rescale>")?;
        anyhow::ensure!(
            means.len() == FEATURE_DIM && scales.len() == FEATURE_DIM,
            "FSMN-VAD CMVN file {} contains {} means and {} scales; expected {FEATURE_DIM} of each",
            cmvn_path.display(),
            means.len(),
            scales.len()
        );

        let mut options = FbankOptions::default();
        options.frame_opts.samp_freq = SAMPLE_RATE;
        options.frame_opts.dither = 0.0;
        "hamming".clone_into(&mut options.frame_opts.window_type);
        options.frame_opts.frame_shift_ms = 10.0;
        options.frame_opts.frame_length_ms = 25.0;
        options.frame_opts.snip_edges = true;
        options.mel_opts.num_bins = N_MELS;
        options.mel_opts.debug_mel = false;
        options.use_energy = false;
        options.energy_floor = 0.0;

        let computer = FbankComputer::new(options).map_err(anyhow::Error::msg)?;
        let window_function = Window::new(&computer.opts.frame_opts);
        Ok(Self {
            means,
            scales,
            computer,
            window_function,
            filterbank: Vec::new(),
            normalized: Vec::new(),
            advanced: 0,
        })
    }

    pub fn advance(&mut self, samples: usize) {
        self.advanced = self.advanced.saturating_add(samples);
    }

    /// Extracts normalized low-frame-rate filterbank features.
    ///
    /// # Errors
    ///
    /// Returns an error if the filterbank cannot be initialized or evaluated.
    pub fn extract(&mut self, waveform: &[f32]) -> Result<Vec<f32>> {
        let count = num_frames(waveform.len(), &self.computer.opts.frame_opts, false);
        let shift = self.computer.opts.frame_opts.window_shift();
        let reuse = if self.advanced % shift == 0 && self.filterbank.len() == count {
            count.saturating_sub(self.advanced / shift)
        } else {
            0
        };
        let discard = self.filterbank.len() - reuse;
        self.filterbank.drain(..discard);
        let scaled: Vec<f32> = waveform.iter().map(|sample| sample * 32_768.0).collect();
        let mut window = vec![0.0; self.computer.opts.frame_opts.padded_window_size()];
        for frame in reuse..count {
            let energy = extract_window(
                0,
                &scaled,
                frame,
                &self.computer.opts.frame_opts,
                self.window_function.as_ref(),
                &mut window,
            )
            .map_err(|()| anyhow::anyhow!("FSMN filterbank window extraction failed"))?;
            let mut feature = vec![0.0; N_MELS];
            self.computer
                .compute(energy, 1.0, &mut window, &mut feature);
            self.filterbank.push(feature);
        }
        self.advanced = 0;
        if self.filterbank.is_empty() {
            return Ok(Vec::new());
        }

        // LFR repeats two frames at each finite-window edge. Overlapping
        // interior normalized frames are identical; recompute both edges plus
        // the newly appended frames so future context never reuses a padded edge.
        self.normalized.drain(..discard * FEATURE_DIM);
        self.normalized.resize(count * FEATURE_DIM, 0.0);
        for frame in 0..count {
            if frame >= 2 && frame < reuse.saturating_sub(2) {
                continue;
            }
            for lfr in 0..LFR_M {
                let source = (frame + lfr).saturating_sub(2).min(count - 1);
                for mel in 0..N_MELS {
                    let index = lfr * N_MELS + mel;
                    self.normalized[frame * FEATURE_DIM + index] =
                        (self.filterbank[source][mel] + self.means[index]) * self.scales[index];
                }
            }
        }
        Ok(self.normalized.clone())
    }
}

fn parse_coefficients(contents: &str, marker: &str) -> Result<Vec<f32>> {
    let mut lines = contents.lines();
    while let Some(line) = lines.next() {
        if line.split_whitespace().next() != Some(marker) {
            continue;
        }

        let coefficients = lines
            .next()
            .with_context(|| format!("CMVN marker {marker} has no coefficient line"))?;
        let mut values = Vec::new();
        let mut inside_brackets = false;
        for token in coefficients.split_whitespace() {
            if token == "[" {
                inside_brackets = true;
            } else if token == "]" {
                break;
            } else if inside_brackets {
                values.push(token.parse::<f32>().with_context(|| {
                    format!("invalid CMVN coefficient {token:?} after {marker}")
                })?);
            }
        }
        anyhow::ensure!(
            !values.is_empty(),
            "CMVN marker {marker} has no coefficients"
        );
        return Ok(values);
    }

    Err(anyhow::anyhow!("CMVN file does not contain {marker}"))
}
