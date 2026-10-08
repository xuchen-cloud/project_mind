//! Packaged Node JSONL transport. Lifecycle deadlines and request correlation
//! belong to the Workspace host; this boundary owns pipes and bounded frames.
use super::errors::{AgentError, AgentResult, ErrorCode};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

pub(crate) const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const NODE_VERSION_GUARD: &str = "data:text/javascript,if(process.versions.node!==%2724.21.0%27)throw%20new%20Error(%27Unsupported%20agent%20runtime%27)";
const PINNED_RUNTIME: &str = include_str!("../../../packages/agent-host/runtime-manifest.json");

fn unavailable() -> AgentError {
    AgentError::new(
        ErrorCode::RuntimeUnavailable,
        "Packaged Agent resources are unavailable or incompatible",
    )
}
fn pipe_failed() -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Agent process pipe failed")
}
fn incompatible(message: &'static str) -> AgentError {
    AgentError::new(ErrorCode::RuntimeIncompatible, message)
}
fn directory(path: &Path) -> AgentResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| unavailable())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(unavailable());
    }
    Ok(())
}
fn regular_json(path: &Path) -> AgentResult<Value> {
    use std::io::Read;
    let file = crate::source_file_snapshot::open_regular(path).map_err(|_| unavailable())?;
    let mut bytes = Vec::new();
    file.take(MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unavailable())?;
    if bytes.len() as u64 > MANIFEST_BYTES {
        return Err(unavailable());
    }
    serde_json::from_slice(&bytes).map_err(|_| unavailable())
}
fn verify_hash(path: &Path, expected: &Value) -> AgentResult<()> {
    // Reuse the no-follow, identity-checked streaming hash used for File Versions.
    let actual = crate::db::file_versions::checksum(path).map_err(|_| unavailable())?;
    if expected.as_str() != actual.strip_prefix("sha256:") {
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
        // Cloud development is not a supported product release platform.
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
        files.insert(relative.to_owned());
    } else if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(|_| unavailable())? {
            let entry = entry.map_err(|_| unavailable())?;
            let name = entry.file_name().into_string().map_err(|_| unavailable())?;
            inventory(root, &format!("{relative}/{name}"), files)?;
        }
    } else {
        return Err(unavailable());
    }
    Ok(())
}
fn valid_distribution_path(relative: &str) -> bool {
    !relative.contains(['\\', ':', '\0'])
        && !relative
            .split('/')
            .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
        && (relative.starts_with("src/")
            || relative.starts_with("node_modules/")
            || matches!(relative, "package.json" | "package-lock.json"))
}

