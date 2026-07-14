import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  RouterProvider,
  createMemoryRouter,
  useLocation,
} from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsRouteBridge } from "./components/settings/SettingsDialog";
import {
  PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT,
  type ProjectRecordFocusSaveRequestDetail,
} from "./lib/record-focus-save";

vi.mock("./services/desktopApi", () => ({
  desktopApi: {
    listSystemFontFamilies: vi.fn(async () => ["PingFang SC", "Segoe UI"]),
    focusProjectWindow: vi.fn(async () => false),
    openProjectWindow: vi.fn(async () => undefined),
    isProjectWindow: vi.fn(() => false),
    getCurrentWindowLabel: vi.fn(() => "main"),
  },
}));

vi.mock("./lib/project-window", () => ({
  PROJECT_WINDOW_NAVIGATE_EVENT: "project-window:navigate",
  getCurrentWindowLabel: vi.fn(() => "main"),
  isProjectWindow: vi.fn(() => false),
  listenToProjectWindowNavigation: vi.fn(async () => null),
  parseProjectWindowProjectId: vi.fn((label: string) => {
    const match = /^project-(\d+)$/u.exec(label);
    return match ? Number.parseInt(match[1] ?? "", 10) : null;
  }),
}));

vi.mock("./services/projectMindApi", () => ({
  projectMindApi: {
    workspaceStatusGet: vi.fn(async () => ({
      currentWorkspace: {
        rootPath: "/tmp/workspace",
        metadataPath: "/tmp/workspace/.project-mind/workspace.json",
        displayName: "Test Workspace",
        createdAt: "2026-04-11T00:00:00.000Z",
      },
      recentWorkspaces: [],
      aiSecretsUnlocked: true,
      securityMode: "workspace_password_encrypted",
    })),
    projectsList: vi.fn(async () => []),
    workspaceSearch: vi.fn(async () => []),
    activityList: vi.fn(async () => []),
    activityCreate: vi.fn(async () => ({
      id: 88,
      projectId: 1,
      attributeOptionId: null,
      attributeLabel: null,
      attributeColorKey: null,
      title: "",
      activityTime: "2026-04-11T00:00:00.000Z",
      statusOptionId: 1,
      statusLabel: "待启动",
      statusColorKey: "amber",
      isPinned: false,
      isExpanded: false,
      createdAt: "",
      updatedAt: "",
      digest: {
        id: 88,
        projectId: 1,
        attributeOptionId: null,
        attributeLabel: null,
        attributeColorKey: null,
        title: "",
        activityTime: "2026-04-11T00:00:00.000Z",
        statusOptionId: 1,
        statusLabel: "待启动",
        statusColorKey: "amber",
        isPinned: false,
        noteCount: 0,
        conclusionCount: 0,
        todoCount: 0,
        documentCount: 0,
        completedTodoCount: 0,
        totalTodoCount: 0,
        hasOpenTodos: false,
      },
      notes: [],
      conclusions: [],
      todos: [],
      documents: [],
    })),
    activityDelete: vi.fn(async ({ activityId }: { activityId: number }) => ({
      id: activityId,
      projectId: 1,
      attributeOptionId: null,
      attributeLabel: null,
      attributeColorKey: null,
      title: "Kickoff Review",
      activityTime: "2026-04-11T00:00:00.000Z",
      statusOptionId: 1,
      statusLabel: "待启动",
      statusColorKey: "amber",
      isPinned: false,
      isExpanded: false,
      createdAt: "",
      updatedAt: "",
      digest: {
        id: activityId,
        projectId: 1,
        attributeOptionId: null,
        attributeLabel: null,
        attributeColorKey: null,
        title: "Kickoff Review",
        activityTime: "2026-04-11T00:00:00.000Z",
        statusOptionId: 1,
        statusLabel: "待启动",
        statusColorKey: "amber",
        isPinned: false,
        noteCount: 0,
        conclusionCount: 0,
        todoCount: 0,
        documentCount: 0,
        completedTodoCount: 0,
        totalTodoCount: 0,
        hasOpenTodos: false,
      },
      notes: [],
      conclusions: [],
      todos: [],
      documents: [],
    })),
    workspaceTodoList: vi.fn(async () => []),
    workspaceRecordList: vi.fn(async () => []),
    workspaceRecordUpsert: vi.fn(),
    workspaceRecordDelete: vi.fn(),
    projectCreate: vi.fn(async ({ name }: { name: string }) => ({
      id: 1,
      name,
      kind: "normal",
      status: "active",
      rootPath: `/tmp/${name}`,
      quickNote: "",
      quickNoteMarkdown: "",
      quickNoteHtml: "",
      isArchived: false,
      createdAt: "",
      updatedAt: "",
    })),
    richTextStyleGet: vi.fn(async () => ({
      body: {
        fontFamily: { source: "preset", value: "workspace_sans" },
        fontSizePx: 14,
        lineHeight: 1.6,
        paragraphSpacingBeforePx: 12,
        paragraphSpacingAfterPx: 0,
      },
      headings: {
        fontFamily: { source: "preset", value: "workspace_sans" },
        lineHeight: 1.35,
        paragraphSpacingBeforePx: 12,
        paragraphSpacingAfterPx: 0,
        h1SizePx: 24,
        h2SizePx: 20,
        h3SizePx: 16,
      },
      list: {
        fontFamily: { source: "preset", value: "workspace_sans" },
        fontSizePx: 14,
        lineHeight: 1.6,
        paragraphSpacingBeforePx: 12,
        paragraphSpacingAfterPx: 0,
      },
    })),
    activitySettingsGet: vi.fn(async () => ({
      activityAttributeOptions: [],
      activityStatusOptions: [
        {
          id: 1,
          label: "待启动",
          colorKey: "amber",
          isSystem: true,
          createdAt: "",
          updatedAt: "",
        },
      ],
    })),
    projectTagSettingsGet: vi.fn(async () => ({
      tags: [],
    })),
    recordTypeSettingsGet: vi.fn(async () => ({
      recordTypes: [
        {
          id: 1,
          key: "quick_note",
          label: "原始记录",
          colorKey: "slate",
          templateHtml: "<p></p>",
          isDefault: true,
          usageCount: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
    })),
    aiJobsListActive: vi.fn(async () => []),
    aiJobGet: vi.fn(async () => null),
    aiSettingsGet: vi.fn(async () => ({
      profiles: [],
      bindings: [],
      hasUsableDefault: false,
      securityMode: "workspace_password_encrypted",
      aiSecretsUnlocked: true,
      execution: {
        maxConcurrency: 1,
      },
      editorSkills: [],
    })),
    projectPageGet: vi.fn(async () => ({
      project: null,
      activityFeed: [],
      projectDocuments: [],
      conclusionGroups: [],
      unfinishedTodos: [],
      finishedTodos: [],
    })),
    projectRecordUpsert: vi.fn(async () => ({
      id: 99,
      projectId: 1,
      activityId: null,
      title: null,
      contentMarkdown: "",
      contentHtml: "<p></p>",
      createdAt: "",
      updatedAt: "",
      tags: [],
    })),
  },
}));

import { WorkspaceLayout, workspaceSearchResultRoute } from "./App";
import { getCurrentWindowLabel, isProjectWindow } from "./lib/project-window";
import { desktopApi } from "./services/desktopApi";
import { projectMindApi } from "./services/projectMindApi";
import { createUiStoreState, useUiStore } from "./state/ui-store";

describe("workspaceSearchResultRoute", () => {
  const baseResult = {
    projectId: 3,
    title: "Result",
    subtitle: "Project",
    matchedText: "Result",
  };

  it("builds routes for every navigable search result kind", () => {
    expect(
      workspaceSearchResultRoute({
        ...baseResult,
        kind: "workspace_quick_note",
        id: 1,
        projectId: null,
      }),
    ).toBe("/workspace");
    expect(
      workspaceSearchResultRoute({
        ...baseResult,
        kind: "workspace_note",
        id: 6,
        projectId: null,
      }),
    ).toBe("/workspace/records/6");
    expect(
      workspaceSearchResultRoute({
        ...baseResult,
        kind: "contact",
        id: 12,
        projectId: null,
      }),
    ).toBeNull();
    expect(
      workspaceSearchResultRoute({ ...baseResult, kind: "activity", id: 7 }),
    ).toBe("/projects/3/activities/7");
    expect(workspaceSearchResultRoute({ ...baseResult, kind: "note", id: 8 })).toBe(
      "/projects/3?focus=record-8",
    );
    expect(
      workspaceSearchResultRoute({ ...baseResult, kind: "conclusion", id: 9 }),
    ).toBe("/projects/3?focus=conclusion-9");
    expect(workspaceSearchResultRoute({ ...baseResult, kind: "todo", id: 10 })).toBe(
      "/projects/3?focus=todo-10",
    );
    expect(
      workspaceSearchResultRoute({ ...baseResult, kind: "document", id: 11 }),
    ).toBe("/projects/3?focus=document-11");
    expect(
      workspaceSearchResultRoute({ ...baseResult, kind: "project", id: 3 }),
    ).toBeNull();
  });
});

describe("WorkspaceLayout", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isProjectWindow).mockReturnValue(false);
    vi.mocked(getCurrentWindowLabel).mockReturnValue("main");
    useUiStore.setState(createUiStoreState());
  });

  it("creates a project immediately from the empty state", async () => {
    const user = userEvent.setup();
    const LocationDisplay = () => {
      const location = useLocation();
      return <div data-testid="location-display">{`${location.pathname}${location.search}`}</div>;
    };

    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout />,
          children: [
            { index: true, element: <div>workspace outlet</div> },
            { path: "today", element: <div>today route</div> },
            {
              path: "projects/:projectId",
              element: (
                <>
                  <div>project route body</div>
                  <LocationDisplay />
                </>
              ),
            },
          ],
        },
      ],
      { initialEntries: ["/"] },
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText(/当前还没有项目。需要开始整理时再创建即可/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "创建项目" }));
    expect(await screen.findByText("project route body")).toBeInTheDocument();
    expect(vi.mocked(projectMindApi.projectCreate).mock.calls[0]?.[0]).toEqual({
      name: "未命名项目",
      quickNote: "",
      status: "active",
    });
    expect(screen.getByTestId("location-display")).toHaveTextContent(
      "/projects/1?renameProject=1",
    );
  });

  it("opens settings as a dialog even when there are no projects", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout />,
          children: [
            { index: true, element: <div>workspace outlet</div> },
            { path: "today", element: <div>today route</div> },
          ],
        },
      ],
      { initialEntries: ["/"] },
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await screen.findByText(/当前还没有项目。需要开始整理时再创建即可/i);
    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(
      await screen.findByRole("dialog", { name: "设置" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Workspace 标签/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /AI 模型配置/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /AI 技能/ })).toBeInTheDocument();
  });

  it("opens rich text settings from the route bridge", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout />,
          children: [
            { index: true, element: <div>workspace outlet</div> },
            { path: "projects", element: <div>projects route</div> },
            { path: "settings/:section", element: <SettingsRouteBridge /> },
          ],
        },
      ],
      { initialEntries: ["/settings/rich-text"] },
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("dialog", { name: "设置" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /富文本样式/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "富文本样式" }),
    ).toBeInTheDocument();
  });

  it("opens workspace tag settings from a workspace route", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout />,
          children: [
            { index: true, element: <div>workspace outlet</div> },
            { path: "projects", element: <div>projects route</div> },
            { path: "settings/:section", element: <SettingsRouteBridge /> },
          ],
        },
      ],
      { initialEntries: ["/settings/project-tags"] },
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("dialog", { name: "设置" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Workspace 标签/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Workspace 标签" })).toBeInTheDocument();
  });

  it("returns to the remembered project route when switching back by top tabs", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ openProjectIds: [1, 2] });

    vi.mocked(projectMindApi.projectsList).mockResolvedValue([
      {
        id: 1,
        name: "Alpha Project",
        kind: "normal",
        status: "active",
        rootPath: "/tmp/alpha",
        summary: "",
        isArchived: false,
        createdAt: "",
        updatedAt: "",
        activityCount: 1,
        unorganizedCount: 0,
        openTodoCount: 1,
      },
      {
        id: 2,
        name: "Beta Project",
        kind: "normal",
        status: "active",
        rootPath: "/tmp/beta",
        summary: "",
        isArchived: false,
        createdAt: "",
        updatedAt: "",
        activityCount: 0,
        unorganizedCount: 0,
        openTodoCount: 0,
      },
    ]);
    vi.mocked(projectMindApi.activityList).mockImplementation(
      async ({ projectId }) =>
        projectId === 1
          ? [
              {
                id: 11,
                projectId: 1,
                attributeOptionId: null,
                attributeLabel: null,
                attributeColorKey: null,
                title: "Kickoff Review",
                activityTime: "2026-04-11T00:00:00.000Z",
                statusOptionId: 1,
                statusLabel: "已整理",
                statusColorKey: "green",
                isPinned: false,
                isExpanded: false,
                createdAt: "",
                updatedAt: "",
                digest: {
                  id: 11,
                  projectId: 1,
                  attributeOptionId: null,
                  attributeLabel: null,
                  attributeColorKey: null,
                  title: "Kickoff Review",
                  activityTime: "2026-04-11T00:00:00.000Z",
                  statusOptionId: 1,
                  statusLabel: "已整理",
                  statusColorKey: "green",
                  isPinned: false,
                  noteCount: 0,
                  conclusionCount: 0,
                  todoCount: 0,
                  documentCount: 0,
                  completedTodoCount: 0,
                  totalTodoCount: 0,
                  hasOpenTodos: false,
                },
                notes: [],
                conclusions: [],
                todos: [],
                documents: [],
              },
            ]
          : [],
    );

    const LocationDisplay = () => {
      const location = useLocation();
      return (
        <div data-testid="location-display">{`${location.pathname}${location.search}`}</div>
      );
    };

    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout />,
          children: [
            {
              path: "projects/:projectId",
              element: (
                <>
                  <div>project route body</div>
                  <LocationDisplay />
                </>
              ),
            },
            {
              path: "projects/:projectId/activities/:activityId",
              element: (
                <>
                  <div>activity route body</div>
                  <LocationDisplay />
                </>
              ),
            },
          ],
        },
      ],
      { initialEntries: ["/projects/1/activities/11?focus=todo-3"] },
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("activity route body")).toBeInTheDocument();
    expect(screen.getByTestId("location-display")).toHaveTextContent(
      "/projects/1/activities/11?focus=todo-3",
    );

    await user.click(
      await screen.findByRole("button", { name: "Beta Project" }),
    );
    expect(await screen.findByText("project route body")).toBeInTheDocument();
    expect(screen.getByTestId("location-display")).toHaveTextContent(
      "/projects/2",
    );

    await user.click(screen.getByRole("button", { name: "Alpha Project" }));
    expect(await screen.findByText("activity route body")).toBeInTheDocument();
    expect(screen.getByTestId("location-display")).toHaveTextContent(
      "/projects/1/activities/11?focus=todo-3",
    );
  });

  it("keeps Today visible without an Ask entry", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout />,
          children: [
            { index: true, element: <div>workspace outlet</div> },
            { path: "today", element: <div>today route</div> },
          ],
        },
      ],
      { initialEntries: ["/"] },
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await screen.findByText(/当前还没有项目。需要开始整理时再创建即可/i);
    expect(
      screen.queryByRole("button", { name: "Ask" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Workspace" })).toBeInTheDocument();
  });

  it("keeps /today accessible after AI entry removal", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout />,
          children: [
            { index: true, element: <div>workspace outlet</div> },
            { path: "projects", element: <div>projects route</div> },
            { path: "today", element: <div>today route</div> },
          ],
        },
      ],
      { initialEntries: ["/today"] },
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(router.state.location.pathname).toBe("/today"));
    expect(await screen.findByText("today route")).toBeInTheDocument();
  });

  it("focuses an existing detached project window instead of navigating in the main window", async () => {
    useUiStore.setState({ openProjectIds: [1, 2] });
    vi.mocked(projectMindApi.projectsList).mockResolvedValue([
      {
        id: 1,
        name: "Alpha Project",
        kind: "normal",
        status: "active",
        rootPath: "/tmp/alpha",
        summary: "",
        isArchived: false,
        createdAt: "",
        updatedAt: "",
        activityCount: 1,
        unorganizedCount: 0,
        openTodoCount: 1,
      },
      {
        id: 2,
        name: "Beta Project",
        kind: "normal",
        status: "active",
        rootPath: "/tmp/beta",
        summary: "",
        isArchived: false,
        createdAt: "",
        updatedAt: "",
        activityCount: 0,
        unorganizedCount: 0,
        openTodoCount: 0,
      },
    ]);
    vi.mocked(desktopApi.focusProjectWindow).mockResolvedValueOnce(true);

    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout />,
          children: [
            {
              path: "projects/:projectId",
              element: <div>project route body</div>,
            },
          ],
        },
      ],
      { initialEntries: ["/projects/1"] },
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await screen.findByText("project route body");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Beta Project" }));

    expect(desktopApi.focusProjectWindow).toHaveBeenCalledWith(2);
    expect(router.state.location.pathname).toBe("/projects/1");
  });

  it("hides the top bar inside a detached project window", async () => {
    vi.mocked(projectMindApi.projectsList).mockResolvedValue([
      {
        id: 1,
        name: "Alpha Project",
        kind: "normal",
        status: "active",
        rootPath: "/tmp/alpha",
        summary: "",
        isArchived: false,
        createdAt: "",
        updatedAt: "",
        activityCount: 1,
        unorganizedCount: 0,
        openTodoCount: 1,
      },
    ]);
    vi.mocked(projectMindApi.projectPageGet).mockResolvedValue({
      project: {
        id: 1,
        name: "Alpha Project",
        kind: "normal",
        status: "active",
        rootPath: "/tmp/alpha",
        summary: "",
        summaryMarkdown: "",
        summaryHtml: "",
        isArchived: false,
        createdAt: "",
        updatedAt: "",
        activityCount: 1,
        unorganizedCount: 0,
        openTodoCount: 1,
      },
      activityFeed: [],
      records: [],
      projectDocuments: [],
      conclusionGroups: [],
      unfinishedTodos: [],
      finishedTodos: [],
    });
    vi.mocked(isProjectWindow).mockReturnValue(true);
    vi.mocked(getCurrentWindowLabel).mockReturnValue("project-1");

    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout />,
          children: [{ path: "projects/:projectId", element: <div>project route body</div> }],
        },
      ],
      { initialEntries: ["/projects/1"] },
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("project route body")).toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "Projects" })).not.toBeInTheDocument();
  });

  it("creates a project record from the sidebar and opens its focus page", async () => {
    const user = userEvent.setup();
    const LocationDisplay = () => {
      const location = useLocation();
      return <div data-testid="location-display">{`${location.pathname}${location.search}`}</div>;
    };

    vi.mocked(projectMindApi.projectsList).mockResolvedValue([
      {
        id: 1,
        name: "Alpha Project",
        kind: "normal",
        status: "active",
        rootPath: "/tmp/alpha",
        summary: "",
        isArchived: false,
        createdAt: "",
        updatedAt: "",
        activityCount: 1,
        unorganizedCount: 0,
        openTodoCount: 1,
      },
    ]);
    vi.mocked(projectMindApi.projectPageGet).mockResolvedValue({
      project: {
        id: 1,
        name: "Alpha Project",
        kind: "normal",
        status: "active",
        rootPath: "/tmp/alpha",
        summary: "",
        summaryMarkdown: "",
        summaryHtml: "",
        isArchived: false,
        createdAt: "",
        updatedAt: "",
        activityCount: 1,
        unorganizedCount: 0,
        openTodoCount: 1,
      },
      activityFeed: [],
      records: [],
      projectDocuments: [],
      conclusionGroups: [],
      unfinishedTodos: [],
      finishedTodos: [],
    });

    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout />,
          children: [
            {
              path: "projects/:projectId",
              element: (
                <>
                  <div>project route body</div>
                  <LocationDisplay />
                </>
              ),
            },
            {
              path: "projects/:projectId/records/:noteId",
              element: (
                <>
                  <div>record focus route body</div>
                  <LocationDisplay />
                </>
              ),
            },
          ],
        },
      ],
      { initialEntries: ["/projects/1"] },
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const sidebar = await screen.findByLabelText("项目导航侧边栏");
    await user.click(within(sidebar).getByRole("button", { name: "新增记录" }));

    expect(projectMindApi.projectRecordUpsert).toHaveBeenCalledWith({
      projectId: 1,
      markdown: "",
      html: "<p></p>",
      tagIds: [],
      defaultCodeLanguage: null,
    });
    expect(await screen.findByText("record focus route body")).toBeInTheDocument();
    expect(screen.getByTestId("location-display")).toHaveTextContent("/projects/1/records/99");
  });

  it("opens a project record focus page when a sidebar record is double clicked", async () => {
    const LocationDisplay = () => {
      const location = useLocation();
      return <div data-testid="location-display">{`${location.pathname}${location.search}`}</div>;
    };

    vi.mocked(projectMindApi.projectsList).mockResolvedValue([
      {
        id: 1,
        name: "Alpha Project",
        kind: "normal",
        status: "active",
        rootPath: "/tmp/alpha",
        summary: "",
        isArchived: false,
        createdAt: "",
        updatedAt: "",
        activityCount: 1,
        unorganizedCount: 0,
        openTodoCount: 1,
      },
    ]);
    vi.mocked(projectMindApi.projectPageGet).mockResolvedValue({
      project: {
        id: 1,
        name: "Alpha Project",
        kind: "normal",
        status: "active",
        rootPath: "/tmp/alpha",
        summary: "",
        summaryMarkdown: "",
        summaryHtml: "",
        isArchived: false,
        createdAt: "",
        updatedAt: "",
        activityCount: 1,
        unorganizedCount: 0,
        openTodoCount: 1,
      },
      activityFeed: [],
      records: [
        {
          id: 7,
          projectId: 1,
          activityId: null,
          title: "Kickoff Review",
          contentMarkdown: "记录内容",
          contentHtml: "<p>记录内容</p>",
          defaultCodeLanguage: null,
          tags: [],
          createdAt: "",
          updatedAt: "",
        },
      ],
      projectDocuments: [],
      conclusionGroups: [],
      unfinishedTodos: [],
      finishedTodos: [],
    });

    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout />,
          children: [
            {
              path: "projects/:projectId",
              element: (
                <>
                  <div>project route body</div>
                  <LocationDisplay />
                </>
              ),
            },
            {
              path: "projects/:projectId/records/:noteId",
              element: (
                <>
                  <div>record focus route body</div>
                  <LocationDisplay />
                </>
              ),
            },
          ],
        },
      ],
      { initialEntries: ["/projects/1?recordQuery=kickoff"] },
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const sidebar = await screen.findByLabelText("项目导航侧边栏");
    fireEvent.doubleClick(within(sidebar).getByRole("button", { name: /Kickoff Review/ }));

    expect(await screen.findByText("record focus route body")).toBeInTheDocument();
    expect(screen.getByTestId("location-display")).toHaveTextContent(
      "/projects/1/records/7?recordQuery=kickoff",
    );
  });

  it("keeps single-click record navigation inside the project focus page", async () => {
    const user = userEvent.setup();
    const LocationDisplay = () => {
      const location = useLocation();
      return <div data-testid="location-display">{`${location.pathname}${location.search}`}</div>;
    };

    vi.mocked(projectMindApi.projectsList).mockResolvedValue([
      {
        id: 1,
        name: "Alpha Project",
        kind: "normal",
        status: "active",
        rootPath: "/tmp/alpha",
        summary: "",
        isArchived: false,
        createdAt: "",
        updatedAt: "",
        activityCount: 1,
        unorganizedCount: 0,
        openTodoCount: 1,
      },
    ]);
    vi.mocked(projectMindApi.projectPageGet).mockResolvedValue({
      project: {
        id: 1,
        name: "Alpha Project",
        kind: "normal",
        status: "active",
        rootPath: "/tmp/alpha",
        summary: "",
        summaryMarkdown: "",
        summaryHtml: "",
        isArchived: false,
        createdAt: "",
        updatedAt: "",
        activityCount: 1,
        unorganizedCount: 0,
        openTodoCount: 1,
      },
      activityFeed: [],
      records: [
        {
          id: 7,
          projectId: 1,
          activityId: null,
          title: "Current Record",
          contentMarkdown: "当前记录",
          contentHtml: "<p>当前记录</p>",
          defaultCodeLanguage: null,
          tags: [],
          createdAt: "",
          updatedAt: "",
        },
        {
          id: 8,
          projectId: 1,
          activityId: null,
          title: "Next Record",
          contentMarkdown: "下一条记录",
          contentHtml: "<p>下一条记录</p>",
          defaultCodeLanguage: null,
          tags: [],
          createdAt: "",
          updatedAt: "",
        },
      ],
      projectDocuments: [],
      conclusionGroups: [],
      unfinishedTodos: [],
      finishedTodos: [],
    });

    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout />,
          children: [
            {
              path: "projects/:projectId/records/:noteId",
              element: (
                <>
                  <div>record focus route body</div>
                  <LocationDisplay />
                </>
              ),
            },
          ],
        },
      ],
      { initialEntries: ["/projects/1/records/7"] },
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const handleSaveRequest = (event: Event) => {
      (event as CustomEvent<ProjectRecordFocusSaveRequestDetail>).detail.respond(true);
    };
    window.addEventListener(PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT, handleSaveRequest);
    const sidebar = await screen.findByLabelText("项目导航侧边栏");
    await user.click(within(sidebar).getByRole("button", { name: /Next Record/ }));

    await waitFor(() => {
      expect(screen.getByTestId("location-display")).toHaveTextContent("/projects/1/records/8");
    });
    window.removeEventListener(PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT, handleSaveRequest);
  });

});
