import { HomeSaveIndicator } from "./HomeSaveIndicator";
import { useHomeHeadingMotion } from "./useHomeHeadingMotion";
import { useHomeModal } from "./useHomeModal";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { ChevronDown, Expand, ChevronLeft, ChevronRight, X } from "lucide-react";
import { QuickNoteTransferSession, registerQuickNoteFlusher, type QuickNoteTransferContext, type QuickNoteTransferTarget } from "../../lib/quick-note-transfer";
import type { RichEditorController, RichEditorPersistState, RichEditorValue } from "../rich-editor";

interface Props {
  identity: string;
  pageTitle?: string;
  pageIcon?: ReactNode;
  editorControllerRef?: RefObject<RichEditorController | null>;
  initialValue: RichEditorValue;
  records: Array<{ id: number; title?: string | null }>;
  persist: (value: RichEditorValue) => Promise<RichEditorValue>;
  beforeTransfer?: (context: QuickNoteTransferContext) => Promise<void>;
  commit: (value: RichEditorValue, target: QuickNoteTransferTarget, context: QuickNoteTransferContext) => Promise<unknown>;
  onClear: () => void;
  onBusyChange?: (busy: boolean) => void;
  onCommitted?: () => void | Promise<void>;
  renderEditor: (options: {
    controllerRef: RefObject<RichEditorController | null>;
    onChange: (value: RichEditorValue) => void;
    onSave: (value: RichEditorValue) => Promise<unknown>;
    onPersistStateChange: (state: RichEditorPersistState) => void;
    readOnly: boolean;
    toolbarExtras: ReactNode;
  }) => ReactNode;
}

