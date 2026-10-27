import { useEffect, useRef, useState, type ComponentProps } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { List, ListTree } from "lucide-react";
import type { FileBrowserScope } from "../../lib/file-types";
import { ProjectSidebar } from "../layout/ProjectSidebar";
import { ProjectDirectoryBrowser, useDirectoryVisibility, useProjectDirectoryListing } from "./ProjectDirectoryBrowser";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import type { AgentWorkspaceBinding } from "../../lib/agent-types";
import type { WorkspaceStatusSnapshot } from "../../lib/types";
import { queryKeys } from "../../lib/queryKeys";
import { getErrorMessage } from "../../lib/errors";
import "./project-directory.css";

type FilesProps = Pick<ComponentProps<typeof ProjectSidebar>, "documents" | "activeFileId"> & {
  activeRelativePath?: string | null;
  filter?: { query: string; tagId: number | null };
} & ({ fileScope: FileBrowserScope; project?: never } | { project: NonNullable<ComponentProps<typeof ProjectSidebar>["project"]>; fileScope?: never });

type DiscoveryScope = { projectId: number | null; rootPath: string; workspaceRoot?: string; tree: boolean };

function DirectoryDemandListing({ binding, ...scope }: DiscoveryScope & { binding?: AgentWorkspaceBinding }) {
  const directory = useProjectDirectoryListing({ ...scope, binding, relativePath: "", enabled: true });
  if (scope.tree) return null;
  return <>
    {directory.isFetching ? <p className="project-directory__message" role="status">正在发现文件…</p> : null}
    {directory.isError ? <p className="project-directory__message" role="alert">{getErrorMessage(directory.error, "无法发现新增文件")}<button type="button" onClick={() => void directory.refetch()}>重试发现文件</button></p> : null}
  </>;
}

/** Mounted only for a visible file panel; metadata remains independently usable. */
function VisibleDirectoryDemand(scope: DiscoveryScope) {
  const [binding, setBinding] = useState<AgentWorkspaceBinding>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const bindingRequired = !!scope.workspaceRoot && "__TAURI_INTERNALS__" in window;
  useEffect(() => {
    if (!bindingRequired || !scope.workspaceRoot) return;
    let disposed = false;
    setError("");
    void recordDocumentApi.bindingGet(scope.workspaceRoot).then(value => {
      if (!disposed) setBinding(value);
    }).catch(reason => {
      if (!disposed) setError(getErrorMessage(reason, "无法开始文件发现"));
    });
    return () => { disposed = true; };
  }, [bindingRequired, scope.workspaceRoot, attempt]);
  if (bindingRequired && !binding) return scope.tree ? null : error
    ? <p className="project-directory__message" role="alert">{error}<button type="button" onClick={() => setAttempt(value => value + 1)}>重试发现文件</button></p>
    : <p className="project-directory__message" role="status">正在发现文件…</p>;
  return <DirectoryDemandListing key={`${binding?.workspaceId}:${binding?.generation}`} {...scope} binding={binding} />;
}

/** Presentation changes never alter the files' real Workspace or Project owner. */
export function HomeProjectFiles({ filter, activeRelativePath, ...props }: FilesProps) {
  const [tree, setTree] = useState(false);
  const scope = props.fileScope;
  const owner = scope ?? { projectId: props.project.id, rootPath: props.project.rootPath, name: props.project.name };
  const queryClient = useQueryClient();
  const workspaceRoot = scope?.workspaceRoot ?? queryClient.getQueryData<WorkspaceStatusSnapshot>(queryKeys.workspaceStatus)?.currentWorkspace?.rootPath;
  const element = useRef<HTMLDivElement>(null);
  const scopeKey = JSON.stringify([workspaceRoot, owner.rootPath, owner.projectId]);
  const { enabled } = useDirectoryVisibility(element, scopeKey);
  const label = tree ? "平铺展示" : "文件树展示";
  return <div ref={element} className="home-rail__files">
    {enabled ? <VisibleDirectoryDemand key={scopeKey} projectId={owner.projectId} rootPath={owner.rootPath} workspaceRoot={workspaceRoot} tree={tree} /> : null}
    <ProjectSidebar key={JSON.stringify([owner.rootPath, owner.projectId])} {...props}
    fileFilter={tree ? { query: "", tagId: null } : filter}
    fileHeaderActions={<button type="button" aria-label={label} title={label} onClick={() => setTree(value => !value)}>{tree ? <List size={16} /> : <ListTree size={16} />}</button>}
    fileContent={tree ? controls => <ProjectDirectoryBrowser fileMenu={controls} documents={props.documents} activeRelativePath={activeRelativePath} key={owner.rootPath} rootPath={owner.rootPath} workspaceRoot={scope?.workspaceRoot} projectId={owner.projectId} /> : undefined}
    filesOnly resident onOpenProject={() => undefined} />
  </div>;
}
