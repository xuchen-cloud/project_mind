import { Fragment, useEffect } from "react";
import type { AgentReviewHandle } from "../../hooks/useAgentReviewPlan";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversationMessage, AgentScopeSettings, AgentSessionMetadata, AgentStoredRun } from "../../lib/agent-types";
import type { AiSettingsSnapshot } from "../../lib/types";
const mocked = vi.hoisted(() => ({ useConversation: vi.fn(), aiSettingsGet: vi.fn(), openSettings: vi.fn(), knowledge: vi.fn(), review: null as AgentReviewHandle | null }));
vi.mock("./useAgentConversation", async importOriginal => ({ ...await importOriginal<typeof import("./useAgentConversation")>(), useAgentConversation: mocked.useConversation }));
vi.mock("./AgentPiMessages", () => ({ AgentPiMessages: (props: import("./AgentPiMessages").AgentPiMessagesProps) => {
  const { messages, liveText, isStreaming, streamRunId = null, renderAfterRun, renderBeforeStream } = props;
  const streams = isStreaming || !!liveText;
  const last = new Map(messages.map((message, index) => [message.runId, index]));
  const stream = () => <>{renderBeforeStream?.()}{liveText ? <article><p>{liveText}</p></article> : null}</>;
  return <div data-testid="pi-messages">{messages.map((message, index) => <Fragment key={message.id}>
    <article><p>{typeof message.content === "string" ? message.content : JSON.stringify(message.content)}</p></article>
    {last.get(message.runId) === index ? <>{streams && message.runId === streamRunId ? stream() : null}{renderAfterRun?.(message.runId)}</> : null}
  </Fragment>)}{streams && !last.has(streamRunId) ? <>{stream()}{renderAfterRun?.(streamRunId)}</> : null}</div>;
} }));
vi.mock("./AgentKnowledgePanel", () => ({ AgentKnowledgePanel: (props: unknown) => { mocked.knowledge(props); return <div>知识目录</div>; } }));
vi.mock("./AgentSourceCard", () => ({ AgentSourceCard: () => <div>来源卡片</div> }));
vi.mock("./AgentRunOutputs", () => ({ AgentRunOutputs: ({ runId, active, current, onReviewChange }: { runId: string; active?: boolean; current?: boolean; onReviewChange?: (handle: AgentReviewHandle | null) => void }) => {
  useEffect(() => { onReviewChange?.(current && !active ? mocked.review : null); return () => onReviewChange?.(null); }, [current, active, onReviewChange, mocked.review]);
  return <div data-testid={`operations-${runId}`} data-active={active || undefined}>操作 {runId}<button>确认执行</button></div>;
} }));
vi.mock("../../services/projectMindApi", () => ({ projectMindApi: { aiSettingsGet: mocked.aiSettingsGet } }));
vi.mock("../../state/ui-store", () => ({ useUiStore: (selector: (state: { openSettings: typeof mocked.openSettings }) => unknown) => selector({ openSettings: mocked.openSettings }) }));
import { AgentPanel } from "./AgentPanel";
import { agentApi } from "../../services/agentApi";
import { useAgentPanelStore } from "../../state/agent-panel-store";
import type { useAgentConversation } from "./useAgentConversation";
const scope = { kind: "project", projectId: 1 } as const;
const binding = { workspaceId: "workspace", generation: "generation" };
const session: AgentSessionMetadata = { id: "a".repeat(32), scope, title: "已有会话", runtimeId: "builtin-pi", profileOverrideId: null, state: "active", createdAt: "now", updatedAt: "now" };
const settings: AgentScopeSettings = { scope, enabled: true, goalRecordId: null, pinnedRefs: [], summaryPolicy: "on_success", overviewIntervalHours: 24, overviewLocalTime: "03:00", overviewTimezone: "UTC", executionMode: "collaborate", revision: 1 };
const run: AgentStoredRun = { id: "b".repeat(32), sessionId: session.id, clientRequestId: "client", state: "running", contextManifest: {}, startedAt: "now", finishedAt: null, usage: null, errorCode: null };
const modelSnapshot = {
  profiles: [{ id: 1, name: "通用配置", providerFamily: "openai_compatible", defaultModel: "model", enabled: true, supportsText: true, hasStoredKey: true }],
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
  await waitFor(() => expect(screen.getByRole("combobox", { name: "会话模型" })).toBeInTheDocument());
  return view;
}
beforeEach(() => {
  vi.clearAllMocks(); mocked.review = null; useAgentPanelStore.getState().clearWorkspace();
  state = {
    binding, settings, sessions: [session], sessionCursor: null, session: null, profileOverrideId: null, selectProfileOverride: vi.fn(), messages: [], nextOrdinal: null,
    run: null, liveText: "", pendingPrompt: "", toolActivity: "", error: null, loading: false,
    starting: false, reading: false, savingSettings: false, probing: false, verified: false, runtimeAvailable: true, busy: false,
    setEnabled: vi.fn(async () => true), setMode: vi.fn(async () => true), setSchedule: vi.fn(async () => true), selectSession: vi.fn(async () => {}), send: vi.fn(async () => true),
    cancel: vi.fn(async () => {}), refresh: vi.fn(async () => {}), moreSessions: vi.fn(async () => {}),
    probe: vi.fn(async () => {}), loadMore: vi.fn(async () => {}),
  };
  mocked.useConversation.mockImplementation(() => state);
  mocked.aiSettingsGet.mockResolvedValue(modelSnapshot);
});
describe("Project assistant panel", () => {
  it("offers usable compatible profiles and locks the selection while busy", async () => {
    mocked.aiSettingsGet.mockResolvedValue({ ...modelSnapshot, profiles: [
      ...modelSnapshot.profiles, { ...modelSnapshot.profiles[0], id: 2, name: "备用模型", defaultModel: "alternate" },
      { ...modelSnapshot.profiles[0], id: 3, name: "停用模型", enabled: false },
    ] });
    const view = await loaded();
    const selector = screen.getByRole("combobox", { name: "会话模型" });
    expect(await screen.findByRole("option", { name: "备用模型 · alternate" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /停用模型/ })).not.toBeInTheDocument();
    fireEvent.change(selector, { target: { value: "2" } });
    expect(state.selectProfileOverride).toHaveBeenCalledWith(2);
    state.busy = true; view.rerender(<QueryClientProvider client={new QueryClient()}><AgentPanel open onClose={closed} scope={scope} workspaceRoot="/workspace" /></QueryClientProvider>);
    expect(screen.getByRole("combobox", { name: "会话模型" })).toBeDisabled();
  });
  it("shows a restored override and blocks sending if its profile is unavailable", async () => {
    state.session = { ...session, profileOverrideId: 42 };
    await renderPanel();
    await waitFor(() => expect(screen.getByText("所选模型配置已删除或不可用")).toBeInTheDocument());
    expect(screen.queryByRole("combobox", { name: "会话模型" })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "问题" }), "问题");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "更多", exact: true }));
    expect(screen.getByRole("button", { name: "验证工具能力" })).toBeDisabled();
  });
  it("shows the general binding model on an existing default session", async () => {
    state.session = session;
    mocked.aiSettingsGet.mockResolvedValue({ ...modelSnapshot, bindings: [{ capability: "default", profileId: 1, model: "binding-model" }] });
    await renderPanel();
    expect(await screen.findByText("通用配置 · binding-model")).toBeInTheDocument();
  });
  it("shows an existing override's profile model instead of the general binding model", async () => {
    state.session = { ...session, profileOverrideId: 2 };
    mocked.aiSettingsGet.mockResolvedValue({ ...modelSnapshot,
      profiles: [...modelSnapshot.profiles, { ...modelSnapshot.profiles[0], id: 2, name: "会话配置", defaultModel: "override-model" }],
      bindings: [{ capability: "default", profileId: 1, model: "binding-model" }],
    });
    await renderPanel();
    expect(await screen.findByText("会话配置 · override-model")).toBeInTheDocument();
  });
  it("requires an explicit model probe and reads knowledge only after choosing its tab", async () => {
    await loaded();
    expect(state.probe).not.toHaveBeenCalled(); expect(mocked.knowledge).not.toHaveBeenCalled();
    expect(screen.queryByText("验证会请求一次模型")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "更多", exact: true }));
    expect(screen.getByText("验证会请求一次模型")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "验证工具能力" }));
    expect(state.probe).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "知识", exact: true }));
    expect(mocked.knowledge).toHaveBeenCalledWith({ binding, scope });
    expect(screen.getByText("知识目录")).toBeInTheDocument();
  });
  it("persists the selected scope enable setting and opens the existing model settings", async () => {
    await loaded();
    await userEvent.click(screen.getByRole("button", { name: "更多", exact: true }));
    await userEvent.click(screen.getByRole("checkbox", { name: "启用本项目助手" }));
    expect(state.setEnabled).toHaveBeenCalledWith(false);
    fireEvent.change(screen.getByRole("combobox", { name: "执行模式" }), { target: { value: "review" } });
    expect(state.setMode).toHaveBeenCalledWith("review");
    await userEvent.click(screen.getByRole("button", { name: "模型设置" }));
    expect(mocked.openSettings).toHaveBeenCalledWith("ai-models"); expect(closed).not.toHaveBeenCalled();
  });
  it("edits and confirms the persisted maintenance schedule", async () => {
    await loaded();
    await userEvent.click(screen.getByRole("button", { name: "更多", exact: true }));
    fireEvent.change(screen.getByRole("combobox", { name: "维护频率" }), { target: { value: "48" } });
    fireEvent.change(screen.getByRole("textbox", { name: "维护时区" }), { target: { value: "Asia/Shanghai" } });
    await userEvent.click(screen.getByRole("button", { name: "保存维护设置" }));
    expect(state.setSchedule).toHaveBeenCalledWith({ overviewIntervalHours: 48, overviewLocalTime: "03:00", overviewTimezone: "Asia/Shanghai" });
    expect(await screen.findByText("维护设置已保存")).toBeInTheDocument();
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
    await loaded();
    expect(screen.getByText("流式回答")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "历史会话" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "历史", exact: true }));
    expect(screen.getByRole("button", { name: session.title })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "更多", exact: true }));
    expect(screen.getByRole("combobox", { name: "执行模式" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "知识", exact: true })).toBeDisabled();
    const draft = screen.getByRole("textbox", { name: "问题" });
    expect(draft).toBeEnabled();
    await userEvent.type(draft, "下一条草稿{Enter}");
    expect(draft).toHaveValue("下一条草稿");
    expect(state.send).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(state.cancel).toHaveBeenCalledOnce();
    state.busy = false; state.run = { ...run, state: "cancelled" };
    await userEvent.click(screen.getByRole("button", { name: "更多", exact: true }));
    expect(state.send).not.toHaveBeenCalled();
    expect(draft).toHaveValue("下一条草稿");
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(state.send).toHaveBeenCalledWith("下一条草稿");
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
  it("keeps the conversation draft while searching history and opening a match", async () => {
    vi.spyOn(agentApi, "sessionSearch").mockResolvedValueOnce({
      matches: [{ sessionId: session.id, messageId: "message", runtimeEntryId: "entry", ordinal: 1,
        role: "user", createdAt: "2026-10-09T10:00:00Z", contentHash: "sha256:abc", branchLeafId: "leaf",
        snippet: "找到的讨论", sessionTitle: "相关会话" }], nextCursor: null,
      coverage: { indexedMessages: 1, remainingMessages: 0, backfilledThisRequest: 1, pendingSessions: 0, complete: true },
    });
    await loaded();
    const draft = screen.getByRole("textbox", { name: "问题" });
    await userEvent.type(draft, "未发送的问题");
    await userEvent.click(screen.getByRole("button", { name: "历史", exact: true }));
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索历史讨论" }), "讨论{Enter}");
    await screen.findByText("找到的讨论");
    expect(draft).toHaveValue("未发送的问题");
    await userEvent.click(screen.getByRole("button", { name: "打开会话" }));
    expect(state.selectSession).toHaveBeenCalledWith(session.id);
    expect(draft).toHaveValue("未发送的问题");
    vi.mocked(agentApi.sessionSearch).mockRestore();
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
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
    let viewportHeight = 100;
    let position = 200;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, get: () => viewportHeight },
      scrollHeight: { configurable: true, get: () => height },
      scrollTop: { configurable: true, get: () => position, set: value => { position = Math.max(0, Math.min(value, height - viewportHeight)); } },
    });
    const grew = () => act(() => observers.filter(observer => observer.targets.has(content)).forEach(observer => observer.emit()));
    fireEvent.scroll(viewport, { target: { scrollTop: 200 } });
    height = 500; grew();
    expect(viewport.scrollTop).toBe(400);
    // Pi's next Markdown leaf grows before the preceding programmatic scroll
    // event arrives. Its new bottom gap must not count as the user scrolling up.
    height = 650;
    fireEvent.scroll(viewport);
    grew();
    expect(viewport.scrollTop).toBe(550);
    // A review hint outside the viewport reduces its height independently.
    viewportHeight = 66;
    act(() => observers.filter(observer => observer.targets.has(viewport)).forEach(observer => observer.emit()));
    expect(viewport.scrollTop).toBe(584);
    viewportHeight = 100;
    act(() => observers.filter(observer => observer.targets.has(viewport)).forEach(observer => observer.emit()));
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

