import { lazy, Suspense } from "react";
import { LoaderCircle } from "lucide-react";
import type { ProjectSidebarSessionsProps } from "./ProjectSidebarSessions";

const SidebarSessions = lazy(() => import("./ProjectSidebarSessions").then(module => ({ default: module.ProjectSidebarSessions })));

/** Session navigation is needed only after its Workspace or Project sidebar is visible. */
export function LazySidebarSessions(props: ProjectSidebarSessionsProps) {
  if (!props.enabled) return null;
  return <Suspense fallback={<section className="project-navigation__section" aria-label={props.projectId === null ? "工作区会话" : "项目会话"}>
    <div className="home-side__heading"><span>会话</span><span role="status" aria-label="正在加载会话列表" className="inline-flex"><LoaderCircle size={14} className="spin" aria-hidden="true" /></span></div>
  </section>}><SidebarSessions {...props} /></Suspense>;
}
