import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { projectMindApi } from "../services/projectMindApi";
import { queryKeys } from "../lib/queryKeys";
import { useTodoModule } from "./use-todo-module";
import type { ProjectListItem, TodoRecord } from "../lib/types";
import { useFeedbackStore } from "../state/feedback-store";
import { createBusinessChangeSync } from "../lib/business-change-sync";

const todo: TodoRecord = {
  revision: 1,
  id: 1, scope: "workspace", projectId: null, content: "不能凭空消失的待办",
  status: "unfinished", priority: "not_urgent_important", dueDate: null,
  tags: [], progresses: [], createdAt: "2026-09-27", updatedAt: "2026-09-27",
};
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("keeps visible todos through cache GC without requiring manual refresh", async () => {
  vi.useFakeTimers();
  vi.spyOn(projectMindApi, "projectsList").mockResolvedValue([]);
  vi.spyOn(projectMindApi, "workspacePageGet").mockResolvedValue({ quickNote: null, records: [], unfinishedTodos: [todo], finishedTodos: [] });
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 100, staleTime: Infinity, retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useTodoModule({ kind: "workspace" }), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(hook.result.current.view.unfinishedTodos.map((item) => item.id)).toEqual([1]);
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(hook.result.current.view.unfinishedTodos.map((item) => item.id)).toEqual([1]);
  const updated = { ...todo, content: "更新后仍然可见" };
  vi.spyOn(projectMindApi, "todoUpdateContent").mockResolvedValue(updated);
  await act(async () => {
    await hook.result.current.change({ type: "update-content", todoId: 1, content: updated.content });
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(hook.result.current.view.unfinishedTodos[0].content).toBe(updated.content);
  hook.unmount(); client.clear();
});

it.each(["collection", "projects"])("reloads missing %s data when returning to a cached view", async (missing) => {
  vi.useFakeTimers();
  vi.spyOn(projectMindApi, "projectsList").mockResolvedValue([]);
  const load = vi.spyOn(projectMindApi, "workspacePageGet").mockResolvedValue({ quickNote: null, records: [], unfinishedTodos: [todo], finishedTodos: [] });
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 100, staleTime: Infinity, refetchOnMount: false, retry: false } } });
  client.setQueryDefaults(queryKeys.todoViews.all, { gcTime: 1000 });
  if (missing === "projects") client.setQueryDefaults(queryKeys.todoCollections.all, { gcTime: 1000 });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const first = renderHook(() => useTodoModule({ kind: "workspace" }), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  first.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  if (missing === "collection") expect(client.getQueryData(queryKeys.todoCollections.workspaceRail)).toBeUndefined();
  else {
    expect(client.getQueryData(queryKeys.todoCollections.workspaceRail)).toBeDefined();
    expect(client.getQueryData(queryKeys.projects.all)).toBeUndefined();
  }
  expect(client.getQueryData(queryKeys.todoViews.workspace)).toBeDefined();
  const second = renderHook(() => useTodoModule({ kind: "workspace" }), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(second.result.current.view.unfinishedTodos.map((item) => item.id)).toEqual([1]);
  expect(load).toHaveBeenCalledTimes(2);
  second.unmount(); client.clear();
});

const project: ProjectListItem = {
  id: 7, name: "测试项目", kind: "normal", status: "active", rootPath: "/tmp/project",
  quickNote: "", isArchived: false, openTodoCount: 1, createdAt: "2026-09-27", updatedAt: "2026-09-27",
};

