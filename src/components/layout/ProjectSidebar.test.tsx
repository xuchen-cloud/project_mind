import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockOpenFolder } = vi.hoisted(() => ({
  mockOpenFolder: vi.fn(async () => undefined),
}));

vi.mock("../../services/desktopApi", () => ({
  desktopApi: {
    openFolder: mockOpenFolder,
  },
}));

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

    render(
      <ProjectSidebar
        project={{ name: "Alpha Project", rootPath: "/tmp/alpha-project", isArchived: false }}
        activities={[
          {
            id: 11,
            title: "Kickoff Review",
            activityTime: "2026-04-06T08:00:00.000Z",
            attributeLabel: "产品评审",
            documentCount: 3,
            completedTodoCount: 1,
            totalTodoCount: 2,
            statusLabel: "已整理",
            statusNeedsAttention: false,
          },
          {
            id: 12,
            title: "Budget Sync",
            activityTime: "2026-04-06T09:00:00.000Z",
            attributeLabel: "预算同步",
            documentCount: 1,
            completedTodoCount: 0,
            totalTodoCount: 1,
            statusLabel: "待复核",
            statusNeedsAttention: true,
          },
        ]}
        activeActivityId={11}
        onOpenProject={onOpenProject}
        onOpenActivity={onOpenActivity}
      />,
    );

    await user.click(screen.getByText("Alpha Project").closest("button")!);
    expect(onOpenProject).toHaveBeenCalledTimes(1);
    expect(mockOpenFolder).toHaveBeenCalledWith("/tmp/alpha-project");

    await user.click(screen.getByText("Budget Sync").closest("button")!);
    expect(onOpenActivity).toHaveBeenCalledWith(12);

    await user.click(screen.getByRole("button", { name: "收起项目侧边栏" }));
    expect(useUiStore.getState().projectSidebarCollapsed).toBe(true);
    expect(screen.getByRole("button", { name: "展开项目侧边栏" })).toBeInTheDocument();
    expect(screen.queryByText("Budget Sync")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "B" }));
    expect(onOpenActivity).toHaveBeenCalledWith(12);
  });
});
