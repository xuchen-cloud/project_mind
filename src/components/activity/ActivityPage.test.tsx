import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
  mockFileTagSettingsGet,
  mockAiGenerateMutateAsync,
  mockAiAcceptMutateAsync,
  mockConclusionMutate,
  mockConclusionMutateAsync,
  mockConclusionUpdateMutateAsync,
  mockConclusionDeleteMutateAsync,
  mockActivityMetaMutate,
  mockNoteMutateAsync,
  mockNoteDeleteMutateAsync,
  mockOpenSettings,
  mockPushToast,
  mockSetStatus,
  mockDocumentImport,
  mockDocumentImportNoteImage,
  mockDocumentImportClipboardNoteImage,
  mockTodoDeleteMutateAsync,
  mockIsAiCapabilityConfigured,
  mockIsAiFeatureReady,
  mockIsAiFeatureVisible,
  mockVisibleAiSuggestionTypes,
} = vi.hoisted(() => ({
  mockProjectsList: vi.fn(),
  mockActivityList: vi.fn(),
  mockAiSettingsGet: vi.fn(),
  mockActivitySettingsGet: vi.fn(),
  mockRecordTypeSettingsGet: vi.fn(),
  mockFileTagSettingsGet: vi.fn(),
  mockAiGenerateMutateAsync: vi.fn(),
  mockAiAcceptMutateAsync: vi.fn(),
  mockConclusionMutate: vi.fn(),
  mockConclusionMutateAsync: vi.fn(),
  mockConclusionUpdateMutateAsync: vi.fn(),
  mockConclusionDeleteMutateAsync: vi.fn(),
  mockActivityMetaMutate: vi.fn(),
  mockNoteMutateAsync: vi.fn(),
  mockNoteDeleteMutateAsync: vi.fn(),
  mockOpenSettings: vi.fn(),
  mockPushToast: vi.fn(),
  mockSetStatus: vi.fn(),
  mockDocumentImport: vi.fn(),
  mockDocumentImportNoteImage: vi.fn(),
  mockDocumentImportClipboardNoteImage: vi.fn(),
  mockTodoDeleteMutateAsync: vi.fn(),
  mockIsAiCapabilityConfigured: vi.fn((..._args: unknown[]) => true),
  mockIsAiFeatureReady: vi.fn((..._args: unknown[]) => true),
  mockIsAiFeatureVisible: vi.fn((..._args: unknown[]) => true),
  mockVisibleAiSuggestionTypes: vi.fn(
    (..._args: unknown[]) =>
      ["conclusion", "todo"] as Array<"conclusion" | "todo">,
  ),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: {
    projectsList: mockProjectsList,
    activityList: mockActivityList,
    aiSettingsGet: mockAiSettingsGet,
    activitySettingsGet: mockActivitySettingsGet,
    recordTypeSettingsGet: mockRecordTypeSettingsGet,
    fileTagSettingsGet: mockFileTagSettingsGet,
    documentImport: mockDocumentImport,
    documentImportNoteImage: mockDocumentImportNoteImage,
    documentImportClipboardNoteImage: mockDocumentImportClipboardNoteImage,
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
    activityMetaMutation: { isPending: false, mutate: mockActivityMetaMutate },
    noteMutation: { isPending: false, mutateAsync: mockNoteMutateAsync },
    noteDeleteMutation: {
      isPending: false,
      mutateAsync: mockNoteDeleteMutateAsync,
    },
    conclusionMutation: {
      isPending: false,
      mutate: mockConclusionMutate,
      mutateAsync: mockConclusionMutateAsync,
    },
    conclusionUpdateMutation: {
      isPending: false,
      mutateAsync: mockConclusionUpdateMutateAsync,
    },
    conclusionDeleteMutation: {
      isPending: false,
      mutateAsync: mockConclusionDeleteMutateAsync,
    },
  }),
}));

