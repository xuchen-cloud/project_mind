import { lazy, Suspense, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../../lib/queryKeys";
import { projectMindApi } from "../../services/projectMindApi";
import { useAgentPanelStore } from "../../state/agent-panel-store";
const AgentPanel = lazy(() => import("./AgentPanel").then(module => ({ default: module.AgentPanel })));

export function AgentWorkspacePanel({ workspaceRoot, workspaceName }: { workspaceRoot?: string; workspaceName?: string }) {
  const { binding, open, expanded, closePanel, toggleExpanded, clearWorkspace } = useAgentPanelStore();
  const current = !!binding && binding.workspaceRoot === workspaceRoot;
  const projectId = current && binding.scope.kind === "project" ? binding.scope.projectId : null;
  const projects = useQuery({ queryKey: queryKeys.projects.all,
    queryFn: () => projectMindApi.projectsList({ includeArchived: true }), enabled: current && open && projectId !== null });
  useEffect(() => { if (binding && !current) clearWorkspace(); }, [binding, current, clearWorkspace]);
  if (!binding || !current) return null;
  const identity = `${binding.workspaceRoot}:${binding.scope.kind === "project" ? binding.scope.projectId : "workspace"}`;
  return <aside className="agent-workspace-panel" hidden={!open} aria-label="助手会话">
    <Suspense fallback={<p className="agent-panel__empty" role="status">正在加载助手…</p>}>
    <AgentPanel key={identity} open={open} scope={binding.scope} workspaceRoot={binding.workspaceRoot}
      scopeName={projectId !== null ? projects.data?.find(project => project.id === projectId)?.name ?? `项目 ${projectId}` : workspaceName ?? "工作区"}
      expanded={expanded} onToggleExpanded={toggleExpanded} onClose={closePanel} />
    </Suspense>
  </aside>;
}
