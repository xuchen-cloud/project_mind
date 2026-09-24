//! Dedicated CPU worker for verified SenseVoice packages.
use super::{model_package, recognition::UtteranceSegment};
use anyhow::{anyhow, Result};
use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineSenseVoiceModelConfig};
use std::{path::Path, sync::mpsc, thread};

const SAMPLE_RATE: i32 = 16_000;
const MAX_SAMPLES: usize = 30 * SAMPLE_RATE as usize;
const MAX_BACKLOG: usize = 8;

pub struct LocalAsrWorker {
    sender: Option<mpsc::SyncSender<Work>>,
    join: Option<thread::JoinHandle<()>>,
}

struct Work {
    segment: UtteranceSegment,
    answer: mpsc::Sender<Result<LocalAsrResult>>,
}

#[derive(Debug)]
pub struct LocalAsrResult {
    pub start_sample: u64,
    pub end_sample: u64,
    pub text: String,
    pub forced_split: bool,
}

impl LocalAsrWorker {
    pub fn start(cache_root: &Path) -> Result<Self> {
        if !model_package::status(cache_root).ready {
            return Err(anyhow!("SenseVoice model package is not verified"));
        }
        let directory = model_package::package_directory(cache_root);
        let (sender, receiver) = mpsc::sync_channel::<Work>(MAX_BACKLOG);
        let (loaded_sender, loaded_receiver) = mpsc::sync_channel(1);
        let join = thread::Builder::new()
            .name("voice-local-asr".into())
            .spawn(move || {
                let recognizer = create_recognizer(&directory);
                let ready = recognizer.is_ok();
                let _ = loaded_sender.send(
                    recognizer
                        .as_ref()
                        .map(|_| ())
                        .map_err(|error| error.to_string()),
                );
                if !ready {
                    return;
                }
                let recognizer = recognizer.expect("checked above");
                while let Ok(work) = receiver.recv() {
                    let _ = work.answer.send(recognize(&recognizer, work.segment));
                }
            })?;
        loaded_receiver.recv()?.map_err(|error| anyhow!(error))?;
        Ok(Self {
            sender: Some(sender),
            join: Some(join),
        })
    }

    /// The caller retains a result channel. A full queue is an explicit
    /// recognition backlog error; the original audio must stay persisted.
    pub fn submit(
        &self,
        segment: UtteranceSegment,
    ) -> Result<mpsc::Receiver<Result<LocalAsrResult>>> {
        if segment.samples.is_empty() || segment.samples.len() > MAX_SAMPLES {
            return Err(anyhow!(
                "SenseVoice segment exceeds the verified input limit"
            ));
        }
        let (answer, result) = mpsc::channel();
        self.sender
            .as_ref()
            .ok_or_else(|| anyhow!("SenseVoice worker is closed"))?
            .try_send(Work { segment, answer })
            .map_err(|error| anyhow!("SenseVoice worker backlog: {error}"))?;
        Ok(result)
    }

    /// Call from a processing thread after result receivers have handled all
    /// submitted segments. Dropping the worker alone never blocks the UI thread.
    pub fn shutdown_and_wait(mut self) -> Result<()> {
        self.sender.take();
        if let Some(join) = self.join.take() {
            join.join()
                .map_err(|_| anyhow!("SenseVoice worker panicked"))?;
        }
        Ok(())
    }
}

impl Drop for LocalAsrWorker {
    fn drop(&mut self) {
        self.sender.take();
        self.join.take();
    }
}

fn create_recognizer(directory: &Path) -> Result<OfflineRecognizer> {
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.sense_voice = OfflineSenseVoiceModelConfig {
        model: Some(
            directory
                .join("model.int8.onnx")
                .to_string_lossy()
                .into_owned(),
        ),
        language: Some("auto".into()),
        use_itn: true,
    };
    config.model_config.tokens = Some(directory.join("tokens.txt").to_string_lossy().into_owned());
    config.model_config.provider = Some("cpu".into());
    config.model_config.num_threads = 2;
    OfflineRecognizer::create(&config).ok_or_else(|| anyhow!("SenseVoice model failed to load"))
}

fn recognize(recognizer: &OfflineRecognizer, segment: UtteranceSegment) -> Result<LocalAsrResult> {
    let end_sample = segment.end_sample();
    let forced_split = segment.forced_split;
    let stream = recognizer.create_stream();
    stream.accept_waveform(SAMPLE_RATE, &segment.samples);
    recognizer.decode(&stream);
    let result = stream
        .get_result()
        .ok_or_else(|| anyhow!("SenseVoice returned no result"))?;
    Ok(LocalAsrResult {
        start_sample: segment.start_sample,
        end_sample,
        text: result.text.trim().into(),
        forced_split,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    use sherpa_onnx::Wave;

    #[test]
    fn rejects_missing_model_without_starting_worker() {
        let root = tempfile::tempdir().unwrap();
        assert!(LocalAsrWorker::start(root.path()).is_err());
    }

    #[test]
    fn rejects_oversized_segment_before_queueing_it() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let worker = LocalAsrWorker {
            sender: Some(sender),
            join: None,
        };
        let result = worker.submit(UtteranceSegment {
            start_sample: 0,
            samples: vec![0.0; MAX_SAMPLES + 1],
            forced_split: false,
        });
        assert!(result.is_err());
        assert!(receiver.try_recv().is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires the verified external SenseVoice package; set PROJECT_MIND_TEST_MODEL_DIR"]
    fn recognizes_official_chinese_fixture_in_the_product_worker() {
        let source = std::path::PathBuf::from(
            std::env::var("PROJECT_MIND_TEST_MODEL_DIR").expect("model directory"),
        );
        let cache = tempfile::tempdir().unwrap();
        let models = cache.path().join("voice-models");
        std::fs::create_dir(&models).unwrap();
        std::os::unix::fs::symlink(&source, models.join(model_package::PACKAGE_ID)).unwrap();
        let worker = LocalAsrWorker::start(cache.path()).unwrap();
        let wave = Wave::read(source.join("test_wavs/zh.wav").to_str().unwrap()).unwrap();
        assert_eq!(wave.sample_rate(), SAMPLE_RATE);
        let answer = worker
            .submit(UtteranceSegment {
                start_sample: 16_000,
                samples: wave.samples().to_vec(),
                forced_split: false,
            })
            .unwrap();
        let result = answer
            .recv_timeout(std::time::Duration::from_secs(15))
            .unwrap()
            .unwrap();
        assert_eq!(result.start_sample, 16_000);
        assert_eq!(result.end_sample, 16_000 + wave.samples().len() as u64);
        assert!(result.text.contains("开饭时间"));
        worker.shutdown_and_wait().unwrap();
    }
}
