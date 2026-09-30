import { expect, it, vi } from "vitest";
import { CanonicalRecordCreation } from "./canonical-record-creation";
import { recordDocumentApi } from "../services/recordDocumentApi";
import { materializeEmbeddedRecordImages } from "../components/rich-editor/noteImageAssets";
import type { RecordEditorState } from "./record-document-types";
vi.mock("../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn(), create: vi.fn() } }));
vi.mock("../components/rich-editor/noteImageAssets", () => ({ materializeEmbeddedRecordImages: vi.fn(async () => undefined), buildProjectNoteImageAssetHandlers: vi.fn(), buildWorkspaceNoteImageAssetHandlers: vi.fn() }));

it("retains the same bound creation intent and prepared assets after losing a native response", async () => {
  const binding = { workspaceId: "workspace", generation: "opened" };
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding);
  vi.mocked(recordDocumentApi.create).mockRejectedValueOnce(new Error("lost response")).mockResolvedValue({} as RecordEditorState);
  const session = new CanonicalRecordCreation();
  const input = { scope: { kind: "workspace" as const }, title: "Copy", tagIds: [], document: { type: "doc", content: [{ type: "paragraph" }] }, codeLanguage: null };
  await expect(session.create("/workspace", input)).rejects.toThrow("lost response");
  await session.create("/workspace", input);
  expect(recordDocumentApi.bindingGet).toHaveBeenCalledOnce();
  expect(materializeEmbeddedRecordImages).toHaveBeenCalledOnce();
  const calls = vi.mocked(recordDocumentApi.create).mock.calls;
  expect(calls[1]).toEqual(calls[0]);
});
