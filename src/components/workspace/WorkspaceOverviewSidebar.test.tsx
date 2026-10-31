import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { fireEvent, render as baseRender, screen, within, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createUiStoreState, useUiStore } from "../../state/ui-store";
import { useListPinsStore } from "../../state/list-pins-store";
import { useFeedbackStore } from "../../state/feedback-store";
import { WorkspaceOverviewSidebar } from "./WorkspaceOverviewSidebar";

function render(element: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return baseRender(element, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

const lists = vi.hoisted(() => ({ fileProps: vi.fn(), fileMount: vi.fn(), sessionMount: vi.fn() }));
vi.mock("../home/LazySidebarSessions", () => ({ LazySidebarSessions: ({ projectId }: { projectId: number | null }) => {
  lists.sessionMount(projectId);
  return <section><h3>会话</h3><div role="region" aria-label="工作区会话列表"><input aria-label="会话重命名" defaultValue="保留的会话草稿" /></div></section>;
} }));
vi.mock("../home/HomeProjectFiles", () => ({ HomeProjectFiles: (props: { fileScope: { projectId: number | null }; filter?: unknown }) => {
  const { fileScope } = props;
  lists.fileProps(props);
  lists.fileMount(fileScope.projectId);
  return <section><div role="region" aria-label="工作区文件列表"><input aria-label="文件重命名" defaultValue="原文件名" /></div></section>;
} }));

beforeEach(() => useListPinsStore.setState({ pins: {} }));

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
    fireEvent.click(screen.getByRole("tab", { name: "记录" }));

    expect(screen.getByRole("tab", { name: "记录", selected: true })).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("tab", { name: "记录" }));
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
    fireEvent.click(screen.getByRole("tab", { name: "记录" }));
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
    fireEvent.click(screen.getByRole("tab", { name: "记录" }));
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
    fireEvent.click(screen.getByRole("tab", { name: "记录" }));
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

it("defaults to Sessions without starting Files and exposes one mutually exclusive navigation panel", () => {
  lists.fileMount.mockClear(); lists.sessionMount.mockClear();
  const { container } = render(<WorkspaceOverviewSidebar {...sidebarProps()} />);
  expect(screen.getByRole("tab", { name: "会话", selected: true })).toHaveAttribute("tabindex", "0");
  expect(screen.getByRole("region", { name: "工作区会话列表" })).toBeVisible();
  expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  expect(screen.queryByRole("region", { name: "工作区记录列表" })).toBeNull();
  expect(screen.queryByRole("region", { name: "工作区文件列表" })).toBeNull();
  expect(lists.fileMount).not.toHaveBeenCalled();
  expect(lists.sessionMount).toHaveBeenCalledWith(null);
  expect(container.querySelector('.home-side__top .home-side__workspace-tab')).toBeNull();
  expect(screen.getByRole("separator", { name: "调整列表区域比例" })).toBeInTheDocument();
});

it("supports roving keyboard tabs with wraparound, Home and End", async () => {
  render(<WorkspaceOverviewSidebar {...sidebarProps()} />);
  const sessions = screen.getByRole("tab", { name: "会话" });
  const recordsTab = screen.getByRole("tab", { name: "记录" });
  const files = screen.getByRole("tab", { name: "文件" });
  sessions.focus();
  fireEvent.keyDown(sessions, { key: "ArrowRight" });
  expect(recordsTab).toHaveFocus();
  expect(recordsTab).toHaveAttribute("aria-selected", "true");
  expect(sessions).toHaveAttribute("tabindex", "-1");
  fireEvent.keyDown(recordsTab, { key: "End" });
  expect(files).toHaveFocus();
  await screen.findByRole("region", { name: "工作区文件列表" });
  expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  fireEvent.keyDown(files, { key: "ArrowRight" });
  expect(sessions).toHaveFocus();
  fireEvent.keyDown(sessions, { key: "ArrowLeft" });
  expect(files).toHaveFocus();
  fireEvent.keyDown(files, { key: "Home" });
  expect(sessions).toHaveFocus();
  expect(sessions).toHaveAttribute("aria-selected", "true");
});

it("preserves visited forms, scroll and record filters while switching lists", async () => {
  const props = sidebarProps({ records, recordQuery: "Needle", activeRecordTagId: 23 });
  const { rerender } = render(<WorkspaceOverviewSidebar {...props} />);
  const sessionDraft = screen.getByRole("textbox", { name: "会话重命名" });
  fireEvent.change(sessionDraft, { target: { value: "尚未提交的名称" } });
  const sessionList = screen.getByRole("region", { name: "工作区会话列表" });
  sessionList.scrollTop = 47;
  fireEvent.click(screen.getByRole("tab", { name: "记录" }));
  const search = screen.getByRole("textbox", { name: "搜索工作区记录" });
  expect(search).toHaveValue("Needle");
  expect(recordList().getAllByRole("button")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "新增工作区记录" }));
  expect(props.onCreateRecord).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("tab", { name: "文件" }));
  const fileDraft = await screen.findByRole("textbox", { name: "文件重命名" });
  fireEvent.change(fileDraft, { target: { value: "文件草稿" } });
  expect(lists.fileMount).toHaveBeenCalledWith(null);
  expect(screen.queryByRole("region", { name: "工作区记录列表" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "会话" }));
  expect(screen.getByRole("textbox", { name: "会话重命名" })).toBe(sessionDraft);
  expect(sessionDraft).toHaveValue("尚未提交的名称");
  expect(sessionList.scrollTop).toBe(47);
  fireEvent.click(screen.getByRole("tab", { name: "记录" }));
  expect(screen.getByRole("textbox", { name: "搜索工作区记录" })).toBe(search);
  expect(search).toHaveValue("Needle");
  fireEvent.click(recordList().getByRole("button", { name: /正文命中/ }));
  expect(props.onOpenRecord).toHaveBeenLastCalledWith(12);
  fireEvent.click(screen.getByRole("tab", { name: "文件" }));
  expect(screen.getByRole("textbox", { name: "文件重命名" })).toBe(fileDraft);
  expect(fileDraft).toHaveValue("文件草稿");
  rerender(<WorkspaceOverviewSidebar {...props} workspaceRootPath="/tmp/another-workspace" />);
  expect(screen.getByRole("tab", { name: "会话", selected: true })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "会话重命名" })).toHaveValue("保留的会话草稿");
  expect(screen.queryByRole("textbox", { name: "文件重命名", hidden: true })).toBeNull();
});

