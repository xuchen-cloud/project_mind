import { StrictMode, useEffect } from "react";
import type { DshConversationHostProps } from "@project-mind/dsh-ui/adapters";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentWorkspacePanel } from "./AgentWorkspacePanel";
import { DshAssistantPanel } from "./DshAssistantPanel";
import { useAgentPanelStore } from "../../state/agent-panel-store";
import { useUiStore } from "../../state/ui-store";
import { useFeedbackStore } from "../../state/feedback-store";
import { requestDshFileReference, setDshWorkspaceRoot } from "../../lib/dsh-host-events";
import { queryKeys } from "../../lib/queryKeys";

const mocks = vi.hoisted(() => ({ command: vi.fn(), insert: vi.fn(), file: vi.fn(), changed: vi.fn(), hosts: [] as DshConversationHostProps[], mounts: 0, unmounts: 0, autoReady: true, openContent: vi.fn() }));
vi.mock("../../services/projectContentApi", () => ({ openProjectContent: mocks.openContent }));
vi.mock("../../services/desktopApi", () => ({ desktopApi: { command: mocks.command } }));
vi.mock("../../lib/project-file-navigation", () => ({ openProjectFilePreview: mocks.file, notifyProjectFilesChanged: mocks.changed }));
vi.mock("@project-mind/dsh-ui/adapters", () => ({
  insertDshFileReference: mocks.insert,
  DshConversationHost: (props: DshConversationHostProps) => {
    mocks.hosts.push(props);
    useEffect(() => { mocks.mounts++; if (mocks.autoReady) props.onReady?.();  return () => { mocks.unmounts++; }; }, []);
    return <div data-testid="host" data-project={props.projectId} data-session={props.sessionId}><input aria-label="DSH draft" /></div>;
  },
}));
const props = { open: true, expanded: true, workspaceRoot: "/workspace", projectId: 1, onClose: vi.fn(), onToggleExpanded: vi.fn() };
const starts = () => mocks.command.mock.calls.filter(([command]) => command === "dsh_assistant_start");
function setup(initial: typeof props & { onOpenSession?: (id: string, title: string) => void } = props, strict = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const shell = (value: typeof initial) => <QueryClientProvider client={client}>{strict ? <StrictMode><DshAssistantPanel {...value} /></StrictMode> : <DshAssistantPanel {...value} />}</QueryClientProvider>;
  const view = render(shell(initial));
  return { ...view, client, update: (value: Partial<typeof props>) => view.rerender(shell({ ...initial, ...value })) };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  mocks.command.mockReset().mockImplementation(async (command, args) => command === "dsh_assistant_sessions" ? [{ id: "saved", title: "历史会话" }] : command === "dsh_assistant_select_session" ? args.sessionId ?? "actual-created" : undefined);
  mocks.insert.mockReset().mockResolvedValue(undefined); mocks.file.mockReset(); mocks.changed.mockReset();
  mocks.openContent.mockReset().mockResolvedValue(undefined);
  mocks.hosts = []; mocks.mounts = 0; mocks.unmounts = 0; mocks.autoReady = true;
  useAgentPanelStore.getState().clearWorkspace();
  useAgentPanelStore.getState().openPanel("/workspace", { kind: "project", projectId: 1 });
  useUiStore.setState({ settingsOpen: false });
  setDshWorkspaceRoot(null); setDshWorkspaceRoot("/workspace"); useFeedbackStore.setState({ toasts: [] });
});
describe("React DSH project shell", () => {
  it("accepts delayed onReady after StrictMode, session notification and ordinary shell rerenders", async () => {
    mocks.autoReady = false;
    const view = setup(props, true); await screen.findByTestId("host");
    const initialHost = mocks.hosts.at(-1)!;
    expect(screen.getByRole("button", { name: "项目会话" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新建会话" })).toBeDisabled();
    act(() => initialHost.onSessionChange?.("saved")); view.update({ expanded: false });
    act(() => useUiStore.getState().openSettings("ai-models")); act(() => useUiStore.getState().closeSettings());
    act(() => initialHost.onReady?.());
    expect(screen.getByRole("button", { name: "项目会话" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "新建会话" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("rejects an old same-project onReady after config refresh and enables only the current Host", async () => {
    mocks.autoReady = false;
    const view = setup(); await screen.findByTestId("host"); const oldHost = mocks.hosts.at(-1)!;
    act(() => view.client.setQueryData(queryKeys.aiSettings, { bindings: [], profiles: [], aiSecretsUnlocked: true }));
    await waitFor(() => expect(mocks.mounts).toBe(2));
    act(() => oldHost.onReady?.()); expect(screen.getByRole("button", { name: "新建会话" })).toBeDisabled();
    act(() => mocks.hosts.at(-1)!.onReady?.()); expect(screen.getByRole("button", { name: "新建会话" })).toBeEnabled();
  });

  it("starts on first open and preserves the real Host mount and draft on close/reopen", async () => {
    const view = setup({ ...props, open: false }); expect(starts()).toHaveLength(0);
    view.update({ open: true }); await screen.findByTestId("host");
    fireEvent.change(screen.getByLabelText("DSH draft"), { target: { value: "draft" } });
    view.update({ open: false }); view.update({ open: true });
    expect(screen.getByLabelText("DSH draft")).toHaveValue("draft"); expect(mocks.mounts).toBe(1); expect(starts()).toHaveLength(1);
    expect(mocks.command.mock.calls.some(([command]) => command === "dsh_assistant_view")).toBe(false);
    view.unmount(); expect(mocks.unmounts).toBe(1);
  });
  it("shows actual locked-model errors and retries native resolution", async () => {
    mocks.command.mockRejectedValueOnce(new Error("主模型凭据已锁定，请解锁"));
    setup(); expect(await screen.findByRole("alert")).toHaveTextContent("请解锁"); expect(screen.queryByTestId("host")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" })); await screen.findByTestId("host"); expect(starts()).toHaveLength(2);
  });
  it("does not mount after startup resolves following close or unmount", async () => {
    const pending = deferred(); mocks.command.mockImplementationOnce(() => pending.promise);
    const view = setup(); await waitFor(() => expect(starts()).toHaveLength(1)); view.update({ open: false });
    await act(async () => pending.resolve()); expect(screen.queryByTestId("host")).toBeNull(); view.unmount(); expect(mocks.mounts).toBe(0);
  });
  it("ignores startup and Host callbacks from an old project", async () => {
    const view = setup(); await screen.findByTestId("host"); const old = mocks.hosts.at(-1)!;
    view.update({ projectId: 2 }); await waitFor(() => expect(screen.getByTestId("host")).toHaveAttribute("data-project", "2"));
    act(() => { old.onError?.("old error"); old.onBusyChange?.(true); old.onFileOpen?.("old.txt"); old.onFilesChanged?.(); });
    expect(screen.queryByText("old error")).toBeNull(); expect(mocks.file).not.toHaveBeenCalled(); expect(mocks.changed).not.toHaveBeenCalled(); expect(useAgentPanelStore.getState().runningBinding).toBeNull();
    view.unmount(); const newest = mocks.hosts.at(-1)!; act(() => newest.onError?.("unmounted"));
  });
  it("restores once then refreshes only while the menu is open, returns real new IDs and deletes with confirmation", async () => {
    setup(); await screen.findByTestId("host"); expect(mocks.command.mock.calls.filter(([command]) => command === "dsh_assistant_sessions")).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "新建会话" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await waitFor(() => expect(screen.getByTestId("host")).toHaveAttribute("data-session", "actual-created"));
    expect(mocks.command).toHaveBeenCalledWith("dsh_assistant_select_session", { projectId: 1, sessionId: null });
    fireEvent.click(screen.getByRole("button", { name: "项目会话" })); await screen.findByRole("button", { name: "历史会话" });
    fireEvent.click(screen.getByRole("button", { name: "删除会话 历史会话" })); expect(screen.getByText(/历史文件保留/u)).toBeVisible(); expect(mocks.command).not.toHaveBeenCalledWith("dsh_assistant_delete_session", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(mocks.command).toHaveBeenCalledWith("dsh_assistant_delete_session", { projectId: 1, sessionId: "saved" }));
    fireEvent.click(screen.getByRole("button", { name: "项目会话" })); fireEvent.click(screen.getByRole("button", { name: "项目会话" }));
    await waitFor(() => expect(mocks.command.mock.calls.filter(([command]) => command === "dsh_assistant_sessions")).toHaveLength(3));
  });
  it("keeps the executing Host, defers its config refresh and allows a different Project panel", async () => {
    const view = setup(); await screen.findByTestId("host");
    act(() => mocks.hosts.at(-1)!.onBusyChange?.(true));
    expect(screen.getByRole("button", { name: "新建会话" })).toBeDisabled();
    act(() => { view.client.setQueryData(queryKeys.aiSettings, { bindings: [], profiles: [], aiSecretsUnlocked: true }); useAgentPanelStore.getState().openPanel("/workspace", { kind: "project", projectId: 2 }); });
    expect(useAgentPanelStore.getState().binding?.scope).toEqual({ kind: "project", projectId: 2 }); expect(starts()).toHaveLength(1); expect(mocks.unmounts).toBe(0);
    view.update({ open: false }); expect(useAgentPanelStore.getState().runningBinding).not.toBeNull();
    view.update({ open: true }); act(() => mocks.hosts.at(-1)!.onBusyChange?.(false));
    await waitFor(() => expect(starts()).toHaveLength(2)); await screen.findByTestId("host");
  });
  it("queues unopened assistant references until Host and actual session are ready, reports insertion failure", async () => {
    const view = setup({ ...props, open: false });
    act(() => requestDshFileReference(1, "src/main.ts")); expect(useAgentPanelStore.getState().open).toBe(true); expect(mocks.insert).not.toHaveBeenCalled();
    view.update({ open: true }); await waitFor(() => expect(mocks.insert).toHaveBeenCalledWith(1, "saved", "src/main.ts", undefined));
    mocks.insert.mockRejectedValueOnce(new Error("引用失败")); act(() => requestDshFileReference(1, "other.ts"));
    await waitFor(() => expect(useFeedbackStore.getState().toasts[0]?.detail).toBe("引用失败"));
    expect(mocks.insert).toHaveBeenCalledTimes(2);
  });
  it("restores history without creating a session and replaces a deleted current session with a real ID", async () => {
    setup(); await screen.findByTestId("host");
    expect(screen.getByTestId("host")).toHaveAttribute("data-session", "saved");
    await waitFor(() => expect(screen.getByRole("button", { name: "项目会话" })).toBeEnabled());
    expect(mocks.command).toHaveBeenCalledWith("dsh_assistant_select_session", { projectId: 1, sessionId: "saved" });
    fireEvent.click(screen.getByRole("button", { name: "项目会话" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除会话 历史会话" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(screen.getByTestId("host")).toHaveAttribute("data-session", "actual-created"));
  });
  it("does not restore or show the stale project when its start resolves after switching", async () => {
    const pending = deferred(); mocks.command.mockImplementationOnce(() => pending.promise);
    const view = setup(); await waitFor(() => expect(starts()).toHaveLength(1)); view.update({ projectId: 2 });
    await act(async () => pending.resolve());
    await waitFor(() => expect(screen.getByTestId("host")).toHaveAttribute("data-project", "2"));
    expect(mocks.command).not.toHaveBeenCalledWith("dsh_assistant_sessions", { projectId: 1 });
    expect(mocks.hosts.every(value => value.projectId === 2)).toBe(true);
  });
  it("restores an already executing project's busy state before navigation can replace it", async () => {
    mocks.command.mockImplementation(async (command, args) => command === "dsh_assistant_sessions" ? [{ id: "running", title: "正在执行", running: true }] : command === "dsh_assistant_select_session" ? args.sessionId : undefined);
    setup(); await screen.findByTestId("host"); expect(useAgentPanelStore.getState().runningBinding?.scope).toEqual({ kind: "project", projectId: 1 });
    expect(screen.getByRole("button", { name: "新建会话" })).toBeDisabled();
    act(() => mocks.hosts.at(-1)!.onBusyChange?.(false)); expect(useAgentPanelStore.getState().runningBinding).toBeNull();
  });
  it("deduplicates identical shared settings cache updates", async () => {
    const view = setup(); await screen.findByTestId("host");
    const snapshot = { bindings: [], profiles: [], aiSecretsUnlocked: true };
    act(() => view.client.setQueryData(queryKeys.aiSettings, snapshot));
    await waitFor(() => expect(starts()).toHaveLength(2)); await screen.findByTestId("host");
    act(() => view.client.setQueryData(queryKeys.aiSettings, { ...snapshot }));
    expect(starts()).toHaveLength(2);
  });
  it("rechecks native shared config after settings closes without resetting an unchanged draft", async () => {
    setup(); await screen.findByTestId("host"); fireEvent.change(screen.getByLabelText("DSH draft"), { target: { value: "keep" } });
    act(() => useUiStore.getState().openSettings("ai-models")); act(() => useUiStore.getState().closeSettings());
    await waitFor(() => expect(starts()).toHaveLength(2)); expect(mocks.mounts).toBe(1); expect(screen.getByLabelText("DSH draft")).toHaveValue("keep");
  });
  it("forwards only current-project file callbacks to the main app", async () => {
    setup(); await screen.findByTestId("host");
    act(() => { mocks.hosts.at(-1)!.onFileOpen?.("src/main.ts", 12); mocks.hosts.at(-1)!.onFilesChanged?.(); });
    expect(mocks.file).toHaveBeenCalledWith(1, "src/main.ts", 12, "saved", undefined); expect(mocks.changed).toHaveBeenCalledWith(1);
  });
});

it('uses the callback mode as a list/create launcher without duplicating a conversation editor', async () => {
  const onOpenSession = vi.fn();
  setup({ ...props, onOpenSession });
  await waitFor(() => expect(screen.getByRole('button', { name: '项目会话' })).toBeEnabled());
  expect(mocks.mounts).toBe(0);
  expect(onOpenSession).not.toHaveBeenCalled();
  expect(mocks.command).not.toHaveBeenCalledWith('dsh_assistant_select_session', expect.anything());
  fireEvent.click(screen.getByRole('button', { name: '项目会话' }));
  fireEvent.click(await screen.findByRole('button', { name: '历史会话' }));
  await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('saved', '历史会话'));
  fireEvent.click(screen.getByRole('button', { name: '新建会话' }));
  await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('actual-created', '新会话'));
  expect(mocks.mounts).toBe(0);
});

function setupWorkspace(projectId = 1) {
  useAgentPanelStore.getState().openPanel("/workspace", { kind: "project", projectId });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const shell = (id: number) => <QueryClientProvider client={client}>
    <main aria-label="项目内容">项目内容 {id}</main>
    <AgentWorkspacePanel workspaceRoot="/workspace" currentProjectId={id} />
  </QueryClientProvider>;
  const view = render(shell(projectId));
  return { ...view, switchProject: (id: number) => view.rerender(shell(id)) };
}

describe("real workspace session launcher", () => {
  it("shows saved sessions in the body immediately and returns to project content after opening and closing", async () => {
    setupWorkspace();
    const list = await screen.findByRole("region", { name: "项目会话" });
    fireEvent.click(within(list).getByRole("button", { name: "历史会话" }));
    await waitFor(() => expect(mocks.openContent).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot: "/workspace", projectId: 1, object: { kind: "session", id: "saved", title: "历史会话" },
    })));
    await waitFor(() => expect(screen.queryByRole("region", { name: "DSH 助手面板" })).toBeNull());
    expect(screen.getByRole("main", { name: "项目内容" })).toBeVisible();
    act(() => useAgentPanelStore.getState().openPanel("/workspace", { kind: "project", projectId: 1 }));
    expect(screen.getByRole("region", { name: "项目会话" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "关闭助手" }));
    expect(screen.queryByRole("region", { name: "DSH 助手面板" })).toBeNull();
    expect(screen.getByRole("main", { name: "项目内容" })).toBeVisible();
    expect(mocks.mounts).toBe(0);
  });

  it("shows an explicit zero-session state and creates only on user request", async () => {
    mocks.command.mockImplementation(async (command, args) => command === "dsh_assistant_sessions" ? [] : command === "dsh_assistant_select_session" ? args.sessionId ?? "actual-created" : undefined);
    setupWorkspace();
    expect(await screen.findByText("暂无会话，点击新建会话开始。", { exact: true })).toBeVisible();
    expect(mocks.command).not.toHaveBeenCalledWith("dsh_assistant_select_session", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await waitFor(() => expect(mocks.openContent).toHaveBeenCalledWith(expect.objectContaining({ object: { kind: "session", id: "actual-created", title: "新会话" } })));
    expect(mocks.mounts).toBe(0);
  });

  it("switches project session lists without showing another project's sessions", async () => {
    mocks.command.mockImplementation(async (command, args) => command === "dsh_assistant_sessions" ? [{ id: `session-${args.projectId}`, title: `项目 ${args.projectId} 会话` }] : command === "dsh_assistant_select_session" ? args.sessionId : undefined);
    const view = setupWorkspace();
    await screen.findByRole("button", { name: "项目 1 会话" });
    view.switchProject(2);
    await screen.findByRole("button", { name: "项目 2 会话" });
    expect(screen.queryByRole("button", { name: "项目 1 会话" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "项目 2 会话" }));
    await waitFor(() => expect(mocks.openContent).toHaveBeenCalledWith(expect.objectContaining({ projectId: 2, object: { kind: "session", id: "session-2", title: "项目 2 会话" } })));
  });

  it("shows startup failure explicitly and keeps close and retry actionable", async () => {
    mocks.command.mockRejectedValueOnce(new Error("主模型凭据已锁定，请解锁"));
    setupWorkspace();
    expect(await screen.findByRole("alert")).toHaveTextContent("主模型凭据已锁定，请解锁");
    expect(screen.getByRole("button", { name: "关闭助手" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("region", { name: "项目会话" })).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
