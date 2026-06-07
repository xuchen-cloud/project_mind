import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";

export type SettingsSection = "file-tags" | "record-types" | "contacts" | "ai" | "rich-text";

export const UI_STORE_STORAGE_KEY = "project-mind-ui";
export const ACTIVITY_NOTE_EDITOR_WIDTH_DEFAULT_PX = 880;
export const ACTIVITY_NOTE_EDITOR_WIDTH_MIN_PX = 720;
export const ACTIVITY_NOTE_EDITOR_WIDTH_MAX_PX = 1080;
export const PROJECT_SIDEBAR_WIDTH_DEFAULT_PX = 288;
export const PROJECT_SIDEBAR_WIDTH_MIN_PX = 260;
export const PROJECT_SIDEBAR_WIDTH_MAX_PX = 480;
export const PROJECT_SIDEBAR_COLLAPSED_WIDTH_PX = 48;
export const TODO_RAIL_WIDTH_DEFAULT_PX = 352;
export const TODO_RAIL_WIDTH_MIN_PX = 280;
export const TODO_RAIL_WIDTH_MAX_PX = 560;
export const TODO_RAIL_COLLAPSED_WIDTH_PX = 48;
export const WORKSPACE_MAIN_CONTENT_MIN_WIDTH_PX = 640;
export const WORKSPACE_WINDOW_MIN_WIDTH_DEFAULT_PX =
  PROJECT_SIDEBAR_WIDTH_MIN_PX +
  WORKSPACE_MAIN_CONTENT_MIN_WIDTH_PX +
  TODO_RAIL_WIDTH_MIN_PX;
export const WORKSPACE_WINDOW_MIN_HEIGHT_PX = 760;
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
  openProjectIds: number[];
  projectRecentPaths: Record<number, string>;
  activityNoteEditorWidthPx: number;
  overviewPageWidth: "auto" | "wide" | "full";
  todoRailWidthPx: number;
  projectSidebarWidthPx: number;
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
  setOverviewPageWidth: (width: "auto" | "wide" | "full") => void;
  setTodoRailWidthPx: (width: number) => void;
  setProjectSidebarWidthPx: (width: number) => void;
  setActivityNoteEditorWidthPx: (width: number) => void;
  resetActivityNoteEditorWidthPx: () => void;
  openProjectTab: (projectId: number) => void;
  closeProjectTab: (projectId: number) => void;
  rememberProjectRoute: (projectId: number, path: string) => void;
  clearProjectRecentPaths: () => void;
  toggleProjectSidebarCollapsed: () => void;
  toggleTodoRailCollapsed: () => void;
}

function sanitizeProjectRoute(path: string) {
  const match = path.match(/^\/projects\/(\d+)(?:\/activities\/\d+)?(?:\?.*)?$/);
  if (!match) {
    return path;
  }

  return `/projects/${match[1]}`;
}

export function createUiStoreState(): UiStoreState {
  return {
    createProjectOpen: false,
    createActivityOpen: false,
    settingsOpen: false,
    settingsSection: "file-tags",
    projectComposer: null,
    projectSidebarCollapsed: false,
    todoRailCollapsed: false,
    openProjectIds: [],
    projectRecentPaths: {},
    activityNoteEditorWidthPx: ACTIVITY_NOTE_EDITOR_WIDTH_DEFAULT_PX,
    overviewPageWidth: "auto",
    todoRailWidthPx: TODO_RAIL_WIDTH_DEFAULT_PX,
    projectSidebarWidthPx: PROJECT_SIDEBAR_WIDTH_DEFAULT_PX,
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
  overviewPageWidth: "auto" | "wide" | "full";
  todoRailWidthPx: number;
  projectSidebarWidthPx: number;
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
        openSettings: (settingsSection = "file-tags") => set({ settingsOpen: true, settingsSection }),
        closeSettings: () => set({ settingsOpen: false }),
        setProjectComposer: (projectComposer) => set({ projectComposer }),
        setProjectSidebarCollapsed: (projectSidebarCollapsed) => set({ projectSidebarCollapsed }),
        setTodoRailCollapsed: (todoRailCollapsed) => set({ todoRailCollapsed }),
        setOverviewPageWidth: (overviewPageWidth) => set({ overviewPageWidth }),
        setTodoRailWidthPx: (todoRailWidthPx) =>
          set({
            todoRailWidthPx: Math.max(
              TODO_RAIL_WIDTH_MIN_PX,
              Math.min(TODO_RAIL_WIDTH_MAX_PX, Math.round(todoRailWidthPx)),
            ),
          }),
        setProjectSidebarWidthPx: (projectSidebarWidthPx) =>
          set({
            projectSidebarWidthPx: Math.max(PROJECT_SIDEBAR_WIDTH_MIN_PX, Math.min(PROJECT_SIDEBAR_WIDTH_MAX_PX, Math.round(projectSidebarWidthPx))),
          }),
        setActivityNoteEditorWidthPx: (width) =>
          set({
            activityNoteEditorWidthPx: clampActivityNoteEditorWidthPx(width),
          }),
        resetActivityNoteEditorWidthPx: () =>
          set({
            activityNoteEditorWidthPx: ACTIVITY_NOTE_EDITOR_WIDTH_DEFAULT_PX,
          }),
        openProjectTab: (projectId) =>
          set((state) => ({
            openProjectIds: state.openProjectIds.includes(projectId)
              ? state.openProjectIds
              : [...state.openProjectIds, projectId],
          })),
        closeProjectTab: (projectId) =>
          set((state) => ({
            openProjectIds: state.openProjectIds.filter((id) => id !== projectId),
          })),
        rememberProjectRoute: (projectId, path) =>
          set((state) => ({
            projectRecentPaths:
              state.projectRecentPaths[projectId] === sanitizeProjectRoute(path)
                ? state.projectRecentPaths
                : {
                    ...state.projectRecentPaths,
                    [projectId]: sanitizeProjectRoute(path),
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
          overviewPageWidth: state.overviewPageWidth,
          todoRailWidthPx: state.todoRailWidthPx,
          projectSidebarWidthPx: state.projectSidebarWidthPx,
        }),
      },
    ),
  );

export const useUiStore = createUiStore();
