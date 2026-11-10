import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { act, fireEvent, render as baseRender, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectSidebarSessions, type ProjectSidebarSessionsProps } from "./ProjectSidebarSessions";
import { useAgentPanelStore } from "../../state/agent-panel-store";

const api = vi.hoisted(() => ({ binding: vi.fn(async (root: string) => ({ workspaceId: root, generation: "open-1" })), start: vi.fn(), summaries: vi.fn(), selectSession: vi.fn(), open: vi.fn(), manage: vi.fn() }));
vi.mock("../../services/dshAssistantApi", () => ({ dshAssistantApi: { ...api, summaries: async (...args: unknown[]) => ({ revision: "r1", items: await api.summaries(...args) }) } }));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: api.binding } }));
vi.mock("../../services/projectContentApi", () => ({ openProjectContent: api.open, manageProjectSession: api.manage }));

let client: QueryClient;
function render(element: ReactElement) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return baseRender(element, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
}
const saved = [
  { id: "alpha", title: "Alpha 方案", running: false },
  { id: "beta", title: "Beta 复盘", running: false },
];
const defaults: ProjectSidebarSessionsProps = { workspaceRoot: "/workspace", projectId: 7, query: "", enabled: true };
function component(props: Partial<ProjectSidebarSessionsProps> = {}) {
  return <ProjectSidebarSessions {...defaults} {...props} />;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((pass, fail) => { resolve = pass; reject = fail; });
  return { promise, resolve, reject };
}
afterEach(() => { client?.clear(); vi.useRealTimers(); });
beforeEach(() => {
  vi.clearAllMocks();
  api.binding.mockReset().mockImplementation(async (root: string) => ({ workspaceId: root, generation: "open-1" }));
  api.summaries.mockReset();
  api.open.mockReset();
  api.selectSession.mockReset();
  api.manage.mockReset();
  api.start.mockResolvedValue(undefined);
  api.summaries.mockResolvedValue(saved);
  api.selectSession.mockImplementation(async (id: string | null) => id ?? "new-id");
  api.open.mockResolvedValue(undefined);
  api.manage.mockResolvedValue(null);
  useAgentPanelStore.getState().clearWorkspace();
  useAgentPanelStore.getState().bindWorkspace(defaults.workspaceRoot);
});

it("loads real API sessions without selecting/creating, and filters titles locally", async () => {
  const view = render(component());
  expect(screen.getByRole("status")).toHaveAccessibleName("正在读取项目会话");
  await screen.findByRole("button", { name: "Alpha 方案" });
  expect(api.start).not.toHaveBeenCalled();
  expect(api.summaries).toHaveBeenCalledWith(7, { workspaceId: "/workspace", generation: "open-1" });
  expect(api.selectSession).not.toHaveBeenCalled();
  const list = screen.getByRole("region", { name: "项目会话列表" });
  expect(list.parentElement).toHaveClass("home-side__list-frame");
  expect(within(list).getAllByRole("button")).toHaveLength(2);
  view.rerender(component({ query: " aLPHa " }));
  expect(screen.getByRole("button", { name: "Alpha 方案" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Beta/ })).toBeNull();
  view.rerender(component({ query: "missing" }));
  expect(screen.getByText("没有匹配的会话")).toBeInTheDocument();
  expect(api.summaries).toHaveBeenCalledTimes(1);
  expect(api.start).not.toHaveBeenCalled();
});

it("shows the loading spinner in the heading immediately before creation", async () => {
  const pending = deferred<typeof saved>();
  api.summaries.mockReturnValueOnce(pending.promise);
  render(component());
  const status = screen.getByRole("status");
  expect(status).toHaveAccessibleName("正在读取项目会话");
  expect(status).toHaveTextContent("");
  expect(status.querySelector("svg")).toHaveClass("spin");
  expect(screen.queryByText(/正在读取|正在打开/)).toBeNull();
  expect(screen.queryByRole("button", { name: "刷新会话" })).toBeNull();
  const create = screen.getByRole("button", { name: "新增会话" });
  expect(create).toBeEnabled();
  expect(create.previousElementSibling).toBe(status);
  expect(status.closest(".home-side__heading")).not.toBeNull();
  expect(screen.getByRole("region", { name: "项目会话列表" })).not.toContainElement(status);
  await act(async () => pending.resolve(saved));
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  expect(create).toBeEnabled();
});

