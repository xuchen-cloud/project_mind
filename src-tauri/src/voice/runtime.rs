use super::{
    contracts::{RecordTarget, SpeechProfile, VoiceSessionSnapshot},
    live_local::{LiveLocalHandle, RecognitionUpdate},
    live_paraformer::LiveParaformerHandle,
    local_asr::LocalAsrWorker,
    storage::{
        preflight_storage, recover_partial_tracks, AudioChunkManifest, PersistedVoiceSession,
        WriterHandle,
    },
};
use crate::db::Database;
use anyhow::{anyhow, Result};
use chrono::Local;
use rand::RngCore;
use std::{path::Path, time::Instant};

#[cfg(target_os = "macos")]
use super::capture::macos::{
    MacCaptureFault as NativeCaptureFault, MacCaptureOutputs as NativeCaptureOutputs,
    MacCaptureSession as NativeCaptureSession,
};
#[cfg(target_os = "windows")]
use super::capture::windows::{
    WindowsCaptureFault as NativeCaptureFault, WindowsCaptureOutputs as NativeCaptureOutputs,
    WindowsCaptureSession as NativeCaptureSession,
};
#[cfg(any(target_os = "macos", target_os = "windows"))]
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
    pending_save: Option<StoppedRun>,
    pending_updates: Vec<RecognitionUpdate>,
}

