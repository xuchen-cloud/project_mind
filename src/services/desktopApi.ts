import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { webviewWindow } from "@tauri-apps/api";
import { availableMonitors, currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readImage, readText } from "@tauri-apps/plugin-clipboard-manager";
import { getErrorMessage } from "../lib/errors";
import type { VoiceSessionSnapshot, VoiceSettings } from "../lib/voice-types";
import { getWorkspaceWindowMinWidth } from "../hooks/useWorkspaceWindowSizeConstraints";
import {
  focusProjectWindow,
  getCurrentWindowLabel,
  isProjectWindow,
  projectWindowLabel,
  parseProjectWindowProjectId,
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

interface WorkspaceLifecycleFlushRequest {
  requestId: string;
  requesterLabel: string;
}

interface WorkspaceLifecycleFlushResponse {
  requestId: string;
  windowLabel: string;
  ok: boolean;
  error?: string;
}

const WORKSPACE_LIFECYCLE_FLUSH_REQUEST_EVENT =
  "workspace-lifecycle:flush-request";
const WORKSPACE_LIFECYCLE_FLUSH_RESPONSE_EVENT =
  "workspace-lifecycle:flush-response";
const WORKSPACE_LIFECYCLE_FLUSH_TIMEOUT_MS = 30_000;
let workspaceLifecycleRequestSequence = 0;

async function otherProjectWindows() {
  const currentLabel = webviewWindow.getCurrentWebviewWindow().label;
  return (await webviewWindow.getAllWebviewWindows()).filter(
    (candidate) =>
      candidate.label !== currentLabel &&
      parseProjectWindowProjectId(candidate.label) !== null,
  );
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
  listenEvent<T>(event: string, onPayload: (payload: T) => void) {
    return listen<T>(event, ({ payload }) => onPayload(payload));
  },
  async captionWindowTrackPosition() {
    const current = getCurrentWindow();
    return (await import("./voiceWindowPosition")).trackVoiceWindowPosition({
      displays: availableMonitors,
      outerPosition: () => current.outerPosition(), outerSize: () => current.outerSize(),
      scaleFactor: () => current.scaleFactor(),
      setSize: (width, height) => current.setSize(new PhysicalSize(width, height)),
      setPosition: (x, y) => current.setPosition(new PhysicalPosition(x, y)),
      onMoved: handler => current.onMoved(handler), onResized: handler => current.onResized(handler),
      onScaleChanged: handler => current.onScaleChanged(handler),
    });
  },
  async captionWindowSetSize(width: number, height: number) {
    const current = getCurrentWindow();
    const minSize = new LogicalSize(width < 380 ? width : 380, height < 72 ? height : 72);
    if (width < 380) await current.setMinSize(minSize);
    await current.setSize(new LogicalSize(width, height));
    if (width >= 380) await current.setMinSize(minSize);
  },

  captionWindowClose() {
    return getCurrentWindow().destroy();
  },

  async closeVoiceCaptionWindow() {
    const captionWindow = await webviewWindow.WebviewWindow.getByLabel("voice-caption");
    if (captionWindow) await captionWindow.destroy();
  },

  captionWindowOnCloseRequested(shouldClose: () => boolean) {
    return getCurrentWindow().onCloseRequested((event) => {
      if (!shouldClose()) event.preventDefault();
    });
  },

  async openVoiceCaptionWindow() {
    const existing = await webviewWindow.WebviewWindow.getByLabel("voice-caption");
    if (existing) {
      await existing.setTheme("light");
      await existing.show();
      return;
    }
    const settings = await Promise.resolve(invoke<VoiceSettings>("voice_settings_get")).catch(() => null);
    const audioOnly = settings?.speechProfile === null;
    const monitor = await currentMonitor();
    const width = audioOnly ? 160 : 680;
    const height = audioOnly ? 48 : 220;
    const bounds = monitor?.workArea;
    const scale = monitor?.scaleFactor ?? 1;
    const x = bounds ? Math.round(bounds.position.x / scale + (bounds.size.width / scale - width) / 2) : undefined;
    const y = bounds ? Math.round(bounds.position.y / scale + bounds.size.height / scale - height - 30) : undefined;
    const url = new URL("voice.html", window.location.href);
    if (audioOnly) url.searchParams.set("audioOnly", "1");
    const captionWindow = new webviewWindow.WebviewWindow("voice-caption", {
      title: "语音记录",
      url: url.toString(),
      width,
      height,
      minWidth: audioOnly ? 160 : 380,
      minHeight: audioOnly ? 48 : 72,
      x,
      y,
      alwaysOnTop: true,
      transparent: true,
      focus: false,
      resizable: true,
      decorations: false,
      // The frosted layer supplies rounded edges; native shadow outlines the rectangular window.
      shadow: false,
      theme: "light",
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      void captionWindow.once("tauri://created", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      void captionWindow.once("tauri://error", (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
    await invoke("voice_caption_apply_material");
  },

  async prepareVoiceLeave() {
    const status = await invoke<{ currentWorkspace: unknown }>("workspace_status_get");
    if (!status.currentWorkspace) return true;
    const session = await invoke<VoiceSessionSnapshot | null>("voice_snapshot_get");
    if (!session || session.phase === "ended") return true;
    if (!(await ask("当前语音记录尚未结束。结束并保存后继续？", {
      title: "保存语音记录", kind: "warning", okLabel: "结束并保存", cancelLabel: "取消",
    }))) return false;
    await invoke("voice_end", { input: {
      sessionId: session.sessionId, expectedRevision: session.revision, requestId: crypto.randomUUID(),
    } });
    await desktopApi.closeVoiceCaptionWindow();
    return true;
  },

  async listenForCloseRequest(onClose: () => Promise<boolean>) {
    const currentWindow = getCurrentWindow();
    let closing = false;
    const requestClose = async () => {
      if (closing) return;
      closing = true;
      try {
        if (!(await onClose())) return;
        if (isProjectWindow()) await currentWindow.destroy();
        else await invoke("app_exit");
      } finally { closing = false; }
    };
    const unlistenClose = await currentWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      await requestClose();
    });
    const unlistenExit = !isProjectWindow()
      ? await webviewWindow.getCurrentWebviewWindow().listen("app:exit-requested", requestClose)
      : () => {};
    return () => { unlistenClose(); unlistenExit(); };
  },

  async listenForWorkspaceLifecycleFlush(onFlush: () => Promise<void>) {
    const currentWindow = webviewWindow.getCurrentWebviewWindow();
    return currentWindow.listen<WorkspaceLifecycleFlushRequest>(
      WORKSPACE_LIFECYCLE_FLUSH_REQUEST_EVENT,
      async ({ payload }) => {
        let response: WorkspaceLifecycleFlushResponse;
        try {
          await onFlush();
          response = {
            requestId: payload.requestId,
            windowLabel: currentWindow.label,
            ok: true,
          };
        } catch (error) {
          response = {
            requestId: payload.requestId,
            windowLabel: currentWindow.label,
            ok: false,
            error: getErrorMessage(error, "Record 保存失败"),
          };
        }

        const requester = await webviewWindow.WebviewWindow.getByLabel(
          payload.requesterLabel,
        );
        await requester?.emit(
          WORKSPACE_LIFECYCLE_FLUSH_RESPONSE_EVENT,
          response,
        );
      },
    );
  },

  async flushOtherWorkspaceWindows(includeCurrent = false) {
    const currentWindow = webviewWindow.getCurrentWebviewWindow();
    const targets = includeCurrent
      ? (await webviewWindow.getAllWebviewWindows()).filter(candidate => candidate.label === "main" || parseProjectWindowProjectId(candidate.label) !== null)
      : await otherProjectWindows();
    if (targets.length === 0) {
      return;
    }

    workspaceLifecycleRequestSequence += 1;
    const requestId = [
      "workspace-lifecycle",
      Date.now(),
      workspaceLifecycleRequestSequence,
    ].join("-");
    const pendingLabels = new Set(targets.map((target) => target.label));
    const failures: string[] = [];
    let resolveResponses!: () => void;
    let rejectResponses!: (error: Error) => void;
    const responses = new Promise<void>((resolve, reject) => {
      resolveResponses = resolve;
      rejectResponses = reject;
    });
    const unlisten = await currentWindow.listen<WorkspaceLifecycleFlushResponse>(
      WORKSPACE_LIFECYCLE_FLUSH_RESPONSE_EVENT,
      ({ payload }) => {
        if (
          payload.requestId !== requestId ||
          !pendingLabels.delete(payload.windowLabel)
        ) {
          return;
        }
        if (!payload.ok) {
          failures.push(
            `${payload.windowLabel}: ${payload.error ?? "Record 保存失败"}`,
          );
        }
        if (pendingLabels.size === 0) {
          resolveResponses();
        }
      },
    );
    const timeoutId = window.setTimeout(() => {
      rejectResponses(
        new Error(
          `等待 Project 窗口保存超时：${[...pendingLabels].join(", ")}`,
        ),
      );
    }, WORKSPACE_LIFECYCLE_FLUSH_TIMEOUT_MS);

    try {
      await Promise.all(
        targets.map((target) =>
          target.emit(WORKSPACE_LIFECYCLE_FLUSH_REQUEST_EVENT, {
            requestId,
            requesterLabel: currentWindow.label,
          } satisfies WorkspaceLifecycleFlushRequest),
        ),
      );
      await responses;
    } finally {
      window.clearTimeout(timeoutId);
      unlisten();
    }

    if (failures.length > 0) {
      throw new Error(failures.join("\n"));
    }
  },

  async destroyOtherWorkspaceWindows() {
    const targets = await otherProjectWindows();
    await Promise.all(targets.map((target) => target.destroy()));
  },

  async command<T>(name: string, payload?: Record<string, unknown>) {
    try {
      return await invoke<T>(name, payload);
    } catch (error) {
      throw new Error(getErrorMessage(error, `${name} 调用失败`));
    }
  },

  /** File services need native failure codes to distinguish unavailable snapshots from conflicts. */
  fileCommand<T>(name: string, payload: Record<string, unknown>) {
    return invoke<T>(name, payload);
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

  resolveExportImage(input: { source?: string; path?: string; mimeType?: string; requestId?: string }) {
    return invoke<{
      dataBase64: string;
      mimeType: string;
      extension: string;
      widthPx?: number | null;
      heightPx?: number | null;
    }>("desktop_resolve_export_image", { input });
  },

  cancelExportImage(requestId: string) {
    return invoke<void>("desktop_cancel_export_image", { requestId });
  },

  exportAvailableBytes(targetPath: string) {
    return invoke<number>("desktop_export_available_bytes", { targetPath });
  },

  writeExportFile(input: { targetPath: string; dataBase64: string; overwrite?: boolean; requestId?: string }) {
    return invoke<string>("desktop_write_export_file", { input });
  },

  cancelExportWrite(requestId: string) {
    return invoke<void>("desktop_cancel_export_write", { requestId });
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
