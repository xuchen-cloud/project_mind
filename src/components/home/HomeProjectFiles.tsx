import type { ComponentProps } from "react";
import { ProjectSidebar } from "../layout/ProjectSidebar";

/** One file panel for the project overview and record sidebar. */
export function HomeProjectFiles(props: Pick<ComponentProps<typeof ProjectSidebar>, "project" | "documents">) {
  return <div className="home-rail__files">
    <h2>文件</h2>
    <ProjectSidebar {...props} filesOnly resident onOpenProject={() => undefined} />
  </div>;
}
