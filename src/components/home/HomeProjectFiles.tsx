import { useState, type ComponentProps } from "react";
import { List, ListTree } from "lucide-react";
import type { FileBrowserScope } from "../../lib/file-types";
import { ProjectSidebar } from "../layout/ProjectSidebar";
import { ProjectDirectoryBrowser } from "./ProjectDirectoryBrowser";
import "./project-directory.css";

type FilesProps = Pick<ComponentProps<typeof ProjectSidebar>, "documents" | "activeFileId"> & {
  activeRelativePath?: string | null;
  filter?: { query: string; tagId: number | null };
} & ({ fileScope: FileBrowserScope; project?: never } | { project: NonNullable<ComponentProps<typeof ProjectSidebar>["project"]>; fileScope?: never });

/** Presentation changes never alter the files' real Workspace or Project owner. */
export function HomeProjectFiles({ filter, activeRelativePath, ...props }: FilesProps) {
  const [tree, setTree] = useState(false);
  const scope = props.fileScope;
  const owner = scope ?? { projectId: props.project.id, rootPath: props.project.rootPath, name: props.project.name };
  const label = tree ? "平铺展示" : "文件树展示";
  return <div className="home-rail__files"><ProjectSidebar key={JSON.stringify([owner.rootPath, owner.projectId])} {...props}
    fileFilter={tree ? { query: "", tagId: null } : filter}
    fileHeaderActions={<button type="button" aria-label={label} title={label} onClick={() => setTree(value => !value)}>{tree ? <List size={16} /> : <ListTree size={16} />}</button>}
    fileContent={tree ? controls => <ProjectDirectoryBrowser fileMenu={controls} documents={props.documents} activeRelativePath={activeRelativePath} key={owner.rootPath} rootPath={owner.rootPath} workspaceRoot={scope?.workspaceRoot} projectId={owner.projectId} /> : undefined}
    filesOnly resident onOpenProject={() => undefined} />
  </div>;
}
