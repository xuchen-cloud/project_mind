//! Office-only process boundary. Business paths and credentials never cross.
use crate::agent::errors::{AgentError, AgentResult, ErrorCode};
use serde::{Deserialize, Serialize};
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

#[path = "office_recalculation.rs"]
mod recalculation;
pub(crate) use recalculation::{baseline_context, clear_baselines, OfficeBaseline};

const FRAME_LIMIT: usize = 180 * 1024 * 1024;
const NODE_GUARD: &str = "data:text/javascript,if(process.versions.node!==%2724.21.0%27)throw%20new%20Error(%27Unsupported%20Office%20runtime%27)";
static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
// Acquire before reading retained files, not after allocating their base64 frames.
static SOURCE_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
pub(crate) async fn admit_source() -> AgentResult<tokio::sync::SemaphorePermit<'static>> {
    tokio::time::timeout(Duration::from_secs(15), SOURCE_SLOTS.acquire()).await
        .map_err(|_| failure(ErrorCode::EditorBusy, "Office utility is busy"))?
        .map_err(|_| failure(ErrorCode::RuntimeUnavailable, "Office utility stopped"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OfficeRecalculation {
    pub edits: Vec<RecalcEdit>,
    pub reads: Vec<RecalcRead>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecalcEdit {
    pub sheet_id: String,
    pub row: u32,
    pub column: u32,
    pub input: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecalcRead {
    pub sheet_id: String,
    pub range: RecalcRange,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecalcRange {
    pub start_row: u32,
    pub end_row: u32,
    pub start_column: u32,
    pub end_column: u32,
}
impl OfficeRecalculation {
    pub(crate) fn validate(&self) -> AgentResult<()> {
        if self.edits.len() > 10_000 || self.reads.len() > 200 {
            return Err(failure(
                ErrorCode::BudgetExceeded,
                "Recalculation exceeds 10000 edits or 200 reads",
            ));
        }
        for edit in &self.edits {
            if edit.sheet_id.is_empty() || edit.row > 1_048_575 || edit.column > 16_383 {
                return Err(failure(
                    ErrorCode::InvalidArgument,
                    "Invalid recalculation edit coordinate",
                ));
            }
            if edit.input.encode_utf16().count() > 32_767 {
                return Err(failure(
                    ErrorCode::BudgetExceeded,
                    "Recalculation input exceeds 32767 UTF-16 units",
                ));
            }
        }
        let mut cells = 0_u64;
        for read in &self.reads {
            let r = &read.range;
            if read.sheet_id.is_empty()
                || r.start_row > r.end_row
                || r.start_column > r.end_column
                || r.end_row > 1_048_575
                || r.end_column > 16_383
            {
                return Err(failure(
                    ErrorCode::InvalidArgument,
                    "Invalid recalculation read range",
                ));
            }
            cells += u64::from(r.end_row - r.start_row + 1)
                * u64::from(r.end_column - r.start_column + 1);
        }
        if cells > 100_000 {
            return Err(failure(
                ErrorCode::BudgetExceeded,
                "Recalculation exceeds 100000 read cells",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OfficeRecalculationResult {
    pub cells: Vec<RecalcCell>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecalcCell {
    pub sheet_id: String,
    pub row: u32,
    pub column: u32,
    pub formatted: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    pub is_formula: bool,
}

#[derive(Clone, Copy)]
pub(crate) enum OfficePayload<'a> {
    Inspect,
    Create(&'a Value),
    Edit(&'a [Value]),
    Recalculate(&'a OfficeRecalculation),
}

pub(crate) trait OfficeUtility {
    fn recalculate(
        &self,
        _baseline: &OfficeBaseline,
        request_id: &str,
        source: &str,
        input: &OfficeRecalculation,
    ) -> impl std::future::Future<Output = AgentResult<Value>> + Send {
        self.request(
            request_id,
            "office.recalculate",
            "xlsx",
            source,
            OfficePayload::Recalculate(input),
        )
    }

    fn request(
        &self,
        request_id: &str,
        method: &str,
        format: &str,
        base64: &str,
        payload: OfficePayload<'_>,
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
            resources.join("agent-host").join(node_name()),
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
    async fn recalculate(
        &self,
        baseline: &OfficeBaseline,
        id: &str,
        source: &str,
        input: &OfficeRecalculation,
    ) -> AgentResult<Value> {
        recalculation::recalculate(self, baseline, id, source, input).await
    }
    async fn request(
        &self,
        request_id: &str,
        method: &str,
        format: &str,
        base64: &str,
        payload: OfficePayload<'_>,
    ) -> AgentResult<Value> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        #[cfg(feature = "office-performance")]
        let performance_start = std::time::Instant::now();
        if request_id.is_empty()
            || request_id.len() > 128
            || !matches!(
                (method, payload),
                ("office.inspect", OfficePayload::Inspect)
                    | ("office.create", OfficePayload::Create(_))
                    | ("office.edit", OfficePayload::Edit(_))
                    | ("office.recalculate", OfficePayload::Recalculate(_))
            )
            || !matches!(format, "docx" | "xlsx" | "pptx")
            || (method == "office.recalculate" && format != "xlsx")
        {
            return Err(failure(
                ErrorCode::InvalidArgument,
                "Invalid Office utility request",
            ));
        }
        // Give one-shot work priority over unused warm baseline processes.
        recalculation::evict_idle();
        // Direct utility callers also acquire before decoding or copying payloads.
        let _slot = tokio::time::timeout(Duration::from_secs(15), SLOTS.acquire())
            .await
            .map_err(|_| failure(ErrorCode::EditorBusy, "Office utility is busy"))?
            .map_err(|_| failure(ErrorCode::RuntimeUnavailable, "Office utility stopped"))?;
        if let OfficePayload::Create(content) = payload {
            if !base64.is_empty() || !(content.is_object() || format == "docx" && content.as_str().is_some_and(|value| !value.trim().is_empty())) {
                return Err(failure(ErrorCode::InvalidArgument, "Creation requires content and no source bytes"));
            }
            if serde_json::to_vec(content).map_err(|_| failure(ErrorCode::InvalidArgument, "Invalid Office content"))?.len() > 2 * 1024 * 1024 {
                return Err(failure(ErrorCode::BudgetExceeded, "Office creation content exceeds 2 MiB"));
            }
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
        if method != "office.create" && (bytes.is_empty() || STANDARD.encode(&bytes) != base64) {
            return Err(failure(
                ErrorCode::InvalidArgument,
                "Office source must be nonempty canonical base64",
            ));
        }
        drop(bytes);
        let mut data = if method == "office.create" { json!({"format":format}) } else { json!({"format":format,"base64":base64}) };
        match payload {
            OfficePayload::Inspect => {}
            OfficePayload::Create(content) => { data["content"] = json!(content); }
            OfficePayload::Edit(edits) => {
                data["edits"] = json!(edits);
            }
            OfficePayload::Recalculate(recalculation) => {
                data["recalculation"] = json!(recalculation);
            }
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
        #[cfg(feature = "office-performance")]
        eprintln!("[office-performance] {request_id} worker-slot {:.3}", performance_start.elapsed().as_secs_f64() * 1000.0);
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
        // Native XLSX children use the OS temp-directory API, independently
        // of the JS engine's explicit tempRoot. Keep both inside this request's
        // private directory after clearing the inherited environment.
        let process_temp = crate::node_paths::permission_path(&temp);
        let mut command = Command::new(&self.node);
        command
            .arg("--permission")
            .arg("--max-old-space-size=1024")
            .arg(format!(
                "--allow-fs-read={}",
                crate::node_paths::permission_path(&self.entry).display()
            ))
            .arg(format!(
                "--allow-fs-read={}",
                crate::node_paths::permission_path(&self.distribution).display()
            ))
            .arg(format!(
                "--allow-fs-read={}",
                crate::node_paths::permission_path(&temp).display()
            ))
            .arg(format!(
                "--allow-fs-write={}",
                crate::node_paths::permission_path(&temp).display()
            ))
            .arg("--allow-child-process")
            .arg(format!("--import={NODE_GUARD}"))
            .arg(&self.entry)
            .current_dir(&temp)
            .env_clear()
            .env("PATH", "")
            .env("TEMP", &process_temp)
            .env("TMP", &process_temp)
            .env("TMPDIR", &process_temp)
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
        #[cfg(feature = "office-performance")]
        eprintln!("[office-performance] {request_id} worker-spawn {:.3}", performance_start.elapsed().as_secs_f64() * 1000.0);
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
            #[cfg(feature = "office-performance")]
            eprintln!("[office-performance] {request_id} worker-response {:.3}", performance_start.elapsed().as_secs_f64() * 1000.0);
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
            let decoded = decode_response(request_id, method, &bytes);
            #[cfg(feature = "office-performance")]
            eprintln!("[office-performance] {request_id} worker-decode {:.3}", performance_start.elapsed().as_secs_f64() * 1000.0);
            decoded
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
fn decode_response(request_id: &str, method: &str, bytes: &[u8]) -> AgentResult<Value> {
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
        Some(true)
            if frame["data"].is_object()
                && (if method == "office.recalculate" {
                    frame["data"]["cells"].is_array()
                } else {
                    frame["data"]["model"].is_object()
                }) =>
        {
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
    async fn recalculate(
        &self,
        baseline: &OfficeBaseline,
        id: &str,
        source: &str,
        input: &OfficeRecalculation,
    ) -> AgentResult<Value> {
        let app = self.0.clone();
        let worker = tokio::task::spawn_blocking(move || OfficeWorker::for_app(&app))
            .await
            .map_err(|_| {
                failure(
                    ErrorCode::RuntimeUnavailable,
                    "Cannot prepare Office baseline worker",
                )
            })??;
        worker.recalculate(baseline, id, source, input).await
    }
    async fn request(
        &self,
        id: &str,
        method: &str,
        format: &str,
        bytes: &str,
        payload: OfficePayload<'_>,
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
        worker.request(id, method, format, bytes, payload).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundled_office_uses_the_shared_node_and_requires_it() {
        let fixture = tempfile::tempdir().unwrap();
        let resources = fixture.path();
        let office = resources.join("office-editor");
        let source = office.join("src");
        let dist = office.join("office-dist");
        let shared = resources.join("agent-host");
        for directory in [&source, &dist, &shared] {
            std::fs::create_dir_all(directory).unwrap();
        }
        std::fs::write(source.join("office-worker-entry.mjs"), "fixture").unwrap();
        for name in [
            "worker.mjs",
            "docx-engine.mjs",
            "xlsx-engine.mjs",
            "pptx-engine.mjs",
            sidecar_name(),
        ] {
            std::fs::write(dist.join(name), "fixture").unwrap();
        }
        let node = shared.join(node_name());
        std::fs::write(&node, "shared-node").unwrap();
        let worker = OfficeWorker::bundled(resources).unwrap();
        assert_eq!(worker.node, node.canonicalize().unwrap());
        assert_eq!(worker.distribution, dist.canonicalize().unwrap());
        assert!(!office.join(node_name()).exists());
        std::fs::remove_file(node).unwrap();
        // An old duplicate must not mask a missing shared runtime.
        std::fs::write(office.join(node_name()), "stale-node").unwrap();
        assert!(OfficeWorker::bundled(resources).is_err());
    }

    fn calculation() -> OfficeRecalculation {
        serde_json::from_value(json!({"edits":[{"sheetId":"s","row":0,"column":0,"input":"=1+1"}],
            "reads":[{"sheetId":"s","range":{"startRow":0,"endRow":0,"startColumn":0,"endColumn":0}}]})).unwrap()
    }
    #[test]
    fn office_recalculate_value_and_aggregate_budgets_are_enforced() {
        let mut input = calculation();
        input.edits[0].input = format!("{}a", "😀".repeat(16383));
        input.validate().unwrap();
        input.edits[0].input.push('a');
        assert_eq!(
            input.validate().unwrap_err().code,
            ErrorCode::BudgetExceeded
        );
        let mut input = calculation();
        input.edits = vec![input.edits[0].clone(); 10000];
        input.validate().unwrap();
        input.edits.push(input.edits[0].clone());
        assert_eq!(
            input.validate().unwrap_err().code,
            ErrorCode::BudgetExceeded
        );
        let mut input = calculation();
        input.reads[0].range.end_row = 499;
        input.reads = vec![input.reads[0].clone(); 200];
        input.validate().unwrap();
        input.reads[0].range.end_row = 500;
        assert_eq!(
            input.validate().unwrap_err().code,
            ErrorCode::BudgetExceeded
        );
        input.reads[0].range.end_row = 499;
        input.reads.push(input.reads[0].clone());
        assert_eq!(
            input.validate().unwrap_err().code,
            ErrorCode::BudgetExceeded
        );
        for value in [
            json!({"edits":[{"sheetId":"","row":0,"column":0,"input":""}],"reads":[]}),
            json!({"edits":[{"sheetId":"s","row":1048576,"column":0,"input":""}],"reads":[]}),
            json!({"edits":[{"sheetId":"s","row":0,"column":16384,"input":""}],"reads":[]}),
            json!({"edits":[],"reads":[{"sheetId":"s","range":{"startRow":1,"endRow":0,"startColumn":0,"endColumn":0}}]}),
        ] {
            assert_eq!(
                serde_json::from_value::<OfficeRecalculation>(value)
                    .unwrap()
                    .validate()
                    .unwrap_err()
                    .code,
                ErrorCode::InvalidArgument
            );
        }
    }
    #[tokio::test]
    async fn office_recalculate_native_protocol_rejects_operation_confusion_and_noncanonical_source(
    ) {
        let worker = OfficeWorker {
            node: PathBuf::new(),
            entry: PathBuf::new(),
            distribution: PathBuf::new(),
            timeout: Duration::ZERO,
        };
        let input = calculation();
        for (method, format, payload) in [
            ("office.inspect", "xlsx", OfficePayload::Recalculate(&input)),
            ("office.edit", "xlsx", OfficePayload::Recalculate(&input)),
            (
                "office.recalculate",
                "docx",
                OfficePayload::Recalculate(&input),
            ),
            ("office.recalculate", "xlsx", OfficePayload::Edit(&[])),
            ("office.recalc", "xlsx", OfficePayload::Recalculate(&input)),
        ] {
            assert_eq!(
                worker
                    .request("r", method, format, "YWJj", payload)
                    .await
                    .unwrap_err()
                    .code,
                ErrorCode::InvalidArgument
            );
        }
        for bytes in ["", "YQ=", "Y Q==", "YR=="] {
            assert_eq!(
                worker
                    .request(
                        "r",
                        "office.recalculate",
                        "xlsx",
                        bytes,
                        OfficePayload::Recalculate(&input)
                    )
                    .await
                    .unwrap_err()
                    .code,
                ErrorCode::InvalidArgument
            );
        }
    }
    #[test]
    fn office_recalculate_protocol_accepts_only_the_cells_response_kind() {
        assert_eq!(
            decode_response(
                "r",
                "office.recalculate",
                br#"{"requestId":"r","ok":true,"data":{"cells":[]}}"#
            )
            .unwrap(),
            json!({"cells":[]})
        );
        for bytes in [
            br#"{"requestId":"r","ok":true,"data":{"model":{}}}"#.as_slice(),
            br#"{"requestId":"wrong","ok":true,"data":{"cells":[]}}"#,
        ] {
            assert_eq!(
                decode_response("r", "office.recalculate", bytes)
                    .unwrap_err()
                    .code,
                ErrorCode::RuntimeIncompatible
            );
        }
    }
    #[test]
    fn office_protocol_binds_response_identity_and_preserves_structured_errors() {
        assert_eq!(
            decode_response(
                "one",
                "office.inspect",
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
                decode_response("one", "office.inspect", bytes)
                    .unwrap_err()
                    .code,
                ErrorCode::RuntimeIncompatible
            );
        }
        let error = decode_response("one", "office.inspect", br#"{"requestId":"one","ok":false,"error":{"code":"INVALID_PATCH","message":"Unknown paragraph"}}"#).unwrap_err();
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
process.stdout.write(JSON.stringify({{requestId:request.requestId,ok:true,data:{{model:{{readDenied,writeDenied,temporary,path:process.env.PATH,home:process.env.HOME??null,options:process.env.NODE_OPTIONS??null,temp:process.env.TEMP,tmp:process.env.TMP,tmpdir:process.env.TMPDIR,cwd:process.cwd(),received:request}}}}}})+'\n');"#,
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
                OfficePayload::Edit(&[json!({"cell":"A1","value":"中文"})]),
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
        for variable in ["temp", "tmp", "tmpdir"] {
            assert_eq!(result["model"][variable], result["model"]["cwd"]);
        }
        assert_eq!(std::fs::read(outside).unwrap(), b"secret");
        std::fs::write(&entry, "setInterval(()=>{},1000)").unwrap();
        worker.timeout = Duration::from_millis(250);
        assert!(worker
            .request(
                "timeout",
                "office.inspect",
                "docx",
                "YWJj",
                OfficePayload::Inspect
            )
            .await
            .unwrap_err()
            .message
            .contains("timed out"));
    }
}
