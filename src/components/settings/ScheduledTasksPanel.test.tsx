import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { queryKeys } from "../../lib/queryKeys";
import { useProjectContentStore } from "../../state/project-content-store";
import { act, fireEvent, render as baseRender, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ScheduledTasksPanel } from "./ScheduledTasksPanel";
import { useAgentPanelStore } from "../../state/agent-panel-store";
const api = vi.hoisted(() => ({ start: vi.fn(), sessions: vi.fn(), selectSession: vi.fn(), list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), run: vi.fn(), openContent: vi.fn() }));
vi.mock("../../services/dshAssistantApi", () => ({ dshAssistantApi: api }));
vi.mock("../../services/dshScheduleApi", () => ({ dshScheduleApi: api }));
vi.mock("../../services/projectContentApi", () => ({ openProjectContent: api.openContent }));
const workspaceId = "scheduled-workspace";
function render(element: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.projectContentBinding("/workspace"), { workspaceId, generation: "open-1" });
  return baseRender(element, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
}
async function beginTask() {
  const button = await screen.findByRole("button", { name: "新建定时任务" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}
const savedTask = { id: "task", title: "已保存的任务", prompt: "总结进展", sessionId: "real-session", enabled: true, rule: { kind: "days" as const, startDate: "2026-10-25", time: "09:00", interval: 1 }, timeZone: "Asia/Shanghai", nextRunAt: null, lastRunAt: null, lastError: null };
beforeEach(() => {
  vi.resetAllMocks();
  useProjectContentStore.setState({ layouts: {} });
  useAgentPanelStore.getState().clearWorkspace();
  useAgentPanelStore.getState().bindWorkspace("/workspace");
  api.start.mockResolvedValue(undefined);
  api.selectSession.mockImplementation(async id => id);
  api.sessions.mockResolvedValue([{ id: "real-session", title: "每日工作" }]);
  api.list.mockResolvedValue([]);
  api.create.mockImplementation(async task => ({ ...task, id: "task", timeZone: "Asia/Shanghai", nextRunAt: "2026-10-25T01:00:00Z", lastRunAt: null, lastError: null }));
});

it("shows saved tasks without waiting for slow conversation enumeration", async () => {
  api.sessions.mockReturnValue(new Promise(() => {}));
  api.list.mockResolvedValue([savedTask]);
  render(<ScheduledTasksPanel open />);
  expect(await screen.findByText("已保存的任务")).toBeVisible();
  expect(api.list).toHaveBeenCalledOnce();
  expect(api.start).not.toHaveBeenCalled();
  expect(screen.queryByText("正在读取定时任务…")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  expect(screen.getByLabelText("绑定会话")).toHaveValue(savedTask.sessionId);
  expect(screen.getByLabelText("绑定会话")).toBeDisabled();
});

it("reads tasks directly even when an explicit assistant start would be slow", async () => {
  api.start.mockReturnValue(new Promise(() => {}));
  api.list.mockResolvedValue([savedTask]);
  render(<ScheduledTasksPanel open />);
  expect(await screen.findByText(savedTask.title)).toBeVisible();
  expect(api.start).not.toHaveBeenCalled();
});

it("keeps tasks usable when conversation enumeration fails", async () => {
  api.list.mockResolvedValue([savedTask]);
  api.sessions.mockRejectedValue(new Error("会话读取失败"));
  render(<ScheduledTasksPanel open />);
  expect(await screen.findByText("会话读取失败")).toBeVisible();
  expect(screen.getByText(savedTask.title)).toBeVisible();
  expect(screen.getByRole("button", { name: "立即执行" })).toBeEnabled();
  api.sessions.mockResolvedValue([{ id: "real-session", title: "恢复的会话" }]);
  fireEvent.click(screen.getByRole("button", { name: "重新读取会话" }));
  expect(await screen.findByText("会话：恢复的会话")).toBeVisible();
  expect(api.list).toHaveBeenCalledOnce();
});

it("shows cached tasks immediately on reopen and refreshes them in the background", async () => {
  api.list.mockResolvedValueOnce([savedTask]);
  const view = render(<ScheduledTasksPanel open />);
  await screen.findByText(savedTask.title);
  let resolve!: (value: typeof savedTask[]) => void;
  api.list.mockImplementation(() => new Promise(done => { resolve = done; }));
  view.rerender(<ScheduledTasksPanel open={false} />);
  view.rerender(<ScheduledTasksPanel open />);
  expect(screen.getByText(savedTask.title)).toBeVisible();
  expect(screen.queryByText("正在读取定时任务…")).not.toBeInTheDocument();
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  await act(async () => resolve([{ ...savedTask, title: "后台更新的任务" }]));
  expect(await screen.findByText("后台更新的任务")).toBeVisible();
});

it("does not show or restore another Workspace's cached tasks after a switch", async () => {
  api.list.mockResolvedValueOnce([savedTask]);
  render(<ScheduledTasksPanel open />);
  await screen.findByText(savedTask.title);
  let resolve!: (value: typeof savedTask[]) => void;
  api.list.mockImplementation(() => new Promise(done => { resolve = done; }));
  act(() => useAgentPanelStore.getState().bindWorkspace("/other-workspace"));
  expect(screen.queryByText(savedTask.title)).not.toBeInTheDocument();
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  await act(async () => resolve([{ ...savedTask, title: "另一个工作区的任务" }]));
  expect(await screen.findByText("另一个工作区的任务")).toBeVisible();
  expect(screen.queryByText(savedTask.title)).not.toBeInTheDocument();
});

it("does not overwrite a pause with a stale background refresh", async () => {
  api.list.mockResolvedValueOnce([savedTask]);
  api.update.mockResolvedValue({ ...savedTask, enabled: false });
  render(<ScheduledTasksPanel open />);
  const refresh = await screen.findByRole("button", { name: "刷新" });
  await waitFor(() => expect(refresh).toBeEnabled());
  let resolve!: (value: typeof savedTask[]) => void;
  api.list.mockImplementation(() => new Promise(done => { resolve = done; }));
  fireEvent.click(refresh);
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "暂停" }));
  await screen.findByText("已暂停");
  await act(async () => resolve([savedTask]));
  expect(screen.getByText("已暂停")).toBeVisible();
});

