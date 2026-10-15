import { beforeEach, expect, it, vi } from "vitest";
import { renameCanonicalRecord } from "./canonical-record-metadata";
import { recordDocumentApi } from "../services/recordDocumentApi";
vi.mock("../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn(), metadataGet: vi.fn(), metadataUpdate: vi.fn() } }));
const binding = { workspaceId: "workspace", generation: "opened" };
const target = { scope: { kind: "workspace" as const }, recordId: 7 };
beforeEach(() => { vi.resetAllMocks(); vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding); });
it("renames against the current metadata and preserves its tags without sending a body", async () => {
  vi.mocked(recordDocumentApi.metadataGet).mockResolvedValue({ title: "Old", tagIds: [9], revision: "current", updatedAt: "now" });
  await renameCanonicalRecord("/workspace",target," New title ");
  expect(recordDocumentApi.metadataUpdate).toHaveBeenCalledWith(binding,{
    target,title: "New title",tagIds: [9],expectedRevision: "current",
  },expect.any(String));
});
it("rejects a stale Workspace before reading or writing metadata", async () => {
  vi.mocked(recordDocumentApi.bindingGet).mockRejectedValue(new Error("WORKSPACE_CHANGED"));
  await expect(renameCanonicalRecord("/workspace",target,"Title")).rejects.toThrow("WORKSPACE_CHANGED");
  expect(recordDocumentApi.metadataGet).not.toHaveBeenCalled();
  expect(recordDocumentApi.metadataUpdate).not.toHaveBeenCalled();
});
