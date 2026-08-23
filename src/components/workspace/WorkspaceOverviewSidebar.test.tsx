import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createUiStoreState, useUiStore } from "../../state/ui-store";
import { WorkspaceOverviewSidebar } from "./WorkspaceOverviewSidebar";

describe("WorkspaceOverviewSidebar", () => {
  beforeEach(() => useUiStore.setState(createUiStoreState()));

  it("prefetches project intent without navigating, including while renaming", () => {
    const onPrefetchProject = vi.fn();
    const onOpenProject = vi.fn();
    render(
      <WorkspaceOverviewSidebar
        workspaceRootPath="/tmp/workspace"
        projects={[{ id: 2, name: "Beta", kind: "normal", status: "active", rootPath: "/tmp/beta", quickNote: "", isArchived: false, createdAt: "", updatedAt: "", unorganizedCount: 0, openTodoCount: 0 }]}
        archivedProjects={[]}
        records={[]}
        recordQuery=""
        onRecordQueryChange={vi.fn()}
        activeRecordTagId={null}
        onActiveRecordTagIdChange={vi.fn()}
        onOpenOverview={vi.fn()}
        onOpenProject={onOpenProject}
        onPrefetchProject={onPrefetchProject}
        onOpenProjectInNewWindow={vi.fn()}
        onCreateProject={vi.fn()}
        onOpenArchivedProject={vi.fn()}
        onRestoreArchivedProject={vi.fn()}
        onRenameProject={vi.fn()}
        onArchiveProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onOpenRecord={vi.fn()}
        onCreateRecord={vi.fn()}
      />,
    );

    const projectButton = screen.getByRole("button", { name: /Beta/ });
    fireEvent.pointerEnter(projectButton);
    fireEvent.focus(projectButton);
    expect(onPrefetchProject).toHaveBeenCalledTimes(2);
    expect(onOpenProject).not.toHaveBeenCalled();

    fireEvent.doubleClick(screen.getByText("Beta"));
    const editingButton = screen.getByDisplayValue("Beta").closest("button");
    expect(editingButton).not.toBeNull();
    fireEvent.pointerEnter(editingButton as HTMLButtonElement);
    expect(onPrefetchProject).toHaveBeenLastCalledWith(2);
    expect(onOpenProject).not.toHaveBeenCalled();
  });
});
