import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DocumentRecord, DocumentVersionRecord, ProjectTagRecord } from "../../lib/types";

const documentMutationMocks = vi.hoisted(() => ({
  documentImportMutation: { mutate: vi.fn(), isPending: false },
  documentMetaMutation: { mutate: vi.fn(), isPending: false },
  documentRelocateMutation: { mutate: vi.fn(), isPending: false },
  documentAddVersionMutation: { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false },
  documentDeleteMutation: { mutate: vi.fn(), isPending: false },
}));

const desktopApiMocks = vi.hoisted(() => ({
  pickFile: vi.fn<(input?: unknown) => Promise<string | null>>(async () => null),
  pickFiles: vi.fn<(input?: unknown) => Promise<string[]>>(async () => []),
  openFile: vi.fn(async () => undefined),
  openFolder: vi.fn(async () => undefined),
  revealInExplorer: vi.fn(async () => undefined),
}));

const projectMindApiMocks = vi.hoisted(() => ({
  projectTagSettingsGet: vi.fn(async () => ({ tags: [] as ProjectTagRecord[] })),
  documentImport: vi.fn(async () => ({ id: 1 })),
  documentListVersions: vi.fn<(input: { documentId: number }) => Promise<DocumentVersionRecord[]>>(
    async () => [],
  ),
}));

const uiStoreMocks = vi.hoisted(() => ({
  openSettings: vi.fn(),
}));

vi.mock("../../hooks/useDocumentMutations", () => ({
  useDocumentMutations: () => documentMutationMocks,
}));

vi.mock("../../services/desktopApi", () => ({
  desktopApi: {
    pickFile: desktopApiMocks.pickFile,
    pickFiles: desktopApiMocks.pickFiles,
    openFile: desktopApiMocks.openFile,
    openFolder: desktopApiMocks.openFolder,
    revealInExplorer: desktopApiMocks.revealInExplorer,
  },
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: {
    projectTagSettingsGet: projectMindApiMocks.projectTagSettingsGet,
    documentImport: projectMindApiMocks.documentImport,
    documentListVersions: projectMindApiMocks.documentListVersions,
  },
}));

vi.mock("../../state/ui-store", () => ({
  useUiStore: (selector: (state: { openSettings: typeof uiStoreMocks.openSettings }) => unknown) =>
    selector({
      openSettings: uiStoreMocks.openSettings,
    }),
}));

import { ManagedDocumentSection } from "./ManagedDocumentSection";

