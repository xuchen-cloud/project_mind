import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef, type Ref } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUiStoreState, useUiStore } from "../../state/ui-store";
import { projectMindApi } from "../../services/projectMindApi";
import type { ProjectPageData } from "../../lib/types";
import { queryKeys } from "../../lib/queryKeys";

import { ProjectOverviewPage } from "./ProjectOverviewPage";

const scrollIntoViewMock = vi.fn();
const scrollToMock = vi.fn();
const noteImageAssetMocks = vi.hoisted(() => ({
  externalizeEmbeddedImageDataUrls: vi.fn(async (value) => value),
  richEditorProps: [] as Array<{ readOnly?: boolean }>,
  richTextViewerProps: [] as Array<{
    html?: string;
    deferUntilVisible?: boolean;
    active?: boolean;
    eagerManagedImages?: boolean;
  }>,
}));
const todoModuleRailProps = vi.hoisted(() => [] as Array<Record<string, any>>);

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
    projectTagSettingsGet: vi.fn(async () => ({
      tags: [{ id: 3, label: "预算", colorKey: "amber" }],
    })),
    projectTagUpsert: vi.fn(async ({ label }: { label: string }) => ({
      id: 9,
      label,
      colorKey: "blue",
    })),
    projectRecordUpsert: vi.fn(async (input) => ({
      id: input.noteId ?? 99,
      projectId: input.projectId,
      title: input.title ?? null,
      contentMarkdown: input.markdown,
      contentHtml: input.html,
      tags: [],
      createdAt: "2026-04-06T08:00:00.000Z",
      updatedAt: "2026-04-06T09:00:00.000Z",
    })),
    projectRecordDelete: vi.fn(async () => undefined),
    aiSettingsGet: vi.fn(async () => null),
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
  RichEditor: (props: {
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
  }) => {
    noteImageAssetMocks.richEditorProps.push({ readOnly: props.readOnly });
    const { html, readOnly, placeholder, controllerRef } = props;
    return readOnly ? (
      <div>{html}</div>
    ) : (
      <MockRichEditor html={html} placeholder={placeholder} controllerRef={controllerRef} />
    );
  },
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
  EntityTagEditor: ({ inputRef }: { inputRef?: Ref<HTMLInputElement> }) => (
    <input ref={inputRef} aria-label="项目记录标签输入" placeholder="#标签" />
  ),
}));

vi.mock("../../todo", () => ({
  TodoModuleRail: (props: Record<string, any>) => {
    todoModuleRailProps.push(props);
    return (
      <button type="button" onClick={() => props.onViewModeChange?.("workspace")}>
        Mock Todo View
      </button>
    );
  },
}));

