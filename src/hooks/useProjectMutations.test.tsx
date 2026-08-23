import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { queryKeys } from "../lib/queryKeys";
import type {
  ProjectListItem,
  ProjectPageData,
  TodoRecord,
  WorkspacePageData,
} from "../lib/types";

const apiMocks = vi.hoisted(() => ({
  projectUpdate: vi.fn(),
  projectSetArchive: vi.fn(),
}));

vi.mock("../services/projectMindApi", () => ({
  projectMindApi: {
    projectUpdate: apiMocks.projectUpdate,
    projectSetArchive: apiMocks.projectSetArchive,
  },
}));

vi.mock("../state/feedback-store", () => ({
  useFeedbackStore: () => ({
    pushToast: vi.fn(),
    setStatus: vi.fn(),
  }),
}));

vi.mock("../state/ui-store", () => ({
  useUiStore: () => ({
    setCreateProjectOpen: vi.fn(),
  }),
}));

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

beforeEach(() => {
  apiMocks.projectUpdate.mockReset();
  apiMocks.projectSetArchive.mockReset();
});

describe("useProjectMutations", () => {
  it("keeps Project Status consistent in shared Project caches", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const projectPage: ProjectPageData = {
      project,
      projectDocuments: [],
      conclusionGroups: [],
      records: [],
      unfinishedTodos: [projectTodo],
      finishedTodos: [],
    };
    queryClient.setQueryData(queryKeys.projects.all, [project]);
    queryClient.setQueryData(queryKeys.projectPage(project.id), projectPage);
    apiMocks.projectUpdate.mockResolvedValueOnce({ ...project, status: "推进中" });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useProjectMutations([project], vi.fn()), { wrapper });

    await act(() =>
      result.current.projectUpdateMutation.mutateAsync({
        projectId: project.id,
        quickNote: project.quickNote,
        status: "推进中",
      }),
    );

    expect(queryClient.getQueryData<ProjectListItem[]>(queryKeys.projects.all)?.[0]).toMatchObject({
      status: "推进中",
      openTodoCount: 1,
      isArchived: false,
    });
    expect(
      queryClient.getQueryData<ProjectPageData>(queryKeys.projectPage(project.id))?.project,
    ).toMatchObject({ status: "推进中", isArchived: false });
  });

  it("keeps shared page caches consistent through Archive and Restore", async () => {
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
    queryClient.setQueryData(queryKeys.todoCollections.workspaceRail, [projectTodo, workspaceTodo]);
    apiMocks.projectSetArchive.mockImplementation(async (input) => ({
      ...project,
      isArchived: input.isArchived,
    }));
    const navigate = vi.fn();
    const wrapper = ({ children }: PropsWithChildren) => (
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
    expect(queryClient.getQueryState(queryKeys.workspacePage)?.isInvalidated).toBe(true);

    await act(() =>
      result.current.archiveMutation.mutateAsync({ projectId: project.id, isArchived: false }),
    );

    expect(
      queryClient.getQueryData<WorkspacePageData>(queryKeys.workspacePage)?.unfinishedTodos,
    ).toEqual([projectTodo, workspaceTodo]);
    expect(queryClient.getQueryData<TodoRecord[]>(queryKeys.todoCollections.workspaceRail)).toEqual([
      projectTodo,
      workspaceTodo,
    ]);
    expect(navigate).toHaveBeenLastCalledWith(`/projects/${project.id}`);
  });

  it("invalidates the Workspace Page when a Project is archived without cached Project data", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.workspacePage, {
      quickNote: null,
      records: [],
      unfinishedTodos: [{ id: 7, projectId: 1 }],
      finishedTodos: [],
    });
    apiMocks.projectSetArchive.mockResolvedValueOnce({
      id: 1,
      name: "Alpha",
      isArchived: true,
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useProjectMutations([], vi.fn()), { wrapper });

    await act(async () => {
      await result.current.archiveMutation.mutateAsync({
        projectId: 1,
        isArchived: true,
      });
    });

    expect(queryClient.getQueryState(queryKeys.workspacePage)?.isInvalidated).toBe(true);
  });
});
