import type { AgentSourceRef } from '../../lib/agent-types';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DshConversationHost, insertDshFileReference } from "@project-mind/dsh-ui/adapters";
import { ChevronDown, Maximize2, Minimize2, Plus, Trash2, X } from "lucide-react";
import { consumeDshFileReference, useDshFileReferences } from "../../lib/dsh-host-events";
import { useFeedbackStore } from "../../state/feedback-store";
import { getErrorMessage } from "../../lib/errors";
import { notifyProjectFilesChanged, openProjectFilePreview } from "../../lib/project-file-navigation";
import { queryKeys } from "../../lib/queryKeys";
import type { AiSettingsSnapshot } from "../../lib/types";
import { dshAssistantApi } from "../../services/dshAssistantApi";
import { useUiStore } from "../../state/ui-store";
import { dshProjectRunKey, useAgentPanelStore } from "../../state/agent-panel-store";
import { Button } from "../../ui/components/Button";
import { PopoverPanel } from "../../ui/components/PopoverPanel";
import { HomeSidebarList } from "../home/HomeSidebarList";
import "../home/home.css";
import "./dsh-assistant.css";

type Session = { id: string; title: string; running?: boolean };

export function DshAssistantPanel({ open, expanded, workspaceRoot, projectId, onToggleExpanded, onClose, onOpenSession }: {
  open: boolean; expanded: boolean; workspaceRoot?: string; projectId: number;
  onToggleExpanded: () => void; onClose: () => void;
  onOpenSession?: (sessionId: string, title: string) => void;
}) {
  const [referenceRevision, setReferenceRevision] = useState(0);
  const [syncedKey, setSyncedKey] = useState<string | null>(null);
  const [hostReady, setHostReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [deleting, setDeleting] = useState<Session | null>(null);
  const pendingReference = useDshFileReferences(state => state.pending.find(value => value.workspaceRoot === workspaceRoot && value.projectId === projectId && (value.sessionId === undefined || value.sessionId === selectedSession?.id)));
  const inserting = useRef<number | null>(null);
  const sessionMenu = useRef<HTMLDivElement>(null);
  const operation = useRef(false);
  const alive = useRef(true);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const openSettings = useUiStore(state => state.openSettings);
  const settingsOpen = useUiStore(state => state.settingsOpen);
  const previousSettingsOpen = useRef(settingsOpen);
  const settingsRecheck = useRef(false);
  const discussionTarget = useAgentPanelStore(state => state.discussionTarget);
  const clearDiscussionTarget = useAgentPanelStore(state => state.clearDiscussionTarget);
  const runBusy = useAgentPanelStore(state => workspaceRoot !== undefined && !!state.runsByProject[dshProjectRunKey(workspaceRoot, projectId)]);
  const queryClient = useQueryClient();
  const subscribe = useCallback((notify: () => void) => queryClient.getQueryCache().subscribe(event => {
    if (event.query.queryKey[0] === queryKeys.aiSettings[0]) notify();
  }), [queryClient]);
  const snapshot = useCallback(() => {
    const settings = queryClient.getQueryData<AiSettingsSnapshot>(queryKeys.aiSettings);
    const binding = settings?.bindings.find(value => value.capability === "default");
    return JSON.stringify([binding, settings?.profiles.find(value => value.id === binding?.profileId),
      settings?.aiSecretsUnlocked, settings?.securityMode, settings?.network]);
  }, [queryClient]);
  const fingerprint = useSyncExternalStore(subscribe, snapshot);
  const syncKey = JSON.stringify([workspaceRoot, projectId, fingerprint, attempt]);
  // A configuration refresh waits until the active run finishes. Keep the
  // original Host subscribed and available to stop while its panel is hidden.
  const ready = syncedKey !== null && (syncedKey === syncKey || runBusy);
  const identity = JSON.stringify([workspaceRoot, projectId, syncedKey]);
  const current = useRef(identity);
  current.current = identity;
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    setSelectedSession(null); setSessions([]); setDeleting(null); setSessionsOpen(false); setSessionBusy(false);
  }, [workspaceRoot, projectId]);

  useEffect(() => {
    if (!open || (!onOpenSession && runBusy) || syncedKey === syncKey) return;
    let cancelled = false;
    setSyncedKey(null); setHostReady(false); setError(null); setSessionBusy(false);
    void (async () => {
      await dshAssistantApi.start(syncKey, projectId);
      if (cancelled) return;
      const saved = await dshAssistantApi.sessions(projectId);
      if (cancelled) return;
      if (onOpenSession) {
        setSessions(saved); setSyncedKey(syncKey); setHostReady(true);
        if (workspaceRoot) useAgentPanelStore.getState().setRunBusy(workspaceRoot, projectId, saved.some(session => session.running));
        return;
      }
      const previous = saved.find(session => session.id === selectedSession?.id) ?? saved[0];
      const id = await dshAssistantApi.selectSession(previous?.id ?? null, projectId);
      if (cancelled) return;
      setSelectedSession({ id, title: previous?.title || "新会话" });
      setSyncedKey(syncKey);
      if (workspaceRoot) useAgentPanelStore.getState().setRunBusy(workspaceRoot, projectId, saved.some(session => session.running));
    })().catch(reason => { if (!cancelled) setError(getErrorMessage(reason, "DSH 助手启动失败")); });
    return () => { cancelled = true; };
  }, [open, runBusy, syncKey, projectId]);

  useEffect(() => {
    if (previousSettingsOpen.current && !settingsOpen) settingsRecheck.current = true;
    previousSettingsOpen.current = settingsOpen;
    if (!settingsRecheck.current || !open || !ready || runBusy) return;
    settingsRecheck.current = false;
    void dshAssistantApi.start(syncKey, projectId).catch(reason => {
      if (alive.current && current.current === identity)
        setError(getErrorMessage(reason, "主模型配置复核失败"));
    });
  }, [settingsOpen, open, ready, runBusy, syncKey, projectId, identity]);

  const callbacks = useMemo(() => {
    const valid = () => alive.current && current.current === identity;
    return {
      onReady: () => { if (valid()) setHostReady(true); },
      onError: (message: string) => { if (valid()) setError(message); },
      onSessionChange: (id: string) => {
        if (!valid()) return;
        setSelectedSession(previous => previous?.id === id ? previous : sessionsRef.current.find(value => value.id === id) ?? { id, title: "会话" });
      },
      onBusyChange: (busy: boolean) => {
        if (valid() && workspaceRoot) useAgentPanelStore.getState().setRunBusy(workspaceRoot, projectId, busy);
      },
      onSettings: () => { if (valid()) openSettings("dsh-assistant"); },
      onFileOpen: (path: string, line?: number, sourceRef?: AgentSourceRef) => { if (valid()) openProjectFilePreview(projectId, path, line, selectedSession?.id, sourceRef); },
      onFilesChanged: () => {
        if (!valid()) return;
        notifyProjectFilesChanged(projectId);
        void queryClient.invalidateQueries({ queryKey: queryKeys.projectPage(projectId) });
      },
    };
  }, [identity, projectId, workspaceRoot, openSettings, queryClient, selectedSession?.id]);

  useEffect(() => {
    if (!open || !ready || !hostReady || error) { setSessionsOpen(false); return; }
    if (!sessionsOpen) return;
    let cancelled = false;
    setSessionsLoading(true);
    void dshAssistantApi.sessions(projectId).then(value => {
      if (!cancelled) {
        setSessions(value); setSessionsLoading(false);
        if (workspaceRoot) useAgentPanelStore.getState().setRunBusy(workspaceRoot, projectId, value.some(session => session.running));
      }
    }, reason => {
      if (!cancelled) { setError(getErrorMessage(reason, "读取项目会话失败")); setSessionsOpen(false); setSessionsLoading(false); }
    });
    const outside = (event: PointerEvent) => { if (!sessionMenu.current?.contains(event.target as Node)) setSessionsOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setSessionsOpen(false); };
    window.addEventListener("pointerdown", outside); window.addEventListener("keydown", escape);
    return () => { cancelled = true; window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); };
  }, [open, ready, hostReady, error, sessionsOpen, identity, projectId]);

  useEffect(() => {
    if (onOpenSession || !open || !ready || !hostReady || !selectedSession?.id || sessionBusy || error || !pendingReference || inserting.current !== null) return;
    const reference = pendingReference;
    inserting.current = reference.id;
    // Claim once before async I/O; StrictMode or another render cannot insert twice.
    consumeDshFileReference(reference.id);
    void insertDshFileReference(projectId, selectedSession.id, reference.path, reference.sourceRef).catch(reason => {
      if (alive.current && current.current === identity)
        useFeedbackStore.getState().pushToast({ tone: "error", title: "引用文件失败", detail: getErrorMessage(reason, "请重新引用该文件") });
    }).finally(() => {
      inserting.current = null;
      if (alive.current && current.current === identity) setReferenceRevision(value => value + 1);
    });
  }, [open, ready, hostReady, selectedSession?.id, sessionBusy, error, pendingReference, projectId, identity, referenceRevision]);

  const operate = async (session: Session | null, remove = false) => {
    if (!open || !ready || !hostReady || error || operation.current || (!onOpenSession && runBusy) || (remove && session?.running)) return;
    operation.current = true; setSessionBusy(true);
    try {
      if (remove && session) {
        await dshAssistantApi.deleteSession(session.id, projectId);
        if (!alive.current || current.current !== identity) return;
        setSessions(values => values.filter(value => value.id !== session.id));
        if (!onOpenSession && selectedSession?.id === session.id) {
          const next = sessions.find(value => value.id !== session.id);
          const id = await dshAssistantApi.selectSession(next?.id ?? null, projectId);
          if (!alive.current || current.current !== identity) return;
          setSelectedSession({ id, title: next?.title || "新会话" });
        }
        setDeleting(null);
      } else {
        const id = await dshAssistantApi.selectSession(session?.id ?? null, projectId);
        if (!alive.current || current.current !== identity) return;
        if (onOpenSession) onOpenSession(id, session?.title || "新会话");
        else setSelectedSession({ id, title: session?.title || "新会话" });
        setSessionsOpen(false);
      }
    } catch (reason) {
      if (alive.current && current.current === identity) { setError(getErrorMessage(reason, remove ? "删除项目会话失败" : "切换项目会话失败")); setSessionsOpen(false); }
    } finally {
      operation.current = false;
      if (alive.current && current.current === identity) setSessionBusy(false);
    }
  };
  const disabled = !open || !ready || !hostReady || !!error || sessionBusy;

  return <section className="dsh-assistant" hidden={!open} aria-label="DSH 助手面板">
    <header className="dsh-assistant__header"><h2>DSH 助手</h2><div className="dsh-assistant__actions">
      <div ref={sessionMenu} className="dsh-assistant__session-menu">
        <Button size="sm" variant="ghost" aria-label="项目会话" aria-haspopup="dialog" aria-expanded={sessionsOpen}
          disabled={disabled} leadingIcon={<ChevronDown size={14} />} onClick={() => setSessionsOpen(value => !value)}>{selectedSession?.title || "会话"}</Button>
        {sessionsOpen ? <PopoverPanel motion="trigger" className="dsh-assistant__sessions" role="dialog" aria-label="项目会话列表">
          {sessionsLoading ? <p role="status">正在读取会话…</p> : null}
          <HomeSidebarList label="项目会话">
            {!sessionsLoading && sessions.length === 0 ? <p>暂无会话</p> : null}
            {sessions.map(session => <div key={session.id} className="dsh-assistant__session-row">
              <Button size="sm" variant={selectedSession?.id === session.id ? "secondary" : "ghost"} disabled={sessionBusy || sessionsLoading || (!onOpenSession && runBusy)}
                aria-pressed={selectedSession?.id === session.id} onClick={() => void operate(session)}>{session.title || "未命名会话"}{session.running ? "（运行中）" : ""}</Button>
              <Button size="sm" variant="ghost" aria-label={`删除会话 ${session.title || "未命名会话"}`} disabled={sessionBusy || sessionsLoading || runBusy || session.running}
                leadingIcon={<Trash2 size={14} />} onClick={() => setDeleting(session)} />
            </div>)}
          </HomeSidebarList>
          {deleting ? <div role="group" aria-label="确认删除会话"><p>删除“{deleting.title || "未命名会话"}”？会话将从项目列表中移除，历史文件保留。</p>
            <Button size="sm" disabled={sessionBusy || runBusy} onClick={() => void operate(deleting, true)}>确认删除</Button>
            <Button size="sm" variant="ghost" disabled={sessionBusy} onClick={() => setDeleting(null)}>取消</Button></div> : null}
        </PopoverPanel> : null}
      </div>
      <Button size="sm" variant="ghost" aria-label="新建会话" leadingIcon={<Plus size={14} />} disabled={disabled || (!onOpenSession && runBusy)} onClick={() => void operate(null)} />
      <Button size="sm" variant="ghost" onClick={() => openSettings("ai-models")}>模型设置</Button>
      <Button size="sm" variant="ghost" onClick={() => openSettings("dsh-assistant")}>助手设置</Button>
      <Button size="sm" variant="ghost" aria-label={expanded ? "收起助手" : "展开助手"} aria-expanded={expanded}
        leadingIcon={expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />} onClick={onToggleExpanded} />
      <Button size="sm" variant="ghost" aria-label="关闭助手" leadingIcon={<X size={15} />} onClick={onClose} />
    </div></header>
    {discussionTarget?.object.scope.kind === "project" && discussionTarget.object.scope.projectId === projectId
      ? <div className="dsh-assistant__context"><p>{discussionTarget.label}：请在对话中引用项目内文件。</p><Button size="sm" variant="ghost" onClick={clearDiscussionTarget}>清除选择</Button></div> : null}
    <div className="dsh-assistant__host">
      {error ? <div className="dsh-assistant__status" role="alert"><p>{error}</p><Button size="sm" disabled={runBusy}
        onClick={() => { setError(null); setAttempt(value => value + 1); }}>重试</Button></div> : !ready ? <p className="dsh-assistant__status" role="status">正在启动 DSH 助手…</p> : null}
      {ready && selectedSession && !onOpenSession ? <DshConversationHost key={syncedKey!} projectId={projectId} sessionId={selectedSession.id} {...callbacks} /> : null}
    </div>
  </section>;
}