it("retains draft and message viewport when closed or expanded, with a review fallback", async () => {
  state.settings = null;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const toggle = vi.fn();
  const panel = (open: boolean, expanded = false) => <QueryClientProvider client={client}><AgentPanel
    open={open} expanded={expanded} onToggleExpanded={toggle} onClose={closed} scope={scope} workspaceRoot="/workspace" scopeName="资料项目" /></QueryClientProvider>;
  const view = render(panel(true));
  expect(screen.getByRole("combobox", { name: "执行模式" })).toHaveValue("review");
  expect(screen.getByText("资料项目")).toBeInTheDocument();
  const field = screen.getByRole("textbox", { name: "问题" });
  const viewport = screen.getByRole("region", { name: "助手消息" });
  await userEvent.type(field, "保留的草稿");
  Object.defineProperties(viewport, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 100 } });
  fireEvent.scroll(viewport, { target: { scrollTop: 120 } });
  await userEvent.click(screen.getByRole("button", { name: "展开助手" }));
  expect(toggle).toHaveBeenCalledOnce();
  view.rerender(panel(true, true));
  expect(screen.getByRole("textbox", { name: "问题" })).toBe(field);
  expect(viewport.scrollTop).toBe(120);
  view.rerender(panel(false, true));
  expect(screen.queryByRole("textbox", { name: "问题" })).not.toBeInTheDocument();
  view.rerender(panel(true, true));
  expect(screen.getByRole("textbox", { name: "问题" })).toHaveValue("保留的草稿");
  expect(screen.getByRole("region", { name: "助手消息" })).toBe(viewport);
  expect(viewport.scrollTop).toBe(120);
});

