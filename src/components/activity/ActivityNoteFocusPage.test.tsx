import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActivityCardData, NoteRecord, ProjectListItem, RecordTypeSettingsSnapshot } from "../../lib/types";
import { ActivityNoteFocusPage } from "./ActivityNoteFocusPage";
import {
  createFreshDraftSession,
  resetActivityNoteSessions,
  setActivityNoteSession,
} from "./note-session";

const {
  mockProjectsList,
  mockActivityList,
  mockAiSettingsGet,
  mockRecordTypeSettingsGet,
  mockNoteMutateAsync,
  mockPushToast,
} = vi.hoisted(() => ({
  mockProjectsList: vi.fn(),
  mockActivityList: vi.fn(),
  mockAiSettingsGet: vi.fn(),
  mockRecordTypeSettingsGet: vi.fn(),
  mockNoteMutateAsync: vi.fn(),
  mockPushToast: vi.fn(),
}));

const recordTypeSettings: RecordTypeSettingsSnapshot = {
  recordTypes: [
    {
      id: 1,
      key: "quick_note",
      label: "原始记录",
      colorKey: "slate",
      templateHtml: "<p></p>",
      isDefault: true,
      usageCount: 0,
      createdAt: "",
      updatedAt: "",
    },
  ],
};

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: {
    projectsList: mockProjectsList,
    activityList: mockActivityList,
    aiSettingsGet: mockAiSettingsGet,
    recordTypeSettingsGet: mockRecordTypeSettingsGet,
    documentImport: vi.fn(),
    documentImportNoteImage: vi.fn(),
    documentImportClipboardNoteImage: vi.fn(),
  },
}));

vi.mock("../../hooks/useActivityMutations", () => ({
  useActivityMutations: () => ({
    noteMutation: {
      isPending: false,
      mutateAsync: mockNoteMutateAsync,
    },
  }),
}));

vi.mock("../../hooks/useAiMutations", () => ({
  useAiMutations: () => ({
    aiGenerateMutation: { isPending: false, mutateAsync: vi.fn() },
    aiAcceptMutation: { isPending: false, mutateAsync: vi.fn() },
  }),
}));

vi.mock("../../state/feedback-store", () => ({
  useFeedbackStore: () => ({
    pushToast: mockPushToast,
  }),
}));

vi.mock("../../lib/ai", () => ({
  isAiCapabilityConfigured: vi.fn(() => false),
  visibleAiSuggestionTypes: vi.fn(() => []),
}));

vi.mock("../../services/desktopApi", () => ({
  desktopApi: {
    revealPath: vi.fn(),
  },
}));

vi.mock("../rich-editor", () => ({
  RICH_EDITOR_FOCUS_REQUEST_EVENT: "codex:test-rich-editor-focus",
  normalizeRichEditorValue: (value: {
    html: string;
    text: string;
    markdown: string;
  }) => {
    const normalizedText = value.text.trim();
    const normalizedMarkdown = value.markdown.trim();

    return {
      html: normalizedText ? `<p>${normalizedText}</p>` : "",
      text: normalizedText,
      markdown: normalizedMarkdown,
    };
  },
  RichEditor: ({
    html = "",
    variant,
    autosave,
    onChange,
    onSave,
    onPersistStateChange,
  }: {
    html?: string;
    variant?: string;
    autosave?:
      | boolean
      | {
          onBlur?: boolean;
        };
    onChange?: (value: { html: string; text: string; markdown: string }) => void;
    onSave?: (value: { html: string; text: string; markdown: string }) => Promise<unknown> | unknown;
    onPersistStateChange?: (
      state: "idle" | "dirty" | "saving" | "saved" | "error",
    ) => void;
  }) => {
    const [value, setValue] = useState(stripHtml(html));

    useEffect(() => {
      setValue(stripHtml(html));
      onPersistStateChange?.(stripHtml(html).trim().length > 0 ? "saved" : "idle");
    }, [html, onPersistStateChange]);

    return (
      <div data-testid="mock-rich-editor" data-variant={variant}>
        <textarea
          aria-label="记录编辑器"
          value={value}
          onChange={(event) => {
            const nextValue = event.target.value;
            setValue(nextValue);
            onPersistStateChange?.("dirty");
            onChange?.({
              html: nextValue ? `<p>${nextValue}</p>` : "",
              text: nextValue,
              markdown: nextValue,
            });
          }}
          onBlur={async () => {
            const saveOnBlur =
              typeof autosave === "object" ? (autosave.onBlur ?? true) : Boolean(autosave);

            if (!saveOnBlur) {
              return;
            }

            onPersistStateChange?.("saving");
            await onSave?.({
              html: value ? `<p>${value}</p>` : "",
              text: value,
              markdown: value,
            });
            onPersistStateChange?.(value.trim().length > 0 ? "saved" : "idle");
          }}
        />
      </div>
    );
  },
}));

