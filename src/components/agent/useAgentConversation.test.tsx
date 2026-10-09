import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversationMessage, AgentObjectRef, AgentRunEvent, AgentScopeSettings, AgentSessionMetadata, AgentStoredRun } from "../../lib/agent-types";
const api = vi.hoisted(() => ({
  statusGet: vi.fn(), settingsGet: vi.fn(), settingsUpdate: vi.fn(), sessionsList: vi.fn(),
  sessionCreate: vi.fn(), sessionGet: vi.fn(), runStart: vi.fn(), runCancel: vi.fn(),
  runGet: vi.fn(), runEventsList: vi.fn(), profileProbe: vi.fn(), onRunEvent: vi.fn(), contextGet: vi.fn(),
  bindingGet: vi.fn(),
}));
vi.mock("../../services/agentApi", async importOriginal => ({
  ...await importOriginal<typeof import("../../services/agentApi")>(), agentApi: api,
}));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: api.bindingGet } }));
import { AgentApiError } from "../../services/agentApi";
import { useAgentConversation } from "./useAgentConversation";
import { useAgentPanelStore } from "../../state/agent-panel-store";
const binding = { workspaceId: "workspace", generation: "generation" };
const scope = { kind: "project", projectId: 1 } as const;
const session: AgentSessionMetadata = { id: "a".repeat(32), scope, title: "已有会话", runtimeId: "builtin-pi", profileOverrideId: null, state: "active", createdAt: "now", updatedAt: "now" };
const stored: AgentStoredRun = { id: "b".repeat(32), sessionId: session.id, clientRequestId: "client", state: "running", contextManifest: {}, startedAt: "now", finishedAt: null, usage: null, errorCode: null };
const settings: AgentScopeSettings = { scope, enabled: true, goalRecordId: null, pinnedRefs: [], summaryPolicy: "on_success", overviewIntervalHours: 24, overviewLocalTime: "03:00", overviewTimezone: "UTC", executionMode: "collaborate", revision: 1 };
let listener: (event: AgentRunEvent) => void;
let stop: ReturnType<typeof vi.fn>;
function event(seq: number, kind: AgentRunEvent["event"], overrides: Partial<AgentRunEvent> = {}): AgentRunEvent {
  return { binding, sessionId: session.id, runId: stored.id, seq, event: kind, ...overrides };
}
function message(ordinal: number, role: AgentConversationMessage["role"] = "assistant"): AgentConversationMessage {
  return { id: `message-${ordinal}`, sessionId: session.id, runId: stored.id, runtimeEntryId: `entry-${ordinal}`, role, content: [{ type: "text", text: `消息 ${ordinal}` }], ordinal, createdAt: "now" };
}
function checkpoint(count = 1) {
  return { schemaVersion: 1, checksum: "sha256:abc", bytes: 100, leafId: "entry", offset: 100, entryCount: count, messageCount: count };
}
async function ready() {
  const view = renderHook(() => useAgentConversation(scope, "/workspace"));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  return view;
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); stop = vi.fn(); useAgentPanelStore.getState().clearWorkspace();
  api.statusGet.mockResolvedValue({ binding, runtimeAvailable: true, bridgeAvailable: false, capabilities: [] });
  api.bindingGet.mockResolvedValue(binding);
  api.settingsGet.mockResolvedValue(settings);
  api.settingsUpdate.mockImplementation(async (_binding, data) => ({ ...data.settings, revision: data.expectedRevision + 1 }));
  api.sessionsList.mockResolvedValue({ sessions: [session], nextCursor: null });
  api.sessionCreate.mockResolvedValue(session);
  api.sessionGet.mockResolvedValue({ session, latestRun: null, checkpoint: null, messages: [], nextOrdinal: null });
  api.runStart.mockResolvedValue(stored); api.runGet.mockResolvedValue(stored);
  api.runEventsList.mockResolvedValue({ events: [], nextSeq: null, firstAvailableSeq: null });
  api.runCancel.mockResolvedValue({ ...stored, state: "cancelling" });
  api.profileProbe.mockResolvedValue({ verified: true });
  api.onRunEvent.mockImplementation(async callback => { listener = callback; return stop; });
});

