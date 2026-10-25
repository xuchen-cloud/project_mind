//! One fixed, opt-in speaker-model download. No audio leaves the device.
use super::diarization_model;
use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInstallStatus {
    pub phase: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub error: Option<String>,
}

#[derive(Clone)]
struct Source {
    name: String,
    url: String,
    sha256: String,
    bytes: u64,
}

fn sources() -> Vec<Source> {
    let urls = [
        "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/9403a6902bb58e3d5ae8c7e77c3422de279db2e0/model.onnx",
        "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/9403a6902bb58e3d5ae8c7e77c3422de279db2e0/LICENSE",
        "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/0743f301363dec56491a490f6d6cbc9d67f9a3bf/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
        "https://raw.githubusercontent.com/modelscope/3D-Speaker/065629c313eaf1a01c65c640c46d77e61e9607b4/LICENSE",
    ];
    diarization_model::FILES
        .iter()
        .zip(diarization_model::FILE_SIZES)
        .zip(urls)
        .map(|(((name, hash), bytes), url)| Source {
            name: (*name).into(),
            url: url.into(),
            sha256: (*hash).into(),
            bytes,
        })
        .collect()
}

struct State {
    status: ModelInstallStatus,
    running: bool,
}
#[derive(Clone)]
struct Installer {
    state: Arc<Mutex<State>>,
}
#[derive(Clone, Copy)]
struct Hooks {
    ready: fn(&Path) -> bool,
    activate: fn(&Path, &Path, &[Source]) -> Result<()>,
    https_only: bool,
    request_timeout: Duration,
}

