use super::{
    contracts::{RecordTarget, VoiceSessionSnapshot},
    storage::{recover_partial_tracks, AudioChunkManifest, PersistedVoiceSession, WriterHandle},
};
use crate::db::Database;
use anyhow::{anyhow, Context, Result};
use chrono::Local;
use rand::RngCore;
use std::{path::Path, time::Instant};

#[cfg(target_os = "macos")]
use super::capture::macos::{MacCaptureOutputs, MacCaptureSession};
#[cfg(target_os = "macos")]
use super::capture::AudioSource;

const AUDIO_QUEUE_CAPACITY: usize = 256;

#[derive(Default)]
pub struct VoiceRuntime {
    active: Option<ActiveSession>,
}

struct ActiveSession {
    persisted: PersistedVoiceSession,
    recording_since: Option<Instant>,
    run: Option<CaptureRun>,
}

struct CaptureRun {
    #[cfg(target_os = "macos")]
    capture: Option<MacCaptureSession>,
    microphone_writer: WriterHandle,
    system_writer: WriterHandle,
    #[cfg(target_os = "macos")]
    faults: tokio::sync::mpsc::Receiver<super::capture::macos::MacCaptureFault>,
}

impl VoiceRuntime {
    pub fn reset(&mut self) {
        debug_assert!(self.active.is_none());
        self.active = None;
    }

    pub fn start(
        &mut self,
        db: &mut Database,
        workspace_root: &Path,
        target: &RecordTarget,
        request_id: &str,
    ) -> Result<VoiceSessionSnapshot> {
        if let Some(active) = &self.active {
            let persisted = db
                .voice_session_by_request(request_id)?
                .filter(|session| session.session_id == active.persisted.session_id)
                .ok_or_else(|| anyhow!("another recording session already owns audio capture"))?;
            return Ok(snapshot(&persisted, active.recording_since));
        }
        preflight_capture()?;
        let session_id = new_session_id();
        let title = format!("语音记录 · {}", Local::now().format("%Y-%m-%d %H:%M"));
        let persisted = db.voice_session_create(target, request_id, &session_id, &title)?;
        if persisted.lifecycle != "preparing" {
            return Ok(snapshot(&persisted, None));
        }
        let run = match start_capture_run(
            workspace_root,
            &persisted.session_id,
            persisted.capture_epoch,
        ) {
            Ok(run) => run,
            Err(error) => {
                let persisted = db.voice_session_transition(
                    &persisted.session_id,
                    persisted.revision,
                    "paused",
                    Some("capture_start_failed"),
                    persisted.active_ms,
                    persisted.capture_epoch,
                )?;
                self.active = Some(ActiveSession {
                    persisted,
                    recording_since: None,
                    run: None,
                });
                return Err(error);
            }
        };
        let persisted = db.voice_session_transition(
            &persisted.session_id,
            persisted.revision,
            "recording",
            None,
            persisted.active_ms,
            persisted.capture_epoch,
        )?;
        let active = ActiveSession {
            persisted,
            recording_since: Some(Instant::now()),
            run: Some(run),
        };
        let result = snapshot(&active.persisted, active.recording_since);
        self.active = Some(active);
        Ok(result)
    }

    pub fn pause(
        &mut self,
        db: &mut Database,
        session_id: &str,
        expected_revision: u64,
    ) -> Result<VoiceSessionSnapshot> {
        self.load_if_needed(db, session_id)?;
        let active = self
            .active
            .as_mut()
            .ok_or_else(|| anyhow!("voice session not found"))?;
        verify(active, session_id, expected_revision)?;
        if active.persisted.lifecycle == "paused" {
            return Ok(snapshot(&active.persisted, None));
        }
        if active.persisted.lifecycle != "recording" {
            return Err(anyhow!("voice session cannot be paused from current state"));
        }
        let elapsed = active
            .recording_since
            .take()
            .map(|started| started.elapsed().as_millis() as u64)
            .unwrap_or_default();
        let manifests = stop_capture_run(active.run.take())?;
        persist_manifests(db, session_id, &manifests)?;
        active.persisted = db.voice_session_transition(
            session_id,
            expected_revision,
            "paused",
            Some("user"),
            active.persisted.active_ms.saturating_add(elapsed),
            active.persisted.capture_epoch,
        )?;
        Ok(snapshot(&active.persisted, None))
    }

