import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ProjectSidebarSessions, type ProjectSidebarSessionsProps } from "./ProjectSidebarSessions";
import { useAgentPanelStore } from "../../state/agent-panel-store";

const api = vi.hoisted(() => ({ start: vi.fn(), sessions: vi.fn(), selectSession: vi.fn(), open: vi.fn() }));
vi.mock("../../services/dshAssistantApi", () => ({ dshAssistantApi: api }));
vi.mock("../../services/projectContentApi", () => ({ openProjectContent: api.open }));

const saved = [
  { id: "alpha", title: "Alpha 方案", running: false },
  { id: "beta", title: "Beta 复盘", running: true },
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
beforeEach(() => {
  vi.resetAllMocks();
  api.start.mockResolvedValue(undefined);
  api.sessions.mockResolvedValue(saved);
  api.selectSession.mockImplementation(async (id: string | null) => id ?? "new-id");
  api.open.mockResolvedValue(undefined);
  useAgentPanelStore.getState().clearWorkspace();
  useAgentPanelStore.getState().bindWorkspace(defaults.workspaceRoot);
});

it("loads real API sessions without selecting/creating, and filters titles locally", async () => {
  const view = render(component());
  expect(screen.getByRole("status")).toHaveTextContent("正在读取项目会话");
  await screen.findByRole("button", { name: "Alpha 方案" });
  expect(api.start).toHaveBeenCalledWith(JSON.stringify(["/workspace", 7]), 7);
  expect(api.sessions).toHaveBeenCalledWith(7);
  expect(api.selectSession).not.toHaveBeenCalled();
  const list = screen.getByRole("region", { name: "项目会话列表" });
  expect(list.parentElement).toHaveClass("home-side__list-frame");
  expect(within(list).getAllByRole("button")).toHaveLength(2);
  view.rerender(component({ query: " aLPHa " }));
  expect(screen.getByRole("button", { name: "Alpha 方案" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Beta/ })).toBeNull();
  view.rerender(component({ query: "missing" }));
  expect(screen.getByText("没有匹配的会话")).toBeInTheDocument();
  expect(api.sessions).toHaveBeenCalledTimes(1);
  expect(api.start).toHaveBeenCalledTimes(1);
});

it("keeps refresh before creation at the right edge of the heading", async () => {
  render(component());
  const refresh = screen.getByRole("button", { name: "刷新会话" });
  const create = screen.getByRole("button", { name: "新增会话" });
  expect(refresh).toBeVisible();
  expect(create).toBeVisible();
  expect(refresh).toBeDisabled();
  expect(create).toBeDisabled();
  expect(refresh.closest(".home-side__heading")).toBe(create.closest(".home-side__heading"));
  expect(refresh.nextElementSibling).toBe(create);
  expect(create.nextElementSibling).toBeNull();
  expect(create.querySelector("svg")).toHaveAttribute("width", "16");
  expect(refresh.querySelector("svg")).toHaveAttribute("width", "16");
  await screen.findByRole("button", { name: "Alpha 方案" });
  expect(refresh).toBeEnabled();
  expect(create).toBeEnabled();
  fireEvent.click(refresh);
  await waitFor(() => expect(api.sessions).toHaveBeenCalledTimes(2));
  expect(api.selectSession).not.toHaveBeenCalled();
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
  api.sessions.mockResolvedValueOnce([]).mockResolvedValue([{ id: "new-id", title: "新会话", running: false }]);
  render(component());
  await screen.findByText("暂无会话");
  expect(api.selectSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "新增会话" }));
  await screen.findByRole("button", { name: "新会话" });
  expect(api.selectSession).toHaveBeenCalledExactlyOnceWith(null, 7);
  expect(api.open.mock.calls[0][0].object).toEqual({ kind: "session", id: "new-id", title: "新会话" });
  expect(api.sessions).toHaveBeenCalledTimes(2);
});

it.each(["start", "sessions"] as const)("shows %s errors and retries only on request", async method => {
  api[method].mockRejectedValueOnce(new Error("服务不可用"));
  render(component());
  expect(await screen.findByRole("alert")).toHaveTextContent("服务不可用");
  expect(api[method]).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByRole("button", { name: "Alpha 方案" });
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "刷新会话" }));
  await waitFor(() => expect(api.sessions).toHaveBeenCalledTimes(method === "start" ? 2 : 3));
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

it("does no work while collapsed and stops the pending start before reading sessions", async () => {
  const pending = deferred<void>();
  api.start.mockReturnValueOnce(pending.promise);
  const view = render(component({ enabled: false }));
  expect(api.start).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "新增会话" })).toBeDisabled();
  view.rerender(component());
  expect(api.start).toHaveBeenCalledTimes(1);
  view.rerender(component({ enabled: false }));
  await act(async () => pending.resolve());
  expect(api.sessions).not.toHaveBeenCalled();
  view.rerender(component());
  await screen.findByRole("button", { name: "Alpha 方案" });
  expect(api.selectSession).not.toHaveBeenCalled();
});

it.each([{ projectId: 8 }, { workspaceRoot: "/other" }])("isolates delayed list results across scope switch %j", async scope => {
  const pending = deferred<typeof saved>();
  api.sessions.mockReturnValueOnce(pending.promise).mockResolvedValue([{ id: "other", title: "新范围", running: false }]);
  const view = render(component());
  await waitFor(() => expect(api.sessions).toHaveBeenCalledTimes(1));
  view.rerender(component(scope));
  await screen.findByRole("button", { name: "新范围" });
  await act(async () => pending.resolve(saved));
  expect(screen.queryByRole("button", { name: "Alpha 方案" })).toBeNull();
  expect(screen.getByRole("button", { name: "新范围" })).toBeInTheDocument();
});

it("isolates stale failures even after returning to the same project", async () => {
  const pending = deferred<void>();
  api.start.mockReturnValueOnce(pending.promise);
  const view = render(component());
  view.rerender(component({ projectId: 8 }));
  await screen.findByRole("button", { name: "Alpha 方案" });
  view.rerender(component());
  await screen.findByRole("button", { name: "Alpha 方案" });
  await act(async () => pending.reject(new Error("旧范围失败")));
  expect(screen.queryByRole("alert")).toBeNull();
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
  expect(within(alpha).getByLabelText("运行中")).toBeInTheDocument();
  expect(within(screen.getByRole("button", { name: /Beta/ })).queryByLabelText("运行中")).toBeNull();
  act(() => useAgentPanelStore.getState().setSessionRuns("/workspace", 7, { alpha: false, beta: true }));
  expect(within(alpha).queryByLabelText("运行中")).toBeNull();
  expect(within(screen.getByRole("button", { name: /Beta/ })).getByLabelText("运行中")).toBeInTheDocument();
  act(() => useAgentPanelStore.getState().setSessionRuns("/workspace", 7, {}));
  expect(screen.queryByLabelText("运行中")).toBeNull();
  expect(api.start).not.toHaveBeenCalled();
  expect(api.sessions).toHaveBeenCalledTimes(1);
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
  expect(list.contains(screen.getByRole("button", { name: "刷新会话" }))).toBe(false);
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
