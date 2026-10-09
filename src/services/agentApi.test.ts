import { beforeEach, expect, it, vi } from "vitest";
import { agentApi, AgentApiError } from "./agentApi";
import { desktopApi } from "./desktopApi";
import { agentQueryKeys } from "../lib/agent-query-keys";
import { queryKeys } from "../lib/queryKeys";
import type { OverviewReadInput, OverviewReadPage, KnowledgeGetInput, KnowledgeGetPage, KnowledgeSearchInput, KnowledgeSearchPage,
  AgentSessionMetadata, AgentSessionSnapshot, AgentStoredRun, AgentRunEvent, AgentRunEventPage,
  AgentSourceRef, AgentSourceNavigation,
  AgentRuntimeOutput, AgentOperationEntry, AgentRecordOutputResult, AgentRecordUndoResult, AgentRecordWithdrawalResult,
  AgentRecordOutputPreview, AgentOutputResult, AgentTodoUndoResult, AgentFileUndoResult,
} from "../lib/agent-types";

vi.mock("./desktopApi", () => ({ desktopApi: { command: vi.fn(), listenEvent: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());
const binding = { workspaceId: "w1", generation: "open-1" };

it("reads a cited message range through the bound GUI command", async () => {
  const data = { sessionId: "s1", branchId: "b1", fromMessageId: "m1", toMessageId: "m2", limit: 50, maxChars: 12000 };
  const page = { sessionId: "s1", branchId: "b1", messages: [], nextCursor: null, hasMore: false };
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "messages-1", ok: true, data: page });
  expect(await agentApi.sessionMessagesRead(binding, data, "messages-1")).toBe(page);
  expect(desktopApi.command).toHaveBeenCalledWith("agent_session_messages_read", { input: { binding, requestId: "messages-1", data } });
});
it("searches history through the bound envelope and rejects a mismatched response", async () => {
  const data = { scope: { kind: "project" as const, projectId: 7 }, query: "决策", afterMessageId: null, limit: 20 };
  const page = { matches: [], nextCursor: null, coverage: { indexedMessages: 5, remainingMessages: 0, backfilledThisRequest: 5, complete: true } };
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "search-1", ok: true, data: page });
  expect(await agentApi.sessionSearch(binding, data, "search-1")).toBe(page);
  expect(desktopApi.command).toHaveBeenCalledWith("agent_session_search", { input: { binding, requestId: "search-1", data } });
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "old-request", ok: true, data: page });
  await expect(agentApi.sessionSearch(binding, data, "search-2")).rejects.toMatchObject({ code: "RUNTIME_INCOMPATIBLE" });
});
const context = { scope: { kind: "project" as const, projectId: 7 }, query: "上次的决定" };

const output: AgentRuntimeOutput = { id: "a".repeat(32), runId: "b".repeat(32), ordinal: 1, revision: 2,
  intent: { intent: "record_create", scope: context.scope, title: "阶段依据", markdown: "有来源支持的候选正文" }, sources: [],
  state: "staged", object: null, mode: "review", errorCode: null, sourceChanged: [], dismissed: false };
const receiptObject = { workspaceId: binding.workspaceId, scope: context.scope, kind: "record" as const, id: "42" };
const operation: AgentOperationEntry = { operationId: "c".repeat(32), runId: output.runId, requestId: "native-commit", kind: "record.create",
  object: receiptObject, beforeRevision: null, afterRevision: 1, beforeSnapshotRef: null, afterSnapshotRef: "snapshot-1",
  undoState: "available", undoOperationId: null, createdAt: "2026-10-08T09:00:00Z", recovery: { withdrawn: false, withdrawalRevision: null, restoreAvailable: false } };

it("routes correction CAS and maintenance controls through bound GUI commands", async () => {
  const corrections = { scope: context.scope, revision: 1, items: [] };
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "read", ok: true, data: corrections });
  expect(await agentApi.overviewCorrectionsGet(binding, context.scope, "read")).toBe(corrections);
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_overview_corrections_get", { input: { binding, requestId: "read", data: context.scope } });
  const update = { scope: context.scope, id: "fix1", itemId: null, text: "纠正", expectedRevision: 1 };
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "save", ok: true, data: corrections });
  await agentApi.overviewCorrectionUpsert(binding, update, "save");
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_overview_correction_upsert", { input: { binding, requestId: "save", data: update } });
  const removal = { scope: context.scope, id: "fix1", expectedRevision: 2 };
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "delete", ok: true, data: corrections });
  await agentApi.overviewCorrectionDelete(binding, removal, "delete");
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_overview_correction_delete", { input: { binding, requestId: "delete", data: removal } });
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "refresh", ok: true, data: { scope: context.scope, pendingCount: 1 } });
  await agentApi.overviewMaintenance(binding, context.scope, "refresh", "refresh");
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_overview_maintenance", { input: { binding, scope: context.scope, action: "refresh", requestId: "refresh" } });
});

