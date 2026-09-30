import { beforeEach, describe, expect, it, vi } from "vitest";
import { CanonicalQuickNoteTransfer } from "./canonical-quick-note-transfer";
import { recordDocumentApi } from "../services/recordDocumentApi";
import { requestProjectRecordFocusSave } from "./record-focus-save";

vi.mock("../services/recordDocumentApi", () => ({ recordDocumentApi: {
  bindingGet: vi.fn(), editorsFlush: vi.fn(), quickNoteTransfer: vi.fn(),
} }));
vi.mock("./record-focus-save", () => ({
  requestProjectRecordFocusSave: vi.fn(), requestWorkspaceRecordFocusSave: vi.fn(),
}));
const binding = { workspaceId: "workspace-a", generation: "generation-a" };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding);
  vi.mocked(requestProjectRecordFocusSave).mockReturnValue("submitted");
});
describe("canonical QuickNote transfer", () => {
  it("flushes the target and uses its current metadata instead of cached Record tags", async () => {
    const order: string[] = [];
    const flush = vi.fn(async () => { order.push("flush"); });
    vi.mocked(recordDocumentApi.editorsFlush).mockImplementation(async () => {
      order.push("read");
      return { head: { headRevision: 4 }, metadata: { revision: "metadata-4", tagIds: [9] } } as never;
    });
    vi.mocked(recordDocumentApi.quickNoteTransfer).mockResolvedValue({} as never);
    const transfer = new CanonicalQuickNoteTransfer();
    await transfer.commit({ workspaceRoot: "/workspace/a", scope: { kind: "project", projectId: 2 },
      target: { kind: "append", recordId: 7 }, markdown: "Idea", title: "Idea",
      resolveTagIds: async () => [3, 9], coordinator: { flush } as never,
    }, { requestId: "append-1" });
    expect(order).toEqual(["flush", "read"]);
    expect(flush).toHaveBeenCalledWith("project:2:7");
    expect(recordDocumentApi.quickNoteTransfer).toHaveBeenCalledWith(binding, {
      scope: { kind: "project", projectId: 2 }, recordId: 7, baseRevision: 4,
      metadataRevision: "metadata-4", expectedMarkdown: "Idea", title: "Idea", tagIds: [9, 3],
    }, "append-1");
  });

  it("keeps the original binding and payload when retrying a lost response", async () => {
    vi.mocked(recordDocumentApi.quickNoteTransfer).mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({} as never);
    const resolveTagIds = vi.fn(async () => [3]);
    const options = { workspaceRoot: "/workspace/a", scope: { kind: "workspace" as const },
      target: { kind: "new" as const }, markdown: "Idea", title: "Idea", resolveTagIds, coordinator: null };
    const transfer = new CanonicalQuickNoteTransfer();
    await expect(transfer.commit(options, { requestId: "new-1" })).rejects.toThrow("response lost");
    await transfer.commit({ ...options, workspaceRoot: "/workspace/b" }, { requestId: "new-1" });
    expect(recordDocumentApi.bindingGet).toHaveBeenCalledTimes(1);
    expect(resolveTagIds).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(recordDocumentApi.quickNoteTransfer).mock.calls;
    expect(calls[0]).toEqual(calls[1]);
  });

  it("does not resolve tags or submit when the Workspace binding changed", async () => {
    vi.mocked(recordDocumentApi.bindingGet).mockRejectedValue(new Error("WORKSPACE_CHANGED"));
    const resolveTagIds = vi.fn(async () => []);
    await expect(new CanonicalQuickNoteTransfer().commit({
      workspaceRoot: "/workspace/a", scope: { kind: "workspace" }, target: { kind: "new" },
      markdown: "Idea", title: null, resolveTagIds, coordinator: null,
    }, { requestId: "new-1" })).rejects.toThrow("WORKSPACE_CHANGED");
    expect(resolveTagIds).not.toHaveBeenCalled();
    expect(recordDocumentApi.quickNoteTransfer).not.toHaveBeenCalled();
  });
});
