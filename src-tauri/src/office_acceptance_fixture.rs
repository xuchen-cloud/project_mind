//! Opt-in isolated UI acceptance data. Never linked into a production binary.
//! The original Workspace is opened only through a read-only SQLite connection;
//! decrypted provider/proxy credentials stay in native memory and are re-encrypted
//! by the production settings APIs under the fresh Workspace's local secret.
use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, bail, Result};
use rusqlite::{Connection, OpenFlags, MAIN_DB};
use serde::Serialize;

use crate::{
    db::Database,
    models::{
        AiCapabilityBindingUpsertInput, AiNetworkSettingsUpsertInput, AiProviderProfileUpsertInput,
        ProjectCreateInput,
    },
    workspace::{
        create_passwordless_workspace, load_metadata, save_local_session, workspace_paths,
        LocalSessionState, LEGACY_WORKSPACE_SECURITY_MODE,
    },
};

const PROJECT_NAME: &str = "季度经营复盘验收";
const BRIEF_NAME: &str = "经营简报.txt";
const BRIEF: &str = "季度经营复盘简报\nQ1：营收120万元，成本80万元。\nQ2：营收180万元，成本110万元。\n目标：营收增长30%。\n项目任务：季度经营复盘，明天向管理层汇报。\n数据均为本次隔离验收的示例数据。\n";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FixtureSummary {
    qa_workspace: String,
    project_id: i64,
    project_directory: String,
    model_id: String,
}

fn empty_target_outside_source(path: &Path, source: &Path) -> Result<()> {
    if !path.is_absolute() {
        bail!("QA targets must be absolute paths");
    }
    let mut existing = path;
    while !existing.exists() {
        existing = existing
            .parent()
            .ok_or_else(|| anyhow!("QA target has no existing ancestor"))?;
    }
    if existing.canonicalize()?.starts_with(source) {
        bail!("QA targets must be outside the source Workspace");
    }
    if path.exists() && (!path.is_dir() || fs::read_dir(path)?.next().is_some()) {
        bail!("QA targets must be new or empty directories");
    }
    Ok(())
}

fn initialize(
    source_root: &Path,
    qa_root: &Path,
    qa_app_data: &Path,
    source_app_data: &Path,
    supplied_password: Option<&str>,
) -> Result<FixtureSummary> {
    let source_root = source_root.canonicalize()?;
    empty_target_outside_source(qa_root, &source_root)?;
    empty_target_outside_source(qa_app_data, &source_root)?;
    if qa_root == qa_app_data {
        bail!("QA Workspace and app data must be different directories");
    }
    let (source_metadata, source_paths) = load_metadata(&source_root)?;
    let source_key = if let Some(key) = source_metadata.local_secret_key {
        key
    } else if source_metadata.security_mode == LEGACY_WORKSPACE_SECURITY_MODE {
        if let Some(password) = supplied_password {
            crate::workspace::verify_workspace_password(&source_metadata, password)?;
            password.to_owned()
        } else {
            crate::debug_read_workspace_key(source_app_data, &source_metadata.workspace_id)?
                .ok_or_else(|| {
                    anyhow!("Source Workspace needs its existing development key cache")
                })?
        }
    } else {
        bail!("Source Workspace has no usable native local secret");
    };
    let temporary = tempfile::tempdir()?;
    let snapshot_root = temporary.path();
    let snapshot_paths = workspace_paths(snapshot_root);
    fs::create_dir_all(&snapshot_paths.hidden_dir)?;
    let readonly = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    let source_connection = Connection::open_with_flags(&source_paths.db_path, readonly)?;
    source_connection.backup(MAIN_DB, &snapshot_paths.db_path, None)?;
    drop(source_connection);
    // No migrations, source cleanup or path repair run against the original or
    // snapshot. The existing native resolver reads the consistent copied DB.
    let mut source = Database::open_runtime_connection(
        &snapshot_paths.db_path,
        snapshot_root,
        Some(source_key),
    )?;
    let resolved = source
        .agent_resolve_profile(None)
        .map_err(|error| anyhow!(error.message))?
        .profile;
    let settings = source.ai_settings_get()?;
    let default_profile_id = settings
        .bindings
        .iter()
        .find(|binding| binding.capability == "default")
        .and_then(|binding| binding.profile_id)
        .ok_or_else(|| anyhow!("General default profile is unavailable"))?;
    let stored = settings
        .profiles
        .iter()
        .find(|profile| profile.id == default_profile_id)
        .ok_or_else(|| anyhow!("General default profile record is unavailable"))?;

    fs::create_dir_all(qa_root)?;
    fs::create_dir_all(qa_app_data)?;
    let (metadata, paths) = create_passwordless_workspace(qa_root)?;
    let mut target = Database::open(&paths.db_path, qa_root, metadata.local_secret_key)?;
    let profile = target.ai_profile_upsert(AiProviderProfileUpsertInput {
        id: None,
        name: "Office真实验收模型".into(),
        provider_family: resolved.provider_family,
        base_url: resolved.base_url,
        api_key: Some(resolved.api_key),
        default_model: resolved.model.clone(),
        supports_text: resolved.supports_text,
        supports_image: resolved.supports_image,
        supports_file: stored.supports_file,
        enabled: true,
    })?;
    target.ai_binding_upsert(AiCapabilityBindingUpsertInput {
        capability: "default".into(),
        use_default: false,
        profile_id: Some(profile.id),
        model: Some(resolved.model.clone()),
    })?;
    // Resolved custom URLs may contain proxy credentials. The production write
    // API splits and encrypts those credentials using the new Workspace key.
    target.ai_network_settings_upsert(AiNetworkSettingsUpsertInput {
        mode: resolved.network.mode,
        proxy_url: resolved.network.proxy_url,
        username: None,
        password: None,
    })?;
    let project = target.project_create(ProjectCreateInput {
        name: PROJECT_NAME.into(),
        summary: Some("根据经营简报准备明天管理层季度复盘材料。".into()),
        status: None,
    })?;
    fs::write(Path::new(&project.root_path).join(BRIEF_NAME), BRIEF)?;
    let file = target.project_file_register(&metadata.workspace_id, project.id, BRIEF_NAME)?;
    if file.state != "ready" || file.version_number != 1 || file.content_hash.is_none() {
        bail!("QA brief did not become a ready native File v1");
    }
    let mut session = LocalSessionState::default();
    session.record_recent_workspace(qa_root);
    save_local_session(&qa_app_data.join("workspace-session.json"), &session)?;
    Ok(FixtureSummary {
        qa_workspace: qa_root.to_string_lossy().into_owned(),
        project_id: project.id,
        project_directory: project.root_path,
        model_id: resolved.model,
    })
}

