import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { HomeProjectSidebar } from "./HomeProjectSidebar";
import { createUiStoreState, useUiStore } from "../../state/ui-store";
import type { NoteRecord } from "../../lib/types";

vi.mock("../../services/projectMindApi", () => ({ projectMindApi: {
  projectTagSettingsGet: async () => ({ tags: [{ id: 7, label: "交付", colorKey: "blue" }] }),
} }));
vi.mock("./ProjectSidebarSessions", () => ({ ProjectSidebarSessions: ({ query }: { query: string }) => <section aria-label="项目会话"><span>会话</span><div role="region" aria-label="项目会话列表">{!query || "交付讨论".includes(query) ? "交付讨论" : "没有匹配的会话"}</div></section> }));
vi.mock("./HomeProjectFiles", () => ({ HomeProjectFiles: ({ filter }: { filter: { query: string; tagId: number | null } }) => <section aria-label="项目文件"><span>文件</span><div role="region" aria-label="项目文件列表">{filter.query}:{filter.tagId}</div></section> }));

beforeEach(() => { localStorage.clear(); useUiStore.setState(createUiStoreState()); });
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onTagChange = vi.fn();
  const onOpenRecord = vi.fn();
  const onOpenProject = vi.fn();
  const onOpenWorkspace = vi.fn();
  const props = { projectId: 1, projectName: "Alpha", workspaceRoot: "/workspace",
    project: { id: 1, name: "Alpha", rootPath: "/project" }, documents: [],
    records: Array.from({ length: 12 }, (_, index) => ({ id: index + 1, title: `记录 ${index + 1}`, contentMarkdown: index === 11 ? "交付依据" : "正文", tags: index === 11 ? [{ id: 7, label: "交付", colorKey: "blue" }] : [], createdAt: "2026-10-15", updatedAt: "2026-10-15" })) as NoteRecord[],
    selectedTagId: null, onTagChange, onOpenRecord, onOpenProject, onOpenWorkspace, onCreateRecord: vi.fn() };
  render(<QueryClientProvider client={client}><HomeProjectSidebar {...props} /></QueryClientProvider>);
  return { onTagChange, onOpenRecord, onOpenProject, onOpenWorkspace };
}
it("opens the project from its title and the workspace from its subtitle independently", async () => {
  const { onOpenProject, onOpenWorkspace, onOpenRecord } = setup();
  await screen.findByRole("button", { name: "#交付" });
  const title = screen.getByRole("button", { name: "Alpha" });
  expect(title).toHaveClass("home-side__identity-title");
  expect(title).toHaveAttribute("type", "button");
  expect(title).toHaveAttribute("title", "Alpha");
  fireEvent.click(title);
  expect(onOpenProject).toHaveBeenCalledOnce();
  expect(onOpenWorkspace).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "NoriMind · 我的工作区" }));
  expect(onOpenWorkspace).toHaveBeenCalledOnce();
  expect(onOpenProject).toHaveBeenCalledOnce();
  expect(onOpenRecord).not.toHaveBeenCalled();
});
it("shows all records and orders fixed navigation above independent content lists", async () => {
  const { onOpenRecord } = setup();
  await screen.findByRole("button", { name: "#交付" });
  const sidebar = screen.getByRole("complementary", { name: "项目导航侧边栏" });
  expect(within(sidebar).getByText("Alpha")).toHaveClass("home-side__identity-title");
  expect(within(sidebar).getByText("Alpha").compareDocumentPosition(screen.getByRole("textbox", { name: "搜索项目内容" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const lists = within(sidebar).getAllByRole("region").map(node => node.getAttribute("aria-label")).filter(label => label?.endsWith("列表"));
  expect(lists).toEqual(["项目标签列表", "项目记录列表", "项目会话列表", "项目文件列表"]);
  fireEvent.click(within(screen.getByRole("region", { name: "项目记录列表" })).getByRole("button", { name: "记录 12" }));
  expect(onOpenRecord).toHaveBeenCalledWith(12);
});
it("filters record bodies and forwards the same query and tag to the other modules", async () => {
  const { onTagChange } = setup();
  fireEvent.change(screen.getByRole("textbox", { name: "搜索项目内容" }), { target: { value: "交付" } });
  const records = screen.getByRole("region", { name: "项目记录列表" });
  expect(within(records).getByRole("button", { name: "记录 12" })).toBeInTheDocument();
  expect(within(records).queryByRole("button", { name: "记录 1" })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "项目会话列表" })).toHaveTextContent("交付讨论");
  expect(screen.getByRole("region", { name: "项目文件列表" })).toHaveTextContent("交付:");
  fireEvent.click(await screen.findByRole("button", { name: "#交付" }));
  expect(onTagChange).toHaveBeenCalledWith(7);
  fireEvent.change(screen.getByRole("textbox", { name: "搜索项目内容" }), { target: { value: "无匹配" } });
  expect(records).toHaveTextContent("没有匹配的记录");
});
