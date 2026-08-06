import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { queryKeys } from "../lib/queryKeys";
import type {
  ProjectListItem,
  ProjectPageData,
  ProjectRecord,
  TodoRecord,
  WorkspacePageData,
} from "../lib/types";
import { syncProjectArchiveCaches } from "./project-archive-query-cache";

const activeProject: ProjectListItem = {
  id: 7,
  name: "Launch",
  kind: "normal",
  status: "active",
  rootPath: "/tmp/launch",
  quickNote: "",
  isArchived: false,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
  unorganizedCount: 0,
  openTodoCount: 1,
};

function todo(id: number, scope: "workspace" | "project", status: "unfinished" | "finished") {
  return {
    id,
    scope,
    projectId: scope === "project" ? activeProject.id : null,
    activityId: null,
    content: `Todo ${id}`,
    status,
    priority: "not_urgent_important",
    dueDate: null,
    tags: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    progresses: [],
  } satisfies TodoRecord;
}

function seedClient() {
  const queryClient = new QueryClient();
  const workspaceTodo = todo(1, "workspace", "unfinished");
  const projectOpenTodo = todo(2, "project", "unfinished");
  const projectFinishedTodo = todo(3, "project", "finished");
  const projectPage: ProjectPageData = {
    project: activeProject,
    projectDocuments: [],
    conclusionGroups: [],
    records: [],
    unfinishedTodos: [projectOpenTodo],
    finishedTodos: [projectFinishedTodo],
  };
  const workspacePage: WorkspacePageData = {
    quickNote: null,
    records: [],
    unfinishedTodos: [workspaceTodo, projectOpenTodo],
    finishedTodos: [projectFinishedTodo],
  };

  queryClient.setQueryData(queryKeys.projects.all, [activeProject]);
  queryClient.setQueryData(queryKeys.projectPage(activeProject.id), projectPage);
  queryClient.setQueryData(queryKeys.workspacePage, workspacePage);
  queryClient.setQueryData(queryKeys.workspaceTodos, [
    workspaceTodo,
    projectOpenTodo,
    projectFinishedTodo,
  ]);
  return { queryClient, workspaceTodo, projectOpenTodo, projectFinishedTodo };
}

describe("syncProjectArchiveCaches", () => {
  it("hides only the archived Project Todos while preserving the Project page", () => {
    const { queryClient, workspaceTodo, projectOpenTodo, projectFinishedTodo } = seedClient();
    const archivedProject: ProjectRecord = { ...activeProject, isArchived: true };

    syncProjectArchiveCaches(queryClient, archivedProject);

    const workspacePage = queryClient.getQueryData<WorkspacePageData>(queryKeys.workspacePage);
    expect(workspacePage?.unfinishedTodos).toEqual([workspaceTodo]);
    expect(workspacePage?.finishedTodos).toEqual([]);
    expect(queryClient.getQueryData<TodoRecord[]>(queryKeys.workspaceTodos)).toEqual([
      workspaceTodo,
    ]);
    expect(
      queryClient.getQueryData<ProjectPageData>(queryKeys.projectPage(activeProject.id)),
    ).toMatchObject({
      project: { isArchived: true },
      unfinishedTodos: [projectOpenTodo],
      finishedTodos: [projectFinishedTodo],
    });
    expect(queryClient.getQueryData<ProjectListItem[]>(queryKeys.projects.all)?.[0]).toMatchObject({
      id: activeProject.id,
      isArchived: true,
      openTodoCount: 1,
    });
  });

  it("restores cached Project Todos with their original status without duplicating Workspace Todos", () => {
    const { queryClient, workspaceTodo, projectOpenTodo, projectFinishedTodo } = seedClient();
    syncProjectArchiveCaches(queryClient, { ...activeProject, isArchived: true });

    syncProjectArchiveCaches(queryClient, { ...activeProject, isArchived: false });

    const workspacePage = queryClient.getQueryData<WorkspacePageData>(queryKeys.workspacePage);
    expect(workspacePage?.unfinishedTodos).toEqual([projectOpenTodo, workspaceTodo]);
    expect(workspacePage?.finishedTodos).toEqual([projectFinishedTodo]);
    expect(queryClient.getQueryData<TodoRecord[]>(queryKeys.workspaceTodos)).toEqual([
      projectOpenTodo,
      workspaceTodo,
      projectFinishedTodo,
    ]);
  });
});
