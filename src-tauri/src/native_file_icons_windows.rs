//! Windows Shell association handlers are retained on their COM thread between
//! enumeration and guarded invocation. No command strings or executables from
//! the webview are evaluated. Icons come from native resources, including PRI.
use super::{select_application, NativeFileApplication};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{io::Cursor, os::windows::ffi::OsStrExt, path::Path};
use windows::{
    core::{PCWSTR, PWSTR},
    Win32::{
        Graphics::Gdi::{
            CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GdiFlush, SelectObject,
            BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ,
        },
        Storage::FileSystem::FILE_ATTRIBUTE_NORMAL,
        System::Com::{
            CoInitializeEx, CoTaskMemFree, CoUninitialize, IDataObject, COINIT_APARTMENTTHREADED,
        },
        UI::{
            Shell::{
                AssocQueryStringW, BHID_DataObject, ExtractIconExW, IAssocHandler, IShellItem,
                SHAssocEnumHandlers, SHCreateItemFromParsingName, SHGetFileInfoW,
                SHLoadIndirectString, ASSOCF_NONE, ASSOCSTR, ASSOCSTR_EXECUTABLE, ASSOCSTR_PROGID,
                ASSOC_FILTER_NONE, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON,
                SHGFI_USEFILEATTRIBUTES,
            },
            WindowsAndMessaging::{DestroyIcon, DrawIconEx, DI_MASK, DI_NORMAL, HICON},
        },
    },
};

const SIZE: u32 = 64;
const PIXEL_BYTES: usize = (SIZE * SIZE * 4) as usize;

fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

struct Apartment;
impl Apartment {
    fn new() -> Result<Self, String> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() }
            .map_err(|e| e.to_string())?;
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

// Each Shell string is allocated with CoTaskMemAlloc.
unsafe fn shell_string(value: PWSTR) -> Result<String, String> {
    let result = unsafe { value.to_string() }.map_err(|e| e.to_string());
    unsafe { CoTaskMemFree(Some(value.0.cast())) };
    result
}

struct Icon(HICON);
impl Drop for Icon {
    fn drop(&mut self) {
        let _ = unsafe { DestroyIcon(self.0) };
    }
}

struct Bitmap {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut u8,
}
impl Bitmap {
    fn new() -> Result<Self, String> {
        let dc = unsafe { CreateCompatibleDC(None) };
        if dc.0.is_null() {
            return Err("Cannot allocate icon drawing context".into());
        }
        let mut info = BITMAPINFO::default();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: SIZE as i32,
            biHeight: -(SIZE as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let bitmap = match unsafe {
            CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)
        } {
            Ok(bitmap) => bitmap,
            Err(error) => {
                let _ = unsafe { DeleteDC(dc) };
                return Err(error.to_string());
            }
        };
        let previous = unsafe { SelectObject(dc, HGDIOBJ(bitmap.0)) };
        if previous.0.is_null() || previous.0 as isize == -1 {
            let _ = unsafe { DeleteObject(HGDIOBJ(bitmap.0)) };
            let _ = unsafe { DeleteDC(dc) };
            return Err("Cannot select icon bitmap".into());
        }
        Ok(Self {
            dc,
            bitmap,
            previous,
            bits: bits.cast(),
        })
    }
}
impl Drop for Bitmap {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.previous);
            let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
            let _ = DeleteDC(self.dc);
        }
    }
}

fn png(image: image::RgbaImage) -> Result<String, String> {
    let mut output = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(output.into_inner())
    ))
}

