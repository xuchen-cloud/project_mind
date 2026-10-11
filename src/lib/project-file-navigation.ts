import { create } from "zustand";
interface ProjectFileRequest { projectId: number; path: string; line?: number }
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
export function openProjectFilePreview(projectId: number, path: string, line?: number) {
  useProjectFileNavigation.getState().open({ projectId, path, line });
}
export function notifyProjectFilesChanged(projectId: number) {
  useProjectFileNavigation.getState().refresh(projectId);
}