export function HomeQuickNote(props: Props) {
  const { identity, records, renderEditor } = props;
  const sectionRef = useRef<HTMLElement>(null);


  const localEditorRef = useRef<RichEditorController | null>(null);
  const editorRef = props.editorControllerRef ?? localEditorRef;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const expandRef = useRef<HTMLButtonElement | null>(null);
  const latest = useMemo(() => ({ current: props }), [identity]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  latest.current = props;
  const [emptyFocused, setEmptyFocused] = useState(false);
  const [scrollCollapse, setScrollCollapse] = useState(0);
  function expandEmpty() { setScrollCollapse(0); setEmptyFocused(true); }
  const [isEmpty, setIsEmpty] = useState(() => !props.initialValue.markdown.trim());
  useEffect(() => {
    setIsEmpty(!props.initialValue.markdown.trim());
  }, [identity, props.initialValue.markdown]);
  useEffect(() => {
    setEmptyFocused(false);
    setScrollCollapse(0);
  }, [identity]);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const titleVisible = useHomeHeadingMotion(sectionRef, identity, props.pageTitle, expanded);
  const [collapsedHeight, setCollapsedHeight] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [appendOpen, setAppendOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [status, setStatus] = useState<RichEditorPersistState>("idle");
  const session = useMemo(() => new QuickNoteTransferSession<RichEditorValue, unknown>({
    readCommitted: () => editorRef.current?.getCommittedValue() ?? latest.current.initialValue,
    isEmpty: (value) => !value.markdown.trim(),
    persist: (value) => latest.current.persist(value),
    beforeTransfer: (context) => latest.current.beforeTransfer?.(context) ?? Promise.resolve(),
    commit: (value, target, context) => latest.current.commit(value, target, context),
    clearLocal: () => {
      if (!mounted.current) return;
      editorRef.current?.replaceCommittedContent("<p></p>");
      setIsEmpty(true);
      setEmptyFocused(false);
      setScrollCollapse(0);
      latest.current.onClear();
    },
    setBusy: (value) => { editorRef.current?.setEditable(!value); if (mounted.current) { setBusy(value); latest.current.onBusyChange?.(value); } },
  }), [identity]);

  useEffect(() => {
    const unregister = registerQuickNoteFlusher(identity, async () => {
      await editorRef.current?.save();
      await session.flush();
    });
    return () => { void session.flush().finally(unregister); };
  }, [identity, session]);

  async function transfer(target: QuickNoteTransferTarget) {
    if (!editorRef.current?.getCommittedValue().markdown.trim()) return;
    setError(null); setRefreshFailed(false); setMenuOpen(false); setAppendOpen(false);
    try {
      await session.transfer(target);
      setStatus("idle");
    } catch (failure) { setError(String(failure)); return; }
    try { await latest.current.onCommitted?.(); }
    catch { setRefreshFailed(true); }
  }
  function closeExpanded() {
    setExpanded(false);
    setMenuOpen(false);
    setAppendOpen(false);
    void editorRef.current?.save()?.catch(() => undefined);
    requestAnimationFrame(() => expandRef.current?.focus());
  }
  useHomeModal(expanded, panelRef, closeExpanded);
  useEffect(() => {
    if (!panelRef.current) return;
    const panel = panelRef.current;
    let frame: HTMLElement | null = null;
    let surface: HTMLElement | null = null;
    const measure = () => {
      const nextFrame = panel.querySelector<HTMLElement>(".rich-editor__frame");
      const nextSurface = panel.querySelector<HTMLElement>(".rich-editor__surface");
      if (nextFrame !== frame || nextSurface !== surface) {
        resize.disconnect();
        frame = nextFrame;
        surface = nextSurface;
        if (frame) resize.observe(frame);
        if (surface) resize.observe(surface);
      }
      if (!frame) return;
      const max = Math.max(0, frame.scrollHeight - frame.clientHeight);
      const position = Math.max(0, Math.min(max, frame.scrollTop));
      frame.style.setProperty("--quick-note-fade-top", String(Math.min(1, position / 64)));
      frame.style.setProperty("--quick-note-fade-bottom", String(Math.min(1, (max - position) / 64)));
    };
    const resize = new ResizeObserver(measure);
    const mutation = new MutationObserver(measure);
    mutation.observe(panel, { childList: true, subtree: true, characterData: true });
    panel.addEventListener("scroll", measure, true);
    measure();
    return () => {
      resize.disconnect();
      mutation.disconnect();
      panel.removeEventListener("scroll", measure, true);
      frame?.style.removeProperty("--quick-note-fade-top");
      frame?.style.removeProperty("--quick-note-fade-bottom");
    };
  }, [expanded]);

  useEffect(() => {
    const scroller = panelRef.current?.closest(".project-overview-focus__scroll");
    if (!scroller) return;
    let userScrollUntil = 0;
    let lastScrollTop = scroller.scrollTop;
    const armScroll = () => { if (performance.now() >= userScrollUntil) lastScrollTop = scroller.scrollTop; userScrollUntil = performance.now() + 600; };
    const onWheel = (event: Event) => {
      if (!isEmpty || expanded) return;
      const wheel = event as WheelEvent;
      const delta = Math.abs(wheel.deltaY) * (wheel.deltaMode === 1 ? 20 : wheel.deltaMode === 2 ? scroller.clientHeight : 1);
      // Wheel input over the sticky editor may be consumed by its inner scroller.
      // Follow the gesture directly, then ignore its corresponding scroll event.
      if (delta > 0) setScrollCollapse((current) => Math.min(40, current + delta));
      userScrollUntil = 0;
    };
    const resetScroll = () => { userScrollUntil = 0; };
    const onKey = (event: Event) => {
      const key = event as KeyboardEvent;
      const target = key.target as HTMLElement;
      if (target.closest("[contenteditable],input,textarea,select,button")) return;
      if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(key.key)) armScroll();
    };
    const onPointer = (event: Event) => { if (event.target === scroller) armScroll(); };
    // Focus and scroll anchoring can scroll this container without user input.
    const collapseEmpty = () => {
      if (isEmpty && !expanded && performance.now() < userScrollUntil) {
        const distance = Math.abs(scroller.scrollTop - lastScrollTop);
        lastScrollTop = scroller.scrollTop;
        setScrollCollapse((current) => Math.min(40, current + distance));
      }
    };
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("touchmove", armScroll, { passive: true });
    scroller.addEventListener("keydown", onKey);
    scroller.addEventListener("pointerdown", onPointer);
    scroller.addEventListener("focusin", resetScroll);
    scroller.addEventListener("scroll", collapseEmpty, { passive: true });
    return () => {
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("touchmove", armScroll);
      scroller.removeEventListener("keydown", onKey);
      scroller.removeEventListener("pointerdown", onPointer);
      scroller.removeEventListener("focusin", resetScroll);
      scroller.removeEventListener("scroll", collapseEmpty);
    };
  }, [isEmpty, expanded]);


  const matches = records.filter((record) => (record.title || "未命名记录").toLowerCase().includes(query.trim().toLowerCase()));
  return <div style={expanded ? { height: collapsedHeight } : { display: "contents" }}><section ref={sectionRef} data-page-heading={props.pageTitle ? "true" : undefined} data-title-visible={titleVisible && !expanded ? "true" : undefined} className={`home-quick-note${expanded ? " home-quick-note--expanded" : ""}`} aria-label="QuickNote">
    {props.pageTitle && !expanded ? <div className="home-quick-note__page-heading" aria-hidden={!titleVisible}>
      {props.pageIcon}<h1 title={props.pageTitle}>{props.pageTitle}</h1>
    </div> : null}
    {expanded ? <div className="home-quick-note__backdrop" onClick={closeExpanded} /> : null}
    <div ref={panelRef} className={`home-quick-note__panel${isEmpty && !expanded ? emptyFocused && scrollCollapse < 40 ? " is-empty-expanded" : " is-empty-compact" : ""}`} style={{ "--empty-editor-height": `${emptyFocused ? 76 - scrollCollapse : 36}px` } as CSSProperties} data-scroll-resizing={scrollCollapse > 0 || undefined} onFocusCapture={(event) => { if ((event.target as HTMLElement).closest("[contenteditable]")) expandEmpty(); }} onClick={(event) => { if ((event.target as HTMLElement).closest("[contenteditable]")) expandEmpty(); }} role={expanded ? "dialog" : undefined} aria-modal={expanded || undefined} aria-label={expanded ? "展开 QuickNote" : undefined} onKeyDown={(event) => { if (event.key === "Escape") { if (appendOpen || menuOpen) { event.stopPropagation(); setAppendOpen(false); setMenuOpen(false); } else if (expanded) closeExpanded(); } }}>
      <header className="home-quick-note__header"><strong>QuickNote</strong><span className="home-quick-note__save">
        <HomeSaveIndicator state={status} showError={false} />
      </span><button ref={expandRef} type="button" className="home-quick-note__icon-button" aria-label={expanded ? "收起 QuickNote" : "展开 QuickNote"} onClick={() => expanded ? closeExpanded() : (setCollapsedHeight(panelRef.current?.offsetHeight ?? 0), setExpanded(true))}>{expanded ? <X size={16} /> : <Expand size={16} />}</button></header>
      <div className={`home-quick-note__editor${toolsExpanded ? " is-tools-expanded" : ""}`}>{renderEditor({ controllerRef: editorRef, onChange: (value) => setIsEmpty(!value.markdown.trim()), onSave: (value) => session.save(value), onPersistStateChange: setStatus, readOnly: busy, toolbarExtras: (<button type="button" className="home-quick-note__tools-toggle" aria-label={toolsExpanded ? "收起格式工具" : "更多格式工具"} aria-expanded={toolsExpanded} onMouseDown={(event) => event.preventDefault()} onClick={() => setToolsExpanded(!toolsExpanded)}>{toolsExpanded ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}</button>) })}</div>

      <footer className="home-quick-note__footer">{refreshFailed ? <span className="home-quick-note__error" role="status">记录已保存，请刷新列表。</span> : null}{error ? <span className="home-quick-note__error" role="alert" title={error}>发布失败，草稿已保留。</span> : null}<div className={`home-quick-note__split${menuOpen ? " is-menu-open" : ""}`}><button type="button" aria-label="保存为记录" disabled={busy || isEmpty} onClick={() => void transfer({ kind: "new" })}><span className="home-quick-note__send-label" aria-hidden="true">保存为记录</span><svg className="home-quick-note__send-icon" width="18" height="14" viewBox="0 0 32 26" fill="none" aria-hidden="true"><path fill="currentColor" d="M0 0 32 13 0 10V0Z" /><path fill="currentColor" d="M0 16 32 13 0 26V16Z" /></svg></button><button type="button" disabled={busy} aria-label="更多转存方式" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><ChevronDown size={14} /></button></div></footer>
      {menuOpen ? <div className="home-quick-note__append"><button type="button" onClick={() => { setMenuOpen(false); setAppendOpen(true); }}>追加到记录…</button></div> : null}
      {appendOpen ? <div className="home-quick-note__append" role="dialog" aria-label="追加到记录"><label>追加到记录…<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前范围的记录" autoFocus /></label><div className="home-quick-note__append-list">{matches.length ? matches.map((record) => <button key={record.id} type="button" onClick={() => void transfer({ kind: "append", recordId: record.id })}>{record.title || "未命名记录"}</button>) : <p>没有匹配的记录</p>}</div><button type="button" onClick={() => setAppendOpen(false)}>取消</button></div> : null}
    </div>
  </section></div>;
}
