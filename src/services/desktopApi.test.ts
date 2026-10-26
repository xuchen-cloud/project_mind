import { beforeEach, describe, expect, it, vi } from "vitest";
import voiceCaptionCapability from "../../src-tauri/capabilities/voice-caption.json";
import mainWindowCapability from "../../src-tauri/capabilities/default.json";
const tauriMocks = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  emitEventMock: vi.fn(async () => undefined),
  convertFileSrcMock: vi.fn((path: string) => `asset://${path}`),
  openMock: vi.fn(),
  saveMock: vi.fn(),
  askMock: vi.fn(),
  readClipboardTextMock: vi.fn(),
  readClipboardImageMock: vi.fn(),
  onCloseRequestedMock: vi.fn(),
  setMinSizeMock: vi.fn(async () => undefined),
  setSizeMock: vi.fn(async () => undefined),
  closeWindowMock: vi.fn(async () => undefined),
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
    setMinSize: tauriMocks.setMinSizeMock,
    setSize: tauriMocks.setSizeMock,
    close: tauriMocks.closeWindowMock,
    destroy: tauriMocks.destroyWindowMock,
  })),
  currentMonitorMock: vi.fn(async () => ({
    position: { x: 0, y: 0 },
    size: { width: 2880, height: 1800 },
    workArea: { position: { x: 0, y: 0 }, size: { width: 2880, height: 1720 } },
    scaleFactor: 2,
  })),
  getByLabelMock: vi.fn(),
  getAllWebviewWindowsMock: vi.fn(async () => []),
  webviewWindowInstances: [] as Array<{
    label: string;
    options?: Record<string, unknown>;
    once: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    setFocus: ReturnType<typeof vi.fn>;
  }>,
  getCurrentWebviewWindowMock: vi.fn(() => ({ label: "main", listen: vi.fn(async () => () => {}) })),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: tauriMocks.emitEventMock,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invokeMock,
  convertFileSrc: tauriMocks.convertFileSrcMock,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: tauriMocks.getCurrentWindowMock,
  currentMonitor: tauriMocks.currentMonitorMock,
  Effect: { Popover: "popover" },
  EffectState: { Active: "active" },
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
      getAllWebviewWindows: tauriMocks.getAllWebviewWindowsMock,
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
    tauriMocks.currentMonitorMock.mockClear();
    tauriMocks.onCloseRequestedMock.mockReset();
    tauriMocks.onCloseRequestedMock.mockResolvedValue(() => undefined);
    tauriMocks.setMinSizeMock.mockClear();
    tauriMocks.setSizeMock.mockClear();
    tauriMocks.closeWindowMock.mockClear();
    tauriMocks.destroyWindowMock.mockClear();
    tauriMocks.getByLabelMock.mockReset();
    tauriMocks.getAllWebviewWindowsMock.mockReset();
    tauriMocks.getAllWebviewWindowsMock.mockResolvedValue([]);
    tauriMocks.getCurrentWebviewWindowMock.mockReset();
    tauriMocks.getCurrentWebviewWindowMock.mockReturnValue({ label: "main", listen: vi.fn(async () => () => {}) });
    tauriMocks.webviewWindowInstances.length = 0;
  });

  it("broadcasts runtime events and propagates delivery failure", async () => {
    tauriMocks.emitEventMock.mockReset().mockResolvedValue(undefined);
    await desktopApi.emitEvent("voice:live-state", { type: "gone" });
    expect(tauriMocks.emitEventMock).toHaveBeenCalledWith("voice:live-state", { type: "gone" });
    const error = new Error("event delivery failed");
    tauriMocks.emitEventMock.mockRejectedValueOnce(error);
    await expect(desktopApi.emitEvent("voice:live-state", { type: "gone" })).rejects.toBe(error);
  });

  it("proxies command invocations through Tauri invoke", async () => {
    tauriMocks.invokeMock.mockResolvedValueOnce({ ok: true });

    await expect(desktopApi.command("projects_list", { input: { includeArchived: true } })).resolves.toEqual({ ok: true });
    expect(tauriMocks.invokeMock).toHaveBeenCalledWith("projects_list", {
      input: { includeArchived: true },
    });
  });

  it("cancels leaving without ending the recording", async () => {
    tauriMocks.invokeMock.mockResolvedValueOnce({ currentWorkspace: {} }).mockResolvedValueOnce({ sessionId: "voice", phase: "recording", revision: 1 });
    tauriMocks.askMock.mockResolvedValueOnce(false);
    expect(await desktopApi.prepareVoiceLeave()).toBe(false);
    expect(tauriMocks.invokeMock).not.toHaveBeenCalledWith("voice_end", expect.anything());
  });

  it("saves the current recording before allowing a lifecycle change", async () => {
    tauriMocks.invokeMock.mockResolvedValueOnce({ currentWorkspace: {} }).mockResolvedValueOnce({ sessionId: "voice", phase: "paused", revision: 3 });
    tauriMocks.askMock.mockResolvedValueOnce(true);
    expect(await desktopApi.prepareVoiceLeave()).toBe(true);
    expect(tauriMocks.invokeMock).toHaveBeenCalledWith("voice_end", { input: { sessionId: "voice", expectedRevision: 3, requestId: expect.any(String) } });
  });

  it("prevents native closing before awaiting the save barrier", async () => {
    let release!: (allow: boolean) => void;
    await desktopApi.listenForCloseRequest(() => new Promise<boolean>(resolve => { release = resolve; }));
    const handler = tauriMocks.onCloseRequestedMock.mock.calls[0][0];
    const preventDefault = vi.fn();
    const pending = handler({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    release(false);
    await pending;
  });

  it("exits the whole app after the main-window lifecycle barrier succeeds", async () => {
    const allowClose = vi.fn(async () => true);
    const unlisten = await desktopApi.listenForCloseRequest(allowClose);
    const handler = tauriMocks.onCloseRequestedMock.mock.calls[0]?.[0] as (
      event: { preventDefault: () => void },
    ) => Promise<void>;
    const preventDefault = vi.fn();

    await handler({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(allowClose).toHaveBeenCalledTimes(1);
    expect(tauriMocks.invokeMock).toHaveBeenCalledWith("app_exit");
    expect(unlisten).toBeTypeOf("function");
  });

  it("lets Tauri close only the current detached Project window", async () => {
    tauriMocks.getCurrentWebviewWindowMock.mockReturnValue({ label: "project-7" });
    const allowClose = vi.fn(async () => true);
    await desktopApi.listenForCloseRequest(allowClose);
    const handler = tauriMocks.onCloseRequestedMock.mock.calls[0]?.[0] as (
      event: { preventDefault: () => void },
    ) => Promise<void>;
    const preventDefault = vi.fn();

    await handler({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(tauriMocks.destroyWindowMock).toHaveBeenCalledOnce();
  });

  it("prevents a close request when the lifecycle barrier fails", async () => {
    const allowClose = vi.fn(async () => false);
    await desktopApi.listenForCloseRequest(allowClose);
    const handler = tauriMocks.onCloseRequestedMock.mock.calls[0]?.[0] as (
      event: { preventDefault: () => void },
    ) => Promise<void>;
    const preventDefault = vi.fn();

    await handler({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("flushes and then destroys detached Project windows for a Workspace switch", async () => {
    let responseHandler:
      | ((event: { payload: { requestId: string; windowLabel: string; ok: boolean } }) => void)
      | undefined;
    const currentWindow = {
      label: "main",
      listen: vi.fn(async (_event: string, handler: typeof responseHandler) => {
        responseHandler = handler;
        return () => undefined;
      }),
    };
    const projectWindow = {
      label: "project-7",
      emit: vi.fn(async (_event: string, request: { requestId: string }) => {
        responseHandler?.({
          payload: {
            requestId: request.requestId,
            windowLabel: "project-7",
            ok: true,
          },
        });
      }),
      destroy: vi.fn(async () => undefined),
    };
    tauriMocks.getCurrentWebviewWindowMock.mockReturnValue(currentWindow);
    tauriMocks.getAllWebviewWindowsMock.mockResolvedValue([
      currentWindow,
      projectWindow,
    ]);

    await desktopApi.flushOtherWorkspaceWindows();
    await desktopApi.destroyOtherWorkspaceWindows();

    expect(projectWindow.emit).toHaveBeenCalledWith(
      "workspace-lifecycle:flush-request",
      expect.objectContaining({ requesterLabel: "main" }),
    );
    expect(projectWindow.destroy).toHaveBeenCalledTimes(1);
  });

  it("responds to a Workspace lifecycle flush request from another window", async () => {
    let requestHandler:
      | ((event: { payload: { requestId: string; requesterLabel: string } }) => Promise<void>)
      | undefined;
    const projectWindow = {
      label: "project-7",
      listen: vi.fn(async (_event: string, handler: typeof requestHandler) => {
        requestHandler = handler;
        return () => undefined;
      }),
    };
    const mainWindow = { emit: vi.fn(async () => undefined) };
    tauriMocks.getCurrentWebviewWindowMock.mockReturnValue(projectWindow);
    tauriMocks.getByLabelMock.mockResolvedValue(mainWindow);
    const flush = vi.fn(async () => undefined);

    await desktopApi.listenForWorkspaceLifecycleFlush(flush);
    await requestHandler?.({
      payload: { requestId: "request-1", requesterLabel: "main" },
    });

    expect(flush).toHaveBeenCalledTimes(1);
    expect(mainWindow.emit).toHaveBeenCalledWith(
      "workspace-lifecycle:flush-response",
      {
        requestId: "request-1",
        windowLabel: "project-7",
        ok: true,
      },
    );
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

  it("prints the format document through the isolated native host", async () => {
    const input = { html: "<p>文档正文</p>", title: "项目材料", pageSize: {widthPt: 595.28, heightPt: 841.89} };
    tauriMocks.invokeMock.mockResolvedValueOnce(undefined);
    await expect(desktopApi.printEditorHtml(input)).resolves.toBeUndefined();
    expect(tauriMocks.invokeMock).toHaveBeenCalledExactlyOnceWith("desktop_print_editor_html", { input });
  });

  it("renders PDF through the isolated native host without accepting a file path", async () => {
    const input = { html: "<p>文档正文</p>", title: "项目材料", pageSize: {widthPt: 720, heightPt: 405} };
    tauriMocks.invokeMock.mockResolvedValueOnce("JVBERg==");
    await expect(desktopApi.renderEditorPdf(input)).resolves.toBe("JVBERg==");
    expect(tauriMocks.invokeMock).toHaveBeenCalledExactlyOnceWith("desktop_render_editor_pdf", { input });
  });

  it("reads exact installed-font metrics and preserves a missing family", async () => {
    const metrics = { unitsPerEm: 2048, hheaAscender: 1900, hheaDescender: -500, hheaLineGap: 0,
      typoAscender: 1600, typoDescender: -400, typoLineGap: 200,
      winAscent: 2000, winDescent: 600, useTypoMetrics: true };
    tauriMocks.invokeMock.mockResolvedValueOnce(metrics).mockResolvedValueOnce(null);
    await expect(desktopApi.editorFontMetrics("Arial")).resolves.toEqual(metrics);
    await expect(desktopApi.editorFontMetrics("Missing family")).resolves.toBeNull();
    expect(tauriMocks.invokeMock).toHaveBeenNthCalledWith(1, "desktop_editor_font_metrics", { family: "Arial" });
    expect(tauriMocks.invokeMock).toHaveBeenNthCalledWith(2, "desktop_editor_font_metrics", { family: "Missing family" });
  });

  it("inspects selected workbook bytes through the read-only native import boundary", async () => {
    const input = {base64: "UEsDBA=="};
    const model = {format: "xlsx", name: "selected.xlsx"};
    tauriMocks.invokeMock.mockResolvedValueOnce(model);
    await expect(desktopApi.inspectImportedWorkbook(input)).resolves.toBe(model);
    expect(tauriMocks.invokeMock).toHaveBeenCalledExactlyOnceWith("desktop_inspect_imported_workbook", {input});
  });

  it("lists screenshot choices only on request and captures the selected opaque choice", async () => {
    const sources = {status: "ok", sources: [{id: "opaque-choice", name: "窗口", kind: "window", thumbnail: "data:image/png;base64,AA=="}]};
    const image = {mediaType: "image/png", base64: "iVBORw==", width: 320, height: 180};
    expect(tauriMocks.invokeMock).not.toHaveBeenCalled();
    tauriMocks.invokeMock.mockResolvedValueOnce(sources).mockResolvedValueOnce(image).mockResolvedValueOnce(null);
    await expect(desktopApi.editorCaptureSources()).resolves.toBe(sources);
    await expect(desktopApi.editorCaptureSource({id: "opaque-choice"})).resolves.toBe(image);
    await expect(desktopApi.editorCaptureSource({id: "vanished-choice"})).resolves.toBeNull();
    expect(tauriMocks.invokeMock).toHaveBeenNthCalledWith(1, "desktop_editor_capture_sources");
    expect(tauriMocks.invokeMock).toHaveBeenNthCalledWith(2, "desktop_editor_capture_source", {input: {id: "opaque-choice"}});
    expect(tauriMocks.invokeMock).toHaveBeenNthCalledWith(3, "desktop_editor_capture_source", {input: {id: "vanished-choice"}});
  });

  it("preserves screenshot permission denial and native failures", async () => {
    const denied = {status: "denied", sources: []};
    tauriMocks.invokeMock.mockResolvedValueOnce(denied).mockRejectedValueOnce("窗口已关闭");
    await expect(desktopApi.editorCaptureSources()).resolves.toBe(denied);
    await expect(desktopApi.editorCaptureSource({id: "opaque-choice"})).rejects.toBe("窗口已关闭");
  });

  it("creates a new project window when none exists", async () => {
    tauriMocks.getByLabelMock.mockResolvedValueOnce(null);
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:1420/#/workspace"),
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

  it("opens one small always-on-top caption window near the display bottom", async () => {
    tauriMocks.getByLabelMock.mockResolvedValueOnce(null);
    await desktopApi.openVoiceCaptionWindow();
    expect(tauriMocks.webviewWindowInstances).toHaveLength(1);
    expect(tauriMocks.webviewWindowInstances[0]).toMatchObject({
      label: "voice-caption",
      options: {
        url: expect.stringContaining("voice.html"),
        alwaysOnTop: true,
        transparent: true,
        decorations: false,
        shadow: false,
        theme: "light",
        width: 680,
        height: 220,
        x: 380,
        y: 610,
      },
    });
    expect(tauriMocks.webviewWindowInstances[0]?.options).not.toHaveProperty("windowEffects");
    expect(tauriMocks.invokeMock).toHaveBeenCalledWith("voice_caption_apply_material");
    const existing = {
      show: vi.fn(),
      setFocus: vi.fn(),
      setTheme: vi.fn(async () => {
        if (!mainWindowCapability.permissions.includes("core:window:allow-set-theme")) {
          throw new Error("window.set_theme not allowed");
        }
      }),
    };
    tauriMocks.getByLabelMock.mockResolvedValueOnce(existing);
    await desktopApi.openVoiceCaptionWindow();
    expect(tauriMocks.webviewWindowInstances).toHaveLength(1);
    expect(existing.show).toHaveBeenCalledOnce();
    expect(existing.setTheme).toHaveBeenCalledWith("light");
    expect(existing.setFocus).not.toHaveBeenCalled();
  });

  it("opens a compact light window immediately when recognition is disabled", async () => {
    tauriMocks.getByLabelMock.mockResolvedValueOnce(null);
    tauriMocks.invokeMock.mockResolvedValueOnce({ speechProfile: null, captionLines: 4 });
    await desktopApi.openVoiceCaptionWindow();
    expect(tauriMocks.webviewWindowInstances[0]?.options).toMatchObject({
      width: 160,
      height: 48,
      minWidth: 160,
      minHeight: 48,
      theme: "light",
      url: expect.stringContaining("audioOnly=1"),
    });
  });

  it("lowers the minimum size before collapsing and restores it after expanding", async () => {
    await desktopApi.captionWindowSetSize(190, 48);
    expect(tauriMocks.setMinSizeMock.mock.invocationCallOrder[0]).toBeLessThan(tauriMocks.setSizeMock.mock.invocationCallOrder[0]);
    expect(tauriMocks.setMinSizeMock).toHaveBeenCalledWith(expect.objectContaining({ width: 190, height: 48 }));

    tauriMocks.setMinSizeMock.mockClear();
    tauriMocks.setSizeMock.mockClear();
    await desktopApi.captionWindowSetSize(680, 220);
    expect(tauriMocks.setSizeMock.mock.invocationCallOrder[0]).toBeLessThan(tauriMocks.setMinSizeMock.mock.invocationCallOrder[0]);
    expect(tauriMocks.setMinSizeMock).toHaveBeenCalledWith(expect.objectContaining({ width: 380, height: 72 }));
  });

  it("allows the caption window to change its minimum size", () => {
    expect(voiceCaptionCapability.permissions).toContain("core:window:allow-set-min-size");
  });

  it("forces the caption window to close even when close requests are intercepted", async () => {
    await desktopApi.captionWindowClose();
    expect(tauriMocks.destroyWindowMock).toHaveBeenCalledOnce();
    expect(tauriMocks.closeWindowMock).not.toHaveBeenCalled();
  });

  it("closes the independent caption window from the main recording controls", async () => {
    tauriMocks.getByLabelMock.mockResolvedValueOnce({ destroy: tauriMocks.destroyWindowMock });
    await desktopApi.closeVoiceCaptionWindow();
    expect(tauriMocks.getByLabelMock).toHaveBeenCalledWith("voice-caption");
    expect(tauriMocks.destroyWindowMock).toHaveBeenCalledOnce();
  });

  it("accepts a caption that closes itself between lookup and destruction", async () => {
    const caption = { destroy: vi.fn().mockRejectedValue(new Error("window not found")) };
    tauriMocks.getByLabelMock.mockResolvedValueOnce(caption).mockResolvedValueOnce(null);

    await expect(desktopApi.closeVoiceCaptionWindow()).resolves.toBeUndefined();

    expect(caption.destroy).toHaveBeenCalledOnce();
    expect(tauriMocks.getByLabelMock).toHaveBeenCalledTimes(2);
  });

  it("reports a destruction failure when the caption is still present", async () => {
    const failure = new Error("window destruction failed");
    const caption = { destroy: vi.fn().mockRejectedValue(failure) };
    tauriMocks.getByLabelMock.mockResolvedValue(caption);

    await expect(desktopApi.closeVoiceCaptionWindow()).rejects.toBe(failure);

    expect(caption.destroy).toHaveBeenCalledOnce();
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

    tauriMocks.getCurrentWebviewWindowMock.mockReturnValueOnce({ label: "main", listen: vi.fn(async () => () => {}) });
    expect(desktopApi.isProjectWindow()).toBe(false);
  });
});


it('maps Word remote image reads to a fixed File command and preserves native failures', async () => {
  const input = {binding: {workspaceId: 'w', generation: 'g'}, document: {object: {workspaceId: 'w', scope: {kind: 'project' as const, projectId: 7}, kind: 'file' as const, id: '42'}, versionNumber: 2, expectedContentHash: 'sha256:source'}, url: 'https://images.example.test/a.png'};
  const result = {mime: 'image/png' as const, base64: 'aW1hZ2U='};
  tauriMocks.invokeMock.mockResolvedValueOnce(result);
  await expect(desktopApi.fetchEditorRemoteImage(input)).resolves.toBe(result);
  expect(tauriMocks.invokeMock).toHaveBeenLastCalledWith('desktop_fetch_editor_remote_image', {input});
  const failure = {code: 'blocked_target', message: '图片地址不是公开网络地址'};
  tauriMocks.invokeMock.mockRejectedValueOnce(failure);
  await expect(desktopApi.fetchEditorRemoteImage(input)).rejects.toBe(failure);
});
