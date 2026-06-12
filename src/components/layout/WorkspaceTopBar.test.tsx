import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  WorkspaceTopBar,
  shouldDetachProjectTabRelease,
} from "./WorkspaceTopBar";

describe("WorkspaceTopBar", () => {
  it("handles search selection and archived restore actions", async () => {
    const user = userEvent.setup();
    const onSearchSelect = vi.fn();
    const onRestoreProject = vi.fn();

    render(
      <WorkspaceTopBar
        projects={[{ id: 1, name: "Alpha", kind: "normal", status: "active", rootPath: "/", quickNote: "", isArchived: false, createdAt: "", updatedAt: "", activityCount: 1, unorganizedCount: 0, openTodoCount: 1 }]}
        currentWorkspace={{
          rootPath: "/tmp/workspace",
          metadataPath: "/tmp/workspace/.project-mind/workspace.json",
          displayName: "Test Workspace",
          createdAt: "",
        }}
        aiSecretsUnlocked
        activeProjectId={1}
        todayActive={false}
        archivedProjects={[{ id: 2, name: "Beta", kind: "normal", status: "paused", rootPath: "/", quickNote: "", isArchived: true, createdAt: "", updatedAt: "", activityCount: 0, unorganizedCount: 0, openTodoCount: 0 }]}
        searchInput="bet"
        onSearchInput={vi.fn()}
        searchResults={[
          {
            kind: "project",
            id: 2,
            projectId: 2,
            title: "Beta",
            subtitle: "Archived project",
            matchedText: "Beta",
          },
        ]}
        searching={false}
        archiveOpen
        onToggleArchive={vi.fn()}
        onCloseArchive={vi.fn()}
        onOpenProject={vi.fn()}
        onCloseProject={vi.fn()}
        onRestoreProject={onRestoreProject}
        workspaceMenuOpen={false}
        onToggleWorkspaceMenu={vi.fn()}
        onCloseWorkspaceMenu={vi.fn()}
        onOpenWorkspaceFolder={vi.fn()}
        onSwitchWorkspace={vi.fn()}
        onLockAiSecrets={vi.fn()}
        onCreateProject={vi.fn()}
        onOpenToday={vi.fn()}
        onOpenSettings={vi.fn()}
        onSearchSelect={onSearchSelect}
      />,
    );

    expect(screen.getByRole("button", { name: "Workspace" })).toBeInTheDocument();
    expect(screen.queryByText("Project Mind")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ask" })).not.toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: /beta/i })[0]);
    expect(onSearchSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "project", projectId: 2 }),
    );

    await user.click(screen.getByRole("button", { name: "恢复" }));
    expect(onRestoreProject).toHaveBeenCalledWith(2);
  });

  it("detects when a dragged tab is released outside the tab list", () => {
    expect(
      shouldDetachProjectTabRelease({
        tabListRect: {
          left: 0,
          right: 200,
          top: 0,
          bottom: 40,
        },
        dragging: true,
        clientX: 260,
        clientY: 20,
      }),
    ).toBe(true);
    expect(
      shouldDetachProjectTabRelease({
        tabListRect: {
          left: 0,
          right: 200,
          top: 0,
          bottom: 40,
        },
        dragging: true,
        clientX: 120,
        clientY: 20,
      }),
    ).toBe(false);
  });

  it("keeps normal clicks from detaching a project tab", async () => {
    const user = userEvent.setup();
    const onOpenProject = vi.fn();
    const onDetachProject = vi.fn();

    render(
      <WorkspaceTopBar
        projects={[{ id: 1, name: "Alpha", kind: "normal", status: "active", rootPath: "/", quickNote: "", isArchived: false, createdAt: "", updatedAt: "", activityCount: 1, unorganizedCount: 0, openTodoCount: 1 }]}
        currentWorkspace={{
          rootPath: "/tmp/workspace",
          metadataPath: "/tmp/workspace/.project-mind/workspace.json",
          displayName: "Test Workspace",
          createdAt: "",
        }}
        aiSecretsUnlocked
        activeProjectId={1}
        todayActive={false}
        archivedProjects={[]}
        searchInput=""
        onSearchInput={vi.fn()}
        searchResults={[]}
        searching={false}
        archiveOpen={false}
        onToggleArchive={vi.fn()}
        onCloseArchive={vi.fn()}
        onOpenProject={onOpenProject}
        onCloseProject={vi.fn()}
        onRestoreProject={vi.fn()}
        workspaceMenuOpen={false}
        onToggleWorkspaceMenu={vi.fn()}
        onCloseWorkspaceMenu={vi.fn()}
        onOpenWorkspaceFolder={vi.fn()}
        onSwitchWorkspace={vi.fn()}
        onLockAiSecrets={vi.fn()}
        onCreateProject={vi.fn()}
        onOpenToday={vi.fn()}
        onOpenSettings={vi.fn()}
        onSearchSelect={vi.fn()}
        onDetachProject={onDetachProject}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Alpha" }));

    expect(onOpenProject).toHaveBeenCalledWith(1);
    expect(onDetachProject).not.toHaveBeenCalled();
  });
});
