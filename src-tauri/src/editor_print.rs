//! A disposable document webview, never the editor or the application webview.
#[cfg(any(target_os = "macos", test))]
use std::{io::Read, path::Path};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use base64::Engine as _;
use serde::Deserialize;
use tauri::{webview::NewWindowResponse, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::{mpsc, oneshot, Semaphore};

// Embedded fonts and multipage images share the document/export 100 MiB budget.
// One job at a time bounds input/bootstrap/webview copies; no unbounded queue.
const MAX_HTML_BYTES: usize = 100 * 1024 * 1024;
const LOAD_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_PDF_BYTES: usize = 100 * 1024 * 1024;
#[cfg(target_os = "windows")]
const PDF_TIMEOUT: Duration = Duration::from_secs(120);
#[cfg(target_os = "windows")]
const PRINT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
// Only one native print panel and one budgeted document may be live at a time.
static PRINT_SLOT: Semaphore = Semaphore::const_new(1);

const DOCUMENT_CSP: &str = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
// about:blank does not reliably trigger WKWebView document-start scripts.
const BOOTSTRAP_URL: &str = "data:text/html,%3C!doctype%20html%3E%3Chtml%3E%3Chead%3E%3C/head%3E%3Cbody%3E%3C/body%3E%3C/html%3E";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorPrintInput {
    pub html: String,
    pub title: Option<String>,
    /// One physical sheet size per native operation. Mixed-size documents are
    /// rendered as ordered groups and merged by the format's PDF exporter.
    pub page_size: Option<EditorPageSize>,
}

#[derive(Debug, Clone, Copy, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorPageSize {
    pub width_pt: f64,
    pub height_pt: f64,
}

#[derive(Debug, PartialEq)]
enum PrintEvent {
    Ready,
    Failed,
    AfterPrint,
    Closed,
}

fn validate_input(caller: &str, input: &EditorPrintInput) -> Result<(), String> {
    let project = caller.strip_prefix("project-").is_some_and(|id| {
        !id.is_empty()
            && id.bytes().all(|c| c.is_ascii_digit())
            && id.parse::<i64>().is_ok_and(|id| id > 0)
    });
    if caller != "main" && !project {
        return Err("当前窗口不能打印编辑器文档".into());
    }
    if input.html.trim().is_empty() {
        return Err("打印 HTML 不能为空".into());
    }
    if input.html.len() > MAX_HTML_BYTES {
        return Err("打印 HTML 超过 100 MiB（含内嵌图片和字体）".into());
    }
    if input.title.as_ref().is_some_and(|title| title.len() > 1024) {
        return Err("打印标题超过 1024 字节".into());
    }
    if input.page_size.is_some_and(|size| {
        ![size.width_pt, size.height_pt]
            .into_iter()
            .all(|value| value.is_finite() && (1.0..=14_400.0).contains(&value))
    }) {
        return Err("打印纸张尺寸必须为 1–14400 pt 的有限值".into());
    }
    Ok(())
}

fn signal_event(url: &tauri::Url, signal_base: &str) -> Option<PrintEvent> {
    match url.as_str().strip_prefix(signal_base)? {
        "ready" => Some(PrintEvent::Ready),
        "failed" => Some(PrintEvent::Failed),
        "afterprint" => Some(PrintEvent::AfterPrint),
        _ => None,
    }
}