fn icon_png(icon: Icon) -> Result<String, String> {
    let bitmap = Bitmap::new()?;
    unsafe { std::ptr::write_bytes(bitmap.bits, 0, PIXEL_BYTES) };
    unsafe {
        DrawIconEx(
            bitmap.dc,
            0,
            0,
            icon.0,
            SIZE as i32,
            SIZE as i32,
            0,
            None,
            DI_NORMAL,
        )
    }
    .map_err(|e| e.to_string())?;
    let _ = unsafe { GdiFlush() };
    let mut pixels = unsafe { std::slice::from_raw_parts(bitmap.bits, PIXEL_BYTES) }.to_vec();
    // Older icon resources use a separate monochrome mask rather than alpha.
    if pixels.chunks_exact(4).all(|pixel| pixel[3] == 0) {
        unsafe { std::ptr::write_bytes(bitmap.bits, 0, PIXEL_BYTES) };
        unsafe {
            DrawIconEx(
                bitmap.dc,
                0,
                0,
                icon.0,
                SIZE as i32,
                SIZE as i32,
                0,
                None,
                DI_MASK,
            )
        }
        .map_err(|e| e.to_string())?;
        let _ = unsafe { GdiFlush() };
        let mask = unsafe { std::slice::from_raw_parts(bitmap.bits, PIXEL_BYTES) };
        for (pixel, mask) in pixels.chunks_exact_mut(4).zip(mask.chunks_exact(4)) {
            pixel[3] = if mask[0] == 0 { 255 } else { 0 };
        }
    } else {
        // DrawIconEx uses premultiplied BGRA; PNG requires straight RGBA.
        for pixel in pixels.chunks_exact_mut(4) {
            let alpha = pixel[3] as u32;
            if alpha > 0 {
                for component in &mut pixel[..3] {
                    *component = ((*component as u32 * 255 + alpha / 2) / alpha).min(255) as u8;
                }
            }
        }
    }
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    png(image::RgbaImage::from_raw(SIZE, SIZE, pixels).expect("fixed icon bitmap size"))
}

