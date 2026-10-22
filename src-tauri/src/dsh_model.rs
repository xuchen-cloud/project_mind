//! Bounded, one-shot model requests through the staged DSH distribution.
use crate::{
    agent::errors::{AgentError, AgentResult, ErrorCode},
    ai_provider::ResolvedAiProfile,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
};
use tauri::Manager;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::watch,
    time::Instant,
};

pub(crate) const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const DISTRIBUTION_MANIFEST_BYTES: usize = 16 * 1024 * 1024;
const METADATA_BYTES: usize = 4 * 1024 * 1024;
const NODE_GUARD: &str = "data:text/javascript,if(process.versions.node!==%2724.21.0%27)throw%20new%20Error(%27Unsupported%20model%20runtime%27)";
const PINNED_NODE: &str = include_str!("../../packages/agent-host/runtime-manifest.json");

fn unavailable() -> AgentError {
    AgentError::new(
        ErrorCode::RuntimeUnavailable,
        "Packaged DSH model resources are unavailable",
    )
}
fn incompatible() -> AgentError {
    AgentError::new(
        ErrorCode::RuntimeIncompatible,
        "DSH model utility response is incompatible",
    )
}
fn pipe_failed() -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "DSH model utility pipe failed")
}
pub(crate) fn timed_out() -> AgentError {
    AgentError::new(ErrorCode::TimedOut, "DSH model request timed out")
}
fn cancelled() -> AgentError {
    AgentError::new(ErrorCode::Cancelled, "DSH model request was cancelled")
}

fn regular_json(path: &Path, limit: usize) -> AgentResult<Value> {
    let file = crate::source_file_snapshot::open_regular(path).map_err(|_| unavailable())?;
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unavailable())?;
    if bytes.len() > limit {
        return Err(unavailable());
    }
    serde_json::from_slice(&bytes).map_err(|_| unavailable())
}
fn verify_hash(path: &Path, expected: &Value) -> AgentResult<()> {
    let checksum = crate::db::file_versions::checksum(path).map_err(|_| unavailable())?;
    if expected.as_str() != checksum.strip_prefix("sha256:") {
        return Err(unavailable());
    }
    Ok(())
}
fn target() -> AgentResult<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("darwin-arm64"),
        ("macos", "x86_64") => Ok("darwin-x64"),
        ("windows", "aarch64") => Ok("win-arm64"),
        ("windows", "x86_64") => Ok("win-x64"),
        #[cfg(any(debug_assertions, test))]
        ("linux", "x86_64") => Ok("linux-x64"),
        _ => Err(unavailable()),
    }
}
fn inventory(root: &Path, relative: &str, files: &mut HashSet<String>) -> AgentResult<()> {
    let path = root.join(relative);
    let metadata = fs::symlink_metadata(&path).map_err(|_| unavailable())?;
    if metadata.file_type().is_symlink() {
        return Err(unavailable());
    }
    if metadata.is_file() {
        if relative != "dsh-distribution.json" {
            files.insert(relative.to_owned());
        }
    } else if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(|_| unavailable())? {
            let name = entry
                .map_err(|_| unavailable())?
                .file_name()
                .into_string()
                .map_err(|_| unavailable())?;
            let next = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            inventory(root, &next, files)?;
        }
    } else {
        return Err(unavailable());
    }
    Ok(())
}
fn valid_path(relative: &str) -> bool {
    !relative.contains(['\\', ':', '\0'])
        && !relative
            .split('/')
            .any(|part| matches!(part, "" | "." | ".."))
}

