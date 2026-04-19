import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";

export type SettingsSection = "activity" | "file-tags" | "record-types" | "ai" | "rich-text";

export const UI_STORE_STORAGE_KEY = "project-mind-ui";
export const ACTIVITY_NOTE_EDITOR_WIDTH_DEFAULT_PX = 880;
export const ACTIVITY_NOTE_EDITOR_WIDTH_MIN_PX = 720;
export const ACTIVITY_NOTE_EDITOR_WIDTH_MAX_PX = 1080;
const fallbackUiStoreStorage = new Map<string, string>();

export function clampActivityNoteEditorWidthPx(width: number) {
  return Math.min(
    ACTIVITY_NOTE_EDITOR_WIDTH_MAX_PX,
    Math.max(ACTIVITY_NOTE_EDITOR_WIDTH_MIN_PX, Math.round(width)),
  );
}

interface UiStoreState {
  createProjectOpen: boolean;
  createActivityOpen: boolean;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  projectComposer: "conclusion" | "todo" | null;
  projectSidebarCollapsed: boolean;
  todoRailCollapsed: boolean;
  projectRecentPaths: Record<number, string>;
  activityNoteEditorWidthPx: number;
}

interface UiStore extends UiStoreState {
  setCreateProjectOpen: (open: boolean) => void;
  setCreateActivityOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setSettingsSection: (section: SettingsSection) => void;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setProjectComposer: (value: "conclusion" | "todo" | null) => void;
  setProjectSidebarCollapsed: (collapsed: boolean) => void;
  setTodoRailCollapsed: (collapsed: boolean) => void;
  setActivityNoteEditorWidthPx: (width: number) => void;
  resetActivityNoteEditorWidthPx: () => void;
  rememberProjectRoute: (projectId: number, path: string) => void;
  clearProjectRecentPaths: () => void;
  toggleProjectSidebarCollapsed: () => void;
  toggleTodoRailCollapsed: () => void;
}

export function createUiStoreState(): UiStoreState {
  return {
    createProjectOpen: false,
    createActivityOpen: false,
    settingsOpen: false,
    settingsSection: "activity",
    projectComposer: null,
    projectSidebarCollapsed: false,
    todoRailCollapsed: false,
    projectRecentPaths: {},
    activityNoteEditorWidthPx: ACTIVITY_NOTE_EDITOR_WIDTH_DEFAULT_PX,
  };
}

function createUiStorePersistStorage(): StateStorage {
  if (typeof window !== "undefined") {
    const browserStorage = window.localStorage as Partial<Storage> | undefined;

    if (
      browserStorage &&
      typeof browserStorage.getItem === "function" &&
      typeof browserStorage.setItem === "function" &&
      typeof browserStorage.removeItem === "function"
    ) {
      return browserStorage as Storage;
    }
  }

  return {
    getItem: (name) => fallbackUiStoreStorage.get(name) ?? null,
    setItem: (name, value) => {
      fallbackUiStoreStorage.set(name, value);
    },
    removeItem: (name) => {
      fallbackUiStoreStorage.delete(name);
    },
  };
}

export const uiStorePersistStorage = createJSONStorage<{
  activityNoteEditorWidthPx: number;
}>(createUiStorePersistStorage);

export const createUiStore = () =>
  create<UiStore>()(
    persist(
      (set) => ({
        ...createUiStoreState(),
        setCreateProjectOpen: (createProjectOpen) => set({ createProjectOpen }),
        setCreateActivityOpen: (createActivityOpen) => set({ createActivityOpen }),
        setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
        setSettingsSection: (settingsSection) => set({ settingsSection }),
        openSettings: (settingsSection = "activity") => set({ settingsOpen: true, settingsSection }),
        closeSettings: () => set({ settingsOpen: false }),
        setProjectComposer: (projectComposer) => set({ projectComposer }),
        setProjectSidebarCollapsed: (projectSidebarCollapsed) => set({ projectSidebarCollapsed }),
        setTodoRailCollapsed: (todoRailCollapsed) => set({ todoRailCollapsed }),
        setActivityNoteEditorWidthPx: (width) =>
          set({
            activityNoteEditorWidthPx: clampActivityNoteEditorWidthPx(width),
          }),
        resetActivityNoteEditorWidthPx: () =>
          set({
            activityNoteEditorWidthPx: ACTIVITY_NOTE_EDITOR_WIDTH_DEFAULT_PX,
          }),
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
      }),
      {
        name: UI_STORE_STORAGE_KEY,
        storage: uiStorePersistStorage,
        partialize: (state) => ({
          activityNoteEditorWidthPx: state.activityNoteEditorWidthPx,
        }),
      },
    ),
  );

export const useUiStore = createUiStore();
