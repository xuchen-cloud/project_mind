import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { projectMindApi } from "../services/projectMindApi";
import { queryKeys } from "../lib/queryKeys";
import { useTodoModule } from "./use-todo-module";
import type { ProjectListItem, TodoRecord } from "../lib/types";

const todo: TodoRecord = {
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
