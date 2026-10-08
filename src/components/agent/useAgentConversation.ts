import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentConversationMessage, AgentRunEvent, AgentScope, AgentScopeSettings,
  AgentSessionCursor, AgentSessionMetadata, AgentStoredRun, AgentWorkspaceBinding,
} from "../../lib/agent-types";
import { getErrorMessage } from "../../lib/errors";
import { AgentApiError, agentApi } from "../../services/agentApi";
import { recordDocumentApi } from "../../services/recordDocumentApi";

export const CONVERSATION_PAGE_SIZE = 50;
const activeStates = new Set(["preparing", "running", "cancelling"]);
export function isAgentRunActive(run: AgentStoredRun | null) { return !!run && activeStates.has(run.state); }
export function agentFailureMessage(error: unknown): string {
  const code = error instanceof AgentApiError ? error.code
    : error && typeof error === "object" && "code" in error ? String(error.code) : null;
  const messages: Record<string, string> = {
    RUN_BUSY: "工作区已有正在运行的助手，请先停止或等待完成。",
    TOOL_CALL_UNSUPPORTED: "请先验证当前模型的工具能力；验证失败时，可在模型设置中更换兼容模型。",
    PROFILE_UNAVAILABLE: "请先在模型设置中配置可用的通用模型。",
    SECRETS_LOCKED: "请先解锁 AI 密钥，再使用助手。",
    WORKSPACE_CHANGED: "工作区已切换，请重新打开助手。",
    RUNTIME_UNAVAILABLE: "内置助手运行资源不可用，请检查应用安装。",
    BUDGET_EXCEEDED: "本次运行已达到上限，已保存的消息仍可阅读，可发送新的问题继续。",
    SOURCE_NOT_READY: "资料尚未准备好，请打开知识页查看资料处理状态。",
    SOURCE_CHANGED: "资料已变化，请刷新后继续提问。",
    IO_FAILED: "助手读取或保存会话失败，请刷新后重试。",
    INVALID_RUN_TRANSITION: "运行状态已变化，请刷新会话后继续。",
    RUNTIME_INCOMPATIBLE: "助手运行资源与应用版本不匹配，请检查应用安装。",
    WORKSPACE_NOT_OPEN: "请先打开工作区。",
    SCOPE_DENIED: "当前操作不在授权范围内，请检查此项目的助手设置。",
    REVISION_CONFLICT: "助手设置已变化，请刷新后重试。",
    RATE_LIMITED: "模型服务请求过于频繁，请稍后重试。",
    CANCELLED: "运行已停止。",
  };
  if (code === "SOURCE_NOT_READY" && error && typeof error === "object" && "details" in error) {
    const details = error.details;
    if (details && typeof details === "object" && "recovery" in details) {
      const recovery = details.recovery;
      if (recovery && typeof recovery === "object" && "message" in recovery && typeof recovery.message === "string") return recovery.message;
    }
  }
  if (code && messages[code]) return messages[code];
  if (code && error && typeof error === "object" && !("message" in error)) return "助手运行失败，可刷新后发送新问题继续。";
  return getErrorMessage(error, "助手操作失败，请重试。");
}
function sameBinding(a: AgentWorkspaceBinding, b: AgentWorkspaceBinding) {
  return a.workspaceId === b.workspaceId && a.generation === b.generation;
}

