//! Durable audio boundary for Voice Record.
use super::capture::{AudioFrameStream, AudioSource};
use anyhow::{anyhow, Result};
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::{BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    thread,
    sync::mpsc,
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
    completed: mpsc::Receiver<AudioChunkManifest>,
    join: Option<thread::JoinHandle<Result<Vec<AudioChunkManifest>>>>,
}

impl WriterHandle {
    pub fn spawn(
        workspace_root: PathBuf,
        session_id: String,
        source: AudioSource,
        epoch: u64,
        mut frames: AudioFrameStream,
    ) -> Self {
        let (send, completed) = mpsc::channel();
        let join = thread::Builder::new()
            .name(format!("voice-writer-{}", source_name(source)))
            .spawn(move || write_track(&workspace_root, &session_id, source, epoch, &mut frames, Some(&send)))
            .expect("voice writer thread should start");
        Self { join: Some(join), completed }
    }

    pub fn take_completed(&self) -> Vec<AudioChunkManifest> {
        self.completed.try_iter().collect()
    }

    pub fn has_stopped(&self) -> bool {
        self.join.as_ref().is_some_and(|join| join.is_finished())
    }

    pub fn finish(mut self) -> Result<Vec<AudioChunkManifest>> {
        self.join
            .take()
            .expect("writer can only be joined once")
            .join()
            .map_err(|_| anyhow!("voice writer thread panicked"))?
    }
}

pub const MIN_FREE_BYTES: u64 = 16 * 1024 * 1024;

pub fn ensure_storage_capacity(root: &Path, minimum: u64) -> Result<()> {
    if fs2::available_space(root)? < minimum {
        return Err(anyhow!("磁盘可用空间不足，录音已停止写入"));
    }
    Ok(())
}

pub fn preflight_storage(root: &Path) -> Result<()> {
    ensure_storage_capacity(root, MIN_FREE_BYTES)?;
    let directory = root.join(VOICE_ASSET_DIR);
    fs::create_dir_all(&directory)?;
    let mut probe = tempfile::NamedTempFile::new_in(&directory)?;
    probe.write_all(b"voice storage preflight")?;
    probe.as_file().sync_all()?;
    Ok(())
}

/// One minute bounds the recovery unit and keeps RIFF sizes below the format limit.
const CHUNK_SECONDS: u64 = 60;

struct TrackChunk {
    writer: BufWriter<File>,
    partial_path: PathBuf,
    final_path: PathBuf,
    manifest: AudioChunkManifest,
}

impl TrackChunk {
    fn create(root: &Path, directory: &Path, source: AudioSource, epoch: u64,
        index: u64, start: u64, rate: u32, channels: u16) -> Result<Self> {
        // Coordinates in the managed filename survive a crash before SQLite registration.
        let final_path = directory.join(format!("{}-{index}-{start}.wav", source_name(source)));
        let partial_path = final_path.with_extension("wav.part");
        let file = OpenOptions::new().create_new(true).read(true).write(true).open(&partial_path)?;
        let mut writer = BufWriter::new(file);
        writer.write_all(&[0_u8; 44])?;
        checkpoint_wav(&mut writer, rate, channels, 0)?;
        Ok(Self { writer, partial_path, manifest: AudioChunkManifest {
            source: source_name(source), epoch, chunk_index: index, start_sample: start,
            sample_count: 0, sample_rate: rate, channels,
            relative_path: final_path.strip_prefix(root)?.to_string_lossy().replace('\\', "/"),
            byte_size: 44,
        }, final_path })
    }

    fn finish(mut self) -> Result<AudioChunkManifest> {
        checkpoint_wav(&mut self.writer, self.manifest.sample_rate, self.manifest.channels, self.manifest.sample_count)?;
        self.writer.get_ref().sync_all()?;
        drop(self.writer);
        fs::rename(&self.partial_path, &self.final_path)?;
        sync_directory(self.final_path.parent().expect("chunk directory"))?;
        self.manifest.byte_size = fs::metadata(&self.final_path)?.len();
        Ok(self.manifest)
    }
}

fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn write_track(
    workspace_root: &Path, session_id: &str, source: AudioSource, epoch: u64,
    frames: &mut AudioFrameStream, completed: Option<&mpsc::Sender<AudioChunkManifest>>,
) -> Result<Vec<AudioChunkManifest>> {
    let directory = workspace_root.join(VOICE_ASSET_DIR).join(session_id).join(format!("epoch-{epoch}"));
    fs::create_dir_all(&directory)?;
    let mut chunks = Vec::new();
    let mut active: Option<TrackChunk> = None;
    let mut format = None;
    let mut next_start = None;
    let mut space_checked = std::time::Instant::now();
    ensure_storage_capacity(workspace_root, MIN_FREE_BYTES)?;
    while let Some(frame) = frames.blocking_next() {
        if frame.channels == 0 || frame.sample_rate == 0 || frame.samples.len() % usize::from(frame.channels) != 0 {
            return Err(anyhow!("invalid audio frame"));
        }
        if space_checked.elapsed().as_secs() >= 1 {
            ensure_storage_capacity(workspace_root, MIN_FREE_BYTES)?;
            space_checked = std::time::Instant::now();
        }
        let expected = *format.get_or_insert((frame.sample_rate, frame.channels));
        if expected != (frame.sample_rate, frame.channels) {
            return Err(anyhow!("audio format changed within one capture epoch"));
        }
        let start = (u128::from(frame.media_position_ns()) * u128::from(frame.sample_rate) / 1_000_000_000) as u64;
        let position = next_start.get_or_insert(start);
        let channels = usize::from(frame.channels);
        let limit = (u64::from(frame.sample_rate) * CHUNK_SECONDS).min((u64::from(u32::MAX) - 36) / (channels as u64 * 4));
        let mut remaining = frame.samples.as_slice();
        while !remaining.is_empty() {
            if active.is_none() {
                active = Some(TrackChunk::create(workspace_root, &directory, source, epoch,
                    chunks.len() as u64, *position, frame.sample_rate, frame.channels)?);
            }
            let chunk = active.as_mut().expect("created chunk");
            let count = (limit - chunk.manifest.sample_count).min((remaining.len() / channels) as u64);
            let (samples, rest) = remaining.split_at(count as usize * channels);
            for sample in samples { chunk.writer.write_all(&sample.to_le_bytes())?; }
            chunk.manifest.sample_count += count;
            *position += count;
            checkpoint_wav(&mut chunk.writer, frame.sample_rate, frame.channels, chunk.manifest.sample_count)?;
            remaining = rest;
            if chunk.manifest.sample_count == limit {
                let manifest = active.take().expect("full chunk").finish()?;
                if let Some(send) = completed { let _ = send.send(manifest.clone()); }
                chunks.push(manifest);
            }
        }
    }
    if let Some(chunk) = active { chunks.push(chunk.finish()?); }
    Ok(chunks)
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
        for file in fs::read_dir(entry.path())? {
            let file = file?;
            if !file.file_type()?.is_file() { continue; }
            let filename = file.file_name().to_string_lossy().into_owned();
            let partial = filename.ends_with(".wav.part");
            let stem = filename.strip_suffix(".wav.part").or_else(|| filename.strip_suffix(".wav"));
            let Some(stem) = stem else { continue; };
            let mut parts = stem.split('-');
            let source = match parts.next() {
                Some("microphone") => "microphone", Some("system") => "system", _ => continue,
            };
            let coordinates = match (parts.next(), parts.next(), parts.next()) {
                (None, None, None) => (0, 0), // Read old epoch-only recordings.
                (Some(index), Some(start), None) => match (index.parse::<u64>(), start.parse::<u64>()) {
                    (Ok(index), Ok(start)) => (index, start), _ => continue,
                },
                _ => continue,
            };
            let final_path = entry.path().join(format!("{stem}.wav"));
            if partial && final_path.exists() { continue; }
            if let Some(mut manifest) = recover_partial_track(workspace_root, &file.path(), &final_path, source, epoch)? {
                manifest.chunk_index = coordinates.0;
                manifest.start_sample = coordinates.1;
                recovered.push(manifest);
            }
        }
    }
    recovered.sort_by_key(|chunk| (chunk.epoch, chunk.source, chunk.chunk_index));
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
    if partial_path != final_path {
        fs::rename(partial_path, final_path)?;
        sync_directory(final_path.parent().expect("chunk directory"))?;
    }
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
    fn write_failure_preserves_completed_chunks_and_storage_preflight_rejects_insufficient_space() {
        let root = tempfile::tempdir().unwrap();
        assert!(ensure_storage_capacity(root.path(), u64::MAX).is_err());
        preflight_storage(root.path()).unwrap();
        let blocked = root.path().join(VOICE_ASSET_DIR).join("failure/epoch-1/microphone-1-600.wav.part");
        fs::create_dir_all(&blocked).unwrap();
        let (sink, stream) = bounded_audio_frames(1).unwrap();
        let writer = WriterHandle::spawn(root.path().into(), "failure".into(), AudioSource::Microphone, 1, stream);
        let mut timeline = SourceTimeline::new(AudioSource::Microphone, 1, 0, 10, 1).unwrap();
        sink.try_push(timeline.stamp(0, vec![0.5; 601]).unwrap()).unwrap();
        drop(sink);
        assert!(writer.finish().is_err());
        let saved = recover_partial_tracks(root.path(), "failure").unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].sample_count, 600);
    }

    #[test]
    fn recording_rolls_tracks_and_recovers_their_original_timeline() {
        let workspace = tempfile::tempdir().unwrap();
        let (sink, stream) = bounded_audio_frames(2).unwrap();
        let writer = WriterHandle::spawn(workspace.path().to_path_buf(), "rolling".into(), AudioSource::Microphone, 1, stream);
        let mut timeline = SourceTimeline::new(AudioSource::Microphone, 1, 0, 10, 1).unwrap();
        sink.try_push(timeline.stamp(200_000_000, vec![0.25; 601]).unwrap()).unwrap();
        drop(sink);
        let chunks = writer.finish().unwrap();
        assert_eq!(chunks.len(), 2);
        assert_eq!((chunks[0].start_sample, chunks[0].sample_count), (2, 600));
        assert_eq!((chunks[1].start_sample, chunks[1].sample_count), (602, 1));
        let last = workspace.path().join(&chunks[1].relative_path);
        fs::rename(&last, last.with_extension("wav.part")).unwrap();
        let recovered = recover_partial_tracks(workspace.path(), "rolling").unwrap();
        assert_eq!(recovered.len(), 2);
        assert_eq!((recovered[1].start_sample, recovered[1].sample_count), (602, 1));
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
            None,
        )
        .unwrap().remove(0);
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
            None,
        )
        .unwrap().remove(0);
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