it("keeps the review controller mounted across closing and reopening", () => {
  state.run = run; state.busy = true; state.liveText = "第一段";
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const panel = (open: boolean) => <QueryClientProvider client={client}><AgentPanel open={open} onClose={closed} scope={scope} workspaceRoot="/workspace" /></QueryClientProvider>;
  const view = render(panel(true));
  const operations = screen.getByTestId(`operations-${run.id}`);
  view.rerender(panel(false));
  expect(document.querySelector('[aria-label="助手消息"]')).toBeInTheDocument();
  expect(screen.getByTestId(`operations-${run.id}`)).toBe(operations);
  view.rerender(panel(true));
  expect(screen.getByTestId(`operations-${run.id}`)).toBe(operations);
});

function reviewFixture(overrides: Partial<AgentReviewHandle> = {}) {
  state.run = { ...run, state: "completed" };
  state.messages = [message("review-answer", run.id, "assistant", "方案已准备好")];
  const handle: AgentReviewHandle = { runId: run.id, summary: "创建记录 1 项", pending: [{ outputId: "output", expectedRevision: 1 }],
    busy: false, confirmed: false, decide: vi.fn(async decision => ({ decision, outputs: [], failures: [] })),
    stop: vi.fn(async () => null), ...overrides };
  mocked.review = handle;
  return handle;
}
it.each(["确认", "确认执行。", "同意执行！", "执行吧", "取消", "取消执行。", "不用了！"])("sends %s through the current Pi conversation", async text => {
  const review = reviewFixture();
  await loaded();
  await waitFor(() => expect(screen.getByText(/可用方案按钮确认或取消/)).toBeInTheDocument());
  const field = screen.getByRole("textbox", { name: "问题" });
  await userEvent.type(field, ` ${text} `);
  await userEvent.click(screen.getByRole("button", { name: "发送" }));
  expect(review.decide).not.toHaveBeenCalled();
  expect(state.send).toHaveBeenCalledWith(` ${text} `);
  await waitFor(() => expect(field).toHaveValue(""));
});
it("sends added requirements as a new run without treating embedded confirmation words as approval", async () => {
  const review = reviewFixture();
  await loaded();
  const field = screen.getByRole("textbox", { name: "问题" });
  await userEvent.type(field, "确认之前先调整期限，取消第二项并补充期限");
  await userEvent.click(screen.getByRole("button", { name: "发送" }));
  expect(review.decide).not.toHaveBeenCalled();
  expect(state.send).toHaveBeenCalledWith("确认之前先调整期限，取消第二项并补充期限");
});
it("keeps a declined model message draft", async () => {
  const review = reviewFixture({ decide: vi.fn(async () => { throw { code: "REVISION_CONFLICT" }; }) });
  state.send.mockResolvedValueOnce(false);
  await loaded();
  const field = screen.getByRole("textbox", { name: "问题" });
  await userEvent.type(field, "确认");
  await userEvent.click(screen.getByRole("button", { name: "发送" }));
  expect(field).toHaveValue("确认");
  expect(review.decide).not.toHaveBeenCalled();
  expect(state.send).toHaveBeenCalledWith("确认");
});
it("keeps review saves busy until the real stop settles and never queues its draft", async () => {
  let settled!: () => void;
  const stopped = new Promise<null>(resolve => { settled = () => resolve(null); });
  const review = reviewFixture({ busy: true, stop: vi.fn(() => stopped) });
  const view = await loaded();
  const field = screen.getByRole("textbox", { name: "问题" });
  await userEvent.type(field, "停止后补充{Enter}");
  expect(state.send).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "停止" }));
  expect(review.stop).toHaveBeenCalledOnce();
  expect(state.cancel).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  await act(async () => { settled(); await stopped; });
  mocked.review = { ...review, busy: false };
  // The controller's authoritative settled handle is the only unlock signal.
  await userEvent.click(screen.getByRole("button", { name: "更多", exact: true }));
  await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
  expect(state.send).not.toHaveBeenCalled();
  expect(field).toHaveValue("停止后补充");
  await userEvent.click(screen.getByRole("button", { name: "发送" }));
  expect(state.send).toHaveBeenCalledWith("停止后补充");
  view.unmount();
});