it("previews a patch against its exact output revision and propagates changed baselines without writing", async () => {
  const preview: AgentRecordOutputPreview = { outputId: output.id, revision: 2, baseRevision: 3,
    difference: { added: ["a".repeat(32)], deleted: [], modified: ["b".repeat(32)], moved: [] } };
  const data = { outputId: output.id, expectedRevision: 2 };
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "preview-1", ok: true, data: preview });
  expect(await agentApi.outputPreview(binding, data, "preview-1")).toBe(preview);
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_output_preview", { input: { binding, requestId: "preview-1", data } });
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "preview-stale", ok: false,
    error: { code: "REVISION_CONFLICT", message: "Record head differs from candidate baseline", retryable: true } });
  await expect(agentApi.outputPreview(binding, data, "preview-stale")).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  expect(vi.mocked(desktopApi.command).mock.calls.map(([name]) => name)).toEqual(["agent_output_preview", "agent_output_preview"]);
});

it("reads bound output pages and individual candidates without changing content or adding authority", async () => {
  const page = { outputs: [output], nextCursor: "opaque-output-cursor" };
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "outputs-1", ok: true, data: page });
  expect(await agentApi.outputList(binding, { runId: output.runId, limit: 10, cursor: null }, "outputs-1")).toBe(page);
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_output_list", { input: { binding, requestId: "outputs-1", data: { runId: output.runId, limit: 10, cursor: null } } });
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "output-1", ok: true, data: output });
  expect(await agentApi.outputGet(binding, { outputId: output.id }, "output-1")).toBe(output);
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_output_get", { input: { binding, requestId: "output-1", data: { outputId: output.id } } });
  expect(desktopApi.command).toHaveBeenCalledTimes(2);
});

it("updates a candidate through CAS and commits its exact revision without frontend grants", async () => {
  const data = { outputId: output.id, expectedRevision: output.revision, candidate: { intent: { intent: "record_create" as const, scope: context.scope, title: "修订标题", markdown: "修订候选正文" }, sources: [] } };
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "edit-output", ok: true, data: { ...output, revision: 3, intent: data.candidate.intent } });
  expect((await agentApi.outputUpdate(binding, data, "edit-output")).revision).toBe(3);
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_output_update", { input: { binding, requestId: "edit-output", data } });
  const result: AgentRecordOutputResult = { output: { ...output, revision: 3, state: "committed", object: receiptObject }, receipt: { operationId: operation.operationId, headRevision: 1 }, operation };
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "confirm-output", ok: true, data: result });
  expect(await agentApi.outputCommit(binding, { outputId: output.id, expectedRevision: 3 }, "confirm-output")).toBe(result);
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_output_commit", { input: { binding, requestId: "confirm-output", data: { outputId: output.id, expectedRevision: 3 } } });
});

it("reads actual operation receipts using bounded run history and receipt identities", async () => {
  const page = { operations: [operation], nextCursor: "opaque-operation-cursor" };
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "receipts-1", ok: true, data: page });
  expect(await agentApi.operationList(binding, { runId: output.runId, cursor: "previous", limit: 20 }, "receipts-1")).toBe(page);
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_operation_list", { input: { binding, requestId: "receipts-1", data: { runId: output.runId, cursor: "previous", limit: 20 } } });
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "receipt-1", ok: true, data: operation });
  expect(await agentApi.operationGet(binding, { operationId: operation.operationId }, "receipt-1")).toBe(operation);
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_operation_get", { input: { binding, requestId: "receipt-1", data: { operationId: operation.operationId } } });
});

it("sends one bounded native batch undo command with the supplied request identity", async () => {
  const data = { runId: output.runId, operationIds: [operation.operationId] };
  const result = { runId: output.runId, results: [], excludedNoChangeIds: [] };
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "batch-undo", ok: true, data: result });
  expect(await agentApi.operationUndoBatch(binding, data, "batch-undo")).toBe(result);
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_operation_undo_batch", { input: { binding, requestId: "batch-undo", data } });
});

