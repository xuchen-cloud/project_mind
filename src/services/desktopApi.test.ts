import { beforeEach, describe, expect, it, vi } from "vitest";
const tauriMocks = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  convertFileSrcMock: vi.fn((path: string) => `asset://${path}`),
  openMock: vi.fn(),
  saveMock: vi.fn(),
  askMock: vi.fn(),
  readClipboardTextMock: vi.fn(),
  readClipboardImageMock: vi.fn(),
  onCloseRequestedMock: vi.fn(),
  destroyWindowMock: vi.fn(async () => undefined),
  getCurrentWindowMock: vi.fn(() => ({
    innerSize: vi.fn(async () => ({
      width: 3360,
      height: 2048,
      toLogical: (scaleFactor: number) => ({
        width: 3360 / scaleFactor,
        height: 2048 / scaleFactor,
      }),
    })),
    scaleFactor: vi.fn(async () => 2),
    onCloseRequested: tauriMocks.onCloseRequestedMock,
    destroy: tauriMocks.destroyWindowMock,
  })),
  getByLabelMock: vi.fn(),
  webviewWindowInstances: [] as Array<{
    label: string;
    options?: Record<string, unknown>;
    once: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    setFocus: ReturnType<typeof vi.fn>;
  }>,
  getCurrentWebviewWindowMock: vi.fn(() => ({ label: "main" })),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invokeMock,
  convertFileSrc: tauriMocks.convertFileSrcMock,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: tauriMocks.getCurrentWindowMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: tauriMocks.openMock,
  save: tauriMocks.saveMock,
  ask: tauriMocks.askMock,
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: tauriMocks.readClipboardTextMock,
  readImage: tauriMocks.readClipboardImageMock,
}));

vi.mock("@tauri-apps/api", () => {
  class MockWebviewWindow {
    label: string;
    once = vi.fn((event: string, handler: () => void) => {
      if (event === "tauri://created") {
        queueMicrotask(handler);
      }
      return Promise.resolve(() => undefined);
    });
    emit = vi.fn(async () => undefined);
    show = vi.fn(async () => undefined);
    setFocus = vi.fn(async () => undefined);

    options?: Record<string, unknown>;

    constructor(label: string, options?: Record<string, unknown>) {
      this.label = label;
      this.options = options;
      tauriMocks.webviewWindowInstances.push(this);
    }

    static getByLabel(label: string) {
      return tauriMocks.getByLabelMock(label);
    }
  }

  return {
    webviewWindow: {
      WebviewWindow: MockWebviewWindow,
      getCurrentWebviewWindow: tauriMocks.getCurrentWebviewWindowMock,
    },
  };
});

import { desktopApi } from "./desktopApi";

