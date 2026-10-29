//! Whole-session CPU diarization; epochs share one clustering operation.
use super::{contracts::VoicePlaybackChunk, diarization_model};
use anyhow::{anyhow, bail, Context, Result};
use sherpa_onnx::{OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufReader, Read},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

/// Whole-session input is bounded to 2 hours / 440 MiB of 16 kHz float audio.
/// sherpa owns additional model/segmentation workspace during synchronous inference.
pub const MAX_DURATION_MS: u64 = 2 * 60 * 60 * 1000;
pub(crate) const CONTACT_MATCH_THRESHOLD: f32 = 0.65;
const RATE: u64 = 16_000;
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SpeakerTurn {
    pub start_ms: u64,
    pub end_ms: u64,
    pub speaker_id: u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SpeakerEmbedding {
    pub speaker_id: u32,
    pub embedding: Vec<f32>,
}
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct DiarizationAnalysis {
    pub turns: Vec<SpeakerTurn>,
    pub embeddings: Vec<SpeakerEmbedding>,
}

fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        bail!("说话人分离已取消");
    }
    Ok(())
}

fn timeline(chunks: &[VoicePlaybackChunk]) -> Result<(BTreeMap<u64, u64>, u64)> {
    let mut lengths = BTreeMap::new();
    for chunk in chunks {
        let end = chunk
            .start_ms
            .checked_add(chunk.duration_ms)
            .ok_or_else(|| anyhow!("录音时间轴溢出"))?;
        lengths
            .entry(chunk.epoch)
            .and_modify(|v: &mut u64| *v = (*v).max(end))
            .or_insert(end);
    }
    let mut total = 0u64;
    for length in lengths.values_mut() {
        let duration = *length;
        *length = total;
        total = total
            .checked_add(duration)
            .ok_or_else(|| anyhow!("录音时间轴溢出"))?;
        if total > MAX_DURATION_MS {
            bail!("本地说话人分离最多支持 2 小时录音；原始录音和转写仍保留");
        }
    }
    Ok((lengths, total))
}

fn read_mixed(chunks: &[VoicePlaybackChunk], cancel: &AtomicBool) -> Result<Vec<f32>> {
    let (offsets, total) = timeline(chunks)?;
    let mut mixed = vec![0f32; (total * RATE / 1000) as usize];
    // Read each source incrementally. Never retain source-rate audio for an entire meeting.
    for chunk in chunks {
        check_cancel(cancel)?;
        let mut reader = BufReader::new(
            File::open(&chunk.path).with_context(|| format!("读取录音 {} 失败", chunk.path))?,
        );
        let mut h = [0u8; 44];
        reader.read_exact(&mut h)?;
        let channels = u16::from_le_bytes(h[22..24].try_into()?);
        let rate = u32::from_le_bytes(h[24..28].try_into()?);
        let bytes = u32::from_le_bytes(h[40..44].try_into()?) as u64;
        if &h[..4] != b"RIFF"
            || &h[8..16] != b"WAVEfmt "
            || h[16..20] != 16u32.to_le_bytes()
            || h[20..22] != 3u16.to_le_bytes()
            || &h[36..40] != b"data"
            || h[34..36] != 32u16.to_le_bytes()
            || channels == 0
            || channels > 32
            || !(8_000..=192_000).contains(&rate)
            || bytes % (u64::from(channels) * 4) != 0
        {
            bail!("不支持或损坏的录音 WAV");
        }
        let frames = bytes / (u64::from(channels) * 4);
        // Saved chunks are at most 60 seconds, permit one rounding frame.
        if frames > u64::from(rate) * 60 + 1 || reader.get_ref().metadata()?.len() != 44 + bytes {
            bail!("录音分片大小无效");
        }
        let duration = frames * 1000 / u64::from(rate);
        if duration.abs_diff(chunk.duration_ms) > 1 {
            bail!("录音分片时长与时间轴不一致");
        }
        let base = (offsets[&chunk.epoch] + chunk.start_ms) * RATE / 1000;
        let output_frames = (frames * RATE).div_ceil(u64::from(rate));
        let mut frame = vec![0u8; usize::from(channels) * 4];
        let mut read_mono = || -> Result<f32> {
            reader.read_exact(&mut frame)?;
            let mut sum = 0f32;
            for sample in frame.chunks_exact(4) {
                let value = f32::from_le_bytes(sample.try_into()?);
                if !value.is_finite() {
                    bail!("录音包含无效采样");
                }
                sum += value;
            }
            Ok(sum / f32::from(channels))
        };
        if frames == 0 {
            continue;
        }
        let mut left = read_mono()?;
        let mut right = if frames > 1 { read_mono()? } else { left };
        let mut cursor = 0u64;
        for index in 0..output_frames {
            if index % 16_000 == 0 {
                check_cancel(cancel)?;
            }
            let position = index * u64::from(rate);
            let desired = position / RATE;
            while cursor < desired {
                left = right;
                cursor += 1;
                right = if cursor + 1 < frames {
                    read_mono()?
                } else {
                    left
                };
            }
            let fraction = (position % RATE) as f32 / RATE as f32;
            if let Some(out) = mixed.get_mut((base + index) as usize) {
                *out += left + (right - left) * fraction;
            }
        }
        check_cancel(cancel)?;
    }
    let peak = mixed.iter().fold(1f32, |peak, value| peak.max(value.abs()));
    for value in &mut mixed {
        *value /= peak;
    }
    Ok(mixed)
}