vi.mock("../../hooks/useAiMutations", () => ({
  useAiMutations: () => ({
    aiGenerateMutation: {
      isPending: false,
      mutateAsync: mockAiGenerateMutateAsync,
    },
    aiAcceptMutation: {
      isPending: false,
      mutateAsync: mockAiAcceptMutateAsync,
    },
  }),
}));

vi.mock("../../hooks/useDocumentMutations", () => ({
  useDocumentMutations: () => ({
    documentImportMutation: { mutate: vi.fn() },
    documentMetaMutation: { mutate: vi.fn() },
    documentRelocateMutation: { mutate: vi.fn() },
    documentAddVersionMutation: { mutate: vi.fn(), mutateAsync: vi.fn() },
    documentDeleteMutation: { mutate: vi.fn(), isPending: false },
  }),
}));

vi.mock("../../hooks/useTodoMutations", () => ({
  useTodoMutations: () => ({
    todoMutation: { mutate: vi.fn() },
    todoContentMutation: { mutateAsync: vi.fn() },
    todoStatusMutation: { mutateAsync: vi.fn() },
    todoPriorityMutation: { mutateAsync: vi.fn() },
    todoProgressMutation: { mutateAsync: vi.fn() },
    todoDeleteMutation: { mutateAsync: mockTodoDeleteMutateAsync },
  }),
}));

vi.mock("../../hooks/useUtilityHooks", () => ({
  useFocusTarget: vi.fn(),
}));

vi.mock("../../state/feedback-store", () => ({
  useFeedbackStore: () => ({
    setStatus: mockSetStatus,
    pushToast: mockPushToast,
  }),
}));

vi.mock("../../state/ui-store", () => ({
  useUiStore: (
    selector?:
      | ((state: { openSettings: typeof mockOpenSettings }) => unknown)
      | undefined,
  ) => {
    const state = {
      openSettings: mockOpenSettings,
    };

    return selector ? selector(state) : state;
  },
}));

vi.mock("../../lib/ai", () => ({
  isAiCapabilityConfigured: mockIsAiCapabilityConfigured,
  isAiFeatureReady: mockIsAiFeatureReady,
  isAiFeatureVisible: mockIsAiFeatureVisible,
  visibleAiSuggestionTypes: mockVisibleAiSuggestionTypes,
}));

vi.mock("../layout/ProjectSidebar", () => ({
  ProjectSidebar: () => <div data-testid="project-sidebar" />,
}));

vi.mock("../todo", () => ({
  TodoRail: () => <div data-testid="todo-rail" />,
}));

vi.mock("../document/ManagedDocumentSection", () => ({
  ManagedDocumentSection: ({
    documents,
  }: {
    documents: Array<{ name: string }>;
  }) => (
    <div data-testid="managed-document-section">
      <div data-testid="managed-document-count">{documents.length}</div>
      {documents.map((document) => (
        <div key={document.name}>{document.name}</div>
      ))}
    </div>
  ),
}));

