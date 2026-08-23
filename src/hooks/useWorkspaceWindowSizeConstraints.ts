import { useEffect, useLayoutEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  PROJECT_SIDEBAR_WIDTH_DEFAULT_PX,
  TODO_RAIL_WIDTH_DEFAULT_PX,
  WORKSPACE_MAIN_CONTENT_MIN_WIDTH_PX,
  WORKSPACE_WINDOW_MIN_HEIGHT_PX,
  WORKSPACE_WINDOW_MIN_WIDTH_DEFAULT_PX,
} from "../state/ui-store";

interface WorkspaceWindowSizeConstraintsOptions {
  showProjectSidebar: boolean;
  projectSidebarCollapsed: boolean;
  projectSidebarWidthPx?: number;
  showTodoRail: boolean;
  todoRailCollapsed: boolean;
  todoRailWidthPx?: number;
  setProjectSidebarCollapsed?: (collapsed: boolean) => void;
  setTodoRailCollapsed?: (collapsed: boolean) => void;
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function getWorkspaceWindowMinWidth({
  showProjectSidebar,
  projectSidebarCollapsed,
  projectSidebarWidthPx = PROJECT_SIDEBAR_WIDTH_DEFAULT_PX,
  showTodoRail,
  todoRailCollapsed,
  todoRailWidthPx = TODO_RAIL_WIDTH_DEFAULT_PX,
}: WorkspaceWindowSizeConstraintsOptions) {
  if (!showProjectSidebar && !showTodoRail) {
    return WORKSPACE_WINDOW_MIN_WIDTH_DEFAULT_PX;
  }

  let minWidth = WORKSPACE_MAIN_CONTENT_MIN_WIDTH_PX;

  if (showProjectSidebar) {
    minWidth += projectSidebarCollapsed
      ? 0
      : projectSidebarWidthPx;
  }

  if (showTodoRail) {
    minWidth += todoRailCollapsed ? 0 : todoRailWidthPx;
  }

  return minWidth;
}

export function getResponsivePanelState(
  options: WorkspaceWindowSizeConstraintsOptions & { availableWidthPx: number },
) {
  let projectSidebarCollapsed = options.projectSidebarCollapsed;
  let todoRailCollapsed = options.todoRailCollapsed;
  const fits = () =>
    getWorkspaceWindowMinWidth({
      ...options,
      projectSidebarCollapsed,
      todoRailCollapsed,
    }) <= options.availableWidthPx;

  if (!fits() && options.showTodoRail && !todoRailCollapsed) {
    todoRailCollapsed = true;
  }
  if (!fits() && options.showProjectSidebar && !projectSidebarCollapsed) {
    projectSidebarCollapsed = true;
  }

  return { projectSidebarCollapsed, todoRailCollapsed };
}

export function getWorkspaceWindowConstraintMinWidth(
  options: WorkspaceWindowSizeConstraintsOptions,
) {
  return Math.min(
    getWorkspaceWindowMinWidth(options),
    WORKSPACE_WINDOW_MIN_WIDTH_DEFAULT_PX,
  );
}

export function useWorkspaceWindowSizeConstraints(
  options: WorkspaceWindowSizeConstraintsOptions,
) {
  const minWidth = getWorkspaceWindowConstraintMinWidth(options);

  useLayoutEffect(() => {
    const protectMainEditor = () => {
      const next = getResponsivePanelState({
        ...options,
        availableWidthPx: window.innerWidth,
      });
      if (next.todoRailCollapsed !== options.todoRailCollapsed) {
        options.setTodoRailCollapsed?.(next.todoRailCollapsed);
      }
      if (next.projectSidebarCollapsed !== options.projectSidebarCollapsed) {
        options.setProjectSidebarCollapsed?.(next.projectSidebarCollapsed);
      }
    };

    protectMainEditor();
    window.addEventListener("resize", protectMainEditor);
    return () => window.removeEventListener("resize", protectMainEditor);
  }, [options]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    void getCurrentWindow().setSizeConstraints({
      minWidth,
      minHeight: WORKSPACE_WINDOW_MIN_HEIGHT_PX,
    });
  }, [minWidth]);
}
