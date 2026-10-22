//! Per-preview loopback static site. The reader owns File authorization and
//! historical-version policy; this module never receives filesystem paths.
use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::Response,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use rand::RngCore;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::{watch, Semaphore};

pub(crate) type AssetReader = Arc<dyn Fn(&str) -> Result<(String, Vec<u8>), String> + Send + Sync>;
pub(crate) type Validator = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

const MAX_ROOT_BYTES: usize = 10 * 1024 * 1024;
const MAX_SITE_BYTES: usize = 32 * 1024 * 1024;
const MAX_RESOURCES: usize = 64;
const MAX_DIAGNOSTICS: usize = 32;
const MAX_PATH_BYTES: usize = 4096;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
// Slots belong to the blocking worker, including after the response times out.
// A stuck callback cannot create an unbounded spawn_blocking queue.
const MAX_WORKERS: usize = 8;

#[derive(Clone)]
struct Resource {
    mime: HeaderValue,
    bytes: Bytes,
}

struct Cache {
    resources: HashMap<String, Resource>,
    bytes: usize,
}

struct SiteState {
    origin: String,
    authority: String,
    bootstrap_path: String,
    root_path: String,
    cookie: String,
    read: AssetReader,
    validate: Validator,
    active: AtomicBool,
    closed: watch::Sender<bool>,
    workers: Arc<Semaphore>,
    cache: Mutex<Cache>,
    diagnostics: Mutex<VecDeque<String>>,
}

pub(crate) struct HtmlSite {
    bootstrap_url: String,
    root_url: String,
    state: Arc<SiteState>,
    server: tokio::task::JoinHandle<()>,
}

impl HtmlSite {
    pub(crate) async fn start(
        name: String,
        bytes: Vec<u8>,
        read: AssetReader,
        validate: Validator,
    ) -> Result<Self, String> {
        if !valid_components(&name) || name.contains('/') || bytes.len() > MAX_ROOT_BYTES {
            return Err("网页文件名无效，或主文件超过 10 MiB。".into());
        }
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| "无法启动网页本地服务。".to_string())?;
        let authority = listener
            .local_addr()
            .map_err(|_| "无法获取网页本地地址。".to_string())?
            .to_string();
        let origin = format!("http://{authority}");
        let bootstrap_path = format!("/{}-bootstrap", secret());
        let root_path = format!("/{}", utf8_percent_encode(&name, NON_ALPHANUMERIC));
        // Cookies are scoped to host, not port. A distinct name AND value keep
        // simultaneous loopback sessions from replacing/authenticating each other.
        let cookie = format!("html_preview_{}={}", secret(), secret());
        let byte_count = bytes.len();
        let root = Resource {
            mime: HeaderValue::from_static("text/html"),
            bytes: Bytes::from(bytes),
        };
        let (closed, _) = watch::channel(false);
        let state = Arc::new(SiteState {
            origin: origin.clone(),
            authority,
            bootstrap_path: bootstrap_path.clone(),
            root_path: root_path.clone(),
            cookie,
            read,
            validate,
            active: AtomicBool::new(true),
            closed,
            workers: Arc::new(Semaphore::new(MAX_WORKERS)),
            cache: Mutex::new(Cache {
                resources: HashMap::from([(name, root)]),
                bytes: byte_count,
            }),
            diagnostics: Mutex::new(VecDeque::new()),
        });
        let router = Router::new().fallback(request).with_state(state.clone());
        let server_state = state.clone();
        let server = tokio::spawn(async move {
            if axum::serve(listener, router).await.is_err() {
                server_state.active.store(false, Ordering::SeqCst);
                server_state.closed.send_replace(true);
                server_state.diagnose("网页本地服务意外停止。");
            }
        });
        Ok(Self {
            bootstrap_url: format!("{origin}{bootstrap_path}"),
            root_url: format!("{origin}{root_path}"),
            state,
            server,
        })
    }

    pub(crate) fn bootstrap_url(&self) -> &str {
        &self.bootstrap_url
    }

    pub(crate) fn root_url(&self) -> &str {
        &self.root_url
    }

    pub(crate) fn diagnostics(&self) -> Vec<String> {
        self.state
            .diagnostics
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect()
    }

    pub(crate) fn close(&self) {
        self.state.active.store(false, Ordering::SeqCst);
        self.state.closed.send_replace(true);
        self.server.abort();
    }
}

