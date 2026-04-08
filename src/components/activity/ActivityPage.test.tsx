import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActivityCardData, ProjectListItem } from "../../lib/types";
import { formatDateTime } from "../../lib/formatters";

const {
  mockProjectsList,
  mockActivityList,
  mockAiSettingsGet,
  mockActivitySettingsGet,
  mockRecordTypeSettingsGet,
  mockAiGenerateMutateAsync,
  mockAiAcceptMutateAsync,
  mockConclusionMutate,
  mockConclusionMutateAsync,
  mockConclusionUpdateMutateAsync,
  mockActivityMetaMutate,
  mockNoteMutateAsync,
  mockOpenSettings,
  mockPushToast,
  mockDocumentImport,
} = vi.hoisted(() => ({
  mockProjectsList: vi.fn(),
  mockActivityList: vi.fn(),
  mockAiSettingsGet: vi.fn(),
  mockActivitySettingsGet: vi.fn(),
  mockRecordTypeSettingsGet: vi.fn(),
  mockAiGenerateMutateAsync: vi.fn(),
  mockAiAcceptMutateAsync: vi.fn(),
  mockConclusionMutate: vi.fn(),
  mockConclusionMutateAsync: vi.fn(),
  mockConclusionUpdateMutateAsync: vi.fn(),
  mockActivityMetaMutate: vi.fn(),
  mockNoteMutateAsync: vi.fn(),
  mockOpenSettings: vi.fn(),
  mockPushToast: vi.fn(),
  mockDocumentImport: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: {
    projectsList: mockProjectsList,
    activityList: mockActivityList,
    aiSettingsGet: mockAiSettingsGet,
    activitySettingsGet: mockActivitySettingsGet,
    recordTypeSettingsGet: mockRecordTypeSettingsGet,
    documentImport: mockDocumentImport,
  },
}));

vi.mock("../../services/desktopApi", () => ({
  desktopApi: {
    pickFile: vi.fn(),
    revealPath: vi.fn(),
    toFileUrl: vi.fn((path: string) => `file://${path}`),
  },
}));

vi.mock("../../hooks/useActivityMutations", () => ({
  useActivityMutations: () => ({
    activityMetaMutation: { mutate: mockActivityMetaMutate },
    noteMutation: { isPending: false, mutateAsync: mockNoteMutateAsync },
    conclusionMutation: {
      isPending: false,
      mutate: mockConclusionMutate,
      mutateAsync: mockConclusionMutateAsync,
    },
    conclusionUpdateMutation: {
      isPending: false,
      mutateAsync: mockConclusionUpdateMutateAsync,
    },
  }),
}));

vi.mock("../../hooks/useAiMutations", () => ({
  useAiMutations: () => ({
    aiGenerateMutation: { isPending: false, mutateAsync: mockAiGenerateMutateAsync },
    aiAcceptMutation: { isPending: false, mutateAsync: mockAiAcceptMutateAsync },
  }),
}));

vi.mock("../../hooks/useDocumentMutations", () => ({
  useDocumentMutations: () => ({
    documentImportMutation: { mutate: vi.fn() },
    documentMetaMutation: { mutate: vi.fn() },
    documentRelocateMutation: { mutate: vi.fn() },
    documentAddVersionMutation: { mutate: vi.fn() },
  }),
}));

vi.mock("../../hooks/useTodoMutations", () => ({
  useTodoMutations: () => ({
    todoMutation: { mutate: vi.fn() },
    todoContentMutation: { mutateAsync: vi.fn() },
    todoStatusMutation: { mutateAsync: vi.fn() },
    todoPriorityMutation: { mutateAsync: vi.fn() },
    todoProgressMutation: { mutateAsync: vi.fn() },
  }),
}));

vi.mock("../../hooks/useUtilityHooks", () => ({
  useFocusTarget: vi.fn(),
}));

vi.mock("../../state/feedback-store", () => ({
  useFeedbackStore: () => ({
    pushToast: mockPushToast,
  }),
}));

vi.mock("../../state/ui-store", () => ({
  useUiStore: () => ({
    openSettings: mockOpenSettings,
  }),
}));

vi.mock("../../lib/ai", () => ({
  isAiCapabilityConfigured: vi.fn(() => true),
}));

