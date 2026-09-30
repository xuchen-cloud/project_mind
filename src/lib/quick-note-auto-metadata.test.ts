import { beforeEach, expect, it, vi } from "vitest";
import { cancelAllQuickNoteRecordMetadata, completeQuickNoteRecordMetadata } from "./quick-note-auto-metadata";
import { recordDocumentApi } from "../services/recordDocumentApi";
import { enqueueAndWait } from "./aiJobs";
import type { AiJobSnapshot, AiSettingsSnapshot, WorkspaceRecord } from "./types";

vi.mock("../services/recordDocumentApi", () => ({ recordDocumentApi: { metadataGet: vi.fn(), metadataApply: vi.fn() } }));
vi.mock("./aiJobs", async (original) => ({ ...await original<typeof import("./aiJobs")>(), enqueueAndWait: vi.fn() }));
const binding = { workspaceId: "workspace", generation: "opened" };
const record: WorkspaceRecord = { id: 7, title: "Quick note", tags: [], contentHtml: "<p>Body</p>", contentMarkdown: "Body", createdAt: "now", updatedAt: "now" };
const baseline = { title: record.title!, tagIds: [], revision: "metadata-1", updatedAt: "now" };
const aiSettings: AiSettingsSnapshot = { profiles: [], bindings: [], hasUsableDefault: true, hasUsableImageDefault: false, securityMode: "workspace", aiSecretsUnlocked: true, execution: { maxConcurrency: 1 }, editorSkills: [] };
const job: AiJobSnapshot = { id: 1, kind: "record_metadata", targetKey: "fixture", status: "succeeded", queuedAt: "now", result: { kind: "record_metadata", metadata: { title: "AI title", existingTagIds: [9], newTags: ["New"] } } };
const args = { binding, record, aiSettings, availableTags: [] };

beforeEach(() => {
  cancelAllQuickNoteRecordMetadata();
  vi.resetAllMocks();
  vi.mocked(recordDocumentApi.metadataGet).mockResolvedValue(baseline);
  vi.mocked(enqueueAndWait).mockResolvedValue(job);
});

it("pins the transferred Workspace and applies AI metadata with its original revision", async () => {
  await completeQuickNoteRecordMetadata(args);
  expect(recordDocumentApi.metadataGet).toHaveBeenCalledWith(binding, { scope: { kind: "workspace" }, recordId: 7 });
  expect(recordDocumentApi.metadataApply).toHaveBeenCalledWith(binding, {
    metadata: { target: { scope: { kind: "workspace" }, recordId: 7 }, title: "AI title", tagIds: [9], expectedRevision: baseline.revision },
    newTags: [{ label: "New", colorKey: expect.any(String) }],
  }, expect.any(String));
});

it("does not generate or overwrite metadata already edited after transfer", async () => {
  vi.mocked(recordDocumentApi.metadataGet).mockResolvedValue({ ...baseline, title: "User title", revision: "metadata-2" });
  await completeQuickNoteRecordMetadata(args);
  expect(enqueueAndWait).not.toHaveBeenCalled();
  expect(recordDocumentApi.metadataApply).not.toHaveBeenCalled();
});

it("retains edits made while the AI job was running by surfacing a CAS failure", async () => {
  vi.mocked(recordDocumentApi.metadataApply).mockRejectedValue(new Error("REVISION_CONFLICT"));
  await expect(completeQuickNoteRecordMetadata(args)).rejects.toThrow("REVISION_CONFLICT");
  expect(vi.mocked(recordDocumentApi.metadataApply).mock.calls[0][1].metadata.expectedRevision).toBe(baseline.revision);
});

it("does not apply an in-flight job after Workspace cancellation", async () => {
  let finish!: (value: AiJobSnapshot) => void;
  vi.mocked(enqueueAndWait).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const running = completeQuickNoteRecordMetadata(args);
  await vi.waitFor(() => expect(enqueueAndWait).toHaveBeenCalledOnce());
  cancelAllQuickNoteRecordMetadata();
  finish(job);
  await running;
  expect(recordDocumentApi.metadataApply).not.toHaveBeenCalled();
});
