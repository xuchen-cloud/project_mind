use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Context, Result};
use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::models::WorkspaceSummary;

pub const WORKSPACE_HIDDEN_DIR_NAME: &str = ".project-mind";
pub const WORKSPACE_DB_FILE_NAME: &str = "workspace.sqlite3";
pub const WORKSPACE_METADATA_FILE_NAME: &str = "workspace.json";
pub const WORKSPACE_SECURITY_MODE: &str = "workspace_password_encrypted";

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMetadata {
    pub workspace_id: String,
    pub workspace_schema_version: i64,
    pub created_at: String,
    pub security_mode: String,
    pub password_verifier: PasswordVerifier,
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
        security_mode: WORKSPACE_SECURITY_MODE.to_string(),
        password_verifier: create_password_verifier(password)?,
    };
    save_metadata(&paths.metadata_path, &metadata)?;
    Ok((metadata, paths))
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
    if metadata.security_mode != WORKSPACE_SECURITY_MODE {
        return Err(anyhow!("workspace security mode is not supported"));
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
        if path == session_path {
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
    fs::write(path, raw)
        .with_context(|| format!("failed to write workspace metadata at {}", path.display()))
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
