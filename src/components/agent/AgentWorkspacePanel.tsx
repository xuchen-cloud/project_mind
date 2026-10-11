import { lazy, Suspense, useEffect, useRef } from "react";
import { useAgentPanelStore } from "../../state/agent-panel-store";
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
    if (open && currentProjectId !== null && (binding.scope.kind !== "project" || binding.scope.projectId !== currentProjectId)) {
      openPanel(binding.workspaceRoot, { kind: "project", projectId: currentProjectId });
    }
    if (discussionTarget && (currentProjectId === null || discussionTarget.object.scope.kind !== "project"
      || discussionTarget.object.scope.projectId !== currentProjectId)) clearDiscussionTarget();
  }, [binding, current, open, currentProjectId, discussionTarget, openPanel, clearDiscussionTarget]);
  if (!binding || !current || binding.scope.kind !== "project") return null;
  const projectId = binding.scope.projectId;
  const visible = open && projectId === currentProjectId;
  // A project owns its DSH history. Closing preserves that project's shell;
  // switching project remounts it and native start selects its own runtime.
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
