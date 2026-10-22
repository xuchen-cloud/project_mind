use super::*;
use reqwest::{redirect::Policy, Client};
use std::sync::atomic::AtomicUsize;

fn client() -> Client {
    Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .build()
        .unwrap()
}

async fn authenticate(client: &Client, site: &HtmlSite) -> String {
    let response = client.get(site.bootstrap_url()).send().await.unwrap();
    assert_eq!(response.status(), 303);
    assert_eq!(response.headers()["referrer-policy"], "no-referrer");
    let cookie = response.headers()["set-cookie"].to_str().unwrap();
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("SameSite=Strict"));
    assert!(cookie.contains("Path=/"));
    assert_eq!(
        response.headers()["location"],
        reqwest::Url::parse(site.root_url()).unwrap().path()
    );
    cookie.split(';').next().unwrap().to_string()
}

async fn fixture(read: AssetReader, validate: Validator) -> HtmlSite {
    HtmlSite::start(
        "首页 test.html".into(),
        b"<script>window.raw = '<&>';</script>\0".to_vec(),
        read,
        validate,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn authentication_assets_query_head_and_fixed_cache() {
    fn send_sync<T: Send + Sync>() {}
    send_sync::<HtmlSite>();
    let calls = Arc::new(AtomicUsize::new(0));
    let reads = calls.clone();
    let site = fixture(
        Arc::new(move |name| {
            reads.fetch_add(1, Ordering::SeqCst);
            let (mime, bytes): (&str, &[u8]) = match name {
                "style.css" => ("text/css", b"body {color:red}"),
                "js/module.js" => ("text/javascript", b"export const x=1"),
                "img/a.png" => ("image/png", b"\x89PNG\r\n"),
                "sub/index.html" => ("text/html", b"<a href='../'>up</a>"),
                "中文 空格.txt" => ("text/plain", b"unicode"),
                _ => return Err("/private/workspace/missing".into()),
            };
            Ok((mime.into(), bytes.to_vec()))
        }),
        Arc::new(|| Ok(())),
    )
    .await;
    let client = client();
    assert_eq!(
        client.get(site.root_url()).send().await.unwrap().status(),
        403
    );
    let cookie = authenticate(&client, &site).await;
    let root = client
        .get(site.root_url())
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(root.headers()["content-type"], "text/html");
    assert!(root.headers().get("access-control-allow-origin").is_none());
    assert_eq!(
        root.bytes().await.unwrap().as_ref(),
        b"<script>window.raw = '<&>';</script>\0"
    );
    for (path, mime, expected) in [
        ("/style.css?v=1", "text/css", &b"body {color:red}"[..]),
        ("/js/module.js", "text/javascript", &b"export const x=1"[..]),
        ("/img/a.png", "image/png", &b"\x89PNG\r\n"[..]),
        ("/sub/", "text/html", &b"<a href='../'>up</a>"[..]),
        (
            "/%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC.txt",
            "text/plain",
            &b"unicode"[..],
        ),
    ] {
        let url = format!("{}{}", site.state.origin, path);
        let response = client
            .get(&url)
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200, "{path}");
        assert_eq!(response.headers()["content-type"], mime);
        assert_eq!(response.bytes().await.unwrap().as_ref(), expected);
        let response = client
            .head(&url)
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers()["content-length"].to_str().unwrap(),
            expected.len().to_string()
        );
        assert!(response.bytes().await.unwrap().is_empty());
    }
    assert_eq!(calls.load(Ordering::SeqCst), 5);
    let response = client
        .get(format!("{}/style.css?v=2", site.state.origin))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(calls.load(Ordering::SeqCst), 5);
}

