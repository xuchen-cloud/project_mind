import { useAgentPanelStore } from "../state/agent-panel-store";
import { create } from "zustand";
import type { AgentSourceRef } from "./agent-types";
interface ProjectFileRequest { workspaceRoot?: string; projectId: number | null; path: string; line?: number; originSessionId?: string; sourceRef?: AgentSourceRef }
interface ProjectFileNavigation {
  request: ProjectFileRequest | null;
  revisions: Record<string, number>;
  open: (request: ProjectFileRequest) => void;
  close: () => void;
  refresh: (projectId: number | null, workspaceRoot?: string) => void;
}
export const useProjectFileNavigation = create<ProjectFileNavigation>(set => ({
  request: null,
  revisions: {},
  open: request => set({ request }),
  close: () => set({ request: null }),
  refresh: (projectId, workspaceRoot) => set(state => { const key = fileNavigationScopeKey(projectId, workspaceRoot); return { revisions: { ...state.revisions, [key]: (state.revisions[key] ?? 0) + 1 } }; }),
}));
export function openProjectFilePreview(projectId: number | null, path: string, line?: number, originSessionId?: string, sourceRef?: AgentSourceRef, workspaceRoot = useAgentPanelStore.getState().workspaceRoot ?? undefined) {
  useProjectFileNavigation.getState().open({ workspaceRoot, projectId, path, line, originSessionId, sourceRef });
}
export function notifyProjectFilesChanged(projectId: number | null, workspaceRoot?: string) {
  useProjectFileNavigation.getState().refresh(projectId, workspaceRoot);
}

/** Directory entries use slash-separated paths; stored native paths use the host separator. */
export function projectFilePathMatches(managedPath: string, rootPath: string, relativePath: string) {
  return managedPath.replaceAll("\\", "/") === `${rootPath.replaceAll("\\", "/").replace(/\/$/, "")}/${relativePath}`;
}

export function fileNavigationScopeKey(projectId: number | null, workspaceRoot = useAgentPanelStore.getState().workspaceRoot ?? "") {
  return JSON.stringify([workspaceRoot, projectId]);
}