#[derive(Clone)]
pub(crate) struct PackagedAgentRuntime {
    root: PathBuf,
    node: PathBuf,
}
impl PackagedAgentRuntime {
    fn resources_for_app(app: &tauri::AppHandle) -> AgentResult<PathBuf> {
        use tauri::Manager;
        if let Ok(resources) = app.path().resource_dir() {
            if resources.join("agent-host/runtime.json").is_file() {
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

    pub(crate) fn for_app(app: &tauri::AppHandle) -> AgentResult<Self> {
        Self::bundled(&Self::resources_for_app(app)?)
    }

    /// Resource presence is suitable for status only. Starting a run still
    /// requires the complete pinned inventory verification in for_app/bundled.
    pub(crate) fn available(app: &tauri::AppHandle) -> bool {
        let Ok(resources) = Self::resources_for_app(app) else {
            return false;
        };
        let root = resources.join("agent-host");
        [
            "runtime.json",
            "pi-distribution.json",
            "src/index.mjs",
            if cfg!(windows) { "node.exe" } else { "node" },
        ]
        .iter()
        .all(|name| root.join(name).is_file())
    }

    pub(crate) fn bundled(resources: &Path) -> AgentResult<Self> {
        let root = resources.join("agent-host");
        directory(&root)?;
        let root = root.canonicalize().map_err(|_| unavailable())?;
        let runtime = regular_json(&root.join("runtime.json"))?;
        let pinned: Value = serde_json::from_str(PINNED_RUNTIME).map_err(|_| unavailable())?;
        let target = target()?;
        if runtime["target"] != target
            || runtime["nodeVersion"] != pinned["nodeVersion"]
            || runtime["nodeVersion"] != "24.21.0"
            || runtime["sourceArchive"] != pinned["targets"][target]["archive"]
            || runtime["sourceArchiveChecksum"] != pinned["targets"][target]["sha256"]
        {
            return Err(unavailable());
        }
        let node = root.join(if cfg!(windows) { "node.exe" } else { "node" });
        verify_hash(&node, &runtime["nodeChecksum"])?;
        let manifest_path = root.join("pi-distribution.json");
        verify_hash(&manifest_path, &runtime["piDistributionChecksum"])?;
        let manifest = regular_json(&manifest_path)?;
        if manifest["schemaVersion"] != 1
            || manifest["target"] != target
            || manifest["sdk"] != pinned["sdk"]
            || manifest["noticesChecksum"] != runtime["piNoticesChecksum"]
            || manifest["packages"].as_array().is_none_or(Vec::is_empty)
        {
            return Err(unavailable());
        }
        verify_hash(
            &root.join("PI-THIRD-PARTY-NOTICES.txt"),
            &runtime["piNoticesChecksum"],
        )?;
        verify_hash(
            &root.join("package-lock.json"),
            &manifest["lockfileChecksum"],
        )?;
        let mut actual = HashSet::new();
        for name in ["src", "node_modules", "package.json", "package-lock.json"] {
            inventory(&root, name, &mut actual)?;
        }
        let mut expected = HashSet::new();
        for item in manifest["files"].as_array().ok_or_else(unavailable)? {
            let relative = item["file"].as_str().ok_or_else(unavailable)?;
            if !valid_distribution_path(relative)
                || !expected.insert(relative.to_owned())
                || !actual.contains(relative)
            {
                return Err(unavailable());
            }
            verify_hash(&root.join(relative), &item["checksum"])?;
        }
        if actual != expected
            || !expected.contains("src/index.mjs")
            || !expected.contains("src/probe-entry.mjs")
            || !expected.contains("node_modules/@earendil-works/pi-coding-agent/package.json")
        {
            return Err(unavailable());
        }
        Ok(Self { root, node })
    }

    pub(crate) async fn spawn(
        &self,
        workspace_root: &Path,
        probe: bool,
    ) -> AgentResult<HostProcess> {
        let workspace_root = workspace_root.canonicalize().map_err(|_| unavailable())?;
        directory(&workspace_root)?;
        // The Host creates the fixed ancestors before granting the child writes
        // only to sessions. SessionStore checks each session directory itself.
        let mut sessions = workspace_root.clone();
        for segment in [".project-mind", "agent", "sessions"] {
            sessions.push(segment);
            match fs::create_dir(&sessions) {
                Ok(()) => {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        fs::set_permissions(&sessions, fs::Permissions::from_mode(0o700))
                            .map_err(|_| unavailable())?;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err(unavailable()),
            }
            directory(&sessions)?;
        }
        let temporary = tempfile::tempdir().map_err(|_| unavailable())?;
        #[cfg(unix)]
        let private_home = temporary.path().canonicalize().map_err(|_| unavailable())?;
        #[cfg(not(unix))]
        let private_home = temporary.path().to_owned();
        let mut command = Command::new(&self.node);
        command
            .arg("--permission")
            .arg("--use-env-proxy")
            .arg("--max-old-space-size=512")
            .arg(format!("--allow-fs-read={}", self.root.display()))
            // SessionStore validates its Workspace root and fixed ancestors.
            // Directory read permission includes descendants; tool grants remain
            // a separate trusted service boundary, not an OS sandbox assertion.
            .arg(format!("--allow-fs-read={}", workspace_root.display()))
            .arg(format!("--allow-fs-write={}", sessions.display()))
            .arg(format!("--import={NODE_VERSION_GUARD}"))
            .arg(self.root.join(if probe {
                "src/probe-entry.mjs"
            } else {
                "src/index.mjs"
            }))
            .current_dir(&private_home)
            .env_clear()
            .env("PATH", "")
            // SDK module initialization calls os.homedir even with discovery
            // disabled. Supply an isolated home, including for UIDs without a
            // passwd entry; never expose the user's real home or Pi directory.
            .env("HOME", &private_home)
            .env("USERPROFILE", &private_home);
        // Never forward NODE_OPTIONS, user HOME, SDK discovery variables, or keys.
        for name in [
            "SystemRoot",
            "WINDIR",
            "ComSpec",
            "TEMP",
            "TMP",
            "TMPDIR",
            "LANG",
            "LC_ALL",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "no_proxy",
            "NODE_EXTRA_CA_CERTS",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        HostProcess::start(command, temporary)
    }
}

pub(crate) struct HostProcess {
    child: Child,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
    pending: Vec<u8>,
    // Keep the private cwd alive until after the child is killed/dropped.
    _temporary: tempfile::TempDir,
}
impl HostProcess {
    fn start(mut command: Command, temporary: tempfile::TempDir) -> AgentResult<Self> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| unavailable())?;
        let input = child.stdin.take().ok_or_else(pipe_failed)?;
        let output = child.stdout.take().ok_or_else(pipe_failed)?;
        Ok(Self {
            child,
            input: Some(input),
            output: BufReader::new(output),
            pending: Vec::new(),
            _temporary: temporary,
        })
    }

    pub(crate) async fn send(&mut self, value: &Value) -> AgentResult<()> {
        let mut frame = BoundedFrame(Vec::new());
        serde_json::to_writer(&mut frame, value).map_err(|_| {
            AgentError::new(
                ErrorCode::InvalidArgument,
                "Agent request exceeds frame limit",
            )
        })?;
        frame.0.push(b'\n');
        let input = self.input.as_mut().ok_or_else(pipe_failed)?;
        input.write_all(&frame.0).await.map_err(|_| pipe_failed())?;
        input.flush().await.map_err(|_| pipe_failed())
    }

    pub(crate) async fn next_frame(&mut self) -> AgentResult<Option<Value>> {
        let result = self.read_frame().await;
        if result.is_err() {
            // Invalid/unbounded child output cannot keep the process alive.
            let _ = self.kill().await;
        }
        result
    }

    async fn read_frame(&mut self) -> AgentResult<Option<Value>> {
        loop {
            let bytes = self.output.fill_buf().await.map_err(|_| pipe_failed())?;
            if bytes.is_empty() {
                return if self.pending.is_empty() {
                    Ok(None)
                } else {
                    Err(incompatible("Agent process ended with an incomplete frame"))
                };
            }
            let newline = bytes.iter().position(|byte| *byte == b'\n');
            let length = newline.unwrap_or(bytes.len());
            if self.pending.len() + length > MAX_FRAME_BYTES {
                return Err(incompatible("Agent response exceeds frame limit"));
            }
            self.pending.extend_from_slice(&bytes[..length]);
            self.output.consume(length + usize::from(newline.is_some()));
            if newline.is_some() {
                let value = serde_json::from_slice(&self.pending)
                    .map_err(|_| incompatible("Agent response is not a JSON frame"))?;
                self.pending.clear();
                return Ok(Some(value));
            }
            // Pending bytes are stored on self so cancellation while waiting for
            // the next chunk does not lose a partial frame.
        }
    }

    /// Close the pipe and await the Host's own shutdown. The caller supplies the
    /// deadline, sends the protocol shutdown frame, and escalates to kill.
    pub(crate) async fn shutdown(&mut self) -> AgentResult<()> {
        if let Some(mut input) = self.input.take() {
            input.shutdown().await.map_err(|_| pipe_failed())?;
        }
        let status = self.child.wait().await.map_err(|_| pipe_failed())?;
        if !status.success() {
            return Err(incompatible("Agent process exited unsuccessfully"));
        }
        Ok(())
    }

    pub(crate) async fn kill(&mut self) -> AgentResult<()> {
        self.input.take();
        self.child.kill().await.map_err(|_| pipe_failed())
    }
}

struct BoundedFrame(Vec<u8>);
impl Write for BoundedFrame {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > MAX_FRAME_BYTES {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "Frame limit"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Duration;

    fn hash(path: &Path) -> String {
        crate::db::file_versions::checksum(path)
            .unwrap()
            .strip_prefix("sha256:")
            .unwrap()
            .to_owned()
    }
    fn write_json(path: &Path, value: &Value) {
        fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    }
    fn seal_manifest(root: &Path, manifest: &Value) {
        write_json(&root.join("pi-distribution.json"), manifest);
        let mut runtime = regular_json(&root.join("runtime.json")).unwrap();
        runtime["piDistributionChecksum"] = json!(hash(&root.join("pi-distribution.json")));
        write_json(&root.join("runtime.json"), &runtime);
    }
    fn fixture() -> tempfile::TempDir {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("agent-host");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("node_modules/@earendil-works/pi-coding-agent")).unwrap();
        for (name, data) in [
            (
                if cfg!(windows) { "node.exe" } else { "node" },
                "node fixture",
            ),
            ("src/index.mjs", "export {};"),
            ("src/probe-entry.mjs", "export {};"),
            (
                "node_modules/@earendil-works/pi-coding-agent/package.json",
                "{}",
            ),
            ("package.json", "{}"),
            ("package-lock.json", "{}"),
            ("PI-THIRD-PARTY-NOTICES.txt", "MIT fixture"),
        ] {
            fs::write(root.join(name), data).unwrap();
        }
        let pinned: Value = serde_json::from_str(PINNED_RUNTIME).unwrap();
        let target = target().unwrap();
        let notices = hash(&root.join("PI-THIRD-PARTY-NOTICES.txt"));
        let runtime = json!({
            "target":target,"nodeVersion":pinned["nodeVersion"],
            "sourceArchive":pinned["targets"][target]["archive"],
            "sourceArchiveChecksum":pinned["targets"][target]["sha256"],
            "nodeChecksum":hash(&root.join(if cfg!(windows) { "node.exe" } else { "node" })),
            "piNoticesChecksum":notices,
        });
        write_json(&root.join("runtime.json"), &runtime);
        let mut files = HashSet::new();
        for name in ["src", "node_modules", "package.json", "package-lock.json"] {
            inventory(&root, name, &mut files).unwrap();
        }
        let files: Vec<Value> = files
            .into_iter()
            .map(|file| json!({"checksum":hash(&root.join(&file)),"file":file}))
            .collect();
        seal_manifest(
            &root,
            &json!({
                "schemaVersion":1,"target":target,"sdk":pinned["sdk"],
                "lockfileChecksum":hash(&root.join("package-lock.json")),
                "noticesChecksum":notices,"packages":[{"name":"fixture","license":"MIT"}],
                "files":files,
            }),
        );
        fixture
    }

    #[test]
    fn agent_process_manifest_rejects_tampering_and_unlisted_modules() {
        let fixture = fixture();
        let root = fixture.path().join("agent-host");
        assert!(PackagedAgentRuntime::bundled(fixture.path()).is_ok());
        fs::write(root.join("src/index.mjs"), "tampered").unwrap();
        assert!(PackagedAgentRuntime::bundled(fixture.path()).is_err());
        fs::write(root.join("src/index.mjs"), "export {};").unwrap();
        fs::write(root.join("node_modules/injected.js"), "export {};").unwrap();
        assert!(PackagedAgentRuntime::bundled(fixture.path()).is_err());
        fs::remove_file(root.join("node_modules/injected.js")).unwrap();
        fs::write(root.join("PI-THIRD-PARTY-NOTICES.txt"), "changed").unwrap();
        assert!(PackagedAgentRuntime::bundled(fixture.path()).is_err());
    }

    #[test]
    fn agent_process_manifest_rejects_platform_pins_and_unsafe_paths() {
        let fixture = fixture();
        let root = fixture.path().join("agent-host");
        let mut runtime = regular_json(&root.join("runtime.json")).unwrap();
        let original = runtime.clone();
        for (field, value) in [
            ("target", "unknown-x64"),
            ("nodeVersion", "25.0.0"),
            ("nodeChecksum", "unverified"),
            ("sourceArchiveChecksum", "unverified"),
            ("piDistributionChecksum", "unverified"),
        ] {
            runtime[field] = json!(value);
            write_json(&root.join("runtime.json"), &runtime);
            assert!(
                PackagedAgentRuntime::bundled(fixture.path()).is_err(),
                "{field}"
            );
            runtime = original.clone();
        }
        write_json(&root.join("runtime.json"), &original);
        let manifest = regular_json(&root.join("pi-distribution.json")).unwrap();
        for path in [
            "../private",
            "src/../index.mjs",
            "src\\index.mjs",
            "/src/index.mjs",
            "src/a:b",
        ] {
            let mut changed = manifest.clone();
            changed["files"][0]["file"] = json!(path);
            seal_manifest(&root, &changed);
            assert!(
                PackagedAgentRuntime::bundled(fixture.path()).is_err(),
                "{path}"
            );
        }
        let mut changed = manifest.clone();
        let duplicate = changed["files"][0].clone();
        changed["files"].as_array_mut().unwrap().push(duplicate);
        seal_manifest(&root, &changed);
        assert!(PackagedAgentRuntime::bundled(fixture.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn agent_process_manifest_rejects_symlinked_dependency_ancestors() {
        use std::os::unix::fs::symlink;
        let fixture = fixture();
        let root = fixture.path().join("agent-host");
        fs::rename(root.join("node_modules"), fixture.path().join("outside")).unwrap();
        symlink(fixture.path().join("outside"), root.join("node_modules")).unwrap();
        assert!(PackagedAgentRuntime::bundled(fixture.path()).is_err());
    }

    #[test]
    fn agent_process_request_bound_counts_utf8_bytes() {
        let mut frame = BoundedFrame(Vec::new());
        assert!(
            serde_json::to_writer(&mut frame, &json!("中".repeat(MAX_FRAME_BYTES / 3))).is_err()
        );
        assert!(frame.0.len() <= MAX_FRAME_BYTES);
        let mut exact = BoundedFrame(Vec::new());
        serde_json::to_writer(&mut exact, &json!("x".repeat(MAX_FRAME_BYTES - 2))).unwrap();
        assert_eq!(exact.0.len(), MAX_FRAME_BYTES);
        let mut escaped = BoundedFrame(Vec::new());
        serde_json::to_writer(&mut escaped, &json!({"content":"\0".repeat(2*1024*1024)})).unwrap();
        assert!(escaped.0.len() > 12 * 1024 * 1024 && escaped.0.len() < MAX_FRAME_BYTES);
    }

    // Test-only explicit runtime injection never resolves a system Node.
    fn test_runtime(root: &Path, script: &str) -> PackagedAgentRuntime {
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/index.mjs"), script).unwrap();
        PackagedAgentRuntime {
            root: root.canonicalize().unwrap(),
            node: Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("resources/agent-host")
                .join(if cfg!(windows) { "node.exe" } else { "node" })
                .canonicalize()
                .expect("prepare the pinned Node before running real process tests"),
        }
    }
    async fn next(process: &mut HostProcess) -> AgentResult<Option<Value>> {
        tokio::time::timeout(Duration::from_secs(5), process.next_frame())
            .await
            .expect("real child must settle within test deadline")
    }

    #[tokio::test]
    #[ignore = "requires prepared pinned Node runtime; run explicitly"]
    async fn agent_process_child_round_trip_and_eof() {
        let fixture = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let runtime = test_runtime(
            fixture.path(),
            r#"
import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin })) {
  process.stdout.write(line + '\n' + '{"second":true}\n');
  break;
}
"#,
        );
        let mut process = runtime.spawn(workspace.path(), false).await.unwrap();
        let frame = json!({"text":"中文", "requestId":"roundtrip"});
        process.send(&frame).await.unwrap();
        assert_eq!(next(&mut process).await.unwrap(), Some(frame));
        assert_eq!(
            next(&mut process).await.unwrap(),
            Some(json!({"second":true}))
        );
        // readline leaves stdin active after breaking its iterator. Close the
        // sending pipe before expecting this fixture to exit and produce EOF.
        process.input.take().unwrap().shutdown().await.unwrap();
        assert_eq!(next(&mut process).await.unwrap(), None);
        process.shutdown().await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires prepared pinned Node runtime; run explicitly"]
    async fn agent_process_child_rejects_oversize_without_newline_and_partial_eof() {
        let fixture = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        for script in [
            &format!("process.stdout.write('x'.repeat({}));setInterval(()=>{{}},1000);", MAX_FRAME_BYTES + 1),
            &format!("process.stdout.write('x'.repeat({})+'\\n');setInterval(()=>{{}},1000);", MAX_FRAME_BYTES + 1),
            "process.stdout.write('{\"partial\":true}');",
            "process.stdout.write('not JSON\\n');",
        ] {
            let runtime = test_runtime(fixture.path(), script);
            let mut process = runtime.spawn(workspace.path(), false).await.unwrap();
            assert_eq!(
                next(&mut process).await.unwrap_err().code,
                ErrorCode::RuntimeIncompatible
            );
            assert!(process.child.try_wait().unwrap().is_some());
        }
    }

    #[tokio::test]
    #[ignore = "requires prepared pinned Node runtime; run explicitly"]
    async fn agent_process_child_keeps_partial_frame_across_cancel_and_kills() {
        let fixture = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let runtime = test_runtime(
            fixture.path(),
            r#"
process.stdout.write('{"partial":');
process.stdin.once('data', () => process.stdout.write('true}\n'));
setInterval(()=>{},1000);
"#,
        );
        let mut process = runtime.spawn(workspace.path(), false).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), process.output.fill_buf())
            .await
            .unwrap()
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(150), process.next_frame())
                .await
                .is_err()
        );
        assert!(!process.pending.is_empty());
        process.send(&json!({"resume":true})).await.unwrap();
        assert_eq!(
            next(&mut process).await.unwrap(),
            Some(json!({"partial":true}))
        );
        tokio::time::timeout(Duration::from_secs(2), process.kill())
            .await
            .unwrap()
            .unwrap();
        assert!(process.child.try_wait().unwrap().is_some());
    }

