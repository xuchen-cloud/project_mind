//! Executable receiver/transport cases. No external image hosts or credentials.
use super::*;
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[test]
fn url_and_ip_policy_cannot_reach_local_or_special_targets() {
    for url in [
        "file:///etc/passwd",
        "data:image/png,a",
        "/tmp/image.png",
        "http://@example.com/x",
        "https://u:p@example.com",
        "https://localhost./",
        "http://127.1/",
        "http://2130706433/",
        "http://0x7f000001/",
        "http://[::ffff:127.0.0.1]/",
        "http://169.254.169.254/",
        "http://198.18.0.1/",
        "https://example.com\\@localhost/",
        "https://example.com/\n",
    ] {
        assert!(image_url(url).is_err(), "accepted {url}");
    }
    assert!(image_url("https://example.com/signed?token=a@b#fragment")
        .unwrap()
        .fragment()
        .is_none());
    for ip in [
        "0.0.0.0",
        "10.0.0.1",
        "100.64.0.1",
        "127.0.0.1",
        "169.254.0.1",
        "172.31.255.255",
        "192.0.0.9",
        "192.0.2.1",
        "192.88.99.1",
        "192.168.1.1",
        "198.18.0.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "255.255.255.255",
        "::",
        "::1",
        "64:ff9b::808:808",
        "fc00::1",
        "fe80::1",
        "ff00::1",
        "2001::1",
        "2001:db8::1",
        "2002:808:808::1",
        "3fff::1",
        "::ffff:10.0.0.1",
    ] {
        assert!(!public_ip(ip.parse().unwrap()), "accepted {ip}");
    }
    for ip in [
        "1.1.1.1",
        "8.8.8.8",
        "100.63.255.255",
        "100.128.0.1",
        "172.15.255.255",
        "172.32.0.1",
        "198.17.255.255",
        "198.20.0.1",
        "2606:4700:4700::1111",
        "2001:4860:4860::8888",
        "::ffff:8.8.8.8",
    ] {
        assert!(public_ip(ip.parse().unwrap()), "blocked {ip}");
    }
}

#[test]
fn caller_and_input_contract_is_closed() {
    let local = tauri::Url::parse("tauri://localhost/").unwrap();
    for (label, window, url) in [
        ("main", "child", local.clone()),
        ("project-01", "project-01", local.clone()),
        ("print", "print", local.clone()),
        (
            "main",
            "main",
            tauri::Url::parse("https://example.com/").unwrap(),
        ),
    ] {
        assert!(authorize_identity(label, window, &url, None, false).is_err());
    }
    assert!(authorize_identity("project-2", "project-2", &local, None, false).is_ok());
    assert!(authorize_project("project-2", 3).is_err());
    assert!(serde_json::from_value::<FetchEditorRemoteImageInput>(
        serde_json::json!({"binding":{},"document":{},"url":"http://example.com","path":"/tmp/a"})
    )
    .is_err());
}

fn png() -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(2, 3)
        .write_to(&mut out, image::ImageFormat::Png)
        .unwrap();
    out.into_inner()
}
#[test]
fn real_image_bytes_mime_and_dimensions_are_required() {
    for (format, mime) in [
        (image::ImageFormat::Png, "image/png"),
        (image::ImageFormat::Jpeg, "image/jpeg"),
        (image::ImageFormat::Gif, "image/gif"),
    ] {
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 3)
            .write_to(&mut out, format)
            .unwrap();
        assert_eq!(raster(out.get_ref(), mime).unwrap(), mime);
        assert_eq!(
            STANDARD.decode(STANDARD.encode(out.get_ref())).unwrap(),
            *out.get_ref()
        );
    }
    assert!(raster(&png(), "image/jpeg").is_err());
    for bytes in [
        b"<html>not image</html>".as_slice(),
        b"<svg/>".as_slice(),
        b"\x89PNG\r\n\x1a\n".as_slice(),
    ] {
        assert!(raster(bytes, "image/png").is_err());
    }
    assert!(dimensions(16_385, 1).is_err());
    assert!(dimensions(8_000, 5_001).is_err());
    assert!(dimensions(0, 1).is_err());
    assert!(dimensions(8_000, 5_000).is_ok());
}

