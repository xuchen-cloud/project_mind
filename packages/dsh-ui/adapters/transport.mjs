import { Channel, invoke } from '@tauri-apps/api/core';
import { createWebConnectionRpc } from '../upstream/client/connection/src/client/rpc.ts';
import { RemoteStreamMuxClient } from '../upstream/api/gateway/src/client/stream-client.ts';

function toBase64(bytes) {
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 32768)
    value += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(value);
}
function fromBase64(value) {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}
async function bodyBytes(body) {
  if (body === undefined || body === null) return new Uint8Array();
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof ReadableStream) return new Uint8Array(await new Response(body).arrayBuffer());
  throw new TypeError('助手通信不支持此请求体');
}

/** EventTarget implements only the socket operations used by upstream's mux. */
export class TauriSocket extends EventTarget {
  readyState = WebSocket.CONNECTING;
  constructor(projectId, call = invoke, makeChannel = callback => new Channel(callback)) {
    super();
    this.projectId = projectId;
    this.call = call;
    this.connectionId = null;
    this.writes = Promise.resolve();
    this.closed = false;
    const pending = [];
    this.channel = makeChannel(frame => {
      if (frame.projectId !== projectId) return;
      if (this.connectionId === null) pending.push(frame);
      else this.receive(frame);
    });
    this.connected = call('dsh_assistant_connect', { projectId, onFrame: this.channel }).then(id => {
      this.connectionId = id;
      if (this.readyState !== WebSocket.CONNECTING) return this.disconnect();
      this.readyState = WebSocket.OPEN;
      this.dispatchEvent(new Event('open'));
      for (const frame of pending) this.receive(frame);
    }, () => this.fail());
  }
  receive(frame) {
    if (this.closed || frame.connectionId !== this.connectionId) return;
    if (frame.type === 'text') this.dispatchEvent(new MessageEvent('message', { data: frame.text }));
    else if (frame.type === 'binary') this.dispatchEvent(new MessageEvent('message', { data: fromBase64(frame.base64).buffer }));
    else if (frame.type === 'error') this.fail();
    else if (frame.type === 'close') {
      this.finish(frame.code, frame.reason);
      void this.disconnect();
    }
  }
  send(text) {
    if (this.readyState !== WebSocket.OPEN) throw new Error('助手连接尚未打开');
    if (typeof text !== 'string') throw new TypeError('DSH mux 仅发送文本帧');
    this.writes = this.writes.then(() => this.call('dsh_assistant_send', {
      projectId: this.projectId, connectionId: this.connectionId, frame: { type: 'text', text },
    })).catch(() => this.fail());
  }
  close() {
    if (this.closed || this.readyState === WebSocket.CLOSING) return;
    this.readyState = WebSocket.CLOSING;
    void this.connected.then(() => this.disconnect());
  }
  async disconnect() {
    if (this.connectionId !== null) {
      const id = this.connectionId;
      this.connectionId = null;
      try { await this.call('dsh_assistant_disconnect', { projectId: this.projectId, connectionId: id }); }
      catch { this.dispatchEvent(new Event('error')); }
    }
    this.finish(1000, 'closed');
  }
  fail() {
    if (this.closed) return;
    this.dispatchEvent(new Event('error'));
    this.close();
  }
  finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
    // Plain Event works in every supported WebView; mux only inspects type.
    const event = new Event('close');
    Object.defineProperties(event, { code: { value: code }, reason: { value: reason } });
    this.dispatchEvent(event);
  }
}

export function createTauriTransport(projectId, call = invoke) {
  let disposed = false;
  const requests = new Map();
  const mux = new RemoteStreamMuxClient(() => new TauriSocket(projectId, call));
  const fetch = async (input, init = {}) => {
    if (disposed) throw new Error('助手客户端已关闭');
    init.signal?.throwIfAborted();
    const requestId = crypto.randomUUID();
    const bytes = await bodyBytes(init.body);
    init.signal?.throwIfAborted();
    const cancel = () => { void call('dsh_assistant_cancel', { projectId, requestId }).catch(() => {}); };
    requests.set(requestId, cancel);
    init.signal?.addEventListener('abort', cancel, { once: true });
    try {
      const result = await call('dsh_assistant_fetch', {
        projectId, requestId, path: String(input), method: init.method ?? 'GET', bodyBase64: toBase64(bytes),
      });
      init.signal?.throwIfAborted();
      if (disposed) throw new Error('助手客户端已关闭');
      return new Response(fromBase64(result.bodyBase64), { status: result.status, headers: result.headers });
    } finally {
      init.signal?.removeEventListener('abort', cancel);
      requests.delete(requestId);
    }
  };
  mux.start();
  const rpc = createWebConnectionRpc(fetch, (endpoint, payload, signal, uplink) => {
    if (disposed) throw new Error('助手客户端已关闭');
    // Connection owns retry scheduling; each generation opens the carrier if lost.
    mux.start();
    return mux.open(endpoint, payload, signal, uplink);
  });
  return { rpc, fetch, async close() {
    if (disposed) return;
    disposed = true;
    for (const cancel of requests.values()) cancel();
    await mux.close();
  } };
}
