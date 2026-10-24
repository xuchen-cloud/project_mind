import { lazy, Suspense, useEffect, useRef } from "react";
import { canDiscussObject, useAgentPanelStore } from "../../state/agent-panel-store";
import { openProjectContent } from "../../services/projectContentApi";
import { useFeedbackStore } from "../../state/feedback-store";

const DshAssistantPanel = lazy(() => import("./DshAssistantPanel").then(module => ({ default: module.DshAssistantPanel })));

export function AgentWorkspacePanel({ workspaceRoot, currentProjectId }: { workspaceRoot?: string; workspaceName?: string; currentProjectId: number | null }) {
  const { binding, open, expanded, discussionTarget, closePanel, toggleExpanded, clearWorkspace, openPanel, clearDiscussionTarget } = useAgentPanelStore();
  const current = !!binding && binding.workspaceRoot === workspaceRoot;
  const sessionOpen = useRef<AbortController | null>(null);
  useEffect(() => () => { sessionOpen.current?.abort(); }, [workspaceRoot, currentProjectId, open]);
  useEffect(() => { if (binding && !current) clearWorkspace(); }, [binding, current, clearWorkspace]);
  useEffect(() => {
    if (!binding || !current) return;
    if (open && (binding.scope.kind === "project" ? binding.scope.projectId : null) !== currentProjectId) {
      openPanel(binding.workspaceRoot, currentProjectId === null ? { kind: "workspace" } : { kind: "project", projectId: currentProjectId });
    }
    const scope = currentProjectId === null ? { kind: "workspace" as const } : { kind: "project" as const, projectId: currentProjectId };
    if (discussionTarget && !canDiscussObject(scope, discussionTarget.object.scope)) clearDiscussionTarget();
  }, [binding, current, open, currentProjectId, discussionTarget, openPanel, clearDiscussionTarget]);
  if (!binding || !current) return null;
  const projectId = binding.scope.kind === "project" ? binding.scope.projectId : null;
  const visible = open && projectId === currentProjectId;
  return <aside className="agent-workspace-panel" hidden={!visible} aria-label="DSH 助手">
    <Suspense fallback={<p role="status">正在加载 DSH 助手…</p>}>
    <DshAssistantPanel key={`${binding.workspaceRoot}:${projectId}`} projectId={projectId} open={visible} expanded={expanded} workspaceRoot={workspaceRoot}
      onToggleExpanded={toggleExpanded} onClose={closePanel} onOpenSession={(sessionId, title) => {
        sessionOpen.current?.abort();
        const controller = new AbortController(); sessionOpen.current = controller;
        void openProjectContent({ workspaceRoot: binding.workspaceRoot, projectId, object: { kind: "session", id: sessionId, title }, signal: controller.signal })
          .then(closePanel, reason => { if (!controller.signal.aborted) useFeedbackStore.getState().pushToast({ tone: "error", title: "无法打开会话", detail: String(reason) }); });
      }} />
    </Suspense>
  </aside>;
}