enum PreparedRecognition {
    Local {
        worker: LocalAsrWorker,
        preview_enabled: bool,
    },
    Paraformer {
        endpoint: String,
        api_key: String,
        credential_profile_id: i64,
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
    activity: super::activity::ActivityHandle,
    workspace_root: std::path::PathBuf,
    session_id: String,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    capture: Option<NativeCaptureSession>,
    microphone_writer: WriterHandle,
    system_writer: WriterHandle,
    recognition: Option<ActiveRecognition>,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    faults: tokio::sync::mpsc::Receiver<NativeCaptureFault>,
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
            return snapshot(
                db,
                &persisted,
                active.recording_since,
                active.interim_text.as_deref(),
            );
        }
        preflight_storage(workspace_root)?;
        preflight_capture()?;
        let recognition = prepare_recognition(db)?;
        let session_id = new_session_id();
        let title = format!("语音记录 · {}", Local::now().format("%Y-%m-%d %H:%M"));
        let persisted = db.voice_session_create(target, request_id, &session_id, &title)?;
        if persisted.lifecycle != "preparing" {
            return snapshot(db, &persisted, None, None);
        }
        register_cloud_epoch(db, &persisted, recognition.as_ref())?;
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
                    pending_save: None,
                    pending_updates: Vec::new(),
                });
                return Err(error);
            }
        };
        let mut active = ActiveSession {
            persisted,
            recording_since: Some(Instant::now()),
            run: Some(run),
            interim_text: None,
            pending_save: None,
            pending_updates: Vec::new(),
        };
        match db.voice_session_transition(
            &active.persisted.session_id,
            active.persisted.revision,
            "recording",
            None,
            active.persisted.active_ms,
            active.persisted.capture_epoch,
        ) {
            Ok(persisted) => active.persisted = persisted,
            Err(error) => {
                stop_for_save(&mut active, "paused", "storage_fault")?;
                self.active = Some(active);
                return Err(error);
            }
        }
        let result = snapshot(
            db,
            &active.persisted,
            active.recording_since,
            active.interim_text.as_deref(),
        );
        self.active = Some(active);
        result
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
            return snapshot(db, &active.persisted, None, None);
        }
        if active.persisted.lifecycle != "recording" {
            return Err(anyhow!("voice session cannot be paused from current state"));
        }
        stop_for_save(active, "paused", "user")?;
        save_stopped_session(db, active)?;
        snapshot(db, &active.persisted, None, None)
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
        if active.pending_save.is_some() {
            return Err(anyhow!("音频保存待重试，完成后才能继续录音"));
        }
        if active.persisted.lifecycle != "paused" {
            return Err(anyhow!("voice session is not paused"));
        }
        preflight_storage(workspace_root)?;
        preflight_capture()?;
        let recognition = prepare_recognition(db)?;
        let epoch = active
            .persisted
            .capture_epoch
            .checked_add(1)
            .ok_or_else(|| anyhow!("capture epoch exhausted"))?;
        // Reserve the epoch before creating files, including failed start attempts.
        active.persisted = db.voice_session_transition(
            session_id,
            expected_revision,
            "paused",
            Some("capture_start_pending"),
            active.persisted.active_ms,
            epoch,
        )?;
        register_cloud_epoch(db, &active.persisted, recognition.as_ref())?;
        let run = start_capture_run(
            workspace_root,
            session_id,
            epoch,
            active.persisted.active_ms,
            recognition,
        )?;
        active.recording_since = Some(Instant::now());
        active.run = Some(run);
        active.interim_text = None;
        match db.voice_session_transition(
            session_id,
            active.persisted.revision,
            "recording",
            None,
            active.persisted.active_ms,
            epoch,
        ) {
            Ok(persisted) => active.persisted = persisted,
            Err(error) => {
                stop_for_save(active, "paused", "storage_fault")?;
                return Err(error);
            }
        }
        snapshot(db, &active.persisted, active.recording_since, None)
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
        let active = self
            .active
            .as_mut()
            .ok_or_else(|| anyhow!("voice session not found"))?;
        if active.persisted.lifecycle == "ended" {
            return snapshot(db, &active.persisted, None, None);
        }
        stop_for_save(active, "ending", "user")?;
        save_stopped_session(db, active)?;
        let result = snapshot(db, &active.persisted, None, None);
        self.active = None;
        result
    }

    pub fn snapshot(
        &mut self,
        db: &mut Database,
        workspace_root: &Path,
    ) -> Result<Option<VoiceSessionSnapshot>> {
        let mut storage_fault = None;
        if let Some(active) = self.active.as_mut() {
            if active.pending_save.is_some() {
                // Disk/database failures must not leave a stopped capture looking live.
                // Keep its recoverable save operation and retry on the next supervisor tick.
                if let Err(error) = save_stopped_session(db, active) {
                    active.persisted.pause_reason = Some(format!("保存待重试：{error}"));
                }
            }
            if active.persisted.lifecycle == "ended" {
                self.active = None;
            }
        }
        if let Some(active) = self.active.as_mut() {
            if let Some(run) = &active.run {
                let persisted = persist_manifests(
                    db,
                    &active.persisted.session_id,
                    &run.microphone_writer.take_completed(),
                )
                .and_then(|_| {
                    persist_manifests(
                        db,
                        &active.persisted.session_id,
                        &run.system_writer.take_completed(),
                    )
                });
                if let Err(error) = persisted {
                    storage_fault = Some(format!("storage_fault: {error}"));
                }
                // Recognition failures are independent of capture/storage health.
                if let Err(error) = persist_available_transcripts(
                    db,
                    &active.persisted.session_id,
                    active.persisted.capture_epoch,
                    run,
                    &mut active.interim_text,
                    &mut active.pending_updates,
                ) {
                    storage_fault = Some(format!("storage_fault: {error}"));
                }
            }
        }
        if self.active.is_none() {
            if let Some(mut persisted) = db.voice_current_session()? {
                if persisted.lifecycle != "ended" {
                    for manifest in recover_partial_tracks(workspace_root, &persisted.session_id)? {
                        db.voice_audio_chunk_insert(&persisted.session_id, &manifest)?;
                    }
                    db.voice_cloud_finish_epochs(&persisted.session_id)?;
                    persisted = db.voice_session_transition(
                        &persisted.session_id,
                        persisted.revision,
                        "paused",
                        Some("recovered"),
                        persisted
                            .active_ms
                            .max(db.voice_saved_duration_ms(&persisted.session_id)?),
                        persisted.capture_epoch,
                    )?;
                }
                self.active = Some(ActiveSession {
                    persisted,
                    recording_since: None,
                    run: None,
                    interim_text: None,
                    pending_save: None,
                    pending_updates: Vec::new(),
                });
            }
        }
        let capture_faulted = self
            .active
            .as_mut()
            .and_then(|active| active.run.as_mut())
            .is_some_and(capture_run_faulted);
        let silent = self
            .active
            .as_ref()
            .and_then(|active| active.run.as_ref())
            .is_some_and(|run| run.activity.should_pause());
        if capture_faulted || storage_fault.is_some() || silent {
            let active = self.active.as_mut().expect("checked active session");
            stop_for_save(
                active,
                "paused",
                storage_fault.as_deref().unwrap_or(if silent {
                    "silence"
                } else {
                    "capture_fault"
                }),
            )?;
            if let Err(error) = save_stopped_session(db, active) {
                active.persisted.pause_reason = Some(format!("保存待重试：{error}"));
            }
        }
        self.active
            .as_ref()
            .map(|active| {
                snapshot(
                    db,
                    &active.persisted,
                    active.recording_since,
                    active.interim_text.as_deref(),
                )
            })
            .transpose()
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
                pending_save: None,
                pending_updates: Vec::new(),
            });
        }
        Ok(())
    }
}

