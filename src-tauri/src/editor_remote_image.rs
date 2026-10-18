//! Restricted Word image paste receiver. Not a general network/file proxy.
//! Policy and pinned upstream comparison: docs/implementation/genoffice-remote-images.md.
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, ErrorCode},
        models::WorkspaceBinding,
    },
    db::{
        file_versions::{GuiFileVersionMetadata, GuiFileVersionPrepare},
        project_directory_files::FileBytesInput,
    },
    source_service::BoundSourceStore,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::{header, redirect::Policy, Client};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::Path,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tauri::Manager;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(30);
static SLOT: OnceLock<Arc<Semaphore>> = OnceLock::new();
type RemoteResult<T> = Result<T, EditorRemoteImageFailure>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FetchEditorRemoteImageInput {
    pub binding: WorkspaceBinding,
    pub document: FileBytesInput,
    pub url: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditorRemoteImage {
    pub mime: String,
    pub base64: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditorRemoteImageFailure {
    pub code: &'static str,
    pub message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
}
fn failure(code: &'static str, message: &'static str) -> EditorRemoteImageFailure {
    EditorRemoteImageFailure {
        code,
        message,
        http_status: None,
    }
}
fn changed() -> EditorRemoteImageFailure {
    failure(
        "document_changed",
        "File 已变更或不可编辑，请重新读取后粘贴图片。",
    )
}
fn agent_failure(error: AgentError) -> EditorRemoteImageFailure {
    match error.code {
        ErrorCode::WorkspaceChanged | ErrorCode::WorkspaceNotOpen => {
            failure("workspace_changed", "Workspace 已关闭或切换。")
        }
        _ => changed(),
    }
}
fn blocked() -> EditorRemoteImageFailure {
    failure("blocked_target", "图片地址不属于允许的公网 HTTP(S) 目标。")
}
fn invalid_url() -> EditorRemoteImageFailure {
    failure(
        "invalid_url",
        "图片地址必须是有效且不含身份信息的 HTTP(S) URL。",
    )
}

fn v4_in(ip: Ipv4Addr, base: Ipv4Addr, bits: u32) -> bool {
    let mask = u32::MAX << (32 - bits);
    u32::from(ip) & mask == u32::from(base) & mask
}
fn v6_in(ip: Ipv6Addr, base: Ipv6Addr, bits: u32) -> bool {
    let mask = u128::MAX << (128 - bits);
    u128::from(ip) & mask == u128::from(base) & mask
}
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ![
            (Ipv4Addr::new(0, 0, 0, 0), 8),
            (Ipv4Addr::new(10, 0, 0, 0), 8),
            (Ipv4Addr::new(100, 64, 0, 0), 10),
            (Ipv4Addr::new(127, 0, 0, 0), 8),
            (Ipv4Addr::new(169, 254, 0, 0), 16),
            (Ipv4Addr::new(172, 16, 0, 0), 12),
            (Ipv4Addr::new(192, 0, 0, 0), 24),
            (Ipv4Addr::new(192, 0, 2, 0), 24),
            (Ipv4Addr::new(192, 88, 99, 0), 24),
            (Ipv4Addr::new(192, 168, 0, 0), 16),
            (Ipv4Addr::new(198, 18, 0, 0), 15),
            (Ipv4Addr::new(198, 51, 100, 0), 24),
            (Ipv4Addr::new(203, 0, 113, 0), 24),
            (Ipv4Addr::new(224, 0, 0, 0), 4),
            (Ipv4Addr::new(240, 0, 0, 0), 4),
        ]
        .iter()
        .any(|(base, bits)| v4_in(ip, *base, *bits)),
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(v4));
            }
            v6_in(ip, Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0), 3)
                && ![
                    (Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 23),
                    (Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0), 32),
                    (Ipv6Addr::new(0x2002, 0, 0, 0, 0, 0, 0, 0), 16),
                    (Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0), 20),
                ]
                .iter()
                .any(|(base, bits)| v6_in(ip, *base, *bits))
        }
    }
}
fn image_url(value: &str) -> RemoteResult<tauri::Url> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > 8192
        || value.bytes().any(|b| b.is_ascii_control() || b == b'\\')
    {
        return Err(invalid_url());
    }
    let authority = value
        .split_once("://")
        .ok_or_else(invalid_url)?
        .1
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    if authority.is_empty() || authority.contains('@') || authority.contains('%') {
        return Err(invalid_url());
    }
    let mut url = tauri::Url::parse(value).map_err(|_| invalid_url())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid_url());
    }
    let host = url
        .host_str()
        .ok_or_else(invalid_url)?
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_lowercase();
    if host.is_empty()
        || ["localhost", "local", "internal"]
            .iter()
            .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
    {
        return Err(blocked());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !public_ip(ip) {
            return Err(blocked());
        }
    }
    // A trailing dot denotes the same host. Canonicalize it before DNS pinning.
    if !host.contains(':') {
        url.set_host(Some(&host)).map_err(|_| invalid_url())?;
    }
    url.set_fragment(None);
    Ok(url)
}
trait Resolver {
    async fn lookup(&self, host: &str, port: u16) -> RemoteResult<Vec<IpAddr>>;
}
struct SystemDns;
impl Resolver for SystemDns {
    async fn lookup(&self, host: &str, port: u16) -> RemoteResult<Vec<IpAddr>> {
        tokio::net::lookup_host((host, port))
            .await
            .map(|all| all.map(|a| a.ip()).collect())
            .map_err(|_| failure("dns_failed", "无法解析图片服务器地址。"))
    }
}
struct Limits {
    bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            bytes: MAX_IMAGE_BYTES,
        }
    }
}
struct Downloader<R> {
    resolver: R,
    limits: Limits,
    owner: Arc<OwnedSemaphorePermit>,
    // Only unit tests can map an already approved logical public host to a
    // local HTTP fixture. No IPC input or production constructor has this knob.
    #[cfg(test)]
    connect: Option<SocketAddr>,
}
impl<R: Resolver> Downloader<R> {
    async fn download(
        &self,
        value: &str,
        check: impl Fn() -> RemoteResult<()>,
    ) -> RemoteResult<EditorRemoteImage> {
        let mut url = image_url(value)?;
        for hop in 0..=5 {
            check()?;
            let host = url
                .host_str()
                .ok_or_else(invalid_url)?
                .trim_matches(['[', ']']);
            let port = url.port_or_known_default().ok_or_else(invalid_url)?;
            let ips = if let Ok(ip) = host.parse::<IpAddr>() {
                vec![ip]
            } else {
                self.resolver.lookup(host, port).await?
            };
            if ips.is_empty() || ips.iter().any(|ip| !public_ip(*ip)) {
                return Err(blocked());
            }
            check()?; // DNS awaited: binding/actual File may have changed.
            let addresses: Vec<SocketAddr> =
                ips.iter().map(|ip| SocketAddr::new(*ip, port)).collect();
            #[cfg(test)]
            let addresses = self.connect.map(|addr| vec![addr]).unwrap_or(addresses);
            let client = Client::builder()
                .no_proxy()
                .redirect(Policy::none())
                .referer(false)
                .retry(reqwest::retry::never())
                .no_gzip()
                .no_brotli()
                .no_zstd()
                .no_deflate()
                .timeout(DEADLINE)
                .resolve_to_addrs(host, &addresses)
                .build()
                .map_err(|_| failure("http_failed", "无法建立图片下载连接。"))?;
            let mut response = client
                .get(url.clone())
                .header(header::USER_AGENT, "Mozilla/5.0")
                .header(header::ACCEPT, "image/png,image/jpeg,image/gif")
                .header(header::ACCEPT_ENCODING, "identity")
                .send()
                .await
                .map_err(|error| {
                    if error.is_timeout() {
                        failure("timeout", "图片读取超过 30 秒，请稍后重试。")
                    } else {
                        failure("http_failed", "图片下载连接失败。")
                    }
                })?;
            check()?; // Response headers are another external I/O boundary.
            let status = response.status();
            if [301, 302, 303, 307, 308].contains(&status.as_u16()) {
                if hop == 5 {
                    return Err(failure("redirect_limit", "图片地址重定向超过 5 次。"));
                }
                let location = response
                    .headers()
                    .get(header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(invalid_url)?;
                // Inspect the raw Location before URL normalization can discard
                // controls, backslashes or empty userinfo on absolute targets.
                if location.len() > 8192
                    || location.bytes().any(|b| b.is_ascii_control() || b == b'\\')
                {
                    return Err(invalid_url());
                }
                if location.contains("://") || location.starts_with("//") {
                    let absolute = if location.starts_with("//") {
                        format!("{}:{location}", url.scheme())
                    } else {
                        location.into()
                    };
                    image_url(&absolute)?;
                }
                let next = url.join(location).map_err(|_| invalid_url())?;
                url = image_url(next.as_str())?;
                continue; // Drop response; do not consume or retain redirect body.
            }
            if !status.is_success() {
                let mut error = failure("http_status", "图片服务器返回失败状态。");
                error.http_status = Some(status.as_u16());
                return Err(error);
            }
            if response
                .headers()
                .get(header::CONTENT_ENCODING)
                .is_some_and(|v| v.as_bytes() != b"identity")
            {
                return Err(failure(
                    "unsupported_image",
                    "图片响应使用了不支持的内容编码。",
                ));
            }
            let mime = response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if !matches!(mime.as_str(), "image/png" | "image/jpeg" | "image/gif") {
                return Err(failure(
                    "unsupported_image",
                    "仅支持真实 PNG、JPEG 或 GIF 图片。",
                ));
            }
            if response
                .content_length()
                .is_some_and(|n| n > self.limits.bytes as u64)
            {
                return Err(failure("image_budget", "图片超过 50 MiB 限制。"));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| failure("http_failed", "图片字节流读取失败。"))?
            {
                if chunk.len() > self.limits.bytes - bytes.len() {
                    return Err(failure("image_budget", "图片超过 50 MiB 限制。"));
                }
                bytes.extend_from_slice(&chunk);
            }
            check()?;
            let mime = raster(&bytes, &mime)?;
            return Ok(EditorRemoteImage {
                mime: mime.into(),
                base64: STANDARD.encode(bytes),
            });
        }
        unreachable!("bounded redirects return at hop 5")
    }
}
fn dimensions(width: u32, height: u32) -> RemoteResult<()> {
    if width == 0
        || height == 0
        || width > 16_384
        || height > 16_384
        || u64::from(width) * u64::from(height) > 40_000_000
    {
        return Err(failure("image_dimensions", "图片像素尺寸超过限制。"));
    }
    Ok(())
}
fn raster(bytes: &[u8], mime: &str) -> RemoteResult<&'static str> {
    let bad = || failure("unsupported_image", "图片 MIME、文件头或图片尺寸头无效。 ");
    let format = image::guess_format(bytes).map_err(|_| bad())?;
    let actual = match format {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::Gif => "image/gif",
        _ => return Err(bad()),
    };
    if mime != actual {
        return Err(bad());
    }
    let (width, height) = image::ImageReader::with_format(std::io::Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|_| bad())?;
    dimensions(width, height)?;
    Ok(actual)
}

