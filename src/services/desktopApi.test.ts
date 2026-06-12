import { beforeEach, describe, expect, it, vi } from "vitest";
const tauriMocks = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  convertFileSrcMock: vi.fn((path: string) => `asset://${path}`),
  openMock: vi.fn(),
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
    tauriMocks.convertFileSrcMock.mockClear();
    tauriMocks.getCurrentWindowMock.mockClear();
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
      minWidth: 736,
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
