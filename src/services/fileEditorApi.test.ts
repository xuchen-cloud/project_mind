import { beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "./desktopApi";
import { fileEditorApi } from "./fileEditorApi";

vi.mock("./desktopApi", () => ({ desktopApi: { command: vi.fn() } }));
const binding = { workspaceId: "w", generation: "g" };
const object = { workspaceId: "w", scope: { kind: "project" as const, projectId: 2 }, kind: "file" as const, id: "7" };
beforeEach(() => vi.clearAllMocks());
it("sends only the matching File and uses the move request identity for its seal", async () => {
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "move", ok: true, data: null });
  await fileEditorApi.flush(binding, object, "move");
  expect(desktopApi.command).toHaveBeenCalledExactlyOnceWith("file_editors_flush", { input: { binding, requestId: "move", data: object } });
});
it("preserves structured failures so an unsuccessful save cannot be reported as ready", async () => {
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "reply", ok: false,
    error: { code: "EDITOR_BUSY", message: "仍在编辑", retryable: true } });
  await expect(fileEditorApi.reply(binding, { object, editorId: "a", flushId: "f", outcome: "busy" }, "reply")).rejects.toMatchObject({ code: "EDITOR_BUSY" });
});
