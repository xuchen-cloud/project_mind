//! Native website execution. This Wry view registers no Tauri IPC or resource protocols.
use crate::{
    agent::models::{Scope, WorkspaceBinding},
    db::project_directory_files::FileBytesInput,
    html_preview_files::PreparedFile,
    html_preview_http::{AssetReader, HtmlSite, Validator},
    AppState,
};
use serde::{Deserialize, Serialize};
use std::{
    cell::RefCell,
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Manager, Webview};

const MAX_VIEWS: usize = 16;
#[derive(Default)]
pub(crate) struct HtmlPreviewState {
    sessions: Mutex<HashMap<String, Session>>,
    documents: Mutex<HashMap<String, Arc<AtomicBool>>>,
}
#[derive(Clone)]
struct Session {
    owner: String,
    project: i64,
    alive: Arc<AtomicBool>,
    site: Arc<HtmlSite>,
    page: Arc<Mutex<PageState>>,
}
#[derive(Default)]
struct PageState {
    url: String,
    loading: bool,
    diagnostics: VecDeque<String>,
}
impl PageState {
    fn diagnostic(&mut self, message: impl AsRef<str>) {
        let text: String = message.as_ref().chars().take(1200).collect();
        if self.diagnostics.back() == Some(&text) {
            return;
        }
        if self.diagnostics.len() == 32 {
            self.diagnostics.pop_front();
        }
        self.diagnostics.push_back(text);
    }
}
struct NativeChild {
    // Drop the view before its context/profile (notably WebView2 file handles).
    view: wry::WebView,
    _context: wry::WebContext,
    _profile: tempfile::TempDir,
}
thread_local! { static VIEWS: RefCell<HashMap<String, NativeChild>> = RefCell::new(HashMap::new()); }

