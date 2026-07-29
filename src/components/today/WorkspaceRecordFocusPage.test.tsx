import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspacePageData, WorkspaceRecord } from "../../lib/types";
import { WorkspaceRecordFocusPage } from "./WorkspaceRecordFocusPage";

const apiMocks = vi.hoisted(() => ({
  workspacePageGet: vi.fn(),
  projectsList: vi.fn(),
  workspaceStatusGet: vi.fn(),
  projectTagSettingsGet: vi.fn(),
  projectTagUpsert: vi.fn(),
  workspaceRecordUpsert: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: apiMocks,
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

vi.mock("../../hooks/useTodoMutations", () => ({
  useTodoMutations: () => ({
    todoMutation: { mutateAsync: vi.fn(async () => undefined) },
    todoContentMutation: { mutateAsync: vi.fn(async () => undefined) },
    todoDeleteMutation: { mutateAsync: vi.fn(async () => undefined) },
    todoPriorityMutation: { mutateAsync: vi.fn(async () => undefined) },
    todoTagMutation: { mutateAsync: vi.fn(async () => undefined) },
    todoProgressMutation: { mutateAsync: vi.fn(async () => undefined) },
    todoProgressUpdateMutation: { mutateAsync: vi.fn(async () => undefined) },
    todoProgressDeleteMutation: { mutateAsync: vi.fn(async () => undefined) },
    todoStatusMutation: { mutateAsync: vi.fn(async () => undefined) },
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

vi.mock("../todo", () => ({
  TodoRail: () => null,
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
        getValue: () => buildMockRichValue(valueRef.current),
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

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location-display">{location.pathname}</div>;
}

function renderPage(ui: ReactElement) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/workspace/records/7"]}>
        <Routes>
          <Route path="/workspace/records/:noteId" element={ui} />
        </Routes>
        <LocationDisplay />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function buildWorkspacePage(): WorkspacePageData {
  return {
    quickNote: null,
    records: [noteA, noteB],
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
    apiMocks.workspacePageGet.mockReset();
    apiMocks.projectsList.mockReset();
    apiMocks.workspaceStatusGet.mockReset();
    apiMocks.projectTagSettingsGet.mockReset();
    apiMocks.projectTagUpsert.mockReset();
    apiMocks.workspaceRecordUpsert.mockReset();

    apiMocks.workspacePageGet.mockResolvedValue(buildWorkspacePage());
    apiMocks.projectsList.mockResolvedValue([]);
    apiMocks.workspaceStatusGet.mockResolvedValue({
      currentWorkspace: { rootPath: "/tmp/workspace", displayName: "workspace" },
      recentWorkspaces: [],
      aiSecretsUnlocked: true,
    });
    apiMocks.projectTagSettingsGet.mockResolvedValue({ tags: [] });
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
  });

  it("flushes the current record before navigating to another record", async () => {
    const user = userEvent.setup();
    renderPage(<WorkspaceRecordFocusPage />);

    await screen.findByDisplayValue("A");
    await user.click(screen.getByRole("button", { name: "Open record 8" }));

    await waitFor(() => {
      expect(apiMocks.workspaceRecordUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          noteId: 7,
          markdown: "正文 A",
          html: "<p>正文 A</p>",
        }),
      );
    });

    expect(apiMocks.workspaceRecordUpsert).not.toHaveBeenCalledWith(
      expect.objectContaining({
        noteId: 8,
        markdown: "正文 A",
      }),
    );
    expect(screen.getByTestId("location-display")).toHaveTextContent("/workspace/records/8");
  });
});