it("selects existing sessions and opens project content with a cancellation signal", async () => {
  const view = render(component());
  fireEvent.click(await screen.findByRole("button", { name: "Alpha 方案" }));
  await waitFor(() => expect(api.open).toHaveBeenCalledWith({
    workspaceRoot: "/workspace", projectId: 7,
    object: { kind: "session", id: "alpha", title: "Alpha 方案" }, signal: expect.any(AbortSignal),
  }));
  expect(api.selectSession).toHaveBeenCalledWith("alpha", 7);
  expect(useAgentPanelStore.getState().open).toBe(false);
  view.unmount();
});

it("creates only on explicit click and refreshes the list after opening", async () => {
  api.summaries.mockResolvedValueOnce([]).mockResolvedValue([{ id: "new-id", title: "新会话", running: false }]);
  render(component());
  await screen.findByText("暂无会话");
  expect(api.selectSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "新增会话" }));
  await screen.findByRole("button", { name: "新会话" });
  expect(api.selectSession).toHaveBeenCalledExactlyOnceWith(null, 7);
  expect(api.open.mock.calls[0][0].object).toEqual({ kind: "session", id: "new-id", title: "新会话" });
  expect(api.summaries).toHaveBeenCalledTimes(2);
});

it.each(["summaries"] as const)("shows %s errors and retries only on request", async method => {
  api[method].mockRejectedValueOnce(new Error("服务不可用"));
  render(component());
  expect(await screen.findByRole("alert")).toHaveTextContent("服务不可用");
  expect(api[method]).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByRole("button", { name: "Alpha 方案" });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(api.selectSession).not.toHaveBeenCalled();
});

