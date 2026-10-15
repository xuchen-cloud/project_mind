import { useState, type ComponentProps } from "react";
import { List, ListTree } from "lucide-react";
import { ProjectSidebar } from "../layout/ProjectSidebar";
import { ProjectDirectoryBrowser } from "./ProjectDirectoryBrowser";
import "./project-directory.css";

/** Presentation changes never alter which project files are managed. */
export function HomeProjectFiles({ filter, ...props }: Pick<ComponentProps<typeof ProjectSidebar>, "project" | "documents"> & { filter?: { query: string; tagId: number | null } }) {
  const [tree, setTree] = useState(false);
  const label = tree ? "平铺展示" : "文件树展示";
  return <div className="home-rail__files"><ProjectSidebar {...props}
    fileFilter={tree ? { query: "", tagId: null } : filter}
    fileHeaderActions={<button type="button" aria-label={label} title={label} onClick={() => setTree(value => !value)}>{tree ? <List size={16} /> : <ListTree size={16} />}</button>}
    fileContent={tree ? <ProjectDirectoryBrowser key={props.project.rootPath} rootPath={props.project.rootPath} projectId={props.project.id} /> : undefined}
    filesOnly resident onOpenProject={() => undefined} />
  </div>;
}
