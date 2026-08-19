use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::Duration,
};

use anyhow::{bail, Context, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};

type CommandResult<T> = std::result::Result<T, String>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveExportImageInput {
    pub source: Option<String>,
    pub path: Option<String>,
    pub mime_type: Option<String>,
    pub request_id: Option<String>,
}

static IMAGE_REQUEST_CANCELLATIONS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Notify>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static WRITE_REQUEST_CANCELLATIONS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedExportImage {
    pub data_base64: String,
    pub mime_type: String,
    pub extension: String,
    pub width_px: Option<u32>,
    pub height_px: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteExportFileInput {
    pub target_path: String,
    pub data_base64: String,
    pub overwrite: Option<bool>,
    pub request_id: Option<String>,
}

#[tauri::command]
pub async fn desktop_resolve_export_image(
    input: ResolveExportImageInput,
) -> CommandResult<ResolvedExportImage> {
    resolve_export_image(input)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_cancel_export_image(request_id: String) {
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return;
    }
    let cancel = IMAGE_REQUEST_CANCELLATIONS
        .lock()
        .expect("image cancellation lock poisoned")
        .entry(request_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Notify::new()))
        .clone();
    cancel.notify_one();
    let cleanup_id = request_id.to_string();
    let cleanup_cancel = cancel.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(65)).await;
        let mut requests = IMAGE_REQUEST_CANCELLATIONS
            .lock()
            .expect("image cancellation lock poisoned");
        if requests
            .get(&cleanup_id)
            .is_some_and(|current| Arc::ptr_eq(current, &cleanup_cancel))
        {
            requests.remove(&cleanup_id);
        }
    });
}