#[cfg(test)]
pub fn analyze(
    cache_root: &Path,
    chunks: &[VoicePlaybackChunk],
    cancel: &AtomicBool,
) -> Result<Vec<SpeakerTurn>> {
    Ok(analyze_with_embeddings(cache_root, chunks, cancel)?.turns)
}

pub fn analyze_with_embeddings(
    cache_root: &Path,
    chunks: &[VoicePlaybackChunk],
    cancel: &AtomicBool,
) -> Result<DiarizationAnalysis> {
    check_cancel(cancel)?;
    let samples = read_mixed(chunks, cancel)?;
    if samples.is_empty() {
        return Ok(DiarizationAnalysis {
            turns: Vec::new(),
            embeddings: Vec::new(),
        });
    }
    let status = diarization_model::status(cache_root);
    if !status.ready {
        bail!("{}", status.detail);
    }
    let directory = diarization_model::package_directory(cache_root);
    let mut config = OfflineSpeakerDiarizationConfig::default();
    config.segmentation.provider = Some("cpu".into());
    config.segmentation.num_threads = 1;
    config.embedding.provider = Some("cpu".into());
    config.embedding.num_threads = 1;
    config.segmentation.pyannote.model =
        Some(directory.join("model.onnx").to_string_lossy().into_owned());
    config.embedding.model = Some(
        directory
            .join(diarization_model::EMBEDDING_FILE)
            .to_string_lossy()
            .into_owned(),
    );
    // Unknown speaker count: one global clustering, never reset IDs per chunk.
    config.clustering.num_clusters = -1;
    // Official pyannote/3D-Speaker example recommends 0.9 for unknown-count
    // clustering. Verified on its Chinese four-speaker fixture: 0.7/0.8 split
    // one speaker (5 clusters); 0.9 preserves the four recurring voices.
    // https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/models.html
    config.clustering.threshold = 0.9;
    check_cancel(cancel)?;
    let engine = OfflineSpeakerDiarization::create(&config)
        .ok_or_else(|| anyhow!("无法加载本地说话人模型"))?;
    if engine.sample_rate() != RATE as i32 {
        bail!("说话人模型采样率不匹配");
    }
    check_cancel(cancel)?;
    let result = engine
        .process(&samples)
        .ok_or_else(|| anyhow!("本地说话人分离失败"))?;
    // sherpa 1.13.8 progress callbacks ignore their return value; they cannot
    // interrupt process(). Keep the entire waveform in one clustering run.
    check_cancel(cancel)?;
    let mut ids = BTreeMap::new();
    let mut turns = Vec::new();
    let duration_ms = samples.len() as u64 * 1000 / RATE;
    for segment in result.sort_by_start_time() {
        if !segment.start.is_finite()
            || !segment.end.is_finite()
            || segment.start < 0.0
            || segment.end <= segment.start
            || segment.speaker < 0
        {
            bail!("说话人模型返回无效时间段");
        }
        let next = ids.len() as u32 + 1;
        let speaker_id = *ids.entry(segment.speaker).or_insert(next);
        let start_ms = ((segment.start as f64 * 1000.0).round() as u64).min(duration_ms);
        let end_ms = ((segment.end as f64 * 1000.0).round() as u64).min(duration_ms);
        if end_ms > start_ms {
            turns.push(SpeakerTurn {
                start_ms,
                end_ms,
                speaker_id,
            });
        }
    }
    drop(result);
    drop(engine);
    let embeddings = extract_embeddings(&directory, &samples, &turns, cancel)?;
    Ok(DiarizationAnalysis { turns, embeddings })
}

