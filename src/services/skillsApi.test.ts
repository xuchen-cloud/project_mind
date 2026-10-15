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
});