it("shows and sends a matching discussion object separately, and allows removing it without changing the draft", async () => {
  const object = { workspaceId: binding.workspaceId, scope, kind: "record" as const, id: "42" };
  useAgentPanelStore.getState().openPanel("/workspace", scope);
  expect(useAgentPanelStore.getState().setDiscussionTarget(binding, object, "项目记录")).toBe(true);
  await loaded();
  expect(screen.getByText("讨论：项目记录")).toBeInTheDocument();
  const field = screen.getByRole("textbox", { name: "问题" });
  await userEvent.type(field, "补充期限");
  await userEvent.click(screen.getByRole("button", { name: "发送" }));
  expect(state.send).toHaveBeenCalledWith("补充期限", object);
  await waitFor(() => expect(field).toHaveValue(""));
  await userEvent.type(field, "保留这个草稿");
  await userEvent.click(screen.getByRole("button", { name: "移除讨论对象" }));
  expect(useAgentPanelStore.getState().discussionTarget).toBeNull();
  expect(field).toHaveValue("保留这个草稿");
});
it("does not display or send a discussion target from another binding generation or scope", async () => {
  useAgentPanelStore.getState().openPanel("/workspace", scope);
  const object = { workspaceId: binding.workspaceId, scope, kind: "todo" as const, id: "42" };
  useAgentPanelStore.getState().setDiscussionTarget({ ...binding, generation: "old-generation" }, object, "旧对象");
  await loaded();
  expect(screen.queryByRole("button", { name: "移除讨论对象" })).not.toBeInTheDocument();
  await userEvent.type(screen.getByRole("textbox", { name: "问题" }), "普通问题");
  await userEvent.click(screen.getByRole("button", { name: "发送" }));
  expect(state.send).toHaveBeenCalledWith("普通问题");
  // A cross-scope entry cannot silently switch the explicitly opened session.
  expect(useAgentPanelStore.getState().setDiscussionTarget(binding, { ...object, scope: { kind: "project", projectId: 2 } }, "另一个项目")).toBe(false);
  expect(useAgentPanelStore.getState().binding?.scope).toEqual(scope);
});