    pub fn resume(
        &mut self,
        db: &mut Database,
        workspace_root: &Path,
        session_id: &str,
        expected_revision: u64,
    ) -> Result<VoiceSessionSnapshot> {
        self.load_if_needed(db, session_id)?;
        let active = self
            .active
            .as_mut()
            .ok_or_else(|| anyhow!("voice session not found"))?;
        verify(active, session_id, expected_revision)?;
        if active.persisted.lifecycle != "paused" {
            return Err(anyhow!("voice session is not paused"));
        }
        preflight_capture()?;
        let epoch = active
            .persisted
            .capture_epoch
            .checked_add(1)
            .ok_or_else(|| anyhow!("capture epoch exhausted"))?;
        let run = start_capture_run(workspace_root, session_id, epoch)?;
        active.persisted = db.voice_session_transition(
            session_id,
            expected_revision,
            "recording",
            None,
            active.persisted.active_ms,
            epoch,
        )?;
        active.recording_since = Some(Instant::now());
        active.run = Some(run);
        Ok(snapshot(&active.persisted, active.recording_since))
    }

    pub fn end(
        &mut self,
        db: &mut Database,
        session_id: &str,
        expected_revision: u64,
    ) -> Result<VoiceSessionSnapshot> {
        self.load_if_needed(db, session_id)?;
        verify(
            self.active
                .as_ref()
                .ok_or_else(|| anyhow!("voice session not found"))?,
            session_id,
            expected_revision,
        )?;
        let mut active = self
            .active
            .take()
            .ok_or_else(|| anyhow!("voice session not found"))?;
        if active.persisted.lifecycle == "ended" {
            return Ok(snapshot(&active.persisted, None));
        }
        let elapsed = active
            .recording_since
            .take()
            .map(|started| started.elapsed().as_millis() as u64)
            .unwrap_or_default();
        let manifests = stop_capture_run(active.run.take())?;
        persist_manifests(db, session_id, &manifests)?;
        let ending = db.voice_session_transition(
            session_id,
            expected_revision,
            "ending",
            None,
            active.persisted.active_ms.saturating_add(elapsed),
            active.persisted.capture_epoch,
        )?;
        let ended = db.voice_session_transition(
            session_id,
            ending.revision,
            "ended",
            None,
            ending.active_ms,
            ending.capture_epoch,
        )?;
        Ok(snapshot(&ended, None))
    }

    pub fn snapshot(
        &mut self,
        db: &mut Database,
        workspace_root: &Path,
    ) -> Result<Option<VoiceSessionSnapshot>> {
        if self.active.is_none() {
            if let Some(mut persisted) = db.voice_current_session()? {
                if persisted.lifecycle == "recording" || persisted.lifecycle == "preparing" {
                    for manifest in recover_partial_tracks(workspace_root, &persisted.session_id)? {
                        db.voice_audio_chunk_insert(&persisted.session_id, &manifest)?;
                    }
                    persisted = db.voice_session_transition(
                        &persisted.session_id,
                        persisted.revision,
                        "paused",
                        Some("recovered"),
                        persisted.active_ms,
                        persisted.capture_epoch,
                    )?;
                }
                self.active = Some(ActiveSession {
                    persisted,
                    recording_since: None,
                    run: None,
                });
            }
        }
        let capture_faulted = self
            .active
            .as_mut()
            .and_then(|active| active.run.as_mut())
            .is_some_and(capture_run_faulted);
        if capture_faulted {
            let active = self.active.as_mut().expect("checked active session");
            let elapsed = active
                .recording_since
                .take()
                .map(|started| started.elapsed().as_millis() as u64)
                .unwrap_or_default();
            let manifests = stop_capture_run(active.run.take())?;
            persist_manifests(db, &active.persisted.session_id, &manifests)?;
            active.persisted = db.voice_session_transition(
                &active.persisted.session_id,
                active.persisted.revision,
                "paused",
                Some("capture_fault"),
                active.persisted.active_ms.saturating_add(elapsed),
                active.persisted.capture_epoch,
            )?;
        }
        Ok(self
            .active
            .as_ref()
            .map(|active| snapshot(&active.persisted, active.recording_since)))
    }

    pub fn has_unfinished_session(
        &mut self,
        db: &mut Database,
        workspace_root: &Path,
    ) -> Result<bool> {
        Ok(self.snapshot(db, workspace_root)?.is_some())
    }

    fn load_if_needed(&mut self, db: &mut Database, session_id: &str) -> Result<()> {
        if self.active.is_none() {
            let persisted = db
                .voice_session_get(session_id)?
                .ok_or_else(|| anyhow!("voice session not found"))?;
            self.active = Some(ActiveSession {
                persisted,
                recording_since: None,
                run: None,
            });
        }
        Ok(())
    }
}