fn bootstrap(input: &EditorPrintInput, signal_base: &str) -> String {
    // This is a native initialization script, not HTML interpolation. In particular,
    // a document containing </script> cannot break out into the trusted parent.
    let html = serde_json::to_string(&input.html).expect("a String is JSON serializable");
    let title = serde_json::to_string(input.title.as_deref().unwrap_or("打印文档"))
        .expect("a String is JSON serializable");
    let signal_base = serde_json::to_string(signal_base).expect("static URL is JSON serializable");
    let csp = serde_json::to_string(DOCUMENT_CSP).expect("static CSP is JSON serializable");
    let bootstrap_url = serde_json::to_string(BOOTSTRAP_URL).unwrap();
    let page_size = serde_json::to_string(&input.page_size).unwrap();
    format!(
        r#"(() => {{
  if (window.top !== window || location.href !== {bootstrap_url}) return;
  if (window.__genofficePrintStarted) return;
  window.__genofficePrintStarted = true;
  const signal = name => {{ location.href = {signal_base} + name; }};
  const start = () => {{
    const head = document.createElement('head');
    head.innerHTML = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src about:; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>html,body{{margin:0;padding:0}}iframe{{display:block;width:100%;border:0}}@media print{{html,body,iframe{{overflow:visible!important}}}}</style>`;
    document.documentElement.replaceChildren(head, document.createElement('body'));
    document.title = {title};
    // Only this parent can signal completion; the sandbox has no scripts/IPC.
    window.addEventListener('afterprint', () => signal('afterprint'), {{ once: true }});
    const frame = document.createElement('iframe');
    const sheet = {page_size};
    if (sheet) frame.style.width = (sheet.widthPt / 0.75) + 'px';
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.addEventListener('error', () => signal('failed'), {{ once: true }});
    frame.addEventListener('load', async () => {{
      try {{
        const doc = frame.contentDocument;
        if (!doc || !doc.body) throw new Error('No print document');
        doc.addEventListener('click', event => event.preventDefault(), true);
        doc.addEventListener('submit', event => event.preventDefault(), true);
        const decode = async image => {{
          image.loading = 'eager';
          await image.decode();
          if (!image.naturalWidth) throw new Error('Print image failed');
        }};
        const backgrounds = new Set();
        for (const node of doc.querySelectorAll('*')) {{
          const css = frame.contentWindow.getComputedStyle(node).backgroundImage;
          for (const match of css.matchAll(/url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/g)) {{
            backgrounds.add(match[1] ?? match[2] ?? match[3]);
          }}
        }}
        await Promise.all([
          ...Array.from(doc.images, decode),
          ...Array.from(backgrounds, async source => {{
            if (!source.startsWith('data:')) throw new Error('External print image');
            const image = new frame.contentWindow.Image();
            image.src = source;
            await decode(image);
          }}),
          ...Array.from(doc.fonts, font => font.load()),
        ]);
        await doc.fonts.ready;
        // Exporters supply their document @page rules; the top-level native print
        // operation needs those rules too. No other document CSS escapes the frame.
        const pages = [];
        const collectPages = rules => {{
          for (const rule of rules) {{
            if (rule.type === 6) pages.push(rule.cssText);
            else if (rule.cssRules) collectPages(rule.cssRules);
          }}
        }};
        for (const sheet of doc.styleSheets) collectPages(sheet.cssRules);
        const style = document.createElement('style');
        style.textContent = pages.join('\n');
        if (sheet) style.textContent += `\n@page{{size:${{sheet.widthPt}}pt ${{sheet.heightPt}}pt;margin:0}}`;
        document.head.append(style);
        // scrollHeight rounds up to an integer CSS pixel, which creates an
        // extra native sheet for exact full-height pages. Preserve subpixels.
        const fit = () => {{
          let bottom = doc.body.getBoundingClientRect().bottom + parseFloat(frame.contentWindow.getComputedStyle(doc.body).marginBottom || '0');
          for (const node of doc.body.querySelectorAll('*')) bottom = Math.max(bottom, node.getBoundingClientRect().bottom);
          frame.style.height = Math.max(1, bottom) + 'px';
        }};
        fit();
        window.addEventListener('beforeprint', fit);
        signal('ready');
      }} catch (_) {{ signal('failed'); }}
    }}, {{ once: true }});
    // The enforced policy precedes the complete, untrusted format HTML.
    frame.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + {csp} + '">' + {html};
    document.body.append(frame);
  }};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {{ once: true }});
  else start();
}})();"#
    )
}

struct PrintWindow {
    window: WebviewWindow,
    events: mpsc::UnboundedReceiver<PrintEvent>,
    closed: Arc<AtomicBool>,
    destroyed: bool,
}

impl PrintWindow {
    fn destroy(&mut self) -> Result<(), String> {
        if !self.destroyed {
            self.destroyed = true;
            self.window
                .destroy()
                .map_err(|error| format!("销毁打印窗口失败：{error}"))?;
        }
        Ok(())
    }
}

impl Drop for PrintWindow {
    fn drop(&mut self) {
        // Fallback for a cancelled native task; the normal path reports errors.
        if let Err(error) = self.destroy() {
            eprintln!("{error}");
        }
    }
}

#[tauri::command]
pub async fn desktop_print_editor_html(
    app: tauri::AppHandle,
    window: tauri::Window,
    input: EditorPrintInput,
) -> Result<(), String> {
    validate_input(window.label(), &input)?;
    let _permit = PRINT_SLOT
        .try_acquire()
        .map_err(|_| "已有文档正在打印".to_string())?;
    if !cfg!(any(target_os = "macos", target_os = "windows")) {
        return Err("当前平台未实现原生编辑器打印".into());
    }
    let mut job = document_window(&app, &input)?;
    let result = run_print(&job.window, &mut job.events, &job.closed, input.page_size).await;
    // Destroy only after native completion, or a preparation/Windows timeout.
    let cleanup = job.destroy();
    match (result, cleanup) {
        (Err(error), Err(cleanup)) => Err(format!("{error}；{cleanup}")),
        (Err(error), _) | (_, Err(error)) => Err(error),
        _ => Ok(()),
    }
}

/// Returns only PDF bytes as base64. No frontend-provided path or native panel.
#[tauri::command]
pub async fn desktop_render_editor_pdf(
    app: tauri::AppHandle,
    window: tauri::Window,
    input: EditorPrintInput,
) -> Result<String, String> {
    validate_input(window.label(), &input)?;
    let _permit = PRINT_SLOT
        .try_acquire()
        .map_err(|_| "已有文档正在打印或生成 PDF".to_string())?;
    if !cfg!(any(target_os = "macos", target_os = "windows")) {
        return Err("当前平台未实现原生编辑器 PDF".into());
    }
    let mut job = document_window(&app, &input)?;
    let result = async {
        wait_document_ready(&mut job.events, &job.closed).await?;
        native_render_pdf(&job.window, input.page_size).await
    }
    .await;
    let cleanup = job.destroy();
    match (result, cleanup) {
        (Err(error), Err(cleanup)) => Err(format!("{error}；{cleanup}")),
        (Err(error), _) | (_, Err(error)) => Err(error),
        (Ok(pdf), Ok(())) => Ok(pdf),
    }
}

fn document_window(
    app: &tauri::AppHandle,
    input: &EditorPrintInput,
) -> Result<PrintWindow, String> {
    let nonce = format!("{:032x}", rand::random::<u128>());
    let label = format!("editor-print-{nonce}");
    let signal_base = format!("https://editor-print.invalid/{nonce}/");
    let (sender, events) = mpsc::unbounded_channel();
    let navigation_sender = sender.clone();
    let navigation_signal = signal_base.clone();
    let window = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::External(BOOTSTRAP_URL.parse().expect("static URL")),
    )
    .title(input.title.as_deref().unwrap_or("打印文档"))
    .inner_size(900.0, 700.0)
    .visible(false)
    .focused(false)
    .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
    .incognito(true)
    .devtools(false)
    .disable_drag_drop_handler()
    .initialization_script(bootstrap(&input, &signal_base))
    .on_navigation(move |url| {
        if let Some(event) = signal_event(url, &navigation_signal) {
            let _ = navigation_sender.send(event);
            return false;
        }
        // No app URL, filesystem URL, arbitrary path, or external navigation.
        url.as_str() == BOOTSTRAP_URL || url.as_str() == "about:srcdoc"
    })
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .on_download(|_, _| false)
    .build()
    .map_err(|error| format!("创建打印窗口失败：{error}"))?;
    let closed = Arc::new(AtomicBool::new(false));
    let closed_event = closed.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            closed_event.store(true, Ordering::Release);
            let _ = sender.send(PrintEvent::Closed);
        } else if matches!(event, tauri::WindowEvent::Destroyed) {
            closed_event.store(true, Ordering::Release);
            let _ = sender.send(PrintEvent::Closed);
        }
    });

    Ok(PrintWindow {
        window,
        events,
        closed,
        destroyed: false,
    })
}

async fn run_print(
    window: &WebviewWindow,
    events: &mut mpsc::UnboundedReceiver<PrintEvent>,
    closed: &AtomicBool,
    page_size: Option<EditorPageSize>,
) -> Result<(), String> {
    wait_document_ready(events, closed).await?;
    window
        .show()
        .map_err(|error| format!("显示打印窗口失败：{error}"))?;
    native_print(window, page_size).await?;

    #[cfg(target_os = "windows")]
    {
        match tokio::time::timeout(PRINT_TIMEOUT, events.recv()).await {
            Ok(Some(PrintEvent::AfterPrint)) => {}
            Ok(Some(PrintEvent::Closed)) => return Err("打印窗口已关闭".into()),
            Ok(_) => return Err("原生打印交互失败".into()),
            Err(_) => return Err("等待系统打印结束超时".into()),
        }
    }
    Ok(())
}

async fn wait_document_ready(
    events: &mut mpsc::UnboundedReceiver<PrintEvent>,
    closed: &AtomicBool,
) -> Result<(), String> {
    match tokio::time::timeout(LOAD_TIMEOUT, events.recv()).await {
        Ok(Some(PrintEvent::Ready)) => {}
        Ok(Some(PrintEvent::Closed)) => return Err("打印窗口已关闭".into()),
        Ok(_) => return Err("打印文档加载失败（请检查内嵌图片和字体）".into()),
        Err(_) => return Err("打印文档加载超时".into()),
    }
    if closed.load(Ordering::Acquire) {
        return Err("打印窗口已关闭".into());
    }
    Ok(())
}

async fn native_print(
    window: &WebviewWindow,
    page_size: Option<EditorPageSize>,
) -> Result<(), String> {
    // WebView2 ShowPrintUI consumes the top-level CSS size from bootstrap.
    #[cfg(not(target_os = "macos"))]
    let _ = page_size;
    let (sender, receiver) = oneshot::channel();
    window
        .with_webview(move |webview| {
            #[cfg(target_os = "macos")]
            unsafe {
                macos::start(webview.inner(), None, page_size, sender);
            }
            #[cfg(not(target_os = "macos"))]
            {
                #[cfg(target_os = "windows")]
                let result = unsafe {
                    use webview2_com::Microsoft::Web::WebView2::Win32::{
                        ICoreWebView2_16, COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM,
                    };
                    use windows::core::Interface;
                    (|| -> windows::core::Result<()> {
                        let native: ICoreWebView2_16 =
                            webview.controller().CoreWebView2()?.cast()?;
                        native.ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM)
                    })()
                    .map_err(|error| format!("打开系统打印面板失败：{error}"))
                };
                #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                let result = {
                    let _ = webview;
                    Err("当前平台未实现原生编辑器打印".into())
                };
                let _ = sender.send(result);
            }
        })
        .map_err(|error| format!("调用原生打印失败：{error}"))?;
    receiver
        .await
        .map_err(|_| "原生打印任务已终止".to_string())?
}

fn validate_pdf(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_PDF_BYTES {
        return Err("生成 PDF 超过 100 MiB".into());
    }
    if !bytes.starts_with(b"%PDF-")
        || !bytes[bytes.len().saturating_sub(1024)..]
            .windows(5)
            .any(|part| part == b"%%EOF")
    {
        return Err("原生引擎未返回完整 PDF".into());
    }
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn read_pdf(path: &Path) -> Result<String, String> {
    // Private native-created directory, plus a bounded read even if the writer
    // produced more bytes than expected. No renderer path enters this function.
    let file = std::fs::File::open(path).map_err(|error| format!("读取生成 PDF 失败：{error}"))?;
    if file
        .metadata()
        .map_err(|error| format!("读取 PDF 大小失败：{error}"))?
        .len()
        > MAX_PDF_BYTES as u64
    {
        return Err("生成 PDF 超过 100 MiB".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_PDF_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取生成 PDF 失败：{error}"))?;
    validate_pdf(&bytes)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[cfg(any(target_os = "windows", test))]
fn decode_pdf_result(json: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    struct PdfResult {
        data: String,
    }
    let result: PdfResult =
        serde_json::from_str(json).map_err(|error| format!("解析原生 PDF 结果失败：{error}"))?;
    if result.data.len() > MAX_PDF_BYTES.div_ceil(3) * 4 {
        return Err("生成 PDF 超过 100 MiB".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&result.data)
        .map_err(|error| format!("原生 PDF base64 无效：{error}"))?;
    validate_pdf(&bytes)?;
    Ok(result.data)
}

async fn native_render_pdf(
    window: &WebviewWindow,
    page_size: Option<EditorPageSize>,
) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let directory = tempfile::Builder::new()
            .prefix("project-mind-editor-pdf-")
            .tempdir()
            .map_err(|error| format!("创建 PDF 临时目录失败：{error}"))?;
        let path = directory.path().join("document.pdf");
        let native_path = path.clone();
        let (sender, receiver) = oneshot::channel();
        window
            .with_webview(move |webview| unsafe {
                macos::start(webview.inner(), Some(&native_path), page_size, sender);
            })
            .map_err(|error| format!("调用 WKWebView PDF 失败：{error}"))?;
        // The AppKit completion delegate owns the lifecycle, including saving.
        // No arbitrary timer may dispose a WKWebView while printing is active.
        let result = async {
            receiver
                .await
                .map_err(|_| "原生 PDF 任务已终止".to_string())??;
            tauri::async_runtime::spawn_blocking(move || read_pdf(&path))
                .await
                .map_err(|error| format!("读取 PDF 任务失败：{error}"))?
        }
        .await;
        let cleanup = directory
            .close()
            .map_err(|error| format!("清理 PDF 临时目录失败：{error}"));
        match (result, cleanup) {
            (Ok(pdf), Ok(())) => Ok(pdf),
            (Err(error), Err(cleanup)) => Err(format!("{error}；{cleanup}")),
            (Err(error), _) | (_, Err(error)) => Err(error),
        }
    }
    #[cfg(target_os = "windows")]
    {
        // A host-only CDP call: no debugging port or frontend devtools access.
        // This preserves CSS @page sizes and backgrounds, unlike relying on
        // WebView2 print-settings defaults. Completion comes from the COM API.
        let (sender, receiver) = oneshot::channel();
        window.with_webview(move |webview| {
            use std::sync::Mutex;
            use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
            use windows::core::{w, HSTRING};
            let sender = Arc::new(Mutex::new(Some(sender)));
            let completed = sender.clone();
            let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, json| {
                let result = status.map_err(|error| format!("原生 PDF 渲染失败：{error}"))
                    .and_then(|()| decode_pdf_result(&json));
                if let Some(sender) = completed.lock().expect("PDF completion lock poisoned").take() {
                    let _ = sender.send(result);
                }
                Ok(())
            }));
            let mut params = serde_json::json!({"printBackground":true,"preferCSSPageSize":true,"displayHeaderFooter":false,"marginTop":0,"marginBottom":0,"marginLeft":0,"marginRight":0,"transferMode":"ReturnAsBase64"});
            if let Some(size) = page_size {
                params["paperWidth"] = (size.width_pt / 72.0).into();
                params["paperHeight"] = (size.height_pt / 72.0).into();
                params["preferCSSPageSize"] = false.into();
            }
            let params = HSTRING::from(params.to_string());
            let result = unsafe {
                webview.controller().CoreWebView2().and_then(|native|
                    native.CallDevToolsProtocolMethod(w!("Page.printToPDF"), &params, &callback))
            };
            if let Err(error) = result {
                if let Some(sender) = sender.lock().expect("PDF completion lock poisoned").take() {
                    let _ = sender.send(Err(format!("调用原生 PDF API 失败：{error}")));
                }
            }
        }).map_err(|error| format!("调用 WebView2 PDF 失败：{error}"))?;
        tokio::time::timeout(PDF_TIMEOUT, receiver)
            .await
            .map_err(|_| "生成 PDF 超时".to_string())?
            .map_err(|_| "原生 PDF 任务已终止".to_string())?
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = window;
        Err("当前平台未实现原生编辑器 PDF".into())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::EditorPageSize;
    use std::{
        ffi::{c_char, c_void, CString},
        mem::transmute,
        os::unix::ffi::OsStrExt,
        path::Path,
        sync::OnceLock,
    };
    use tokio::sync::oneshot;
    type Object = *mut c_void;
    type Selector = *mut c_void;

    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> Object;
        fn sel_registerName(name: *const c_char) -> Selector;
        fn objc_msgSend();
        fn objc_allocateClassPair(superclass: Object, name: *const c_char, extra: usize) -> Object;
        fn objc_registerClassPair(class: Object);
        fn class_addMethod(
            class: Object,
            selector: Selector,
            implementation: *const c_void,
            types: *const c_char,
        ) -> i8;
    }

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {
        static NSPrintSaveJob: Object;
        static NSPrintJobSavingURL: Object;
    }

    struct Completion {
        sender: oneshot::Sender<Result<(), String>>,
        pdf: bool,
    }

    unsafe extern "C" fn completed(
        delegate: Object,
        _: Selector,
        operation: Object,
        success: i8,
        context: *mut c_void,
    ) {
        let completion = Box::from_raw(context.cast::<Completion>());
        let release: unsafe extern "C" fn(Object, Selector) = transmute(objc_msgSend as *const ());
        release(operation, sel_registerName(c"release".as_ptr()));
        release(delegate, sel_registerName(c"release".as_ptr()));
        let result = if success != 0 {
            Ok(())
        } else if completion.pdf {
            Err("WKWebView 原生 PDF 生成失败".into())
        } else {
            Err("打印已取消或系统打印失败".into())
        };
        let _ = completion.sender.send(result);
    }

    unsafe fn delegate_class() -> Result<Object, String> {
        static CLASS: OnceLock<Result<usize, String>> = OnceLock::new();
        CLASS
            .get_or_init(|| {
                let class = objc_allocateClassPair(
                    objc_getClass(c"NSObject".as_ptr()),
                    c"ProjectMindEditorPrintCompletion".as_ptr(),
                    0,
                );
                if class.is_null() {
                    return Err("无法创建原生打印完成 delegate".into());
                }
                #[cfg(target_arch = "aarch64")]
                let encoding = c"v@:@B^v";
                #[cfg(not(target_arch = "aarch64"))]
                let encoding = c"v@:@c^v";
                if class_addMethod(
                    class,
                    sel_registerName(c"printOperationDidRun:success:context:".as_ptr()),
                    completed as *const c_void,
                    encoding.as_ptr(),
                ) == 0
                {
                    return Err("无法注册原生打印完成方法".into());
                }
                objc_registerClassPair(class);
                Ok(class as usize)
            })
            .as_ref()
            .map(|class| *class as Object)
            .map_err(Clone::clone)
    }

    // Called on Tauri's UI thread. The native callback, which AppKit may invoke
    // on its printing thread, is the only completion signal. Never runOperation:
    // it blocks WK's asynchronous pagination and can enumerate NSIntegerMax pages.
    pub unsafe fn start(
        webview: Object,
        save_path: Option<&Path>,
        page_size: Option<EditorPageSize>,
        sender: oneshot::Sender<Result<(), String>>,
    ) {
        let send: unsafe extern "C" fn(Object, Selector) -> Object =
            transmute(objc_msgSend as *const ());
        let operation = match make_operation(webview, save_path, page_size) {
            Ok(operation) => operation,
            Err(error) => {
                let _ = sender.send(Err(error));
                return;
            }
        };
        let class = match delegate_class() {
            Ok(class) => class,
            Err(error) => {
                send(operation, sel_registerName(c"release".as_ptr()));
                let _ = sender.send(Err(error));
                return;
            }
        };
        let delegate = send(
            send(class, sel_registerName(c"alloc".as_ptr())),
            sel_registerName(c"init".as_ptr()),
        );
        let context = Box::into_raw(Box::new(Completion {
            sender,
            pdf: save_path.is_some(),
        }));
        let run: unsafe extern "C" fn(Object, Selector, Object, Object, Selector, *mut c_void) =
            transmute(objc_msgSend as *const ());
        run(
            operation,
            sel_registerName(
                c"runOperationModalForWindow:delegate:didRunSelector:contextInfo:".as_ptr(),
            ),
            send(webview, sel_registerName(c"window".as_ptr())),
            delegate,
            sel_registerName(c"printOperationDidRun:success:context:".as_ptr()),
            context.cast(),
        );
    }

    unsafe fn make_operation(
        webview: Object,
        save_path: Option<&Path>,
        page_size: Option<EditorPageSize>,
    ) -> Result<Object, String> {
        let send: unsafe extern "C" fn(Object, Selector) -> Object =
            transmute(objc_msgSend as *const ());
        let send_object: unsafe extern "C" fn(Object, Selector, Object) -> Object =
            transmute(objc_msgSend as *const ());
        let send_void: unsafe extern "C" fn(Object, Selector) =
            transmute(objc_msgSend as *const ());
        let send_set: unsafe extern "C" fn(Object, Selector, Object) =
            transmute(objc_msgSend as *const ());
        let send_flag: unsafe extern "C" fn(Object, Selector, i8) =
            transmute(objc_msgSend as *const ());
        let configuration = send(webview, sel_registerName(c"configuration".as_ptr()));
        let preferences = send(configuration, sel_registerName(c"preferences".as_ptr()));
        send_flag(
            preferences,
            sel_registerName(c"setShouldPrintBackgrounds:".as_ptr()),
            1,
        );
        let info_class = objc_getClass(c"NSPrintInfo".as_ptr());
        let shared = send(info_class, sel_registerName(c"sharedPrintInfo".as_ptr()));
        let info = send(shared, sel_registerName(c"copy".as_ptr()));
        if info.is_null() {
            return Err("无法创建系统打印配置".into());
        }
        if let Some(size) = page_size {
            #[repr(C)]
            struct Size {
                width: f64,
                height: f64,
            }
            let set_size: unsafe extern "C" fn(Object, Selector, Size) =
                transmute(objc_msgSend as *const ());
            let set_margin: unsafe extern "C" fn(Object, Selector, f64) =
                transmute(objc_msgSend as *const ());
            set_size(
                info,
                sel_registerName(c"setPaperSize:".as_ptr()),
                Size {
                    width: size.width_pt,
                    height: size.height_pt,
                },
            );
            for name in [
                c"setTopMargin:",
                c"setBottomMargin:",
                c"setLeftMargin:",
                c"setRightMargin:",
            ] {
                set_margin(info, sel_registerName(name.as_ptr()), 0.0);
            }
        }
        if let Some(path) = save_path {
            let path = CString::new(path.as_os_str().as_bytes())
                .map_err(|_| "PDF 临时路径无效".to_string())?;
            let string: unsafe extern "C" fn(Object, Selector, *const c_char) -> Object =
                transmute(objc_msgSend as *const ());
            let path_string = string(
                objc_getClass(c"NSString".as_ptr()),
                sel_registerName(c"stringWithUTF8String:".as_ptr()),
                path.as_ptr(),
            );
            let url = send_object(
                objc_getClass(c"NSURL".as_ptr()),
                sel_registerName(c"fileURLWithPath:".as_ptr()),
                path_string,
            );
            if url.is_null() {
                send_void(info, sel_registerName(c"release".as_ptr()));
                return Err("无法创建 PDF 临时 URL".into());
            }
            send_set(
                info,
                sel_registerName(c"setJobDisposition:".as_ptr()),
                NSPrintSaveJob,
            );
            let dictionary = send(info, sel_registerName(c"dictionary".as_ptr()));
            let set_object: unsafe extern "C" fn(Object, Selector, Object, Object) =
                transmute(objc_msgSend as *const ());
            set_object(
                dictionary,
                sel_registerName(c"setObject:forKey:".as_ptr()),
                url,
                NSPrintJobSavingURL,
            );
        }
        let operation = send_object(
            webview,
            sel_registerName(c"printOperationWithPrintInfo:".as_ptr()),
            info,
        );
        send_void(info, sel_registerName(c"release".as_ptr()));
        if operation.is_null() {
            return Err("无法创建 WKWebView 原生打印操作".into());
        }
        send(operation, sel_registerName(c"retain".as_ptr()));
        // WKPrintingView prepares final page data on its secondary-thread path.
        // On the main-thread preview path it initially reports NSIntegerMax
        // pages while awaiting the asynchronous pagination response.
        send_flag(
            operation,
            sel_registerName(c"setCanSpawnSeparateThread:".as_ptr()),
            1,
        );
        if save_path.is_some() {
            send_flag(
                operation,
                sel_registerName(c"setShowsPrintPanel:".as_ptr()),
                0,
            );
            send_flag(
                operation,
                sel_registerName(c"setShowsProgressPanel:".as_ptr()),
                0,
            );
        }
        Ok(operation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(html: impl Into<String>) -> EditorPrintInput {
        EditorPrintInput {
            html: html.into(),
            title: None,
            page_size: None,
        }
    }

    #[test]
    fn editor_print_budget_counts_utf8_and_includes_embedded_assets() {
        assert!(validate_input("main", &input("x".repeat(MAX_HTML_BYTES))).is_ok());
        assert!(validate_input("main", &input("x".repeat(MAX_HTML_BYTES + 1))).is_err());
        assert!(validate_input("main", &input("中".repeat(MAX_HTML_BYTES / 3 + 1))).is_err());
        assert!(validate_input("main", &input(" \n\t")).is_err());
    }

    #[test]
    fn editor_print_explicit_geometry_is_finite_and_bounded() {
        let mut document = input("<p>PDF</p>");
        for (width_pt, height_pt) in [(595.5, 841.5), (720.0, 405.0), (1.0, 14400.0)] {
            document.page_size = Some(EditorPageSize {
                width_pt,
                height_pt,
            });
            assert!(validate_input("main", &document).is_ok());
        }
        for width_pt in [0.0, -1.0, 14400.1, f64::NAN, f64::INFINITY] {
            document.page_size = Some(EditorPageSize {
                width_pt,
                height_pt: 842.0,
            });
            assert!(validate_input("main", &document).is_err());
        }
        let dto: EditorPrintInput = serde_json::from_str(
            r#"{"html":"<p>PDF</p>","pageSize":{"widthPt":720,"heightPt":405}}"#,
        )
        .unwrap();
        assert_eq!(dto.page_size.unwrap().height_pt, 405.0);
    }

    #[test]
    fn editor_print_caller_comes_from_native_window() {
        for caller in ["main", "project-1", "project-123"] {
            assert!(validate_input(caller, &input("<p>Document</p>")).is_ok());
        }
        for caller in [
            "voice-caption",
            "editor-print-abcd",
            "project-",
            "project-0",
            "project-NaN",
            "project-1/../../main",
        ] {
            assert!(validate_input(caller, &input("<p>Document</p>")).is_err());
        }
    }

    #[test]
    fn editor_print_only_accepts_exact_per_job_signals() {
        let base = "https://editor-print.invalid/nonce/";
        assert_eq!(
            signal_event(&format!("{base}ready").parse().unwrap(), base),
            Some(PrintEvent::Ready)
        );
        for url in [
            "https://editor-print.invalid/other/ready",
            "https://editor-print.invalid/nonce/ready?extra=1",
            "https://evil.invalid/nonce/ready",
        ] {
            assert_eq!(signal_event(&url.parse().unwrap(), base), None);
        }
    }

    #[test]
    fn editor_print_untrusted_document_cannot_escape_bootstrap_string() {
        let script = bootstrap(
            &input("</script><script>window.print()</script>"),
            "https://editor-print.invalid/n/",
        );
        assert!(script.contains("frame.setAttribute('sandbox', 'allow-same-origin')"));
        assert!(!script.contains("allow-scripts"));
        assert!(script.contains("await doc.fonts.ready"));
        assert!(script.contains("await image.decode()"));
        assert!(!script.contains("setTimeout"));
        assert!(DOCUMENT_CSP.contains("default-src 'none'"));
        assert!(DOCUMENT_CSP.contains("img-src data:"));
        assert!(DOCUMENT_CSP.contains("font-src data:"));
    }

    #[test]
    fn editor_print_pdf_result_rejects_missing_invalid_and_truncated_bytes() {
        let valid = base64::engine::general_purpose::STANDARD.encode(b"%PDF-1.7\nbody\n%%EOF\n");
        assert_eq!(
            decode_pdf_result(&serde_json::json!({"data": valid}).to_string()).unwrap(),
            valid
        );
        for json in ["{}", r#"{"data":"!not-base64"}"#, r#"{"data":"SGVsbG8="}"#] {
            assert!(decode_pdf_result(json).is_err());
        }
        assert!(validate_pdf(b"%PDF-1.7\ntruncated").is_err());
        assert!(validate_pdf(b"").is_err());
    }

    #[test]
    fn editor_print_pdf_budget_is_on_decoded_bytes_and_native_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("document.pdf");
        std::fs::write(&path, b"%PDF-1.7\nbody\n%%EOF\n").unwrap();
        assert!(read_pdf(&path).is_ok());
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(MAX_PDF_BYTES as u64 + 1)
            .unwrap();
        assert_eq!(read_pdf(&path).unwrap_err(), "生成 PDF 超过 100 MiB");
        let mut maximum = vec![b' '; MAX_PDF_BYTES];
        maximum[..8].copy_from_slice(b"%PDF-1.7");
        maximum[MAX_PDF_BYTES - 5..].copy_from_slice(b"%%EOF");
        assert!(validate_pdf(&maximum).is_ok());
        maximum.push(b' ');
        assert!(validate_pdf(&maximum).is_err());
    }

    #[test]
    fn editor_print_wire_input_cannot_supply_paths_or_caller() {
        assert!(serde_json::from_value::<EditorPrintInput>(
            serde_json::json!({"html":"<p>Document</p>","path":"/tmp/output.pdf"})
        )
        .is_err());
        assert!(serde_json::from_value::<EditorPrintInput>(
            serde_json::json!({"html":"<p>Document</p>","caller":"main"})
        )
        .is_err());
    }
}
