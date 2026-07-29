import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  documentImport: vi.fn(),
  documentImportNoteImage: vi.fn(),
  documentImportClipboardNoteImage: vi.fn(),
  workspaceNoteImageImport: vi.fn(),
  workspaceClipboardNoteImageImport: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: apiMocks,
}));

vi.mock("../../services/desktopApi", () => ({
  desktopApi: {
    toFileUrl: vi.fn((path: string) => `asset://${path}`),
  },
}));

import {
  buildProjectNoteImageAssetHandlers,
  buildWorkspaceNoteImageAssetHandlers,
  externalizeEmbeddedImageDataUrls,
} from "./noteImageAssets";

describe("buildProjectNoteImageAssetHandlers", () => {
  beforeEach(() => {
    apiMocks.documentImport.mockReset();
    apiMocks.documentImportNoteImage.mockReset();
    apiMocks.documentImportClipboardNoteImage.mockReset();
    apiMocks.workspaceNoteImageImport.mockReset();
    apiMocks.workspaceClipboardNoteImageImport.mockReset();
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

  it("imports regular files as project documents for attachment references", async () => {
    apiMocks.documentImport.mockResolvedValueOnce({
      id: 42,
      name: "brief.pdf",
      managedPath: "/tmp/project/brief.pdf",
      originalPath: "/tmp/source/brief.pdf",
      mimeType: "application/pdf",
      isStarred: false,
    });

    const handlers = buildProjectNoteImageAssetHandlers(9, 16);
    const asset = await handlers.insertFile?.("/tmp/source/brief.pdf");

    expect(apiMocks.documentImport).toHaveBeenCalledWith({
      projectId: 9,
      activityId: 16,
      sourcePath: "/tmp/source/brief.pdf",
      isStarred: false,
      tagIds: [],
    });
    expect(asset).toEqual({
      kind: "file",
      title: "brief.pdf",
      path: "/tmp/project/brief.pdf",
      href: "file:///tmp/project/brief.pdf",
      mimeType: "application/pdf",
      documentId: 42,
      meta: "application/pdf",
      isStarred: false,
    });
  });
});

describe("buildWorkspaceNoteImageAssetHandlers", () => {
  beforeEach(() => {
    apiMocks.documentImport.mockReset();
    apiMocks.documentImportNoteImage.mockReset();
    apiMocks.documentImportClipboardNoteImage.mockReset();
    apiMocks.workspaceNoteImageImport.mockReset();
    apiMocks.workspaceClipboardNoteImageImport.mockReset();
  });

  it("imports workspace pasted native-path images as file-backed assets", async () => {
    apiMocks.workspaceNoteImageImport.mockResolvedValueOnce({
      title: "clip.png",
      path: "/tmp/workspace/.project-mind/embedded-note-assets/workspace/clip.png",
      mimeType: "image/png",
    });

    const handlers = buildWorkspaceNoteImageAssetHandlers();
    const file = new File(["fake"], "clip.png", { type: "image/png" });
    Object.defineProperty(file, "path", {
      configurable: true,
      value: "/tmp/source/clip.png",
    });

    const asset = await handlers.insertPastedImage?.(file);

    expect(apiMocks.workspaceNoteImageImport).toHaveBeenCalledWith({
      sourcePath: "/tmp/source/clip.png",
    });
    expect(apiMocks.workspaceClipboardNoteImageImport).not.toHaveBeenCalled();
    expect(asset).toEqual({
      kind: "image",
      title: "clip.png",
      path: "/tmp/workspace/.project-mind/embedded-note-assets/workspace/clip.png",
      mimeType: "image/png",
    });
    expect(handlers.insertFile).toBeUndefined();
  });

  it("uploads workspace clipboard-only images without embedding data urls in the editor", async () => {
    apiMocks.workspaceClipboardNoteImageImport.mockResolvedValueOnce({
      title: "pasted.png",
      path: "/tmp/workspace/.project-mind/embedded-note-assets/workspace/pasted.png",
      mimeType: "image/png",
    });

    const handlers = buildWorkspaceNoteImageAssetHandlers();
    const file = new File(["hello"], "pasted.png", { type: "image/png" });
    const asset = await handlers.insertPastedImage?.(file);

    expect(apiMocks.workspaceClipboardNoteImageImport).toHaveBeenCalledWith({
      fileName: "pasted.png",
      mimeType: "image/png",
      dataBase64: "aGVsbG8=",
    });
    expect(asset).toEqual({
      kind: "image",
      title: "pasted.png",
      path: "/tmp/workspace/.project-mind/embedded-note-assets/workspace/pasted.png",
      mimeType: "image/png",
    });
  });

  it("externalizes legacy embedded data-url images before saving workspace content", async () => {
    apiMocks.workspaceClipboardNoteImageImport.mockResolvedValueOnce({
      title: "legacy.png",
      path: "/tmp/workspace/.project-mind/embedded-note-assets/workspace/legacy.png",
      mimeType: "image/png",
    });

    const handlers = buildWorkspaceNoteImageAssetHandlers();
    const value = await externalizeEmbeddedImageDataUrls(
      {
        html: '<p><img src="data:image/png;base64,aGVsbG8=" alt="legacy" /></p>',
        text: "[图片] legacy",
        markdown: "[图片] legacy",
      },
      handlers,
    );

    expect(apiMocks.workspaceClipboardNoteImageImport).toHaveBeenCalledWith({
      fileName: "legacy.png",
      mimeType: "image/png",
      dataBase64: "aGVsbG8=",
    });
    expect(value.html).toContain('data-path="/tmp/workspace/.project-mind/embedded-note-assets/workspace/legacy.png"');
    expect(value.html).not.toContain("data:image/png;base64");
  });

  it("keeps saved workspace html small after five large embedded images", async () => {
    const insertPastedImage = vi.fn(async (file: File) => ({
      kind: "image" as const,
      title: file.name,
      path: `/tmp/workspace/.project-mind/embedded-note-assets/workspace/${file.name}`,
      mimeType: file.type,
    }));
    const largeImagePayload = "A".repeat(1_800_000);
    const largeImageHtml = Array.from(
      { length: 5 },
      (_, index) =>
        `<p><img src="data:image/png;base64,${largeImagePayload}" alt="large-${index + 1}" /></p>`,
    ).join("");

    const value = await externalizeEmbeddedImageDataUrls(
      {
        html: largeImageHtml,
        text: "[图片] ".repeat(5).trim(),
        markdown: "[图片] ".repeat(5).trim(),
      },
      { insertPastedImage },
    );

    expect(largeImageHtml.length).toBeGreaterThan(8_000_000);
    expect(insertPastedImage).toHaveBeenCalledTimes(5);
    expect(value.html).not.toContain("data:image/png;base64");
    expect(value.html).toContain(".project-mind/embedded-note-assets/workspace/large-5.png");
    expect(value.html.length).toBeLessThan(2_000);
  });
});