impl HtmlPreviewState {
    fn document_lease(&self, parent: &str) -> Arc<AtomicBool> {
        crate::lock_mutex(&self.documents)
            .entry(parent.into())
            .or_insert_with(|| Arc::new(AtomicBool::new(true)))
            .clone()
    }
    fn retire_documents(&self, parent: Option<&str>) {
        let mut documents = crate::lock_mutex(&self.documents);
        if let Some(parent) = parent {
            if let Some(alive) = documents.remove(parent) {
                alive.store(false, Ordering::Release);
            }
        } else {
            for (_, alive) in documents.drain() {
                alive.store(false, Ordering::Release);
            }
        }
    }
    fn session(&self, caller: &Webview, id: &str) -> Result<Session, String> {
        let item = crate::lock_mutex(&self.sessions)
            .get(id)
            .cloned()
            .ok_or("网页会话已关闭，请刷新")?;
        crate::project_directory::authorize_caller(caller, item.project)?;
        if item.owner != caller.label() || !item.alive.load(Ordering::Acquire) {
            return Err("此窗口不能控制该网页".into());
        }
        Ok(item)
    }
    fn remove(&self, id: &str) -> Option<Session> {
        let item = crate::lock_mutex(&self.sessions).remove(id)?;
        item.alive.store(false, Ordering::Release);
        item.site.close();
        Some(item)
    }
    pub fn detach_parent(&self, app: &AppHandle, parent: &str) {
        self.retire_documents(Some(parent));
        let ids: Vec<_> = crate::lock_mutex(&self.sessions)
            .iter()
            .filter(|(_, session)| session.owner == parent)
            .map(|(id, _)| id.clone())
            .collect();
        self.detach(app, ids);
    }
    pub fn close_all(&self, app: &AppHandle) {
        self.retire_documents(None);
        let ids = crate::lock_mutex(&self.sessions).keys().cloned().collect();
        self.detach(app, ids);
    }
    fn detach(&self, app: &AppHandle, ids: Vec<String>) {
        for id in &ids {
            self.remove(id);
        }
        // A stopped application already dropped its platform views. HTTP leases
        // are revoked above even if its event loop can no longer accept work.
        let _ = app.run_on_main_thread(move || {
            VIEWS.with(|views| {
                let mut views = views.borrow_mut();
                for id in ids {
                    views.remove(&id);
                }
            })
        });
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeLayout {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewport_width: f64,
    viewport_height: f64,
    visible: bool,
    #[serde(default)]
    page_width: f64,
}
impl NativeLayout {
    fn zoom(&self, rect: &wry::Rect, system_scale: f64) -> Result<f64, String> {
        if !self.page_width.is_finite()
            || self.page_width < 0.0
            || !system_scale.is_finite()
            || system_scale <= 0.0
        {
            return Err("网页缩放尺寸无效".into());
        }
        let css_width = if self.page_width > 0.0 {
            self.page_width
        } else {
            self.width
        };
        Ok(rect.size.to_physical::<u32>(1.0).width as f64 / system_scale / css_width)
    }
    fn rect(&self, client: tauri::PhysicalSize<u32>) -> Result<Option<wry::Rect>, String> {
        if !self.visible {
            return Ok(None);
        }
        if ![
            self.x,
            self.y,
            self.width,
            self.height,
            self.viewport_width,
            self.viewport_height,
        ]
        .iter()
        .all(|n| n.is_finite())
            || self.viewport_width <= 0.0
            || self.viewport_height <= 0.0
        {
            return Err("网页视口尺寸无效".into());
        }
        let left = self.x.max(0.0).min(self.viewport_width);
        let top = self.y.max(0.0).min(self.viewport_height);
        let right = (self.x + self.width).min(self.viewport_width);
        let bottom = (self.y + self.height).min(self.viewport_height);
        if right <= left || bottom <= top || client.width == 0 || client.height == 0 {
            return Ok(None);
        }
        let scale_x = client.width as f64 / self.viewport_width;
        let scale_y = client.height as f64 / self.viewport_height;
        Ok(Some(wry::Rect {
            position: wry::dpi::PhysicalPosition::new(
                (left * scale_x).round() as i32,
                (top * scale_y).round() as i32,
            )
            .into(),
            size: wry::dpi::PhysicalSize::new(
                ((right - left) * scale_x).round() as u32,
                ((bottom - top) * scale_y).round() as u32,
            )
            .into(),
        }))
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreatedPreview {
    id: String,
    url: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewStatus {
    url: String,
    loading: bool,
    diagnostics: Vec<String>,
}

fn web_navigation(url: &str) -> bool {
    tauri::Url::parse(url).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && !matches!(
                url.host_str(),
                Some("asset.localhost" | "tauri.localhost" | "ipc.localhost")
            )
    })
}
async fn on_ui<T: Send + 'static>(
    app: &AppHandle,
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = send.send(task());
    })
    .map_err(|error| error.to_string())?;
    receive
        .await
        .map_err(|_| "网页视图主线程已停止".to_string())?
}
fn with_view<T>(
    id: &str,
    task: impl FnOnce(&wry::WebView) -> Result<T, wry::Error>,
) -> Result<T, String> {
    VIEWS.with(|views| {
        let views = views.borrow();
        task(&views.get(id).ok_or("网页视图已关闭")?.view).map_err(|error| error.to_string())
    })
}
const DIAGNOSTIC_SCRIPT: &str = r#"(()=>{
const report=message=>{try{window.ipc.postMessage(JSON.stringify({message:String(message).slice(0,1200)}));}catch{}};
addEventListener('error',event=>{
 if(event.target && event.target!==window){const node=event.target;report('资源加载失败：'+(node.getAttribute?.('src')||node.getAttribute?.('href')||node.tagName||''));}
 else report(event.message||'网页脚本执行失败');
},true);
addEventListener('unhandledrejection',event=>report('未处理的脚本错误：'+String(event.reason)));
})()"#;

