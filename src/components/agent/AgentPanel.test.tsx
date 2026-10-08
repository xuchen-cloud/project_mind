import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentScopeSettings, AgentSessionMetadata, AgentStoredRun } from "../../lib/agent-types";
import type { AiSettingsSnapshot } from "../../lib/types";
const mocked = vi.hoisted(() => ({ useConversation: vi.fn(), aiSettingsGet: vi.fn(), openSettings: vi.fn(), knowledge: vi.fn() }));
vi.mock("./useAgentConversation", () => ({ useAgentConversation: mocked.useConversation }));
vi.mock("./AgentKnowledgePanel", () => ({ AgentKnowledgePanel: (props: unknown) => { mocked.knowledge(props); return <div>知识目录</div>; } }));
vi.mock("./AgentSourceCard", () => ({ AgentSourceCard: () => <div>来源卡片</div> }));
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
    setEnabled: vi.fn(async () => {}), selectSession: vi.fn(async () => {}), send: vi.fn(async () => true),
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