it("creates a scheduled prompt bound to an existing Workspace conversation with a calendar rule", async () => {
  render(<ScheduledTasksPanel open />);
  await beginTask();
  fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "晨间整理" } });
  fireEvent.change(screen.getByLabelText("任务内容"), { target: { value: "整理工作区所有项目的进展" } });
  fireEvent.change(screen.getByLabelText("首次日期"), { target: { value: "2026-10-25" } });
  fireEvent.change(screen.getByLabelText("执行时间"), { target: { value: "09:00" } });
  fireEvent.change(screen.getByLabelText("重复方式"), { target: { value: "weekdays" } });
  fireEvent.click(screen.getByRole("button", { name: "保存任务" }));
  await waitFor(() => expect(api.create).toHaveBeenCalledWith({ title: "晨间整理", prompt: "整理工作区所有项目的进展", sessionId: "real-session", enabled: true, rule: { kind: "weekdays", startDate: "2026-10-25", time: "09:00" } }, expect.any(String)));
  expect(api.start).not.toHaveBeenCalled();
  expect(api.sessions).toHaveBeenCalledWith(null);
  expect(api.selectSession).not.toHaveBeenCalled();
  expect(await screen.findByText("晨间整理")).toBeInTheDocument();
});

it("retains the same mutation identity when retrying a failed create", async () => {
  api.create.mockRejectedValueOnce(new Error("连接中断"));
  render(<ScheduledTasksPanel open />);
  await beginTask();
  fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "每日摘要" } });
  fireEvent.change(screen.getByLabelText("任务内容"), { target: { value: "生成摘要" } });
  fireEvent.click(screen.getByRole("button", { name: "保存任务" }));
  await screen.findAllByText("连接中断");
  fireEvent.click(screen.getByRole("button", { name: "保存任务" }));
  await waitFor(() => expect(api.create).toHaveBeenCalledTimes(2));
  expect(api.create.mock.calls[0][1]).toEqual(api.create.mock.calls[1][1]);
  expect(await screen.findByText("每日摘要")).toBeInTheDocument();
});

