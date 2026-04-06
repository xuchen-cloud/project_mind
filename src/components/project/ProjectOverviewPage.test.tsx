import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectListItem, ProjectOverviewData } from "../../lib/types";

const {
  mockProjectsList,
  mockProjectGetOverview,
  mockActivitySettingsGet,
  mockOpenFolder,
  mockSetCreateActivityOpen,
  mockOpenSettings,
  mockConclusionUpdateMutate,
  mockPushToast,
} = vi.hoisted(() => ({
  mockProjectsList: vi.fn(),
  mockProjectGetOverview: vi.fn(),
  mockActivitySettingsGet: vi.fn(),
  mockOpenFolder: vi.fn(async () => undefined),
  mockSetCreateActivityOpen: vi.fn(),
  mockOpenSettings: vi.fn(),
  mockConclusionUpdateMutate: vi.fn(),
  mockPushToast: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: {
    projectsList: mockProjectsList,
    projectGetOverview: mockProjectGetOverview,
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
    summaryMutation: { mutate: vi.fn() },
    archiveMutation: { mutate: vi.fn() },
  }),
}));

vi.mock("../../hooks/useActivityMutations", () => ({
  useActivityMutations: () => ({
    createActivityMutation: { mutate: vi.fn() },
    conclusionUpdateMutation: { mutate: mockConclusionUpdateMutate },
  }),
}));

vi.mock("../../hooks/useTodoMutations", () => ({
  useTodoMutations: () => ({
    todoMutation: { mutate: vi.fn() },
    todoContentMutation: { mutateAsync: vi.fn() },
    todoStatusMutation: { mutateAsync: vi.fn() },
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

import { ProjectOverviewPage } from "./ProjectOverviewPage";

describe("ProjectOverviewPage", () => {
  beforeEach(() => {
    mockProjectsList.mockReset();
    mockProjectGetOverview.mockReset();
    mockActivitySettingsGet.mockReset();
    mockOpenFolder.mockReset();
    mockSetCreateActivityOpen.mockReset();
    mockOpenSettings.mockReset();
    mockConclusionUpdateMutate.mockReset();
    mockPushToast.mockReset();

    mockProjectsList.mockResolvedValue([buildProject()]);
    mockProjectGetOverview.mockResolvedValue(buildOverview());
    mockActivitySettingsGet.mockResolvedValue({
      activityAttributeOptions: [],
      activityStatusOptions: [],
    });
  });

  it("shows the project root path under the title and reveals it in Finder", async () => {
    const user = userEvent.setup();

    renderProjectOverviewPage();

    expect(await screen.findByText("Project Atlas")).toBeInTheDocument();
    expect(screen.getByText("项目目录：/tmp/project-atlas")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "关键资料" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "在资源管理器中打开项目目录" }));

    expect(mockOpenFolder).toHaveBeenCalledWith("/tmp/project-atlas");
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

    await user.click(screen.getByRole("button", { name: "编辑" }));
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
        title: "预算讨论",
        activityTime: "2026-04-06T10:00:00.000Z",
        statusOptionId: 3,
        statusLabel: "已整理",
        statusNeedsAttention: false,
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
