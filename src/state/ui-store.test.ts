import { beforeEach, describe, expect, it } from "vitest";

import {
  NOTE_EDITOR_WIDTH_DEFAULT_PX,
  NOTE_EDITOR_WIDTH_MAX_PX,
  NOTE_EDITOR_WIDTH_MIN_PX,
  PROJECT_SIDEBAR_WIDTH_DEFAULT_PX,
  TODO_RAIL_WIDTH_DEFAULT_PX,
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

  it("toggles modal, rail, and sidebar state", () => {
    useUiStore.setState({
      ...createUiStoreState(),
      createProjectOpen: true,
      settingsSection: "ai-models",
    });

    useUiStore.getState().setCreateProjectOpen(false);
    useUiStore.getState().setProjectComposer("todo");
    useUiStore.getState().openSettings("contacts");
    useUiStore.getState().rememberProjectRoute(9, "/projects/9/activities/11?focus=todo-3");
    useUiStore.getState().toggleProjectSidebarCollapsed();
    useUiStore.getState().toggleTodoRailCollapsed();
    useUiStore.getState().closeSettings();
    useUiStore.getState().setSettingsOpen(true);

    const state = useUiStore.getState();
    expect(state.createProjectOpen).toBe(false);
    expect(state.projectComposer).toBe("todo");
    expect(state.settingsOpen).toBe(true);
    expect(state.settingsSection).toBe("contacts");
    expect(state.projectSidebarCollapsed).toBe(true);
    expect(state.todoRailCollapsed).toBe(true);
    expect(state.projectRecentPaths[9]).toBe("/projects/9/activities/11?focus=todo-3");
    expect(state.noteEditorWidthPx).toBe(
      NOTE_EDITOR_WIDTH_DEFAULT_PX,
    );

    useUiStore.getState().clearProjectRecentPaths();
    expect(useUiStore.getState().projectRecentPaths).toEqual({});
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
      },
      version: 1,
    });
  });
});