#[tauri::command]
pub fn desktop_export_available_bytes(target_path: String) -> CommandResult<u64> {
    let parent = export_parent(Path::new(target_path.trim())).map_err(|error| error.to_string())?;
    fs2::available_space(parent).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_export_path_exists(path: String) -> bool {
    Path::new(path.trim()).exists()
}

#[tauri::command]
pub fn desktop_next_available_export_path(path: String) -> CommandResult<String> {
    next_available_export_path(Path::new(path.trim()))
        .map(|value| value.to_string_lossy().into_owned())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn desktop_write_export_file(input: WriteExportFileInput) -> CommandResult<String> {
    let request_id = input
        .request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let cancelled = request_id.map(|request_id| {
        WRITE_REQUEST_CANCELLATIONS
            .lock()
            .expect("write cancellation lock poisoned")
            .entry(request_id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    });
    let target_path = input.target_path.trim().to_string();
    let data_base64 = input.data_base64.trim().to_string();
    let overwrite = input.overwrite.unwrap_or(false);
    let write_cancelled = cancelled.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_base64)
            .context("导出数据不是有效的 Base64")?;
        atomic_write_export_with_cancel(
            Path::new(&target_path),
            &bytes,
            overwrite,
            write_cancelled.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("导出写入任务失败：{error}"))?;
    if let Some(request_id) = request_id {
        WRITE_REQUEST_CANCELLATIONS
            .lock()
            .expect("write cancellation lock poisoned")
            .remove(request_id);
    }
    result
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_cancel_export_write(request_id: String) {
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return;
    }
    WRITE_REQUEST_CANCELLATIONS
        .lock()
        .expect("write cancellation lock poisoned")
        .entry(request_id.to_string())
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .store(true, Ordering::Release);
}

async fn resolve_export_image(input: ResolveExportImageInput) -> Result<ResolvedExportImage> {
    let (bytes, response_mime) = read_export_image(&input).await?;
    let mime_type = normalized_mime(
        input.mime_type.as_deref().or(response_mime.as_deref()),
        input.path.as_deref().or(input.source.as_deref()),
        &bytes,
    );
    let extension = extension_for_mime(&mime_type)
        .or_else(|| image::guess_format(&bytes).ok().map(image_extension))
        .unwrap_or_else(|| "bin".to_string());
    let sanitized = sanitize_image_metadata(&bytes, &extension)?;
    let dimensions = image::load_from_memory(&sanitized)
        .ok()
        .map(|image| (image.width(), image.height()));

    Ok(ResolvedExportImage {
        data_base64: base64::engine::general_purpose::STANDARD.encode(sanitized),
        mime_type,
        extension,
        width_px: dimensions.map(|value| value.0),
        height_px: dimensions.map(|value| value.1),
    })
}

fn next_available_export_path(path: &Path) -> Result<PathBuf> {
    if !path.exists() {
        return Ok(path.to_path_buf());
    }
    let parent = export_parent(path)?;
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("未命名记录");
    let extension = path.extension().and_then(|value| value.to_str());
    for number in 2..=u32::MAX {
        let name = match extension {
            Some(value) if !value.is_empty() => format!("{stem}-{number}.{value}"),
            _ => format!("{stem}-{number}"),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    bail!("无法为导出文件生成可用名称")
}

async fn read_export_image(input: &ResolveExportImageInput) -> Result<(Vec<u8>, Option<String>)> {
    let request_id = input
        .request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let cancel = cancellation_for_request(request_id);
    if let Some(path) = input
        .path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let target = Path::new(path);
        let read_result = tokio::select! {
            biased;
            _ = cancel.notified() => {
                cleanup_image_request(request_id);
                bail!("图片读取已取消")
            }
            bytes = tokio::fs::read(target) => bytes,
        };
        cleanup_image_request(request_id);
        let bytes = read_result.with_context(|| format!("无法读取图片 {}", target.display()))?;
        return Ok((bytes, None));
    }

    let source = input.source.as_deref().map(str::trim).unwrap_or_default();
    if let Some(data) = source.strip_prefix("data:") {
        let result = decode_data_url(data).map(|(bytes, mime)| (bytes, Some(mime)));
        cleanup_image_request(request_id);
        return result;
    }
    if source.starts_with("https://") || source.starts_with("http://") {
        let client = match reqwest::Client::builder()
            .user_agent("Project-Mind-Record-Export/1.0")
            .timeout(Duration::from_secs(60))
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                cleanup_image_request(request_id);
                return Err(error.into());
            }
        };
        let response_result = tokio::select! {
            biased;
            _ = cancel.notified() => {
                cleanup_image_request(request_id);
                bail!("图片读取已取消")
            }
            response = client.get(source).send() => response,
        };
        let response = match response_result
            .with_context(|| format!("无法读取远程图片 {source}"))
            .and_then(|response| {
                response
                    .error_for_status()
                    .with_context(|| format!("远程图片返回错误 {source}"))
            }) {
            Ok(response) => response,
            Err(error) => {
                cleanup_image_request(request_id);
                return Err(error);
            }
        };
        let mime = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(str::trim)
            .filter(|value| value.starts_with("image/"))
            .map(ToOwned::to_owned);
        let bytes_result = tokio::select! {
            biased;
            _ = cancel.notified() => {
                cleanup_image_request(request_id);
                bail!("图片读取已取消")
            }
            bytes = response.bytes() => bytes,
        };
        cleanup_image_request(request_id);
        return Ok((bytes_result?.to_vec(), mime));
    }

    cleanup_image_request(request_id);
    bail!("图片没有可读取的本地路径、data URL 或 HTTP/HTTPS 来源")
}

fn cancellation_for_request(request_id: Option<&str>) -> Arc<tokio::sync::Notify> {
    request_id
        .map(|request_id| {
            IMAGE_REQUEST_CANCELLATIONS
                .lock()
                .expect("image cancellation lock poisoned")
                .entry(request_id.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Notify::new()))
                .clone()
        })
        .unwrap_or_else(|| Arc::new(tokio::sync::Notify::new()))
}

