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
import { queryKeys } from "../../lib/queryKeys";
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
  }: {
    html?: string;
    onSave?: (value: { html: string; text: string; markdown: string }) => Promise<unknown>;
    variant?: string;
    showToolbar?: boolean;
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

function render(ui: ReactElement) {
  const queryClient = new QueryClient({
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
    html: `<p>${value}</p>`,
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

  const openRecord = async (targetNoteId: number) => {
    const result = await requestProjectRecordFocusSave({ projectId, noteId });
    if (result === "saved") {
      navigate(`/projects/${projectId}/records/${targetNoteId}`);
    }
  };

  return (
    <>
      <button type="button" onClick={() => void openRecord(70)}>打开记录 A</button>
      <button type="button" onClick={() => void openRecord(80)}>打开记录 B</button>
      <ProjectNoteFocusPage />
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

  it("saves the active record when project sidebar navigation requests a flush", async () => {
    render(<ProjectNoteFocusPage />);

    await screen.findByPlaceholderText("记录标题");
    const scroll = screen.getByTestId("project-record-focus-scroll");
    scroll.scrollTop = 184;

    window.dispatchEvent(
      new CustomEvent(PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT, {
        detail: {
          projectId: 1,
          noteId: 7,
          respond: vi.fn(),
        },
      }),
    );

    await waitFor(() => {
      expect(apiMocks.projectRecordUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          noteId: 7,
          markdown: "正文",
          html: "<p>正文</p>",
        }),
      );
    });
    expect(apiMocks.projectRecordUpsert).toHaveBeenCalledTimes(1);
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
    expect(notes.get(70)?.contentMarkdown).toBe("修改后的正文 A");

    await user.click(screen.getByRole("button", { name: "打开记录 A" }));
    expect(await screen.findByDisplayValue("修改后的正文 A")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("project-record-focus-scroll").scrollTop).toBe(160);
    });
  });

  it("keeps the current focus record open when the switch save fails", async () => {
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
    apiMocks.projectRecordUpsert.mockRejectedValue(new Error("save failed"));

    baseRender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter initialEntries={["/projects/1/records/70"]}>
          <Routes>
            <Route path="/projects/:projectId/records/:noteId" element={<FocusSwitchHarness />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByDisplayValue("正文 A")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "打开记录 B" }));
    await waitFor(() => expect(apiMocks.projectRecordUpsert).toHaveBeenCalledTimes(1));
    expect(screen.getByDisplayValue("正文 A")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("正文 B")).not.toBeInTheDocument();
  });
});
