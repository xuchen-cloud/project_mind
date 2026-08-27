import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  NoteRecord,
  ProjectPageData,
  ProjectRecord,
  WorkspacePageData,
  WorkspaceRecord,
} from "../../lib/types";
import { queryKeys } from "../../lib/queryKeys";
import { RecordSaveCoordinator } from "../../lib/record-save-coordinator";
import { RecordSaveCoordinatorProvider } from "../../lib/record-save-runtime";
import { RecordFocusResidentPages } from "../record/RecordFocusResidentPages";
import { WorkspaceRecordFocusPage } from "./WorkspaceRecordFocusPage";

const apiMocks = vi.hoisted(() => ({
  workspacePageGet: vi.fn(),
  projectsList: vi.fn(),
  workspaceStatusGet: vi.fn(),
  projectTagSettingsGet: vi.fn(),
  projectTagUpsert: vi.fn(),
  workspaceRecordUpsert: vi.fn(),
  workspaceRecordMetadataApply: vi.fn(),
  aiSettingsGet: vi.fn(),
  projectPageGet: vi.fn(),
  projectRecordUpsert: vi.fn(),
}));

const aiMetadataMocks = vi.hoisted(() => ({
  enqueueAndWait: vi.fn(),
}));

vi.mock("../../lib/aiJobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/aiJobs")>()),
  enqueueAndWait: aiMetadataMocks.enqueueAndWait,
}));

const recordExportMocks = vi.hoisted(() => ({
  sources: [] as Array<{ committedHtml: string; recordKind: string }>,
  editorValue: "正文 A[AI preview]",
  committedValue: "正文 A",
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: apiMocks,
}));

vi.mock("../../features/record-export/desktopRecordExportPlatform", () => ({
  createDesktopRecordExporter: (saveCommittedContent: () => Promise<{ committedHtml: string; recordKind: string }>) =>
    async () => {
      recordExportMocks.sources.push(await saveCommittedContent());
      return { kind: "success", path: "/tmp/export.pdf", warnings: [], fontSubstituted: false };
    },
}));

vi.mock("../../features/record-export/RecordExportAction", () => ({
  RecordExportAction: ({ exportTo }: { exportTo: (request: object) => Promise<unknown> }) => (
    <button type="button" onClick={() => void exportTo({ format: "pdf", targetPath: "/tmp/export.pdf" })}>
      测试导出
    </button>
  ),
}));

vi.mock("../../services/desktopApi", () => ({
  desktopApi: {
    focusProjectWindow: vi.fn(async () => false),
    openProjectWindow: vi.fn(async () => undefined),
  },
}));

vi.mock("../../hooks/useContactMentionOptions", () => ({
  useContactMentionOptions: () => ({}),
}));

vi.mock("../../hooks/useContactMentionNavigation", () => ({
  useContactMentionNavigation: () => vi.fn(),
}));

vi.mock("../../hooks/useInternalReferenceNavigation", () => ({
  useInternalReferenceNavigation: () => vi.fn(),
}));

vi.mock("../../hooks/useProjectMutations", () => ({
  useProjectMutations: () => ({
    createProjectMutation: { isPending: false, mutateAsync: vi.fn(async () => undefined) },
    archiveMutation: { mutate: vi.fn() },
    deleteProjectMutation: { mutate: vi.fn() },
  }),
}));

vi.mock("../../state/feedback-store", () => ({
  useFeedbackStore: () => ({
    pushToast: vi.fn(),
  }),
}));

vi.mock("../../state/ui-store", () => ({
  useUiStore: () => ({
    openSettings: vi.fn(),
    pageWidthMode: "adaptive",
    projectRecentPaths: {},
    openProjectIds: [],
    closeProjectTab: vi.fn(),
    projectSidebarCollapsed: false,
    todoRailCollapsed: true,
  }),
}));

vi.mock("../../todo", () => ({
  TodoModuleRail: ({ enabled }: { enabled?: boolean }) => (
    <div data-testid="todo-module-rail" data-enabled={enabled === false ? "false" : "true"} />
  ),
}));

vi.mock("./WorkspaceOverviewSidebar", () => ({
  WorkspaceOverviewSidebar: ({ onOpenRecord }: { onOpenRecord: (recordId: number) => void }) => (
    <button type="button" onClick={() => onOpenRecord(8)}>
      Open record 8
    </button>
  ),
}));

