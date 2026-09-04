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
        projects={[{ id: 2, name: "Beta", kind: "normal", status: "active", rootPath: "/tmp/beta", quickNote: "", isArchived: false, createdAt: "", updatedAt: "", openTodoCount: 0 }]}
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

  it("opens record actions when a Workspace Record is right clicked", () => {
    useUiStore.setState({ workspaceSidebarTab: "records" });
    const onRenameRecord = vi.fn();
    const onDeleteRecord = vi.fn();

    render(
      <WorkspaceOverviewSidebar
        workspaceRootPath="/tmp/workspace"
        projects={[]}
        archivedProjects={[]}
        records={[
          {
            id: 11,
            title: "长期方法",
            contentMarkdown: "记录内容",
            tags: [],
            updatedAt: "2026-09-04T08:00:00.000Z",
          },
        ]}
        recordQuery=""
        onRecordQueryChange={vi.fn()}
        activeRecordTagId={null}
        onActiveRecordTagIdChange={vi.fn()}
        onOpenOverview={vi.fn()}
        onOpenProject={vi.fn()}
        onOpenProjectInNewWindow={vi.fn()}
        onCreateProject={vi.fn()}
        onOpenArchivedProject={vi.fn()}
        onRestoreArchivedProject={vi.fn()}
        onRenameProject={vi.fn()}
        onArchiveProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onOpenRecord={vi.fn()}
        onCreateRecord={vi.fn()}
        onRenameRecord={onRenameRecord}
        onDeleteRecord={onDeleteRecord}
      />,
    );

    fireEvent.contextMenu(screen.getByText("长期方法"));

    expect(screen.getByRole("menu", { name: "记录操作" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /重命名/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /删除/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: /重命名/ }));
    const titleInput = screen.getByDisplayValue("长期方法");
    fireEvent.change(titleInput, { target: { value: "长期实践" } });
    fireEvent.keyDown(titleInput, { key: "Enter" });
    expect(onRenameRecord).toHaveBeenCalledWith(
      expect.objectContaining({ id: 11 }),
      "长期实践",
    );

    fireEvent.contextMenu(screen.getByText("长期方法"));
    fireEvent.click(screen.getByRole("menuitem", { name: /删除/ }));
    expect(onDeleteRecord).toHaveBeenCalledWith(expect.objectContaining({ id: 11 }));
  });
});