vi.mock("../rich-editor", () => ({
  EMPTY_RICH_EDITOR_HTML: "",
  normalizeRichEditorValue: (value: {
    html: string;
    text: string;
    markdown: string;
  }) => {
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
    onChange?: (value: {
      html: string;
      text: string;
      markdown: string;
    }) => void;
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
  ActivityNotesPanel: (props: {
    onDeleteNote?: (noteId: number) => Promise<unknown> | unknown;
    onImportImage?: (sourcePath: string) => Promise<unknown>;
    onImportDocument?: (sourcePath: string) => Promise<unknown>;
    onImportClipboardImage?: (file: File) => Promise<unknown>;
  }) => {
    return (
      <section data-testid="activity-notes-panel">
        <div data-testid="activity-notes-editor">记录编辑器区</div>
        <div data-testid="activity-notes-results">记录结果</div>
        <button
          type="button"
          onClick={() => {
            void props.onImportImage?.("/tmp/project-atlas/inbox/clip.png");
          }}
        >
          触发图片导入
        </button>
      <button
        type="button"
        onClick={() => {
          const pastedFile = new File(["fake"], "pasted-image.png", { type: "image/png" });
          Object.defineProperty(pastedFile, "arrayBuffer", {
            value: async () => new TextEncoder().encode("fake").buffer,
          });
          void props.onImportClipboardImage?.(
            pastedFile,
          );
        }}
      >
          触发粘贴图片导入
        </button>
        <button
          type="button"
          onClick={() => {
            void props.onDeleteNote?.(21);
          }}
        >
          触发记录删除
        </button>
      </section>
    );
  },
}));

vi.mock("../ai/AiArtifactCard", () => ({
  AiArtifactCard: () => (
    <section data-testid="ai-artifact-card">AI Artifact</section>
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
    mockFileTagSettingsGet.mockReset();
    mockAiGenerateMutateAsync.mockReset();
    mockAiAcceptMutateAsync.mockReset();
    mockConclusionMutate.mockReset();
    mockConclusionMutateAsync.mockReset();
    mockConclusionUpdateMutateAsync.mockReset();
    mockConclusionDeleteMutateAsync.mockReset();
    mockActivityMetaMutate.mockReset();
    mockNoteMutateAsync.mockReset();
    mockNoteDeleteMutateAsync.mockReset();
    mockOpenSettings.mockReset();
    mockPushToast.mockReset();
    mockSetStatus.mockReset();
    mockDocumentImport.mockReset();
    mockDocumentImportNoteImage.mockReset();
    mockDocumentImportClipboardNoteImage.mockReset();
    mockTodoDeleteMutateAsync.mockReset();
    mockIsAiCapabilityConfigured.mockReset();
    mockIsAiFeatureReady.mockReset();
    mockIsAiFeatureVisible.mockReset();
    mockVisibleAiSuggestionTypes.mockReset();
    mockIsAiCapabilityConfigured.mockReturnValue(true);
    mockIsAiFeatureReady.mockReturnValue(true);
    mockIsAiFeatureVisible.mockReturnValue(true);
    mockVisibleAiSuggestionTypes.mockReturnValue(["conclusion", "todo"]);

    mockProjectsList.mockResolvedValue([buildProject()]);
    mockActivityList.mockResolvedValue([buildActivity()]);
    mockAiSettingsGet.mockResolvedValue({});
    mockActivitySettingsGet.mockResolvedValue({
      activityAttributeOptions: [
        {
          id: 1,
          label: "MEETING",
          colorKey: "blue",
          createdAt: "",
          updatedAt: "",
        },
        {
          id: 2,
          label: "LEGAL",
          colorKey: "amber",
          createdAt: "",
          updatedAt: "",
        },
      ],
      activityStatusOptions: [
        {
          id: 3,
          label: "待启动",
          colorKey: "amber",
          isSystem: true,
          createdAt: "",
          updatedAt: "",
        },
        {
          id: 4,
          label: "已整理",
          colorKey: "green",
          isSystem: false,
          createdAt: "",
          updatedAt: "",
        },
        {
          id: 5,
          label: "待法务确认",
          colorKey: "orange",
          isSystem: false,
          createdAt: "",
          updatedAt: "",
        },
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
    mockFileTagSettingsGet.mockResolvedValue({ tags: [] });
    mockDocumentImport.mockResolvedValue(buildDocumentRecord());
    mockDocumentImportNoteImage.mockResolvedValue(
      buildDocumentRecord({
        id: 41,
        name: "clip.png",
        baseName: "clip.png",
        originalPath: "/tmp/project-atlas/inbox/clip.png",
        managedPath:
          "/tmp/project-atlas/.project-mind/embedded-note-assets/activity-11/clip.png",
        historyDirPath:
          "/tmp/project-atlas/.project-mind/embedded-note-assets/activity-11/.41.pm-versions",
        storageMode: "managed_copy" as const,
        mimeType: "image/png",
      }),
    );
    mockDocumentImportClipboardNoteImage.mockResolvedValue(
      buildDocumentRecord({
        id: 42,
        name: "clipboard-image-20260412090000.png",
        baseName: "clipboard-image-20260412090000.png",
        originalPath:
          "/tmp/project-atlas/.project-mind/embedded-note-assets/activity-11/clipboard-image-20260412090000.png",
        managedPath:
          "/tmp/project-atlas/.project-mind/embedded-note-assets/activity-11/clipboard-image-20260412090000.png",
        historyDirPath:
          "/tmp/project-atlas/.project-mind/embedded-note-assets/activity-11/.42.pm-versions",
        storageMode: "managed_copy" as const,
        mimeType: "image/png",
      }),
    );
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
    expect(
      screen.getByRole("button", { name: "新增结论" }),
    ).toBeInTheDocument();
    expect(screen.getByText("已确认预算分配方案")).toBeInTheDocument();
    expect(screen.queryByText("结论列表")).not.toBeInTheDocument();
    expect(screen.queryByText("AI 辅助提炼")).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("记录已确认的判断、共识或决定。"),
    ).not.toBeInTheDocument();

    const notesPanel = screen.getByTestId("activity-notes-panel");
    const editorBlock = screen.getByTestId("activity-notes-editor");
    const resultsBlock = screen.getByTestId("activity-notes-results");
    expect(
      notesPanel.compareDocumentPosition(resultsBlock) &
        Node.DOCUMENT_POSITION_CONTAINED_BY,
    ).toBeTruthy();
    expect(
      editorBlock.compareDocumentPosition(resultsBlock) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const documentsHeading = screen.getByRole("heading", { name: "文件材料" });
    const conclusionsHeading = screen.getByRole("heading", { name: "结论" });
    expect(
      documentsHeading.compareDocumentPosition(conclusionsHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "新增结论" }));
    await user.type(
      screen.getByPlaceholderText("记录已确认的判断、共识或决定。"),
      "新增的活动结论",
    );
    expect(
      screen.queryByRole("button", { name: "保存结论" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "取消" }),
    ).not.toBeInTheDocument();
    fireEvent.blur(
      screen.getByPlaceholderText("记录已确认的判断、共识或决定。"),
    );

    expect(mockConclusionMutateAsync).toHaveBeenCalledWith({
      projectId: 9,
      activityId: 11,
      markdown: "新增的活动结论",
      html: "<p>新增的活动结论</p>",
      promotedToProject: false,
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

    expect(
      await screen.findByRole("heading", { name: "预算讨论" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "MEETING" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "已整理" })).toBeInTheDocument();
    expect(screen.getByLabelText("文件 0")).toBeInTheDocument();
    expect(screen.getByLabelText("结论 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Todo 0/0")).toBeInTheDocument();
    expect(
      screen.getByText(formatDateTime(buildActivity().activityTime)),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "标记待复核" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /置顶|取消置顶/ }),
    ).not.toBeInTheDocument();

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

  it("wires note deletion through the notes panel", async () => {
    const user = userEvent.setup();

    renderActivityPage();

    await user.click(await screen.findByRole("button", { name: "触发记录删除" }));

    expect(mockNoteDeleteMutateAsync).toHaveBeenCalledWith({
      noteId: 21,
    });
  });

  it("places the activity attribute control before the activity title", async () => {
    renderActivityPage();

    const heading = await screen.findByRole("heading", { name: "预算讨论" });
    const headerBlock = heading.parentElement;
    expect(headerBlock).not.toBeNull();

    const attributeButton = within(headerBlock as HTMLElement).getByRole(
      "button",
      { name: "MEETING" },
    );
    const titleButton = within(headerBlock as HTMLElement).getByRole("button", {
      name: "预算讨论",
    });
    expect(
      attributeButton.compareDocumentPosition(titleButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("still shows the unassigned attribute control on the activity page when no attribute is set", async () => {
    mockActivityList.mockResolvedValue([
      {
        ...buildActivity(),
        attributeOptionId: null,
        attributeLabel: null,
        attributeColorKey: null,
        digest: {
          ...buildActivity().digest,
          attributeOptionId: null,
          attributeLabel: null,
          attributeColorKey: null,
        },
      },
    ]);

    renderActivityPage();

    expect(
      await screen.findByRole("button", { name: "未设置属性" }),
    ).toBeInTheDocument();
  });

  it("opens the activity title in edit mode for a newly created activity route", async () => {
    renderActivityPage({
      initialEntries: ["/projects/9/activities/11?focus=activity-title"],
    });

    expect(await screen.findByLabelText("Activity 名称")).toHaveFocus();
    expect(screen.getByDisplayValue("预算讨论")).toBeInTheDocument();
  });

  it("edits the activity title inline and saves on submit", async () => {
    const user = userEvent.setup();

    renderActivityPage();

    await user.click(await screen.findByRole("button", { name: "预算讨论" }));
    await user.clear(screen.getByLabelText("Activity 名称"));
    await user.type(
      screen.getByLabelText("Activity 名称"),
      "预算同步会{Enter}",
    );

    expect(mockActivityMetaMutate).toHaveBeenCalledWith({
      activityId: 11,
      title: "预算同步会",
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
    fireEvent.blur(
      screen.getByPlaceholderText("记录已确认的判断、共识或决定。"),
    );

    expect(mockConclusionMutateAsync).toHaveBeenCalledWith({
      projectId: 9,
      activityId: 11,
      markdown: "新增的活动结论",
      html: "<p>新增的活动结论</p>",
      promotedToProject: false,
    });
  });

  it("creates a new conclusion without showing a visible star control", async () => {
    const user = userEvent.setup();

    renderActivityPage();

    await screen.findByRole("button", { name: "新增结论" });
    await user.click(screen.getByRole("button", { name: "新增结论" }));
    await user.type(
      screen.getByPlaceholderText("记录已确认的判断、共识或决定。"),
      "只保留在活动内",
    );
    expect(
      screen.queryByRole("button", { name: /项目级标星|取消项目级标星/ }),
    ).not.toBeInTheDocument();
    fireEvent.blur(
      screen.getByPlaceholderText("记录已确认的判断、共识或决定。"),
    );

    expect(mockConclusionMutateAsync).toHaveBeenCalledWith({
      projectId: 9,
      activityId: 11,
      markdown: "只保留在活动内",
      html: "<p>只保留在活动内</p>",
      promotedToProject: false,
    });
  });

  it("hides the empty conclusion state while the composer is open", async () => {
    const user = userEvent.setup();
    mockActivityList.mockResolvedValue([
      {
        ...buildActivity(),
        digest: {
          ...buildActivity().digest,
          conclusionCount: 0,
        },
        conclusions: [],
      },
    ]);

    renderActivityPage();

    expect(await screen.findByText("还没有结论。")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "新增结论" }));

    expect(
      screen.getByPlaceholderText("记录已确认的判断、共识或决定。"),
    ).toBeInTheDocument();
    expect(screen.queryByText("还没有结论。")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "保存结论" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "取消" }),
    ).not.toBeInTheDocument();
  });

  it("edits an existing conclusion in place", async () => {
    const user = userEvent.setup();

    renderActivityPage();

    expect(
      screen.queryByRole("button", { name: "编辑" }),
    ).not.toBeInTheDocument();
    await user.click(await screen.findByText("已确认预算分配方案"));
    const editor = screen.getByLabelText("结论编辑器");
    expect(
      screen.queryByRole("button", { name: "保存修改" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "取消" }),
    ).not.toBeInTheDocument();
    await user.clear(editor);
    await user.type(editor, "调整后的活动结论");
    fireEvent.blur(editor);

    expect(mockConclusionUpdateMutateAsync).toHaveBeenCalledWith({
      conclusionId: 21,
      markdown: "调整后的活动结论",
      html: "<p>调整后的活动结论</p>",
      promotedToProject: true,
    });
  });

  it("saves the current conclusion before switching to another one", async () => {
    const user = userEvent.setup();

    mockActivityList.mockResolvedValue([
      buildActivityWithConclusions([
        buildActivityConclusion(21, "第一条结论", true),
        buildActivityConclusion(22, "第二条结论", false),
      ]),
    ]);

    renderActivityPage();

    await user.click(await screen.findByText("第一条结论"));
    await user.clear(screen.getByLabelText("结论编辑器"));
    await user.type(screen.getByLabelText("结论编辑器"), "更新后的第一条结论");
    await user.click(screen.getByText("第二条结论"));

    expect(mockConclusionUpdateMutateAsync).toHaveBeenCalledWith({
      conclusionId: 21,
      markdown: "更新后的第一条结论",
      html: "<p>更新后的第一条结论</p>",
      promotedToProject: true,
    });
    expect(screen.getByDisplayValue("第二条结论")).toBeInTheDocument();
    expect(screen.getAllByLabelText("结论编辑器")).toHaveLength(1);
  });

  it("closes an empty new conclusion draft before activating another conclusion", async () => {
    const user = userEvent.setup();

    mockActivityList.mockResolvedValue([
      buildActivityWithConclusions([
        buildActivityConclusion(21, "第一条结论", true),
      ]),
    ]);

    renderActivityPage();

    await user.click(await screen.findByRole("button", { name: "新增结论" }));
    expect(
      screen.getByPlaceholderText("记录已确认的判断、共识或决定。"),
    ).toBeInTheDocument();

    await user.click(screen.getByText("第一条结论"));

    expect(mockConclusionMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("第一条结论")).toBeInTheDocument();
    expect(screen.getAllByLabelText("结论编辑器")).toHaveLength(1);
  });

  it("creates a non-empty new conclusion before switching to another conclusion", async () => {
    const user = userEvent.setup();

    mockActivityList.mockResolvedValue([
      buildActivityWithConclusions([
        buildActivityConclusion(21, "第一条结论", true),
      ]),
    ]);

    renderActivityPage();

    await user.click(await screen.findByRole("button", { name: "新增结论" }));
    await user.type(screen.getByLabelText("结论编辑器"), "待保存的新结论");
    await user.click(screen.getByText("第一条结论"));

    expect(mockConclusionMutateAsync).toHaveBeenCalledWith({
      projectId: 9,
      activityId: 11,
      markdown: "待保存的新结论",
      html: "<p>待保存的新结论</p>",
      promotedToProject: false,
    });
    expect(screen.getByDisplayValue("第一条结论")).toBeInTheDocument();
    expect(screen.getAllByLabelText("结论编辑器")).toHaveLength(1);
  });

  it("keeps the current conclusion active when auto-save fails during switching", async () => {
    const user = userEvent.setup();

    mockConclusionUpdateMutateAsync.mockRejectedValueOnce(
      new Error("save failed"),
    );
    mockActivityList.mockResolvedValue([
      buildActivityWithConclusions([
        buildActivityConclusion(21, "第一条结论", true),
        buildActivityConclusion(22, "第二条结论", false),
      ]),
    ]);

    renderActivityPage();

    await user.click(await screen.findByText("第一条结论"));
    await user.clear(screen.getByLabelText("结论编辑器"));
    await user.type(
      screen.getByLabelText("结论编辑器"),
      "保存失败的第一条结论",
    );
    await user.click(screen.getByText("第二条结论"));

    expect(mockConclusionUpdateMutateAsync).toHaveBeenCalledWith({
      conclusionId: 21,
      markdown: "保存失败的第一条结论",
      html: "<p>保存失败的第一条结论</p>",
      promotedToProject: true,
    });
    expect(
      screen.getByDisplayValue("保存失败的第一条结论"),
    ).toBeInTheDocument();
    expect(screen.queryByDisplayValue("第二条结论")).not.toBeInTheDocument();
  });

  it("submits conclusion edits with ctrl-enter", async () => {
    const user = userEvent.setup();

    renderActivityPage();

    await user.click(await screen.findByText("已确认预算分配方案"));
    const editor = screen.getByLabelText("结论编辑器");
    await user.clear(editor);
    await user.type(editor, "快捷键保存的活动结论");
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });

    expect(mockConclusionUpdateMutateAsync).toHaveBeenCalledWith({
      conclusionId: 21,
      markdown: "快捷键保存的活动结论",
      html: "<p>快捷键保存的活动结论</p>",
      promotedToProject: true,
    });
  });

  it("renders conclusions without update timestamps", async () => {
    renderActivityPage();

    expect(await screen.findByText("已确认预算分配方案")).toBeInTheDocument();
    expect(screen.queryByText(/更新于/u)).not.toBeInTheDocument();
  });

  it("toggles an existing conclusion from the context menu", async () => {
    const user = userEvent.setup();

    renderActivityPage();

    fireEvent.contextMenu(await screen.findByText("已确认预算分配方案"), {
      clientX: 160,
      clientY: 84,
    });
    await user.click(screen.getByRole("menuitem", { name: "取消项目级标星" }));

    expect(mockConclusionUpdateMutateAsync).toHaveBeenCalledWith({
      conclusionId: 21,
      markdown: "已确认预算分配方案",
      html: "<p>已确认预算分配方案</p>",
      promotedToProject: false,
    });
  });

  it("keeps an inactive conclusion out of edit mode when right-clicking", async () => {
    renderActivityPage();

    const conclusion = await screen.findByText("已确认预算分配方案");
    const mouseDownEvent = new MouseEvent("mousedown", {
      button: 2,
      bubbles: true,
      cancelable: true,
    });

    conclusion.dispatchEvent(mouseDownEvent);

    expect(mouseDownEvent.defaultPrevented).toBe(true);

    fireEvent.contextMenu(conclusion, {
      clientX: 160,
      clientY: 84,
    });

    expect(await screen.findByRole("menu", { name: "结论操作" })).toBeInTheDocument();
    expect(screen.queryByLabelText("结论编辑器")).not.toBeInTheDocument();
  });

  it("deletes an existing conclusion from the context menu", async () => {
    const user = userEvent.setup();

    renderActivityPage();

    fireEvent.contextMenu(await screen.findByText("已确认预算分配方案"), {
      clientX: 160,
      clientY: 84,
    });

    await user.click(screen.getByRole("menuitem", { name: "删除" }));

    expect(mockConclusionDeleteMutateAsync).toHaveBeenCalledWith({
      conclusionId: 21,
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

  it("imports dropped file URIs into the current activity from anywhere on the page", async () => {
    renderActivityPage();

    await screen.findByText("文件材料");

    const dropZone = screen.getByTestId("activity-page-dropzone");

    fireEvent.drop(dropZone, {
      dataTransfer: {
        files: [],
        getData: (type: string) =>
          type === "text/uri-list"
            ? "file:///tmp/project-atlas/inbox/brief%20v2.pdf"
            : "",
      },
    });

    await waitFor(() =>
      expect(mockDocumentImport).toHaveBeenCalledWith({
        projectId: 9,
        activityId: 11,
        sourcePath: "/tmp/project-atlas/inbox/brief v2.pdf",
        isStarred: false,
      }),
    );
  });

  it("routes note image inserts to the hidden note-image import without appending to file materials", async () => {
    const user = userEvent.setup();

    renderActivityPage();

    expect(await screen.findByText("文件材料")).toBeInTheDocument();
    expect(screen.getByTestId("managed-document-count")).toHaveTextContent("0");

    await user.click(screen.getByRole("button", { name: "触发图片导入" }));

    await waitFor(() =>
      expect(mockDocumentImportNoteImage).toHaveBeenCalledWith({
        projectId: 9,
        activityId: 11,
        sourcePath: "/tmp/project-atlas/inbox/clip.png",
      }),
    );

    expect(screen.getByTestId("managed-document-count")).toHaveTextContent("0");
    expect(screen.queryByText("clip.png")).not.toBeInTheDocument();
  });

  it("routes pasted note images to the hidden clipboard import without appending to file materials", async () => {
    const user = userEvent.setup();

    renderActivityPage();

    expect(await screen.findByText("文件材料")).toBeInTheDocument();
    expect(screen.getByTestId("managed-document-count")).toHaveTextContent("0");

    await user.click(screen.getByRole("button", { name: "触发粘贴图片导入" }));

    await waitFor(() =>
      expect(mockDocumentImportClipboardNoteImage).toHaveBeenCalledWith({
        projectId: 9,
        activityId: 11,
        fileName: expect.stringMatching(/^clipboard-image-/),
        mimeType: "image/png",
        dataBase64: expect.any(String),
      }),
    );

    expect(screen.getByTestId("managed-document-count")).toHaveTextContent("0");
    expect(screen.queryByText(/clipboard-image/u)).not.toBeInTheDocument();
  });

  it("shows the import tag dialog for activity page drops when file tags exist", async () => {
    const user = userEvent.setup();
    mockFileTagSettingsGet.mockResolvedValue({
      tags: [
        {
          id: 3,
          label: "待审核",
          colorKey: "amber",
          usageCount: 1,
          createdAt: "",
          updatedAt: "",
        },
      ],
    });

    renderActivityPage();

    await screen.findByText("文件材料");

    fireEvent.drop(screen.getByTestId("activity-page-dropzone"), {
      dataTransfer: {
        files: [{ path: "/tmp/project-atlas/inbox/brief.pdf" }],
      },
    });

    expect(
      await screen.findByRole("dialog", { name: "选择导入标签" }),
    ).toBeInTheDocument();

    await user.click(screen.getByLabelText("待审核"));
    await user.click(screen.getByRole("button", { name: "开始导入" }));

    await waitFor(() =>
      expect(mockDocumentImport).toHaveBeenCalledWith({
        projectId: 9,
        activityId: 11,
        sourcePath: "/tmp/project-atlas/inbox/brief.pdf",
        isStarred: false,
        tagIds: [3],
      }),
    );
  });

  it("expands the embedded AI summary and auto-collapses it on outside press", async () => {
    const user = userEvent.setup();

    renderActivityPage();

    expect(await screen.findByText("文件材料")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-artifact-card")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "AI 概览" }));
    expect(screen.getByTestId("ai-artifact-card")).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("ai-artifact-card")).not.toBeInTheDocument();
  });

  it("hides AI modules when related feature toggles are off", async () => {
    mockVisibleAiSuggestionTypes.mockReturnValue([]);
    mockIsAiFeatureVisible.mockImplementation(
      (_snapshot: unknown, feature: unknown) =>
        feature !== "summary.activity_summary",
    );

    renderActivityPage();

    await screen.findByText("文件材料");
    expect(
      screen.queryByRole("button", { name: "AI 提炼" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("ai-artifact-card")).not.toBeInTheDocument();
  });
});

function renderActivityPage({
  initialEntries = ["/projects/9/activities/11"],
}: {
  initialEntries?: string[];
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route
            path="/projects/:projectId/activities/:activityId"
            element={<ActivityPage />}
          />
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

function buildActivityWithConclusions(
  conclusions: ActivityCardData["conclusions"],
): ActivityCardData {
  const activity = buildActivity();

  return {
    ...activity,
    digest: {
      ...activity.digest,
      conclusionCount: conclusions.length,
    },
    conclusions,
  };
}

function buildActivityConclusion(
  id: number,
  contentMarkdown: string,
  promotedToProject: boolean,
) {
  return {
    id,
    projectId: 9,
    activityId: 11,
    noteId: null,
    contentMarkdown,
    contentHtml: `<p>${contentMarkdown}</p>`,
    promotedToProject,
    sourceActivityTitle: "预算讨论",
    createdAt: "2026-04-06T10:20:00.000Z",
    updatedAt: "2026-04-06T10:25:00.000Z",
  };
}

function toPlainText(value: string) {
  return value.replace(/<[^>]+>/g, "");
}

function toHtml(value: string) {
  return value ? `<p>${value}</p>` : "";
}

function buildDocumentRecord(
  partial: Partial<ReturnType<typeof buildDocumentRecordBase>> = {},
) {
  return {
    ...buildDocumentRecordBase(),
    ...partial,
  };
}

function buildDocumentRecordBase() {
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