#[tauri::command]
pub(crate) async fn html_preview_create(
    caller: Webview,
    app: AppHandle,
    binding: WorkspaceBinding,
    input: FileBytesInput,
    historical: bool,
) -> Result<CreatedPreview, String> {
    let Scope::Project { project_id } = &input.object.scope else {
        return Err("网页必须属于项目".into());
    };
    let project = *project_id;
    crate::project_directory::authorize_caller(&caller, project)?;
    // Capture before the first await: reload may precede Session insertion.
    let document_alive = app
        .state::<HtmlPreviewState>()
        .document_lease(caller.label());
    let prepared = Arc::new(
        crate::project_directory::bound_file_command(&*app.state::<AppState>(), &binding, |db| {
            PreparedFile::read(db, input, historical)
        })
        .map_err(|error| error.message)?,
    );
    let reader_app = app.clone();
    let reader_binding = binding.clone();
    let files = prepared.clone();
    let read: AssetReader = Arc::new(move |path| {
        crate::project_directory::bound_file_command(
            &*reader_app.state::<AppState>(),
            &reader_binding,
            |db| files.read_related(db, path),
        )
        .map_err(|error| error.message)
    });
    let validator_app = app.clone();
    let validator_binding = binding.clone();
    let files = prepared.clone();
    let validate: Validator = Arc::new(move || {
        crate::project_directory::bound_file_command(
            &*validator_app.state::<AppState>(),
            &validator_binding,
            |db| files.validate(db),
        )
        .map_err(|error| error.message)
    });
    let site = Arc::new(
        HtmlSite::start(
            prepared.name.clone(),
            prepared.bytes.clone(),
            read,
            validate,
        )
        .await?,
    );
    let id = format!("html-preview-{:032x}", rand::random::<u128>());
    let alive = Arc::new(AtomicBool::new(true));
    let page = Arc::new(Mutex::new(PageState {
        url: site.root_url().to_string(),
        loading: true,
        ..Default::default()
    }));
    {
        let state = app.state::<HtmlPreviewState>();
        let mut sessions = crate::lock_mutex(&state.sessions);
        if sessions.len() >= MAX_VIEWS {
            site.close();
            return Err("已打开 16 个网页，请先关闭部分网页标签".into());
        }
        sessions.insert(
            id.clone(),
            Session {
                owner: caller.label().into(),
                project,
                alive: alive.clone(),
                site: site.clone(),
                page: page.clone(),
            },
        );
    }
    let parent = caller.window();
    let child_id = id.clone();
    let start = site.bootstrap_url().to_string();
    let root_url = site.root_url().to_string();
    let new_window_app = app.clone();
    let child_page = page.clone();
    let child_alive = alive.clone();
    let child_document_alive = document_alive.clone();
    let result = on_ui(&app, move || {
        if !child_alive.load(Ordering::Acquire) || !child_document_alive.load(Ordering::Acquire) {
            return Err("网页已关闭".into());
        }
        let profile = tempfile::Builder::new()
            .prefix("project-mind-web-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        let mut context = wry::WebContext::new(Some(profile.path().to_path_buf()));
        let load_page = child_page.clone();
        let navigation_page = child_page.clone();
        let download_page = child_page.clone();
        let messages_page = child_page.clone();
        let new_id = child_id.clone();
        let new_page = child_page.clone();
        let view = wry::WebViewBuilder::new_with_web_context(&mut context)
            .with_url(&start)
            .with_visible(false)
            .with_focused(false)
            .with_incognito(true)
            .with_general_autofill_enabled(false)
            .with_bounds(wry::Rect {
                position: wry::dpi::LogicalPosition::new(0, 0).into(),
                size: wry::dpi::LogicalSize::new(1, 1).into(),
            })
            // No Tauri wrapper: no asset/tauri/ipc custom protocols and no Tauri
            // initialization scripts or invoke handler are registered here.
            .with_initialization_script_for_main_only(DIAGNOSTIC_SCRIPT, false)
            .with_ipc_handler(move |request| {
                // Diagnostics are untrusted bounded text only, never commands.
                if request.body().len() > 8192 {
                    return;
                }
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(request.body()) {
                    if let Some(message) = value.get("message").and_then(|v| v.as_str()) {
                        crate::lock_mutex(&messages_page).diagnostic(message);
                    }
                }
            })
            .with_navigation_handler(move |url| {
                let allowed = web_navigation(&url);
                if !allowed {
                    crate::lock_mutex(&navigation_page).diagnostic("已阻止本机文件或应用协议导航");
                }
                allowed
            })
            .with_on_page_load_handler(move |event, url| {
                let mut page = crate::lock_mutex(&load_page);
                page.loading = matches!(event, wry::PageLoadEvent::Started);
                // Never expose the secret bootstrap URL in trusted chrome.
                page.url = if url == start { root_url.clone() } else { url };
            })
            .with_download_started_handler(move |_, _| {
                crate::lock_mutex(&download_page)
                    .diagnostic("暂不支持下载，请使用外部浏览器打开网页");
                false
            })
            .with_new_window_req_handler(move |url, _| {
                if web_navigation(&url) {
                    let next_app = new_window_app.clone();
                    let next_id = new_id.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = on_ui(&next_app, move || {
                            with_view(&next_id, |view| view.load_url(&url))
                        })
                        .await;
                    });
                } else {
                    crate::lock_mutex(&new_page).diagnostic("已阻止本机文件或应用协议新窗口");
                }
                wry::NewWindowResponse::Deny
            })
            .build_as_child(&parent)
            .map_err(|error| format!("无法创建网页视图：{error}"))?;
        if !child_alive.load(Ordering::Acquire) || !child_document_alive.load(Ordering::Acquire) {
            return Err("网页已关闭".into());
        }
        VIEWS.with(|views| {
            views.borrow_mut().insert(
                child_id,
                NativeChild {
                    view,
                    _context: context,
                    _profile: profile,
                },
            )
        });
        Ok(())
    })
    .await;
    let validation =
        crate::project_directory::bound_file_command(&*app.state::<AppState>(), &binding, |db| {
            prepared.validate(db)
        })
        .map_err(|error| error.message);
    if let Err(error) = result.and(validation) {
        app.state::<HtmlPreviewState>().detach(&app, vec![id]);
        return Err(error);
    }
    // Parent reload/Workspace change may have invalidated the lease while Wry
    // entered the native event loop during creation (especially WebView2).
    if !alive.load(Ordering::Acquire) {
        return Err("网页已关闭".into());
    }
    Ok(CreatedPreview {
        id,
        url: site.root_url().into(),
    })
}
#[tauri::command]
pub(crate) async fn html_preview_layout(
    caller: Webview,
    app: AppHandle,
    id: String,
    bounds: NativeLayout,
) -> Result<(), String> {
    let session = app.state::<HtmlPreviewState>().session(&caller, &id)?;
    let parent = caller.window();
    on_ui(&app, move || {
        if !session.alive.load(Ordering::Acquire) {
            return Ok(());
        }
        let rect = bounds.rect(parent.inner_size().map_err(|error| error.to_string())?)?;
        let zoom = rect
            .as_ref()
            .map(|rect| {
                bounds.zoom(
                    rect,
                    parent.scale_factor().map_err(|error| error.to_string())?,
                )
            })
            .transpose()?;
        with_view(&id, |view| {
            if let Some(rect) = rect {
                view.set_bounds(rect)?;
                view.zoom(zoom.unwrap())?;
                view.set_visible(true)
            } else {
                view.set_visible(false)
            }
        })
    })
    .await
}
#[tauri::command]
pub(crate) async fn html_preview_action(
    caller: Webview,
    app: AppHandle,
    id: String,
    action: String,
) -> Result<(), String> {
    let session = app.state::<HtmlPreviewState>().session(&caller, &id)?;
    on_ui(&app, move || {
        if !session.alive.load(Ordering::Acquire) {
            return Err("网页已关闭".into());
        }
        with_view(&id, |view| match action.as_str() {
            "back" => view.evaluate_script("history.back()"),
            "forward" => view.evaluate_script("history.forward()"),
            "reload" => view.reload(),
            _ => {
                return Err(wry::Error::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "无效网页操作",
                )))
            }
        })
    })
    .await
}
#[tauri::command]
pub(crate) fn html_preview_status(
    caller: Webview,
    app: AppHandle,
    id: String,
) -> Result<PreviewStatus, String> {
    let session = app.state::<HtmlPreviewState>().session(&caller, &id)?;
    let page = crate::lock_mutex(&session.page);
    let mut diagnostics: Vec<_> = page.diagnostics.iter().cloned().collect();
    diagnostics.extend(session.site.diagnostics());
    diagnostics.truncate(64);
    Ok(PreviewStatus {
        url: page.url.clone(),
        loading: page.loading,
        diagnostics,
    })
}
#[tauri::command]
pub(crate) async fn html_preview_close(
    caller: Webview,
    app: AppHandle,
    id: String,
) -> Result<(), String> {
    let state = app.state::<HtmlPreviewState>();
    if !crate::lock_mutex(&state.sessions).contains_key(&id) {
        return Ok(());
    }
    state.session(&caller, &id)?;
    state.remove(&id);
    on_ui(&app, move || {
        VIEWS.with(|views| views.borrow_mut().remove(&id));
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parent_reload_retires_pending_creation_without_invalidating_other_windows() {
        let state = HtmlPreviewState::default();
        let pending = state.document_lease("main");
        let other = state.document_lease("project-2");
        state.retire_documents(Some("main"));
        assert!(!pending.load(Ordering::Acquire));
        assert!(other.load(Ordering::Acquire));
        let next = state.document_lease("main");
        assert!(next.load(Ordering::Acquire));
        state.retire_documents(None);
        assert!(!next.load(Ordering::Acquire));
        assert!(!other.load(Ordering::Acquire));
    }
    #[test]
    fn native_layout_uses_physical_client_size_for_dpi_and_browser_zoom() {
        let bounds = NativeLayout {
            x: 100.0,
            y: 80.0,
            width: 400.0,
            height: 300.0,
            viewport_width: 1000.0,
            viewport_height: 800.0,
            visible: true,
            page_width: 0.0,
        };
        let rect = bounds
            .rect(tauri::PhysicalSize::new(1500, 1200))
            .unwrap()
            .unwrap();
        assert_eq!(
            rect.position.to_physical::<i32>(1.0),
            wry::dpi::PhysicalPosition::new(150, 120)
        );
        assert_eq!(
            rect.size.to_physical::<u32>(1.0),
            wry::dpi::PhysicalSize::new(600, 450)
        );
    }
    #[test]
    fn native_layout_preserves_selected_css_width_when_scaled_to_fit() {
        let mut bounds = NativeLayout {
            x: 100.0,
            y: 80.0,
            width: 400.0,
            height: 300.0,
            viewport_width: 1000.0,
            viewport_height: 800.0,
            visible: true,
            page_width: 1440.0,
        };
        let rect = bounds
            .rect(tauri::PhysicalSize::new(1500, 1200))
            .unwrap()
            .unwrap();
        assert!((bounds.zoom(&rect, 1.5).unwrap() - 0.2777777778).abs() < 0.000001);
        bounds.page_width = 375.0;
        assert!((bounds.zoom(&rect, 1.5).unwrap() - 1.0666666667).abs() < 0.000001);
    }
    #[test]
    fn hidden_or_outside_views_have_no_native_rectangle() {
        let mut bounds = NativeLayout {
            x: 100.0,
            y: 80.0,
            width: 400.0,
            height: 300.0,
            viewport_width: 1000.0,
            viewport_height: 800.0,
            visible: false,
            page_width: 0.0,
        };
        assert!(bounds
            .rect(tauri::PhysicalSize::new(1000, 800))
            .unwrap()
            .is_none());
        bounds.visible = true;
        bounds.x = 1001.0;
        assert!(bounds
            .rect(tauri::PhysicalSize::new(1000, 800))
            .unwrap()
            .is_none());
    }
    #[test]
    fn navigation_accepts_web_pages_and_rejects_local_application_protocols() {
        assert!(web_navigation("https://example.com/page"));
        assert!(web_navigation("http://127.0.0.1:12345/index.html"));
        for url in [
            "file:///C:/Users/a",
            "asset:///etc/passwd",
            "tauri://localhost",
            "http://asset.localhost/a",
            "https://tauri.localhost/",
            "javascript:alert(1)",
            "ipc://localhost",
        ] {
            assert!(!web_navigation(url), "{url}");
        }
    }
}
