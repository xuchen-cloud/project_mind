import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ProjectListItem } from "../../lib/types";
import { ArchivedProjectsDialogContent as ArchivedProjectsDialog } from "./ArchivedProjectsDialogContent";

const projects: ProjectListItem[] = [
  { id: 11, name: "Alpha Research", rootPath: "/Workspace/Studies", kind: "normal", status: "active", quickNote: "", isArchived: true, createdAt: "", updatedAt: "", openTodoCount: 3 },
  { id: 27, name: "Beta Design", rootPath: "/Workspace/Design", kind: "normal", status: "active", quickNote: "", isArchived: true, createdAt: "", updatedAt: "", openTodoCount: 1 },
];

function setup(overrides: Partial<Parameters<typeof ArchivedProjectsDialog>[0]> = {}) {
  const props = {
    open: true,
    projects,
    onClose: vi.fn(),
    onOpenProject: vi.fn(),
    onRestoreProject: vi.fn(),
    ...overrides,
  };
  const view = render(<ArchivedProjectsDialog {...props} />);
  return { ...view, props };
}

function search(query: string) {
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索归档项目" }), { target: { value: query } });
}

describe("ArchivedProjectsDialog", () => {
  it.each(["  aLPHa  ", "  /wORKSPACE/sTUDIES  "])("searches names and root paths with trimmed, case-insensitive text: %s", (query) => {
    setup();
    search(query);
    expect(screen.getByRole("heading", { name: "Alpha Research" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Beta Design" })).not.toBeInTheDocument();
  });

  it("restores all projects when search is cleared or contains only whitespace", () => {
    setup();
    search("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(screen.getByRole("searchbox", { name: "搜索归档项目" })).toHaveValue("");
    expect(screen.getAllByRole("button", { name: "打开" })).toHaveLength(2);
    search("   ");
    expect(screen.getAllByRole("button", { name: "打开" })).toHaveLength(2);
  });

  it("closes before opening the matching project, and restores the matching project without closing", () => {
    const { props } = setup();
    search("design");
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    expect(props.onRestoreProject).toHaveBeenCalledExactlyOnceWith(27);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onOpenProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    expect(props.onOpenProject).toHaveBeenCalledExactlyOnceWith(27);
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onClose.mock.invocationCallOrder[0]).toBeLessThan(props.onOpenProject.mock.invocationCallOrder[0]);
  });

  it("delegates closing to the parent and resets search after an external close and reopen", () => {
    const { props, rerender } = setup();
    search("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "关闭对话框" }));
    expect(props.onClose).toHaveBeenCalledOnce();
    rerender(<ArchivedProjectsDialog {...props} open={false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    rerender(<ArchivedProjectsDialog {...props} open />);
    expect(screen.getByRole("searchbox", { name: "搜索归档项目" })).toHaveValue("");
    expect(screen.getAllByRole("button", { name: "打开" })).toHaveLength(2);
  });

  it("distinguishes an empty archive from a search with no matches", () => {
    const { props, rerender } = setup();
    search("missing");
    expect(screen.getByText("没有匹配的归档项目")).toBeVisible();
    expect(screen.queryByText("暂无归档项目")).not.toBeInTheDocument();
    rerender(<ArchivedProjectsDialog {...props} projects={[]} />);
    expect(screen.getByText("暂无归档项目")).toBeVisible();
    expect(screen.queryByText("没有匹配的归档项目")).not.toBeInTheDocument();
  });

  it("updates filtered results when the parent adds, removes or changes projects", () => {
    const { props, rerender } = setup();
    search("Studies");
    rerender(<ArchivedProjectsDialog {...props} projects={[projects[1]]} />);
    expect(screen.getByText("没有匹配的归档项目")).toBeVisible();
    const added = { ...projects[1], id: 39, name: "Gamma", rootPath: "/Workspace/Studies/Gamma" };
    rerender(<ArchivedProjectsDialog {...props} projects={[projects[1], added]} />);
    expect(screen.getByRole("heading", { name: "Gamma" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Alpha Research" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    expect(props.onRestoreProject).toHaveBeenCalledExactlyOnceWith(39);
    rerender(<ArchivedProjectsDialog {...props} projects={[{ ...added, rootPath: "/Elsewhere" }]} />);
    expect(screen.getByText("没有匹配的归档项目")).toBeVisible();
  });

  it("keeps the title and search outside the shared scroll list and preserves project details", () => {
    setup();
    const list = screen.getByRole("region", { name: "归档项目列表" });
    expect(list.parentElement).toHaveClass("home-side__list-frame");
    expect(within(list).queryByRole("searchbox")).not.toBeInTheDocument();
    expect(within(list).queryByRole("heading", { name: "归档项目" })).not.toBeInTheDocument();
    expect(within(list).queryByText("archived")).not.toBeInTheDocument();
    expect(within(list).getByText("/Workspace/Studies")).toBeVisible();
    expect(within(list).queryByText(/待办待跟进/)).not.toBeInTheDocument();
  });
});
