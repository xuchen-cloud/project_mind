import type { QueryClient } from "@tanstack/react-query";

import { queryKeys } from "../lib/queryKeys";
import { projectMindApi } from "../services/projectMindApi";
import type {
  ProjectListItem,
  ProjectPageData,
  TodoCreateInput,
  TodoRecord,
  WorkspacePageData,
} from "../lib/types";

type TodoListData = ProjectPageData | WorkspacePageData;

function cachedTodoHeads(queryClient: QueryClient) {
  const heads = new Map<number, TodoRecord>();
  for (const [, collection] of queryClient.getQueriesData<TodoRecord[]>({ queryKey: queryKeys.todoCollections.all })) {
    for (const todo of collection ?? []) {
      if ((heads.get(todo.id)?.revision ?? -1) <= todo.revision) heads.set(todo.id, todo);
    }
  }
  return heads;
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
  if (previousTodo && previousTodo.revision > todo.revision) return current;
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

function upsertTodoInCollection(current: TodoRecord[] | undefined, todo: TodoRecord) {
  if (!current) return current;
  const existing = current.find((item) => item.id === todo.id);
  if (existing && existing.revision > todo.revision) return current;
  const nextTodo = existing ? { ...existing, ...todo } : todo;
  return [nextTodo, ...current.filter((item) => item.id !== todo.id)];
}

function projectIsArchived(queryClient: QueryClient, projectId: number) {
  const projectPage = queryClient.getQueryData<ProjectPageData>(queryKeys.projectPage(projectId));
  if (projectPage?.project) return projectPage.project.isArchived;

  return queryClient
    .getQueryData<ProjectListItem[]>(queryKeys.projects.all)
    ?.find((project) => project.id === projectId)?.isArchived;
}

function todoIsVisibleInWorkspace(queryClient: QueryClient, todo: TodoRecord) {
  return (
    todo.scope === "workspace" ||
    (todo.projectId != null && projectIsArchived(queryClient, todo.projectId) !== true)
  );
}

export function cacheWorkspaceTodoCollections(
  queryClient: QueryClient,
  workspacePage: WorkspacePageData,
) {
  const existing = cachedTodoHeads(queryClient);
  const workspaceRailTodos = [
    ...workspacePage.unfinishedTodos,
    ...workspacePage.finishedTodos,
  ].map(todo => (existing.get(todo.id)?.revision ?? -1) > todo.revision ? existing.get(todo.id)! : todo);
  queryClient.setQueryData<WorkspacePageData>(queryKeys.workspacePage, {
    ...workspacePage,
    unfinishedTodos: workspaceRailTodos.filter(todo => todo.status === "unfinished"),
    finishedTodos: workspaceRailTodos.filter(todo => todo.status === "finished"),
  });
  queryClient.setQueryData(
    queryKeys.todoCollections.workspaceOwned,
    workspaceRailTodos.filter((todo) => todo.scope === "workspace"),
  );
  queryClient.setQueryData(queryKeys.todoCollections.workspaceRail, workspaceRailTodos);

  const projectTodos = new Map<number, TodoRecord[]>();
  for (const todo of workspaceRailTodos) {
    if (todo.scope !== "project" || todo.projectId == null) continue;
    projectTodos.set(todo.projectId, [...(projectTodos.get(todo.projectId) ?? []), todo]);
  }
  for (const [projectId, todos] of projectTodos) {
    queryClient.setQueryData(queryKeys.todoCollections.projectOwned(projectId), todos);
  }
}

export function cacheProjectTodoCollection(
  queryClient: QueryClient,
  projectPage: ProjectPageData,
) {
  const existing = cachedTodoHeads(queryClient);
  const todos = [
    ...projectPage.unfinishedTodos,
    ...projectPage.finishedTodos,
  ].map(todo => (existing.get(todo.id)?.revision ?? -1) > todo.revision ? existing.get(todo.id)! : todo);
  queryClient.setQueryData(queryKeys.todoCollections.projectOwned(projectPage.project.id), todos);
  queryClient.setQueryData<ProjectPageData>(queryKeys.projectPage(projectPage.project.id), {
    ...projectPage,
    unfinishedTodos: todos.filter(todo => todo.status === "unfinished"),
    finishedTodos: todos.filter(todo => todo.status === "finished"),
  });
}

export async function fetchWorkspacePageWithTodoCollections(queryClient: QueryClient) {
  const workspacePage = await projectMindApi.workspacePageGet();
  cacheWorkspaceTodoCollections(queryClient, workspacePage);
  return workspacePage;
}

export async function fetchProjectPageWithTodoCollection(
  queryClient: QueryClient,
  projectId: number,
) {
  const projectPage = await projectMindApi.projectPageGet({ projectId });
  cacheProjectTodoCollection(queryClient, projectPage);
  return projectPage;
}

export function optimisticTodoFromInput(input: TodoCreateInput): TodoRecord {
  const now = new Date().toISOString();
  return {
    id: -Date.now(),
    revision: 0,
    scope: input.scope,
    projectId: input.projectId ?? null,
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
          : [
              queryClient.cancelQueries({ queryKey: queryKeys.projectPage(projectId) }),
              queryClient.cancelQueries({
                queryKey: queryKeys.todoCollections.projectOwned(projectId),
              }),
            ]),
        queryClient.cancelQueries({ queryKey: queryKeys.workspacePage }),
        queryClient.cancelQueries({ queryKey: queryKeys.todoCollections.workspaceOwned }),
        queryClient.cancelQueries({ queryKey: queryKeys.todoCollections.workspaceRail }),
        queryClient.cancelQueries({ queryKey: queryKeys.projects.all }),
      ]),
    upsert: (todo: TodoRecord) => {
      if (todo.scope === "workspace") {
        queryClient.setQueryData<TodoRecord[] | undefined>(
          queryKeys.todoCollections.workspaceOwned,
          (current) => upsertTodoInCollection(current, todo),
        );
      }
      if (todo.projectId != null) {
        queryClient.setQueryData<TodoRecord[] | undefined>(
          queryKeys.todoCollections.projectOwned(todo.projectId),
          (current) => upsertTodoInCollection(current, todo),
        );
        queryClient.setQueryData<ProjectPageData | undefined>(
          queryKeys.projectPage(todo.projectId),
          (current) => mergeTodoByStatus(current, todo),
        );
      }
      const visibleInWorkspace = todoIsVisibleInWorkspace(queryClient, todo);
      queryClient.setQueryData<WorkspacePageData | undefined>(queryKeys.workspacePage, (current) =>
        visibleInWorkspace
          ? mergeTodoByStatus(current, todo)
          : removeTodoFromListData(current, todo.id),
      );
      queryClient.setQueryData<TodoRecord[] | undefined>(queryKeys.todoCollections.workspaceRail, (current) =>
        visibleInWorkspace
          ? upsertTodoInCollection(current, todo)
          : current?.filter((item) => item.id !== todo.id),
      );
    },
    remove: (todo: TodoRecord) => {
      if ((cachedTodoHeads(queryClient).get(todo.id)?.revision ?? -1) > todo.revision) return;
      if (todo.scope === "workspace") {
        queryClient.setQueryData<TodoRecord[] | undefined>(
          queryKeys.todoCollections.workspaceOwned,
          (current) => current?.filter((item) => item.id !== todo.id),
        );
      }
      if (todo.projectId != null) {
        queryClient.setQueryData<TodoRecord[] | undefined>(
          queryKeys.todoCollections.projectOwned(todo.projectId),
          (current) => current?.filter((item) => item.id !== todo.id),
        );
        queryClient.setQueryData<ProjectPageData | undefined>(
          queryKeys.projectPage(todo.projectId),
          (current) => removeTodoFromListData(current, todo.id),
        );
      }
      queryClient.setQueryData<WorkspacePageData | undefined>(queryKeys.workspacePage, (current) =>
        removeTodoFromListData(current, todo.id),
      );
      queryClient.setQueryData<TodoRecord[] | undefined>(queryKeys.todoCollections.workspaceRail, (current) =>
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
    syncProjectOpenCount: (projectId: number | null | undefined) => {
      if (projectId == null) return;
      const todos = queryClient.getQueryData<TodoRecord[]>(queryKeys.todoCollections.projectOwned(projectId));
      if (!todos) return;
      const openTodoCount = todos.filter(todo => todo.status === "unfinished").length;
      queryClient.setQueryData<ProjectListItem[] | undefined>(queryKeys.projects.all, projects =>
        projects?.map(project => project.id === projectId ? { ...project, openTodoCount } : project));
    },
  };
}
