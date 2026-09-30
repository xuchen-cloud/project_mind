import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import type { DocumentTagRecord } from "../../lib/types";
import { queryKeys } from "../../lib/queryKeys";
import { projectMindApi } from "../../services/projectMindApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { PopoverPanel } from "../../ui/components";

export function SidebarTagItem({ tag, projectId, selected, onSelect }: {
  tag: DocumentTagRecord;
  projectId: number | null;
  selected: boolean;
  onSelect: (id: number | null) => void;
}) {
  const client = useQueryClient();
  const { pushToast } = useFeedbackStore();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(tag.label);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMenu(null); rowRef.current?.focus(); }
    };
    const scroll = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", scroll);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", scroll);
    };
  }, [menu]);

  async function commit(remove = false) {
    const nextLabel = label.trim().replace(/^#/, "").trim();
    if (pending.current || (!remove && !nextLabel)) return;
    if (!remove && nextLabel === tag.label) { setEditing(false); return; }
    pending.current = true;
    setBusy(true);
    try {
      if (remove) {
        await projectMindApi.projectTagDelete({ projectId, tagId: tag.id });
        if (selected) onSelect(null);
      } else {
        await projectMindApi.projectTagUpsert({ projectId, id: tag.id, label: nextLabel, colorKey: tag.colorKey });
      }
      setEditing(false);
      setMenu(null);
      await Promise.all([queryKeys.projectTags.all, ["project-page"], queryKeys.workspacePage,
        queryKeys.todoCollections.all, queryKeys.todoViews.all, ["search"]].map(queryKey => client.invalidateQueries({ queryKey })));
    } catch (error) {
      pushToast({ tone: "error", title: remove ? "删除标签失败" : "保存标签失败", detail: String(error) });
    } finally { pending.current = false; setBusy(false); }
  }

  return <>
    {editing ? <div className="home-side__item home-side__tag-edit">
      <span className="home-side__hash">#</span>
      <input aria-label="标签名称" autoFocus value={label} disabled={busy}
        onFocus={event => event.currentTarget.select()}
        onChange={event => setLabel(event.target.value)}
        onBlur={() => { if (!label.trim()) setEditing(false); else void commit(); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") { event.preventDefault(); void commit(); }
          if (event.key === "Escape") { event.preventDefault(); setEditing(false); }
        }} />
    </div> : <button ref={rowRef} type="button" className={`home-side__item ${selected ? "is-active" : ""}`}
      disabled={busy} title={tag.label} onClick={() => onSelect(tag.id)}
      onContextMenu={event => {
        event.preventDefault();
        if (busy) return;
        setMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 148)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 88)) });
      }}>
      <span className="home-side__hash">#</span><span>{tag.label}</span>
    </button>}
    {menu ? createPortal(<PopoverPanel ref={menuRef} className="home-tag-menu context-menu__panel" role="menu" aria-label="标签操作"
      style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 120 }}>
      <button className="context-menu__item" role="menuitem" disabled={busy} onClick={() => { setLabel(tag.label); setEditing(true); setMenu(null); }}><Pencil size={14} />编辑标签</button>
      <button className="context-menu__item" data-tone="danger" role="menuitem" disabled={busy} onClick={() => void commit(true)}><Trash2 size={14} />删除标签</button>
    </PopoverPanel>, document.body) : null}
  </>;
}