fn cleanup_image_request(request_id: Option<&str>) {
    if let Some(request_id) = request_id {
        IMAGE_REQUEST_CANCELLATIONS
            .lock()
            .expect("image cancellation lock poisoned")
            .remove(request_id);
    }
}

fn decode_data_url(value: &str) -> Result<(Vec<u8>, String)> {
    let (header, payload) = value.split_once(',').context("data URL 缺少内容")?;
    let mime = header
        .split(';')
        .next()
        .map(str::trim)
        .filter(|value| value.starts_with("image/"))
        .unwrap_or("application/octet-stream")
        .to_string();
    if header
        .split(';')
        .any(|part| part.eq_ignore_ascii_case("base64"))
    {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload.trim())
            .context("data URL Base64 无效")?;
        return Ok((bytes, mime));
    }
    bail!("仅支持 Base64 图片 data URL")
}

fn sanitize_image_metadata(bytes: &[u8], extension: &str) -> Result<Vec<u8>> {
    match extension {
        "jpg" | "jpeg" => strip_jpeg_metadata(bytes),
        "png" => strip_png_metadata(bytes),
        "webp" => strip_webp_metadata(bytes),
        "gif" => strip_gif_comments(bytes),
        _ => Ok(bytes.to_vec()),
    }
}

fn strip_jpeg_metadata(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.len() < 2 || bytes[..2] != [0xff, 0xd8] {
        bail!("JPEG 文件头无效")
    }
    let mut output = bytes[..2].to_vec();
    let mut visual_orientation = None;
    let mut offset = 2;
    while offset < bytes.len() {
        if bytes[offset] != 0xff {
            output.extend_from_slice(&bytes[offset..]);
            break;
        }
        let marker_start = offset;
        while offset < bytes.len() && bytes[offset] == 0xff {
            offset += 1;
        }
        if offset >= bytes.len() {
            bail!("JPEG 标记不完整")
        }
        let marker = bytes[offset];
        offset += 1;
        if marker == 0xda || marker == 0xd9 {
            output.extend_from_slice(&bytes[marker_start..]);
            break;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            output.extend_from_slice(&bytes[marker_start..offset]);
            continue;
        }
        if offset + 2 > bytes.len() {
            bail!("JPEG 段长度缺失")
        }
        let length = u16::from_be_bytes([bytes[offset], bytes[offset + 1]]) as usize;
        if length < 2 || offset + length > bytes.len() {
            bail!("JPEG 段长度无效")
        }
        if marker == 0xe1 {
            let payload = &bytes[offset + 2..offset + length];
            if let Some(exif) = payload.strip_prefix(b"Exif\0\0") {
                visual_orientation = image::metadata::Orientation::from_exif_chunk(exif)
                    .map(image::metadata::Orientation::to_exif)
                    .filter(|value| *value != 1)
                    .or(visual_orientation);
            }
        }
        let should_remove = marker == 0xe1 || marker == 0xed || marker == 0xfe;
        if !should_remove {
            output.extend_from_slice(&bytes[marker_start..offset + length]);
        }
        offset += length;
    }
    if let Some(orientation) = visual_orientation {
        output.splice(2..2, minimal_exif_orientation_segment(orientation));
    }
    Ok(output)
}

fn minimal_exif_orientation_segment(orientation: u8) -> Vec<u8> {
    vec![
        0xff,
        0xe1,
        0x00,
        0x22,
        b'E',
        b'x',
        b'i',
        b'f',
        0,
        0,
        b'M',
        b'M',
        0,
        42,
        0,
        0,
        0,
        8,
        0,
        1,
        0x01,
        0x12,
        0,
        3,
        0,
        0,
        0,
        1,
        0,
        orientation,
        0,
        0,
        0,
        0,
        0,
        0,
    ]
}

