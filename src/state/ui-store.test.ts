import { beforeEach, describe, expect, it } from "vitest";

import {
  ACTIVITY_NOTE_EDITOR_WIDTH_DEFAULT_PX,
  ACTIVITY_NOTE_EDITOR_WIDTH_MAX_PX,
  ACTIVITY_NOTE_EDITOR_WIDTH_MIN_PX,
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
      settingsSection: "ai",
    });

    useUiStore.getState().setCreateProjectOpen(false);
    useUiStore.getState().setCreateActivityOpen(true);
    useUiStore.getState().openSettings("record-types");
    useUiStore.getState().rememberProjectRoute(9, "/projects/9/activities/11?focus=todo-3");
    useUiStore.getState().toggleProjectSidebarCollapsed();
    useUiStore.getState().toggleTodoRailCollapsed();
    useUiStore.getState().closeSettings();
    useUiStore.getState().setSettingsOpen(true);

    const state = useUiStore.getState();
    expect(state.createProjectOpen).toBe(false);
    expect(state.createActivityOpen).toBe(true);
    expect(state.settingsOpen).toBe(true);
    expect(state.settingsSection).toBe("record-types");
    expect(state.projectSidebarCollapsed).toBe(true);
    expect(state.todoRailCollapsed).toBe(true);
    expect(state.projectRecentPaths[9]).toBe("/projects/9/activities/11?focus=todo-3");
    expect(state.activityNoteEditorWidthPx).toBe(
      ACTIVITY_NOTE_EDITOR_WIDTH_DEFAULT_PX,
    );

    useUiStore.getState().clearProjectRecentPaths();
    expect(useUiStore.getState().projectRecentPaths).toEqual({});
  });

  it("clamps the persisted activity note editor width preference", () => {
    expect(useUiStore.getState().activityNoteEditorWidthPx).toBe(
      ACTIVITY_NOTE_EDITOR_WIDTH_DEFAULT_PX,
    );

    useUiStore.getState().setActivityNoteEditorWidthPx(600);
    expect(useUiStore.getState().activityNoteEditorWidthPx).toBe(
      ACTIVITY_NOTE_EDITOR_WIDTH_MIN_PX,
    );

    useUiStore.getState().setActivityNoteEditorWidthPx(2048);
    expect(useUiStore.getState().activityNoteEditorWidthPx).toBe(
      ACTIVITY_NOTE_EDITOR_WIDTH_MAX_PX,
    );
  });

  it("rehydrates the activity note editor width from persisted storage only", async () => {
    useUiStore.getState().setCreateProjectOpen(true);
    useUiStore.getState().setActivityNoteEditorWidthPx(960);

    const persistedStore = createUiStore();
    await persistedStore.persist.rehydrate();

    expect(persistedStore.getState().activityNoteEditorWidthPx).toBe(960);
    expect(persistedStore.getState().createProjectOpen).toBe(false);

    expect(uiStorePersistStorage?.getItem(UI_STORE_STORAGE_KEY)).toEqual({
      state: {
        activityNoteEditorWidthPx: 960,
      },
      version: 0,
    });
  });
});
