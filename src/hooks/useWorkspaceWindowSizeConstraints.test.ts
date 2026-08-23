import { describe, expect, it } from "vitest";

import {
  PROJECT_SIDEBAR_WIDTH_DEFAULT_PX,
  PROJECT_SIDEBAR_WIDTH_MIN_PX,
  TODO_RAIL_WIDTH_DEFAULT_PX,
  TODO_RAIL_WIDTH_MIN_PX,
  WORKSPACE_MAIN_CONTENT_MIN_WIDTH_PX,
  WORKSPACE_WINDOW_MIN_WIDTH_DEFAULT_PX,
} from "../state/ui-store";
import {
  getResponsivePanelState,
  getWorkspaceWindowConstraintMinWidth,
  getWorkspaceWindowMinWidth,
} from "./useWorkspaceWindowSizeConstraints";

describe("getWorkspaceWindowMinWidth", () => {
  it("keeps the default minimum width when both side panels are expanded", () => {
    expect(
      getWorkspaceWindowMinWidth({
        showProjectSidebar: true,
        projectSidebarCollapsed: false,
        projectSidebarWidthPx: PROJECT_SIDEBAR_WIDTH_DEFAULT_PX,
        showTodoRail: true,
        todoRailCollapsed: false,
        todoRailWidthPx: TODO_RAIL_WIDTH_DEFAULT_PX,
      }),
    ).toBe(
      WORKSPACE_MAIN_CONTENT_MIN_WIDTH_PX +
        PROJECT_SIDEBAR_WIDTH_DEFAULT_PX +
        TODO_RAIL_WIDTH_DEFAULT_PX,
    );
  });

  it("reduces the minimum width when the project sidebar is collapsed", () => {
    expect(
      getWorkspaceWindowMinWidth({
        showProjectSidebar: true,
        projectSidebarCollapsed: true,
        projectSidebarWidthPx: PROJECT_SIDEBAR_WIDTH_DEFAULT_PX,
        showTodoRail: true,
        todoRailCollapsed: false,
        todoRailWidthPx: TODO_RAIL_WIDTH_MIN_PX,
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
        projectSidebarWidthPx: PROJECT_SIDEBAR_WIDTH_MIN_PX,
        showTodoRail: true,
        todoRailCollapsed: true,
        todoRailWidthPx: TODO_RAIL_WIDTH_DEFAULT_PX,
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
        projectSidebarWidthPx: PROJECT_SIDEBAR_WIDTH_DEFAULT_PX,
        showTodoRail: false,
        todoRailCollapsed: false,
        todoRailWidthPx: TODO_RAIL_WIDTH_DEFAULT_PX,
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
        projectSidebarWidthPx: PROJECT_SIDEBAR_WIDTH_DEFAULT_PX,
        showTodoRail: true,
        todoRailCollapsed: true,
        todoRailWidthPx: TODO_RAIL_WIDTH_DEFAULT_PX,
      }),
    ).toBe(WORKSPACE_MAIN_CONTENT_MIN_WIDTH_PX);
  });

  it("collapses the Todo Rail first when persisted widths would squeeze the editor", () => {
    expect(
      getResponsivePanelState({
        availableWidthPx: 1180,
        showProjectSidebar: true,
        projectSidebarCollapsed: false,
        projectSidebarWidthPx: 420,
        showTodoRail: true,
        todoRailCollapsed: false,
        todoRailWidthPx: 440,
      }),
    ).toEqual({ projectSidebarCollapsed: false, todoRailCollapsed: true });
  });

  it("keeps the native constraint low enough for responsive collapse to occur", () => {
    expect(
      getWorkspaceWindowConstraintMinWidth({
        showProjectSidebar: true,
        projectSidebarCollapsed: false,
        projectSidebarWidthPx: 480,
        showTodoRail: true,
        todoRailCollapsed: false,
        todoRailWidthPx: 560,
      }),
    ).toBe(WORKSPACE_WINDOW_MIN_WIDTH_DEFAULT_PX);
  });
});
