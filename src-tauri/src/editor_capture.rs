//! User-initiated, one-shot editor screenshots. No File/path/handle input.
use std::{
    io::{self, Write},
    sync::Mutex,
    time::{Duration, Instant},
};

use base64::Engine as _;
use image::{codecs::png::PngEncoder, ImageEncoder, RgbaImage};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::sync::Semaphore;

#[cfg(target_os = "macos")]
#[path = "editor_capture/macos.rs"]
mod platform;
#[cfg(target_os = "windows")]
#[path = "editor_capture/windows.rs"]
mod platform;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    pub struct Target;
    pub fn sources() -> super::NativeResult<Vec<super::Candidate<Target>>> {
        Err(super::CaptureError::Failed(
            "当前平台未实现编辑器截图".into(),
        ))
    }
    pub fn capture(_: Target) -> super::NativeResult<Option<image::RgbaImage>> {
        Err(super::CaptureError::Failed(
            "当前平台未实现编辑器截图".into(),
        ))
    }
}

const MAX_PNG_BYTES: usize = 20 * 1024 * 1024;
const MAX_PIXELS: u64 = 40_000_000; // Includes an 8K display, bounds RGBA to 160 MB.
const MAX_SIDE: u32 = 16_384;
const MAX_SOURCES: usize = 64;
const MAX_LISTINGS: usize = 32;
const LIST_TTL: Duration = Duration::from_secs(120);
const THUMB_WIDTH: u32 = 320;
const THUMB_HEIGHT: u32 = 180;
static SLOT: Semaphore = Semaphore::const_new(1);
static SELECTIONS: Mutex<Selections<platform::Target>> = Mutex::new(Selections {
    lists: Vec::new(),
    watched_callers: Vec::new(),
});

