import { directoryQueryRelativePath, matchesDirectoryQueryBinding, projectDirectoryQueryKey } from "../../lib/project-directory-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Trash2 } from "lucide-react";
import type { ProjectFileMenuControls, ProjectSidebarDocumentItem } from "../layout/ProjectSidebar";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { projectFileApi } from "../../services/projectFileApi";
import { projectMindApi } from "../../services/projectMindApi";
import type { WorkspaceStatusSnapshot } from "../../lib/types";
import { queryKeys } from "../../lib/queryKeys";
import { getErrorMessage } from "../../lib/errors";
import { indexProjectFiles, openProjectFilePreview, type ProjectFileIndex } from "../../lib/project-file-navigation";
import { projectDirectoryApi, type ProjectDirectoryEntry } from "../../services/projectDirectoryApi";
import { desktopApi } from "../../services/desktopApi";
import type { AgentWorkspaceBinding } from "../../lib/agent-types";
import { HomeSidebarList } from "./HomeSidebarList";
import { ListPinIndicator } from "../../ui/components";
import { FileIcon } from "../document/FileIcon";
import { useDirectoryActions } from "./useDirectoryActions";
import { ActionContextMenu } from "../../ui/components/ActionContextMenu";
import { fileSelectionData, useFileSelection, type FileSelectionItem } from "./useFileSelection";
import { useNavigationTrash } from "./useNavigationTrash";
import "./project-directory.css";

/** Shared demand boundaries for physical file views, including resident panels. */
export function useDirectoryVisibility(element: RefObject<HTMLElement | null>, scopeKey: string) {
  const [visibleScope, setVisibleScope] = useState({ key: scopeKey, enabled: false });
  const enabled = visibleScope.key === scopeKey && visibleScope.enabled;
  const isVisible = useCallback(() => {
    if (document.visibilityState === "hidden" || !element.current) return false;
    for (let node: HTMLElement | null = element.current; node; node = node.parentElement) {
      if (node.hidden || node.inert || node.hasAttribute("inert") || getComputedStyle(node).display === "none" || getComputedStyle(node).visibility === "hidden") return false;
    }
    return true;
  }, [element]);
  useLayoutEffect(() => {
    const visibility = () => {
      const enabled = isVisible();
      setVisibleScope(previous => previous.key === scopeKey && previous.enabled === enabled ? previous : { key: scopeKey, enabled });
    };
    const observer = new MutationObserver(visibility);
    for (let node: HTMLElement | null = element.current; node; node = node.parentElement) {
      observer.observe(node,{attributes:true,attributeFilter:["hidden","inert","style","class"]});
    }
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => {observer.disconnect();document.removeEventListener("visibilitychange", visibility);};
  }, [element, scopeKey, isVisible]);
  return { enabled, isVisible };
}

