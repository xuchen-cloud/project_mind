//! A single native utility per analysis. Only paths and small results cross the
//! boundary; the complete mixed waveform exists exclusively in the child.
use super::{contracts::VoicePlaybackChunk, diarization::DiarizationAnalysis};
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};

const HELPER_FLAG: &str = "--voice-diarization-helper";
const REQUEST_BYTES: u64 = 8 * 1024 * 1024;
const RESPONSE_BYTES: u64 = 32 * 1024 * 1024;
const CANCEL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Serialize, Deserialize)]
struct Request {
    workspace_root: PathBuf,
    cache_root: PathBuf,
    chunks: Vec<VoicePlaybackChunk>,
}

#[derive(Serialize, Deserialize)]
enum Response {
    Completed(DiarizationAnalysis),
    Failed(String),
}

#[derive(Debug)]
pub(crate) struct Cancelled;
impl std::fmt::Display for Cancelled {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("说话人分离已取消")
    }
}
impl std::error::Error for Cancelled {}

struct ReapOnExit<'a>(&'a ProcessOwner);
impl Drop for ReapOnExit<'_> {
    fn drop(&mut self) {
        if let Err(error) = self.0.stop() {
            eprintln!("voice diarization helper cleanup: {error:#}");
        }
    }
}

/// Shared only with Workspace shutdown. Both normal completion and cancellation
/// reap the child before releasing the global CPU worker permit.
#[derive(Default)]
pub(crate) struct ProcessOwner(Mutex<Option<Child>>);

impl ProcessOwner {
    pub(crate) fn stop(&self) -> Result<()> {
        let mut slot = crate::lock_mutex(&self.0);
        let Some(child) = slot.as_mut() else {
            return Ok(());
        };
        if child.try_wait()?.is_none() {
            // A normal exit may race kill; always wait and verify the result.
            let killed = child.kill();
            if let Err(error) = killed {
                if child.try_wait()?.is_none() {
                    return Err(error).context("无法停止说话人分析进程");
                }
            }
            child.wait().context("无法回收说话人分析进程")?;
        }
        *slot = None;
        Ok(())
    }

    fn wait(&self, command: &mut Command, cancel: &AtomicBool) -> Result<ExitStatus> {
        {
            let mut slot = crate::lock_mutex(&self.0);
            if cancel.load(Ordering::Acquire) {
                return Err(Cancelled.into());
            }
            if slot.is_some() {
                bail!("说话人分析进程仍在运行");
            }
            // Child.stdin owns the parent's write end. Keep it in the slot
            // until completion/stop; an application crash closes it in the OS.
            *slot = Some(command.spawn().context("无法启动内置说话人分析进程")?);
        }
        loop {
            if cancel.load(Ordering::Acquire) {
                self.stop()?;
                return Err(Cancelled.into());
            }
            let status = {
                let mut slot = crate::lock_mutex(&self.0);
                let child = slot.as_mut().ok_or_else(|| anyhow!(Cancelled))?;
                let status = child.try_wait().context("无法等待说话人分析进程")?;
                if status.is_some() {
                    *slot = None;
                }
                status
            };
            if let Some(status) = status {
                return Ok(status);
            }
            std::thread::sleep(CANCEL_INTERVAL);
        }
    }
}

impl Drop for ProcessOwner {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            eprintln!("voice diarization helper cleanup: {error:#}");
        }
    }
}

fn configure(command: &mut Command) {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
}

