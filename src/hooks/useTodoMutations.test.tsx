import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";

import { queryKeys } from "../lib/queryKeys";
import type { TodoRecord, WorkspacePageData } from "../lib/types";

const apiMocks = vi.hoisted(() => ({
  todoCreate: vi.fn(),
  todoUpdateContent: vi.fn(),
  todoUpdateTags: vi.fn(),
  todoUpdatePriority: vi.fn(),
  todoUpdateStatus: vi.fn(),
  todoAddProgress: vi.fn(),
  todoUpdateProgress: vi.fn(),
  todoDeleteProgress: vi.fn(),
  todoDelete: vi.fn(),
}));

vi.mock("../services/projectMindApi", () => ({
  projectMindApi: apiMocks,
}));

vi.mock("../state/feedback-store", () => ({
  useFeedbackStore: () => ({
    pushToast: vi.fn(),
    setStatus: vi.fn(),
  }),
}));

import { useTodoMutations } from "./useTodoMutations";

const workspaceTodo: TodoRecord = {
  id: 7,
  scope: "workspace",
  projectId: null,
  activityId: null,
  content: "整理跨项目复盘",
  status: "unfinished",
  priority: "not_urgent_important",
  dueDate: null,
  tags: [],
  createdAt: "2026-07-30T08:00:00.000Z",
  updatedAt: "2026-07-30T08:00:00.000Z",
  progresses: [],
};