/** One bounded page at a time. Only a submitted question enters the Host's context path. */
export function useAgentConversation(scope: AgentScope, workspaceRoot?: string) {
  const scopeKey = scope.kind === "workspace" ? "workspace" : `project:${scope.projectId}`;
  const preferenceKey = (bound: AgentWorkspaceBinding) => `project-mind:agent:last-session:${bound.workspaceId}:${scopeKey}`;
  const [initialization, setInitialization] = useState(0);
  const [binding, setBinding] = useState<AgentWorkspaceBinding | null>(null);
  const [settings, setSettings] = useState<AgentScopeSettings | null>(null);
  const [sessions, setSessions] = useState<AgentSessionMetadata[]>([]);
  const [sessionCursor, setSessionCursor] = useState<AgentSessionCursor | null>(null);
  const [session, setSession] = useState<AgentSessionMetadata | null>(null);
  const [messages, setMessages] = useState<AgentConversationMessage[]>([]);
  const [nextOrdinal, setNextOrdinal] = useState<number | null>(null);
  const [run, setRun] = useState<AgentStoredRun | null>(null);
  const [liveText, setLiveText] = useState("");
  const [pendingPrompt, setPendingPrompt] = useState("");
  const [toolActivity, setToolActivity] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [reading, setReading] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [probing, setProbing] = useState(false);
  const [verified, setVerified] = useState(false);
  const [runtimeAvailable, setRuntimeAvailable] = useState(false);
  const epoch = useRef(0);
  const bindingRef = useRef<AgentWorkspaceBinding | null>(null);
  const sessionRef = useRef<AgentSessionMetadata | null>(null);
  const runRef = useRef<AgentStoredRun | null>(null);
  const startingRef = useRef(false);
  const lastSeq = useRef(0);
  const buffered = useRef<AgentRunEvent[]>([]);
  const eventChain = useRef(Promise.resolve());
  const subscribed = useRef<Promise<void>>(Promise.resolve());
  const checksum = useRef<string | null>(null);
  const readVersion = useRef(0);

  const valid = useCallback((token: number, bound: AgentWorkspaceBinding) =>
    epoch.current === token && bindingRef.current !== null && sameBinding(bindingRef.current, bound), []);

  const loadMessages = useCallback(async (bound: AgentWorkspaceBinding, sessionId: string, afterOrdinal: number | null = null) => {
    const token = epoch.current;
    const version = ++readVersion.current;
    setReading(true);
    try {
      const page = await agentApi.sessionGet(bound, { sessionId, afterOrdinal, limit: CONVERSATION_PAGE_SIZE });
      if (!valid(token, bound) || sessionRef.current?.id !== sessionId || version !== readVersion.current) return;
      const latest = page.latestRun;
      if (latest) {
        if (runRef.current?.id !== latest.id) {
          lastSeq.current = 0; setLiveText(""); setPendingPrompt("");
        }
        runRef.current = latest; setRun(latest);
        if (latest.state === "interrupted") setError("运行已中断，已保存的消息仍可阅读；可发送新问题继续。");
        if (latest.state === "failed" && latest.errorCode) setError(agentFailureMessage({ code: latest.errorCode }));
      }
      if (afterOrdinal !== null && checksum.current !== page.checkpoint?.checksum) {
        // A new checkpoint invalidates the previous page cursor. Reconcile through
        // the first bounded page instead of silently joining two history versions.
        const fresh = await agentApi.sessionGet(bound, { sessionId, limit: CONVERSATION_PAGE_SIZE });
        if (!valid(token, bound) || sessionRef.current?.id !== sessionId || version !== readVersion.current) return;
        checksum.current = fresh.checkpoint?.checksum ?? null;
        sessionRef.current = fresh.session; setSession(fresh.session);
        setMessages(fresh.messages); setNextOrdinal(fresh.nextOrdinal);
        setError("会话已有新消息，已刷新。可继续加载后续消息。");
        return;
      }
      checksum.current = page.checkpoint?.checksum ?? null;
      sessionRef.current = page.session; setSession(page.session);
      setMessages(current => afterOrdinal === null ? page.messages
        : [...current, ...page.messages.filter(message => !current.some(existing => existing.id === message.id))]);
      setNextOrdinal(page.nextOrdinal);
      const currentRun = runRef.current;
      if (currentRun && page.messages.some(message => message.runId === currentRun.id && message.role === "assistant")) {
        setLiveText(""); setPendingPrompt("");
      }
    } catch (failure) {
      if (valid(token, bound) && sessionRef.current?.id === sessionId && version === readVersion.current) setError(agentFailureMessage(failure));
    } finally {
      if (valid(token, bound) && version === readVersion.current) setReading(false);
    }
  }, [valid]);

  const applyEvent = useCallback((event: AgentRunEvent) => {
    const bound = bindingRef.current;
    const currentRun = runRef.current;
    if (!bound || !sameBinding(event.binding, bound) || event.sessionId !== sessionRef.current?.id
      || event.runId !== currentRun?.id || event.seq <= lastSeq.current) return;
    lastSeq.current = event.seq;
    const kind = event.event;
    if (kind.type === "text.delta") setLiveText(text => text + kind.data.text);
    if (kind.type === "tool.started") setToolActivity("正在读取资料…");
    if (kind.type === "tool.completed") setToolActivity("");
    const state = kind.type === "run.started" ? "running"
      : kind.type === "run.completed" ? "completed"
      : kind.type === "run.cancelled" ? "cancelled"
      : kind.type === "run.failed" ? "failed" : null;
    if (state) {
      const updated = { ...currentRun, state } satisfies AgentStoredRun;
      runRef.current = updated; setRun(updated);
      if (!activeStates.has(state)) {
        setToolActivity("");
        if (kind.type === "run.failed") setError(agentFailureMessage(kind.data.error));
        void loadMessages(bound, event.sessionId);
      }
    }
  }, [loadMessages]);

  const catchUpEvents = useCallback(async (bound: AgentWorkspaceBinding, runId: string) => {
    const token = epoch.current;
    // The Host retains at most 1000 events; each read remains bounded at 100.
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = await agentApi.runEventsList(bound, { runId, afterSeq: lastSeq.current, limit: 100 });
      if (!valid(token, bound) || runRef.current?.id !== runId) return;
      if (page.firstAvailableSeq !== null && page.firstAvailableSeq > lastSeq.current + 1) {
        lastSeq.current = page.firstAvailableSeq - 1;
        setLiveText("");
        setError("部分实时记录已过期，已保存的会话消息可通过刷新恢复。");
      }
      page.events.forEach(applyEvent);
      if (page.nextSeq === null || !isAgentRunActive(runRef.current)) break;
    }
  }, [applyEvent, valid]);

  const receiveEvent = useCallback((event: AgentRunEvent) => {
    const bound = bindingRef.current;
    if (!bound || !sameBinding(bound, event.binding) || event.sessionId !== sessionRef.current?.id) return;
    if (startingRef.current && !runRef.current) {
      if (buffered.current.length < 1000) buffered.current.push(event);
      return;
    }
    if (runRef.current?.id !== event.runId) return;
    eventChain.current = eventChain.current.then(async () => {
      if (event.seq > lastSeq.current + 1) await catchUpEvents(bound, event.runId);
      applyEvent(event);
    }).catch(failure => {
      if (bindingRef.current && sameBinding(bound, bindingRef.current)
        && event.sessionId === sessionRef.current?.id && event.runId === runRef.current?.id) setError(agentFailureMessage(failure));
    });
  }, [applyEvent, catchUpEvents]);

  useEffect(() => {
    const token = ++epoch.current;
    let unlisten: (() => void) | undefined;
    bindingRef.current = null; sessionRef.current = null; runRef.current = null;
    startingRef.current = false; lastSeq.current = 0; buffered.current = [];
    setBinding(null); setSession(null); setRun(null); setMessages([]);
    setPendingPrompt(""); setLiveText(""); setSettings(null); setSessions([]); setError(null); setLoading(true);
    setVerified(false); setProbing(false); setSavingSettings(false); setReading(false);
    setStarting(false); setRuntimeAvailable(false); setNextOrdinal(null); setSessionCursor(null);
    setToolActivity(""); checksum.current = null; readVersion.current++;
    const initialize = async () => {
      const status = await agentApi.statusGet();
      const bound = workspaceRoot ? await recordDocumentApi.bindingGet(workspaceRoot) : status.binding;
      if (epoch.current !== token) return;
      if (!bound) throw new Error("请先打开工作区。");
      if (!status.binding || !sameBinding(status.binding, bound)) throw new Error("工作区已切换，请重新打开助手。");
      bindingRef.current = bound; setBinding(bound); setRuntimeAvailable(status.runtimeAvailable);
      subscribed.current = agentApi.onRunEvent(receiveEvent).then(stop => {
        if (epoch.current !== token) stop(); else unlisten = stop;
      });
      await subscribed.current;
      const [nextSettings, history] = await Promise.all([
        agentApi.settingsGet(bound, scope), agentApi.sessionsList(bound, { scope, limit: 20 }),
      ]);
      if (!valid(token, bound)) return;
      setSettings(nextSettings); setSessions(history.sessions); setSessionCursor(history.nextCursor);
      const previous = localStorage.getItem(preferenceKey(bound));
      const selected = history.sessions.find(item => item.id === previous);
      if (selected) {
        sessionRef.current = selected; setSession(selected);
        await loadMessages(bound, selected.id);
      }
    };
    void initialize().catch(failure => { if (epoch.current === token) setError(agentFailureMessage(failure)); })
      .finally(() => { if (epoch.current === token) setLoading(false); });
    return () => { epoch.current++; unlisten?.(); };
    // Scope objects are recreated by parent pages; identity is their primitive key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, workspaceRoot, receiveEvent, valid, loadMessages, initialization]);

  useEffect(() => {
    if (!binding || !run || !isAgentRunActive(run)) return;
    let stopped = false;
    let pending = false;
    const bound = binding; const runId = run.id; const token = epoch.current;
    const reconcile = async () => {
      if (pending || stopped) return;
      pending = true;
      try {
        await catchUpEvents(bound, runId);
        const stored = await agentApi.runGet(bound, { runId });
        if (stopped || !valid(token, bound) || runRef.current?.id !== runId) return;
        runRef.current = stored; setRun(stored);
        if (!isAgentRunActive(stored)) {
          setToolActivity("");
          if (stored.state === "interrupted") setError("运行已中断，已保存的消息仍可阅读；可发送新问题继续。");
          if (stored.state === "failed" && stored.errorCode) setError(agentFailureMessage({ code: stored.errorCode }));
          await loadMessages(bound, stored.sessionId);
        }
      } catch (failure) {
        if (!stopped && valid(token, bound)) setError(agentFailureMessage(failure));
      } finally { pending = false; }
    };
    const timer = window.setInterval(() => { void reconcile(); }, 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [binding, run?.id, run?.state, catchUpEvents, loadMessages, valid]);

  const setEnabled = async (enabled: boolean) => {
    if (!binding || !settings || savingSettings) return;
    const token = epoch.current; setSavingSettings(true); setError(null);
    try {
      const saved = await agentApi.settingsUpdate(binding, { settings: { ...settings, enabled }, expectedRevision: settings.revision });
      if (valid(token, binding)) setSettings(saved);
    } catch (failure) { if (valid(token, binding)) setError(agentFailureMessage(failure)); }
    finally { if (valid(token, binding)) setSavingSettings(false); }
  };
  const selectSession = async (id: string) => {
    if (!binding || startingRef.current || isAgentRunActive(runRef.current)) return;
    const selected = sessions.find(item => item.id === id) ?? null;
    readVersion.current++; sessionRef.current = selected; runRef.current = null; lastSeq.current = 0;
    if (selected) localStorage.setItem(preferenceKey(binding), selected.id);
    else localStorage.removeItem(preferenceKey(binding));
    setSession(selected); setRun(null); setMessages([]); setNextOrdinal(null); setReading(false);
    setPendingPrompt(""); setLiveText(""); setError(null); checksum.current = null;
    if (selected) await loadMessages(binding, selected.id);
  };
  const send = async (prompt: string): Promise<boolean> => {
    if (!binding || !settings?.enabled || startingRef.current || isAgentRunActive(runRef.current) || !prompt.trim()) return false;
    const token = epoch.current; const bound = binding;
    startingRef.current = true; setStarting(true); setError(null); setPendingPrompt(prompt.trim());
    setLiveText(""); setToolActivity(""); runRef.current = null; setRun(null); lastSeq.current = 0; buffered.current = [];
    try {
      let selected = sessionRef.current;
      if (!selected) {
        selected = await agentApi.sessionCreate(bound, { scope, title: prompt.trim().slice(0, 60) });
        if (!valid(token, bound)) return false;
        sessionRef.current = selected; setSession(selected); setSessions(history => [selected!, ...history]);
        localStorage.setItem(preferenceKey(bound), selected.id);
      }
      await subscribed.current;
      const started = await agentApi.runStart(bound, { sessionId: selected.id, clientRequestId: crypto.randomUUID(), prompt: prompt.trim() });
      if (!valid(token, bound) || sessionRef.current?.id !== selected.id) return false;
      runRef.current = started; setRun(started);
      const early = buffered.current; buffered.current = []; startingRef.current = false;
      early.forEach(receiveEvent);
      try { await catchUpEvents(bound, started.id); }
      catch (failure) { if (valid(token, bound)) setError(agentFailureMessage(failure)); }
      if (!isAgentRunActive(started)) await loadMessages(bound, selected.id);
      return true;
    } catch (failure) {
      if (valid(token, bound)) { setError(agentFailureMessage(failure)); setPendingPrompt(""); }
      return false;
    } finally {
      if (valid(token, bound)) { startingRef.current = false; setStarting(false); }
    }
  };
  const cancel = async () => {
    if (!binding || !runRef.current || !isAgentRunActive(runRef.current)) return;
    const token = epoch.current;
    try {
      const cancelled = await agentApi.runCancel(binding, { runId: runRef.current.id });
      if (!valid(token, binding)) return;
      runRef.current = cancelled; setRun(cancelled);
      if (!isAgentRunActive(cancelled)) await loadMessages(binding, cancelled.sessionId);
    } catch (failure) { if (valid(token, binding)) setError(agentFailureMessage(failure)); }
  };
  const refresh = async () => {
    if (!binding) { setInitialization(value => value + 1); return; }
    setError(null);
    if (workspaceRoot) {
      try {
        const current = await recordDocumentApi.bindingGet(workspaceRoot);
        if (!sameBinding(current, binding)) { setInitialization(value => value + 1); return; }
      } catch (failure) { setError(agentFailureMessage(failure)); return; }
    }
    if (sessionRef.current) await loadMessages(binding, sessionRef.current.id);
    const token = epoch.current;
    try {
      const [nextSettings, history] = await Promise.all([
        agentApi.settingsGet(binding, scope), agentApi.sessionsList(binding, { scope, limit: 20 }),
      ]);
      if (!valid(token, binding)) return;
      setSettings(nextSettings); setSessions(history.sessions); setSessionCursor(history.nextCursor);
      if (runRef.current) {
        const current = await agentApi.runGet(binding, { runId: runRef.current.id });
        if (valid(token, binding) && current.id === runRef.current?.id) { runRef.current = current; setRun(current); }
      }
    } catch (failure) { if (valid(token, binding)) setError(agentFailureMessage(failure)); }
  };
  const moreSessions = async () => {
    if (!binding || !sessionCursor) return;
    const token = epoch.current;
    try {
      const page = await agentApi.sessionsList(binding, { scope, cursor: sessionCursor, limit: 20 });
      if (!valid(token, binding)) return;
      setSessions(current => [...current, ...page.sessions.filter(item => !current.some(existing => existing.id === item.id))]);
      setSessionCursor(page.nextCursor);
    } catch (failure) { if (valid(token, binding)) setError(agentFailureMessage(failure)); }
  };
  const probe = async () => {
    if (!binding || probing || isAgentRunActive(runRef.current)) return;
    const token = epoch.current; setProbing(true); setVerified(false); setError(null);
    try {
      const result = await agentApi.profileProbe(binding);
      if (valid(token, binding)) setVerified(result.verified);
    } catch (failure) { if (valid(token, binding)) setError(agentFailureMessage(failure)); }
    finally { if (valid(token, binding)) setProbing(false); }
  };
  return {
    binding, settings, sessions, sessionCursor, session, messages, nextOrdinal, run, liveText,
    pendingPrompt, toolActivity, error, loading, starting, reading, savingSettings, probing, verified,
    runtimeAvailable, busy: starting || isAgentRunActive(run), setEnabled, selectSession, send, cancel,
    refresh, moreSessions, probe, loadMore: () => binding && session && nextOrdinal !== null
      ? loadMessages(binding, session.id, nextOrdinal) : Promise.resolve(),
  };
}
