import type { QueryClient } from "@tanstack/react-query";

import { queryKeys } from "../lib/queryKeys";
import type {
  ProjectListItem,
  ProjectPageData,
  TodoCreateInput,
  TodoRecord,
  WorkspacePageData,
} from "../lib/types";

type TodoListData = ProjectPageData | WorkspacePageData;

export interface TodoQuerySnapshot {
  projectPage?: ProjectPageData;
  workspacePage?: WorkspacePageData;
  workspaceTodos?: TodoRecord[];
  projects?: ProjectListItem[];
}

function withoutTodo(todos: TodoRecord[] | undefined, todoId: number) {
  return (todos ?? []).filter((todo) => todo.id !== todoId);
}

function mergeTodoByStatus<T extends TodoListData>(current: T | undefined, todo: TodoRecord) {
  if (!current) return current;

  const unfinishedTodos = current.unfinishedTodos ?? [];
  const finishedTodos = current.finishedTodos ?? [];
  const previousTodo =
    unfinishedTodos.find((item) => item.id === todo.id) ??
    finishedTodos.find((item) => item.id === todo.id);
  const baseUnfinishedTodos = withoutTodo(current.unfinishedTodos, todo.id);
  const baseFinishedTodos = withoutTodo(current.finishedTodos, todo.id);
  const nextTodo = previousTodo ? { ...previousTodo, ...todo } : todo;

  if (previousTodo?.status === nextTodo.status) {
    return {
      ...current,
      unfinishedTodos:
        nextTodo.status === "unfinished"
          ? unfinishedTodos.map((item) => (item.id === nextTodo.id ? nextTodo : item))
          : baseUnfinishedTodos,
      finishedTodos:
        nextTodo.status === "finished"
          ? finishedTodos.map((item) => (item.id === nextTodo.id ? nextTodo : item))
          : baseFinishedTodos,
    };
  }

  return {
    ...current,
    unfinishedTodos:
      nextTodo.status === "finished" ? baseUnfinishedTodos : [nextTodo, ...baseUnfinishedTodos],
    finishedTodos:
      nextTodo.status === "finished" ? [nextTodo, ...baseFinishedTodos] : baseFinishedTodos,
  };
}

function removeTodoFromListData<T extends TodoListData>(current: T | undefined, todoId: number) {
  return current
    ? {
        ...current,
        unfinishedTodos: withoutTodo(current.unfinishedTodos, todoId),
        finishedTodos: withoutTodo(current.finishedTodos, todoId),
      }
    : current;
}

function mergeWorkspaceTodos(current: TodoRecord[] | undefined, todo: TodoRecord) {
  if (!current) return current;
  const existing = current.find((item) => item.id === todo.id);
  const nextTodo = existing ? { ...existing, ...todo } : todo;
  return [nextTodo, ...current.filter((item) => item.id !== todo.id)];
}

export function optimisticTodoFromInput(input: TodoCreateInput): TodoRecord {
  const now = new Date().toISOString();
  return {
    id: -Date.now(),
    scope: input.scope ?? "project",
    projectId: input.projectId ?? null,
    activityId: input.activityId ?? null,
    content: input.content,
    status: "unfinished",
    priority: input.priority,
    dueDate: input.dueDate ?? null,
    tags: [],
    createdAt: now,
    updatedAt: now,
    progresses: [],
  };
}

export function createTodoQueryCache(queryClient: QueryClient) {
  return {
    cancel: (projectId?: number | null) =>
      Promise.all([
        ...(projectId == null
          ? []
          : [queryClient.cancelQueries({ queryKey: queryKeys.projectPage(projectId) })]),
        queryClient.cancelQueries({ queryKey: queryKeys.workspacePage }),
        queryClient.cancelQueries({ queryKey: queryKeys.workspaceTodos }),
        queryClient.cancelQueries({ queryKey: queryKeys.projects.all }),
      ]),
    snapshot: (projectId?: number | null): TodoQuerySnapshot => ({
      projectPage:
        projectId == null
          ? undefined
          : queryClient.getQueryData<ProjectPageData>(queryKeys.projectPage(projectId)),
      workspacePage: queryClient.getQueryData<WorkspacePageData>(queryKeys.workspacePage),
      workspaceTodos: queryClient.getQueryData<TodoRecord[]>(queryKeys.workspaceTodos),
      projects: queryClient.getQueryData<ProjectListItem[]>(queryKeys.projects.all),
    }),
    restore: (projectId?: number | null, snapshot?: TodoQuerySnapshot) => {
      if (!snapshot) return;
      if (projectId != null) {
        queryClient.setQueryData(queryKeys.projectPage(projectId), snapshot.projectPage);
      }
      queryClient.setQueryData(queryKeys.workspacePage, snapshot.workspacePage);
      queryClient.setQueryData(queryKeys.workspaceTodos, snapshot.workspaceTodos);
      queryClient.setQueryData(queryKeys.projects.all, snapshot.projects);
    },
    upsert: (todo: TodoRecord) => {
      if (todo.projectId != null) {
        queryClient.setQueryData<ProjectPageData | undefined>(
          queryKeys.projectPage(todo.projectId),
          (current) => mergeTodoByStatus(current, todo),
        );
      }
      queryClient.setQueryData<WorkspacePageData | undefined>(queryKeys.workspacePage, (current) =>
        mergeTodoByStatus(current, todo),
      );
      queryClient.setQueryData<TodoRecord[] | undefined>(queryKeys.workspaceTodos, (current) =>
        mergeWorkspaceTodos(current, todo),
      );
    },
    remove: (todo: TodoRecord) => {
      if (todo.projectId != null) {
        queryClient.setQueryData<ProjectPageData | undefined>(
          queryKeys.projectPage(todo.projectId),
          (current) => removeTodoFromListData(current, todo.id),
        );
      }
      queryClient.setQueryData<WorkspacePageData | undefined>(queryKeys.workspacePage, (current) =>
        removeTodoFromListData(current, todo.id),
      );
      queryClient.setQueryData<TodoRecord[] | undefined>(queryKeys.workspaceTodos, (current) =>
        current?.filter((item) => item.id !== todo.id),
      );
    },
    updateProjectOpenCount: (projectId: number | null | undefined, delta: number) => {
      if (projectId == null || delta === 0) return;
      queryClient.setQueryData<ProjectListItem[] | undefined>(queryKeys.projects.all, (projects) =>
        projects?.map((project) =>
          project.id === projectId
            ? { ...project, openTodoCount: Math.max(0, project.openTodoCount + delta) }
            : project,
        ),
      );
    },
  };
}
