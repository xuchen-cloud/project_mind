import { beforeEach, describe, expect, it } from "vitest";

import {
  NOTE_EDITOR_WIDTH_DEFAULT_PX,
  NOTE_EDITOR_WIDTH_MAX_PX,
  NOTE_EDITOR_WIDTH_MIN_PX,
  PROJECT_SIDEBAR_WIDTH_DEFAULT_PX,
  TODO_RAIL_WIDTH_DEFAULT_PX,
  WORKSPACE_MAIN_CONTENT_MIN_WIDTH_PX,
  WORKSPACE_WINDOW_MIN_WIDTH_DEFAULT_PX,
  createUiStore,
  createUiStoreState,
  UI_STORE_STORAGE_KEY,
  uiStorePersistStorage,
  useUiStore,
} from "./ui-store";

describe("useUiStore", () => {
  beforeEach(() => {
    useUiStore.persist.clearStorage();
    useUiStore.setState(createUiStoreState());
  });

  it("defaults the todo rail to floating without changing its collapse default", () => {
    useUiStore.persist.clearStorage();
    const store = createUiStore();

    expect(createUiStoreState().todoRailMode).toBe("floating");
    expect(store.getState().todoRailMode).toBe("floating");
    expect(store.getState().todoRailCollapsed).toBe(false);
  });

  it("switches todo rail modes independently of collapse state", () => {
    useUiStore.getState().setTodoRailMode("pinned");
    expect(useUiStore.getState().todoRailMode).toBe("pinned");
    expect(useUiStore.getState().todoRailCollapsed).toBe(false);

    useUiStore.getState().setTodoRailCollapsed(true);
    useUiStore.getState().setTodoRailMode("floating");
    expect(useUiStore.getState().todoRailMode).toBe("floating");
    expect(useUiStore.getState().todoRailCollapsed).toBe(true);
  });

  it.each(["pinned", "floating"] as const)(
    "rehydrates the %s todo rail mode in a fresh store",
    async (mode) => {
      useUiStore.getState().setTodoRailMode("pinned");
      useUiStore.getState().setTodoRailMode(mode);

      const store = createUiStore();
      await store.persist.rehydrate();

      expect(store.getState().todoRailMode).toBe(mode);
    },
  );

  it("migrates older v1 preferences to floating while preserving saved preferences", async () => {
    const preferences = {
      noteEditorWidthPx: 960,
      pageWidthMode: "wide" as const,
      todoRailWidthPx: 360,
      projectSidebarWidthPx: 320,
      projectSidebarCollapsed: true,
      todoRailCollapsed: true,
      projectTodoViewMode: "workspace" as const,
    };
    await uiStorePersistStorage?.setItem(UI_STORE_STORAGE_KEY, {
      state: preferences,
      version: 1,
    });

    const store = createUiStore();
    await store.persist.rehydrate();

    expect(store.getState()).toMatchObject({
      ...preferences,
      todoRailMode: "floating",
    });
    expect(await uiStorePersistStorage?.getItem(UI_STORE_STORAGE_KEY)).toEqual({
      state: { ...preferences, todoRailMode: "floating" },
      version: 2,
    });
  });

  it("preserves the main editor minimum width at the 1180px desktop seam", () => {
    expect(
      PROJECT_SIDEBAR_WIDTH_DEFAULT_PX +
        WORKSPACE_MAIN_CONTENT_MIN_WIDTH_PX +
        TODO_RAIL_WIDTH_DEFAULT_PX,
    ).toBeLessThanOrEqual(WORKSPACE_WINDOW_MIN_WIDTH_DEFAULT_PX);
  });

  it("toggles modal, rail, and sidebar state", () => {
    useUiStore.setState({
      ...createUiStoreState(),
      createProjectOpen: true,
      settingsSection: "ai-models",
    });

    useUiStore.getState().setCreateProjectOpen(false);
    useUiStore.getState().setProjectComposer("todo");
    useUiStore.getState().setWorkspaceSidebarTab("records");
    useUiStore.getState().setWorkspaceProjectQuery("alpha");
    useUiStore.getState().setProjectSidebarTab("files");
    useUiStore.getState().setProjectFileQuery(9, "brief");
    useUiStore.getState().setProjectDocumentTagId(9, 3);
    useUiStore.getState().setTodoRailTab("finished");
    useUiStore.getState().setTodoRailSortMode("priority");
    useUiStore.getState().setProjectTodoViewMode("workspace");
    useUiStore.getState().openProjectTab(9);
    useUiStore.getState().openSettings("contacts");
    useUiStore.getState().rememberProjectRoute(9, "/projects/9?focus=record-11");
    useUiStore.getState().toggleProjectSidebarCollapsed();
    useUiStore.getState().toggleTodoRailCollapsed();
    useUiStore.getState().closeSettings();
    useUiStore.getState().setSettingsOpen(true);

    const state = useUiStore.getState();
    expect(state.createProjectOpen).toBe(false);
    expect(state.projectComposer).toBe("todo");
    expect(state.workspaceSidebarTab).toBe("records");
    expect(state.workspaceProjectQuery).toBe("alpha");
    expect(state.projectSidebarTab).toBe("files");
    expect(state.projectFileFilters[9]).toEqual({ query: "brief", tagId: 3 });
    expect(state.todoRailTab).toBe("finished");
    expect(state.todoRailSortMode).toBe("priority");
    expect(state.projectTodoViewMode).toBe("workspace");
    expect(state.settingsOpen).toBe(true);
    expect(state.openProjectIds).toEqual([9]);
    expect(state.settingsSection).toBe("contacts");
    expect(state.projectSidebarCollapsed).toBe(true);
    expect(state.todoRailCollapsed).toBe(true);
    expect(state.projectRecentPaths[9]).toBe("/projects/9?focus=record-11");
    expect(state.noteEditorWidthPx).toBe(
      NOTE_EDITOR_WIDTH_DEFAULT_PX,
    );

    useUiStore.getState().clearProjectRecentPaths();
    expect(useUiStore.getState().projectRecentPaths).toEqual({});
    useUiStore.getState().rememberProjectRoute(9, "/projects/9?focus=record-12");

    useUiStore.getState().clearWorkspaceScopedUiState();
    expect(useUiStore.getState().projectFileFilters).toEqual({});
    expect(useUiStore.getState().workspaceProjectQuery).toBe("");
    expect(useUiStore.getState().openProjectIds).toEqual([]);
    expect(useUiStore.getState().projectRecentPaths).toEqual({});
    expect(useUiStore.getState().settingsOpen).toBe(false);
    expect(useUiStore.getState().settingsProjectId).toBeNull();
    expect(useUiStore.getState().projectComposer).toBeNull();
  });

  it("clamps the persisted note editor width preference", () => {
    expect(useUiStore.getState().noteEditorWidthPx).toBe(
      NOTE_EDITOR_WIDTH_DEFAULT_PX,
    );

    useUiStore.getState().setNoteEditorWidthPx(600);
    expect(useUiStore.getState().noteEditorWidthPx).toBe(
      NOTE_EDITOR_WIDTH_MIN_PX,
    );

    useUiStore.getState().setNoteEditorWidthPx(2048);
    expect(useUiStore.getState().noteEditorWidthPx).toBe(
      NOTE_EDITOR_WIDTH_MAX_PX,
    );
  });

  it("rehydrates the note editor width from persisted storage only", async () => {
    useUiStore.getState().setCreateProjectOpen(true);
    useUiStore.getState().setNoteEditorWidthPx(960);

    const persistedStore = createUiStore();
    await persistedStore.persist.rehydrate();

    expect(persistedStore.getState().noteEditorWidthPx).toBe(960);
    expect(persistedStore.getState().createProjectOpen).toBe(false);

    expect(uiStorePersistStorage?.getItem(UI_STORE_STORAGE_KEY)).toEqual({
      state: {
        noteEditorWidthPx: 960,
        pageWidthMode: "adaptive",
        todoRailWidthPx: TODO_RAIL_WIDTH_DEFAULT_PX,
        projectSidebarWidthPx: PROJECT_SIDEBAR_WIDTH_DEFAULT_PX,
        projectSidebarCollapsed: false,
        todoRailCollapsed: false,
        todoRailMode: "floating",
        projectTodoViewMode: "current-project",
      },
      version: 2,
    });
  });
});
