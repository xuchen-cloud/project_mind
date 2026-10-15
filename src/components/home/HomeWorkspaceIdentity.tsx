import { createContext, useContext } from "react";
import { ChevronsUpDown, Settings } from "lucide-react";

export const HomeWorkspaceActionsContext = createContext<{
  workspaceName: string;
  switchWorkspace: () => void;
  openSettings: () => void;
} | null>(null);

export function HomeWorkspaceIdentity({ onOpenWorkspace }: { onOpenWorkspace: () => void }) {
  return <div className="home-side__workspace-row">
    <button type="button" className="home-side__workspace" onClick={onOpenWorkspace}>我的工作区</button>
  </div>;
}

export function HomeSidebarFooter() {
  const actions = useContext(HomeWorkspaceActionsContext);
  if (!actions) return null;
  return <div className="home-side__footer" role="group" aria-label="工作区操作">
    <button type="button" className="home-side__footer-workspace" aria-label="切换 Workspace" title="切换工作区" onClick={actions.switchWorkspace}><ChevronsUpDown size={16} /><span>{actions.workspaceName}</span></button>
    <button type="button" className="home-side__workspace-action" aria-label="设置" title="设置" onClick={actions.openSettings}><Settings size={18} /></button>
  </div>;
}
