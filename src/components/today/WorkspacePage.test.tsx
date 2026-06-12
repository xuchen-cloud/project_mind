import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUiStoreState, useUiStore } from "../../state/ui-store";

const apiMocks = vi.hoisted(() => ({
  projectsList: vi.fn(),
  workspacePageGet: vi.fn(),
  workspaceStatusGet: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: apiMocks,
}));

vi.mock("../../hooks/useTodoMutations", () => ({
  useTodoMutations: () => ({
    todoMutation: { mutate: vi.fn(), mutateAsync: vi.fn(async () => undefined) },
    todoContentMutation: { mutateAsync: vi.fn() },
    todoActivityMutation: { mutateAsync: vi.fn() },
    todoDeleteMutation: { mutateAsync: vi.fn() },
    todoPriorityMutation: { mutateAsync: vi.fn() },
    todoTagMutation: { mutateAsync: vi.fn() },
    todoProgressMutation: { mutateAsync: vi.fn() },
    todoProgressUpdateMutation: { mutateAsync: vi.fn() },
    todoProgressDeleteMutation: { mutateAsync: vi.fn() },
    todoStatusMutation: { mutateAsync: vi.fn() },
  }),
}));

vi.mock("../../hooks/useWorkspaceQuickNoteMutations", () => ({
  useWorkspaceQuickNoteMutations: () => ({
    workspaceQuickNoteMutation: { mutateAsync: vi.fn(), isPending: false },
  }),
}));

vi.mock("../../hooks/useWorkspaceRecordMutations", () => ({
  useWorkspaceRecordMutations: () => ({
    workspaceRecordMutation: { mutateAsync: vi.fn(), isPending: false },
    workspaceRecordDeleteMutation: { mutateAsync: vi.fn(), isPending: false },
  }),
}));

vi.mock("../../state/feedback-store", () => ({
  useFeedbackStore: () => ({
    pushToast: vi.fn(),
  }),
}));

const desktopApiMocks = vi.hoisted(() => ({
  openProjectWindow: vi.fn(async () => undefined),
  focusProjectWindow: vi.fn(async () => false),
  openFolder: vi.fn(async () => undefined),
}));

vi.mock("../../services/desktopApi", () => ({
  desktopApi: {
    openProjectWindow: desktopApiMocks.openProjectWindow,
    focusProjectWindow: desktopApiMocks.focusProjectWindow,
    openFolder: desktopApiMocks.openFolder,
  },
}));

