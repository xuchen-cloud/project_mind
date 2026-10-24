//! Registered IPC boundaries for the authoritative Voice runtime.
use super::contracts::*;
use super::model_package::{self, ModelPackageStatus};
use super::paraformer;
use crate::{lock_mutex, AppState};
use tauri::{Manager, State};

fn authorize_playback_file(
    scope: &tauri::scope::fs::Scope,
    path: &std::path::Path,
) -> tauri::Result<()> {
    // Wildcard scopes exclude the hidden .project-mind directory on macOS.
    // Grant only files resolved from this Record's persisted audio metadata.
    scope.allow_file(path)
}

#[cfg(test)]
mod playback_scope_tests {
    #[test]
    fn hidden_recording_is_readable_after_authorization() {
        let app = tauri::test::mock_app();
        let root = tempfile::tempdir().unwrap();
        let path = root
            .path()
            .join(".project-mind/voice/session/microphone.wav");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"RIFF").unwrap();
        let scope = tauri::scope::fs::Scope::new(
            &app,
            &tauri::utils::config::FsScope::Scope {
                allow: vec![root.path().join("**")],
                deny: vec![],
                require_literal_leading_dot: Some(true),
            },
        )
        .unwrap();
        assert!(
            !scope.is_allowed(&path),
            "wildcard must reproduce hidden-directory denial"
        );
        super::authorize_playback_file(&scope, &path).unwrap();
        assert!(
            scope.is_allowed(&path),
            "recording must be readable by the asset protocol"
        );
        assert!(!scope.is_allowed(root.path().join(".project-mind/private.txt")));
    }
}

fn failed(operation: &'static str, error: impl std::fmt::Display) -> VoiceError {
    VoiceError {
        code: "voice_operation_failed",
        operation,
        message: error.to_string(),
    }
}

/// Final segments may be persisted while draining the live runtime, even if a
/// later phase transition fails. Publish captured commits after both locks drop.
fn with_voice_db<T>(state: &AppState, workspace: &crate::WorkspaceRuntime, operation: &'static str,
    action: impl FnOnce(&mut super::runtime::VoiceRuntime, &mut crate::db::Database) -> anyhow::Result<T>) -> VoiceResult<T> {
    let request_id = format!("voice:{:032x}", rand::random::<u128>());
    let (result, changes) = {
        let mut voice = lock_mutex(&state.voice_runtime);
        let current = lock_mutex(&state.current_workspace);
        if !current.as_ref().is_some_and(|current| current.agent_binding == workspace.agent_binding) {
            return Err(failed(operation, "Workspace changed before the command acquired storage"));
        }
        let mut db = lock_mutex(&workspace.db);
        crate::committed_changes::capture_native_committed(&workspace.agent_binding, &mut db, &request_id, |db| action(&mut voice, db))
            .map_err(|error| failed(operation, error))?
    };
    if let Some(changes) = changes {
        use crate::committed_changes::CommittedChangePublisher;
        state.publish_committed(changes);
    }
    result.map_err(|error| failed(operation, error))
}

#[tauri::command]
pub(crate) async fn voice_model_status_get() -> VoiceResult<ModelPackageStatus> {
    let cache = crate::default_app_data_dir().map_err(|error| failed("model_status", error))?;
    tauri::async_runtime::spawn_blocking(move || model_package::status(&cache))
        .await
        .map_err(|error| failed("model_status", error))
}

#[tauri::command]
pub(crate) async fn voice_model_import(
    source_directory: String,
) -> VoiceResult<ModelPackageStatus> {
    let cache = crate::default_app_data_dir().map_err(|error| failed("model_import", error))?;
    tauri::async_runtime::spawn_blocking(move || {
        model_package::import_sense_voice(std::path::Path::new(&source_directory), &cache)
    })
    .await
    .map_err(|error| failed("model_import", error))?
    .map_err(|error| failed("model_import", error))
}

#[tauri::command]
pub(crate) async fn voice_diarization_model_status_get() -> VoiceResult<ModelPackageStatus> {
    let cache = crate::default_app_data_dir().map_err(|error| failed("diarization_model_status", error))?;
    tauri::async_runtime::spawn_blocking(move || super::diarization_model::status(&cache))
        .await.map_err(|error| failed("diarization_model_status", error))
}

#[tauri::command]
pub(crate) async fn voice_diarization_model_import(source_directory: String) -> VoiceResult<ModelPackageStatus> {
    let cache = crate::default_app_data_dir().map_err(|error| failed("diarization_model_import", error))?;
    tauri::async_runtime::spawn_blocking(move || super::diarization_model::import(std::path::Path::new(&source_directory), &cache))
        .await.map_err(|error| failed("diarization_model_import", error))?
        .map_err(|error| failed("diarization_model_import", error))
}

