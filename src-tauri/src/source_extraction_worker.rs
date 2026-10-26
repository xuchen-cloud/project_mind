//! Read-only, one-per-Workspace extraction of an already authorized snapshot.
use crate::agent::errors::{AgentError, AgentResult, ErrorCode};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex, Weak},
    time::Duration,
};
use tokio::sync::Semaphore;

const RESPONSE_LIMIT: usize = 16 * 1024 * 1024;
static SLOTS: LazyLock<Mutex<HashMap<String, Weak<Semaphore>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
fn workspace_slot(workspace_id: &str) -> AgentResult<Arc<Semaphore>> {
    let mut slots = SLOTS.lock().map_err(|_| unavailable())?;
    slots.retain(|_, slot| slot.strong_count() > 0);
    if let Some(slot) = slots.get(workspace_id).and_then(Weak::upgrade) {
        return Ok(slot);
    }
    let slot = Arc::new(Semaphore::new(1));
    slots.insert(workspace_id.into(), Arc::downgrade(&slot));
    Ok(slot)
}
fn require_directory(path: &Path) -> AgentResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| unavailable())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(unavailable());
    }
    Ok(())
}
fn unavailable() -> AgentError {
    AgentError::new(
        ErrorCode::RuntimeUnavailable,
        "Source extraction resources are unavailable or incompatible",
    )
}
#[cfg(test)]
static HASH_COUNTS: LazyLock<Mutex<HashMap<PathBuf, usize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
#[cfg(test)]
static REQUEST_COUNTS: LazyLock<Mutex<HashMap<String, usize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
#[cfg(test)]
pub(crate) fn verification_count(path: &Path) -> usize {
    HASH_COUNTS.lock().unwrap().get(path).copied().unwrap_or(0)
}
#[cfg(test)]
pub(crate) fn request_count(workspace: &str) -> usize {
    REQUEST_COUNTS
        .lock()
        .unwrap()
        .get(workspace)
        .copied()
        .unwrap_or(0)
}
fn hash_file(file: &Path) -> AgentResult<String> {
    #[cfg(test)]
    {
        *HASH_COUNTS
            .lock()
            .unwrap()
            .entry(file.to_owned())
            .or_default() += 1;
    }
    let metadata = fs::symlink_metadata(file).map_err(|_| unavailable())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(unavailable());
    }
    let mut input = fs::File::open(file).map_err(|_| unavailable())?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let count = input.read(&mut buffer).map_err(|_| unavailable())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn verify_hash(file: &Path, hash: &Value) -> AgentResult<crate::source_file_snapshot::FileStamp> {
    let before = fs::symlink_metadata(file).map_err(|_| unavailable())?;
    if !before.is_file() || before.file_type().is_symlink() {
        return Err(unavailable());
    }
    let before = crate::source_file_snapshot::FileStamp::from_metadata(&before);
    if hash.as_str() != Some(hash_file(file)?.as_str()) {
        return Err(unavailable());
    }
    let after = fs::symlink_metadata(file).map_err(|_| unavailable())?;
    if !after.is_file()
        || after.file_type().is_symlink()
        || crate::source_file_snapshot::FileStamp::from_metadata(&after) != before
    {
        return Err(unavailable());
    }
    Ok(before)
}

fn regular_json(file: &Path) -> AgentResult<Value> {
    let metadata = fs::symlink_metadata(file).map_err(|_| unavailable())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 1024 * 1024 {
        return Err(unavailable());
    }
    serde_json::from_slice(&fs::read(file).map_err(|_| unavailable())?).map_err(|_| unavailable())
}

// Verified public parser resources are independent of Workspace content. Keep
// at most two resource roots; one root's verification never blocks another.
struct RuntimeSlot {
    root: PathBuf,
    worker: Mutex<Option<SourceExtractionWorker>>,
}
static VERIFIED_RUNTIMES: LazyLock<Mutex<std::collections::VecDeque<Arc<RuntimeSlot>>>> =
    LazyLock::new(|| Mutex::new(std::collections::VecDeque::new()));