vi.mock("../rich-editor/noteImageAssets", () => ({
  buildWorkspaceNoteImageAssetHandlers: () => undefined,
  buildProjectNoteImageAssetHandlers: () => undefined,
  externalizeEmbeddedImageDataUrls: vi.fn(async (value) => value),
}));

vi.mock("../rich-editor", () => ({
  getRenderableRichTextHtml: ({ html, markdown }: { html?: string; markdown?: string }) =>
    html ?? (markdown ? `<p>${markdown}</p>` : ""),
  normalizeRichEditorValue: (value: { html: string; text: string; markdown: string }) => value,
  RichEditor: ({
    html,
    controllerRef,
  }: {
    html?: string;
    controllerRef?: {
      current: {
        getValue: () => { html: string; text: string; markdown: string };
        getCommittedValue: () => { html: string; text: string; markdown: string };
        focus: () => void;
        save: () => Promise<unknown>;
      } | null;
    };
  }) => {
    const [value] = useState(toPlainText(html ?? ""));
    const valueRef = useRef(value);
    valueRef.current = value;

    useEffect(() => {
      if (!controllerRef) return;

      controllerRef.current = {
        getValue: () => buildMockRichValue(recordExportMocks.editorValue),
        getCommittedValue: () => buildMockRichValue(recordExportMocks.committedValue),
        focus: vi.fn(),
        save: vi.fn(),
      };

      return () => {
        controllerRef.current = null;
      };
    }, [controllerRef]);

    return <textarea aria-label="正文编辑器" value={value} readOnly />;
  },
}));

const noteA: WorkspaceRecord = {
  id: 7,
  title: "A",
  contentMarkdown: "正文 A",
  contentHtml: "<p>正文 A</p>",
  tags: [],
  createdAt: "",
  updatedAt: "",
};

const noteB: WorkspaceRecord = {
  id: 8,
  title: "B",
  contentMarkdown: "正文 B",
  contentHtml: "<p>正文 B</p>",
  tags: [],
  createdAt: "",
  updatedAt: "",
};

const noteC: WorkspaceRecord = {
  id: 9,
  title: "C",
  contentMarkdown: "正文 C",
  contentHtml: "<p>正文 C</p>",
  tags: [],
  createdAt: "",
  updatedAt: "",
};

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location-display">{location.pathname}</div>;
}

function renderPage(ui: ReactElement, queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/workspace/records/7"]}>
        <Routes>
          <Route path="/workspace/records/:noteId" element={ui} />
        </Routes>
        <LocationDisplay />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function ResidentWorkspaceFocusHarness() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate("/workspace/records/7")}>打开 Workspace 记录 A</button>
      <button type="button" onClick={() => navigate("/workspace/records/8")}>打开 Workspace 记录 B</button>
      <button type="button" onClick={() => navigate("/workspace/records/9")}>打开 Workspace 记录 C</button>
      <RecordFocusResidentPages workspaceKey="/tmp/workspace" />
    </>
  );
}

function CrossScopeFocusHarness() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate("/workspace/records/7")}>打开 Workspace Focus</button>
      <button type="button" onClick={() => navigate("/projects/1/records/70")}>打开 Project Focus</button>
      <RecordFocusResidentPages workspaceKey="/tmp/workspace" />
    </>
  );
}

function buildWorkspacePage(): WorkspacePageData {
  return {
    quickNote: null,
    records: [noteA, noteB, noteC],
    unfinishedTodos: [],
    finishedTodos: [],
  };
}

function buildMockRichValue(value: string) {
  return {
    html: `<p>${value}</p>`,
    text: value,
    markdown: value,
  };
}

function toPlainText(html: string) {
  return html.replace(/<[^>]+>/gu, "");
}

