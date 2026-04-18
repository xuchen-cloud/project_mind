import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActivityDigest, ProjectListItem, ProjectOverviewData } from "../../lib/types";

const {
  mockProjectsList,
  mockProjectGetOverview,
  mockAiSettingsGet,
  mockActivitySettingsGet,
  mockFileTagSettingsGet,
  mockDocumentImport,
  mockOpenFolder,
  mockSummaryMutate,
  mockCreateActivityMutate,
  mockConclusionUpdateMutate,
  mockConclusionDeleteMutateAsync,
  mockPushToast,
  mockSetStatus,
  mockTodoDeleteMutateAsync,
} = vi.hoisted(() => ({
  mockProjectsList: vi.fn(),
  mockProjectGetOverview: vi.fn(),
  mockAiSettingsGet: vi.fn(),
  mockActivitySettingsGet: vi.fn(),
  mockFileTagSettingsGet: vi.fn(),
  mockDocumentImport: vi.fn(),
  mockOpenFolder: vi.fn(async () => undefined),
  mockSummaryMutate: vi.fn(),
  mockCreateActivityMutate: vi.fn(),
  mockConclusionUpdateMutate: vi.fn(),
  mockConclusionDeleteMutateAsync: vi.fn(),
  mockPushToast: vi.fn(),
  mockSetStatus: vi.fn(),
  mockTodoDeleteMutateAsync: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: {
    projectsList: mockProjectsList,
    projectGetOverview: mockProjectGetOverview,
    aiSettingsGet: mockAiSettingsGet,
    activitySettingsGet: mockActivitySettingsGet,
    fileTagSettingsGet: mockFileTagSettingsGet,
    documentImport: mockDocumentImport,
  },
}));

vi.mock("../../services/desktopApi", () => ({
  desktopApi: {
    openFolder: mockOpenFolder,
  },
}));

vi.mock("../../hooks/useProjectMutations", () => ({
  useProjectMutations: () => ({
    summaryMutation: { mutate: mockSummaryMutate },
    archiveMutation: { mutate: vi.fn() },
  }),
}));

vi.mock("../../hooks/useActivityMutations", () => ({
  useActivityMutations: (options?: {
    onCreateActivitySuccess?: (activity: { id: number; projectId: number }) => void;
  }) => ({
    createActivityMutation: {
      isPending: false,
      mutate: (input: unknown) => {
        mockCreateActivityMutate(input);
        options?.onCreateActivitySuccess?.({ id: 88, projectId: 9 });
      },
    },
    conclusionUpdateMutation: { isPending: false, mutate: mockConclusionUpdateMutate },
    conclusionDeleteMutation: { isPending: false, mutateAsync: mockConclusionDeleteMutateAsync },
  }),
}));

