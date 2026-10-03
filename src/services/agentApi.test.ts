import { beforeEach, expect, it, vi } from "vitest";
import { agentApi, AgentApiError } from "./agentApi";
import { desktopApi } from "./desktopApi";
import { agentQueryKeys } from "../lib/agent-query-keys";
import { queryKeys } from "../lib/queryKeys";
import type { OverviewReadInput, OverviewReadPage, KnowledgeGetInput, KnowledgeGetPage, KnowledgeSearchInput, KnowledgeSearchPage } from "../lib/agent-types";

vi.mock("./desktopApi", () => ({ desktopApi: { command: vi.fn() } }));
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

it("sends bounded development scheduling controls with the explicit binding", async () => {
  vi.mocked(desktopApi.command).mockResolvedValue({ apiVersion: 1, requestId: "r1", ok: true, data: null });
  expect(await agentApi.sourceMaintenance(binding, context.scope, "cancel", "r1")).toBeNull();
  expect(desktopApi.command).toHaveBeenCalledWith("agent_source_maintenance", { input: { binding, scope: context.scope, action: "cancel", requestId: "r1" } });
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
