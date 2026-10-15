import { closeFilePreview, openFilePreview, useFilePreviewStore } from "./state/file-preview-store";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

const buildMode = vi.hoisted(() => ({ debug: true }));
vi.mock("./lib/build-mode", () => ({ get isDebugBuild() { return buildMode.debug; } }));

import { SettingsRouteBridge } from "./components/settings/SettingsDialog";
import {
  PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT,
  WORKSPACE_RECORD_FOCUS_SAVE_REQUEST_EVENT,
  type ProjectRecordFocusSaveRequestDetail,
} from "./lib/record-focus-save";
import { RecordSaveCoordinator, projectRecordSaveKey } from "./lib/record-save-coordinator";
import { queryKeys } from "./lib/queryKeys";
import { fixtureEditorState } from "./test/recordDocumentFixture";
import type { RecordTarget } from "./lib/record-document-types";
import type { ProjectPageData, WorkspacePageData } from "./lib/types";
import { fileDocumentApi } from "./services/fileDocumentApi";
import { projectFileApi } from "./services/projectFileApi";
import { openProjectFilePreview, useProjectFileNavigation } from "./lib/project-file-navigation";
import { projectDirectoryApi } from "./services/projectDirectoryApi";
import { dshAssistantApi } from "./services/dshAssistantApi";
import { useAgentPanelStore } from "./state/agent-panel-store";
import { getContentLayout } from "./lib/project-content-layout";
import { useProjectContentStore } from "./state/project-content-store";
// Keep native reads, canonical editors, content tabs and the assistant panel real.
// Separately bundled DSH renderers have their own suites; loading their global
// stylesheet here makes jsdom role/visibility queries depend on test order.
vi.mock("@project-mind/dsh-ui/adapters", () => ({
  DshConversationHost: () => <div data-testid="dsh-conversation-host" />,
  DshSettingsHost: () => <div data-testid="dsh-settings-host" />,
  insertDshFileReference: vi.fn(),
}));
vi.mock("../packages/dsh-ui/preview", () => ({
  DshFilePreview: ({ text }: { text?: string }) => <div>{text}</div>,
}));
vi.mock("./services/fileDocumentApi", () => ({ fileDocumentApi: { versionsList: vi.fn(), sourceRead: vi.fn() } }));
vi.mock("./services/projectFileApi", async importOriginal => ({
  ...(await importOriginal<typeof import("./services/projectFileApi")>()),
  projectFileApi: { readBytes: vi.fn(), resolve: vi.fn(), register: vi.fn() },
}));
vi.mock("./services/projectDirectoryApi", () => ({ projectDirectoryApi: { resolveReference: vi.fn(), list: vi.fn(async () => ({ entries: [] })), tree: vi.fn(async () => ({ entries: [] })) } }));
const recordMocks = vi.hoisted(() => ({ editorGet: vi.fn(), checkpoint: vi.fn(), bindingGet: vi.fn(async () => ({ workspaceId: "fixture-workspace", generation: "open-1" })), create: vi.fn(async () => ({ record: { id: 99 } })) }));
vi.mock("./services/agentApi", () => ({ agentApi: { statusGet: async () => ({ binding: { workspaceId: "fixture-workspace", generation: "open-1" } }) } }));
vi.mock("./services/recordDocumentApi", () => ({ recordDocumentApi: { ...recordMocks, editorRegister: vi.fn(async () => null), editorUnregister: vi.fn(async () => null), editorFlushReply: vi.fn(async () => null) } }));

function configureCanonicalRecords(queryClient: QueryClient) {
  recordMocks.editorGet.mockImplementation(async (_binding, target: RecordTarget) => {
    const page = target.scope.kind === "project"
      ? queryClient.getQueryData<ProjectPageData>(queryKeys.projectPage(target.scope.projectId))
      : queryClient.getQueryData<WorkspacePageData>(queryKeys.workspacePage);
    const record = page?.records?.find((candidate) => candidate.id === target.recordId);
    if (!record) throw new Error("Fixture Record is missing");
    return fixtureEditorState(target, record);
  });
}

