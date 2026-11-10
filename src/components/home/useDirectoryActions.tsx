import { directoryQueryRelativePath, matchesDirectoryQueryBinding } from "../../lib/project-directory-query";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pencil, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { ActionContextMenu } from "../../ui/components/ActionContextMenu";
import { desktopApi } from "../../services/desktopApi";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { projectDirectoryApi, type DirectoryChangeTarget, type PreparedDirectoryChange } from "../../services/projectDirectoryApi";
import { queryKeys } from "../../lib/queryKeys";
import { getErrorMessage } from "../../lib/errors";
import type { AgentWorkspaceBinding } from "../../lib/agent-types";

type Editing = { target: DirectoryChangeTarget; prepared: PreparedDirectoryChange; name: string };

/** Native prepare/commit reject active descendant editors. Never close or
 * discard an editor here: the user closes it through its existing save guard. */
export function useDirectoryActions({ projectId, rootPath, workspaceRoot, binding }: {
  projectId: number | null; rootPath: string; workspaceRoot?: string; binding?: AgentWorkspaceBinding;
}) {
  const client = useQueryClient();
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const editRef = useRef<Editing | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const operation = useRef(false);
  const epoch = useRef(0);
  useLayoutEffect(() => {
    epoch.current++;
    setMenu(null); setEditing(null); editRef.current = null;
    setError(""); setBusy(false); operation.current = false;
    return () => { epoch.current++; };
  }, [projectId, rootPath, workspaceRoot, binding?.workspaceId, binding?.generation]);
  const cancelRename = () => { editRef.current = null; setEditing(null); };
  const run = async (action: (current: () => boolean) => Promise<void>) => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError("");
    const generation = epoch.current;
    const current = () => epoch.current === generation;
    try { await action(current); }
    catch (reason) { if (current()) setError(getErrorMessage(reason, "无法操作文件夹")); }
    finally { if (current()) { operation.current = false; setBusy(false); } }
  };
  const prepare = async (path: string, current: () => boolean) => {
    if (!workspaceRoot) throw new Error("工作区信息尚未就绪，请稍后重试。");
    const actualBinding = await recordDocumentApi.bindingGet(workspaceRoot);
    if (!current()) return;
    if (binding && (binding.workspaceId !== actualBinding.workspaceId || binding.generation !== actualBinding.generation)) {
      throw new Error("工作区已切换，请刷新后重试文件夹操作。");
    }
    const target = { binding: actualBinding, projectId, relativePath: path };
    return { target, prepared: await projectDirectoryApi.prepareChange(target) };
  };
  const reprepare = async (target: DirectoryChangeTarget, before: PreparedDirectoryChange) => {
    const after = await projectDirectoryApi.prepareChange(target);
    const files = (value: PreparedDirectoryChange) => [...value.files].sort((a, b) => a.fileId - b.fileId);
    if (before.token !== after.token || before.identityToken !== after.identityToken || before.relativePath !== after.relativePath
      || JSON.stringify(files(before)) !== JSON.stringify(files(after))) {
      throw new Error("文件夹或其中的文件已变化，请重新打开菜单后重试。");
    }
    return after;
  };
  const refresh = async (current: () => boolean, sourcePath: string) => {
    const directoryKey = ["project-directory", rootPath, projectId];
    const pageKey = projectId === null ? queryKeys.workspacePage : queryKeys.projectPage(projectId);
    const matchesBinding = (key: readonly unknown[]) => matchesDirectoryQueryBinding(key, workspaceRoot, binding);
    const isSource = (key: readonly unknown[]) => {
      const path = directoryQueryRelativePath(key);
      return path === sourcePath || path.startsWith(`${sourcePath}/`);
    };
    // A pre-commit native read cannot satisfy the post-commit reconciliation.
    await Promise.allSettled([...client.getQueryCache().findAll({ queryKey: directoryKey,
      predicate: query => matchesBinding(query.queryKey) }),
      ...client.getQueryCache().findAll({ queryKey: pageKey })]
      .filter(query => query.state.fetchStatus !== "idle").map(query => query.promise));
    if (!current()) return;
    await Promise.all([
      // The commit moved this subtree. Retire its snapshot without reading the
      // old paths while the refreshed parent removes their mounted observers.
      client.invalidateQueries({ queryKey: directoryKey, predicate: query => matchesBinding(query.queryKey) && isSource(query.queryKey), refetchType: "none" }),
      client.invalidateQueries({ queryKey: directoryKey, predicate: query => matchesBinding(query.queryKey) && !isSource(query.queryKey) }, { cancelRefetch: false, throwOnError: true }),
      client.invalidateQueries({ queryKey: pageKey }, { cancelRefetch: false, throwOnError: true }),
    ]);
  };
  const beginRename = (path: string) => void run(async current => {
    const value = await prepare(path, current);
    if (!current() || !value) return;
    const edit = { ...value, name: path.slice(path.lastIndexOf("/") + 1) };
    editRef.current = edit; setEditing(edit);
  });
  const commitRename = () => {
    const edit = editRef.current;
    if (!edit || operation.current) return;
    const name = edit.name.trim();
    if (!name) { setError("文件夹名称不能为空。"); return; }
    if (name === edit.target.relativePath.slice(edit.target.relativePath.lastIndexOf("/") + 1)) { cancelRename(); return; }
    void run(async current => {
      const prepared = await reprepare(edit.target, edit.prepared);
      if (!current() || editRef.current !== edit) return;
      await projectDirectoryApi.rename({ ...edit.target, token: prepared.token, name, requestId: crypto.randomUUID() });
      if (!current()) return;
      cancelRename();
      await refresh(current, edit.target.relativePath);
    });
  };
  const trash = (path: string) => void run(async current => {
    const value = await prepare(path, current);
    if (!current() || !value) return;
    const { target, prepared } = value;
    const confirmed = await desktopApi.confirm(`将整个文件夹“${path}”及其中所有内容移入系统回收站？\n包括尚未纳管的文件。文件身份与历史记录仍会保留。`, "移入回收站");
    if (!current() || !confirmed) return;
    const after = await reprepare(target, prepared);
    if (!current()) return;
    await projectDirectoryApi.delete({ ...target, token: after.token, confirmed: true, requestId: crypto.randomUUID() });
    if (current()) await refresh(current, target.relativePath);
  });
  const openMenu = (path: string, x: number, y: number) => {
    if (operation.current || editRef.current) return;
    setError(""); setMenu({ path, x, y });
  };
  const renderRenameInput = (path: string) => editing?.target.relativePath === path ? <input
    autoFocus aria-label={`重命名文件夹 ${path.slice(path.lastIndexOf("/") + 1)}`}
    className="inline-object-input h-6 min-w-0 flex-1 px-1.5 text-[12px] leading-4 text-text outline-none"
    value={editing.name} disabled={busy} aria-busy={busy}
    onFocus={event => event.currentTarget.select()}
    onChange={event => { const edit = { ...editing, name: event.target.value }; editRef.current = edit; setEditing(edit); }}
    onBlur={commitRename}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); cancelRename(); }
      if (event.key === "Enter") { event.preventDefault(); commitRename(); }
    }} /> : null;
  const panel = menu ? createPortal(<ActionContextMenu x={menu.x} y={menu.y} ariaLabel="文件夹操作" onClose={() => setMenu(null)} actions={[
    { key: "rename", label: "重命名", icon: Pencil, onSelect: () => beginRename(menu.path) },
    { key: "trash", label: "移入回收站", icon: Trash2, tone: "danger", onSelect: () => trash(menu.path) },
  ]} />, document.body) : null;
  return { openMenu, renderRenameInput, panel, error, busy };
}