vi.mock("../layout/ProjectSidebar", () => ({
  ProjectSidebar: () => <div data-testid="project-sidebar" />,
}));

vi.mock("../todo", () => ({
  TodoRail: () => <div data-testid="todo-rail" />,
}));

vi.mock("../document/ManagedDocumentSection", () => ({
  ManagedDocumentSection: () => <div data-testid="managed-document-section" />,
}));

vi.mock("../rich-editor", () => ({
  EMPTY_RICH_EDITOR_HTML: "",
  normalizeRichEditorValue: (value: { html: string; text: string; markdown: string }) => {
    const normalizedText = value.text.trim();
    const normalizedMarkdown = value.markdown.trim();

    return {
      html: toHtml(normalizedText),
      text: normalizedText,
      markdown: normalizedMarkdown,
    };
  },
  getRenderableRichTextHtml: ({
    html,
    markdown,
  }: {
    html?: string;
    markdown?: string;
  }) => html ?? markdown ?? "",
  RichEditor: ({
    html = "",
    onChange,
    placeholder,
    readOnly,
  }: {
    html?: string;
    placeholder?: string;
    readOnly?: boolean;
    onChange?: (value: { html: string; text: string; markdown: string }) => void;
  }) => {
    const value = toPlainText(html);

    if (readOnly) {
      return <div>{value}</div>;
    }

    return (
      <textarea
        aria-label="结论编辑器"
        placeholder={placeholder}
        value={value}
        onChange={(event) => {
          const nextValue = event.target.value;
          onChange?.({
            html: toHtml(nextValue),
            text: nextValue,
            markdown: nextValue,
          });
        }}
      />
    );
  },
}));

vi.mock("./ActivityNotesPanel", () => ({
  ActivityNotesPanel: () => (
    <section data-testid="activity-notes-panel">
      <div data-testid="activity-notes-editor">记录编辑器区</div>
      <div data-testid="activity-notes-results">记录结果</div>
    </section>
  ),
}));

import { ActivityPage } from "./ActivityPage";

