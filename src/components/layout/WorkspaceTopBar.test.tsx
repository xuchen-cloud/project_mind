import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceTopBar } from "./WorkspaceTopBar";

describe("WorkspaceTopBar", () => {
  it("handles search selection and archived restore actions", async () => {
    const user = userEvent.setup();
    const onSearchSelect = vi.fn();
    const onRestoreProject = vi.fn();
    const onOpenAsk = vi.fn();

    render(
      <WorkspaceTopBar
        projects={[{ id: 1, name: "Alpha", status: "active", rootPath: "/", fileLayoutVersion: 1, summary: "", isArchived: false, createdAt: "", updatedAt: "", activityCount: 1, unorganizedCount: 0, openTodoCount: 1 }]}
        activeProjectId={1}
        todayActive={false}
        askOpen={false}
        archivedProjects={[{ id: 2, name: "Beta", status: "paused", rootPath: "/", fileLayoutVersion: 1, summary: "", isArchived: true, createdAt: "", updatedAt: "", activityCount: 0, unorganizedCount: 0, openTodoCount: 0 }]}
        searchInput="bet"
        onSearchInput={vi.fn()}
        searchGroups={[
          [
            "project",
            [
              {
                kind: "project",
                id: 2,
                projectId: 2,
                title: "Beta",
                subtitle: "Archived project",
                matchedText: "Beta",
              },
            ],
          ],
        ]}
        searching={false}
        archiveOpen
        onToggleArchive={vi.fn()}
        onCloseArchive={vi.fn()}
        onOpenProject={vi.fn()}
        onRestoreProject={onRestoreProject}
        onCreateProject={vi.fn()}
        onOpenToday={vi.fn()}
        onOpenAsk={onOpenAsk}
        onOpenSettings={vi.fn()}
        onSearchSelect={onSearchSelect}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(onOpenAsk).toHaveBeenCalledTimes(1);

    await user.click(screen.getAllByRole("button", { name: /beta/i })[0]);
    expect(onSearchSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "project", projectId: 2 }),
    );

    await user.click(screen.getByRole("button", { name: "恢复" }));
    expect(onRestoreProject).toHaveBeenCalledWith(2);
  });
});
