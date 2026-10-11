import { create } from "zustand";
import type { AgentSourceRef } from './agent-types';
import { useAgentPanelStore } from "../state/agent-panel-store";
import { useFeedbackStore } from "../state/feedback-store";

export const DSH_BUSY_MESSAGE = "助手仍在后台执行。关闭或切换工作区将停止所有项目任务。";
export function showDshBusyFeedback() {
  useFeedbackStore.getState().setStatus({ tone: "warning", label: "助手正在执行", message: DSH_BUSY_MESSAGE });
  useFeedbackStore.getState().pushToast({ tone: "info", title: "助手正在执行", detail: DSH_BUSY_MESSAGE });
}
// Project runtimes are independent; changing the visible Project cannot stop a run.
export function blocksDshProjectNavigation(_runningProjectId: number | null, _pathname: string) {
  return false;
}
interface FileReference { id: number; workspaceRoot: string; projectId: number; sessionId?: string; path: string; sourceRef?: AgentSourceRef }
let sequence = 0;
export const useDshFileReferences = create<{
  workspaceRoot: string | null; pending: FileReference[];
}>(() => ({ workspaceRoot: null, pending: [] }));

export function setDshWorkspaceRoot(workspaceRoot: string | null) {
  if (useDshFileReferences.getState().workspaceRoot !== workspaceRoot) {
    window.dispatchEvent(new Event('mind:dsh-workspace-close'));
    useDshFileReferences.setState({ workspaceRoot, pending: [] });
    useAgentPanelStore.getState().bindWorkspace(workspaceRoot);
  }
}
export function requestDshFileReference(projectId: number, path: string, sessionId?: string, sourceRef?: AgentSourceRef): void {
  const workspaceRoot = useDshFileReferences.getState().workspaceRoot;
  if (!workspaceRoot) {
    useFeedbackStore.getState().pushToast({ tone: "error", title: "无法引用文件", detail: "请先打开工作区并进入项目" });
    return;
  }
  if (sessionId === undefined) {
    useAgentPanelStore.getState().openPanel(workspaceRoot, { kind: "project", projectId });
    const binding = useAgentPanelStore.getState().binding;
    if (binding?.workspaceRoot !== workspaceRoot || binding.scope.kind !== "project" || binding.scope.projectId !== projectId) return;
  }
  useDshFileReferences.setState(state => ({ pending: [...state.pending, { id: ++sequence, workspaceRoot, projectId, sessionId, path, sourceRef }] }));
}
export function consumeDshFileReference(id: number) {
  useDshFileReferences.setState(state => ({ pending: state.pending.filter(value => value.id !== id) }));
}

/** Catalog facts keep updating after the last content page is unmounted. */
window.addEventListener('mind:dsh-project-busy', event => {
  const workspaceRoot = useDshFileReferences.getState().workspaceRoot;
  if (!workspaceRoot) return;
  const { projectId, busy } = (event as CustomEvent<{ projectId: number; busy: boolean }>).detail;
  useAgentPanelStore.getState().setRunBusy(workspaceRoot, projectId, busy);
});