describe("useTodoMutations", () => {
  it("shows a Workspace Todo immediately and removes it when creation fails", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const workspacePage: WorkspacePageData = {
      quickNote: null,
      records: [],
      unfinishedTodos: [],
      finishedTodos: [],
    };
    queryClient.setQueryData(queryKeys.workspacePage, workspacePage);

    let rejectCreate: ((reason?: unknown) => void) | undefined;
    apiMocks.todoCreate.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectCreate = reject;
      }),
    );

    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useTodoMutations([]), { wrapper });

    let mutationPromise: Promise<unknown>;
    act(() => {
      mutationPromise = result.current.todoMutation
        .mutateAsync({
          scope: "workspace",
          projectId: null,
          activityId: null,
          content: "立即出现的 Workspace Todo",
          priority: "not_urgent_important",
          tagIds: [],
        })
        .catch(() => undefined);
    });

    await waitFor(() => {
      const optimistic = queryClient.getQueryData<WorkspacePageData>(
        queryKeys.workspacePage,
      );
      expect(optimistic?.unfinishedTodos[0]).toMatchObject({
        scope: "workspace",
        projectId: null,
        content: "立即出现的 Workspace Todo",
      });
    });

    rejectCreate?.(new Error("database unavailable"));
    await act(async () => {
      await mutationPromise;
    });

    const restored = queryClient.getQueryData<WorkspacePageData>(
      queryKeys.workspacePage,
    );
    expect(restored?.unfinishedTodos).toEqual([]);
    expect(restored?.finishedTodos).toEqual([]);
  });

  it("rolls a Workspace Todo status back when the optimistic update fails", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const workspacePage: WorkspacePageData = {
      quickNote: null,
      records: [],
      unfinishedTodos: [workspaceTodo],
      finishedTodos: [],
    };
    queryClient.setQueryData(queryKeys.workspacePage, workspacePage);

    let rejectUpdate: ((reason?: unknown) => void) | undefined;
    apiMocks.todoUpdateStatus.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectUpdate = reject;
      }),
    );

    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useTodoMutations([workspaceTodo]), {
      wrapper,
    });

    let mutationPromise: Promise<unknown>;
    act(() => {
      mutationPromise = result.current.todoStatusMutation
        .mutateAsync({ todoId: workspaceTodo.id, status: "finished" })
        .catch(() => undefined);
    });

    await waitFor(() => {
      const optimistic = queryClient.getQueryData<WorkspacePageData>(
        queryKeys.workspacePage,
      );
      expect(optimistic?.unfinishedTodos).toEqual([]);
      expect(optimistic?.finishedTodos.map((todo) => todo.id)).toEqual([7]);
    });

    rejectUpdate?.(new Error("database unavailable"));
    await act(async () => {
      await mutationPromise;
    });

    const restored = queryClient.getQueryData<WorkspacePageData>(
      queryKeys.workspacePage,
    );
    expect(restored?.unfinishedTodos.map((todo) => todo.id)).toEqual([7]);
    expect(restored?.finishedTodos).toEqual([]);
  });

  it("rolls a Workspace Todo priority back when the optimistic update fails", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const workspacePage: WorkspacePageData = {
      quickNote: null,
      records: [],
      unfinishedTodos: [workspaceTodo],
      finishedTodos: [],
    };
    queryClient.setQueryData(queryKeys.workspacePage, workspacePage);

    let rejectUpdate: ((reason?: unknown) => void) | undefined;
    apiMocks.todoUpdatePriority.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectUpdate = reject;
      }),
    );

    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useTodoMutations([workspaceTodo]), {
      wrapper,
    });

    let mutationPromise: Promise<unknown>;
    act(() => {
      mutationPromise = result.current.todoPriorityMutation
        .mutateAsync({ todoId: workspaceTodo.id, priority: "urgent_important" })
        .catch(() => undefined);
    });

    await waitFor(() => {
      const optimistic = queryClient.getQueryData<WorkspacePageData>(
        queryKeys.workspacePage,
      );
      expect(optimistic?.unfinishedTodos[0].priority).toBe("urgent_important");
    });

    rejectUpdate?.(new Error("database unavailable"));
    await act(async () => {
      await mutationPromise;
    });

    const restored = queryClient.getQueryData<WorkspacePageData>(
      queryKeys.workspacePage,
    );
    expect(restored?.unfinishedTodos[0].priority).toBe(
      "not_urgent_important",
    );
  });

  it("rolls explicit Workspace Tags back when the update fails", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    queryClient.setQueryData<WorkspacePageData>(queryKeys.workspacePage, {
      quickNote: null,
      records: [],
      unfinishedTodos: [workspaceTodo],
      finishedTodos: [],
    });
    const workspaceTag = {
      id: 22,
      label: "复盘",
      colorKey: "teal" as const,
    };

    let rejectUpdate: ((reason?: unknown) => void) | undefined;
    apiMocks.todoUpdateTags.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectUpdate = reject;
      }),
    );

    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useTodoMutations([workspaceTodo]), {
      wrapper,
    });

    let mutationPromise: Promise<unknown>;
    act(() => {
      mutationPromise = result.current.todoTagMutation
        .mutateAsync({
          todoId: workspaceTodo.id,
          tagIds: [workspaceTag.id],
          optimisticTags: [workspaceTag],
        })
        .catch(() => undefined);
    });

    await waitFor(() => {
      const optimistic = queryClient.getQueryData<WorkspacePageData>(
        queryKeys.workspacePage,
      );
      expect(optimistic?.unfinishedTodos[0].tags).toEqual([workspaceTag]);
    });

    rejectUpdate?.(new Error("database unavailable"));
    await act(async () => {
      await mutationPromise;
    });

    const restored = queryClient.getQueryData<WorkspacePageData>(
      queryKeys.workspacePage,
    );
    expect(restored?.unfinishedTodos[0].tags).toEqual([]);
  });

  it("rolls a new Workspace Todo Subtask back when creation fails", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    queryClient.setQueryData<WorkspacePageData>(queryKeys.workspacePage, {
      quickNote: null,
      records: [],
      unfinishedTodos: [workspaceTodo],
      finishedTodos: [],
    });

    let rejectCreate: ((reason?: unknown) => void) | undefined;
    apiMocks.todoAddProgress.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectCreate = reject;
      }),
    );

    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useTodoMutations([workspaceTodo]), {
      wrapper,
    });

    let mutationPromise: Promise<unknown>;
    act(() => {
      mutationPromise = result.current.todoProgressMutation
        .mutateAsync({
          todoId: workspaceTodo.id,
          content: "整理访谈材料",
          progressDate: "2026-07-30",
          dueDate: "2026-08-02",
        })
        .catch(() => undefined);
    });

    await waitFor(() => {
      const optimistic = queryClient.getQueryData<WorkspacePageData>(
        queryKeys.workspacePage,
      );
      expect(optimistic?.unfinishedTodos[0].progresses[0]).toMatchObject({
        todoId: 7,
        content: "整理访谈材料",
        dueDate: "2026-08-02",
        status: "unfinished",
      });
    });

    rejectCreate?.(new Error("database unavailable"));
    await act(async () => {
      await mutationPromise;
    });

    const restored = queryClient.getQueryData<WorkspacePageData>(
      queryKeys.workspacePage,
    );
    expect(restored?.unfinishedTodos[0].progresses).toEqual([]);
  });
});
