import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { fireEvent, render as baseRender, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createUiStoreState, useUiStore } from "../../state/ui-store";
import { WorkspaceOverviewSidebar } from "./WorkspaceOverviewSidebar";

function render(element: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return baseRender(element, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

type SidebarProps = ComponentProps<typeof WorkspaceOverviewSidebar>;

function sidebarProps(overrides: Partial<SidebarProps> = {}): SidebarProps {
  return {
    workspaceRootPath: "/tmp/workspace",
    projects: [],
    archivedProjects: [],
    records: [],
    recordQuery: "",
    onRecordQueryChange: vi.fn(),
    activeRecordTagId: null,
    onActiveRecordTagIdChange: vi.fn(),
    onOpenOverview: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenProjectInNewWindow: vi.fn(),
    onCreateProject: vi.fn(),
    onOpenArchivedProject: vi.fn(),
    onRestoreArchivedProject: vi.fn(),
    onRenameProject: vi.fn(),
    onArchiveProject: vi.fn(),
    onDeleteProject: vi.fn(),
    onOpenRecord: vi.fn(),
    onCreateRecord: vi.fn(),
    ...overrides,
  };
}

const workTag = { id: 23, label: "Work", colorKey: "blue" as const };
const unusedTag = { id: 24, label: "尚未使用", colorKey: "green" as const };
const records: SidebarProps["records"] = [
  { id: 11, title: "Needle 标题", contentMarkdown: "普通正文", tags: [workTag], updatedAt: "2026-09-01T08:00:00Z" },
  { id: 12, title: "正文命中", contentMarkdown: "正文包含 NEEDLE", tags: [workTag], updatedAt: "2026-09-03T08:00:00Z" },
  { id: 13, title: "标签命中", contentMarkdown: "普通正文", tags: [{ id: 25, label: "Needle", colorKey: "blue" }], updatedAt: "2026-09-02T08:00:00Z" },
  { id: 14, title: "无关记录", contentMarkdown: "普通正文", tags: [workTag], updatedAt: "2026-09-04T08:00:00Z" },
];

function recordList() {
  return within(screen.getByRole("region", { name: "工作区记录列表" }));
}

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

  it("shows records and unused tag chips, and reports tag selection and clearing", () => {
    useUiStore.setState({ workspaceSidebarTab: "records" });
    const props = sidebarProps({ records, availableTags: [workTag, unusedTag] });
    const { rerender } = render(<WorkspaceOverviewSidebar {...props} />);

    expect(screen.getByText("记录", { exact: true })).toBeInTheDocument();
    expect(recordList().getByRole("button", { name: /Needle 标题/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全部", pressed: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /#\s*尚未使用/, pressed: false }));
    expect(props.onActiveRecordTagIdChange).toHaveBeenLastCalledWith(24);

    rerender(<WorkspaceOverviewSidebar {...props} activeRecordTagId={24} />);
    expect(screen.getByRole("button", { name: /#\s*尚未使用/, pressed: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "全部", pressed: false }));
    expect(props.onActiveRecordTagIdChange).toHaveBeenLastCalledWith(null);
  });

  it("reports raw search input and follows the controlled query prop", () => {
    const props = sidebarProps({ records, recordQuery: "initial" });
    const { rerender } = render(<WorkspaceOverviewSidebar {...props} />);
    const search = screen.getByRole("textbox", { name: "搜索工作区记录" });
    expect(search).toHaveValue("initial");

    fireEvent.change(search, { target: { value: "  NeEdLe  " } });
    expect(props.onRecordQueryChange).toHaveBeenLastCalledWith("  NeEdLe  ");
    expect(search).toHaveValue("initial");

    rerender(<WorkspaceOverviewSidebar {...props} recordQuery="  NeEdLe  " />);
    expect(search).toHaveValue("  NeEdLe  ");
    expect(recordList().getAllByRole("button")).toHaveLength(3);
  });

  it("matches title, body and tags case-insensitively, then intersects the selected tag", () => {
    const props = sidebarProps({ records, availableTags: [workTag, unusedTag], recordQuery: "  nEeDlE  " });
    const { rerender } = render(<WorkspaceOverviewSidebar {...props} />);
    expect(recordList().getAllByRole("button").map(button => button.textContent)).toEqual([
      expect.stringContaining("正文命中"),
      expect.stringContaining("标签命中"),
      expect.stringContaining("Needle 标题"),
    ]);

    rerender(<WorkspaceOverviewSidebar {...props} activeRecordTagId={23} />);
    expect(recordList().getAllByRole("button").map(button => button.textContent)).toEqual([
      expect.stringContaining("正文命中"),
      expect.stringContaining("Needle 标题"),
    ]);
    expect(recordList().queryByText("无关记录")).not.toBeInTheDocument();

    rerender(<WorkspaceOverviewSidebar {...props} recordQuery="   " activeRecordTagId={23} />);
    expect(recordList().getAllByRole("button")).toHaveLength(3);
    expect(recordList().getByRole("button", { name: /无关记录/ })).toBeInTheDocument();
  });

  it.each([
    { name: "no records", items: [], query: "", tagId: null, message: /暂无.*记录/ },
    { name: "no search matches", items: records, query: "missing", tagId: null, message: /没有匹配.*记录/ },
    { name: "an unused tag", items: records, query: "", tagId: 24, message: /没有匹配.*记录/ },
  ])("shows the empty state for $name", ({ items, query, tagId, message }) => {
    render(<WorkspaceOverviewSidebar {...sidebarProps({ records: items, recordQuery: query, activeRecordTagId: tagId, availableTags: [workTag, unusedTag] })} />);
    expect(recordList().getByText(message)).toBeInTheDocument();
    expect(recordList().queryAllByRole("button")).toHaveLength(0);
  });

  it("keeps every record beyond twenty in descending update order and opens, creates and marks the current record", () => {
    const manyRecords = Array.from({ length: 25 }, (_, index) => ({
      id: index + 1,
      title: `记录 ${index + 1}`,
      contentMarkdown: "",
      tags: [],
      updatedAt: `2026-09-${String(index + 1).padStart(2, "0")}T08:00:00Z`,
    }));
    const props = sidebarProps({ records: manyRecords, activeRecordId: 7 });
    const { rerender } = render(<WorkspaceOverviewSidebar {...props} />);
    const buttons = recordList().getAllByRole("button");
    expect(buttons).toHaveLength(25);
    expect(buttons.map(button => button.textContent)).toEqual([
      "记录 25", "记录 24", "记录 23", "记录 22", "记录 21",
      "记录 20", "记录 19", "记录 18", "记录 17", "记录 16",
      "记录 15", "记录 14", "记录 13", "记录 12", "记录 11",
      "记录 10", "记录 9", "记录 8", "记录 7", "记录 6",
      "记录 5", "记录 4", "记录 3", "记录 2", "记录 1",
    ]);
    expect(recordList().getByRole("button", { current: "page" })).toHaveAccessibleName("记录 7");
    fireEvent.click(recordList().getByRole("button", { name: "记录 1", exact: true }));
    expect(props.onOpenRecord).toHaveBeenLastCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: "新增工作区记录" }));
    expect(props.onCreateRecord).toHaveBeenCalledTimes(1);

    rerender(<WorkspaceOverviewSidebar {...props} activeRecordId={1} />);
    expect(recordList().getByRole("button", { current: "page" })).toHaveAccessibleName("记录 1");
    expect(recordList().getByRole("button", { name: "记录 7", exact: true })).not.toHaveAttribute("aria-current", "page");
  });
});
