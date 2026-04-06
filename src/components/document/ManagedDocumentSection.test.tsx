import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DocumentRecord } from "../../lib/types";

const documentMutationMocks = vi.hoisted(() => ({
  documentImportMutation: { mutate: vi.fn(), isPending: false },
  documentMetaMutation: { mutate: vi.fn(), isPending: false },
  documentRelocateMutation: { mutate: vi.fn(), isPending: false },
  documentAddVersionMutation: { mutate: vi.fn(), isPending: false },
}));

const desktopApiMocks = vi.hoisted(() => ({
  pickFile: vi.fn<(input?: unknown) => Promise<string | null>>(async () => null),
  openFile: vi.fn(async () => undefined),
  openFolder: vi.fn(async () => undefined),
  revealInExplorer: vi.fn(async () => undefined),
}));

vi.mock("../../hooks/useDocumentMutations", () => ({
  useDocumentMutations: () => documentMutationMocks,
}));

vi.mock("../../services/desktopApi", () => ({
  desktopApi: {
    pickFile: desktopApiMocks.pickFile,
    openFile: desktopApiMocks.openFile,
    openFolder: desktopApiMocks.openFolder,
    revealInExplorer: desktopApiMocks.revealInExplorer,
  },
}));

import { ManagedDocumentSection } from "./ManagedDocumentSection";

describe("ManagedDocumentSection", () => {
  beforeEach(() => {
    documentMutationMocks.documentImportMutation.mutate.mockReset();
    documentMutationMocks.documentMetaMutation.mutate.mockReset();
    documentMutationMocks.documentRelocateMutation.mutate.mockReset();
    documentMutationMocks.documentAddVersionMutation.mutate.mockReset();
    desktopApiMocks.pickFile.mockReset();
    desktopApiMocks.openFile.mockReset();
    desktopApiMocks.openFolder.mockReset();
    desktopApiMocks.revealInExplorer.mockReset();

    desktopApiMocks.pickFile.mockResolvedValue(null);
    desktopApiMocks.openFile.mockResolvedValue(undefined);
    desktopApiMocks.openFolder.mockResolvedValue(undefined);
    desktopApiMocks.revealInExplorer.mockResolvedValue(undefined);
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

  it("imports a file without legacy role or project visibility fields", async () => {
    const user = userEvent.setup();
    desktopApiMocks.pickFile.mockResolvedValueOnce("/tmp/project/brief.pdf");

    renderSection([]);

    await user.click(screen.getByRole("button", { name: "导入文件" }));

    expect(documentMutationMocks.documentImportMutation.mutate).toHaveBeenCalledWith({
      projectId: 1,
      sourcePath: "/tmp/project/brief.pdf",
      isStarred: false,
    });
  });

  it("only exposes the star action on each card", async () => {
    const user = userEvent.setup();

    renderSection([
      buildDocument({
        id: 7,
        isStarred: false,
      }),
    ]);

    const documentCard = document.getElementById("document-7");
    expect(documentCard).not.toBeNull();

    expect(within(documentCard as HTMLElement).queryByRole("button", { name: "更多操作" })).not.toBeInTheDocument();

    await user.click(within(documentCard as HTMLElement).getByRole("button", { name: "标星" }));

    expect(documentMutationMocks.documentMetaMutation.mutate).toHaveBeenCalledWith({
      documentId: 7,
      isStarred: true,
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
    createdAt: partial.createdAt ?? "2026-04-06T08:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-04-06T09:00:00.000Z",
  };
}
