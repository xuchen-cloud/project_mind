use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
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
}

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
}

#[tauri::command]
pub fn desktop_resolve_export_image(
    input: ResolveExportImageInput,
) -> CommandResult<ResolvedExportImage> {
    resolve_export_image(input).map_err(|error| error.to_string())
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
pub fn desktop_write_export_file(input: WriteExportFileInput) -> CommandResult<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(input.data_base64.trim())
        .context("导出数据不是有效的 Base64")
        .map_err(|error| error.to_string())?;
    atomic_write_export(
        Path::new(input.target_path.trim()),
        &bytes,
        input.overwrite.unwrap_or(false),
    )
    .map(|path| path.to_string_lossy().into_owned())
    .map_err(|error| error.to_string())
}

fn resolve_export_image(input: ResolveExportImageInput) -> Result<ResolvedExportImage> {
    let (bytes, response_mime) = read_export_image(&input)?;
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

fn read_export_image(input: &ResolveExportImageInput) -> Result<(Vec<u8>, Option<String>)> {
    if let Some(path) = input
        .path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let target = Path::new(path);
        let bytes =
            fs::read(target).with_context(|| format!("无法读取图片 {}", target.display()))?;
        return Ok((bytes, None));
    }

    let source = input.source.as_deref().map(str::trim).unwrap_or_default();
    if let Some(data) = source.strip_prefix("data:") {
        return decode_data_url(data).map(|(bytes, mime)| (bytes, Some(mime)));
    }
    if source.starts_with("https://") || source.starts_with("http://") {
        let response = reqwest::blocking::Client::builder()
            .user_agent("Project-Mind-Record-Export/1.0")
            .build()?
            .get(source)
            .send()
            .with_context(|| format!("无法读取远程图片 {source}"))?
            .error_for_status()
            .with_context(|| format!("远程图片返回错误 {source}"))?;
        let mime = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(str::trim)
            .filter(|value| value.starts_with("image/"))
            .map(ToOwned::to_owned);
        let mut reader = response;
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes)?;
        return Ok((bytes, mime));
    }

    bail!("图片没有可读取的本地路径、data URL 或 HTTP/HTTPS 来源")
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
        let should_remove = marker == 0xe1 || marker == 0xed || marker == 0xfe;
        if !should_remove {
            output.extend_from_slice(&bytes[marker_start..offset + length]);
        }
        offset += length;
    }
    Ok(output)
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
                offset = skip_gif_sub_blocks(bytes, offset)?;
                if label != 0xfe {
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
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;

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
    provided
        .map(str::trim)
        .filter(|value| value.starts_with("image/"))
        .map(ToOwned::to_owned)
        .or_else(|| {
            source.and_then(|value| {
                mime_guess::from_path(value)
                    .first_raw()
                    .map(ToOwned::to_owned)
            })
        })
        .or_else(|| {
            image::guess_format(bytes)
                .ok()
                .map(|format| format.to_mime_type().to_string())
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
}