pub(crate) struct ModelRuntime {
    root: PathBuf,
    node: PathBuf,
}
impl ModelRuntime {
    fn resources(app: &tauri::AppHandle) -> AgentResult<PathBuf> {
        if let Ok(resources) = app.path().resource_dir() {
            if resources
                .join("dsh-assistant/dsh-distribution.json")
                .is_file()
            {
                return Ok(resources);
            }
        }
        #[cfg(debug_assertions)]
        {
            return Ok(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"));
        }
        #[cfg(not(debug_assertions))]
        Err(unavailable())
    }
    pub(crate) fn available(app: &tauri::AppHandle) -> bool {
        Self::resources(app).is_ok_and(|resources| {
            resources
                .join("dsh-assistant/dsh-distribution.json")
                .is_file()
                && resources
                    .join("dsh-assistant/scripts/model-utility-entry.mjs")
                    .is_file()
                && resources
                    .join("agent-host")
                    .join(if cfg!(windows) { "node.exe" } else { "node" })
                    .is_file()
        })
    }
    pub(crate) fn for_app(app: &tauri::AppHandle) -> AgentResult<Self> {
        Self::bundled(&Self::resources(app)?)
    }
    pub(crate) fn bundled(resources: &Path) -> AgentResult<Self> {
        let root = resources.join("dsh-assistant");
        let node_root = resources.join("agent-host");
        for directory in [&root, &node_root] {
            let metadata = fs::symlink_metadata(directory).map_err(|_| unavailable())?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(unavailable());
            }
        }
        let node_name = if cfg!(windows) { "node.exe" } else { "node" };
        let node = node_root.join(node_name);
        let receipt = regular_json(&node_root.join("runtime.json"), METADATA_BYTES)?;
        let pinned: Value = serde_json::from_str(PINNED_NODE).map_err(|_| unavailable())?;
        let target = target()?;
        if receipt["target"] != target
            || receipt["nodeVersion"] != "24.21.0"
            || receipt["nodeVersion"] != pinned["nodeVersion"]
            || receipt["sourceArchive"] != pinned["targets"][target]["archive"]
            || receipt["sourceArchiveChecksum"] != pinned["targets"][target]["sha256"]
        {
            return Err(unavailable());
        }
        verify_hash(&node, &receipt["nodeChecksum"])?;
        let manifest = regular_json(
            &root.join("dsh-distribution.json"),
            DISTRIBUTION_MANIFEST_BYTES,
        )?;
        if manifest["schemaVersion"] != 1
            || manifest["target"] != target
            || manifest["entry"] != "scripts/runtime.mjs"
            || manifest["installAnchor"] != "package.json"
            || manifest["node"]["executable"] != format!("../agent-host/{node_name}")
            || manifest["node"]["version"] != receipt["nodeVersion"]
            || manifest["node"]["checksum"] != receipt["nodeChecksum"]
            || manifest["packages"].as_array().is_none_or(Vec::is_empty)
        {
            return Err(unavailable());
        }
        verify_hash(
            &root.join("package-lock.json"),
            &manifest["lockfileChecksum"],
        )?;
        verify_hash(
            &root.join("DSH-THIRD-PARTY-NOTICES.txt"),
            &manifest["noticesChecksum"],
        )?;
        let mut actual = HashSet::new();
        inventory(&root, "", &mut actual)?;
        let mut expected = HashSet::new();
        for file in manifest["files"].as_array().ok_or_else(unavailable)? {
            let relative = file["file"].as_str().ok_or_else(unavailable)?;
            if !valid_path(relative)
                || !expected.insert(relative.to_owned())
                || !actual.contains(relative)
            {
                return Err(unavailable());
            }
            verify_hash(&root.join(relative), &file["checksum"])?;
        }
        if expected != actual
            || !expected.contains("scripts/model-utility-entry.mjs")
            || !expected.contains("scripts/runtime.mjs")
            || !expected.contains("upstream.json")
        {
            return Err(unavailable());
        }
        let upstream = regular_json(&root.join("upstream.json"), METADATA_BYTES)?;
        let pinned_upstream: Value =
            serde_json::from_str(include_str!("../../packages/dsh-assistant/upstream.json"))
                .map_err(|_| unavailable())?;
        if upstream != pinned_upstream {
            return Err(unavailable());
        }
        Ok(Self {
            root: root.canonicalize().map_err(|_| unavailable())?,
            node,
        })
    }

