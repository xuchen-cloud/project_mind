import { act, renderHook } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useInternalReferenceSearch } from "./InternalReferencePicker";
import { createBusinessChangeSync } from "../../lib/business-change-sync";
import { desktopApi } from "../../services/desktopApi";
import type { AgentChangePage } from "../../lib/agent-types";
import type { InternalReferenceContext, InternalReferenceSearchResult } from "../../lib/types";

const binding = { workspaceId: "w1", generation: "open-1" };
const candidate: InternalReferenceSearchResult = {
  kind: "note", id: 7, label: "Moved Record", scope: "project", projectId: 1,
  subtitle: "Project One", updatedAt: "2026-11-10T00:00:00Z",
};
const ownerChange: AgentChangePage = {
  entries: [{ seq: 1, objectKey: "w1/project:1/record/7", scope: { kind: "project", projectId: 1 },
    operation: "record.update", revision: "new", createdAt: "2026-11-10T00:00:00Z" }],
  cursor: 1, hasMore: false, resetRequired: false,
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const search = () => act(async () => { await vi.advanceTimersByTimeAsync(120); });

it("clears open Project candidates after a native owner change and searches again in the original scope", async () => {
  const command = vi.spyOn(desktopApi, "command").mockResolvedValueOnce([candidate]).mockResolvedValueOnce([]);
  const { result } = renderHook(() => useInternalReferenceSearch({
    open: true, query: "Moved", context: { scope: "project", projectId: 1 }, limit: 5,
  }));
  await search();
  expect(result.current.results).toEqual([candidate]);
  const client = new QueryClient();
  const sync = createBusinessChangeSync({ binding, queryClient: client, readChanges: async () => ownerChange });
  await act(async () => { await sync.catchUp(); });
  expect(result.current.results).toEqual([]);
  await search();
  expect(command.mock.calls).toEqual([
    ["internal_reference_search", { input: { query: "Moved", scope: "project", projectId: 1, limit: 5 } }],
    ["internal_reference_search", { input: { query: "Moved", scope: "project", projectId: 1, limit: 5 } }],
  ]);
  expect(result.current.results).toEqual([]);
  sync.stop(); client.clear();
});

it.each(["resolve", "reject"])("ignores an in-flight search that %ss after its owner scope changes", async (settlement) => {
  let resolve!: (results: InternalReferenceSearchResult[]) => void;
  let reject!: (error: Error) => void;
  const stale = new Promise<InternalReferenceSearchResult[]>((done, fail) => { resolve = done; reject = fail; });
  const command = vi.spyOn(desktopApi, "command").mockReturnValueOnce(stale).mockResolvedValueOnce([]);
  const { result } = renderHook(() => useInternalReferenceSearch({
    open: true, query: "Moved", context: { scope: "project", projectId: 1 },
  }));
  await search();
  expect(result.current.loading).toBe(true);
  const client = new QueryClient();
  const sync = createBusinessChangeSync({ binding, queryClient: client, readChanges: async () => ownerChange });
  await act(async () => {
    await sync.catchUp();
    if (settlement === "resolve") resolve([candidate]);
    else reject(new Error("old search failed"));
  });
  expect(result.current.results).toEqual([]);
  expect(result.current.loading).toBe(true);
  await search();
  expect(command).toHaveBeenCalledTimes(2);
  expect(result.current.results).toEqual([]);
  expect(result.current.loading).toBe(false);
  sync.stop(); client.clear();
});

it("keeps fresh candidates when a pre-move response arrives after the new search completes", async () => {
  let resolve!: (results: InternalReferenceSearchResult[]) => void;
  const stale = new Promise<InternalReferenceSearchResult[]>(done => { resolve = done; });
  const remaining = { ...candidate, id: 8, label: "Remaining Record" };
  vi.spyOn(desktopApi, "command").mockReturnValueOnce(stale).mockResolvedValueOnce([remaining]);
  const { result } = renderHook(() => useInternalReferenceSearch({
    open: true, query: "", context: { scope: "project", projectId: 1 },
  }));
  await search();
  const client = new QueryClient();
  const sync = createBusinessChangeSync({ binding, queryClient: client, readChanges: async () => ownerChange });
  await act(async () => { await sync.catchUp(); });
  await search();
  expect(result.current.results).toEqual([remaining]);
  await act(async () => { resolve([candidate]); });
  expect(result.current.results).toEqual([remaining]);
  expect(result.current.loading).toBe(false);
  sync.stop(); client.clear();
});

const visibilityCases: { context: InternalReferenceContext; changedProject: number | null; refresh: boolean }[] = [
  { context: { scope: "project", projectId: 1 }, changedProject: 1, refresh: true },
  { context: { scope: "project", projectId: 1 }, changedProject: 2, refresh: false },
  { context: { scope: "project", projectId: 1 }, changedProject: null, refresh: false },
  { context: { scope: "workspace" }, changedProject: 1, refresh: true },
  { context: { scope: "workspace" }, changedProject: 2, refresh: true },
  { context: { scope: "workspace" }, changedProject: null, refresh: true },
];
it.each(visibilityCases)(
  "refreshes $context.scope:$context.projectId for visible File scope $changedProject: $refresh", async ({ context, changedProject, refresh }) => {
    const command = vi.spyOn(desktopApi, "command").mockResolvedValue([candidate]);
    const { result } = renderHook(() => useInternalReferenceSearch({ open: true, query: "", context }));
    await search();
    const scope = changedProject === null ? { kind: "workspace" as const }
      : { kind: "project" as const, projectId: changedProject };
    const client = new QueryClient();
    const sync = createBusinessChangeSync({ binding, queryClient: client, readChanges: async () => ({
      ...ownerChange, entries: [{ ...ownerChange.entries[0], scope,
        objectKey: `w1/${changedProject === null ? "workspace" : `project:${changedProject}`}/file/7`,
        operation: "file.update" }],
    }) });
    await act(async () => { await sync.catchUp(); });
    expect(result.current.results).toEqual(refresh ? [] : [candidate]);
    await search();
    expect(command).toHaveBeenCalledTimes(refresh ? 2 : 1);
    expect(command).toHaveBeenLastCalledWith("internal_reference_search", {
      input: { query: "", scope: context.scope, projectId: context.projectId ?? null, limit: 8 },
    });
    sync.stop(); client.clear();
  },
);

it.each(["project", "workspace"] as const)("refreshes an open %s picker after a native history reset", async (scope) => {
  const command = vi.spyOn(desktopApi, "command").mockResolvedValueOnce([candidate]).mockResolvedValueOnce([]);
  const { result } = renderHook(() => useInternalReferenceSearch({ open: true, query: "", context: { scope, projectId: scope === "project" ? 1 : null } }));
  await search();
  const client = new QueryClient();
  const sync = createBusinessChangeSync({ binding, queryClient: client, readChanges: async () => ({
    entries: [], cursor: 20, hasMore: false, resetRequired: true,
  }) });
  await act(async () => { await sync.catchUp(); });
  expect(result.current.results).toEqual([]);
  await search();
  expect(command).toHaveBeenCalledTimes(2);
  sync.stop(); client.clear();
});

it("does not search from business changes while closed or after unmount", async () => {
  const command = vi.spyOn(desktopApi, "command").mockResolvedValue([candidate]);
  const { result, rerender, unmount } = renderHook(({ open }) => useInternalReferenceSearch({
    open, query: "", context: { scope: "project", projectId: 1 },
  }), { initialProps: { open: true } });
  await search();
  rerender({ open: false });
  const client = new QueryClient();
  let cursor = 0;
  const sync = createBusinessChangeSync({ binding, queryClient: client, readChanges: async () => ({ ...ownerChange, cursor: ++cursor }) });
  await act(async () => { await sync.catchUp(); });
  await search();
  expect(result.current.results).toEqual([]);
  expect(result.current.loading).toBe(false);
  expect(command).toHaveBeenCalledOnce();
  unmount();
  await sync.catchUp();
  await search();
  expect(command).toHaveBeenCalledOnce();
  sync.stop(); client.clear();
});