describe("desktopApi", () => {
  beforeEach(() => {
    tauriMocks.invokeMock.mockReset();
    tauriMocks.openMock.mockReset();
    tauriMocks.saveMock.mockReset();
    tauriMocks.askMock.mockReset();
    tauriMocks.readClipboardTextMock.mockReset();
    tauriMocks.readClipboardImageMock.mockReset();
    tauriMocks.convertFileSrcMock.mockClear();
    tauriMocks.getCurrentWindowMock.mockClear();
    tauriMocks.onCloseRequestedMock.mockReset();
    tauriMocks.onCloseRequestedMock.mockResolvedValue(() => undefined);
    tauriMocks.destroyWindowMock.mockClear();
    tauriMocks.getByLabelMock.mockReset();
    tauriMocks.getCurrentWebviewWindowMock.mockClear();
    tauriMocks.webviewWindowInstances.length = 0;
  });

  it("proxies command invocations through Tauri invoke", async () => {
    tauriMocks.invokeMock.mockResolvedValueOnce({ ok: true });

    await expect(desktopApi.command("projects_list", { input: { includeArchived: true } })).resolves.toEqual({ ok: true });
    expect(tauriMocks.invokeMock).toHaveBeenCalledWith("projects_list", {
      input: { includeArchived: true },
    });
  });

  it("prevents a close request until the lifecycle barrier allows destruction", async () => {
    const allowClose = vi.fn(async () => true);
    const unlisten = await desktopApi.listenForCloseRequest(allowClose);
    const handler = tauriMocks.onCloseRequestedMock.mock.calls[0]?.[0] as (
      event: { preventDefault: () => void },
    ) => Promise<void>;
    const preventDefault = vi.fn();

    await handler({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(allowClose).toHaveBeenCalledTimes(1);
    expect(tauriMocks.destroyWindowMock).toHaveBeenCalledTimes(1);
    expect(unlisten).toBeTypeOf("function");
  });

  it("reads clipboard HTML and text through their native adapter boundaries", async () => {
    tauriMocks.invokeMock.mockResolvedValueOnce("<p>Rich clipboard</p>");
    tauriMocks.readClipboardTextMock.mockResolvedValueOnce("Rich clipboard");

    await expect(desktopApi.readClipboardHtml()).resolves.toBe("<p>Rich clipboard</p>");
    await expect(desktopApi.readClipboardText()).resolves.toBe("Rich clipboard");

    expect(tauriMocks.invokeMock).toHaveBeenCalledWith("desktop_read_clipboard_html");
    expect(tauriMocks.readClipboardTextMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes an empty native text clipboard without hiding real failures", async () => {
    tauriMocks.readClipboardTextMock.mockRejectedValueOnce(
      "The clipboard contents were not available in the requested format or the clipboard is empty.",
    );
    await expect(desktopApi.readClipboardText()).resolves.toBeNull();

    tauriMocks.readClipboardTextMock.mockRejectedValueOnce("clipboard access denied");
    await expect(desktopApi.readClipboardText()).rejects.toBe("clipboard access denied");
  });

  it("reads normalized clipboard image pixels and always closes the native resource", async () => {
    tauriMocks.readClipboardImageMock.mockRejectedValueOnce(
      "The clipboard contents were not available in the requested format or the clipboard is empty.",
    );
    await expect(desktopApi.readClipboardImage()).resolves.toBeNull();

    tauriMocks.readClipboardImageMock.mockRejectedValueOnce("native clipboard is unavailable");
    await expect(desktopApi.readClipboardImage()).rejects.toBe("native clipboard is unavailable");

    const close = vi.fn(async () => undefined);
    const rgba = new Uint8Array([255, 0, 0, 255]);
    tauriMocks.readClipboardImageMock.mockResolvedValueOnce({
      rgba: vi.fn(async () => rgba),
      size: vi.fn(async () => ({ width: 1, height: 1 })),
      close,
    });

    await expect(desktopApi.readClipboardImage()).resolves.toEqual({
      rgba,
      width: 1,
      height: 1,
    });
    expect(close).toHaveBeenCalledTimes(1);

    const failedClose = vi.fn(async () => undefined);
    tauriMocks.readClipboardImageMock.mockResolvedValueOnce({
      rgba: vi.fn(async () => {
        throw new Error("RGBA unavailable");
      }),
      size: vi.fn(async () => ({ width: 1, height: 1 })),
      close: failedClose,
    });

    await expect(desktopApi.readClipboardImage()).rejects.toThrow("RGBA unavailable");
    expect(failedClose).toHaveBeenCalledTimes(1);
  });

  it("normalizes invoke failures into readable Error messages", async () => {
    tauriMocks.invokeMock.mockRejectedValueOnce({ message: "Error: 上游服务返回 401" });

    await expect(desktopApi.command("ai_profile_test")).rejects.toMatchObject({
      message: "上游服务返回 401",
    });
  });

  it("normalizes picked file values", async () => {
    tauriMocks.openMock.mockResolvedValueOnce(["/tmp/file.md"]);

    await expect(desktopApi.pickFile({ title: "Pick file" })).resolves.toBe("/tmp/file.md");
    expect(tauriMocks.openMock).toHaveBeenCalledWith({
      title: "Pick file",
      directory: false,
      multiple: false,
      filters: undefined,
    });
  });

  it("returns all selected files when multiple selection is enabled", async () => {
    tauriMocks.openMock.mockResolvedValueOnce(["/tmp/file-a.md", "/tmp/file-b.md"]);

    await expect(desktopApi.pickFiles({ title: "Pick files" })).resolves.toEqual([
      "/tmp/file-a.md",
      "/tmp/file-b.md",
    ]);
    expect(tauriMocks.openMock).toHaveBeenCalledWith({
      title: "Pick files",
      directory: false,
      multiple: true,
      filters: undefined,
    });
  });

  it("reveals paths and converts file urls", async () => {
    tauriMocks.invokeMock.mockResolvedValueOnce(undefined);

    await desktopApi.revealPath("/tmp/demo.txt");
    expect(tauriMocks.invokeMock).toHaveBeenCalledWith("desktop_reveal_in_explorer", {
      path: "/tmp/demo.txt",
    });
    expect(desktopApi.toFileUrl("/tmp/demo.txt")).toBe("asset:///tmp/demo.txt");
  });

  it("opens folders through the desktop command", async () => {
    tauriMocks.invokeMock.mockResolvedValueOnce(undefined);

    await desktopApi.openFolder("/tmp/project");

    expect(tauriMocks.invokeMock).toHaveBeenCalledWith("desktop_open_folder", {
      path: "/tmp/project",
    });
  });

  it("reveals paths in explorer", async () => {
    tauriMocks.invokeMock.mockResolvedValueOnce(undefined);

    await desktopApi.revealInExplorer("/tmp/demo.txt");

    expect(tauriMocks.invokeMock).toHaveBeenCalledWith("desktop_reveal_in_explorer", {
      path: "/tmp/demo.txt",
    });
  });

  it("lists system font families through the desktop command", async () => {
    tauriMocks.invokeMock.mockResolvedValueOnce(["Segoe UI", "PingFang SC"]);

    await expect(desktopApi.listSystemFontFamilies()).resolves.toEqual([
      "Segoe UI",
      "PingFang SC",
    ]);

    expect(tauriMocks.invokeMock).toHaveBeenCalledWith("desktop_list_system_font_families");
  });

  it("generates image thumbnails through the desktop command", async () => {
    tauriMocks.invokeMock.mockResolvedValueOnce("/tmp/thumb.jpg");

    await expect(desktopApi.generateImageThumbnail("/tmp/clip.png", 720)).resolves.toBe(
      "/tmp/thumb.jpg",
    );

    expect(tauriMocks.invokeMock).toHaveBeenCalledWith("desktop_generate_image_thumbnail", {
      path: "/tmp/clip.png",
      maxEdge: 720,
    });
  });

  it("maps Record Export image, disk-space, and atomic-write commands", async () => {
    tauriMocks.invokeMock
      .mockResolvedValueOnce({ dataBase64: "AA==", mimeType: "image/png", extension: "png" })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(4096)
      .mockResolvedValueOnce("/tmp/export.pdf")
      .mockResolvedValueOnce(undefined);

    await desktopApi.resolveExportImage({ path: "/tmp/image.png", mimeType: "image/png", requestId: "image-1" });
    await desktopApi.cancelExportImage("image-1");
    await desktopApi.exportAvailableBytes("/tmp/export.pdf");
    await desktopApi.writeExportFile({
      targetPath: "/tmp/export.pdf",
      dataBase64: "JVBERg==",
      overwrite: true,
      requestId: "write-1",
    });
    await desktopApi.cancelExportWrite("write-1");

    expect(tauriMocks.invokeMock).toHaveBeenNthCalledWith(1, "desktop_resolve_export_image", {
      input: { path: "/tmp/image.png", mimeType: "image/png", requestId: "image-1" },
    });
    expect(tauriMocks.invokeMock).toHaveBeenNthCalledWith(2, "desktop_cancel_export_image", {
      requestId: "image-1",
    });
    expect(tauriMocks.invokeMock).toHaveBeenNthCalledWith(3, "desktop_export_available_bytes", {
      targetPath: "/tmp/export.pdf",
    });
    expect(tauriMocks.invokeMock).toHaveBeenNthCalledWith(4, "desktop_write_export_file", {
      input: { targetPath: "/tmp/export.pdf", dataBase64: "JVBERg==", overwrite: true, requestId: "write-1" },
    });
    expect(tauriMocks.invokeMock).toHaveBeenNthCalledWith(5, "desktop_cancel_export_write", {
      requestId: "write-1",
    });
  });

  it("creates a new project window when none exists", async () => {
    tauriMocks.getByLabelMock.mockResolvedValueOnce(null);
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:1420/#/today"),
    });

    await desktopApi.openProjectWindow({
      projectId: 7,
      projectName: "Alpha Project",
      route: "/projects/7?focus=record-3",
    });

    expect(tauriMocks.webviewWindowInstances).toHaveLength(1);
    expect(tauriMocks.webviewWindowInstances[0]?.label).toBe("project-7");
    expect(tauriMocks.webviewWindowInstances[0]?.options).toMatchObject({
      width: 1680,
      height: 1024,
      minWidth: 640,
    });
    expect(tauriMocks.getCurrentWindowMock).toHaveBeenCalledTimes(1);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("focuses and navigates an existing project window", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const existingWindow = {
      show: vi.fn(async () => undefined),
      setFocus: vi.fn(async () => undefined),
      emit: vi.fn(async () => undefined),
    };
    tauriMocks.getByLabelMock.mockResolvedValue(existingWindow);

    await desktopApi.openProjectWindow({
      projectId: 7,
      projectName: "Alpha Project",
      route: "/projects/7",
    });

    expect(existingWindow.show).toHaveBeenCalledTimes(1);
    expect(existingWindow.setFocus).toHaveBeenCalledTimes(1);
    expect(existingWindow.emit).toHaveBeenCalledWith("project-window:navigate", {
      route: "/projects/7",
    });
    expect(tauriMocks.webviewWindowInstances).toHaveLength(0);
  });

  it("reports whether the current window is a project window", () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    tauriMocks.getCurrentWebviewWindowMock.mockReturnValueOnce({ label: "project-8" });
    expect(desktopApi.isProjectWindow()).toBe(true);

    tauriMocks.getCurrentWebviewWindowMock.mockReturnValueOnce({ label: "main" });
    expect(desktopApi.isProjectWindow()).toBe(false);
  });
});
