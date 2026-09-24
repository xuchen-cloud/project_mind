use super::{
    contracts::{RecordTarget, SpeechProfile, VoiceSessionSnapshot},
    live_local::{LiveLocalHandle, RecognitionUpdate},
    live_paraformer::LiveParaformerHandle,
    local_asr::LocalAsrWorker,
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
    interim_text: Option<String>,
}

enum PreparedRecognition {
    Local {
        worker: LocalAsrWorker,
        preview_enabled: bool,
    },
    Paraformer {
        endpoint: String,
        api_key: String,
        preview_enabled: bool,
    },
}

enum ActiveRecognition {
    Local(LiveLocalHandle),
    Paraformer(LiveParaformerHandle),
}

impl ActiveRecognition {
    fn try_result(&self) -> Option<Result<RecognitionUpdate>> {
        match self {
            Self::Local(handle) => handle.try_result(),
            Self::Paraformer(handle) => handle.try_result(),
        }
    }

    fn finish(self) -> Vec<Result<RecognitionUpdate>> {
        match self {
            Self::Local(handle) => handle.finish(),
            Self::Paraformer(handle) => handle.finish(),
        }
    }
}

struct CaptureRun {
    #[cfg(target_os = "macos")]
    capture: Option<MacCaptureSession>,
    microphone_writer: WriterHandle,
    system_writer: WriterHandle,
    recognition: Option<ActiveRecognition>,
    #[cfg(target_os = "macos")]
    faults: tokio::sync::mpsc::Receiver<super::capture::macos::MacCaptureFault>,
}

impl VoiceRuntime {
    pub fn set_live_preview_enabled(&mut self, enabled: bool) {
        if let Some(active) = self.active.as_mut() {
            if !enabled {
                active.interim_text = None;
            }
            if let Some(recognition) = active.run.as_ref().and_then(|run| run.recognition.as_ref())
            {
                match recognition {
                    ActiveRecognition::Local(handle) => handle.set_preview_enabled(enabled),
                    ActiveRecognition::Paraformer(handle) => handle.set_preview_enabled(enabled),
                }
            }
        }
    }

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
            return Ok(snapshot(
                &persisted,
                active.recording_since,
                active.interim_text.as_deref(),
            ));
        }
        preflight_capture()?;
        let recognition = prepare_recognition(db)?;
        let session_id = new_session_id();
        let title = format!("语音记录 · {}", Local::now().format("%Y-%m-%d %H:%M"));
        let persisted = db.voice_session_create(target, request_id, &session_id, &title)?;
        if persisted.lifecycle != "preparing" {
            return Ok(snapshot(&persisted, None, None));
        }
        let run = match start_capture_run(
            workspace_root,
            &persisted.session_id,
            persisted.capture_epoch,
            persisted.active_ms,
            recognition,
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
                    interim_text: None,
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
            interim_text: None,
        };
        let result = snapshot(
            &active.persisted,
            active.recording_since,
            active.interim_text.as_deref(),
        );
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
            return Ok(snapshot(&active.persisted, None, None));
        }
        if active.persisted.lifecycle != "recording" {
            return Err(anyhow!("voice session cannot be paused from current state"));
        }
        let elapsed = active
            .recording_since
            .take()
            .map(|started| started.elapsed().as_millis() as u64)
            .unwrap_or_default();
        let stopped = stop_capture_run(active.run.take())?;
        persist_manifests(db, session_id, &stopped.manifests)?;
        let recognition_error = persist_transcripts(db, session_id, stopped.results).err();
        active.persisted = db.voice_session_transition(
            session_id,
            expected_revision,
            "paused",
            Some("user"),
            active.persisted.active_ms.saturating_add(elapsed),
            active.persisted.capture_epoch,
        )?;
        if let Some(error) = recognition_error {
            return Err(error).context("录音已暂停，但语音识别失败");
        }
        active.interim_text = None;
        Ok(snapshot(&active.persisted, None, None))
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
        let recognition = prepare_recognition(db)?;
        let epoch = active
            .persisted
            .capture_epoch
            .checked_add(1)
            .ok_or_else(|| anyhow!("capture epoch exhausted"))?;
        let run = start_capture_run(
            workspace_root,
            session_id,
            epoch,
            active.persisted.active_ms,
            recognition,
        )?;
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
        active.interim_text = None;
        Ok(snapshot(&active.persisted, active.recording_since, None))
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
            return Ok(snapshot(&active.persisted, None, None));
        }
        let elapsed = active
            .recording_since
            .take()
            .map(|started| started.elapsed().as_millis() as u64)
            .unwrap_or_default();
        let stopped = stop_capture_run(active.run.take())?;
        persist_manifests(db, session_id, &stopped.manifests)?;
        let recognition_error = persist_transcripts(db, session_id, stopped.results).err();
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
        if let Some(error) = recognition_error {
            return Err(error).context("录音已保存，但语音识别失败");
        }
        Ok(snapshot(&ended, None, None))
    }

    pub fn snapshot(
        &mut self,
        db: &mut Database,
        workspace_root: &Path,
    ) -> Result<Option<VoiceSessionSnapshot>> {
        if let Some(active) = self.active.as_mut() {
            if let Some(run) = &active.run {
                persist_available_transcripts(
                    db,
                    &active.persisted.session_id,
                    run,
                    &mut active.interim_text,
                )?;
            }
        }
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
                    interim_text: None,
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
            let stopped = stop_capture_run(active.run.take())?;
            persist_manifests(db, &active.persisted.session_id, &stopped.manifests)?;
            let recognition_error =
                persist_transcripts(db, &active.persisted.session_id, stopped.results).err();
            active.persisted = db.voice_session_transition(
                &active.persisted.session_id,
                active.persisted.revision,
                "paused",
                Some("capture_fault"),
                active.persisted.active_ms.saturating_add(elapsed),
                active.persisted.capture_epoch,
            )?;
            active.interim_text = None;
            if let Some(error) = recognition_error {
                return Err(error).context("录音因采集故障已暂停，且语音识别失败");
            }
        }
        Ok(self.active.as_ref().map(|active| {
            snapshot(
                &active.persisted,
                active.recording_since,
                active.interim_text.as_deref(),
            )
        }))
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
                interim_text: None,
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
    interim_text: Option<&str>,
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
        interim_text: interim_text.map(str::to_string),
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