#[tauri::command]
pub(crate) fn voice_diarization_model_install() -> VoiceResult<super::diarization_install::ModelInstallStatus> {
    let cache = crate::default_app_data_dir().map_err(|error| failed("diarization_model_install", error))?;
    super::diarization_install::start(cache).map_err(|error| failed("diarization_model_install", error))
}

#[tauri::command]
pub(crate) fn voice_diarization_model_install_status_get() -> super::diarization_install::ModelInstallStatus {
    super::diarization_install::snapshot()
}

fn with_diarization_db<T>(state: &AppState, operation: &'static str, expected_workspace: Option<&std::sync::Arc<crate::WorkspaceRuntime>>,
    action: impl FnOnce(&mut crate::db::Database) -> anyhow::Result<T>) -> VoiceResult<T> {
    let current = lock_mutex(&state.current_workspace);
    let workspace = current.as_ref().ok_or_else(|| failed(operation, "请先打开 Workspace"))?;
    if expected_workspace.is_some_and(|expected| !std::sync::Arc::ptr_eq(expected, workspace)) {
        return Err(failed(operation, "Workspace 在请求期间已切换，请重新开始"));
    }
    let mut db = lock_mutex(&workspace.db);
    action(&mut db).map_err(|error| failed(operation, error))
}

#[tauri::command]
pub(crate) fn voice_diarization_get(state: State<'_, AppState>, input: VoiceRecordLookup) -> VoiceResult<Option<VoiceDiarizationSnapshot>> {
    with_diarization_db(&state, "diarization_get", None, |db| db.voice_diarization_get(&input))
}

#[tauri::command]
pub(crate) async fn voice_diarization_start(state: State<'_, AppState>, input: VoiceRecordLookup) -> VoiceResult<Option<VoiceDiarizationSnapshot>> {
    let workspace = state.current_workspace().map_err(|error| failed("diarization_start", error))?;
    let cache = crate::default_app_data_dir().map_err(|error| failed("diarization_start", error))?;
    let status = tauri::async_runtime::spawn_blocking(move || super::diarization_model::status(&cache))
        .await.map_err(|error| failed("diarization_start", error))?;
    if !status.ready { return Err(failed("diarization_start", status.detail)); }
    with_diarization_db(&state, "diarization_start", Some(&workspace), |db| {
        let Some(snapshot) = db.voice_diarization_get(&input)? else { return Ok(None); };
        let playback = db.voice_diarization_playback(&snapshot.session_id)?
            .ok_or_else(|| anyhow::anyhow!("语音记录不存在"))?;
        if playback.phase != "ended" { return Err(anyhow::anyhow!("请先结束录音，再区分说话人")); }
        if playback.chunks.is_empty() { return Err(anyhow::anyhow!("没有可分析的已保存录音")); }
        db.voice_diarization_enqueue(&snapshot.session_id)?;
        db.voice_diarization_get(&input)
    })
}

#[tauri::command]
pub(crate) fn voice_speaker_rename(state: State<'_, AppState>, input: VoiceSpeakerRenameInput) -> VoiceResult<VoiceDiarizationSnapshot> {
    with_diarization_db(&state, "speaker_rename", None, |db| db.voice_speaker_rename(&input.target, input.speaker_id, &input.name, input.expected_revision))
}

#[tauri::command]
pub(crate) fn voice_speaker_link_contact(state: State<'_, AppState>, input: VoiceSpeakerLinkContactInput) -> VoiceResult<VoiceDiarizationSnapshot> {
    with_diarization_db(&state, "speaker_link_contact", None, |db| db.voice_speaker_link_contact(&input.target, input.speaker_id, input.contact_id, input.expected_revision))
}

#[tauri::command]
pub(crate) async fn voice_profile_test(
    state: State<'_, AppState>,
    input: VoiceProfileTestInput,
) -> VoiceResult<()> {
    let workspace = state
        .current_workspace()
        .map_err(|error| failed("profile_test", error))?;
    let api_key = {
        lock_mutex(&workspace.db)
            .voice_credential_from_ai_profile(input.credential_profile_id)
            .map_err(|error| failed("profile_test", error))?
    };
    paraformer::test_connection(&input.endpoint, &api_key)
        .await
        .map_err(|error| failed("profile_test", error))
}

#[tauri::command]
pub(crate) fn voice_availability_get() -> VoiceAvailability {
    VoiceAvailability {
        implemented: cfg!(any(target_os = "macos", target_os = "windows")),
        reason: if cfg!(target_os = "macos") {
            "macOS 15 双路录音可用".into()
        } else if cfg!(target_os = "windows") {
            "Windows WASAPI 双路录音已接入，待真实设备验收".into()
        } else {
            "当前平台的双路录音适配器尚未完成".into()
        },
    }
}