vi.mock("./services/desktopApi", () => ({
  desktopApi: {
    listenEvent: vi.fn(async () => () => undefined),
    command: vi.fn(async (name: string) => {
      if (name === "voice_availability_get") return { implemented: false, reason: "test" };
      if (name === "voice_settings_get") return { speechProfile: null, textProfileId: null, translationProfileId: null, contextEnabled: false, captionLines: 4 };
      if (name === "dsh_assistant_sessions") return [];
      return null;
    }),
    listSystemFontFamilies: vi.fn(async () => ["PingFang SC", "Segoe UI"]),
    focusProjectWindow: vi.fn(async () => false),
    openProjectWindow: vi.fn(async () => undefined),
    isProjectWindow: vi.fn(() => false),
    getCurrentWindowLabel: vi.fn(() => "main"),
    prepareVoiceLeave: vi.fn(async () => true),
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
    workspaceCreate: vi.fn(),
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
      network: { mode: "system", proxyUrl: null, username: null, hasStoredPassword: false },
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
    expect(workspaceSearchResultRoute({ ...baseResult, kind: "note", id: 8 })).toBe("/projects/3/records/8");
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
  afterEach(() => { buildMode.debug = true; vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  it.each([{ label: "Vite dev", debug: true }, { label: "native debug / production frontend", debug: true }, { label: "release", debug: false }])("creates Workspace with native-generated DEV credentials or required release password ($label)", async ({ debug: dev }) => {
    buildMode.debug = dev;
    vi.mocked(projectMindApi.workspaceStatusGet).mockResolvedValue({ currentWorkspace: null, recentWorkspaces: [], aiSecretsUnlocked: false, securityMode: "workspace_password_encrypted" });
    vi.mocked(projectMindApi.workspaceCreate).mockResolvedValue({ currentWorkspace: null, recentWorkspaces: [], aiSecretsUnlocked: true, securityMode: "workspace_password_encrypted" });
    const router = createMemoryRouter([{ path: "/", element: <WorkspaceLayout />, children: [{ path: "workspace", element: <div /> }] }], { initialEntries: ["/"] });
    render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "新建 Workspace" }));
    fireEvent.change(screen.getByPlaceholderText("例如：/Users/alex/workspaces/customer-success"), { target: { value: " /tmp/new-workspace " } });
    fireEvent.click(screen.getByRole("button", { name: "创建 Workspace" }));
    if (!dev) {
      expect(await screen.findByRole("alert")).toHaveTextContent("请输入 workspace 密码。");
      expect(projectMindApi.workspaceCreate).not.toHaveBeenCalled();
      fireEvent.change(screen.getByPlaceholderText("用于加密保存的 AI API Key"), { target: { value: "original-secret" } });
      fireEvent.click(screen.getByRole("button", { name: "创建 Workspace" }));
    }
    await waitFor(() => expect(projectMindApi.workspaceCreate).toHaveBeenCalledWith({ rootPath: "/tmp/new-workspace", password: dev ? "" : "original-secret" }));
  });
  beforeEach(() => {
    closeFilePreview();
    useAgentPanelStore.getState().clearWorkspace();
    useProjectContentStore.setState({ layouts: {} });
    useProjectFileNavigation.setState({ request: null, revisions: {} });
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

  it("migrates legacy preview and assistant path entries into the real cached Project shell while preserving a pinned view", async () => {
    await import("./components/document/ProjectFileContent");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const timestamp = "2026-10-11T00:00:00Z";
    const projects = [7, 8].map(id => ({ id, name: `Project ${id}`, kind: "normal" as const, status: "active",
      rootPath: `/tmp/project-${id}`, quickNote: "", isArchived: false, createdAt: timestamp, updatedAt: timestamp, openTodoCount: 0 }));
    const record = { id: 70, projectId: 7, title: "保留的记录", contentMarkdown: "canonical body", contentHtml: "<p>canonical body</p>",
      defaultCodeLanguage: null, tags: [], createdAt: timestamp, updatedAt: timestamp };
    client.setQueryData(queryKeys.workspaceStatus, { currentWorkspace: { rootPath: "/tmp/workspace", metadataPath: "/tmp/workspace/.project-mind/workspace.json", displayName: "Test Workspace", createdAt: timestamp }, recentWorkspaces: [], aiSecretsUnlocked: true, securityMode: "workspace_password_encrypted" });
    client.setQueryData(queryKeys.projects.all, projects);
    for (const project of projects) {
      client.setQueryData(queryKeys.projectPage(project.id), { project, records: project.id === 7 ? [record] : [], projectDocuments: [], unfinishedTodos: [], finishedTodos: [] });
      client.setQueryData(queryKeys.projectTags.project(project.id), { tags: [] });
    }
    client.setQueryData(queryKeys.aiSettings, null); configureCanonicalRecords(client);
    vi.mocked(projectMindApi.projectsList).mockResolvedValue(projects);
    const versions = [3, 2, 1].map(versionNumber => ({ id: `v${versionNumber}`, versionNumber, name: "context.txt", createdAt: timestamp, contentHash: `sha256:v${versionNumber}`, isCurrent: versionNumber === 3 }));
    vi.mocked(fileDocumentApi.versionsList).mockImplementation(async (_binding, { object }) => ({ object, currentVersionNumber: 3, currentContentHash: "sha256:v3", versions, nextCursor: null }));
    vi.mocked(projectFileApi.readBytes).mockImplementation(async (_binding, input) => {
      const text = `retained version ${input.versionNumber}`;
      return { object: input.object, versionNumber: input.versionNumber, contentHash: input.expectedContentHash, name: "context.txt", mime: "text/plain", byteLength: text.length, base64: btoa(text) };
    });
    vi.mocked(fileDocumentApi.sourceRead).mockImplementation(async (_binding, input) => {
      const text = `retained version ${input.versionNumber}`;
      return { object: input.object, versionNumber: input.versionNumber, contentHash: input.expectedContentHash!, title: "context.txt", byteLength: text.length,
        format: "text", text, startChar: 0, endChar: text.length, totalChars: text.length, nextCursor: null, complete: true };
    });
    vi.mocked(projectDirectoryApi.resolveReference).mockResolvedValue("notes/context.txt");
    const object = { workspaceId: "fixture-workspace", scope: { kind: "project" as const, projectId: 7 }, kind: "file" as const, id: "51" };
    const identity = { object, name: "context.txt", relativePath: "notes/context.txt", state: "ready" as const, versionNumber: 3, contentHash: "sha256:v3", reason: null };
    vi.mocked(projectFileApi.register).mockResolvedValue(identity); vi.mocked(projectFileApi.resolve).mockResolvedValue(identity);
    const coordinator = new RecordSaveCoordinator({ workspaceKey: "/tmp/workspace", adapter: { persist: vi.fn(async snapshot => ({ updatedAt: timestamp, headRevision: snapshot.canonicalBody!.baseRevision + 1 })) } });
    const router = createMemoryRouter([{ path: "/", element: <WorkspaceLayout cacheProjectOverviewPages recordSaveCoordinator={coordinator} />,
      children: [{ path: "projects/:projectId", element: <p>legacy overview</p> }, { path: "projects/:projectId/records/:noteId", element: <p>legacy record</p> }] }], { initialEntries: ["/projects/7/records/70"] });
    render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByPlaceholderText("记录标题")).toBeEnabled());
    const recordPage = document.querySelector('[data-focus-page-key="7:70"]')!;
    const projectShell = document.querySelector('[data-project-resident-id="7"]')!;
    const request = { workspaceRoot: "/tmp/workspace", projectId: 7, documentId: 51, title: "context.txt", versionNumber: 2 };
    act(() => openFilePreview(request));
    await waitFor(() => expect(screen.getByRole("tab", { name: /context.txt/ })).toBeVisible());
    await waitFor(() => {
      const preview = screen.getByRole("region", { name: "项目文件预览" });
      expect(preview).toHaveTextContent("retained version 2");
    }, { timeout: 5000 });
    expect(screen.getByLabelText("文件查看版本")).toHaveValue("2");
    expect(recordPage).not.toBeVisible(); expect(recordPage).toBeInTheDocument();
    expect(document.querySelector('[data-project-resident-id="7"]')).toBe(projectShell);
    const fileTab = screen.getByRole("tab", { name: /context.txt/ }); const pageId = fileTab.getAttribute("aria-controls");
    expect(router.state.location.pathname).toBe("/projects/7"); expect(router.state.location.search).toContain("content=");
    act(() => openFilePreview({ ...request, versionNumber: undefined }));
    await waitFor(() => expect(useFilePreviewStore.getState().request).toBeNull());
    expect(screen.getByLabelText("文件查看版本")).toHaveValue("2");
    act(() => openProjectFilePreview(7, "/tmp/project-7/notes/context.txt", 4));
    await waitFor(() => expect(useProjectFileNavigation.getState().request).toBeNull());
    expect(screen.getByRole("tab", { name: /context.txt/ })).toHaveAttribute("aria-controls", pageId!);
    expect(projectFileApi.register).toHaveBeenCalledWith({ workspaceId: "fixture-workspace", generation: "open-1" }, 7, "notes/context.txt");
    expect(screen.getByLabelText("文件查看版本")).toHaveValue("2");
    expect(getContentLayout(useProjectContentStore.getState(), { workspaceId: "fixture-workspace", projectId: 7 }).tabs).toHaveLength(2);
    await act(() => router.navigate("/projects/8"));
    expect(projectShell).not.toBeVisible();
    await act(() => router.navigate(`/projects/7?content=${encodeURIComponent(getContentLayout(useProjectContentStore.getState(), { workspaceId: "fixture-workspace", projectId: 7 }).tabs.find(tab => tab.object.kind === "file")!.id)}`));
    await waitFor(() => expect(screen.getByRole("tab", { name: /context.txt/ })).toBeVisible());
    await waitFor(() => {
      const preview = screen.getByRole("region", { name: "项目文件预览" });
      expect(preview).toHaveTextContent("retained version 2");
    }, { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "关闭context.txt" }));
    await waitFor(() => expect(recordPage).toBeVisible());
    expect(document.querySelector('[data-focus-page-key="7:70"]')).toBe(recordPage);
    expect(router.state.location.pathname).toBe("/projects/7/records/70");
    expect(screen.queryByRole("region", { name: "项目文件预览" })).not.toBeInTheDocument();
    expect(screen.queryByText("legacy record")).not.toBeInTheDocument();
    expect(projectMindApi.projectPageGet).not.toHaveBeenCalled();
  }, 15_000);

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
    expect(screen.queryByRole("button", { name: /Workspace 标签/ })).not.toBeInTheDocument();
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

  it("redirects the retired tag settings route to workspace settings", async () => {
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
    expect(screen.queryByRole("button", { name: /Workspace 标签/ })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "页面宽度" })).toBeInTheDocument();
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
        summary: "", quickNote: "", quickNoteMarkdown: "", quickNoteHtml: "<p></p>",
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
        summary: "", quickNote: "", quickNoteMarkdown: "", quickNoteHtml: "<p></p>",
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
          element: <WorkspaceLayout cacheProjectOverviewPages />,
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

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    recordMocks.editorGet.mockImplementation(async (_binding, target: RecordTarget) => fixtureEditorState(target, {
      id: 99, projectId: 1, title: null, contentMarkdown: "", contentHtml: "<p></p>", defaultCodeLanguage: null, tags: [], createdAt: "now", updatedAt: "now",
    }));
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const sidebar = await screen.findByLabelText("项目导航侧边栏");
    recordMocks.create.mockImplementationOnce(async () => {
      const page = client.getQueryData<ProjectPageData>(queryKeys.projectPage(1))!;
      const record = { id: 99, projectId: 1, title: null, contentMarkdown: "", contentHtml: "<p></p>", defaultCodeLanguage: null, tags: [], createdAt: "now", updatedAt: "now" };
      vi.mocked(projectMindApi.projectPageGet).mockResolvedValue({ ...page, records: [record] });
      return { record };
    });
    await user.click(within(sidebar).getByRole("button", { name: "新增记录" }));

    await waitFor(() => expect(recordMocks.create).toHaveBeenCalledWith(expect.any(Object), {
      scope: { kind: "project", projectId: 1 }, title: null, document: { type: "doc", content: [{ type: "paragraph" }] }, tagIds: [], codeLanguage: null,
    }, expect.any(String)));
    expect(projectMindApi.projectRecordUpsert).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByPlaceholderText("记录标题")).toBeEnabled());
    expect(screen.getByRole("tab", { name: "未命名记录" })).toHaveAttribute("aria-selected", "true");
    expect(router.state.location.pathname).toBe("/projects/1/records/99");
    expect(screen.queryByText("record focus route body")).not.toBeInTheDocument();
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
        summary: "", quickNote: "", quickNoteMarkdown: "", quickNoteHtml: "<p></p>",
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
        summary: "", quickNote: "", quickNoteMarkdown: "", quickNoteHtml: "<p></p>",
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
          element: <WorkspaceLayout cacheProjectOverviewPages />,
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

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    configureCanonicalRecords(client);
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const sidebar = await screen.findByLabelText("项目导航侧边栏");
    await userEvent.setup().dblClick(within(sidebar).getByRole("button", { name: /Kickoff Review/ }));

    await waitFor(() => expect(screen.getByPlaceholderText("记录标题")).toHaveValue("Kickoff Review"));
    expect(screen.getByRole("tab", { name: "Kickoff Review" })).toHaveAttribute("aria-selected", "true");
    expect(router.state.location.pathname + router.state.location.search).toBe("/projects/1/records/7?recordQuery=kickoff");
    expect(screen.queryByText("record focus route body")).not.toBeInTheDocument();
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

  it("keeps Project content Records resident independently of the Workspace Record LRU through production routes", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
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
    let finishWorkspaceSave!: () => void;
    const workspaceSave = new Promise<void>(resolve => { finishWorkspaceSave = resolve; });
    const persist = vi.fn(async (snapshot) => {
      if (snapshot.scope === "workspace") await workspaceSave;
      return { updatedAt: timestamp, headRevision: snapshot.canonicalBody!.baseRevision + 1 };
    });
    configureCanonicalRecords(queryClient);
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

    const view = render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    onTestFinished(async () => {
      // Release even on a failed assertion, then finish saves before resetting mocks.
      await act(async () => { finishWorkspaceSave(); await coordinator.flush(); });
      view.unmount();
      router.dispose();
      await queryClient.cancelQueries();
      queryClient.clear();
    });

    await waitFor(() => expect(screen.getByPlaceholderText("记录标题")).toBeEnabled());
    const alphaA = document.querySelector('[data-focus-page-key="1:7"]');
    expect(alphaA).not.toBeNull();
    expect(alphaA?.closest('[data-project-resident-id="1"]')).not.toBeNull();

    await act(() => router.navigate("/projects/1/records/8"));
    await waitFor(() => expect(document.querySelector('[data-focus-page-key="1:8"]')).not.toBeNull());
    await waitFor(() => expect(document.querySelector('[data-focus-page-key="1:8"] input[placeholder="记录标题"]')).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "分栏" }));
    const alphaB = document.querySelector('[data-focus-page-key="1:8"]')!;
    expect(alphaA).toBeVisible(); expect(alphaB).toBeVisible();
    expect(within(alphaA as HTMLElement).getByPlaceholderText("记录标题")).toBeEnabled();
    expect(within(alphaB as HTMLElement).getByPlaceholderText("记录标题")).toBeEnabled();
    expect(screen.getAllByRole("tablist", { name: /栏内容/ })).toHaveLength(2);
    fireEvent.focus(within(alphaA as HTMLElement).getByPlaceholderText("记录标题"));
    expect(screen.getByRole("tablist", { name: "左栏内容" }).closest(".project-content__pane-tabs")).toHaveAttribute("data-focused", "true");
    expect(screen.getByRole("tablist", { name: "右栏内容" }).closest(".project-content__pane-tabs")).not.toHaveAttribute("data-focused");
    fireEvent.click(screen.getByRole("button", { name: "合并分栏" }));
    expect(document.querySelector('[data-focus-page-key="1:7"]')).toBe(alphaA);
    expect(document.querySelector('[data-focus-page-key="1:8"]')).toBe(alphaB);
    await act(() => router.navigate("/projects/1/records/7"));
    await waitFor(() => expect(document.querySelector('[data-focus-page-key="1:7"]')).toBe(alphaA));

    await act(() => router.navigate("/projects/2/records/17"));
    await waitFor(() => expect(document.querySelector('[data-focus-page-key="2:17"]')).not.toBeNull());
    await waitFor(() => expect(document.querySelector('[data-focus-page-key="2:17"] input[placeholder="记录标题"]')).toBeEnabled());
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
    await waitFor(() => expect(document.querySelector('[data-focus-page-key="workspace:27"] input[placeholder="记录标题"]')).toBeEnabled());
    await act(() => router.navigate("/workspace"));
    expect(router.state.location.pathname).toBe("/workspace");
    await waitFor(() => {
      expect(
        persist.mock.calls.filter(([snapshot]) => snapshot.scope === "workspace" && snapshot.recordId === 27),
      ).toHaveLength(1);
    });
    await act(async () => { finishWorkspaceSave(); await coordinator.flush(); });
    await act(() => router.navigate("/workspace/records/27"));
    await waitFor(() => expect(document.querySelector('[data-focus-page-key="workspace:27"]')).not.toBeNull());

    await act(() => router.navigate("/projects/1/records/8"));
    await waitFor(() => expect(document.querySelector('[data-focus-page-key="1:8"]')).not.toBeNull());
    expect(document.querySelectorAll('[data-project-resident-id] [data-content-object^="record:"]')).toHaveLength(3);
    expect(document.querySelectorAll("[data-record-focus-resident-key]")).toHaveLength(1);
    expect(alphaA).toBeInTheDocument();
    expect(alphaA).not.toBeVisible();
    expect(screen.getByRole("tab", { name: "Alpha B" })).toHaveAttribute("aria-selected", "true");
    expect(projectMindApi.projectPageGet).not.toHaveBeenCalled();
    expect(projectMindApi.workspacePageGet).not.toHaveBeenCalled();
  }, 15_000);

  async function renderResidentProjectFixture(startWithRecord = false) {
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
    configureCanonicalRecords(queryClient);
    const coordinator = new RecordSaveCoordinator({
      workspaceKey: "/tmp/workspace",
      adapter: {
        persist: vi.fn(async (snapshot) => {
          return { updatedAt: timestamp, headRevision: snapshot.canonicalBody!.baseRevision + 1 };
        }),
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
      { initialEntries: [startWithRecord ? "/projects/7/records/70" : "/projects/1?view=record"] },
    );
    const view = render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    onTestFinished(async () => {
      // Unmount observers before cancelling queries; no previous fixture may
      // continue publishing into the next test's shared API mocks.
      view.unmount();
      router.dispose();
      await queryClient.cancelQueries();
      queryClient.clear();
    });

    const initialProjectId = startWithRecord ? 7 : 1;
    await waitFor(() => expect(document.querySelector(`[data-project-resident-id="${initialProjectId}"]`)).not.toBeNull());
    const projectA = document.querySelector(`[data-project-resident-id="${initialProjectId}"]`);

    return { router, coordinator, projectA };
  }

  it("restores interactive Project content after closing the assistant and after switching Projects", async () => {
    const start = vi.spyOn(dshAssistantApi, "start").mockResolvedValue(undefined);
    const sessions = vi.spyOn(dshAssistantApi, "sessions").mockResolvedValue([]);
    useAgentPanelStore.getState().clearWorkspace();
    onTestFinished(() => { start.mockRestore(); sessions.mockRestore(); useAgentPanelStore.getState().clearWorkspace(); });
    const { router } = await renderResidentProjectFixture();
    const launcher = await screen.findByRole("button", { name: "助手" });
    await waitFor(() => expect(launcher).toBeEnabled());
    await userEvent.click(launcher);
    expect(useAgentPanelStore.getState().open).toBe(true);
    const assistant = await screen.findByRole("heading", { name: "DSH 助手" });
    const panel = within(assistant.closest(".agent-workspace-panel")! as HTMLElement);
    const main = document.querySelector(".workspace-content-main")!;
    await waitFor(() => expect(panel.getByRole("button", { name: "新建会话" })).toBeEnabled());
    expect(main).toHaveAttribute("inert");
    await userEvent.click(panel.getByRole("button", { name: "关闭助手" }));
    expect(main).not.toHaveAttribute("inert");
    expect(launcher).toBeEnabled();
    await userEvent.click(launcher);
    await act(() => router.navigate("/projects/2?view=overview"));
    await waitFor(() => expect(useAgentPanelStore.getState().binding?.scope).toEqual({ kind: "project", projectId: 2 }));
    await waitFor(() => expect(sessions).toHaveBeenCalledWith(2));
    await userEvent.click(panel.getByRole("button", { name: "关闭助手" }));
    expect(main).not.toHaveAttribute("inert");
    expect(document.querySelector('[data-project-resident-id="2"]')).toHaveAttribute("data-project-resident-active", "true");
    const activeLauncher = within(document.querySelector('[data-project-resident-id="2"] .agent-launcher')! as HTMLElement);
    expect(activeLauncher.getByRole("button", { name: "助手" })).toBeEnabled();
  });

  it("keeps five Project overviews resident while preserving all opened content shells", async () => {
    const { router, projectA } = await renderResidentProjectFixture();
    for (const projectId of [2, 3, 4, 5]) {
      await act(() => router.navigate(`/projects/${projectId}`));
      await waitFor(() =>
        expect(document.querySelector(`[data-project-resident-id="${projectId}"]`)).toHaveAttribute(
          "data-project-resident-active",
          "true",
        ),
      );
    }
    await waitFor(() => expect(screen.getAllByTestId("project-overview-focus-page")).toHaveLength(5));
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
      expect(screen.getAllByTestId("project-overview-focus-page")).toHaveLength(5);
      expect(document.querySelector('[data-project-resident-id="2"]')).toBeInTheDocument();
      expect(document.querySelector('[data-project-resident-id="2"] [data-testid="project-overview-focus-page"]')).toBeNull();
    });
    expect(document.querySelector('[data-project-resident-id="1"]')).toBe(projectA);

    // Keyboard focus reveals the close button without relying on jsdom hover CSS.
    const closeProject = screen.getByRole("button", { name: "关闭 Project 3" });
    act(() => closeProject.focus());
    await userEvent.setup().keyboard("{Enter}");
    await waitFor(() => expect(document.querySelector('[data-project-resident-id="3"]')).toBeNull());

    expect(projectMindApi.projectPageGet).not.toHaveBeenCalled();
    expect(projectMindApi.projectTagSettingsGet).not.toHaveBeenCalled();
  }, 15_000);

  it("retains opened Project content shells and Record editors across six project switches without refetching", async () => {
    const { router } = await renderResidentProjectFixture(true);
    await waitFor(() => expect(document.querySelector('[data-focus-page-key="7:70"] input[placeholder="记录标题"]')).toBeEnabled());
    act(() => useAgentPanelStore.getState().setRunBusy("/tmp/workspace", 7, true));
    for (const projectId of [8, 9, 10, 11, 12]) {
      const recordId = projectId * 10;
      await act(() => router.navigate(`/projects/${projectId}/records/${recordId}`));
      await waitFor(() =>
        expect(document.querySelector(`[data-focus-page-key="${projectId}:${recordId}"]`)).not.toBeNull(),
      );
      await waitFor(() => expect(document.querySelector(`[data-focus-page-key="${projectId}:${recordId}"] input[placeholder="记录标题"]`)).toBeEnabled());
    }
    expect(document.querySelectorAll("[data-project-resident-id]")).toHaveLength(12);
    expect(document.querySelectorAll('[data-project-resident-id] [data-content-object^="record:"]')).toHaveLength(6);
    expect(document.querySelector('[data-focus-page-key="7:70"]')).toBeInTheDocument();
    await act(() => router.navigate("/projects/7/records/70"));
    await waitFor(() => expect(document.querySelector('[data-focus-page-key="7:70"]')).toBeVisible());
    expect(within(document.querySelector('[data-project-resident-id="7"] .project-content__pane-tabs')! as HTMLElement).getByRole("tab", { name: "Record 7" })).toHaveAttribute("aria-selected", "true");
    expect(projectMindApi.projectPageGet).not.toHaveBeenCalled();
    expect(projectMindApi.projectTagSettingsGet).not.toHaveBeenCalled();
    expect(useAgentPanelStore.getState().runningBinding?.scope).toEqual({ kind: "project", projectId: 7 });
  }, 15_000);
  it.each(["project", "workspace"] as const)("retains a hidden Record and its Project when the %s close guard fails, without blocking another Project", async target => {
    const { router, coordinator, projectA } = await renderResidentProjectFixture(true);
    await waitFor(() => expect(document.querySelector('[data-focus-page-key="7:70"] input[placeholder="记录标题"]')).toBeEnabled());
    const recordPage = document.querySelector('[data-focus-page-key="7:70"]');
    await act(() => router.navigate("/projects/8/records/80"));
    await waitFor(() => expect(document.querySelector('[data-focus-page-key="8:80"] input[placeholder="记录标题"]')).toBeEnabled());
    await coordinator.flush();
    const flush = coordinator.flush.bind(coordinator);
    vi.spyOn(coordinator, "flush").mockImplementation(async key => {
      if (key === projectRecordSaveKey(7, 70)) throw new Error("Project 7 保存失败");
      return flush(key);
    });
    fireEvent.click(screen.getByRole("button", { name: target === "project" ? "关闭 Project 7" : "切换 Workspace" }));
    expect(await screen.findByText(target === "project" ? "项目内容尚不能关闭" : "切换 Workspace 失败")).toBeInTheDocument();
    expect(projectMindApi.workspaceClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-project-resident-id="7"]')).toBe(projectA);
    expect(document.querySelector('[data-focus-page-key="7:70"]')).toBe(recordPage);
    expect(recordPage).not.toBeVisible();
    expect(router.state.location.pathname).toBe("/projects/8/records/80");
    expect(screen.getByRole("tab", { name: "Project 7" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭 Project 8" }));
    await waitFor(() => expect(screen.queryByRole("tab", { name: "Project 8" })).not.toBeInTheDocument());
    expect(screen.getByRole("tab", { name: "Project 7" })).toBeInTheDocument();
    expect(document.querySelector('[data-focus-page-key="7:70"]')).toBe(recordPage);
  }, 15_000);

  it.each(["project", "content"] as const)("keeps a newly selected Project when its earlier %s tab finishes closing", async target => {
    const { router, coordinator } = await renderResidentProjectFixture(true);
    await waitFor(() => expect(document.querySelector('[data-focus-page-key="7:70"] input[placeholder="记录标题"]')).toBeEnabled());
    let finish!: () => void;
    const closing = new Promise<void>(resolve => { finish = resolve; });
    const flush = coordinator.flush.bind(coordinator);
    const pending = vi.spyOn(coordinator, "flush").mockImplementation(async key => {
      if (key === projectRecordSaveKey(7, 70)) await closing;
      return flush(key);
    });
    try {
      fireEvent.click(screen.getByRole("button", { name: target === "project" ? "关闭 Project 7" : "关闭Record 7" }));
      await waitFor(() => expect(pending).toHaveBeenCalledWith(projectRecordSaveKey(7, 70)));
      await act(() => router.navigate("/projects/8"));
      await act(async () => { finish(); await closing; });
      await waitFor(() => expect(document.querySelector('[data-focus-page-key="7:70"]')).toBeNull());
      if (target === "project") expect(document.querySelector('[data-project-resident-id="7"]')).toBeNull();
      expect(router.state.location.pathname).toBe("/projects/8");
      expect(document.querySelector('[data-project-resident-id="8"]')).toHaveAttribute("data-project-resident-active", "true");
    } finally { finish(); }
  }, 15_000);

  it.each([
    ["/projects/1/records/999", "/workspace"],
    ["/workspace/records/999", "/projects/2"],
  ])("allows navigation from a missing Record at %s to %s", async (initialRoute, destination) => {
    const projects = [1, 2].map((id) => ({
      id, name: id === 1 ? "Alpha" : "Beta", kind: "normal" as const,
      status: "active", rootPath: `/tmp/project-${id}`, quickNote: "",
      isArchived: false, createdAt: "", updatedAt: "", openTodoCount: 0,
    }));
    const page = { records: [], projectDocuments: [], unfinishedTodos: [], finishedTodos: [] };
    vi.mocked(projectMindApi.projectsList).mockResolvedValue(projects);
    vi.mocked(projectMindApi.projectPageGet).mockImplementation(async ({ projectId }) => ({
      ...page, project: projects.find((project) => project.id === projectId)!,
    }));
    vi.mocked(projectMindApi.workspacePageGet).mockResolvedValue({ ...page, quickNote: null });
    useUiStore.setState({ openProjectIds: [1, 2] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(queryKeys.projects.all, projects);
    for (const project of projects) {
      client.setQueryData(queryKeys.projectPage(project.id), { ...page, project });
      client.setQueryData(queryKeys.projectTags.project(project.id), { tags: [] });
    }
    client.setQueryData(queryKeys.workspacePage, { ...page, quickNote: null });
    client.setQueryData(queryKeys.projectTags.workspace, { tags: [] });
    const persist = vi.fn();
    const coordinator = new RecordSaveCoordinator({ workspaceKey: "/tmp/workspace", adapter: { persist } });
    const router = createMemoryRouter([{
      path: "/", element: <WorkspaceLayout cacheProjectOverviewPages recordSaveCoordinator={coordinator} />,
      children: [
        { path: "projects/:projectId/records/:noteId", element: <div /> },
        { path: "workspace/records/:noteId", element: <div /> },
        { path: "projects/:projectId", element: <div /> },
        { path: "workspace", element: <div /> },
      ],
    }], { initialEntries: [initialRoute] });
    render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
    await screen.findByText("记录未找到");
    fireEvent.click(screen.getByRole("tab", { name: destination === "/workspace" ? "Workspace" : "Beta" }));
    await waitFor(() => expect(router.state.navigation.state).toBe("idle"));
    expect(router.state.location.pathname).toBe(destination);
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    ["/projects/1/records/7", PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT, false],
    ["/workspace/records/7", WORKSPACE_RECORD_FOCUS_SAVE_REQUEST_EVENT, false],
    ["/projects/1/records/7", PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT, null],
  ])("keeps %s when %s responds %s", async (initialRoute, eventName, response) => {
    const router = createMemoryRouter([{
      path: "/", element: <WorkspaceLayout />,
      children: [
        { path: "projects/:projectId/records/:noteId", element: <div>loaded record</div> },
        { path: "workspace/records/:noteId", element: <div>loaded record</div> },
        { path: "workspace", element: <div>workspace overview</div> },
      ],
    }], { initialEntries: [initialRoute] });
    const handleSave = (event: Event) => {
      (event as CustomEvent<{ respond: (submitted: boolean) => void }>).detail.respond(false);
    };
    if (response !== null) window.addEventListener(eventName, handleSave);
    try {
      render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
      await screen.findByText("loaded record");
      await act(() => router.navigate("/workspace"));
      expect(router.state.location.pathname).toBe(initialRoute);
    } finally {
      window.removeEventListener(eventName, handleSave);
    }
  });
});