it("retains project tasks and project metadata across GC, including while a page is warm", async () => {
  vi.useFakeTimers();
  const projectTodo: TodoRecord = { ...todo, scope: "project", projectId: 7 };
  vi.spyOn(projectMindApi, "projectsList").mockResolvedValue([project]);
  vi.spyOn(projectMindApi, "workspacePageGet").mockResolvedValue({ quickNote: null, records: [], unfinishedTodos: [projectTodo], finishedTodos: [] });
  vi.spyOn(projectMindApi, "projectPageGet").mockResolvedValue({ project, projectDocuments: [], records: [], unfinishedTodos: [projectTodo], finishedTodos: [] });
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 100, staleTime: Infinity, retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const workspace = renderHook(({ enabled }) => useTodoModule({ kind: "workspace" }, enabled), { wrapper, initialProps: { enabled: true } });
  const projectView = renderHook(() => useTodoModule({ kind: "current-project", projectId: 7 }), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  workspace.rerender({ enabled: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(workspace.result.current.view.unfinishedTodos.map((item) => item.id)).toEqual([1]);
  expect(projectView.result.current.view.unfinishedTodos.map((item) => item.id)).toEqual([1]);
  expect(workspace.result.current.view.projects.map((item) => item.id)).toEqual([7]);
  workspace.unmount(); projectView.unmount(); client.clear();
});

it("shows a readable GUI conflict after refreshing the actual Todo head and never retries the write", async () => {
  const current = { ...todo, revision: 8, content: "Agent 已保存的新内容" };
  vi.spyOn(projectMindApi, "projectsList").mockResolvedValue([]);
  const load = vi.spyOn(projectMindApi, "workspacePageGet").mockResolvedValueOnce({ quickNote: null, records: [], unfinishedTodos: [todo], finishedTodos: [] })
    .mockResolvedValue({ quickNote: null, records: [], unfinishedTodos: [current], finishedTodos: [] });
  const conflict = JSON.stringify({ code: "REVISION_CONFLICT", message: "Todo head changed" });
  const update = vi.spyOn(projectMindApi, "todoUpdateContent").mockRejectedValueOnce(conflict);
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useTodoModule({ kind: "workspace" }), { wrapper });
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  await act(async () => { await expect(hook.result.current.change({ type: "update-content", todoId: 1, content: "过期输入" })).rejects.toBe(conflict); });
  expect(update).toHaveBeenCalledOnce(); expect(load).toHaveBeenCalledTimes(2);
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: todo.revision }));
  expect(hook.result.current.view.unfinishedTodos[0]).toMatchObject(current);
  const toasts = useFeedbackStore.getState().toasts;
  expect(toasts[toasts.length - 1].detail).toBe("Todo 已变化，已刷新最新数据。请核对后重新操作。");
  hook.unmount(); client.clear();
});

it.each(["workspace", "current-project"] as const)("refreshes the visible %s rail after native changes while its source page is refetching", async (kind) => {
  const original: TodoRecord = { ...todo, scope: "project", projectId: 7 };
  const added = { ...original, id: 2, content: "会话新建的待办" };
  const finished = { ...original, revision: 2, status: "finished" as const, progresses: [{
    id: 3, todoId: 1, content: "会话新增的子任务", status: "unfinished" as const,
    progressDate: "2026-10-22", dueDate: null, createdAt: original.createdAt, updatedAt: original.updatedAt,
  }] };
  const before = { project, projectDocuments: [], quickNote: null, records: [], unfinishedTodos: [original], finishedTodos: [] };
  const after = { ...before, unfinishedTodos: [added], finishedTodos: [finished] };
  let release!: (page: typeof after) => void;
  const pending = new Promise<typeof after>(resolve => { release = resolve; });
  vi.spyOn(projectMindApi, "projectsList").mockResolvedValue([project]);
  const pageGet = kind === "workspace" ? vi.spyOn(projectMindApi, "workspacePageGet") : vi.spyOn(projectMindApi, "projectPageGet");
  pageGet.mockResolvedValueOnce(before).mockReturnValueOnce(pending);
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const scope = kind === "workspace" ? { kind } as const : { kind, projectId: 7 } as const;
  const pageKey = kind === "workspace" ? queryKeys.workspacePage : queryKeys.projectPage(7);
  const hook = renderHook(() => {
    // The visible main page and Todo rail share this source query. The native
    // notification starts its refetch before invalidating the derived rail.
    useQuery({ queryKey: pageKey, queryFn: () => kind === "workspace" ? projectMindApi.workspacePageGet() : projectMindApi.projectPageGet({ projectId: 7 }) });
    return useTodoModule(scope);
  }, { wrapper });
  await waitFor(() => expect(hook.result.current.view.unfinishedTodos.map(item => item.id)).toEqual([1]));
  const binding = { workspaceId: "w1", generation: "g1" };
  const sync = createBusinessChangeSync({ binding, queryClient: client, readChanges: async () => ({
    entries: [{ seq: 1, objectKey: "w1/project:7/todo/1", scope: { kind: "project", projectId: 7 }, operation: "todo.update", revision: "2", createdAt: "2026-10-22" }],
    cursor: 1, hasMore: false, resetRequired: false,
  }) });
  await act(async () => { await sync.notify({ binding, seq: 1, changedRefs: [], resetRequired: false }); });
  await waitFor(() => expect(pageGet).toHaveBeenCalledTimes(2));
  await act(async () => { release(after); });
  await waitFor(() => expect(hook.result.current.view.unfinishedTodos.map(item => item.id)).toEqual([2]));
  expect(hook.result.current.view.finishedTodos[0]).toMatchObject({ id: 1, status: "finished", progresses: [{ id: 3, content: "会话新增的子任务" }] });
  expect(pageGet).toHaveBeenCalledTimes(2);
  sync.stop(); hook.unmount(); client.clear();
});
