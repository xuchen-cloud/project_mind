import { useEffect, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { queryKeys } from "../../lib/queryKeys";
import { getErrorMessage } from "../../lib/errors";
import { openProjectFilePreview, useProjectFileNavigation } from "../../lib/project-file-navigation";
import { projectDirectoryApi } from "../../services/projectDirectoryApi";
import { HomeSidebarList } from "./HomeSidebarList";
import { FileIcon } from "../document/FileIcon";
import "./project-directory.css";

function DirectoryBranch({ projectId, rootPath, relativePath, depth, revision, activeRelativePath }: {
  projectId: number; rootPath: string; relativePath: string; depth: number; revision: number; activeRelativePath?: string | null;
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
    {directory.data?.map(entry => <div key={entry.relativePath}>
      <button type="button" className={`project-directory__entry ${entry.kind === "file" && entry.relativePath === activeRelativePath ? "is-active" : ""}`} style={indentation}
        aria-current={entry.kind === "file" && entry.relativePath === activeRelativePath ? "true" : undefined}
        aria-expanded={entry.kind === "directory" ? expanded.has(entry.relativePath) : undefined}
        onClick={() => {
          if (entry.kind === "file") { openProjectFilePreview(projectId, entry.relativePath); return; }
          setExpanded(previous => { const next = new Set(previous); if (next.has(entry.relativePath)) next.delete(entry.relativePath); else next.add(entry.relativePath); return next; });
        }}>
        {entry.kind === "directory" ? <ChevronRight size={12} strokeWidth={1.5} className="project-directory__chevron" aria-hidden="true" /> : <FileIcon name={entry.name} size={12} />}
        <span className="project-directory__name" title={entry.name}>{entry.name}</span>
      </button>
      {entry.kind === "directory" && expanded.has(entry.relativePath) ? <div className="project-directory__children" style={{ "--directory-guide-left": `${4 + depth * 12 + 6}px` } as CSSProperties}>
        <DirectoryBranch rootPath={rootPath} projectId={projectId} relativePath={entry.relativePath} depth={depth + 1} revision={revision} activeRelativePath={activeRelativePath} />
      </div> : null}
    </div>)}
  </>;
}

/** One scroll viewport for the entire expanded physical file hierarchy. */
export function ProjectDirectoryBrowser({ projectId, rootPath, activeRelativePath }: { projectId: number; rootPath: string; activeRelativePath?: string | null }) {
  const revision = useProjectFileNavigation(state => state.revisions[projectId] ?? 0);
  return <div className="project-directory"><HomeSidebarList label="项目目录内容">
    <DirectoryBranch key={rootPath} rootPath={rootPath} projectId={projectId} relativePath="" depth={0} revision={revision} activeRelativePath={activeRelativePath} />
  </HomeSidebarList></div>;
}
