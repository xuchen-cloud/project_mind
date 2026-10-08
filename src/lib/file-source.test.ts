import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileSourcePage } from "./file-types";
import { fileDocumentApi } from "../services/fileDocumentApi";
import { readCompleteFileSource } from "./file-source";

vi.mock("../services/fileDocumentApi", () => ({ fileDocumentApi: { sourceRead: vi.fn() } }));
const binding = { workspaceId: "workspace", generation: "generation" };
const object = { workspaceId: binding.workspaceId, scope: { kind: "project", projectId: 1 }, kind: "file", id: "7" } as const;
const input = { object, versionNumber: 2, expectedContentHash: "registered-hash" };
const chunks = ["\uFEFF<script>原😀", "文()</script>\r\n", "最后\n"];
const text = chunks.join("");
function pages(): FileSourcePage[] {
  let offset = 0;
  return chunks.map((chunk, index) => {
    const startChar = offset;
    offset += Array.from(chunk).length;
    return {
      object, versionNumber: 2, contentHash: input.expectedContentHash, title: "source.html", format: "html",
      byteLength: new TextEncoder().encode(text).byteLength, text: chunk, startChar, endChar: offset,
      totalChars: Array.from(text).length, nextCursor: index < chunks.length - 1 ? `page-${index + 1}` : null,
      complete: index === chunks.length - 1,
    };
  });
}
beforeEach(() => vi.resetAllMocks());

describe("complete registered File source", () => {
  it("combines fixed-version pages with exact HTML, BOM, Unicode and line endings", async () => {
    const source = pages();
    for (const page of source) vi.mocked(fileDocumentApi.sourceRead).mockResolvedValueOnce(page);
    const result = await readCompleteFileSource(binding, input);
    expect(result).toEqual({ ...source[0], text, startChar: 0, endChar: Array.from(text).length, nextCursor: null, complete: true });
    expect(fileDocumentApi.sourceRead).toHaveBeenCalledTimes(3);
    for (let index = 0; index < 3; index++) expect(fileDocumentApi.sourceRead).toHaveBeenNthCalledWith(index + 1, binding, {
      ...input, cursor: index === 0 ? null : `page-${index}`, budgetChars: 24000,
    });
  });

  it("accepts an empty complete file", async () => {
    vi.mocked(fileDocumentApi.sourceRead).mockResolvedValue({ ...pages()[0], text: "", byteLength: 0, startChar: 0, endChar: 0, totalChars: 0, nextCursor: null, complete: true });
    expect((await readCompleteFileSource(binding, input)).text).toBe("");
  });

  it.each([
    ["version", { versionNumber: 3 }],
    ["hash", { contentHash: "changed" }],
    ["identity", { object: { ...object, id: "8" } }],
    ["Workspace", { object: { ...object, workspaceId: "other" } }],
    ["scope", { object: { ...object, scope: { kind: "project", projectId: 2 } } }],
    ["kind", { object: { ...object, kind: "record" } }],
    ["gap", { startChar: 0 }],
    ["text range", { endChar: 20 }],
    ["total", { totalChars: 100 }],
    ["byte length", { byteLength: 100 }],
    ["format", { format: "text" }],
    ["title", { title: "different.html" }],
    ["repeated cursor", { nextCursor: "page-1" }],
    ["missing cursor", { nextCursor: null }],
    ["premature complete", { complete: true, nextCursor: null }],
  ])("rejects changed %s without returning partial source", async (_name, change) => {
    const source = pages();
    vi.mocked(fileDocumentApi.sourceRead).mockResolvedValueOnce(source[0])
      .mockResolvedValueOnce({ ...source[1], ...change } as FileSourcePage);
    await expect(readCompleteFileSource(binding, input)).rejects.toThrow("文件源码分页不一致");
    expect(fileDocumentApi.sourceRead).toHaveBeenCalledTimes(2);
  });

  it.each([
    { complete: true, nextCursor: "extra" },
    { complete: false, nextCursor: "extra" },
    { byteLength: 1 },
  ])("rejects a contradictory final page or complete byte length: %j", async change => {
    const source = pages();
    source[2] = { ...source[2], ...change };
    for (const page of source) vi.mocked(fileDocumentApi.sourceRead).mockResolvedValueOnce(page);
    await expect(readCompleteFileSource(binding, input)).rejects.toThrow("文件源码分页不一致");
  });

  it("preserves a later IPC failure instead of returning the accumulated prefix", async () => {
    const failure = new Error("Source changed");
    vi.mocked(fileDocumentApi.sourceRead).mockResolvedValueOnce(pages()[0]).mockRejectedValueOnce(failure);
    await expect(readCompleteFileSource(binding, input)).rejects.toBe(failure);
  });

  it("does not start a request when already cancelled", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(readCompleteFileSource(binding, input, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fileDocumentApi.sourceRead).not.toHaveBeenCalled();
  });

  it("cancels pending IPC and ignores its eventual page without requesting the next page", async () => {
    let resolvePage!: (page: FileSourcePage) => void;
    vi.mocked(fileDocumentApi.sourceRead).mockImplementationOnce(() => new Promise(resolve => { resolvePage = resolve; }));
    const controller = new AbortController();
    const result = readCompleteFileSource(binding, input, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    resolvePage(pages()[0]);
    await Promise.resolve();
    expect(fileDocumentApi.sourceRead).toHaveBeenCalledTimes(1);
  });

  it("cancels between pages without reading another page", async () => {
    const controller = new AbortController();
    vi.mocked(fileDocumentApi.sourceRead).mockImplementationOnce(async () => {
      controller.abort();
      return pages()[0];
    });
    await expect(readCompleteFileSource(binding, input, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fileDocumentApi.sourceRead).toHaveBeenCalledTimes(1);
  });
});
