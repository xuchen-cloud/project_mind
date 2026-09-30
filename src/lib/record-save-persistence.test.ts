import { beforeEach, expect, it, vi } from "vitest";
import { persistRecordSnapshot } from "./record-save-persistence";
import { recordDocumentApi } from "../services/recordDocumentApi";
import { projectMindApi } from "../services/projectMindApi";
import type { CommittedProjectRecordSnapshot } from "./record-save-coordinator";
import type { RecordEditorSaveResult } from "./record-document-types";
import { AgentApiError } from "../services/agentApi";
import { RecordSaveFailure } from "./record-save-coordinator";
import { buildProjectNoteImageAssetHandlers } from "../components/rich-editor/noteImageAssets";

vi.mock("../components/rich-editor/noteImageAssets", async (importOriginal) => ({
  ...await importOriginal<typeof import("../components/rich-editor/noteImageAssets")>(),
  buildProjectNoteImageAssetHandlers: vi.fn(() => ({})),
}));

vi.mock("../services/recordDocumentApi", () => ({ recordDocumentApi: { bodySave: vi.fn() } }));
vi.mock("../services/projectMindApi", () => ({ projectMindApi: { projectRecordUpsert: vi.fn(), workspaceRecordUpsert: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());

it("saves the committed JSON through CAS and uses the server projection instead of legacy HTML caches", async () => {
  const target = { scope: { kind: "project" as const, projectId: 1 }, recordId: 7 };
  const document = { type: "doc", content: [{ type: "paragraph", attrs: { blockId: "1".repeat(32) }, content: [{ type: "text", text: "Committed tree" }] }] };
  const snapshot: CommittedProjectRecordSnapshot = {
    scope: "project", workspaceKey: "/workspace", projectId: 1, recordId: 7,
    title: "New title", tagIds: [], defaultCodeLanguage: null,
    committedContent: { html: "<p>Stale cache</p>", markdown: "Stale cache", text: "Stale cache" },
    canonicalBody: { binding: { workspaceId: "w1", generation: "open-1" }, requestId: "save-1", baseRevision: 1, document, editSessionId: "a".repeat(32), origin: "manual", metadataBase: { title: "Old title", tagIds: [], revision: "metadata-1", updatedAt: "old" } },
  };
  const head = { target, headRevision: 2, editSessionId: "a".repeat(32), checkpointDueAt: null,
    projection: { document, html: "<p>Committed tree</p>", markdown: "Committed tree", text: "Committed tree", schemaVersion: 1, bodyHash: "sha256:fixture", codeLanguage: null } };
  const metadata = { title: "New title", tagIds: [], revision: "metadata-2", updatedAt: "saved" };
  const record = { id: 7, projectId: 1, title: "New title", contentHtml: head.projection.html, contentMarkdown: head.projection.markdown, tags: [], createdAt: "created", updatedAt: "saved" };
  const response: RecordEditorSaveResult = { commit: { head, noChange: false, beforeVersion: "v1", afterVersion: null, metadata }, editor: { head, metadata, record } };
  vi.mocked(recordDocumentApi.bodySave).mockResolvedValue(response);
  vi.mocked(projectMindApi.projectRecordUpsert).mockResolvedValue(record);
  const result = await persistRecordSnapshot(snapshot);
  expect(projectMindApi.projectRecordUpsert).not.toHaveBeenCalled();
  expect(result).toMatchObject({ headRevision: 2, metadata: { revision: "metadata-2" }, record: { contentMarkdown: "Committed tree" } });
  expect(vi.mocked(recordDocumentApi.bodySave).mock.calls[0]?.[1]).toMatchObject({ target, baseRevision: 1, document, metadata: { expectedRevision: "metadata-1", title: "New title" } });
});

function fixture(): CommittedProjectRecordSnapshot {
  return { scope: "project", workspaceKey: "/workspace", projectId: 1, recordId: 7,
    title: "Title", tagIds: [4], defaultCodeLanguage: null,
    committedContent: { html: "", markdown: "#[tag:99|Stale|blue]", text: "" },
    canonicalBody: { binding: { workspaceId: "w1", generation: "open-1" }, requestId: "fixture", baseRevision: 1,
      document: { type: "doc", content: [{ type: "paragraph", attrs: { blockId: "1".repeat(32) } }] },
      editSessionId: "a".repeat(32), origin: "manual", metadataBase: { title: "Title", tagIds: [4], revision: "metadata-1", updatedAt: "old" } } };
}

it("does not write unchanged headers or infer tags from stale markdown", async () => {
  vi.mocked(recordDocumentApi.bodySave).mockRejectedValue(new Error("stop after capture"));
  await expect(persistRecordSnapshot(fixture())).rejects.toThrow("stop after capture");
  expect(vi.mocked(recordDocumentApi.bodySave).mock.calls[0]?.[1].metadata).toBeUndefined();
});

it.each([8, "8"])("adds mention tags from the committed tree with ID %s", async (tagId) => {
  const snapshot = fixture();
  snapshot.canonicalBody!.document.content![0].content = [{ type: "tagMention", attrs: { tagId, label: "Actual", colorKey: "blue" } }];
  vi.mocked(recordDocumentApi.bodySave).mockRejectedValue(new Error("captured"));
  await expect(persistRecordSnapshot(snapshot)).rejects.toThrow("captured");
  expect(vi.mocked(recordDocumentApi.bodySave).mock.calls[0]?.[1].metadata?.tagIds).toEqual([4, 8]);
});

it("preserves conflict details and disables automatic retry", async () => {
  vi.mocked(recordDocumentApi.bodySave).mockRejectedValue(new AgentApiError({ code: "REVISION_CONFLICT", message: "Other window saved", retryable: false, details: { currentRevision: 2 } }));
  const error = await persistRecordSnapshot(fixture()).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(RecordSaveFailure);
  expect(error).toMatchObject({ retryable: false, code: "REVISION_CONFLICT", details: { currentRevision: 2 } });
});

it("reuses imported images after a failed save without mutating the captured tree", async () => {
  const snapshot = fixture();
  const dataUrl = "data:image/png;base64,aGVsbG8=";
  snapshot.canonicalBody!.document.content!.push({ type: "image", attrs: { blockId: "2".repeat(32), src: dataUrl } });
  const insertPastedImage = vi.fn().mockResolvedValue({ path: "/workspace/project/image.png", title: "image", mimeType: "image/png" });
  vi.mocked(buildProjectNoteImageAssetHandlers).mockReturnValue({ insertPastedImage });
  vi.mocked(recordDocumentApi.bodySave).mockRejectedValue(new AgentApiError({ code: "IO_FAILED", message: "Temporary failure", retryable: false }));
  await expect(persistRecordSnapshot(snapshot)).rejects.toMatchObject({ retryable: true });
  await expect(persistRecordSnapshot(snapshot)).rejects.toMatchObject({ retryable: true });
  expect(insertPastedImage).toHaveBeenCalledTimes(1);
  expect(snapshot.canonicalBody!.document.content![1].attrs?.src).toBe(dataUrl);
  expect(vi.mocked(recordDocumentApi.bodySave).mock.calls[1]?.[1].document.content![1].attrs).toMatchObject({ src: null, path: "/workspace/project/image.png", blockId: "2".repeat(32) });
});
