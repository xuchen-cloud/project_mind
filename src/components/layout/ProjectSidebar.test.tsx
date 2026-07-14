import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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

  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("ProjectSidebar", () => {
  beforeEach(() => {
    documentMutationMocks.documentMetaMutation.mutate.mockReset();
    documentMutationMocks.documentAddVersionMutation.mutate.mockReset();
    documentMutationMocks.documentAddVersionMutation.mutateAsync.mockReset();
    documentMutationMocks.documentDeleteMutation.mutate.mockReset();
    desktopApiMocks.pickFiles.mockReset();
    desktopApiMocks.openFile.mockReset();
    desktopApiMocks.revealInExplorer.mockReset();
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
