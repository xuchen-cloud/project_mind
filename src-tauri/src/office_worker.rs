//! Office-only process boundary. Business paths and credentials never cross.
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

const FRAME_LIMIT: usize = 180 * 1024 * 1024;
const NODE_GUARD: &str = "data:text/javascript,if(process.versions.node!==%2724.21.0%27)throw%20new%20Error(%27Unsupported%20Office%20runtime%27)";
static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

pub(crate) trait OfficeUtility {
    fn request(
        &self,
        request_id: &str,
        method: &str,
        format: &str,
        base64: &str,
        edits: Option<&[Value]>,
    ) -> impl std::future::Future<Output = AgentResult<Value>> + Send;
}
#[derive(Clone)]
pub(crate) struct OfficeWorker {
    node: PathBuf,
    entry: PathBuf,
    distribution: PathBuf,
    timeout: Duration,
}
impl OfficeWorker {
    pub(crate) fn for_app(app: &tauri::AppHandle) -> AgentResult<Self> {
        use tauri::Manager;
        if let Ok(resources) = app.path().resource_dir() {
            if resources.join("office-editor").is_dir() {
                return Self::bundled(&resources);
            }
        }
        #[cfg(debug_assertions)]
        {
            Self::development()
        }
        #[cfg(not(debug_assertions))]
        {
            Err(failure(
                ErrorCode::RuntimeUnavailable,
                "Packaged Office utility is unavailable",
            ))
        }
    }
    pub(crate) fn bundled(resources: &Path) -> AgentResult<Self> {
        let root = resources.join("office-editor");
        Self::from_paths(
            root.join(node_name()),
            root.join("src/office-worker-entry.mjs"),
        )
    }
    #[cfg(any(debug_assertions, test))]
    pub(crate) fn development() -> AgentResult<Self> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/agent-host");
        Self::from_paths(
            Self::development_node()?,
            root.join("src/office-worker-entry.mjs"),
        )
    }
    #[cfg(any(debug_assertions, test))]
    pub(crate) fn development_node() -> AgentResult<PathBuf> {
        let target = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", "aarch64") => "darwin-arm64",
            ("macos", "x86_64") => "darwin-x64",
            ("windows", "aarch64") => "win-arm64",
            ("windows", "x86_64") => "win-x64",
            ("linux", "x86_64") => "linux-x64",
            _ => {
                return Err(failure(
                    ErrorCode::RuntimeUnavailable,
                    "Office runtime is unavailable on this platform",
                ))
            }
        };
        Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../packages/agent-host/runtime")
            .join(target)
            .join(node_name()))
    }
    fn from_paths(node: PathBuf, entry: PathBuf) -> AgentResult<Self> {
        let distribution = entry
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| failure(ErrorCode::RuntimeUnavailable, "Office entry is unavailable"))?
            .join("office-dist");
        let files = [
            node.clone(),
            entry.clone(),
            distribution.join("worker.mjs"),
            distribution.join("docx-engine.mjs"),
            distribution.join("xlsx-engine.mjs"),
            distribution.join("pptx-engine.mjs"),
            distribution.join(sidecar_name()),
        ];
        for path in &files {
            if !path.is_absolute()
                || !std::fs::symlink_metadata(path)
                    .is_ok_and(|m| m.is_file() && !m.file_type().is_symlink())
            {
                return Err(failure(
                    ErrorCode::RuntimeUnavailable,
                    "Prepare the fixed Office runtime assets first",
                ));
            }
        }
        let resolve = |path| {
            std::fs::canonicalize(path).map_err(|_| {
                failure(
                    ErrorCode::RuntimeUnavailable,
                    "Office assets cannot be resolved",
                )
            })
        };
        Ok(Self {
            node: resolve(node)?,
            entry: resolve(entry)?,
            distribution: resolve(distribution)?,
            timeout: Duration::from_secs(90),
        })
    }
}
fn node_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}
fn sidecar_name() -> &'static str {
    if cfg!(windows) {
        "xlsx-sidecar.exe"
    } else {
        "xlsx-sidecar"
    }
}
fn failure(code: ErrorCode, message: &str) -> AgentError {
    AgentError::new(code, message)
}