describe("ManagedDocumentSection", () => {
  beforeEach(() => {
    documentMutationMocks.documentImportMutation.mutate.mockReset();
    documentMutationMocks.documentMetaMutation.mutate.mockReset();
    documentMutationMocks.documentRelocateMutation.mutate.mockReset();
    documentMutationMocks.documentAddVersionMutation.mutate.mockReset();
    documentMutationMocks.documentAddVersionMutation.mutateAsync.mockReset();
    documentMutationMocks.documentDeleteMutation.mutate.mockReset();
    desktopApiMocks.pickFile.mockReset();
    desktopApiMocks.pickFiles.mockReset();
    desktopApiMocks.openFile.mockReset();
    desktopApiMocks.openFolder.mockReset();
    desktopApiMocks.revealInExplorer.mockReset();
    projectMindApiMocks.projectTagSettingsGet.mockReset();
    projectMindApiMocks.documentImport.mockReset();
    projectMindApiMocks.documentListVersions.mockReset();
    uiStoreMocks.openSettings.mockReset();

    desktopApiMocks.pickFile.mockResolvedValue(null);
    desktopApiMocks.pickFiles.mockResolvedValue([]);
    desktopApiMocks.openFile.mockResolvedValue(undefined);
    desktopApiMocks.openFolder.mockResolvedValue(undefined);
    desktopApiMocks.revealInExplorer.mockResolvedValue(undefined);
    documentMutationMocks.documentAddVersionMutation.mutateAsync.mockResolvedValue(buildDocument());
    projectMindApiMocks.projectTagSettingsGet.mockResolvedValue({ tags: [] });
    projectMindApiMocks.documentImport.mockResolvedValue(buildDocument());
    projectMindApiMocks.documentListVersions.mockResolvedValue([]);
  });

  it("does not show a version badge for single-version documents", () => {
    renderSection([buildDocument({ versionCount: 1, currentVersionNumber: 1 })]);

    expect(screen.queryByText("v1")).not.toBeInTheDocument();
  });

  it("shows the current version badge without extra action buttons", () => {
    renderSection([
      buildDocument({
        id: 7,
        name: "Roadmap_v3.pdf",
        baseName: "Roadmap.pdf",
        currentVersionNumber: 3,
        versionCount: 3,
      }),
    ]);

    expect(screen.getByText("v3")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更多操作" })).not.toBeInTheDocument();
  });

  it("opens the version dropdown from the version badge and opens a historical version", async () => {
    const user = userEvent.setup();
    projectMindApiMocks.documentListVersions.mockResolvedValueOnce([
      {
        id: 102,
        documentId: 7,
        versionNumber: 2,
        name: "Roadmap_v2.pdf",
        sourcePath: "/tmp/original/Roadmap.pdf",
        managedPath: "/tmp/project/Roadmap_v2.pdf",
        createdAt: "2026-04-06T10:00:00.000Z",
      },
      {
        id: 101,
        documentId: 7,
        versionNumber: 1,
        name: "Roadmap.pdf",
        sourcePath: "/tmp/original/Roadmap.pdf",
        managedPath: "/tmp/project/.7.pm-versions/Roadmap.pdf",
        createdAt: "2026-04-06T09:00:00.000Z",
      },
    ]);

    renderSection([
      buildDocument({
        id: 7,
        name: "Roadmap_v2.pdf",
        baseName: "Roadmap.pdf",
        currentVersionNumber: 2,
        versionCount: 2,
      }),
    ]);

    await user.click(screen.getByRole("button", { name: "选择 Roadmap.pdf 的版本" }));

    expect(await screen.findByRole("menu", { name: "Roadmap.pdf 版本列表" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "版本历史 · Roadmap.pdf" })).not.toBeInTheDocument();
    expect(projectMindApiMocks.documentListVersions).toHaveBeenCalledWith({ documentId: 7 });

    await user.click(screen.getByRole("menuitemradio", { name: /v1/i }));

    expect(desktopApiMocks.openFile).toHaveBeenCalledWith("/tmp/project/.7.pm-versions/Roadmap.pdf");
  });

  it("sorts starred documents before unstarred ones, then by updated time", () => {
    const { container } = renderSection([
      buildDocument({
        id: 1,
        baseName: "Older starred.pdf",
        isStarred: true,
        updatedAt: "2026-04-06T08:00:00.000Z",
      }),
      buildDocument({
        id: 2,
        baseName: "Newest starred.pdf",
        isStarred: true,
        updatedAt: "2026-04-06T10:00:00.000Z",
      }),
      buildDocument({
        id: 3,
        baseName: "Newest plain.pdf",
        isStarred: false,
        updatedAt: "2026-04-06T11:00:00.000Z",
      }),
    ]);

    expect(
      Array.from(container.querySelectorAll("[id^='document-']")).map((node) => node.id),
    ).toEqual(["document-2", "document-1", "document-3"]);
  });

  it("opens the file when clicking the row body", async () => {
    renderSection([
      buildDocument({
        id: 9,
        baseName: "Spec brief.pdf",
        managedPath: "/tmp/project/Spec brief.pdf",
      }),
    ]);

    const documentRow = document.getElementById("document-9");
    expect(documentRow).not.toBeNull();

    fireEvent.click(documentRow as HTMLElement);

    await waitFor(() => {
      expect(desktopApiMocks.openFile).toHaveBeenCalledWith("/tmp/project/Spec brief.pdf");
    });
  });

  it("supports inline rename by double-clicking the file name", async () => {
    const user = userEvent.setup();

    renderSection([
      buildDocument({
        id: 5,
        name: "Weekly_sync_v2.pdf",
        baseName: "Weekly_sync.pdf",
        currentVersionNumber: 2,
        versionCount: 2,
      }),
    ]);

    await user.dblClick(screen.getByText("Weekly_sync.pdf"));
    const input = screen.getByDisplayValue("Weekly_sync.pdf");

    await user.clear(input);
    await user.type(input, "Renamed brief.pdf");
    await user.keyboard("{Enter}");

    expect(documentMutationMocks.documentMetaMutation.mutate).toHaveBeenCalledWith({
      documentId: 5,
      baseName: "Renamed brief.pdf",
    });
  });

  it("renders tag dots on the card without showing the tag names inside the card body", async () => {
    projectMindApiMocks.projectTagSettingsGet.mockResolvedValue({
      tags: [buildProjectTag({ id: 1, label: "法务", colorKey: "blue" })],
    });

    renderSection([
      buildDocument({
        id: 13,
        tags: [buildDocumentTag({ id: 1, label: "法务", colorKey: "blue" })],
      }),
    ]);

    const documentCard = await screen.findByRole("button", { name: /项目标签：法务/ });
    expect(within(documentCard).queryByText("法务")).not.toBeInTheDocument();
    expect(documentCard.querySelector(".rounded-full")).not.toBeNull();
  });

  it("filters documents with OR logic across multiple selected tags", async () => {
    projectMindApiMocks.projectTagSettingsGet.mockResolvedValue({
      tags: [
        buildProjectTag({ id: 1, label: "法务", colorKey: "blue" }),
        buildProjectTag({ id: 2, label: "紧急", colorKey: "red" }),
      ],
    });

    const user = userEvent.setup();

    renderSection([
      buildDocument({
        id: 1,
        baseName: "合同审阅.pdf",
        tags: [buildDocumentTag({ id: 1, label: "法务", colorKey: "blue" })],
      }),
      buildDocument({
        id: 2,
        baseName: "风险说明.pdf",
        tags: [buildDocumentTag({ id: 2, label: "紧急", colorKey: "red" })],
      }),
      buildDocument({
        id: 3,
        baseName: "周报.pdf",
        tags: [],
      }),
    ]);

    const allFilterButton = await screen.findByRole("button", { name: "全部" });
    const filterBar = allFilterButton.parentElement?.parentElement as HTMLElement;

    await user.click(within(filterBar).getByRole("button", { name: /法务/ }));
    expect(screen.getByText("合同审阅.pdf")).toBeInTheDocument();
    expect(screen.queryByText("风险说明.pdf")).not.toBeInTheDocument();
    expect(screen.queryByText("周报.pdf")).not.toBeInTheDocument();

    await user.click(within(filterBar).getByRole("button", { name: /紧急/ }));
    expect(screen.getByText("合同审阅.pdf")).toBeInTheDocument();
    expect(screen.getByText("风险说明.pdf")).toBeInTheDocument();
    expect(screen.queryByText("周报.pdf")).not.toBeInTheDocument();

    await user.click(within(filterBar).getByRole("button", { name: "全部" }));
    expect(screen.getByText("周报.pdf")).toBeInTheDocument();
  });

  it("imports selected files without legacy role or project visibility fields", async () => {
    const user = userEvent.setup();
    desktopApiMocks.pickFiles.mockResolvedValueOnce([
      "/tmp/project/brief.pdf",
      "/tmp/project/notes.docx",
    ]);

    renderSection([]);

    await user.click(screen.getByRole("button", { name: "导入文件" }));

    await waitFor(() => {
      expect(projectMindApiMocks.documentImport).toHaveBeenNthCalledWith(1, {
        projectId: 1,
        sourcePath: "/tmp/project/brief.pdf",
        isStarred: false,
      });
      expect(projectMindApiMocks.documentImport).toHaveBeenNthCalledWith(2, {
        projectId: 1,
        sourcePath: "/tmp/project/notes.docx",
        isStarred: false,
      });
    });
  });

  it("imports dropped windows file uris using native windows paths", async () => {
    const { container } = renderSection([]);
    const dropTarget = container.querySelector("[class~='grid'][class~='gap-4'] > div");

    expect(dropTarget).not.toBeNull();

    fireEvent.drop(dropTarget as HTMLElement, {
      dataTransfer: {
        files: [],
        getData: (type: string) =>
          type === "text/uri-list"
            ? "file:///C:/Users/demo/brief.pdf\nfile://server/share/notes.docx"
            : "",
      },
    });

    await waitFor(() => {
      expect(projectMindApiMocks.documentImport).toHaveBeenNthCalledWith(1, {
        projectId: 1,
        sourcePath: "C:\\Users\\demo\\brief.pdf",
        isStarred: false,
      });
      expect(projectMindApiMocks.documentImport).toHaveBeenNthCalledWith(2, {
        projectId: 1,
        sourcePath: "\\\\server\\share\\notes.docx",
        isStarred: false,
      });
    });
  });

  it("only exposes the star action in the context menu", async () => {
    const user = userEvent.setup();

    renderSection([
      buildDocument({
        id: 7,
        isStarred: false,
      }),
    ]);

    const documentCard = document.getElementById("document-7");
    expect(documentCard).not.toBeNull();

    expect(within(documentCard as HTMLElement).queryByRole("button", { name: "标星" })).not.toBeInTheDocument();

    fireEvent.contextMenu(documentCard as HTMLElement);
    await user.click(screen.getByRole("menuitem", { name: "标星" }));

    expect(documentMutationMocks.documentMetaMutation.mutate).toHaveBeenCalledWith({
      documentId: 7,
      isStarred: true,
    });
  });

  it("starts inline rename from the context menu", async () => {
    const user = userEvent.setup();

    renderSection([
      buildDocument({
        id: 24,
        baseName: "Context rename.pdf",
      }),
    ]);

    fireEvent.contextMenu(document.getElementById("document-24") as HTMLElement);
    await user.click(screen.getByRole("menuitem", { name: "重命名" }));

    const input = await screen.findByDisplayValue("Context rename.pdf");
    await user.clear(input);
    await user.type(input, "Renamed from menu.pdf{Enter}");

    expect(documentMutationMocks.documentMetaMutation.mutate).toHaveBeenCalledWith({
      documentId: 24,
      baseName: "Renamed from menu.pdf",
    });
  });

  it("prevents native text selection on right mouse down before opening the context menu", async () => {
    renderSection([
      buildDocument({
        id: 8,
        baseName: "Context target.pdf",
      }),
    ]);

    const documentCard = document.getElementById("document-8");
    expect(documentCard).not.toBeNull();

    const mouseDownEvent = new MouseEvent("mousedown", {
      button: 2,
      bubbles: true,
      cancelable: true,
    });

    (documentCard as HTMLElement).dispatchEvent(mouseDownEvent);

    expect(mouseDownEvent.defaultPrevented).toBe(true);

    fireEvent.contextMenu(documentCard as HTMLElement);

    expect(await screen.findByRole("menu", { name: "文件操作" })).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Context target.pdf")).not.toBeInTheDocument();
  });

  it("shows ordered document actions and reveals the file location from the context menu", async () => {
    const user = userEvent.setup();

    renderSection([
      buildDocument({
        id: 21,
        baseName: "Spec brief.pdf",
        managedPath: "/tmp/project/Spec brief.pdf",
      }),
    ]);

    fireEvent.contextMenu(document.getElementById("document-21") as HTMLElement);

    expect(screen.getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
      "打开文件所在位置",
      "重命名",
      "复制为新版本并打开",
      "标星",
      "删除",
    ]);

    await user.click(screen.getByRole("menuitem", { name: "打开文件所在位置" }));

    expect(desktopApiMocks.revealInExplorer).toHaveBeenCalledWith("/tmp/project/Spec brief.pdf");
  });

  it("duplicates the current version, adds the new version, and opens the new managed file", async () => {
    const user = userEvent.setup();
    documentMutationMocks.documentAddVersionMutation.mutateAsync.mockResolvedValueOnce(
      buildDocument({
        id: 22,
        baseName: "Spec brief.pdf",
        managedPath: "/tmp/project/Spec brief_v2.pdf",
        currentVersionNumber: 2,
        versionCount: 2,
      }),
    );

    renderSection([
      buildDocument({
        id: 22,
        baseName: "Spec brief.pdf",
      }),
    ]);

    fireEvent.contextMenu(document.getElementById("document-22") as HTMLElement);
    await user.click(screen.getByRole("menuitem", { name: "复制为新版本并打开" }));

    expect(documentMutationMocks.documentAddVersionMutation.mutateAsync).toHaveBeenCalledWith({
      documentId: 22,
    });

    await waitFor(() => {
      expect(desktopApiMocks.openFile).toHaveBeenCalledWith("/tmp/project/Spec brief_v2.pdf");
    });
  });

  it("deletes a document from the context menu without confirmation", async () => {
    const user = userEvent.setup();

    renderSection([
      buildDocument({
        id: 23,
        baseName: "Delete me.pdf",
      }),
    ]);

    fireEvent.contextMenu(document.getElementById("document-23") as HTMLElement);
    await user.click(screen.getByRole("menuitem", { name: "删除" }));

    expect(documentMutationMocks.documentDeleteMutation.mutate).toHaveBeenCalledWith({
      documentId: 23,
    });
  });

  it("disables locate and add-version actions for missing files while keeping delete available", () => {
    renderSection([
      buildDocument({
        id: 25,
        baseName: "Missing brief.pdf",
        health: "missing",
      }),
    ]);

    fireEvent.contextMenu(document.getElementById("document-25") as HTMLElement);

    expect(screen.getByRole("menuitem", { name: "打开文件所在位置" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "重命名" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "复制为新版本并打开" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "删除" })).toBeEnabled();
  });

  it("does not enter rename mode for missing files on double click", async () => {
    const user = userEvent.setup();

    renderSection([
      buildDocument({
        id: 26,
        baseName: "Missing inline.pdf",
        health: "missing",
      }),
    ]);

    await user.dblClick(screen.getByText("Missing inline.pdf"));

    expect(screen.queryByDisplayValue("Missing inline.pdf")).not.toBeInTheDocument();
    expect(documentMutationMocks.documentMetaMutation.mutate).not.toHaveBeenCalled();
  });

  it("opens an import tag dialog when workspace tags exist and applies selected tag ids to every file", async () => {
    projectMindApiMocks.projectTagSettingsGet.mockResolvedValue({
      tags: [buildProjectTag({ id: 3, label: "待审核", colorKey: "amber" })],
    });
    desktopApiMocks.pickFiles.mockResolvedValueOnce([
      "/tmp/project/brief.pdf",
      "/tmp/project/notes.docx",
    ]);

    const user = userEvent.setup();
    renderSection([]);

    await user.click(await screen.findByRole("button", { name: "导入文件" }));
    expect(await screen.findByRole("dialog", { name: "选择导入标签" })).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("#输入或选择标签"), "待审核");
    await user.click(screen.getByRole("button", { name: "待审核" }));
    await user.click(screen.getByRole("button", { name: "开始导入" }));

    await waitFor(() => {
      expect(projectMindApiMocks.documentImport).toHaveBeenNthCalledWith(1, {
        projectId: 1,
        sourcePath: "/tmp/project/brief.pdf",
        isStarred: false,
        tagIds: [3],
      });
      expect(projectMindApiMocks.documentImport).toHaveBeenNthCalledWith(2, {
        projectId: 1,
        sourcePath: "/tmp/project/notes.docx",
        isStarred: false,
        tagIds: [3],
      });
    });
  });
});

