import { beforeEach, expect, it, vi } from "vitest";
import { agentApi, AgentApiError } from "./agentApi";
import { desktopApi } from "./desktopApi";
import { agentQueryKeys } from "../lib/agent-query-keys";
import { queryKeys } from "../lib/queryKeys";
import type { OverviewReadInput, OverviewReadPage, KnowledgeGetInput, KnowledgeGetPage, KnowledgeSearchInput, KnowledgeSearchPage,
  AgentSessionMetadata, AgentSessionSnapshot, AgentStoredRun, AgentRunEvent, AgentRunEventPage,
  AgentSourceRef, AgentSourceNavigation,
} from "../lib/agent-types";

vi.mock("./desktopApi", () => ({ desktopApi: { command: vi.fn(), listenEvent: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());
const binding = { workspaceId: "w1", generation: "open-1" };
const context = { scope: { kind: "project" as const, projectId: 7 }, query: "上次的决定" };

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
