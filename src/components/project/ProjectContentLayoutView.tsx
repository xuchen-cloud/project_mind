import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Columns2, GripVertical, Home, Merge, X } from "lucide-react";
import type { ContentPane, ContentScope, ContentTab, ProjectContentLayout } from "../../lib/project-content-layout";
import { useProjectContentStore } from "../../state/project-content-store";
import "./project-content.css";

type PaneId = ContentPane["id"];
export interface ContentPageProps {
  tab: ContentTab;
  visible: boolean;
  focused: boolean;
  registerCloseGuard: (guard: () => Promise<void>) => () => void;
}

function TabBar({ pane, layout, onSelect, onClose, scope }: {
  pane: ContentPane; layout: ProjectContentLayout; scope: ContentScope;
  onSelect: (paneId: PaneId, tabId: string) => void;
  onClose: (tabId: string) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: 0, right: 0 });
  const [menu, setMenu] = useState<{ id: string; left: number; top: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: Event) => { if (!(event.target as HTMLElement).closest('[data-content-tab-menu]')) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMenu(null); document.getElementById(`content-tab-${menu.id}`)?.focus(); } };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape, true); };
  }, [menu]);
  function measure() {
    const node = viewport.current;
    if (!node) return;
    const max = Math.max(0, node.scrollWidth - node.clientWidth);
    const position = Math.max(0, Math.min(max, node.scrollLeft));
    const distance = Math.min(64, max / 2);
    const next = { left: distance ? Math.min(1, position / distance) : 0, right: distance ? Math.min(1, (max - position) / distance) : 0 };
    setEdges(previous => previous.left === next.left && previous.right === next.right ? previous : next);
  }
  useLayoutEffect(() => {
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    if (viewport.current) observer.observe(viewport.current);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(measure, [pane.tabIds, layout.tabs]);
  const drop = (event: React.DragEvent, index?: number) => {
    const id = event.dataTransfer.getData("application/x-project-content-tab");
    if (!layout.tabs.some(tab => tab.id === id)) return;
    event.preventDefault();
    useProjectContentStore.getState().move(scope, id, pane.id, index);
    onSelect(pane.id, id);
  };
  return <div className="project-content__tab-frame" style={{ "--tab-fade-left": edges.left, "--tab-fade-right": edges.right } as CSSProperties}>
    <div ref={viewport} className="project-content__tab-scroll" onScroll={measure} onDragOver={event => event.preventDefault()} onDrop={event => drop(event)}>
      <div ref={content} className="project-content__tabs" role="tablist" aria-label={`${pane.id === "left" ? "左" : "右"}栏内容`}>
        {pane.tabIds.map((id, index) => {
          const tab = layout.tabs.find(item => item.id === id)!;
          return <div key={id} className="project-content__tab" data-selected={pane.selectedTabId === id || undefined}
            draggable onDragStart={event => { event.dataTransfer.setData("application/x-project-content-tab", id); event.dataTransfer.effectAllowed = "move"; }}
            onDragOver={event => event.preventDefault()} onDrop={event => { event.stopPropagation(); drop(event, index); }}>
            <button type="button" role="tab" id={`content-tab-${id}`} aria-controls={`content-page-${id}`} aria-selected={pane.selectedTabId === id}
              tabIndex={pane.selectedTabId === id ? 0 : -1} onClick={() => onSelect(pane.id, id)} title={tab.object.title} onKeyDown={event => {
                const next = event.key === "ArrowRight" ? (index + 1) % pane.tabIds.length : event.key === "ArrowLeft" ? (index - 1 + pane.tabIds.length) % pane.tabIds.length : event.key === "Home" ? 0 : event.key === "End" ? pane.tabIds.length - 1 : null;
                if (next !== null) { event.preventDefault(); const nextId = pane.tabIds[next]; onSelect(pane.id, nextId); document.getElementById(`content-tab-${nextId}`)?.focus(); }
              }}>
              <span>{tab.object.title}</span>{tab.object.kind === "file" && tab.view.versionNumber !== undefined ? <small>v{tab.view.versionNumber}</small> : null}
            </button>
            <button type="button" data-content-tab-menu className="project-content__tab-menu-button" aria-label={`${tab.object.title}的操作`} aria-expanded={menu?.id === id} onClick={event => {
              const bounds = event.currentTarget.getBoundingClientRect();
              setMenu(menu?.id === id ? null : { id, left: Math.max(8, Math.min(bounds.left, window.innerWidth - 190)), top: bounds.bottom + 4 });
            }}><GripVertical size={12} /></button>
            <button type="button" aria-label={`关闭${tab.object.title}`} title="关闭内容 Tab（Alt+W）" onClick={() => onClose(id)}><X size={13} /></button>
            {menu?.id === id ? <div data-content-tab-menu className="context-menu__panel project-content__tab-menu" role="menu" style={{ left: menu.left, top: menu.top }}>
              <button type="button" role="menuitem" className="context-menu__item" disabled={index === 0} onClick={() => { useProjectContentStore.getState().reorder(scope, pane.id, id, index - 1); setMenu(null); }}>向前排序</button>
              <button type="button" role="menuitem" className="context-menu__item" disabled={index === pane.tabIds.length - 1} onClick={() => { useProjectContentStore.getState().reorder(scope, pane.id, id, index + 1); setMenu(null); }}>向后排序</button>
              {layout.panes.length === 2 ? <button type="button" role="menuitem" className="context-menu__item" onClick={() => { const other = pane.id === "left" ? "right" : "left"; useProjectContentStore.getState().move(scope, id, other); onSelect(other, id); setMenu(null); }}>移动到{pane.id === "left" ? "右" : "左"}栏</button> : null}
            </div> : null}
          </div>;
        })}
      </div>
    </div>
  </div>;
}

/** Pages stay siblings with stable keys when their grid column changes. */
export function ProjectContentLayoutView({ scope, layout, active, renderPage, onSelect, onOverview, onClose, registerLeaveGuard }: {
  scope: ContentScope; layout: ProjectContentLayout; active: boolean;
  renderPage: (props: ContentPageProps) => ReactNode;
  onSelect: (paneId: PaneId, tabId: string) => void;
  onOverview: () => void;
  onClose: (tabId: string, guard?: () => Promise<void>) => Promise<void>;
  registerLeaveGuard?: (guard: () => Promise<void>) => () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const [contentWidth, setContentWidth] = useState(0);
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
    for (const tab of currentTabs.current) if (tab.object.kind === "record") await guards.current.get(tab.id)?.();
  }), [registerLeaveGuard]);
  const split = layout.panes.length === 2;
  const minRatio = Math.max(0.2, Math.min(320 / (contentWidth || 720), 0.45));
  const displayedRatio = Math.max(minRatio, Math.min(1 - minRatio, layout.ratio));
  const previousRects = useRef(new Map<string, DOMRect>());
  const structure = layout.panes.map(pane => `${pane.id}:${pane.tabIds.join(",")}`).join("|");
  useLayoutEffect(() => {
    const pages = root.current?.querySelectorAll<HTMLElement>(".project-content__page:not([hidden])");
    const nextRects = new Map<string, DOMRect>();
    const animations: Animation[] = [];
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    pages?.forEach(page => {
      const current = page.getBoundingClientRect();
      const previous = previousRects.current.get(page.id);
      nextRects.set(page.id, current);
      if (reduced || !page.animate || !previous || !current.width || !current.height) return;
      const dx = previous.left - current.left, dy = previous.top - current.top;
      const scaleX = previous.width / current.width, scaleY = previous.height / current.height;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(scaleX - 1) < 0.01 && Math.abs(scaleY - 1) < 0.01) return;
      animations.push(page.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`, transformOrigin: "top left" }, { transform: "none", transformOrigin: "top left" }], { duration: 180, easing: "cubic-bezier(.16,1,.3,1)" }));
    });
    previousRects.current = nextRects;
    return () => animations.forEach(animation => animation.cancel());
  }, [structure, narrow]);
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
  return <section ref={root} className="project-content" aria-label="项目内容" data-split={split || undefined} data-narrow={narrow || undefined}
    style={{ "--content-ratio": `${displayedRatio * 100}%` } as CSSProperties}>
    <div className="project-content__toolbar">
      <button type="button" onClick={onOverview} title="项目概览"><Home size={14} /><span>项目概览</span></button>
      <div>
        {split && narrow ? <button type="button" onClick={() => useProjectContentStore.getState().focus(scope, layout.focusedPaneId === "left" ? "right" : "left")}><ArrowLeft size={13} /><span>切换另一栏</span><ArrowRight size={13} /></button> : null}
        <button type="button" onClick={() => split ? useProjectContentStore.getState().merge(scope) : useProjectContentStore.getState().split(scope)}
          title={split ? "合并分栏" : "分栏：将当前 Tab 移到右栏"}>{split ? <Merge size={14} /> : <Columns2 size={14} />}<span>{split ? "合并分栏" : "分栏"}</span></button>
      </div>
    </div>
    {error ? <div className="project-content__error" role="alert">{error}<button type="button" onClick={() => setError(null)} aria-label="关闭错误提示"><X size={13} /></button></div> : null}
    <div className="project-content__grid" onKeyDown={event => {
      if (!active || event.defaultPrevented || (event.target as HTMLElement).closest('[role="dialog"],[role="menu"],.context-menu__panel')) return;
      const pane = layout.panes.find(item => item.id === layout.focusedPaneId)!;
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "w" && pane.selectedTabId) { event.preventDefault(); void close(pane.selectedTabId); }
      if (event.ctrlKey && !event.metaKey && (event.key === "PageUp" || event.key === "PageDown") && pane.tabIds.length) {
        event.preventDefault(); const index = pane.tabIds.indexOf(pane.selectedTabId!); const step = event.key === "PageDown" ? 1 : -1;
        onSelect(pane.id, pane.tabIds[(index + step + pane.tabIds.length) % pane.tabIds.length]);
      }
    }}>
      {layout.panes.map((pane, index) => {
        const shown = !narrow || !split || pane.id === layout.focusedPaneId;
        return <div key={pane.id} className="project-content__pane-tabs" data-focused={pane.id === layout.focusedPaneId || undefined} style={{ gridColumn: narrow ? 1 : index + 1, gridRow: 1, display: shown ? undefined : "none" }}>
          <TabBar pane={pane} layout={layout} scope={scope} onSelect={onSelect} onClose={id => void close(id)} />
        </div>;
      })}
      {layout.tabs.map(tab => {
        const index = layout.panes.findIndex(pane => pane.tabIds.includes(tab.id));
        const pane = layout.panes[index];
        const visible = active && pane.selectedTabId === tab.id && (!narrow || !split || pane.id === layout.focusedPaneId);
        const focused = visible && pane.id === layout.focusedPaneId;
        return <div key={tab.id} id={`content-page-${tab.id}`} role="tabpanel" aria-labelledby={`content-tab-${tab.id}`} className="project-content__page"
          hidden={!visible} inert={!visible} style={{ gridColumn: narrow ? 1 : index + 1, gridRow: 2 }} data-content-object={`${tab.object.kind}:${tab.object.id}`}
          onPointerDownCapture={() => useProjectContentStore.getState().focus(scope, pane.id)} onFocusCapture={() => useProjectContentStore.getState().focus(scope, pane.id)}>
          {renderPage({ tab, visible, focused, registerCloseGuard: registrar(tab.id) })}
        </div>;
      })}
      {layout.panes.filter(pane => pane.selectedTabId === null).map(pane => <div key={`empty-${pane.id}`} className="project-content__empty" style={{ gridColumn: narrow ? 1 : layout.panes.indexOf(pane) + 1, gridRow: 2 }} hidden={narrow && split && pane.id !== layout.focusedPaneId}
        onPointerDown={() => useProjectContentStore.getState().focus(scope, pane.id)}><p>在这栏打开项目内容</p><span>从记录、文件或会话列表选择内容，或将 Tab 移到此栏。</span></div>)}
      {split && !narrow ? <div className="project-content__divider" role="separator" aria-label="调整内容分栏比例" aria-orientation="vertical" aria-valuemin={Math.round(minRatio * 100)} aria-valuemax={Math.round((1 - minRatio) * 100)} aria-valuenow={Math.round(displayedRatio * 100)} tabIndex={0} onPointerDown={resize}
        onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); useProjectContentStore.getState().setRatio(scope, Math.max(minRatio, Math.min(1 - minRatio, displayedRatio + (event.key === "ArrowRight" ? 0.025 : -0.025)))); } }} /> : null}
    </div>
  </section>;
}