#[tokio::test]
async fn host_origin_methods_and_session_isolation() {
    let site = fixture(Arc::new(|_| unreachable!()), Arc::new(|| Ok(()))).await;
    let other = fixture(Arc::new(|_| unreachable!()), Arc::new(|| Ok(()))).await;
    assert_ne!(site.state.origin, other.state.origin);
    let client = client();
    let cookie = authenticate(&client, &site).await;
    for (name, value) in [
        ("Host", "localhost:1"),
        ("Origin", "http://evil.test"),
        ("Sec-Fetch-Site", "cross-site"),
        ("Sec-Fetch-Site", "same-site"),
    ] {
        let response = client
            .get(site.root_url())
            .header("Cookie", &cookie)
            .header(name, value)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 403, "{name}: {value}");
        assert_eq!(response.headers()["referrer-policy"], "no-referrer");
    }
    assert_eq!(
        client
            .get(site.root_url())
            .header("Cookie", &cookie)
            .header("Origin", &site.state.origin)
            .header("Sec-Fetch-Site", "same-origin")
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        client
            .get(other.root_url())
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        client
            .post(site.root_url())
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap()
            .status(),
        405
    );
}

// Raw requests preserve traversal segments that URL clients otherwise normalize.
async fn raw(site: &HtmlSite, path: &str, cookie: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(&site.state.authority)
        .await
        .unwrap();
    stream
        .write_all(
            format!(
                "GET {path} HTTP/1.1\r\nHost: {}\r\nCookie: {cookie}\r\nConnection: close\r\n\r\n",
                site.state.authority
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).await.unwrap();
    String::from_utf8(bytes).unwrap()
}

#[tokio::test]
async fn rejects_windows_traversal_and_double_decoding() {
    let site = fixture(
        Arc::new(|_| panic!("unsafe path reached reader")),
        Arc::new(|| Ok(())),
    )
    .await;
    let client = client();
    let cookie = authenticate(&client, &site).await;
    for path in [
        "/../x",
        "/%2e%2e/x",
        "/%252e%252e/x",
        "/a%5cb",
        "/C%3a/x",
        "//server/share",
        "/file%3astream",
        "/a%00b",
        "/a%1fb",
        "/file.",
        "/file%20",
        "/%2Fserver/x",
        "/.internal/x",
        "/a/%2e/x",
        "/broken%zz",
    ] {
        let response = raw(&site, path, &cookie).await;
        assert!(response.starts_with("HTTP/1.1 400"), "{path}: {response}");
    }
}

#[tokio::test]
async fn validation_revokes_cached_root_and_diagnostics_are_bounded_and_private() {
    let valid = Arc::new(AtomicBool::new(true));
    let flag = valid.clone();
    let site = fixture(
        Arc::new(|_| Err("historical dependency missing at /Users/private/workspace".into())),
        Arc::new(move || {
            if flag.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err("/private/binding".into())
            }
        }),
    )
    .await;
    let client = client();
    let cookie = authenticate(&client, &site).await;
    for n in 0..40 {
        let response = client
            .get(format!("{}/missing-{n}.js", site.state.origin))
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 404);
        assert!(!response.text().await.unwrap().contains("private"));
    }
    let diagnostics = site.diagnostics();
    assert!(!diagnostics.is_empty());
    assert!(diagnostics.len() <= 32);
    assert!(diagnostics
        .iter()
        .all(|d| d.len() <= 256 && !d.contains("private")));
    valid.store(false, Ordering::SeqCst);
    let response = client
        .get(site.root_url())
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    assert!(!response.text().await.unwrap().contains("private"));
}

