// Inference follows extract-speech 0.9.1, Copyright (c) 2026 Yehor Smoliakov.
// Adapted under MIT; see LICENSE.extract-speech.
// The detector consumes the finite window tail. Persistent caches stop before
// the two provisional LFR edge frames; those are evaluated on a temporary copy.
//! Candle implementation of FSMN-VAD.

use std::{collections::HashMap, path::PathBuf};

use anyhow::{Context, Result};
use extract_speech::candle_core::{self, Device, Tensor};

use super::frontend::{WindowFrontend, FEATURE_DIM};

const CACHE_COUNT: usize = 4;
const CACHE_DIM: usize = 128;
const CACHE_ORDER: usize = 19;

pub struct WindowModel {
    model: candle_onnx::onnx::ModelProto,
    frontend: WindowFrontend,
    constants: HashMap<String, Tensor>,
    device: Device,
}

impl WindowModel {
    /// Loads an FSMN model and its preprocessing sidecar for Candle inference.
    ///
    /// # Errors
    ///
    /// Returns an error if the model or CMVN sidecar cannot be loaded.
    pub fn new(model_path: PathBuf, device: Device) -> Result<Self> {
        let frontend = WindowFrontend::from_model_path(&model_path)?;
        let mut model = candle_onnx::read_file(model_path)?;
        let graph = model.graph.as_mut().context("FSMN model has no graph")?;
        let constants = graph
            .initializer
            .iter()
            .map(|value| {
                Ok((
                    value.name.clone(),
                    candle_onnx::eval::get_tensor(value, &value.name)?,
                ))
            })
            .collect::<Result<HashMap<_, _>>>()?;
        graph.initializer.clear();
        Ok(Self {
            constants,
            model,
            frontend,
            device,
        })
    }

    pub fn advance(&mut self, samples: usize) {
        self.frontend.advance(samples);
    }

    #[cfg(test)]
    /// Computes a speech probability for every FSMN frame.
    ///
    /// # Errors
    ///
    /// Returns an error if feature extraction, inference, or tensor validation fails.
    pub fn speech_probabilities(&mut self, waveform: &[f32]) -> Result<Vec<f32>> {
        let features = self.frontend.extract(waveform)?;
        if features.is_empty() {
            return Ok(Vec::new());
        }

        Ok(self.evaluate(&features, &self.empty_caches()?)?.0)
    }

    fn empty_caches(&self) -> Result<[Tensor; CACHE_COUNT]> {
        let empty = Tensor::zeros(
            (1, CACHE_DIM, CACHE_ORDER, 1),
            candle_core::DType::F32,
            &self.device,
        )?;
        Ok(std::array::from_fn(|_| empty.clone()))
    }

    fn evaluate(
        &self,
        features: &[f32],
        caches: &[Tensor; CACHE_COUNT],
    ) -> Result<(Vec<f32>, [Tensor; CACHE_COUNT])> {
        let frame_count = features.len() / FEATURE_DIM;
        let speech = Tensor::from_slice(features, (1, frame_count, FEATURE_DIM), &self.device)?;
        let mut inputs = self.constants.clone();
        inputs.insert("speech".to_string(), speech);
        for (index, cache) in caches.iter().enumerate() {
            inputs.insert(format!("in_cache{index}"), cache.clone());
        }
        let outputs = candle_onnx::simple_eval(&self.model, inputs)
            .context("failed to evaluate FSMN-VAD with Candle")?;
        let logits = outputs
            .get("logits")
            .context("FSMN-VAD model did not return a 'logits' tensor")?;
        let dimensions = logits.dims();
        anyhow::ensure!(dimensions.len() == 3 && dimensions[0] == 1 && dimensions[1] == frame_count,
            "FSMN-VAD returned logits with shape {dimensions:?}; expected [1, {frame_count}, classes]");
        let classes = dimensions[2];
        anyhow::ensure!(classes >= 2, "FSMN-VAD returned fewer than two classes");
        let scores = logits.flatten_all()?.to_vec1::<f32>()?;
        anyhow::ensure!(
            scores.len() == frame_count * classes,
            "FSMN-VAD returned inconsistent logits"
        );
        let probabilities = scores
            .chunks_exact(classes)
            .map(|score| (1.0 - score[0]).clamp(0.0, 1.0))
            .collect();
        let mut next = caches.clone();
        for (index, cache) in next.iter_mut().enumerate() {
            let name = format!("out_cache{index}");
            let value = outputs
                .get(&name)
                .with_context(|| format!("FSMN-VAD model did not return '{name}'"))?;
            anyhow::ensure!(
                value.dims() == [1, CACHE_DIM, CACHE_ORDER, 1],
                "FSMN-VAD returned {name} with shape {:?}",
                value.dims()
            );
            cache.clone_from(value);
        }
        Ok((probabilities, next))
    }
}

// The fixed graph has four causal 19-frame memories (76 frames total). Its last
// nine outputs are beyond any left-edge initialization effects. LFR requires two
// future frames: commit only through index 97 and recompute indices 98/99 as
// provisional scores. A later window first replaces those with real context.
pub struct StreamingWindowModel {
    model: WindowModel,
    caches: Option<[Tensor; CACHE_COUNT]>,
    scores: Vec<f32>,
    advanced: usize,
}

impl StreamingWindowModel {
    pub fn new(path: PathBuf, device: Device) -> Result<Self> {
        Ok(Self {
            model: WindowModel::new(path, device)?,
            caches: None,
            scores: vec![0.0; 100],
            advanced: 0,
        })
    }

    pub fn advance(&mut self, samples: usize) {
        self.model.advance(samples);
        self.advanced = self.advanced.saturating_add(samples);
    }

    pub fn speech_probabilities(&mut self, waveform: &[f32]) -> Result<Vec<f32>> {
        let delta = self.advanced / 160;
        let features = self.model.frontend.extract(waveform)?;
        self.advanced = 0;
        anyhow::ensure!(
            features.len() == 100 * FEATURE_DIM,
            "streaming FSMN expects the fixed 100-frame window"
        );
        let (start, caches) = if self.caches.is_none() || delta >= 98 {
            (0, self.model.empty_caches()?)
        } else {
            self.scores.rotate_left(delta);
            (98 - delta, self.caches.as_ref().unwrap().clone())
        };
        let (stable_scores, stable_caches) = self
            .model
            .evaluate(&features[start * FEATURE_DIM..98 * FEATURE_DIM], &caches)?;
        self.scores[start..98].copy_from_slice(&stable_scores);
        let (provisional_scores, _) = self
            .model
            .evaluate(&features[98 * FEATURE_DIM..], &stable_caches)?;
        self.scores[98..].copy_from_slice(&provisional_scores);
        self.caches = Some(stable_caches);
        Ok(self.scores[91..].to_vec())
    }
}
