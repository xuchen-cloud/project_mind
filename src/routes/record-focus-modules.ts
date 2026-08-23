export const loadProjectNoteFocusPageModule = () =>
  import("../components/project/ProjectNoteFocusPage").then((module) => ({
    default: module.ProjectNoteFocusPage,
  }));

export const loadWorkspaceRecordFocusPageModule = () =>
  import("../components/workspace/WorkspaceRecordFocusPage").then((module) => ({
    default: module.WorkspaceRecordFocusPage,
  }));

export function preloadRecordFocusPageModules() {
  return Promise.all([
    loadProjectNoteFocusPageModule(),
    loadWorkspaceRecordFocusPageModule(),
  ]);
}

export function scheduleRecordFocusPageModulesPreload(targetWindow: Window) {
  const preload = () => {
    void preloadRecordFocusPageModules().catch(() => {
      // Formal navigation retries the import and owns any user-facing error.
    });
  };

  if (typeof targetWindow.requestIdleCallback === "function") {
    const handle = targetWindow.requestIdleCallback(preload, { timeout: 1500 });
    return () => targetWindow.cancelIdleCallback(handle);
  }

  const handle = targetWindow.setTimeout(preload, 0);
  return () => targetWindow.clearTimeout(handle);
}
