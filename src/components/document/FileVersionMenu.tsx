import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal, flushSync } from "react-dom";
import { ChevronDown, Pencil, Star } from "lucide-react";
import { PopoverPanel } from "../../ui/components/PopoverPanel";
import { HomeSidebarList } from "../home/HomeSidebarList";
import { formatDateTime } from "../../lib/formatters";
import { getErrorMessage } from "../../lib/errors";
import type { FileVersionMetadata, FileVersionMetadataUpdateResult } from "../../lib/file-types";
import { FileVersionMenuMetadataEditor, fileVersionMetadataIdentity, type EditableFileVersion } from "./FileVersionMenuMetadataEditor";
import "./file-version-menu.css";

type MenuVersion = Pick<FileVersionMetadata, "id" | "versionNumber"> & Partial<Pick<FileVersionMetadata,
  "createdAt" | "isCurrent" | "displayName" | "isImportant" | "metadataRevision" | "metadataTarget">>;
function editable(version: MenuVersion): version is MenuVersion & EditableFileVersion {
  return !!version.metadataTarget && version.metadataRevision !== undefined && version.displayName !== undefined && version.isImportant !== undefined;
}

export interface FileVersionMenuProps {
  label: string;
  triggerLabel: string;
  versions: MenuVersion[];
  selectedVersion?: number;
  includeLatest?: boolean;
  latestVersion?: number;
  latestLabel?: string;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onSelect: (versionNumber: number | undefined) => void | Promise<void>;
  onHistory?: () => void;
  visible?: boolean;
  onOpenChange?: (open: boolean) => void;
  variant?: "toolbar" | "badge";
}

