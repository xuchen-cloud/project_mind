//! Native-only XLSX baseline ownership. No lease or session identity crosses IPC.
use super::*;
use crate::{agent::models::WorkspaceBinding, db::project_directory_files::FileBytesInput};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex, Weak,
    },
    time::Instant,
};
use tokio::io::{AsyncBufReadExt, BufReader};

const BASELINE_LIMIT: usize = 64 * 1024 * 1024;
const BASELINE_BYTES: usize = 128 * 1024 * 1024;
const IDLE: Duration = Duration::from_secs(30);
struct Scope {
    binding: WorkspaceBinding,
    active: AtomicBool,
}
static SCOPES: LazyLock<Mutex<VecDeque<Arc<Scope>>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));
#[derive(Clone)]
pub(crate) struct OfficeBaseline {
    scope: Arc<Scope>,
    input: FileBytesInput,
    bytes: usize,
}
// Called under the authorized current-store lock, before any asynchronous work.
pub(crate) fn baseline_context(
    binding: &WorkspaceBinding,
    input: &FileBytesInput,
    bytes: usize,
) -> AgentResult<OfficeBaseline> {
    if bytes == 0 || bytes > BASELINE_LIMIT {
        return Err(failure(
            ErrorCode::BudgetExceeded,
            "Recalculation baseline exceeds 64 MiB",
        ));
    }
    let mut scopes = SCOPES.lock().map_err(|_| busy())?;
    scopes.retain(|scope| {
        let keep = scope.binding.workspace_id != binding.workspace_id || scope.binding == *binding;
        if !keep {
            scope.active.store(false, Ordering::Release);
        }
        keep
    });
    let scope = if let Some(scope) = scopes.iter().find(|scope| scope.binding == *binding) {
        scope.clone()
    } else {
        if scopes.len() == 16 {
            let index = scopes
                .iter()
                .position(|scope| Arc::strong_count(scope) == 1)
                .ok_or_else(busy)?;
            scopes
                .remove(index)
                .unwrap()
                .active
                .store(false, Ordering::Release);
        }
        let scope = Arc::new(Scope {
            binding: binding.clone(),
            active: AtomicBool::new(true),
        });
        scopes.push_back(scope.clone());
        scope
    };
    Ok(OfficeBaseline {
        scope,
        input: input.clone(),
        bytes,
    })
}
fn busy() -> AgentError {
    failure(
        ErrorCode::EditorBusy,
        "Office baseline process or byte budget is full",
    )
}
fn closed() -> AgentError {
    failure(
        ErrorCode::WorkspaceChanged,
        "Office baseline generation is no longer active",
    )
}
struct Lease {
    baseline: OfficeBaseline,
    active: AtomicBool,
    state: tokio::sync::Mutex<Option<Session>>,
    tree: Mutex<Option<crate::office_process::ProcessTree>>,
    used: Mutex<Instant>,
}
impl Lease {
    fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire) && self.baseline.scope.active.load(Ordering::Acquire)
    }
    fn close(&self) {
        self.active.store(false, Ordering::Release);
        // Can kill a busy request immediately without waiting on its async lock.
        if let Ok(mut tree) = self.tree.lock() {
            tree.take();
        }
        if let Ok(mut state) = self.state.try_lock() {
            state.take();
        }
    }
}
static LEASES: LazyLock<Mutex<VecDeque<Arc<Lease>>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));
pub(crate) fn clear_baselines(binding: &WorkspaceBinding) {
    if let Ok(mut scopes) = SCOPES.lock() {
        scopes.retain(|scope| {
            if scope.binding == *binding {
                scope.active.store(false, Ordering::Release);
                false
            } else {
                true
            }
        });
    }
    if let Ok(mut entries) = LEASES.lock() {
        entries.retain(|entry| {
            if entry.baseline.scope.binding == *binding {
                entry.close();
                false
            } else {
                true
            }
        });
    }
}
// One-shot inspect/edit/save must not wait behind two unused warm baselines.
pub(super) fn evict_idle() {
    if let Ok(mut entries) = LEASES.lock() {
        entries.retain(|entry| {
            if Arc::strong_count(entry) == 1 {
                entry.close();
                false
            } else {
                true
            }
        });
    }
}
fn lease(baseline: &OfficeBaseline) -> AgentResult<Arc<Lease>> {
    let mut entries = LEASES.lock().map_err(|_| busy())?;
    if !baseline.scope.active.load(Ordering::Acquire) {
        return Err(closed());
    }
    entries.retain(|entry| {
        let keep = entry.is_active()
            && (entry.baseline.scope.binding.workspace_id != baseline.scope.binding.workspace_id
                || entry.baseline.scope.binding == baseline.scope.binding);
        if !keep {
            entry.close();
        }
        keep
    });
    if let Some(index) = entries.iter().position(|entry| {
        entry.baseline.scope.binding == baseline.scope.binding
            && entry.baseline.input == baseline.input
    }) {
        let entry = entries.remove(index).unwrap();
        entries.push_back(entry.clone());
        return Ok(entry);
    }
    while entries.len() >= 2
        || entries
            .iter()
            .map(|entry| entry.baseline.bytes)
            .sum::<usize>()
            + baseline.bytes
            > BASELINE_BYTES
    {
        let index = entries
            .iter()
            .position(|entry| Arc::strong_count(entry) == 1)
            .ok_or_else(busy)?;
        entries.remove(index).unwrap().close();
    }
    let entry = Arc::new(Lease {
        baseline: baseline.clone(),
        active: AtomicBool::new(true),
        state: tokio::sync::Mutex::new(None),
        tree: Mutex::new(None),
        used: Mutex::new(Instant::now()),
    });
    entries.push_back(entry.clone());
    let weak = Arc::downgrade(&entry);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(IDLE).await;
            let Some(entry) = weak.upgrade() else { break };
            if expire_idle(&entry) {
                break;
            }
        }
    });
    Ok(entry)
}
fn expire_idle(entry: &Arc<Lease>) -> bool {
    let Ok(mut entries) = LEASES.lock() else {
        return true;
    };
    if !entry.is_active() {
        entry.close();
        entries.retain(|candidate| !Arc::ptr_eq(candidate, entry));
        return true;
    }
    if Arc::strong_count(entry) == 2 && entry.used.lock().is_ok_and(|used| used.elapsed() >= IDLE) {
        entry.close();
        entries.retain(|candidate| !Arc::ptr_eq(candidate, entry));
        true
    } else {
        false
    }
}
#[cfg(test)]
static STARTS: LazyLock<Mutex<Vec<(String, u32)>>> = LazyLock::new(|| Mutex::new(Vec::new()));
#[cfg(test)]
static DIRECTORIES: LazyLock<Mutex<Vec<(String, PathBuf)>>> =
    LazyLock::new(|| Mutex::new(Vec::new()));
