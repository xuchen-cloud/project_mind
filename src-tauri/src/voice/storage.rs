//! Durable audio boundary for Voice Record.
use super::capture::{AudioFrame, AudioFrameStream, AudioSource};
use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::{BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    thread,
};

pub const VOICE_ASSET_DIR: &str = ".project-mind/voice";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistedVoiceSession {
    pub session_id: String,
    pub voice_record_id: i64,
    pub project_note_id: Option<i64>,
    pub workspace_note_id: Option<i64>,
    pub lifecycle: String,
    pub pause_reason: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub active_ms: u64,
    pub revision: u64,
    pub capture_epoch: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioChunkManifest {
    pub source: &'static str,
    pub epoch: u64,
    pub chunk_index: u64,
    pub start_sample: u64,
    pub sample_count: u64,
    pub sample_rate: u32,
    pub channels: u16,
    pub relative_path: String,
    pub byte_size: u64,
}

pub struct WriterHandle {
    join: Option<thread::JoinHandle<Result<AudioChunkManifest>>>,
}

impl WriterHandle {
    pub fn spawn(
        workspace_root: PathBuf,
        session_id: String,
        source: AudioSource,
        epoch: u64,
        mut frames: AudioFrameStream,
    ) -> Self {
        let join = thread::Builder::new()
            .name(format!("voice-writer-{}", source_name(source)))
            .spawn(move || write_track(&workspace_root, &session_id, source, epoch, &mut frames))
            .expect("voice writer thread should start");
        Self { join: Some(join) }
    }

    pub fn finish(mut self) -> Result<AudioChunkManifest> {
        self.join
            .take()
            .expect("writer can only be joined once")
            .join()
            .map_err(|_| anyhow!("voice writer thread panicked"))?
    }
}

fn write_track(
    workspace_root: &Path,
    session_id: &str,
    source: AudioSource,
    epoch: u64,
    frames: &mut AudioFrameStream,
) -> Result<AudioChunkManifest> {
    let directory = workspace_root
        .join(VOICE_ASSET_DIR)
        .join(session_id)
        .join(format!("epoch-{epoch}"));
    fs::create_dir_all(&directory).with_context(|| {
        format!(
            "failed to create voice asset directory {}",
            directory.display()
        )
    })?;
    let file_name = format!("{}.wav", source_name(source));
    let final_path = directory.join(&file_name);
    let partial_path = directory.join(format!("{file_name}.part"));
    let file = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(&partial_path)
        .with_context(|| format!("failed to create audio chunk {}", partial_path.display()))?;
    let mut writer = BufWriter::new(file);
    writer.write_all(&[0_u8; 44])?;

    let first = frames
        .blocking_next()
        .ok_or_else(|| anyhow!("capture ended before {source:?} produced audio"))?;
    let sample_rate = first.sample_rate;
    let channels = first.channels;
    let source_offset_samples = u128::from(first.media_position_ns())
        .saturating_mul(u128::from(first.sample_rate))
        / 1_000_000_000;
    let start_sample = u64::try_from(source_offset_samples).unwrap_or(u64::MAX);
    let mut sample_count = 0_u64;
    write_frame(
        &mut writer,
        &first,
        sample_rate,
        channels,
        &mut sample_count,
    )?;
    checkpoint_wav(&mut writer, sample_rate, channels, sample_count)?;
    let mut checkpoint_at = sample_count.saturating_add(u64::from(sample_rate));
    while let Some(frame) = frames.blocking_next() {
        write_frame(
            &mut writer,
            &frame,
            sample_rate,
            channels,
            &mut sample_count,
        )?;
        if sample_count >= checkpoint_at {
            checkpoint_wav(&mut writer, sample_rate, channels, sample_count)?;
            checkpoint_at = sample_count.saturating_add(u64::from(sample_rate));
        }
    }

    let data_bytes = sample_count
        .checked_mul(u64::from(channels))
        .and_then(|value| value.checked_mul(4))
        .ok_or_else(|| anyhow!("audio chunk size overflow"))?;
    let data_bytes_u32 = u32::try_from(data_bytes).context("WAV chunk exceeded 4 GiB")?;
    write_wav_header(&mut writer, sample_rate, channels, data_bytes_u32)?;
    writer.flush()?;
    let file = writer.into_inner().map_err(|error| error.into_error())?;
    file.sync_all()?;
    fs::rename(&partial_path, &final_path)?;
    if let Some(parent) = final_path.parent() {
        File::open(parent)?.sync_all()?;
    }
    let byte_size = fs::metadata(&final_path)?.len();
    let relative_path = final_path
        .strip_prefix(workspace_root)
        .context("voice asset escaped workspace")?
        .to_string_lossy()
        .replace('\\', "/");

    Ok(AudioChunkManifest {
        source: source_name(source),
        epoch,
        chunk_index: 0,
        start_sample,
        sample_count,
        sample_rate,
        channels,
        relative_path,
        byte_size,
    })
}

fn checkpoint_wav(
    writer: &mut BufWriter<File>,
    sample_rate: u32,
    channels: u16,
    sample_count: u64,
) -> Result<()> {
    let data_bytes = sample_count
        .checked_mul(u64::from(channels))
        .and_then(|value| value.checked_mul(4))
        .ok_or_else(|| anyhow!("audio chunk size overflow"))?;
    write_wav_header(writer, sample_rate, channels, u32::try_from(data_bytes)?)?;
    writer.flush()?;
    Ok(())
}

pub fn recover_partial_tracks(
    workspace_root: &Path,
    session_id: &str,
) -> Result<Vec<AudioChunkManifest>> {
    let session_dir = workspace_root.join(VOICE_ASSET_DIR).join(session_id);
    if !session_dir.exists() {
        return Ok(Vec::new());
    }
    let mut recovered = Vec::new();
    for entry in fs::read_dir(&session_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let directory_name = entry.file_name();
        let Some(epoch) = directory_name
            .to_string_lossy()
            .strip_prefix("epoch-")
            .and_then(|value| value.parse::<u64>().ok())
        else {
            continue;
        };
        for source in [AudioSource::Microphone, AudioSource::System] {
            let name = source_name(source);
            let partial_path = entry.path().join(format!("{name}.wav.part"));
            let final_path = entry.path().join(format!("{name}.wav"));
            if !partial_path.exists() || final_path.exists() {
                continue;
            }
            if let Some(manifest) =
                recover_partial_track(workspace_root, &partial_path, &final_path, name, epoch)?
            {
                recovered.push(manifest);
            }
        }
    }
    Ok(recovered)
}

fn recover_partial_track(
    workspace_root: &Path,
    partial_path: &Path,
    final_path: &Path,
    source: &'static str,
    epoch: u64,
) -> Result<Option<AudioChunkManifest>> {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(partial_path)?;
    let mut header = [0_u8; 44];
    if file.read_exact(&mut header).is_err()
        || &header[0..4] != b"RIFF"
        || &header[8..12] != b"WAVE"
    {
        return Ok(None);
    }
    let channels = u16::from_le_bytes([header[22], header[23]]);
    let sample_rate = u32::from_le_bytes([header[24], header[25], header[26], header[27]]);
    if channels == 0 || sample_rate == 0 {
        return Ok(None);
    }
    let block_align = u64::from(channels) * 4;
    let file_len = file.metadata()?.len();
    let data_bytes = file_len.saturating_sub(44) / block_align * block_align;
    if data_bytes == 0 || data_bytes > u64::from(u32::MAX) {
        return Ok(None);
    }
    let sample_count = data_bytes / block_align;
    file.set_len(44 + data_bytes)?;
    let mut writer = BufWriter::new(file);
    write_wav_header(&mut writer, sample_rate, channels, data_bytes as u32)?;
    writer.flush()?;
    let file = writer.into_inner().map_err(|error| error.into_error())?;
    file.sync_all()?;
    fs::rename(partial_path, final_path)?;
    let relative_path = final_path
        .strip_prefix(workspace_root)?
        .to_string_lossy()
        .replace('\\', "/");
    Ok(Some(AudioChunkManifest {
        source,
        epoch,
        chunk_index: 0,
        start_sample: 0,
        sample_count,
        sample_rate,
        channels,
        relative_path,
        byte_size: 44 + data_bytes,
    }))
}

fn write_frame(
    writer: &mut BufWriter<File>,
    frame: &AudioFrame,
    sample_rate: u32,
    channels: u16,
    sample_count: &mut u64,
) -> Result<()> {
    if frame.sample_rate != sample_rate || frame.channels != channels {
        return Err(anyhow!("audio format changed within one capture epoch"));
    }
    for sample in &frame.samples {
        writer.write_all(&sample.to_le_bytes())?;
    }
    *sample_count = sample_count
        .checked_add(u64::try_from(frame.samples.len() / usize::from(channels))?)
        .ok_or_else(|| anyhow!("audio sample counter overflow"))?;
    Ok(())
}

fn write_wav_header(
    writer: &mut BufWriter<File>,
    sample_rate: u32,
    channels: u16,
    data_bytes: u32,
) -> Result<()> {
    let byte_rate = sample_rate
        .checked_mul(u32::from(channels))
        .and_then(|value| value.checked_mul(4))
        .ok_or_else(|| anyhow!("invalid WAV byte rate"))?;
    let block_align = channels
        .checked_mul(4)
        .ok_or_else(|| anyhow!("invalid WAV block alignment"))?;
    let riff_size = data_bytes
        .checked_add(36)
        .ok_or_else(|| anyhow!("invalid WAV size"))?;
    writer.seek(SeekFrom::Start(0))?;
    writer.write_all(b"RIFF")?;
    writer.write_all(&riff_size.to_le_bytes())?;
    writer.write_all(b"WAVEfmt ")?;
    writer.write_all(&16_u32.to_le_bytes())?;
    writer.write_all(&3_u16.to_le_bytes())?;
    writer.write_all(&channels.to_le_bytes())?;
    writer.write_all(&sample_rate.to_le_bytes())?;
    writer.write_all(&byte_rate.to_le_bytes())?;
    writer.write_all(&block_align.to_le_bytes())?;
    writer.write_all(&32_u16.to_le_bytes())?;
    writer.write_all(b"data")?;
    writer.write_all(&data_bytes.to_le_bytes())?;
    writer.seek(SeekFrom::End(0))?;
    Ok(())
}

pub const fn source_name(source: AudioSource) -> &'static str {
    match source {
        AudioSource::Microphone => "microphone",
        AudioSource::System => "system",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::capture::{bounded_audio_frames, SourceTimeline};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_workspace() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("project-mind-voice-writer-{unique}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn integer_microphone_round_trips_through_float_wav_at_device_rate() {
        use crate::voice::capture::{decode_i16_pcm, PcmBuffer};
        let workspace = tempfile::tempdir().unwrap();
        let input = [-32768_i16, -1234, 0, 1234, 32767];
        let bytes = input
            .into_iter()
            .flat_map(i16::to_ne_bytes)
            .collect::<Vec<_>>();
        let samples = decode_i16_pcm(&[PcmBuffer {
            channels: 1,
            bytes: &bytes,
        }])
        .unwrap();
        let (sink, mut stream) = bounded_audio_frames(2).unwrap();
        let mut timeline = SourceTimeline::new(AudioSource::Microphone, 1, 0, 44_100, 1).unwrap();
        sink.try_push(timeline.stamp(0, samples).unwrap()).unwrap();
        drop(sink);
        let manifest = write_track(
            workspace.path(),
            "integer-input",
            AudioSource::Microphone,
            1,
            &mut stream,
        )
        .unwrap();
        assert_eq!(manifest.sample_count, input.len() as u64);
        assert_eq!(manifest.sample_rate, 44_100);
        let wav = fs::read(workspace.path().join(manifest.relative_path)).unwrap();
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 44_100);
        let output = wav[44..]
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(output, input.map(|value| f32::from(value) / 32768.0));
    }

    #[test]
    fn writer_finalizes_float_wav_and_recovers_a_crash_partial() {
        let workspace = temp_workspace();
        let (sink, mut stream) = bounded_audio_frames(2).unwrap();
        let mut timeline = SourceTimeline::new(AudioSource::Microphone, 1, 0, 48_000, 1).unwrap();
        sink.try_push(timeline.stamp(100_000_000, vec![0.25; 480]).unwrap())
            .unwrap();
        drop(sink);

        let manifest = write_track(
            &workspace,
            "session",
            AudioSource::Microphone,
            1,
            &mut stream,
        )
        .unwrap();
        assert_eq!(manifest.sample_count, 480);
        assert_eq!(manifest.start_sample, 4_800);
        let final_path = workspace.join(&manifest.relative_path);
        let partial_path = final_path.with_extension("wav.part");
        fs::rename(&final_path, &partial_path).unwrap();
        {
            let mut file = OpenOptions::new().write(true).open(&partial_path).unwrap();
            file.seek(SeekFrom::Start(40)).unwrap();
            file.write_all(&0_u32.to_le_bytes()).unwrap();
        }

        let recovered = recover_partial_tracks(&workspace, "session").unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].sample_count, 480);
        assert!(final_path.exists());
        assert!(!partial_path.exists());
        let _ = fs::remove_dir_all(workspace);
    }
}
