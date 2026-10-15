import { beforeEach, expect, it, vi } from "vitest";
import { agentApi, AgentApiError } from "../services/agentApi";
import { desktopApi } from "../services/desktopApi";
import { recordDocumentApi } from "../services/recordDocumentApi";
import { RecordSaveCoordinator, RecordSaveFailure, type CommittedProjectRecordSnapshot } from "./record-save-coordinator";
import { discardDeletedRecordForClose, flushRecordSavesForClose } from "./deleted-record-close";

vi.mock("../services/agentApi", async importOriginal => ({
  ...await importOriginal<typeof import("../services/agentApi")>(), agentApi: { statusGet: vi.fn() },
}));
vi.mock("../services/desktopApi", () => ({ desktopApi: { confirm: vi.fn() } }));
vi.mock("../services/recordDocumentApi", () => ({ recordDocumentApi: { editorGet: vi.fn() } }));
const binding = { workspaceId: "workspace", generation: "generation-1" };
const missing = () => new AgentApiError({ code: "NOT_FOUND", message: "Record is missing", retryable: false });
const saveMissing = new RecordSaveFailure("Record is missing", { code: "NOT_FOUND", retryable: false });
function snapshot(recordId = 7): CommittedProjectRecordSnapshot {
  return { scope: "project", workspaceKey: "/workspace", projectId: 1, recordId, title: "草稿", tagIds: [], defaultCodeLanguage: null,
    committedContent: { html: "<p>草稿</p>", markdown: "草稿", text: "草稿" },
    canonicalBody: { binding, requestId: crypto.randomUUID(), baseRevision: 1, document: { type: "doc" }, editSessionId: null, origin: "manual" } };
}
async function fixture(error: unknown = saveMissing) {
  const persist = vi.fn(async () => { throw error; });
  const coordinator = new RecordSaveCoordinator({ adapter: { persist } });
  coordinator.submit(snapshot());
  await coordinator.flush().catch(() => undefined);
  return { coordinator, persist, options: { coordinator, recordKey: "project:1:7", binding,
    target: { scope: { kind: "project" as const, projectId: 1 }, recordId: 7 }, error, isCurrent: () => true } };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(recordDocumentApi.editorGet).mockRejectedValue(missing());
  vi.mocked(desktopApi.confirm).mockResolvedValue(true);
  vi.mocked(agentApi.statusGet).mockResolvedValue({ binding } as Awaited<ReturnType<typeof agentApi.statusGet>>);
});
it.each([false, true])("only discards the missing Record after confirmation=%s", async accepted => {
  const { coordinator, options } = await fixture();
  coordinator.submit(snapshot(8));
  await coordinator.flush().catch(() => undefined);
  vi.mocked(desktopApi.confirm).mockResolvedValue(accepted);
  if (accepted) await discardDeletedRecordForClose(options);
  else await expect(discardDeletedRecordForClose(options)).rejects.toThrow("已取消关闭");
  expect(coordinator.getLatestSnapshot("project:1:7") === null).toBe(accepted);
  expect(coordinator.getLatestSnapshot("project:1:8")).not.toBeNull();
});
it.each(["IO_FAILED", "SCOPE_DENIED", "REVISION_CONFLICT", "SOURCE_NOT_READY", "EDITOR_BUSY"] as const)("does not offer discard for %s", async code => {
  const error = new RecordSaveFailure("save failed", { code, retryable: false });
  const { coordinator, options } = await fixture(error);
  await expect(discardDeletedRecordForClose(options)).rejects.toBe(error);
  expect(desktopApi.confirm).not.toHaveBeenCalled();
  expect(coordinator.getLatestSnapshot("project:1:7")).not.toBeNull();
});
it("does not mistake a missing reference for a deleted Record", async () => {
  const { options } = await fixture();
  vi.mocked(recordDocumentApi.editorGet).mockResolvedValue({} as never);
  await expect(discardDeletedRecordForClose(options)).rejects.toBe(saveMissing);
  expect(desktopApi.confirm).not.toHaveBeenCalled();
});
it("preserves the queue if verification fails due to permissions", async () => {
  const { coordinator, options } = await fixture();
  const error = new AgentApiError({ code: "SCOPE_DENIED", message: "denied", retryable: false });
  vi.mocked(recordDocumentApi.editorGet).mockRejectedValue(error);
  await expect(discardDeletedRecordForClose(options)).rejects.toBe(error);
  expect(desktopApi.confirm).not.toHaveBeenCalled();
  expect(coordinator.getLatestSnapshot("project:1:7")).not.toBeNull();
});
it.each(["draft", "queue", "workspace"])("rejects a stale confirmation after %s changes", async change => {
  const { coordinator, options } = await fixture();
  let current = true;
  options.isCurrent = () => current;
  vi.mocked(desktopApi.confirm).mockImplementation(async () => {
    if (change === "draft") current = false;
    if (change === "queue") coordinator.submit(snapshot());
    if (change === "workspace") vi.mocked(agentApi.statusGet).mockResolvedValue({ binding: { ...binding, generation: "generation-2" } } as never);
    return true;
  });
  await expect(discardDeletedRecordForClose(options)).rejects.toThrow(/已变化|已切换/);
  expect(coordinator.getLatestSnapshot("project:1:7")).not.toBeNull();
});
it("ordinary flush stays strict; a close can discard an orphan failure and still await other saves", async () => {
  let finish!: () => void;
  const pending = new Promise<{ updatedAt: string }>(resolve => { finish = () => resolve({ updatedAt: "saved" }); });
  const coordinator = new RecordSaveCoordinator({ adapter: { persist: async value => {
    if (value.recordId === 7) throw saveMissing;
    return pending;
  } } });
  coordinator.submit(snapshot());
  await expect(coordinator.flush()).rejects.toBe(saveMissing);
  coordinator.submit({ ...snapshot(8), canonicalBody: undefined });
  let closed = false;
  const close = flushRecordSavesForClose(coordinator).then(() => { closed = true; });
  await vi.waitFor(() => expect(desktopApi.confirm).toHaveBeenCalledOnce());
  expect(closed).toBe(false);
  finish();
  await close;
  expect(coordinator.getStatus().phase).toBe("idle");
});
