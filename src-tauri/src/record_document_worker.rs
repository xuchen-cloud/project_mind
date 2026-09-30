//! Bounded utility-process boundary. The worker receives document data only;
//! neither credentials, Workspace paths, model tools nor database handles cross.
use crate::agent::errors::{AgentError, AgentResult, ErrorCode};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};

const REQUEST_LIMIT: usize = 4 * 1024 * 1024;
const RESPONSE_LIMIT: usize = 12 * 1024 * 1024;
static WORKER_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
const NODE_VERSION_GUARD: &str = "data:text/javascript,if(process.versions.node!==%2724.21.0%27)throw%20new%20Error(%27Unsupported%20utility%20runtime%27)";

#[derive(Clone)]
pub(crate) struct RecordDocumentWorker {
    node: PathBuf,
    entry: PathBuf,
    timeout: Duration,
}
impl RecordDocumentWorker {
    pub(crate) fn for_app(app: &tauri::AppHandle) -> AgentResult<Self> {
        use tauri::Manager;
        if let Ok(resources) = app.path().resource_dir() {
            let root = resources.join("agent-host");
            if root
                .join(if cfg!(windows) { "node.exe" } else { "node" })
                .is_file()
            {
                return Self::bundled(&resources);
            }
        }
        #[cfg(debug_assertions)]
        {
            return Self::development();
        }
        #[cfg(not(debug_assertions))]
        Err(AgentError::new(
            ErrorCode::RuntimeUnavailable,
            "Packaged document utility is unavailable",
        ))
    }
    pub(crate) fn bundled(resource_directory: &Path) -> AgentResult<Self> {
        let root = resource_directory.join("agent-host");
        Self::from_paths(
            root.join(if cfg!(windows) { "node.exe" } else { "node" }),
            root.join("src/record-worker-entry.mjs"),
        )
    }
    #[cfg(any(debug_assertions, test))]
    pub(crate) fn development() -> AgentResult<Self> {
        let target = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", "aarch64") => "darwin-arm64",
            ("macos", "x86_64") => "darwin-x64",
            ("windows", "aarch64") => "win-arm64",
            ("windows", "x86_64") => "win-x64",
            _ => {
                return Err(AgentError::new(
                    ErrorCode::RuntimeUnavailable,
                    "Utility runtime is not prepared for this platform",
                ))
            }
        };
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/agent-host");
        Self::from_paths(
            root.join("runtime")
                .join(target)
                .join(if cfg!(windows) { "node.exe" } else { "node" }),
            root.join("src/record-worker-entry.mjs"),
        )
    }
    fn from_paths(node: PathBuf, entry: PathBuf) -> AgentResult<Self> {
        if !node.is_absolute() || !entry.is_absolute() || !node.is_file() || !entry.is_file() {
            return Err(AgentError::new(
                ErrorCode::RuntimeUnavailable,
                "Prepare the packaged utility runtime first",
            ));
        }
        // Node's permission matcher requires real paths, including macOS's
        // /var -> /private/var temporary-directory alias.
        let unavailable = |_| {
            AgentError::new(
                ErrorCode::RuntimeUnavailable,
                "Utility resources cannot be resolved",
            )
        };
        Ok(Self {
            node: std::fs::canonicalize(node).map_err(unavailable)?,
            entry: std::fs::canonicalize(entry).map_err(unavailable)?,
            timeout: Duration::from_secs(10),
        })
    }
    pub(crate) async fn request(
        &self,
        request_id: &str,
        method: &str,
        data: Value,
    ) -> AgentResult<Value> {
        if request_id.is_empty()
            || request_id.len() > 128
            || !matches!(
                method,
                "record.initialize"
                    | "record.validate"
                    | "record.patch"
                    | "record.compare"
                    | "record.schema"
            )
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid utility request",
            ));
        }
        let mut frame =
            serde_json::to_vec(&json!({"requestId":request_id,"method":method,"data":data}))
                .map_err(|_| AgentError::new(ErrorCode::InvalidPatch, "Invalid document data"))?;
        if frame.len() > REQUEST_LIMIT {
            return Err(AgentError::new(
                ErrorCode::InvalidPatch,
                "Document request exceeds frame limit",
            ));
        }
        frame.push(b'\n');
        let _slot = tokio::time::timeout(self.timeout, WORKER_SLOTS.acquire())
            .await
            .map_err(|_| AgentError::new(ErrorCode::EditorBusy, "Document utility is busy"))?
            .map_err(|_| {
                AgentError::new(ErrorCode::RuntimeUnavailable, "Document utility stopped")
            })?;
        let temporary = tempfile::tempdir()
            .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot prepare utility process"))?;
        let source = self.entry.parent().ok_or_else(|| {
            AgentError::new(ErrorCode::RuntimeUnavailable, "Utility entry is missing")
        })?;
        let distribution = source
            .parent()
            .ok_or_else(|| {
                AgentError::new(
                    ErrorCode::RuntimeUnavailable,
                    "Utility distribution is missing",
                )
            })?
            .join("dist");
        let mut command = Command::new(&self.node);
        command
            .arg("--permission")
            .arg("--max-old-space-size=256")
            .arg(format!("--allow-fs-read={}", source.display()))
            .arg(format!("--allow-fs-read={}", distribution.display()))
            .arg(format!("--import={NODE_VERSION_GUARD}"))
            .arg(&self.entry)
            .current_dir(temporary.path())
            .env_clear()
            .env("HOME", temporary.path())
            .env("USERPROFILE", temporary.path())
            .env("PATH", "")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            if let Some(root) = std::env::var_os("SystemRoot") {
                command.env("SystemRoot", root);
            }
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|_| {
            AgentError::new(
                ErrorCode::RuntimeUnavailable,
                "Cannot start packaged utility process",
            )
        })?;
        let mut input = child
            .stdin
            .take()
            .ok_or_else(|| AgentError::new(ErrorCode::IoFailed, "Utility input is unavailable"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| AgentError::new(ErrorCode::IoFailed, "Utility output is unavailable"))?;
        let result = tokio::time::timeout(self.timeout, async {
            let send = async {
                input.write_all(&frame).await?;
                input.shutdown().await?;
                // ChildStdin::shutdown does not release the pipe handle. EOF is
                // required for the one-request worker to settle and exit.
                drop(input);
                Ok::<_, std::io::Error>(())
            };
            let receive = async {
                let mut bytes = Vec::new();
                output
                    .take(RESPONSE_LIMIT as u64 + 1)
                    .read_to_end(&mut bytes)
                    .await?;
                Ok::<_, std::io::Error>(bytes)
            };
            let (_, bytes) = tokio::try_join!(send, receive)
                .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Utility pipe failed"))?;
            if bytes.len() > RESPONSE_LIMIT {
                return Err(AgentError::new(
                    ErrorCode::RuntimeIncompatible,
                    "Utility response exceeds frame limit",
                ));
            }
            let status = child.wait().await.map_err(|_| {
                AgentError::new(ErrorCode::IoFailed, "Cannot settle utility process")
            })?;
            if !status.success() {
                return Err(AgentError::new(
                    ErrorCode::RuntimeIncompatible,
                    "Utility process exited unsuccessfully",
                ));
            }
            decode_response(request_id, &bytes)
        })
        .await;
        match result {
            Ok(result) => {
                if result.is_err() {
                    let _ = child.kill().await;
                }
                result
            }
            Err(_) => {
                let _ = child.kill().await;
                Err(AgentError::new(
                    ErrorCode::IoFailed,
                    "Document utility timed out",
                ))
            }
        }
    }
}
fn decode_response(request_id: &str, bytes: &[u8]) -> AgentResult<Value> {
    let incompatible = || {
        AgentError::new(
            ErrorCode::RuntimeIncompatible,
            "Invalid document utility response",
        )
    };
    if bytes.last() != Some(&b'\n')
        || bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .count()
            != 1
    {
        return Err(incompatible());
    }
    let response: Value = serde_json::from_slice(bytes).map_err(|_| incompatible())?;
    if response["requestId"].as_str() != Some(request_id) {
        return Err(incompatible());
    }
    match response["ok"].as_bool() {
        Some(true) => response.get("data").cloned().ok_or_else(incompatible),
        Some(false) if response["error"]["code"] == "INVALID_PATCH" => {
            let diagnostic = response["error"]["message"]
                .as_str()
                .filter(|message| message.len() <= 512)
                .unwrap_or("Cannot convert Record document");
            Err(AgentError::new(ErrorCode::InvalidPatch, diagnostic))
        }
        _ => Err(incompatible()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn record_worker_frame_requires_one_matching_response_and_preserves_diagnostics() {
        assert!(decode_response(
            "expected",
            b"{\"requestId\":\"other\",\"ok\":true,\"data\":{}}\n"
        )
        .is_err());
        assert!(decode_response(
            "expected",
            b"{\"requestId\":\"expected\",\"ok\":true,\"data\":{}}\n{}\n"
        )
        .is_err());
        let error = decode_response("expected", b"{\"requestId\":\"expected\",\"ok\":false,\"error\":{\"code\":\"INVALID_PATCH\",\"message\":\"Unsupported legacy HTML node: video\"}}\n").unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidPatch);
        assert!(error.message.contains("video"));
    }

    #[tokio::test]
    #[ignore = "requires staged packaged utility resources; run explicitly"]
    async fn record_worker_packaged_resources_convert_without_development_paths() {
        let fixture = tempfile::tempdir().unwrap();
        let resources = fixture.path().join("安装包 中文 resources");
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/agent-host");
        fn copy_tree(source: &Path, destination: &Path) {
            std::fs::create_dir_all(destination).unwrap();
            for entry in std::fs::read_dir(source).unwrap() {
                let entry = entry.unwrap();
                let destination = destination.join(entry.file_name());
                if entry.file_type().unwrap().is_dir() {
                    copy_tree(&entry.path(), &destination);
                } else {
                    std::fs::copy(entry.path(), destination).unwrap();
                }
            }
        }
        copy_tree(&source, &resources.join("agent-host"));
        let client = RecordDocumentWorker::bundled(&resources).unwrap();
        assert!(client
            .node
            .starts_with(std::fs::canonicalize(&resources).unwrap()));
        assert!(client
            .entry
            .starts_with(std::fs::canonicalize(&resources).unwrap()));
        let response = client
            .request(
                "installed",
                "record.initialize",
                json!({"html":"<p>Installed utility</p>"}),
            )
            .await
            .unwrap();
        let projection: crate::record_documents::RecordDocumentProjection =
            serde_json::from_value(response).unwrap();
        projection.validate().unwrap();
        assert_eq!(projection.text, "Installed utility");
    }

    #[tokio::test]
    #[ignore = "requires the prepared pinned Node runtime; run explicitly"]
    async fn record_worker_pinned_process_denies_file_access_and_spawn_and_kills_unsettled_workers()
    {
        let prepared = RecordDocumentWorker::development().unwrap();
        let fixture = tempfile::tempdir().unwrap();
        let source = fixture.path().join("src");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(fixture.path().join("dist")).unwrap();
        let outside = fixture.path().join("outside.txt");
        std::fs::write(&outside, "Private fixture").unwrap();
        let entry = source.join("fixture.mjs");
        let script = format!(
            r#"import {{readFile}} from 'node:fs/promises';import {{spawn}} from 'node:child_process';
let fsDenied=false,spawnDenied=false;try{{await readFile({});}}catch(error){{fsDenied=error.code==='ERR_ACCESS_DENIED';}}
try{{spawnDenied=await new Promise((resolve)=>{{const child=spawn(process.execPath,['--version']);child.on('error',(error)=>resolve(error.code==='ERR_ACCESS_DENIED'));child.on('exit',()=>resolve(false));}});}}catch(error){{spawnDenied=error.code==='ERR_ACCESS_DENIED';}}
for await(const chunk of process.stdin){{}}
process.stdout.write(JSON.stringify({{requestId:'restrictions',ok:true,data:{{fsDenied,spawnDenied,path:process.env.PATH,options:process.env.NODE_OPTIONS??null}}}})+'\n');
"#,
            serde_json::to_string(&outside.to_string_lossy()).unwrap()
        );
        std::fs::write(&entry, script).unwrap();
        let mut client = RecordDocumentWorker::from_paths(prepared.node, entry.clone()).unwrap();
        let response = client
            .request("restrictions", "record.schema", json!({}))
            .await
            .unwrap();
        assert_eq!(
            response,
            json!({"fsDenied":true,"spawnDenied":true,"path":"","options":null})
        );
        std::fs::write(&entry, "setInterval(()=>{},1000);").unwrap();
        client.timeout = Duration::from_millis(500);
        let error = client
            .request("timeout", "record.schema", json!({}))
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::IoFailed);
        assert!(error.message.contains("timed out"));
        std::fs::write(&entry, "process.stdout.write('x'.repeat(13*1024*1024));").unwrap();
        client.timeout = Duration::from_secs(3);
        assert_eq!(
            client
                .request("oversized", "record.schema", json!({}))
                .await
                .unwrap_err()
                .code,
            ErrorCode::RuntimeIncompatible
        );
    }

    #[tokio::test]
    #[ignore = "requires prepared pinned Node runtime and built utility worker; run explicitly"]
    async fn record_worker_pinned_process_converts_and_previews_without_system_node() {
        let client = RecordDocumentWorker::development().unwrap();
        let initial = client
            .request(
                "fixture",
                "record.initialize",
                json!({"html":"<p>中文正文</p>"}),
            )
            .await
            .unwrap();
        let projection: crate::record_documents::RecordDocumentProjection =
            serde_json::from_value(initial.clone()).unwrap();
        projection.validate().unwrap();
        let result = client.request("append", "record.patch", json!({"document":initial["document"],"operations":[{"op":"append","parentBlockId":null,"blocks":[{"type":"paragraph","content":[{"type":"text","text":"Added"}]}]}]})).await.unwrap();
        assert_eq!(
            result["patch"]["createdBlockIds"].as_array().unwrap().len(),
            1
        );
        assert!(result["html"].as_str().unwrap().contains("Added"));
        assert_eq!(
            client
                .request(
                    "invalid",
                    "record.initialize",
                    json!({"html":"<video></video>"})
                )
                .await
                .unwrap_err()
                .code,
            ErrorCode::InvalidPatch
        );
    }
}
