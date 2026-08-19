import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { webviewWindow } from "@tauri-apps/api";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readImage, readText } from "@tauri-apps/plugin-clipboard-manager";
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

  saveFile(options: PickFileOptions & { defaultPath?: string } = {}) {
    return save({
      title: options.title,
      defaultPath: options.defaultPath,
      filters: options.filters,
    });
  },

  confirm(message: string, title = "请确认") {
    return ask(message, { title, kind: "warning" });
  },

  openExternalUrl(url: string) {
    return openUrl(url);
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

  resolveExportImage(input: { source?: string; path?: string; mimeType?: string }) {
    return invoke<{
      dataBase64: string;
      mimeType: string;
      extension: string;
      widthPx?: number | null;
      heightPx?: number | null;
    }>("desktop_resolve_export_image", { input });
  },

  exportAvailableBytes(targetPath: string) {
    return invoke<number>("desktop_export_available_bytes", { targetPath });
  },

  writeExportFile(input: { targetPath: string; dataBase64: string; overwrite?: boolean }) {
    return invoke<string>("desktop_write_export_file", { input });
  },

  async readClipboardText() {
    try {
      return await readText();
    } catch (error) {
      if (isClipboardContentUnavailableError(error)) {
        return null;
      }

      throw error;
    }
  },

  readClipboardHtml() {
    return invoke<string | null>("desktop_read_clipboard_html");
  },

  async readClipboardImage() {
    let image: Awaited<ReturnType<typeof readImage>>;

    try {
      image = await readImage();
    } catch (error) {
      if (isClipboardContentUnavailableError(error)) {
        return null;
      }

      throw error;
    }

    try {
      const [rgba, size] = await Promise.all([image.rgba(), image.size()]);
      return { rgba, ...size };
    } finally {
      await image.close();
    }
  },

  generateImageThumbnail(path: string, maxEdge = 960) {
    return invoke<string>("desktop_generate_image_thumbnail", { path, maxEdge });
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

function isClipboardContentUnavailableError(error: unknown) {
  return getErrorMessage(error).includes(
    "The clipboard contents were not available in the requested format or the clipboard is empty.",
  );
}