fn verify(active: &ActiveSession, session_id: &str, expected_revision: u64) -> Result<()> {
    if active.persisted.session_id != session_id {
        return Err(anyhow!(
            "another recording session owns the capture runtime"
        ));
    }
    if active.persisted.revision != expected_revision {
        return Err(anyhow!("voice session revision conflict"));
    }
    Ok(())
}

fn snapshot(
    session: &PersistedVoiceSession,
    recording_since: Option<Instant>,
) -> VoiceSessionSnapshot {
    let elapsed = recording_since
        .map(|started| started.elapsed().as_millis() as u64)
        .unwrap_or_default();
    VoiceSessionSnapshot {
        session_id: session.session_id.clone(),
        revision: session.revision,
        phase: session.lifecycle.clone(),
        active_ms: session.active_ms.saturating_add(elapsed),
        pause_reason: session.pause_reason.clone(),
        project_note_id: session.project_note_id,
        workspace_note_id: session.workspace_note_id,
    }
}

fn new_session_id() -> String {
    let mut bytes = [0_u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

fn persist_manifests(
    db: &Database,
    session_id: &str,
    manifests: &[AudioChunkManifest],
) -> Result<()> {
    for manifest in manifests {
        db.voice_audio_chunk_insert(session_id, manifest)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn preflight_capture() -> Result<()> {
    MacCaptureSession::preflight().map_err(|error| anyhow!(error))
}

#[cfg(not(target_os = "macos"))]
fn preflight_capture() -> Result<()> {
    Err(anyhow!(
        "voice capture is not implemented on this platform yet"
    ))
}

#[cfg(target_os = "macos")]
fn start_capture_run(workspace_root: &Path, session_id: &str, epoch: u64) -> Result<CaptureRun> {
    let (capture, outputs) =
        MacCaptureSession::start(epoch, AUDIO_QUEUE_CAPACITY).map_err(|error| anyhow!(error))?;
    Ok(build_capture_run(
        workspace_root,
        session_id,
        epoch,
        capture,
        outputs,
    ))
}

#[cfg(target_os = "macos")]
fn build_capture_run(
    workspace_root: &Path,
    session_id: &str,
    epoch: u64,
    capture: MacCaptureSession,
    outputs: MacCaptureOutputs,
) -> CaptureRun {
    CaptureRun {
        capture: Some(capture),
        microphone_writer: WriterHandle::spawn(
            workspace_root.to_path_buf(),
            session_id.to_string(),
            AudioSource::Microphone,
            epoch,
            outputs.microphone,
        ),
        system_writer: WriterHandle::spawn(
            workspace_root.to_path_buf(),
            session_id.to_string(),
            AudioSource::System,
            epoch,
            outputs.system,
        ),
        faults: outputs.faults,
    }
}

#[cfg(not(target_os = "macos"))]
fn start_capture_run(_workspace_root: &Path, _session_id: &str, _epoch: u64) -> Result<CaptureRun> {
    Err(anyhow!(
        "voice capture is not implemented on this platform yet"
    ))
}

fn stop_capture_run(run: Option<CaptureRun>) -> Result<Vec<AudioChunkManifest>> {
    let Some(mut run) = run else {
        return Ok(Vec::new());
    };
    #[cfg(target_os = "macos")]
    if let Some(mut capture) = run.capture.take() {
        capture.stop().map_err(|error| anyhow!(error))?;
        drop(capture);
    }
    let microphone = run.microphone_writer.finish();
    let system = run.system_writer.finish();
    let microphone = microphone.context("failed to finalize microphone track")?;
    let system = system.context("failed to finalize system track")?;
    Ok(vec![microphone, system])
}

#[cfg(target_os = "macos")]
fn capture_run_faulted(run: &mut CaptureRun) -> bool {
    run.faults.try_recv().is_ok()
}

#[cfg(not(target_os = "macos"))]
fn capture_run_faulted(_run: &mut CaptureRun) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_end_request_keeps_the_owned_session() {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(
            &root.path().join("app.sqlite3"),
            root.path(),
            Some("test-secret".to_string()),
        )
        .unwrap();
        let persisted = db
            .voice_session_create(&RecordTarget::Workspace, "request", "session", "Voice")
            .unwrap();
        let mut runtime = VoiceRuntime {
            active: Some(ActiveSession {
                persisted: persisted.clone(),
                recording_since: None,
                run: None,
            }),
        };

        assert!(runtime
            .end(&mut db, "session", persisted.revision + 1)
            .is_err());
        assert_eq!(
            runtime.active.as_ref().unwrap().persisted.session_id,
            "session"
        );
        assert_eq!(
            db.voice_session_get("session").unwrap().unwrap().lifecycle,
            "preparing"
        );
    }
}