it("retries a failed open of a newly created session without creating another", async () => {
  api.open.mockRejectedValueOnce(new Error("打开失败"));
  render(component());
  await screen.findByRole("button", { name: "Alpha 方案" });
  fireEvent.click(screen.getByRole("button", { name: "新增会话" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("打开失败");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(api.open).toHaveBeenCalledTimes(2));
  expect(api.selectSession.mock.calls).toEqual([[null, 7], ["new-id", 7]]);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("shows selection errors and allows retry of the same session", async () => {
  api.selectSession.mockRejectedValueOnce(new Error("选择失败"));
  render(component());
  fireEvent.click(await screen.findByRole("button", { name: "Alpha 方案" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("选择失败");
  expect(api.open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(api.open).toHaveBeenCalledTimes(1));
  expect(api.selectSession.mock.calls).toEqual([["alpha", 7], ["alpha", 7]]);
});

it("does no initial work while collapsed and reuses a same-generation pending list after expanding", async () => {
  const pending = deferred<typeof saved>();
  api.summaries.mockReturnValueOnce(pending.promise);
  const view = render(component({ enabled: false }));
  expect(api.summaries).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "新增会话" })).toBeDisabled();
  view.rerender(component());
  await waitFor(() => expect(api.summaries).toHaveBeenCalledTimes(1));
  view.rerender(component({ enabled: false }));
  await act(async () => pending.resolve(saved));
  view.rerender(component());
  await screen.findByRole("button", { name: "Alpha 方案" });
  expect(api.summaries).toHaveBeenCalledTimes(1);
  expect(api.selectSession).not.toHaveBeenCalled();
});

it.each([{ projectId: 8 }, { workspaceRoot: "/other" }])("isolates delayed list results across scope switch %j", async scope => {
  const pending = deferred<typeof saved>();
  api.summaries.mockReturnValueOnce(pending.promise).mockResolvedValue([{ id: "other", title: "新范围", running: false }]);
  const view = render(component());
  await waitFor(() => expect(api.summaries).toHaveBeenCalledTimes(1));
  view.rerender(component(scope));
  await screen.findByRole("button", { name: "新范围" });
  await act(async () => pending.resolve(saved));
  expect(screen.queryByRole("button", { name: "Alpha 方案" })).toBeNull();
  expect(screen.getByRole("button", { name: "新范围" })).toBeInTheDocument();
});

it("reuses an in-flight read after A-B-A without requesting A twice", async () => {
  const pending = deferred<typeof saved>();
  api.summaries.mockReturnValueOnce(pending.promise);
  const view = render(component());
  await waitFor(() => expect(api.summaries).toHaveBeenCalledTimes(1));
  view.rerender(component({ projectId: 8 }));
  await screen.findByRole("button", { name: "Alpha 方案" });
  view.rerender(component());
  expect(screen.queryByRole("button", { name: "Alpha 方案" })).toBeNull();
  await act(async () => pending.resolve(saved));
  await screen.findByRole("button", { name: "Alpha 方案" });
  expect(api.summaries).toHaveBeenCalledTimes(2);
});

it.each([{ projectId: 8 }, { workspaceRoot: "/other" }, { enabled: false }])("does not open after an in-flight selection crosses a boundary %j", async scope => {
  const pending = deferred<string>();
  api.selectSession.mockReturnValueOnce(pending.promise);
  const view = render(component());
  fireEvent.click(await screen.findByRole("button", { name: "Alpha 方案" }));
  await waitFor(() => expect(api.selectSession).toHaveBeenCalledTimes(1));
  view.rerender(component(scope));
  await act(async () => pending.resolve("alpha"));
  expect(api.open).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each([{ projectId: 8 }, { workspaceRoot: "/other" }, { enabled: false }])("aborts content opening on scope/visibility change %j", async scope => {
  const pending = deferred<void>();
  api.open.mockReturnValueOnce(pending.promise);
  const view = render(component());
  fireEvent.click(await screen.findByRole("button", { name: "Alpha 方案" }));
  await waitFor(() => expect(api.open).toHaveBeenCalledTimes(1));
  const signal = api.open.mock.calls[0][0].signal as AbortSignal;
  view.rerender(component(scope));
  expect(signal.aborted).toBe(true);
  await act(async () => pending.reject(new Error("打开已取消")));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("reuses runtime status without starting an active run or polling", async () => {
  useAgentPanelStore.getState().setRunBusy("/workspace", 7, true);
  useAgentPanelStore.getState().setSessionRuns("/workspace", 7, { alpha: true, beta: false });
  const view = render(component());
  const alpha = await screen.findByRole("button", { name: /Alpha/ });
  const running = within(alpha).getByRole("status", { name: "运行中" });
  expect(running.tagName.toLowerCase()).toBe("svg");
  expect(running).toHaveClass("home-side__running", "spin");
  expect(alpha.lastElementChild).toBe(running);
  expect(alpha).not.toHaveTextContent("运行中");
  expect(within(screen.getByRole("button", { name: /Beta/ })).queryByLabelText("运行中")).toBeNull();
  act(() => useAgentPanelStore.getState().setSessionRuns("/workspace", 7, { alpha: false, beta: true }));
  expect(within(alpha).queryByLabelText("运行中")).toBeNull();
  expect(within(screen.getByRole("button", { name: /Beta/ })).getByLabelText("运行中")).toBeInTheDocument();
  act(() => useAgentPanelStore.getState().setSessionRuns("/workspace", 7, {}));
  expect(screen.queryByLabelText("运行中")).toBeNull();
  expect(api.start).not.toHaveBeenCalled();
  expect(api.summaries).toHaveBeenCalledTimes(1);
  view.unmount();
});

it("keeps edge fades confined to the list and remeasures after filtering", async () => {
  const view = render(component());
  await screen.findByRole("button", { name: "Alpha 方案" });
  const list = screen.getByRole("region", { name: "项目会话列表" });
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 300 },
  });
  fireEvent.scroll(list, { target: { scrollTop: 0 } });
  expect(list).toHaveAttribute("data-overflow-bottom");
  expect(list).not.toHaveAttribute("data-overflow-top");
  fireEvent.scroll(list, { target: { scrollTop: 32 } });
  expect(list.parentElement!.style.getPropertyValue("--scroll-fade-top-opacity")).toBe("0.5");
  expect(list.contains(screen.getByRole("button", { name: "新增会话" }))).toBe(false);
  Object.defineProperty(list, "scrollHeight", { configurable: true, value: 100 });
  view.rerender(component({ query: "alpha" }));
  expect(list).not.toHaveAttribute("data-overflow-top");
  expect(list).not.toHaveAttribute("data-overflow-bottom");
});

it("ignores repeated clicks while a selection is pending", async () => {
  const pending = deferred<string>();
  api.selectSession.mockReturnValueOnce(pending.promise);
  render(component());
  fireEvent.click(await screen.findByRole("button", { name: "Alpha 方案" }));
  fireEvent.click(screen.getByRole("button", { name: "新增会话" }));
  await waitFor(() => expect(api.selectSession).toHaveBeenCalledTimes(1));
  await act(async () => pending.resolve("alpha"));
  expect(api.open).toHaveBeenCalledTimes(1);
});

it("uses only focused session props for selection, never an opening click", async () => {
  const view = render(component({ activeSessionId: "alpha" }));
  const alpha = await screen.findByRole("button", { name: "Alpha 方案" });
  const beta = screen.getByRole("button", { name: "Beta 复盘" });
  expect(alpha).toHaveClass("is-active");
  expect(beta).not.toHaveClass("is-active");
  fireEvent.click(beta);
  await waitFor(() => expect(api.open).toHaveBeenCalled());
  expect(alpha).toHaveClass("is-active");
  expect(beta).not.toHaveClass("is-active");
  view.rerender(component({ activeSessionId: "beta" }));
  expect(alpha).not.toHaveClass("is-active");
  expect(beta).toHaveClass("is-active");
  view.rerender(component({ activeSessionId: null }));
  expect(beta).not.toHaveClass("is-active");
});

it("automatically syncs this project's catalog and on focus without blanking the list", async () => {
  const pending = deferred<typeof saved>();
  const view = render(component());
  await screen.findByRole("button", { name: "Alpha 方案" });
  api.summaries.mockReturnValueOnce(pending.promise);
  act(() => window.dispatchEvent(new CustomEvent("mind:dsh-sessions-changed", { detail: { projectId: 8 } })));
  expect(api.summaries).toHaveBeenCalledTimes(1);
  act(() => window.dispatchEvent(new CustomEvent("mind:dsh-sessions-changed", { detail: { projectId: 7 } })));
  await waitFor(() => expect(api.summaries).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "Alpha 方案" })).toBeVisible();
  expect(screen.getByRole("status")).toHaveAccessibleName("正在读取项目会话");
  expect(screen.queryByText(/正在读取|正在打开/)).toBeNull();
  await act(async () => pending.resolve([{ id: "beta", title: "更新的标题", running: false }]));
  await screen.findByRole("button", { name: "更新的标题" });
  expect(screen.queryByRole("button", { name: "Alpha 方案" })).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
  api.summaries.mockResolvedValue([]);
  act(() => window.dispatchEvent(new Event("focus")));
  expect(api.summaries).toHaveBeenCalledTimes(2);
  const { sessionSummariesQueryOptions } = await import("../../lib/session-summaries");
  const options = sessionSummariesQueryOptions({ workspaceId: "/workspace", generation: "open-1" }, 7);
  act(() => client.setQueryData(options.queryKey, client.getQueryData(options.queryKey), { updatedAt: Date.now() - 16_000 }));
  act(() => window.dispatchEvent(new Event("focus")));
  await screen.findByText("暂无会话");
  view.rerender(component({ enabled: false }));
  act(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new CustomEvent("mind:dsh-sessions-changed", { detail: { projectId: 7 } }));
  });
  expect(api.summaries).toHaveBeenCalledTimes(3);
  view.unmount();
  act(() => window.dispatchEvent(new Event("focus")));
  expect(api.summaries).toHaveBeenCalledTimes(3);
});

it("shows a single text-free spinner until content opening finishes", async () => {
  const pending = deferred<void>();
  api.open.mockReturnValueOnce(pending.promise);
  render(component());
  fireEvent.click(await screen.findByRole("button", { name: "Alpha 方案" }));
  await waitFor(() => expect(api.open).toHaveBeenCalledTimes(1));
  const status = screen.getByRole("status");
  expect(status).toHaveAccessibleName("正在打开会话");
  expect(status.textContent).toBe("");
  expect(status.querySelector("svg")).toHaveClass("spin");
  expect(screen.queryByText(/正在读取|正在打开/)).toBeNull();
  expect(screen.getByRole("button", { name: "新增会话" }).previousElementSibling).toBe(status);
  expect(screen.getByRole("button", { name: "新增会话" })).toBeDisabled();
  await act(async () => pending.resolve());
  expect(screen.queryByRole("status")).toBeNull();
});


it("offers the standard session context menu and commits an inline rename", async () => {
  api.summaries.mockResolvedValueOnce(saved).mockResolvedValue([{ ...saved[0], title: "新标题" }]);
  render(component());
  fireEvent.contextMenu(await screen.findByRole("button", { name: "Alpha 方案" }), { clientX: 40, clientY: 70 });
  const menu = screen.getByRole("menu", { name: "会话操作" });
  expect(menu.closest(".context-menu__panel")).not.toBeNull();
  expect(within(menu).getAllByRole("menuitem").map(item => item.textContent)).toEqual(["重命名", "置顶", "分叉会话", "归档", "删除"]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "重命名" }));
  const field = screen.getByRole("textbox", { name: "重命名会话" });
  fireEvent.change(field, { target: { value: "新标题" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(api.manage).toHaveBeenCalledWith({ workspaceRoot: "/workspace", projectId: 7, sessionId: "alpha", action: { kind: "rename", title: "新标题" }, signal: expect.any(AbortSignal) }));
  await screen.findByRole("button", { name: "新标题" });
});

it.each([
  [false, "置顶", "pin"], [true, "取消置顶", "unpin"], [false, "归档", "archive"],
] as const)("performs %s/%s and automatically reloads", async (pinned, label, kind) => {
  api.summaries.mockResolvedValue([{ id: "alpha", title: "Alpha", running: false, pinned }]);
  render(component());
  fireEvent.contextMenu(await screen.findByRole("button", { name: /Alpha/ }), { clientX: 40, clientY: 70 });
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
  await waitFor(() => expect(api.manage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "alpha", action: { kind } })));
  await waitFor(() => expect(api.summaries).toHaveBeenCalledTimes(2));
});

