import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversationMessage, AgentRunEvent, AgentScopeSettings, AgentSessionMetadata, AgentStoredRun } from "../../lib/agent-types";
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
  vi.clearAllMocks(); localStorage.clear(); stop = vi.fn();
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
  it("loads only metadata until a question or history selection", async () => {
    const view = await ready();
    expect(api.contextGet).not.toHaveBeenCalled(); expect(api.sessionGet).not.toHaveBeenCalled();
    expect(api.runStart).not.toHaveBeenCalled(); expect(api.profileProbe).not.toHaveBeenCalled();
    expect(api.sessionsList).toHaveBeenCalledWith(binding, { scope, limit: 20 });
    await act(async () => { await view.result.current.setEnabled(false); });
    expect(api.settingsUpdate).toHaveBeenCalledWith(binding, { settings: { ...settings, enabled: false }, expectedRevision: 1 });
    expect(view.result.current.settings?.enabled).toBe(false);
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
