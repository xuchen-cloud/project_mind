import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversationMessage, AgentScopeSettings, AgentSessionMetadata, AgentStoredRun } from "../../lib/agent-types";
import type { AiSettingsSnapshot } from "../../lib/types";
const mocked = vi.hoisted(() => ({ useConversation: vi.fn(), aiSettingsGet: vi.fn(), openSettings: vi.fn(), knowledge: vi.fn() }));
vi.mock("./useAgentConversation", () => ({ useAgentConversation: mocked.useConversation }));
vi.mock("./AgentKnowledgePanel", () => ({ AgentKnowledgePanel: (props: unknown) => { mocked.knowledge(props); return <div>知识目录</div>; } }));
vi.mock("./AgentSourceCard", () => ({ AgentSourceCard: () => <div>来源卡片</div> }));
vi.mock("./AgentRunOutputs", () => ({ AgentRunOutputs: ({ runId, active }: { runId: string; active?: boolean }) => <div data-testid={`operations-${runId}`} data-active={active || undefined}>操作 {runId}<button>确认执行</button></div> }));
vi.mock("../../services/projectMindApi", () => ({ projectMindApi: { aiSettingsGet: mocked.aiSettingsGet } }));
vi.mock("../../state/ui-store", () => ({ useUiStore: (selector: (state: { openSettings: typeof mocked.openSettings }) => unknown) => selector({ openSettings: mocked.openSettings }) }));
import { AgentPanel } from "./AgentPanel";
import type { useAgentConversation } from "./useAgentConversation";
const scope = { kind: "project", projectId: 1 } as const;
const binding = { workspaceId: "workspace", generation: "generation" };
const session: AgentSessionMetadata = { id: "a".repeat(32), scope, title: "已有会话", runtimeId: "builtin-pi", profileOverrideId: null, state: "active", createdAt: "now", updatedAt: "now" };
const settings: AgentScopeSettings = { scope, enabled: true, goalRecordId: null, pinnedRefs: [], summaryPolicy: "on_success", overviewIntervalHours: 24, overviewLocalTime: "03:00", overviewTimezone: "UTC", executionMode: "collaborate", revision: 1 };
const run: AgentStoredRun = { id: "b".repeat(32), sessionId: session.id, clientRequestId: "client", state: "running", contextManifest: {}, startedAt: "now", finishedAt: null, usage: null, errorCode: null };
const modelSnapshot = {
  profiles: [{ id: 1, name: "通用配置", defaultModel: "model", enabled: true, supportsText: true, hasStoredKey: true }],
  bindings: [{ capability: "default", profileId: 1, model: "model" }], aiSecretsUnlocked: true,
} as AiSettingsSnapshot;
let state: ReturnType<typeof useAgentConversation>;
const closed = vi.fn();
function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><AgentPanel open onClose={closed} scope={scope} workspaceRoot="/workspace" /></QueryClientProvider>);
}
function message(id: string, runId: string, role: AgentConversationMessage["role"], text: string): AgentConversationMessage {
  return { id, sessionId: session.id, runId, runtimeEntryId: id, ordinal: 0, role, content: text, createdAt: "now" };
}
async function loaded() {
  const view = renderPanel();
  await waitFor(() => expect(screen.getByRole("textbox", { name: "问题" })).toBeEnabled());
  return view;
}
beforeEach(() => {
  vi.clearAllMocks();
  state = {
    binding, settings, sessions: [session], sessionCursor: null, session: null, messages: [], nextOrdinal: null,
    run: null, liveText: "", pendingPrompt: "", toolActivity: "", error: null, loading: false,
    starting: false, reading: false, savingSettings: false, probing: false, verified: false, runtimeAvailable: true, busy: false,
    setEnabled: vi.fn(async () => {}), setMode: vi.fn(async () => {}), selectSession: vi.fn(async () => {}), send: vi.fn(async () => true),
    cancel: vi.fn(async () => {}), refresh: vi.fn(async () => {}), moreSessions: vi.fn(async () => {}),
    probe: vi.fn(async () => {}), loadMore: vi.fn(async () => {}),
  };
  mocked.useConversation.mockImplementation(() => state);
  mocked.aiSettingsGet.mockResolvedValue(modelSnapshot);
});
describe("Project assistant panel", () => {
  it("requires an explicit model probe and reads knowledge only after choosing its tab", async () => {
    await loaded();
    expect(state.probe).not.toHaveBeenCalled(); expect(mocked.knowledge).not.toHaveBeenCalled();
    expect(screen.getByText("验证会请求一次模型")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "验证工具能力" }));
    expect(state.probe).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("tab", { name: "知识" }));
    expect(mocked.knowledge).toHaveBeenCalledWith({ binding, scope });
    expect(screen.getByText("知识目录")).toBeInTheDocument();
  });
  it("persists the selected scope enable setting and opens the existing model settings", async () => {
    await loaded();
    await userEvent.click(screen.getByRole("checkbox", { name: "启用本项目助手" }));
    expect(state.setEnabled).toHaveBeenCalledWith(false);
    fireEvent.change(screen.getByRole("combobox", { name: "执行模式" }), { target: { value: "review" } });
    expect(state.setMode).toHaveBeenCalledWith("review");
    await userEvent.click(screen.getByRole("button", { name: "模型设置" }));
    expect(mocked.openSettings).toHaveBeenCalledWith("ai-models"); expect(closed).toHaveBeenCalledOnce();
  });
  it("sends with Enter and retains the question when startup is rejected", async () => {
    await loaded();
    const field = screen.getByRole("textbox", { name: "问题" });
    vi.mocked(state.send).mockResolvedValueOnce(false);
    await userEvent.type(field, "需要保留的问题");
    await userEvent.keyboard("{Enter}");
    expect(state.send).toHaveBeenCalledWith("需要保留的问题");
    expect(field).toHaveValue("需要保留的问题");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(field).toHaveValue(""));
  });
  it("offers stop for an active run and prevents history switching while running", async () => {
    state.busy = true; state.run = run; state.liveText = "流式回答";
    renderPanel();
    expect(screen.getByText("流式回答")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "历史会话" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "执行模式" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "知识" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(state.cancel).toHaveBeenCalledOnce();
  });
  it("loads historical messages only on request and keeps archived sessions readable", async () => {
    state.session = { ...session, state: "archived" }; state.nextOrdinal = 49;
    renderPanel();
    expect(screen.getByRole("textbox", { name: "问题" })).toBeDisabled();
    expect(screen.getByText("该会话已归档，请新建会话。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "加载后续消息" }));
    expect(state.loadMore).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "新会话" }));
    expect(state.selectSession).toHaveBeenCalledWith("");
  });
  it("bounds UTF-8 question size before sending and reports readable errors", async () => {
    state.error = "当前模型未通过工具验证";
    await loaded();
    expect(screen.getByRole("alert")).toHaveTextContent("当前模型未通过工具验证");
    fireEvent.change(screen.getByRole("textbox", { name: "问题" }), { target: { value: "字".repeat(22000) } });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByText("问题超过长度上限，请缩短后发送。")).toBeInTheDocument();
  });
});