import { WorkspacePage } from "./WorkspacePage";

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <WorkspacePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("WorkspacePage", () => {
  beforeEach(() => {
    apiMocks.projectsList.mockReset();
    apiMocks.workspacePageGet.mockReset();
    apiMocks.workspaceStatusGet.mockReset();
    desktopApiMocks.openProjectWindow.mockClear();
    desktopApiMocks.focusProjectWindow.mockClear();
    desktopApiMocks.openFolder.mockClear();
    useUiStore.setState(createUiStoreState());
  });

  it("shows the overview page content", async () => {
    apiMocks.projectsList.mockResolvedValueOnce([
      {
        id: 1,
        name: "Alpha",
        kind: "normal",
        status: "active",
        rootPath: "/tmp/alpha",
        quickNote: "",
        isArchived: false,
        createdAt: "",
        updatedAt: "",
        activityCount: 1,
        unorganizedCount: 0,
        openTodoCount: 1,
      },
    ]);
    apiMocks.workspacePageGet.mockResolvedValueOnce({
      quickNote: null,
      records: [],
      unfinishedTodos: [],
      finishedTodos: [],
    });
    apiMocks.workspaceStatusGet.mockResolvedValueOnce({
      currentWorkspace: {
        rootPath: "/tmp/workspace",
        displayName: "workspace",
      },
      recentWorkspaces: [],
      aiSecretsUnlocked: true,
    });

    renderPage();

    expect(await screen.findByLabelText("工作区导航侧边栏")).toBeInTheDocument();
    expect(screen.getByText("To Do List")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-overview-view-switch")).toBeInTheDocument();
  });

  it("keeps Workspace usable without AI modules", async () => {
    apiMocks.projectsList.mockResolvedValueOnce([]);
    apiMocks.workspacePageGet.mockResolvedValueOnce({
      quickNote: null,
      records: [],
      unfinishedTodos: [],
      finishedTodos: [],
    });
    apiMocks.workspaceStatusGet.mockResolvedValueOnce({
      currentWorkspace: {
        rootPath: "/tmp/workspace",
        displayName: "workspace",
      },
      recentWorkspaces: [],
      aiSecretsUnlocked: true,
    });

    renderPage();

    expect(await screen.findByLabelText("工作区导航侧边栏")).toBeInTheDocument();
    expect(screen.getByText("To Do List")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("AI")).not.toBeInTheDocument();
    });
  });

  it("opens a project in a new window from the sidebar context menu", async () => {
    apiMocks.projectsList.mockResolvedValueOnce([
      {
        id: 1,
        name: "Alpha",
        kind: "normal",
        status: "active",
        rootPath: "/tmp/alpha",
        quickNote: "",
        isArchived: false,
        createdAt: "",
        updatedAt: "",
        activityCount: 1,
        unorganizedCount: 0,
        openTodoCount: 1,
      },
    ]);
    apiMocks.workspacePageGet.mockResolvedValueOnce({
      quickNote: null,
      records: [],
      unfinishedTodos: [],
      finishedTodos: [],
    });
    apiMocks.workspaceStatusGet.mockResolvedValueOnce({
      currentWorkspace: {
        rootPath: "/tmp/workspace",
        displayName: "workspace",
      },
      recentWorkspaces: [],
      aiSecretsUnlocked: true,
    });
    useUiStore.setState({
      ...createUiStoreState(),
      projectRecentPaths: {
        1: "/projects/1?focus=record-9",
      },
    });

    renderPage();

    const projectButton = await screen.findByRole("button", { name: /alpha/i });
    fireEvent.contextMenu(projectButton, {
      clientX: 100,
      clientY: 120,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "在新窗口中打开" }));

    expect(desktopApiMocks.openProjectWindow).toHaveBeenCalledWith({
      projectId: 1,
      projectName: "Alpha",
      route: "/projects/1?focus=record-9",
    });
  });

  it("closes the matching main-window tab after opening the project in a new window", async () => {
    apiMocks.projectsList.mockResolvedValueOnce([
      {
        id: 1,
        name: "Alpha",
        kind: "normal",
        status: "active",
        rootPath: "/tmp/alpha",
        quickNote: "",
        isArchived: false,
        createdAt: "",
        updatedAt: "",
        activityCount: 1,
        unorganizedCount: 0,
        openTodoCount: 1,
      },
    ]);
    apiMocks.workspacePageGet.mockResolvedValueOnce({
      quickNote: null,
      records: [],
      unfinishedTodos: [],
      finishedTodos: [],
    });
    apiMocks.workspaceStatusGet.mockResolvedValueOnce({
      currentWorkspace: {
        rootPath: "/tmp/workspace",
        displayName: "workspace",
      },
      recentWorkspaces: [],
      aiSecretsUnlocked: true,
    });
    useUiStore.setState({
      ...createUiStoreState(),
      openProjectIds: [1],
      projectRecentPaths: {
        1: "/projects/1",
      },
    });

    renderPage();

    const projectButton = await screen.findByRole("button", { name: /alpha/i });
    fireEvent.contextMenu(projectButton, {
      clientX: 100,
      clientY: 120,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "在新窗口中打开" }));

    await waitFor(() => {
      expect(useUiStore.getState().openProjectIds).toEqual([]);
    });
  });

  it("focuses an existing detached project window from the sidebar instead of opening in place", async () => {
    apiMocks.projectsList.mockResolvedValueOnce([
      {
        id: 1,
        name: "Alpha",
        kind: "normal",
        status: "active",
        rootPath: "/tmp/alpha",
        quickNote: "",
        isArchived: false,
        createdAt: "",
        updatedAt: "",
        activityCount: 1,
        unorganizedCount: 0,
        openTodoCount: 1,
      },
    ]);
    apiMocks.workspacePageGet.mockResolvedValueOnce({
      quickNote: null,
      records: [],
      unfinishedTodos: [],
      finishedTodos: [],
    });
    apiMocks.workspaceStatusGet.mockResolvedValueOnce({
      currentWorkspace: {
        rootPath: "/tmp/workspace",
        displayName: "workspace",
      },
      recentWorkspaces: [],
      aiSecretsUnlocked: true,
    });
    desktopApiMocks.focusProjectWindow.mockResolvedValueOnce(true);

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /alpha/i }));

    expect(desktopApiMocks.focusProjectWindow).toHaveBeenCalledWith(1);
  });
});