#[derive(Debug)]
enum CaptureError {
    Denied,
    Failed(String),
}
type NativeResult<T> = Result<T, CaptureError>;
impl From<String> for CaptureError {
    fn from(error: String) -> Self {
        Self::Failed(error)
    }
}
impl CaptureError {
    fn message(self) -> String {
        match self {
            Self::Denied => "系统拒绝了屏幕截图权限".into(),
            Self::Failed(error) => error,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum SourceKind {
    Screen,
    Window,
}

#[derive(Serialize)]
pub struct ScreenSource {
    id: String,
    name: String,
    kind: SourceKind,
    thumbnail: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourcesStatus {
    Ok,
    Denied,
}
#[derive(Serialize)]
pub struct ScreenSourcesResult {
    status: SourcesStatus,
    sources: Vec<ScreenSource>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScreenCaptureInput {
    id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenCaptureResult {
    media_type: &'static str,
    base64: String,
    width: u32,
    height: u32,
}

struct Candidate<T> {
    name: String,
    kind: SourceKind,
    thumbnail: String,
    target: T,
}
struct Choice<T> {
    id: String,
    target: T,
}
struct Listing<T> {
    caller: String,
    generation: u128,
    expires: Instant,
    choices: Vec<Choice<T>>,
}
// Generic only so the exact selection/expiry boundary can be tested without
// constructing native capture objects or invoking any permission API.
struct Selections<T> {
    lists: Vec<Listing<T>>,
    watched_callers: Vec<String>,
}
impl<T> Selections<T> {
    fn clear(&mut self, caller: &str) {
        self.lists.retain(|list| list.caller != caller);
    }
    fn prune(&mut self, now: Instant) {
        self.lists.retain(|list| now < list.expires);
    }
    fn publish(
        &mut self,
        caller: &str,
        candidates: Vec<Candidate<T>>,
        now: Instant,
    ) -> Result<(ScreenSourcesResult, u128), String> {
        self.prune(now);
        self.clear(caller);
        if !self.watched_callers.iter().any(|label| label == caller) {
            return Err("截图请求窗口已关闭".into());
        }
        if self.lists.len() >= MAX_LISTINGS || candidates.len() > MAX_SOURCES {
            return Err("截图来源列表超过资源上限".into());
        }
        let generation = rand::random();
        let mut sources = Vec::with_capacity(candidates.len());
        let mut choices = Vec::with_capacity(candidates.len());
        for candidate in candidates {
            let id = format!("{:032x}", rand::random::<u128>());
            sources.push(ScreenSource {
                id: id.clone(),
                name: candidate.name,
                kind: candidate.kind,
                thumbnail: candidate.thumbnail,
            });
            choices.push(Choice {
                id,
                target: candidate.target,
            });
        }
        self.lists.push(Listing {
            caller: caller.into(),
            generation,
            expires: now + LIST_TTL,
            choices,
        });
        Ok((
            ScreenSourcesResult {
                status: SourcesStatus::Ok,
                sources,
            },
            generation,
        ))
    }
    fn take(&mut self, caller: &str, id: &str, now: Instant) -> Result<T, String> {
        self.prune(now);
        let position = self
            .lists
            .iter()
            .position(|list| {
                list.caller == caller && list.choices.iter().any(|choice| choice.id == id)
            })
            .ok_or("截图来源无效或已过期，请重新选择")?;
        // One selection consumes the entire list, including on native failure.
        let list = self.lists.remove(position);
        Ok(list
            .choices
            .into_iter()
            .find(|choice| choice.id == id)
            .unwrap()
            .target)
    }
    fn expire(&mut self, caller: &str, generation: u128) {
        self.lists
            .retain(|list| list.caller != caller || list.generation != generation);
    }
}

fn validate_caller(caller: &str) -> Result<(), String> {
    let project = caller.strip_prefix("project-").is_some_and(|id| {
        !id.is_empty()
            && id.bytes().all(|c| c.is_ascii_digit())
            && id.parse::<i64>().is_ok_and(|id| id > 0)
    });
    if caller == "main" || project {
        Ok(())
    } else {
        Err("当前窗口不能采集编辑器截图".into())
    }
}

fn local_caller_url(url: &tauri::Url, dev_url: Option<&tauri::Url>, is_dev: bool) -> bool {
    if is_dev {
        dev_url.is_some_and(|dev| dev.origin() == url.origin())
    } else {
        let application_host = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost"));
        application_host
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
    }
}
fn authorize_identity(
    label: &str,
    window_label: &str,
    url: &tauri::Url,
    dev_url: Option<&tauri::Url>,
    is_dev: bool,
) -> Result<(), String> {
    validate_caller(label)?;
    if label != window_label || !local_caller_url(url, dev_url, is_dev) {
        return Err("此页面不能采集编辑器截图".into());
    }
    Ok(())
}
fn authorize_caller(caller: &tauri::Webview) -> Result<(), String> {
    let url = caller.url().map_err(|_| "无法验证截图调用页面")?;
    authorize_identity(
        caller.label(),
        caller.window().label(),
        &url,
        caller.app_handle().config().build.dev_url.as_ref(),
        cfg!(dev),
    )
}

fn source_candidates<T>(
    result: NativeResult<Vec<Candidate<T>>>,
) -> Result<Option<Vec<Candidate<T>>>, String> {
    match result {
        Ok(candidates) => Ok(Some(candidates)),
        Err(CaptureError::Denied) => Ok(None),
        Err(error) => Err(error.message()),
    }
}
fn capture_result(
    result: NativeResult<Option<RgbaImage>>,
) -> Result<Option<ScreenCaptureResult>, String> {
    result
        .map_err(CaptureError::message)?
        .map(encode_capture)
        .transpose()
}

fn watch_caller(window: &tauri::Window) -> Result<(), String> {
    let caller = window.label().to_string();
    let mut state = SELECTIONS.lock().map_err(|_| "截图选择状态不可用")?;
    state.clear(&caller); // A new button action invalidates previous choices.
    if !state.watched_callers.contains(&caller) {
        state.watched_callers.push(caller.clone());
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Ok(mut state) = SELECTIONS.lock() {
                    state.clear(&caller);
                    state.watched_callers.retain(|label| label != &caller);
                }
            }
        });
    }
    Ok(())
}

/// Called only by the editor's screenshot button; may request OS permission.
#[tauri::command]
pub async fn desktop_editor_capture_sources(
    caller: tauri::Webview,
) -> Result<ScreenSourcesResult, String> {
    authorize_caller(&caller)?;
    let permit = SLOT.try_acquire().map_err(|_| "已有截图请求正在处理")?;
    watch_caller(&caller.window())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit; // Cancellation must not start a second OS capture.
        authorize_caller(&caller)?;
        let candidates = source_candidates(platform::sources())?;
        // Navigation or destruction may occur while the OS permission/content I/O runs.
        authorize_caller(&caller)?;
        let Some(candidates) = candidates else {
            return Ok(ScreenSourcesResult {
                status: SourcesStatus::Denied,
                sources: Vec::new(),
            });
        };
        caller
            .window()
            .is_visible()
            .map_err(|_| "截图请求窗口已关闭")?;
        let label = caller.label().to_string();
        let (result, generation) = SELECTIONS
            .lock()
            .map_err(|_| "截图选择状态不可用")?
            .publish(&label, candidates, Instant::now())?;
        // Schedule before returning from the detached worker: a cancelled IPC
        // future must not leave retained OS sources alive beyond their TTL.
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(LIST_TTL).await;
            if let Ok(mut state) = SELECTIONS.lock() {
                state.expire(&label, generation);
            }
        });
        Ok(result)
    })
    .await
    .map_err(|error| format!("截图来源任务失败：{error}"))?
}