describe("assistant conversation lifecycle", () => {
  it("retains a same-binding Project discussion target when the Workspace conversation initializes", async () => {
    const workspaceScope = { kind: "workspace" } as const;
    const target: AgentObjectRef = { workspaceId: binding.workspaceId, scope, kind: "record", id: "42" };
    useAgentPanelStore.getState().openPanel("/workspace", workspaceScope);
    expect(useAgentPanelStore.getState().setDiscussionTarget(binding, target, "项目记录")).toBe(true);
    const view = renderHook(() => useAgentConversation(workspaceScope, "/workspace"));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(useAgentPanelStore.getState().discussionTarget?.object).toEqual(target);
    view.unmount();
  });
  it("coalesces separate high-frequency deltas, flushes the tail, and pauses while hidden", async () => {
    const view = renderHook(({ visible }) => useAgentConversation(scope, "/workspace", visible), { initialProps: { visible: true } });
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    await act(async () => { await view.result.current.send("流测试"); });
    vi.useFakeTimers();
    try {
      const updates: string[] = [];
      for (let seq = 1; seq <= 40; seq++) {
        await act(async () => { listener(event(seq, { type: "text.delta", data: { text: "字" } })); await Promise.resolve(); });
        await act(async () => { vi.advanceTimersByTime(5); await Promise.resolve(); });
        const value = view.result.current.liveText;
        if (value && value !== updates.at(-1)) updates.push(value);
      }
      expect(updates.length).toBeLessThanOrEqual(4);
      expect(view.result.current.liveText).toBe("字".repeat(40));
      view.rerender({ visible: false });
      for (let seq = 41; seq <= 50; seq++) {
        await act(async () => { listener(event(seq, { type: "text.delta", data: { text: "尾" } })); await Promise.resolve(); });
        await act(async () => { vi.advanceTimersByTime(10); await Promise.resolve(); });
      }
      expect(view.result.current.liveText).toBe("字".repeat(40));
      view.rerender({ visible: true });
      expect(view.result.current.liveText).toBe("字".repeat(40) + "尾".repeat(10));
      await act(async () => { listener(event(51, { type: "text.delta", data: { text: "终" } })); await Promise.resolve(); });
      // Keep the persisted read pending so the terminal event's immediate flush is observable.
      api.sessionGet.mockImplementationOnce(() => new Promise(() => {}));
      await act(async () => { listener(event(52, { type: "run.completed" })); await Promise.resolve(); });
      expect(view.result.current.liveText).toBe("字".repeat(40) + "尾".repeat(10) + "终");
    } finally { vi.useRealTimers(); view.unmount(); }
  });
  it("discards a pending delta on scope change and ignores the old run", async () => {
    const view = renderHook(({ currentScope }) => useAgentConversation(currentScope, "/workspace"), {
      initialProps: { currentScope: scope as { kind: "project"; projectId: number } },
    });
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    await act(async () => { await view.result.current.send("旧问题"); });
    vi.useFakeTimers();
    try {
      await act(async () => { listener(event(1, { type: "text.delta", data: { text: "旧内容" } })); await Promise.resolve(); });
      view.rerender({ currentScope: { kind: "project", projectId: 2 } });
      await act(async () => { vi.advanceTimersByTime(100); await Promise.resolve(); });
      expect(view.result.current.liveText).toBe("");
      await act(async () => { listener(event(2, { type: "text.delta", data: { text: "仍是旧内容" } })); await Promise.resolve(); });
      expect(view.result.current.liveText).toBe("");
    } finally { vi.useRealTimers(); view.unmount(); }
  });
  it("uses the selected profile for creation and probe, then keeps the created session binding", async () => {
    const overridden = { ...session, profileOverrideId: 2 };
    api.sessionCreate.mockResolvedValueOnce(overridden);
    const view = await ready();
    act(() => view.result.current.selectProfileOverride(2));
    await act(async () => { await view.result.current.probe(); });
    expect(api.profileProbe).toHaveBeenCalledWith(binding, { profileOverrideId: 2 });
    await act(async () => { await view.result.current.send("覆盖模型问题"); });
    expect(api.sessionCreate).toHaveBeenCalledWith(binding, { scope, title: "覆盖模型问题", profileOverrideId: 2 });
    expect(view.result.current.session?.profileOverrideId).toBe(2);
    act(() => view.result.current.selectProfileOverride(null));
    expect(view.result.current.profileOverrideId).toBe(2);
  });
  it("probes a restored session's binding independently of the next-session selection", async () => {
    const overridden = { ...session, profileOverrideId: 2 };
    api.sessionsList.mockResolvedValue({ sessions: [overridden], nextCursor: null });
    api.sessionGet.mockResolvedValue({ session: overridden, latestRun: null, checkpoint: null, messages: [], nextOrdinal: null });
    localStorage.setItem("project-mind:agent:last-session:workspace:project:1", session.id);
    const view = await ready();
    await act(async () => { await view.result.current.probe(); });
    expect(api.profileProbe).toHaveBeenCalledWith(binding, { profileOverrideId: 2 });
    await act(async () => { await view.result.current.selectSession(""); await view.result.current.probe(); });
    expect(api.profileProbe).toHaveBeenLastCalledWith(binding, {});
  });
  it("invalidates verification when the next-session profile changes", async () => {
    const view = await ready();
    await act(async () => { await view.result.current.probe(); });
    expect(view.result.current.verified).toBe(true);
    act(() => view.result.current.selectProfileOverride(2));
    expect(view.result.current.verified).toBe(false);
  });
  it("clears a pending model selection when the scope changes", async () => {
    const view = renderHook(({ currentScope }) => useAgentConversation(currentScope, "/workspace"), {
      initialProps: { currentScope: scope as { kind: "project"; projectId: number } },
    });
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    act(() => view.result.current.selectProfileOverride(2));
    expect(view.result.current.profileOverrideId).toBe(2);
    view.rerender({ currentScope: { kind: "project", projectId: 2 } });
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.profileOverrideId).toBeNull();
    await act(async () => { await view.result.current.probe(); });
    expect(api.profileProbe).toHaveBeenLastCalledWith(binding, {});
  });
  it("ignores a probe result after switching to another session", async () => {
    let finishProbe!: (value: { verified: boolean }) => void;
    api.profileProbe.mockImplementationOnce(() => new Promise(resolve => { finishProbe = resolve; }));
    const view = await ready();
    let probing!: Promise<void>;
    act(() => { probing = view.result.current.probe(); });
    await act(async () => { await view.result.current.selectSession(session.id); });
    await act(async () => { finishProbe({ verified: true }); await probing; });
    expect(view.result.current.verified).toBe(false);
  });
  it("uses the device timezone on first enable and preserves previously saved UTC", async () => {
    api.settingsGet.mockResolvedValueOnce({ ...settings, enabled: false, revision: 0 });
    const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    const timezone = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockImplementation(function (this: Intl.DateTimeFormat) { return { ...resolvedOptions.call(this), timeZone: "Asia/Shanghai" }; });
    const view = await ready();
    await act(async () => { await view.result.current.setEnabled(true); });
    expect(api.settingsUpdate).toHaveBeenCalledWith(binding, {
      settings: { ...settings, enabled: true, revision: 0, overviewTimezone: "Asia/Shanghai" }, expectedRevision: 0,
    });
    api.settingsUpdate.mockClear();
    api.settingsGet.mockResolvedValueOnce({ ...settings, enabled: false, revision: 2 });
    await act(async () => { await view.result.current.refresh(); });
    await act(async () => { await view.result.current.setEnabled(true); });
    expect(api.settingsUpdate).toHaveBeenCalledWith(binding, {
      settings: { ...settings, enabled: true, revision: 2 }, expectedRevision: 2,
    });
    timezone.mockRestore();
  });
  it("saves a schedule with CAS and retains the previous values on failure", async () => {
    const view = await ready();
    const schedule = { overviewIntervalHours: 48 as const, overviewLocalTime: "04:30", overviewTimezone: "Asia/Shanghai" };
    await act(async () => { expect(await view.result.current.setSchedule(schedule)).toBe(true); });
    expect(api.settingsUpdate).toHaveBeenCalledWith(binding, { settings: { ...settings, ...schedule }, expectedRevision: 1 });
    api.settingsGet.mockResolvedValueOnce({ ...settings, ...schedule, revision: 2 });
    await act(async () => { await view.result.current.refresh(); });
    expect(view.result.current.settings?.overviewTimezone).toBe("Asia/Shanghai");
    api.settingsUpdate.mockRejectedValueOnce(new AgentApiError({ code: "INVALID_ARGUMENT", message: "Invalid assistant settings", retryable: false }));
    await act(async () => { expect(await view.result.current.setSchedule({ ...schedule, overviewTimezone: "Invalid/Zone" })).toBe(false); });
    expect(view.result.current.settings?.overviewTimezone).toBe("Asia/Shanghai");
    expect(view.result.current.error).toBeTruthy();
  });
  it("passes an explicitly selected object separately without rewriting the question", async () => {
    const view = await ready();
    const object: AgentObjectRef = { workspaceId: binding.workspaceId, scope, kind: "todo", id: "42" };
    await act(async () => { expect(await view.result.current.send("把截止时间改到周五", object)).toBe(true); });
    expect(api.runStart).toHaveBeenCalledWith(binding, {
      sessionId: session.id, clientRequestId: expect.any(String), prompt: "把截止时间改到周五", discussionTarget: object,
    });
    expect(api.contextGet).not.toHaveBeenCalled();
  });
  it("omits the target for ordinary questions and clears it on a new session", async () => {
    useAgentPanelStore.getState().openPanel("/workspace", scope);
    const view = await ready();
    useAgentPanelStore.getState().setDiscussionTarget(binding, { workspaceId: binding.workspaceId, scope, kind: "record", id: "3" }, "记录");
    await act(async () => { await view.result.current.selectSession(""); });
    expect(useAgentPanelStore.getState().discussionTarget).toBeNull();
    await act(async () => { await view.result.current.send("普通问题"); });
    expect(api.runStart.mock.calls[0][1]).not.toHaveProperty("discussionTarget");
  });
  it("clears a selection when the same Workspace reopens with a new generation", async () => {
    useAgentPanelStore.getState().openPanel("/workspace", scope);
    const view = await ready();
    useAgentPanelStore.getState().setDiscussionTarget(binding, { workspaceId: binding.workspaceId, scope, kind: "file", id: "5" }, "文件");
    const next = { ...binding, generation: "new" };
    api.bindingGet.mockResolvedValue(next); api.statusGet.mockResolvedValue({ binding: next, runtimeAvailable: true });
    await act(async () => { await view.result.current.refresh(); });
    await waitFor(() => expect(view.result.current.binding).toEqual(next));
    expect(useAgentPanelStore.getState().discussionTarget).toBeNull();
  });
  it("loads only metadata until a question or history selection", async () => {
    const view = await ready();
    expect(api.contextGet).not.toHaveBeenCalled(); expect(api.sessionGet).not.toHaveBeenCalled();
    expect(api.runStart).not.toHaveBeenCalled(); expect(api.profileProbe).not.toHaveBeenCalled();
    expect(api.sessionsList).toHaveBeenCalledWith(binding, { scope, limit: 20 });
    await act(async () => { await view.result.current.setEnabled(false); });
    expect(api.settingsUpdate).toHaveBeenCalledWith(binding, { settings: { ...settings, enabled: false }, expectedRevision: 1 });
    expect(view.result.current.settings?.enabled).toBe(false);
    await act(async () => { await view.result.current.setMode("review"); });
    expect(api.settingsUpdate).toHaveBeenLastCalledWith(binding, { settings: { ...settings, enabled: false, executionMode: "review", revision: 2 }, expectedRevision: 2 });
    expect(view.result.current.settings?.executionMode).toBe("review");
    view.unmount(); expect(stop).toHaveBeenCalledOnce();
  });
  it("buffers events emitted before runStart responds and persists the settled projection", async () => {
    const view = await ready();
    api.runStart.mockImplementation(async () => {
      listener(event(1, { type: "run.started" }));
      listener(event(2, { type: "text.delta", data: { text: "你好" } }));
      return stored;
    });
    await act(async () => { expect(await view.result.current.send("第一个问题")).toBe(true); });
    await waitFor(() => expect(view.result.current.liveText).toBe("你好"));
    expect(api.onRunEvent.mock.invocationCallOrder[0]).toBeLessThan(api.runStart.mock.invocationCallOrder[0]);
    expect(api.sessionCreate).toHaveBeenCalledWith(binding, { scope, title: "第一个问题" });
    api.sessionGet.mockResolvedValue({ session, latestRun: null, checkpoint: checkpoint(), messages: [message(0)], nextOrdinal: null });
    await act(async () => { listener(event(3, { type: "run.completed" })); });
    await waitFor(() => expect(view.result.current.run?.state).toBe("completed"));
    await waitFor(() => expect(view.result.current.messages).toHaveLength(1));
    expect(view.result.current.liveText).toBe("");
    expect(api.contextGet).not.toHaveBeenCalled();
  });
  it("rejects stale bindings, other sessions/runs, and duplicate sequences", async () => {
    const view = await ready();
    await act(async () => { await view.result.current.send("问题"); });
    await act(async () => {
      listener(event(1, { type: "run.started" }));
      listener(event(2, { type: "text.delta", data: { text: "当前回答" } }));
      listener(event(2, { type: "text.delta", data: { text: "重复" } }));
      listener(event(3, { type: "text.delta", data: { text: "旧工作区" } }, { binding: { ...binding, generation: "old" } }));
      listener(event(3, { type: "text.delta", data: { text: "另一会话" } }, { sessionId: "c".repeat(32) }));
      listener(event(3, { type: "text.delta", data: { text: "另一运行" } }, { runId: "d".repeat(32) }));
    });
    await waitFor(() => expect(view.result.current.liveText).toBe("当前回答"));
    await act(async () => { await view.result.current.cancel(); });
    expect(api.runCancel).toHaveBeenCalledWith(binding, { runId: stored.id });
    expect(view.result.current.run?.state).toBe("cancelling");
  });
  it("paginates history explicitly and preserves the checkpoint bound", async () => {
    const view = await ready();
    const first = Array.from({ length: 50 }, (_, ordinal) => message(ordinal));
    api.sessionGet.mockResolvedValueOnce({ session, latestRun: null, checkpoint: checkpoint(51), messages: first, nextOrdinal: 49 })
      .mockResolvedValueOnce({ session, latestRun: null, checkpoint: checkpoint(51), messages: [message(50)], nextOrdinal: null });
    await act(async () => { await view.result.current.selectSession(session.id); });
    expect(view.result.current.messages).toHaveLength(50);
    expect(api.sessionGet).toHaveBeenCalledTimes(1);
    expect(api.sessionGet).toHaveBeenLastCalledWith(binding, { sessionId: session.id, afterOrdinal: null, limit: 50 });
    await act(async () => { await view.result.current.loadMore(); });
    expect(api.sessionGet).toHaveBeenLastCalledWith(binding, { sessionId: session.id, afterOrdinal: 49, limit: 50 });
    expect(view.result.current.messages).toHaveLength(51); expect(view.result.current.nextOrdinal).toBeNull();
  });
  it("restores an active run without any projected message after reopening the last selected session", async () => {
    localStorage.setItem("project-mind:agent:last-session:workspace:project:1", session.id);
    api.sessionGet.mockResolvedValue({ session, latestRun: stored, checkpoint: null, messages: [], nextOrdinal: null });
    const view = await ready();
    expect(view.result.current.session?.id).toBe(session.id);
    expect(view.result.current.run?.id).toBe(stored.id);
    expect(view.result.current.busy).toBe(true);
    await act(async () => { await view.result.current.cancel(); });
    expect(api.runCancel).toHaveBeenCalledWith(binding, { runId: stored.id });
    expect(api.contextGet).not.toHaveBeenCalled();
  });
  it("explains a persisted model timeout and preserves the readable conversation", async () => {
    api.sessionGet.mockResolvedValue({ session, latestRun: { ...stored, state: "failed", errorCode: "TIMED_OUT" },
      checkpoint: checkpoint(), messages: [message(0)], nextOrdinal: null });
    const view = await ready();
    await act(async () => { await view.result.current.selectSession(session.id); });
    expect(view.result.current.error).toBe("助手响应超时，已保存的消息仍可阅读；可稍后发送新问题继续。");
    expect(view.result.current.messages).toHaveLength(1);
  });
  it("shows a concrete busy error and does not treat rejection as completion", async () => {
    const view = await ready();
    api.runStart.mockRejectedValue(new AgentApiError({ code: "RUN_BUSY", message: "busy", retryable: false }));
    await act(async () => { expect(await view.result.current.send("保留这个问题")).toBe(false); });
    expect(view.result.current.error).toContain("工作区已有正在运行的助手");
    expect(view.result.current.busy).toBe(false); expect(view.result.current.run).toBeNull();
  });
  it("rebinds explicitly on refresh after the same Workspace reopens", async () => {
    const view = await ready();
    const next = { ...binding, generation: "new" };
    api.bindingGet.mockResolvedValue(next);
    api.statusGet.mockResolvedValue({ binding: next, runtimeAvailable: true });
    await act(async () => { await view.result.current.refresh(); });
    await waitFor(() => expect(view.result.current.binding).toEqual(next));
    expect(api.settingsGet).toHaveBeenLastCalledWith(next, scope);
    expect(stop).toHaveBeenCalled();
  });
});