vi.mock("../../hooks/useDocumentImportFlow", () => ({
  useDocumentImportFlow: () => ({
    projectTags: [],
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
    useUiStore.setState(createUiStoreState());
    todoModuleRailProps.length = 0;
    noteImageAssetMocks.externalizeEmbeddedImageDataUrls.mockClear();
    noteImageAssetMocks.richEditorProps.length = 0;
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

  it("uses a static overview skeleton only for a cold project entry", async () => {
    vi.useFakeTimers();
    let resolvePage!: (value: ProjectPageData) => void;
    vi.mocked(projectMindApi.projectPageGet).mockImplementationOnce(
      () => new Promise((resolve) => { resolvePage = resolve; }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/1"]}>
          <Routes><Route path="/projects/:projectId" element={<ProjectOverviewPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.queryByRole("status", { name: "正在加载项目页" })).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(119));
    expect(screen.queryByRole("status", { name: "正在加载项目页" })).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole("status", { name: "正在加载项目页" })).toHaveAttribute("data-variant", "overview");
    expect(document.querySelector(".animate-spin, .spin")).toBeNull();

    vi.useRealTimers();
    await act(async () => resolvePage(projectPageWithTaglessRecord()));
    const page = await screen.findByTestId("project-overview-focus-page");
    expect(screen.queryByRole("status", { name: "正在加载项目页" })).not.toBeInTheDocument();
    expect(page.closest(".page-cold-entry")).toHaveAttribute("data-cold-entry", "true");
  });

  it("does not replay cold entry when a cached resident project is hidden and restored", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.projects.all, [projectPageWithTaglessRecord().project]);
    queryClient.setQueryData(queryKeys.projectPage(1), projectPageWithTaglessRecord());
    const page = (visible: boolean) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/1"]}>
          <Routes><Route path="/projects/:projectId" element={<ProjectOverviewPage visible={visible} />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const view = render(page(true));
    expect((await screen.findByTestId("project-overview-focus-page")).closest(".page-cold-entry")).not.toHaveAttribute("data-cold-entry");

    view.rerender(page(false));
    view.rerender(page(true));
    expect(screen.queryByRole("status", { name: "正在加载项目页" })).not.toBeInTheDocument();
    expect(screen.getByTestId("project-overview-focus-page").closest(".page-cold-entry")).not.toHaveAttribute("data-cold-entry");
  });

  it("does not build Project Record history until the Record view is active", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/1"]}>
          <Routes><Route path="/projects/:projectId" element={<ProjectOverviewPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByRole("button", { name: "Record" });
    expect(screen.queryByText("目标记录")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Record" }));

    expect(await screen.findByText("目标记录")).toBeInTheDocument();
  });

  it("does not expose the internal Project status beside the title", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/1"]}>
          <Routes>
            <Route path="/projects/:projectId" element={<ProjectOverviewPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("textbox", { name: "项目名称" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "项目状态" })).not.toBeInTheDocument();
    expect(screen.queryByText("active")).not.toBeInTheDocument();
  });

  it("defaults to Current Project View and persists a switch to Workspace View", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/1"]}>
          <Routes>
            <Route path="/projects/:projectId" element={<ProjectOverviewPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByRole("textbox", { name: "项目名称" });
    expect(todoModuleRailProps.at(-1)?.scope).toEqual({
      kind: "current-project",
      projectId: 1,
    });

    await userEvent.click(screen.getByRole("button", { name: "Mock Todo View" }));
    expect(useUiStore.getState().projectTodoViewMode).toBe("workspace");
    expect(todoModuleRailProps.at(-1)?.scope).toEqual({ kind: "workspace" });
  });

  it("pauses the Todo module while the resident Project page is hidden", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = (visible: boolean) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/1"]}>
          <Routes>
            <Route
              path="/projects/:projectId"
              element={<ProjectOverviewPage visible={visible} />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const view = render(page(true));
    await screen.findByRole("textbox", { name: "项目名称" });

    view.rerender(page(false));

    expect(todoModuleRailProps.at(-1)?.enabled).toBe(false);
  });

  it("disables Current Project Todo creation after the Project enters Archive", async () => {
    const archivedProject = {
      id: 1,
      name: "Archived Project",
      rootPath: "/tmp/archived-project",
      isArchived: true,
      kind: "normal" as const,
      quickNote: "",
      quickNoteMarkdown: "",
      quickNoteHtml: "",
      status: "active",
      openTodoCount: 0,
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    };
    vi.mocked(projectMindApi.projectsList).mockResolvedValueOnce([archivedProject]);
    vi.mocked(projectMindApi.projectPageGet).mockResolvedValueOnce(
      {
        project: archivedProject,
        records: [],
        unfinishedTodos: [],
        finishedTodos: [],
        projectDocuments: [],
      } satisfies ProjectPageData,
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/1"]}>
          <Routes>
            <Route path="/projects/:projectId" element={<ProjectOverviewPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByRole("textbox", { name: "项目名称" });
    expect(todoModuleRailProps.at(-1)?.canCreateTodo).toBe(false);
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

  it("does not autofocus controls while the resident Project shell is Warm", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const projectPage = projectPageWithTaglessRecord();
    queryClient.setQueryData(queryKeys.projects.all, [projectPage.project]);
    queryClient.setQueryData(queryKeys.projectPage(1), projectPage);
    queryClient.setQueryData(queryKeys.projectTags.project(1), { tags: [] });
    document.body.focus();

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/1?renameProject=1"]}>
          <Routes>
            <Route
              path="/projects/:projectId"
              element={<ProjectOverviewPage visible={false} />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const nameInput = screen.getByRole("textbox", { name: "项目名称" });
    await Promise.resolve();
    expect(nameInput).not.toHaveFocus();
  });

  it("makes every Overview editor read-only while the resident Project shell is Warm", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const projectPage = projectPageWithTaglessRecord();
    queryClient.setQueryData(queryKeys.projects.all, [projectPage.project]);
    queryClient.setQueryData(queryKeys.projectPage(1), projectPage);
    queryClient.setQueryData(queryKeys.projectTags.project(1), { tags: [] });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/1?view=record&compose=record"]}>
          <Routes>
            <Route
              path="/projects/:projectId"
              element={<ProjectOverviewPage visible={false} />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(noteImageAssetMocks.richEditorProps.length).toBeGreaterThanOrEqual(2);
    expect(noteImageAssetMocks.richEditorProps.every(({ readOnly }) => readOnly)).toBe(true);
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

  it("defers the project record viewer in browse mode while preserving eager nearby images", async () => {
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
    expect(recordViewerProps?.deferUntilVisible).toBe(true);
    expect(recordViewerProps?.eagerManagedImages).toBe(true);
  });

  it("expands and collapses long project record content without entering editing", async () => {
    const scrollHeightSpy = mockCollapsibleScrollHeight(() => 460);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    try {
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/projects/1?view=record"]}>
            <Routes>
              <Route path="/projects/:projectId" element={<ProjectOverviewPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );

      const expandButton = await screen.findByRole("button", { name: "展开全部" });
      fireEvent.mouseDown(expandButton, { button: 0 });
      fireEvent.click(expandButton);

      expect(await screen.findByRole("button", { name: "收起" })).toBeInTheDocument();
      expect(screen.queryByLabelText(/写记录/)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "收起" }));
      expect(await screen.findByRole("button", { name: "展开全部" })).toBeInTheDocument();
    } finally {
      scrollHeightSpy.mockRestore();
    }
  });

  it("does not reserve an empty tag row when a project record has no tags", async () => {
    const { projectMindApi } = await import("../../services/projectMindApi");
    vi.mocked(projectMindApi.projectPageGet).mockResolvedValueOnce(projectPageWithTaglessRecord());
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

    await screen.findByRole("button", { name: /无标签记录/ });

    expect(screen.queryByRole("button", { name: "添加标签" })).not.toBeInTheDocument();
    expect(
      document.querySelector("#record-8 .project-history-record__tag-row"),
    ).not.toBeInTheDocument();
  });

  it("keeps the tag row hidden when a tagless project record enters editing normally", async () => {
    const { projectMindApi } = await import("../../services/projectMindApi");
    vi.mocked(projectMindApi.projectPageGet).mockResolvedValueOnce(projectPageWithTaglessRecord());
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

    fireEvent.mouseDown(await screen.findByRole("button", { name: /无标签记录/ }), { button: 0 });

    expect(screen.getByLabelText(/写记录/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加标签" })).toBeInTheDocument();
    expect(screen.queryByLabelText("项目记录标签输入")).not.toBeInTheDocument();
    expect(
      document.querySelector("#record-8 .project-history-record__tag-row"),
    ).not.toBeInTheDocument();
  });

  it("opens and focuses the tag editor from the project record header add tag button", async () => {
    const { projectMindApi } = await import("../../services/projectMindApi");
    vi.mocked(projectMindApi.projectPageGet).mockResolvedValueOnce(projectPageWithTaglessRecord());
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

    const recordButton = await screen.findByRole("button", { name: /无标签记录/ });
    expect(screen.queryByRole("button", { name: "添加标签" })).not.toBeInTheDocument();

    fireEvent.mouseDown(recordButton, { button: 0 });
    fireEvent.mouseDown(screen.getByRole("button", { name: "添加标签" }), { button: 0 });

    const tagInput = await screen.findByLabelText("项目记录标签输入");
    await waitFor(() => {
      expect(tagInput).toHaveFocus();
    });
    expect(document.querySelector("#record-8 .project-history-record__tag-row")).toBeInTheDocument();
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

function mockCollapsibleScrollHeight(getHeight: (element: HTMLElement) => number) {
  return vi
    .spyOn(HTMLElement.prototype, "scrollHeight", "get")
    .mockImplementation(function getScrollHeight(this: HTMLElement) {
      if (this.classList.contains("project-history-record__collapsible")) {
        return getHeight(this);
      }

      return 0;
    });
}

function projectPageWithTaglessRecord() {
  return {
    project: {
      id: 1,
      name: "Alpha Project",
      rootPath: "/tmp/alpha-project",
      isArchived: false,
      kind: "normal" as const,
      quickNote: "",
      quickNoteMarkdown: "",
      quickNoteHtml: "",
      status: "active",
    },
    records: [
      {
        id: 8,
        projectId: 1,
        title: "无标签记录",
        contentMarkdown: "没有标签的内容",
        contentHtml: "<p>没有标签的内容</p>",
        createdAt: "2026-04-06T08:00:00.000Z",
        updatedAt: "2026-04-06T09:00:00.000Z",
        tags: [],
      },
    ],
    unfinishedTodos: [],
    finishedTodos: [],
    documents: [],
  };
}