#[derive(Clone)]
struct Dns {
    answers: Vec<IpAddr>,
    calls: Arc<Mutex<Vec<String>>>,
}
impl Resolver for Dns {
    async fn lookup(&self, host: &str, _port: u16) -> RemoteResult<Vec<IpAddr>> {
        self.calls.lock().unwrap().push(host.into());
        Ok(self.answers.clone())
    }
}
async fn server(
    responses: Vec<Vec<u8>>,
    delay: Duration,
) -> (
    SocketAddr,
    Arc<Mutex<Vec<String>>>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let task = tokio::spawn(async move {
        for response in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut part = [0; 1024];
                let n = socket.read(&mut part).await.unwrap();
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&part[..n]);
                if request.windows(4).any(|s| s == b"\r\n\r\n") {
                    break;
                }
            }
            seen.lock()
                .unwrap()
                .push(String::from_utf8(request).unwrap());
            tokio::time::sleep(delay).await;
            let _ = socket.write_all(&response).await;
        }
    });
    (addr, requests, task)
}
fn response(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
    [
        format!(
            "HTTP/1.1 {status}\r\nConnection: close\r\n{headers}Content-Length: {}\r\n\r\n",
            body.len()
        )
        .as_bytes(),
        body,
    ]
    .concat()
}
fn downloader(addr: SocketAddr) -> Downloader<Dns> {
    Downloader {
        owner: Arc::new(Arc::new(Semaphore::new(1)).try_acquire_owned().unwrap()),
        resolver: Dns {
            answers: vec!["8.8.8.8".parse().unwrap()],
            calls: Arc::new(Mutex::new(Vec::new())),
        },
        limits: Limits::default(),
        connect: Some(addr),
    }
}

#[tokio::test]
async fn actual_http_is_pinned_per_hop_without_cookies_credentials_or_retry() {
    let bytes = png();
    let (addr, seen, task) = server(
        vec![
            response(
                "302 Found",
                "Location: /final\r\nSet-Cookie: secret=hidden\r\n",
                b"",
            ),
            response("200 OK", "Content-Type: image/png\r\n", &bytes),
        ],
        Duration::ZERO,
    )
    .await;
    let client = downloader(addr);
    let image = client
        .download("http://images.test/start", || Ok(()))
        .await
        .unwrap();
    task.await.unwrap();
    assert_eq!(STANDARD.decode(image.base64).unwrap(), bytes);
    assert_eq!(
        *client.resolver.calls.lock().unwrap(),
        vec!["images.test", "images.test"]
    );
    let requests = seen.lock().unwrap();
    assert_eq!(requests.len(), 2);
    for request in requests.iter() {
        let lower = request.to_lowercase();
        assert!(lower.contains("host: images.test\r\n"));
        for denied in [
            "cookie:",
            "authorization:",
            "proxy-authorization:",
            "referer:",
            "range:",
        ] {
            assert!(!lower.contains(denied), "{lower}");
        }
        assert!(lower.contains("accept-encoding: identity\r\n"));
    }
    drop(requests);
    let (addr, seen, task) = server(
        vec![response(
            "500 Internal Server Error",
            "",
            b"secret remote body",
        )],
        Duration::ZERO,
    )
    .await;
    let error = downloader(addr)
        .download("http://images.test/", || Ok(()))
        .await
        .unwrap_err();
    task.await.unwrap();
    assert_eq!(error.code, "http_status");
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert!(!error.message.contains("secret"));
}

#[tokio::test]
async fn redirect_and_mixed_dns_are_rejected_before_next_socket() {
    let (addr, seen, task) = server(
        vec![response(
            "302 Found",
            "Location: http://127.0.0.1/private\r\n",
            b"",
        )],
        Duration::ZERO,
    )
    .await;
    let client = downloader(addr);
    assert!(client
        .download("http://images.test/", || Ok(()))
        .await
        .is_err());
    task.await.unwrap();
    assert_eq!(seen.lock().unwrap().len(), 1);
    let mut client = downloader(addr);
    client.resolver.answers.push("127.0.0.1".parse().unwrap());
    assert_eq!(
        client
            .download("http://images.test/", || Ok(()))
            .await
            .unwrap_err()
            .code,
        "blocked_target"
    );
    let (addr, seen, task) = server(
        (0..6)
            .map(|_| response("302 Found", "Location: /again\r\n", b""))
            .collect(),
        Duration::ZERO,
    )
    .await;
    assert_eq!(
        downloader(addr)
            .download("http://images.test/", || Ok(()))
            .await
            .unwrap_err()
            .code,
        "redirect_limit"
    );
    task.await.unwrap();
    assert_eq!(seen.lock().unwrap().len(), 6);
}