pub(crate) fn analyze(
    workspace_root: &Path,
    cache_root: &Path,
    chunks: Vec<VoicePlaybackChunk>,
    cancel: &AtomicBool,
    owner: &ProcessOwner,
) -> Result<DiarizationAnalysis> {
    if cancel.load(Ordering::Acquire) {
        return Err(Cancelled.into());
    }
    let temporary = tempfile::Builder::new()
        .prefix("mind-voice-diarization-")
        .tempdir()?;
    let request = Request {
        workspace_root: workspace_root.into(),
        cache_root: cache_root.into(),
        chunks,
    };
    let bytes = serde_json::to_vec(&request)?;
    if bytes.len() as u64 > REQUEST_BYTES {
        bail!("说话人分析请求超出预算");
    }
    std::fs::write(temporary.path().join("request.json"), bytes)?;
    // Reuse the executable actually launched by Tauri in dev and the installed
    // executable in release. No sidecar path, script runtime or bundle lookup.
    let mut command = Command::new(std::env::current_exe()?);
    command.arg(HELPER_FLAG).arg(temporary.path());
    configure(&mut command);
    let _reap = ReapOnExit(owner);
    let status = owner.wait(&mut command, cancel);
    if status.is_err() {
        owner.stop()?;
    }
    let status = status?;
    if cancel.load(Ordering::Acquire) {
        return Err(Cancelled.into());
    }
    let response: Response = read_json(&temporary.path().join("response.json"), RESPONSE_BYTES)
        .with_context(|| format!("说话人分析进程未返回有效结果（{status}）"))?;
    match response {
        Response::Completed(analysis) if status.success() => Ok(analysis),
        Response::Failed(error) => bail!("{error}"),
        _ => bail!("说话人分析进程异常退出：{status}"),
    }
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path, budget: u64) -> Result<T> {
    let file = File::open(path)?;
    if file.metadata()?.len() > budget {
        bail!("说话人分析消息超出预算");
    }
    let mut bytes = Vec::new();
    file.take(budget + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > budget {
        bail!("说话人分析消息超出预算");
    }
    Ok(serde_json::from_slice(&bytes)?)
}

fn execute(directory: &Path) -> Result<()> {
    let request: Request = read_json(&directory.join("request.json"), REQUEST_BYTES)?;
    let result = (|| {
        let chunks =
            super::diarization_worker::authorize_audio(&request.workspace_root, request.chunks)?;
        // Exactly one complete timeline enters sherpa; pause epochs and all
        // source chunks retain their shared clustering and speaker identities.
        super::diarization::analyze_with_embeddings(
            &request.cache_root,
            &chunks,
            &AtomicBool::new(false),
        )
    })();
    let response = match result {
        Ok(analysis) => Response::Completed(analysis),
        Err(error) => Response::Failed(format!("{error:#}")),
    };
    let bytes = serde_json::to_vec(&response)?;
    if bytes.len() as u64 > RESPONSE_BYTES {
        bail!("说话人分析结果超出预算");
    }
    std::fs::write(directory.join("response.json"), bytes)?;
    Ok(())
}

/// Called by main before any application/window initialization.
#[doc(hidden)]
pub fn helper_main() -> Option<i32> {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    if arguments.first().map(|value| value.as_os_str()) != Some(std::ffi::OsStr::new(HELPER_FLAG)) {
        return None;
    }
    if arguments.len() == 2 {
        if let Err(error) = super::diarization_parent::watch_parent() {
            eprintln!("voice diarization parent pipe: {error}");
            return Some(1);
        }
    }
    helper_entry(arguments.into_iter())
}

fn helper_entry(mut arguments: impl Iterator<Item = std::ffi::OsString>) -> Option<i32> {
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new(HELPER_FLAG)) {
        return None;
    }
    let Some(directory) = arguments.next() else {
        return Some(2);
    };
    if arguments.next().is_some() {
        return Some(2);
    }
    Some(match execute(Path::new(&directory)) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("voice diarization helper: {error:#}");
            1
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE_DIRECTORY: &str = "PROJECT_MIND_DIARIZATION_PROCESS_TEST_DIRECTORY";
    const FIXTURE_MODE: &str = "PROJECT_MIND_DIARIZATION_PROCESS_TEST_MODE";

    // Invoked only in a child test executable; ordinary test runs return without
    // starting devices, models or a second application instance.
    #[test]
    fn helper_fixture() {
        let Some(directory) = std::env::var_os(FIXTURE_DIRECTORY) else {
            return;
        };
        let directory = PathBuf::from(directory);
        if std::env::var(FIXTURE_MODE).as_deref() == Ok("execute") {
            execute(&directory).unwrap();
            return;
        }
        std::fs::write(directory.join("started"), std::process::id().to_string()).unwrap();
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }

    fn fixture_command(directory: &Path, mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "voice::diarization_process::tests::helper_fixture",
                "--nocapture",
            ])
            .env(FIXTURE_DIRECTORY, directory)
            .env(FIXTURE_MODE, mode);
        configure(&mut command);
        command
    }

    struct StopAtExit<'a>(&'a ProcessOwner, &'a AtomicBool);
    impl Drop for StopAtExit<'_> {
        fn drop(&mut self) {
            self.1.store(true, Ordering::Release);
            self.0.stop().unwrap();
        }
    }

    #[test]
    fn workspace_cancel_kills_and_reaps_the_active_cpu_helper() {
        let directory = tempfile::tempdir().unwrap();
        let owner = ProcessOwner::default();
        let cancel = AtomicBool::new(false);
        let mut command = fixture_command(directory.path(), "wait");
        std::thread::scope(|scope| {
            let _cleanup = StopAtExit(&owner, &cancel);
            let waiting = scope.spawn(|| owner.wait(&mut command, &cancel));
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while !directory.path().join("started").exists() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "fixture process did not start"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            let started = std::time::Instant::now();
            cancel.store(true, Ordering::Release);
            owner.stop().unwrap(); // same synchronous close path as Workspace
            assert!(
                crate::lock_mutex(&owner.0).is_none(),
                "close must reap, not detach, the child"
            );
            assert!(waiting
                .join()
                .unwrap()
                .unwrap_err()
                .downcast_ref::<Cancelled>()
                .is_some());
            assert!(started.elapsed() < Duration::from_secs(2));
        });
    }

    #[test]
    fn child_protocol_passes_paths_and_returns_empty_analysis_without_a_model() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(
            directory
                .path()
                .join(super::super::storage::VOICE_ASSET_DIR),
        )
        .unwrap();
        let mut request = Request {
            workspace_root: directory.path().into(),
            cache_root: directory.path().into(),
            chunks: vec![VoicePlaybackChunk {
                source: "microphone".into(),
                epoch: 1,
                start_ms: 0,
                duration_ms: super::super::diarization::MAX_DURATION_MS,
                path: directory
                    .path()
                    .join(".project-mind/voice/audio.wav")
                    .to_string_lossy()
                    .into_owned(),
            }],
        };
        let bytes = serde_json::to_vec(&request).unwrap();
        assert!(
            bytes.len() < 4_096,
            "two-hour audio must remain path metadata in the parent"
        );
        request.chunks.clear();
        std::fs::write(
            directory.path().join("request.json"),
            serde_json::to_vec(&request).unwrap(),
        )
        .unwrap();
        let mut command = fixture_command(directory.path(), "execute");
        let owner = ProcessOwner::default();
        let status = owner.wait(&mut command, &AtomicBool::new(false)).unwrap();
        assert!(status.success());
        assert!(crate::lock_mutex(&owner.0).is_none());
        let response: Response =
            read_json(&directory.path().join("response.json"), RESPONSE_BYTES).unwrap();
        match response {
            Response::Completed(analysis) => {
                assert!(analysis.turns.is_empty());
                assert!(analysis.embeddings.is_empty());
            }
            Response::Failed(error) => panic!("{error}"),
        }
    }

    #[test]
    fn invalid_helper_invocation_never_falls_through_to_tauri() {
        use std::ffi::OsString;
        assert_eq!(
            helper_entry([OsString::from("--unrelated")].into_iter()),
            None
        );
        assert_eq!(
            helper_entry([OsString::from(HELPER_FLAG)].into_iter()),
            Some(2)
        );
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            helper_entry([OsString::from(HELPER_FLAG), root.path().as_os_str().into()].into_iter()),
            Some(1)
        );
    }
}
