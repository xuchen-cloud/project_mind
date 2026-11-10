import { beforeEach, expect, it, vi } from "vitest";
import { fileDocumentApi } from "./fileDocumentApi";
import { desktopApi } from "./desktopApi";
vi.mock("./desktopApi", () => ({ desktopApi: { command: vi.fn() } }));
const binding = { workspaceId: "w", generation: "g" };
const object = { workspaceId: "w", scope: { kind: "project" as const, projectId: 2 }, kind: "file" as const, id: "7" };
beforeEach(() => vi.resetAllMocks());
it("sends bounded metadata and source pages bound to actual versions, hashes and workspace", async () => {
  vi.mocked(desktopApi.command).mockImplementation(async (command, args) => ({ apiVersion: 1, requestId: (args!.input as { requestId: string }).requestId, ok: true,
    data: command === "file_versions_list" ? { object, versions: [] } : command === "file_versions_get" ? { object, version: { id: "12" } } : {} }));
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

it("updates version labels through the frozen ApiResponse envelope and metadata CAS", async () => {
  const result = { object, versionId: "12", displayName: "评审版", isImportant: true, metadataRevision: 4 };
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "labels", ok: true, data: result });
  const data = { object, versionId: "12", expectedMetadataRevision: 3, displayName: "评审版", isImportant: true };
  expect(await fileDocumentApi.versionMetadataUpdate(binding, data, "labels")).toEqual(result);
  expect(desktopApi.command).toHaveBeenCalledExactlyOnceWith("file_version_metadata_update", { input: { binding, requestId: "labels", data } });
});

it.each(["REVISION_CONFLICT", "SCOPE_DENIED", "WORKSPACE_CHANGED"])("preserves typed metadata failure %s and details without retry", async code => {
  const details = { versionId: "12", metadataRevision: 9 };
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "labels", ok: false,
    error: { code, message: "metadata rejected", retryable: false, details } });
  await expect(fileDocumentApi.versionMetadataUpdate(binding, { object, versionId: "12", expectedMetadataRevision: 3,
    displayName: null, isImportant: false }, "labels")).rejects.toMatchObject({ code, message: "metadata rejected", details });
  expect(desktopApi.command).toHaveBeenCalledTimes(1);
});

it("carries authoritative labels and a frozen edit target through both version projections", async () => {
  const version = { id: "12", versionNumber: 2, name: "physical.txt", createdAt: "2026-11-10", contentHash: "h",
    isCurrent: false, displayName: null, isImportant: false, metadataRevision: 0 };
  const workspaceObject = { ...object, scope: { kind: "workspace" as const } };
  const currentBinding = { ...binding };
  vi.mocked(desktopApi.command).mockImplementation(async (command, args) => ({ apiVersion: 1,
    requestId: (args!.input as { requestId: string }).requestId, ok: true,
    data: { object: workspaceObject, currentVersionNumber: 3, currentContentHash: "head", ...(command === "file_versions_list" ? { versions: [version], nextCursor: null } : { version }) } }));
  const page = await fileDocumentApi.versionsList(currentBinding, { object: workspaceObject }, "list");
  const fixed = await fileDocumentApi.versionGet(currentBinding, { object: workspaceObject, versionId: "12" }, "get");
  currentBinding.generation = "new-generation";
  for (const item of [page.versions[0], fixed.version]) {
    expect(item).toMatchObject({ ...version, metadataTarget: { binding, object: workspaceObject } });
    expect(item.metadataTarget?.object).not.toBe(workspaceObject);
    expect({ ...item }.metadataTarget).toEqual({ binding, object: workspaceObject });
  }
});