it("places each run's controls once after its last assistant or tool message in conversation order", () => {
  state.run = { ...run, id: "second", state: "completed" };
  state.messages = [
    message("u1", "first", "user", "第一问题"),
    message("a1", "first", "assistant", "第一回复"),
    message("t1", "first", "tool", "第一工具结果"),
    message("u2", "second", "user", "第二问题"),
    message("t2", "second", "tool", "第二工具结果"),
    message("a2", "second", "assistant", "第二回复"),
  ];
  renderPanel();
  const first = screen.getByTestId("operations-first");
  const second = screen.getByTestId("operations-second");
  const firstTool = screen.getByText("第一工具结果").closest("article")!;
  const secondQuestion = screen.getByText("第二问题");
  const secondReply = screen.getByText("第二回复");
  expect(firstTool.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(first.compareDocumentPosition(secondQuestion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(secondReply.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getAllByTestId("operations-first")).toHaveLength(1);
  expect(screen.getAllByTestId("operations-second")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "本次运行成果" })).not.toBeInTheDocument();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  fireEvent.click(first.querySelector("button")!);
  expect(screen.queryByRole("dialog", { name: "确认保存成果" })).not.toBeInTheDocument();
});

it("keeps active operation controls after the live reply or thinking placeholder, without repeating them at a persisted anchor", () => {
  state.run = { ...run, id: "live" }; state.busy = true;
  state.messages = [message("tool", "live", "tool", "此前工具结果")];
  state.liveText = "正在生成的回复";
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const panel = <QueryClientProvider client={client}><AgentPanel open onClose={closed} scope={scope} workspaceRoot="/workspace" /></QueryClientProvider>;
  const view = render(panel);
  let operations = screen.getByTestId("operations-live");
  expect(screen.getByText("正在生成的回复").compareDocumentPosition(operations) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(operations).toHaveAttribute("data-active", "true");
  expect(screen.getAllByTestId("operations-live")).toHaveLength(1);
  state.liveText = "";
  view.rerender(<QueryClientProvider client={client}><AgentPanel open onClose={closed} scope={scope} workspaceRoot="/workspace" /></QueryClientProvider>);
  operations = screen.getByTestId("operations-live");
  expect(screen.getByText("正在思考…").compareDocumentPosition(operations) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getAllByTestId("operations-live")).toHaveLength(1);
});

it("moves controls to the later message after pagination instead of rendering the same run twice", () => {
  state.messages = [message("a1", "historical", "assistant", "第一页回复")];
  state.nextOrdinal = 49;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><AgentPanel open onClose={closed} scope={scope} workspaceRoot="/workspace" /></QueryClientProvider>);
  expect(screen.getAllByTestId("operations-historical")).toHaveLength(1);
  state.messages = [...state.messages, message("a2", "historical", "assistant", "后续页回复")];
  state.nextOrdinal = null;
  view.rerender(<QueryClientProvider client={client}><AgentPanel open onClose={closed} scope={scope} workspaceRoot="/workspace" /></QueryClientProvider>);
  const operations = screen.getByTestId("operations-historical");
  expect(screen.getByText("后续页回复").compareDocumentPosition(operations) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getAllByTestId("operations-historical")).toHaveLength(1);
});

it("follows asynchronously growing operation content only while the reader is at the bottom", () => {
  const observers: ContentObserver[] = [];
  class ContentObserver implements ResizeObserver {
    targets = new Set<Element>();
    constructor(private callback: ResizeObserverCallback) { observers.push(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect = vi.fn(() => { this.targets.clear(); });
    emit() { this.callback([], this); }
  }
  vi.stubGlobal("ResizeObserver", ContentObserver);
  const view = renderPanel();
  try {
    const viewport = screen.getByRole("region", { name: "助手消息" });
    const content = viewport.firstElementChild!;
    let height = 300;
    let position = 200;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, get: () => height },
      scrollTop: { configurable: true, get: () => position, set: value => { position = Math.max(0, Math.min(value, height - 100)); } },
    });
    const grew = () => act(() => observers.filter(observer => observer.targets.has(content)).forEach(observer => observer.emit()));
    fireEvent.scroll(viewport, { target: { scrollTop: 200 } });
    height = 500; grew();
    expect(viewport.scrollTop).toBe(400);
    fireEvent.scroll(viewport, { target: { scrollTop: 75 } });
    height = 700; grew();
    expect(viewport.scrollTop).toBe(75);
    fireEvent.scroll(viewport, { target: { scrollTop: 600 } });
    height = 800; grew();
    expect(viewport.scrollTop).toBe(700);
    view.unmount();
    expect(observers.every(observer => observer.disconnect.mock.calls.length > 0)).toBe(true);
  } finally { view.unmount(); vi.unstubAllGlobals(); }
});