it("undoes a modified Record from its receipt baseline and restores a withdrawn creation with revision checking", async () => {
  const undo: AgentRecordUndoResult = { operationId: "undo-op", originalOperationId: operation.operationId, object: receiptObject,
    head: { target: { scope: context.scope, recordId: 42 }, headRevision: 3, bodyHash: "sha256:restored" }, beforeVersion: "before", afterVersion: "after" };
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "undo", ok: true, data: undo });
  expect(await agentApi.operationUndo(binding, { operationId: operation.operationId, expectedHeadRevision: 2 }, "undo")).toBe(undo);
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_operation_undo", { input: { binding, requestId: "undo", data: { operationId: operation.operationId, expectedHeadRevision: 2 } } });
  const restore: AgentRecordWithdrawalResult = { operationId: "restore-op", creationOperationId: operation.operationId, object: receiptObject, withdrawn: false, revision: 2 };
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "restore", ok: true, data: restore });
  expect(await agentApi.operationRestoreCreated(binding, { creationOperationId: operation.operationId, expectedWithdrawalRevision: 1 }, "restore")).toBe(restore);
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_operation_restore_created", { input: { binding, requestId: "restore", data: { creationOperationId: operation.operationId, expectedWithdrawalRevision: 1 } } });
});

it("preserves undo conflicts and output CAS errors without replaying a rejected write", async () => {
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "undo-conflict", ok: false,
    error: { code: "UNDO_CONFLICT", message: "Record changed after the original operation", retryable: false } });
  await expect(agentApi.operationUndo(binding, { operationId: operation.operationId, expectedHeadRevision: 1 }, "undo-conflict")).rejects.toMatchObject({ code: "UNDO_CONFLICT" });
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "commit-conflict", ok: false,
    error: { code: "REVISION_CONFLICT", message: "Output revision changed", retryable: true } });
  await expect(agentApi.outputCommit(binding, { outputId: output.id, expectedRevision: 1 }, "commit-conflict")).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  expect(desktopApi.command).toHaveBeenCalledTimes(2);
});

const knowledgeSummary: KnowledgeGetPage = {
  scope: context.scope, nodeId: "node:decision-1", kind: "decision", revision: 3,
  title: "决策", view: "summary", summary: "有界摘要", summaryOffset: 4,
  sections: [], sourceRefs: [], related: [],
  coverage: { processed: 1, partial: 0, excluded: 0, unsupported: 0, pending: 0 },
  stale: false, epistemicStatus: "recorded", validState: "current", nextCursor: "next-summary",
};

it("returns bounded Knowledge summaries without loading content or related sources", async () => {
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "r1", ok: true, data: knowledgeSummary });
  expect(await agentApi.knowledgeGet(binding, { scope: context.scope, nodeId: "node:decision-1" }, "r1")).toBe(knowledgeSummary);
  expect(desktopApi.command).toHaveBeenCalledTimes(1);
  expect(desktopApi.command).toHaveBeenCalledWith("agent_knowledge_get", {
    input: { binding, requestId: "r1", data: { scope: context.scope, nodeId: "node:decision-1" } },
  });
});

it("forwards Knowledge view, section selection, version, cursor and budget unchanged", async () => {
  const data: KnowledgeGetInput = { scope: context.scope, nodeId: "overview:item-1", view: "content",
    sectionIds: ["section-1"], version: 3, cursor: "read-cursor", budgetChars: 600 };
  const page: KnowledgeGetPage = { ...knowledgeSummary, nodeId: "overview:item-1", kind: "overview_item", view: "content",
    summary: null, summaryOffset: 0, sections: [{ id: "section-1", title: "内容", text: "片段", textOffset: 2, complete: false }] };
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "r1", ok: true, data: page });
  expect(await agentApi.knowledgeGet(binding, data, "r1")).toBe(page);
  expect(desktopApi.command).toHaveBeenCalledWith("agent_knowledge_get", { input: { binding, requestId: "r1", data } });
});

it("preserves Knowledge search fallback signals without calling source APIs", async () => {
  const data: KnowledgeSearchInput = { scope: context.scope, query: "未覆盖主题", kinds: ["topic", "decision", "source_summary"],
    cursor: "search-cursor", limit: 5, budgetChars: 800 };
  const page: KnowledgeSearchPage = { scope: context.scope, items: [], nextCursor: null, sourceFallbackRequired: true };
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "r1", ok: true, data: page });
  expect(await agentApi.knowledgeSearch(binding, data, "r1")).toBe(page);
  expect(desktopApi.command).toHaveBeenCalledTimes(1);
  expect(desktopApi.command).toHaveBeenCalledWith("agent_knowledge_search", { input: { binding, requestId: "r1", data } });
});

