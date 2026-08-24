import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { MemoryRouter, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { act, fireEvent, render as baseRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NoteRecord, ProjectPageData, ProjectRecord } from "../../lib/types";
import {
  PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT,
  requestProjectRecordFocusSave,
} from "../../lib/record-focus-save";
import { RecordSaveCoordinator } from "../../lib/record-save-coordinator";
import { RecordSaveCoordinatorProvider } from "../../lib/record-save-runtime";
import { queryKeys } from "../../lib/queryKeys";
import { RecordFocusResidentPages } from "../record/RecordFocusResidentPages";
import { ProjectNoteFocusPage } from "./ProjectNoteFocusPage";

const richEditorMocks = vi.hoisted(() => ({
  focus: vi.fn(),
}));

const noteImageAssetMocks = vi.hoisted(() => ({
  externalizeEmbeddedImageDataUrls: vi.fn(async (value) => value),
}));

const recordExportMocks = vi.hoisted(() => ({
  sources: [] as Array<{ committedHtml: string; recordKind: string }>,
}));

const apiMocks = vi.hoisted(() => ({
  projectsList: vi.fn(),
  projectPageGet: vi.fn(),
  projectTagSettingsGet: vi.fn(),
  projectTagUpsert: vi.fn(),
  projectRecordUpsert: vi.fn(),
  aiSettingsGet: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: apiMocks,
}));

vi.mock("../../features/record-export/desktopRecordExportPlatform", () => ({
  createDesktopRecordExporter: (saveCommittedContent: () => Promise<{ committedHtml: string; recordKind: string }>) =>
    async () => {
      recordExportMocks.sources.push(await saveCommittedContent());
      return { kind: "success", path: "/tmp/export.docx", warnings: [], fontSubstituted: false };
    },
}));

vi.mock("../../features/record-export/RecordExportAction", () => ({
  RecordExportAction: ({ exportTo }: { exportTo: (request: object) => Promise<unknown> }) => (
    <button type="button" onClick={() => void exportTo({ format: "docx", targetPath: "/tmp/export.docx" })}>
      测试导出
    </button>
  ),
}));

vi.mock("../../hooks/useContactMentionOptions", () => ({
  useContactMentionOptions: () => ({}),
}));

vi.mock("../../hooks/useInternalReferenceNavigation", () => ({
  useInternalReferenceNavigation: () => vi.fn(),
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
    projectSidebarCollapsed: false,
  }),
}));

vi.mock("../rich-editor/noteImageAssets", () => ({
  buildProjectNoteImageAssetHandlers: () => undefined,
  externalizeEmbeddedImageDataUrls: noteImageAssetMocks.externalizeEmbeddedImageDataUrls,
}));

vi.mock("../rich-editor", () => ({
  getRenderableRichTextHtml: ({ html, markdown }: { html?: string; markdown?: string }) =>
    html ?? (markdown ? `<p>${markdown}</p>` : ""),
  normalizeRichEditorValue: (value: { html: string; text: string; markdown: string }) => value,
  RichEditor: ({
    html,
    controllerRef,
    onSave,
    variant,
    showToolbar,
    autoFocus,
    readOnly,
  }: {
    html?: string;
    onSave?: (value: { html: string; text: string; markdown: string }) => Promise<unknown>;
    variant?: string;
    showToolbar?: boolean;
    autoFocus?: boolean;
    readOnly?: boolean;
    controllerRef?: {
      current: {
        getValue: () => { html: string; text: string; markdown: string };
        getCommittedValue: () => { html: string; text: string; markdown: string };
        focus: (position?: "start" | "end" | number) => void;
        save: () => Promise<unknown>;
      } | null;
    };
  }) => {
    const [value, setValue] = useState(toPlainText(html ?? ""));
    const valueRef = useRef(value);
    valueRef.current = value;

    useEffect(() => {
      if (!controllerRef) {
        return;
      }

      controllerRef.current = {
        getValue: () => buildMockRichValue(valueRef.current),
        getCommittedValue: () => buildMockRichValue(valueRef.current.replace("[AI preview]", "")),
        focus: richEditorMocks.focus,
        save: vi.fn(() => onSave?.(buildMockRichValue(valueRef.current.replace("[AI preview]", ""))) ?? Promise.resolve()),
      };

      return () => {
        controllerRef.current = null;
      };
    }, [controllerRef, onSave]);

    return (
      <textarea
        aria-label="正文编辑器"
        data-variant={variant}
        data-show-toolbar={String(showToolbar)}
        data-auto-focus={String(Boolean(autoFocus))}
        readOnly={readOnly}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    );
  },
}));

