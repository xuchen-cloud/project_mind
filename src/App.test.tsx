import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsRouteBridge } from "./components/settings/SettingsDialog";

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
    richTextStyleGet: vi.fn(async () => ({
      body: {
        fontPreset: "workspace_sans",
        fontSizePx: 14,
        lineHeight: 1.6,
        paragraphSpacingBeforePx: 12,
        paragraphSpacingAfterPx: 0,
      },
      headings: {
        fontPreset: "workspace_sans",
        lineHeight: 1.35,
        paragraphSpacingBeforePx: 12,
        paragraphSpacingAfterPx: 0,
        h1SizePx: 24,
        h2SizePx: 20,
        h3SizePx: 16,
      },
      list: {
        fontPreset: "workspace_sans",
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
        },
        features: {
          "summary.activity_summary": true,
          "summary.project_brief": true,
          "summary.daily_brief": true,
          "suggestion_generation.conclusion": true,
          "suggestion_generation.todo": true,
        },
      },
    })),
    projectGetOverview: vi.fn(async () => ({
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
import { projectMindApi } from "./services/projectMindApi";
import { useUiStore } from "./state/ui-store";

describe("WorkspaceLayout", () => {
  beforeEach(() => {
    useUiStore.setState({
      createProjectOpen: false,
      createActivityOpen: false,
      settingsOpen: false,
      settingsSection: "activity",
      projectComposer: null,
      projectSidebarCollapsed: false,
      todoRailCollapsed: false,
    });
  });

  it("shows the empty state and opens create project dialog", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout />,
          children: [{ index: true, element: <div>workspace outlet</div> }],
        },
      ],
      { initialEntries: ["/"] },
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/当前还没有项目。需要开始整理时再创建即可/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "创建项目" }));
    expect(await screen.findByText("Project Mind Workspace")).toBeInTheDocument();
    expect(screen.getByText("Project Mind Workspace")).toBeInTheDocument();
  });

  it("opens settings as a dialog even when there are no projects", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout />,
          children: [{ index: true, element: <div>workspace outlet</div> }],
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
    expect(await screen.findByRole("dialog", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /活动标签/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /文件标签/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /记录类型/ })).toBeInTheDocument();
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

    expect(await screen.findByRole("dialog", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /富文本样式/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "富文本样式" })).toBeInTheDocument();
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

    expect(await screen.findByRole("dialog", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /文件标签/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "文件标签" })).toBeInTheDocument();
  });

  it("renders the project activity sidebar at shell level while keeping the top tabs", async () => {
    vi.mocked(projectMindApi.projectsList).mockResolvedValueOnce([
      {
        id: 1,
        name: "Alpha Project",
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

    expect(await screen.findByLabelText("项目导航侧边栏")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Today" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起项目侧边栏" })).toBeInTheDocument();
    expect(screen.getByText("Kickoff Review")).toBeInTheDocument();
    expect(screen.getByText("project route body")).toBeInTheDocument();
  });

  it("hides Ask and Today entries when their AI toggles are off", async () => {
    vi.mocked(projectMindApi.aiSettingsGet).mockResolvedValueOnce({
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
          assistant: false,
          summary: true,
          suggestion_generation: true,
        },
        features: {
          "summary.activity_summary": true,
          "summary.project_brief": true,
          "summary.daily_brief": false,
          "suggestion_generation.conclusion": true,
          "suggestion_generation.todo": true,
        },
      },
    });

    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout />,
          children: [{ index: true, element: <div>workspace outlet</div> }],
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
    expect(screen.queryByRole("button", { name: "Ask" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Today" })).not.toBeInTheDocument();
  });

  it("redirects away from /today when the daily brief feature is off", async () => {
    vi.mocked(projectMindApi.aiSettingsGet).mockResolvedValueOnce({
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
        },
        features: {
          "summary.activity_summary": true,
          "summary.project_brief": true,
          "summary.daily_brief": false,
          "suggestion_generation.conclusion": true,
          "suggestion_generation.todo": true,
        },
      },
    });

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

    await waitFor(() => expect(router.state.location.pathname).toBe("/projects"));
    await waitFor(() => {
      expect(screen.queryByText("today route")).not.toBeInTheDocument();
    });
    expect(screen.getByText(/当前还没有项目。需要开始整理时再创建即可/i)).toBeInTheDocument();
  });
});
