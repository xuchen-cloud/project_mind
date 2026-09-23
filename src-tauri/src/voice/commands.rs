//! Registered IPC boundaries for the authoritative Voice runtime.
use super::contracts::*;
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

#[tauri::command]
pub(crate) fn voice_availability_get() -> VoiceAvailability {
    VoiceAvailability {
        implemented: cfg!(target_os = "macos"),
        reason: if cfg!(target_os = "macos") {
            "macOS 15 双路录音可用".into()
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
    let result = lock_mutex(&runtime.db)
        .voice_settings_upsert(&input)
        .map_err(|error| failed("settings_upsert", error));
    result
}

#[tauri::command]
pub(crate) fn voice_start(
    state: State<'_, AppState>,
    input: StartInput,
) -> VoiceResult<VoiceSessionSnapshot> {
    let workspace = state
        .current_workspace()
        .map_err(|error| failed("start", error))?;
    let mut voice = lock_mutex(&state.voice_runtime);
    let mut db = lock_mutex(&workspace.db);
    voice
        .start(
            &mut db,
            &workspace.paths.root_path,
            &input.target,
            &input.request_id,
        )
        .map_err(|error| failed("start", error))
}

#[tauri::command]
pub(crate) fn voice_pause(
    state: State<'_, AppState>,
    input: SessionInput,
) -> VoiceResult<VoiceSessionSnapshot> {
    let workspace = state
        .current_workspace()
        .map_err(|error| failed("pause", error))?;
    let mut voice = lock_mutex(&state.voice_runtime);
    let mut db = lock_mutex(&workspace.db);
    voice
        .pause(&mut db, &input.session_id, input.expected_revision)
        .map_err(|error| failed("pause", error))
}

#[tauri::command]
pub(crate) fn voice_resume(
    state: State<'_, AppState>,
    input: SessionInput,
) -> VoiceResult<VoiceSessionSnapshot> {
    let workspace = state
        .current_workspace()
        .map_err(|error| failed("resume", error))?;
    let mut voice = lock_mutex(&state.voice_runtime);
    let mut db = lock_mutex(&workspace.db);
    voice
        .resume(
            &mut db,
            &workspace.paths.root_path,
            &input.session_id,
            input.expected_revision,
        )
        .map_err(|error| failed("resume", error))
}

#[tauri::command]
pub(crate) fn voice_end(
    state: State<'_, AppState>,
    input: SessionInput,
) -> VoiceResult<VoiceSessionSnapshot> {
    let workspace = state
        .current_workspace()
        .map_err(|error| failed("end", error))?;
    let mut voice = lock_mutex(&state.voice_runtime);
    let mut db = lock_mutex(&workspace.db);
    voice
        .end(&mut db, &input.session_id, input.expected_revision)
        .map_err(|error| failed("end", error))
}

#[tauri::command]
pub(crate) fn voice_snapshot_get(
    state: State<'_, AppState>,
) -> VoiceResult<Option<VoiceSessionSnapshot>> {
    let workspace = state
        .current_workspace()
        .map_err(|error| failed("snapshot_get", error))?;
    let mut voice = lock_mutex(&state.voice_runtime);
    let mut db = lock_mutex(&workspace.db);
    voice
        .snapshot(&mut db, &workspace.paths.root_path)
        .map_err(|error| failed("snapshot_get", error))
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
