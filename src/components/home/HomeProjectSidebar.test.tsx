import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { HomeProjectSidebar } from "./HomeProjectSidebar";
import { createUiStoreState, useUiStore } from "../../state/ui-store";
import { usePrefetchFileApplications } from "../../hooks/useFileApplications";
import type { ComponentProps } from "react";
import { useProjectContentStore } from "../../state/project-content-store";
import { useListPinsStore } from "../../state/list-pins-store";
import type { NoteRecord } from "../../lib/types";

vi.mock("../../hooks/useFileApplications", () => ({ usePrefetchFileApplications: vi.fn() }));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: async () => ({ workspaceId: "native-workspace", generation: "1" }) } }));
vi.mock("../../services/projectFileApi", () => ({ projectFileApi: { resolve: async () => ({ relativePath: "generated/result.txt" }) } }));
vi.mock("../../services/projectMindApi", () => ({ projectMindApi: {
  projectTagSettingsGet: async () => ({ tags: [{ id: 7, label: "交付", colorKey: "blue" }] }),
} }));
vi.mock("./ProjectSidebarSessions", () => ({ ProjectSidebarSessions: ({ query, activeSessionId }: { query: string; activeSessionId?: string | null }) => <section aria-label="项目会话" data-active-session={activeSessionId}><span>会话</span><div role="region" aria-label="项目会话列表">{!query || "交付讨论".includes(query) ? "交付讨论" : "没有匹配的会话"}</div></section> }));
vi.mock("./HomeProjectFiles", () => ({ HomeProjectFiles: ({ filter, activeFileId }: { filter: { query: string; tagId: number | null }; activeFileId?: number | null }) => <section aria-label="项目文件" data-active-file={activeFileId}><span>文件</span><div role="region" aria-label="项目文件列表">{filter.query}:{filter.tagId}</div></section> }));

beforeEach(() => { localStorage.clear(); useListPinsStore.setState({ pins: {} }); useUiStore.setState(createUiStoreState()); useProjectContentStore.setState({ layouts: {} }); });
function setup(voiceProps: Partial<ComponentProps<typeof HomeProjectSidebar>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onTagChange = vi.fn();
  const onOpenRecord = vi.fn();
  const onOpenProject = vi.fn();
  const onOpenWorkspace = vi.fn();
  const props = { projectId: 1, projectName: "Alpha", workspaceRoot: "/workspace",
    project: { id: 1, name: "Alpha", rootPath: "/project" }, documents: [],
    records: Array.from({ length: 12 }, (_, index) => ({ id: index + 1, title: `记录 ${index + 1}`, contentMarkdown: index === 11 ? "交付依据" : "正文", tags: index === 11 ? [{ id: 7, label: "交付", colorKey: "blue" }] : [], createdAt: "2026-10-15", updatedAt: "2026-10-15" })) as NoteRecord[],
    selectedTagId: null, onTagChange, onOpenRecord, onOpenProject, onOpenWorkspace, onCreateRecord: vi.fn() };
  const component = (overrides: Partial<ComponentProps<typeof HomeProjectSidebar>> = {}) => <QueryClientProvider client={client}><HomeProjectSidebar {...props} {...voiceProps} {...overrides} /></QueryClientProvider>;
  const view = render(component());
  return { onTagChange, onOpenRecord, onOpenProject, onOpenWorkspace, onCreateRecord: props.onCreateRecord, view, component };
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

it("places voice creation before text creation and invokes each independently", () => {
  const onCreateVoiceRecord = vi.fn();
  const { onCreateRecord } = setup({ onCreateVoiceRecord });
  const voice = screen.getByRole("button", { name: "新增语音记录" });
  const text = screen.getByRole("button", { name: "新增记录" });
  expect(voice).toHaveAttribute("title", "新增语音记录");
  expect(voice.parentElement).toHaveClass("home-side__heading-actions");
  expect(voice.nextElementSibling).toBe(text);
  expect(voice).toBeEnabled();
  fireEvent.click(voice);
  expect(onCreateVoiceRecord).toHaveBeenCalledOnce();
  expect(onCreateRecord).not.toHaveBeenCalled();
  fireEvent.click(text);
  expect(onCreateRecord).toHaveBeenCalledOnce();
  expect(onCreateVoiceRecord).toHaveBeenCalledOnce();
});
it("disables only voice creation while pending", () => {
  const onCreateVoiceRecord = vi.fn();
  const { onCreateRecord } = setup({ onCreateVoiceRecord, creatingVoiceRecord: true });
  const voice = screen.getByRole("button", { name: "新增语音记录" });
  expect(voice).toBeDisabled();
  fireEvent.click(voice);
  expect(onCreateVoiceRecord).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "新增记录" }));
  expect(onCreateRecord).toHaveBeenCalledOnce();
});
it("hides voice creation when no callback is supplied", () => {
  setup();
  expect(screen.queryByRole("button", { name: "新增语音记录" })).not.toBeInTheDocument();
});

