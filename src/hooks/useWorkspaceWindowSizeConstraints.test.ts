import { describe, expect, it } from "vitest";

import {
  PROJECT_SIDEBAR_WIDTH_MIN_PX,
  TODO_RAIL_WIDTH_MIN_PX,
  WORKSPACE_MAIN_CONTENT_MIN_WIDTH_PX,
  WORKSPACE_WINDOW_MIN_WIDTH_DEFAULT_PX,
} from "../state/ui-store";
import { getWorkspaceWindowMinWidth } from "./useWorkspaceWindowSizeConstraints";

describe("getWorkspaceWindowMinWidth", () => {
  it("keeps the default minimum width when both side panels are expanded", () => {
    expect(
      getWorkspaceWindowMinWidth({
        showProjectSidebar: true,
        projectSidebarCollapsed: false,
        showTodoRail: true,
        todoRailCollapsed: false,
      }),
    ).toBe(WORKSPACE_WINDOW_MIN_WIDTH_DEFAULT_PX);
  });

  it("reduces the minimum width when the project sidebar is collapsed", () => {
    expect(
      getWorkspaceWindowMinWidth({
        showProjectSidebar: true,
        projectSidebarCollapsed: true,
        showTodoRail: true,
        todoRailCollapsed: false,
      }),
    ).toBe(
      WORKSPACE_MAIN_CONTENT_MIN_WIDTH_PX +
        TODO_RAIL_WIDTH_MIN_PX,
    );
  });

  it("reduces the minimum width when the todo rail is collapsed", () => {
    expect(
      getWorkspaceWindowMinWidth({
        showProjectSidebar: true,
        projectSidebarCollapsed: false,
        showTodoRail: true,
        todoRailCollapsed: true,
      }),
    ).toBe(
      WORKSPACE_MAIN_CONTENT_MIN_WIDTH_PX +
        PROJECT_SIDEBAR_WIDTH_MIN_PX,
    );
  });

  it("uses only the visible panels when computing the minimum width", () => {
    expect(
      getWorkspaceWindowMinWidth({
        showProjectSidebar: true,
        projectSidebarCollapsed: true,
        showTodoRail: false,
        todoRailCollapsed: false,
      }),
    ).toBe(
      WORKSPACE_MAIN_CONTENT_MIN_WIDTH_PX,
    );
  });

  it("matches the workspace/project collapsed width when both side panels remain visible but collapsed", () => {
    expect(
      getWorkspaceWindowMinWidth({
        showProjectSidebar: true,
        projectSidebarCollapsed: true,
        showTodoRail: true,
        todoRailCollapsed: true,
      }),
    ).toBe(WORKSPACE_MAIN_CONTENT_MIN_WIDTH_PX);
  });
});