impl OfficeUtility for OfficeWorker {
    async fn request(
        &self,
        request_id: &str,
        method: &str,
        format: &str,
        base64: &str,
        edits: Option<&[Value]>,
    ) -> AgentResult<Value> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        if request_id.is_empty()
            || request_id.len() > 128
            || !matches!(method, "office.inspect" | "office.edit")
            || !matches!(format, "docx" | "xlsx" | "pptx")
            || (method == "office.edit" && edits.is_none())
        {
            return Err(failure(
                ErrorCode::InvalidArgument,
                "Invalid Office utility request",
            ));
        }
        // The byte budget is independent of the larger base64/JSON frame budget.
        let max_encoded = (crate::file_content::MAX_CONTENT as usize).div_ceil(3) * 4;
        if base64.len() > max_encoded {
            return Err(failure(
                ErrorCode::BudgetExceeded,
                "Office bytes exceed 100 MiB",
            ));
        }
        let bytes = STANDARD
            .decode(base64)
            .map_err(|_| failure(ErrorCode::InvalidArgument, "Invalid Office base64"))?;
        if bytes.len() as u64 > crate::file_content::MAX_CONTENT {
            return Err(failure(
                ErrorCode::BudgetExceeded,
                "Office bytes exceed 100 MiB",
            ));
        }
        drop(bytes);
        let mut data = json!({"format":format,"base64":base64});
        if let Some(edits) = edits {
            data["edits"] = json!(edits);
        }
        let mut frame =
            serde_json::to_vec(&json!({"requestId":request_id,"method":method,"data":data}))
                .map_err(|_| failure(ErrorCode::InvalidArgument, "Invalid Office data"))?;
        if frame.len() > FRAME_LIMIT {
            return Err(failure(
                ErrorCode::BudgetExceeded,
                "Office request exceeds frame limit",
            ));
        }
        frame.push(b'\n');
        let _slot = tokio::time::timeout(Duration::from_secs(15), SLOTS.acquire())
            .await
            .map_err(|_| failure(ErrorCode::EditorBusy, "Office utility is busy"))?
            .map_err(|_| failure(ErrorCode::RuntimeUnavailable, "Office utility stopped"))?;
        let temporary = tempfile::tempdir().map_err(|_| {
            failure(
                ErrorCode::IoFailed,
                "Cannot prepare Office temporary directory",
            )
        })?;
        let temp = temporary.path().canonicalize().map_err(|_| {
            failure(
                ErrorCode::IoFailed,
                "Cannot resolve Office temporary directory",
            )
        })?;
        let mut command = Command::new(&self.node);
        command
            .arg("--permission")
            .arg("--max-old-space-size=1024")
            .arg(format!("--allow-fs-read={}", self.entry.display()))
            .arg(format!("--allow-fs-read={}", self.distribution.display()))
            .arg(format!("--allow-fs-read={}", temp.display()))
            .arg(format!("--allow-fs-write={}", temp.display()))
            .arg("--allow-child-process")
            .arg(format!("--import={NODE_GUARD}"))
            .arg(&self.entry)
            .current_dir(&temp)
            .env_clear()
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
        crate::office_process::configure(&mut command);
        let mut child = command.spawn().map_err(|_| {
            failure(
                ErrorCode::RuntimeUnavailable,
                "Cannot start fixed Office worker",
            )
        })?;
        let _tree = crate::office_process::ProcessTree::attach(&child)?;
        let mut input = child
            .stdin
            .take()
            .ok_or_else(|| failure(ErrorCode::IoFailed, "Office input is unavailable"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| failure(ErrorCode::IoFailed, "Office output is unavailable"))?;
        let result = tokio::time::timeout(self.timeout, async {
            let send = async {
                input.write_all(&frame).await?;
                input.shutdown().await?;
                drop(input);
                Ok::<_, std::io::Error>(())
            };
            let receive = async {
                let mut bytes = Vec::new();
                output
                    .take(FRAME_LIMIT as u64 + 1)
                    .read_to_end(&mut bytes)
                    .await?;
                Ok::<_, std::io::Error>(bytes)
            };
            let (_, bytes) = tokio::try_join!(send, receive)
                .map_err(|_| failure(ErrorCode::IoFailed, "Office pipe failed"))?;
            if bytes.len() > FRAME_LIMIT {
                return Err(failure(
                    ErrorCode::BudgetExceeded,
                    "Office response exceeds frame limit",
                ));
            }
            if !child
                .wait()
                .await
                .map_err(|_| failure(ErrorCode::IoFailed, "Cannot settle Office worker"))?
                .success()
            {
                return Err(failure(
                    ErrorCode::RuntimeIncompatible,
                    "Office worker exited unsuccessfully",
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
                Err(failure(ErrorCode::IoFailed, "Office worker timed out"))
            }
        }
    }
}
fn decode_response(request_id: &str, bytes: &[u8]) -> AgentResult<Value> {
    let incompatible = || {
        failure(
            ErrorCode::RuntimeIncompatible,
            "Office worker returned an invalid response",
        )
    };
    let frame: Value = serde_json::from_slice(bytes).map_err(|_| incompatible())?;
    if frame["requestId"].as_str() != Some(request_id) {
        return Err(incompatible());
    }
    match frame["ok"].as_bool() {
        Some(true) if frame["data"].is_object() && frame["data"]["model"].is_object() => {
            Ok(frame["data"].clone())
        }
        Some(false) => {
            let code = frame["error"]["code"].as_str().ok_or_else(incompatible)?;
            let message = frame["error"]["message"]
                .as_str()
                .ok_or_else(incompatible)?;
            let code = serde_json::from_value(json!(code)).unwrap_or(ErrorCode::InvalidPatch);
            Err(failure(code, message))
        }
        _ => Err(incompatible()),
    }
}
pub(crate) struct AppOfficeUtility(pub tauri::AppHandle);
impl OfficeUtility for AppOfficeUtility {
    async fn request(
        &self,
        id: &str,
        method: &str,
        format: &str,
        bytes: &str,
        edits: Option<&[Value]>,
    ) -> AgentResult<Value> {
        let app = self.0.clone();
        let worker = tokio::task::spawn_blocking(move || OfficeWorker::for_app(&app))
            .await
            .map_err(|_| {
                failure(
                    ErrorCode::RuntimeUnavailable,
                    "Cannot prepare Office worker",
                )
            })??;
        worker.request(id, method, format, bytes, edits).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn office_protocol_binds_response_identity_and_preserves_structured_errors() {
        assert_eq!(
            decode_response(
                "one",
                r#"{"requestId":"one","ok":true,"data":{"model":{"text":"中文"}}}"#.as_bytes()
            )
            .unwrap()["model"]["text"],
            "中文"
        );
        for bytes in [
            br#"{"requestId":"other","ok":true,"data":{"model":{}}}"#.as_slice(),
            br#"{"requestId":"one","ok":true,"data":{}}"#,
            b"{}\n{}\n",
        ] {
            assert_eq!(
                decode_response("one", bytes).unwrap_err().code,
                ErrorCode::RuntimeIncompatible
            );
        }
        let error = decode_response("one", br#"{"requestId":"one","ok":false,"error":{"code":"INVALID_PATCH","message":"Unknown paragraph"}}"#).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidPatch);
        assert_eq!(error.message, "Unknown paragraph");
    }
    #[tokio::test]
    #[ignore = "requires MIND_OFFICE_TEST_NODE pointing at pinned Node 24.21.0"]
    async fn office_worker_permissions_protocol_and_timeout() {
        let node = PathBuf::from(
            std::env::var_os("MIND_OFFICE_TEST_NODE")
                .expect("Explicit pinned test runtime required"),
        );
        let fixture = tempfile::tempdir().unwrap();
        let source = fixture.path().join("src");
        let dist = fixture.path().join("office-dist");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&dist).unwrap();
        for name in [
            "worker.mjs",
            "docx-engine.mjs",
            "xlsx-engine.mjs",
            "pptx-engine.mjs",
            sidecar_name(),
        ] {
            std::fs::write(dist.join(name), b"fixture").unwrap();
        }
        let outside = fixture.path().join("business-secret");
        std::fs::write(&outside, b"secret").unwrap();
        let entry = source.join("office-worker-entry.mjs");
        let script = format!(
            r#"import {{readFile,writeFile}} from 'node:fs/promises';
let request;for await (const chunk of process.stdin) {{request=JSON.parse(chunk.toString());}}
let readDenied=false,writeDenied=false;try{{await readFile({0});}}catch(error){{readDenied=error.code==='ERR_ACCESS_DENIED';}}
try{{await writeFile({0},'changed');}}catch(error){{writeDenied=error.code==='ERR_ACCESS_DENIED';}}
await writeFile('office-test-temp','candidate');const temporary=await readFile('office-test-temp','utf8');
process.stdout.write(JSON.stringify({{requestId:request.requestId,ok:true,data:{{model:{{readDenied,writeDenied,temporary,path:process.env.PATH,home:process.env.HOME??null,options:process.env.NODE_OPTIONS??null,received:request}}}}}})+'\n');"#,
            serde_json::to_string(&outside.to_string_lossy()).unwrap()
        );
        std::fs::write(&entry, script).unwrap();
        let mut worker = OfficeWorker::from_paths(node, entry.clone()).unwrap();
        let result = worker
            .request(
                "protocol",
                "office.edit",
                "xlsx",
                "YWJj",
                Some(&[json!({"cell":"A1","value":"中文"})]),
            )
            .await
            .unwrap();
        assert_eq!(
            result["model"]["received"],
            json!({"requestId":"protocol","method":"office.edit","data":{"format":"xlsx","base64":"YWJj","edits":[{"cell":"A1","value":"中文"}]}})
        );
        assert_eq!(result["model"]["readDenied"], true);
        assert_eq!(result["model"]["writeDenied"], true);
        assert_eq!(result["model"]["temporary"], "candidate");
        assert_eq!(result["model"]["home"], Value::Null);
        assert_eq!(result["model"]["path"], "");
        assert_eq!(result["model"]["options"], Value::Null);
        assert_eq!(std::fs::read(outside).unwrap(), b"secret");
        std::fs::write(&entry, "setInterval(()=>{},1000)").unwrap();
        worker.timeout = Duration::from_millis(250);
        assert!(worker
            .request("timeout", "office.inspect", "docx", "YWJj", None)
            .await
            .unwrap_err()
            .message
            .contains("timed out"));
    }
}