#[tokio::test]
async fn streaming_cap_and_total_deadline_are_real() {
    let bytes = png();
    let len = bytes.len();
    for (extra, expected) in [(0, None), (1, Some("image_budget"))] {
        let mut body = bytes.clone();
        body.extend(std::iter::repeat_n(0, extra));
        let chunked=[format!("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: image/png\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n",body.len()).into_bytes(),body,b"\r\n0\r\n\r\n".to_vec()].concat();
        let (addr, _, task) = server(vec![chunked], Duration::ZERO).await;
        let mut client = downloader(addr);
        client.limits.bytes = len;
        let result = client.download("http://images.test/", || Ok(())).await;
        task.await.unwrap();
        if let Some(code) = expected {
            assert_eq!(result.unwrap_err().code, code)
        } else {
            assert!(result.is_ok())
        }
    }
    let (addr, _, task) = server(
        vec![
            response("302 Found", "Location: /again\r\n", b""),
            response("200 OK", "Content-Type: image/png\r\n", &bytes),
        ],
        Duration::from_millis(70),
    )
    .await;
    let result = tokio::time::timeout(
        Duration::from_millis(110),
        downloader(addr).download("http://images.test/", || Ok(())),
    )
    .await;
    assert!(result.is_err());
    task.abort();
}

#[test]
fn actual_file_stream_stops_when_it_grows_past_budget() {
    struct Growing {
        read: u64,
    }
    impl Read for Growing {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            buf.fill(42);
            self.read += buf.len() as u64;
            Ok(buf.len())
        }
    }
    let mut input = Growing { read: 0 };
    assert_eq!(
        bounded_hash(&mut input, 100_000).unwrap_err().code,
        "document_budget"
    );
    assert_eq!(
        input.read, 100_001,
        "only one probe byte beyond the actual budget"
    );
    assert_eq!(
        bounded_hash(&mut std::io::Cursor::new(b"abc"), 3).unwrap(),
        "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn real_file_growth_after_metadata_precheck_cannot_bypass_stream_budget() {
    use std::io::{Seek, Write};
    let mut file = tempfile::tempfile().unwrap();
    file.write_all(b"abc").unwrap();
    assert_eq!(file.metadata().unwrap().len(), 3);
    // Grow after the metadata precheck, as a concurrent writer can do.
    file.write_all(b"d").unwrap();
    file.rewind().unwrap();
    assert_eq!(
        bounded_hash(&mut file, 3).unwrap_err().code,
        "document_budget"
    );
    assert_eq!(file.stream_position().unwrap(), 4);
}

#[tokio::test]
async fn timeout_and_cancellation_keep_single_slot_until_real_disk_io_ends() {
    for cancel in [false, true] {
        let semaphore = Arc::new(Semaphore::new(1));
        let owner = Arc::new(semaphore.clone().try_acquire_owned().unwrap());
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let reached_network = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let network = reached_network.clone();
        let wait = tokio::spawn(async move {
            disk_job(owner, move || {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
            .await
            .unwrap();
            network.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        started_rx.await.unwrap();
        // Abort the waiting IPC future, or emulate the timeout wrapper dropping
        // it; neither can abort spawn_blocking's actual hash/verify worker.
        if cancel {
            wait.abort();
        } else {
            let mut wait = wait;
            assert!(tokio::time::timeout(Duration::from_millis(5), &mut wait)
                .await
                .is_err());
            wait.abort();
        }
        let stayed_busy = semaphore.clone().try_acquire_owned().is_err();
        release_tx.send(()).unwrap();
        assert!(stayed_busy, "disk worker lost its slot at cancellation");
        let _permit = tokio::time::timeout(Duration::from_secs(1), semaphore.acquire())
            .await
            .unwrap()
            .unwrap();
        assert!(
            !reached_network.load(std::sync::atomic::Ordering::SeqCst),
            "cancelled I/O continued into network"
        );
    }
}

mod document;
