import React, { useEffect, useRef, useState } from 'react';
import { HostPortalProvider } from '@deepseek-ai/dsh-client-ui-primitives';
import { installScrollEdges } from './scroll-edges.mjs';
import { createDshClient } from './client.jsx';
import '../styles/scoped.css';
import './host.css';

const clients = new Map();
function acquire(projectId) {
  let entry = clients.get(projectId);
  if (entry === undefined) {
    entry = { users: 0, promise: createDshClient(projectId) };
    clients.set(projectId, entry);
  }
  entry.users++;
  let released = false;
  return { promise: entry.promise, release() {
    if (released) return;
    released = true;
    entry.users--;
    // React StrictMode's immediate effect remount keeps the same graph.
    queueMicrotask(() => {
      if (entry.users !== 0 || clients.get(projectId) !== entry) return;
      clients.delete(projectId);
      void entry.promise.then(client => client.dispose(), () => {}).catch(error => console.error('DSH 客户端关闭失败', error));
    });
  } };
}

export async function insertDshFileReference(projectId, path) {
  const entry = clients.get(projectId);
  if (entry === undefined || entry.users === 0) throw new Error('请先打开当前项目的助手，再引用文件');
  (await entry.promise).insertFile(path);
}

function Host({ projectId, sessionId, mode, ...callbacks }) {
  const element = useRef(null);
  const handlers = useRef(callbacks);
  handlers.current = callbacks;
  const [client, setClient] = useState(null);
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
        if (type === 'session') handlers.current.onSessionChange?.(data);
        else if (type === 'busy') handlers.current.onBusyChange?.(data);
        else if (type === 'file') handlers.current.onFileOpen?.(data.path, data.line);
        else if (type === 'filesChanged') handlers.current.onFilesChanged?.();
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
  }, [projectId]);
  useEffect(() => {
    if (client === null || mode !== 'chat' || sessionId === null) return;
    const opening = new AbortController();
    void client.select(sessionId, opening.signal).then(() => {
      if (!opening.signal.aborted) handlers.current.onReady?.();
    }, cause => {
      if (opening.signal.aborted) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      handlers.current.onError?.(message);
    });
    return () => { opening.abort(); };
  }, [client, sessionId, mode]);
  useEffect(() => {
    if (client && element.current) return installScrollEdges(element.current);
  }, [client]);
  return <div ref={element} className="dsh-ui-host" data-dsh-component-host data-mode={mode}>
    {error ? <p role="alert">{error}</p> : client === null || portal === null
      ? <p role="status">正在连接助手…</p>
      : <HostPortalProvider value={portal}>{client.ctx.slots.renderSlot('root', { mode })}</HostPortalProvider>}
  </div>;
}
export function DshConversationHost(props) { return <Host {...props} mode="chat" />; }
export function DshSettingsHost(props) { return <Host {...props} sessionId={null} />; }