describe("ActivityNoteFocusPage", () => {
  beforeEach(() => {
    mockProjectsList.mockReset();
    mockActivityList.mockReset();
    mockAiSettingsGet.mockReset();
    mockRecordTypeSettingsGet.mockReset();
    mockNoteMutateAsync.mockReset();
    mockPushToast.mockReset();
    resetActivityNoteSessions();

    mockProjectsList.mockResolvedValue([buildProject()]);
    mockActivityList.mockResolvedValue([buildActivity()]);
    mockAiSettingsGet.mockResolvedValue({});
    mockRecordTypeSettingsGet.mockResolvedValue(recordTypeSettings);
    mockNoteMutateAsync.mockImplementation(async (input: {
      noteId?: number;
      noteType: string;
      title?: string;
      markdown: string;
      html: string;
    }) => ({
      id: input.noteId ?? 101,
      projectId: 9,
      activityId: 11,
      noteType: input.noteType,
      title: input.title ?? null,
      contentMarkdown: input.markdown,
      contentHtml: input.html,
      createdAt: "2026-04-18T08:00:00.000Z",
      updatedAt: "2026-04-18T08:05:00.000Z",
    }));
  });

  it("renders the dedicated note focus page with page editor chrome and no explicit save button", async () => {
    renderFocusPage("/projects/9/activities/11/notes/1");

    expect(await screen.findByTestId("activity-note-focus-page")).toBeInTheDocument();

    const chrome = screen.getByTestId("activity-note-focus-chrome");
    const scroll = screen.getByTestId("activity-note-focus-scroll");
    const titleInput = screen.getByLabelText("记录标题");
    const backButton = screen.getByRole("button", { name: "返回 Activity" });
    const breadcrumbs = screen.getByTestId("activity-note-focus-breadcrumbs");

    expect(chrome).toContainElement(backButton);
    expect(chrome).toContainElement(screen.getByTestId("activity-note-focus-status"));
    expect(chrome).not.toContainElement(titleInput);
    expect(scroll).toContainElement(titleInput);
    expect(breadcrumbs).toHaveTextContent("Project Atlas");
    expect(breadcrumbs).toHaveTextContent("预算讨论");
    expect(breadcrumbs).toHaveTextContent("预算记录");

    expect(titleInput).toHaveValue("预算记录");
    expect(screen.getByTestId("mock-rich-editor")).toHaveAttribute("data-variant", "page");
    expect(screen.getByTestId("activity-note-focus-status")).toHaveTextContent("已保存");
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();

    fireEvent.click(scroll);
    expect(screen.getByTestId("activity-note-focus-page")).toBeInTheDocument();
  });

  it("replaces a draft focus route with the saved note route after the first autosave", async () => {
    const user = userEvent.setup();
    const draftSession = createFreshDraftSession("quick_note", recordTypeSettings);
    setActivityNoteSession(11, draftSession);

    renderFocusPage(
      `/projects/9/activities/11/notes/draft/${draftSession.draftNote?.localId ?? "missing"}`,
    );

    const editor = await screen.findByLabelText("记录编辑器");
    await user.type(editor, "草稿专注页内容");
    fireEvent.blur(editor);

    await waitFor(() =>
      expect(mockNoteMutateAsync).toHaveBeenCalledWith({
        projectId: 9,
        activityId: 11,
        noteType: "quick_note",
        title: "草稿专注页内容",
        markdown: "草稿专注页内容",
        html: "<p>草稿专注页内容</p>",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("location-display")).toHaveTextContent(
        "/projects/9/activities/11/notes/101",
      ),
    );
  });

  it("moves focus from the title into the editor body on Enter and Tab", async () => {
    renderFocusPage("/projects/9/activities/11/notes/1");

    const titleInput = await screen.findByLabelText("记录标题");
    const editor = screen.getByLabelText("记录编辑器");

    titleInput.focus();
    expect(titleInput).toHaveFocus();

    fireEvent.keyDown(titleInput, { key: "Enter" });
    expect(editor).toHaveFocus();

    titleInput.focus();
    expect(titleInput).toHaveFocus();

    fireEvent.keyDown(titleInput, { key: "Tab" });
    expect(editor).toHaveFocus();
  });
});

function renderFocusPage(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LocationDisplay />
        <Routes>
          <Route
            path="/projects/:projectId/activities/:activityId"
            element={<div>activity route</div>}
          />
          <Route
            path="/projects/:projectId/activities/:activityId/notes/:noteId"
            element={<ActivityNoteFocusPage />}
          />
          <Route
            path="/projects/:projectId/activities/:activityId/notes/draft/:draftLocalId"
            element={<ActivityNoteFocusPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location-display">{location.pathname}</div>;
}

function buildProject(): ProjectListItem {
  return {
    id: 9,
    name: "Project Atlas",
    kind: "normal",
    status: "active",
    rootPath: "/tmp/project-atlas",
    summary: "",
    isArchived: false,
    createdAt: "2026-04-18T08:00:00.000Z",
    updatedAt: "2026-04-18T08:00:00.000Z",
    activityCount: 1,
    unorganizedCount: 0,
    openTodoCount: 0,
  };
}

function buildActivity(): ActivityCardData {
  return {
    id: 11,
    projectId: 9,
    attributeOptionId: null,
    attributeLabel: null,
    attributeColorKey: null,
    title: "预算讨论",
    briefMarkdown: "",
    briefHtml: "",
    activityTime: "2026-04-18T08:00:00.000Z",
    statusOptionId: 4,
    statusLabel: "已整理",
    statusColorKey: "green",
    isPinned: false,
    isExpanded: true,
    notes: [
      {
        id: 1,
        projectId: 9,
        activityId: 11,
        noteType: "quick_note",
        title: "预算记录",
        contentMarkdown: "客户确认需要补充上下文",
        contentHtml: "<p>客户确认需要补充上下文</p>",
        createdAt: "2026-04-18T08:00:00.000Z",
        updatedAt: "2026-04-18T08:05:00.000Z",
      } satisfies NoteRecord,
    ],
    conclusions: [],
    documents: [],
    todos: [],
    aiSuggestions: [],
    digest: {
      id: 11,
      projectId: 9,
      title: "预算讨论",
      activityTime: "2026-04-18T08:00:00.000Z",
      attributeOptionId: null,
      attributeLabel: null,
      attributeColorKey: null,
      statusOptionId: 4,
      noteCount: 1,
      conclusionCount: 0,
      todoCount: 0,
      documentCount: 0,
      completedTodoCount: 0,
      totalTodoCount: 0,
      hasOpenTodos: false,
      statusLabel: "已整理",
      statusColorKey: "green",
      isPinned: false,
    },
    createdAt: "2026-04-18T08:00:00.000Z",
    updatedAt: "2026-04-18T08:05:00.000Z",
  };
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, "").trim();
}