it("edits and pauses an existing task without changing its original conversation", async () => {
  const task = { id: "task", title: "周总结", prompt: "总结进展", sessionId: "real-session", enabled: true, rule: { kind: "weeks", startDate: "2026-10-25", time: "09:00", interval: 2, weekdays: [1, 5] }, timeZone: "Asia/Shanghai", nextRunAt: null, lastRunAt: null, lastError: "上次运行失败" };
  api.list.mockResolvedValue([task]);
  api.update.mockImplementation(async (id, input) => ({ ...task, ...input }));
  render(<ScheduledTasksPanel open />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
  expect(screen.getByLabelText("绑定会话")).toBeDisabled();
  expect(screen.getByLabelText("周一")).toBeChecked();
  fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "双周总结" } });
  fireEvent.click(screen.getByRole("button", { name: "保存任务" }));
  await screen.findByText("双周总结");
  expect(api.update.mock.calls[0][1].sessionId).toBe("real-session");
  fireEvent.click(screen.getByRole("button", { name: "暂停" }));
  await screen.findByText("已暂停");
  expect(api.update.mock.calls[1][1].enabled).toBe(false);
});

it("runs a paused task once, blocks duplicate clicks and retains its request identity after an uncertain response", async () => {
  const task = { id: "task", title: "验证任务", prompt: "总结进展", sessionId: "real-session", enabled: false, rule: { kind: "days", startDate: "2026-10-25", time: "09:00", interval: 1 }, timeZone: "Asia/Shanghai", nextRunAt: null, lastRunAt: null, lastError: null };
  api.list.mockResolvedValue([task]);
  let reject!: (error: Error) => void;
  api.run.mockImplementationOnce(() => new Promise((_, failure) => { reject = failure; }));
  api.run.mockResolvedValue({ ...task, lastRunAt: "2026-10-24T06:00:00Z" });
  const onRunStarted = vi.fn();
  render(<ScheduledTasksPanel open onRunStarted={onRunStarted} />);
  fireEvent.click(await screen.findByRole("button", { name: "立即执行" }));
  await waitFor(() => expect(api.run).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("button", { name: "正在触发…" })).toBeDisabled();
  reject(new Error("连接中断"));
  await screen.findByText("连接中断");
  fireEvent.click(screen.getByRole("button", { name: "重试执行" }));
  await screen.findByText(/已发送到原会话/);
  expect(api.run.mock.calls[1]).toEqual(api.run.mock.calls[0]);
  expect(screen.getByText("已暂停")).toBeInTheDocument();
  expect(api.update).not.toHaveBeenCalled();
  expect(api.openContent).toHaveBeenCalledWith({ workspaceRoot: "/workspace", projectId: null, object: { kind: "session", id: "real-session", title: "每日工作" } });
  expect(onRunStarted).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "立即执行" }));
  await waitFor(() => expect(api.run).toHaveBeenCalledTimes(3));
  expect(api.run.mock.calls[2][1]).not.toEqual(api.run.mock.calls[0][1]);
});

it("defaults a new task to the focused shared Workspace Session instead of the old floating selection", async () => {
  api.sessions.mockResolvedValue([{ id: "first", title: "列表首个会话" }, { id: "second", title: "当前工作区会话" }]);
  useProjectContentStore.getState().open({ workspaceId, projectId: null }, { kind: "session", id: "second", title: "当前工作区会话" });
  useProjectContentStore.getState().open({ workspaceId, projectId: 7 }, { kind: "session", id: "first", title: "项目会话同ID" });
  useAgentPanelStore.setState({ workspaceSession: { workspaceRoot: "/workspace", id: "first", title: "旧浮层选择" } });
  render(<ScheduledTasksPanel open />);
  await beginTask();
  expect(screen.getByRole("combobox", { name: "绑定会话" })).toHaveValue("second");
});

it("ignores a Project Session with the same id and uses the first real Workspace Session when Workspace has no Session selected", async () => {
  api.sessions.mockResolvedValue([{ id: "first", title: "列表首个会话" }, { id: "second", title: "另一个工作区会话" }]);
  useProjectContentStore.getState().open({ workspaceId, projectId: null }, { kind: "record", id: 7, title: "工作区记录" });
  useProjectContentStore.getState().open({ workspaceId, projectId: 7 }, { kind: "session", id: "second", title: "项目会话同ID" });
  useAgentPanelStore.setState({ workspaceSession: { workspaceRoot: "/workspace", id: "second", title: "旧浮层选择" } });
  render(<ScheduledTasksPanel open />);
  await beginTask();
  expect(screen.getByRole("combobox", { name: "绑定会话" })).toHaveValue("first");
});
