//! WGC one-frame sessions: no GDI/PrintWindow fallback, no continuous recorder.
use super::{
    dimensions, thumbnail, Candidate, CaptureError, NativeResult, SourceKind, MAX_SOURCES,
};
use image::RgbaImage;
use std::{
    mem::size_of,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};
use windows::{
    core::{factory, Interface, BOOL},
    Foundation::TypedEventHandler,
    Graphics::{
        Capture::{
            Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem,
            GraphicsCaptureSession,
        },
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
    },
    Win32::{
        Foundation::{HWND, LPARAM, RECT},
        Graphics::{
            Direct3D::D3D_DRIVER_TYPE_HARDWARE,
            Direct3D11::*,
            Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED},
            Dxgi::{Common::DXGI_FORMAT_B8G8R8A8_UNORM, IDXGIDevice},
            Gdi::{
                EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
            },
        },
        System::WinRT::{
            Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
            Graphics::Capture::IGraphicsCaptureItemInterop,
            RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED,
        },
        UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, IsIconic, IsWindowVisible},
    },
};

fn native_error(error: windows::core::Error) -> CaptureError {
    if error.code().0 == 0x80070005_u32 as i32 {
        CaptureError::Denied
    } else {
        CaptureError::Failed(format!("Windows Graphics Capture 失败：{error}"))
    }
}
struct Apartment;
impl Apartment {
    fn enter() -> NativeResult<Self> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(native_error)?;
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() }
    }
}

pub struct Target {
    item: GraphicsCaptureItem,
    closed: Arc<AtomicBool>,
    closed_event: i64,
}
impl Target {
    fn new(item: GraphicsCaptureItem) -> NativeResult<Self> {
        let closed = Arc::new(AtomicBool::new(false));
        let flag = closed.clone();
        let closed_event = item
            .Closed(&TypedEventHandler::new(move |_, _| {
                flag.store(true, Ordering::Release);
                Ok(())
            }))
            .map_err(native_error)?;
        Ok(Self {
            item,
            closed,
            closed_event,
        })
    }
    fn gone(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
}
impl Drop for Target {
    fn drop(&mut self) {
        if let Err(error) = self.item.RemoveClosed(self.closed_event) {
            eprintln!("释放截图来源事件失败：{error}");
        }
    }
}

enum Handle {
    Screen(HMONITOR, String),
    Window(HWND, String),
}
unsafe extern "system" fn monitor_callback(
    monitor: HMONITOR,
    _: HDC,
    _: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let handles = &mut *(data.0 as *mut Vec<Handle>);
    if handles.len() >= MAX_SOURCES {
        return BOOL(1);
    }
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    if GetMonitorInfoW(
        monitor,
        (&mut info as *mut MONITORINFOEXW).cast::<MONITORINFO>(),
    )
    .as_bool()
    {
        let length = info
            .szDevice
            .iter()
            .position(|ch| *ch == 0)
            .unwrap_or(info.szDevice.len());
        handles.push(Handle::Screen(
            monitor,
            String::from_utf16_lossy(&info.szDevice[..length]),
        ));
    }
    BOOL(1)
}
unsafe extern "system" fn window_callback(window: HWND, data: LPARAM) -> BOOL {
    if (&*(data.0 as *const Vec<Handle>)).len() >= MAX_SOURCES {
        return BOOL(1);
    }
    if !IsWindowVisible(window).as_bool() || IsIconic(window).as_bool() {
        return BOOL(1);
    }
    let mut cloaked = 0u32;
    // DWM metadata failure is not an authorization to exclude this window.
    if DwmGetWindowAttribute(
        window,
        DWMWA_CLOAKED,
        (&mut cloaked as *mut u32).cast(),
        size_of::<u32>() as u32,
    )
    .is_ok()
        && cloaked != 0
    {
        return BOOL(1);
    }
    let mut name = [0u16; 1024];
    let length = GetWindowTextW(window, &mut name).max(0) as usize;
    if length != 0 {
        (&mut *(data.0 as *mut Vec<Handle>)).push(Handle::Window(
            window,
            String::from_utf16_lossy(&name[..length]),
        ));
    }
    BOOL(1)
}

struct Device {
    native: ID3D11Device,
    context: ID3D11DeviceContext,
    runtime: IDirect3DDevice,
}
impl Device {
    fn new() -> NativeResult<Self> {
        let (mut native, mut context) = (None, None);
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                Default::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut native),
                None,
                Some(&mut context),
            )
        }
        .map_err(native_error)?;
        let native =
            native.ok_or_else(|| CaptureError::Failed("未创建截图 D3D11 device".into()))?;
        let context =
            context.ok_or_else(|| CaptureError::Failed("未创建截图 D3D11 context".into()))?;
        let dxgi: IDXGIDevice = native.cast().map_err(native_error)?;
        let runtime = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
            .map_err(native_error)?
            .cast()
            .map_err(native_error)?;
        Ok(Self {
            native,
            context,
            runtime,
        })
    }
}

