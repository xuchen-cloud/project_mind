import { beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "./desktopApi";
import { nativeFileIconApi } from "./nativeFileIconApi";

vi.mock("./desktopApi", () => ({ desktopApi: { fileCommand: vi.fn() } }));

describe("nativeFileIconApi.typeIcon", () => {
  beforeEach(() => { vi.mocked(desktopApi.fileCommand).mockReset(); });

  it("uses the file TYPE command and passes the caller's name unchanged", async () => {
    const png = "data:image/png;base64,aWNvbg==";
    vi.mocked(desktopApi.fileCommand).mockResolvedValue(png);
    expect(await nativeFileIconApi.typeIcon("C:\\files\\Drawing.CUSTOM")).toBe(png);
    expect(desktopApi.fileCommand).toHaveBeenCalledExactlyOnceWith("desktop_file_type_icon", { name: "C:\\files\\Drawing.CUSTOM" });
  });

  it("preserves the OS's null result", async () => {
    vi.mocked(desktopApi.fileCommand).mockResolvedValue(null);
    expect(await nativeFileIconApi.typeIcon("drawing.custom")).toBeNull();
  });

  it("propagates native failure to the presentation without swallowing it", async () => {
    const error = { code: "icon_unavailable", message: "System icon lookup failed" };
    vi.mocked(desktopApi.fileCommand).mockRejectedValue(error);
    await expect(nativeFileIconApi.typeIcon("drawing.custom")).rejects.toBe(error);
  });
});
