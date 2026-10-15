import { createContext, useContext } from "react";
import { Archive, ChevronsUpDown, Settings } from "lucide-react";
import wordmark from "../../assets/home/norimind-wordmark.svg";

export const HomeWorkspaceActionsContext = createContext<{
  workspaceName: string;
  switchWorkspace: () => void;
  openSettings: () => void;
  openArchivedProjects: () => void;
} | null>(null);

export function HomeWorkspaceIdentity({ projectName, onOpenProject, onOpenWorkspace }: { projectName?: string; onOpenProject?: () => void; onOpenWorkspace: () => void }) {
  const actions = useContext(HomeWorkspaceActionsContext);
  const workspaceName = actions?.workspaceName ?? "我的工作区";
  return <div className="home-side__brand-copy">
    {projectName !== undefined ? <>
      <button type="button" className="home-side__identity-title" title={projectName} onClick={onOpenProject}>{projectName}</button>
      <button type="button" className="home-side__identity-subtitle" aria-label={`NoriMind · ${workspaceName}`} title={`NoriMind · ${workspaceName}`} onClick={onOpenWorkspace}><img className="home-side__identity-wordmark" src={wordmark} alt="NoriMind" /><span aria-hidden="true">·</span><span className="home-side__identity-workspace">{workspaceName}</span></button>
    </> : <>
      <button type="button" className="home-side__identity-title" title={workspaceName} onClick={onOpenWorkspace}>{workspaceName}</button>
      <span className="home-side__identity-subtitle"><img className="home-side__identity-wordmark" src={wordmark} alt="NoriMind" /></span>
    </>}
  </div>;
}

export function HomeSidebarFooter({ onOpenArchivedProjects }: { onOpenArchivedProjects?: () => void } = {}) {
  const actions = useContext(HomeWorkspaceActionsContext);
  const openArchivedProjects = onOpenArchivedProjects ?? actions?.openArchivedProjects;
  if (!actions && !openArchivedProjects) return null;
  return <div className="home-side__footer" role="group" aria-label="工作区操作">
    {actions ? <button type="button" className="home-side__footer-workspace" aria-label="切换 Workspace" title="切换工作区" onClick={actions.switchWorkspace}><ChevronsUpDown size={16} /><span>{actions.workspaceName}</span></button> : null}
    <button type="button" className="home-side__workspace-action" aria-label="归档项目" title="归档项目" onClick={openArchivedProjects}><Archive size={18} /></button>
    {actions ? <button type="button" className="home-side__workspace-action" aria-label="设置" title="设置" onClick={actions.openSettings}><Settings size={18} /></button> : null}
  </div>;
}
