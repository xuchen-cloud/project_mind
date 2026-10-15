import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { HomeNoteSidebar } from "./HomeNoteSidebar";
import { useUiStore } from "../../state/ui-store";

const records = [
  { id: 1, title: "计划", contentMarkdown: "本周安排", updatedAt: "2026-09-26" },
  { id: 2, title: "复盘", contentMarkdown: "本周总结", updatedAt: "2026-09-27" },
];
beforeEach(() => { localStorage.clear(); useUiStore.setState({ projectSidebarCollapsed: false }); });
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