it("preserves nullable Knowledge inputs and structured errors for both read commands", async () => {
  const read: KnowledgeGetInput = { scope: context.scope, nodeId: "node:decision-1", version: null, cursor: null, budgetChars: null };
  const search: KnowledgeSearchInput = { scope: context.scope, query: "决策", cursor: null, limit: null, budgetChars: null };
  const error = { code: "SOURCE_CHANGED", message: "Knowledge changed", retryable: true, details: { revision: 4 } };
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "r1", ok: false, error });
  await expect(agentApi.knowledgeGet(binding, read, "r1")).rejects.toMatchObject({ name: "AgentApiError", ...error });
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_knowledge_get", { input: { binding, requestId: "r1", data: read } });
  await expect(agentApi.knowledgeSearch(binding, search, "r1")).rejects.toMatchObject({ name: "AgentApiError", ...error });
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_knowledge_search", { input: { binding, requestId: "r1", data: search } });
});

const overviewDirectory: OverviewReadPage = {
  scope: context.scope, revision: 3, sections: [{ section: "progress", count: 1 }], items: [],
  stale: false, pendingCount: 0, needsRebuild: false,
  coverage: { processed: 1, partial: 0, excluded: 0, unsupported: 0, pending: 0 },
  asOfSeq: 12, correctionRevision: 2, nextCursor: null,
};

it("reads an Overview directory without adding selections or fetching body", async () => {
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "r1", ok: true, data: overviewDirectory });
  const page = await agentApi.overviewGet(binding, { scope: context.scope }, "r1");
  expect(page).toBe(overviewDirectory);
  expect(page.items).toEqual([]);
  expect(desktopApi.command).toHaveBeenCalledTimes(1);
  expect(desktopApi.command).toHaveBeenCalledWith("agent_overview_get", {
    input: { binding, requestId: "r1", data: { scope: context.scope } },
  });
});

it("forwards explicit Overview selection, version, cursor and budget and preserves bounded items", async () => {
  const input: OverviewReadInput = {
    scope: context.scope, sections: ["progress"], itemIds: ["item-1"], version: 3,
    cursor: "opaque-cursor", budgetChars: 600,
  };
  const page: OverviewReadPage = { ...overviewDirectory, items: [{
    item: { id: "item-1", section: "progress", text: "片段", epistemicStatus: "recorded",
      sourceRefs: [], dependencyItemIds: [], validState: "current", updatedAt: "2026-10-03" },
    textOffset: 4, complete: false,
  }], nextCursor: "next-cursor" };
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "r1", ok: true, data: page });
  expect(await agentApi.overviewGet(binding, input, "r1")).toBe(page);
  expect(desktopApi.command).toHaveBeenCalledWith("agent_overview_get", { input: { binding, requestId: "r1", data: input } });
});

it("passes nullable Overview read options and preserves structured errors", async () => {
  const input: OverviewReadInput = {
    scope: context.scope, sections: [], itemIds: [], version: null, cursor: null, budgetChars: null,
  };
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "r1", ok: false,
    error: { code: "SOURCE_CHANGED", message: "Overview changed", retryable: true, details: { revision: 4 } } });
  await expect(agentApi.overviewGet(binding, input, "r1")).rejects.toMatchObject({
    name: "AgentApiError", code: "SOURCE_CHANGED", message: "Overview changed", retryable: true, details: { revision: 4 },
  });
  expect(desktopApi.command).toHaveBeenCalledWith("agent_overview_get", { input: { binding, requestId: "r1", data: input } });
});

it("sends bounded source scheduling controls with the explicit binding", async () => {
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "r1", ok: true, data: null });
  expect(await agentApi.sourceMaintenance(binding, context.scope, "cancel", "r1")).toBeNull();
  expect(desktopApi.command).toHaveBeenCalledWith("agent_source_maintenance", { input: { binding, scope: context.scope, action: "cancel", requestId: "r1" } });
});