fn normalize(values: &mut [f32]) -> Result<()> {
    let norm = values
        .iter()
        .map(|value| f64::from(*value).powi(2))
        .sum::<f64>()
        .sqrt();
    if !norm.is_finite() || norm < 1e-12 {
        bail!("说话人模型返回无效声纹");
    }
    for value in values {
        *value = (f64::from(*value) / norm) as f32;
    }
    Ok(())
}

// Subtract other speakers' intervals before selecting the longest clean samples.
fn clean_intervals(turns: &[SpeakerTurn], speaker_id: u32) -> Vec<(u64, u64)> {
    let mut clean = Vec::new();
    for turn in turns.iter().filter(|turn| turn.speaker_id == speaker_id) {
        let mut pieces = vec![(turn.start_ms, turn.end_ms)];
        for other in turns.iter().filter(|other| other.speaker_id != speaker_id) {
            pieces = pieces
                .into_iter()
                .flat_map(|(start, end)| {
                    if other.end_ms <= start || other.start_ms >= end {
                        return vec![(start, end)];
                    }
                    let mut remaining = Vec::new();
                    if start < other.start_ms {
                        remaining.push((start, other.start_ms));
                    }
                    if other.end_ms < end {
                        remaining.push((other.end_ms, end));
                    }
                    remaining
                })
                .collect();
        }
        clean.extend(
            pieces
                .into_iter()
                .filter(|(start, end)| end - start >= 3000),
        );
    }
    clean.sort_by_key(|(start, end)| std::cmp::Reverse(end - start));
    clean
}