struct Session {
    child: tokio::process::Child,
    input: tokio::process::ChildStdin,
    output: BufReader<tokio::process::ChildStdout>,
    _temporary: tempfile::TempDir,
    _permit: tokio::sync::SemaphorePermit<'static>,
    lease: Weak<Lease>,
    entry: PathBuf,
}
impl Drop for Session {
    fn drop(&mut self) {
        // Cancellation drops the local session before it can return to the
        // cache. Kill the whole tree even though the lease itself stays alive.
        if let Some(lease) = self.lease.upgrade() {
            if let Ok(mut tree) = lease.tree.lock() {
                tree.take();
            }
        }
        let _ = self.child.start_kill();
    }
}
impl Session {
    async fn start(worker: &OfficeWorker, lease: &Arc<Lease>) -> AgentResult<Self> {
        let permit = tokio::time::timeout(Duration::from_secs(15), SLOTS.acquire())
            .await
            .map_err(|_| busy())?
            .map_err(|_| busy())?;
        if !lease.is_active() {
            return Err(closed());
        }
        let temporary = tempfile::tempdir().map_err(|_| {
            failure(
                ErrorCode::IoFailed,
                "Cannot prepare Office baseline directory",
            )
        })?;
        let temp = temporary.path().canonicalize().map_err(|_| {
            failure(
                ErrorCode::IoFailed,
                "Cannot resolve Office baseline directory",
            )
        })?;
        #[cfg(test)]
        DIRECTORIES.lock().unwrap().push((
            lease.baseline.scope.binding.workspace_id.clone(),
            temp.clone(),
        ));
        let process_temp = crate::node_paths::permission_path(&temp);
        let mut command = Command::new(&worker.node);
        command
            .arg("--permission")
            .arg("--max-old-space-size=1024")
            .arg(format!(
                "--allow-fs-read={}",
                crate::node_paths::permission_path(&worker.entry).display()
            ))
            .arg(format!(
                "--allow-fs-read={}",
                crate::node_paths::permission_path(&worker.distribution).display()
            ))
            .arg(format!("--allow-fs-read={}", process_temp.display()))
            .arg(format!("--allow-fs-write={}", process_temp.display()))
            .arg("--allow-child-process")
            .arg(format!("--import={NODE_GUARD}"))
            .arg(&worker.entry)
            .arg("--recalc-baseline")
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
                "Cannot start Office baseline worker",
            )
        })?;
        let tree = crate::office_process::ProcessTree::attach(&child)?;
        let mut owner = lease.tree.lock().map_err(|_| busy())?;
        if !lease.is_active() {
            drop(tree);
            return Err(closed());
        }
        *owner = Some(tree);
        drop(owner);
        #[cfg(test)]
        STARTS.lock().unwrap().push((
            lease.baseline.scope.binding.workspace_id.clone(),
            child.id().unwrap(),
        ));
        let input = child
            .stdin
            .take()
            .ok_or_else(|| failure(ErrorCode::IoFailed, "Office baseline input unavailable"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| failure(ErrorCode::IoFailed, "Office baseline output unavailable"))?;
        Ok(Self {
            child,
            input,
            output: BufReader::new(output),
            _temporary: temporary,
            _permit: permit,
            lease: Arc::downgrade(lease),
            entry: worker.entry.clone(),
        })
    }
    async fn exchange(
        &mut self,
        id: &str,
        source: Option<&str>,
        input: &OfficeRecalculation,
    ) -> AgentResult<Value> {
        let mut data = json!({"format":"xlsx","recalculation":input});
        if let Some(source) = source {
            data["base64"] = json!(source);
        }
        let mut frame =
            serde_json::to_vec(&json!({"requestId":id,"method":"office.recalculate","data":data}))
                .map_err(|_| {
                    failure(ErrorCode::InvalidArgument, "Invalid Office baseline frame")
                })?;
        if frame.len() > FRAME_LIMIT {
            return Err(failure(
                ErrorCode::BudgetExceeded,
                "Office request exceeds frame limit",
            ));
        }
        frame.push(b'\n');
        self.input
            .write_all(&frame)
            .await
            .map_err(|_| failure(ErrorCode::IoFailed, "Office baseline input failed"))?;
        self.input
            .flush()
            .await
            .map_err(|_| failure(ErrorCode::IoFailed, "Office baseline input failed"))?;
        let mut result = Vec::new();
        (&mut self.output)
            .take(FRAME_LIMIT as u64 + 1)
            .read_until(b'\n', &mut result)
            .await
            .map_err(|_| failure(ErrorCode::IoFailed, "Office baseline output failed"))?;
        if result.len() > FRAME_LIMIT {
            return Err(failure(
                ErrorCode::BudgetExceeded,
                "Office response exceeds frame limit",
            ));
        }
        if result.last() != Some(&b'\n') {
            return Err(failure(
                ErrorCode::RuntimeIncompatible,
                "Incomplete Office baseline response",
            ));
        }
        decode_response(id, "office.recalculate", &result)
    }
}
pub(super) async fn recalculate(
    worker: &OfficeWorker,
    baseline: &OfficeBaseline,
    id: &str,
    source: &str,
    input: &OfficeRecalculation,
) -> AgentResult<Value> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    input.validate()?;
    if id.is_empty() || id.len() > 128 {
        return Err(failure(
            ErrorCode::InvalidArgument,
            "Invalid Office recalculation request identity",
        ));
    }
    let lease = lease(baseline)?;
    let mut state = tokio::time::timeout(worker.timeout, lease.state.lock())
        .await
        .map_err(|_| busy())?;
    if !lease.is_active() {
        return Err(closed());
    }
    let existing = state.take().filter(|session| session.entry == worker.entry);
    let fresh = existing.is_none();
    // Only initialization crosses the source-byte process boundary. Every
    // warm call still arrives after FileOfficeService read/hash and auth checks.
    if fresh {
        if source.len() > BASELINE_LIMIT.div_ceil(3) * 4 {
            return Err(failure(
                ErrorCode::BudgetExceeded,
                "Office baseline exceeds 64 MiB",
            ));
        }
        let bytes = STANDARD
            .decode(source)
            .map_err(|_| failure(ErrorCode::InvalidArgument, "Invalid Office baseline bytes"))?;
        if bytes.len() != baseline.bytes || STANDARD.encode(&bytes) != source {
            return Err(failure(
                ErrorCode::InvalidArgument,
                "Office baseline requires exact canonical bytes",
            ));
        }
        // FileOfficeService supplied this native-only context after its retained
        // byte/hash read. Reuse that invariant rather than hashing again here.
        drop(bytes);
    }

    let mut session = if let Some(session) = existing {
        session
    } else {
        Session::start(worker, &lease).await?
    };
    let result = tokio::time::timeout(
        worker.timeout,
        session.exchange(id, if fresh { Some(source) } else { None }, input),
    )
    .await
    .map_err(|_| failure(ErrorCode::IoFailed, "Office baseline worker timed out"))?;
    if !lease.is_active() {
        return Err(closed());
    }
    if result.is_ok() {
        *lease.used.lock().map_err(|_| busy())? = Instant::now();
        *state = Some(session);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::models::{ObjectKind, ObjectRef, Scope as ObjectScope};
    use base64::Engine as _;
    use sha2::{Digest, Sha256};
    static TEST_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    fn fixture(
        bytes: &[u8],
        entry: Option<&str>,
    ) -> (tempfile::TempDir, OfficeWorker, OfficeBaseline) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let source = root.join("src");
        let dist = root.join("office-dist");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&dist).unwrap();
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        if let Some(entry) = entry {
            std::fs::write(source.join("office-worker-entry.mjs"), entry).unwrap();
        } else {
            std::fs::copy(
                repo.join("packages/agent-host/src/office-worker-entry.mjs"),
                source.join("office-worker-entry.mjs"),
            )
            .unwrap();
        }
        std::fs::copy(
            repo.join("packages/office-runtime/worker.mjs"),
            dist.join("worker.mjs"),
        )
        .unwrap();
        std::fs::copy(
            repo.join("packages/office-xlsx/dist/engine.mjs"),
            dist.join("xlsx-engine.mjs"),
        )
        .unwrap();
        for name in ["docx-engine.mjs", "pptx-engine.mjs"] {
            std::fs::write(dist.join(name), "export {};").unwrap();
        }
        let binary = repo.join("packages/office-xlsx/dist").join(sidecar_name());
        std::fs::hard_link(&binary, dist.join(sidecar_name()))
            .or_else(|_| std::fs::copy(binary, dist.join(sidecar_name())).map(|_| ()))
            .unwrap();
        let worker = OfficeWorker::from_paths(
            OfficeWorker::development_node().unwrap(),
            source.join("office-worker-entry.mjs"),
        )
        .unwrap();
        let binding = WorkspaceBinding {
            workspace_id: format!("baseline-{}", root.file_name().unwrap().to_string_lossy()),
            generation: "opened".into(),
        };
        let input = FileBytesInput {
            object: ObjectRef {
                workspace_id: binding.workspace_id.clone(),
                scope: ObjectScope::Workspace,
                kind: ObjectKind::File,
                id: "42".into(),
            },
            version_number: 1,
            expected_content_hash: format!("sha256:{:x}", Sha256::digest(bytes)),
        };
        let baseline = baseline_context(&binding, &input, bytes.len()).unwrap();
        (temp, worker, baseline)
    }
    fn request(value: i32) -> OfficeRecalculation {
        serde_json::from_value(json!({"edits":[{"sheetId":"sheet-1","row":2,"column":1,"input":value.to_string()}],"reads":[{"sheetId":"sheet-1","range":{"startRow":6,"endRow":6,"startColumn":1,"endColumn":1}}]})).unwrap()
    }
    fn starts(baseline: &OfficeBaseline) -> Vec<u32> {
        STARTS
            .lock()
            .unwrap()
            .iter()
            .filter(|(workspace, _)| workspace == &baseline.scope.binding.workspace_id)
            .map(|(_, pid)| *pid)
            .collect()
    }
    #[tokio::test]
    async fn office_baseline_50_distinct_edits_and_concurrent_requests_reuse_one_private_worker() {
        let _gate = TEST_GATE.lock().await;
        let bytes = std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../packages/office-xlsx/tests/fixtures/simple.original.xlsx"),
        )
        .unwrap();
        let (_temp, worker, baseline) = fixture(&bytes, None);
        let source = base64::engine::general_purpose::STANDARD.encode(&bytes);
        for value in 1..=50 {
            let result = recalculate(
                &worker,
                &baseline,
                &format!("edit-{value}"),
                &source,
                &request(value),
            )
            .await
            .unwrap();
            assert_eq!(result["cells"][0]["number"], value * 2);
        }
        let a = request(17);
        let b = request(29);
        let (first, second) = tokio::join!(
            recalculate(&worker, &baseline, "concurrent-a", &source, &a),
            recalculate(&worker, &baseline, "concurrent-b", &source, &b)
        );
        assert_eq!(first.unwrap()["cells"][0]["number"], 34);
        assert_eq!(second.unwrap()["cells"][0]["number"], 58);
        assert_eq!(
            starts(&baseline).len(),
            1,
            "50 sequential and 2 concurrent overlays must share one native-owned process"
        );
        let lease = lease(&baseline).unwrap();
        *lease.used.lock().unwrap() = Instant::now() - IDLE;
        assert!(expire_idle(&lease));
        assert!(lease.state.try_lock().unwrap().is_none());
        assert!(lease.tree.lock().unwrap().is_none());
        clear_baselines(&baseline.scope.binding);
    }
    #[tokio::test]
    async fn office_baseline_close_blocks_late_fill_and_generation_reopen_has_new_owner() {
        let _gate = TEST_GATE.lock().await;
        let (_temp, worker, baseline) = fixture(b"abc", Some("process.stdin.resume();"));
        clear_baselines(&baseline.scope.binding);
        assert_eq!(
            recalculate(&worker, &baseline, "late", "YWJj", &request(1))
                .await
                .unwrap_err()
                .code,
            ErrorCode::WorkspaceChanged
        );
        assert!(starts(&baseline).is_empty());
        let mut binding = baseline.scope.binding.clone();
        binding.generation = "reopened".into();
        let next = baseline_context(&binding, &baseline.input, 3).unwrap();
        assert!(next.scope.active.load(Ordering::Acquire));
        assert!(!Arc::ptr_eq(&baseline.scope, &next.scope));
        clear_baselines(&binding);
    }
    #[tokio::test]
    async fn office_baseline_budget_bounds_entries_and_bytes_without_evicting_active_calls() {
        let _gate = TEST_GATE.lock().await;
        let (_temp, _worker, mut baseline) = fixture(b"abc", Some("process.stdin.resume();"));
        baseline.bytes = BASELINE_LIMIT;
        let first = lease(&baseline).unwrap();
        let mut second = baseline.clone();
        second.input.object.id = "43".into();
        let held = lease(&second).unwrap();
        let mut third = baseline.clone();
        third.input.object.id = "44".into();
        assert!(matches!(lease(&third),Err(error) if error.code==ErrorCode::EditorBusy));
        assert!(first.is_active());
        assert!(held.is_active());
        assert_eq!(
            LEASES
                .lock()
                .unwrap()
                .iter()
                .map(|entry| entry.baseline.bytes)
                .sum::<usize>(),
            BASELINE_BYTES
        );
        drop(first);
        let admitted = lease(&third).unwrap();
        assert!(admitted.is_active());
        assert!(held.is_active());
        assert_eq!(LEASES.lock().unwrap().len(), 2);
        assert!(
            matches!(baseline_context(&baseline.scope.binding,&baseline.input,BASELINE_LIMIT+1),Err(error) if error.code==ErrorCode::BudgetExceeded)
        );
        clear_baselines(&baseline.scope.binding);
        assert!(!held.is_active());
        assert!(!admitted.is_active());
    }
    #[cfg(unix)]
    async fn stopped(pid: u32) {
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        for _ in 0..100 {
            if unsafe { kill(pid as i32, 0) } != 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("Office child {pid} survived process-tree disposal");
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn office_baseline_cancel_timeout_and_close_kill_the_entire_tree() {
        let _gate = TEST_GATE.lock().await;
        let entry = r#"import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});let count=0;
createInterface({input:process.stdin}).on('line',line=>{const frame=JSON.parse(line);if(count++===0)process.stdout.write(JSON.stringify({requestId:frame.requestId,ok:true,data:{cells:[{formatted:String(child.pid)}]}})+'\n')});"#;
        for mode in ["cancel", "timeout", "close"] {
            let (_temp, mut worker, baseline) = fixture(b"abc", Some(entry));
            let first = recalculate(&worker, &baseline, "first", "YWJj", &request(1))
                .await
                .unwrap();
            let child = first["cells"][0]["formatted"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap();
            let parent = starts(&baseline)[0];
            if mode == "timeout" {
                worker.timeout = Duration::from_millis(50);
            }
            let pending_worker = worker.clone();
            let pending_baseline = baseline.clone();
            let pending = tokio::spawn(async move {
                recalculate(
                    &pending_worker,
                    &pending_baseline,
                    "pending",
                    "YWJj",
                    &request(2),
                )
                .await
            });
            tokio::time::sleep(Duration::from_millis(20)).await;
            match mode {
                "cancel" => {
                    pending.abort();
                    assert!(pending.await.unwrap_err().is_cancelled());
                }
                "close" => {
                    clear_baselines(&baseline.scope.binding);
                    assert_eq!(
                        pending.await.unwrap().unwrap_err().code,
                        ErrorCode::WorkspaceChanged
                    );
                }
                _ => assert_eq!(
                    pending.await.unwrap().unwrap_err().code,
                    ErrorCode::IoFailed
                ),
            }
            stopped(parent).await;
            stopped(child).await;
            clear_baselines(&baseline.scope.binding);
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn office_baseline_parent_fixture() {
        use std::os::unix::fs::PermissionsExt;
        let Some(directory) = std::env::var_os("PROJECT_MIND_OFFICE_PARENT_FIXTURE") else {
            return;
        };
        let directory = PathBuf::from(directory);
        let bytes = std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../packages/office-xlsx/tests/fixtures/simple.original.xlsx"),
        )
        .unwrap();
        let (_temp, worker, baseline) = fixture(&bytes, None);
        let wrapper = worker.distribution.join(sidecar_name());
        std::fs::remove_file(&wrapper).unwrap(); // fixture initially hard-links the real binary
        let binary = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../packages/office-xlsx/dist/xlsx-sidecar")
            .canonicalize()
            .unwrap();
        let ready = "require('node:path').join(process.cwd(),'inflight.json')";
        let binary = serde_json::to_string(&binary).unwrap();
        let body = format!(
            r#"#!{}
const {{spawn}}=require('node:child_process'),{{createInterface}}=require('node:readline'),fs=require('node:fs');
const child=spawn({binary},[],{{stdio:['pipe','pipe','inherit']}});let blocked=false;
createInterface({{input:process.stdin}}).on('line',line=>{{if(JSON.parse(line).command==='recalc_cells'){{blocked=true;fs.writeFileSync({ready}+'.tmp',JSON.stringify({{worker:process.ppid,wrapper:process.pid,sidecar:child.pid}}));fs.renameSync({ready}+'.tmp',{ready})}}child.stdin.write(line+'\n')}});
createInterface({{input:child.stdout}}).on('line',line=>{{if(!blocked)process.stdout.write(line+'\n')}});
"#,
            worker.node.display()
        );
        std::fs::write(&wrapper, body).unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        let source = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let owner = baseline.scope.binding.workspace_id.clone();
        let pending = tokio::spawn(async move {
            recalculate(&worker, &baseline, "blocked", &source, &request(1)).await
        });
        loop {
            let temp = DIRECTORIES
                .lock()
                .unwrap()
                .iter()
                .find(|(workspace, _)| workspace == &owner)
                .map(|(_, path)| path.clone());
            if let Some(temp) = temp {
                std::fs::write(
                    directory.join("private-temp.json"),
                    serde_json::to_vec(&temp).unwrap(),
                )
                .unwrap();
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        pending.await.unwrap().unwrap();
    }
    #[cfg(unix)]
    struct ParentOwner(std::process::Child);
    #[cfg(unix)]
    impl Drop for ParentOwner {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn office_baseline_parent_sigkill_while_awaiting_sidecar_reaps_worker_and_descendants() {
        use std::os::unix::process::ExitStatusExt;
        let _gate = TEST_GATE.lock().await;
        let directory = tempfile::tempdir().unwrap();
        let module = module_path!().split_once("::").unwrap().1;
        let mut parent = ParentOwner(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    &format!("{module}::office_baseline_parent_fixture"),
                    "--nocapture",
                ])
                .env("PROJECT_MIND_OFFICE_PARENT_FIXTURE", directory.path())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        let private = loop {
            if let Ok(value) = std::fs::read(directory.path().join("private-temp.json")) {
                if let Ok(path) = serde_json::from_slice::<PathBuf>(&value) {
                    break path;
                }
            }
            assert!(
                Instant::now() < deadline,
                "native private directory did not become ready"
            );
            assert!(
                parent.0.try_wait().unwrap().is_none(),
                "native fixture failed before calculation"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        while !private.join("inflight.json").exists() {
            assert!(
                Instant::now() < deadline,
                "native parent did not reach an in-flight sidecar calculation"
            );
            assert!(
                parent.0.try_wait().unwrap().is_none(),
                "native fixture failed before calculation"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let pids: Value =
            serde_json::from_slice(&std::fs::read(private.join("inflight.json")).unwrap()).unwrap();
        parent.0.kill().unwrap();
        assert_eq!(parent.0.wait().unwrap().signal(), Some(9));
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        let mut alive = true;
        for _ in 0..100 {
            alive = ["worker", "wrapper", "sidecar"]
                .iter()
                .any(|key| unsafe { kill(pids[key].as_i64().unwrap() as i32, 0) } == 0);
            if !alive {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // Red-test cleanup is independent of the production mechanism.
        if alive {
            unsafe {
                kill(-(pids["worker"].as_i64().unwrap() as i32), 9);
            }
        }
        let _ = std::fs::remove_dir_all(private);
        assert!(
            !alive,
            "native parent SIGKILL left the in-flight Office process tree alive: {pids}"
        );
    }
}