const session: AgentSessionMetadata = {
  id: "session-1", scope: context.scope, title: "项目资料", runtimeId: "builtin-pi", profileOverrideId: null,
  state: "active", createdAt: "2026-10-08T09:00:00Z", updatedAt: "2026-10-08T09:01:00Z",
};
const snapshot: AgentSessionSnapshot = {
  session,
  checkpoint: { schemaVersion: 1, checksum: "sha256:checkpoint", bytes: 2048, leafId: "entry-2", offset: 2048, entryCount: 3, messageCount: 2 },
  messages: [{ id: "message-2", sessionId: session.id, runId: "run-1", runtimeEntryId: "entry-2", role: "assistant",
    content: [{ type: "text", text: "有来源依据的回答" }], ordinal: 2, createdAt: "2026-10-08T09:01:00Z",
    parentId: "entry-1", stopReason: "stop", usage: { input: 32, output: 16 } }],
  nextOrdinal: 2,
  latestRun: null,
};
const run: AgentStoredRun = {
  id: "run-1", sessionId: session.id, clientRequestId: "client-stable-1", state: "running",
  contextManifest: { scope: context.scope, settingsRevision: 2 }, startedAt: "2026-10-08T09:01:00Z",
  finishedAt: null, usage: null, errorCode: null,
};

it("creates scoped sessions with an optional Pi runtime and nullable Profile override", async () => {
  const data = { scope: context.scope, title: "项目资料", profileOverrideId: null };
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "create-1", ok: true, data: session });
  expect(await agentApi.sessionCreate(binding, data, "create-1")).toBe(session);
  expect(desktopApi.command).toHaveBeenCalledWith("agent_session_create", { input: { binding, requestId: "create-1", data } });
});

it("preserves session cursors and bounded message projections", async () => {
  const cursor = { updatedAt: session.updatedAt, id: session.id };
  const page = { sessions: [session], nextCursor: cursor };
  const listData = { scope: context.scope, cursor, limit: 10 };
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "list-1", ok: true, data: page });
  expect(await agentApi.sessionsList(binding, listData, "list-1")).toBe(page);
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_sessions_list", { input: { binding, requestId: "list-1", data: listData } });
  const getData = { sessionId: session.id, afterOrdinal: 1, limit: 1 };
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "get-1", ok: true, data: snapshot });
  expect(await agentApi.sessionGet(binding, getData, "get-1")).toBe(snapshot);
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_session_get", { input: { binding, requestId: "get-1", data: getData } });
  expect(desktopApi.command).toHaveBeenCalledTimes(2);
});

it("archives and deletes stored sessions without accepting a caller scope", async () => {
  const archived: AgentSessionMetadata = { ...session, state: "archived" };
  const data = { sessionId: session.id, archived: true };
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "archive-1", ok: true, data: archived });
  expect(await agentApi.sessionArchive(binding, data, "archive-1")).toBe(archived);
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_session_archive", { input: { binding, requestId: "archive-1", data } });
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "delete-1", ok: true, data: true });
  expect(await agentApi.sessionDelete(binding, { sessionId: session.id }, "delete-1")).toBe(true);
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_session_delete", { input: { binding, requestId: "delete-1", data: { sessionId: session.id } } });
});

it("keeps the stable run client identity separate from the command response identity", async () => {
  const data = { sessionId: session.id, clientRequestId: run.clientRequestId, prompt: "上次决定依据是什么？" };
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "start-1", ok: true, data: run });
  expect(await agentApi.runStart(binding, data, "start-1")).toBe(run);
  expect(desktopApi.command).toHaveBeenCalledWith("agent_run_start", { input: { binding, requestId: "start-1", data } });
  const error = { code: "IDEMPOTENCY_CONFLICT", message: "This client request already names another prompt", retryable: false };
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "start-retry", ok: false, error });
  await expect(agentApi.runStart(binding, data, "start-retry")).rejects.toMatchObject({ name: "AgentApiError", ...error });
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_run_start", { input: { binding, requestId: "start-retry", data } });
});

it("returns stored run state from get and cancel without claiming immediate settlement", async () => {
  const data = { runId: run.id };
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "run-get", ok: true, data: run });
  expect(await agentApi.runGet(binding, data, "run-get")).toBe(run);
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_run_get", { input: { binding, requestId: "run-get", data } });
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "cancel-1", ok: true, data: run });
  expect((await agentApi.runCancel(binding, data, "cancel-1")).state).toBe("running");
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_run_cancel", { input: { binding, requestId: "cancel-1", data } });
});

