import { expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { createBusinessChangeSync } from "./business-change-sync";
import { queryKeys } from "./queryKeys";
import type { AgentChangePage } from "./agent-types";

const binding = { workspaceId: "w1", generation: "open-1" };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const change = (seq: number, project: number | null, kind = "record", id = "7") => ({
  seq, objectKey: `w1/${project === null ? "workspace" : `project:${project}`}/${kind}/${id}`,
  scope: project === null ? { kind: "workspace" as const } : { kind: "project" as const, projectId: project },
  operation: `${kind}.update`, revision: "new", createdAt: "2026-10-01T00:00:00Z",
});

it("marks a Warm project dirty without querying it and preserves unrelated caches", async () => {
  const client = new QueryClient();
  client.setQueryData(queryKeys.projectPage(1), { records: ["old"] });
  client.setQueryData(queryKeys.projectPage(2), { records: ["other"] });
  const fetch = vi.fn(async () => ({ records: ["new"] }));
  const observer = new QueryObserver(client, { queryKey: queryKeys.projectPage(1), queryFn: fetch, enabled: false, staleTime: Infinity });
  const unsubscribe = observer.subscribe(() => {});
  const read = vi.fn(async () => ({ entries: [change(1, 1)], cursor: 1, hasMore: false, resetRequired: false }));
  const sync = createBusinessChangeSync({ binding, queryClient: client, readChanges: read });
  await sync.catchUp();
  expect(client.getQueryState(queryKeys.projectPage(1))?.isInvalidated).toBe(true);
  expect(client.getQueryState(queryKeys.projectPage(2))?.isInvalidated).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  observer.setOptions({ queryKey: queryKeys.projectPage(1), queryFn: fetch, enabled: true, staleTime: Infinity });
  await tick();
  expect(fetch).toHaveBeenCalledOnce();
  expect(client.getQueryData(queryKeys.projectPage(1))).toEqual({ records: ["new"] });
  sync.stop(); unsubscribe(); client.clear();
});

it("uses notifications as hints and catches up missing events through the durable cursor", async () => {
  const client = new QueryClient();
  client.setQueryData(queryKeys.projectPage(1), {});
  client.setQueryData(queryKeys.projectPage(2), {});
  const read = vi.fn(async (afterSeq: number): Promise<AgentChangePage> => ({
    entries: afterSeq === 5 ? [change(6, 1), change(7, 2, "file", "11")] : [],
    cursor: 7, hasMore: false, resetRequired: false,
  }));
  const sync = createBusinessChangeSync({ binding, queryClient: client, readChanges: read, initialSeq: 5 });
  await sync.notify({ binding, seq: 7, changedRefs: [], resetRequired: false });
  expect(read).toHaveBeenCalledWith(5);
  expect(client.getQueryState(queryKeys.projectPage(1))?.isInvalidated).toBe(true);
  expect(client.getQueryState(queryKeys.projectPage(2))?.isInvalidated).toBe(true);
  expect(sync.lastSeq()).toBe(7);
  await sync.notify({ binding: { ...binding, generation: "old-open" }, seq: 9, changedRefs: [], resetRequired: false });
  await sync.notify({ binding, seq: 7, changedRefs: [], resetRequired: false });
  expect(read).toHaveBeenCalledOnce();
  sync.stop(); client.clear();
});

it("discards late catch-up after a Workspace switch and keeps failed cursors retryable", async () => {
  const client = new QueryClient(); client.setQueryData(queryKeys.projectPage(1), {});
  let resolve!: (page: AgentChangePage) => void;
  const pending = new Promise<AgentChangePage>(done => { resolve = done; });
  const sync = createBusinessChangeSync({ binding, queryClient: client, readChanges: () => pending, initialSeq: 4 });
  const read = sync.catchUp(); sync.stop();
  resolve({ entries: [change(5, 1)], cursor: 5, hasMore: false, resetRequired: false });
  await read;
  expect(client.getQueryState(queryKeys.projectPage(1))?.isInvalidated).toBe(false);
  expect(sync.lastSeq()).toBe(4);
  const recover = vi.fn().mockRejectedValueOnce(new Error("disconnected")).mockResolvedValueOnce({ entries: [change(5, 1)], cursor: 5, hasMore: false, resetRequired: false });
  const retry = createBusinessChangeSync({ binding, queryClient: client, readChanges: recover, initialSeq: 4 });
  await expect(retry.catchUp()).rejects.toThrow("disconnected");
  expect(retry.lastSeq()).toBe(4);
  await retry.catchUp(); expect(retry.lastSeq()).toBe(5);
  retry.stop(); client.clear();
});

it("paginates bounded logs and resets Workspace caches when history has expired", async () => {
  const client = new QueryClient();
  client.setQueryData(queryKeys.projectPage(1), {}); client.setQueryData(queryKeys.contacts.all, {});
  const read = vi.fn().mockResolvedValueOnce({ entries: [change(1, 1)], cursor: 1, hasMore: true, resetRequired: false })
    .mockResolvedValueOnce({ entries: [], cursor: 20, hasMore: false, resetRequired: true });
  const sync = createBusinessChangeSync({ binding, queryClient: client, readChanges: read });
  await sync.catchUp();
  expect(read.mock.calls).toEqual([[0], [1]]);
  expect(sync.lastSeq()).toBe(20);
  expect(client.getQueryState(queryKeys.contacts.all)?.isInvalidated).toBe(true);
  sync.stop(); client.clear();
});

it("refreshes Workspace File lists and versions without invalidating a Project's page", async () => {
  const client = new QueryClient();
  client.setQueryData(queryKeys.workspacePage, { workspaceDocuments: [] });
  client.setQueryData(queryKeys.documentVersions(51), []);
  client.setQueryData(queryKeys.projectPage(7), { projectDocuments: [] });
  const sync = createBusinessChangeSync({ binding, queryClient: client, readChanges: async () => ({ entries: [change(1, null, "file", "51")], cursor: 1, hasMore: false, resetRequired: false }) });
  await sync.catchUp();
  expect(client.getQueryState(queryKeys.workspacePage)?.isInvalidated).toBe(true);
  expect(client.getQueryState(queryKeys.documentVersions(51))?.isInvalidated).toBe(true);
  expect(client.getQueryState(queryKeys.projectPage(7))?.isInvalidated).toBe(false);
  sync.stop(); client.clear();
});
