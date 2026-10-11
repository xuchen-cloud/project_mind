import { useState, type ComponentProps } from "react";
import { ProjectSidebar } from "../layout/ProjectSidebar";
import { SidebarTabs } from "../../ui/components";
import { ProjectDirectoryBrowser } from "./ProjectDirectoryBrowser";
import "./project-directory.css";

/** One file panel for the project overview and record sidebar. */
export function HomeProjectFiles(props: Pick<ComponentProps<typeof ProjectSidebar>, "project" | "documents">) {
  const [mode, setMode] = useState<"managed" | "directory">("managed");
  return <div className="home-rail__files">
    <h2>文件</h2>
    <div className="project-directory-tabs"><SidebarTabs ariaLabel="项目文件范围" value={mode} onValueChange={setMode}
      options={[{ value: "managed", label: "已管理文件" }, { value: "directory", label: "项目目录" }]} /></div>
    {mode === "managed" ? <ProjectSidebar {...props} filesOnly resident onOpenProject={() => undefined} />
      : <ProjectDirectoryBrowser key={props.project.id} projectId={props.project.id} />}
  </div>;
}