it("preserves event retention gaps and pagination for recovery", async () => {
  const event: AgentRunEvent = { binding, sessionId: session.id, runId: run.id, seq: 41, event: { type: "text.delta", data: { text: "依据" } } };
  const page: AgentRunEventPage = { events: [event], nextSeq: 41, firstAvailableSeq: 40 };
  const data = { runId: run.id, afterSeq: 12, limit: 25 };
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "events-1", ok: true, data: page });
  expect(await agentApi.runEventsList(binding, data, "events-1")).toBe(page);
  expect(desktopApi.command).toHaveBeenCalledTimes(1);
  expect(desktopApi.command).toHaveBeenCalledWith("agent_run_events_list", { input: { binding, requestId: "events-1", data } });
});

it("verifies the selected or default Profile without sending credentials", async () => {
  for (const data of [{}, { profileOverrideId: null }, { profileOverrideId: 7 }]) {
    const result = { verified: true };
    vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "probe-1", ok: true, data: result });
    expect(await agentApi.profileProbe(binding, data, "probe-1")).toBe(result);
    expect(desktopApi.command).toHaveBeenLastCalledWith("agent_profile_probe", { input: { binding, requestId: "probe-1", data } });
  }
});

it("rejects stale run responses and keeps workspace-switch errors structured", async () => {
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "other-command", ok: true, data: run });
  await expect(agentApi.runGet(binding, { runId: run.id }, "run-get")).rejects.toMatchObject({ code: "RUNTIME_INCOMPATIBLE" });
  const error = { code: "WORKSPACE_CHANGED", message: "Workspace changed during Profile verification", retryable: false };
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "probe-1", ok: false, error });
  await expect(agentApi.profileProbe(binding, {}, "probe-1")).rejects.toMatchObject({ name: "AgentApiError", ...error });
});

it("subscribes to typed run events and returns the desktop cleanup callback", async () => {
  const handler = vi.fn();
  const unlisten = vi.fn();
  vi.mocked(desktopApi.listenEvent).mockResolvedValue(unlisten);
  const cleanup = await agentApi.onRunEvent(handler);
  expect(desktopApi.listenEvent).toHaveBeenCalledWith("agent-run-event", handler);
  const event: AgentRunEvent = { binding, sessionId: session.id, runId: run.id, seq: 42,
    event: { type: "run.failed", data: { error: { code: "SOURCE_CHANGED", message: "Source changed", retryable: true } } } };
  const [, callback] = vi.mocked(desktopApi.listenEvent).mock.calls[0];
  callback(event);
  expect(handler).toHaveBeenCalledWith(event);
  expect(desktopApi.command).not.toHaveBeenCalled();
  cleanup();
  expect(unlisten).toHaveBeenCalledOnce();
});

it("resolves an unchanged cited source through the trusted binding and preserves unavailable locator status", async () => {
  const data: AgentSourceRef = { object: { workspaceId: binding.workspaceId, scope: context.scope, kind: "transcript", id: "99" },
    revision: "sha256:source", fileVersion: null, recordVersion: null, blockId: null,
    locator: { kind: "time", startMs: 1000, endMs: 2500 }, title: "会议原话", excerpt: "证据" };
  const navigation: AgentSourceNavigation = { object: data.object, status: "changed", recordTarget: { scope: context.scope, recordId: 42 },
    currentRevision: "sha256:changed", revisionMatches: false, recordVersion: null, recordVersionId: null, headRevision: null,
    blockId: null, blockStatus: "not_requested", voiceRecordId: 99, startMs: 1000, endMs: 2500, timeStatus: "missing" };
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "resolve-1", ok: true, data: navigation });
  expect(await agentApi.sourceResolve(binding, data, "resolve-1")).toBe(navigation);
  expect(desktopApi.command).toHaveBeenCalledWith("agent_source_resolve", { input: { binding, requestId: "resolve-1", data } });
});

it("passes explicit Workspace binding without eagerly reading anything", async () => {
  expect(desktopApi.command).not.toHaveBeenCalled();
  const data = { identity: { scope: context.scope, name: "项目", archived: false }, status: "not_built",
    overviewUpdatedAt: null, positioning: null, coverage: null, nodes: [], hasMore: false, availableReads: [] };
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "r1", ok: true, data });
  expect(await agentApi.contextGet(binding, context, "r1")).toEqual(data);
  expect(desktopApi.command).toHaveBeenCalledWith("agent_context_get", { input: { binding, requestId: "r1", context } });
});

