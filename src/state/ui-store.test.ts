import { describe, expect, it } from "vitest";

import { useUiStore } from "./ui-store";

describe("useUiStore", () => {
  it("toggles modal, rail, and sidebar state", () => {
    useUiStore.setState({
      createProjectOpen: true,
      createActivityOpen: false,
      settingsOpen: false,
      settingsSection: "ai",
      projectComposer: null,
      projectSidebarCollapsed: false,
      todoRailCollapsed: false,
    });

    useUiStore.getState().setCreateProjectOpen(false);
    useUiStore.getState().setCreateActivityOpen(true);
    useUiStore.getState().openSettings("record-types");
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
  });
});
