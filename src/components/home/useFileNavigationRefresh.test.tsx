import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { ProjectSidebarDocumentItem } from "../layout/ProjectSidebar";
import { useFileNavigationRefresh } from "./useFileNavigationRefresh";
import { projectDirectoryQueryKey } from "../../lib/project-directory-query";

const native = vi.hoisted(() => ({ list: vi.fn(), binding: vi.fn(), listen: vi.fn() }));
vi.mock("../../services/projectDirectoryApi", () => ({ projectDirectoryApi: { list: native.list } }));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: native.binding } }));
vi.mock("../../services/desktopApi", () => ({ desktopApi: { listenEvent: native.listen } }));
const directory = (path: string) => ({ name: path.split("/").pop(), relativePath: path, kind: "directory", bytes: 0 });
const file = (path: string) => ({ ...directory(path), kind: "file" });
const item = (id: number, path: string, health = "normal") => ({ id, managedPath: `/root/${path}`, health }) as ProjectSidebarDocumentItem;
beforeEach(() => {
  vi.resetAllMocks();
  native.binding.mockResolvedValue({ workspaceId: "w", generation: "g" });
  native.list.mockResolvedValue([]);
});
function setup(projectId: number | null, documents: ProjectSidebarDocumentItem[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const hook = renderHook(props => useFileNavigationRefresh(props), {
    initialProps: { projectId, rootPath: "/root", workspaceRoot: "/workspace", enabled: true, documents },
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  return { ...hook, invalidate, client };
}
it.each([7, null])("refreshes real membership and the correct owner page without destroying cached history (owner=%s)", async projectId => {
  const missing = item(1, "gone.txt"), present = item(2, "nested/live.txt");
  native.list.mockImplementation(async (_id, path) => path === "" ? [directory("nested")] : [file("nested/live.txt")]);
  const hook = setup(projectId, [missing, present]);
  hook.client.setQueryData(["documentVersions", 1], ["retained history"]);
  await act(async () => { await hook.result.current.refresh(); });
  expect(hook.result.current.visibleDocuments).toEqual([present]);
  expect(native.list.mock.calls).toEqual([[projectId, ""], [projectId, "nested"]]);
  expect(hook.invalidate).toHaveBeenCalledWith({ queryKey: projectId === null ? ["workspace-page"] : ["project-page", 7] }, { cancelRefetch: false, throwOnError: true });
  expect(hook.client.getQueryData(["documentVersions", 1])).toEqual(["retained history"]);
});
it("hides missing navigation on initial use and brings restored originals back after refresh", async () => {
  const restored = item(1, "restored.txt", "missing");
  const hook = setup(7, [restored]);
  expect(hook.result.current.visibleDocuments).toEqual([]);
  native.list.mockResolvedValue([file("restored.txt")]);
  await act(async () => { await hook.result.current.refresh(); });
  expect(hook.result.current.visibleDocuments).toEqual([restored]);
});
it("removes descendants of a deleted folder without querying its nonexistent path", async () => {
  const hook = setup(7, [item(1, "removed/deep/gone.txt")]);
  await act(async () => { await hook.result.current.refresh(); });
  expect(hook.result.current.visibleDocuments).toEqual([]);
  expect(native.list.mock.calls).toEqual([[7, ""]]);
});
it("keeps navigation on unreadable directories and reports the failure", async () => {
  const retained = item(1, "private/file.txt");
  const hook = setup(7, [retained]);
  native.list.mockImplementation(async (_id, path) => { if (path === "") return [directory("private")]; throw new Error("权限不足"); });
  await act(async () => { await hook.result.current.refresh(); });
  expect(hook.result.current.visibleDocuments).toEqual([retained]);
  expect(hook.result.current.error).toBe("权限不足");
});
it("discards a pending old scope check and never hides a File at its updated path", async () => {
  let resolve!: (value: unknown[]) => void;
  native.list.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const hook = setup(7, [item(1, "old.txt")]);
  let refresh!: Promise<void>;
  act(() => { refresh = hook.result.current.refresh(); });
  await waitFor(() => expect(native.list).toHaveBeenCalledOnce());
  const moved = item(1, "moved.txt");
  hook.rerender({ projectId: 8, rootPath: "/root", workspaceRoot: "/workspace", enabled: true, documents: [moved] });
  await act(async () => { resolve([]); await refresh; });
  expect(hook.result.current.visibleDocuments).toEqual([moved]);
});
it("checks watcher binding and owner, then reconciles deletion without a click", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  let dirty!: (hint: unknown) => void;
  const unlisten = vi.fn();
  native.listen.mockImplementation(async (_event, callback) => { dirty = callback; return unlisten; });
  const hook = setup(null, [item(1, "deleted.txt")]);
  try {
    await waitFor(() => expect(native.binding).toHaveBeenCalled());
    await act(async () => {});
    act(() => {
      dirty({ binding: { workspaceId: "w", generation: "old" }, projectId: null });
      dirty({ binding: { workspaceId: "w", generation: "g" }, projectId: 7 });
    });
    expect(native.list).not.toHaveBeenCalled();
    act(() => dirty({ binding: { workspaceId: "w", generation: "g" }, projectId: null, relativePaths: [""] }));
    await waitFor(() => expect(hook.result.current.visibleDocuments).toEqual([]));
  } finally { hook.unmount(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); }
  expect(unlisten).toHaveBeenCalledOnce();
});

it("checks only affected registered parents for a scoped dirty hint", async () => {
  const retained = item(2, "other/live.txt");
  native.list.mockImplementation(async (_id, path) => path === "" ? [directory("changed"), directory("other")] : []);
  const hook = setup(7, [item(1, "changed/gone.txt"), retained]);
  await act(async () => { await hook.result.current.refresh(["changed"]); });
  expect(hook.result.current.visibleDocuments).toEqual([retained]);
  expect(native.list.mock.calls).toEqual([[7, ""], [7, "changed"]]);
});

it("does not apply a deleted File's presence check to a different File at the same path", async () => {
  const hook = setup(7, [item(1, "same.txt")]);
  await act(async () => { await hook.result.current.refresh(); });
  expect(hook.result.current.visibleDocuments).toEqual([]);
  const replacement = item(2, "same.txt");
  hook.rerender({ projectId: 7, rootPath: "/root", workspaceRoot: "/workspace", enabled: true, documents: [replacement] });
  expect(hook.result.current.visibleDocuments).toEqual([replacement]);
});

it("rejects a presence result if the native Workspace generation changed during enumeration", async () => {
  const retained = item(1, "maybe.txt");
  native.binding.mockResolvedValueOnce({ workspaceId: "w", generation: "before" }).mockResolvedValueOnce({ workspaceId: "w", generation: "after" });
  const hook = setup(7, [retained]);
  await act(async () => { await hook.result.current.refresh(); });
  expect(hook.result.current.visibleDocuments).toEqual([retained]);
  expect(hook.result.current.error).toContain("工作区已切换");
});

it("honors newly missing native health after an earlier successful presence check", async () => {
  native.list.mockResolvedValue([file("deleted-by-app.txt")]);
  const hook = setup(7, [item(1, "deleted-by-app.txt")]);
  await act(async () => { await hook.result.current.refresh(); });
  expect(hook.result.current.visibleDocuments).toHaveLength(1);
  hook.rerender({ projectId: 7, rootPath: "/root", workspaceRoot: "/workspace", enabled: true, documents: [item(1, "deleted-by-app.txt", "missing")] });
  expect(hook.result.current.visibleDocuments).toEqual([]);
});

it("does not reuse missing presence after A-B-A scope navigation", async () => {
  const original = item(1, "restored.txt");
  const hook = setup(7, [original]);
  await act(async () => { await hook.result.current.refresh(); });
  expect(hook.result.current.visibleDocuments).toEqual([]);
  hook.rerender({ projectId: 8, rootPath: "/root", workspaceRoot: "/workspace", enabled: true, documents: [] });
  hook.rerender({ projectId: 7, rootPath: "/root", workspaceRoot: "/workspace", enabled: true, documents: [original] });
  expect(hook.result.current.visibleDocuments).toEqual([original]);
});

it("drops the prior binding's presence even if reading the reopened Workspace fails", async () => {
  const original = item(1, "restored.txt");
  const hook = setup(7, [original]);
  await act(async () => { await hook.result.current.refresh(); });
  expect(hook.result.current.visibleDocuments).toEqual([]);
  native.binding.mockResolvedValue({ workspaceId: "w", generation: "reopened" });
  native.list.mockRejectedValue(new Error("暂时不可读"));
  await act(async () => { await hook.result.current.refresh(); });
  expect(hook.result.current.error).toBe("暂时不可读");
  expect(hook.result.current.visibleDocuments).toEqual([original]);
});

it("keeps a same-path replacement visible when the old File's in-flight check completes", async () => {
  const hook = setup(7, [item(1, "same.txt")]);
  let finish!: (value: unknown[]) => void;
  native.list.mockReturnValueOnce(new Promise(done => { finish = done; }));
  let refresh!: Promise<void>;
  act(() => { refresh = hook.result.current.refresh(); });
  await waitFor(() => expect(native.list).toHaveBeenCalledOnce());
  const replacement = item(2, "same.txt");
  hook.rerender({ projectId: 7, rootPath: "/root", workspaceRoot: "/workspace", enabled: true, documents: [replacement] });
  await act(async () => { finish([]); await refresh; });
  expect(hook.result.current.visibleDocuments).toEqual([replacement]);
});

it("merges a queued manual refresh with dirty paths and restores all parents", async () => {
  const documents = [item(1, "a/one.txt"), item(2, "b/two.txt")];
  const hook = setup(7, documents);
  await act(async () => { await hook.result.current.refresh(); });
  expect(hook.result.current.visibleDocuments).toEqual([]);
  let finish!: (value: unknown[]) => void;
  native.list.mockClear().mockReturnValueOnce(new Promise(done => { finish = done; }));
  let refresh!: Promise<void>;
  act(() => { refresh = hook.result.current.refresh(["a"]); });
  await waitFor(() => expect(native.list).toHaveBeenCalledOnce());
  act(() => { void hook.result.current.refresh(); void hook.result.current.refresh(["b"]); });
  native.list.mockImplementation(async (_owner, path) => path === "" ? [directory("a"), directory("b")] : [file(path === "a" ? "a/one.txt" : "b/two.txt")]);
  await act(async () => { finish([directory("a"), directory("b")]); await refresh; });
  expect(hook.result.current.visibleDocuments).toEqual(documents);
  expect(native.list.mock.calls.map(call => call[1])).toEqual(["", "a", "", "a", "b"]);
});

it("consumes a queued dirty hint even when the in-flight enumeration fails", async () => {
  const hook = setup(7, [item(1, "gone.txt")]);
  let fail!: (reason: Error) => void;
  native.list.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
  let refresh!: Promise<void>;
  act(() => { refresh = hook.result.current.refresh(); });
  await waitFor(() => expect(native.list).toHaveBeenCalledOnce());
  act(() => { void hook.result.current.refresh([""]); });
  await act(async () => { fail(new Error("暂时不可读")); await refresh; });
  expect(native.list).toHaveBeenCalledTimes(2);
  expect(hook.result.current.visibleDocuments).toEqual([]);
  expect(hook.result.current.error).toBe("");
});

it("does not let delayed listener setup roll a refreshed binding back to an old generation", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  let dirty!: (hint: unknown) => void;
  native.listen.mockImplementation(async (_event, callback) => { dirty = callback; return vi.fn(); });
  let finishBinding!: (value: { workspaceId: string; generation: string }) => void;
  native.binding.mockReturnValueOnce(new Promise(done => { finishBinding = done; }))
    .mockResolvedValue({ workspaceId: "w", generation: "new" });
  const hook = setup(7, [item(1, "gone.txt")]);
  try {
    await waitFor(() => expect(native.binding).toHaveBeenCalledOnce());
    await act(async () => { await hook.result.current.refresh(); });
    expect(hook.result.current.binding?.generation).toBe("new");
    await act(async () => finishBinding({ workspaceId: "w", generation: "old" }));
    expect(hook.result.current.binding?.generation).toBe("new");
    native.list.mockClear();
    act(() => dirty({ binding: { workspaceId: "w", generation: "old" }, projectId: 7 }));
    expect(native.list).not.toHaveBeenCalled();
    act(() => dirty({ binding: { workspaceId: "w", generation: "new" }, projectId: 7 }));
    await waitFor(() => expect(native.list).toHaveBeenCalledOnce());
  } finally { hook.unmount(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); }
});

it.each([7, null])("manual refresh skips ENOENT expanded descendants after their parent confirms deletion and updates both views (owner=%s)", async owner => {
  const retained = item(2, "live/current.txt");
  const hook = setup(owner, [item(1, "removed/deep/gone.txt"), retained]);
  const key = (path: string) => projectDirectoryQueryKey("/root", owner, path, "/workspace", { workspaceId: "w", generation: "g" });
  const removedRead = vi.fn().mockRejectedValue(new Error("ENOENT: removed"));
  const cached = [
    { path: "", data: [directory("removed"), directory("live")] },
    { path: "removed", data: [directory("removed/deep")] },
    { path: "removed/deep", data: [file("removed/deep/gone.txt")] },
    { path: "live", data: [file("live/old.txt")] },
  ];
  const observers = cached.map(({ path, data }) => new QueryObserver(hook.client, { queryKey: key(path), staleTime: Infinity,
    initialData: data, queryFn: path.startsWith("removed") ? removedRead : async () => native.list(owner, path) }));
  const unsubscribe = observers.map(observer => observer.subscribe(() => {}));
  const foreignKey = projectDirectoryQueryKey("/root", owner, "removed", "/other-workspace", { workspaceId: "other", generation: "g" });
  hook.client.setQueryData(foreignKey, [file("foreign.txt")]);
  native.list.mockImplementation(async (_owner, path) => {
    if (path === "") return [directory("live")];
    if (path === "live") return [file("live/current.txt")];
    throw new Error(`ENOENT: ${path}`);
  });
  try {
    await act(async () => { await hook.result.current.refresh(); });
    expect(hook.result.current.error).toBe("");
    expect(hook.result.current.visibleDocuments).toEqual([retained]);
    expect(native.list.mock.calls).toEqual([[owner, ""], [owner, "live"]]);
    expect(removedRead).not.toHaveBeenCalled();
    expect(hook.client.getQueryData(key(""))).toEqual([directory("live")]);
    expect(hook.client.getQueryData(key("removed"))).toEqual([]);
    expect(hook.client.getQueryData(key("removed/deep"))).toEqual([]);
    expect(hook.client.getQueryData(key("live"))).toEqual([file("live/current.txt")]);
    expect(hook.client.getQueryData(foreignKey)).toEqual([file("foreign.txt")]);
    expect(hook.client.getQueryState(foreignKey)?.isInvalidated).toBe(false);
  } finally { for (const stop of unsubscribe) stop(); }
});

it.each(["EACCES: private", "ENOENT after parent enumeration"])("manual refresh reports %s when the parent still lists that expanded directory", async message => {
  const retained = item(1, "private/file.txt");
  const hook = setup(7, [retained]);
  const key = projectDirectoryQueryKey("/root", 7, "private", "/workspace", { workspaceId: "w", generation: "g" });
  const observer = new QueryObserver(hook.client, { queryKey: key, staleTime: Infinity,
    initialData: [file("private/file.txt")], queryFn: async () => native.list(7, "private") });
  const unsubscribe = observer.subscribe(() => {});
  native.list.mockImplementation(async (_owner, path) => {
    if (path === "") return [directory("private")];
    throw new Error(message);
  });
  try {
    await act(async () => { await hook.result.current.refresh(); });
    expect(hook.result.current.error).toBe(message);
    expect(hook.result.current.visibleDocuments).toEqual([retained]);
    expect(hook.client.getQueryData(key)).toEqual([file("private/file.txt")]);
  } finally { unsubscribe(); }
});

it("manual refresh reconciles expanded unregistered directories even with no managed Files", async () => {
  const hook = setup(7, []);
  const key = projectDirectoryQueryKey("/root", 7, "outer/inner", "/workspace", { workspaceId: "w", generation: "g" });
  const observer = new QueryObserver(hook.client, { queryKey: key, staleTime: Infinity,
    initialData: [file("outer/inner/old.txt")], queryFn: async () => native.list(7, "outer/inner") });
  const unsubscribe = observer.subscribe(() => {});
  native.list.mockImplementation(async (_owner, path) => path === "" ? [directory("outer")]
    : path === "outer" ? [directory("outer/inner")] : [file("outer/inner/new.txt")]);
  try {
    await act(async () => { await hook.result.current.refresh(); });
    expect(hook.result.current.error).toBe("");
    expect(native.list.mock.calls).toEqual([[7, ""], [7, "outer"], [7, "outer/inner"]]);
    expect(hook.client.getQueryData(key)).toEqual([file("outer/inner/new.txt")]);
  } finally { unsubscribe(); }
});

it("waits for an old expanded read before publishing a new manual snapshot", async () => {
  const hook = setup(7, [item(1, "removed/gone.txt")]);
  const key = projectDirectoryQueryKey("/root", 7, "", "/workspace", { workspaceId: "w", generation: "g" });
  let finish!: (entries: ReturnType<typeof directory>[]) => void;
  const read = vi.fn().mockReturnValueOnce(new Promise(done => { finish = done; }));
  const observer = new QueryObserver(hook.client, { queryKey: key, staleTime: Infinity,
    initialData: [directory("removed")], queryFn: read });
  const unsubscribe = observer.subscribe(() => {});
  try {
    let oldRead!: ReturnType<typeof observer.refetch>;
    act(() => { oldRead = observer.refetch(); });
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    let refresh!: Promise<void>;
    act(() => { refresh = hook.result.current.refresh(); });
    await act(async () => {});
    expect(native.list).not.toHaveBeenCalled();
    await act(async () => { finish([directory("removed")]); await oldRead; await refresh; });
    expect(native.list.mock.calls).toEqual([[7, ""]]);
    expect(hook.result.current.visibleDocuments).toEqual([]);
    expect(hook.result.current.error).toBe("");
    expect(hook.client.getQueryData(key)).toEqual([]);
  } finally { unsubscribe(); }
});

it("settles an expanded read mounted by page refresh before publishing the manual snapshot", async () => {
  const hook = setup(7, []);
  const key = projectDirectoryQueryKey("/root", 7, "", "/workspace", { workspaceId: "w", generation: "g" });
  let finish!: (entries: ReturnType<typeof directory>[]) => void;
  const read = vi.fn().mockReturnValueOnce(new Promise(done => { finish = done; }));
  let stopExpanded = () => {};
  const page = new QueryObserver(hook.client, { queryKey: ["project-page", 7], staleTime: Infinity, initialData: "old page",
    queryFn: async () => {
      const expanded = new QueryObserver(hook.client, { queryKey: key, staleTime: Infinity,
        initialData: [directory("removed")], queryFn: read });
      stopExpanded = expanded.subscribe(() => {});
      void expanded.refetch();
      return "new page";
    } });
  const stopPage = page.subscribe(() => {});
  try {
    let refresh!: Promise<void>;
    act(() => { refresh = hook.result.current.refresh(); });
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(native.list).not.toHaveBeenCalled();
    await act(async () => { finish([directory("removed")]); await refresh; });
    expect(hook.result.current.error).toBe("");
    expect(hook.client.getQueryData(key)).toEqual([]);
    expect(native.list.mock.calls).toEqual([[7, ""]]);
  } finally { stopExpanded(); stopPage(); }
});
