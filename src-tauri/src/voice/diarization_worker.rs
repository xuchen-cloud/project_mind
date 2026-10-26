//! One process-wide CPU worker. Results belong to the captured Workspace generation.
use super::{contracts::VoicePlaybackChunk, contracts::VoiceSpeakerTurn, diarization_model};
use crate::{lock_mutex, AppState, WorkspaceRuntime};
use anyhow::{anyhow, Result};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{Emitter, Manager};

static RUNNING: AtomicBool = AtomicBool::new(false);

struct WorkerPermit;
impl WorkerPermit {
    fn acquire() -> Option<Self> {
        RUNNING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self)
    }
}
impl Drop for WorkerPermit {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::Release);
        super::supervision::wake();
    }
}

pub(crate) fn kick(workspace: Arc<WorkspaceRuntime>, app: tauri::AppHandle) -> Result<()> {
    let Some(permit) = WorkerPermit::acquire() else {
        return Ok(());
    };
    let spawned = std::thread::Builder::new()
        .name("voice-diarization".into())
        .spawn(move || {
            let _permit = permit;
            if let Err(error) = run(&workspace, &app) {
                eprintln!("voice diarization worker: {error:#}");
                let _ = app.emit("voice:error", format!("说话人分析失败：{error:#}"));
            }
        });
    if let Err(error) = spawned {
        return Err(error.into());
    }
    Ok(())
}

fn run(workspace: &Arc<WorkspaceRuntime>, app: &tauri::AppHandle) -> Result<()> {
    let cache = crate::default_app_data_dir()?;
    let state = app.state::<AppState>();
    loop {
        let job = {
            let current = lock_mutex(&state.current_workspace);
            if !current
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, workspace))
                || workspace
                    .voice_diarization_interrupt
                    .load(Ordering::Acquire)
            {
                return Ok(());
            }
            lock_mutex(&workspace.db).voice_diarization_claim()?
        };
        let Some((session, revision)) = job else {
            return Ok(());
        };
        let result = (|| -> Result<_> {
            let snapshot = lock_mutex(&workspace.db)
                .voice_diarization_playback(&session)?
                .ok_or_else(|| anyhow!("语音记录已删除"))?;
            if snapshot.phase != "ended" {
                return Err(anyhow!("请先结束录音"));
            }
            let chunks = authorize_audio(&workspace.paths.root_path, snapshot.chunks)?;
            super::diarization_process::analyze(
                &workspace.paths.root_path,
                &cache,
                chunks,
                &workspace.voice_diarization_interrupt,
                &workspace.voice_diarization_process,
            )
        })();
        // Holding the current-Workspace lock fences a switch against the final commit.
        let current = lock_mutex(&state.current_workspace);
        let mut db = lock_mutex(&workspace.db);
        if !current
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, workspace))
            || workspace
                .voice_diarization_interrupt
                .load(Ordering::Acquire)
            || result.as_ref().is_err_and(|error| {
                error
                    .downcast_ref::<super::diarization_process::Cancelled>()
                    .is_some()
            })
        {
            db.voice_diarization_release(&session, revision)?;
            return Ok(());
        }
        let committed = result.and_then(|analysis| {
            let turns = analysis
                .turns
                .into_iter()
                .map(|turn| VoiceSpeakerTurn {
                    start_ms: turn.start_ms,
                    end_ms: turn.end_ms,
                    speaker_id: turn.speaker_id,
                })
                .collect::<Vec<_>>();
            let embeddings = analysis
                .embeddings
                .into_iter()
                .map(|item| (item.speaker_id, item.embedding))
                .collect::<Vec<_>>();
            db.voice_diarization_finish_with_embeddings(
                &session,
                revision,
                &turns,
                diarization_model::PACKAGE_ID,
                &embeddings,
            )
        });
        if let Err(error) = committed {
            db.voice_diarization_fail(&session, revision, &format!("{error:#}"))?;
        }
    }
}

pub(super) fn authorize_audio(
    root: &Path,
    mut chunks: Vec<VoicePlaybackChunk>,
) -> Result<Vec<VoicePlaybackChunk>> {
    let root = root.canonicalize()?;
    let assets = root.join(super::storage::VOICE_ASSET_DIR).canonicalize()?;
    if !assets.starts_with(&root) {
        return Err(anyhow!("录音目录超出当前 Workspace"));
    }
    for chunk in &mut chunks {
        let path = Path::new(&chunk.path).canonicalize()?;
        if !path.starts_with(&assets) {
            return Err(anyhow!("录音文件超出当前 Workspace 的语音目录"));
        }
        chunk.path = path.to_string_lossy().into_owned();
    }
    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cpu_permit_allows_only_one_analysis_until_owner_finishes() {
        let first = WorkerPermit::acquire().expect("first worker");
        assert!(WorkerPermit::acquire().is_none());
        drop(first);
        assert!(WorkerPermit::acquire().is_some());
    }

    #[test]
    fn diarization_audio_is_scoped_to_managed_voice_assets() {
        let root = tempfile::tempdir().unwrap();
        let assets = root.path().join(super::super::storage::VOICE_ASSET_DIR);
        std::fs::create_dir_all(&assets).unwrap();
        let inside = assets.join("test.wav");
        let outside = root.path().join("private.wav");
        std::fs::write(&inside, b"audio").unwrap();
        std::fs::write(&outside, b"private").unwrap();
        let chunk = |path: &Path| VoicePlaybackChunk {
            source: "microphone".into(),
            epoch: 0,
            start_ms: 0,
            duration_ms: 1,
            path: path.to_string_lossy().into_owned(),
        };
        assert!(authorize_audio(root.path(), vec![chunk(&inside)]).is_ok());
        assert!(authorize_audio(root.path(), vec![chunk(&outside)]).is_err());
    }
}
