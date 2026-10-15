import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { queryKeys } from "../../lib/queryKeys";
import { closeFilePreview, useFilePreviewStore } from "../../state/file-preview-store";
import type { DocumentRecord, ProjectTagRecord } from "../../lib/types";
import { createUiStoreState, useUiStore } from "../../state/ui-store";
import { ProjectSidebar } from "./ProjectSidebar";

const documentMutationMocks = vi.hoisted(() => ({
  documentMetaMutation: { mutate: vi.fn(), isPending: false },
  documentAddVersionMutation: { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false },
  documentDeleteMutation: { mutate: vi.fn(), isPending: false },
}));

const desktopApiMocks = vi.hoisted(() => ({
  pickFiles: vi.fn<(input?: unknown) => Promise<string[]>>(async () => []),
  openFile: vi.fn(async () => undefined),
  revealInExplorer: vi.fn(async () => undefined),
}));

const projectMindApiMocks = vi.hoisted(() => ({
  documentListVersions: vi.fn(async () => []),
  projectTagSettingsGet: vi.fn(async () => ({ tags: [] as ProjectTagRecord[] })),
  documentImport: vi.fn(async ({ projectId, sourcePath }: { projectId: number; sourcePath: string }) =>
    buildDocument({ projectId, name: sourcePath.split("/").pop() ?? "brief.pdf", baseName: sourcePath.split("/").pop() ?? "brief.pdf" }),
  ),
}));

vi.mock("../../hooks/useDocumentMutations", () => ({
  useDocumentMutations: () => documentMutationMocks,
}));