it("shows an unpersisted question before the Pi stream once, then uses only its durable user entry", () => {
  state.run = run; state.busy = true; state.pendingPrompt = "当前问题"; state.liveText = "当前回答";
  state.messages = [message("old-answer", "old-run", "assistant", "此前回答")];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const panel = () => <QueryClientProvider client={client}><AgentPanel open onClose={closed} scope={scope} workspaceRoot="/workspace" /></QueryClientProvider>;
  const view = render(panel());
  const pending = screen.getByRole("article", { name: "正在提交的问题" });
  expect(screen.getByText("此前回答").compareDocumentPosition(pending) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(pending.compareDocumentPosition(screen.getByText("当前回答")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getAllByText("当前问题")).toHaveLength(1);
  state.messages = [...state.messages, message("saved-user", run.id, "user", "当前问题")];
  view.rerender(panel());
  expect(screen.queryByRole("article", { name: "正在提交的问题" })).not.toBeInTheDocument();
  expect(screen.getAllByText("当前问题")).toHaveLength(1);
  expect(screen.getAllByText("当前回答")).toHaveLength(1);
  expect(screen.getAllByTestId(`operations-${run.id}`)).toHaveLength(1);
});
it("keeps native review buttons available when the model is unavailable", async () => {
  const review = reviewFixture();
  mocked.aiSettingsGet.mockResolvedValue({ ...modelSnapshot, profiles: [], bindings: [] });
  state.runtimeAvailable = false;
  renderPanel();
  await waitFor(() => expect(screen.getByText(/可用方案按钮确认或取消/)).toBeInTheDocument());
  await userEvent.type(screen.getByRole("textbox", { name: "问题" }), "确认");
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  expect(review.decide).not.toHaveBeenCalled();
  expect(state.send).not.toHaveBeenCalled();
});
