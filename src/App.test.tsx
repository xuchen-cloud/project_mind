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

vi.mock("./services/desktopApi", () => ({
  desktopApi: {
    listSystemFontFamilies: vi.fn(async () => ["PingFang SC", "Segoe UI"]),
    focusProjectWindow: vi.fn(async () => false),
    openProjectWindow: vi.fn(async () => undefined),
    isProjectWindow: vi.fn(() => false),
    getCurrentWindowLabel: vi.fn(() => "main"),
  },
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
      aiSuggestions: [],
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
      aiSuggestions: [],
    })),
    workspaceTodoList: vi.fn(async () => []),
    workspaceRecordList: vi.fn(async () => []),
    workspaceRecordUpsert: vi.fn(),
    workspaceRecordDelete: vi.fn(),
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
    fileTagSettingsGet: vi.fn(async () => ({
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
      featureSettings: {
        masterEnabled: true,
        capabilities: {
          assistant: true,
          summary: true,
          suggestion_generation: true,
          editor_rewrite: true,
        },
        features: {
          "summary.activity_summary": true,
          "summary.project_brief": true,
          "summary.daily_brief": true,
          "suggestion_generation.conclusion": true,
          "suggestion_generation.todo": true,
        },
      },
      editorRewriteActions: [],
    })),
    projectPageGet: vi.fn(async () => ({
      project: null,
      activityFeed: [],
      projectDocuments: [],
      conclusionGroups: [],
      unfinishedTodos: [],
      finishedTodos: [],
    })),
  },
}));

import { WorkspaceLayout } from "./App";
import type { ActivityCardData } from "./lib/types";
import { desktopApi } from "./services/desktopApi";
import { projectMindApi } from "./services/projectMindApi";
import { useUiStore } from "./state/ui-store";