#[derive(Clone)]
pub(crate) struct SourceExtractionWorker {
    node: PathBuf,
    entry: PathBuf,
    distribution: PathBuf,
    timeout: Duration,
    fingerprint: String,
    verified_files: Arc<Vec<(PathBuf, crate::source_file_snapshot::FileStamp)>>,
    verified_directories: Arc<Vec<PathBuf>>,
}
impl SourceExtractionWorker {
    pub(crate) fn for_app(app: &tauri::AppHandle) -> AgentResult<Self> {
        use tauri::Manager;
        if let Ok(root) = app.path().resource_dir() {
            if root.join("source-extractor/runtime.json").is_file() {
                return Self::bundled_cached(&root);
            }
        }
        #[cfg(debug_assertions)]
        {
            return Self::bundled_cached(
                &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"),
            );
        }
        #[cfg(not(debug_assertions))]
        Err(unavailable())
    }
    pub(crate) fn bundled_cached(resources: &Path) -> AgentResult<Self> {
        let slot = {
            let mut entries = VERIFIED_RUNTIMES.lock().map_err(|_| unavailable())?;
            if let Some(index) = entries.iter().position(|entry| entry.root == resources) {
                let entry = entries.remove(index).unwrap();
                entries.push_back(entry.clone());
                entry
            } else {
                if entries.len() == 2 {
                    let index = entries
                        .iter()
                        .position(|entry| Arc::strong_count(entry) == 1)
                        .ok_or_else(|| {
                            AgentError::new(
                                ErrorCode::RunBusy,
                                "Source runtime verification is busy",
                            )
                        })?;
                    entries.remove(index);
                }
                let entry = Arc::new(RuntimeSlot {
                    root: resources.to_owned(),
                    worker: Mutex::new(None),
                });
                entries.push_back(entry.clone());
                entry
            }
        };
        let mut cached = slot.worker.lock().map_err(|_| unavailable())?;
        if let Some(worker) = cached
            .as_ref()
            .filter(|worker| worker.resources_unchanged())
        {
            return Ok(worker.clone());
        }
        *cached = None;
        let worker = Self::bundled(resources)?;
        *cached = Some(worker.clone());
        Ok(worker)
    }
    fn resources_unchanged(&self) -> bool {
        // Windows timestamps are not a content proof. Keep full verification
        // there, exactly as with File snapshots, until a stronger proof exists.
        if cfg!(windows) {
            return false;
        }
        self.verified_directories
            .iter()
            .all(|path| require_directory(path).is_ok())
            && self.verified_files.iter().all(|(path, stamp)| {
                fs::symlink_metadata(path).is_ok_and(|metadata| {
                    metadata.is_file()
                        && !metadata.file_type().is_symlink()
                        && crate::source_file_snapshot::FileStamp::from_metadata(&metadata)
                            == *stamp
                })
            })
    }
    pub(crate) fn bundled(resources: &Path) -> AgentResult<Self> {
        let root = resources.join("source-extractor");
        let distribution = root.join("source-dist");
        let mut verified_files = Vec::new();
        let mut verified_directories = Vec::new();
        let mut verify = |path: &Path, hash: &Value| -> AgentResult<()> {
            verified_files.push((path.to_owned(), verify_hash(path, hash)?));
            Ok(())
        };
        for directory in [
            &root,
            &distribution,
            &root.join("src"),
            &resources.join("agent-host"),
        ] {
            require_directory(directory)?;
            verified_directories.push(directory.clone());
        }
        let runtime_path = root.join("runtime.json");
        let runtime_stamp = crate::source_file_snapshot::FileStamp::from_metadata(
            &fs::symlink_metadata(&runtime_path).map_err(|_| unavailable())?,
        );
        let runtime = regular_json(&runtime_path)?;
        if crate::source_file_snapshot::FileStamp::from_metadata(
            &fs::symlink_metadata(&runtime_path).map_err(|_| unavailable())?,
        ) != runtime_stamp
        {
            return Err(unavailable());
        }
        let node =
            resources
                .join("agent-host")
                .join(if cfg!(windows) { "node.exe" } else { "node" });
        let entry = root.join("src/source-worker-entry.mjs");
        let target = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", "aarch64") => "darwin-arm64",
            ("macos", "x86_64") => "darwin-x64",
            ("windows", "aarch64") => "win-arm64",
            ("windows", "x86_64") => "win-x64",
            #[cfg(any(debug_assertions, test))]
            ("linux", "x86_64") => "linux-x64",
            _ => return Err(unavailable()),
        };
        if runtime["nodeVersion"] != "24.21.0" || runtime["target"] != target {
            return Err(unavailable());
        }
        verify(&node, &runtime["nodeChecksum"])?;
        verify(&entry, &runtime["sourceEntryChecksum"])?;
        let manifest_file = distribution.join("source-worker-distribution.json");
        verify(&manifest_file, &runtime["sourceDistributionChecksum"])?;
        let manifest = regular_json(&manifest_file)?;
        if manifest["schemaVersion"] != 1 {
            return Err(unavailable());
        }
        verify(
            &distribution.join("SOURCE-THIRD-PARTY-NOTICES.txt"),
            &manifest["noticesChecksum"],
        )?;
        let bundles = manifest["bundles"].as_array().ok_or_else(unavailable)?;
        let assets = manifest["assets"].as_array().ok_or_else(unavailable)?;
        if !bundles
            .iter()
            .any(|entry| entry["file"] == "source-extraction-worker.mjs")
            || assets.is_empty()
        {
            return Err(unavailable());
        }
        let mut seen = std::collections::HashSet::new();
        for item in bundles.iter().chain(assets.iter()) {
            let relative = item["file"].as_str().ok_or_else(unavailable)?;
            let components: Vec<_> = relative.split('/').collect();
            if components.iter().any(|part| {
                part.is_empty()
                    || *part == "."
                    || *part == ".."
                    || !part
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"_-.".contains(&byte))
            }) || !(components.len() == 1
                && relative.starts_with("source-")
                && relative.ends_with(".mjs")
                || components.len() == 2 && matches!(components[0], "pdf-cmaps" | "pdf-fonts"))
                || !seen.insert(relative)
            {
                return Err(unavailable());
            }
            let file = distribution.join(relative);
            let parent = fs::symlink_metadata(file.parent().ok_or_else(unavailable)?)
                .map_err(|_| unavailable())?;
            if !parent.is_dir() || parent.file_type().is_symlink() {
                return Err(unavailable());
            }
            verified_directories.push(file.parent().ok_or_else(unavailable)?.to_owned());
            verify(&file, &item["checksum"])?;
        }
        drop(verify);
        verified_files.push((runtime_path, runtime_stamp));
        verified_directories.sort();
        verified_directories.dedup();
        Ok(Self {
            node: node.canonicalize().map_err(|_| unavailable())?,
            entry: entry.canonicalize().map_err(|_| unavailable())?,
            distribution: distribution.canonicalize().map_err(|_| unavailable())?,
            timeout: Duration::from_secs(60),
            verified_files: Arc::new(verified_files),
            verified_directories: Arc::new(verified_directories),
            fingerprint: format!(
                "{:x}",
                Sha256::digest(
                    serde_json::to_vec(&(&runtime, &manifest)).map_err(|_| unavailable())?
                )
            ),
        })
    }
    pub(crate) fn cache_identity(&self) -> String {
        format!(
            "{}:{}:{}",
            self.entry.display(),
            self.distribution.display(),
            self.fingerprint
        )
    }
    pub(crate) async fn request(
        &self,
        workspace_id: &str,
        request_id: &str,
        format: &str,
        bytes: &[u8],
    ) -> AgentResult<Value> {
        let maximum = match format {
            "pdf" => 50 * 1024 * 1024,
            "text" | "markdown" | "html" => 10 * 1024 * 1024,
            _ => {
                return Err(AgentError::new(
                    ErrorCode::InvalidArgument,
                    "Unsupported source extraction format",
                ))
            }
        };
        if workspace_id.is_empty()
            || workspace_id.len() > 128
            || request_id.is_empty()
            || request_id.len() > 128
            || bytes.len() > maximum
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid source extraction snapshot",
            ));
        }
        let slot = workspace_slot(workspace_id)?;
        let _permit = tokio::time::timeout(self.timeout, slot.acquire())
            .await
            .map_err(|_| AgentError::new(ErrorCode::RunBusy, "Workspace extraction is busy"))?
            .map_err(|_| unavailable())?;
        let mut frame = serde_json::to_vec(&json!({"requestId":request_id,"format":format,"base64":base64::engine::general_purpose::STANDARD.encode(bytes)})).map_err(|_| unavailable())?;
        frame.push(b'\n');
        #[cfg(test)]
        {
            *REQUEST_COUNTS
                .lock()
                .unwrap()
                .entry(workspace_id.to_owned())
                .or_default() += 1;
        }
        let output = crate::utility_process::run_utility_process(
            &self.node,
            &self.entry,
            &self.distribution,
            &frame,
            crate::utility_process::UtilityLimits {
                timeout: self.timeout,
                response_bytes: RESPONSE_LIMIT,
                heap_mib: 512,
            },
        )
        .await?;
        decode_response(request_id, &output)
    }
}
fn decode_response(request_id: &str, bytes: &[u8]) -> AgentResult<Value> {
    let invalid = || {
        AgentError::new(
            ErrorCode::RuntimeIncompatible,
            "Invalid source extraction response",
        )
    };
    if bytes.last() != Some(&b'\n')
        || bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .count()
            != 1
    {
        return Err(invalid());
    }
    let response: Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if response["requestId"].as_str() != Some(request_id) {
        return Err(invalid());
    }
    if response["ok"] == false {
        return Err(AgentError::new(
            ErrorCode::IoFailed,
            "Cannot extract source snapshot",
        ));
    }
    if response["ok"] != true {
        return Err(invalid());
    }
    let data = response.get("data").ok_or_else(invalid)?;
    let state = data["state"].as_str().ok_or_else(invalid)?;
    if !matches!(
        state,
        "ready"
            | "partial"
            | "needs_ocr"
            | "encrypted"
            | "too_large"
            | "failed"
            | "unsupported_encoding"
    ) {
        return Err(invalid());
    }
    let chunks = data["chunks"].as_array().ok_or_else(invalid)?;
    let chars = data["coverage"]["chars"].as_u64().ok_or_else(invalid)?;
    if chunks.len() > 10000
        || chars > 2 * 1024 * 1024
        || data["coverage"]["complete"].as_bool() != Some(state == "ready")
    {
        return Err(invalid());
    }
    let paragraph_mode = data["coverage"].get("paragraphs").is_some();
    let mut covered = std::collections::BTreeMap::<u64, u64>::new();
    let mut actual_chars = 0;
    let mut previous_location = 0;
    for (ordinal, chunk) in chunks.iter().enumerate() {
        let text = chunk["text"].as_str().ok_or_else(invalid)?;
        let start = chunk["range"]["start"].as_u64().ok_or_else(invalid)?;
        let end = chunk["range"]["end"].as_u64().ok_or_else(invalid)?;
        let location = if paragraph_mode {
            if chunk["locator"]["kind"] != "paragraph"
                || chunk["locator"]["start"] != chunk["locator"]["end"]
            {
                return Err(invalid());
            }
            chunk["locator"]["start"].as_u64().ok_or_else(invalid)?
        } else {
            if chunk["locator"]["kind"] != "page"
                || chunk["locator"]["start"].as_u64() != Some(start)
                || chunk["locator"]["end"].as_u64() != Some(end)
            {
                return Err(invalid());
            }
            chunk["locator"]["page"].as_u64().ok_or_else(invalid)?
        };
        if chunk["ordinal"].as_u64() != Some(ordinal as u64)
            || text.is_empty()
            || end < start
            || end - start != text.chars().count() as u64
            || end - start > 1800
            || end > 2 * 1024 * 1024
            || location == 0
            || location < previous_location
        {
            return Err(invalid());
        }
        let previous_end = covered.get(&location).copied().unwrap_or(0);
        if start != previous_end.saturating_sub(200) || end <= previous_end {
            return Err(invalid());
        }
        actual_chars += end - previous_end;
        covered.insert(location, end);
        previous_location = location;
    }
    if actual_chars != chars {
        return Err(invalid());
    }
    if paragraph_mode {
        if data["coverage"]["paragraphs"].as_u64() != Some(covered.len() as u64) {
            return Err(invalid());
        }
    } else {
        let pages_read = data["coverage"]["pagesRead"].as_u64().ok_or_else(invalid)?;
        let pages = data["coverage"]["textPages"]
            .as_array()
            .ok_or_else(invalid)?;
        if pages_read > 500
            || pages.iter().map(Value::as_u64).collect::<Option<Vec<_>>>()
                != Some(covered.keys().copied().collect())
        {
            return Err(invalid());
        }
        match data["coverage"]["totalPages"].as_u64() {
            Some(total)
                if total > 0
                    && pages_read <= total
                    && previous_location <= pages_read
                    && (state != "ready"
                        || pages_read == total && covered.len() as u64 == total) =>
            {
                ()
            }
            None if data["coverage"]["totalPages"].is_null()
                && pages_read == 0
                && covered.is_empty()
                && state != "ready" =>
            {
                ()
            }
            _ => return Err(invalid()),
        }
    }
    match (state, data["reason"].as_str()) {
        (
            "partial",
            Some(
                "character_limit" | "chunk_limit" | "page_limit" | "missing_text"
                | "structure_limit",
            ),
        )
        | ("failed", Some("invalid_pdf")) => (),
        ("partial" | "failed", _) => return Err(invalid()),
        (_, None) if data["reason"].is_null() => (),
        _ => return Err(invalid()),
    }
    Ok(data.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_node(prepared: &Path, fixture: &Path) -> PathBuf {
        let name = if cfg!(windows) { "node.exe" } else { "node" };
        fs::create_dir(fixture.join("agent-host")).unwrap();
        let node = fixture.join("agent-host").join(name);
        // A hard link changes the shared Node inode's ctime on creation and cleanup,
        // racing bundled() verification in other tests. Give each fixture its own inode.
        fs::copy(prepared.join("agent-host").join(name), &node).unwrap();
        node
    }

    #[cfg(unix)]
    #[test]
    fn source_runtime_fixture_does_not_change_shared_node_identity_or_stamp() {
        use std::os::unix::fs::MetadataExt;

        // Exercise the same fixture constructor without touching the packaged runtime.
        let prepared = tempfile::tempdir().unwrap();
        fs::create_dir(prepared.path().join("agent-host")).unwrap();
        let source = prepared.path().join("agent-host/node");
        fs::write(&source, b"fixture node").unwrap();
        let before = fs::metadata(&source).unwrap();
        let stamp = crate::source_file_snapshot::FileStamp::from_metadata(&before);
        let fixture = tempfile::tempdir().unwrap();
        let node = fixture_node(prepared.path(), fixture.path());
        assert_ne!(
            fs::metadata(&node).unwrap().ino(),
            before.ino(),
            "runtime fixtures must own an independent inode"
        );
        assert_eq!(fs::read(&node).unwrap(), fs::read(&source).unwrap());
        assert_eq!(
            crate::source_file_snapshot::FileStamp::from_metadata(&fs::metadata(&source).unwrap()),
            stamp,
            "creating a fixture must not invalidate a concurrent runtime verification"
        );
        drop(fixture);
        assert_eq!(
            crate::source_file_snapshot::FileStamp::from_metadata(&fs::metadata(&source).unwrap()),
            stamp,
            "removing a fixture must not invalidate a concurrent runtime verification"
        );
    }
    #[test]
    fn source_worker_rejects_inconsistent_coverage_and_source_anchors() {
        let mut data = json!({"state":"ready","reason":null,"chunks":[{"ordinal":0,"text":"abc","locator":{"kind":"paragraph","start":1,"end":1},"range":{"start":0,"end":3}}],"coverage":{"chars":3,"paragraphs":1,"complete":true}});
        let decode = |data: &Value| {
            decode_response(
                "fixture",
                &serde_json::to_vec(&json!({"requestId":"fixture","ok":true,"data":data}))
                    .unwrap()
                    .into_iter()
                    .chain([b'\n'])
                    .collect::<Vec<_>>(),
            )
        };
        assert!(decode(&data).is_ok());
        data["coverage"]["chars"] = json!(2);
        assert!(decode(&data).is_err());
        data["coverage"]["chars"] = json!(3);
        data["chunks"][0]["locator"]["start"] = json!(0);
        assert!(decode(&data).is_err());
        data["chunks"][0]["locator"] = json!({"kind":"page","page":2,"start":0,"end":3});
        data["coverage"] =
            json!({"chars":3,"pagesRead":1,"totalPages":1,"textPages":[1],"complete":true});
        assert!(decode(&data).is_err());
    }
    #[tokio::test]
    async fn source_worker_extracts_bound_snapshot_with_packaged_runtime() {
        let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let worker = SourceExtractionWorker::bundled(&resources).unwrap();
        let extracted = worker
            .request(
                "source-workspace",
                "fixture-request",
                "html",
                "<p>中文 evidence</p><script>hidden()</script>".as_bytes(),
            )
            .await
            .unwrap();
        assert_eq!(extracted["state"], "ready");
        assert_eq!(extracted["chunks"][0]["text"], "中文 evidence");
        assert_eq!(extracted["coverage"]["complete"], true);
    }
    #[tokio::test]
    async fn source_worker_serializes_one_workspace_without_blocking_another() {
        let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let mut worker = SourceExtractionWorker::bundled(&resources).unwrap();
        let slot = workspace_slot("quota-workspace-a").unwrap();
        let permit = slot.acquire().await.unwrap();
        worker.timeout = Duration::from_millis(50);
        let blocked = worker
            .request("quota-workspace-a", "blocked", "text", b"kept")
            .await
            .unwrap_err();
        assert_eq!(blocked.code, ErrorCode::RunBusy);
        worker.timeout = Duration::from_secs(3);
        assert_eq!(
            worker
                .request("quota-workspace-b", "independent", "text", b"other")
                .await
                .unwrap()["state"],
            "ready"
        );
        drop(permit);
        assert_eq!(
            worker
                .request("quota-workspace-a", "released", "text", b"kept")
                .await
                .unwrap()["state"],
            "ready"
        );
    }
    #[tokio::test]
    async fn source_worker_kills_hung_process_and_releases_workspace_slot() {
        let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let mut worker = SourceExtractionWorker::bundled(&resources).unwrap();
        let original = worker.entry.clone();
        let temp = tempfile::tempdir().unwrap();
        let entry = temp.path().join("hang.mjs");
        fs::write(
            &entry,
            "setInterval(()=>{},1000); await new Promise(()=>{});",
        )
        .unwrap();
        worker.entry = entry.canonicalize().unwrap();
        worker.timeout = Duration::from_millis(500);
        let error = worker
            .request("timeout-workspace", "hung", "text", b"draft")
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::IoFailed);
        assert!(error.message.contains("timed out"));
        worker.entry = original;
        worker.timeout = Duration::from_secs(3);
        assert_eq!(
            worker
                .request("timeout-workspace", "retry", "text", b"draft")
                .await
                .unwrap()["state"],
            "ready"
        );
    }
    #[cfg(unix)]
    #[test]
    fn source_runtime_cache_reuses_verified_resources_and_rejects_restored_mtime_change() {
        fn copy_tree(from: &Path, to: &Path) {
            fs::create_dir_all(to).unwrap();
            for item in fs::read_dir(from).unwrap() {
                let item = item.unwrap();
                let destination = to.join(item.file_name());
                if item.file_type().unwrap().is_dir() {
                    copy_tree(&item.path(), &destination);
                } else {
                    fs::copy(item.path(), destination).unwrap();
                }
            }
        }
        let prepared = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let temp = tempfile::tempdir().unwrap();
        copy_tree(
            &prepared.join("source-extractor"),
            &temp.path().join("source-extractor"),
        );
        let node = fixture_node(&prepared, temp.path());
        let worker = SourceExtractionWorker::bundled_cached(temp.path()).unwrap();
        for _ in 0..100 {
            let next = SourceExtractionWorker::bundled_cached(temp.path()).unwrap();
            assert_eq!(next.cache_identity(), worker.cache_identity());
        }
        assert_eq!(
            verification_count(&node),
            1,
            "unchanged wrappers must not rehash Node"
        );
        let font = temp
            .path()
            .join("source-extractor/source-dist/pdf-fonts/LiberationSans-Regular.ttf");
        assert_eq!(verification_count(&font), 1);
        let modified = fs::metadata(&font).unwrap().modified().unwrap();
        let mut content = fs::read(&font).unwrap();
        content[0] ^= 1;
        fs::write(&font, content).unwrap();
        fs::File::open(&font)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert!(SourceExtractionWorker::bundled_cached(temp.path()).is_err());
        assert_eq!(
            verification_count(&node),
            2,
            "changed stat proof forces full verification"
        );
    }
    #[test]
    fn source_worker_rejects_a_modified_packaged_parser_resource() {
        fn copy_tree(from: &Path, to: &Path) {
            fs::create_dir_all(to).unwrap();
            for item in fs::read_dir(from).unwrap() {
                let item = item.unwrap();
                let destination = to.join(item.file_name());
                if item.file_type().unwrap().is_dir() {
                    copy_tree(&item.path(), &destination);
                } else {
                    fs::copy(item.path(), destination).unwrap();
                }
            }
        }
        let prepared = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let temp = tempfile::tempdir().unwrap();
        copy_tree(
            &prepared.join("source-extractor"),
            &temp.path().join("source-extractor"),
        );
        fixture_node(&prepared, temp.path());
        let font = temp
            .path()
            .join("source-extractor/source-dist/pdf-fonts/LiberationSans-Regular.ttf");
        fs::write(font, b"changed parser resource").unwrap();
        assert!(SourceExtractionWorker::bundled(temp.path()).is_err());
    }
    #[test]
    fn source_worker_refuses_unprepared_distribution() {
        let root = tempfile::tempdir().unwrap();
        assert!(SourceExtractionWorker::bundled(root.path()).is_err());
    }
}