struct Session {
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    frame_event: i64,
    closed: bool,
}
impl Session {
    fn close(&mut self) -> windows::core::Result<()> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        // Execute all cleanup even when an earlier close reports an error.
        let event = self.pool.RemoveFrameArrived(self.frame_event);
        let session = self.session.Close();
        let pool = self.pool.Close();
        event.and(session).and(pool)
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        if let Err(error) = self.close() {
            eprintln!("关闭截图会话失败：{error}");
        }
    }
}
struct Frame(Direct3D11CaptureFrame);
impl Drop for Frame {
    fn drop(&mut self) {
        if let Err(error) = self.0.Close() {
            eprintln!("释放截图帧失败：{error}");
        }
    }
}

fn shot(target: &Target, device: &Device) -> NativeResult<RgbaImage> {
    let size = target.item.Size().map_err(native_error)?;
    dimensions(
        size.Width.try_into().unwrap_or(0),
        size.Height.try_into().unwrap_or(0),
    )?;
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &device.runtime,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        1,
        size,
    )
    .map_err(native_error)?;
    let session = match pool.CreateCaptureSession(&target.item) {
        Ok(session) => session,
        Err(error) => {
            let _ = pool.Close();
            return Err(native_error(error));
        }
    };
    let (sender, receiver) = mpsc::sync_channel(1);
    let event = match pool.FrameArrived(&TypedEventHandler::new(move |_, _| {
        let _ = sender.try_send(());
        Ok(())
    })) {
        Ok(event) => event,
        Err(error) => {
            let _ = session.Close();
            let _ = pool.Close();
            return Err(native_error(error));
        }
    };
    let mut capture = Session {
        pool,
        session,
        frame_event: event,
        closed: false,
    };
    let result = (|| {
        // Keep the OS capture border and OS protection policy; no borderless grant.
        capture.session.StartCapture().map_err(native_error)?;
        receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| CaptureError::Failed("等待 Windows 截图帧超时".into()))?;
        let frame = Frame(capture.pool.TryGetNextFrame().map_err(native_error)?);
        let actual = frame.0.ContentSize().map_err(native_error)?;
        let (width, height) = (
            u32::try_from(actual.Width).unwrap_or(0),
            u32::try_from(actual.Height).unwrap_or(0),
        );
        dimensions(width, height)?;
        // A source resized during this one-frame operation must be selected again;
        // never return clipped/undefined pixels as a successful screenshot.
        if width > size.Width as u32 || height > size.Height as u32 {
            return Err(CaptureError::Failed(
                "截图来源尺寸已变化，请重新选择".into(),
            ));
        }
        let access: IDirect3DDxgiInterfaceAccess = frame
            .0
            .Surface()
            .map_err(native_error)?
            .cast()
            .map_err(native_error)?;
        let texture: ID3D11Texture2D = unsafe { access.GetInterface() }.map_err(native_error)?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { texture.GetDesc(&mut desc) };
        dimensions(desc.Width, desc.Height)?;
        if width > desc.Width || height > desc.Height || desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM {
            return Err(CaptureError::Failed("Windows 返回不匹配的截图表面".into()));
        }
        desc.Usage = D3D11_USAGE_STAGING;
        desc.BindFlags = 0;
        desc.MiscFlags = 0;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        let mut staging = None;
        unsafe {
            device
                .native
                .CreateTexture2D(&desc, None, Some(&mut staging))
        }
        .map_err(native_error)?;
        let staging = staging.ok_or_else(|| CaptureError::Failed("未创建截图读取表面".into()))?;
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            device.context.CopyResource(&staging, &texture);
            device
                .context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .map_err(native_error)?;
        }
        let pixels = (|| {
            if mapped.pData.is_null() || mapped.RowPitch < width * 4 {
                return Err(CaptureError::Failed("Windows 截图像素行不完整".into()));
            }
            let mut rgba = RgbaImage::new(width, height);
            for y in 0..height as usize {
                let source = unsafe {
                    std::slice::from_raw_parts(
                        mapped.pData.cast::<u8>().add(y * mapped.RowPitch as usize),
                        width as usize * 4,
                    )
                };
                let destination =
                    &mut rgba.as_mut()[y * width as usize * 4..(y + 1) * width as usize * 4];
                for (bgra, rgba) in source.chunks_exact(4).zip(destination.chunks_exact_mut(4)) {
                    rgba.copy_from_slice(&[bgra[2], bgra[1], bgra[0], bgra[3]]);
                }
            }
            Ok(rgba)
        })();
        unsafe { device.context.Unmap(&staging, 0) };
        pixels
    })();
    let cleanup = capture.close().map_err(native_error);
    match (result, cleanup) {
        (Ok(image), Ok(())) => Ok(image),
        (Err(error), Ok(())) | (_, Err(error)) => Err(error),
    }
}