impl Installer {
    fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                running: false,
                status: ModelInstallStatus {
                    phase: "idle".into(),
                    downloaded_bytes: 0,
                    total_bytes: 0,
                    error: None,
                },
            })),
        }
    }
    fn snapshot(&self) -> ModelInstallStatus {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .status
            .clone()
    }
    fn update(&self, action: impl FnOnce(&mut ModelInstallStatus)) {
        action(
            &mut self
                .state
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .status,
        );
    }
    fn start(
        &self,
        cache_root: PathBuf,
        sources: Vec<Source>,
        hooks: Hooks,
    ) -> Result<ModelInstallStatus> {
        let initial = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            if state.running {
                return Ok(state.status.clone());
            }
            state.running = true;
            state.status = ModelInstallStatus {
                phase: "downloading".into(),
                downloaded_bytes: 0,
                total_bytes: sources.iter().map(|source| source.bytes).sum(),
                error: None,
            };
            state.status.clone()
        };
        let worker = self.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("voice-model-install".into())
            .spawn(move || {
                let outcome = worker.install(&cache_root, &sources, hooks);
                let mut state = worker
                    .state
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                state.running = false;
                match outcome {
                    Ok(()) => {
                        state.status.phase = "ready".into();
                        state.status.downloaded_bytes = state.status.total_bytes;
                        state.status.error = None;
                    }
                    Err(error) => {
                        state.status.phase = "failed".into();
                        state.status.error = Some(format!(
                            "说话人模型准备失败：{error:#}。请检查网络或磁盘空间后重试"
                        ));
                    }
                }
            })
        {
            let message = format!("无法启动模型下载任务：{error}");
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            state.running = false;
            state.status.phase = "failed".into();
            state.status.error = Some(message.clone());
            return Err(anyhow!(message));
        }
        Ok(initial)
    }

    fn install(&self, cache_root: &Path, sources: &[Source], hooks: Hooks) -> Result<()> {
        if (hooks.ready)(cache_root) {
            return Ok(());
        }
        let parent = cache_root.join("voice-models");
        fs::create_dir_all(&parent).context("无法创建模型缓存目录")?;
        let stage = tempfile::Builder::new()
            .prefix("speaker-download-")
            .tempdir_in(&parent)
            .context("无法创建模型下载临时目录")?;
        let result = (|| -> Result<()> {
            // Keep TLS verification and reqwest's system-proxy discovery enabled.
            // A 30-minute response deadline supports the observed ~40 KiB/s HF
            // connection for the 39.6 MB embedding; four files bound the job.
            let builder = reqwest::blocking::Client::builder()
                .https_only(hooks.https_only)
                .connect_timeout(Duration::from_secs(20))
                .timeout(hooks.request_timeout)
                .redirect(reqwest::redirect::Policy::limited(5));
            // Loopback test traffic is deterministic and must bypass machine proxies.
            let builder = if hooks.https_only {
                builder
            } else {
                builder.no_proxy()
            };
            let client = builder
                .build()
                .map_err(|_| anyhow!("无法初始化安全下载连接"))?;
            let mut hashes = Vec::new();
            let mut total = 0u64;
            for source in sources {
                // Blocking ClientBuilder's timeout bounds individual Read calls.
                // RequestBuilder also carries the deadline into the async body,
                // so a continuously arriving slow response cannot run indefinitely.
                let mut response = client
                    .get(&source.url)
                    .timeout(hooks.request_timeout)
                    .send()
                    .map_err(|error| {
                        if error.is_timeout() {
                            anyhow!("下载 {} 超时", source.name)
                        } else if error.is_connect() {
                            anyhow!("无法连接模型下载站点，请检查系统代理或网络")
                        } else {
                            anyhow!("无法下载 {}，安全连接或重定向失败", source.name)
                        }
                    })?;
                if !response.status().is_success() {
                    bail!(
                        "下载 {} 失败（HTTP {}）",
                        source.name,
                        response.status().as_u16()
                    );
                }
                if response
                    .content_length()
                    .is_some_and(|length| length != source.bytes)
                {
                    bail!("模型文件 {} 的下载大小不匹配", source.name);
                }
                let mut file = File::create(stage.path().join(&source.name))
                    .with_context(|| format!("无法写入模型文件 {}", source.name))?;
                let mut count = 0u64;
                let mut hash = Sha256::new();
                let mut buffer = [0u8; 64 * 1024];
                loop {
                    let n = response
                        .read(&mut buffer)
                        .map_err(|_| anyhow!("下载 {} 中断或超时", source.name))?;
                    if n == 0 {
                        break;
                    }
                    count += n as u64;
                    if count > source.bytes {
                        bail!("模型文件 {} 超出固定大小限制", source.name);
                    }
                    file.write_all(&buffer[..n])
                        .with_context(|| format!("写入模型文件 {} 失败", source.name))?;
                    hash.update(&buffer[..n]);
                    total += n as u64;
                    self.update(|status| status.downloaded_bytes = total);
                }
                if count != source.bytes {
                    bail!("模型文件 {} 下载不完整", source.name);
                }
                file.sync_all()
                    .with_context(|| format!("保存模型文件 {} 失败", source.name))?;
                hashes.push(format!("{:x}", hash.finalize()));
            }
            self.update(|status| status.phase = "verifying".into());
            for (source, actual) in sources.iter().zip(hashes) {
                if actual != source.sha256 {
                    bail!("模型文件 {} 校验失败，请重新下载", source.name);
                }
            }
            (hooks.activate)(stage.path(), cache_root, sources).context("无法激活已校验模型")
        })();
        let cleanup = stage.close().context("无法清理模型下载临时文件");
        match (result, cleanup) {
            (Ok(()), cleanup) => cleanup,
            (Err(error), Ok(())) => Err(error),
            (Err(error), Err(cleanup)) => {
                Err(error.context(format!("下载失败且临时文件清理失败：{cleanup:#}")))
            }
        }
    }
}

