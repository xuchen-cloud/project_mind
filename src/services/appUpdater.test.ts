import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetVersion, mockCheck, mockDownloadAndInstall, mockRelaunch } = vi.hoisted(() => ({
  mockGetVersion: vi.fn(),
  mockCheck: vi.fn(),
  mockDownloadAndInstall: vi.fn(),
  mockRelaunch: vi.fn(),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: mockGetVersion,
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: mockCheck,
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: mockRelaunch,
}));

import { tauriAppUpdater } from "./appUpdater";

describe("tauriAppUpdater", () => {
  beforeEach(() => {
    mockGetVersion.mockReset();
    mockCheck.mockReset();
    mockDownloadAndInstall.mockReset();
    mockRelaunch.mockReset();
  });

  it("checks, installs, and relaunches through the Tauri updater boundary", async () => {
    mockGetVersion.mockResolvedValue("0.1.0");
    mockCheck.mockResolvedValue({
      version: "0.2.0-beta.1",
      body: "Beta update",
      downloadAndInstall: mockDownloadAndInstall,
    });

    await expect(tauriAppUpdater.currentVersion()).resolves.toBe("0.1.0");
    const update = await tauriAppUpdater.check();

    expect(update).toEqual({ version: "0.2.0-beta.1", notes: "Beta update" });
    await tauriAppUpdater.install(update!);

    expect(mockDownloadAndInstall).toHaveBeenCalledOnce();
    expect(mockRelaunch).toHaveBeenCalledOnce();
  });
});