export function useProjectDirectoryListing({ projectId, workspaceRoot, binding, rootPath, relativePath, enabled }: {
  projectId: number | null; workspaceRoot?: string; binding?: AgentWorkspaceBinding; rootPath: string; relativePath: string; enabled: boolean;
}) {
  const queryClient = useQueryClient();
  const queryKey = projectDirectoryQueryKey(rootPath, projectId, relativePath, workspaceRoot, binding);
  const existing = queryClient.getQueryCache().find({ queryKey, exact: true });
  // Visible views share an in-progress read. Completed data still needs
  // reconciliation: the flat view does not consume directory dirty hints.
  const sharesActiveRead = existing?.isActive() && existing.state.fetchStatus === "fetching";
  const cachedOnMount = useRef(!sharesActiveRead && existing && (existing.state.data !== undefined || existing.state.fetchStatus !== "idle")
    ? { promise: existing.state.fetchStatus !== "idle" ? existing.promise : undefined } : undefined);
  const directory = useQuery({
    queryKey,
    queryFn: async () => {
      // The list command uses the window's current Workspace. Its result may
      // only enter this binding's cache if the binding still matches around I/O.
      const verifyBinding = async () => {
        if (!binding || !workspaceRoot) return;
        const actual = await recordDocumentApi.bindingGet(workspaceRoot);
        if (binding.workspaceId !== actual.workspaceId || binding.generation !== actual.generation) {
          throw new Error("工作区已切换，请重试读取目录。");
        }
      };
      await verifyBinding();
      const entries = await projectDirectoryApi.list(projectId, relativePath);
      await verifyBinding();
      return entries;
    },
    retry: false,
    enabled,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const used = useRef(false);
  useEffect(() => {
    if (!enabled || used.current) return;
    used.current = true;
    // Retain the usable snapshot across A-B-A navigation. Revalidate once on
    // actual use against the native watcher-backed cache, including changes
    // made while this branch was unmounted. No disk enumeration on a cache hit.
    if (!cachedOnMount.current) return;
    let disposed = false;
    // A read started before unmount may still be in flight. Its completion
    // cannot consume this use's reconciliation, since dirty hints were absent.
    void Promise.resolve(cachedOnMount.current.promise).catch(() => {}).then(() => {
      if (!disposed) return directory.refetch({ cancelRefetch: false });
    });
    return () => { disposed = true; used.current = false; };
  }, [enabled]);
  return directory;
}

function DirectoryBranch({ projectId, workspaceRoot, binding, rootPath, relativePath, depth, enabled, activeRelativePath, selection, onContextMenu, renderRenameInput, renderDirectoryRenameInput, fileIndex }: {
  projectId: number | null; workspaceRoot?: string; binding?: AgentWorkspaceBinding; rootPath: string; relativePath: string; depth: number; enabled: boolean; activeRelativePath?: string | null;
  selection: ReturnType<typeof useFileSelection>;
  onContextMenu: (item: FileSelectionItem, x: number, y: number, event?: Parameters<ReturnType<typeof useFileSelection>["onContextMenu"]>[1]) => void;
  renderRenameInput?: (path: string) => ReactNode;
  renderDirectoryRenameInput: (path: string) => ReactNode;
  fileIndex: ProjectFileIndex<ProjectSidebarDocumentItem>;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!activeRelativePath) return;
    // Expand only the next ancestor in this branch, without scanning other folders.
    const prefix = relativePath ? `${relativePath}/` : "";
    if (!activeRelativePath.startsWith(prefix)) return;
    const remaining = activeRelativePath.slice(prefix.length);
    const separator = remaining.indexOf("/");
    if (separator < 0) return;
    const ancestor = prefix + remaining.slice(0, separator);
    setExpanded(previous => previous.has(ancestor) ? previous : new Set([...previous, ancestor]));
  }, [activeRelativePath, relativePath]);
  const indentation = { paddingInlineStart: 4 + depth * 12 };
  const directory = useProjectDirectoryListing({ projectId, workspaceRoot, binding, rootPath, relativePath, enabled });
  return <>
    {directory.isPending ? <p className="project-directory__message" style={indentation} role="status">正在读取目录…</p> : null}
    {directory.isError ? <div className="project-directory__message" style={indentation} role="alert">{getErrorMessage(directory.error, "无法读取项目目录")}<button type="button" onClick={() => void directory.refetch()}>重试读取目录</button></div> : null}
    {directory.data?.length === 0 ? <p className="project-directory__message" style={indentation}>此目录为空</p> : null}
    {directory.data?.map(entry => {
      const dropDocument = entry.kind === "file" ? fileIndex.findByRelativePath(entry.relativePath) : undefined;
      const starred = dropDocument?.isStarred;
      const item: FileSelectionItem = { key: `${entry.kind}:${entry.relativePath}`, relativePath: entry.relativePath, kind: entry.kind, ...(dropDocument ? { fileId: dropDocument.id } : {}) };
      const selected = selection.selected.has(item.key);
      const renameInput = entry.kind === "file" ? renderRenameInput?.(entry.relativePath) : renderDirectoryRenameInput(entry.relativePath);
      return <div key={entry.relativePath}>
      {renameInput ? <div className="project-directory__entry" style={indentation}>
        {entry.kind === "directory" ? <ChevronRight size={12} aria-hidden="true" /> : <FileIcon name={entry.name} size={12} />}{renameInput}{starred ? <ListPinIndicator label="标星" /> : null}
      </div> : <button type="button" {...fileSelectionData(item)} data-selected={selected} aria-pressed={selected} className={`project-directory__entry ${selected ? "is-selected" : ""} ${entry.kind === "file" && entry.relativePath === activeRelativePath ? "is-active" : ""}`} style={indentation}
        data-file-drop-target={dropDocument ? JSON.stringify({ id: dropDocument.id, name: dropDocument.name,
          documentId: dropDocument.id, projectId: dropDocument.projectId, managedPath: dropDocument.managedPath,
          expectedVersionNumber: dropDocument.currentVersionNumber }) : undefined}
        aria-label={entry.name}
        aria-current={entry.kind === "file" && entry.relativePath === activeRelativePath ? "true" : undefined}
        aria-expanded={entry.kind === "directory" ? expanded.has(entry.relativePath) : undefined}
        onMouseDown={event => selection.onMouseDown(item, event)}
        onContextMenu={event => {
          event.preventDefault();
          onContextMenu(item, event.clientX, event.clientY, event);
        }}
        onKeyDown={event => {
          if (!(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          onContextMenu(item, rect.left + 12, rect.bottom + 6);
        }}
        onClick={event => {
          if (selection.onClick(item, event)) return;
          if (entry.kind === "file") { openProjectFilePreview(projectId, entry.relativePath, undefined, undefined, undefined, workspaceRoot); return; }
          setExpanded(previous => { const next = new Set(previous); if (next.has(entry.relativePath)) next.delete(entry.relativePath); else next.add(entry.relativePath); return next; });
        }}>
        {entry.kind === "directory" ? <ChevronRight size={12} strokeWidth={1.5} className="project-directory__chevron" aria-hidden="true" /> : <FileIcon name={entry.name} size={12} />}
        <span className="project-directory__name" title={entry.name}>{entry.name}</span>
        {starred ? <ListPinIndicator label="标星" /> : null}
      </button>}
      {entry.kind === "directory" && expanded.has(entry.relativePath) ? <div className="project-directory__children" style={{ "--directory-guide-left": `${4 + depth * 12 + 6}px` } as CSSProperties}>
        <DirectoryBranch workspaceRoot={workspaceRoot} binding={binding} rootPath={rootPath} projectId={projectId} relativePath={entry.relativePath} depth={depth + 1} enabled={enabled} activeRelativePath={activeRelativePath} selection={selection} onContextMenu={onContextMenu} renderRenameInput={renderRenameInput} renderDirectoryRenameInput={renderDirectoryRenameInput} fileIndex={fileIndex} />
      </div> : null}
    </div>; })}
  </>;
}

const EMPTY_DOCUMENTS: ProjectSidebarDocumentItem[] = [];

/** One scroll viewport for the entire expanded physical file hierarchy. */
export function ProjectDirectoryBrowser({ projectId, workspaceRoot, rootPath, binding: navigationBinding, activeRelativePath, documents = EMPTY_DOCUMENTS, fileMenu }: {
  projectId: number | null; workspaceRoot?: string; rootPath: string; binding?: AgentWorkspaceBinding; activeRelativePath?: string | null;
  documents?: ProjectSidebarDocumentItem[]; fileMenu?: ProjectFileMenuControls;
}) {
  const queryClient = useQueryClient();
  const fileIndex = useMemo(() => indexProjectFiles({ rootPath, documents }), [rootPath, documents]);
  const element = useRef<HTMLDivElement>(null);
  const { enabled, isVisible } = useDirectoryVisibility(element, JSON.stringify([rootPath, projectId]));
  const [menuError, setMenuError] = useState("");
  const activeWorkspaceRoot = workspaceRoot ?? queryClient.getQueryData<WorkspaceStatusSnapshot>(queryKeys.workspaceStatus)?.currentWorkspace?.rootPath;
  const scope = JSON.stringify([activeWorkspaceRoot, rootPath, projectId]);
  const scopeEpoch = useRef(0);
  useLayoutEffect(() => {
    scopeEpoch.current++;
    return () => { scopeEpoch.current++; };
  }, [scope]);
  const [boundWorkspace, setBoundWorkspace] = useState<{ scope: string; binding: AgentWorkspaceBinding }>();
  const bindingRequired = !!activeWorkspaceRoot && "__TAURI_INTERNALS__" in window;
  const directoryBinding = navigationBinding ?? (boundWorkspace?.scope === scope ? boundWorkspace?.binding : undefined);
  const currentBinding = useRef(directoryBinding);
  currentBinding.current = directoryBinding;
  const directoryActions = useDirectoryActions({ projectId, rootPath, workspaceRoot: activeWorkspaceRoot, binding: directoryBinding });
  const selectionScope = JSON.stringify([scope, directoryBinding?.workspaceId, directoryBinding?.generation]);
  const selection = useFileSelection(selectionScope, element);
  const navigationTrash = useNavigationTrash({ workspaceRoot: activeWorkspaceRoot, rootPath, projectId, binding: directoryBinding });
  const [bulkMenu, setBulkMenu] = useState<{ scope: string; x: number; y: number; keys: string[]; run: ReturnType<typeof navigationTrash.capture> } | null>(null);
  useLayoutEffect(() => {
    setBulkMenu(previous => previous?.scope === selectionScope && previous.keys.length === selection.selected.size
      && previous.keys.every(key => selection.selected.has(key)) ? previous : null);
  }, [selectionScope, selection.selected]);
  const bulkBlocked = navigationTrash.busy || directoryActions.busy || directoryActions.renaming
    || fileMenu?.busy || fileMenu?.renaming;
  const hasInlineEditor = () => !!element.current?.querySelector("input, textarea, [contenteditable=true]");
  useLayoutEffect(() => { setMenuError(""); }, [scope, directoryBinding?.workspaceId, directoryBinding?.generation]);
  const refreshDirectories = useRef<(paths: string[] | null | undefined) => void>(() => {});
  // All directory change sources share one queue for this mounted scope.
  // Layout cleanup retires it before a new scope can use the same element.
  useLayoutEffect(() => {
    let disposed = false;
    const matchesBinding = (key: readonly unknown[]) => matchesDirectoryQueryBinding(key, activeWorkspaceRoot, directoryBinding);
    const prefix = ["project-directory", rootPath, projectId];
    const within = (path: string, ancestor: string) => path === ancestor || ancestor === "" || path.startsWith(`${ancestor}/`);
    const invalidate = (paths: Set<string> | null) => queryClient.invalidateQueries({
      queryKey: prefix,
      predicate: query => matchesBinding(query.queryKey) && (paths === null || paths.has(directoryQueryRelativePath(query.queryKey))),
      refetchType: "none",
    });
    let dirty: Set<string> | null | undefined;
    let flight: Promise<void> | undefined;
    const refresh = (paths: string[] | null | undefined) => {
      if (disposed) return;
      // Empty paths resume a deferred generation without widening its scope.
      if (paths?.length !== 0) {
        if (paths == null) dirty = null;
        else if (dirty !== null) {dirty = new Set([...(dirty ?? []),...paths]);if (dirty.size > 256) dirty = null;}
      }
      if (flight || dirty === undefined || !isVisible()) return;
      flight = Promise.resolve().then(async () => {
        while (dirty !== undefined && !disposed && isVisible()) {
          const paths = dirty;
          // Invalidation would reuse an older read (including an initial read
          // with no data), whose result can then clear isInvalidated. Let that
          // native I/O settle before consuming this dirty generation.
          const scoped = queryClient.getQueryCache().findAll({ queryKey: prefix, predicate: query => matchesBinding(query.queryKey) });
          const affected = scoped.filter(query => paths === null || paths.has(directoryQueryRelativePath(query.queryKey)));
          const pending = scoped.filter(query => query.state.fetchStatus !== "idle" && affected.some(target =>
            within(directoryQueryRelativePath(target.queryKey), directoryQueryRelativePath(query.queryKey)))).map(query => query.promise);
          await Promise.allSettled(pending);
          if (disposed || !isVisible()) break;
          // Hints arriving during the wait stay merged; include their paths in
          // the wait before issuing one refresh for the accumulated generation.
          if (paths !== dirty) continue;
          dirty = undefined;
          await invalidate(paths);
          const active = queryClient.getQueryCache().findAll({ queryKey: prefix,
            predicate: query => matchesBinding(query.queryKey) && query.isActive()
              && (paths === null || paths.has(directoryQueryRelativePath(query.queryKey))) })
            .sort((a, b) => directoryQueryRelativePath(a.queryKey).split("/").length - directoryQueryRelativePath(b.queryKey).split("/").length
              || directoryQueryRelativePath(a.queryKey).localeCompare(directoryQueryRelativePath(b.queryKey)));
          const missing = new Set<string>();
          const failed = new Set<string>();
          let failure: unknown;
          for (let index = 0; index < active.length; index++) {
            if (disposed) return;
            if (!isVisible()) {
              if (dirty !== null) dirty = new Set([...(dirty ?? []), ...active.slice(index).map(query => directoryQueryRelativePath(query.queryKey))]);
              break;
            }
            const query = active[index];
            const path = directoryQueryRelativePath(query.queryKey);
            if ([...missing, ...failed].some(ancestor => within(path, ancestor))) continue;
            const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
            const parent = path ? queryClient.getQueryCache().find({ queryKey: projectDirectoryQueryKey(rootPath, projectId,
              parentPath, activeWorkspaceRoot, directoryBinding), exact: true }) : undefined;
            if (parent?.state.status === "error") { failed.add(path); continue; }
            const entries = parent?.state.data as ProjectDirectoryEntry[] | undefined;
            if (entries && !parent?.state.isInvalidated && !entries.some(entry => entry.kind === "directory" && entry.relativePath === path)) {
              missing.add(path);
              // A successful ancestor read proves this subtree is gone. Retire
              // outstanding reads; never infer deletion from an I/O failure.
              await queryClient.cancelQueries({ queryKey: prefix, predicate: candidate => matchesBinding(candidate.queryKey)
                && within(directoryQueryRelativePath(candidate.queryKey), path) });
              continue;
            }
            if (!query.isActive()) continue;
            try {
              await queryClient.refetchQueries({ queryKey: query.queryKey, exact: true, type: "active" }, { cancelRefetch: false, throwOnError: true });
              // A concurrent publisher may retire this read. Its invalidated
              // snapshot cannot establish membership for the next descendant.
              if (query.state.isInvalidated) failed.add(path);
            } catch (reason) { failed.add(path); failure ??= reason; }
          }
          if (!disposed) setMenuError(failure ? getErrorMessage(failure, "无法刷新目录") : "");
        }
      }).finally(() => { flight = undefined; });
      void flight.catch(reason => { if (!disposed) setMenuError(getErrorMessage(reason, "无法刷新目录")); });
    };
    refreshDirectories.current = refresh;
    return () => { disposed = true; };
  }, [queryClient, activeWorkspaceRoot, rootPath, projectId, directoryBinding?.workspaceId, directoryBinding?.generation]);
  useEffect(() => { if (enabled) refreshDirectories.current([]); }, [enabled]);
  // Page invalidation also follows ordinary saves/Todo changes. Only committed
  // path membership changes alter directory entries; do not fan these out.
  const previousPaths = useRef<{scope:string;paths:Map<number,string>} | undefined>(undefined);
  useEffect(() => {
    const paths = new Map(documents.map(item => [item.id,item.managedPath]));
    const previous = previousPaths.current;
    previousPaths.current = {scope,paths};
    if (!previous || previous.scope !== scope) return;
    const changed = new Set<string>();
    const addParents = (path:string) => {
      const prefix = rootPath.replaceAll("\\","/").replace(/\/$/, "") + "/";
      const normalized = path.replaceAll("\\","/");
      if (!normalized.startsWith(prefix)) return;
      const segments = normalized.slice(prefix.length).split("/"); segments.pop();
      while (true) { changed.add(segments.join("/")); if (!segments.length) break; segments.pop(); }
    };
    for (const [id,path] of previous.paths) if (paths.get(id) !== path) addParents(path);
    for (const [id,path] of paths) if (previous.paths.get(id) !== path) addParents(path);
    if (changed.size) refreshDirectories.current([...changed]);
  }, [queryClient,scope,rootPath,projectId,documents]);
  const request = useRef(0);
  useLayoutEffect(() => () => { request.current += 1; }, [activeWorkspaceRoot, projectId, rootPath, directoryBinding?.workspaceId, directoryBinding?.generation]);
  useEffect(() => {
    if (!activeWorkspaceRoot || !("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    const epoch = scopeEpoch.current;
    const current = () => !disposed && scopeEpoch.current === epoch;
    let binding: AgentWorkspaceBinding | undefined;
    const earlyHints: DirectoryDirtyHint[] = [];
    let unlisten: (() => void) | undefined;
    const changed = (hint: DirectoryDirtyHint) => {
      if (!current() || hint.projectId !== projectId) return;
      if (!binding) { earlyHints.push(hint); return; }
      const expected = currentBinding.current ?? binding;
      if (hint.binding.workspaceId === expected.workspaceId && hint.binding.generation === expected.generation) refreshDirectories.current(hint.relativePaths);
    };
    void (async () => {
      // Listen before reading identity so watcher changes during setup are kept.
      unlisten = await desktopApi.listenEvent("mind:project-directory-dirty", changed);
      if (!current()) { unlisten(); return; }
      binding = await recordDocumentApi.bindingGet(activeWorkspaceRoot);
      if (!current()) return;
      setBoundWorkspace({ scope, binding });
      for (const hint of earlyHints) changed(hint); earlyHints.length = 0;
    })().catch(reason => { if (current()) setMenuError(getErrorMessage(reason, "无法监听目录变化")); });
    return () => { disposed = true; unlisten?.(); };
  }, [queryClient, activeWorkspaceRoot, rootPath, projectId]);
  useEffect(() => {
    const cancel = () => { request.current += 1; };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    window.addEventListener("keydown", escape);
    window.addEventListener("pointerdown", cancel);
    return () => { cancel(); window.removeEventListener("keydown", escape); window.removeEventListener("pointerdown", cancel); };
  }, [projectId, rootPath]);
  const onFileContextMenu = async (relativePath: string, x: number, y: number) => {
    if (!fileMenu) return;
    const current = ++request.current;
    setMenuError("");
    try {
      const actualBinding = directoryBinding && activeWorkspaceRoot ? await recordDocumentApi.bindingGet(activeWorkspaceRoot) : undefined;
      if (current !== request.current) return;
      if (actualBinding && directoryBinding && (actualBinding.workspaceId !== directoryBinding.workspaceId || actualBinding.generation !== directoryBinding.generation)) {
        throw new Error("工作区已切换，请刷新后重试文件操作。");
      }
      let document = fileIndex.findByRelativePath(relativePath);
      if (!document) {
        const activeWorkspaceRoot = workspaceRoot ?? queryClient.getQueryData<WorkspaceStatusSnapshot>(queryKeys.workspaceStatus)?.currentWorkspace?.rootPath;
        if (!activeWorkspaceRoot) throw new Error("工作区信息尚未就绪，请稍后重试。");
        const binding = actualBinding ?? await recordDocumentApi.bindingGet(activeWorkspaceRoot);
        if (current !== request.current) return;
        const file = await projectFileApi.register(binding, projectId, relativePath);
        if (current !== request.current) return;
        if (file.state !== "ready") throw new Error(file.reason ?? "文件身份需要核对");
        const listed = projectId === null ? (await projectMindApi.workspacePageGet()).workspaceDocuments : (await projectMindApi.projectPageGet({ projectId })).projectDocuments;
        if (current !== request.current) return;
        const after = await recordDocumentApi.bindingGet(activeWorkspaceRoot);
        if (current !== request.current) return;
        if (binding.workspaceId !== after.workspaceId || binding.generation !== after.generation) throw new Error("工作区已切换，请重试。");
        document = listed.find(item => String(item.id) === file.object.id);
        if (!document) throw new Error("无法读取已管理文件");
        await queryClient.invalidateQueries({ queryKey: projectId === null ? queryKeys.workspacePage : queryKeys.projectPage(projectId) });
      }
      if (current === request.current) fileMenu.openContextMenu(document, x, y);
    } catch (error) {
      if (current === request.current) setMenuError(getErrorMessage(error, "无法打开文件操作菜单"));
    }
  };
  const onContextMenu = (item: FileSelectionItem, x: number, y: number, event?: Parameters<typeof selection.onContextMenu>[1]) => {
    request.current++;
    setBulkMenu(null);
    const items = selection.onContextMenu(item, event);
    if (!items) return;
    if (items.length >= 2) {
      if (bulkBlocked || hasInlineEditor()) return;
      setBulkMenu({ scope: selectionScope, x, y, keys: items.map(item => item.key), run: navigationTrash.capture(items) });
    } else if (items.length === 1) {
      if (item.kind === "file") void onFileContextMenu(item.relativePath, x, y);
      else directoryActions.openMenu(item.relativePath, x, y);
    }
  };
  return <div ref={element} className="project-directory">{menuError || directoryActions.error ? <p role="alert">{menuError || directoryActions.error}</p> : null}<HomeSidebarList label={projectId === null ? "工作区目录内容" : "项目目录内容"}>
    <DirectoryBranch workspaceRoot={activeWorkspaceRoot} binding={directoryBinding} key={`${activeWorkspaceRoot}:${rootPath}:${projectId}:${directoryBinding?.workspaceId}:${directoryBinding?.generation}`} rootPath={rootPath} projectId={projectId} relativePath="" depth={0} enabled={enabled && (!bindingRequired || !!directoryBinding)} activeRelativePath={activeRelativePath} selection={selection} onContextMenu={onContextMenu} renderRenameInput={fileMenu?.renderRenameInput} renderDirectoryRenameInput={directoryActions.renderRenameInput} fileIndex={fileIndex} />
  </HomeSidebarList>{directoryActions.panel}{bulkMenu?.scope === selectionScope ? createPortal(<ActionContextMenu
    x={bulkMenu.x} y={bulkMenu.y} ariaLabel="所选文件操作" onClose={() => setBulkMenu(null)} actions={[
      { key: "trash-selected", label: `删除所选 ${bulkMenu.keys.length} 项`, icon: Trash2, tone: "danger", disabled: bulkBlocked,
        onSelect: () => {
          if (bulkBlocked || hasInlineEditor()) return;
          void bulkMenu.run().then(result => {
            if (result) selection.remove(result.succeeded.map(item => item.relativePath));
          });
        } },
    ]} />, document.body) : null}</div>;
}

interface DirectoryDirtyHint { binding: AgentWorkspaceBinding; projectId: number | null; relativePaths?: string[] | null }
