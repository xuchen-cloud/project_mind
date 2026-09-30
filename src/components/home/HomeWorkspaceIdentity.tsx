import { createContext, useContext } from "react";
import { ArrowLeftRight, Settings } from "lucide-react";

export const HomeWorkspaceActionsContext = createContext<{
  switchWorkspace: () => void;
  openSettings: () => void;
} | null>(null);

export function HomeWorkspaceIdentity({ onOpenWorkspace }: { onOpenWorkspace: () => void }) {
  const actions = useContext(HomeWorkspaceActionsContext);
  return <div className="home-side__workspace-row">
    <button type="button" className="home-side__workspace" onClick={onOpenWorkspace}>我的工作区</button>
    {actions ? <>
      <button type="button" className="home-side__workspace-action" aria-label="切换 Workspace" title="切换工作区" onClick={actions.switchWorkspace}><ArrowLeftRight size={13} /></button>
      <button type="button" className="home-side__workspace-action" aria-label="设置" title="设置" onClick={actions.openSettings}><Settings size={13} /></button>
    </> : null}
  </div>;
}