#[test]
#[ignore = "requires explicit real source Workspace and isolated QA directories"]
fn initialize_real_office_acceptance_workspace() -> Result<()> {
    let path = |name| {
        std::env::var_os(name)
            .map(PathBuf::from)
            .ok_or_else(|| anyhow!("Missing required acceptance environment: {name}"))
    };
    let summary = initialize(
        &path("PROJECT_MIND_QA_SOURCE_WORKSPACE")?,
        &path("PROJECT_MIND_QA_ROOT")?,
        &path("PROJECT_MIND_QA_APP_DATA")?,
        &crate::default_app_data_dir()?,
        std::env::var("PROJECT_MIND_QA_SOURCE_PASSWORD")
            .ok()
            .as_deref(),
    )?;
    println!("{}", serde_json::to_string(&summary)?);
    Ok(())
}

#[test]
fn fixture_copies_profile_from_readonly_snapshot_and_preserves_original() -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let source_root = temporary.path().join("source");
    let source_app_data = temporary.path().join("source-app-data");
    let qa_root = temporary.path().join("qa-workspace");
    let qa_app_data = temporary.path().join("qa-app-data");
    let (metadata, paths) = create_passwordless_workspace(&source_root)?;
    let mut db = Database::open(&paths.db_path, &source_root, metadata.local_secret_key)?;
    let profile = db.ai_profile_upsert(AiProviderProfileUpsertInput {
        id: None,
        name: "fixture".into(),
        provider_family: "openai_compatible".into(),
        base_url: "http://localhost:12345/v1".into(),
        api_key: Some("fixture-credential".into()),
        default_model: "profile-default".into(),
        supports_text: true,
        supports_image: false,
        supports_file: true,
        enabled: true,
    })?;
    db.ai_binding_upsert(AiCapabilityBindingUpsertInput {
        capability: "default".into(),
        use_default: false,
        profile_id: Some(profile.id),
        model: Some("general-binding-model".into()),
    })?;
    db.ai_network_settings_upsert(AiNetworkSettingsUpsertInput {
        mode: crate::models::AiProxyMode::Direct,
        proxy_url: None,
        username: None,
        password: None,
    })?;
    drop(db);
    let metadata_before = fs::read(&paths.metadata_path)?;
    let db_before = fs::read(&paths.db_path)?;
    let summary = initialize(&source_root, &qa_root, &qa_app_data, &source_app_data, None)?;
    assert_eq!(summary.model_id, "general-binding-model");
    assert_eq!(fs::read(&paths.metadata_path)?, metadata_before);
    assert_eq!(fs::read(&paths.db_path)?, db_before);
    let (qa_metadata, qa_paths) = load_metadata(&qa_root)?;
    let target = Database::open_runtime_connection(
        &qa_paths.db_path,
        &qa_root,
        qa_metadata.local_secret_key,
    )?;
    let resolved = target
        .agent_resolve_profile(None)
        .map_err(|error| anyhow!(error.message))?
        .profile;
    assert!(resolved.api_key == "fixture-credential");
    assert_eq!(resolved.network.mode, crate::models::AiProxyMode::Direct);
    assert!(fs::read(qa_paths.db_path)?
        .windows("fixture-credential".len())
        .all(|bytes| bytes != b"fixture-credential"));
    assert_eq!(
        fs::read_to_string(Path::new(&summary.project_directory).join(BRIEF_NAME))?,
        BRIEF
    );
    assert_eq!(
        crate::workspace::load_local_session(&qa_app_data.join("workspace-session.json"))?
            .last_opened_workspace_root,
        Some(qa_root.to_string_lossy().into_owned())
    );
    assert!(initialize(&source_root, &qa_root, &qa_app_data, &source_app_data, None).is_err());
    assert!(
        empty_target_outside_source(&source_root.join("nested"), &source_root.canonicalize()?)
            .is_err()
    );
    Ok(())
}

#[test]
fn supplied_legacy_password_is_verified_without_migrating_source() -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let source = temporary.path().join("legacy");
    let (_, paths) = crate::workspace::create_workspace(&source, "fixture-password")?;
    let before = fs::read(&paths.metadata_path)?;
    for password in [Some("wrong"), Some("fixture-password")] {
        // No profile exists: the correct password passes verification, then
        // stops at model resolution. Both attempts leave source bytes intact.
        let error = initialize(
            &source,
            &temporary.path().join("qa"),
            &temporary.path().join("data"),
            temporary.path(),
            password,
        )
        .err()
        .unwrap();
        if password == Some("wrong") {
            assert!(error.to_string().contains("password is incorrect"));
        } else {
            assert!(!error.to_string().contains("password is incorrect"));
        }
        assert_eq!(fs::read(&paths.metadata_path)?, before);
    }
    Ok(())
}
