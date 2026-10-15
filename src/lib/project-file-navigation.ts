import { create } from "zustand";
import type { AgentSourceRef } from "./agent-types";
interface ProjectFileRequest { projectId: number; path: string; line?: number; originSessionId?: string; sourceRef?: AgentSourceRef }
interface ProjectFileNavigation {
  request: ProjectFileRequest | null;
  revisions: Record<number, number>;
  open: (request: ProjectFileRequest) => void;
  close: () => void;
  refresh: (projectId: number) => void;
}
export const useProjectFileNavigation = create<ProjectFileNavigation>(set => ({
  request: null,
  revisions: {},
  open: request => set({ request }),
  close: () => set({ request: null }),
  refresh: projectId => set(state => ({ revisions: { ...state.revisions, [projectId]: (state.revisions[projectId] ?? 0) + 1 } })),
}));
export function openProjectFilePreview(projectId: number, path: string, line?: number, originSessionId?: string, sourceRef?: AgentSourceRef) {
  useProjectFileNavigation.getState().open({ projectId, path, line, originSessionId, sourceRef });
}
export function notifyProjectFilesChanged(projectId: number) {
  useProjectFileNavigation.getState().refresh(projectId);
}

/** Directory entries use slash-separated paths; stored native paths use the host separator. */
export function projectFilePathMatches(managedPath: string, rootPath: string, relativePath: string) {
  return managedPath.replaceAll("\\", "/") === `${rootPath.replaceAll("\\", "/").replace(/\/$/, "")}/${relativePath}`;
}
