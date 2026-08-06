import type { QueryClient } from "@tanstack/react-query";

import { queryKeys } from "../lib/queryKeys";
import type {
  ProjectListItem,
  ProjectPageData,
  ProjectRecord,
  TodoRecord,
  WorkspacePageData,
} from "../lib/types";

function withoutProjectTodos(todos: TodoRecord[] | undefined, projectId: number) {
  return (todos ?? []).filter(
    (todo) => todo.scope === "workspace" || todo.projectId !== projectId,
  );
}

function compareTodoRecency(left: TodoRecord, right: TodoRecord) {
  const createdAtOrder = right.createdAt.localeCompare(left.createdAt);
  return createdAtOrder !== 0 ? createdAtOrder : right.id - left.id;
}

function compareWorkspaceTodos(left: TodoRecord, right: TodoRecord) {
  if (left.status !== right.status) return left.status === "unfinished" ? -1 : 1;
  return compareTodoRecency(left, right);
}

function mergeTodos(
  current: TodoRecord[] | undefined,
  additions: TodoRecord[],
  compare: (left: TodoRecord, right: TodoRecord) => number = compareTodoRecency,
) {
  const additionIds = new Set(additions.map((todo) => todo.id));
  return [...additions, ...(current ?? []).filter((todo) => !additionIds.has(todo.id))].sort(compare);
}

export function syncProjectArchiveCaches(queryClient: QueryClient, project: ProjectRecord) {
  const projectPage = queryClient.getQueryData<ProjectPageData>(queryKeys.projectPage(project.id));
  const projectTodos = projectPage
    ? [...projectPage.unfinishedTodos, ...projectPage.finishedTodos]
    : [];

  queryClient.setQueryData<ProjectListItem[] | undefined>(queryKeys.projects.all, (current) =>
    current?.map((item) => (item.id === project.id ? { ...item, ...project } : item)),
  );
  queryClient.setQueryData<ProjectPageData | undefined>(
    queryKeys.projectPage(project.id),
    (current) => (current ? { ...current, project: { ...current.project, ...project } } : current),
  );
  queryClient.setQueryData<WorkspacePageData | undefined>(queryKeys.workspacePage, (current) => {
    if (!current) return current;

    if (project.isArchived) {
      return {
        ...current,
        unfinishedTodos: withoutProjectTodos(current.unfinishedTodos, project.id),
        finishedTodos: withoutProjectTodos(current.finishedTodos, project.id),
      };
    }

    return {
      ...current,
      unfinishedTodos: mergeTodos(
        current.unfinishedTodos,
        projectTodos.filter((todo) => todo.status === "unfinished"),
      ),
      finishedTodos: mergeTodos(
        current.finishedTodos,
        projectTodos.filter((todo) => todo.status === "finished"),
      ),
    };
  });
  queryClient.setQueryData<TodoRecord[] | undefined>(queryKeys.todoCollections.workspaceRail, (current) => {
    if (!current) return current;
    return project.isArchived
      ? withoutProjectTodos(current, project.id)
      : mergeTodos(current, projectTodos, compareWorkspaceTodos);
  });
}
