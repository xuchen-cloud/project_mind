import { expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class { constructor(public onmessage: (value: unknown) => void) {} } }));
import { TauriSocket, createTauriTransport } from './transport.mjs';

it('binds native frames to the owning project and connection and preserves ordered mux writes', async () => {
  let receive!: (event: unknown) => void;
  const sent: string[] = [];
  const call = vi.fn(async (name: string, args: Record<string, any>) => {
    if (name === 'dsh_assistant_connect') return 'connection-a';
    if (name === 'dsh_assistant_send') sent.push(args.frame.text);
  });
  const socket = new TauriSocket(7, call, (callback: typeof receive) => { receive = callback; return {}; });
  const received: string[] = [];
  socket.addEventListener('message', (event: MessageEvent) => received.push(event.data));
  await socket.connected;
  receive({ type: 'text', projectId: 8, connectionId: 'connection-a', text: 'wrong project' });
  receive({ type: 'text', projectId: 7, connectionId: 'old-generation', text: 'stale' });
  receive({ type: 'text', projectId: 7, connectionId: 'connection-a', text: 'actual' });
  expect(received).toEqual(['actual']);
  socket.send('open'); socket.send('item'); socket.send('end');
  await socket.writes;
  expect(sent).toEqual(['open', 'item', 'end']);
  socket.close(); await socket.connected; await new Promise(resolve => queueMicrotask(resolve));
  expect(call).toHaveBeenCalledWith('dsh_assistant_disconnect', { projectId: 7, connectionId: 'connection-a' });
});

it('closes an owned connection that finishes opening after the host was disposed', async () => {
  let complete!: (id: string) => void;
  const call = vi.fn((name: string) => name === 'dsh_assistant_connect' ? new Promise(resolve => { complete = resolve; }) : Promise.resolve());
  const socket = new TauriSocket(7, call, () => ({}));
  const opened = vi.fn(); socket.addEventListener('open', opened);
  socket.close(); complete('late'); await socket.connected;
  expect(opened).not.toHaveBeenCalled();
  expect(socket.readyState).toBe(WebSocket.CLOSED);
  expect(call).toHaveBeenCalledWith('dsh_assistant_disconnect', { projectId: 7, connectionId: 'late' });
});

it('encodes actual attachment bytes and cancels an in-flight upload through native ownership', async () => {
  let resolveFetch!: (value: unknown) => void;
  const call = vi.fn((name: string) => {
    if (name === 'dsh_assistant_connect') return Promise.reject(new Error('fixture socket unavailable'));
    if (name === 'dsh_assistant_fetch') return new Promise(resolve => { resolveFetch = resolve; });
    return Promise.resolve();
  });
  const transport = createTauriTransport(7, call);
  const controller = new AbortController();
  const request = transport.fetch('api/session/uploadFileBinary?sessionId=s-a', { method: 'POST', body: new Uint8Array([0, 1, 255]), signal: controller.signal });
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('dsh_assistant_fetch', expect.objectContaining({ projectId: 7, bodyBase64: 'AAH/' })));
  controller.abort();
  expect(call).toHaveBeenCalledWith('dsh_assistant_cancel', expect.objectContaining({ projectId: 7 }));
  resolveFetch({ status: 200, headers: { 'content-type': 'application/octet-stream' }, bodyBase64: 'AAH/' });
  await expect(request).rejects.toThrow();
  await transport.close();
});
