import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useUiStore } from "../../state/ui-store";
import { ProjectSidebar } from "./ProjectSidebar";

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

    render(
      <ProjectSidebar
        project={{
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
    expect(screen.getByText("Activities")).toBeInTheDocument();
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

  it("shows delete inside the activity context menu on right click", async () => {
    const user = userEvent.setup();
    const onDeleteActivity = vi.fn();

    render(
      <ProjectSidebar
        project={{
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
});
