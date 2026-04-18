import { create } from "zustand";

export type SettingsSection = "activity" | "file-tags" | "record-types" | "ai" | "rich-text";

interface UiStore {
  createProjectOpen: boolean;
  createActivityOpen: boolean;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  projectComposer: "conclusion" | "todo" | null;
  projectSidebarCollapsed: boolean;
  todoRailCollapsed: boolean;
  projectRecentPaths: Record<number, string>;
  setCreateProjectOpen: (open: boolean) => void;
  setCreateActivityOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setSettingsSection: (section: SettingsSection) => void;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setProjectComposer: (value: "conclusion" | "todo" | null) => void;
  setProjectSidebarCollapsed: (collapsed: boolean) => void;
  setTodoRailCollapsed: (collapsed: boolean) => void;
  rememberProjectRoute: (projectId: number, path: string) => void;
  clearProjectRecentPaths: () => void;
  toggleProjectSidebarCollapsed: () => void;
  toggleTodoRailCollapsed: () => void;
}

export const useUiStore = create<UiStore>((set) => ({
  createProjectOpen: false,
  createActivityOpen: false,
  settingsOpen: false,
  settingsSection: "activity",
  projectComposer: null,
  projectSidebarCollapsed: false,
  todoRailCollapsed: false,
  projectRecentPaths: {},
  setCreateProjectOpen: (createProjectOpen) => set({ createProjectOpen }),
  setCreateActivityOpen: (createActivityOpen) => set({ createActivityOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  openSettings: (settingsSection = "activity") => set({ settingsOpen: true, settingsSection }),
  closeSettings: () => set({ settingsOpen: false }),
  setProjectComposer: (projectComposer) => set({ projectComposer }),
  setProjectSidebarCollapsed: (projectSidebarCollapsed) => set({ projectSidebarCollapsed }),
  setTodoRailCollapsed: (todoRailCollapsed) => set({ todoRailCollapsed }),
  rememberProjectRoute: (projectId, path) =>
    set((state) => ({
      projectRecentPaths:
        state.projectRecentPaths[projectId] === path
          ? state.projectRecentPaths
          : {
              ...state.projectRecentPaths,
              [projectId]: path,
            },
    })),
  clearProjectRecentPaths: () => set({ projectRecentPaths: {} }),
  toggleProjectSidebarCollapsed: () =>
    set((state) => ({ projectSidebarCollapsed: !state.projectSidebarCollapsed })),
  toggleTodoRailCollapsed: () =>
    set((state) => ({ todoRailCollapsed: !state.todoRailCollapsed })),
}));