describe("ActivityPage", () => {
  beforeEach(() => {
    mockProjectsList.mockReset();
    mockActivityList.mockReset();
    mockAiSettingsGet.mockReset();
    mockActivitySettingsGet.mockReset();
    mockRecordTypeSettingsGet.mockReset();
    mockAiGenerateMutateAsync.mockReset();
    mockAiAcceptMutateAsync.mockReset();
    mockConclusionMutate.mockReset();
    mockConclusionMutateAsync.mockReset();
    mockConclusionUpdateMutateAsync.mockReset();
    mockActivityMetaMutate.mockReset();
    mockNoteMutateAsync.mockReset();
    mockOpenSettings.mockReset();
    mockPushToast.mockReset();
    mockDocumentImport.mockReset();

    mockProjectsList.mockResolvedValue([buildProject()]);
    mockActivityList.mockResolvedValue([buildActivity()]);
    mockAiSettingsGet.mockResolvedValue({});
    mockActivitySettingsGet.mockResolvedValue({
      activityAttributeOptions: [
        { id: 1, label: "MEETING", colorKey: "blue", createdAt: "", updatedAt: "" },
        { id: 2, label: "LEGAL", colorKey: "amber", createdAt: "", updatedAt: "" },
      ],
      activityStatusOptions: [
        { id: 3, label: "待启动", colorKey: "amber", isSystem: true, createdAt: "", updatedAt: "" },
        { id: 4, label: "已整理", colorKey: "green", isSystem: false, createdAt: "", updatedAt: "" },
        { id: 5, label: "待法务确认", colorKey: "orange", isSystem: false, createdAt: "", updatedAt: "" },
      ],
    });
    mockRecordTypeSettingsGet.mockResolvedValue({
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
        {
          id: 2,
          key: "meeting_minutes",
          label: "会议记录",
          colorKey: "blue",
          templateHtml: "<h2>背景</h2><p></p>",
          isDefault: false,
          usageCount: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
    });
    mockDocumentImport.mockResolvedValue(buildDocumentRecord());
    mockConclusionMutateAsync.mockResolvedValue({
      id: 22,
      projectId: 9,
      activityId: 11,
      noteId: null,
      contentMarkdown: "新增的活动结论",
      contentHtml: "<p>新增的活动结论</p>",
      promotedToProject: true,
      sourceActivityTitle: "预算讨论",
      createdAt: "2026-04-06T10:40:00.000Z",
      updatedAt: "2026-04-06T10:40:00.000Z",
    });
    mockConclusionUpdateMutateAsync.mockResolvedValue({
      ...buildActivity().conclusions[0],
      contentMarkdown: "调整后的活动结论",
      contentHtml: "<p>调整后的活动结论</p>",
    });
  });

  it("renders record results under the editor and places documents above conclusions", async () => {
    const user = userEvent.setup();

    renderActivityPage();

    expect(await screen.findByText("文件材料")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新增结论" })).toBeInTheDocument();
    expect(screen.getByText("当前结论")).toBeInTheDocument();
    expect(screen.getByText("已确认预算分配方案")).toBeInTheDocument();
    expect(screen.getByText("1 条")).toBeInTheDocument();
    expect(screen.queryByText("结论列表")).not.toBeInTheDocument();
    expect(screen.queryByText("AI 辅助提炼")).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("记录已确认的判断、共识或决定。"),
    ).not.toBeInTheDocument();

    const notesPanel = screen.getByTestId("activity-notes-panel");
    const editorBlock = screen.getByTestId("activity-notes-editor");
    const resultsBlock = screen.getByTestId("activity-notes-results");
    expect(notesPanel.compareDocumentPosition(resultsBlock) & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeTruthy();
    expect(editorBlock.compareDocumentPosition(resultsBlock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const documentsHeading = screen.getByRole("heading", { name: "文件材料" });
    const conclusionsHeading = screen.getByRole("heading", { name: "结论" });
    expect(
      documentsHeading.compareDocumentPosition(conclusionsHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "新增结论" }));
    await user.type(screen.getByPlaceholderText("记录已确认的判断、共识或决定。"), "新增的活动结论");
    await user.click(screen.getByRole("button", { name: "保存结论" }));

    expect(mockConclusionMutateAsync).toHaveBeenCalledWith({
      projectId: 9,
      activityId: 11,
      markdown: "新增的活动结论",
      html: "<p>新增的活动结论</p>",
      promotedToProject: true,
    });

    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText("记录已确认的判断、共识或决定。"),
      ).not.toBeInTheDocument(),
    );
  });

  it("renders editable header tags and removes the old review button", async () => {
    const user = userEvent.setup();

    renderActivityPage();

    expect(await screen.findByRole("heading", { name: "预算讨论" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "MEETING" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "已整理" })).toBeInTheDocument();
    expect(screen.getByText(formatDateTime(buildActivity().activityTime))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "标记待复核" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /固定|取消固定/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "MEETING" }));
    await user.click(screen.getByRole("button", { name: "LEGAL" }));

    expect(mockActivityMetaMutate).toHaveBeenCalledWith({
      activityId: 11,
      attributeOptionId: 2,
    });

    await user.click(screen.getByRole("button", { name: "已整理" }));
    await user.click(screen.getByRole("button", { name: "待法务确认" }));

    expect(mockActivityMetaMutate).toHaveBeenCalledWith({
      activityId: 11,
      statusOptionId: 5,
    });
  });

  it("trims boundary blank lines and spaces before saving a conclusion", async () => {
    const user = userEvent.setup();

    renderActivityPage();

    await screen.findByRole("button", { name: "新增结论" });
    await user.click(screen.getByRole("button", { name: "新增结论" }));

    await user.type(
      screen.getByPlaceholderText("记录已确认的判断、共识或决定。"),
      "  新增的活动结论  ",
    );
    await user.click(screen.getByRole("button", { name: "保存结论" }));

    expect(mockConclusionMutateAsync).toHaveBeenCalledWith({
      projectId: 9,
      activityId: 11,
      markdown: "新增的活动结论",
      html: "<p>新增的活动结论</p>",
      promotedToProject: true,
    });
  });

  it("edits an existing conclusion in place", async () => {
    const user = userEvent.setup();

    renderActivityPage();

    await user.click(await screen.findByRole("button", { name: "编辑" }));
    const editor = screen.getByLabelText("结论编辑器");
    await user.clear(editor);
    await user.type(editor, "调整后的活动结论");
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    expect(mockConclusionUpdateMutateAsync).toHaveBeenCalledWith({
      conclusionId: 21,
      markdown: "调整后的活动结论",
      html: "<p>调整后的活动结论</p>",
      promotedToProject: true,
    });
  });

  it("imports dropped files into the current activity from anywhere on the page", async () => {
    renderActivityPage();

    await screen.findByText("文件材料");

    const dropZone = screen.getByTestId("activity-page-dropzone");

    fireEvent.dragOver(dropZone, {
      dataTransfer: {
        files: [{ path: "/tmp/project-atlas/inbox/brief.pdf" }],
      },
    });

    fireEvent.drop(dropZone, {
      dataTransfer: {
        files: [{ path: "/tmp/project-atlas/inbox/brief.pdf" }],
      },
    });

    await waitFor(() =>
      expect(mockDocumentImport).toHaveBeenCalledWith({
        projectId: 9,
        activityId: 11,
        sourcePath: "/tmp/project-atlas/inbox/brief.pdf",
        isStarred: false,
      }),
    );
  });
});

function renderActivityPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/projects/9/activities/11"]}>
        <Routes>
          <Route path="/projects/:projectId/activities/:activityId" element={<ActivityPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function buildProject(): ProjectListItem {
  return {
    id: 9,
    name: "Project Atlas",
    status: "active",
    rootPath: "/tmp/project-atlas",
    fileLayoutVersion: 1,
    summary: "",
    isArchived: false,
    createdAt: "2026-04-06T08:00:00.000Z",
    updatedAt: "2026-04-06T09:00:00.000Z",
    activityCount: 1,
    unorganizedCount: 0,
    openTodoCount: 0,
  };
}

function buildActivity(): ActivityCardData {
  return {
    id: 11,
    projectId: 9,
    attributeOptionId: 1,
    attributeLabel: "MEETING",
    attributeColorKey: "blue",
    title: "预算讨论",
    activityTime: "2026-04-06T10:00:00.000Z",
    statusOptionId: 4,
    statusLabel: "已整理",
    statusColorKey: "green",
    isPinned: false,
    isExpanded: true,
    createdAt: "2026-04-06T10:00:00.000Z",
    updatedAt: "2026-04-06T10:30:00.000Z",
    digest: {
      id: 11,
      projectId: 9,
      attributeOptionId: 1,
      attributeLabel: "MEETING",
      attributeColorKey: "blue",
      title: "预算讨论",
      activityTime: "2026-04-06T10:00:00.000Z",
      statusOptionId: 4,
      statusLabel: "已整理",
      statusColorKey: "green",
      isPinned: false,
      noteCount: 0,
      conclusionCount: 1,
      todoCount: 0,
      documentCount: 0,
      completedTodoCount: 0,
      totalTodoCount: 0,
      hasOpenTodos: false,
    },
    notes: [],
    conclusions: [
      {
        id: 21,
        projectId: 9,
        activityId: 11,
        noteId: null,
        contentMarkdown: "已确认预算分配方案",
        contentHtml: "<p>已确认预算分配方案</p>",
        promotedToProject: true,
        sourceActivityTitle: "预算讨论",
        createdAt: "2026-04-06T10:20:00.000Z",
        updatedAt: "2026-04-06T10:25:00.000Z",
      },
    ],
    todos: [],
    documents: [],
    aiSuggestions: [],
  };
}

function toPlainText(value: string) {
  return value.replace(/<[^>]+>/g, "");
}

function toHtml(value: string) {
  return value ? `<p>${value}</p>` : "";
}

function buildDocumentRecord() {
  return {
    id: 31,
    projectId: 9,
    activityId: 11,
    name: "brief.pdf",
    baseName: "brief.pdf",
    originalPath: "/tmp/project-atlas/inbox/brief.pdf",
    managedPath: "/tmp/project-atlas/activities/预算讨论/brief.pdf",
    historyDirPath: "/tmp/project-atlas/.versions/31",
    storageMode: "managed_copy" as const,
    mimeType: "application/pdf",
    isStarred: false,
    currentVersionNumber: 1,
    versionCount: 1,
    sourceActivityTitle: "预算讨论",
    health: "normal" as const,
    tags: [],
    createdAt: "2026-04-06T10:20:00.000Z",
    updatedAt: "2026-04-06T10:20:00.000Z",
  };
}
