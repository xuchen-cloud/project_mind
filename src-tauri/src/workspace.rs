use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Context, Result};
use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::models::WorkspaceSummary;

pub const WORKSPACE_HIDDEN_DIR_NAME: &str = ".project-mind";
pub const WORKSPACE_DB_FILE_NAME: &str = "workspace.sqlite3";
pub const WORKSPACE_METADATA_FILE_NAME: &str = "workspace.json";
pub const WORKSPACE_SECURITY_MODE: &str = "workspace_local_key_encrypted";
pub const LEGACY_WORKSPACE_SECURITY_MODE: &str = "workspace_password_encrypted";

const WORKSPACE_SCHEMA_VERSION: i64 = 1;
const PASSWORD_SALT_BYTES: usize = 16;
const PASSWORD_HASH_BYTES: usize = 32;
const PASSWORD_CONTEXT: &str = "project-mind-alpha::workspace-password::v1";

#[derive(Debug, Clone)]
pub struct WorkspacePaths {
    pub root_path: PathBuf,
    #[allow(dead_code)]
    pub hidden_dir: PathBuf,
    pub metadata_path: PathBuf,
    pub db_path: PathBuf,
    pub cache_dir: PathBuf,
    pub log_dir: PathBuf,
    pub temp_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSessionState {
    pub last_opened_workspace_root: Option<String>,
    pub recent_workspace_roots: Vec<String>,
}

impl Default for LocalSessionState {
    fn default() -> Self {
        Self {
            last_opened_workspace_root: None,
            recent_workspace_roots: Vec::new(),
        }
    }
}

impl LocalSessionState {
    pub fn record_recent_workspace(&mut self, root_path: &Path) {
        let root = root_path.to_string_lossy().to_string();
        self.recent_workspace_roots
            .retain(|candidate| candidate != &root);
        self.recent_workspace_roots.insert(0, root.clone());
        self.recent_workspace_roots.truncate(8);
        self.last_opened_workspace_root = Some(root);
    }

