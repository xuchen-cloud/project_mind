import { create } from "zustand";
import { useAgentPanelStore } from "../state/agent-panel-store";
import { useFeedbackStore } from "../state/feedback-store";

export const DSH_BUSY_MESSAGE = "助手正在执行，请先在会话中停止任务，再切换项目或工作区。";
export function showDshBusyFeedback() {
  useFeedbackStore.getState().setStatus({ tone: "warning", label: "助手正在执行", message: DSH_BUSY_MESSAGE });
  useFeedbackStore.getState().pushToast({ tone: "info", title: "助手正在执行", detail: DSH_BUSY_MESSAGE });
}
export function blocksDshProjectNavigation(runningProjectId: number | null, pathname: string) {
  if (runningProjectId === null) return false;
  const project = pathname.match(/^\/projects\/(\d+)(?:\/|$)/u)?.[1];
  return project === undefined || Number(project) !== runningProjectId;
}
interface FileReference { id: number; workspaceRoot: string; projectId: number; path: string }
let sequence = 0;
export const useDshFileReferences = create<{
  workspaceRoot: string | null; pending: FileReference[];
}>(() => ({ workspaceRoot: null, pending: [] }));

export function setDshWorkspaceRoot(workspaceRoot: string | null) {
  if (useDshFileReferences.getState().workspaceRoot !== workspaceRoot)
    useDshFileReferences.setState({ workspaceRoot, pending: [] });
}
export function requestDshFileReference(projectId: number, path: string): void {
  const workspaceRoot = useDshFileReferences.getState().workspaceRoot;
  if (!workspaceRoot) {
    useFeedbackStore.getState().pushToast({ tone: "error", title: "无法引用文件", detail: "请先打开工作区并进入项目" });
    return;
  }
  useAgentPanelStore.getState().openPanel(workspaceRoot, { kind: "project", projectId });
  const binding = useAgentPanelStore.getState().binding;
  if (binding?.workspaceRoot !== workspaceRoot || binding.scope.kind !== "project" || binding.scope.projectId !== projectId) return;
  useDshFileReferences.setState(state => ({ pending: [...state.pending, { id: ++sequence, workspaceRoot, projectId, path }] }));
}
export function consumeDshFileReference(id: number) {
  useDshFileReferences.setState(state => ({ pending: state.pending.filter(value => value.id !== id) }));
}