vi.mock("../../hooks/useTodoMutations", () => ({
  useTodoMutations: () => ({
    todoMutation: { mutate: vi.fn() },
    todoContentMutation: { mutateAsync: vi.fn() },
    todoActivityMutation: { mutateAsync: vi.fn() },
    todoStatusMutation: { mutateAsync: vi.fn() },
    todoPriorityMutation: { mutateAsync: vi.fn() },
    todoProgressMutation: { mutateAsync: vi.fn() },
    todoProgressUpdateMutation: { mutateAsync: vi.fn() },
    todoProgressDeleteMutation: { mutateAsync: vi.fn() },
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
  useUiStore: () => ({}),
}));

vi.mock("../layout/ProjectSidebar", () => ({
  ProjectSidebar: () => <div data-testid="project-sidebar" />,
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

    const ariaLabel =
      placeholder === "填写项目当前阶段、目标和关键约束。" ? "项目简介" : "结论编辑器";

    return (
      <textarea
        aria-label={ariaLabel}
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

vi.mock("../todo", () => ({
  TodoRail: () => <div data-testid="todo-rail" />,
}));

vi.mock("../document/ManagedDocumentSection", () => ({
  ManagedDocumentSection: () => <div data-testid="managed-document-section" />,
}));

vi.mock("../ai/AiArtifactCard", () => ({
  AiArtifactCard: () => <section data-testid="ai-artifact-card">AI Artifact</section>,
}));

import { ProjectOverviewPage } from "./ProjectOverviewPage";

describe("ProjectOverviewPage", () => {
  beforeEach(() => {
    mockProjectsList.mockReset();
    mockProjectGetOverview.mockReset();
    mockAiSettingsGet.mockReset();
    mockActivitySettingsGet.mockReset();
    mockFileTagSettingsGet.mockReset();
    mockDocumentImport.mockReset();
    mockOpenFolder.mockReset();
    mockSummaryMutate.mockReset();
    mockCreateActivityMutate.mockReset();
    mockConclusionUpdateMutate.mockReset();
    mockConclusionDeleteMutateAsync.mockReset();
    mockPushToast.mockReset();
    mockSetStatus.mockReset();
    mockTodoDeleteMutateAsync.mockReset();

    mockProjectsList.mockResolvedValue([buildProject()]);
    mockProjectGetOverview.mockResolvedValue(buildOverview());
    mockAiSettingsGet.mockResolvedValue({
      profiles: [],
      bindings: [],
      hasUsableDefault: false,
      securityMode: "workspace_password_encrypted",
      aiSecretsUnlocked: true,
      execution: {
        maxConcurrency: 1,
      },
      featureSettings: {
        masterEnabled: true,
        capabilities: {
          assistant: true,
          summary: true,
          suggestion_generation: true,
        },
        features: {
          "summary.activity_summary": true,
          "summary.project_brief": true,
          "summary.daily_brief": true,
          "suggestion_generation.conclusion": true,
          "suggestion_generation.todo": true,
        },
      },
    });
    mockActivitySettingsGet.mockResolvedValue({
      activityAttributeOptions: [],
      activityStatusOptions: [],
    });
    mockFileTagSettingsGet.mockResolvedValue({ tags: [] });
    mockDocumentImport.mockResolvedValue(buildProjectDocument());
  });

  it("opens the project folder from the clickable root path", async () => {
    const user = userEvent.setup();

    renderProjectOverviewPage();

    expect(await screen.findByText("Project Atlas")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "项目目录：/tmp/project-atlas" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "关键资料" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "项目目录：/tmp/project-atlas" }));

    expect(mockOpenFolder).toHaveBeenCalledWith("/tmp/project-atlas");
  });

  it("shows the current project status next to the title", async () => {
    renderProjectOverviewPage();

    expect(await screen.findByText("Project Atlas")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("edits the project name inline and saves automatically on submit", async () => {
    const user = userEvent.setup();

    renderProjectOverviewPage();

    expect(await screen.findByRole("button", { name: "Project Atlas" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Project Atlas" }));
    await user.clear(screen.getByLabelText("项目名称"));
    await user.type(screen.getByLabelText("项目名称"), "Atlas Prime{Enter}");

    expect(mockSummaryMutate).toHaveBeenCalledWith({
      projectId: 9,
      name: "Atlas Prime",
      summary: "阶段目标与风险说明",
      summaryMarkdown: "阶段目标与风险说明",
      summaryHtml: "<p>阶段目标与风险说明</p>",
      status: "active",
    });
  });

  it("edits the project summary inline and saves automatically on blur", async () => {
    const user = userEvent.setup();

    renderProjectOverviewPage();

    expect(await screen.findByRole("button", { name: "阶段目标与风险说明" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "阶段目标与风险说明" }));
    await user.clear(screen.getByLabelText("项目简介"));
    await user.type(screen.getByLabelText("项目简介"), "更新后的项目简介");
    await user.tab();

    expect(mockSummaryMutate).toHaveBeenCalledWith({
      projectId: 9,
      summary: "更新后的项目简介",
      summaryMarkdown: "更新后的项目简介",
      summaryHtml: "<p>更新后的项目简介</p>",
      status: "active",
    });
  });

  it("imports dropped files into the project root from anywhere on the page", async () => {
    renderProjectOverviewPage();

    await screen.findByText("Project Atlas");

    fireEvent.drop(screen.getByTestId("project-page-dropzone"), {
      dataTransfer: {
        files: [{ path: "/tmp/project-atlas/inbox/project-brief.pdf" }],
      },
    });

    await waitFor(() =>
      expect(mockDocumentImport).toHaveBeenCalledWith({
        projectId: 9,
        sourcePath: "/tmp/project-atlas/inbox/project-brief.pdf",
        isStarred: false,
      }),
    );
  });

  it("creates a new activity directly and navigates to the new activity page", async () => {
    const user = userEvent.setup();

    renderProjectOverviewPage();

    expect(await screen.findByText("Project Atlas")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "新增 Activity" }));

    expect(mockCreateActivityMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 9,
        title: "",
        activityTime: expect.any(String),
      }),
    );
    expect(await screen.findByTestId("activity-route")).toBeInTheDocument();
    expect(screen.getByTestId("location-display")).toHaveTextContent(
      "/projects/9/activities/88?focus=activity-title",
    );
  });

  it("imports dropped file URIs into the project root from anywhere on the page", async () => {
    renderProjectOverviewPage();

    await screen.findByText("Project Atlas");

    fireEvent.drop(screen.getByTestId("project-page-dropzone"), {
      dataTransfer: {
        files: [],
        getData: (type: string) =>
          type === "text/uri-list" ? "file:///tmp/project-atlas/inbox/project%20brief.pdf" : "",
      },
    });

    await waitFor(() =>
      expect(mockDocumentImport).toHaveBeenCalledWith({
        projectId: 9,
        sourcePath: "/tmp/project-atlas/inbox/project brief.pdf",
        isStarred: false,
      }),
    );
  });

  it("shows the import tag dialog for project page drops when file tags exist", async () => {
    const user = userEvent.setup();
    mockFileTagSettingsGet.mockResolvedValue({
      tags: [{ id: 3, label: "待审核", colorKey: "amber", usageCount: 1, createdAt: "", updatedAt: "" }],
    });

    renderProjectOverviewPage();

    await screen.findByText("Project Atlas");

    fireEvent.drop(screen.getByTestId("project-page-dropzone"), {
      dataTransfer: {
        files: [{ path: "/tmp/project-atlas/inbox/project-brief.pdf" }],
      },
    });

    expect(await screen.findByRole("dialog", { name: "选择导入标签" })).toBeInTheDocument();

    await user.click(screen.getByLabelText("待审核"));
    await user.click(screen.getByRole("button", { name: "开始导入" }));

    await waitFor(() =>
      expect(mockDocumentImport).toHaveBeenCalledWith({
        projectId: 9,
        sourcePath: "/tmp/project-atlas/inbox/project-brief.pdf",
        isStarred: false,
        tagIds: [3],
      }),
    );
  });

  it("renders rich conclusion rows and saves inline edits with markdown/html payload", async () => {
    const user = userEvent.setup();

    mockProjectGetOverview.mockResolvedValue(
      buildOverview({
        conclusionGroups: [
          {
            activityId: 11,
            activityTitle: "预算讨论",
            conclusions: [
              {
                id: 31,
                projectId: 9,
                activityId: 11,
                contentMarkdown: "一个项目级关键结论",
                contentHtml: "<p>一个项目级关键结论</p>",
                promotedToProject: true,
                createdAt: "2026-04-06T10:10:00.000Z",
                updatedAt: "2026-04-06T10:10:00.000Z",
              },
            ],
          },
        ],
      }),
    );

    renderProjectOverviewPage();

    expect(await screen.findByText("1 条结论")).toBeInTheDocument();
    expect(screen.getByText("一个项目级关键结论")).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
    await user.click(screen.getByText("一个项目级关键结论"));
    expect(screen.getByDisplayValue("一个项目级关键结论")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存修改" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消" })).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("结论编辑器"));
    await user.type(screen.getByLabelText("结论编辑器"), "调整后的项目结论");
    fireEvent.blur(screen.getByLabelText("结论编辑器"));

    expect(mockConclusionUpdateMutate).toHaveBeenCalledWith({
      conclusionId: 31,
      markdown: "调整后的项目结论",
      html: "<p>调整后的项目结论</p>",
      promotedToProject: true,
    });
  });

  it("keeps activity attribute, activity title, and conclusion count together above conclusion content", async () => {
    mockProjectGetOverview.mockResolvedValue(
      buildOverview({
        conclusionGroups: [
          buildConclusionGroup("预算讨论", [buildOverviewConclusion(31, "一个项目级关键结论", 11, true)]),
        ],
      }),
    );

    renderProjectOverviewPage();

    const conclusionCard = (await screen.findByText("预算讨论")).closest("article");
    expect(conclusionCard).not.toBeNull();
    expect(within(conclusionCard as HTMLElement).getByText("预算沟通")).toBeInTheDocument();
    expect(within(conclusionCard as HTMLElement).getByText("预算讨论")).toBeInTheDocument();
    expect(within(conclusionCard as HTMLElement).getByText("1 条结论")).toBeInTheDocument();

    const activityTag = within(conclusionCard as HTMLElement).getByText("预算沟通");
    const activityTitle = within(conclusionCard as HTMLElement).getByText("预算讨论");
    const conclusionCount = within(conclusionCard as HTMLElement).getByText("1 条结论");
    const conclusionContent = within(conclusionCard as HTMLElement).getByText("一个项目级关键结论");

    expect(
      activityTag.compareDocumentPosition(activityTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      activityTitle.compareDocumentPosition(conclusionCount) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      conclusionCount.compareDocumentPosition(conclusionContent) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("does not render the unassigned attribute tag in the conclusion timeline when an activity has no attribute", async () => {
    mockProjectGetOverview.mockResolvedValue(
      buildOverview({
        activityFeed: [
          {
            ...buildOverviewActivity(11, "预算讨论"),
            attributeOptionId: null,
            attributeLabel: null,
            attributeColorKey: null,
          },
        ],
        conclusionGroups: [
          buildConclusionGroup("预算讨论", [buildOverviewConclusion(31, "一个项目级关键结论", 11, true)]),
        ],
      }),
    );

    renderProjectOverviewPage();

    const conclusionCard = (await screen.findByText("预算讨论")).closest("article");
    expect(conclusionCard).not.toBeNull();
    expect(within(conclusionCard as HTMLElement).queryByText("未设置属性")).not.toBeInTheDocument();
  });

  it("keeps only one active conclusion within the same group", async () => {
    const user = userEvent.setup();

    mockProjectGetOverview.mockResolvedValue(
      buildOverview({
        conclusionGroups: [
          buildConclusionGroup("预算讨论", [
            buildOverviewConclusion(31, "第一条项目结论", 11, true),
            buildOverviewConclusion(32, "第二条项目结论", 11, true),
          ]),
        ],
      }),
    );

    renderProjectOverviewPage();

    await user.click(await screen.findByText("第一条项目结论"));
    await user.clear(screen.getByLabelText("结论编辑器"));
    await user.type(screen.getByLabelText("结论编辑器"), "更新后的第一条项目结论");
    await user.click(screen.getByText("第二条项目结论"));

    expect(mockConclusionUpdateMutate).toHaveBeenCalledWith({
      conclusionId: 31,
      markdown: "更新后的第一条项目结论",
      html: "<p>更新后的第一条项目结论</p>",
      promotedToProject: true,
    });
    expect(screen.getByDisplayValue("第二条项目结论")).toBeInTheDocument();
    expect(screen.getAllByLabelText("结论编辑器")).toHaveLength(1);
  });

  it("keeps only one active conclusion across different groups", async () => {
    const user = userEvent.setup();

    mockProjectGetOverview.mockResolvedValue(
      buildOverview({
        activityFeed: [
          buildOverviewActivity(11, "预算讨论"),
          buildOverviewActivity(12, "法务同步"),
        ],
        conclusionGroups: [
          buildConclusionGroup("预算讨论", [buildOverviewConclusion(31, "预算结论", 11, true)]),
          buildConclusionGroup("法务同步", [buildOverviewConclusion(41, "法务结论", 12, true)]),
        ],
      }),
    );

    renderProjectOverviewPage();

    await user.click(await screen.findByText("预算结论"));
    await user.clear(screen.getByLabelText("结论编辑器"));
    await user.type(screen.getByLabelText("结论编辑器"), "更新后的预算结论");
    await user.click(screen.getByText("法务结论"));

    expect(mockConclusionUpdateMutate).toHaveBeenCalledWith({
      conclusionId: 31,
      markdown: "更新后的预算结论",
      html: "<p>更新后的预算结论</p>",
      promotedToProject: true,
    });
    expect(screen.getByDisplayValue("法务结论")).toBeInTheDocument();
    expect(screen.getAllByLabelText("结论编辑器")).toHaveLength(1);
  });

  it("trims boundary blank lines and spaces before saving an edited conclusion", async () => {
    const user = userEvent.setup();

    mockProjectGetOverview.mockResolvedValue(
      buildOverview({
        conclusionGroups: [
          {
            activityId: 11,
            activityTitle: "预算讨论",
            conclusions: [
              {
                id: 31,
                projectId: 9,
                activityId: 11,
                contentMarkdown: "一个项目级关键结论",
                contentHtml: "<p>一个项目级关键结论</p>",
                promotedToProject: true,
                createdAt: "2026-04-06T10:10:00.000Z",
                updatedAt: "2026-04-06T10:10:00.000Z",
              },
            ],
          },
        ],
      }),
    );

    renderProjectOverviewPage();

    expect(await screen.findByText("1 条结论")).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
    await user.click(screen.getByText("一个项目级关键结论"));
    await user.clear(screen.getByLabelText("结论编辑器"));
    await user.type(screen.getByLabelText("结论编辑器"), "  调整后的项目结论  ");
    fireEvent.blur(screen.getByLabelText("结论编辑器"));

    expect(mockConclusionUpdateMutate).toHaveBeenCalledWith({
      conclusionId: 31,
      markdown: "调整后的项目结论",
      html: "<p>调整后的项目结论</p>",
      promotedToProject: true,
    });
  });

  it("submits edited conclusions with ctrl-enter", async () => {
    const user = userEvent.setup();

    mockProjectGetOverview.mockResolvedValue(
      buildOverview({
        conclusionGroups: [
          {
            activityId: 11,
            activityTitle: "预算讨论",
            conclusions: [
              {
                id: 31,
                projectId: 9,
                activityId: 11,
                contentMarkdown: "一个项目级关键结论",
                contentHtml: "<p>一个项目级关键结论</p>",
                promotedToProject: true,
                createdAt: "2026-04-06T10:10:00.000Z",
                updatedAt: "2026-04-06T10:10:00.000Z",
              },
            ],
          },
        ],
      }),
    );

    renderProjectOverviewPage();

    await user.click(await screen.findByText("一个项目级关键结论"));
    const editor = screen.getByLabelText("结论编辑器");
    await user.clear(editor);
    await user.type(editor, "快捷键保存的项目结论");
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });

    expect(mockConclusionUpdateMutate).toHaveBeenCalledWith({
      conclusionId: 31,
      markdown: "快捷键保存的项目结论",
      html: "<p>快捷键保存的项目结论</p>",
      promotedToProject: true,
    });
  });

  it("deletes a conclusion from the context menu", async () => {
    const user = userEvent.setup();

    mockProjectGetOverview.mockResolvedValue(
      buildOverview({
        conclusionGroups: [
          {
            activityId: 11,
            activityTitle: "预算讨论",
            conclusions: [
              {
                id: 31,
                projectId: 9,
                activityId: 11,
                contentMarkdown: "一个项目级关键结论",
                contentHtml: "<p>一个项目级关键结论</p>",
                promotedToProject: true,
                createdAt: "2026-04-06T10:10:00.000Z",
                updatedAt: "2026-04-06T10:10:00.000Z",
              },
            ],
          },
        ],
      }),
    );

    renderProjectOverviewPage();

    fireEvent.contextMenu(await screen.findByText("一个项目级关键结论"), {
      clientX: 180,
      clientY: 96,
    });

    await user.click(screen.getByRole("menuitem", { name: "删除" }));

    expect(mockConclusionDeleteMutateAsync).toHaveBeenCalledWith({ conclusionId: 31 });
  });

  it("keeps a project conclusion out of edit mode when right-clicking", async () => {
    mockProjectGetOverview.mockResolvedValue(
      buildOverview({
        conclusionGroups: [
          buildConclusionGroup("预算讨论", [buildOverviewConclusion(31, "一个项目级关键结论", 11, true)]),
        ],
      }),
    );

    renderProjectOverviewPage();

    const conclusion = await screen.findByText("一个项目级关键结论");
    const mouseDownEvent = new MouseEvent("mousedown", {
      button: 2,
      bubbles: true,
      cancelable: true,
    });

    conclusion.dispatchEvent(mouseDownEvent);

    expect(mouseDownEvent.defaultPrevented).toBe(true);

    fireEvent.contextMenu(conclusion, {
      clientX: 180,
      clientY: 96,
    });

    expect(await screen.findByRole("menu", { name: "结论操作" })).toBeInTheDocument();
    expect(screen.queryByLabelText("结论编辑器")).not.toBeInTheDocument();
  });

  it("toggles project-level visibility from the conclusion context menu", async () => {
    const user = userEvent.setup();

    mockProjectGetOverview.mockResolvedValue(
      buildOverview({
        conclusionGroups: [
          {
            activityId: 11,
            activityTitle: "预算讨论",
            conclusions: [
              {
                id: 31,
                projectId: 9,
                activityId: 11,
                contentMarkdown: "一个项目级关键结论",
                contentHtml: "<p>一个项目级关键结论</p>",
                promotedToProject: true,
                createdAt: "2026-04-06T10:10:00.000Z",
                updatedAt: "2026-04-06T10:10:00.000Z",
              },
            ],
          },
        ],
      }),
    );

    renderProjectOverviewPage();

    expect(screen.queryByRole("button", { name: /项目级标星|取消项目级标星/ })).not.toBeInTheDocument();

    fireEvent.contextMenu(await screen.findByText("一个项目级关键结论"), {
      clientX: 180,
      clientY: 96,
    });

    await user.click(screen.getByRole("menuitem", { name: "取消项目级标星" }));

    expect(mockConclusionUpdateMutate).toHaveBeenCalledWith({
      conclusionId: 31,
      markdown: "一个项目级关键结论",
      html: "<p>一个项目级关键结论</p>",
      promotedToProject: false,
    });
  });

  it("toggles pinning from the project conclusion context menu", async () => {
    const user = userEvent.setup();

    mockProjectGetOverview.mockResolvedValue(
      buildOverview({
        conclusionGroups: [
          buildConclusionGroup("预算讨论", [
            buildOverviewConclusion(31, "一个项目级关键结论", 11, true),
          ]),
        ],
      }),
    );

    renderProjectOverviewPage();

    fireEvent.contextMenu(await screen.findByText("一个项目级关键结论"), {
      clientX: 180,
      clientY: 96,
    });

    await user.click(screen.getByRole("menuitem", { name: "置顶" }));

    expect(mockConclusionUpdateMutate).toHaveBeenCalledWith({
      conclusionId: 31,
      markdown: "一个项目级关键结论",
      html: "<p>一个项目级关键结论</p>",
      promotedToProject: true,
      isPinned: true,
    });
  });

  it("expands the embedded AI brief and auto-collapses it on outside press", async () => {
    const user = userEvent.setup();

    renderProjectOverviewPage();

    expect(await screen.findByText("结论时间线")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-artifact-card")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "AI 概览" }));
    expect(screen.getByTestId("ai-artifact-card")).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("ai-artifact-card")).not.toBeInTheDocument();
  });

  it("hides the AI brief when the project brief feature is turned off", async () => {
    mockAiSettingsGet.mockResolvedValue({
      profiles: [],
      bindings: [],
      hasUsableDefault: false,
      securityMode: "workspace_password_encrypted",
      aiSecretsUnlocked: true,
      execution: {
        maxConcurrency: 1,
      },
      featureSettings: {
        masterEnabled: true,
        capabilities: {
          assistant: true,
          summary: true,
          suggestion_generation: true,
        },
        features: {
          "summary.activity_summary": true,
          "summary.project_brief": false,
          "summary.daily_brief": true,
          "suggestion_generation.conclusion": true,
          "suggestion_generation.todo": true,
        },
      },
    });

    renderProjectOverviewPage();

    expect(await screen.findByText("结论时间线")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-artifact-card")).not.toBeInTheDocument();
  });
});

function renderProjectOverviewPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/projects/9"]}>
        <Routes>
          <Route path="/projects/:projectId" element={<ProjectOverviewPage />} />
          <Route path="/projects/:projectId/activities/:activityId" element={<ActivityRouteStub />} />
        </Routes>
        <LocationDisplay />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function ActivityRouteStub() {
  return <div data-testid="activity-route">activity route</div>;
}

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location-display">{`${location.pathname}${location.search}`}</div>;
}

function buildProject(): ProjectListItem {
  return {
    id: 9,
    name: "Project Atlas",
    status: "active",
    rootPath: "/tmp/project-atlas",
    summary: "阶段目标与风险说明",
    summaryMarkdown: "阶段目标与风险说明",
    summaryHtml: "<p>阶段目标与风险说明</p>",
    isArchived: false,
    createdAt: "2026-04-06T08:00:00.000Z",
    updatedAt: "2026-04-06T09:00:00.000Z",
    activityCount: 1,
    unorganizedCount: 0,
    openTodoCount: 1,
  };
}

function toPlainText(value: string) {
  return value.replace(/<[^>]+>/g, "");
}

function toHtml(value: string) {
  return value ? `<p>${value}</p>` : "";
}

function buildOverview(overrides: Partial<ProjectOverviewData> = {}): ProjectOverviewData {
  const project = buildProject();
  return {
    project,
    activityFeed: [buildOverviewActivity(11, "预算讨论")],
    projectDocuments: [],
    conclusionGroups: [],
    unfinishedTodos: [],
    finishedTodos: [],
    ...overrides,
  };
}

function buildOverviewActivity(id: number, title: string): ActivityDigest {
  return {
    id,
    projectId: 9,
    attributeOptionId: 4,
    attributeLabel: "预算沟通",
    attributeColorKey: "teal" as const,
    title,
    activityTime: "2026-04-06T10:00:00.000Z",
    statusOptionId: 3,
    statusLabel: "已整理",
    statusColorKey: "green" as const,
    isPinned: false,
    noteCount: 0,
    conclusionCount: 0,
    todoCount: 0,
    documentCount: 0,
    completedTodoCount: 0,
    totalTodoCount: 0,
    hasOpenTodos: false,
  };
}

function buildConclusionGroup(
  activityTitle: string,
  conclusions: ProjectOverviewData["conclusionGroups"][number]["conclusions"],
) {
  return {
    activityId: conclusions[0]?.activityId ?? null,
    activityTitle,
    conclusions,
  };
}

function buildOverviewConclusion(
  id: number,
  contentMarkdown: string,
  activityId: number | null,
  promotedToProject: boolean,
  isPinned = false,
) {
  return {
    id,
    projectId: 9,
    activityId,
    contentMarkdown,
    contentHtml: `<p>${contentMarkdown}</p>`,
    promotedToProject,
    isPinned,
    createdAt: "2026-04-06T10:10:00.000Z",
    updatedAt: "2026-04-06T10:10:00.000Z",
  };
}

function buildProjectDocument() {
  return {
    id: 31,
    projectId: 9,
    activityId: null,
    name: "project-brief.pdf",
    baseName: "project-brief.pdf",
    originalPath: "/tmp/project-atlas/inbox/project-brief.pdf",
    managedPath: "/tmp/project-atlas/project-brief.pdf",
    historyDirPath: "/tmp/project-atlas/.31.pm-versions",
    storageMode: "managed_copy" as const,
    mimeType: "application/pdf",
    isStarred: false,
    currentVersionNumber: 1,
    versionCount: 1,
    sourceActivityTitle: null,
    health: "normal" as const,
    tags: [],
    createdAt: "2026-04-06T10:20:00.000Z",
    updatedAt: "2026-04-06T10:20:00.000Z",
  };
}