it("follows focused content across records, sessions and files and isolates project selection", async () => {
  const scope = { workspaceId: "native-workspace", projectId: 1 };
  const store = useProjectContentStore.getState();
  store.open(scope, { kind: "record", id: 12, title: "Record" });
  const { view, component } = setup();
  const record = await screen.findByRole("button", { name: "记录 12" });
  await vi.waitFor(() => expect(record).toHaveClass("is-active"));
  act(() => { store.open(scope, { kind: "session", id: "alpha", title: "Session" }); });
  expect(record).not.toHaveClass("is-active");
  expect(screen.getByRole("region", { name: "项目会话" })).toHaveAttribute("data-active-session", "alpha");
  act(() => { store.open(scope, { kind: "file", id: 42, title: "File" }); });
  expect(screen.getByRole("region", { name: "项目会话" })).not.toHaveAttribute("data-active-session");
  expect(screen.getByRole("region", { name: "项目文件" })).toHaveAttribute("data-active-file", "42");
  expect(record).not.toHaveClass("is-active");
  view.rerender(component({ projectId: 2, project: { id: 2, name: "Beta", rootPath: "/other" } }));
  expect(screen.getByRole("region", { name: "项目文件" })).not.toHaveAttribute("data-active-file");
  view.rerender(component());
  expect(screen.getByRole("region", { name: "项目文件" })).toHaveAttribute("data-active-file", "42");
  act(() => store.selectHome(scope));
  expect(screen.getByRole("region", { name: "项目文件" })).not.toHaveAttribute("data-active-file");
  expect(record).not.toHaveClass("is-active");
});

it("prefetches file applications for the sidebar project documents", () => {
  const documents: NonNullable<ComponentProps<typeof HomeProjectSidebar>["documents"]> = [{
    id: 42, projectId: 1, name: "report.pdf", baseName: "report.pdf", mimeType: "application/pdf",
    managedPath: "/project/report.pdf", originalPath: "", historyDirPath: "", isStarred: false,
    currentVersionNumber: 1, versionCount: 1, health: "normal", tags: [],
  }];
  setup({ documents });
  expect(usePrefetchFileApplications).toHaveBeenCalledWith("/workspace", 1, documents);
});

it("orders records by edits and ignores prior visits and opening", () => {
  localStorage.setItem("project-mind:recent-records:/workspace:1", "[1]");
  const records = [
    { id: 1, title: "旧记录", contentMarkdown: "正文", createdAt: "2026-10-01", updatedAt: "2026-10-01" },
    { id: 2, title: "新记录", contentMarkdown: "正文", createdAt: "2026-10-02", updatedAt: "2026-10-02" },
  ] as NoteRecord[];
  const { onOpenRecord, view, component } = setup({ records });
  const titles = () => within(screen.getByRole("region", { name: "项目记录列表" })).getAllByRole("button").map(item => item.title);
  expect(titles()).toEqual(["新记录", "旧记录"]);
  fireEvent.click(screen.getByRole("button", { name: "旧记录" }));
  expect(onOpenRecord).toHaveBeenCalledWith(1);
  expect(titles()).toEqual(["新记录", "旧记录"]);
  view.rerender(component({ records: [{ ...records[0], updatedAt: "2026-10-03" }, records[1]] }));
  expect(titles()).toEqual(["旧记录", "新记录"]);
});

it("pins and unpins records from the context menu without edit callbacks", () => {
  setup();
  const list = screen.getByRole("region", { name: "项目记录列表" });
  fireEvent.contextMenu(within(list).getByRole("button", { name: "记录 1" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "置顶" }));
  expect(within(list).getAllByRole("button")[0]).toHaveAttribute("title", "记录 1");
  expect(within(list).getByLabelText("已置顶")).toBeInTheDocument();
  const pin = screen.getByLabelText("已置顶");
  expect(pin).toHaveClass("list-pin-indicator");
  expect(pin.parentElement?.lastElementChild).toBe(pin);
  fireEvent.contextMenu(within(list).getByTitle("记录 1"));
  fireEvent.click(screen.getByRole("menuitem", { name: "取消置顶" }));
  expect(within(list).getAllByRole("button")[0]).toHaveAttribute("title", "记录 12");
});
