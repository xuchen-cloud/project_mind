//! Bounded replay of durable gaps. Live capture interrupts replay without losing progress.
use crate::{db::CloudGap, lock_mutex, WorkspaceRuntime};
use anyhow::{anyhow, Result};
use std::{
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

pub(crate) struct SavedChunk {
    pub path: std::path::PathBuf,
    pub start_sample: u64,
    pub sample_count: u64,
    pub sample_rate: u32,
    pub channels: u16,
}

pub(crate) fn read_mix(chunks: &[SavedChunk], start_ms: u64, end_ms: u64) -> Result<Vec<f32>> {
    if end_ms <= start_ms || end_ms - start_ms > 30_000 {
        return Err(anyhow!("invalid replay interval"));
    }
    let mut mixed = vec![0_f32; ((end_ms - start_ms) * 16) as usize];
    for chunk in chunks {
        if chunk.sample_rate == 0 || chunk.channels == 0 {
            return Err(anyhow!("invalid saved audio format"));
        }
        let start = start_ms * u64::from(chunk.sample_rate) / 1000;
        let end = end_ms * u64::from(chunk.sample_rate) / 1000;
        let first = start.max(chunk.start_sample);
        let last = end.min(chunk.start_sample + chunk.sample_count);
        if first >= last {
            continue;
        }
        let mut file = std::fs::File::open(&chunk.path)?;
        let mut header = [0; 44];
        file.read_exact(&mut header)?;
        if &header[..4] != b"RIFF"
            || &header[8..16] != b"WAVEfmt "
            || header[20..22] != 3_u16.to_le_bytes()
            || header[22..24] != chunk.channels.to_le_bytes()
            || header[24..28] != chunk.sample_rate.to_le_bytes()
            || &header[36..40] != b"data"
        {
            return Err(anyhow!("unsupported saved WAV"));
        }
        let stride = u64::from(chunk.channels) * 4;
        file.seek(SeekFrom::Start(44 + (first - chunk.start_sample) * stride))?;
        let mut bytes = vec![0; ((last - first) * stride) as usize];
        file.read_exact(&mut bytes)?;
        let mono: Vec<f32> = bytes
            .chunks_exact(stride as usize)
            .map(|frame| {
                frame
                    .chunks_exact(4)
                    .map(|sample| f32::from_le_bytes(sample.try_into().unwrap()))
                    .sum::<f32>()
                    / f32::from(chunk.channels)
            })
            .collect();
        for (index, output) in mixed.iter_mut().enumerate() {
            let position = (start_ms as f64 / 1000.0 + index as f64 / 16000.0)
                * f64::from(chunk.sample_rate)
                - first as f64;
            if position < 0.0 || position >= mono.len() as f64 {
                continue;
            }
            let left = position as usize;
            let fraction = (position - left as f64) as f32;
            let value = mono[left] + (mono[(left + 1).min(mono.len() - 1)] - mono[left]) * fraction;
            if !value.is_finite() {
                return Err(anyhow!("non-finite saved audio"));
            }
            *output += value;
        }
    }
    for value in &mut mixed {
        *value = value.clamp(-1.0, 1.0);
    }
    Ok(mixed)
}

pub(crate) fn managed_path(root: &Path, relative: &str) -> Result<std::path::PathBuf> {
    let path = root.join(relative).canonicalize()?;
    if !path.starts_with(root.join(super::storage::VOICE_ASSET_DIR).canonicalize()?) {
        return Err(anyhow!("saved audio escaped voice assets"));
    }
    Ok(path)
}

pub(crate) fn kick(workspace: Arc<WorkspaceRuntime>, handle: tauri::AppHandle) {
    if workspace
        .voice_recovery_running
        .swap(true, Ordering::AcqRel)
    {
        return;
    }
    std::thread::spawn(move || {
        let outcome = recover_one(&workspace, &handle);
        if let Err(error) = outcome {
            eprintln!("voice recovery worker: {error}");
        }
        workspace
            .voice_recovery_running
            .store(false, Ordering::Release);
    });
}

fn recover_one(workspace: &WorkspaceRuntime, handle: &tauri::AppHandle) -> Result<()> {
    if workspace.voice_recovery_interrupt.load(Ordering::Acquire) {
        return Ok(());
    }
    let Some(gap) =
        lock_mutex(&workspace.db).voice_cloud_claim(chrono::Utc::now().timestamp_millis())?
    else {
        return Ok(());
    };
    let result = replay(workspace, &gap);
    match result {
        Ok(Some((end, results))) => {
            let (result, changes) = {
                use tauri::Manager;
                let state = handle.state::<crate::AppState>();
                let current = lock_mutex(&state.current_workspace);
                if workspace.voice_recovery_interrupt.load(Ordering::Acquire)
                    || !current.as_ref().is_some_and(|current| current.agent_binding == workspace.agent_binding) {
                    lock_mutex(&workspace.db).voice_cloud_release(gap.id, None, 0)?;
                    return Ok(());
                }
                let mut db = lock_mutex(&workspace.db);
                crate::committed_changes::capture_native_committed(&workspace.agent_binding, &mut db, "voice-recovery", |db|
                    db.voice_cloud_commit(&gap, end, &results))?
            };
            if let Some(changes) = changes { crate::committed_changes::publish_to(handle, changes); }
            result?;
            workspace.kick_voice_minutes();
        }
        Ok(None) => lock_mutex(&workspace.db).voice_cloud_release(gap.id, None, 0)?,
        Err(error) => lock_mutex(&workspace.db).voice_cloud_release(
            gap.id,
            Some(&error.to_string()),
            chrono::Utc::now().timestamp_millis(),
        )?,
    }
    Ok(())
}

fn replay(
    workspace: &WorkspaceRuntime,
    gap: &CloudGap,
) -> Result<Option<(u64, Vec<super::live_local::TranscriptFinal>)>> {
    let end = gap
        .end_ms
        .ok_or_else(|| anyhow!("unsealed recovery interval"))?
        .min(gap.cursor_ms + 30_000);
    let (key, chunks) = {
        let db = lock_mutex(&workspace.db);
        (
            db.voice_credential_from_ai_profile(gap.credential_profile_id)?,
            db.voice_cloud_audio(gap)?,
        )
    };
    let samples = read_mix(
        &chunks,
        gap.cursor_ms.saturating_sub(gap.epoch_offset_ms),
        end.saturating_sub(gap.epoch_offset_ms),
    )?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        let connection = super::live_paraformer::transcribe_saved(&gap.endpoint, &key, &samples, gap.cursor_ms);
        tokio::pin!(connection);
        let timeout = tokio::time::sleep(Duration::from_secs(90));
        tokio::pin!(timeout);
        loop {
            tokio::select! {
                result = &mut connection => return result.map(|results| Some((end, results))),
                _ = &mut timeout => return Err(anyhow!("补转写请求超时")),
                _ = tokio::time::sleep(Duration::from_millis(100)) => {
                    if workspace.voice_recovery_interrupt.load(Ordering::Acquire) { return Ok(None); }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_reads_only_requested_interval_across_chunks() {
        let root = tempfile::tempdir().unwrap();
        let mut chunks = Vec::new();
        for index in 0..2 {
            let path = root.path().join(format!("{index}.wav"));
            let mut bytes = vec![0; 44];
            bytes[..4].copy_from_slice(b"RIFF");
            bytes[8..16].copy_from_slice(b"WAVEfmt ");
            bytes[20..22].copy_from_slice(&3_u16.to_le_bytes());
            bytes[22..24].copy_from_slice(&1_u16.to_le_bytes());
            bytes[24..28].copy_from_slice(&16000_u32.to_le_bytes());
            bytes[36..40].copy_from_slice(b"data");
            for _ in 0..16000 {
                bytes.extend_from_slice(&(0.2 + index as f32 * 0.2).to_le_bytes());
            }
            std::fs::write(&path, bytes).unwrap();
            chunks.push(SavedChunk {
                path,
                start_sample: index * 16000,
                sample_count: 16000,
                sample_rate: 16000,
                channels: 1,
            });
        }
        let mixed = read_mix(&chunks, 500, 1500).unwrap();
        assert_eq!(mixed.len(), 16000);
        assert!((mixed[0] - 0.2).abs() < 0.0001);
        assert!((mixed[12000] - 0.4).abs() < 0.0001);
    }
}