describe("WorkspaceRecordFocusPage record switching", () => {
  beforeEach(() => {
    recordExportMocks.sources.length = 0;
    recordExportMocks.editorValue = "正文 A[AI preview]";
    recordExportMocks.committedValue = "正文 A";
    apiMocks.workspacePageGet.mockReset();
    apiMocks.projectsList.mockReset();
    apiMocks.workspaceStatusGet.mockReset();
    apiMocks.projectTagSettingsGet.mockReset();
    apiMocks.projectTagUpsert.mockReset();
    apiMocks.workspaceRecordUpsert.mockReset();
    apiMocks.workspaceRecordMetadataApply.mockReset();
    apiMocks.aiSettingsGet.mockReset();
    apiMocks.projectPageGet.mockReset();
    apiMocks.projectRecordUpsert.mockReset();
    aiMetadataMocks.enqueueAndWait.mockReset();

    apiMocks.workspacePageGet.mockResolvedValue(buildWorkspacePage());
    apiMocks.projectsList.mockResolvedValue([]);
    apiMocks.workspaceStatusGet.mockResolvedValue({
      currentWorkspace: { rootPath: "/tmp/workspace", displayName: "workspace" },
      recentWorkspaces: [],
      aiSecretsUnlocked: true,
    });
    apiMocks.projectTagSettingsGet.mockResolvedValue({ tags: [] });
    apiMocks.aiSettingsGet.mockResolvedValue(null);
    apiMocks.projectRecordUpsert.mockResolvedValue({});
    apiMocks.projectTagUpsert.mockImplementation(async ({ label }: { label: string }) => ({
      id: 22,
      label,
      colorKey: "blue",
      usageCount: 0,
      createdAt: "",
      updatedAt: "",
    }));
    apiMocks.workspaceRecordUpsert.mockImplementation(async (input: Partial<WorkspaceRecord>) => ({
      ...(input.noteId === 8 ? noteB : noteA),
      title: input.title,
      contentMarkdown: input.markdown ?? "",
      contentHtml: input.html ?? "",
    }));
    apiMocks.workspaceRecordMetadataApply.mockImplementation(async (input: {
      title: string;
      tagIds: number[];
      newTags: Array<{ label: string }>;
    }) => ({
      ...noteA,
      title: input.title,
      tags: [
        ...input.tagIds.map((id) => ({ id, label: `Tag ${id}`, colorKey: "blue" as const })),
        ...input.newTags.map((tag, index) => ({ id: 30 + index, label: tag.label, colorKey: "teal" as const })),
      ],
    }));
  });

  it("hands a cold record from one static skeleton to ready content", async () => {
    vi.useFakeTimers();
    let resolvePage!: (value: WorkspacePageData) => void;
    apiMocks.workspacePageGet.mockImplementationOnce(() => new Promise((resolve) => { resolvePage = resolve; }));
    const view = renderPage(<WorkspaceRecordFocusPage />);

    expect(screen.queryByRole("status", { name: "正在加载工作区记录" })).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(119));
    expect(screen.queryByRole("status", { name: "正在加载工作区记录" })).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole("status", { name: "正在加载工作区记录" })).toHaveAttribute("data-variant", "record");
    expect(view.container.querySelector(".animate-spin, .spin")).toBeNull();

    vi.useRealTimers();
    await act(async () => resolvePage(buildWorkspacePage()));
    expect(await screen.findByLabelText("正文编辑器")).toHaveValue("正文 A");
    expect(screen.queryByRole("status", { name: "正在加载工作区记录" })).not.toBeInTheDocument();
    expect(view.container.querySelector(".page-cold-entry")).toHaveAttribute("data-cold-entry", "true");
  });

  it("renders a cached record synchronously without a cold entrance", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.workspacePage, buildWorkspacePage());
    queryClient.setQueryData(queryKeys.projects.all, []);
    queryClient.setQueryData(queryKeys.workspaceStatus, { currentWorkspace: { rootPath: "/tmp/workspace", displayName: "workspace" }, recentWorkspaces: [], aiSecretsUnlocked: true });
    const view = renderPage(<WorkspaceRecordFocusPage />, queryClient);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByLabelText("正文编辑器")).toHaveValue("正文 A");
    expect(view.container.querySelector(".page-cold-entry")).not.toHaveAttribute("data-cold-entry");
  });

  it("offers AI title and Tag filling in a Workspace Record", async () => {
    renderPage(<WorkspaceRecordFocusPage />);

    expect(
      await screen.findByRole("button", { name: "AI 填写标题和标签" }),
    ).toBeEnabled();
  });

  it("applies AI metadata through the Workspace Record atomic save path", async () => {
    apiMocks.aiSettingsGet.mockResolvedValue({
      profiles: [],
      bindings: [],
      hasUsableDefault: true,
      hasUsableImageDefault: false,
      securityMode: "workspace",
      aiSecretsUnlocked: true,
      execution: { maxConcurrency: 1 },
      editorSkills: [],
    });
    apiMocks.projectTagSettingsGet.mockResolvedValue({
      tags: [{ id: 12, label: "长期方法", colorKey: "teal", usageCount: 2, createdAt: "", updatedAt: "" }],
    });
    aiMetadataMocks.enqueueAndWait.mockResolvedValue({
      id: 9,
      kind: "record_metadata",
      targetKey: "record-ai-metadata:workspace:7",
      status: "succeeded",
      queuedAt: "",
      result: {
        kind: "record_metadata",
        metadata: { title: "Workspace 方法总结", existingTagIds: [12], newTags: ["复盘"] },
      },
    });
    renderPage(<WorkspaceRecordFocusPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "AI 填写标题和标签" }));

    await waitFor(() => expect(apiMocks.workspaceRecordMetadataApply).toHaveBeenCalledWith({
      noteId: 7,
      title: "Workspace 方法总结",
      tagIds: [12],
      newTags: [{ label: "复盘", colorKey: expect.any(String) }],
    }));
    expect(aiMetadataMocks.enqueueAndWait).toHaveBeenCalledWith(expect.objectContaining({
      kind: "record_metadata",
      input: expect.objectContaining({ markdown: "正文 A" }),
    }));
    expect(screen.getByDisplayValue("Workspace 方法总结")).toBeInTheDocument();
  });

  it("exports the Workspace Record from committed content and excludes pending AI preview", async () => {
    const user = userEvent.setup();
    renderPage(<WorkspaceRecordFocusPage />);

    await screen.findByDisplayValue("A");
    await user.click(screen.getByRole("button", { name: "测试导出" }));

    await waitFor(() => expect(recordExportMocks.sources).toHaveLength(1));
    expect(recordExportMocks.sources[0]).toMatchObject({
      recordKind: "workspace",
      committedHtml: "<p>正文 A</p>",
    });
    expect(recordExportMocks.sources[0]?.committedHtml).not.toContain("AI preview");
  });

  it("leaves persistence to the route coordinator when navigating to another record", async () => {
    const user = userEvent.setup();
    renderPage(<WorkspaceRecordFocusPage />);

    await screen.findByDisplayValue("A");
    await user.click(screen.getByRole("button", { name: "Open record 8" }));

    expect(screen.getByTestId("location-display")).toHaveTextContent("/workspace/records/8");
    expect(apiMocks.workspaceRecordUpsert).not.toHaveBeenCalled();
  });

  it("reuses the two most recent Workspace Record Focus editors without another workspace-page request", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.workspacePage, buildWorkspacePage());
    queryClient.setQueryData(queryKeys.projects.all, []);
    queryClient.setQueryData(queryKeys.workspaceStatus, {
      currentWorkspace: { rootPath: "/tmp/workspace", displayName: "workspace" },
      recentWorkspaces: [],
      aiSecretsUnlocked: true,
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/workspace/records/7"]}>
          <Routes>
            <Route
              path="/workspace/records/:noteId"
              element={<ResidentWorkspaceFocusHarness />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const editorA = await screen.findByDisplayValue("正文 A");
    expect(apiMocks.workspacePageGet).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "打开 Workspace 记录 B" }));
    const editorB = await screen.findByDisplayValue("正文 B");
    expect(document.querySelectorAll("[data-record-focus-resident-key]")).toHaveLength(2);
    expect(
      editorA.closest("[data-record-focus-resident-key]")?.querySelector(
        '[data-testid="todo-module-rail"]',
      ),
    ).toHaveAttribute("data-enabled", "false");

    await user.click(screen.getByRole("button", { name: "打开 Workspace 记录 A" }));
    expect(await screen.findByDisplayValue("正文 A")).toBe(editorA);
    expect(apiMocks.workspacePageGet).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "打开 Workspace 记录 C" }));
    expect(await screen.findByDisplayValue("正文 C")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-record-focus-resident-key]")).toHaveLength(2);
    expect(editorB).not.toBeInTheDocument();
  });

  it("shares the two-editor residency limit between Workspace and Project Record Focus", async () => {
    const user = userEvent.setup();
    const project: ProjectRecord = {
      id: 1,
      name: "Alpha",
      kind: "normal",
      status: "active",
      rootPath: "/tmp/alpha",
      quickNote: "",
      isArchived: false,
      createdAt: "",
      updatedAt: "",
    };
    const projectNote: NoteRecord = {
      id: 70,
      projectId: 1,
      title: "Project Record",
      contentMarkdown: "Project 正文",
      contentHtml: "<p>Project 正文</p>",
      tags: [],
      createdAt: "",
      updatedAt: "",
    };
    const projectPage: ProjectPageData = {
      project,
      records: [projectNote],
      unfinishedTodos: [],
      finishedTodos: [],
      projectDocuments: [],
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.workspacePage, buildWorkspacePage());
    queryClient.setQueryData(queryKeys.workspaceStatus, {
      currentWorkspace: { rootPath: "/tmp/workspace", displayName: "workspace" },
      recentWorkspaces: [],
      aiSecretsUnlocked: true,
    });
    queryClient.setQueryData(queryKeys.projects.all, [project]);
    queryClient.setQueryData(queryKeys.projectPage(1), projectPage);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/workspace/records/7"]}>
          <Routes>
            <Route path="*" element={<CrossScopeFocusHarness />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const workspaceEditor = await screen.findByDisplayValue("正文 A");
    await user.click(screen.getByRole("button", { name: "打开 Project Focus" }));
    await screen.findByDisplayValue("Project 正文");
    await user.click(screen.getByRole("button", { name: "打开 Workspace Focus" }));

    expect(await screen.findByDisplayValue("正文 A")).toBe(workspaceEditor);
    expect(document.querySelectorAll("[data-record-focus-resident-key]")).toHaveLength(2);
    expect(apiMocks.workspacePageGet).not.toHaveBeenCalled();
    expect(apiMocks.projectPageGet).not.toHaveBeenCalled();
  });

  it("does not overwrite an initialized Workspace Record draft after Query cache refresh", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.workspacePage, buildWorkspacePage());

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/workspace/records/7"]}>
          <Routes>
            <Route
              path="/workspace/records/:noteId"
              element={<WorkspaceRecordFocusPage />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const title = screen.getByPlaceholderText("记录标题");
    await user.clear(title);
    await user.type(title, "Workspace 本地标题");
    queryClient.setQueryData<WorkspacePageData>(queryKeys.workspacePage, {
      ...buildWorkspacePage(),
      records: [
        { ...noteA, title: "后台刷新标题", contentMarkdown: "后台正文", contentHtml: "<p>后台正文</p>" },
        noteB,
        noteC,
      ],
    });

    expect(title).toHaveValue("Workspace 本地标题");
    expect(screen.getByDisplayValue("正文 A")).toBeInTheDocument();
  });

  it("initializes from a failed Workspace save snapshot before stale Query data", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.workspacePage, buildWorkspacePage());
    const coordinator = new RecordSaveCoordinator({
      workspaceKey: "/tmp/workspace",
      adapter: { persist: vi.fn(async () => { throw new Error("save failed"); }) },
    });
    coordinator.submit({
      scope: "workspace",
      workspaceKey: "/tmp/workspace",
      recordId: 7,
      title: "失败快照标题",
      tagIds: [],
      defaultCodeLanguage: "typescript",
      committedContent: buildMockRichValue("失败快照最新正文"),
    });
    await vi.waitFor(() => {
      expect(coordinator.getRecordStatus("workspace:7").phase).toBe("error");
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RecordSaveCoordinatorProvider coordinator={coordinator}>
          <MemoryRouter initialEntries={["/workspace/records/7"]}>
            <Routes>
              <Route path="/workspace/records/:noteId" element={<WorkspaceRecordFocusPage />} />
            </Routes>
          </MemoryRouter>
        </RecordSaveCoordinatorProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByPlaceholderText("记录标题")).toHaveValue("失败快照标题");
    expect(screen.getByDisplayValue("失败快照最新正文")).toBeInTheDocument();
    expect(apiMocks.workspacePageGet).not.toHaveBeenCalled();
  });
});