    pub fn clear_current_workspace(&mut self) {
        self.last_opened_workspace_root = None;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMetadata {
    pub workspace_id: String,
    pub workspace_schema_version: i64,
    pub created_at: String,
    pub security_mode: String,
    pub password_verifier: PasswordVerifier,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_secret_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordVerifier {
    pub salt_b64: String,
    pub hash_b64: String,
}

pub fn workspace_paths(root_path: &Path) -> WorkspacePaths {
    let hidden_dir = root_path.join(WORKSPACE_HIDDEN_DIR_NAME);
    WorkspacePaths {
        root_path: root_path.to_path_buf(),
        metadata_path: hidden_dir.join(WORKSPACE_METADATA_FILE_NAME),
        db_path: hidden_dir.join(WORKSPACE_DB_FILE_NAME),
        cache_dir: hidden_dir.join("cache").join("ai"),
        log_dir: hidden_dir.join("logs"),
        temp_dir: hidden_dir.join("tmp"),
        hidden_dir,
    }
}

pub fn create_workspace(
    root_path: &Path,
    password: &str,
) -> Result<(WorkspaceMetadata, WorkspacePaths)> {
    let paths = workspace_paths(root_path);
    if paths.metadata_path.exists() {
        return Err(anyhow!(
            "workspace already exists at {}",
            root_path.display()
        ));
    }

    fs::create_dir_all(&paths.cache_dir)?;
    fs::create_dir_all(&paths.log_dir)?;
    fs::create_dir_all(&paths.temp_dir)?;

    #[cfg(target_os = "windows")]
    {
        set_hidden_attribute(&paths.hidden_dir)?;
    }

    let metadata = WorkspaceMetadata {
        workspace_id: random_hex(16),
        workspace_schema_version: WORKSPACE_SCHEMA_VERSION,
        created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        security_mode: LEGACY_WORKSPACE_SECURITY_MODE.to_string(),
        password_verifier: create_password_verifier(password)?,
        local_secret_key: None,
    };
    save_metadata(&paths.metadata_path, &metadata)?;
    Ok((metadata, paths))
}

pub fn generate_workspace_secret_key() -> String {
    random_hex(32)
}

pub fn create_passwordless_workspace(
    root_path: &Path,
) -> Result<(WorkspaceMetadata, WorkspacePaths)> {
    let paths = workspace_paths(root_path);
    if paths.metadata_path.exists() {
        return Err(anyhow!(
            "workspace already exists at {}",
            root_path.display()
        ));
    }
    fs::create_dir_all(&paths.cache_dir)?;
    fs::create_dir_all(&paths.log_dir)?;
    fs::create_dir_all(&paths.temp_dir)?;
    #[cfg(target_os = "windows")]
    set_hidden_attribute(&paths.hidden_dir)?;

    let key = generate_workspace_secret_key();
    let metadata = WorkspaceMetadata {
        workspace_id: random_hex(16),
        workspace_schema_version: WORKSPACE_SCHEMA_VERSION,
        created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        security_mode: WORKSPACE_SECURITY_MODE.to_string(),
        password_verifier: local_key_verifier(&key),
        local_secret_key: Some(key),
    };
    save_metadata(&paths.metadata_path, &metadata)?;
    Ok((metadata, paths))
}

pub fn enable_passwordless_workspace(
    metadata_path: &Path,
    metadata: &WorkspaceMetadata,
    key: &str,
) -> Result<WorkspaceMetadata> {
    validate_local_secret_key(Some(key))?;
    let mut updated = metadata.clone();
    updated.security_mode = WORKSPACE_SECURITY_MODE.to_string();
    updated.local_secret_key = Some(key.to_owned());
    updated.password_verifier = local_key_verifier(key);
    save_metadata(metadata_path, &updated)?;
    Ok(updated)
}

fn local_key_verifier(key: &str) -> PasswordVerifier {
    PasswordVerifier {
        salt_b64: String::new(),
        hash_b64: STANDARD.encode(Sha256::digest(key.as_bytes())),
    }
}

fn validate_local_secret_key(key: Option<&str>) -> Result<()> {
    if key.is_none_or(|key| key.trim().is_empty()) {
        return Err(anyhow!("workspace local secret key is missing or invalid"));
    }
    Ok(())
}

pub fn load_metadata(root_path: &Path) -> Result<(WorkspaceMetadata, WorkspacePaths)> {
    let paths = workspace_paths(root_path);
    let raw = fs::read_to_string(&paths.metadata_path).with_context(|| {
        format!(
            "failed to read workspace metadata at {}",
            paths.metadata_path.display()
        )
    })?;
    let metadata: WorkspaceMetadata =
        serde_json::from_str(&raw).context("failed to parse workspace metadata")?;
    match metadata.security_mode.as_str() {
        WORKSPACE_SECURITY_MODE => {
            validate_local_secret_key(metadata.local_secret_key.as_deref())?;
            // This detects damaged metadata; the key is already stored beside
            // its checksum, so password stretching adds no protection here.
            if metadata.password_verifier.hash_b64
                != local_key_verifier(metadata.local_secret_key.as_deref().unwrap()).hash_b64
            {
                return Err(anyhow!("workspace local secret key is invalid"));
            }
        }
        LEGACY_WORKSPACE_SECURITY_MODE => {}
        _ => return Err(anyhow!("workspace security mode is not supported")),
    }
    Ok((metadata, paths))
}

pub fn workspace_summary(root_path: &Path, metadata: &WorkspaceMetadata) -> WorkspaceSummary {
    let paths = workspace_paths(root_path);
    WorkspaceSummary {
        root_path: root_path.to_string_lossy().to_string(),
        metadata_path: paths.metadata_path.to_string_lossy().to_string(),
        display_name: root_path
            .file_name()
            .and_then(|segment| segment.to_str())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| root_path.to_string_lossy().to_string()),
        created_at: metadata.created_at.clone(),
    }
}

pub fn verify_workspace_password(metadata: &WorkspaceMetadata, password: &str) -> Result<()> {
    let salt = STANDARD
        .decode(&metadata.password_verifier.salt_b64)
        .context("workspace password salt is invalid")?;
    let expected = STANDARD
        .decode(&metadata.password_verifier.hash_b64)
        .context("workspace password hash is invalid")?;
    let actual = derive_password_hash(password, &salt)?;
    if actual.as_slice() == expected.as_slice() {
        Ok(())
    } else {
        Err(anyhow!("workspace password is incorrect"))
    }
}

pub fn load_local_session(path: &Path) -> Result<LocalSessionState> {
    if !path.exists() {
        return Ok(LocalSessionState::default());
    }
    let raw = fs::read_to_string(path).with_context(|| {
        format!(
            "failed to read local workspace session at {}",
            path.display()
        )
    })?;
    serde_json::from_str(&raw).context("failed to parse local workspace session")
}

pub fn save_local_session(path: &Path, state: &LocalSessionState) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(state)?;
    fs::write(path, raw).with_context(|| {
        format!(
            "failed to write local workspace session at {}",
            path.display()
        )
    })
}

pub fn cleanup_legacy_app_data(app_data_dir: &Path, session_path: &Path) -> Result<()> {
    if !app_data_dir.exists() {
        fs::create_dir_all(app_data_dir)?;
        return Ok(());
    }

    for entry in fs::read_dir(app_data_dir)? {
        let entry = entry?;
        let path = entry.path();
        // Imported voice models belong to the current app and must survive restarts.
        if path == session_path
            || (path == app_data_dir.join("voice-models") && entry.file_type()?.is_dir())
            || (path == app_data_dir.join("debug-workspace-keys") && entry.file_type()?.is_dir())
        {
            continue;
        }
        if path.is_dir() {
            fs::remove_dir_all(&path).with_context(|| {
                format!(
                    "failed to remove legacy app data directory {}",
                    path.display()
                )
            })?;
        } else {
            fs::remove_file(&path).with_context(|| {
                format!("failed to remove legacy app data file {}", path.display())
            })?;
        }
    }

    Ok(())
}

fn save_metadata(path: &Path, metadata: &WorkspaceMetadata) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(metadata)?;
    let parent = path
        .parent()
        .context("workspace metadata path has no parent")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    temporary.write_all(raw.as_bytes())?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .with_context(|| format!("failed to write workspace metadata at {}", path.display()))?;
    Ok(())
}

fn create_password_verifier(password: &str) -> Result<PasswordVerifier> {
    let password = password.trim();
    if password.is_empty() {
        return Err(anyhow!("workspace password cannot be empty"));
    }

    let mut salt = [0_u8; PASSWORD_SALT_BYTES];
    rand::thread_rng().fill_bytes(&mut salt);
    let hash = derive_password_hash(password, &salt)?;
    Ok(PasswordVerifier {
        salt_b64: STANDARD.encode(salt),
        hash_b64: STANDARD.encode(hash),
    })
}

fn derive_password_hash(password: &str, salt: &[u8]) -> Result<[u8; PASSWORD_HASH_BYTES]> {
    let mut output = [0_u8; PASSWORD_HASH_BYTES];
    let effective_password = format!("{PASSWORD_CONTEXT}::{password}");
    Argon2::default()
        .hash_password_into(effective_password.as_bytes(), salt, &mut output)
        .map_err(|error| anyhow!("failed to derive workspace password hash: {error}"))?;
    Ok(output)
}

fn random_hex(bytes: usize) -> String {
    let mut payload = vec![0_u8; bytes];
    rand::thread_rng().fill_bytes(&mut payload);
    payload
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

#[cfg(target_os = "windows")]
fn set_hidden_attribute(path: &Path) -> Result<()> {
    use std::process::Command;

    let status = Command::new("attrib")
        .arg("+h")
        .arg(path)
        .status()
        .context("failed to invoke attrib")?;
    if status.success() {
        Ok(())
    } else {
        Err(anyhow!(
            "failed to mark workspace metadata directory hidden at {}",
            path.display()
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::LocalSessionState;

    #[test]
    fn leaving_workspace_clears_auto_restore_but_preserves_recents() {
        let mut session = LocalSessionState::default();
        session.record_recent_workspace(Path::new("first-workspace"));
        session.record_recent_workspace(Path::new("second-workspace"));

        session.clear_current_workspace();

        assert_eq!(session.last_opened_workspace_root, None);
        assert_eq!(
            session.recent_workspace_roots,
            vec![
                "second-workspace".to_string(),
                "first-workspace".to_string()
            ]
        );
    }
}

#[cfg(test)]
mod legacy_app_data_tests {
    use super::cleanup_legacy_app_data;
    use std::fs;

    #[test]
    fn cleanup_preserves_debug_workspace_keys_across_restarts() {
        let app_data = tempfile::tempdir().unwrap();
        let session = app_data.path().join("session.json");
        let keys = app_data.path().join("debug-workspace-keys");
        let models = app_data.path().join("voice-models");
        fs::write(&session, "session").unwrap();
        fs::create_dir(&keys).unwrap();
        fs::write(keys.join("workspace-id"), "workspace-key").unwrap();
        fs::create_dir(&models).unwrap();
        fs::write(models.join("model"), "voice-model").unwrap();
        fs::write(app_data.path().join("legacy-data"), "obsolete").unwrap();

        cleanup_legacy_app_data(app_data.path(), &session).unwrap();
        cleanup_legacy_app_data(app_data.path(), &session).unwrap();

        assert_eq!(
            fs::read_to_string(keys.join("workspace-id")).unwrap(),
            "workspace-key"
        );
        assert!(session.is_file());
        assert!(models.join("model").is_file());
        assert!(!app_data.path().join("legacy-data").exists());
    }

    #[test]
    fn cleanup_removes_file_named_as_debug_workspace_key_directory() {
        let app_data = tempfile::tempdir().unwrap();
        let keys = app_data.path().join("debug-workspace-keys");
        fs::write(&keys, "not-a-directory").unwrap();

        cleanup_legacy_app_data(app_data.path(), &app_data.path().join("session.json")).unwrap();

        assert!(!keys.exists());
    }
}

#[cfg(test)]
mod passwordless_tests {
    use super::*;

    #[test]
    fn legacy_workspace_conversion_preserves_identity_and_the_supplied_key() {
        let root = tempfile::tempdir().unwrap();
        let (legacy, paths) = create_workspace(root.path(), "old password").unwrap();
        let (loaded, _) = load_metadata(root.path()).unwrap();
        assert_eq!(loaded.security_mode, "workspace_password_encrypted");
        assert!(loaded.local_secret_key.is_none());
        verify_workspace_password(&loaded, "old password").unwrap();
        let converted =
            enable_passwordless_workspace(&paths.metadata_path, &legacy, "old password").unwrap();
        let (reopened, _) = load_metadata(root.path()).unwrap();
        assert_eq!(converted.workspace_id, legacy.workspace_id);
        assert_eq!(converted.created_at, legacy.created_at);
        assert_eq!(
            converted.workspace_schema_version,
            legacy.workspace_schema_version
        );
        assert_eq!(reopened.local_secret_key.as_deref(), Some("old password"));
        assert!(legacy.local_secret_key.is_none());
    }

    #[test]
    fn invalid_local_key_fails_without_regenerating_metadata() {
        let root = tempfile::tempdir().unwrap();
        let (metadata, paths) = create_passwordless_workspace(root.path()).unwrap();
        for key in [None, Some(""), Some("wrong key")] {
            let mut corrupt = serde_json::to_value(&metadata).unwrap();
            corrupt["localSecretKey"] = serde_json::json!(key);
            let raw = serde_json::to_string(&corrupt).unwrap();
            fs::write(&paths.metadata_path, &raw).unwrap();
            assert!(load_metadata(root.path()).is_err());
            assert_eq!(fs::read_to_string(&paths.metadata_path).unwrap(), raw);
        }
    }

    #[test]
    fn failed_conversion_keeps_original_metadata_and_key() {
        let root = tempfile::tempdir().unwrap();
        let (legacy, paths) = create_workspace(root.path(), "old password").unwrap();
        let raw = fs::read_to_string(&paths.metadata_path).unwrap();
        let blocked = root.path().join("blocked");
        fs::write(&blocked, "file blocks parent directory").unwrap();
        assert!(
            enable_passwordless_workspace(&blocked.join("workspace.json"), &legacy, "new key")
                .is_err()
        );
        assert_eq!(fs::read_to_string(&paths.metadata_path).unwrap(), raw);
        assert!(legacy.local_secret_key.is_none());
        assert_eq!(legacy.security_mode, "workspace_password_encrypted");
    }

    #[test]
    fn passwordless_creation_reopens_with_the_same_isolated_key() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let (created, paths) = create_passwordless_workspace(first.path()).unwrap();
        let (reopened, _) = load_metadata(first.path()).unwrap();
        let (other, _) = create_passwordless_workspace(second.path()).unwrap();
        assert_eq!(created.security_mode, "workspace_local_key_encrypted");
        assert_eq!(created.local_secret_key, reopened.local_secret_key);
        assert_ne!(created.local_secret_key, other.local_secret_key);
        assert!(!created.local_secret_key.as_ref().unwrap().is_empty());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(paths.metadata_path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