it("preserves structured errors and rejects mismatched responses", async () => {
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "r1", ok: false,
    error: { code: "WORKSPACE_CHANGED", message: "Changed", retryable: false } });
  await expect(agentApi.contextGet(binding, context, "r1")).rejects.toMatchObject({ code: "WORKSPACE_CHANGED", retryable: false });
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "other", ok: true, data: {} });
  await expect(agentApi.statusGet("r1")).rejects.toBeInstanceOf(AgentApiError);
  await expect(agentApi.statusGet("r1")).rejects.toMatchObject({ code: "RUNTIME_INCOMPATIBLE" });
});

it("isolates cache by Workspace, generation, scope, query and budget", () => {
  const key = agentQueryKeys.context(binding, context.scope, "q");
  expect(key).not.toEqual(agentQueryKeys.context({ ...binding, workspaceId: "w2" }, context.scope, "q"));
  expect(key).not.toEqual(agentQueryKeys.context({ ...binding, generation: "open-2" }, context.scope, "q"));
  expect(key).not.toEqual(agentQueryKeys.context(binding, { kind: "workspace" }, "q"));
  expect(key).not.toEqual(agentQueryKeys.context(binding, context.scope, "q2"));
  expect(key).not.toEqual(agentQueryKeys.context(binding, context.scope, "q", 500));
  expect(queryKeys.workspaceScoped).toContainEqual(["agent"]);
});

it("saves user scope settings with a revision and forwards conflict details", async () => {
  const settings = { scope: context.scope, enabled: false, goalRecordId: null, pinnedRefs: [], summaryPolicy: "on_success" as const,
    overviewIntervalHours: 24 as const, overviewLocalTime: "03:00", overviewTimezone: "Asia/Shanghai", executionMode: "collaborate" as const, revision: 0 };
  const saved = { ...settings, revision: 1 };
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "r1", ok: true, data: saved });
  expect(await agentApi.settingsUpdate(binding, { settings, expectedRevision: 0 }, "r1")).toEqual(saved);
  expect(desktopApi.command).toHaveBeenCalledWith("agent_settings_update", { input: { binding, requestId: "r1", data: { settings, expectedRevision: 0 } } });
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "r2", ok: false,
    error: { code: "REVISION_CONFLICT", message: "Changed", retryable: false, details: { current: saved } } });
  await expect(agentApi.settingsUpdate(binding, { settings, expectedRevision: 0 }, "r2")).rejects.toMatchObject({ code: "REVISION_CONFLICT", details: { current: saved } });
});


it("uses the shared output and receipt APIs for typed Todo candidates and numeric revisions", async () => {
  const object = { ...receiptObject, kind: "todo" as const, id: "18" };
  const todo: AgentRuntimeOutput = { ...output, intent: { intent: "todo_create", scope: context.scope, dedupeKey: "evidence-todo",
    content: "核对原始证据", priority: "urgent_important", dueDate: null, tagIds: [3],
    children: [{ content: "核对子项", progressDate: "2026-10-08", dueDate: "2026-10-12" }] }, mode: "collaborate" };
  const saved: AgentOutputResult = { output: { ...todo, state: "committed", object }, receipt: { revision: 1 },
    operation: { ...operation, object, kind: "todo.create" } };
  const revisionInput = { outputId: todo.id, expectedRevision: todo.revision };
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "save-todo", ok: true, data: saved });
  expect(await agentApi.outputCommit(binding, revisionInput, "save-todo")).toBe(saved);
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_output_commit", { input: { binding, requestId: "save-todo", data: revisionInput } });
  const candidate = { intent: { intent: "todo_update" as const, target: object, expectedRevision: 1,
    changes: [{ change: "deadline" as const, dueDate: "2026-10-15" }, { change: "child_update" as const,
      childId: 2, content: "核对完成", progressDate: "2026-10-09", dueDate: null, status: "finished" as const }] }, sources: [] };
  const edit = { outputId: todo.id, expectedRevision: 2, candidate };
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "edit-todo", ok: true, data: { ...todo, intent: candidate.intent, revision: 3 } });
  expect((await agentApi.outputUpdate(binding, edit, "edit-todo")).intent).toBe(candidate.intent);
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_output_update", { input: { binding, requestId: "edit-todo", data: edit } });
  const undo: AgentTodoUndoResult = { operationId: "undo-todo", originalOperationId: operation.operationId, object,
    beforeRevision: 2, afterRevision: 3, beforeSnapshotRef: "a".repeat(32), afterSnapshotRef: "b".repeat(32), bodyHash: "sha256:" + "c".repeat(64) };
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "undo-todo", ok: true, data: undo });
  expect(await agentApi.operationUndo(binding, { operationId: operation.operationId, expectedHeadRevision: 2 }, "undo-todo")).toBe(undo);
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_operation_undo", { input: { binding, requestId: "undo-todo", data: { operationId: operation.operationId, expectedHeadRevision: 2 } } });
  expect(vi.mocked(desktopApi.command).mock.calls.map(([name]) => name)).toEqual(["agent_output_commit", "agent_output_update", "agent_operation_undo"]);
});


