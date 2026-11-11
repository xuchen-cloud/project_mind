import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const summaries = vi.hoisted(() => vi.fn(async (_projectId: number | null, _binding: unknown) => ({ revision: "r1", items: [] })));
vi.mock("../services/dshAssistantApi", () => ({ dshAssistantApi: { summaries } }));
vi.mock("../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: async () => ({ workspaceId: "w", generation: "g" }) } }));
vi.mock("../services/projectMindApi", () => ({
  projectMindApi: {
    projectPageGet: vi.fn(async ({ projectId }: { projectId: number }) => ({ projectId })),
    projectTagSettingsGet: vi.fn(async ({ projectId }: { projectId: number }) => ({ projectId })),
  },
}));

import { prefetchProjectPageData, scheduleSessionSummariesPrefetch } from "./project-prefetch";
import { queryKeys } from "./queryKeys";
import { projectMindApi } from "../services/projectMindApi";

beforeEach(() => summaries.mockReset().mockResolvedValue({ revision: "r1", items: [] }));
afterEach(() => { vi.unstubAllGlobals(); });

describe("prefetchProjectPageData", () => {
  beforeEach(() => vi.clearAllMocks());

  it("warms the canonical project page and tag caches together", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["workspace-status"], { currentWorkspace: { rootPath: "/workspace" } });

    await prefetchProjectPageData(queryClient, 7);

    expect(projectMindApi.projectPageGet).toHaveBeenCalledWith({ projectId: 7 });
    expect(projectMindApi.projectTagSettingsGet).toHaveBeenCalledWith({ projectId: 7 }, { workspaceId: "w", generation: "g" });
    expect(queryClient.getQueryData(queryKeys.projectPage(7))).toEqual({ projectId: 7 });
    expect(queryClient.getQueryData(queryKeys.projectTags.project(7))).toEqual({ projectId: 7 });
  });
});


it("prefetches only bounded requested scopes at idle and shares the sidebar cache", async () => {
  const idle: (() => void)[] = [];
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => { idle.push(callback); return idle.length; });
  vi.stubGlobal("cancelIdleCallback", vi.fn());
  const client = new QueryClient();
  const cancel = scheduleSessionSummariesPrefetch(client, "/workspace", [7, null, 8, 9, 10, 11]);
  expect(summaries).not.toHaveBeenCalled();
  for (let i = 0; i < 4; i++) {
    idle.shift()!();
    await vi.waitFor(() => expect(summaries).toHaveBeenCalledTimes(i + 1));
    await vi.waitFor(() => expect(idle.length).toBe(i === 3 ? 0 : 1));
  }
  expect(summaries.mock.calls.map(args => args[0])).toEqual([7, null, 8, 9]);
  const { sessionSummariesQueryOptions } = await import("./session-summaries");
  expect(await client.fetchQuery(sessionSummariesQueryOptions({ workspaceId: "w", generation: "g" }, 7))).toEqual({ revision: "r1", items: [] });
  expect(summaries).toHaveBeenCalledTimes(4);
  cancel();
  client.clear();
  vi.unstubAllGlobals();
});


it("stops queued scopes when Workspace readiness is lost during a read", async () => {
  const idle: (() => void)[] = [];
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => { idle.push(callback); return idle.length; });
  vi.stubGlobal("cancelIdleCallback", vi.fn());
  let finish!: () => void;
  summaries.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ revision: "r1", items: [] }); }));
  const client = new QueryClient();
  const cancel = scheduleSessionSummariesPrefetch(client, "/workspace", [7, 8, 9]);
  idle.shift()!();
  await vi.waitFor(() => expect(summaries).toHaveBeenCalledTimes(1));
  cancel();
  client.removeQueries({ queryKey: ["agent"] });
  finish();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(idle).toHaveLength(0);
  expect(summaries).toHaveBeenCalledTimes(1);
  client.clear();
});

it("cancels idle work before it can request a Workspace binding", () => {
  const idle: (() => void)[] = [];
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => { idle.push(callback); return 1; });
  vi.stubGlobal("cancelIdleCallback", vi.fn());
  const client = new QueryClient();
  const cancel = scheduleSessionSummariesPrefetch(client, "/workspace", [7]);
  cancel();
  idle.shift()!();
  expect(client.getQueryCache().getAll()).toHaveLength(0);
  expect(summaries).not.toHaveBeenCalled();
  client.clear();
});


it("bounds concurrent background reads across hover and Workspace-ready schedulers", async () => {
  const idle: (() => void)[] = [];
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => { idle.push(callback); return idle.length; });
  vi.stubGlobal("cancelIdleCallback", vi.fn());
  let finish!: () => void;
  summaries.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ revision: "r1", items: [] }); }));
  const client = new QueryClient();
  const ready = scheduleSessionSummariesPrefetch(client, "/workspace", [7]);
  const hover = scheduleSessionSummariesPrefetch(client, "/workspace", [8]);
  idle.shift()!();
  await vi.waitFor(() => expect(summaries).toHaveBeenCalledTimes(1));
  idle.shift()!();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(summaries).toHaveBeenCalledTimes(1);
  finish();
  await vi.waitFor(() => expect(idle).toHaveLength(1));
  idle.shift()!();
  await vi.waitFor(() => expect(summaries).toHaveBeenCalledTimes(2));
  ready(); hover(); client.clear();
});
