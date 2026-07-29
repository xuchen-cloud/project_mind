import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  WorkspaceTopBar,
  shouldDetachProjectTabRelease,
} from "./WorkspaceTopBar";

describe("WorkspaceTopBar", () => {
  it("handles search selection", async () => {
    const user = userEvent.setup();
    const onSearchSelect = vi.fn();

    render(
      <WorkspaceTopBar
        projects={[{ id: 1, name: "Alpha", kind: "normal", status: "active", rootPath: "/", quickNote: "", isArchived: false, createdAt: "", updatedAt: "", activityCount: 1, unorganizedCount: 0, openTodoCount: 1 }]}
        activeProjectId={1}
        todayActive={false}
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
        onOpenProject={vi.fn()}
        onCloseProject={vi.fn()}
        onOpenToday={vi.fn()}
        onOpenSettings={vi.fn()}
        onSearchSelect={onSearchSelect}
      />,
    );

    expect(screen.getByRole("button", { name: "Workspace" })).toBeInTheDocument();
    expect(screen.queryByText("Project Mind")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ask" })).not.toBeInTheDocument();

    await user.click(
      screen.getByPlaceholderText("搜索 Workspace、项目、活动、记录、结论、Todo、文件、联系人"),
    );
    await user.click(screen.getAllByRole("button", { name: /beta/i })[0]);
    expect(onSearchSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "project", projectId: 2 }),
    );
  });

  it("shows localized result kinds and the matched context", () => {
    render(
      <WorkspaceTopBar
        projects={[]}
        activeProjectId={null}
        showToday={false}
        searchInput="预算"
        onSearchInput={vi.fn()}
        searchResults={[
          {
            kind: "activity",
            id: 7,
            projectId: 2,
            activityId: 7,
            title: "季度复盘",
            subtitle: "Alpha",
            matchedText: "…讨论下一季度预算和交付节奏…",
          },
        ]}
        searching={false}
        onOpenProject={vi.fn()}
        onOpenToday={vi.fn()}
        onOpenSettings={vi.fn()}
        onSearchSelect={vi.fn()}
      />,
    );

    fireEvent.focus(
      screen.getByPlaceholderText("搜索 Workspace、项目、活动、记录、结论、Todo、文件、联系人"),
    );
    expect(screen.getByText("活动")).toBeInTheDocument();
    expect(screen.getByText("…讨论下一季度预算和交付节奏…")).toBeInTheDocument();
  });

  it("keeps Workspace and Project Todo results distinct and shows their sources", async () => {
    const user = userEvent.setup();
    const onSearchSelect = vi.fn();
    render(
      <WorkspaceTopBar
        projects={[]}
        activeProjectId={null}
        searchInput="同名 Todo"
        onSearchInput={vi.fn()}
        searchResults={[
          {
            kind: "todo",
            id: 7,
            scope: "workspace",
            projectId: null,
            source: "Workspace",
            title: "同名 Todo",
            subtitle: "Workspace",
            matchedText: "同名 Todo",
          },
          {
            kind: "todo",
            id: 7,
            scope: "project",
            projectId: 3,
            source: "Alpha",
            title: "同名 Todo",
            subtitle: "Alpha",
            matchedText: "同名 Todo",
          },
        ]}
        searching={false}
        onOpenProject={vi.fn()}
        onOpenToday={vi.fn()}
        onOpenSettings={vi.fn()}
        onSearchSelect={onSearchSelect}
      />,
    );

    fireEvent.focus(
      screen.getByPlaceholderText("搜索 Workspace、项目、活动、记录、结论、Todo、文件、联系人"),
    );
    expect(screen.getAllByText("Workspace")).toHaveLength(2);
    expect(screen.getByText("Alpha")).toBeInTheDocument();

    const results = screen.getAllByRole("button", { name: /同名 Todo/ });
    expect(results).toHaveLength(2);
    await user.click(results[0]);
    expect(onSearchSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "todo", scope: "workspace", projectId: null }),
    );
  });

  it("shows a search error instead of reporting no matches", () => {
    render(
      <WorkspaceTopBar
        projects={[]}
        activeProjectId={null}
        showToday={false}
        searchInput="预算"
        onSearchInput={vi.fn()}
        searchResults={[]}
        searching={false}
        searchError
        onOpenProject={vi.fn()}
        onOpenToday={vi.fn()}
        onOpenSettings={vi.fn()}
        onSearchSelect={vi.fn()}
      />,
    );

    fireEvent.focus(
      screen.getByPlaceholderText("搜索 Workspace、项目、活动、记录、结论、Todo、文件、联系人"),
    );
    expect(screen.getByText("搜索失败，请稍后重试")).toBeInTheDocument();
    expect(screen.queryByText("没有匹配结果")).not.toBeInTheDocument();
  });

  it("shows searchable scope before the user types", () => {
    render(
      <WorkspaceTopBar
        projects={[]}
        activeProjectId={null}
        showToday={false}
        searchInput=""
        onSearchInput={vi.fn()}
        searchResults={[]}
        searching={false}
        onOpenProject={vi.fn()}
        onOpenToday={vi.fn()}
        onOpenSettings={vi.fn()}
        onSearchSelect={vi.fn()}
      />,
    );

    fireEvent.focus(
      screen.getByPlaceholderText("搜索 Workspace、项目、活动、记录、结论、Todo、文件、联系人"),
    );
    expect(
      screen.getByText("输入关键词，搜索 Workspace、项目、活动、记录、结论、Todo、文件和联系人"),
    ).toBeInTheDocument();
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
        activeProjectId={1}
        todayActive={false}
        searchInput=""
        onSearchInput={vi.fn()}
        searchResults={[]}
        searching={false}
        onOpenProject={onOpenProject}
        onCloseProject={vi.fn()}
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

  it("opens the project tab context menu and detaches to a new window", async () => {
    const onDetachProject = vi.fn();

    render(
      <WorkspaceTopBar
        projects={[{ id: 1, name: "Alpha", kind: "normal", status: "active", rootPath: "/", quickNote: "", isArchived: false, createdAt: "", updatedAt: "", activityCount: 1, unorganizedCount: 0, openTodoCount: 1 }]}
        activeProjectId={1}
        todayActive={false}
        searchInput=""
        onSearchInput={vi.fn()}
        searchResults={[]}
        searching={false}
        onOpenProject={vi.fn()}
        onCloseProject={vi.fn()}
        onOpenToday={vi.fn()}
        onOpenSettings={vi.fn()}
        onSearchSelect={vi.fn()}
        onDetachProject={onDetachProject}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "Alpha" }), {
      clientX: 120,
      clientY: 88,
    });

    fireEvent.click(await screen.findByRole("menuitem", { name: "在新窗口中打开" }));

    expect(onDetachProject).toHaveBeenCalledWith(1);
  });

  it("keeps full titles while marking the active tab close button as persistent", () => {
    render(
      <WorkspaceTopBar
        projects={[
          {
            id: 1,
            name: "Alpha project with a very long title",
            kind: "normal",
            status: "active",
            rootPath: "/",
            quickNote: "",
            isArchived: false,
            createdAt: "",
            updatedAt: "",
            activityCount: 1,
            unorganizedCount: 0,
            openTodoCount: 1,
          },
          {
            id: 2,
            name: "Beta project with another very long title",
            kind: "normal",
            status: "active",
            rootPath: "/",
            quickNote: "",
            isArchived: false,
            createdAt: "",
            updatedAt: "",
            activityCount: 1,
            unorganizedCount: 0,
            openTodoCount: 1,
          },
        ]}
        activeProjectId={1}
        todayActive={false}
        searchInput=""
        onSearchInput={vi.fn()}
        searchResults={[]}
        searching={false}
        onOpenProject={vi.fn()}
        onCloseProject={vi.fn()}
        onOpenToday={vi.fn()}
        onOpenSettings={vi.fn()}
        onSearchSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Workspace" })).toHaveAttribute("title", "Workspace");
    expect(screen.getByRole("button", { name: "Alpha project with a very long title" })).toHaveAttribute(
      "title",
      "Alpha project with a very long title",
    );
    expect(screen.getByRole("button", { name: "Beta project with another very long title" })).toHaveAttribute(
      "title",
      "Beta project with another very long title",
    );

    expect(
      screen.getByRole("button", { name: "关闭 Alpha project with a very long title" }),
    ).toHaveClass("workspace-topbar__tab-close--persistent");
    expect(
      screen.getByRole("button", { name: "关闭 Beta project with another very long title" }),
    ).not.toHaveClass("workspace-topbar__tab-close--persistent");
  });
});
