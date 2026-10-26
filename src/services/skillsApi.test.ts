import { beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "./desktopApi";
import { skillsApi } from "./skillsApi";

vi.mock("./desktopApi", () => ({ desktopApi: { command: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());

describe("skillsApi", () => {
  it("requests workspace or native project catalogs and preserves builtin entries", async () => {
    const catalog = { skills: [{ name: "CLI", description: "Builtin", path: null, source: "builtin" }], directories: [], complete: true };
    vi.mocked(desktopApi.command).mockResolvedValue(catalog);
    expect(await skillsApi.list()).toBe(catalog);
    expect(desktopApi.command).toHaveBeenLastCalledWith("skills_list", { projectId: null });
    expect(await skillsApi.list(7)).toBe(catalog);
    expect(desktopApi.command).toHaveBeenLastCalledWith("skills_list", { projectId: 7 });
  });
  it("propagates discovery errors for the panel to report", async () => {
    vi.mocked(desktopApi.command).mockRejectedValue(new Error("unavailable"));
    await expect(skillsApi.list(null)).rejects.toThrow("unavailable");
  });
  it("sends management actions with the selected context and propagates failures", async () => {
    const catalog = { skills: [], directories: [], complete: true };
    vi.mocked(desktopApi.command).mockResolvedValue(catalog);
    expect(await skillsApi.manage(7, "/skills/example", "disable")).toBe(catalog);
    expect(desktopApi.command).toHaveBeenLastCalledWith("skills_manage", { projectId: 7, entryPath: "/skills/example", action: "disable" });
    vi.mocked(desktopApi.command).mockRejectedValue(new Error("cannot move"));
    await expect(skillsApi.manage(null, "/skills/.disabled/example", "enable")).rejects.toThrow("cannot move");
  });
});

it("passes refresh and cancellation identity to the existing native command", async () => {
  vi.mocked(desktopApi.command).mockResolvedValue(null);
  await skillsApi.list(7, { requestId: "scan-1", refresh: true });
  expect(desktopApi.command).toHaveBeenLastCalledWith("skills_list", { projectId: 7, requestId: "scan-1", refresh: true });
  await skillsApi.cancel("scan-1");
  expect(desktopApi.command).toHaveBeenLastCalledWith("skills_list", { requestId: "scan-1", cancel: true });
});