#[tauri::command]
pub(crate) fn voice_settings_get(state: State<'_, AppState>) -> VoiceResult<VoiceSettings> {
    let runtime = state
        .current_workspace()
        .map_err(|error| failed("settings_get", error))?;
    let result = lock_mutex(&runtime.db)
        .voice_settings_get()
        .map_err(|error| failed("settings_get", error));
    result
}

#[tauri::command]
pub(crate) fn voice_settings_upsert(
    state: State<'_, AppState>,
    input: VoiceSettings,
) -> VoiceResult<()> {
    let runtime = state
        .current_workspace()
        .map_err(|error| failed("settings_upsert", error))?;
    lock_mutex(&runtime.db)
        .voice_settings_upsert(&input)
        .map_err(|error| failed("settings_upsert", error))?;
    lock_mutex(&state.voice_runtime).set_live_preview_enabled(input.live_preview_enabled);
    Ok(())
}

#[tauri::command]
pub(crate) fn voice_start(
    state: State<'_, AppState>,
    input: StartInput,
) -> VoiceResult<VoiceSessionSnapshot> {
    let workspace = state
        .current_workspace()
        .map_err(|error| failed("start", error))?;
    workspace
        .voice_recovery_interrupt
        .store(true, std::sync::atomic::Ordering::Release);
    workspace.voice_diarization_interrupt.store(true, std::sync::atomic::Ordering::Release);
    with_voice_db(&state, &workspace, "start", |voice, db| {
        voice.start(db, &workspace.paths.root_path, &input.target, &input.request_id)
    })
}

#[tauri::command]
pub(crate) fn voice_pause(
    state: State<'_, AppState>,
    input: SessionInput,
) -> VoiceResult<VoiceSessionSnapshot> {
    let workspace = state
        .current_workspace()
        .map_err(|error| failed("pause", error))?;
    with_voice_db(&state, &workspace, "pause", |voice, db| {
        voice.pause(db, &input.session_id, input.expected_revision)
    })
}

#[tauri::command]
pub(crate) fn voice_resume(
    state: State<'_, AppState>,
    input: SessionInput,
) -> VoiceResult<VoiceSessionSnapshot> {
    let workspace = state
        .current_workspace()
        .map_err(|error| failed("resume", error))?;
    workspace
        .voice_recovery_interrupt
        .store(true, std::sync::atomic::Ordering::Release);
    workspace.voice_diarization_interrupt.store(true, std::sync::atomic::Ordering::Release);
    with_voice_db(&state, &workspace, "resume", |voice, db| {
        voice.resume(db, &workspace.paths.root_path, &input.session_id, input.expected_revision)
    })
}

#[tauri::command]
pub(crate) fn voice_end(
    state: State<'_, AppState>,
    input: SessionInput,
) -> VoiceResult<VoiceSessionSnapshot> {
    let workspace = state
        .current_workspace()
        .map_err(|error| failed("end", error))?;
    let (result, queued) = with_voice_db(&state, &workspace, "end", |voice, db| {
        let result = voice.end(db, &input.session_id, input.expected_revision)?;
        let queued = db.voice_settings_get()?.text_profile_id.is_some()
            && db.voice_minutes_enqueue(&input.session_id, "final")?;
        Ok((result, queued))
    })?;
    if queued { workspace.kick_voice_minutes(); }
    Ok(result)
}

#[tauri::command]
pub(crate) fn voice_snapshot_get(
    state: State<'_, AppState>,
) -> VoiceResult<Option<VoiceSessionSnapshot>> {
    let workspace = state
        .current_workspace()
        .map_err(|error| failed("snapshot_get", error))?;
    let (result, pending) = with_voice_db(&state, &workspace, "snapshot_get", |voice, db| {
        let result = voice.snapshot(db, &workspace.paths.root_path)?;
        if let Some(snapshot) = &result {
            if snapshot.active_ms >= 15 * 60 * 1_000 && snapshot.phase == "recording"
                && db.voice_settings_get()?.text_profile_id.is_some() {
                let bucket = snapshot.active_ms / (15 * 60 * 1_000);
                db.voice_minutes_enqueue(&snapshot.session_id, &format!("auto:{bucket}"))?;
            }
        }
        Ok((result, db.voice_minutes_has_pending()?))
    })?;
    if pending { workspace.kick_voice_minutes(); }
    Ok(result)
}

