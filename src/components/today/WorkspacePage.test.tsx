import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUiStoreState, useUiStore } from "../../state/ui-store";

const apiMocks = vi.hoisted(() => ({
  projectsList: vi.fn(),
  workspacePageGet: vi.fn(),
  workspaceStatusGet: vi.fn(),
  fileTagSettingsGet: vi.fn(),
  aiSettingsGet: vi.fn(),
}));

const projectMutationMocks = vi.hoisted(() => ({
  archiveMutate: vi.fn(),
  createProjectMutateAsync: vi.fn(async () => undefined),
  deleteProjectMutate: vi.fn(),
}));

const workspaceRecordMutationMocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
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
    workspaceRecordMutation: {
      mutateAsync: workspaceRecordMutationMocks.mutateAsync,
      isPending: false,
    },
    workspaceRecordDeleteMutation: { mutateAsync: vi.fn(), isPending: false },
  }),
}));

vi.mock("../../hooks/useProjectMutations", () => ({
  useProjectMutations: () => ({
    createProjectMutation: {
      isPending: false,
      mutateAsync: projectMutationMocks.createProjectMutateAsync,
    },
    archiveMutation: { mutate: projectMutationMocks.archiveMutate },
    deleteProjectMutation: { mutate: projectMutationMocks.deleteProjectMutate },
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

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location-display">{`${location.pathname}${location.search}`}</div>;
}

function renderPage(initialEntries: string[] = ["/"]) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={initialEntries}>
        <WorkspacePage />
        <LocationDisplay />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("WorkspacePage", () => {
  beforeEach(() => {
    apiMocks.projectsList.mockReset();
    apiMocks.workspacePageGet.mockReset();
    apiMocks.workspaceStatusGet.mockReset();
    apiMocks.fileTagSettingsGet.mockReset();
    apiMocks.aiSettingsGet.mockReset();
    apiMocks.projectsList.mockResolvedValue([]);
    apiMocks.workspacePageGet.mockResolvedValue({
      quickNote: null,
      records: [],
      unfinishedTodos: [],
      finishedTodos: [],
    });
    apiMocks.workspaceStatusGet.mockResolvedValue({
      currentWorkspace: {
        rootPath: "/tmp/workspace",
        displayName: "workspace",
      },
      recentWorkspaces: [],
      aiSecretsUnlocked: true,
    });
    apiMocks.fileTagSettingsGet.mockResolvedValue({ tags: [] });
    apiMocks.aiSettingsGet.mockResolvedValue(null);
    desktopApiMocks.openProjectWindow.mockClear();
    desktopApiMocks.focusProjectWindow.mockClear();
    desktopApiMocks.openFolder.mockClear();
    projectMutationMocks.archiveMutate.mockClear();
    projectMutationMocks.createProjectMutateAsync.mockClear();
    projectMutationMocks.deleteProjectMutate.mockClear();
    workspaceRecordMutationMocks.mutateAsync.mockReset();
    workspaceRecordMutationMocks.mutateAsync.mockResolvedValue({
      id: 99,
      title: null,
      contentMarkdown: "",
      contentHtml: "<p></p>",
      tags: [],
      createdAt: "2026-04-06T08:00:00.000Z",
      updatedAt: "2026-04-06T08:00:00.000Z",
    });
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
    apiMocks.fileTagSettingsGet.mockResolvedValueOnce({ tags: [] });

    renderPage();

    expect(await screen.findByLabelText("工作区导航侧边栏")).toBeInTheDocument();
    expect(screen.getByText("Todo List")).toBeInTheDocument();
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
    apiMocks.fileTagSettingsGet.mockResolvedValueOnce({ tags: [] });

    renderPage();

    expect(await screen.findByLabelText("工作区导航侧边栏")).toBeInTheDocument();
    expect(screen.getByText("Todo List")).toBeInTheDocument();
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
    apiMocks.fileTagSettingsGet.mockResolvedValueOnce({ tags: [] });
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

  it("requires dialog confirmation before deleting a project", async () => {
    const user = userEvent.setup();

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
    apiMocks.fileTagSettingsGet.mockResolvedValueOnce({ tags: [] });

    renderPage();

    const projectButton = await screen.findByRole("button", { name: /alpha/i });
    fireEvent.contextMenu(projectButton, {
      clientX: 100,
      clientY: 120,
    });
    await user.click(await screen.findByRole("menuitem", { name: "删除" }));

    expect(projectMutationMocks.deleteProjectMutate).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog", { name: "删除项目" });
    expect(within(dialog).getByText("Alpha")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "删除项目" }));

    expect(projectMutationMocks.deleteProjectMutate).toHaveBeenCalledWith({ projectId: 1 });
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
    apiMocks.fileTagSettingsGet.mockResolvedValueOnce({ tags: [] });
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
    apiMocks.fileTagSettingsGet.mockResolvedValueOnce({ tags: [] });
    desktopApiMocks.focusProjectWindow.mockResolvedValueOnce(true);

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /alpha/i }));

    expect(desktopApiMocks.focusProjectWindow).toHaveBeenCalledWith(1);
  });

  it("creates a project immediately from the project tab action", async () => {
    const user = userEvent.setup();

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
    apiMocks.fileTagSettingsGet.mockResolvedValueOnce({ tags: [] });

    renderPage();

    await user.click(await screen.findByRole("button", { name: "新建项目" }));

    expect(projectMutationMocks.createProjectMutateAsync).toHaveBeenCalledWith({
      name: "未命名项目",
      quickNote: "",
      status: "active",
    });
  });

  it("shows the archived project button and opens the archived dialog", async () => {
    const user = userEvent.setup();

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
      {
        id: 2,
        name: "Beta Archive",
        kind: "normal",
        status: "paused",
        rootPath: "/tmp/beta",
        quickNote: "",
        isArchived: true,
        createdAt: "",
        updatedAt: "",
        activityCount: 0,
        unorganizedCount: 0,
        openTodoCount: 2,
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
    apiMocks.fileTagSettingsGet.mockResolvedValueOnce({ tags: [] });

    renderPage();

    await user.click(await screen.findByRole("button", { name: /归档项目/i }));

    const dialog = screen.getByRole("dialog", { name: "归档项目" });
    expect(within(dialog).getByText("Beta Archive")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "打开" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "恢复" })).toBeInTheDocument();
  });

  it("opens an archived project in the current window from the dialog", async () => {
    const user = userEvent.setup();

    apiMocks.projectsList.mockResolvedValueOnce([
      {
        id: 2,
        name: "Beta Archive",
        kind: "normal",
        status: "paused",
        rootPath: "/tmp/beta",
        quickNote: "",
        isArchived: true,
        createdAt: "",
        updatedAt: "",
        activityCount: 0,
        unorganizedCount: 0,
        openTodoCount: 2,
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
    apiMocks.fileTagSettingsGet.mockResolvedValueOnce({ tags: [] });

    renderPage();

    await user.click(await screen.findByRole("button", { name: /归档项目/i }));
    await user.click(within(screen.getByRole("dialog", { name: "归档项目" })).getByRole("button", { name: "打开" }));

    expect(desktopApiMocks.focusProjectWindow).toHaveBeenCalledWith(2);
  });

  it("restores an archived project from the dialog", async () => {
    const user = userEvent.setup();

    apiMocks.projectsList.mockResolvedValueOnce([
      {
        id: 2,
        name: "Beta Archive",
        kind: "normal",
        status: "paused",
        rootPath: "/tmp/beta",
        quickNote: "",
        isArchived: true,
        createdAt: "",
        updatedAt: "",
        activityCount: 0,
        unorganizedCount: 0,
        openTodoCount: 2,
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
    apiMocks.fileTagSettingsGet.mockResolvedValueOnce({ tags: [] });

    renderPage();

    await user.click(await screen.findByRole("button", { name: /归档项目/i }));
    await user.click(within(screen.getByRole("dialog", { name: "归档项目" })).getByRole("button", { name: "恢复" }));

    expect(projectMutationMocks.archiveMutate).toHaveBeenCalledWith({
      projectId: 2,
      isArchived: false,
    });
  });

  it("shows an empty state when no archived projects exist", async () => {
    const user = userEvent.setup();

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
    apiMocks.fileTagSettingsGet.mockResolvedValueOnce({ tags: [] });

    renderPage();

    await user.click(await screen.findByRole("button", { name: /归档项目/i }));

    expect(
      within(screen.getByRole("dialog", { name: "归档项目" })).getByText("暂无归档项目"),
    ).toBeInTheDocument();
  });

  it("filters record body from the sidebar search and tag pills", async () => {
    const user = userEvent.setup();

    apiMocks.projectsList.mockResolvedValueOnce([]);
    apiMocks.workspacePageGet.mockResolvedValueOnce({
      quickNote: null,
      records: [
        {
          id: 1,
          title: "预算复盘",
          contentMarkdown: "命中记录内容",
          contentHtml: "<p>命中记录内容</p>",
          createdAt: "2026-04-06T08:00:00.000Z",
          updatedAt: "2026-04-06T09:00:00.000Z",
          tags: [{ id: 3, label: "预算", colorKey: "amber" }],
        },
        {
          id: 2,
          title: "招聘同步",
          contentMarkdown: "另一个结果",
          contentHtml: "<p>另一个结果</p>",
          createdAt: "2026-04-06T10:00:00.000Z",
          updatedAt: "2026-04-06T11:00:00.000Z",
          tags: [{ id: 4, label: "招聘", colorKey: "blue" }],
        },
      ],
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
    apiMocks.fileTagSettingsGet.mockResolvedValueOnce({
      tags: [
        { id: 3, label: "预算", colorKey: "amber" },
        { id: 4, label: "招聘", colorKey: "blue" },
      ],
    });

    renderPage(["/?view=record"]);

    const sidebar = await screen.findByLabelText("工作区导航侧边栏");
    const recordPage = screen.getByTestId("workspace-page-body-record");

    await user.click(within(sidebar).getByRole("tab", { name: "记录" }));
    await user.click(within(sidebar).getByRole("button", { name: "预算" }));

    expect(within(recordPage).getByText("预算复盘")).toBeInTheDocument();
    expect(within(recordPage).queryByText("招聘同步")).not.toBeInTheDocument();

    await user.type(within(sidebar).getByLabelText("搜索记录"), "命中");

    expect(within(recordPage).getByText("预算复盘")).toBeInTheDocument();
    expect(within(recordPage).queryByText("招聘同步")).not.toBeInTheDocument();
  });

  it("opens a workspace record focus page when a sidebar record is double clicked", async () => {
    const user = userEvent.setup();

    apiMocks.projectsList.mockResolvedValueOnce([]);
    apiMocks.workspacePageGet.mockResolvedValueOnce({
      quickNote: null,
      records: [
        {
          id: 7,
          title: "预算复盘",
          contentMarkdown: "命中记录内容",
          contentHtml: "<p>命中记录内容</p>",
          createdAt: "2026-04-06T08:00:00.000Z",
          updatedAt: "2026-04-06T09:00:00.000Z",
          tags: [],
        },
      ],
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
    apiMocks.fileTagSettingsGet.mockResolvedValueOnce({ tags: [] });

    renderPage(["/?view=record"]);

    const sidebar = await screen.findByLabelText("工作区导航侧边栏");
    await user.click(within(sidebar).getByRole("tab", { name: "记录" }));

    fireEvent.doubleClick(within(sidebar).getByRole("button", { name: /预算复盘/ }));

    expect(screen.getByTestId("location-display")).toHaveTextContent("/workspace/records/7");
  });

  it("creates a workspace record from the sidebar and opens its focus page", async () => {
    const user = userEvent.setup();

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
    apiMocks.fileTagSettingsGet.mockResolvedValueOnce({ tags: [] });

    renderPage(["/?view=record"]);

    const sidebar = await screen.findByLabelText("工作区导航侧边栏");
    await user.click(within(sidebar).getByRole("tab", { name: "记录" }));
    await user.click(within(sidebar).getByRole("button", { name: "新增记录" }));

    expect(workspaceRecordMutationMocks.mutateAsync).toHaveBeenCalledWith({
      markdown: "",
      html: "<p></p>",
      tagIds: [],
    });
    await waitFor(() => {
      expect(screen.getByTestId("location-display")).toHaveTextContent("/workspace/records/99");
    });
    expect(screen.queryByPlaceholderText("记录标题")).not.toBeInTheDocument();
  });
});
