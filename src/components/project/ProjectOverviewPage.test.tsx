import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectOverviewPage } from "./ProjectOverviewPage";

const scrollIntoViewMock = vi.fn();

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: {
    projectsList: vi.fn(async () => [
      {
        id: 1,
        name: "Alpha Project",
        rootPath: "/tmp/alpha-project",
        isArchived: false,
        kind: "normal",
        quickNote: "",
        quickNoteMarkdown: "",
        quickNoteHtml: "",
        status: "active",
      },
    ]),
    projectPageGet: vi.fn(async () => ({
      project: {
        id: 1,
        name: "Alpha Project",
        rootPath: "/tmp/alpha-project",
        isArchived: false,
        kind: "normal",
        quickNote: "",
        quickNoteMarkdown: "",
        quickNoteHtml: "",
        status: "active",
      },
      records: [
        {
          id: 7,
          projectId: 1,
          title: "目标记录",
          contentMarkdown: "命中记录内容",
          contentHtml: "<p>命中记录内容</p>",
          createdAt: "2026-04-06T08:00:00.000Z",
          updatedAt: "2026-04-06T09:00:00.000Z",
          tags: [{ id: 3, label: "预算", colorKey: "amber" }],
        },
      ],
      unfinishedTodos: [],
      finishedTodos: [],
      documents: [],
    })),
    fileTagSettingsGet: vi.fn(async () => ({
      tags: [{ id: 3, label: "预算", colorKey: "amber" }],
    })),
  },
}));

vi.mock("../../services/desktopApi", () => ({
  desktopApi: {
    openFolder: vi.fn(async () => undefined),
    pickFiles: vi.fn(async () => []),
  },
}));

vi.mock("../../hooks/useInternalReferenceNavigation", () => ({
  useInternalReferenceNavigation: () => vi.fn(),
}));

vi.mock("../../hooks/useContactMentionNavigation", () => ({
  useContactMentionNavigation: () => vi.fn(),
}));

vi.mock("../../hooks/useContactMentionOptions", () => ({
  useContactMentionOptions: () => [],
}));

vi.mock("../../hooks/useProjectMutations", () => ({
  useProjectMutations: () => ({
    projectUpdateMutation: { mutateAsync: vi.fn(async () => undefined) },
  }),
}));

vi.mock("../../hooks/useTodoMutations", () => ({
  useTodoMutations: () => ({
    todoMutation: { mutateAsync: vi.fn(async () => undefined) },
    todoContentMutation: { mutateAsync: vi.fn(async () => undefined) },
    todoStatusMutation: { mutateAsync: vi.fn(async () => undefined) },
    todoPriorityMutation: { mutateAsync: vi.fn(async () => undefined) },
    todoTagMutation: { mutateAsync: vi.fn(async () => undefined) },
    todoProgressMutation: { mutateAsync: vi.fn(async () => undefined) },
    todoProgressUpdateMutation: { mutateAsync: vi.fn(async () => undefined) },
    todoProgressDeleteMutation: { mutateAsync: vi.fn(async () => undefined) },
    todoDeleteMutation: { mutateAsync: vi.fn(async () => undefined) },
  }),
}));

vi.mock("../../hooks/useUtilityHooks", async () => {
  const actual = await vi.importActual<typeof import("../../hooks/useUtilityHooks")>(
    "../../hooks/useUtilityHooks",
  );
  return {
    ...actual,
  };
});

vi.mock("../rich-editor", () => ({
  getRenderableRichTextHtml: ({ html, markdown }: { html?: string; markdown?: string }) =>
    html ?? (markdown ? `<p>${markdown}</p>` : ""),
  normalizeRichEditorValue: (value: { html: string; text: string; markdown: string }) => value,
  RichEditor: ({
    html,
    readOnly,
    placeholder,
  }: {
    html?: string;
    readOnly?: boolean;
    placeholder?: string;
  }) =>
    readOnly ? (
      <div>{html}</div>
    ) : (
      <textarea aria-label={placeholder ?? "rich-editor"} defaultValue={html ?? ""} />
    ),
}));

vi.mock("../document/DocumentImportTagDialog", () => ({
  DocumentImportTagDialog: () => null,
}));

vi.mock("../tags/EntityTagEditor", () => ({
  EntityTagEditor: () => <div>EntityTagEditor</div>,
}));

vi.mock("../todo", () => ({
  TodoRail: () => <div>TodoRail</div>,
}));

vi.mock("../../hooks/useDocumentImportFlow", () => ({
  useDocumentImportFlow: () => ({
    fileTags: [],
    pendingImportPaths: null,
    pendingImportTagIds: [],
    requestImportPaths: vi.fn(async () => undefined),
    togglePendingImportTag: vi.fn(),
    closeImportTagDialog: vi.fn(),
    confirmImportTagDialog: vi.fn(async () => undefined),
    manageImportTags: vi.fn(),
  }),
}));

describe("ProjectOverviewPage", () => {
  beforeEach(() => {
    scrollIntoViewMock.mockReset();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoViewMock,
    });
  });

  it("switches to history, clears filters, and focuses the matching record from focus query", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/1?focus=record-7"]}>
          <Routes>
            <Route path="/projects/:projectId" element={<ProjectOverviewPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("button", { name: "Record" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const searchField = screen.getByLabelText("搜索记录") as HTMLInputElement;
    expect(searchField.value).toBe("");

    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalled();
    });

    const record = document.getElementById("record-7");
    expect(record).toBeInTheDocument();
    expect(record).toHaveClass("scroll-mt-6");
    expect(record).toHaveClass("is-focused");
    expect(screen.getByText("目标记录")).toBeInTheDocument();
  });
});
