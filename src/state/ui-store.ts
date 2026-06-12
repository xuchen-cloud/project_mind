import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";

export type SettingsSection =
  | "page-width"
  | "file-tags"
  | "contacts"
  | "ai"
  | "rich-text";
export type PageWidthMode = "adaptive" | "narrow" | "wide" | "full";

export const UI_STORE_STORAGE_KEY = "project-mind-ui";
export const NOTE_EDITOR_WIDTH_DEFAULT_PX = 880;
export const NOTE_EDITOR_WIDTH_MIN_PX = 720;
export const NOTE_EDITOR_WIDTH_MAX_PX = 1080;
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

export function clampNoteEditorWidthPx(width: number) {
  return Math.min(
    NOTE_EDITOR_WIDTH_MAX_PX,
    Math.max(NOTE_EDITOR_WIDTH_MIN_PX, Math.round(width)),
  );
}

interface UiStoreState {
  createProjectOpen: boolean;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  settingsProjectId: number | null;
  projectComposer: "conclusion" | "todo" | null;
  projectSidebarCollapsed: boolean;
  todoRailCollapsed: boolean;
  openProjectIds: number[];
  projectRecentPaths: Record<number, string>;
  noteEditorWidthPx: number;
  pageWidthMode: PageWidthMode;
  todoRailWidthPx: number;
  projectSidebarWidthPx: number;
}

interface UiStore extends UiStoreState {
  setCreateProjectOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setSettingsSection: (section: SettingsSection) => void;
  setSettingsProjectId: (projectId: number | null) => void;
  openSettings: (section?: SettingsSection, projectId?: number | null) => void;
  closeSettings: () => void;
  setProjectComposer: (value: "conclusion" | "todo" | null) => void;
  setProjectSidebarCollapsed: (collapsed: boolean) => void;
  setTodoRailCollapsed: (collapsed: boolean) => void;
  setPageWidthMode: (width: PageWidthMode) => void;
  setTodoRailWidthPx: (width: number) => void;
  setProjectSidebarWidthPx: (width: number) => void;
  setNoteEditorWidthPx: (width: number) => void;
  resetNoteEditorWidthPx: () => void;
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
    settingsOpen: false,
    settingsSection: "page-width",
    settingsProjectId: null,
    projectComposer: null,
    projectSidebarCollapsed: false,
    todoRailCollapsed: false,
    openProjectIds: [],
    projectRecentPaths: {},
    noteEditorWidthPx: NOTE_EDITOR_WIDTH_DEFAULT_PX,
    pageWidthMode: "adaptive",
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
  noteEditorWidthPx: number;
  pageWidthMode?: PageWidthMode;
  overviewPageWidth?: "auto" | "wide" | "full";
  todoRailWidthPx: number;
  projectSidebarWidthPx: number;
  projectSidebarCollapsed?: boolean;
  todoRailCollapsed?: boolean;
}>(createUiStorePersistStorage);

export const createUiStore = () =>
  create<UiStore>()(
    persist(
      (set) => ({
        ...createUiStoreState(),
        setCreateProjectOpen: (createProjectOpen) => set({ createProjectOpen }),
        setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
        setSettingsSection: (settingsSection) => set({ settingsSection }),
        setSettingsProjectId: (settingsProjectId) => set({ settingsProjectId }),
        openSettings: (settingsSection = "page-width", settingsProjectId = null) =>
          set({ settingsOpen: true, settingsSection, settingsProjectId }),
        closeSettings: () => set({ settingsOpen: false, settingsProjectId: null }),
        setProjectComposer: (projectComposer) => set({ projectComposer }),
        setProjectSidebarCollapsed: (projectSidebarCollapsed) => set({ projectSidebarCollapsed }),
        setTodoRailCollapsed: (todoRailCollapsed) => set({ todoRailCollapsed }),
        setPageWidthMode: (pageWidthMode) => set({ pageWidthMode }),
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
        setNoteEditorWidthPx: (width) =>
          set({
            noteEditorWidthPx: clampNoteEditorWidthPx(width),
          }),
        resetNoteEditorWidthPx: () =>
          set({
            noteEditorWidthPx: NOTE_EDITOR_WIDTH_DEFAULT_PX,
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
        version: 1,
        storage: uiStorePersistStorage,
        migrate: (persistedState) => {
          const state = persistedState as
            | {
                noteEditorWidthPx?: number;
                pageWidthMode?: PageWidthMode;
                overviewPageWidth?: "auto" | "wide" | "full";
                todoRailWidthPx?: number;
                projectSidebarWidthPx?: number;
                projectSidebarCollapsed?: boolean;
                todoRailCollapsed?: boolean;
              }
            | undefined;

          const legacyWidth = state?.overviewPageWidth;
          const pageWidthMode =
            state?.pageWidthMode ??
            (legacyWidth === "full"
              ? "full"
              : legacyWidth === "wide"
                ? "wide"
                : "adaptive");

          return {
            noteEditorWidthPx: state?.noteEditorWidthPx ?? NOTE_EDITOR_WIDTH_DEFAULT_PX,
            pageWidthMode,
            todoRailWidthPx: state?.todoRailWidthPx ?? TODO_RAIL_WIDTH_DEFAULT_PX,
            projectSidebarWidthPx:
              state?.projectSidebarWidthPx ?? PROJECT_SIDEBAR_WIDTH_DEFAULT_PX,
            projectSidebarCollapsed: state?.projectSidebarCollapsed ?? false,
            todoRailCollapsed: state?.todoRailCollapsed ?? false,
          };
        },
        partialize: (state) => ({
          noteEditorWidthPx: state.noteEditorWidthPx,
          pageWidthMode: state.pageWidthMode,
          todoRailWidthPx: state.todoRailWidthPx,
          projectSidebarWidthPx: state.projectSidebarWidthPx,
          projectSidebarCollapsed: state.projectSidebarCollapsed,
          todoRailCollapsed: state.todoRailCollapsed,
        }),
      },
    ),
  );

export const useUiStore = createUiStore();
