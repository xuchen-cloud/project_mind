import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  PROJECT_SIDEBAR_COLLAPSED_WIDTH_PX,
  PROJECT_SIDEBAR_WIDTH_MIN_PX,
  TODO_RAIL_COLLAPSED_WIDTH_PX,
  TODO_RAIL_WIDTH_MIN_PX,
  WORKSPACE_MAIN_CONTENT_MIN_WIDTH_PX,
  WORKSPACE_WINDOW_MIN_HEIGHT_PX,
  WORKSPACE_WINDOW_MIN_WIDTH_DEFAULT_PX,
} from "../state/ui-store";

interface WorkspaceWindowSizeConstraintsOptions {
  showProjectSidebar: boolean;
  projectSidebarCollapsed: boolean;
  showTodoRail: boolean;
  todoRailCollapsed: boolean;
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function getWorkspaceWindowMinWidth({
  showProjectSidebar,
  projectSidebarCollapsed,
  showTodoRail,
  todoRailCollapsed,
}: WorkspaceWindowSizeConstraintsOptions) {
  if (!showProjectSidebar && !showTodoRail) {
    return WORKSPACE_WINDOW_MIN_WIDTH_DEFAULT_PX;
  }

  let minWidth = WORKSPACE_MAIN_CONTENT_MIN_WIDTH_PX;

  if (showProjectSidebar) {
    minWidth += projectSidebarCollapsed
      ? PROJECT_SIDEBAR_COLLAPSED_WIDTH_PX
      : PROJECT_SIDEBAR_WIDTH_MIN_PX;
  }

  if (showTodoRail) {
    minWidth += todoRailCollapsed
      ? TODO_RAIL_COLLAPSED_WIDTH_PX
      : TODO_RAIL_WIDTH_MIN_PX;
  }

  return minWidth;
}

export function useWorkspaceWindowSizeConstraints(
  options: WorkspaceWindowSizeConstraintsOptions,
) {
  const minWidth = getWorkspaceWindowMinWidth(options);

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
