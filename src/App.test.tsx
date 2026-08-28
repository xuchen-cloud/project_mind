import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsRouteBridge } from "./components/settings/SettingsDialog";
import {
  PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT,
  type ProjectRecordFocusSaveRequestDetail,
} from "./lib/record-focus-save";
import { RecordSaveCoordinator } from "./lib/record-save-coordinator";
import { queryKeys } from "./lib/queryKeys";

vi.mock("./services/desktopApi", () => ({
  desktopApi: {
    listSystemFontFamilies: vi.fn(async () => ["PingFang SC", "Segoe UI"]),
    focusProjectWindow: vi.fn(async () => false),
    openProjectWindow: vi.fn(async () => undefined),
    isProjectWindow: vi.fn(() => false),
    getCurrentWindowLabel: vi.fn(() => "main"),
    listenForCloseRequest: vi.fn(async () => () => undefined),
    listenForWorkspaceLifecycleFlush: vi.fn(async () => () => undefined),
    flushOtherWorkspaceWindows: vi.fn(async () => undefined),
    destroyOtherWorkspaceWindows: vi.fn(async () => undefined),
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

vi.mock("./routes/record-focus-modules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./routes/record-focus-modules")>()),
  scheduleRecordFocusPageModulesPreload: vi.fn(() => vi.fn()),
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
    workspaceRecordList: vi.fn(async () => []),
    workspacePageGet: vi.fn(async () => ({
      quickNote: null,
      records: [],
      unfinishedTodos: [],
      finishedTodos: [],
    })),
    workspaceRecordUpsert: vi.fn(),
    workspaceRecordDelete: vi.fn(),
    workspaceOpen: vi.fn(),
    workspaceClose: vi.fn(),
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
        h4SizePx: 14,
      },
      list: {
        fontFamily: { source: "preset", value: "workspace_sans" },
        fontSizePx: 14,
        lineHeight: 1.6,
        paragraphSpacingBeforePx: 12,
        paragraphSpacingAfterPx: 0,
      },
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
      projectDocuments: [],
      unfinishedTodos: [],
      finishedTodos: [],
    })),
    projectRecordUpsert: vi.fn(async () => ({
      id: 99,
      projectId: 1,
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

  it("builds only routes consumed by the current workspace and project pages", () => {
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
    expect(workspaceSearchResultRoute({ ...baseResult, kind: "note", id: 8 })).toBe("/projects/3?focus=record-8");
    expect(
      workspaceSearchResultRoute({
        ...baseResult,
        kind: "todo",
        id: 10,
        scope: "project",
        source: "Project",
      }),
    ).toBe("/projects/3?focus=todo-10");
    expect(
      workspaceSearchResultRoute({
        ...baseResult,
        kind: "todo",
        id: 10,
        scope: "workspace",
        source: "Workspace",
        projectId: null,
      }),
    ).toBe("/workspace?focus=todo-10");
    expect(workspaceSearchResultRoute({ ...baseResult, kind: "document", id: 11 })).toBe("/projects/3");
    expect(workspaceSearchResultRoute({ ...baseResult, kind: "project", id: 3 })).toBeNull();
  });
});

describe("WorkspaceLayout", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(desktopApi.listenForCloseRequest).mockResolvedValue(() => undefined);
    vi.mocked(desktopApi.listenForWorkspaceLifecycleFlush).mockResolvedValue(
      () => undefined,
    );
    vi.mocked(desktopApi.flushOtherWorkspaceWindows).mockResolvedValue(undefined);
    vi.mocked(desktopApi.destroyOtherWorkspaceWindows).mockResolvedValue(undefined);
    vi.mocked(isProjectWindow).mockReturnValue(false);
    vi.mocked(getCurrentWindowLabel).mockReturnValue("main");
    useUiStore.setState(createUiStoreState());
  });

  it("keeps the top-bar search global while a Project is active", async () => {
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
        openTodoCount: 0,
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
        openTodoCount: 0,
      },
      records: [],
      projectDocuments: [],
      unfinishedTodos: [],
      finishedTodos: [],
    });
    vi.mocked(projectMindApi.workspaceSearch).mockImplementation(async (input) =>
      input.projectId === undefined
        ? [
            {
              kind: "note",
              id: 7,
              projectId: 1,
              title: "季度复盘",
              subtitle: "Alpha Project",
              matchedText: "客户标签",
            },
          ]
        : [],
    );

    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout />,
          children: [
            { path: "projects/:projectId", element: <div>project route body</div> },
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

    await userEvent.setup().type(await screen.findByLabelText("全局搜索"), "客户标签");

    expect(await screen.findByText("季度复盘")).toBeInTheDocument();
    expect(projectMindApi.workspaceSearch).toHaveBeenLastCalledWith({ query: "客户标签" });
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
            { path: "workspace", element: <div>workspace route</div> },
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

    expect(await screen.findByText(/当前还没有项目。需要开始整理时再创建即可/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "创建项目" }));
    expect(await screen.findByText("project route body")).toBeInTheDocument();
    expect(vi.mocked(projectMindApi.projectCreate).mock.calls[0]?.[0]).toEqual({
      name: "未命名项目",
      quickNote: "",
      status: "active",
    });
    expect(screen.getByTestId("location-display")).toHaveTextContent("/projects/1?renameProject=1");
  });

  it("flushes the old Workspace queue before opening another Workspace", async () => {
    const user = userEvent.setup();
    vi.mocked(projectMindApi.workspaceStatusGet).mockResolvedValue({
      currentWorkspace: null,
      recentWorkspaces: [
        {
          rootPath: "/tmp/next-workspace",
          metadataPath: "/tmp/next-workspace/.project-mind/workspace.json",
          displayName: "Next Workspace",
          createdAt: "2026-08-23T00:00:00.000Z",
        },
      ],
      aiSecretsUnlocked: false,
      securityMode: "workspace_password_encrypted",
    });
    vi.mocked(projectMindApi.workspaceOpen).mockResolvedValue({
      currentWorkspace: {
        rootPath: "/tmp/next-workspace",
        metadataPath: "/tmp/next-workspace/.project-mind/workspace.json",
        displayName: "Next Workspace",
        createdAt: "2026-08-23T00:00:00.000Z",
      },
      recentWorkspaces: [],
      aiSecretsUnlocked: true,
      securityMode: "workspace_password_encrypted",
    });
    let finishSave!: () => void;
    const pendingSave = new Promise<{ updatedAt: string }>((resolve) => {
      finishSave = () => resolve({ updatedAt: "saved" });
    });
    const coordinator = new RecordSaveCoordinator({
      workspaceKey: "/tmp/old-workspace",
      adapter: { persist: vi.fn(() => pendingSave) },
    });
    coordinator.submit({
      scope: "project",
      workspaceKey: "/tmp/old-workspace",
      projectId: 1,
      recordId: 7,
      title: "Record",
      tagIds: [],
      defaultCodeLanguage: null,
      committedContent: {
        html: "<p>pending</p>",
        text: "pending",
        markdown: "pending",
      },
    });
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout recordSaveCoordinator={coordinator} />,
        },
      ],
      { initialEntries: ["/"] },
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole("button", { name: /Next Workspace/ }));
    expect(projectMindApi.workspaceOpen).not.toHaveBeenCalled();
    finishSave();
    await waitFor(() => {
      expect(projectMindApi.workspaceOpen).toHaveBeenCalledWith({
        rootPath: "/tmp/next-workspace",
      });
    });
  });

  it("flushes saves and returns to the Workspace Gate when switching Workspace", async () => {
    const user = userEvent.setup();
    vi.mocked(projectMindApi.workspaceClose).mockResolvedValue({
      currentWorkspace: null,
      recentWorkspaces: [
        {
          rootPath: "/tmp/workspace",
          metadataPath: "/tmp/workspace/.project-mind/workspace.json",
          displayName: "Test Workspace",
          createdAt: "2026-04-11T00:00:00.000Z",
        },
      ],
      aiSecretsUnlocked: false,
      securityMode: "workspace_password_encrypted",
    });
    const coordinator = new RecordSaveCoordinator({
      workspaceKey: "/tmp/workspace",
      adapter: { persist: vi.fn() },
    });
    const flush = vi.spyOn(coordinator, "flush");
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.contacts.all, [{ id: 1, name: "Old Contact" }]);
    queryClient.setQueryData(queryKeys.documentVersions(7), [{ id: 3 }]);
    useUiStore.getState().openProjectTab(9);
    useUiStore.getState().openSettings("contacts", 9);
    const router = createMemoryRouter(
      [{ path: "*", element: <WorkspaceLayout recordSaveCoordinator={coordinator} /> }],
      { initialEntries: ["/"] },
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "切换 Workspace" }));

    await waitFor(() => expect(projectMindApi.workspaceClose).toHaveBeenCalledTimes(1));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(desktopApi.flushOtherWorkspaceWindows).toHaveBeenCalledTimes(1);
    expect(desktopApi.destroyOtherWorkspaceWindows).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(desktopApi.destroyOtherWorkspaceWindows).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(projectMindApi.workspaceClose).mock.invocationCallOrder[0]);
    expect(queryClient.getQueryData(queryKeys.contacts.all)).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.documentVersions(7))).toBeUndefined();
    expect(useUiStore.getState().openProjectIds).toEqual([]);
    expect(useUiStore.getState().settingsOpen).toBe(false);
    expect(await screen.findByRole("heading", { name: "打开你的 Workspace" })).toBeInTheDocument();
  });

  it("keeps the current Workspace open when the switch save barrier fails", async () => {
    const user = userEvent.setup();
    const coordinator = new RecordSaveCoordinator({
      workspaceKey: "/tmp/workspace",
      adapter: { persist: vi.fn() },
    });
    vi.spyOn(coordinator, "flush").mockRejectedValue(new Error("save failed"));
    const router = createMemoryRouter(
      [{ path: "*", element: <WorkspaceLayout recordSaveCoordinator={coordinator} /> }],
      { initialEntries: ["/"] },
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "切换 Workspace" }));

    expect(projectMindApi.workspaceClose).not.toHaveBeenCalled();
    expect(await screen.findByText("切换 Workspace 失败")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Workspace" })).toBeInTheDocument();
  });

  it("waits for pending Record saves before allowing a normal window close", async () => {
    let requestClose: (() => Promise<boolean>) | undefined;
    vi.mocked(desktopApi.listenForCloseRequest).mockImplementation(async (handler) => {
      requestClose = handler;
      return () => undefined;
    });
    let finishSave!: () => void;
    const pendingSave = new Promise<{ updatedAt: string }>((resolve) => {
      finishSave = () => resolve({ updatedAt: "saved" });
    });
    const coordinator = new RecordSaveCoordinator({
      workspaceKey: "/tmp/workspace",
      adapter: { persist: vi.fn(() => pendingSave) },
    });
    coordinator.submit({
      scope: "project",
      workspaceKey: "/tmp/workspace",
      projectId: 1,
      recordId: 7,
      title: "Record",
      tagIds: [],
      defaultCodeLanguage: null,
      committedContent: {
        html: "<p>pending</p>",
        text: "pending",
        markdown: "pending",
      },
    });
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout recordSaveCoordinator={coordinator} />,
        },
      ],
      { initialEntries: ["/"] },
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(requestClose).toBeDefined());
    let closed = false;
    const closeResult = requestClose?.().then((result) => {
      closed = result;
      return result;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    finishSave();
    await expect(closeResult).resolves.toBe(true);
    expect(desktopApi.flushOtherWorkspaceWindows).toHaveBeenCalledTimes(1);
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
            { path: "workspace", element: <div>workspace route</div> },
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
    expect(await screen.findByRole("dialog", { name: "设置" })).toBeInTheDocument();
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

    expect(await screen.findByRole("dialog", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /富文本样式/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "富文本样式" })).toBeInTheDocument();
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

    expect(await screen.findByRole("dialog", { name: "设置" })).toBeInTheDocument();
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
        openTodoCount: 0,
      },
    ]);
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
      { initialEntries: ["/projects/1?focus=todo-3"] },
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("project route body")).toBeInTheDocument();
    expect(screen.getByTestId("location-display")).toHaveTextContent("/projects/1?focus=todo-3");

    await user.click(await screen.findByRole("tab", { name: "Beta Project" }));
    expect(await screen.findByText("project route body")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("location-display")).toHaveTextContent("/projects/2"));

    await user.click(screen.getByRole("tab", { name: "Alpha Project" }));
    await waitFor(() => expect(screen.getByTestId("location-display")).toHaveTextContent("/projects/1?focus=todo-3"));
  });

  it("keeps Workspace visible without an Ask entry", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout />,
          children: [
            { index: true, element: <div>workspace outlet</div> },
            { path: "workspace", element: <div>workspace route</div> },
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
    expect(screen.queryByRole("button", { name: "Ask" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Workspace" })).toBeInTheDocument();
  });

  it("uses /workspace as the canonical Workspace route", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout />,
          children: [
            { index: true, element: <div>workspace outlet</div> },
            { path: "projects", element: <div>projects route</div> },
            { path: "workspace", element: <div>workspace route</div> },
          ],
        },
      ],
      { initialEntries: ["/workspace"] },
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(router.state.location.pathname).toBe("/workspace"));
    expect(await screen.findByText("workspace route")).toBeInTheDocument();
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
    await userEvent.setup().click(await screen.findByRole("tab", { name: "Beta Project" }));

    expect(desktopApi.focusProjectWindow).toHaveBeenCalledWith(2);
    expect(router.state.location.pathname).toBe("/projects/1");
  });

  it("prefetches project page data before a non-active tab is opened", async () => {
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
        openTodoCount: 0,
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
        openTodoCount: 0,
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

    await screen.findByText("project route body");
    const betaTab = await screen.findByRole("tab", { name: "Beta Project" });
    vi.mocked(projectMindApi.projectPageGet).mockClear();

    fireEvent.pointerEnter(betaTab);

    await waitFor(() =>
      expect(projectMindApi.projectPageGet).toHaveBeenCalledWith({
        projectId: 2,
      }),
    );
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
        openTodoCount: 1,
      },
      records: [],
      projectDocuments: [],
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
        openTodoCount: 1,
      },
      records: [],
      projectDocuments: [],
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
        openTodoCount: 1,
      },
      records: [
        {
          id: 7,
          projectId: 1,
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
    expect(screen.getByTestId("location-display")).toHaveTextContent("/projects/1/records/7?recordQuery=kickoff");
  });

  it("commits Record navigation before a delayed forced save resolves", async () => {
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
        openTodoCount: 1,
      },
      records: [
        {
          id: 7,
          projectId: 1,
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
      unfinishedTodos: [],
      finishedTodos: [],
    });

    let finishSave!: () => void;
    const delayedSave = new Promise<{ updatedAt: string }>((resolve) => {
      finishSave = () => resolve({ updatedAt: "saved" });
    });
    const persist = vi.fn(() => delayedSave);
    const coordinator = new RecordSaveCoordinator({
      workspaceKey: "/tmp/workspace",
      adapter: { persist },
    });
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout recordSaveCoordinator={coordinator} />,
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
      const detail = (event as CustomEvent<ProjectRecordFocusSaveRequestDetail>).detail;
      coordinator.submit({
        scope: "project",
        workspaceKey: "/tmp/workspace",
        projectId: detail.projectId,
        recordId: detail.recordId,
        title: "Current Record",
        tagIds: [],
        defaultCodeLanguage: null,
        committedContent: {
          html: "<p>最后一个字符！</p>",
          text: "最后一个字符！",
          markdown: "最后一个字符！",
        },
      });
      detail.respond(true);
    };
    window.addEventListener(PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT, handleSaveRequest);
    const sidebar = await screen.findByLabelText("项目导航侧边栏");
    fireEvent.click(within(sidebar).getByRole("button", { name: /Next Record/ }));

    expect(screen.getByTestId("location-display")).toHaveTextContent("/projects/1/records/8");
    expect(persist).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: 7,
        committedContent: expect.objectContaining({
          markdown: "最后一个字符！",
        }),
      }),
    );
    expect(coordinator.getStatus()).toMatchObject({
      phase: "saving",
      pendingCount: 1,
    });
    finishSave();
    await coordinator.flush();

    await router.navigate(-1);
    await waitFor(() => {
      expect(screen.getByTestId("location-display")).toHaveTextContent("/projects/1/records/7");
    });
    await Promise.resolve();
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ recordId: 8 }));
    await coordinator.flush();
    window.removeEventListener(PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT, handleSaveRequest);
  });

  it("keeps a global two-entry Record Focus LRU through the production WorkspaceLayout routes", async () => {
    const timestamp = "2026-08-23T00:00:00.000Z";
    const project = (id: number, name: string) => ({
      id,
      name,
      kind: "normal" as const,
      status: "active",
      rootPath: `/tmp/${name.toLowerCase()}`,
      quickNote: "",
      isArchived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      openTodoCount: 0,
    });
    const projects = [project(1, "Alpha"), project(2, "Beta")];
    const record = (projectId: number, id: number, title: string) => ({
      id,
      projectId,
      title,
      contentMarkdown: `${title} 正文`,
      contentHtml: `<p>${title} 正文</p>`,
      defaultCodeLanguage: null,
      tags: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const projectPages = new Map([
      [
        1,
        {
          project: projects[0],
          records: [record(1, 7, "Alpha A"), record(1, 8, "Alpha B")],
          projectDocuments: [],
          unfinishedTodos: [],
          finishedTodos: [],
        },
      ],
      [
        2,
        {
          project: projects[1],
          records: [record(2, 17, "Beta A")],
          projectDocuments: [],
          unfinishedTodos: [],
          finishedTodos: [],
        },
      ],
    ]);
    const workspacePage = {
      quickNote: null,
      records: [
        {
          id: 27,
          title: "Workspace A",
          contentMarkdown: "Workspace A 正文",
          contentHtml: "<p>Workspace A 正文</p>",
          defaultCodeLanguage: null,
          tags: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      unfinishedTodos: [],
      finishedTodos: [],
    };
    const workspaceStatus = {
      currentWorkspace: {
        rootPath: "/tmp/workspace",
        metadataPath: "/tmp/workspace/.project-mind/workspace.json",
        displayName: "Test Workspace",
        createdAt: timestamp,
      },
      recentWorkspaces: [],
      aiSecretsUnlocked: true,
      securityMode: "workspace_password_encrypted" as const,
    };
    vi.mocked(projectMindApi.projectsList).mockResolvedValue(projects);
    vi.mocked(projectMindApi.projectPageGet).mockImplementation(async ({ projectId }) => projectPages.get(projectId)!);
    vi.mocked(projectMindApi.workspacePageGet).mockResolvedValue(workspacePage);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnMount: false } },
    });
    queryClient.setQueryData(queryKeys.workspaceStatus, workspaceStatus);
    queryClient.setQueryData(queryKeys.projects.all, projects);
    queryClient.setQueryData(queryKeys.projectPage(1), projectPages.get(1));
    queryClient.setQueryData(queryKeys.projectPage(2), projectPages.get(2));
    queryClient.setQueryData(queryKeys.workspacePage, workspacePage);
    queryClient.setQueryData(queryKeys.projectTags.workspace, { tags: [] });
    queryClient.setQueryData(queryKeys.projectTags.project(1), { tags: [] });
    queryClient.setQueryData(queryKeys.projectTags.project(2), { tags: [] });
    queryClient.setQueryData(queryKeys.aiSettings, null);
    const persist = vi.fn(() => new Promise<{ updatedAt: string }>(() => undefined));
    const coordinator = new RecordSaveCoordinator({
      workspaceKey: "/tmp/workspace",
      adapter: { persist },
    });
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout cacheProjectOverviewPages recordSaveCoordinator={coordinator} />,
          children: [
            {
              path: "projects/:projectId/records/:noteId",
              element: <div>legacy project route</div>,
            },
            {
              path: "workspace/records/:noteId",
              element: <div>legacy workspace route</div>,
            },
            {
              path: "workspace",
              element: <div>legacy workspace overview</div>,
            },
          ],
        },
      ],
      { initialEntries: ["/projects/1/records/7"] },
    );

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const fallback = document.querySelector("[data-record-focus-cached-fallback]");
    expect(fallback).toHaveTextContent("Alpha A 正文");
    expect(screen.queryByRole("status", { name: "正在打开记录" })).not.toBeInTheDocument();
    await screen.findByPlaceholderText("记录标题");
    const alphaA = document.querySelector('[data-focus-page-key="1:7"]');
    expect(alphaA).not.toBeNull();
    expect(alphaA?.closest('[data-project-resident-id="1"]')).not.toBeNull();

    await act(() => router.navigate("/projects/1/records/8"));
    await waitFor(() => expect(document.querySelector('[data-focus-page-key="1:8"]')).not.toBeNull());
    await act(() => router.navigate("/projects/1/records/7"));
    await waitFor(() => expect(document.querySelector('[data-focus-page-key="1:7"]')).toBe(alphaA));

    await act(() => router.navigate("/projects/2/records/17"));
    await waitFor(() => expect(document.querySelector('[data-focus-page-key="2:17"]')).not.toBeNull());
    expect(
      document.querySelector('[data-focus-page-key="2:17"]')?.closest('[data-project-resident-id="2"]'),
    ).not.toBeNull();
    await act(() => router.navigate("/projects/1/records/7"));
    await waitFor(() => expect(document.querySelector('[data-focus-page-key="1:7"]')).toBe(alphaA));

    await act(() => router.navigate("/workspace/records/27"));
    await waitFor(() => expect(document.querySelector('[data-focus-page-key="workspace:27"]')).not.toBeNull());
    expect(
      document.querySelector('[data-focus-page-key="workspace:27"]')?.closest("[data-workspace-resident-shell]"),
    ).not.toBeNull();
    await act(() => router.navigate("/workspace"));
    expect(router.state.location.pathname).toBe("/workspace");
    await waitFor(() => {
      expect(
        persist.mock.calls.filter(([snapshot]) => snapshot.scope === "workspace" && snapshot.recordId === 27),
      ).toHaveLength(1);
    });
    await act(() => router.navigate("/workspace/records/27"));
    await waitFor(() => expect(document.querySelector('[data-focus-page-key="workspace:27"]')).not.toBeNull());

    await act(() => router.navigate("/projects/1/records/8"));
    await waitFor(() => expect(document.querySelector('[data-focus-page-key="1:8"]')).not.toBeNull());
    expect(document.querySelectorAll("[data-record-focus-resident-key]")).toHaveLength(2);
    expect(alphaA).not.toBeInTheDocument();
    expect(projectMindApi.projectPageGet).not.toHaveBeenCalled();
    expect(projectMindApi.workspacePageGet).not.toHaveBeenCalled();
  });

  it("keeps five unified Project shells resident and evicts only the LRU shell", async () => {
    const timestamp = "2026-08-23T00:00:00.000Z";
    const projects = Array.from({ length: 12 }, (_, index) => {
      const id = index + 1;
      return {
        id,
        name: `Project ${id}`,
        kind: "normal" as const,
        status: "active",
        rootPath: `/tmp/project-${id}`,
        quickNote: `Quick note ${id}`,
        quickNoteMarkdown: `Quick note ${id}`,
        quickNoteHtml: `<p>Quick note ${id}</p>`,
        isArchived: false,
        createdAt: timestamp,
        updatedAt: timestamp,
        openTodoCount: 0,
      };
    });
    const projectPages = new Map(
      projects.map((project) => [
        project.id,
        {
          project,
          records: [
            {
              id: project.id * 10,
              projectId: project.id,
              title: `Record ${project.id}`,
              contentMarkdown: `Record body ${project.id}`,
              contentHtml: `<p>Record body ${project.id}</p>`,
              defaultCodeLanguage: null,
              tags: [],
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
          projectDocuments: [],
          unfinishedTodos: [],
          finishedTodos: [],
        },
      ]),
    );
    vi.mocked(projectMindApi.projectsList).mockResolvedValue(projects);
    vi.mocked(projectMindApi.projectPageGet).mockImplementation(async ({ projectId }) => projectPages.get(projectId)!);
    useUiStore.setState({
      openProjectIds: projects.map((project) => project.id),
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnMount: false } },
    });
    queryClient.setQueryData(queryKeys.projects.all, projects);
    for (const project of projects) {
      queryClient.setQueryData(queryKeys.projectPage(project.id), projectPages.get(project.id));
      queryClient.setQueryData(queryKeys.projectTags.project(project.id), {
        tags: [],
      });
    }
    queryClient.setQueryData(queryKeys.projectTags.workspace, { tags: [] });
    queryClient.setQueryData(queryKeys.aiSettings, null);
    const coordinator = new RecordSaveCoordinator({
      workspaceKey: "/tmp/workspace",
      adapter: {
        persist: vi.fn(async () => ({ updatedAt: timestamp })),
      },
    });

    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout cacheProjectOverviewPages recordSaveCoordinator={coordinator} />,
          children: [
            { path: "projects/:projectId", element: <div>legacy route</div> },
            {
              path: "projects/:projectId/records/:noteId",
              element: <div>legacy Focus route</div>,
            },
          ],
        },
      ],
      { initialEntries: ["/projects/1?view=record"] },
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(document.querySelector('[data-project-resident-id="1"]')).not.toBeNull());
    const projectA = document.querySelector('[data-project-resident-id="1"]');

    for (const projectId of [2, 3, 4, 5]) {
      await act(() => router.navigate(`/projects/${projectId}`));
      await waitFor(() =>
        expect(document.querySelector(`[data-project-resident-id="${projectId}"]`)).toHaveAttribute(
          "data-project-resident-active",
          "true",
        ),
      );
    }
    await waitFor(() => expect(document.querySelectorAll("[data-project-resident-id]")).toHaveLength(5));
    expect(projectA).toHaveAttribute("aria-hidden", "true");
    expect(projectA).toHaveAttribute("inert");

    await userEvent.setup().click(screen.getByRole("tab", { name: "Project 1" }));
    await waitFor(() => {
      expect(document.querySelector('[data-project-resident-id="1"]')).toBe(projectA);
      expect(projectA).toHaveAttribute("data-project-resident-active", "true");
    });
    expect(router.state.location.pathname).toBe("/projects/1");
    expect(router.state.location.search).toBe("?view=record");

    await act(() => router.navigate("/projects/6"));
    await waitFor(() => {
      expect(document.querySelectorAll("[data-project-resident-id]")).toHaveLength(5);
      expect(document.querySelector('[data-project-resident-id="2"]')).toBeNull();
    });
    expect(document.querySelector('[data-project-resident-id="1"]')).toBe(projectA);

    await userEvent.setup().click(screen.getByRole("button", { name: "关闭 Project 3" }));
    await waitFor(() => expect(document.querySelector('[data-project-resident-id="3"]')).toBeNull());

    for (const projectId of [7, 8, 9, 10, 11, 12]) {
      const recordId = projectId * 10;
      await act(async () => {
        await router.navigate(`/projects/${projectId}/records/${recordId}`);
        await coordinator.flush();
      });
      await waitFor(() =>
        expect(document.querySelector(`[data-focus-page-key="${projectId}:${recordId}"]`)).not.toBeNull(),
      );
    }
    expect(document.querySelectorAll("[data-project-resident-id]")).toHaveLength(5);
    expect(document.querySelectorAll("[data-record-focus-resident-key]")).toHaveLength(2);
    expect(projectMindApi.projectPageGet).not.toHaveBeenCalled();
    expect(projectMindApi.projectTagSettingsGet).not.toHaveBeenCalled();
  }, 15_000);
});