it("dismisses the exact output revision durably without committing business content", async () => {
  const dismissed: AgentRuntimeOutput = { ...output, revision: output.revision + 1, dismissed: true };
  const data = { outputId: output.id, expectedRevision: output.revision };
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "dismiss-output", ok: true, data: dismissed });
  expect(await agentApi.outputDismiss(binding, data, "dismiss-output")).toBe(dismissed);
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_output_dismiss", { input: { binding, requestId: "dismiss-output", data } });
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "dismiss-stale", ok: false,
    error: { code: "REVISION_CONFLICT", message: "Output revision changed", retryable: true } });
  await expect(agentApi.outputDismiss(binding, data, "dismiss-stale")).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  expect(vi.mocked(desktopApi.command).mock.calls.map(([name]) => name)).toEqual(["agent_output_dismiss", "agent_output_dismiss"]);
});


it("retains exact File patch/restore candidates and native undo versions through the shared APIs", async () => {
  const object = { ...receiptObject, kind: "file" as const, id: "41" };
  const patch = { object, expectedVersionNumber: 2, expectedContentHash: "sha256:" + "d".repeat(64), edits: [{ oldText: "旧目标", newText: "新目标", occurrence: 2 }], appendText: null };
  const data = { outputId: output.id, expectedRevision: output.revision, candidate: { intent: { intent: "file_patch" as const, patch }, sources: [] } };
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "file-patch", ok: true, data: { ...output, intent: data.candidate.intent, revision: 3 } });
  expect((await agentApi.outputUpdate(binding, data, "file-patch")).intent).toBe(data.candidate.intent);
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_output_update", { input: { binding, requestId: "file-patch", data } });
  const restored: AgentRuntimeOutput = { ...output, object, state: "committed", intent: { intent: "file_restore", restore: { object, versionId: "17", expectedVersionNumber: 3, expectedContentHash: "sha256:" + "e".repeat(64) } }, fileReceipt: { documentId: 41, versionNumber: 4, contentHash: "sha256:restored", noChange: false } };
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "file-restore", ok: true, data: { output: restored, receipt: restored.fileReceipt, operation: null } });
  expect((await agentApi.outputCommit(binding, { outputId: output.id, expectedRevision: 2 }, "file-restore")).output.fileReceipt).toBe(restored.fileReceipt);
  const undo: AgentFileUndoResult = { operationId: "file-undo", originalOperationId: "file-save", object,
    beforeVersionNumber: 4, afterVersionNumber: 5, beforeVersionId: "18", afterVersionId: "19", contentHash: "sha256:previous" };
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "file-undo", ok: true, data: undo });
  expect(await agentApi.operationUndo(binding, { operationId: "file-save", expectedHeadRevision: 4 }, "file-undo")).toBe(undo);
  expect(desktopApi.command).toHaveBeenLastCalledWith("agent_operation_undo", { input: { binding, requestId: "file-undo", data: { operationId: "file-save", expectedHeadRevision: 4 } } });
});


it("persists an exact grouped review decision with text through the shared bound native command", async () => {
  const data = { runId: output.runId, outputs: [{ outputId: output.id, expectedRevision: output.revision }], decision: "cancel" as const, text: "取消这个方案" };
  const result = { runId: output.runId, decision: "cancel" as const, outputs: [{ ...output, revision: output.revision + 1, dismissed: true, reviewDecision: { requestId: "review-1", decision: "cancel" as const, text: data.text, decidedAt: "native-now" } }] };
  vi.mocked(desktopApi.command).mockResolvedValueOnce({ apiVersion: 1, requestId: "review-1", ok: true, data: result });
  expect(await agentApi.outputReview(binding, data, "review-1")).toBe(result);
  expect(desktopApi.command).toHaveBeenCalledWith("agent_output_review", { input: { binding, requestId: "review-1", data } });
  expect(desktopApi.command).toHaveBeenCalledOnce();
});
