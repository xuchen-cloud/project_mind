use super::{
    dimensions, thumbnail, Candidate, CaptureError, NativeResult, SourceKind, MAX_SOURCES,
    THUMB_HEIGHT, THUMB_WIDTH,
};
use image::RgbaImage;
use screencapturekit::{
    error::SCError,
    prelude::{SCContentFilter, SCShareableContent, SCStreamConfiguration},
    screenshot_manager::{CGImageExt, SCScreenshotManager},
    shareable_content::{SCDisplay, SCWindow},
};

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

pub enum Target {
    Screen(SCDisplay),
    Window(SCWindow),
}

fn permission(request: bool) -> NativeResult<()> {
    let granted =
        unsafe { CGPreflightScreenCaptureAccess() || (request && CGRequestScreenCaptureAccess()) };
    if granted {
        Ok(())
    } else {
        Err(CaptureError::Denied)
    }
}
fn native_error(error: SCError) -> CaptureError {
    // The crate's screenshot callback exposes localized text, not NSError codes.
    // Recheck the actual OS grant, never classify a localized string as denial.
    if permission(false).is_err() {
        CaptureError::Denied
    } else {
        CaptureError::Failed(format!("ScreenCaptureKit 截图失败：{error}"))
    }
}
fn content() -> NativeResult<SCShareableContent> {
    SCShareableContent::create()
        .with_exclude_desktop_windows(true)
        .with_on_screen_windows_only(true)
        .get()
        .map_err(native_error)
}

impl Target {
    fn kind(&self) -> SourceKind {
        match self {
            Self::Screen(_) => SourceKind::Screen,
            Self::Window(_) => SourceKind::Window,
        }
    }
    fn name(&self) -> String {
        match self {
            Self::Screen(display) => format!(
                "显示器 {}（{}×{}）",
                display.display_id(),
                display.width(),
                display.height()
            ),
            Self::Window(window) => {
                let app = window
                    .owning_application()
                    .map(|app| app.application_name())
                    .unwrap_or_default();
                let title = window.title().unwrap_or_default();
                if title.is_empty() {
                    app
                } else if app.is_empty() {
                    title
                } else {
                    format!("{title} — {app}")
                }
            }
        }
    }
    fn filter(&self) -> NativeResult<SCContentFilter> {
        let builder = SCContentFilter::create();
        match self {
            Self::Screen(display) => builder.with_display(display).with_excluding_windows(&[]),
            Self::Window(window) => builder.with_window(window),
        }
        .try_build()
        .map_err(native_error)
    }
    fn exists(&self) -> NativeResult<bool> {
        Ok(self.refreshed()?.is_some())
    }
    fn refreshed(&self) -> NativeResult<Option<Self>> {
        let current = content()?;
        Ok(match self {
            Self::Screen(display) => current
                .displays()
                .into_iter()
                .find(|next| next.display_id() == display.display_id())
                .map(Self::Screen),
            Self::Window(window) => current
                .windows()
                .into_iter()
                .find(|next| {
                    next.window_id() == window.window_id()
                        && next.owning_application().map(|app| app.process_id())
                            == window.owning_application().map(|app| app.process_id())
                })
                .map(Self::Window),
        })
    }
}

fn shot(target: &Target, preview: bool) -> NativeResult<RgbaImage> {
    let filter = target.filter()?;
    let rect = filter.content_rect();
    let scale = f64::from(filter.point_pixel_scale());
    let pixel = |value: f64| -> Result<u32, String> {
        let value = (value * scale).ceil();
        if !value.is_finite() || !(1.0..=16_384.0).contains(&value) {
            return Err("ScreenCaptureKit 返回无效或超限尺寸".into());
        }
        Ok(value as u32)
    };
    let (width, height) = (pixel(rect.size.width)?, pixel(rect.size.height)?);
    dimensions(width, height)?;
    let (width, height) = if preview {
        let ratio = (f64::from(THUMB_WIDTH) / f64::from(width))
            .min(f64::from(THUMB_HEIGHT) / f64::from(height))
            .min(1.0);
        (
            (f64::from(width) * ratio).floor().max(1.0) as u32,
            (f64::from(height) * ratio).floor().max(1.0) as u32,
        )
    } else {
        (width, height)
    };
    let config = SCStreamConfiguration::new()
        .with_width(width)
        .with_height(height)
        .with_scales_to_fit(true)
        .with_shows_cursor(false)
        .with_captures_audio(false)
        .with_ignores_shadows_single_window(true);
    let image = SCScreenshotManager::capture_image(&filter, &config).map_err(native_error)?;
    // Check the returned dimensions before allocating an RGBA conversion buffer.
    let (width, height) = (
        u32::try_from(image.width()).map_err(|_| "截图宽度无效".to_string())?,
        u32::try_from(image.height()).map_err(|_| "截图高度无效".to_string())?,
    );
    dimensions(width, height)?;
    let rgba = image.rgba_data().map_err(native_error)?;
    RgbaImage::from_raw(width, height, rgba)
        .ok_or_else(|| CaptureError::Failed("截图像素数据不完整".into()))
}

pub fn sources() -> NativeResult<Vec<Candidate<Target>>> {
    permission(true)?; // Only the explicit source-list action may ask for access.
    let content = content()?;
    let targets = content.displays().into_iter().map(Target::Screen).chain(
        content
            .windows()
            .into_iter()
            .filter(|window| {
                window.is_on_screen()
                    && window.window_layer() == 0
                    && window.owning_application().is_some()
            })
            .map(Target::Window),
    );
    let mut sources = Vec::new();
    for target in targets.take(MAX_SOURCES) {
        let image = match shot(&target, true) {
            Ok(image) => image,
            Err(error) => {
                if !target.exists()? {
                    continue;
                } // Vanished during enumeration.
                return Err(error);
            }
        };
        sources.push(Candidate {
            name: target.name(),
            kind: target.kind(),
            thumbnail: thumbnail(&image)?,
            target,
        });
    }
    Ok(sources)
}

pub fn capture(target: Target) -> NativeResult<Option<RgbaImage>> {
    permission(false)?; // Never re-prompt after the user's source selection.
                        // SCWindow/SCDisplay are immutable listing snapshots. Refresh the selected
                        // identity so a resize/DPI change while choosing does not use old geometry.
    let Some(target) = target.refreshed()? else {
        return Ok(None);
    };
    match shot(&target, false) {
        Ok(image) => Ok(Some(image)),
        Err(error) => {
            if !target.exists()? {
                Ok(None)
            } else {
                Err(error)
            }
        }
    }
}
