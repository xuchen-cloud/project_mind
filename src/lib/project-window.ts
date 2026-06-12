import { webviewWindow } from "@tauri-apps/api";

export const PROJECT_WINDOW_LABEL_PREFIX = "project-";
export const PROJECT_WINDOW_NAVIGATE_EVENT = "project-window:navigate";

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function projectWindowLabel(projectId: number) {
  return `${PROJECT_WINDOW_LABEL_PREFIX}${projectId}`;
}

export function parseProjectWindowProjectId(label: string | null | undefined) {
  if (!label?.startsWith(PROJECT_WINDOW_LABEL_PREFIX)) {
    return null;
  }

  const parsed = Number(label.slice(PROJECT_WINDOW_LABEL_PREFIX.length));
  return Number.isFinite(parsed) ? parsed : null;
}

export function getCurrentWindowLabel() {
  try {
    return webviewWindow.getCurrentWebviewWindow().label;
  } catch {
    return null;
  }
}

export function isProjectWindow() {
  return parseProjectWindowProjectId(getCurrentWindowLabel()) !== null;
}

export async function getProjectWindow(projectId: number) {
  if (!isTauriRuntime()) {
    return null;
  }

  return webviewWindow.WebviewWindow.getByLabel(projectWindowLabel(projectId));
}

export async function focusProjectWindow(projectId: number) {
  const projectWindow = await getProjectWindow(projectId);
  if (!projectWindow) {
    return false;
  }

  await projectWindow.show();
  await projectWindow.setFocus();
  return true;
}