pub(super) fn type_icon(extension: &str) -> Result<String, String> {
    let _apartment = Apartment::new()?;
    let filename = if extension.is_empty() {
        "file".to_string()
    } else {
        format!("file.{extension}")
    };
    let filename = wide(filename.as_ref());
    let mut info = SHFILEINFOW::default();
    let result = unsafe {
        SHGetFileInfoW(
            PCWSTR(filename.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON | SHGFI_USEFILEATTRIBUTES,
        )
    };
    if result == 0 || info.hIcon.0.is_null() {
        return Err("Windows type icon lookup failed".into());
    }
    icon_png(Icon(info.hIcon))
}

fn association(extension: &[u16], kind: ASSOCSTR) -> Option<String> {
    let mut buffer = vec![0u16; 32768];
    let mut count = buffer.len() as u32;
    let result = unsafe {
        AssocQueryStringW(
            ASSOCF_NONE,
            kind,
            PCWSTR(extension.as_ptr()),
            PCWSTR::null(),
            Some(PWSTR(buffer.as_mut_ptr())),
            &mut count,
        )
    };
    if !result.is_ok() {
        return None;
    }
    Some(String::from_utf16_lossy(
        &buffer[..buffer.iter().position(|v| *v == 0)?],
    ))
}

fn application_icon(handler: &IAssocHandler) -> Result<Option<String>, String> {
    let mut location = PWSTR::null();
    let mut index = 0;
    // Missing icon is represented by null in the public DTO, never a substitute.
    if unsafe { handler.GetIconLocation(&mut location, &mut index) }.is_err() {
        return Ok(None);
    }
    let location = unsafe { shell_string(location) }?;
    if location.is_empty() {
        return Ok(None);
    }
    if location.starts_with("@{") {
        let source = wide(location.as_ref());
        let mut resolved = vec![0u16; 32768];
        if unsafe { SHLoadIndirectString(PCWSTR(source.as_ptr()), &mut resolved, None) }.is_err() {
            return Ok(None);
        }
        let end = resolved
            .iter()
            .position(|v| *v == 0)
            .unwrap_or(resolved.len());
        let path = String::from_utf16_lossy(&resolved[..end]);
        if std::fs::metadata(&path)
            .map(|m| m.len() > 10 * 1024 * 1024)
            .unwrap_or(true)
        {
            return Ok(None);
        }
        let mut reader = image::ImageReader::open(&path)
            .map_err(|e| e.to_string())?
            .with_guessed_format()
            .map_err(|e| e.to_string())?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(4096);
        limits.max_image_height = Some(4096);
        limits.max_alloc = Some(32 * 1024 * 1024);
        reader.limits(limits);
        let image = reader.decode().map_err(|e| e.to_string())?;
        return png(image
            .resize(SIZE, SIZE, image::imageops::FilterType::Lanczos3)
            .to_rgba8())
        .map(Some);
    }
    let path = wide(location.trim_start_matches('@').as_ref());
    let mut icon = HICON::default();
    if unsafe { ExtractIconExW(PCWSTR(path.as_ptr()), index, Some(&mut icon), None, 1) } == 0
        || icon.0.is_null()
    {
        return Ok(None);
    }
    icon_png(Icon(icon)).map(Some)
}

pub(crate) struct Applications {
    entries: Vec<NativeFileApplication>,
    handlers: Vec<IAssocHandler>,
    // Declared last so native handlers release before CoUninitialize.
    _apartment: Apartment,
}
impl Applications {
    pub(crate) fn load(path: &Path) -> Result<Self, String> {
        let apartment = Apartment::new()?;
        let extension = path
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let extension = wide(extension.as_ref());
        let executable = association(&extension, ASSOCSTR_EXECUTABLE);
        let progid = association(&extension, ASSOCSTR_PROGID);
        let enumeration =
            unsafe { SHAssocEnumHandlers(PCWSTR(extension.as_ptr()), ASSOC_FILTER_NONE) }
                .map_err(|e| e.to_string())?;
        let mut entries: Vec<NativeFileApplication> = Vec::new();
        let mut handlers = Vec::new();
        // One extra fetch distinguishes a complete list from a budget overflow.
        for _ in 0..=64 {
            let mut next = [None];
            let mut fetched = 0;
            unsafe { enumeration.Next(&mut next, Some(&mut fetched)) }
                .map_err(|e| e.to_string())?;
            if fetched == 0 {
                return Ok(Self {
                    entries,
                    handlers,
                    _apartment: apartment,
                });
            }
            if handlers.len() == 64 {
                return Err("Too many registered applications".into());
            }
            let handler = next[0].take().expect("Shell fetched handler");
            let id = unsafe { shell_string(handler.GetName().map_err(|e| e.to_string())?) }?;
            if entries.iter().any(|entry| entry.id == id) {
                continue;
            }
            let name = unsafe { shell_string(handler.GetUIName().map_err(|e| e.to_string())?) }?;
            let is_default = executable
                .as_ref()
                .into_iter()
                .chain(progid.as_ref())
                .any(|default| default.eq_ignore_ascii_case(&id));
            let icon = application_icon(&handler)?;
            entries.push(NativeFileApplication {
                id,
                name,
                icon,
                is_default,
            });
            handlers.push(handler);
        }
        Err("Too many registered applications".into())
    }
    pub(crate) fn list(&self) -> Vec<NativeFileApplication> {
        self.entries.clone()
    }
    pub(crate) fn open(&self, id: &str, path: &Path) -> anyhow::Result<()> {
        let entry = select_application(&self.entries, id)?;
        let index = self
            .entries
            .iter()
            .position(|app| app.id == entry.id)
            .expect("selected registered handler");
        let path = wide(path.as_os_str());
        let item: IShellItem = unsafe { SHCreateItemFromParsingName(PCWSTR(path.as_ptr()), None) }?;
        let data: IDataObject = unsafe { item.BindToHandler(None, &BHID_DataObject) }?;
        unsafe { self.handlers[index].Invoke(&data) }?;
        Ok(())
    }
}