fn prepare_recognition(db: &Database) -> Result<PreparedRecognition> {
    let settings = db.voice_settings_get()?;
    match settings.speech_profile {
        Some(SpeechProfile::SenseVoiceOnnx { .. }) => {
            let cache = crate::default_app_data_dir()?;
            Ok(PreparedRecognition::Local {
                worker: LocalAsrWorker::start(&cache)?,
                preview_enabled: settings.live_preview_enabled,
            })
        }
        Some(SpeechProfile::Paraformer {
            endpoint,
            model,
            credential_profile_id,
        }) => {
            if model != "paraformer-realtime-v2" {
                return Err(anyhow!("unsupported Paraformer model"));
            }
            super::paraformer::validate_endpoint(&endpoint)?;
            let profile_id =
                credential_profile_id.ok_or_else(|| anyhow!("请先选择 Paraformer 凭据"))?;
            let api_key = db.voice_credential_from_ai_profile(profile_id)?;
            Ok(PreparedRecognition::Paraformer {
                endpoint,
                api_key,
                preview_enabled: settings.live_preview_enabled,
            })
        }
        None => Err(anyhow!("请先在语音设置中选择并保存语音识别引擎")),
    }
}

fn persist_transcripts(
    db: &Database,
    session_id: &str,
    results: Vec<Result<RecognitionUpdate>>,
) -> Result<()> {
    let mut first_error = None;
    for result in results {
        let result = match result {
            Ok(RecognitionUpdate::Final(result)) => result,
            Ok(RecognitionUpdate::Partial(_)) => continue,
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
                continue;
            }
        };
        if result.text.trim().is_empty() {
            continue;
        }
        if let Err(error) = db.voice_transcript_append_final(
            session_id,
            &result.provider_key,
            result.start_ms,
            result.end_ms,
            &result.text,
            None,
        ) {
            if first_error.is_none() {
                first_error = Some(error);
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn persist_available_transcripts(
    db: &Database,
    session_id: &str,
    run: &CaptureRun,
    interim_text: &mut Option<String>,
) -> Result<()> {
    let Some(recognition) = &run.recognition else {
        return Ok(());
    };
    while let Some(result) = recognition.try_result() {
        match result {
            Ok(RecognitionUpdate::Partial(text)) => {
                *interim_text = (!text.is_empty()).then_some(text);
            }
            other => persist_transcripts(db, session_id, vec![other])?,
        }
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
fn start_capture_run(
    workspace_root: &Path,
    session_id: &str,
    epoch: u64,
    epoch_offset_ms: u64,
    recognition: PreparedRecognition,
) -> Result<CaptureRun> {
    let (capture, outputs) = MacCaptureSession::start(epoch, AUDIO_QUEUE_CAPACITY, true)
        .map_err(|error| anyhow!(error))?;
    build_capture_run(
        workspace_root,
        session_id,
        epoch,
        epoch_offset_ms,
        recognition,
        capture,
        outputs,
    )
}

#[cfg(target_os = "macos")]
fn build_capture_run(
    workspace_root: &Path,
    session_id: &str,
    epoch: u64,
    epoch_offset_ms: u64,
    recognition: PreparedRecognition,
    capture: MacCaptureSession,
    outputs: MacCaptureOutputs,
) -> Result<CaptureRun> {
    let microphone = outputs
        .recognition_microphone
        .ok_or_else(|| anyhow!("missing recognition microphone"))?;
    let system = outputs
        .recognition_system
        .ok_or_else(|| anyhow!("missing recognition system audio"))?;
    let recognition = match recognition {
        PreparedRecognition::Local {
            worker,
            preview_enabled,
        } => ActiveRecognition::Local(LiveLocalHandle::spawn(
            worker,
            microphone,
            system,
            epoch_offset_ms,
            preview_enabled,
        )?),
        PreparedRecognition::Paraformer {
            endpoint,
            api_key,
            preview_enabled,
        } => ActiveRecognition::Paraformer(LiveParaformerHandle::spawn(
            endpoint,
            api_key,
            microphone,
            system,
            epoch_offset_ms,
            preview_enabled,
        )?),
    };
    Ok(CaptureRun {
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
        recognition: Some(recognition),
        faults: outputs.faults,
    })
}

#[cfg(not(target_os = "macos"))]
fn start_capture_run(
    _workspace_root: &Path,
    _session_id: &str,
    _epoch: u64,
    _epoch_offset_ms: u64,
    _recognition: PreparedRecognition,
) -> Result<CaptureRun> {
    Err(anyhow!(
        "voice capture is not implemented on this platform yet"
    ))
}

struct StoppedRun {
    manifests: Vec<AudioChunkManifest>,
    results: Vec<Result<RecognitionUpdate>>,
}

fn stop_capture_run(run: Option<CaptureRun>) -> Result<StoppedRun> {
    let Some(mut run) = run else {
        return Ok(StoppedRun {
            manifests: Vec::new(),
            results: Vec::new(),
        });
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
    let results = run
        .recognition
        .take()
        .map(ActiveRecognition::finish)
        .unwrap_or_default();
    Ok(StoppedRun {
        manifests: vec![microphone, system],
        results,
    })
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
    fn completed_local_sentence_is_saved_for_captions_and_record_transcript() {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(
            &root.path().join("app.sqlite3"),
            root.path(),
            Some("test-secret".to_string()),
        )
        .unwrap();
        let session = db
            .voice_session_create(&RecordTarget::Workspace, "request", "session", "Voice")
            .unwrap();
        persist_transcripts(
            &db,
            &session.session_id,
            vec![
                Ok(RecognitionUpdate::Partial("临时内容".into())),
                Ok(RecognitionUpdate::Final(
                    super::super::live_local::TranscriptFinal {
                        provider_key: "local:16000".into(),
                        start_ms: 1_000,
                        end_ms: 3_000,
                        text: "第一句话。".into(),
                    },
                )),
            ],
        )
        .unwrap();
        let captions = db.voice_transcript_tail(&session.session_id, 4).unwrap();
        assert_eq!(captions.len(), 1);
        assert_eq!(captions[0].text, "第一句话。");
        assert_eq!((captions[0].start_ms, captions[0].end_ms), (1_000, 3_000));
    }

    #[test]
    fn disabling_preview_clears_the_provisional_line_without_ending_the_session() {
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
                persisted,
                recording_since: None,
                run: None,
                interim_text: Some("正在识别".into()),
            }),
        };
        runtime.set_live_preview_enabled(false);
        let active = runtime.active.unwrap();
        assert!(active.interim_text.is_none());
        assert_eq!(active.persisted.lifecycle, "preparing");
    }

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
                interim_text: None,
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
