import { beforeEach, expect, it, vi } from "vitest";
import { fileDocumentApi } from "./fileDocumentApi";
import { desktopApi } from "./desktopApi";
vi.mock("./desktopApi", () => ({ desktopApi: { command: vi.fn() } }));
const binding = { workspaceId: "w", generation: "g" };
const object = { workspaceId: "w", scope: { kind: "project" as const, projectId: 2 }, kind: "file" as const, id: "7" };
beforeEach(() => vi.resetAllMocks());
it("sends bounded metadata and source pages bound to actual versions, hashes and workspace", async () => {
  vi.mocked(desktopApi.command).mockImplementation(async (_command, args) => ({ apiVersion: 1, requestId: (args!.input as { requestId: string }).requestId, ok: true, data: {} }));
  await fileDocumentApi.versionsList(binding, { object, cursor: 5, limit: 50 }, "list");
  expect(desktopApi.command).toHaveBeenLastCalledWith("file_versions_list", { input: { binding, requestId: "list", data: { object, cursor: 5, limit: 50 } } });
  await fileDocumentApi.versionGet(binding, { object, versionId: "12" }, "get");
  expect(desktopApi.command).toHaveBeenLastCalledWith("file_versions_get", { input: { binding, requestId: "get", data: { object, versionId: "12" } } });
  const data = { object, versionNumber: 2, expectedContentHash: "old-hash", cursor: "fixed-page", budgetChars: 4000 };
  await fileDocumentApi.sourceRead(binding, data, "source");
  expect(desktopApi.command).toHaveBeenLastCalledWith("file_source_read", { input: { binding, requestId: "source", data } });
});
it("preserves exact restore CAS and durable request identity", async () => {
  const result = { receipt: { documentId: 7, versionNumber: 6, contentHash: "actual", noChange: false }, versionPath: null };
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "restore", ok: true, data: result });
  const data = { object, versionId: "12", expectedVersionNumber: 5, expectedContentHash: "head-hash" };
  expect(await fileDocumentApi.restore(binding, data, "restore")).toEqual(result);
  expect(desktopApi.command).toHaveBeenCalledWith("file_version_restore", { input: { binding, requestId: "restore", data } });
});
it("surfaces a real CAS error rather than retrying", async () => {
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "restore", ok: false, error: { code: "REVISION_CONFLICT", message: "head changed", retryable: false } });
  await expect(fileDocumentApi.restore(binding, { object, versionId: "1", expectedVersionNumber: 2, expectedContentHash: "h" }, "restore")).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  expect(desktopApi.command).toHaveBeenCalledTimes(1);
});
