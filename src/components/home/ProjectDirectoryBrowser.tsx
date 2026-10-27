import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import type { ProjectFileMenuControls, ProjectSidebarDocumentItem } from "../layout/ProjectSidebar";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { projectFileApi } from "../../services/projectFileApi";
import { projectMindApi } from "../../services/projectMindApi";
import type { WorkspaceStatusSnapshot } from "../../lib/types";
import { queryKeys } from "../../lib/queryKeys";
import { getErrorMessage } from "../../lib/errors";
import { projectFilePathMatches, openProjectFilePreview } from "../../lib/project-file-navigation";
import { projectDirectoryApi } from "../../services/projectDirectoryApi";
import { desktopApi } from "../../services/desktopApi";
import type { AgentWorkspaceBinding } from "../../lib/agent-types";
import { HomeSidebarList } from "./HomeSidebarList";
import { FileIcon } from "../document/FileIcon";
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
  const queryKey = [...queryKeys.projectDirectory(rootPath, projectId, relativePath, 0), workspaceRoot, ...(binding ? [binding.workspaceId, binding.generation] : [])];
  const existing = queryClient.getQueryCache().find({ queryKey, exact: true });
  // Visible views share an in-progress read. Completed data still needs
  // reconciliation: the flat view does not consume directory dirty hints.
  const sharesActiveRead = existing?.isActive() && existing.state.fetchStatus === "fetching";
  const cachedOnMount = useRef(!sharesActiveRead && existing && (existing.state.data !== undefined || existing.state.fetchStatus !== "idle")
    ? { promise: existing.state.fetchStatus !== "idle" ? existing.promise : undefined } : undefined);
  const directory = useQuery({
    queryKey,
    queryFn: () => projectDirectoryApi.list(projectId, relativePath),
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

function DirectoryBranch({ projectId, workspaceRoot, binding, rootPath, relativePath, depth, enabled, activeRelativePath, onFileContextMenu, renderRenameInput }: {
  projectId: number | null; workspaceRoot?: string; binding?: AgentWorkspaceBinding; rootPath: string; relativePath: string; depth: number; enabled: boolean; activeRelativePath?: string | null;
  onFileContextMenu: (path: string, x: number, y: number) => void;
  renderRenameInput?: (path: string) => ReactNode;
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
      const renameInput = entry.kind === "file" ? renderRenameInput?.(entry.relativePath) : null;
      return <div key={entry.relativePath}>
      {renameInput ? <div className="project-directory__entry" style={indentation}>
        <FileIcon name={entry.name} size={12} />{renameInput}
      </div> : <button type="button" className={`project-directory__entry ${entry.kind === "file" && entry.relativePath === activeRelativePath ? "is-active" : ""}`} style={indentation}
        aria-current={entry.kind === "file" && entry.relativePath === activeRelativePath ? "true" : undefined}
        aria-expanded={entry.kind === "directory" ? expanded.has(entry.relativePath) : undefined}
        onContextMenu={event => {
          if (entry.kind !== "file") return;
          event.preventDefault();
          onFileContextMenu(entry.relativePath, event.clientX, event.clientY);
        }}
        onKeyDown={event => {
          if (entry.kind !== "file" || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          onFileContextMenu(entry.relativePath, rect.left + 12, rect.bottom + 6);
        }}
        onClick={() => {
          if (entry.kind === "file") { openProjectFilePreview(projectId, entry.relativePath, undefined, undefined, undefined, workspaceRoot); return; }
          setExpanded(previous => { const next = new Set(previous); if (next.has(entry.relativePath)) next.delete(entry.relativePath); else next.add(entry.relativePath); return next; });
        }}>
        {entry.kind === "directory" ? <ChevronRight size={12} strokeWidth={1.5} className="project-directory__chevron" aria-hidden="true" /> : <FileIcon name={entry.name} size={12} />}
        <span className="project-directory__name" title={entry.name}>{entry.name}</span>
      </button>}
      {entry.kind === "directory" && expanded.has(entry.relativePath) ? <div className="project-directory__children" style={{ "--directory-guide-left": `${4 + depth * 12 + 6}px` } as CSSProperties}>
        <DirectoryBranch workspaceRoot={workspaceRoot} binding={binding} rootPath={rootPath} projectId={projectId} relativePath={entry.relativePath} depth={depth + 1} enabled={enabled} activeRelativePath={activeRelativePath} onFileContextMenu={onFileContextMenu} renderRenameInput={renderRenameInput} />
      </div> : null}
    </div>; })}
  </>;
}

/** One scroll viewport for the entire expanded physical file hierarchy. */
export function ProjectDirectoryBrowser({ projectId, workspaceRoot, rootPath, activeRelativePath, documents = [], fileMenu }: {
  projectId: number | null; workspaceRoot?: string; rootPath: string; activeRelativePath?: string | null;
  documents?: ProjectSidebarDocumentItem[]; fileMenu?: ProjectFileMenuControls;
}) {
  const queryClient = useQueryClient();
  const element = useRef<HTMLDivElement>(null);
  const { enabled, isVisible } = useDirectoryVisibility(element, JSON.stringify([rootPath, projectId]));
  const [menuError, setMenuError] = useState("");
  const activeWorkspaceRoot = workspaceRoot ?? queryClient.getQueryData<WorkspaceStatusSnapshot>(queryKeys.workspaceStatus)?.currentWorkspace?.rootPath;
  const [boundWorkspace, setBoundWorkspace] = useState<{ root: string; binding: AgentWorkspaceBinding }>();
  const bindingRequired = !!activeWorkspaceRoot && "__TAURI_INTERNALS__" in window;
  const directoryBinding = boundWorkspace?.root === activeWorkspaceRoot ? boundWorkspace?.binding : undefined;
  const refreshDirectories = useRef<(paths: string[] | null | undefined) => void>(() => {});
  // All directory change sources share one queue for this mounted scope.
  // Layout cleanup retires it before a new scope can use the same element.
  useLayoutEffect(() => {
    let disposed = false;
    const invalidate = (paths: Set<string> | null) => queryClient.invalidateQueries({
      queryKey: ["project-directory", rootPath, projectId],
      predicate: query => paths === null || paths.has(String(query.queryKey[3])),
      refetchType: isVisible() ? "active" : "none",
    }, { cancelRefetch: false });
    let dirty: Set<string> | null | undefined;
    let flight: Promise<void> | undefined;
    const refresh = (paths: string[] | null | undefined) => {
      if (disposed) return;
      if (paths?.length === 0) return;
      if (paths == null) dirty = null;
      else if (dirty !== null) {dirty = new Set([...(dirty ?? []),...paths]);if (dirty.size > 256) dirty = null;}
      if (flight) return;
      flight = Promise.resolve().then(async () => {
        while (dirty !== undefined && !disposed) {
          const paths = dirty;
          // Invalidation would reuse an older read (including an initial read
          // with no data), whose result can then clear isInvalidated. Let that
          // native I/O settle before consuming this dirty generation.
          const pending = queryClient.getQueryCache().findAll({
            queryKey: ["project-directory", rootPath, projectId],
            predicate: query => paths === null || paths.has(String(query.queryKey[3])),
          }).filter(query => query.state.fetchStatus !== "idle").map(query => query.promise);
          await Promise.allSettled(pending);
          if (disposed) break;
          // Hints arriving during the wait stay merged; include their paths in
          // the wait before issuing one refresh for the accumulated generation.
          if (paths !== dirty) continue;
          dirty = undefined;
          await invalidate(paths);
        }
      }).finally(() => { flight = undefined; });
      void flight.catch(reason => { if (!disposed) setMenuError(getErrorMessage(reason, "无法刷新目录")); });
    };
    refreshDirectories.current = refresh;
    return () => { disposed = true; };
  }, [queryClient, activeWorkspaceRoot, rootPath, projectId]);
  // Page invalidation also follows ordinary saves/Todo changes. Only committed
  // path membership changes alter directory entries; do not fan these out.
  const previousPaths = useRef<{rootPath:string;projectId:number|null;paths:Map<number,string>} | undefined>(undefined);
  useEffect(() => {
    const paths = new Map(documents.map(item => [item.id,item.managedPath]));
    const previous = previousPaths.current;
    previousPaths.current = {rootPath,projectId,paths};
    if (!previous || previous.rootPath !== rootPath || previous.projectId !== projectId) return;
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
  }, [queryClient,rootPath,projectId,documents]);
  const request = useRef(0);
  useEffect(() => {
    if (!activeWorkspaceRoot || !("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    const refresh = refreshDirectories.current;
    let binding: AgentWorkspaceBinding | undefined;
    const earlyHints: DirectoryDirtyHint[] = [];
    let unlisten: (() => void) | undefined;
    const changed = (hint: DirectoryDirtyHint) => {
      if (disposed || hint.projectId !== projectId) return;
      if (!binding) { earlyHints.push(hint); return; }
      if (hint.binding.workspaceId === binding.workspaceId && hint.binding.generation === binding.generation) refresh(hint.relativePaths);
    };
    void (async () => {
      // Listen before reading identity so watcher changes during setup are kept.
      unlisten = await desktopApi.listenEvent("mind:project-directory-dirty", changed);
      if (disposed) { unlisten(); return; }
      binding = await recordDocumentApi.bindingGet(activeWorkspaceRoot);
      if (disposed) return;
      setBoundWorkspace({ root: activeWorkspaceRoot, binding });
      for (const hint of earlyHints) changed(hint); earlyHints.length = 0;
    })().catch(reason => { if (!disposed) setMenuError(getErrorMessage(reason, "无法监听目录变化")); });
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
      let document = documents.find(item => projectFilePathMatches(item.managedPath, rootPath, relativePath));
      if (!document) {
        const activeWorkspaceRoot = workspaceRoot ?? queryClient.getQueryData<WorkspaceStatusSnapshot>(queryKeys.workspaceStatus)?.currentWorkspace?.rootPath;
        if (!activeWorkspaceRoot) throw new Error("工作区信息尚未就绪，请稍后重试。");
        const binding = await recordDocumentApi.bindingGet(activeWorkspaceRoot);
        if (current !== request.current) return;
        const file = await projectFileApi.register(binding, projectId, relativePath);
        if (current !== request.current) return;
        if (file.state !== "ready") throw new Error(file.reason ?? "文件身份需要核对");
        const listed = projectId === null ? (await projectMindApi.workspacePageGet()).workspaceDocuments : (await projectMindApi.projectPageGet({ projectId })).projectDocuments;
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
  return <div ref={element} className="project-directory">{menuError ? <p role="alert">{menuError}</p> : null}<HomeSidebarList label={projectId === null ? "工作区目录内容" : "项目目录内容"}>
    <DirectoryBranch workspaceRoot={activeWorkspaceRoot} binding={directoryBinding} key={`${activeWorkspaceRoot}:${rootPath}:${projectId}:${directoryBinding?.workspaceId}:${directoryBinding?.generation}`} rootPath={rootPath} projectId={projectId} relativePath="" depth={0} enabled={enabled && (!bindingRequired || !!directoryBinding)} activeRelativePath={activeRelativePath} onFileContextMenu={onFileContextMenu} renderRenameInput={fileMenu?.renderRenameInput} />
  </HomeSidebarList></div>;
}

interface DirectoryDirtyHint { binding: AgentWorkspaceBinding; projectId: number | null; relativePaths?: string[] | null }
