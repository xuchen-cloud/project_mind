import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { queryKeys } from "../lib/queryKeys";
import type {
  ProjectListItem,
  ProjectPageData,
  ProjectRecord,
  TodoRecord,
  WorkspacePageData,
} from "../lib/types";
import { projectMindApi } from "../services/projectMindApi";
import { useProjectMutations } from "./useProjectMutations";

const project: ProjectListItem = {
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

const projectTodo: TodoRecord = {
  ...workspaceTodo,
  id: 2,
  scope: "project",
  projectId: project.id,
  content: "Project Todo",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useProjectMutations Archive cache integration", () => {
  it("keeps Project and Workspace page caches consistent through Archive and Restore", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const projectPage: ProjectPageData = {
      project,
      projectDocuments: [],
      conclusionGroups: [],
      records: [],
      unfinishedTodos: [projectTodo],
      finishedTodos: [],
    };
    const workspacePage: WorkspacePageData = {
      quickNote: null,
      records: [],
      unfinishedTodos: [projectTodo, workspaceTodo],
      finishedTodos: [],
    };
    queryClient.setQueryData(queryKeys.projects.all, [project]);
    queryClient.setQueryData(queryKeys.projectPage(project.id), projectPage);
    queryClient.setQueryData(queryKeys.workspacePage, workspacePage);
    queryClient.setQueryData(queryKeys.workspaceTodos, [projectTodo, workspaceTodo]);

    vi.spyOn(projectMindApi, "projectSetArchive").mockImplementation(async (input) =>
      ({ ...project, isArchived: input.isArchived }) satisfies ProjectRecord,
    );
    const navigate = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useProjectMutations([project], navigate), { wrapper });

    await act(() =>
      result.current.archiveMutation.mutateAsync({ projectId: project.id, isArchived: true }),
    );

    expect(queryClient.getQueryData<ProjectListItem[]>(queryKeys.projects.all)?.[0]).toMatchObject({
      isArchived: true,
      openTodoCount: 1,
    });
    expect(
      queryClient.getQueryData<ProjectPageData>(queryKeys.projectPage(project.id)),
    ).toMatchObject({
      project: { isArchived: true },
      unfinishedTodos: [projectTodo],
    });
    expect(
      queryClient.getQueryData<WorkspacePageData>(queryKeys.workspacePage)?.unfinishedTodos,
    ).toEqual([workspaceTodo]);

    await act(() =>
      result.current.archiveMutation.mutateAsync({ projectId: project.id, isArchived: false }),
    );

    expect(
      queryClient.getQueryData<WorkspacePageData>(queryKeys.workspacePage)?.unfinishedTodos,
    ).toEqual([projectTodo, workspaceTodo]);
    expect(queryClient.getQueryData<TodoRecord[]>(queryKeys.workspaceTodos)).toEqual([
      projectTodo,
      workspaceTodo,
    ]);
    expect(navigate).toHaveBeenLastCalledWith(`/projects/${project.id}`);
  });
});
