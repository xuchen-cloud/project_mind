import React, { useEffect, useRef, useState } from 'react';
import { HostPortalProvider } from '@deepseek-ai/dsh-client-ui-primitives';
import { installScrollEdges } from './scroll-edges.mjs';
import { createDshClient } from './client.jsx';
import { observeSessionModel } from './session-model.mjs';
import '../styles/scoped.css';
import './host.css';

const clients = new Map();
function acquire(projectId) {
  let entry = clients.get(projectId);
  if (entry === undefined) {
    entry = { users: 0, promise: createDshClient(projectId) };
    clients.set(projectId, entry);
    void entry.promise.catch(() => { if (clients.get(projectId) === entry) clients.delete(projectId); });
    void entry.promise.then(client => client.subscribe((type, data) => {
      if (clients.get(projectId) !== entry) return;
      if (type === 'busy')
        window.dispatchEvent(new CustomEvent('mind:dsh-project-busy', { detail: { projectId, busy: data } }));
      else if (type === 'sessionRuns')
        window.dispatchEvent(new CustomEvent('mind:dsh-session-runs', { detail: { projectId, runningBySession: data } }));
      else if (type === 'sessionTitles')
        window.dispatchEvent(new CustomEvent('mind:dsh-session-titles', { detail: { projectId, titlesBySession: data } }));
      else if (type === 'sessionsChanged')
        window.dispatchEvent(new CustomEvent('mind:dsh-sessions-changed', { detail: { projectId } }));
    }), () => {});
  }
  entry.users++;
  let released = false;
  return { promise: entry.promise, release() {
    if (released) return;
    released = true;
    entry.users--;
    // A content page only releases its UI seat. The project graph and Session
    // stores survive Tab closure; workspace teardown owns graph disposal.
  } };
}

export async function insertDshFileReference(projectId, sessionId, path, sourceRef) {
  const entry = clients.get(projectId);
  if (entry === undefined) throw new Error('请先打开当前项目的助手，再引用文件');
  await (await entry.promise).insertFile(sessionId, path, sourceRef);
}

function Host({ projectId, sessionId, focused = true, mode, ...callbacks }) {
  const element = useRef(null);
  const handlers = useRef(callbacks);
  handlers.current = { ...callbacks, focused };
  const [client, setClient] = useState(null);
  const [reference, setReference] = useState(null);
  const [error, setError] = useState('');
  const [portal, setPortal] = useState(null);
  useEffect(() => {
    const node = document.createElement('div');
    node.className = 'dsh-ui-host dsh-ui-portals';
    document.body.append(node);
    setPortal(node);
    const updateTheme = () => {
      const dark = document.body.hasAttribute('data-ds-dark-theme') || document.documentElement.dataset.theme === 'dark';
      node.toggleAttribute('data-ds-dark-theme', dark);
      element.current?.toggleAttribute('data-ds-dark-theme', dark);
    };
    updateTheme();
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
    return () => { observer.disconnect(); node.remove(); };
  }, []);
  useEffect(() => {
    let active = true;
    let unsubscribe;
    setClient(null);
    setError('');
    const handle = acquire(projectId);
    void handle.promise.then(value => {
      if (!active) return;
      unsubscribe = value.subscribe((type, data) => {
        if (!active) return;
        if (type === 'session' && handlers.current.focused) handlers.current.onSessionChange?.(data);
        else if (type === 'busy') handlers.current.onBusyChange?.(data);
        else if (type === 'file' && (data.sessionId ? data.sessionId === sessionId : handlers.current.focused)) handlers.current.onFileOpen?.(data.path, data.line, data.sourceRef);
        else if (type === 'filesChanged') handlers.current.onFilesChanged?.();
        else if (type === 'modelSettings' && data === sessionId) handlers.current.onModelSettings?.();
        else if (type === 'error') handlers.current.onError?.(data);
      });
      setClient(value);
      if (mode !== 'chat') handlers.current.onReady?.();
    }, cause => {
      if (!active) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      handlers.current.onError?.(message);
    });
    return () => { active = false; unsubscribe?.(); handle.release(); };
  }, [projectId, sessionId]);
  useEffect(() => {
    setReference(null);
    setError('');
    if (client === null || mode !== 'chat') return;
    const opening = new AbortController();
    let selected;
    let unsubscribeModel;
    void client.select(sessionId, opening.signal).then(value => {
      if (opening.signal.aborted) { value.release(); return; }
      selected = value;
      unsubscribeModel = observeSessionModel(value, model => {
        if (!opening.signal.aborted) handlers.current.onModelChange?.(model);
      });
      setReference(value);
      handlers.current.onReady?.();
    }, cause => {
      if (opening.signal.aborted) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      handlers.current.onError?.(message);
    });
    return () => { opening.abort(); unsubscribeModel?.(); selected?.release(); };
  }, [client, sessionId, mode]);
  useEffect(() => {
    if (client && element.current) return installScrollEdges(element.current);
  }, [client]);
  return <div ref={element} className="dsh-ui-host" data-dsh-component-host data-dsh-focused={focused} data-mode={mode}>
    {error ? <p role="alert">{error}</p> : client === null || portal === null || (mode === 'chat' && reference?.sessionId !== sessionId)
      ? <p role="status">正在连接助手…</p>
      : <HostPortalProvider value={portal}>{client.ctx.slots.renderSlot('root', { mode, reference })}</HostPortalProvider>}
  </div>;
}
export function DshConversationHost(props) {
  if (typeof props.sessionId !== 'string' || props.sessionId.length === 0) throw new Error('会话页面必须指定 Session ID');
  return <Host {...props} mode="chat" />;
}
export function DshSettingsHost(props) { return <Host {...props} sessionId={null} />; }

export async function disposeDshClients() {
  const entries = [...clients.values()];
  for (const projectId of clients.keys()) {
    window.dispatchEvent(new CustomEvent('mind:dsh-session-runs', { detail: { projectId, runningBySession: {} } }));
    window.dispatchEvent(new CustomEvent('mind:dsh-session-titles', { detail: { projectId, titlesBySession: {} } }));
  }
  clients.clear();
  await Promise.all(entries.map(entry => entry.promise.then(client => client.dispose(), () => {})));
}
window.addEventListener('mind:dsh-workspace-close', () => {
  void disposeDshClients().catch(error => console.error('DSH 客户端关闭失败', error));
});
