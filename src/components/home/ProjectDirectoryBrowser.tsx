import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import type { ProjectFileMenuControls, ProjectSidebarDocumentItem } from "../layout/ProjectSidebar";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { projectFileApi } from "../../services/projectFileApi";
import { projectMindApi } from "../../services/projectMindApi";
import type { WorkspaceStatusSnapshot } from "../../lib/types";
import { queryKeys } from "../../lib/queryKeys";
import { getErrorMessage } from "../../lib/errors";
import { fileNavigationScopeKey, projectFilePathMatches, openProjectFilePreview, useProjectFileNavigation } from "../../lib/project-file-navigation";
import { projectDirectoryApi } from "../../services/projectDirectoryApi";
import { HomeSidebarList } from "./HomeSidebarList";
import { FileIcon } from "../document/FileIcon";
import "./project-directory.css";

function DirectoryBranch({ projectId, workspaceRoot, rootPath, relativePath, depth, revision, activeRelativePath, onFileContextMenu, renderRenameInput }: {
  projectId: number | null; workspaceRoot?: string; rootPath: string; relativePath: string; depth: number; revision: number; activeRelativePath?: string | null;
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
  const directory = useQuery({
    queryKey: queryKeys.projectDirectory(rootPath, projectId, relativePath, revision),
    queryFn: () => projectDirectoryApi.list(projectId, relativePath),
    retry: false,
    // External copies also appear while this project remains in the foreground.
    refetchInterval: 3000,
    gcTime: 0,
  });
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
        <DirectoryBranch workspaceRoot={workspaceRoot} rootPath={rootPath} projectId={projectId} relativePath={entry.relativePath} depth={depth + 1} revision={revision} activeRelativePath={activeRelativePath} onFileContextMenu={onFileContextMenu} renderRenameInput={renderRenameInput} />
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
  const request = useRef(0);
  const [menuError, setMenuError] = useState("");
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
  const revision = useProjectFileNavigation(state => state.revisions[fileNavigationScopeKey(projectId, workspaceRoot)] ?? 0);
  return <div className="project-directory">{menuError ? <p role="alert">{menuError}</p> : null}<HomeSidebarList label={projectId === null ? "工作区目录内容" : "项目目录内容"}>
    <DirectoryBranch workspaceRoot={workspaceRoot} key={rootPath} rootPath={rootPath} projectId={projectId} relativePath="" depth={0} revision={revision} activeRelativePath={activeRelativePath} onFileContextMenu={onFileContextMenu} renderRenameInput={fileMenu?.renderRenameInput} />
  </HomeSidebarList></div>;
}