vi.mock("../../services/desktopApi", () => ({
  desktopApi: {
    pickFiles: desktopApiMocks.pickFiles,
    openFile: desktopApiMocks.openFile,
    revealInExplorer: desktopApiMocks.revealInExplorer,
  },
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: {
    projectTagSettingsGet: projectMindApiMocks.projectTagSettingsGet,
    documentListVersions: projectMindApiMocks.documentListVersions,
    documentImport: projectMindApiMocks.documentImport,
  },
}));

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  queryClient.setQueryData(queryKeys.workspaceStatus, { currentWorkspace: { rootPath: "/tmp/workspace" } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("ProjectSidebar", () => {
  it("keeps the tree toggle and file import together in the title row in either presentation", async () => {
    const view = renderWithProviders(<ProjectSidebar filesOnly resident fileFilter={{ query: "", tagId: null }}
      fileHeaderActions={<button type="button">文件树展示</button>} fileContent={<div>文件树内容</div>}
      project={{ id: 1, name: "Alpha", rootPath: "/project" }} documents={[]} onOpenProject={vi.fn()} />);
    const add = screen.getByRole("button", { name: "导入文件" });
    const toggle = screen.getByRole("button", { name: "文件树展示" });
    expect(add.closest(".home-side__heading")).toContainElement(screen.getByRole("heading", { name: "文件" }));
    expect(add.parentElement?.lastElementChild).toBe(add);
    expect(add.parentElement).toContainElement(toggle);
    fireEvent.click(add);
    await waitFor(() => expect(desktopApiMocks.pickFiles).toHaveBeenCalledOnce());
    expect(screen.getByText("文件树内容")).toBeVisible();
    view.unmount();
  });

  it("uses the shared query and tag without a second search input and keeps file actions", async () => {
    const documents = [
      buildDocument({ id: 1, name: "交付.pdf", baseName: "交付.pdf", tags: [{ id: 7, label: "交付", colorKey: "blue" }] }),
      buildDocument({ id: 2, name: "预算.pdf", baseName: "预算.pdf" }),
    ];
    const view = renderWithProviders(<ProjectSidebar filesOnly resident fileFilter={{ query: "交付", tagId: 7 }}
      project={{ id: 1, name: "Alpha", rootPath: "/project" }} documents={documents} onOpenProject={vi.fn()} />);
    expect(screen.queryByRole("textbox", { name: "搜索文件" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入文件" })).toBeInTheDocument();
    const list = screen.getByRole("region", { name: "项目文件列表" });
    expect(list).toHaveTextContent("交付.pdf");
    expect(list).not.toHaveTextContent("预算.pdf");
    view.unmount();
    renderWithProviders(<ProjectSidebar filesOnly resident fileFilter={{ query: "", tagId: null }}
      project={{ id: 1, name: "Alpha", rootPath: "/project" }} documents={documents} onOpenProject={vi.fn()} />);
    expect(screen.getByRole("region", { name: "项目文件列表" })).toHaveTextContent("预算.pdf");
  });
  beforeEach(() => {
    closeFilePreview();
    documentMutationMocks.documentMetaMutation.mutate.mockReset();
    documentMutationMocks.documentAddVersionMutation.mutate.mockReset();
    documentMutationMocks.documentAddVersionMutation.mutateAsync.mockReset();
    documentMutationMocks.documentDeleteMutation.mutate.mockReset();
    desktopApiMocks.pickFiles.mockReset();
    desktopApiMocks.openFile.mockReset();
    desktopApiMocks.revealInExplorer.mockReset();
    projectMindApiMocks.documentListVersions.mockReset();
    projectMindApiMocks.documentListVersions.mockResolvedValue([]);
    projectMindApiMocks.projectTagSettingsGet.mockReset();
    projectMindApiMocks.documentImport.mockReset();

    desktopApiMocks.pickFiles.mockResolvedValue([]);
    desktopApiMocks.openFile.mockResolvedValue(undefined);
    desktopApiMocks.revealInExplorer.mockResolvedValue(undefined);
    projectMindApiMocks.projectTagSettingsGet.mockResolvedValue({ tags: [] });
    projectMindApiMocks.documentImport.mockImplementation(
      async ({ projectId, sourcePath }: { projectId: number; sourcePath: string }) =>
        buildDocument({
          projectId,
          name: sourcePath.split("/").pop() ?? "brief.pdf",
          baseName: sourcePath.split("/").pop() ?? "brief.pdf",
          managedPath: sourcePath,
          originalPath: sourcePath,
        }),
    );

    useUiStore.setState(createUiStoreState());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("places voice creation before text creation and invokes each independently", () => {
    const onCreateVoiceRecord = vi.fn();
    const onCreateRecord = vi.fn();
    renderWithProviders(<ProjectSidebar project={{ id: 1, name: "Alpha", rootPath: "/project" }}
      onOpenProject={vi.fn()} onCreateRecord={onCreateRecord} onCreateVoiceRecord={onCreateVoiceRecord} />);
    const voice = screen.getByRole("button", { name: "新增语音记录" });
    const text = screen.getByRole("button", { name: "新增记录" });
    expect(voice).toHaveAttribute("title", "新增语音记录");
    expect(voice.nextElementSibling).toBe(text);
    expect(voice).toBeEnabled();
    fireEvent.click(voice);
    expect(onCreateVoiceRecord).toHaveBeenCalledOnce();
    expect(onCreateRecord).not.toHaveBeenCalled();
    fireEvent.click(text);
    expect(onCreateRecord).toHaveBeenCalledOnce();
    expect(onCreateVoiceRecord).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("tab", { name: "文件" }));
    expect(screen.queryByRole("button", { name: "新增语音记录" })).not.toBeInTheDocument();
  });

  it("disables only voice creation while pending", () => {
    const onCreateVoiceRecord = vi.fn();
    const onCreateRecord = vi.fn();
    renderWithProviders(<ProjectSidebar project={{ id: 1, name: "Alpha", rootPath: "/project" }}
      onOpenProject={vi.fn()} onCreateRecord={onCreateRecord} onCreateVoiceRecord={onCreateVoiceRecord} creatingVoiceRecord />);
    const voice = screen.getByRole("button", { name: "新增语音记录" });
    expect(voice).toBeDisabled();
    fireEvent.click(voice);
    expect(onCreateVoiceRecord).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "新增记录" }));
    expect(onCreateRecord).toHaveBeenCalledOnce();
  });

  it("hides voice creation when no callback is supplied", () => {
    renderWithProviders(<ProjectSidebar project={{ id: 1, name: "Alpha", rootPath: "/project" }} onOpenProject={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "新增语音记录" })).not.toBeInTheDocument();
  });

  it("selects only the focused file and hides visible tags while preserving filtering and management", async () => {
    const documents = [
      buildDocument({ id: 41, name: "交付.pdf", baseName: "交付.pdf", tags: [{ id: 7, label: "交付", colorKey: "blue" }] }),
      buildDocument({ id: 42, name: "预算.pdf", baseName: "预算.pdf" }),
    ];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const component = (activeFileId: number | null, tagId: number | null = null) => <QueryClientProvider client={client}>
      <ProjectSidebar filesOnly resident fileFilter={{ query: "", tagId }} activeFileId={activeFileId}
        project={{ id: 1, name: "Alpha", rootPath: "/project" }} documents={documents} onOpenProject={vi.fn()} />
    </QueryClientProvider>;
    const view = render(component(41));
    const list = screen.getByRole("region", { name: "项目文件列表" });
    const delivery = within(list).getByRole("button", { name: /^交付.pdf/ });
    const budget = within(list).getByRole("button", { name: /^预算.pdf/ });
    expect(delivery).toHaveClass("is-active");
    expect(budget).not.toHaveClass("is-active");
    expect(within(list).queryByText("交付", { exact: true })).toBeNull();
    view.rerender(component(42));
    expect(delivery).not.toHaveClass("is-active");
    expect(budget).toHaveClass("is-active");
    view.rerender(component(null, 7));
    expect(within(list).queryByRole("button", { name: /^预算.pdf/ })).toBeNull();
    expect(within(list).getByRole("button", { name: /^交付.pdf/ })).not.toHaveClass("is-active");
    fireEvent.contextMenu(delivery);
    expect(await screen.findByPlaceholderText("新增标签")).toBeInTheDocument();
  });

  it("portals the file menu outside transformed ancestors and clamps its measured dimensions", async () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("aria-label") === "文件操作"
        ? { width: 240, height: 210, left: 0, top: 0, right: 240, bottom: 210, x: 0, y: 0, toJSON() {} }
        : originalRect.call(this);
    });
    try {
      const view = renderWithProviders(<div style={{ transform: "translateX(120px)" }}><ProjectSidebar filesOnly resident
        project={{ id: 1, name: "Alpha", rootPath: "/project" }} documents={[buildDocument({ id: 41 })]} onOpenProject={vi.fn()} /></div>);
      fireEvent.contextMenu(screen.getByRole("button", { name: /^brief.pdf/ }), { clientX: window.innerWidth - 10, clientY: window.innerHeight - 10 });
      const menu = await screen.findByRole("menu", { name: "文件操作" });
      expect(menu.parentElement).toBe(document.body);
      expect(view.container).not.toContainElement(menu);
      expect(menu).toHaveStyle({ left: `${window.innerWidth - 252}px`, top: `${window.innerHeight - 222}px` });
      expect(await within(menu).findByPlaceholderText("新增标签")).toBeInTheDocument();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(menu).not.toBeInTheDocument();
    } finally { rect.mockRestore(); }
  });

  it("chooses a sidebar file version without also opening the latest file", async () => {
    const document = buildDocument({ id: 29, name: "brief.pdf", baseName: "brief.pdf", currentVersionNumber: 2, versionCount: 2 });
    const versions = [2, 1].map(versionNumber => ({ id: versionNumber, documentId: 29, versionNumber, name: "brief.pdf", sourcePath: "/source", managedPath: "/managed", createdAt: "2026-10-15T10:00:00Z" }));
    projectMindApiMocks.documentListVersions.mockResolvedValue(versions as never);
    renderWithProviders(<ProjectSidebar filesOnly project={{ id: 1, name: "Alpha", rootPath: "/tmp/project" }} documents={[document]} onOpenProject={() => undefined} />);
    expect(projectMindApiMocks.documentListVersions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "选择 brief.pdf 的版本" }));
    const menu = await screen.findByRole("menu");
    const old = await within(menu).findByRole("menuitemradio", {name:"v1",exact:true});
    expect(within(menu).getByRole("menuitem", {name:"查看历史与比较"})).toBeVisible();
    expect(useFilePreviewStore.getState().request).toBeNull();
    fireEvent.click(old);
    await waitFor(() => expect(useFilePreviewStore.getState().request).toMatchObject({ documentId:29, versionNumber:1 }));
    expect(desktopApiMocks.openFile).not.toHaveBeenCalled();
  });

  it("opens an HTML file from the existing file rail without invoking the desktop opener", async () => {
    const html = buildDocument({ id: 29, name: "report.htm", baseName: "report.htm", mimeType: "text/html" });
    const onOpenDocument = vi.fn();
    renderWithProviders(<ProjectSidebar filesOnly project={{ id: 1, name: "Alpha", rootPath: "/tmp/project" }} documents={[html]} onOpenProject={() => undefined} onOpenDocument={onOpenDocument} />);
    fireEvent.click(screen.getByText("report.htm"));
    await waitFor(() => expect(useFilePreviewStore.getState().request).toEqual({ workspaceRoot: "/tmp/workspace", projectId: 1, documentId: 29, title: "report.htm" }));
    expect(desktopApiMocks.openFile).not.toHaveBeenCalled();
    expect(onOpenDocument).not.toHaveBeenCalled();
    closeFilePreview();
    screen.getByRole("button", { name: "report.htm", exact: true }).focus();
    await userEvent.setup().keyboard("{Enter}");
    await waitFor(() => expect(useFilePreviewStore.getState().request?.documentId).toBe(29));
    expect(onOpenDocument).not.toHaveBeenCalled();
  });

  it("opens the project overview, navigates records, and toggles collapse", async () => {
    const user = userEvent.setup();
    const onOpenProject = vi.fn();
    const onOpenRecord = vi.fn();
    const onCreateRecord = vi.fn();

    renderWithProviders(
      <ProjectSidebar
        project={{
          id: 1,
          name: "Alpha Project",
          rootPath: "/tmp/alpha-project",
          isArchived: false,
        }}
        records={[
          {
            id: 11,
            title: "Kickoff Review",
            typeLabel: "会议记录",
            contentMarkdown: "记录内容",
            tags: [{ id: 1, label: "产品评审", colorKey: "blue" as const }],
            updatedAt: "2026-04-06T08:00:00.000Z",
          },
          {
            id: 12,
            title: "Budget Sync",
            typeLabel: "同步记录",
            contentMarkdown: "预算同步",
            tags: [],
            updatedAt: "2026-04-06T09:00:00.000Z",
          },
        ]}
        activeRecordId={11}
        onOpenProject={onOpenProject}
        onOpenRecord={onOpenRecord}
        onCreateRecord={onCreateRecord}
      />,
    );

    expect(screen.getByText("Alpha Project")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "记录" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Kickoff Review")).toBeInTheDocument();
    expect(screen.getAllByText("产品评审")).toHaveLength(2);

    await user.click(screen.getByText("Alpha Project").closest("button")!);
    expect(onOpenProject).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "新增记录" }));
    expect(onCreateRecord).toHaveBeenCalledTimes(1);

    await user.click(screen.getByText("Budget Sync").closest("button")!);
    expect(onOpenRecord).toHaveBeenCalledWith(12);

    await user.click(screen.getByRole("button", { name: "收起项目侧边栏" }));
    expect(useUiStore.getState().projectSidebarCollapsed).toBe(true);
    expect(
      screen.getByRole("button", { name: "展开项目侧边栏" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Budget Sync")).not.toBeInTheDocument();

    expect(screen.getByRole("button", { name: "展开项目侧边栏" })).toBeInTheDocument();
  });

  it("imports files from the picker in the files tab", async () => {
    const user = userEvent.setup();
    desktopApiMocks.pickFiles.mockResolvedValueOnce(["/tmp/alpha-project/brief.pdf"]);

    renderWithProviders(
      <ProjectSidebar
        project={{
          id: 1,
          name: "Alpha Project",
          rootPath: "/tmp/alpha-project",
          isArchived: false,
        }}
        records={[]}
        documents={[]}
        onOpenProject={vi.fn()}
        onOpenRecord={vi.fn()}
        onCreateRecord={vi.fn()}
        onOpenDocument={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "文件" }));
    await user.click(screen.getByRole("button", { name: "导入文件" }));

    await waitFor(() => {
      expect(projectMindApiMocks.documentImport).toHaveBeenCalledWith({
        projectId: 1,
        sourcePath: "/tmp/alpha-project/brief.pdf",
        isStarred: false,
      });
    });
  });

  it("imports dropped files from the sidebar and switches to the files tab", async () => {
    const dataTransfer = createFileDrop("/tmp/alpha-project/brief.pdf");

    renderWithProviders(
      <ProjectSidebar
        project={{
          id: 1,
          name: "Alpha Project",
          rootPath: "/tmp/alpha-project",
          isArchived: false,
        }}
        records={[
          {
            id: 11,
            title: "Kickoff Review",
            typeLabel: "会议记录",
            contentMarkdown: "记录内容",
            tags: [],
            updatedAt: "2026-04-06T08:00:00.000Z",
          },
        ]}
        documents={[]}
        onOpenProject={vi.fn()}
        onOpenRecord={vi.fn()}
        onCreateRecord={vi.fn()}
        onOpenDocument={vi.fn()}
      />,
    );

    const sidebar = screen.getByLabelText("项目导航侧边栏");
    fireEvent.dragEnter(sidebar, { dataTransfer });

    expect(screen.getByRole("tab", { name: "文件" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("松手即可导入文件")).toBeInTheDocument();

    fireEvent.drop(sidebar, { dataTransfer });

    await waitFor(() => {
      expect(projectMindApiMocks.documentImport).toHaveBeenCalledWith({
        projectId: 1,
        sourcePath: "/tmp/alpha-project/brief.pdf",
        isStarred: false,
      });
    });
  });

  it("does not hide the drag prompt on a transient drag leave", () => {
    vi.useFakeTimers();
    const dataTransfer = createFileDrop("/tmp/alpha-project/brief.pdf");

    renderWithProviders(
      <ProjectSidebar
        project={{
          id: 1,
          name: "Alpha Project",
          rootPath: "/tmp/alpha-project",
          isArchived: false,
        }}
        records={[]}
        documents={[]}
        onOpenProject={vi.fn()}
        onOpenRecord={vi.fn()}
        onCreateRecord={vi.fn()}
        onOpenDocument={vi.fn()}
      />,
    );

    const sidebar = screen.getByLabelText("项目导航侧边栏");
    fireEvent.dragEnter(sidebar, { dataTransfer });
    expect(screen.getByText("松手即可导入文件")).toBeInTheDocument();

    fireEvent.dragLeave(sidebar, {
      clientX: -1,
      clientY: -1,
      dataTransfer,
    });
    fireEvent.dragEnter(sidebar, { dataTransfer });
    vi.advanceTimersByTime(100);

    expect(screen.getByText("松手即可导入文件")).toBeInTheDocument();
  });

  it("shows add actions beside search and hides tab counts", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <ProjectSidebar
        project={{
          id: 1,
          name: "Alpha Project",
          rootPath: "/tmp/alpha-project",
          isArchived: false,
        }}
        records={[
          {
            id: 11,
            title: "Kickoff Review",
            typeLabel: "会议记录",
            contentMarkdown: "记录内容",
            tags: [],
            updatedAt: "2026-04-06T08:00:00.000Z",
          },
        ]}
        documents={[
          {
            id: 21,
            projectId: 1,
            name: "budget.xlsx",
            baseName: "budget",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            managedPath: "/tmp/alpha-project/budget.xlsx",
            originalPath: "/original/budget.xlsx",
            historyDirPath: "/history/budget",
            isStarred: false,
            currentVersionNumber: 1,
            versionCount: 1,
            health: "normal",
            tags: [],
          },
        ]}
        onOpenProject={vi.fn()}
        onOpenRecord={vi.fn()}
        onCreateRecord={vi.fn()}
        onOpenDocument={vi.fn()}
      />,
    );

    expect(screen.getByRole("tab", { name: "记录" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "文件" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /记录 1/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /文件 1/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新增记录" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "文件" }));
    expect(screen.getByRole("button", { name: "导入文件" })).toBeInTheDocument();
  });

  it("keeps the files tab across remounts and isolates file filters by project", async () => {
    const user = userEvent.setup();
    const projectOneDocument = buildDocument({
      tags: [{ id: 7, label: "预算", colorKey: "amber" }],
    });
    const renderProject = (projectId: number, documents: DocumentRecord[]) =>
      renderWithProviders(
        <ProjectSidebar
          project={{
            id: projectId,
            name: projectId === 1 ? "Alpha Project" : "Beta Project",
            rootPath: `/tmp/project-${projectId}`,
            isArchived: false,
          }}
          records={[]}
          documents={documents}
          onOpenProject={vi.fn()}
          onOpenRecord={vi.fn()}
          onCreateRecord={vi.fn()}
          onOpenDocument={vi.fn()}
        />,
      );

    const firstProject = renderProject(1, [projectOneDocument]);
    await user.click(screen.getByRole("tab", { name: "文件" }));
    await user.type(screen.getByLabelText("搜索文件"), "brief");
    await user.click(screen.getByRole("button", { name: "预算" }));

    expect(useUiStore.getState().projectFileFilters[1]).toEqual({
      query: "brief",
      tagId: 7,
    });

    firstProject.unmount();
    const secondProject = renderProject(2, [
      buildDocument({ id: 22, projectId: 2, name: "roadmap.pdf" }),
    ]);

    expect(screen.getByRole("tab", { name: "文件" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("搜索文件")).toHaveValue("");

    secondProject.unmount();
    renderProject(1, [projectOneDocument]);

    expect(screen.getByLabelText("搜索文件")).toHaveValue("brief");
    expect(useUiStore.getState().projectFileFilters[1]?.tagId).toBe(7);
  });
});

function buildDocument(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: overrides.id ?? 21,
    projectId: overrides.projectId ?? 1,
    name: overrides.name ?? "brief.pdf",
    baseName: overrides.baseName ?? "brief.pdf",
    mimeType: overrides.mimeType ?? "application/pdf",
    managedPath: overrides.managedPath ?? "/tmp/alpha-project/brief.pdf",
    originalPath: overrides.originalPath ?? "/tmp/alpha-project/brief.pdf",
    historyDirPath: overrides.historyDirPath ?? "/tmp/alpha-project/.history/brief",
    isStarred: overrides.isStarred ?? false,
    currentVersionNumber: overrides.currentVersionNumber ?? 1,
    versionCount: overrides.versionCount ?? 1,
    health: overrides.health ?? "normal",
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? "2026-04-06T08:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-06T08:00:00.000Z",
  };
}

function createFileDrop(path: string): DataTransfer {
  return {
    files: [{ path }] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: ["Files"],
    getData: vi.fn(() => ""),
  } as unknown as DataTransfer;
}