/// Only a native-issued opaque choice, never a handle, source ID, or path.
#[tauri::command]
pub async fn desktop_editor_capture_source(
    caller: tauri::Webview,
    input: ScreenCaptureInput,
) -> Result<Option<ScreenCaptureResult>, String> {
    authorize_caller(&caller)?;
    if input.id.is_empty() || input.id.len() > 256 {
        return Err("截图来源 ID 无效".into());
    }
    let permit = SLOT.try_acquire().map_err(|_| "已有截图请求正在处理")?;
    let target = SELECTIONS.lock().map_err(|_| "截图选择状态不可用")?.take(
        caller.label(),
        &input.id,
        Instant::now(),
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        authorize_caller(&caller)?;
        let result = platform::capture(target);
        authorize_caller(&caller)?;
        capture_result(result)
    })
    .await
    .map_err(|error| format!("截图任务失败：{error}"))?
}

fn dimensions(width: u32, height: u32) -> Result<(), String> {
    if width == 0
        || height == 0
        || width > MAX_SIDE
        || height > MAX_SIDE
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err("截图尺寸超过限制（每边 16384 像素，总计 4000 万像素）".into());
    }
    Ok(())
}

struct BoundedPng {
    bytes: Vec<u8>,
    limit: usize,
    overflowed: bool,
}
impl Write for BoundedPng {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.overflowed || buf.len() > self.limit.saturating_sub(self.bytes.len()) {
            self.overflowed = true;
            return Err(io::Error::other("截图 PNG 超过字节预算"));
        }
        self.bytes.extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn png(image: &RgbaImage, limit: usize) -> Result<Vec<u8>, String> {
    dimensions(image.width(), image.height())?;
    let mut output = BoundedPng {
        bytes: Vec::new(),
        limit,
        overflowed: false,
    };
    let encoded = PngEncoder::new(&mut output).write_image(
        image.as_raw(),
        image.width(),
        image.height(),
        image::ExtendedColorType::Rgba8,
    );
    // image 0.25.10 leaves IEND to png::Writer::drop, which discards write
    // errors. Inspect the sink after that drop, including when encoding says Ok.
    if output.overflowed {
        return Err(format!("截图 PNG 超过字节预算（上限 {limit} 字节）"));
    }
    encoded.map_err(|error| format!("编码截图 PNG 失败：{error}"))?;
    Ok(output.bytes)
}
fn encode_capture(image: RgbaImage) -> Result<ScreenCaptureResult, String> {
    let bytes = png(&image, MAX_PNG_BYTES)?;
    Ok(ScreenCaptureResult {
        media_type: "image/png",
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        width: image.width(),
        height: image.height(),
    })
}
fn thumbnail(image: &RgbaImage) -> Result<String, String> {
    dimensions(image.width(), image.height())?;
    let scale = (f64::from(THUMB_WIDTH) / f64::from(image.width()))
        .min(f64::from(THUMB_HEIGHT) / f64::from(image.height()))
        .min(1.0);
    // imageops::thumbnail uses exact dimensions, unlike DynamicImage::thumbnail.
    // Compute the aspect-preserving dimensions without cloning the source RGBA.
    let width = (f64::from(image.width()) * scale).round().max(1.0) as u32;
    let height = (f64::from(image.height()) * scale).round().max(1.0) as u32;
    let resized = image::imageops::thumbnail(image, width, height);
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png(&resized, 256 * 1024)?)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn registry() -> Selections<u8> {
        Selections {
            lists: Vec::new(),
            watched_callers: vec!["main".into(), "project-1".into()],
        }
    }
    fn candidate(value: u8) -> Candidate<u8> {
        Candidate {
            name: "Window".into(),
            kind: SourceKind::Window,
            thumbnail: String::new(),
            target: value,
        }
    }
    #[test]
    fn editor_capture_rejects_caller_and_handle_path_inputs() {
        for caller in ["main", "project-1", "project-123"] {
            assert!(validate_caller(caller).is_ok());
        }
        for caller in [
            "",
            "settings",
            "editor-print-a",
            "project-0",
            "project--1",
            "project-1/x",
        ] {
            assert!(validate_caller(caller).is_err());
        }
        for input in [
            r#"{"id":"abc","hwnd":1}"#,
            r#"{"id":"abc","path":"/tmp/file"}"#,
            r#"{"id":"abc","caller":"main"}"#,
        ] {
            assert!(serde_json::from_str::<ScreenCaptureInput>(input).is_err());
        }
    }
    #[test]
    fn editor_capture_authorizes_only_local_primary_webviews() {
        let dev = tauri::Url::parse("http://localhost:1420").unwrap();
        for url in [
            "tauri://localhost/",
            "http://tauri.localhost/",
            "https://tauri.localhost/",
        ] {
            let url = tauri::Url::parse(url).unwrap();
            assert!(authorize_identity("main", "main", &url, Some(&dev), false).is_ok());
            assert!(authorize_identity("project-1", "project-1", &url, Some(&dev), false).is_ok());
            assert!(authorize_identity("browser-child", "main", &url, Some(&dev), false).is_err());
            assert!(authorize_identity("main", "project-1", &url, Some(&dev), false).is_err());
        }
        for url in [
            "https://example.com/",
            "https://tauri.localhost.example.com/",
            "http://tauri.localhost:8787/",
            "tauri://localhost:8787/",
            "http://user@tauri.localhost/",
            "tauri://other/",
            "file:///tmp/index.html",
            "http://localhost:1420/",
        ] {
            assert!(authorize_identity(
                "main",
                "main",
                &tauri::Url::parse(url).unwrap(),
                Some(&dev),
                false
            )
            .is_err());
        }
        assert!(authorize_identity("main", "main", &dev, Some(&dev), true).is_ok());
        assert!(authorize_identity("main", "main", &dev, None, true).is_err());
        assert!(!local_caller_url(
            &tauri::Url::parse("http://localhost:1421/").unwrap(),
            Some(&dev),
            true
        ));
        assert!(!local_caller_url(
            &tauri::Url::parse("tauri://localhost/").unwrap(),
            Some(&dev),
            true
        ));
    }
    #[test]
    fn editor_capture_denial_fault_and_vanished_have_distinct_results() {
        assert!(source_candidates::<u8>(Err(CaptureError::Denied))
            .unwrap()
            .is_none());
        assert_eq!(
            source_candidates::<u8>(Err(CaptureError::Failed("native fault".into())))
                .err()
                .unwrap(),
            "native fault"
        );
        assert!(source_candidates::<u8>(Ok(Vec::new()))
            .unwrap()
            .unwrap()
            .is_empty());
        assert!(capture_result(Ok(None)).unwrap().is_none());
        assert!(capture_result(Err(CaptureError::Denied)).is_err());
        assert_eq!(
            capture_result(Err(CaptureError::Failed("native fault".into())))
                .err()
                .unwrap(),
            "native fault"
        );
    }
    #[test]
    fn editor_capture_choice_is_caller_bound_and_single_use() {
        let mut state = registry();
        let now = Instant::now();
        let (list, _) = state
            .publish("main", vec![candidate(42), candidate(43)], now)
            .unwrap();
        let id = &list.sources[0].id;
        assert_eq!(id.len(), 32);
        assert!(state.take("project-1", id, now).is_err());
        assert!(state.take("main", "1234", now).is_err());
        assert_eq!(state.take("main", id, now).unwrap(), 42);
        assert!(state.take("main", &list.sources[1].id, now).is_err());
    }
    #[test]
    fn editor_capture_refresh_expiry_and_close_revoke_choices() {
        let mut state = registry();
        let now = Instant::now();
        let (old, old_generation) = state.publish("main", vec![candidate(1)], now).unwrap();
        let (new, _) = state.publish("main", vec![candidate(2)], now).unwrap();
        state.expire("main", old_generation);
        assert!(state.take("main", &old.sources[0].id, now).is_err());
        assert_eq!(state.take("main", &new.sources[0].id, now).unwrap(), 2);
        let (expired, _) = state.publish("main", vec![candidate(3)], now).unwrap();
        assert!(state
            .take("main", &expired.sources[0].id, now + LIST_TTL)
            .is_err());
        let (closed, _) = state.publish("main", vec![candidate(4)], now).unwrap();
        state.clear("main");
        state.watched_callers.clear();
        assert!(state.take("main", &closed.sources[0].id, now).is_err());
        assert!(state.publish("main", vec![candidate(5)], now).is_err());
    }
    #[test]
    fn editor_capture_releases_other_choices_refresh_and_expiry() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        struct Probe(Arc<AtomicUsize>);
        impl Drop for Probe {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let count = Arc::new(AtomicUsize::new(0));
        let candidate = || Candidate {
            name: String::new(),
            kind: SourceKind::Screen,
            thumbnail: String::new(),
            target: Probe(count.clone()),
        };
        let mut state = Selections {
            lists: Vec::new(),
            watched_callers: vec!["main".into()],
        };
        let now = Instant::now();
        let (list, _) = state
            .publish("main", vec![candidate(), candidate()], now)
            .unwrap();
        let selected = state.take("main", &list.sources[0].id, now).unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
        drop(selected);
        assert_eq!(count.load(Ordering::SeqCst), 2);
        state.publish("main", vec![candidate()], now).unwrap();
        let (_, generation) = state.publish("main", vec![candidate()], now).unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 3);
        state.expire("main", generation);
        assert_eq!(count.load(Ordering::SeqCst), 4);
        assert!(state
            .publish(
                "main",
                (0..=MAX_SOURCES).map(|_| candidate()).collect(),
                now
            )
            .is_err());
    }
    #[test]
    fn editor_capture_png_dimensions_and_exact_budget() {
        assert!(MAX_PNG_BYTES.div_ceil(3) * 4 <= 28_000_000); // Upstream base64 schema.
        assert!(dimensions(7680, 4320).is_ok());
        for size in [
            (0, 10),
            (10, 0),
            (16_385, 1),
            (10_000, 10_000),
            (u32::MAX, u32::MAX),
        ] {
            assert!(dimensions(size.0, size.1).is_err());
        }
        let image = RgbaImage::from_pixel(2, 3, image::Rgba([32, 64, 128, 255]));
        let bytes = png(&image, MAX_PNG_BYTES).unwrap();
        // Include every partial IEND write, whose error the dependency drops.
        for limit in 0..bytes.len() {
            assert!(png(&image, limit).is_err(), "accepted PNG budget {limit}");
        }
        assert_eq!(png(&image, bytes.len()).unwrap(), bytes);
        assert!(bytes.ends_with(&[0, 0, 0, 0, b'I', b'E', b'N', b'D', 174, 66, 96, 130]));
        assert_eq!(image::load_from_memory(&bytes).unwrap().to_rgba8(), image);
        let result = encode_capture(image).unwrap();
        let decoded = image::load_from_memory(
            &base64::engine::general_purpose::STANDARD
                .decode(result.base64)
                .unwrap(),
        )
        .unwrap();
        assert_eq!((decoded.width(), decoded.height()), (2, 3));
        let mut sink = BoundedPng {
            bytes: vec![0; MAX_PNG_BYTES - 1],
            limit: MAX_PNG_BYTES,
            overflowed: false,
        };
        assert_eq!(sink.write(&[1]).unwrap(), 1);
        assert!(sink.write(&[2]).is_err());
        assert!(sink.overflowed);
        assert_eq!(sink.bytes.len(), MAX_PNG_BYTES);
    }
    #[test]
    fn editor_capture_thumbnail_stays_small_and_contract_is_png() {
        for (source, expected) in [
            ((1000, 1000), (180, 180)),
            ((400, 100), (320, 80)),
            ((100, 400), (45, 180)),
            ((1, 1000), (1, 180)),
            ((1000, 1), (320, 1)),
            ((1, 1), (1, 1)),
        ] {
            let image = RgbaImage::new(source.0, source.1);
            let data = thumbnail(&image).unwrap();
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data.strip_prefix("data:image/png;base64,").unwrap())
                .unwrap();
            assert!(bytes.len() <= 256 * 1024);
            let decoded = image::load_from_memory(&bytes).unwrap();
            assert_eq!((decoded.width(), decoded.height()), expected);
        }
        let result = serde_json::to_value(encode_capture(RgbaImage::new(1, 1)).unwrap()).unwrap();
        assert_eq!(result["mediaType"], "image/png");
        assert!(result.get("media_type").is_none());
        assert_eq!(CaptureError::Denied.message(), "系统拒绝了屏幕截图权限");
        assert_eq!(
            CaptureError::Failed("native error".into()).message(),
            "native error"
        );
    }
}
