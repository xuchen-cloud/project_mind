import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  convertFileSrcMock: vi.fn((path: string) => `asset://${path}`),
  openMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invokeMock,
  convertFileSrc: tauriMocks.convertFileSrcMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: tauriMocks.openMock,
}));

import { desktopApi } from "./desktopApi";

describe("desktopApi", () => {
  beforeEach(() => {
    tauriMocks.invokeMock.mockReset();
    tauriMocks.openMock.mockReset();
    tauriMocks.convertFileSrcMock.mockClear();
  });

  it("proxies command invocations through Tauri invoke", async () => {
    tauriMocks.invokeMock.mockResolvedValueOnce({ ok: true });

    await expect(desktopApi.command("projects_list", { input: { includeArchived: true } })).resolves.toEqual({ ok: true });
    expect(tauriMocks.invokeMock).toHaveBeenCalledWith("projects_list", {
      input: { includeArchived: true },
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
});