impl Drop for HtmlSite {
    fn drop(&mut self) {
        self.close();
    }
}

fn secret() -> String {
    let mut bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

impl SiteState {
    // Deliberately do not record callback errors: they may contain local paths,
    // secrets, or unbounded external content. The UI gets stable bounded reasons.
    fn diagnose(&self, message: &'static str) {
        let mut diagnostics = self.diagnostics.lock().unwrap_or_else(|e| e.into_inner());
        if diagnostics.back().is_some_and(|last| last == message) {
            return;
        }
        if diagnostics.len() == MAX_DIAGNOSTICS {
            diagnostics.pop_front();
        }
        diagnostics.push_back(message.to_string());
    }

    fn check(&self) -> Result<(), StatusCode> {
        if !self.active.load(Ordering::SeqCst) {
            return Err(StatusCode::GONE);
        }
        (self.validate)().map_err(|_| {
            self.diagnose("网页授权或原件版本已变化，请刷新。");
            StatusCode::FORBIDDEN
        })?;
        if !self.active.load(Ordering::SeqCst) {
            return Err(StatusCode::GONE);
        }
        Ok(())
    }

    fn load(&self, name: &str) -> Result<Resource, StatusCode> {
        // Serialize cache misses so the session budget and first-read snapshot
        // are atomic. At most MAX_WORKERS callers can be waiting for this lock.
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        self.check()?;
        if let Some(resource) = cache.resources.get(name) {
            return Ok(resource.clone());
        }
        if cache.resources.len() >= MAX_RESOURCES {
            self.diagnose("网页资源数量超过 64 项上限。");
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        let (mime, bytes) = (self.read)(name).map_err(|_| {
            self.diagnose("此版本的关联资源不可用或读取失败。");
            StatusCode::NOT_FOUND
        })?;
        // File I/O may have crossed a workspace switch or version change.
        self.check()?;
        if bytes.len() > MAX_SITE_BYTES - cache.bytes {
            self.diagnose("网页资源总大小超过 32 MiB 上限。");
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        let mime = HeaderValue::from_str(&mime).map_err(|_| {
            self.diagnose("网页资源的媒体类型无效。");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
        cache.bytes += bytes.len();
        let resource = Resource {
            mime,
            bytes: Bytes::from(bytes),
        };
        cache.resources.insert(name.to_string(), resource.clone());
        Ok(resource)
    }
}

fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Result<Option<&'a str>, ()> {
    let mut values = headers.get_all(name).iter();
    let first = values
        .next()
        .map(|value| value.to_str().map_err(|_| ()))
        .transpose()?;
    if values.next().is_some() {
        return Err(());
    }
    Ok(first)
}

fn allowed_source(state: &SiteState, headers: &HeaderMap, uri: &Uri) -> bool {
    if single_header(headers, "host") != Ok(Some(state.authority.as_str())) {
        return false;
    }
    // Absolute-form request targets must agree too; never act as a proxy.
    if uri
        .authority()
        .is_some_and(|a| a.as_str() != state.authority)
        || uri.scheme_str().is_some_and(|scheme| scheme != "http")
    {
        return false;
    }
    match single_header(headers, "origin") {
        Ok(None) => {}
        Ok(Some(origin)) if origin == state.origin => {}
        _ => return false,
    }
    matches!(
        single_header(headers, "sec-fetch-site"),
        Ok(None | Some("same-origin" | "none"))
    )
}

fn authenticated(state: &SiteState, headers: &HeaderMap) -> bool {
    let mut matches = 0;
    for value in headers.get_all(header::COOKIE) {
        let Ok(value) = value.to_str() else {
            return false;
        };
        for part in value.split(';') {
            if part.trim() == state.cookie {
                matches += 1;
            }
        }
    }
    matches == 1
}

fn valid_components(name: &str) -> bool {
    if name.is_empty() || name.len() > MAX_PATH_BYTES {
        return false;
    }
    name.split('/').all(|part| {
        !part.is_empty()
            && !part.starts_with('.')
            && !part.ends_with(['.', ' '])
            && !part
                .chars()
                .any(|c| c.is_control() || matches!(c, '\\' | ':' | '%' | '?' | '#'))
            && !windows_device(part)
    })
}

fn windows_device(part: &str) -> bool {
    let stem = part
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|n| matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"))
}

fn resource_name(path: &str) -> Result<String, StatusCode> {
    if path.len() > MAX_PATH_BYTES || !path.starts_with('/') {
        return Err(StatusCode::BAD_REQUEST);
    }
    let decoded = percent_decode_str(path)
        .decode_utf8()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let mut name = decoded
        .strip_prefix('/')
        .ok_or(StatusCode::BAD_REQUEST)?
        .to_string();
    if name.is_empty() || name.ends_with('/') {
        name.push_str("index.html");
    }
    if !valid_components(&name) {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(name)
}

enum Reply {
    Bootstrap,
    Asset(Resource),
}

async fn request(
    State(state): State<Arc<SiteState>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let head = method == Method::HEAD;
    if !state.active.load(Ordering::SeqCst) {
        return failure(StatusCode::GONE, head);
    }
    if !allowed_source(&state, &headers, &uri) {
        return failure(StatusCode::FORBIDDEN, head);
    }
    if method != Method::GET && !head {
        let mut response = failure(StatusCode::METHOD_NOT_ALLOWED, head);
        response
            .headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
        return response;
    }
    let bootstrap = uri.path() == state.bootstrap_path;
    if !bootstrap && !authenticated(&state, &headers) {
        return failure(StatusCode::FORBIDDEN, head);
    }
    let name = if bootstrap {
        None
    } else {
        match resource_name(uri.path()) {
            Ok(name) => Some(name),
            Err(code) => return failure(code, head),
        }
    };
    let Ok(permit) = state.workers.clone().try_acquire_owned() else {
        state.diagnose("网页资源读取繁忙，待处理请求过多。");
        return failure(StatusCode::SERVICE_UNAVAILABLE, head);
    };
    let mut closed = state.closed.subscribe();
    let worker_state = state.clone();
    let worker = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        match name {
            Some(name) => worker_state.load(&name).map(Reply::Asset),
            None => worker_state.check().map(|()| Reply::Bootstrap),
        }
    });
    let result = tokio::select! {
        biased;
        _ = closed.changed() => Err(StatusCode::GONE),
        result = tokio::time::timeout(REQUEST_TIMEOUT, worker) => match result {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                state.diagnose("网页资源读取任务失败。");
                Err(StatusCode::INTERNAL_SERVER_ERROR)
            }
            Err(_) => {
                state.diagnose("网页资源读取超时。");
                Err(StatusCode::GATEWAY_TIMEOUT)
            }
        },
    };
    if !state.active.load(Ordering::SeqCst) {
        return failure(StatusCode::GONE, head);
    }
    match result {
        Ok(Reply::Bootstrap) => {
            let mut response = response(StatusCode::SEE_OTHER, Bytes::new(), head);
            response.headers_mut().insert(
                header::LOCATION,
                HeaderValue::from_str(&state.root_path).expect("encoded root path"),
            );
            response.headers_mut().insert(
                header::SET_COOKIE,
                HeaderValue::from_str(&format!(
                    "{}; Path=/; HttpOnly; SameSite=Strict",
                    state.cookie
                ))
                .expect("generated cookie"),
            );
            response
        }
        Ok(Reply::Asset(resource)) => {
            let mut response = response(StatusCode::OK, resource.bytes, head);
            response
                .headers_mut()
                .insert(header::CONTENT_TYPE, resource.mime);
            response
        }
        Err(code) => failure(code, head),
    }
}

fn response(status: StatusCode, bytes: Bytes, head: bool) -> Response {
    let length = bytes.len();
    let mut response = Response::new(if head {
        Body::empty()
    } else {
        Body::from(bytes)
    });
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&length.to_string()).expect("integer header"),
    );
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    // Revalidate on every actual request; WebView/HTTP caches must not bypass
    // workspace revocation or retain old-session content on refresh.
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn failure(status: StatusCode, head: bool) -> Response {
    response(
        status,
        Bytes::from_static(b"HTML preview request unavailable."),
        head,
    )
}

#[cfg(test)]
#[path = "html_preview_http_tests.rs"]
mod tests;
