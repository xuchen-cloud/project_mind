import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  documentImportNoteImage: vi.fn(),
  documentImportClipboardNoteImage: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: apiMocks,
}));

import { buildProjectNoteImageAssetHandlers } from "./noteImageAssets";

describe("buildProjectNoteImageAssetHandlers", () => {
  beforeEach(() => {
    apiMocks.documentImportNoteImage.mockReset();
    apiMocks.documentImportClipboardNoteImage.mockReset();
  });

  it("imports pasted native-path images through the file-backed note image command", async () => {
    apiMocks.documentImportNoteImage.mockResolvedValueOnce({
      id: 31,
      name: "clip.png",
      managedPath: "/tmp/managed/clip.png",
      originalPath: "/tmp/original/clip.png",
      mimeType: "image/png",
    });

    const handlers = buildProjectNoteImageAssetHandlers(7, 12);
    const file = new File(["fake"], "clip.png", { type: "image/png" });
    Object.defineProperty(file, "path", {
      configurable: true,
      value: "/tmp/source/clip.png",
    });

    const asset = await handlers.insertPastedImage?.(file);

    expect(apiMocks.documentImportNoteImage).toHaveBeenCalledWith({
      projectId: 7,
      activityId: 12,
      sourcePath: "/tmp/source/clip.png",
    });
    expect(apiMocks.documentImportClipboardNoteImage).not.toHaveBeenCalled();
    expect(asset).toEqual({
      kind: "image",
      title: "clip.png",
      path: "/tmp/managed/clip.png",
      mimeType: "image/png",
      documentId: 31,
    });
  });

  it("uploads clipboard-only images through the dedicated clipboard command", async () => {
    apiMocks.documentImportClipboardNoteImage.mockResolvedValueOnce({
      id: 32,
      name: "pasted.png",
      managedPath: "/tmp/managed/pasted.png",
      originalPath: "/tmp/managed/pasted.png",
      mimeType: "image/png",
    });

    const handlers = buildProjectNoteImageAssetHandlers(8, 15);
    const file = new File(["hello"], "pasted.png", { type: "image/png" });

    const asset = await handlers.insertPastedImage?.(file);

    expect(apiMocks.documentImportClipboardNoteImage).toHaveBeenCalledWith({
      projectId: 8,
      activityId: 15,
      fileName: "pasted.png",
      mimeType: "image/png",
      dataBase64: "aGVsbG8=",
    });
    expect(asset).toEqual({
      kind: "image",
      title: "pasted.png",
      path: "/tmp/managed/pasted.png",
      mimeType: "image/png",
      documentId: 32,
    });
  });
});