    pub(crate) async fn call(
        &self,
        operation: &str,
        profile: &mut ResolvedAiProfile,
        data: Value,
        deadline: Instant,
        mut cancel: Option<&mut watch::Receiver<bool>>,
    ) -> AgentResult<Value> {
        let frame = request(operation, profile, data);
        profile.api_key.clear();
        let mut frame = frame?;
        // Keys are sent once over stdin and never placed in args, files or errors.
        let temporary = tempfile::tempdir().map_err(|_| unavailable())?;
        let mut command = Command::new(&self.node);
        command
            .arg("--permission")
            .arg("--use-env-proxy")
            .arg("--max-old-space-size=512")
            .arg(format!("--allow-fs-read={}", self.root.display()))
            .arg(format!("--import={NODE_GUARD}"))
            .arg(self.root.join("scripts/model-utility-entry.mjs"))
            .current_dir(temporary.path())
            .env_clear()
            .env("PATH", "")
            .env("HOME", temporary.path())
            .env("USERPROFILE", temporary.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for name in [
            "SystemRoot",
            "WINDIR",
            "LANG",
            "LC_ALL",
            "NODE_EXTRA_CA_CERTS",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        crate::ai_network::configure_node(&mut command, &profile.base_url, &profile.network)
            .map_err(|_| {
                AgentError::new(
                    ErrorCode::ProfileUnavailable,
                    "Cannot apply AI network settings",
                )
            })?;
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        if Instant::now() >= deadline {
            return Err(timed_out());
        }
        if cancel.as_ref().is_some_and(|receiver| *receiver.borrow()) {
            return Err(cancelled());
        }
        let mut child = command.spawn().map_err(|_| unavailable())?;
        let mut input = child.stdin.take().ok_or_else(pipe_failed)?;
        let output = child.stdout.take().ok_or_else(pipe_failed)?;
        let result = tokio::select! {
            biased;
            _ = cancellation(&mut cancel) => Err(cancelled()),
            _ = tokio::time::sleep_until(deadline) => Err(timed_out()),
            result = async {
                let send = async {
                    let result = input.write_all(&frame.0).await;
                    frame.0.fill(0);
                    result.map_err(|_| pipe_failed())?;
                    input.shutdown().await.map_err(|_| pipe_failed())?;
                    drop(input);
                    Ok::<_, AgentError>(())
                };
                let receive = async {
                    let mut bytes = Vec::new();
                    output.take(MAX_RESPONSE_BYTES as u64 + 1).read_to_end(&mut bytes).await.map_err(|_| pipe_failed())?;
                    if bytes.len() > MAX_RESPONSE_BYTES { return Err(incompatible()); }
                    Ok(bytes)
                };
                let (_, bytes) = tokio::try_join!(send, receive)?;
                let status = child.wait().await.map_err(|_| pipe_failed())?;
                if !status.success() { return Err(incompatible()); }
                response(&bytes)
            } => result,
        };
        if result.is_err() {
            child.kill().await.map_err(|_| pipe_failed())?;
        }
        result
    }
}

struct SensitiveFrame(Vec<u8>);
impl Drop for SensitiveFrame {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}
fn request(
    operation: &str,
    profile: &ResolvedAiProfile,
    data: Value,
) -> AgentResult<SensitiveFrame> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Metadata<'a> {
        provider_family: &'a str,
        base_url: &'a str,
        default_model: &'a str,
        supports_text: bool,
        enabled: bool,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Request<'a> {
        operation: &'a str,
        profile: Metadata<'a>,
        model_id: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        api_key: Option<&'a str>,
        #[serde(flatten)]
        data: Value,
    }
    let frame = SensitiveFrame(
        serde_json::to_vec(&Request {
            operation,
            profile: Metadata {
                provider_family: &profile.provider_family,
                base_url: &profile.base_url,
                default_model: &profile.model,
                supports_text: profile.supports_text,
                enabled: true,
            },
            model_id: &profile.model,
            api_key: (operation != "capacity").then_some(profile.api_key.as_str()),
            data,
        })
        .map_err(|_| incompatible())?,
    );
    if frame.0.len() > MAX_REQUEST_BYTES {
        return Err(AgentError::new(
            ErrorCode::BudgetExceeded,
            "DSH model request exceeds its input limit",
        ));
    }
    Ok(frame)
}

async fn cancellation(cancel: &mut Option<&mut watch::Receiver<bool>>) {
    let Some(cancel) = cancel else {
        return std::future::pending().await;
    };
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            return;
        }
    }
}
pub(crate) async fn cancelled_watch(cancel: &mut watch::Receiver<bool>) {
    cancellation(&mut Some(cancel)).await
}
fn response(bytes: &[u8]) -> AgentResult<Value> {
    let frame: Value = serde_json::from_slice(bytes).map_err(|_| incompatible())?;
    match frame["ok"].as_bool() {
        Some(true) if frame["data"].is_object() => Ok(frame["data"].clone()),
        Some(false) => {
            let code = match frame["error"]["code"].as_str() {
                Some("RUN_CANCELLED") => ErrorCode::Cancelled,
                Some("MODEL_FAILED" | "RUNTIME_FAILED") => ErrorCode::RuntimeUnavailable,
                _ => serde_json::from_value(frame["error"]["code"].clone())
                    .unwrap_or(ErrorCode::RuntimeIncompatible),
            };
            Err(AgentError::new(code, "DSH model request failed"))
        }
        _ => Err(incompatible()),
    }
}

#[cfg(test)]
#[path = "dsh_model_tests.rs"]
mod tests;