fn stop_for_save(active: &mut ActiveSession, phase: &str, reason: &str) -> Result<()> {
    if active.pending_save.is_none() {
        let elapsed = active
            .recording_since
            .take()
            .map(|start| start.elapsed().as_millis() as u64)
            .unwrap_or(0);
        active.persisted.active_ms = active.persisted.active_ms.saturating_add(elapsed);
        active.pending_save = Some(stop_capture_run(active.run.take())?);
    }
    active.persisted.lifecycle = phase.into();
    active.persisted.pause_reason = Some(
        active
            .pending_save
            .as_ref()
            .and_then(|saved| saved.storage_error.clone())
            .unwrap_or_else(|| reason.into()),
    );
    active.interim_text = None;
    Ok(())
}

fn save_stopped_session(db: &Database, active: &mut ActiveSession) -> Result<()> {
    let Some(saved) = &active.pending_save else {
        return Ok(());
    };
    let id = &active.persisted.session_id;
    persist_manifests(db, id, &saved.manifests)?;
    db.voice_recover_audio(id)?;
    // Keep final text in memory until all database writes succeed; a retry is idempotent.
    for update in &active.pending_updates {
        persist_recognition_update(db, id, active.persisted.capture_epoch, update)?;
    }
    for update in &saved.results {
        match update {
            Ok(update) => {
                persist_recognition_update(db, id, active.persisted.capture_epoch, update)?
            }
            Err(error) => {
                db.voice_recognition_failed(id, active.persisted.capture_epoch, &error.to_string())?
            }
        }
    }
    db.voice_cloud_finish_epochs(id)?;
    let phase = if active.persisted.lifecycle == "ending" {
        "ended"
    } else {
        "paused"
    };
    let auto_diarization = phase == "ended"
        && matches!(
            db.voice_settings_get()?.speech_profile,
            Some(super::contracts::SpeechProfile::SenseVoiceOnnx { .. })
        )
        && super::diarization_model::status(&crate::default_app_data_dir()?).ready;
    active.persisted = db.voice_session_save_stopped(
        id,
        active.persisted.revision,
        phase,
        active.persisted.pause_reason.as_deref(),
        db.voice_saved_duration_ms(id)?,
        active.persisted.capture_epoch,
        auto_diarization,
    )?;
    active.pending_save = None;
    active.pending_updates.clear();
    Ok(())
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
    db: &Database,
    session: &PersistedVoiceSession,
    recording_since: Option<Instant>,
    interim_text: Option<&str>,
) -> Result<VoiceSessionSnapshot> {
    let elapsed = recording_since
        .map(|started| started.elapsed().as_millis() as u64)
        .unwrap_or_default();
    Ok(VoiceSessionSnapshot {
        recognition_error: db
            .voice_recognition_error(&session.session_id, Some(session.capture_epoch))?,
        session_id: session.session_id.clone(),
        revision: session.revision,
        phase: session.lifecycle.clone(),
        active_ms: session.active_ms.saturating_add(elapsed),
        pause_reason: session.pause_reason.clone(),
        interim_text: interim_text.map(str::to_string),
        project_note_id: session.project_note_id,
        workspace_note_id: session.workspace_note_id,
    })
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

fn prepare_recognition(db: &Database) -> Result<Option<PreparedRecognition>> {
    let settings = db.voice_settings_get()?;
    match settings.speech_profile {
        Some(SpeechProfile::SenseVoiceOnnx { .. }) => {
            let cache = crate::default_app_data_dir()?;
            Ok(Some(PreparedRecognition::Local {
                worker: LocalAsrWorker::start(&cache)?,
                preview_enabled: settings.live_preview_enabled,
            }))
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
            Ok(Some(PreparedRecognition::Paraformer {
                endpoint,
                api_key,
                credential_profile_id: profile_id,
                preview_enabled: settings.live_preview_enabled,
            }))
        }
        None => Ok(None),
    }
}

#[cfg(test)]
fn persist_transcripts(
    db: &Database,
    session_id: &str,
    results: Vec<Result<RecognitionUpdate>>,
) -> Result<()> {
    let mut first_error = None;
    for result in results {
        let result = match result {
            Ok(RecognitionUpdate::Final(result)) => result,
            Ok(_) => continue,
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

fn register_cloud_epoch(
    db: &Database,
    session: &PersistedVoiceSession,
    recognition: Option<&PreparedRecognition>,
) -> Result<()> {
    if let Some(PreparedRecognition::Paraformer {
        endpoint,
        credential_profile_id,
        ..
    }) = recognition
    {
        db.voice_cloud_epoch(
            &session.session_id,
            session.capture_epoch,
            session.active_ms,
            endpoint,
            *credential_profile_id,
        )?;
    }
    Ok(())
}

fn persist_recognition_update(
    db: &Database,
    session: &str,
    epoch: u64,
    update: &RecognitionUpdate,
) -> Result<()> {
    match update {
        RecognitionUpdate::Final(result) if !result.text.trim().is_empty() => {
            db.voice_transcript_append_final(
                session,
                &result.provider_key,
                result.start_ms,
                result.end_ms,
                &result.text,
                None,
            )?;
            db.voice_cloud_acknowledge(session, epoch, result.end_ms)?;
        }
        RecognitionUpdate::CloudGap(error) => db.voice_recognition_failed(session, epoch, error)?,
        RecognitionUpdate::CloudConnected { start_ms } => {
            db.voice_cloud_connected(session, epoch, *start_ms)?
        }
        RecognitionUpdate::CloudComplete => db.voice_cloud_complete(session, epoch)?,
        _ => {}
    }
    Ok(())
}

fn persist_available_transcripts(
    db: &Database,
    session_id: &str,
    epoch: u64,
    run: &CaptureRun,
    interim_text: &mut Option<String>,
    pending: &mut Vec<RecognitionUpdate>,
) -> Result<()> {
    let Some(recognition) = &run.recognition else {
        return Ok(());
    };
    while let Some(result) = recognition.try_result() {
        match result {
            Ok(RecognitionUpdate::Partial(text)) => {
                *interim_text = (!text.is_empty()).then_some(text)
            }
            Ok(update) => pending.push(update),
            Err(error) => {
                *interim_text = None;
                pending.push(RecognitionUpdate::CloudGap(error.to_string()));
            }
        }
    }
    for update in pending.iter() {
        persist_recognition_update(db, session_id, epoch, update)?;
    }
    pending.clear();
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn preflight_capture() -> Result<()> {
    NativeCaptureSession::preflight().map_err(|error| anyhow!(error))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn preflight_capture() -> Result<()> {
    Err(anyhow!(
        "voice capture is not implemented on this platform yet"
    ))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn start_capture_run(
    workspace_root: &Path,
    session_id: &str,
    epoch: u64,
    epoch_offset_ms: u64,
    recognition: Option<PreparedRecognition>,
) -> Result<CaptureRun> {
    let (capture, outputs) =
        NativeCaptureSession::start(epoch, AUDIO_QUEUE_CAPACITY, recognition.is_some())
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

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn build_capture_run(
    workspace_root: &Path,
    session_id: &str,
    epoch: u64,
    epoch_offset_ms: u64,
    recognition: Option<PreparedRecognition>,
    capture: NativeCaptureSession,
    outputs: NativeCaptureOutputs,
) -> Result<CaptureRun> {
    let recognition = match recognition {
        None => None,
        Some(recognition) => {
            let microphone = outputs
                .recognition_microphone
                .ok_or_else(|| anyhow!("missing recognition microphone"))?;
            let system = outputs
                .recognition_system
                .ok_or_else(|| anyhow!("missing recognition system audio"))?;
            Some(match recognition {
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
                    credential_profile_id: _,
                    preview_enabled,
                } => ActiveRecognition::Paraformer(LiveParaformerHandle::spawn(
                    endpoint,
                    api_key,
                    microphone,
                    system,
                    epoch_offset_ms,
                    preview_enabled,
                )?),
            })
        }
    };
    let activity = super::activity::ActivityHandle::spawn(
        outputs.activity_microphone,
        outputs.activity_system,
    )?;
    Ok(CaptureRun {
        activity,
        workspace_root: workspace_root.to_path_buf(),
        session_id: session_id.to_owned(),
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
        recognition,
        faults: outputs.faults,
    })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn start_capture_run(
    _workspace_root: &Path,
    _session_id: &str,
    _epoch: u64,
    _epoch_offset_ms: u64,
    _recognition: Option<PreparedRecognition>,
) -> Result<CaptureRun> {
    Err(anyhow!(
        "voice capture is not implemented on this platform yet"
    ))
}

struct StoppedRun {
    manifests: Vec<AudioChunkManifest>,
    results: Vec<Result<RecognitionUpdate>>,
    storage_error: Option<String>,
}

fn stop_capture_run(run: Option<CaptureRun>) -> Result<StoppedRun> {
    let Some(mut run) = run else {
        return Ok(StoppedRun {
            manifests: Vec::new(),
            results: Vec::new(),
            storage_error: None,
        });
    };
    let mut storage_error = None;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if let Some(mut capture) = run.capture.take() {
        if let Err(error) = capture.stop() {
            storage_error = Some(format!("capture_fault: {error}"));
        }
        drop(capture);
    }
    if let Err(error) = run.activity.finish() {
        storage_error = Some(format!("activity_fault: {error}"));
    }
    let microphone = run.microphone_writer.finish();
    let system = run.system_writer.finish();
    let mut manifests = Vec::new();
    for result in [microphone, system] {
        match result {
            Ok(saved) => manifests.extend(saved),
            Err(error) => {
                storage_error = Some(format!("storage_fault: {error}"));
            }
        }
    }
    if storage_error.is_some() {
        // Recover both tracks even if one writer failed; never discard its peer's valid audio.
        match recover_partial_tracks(&run.workspace_root, &run.session_id) {
            Ok(recovered) => manifests.extend(recovered),
            Err(error) => storage_error = Some(format!("storage_fault: {error}")),
        }
    }
    let results = run
        .recognition
        .take()
        .map(ActiveRecognition::finish)
        .unwrap_or_default();
    Ok(StoppedRun {
        manifests,
        storage_error,
        results,
    })
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn capture_run_faulted(run: &mut CaptureRun) -> bool {
    run.activity.failed()
        || run.microphone_writer.has_stopped()
        || run.system_writer.has_stopped()
        || run.faults.try_recv().is_ok()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn capture_run_faulted(run: &mut CaptureRun) -> bool {
    run.activity.failed() || run.microphone_writer.has_stopped() || run.system_writer.has_stopped()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_database_save_keeps_a_stopped_session_and_retries_without_recapturing() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("db.sqlite");
        let mut db = Database::open(&path, root.path(), None).unwrap();
        let session = db
            .voice_session_create(&RecordTarget::Workspace, "failure", "failure", "Voice")
            .unwrap();
        let fault = rusqlite::Connection::open(&path).unwrap();
        fault.execute_batch("CREATE TRIGGER fail_save BEFORE UPDATE ON recording_sessions BEGIN SELECT RAISE(FAIL, 'disk full'); END;").unwrap();
        let mut runtime = VoiceRuntime::default();
        assert!(runtime.end(&mut db, "failure", session.revision).is_err());
        let stopped = runtime.snapshot(&mut db, root.path()).unwrap().unwrap();
        assert_eq!(stopped.phase, "ending");
        assert!(stopped.pause_reason.unwrap().contains("保存待重试"));
        fault.execute_batch("DROP TRIGGER fail_save").unwrap();
        assert!(runtime.snapshot(&mut db, root.path()).unwrap().is_none());
        assert_eq!(
            db.voice_session_get("failure").unwrap().unwrap().lifecycle,
            "ended"
        );
    }

    #[test]
    fn recovery_after_file_rename_restores_audio_duration_before_resuming() {
        use crate::voice::capture::{bounded_audio_frames, AudioSource, SourceTimeline};
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("db.sqlite"), root.path(), None).unwrap();
        db.voice_session_create(&RecordTarget::Workspace, "crash", "crash", "Voice")
            .unwrap();
        let (sink, stream) = bounded_audio_frames(1).unwrap();
        let writer = WriterHandle::spawn(
            root.path().into(),
            "crash".into(),
            AudioSource::Microphone,
            1,
            stream,
        );
        let mut timeline = SourceTimeline::new(AudioSource::Microphone, 1, 0, 10, 1).unwrap();
        sink.try_push(timeline.stamp(200_000_000, vec![0.5; 601]).unwrap())
            .unwrap();
        drop(sink);
        writer.finish().unwrap(); // Crash before database registration.
        let snapshot = VoiceRuntime::default()
            .snapshot(&mut db, root.path())
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.phase, "paused");
        assert_eq!(snapshot.active_ms, 60_300);
    }

    #[test]
    fn no_speech_profile_allows_audio_capture_without_recognition() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(
            &root.path().join("app.sqlite3"),
            root.path(),
            Some("test-secret".to_string()),
        )
        .unwrap();
        assert!(prepare_recognition(&db).unwrap().is_none());
    }

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
    fn local_recognition_failure_stays_visible_without_stopping_audio_and_survives_resume() {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("db.sqlite"), root.path(), None).unwrap();
        let session = db
            .voice_session_create(
                &RecordTarget::Workspace,
                "local-error",
                "local-error",
                "Voice",
            )
            .unwrap();
        let persisted = db
            .voice_session_transition(
                &session.session_id,
                session.revision,
                "recording",
                None,
                1000,
                1,
            )
            .unwrap();
        persist_recognition_update(
            &db,
            &session.session_id,
            1,
            &RecognitionUpdate::CloudGap("local inference failed".into()),
        )
        .unwrap();
        let mut runtime = VoiceRuntime {
            active: Some(ActiveSession {
                persisted,
                recording_since: None,
                run: None,
                interim_text: None,
                pending_save: None,
                pending_updates: Vec::new(),
            }),
        };
        let live = runtime.snapshot(&mut db, root.path()).unwrap().unwrap();
        assert_eq!(live.phase, "recording");
        assert_eq!(live.pause_reason, None);
        assert_eq!(
            serde_json::to_value(live).unwrap()["recognitionError"],
            "local inference failed"
        );
        let active = runtime.active.as_mut().unwrap();
        active.persisted = db
            .voice_session_transition(
                &session.session_id,
                active.persisted.revision,
                "recording",
                None,
                1000,
                2,
            )
            .unwrap();
        let resumed = runtime.snapshot(&mut db, root.path()).unwrap().unwrap();
        assert!(serde_json::to_value(resumed).unwrap()["recognitionError"].is_null());
        let revision = runtime.active.as_ref().unwrap().persisted.revision;
        runtime.end(&mut db, &session.session_id, revision).unwrap();
        let playback = db
            .voice_playback_get(&super::super::contracts::VoiceRecordLookup::Workspace {
                record_id: session.workspace_note_id.unwrap(),
            })
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(playback).unwrap()["recognitionError"],
            "local inference failed"
        );
        assert!(db.voice_cloud_gaps(&session.session_id).unwrap().is_empty());
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
                pending_save: None,
                pending_updates: Vec::new(),
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
                pending_save: None,
                pending_updates: Vec::new(),
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
