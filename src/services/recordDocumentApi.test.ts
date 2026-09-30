import { beforeEach, expect, it, vi } from "vitest";
import { recordDocumentApi } from "./recordDocumentApi";
import { desktopApi } from "./desktopApi";
vi.mock("./desktopApi", () => ({ desktopApi: { command: vi.fn() } }));
beforeEach(() => vi.resetAllMocks());
it("keeps native cut registration and claims bound to a specific Workspace generation and destination Record", async () => {
  const binding = { workspaceId: "workspace", generation: "opened" };
  const target = { scope: { kind: "project" as const, projectId: 3 }, recordId: 7 };
  const token = "11111111-1111-4111-8111-111111111111";
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "register", ok: true, data: null });
  await recordDocumentApi.cutRegister(binding, target, token, "register");
  expect(desktopApi.command).toHaveBeenCalledWith("record_cut_register", { input: { binding, requestId: "register", data: { target, token } } });
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "claim", ok: true, data: false });
  expect(await recordDocumentApi.cutClaim(binding, target, token, "claim")).toBe(false);
  expect(desktopApi.command).toHaveBeenLastCalledWith("record_cut_claim", { input: { binding, requestId: "claim", data: { target, token } } });
});