fn strip_png_metadata(bytes: &[u8]) -> Result<Vec<u8>> {
    const SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if !bytes.starts_with(SIGNATURE) {
        bail!("PNG 文件头无效")
    }
    let mut output = SIGNATURE.to_vec();
    let mut offset = 8;
    while offset + 12 <= bytes.len() {
        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let end = offset + 12 + length;
        if end > bytes.len() {
            bail!("PNG chunk 长度无效")
        }
        let kind = &bytes[offset + 4..offset + 8];
        if !matches!(kind, b"eXIf" | b"tEXt" | b"zTXt" | b"iTXt" | b"tIME") {
            output.extend_from_slice(&bytes[offset..end]);
        }
        offset = end;
        if kind == b"IEND" {
            return Ok(output);
        }
    }
    bail!("PNG 缺少完整 IEND")
}

fn strip_webp_metadata(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        bail!("WebP 文件头无效")
    }
    let mut output = bytes[..12].to_vec();
    let mut offset = 12;
    while offset + 8 <= bytes.len() {
        let length = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let padded = length + (length % 2);
        let end = offset + 8 + padded;
        if end > bytes.len() {
            bail!("WebP chunk 长度无效")
        }
        let kind = &bytes[offset..offset + 4];
        if kind != b"EXIF" && kind != b"XMP " {
            let output_start = output.len();
            output.extend_from_slice(&bytes[offset..end]);
            if kind == b"VP8X" && length >= 10 {
                output[output_start + 8] &= !0x0c;
            }
        }
        offset = end;
    }
    let riff_size = (output.len() - 8) as u32;
    output[4..8].copy_from_slice(&riff_size.to_le_bytes());
    Ok(output)
}

fn strip_gif_comments(bytes: &[u8]) -> Result<Vec<u8>> {
    if !bytes.starts_with(b"GIF87a") && !bytes.starts_with(b"GIF89a") {
        bail!("GIF 文件头无效")
    }
    if bytes.len() < 13 {
        bail!("GIF 逻辑屏幕描述符不完整")
    }
    let global_table_bytes = if bytes[10] & 0x80 != 0 {
        3usize << ((bytes[10] & 0x07) + 1)
    } else {
        0
    };
    let header_end = 13 + global_table_bytes;
    if header_end > bytes.len() {
        bail!("GIF 全局颜色表不完整")
    }
    let mut output = bytes[..header_end].to_vec();
    let mut offset = header_end;
    while offset < bytes.len() {
        match bytes[offset] {
            0x3b => {
                output.push(0x3b);
                return Ok(output);
            }
            0x21 => {
                let label = *bytes.get(offset + 1).context("GIF 扩展块不完整")?;
                let start = offset;
                offset += 2;
                let application_id = if label == 0xff {
                    let size = *bytes.get(offset).context("GIF 应用扩展块不完整")? as usize;
                    bytes.get(offset + 1..offset + 1 + size)
                } else {
                    None
                };
                offset = skip_gif_sub_blocks(bytes, offset)?;
                let keeps_visual_animation_control =
                    application_id.is_some_and(|id| id == b"NETSCAPE2.0" || id == b"ANIMEXTS1.0");
                if label != 0xfe && (label != 0xff || keeps_visual_animation_control) {
                    output.extend_from_slice(&bytes[start..offset]);
                }
            }
            0x2c => {
                if offset + 10 > bytes.len() {
                    bail!("GIF 图像描述符不完整")
                }
                let local_table_bytes = if bytes[offset + 9] & 0x80 != 0 {
                    3usize << ((bytes[offset + 9] & 0x07) + 1)
                } else {
                    0
                };
                let data_start = offset + 10 + local_table_bytes;
                if data_start >= bytes.len() {
                    bail!("GIF 图像数据不完整")
                }
                let start = offset;
                offset = skip_gif_sub_blocks(bytes, data_start + 1)?;
                output.extend_from_slice(&bytes[start..offset]);
            }
            _ => bail!("GIF 包含未知数据块"),
        }
    }
    bail!("GIF 缺少结束标记")
}