pub fn sources() -> NativeResult<Vec<Candidate<Target>>> {
    let _apartment = Apartment::enter()?;
    if !GraphicsCaptureSession::IsSupported().map_err(native_error)? {
        return Err(CaptureError::Failed(
            "系统不支持 Windows Graphics Capture（需要 Windows 10 1903 或更新版本及兼容显卡）"
                .into(),
        ));
    }
    let mut handles = Vec::<Handle>::new();
    unsafe {
        if !EnumDisplayMonitors(
            None,
            None,
            Some(monitor_callback),
            LPARAM((&mut handles as *mut Vec<Handle>) as isize),
        )
        .as_bool()
        {
            return Err(native_error(windows::core::Error::from_win32()));
        }
        EnumWindows(
            Some(window_callback),
            LPARAM((&mut handles as *mut Vec<Handle>) as isize),
        )
        .map_err(native_error)?;
    }
    let interop: IGraphicsCaptureItemInterop =
        factory::<GraphicsCaptureItem, _>().map_err(native_error)?;
    let device = Device::new()?;
    let mut sources = Vec::new();
    for handle in handles.into_iter().take(MAX_SOURCES) {
        let (item, kind, name): (GraphicsCaptureItem, _, _) = match handle {
            Handle::Screen(handle, name) => (
                unsafe { interop.CreateForMonitor(handle) }.map_err(native_error)?,
                SourceKind::Screen,
                name,
            ),
            Handle::Window(handle, name) => (
                unsafe { interop.CreateForWindow(handle) }.map_err(native_error)?,
                SourceKind::Window,
                name,
            ),
        };
        let target = Target::new(item)?;
        let image = match shot(&target, &device) {
            Ok(image) => image,
            Err(_) if target.gone() => continue,
            Err(error) => return Err(error),
        };
        sources.push(Candidate {
            name,
            kind,
            thumbnail: thumbnail(&image)?,
            target,
        });
    }
    Ok(sources)
}

pub fn capture(target: Target) -> NativeResult<Option<RgbaImage>> {
    let _apartment = Apartment::enter()?;
    if target.gone() {
        return Ok(None);
    }
    match shot(&target, &Device::new()?) {
        Ok(image) if !target.gone() => Ok(Some(image)),
        _ if target.gone() => Ok(None),
        Err(error) => Err(error),
        Ok(_) => unreachable!("source presence was checked above"),
    }
}