describe("WorkspaceLayout", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useUiStore.setState({
      createProjectOpen: false,
      createActivityOpen: false,
      settingsOpen: false,
      settingsSection: "activity",
      projectComposer: null,
      projectSidebarCollapsed: false,
      todoRailCollapsed: false,
      openProjectIds: [],
      projectRecentPaths: {},
    });
  });

  it("shows the empty state and opens create project dialog", async () => {
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

    expect(
      await screen.findByText(/当前还没有项目。需要开始整理时再创建即可/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "创建项目" }));
    expect(
      await screen.findByText("Project Mind Workspace"),
    ).toBeInTheDocument();
    expect(screen.getByText("Project Mind Workspace")).toBeInTheDocument();
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
    expect(
      screen.getByRole("button", { name: /活动标签/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /文件标签/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /记录类型/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /AI 设置/ })).toBeInTheDocument();
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

  it("opens file tag settings from the route bridge", async () => {
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
      { initialEntries: ["/settings/file-tags"] },
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
      screen.getByRole("button", { name: /文件标签/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "文件标签" }),
    ).toBeInTheDocument();
  });

  it("renders the project activity sidebar at shell level while keeping the top tabs", async () => {
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
        activityCount: 2,
        unorganizedCount: 0,
        openTodoCount: 1,
      },
    ]);
    vi.mocked(projectMindApi.activityList).mockResolvedValueOnce([
      {
        id: 11,
        projectId: 1,
        attributeOptionId: null,
        attributeLabel: "会议",
        attributeColorKey: "blue",
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
          attributeLabel: "会议",
          attributeColorKey: "blue",
          title: "Kickoff Review",
          activityTime: "2026-04-11T00:00:00.000Z",
          statusOptionId: 1,
          statusLabel: "已整理",
          statusColorKey: "green",
          isPinned: false,
          noteCount: 0,
          conclusionCount: 0,
          todoCount: 1,
          documentCount: 2,
          completedTodoCount: 0,
          totalTodoCount: 1,
          hasOpenTodos: true,
        },
        notes: [],
        conclusions: [],
        todos: [],
        documents: [],
        aiSuggestions: [],
      },
    ]);

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

    expect(await screen.findByLabelText("项目导航侧边栏")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "总览" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "收起项目侧边栏" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Kickoff Review")).toBeInTheDocument();
    expect(screen.getByText("project route body")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "新建 Activity" }),
    ).toBeInTheDocument();
  });

  it("creates a new activity from the sidebar and navigates into it", async () => {
    const user = userEvent.setup();

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
        activityCount: 2,
        unorganizedCount: 0,
        openTodoCount: 1,
      },
    ]);
    vi.mocked(projectMindApi.activityList).mockResolvedValue([
      {
        id: 11,
        projectId: 1,
        attributeOptionId: null,
        attributeLabel: "会议",
        attributeColorKey: "blue",
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
          attributeLabel: "会议",
          attributeColorKey: "blue",
          title: "Kickoff Review",
          activityTime: "2026-04-11T00:00:00.000Z",
          statusOptionId: 1,
          statusLabel: "已整理",
          statusColorKey: "green",
          isPinned: false,
          noteCount: 0,
          conclusionCount: 0,
          todoCount: 1,
          documentCount: 2,
          completedTodoCount: 0,
          totalTodoCount: 1,
          hasOpenTodos: true,
        },
        notes: [],
        conclusions: [],
        todos: [],
        documents: [],
        aiSuggestions: [],
      },
    ]);

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
            {
              path: "projects/:projectId/activities/:activityId",
              element: <div>activity route body</div>,
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

    await screen.findByLabelText("项目导航侧边栏");
    await user.click(screen.getByRole("button", { name: "新建 Activity" }));

    await waitFor(() =>
      expect(vi.mocked(projectMindApi.activityCreate)).toHaveBeenCalled(),
    );
    expect(vi.mocked(projectMindApi.activityCreate).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        projectId: 1,
        title: "",
        activityTime: expect.any(String),
      }),
    );
    await screen.findByText("activity route body");
  });

  it("deletes the active activity from the sidebar context menu after confirmation", async () => {
    const user = userEvent.setup();
    let deleted = false;
    const activity: ActivityCardData = {
      id: 11,
      projectId: 1,
      attributeOptionId: null,
      attributeLabel: "会议",
      attributeColorKey: "blue",
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
        attributeLabel: "会议",
        attributeColorKey: "blue",
        title: "Kickoff Review",
        activityTime: "2026-04-11T00:00:00.000Z",
        statusOptionId: 1,
        statusLabel: "已整理",
        statusColorKey: "green",
        isPinned: false,
        noteCount: 1,
        conclusionCount: 1,
        todoCount: 1,
        documentCount: 1,
        completedTodoCount: 0,
        totalTodoCount: 1,
        hasOpenTodos: true,
      },
      notes: [
        {
          id: 201,
          projectId: 1,
          activityId: 11,
          noteType: "quick_note",
          title: null,
          contentMarkdown: "记录",
          contentHtml: "<p>记录</p>",
          createdAt: "",
          updatedAt: "",
        },
      ],
      conclusions: [
        {
          id: 301,
          projectId: 1,
          activityId: 11,
          noteId: 201,
          contentMarkdown: "结论",
          contentHtml: "<p>结论</p>",
          promotedToProject: false,
          createdAt: "",
          updatedAt: "",
        },
      ],
      todos: [
        {
          id: 401,
          projectId: 1,
          activityId: 11,
          content: "Todo",
          status: "unfinished" as const,
          priority: "not_urgent_important" as const,
          createdAt: "",
          updatedAt: "",
          progresses: [],
        },
      ],
      documents: [
        {
          id: 501,
          projectId: 1,
          activityId: 11,
          name: "brief.md",
          baseName: "brief",
          originalPath: "/tmp/alpha/brief.md",
          managedPath: "/tmp/alpha/.project-mind/files/brief.md",
          historyDirPath: "/tmp/alpha/.project-mind/history/brief",
          storageMode: "managed_copy",
          mimeType: "text/markdown",
          isStarred: false,
          currentVersionNumber: 1,
          versionCount: 1,
          sourceActivityTitle: "Kickoff Review",
          health: "normal" as const,
          tags: [],
          createdAt: "",
          updatedAt: "",
        },
      ],
      aiSuggestions: [],
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
    vi.mocked(projectMindApi.activityList).mockImplementation(async () =>
      deleted ? [] : [activity],
    );
    vi.mocked(projectMindApi.activityDelete).mockImplementation(
      async ({ activityId }) => {
        deleted = true;
        return {
          ...activity,
          id: activityId,
        };
      },
    );

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
            {
              path: "projects/:projectId/activities/:activityId",
              element: <div>activity route body</div>,
            },
          ],
        },
      ],
      { initialEntries: ["/projects/1/activities/11"] },
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("activity route body")).toBeInTheDocument();

    const sidebar = await screen.findByLabelText("项目导航侧边栏");
    fireEvent.contextMenu(
      within(sidebar).getByText("Kickoff Review").closest("button")!,
      {
        clientX: 180,
        clientY: 140,
      },
    );

    await user.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(
      await screen.findByRole("dialog", { name: "删除 Activity" }),
    ).toBeInTheDocument();
    expect(screen.getByText("活动记录：1 条")).toBeInTheDocument();
    expect(screen.getByText("结论：1 条")).toBeInTheDocument();
    expect(screen.getByText("Todo：1 条")).toBeInTheDocument();
    expect(screen.getByText("文件：1 个")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() =>
      expect(vi.mocked(projectMindApi.activityDelete)).toHaveBeenCalledWith(
        { activityId: 11 },
        expect.anything(),
      ),
    );
    expect(await screen.findByText("project route body")).toBeInTheDocument();
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
                aiSuggestions: [],
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
    expect(screen.getByRole("button", { name: "总览" })).toBeInTheDocument();
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
    vi.mocked(desktopApi.isProjectWindow).mockReturnValueOnce(true);
    vi.mocked(desktopApi.getCurrentWindowLabel).mockReturnValueOnce("project-1");

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
});
