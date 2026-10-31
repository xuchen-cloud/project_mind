import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HomeNoteSidebar } from "./HomeNoteSidebar";
import { createUiStoreState, useUiStore } from "../../state/ui-store";
import { useListPinsStore } from "../../state/list-pins-store";

beforeEach(() => { localStorage.clear(); useListPinsStore.setState({ pins: {} }); useUiStore.setState(createUiStoreState()); });
const records = [{ id: 1, title: "旧记录", contentMarkdown: "正文", updatedAt: "2026-10-01" }, { id: 2, title: "新记录", contentMarkdown: "正文", updatedAt: "2026-10-02" }];
it("keeps opening order stable, moves edits, and pins within the current scope", () => {
  const onOpenRecord = vi.fn();
  const props = { workspaceRoot: "/workspace", records, activeRecordId: 2, onOpenRecord, onOpenWorkspace: vi.fn(), onCreateRecord: vi.fn() };
  const view = render(<HomeNoteSidebar {...props} />);
  const titles = () => within(screen.getByRole("region", { name: "最近记录列表" })).getAllByRole("button").map(item => item.title);
  expect(titles()).toEqual(["新记录", "旧记录"]);
  fireEvent.click(screen.getByRole("button", { name: "旧记录" }));
  expect(onOpenRecord).toHaveBeenCalledWith(1);
  expect(titles()).toEqual(["新记录", "旧记录"]);
  fireEvent.contextMenu(screen.getByRole("button", { name: "旧记录" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "置顶" }));
  expect(titles()).toEqual(["旧记录", "新记录"]);
  expect(screen.getByLabelText("已置顶")).toBeInTheDocument();
  const pin = screen.getByLabelText("已置顶");
  expect(pin).toHaveClass("list-pin-indicator");
  expect(pin.parentElement?.lastElementChild).toBe(pin);
  view.rerender(<HomeNoteSidebar {...props} projectId={7} />);
  expect(titles()).toEqual(["新记录", "旧记录"]);
  view.rerender(<HomeNoteSidebar {...props} />);
  fireEvent.contextMenu(screen.getByTitle("旧记录"));
  fireEvent.click(screen.getByRole("menuitem", { name: "取消置顶" }));
  expect(titles()).toEqual(["新记录", "旧记录"]);
  view.rerender(<HomeNoteSidebar {...props} records={[{ ...records[0], updatedAt: "2026-10-03" }, records[1]]} />);
  expect(titles()).toEqual(["旧记录", "新记录"]);
});
it("keeps rename and delete available beside pinning and skips unchanged renames", () => {
  const onRenameRecord = vi.fn(async () => undefined);
  const onDeleteRecord = vi.fn(async () => undefined);
  render(<HomeNoteSidebar workspaceRoot="/workspace" records={records} activeRecordId={2} onOpenRecord={vi.fn()} onOpenWorkspace={vi.fn()} onCreateRecord={vi.fn()} onRenameRecord={onRenameRecord} onDeleteRecord={onDeleteRecord} />);
  fireEvent.contextMenu(screen.getByTitle("旧记录"));
  expect(screen.getByRole("menuitem", { name: "置顶" })).toBeEnabled();
  expect(screen.getByRole("menuitem", { name: "删除记录" })).toBeEnabled();
  fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
  fireEvent.blur(screen.getByRole("textbox", { name: "重命名记录" }));
  expect(onRenameRecord).not.toHaveBeenCalled();
});


describe("existing note navigation", () => {
  const records = [
    { id: 1, title: "计划", contentMarkdown: "本周安排", updatedAt: "2026-09-26" },
    { id: 2, title: "复盘", contentMarkdown: "本周总结", updatedAt: "2026-09-27" },
  ];
it("workspace notes show only searchable recent records", () => {
  render(<HomeNoteSidebar workspaceRoot="/test" records={records} activeRecordId={1} onOpenWorkspace={vi.fn()} onOpenRecord={vi.fn()} onCreateRecord={vi.fn()} />);
  expect(screen.getAllByRole("button", { name: "我的工作区" }).find(button => button.classList.contains("home-side__identity-title"))).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "NoriMind" }).parentElement).toHaveClass("home-side__identity-subtitle");
  expect(screen.queryByText("最近文件")).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "搜索最近记录" }), { target: { value: "总结" } });
  expect(screen.getByRole("button", { name: "复盘" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "计划" })).not.toBeInTheDocument();
});
it("project notes host the shared file panel independently of record search", () => {
  const openFile = vi.fn();
  render(<HomeNoteSidebar workspaceRoot="/test" projectId={1} records={records}
    filePanel={<button onClick={openFile}>共享文件面板</button>}
    activeRecordId={1} onOpenWorkspace={vi.fn()} onOpenRecord={vi.fn()} onCreateRecord={vi.fn()} />);
  expect(screen.getByRole("separator", { name: "调整列表区域比例" })).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "搜索最近记录" }), { target: { value: "计划" } });
  expect(screen.getByRole("button", { name: "计划" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "共享文件面板" }));
  expect(openFile).toHaveBeenCalledOnce();
});

});