fn project_label(label: &str) -> Option<i64> {
    let id = label.strip_prefix("project-")?.parse::<i64>().ok()?;
    (id > 0 && label == format!("project-{id}")).then_some(id)
}
fn authorize_identity(
    label: &str,
    window: &str,
    url: &tauri::Url,
    dev: Option<&tauri::Url>,
    is_dev: bool,
) -> RemoteResult<()> {
    let local = url.username().is_empty()
        && url.password().is_none()
        && (if is_dev && dev.is_some() {
            dev.is_some_and(|dev| dev.origin() == url.origin())
        } else {
            url.port().is_none()
                && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                    || (matches!(url.scheme(), "http" | "https")
                        && url.host_str() == Some("tauri.localhost")))
        });
    if !local || label != window || (label != "main" && project_label(label).is_none()) {
        return Err(failure("caller_denied", "此页面无权读取编辑器远程图片。"));
    }
    Ok(())
}
fn authorize(caller: &tauri::Webview) -> RemoteResult<String> {
    let url = caller
        .url()
        .map_err(|_| failure("caller_denied", "无法验证调用页面。"))?;
    authorize_identity(
        caller.label(),
        caller.window().label(),
        &url,
        caller.app_handle().config().build.dev_url.as_ref(),
        cfg!(dev),
    )?;
    Ok(caller.label().into())
}
fn authorize_project(label: &str, project: i64) -> RemoteResult<()> {
    if label == "main" || project_label(label) == Some(project) {
        Ok(())
    } else {
        Err(failure("caller_denied", "此页面不能读取其他项目的图片。"))
    }
}
fn metadata<S: BoundSourceStore>(
    store: &S,
    input: &FetchEditorRemoteImageInput,
    request: &RequestContext,
) -> RemoteResult<GuiFileVersionMetadata> {
    store
        .with_current(|current, db| {
            crate::file_version_service::validate_binding(&input.binding, current)?;
            let target =
                db.file_version_registered_target(request, current, &input.document.object)?;
            if target.current_version_number != i64::from(input.document.version_number)
                || !Path::new(&target.managed_path)
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("docx"))
            {
                return Err(AgentError::new(
                    ErrorCode::RevisionConflict,
                    "File is not the current DOCX",
                ));
            }
            let result = db.file_version_gui_metadata(&GuiFileVersionPrepare {
                document_id: target.id,
                project_id: target.project_id,
                managed_path: target.managed_path,
                expected_version_number: input.document.version_number,
                source_path: None,
            })?;
            if result.registered_content_hash.as_ref()
                != Some(&input.document.expected_content_hash)
            {
                return Err(AgentError::new(
                    ErrorCode::RevisionConflict,
                    "File hash changed",
                ));
            }
            Ok(result)
        })
        .map_err(agent_failure)
}
fn bounded_hash(input: &mut impl Read, limit: u64) -> RemoteResult<String> {
    let mut digest = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 65536];
    loop {
        // A one-byte probe detects a growing file without reading an unbounded
        // chunk past the cap. No full File buffer is allocated.
        let remaining = (limit - size).saturating_add(1).min(buffer.len() as u64) as usize;
        let count = input
            .read(&mut buffer[..remaining])
            .map_err(|_| changed())?;
        if count == 0 {
            break;
        }
        if count as u64 > limit - size {
            return Err(failure(
                "document_budget",
                "File 原件超过 100 MiB 图片授权核验预算。",
            ));
        }
        size += count as u64;
        digest.update(&buffer[..count]);
    }
    Ok(format!("sha256:{:x}", digest.finalize()))
}
fn hash_document(path: &Path, expected: &str) -> RemoteResult<()> {
    use crate::source_file_snapshot::{open_regular, FileStamp};
    let initial = std::fs::symlink_metadata(path).map_err(|_| changed())?;
    if initial.file_type().is_symlink() || !initial.is_file() {
        return Err(changed());
    }
    if initial.len() > crate::file_content::MAX_CONTENT {
        return Err(failure(
            "document_budget",
            "File 原件超过 100 MiB 图片授权核验预算。",
        ));
    }
    let mut file = open_regular(path).map_err(agent_failure)?;
    let before = FileStamp::from_metadata(&file.metadata().map_err(|_| changed())?);
    if before != FileStamp::from_metadata(&initial) {
        return Err(changed());
    }
    let hash = bounded_hash(&mut file, crate::file_content::MAX_CONTENT)?;
    if hash != expected
        || before != FileStamp::from_metadata(&file.metadata().map_err(|_| changed())?)
        || before
            != FileStamp::from_metadata(&std::fs::symlink_metadata(path).map_err(|_| changed())?)
        || crate::db::file_versions::identity(&file).map_err(|_| changed())?
            != crate::db::file_versions::path_identity(path).map_err(|_| changed())?
    {
        return Err(changed());
    }
    Ok(())
}
async fn disk_job<T: Send + 'static>(
    owner: Arc<OwnedSemaphorePermit>,
    operation: impl FnOnce() -> RemoteResult<T> + Send + 'static,
) -> RemoteResult<T> {
    tokio::task::spawn_blocking(move || {
        let _owner = owner;
        operation()
    })
    .await
    .map_err(|_| changed())?
}
async fn capture_document(
    metadata: &GuiFileVersionMetadata,
    expected: &str,
    owner: &Arc<OwnedSemaphorePermit>,
) -> RemoteResult<()> {
    let path = metadata.input.managed_path.clone();
    let expected = expected.to_owned();
    // spawn_blocking cannot be cancelled. Its slot owner lives until actual I/O
    // finishes, even if timeout/IPC cancellation drops the awaiting future.
    disk_job(owner.clone(), move || {
        hash_document(Path::new(&path), &expected)
    })
    .await
}
async fn fetch_for_document<S: BoundSourceStore, R: Resolver>(
    store: &S,
    input: &FetchEditorRemoteImageInput,
    caller: impl Fn() -> RemoteResult<String>,
    downloader: &Downloader<R>,
) -> RemoteResult<EditorRemoteImage> {
    // Reject syntax without DNS. Input hash is the existing sha256:<64> format.
    image_url(&input.url)?;
    if !crate::db::file_versions::valid_hash(&input.document.expected_content_hash) {
        return Err(changed());
    }
    let label = caller()?;
    let request = crate::file_office::gui_request(
        store,
        &input.binding,
        "editor-remote-image",
        &input.document.object,
        true,
    )
    .map_err(agent_failure)?;
    let before = metadata(store, input, &request)?;
    authorize_project(&label, before.input.project_id)?;
    let check = || {
        let label = caller()?;
        let now = metadata(store, input, &request)?;
        authorize_project(&label, now.input.project_id)?;
        if now != before {
            return Err(changed());
        }
        Ok(())
    };
    capture_document(
        &before,
        &input.document.expected_content_hash,
        &downloader.owner,
    )
    .await?;
    check()?;
    let result = downloader.download(&input.url, &check).await;
    // Even failure receipts recheck authority. Only these two filesystem hashes
    // span the network operation; no Workspace/DB mutex spans any await.
    check()?;
    capture_document(
        &before,
        &input.document.expected_content_hash,
        &downloader.owner,
    )
    .await?;
    check()?;
    result
}

#[tauri::command]
pub(crate) async fn desktop_fetch_editor_remote_image(
    state: tauri::State<'_, crate::AppState>,
    caller: tauri::Webview,
    input: FetchEditorRemoteImageInput,
) -> RemoteResult<EditorRemoteImage> {
    let owner = Arc::new(
        SLOT.get_or_init(|| Arc::new(Semaphore::new(1)))
            .clone()
            .try_acquire_owned()
            .map_err(|_| failure("busy", "另一个图片读取尚未完成，请稍后重试。"))?,
    );
    let downloader = Downloader {
        resolver: SystemDns,
        owner,
        limits: Limits::default(),
        #[cfg(test)]
        connect: None,
    };
    tokio::time::timeout(
        DEADLINE,
        fetch_for_document(&*state, &input, || authorize(&caller), &downloader),
    )
    .await
    .map_err(|_| failure("timeout", "图片读取超过 30 秒，请稍后重试。"))?
}

#[cfg(test)]
mod tests;