    #[tokio::test]
    #[ignore = "requires prepared pinned Node runtime; run explicitly"]
    async fn agent_process_child_permissions_and_environment_are_restricted() {
        let fixture = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("private.txt");
        fs::write(&outside_file, "private fixture").unwrap();
        let script = format!(
            r#"
import {{writeFile, readFile}} from 'node:fs/promises';
import {{spawn}} from 'node:child_process';
const root = {};
let writeDenied = false, spawnDenied = false, outsideReadDenied = false;
try {{ await writeFile(root+'/outside.txt', 'forbidden'); }} catch (error) {{ writeDenied = error.code === 'ERR_ACCESS_DENIED'; }}
try {{ await readFile({}); }} catch (error) {{ outsideReadDenied = error.code === 'ERR_ACCESS_DENIED'; }}
try {{ spawnDenied = await new Promise(resolve => {{
  const child = spawn(process.execPath,['--version']);
  child.on('error', error => resolve(error.code === 'ERR_ACCESS_DENIED'));
  child.on('exit', () => resolve(false));
}}); }} catch (error) {{ spawnDenied = error.code === 'ERR_ACCESS_DENIED'; }}
await writeFile(root+'/.project-mind/agent/sessions/allowed.txt', 'checkpoint');
process.stdout.write(JSON.stringify({{writeDenied,spawnDenied,outsideReadDenied,envProxy:process.execArgv.includes('--use-env-proxy'),path:process.env.PATH,options:process.env.NODE_OPTIONS??null,homeIsPrivate:process.env.HOME===process.cwd()}})+'\n');
"#,
            serde_json::to_string(&workspace.path().canonicalize().unwrap()).unwrap(),
            serde_json::to_string(&outside_file).unwrap()
        );
        let runtime = test_runtime(fixture.path(), &script);
        let mut process = runtime.spawn(workspace.path(), false).await.unwrap();
        assert_eq!(
            next(&mut process).await.unwrap(),
            Some(json!({
                "writeDenied":true,"spawnDenied":true,"outsideReadDenied":true,"envProxy":true,
                "path":"","options":null,"homeIsPrivate":true,
            }))
        );
        process.shutdown().await.unwrap();
        assert!(!workspace.path().join("outside.txt").exists());
        assert!(workspace
            .path()
            .join(".project-mind/agent/sessions/allowed.txt")
            .exists());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "requires prepared pinned Node runtime; run explicitly"]
    async fn agent_process_drop_terminates_live_child() {
        let fixture = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let runtime = test_runtime(
            fixture.path(),
            "process.stdout.write('{\"ready\":true}\\n');setInterval(()=>{},1000);",
        );
        let mut process = runtime.spawn(workspace.path(), false).await.unwrap();
        assert_eq!(
            next(&mut process).await.unwrap(),
            Some(json!({"ready":true}))
        );
        let pid = process.child.id().unwrap();
        drop(process);
        tokio::time::timeout(Duration::from_secs(5), async {
            while Path::new(&format!("/proc/{pid}")).exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("dropped child must be terminated and reaped");
    }
}
