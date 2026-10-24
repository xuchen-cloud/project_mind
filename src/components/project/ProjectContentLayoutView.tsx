import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftRight, Columns2, Home, Merge, X } from "lucide-react";
import { AiChatIcon, RecordIcon } from "../icons/ContentTypeIcon";
import { TabStripScroll } from "../../ui/components/TabStripScroll";
import "../../ui/tab-strip.css";
import { measureTabLabels } from "../../ui/tab-strip";
import { FileIcon } from "../document/FileIcon";
import type { ContentPane, ContentScope, ContentTab, ProjectContentLayout } from "../../lib/project-content-layout";
import { dshProjectRunKey, useAgentPanelStore } from "../../state/agent-panel-store";
import { MOTION_DURATION_MS } from "../../ui/motion";
import { useProjectContentStore } from "../../state/project-content-store";
import "./project-content.css";

type PaneId = ContentPane["id"];
export interface ContentPageProps {
  tab: ContentTab;
  visible: boolean;
  focused: boolean;
  registerCloseGuard: (guard: () => Promise<void>) => () => void;
}

interface TabDragZone {
  node: HTMLElement;
  hover: (x: number) => void;
  leave: () => void;
  drop: (id: string, x: number) => void;
}
interface TabLanding { index: number; id?: string; edge?: "before" | "after" }
/** Freeze the live tab's hover/selection, label mask and icon styles outside its strip. */
function cloneDragTab(source: HTMLElement): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement;
  const originals = [source, ...source.querySelectorAll<HTMLElement | SVGElement>("*")];
  const copies = [clone, ...clone.querySelectorAll<HTMLElement | SVGElement>("*")];
  originals.forEach((original, index) => {
    const copy = copies[index], style = getComputedStyle(original);
    for (const property of Array.from(style)) copy.style.setProperty(property, style.getPropertyValue(property));
    copy.style.transition = "none";
    copy.style.animation = "none";
    copy.style.outline = "none";
    copy.style.boxShadow = "none";
    copy.style.pointerEvents = "none";
    for (const attribute of [...copy.attributes]) {
      if (attribute.name === "id" || attribute.name === "role" || attribute.name.startsWith("aria-")
        || ["data-tab-id", "data-drop", "data-dragging", "title"].includes(attribute.name)) copy.removeAttribute(attribute.name);
    }
    if (copy instanceof HTMLElement) copy.tabIndex = -1;
  });
  const bounds = source.getBoundingClientRect();
  // The inherited standard-width cap and focus decoration must not alter the snapshot.
  clone.style.width = clone.style.minWidth = clone.style.maxWidth = `${bounds.width}px`;
  clone.style.height = clone.style.minHeight = clone.style.maxHeight = `${bounds.height}px`;
  clone.style.transform = "none";
  clone.inert = true;
  return clone;
}
function tabTypeLabel(tab: ContentTab): string {
  if (tab.object.kind === "record") return tab.object.isVoice ? "语音记录" : "记录";
  if (tab.object.kind === "session") return "会话";
  const extension = tab.object.title.includes(".") ? tab.object.title.split(".").pop()?.toLowerCase() : undefined;
  if (extension === "md" || extension === "markdown") return "Markdown 文件";
  if (extension === "pdf") return "PDF 文件";
  if (["csv", "xls", "xlsx"].includes(extension ?? "")) return "表格文件";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension ?? "")) return "图片文件";
  if (["js", "ts", "tsx", "jsx", "json", "py", "rs", "html", "css"].includes(extension ?? "")) return "代码文件";
  return extension ? `${extension.toUpperCase()} 文件` : "文件";
}
function TabBar({ pane, layout, onSelect, onOverview, onClose, scope, dragging, startDrag, dragZones, shown }: {
  pane: ContentPane; layout: ProjectContentLayout; scope: ContentScope; shown: boolean;
  dragging: string | null; startDrag: (event: React.PointerEvent<HTMLElement>, id: string) => void;
  dragZones: Map<PaneId, TabDragZone>;
  onSelect: (paneId: PaneId, tabId: string) => void;
  onOverview: () => void;
  onClose: (tabId: string) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const memberKey = pane.tabIds.join("|");
  const [edges, setEdges] = useState({ left: 0, right: 0 });
  const [landing, setLanding] = useState<TabLanding | null>(null);
  const dragX = useRef<number | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const sessionRuns = useAgentPanelStore(state => state.workspaceRoot
    ? state.sessionsByProject[dshProjectRunKey(state.workspaceRoot, scope.projectId)] : undefined);
  function measure(labels = false) {
    const node = viewport.current;
    if (!node) return;
    const max = Math.max(0, node.scrollWidth - node.clientWidth);
    const position = Math.max(0, Math.min(max, node.scrollLeft));
    const distance = Math.min(64, max / 2);
    const next = { left: distance ? Math.min(1, position / distance) : 0, right: distance ? Math.min(1, (max - position) / distance) : 0 };
    setEdges(previous => previous.left === next.left && previous.right === next.right ? previous : next);
    if (labels) measureTabLabels(content.current);
  }
  function revealSelected() {
    const node = viewport.current;
    const selected = document.getElementById(`content-tab-${pane.selectedTabId}`)?.closest<HTMLElement>(".project-content__tab");
    if (!node || !selected || !shown) return;
    const bounds = node.getBoundingClientRect(), tab = selected.getBoundingClientRect();
    const max = Math.max(0, node.scrollWidth - node.clientWidth);
    // Only move this strip: scrollIntoView could scroll the workspace or editor.
    const delta = tab.left < bounds.left + 6 ? tab.left - bounds.left - 6
      : tab.right > bounds.right - 6 ? tab.right - bounds.right + 6 : 0;
    node.scrollLeft = Math.max(0, Math.min(max, node.scrollLeft + delta));
    measure();
  }
  function stopAutoScroll() {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null; dragX.current = null;
  }
  function landingAt(x: number): TabLanding {
    const items = [...(content.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? [])];
    for (const [index, item] of items.entries()) {
      const bounds = item.getBoundingClientRect();
      if (x < bounds.right) {
        const edge = x < bounds.left + bounds.width / 2 ? "before" : "after";
        return { index: index + (edge === "after" ? 1 : 0), id: pane.tabIds[index], edge };
      }
    }
    return { index: items.length, id: pane.tabIds[pane.tabIds.length - 1], edge: "after" as const };
  }
  function autoScroll() {
    scrollFrame.current = null;
    const node = viewport.current, x = dragX.current;
    if (!node || x === null) return;
    const bounds = node.getBoundingClientRect(), edge = 32;
    const velocity = x < bounds.left + edge ? -Math.min(1, (bounds.left + edge - x) / edge)
      : x > bounds.right - edge ? Math.min(1, (x - bounds.right + edge) / edge) : 0;
    const previous = node.scrollLeft;
    node.scrollLeft = Math.max(0, Math.min(node.scrollWidth - node.clientWidth, previous + velocity * 10));
    if (node.scrollLeft !== previous) { measure(); setLanding(landingAt(x)); }
    if (velocity && node.scrollLeft !== previous) scrollFrame.current = requestAnimationFrame(autoScroll);
  }
  useEffect(() => {
    if (!dragging) { stopAutoScroll(); setLanding(null); }
  }, [dragging]);
  useEffect(() => stopAutoScroll, []);
  useLayoutEffect(() => {
    const update = () => { measure(true); revealSelected(); };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    if (viewport.current) observer.observe(viewport.current);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [pane.selectedTabId, shown]);
  useLayoutEffect(() => { measure(true); revealSelected(); }, [memberKey]);
  useLayoutEffect(() => measure(true), [layout.tabs]);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientWidth : 1;
      const delta = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * factor;
      const next = Math.max(0, Math.min(node.scrollWidth - node.clientWidth, node.scrollLeft + delta));
      if (next === node.scrollLeft) return;
      event.preventDefault(); node.scrollLeft = next; measure();
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, []);
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const zone: TabDragZone = {
      node,
      hover: x => {
        const next = landingAt(x);
        setLanding(previous => previous?.id === next.id && previous?.edge === next.edge && previous?.index === next.index ? previous : next);
        dragX.current = x;
        if (scrollFrame.current === null) scrollFrame.current = requestAnimationFrame(autoScroll);
      },
      leave: () => { stopAutoScroll(); setLanding(null); },
      drop: (id, x) => {
        const sourceIndex = pane.tabIds.indexOf(id), insertion = landingAt(x).index;
        const index = sourceIndex >= 0 && sourceIndex < insertion ? insertion - 1 : insertion;
        stopAutoScroll(); setLanding(null);
        useProjectContentStore.getState().move(scope, id, pane.id, index);
        onSelect(pane.id, id);
        requestAnimationFrame(() => document.getElementById(`content-tab-${id}`)?.focus());
      },
    };
    dragZones.set(pane.id, zone);
    return () => { if (dragZones.get(pane.id) === zone) dragZones.delete(pane.id); };
  }, [pane, layout, scope, onSelect]);
  const tabRects = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const next = new Map<string, DOMRect>(); const animations: Animation[] = [];
    content.current?.querySelectorAll<HTMLElement>("[data-tab-id]").forEach(tab => {
      const id = tab.dataset.tabId!, bounds = tab.getBoundingClientRect(), previous = tabRects.current.get(id);
      next.set(id, bounds);
      if (!previous || !bounds.width || !tab.animate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
      const dx = previous.left - bounds.left;
      if (Math.abs(dx) >= 1) animations.push(tab.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], { duration: MOTION_DURATION_MS.deliberate, easing: "cubic-bezier(.16,1,.3,1)" }));
    });
    tabRects.current = next;
    return () => animations.forEach(animation => animation.cancel());
  }, [memberKey]);
  return <div className="project-content__tab-frame tab-strip-frame" data-drop-empty={landing && !pane.tabIds.length || undefined}
    style={{ "--tab-fade-left": edges.left, "--tab-fade-right": edges.right } as CSSProperties}>
    <div ref={viewport} className="project-content__tab-scroll tab-strip-viewport" onScroll={() => {
      measure();
      content.current?.querySelectorAll<HTMLElement>("[data-tab-id]").forEach(tab => tabRects.current.set(tab.dataset.tabId!, tab.getBoundingClientRect()));
    }}>
      <div ref={content} className="project-content__tabs" role="tablist" aria-label={`${pane.id === "left" ? "左" : "右"}栏内容`}>
        {pane.tabIds.map((id, index) => {
          const tab = layout.tabs.find(item => item.id === id)!;
          const type = tabTypeLabel(tab);
          const running = tab.object.kind === "session" && sessionRuns?.[String(tab.object.id)] === true;
          return <div key={id} className="project-content__tab compact-tab" data-tab-id={id} data-selected={pane.selectedTabId === id || undefined}
            data-running={running || undefined} data-dragging={dragging === id || undefined} data-drop={landing?.id === id ? landing.edge : undefined}
            onClick={event => { if (!(event.target instanceof Element && event.target.closest(".compact-tab__close"))) onSelect(pane.id, id); }}
            onPointerDown={event => { if (!(event.target instanceof Element && event.target.closest(".compact-tab__close"))) startDrag(event, id); }}
            >
            <div className="compact-tab__body">
            <button type="button" role="tab" className="compact-tab__trigger" id={`content-tab-${id}`} aria-controls={`content-page-${id}`} aria-selected={pane.selectedTabId === id}
              aria-label={tab.object.title} aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight Control+Alt+Shift+ArrowLeft Control+Alt+Shift+ArrowRight"
              tabIndex={pane.selectedTabId === id ? 0 : -1}
              title={`${tab.object.title} · ${type}${running ? " · 正在执行" : ""}
Alt+Shift+←/→ 排序；Ctrl+Alt+Shift+←/→ 移到对应栏`}
              onKeyDown={event => {
                if (event.altKey && event.shiftKey && !event.metaKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
                  event.preventDefault(); event.stopPropagation();
                  const store = useProjectContentStore.getState();
                  if (event.ctrlKey) {
                    const other = event.key === "ArrowLeft" ? "left" : "right";
                    if (other !== pane.id && layout.panes.some(item => item.id === other)) { store.move(scope, id, other); onSelect(other, id); }
                  } else { store.reorder(scope, pane.id, id, index + (event.key === "ArrowLeft" ? -1 : 1)); onSelect(pane.id, id); }
                  event.currentTarget.focus();
                  requestAnimationFrame(() => document.getElementById(`content-tab-${id}`)?.focus());
                  return;
                }
                if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                if (pane.id === "left" && ((index === 0 && event.key === "ArrowLeft") || event.key === "Home")) {
                  event.preventDefault(); onOverview(); document.getElementById(`content-home-${scope.projectId}`)?.focus(); return;
                }
                const next = event.key === "ArrowRight" ? (index + 1) % pane.tabIds.length : event.key === "ArrowLeft" ? (index - 1 + pane.tabIds.length) % pane.tabIds.length : event.key === "Home" ? 0 : event.key === "End" ? pane.tabIds.length - 1 : null;
                if (next !== null) { event.preventDefault(); const nextId = pane.tabIds[next]; onSelect(pane.id, nextId); document.getElementById(`content-tab-${nextId}`)?.focus(); }
              }}>
              {tab.object.kind === "file" ? <FileIcon name={tab.object.title} size={16} className="project-content__tab-icon" />
                : tab.object.kind === "record" ? <RecordIcon size={16} isVoice={tab.object.isVoice} className="project-content__tab-icon" />
                : <AiChatIcon size={16} className="project-content__tab-icon" />}
              {running ? <span className="project-content__running" role="status" aria-label="正在执行" /> : null}
              <span className="project-content__tab-title compact-tab__label">{tab.object.title}
                {tab.object.kind === "file" && tab.view.versionNumber !== undefined ? <small>v{tab.view.versionNumber}</small> : null}
              </span>
            </button>
            <button type="button" className="project-content__tab-close compact-tab__close" aria-label={`关闭${tab.object.title}`} title="关闭内容 Tab（Alt+W）" onClick={() => onClose(id)}><X size={14} strokeWidth={1.5} /></button>
            </div>
          </div>;
        })}
      </div>
    </div>
    <TabStripScroll viewportRef={viewport} contentKey={memberKey} ariaLabel={`${pane.id === "left" ? "左" : "右"}栏标签滚动`} />
  </div>;
}

