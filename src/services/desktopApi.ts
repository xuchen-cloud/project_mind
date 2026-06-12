import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { webviewWindow } from "@tauri-apps/api";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { open } from "@tauri-apps/plugin-dialog";
import { getErrorMessage } from "../lib/errors";
import { getWorkspaceWindowMinWidth } from "../hooks/useWorkspaceWindowSizeConstraints";
import {
  focusProjectWindow,
  getCurrentWindowLabel,
  isProjectWindow,
  projectWindowLabel,
} from "../lib/project-window";
import {
  WORKSPACE_WINDOW_MIN_HEIGHT_PX,
} from "../state/ui-store";

interface PickFilter {
  name: string;
  extensions: string[];
}

interface PickFileOptions {
  title?: string;
  filters?: PickFilter[];
}

function projectWindowUrl(route: string) {
  if (typeof window === "undefined") {
    return `index.html#${route}`;
  }

  const nextUrl = new URL(window.location.href);
  nextUrl.hash = `#${route}`;
  return nextUrl.toString();
}

function projectWindowShowsTodoRail(route: string) {
  return !route.endsWith("/summary") && !/\/projects\/\d+\/records\/\d+(?:\?.*)?$/u.test(route);
}

export const desktopApi = {
  async command<T>(name: string, payload?: Record<string, unknown>) {
    try {
      return await invoke<T>(name, payload);
    } catch (error) {
      throw new Error(getErrorMessage(error, `${name} 调用失败`));
    }
  },

  async pickDirectory(title = "选择文件夹") {
    const selected = await open({
      title,
      directory: true,
      multiple: false,
    });
    return Array.isArray(selected) ? selected[0] ?? null : selected;
  },

  async pickFile(options: PickFileOptions = {}) {
    const selected = await open({
      title: options.title,
      directory: false,
      multiple: false,
      filters: options.filters,
    });
    return Array.isArray(selected) ? selected[0] ?? null : selected;
  },

  async pickFiles(options: PickFileOptions = {}) {
    const selected = await open({
      title: options.title,
      directory: false,
      multiple: true,
      filters: options.filters,
    });

    if (!selected) {
      return [];
    }

    return Array.isArray(selected) ? selected : [selected];
  },

  openFile(path: string) {
    return invoke<void>("desktop_open_file", { path });
  },

  revealPath(path: string) {
    return this.revealInExplorer(path);
  },

  openFolder(path: string) {
    return invoke<void>("desktop_open_folder", { path });
  },

  revealInExplorer(path: string) {
    return invoke<void>("desktop_reveal_in_explorer", { path });
  },

  readFileAsDataUrl(path: string, mimeType?: string) {
    return invoke<string>("desktop_read_file_as_data_url", { path, mimeType });
  },

  listSystemFontFamilies() {
    return invoke<string[]>("desktop_list_system_font_families");
  },

  toFileUrl(path: string) {
    return convertFileSrc(path);
  },

  async openProjectWindow(input: {
    projectId: number;
    projectName: string;
    route: string;
  }) {
    const focused = await focusProjectWindow(input.projectId);
    if (focused) {
      const existingWindow = await webviewWindow.WebviewWindow.getByLabel(
        projectWindowLabel(input.projectId),
      );
      if (existingWindow) {
        await existingWindow.emit("project-window:navigate", {
          route: input.route,
        });
      }
      return;
    }

    const currentWindowHandle = getCurrentWindow();
    const [currentWindowSize, currentWindowScaleFactor] = await Promise.all([
      currentWindowHandle.innerSize().catch(() => null),
      currentWindowHandle.scaleFactor().catch(() => null),
    ]);
    const currentWindowLogicalSize =
      currentWindowSize && currentWindowScaleFactor
        ? currentWindowSize.toLogical(currentWindowScaleFactor)
        : null;
    const minWidth = getWorkspaceWindowMinWidth({
      showProjectSidebar: true,
      projectSidebarCollapsed: true,
      showTodoRail: projectWindowShowsTodoRail(input.route),
      todoRailCollapsed: true,
    });
    const projectWindow = new webviewWindow.WebviewWindow(projectWindowLabel(input.projectId), {
      title: input.projectName,
      url: projectWindowUrl(input.route),
      width: currentWindowLogicalSize?.width,
      height: currentWindowLogicalSize?.height,
      minWidth,
      minHeight: WORKSPACE_WINDOW_MIN_HEIGHT_PX,
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      void projectWindow.once("tauri://created", async () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      });

      void projectWindow.once("tauri://error", (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      });
    });
  },

  focusProjectWindow,

  isProjectWindow,

  getCurrentWindowLabel,
};
