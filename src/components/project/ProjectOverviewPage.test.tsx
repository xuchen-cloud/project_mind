import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectOverviewPage } from "./ProjectOverviewPage";

const scrollIntoViewMock = vi.fn();
const scrollToMock = vi.fn();
const noteImageAssetMocks = vi.hoisted(() => ({
  externalizeEmbeddedImageDataUrls: vi.fn(async (value) => value),
  richTextViewerProps: [] as Array<{
    html?: string;
    deferUntilVisible?: boolean;
    active?: boolean;
    eagerManagedImages?: boolean;
  }>,
}));

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
    fileTagOptionUpsert: vi.fn(async ({ label }: { label: string }) => ({
      id: 9,
      label,
      colorKey: "blue",
    })),
    projectRecordUpsert: vi.fn(async (input) => ({
      id: input.noteId ?? 99,
      projectId: input.projectId,
      activityId: input.activityId ?? null,
      title: input.title ?? null,
      contentMarkdown: input.markdown,
      contentHtml: input.html,
      tags: [],
      createdAt: "2026-04-06T08:00:00.000Z",
      updatedAt: "2026-04-06T09:00:00.000Z",
    })),
    projectRecordDelete: vi.fn(async () => undefined),
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

vi.mock("../rich-editor/noteImageAssets", () => ({
  buildProjectNoteImageAssetHandlers: () => ({
    insertImage: vi.fn(),
    insertPastedImage: vi.fn(),
  }),
  externalizeEmbeddedImageDataUrls: noteImageAssetMocks.externalizeEmbeddedImageDataUrls,
}));

vi.mock("../rich-editor", () => ({
  getRenderableRichTextHtml: ({ html, markdown }: { html?: string; markdown?: string }) =>
    html ?? (markdown ? `<p>${markdown}</p>` : ""),
  normalizeRichEditorValue: (value: { html: string; text: string; markdown: string }) => value,
  RichTextViewer: (props: {
    html?: string;
    deferUntilVisible?: boolean;
    active?: boolean;
    eagerManagedImages?: boolean;
  }) => {
    noteImageAssetMocks.richTextViewerProps.push(props);
    return <div>{props.html}</div>;
  },
  RichEditor: ({
    html,
    readOnly,
    placeholder,
    controllerRef,
  }: {
    html?: string;
    readOnly?: boolean;
    placeholder?: string;
    controllerRef?: {
      current: {
        getValue: () => { html: string; text: string; markdown: string };
        focus: () => void;
        save: () => Promise<unknown>;
      } | null;
    };
  }) =>
    readOnly ? (
      <div>{html}</div>
    ) : (
      <MockRichEditor html={html} placeholder={placeholder} controllerRef={controllerRef} />
    ),
}));

function MockRichEditor({
  html,
  placeholder,
  controllerRef,
}: {
  html?: string;
  placeholder?: string;
  controllerRef?: {
    current: {
      getValue: () => { html: string; text: string; markdown: string };
      focus: () => void;
      save: () => Promise<unknown>;
    } | null;
  };
}) {
  const valueRef = useRef(html ?? "");

  useEffect(() => {
    if (!controllerRef) {
      return;
    }

    controllerRef.current = {
      getValue: () => ({
        html: valueRef.current,
        text: valueRef.current.replace(/<[^>]+>/gu, ""),
        markdown: valueRef.current.replace(/<[^>]+>/gu, ""),
      }),
      focus: vi.fn(),
      save: vi.fn(async () => undefined),
    };

    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef]);

  return (
    <textarea
      aria-label={placeholder ?? "rich-editor"}
      className="rich-editor__surface"
      defaultValue={html ?? ""}
      onChange={(event) => {
        valueRef.current = event.currentTarget.value;
      }}
    />
  );
}

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
    noteImageAssetMocks.externalizeEmbeddedImageDataUrls.mockClear();
    noteImageAssetMocks.richTextViewerProps.length = 0;
    scrollIntoViewMock.mockReset();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoViewMock,
    });
    scrollToMock.mockReset();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollToMock,
    });
  });

  it("switches to history and focuses the matching record from focus query", async () => {
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

    await waitFor(() => {
      expect(scrollToMock).toHaveBeenCalled();
    });

    const record = document.getElementById("record-7");
    expect(record).toBeInTheDocument();
    expect(record).toHaveClass("scroll-mt-6");
    expect(record).toHaveClass("is-focused");
    expect(screen.getByText("目标记录")).toBeInTheDocument();
  });

  it("focuses and selects the project name when opened in rename mode", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/1?renameProject=1"]}>
          <Routes>
            <Route path="/projects/:projectId" element={<ProjectOverviewPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const nameInput = await screen.findByRole("textbox", { name: "项目名称" });

    await waitFor(() => {
      expect(nameInput).toHaveFocus();
    });
    expect(nameInput).toHaveValue("Alpha Project");
  });

  it("keeps the record context menu available after opening the record view", async () => {
    const { projectMindApi } = await import("../../services/projectMindApi");
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/1?view=record&recordTag=3"]}>
          <Routes>
            <Route path="/projects/:projectId" element={<ProjectOverviewPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const record = await screen.findByRole("button", { name: /目标记录/ });
    fireEvent.contextMenu(record, { clientX: 64, clientY: 96 });
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));

    await waitFor(() => {
      expect(projectMindApi.projectRecordDelete).toHaveBeenCalledWith({ noteId: 7 });
    });
  });

  it("does not defer the project record viewer in browse mode so images can render immediately", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/1?view=record"]}>
          <Routes>
            <Route path="/projects/:projectId" element={<ProjectOverviewPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByRole("button", { name: /目标记录/ });

    const recordViewerProps = noteImageAssetMocks.richTextViewerProps.find((props) =>
      props.html?.includes("命中记录内容"),
    );

    expect(recordViewerProps).toBeDefined();
    expect(recordViewerProps?.deferUntilVisible).toBeUndefined();
    expect(recordViewerProps?.eagerManagedImages).toBe(true);
  });

  it("opens the record context menu from an edited project record header but not the editor body", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/1?view=record"]}>
          <Routes>
            <Route path="/projects/:projectId" element={<ProjectOverviewPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const record = await screen.findByRole("button", { name: /目标记录/ });
    fireEvent.mouseDown(record, { button: 0 });

    fireEvent.contextMenu(screen.getByPlaceholderText("记录标题"), {
      clientX: 64,
      clientY: 86,
    });
    expect(screen.getByRole("menu", { name: "记录操作" })).toBeInTheDocument();

    fireEvent.scroll(window);
    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "记录操作" })).not.toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByLabelText(/写记录/), {
      clientX: 64,
      clientY: 126,
    });
    expect(screen.queryByRole("menu", { name: "记录操作" })).not.toBeInTheDocument();
  });

  it("exits project record editing with Ctrl+Enter", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/1?view=record"]}>
          <Routes>
            <Route path="/projects/:projectId" element={<ProjectOverviewPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const record = await screen.findByRole("button", { name: /目标记录/ });
    fireEvent.mouseDown(record, { button: 0 });

    const editor = screen.getByLabelText(/写记录/);
    fireEvent.change(editor, { target: { value: "<p>新的记录内容</p>" } });
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });

    await waitFor(() => {
      expect(screen.queryByLabelText(/写记录/)).not.toBeInTheDocument();
    });
    expect(noteImageAssetMocks.externalizeEmbeddedImageDataUrls).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /目标记录/ })).toBeInTheDocument();
  });
});
