import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { AgentWorkspaceBinding } from "../../lib/agent-types";
import type { FileBytesInput } from "../../lib/file-types";
import { htmlPreviewApi, type HtmlPreviewBounds, type HtmlPreviewStatus } from "../../services/htmlPreviewApi";
import "./project-file-content.css";

export interface HtmlWebviewContentProps {
  binding: AgentWorkspaceBinding;
  input: FileBytesInput;
  historical: boolean;
  visible: boolean;
}
const overlays = '[role="dialog"], [role="menu"], [role="listbox"], .context-menu__panel, [popover]';
function hidden(element: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (current.hasAttribute("hidden") || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return true;
  }
  return false;
}
function errorMessage(error: unknown): string {
  return error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
}
/** Owns one native browsing context. Ordinary visibility changes only change its bounds. */
export function HtmlWebviewContent({ binding, input, historical, visible }: HtmlWebviewContentProps) {
  const host = useRef<HTMLDivElement>(null);
  const shown = useRef(visible); shown.current = visible;
  const update = useRef<() => void>(() => {});
  const [width, setWidth] = useState(0);
  const pageWidth = useRef(width); pageWidth.current = width;
  const [sessionId, setSessionId] = useState<string>();
  const [status, setStatus] = useState<HtmlPreviewStatus>();
  const [error, setError] = useState<string>();
  const actionRevision = useRef(0);

  useEffect(() => {
    const element = host.current!;
    const root = element.closest(".html-webview")!;
    let disposed = false;
    let id: string | undefined;
    let pending = false;
    let pendingRetired = false;
    let failed = false;
    let lastBounds = "";
    let effectiveVisible = false;
    let statusRevision = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    let layoutQueue = Promise.resolve();
    setSessionId(undefined); setStatus(undefined); setError(undefined);
    const close = (session: string) => {
      void htmlPreviewApi.close(session).catch(failure => console.error("HTML 会话释放失败", failure));
    };
    const eligible = () => shown.current && !hidden(element);
    function bounds(): HtmlPreviewBounds {
      const rect = element.getBoundingClientRect();
      let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
      let right = Math.min(window.innerWidth, rect.right), bottom = Math.min(window.innerHeight, rect.bottom);
      // Clip to actual ancestor viewports so native content cannot cover adjacent panes.
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const area = parent.getBoundingClientRect();
        if (/(hidden|clip|auto|scroll)/u.test(`${style.overflow} ${style.overflowX}`)) { left = Math.max(left, area.left); right = Math.min(right, area.right); }
        if (/(hidden|clip|auto|scroll)/u.test(`${style.overflow} ${style.overflowY}`)) { top = Math.max(top, area.top); bottom = Math.min(bottom, area.bottom); }
      }
      const dragging = Array.from(document.querySelectorAll('.project-content[data-dragging], .workspace-topbar__tab.opacity-60')).some(tab => !hidden(tab));
      let show = eligible() && right > left && bottom > top && !dragging;
      if (show) for (const overlay of document.querySelectorAll(overlays)) {
        if (hidden(overlay)) continue;
        const area = overlay.getBoundingClientRect();
        if (area.width > 0 && area.height > 0 && area.left < right && area.right > left && area.top < bottom && area.bottom > top) { show = false; break; }
      }
      return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top), viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, visible: show, pageWidth: pageWidth.current };
    }
    async function poll(revision: number, session: string) {
      try {
        const next = await htmlPreviewApi.status(session);
        if (disposed || revision !== statusRevision || !effectiveVisible || id !== session) return;
        setStatus(next);
      } catch (failure) {
        if (disposed || revision !== statusRevision || !effectiveVisible || id !== session) return;
        setError(errorMessage(failure));
      }
      if (!disposed && revision === statusRevision && effectiveVisible) timer = setTimeout(() => void poll(revision, session), 750);
    }
    function sync() {
      if (disposed) return;
      if (pending && !eligible()) pendingRetired = true;
      if (!id && !pending && !failed && eligible()) {
        pending = true;
        pendingRetired = false;
        void htmlPreviewApi.create(binding, input, historical).then(session => {
          pending = false;
          if (disposed || pendingRetired || !eligible()) {
            close(session.id);
            if (!disposed) sync();
            return;
          }
          id = session.id; setSessionId(id); sync();
        }, failure => {
          pending = false;
          if (disposed) return;
          if (pendingRetired || !eligible()) { sync(); return; }
          if (!disposed && eligible()) { failed = true; setError(errorMessage(failure)); }
        });
      }
      if (!id) return;
      const next = bounds();
      if (next.visible && !frame) frame = requestAnimationFrame(trackPosition);
      else if (!next.visible && frame) { cancelAnimationFrame(frame); frame = 0; }
      if (next.visible !== effectiveVisible) {
        effectiveVisible = next.visible;
        actionRevision.current++;
        statusRevision++;
        clearTimeout(timer);
        if (effectiveVisible) void poll(statusRevision, id);
      }
      const signature = JSON.stringify(next);
      if (signature === lastBounds) return;
      lastBounds = signature;
      const session = id;
      // Preserve hide/show ordering even when native dispatch is asynchronous.
      layoutQueue = layoutQueue.then(async () => {
        if (!disposed && id === session) await htmlPreviewApi.layout(session, next);
      }).catch(failure => { if (!disposed && id === session) setError(errorMessage(failure)); });
    }
    update.current = sync;
    const resize = new ResizeObserver(sync);
    for (let current: Element | null = element; current; current = current.parentElement) resize.observe(current);
    const mutation = new MutationObserver(records => {
      // Status text and diagnostics are React-owned; observing them would feed back into layout.
      if (records.some(record => !root.contains(record.target))) sync();
      else if (records.some(record => record.type === 'attributes')) sync();
    });
    mutation.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "class", "style", "open", "popover", "data-dragging"] });
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    document.addEventListener("toggle", sync, true);
    // Position can change without resize (split panes, CSS transitions, dragging).
    // Hidden/occluded contexts resume through the observers and window events.
    function trackPosition() { frame = 0; sync(); }
    sync();
    return () => {
      disposed = true; actionRevision.current++; statusRevision++; update.current = () => {};
      clearTimeout(timer); cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect();
      window.removeEventListener("resize", sync); window.removeEventListener("scroll", sync, true); document.removeEventListener("toggle", sync, true);
      if (id) close(id);
    };
    // Session identity is the fixed File and Workspace generation, never object allocation or visibility.
  }, [binding.workspaceId, binding.generation, input.object.workspaceId, input.object.id, input.object.scope.kind,
    input.object.scope.kind === "project" ? input.object.scope.projectId : undefined, input.versionNumber, input.expectedContentHash, historical]);
  useEffect(() => { update.current(); }, [visible, width]);

  async function navigate(action: "back" | "forward") {
    if (!sessionId) return;
    const revision = ++actionRevision.current;
    try { await htmlPreviewApi.action(sessionId, action); }
    catch (failure) { if (revision === actionRevision.current) setError(errorMessage(failure)); }
  }
  return <section className="html-webview" aria-label="HTML 网页">
    <div className="project-file-content__toolbar html-webview__toolbar" role="toolbar" aria-label="网页导航和视口">
      <button type="button" aria-label="后退" title="后退" disabled={!sessionId} onClick={() => void navigate("back")}><ArrowLeft size={14} aria-hidden="true" /></button>
      <button type="button" aria-label="前进" title="前进" disabled={!sessionId} onClick={() => void navigate("forward")}><ArrowRight size={14} aria-hidden="true" /></button>
      <label>视口 <select aria-label="网页视口宽度" value={width} onChange={event => setWidth(Number(event.target.value))}>
        <option value={0}>自适应</option><option value={375}>375</option><option value={768}>768</option><option value={1440}>1440</option>
      </select></label>
      {status?.loading ? <span role="status">网页加载中…</span> : null}
    </div>
    {error ? <p role="alert" className="project-file-content__notice">网页运行失败：{error}</p> : null}
    {status?.diagnostics.map((diagnostic, index) => <p role="status" className="project-file-content__notice" key={index}>{diagnostic}</p>)}
    <div className="html-webview__stage"><div ref={host} className="html-webview__host" style={{ width: width ? `min(100%, ${width}px)` : "100%" }} aria-label="原生网页显示区域" /></div>
  </section>;
}