fn extract_embeddings(
    directory: &Path,
    samples: &[f32],
    turns: &[SpeakerTurn],
    cancel: &AtomicBool,
) -> Result<Vec<SpeakerEmbedding>> {
    use sherpa_onnx::{SpeakerEmbeddingExtractor, SpeakerEmbeddingExtractorConfig};
    check_cancel(cancel)?;
    let extractor = SpeakerEmbeddingExtractor::create(&SpeakerEmbeddingExtractorConfig {
        model: Some(
            directory
                .join(diarization_model::EMBEDDING_FILE)
                .to_string_lossy()
                .into_owned(),
        ),
        provider: Some("cpu".into()),
        num_threads: 1,
        ..Default::default()
    })
    .ok_or_else(|| anyhow!("无法加载本地声纹模型"))?;
    let ids = turns
        .iter()
        .map(|turn| turn.speaker_id)
        .collect::<std::collections::BTreeSet<_>>();
    let mut output = Vec::new();
    for speaker_id in ids {
        let mut remaining = 30_000;
        let mut sum = vec![0f32; extractor.dim() as usize];
        let mut count = 0;
        for (start, end) in clean_intervals(turns, speaker_id) {
            let duration = (end - start).min(remaining);
            if duration < 3000 {
                break;
            }
            check_cancel(cancel)?;
            let stream = extractor
                .create_stream()
                .ok_or_else(|| anyhow!("无法创建声纹音频流"))?;
            stream.accept_waveform(
                RATE as i32,
                &samples[(start * 16) as usize
                    ..((start + duration) * 16).min(samples.len() as u64) as usize],
            );
            stream.input_finished();
            if !extractor.is_ready(&stream) {
                bail!("声纹模型未接受有效语音片段");
            }
            let mut embedding = extractor
                .compute(&stream)
                .ok_or_else(|| anyhow!("声纹提取失败"))?;
            check_cancel(cancel)?;
            normalize(&mut embedding)?;
            for (sum, value) in sum.iter_mut().zip(embedding) {
                *sum += value;
            }
            count += 1;
            remaining -= duration;
        }
        if count > 0 {
            normalize(&mut sum)?;
            output.push(SpeakerEmbedding {
                speaker_id,
                embedding: sum,
            });
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn wav(path: &Path, samples: &[f32], rate: u32) {
        let mut h = [0u8; 44];
        h[..4].copy_from_slice(b"RIFF");
        h[4..8].copy_from_slice(&(36 + samples.len() as u32 * 4).to_le_bytes());
        h[8..16].copy_from_slice(b"WAVEfmt ");
        h[16..20].copy_from_slice(&16u32.to_le_bytes());
        h[20..22].copy_from_slice(&3u16.to_le_bytes());
        h[22..24].copy_from_slice(&1u16.to_le_bytes());
        h[24..28].copy_from_slice(&rate.to_le_bytes());
        h[34..36].copy_from_slice(&32u16.to_le_bytes());
        h[36..40].copy_from_slice(b"data");
        h[40..44].copy_from_slice(&(samples.len() as u32 * 4).to_le_bytes());
        let mut bytes = h.to_vec();
        for value in samples {
            bytes.extend(value.to_le_bytes());
        }
        std::fs::write(path, bytes).unwrap();
    }
    fn chunk(path: &Path, epoch: u64, source: &str, duration_ms: u64) -> VoicePlaybackChunk {
        VoicePlaybackChunk {
            source: source.into(),
            epoch,
            start_ms: 0,
            duration_ms,
            path: path.to_string_lossy().into_owned(),
        }
    }
    #[test]
    fn mixes_sources_and_concatenates_pause_epochs() {
        let temp = tempfile::tempdir().unwrap();
        let a = temp.path().join("a.wav");
        let b = temp.path().join("b.wav");
        wav(&a, &vec![0.2; 8000], 8000);
        wav(&b, &vec![0.3; 48000], 48000);
        let input = [
            chunk(&b, 2, "system", 1000),
            chunk(&a, 1, "microphone", 1000),
            chunk(&b, 1, "system", 1000),
        ];
        let mixed = read_mixed(&input, &AtomicBool::new(false)).unwrap();
        assert_eq!(mixed.len(), 32000);
        assert!((mixed[0] - 0.5).abs() < 0.001);
        assert!((mixed[16000] - 0.3).abs() < 0.001);
    }
    #[test]
    fn rejects_invalid_audio_budget_and_cancellation() {
        let temp = tempfile::tempdir().unwrap();
        let a = temp.path().join("a.wav");
        wav(&a, &[f32::NAN; 16], 16000);
        assert!(read_mixed(&[chunk(&a, 1, "microphone", 1)], &AtomicBool::new(false)).is_err());
        assert!(read_mixed(
            &[chunk(&a, 1, "microphone", MAX_DURATION_MS + 1)],
            &AtomicBool::new(false)
        )
        .unwrap_err()
        .to_string()
        .contains("2 小时"));
        assert!(analyze(temp.path(), &[], &AtomicBool::new(true))
            .unwrap_err()
            .to_string()
            .contains("取消"));
    }
    #[test]
    fn voiceprints_exclude_overlap_and_short_fragments() {
        let turns = vec![
            SpeakerTurn {
                start_ms: 0,
                end_ms: 10000,
                speaker_id: 1,
            },
            SpeakerTurn {
                start_ms: 4000,
                end_ms: 6000,
                speaker_id: 2,
            },
        ];
        assert_eq!(clean_intervals(&turns, 1), vec![(0, 4000), (6000, 10000)]);
        assert!(clean_intervals(&turns, 2).is_empty());
        let mut values = vec![3.0, 4.0];
        normalize(&mut values).unwrap();
        assert!((values[0] - 0.6).abs() < 1e-6);
        assert!(normalize(&mut [0.0, 0.0]).is_err());
    }
    #[test]
    fn refuses_truncated_wav_and_inconsistent_timeline() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("audio.wav");
        wav(&path, &[0.2; 160], 16000);
        let cancel = AtomicBool::new(false);
        assert!(read_mixed(&[chunk(&path, 1, "microphone", 1000)], &cancel)
            .unwrap_err()
            .to_string()
            .contains("时长"));
        let mut bytes = std::fs::read(&path).unwrap();
        bytes.pop();
        std::fs::write(&path, bytes).unwrap();
        assert!(read_mixed(&[chunk(&path, 1, "microphone", 10)], &cancel)
            .unwrap_err()
            .to_string()
            .contains("大小"));
    }
    #[test]
    #[ignore = "set PROJECT_MIND_DIARIZATION_MODEL and PROJECT_MIND_DIARIZATION_WAV to official external assets"]
    fn real_chinese_four_speaker_smoke() {
        let model = std::env::var("PROJECT_MIND_DIARIZATION_MODEL").unwrap();
        let input = std::env::var("PROJECT_MIND_DIARIZATION_WAV").unwrap();
        let cache = tempfile::tempdir().unwrap();
        diarization_model::import(Path::new(&model), cache.path()).unwrap();
        let wave = sherpa_onnx::Wave::read(&input).unwrap();
        assert_eq!(wave.sample_rate(), 16000);
        let path = cache.path().join("meeting.wav");
        wav(&path, wave.samples(), 16000);
        let duration = wave.samples().len() as u64 / 16;
        let analysis = analyze_with_embeddings(
            cache.path(),
            &[chunk(&path, 1, "microphone", duration)],
            &AtomicBool::new(false),
        )
        .unwrap();
        let turns = analysis.turns;
        assert!(analysis.embeddings.len() >= 2);
        assert!(analysis
            .embeddings
            .iter()
            .all(|speaker| speaker.embedding.len() == 512));
        let speakers = turns
            .iter()
            .map(|turn| turn.speaker_id)
            .collect::<std::collections::BTreeSet<_>>();
        eprintln!(
            "real smoke: {} turns, {} speakers: {:?}",
            turns.len(),
            speakers.len(),
            turns
        );
        assert_eq!(speakers.len(),4,"the official four-person fixture must preserve its four voices without a configured speaker count");
        assert!(turns
            .windows(2)
            .all(|pair| pair[0].start_ms <= pair[1].start_ms));
        assert!(turns.iter().all(|turn| turn.end_ms <= duration));
        // Independent halves of the longest clean turn represent the same person.
        let same = turns
            .iter()
            .find_map(|turn| {
                clean_intervals(&turns, turn.speaker_id)
                    .into_iter()
                    .find(|(start, end)| end - start >= 6200)
                    .map(|interval| (turn.speaker_id, interval))
            })
            .expect("fixture must include a long clean turn");
        let different = turns
            .iter()
            .filter(|turn| turn.speaker_id != same.0)
            .find_map(|turn| clean_intervals(&turns, turn.speaker_id).first().copied())
            .unwrap();
        let extractor = sherpa_onnx::SpeakerEmbeddingExtractor::create(
            &sherpa_onnx::SpeakerEmbeddingExtractorConfig {
                model: Some(
                    diarization_model::package_directory(cache.path())
                        .join(diarization_model::EMBEDDING_FILE)
                        .to_string_lossy()
                        .into_owned(),
                ),
                ..Default::default()
            },
        )
        .unwrap();
        let extract = |start: u64| {
            let stream = extractor.create_stream().unwrap();
            stream.accept_waveform(
                16000,
                &wave.samples()[(start * 16) as usize..((start + 3000) * 16) as usize],
            );
            stream.input_finished();
            let mut embedding = extractor.compute(&stream).unwrap();
            normalize(&mut embedding).unwrap();
            embedding
        };
        let a = extract(same.1 .0);
        let b = extract(same.1 .0 + 3100);
        let c = extract(different.0);
        let cosine = |x: &[f32], y: &[f32]| x.iter().zip(y).map(|(a, b)| a * b).sum::<f32>();
        let same_score = cosine(&a, &b);
        let different_score = cosine(&a, &c);
        eprintln!("voiceprint cosine: same={same_score:.4}, different={different_score:.4}");
        // Initial product gate, not a calibrated false-acceptance guarantee.
        // Real meeting noise, channel changes and near-ties still require abstention.
        assert!(
            same_score >= CONTACT_MATCH_THRESHOLD,
            "independent same-person samples must pass the candidate voiceprint gate"
        );
        assert!(
            different_score < CONTACT_MATCH_THRESHOLD,
            "different-person samples must fail the candidate voiceprint gate"
        );
        // Exercise enrollment and later matching using real, disjoint voice samples.
        let mut db =
            crate::db::Database::open(&cache.path().join("voice.sqlite"), cache.path(), None)
                .unwrap();
        let contact = db
            .contact_upsert(crate::models::ContactUpsertInput {
                id: None,
                base_revision: None,
                name: "声音验收联系人".into(),
                pinyin_full: None,
                pinyin_abbr: None,
                email: None,
                employee_id: None,
                role: None,
                department: None,
                nicknames: None,
                nickname_pinyin: None,
                notes: None,
            })
            .unwrap();
        for (index, (start, embedding)) in [(same.1 .0, a), (same.1 .0 + 3100, b), (different.0, c)]
            .into_iter()
            .enumerate()
        {
            let id = format!("real-voice-{index}");
            let session = db
                .voice_session_create(
                    &super::super::contracts::RecordTarget::Workspace,
                    &id,
                    &id,
                    "真实声纹验收",
                )
                .unwrap();
            let relative_path = format!(".project-mind/voice/{id}/microphone.wav");
            let audio = cache.path().join(&relative_path);
            std::fs::create_dir_all(audio.parent().unwrap()).unwrap();
            wav(
                &audio,
                &wave.samples()[(start * 16) as usize..((start + 3000) * 16) as usize],
                16000,
            );
            db.voice_audio_chunk_insert(
                &id,
                &super::super::storage::AudioChunkManifest {
                    source: "microphone",
                    epoch: 1,
                    chunk_index: 0,
                    start_sample: 0,
                    sample_count: 48_000,
                    sample_rate: 16_000,
                    channels: 1,
                    relative_path,
                    byte_size: 192_044,
                },
            )
            .unwrap();
            db.voice_session_transition(&id, session.revision, "ended", None, 3000, 1)
                .unwrap();
            db.voice_diarization_enqueue(&id).unwrap();
            let (_, revision) = db.voice_diarization_claim().unwrap().unwrap();
            db.voice_diarization_finish_with_embeddings(
                &id,
                revision,
                &[super::super::contracts::VoiceSpeakerTurn {
                    start_ms: 0,
                    end_ms: 3000,
                    speaker_id: 1,
                }],
                diarization_model::PACKAGE_ID,
                &[(1, embedding)],
            )
            .unwrap();
            let target = super::super::contracts::VoiceRecordLookup::Workspace {
                record_id: session.workspace_note_id.unwrap(),
            };
            let snapshot = db.voice_diarization_get(&target).unwrap().unwrap();
            match index {
                0 => {
                    db.voice_speaker_link_contact(&target, 1, Some(contact.id), snapshot.revision)
                        .unwrap();
                }
                1 => {
                    assert_eq!(snapshot.speakers[0].contact_id, Some(contact.id));
                    assert_eq!(
                        snapshot.speakers[0].association.as_deref(),
                        Some("automatic")
                    );
                }
                _ => assert!(
                    snapshot.speakers[0].contact_id.is_none(),
                    "different voice must remain anonymous"
                ),
            }
        }
        eprintln!("real voice contact enrollment, later match and unknown voice rejection passed");
    }
}