const project: ProjectRecord = {
  id: 1,
  name: "Alpha",
  kind: "normal",
  status: "active",
  rootPath: "/tmp/alpha",
  quickNote: "",
  quickNoteMarkdown: "",
  quickNoteHtml: "",
  isArchived: false,
  createdAt: "",
  updatedAt: "",
};

const baseNote: NoteRecord = {
  id: 7,
  projectId: 1,
  activityId: null,
  title: "旧标题",
  contentMarkdown: "正文",
  contentHtml: "<p>正文</p>",
  tags: [],
  createdAt: "",
  updatedAt: "",
};

let currentNote: NoteRecord;

function render(ui: ReactElement, providedQueryClient?: QueryClient) {
  const queryClient = providedQueryClient ?? new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const view = baseRender(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/projects/1/records/7"]}>
        <Routes>
          <Route path="/projects/:projectId/records/:noteId" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

function buildProjectPage(): ProjectPageData {
  return {
    project,
    records: [currentNote],
    unfinishedTodos: [],
    finishedTodos: [],
    projectDocuments: [],
  };
}

function buildMockRichValue(value: string) {
  return {
    html: value.includes("[managed image]")
      ? `<p>${value}<img src="data:image/png;base64,AA=="></p>`
      : `<p>${value}</p>`,
    text: value,
    markdown: value,
  };
}

function toPlainText(html: string) {
  return html.replace(/<[^>]+>/gu, "");
}

function FocusSwitchHarness() {
  const navigate = useNavigate();
  const params = useParams();
  const projectId = Number.parseInt(params.projectId ?? "", 10);
  const noteId = Number.parseInt(params.noteId ?? "", 10);

  const openRecord = (targetNoteId: number) => {
    const result = requestProjectRecordFocusSave({ projectId, recordId: noteId });
    if (result === "submitted") {
      navigate(`/projects/${projectId}/records/${targetNoteId}`);
    }
  };

  return (
    <>
      <button type="button" onClick={() => openRecord(70)}>打开记录 A</button>
      <button type="button" onClick={() => openRecord(80)}>打开记录 B</button>
      <ProjectNoteFocusPage />
    </>
  );
}

function ResidentFocusSwitchHarness() {
  const navigate = useNavigate();
  const params = useParams();
  const projectId = Number.parseInt(params.projectId ?? "", 10);
  const noteId = Number.parseInt(params.noteId ?? "", 10);

  const openRecord = (targetNoteId: number) => {
    const result = requestProjectRecordFocusSave({ projectId, recordId: noteId });
    if (result === "submitted") {
      navigate(`/projects/${projectId}/records/${targetNoteId}`);
    }
  };

  return (
    <>
      <button type="button" onClick={() => openRecord(70)}>打开驻留记录 A</button>
      <button type="button" onClick={() => openRecord(80)}>打开驻留记录 B</button>
      <button type="button" onClick={() => openRecord(90)}>打开驻留记录 C</button>
      <RecordFocusResidentPages workspaceKey="/tmp/workspace" />
    </>
  );
}

function CrossProjectFocusSwitchHarness() {
  const navigate = useNavigate();
  const params = useParams();
  const projectId = Number.parseInt(params.projectId ?? "", 10);
  const noteId = Number.parseInt(params.noteId ?? "", 10);

  const openRecord = (targetProjectId: number, targetNoteId: number) => {
    const result = requestProjectRecordFocusSave({ projectId, recordId: noteId });
    if (result === "submitted") {
      navigate(`/projects/${targetProjectId}/records/${targetNoteId}`);
    }
  };

  return (
    <>
      <button type="button" onClick={() => openRecord(1, 70)}>打开 Project A Focus</button>
      <button type="button" onClick={() => openRecord(2, 80)}>打开 Project B Focus</button>
      <RecordFocusResidentPages workspaceKey="/tmp/workspace" />
    </>
  );
}

function ResidentFocusVisibilityHarness() {
  const [visible, setVisible] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setVisible((current) => !current)}>
        切换 Focus 可见性
      </button>
      <ProjectNoteFocusPage visible={visible} />
    </>
  );
}

