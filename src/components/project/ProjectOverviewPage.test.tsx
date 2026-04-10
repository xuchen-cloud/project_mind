import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectListItem, ProjectOverviewData } from "../../lib/types";

const {
  mockProjectsList,
  mockProjectGetOverview,
  mockAiSettingsGet,
  mockActivitySettingsGet,
  mockOpenFolder,
  mockSummaryMutate,
  mockSetCreateActivityOpen,
  mockOpenSettings,
  mockConclusionUpdateMutate,
  mockConclusionDeleteMutateAsync,
  mockPushToast,
  mockTodoDeleteMutateAsync,
} = vi.hoisted(() => ({
  mockProjectsList: vi.fn(),
  mockProjectGetOverview: vi.fn(),
  mockAiSettingsGet: vi.fn(),
  mockActivitySettingsGet: vi.fn(),
  mockOpenFolder: vi.fn(async () => undefined),
  mockSummaryMutate: vi.fn(),
  mockSetCreateActivityOpen: vi.fn(),
  mockOpenSettings: vi.fn(),
  mockConclusionUpdateMutate: vi.fn(),
  mockConclusionDeleteMutateAsync: vi.fn(),
  mockPushToast: vi.fn(),
  mockTodoDeleteMutateAsync: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: {
    projectsList: mockProjectsList,
    projectGetOverview: mockProjectGetOverview,
    aiSettingsGet: mockAiSettingsGet,
    activitySettingsGet: mockActivitySettingsGet,
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
  useActivityMutations: () => ({
    createActivityMutation: { mutate: vi.fn() },
    conclusionUpdateMutation: { isPending: false, mutate: mockConclusionUpdateMutate },
    conclusionDeleteMutation: { isPending: false, mutateAsync: mockConclusionDeleteMutateAsync },
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
    pushToast: mockPushToast,
  }),
}));

vi.mock("../../state/ui-store", () => ({
  useUiStore: () => ({
    createActivityOpen: false,
    setCreateActivityOpen: mockSetCreateActivityOpen,
    openSettings: mockOpenSettings,
  }),
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
    mockOpenFolder.mockReset();
    mockSummaryMutate.mockReset();
    mockSetCreateActivityOpen.mockReset();
    mockOpenSettings.mockReset();
    mockConclusionUpdateMutate.mockReset();
    mockConclusionDeleteMutateAsync.mockReset();
    mockPushToast.mockReset();
    mockTodoDeleteMutateAsync.mockReset();

    mockProjectsList.mockResolvedValue([buildProject()]);
    mockProjectGetOverview.mockResolvedValue(buildOverview());
    mockAiSettingsGet.mockResolvedValue({
      profiles: [],
      bindings: [],
      hasUsableDefault: false,
      securityMode: "device_bound_encrypted",
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
      status: "active",
    });
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

    await user.clear(screen.getByLabelText("结论编辑器"));
    await user.type(screen.getByLabelText("结论编辑器"), "调整后的项目结论");
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    expect(mockConclusionUpdateMutate).toHaveBeenCalledWith({
      conclusionId: 31,
      markdown: "调整后的项目结论",
      html: "<p>调整后的项目结论</p>",
      promotedToProject: true,
    });
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
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    expect(mockConclusionUpdateMutate).toHaveBeenCalledWith({
      conclusionId: 31,
      markdown: "调整后的项目结论",
      html: "<p>调整后的项目结论</p>",
      promotedToProject: true,
    });
  });

  it("deletes a conclusion from the context menu", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

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

    expect(confirmSpy).toHaveBeenCalledWith("确定删除这条结论吗？删除后无法恢复。");
    expect(mockConclusionDeleteMutateAsync).toHaveBeenCalledWith({ conclusionId: 31 });

    confirmSpy.mockRestore();
  });

  it("hides the AI brief when the project brief feature is turned off", async () => {
    mockAiSettingsGet.mockResolvedValue({
      profiles: [],
      bindings: [],
      hasUsableDefault: false,
      securityMode: "device_bound_encrypted",
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
    summary: "阶段目标与风险说明",
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
    activityFeed: [
      {
        id: 11,
        projectId: project.id,
        attributeOptionId: 4,
        attributeLabel: "预算沟通",
        attributeColorKey: "teal",
        title: "预算讨论",
        activityTime: "2026-04-06T10:00:00.000Z",
        statusOptionId: 3,
        statusLabel: "已整理",
        statusColorKey: "green",
        isPinned: false,
        noteCount: 0,
        conclusionCount: 0,
        todoCount: 0,
        documentCount: 0,
        completedTodoCount: 0,
        totalTodoCount: 0,
        hasOpenTodos: false,
      },
    ],
    projectDocuments: [],
    conclusionGroups: [],
    unfinishedTodos: [],
    finishedTodos: [],
    ...overrides,
  };
}
