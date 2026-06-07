import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useUiStore } from "../../state/ui-store";
import { ProjectSidebar } from "./ProjectSidebar";

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("ProjectSidebar", () => {
  beforeEach(() => {
    useUiStore.setState({
      createProjectOpen: false,
      createActivityOpen: false,
      settingsOpen: false,
      settingsSection: "activity",
      projectComposer: null,
      projectSidebarCollapsed: false,
      todoRailCollapsed: false,
    });
  });

  it("opens the project overview, navigates activities, and toggles collapse", async () => {
    const user = userEvent.setup();
    const onOpenProject = vi.fn();
    const onOpenActivity = vi.fn();
    const onCreateActivity = vi.fn();
    const onDeleteActivity = vi.fn();

    renderWithProviders(
      <ProjectSidebar
        project={{
          id: 1,
          name: "Alpha Project",
          rootPath: "/tmp/alpha-project",
          isArchived: false,
        }}
        activities={[
          {
            id: 11,
            title: "Kickoff Review",
            activityTime: "2026-04-06T08:00:00.000Z",
            attributeLabel: "产品评审",
            attributeColorKey: "blue",
            conclusionCount: 2,
            documentCount: 3,
            completedTodoCount: 1,
            totalTodoCount: 2,
            statusLabel: "已整理",
            statusColorKey: "green",
          },
          {
            id: 12,
            title: "Budget Sync",
            activityTime: "2026-04-06T09:00:00.000Z",
            attributeLabel: null,
            attributeColorKey: null,
            conclusionCount: 0,
            documentCount: 1,
            completedTodoCount: 0,
            totalTodoCount: 1,
            statusLabel: "待复核",
            statusColorKey: "amber",
          },
        ]}
        activeActivityId={11}
        onOpenProject={onOpenProject}
        onOpenActivity={onOpenActivity}
        onCreateActivity={onCreateActivity}
        onDeleteActivity={onDeleteActivity}
      />,
    );

    expect(screen.getByText("Alpha Project")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Activities" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByText("2026/4/6")).not.toBeInTheDocument();
    expect(screen.queryByText("未设置属性")).not.toBeInTheDocument();
    expect(screen.getByLabelText("文件 3")).toBeInTheDocument();
    expect(screen.getByLabelText("结论 2")).toBeInTheDocument();
    expect(screen.getByLabelText("Todo 1/2")).toBeInTheDocument();
    expect(screen.getByText("已整理")).toBeInTheDocument();

    const kickoffButton = screen.getByText("Kickoff Review").closest("button");
    expect(kickoffButton).not.toBeNull();
    const kickoffAttribute = within(kickoffButton as HTMLElement).getByText(
      "产品评审",
    );
    const kickoffTitle = within(kickoffButton as HTMLElement).getByText(
      "Kickoff Review",
    );
    expect(
      kickoffAttribute.compareDocumentPosition(kickoffTitle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const kickoffStatus = within(kickoffButton as HTMLElement).getByText(
      "已整理",
    );
    expect(
      kickoffTitle.compareDocumentPosition(kickoffStatus) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await user.click(screen.getByText("Alpha Project").closest("button")!);
    expect(onOpenProject).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "新建 Activity" }));
    expect(onCreateActivity).toHaveBeenCalledTimes(1);

    await user.click(screen.getByText("Budget Sync").closest("button")!);
    expect(onOpenActivity).toHaveBeenCalledWith(12);

    await user.click(screen.getByRole("button", { name: "收起项目侧边栏" }));
    expect(useUiStore.getState().projectSidebarCollapsed).toBe(true);
    expect(
      screen.getByRole("button", { name: "展开项目侧边栏" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Budget Sync")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "新建 Activity" }));
    expect(onCreateActivity).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole("button", { name: "B" }));
    expect(onOpenActivity).toHaveBeenCalledWith(12);
  });

  it("renders reference projects without activity and file tabs", () => {
    renderWithProviders(
      <ProjectSidebar
        project={{
          id: 1,
          name: "资料",
          kind: "reference",
          rootPath: "/tmp/workspace/资料",
          isArchived: false,
        }}
        activities={[]}
        onOpenProject={vi.fn()}
        onOpenActivity={vi.fn()}
        onCreateActivity={vi.fn()}
        onDeleteActivity={vi.fn()}
      />,
    );

    expect(screen.getByText("资料项目")).toBeInTheDocument();
    expect(screen.getByText(/不创建 Activity/u)).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /记录/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /文件/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新建 Activity" })).not.toBeInTheDocument();
  });

  it("shows delete inside the activity context menu on right click", async () => {
    const user = userEvent.setup();
    const onDeleteActivity = vi.fn();

    renderWithProviders(
      <ProjectSidebar
        project={{
          id: 1,
          name: "Alpha Project",
          rootPath: "/tmp/alpha-project",
          isArchived: false,
        }}
        activities={[
          {
            id: 11,
            title: "Kickoff Review",
            activityTime: "2026-04-06T08:00:00.000Z",
            attributeLabel: "产品评审",
            attributeColorKey: "blue",
            conclusionCount: 2,
            documentCount: 3,
            completedTodoCount: 1,
            totalTodoCount: 2,
            statusLabel: "已整理",
            statusColorKey: "green",
          },
          {
            id: 12,
            title: "Budget Sync",
            activityTime: "2026-04-06T09:00:00.000Z",
            attributeLabel: null,
            attributeColorKey: null,
            conclusionCount: 0,
            documentCount: 1,
            completedTodoCount: 0,
            totalTodoCount: 1,
            statusLabel: "待复核",
            statusColorKey: "amber",
          },
        ]}
        activeActivityId={11}
        onOpenProject={vi.fn()}
        onOpenActivity={vi.fn()}
        onCreateActivity={vi.fn()}
        onDeleteActivity={onDeleteActivity}
      />,
    );

    fireEvent.contextMenu(screen.getByText("Budget Sync").closest("button")!, {
      clientX: 160,
      clientY: 120,
    });

    expect(
      screen.getByRole("menu", { name: "Activity 操作" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(onDeleteActivity).toHaveBeenCalledWith(12);
  });

  it("switches to the Files tab and opens project files", async () => {
    const user = userEvent.setup();
    const onOpenDocument = vi.fn();
    const onMoveDocument = vi.fn();

    renderWithProviders(
      <ProjectSidebar
        project={{
          id: 1,
          name: "Alpha Project",
          rootPath: "/tmp/alpha-project",
          isArchived: false,
        }}
        activities={[
          {
            id: 11,
            title: "Kickoff Review",
            activityTime: "2026-04-06T08:00:00.000Z",
            attributeLabel: "产品评审",
            attributeColorKey: "blue",
            conclusionCount: 2,
            documentCount: 3,
            completedTodoCount: 1,
            totalTodoCount: 2,
            statusLabel: "已整理",
            statusColorKey: "green",
          },
        ]}
        documents={[
          {
            id: 21,
            projectId: 1,
            activityId: 11,
            name: "budget.xlsx",
            baseName: "budget",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            managedPath: "/tmp/alpha-project/budget.xlsx",
            originalPath: "/original/budget.xlsx",
            historyDirPath: "/history/budget",
            sourceActivityTitle: "Kickoff Review",
            isStarred: false,
            currentVersionNumber: 1,
            versionCount: 1,
            health: "normal" as const,
            tags: [{ id: 3, label: "预算", colorKey: "amber" as const }],
          },
          {
            id: 22,
            projectId: 1,
            activityId: null,
            name: "diagram.png",
            baseName: "diagram",
            mimeType: "image/png",
            managedPath: "/tmp/alpha-project/diagram.png",
            originalPath: "/original/diagram.png",
            historyDirPath: "/history/diagram",
            sourceActivityTitle: null,
            isStarred: false,
            currentVersionNumber: 1,
            versionCount: 1,
            health: "normal" as const,
            tags: [],
          },
        ]}
        activeActivityId={11}
        onOpenProject={vi.fn()}
        onOpenActivity={vi.fn()}
        onOpenDocument={onOpenDocument}
        onMoveDocument={onMoveDocument}
        onCreateActivity={vi.fn()}
        onDeleteActivity={vi.fn()}
      />,
    );

    expect(screen.getByRole("tab", { name: /记录/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.click(screen.getByRole("tab", { name: /文件/ }));

    expect(screen.getByRole("tab", { name: /文件/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("budget.xlsx")).toBeInTheDocument();
    // sourceActivityTitle is displayed in the file list
    expect(screen.getByText("Kickoff Review")).toBeInTheDocument();
    expect(screen.getByText("diagram.png")).toBeInTheDocument();

    // Click on a file to open it
    await user.click(screen.getByText("budget.xlsx"));
    expect(onOpenDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 21,
        managedPath: "/tmp/alpha-project/budget.xlsx",
      }),
    );
  });
});
