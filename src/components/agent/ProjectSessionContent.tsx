import type { AgentSourceRef } from '../../lib/agent-types';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DshConversationHost, insertDshFileReference } from '@project-mind/dsh-ui/adapters';
import { consumeDshFileReference, useDshFileReferences } from '../../lib/dsh-host-events';
import { getErrorMessage } from '../../lib/errors';
import { notifyProjectFilesChanged, openProjectFilePreview } from '../../lib/project-file-navigation';
import { queryKeys } from '../../lib/queryKeys';
import type { AiSettingsSnapshot } from '../../lib/types';
import { dshAssistantApi } from '../../services/dshAssistantApi';
import { dshProjectRunKey, useAgentPanelStore } from '../../state/agent-panel-store';
import { useUiStore } from '../../state/ui-store';
import { Button } from '../../ui/components/Button';
import { MemoryAdoption } from '../memory/MemoryAdoption';
import './project-session-content.css';

export interface ProjectSessionContentProps {
  workspaceRoot: string;
  projectId: number;
  sessionId: string;
  visible: boolean;
  focused: boolean;
}

/** The Project client retains the original Session store when this UI seat closes. */
export function ProjectSessionContent({ workspaceRoot, projectId, sessionId, visible, focused }: ProjectSessionContentProps) {
  const queryClient = useQueryClient();
  const subscribe = useCallback((notify: () => void) => queryClient.getQueryCache().subscribe(event => {
    if (event.query.queryKey[0] === queryKeys.aiSettings[0]) notify();
  }), [queryClient]);
  const snapshot = useCallback(() => {
    const settings = queryClient.getQueryData<AiSettingsSnapshot>(queryKeys.aiSettings);
    return JSON.stringify([settings?.bindings, settings?.profiles,
      settings?.aiSecretsUnlocked, settings?.securityMode, settings?.network]);
  }, [queryClient]);
  const fingerprint = useSyncExternalStore(subscribe, snapshot);
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([workspaceRoot, projectId, sessionId, fingerprint, attempt]);
  const identity = JSON.stringify([workspaceRoot, projectId, sessionId]);
  const [readyIdentity, setReadyIdentity] = useState<string | null>(null);
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const [hostReady, setHostReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [referenceRevision, setReferenceRevision] = useState(0);
  const [referenceError, setReferenceError] = useState<{ id: number; message: string } | null>(null);
  const busy = useAgentPanelStore(state => !!state.runsByProject[dshProjectRunKey(workspaceRoot, projectId)]);
  const ready = readyIdentity === identity && (readyKey === key || busy);
  const pending = useDshFileReferences(state => state.pending.find(item => item.workspaceRoot === workspaceRoot
    && item.projectId === projectId && item.sessionId === sessionId));
  const inserting = useRef(false);
  const current = useRef(key);
  current.current = key;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const openSettings = useUiStore(state => state.openSettings);

  useEffect(() => {
    if (!visible || ready) return;
    let cancelled = false;
    setHostReady(false); setError(null);
    void (async () => {
      if (!busy) await dshAssistantApi.start(JSON.stringify([workspaceRoot, projectId, fingerprint]), projectId);
      if (cancelled) return;
      await dshAssistantApi.selectSession(sessionId, projectId);
      if (!cancelled) { setReadyIdentity(identity); setReadyKey(key); }
    })().catch(reason => { if (!cancelled) setError(getErrorMessage(reason, '读取项目会话失败')); });
    return () => { cancelled = true; };
  }, [visible, ready, busy, key, workspaceRoot, projectId, sessionId, fingerprint, identity]);

  const callbacks = useMemo(() => {
    const valid = () => alive.current && current.current === key;
    return {
      onReady: () => { if (valid()) setHostReady(true); },
      onError: (message: string) => { if (valid()) setError(message); },
      onSettings: () => { if (valid()) openSettings('dsh-assistant'); },
      onModelSettings: () => { if (valid()) openSettings('ai-models'); },
      onFileOpen: (path: string, line?: number, sourceRef?: AgentSourceRef) => { if (valid()) openProjectFilePreview(projectId, path, line, sessionId, sourceRef); },
      onFilesChanged: () => {
        if (!valid()) return;
        notifyProjectFilesChanged(projectId);
        void queryClient.invalidateQueries({ queryKey: queryKeys.projectPage(projectId) });
      },
    };
  }, [key, projectId, sessionId, openSettings, queryClient]);

  useEffect(() => {
    if (!visible || !ready || !hostReady || error || !pending || inserting.current || referenceError?.id === pending.id) return;
    inserting.current = true;
    void insertDshFileReference(projectId, sessionId, pending.path, pending.sourceRef).then(() => {
      consumeDshFileReference(pending.id);
    }).catch(reason => {
      if (alive.current) setReferenceError({ id: pending.id, message: getErrorMessage(reason, '引用文件失败') });
    }).finally(() => {
      inserting.current = false;
      if (alive.current && current.current === key) setReferenceRevision(value => value + 1);
    });
  }, [visible, ready, hostReady, error, pending, projectId, sessionId, key, referenceRevision, referenceError]);

  if (!visible) return null;
  return <section className="project-session-content" data-project-session={sessionId} data-focused={focused}>
    {error ? <div role="alert">
      <p>{error}</p>
      <Button size="sm" variant="ghost" onClick={() => openSettings('ai-models')}>模型设置</Button>
      <Button size="sm" onClick={() => { setReadyKey(null); setAttempt(value => value + 1); }}>重试</Button>
    </div>
      : !ready ? <p role="status">正在读取项目会话…</p> : null}
    {pending && referenceError?.id === pending.id ? <div role="alert">
      <p>引用 {pending.path} 失败：{referenceError.message}</p>
      <Button size="sm" onClick={() => setReferenceError(null)}>重试引用</Button>
    </div> : null}
    {ready ? <DshConversationHost renderMemoryAdoption={({ sessionId: adoptedSession, turn }) => <MemoryAdoption workspaceRoot={workspaceRoot} projectId={projectId} sessionId={adoptedSession} turn={turn} />} projectId={projectId} sessionId={sessionId} focused={focused} {...callbacks} /> : null}
  </section>;
}
