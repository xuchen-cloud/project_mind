import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RefreshCw, Send, Square } from "lucide-react";
import type { AgentScope } from "../../lib/agent-types";
import { bindingForCapability, findAiProfile } from "../../lib/ai";
import { queryKeys } from "../../lib/queryKeys";
import { projectMindApi } from "../../services/projectMindApi";
import { useUiStore } from "../../state/ui-store";
import { Button, Dialog } from "../../ui/components";
import { HomeSidebarList } from "../home/HomeSidebarList";
import { AgentMessage } from "./AgentMessage";
import { AgentKnowledgePanel } from "./AgentKnowledgePanel";
import { useAgentConversation } from "./useAgentConversation";
import "../home/home.css";
import "./agent.css";

export function AgentPanel({ open, onClose, scope, workspaceRoot }: {
  open: boolean; onClose: () => void; scope: AgentScope; workspaceRoot?: string;
}) {
  const conversation = useAgentConversation(scope, workspaceRoot);
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<"conversation" | "knowledge">("conversation");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const verificationProfile = useRef<string | null>(null);
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
    if (!viewport || !open || tab !== "conversation") return;
    const changed = () => { stickToBottom.current = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 64; };
    viewport.addEventListener("scroll", changed);
    return () => viewport.removeEventListener("scroll", changed);
  }, [open, tab]);
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (viewport && stickToBottom.current) viewport.scrollTop = viewport.scrollHeight;
  }, [conversation.messages, conversation.liveText, conversation.pendingPrompt, open]);

  const send = async () => {
    if (!ready || conversation.busy || conversation.probing || !draft.trim() || byteLength > 65536) return;
    const submitted = draft;
    if (await conversation.send(submitted)) setDraft(current => current === submitted ? "" : current);
  };
  const currentUserPersisted = !!conversation.run && conversation.messages.some(message => message.runId === conversation.run?.id && message.role === "user");

  return <Dialog open={open} onClose={onClose} title={scope.kind === "project" ? "项目助手" : "工作区助手"}
    description="当前支持问答和资料读取，创建或修改成果尚未接入。"
    widthClassName="agent-panel-surface" bodyClassName="agent-panel-body" positionClassName="agent-panel-position">
    <div className="agent-panel">
      <div className="agent-panel__settings">
        <div className="agent-panel__setting-row">
          <label className="agent-panel__enable"><input type="checkbox" checked={conversation.settings?.enabled ?? false}
            disabled={conversation.loading || conversation.savingSettings || conversation.busy}
            onChange={event => void conversation.setEnabled(event.target.checked)} />
            启用{scope.kind === "project" ? "本项目" : "工作区"}助手</label>
          <Button size="sm" variant="ghost" onClick={() => { onClose(); openSettings("ai-models"); }}>模型设置</Button>
        </div>
        <p className="agent-panel__hint">{profile ? `通用模型：${profile.name}${model ? ` · ${model}` : ""}` : "尚未配置通用模型"}</p>
        <div className="agent-panel__setting-row">
          <Button size="sm" disabled={!conversation.binding || !modelReady || !conversation.runtimeAvailable || conversation.busy || conversation.probing}
            onClick={() => { verificationProfile.current = modelIdentity; void conversation.probe(); }}>{conversation.probing ? "正在验证…" : "验证工具能力"}</Button>
          <span className="agent-panel__hint">{conversation.verified && verificationProfile.current === modelIdentity ? "工具能力已验证" : "验证会请求一次模型"}</span>
        </div>
        {!conversation.loading && !conversation.runtimeAvailable ? <p className="agent-panel__hint" role="status">内置助手运行资源不可用，请检查应用安装。</p> : null}
      </div>
      <div className="agent-panel__tabs" role="tablist" aria-label="助手内容">
        <Button size="sm" variant={tab === "conversation" ? "secondary" : "ghost"} role="tab" aria-selected={tab === "conversation"}
          onClick={() => setTab("conversation")}>会话</Button>
        <Button size="sm" variant={tab === "knowledge" ? "secondary" : "ghost"} role="tab" aria-selected={tab === "knowledge"}
          disabled={!conversation.binding || conversation.busy} onClick={() => setTab("knowledge")}>知识</Button>
      </div>
      {conversation.error ? <div className="agent-panel__error" role="alert"><p>{conversation.error}</p>
        <Button size="sm" variant="ghost" onClick={() => void conversation.refresh()}>刷新重试</Button></div> : null}
      {tab === "knowledge" && conversation.binding ? <div className="agent-panel__knowledge"><HomeSidebarList label="知识与资料状态"><AgentKnowledgePanel binding={conversation.binding} scope={scope} /></HomeSidebarList></div> : <>
        <div className="agent-panel__history">
          <label className="agent-panel__history-label">历史会话<select aria-label="历史会话" value={conversation.session?.id ?? ""}
            disabled={conversation.loading || conversation.busy || conversation.reading}
            onChange={event => { stickToBottom.current = true; void conversation.selectSession(event.target.value); }}>
            <option value="">新会话</option>
            {conversation.sessions.map(session => <option value={session.id} key={session.id}>{session.title}{session.state === "archived" ? "（已归档）" : session.state === "read_only" ? "（只读）" : ""}</option>)}
          </select></label>
          <Button size="sm" disabled={conversation.busy || !conversation.session} onClick={() => { setDraft(""); void conversation.selectSession(""); }}>新会话</Button>
          <Button size="sm" variant="ghost" aria-label="刷新会话" leadingIcon={<RefreshCw size={14} />} disabled={conversation.reading}
            onClick={() => void conversation.refresh()}>刷新</Button>
          {conversation.sessionCursor ? <Button size="sm" variant="ghost" onClick={() => void conversation.moreSessions()}>更多会话</Button> : null}
        </div>
        <HomeSidebarList label="助手消息" scrollRef={scrollRef}>
          {conversation.loading ? <p className="agent-panel__empty" role="status">正在加载助手…</p> : null}
          {!conversation.loading && !conversation.messages.length && !conversation.pendingPrompt ? <p className="agent-panel__empty">
            {conversation.settings?.enabled ? "问一个与当前工作有关的问题，助手会按需读取资料。" : "启用助手并配置通用模型后，可以开始提问。"}</p> : null}
          {conversation.binding ? conversation.messages.map(message => <AgentMessage key={message.id} message={message} binding={conversation.binding!} />) : null}
          {conversation.nextOrdinal !== null ? <Button size="sm" variant="ghost" disabled={conversation.reading} onClick={() => { stickToBottom.current = false; void conversation.loadMore(); }}>
            {conversation.reading ? "加载中…" : "加载后续消息"}</Button> : null}
          {conversation.pendingPrompt && !currentUserPersisted ? <article className="agent-message agent-message--user"><div className="agent-message__label">你</div><p className="agent-message__text">{conversation.pendingPrompt}</p></article> : null}
          {conversation.liveText ? <article className="agent-message agent-message--assistant"><div className="agent-message__label">助手</div><p className="agent-message__text">{conversation.liveText}</p></article> : null}
          {conversation.toolActivity ? <p className="agent-panel__hint" role="status">{conversation.toolActivity}</p> : null}
          {conversation.busy && !conversation.liveText && !conversation.toolActivity ? <p className="agent-panel__hint" role="status">{conversation.run?.state === "cancelling" ? "正在停止…" : "正在思考…"}</p> : null}
          {conversation.run?.state === "cancelled" ? <p className="agent-panel__hint" role="status">已停止。已保存的消息仍可继续阅读。</p> : null}
          {conversation.run?.state === "interrupted" ? <p className="agent-panel__hint" role="status">运行已中断，可发送新问题继续。</p> : null}
        </HomeSidebarList>
        {blockedSession ? <p className="agent-panel__hint">{conversation.session?.state === "archived" ? "该会话已归档，请新建会话。" : "会话历史校验未通过，已保留历史并停止继续运行。"}</p> : null}
        <form className="agent-panel__composer" onSubmit={event => { event.preventDefault(); void send(); }}>
          <label htmlFor={`agent-question-${scope.kind === "project" ? scope.projectId : "workspace"}`} className="agent-panel__hint">问题</label>
          <textarea id={`agent-question-${scope.kind === "project" ? scope.projectId : "workspace"}`} value={draft} onChange={event => setDraft(event.target.value)}
            disabled={conversation.busy || !ready || conversation.probing} placeholder="向助手提问…" rows={3}
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
          <div className="agent-panel__composer-actions"><span className="agent-panel__hint">{byteLength > 65536 ? "问题超过长度上限，请缩短后发送。" : "Enter 发送，Shift + Enter 换行"}</span>
            {conversation.busy ? <Button type="button" size="sm" leadingIcon={<Square size={13} />} disabled={conversation.starting || conversation.run?.state === "cancelling"} onClick={() => void conversation.cancel()}>停止</Button>
              : <Button type="submit" size="sm" variant="primary" leadingIcon={<Send size={14} />} disabled={!ready || conversation.probing || !draft.trim() || byteLength > 65536}>发送</Button>}
          </div>
        </form>
      </>}
    </div>
  </Dialog>;
}