/** Pages stay siblings with stable keys when their grid column changes. */
export function ProjectContentLayoutView({ scope, layout, active, renderPage, renderOverview, onSelect, onOverview, onClose, registerLeaveGuard }: {
  scope: ContentScope; layout: ProjectContentLayout; active: boolean;
  renderPage: (props: ContentPageProps) => ReactNode;
  renderOverview?: (visible: boolean) => ReactNode;
  onSelect: (paneId: PaneId, tabId: string) => void;
  onOverview: () => void;
  onClose: (tabId: string, guard?: () => Promise<void>) => Promise<void>;
  registerLeaveGuard?: (guard: () => Promise<void>) => () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const [contentWidth, setContentWidth] = useState(0);
  const [dragging, setDragging] = useState<string | null>(null);
  const dragZones = useRef(new Map<PaneId, TabDragZone>());
  const dragPreview = useRef<HTMLDivElement>(null);
  const pointerDrag = useRef<{ id: string; pointerId: number; startX: number; startY: number; moving: boolean; capture: HTMLElement } | null>(null);
  const suppressClick = useRef(false);
  function startDrag(event: React.PointerEvent<HTMLElement>, id: string) {
    if (!active || event.button !== 0) return;
    event.preventDefault(); event.currentTarget.querySelector<HTMLButtonElement>("[role=tab]")?.focus();
    const capture = event.currentTarget;
    capture.setPointerCapture?.(event.pointerId);
    pointerDrag.current = { id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moving: false, capture };
    suppressClick.current = false;
  }
  useEffect(() => {
    const targetAt = (event: PointerEvent) => [...dragZones.current.values()].find(zone => {
      const bounds = zone.node.getBoundingClientRect();
      return bounds.width > 0 && event.clientX >= bounds.left && event.clientX < bounds.right && event.clientY >= bounds.top && event.clientY < bounds.bottom;
    });
    const move = (event: PointerEvent) => {
      const state = pointerDrag.current;
      if (!state || state.pointerId !== event.pointerId) return;
      if (!state.moving && Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < 6) return;
      if (!state.moving) {
        dragPreview.current?.replaceChildren(cloneDragTab(state.capture));
        state.moving = true; setDragging(state.id);
      }
      suppressClick.current = true;
      if (dragPreview.current) dragPreview.current.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
      const target = targetAt(event);
      for (const zone of dragZones.current.values()) if (zone === target) zone.hover(event.clientX); else zone.leave();
    };
    const finish = (event?: PointerEvent) => {
      const state = pointerDrag.current;
      if (!state || (event && state.pointerId !== event.pointerId)) return;
      pointerDrag.current = null;
      if (state.capture.hasPointerCapture?.(state.pointerId)) state.capture.releasePointerCapture(state.pointerId);
      dragPreview.current?.replaceChildren();
      dragPreview.current?.style.removeProperty("transform");
      if (event?.type === "pointerup" && state.moving) targetAt(event)?.drop(state.id, event.clientX);
      for (const zone of dragZones.current.values()) zone.leave();
      setDragging(null);
      if (event?.type !== "pointerup") suppressClick.current = false;
      else requestAnimationFrame(() => { suppressClick.current = false; });
    };
    const blur = () => finish();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !pointerDrag.current?.moving) return;
      event.preventDefault(); event.stopPropagation(); finish();
    };
    window.addEventListener("keydown", escape, true);
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", finish); window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish); window.removeEventListener("blur", blur);
      finish();
    };
  }, [scope.workspaceId, scope.projectId, active]);
  const narrow = contentWidth > 0 && contentWidth < 720;
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const guards = useRef(new Map<string, () => Promise<void>>());
  const registrars = useRef(new Map<string, ContentPageProps["registerCloseGuard"]>());
  const currentTabs = useRef(layout.tabs);
  currentTabs.current = layout.tabs;
  useEffect(() => {
    const ids = new Set(layout.tabs.map(tab => tab.id));
    for (const id of guards.current.keys()) if (!ids.has(id)) guards.current.delete(id);
    for (const id of registrars.current.keys()) if (!ids.has(id)) registrars.current.delete(id);
  }, [layout.tabs]);
  useEffect(() => registerLeaveGuard?.(async () => {
    for (const tab of currentTabs.current) if (tab.object.kind === "record" || tab.object.kind === "file") await guards.current.get(tab.id)?.();
  }), [registerLeaveGuard]);
  const split = layout.panes.length === 2;
  const singlePane = narrow;
  useEffect(() => { setDragging(null); }, [scope.workspaceId, scope.projectId]);
  const minRatio = Math.max(0.2, Math.min(320 / (contentWidth || 720), 0.45));
  const displayedRatio = Math.max(minRatio, Math.min(1 - minRatio, layout.ratio));
  const previousRects = useRef(new Map<string, DOMRect>());
  const previousStructure = useRef("");
  const structure = layout.panes.map(pane => `${pane.id}:${pane.tabIds.join(",")}`).join("|");
  useLayoutEffect(() => {
    const pages = root.current?.querySelectorAll<HTMLElement>(".project-content__page:not([hidden]), .project-content__pane-tabs");
    const nextRects = new Map<string, DOMRect>();
    const structureKey = `${structure}:${singlePane}`;
    const animateChange = previousStructure.current !== structureKey;
    previousStructure.current = structureKey;
    const animations: Animation[] = [];
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    pages?.forEach(page => {
      const current = page.getBoundingClientRect();
      const previous = previousRects.current.get(page.id);
      nextRects.set(page.id, current);
      if (!animateChange || reduced || !page.animate || !previous || !previous.width || !previous.height || !current.width || !current.height) return;
      const dx = previous.left - current.left, dy = previous.top - current.top;
      const scaleX = previous.width / current.width, scaleY = previous.height / current.height;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(scaleX - 1) < 0.01 && Math.abs(scaleY - 1) < 0.01) return;
      animations.push(page.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`, transformOrigin: "top left" }, { transform: "none", transformOrigin: "top left" }], { duration: MOTION_DURATION_MS.deliberate, easing: "cubic-bezier(.16,1,.3,1)" }));
    });
    previousRects.current = nextRects;
    return () => animations.forEach(animation => animation.cancel());
  }, [structure, singlePane, layout.focusedPaneId, contentWidth, displayedRatio, layout.panes.map(pane => pane.selectedTabId).join("|")]);
  useLayoutEffect(() => {
    const measure = () => { if (root.current) setContentWidth(root.current.clientWidth); };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  async function close(id: string) {
    if (closing) return;
    setClosing(id); setError(null);
    try { await onClose(id, guards.current.get(id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setClosing(null); }
  }
  function registrar(id: string) {
    let value = registrars.current.get(id);
    if (!value) {
      value = guard => { guards.current.set(id, guard); return () => { if (guards.current.get(id) === guard) guards.current.delete(id); }; };
      registrars.current.set(id, value);
    }
    return value;
  }
  function resize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const node = event.currentTarget;
    node.setPointerCapture(event.pointerId);
    const bounds = root.current!.getBoundingClientRect();
    const move = (next: PointerEvent) => {
      const min = Math.max(0.2, Math.min(320 / bounds.width, 0.45));
      useProjectContentStore.getState().setRatio(scope, Math.max(min, Math.min(1 - min, (next.clientX - bounds.left) / bounds.width)));
    };
    const finish = () => { node.removeEventListener("pointermove", move); node.removeEventListener("pointerup", finish); node.removeEventListener("pointercancel", finish); };
    node.addEventListener("pointermove", move); node.addEventListener("pointerup", finish); node.addEventListener("pointercancel", finish);
  }
  const overviewVisible = active && layout.panes[0].selectedTabId === null && (!singlePane || !split || layout.focusedPaneId === "left");
  return <section ref={root} className="project-content" aria-label={scope.projectId === null ? "工作区内容" : "项目内容"} data-split={split || undefined} data-narrow={narrow || undefined} data-dragging={dragging || undefined}
    onClickCapture={event => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      if ((event.target as HTMLElement).closest('.project-content__tab, [role="tab"]')) { event.preventDefault(); event.stopPropagation(); }
    }}
    style={{ "--content-ratio": `${displayedRatio * 100}%` } as CSSProperties}>
    {createPortal(<div ref={dragPreview} className="project-content__drag-preview" aria-hidden="true" inert hidden={!dragging} />, document.body)}
    {error ? <div className="project-content__error" role="alert">{error}<button type="button" onClick={() => setError(null)} aria-label="关闭错误提示"><X size={13} /></button></div> : null}
    <div className="project-content__grid" onKeyDown={event => {
      if (!active || event.defaultPrevented || (event.target as HTMLElement).closest('[role="dialog"],[role="menu"],.context-menu__panel')) return;
      const pane = layout.panes.find(item => item.id === layout.focusedPaneId)!;
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "w" && pane.selectedTabId) { event.preventDefault(); void close(pane.selectedTabId); }
      if (event.ctrlKey && !event.metaKey && (event.key === "PageUp" || event.key === "PageDown") && pane.tabIds.length) {
        const ids = pane.id === "left" ? [null, ...pane.tabIds] : pane.tabIds;
        event.preventDefault(); const index = ids.indexOf(pane.selectedTabId); const step = event.key === "PageDown" ? 1 : -1;
        const next = ids[(index + step + ids.length) % ids.length];
        if (next === null) onOverview(); else onSelect(pane.id, next);
      }
    }}>
      {layout.panes.map((pane, index) => {
        const shown = !singlePane || !split || pane.id === layout.focusedPaneId;
        return <div key={pane.id} id={`content-pane-${pane.id}`} className="project-content__pane-tabs" data-focused={pane.id === layout.focusedPaneId || undefined} style={{ gridColumn: singlePane ? 1 : index + 1, gridRow: 1, display: shown ? undefined : "none" }}>
          {pane.id === "left" ? <button type="button" id={`content-home-${scope.projectId}`} className="project-content__icon-button project-content__home" aria-label={scope.projectId === null ? "工作区首页" : "项目首页"} title={scope.projectId === null ? "工作区首页" : "项目首页"}
            aria-pressed={pane.selectedTabId === null} aria-controls={`content-home-page-${scope.projectId}`} onClick={onOverview}
            onKeyDown={event => {
              if ((event.key === "ArrowRight" || event.key === "ArrowLeft" || event.key === "End") && pane.tabIds.length) {
                const id = pane.tabIds[event.key === "ArrowRight" ? 0 : pane.tabIds.length - 1];
                event.preventDefault(); onSelect(pane.id, id); document.getElementById(`content-tab-${id}`)?.focus();
              }
            }}><Home size={16} strokeWidth={1.6} /></button> : null}
          <TabBar pane={pane} layout={layout} scope={scope} onSelect={onSelect} onOverview={onOverview} onClose={id => void close(id)} dragging={dragging} startDrag={startDrag} dragZones={dragZones.current} shown={shown} />
          <div className="project-content__tab-actions">
            {split && singlePane ? <button type="button" className="project-content__icon-button" aria-label="切换另一栏" title="切换另一栏"
              onClick={() => useProjectContentStore.getState().focus(scope, pane.id === "left" ? "right" : "left")}><ArrowLeftRight size={15} /></button> : null}
            {!split ? <button type="button" className="project-content__icon-button" aria-label="分栏" title="分栏：将当前 Tab 移到右栏"
              onClick={() => useProjectContentStore.getState().split(scope)}><Columns2 size={16} strokeWidth={1.6} /></button> : null}
            {split && pane.id === "right" ? <button type="button" className="project-content__icon-button" aria-label="合并分栏" title="合并分栏"
              onClick={() => useProjectContentStore.getState().merge(scope)}><Merge size={16} strokeWidth={1.6} /></button> : null}
          </div>
        </div>;
      })}
      <div id={`content-home-page-${scope.projectId}`} role="region" aria-label={scope.projectId === null ? "工作区首页" : "项目首页"} className="project-content__page project-content__overview"
        hidden={!overviewVisible} inert={!overviewVisible} style={{ gridColumn: 1, gridRow: 2 }}
        onPointerDownCapture={() => useProjectContentStore.getState().focus(scope, "left")} onFocusCapture={() => useProjectContentStore.getState().focus(scope, "left")}>
        {renderOverview?.(overviewVisible)}
      </div>
      {layout.tabs.map(tab => {
        const index = layout.panes.findIndex(pane => pane.tabIds.includes(tab.id));
        const pane = layout.panes[index];
        const visible = active && pane.selectedTabId === tab.id && (!singlePane || !split || pane.id === layout.focusedPaneId);
        const focused = visible && pane.id === layout.focusedPaneId;
        return <div key={tab.id} id={`content-page-${tab.id}`} role="tabpanel" aria-labelledby={`content-tab-${tab.id}`} className="project-content__page"
          hidden={!visible} inert={!visible} style={{ gridColumn: singlePane ? 1 : index + 1, gridRow: 2 }} data-content-object={`${tab.object.kind}:${tab.object.id}`}
          onPointerDownCapture={() => useProjectContentStore.getState().focus(scope, pane.id)} onFocusCapture={() => useProjectContentStore.getState().focus(scope, pane.id)}>
          {renderPage({ tab, visible, focused, registerCloseGuard: registrar(tab.id) })}
        </div>;
      })}
      {layout.panes.filter(pane => pane.id === "right" && pane.selectedTabId === null).map(pane => <div key={`empty-${pane.id}`} className="project-content__empty" style={{ gridColumn: singlePane ? 1 : layout.panes.indexOf(pane) + 1, gridRow: 2 }} hidden={!active || (singlePane && split && pane.id !== layout.focusedPaneId)}
        onPointerDown={() => useProjectContentStore.getState().focus(scope, pane.id)}><p>在这栏打开{scope.projectId === null ? "工作区" : "项目"}内容</p><span>从记录、文件或会话列表选择内容，或将 Tab 移到此栏。</span></div>)}
      {split && !singlePane ? <div className="project-content__divider" role="separator" aria-label="调整内容分栏比例" aria-orientation="vertical" aria-valuemin={Math.round(minRatio * 100)} aria-valuemax={Math.round((1 - minRatio) * 100)} aria-valuenow={Math.round(displayedRatio * 100)} tabIndex={0} onPointerDown={resize}
        onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); useProjectContentStore.getState().setRatio(scope, Math.max(minRatio, Math.min(1 - minRatio, displayedRatio + (event.key === "ArrowRight" ? 0.025 : -0.025)))); } }} /> : null}
    </div>
  </section>;
}