it("keeps Files independent from the Record query and selected tag", async () => {
  lists.fileProps.mockClear();
  render(<WorkspaceOverviewSidebar {...sidebarProps({ recordQuery: "记录专用搜索", activeRecordTagId: 23 })} />);
  fireEvent.click(screen.getByRole("tab", { name: "文件" }));
  await screen.findByRole("region", { name: "工作区文件列表" });
  expect(lists.fileProps).toHaveBeenCalled();
  const props = lists.fileProps.mock.lastCall?.[0];
  expect(props.fileScope.projectId).toBeNull();
  expect(props.fileScope.rootPath).toBe("/tmp/workspace/files");
  expect(props.filter).toBeUndefined();
});


it("opens record actions and commits trimmed names, while Escape, IME and unchanged names do not rename", async () => {
  const props = sidebarProps({ records, onRenameRecord: vi.fn(), onDeleteRecord: vi.fn() });
  render(<WorkspaceOverviewSidebar {...props} />);
  fireEvent.click(screen.getByRole("tab", { name: "记录" }));
  const rename = () => {
    fireEvent.contextMenu(recordList().getByRole("button", { name: /Needle 标题/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    return screen.getByRole("textbox", { name: "记录名称" });
  };
  let input = rename();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(props.onRenameRecord).not.toHaveBeenCalled();
  input = rename();
  fireEvent.change(input, { target: { value: " 草稿 " } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(props.onRenameRecord).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(props.onRenameRecord).not.toHaveBeenCalled();
  input = rename();
  fireEvent.change(input, { target: { value: " 新名称 " } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(props.onRenameRecord).toHaveBeenCalledExactlyOnceWith(records[0], "新名称");
  fireEvent.contextMenu(recordList().getByRole("button", { name: /Needle 标题/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
  expect(props.onDeleteRecord).toHaveBeenCalledExactlyOnceWith(records[0]);
});

it("reports rejected record rename and delete operations", async () => {
  useFeedbackStore.setState({ toasts: [] });
  render(<WorkspaceOverviewSidebar {...sidebarProps({ records, onRenameRecord: vi.fn().mockRejectedValue(new Error("rename failed")), onDeleteRecord: vi.fn().mockRejectedValue(new Error("delete failed")) })} />);
  fireEvent.click(screen.getByRole("tab", { name: "记录" }));
  fireEvent.contextMenu(recordList().getByRole("button", { name: /Needle 标题/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
  const input = screen.getByRole("textbox", { name: "记录名称" });
  fireEvent.change(input, { target: { value: "新标题" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(useFeedbackStore.getState().toasts).toEqual(expect.arrayContaining([expect.objectContaining({ tone: "error", detail: "rename failed" })])));
  fireEvent.contextMenu(recordList().getByRole("button", { name: /Needle 标题/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
  await waitFor(() => expect(useFeedbackStore.getState().toasts).toEqual(expect.arrayContaining([expect.objectContaining({ tone: "error", detail: "delete failed" })])));
});


it("pins records above newer updates, preserves pins through filters, and restores update order after unpinning", () => {
  const props = sidebarProps({ records, availableTags: [workTag], onRenameRecord: vi.fn(), onDeleteRecord: vi.fn() });
  const { rerender } = render(<WorkspaceOverviewSidebar {...props} />);
  fireEvent.click(screen.getByRole("tab", { name: "记录" }));
  fireEvent.contextMenu(recordList().getByRole("button", { name: /Needle 标题/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: "置顶" }));
  expect(recordList().getAllByRole("button")[0]).toHaveTextContent("Needle 标题");
  expect(recordList().getByRole("button", { name: /Needle 标题/ })).toContainElement(recordList().getByLabelText("已置顶"));
  const recordPin = recordList().getByLabelText("已置顶");
  expect(recordPin).toHaveClass("list-pin-indicator");
  expect(recordPin.parentElement?.lastElementChild).toBe(recordPin);
  rerender(<WorkspaceOverviewSidebar {...props} recordQuery="正文" activeRecordTagId={23} />);
  expect(recordList().getAllByRole("button")[0]).toHaveTextContent("Needle 标题");
  rerender(<WorkspaceOverviewSidebar {...props} recordQuery="无关" />);
  expect(recordList().queryByText("Needle 标题")).toBeNull();
  rerender(<WorkspaceOverviewSidebar {...props} />);
  expect(recordList().getAllByRole("button")[0]).toHaveTextContent("Needle 标题");
  fireEvent.contextMenu(recordList().getByRole("button", { name: /Needle 标题/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: "取消置顶" }));
  expect(recordList().getAllByRole("button")[0]).toHaveTextContent("无关记录");
});

it("pins projects independently and preserves pin ordering after project search is cleared", () => {
  const projects = [1, 2].map(id => ({ id, name: `项目 ${id}`, kind: "normal" as const, status: "active" as const, rootPath: `/tmp/p${id}`, quickNote: "", isArchived: false, createdAt: "", updatedAt: `2026-09-0${id}T08:00:00Z`, openTodoCount: 0 }));
  render(<WorkspaceOverviewSidebar {...sidebarProps({ projects })} />);
  const projectList = within(screen.getByRole("region", { name: "项目列表" }));
  expect(projectList.getAllByRole("button")[0]).toHaveTextContent("项目 2");
  fireEvent.contextMenu(projectList.getByRole("button", { name: "项目 1" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "置顶" }));
  expect(projectList.getAllByRole("button")[0]).toHaveTextContent("项目 1");
  const projectPin = projectList.getByLabelText("已置顶");
  expect(projectPin).toHaveClass("list-pin-indicator");
  expect(projectPin.parentElement?.lastElementChild).toBe(projectPin);
  const search = screen.getByRole("textbox", { name: "搜索项目" });
  fireEvent.change(search, { target: { value: "项目 2" } });
  expect(projectList.getAllByRole("button")).toHaveLength(1);
  fireEvent.change(search, { target: { value: "" } });
  expect(projectList.getAllByRole("button")[0]).toHaveTextContent("项目 1");
  fireEvent.contextMenu(projectList.getByRole("button", { name: /项目 1/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: "取消置顶" }));
  expect(projectList.getAllByRole("button")[0]).toHaveTextContent("项目 2");
});

it("preserves the native text menu while renaming a workspace record", () => {
  useUiStore.setState(createUiStoreState());
  render(<WorkspaceOverviewSidebar {...sidebarProps({ records, onRenameRecord: vi.fn() })} />);
  fireEvent.click(screen.getByRole("tab", { name: "记录" }));
  fireEvent.contextMenu(recordList().getByRole("button", { name: /Needle 标题/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
  const input = screen.getByRole("textbox", { name: "记录名称" });
  expect(fireEvent.contextMenu(input)).toBe(true);
  expect(screen.queryByRole("menu", { name: "记录操作" })).not.toBeInTheDocument();
});
