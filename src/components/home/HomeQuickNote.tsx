import { useHomeModal } from "./useHomeModal";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, ChevronDown, Expand, LoaderCircle, X } from "lucide-react";
import { QuickNoteTransferSession, registerQuickNoteFlusher, type QuickNoteTransferTarget } from "../../lib/quick-note-transfer";
import type { RichEditorController, RichEditorPersistState, RichEditorValue } from "../rich-editor";

interface Props {
  identity: string;
  initialValue: RichEditorValue;
  records: Array<{ id: number; title?: string | null }>;
  persist: (value: RichEditorValue) => Promise<RichEditorValue>;
  commit: (value: RichEditorValue, target: QuickNoteTransferTarget) => Promise<unknown>;
  onClear: () => void;
  onBusyChange?: (busy: boolean) => void;
  onCommitted?: () => void | Promise<void>;
  renderEditor: (options: {
    controllerRef: RefObject<RichEditorController | null>;
    onSave: (value: RichEditorValue) => Promise<unknown>;
    onPersistStateChange: (state: RichEditorPersistState) => void;
    readOnly: boolean;
  }) => ReactNode;
}

export function HomeQuickNote(props: Props) {
  const { identity, records, renderEditor } = props;
  const editorRef = useRef<RichEditorController | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const expandRef = useRef<HTMLButtonElement | null>(null);
  const latest = useMemo(() => ({ current: props }), [identity]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  latest.current = props;
  const [expanded, setExpanded] = useState(false);
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
    commit: (value, target) => latest.current.commit(value, target),
    clearLocal: () => {
      if (!mounted.current) return;
      editorRef.current?.replaceCommittedContent("<p></p>");
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
  const saveText = busy ? "发布中…" : status === "error" ? "保存失败，请重试" : status === "saving" ? "保存中…" : status === "dirty" ? "等待自动保存…" : "已自动保存";
  const matches = records.filter((record) => (record.title || "未命名记录").toLowerCase().includes(query.trim().toLowerCase()));
  return <div style={expanded ? { height: collapsedHeight } : { display: "contents" }}><section className={`home-quick-note${expanded ? " home-quick-note--expanded" : ""}`} aria-label="QuickNote">
    {expanded ? <div className="home-quick-note__backdrop" onClick={closeExpanded} /> : null}
    <div ref={panelRef} className="home-quick-note__panel" role={expanded ? "dialog" : undefined} aria-modal={expanded || undefined} aria-label={expanded ? "展开 QuickNote" : undefined} onKeyDown={(event) => { if (event.key === "Escape") { if (appendOpen || menuOpen) { event.stopPropagation(); setAppendOpen(false); setMenuOpen(false); } else if (expanded) closeExpanded(); } }}>
      <header className="home-quick-note__header"><strong>QuickNote</strong><button type="button" className={`home-quick-note__save${status === "error" ? " is-error" : ""}`} disabled={status !== "error"} onClick={() => void editorRef.current?.save({ force: true })?.catch(() => undefined)}>
        {busy || status === "saving" ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{saveText}
      </button><button ref={expandRef} type="button" className="home-quick-note__icon-button" aria-label={expanded ? "收起 QuickNote" : "展开 QuickNote"} onClick={() => expanded ? closeExpanded() : (setCollapsedHeight(panelRef.current?.offsetHeight ?? 0), setExpanded(true))}>{expanded ? <X size={18} /> : <Expand size={17} />}</button></header>
      <div className="home-quick-note__editor">{renderEditor({ controllerRef: editorRef, onSave: (value) => session.save(value), onPersistStateChange: setStatus, readOnly: busy })}</div>
      <footer className="home-quick-note__footer">{refreshFailed ? <span className="home-quick-note__error" role="status">记录已保存，请刷新列表。</span> : null}{error ? <span className="home-quick-note__error" role="alert" title={error}>发布失败，草稿已保留。</span> : null}<div className="home-quick-note__split"><button type="button" disabled={busy || !props.initialValue.markdown.trim()} onClick={() => void transfer({ kind: "new" })}>存为记录</button><button type="button" disabled={busy} aria-label="更多转存方式" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><ChevronDown size={16} /></button></div></footer>
      {menuOpen ? <div className="home-quick-note__append"><button type="button" onClick={() => { setMenuOpen(false); setAppendOpen(true); }}>追加到记录…</button></div> : null}
      {appendOpen ? <div className="home-quick-note__append" role="dialog" aria-label="追加到记录"><label>追加到记录…<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前范围的记录" autoFocus /></label><div className="home-quick-note__append-list">{matches.length ? matches.map((record) => <button key={record.id} type="button" onClick={() => void transfer({ kind: "append", recordId: record.id })}>{record.title || "未命名记录"}</button>) : <p>没有匹配的记录</p>}</div><button type="button" onClick={() => setAppendOpen(false)}>取消</button></div> : null}
    </div>
  </section></div>;
}
