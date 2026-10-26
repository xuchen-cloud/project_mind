import { beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "./desktopApi";
import { fileBytes, projectFileApi, ProjectFileError } from "./projectFileApi";
import type { FileBytesResult } from "../lib/file-types";
vi.mock("./desktopApi", () => ({ desktopApi: { fileCommand: vi.fn() } }));
const binding = { workspaceId: "workspace", generation: "current" };
const object = { workspaceId: "workspace", scope: { kind: "project" as const, projectId: 2 }, kind: "file" as const, id: "17" };
describe("fixed File version bytes", () => {
  beforeEach(() => { vi.mocked(desktopApi.fileCommand).mockReset(); });
  it("sends a null baseline only with the explicit legacy registration action", async () => {
    await projectFileApi.reconcile(binding, object, "资料/旧文件.txt", 1, null, "registration");
    expect(desktopApi.fileCommand).toHaveBeenCalledWith("project_file_reconcile", {
      binding, object, relativePath: "资料/旧文件.txt", expectedVersionNumber: 1, expectedContentHash: null, confirmation: "registration",
    });
  });
  it("sends the workspace generation and exact registered version and decodes binary without UTF-8 loss", async () => {
    const result: FileBytesResult = { object, versionNumber: 3, contentHash: "sha256:known", name: "binary.dat", mime: "application/octet-stream", byteLength: 4, base64: "AP+AKg==" };
    vi.mocked(desktopApi.fileCommand).mockResolvedValue(result);
    const input = { object, versionNumber: 3, expectedContentHash: result.contentHash };
    expect(fileBytes(await projectFileApi.readBytes(binding, input))).toEqual(new Uint8Array([0, 255, 128, 42]));
    expect(desktopApi.fileCommand).toHaveBeenCalledWith("project_file_read_bytes", { binding, input });
  });
  it("preserves the missing snapshot error code for the preview unavailable state", async () => {
    vi.mocked(desktopApi.fileCommand).mockRejectedValue({ code: "snapshot_missing", message: "Historical snapshot is missing" });
    const request = projectFileApi.readBytes(binding, { object, versionNumber: 3, expectedContentHash: "sha256:known" });
    await expect(request).rejects.toBeInstanceOf(ProjectFileError);
    await expect(request).rejects.toMatchObject({ code: "snapshot_missing", message: "Historical snapshot is missing" });
  });
  it("binds application lookup and selection to the current File without a version or client path", async () => {
    vi.mocked(desktopApi.fileCommand).mockResolvedValueOnce([{ id: "native-handler", name: "Viewer", icon: null, isDefault: true }]);
    expect(await projectFileApi.applications(binding, object)).toEqual([{ id: "native-handler", name: "Viewer", icon: null, isDefault: true }]);
    expect(desktopApi.fileCommand).toHaveBeenLastCalledWith("project_file_applications", { binding, object });
    await projectFileApi.openWith(binding, object, "native-handler");
    expect(desktopApi.fileCommand).toHaveBeenLastCalledWith("project_file_open_with", { binding, object, applicationId: "native-handler" });
  });
});
