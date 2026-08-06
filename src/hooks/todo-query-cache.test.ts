import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { queryKeys } from "../lib/queryKeys";
import type { ProjectPageData, TodoRecord, WorkspacePageData } from "../lib/types";
import {
  cacheProjectTodoCollection,
  cacheWorkspaceTodoCollections,
  createTodoQueryCache,
} from "./todo-query-cache";

const archivedProjectPage: ProjectPageData = {
  project: {
    id: 9,
    name: "Archived",
    kind: "normal",
    status: "active",
    rootPath: "/tmp/archived",
    quickNote: "",
    isArchived: true,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  },
  projectDocuments: [],
  conclusionGroups: [],
  records: [],
  unfinishedTodos: [],
  finishedTodos: [],
};

const workspaceTodo: TodoRecord = {
  id: 1,
  scope: "workspace",
  projectId: null,
  activityId: null,
  content: "Workspace Todo",
  status: "unfinished",
  priority: "not_urgent_important",
  dueDate: null,
  tags: [],
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
  progresses: [],
};

describe("createTodoQueryCache", () => {
  it("initializes the three ownership collections from public page results", () => {
    const queryClient = new QueryClient();
    const projectTodo: TodoRecord = {
      ...workspaceTodo,
      id: 2,
      scope: "project",
      projectId: archivedProjectPage.project.id,
      content: "Project Todo",
    };
    const workspacePage: WorkspacePageData = {
      quickNote: null,
      records: [],
      unfinishedTodos: [workspaceTodo, projectTodo],
      finishedTodos: [],
    };
    const projectPage = {
      ...archivedProjectPage,
      unfinishedTodos: [projectTodo],
    };

    cacheWorkspaceTodoCollections(queryClient, workspacePage);
    cacheProjectTodoCollection(queryClient, projectPage);

    expect(
      queryClient.getQueryData<TodoRecord[]>(queryKeys.todoCollections.workspaceOwned),
    ).toEqual([workspaceTodo]);
    expect(
      queryClient.getQueryData<TodoRecord[]>(
        queryKeys.todoCollections.projectOwned(archivedProjectPage.project.id),
      ),
    ).toEqual([projectTodo]);
    expect(
      queryClient.getQueryData<TodoRecord[]>(queryKeys.todoCollections.workspaceRail),
    ).toEqual([workspaceTodo, projectTodo]);
  });

  it("keeps archived Project Todo mutations out of Workspace aggregates", () => {
    const queryClient = new QueryClient();
    const archivedTodo: TodoRecord = {
      ...workspaceTodo,
      id: 2,
      scope: "project",
      projectId: archivedProjectPage.project.id,
      content: "Archived Project Todo",
    };
    const workspacePage: WorkspacePageData = {
      quickNote: null,
      records: [],
      unfinishedTodos: [workspaceTodo, archivedTodo],
      finishedTodos: [],
    };
    queryClient.setQueryData(queryKeys.projectPage(archivedProjectPage.project.id), {
      ...archivedProjectPage,
      unfinishedTodos: [archivedTodo],
    });
    queryClient.setQueryData(queryKeys.workspacePage, workspacePage);
    queryClient.setQueryData(queryKeys.todoCollections.workspaceOwned, [workspaceTodo]);
    queryClient.setQueryData(
      queryKeys.todoCollections.projectOwned(archivedProjectPage.project.id),
      [archivedTodo],
    );
    queryClient.setQueryData(queryKeys.todoCollections.workspaceRail, [workspaceTodo, archivedTodo]);

    createTodoQueryCache(queryClient).upsert({
      ...archivedTodo,
      content: "Edited while archived",
    });

    expect(
      queryClient.getQueryData<ProjectPageData>(
        queryKeys.projectPage(archivedProjectPage.project.id),
      )?.unfinishedTodos[0].content,
    ).toBe("Edited while archived");
    expect(
      queryClient.getQueryData<WorkspacePageData>(queryKeys.workspacePage)?.unfinishedTodos,
    ).toEqual([workspaceTodo]);
    expect(queryClient.getQueryData<TodoRecord[]>(queryKeys.todoCollections.workspaceRail)).toEqual([
      workspaceTodo,
    ]);
    expect(
      queryClient.getQueryData<TodoRecord[]>(queryKeys.todoCollections.workspaceOwned),
    ).toEqual([workspaceTodo]);
    expect(
      queryClient.getQueryData<TodoRecord[]>(
        queryKeys.todoCollections.projectOwned(archivedProjectPage.project.id),
      )?.[0].content,
    ).toBe("Edited while archived");
  });
});
