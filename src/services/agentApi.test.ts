import { beforeEach, expect, it, vi } from "vitest";
import { agentApi, AgentApiError } from "./agentApi";
import { desktopApi } from "./desktopApi";
import { agentQueryKeys } from "../lib/agent-query-keys";
import { queryKeys } from "../lib/queryKeys";

vi.mock("./desktopApi", () => ({ desktopApi: { command: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());
const binding = { workspaceId: "w1", generation: "open-1" };
const context = { scope: { kind: "project" as const, projectId: 7 }, query: "上次的决定" };

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
