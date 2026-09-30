import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteRecord, ProjectPageData, WorkspacePageData, WorkspaceRecord } from "./types";
import { queryKeys } from "./queryKeys";
import { createRecordSaveCoordinator } from "./record-save-runtime";
import { recordDocumentApi } from "../services/recordDocumentApi";
import { projectMindApi } from "../services/projectMindApi";
import { fixtureBodySave, fixtureDocument } from "../test/recordDocumentFixture";
import type { CommittedRecordBody } from "./record-save-coordinator";
vi.mock("../services/recordDocumentApi", () => ({ recordDocumentApi: { bodySave: vi.fn() } }));
vi.mock("../services/projectMindApi", () => ({ projectMindApi: { projectRecordUpsert: vi.fn(), workspaceRecordUpsert: vi.fn() } }));
beforeEach(() => vi.resetAllMocks());

function record(markdown: string, updatedAt: string): NoteRecord {
  return { id: 7, projectId: 1, title: "Record title", contentMarkdown: markdown, contentHtml: `<p>${markdown}</p>`, defaultCodeLanguage: "typescript", tags: [], createdAt: "created", updatedAt };
}
function projectPage(value: NoteRecord): ProjectPageData {
  return { project: null, records: [value], unfinishedTodos: [], finishedTodos: [], projectDocuments: [] };
}
function body(value: string, title = "Record title"): CommittedRecordBody {
  return { binding: { workspaceId: "workspace", generation: "opened" }, requestId: crypto.randomUUID(), baseRevision: 1,
    document: fixtureDocument(value), editSessionId: "a".repeat(32), origin: "manual", metadataBase: { title, tagIds: [], revision: "metadata-1", updatedAt: "old" } };
}

describe("Record save runtime", () => {
  it("persists canonical snapshots in order, advances CAS, and publishes only the newest result to React Query", async () => {
    let finishOld!: (value: NoteRecord) => void;
    const oldWrite = new Promise<NoteRecord>((resolve) => { finishOld = resolve; });
    const tags = [3, 5].map((id) => ({ id, label: `Tag ${id}`, colorKey: "slate" }));
    vi.mocked(recordDocumentApi.bodySave)
      .mockImplementationOnce((_binding, input) => fixtureBodySave(input, record("cached", "cached-time"), async (fields) => ({ ...await oldWrite, title: fields.title, tags })))
      .mockImplementationOnce((_binding, input) => fixtureBodySave(input, { ...record("old", "old-time"), title: "Latest title", tags }, async (fields) => ({ ...record("new", "new-time"), title: fields.title, tags })));
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.projectPage(1), projectPage(record("cached", "cached-time")));
    const coordinator = createRecordSaveCoordinator({ workspaceKey: "/tmp/workspace", queryClient });
    const base = { scope: "project" as const, workspaceKey: "/tmp/workspace", projectId: 1, recordId: 7, title: " Latest title ", tagIds: [3, 5], defaultCodeLanguage: "typescript" };
    coordinator.submit({ ...base, committedContent: { html: "<p>old</p>", text: "old", markdown: "old" }, canonicalBody: body("old") });
    coordinator.submit({ ...base, committedContent: { html: "<p>new</p>", text: "new", markdown: "new" }, canonicalBody: body("new") });
    finishOld(record("old", "old-time"));
    await Promise.resolve();
    expect(queryClient.getQueryData<ProjectPageData>(queryKeys.projectPage(1))?.records?.[0]?.contentMarkdown).toBe("cached");
    await coordinator.flush();
    expect(vi.mocked(recordDocumentApi.bodySave).mock.calls[0][1]).toMatchObject({ baseRevision: 1, metadata: { title: "Latest title", tagIds: [3, 5], expectedRevision: "metadata-1" } });
    expect(vi.mocked(recordDocumentApi.bodySave).mock.calls[1][1]).toMatchObject({ target: { scope: { kind: "project", projectId: 1 }, recordId: 7 }, baseRevision: 2, document: fixtureDocument("new"), codeLanguage: "typescript" });
    expect(vi.mocked(recordDocumentApi.bodySave).mock.calls[1][1].metadata).toBeUndefined();
    expect(queryClient.getQueryData<ProjectPageData>(queryKeys.projectPage(1))?.records?.[0]?.contentMarkdown).toBe("new");
    expect(projectMindApi.projectRecordUpsert).not.toHaveBeenCalled();
  });
  it("publishes a canonical Workspace Record response to the Workspace cache", async () => {
    const cached: WorkspaceRecord = { id: 7, title: "Old", contentMarkdown: "old", contentHtml: "<p>old</p>", tags: [], createdAt: "created", updatedAt: "old-time" };
    vi.mocked(recordDocumentApi.bodySave).mockImplementation((_binding, input) => fixtureBodySave(input, cached, async (fields) => ({ ...cached, title: fields.title, contentMarkdown: fields.markdown, contentHtml: fields.html, updatedAt: "new-time" })));
    const queryClient = new QueryClient();
    queryClient.setQueryData<WorkspacePageData>(queryKeys.workspacePage, { quickNote: null, records: [cached], unfinishedTodos: [], finishedTodos: [] });
    const coordinator = createRecordSaveCoordinator({ workspaceKey: "/tmp/workspace", queryClient });
    coordinator.submit({ scope: "workspace", workspaceKey: "/tmp/workspace", recordId: 7, title: " Latest ", tagIds: [], defaultCodeLanguage: null,
      committedContent: { html: "<p>stale cache</p>", text: "stale cache", markdown: "stale cache" }, canonicalBody: body("new", "Old") });
    await coordinator.flush();
    expect(vi.mocked(recordDocumentApi.bodySave).mock.calls[0][1]).toMatchObject({ document: fixtureDocument("new"), metadata: { title: "Latest", expectedRevision: "metadata-1" } });
    expect(queryClient.getQueryData<WorkspacePageData>(queryKeys.workspacePage)?.records?.[0]?.contentMarkdown).toBe("new");
    expect(projectMindApi.workspaceRecordUpsert).not.toHaveBeenCalled();
  });
  it("retains an unbound draft as a non-retryable failure and never uses an unconditional upsert", async () => {
    const coordinator = createRecordSaveCoordinator({ workspaceKey: "/tmp/workspace", queryClient: new QueryClient() });
    coordinator.submit({ scope: "workspace", workspaceKey: "/tmp/workspace", recordId: 7, title: "Draft", tagIds: [], defaultCodeLanguage: null, committedContent: { html: "<p>Keep draft</p>", text: "Keep draft", markdown: "Keep draft" } });
    await expect(coordinator.flush()).rejects.toMatchObject({ code: "SOURCE_NOT_READY", retryable: false });
    expect(coordinator.getLatestSnapshot("workspace:7")?.committedContent.markdown).toBe("Keep draft");
    expect(recordDocumentApi.bodySave).not.toHaveBeenCalled();
    expect(projectMindApi.workspaceRecordUpsert).not.toHaveBeenCalled();
  });
});