fn skip_gif_sub_blocks(bytes: &[u8], mut offset: usize) -> Result<usize> {
    loop {
        let size = *bytes.get(offset).context("GIF 数据子块不完整")? as usize;
        offset += 1;
        if size == 0 {
            return Ok(offset);
        }
        offset = offset.checked_add(size).context("GIF 数据子块溢出")?;
        if offset > bytes.len() {
            bail!("GIF 数据子块长度无效")
        }
    }
}

fn atomic_write_export(target: &Path, bytes: &[u8], overwrite: bool) -> Result<PathBuf> {
    atomic_write_export_with_cancel(target, bytes, overwrite, None)
}

fn atomic_write_export_with_cancel(
    target: &Path,
    bytes: &[u8],
    overwrite: bool,
    cancelled: Option<&AtomicBool>,
) -> Result<PathBuf> {
    atomic_write_export_with_cancel_hook(target, bytes, overwrite, cancelled, |_| {})
}

fn atomic_write_export_with_cancel_hook(
    target: &Path,
    bytes: &[u8],
    overwrite: bool,
    cancelled: Option<&AtomicBool>,
    mut after_chunk: impl FnMut(usize),
) -> Result<PathBuf> {
    if target.as_os_str().is_empty() {
        bail!("导出目标路径为空")
    }
    let parent = export_parent(target)?;
    if target.exists() && !overwrite {
        bail!("目标文件已存在，需要明确确认覆盖")
    }
    let available = fs2::available_space(parent)?;
    let required = (bytes.len() as u64).saturating_mul(2).max(1_048_576);
    if available < required {
        bail!("可用磁盘空间不足，无法完成导出")
    }

    let mut temporary = tempfile::Builder::new()
        .prefix(".project-mind-export-")
        .tempfile_in(parent)
        .with_context(|| format!("无法在 {} 创建临时导出文件", parent.display()))?;
    for (index, chunk) in bytes.chunks(1024 * 1024).enumerate() {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            bail!("导出写入已取消")
        }
        temporary.write_all(chunk)?;
        after_chunk(index);
    }
    temporary.as_file().sync_all()?;

    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        bail!("导出写入已取消")
    }

    persist_atomic(temporary, target, overwrite)?;
    if let Ok(directory) = fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(target.to_path_buf())
}