describe("ProjectNoteFocusPage keyboard flow", () => {
  beforeEach(() => {
    currentNote = { ...baseNote, tags: [] };
    recordExportMocks.sources.length = 0;
    richEditorMocks.focus.mockReset();
    noteImageAssetMocks.externalizeEmbeddedImageDataUrls.mockClear();
    apiMocks.projectsList.mockReset();
    apiMocks.projectPageGet.mockReset();
    apiMocks.projectTagSettingsGet.mockReset();
    apiMocks.projectTagUpsert.mockReset();
    apiMocks.projectRecordUpsert.mockReset();
    apiMocks.aiSettingsGet.mockReset();

    apiMocks.projectsList.mockResolvedValue([project]);
    apiMocks.aiSettingsGet.mockResolvedValue(null);
    apiMocks.projectPageGet.mockImplementation(async () => buildProjectPage());
    apiMocks.projectTagSettingsGet.mockResolvedValue({ tags: [] });
    apiMocks.projectTagUpsert.mockImplementation(async ({ label }: { label: string }) => ({
      id: 22,
      label,
      colorKey: "blue",
      usageCount: 0,
      createdAt: "",
      updatedAt: "",
    }));
    apiMocks.projectRecordUpsert.mockImplementation(async (input: Partial<NoteRecord> & { tagIds?: number[] }) => {
      currentNote = {
        ...currentNote,
        title: input.title,
        contentMarkdown: input.markdown ?? currentNote.contentMarkdown,
        contentHtml: input.html ?? currentNote.contentHtml,
        tags: input.tagIds?.map((id) => ({ id, label: id === 22 ? "紧急" : `Tag ${id}`, colorKey: "blue" })) ?? currentNote.tags,
      };
      return currentNote;
    });
  });

  it("hands a cold record from one static skeleton to ready content", async () => {
    vi.useFakeTimers();
    let resolvePage!: (value: ProjectPageData) => void;
    apiMocks.projectPageGet.mockImplementationOnce(() => new Promise((resolve) => { resolvePage = resolve; }));
    const view = render(<ProjectNoteFocusPage />);

    expect(screen.queryByRole("status", { name: "正在加载项目记录" })).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(119));
    expect(screen.queryByRole("status", { name: "正在加载项目记录" })).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole("status", { name: "正在加载项目记录" })).toHaveAttribute("data-variant", "record");
    expect(view.container.querySelector(".animate-spin, .spin")).toBeNull();

    vi.useRealTimers();
    await act(async () => resolvePage(buildProjectPage()));
    expect(await screen.findByLabelText("正文编辑器")).toHaveValue("正文");
    expect(screen.queryByRole("status", { name: "正在加载项目记录" })).not.toBeInTheDocument();
    expect(view.container.querySelector("[data-focus-page-key]" )).toHaveAttribute("data-cold-entry", "true");
  });

  it("renders a cached record synchronously without a cold entrance", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.projects.all, [project]);
    queryClient.setQueryData(queryKeys.projectPage(1), buildProjectPage());

    const view = render(<ProjectNoteFocusPage />, queryClient);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByLabelText("正文编辑器")).toHaveValue("正文");
    expect(view.container.querySelector("[data-focus-page-key]")).not.toHaveAttribute("data-cold-entry");
  });

  it("does not refetch cached Project Labels when a Warm Focus becomes Active", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.projects.all, [project]);
    queryClient.setQueryData(queryKeys.projectPage(1), buildProjectPage());
    queryClient.setQueryData(
      queryKeys.projectTags.project(1),
      { tags: [] },
      { updatedAt: Date.now() - 60_000 },
    );

    render(<ResidentFocusVisibilityHarness />, queryClient);
    const user = userEvent.setup();
    await screen.findByLabelText("正文编辑器");
    await user.click(screen.getByRole("button", { name: "切换 Focus 可见性" }));
    await user.click(screen.getByRole("button", { name: "切换 Focus 可见性" }));

    expect(apiMocks.projectTagSettingsGet).not.toHaveBeenCalled();
  });

  it("awaits an in-flight save and exports ordinary edits without pending AI preview", async () => {
    const user = userEvent.setup();
    let finishSave: ((value: NoteRecord) => void) | undefined;
    apiMocks.projectRecordUpsert.mockImplementationOnce(() => new Promise<NoteRecord>((resolve) => {
      finishSave = resolve;
    }));
    render(<ProjectNoteFocusPage />);

    const editor = await screen.findByLabelText("正文编辑器");
    await user.clear(editor);
    fireEvent.change(editor, { target: { value: "未保存普通编辑[AI preview]" } });
    await user.click(screen.getByRole("button", { name: "测试导出" }));

    await waitFor(() => expect(apiMocks.projectRecordUpsert).toHaveBeenCalled());
    expect(recordExportMocks.sources).toHaveLength(0);
    finishSave?.({ ...currentNote, contentHtml: "<p>未保存普通编辑</p>" });
    await waitFor(() => expect(recordExportMocks.sources).toHaveLength(1));
    expect(recordExportMocks.sources[0]).toMatchObject({
      recordKind: "project",
      committedHtml: "<p>未保存普通编辑</p>",
    });
    expect(recordExportMocks.sources[0]?.committedHtml).not.toContain("AI preview");
  });

  it("saves the title with Tab and focuses the tag input", async () => {
    const user = userEvent.setup();
    render(<ProjectNoteFocusPage />);

    const titleInput = await screen.findByPlaceholderText("记录标题");
    await user.clear(titleInput);
    await user.type(titleInput, "新标题");
    await user.keyboard("{Tab}");

    const tagInput = screen.getByPlaceholderText("#标签");
    await waitFor(() => expect(tagInput).toHaveFocus());
    expect(apiMocks.projectRecordUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ noteId: 7, title: "新标题" }),
    );
    expect(noteImageAssetMocks.externalizeEmbeddedImageDataUrls).toHaveBeenCalled();
  });

  it("keeps the focus page height constrained so its content area can scroll", async () => {
    render(<ProjectNoteFocusPage />);

    const scroll = await screen.findByTestId("project-record-focus-scroll");
    expect(scroll).toHaveClass("project-overview-focus__scroll");
    expect(scroll.parentElement).toHaveClass(
      "project-overview-focus",
      "h-full",
      "min-h-0",
    );
    expect(screen.getByLabelText("正文编辑器")).toHaveAttribute("data-variant", "page");
    expect(screen.getByLabelText("正文编辑器")).toHaveAttribute(
      "data-show-toolbar",
      "false",
    );
  });

  it("saves the title with Enter and focuses the tag input", async () => {
    const user = userEvent.setup();
    render(<ProjectNoteFocusPage />);

    const titleInput = await screen.findByPlaceholderText("记录标题");
    await user.clear(titleInput);
    await user.type(titleInput, "回车标题");
    await user.keyboard("{Enter}");

    const tagInput = screen.getByPlaceholderText("#标签");
    await waitFor(() => expect(tagInput).toHaveFocus());
    expect(apiMocks.projectRecordUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ noteId: 7, title: "回车标题" }),
    );
  });

  it("saves a tag with Enter and focuses the rich editor body", async () => {
    const user = userEvent.setup();
    render(<ProjectNoteFocusPage />);

    const tagInput = await screen.findByPlaceholderText("#标签");
    await user.type(tagInput, "紧急{Enter}");

    await waitFor(() => {
      expect(apiMocks.projectTagUpsert).toHaveBeenCalledWith({
        projectId: 1,
        label: "紧急",
        colorKey: expect.any(String),
      });
    });
    await waitFor(() => expect(richEditorMocks.focus).toHaveBeenCalledWith("end"));
  });

  it("preserves the current title when saving a new tag before a separate title save", async () => {
    const user = userEvent.setup();
    render(<ProjectNoteFocusPage />);

    const titleInput = await screen.findByPlaceholderText("记录标题");
    await user.clear(titleInput);
    await user.type(titleInput, "直接加标签的标题");

    const tagInput = screen.getByPlaceholderText("#标签");
    await user.click(tagInput);
    await user.type(tagInput, "紧急{Enter}");

    await waitFor(() => {
      expect(apiMocks.projectRecordUpsert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          noteId: 7,
          title: "直接加标签的标题",
          tagIds: [22],
        }),
      );
    });
  });

  it("captures complete committed metadata when navigation requests a forced save", async () => {
    currentNote = {
      ...currentNote,
      defaultCodeLanguage: "python",
      tags: [{ id: 5, label: "Source", colorKey: "blue" }],
    };
    render(<ProjectNoteFocusPage />);

    const user = userEvent.setup();
    const title = await screen.findByPlaceholderText("记录标题");
    await user.clear(title);
    await user.type(title, "最新标题");
    const editor = screen.getByLabelText("正文编辑器");
    await user.clear(editor);
    fireEvent.change(editor, {
      target: { value: "最后一个字符！[managed image][AI preview]" },
    });
    const scroll = screen.getByTestId("project-record-focus-scroll");
    scroll.scrollTop = 184;

    window.dispatchEvent(
      new CustomEvent(PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT, {
        detail: {
          projectId: 1,
          recordId: 7,
          respond: vi.fn(),
        },
      }),
    );

    await waitFor(() => {
      expect(apiMocks.projectRecordUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          noteId: 7,
          title: "最新标题",
          markdown: "最后一个字符！[managed image]",
          html: expect.stringContaining("data:image/png;base64,AA=="),
          defaultCodeLanguage: "python",
          tagIds: [5],
        }),
      );
    });
    expect(noteImageAssetMocks.externalizeEmbeddedImageDataUrls).toHaveBeenCalledWith(
      expect.objectContaining({
        markdown: "最后一个字符！[managed image]",
        html: expect.stringContaining("data:image/png;base64,AA=="),
      }),
      undefined,
    );
    expect(
      noteImageAssetMocks.externalizeEmbeddedImageDataUrls.mock.calls[0]?.[0]?.markdown,
    ).not.toContain("AI preview");
    expect(apiMocks.projectRecordUpsert).toHaveBeenCalledTimes(2);
    expect(scroll.scrollTop).toBe(184);
  });

  it("does not reinitialize the same focus editor after its query refreshes", async () => {
    const user = userEvent.setup();
    const { queryClient } = render(<ProjectNoteFocusPage />);

    const titleInput = await screen.findByPlaceholderText("记录标题");
    await user.clear(titleInput);
    await user.type(titleInput, "尚未离开的本地标题");

    currentNote = {
      ...currentNote,
      title: "服务端刷新标题",
      contentMarkdown: "服务端刷新正文",
      contentHtml: "<p>服务端刷新正文</p>",
    };
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: queryKeys.projectPage(1) });
    });

    expect(titleInput).toHaveValue("尚未离开的本地标题");
  });

  it("reuses the two most recent Project Record Focus editors without another project-page request", async () => {
    const user = userEvent.setup();
    const notes = [
      { ...baseNote, id: 70, title: "记录 A", contentMarkdown: "正文 A", contentHtml: "<p>正文 A</p>" },
      { ...baseNote, id: 80, title: "记录 B", contentMarkdown: "正文 B", contentHtml: "<p>正文 B</p>" },
      { ...baseNote, id: 90, title: "记录 C", contentMarkdown: "正文 C", contentHtml: "<p>正文 C</p>" },
    ];
    const projectPage = {
      project,
      records: notes,
      unfinishedTodos: [],
      finishedTodos: [],
      projectDocuments: [],
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.projectPage(1), projectPage);
    queryClient.setQueryData(queryKeys.projects.all, [project]);
    const coordinator = new RecordSaveCoordinator({
      workspaceKey: "/tmp/workspace",
      adapter: { persist: vi.fn(async () => ({ updatedAt: "saved" })) },
    });

    baseRender(
      <QueryClientProvider client={queryClient}>
        <RecordSaveCoordinatorProvider coordinator={coordinator}>
          <MemoryRouter initialEntries={["/projects/1/records/70"]}>
            <Routes>
              <Route
                path="/projects/:projectId/records/:noteId"
                element={<ResidentFocusSwitchHarness />}
              />
            </Routes>
          </MemoryRouter>
        </RecordSaveCoordinatorProvider>
      </QueryClientProvider>,
    );

    const editorA = await screen.findByDisplayValue("正文 A");
    await user.clear(editorA);
    await user.type(editorA, "本地正文 A");
    expect(apiMocks.projectPageGet).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "打开驻留记录 B" }));
    const editorB = await screen.findByDisplayValue("正文 B");
    expect(document.querySelectorAll("[data-record-focus-resident-key]")).toHaveLength(2);
    expect(editorA).toHaveAttribute("readonly");
    expect(editorA).toHaveAttribute("data-auto-focus", "false");
    expect(editorA.closest("[data-record-focus-resident-key]")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(editorA.closest("[data-record-focus-resident-key]")).toHaveAttribute("inert");
    expect(editorB).not.toHaveAttribute("readonly");

    queryClient.setQueryData<ProjectPageData>(queryKeys.projectPage(1), {
      ...projectPage,
      records: notes.map((note) =>
        note.id === 70
          ? { ...note, contentMarkdown: "后台刷新正文 A", contentHtml: "<p>后台刷新正文 A</p>" }
          : note,
      ),
    });

    await user.click(screen.getByRole("button", { name: "打开驻留记录 A" }));
    expect(await screen.findByDisplayValue("本地正文 A")).toBe(editorA);
    expect(apiMocks.projectPageGet).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "打开驻留记录 C" }));
    expect(await screen.findByDisplayValue("正文 C")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-record-focus-resident-key]")).toHaveLength(2);
    expect(editorB).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "打开驻留记录 B" }));
    expect(await screen.findByDisplayValue("正文 B")).not.toBe(editorB);
    expect(apiMocks.projectPageGet).not.toHaveBeenCalled();
  });

  it("reuses the same Focus editors across Projects under one Workspace-wide limit", async () => {
    const user = userEvent.setup();
    const projectB = { ...project, id: 2, name: "Beta", rootPath: "/tmp/beta" };
    const noteA = {
      ...baseNote,
      id: 70,
      projectId: 1,
      title: "Project A Record",
      contentMarkdown: "Project A 正文",
      contentHtml: "<p>Project A 正文</p>",
    };
    const noteB = {
      ...baseNote,
      id: 80,
      projectId: 2,
      title: "Project B Record",
      contentMarkdown: "Project B 正文",
      contentHtml: "<p>Project B 正文</p>",
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.projects.all, [project, projectB]);
    queryClient.setQueryData<ProjectPageData>(queryKeys.projectPage(1), {
      project,
      records: [noteA],
      unfinishedTodos: [],
      finishedTodos: [],
      projectDocuments: [],
    });
    queryClient.setQueryData<ProjectPageData>(queryKeys.projectPage(2), {
      project: projectB,
      records: [noteB],
      unfinishedTodos: [],
      finishedTodos: [],
      projectDocuments: [],
    });
    const coordinator = new RecordSaveCoordinator({
      workspaceKey: "/tmp/workspace",
      adapter: { persist: vi.fn(async () => ({ updatedAt: "saved" })) },
    });

    baseRender(
      <QueryClientProvider client={queryClient}>
        <RecordSaveCoordinatorProvider coordinator={coordinator}>
          <MemoryRouter initialEntries={["/projects/1/records/70"]}>
            <Routes>
              <Route
                path="/projects/:projectId/records/:noteId"
                element={<CrossProjectFocusSwitchHarness />}
              />
            </Routes>
          </MemoryRouter>
        </RecordSaveCoordinatorProvider>
      </QueryClientProvider>,
    );

    const editorA = await screen.findByDisplayValue("Project A 正文");
    await user.click(screen.getByRole("button", { name: "打开 Project B Focus" }));
    await screen.findByDisplayValue("Project B 正文");
    await user.click(screen.getByRole("button", { name: "打开 Project A Focus" }));

    expect(await screen.findByDisplayValue("Project A 正文")).toBe(editorA);
    expect(document.querySelectorAll("[data-record-focus-resident-key]")).toHaveLength(2);
    expect(apiMocks.projectPageGet).not.toHaveBeenCalled();
  });

  it("restores an evicted Project Record Focus from the latest pending save snapshot", async () => {
    const user = userEvent.setup();
    const notes = [
      { ...baseNote, id: 70, title: "记录 A", contentMarkdown: "旧正文 A", contentHtml: "<p>旧正文 A</p>" },
      { ...baseNote, id: 80, title: "记录 B", contentMarkdown: "正文 B", contentHtml: "<p>正文 B</p>" },
      { ...baseNote, id: 90, title: "记录 C", contentMarkdown: "正文 C", contentHtml: "<p>正文 C</p>" },
    ];
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData<ProjectPageData>(queryKeys.projectPage(1), {
      project,
      records: notes,
      unfinishedTodos: [],
      finishedTodos: [],
      projectDocuments: [],
    });
    queryClient.setQueryData(queryKeys.projects.all, [project]);
    const coordinator = new RecordSaveCoordinator({
      workspaceKey: "/tmp/workspace",
      adapter: { persist: vi.fn(() => new Promise(() => undefined)) },
    });

    baseRender(
      <QueryClientProvider client={queryClient}>
        <RecordSaveCoordinatorProvider coordinator={coordinator}>
          <MemoryRouter initialEntries={["/projects/1/records/70"]}>
            <Routes>
              <Route
                path="/projects/:projectId/records/:noteId"
                element={<ResidentFocusSwitchHarness />}
              />
            </Routes>
          </MemoryRouter>
        </RecordSaveCoordinatorProvider>
      </QueryClientProvider>,
    );

    const editorA = await screen.findByDisplayValue("旧正文 A");
    await user.clear(editorA);
    await user.type(editorA, "延迟保存的最新正文 A");
    await user.click(screen.getByRole("button", { name: "打开驻留记录 B" }));
    await screen.findByDisplayValue("正文 B");
    await user.click(screen.getByRole("button", { name: "打开驻留记录 C" }));
    await screen.findByDisplayValue("正文 C");
    expect(editorA).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "打开驻留记录 A" }));
    expect(await screen.findByDisplayValue("延迟保存的最新正文 A")).toBeInTheDocument();
    expect(apiMocks.projectPageGet).not.toHaveBeenCalled();
  });

  it("initializes from a failed save snapshot before stale Query data", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData<ProjectPageData>(queryKeys.projectPage(1), {
      project,
      records: [
        {
          ...baseNote,
          id: 70,
          title: "Query 旧标题",
          contentMarkdown: "Query 旧正文",
          contentHtml: "<p>Query 旧正文</p>",
        },
      ],
      unfinishedTodos: [],
      finishedTodos: [],
      projectDocuments: [],
    });
    queryClient.setQueryData(queryKeys.projects.all, [project]);
    const coordinator = new RecordSaveCoordinator({
      workspaceKey: "/tmp/workspace",
      adapter: { persist: vi.fn(async () => { throw new Error("save failed"); }) },
    });
    coordinator.submit({
      scope: "project",
      workspaceKey: "/tmp/workspace",
      projectId: 1,
      recordId: 70,
      activityId: null,
      title: "失败快照标题",
      tagIds: [],
      defaultCodeLanguage: "typescript",
      committedContent: buildMockRichValue("失败快照最新正文"),
    });
    await vi.waitFor(() => {
      expect(coordinator.getRecordStatus("project:1:70").phase).toBe("error");
    });

    baseRender(
      <QueryClientProvider client={queryClient}>
        <RecordSaveCoordinatorProvider coordinator={coordinator}>
          <MemoryRouter initialEntries={["/projects/1/records/70"]}>
            <Routes>
              <Route
                path="/projects/:projectId/records/:noteId"
                element={<ProjectNoteFocusPage />}
              />
            </Routes>
          </MemoryRouter>
        </RecordSaveCoordinatorProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByPlaceholderText("记录标题")).toHaveValue("失败快照标题");
    expect(screen.getByDisplayValue("失败快照最新正文")).toBeInTheDocument();
    expect(apiMocks.projectPageGet).not.toHaveBeenCalled();
  });

  it("saves edited content before switching records and restores its previous scroll position", async () => {
    const user = userEvent.setup();
    const notes = new Map<number, NoteRecord>([
      [70, { ...baseNote, id: 70, title: "记录 A", contentMarkdown: "正文 A", contentHtml: "<p>正文 A</p>" }],
      [80, { ...baseNote, id: 80, title: "记录 B", contentMarkdown: "正文 B", contentHtml: "<p>正文 B</p>" }],
    ]);
    apiMocks.projectPageGet.mockImplementation(async () => ({
      project,
      records: Array.from(notes.values()),
      unfinishedTodos: [],
      finishedTodos: [],
      projectDocuments: [],
    }));
    apiMocks.projectRecordUpsert.mockImplementation(async (input: {
      noteId: number;
      title?: string;
      markdown: string;
      html: string;
      defaultCodeLanguage?: string | null;
      tagIds?: number[];
    }) => {
      const previous = notes.get(input.noteId)!;
      const saved = {
        ...previous,
        title: input.title ?? null,
        contentMarkdown: input.markdown,
        contentHtml: input.html,
        defaultCodeLanguage: input.defaultCodeLanguage ?? null,
      };
      notes.set(input.noteId, saved);
      return saved;
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    baseRender(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/1/records/70"]}>
          <Routes>
            <Route path="/projects/:projectId/records/:noteId" element={<FocusSwitchHarness />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const editorA = await screen.findByRole("textbox", { name: "正文编辑器" });
    const scrollA = screen.getByTestId("project-record-focus-scroll");
    scrollA.scrollTop = 160;
    await user.clear(editorA);
    await user.type(editorA, "修改后的正文 A");
    await user.click(screen.getByRole("button", { name: "打开记录 B" }));

    expect(await screen.findByDisplayValue("正文 B")).toBeInTheDocument();
    await waitFor(() => {
      expect(notes.get(70)?.contentMarkdown).toBe("修改后的正文 A");
    });

    await user.click(screen.getByRole("button", { name: "打开记录 A" }));
    expect(await screen.findByDisplayValue("修改后的正文 A")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("project-record-focus-scroll").scrollTop).toBe(160);
    });
  });

  it("navigates after a failed background save and retains the failed snapshot", async () => {
    const user = userEvent.setup();
    apiMocks.projectPageGet.mockResolvedValue({
      project,
      records: [
        { ...baseNote, id: 70, title: "记录 A", contentMarkdown: "正文 A", contentHtml: "<p>正文 A</p>" },
        { ...baseNote, id: 80, title: "记录 B", contentMarkdown: "正文 B", contentHtml: "<p>正文 B</p>" },
      ],
      unfinishedTodos: [],
      finishedTodos: [],
      projectDocuments: [],
    });
    const coordinator = new RecordSaveCoordinator({
      workspaceKey: "/tmp/workspace",
      adapter: { persist: vi.fn(async () => { throw new Error("save failed"); }) },
    });

    baseRender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RecordSaveCoordinatorProvider coordinator={coordinator}>
        <MemoryRouter initialEntries={["/projects/1/records/70"]}>
          <Routes>
            <Route path="/projects/:projectId/records/:noteId" element={<FocusSwitchHarness />} />
          </Routes>
        </MemoryRouter>
        </RecordSaveCoordinatorProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByDisplayValue("正文 A")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "打开记录 B" }));
    expect(await screen.findByDisplayValue("正文 B")).toBeInTheDocument();
    await waitFor(() => {
      expect(coordinator.getStatus()).toMatchObject({ phase: "error", failedCount: 1 });
    });
    expect(coordinator.getLatestSnapshot("project:1:70")?.committedContent.markdown).toBe(
      "正文 A",
    );
  });
});