#[tauri::command]
pub(crate) fn voice_minutes_get(
    state: State<'_, AppState>,
    input: VoiceRecordLookup,
) -> VoiceResult<Option<VoiceMinutesSnapshot>> {
    let workspace = state
        .current_workspace()
        .map_err(|error| failed("minutes_get", error))?;
    let db = lock_mutex(&workspace.db);
    let snapshot = db
        .voice_minutes_get(&input)
        .map_err(|error| failed("minutes_get", error))?;
    if db
        .voice_minutes_has_pending()
        .map_err(|error| failed("minutes_get", error))?
    {
        workspace.kick_voice_minutes();
    }
    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn voice_minutes_generate(
    state: State<'_, AppState>,
    input: VoiceMinutesGenerateInput,
) -> VoiceResult<Option<VoiceMinutesSnapshot>> {
    let workspace = state
        .current_workspace()
        .map_err(|error| failed("minutes_generate", error))?;
    let db = lock_mutex(&workspace.db);
    db.voice_minutes_profile()
        .map_err(|error| failed("minutes_generate", error))?;
    let snapshot = db
        .voice_minutes_get(&input.target)
        .map_err(|error| failed("minutes_generate", error))?;
    if let Some(snapshot) = &snapshot {
        db.voice_minutes_enqueue(
            &snapshot.session_id,
            &format!("manual:{}", input.request_id),
        )
        .map_err(|error| failed("minutes_generate", error))?;
        if db
            .voice_minutes_has_pending()
            .map_err(|error| failed("minutes_generate", error))?
        {
            workspace.kick_voice_minutes();
        }
    }
    db.voice_minutes_get(&input.target)
        .map_err(|error| failed("minutes_generate", error))
}

#[tauri::command]
pub(crate) fn voice_playback_get(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    input: VoiceRecordLookup,
) -> VoiceResult<Option<VoicePlaybackSnapshot>> {
    let workspace = state
        .current_workspace()
        .map_err(|error| failed("playback_get", error))?;
    let result = lock_mutex(&workspace.db)
        .voice_playback_get(&input)
        .map_err(|error| failed("playback_get", error))?;
    if let Some(snapshot) = &result {
        let root = workspace
            .paths
            .root_path
            .canonicalize()
            .map_err(|error| failed("playback_get", error))?;
        let scope = app.asset_protocol_scope();
        for chunk in &snapshot.chunks {
            let path = std::path::Path::new(&chunk.path)
                .canonicalize()
                .map_err(|error| failed("playback_get", error))?;
            if !path.starts_with(&root) {
                return Err(failed("playback_get", "voice audio path escaped workspace"));
            }
            authorize_playback_file(&scope, &path)
                .map_err(|error| failed("playback_get", error))?;
        }
    }
    Ok(result)
}

#[tauri::command]
pub(crate) fn voice_transcript_list(
    state: State<'_, AppState>,
    input: VoiceTranscriptListInput,
) -> VoiceResult<Option<VoiceTranscriptPage>> {
    let workspace = state
        .current_workspace()
        .map_err(|error| failed("transcript_list", error))?;
    let result = lock_mutex(&workspace.db)
        .voice_transcript_list(&input.target, input.after.as_ref(), input.limit)
        .map_err(|error| failed("transcript_list", error));
    result
}

#[tauri::command]
pub(crate) fn voice_transcript_tail(
    state: State<'_, AppState>,
    input: VoiceTranscriptTailInput,
) -> VoiceResult<Vec<VoiceTranscriptSegment>> {
    let workspace = state
        .current_workspace()
        .map_err(|error| failed("transcript_tail", error))?;
    let result = lock_mutex(&workspace.db)
        .voice_transcript_tail(&input.session_id, input.limit)
        .map_err(|error| failed("transcript_tail", error));
    result
}

#[tauri::command]
pub(crate) fn voice_recovery_get(
    state: State<'_, AppState>,
    input: VoiceRecordLookup,
) -> VoiceResult<Vec<crate::db::CloudGap>> {
    let workspace = state
        .current_workspace()
        .map_err(|error| failed("recovery_get", error))?;
    let result = lock_mutex(&workspace.db)
        .voice_cloud_status(&input)
        .map_err(|error| failed("recovery_get", error));
    result
}

#[tauri::command]
pub(crate) fn voice_recovery_retry(
    state: State<'_, AppState>,
    input: VoiceRecordLookup,
) -> VoiceResult<()> {
    let workspace = state
        .current_workspace()
        .map_err(|error| failed("recovery_retry", error))?;
    let result = lock_mutex(&workspace.db)
        .voice_cloud_retry(&input)
        .map_err(|error| failed("recovery_retry", error));
    result
}