#[cfg(not(target_os = "windows"))]
fn persist_atomic(
    temporary: tempfile::NamedTempFile,
    target: &Path,
    overwrite: bool,
) -> Result<()> {
    if overwrite {
        temporary.persist(target)?;
    } else {
        temporary.persist_noclobber(target)?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn persist_atomic(
    temporary: tempfile::NamedTempFile,
    target: &Path,
    overwrite: bool,
) -> Result<()> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    if !target.exists() {
        temporary.persist_noclobber(target)?;
        return Ok(());
    }
    if !overwrite {
        bail!("目标文件已存在，需要明确确认覆盖")
    }
    let (file, temporary_path) = temporary.keep()?;
    drop(file);
    let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let temporary_wide: Vec<u16> = temporary_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        ReplaceFileW(
            target_wide.as_ptr(),
            temporary_wide.as_ptr(),
            ptr::null(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if result == 0 {
        let error = std::io::Error::last_os_error();
        let _ = fs::remove_file(&temporary_path);
        return Err(error.into());
    }
    Ok(())
}

fn export_parent(target: &Path) -> Result<&Path> {
    let parent = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    if !parent.is_dir() {
        bail!("导出目录不存在：{}", parent.display())
    }
    Ok(parent)
}

fn normalized_mime(provided: Option<&str>, source: Option<&str>, bytes: &[u8]) -> String {
    image::guess_format(bytes)
        .ok()
        .map(|format| format.to_mime_type().to_string())
        .or_else(|| {
            provided
                .map(str::trim)
                .filter(|value| value.starts_with("image/"))
                .map(ToOwned::to_owned)
        })
        .or_else(|| {
            source.and_then(|value| {
                mime_guess::from_path(value)
                    .first_raw()
                    .map(ToOwned::to_owned)
            })
        })
        .unwrap_or_else(|| "application/octet-stream".to_string())
}

fn extension_for_mime(mime: &str) -> Option<String> {
    match mime {
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        "image/svg+xml" => Some("svg"),
        "image/heic" => Some("heic"),
        "image/heif" => Some("heif"),
        _ => None,
    }
    .map(ToOwned::to_owned)
}

fn image_extension(format: image::ImageFormat) -> String {
    match format {
        image::ImageFormat::Jpeg => "jpg",
        image::ImageFormat::Png => "png",
        image::ImageFormat::Gif => "gif",
        image::ImageFormat::WebP => "webp",
        image::ImageFormat::Bmp => "bmp",
        _ => "bin",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn jpeg_metadata_is_removed_without_reencoding_scan_data() {
        let input = [
            0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, b'E', b'x', b'i', b'f', 0, 0, 0xff, 0xe0, 0x00,
            0x04, b'J', b'F', 0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x11, 0x22, 0xff, 0xd9,
        ];
        let output = strip_jpeg_metadata(&input).unwrap();
        assert!(!output.windows(4).any(|window| window == b"Exif"));
        assert!(output.ends_with(&[0x11, 0x22, 0xff, 0xd9]));
    }

    #[test]
    fn base64_data_urls_are_decoded_with_their_image_mime_type() {
        let (bytes, mime) = decode_data_url("image/png;base64,iVBORw0KGgo=").unwrap();
        assert_eq!(bytes, [137, 80, 78, 71, 13, 10, 26, 10]);
        assert_eq!(mime, "image/png");
    }

    #[test]
    fn jpeg_privacy_cleanup_keeps_only_visual_orientation_from_exif() {
        let mut input = vec![0xff, 0xd8];
        input.extend(minimal_exif_orientation_segment(6));
        input.extend([0xff, 0xfe, 0x00, 0x0d]);
        input.extend(b"GPS 31.2304");
        input.extend([0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x11, 0x22, 0xff, 0xd9]);

        let output = strip_jpeg_metadata(&input).unwrap();
        assert!(!output.windows(3).any(|window| window == b"GPS"));
        assert_eq!(output[2..38], minimal_exif_orientation_segment(6));
        assert!(output.ends_with(&[0x11, 0x22, 0xff, 0xd9]));
    }

    #[tokio::test]
    async fn cancellation_is_remembered_when_it_arrives_before_the_remote_request_starts() {
        desktop_cancel_export_image("early-cancel".to_string());
        let cancel = IMAGE_REQUEST_CANCELLATIONS
            .lock()
            .unwrap()
            .get("early-cancel")
            .unwrap()
            .clone();
        assert!(
            tokio::time::timeout(Duration::from_millis(20), cancel.notified())
                .await
                .is_ok()
        );
        cleanup_image_request(Some("early-cancel"));
    }

    #[tokio::test]
    async fn cancellation_stops_a_local_image_read_before_bytes_are_returned() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large-image.png");
        fs::write(&path, vec![0u8; 1024 * 1024]).unwrap();
        desktop_cancel_export_image("cancel-local".to_string());
        let input = ResolveExportImageInput {
            source: None,
            path: Some(path.to_string_lossy().into_owned()),
            mime_type: Some("image/png".to_string()),
            request_id: Some("cancel-local".to_string()),
        };

        assert!(read_export_image(&input)
            .await
            .unwrap_err()
            .to_string()
            .contains("已取消"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unreadable_local_images_return_a_structured_read_error() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("private.png");
        fs::write(&path, b"private").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        let input = ResolveExportImageInput {
            source: None,
            path: Some(path.to_string_lossy().into_owned()),
            mime_type: Some("image/png".to_string()),
            request_id: Some("permission-denied".to_string()),
        };

        let error = read_export_image(&input).await.unwrap_err().to_string();
        assert!(error.contains("无法读取图片"));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    #[test]
    fn failed_or_unconfirmed_writes_preserve_existing_target_and_clean_temporary_files() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("record.md");
        fs::write(&target, b"original").unwrap();

        assert!(atomic_write_export(&target, b"replacement", false).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"original");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);

        atomic_write_export(&target, b"replacement", true).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"replacement");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn cancellation_after_writing_has_started_preserves_target_and_removes_temporary_file() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("cancelled.pdf");
        fs::write(&target, b"original").unwrap();
        let cancelled = AtomicBool::new(false);
        let result = atomic_write_export_with_cancel_hook(
            &target,
            &vec![1u8; 3_000_000],
            true,
            Some(&cancelled),
            |index| {
                if index == 0 {
                    cancelled.store(true, Ordering::Release);
                }
            },
        );

        assert!(result.unwrap_err().to_string().contains("已取消"));
        assert_eq!(fs::read(&target).unwrap(), b"original");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn collisions_receive_the_first_available_portable_suffix() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("记录.md");
        fs::write(&target, b"one").unwrap();
        fs::write(directory.path().join("记录-2.md"), b"two").unwrap();

        assert_eq!(
            next_available_export_path(&target).unwrap(),
            directory.path().join("记录-3.md")
        );
    }

    #[test]
    fn gif_comments_are_removed_without_scanning_compressed_image_bytes_as_extensions() {
        let input = [
            b'G', b'I', b'F', b'8', b'9', b'a', 1, 0, 1, 0, 0, 0, 0, 0x21, 0xfe, 3, b'g', b'p',
            b's', 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 3, 0x21, 0xfe, 0x01, 0, 0x3b,
        ];
        let output = strip_gif_comments(&input).unwrap();
        assert!(!output
            .windows(5)
            .any(|window| window == [0x21, 0xfe, 3, b'g', b'p']));
        assert!(output.windows(3).any(|window| window == [0x21, 0xfe, 0x01]));
        assert_eq!(output.last(), Some(&0x3b));
    }

    #[test]
    fn gif_privacy_cleanup_removes_metadata_extensions_but_keeps_animation_looping() {
        let mut input = b"GIF89a\x01\0\x01\0\0\0\0".to_vec();
        input.extend([0x21, 0xff, 0x0b]);
        input.extend(b"NETSCAPE2.0");
        input.extend([0x03, 0x01, 0x00, 0x00, 0x00]);
        input.extend([0x21, 0xff, 0x0b]);
        input.extend(b"XMP DataXMP");
        input.extend([0x03, b'g', b'p', b's', 0x00, 0x3b]);

        let output = strip_gif_comments(&input).unwrap();
        assert!(output.windows(11).any(|window| window == b"NETSCAPE2.0"));
        assert!(!output.windows(11).any(|window| window == b"XMP DataXMP"));
        assert!(!output.windows(3).any(|window| window == b"gps"));
    }

    #[tokio::test]
    async fn remote_images_are_read_with_response_mime_and_without_sending_record_content() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let read = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("GET /image HTTP/1.1"));
            assert!(!request.contains("private record body"));
            let png = b"\x89PNG\r\n\x1a\n";
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                png.len()
            )
            .unwrap();
            stream.write_all(png).unwrap();
        });
        let input = ResolveExportImageInput {
            source: Some(format!("http://{address}/image")),
            path: None,
            mime_type: None,
            request_id: Some("remote-success".to_string()),
        };

        let (bytes, mime) = read_export_image(&input).await.unwrap();
        assert_eq!(bytes, b"\x89PNG\r\n\x1a\n");
        assert_eq!(mime.as_deref(), Some("image/png"));
        server.join().unwrap();
    }
}