/** Menu name is `${label}列表`; use a parent key for file identity changes. */
export function FileVersionMenu({ label, triggerLabel, versions, selectedVersion, includeLatest = false, latestVersion, latestLabel, loading = false, error, onRetry, onSelect, onHistory, visible = true, onOpenChange, variant = "toolbar" }: FileVersionMenuProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const session = useRef(0);
  const selecting = useRef(false);
  const notify = useRef(onOpenChange);
  notify.current = onOpenChange;
  const isOpen = useRef(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [selectionError, setSelectionError] = useState<string>();
  const [metadata, setMetadata] = useState<Record<string, FileVersionMetadataUpdateResult>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const displayVersions = versions.map(version => {
    if (!editable(version)) return version;
    const updated = metadata[fileVersionMetadataIdentity(version)];
    return updated && updated.metadataRevision >= version.metadataRevision ? { ...version,
      displayName: updated.displayName, isImportant: updated.isImportant, metadataRevision: updated.metadataRevision } : version;
  });
  const editing = displayVersions.find(version => editable(version) && fileVersionMetadataIdentity(version) === editingKey);
  const menuWidth = displayVersions.some(version => version.displayName || version.isImportant || editable(version)) ? 264 : 128;
  const [position, setPosition] = useState({ top: 12, left: 12, maxHeight: 240, above: false });
  const changeOpen = useCallback((value: boolean, restoreFocus = true) => {
    if (isOpen.current === value) return;
    isOpen.current = value;
    session.current += 1;
    selecting.current = false;
    setPending(false);
    setSelectionError(undefined);
    setOpen(value);
    notify.current?.(value);
    if (!value && restoreFocus) trigger.current?.focus();
  }, []);
  useEffect(() => {
    if (!visible) changeOpen(false, false);
  }, [visible, changeOpen]);
  useEffect(() => {
    changeOpen(false, false);
  }, [label, changeOpen]);
  useEffect(() => () => { session.current += 1; }, []);
  useLayoutEffect(() => {
    if (!open || !visible) return;
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const height = window.innerHeight;
      const width = Math.min(menuWidth, Math.max(0, window.innerWidth - 24));
      const below = Math.max(0, height - rect.bottom - 18);
      const aboveSpace = Math.max(0, rect.top - 18);
      const desired = panel.current!.scrollHeight;
      const above = below < desired && aboveSpace > below;
      const maxHeight = above ? aboveSpace : below;
      const actualHeight = Math.min(desired, maxHeight);
      setPosition({ top: above ? Math.max(12, rect.top - 6 - actualHeight) : Math.max(12, Math.min(rect.bottom + 6, height - 12 - actualHeight)), left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)), maxHeight, above });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(trigger.current!);
    observer.observe(panel.current!);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, visible, versions, includeLatest, loading, error, selectionError, onHistory, menuWidth]);
  useEffect(() => {
    if (!open || !visible) return;
    panel.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) changeOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); changeOpen(false); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open, visible, changeOpen]);
  async function choose(version: number | undefined) {
    if (selecting.current) return;
    selecting.current = true;
    setPending(true);
    setSelectionError(undefined);
    const currentSession = session.current;
    try {
      await onSelect(version);
      if (session.current === currentSession) changeOpen(false);
    } catch (cause) {
      if (session.current === currentSession) setSelectionError(getErrorMessage(cause, "无法切换版本"));
    } finally {
      if (session.current === currentSession) { selecting.current = false; setPending(false); }
    }
  }
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const items = Array.from(panel.current!.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)'));
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : index < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1) : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  }
  const row = (name: string, version: number | undefined, createdAt?: string, current?: boolean, item?: MenuVersion) => <button type="button" className="file-version-menu__row" role="menuitemradio" aria-label={`${name}${item?.isImportant ? "，重要版本" : ""}`} aria-checked={selectedVersion === version} disabled={pending || loading} onClick={() => void choose(version)}
    style={item && editable(item) ? { flex: 1, minWidth: 0, width: "auto" } : undefined} title={name}>
    <span className="file-version-menu__text"><span>{item ? `V${item.versionNumber}${item.displayName ? `（${item.displayName}）` : ""}` : name}{current ? <small>（当前）</small> : null}</span>{createdAt ? <time dateTime={createdAt}>{formatDateTime(createdAt)}</time> : null}</span>
    {item?.isImportant ? <Star size={13} aria-hidden="true" fill="currentColor" className="shrink-0" /> : null}
  </button>;
  return <>
    <span data-document-interactive="true" className={`file-version-control file-version-control--${variant}`}>
      <button ref={trigger} data-document-interactive="true" type="button" className="file-version-control__trigger" aria-label={label} aria-haspopup="menu" aria-expanded={open && visible} aria-controls={open && visible ? id : undefined} disabled={!visible} onClick={event => { event.stopPropagation(); changeOpen(!open); }}>{triggerLabel}<ChevronDown size={12} strokeWidth={1.5} aria-hidden="true" /></button>
    </span>
    {open && visible ? createPortal(<PopoverPanel ref={panel} id={id} role="menu" aria-label={`${label}列表`} tabIndex={-1} className="file-version-menu" style={{ top: position.top, left: position.left, maxHeight: position.maxHeight, width: menuWidth }} motion="trigger" motionOrigin={position.above ? "bottom right" : "top right"} onKeyDown={navigate} onClick={event => event.stopPropagation()}>
      <HomeSidebarList label={`${label}选项`}>
        {includeLatest ? row(latestLabel ?? (latestVersion ? `v${latestVersion}（当前）` : "当前版本"), undefined) : null}
        {displayVersions.map(version => <span className="file-version-menu__entry" key={version.id} style={editable(version) ? { display: "flex", alignItems: "center" } : undefined}>
          {row(`v${version.versionNumber}${version.displayName ? `（${version.displayName}）` : ""}`, version.versionNumber, version.createdAt, !includeLatest && version.isCurrent, version)}
          {editable(version) ? <button type="button" role="menuitem" aria-label={`编辑 V${version.versionNumber} 标记`} title="编辑版本标记" disabled={pending || loading}
            className="shrink-0 p-1.5" onClick={() => { flushSync(() => changeOpen(false)); setEditingKey(fileVersionMetadataIdentity(version)); }}><Pencil size={13} aria-hidden="true" /></button> : null}
        </span>)}
        {loading ? <p role="status">正在读取版本…</p> : null}
        {!loading && !error && !versions.length && !includeLatest ? <p role="status">暂无版本</p> : null}
        {error || selectionError ? <p role="alert">{error || selectionError}</p> : null}
        {error && onRetry ? <button type="button" role="menuitem" className="file-version-menu__row" disabled={pending || loading} onClick={onRetry}>重试</button> : null}
      </HomeSidebarList>
      {onHistory ? <button type="button" role="menuitem" className="file-version-menu__history" disabled={pending} onClick={() => { flushSync(() => changeOpen(false)); onHistory(); }}>查看历史与比较</button> : null}
    </PopoverPanel>, document.body) : null}
    {visible && editing && editable(editing) ? <span data-document-interactive="true" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      <FileVersionMenuMetadataEditor key={editingKey} version={editing} onClose={() => setEditingKey(null)}
        onUpdated={result => setMetadata(previous => ({ ...previous, [fileVersionMetadataIdentity(editing)]: result }))} />
    </span> : null}
  </>;
}
