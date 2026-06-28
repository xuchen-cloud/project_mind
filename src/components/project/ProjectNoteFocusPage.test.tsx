import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render as baseRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NoteRecord, ProjectPageData, ProjectRecord } from "../../lib/types";
import { ProjectNoteFocusPage } from "./ProjectNoteFocusPage";

const richEditorMocks = vi.hoisted(() => ({
  focus: vi.fn(),
}));

const noteImageAssetMocks = vi.hoisted(() => ({
  externalizeEmbeddedImageDataUrls: vi.fn(async (value) => value),
}));

const apiMocks = vi.hoisted(() => ({
  projectsList: vi.fn(),
  projectPageGet: vi.fn(),
  fileTagSettingsGet: vi.fn(),
  fileTagOptionUpsert: vi.fn(),
  projectRecordUpsert: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: apiMocks,
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
  }: {
    html?: string;
    controllerRef?: {
      current: {
        getValue: () => { html: string; text: string; markdown: string };
        focus: (position?: "start" | "end" | number) => void;
        save: () => Promise<unknown>;
      } | null;
    };
  }) => {
    const [value] = useState(toPlainText(html ?? ""));
    const valueRef = useRef(value);
    valueRef.current = value;

    useEffect(() => {
      if (!controllerRef) {
        return;
      }

      controllerRef.current = {
        getValue: () => buildMockRichValue(valueRef.current),
        focus: richEditorMocks.focus,
        save: vi.fn(),
      };

      return () => {
        controllerRef.current = null;
      };
    }, [controllerRef]);

    return <textarea aria-label="正文编辑器" value={value} readOnly />;
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

  return baseRender(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/projects/1/records/7"]}>
        <Routes>
          <Route path="/projects/:projectId/records/:noteId" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
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

describe("ProjectNoteFocusPage keyboard flow", () => {
  beforeEach(() => {
    currentNote = { ...baseNote, tags: [] };
    richEditorMocks.focus.mockReset();
    noteImageAssetMocks.externalizeEmbeddedImageDataUrls.mockClear();
    apiMocks.projectsList.mockReset();
    apiMocks.projectPageGet.mockReset();
    apiMocks.fileTagSettingsGet.mockReset();
    apiMocks.fileTagOptionUpsert.mockReset();
    apiMocks.projectRecordUpsert.mockReset();

    apiMocks.projectsList.mockResolvedValue([project]);
    apiMocks.projectPageGet.mockImplementation(async () => buildProjectPage());
    apiMocks.fileTagSettingsGet.mockResolvedValue({ tags: [] });
    apiMocks.fileTagOptionUpsert.mockImplementation(async ({ label }: { label: string }) => ({
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
      expect(apiMocks.fileTagOptionUpsert).toHaveBeenCalledWith({
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
});
