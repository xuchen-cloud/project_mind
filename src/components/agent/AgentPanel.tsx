import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { RefreshCw, Send, Square, X, Maximize2, Minimize2 } from "lucide-react";
import type { AgentReviewHandle } from "../../hooks/useAgentReviewPlan";
import type { AgentScope } from "../../lib/agent-types";
import { bindingForCapability, findAiProfile } from "../../lib/ai";
import { queryKeys } from "../../lib/queryKeys";
import { projectMindApi } from "../../services/projectMindApi";
import { sameAgentScope, useAgentPanelStore } from "../../state/agent-panel-store";
import { useUiStore } from "../../state/ui-store";
import { Button } from "../../ui/components";
import { HomeSidebarList } from "../home/HomeSidebarList";
import { AgentPiMessages } from "./AgentPiMessages";
import { AgentKnowledgePanel } from "./AgentKnowledgePanel";
import { AgentHistorySearch } from "./AgentHistorySearch";
import { AgentRunOutputs } from "./AgentRunOutputs";
import { agentFailureMessage, useAgentConversation } from "./useAgentConversation";
import "../home/home.css";
import "./agent.css";

export function AgentPanel({ open, onClose, scope, workspaceRoot, scopeName, expanded = false, onToggleExpanded }: {
  open: boolean; onClose: () => void; scope: AgentScope; workspaceRoot?: string;
  scopeName?: string; expanded?: boolean; onToggleExpanded?: () => void;
}) {
  const conversation = useAgentConversation(scope, workspaceRoot);
  const [draft, setDraft] = useState("");
  const [review, setReview] = useState<AgentReviewHandle | null>(null);
  const [decisionPending, setDecisionPending] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const decisionInFlight = useRef(false);
  const currentReview = review?.runId === conversation.run?.id ? review : null;
  const busy = conversation.busy || !!currentReview?.busy || decisionPending;
  const onReviewChange = useCallback((handle: AgentReviewHandle | null) => {
    if (handle && handle.runId !== conversation.run?.id) return;
    setReview(handle);
  }, [conversation.run?.id]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const closedScrollTop = useRef<number | null>(null);
  const verificationProfile = useRef<string | null>(null);
  const discussionTarget = useAgentPanelStore(state => state.discussionTarget);
  const clearDiscussionTarget = useAgentPanelStore(state => state.clearDiscussionTarget);
  const discussion = discussionTarget && conversation.binding
    && discussionTarget.binding.workspaceId === conversation.binding.workspaceId
    && discussionTarget.binding.generation === conversation.binding.generation
    && sameAgentScope(discussionTarget.object.scope, scope) ? discussionTarget : null;
  const openSettings = useUiStore(state => state.openSettings);
  const aiSettings = useQuery({ queryKey: queryKeys.aiSettings, queryFn: projectMindApi.aiSettingsGet, enabled: open });
  const general = aiSettings.data ? bindingForCapability(aiSettings.data, "default") : null;
  const profile = aiSettings.data ? findAiProfile(aiSettings.data.profiles, general?.profileId) : null;
  const model = general?.model || profile?.defaultModel;
  const modelIdentity = JSON.stringify([profile?.id, profile?.updatedAt, model]);
  const modelReady = !!profile?.enabled && profile.hasStoredKey && profile.supportsText && aiSettings.data?.aiSecretsUnlocked !== false;
  const blockedSession = !!conversation.session && conversation.session.state !== "active";
  const ready = conversation.settings?.enabled && conversation.binding && conversation.runtimeAvailable && modelReady && !blockedSession;
  const byteLength = new TextEncoder().encode(draft).byteLength;

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport || !open) return;
    let previousTop = viewport.scrollTop;
    const changed = () => {
      const top = viewport.scrollTop;
      const atBottom = viewport.scrollHeight - viewport.clientHeight - top < 64;
      // Async Pi/Markdown layout can grow between a programmatic scroll and
      // its event. Only moving up leaves follow mode; reaching bottom resumes it.
      if (top < previousTop || atBottom) stickToBottom.current = atBottom;
      previousTop = top;
    };
    viewport.addEventListener("scroll", changed);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      if (stickToBottom.current) viewport.scrollTop = viewport.scrollHeight;
    });
    observer?.observe(viewport);
    if (viewport.firstElementChild) observer?.observe(viewport.firstElementChild);
    return () => { viewport.removeEventListener("scroll", changed); observer?.disconnect(); };
  }, [open]);
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    if (!open) { closedScrollTop.current = viewport.scrollTop; return; }
    if (closedScrollTop.current !== null) {
      viewport.scrollTop = closedScrollTop.current;
      closedScrollTop.current = null;
    } else if (stickToBottom.current) viewport.scrollTop = viewport.scrollHeight;
  }, [conversation.messages, conversation.liveText, conversation.pendingPrompt, open]);

  const decisionText = draft.trim().replace(/[。.!！]+$/u, "").trim();
  const reviewDecision = ["确认", "确认执行", "同意执行", "执行吧"].includes(decisionText) ? "confirm"
    : ["取消", "取消执行", "不用了"].includes(decisionText) ? "cancel" : null;
  const sendsDecision = !!reviewDecision && !!currentReview?.pending.length;
  const canSend = !busy && !conversation.probing && !!draft.trim() && byteLength <= 65536 && !blockedSession && (sendsDecision || !!ready);
  const send = async () => {
    if (!canSend || decisionInFlight.current) return;
    const submitted = draft;
    if (sendsDecision && currentReview && reviewDecision) {
      decisionInFlight.current = true; setDecisionPending(true); setDecisionError(null);
      try {
        await currentReview.decide(reviewDecision, submitted);
        setDraft(current => current === submitted ? "" : current);
      } catch (failure) { setDecisionError(agentFailureMessage(failure)); }
      finally { decisionInFlight.current = false; setDecisionPending(false); }
      return;
    }
    setDecisionError(null);
    if (await (discussion ? conversation.send(submitted, discussion.object) : conversation.send(submitted))) setDraft(current => current === submitted ? "" : current);
  };
  const stop = async () => {
    if (currentReview?.busy || decisionInFlight.current) {
      try { await currentReview?.stop(); }
      catch (failure) { setDecisionError(agentFailureMessage(failure)); }
    } else await conversation.cancel();
  };
  const currentUserPersisted = !!conversation.run && conversation.messages.some(message => message.runId === conversation.run?.id && message.role === "user");
  const currentRunHasMessages = !!conversation.run && conversation.messages.some(message => message.runId === conversation.run?.id);
  const renderRunControls = (runId: string | null) => {
    const current = runId === (conversation.run?.id ?? null);
    return <>
      {current && conversation.toolActivity ? <p className="agent-panel__hint" role="status">{conversation.toolActivity}</p> : null}
      {current && conversation.busy && !conversation.liveText && !conversation.toolActivity ? <p className="agent-panel__hint" role="status">{conversation.run?.state === "cancelling" ? "正在停止…" : "正在思考…"}</p> : null}
      {current && conversation.run?.state === "cancelled" ? <p className="agent-panel__hint" role="status">已停止。已保存的消息仍可继续阅读。</p> : null}
      {current && conversation.run?.state === "interrupted" ? <p className="agent-panel__hint" role="status">运行已中断，可发送新问题继续。</p> : null}
      {conversation.binding && runId ? <AgentRunOutputs binding={conversation.binding} runId={runId}
        active={current && conversation.busy} current={current} onReviewChange={current ? onReviewChange : undefined} /> : null}
    </>;
  };

  return <section className="agent-panel" hidden={!open} aria-label="助手面板">
      <header className="agent-panel__header">
        <div className="agent-panel__titles"><span className="agent-panel__scope">{scopeName ?? (scope.kind === "project" ? "项目助手" : "工作区助手")}</span>
          <h2>{conversation.session?.title ?? "新会话"}</h2></div>
        <div className="agent-panel__header-actions">
          {onToggleExpanded ? <Button size="sm" variant="ghost" aria-label={expanded ? "收起助手" : "展开助手"}
            leadingIcon={expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />} onClick={onToggleExpanded} /> : null}
          <Button size="sm" variant="ghost" aria-label="关闭助手" leadingIcon={<X size={15} />} onClick={onClose} />
        </div>
      </header>
      <div className="agent-panel__toolbar">
        <Button size="sm" variant="ghost" aria-expanded={historyOpen} onClick={() => setHistoryOpen(value => !value)}>历史</Button>
        <Button size="sm" variant="ghost" disabled={busy || !conversation.session}
          onClick={() => { setDraft(""); setHistoryOpen(false); stickToBottom.current = true; void conversation.selectSession(""); }}>新会话</Button>
        <Button size="sm" variant="ghost" aria-expanded={moreOpen} onClick={() => setMoreOpen(value => !value)}>更多</Button>
      </div>
      {historyOpen ? <div className="agent-panel__history">
        <HomeSidebarList label="历史会话">
          <AgentHistorySearch key={JSON.stringify([conversation.binding, scope])} binding={conversation.binding} scope={scope}
            busySession={conversation.loading || busy || conversation.reading}
            onOpenSession={id => { stickToBottom.current = true; setHistoryOpen(false); void conversation.selectSession(id); }}>
          {conversation.sessions.map(session => <Button key={session.id} size="sm" variant={conversation.session?.id === session.id ? "secondary" : "ghost"}
            disabled={conversation.loading || busy || conversation.reading}
            onClick={() => { stickToBottom.current = true; setHistoryOpen(false); void conversation.selectSession(session.id); }}>
            {session.title}{session.state === "archived" ? "（已归档）" : session.state === "read_only" ? "（只读）" : ""}</Button>)}
          {!conversation.sessions.length ? <p className="agent-panel__hint">暂无历史会话</p> : null}
          {conversation.sessionCursor ? <Button size="sm" variant="ghost" disabled={conversation.reading} onClick={() => void conversation.moreSessions()}>更多会话</Button> : null}
          </AgentHistorySearch>
        </HomeSidebarList>
        <Button size="sm" variant="ghost" aria-label="刷新会话" leadingIcon={<RefreshCw size={14} />} disabled={conversation.reading}
          onClick={() => void conversation.refresh()}>刷新</Button>
      </div> : null}
      {moreOpen ? <div className="agent-panel__more"><HomeSidebarList label="助手更多设置">
      <div className="agent-panel__settings">
        <div className="agent-panel__setting-row">
          <label className="agent-panel__enable"><input type="checkbox" checked={conversation.settings?.enabled ?? false}
            disabled={conversation.loading || conversation.savingSettings || busy}
            onChange={event => void conversation.setEnabled(event.target.checked)} />
            启用{scope.kind === "project" ? "本项目" : "工作区"}助手</label>
          <Button size="sm" variant="ghost" onClick={() => openSettings("ai-models")}>模型设置</Button>
        </div>
        <p className="agent-panel__hint">{profile ? `通用模型：${profile.name}${model ? ` · ${model}` : ""}` : "尚未配置通用模型"}</p>
        <div className="agent-panel__setting-row">
          <Button size="sm" disabled={!conversation.binding || !modelReady || !conversation.runtimeAvailable || busy || conversation.probing}
            onClick={() => { verificationProfile.current = modelIdentity; void conversation.probe(); }}>{conversation.probing ? "正在验证…" : "验证工具能力"}</Button>
          <span className="agent-panel__hint">{conversation.verified && verificationProfile.current === modelIdentity ? "工具能力已验证" : "验证会请求一次模型"}</span>
        </div>
        {!conversation.loading && !conversation.runtimeAvailable ? <p className="agent-panel__hint" role="status">内置助手运行资源不可用，请检查应用安装。</p> : null}
      </div>
      <Button size="sm" variant="ghost" aria-expanded={knowledgeOpen} disabled={!conversation.binding || busy}
        onClick={() => setKnowledgeOpen(value => !value)}>知识</Button>
      {knowledgeOpen && conversation.binding ? <div className="agent-panel__knowledge"><HomeSidebarList label="知识与资料状态"><AgentKnowledgePanel binding={conversation.binding} scope={scope} /></HomeSidebarList></div> : null}
      </HomeSidebarList></div> : null}
      {decisionError || conversation.error ? <div className="agent-panel__error" role="alert"><p>{decisionError || conversation.error}</p>
        <Button size="sm" variant="ghost" onClick={() => { setDecisionError(null); void conversation.refresh(); }}>刷新重试</Button></div> : null}
        <HomeSidebarList label="助手消息" scrollRef={scrollRef}>
          {conversation.loading ? <p className="agent-panel__empty" role="status">正在加载助手…</p> : null}
          {!conversation.loading && !conversation.messages.length && !conversation.pendingPrompt ? <p className="agent-panel__empty">
            {conversation.settings?.enabled ? "问一个与当前工作有关的问题，助手会按需读取资料。" : "启用助手并配置通用模型后，可以开始提问。"}</p> : null}
          {conversation.binding ? <AgentPiMessages messages={conversation.messages} binding={conversation.binding}
            liveText={conversation.liveText} isStreaming={conversation.busy} streamRunId={conversation.run?.id ?? null}
            renderBeforeStream={() => conversation.pendingPrompt && !currentUserPersisted ? <article className="agent-message agent-message--user" aria-label="正在提交的问题"><div className="agent-message__label">你</div><p className="agent-message__text">{conversation.pendingPrompt}</p></article> : null}
            renderAfterRun={renderRunControls} /> : null}
          {conversation.nextOrdinal !== null ? <Button size="sm" variant="ghost" disabled={conversation.reading} onClick={() => { stickToBottom.current = false; void conversation.loadMore(); }}>
            {conversation.reading ? "加载中…" : "加载后续消息"}</Button> : null}
          {conversation.run && !currentRunHasMessages && !conversation.busy && !conversation.liveText ? renderRunControls(conversation.run.id) : null}
        </HomeSidebarList>
        {blockedSession ? <p className="agent-panel__hint">{conversation.session?.state === "archived" ? "该会话已归档，请新建会话。" : "会话历史校验未通过，已保留历史并停止继续运行。"}</p> : null}
        {currentReview?.pending.length && !currentReview.busy ? <p className="agent-panel__review-hint">{currentReview.confirmed ? "保存未完成，可输入“确认”重试或“取消”剩余项。" : "输入“确认”执行当前方案，输入“取消”放弃，或补充新的要求。"}</p> : null}
        <form className="agent-panel__composer" onSubmit={event => { event.preventDefault(); void send(); }}>
          {discussion ? <div className="agent-panel__discussion-target"><span>讨论：{discussion.label}</span>
            <Button size="sm" variant="ghost" type="button" aria-label="移除讨论对象" leadingIcon={<X size={13} />} onClick={clearDiscussionTarget} /></div> : null}
          <label htmlFor={`agent-question-${scope.kind === "project" ? scope.projectId : "workspace"}`} className="agent-panel__hint">问题</label>
          <textarea id={`agent-question-${scope.kind === "project" ? scope.projectId : "workspace"}`} value={draft} onChange={event => setDraft(event.target.value)}
            disabled={blockedSession} placeholder="向助手提问…" rows={3}
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
          <div className="agent-panel__composer-options">
            <span className="agent-panel__model" title={profile ? `${profile.name} · ${model ?? ""}` : "尚未配置通用模型"}>{model ?? "未配置模型"}</span>
            <label className="agent-panel__mode"><span className="sr-only">执行模式</span><select aria-label="执行模式" value={conversation.settings?.executionMode ?? "review"}
              disabled={!conversation.settings || conversation.loading || conversation.savingSettings || busy}
              onChange={event => void conversation.setMode(event.target.value as "collaborate" | "review" | "read_only")}>
              <option value="read_only">仅讨论</option><option value="review">确认后执行</option><option value="collaborate">自动执行</option>
            </select></label>
          </div>
          <div className="agent-panel__composer-actions"><span className="agent-panel__hint">{byteLength > 65536 ? "问题超过长度上限，请缩短后发送。" : "Enter 发送，Shift + Enter 换行"}</span>
            {busy ? <><Button type="button" size="sm" leadingIcon={<Square size={13} />} disabled={conversation.starting || conversation.run?.state === "cancelling"} onClick={() => void stop()}>停止</Button><Button type="submit" size="sm" disabled>发送</Button></>
              : <Button type="submit" size="sm" variant="primary" leadingIcon={<Send size={14} />} disabled={!canSend}>发送</Button>}
          </div>
        </form>
  </section>;
}