fn installer() -> &'static Installer {
    static INSTALLER: OnceLock<Installer> = OnceLock::new();
    INSTALLER.get_or_init(Installer::new)
}
pub fn snapshot() -> ModelInstallStatus {
    installer().snapshot()
}
pub fn start(cache_root: PathBuf) -> Result<ModelInstallStatus> {
    installer().start(
        cache_root,
        sources(),
        Hooks {
            ready: |root| diarization_model::status(root).ready,
            activate: |source, root, _| diarization_model::import(source, root).map(|_| ()),
            https_only: true,
            request_timeout: Duration::from_secs(30 * 60),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::BTreeMap,
        net::TcpListener,
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
        thread::{self, JoinHandle},
        time::Instant,
    };

    fn temporary() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }
    fn fixtures() -> Vec<(String, Vec<u8>)> {
        (0..4)
            .map(|i| (format!("file{i}.bin"), vec![b'a' + i; 32 * 1024]))
            .collect()
    }
    fn fixture_ready(root: &Path) -> bool {
        fixtures().into_iter().all(|(name, bytes)| {
            fs::read(root.join("voice-models/install-test").join(name))
                .ok()
                .as_ref()
                == Some(&bytes)
        })
    }
    fn activate(source: &Path, root: &Path, sources: &[Source]) -> Result<()> {
        let files = sources
            .iter()
            .map(|file| (file.name.as_str(), file.sha256.as_str()))
            .collect::<Vec<_>>();
        diarization_model::import_install_fixture(source, root, &files)
    }
    fn hooks() -> Hooks {
        Hooks {
            ready: fixture_ready,
            activate,
            https_only: false,
            request_timeout: Duration::from_secs(30 * 60),
        }
    }
    fn finish(installer: &Installer) -> ModelInstallStatus {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let state = installer.snapshot();
            if matches!(state.phase.as_str(), "ready" | "failed") {
                return state;
            }
            assert!(
                Instant::now() < deadline,
                "download did not finish: {state:?}"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }
    struct Server {
        base: String,
        hits: Arc<AtomicUsize>,
        fail: Arc<AtomicUsize>,
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }
    impl Server {
        fn new(files: Vec<(String, Vec<u8>)>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            listener.set_nonblocking(true).unwrap();
            let files = files.into_iter().collect::<BTreeMap<_, _>>();
            let hits = Arc::new(AtomicUsize::new(0));
            let fail = Arc::new(AtomicUsize::new(0));
            let stop = Arc::new(AtomicBool::new(false));
            let (server_hits, server_fail, server_stop) =
                (hits.clone(), fail.clone(), stop.clone());
            let task = thread::spawn(move || {
                while !server_stop.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            stream.set_nonblocking(false).unwrap();
                            stream
                                .set_read_timeout(Some(Duration::from_secs(2)))
                                .unwrap();
                            let mut request = [0u8; 4096];
                            let n = stream.read(&mut request).unwrap();
                            let request = String::from_utf8_lossy(&request[..n]);
                            let name = request
                                .split_whitespace()
                                .nth(1)
                                .unwrap()
                                .trim_start_matches('/');
                            let request_number = server_hits.fetch_add(1, Ordering::AcqRel) + 1;
                            if server_fail.load(Ordering::Acquire) == request_number {
                                let _=stream.write_all(b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                                continue;
                            }
                            let body = &files[name];
                            let header=format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
                            if stream.write_all(header.as_bytes()).is_err() {
                                continue;
                            }
                            for chunk in body.chunks(1024) {
                                if stream.write_all(chunk).is_err() {
                                    break;
                                }
                                thread::sleep(Duration::from_millis(2));
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(2))
                        }
                        Err(error) => panic!("loopback server: {error}"),
                    }
                }
            });
            Self {
                base,
                hits,
                fail,
                stop,
                thread: Some(task),
            }
        }
        fn sources(&self, files: &[(String, Vec<u8>)]) -> Vec<Source> {
            files
                .iter()
                .map(|(name, body)| Source {
                    name: name.clone(),
                    url: format!("{}/{}", self.base, name),
                    sha256: format!("{:x}", Sha256::digest(body)),
                    bytes: body.len() as u64,
                })
                .collect()
        }
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            self.thread.take().unwrap().join().unwrap();
        }
    }

    #[test]
    fn http_installs_all_files_reports_progress_and_reuses_cache() {
        let files = fixtures();
        let server = Server::new(files.clone());
        let installer = Installer::new();
        let cache = temporary();
        assert_eq!(installer.snapshot().phase, "idle");
        let started = installer
            .start(cache.path().into(), server.sources(&files), hooks())
            .unwrap();
        assert_eq!(started.phase, "downloading");
        assert_eq!(started.total_bytes, 131072);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let status = installer.snapshot();
            if status.downloaded_bytes > 0 && status.downloaded_bytes < status.total_bytes {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "no intermediate byte progress: {status:?}"
            );
            thread::sleep(Duration::from_millis(2));
        }
        installer
            .start(cache.path().into(), server.sources(&files), hooks())
            .unwrap();
        let done = finish(&installer);
        assert_eq!(done.phase, "ready", "{done:?}");
        assert_eq!(done.downloaded_bytes, 131072);
        assert_eq!(server.hits.load(Ordering::Acquire), 4);
        fs::write(
            cache.path().join("voice-models/install-test/file0.bin"),
            b"corrupt",
        )
        .unwrap();
        installer
            .start(cache.path().into(), server.sources(&files), hooks())
            .unwrap();
        assert_eq!(finish(&installer).phase, "ready");
        assert_eq!(
            server.hits.load(Ordering::Acquire),
            8,
            "a new start must recheck a previously ready cache"
        );
        for (name, bytes) in &files {
            assert_eq!(
                &fs::read(cache.path().join("voice-models/install-test").join(name)).unwrap(),
                bytes
            );
        }
        installer
            .start(cache.path().into(), server.sources(&files), hooks())
            .unwrap();
        assert_eq!(finish(&installer).phase, "ready");
        assert_eq!(server.hits.load(Ordering::Acquire), 8);
        assert_eq!(
            fs::read_dir(cache.path().join("voice-models"))
                .unwrap()
                .count(),
            1
        );
    }
    #[test]
    fn failed_http_is_explicit_does_not_activate_and_manual_retry_succeeds() {
        let files = fixtures();
        let server = Server::new(files.clone());
        let installer = Installer::new();
        let cache = temporary();
        server.fail.store(2, Ordering::Release);
        installer
            .start(cache.path().into(), server.sources(&files), hooks())
            .unwrap();
        let failed = finish(&installer);
        assert_eq!(failed.phase, "failed");
        assert!(failed.error.unwrap().contains("HTTP 503"));
        assert!(!fixture_ready(cache.path()));
        assert_eq!(
            fs::read_dir(cache.path().join("voice-models"))
                .unwrap()
                .count(),
            0
        );
        installer
            .start(cache.path().into(), server.sources(&files), hooks())
            .unwrap();
        assert_eq!(finish(&installer).phase, "ready");
        assert_eq!(server.hits.load(Ordering::Acquire), 6);
    }
    #[test]
    fn bad_hash_preserves_existing_cache_and_removes_download_stage() {
        let files = fixtures();
        let server = Server::new(files.clone());
        let installer = Installer::new();
        let cache = temporary();
        let old = cache.path().join("voice-models/install-test");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("old-model"), b"keep").unwrap();
        let mut sources = server.sources(&files);
        sources[2].sha256 = "bad".into();
        installer
            .start(cache.path().into(), sources, hooks())
            .unwrap();
        let failed = finish(&installer);
        assert_eq!(failed.phase, "failed");
        assert!(failed.error.unwrap().contains("校验失败"));
        assert_eq!(fs::read(old.join("old-model")).unwrap(), b"keep");
        assert_eq!(
            fs::read_dir(cache.path().join("voice-models"))
                .unwrap()
                .count(),
            1
        );
    }
    #[test]
    fn oversized_response_is_rejected_before_activation() {
        let files = fixtures();
        let server = Server::new(files.clone());
        let installer = Installer::new();
        let cache = temporary();
        let mut sources = server.sources(&files);
        sources[0].bytes -= 1;
        installer
            .start(cache.path().into(), sources, hooks())
            .unwrap();
        let failed = finish(&installer);
        assert_eq!(failed.phase, "failed");
        assert!(failed.error.unwrap().contains("大小"));
        assert!(!fixture_ready(cache.path()));
    }
    #[test]
    fn total_deadline_stops_continuous_slow_body_and_cleans_stage() {
        let files = (0..4)
            .map(|i| (format!("file{i}.bin"), vec![b'a' + i; 128 * 1024]))
            .collect::<Vec<_>>();
        let server = Server::new(files.clone());
        let installer = Installer::new();
        let cache = temporary();
        let started = Instant::now();
        installer
            .start(
                cache.path().into(),
                server.sources(&files),
                Hooks {
                    request_timeout: Duration::from_millis(150),
                    ..hooks()
                },
            )
            .unwrap();
        let status = finish(&installer);
        assert_eq!(
            status.phase, "failed",
            "continuous 2ms chunks must hit the total deadline"
        );
        assert!(
            status.downloaded_bytes > 0 && status.downloaded_bytes < 128 * 1024,
            "the deadline must interrupt an active body: {status:?}"
        );
        assert!(started.elapsed() < Duration::from_millis(900));
        assert_eq!(server.hits.load(Ordering::Acquire), 1);
        assert!(!fixture_ready(cache.path()));
        assert_eq!(
            fs::read_dir(cache.path().join("voice-models"))
                .unwrap()
                .count(),
            0
        );
    }
    #[test]
    #[ignore = "downloads the complete pinned HTTPS package; set TEMP/TMP to a test volume with sufficient free space"]
    fn real_pinned_https_install() {
        let cache = temporary();
        let installer = Installer::new();
        installer
            .start(
                cache.path().into(),
                sources(),
                Hooks {
                    ready: |root| diarization_model::status(root).ready,
                    activate: |source, root, _| diarization_model::import(source, root).map(|_| ()),
                    https_only: true,
                    request_timeout: Duration::from_secs(30 * 60),
                },
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(125 * 60);
        loop {
            let state = installer.snapshot();
            if matches!(state.phase.as_str(), "ready" | "failed") {
                assert_eq!(state.phase, "ready", "{state:?}");
                break;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(50));
        }
        assert!(diarization_model::status(cache.path()).ready);
    }
}