function renderSection(documents: DocumentRecord[]) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ManagedDocumentSection
        projectId={1}
        projectRootPath="/tmp/project"
        documents={documents}
        layout="grid"
      />
    </QueryClientProvider>,
  );
}

function buildDocument(partial: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: partial.id ?? 1,
    projectId: partial.projectId ?? 1,
    activityId: partial.activityId ?? null,
    name: partial.name ?? "Roadmap.pdf",
    baseName: partial.baseName ?? "Roadmap.pdf",
    originalPath: partial.originalPath ?? "/tmp/original/Roadmap.pdf",
    managedPath: partial.managedPath ?? "/tmp/project/Roadmap.pdf",
    historyDirPath: partial.historyDirPath ?? "/tmp/project/.1.pm-versions",
    storageMode: partial.storageMode ?? "managed_copy",
    mimeType: partial.mimeType ?? "application/pdf",
    isStarred: partial.isStarred ?? false,
    currentVersionNumber: partial.currentVersionNumber ?? 1,
    versionCount: partial.versionCount ?? 1,
    sourceActivityTitle: partial.sourceActivityTitle ?? null,
    health: partial.health ?? "normal",
    tags: partial.tags ?? [],
    createdAt: partial.createdAt ?? "2026-04-06T08:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-04-06T09:00:00.000Z",
  };
}

function buildDocumentTag(
  partial: Partial<DocumentRecord["tags"][number]> = {},
): DocumentRecord["tags"][number] {
  return {
    id: partial.id ?? 1,
    label: partial.label ?? "法务",
    colorKey: partial.colorKey ?? "blue",
  };
}

function buildProjectTag(partial: Partial<ProjectTagRecord> = {}): ProjectTagRecord {
  return {
    id: partial.id ?? 1,
    label: partial.label ?? "法务",
    colorKey: partial.colorKey ?? "blue",
    usageCount: partial.usageCount ?? 0,
    createdAt: partial.createdAt ?? "2026-04-06T08:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-04-06T08:00:00.000Z",
  };
}
