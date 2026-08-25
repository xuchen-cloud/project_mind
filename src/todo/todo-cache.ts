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

export interface TodoQuerySnapshot {
  projectPage?: ProjectPageData;
  workspacePage?: WorkspacePageData;
  workspaceOwnedTodos?: TodoRecord[];
  projectOwnedTodos?: TodoRecord[];
  workspaceRailTodos?: TodoRecord[];
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

function upsertTodoInCollection(current: TodoRecord[] | undefined, todo: TodoRecord) {
  if (!current) return current;
  const existing = current.find((item) => item.id === todo.id);
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
  const workspaceRailTodos = [
    ...workspacePage.unfinishedTodos,
    ...workspacePage.finishedTodos,
  ];
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
  queryClient.setQueryData(queryKeys.todoCollections.projectOwned(projectPage.project.id), [
    ...projectPage.unfinishedTodos,
    ...projectPage.finishedTodos,
  ]);
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
    snapshot: (projectId?: number | null): TodoQuerySnapshot => ({
      projectPage:
        projectId == null
          ? undefined
          : queryClient.getQueryData<ProjectPageData>(queryKeys.projectPage(projectId)),
      workspacePage: queryClient.getQueryData<WorkspacePageData>(queryKeys.workspacePage),
      workspaceOwnedTodos: queryClient.getQueryData<TodoRecord[]>(
        queryKeys.todoCollections.workspaceOwned,
      ),
      projectOwnedTodos:
        projectId == null
          ? undefined
          : queryClient.getQueryData<TodoRecord[]>(
              queryKeys.todoCollections.projectOwned(projectId),
            ),
      workspaceRailTodos: queryClient.getQueryData<TodoRecord[]>(
        queryKeys.todoCollections.workspaceRail,
      ),
      projects: queryClient.getQueryData<ProjectListItem[]>(queryKeys.projects.all),
    }),
    restore: (projectId?: number | null, snapshot?: TodoQuerySnapshot) => {
      if (!snapshot) return;
      if (projectId != null) {
        queryClient.setQueryData(queryKeys.projectPage(projectId), snapshot.projectPage);
        queryClient.setQueryData(
          queryKeys.todoCollections.projectOwned(projectId),
          snapshot.projectOwnedTodos,
        );
      }
      queryClient.setQueryData(queryKeys.workspacePage, snapshot.workspacePage);
      queryClient.setQueryData(
        queryKeys.todoCollections.workspaceOwned,
        snapshot.workspaceOwnedTodos,
      );
      queryClient.setQueryData(
        queryKeys.todoCollections.workspaceRail,
        snapshot.workspaceRailTodos,
      );
      queryClient.setQueryData(queryKeys.projects.all, snapshot.projects);
    },
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
  };
}