it("confirms deletion before removing the session", async () => {
  api.summaries.mockResolvedValueOnce(saved).mockResolvedValue([]);
  render(component());
  fireEvent.contextMenu(await screen.findByRole("button", { name: "Alpha 方案" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
  const dialog = screen.getByRole("dialog", { name: "删除会话" });
  expect(api.manage).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
  await waitFor(() => expect(api.manage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "alpha", action: { kind: "delete" } })));
  await screen.findByText("暂无会话");
});

it("retries opening a fork without creating another fork", async () => {
  api.manage.mockResolvedValueOnce("child");
  api.open.mockRejectedValueOnce(new Error("打开失败"));
  render(component());
  fireEvent.contextMenu(await screen.findByRole("button", { name: "Alpha 方案" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "分叉会话" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("打开失败");
  expect(api.open).toHaveBeenCalledWith(expect.objectContaining({ object: { kind: "session", id: "child", title: "Alpha 方案" } }));
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(api.open).toHaveBeenCalledTimes(2));
  expect(api.manage).toHaveBeenCalledTimes(1);
  expect(api.selectSession).toHaveBeenCalledWith("child", 7);
});

it("discards a pending fork after switching projects", async () => {
  const pending = deferred<string>();
  api.manage.mockReturnValueOnce(pending.promise);
  const view = render(component());
  fireEvent.contextMenu(await screen.findByRole("button", { name: "Alpha 方案" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "分叉会话" }));
  await waitFor(() => expect(api.manage).toHaveBeenCalled());
  view.rerender(component({ projectId: 8 }));
  await act(async () => pending.resolve("child"));
  expect(api.open).not.toHaveBeenCalled();
});

it("cancels inline rename with Escape without saving", async () => {
  render(component());
  fireEvent.contextMenu(await screen.findByRole("button", { name: "Alpha 方案" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
  const field = screen.getByRole("textbox", { name: "重命名会话" });
  fireEvent.change(field, { target: { value: "unsaved" } });
  fireEvent.keyDown(field, { key: "Escape" });
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(api.manage).not.toHaveBeenCalled();
});

it("opens a real Workspace session through the same content Tabs as Project sessions", async () => {
  render(component({ projectId: null }));
  fireEvent.click(await screen.findByRole("button", { name: "Alpha 方案" }));
  await waitFor(() => expect(api.open).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: "/workspace", projectId: null, object: { kind: "session", id: "alpha", title: "Alpha 方案" } })));
  expect(api.selectSession).toHaveBeenCalledWith("alpha", null);
  expect(useAgentPanelStore.getState().open).toBe(false);
});

it("retries an unknown fork result with the same stable child identity", async () => {
  api.manage.mockRejectedValueOnce(new Error("响应丢失")).mockImplementationOnce(async input => input.action.childSessionId);
  render(component());
  fireEvent.contextMenu(await screen.findByRole("button", { name: "Alpha 方案" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "分叉会话" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("响应丢失");
  const original = api.manage.mock.calls[0][0];
  expect(original.action.childSessionId).toMatch(/^session-[0-9a-f-]{36}$/);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(api.open).toHaveBeenCalledWith(expect.objectContaining({object:{kind:"session",id:original.action.childSessionId,title:"Alpha 方案"}})));
  expect(api.manage.mock.calls[1][0].action).toEqual(original.action);
});


it("reuses fresh A on A-B-A and keeps known names usable after an explicit refresh fails", async () => {
  const view = render(component());
  await screen.findByRole("button", { name: "Alpha 方案" });
  const other = deferred<typeof saved>();
  api.summaries.mockReturnValueOnce(other.promise).mockRejectedValueOnce(new Error("刷新失败"));
  view.rerender(component({ projectId: 8 }));
  await waitFor(() => expect(api.summaries).toHaveBeenCalledTimes(2));
  view.rerender(component());
  expect(screen.getByRole("button", { name: "Alpha 方案" })).toBeEnabled();
  expect(api.summaries).toHaveBeenCalledTimes(2);
  act(() => window.dispatchEvent(new CustomEvent("mind:dsh-sessions-changed", { detail: { projectId: 7 } })));
  expect(await screen.findByRole("alert")).toHaveTextContent("刷新失败");
  fireEvent.click(screen.getByRole("button", { name: "Alpha 方案" }));
  await waitFor(() => expect(api.open).toHaveBeenCalled());
  await act(async () => other.resolve([{ id: "other", title: "其他项目", running: false }]));
  expect(screen.queryByRole("button", { name: "其他项目" })).toBeNull();
});

it("keeps names and creation usable during refresh, and replaces the pre-mutation snapshot", async () => {
  render(component());
  await screen.findByRole("button", { name: "Alpha 方案" });
  const old = deferred<typeof saved>();
  api.summaries.mockReturnValueOnce(old.promise).mockResolvedValueOnce([{ id: "new-id", title: "新会话", running: false }]);
  act(() => window.dispatchEvent(new CustomEvent("mind:dsh-sessions-changed", { detail: { projectId: 7 } })));
  await waitFor(() => expect(api.summaries).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "Alpha 方案" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "新增会话" }));
  await screen.findByRole("button", { name: "新会话" });
  await act(async () => old.resolve([]));
  expect(screen.getByRole("button", { name: "新会话" })).toBeVisible();
});

it("subscribes both sidebars to a single catalog-event refresh", async () => {
  render(<>{component()}{component()}</>);
  await screen.findAllByRole("button", { name: "Alpha 方案" });
  api.summaries.mockResolvedValueOnce([{ id: "new", title: "最新名称", running: false }]);
  act(() => window.dispatchEvent(new CustomEvent("mind:dsh-sessions-changed", { detail: { projectId: 7 } })));
  expect(await screen.findAllByRole("button", { name: "最新名称" })).toHaveLength(2);
  expect(api.summaries).toHaveBeenCalledTimes(2);
});

it.each([7, null])("keeps the pinned running session indicator last in scope %s", async (projectId) => {
  api.summaries.mockResolvedValue([{ ...saved[0], pinned: true }]);
  useAgentPanelStore.getState().setSessionRuns("/workspace", projectId, { alpha: true });
  render(component({ projectId }));
  const row = await screen.findByTitle("Alpha 方案");
  const pin = within(row).getByLabelText("已置顶");
  const running = within(row).getByRole("status", { name: "运行中" });
  expect(pin).toHaveClass("list-pin-indicator");
  expect(row.lastElementChild).toBe(pin);
  expect(pin.previousElementSibling).toBe(running);
});


it("shares a pending summary request across sidebars and reuses the fresh result on remount", async () => {
  const pending = deferred<typeof saved>();
  api.summaries.mockReturnValueOnce(pending.promise);
  const view = render(<>{component()}{component()}</>);
  await waitFor(() => expect(api.summaries).toHaveBeenCalledTimes(1));
  await act(async () => pending.resolve(saved));
  expect(await screen.findAllByRole("button", { name: "Alpha 方案" })).toHaveLength(2);
  view.rerender(<div />);
  view.rerender(component());
  expect(screen.getByRole("button", { name: "Alpha 方案" })).toBeVisible();
  expect(api.summaries).toHaveBeenCalledTimes(1);
});


it("shows the persisted running summary before live status arrives", async () => {
  api.summaries.mockResolvedValue([{ ...saved[0], running: true, pinned: true }]);
  render(component());
  const row = await screen.findByTitle("Alpha 方案");
  expect(within(row).getByRole("status", { name: "运行中" })).toBeVisible();
  fireEvent.contextMenu(row);
  expect(screen.getByRole("menuitem", { name: "归档" })).toBeDisabled();
  expect(screen.getByRole("menuitem", { name: "删除" })).toBeDisabled();
});


it("refreshes creation begun before Workspace binding finished even if the initial list arrived first", async () => {
  const binding = deferred<{ workspaceId: string; generation: string }>();
  const opening = deferred<void>();
  api.binding.mockReturnValueOnce(binding.promise);
  api.open.mockReturnValueOnce(opening.promise);
  api.summaries.mockResolvedValueOnce(saved).mockResolvedValueOnce([{ ...saved[0], id: "new-id", title: "新会话" }]);
  render(component());
  fireEvent.click(screen.getByRole("button", { name: "新增会话" }));
  await waitFor(() => expect(api.open).toHaveBeenCalledTimes(1));
  await act(async () => binding.resolve({ workspaceId: "/workspace", generation: "open-1" }));
  await screen.findByRole("button", { name: "Alpha 方案" });
  await act(async () => opening.resolve());
  await screen.findByRole("button", { name: "新会话" });
});