#[tokio::test]
async fn resource_count_and_byte_budgets_include_root() {
    let site = fixture(
        Arc::new(|_| Ok(("text/plain".into(), vec![1]))),
        Arc::new(|| Ok(())),
    )
    .await;
    let client = client();
    let cookie = authenticate(&client, &site).await;
    for n in 0..63 {
        assert_eq!(
            client
                .get(format!("{}/{n}", site.state.origin))
                .header("Cookie", &cookie)
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
    }
    assert_eq!(
        client
            .get(format!("{}/overflow", site.state.origin))
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap()
            .status(),
        413
    );
    let site = fixture(
        Arc::new(|_| Ok(("application/octet-stream".into(), vec![0; 16 * 1024 * 1024]))),
        Arc::new(|| Ok(())),
    )
    .await;
    let cookie = authenticate(&client, &site).await;
    assert_eq!(
        client
            .get(format!("{}/a", site.state.origin))
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        client
            .get(format!("{}/b", site.state.origin))
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap()
            .status(),
        413
    );
    assert!(HtmlSite::start(
        "index.html".into(),
        vec![0; 10 * 1024 * 1024 + 1],
        Arc::new(|_| unreachable!()),
        Arc::new(|| Ok(()))
    )
    .await
    .is_err());
}

#[tokio::test]
async fn close_discards_late_reader_and_stops_listener() {
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let started = std::sync::Mutex::new(Some(started_tx));
    let release = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
    let worker_release = release.clone();
    let site = Arc::new(
        fixture(
            Arc::new(move |_| {
                if let Some(tx) = started.lock().unwrap().take() {
                    let _ = tx.send(());
                }
                let (lock, wake) = &*worker_release;
                let mut ready = lock.lock().unwrap();
                while !*ready {
                    ready = wake.wait(ready).unwrap();
                }
                Ok(("text/plain".into(), b"LATE PRIVATE DATA".to_vec()))
            }),
            Arc::new(|| Ok(())),
        )
        .await,
    );
    let client = client();
    let cookie = authenticate(&client, &site).await;
    let request = client
        .get(format!("{}/late", site.state.origin))
        .header("Cookie", &cookie)
        .send();
    let pending = tokio::spawn(request);
    started_rx.await.unwrap();
    site.close();
    *release.0.lock().unwrap() = true;
    release.1.notify_all();
    if let Ok(response) = pending.await.unwrap() {
        assert_ne!(response.status(), 200);
        assert!(!response
            .text()
            .await
            .unwrap_or_default()
            .contains("LATE PRIVATE DATA"));
    }
    tokio::task::yield_now().await;
    if let Ok(response) = client
        .get(site.root_url())
        .header("Cookie", cookie)
        .send()
        .await
    {
        assert_ne!(response.status(), 200);
    }
}

#[tokio::test]
async fn worker_slots_bound_requests_and_survive_response_timeout() {
    let (started, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
    let release = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
    let worker_release = release.clone();
    // Blocking in validation exercises all slots independently of cache locking.
    let site = fixture(
        Arc::new(|_| unreachable!()),
        Arc::new(move || {
            let _ = started.send(());
            let (lock, wake) = &*worker_release;
            let mut ready = lock.lock().unwrap();
            while !*ready {
                ready = wake.wait(ready).unwrap();
            }
            Ok(())
        }),
    )
    .await;
    let client = client();
    let mut requests = Vec::new();
    for _ in 0..MAX_WORKERS {
        requests.push(tokio::spawn(client.get(site.bootstrap_url()).send()));
        started_rx.recv().await.unwrap();
    }
    // A response timeout must not free a still-running blocking worker's slot.
    let mut completed = Vec::new();
    for request in requests {
        completed.push(request.await);
    }
    let busy = client.get(site.bootstrap_url()).send().await;
    // Release before asserting so any failure still lets the runtime shut down.
    *release.0.lock().unwrap() = true;
    release.1.notify_all();
    for result in completed {
        assert_eq!(result.unwrap().unwrap().status(), 504);
    }
    assert_eq!(busy.unwrap().status(), 503);
    assert!(site.diagnostics().iter().any(|d| d.contains("超时")));
}

#[tokio::test]
async fn drop_revokes_and_invalid_root_names_do_not_start() {
    let site = fixture(Arc::new(|_| unreachable!()), Arc::new(|| Ok(()))).await;
    let state = site.state.clone();
    let client = client();
    let url = site.root_url().to_string();
    let cookie = authenticate(&client, &site).await;
    drop(site);
    assert!(!state.active.load(Ordering::SeqCst));
    if let Ok(response) = client.get(url).header("Cookie", cookie).send().await {
        assert_ne!(response.status(), 200);
    }
    for name in [
        "../index.html",
        "a/b.html",
        "C:\\index.html",
        "file.html:ads",
        "file.html.",
        "file.html ",
    ] {
        assert!(HtmlSite::start(
            name.into(),
            vec![],
            Arc::new(|_| unreachable!()),
            Arc::new(|| Ok(()))
        )
        .await
        .is_err());
    }
}
