import { useEffect, useId, useRef, useState } from "react";

import { Button } from "../../ui/components/Button";
import { Dialog } from "../../ui/components/Dialog";
import { SearchField } from "../../ui/components/SearchField";
import { HomeSidebarList } from "../home/HomeSidebarList";

export interface MoveDestinationDialogProps {
  title: string;
  workspaceName: string;
  projects: { id: number; name: string; isArchived?: boolean }[];
  currentProjectId: number | null;
  onMove: (projectId: number | null) => Promise<void>;
  onClose: () => void;
  loading?: boolean;
  error?: string;
}

/**
 * Parent must key this dialog by the frozen Workspace binding (including its
 * generation) and object identity (Record/File plus owner and ID). Workspace
 * names and numeric object IDs alone are not unique across bindings. Capture
 * that same binding/object in onMove; changing either must unmount this instance
 * so its pending result cannot close or update the replacement dialog.
 */
export function MoveDestinationDialog({
  title, workspaceName, projects, currentProjectId, onMove, onClose, loading = false, error,
}: MoveDestinationDialogProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | null | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [moveError, setMoveError] = useState<string>();
  const submitting = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const searchRef = useRef<HTMLInputElement>(null);
  const radioName = useId();
  const busy = pending || loading;
  const destinations = [
    { id: null, name: `工作区根级 · ${workspaceName}`, isArchived: false },
    ...projects,
  ];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = destinations.filter(destination =>
    `${destination.name} ${workspaceName}`.toLocaleLowerCase().includes(normalizedQuery),
  );
  const validSelection = selected !== undefined && selected !== currentProjectId
    && destinations.some(destination => destination.id === selected && !destination.isArchived);

  function close() {
    if (!submitting.current) onClose();
  }

  async function move() {
    if (submitting.current || loading || !validSelection || selected === undefined) return;
    submitting.current = true;
    setPending(true);
    setMoveError(undefined);
    try {
      await onMove(selected);
    } catch (cause) {
      if (!active.current) return;
      const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
      setMoveError(message.trim() ? message : "移动失败，请重试。");
      submitting.current = false;
      setPending(false);
      return;
    }
    if (!active.current) return;
    submitting.current = false;
    setPending(false);
    onClose();
  }

  return (
    <Dialog
      open
      title={title}
      description="选择同一工作区内的目标位置。"
      onClose={close}
      initialFocusRef={searchRef}
      widthClassName="max-w-lg h-[min(72dvh,36rem)]"
      bodyClassName="flex min-h-0 flex-col gap-3 overflow-hidden overflow-y-hidden"
      footer={<>
        <Button type="button" variant="ghost" onClick={close} disabled={pending}>取消</Button>
        <Button type="button" variant="primary" onClick={() => void move()} disabled={busy || !validSelection}>
          {pending ? "移动中…" : "移动"}
        </Button>
      </>}
    >
      <SearchField
        ref={searchRef}
        type="search"
        aria-label="搜索移动目标"
        placeholder="搜索项目或工作区根级"
        value={query}
        onChange={event => setQuery(event.target.value)}
        disabled={pending}
        className="shrink-0"
      />
      {loading ? <p role="status" className="text-body text-text-muted">正在加载移动目标…</p> : null}
      {moveError || error ? <p role="alert" className="text-body text-danger">{moveError || error}</p> : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden [--home-sidebar:var(--color-bg)]" aria-busy={busy}>
        <HomeSidebarList label="移动目标列表" searchKey={normalizedQuery}>
          <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
            <legend className="sr-only">选择移动目标</legend>
            <div className="grid gap-2">
              {filtered.map(destination => {
                const current = destination.id === currentProjectId;
                const disabled = current || !!destination.isArchived;
                return (
                  <label key={destination.id ?? "root"} className={`flex min-w-0 items-center gap-3 rounded-[var(--radius-6)] border border-border px-3 py-3 text-body text-text focus-within:border-accent ${disabled || busy ? "opacity-60" : "cursor-pointer hover:bg-bg-hover"}`}>
                    <input
                      type="radio"
                      name={radioName}
                      value={destination.id ?? "root"}
                      checked={selected === destination.id}
                      disabled={disabled}
                      onChange={() => setSelected(destination.id)}
                      className="shrink-0 accent-text"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words font-medium">{destination.name}</span>
                      {destination.id !== null ? <span className="block break-words text-ui text-text-muted">所属工作区 · {workspaceName}</span> : null}
                    </span>
                    <span className="shrink-0 text-ui text-text-muted">
                      {destination.isArchived ? <span className="block">已归档</span> : null}
                      {current ? <span className="block">当前位置</span> : null}
                    </span>
                  </label>
                );
              })}
              {!loading && filtered.length === 0 ? <p role="status" className="px-3 py-8 text-center text-body text-text-muted">没有匹配的移动目标</p> : null}
            </div>
          </fieldset>
        </HomeSidebarList>
      </div>
    </Dialog>
  );
}
