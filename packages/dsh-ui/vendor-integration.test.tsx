import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Context } from '@deepseek-ai/cordis';
import { HostPortalProvider } from './upstream/client/ui-primitives/src/HostPortal';
import { Modal } from './upstream/client/ui-primitives/src/Modal';
import { MenuSurface } from './upstream/client/ui-primitives/src/MenuSurface';
import { Toast } from './upstream/client/ui-primitives/src/Toast';
import { FileUploadRuntime } from './upstream/client/file-upload/src/client/runtime';
import { RemoteStreamMuxClient } from './upstream/api/gateway/src/client/stream-client';
import { scopeTheme } from './scope-styles.mjs';

const hosts: HTMLElement[] = [];
afterEach(() => { cleanup(); hosts.splice(0).forEach(host => host.remove()); vi.unstubAllGlobals(); });
function host() { const node = document.createElement('div'); node.className = 'dsh-ui-host'; document.body.append(node); hosts.push(node); return node; }

it('keeps two hosts floating content and menu backing inside their own portal surface', () => {
  const first = host(); const second = host();
  render(<HostPortalProvider value={first}><Modal open onClose={() => {}} title="First" closeLabel="Close">First content</Modal><MenuSurface>Menu one</MenuSurface></HostPortalProvider>);
  render(<HostPortalProvider value={second}><Modal open onClose={() => {}} title="Second" closeLabel="Close">Second content</Modal><Toast text="Notice two" onDone={() => {}} /></HostPortalProvider>);
  expect(first.querySelector('[role="dialog"]')).toHaveTextContent('First content');
  expect(first.querySelector('[data-menu-backing]')).not.toBeNull();
  expect(first.lastElementChild).toHaveAttribute('data-menu-backing');
  expect(first).not.toHaveTextContent('Second content');
  expect(second.querySelector('[role="dialog"]')).toHaveTextContent('Second content');
  expect(second).toHaveTextContent('Notice two');
  expect(second.querySelector('[data-menu-backing]')).toBeNull();
});

it('preserves standalone document-body fallback', () => {
  const view = render(<Modal open onClose={() => {}} title="Standalone" closeLabel="Close">Standalone content</Modal>);
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull(); expect(view.container.querySelector('[role="dialog"]')).toBeNull();
  expect(dialog?.parentElement?.parentElement).toBe(document.body);
});

it('uses instance upload hooks independently and retains original global fallback', async () => {
  const original = vi.fn(async () => new Response('global', { status: 200 }));
  const injected = vi.fn(async () => new Response('instance', { status: 201 }));
  vi.stubGlobal('__DSH_FILE_UPLOAD__', { fetch: original });
  const ctx = new Context();
  const runtime = new FileUploadRuntime(ctx, { fetch: injected });
  const request = { path: '/upload?sessionId=one', body: new Blob(['content']) };
  expect(await runtime.post(request)).toEqual({ status: 201, body: 'instance' });
  expect(original).not.toHaveBeenCalled();
  const standalone = new FileUploadRuntime(new Context());
  expect(await standalone.post(request)).toEqual({ status: 200, body: 'global' });
  expect(injected).toHaveBeenCalledOnce(); expect(original).toHaveBeenCalledOnce();
});

class Socket extends EventTarget {
  readyState = WebSocket.CONNECTING;
  frames: Record<string, unknown>[] = [];
  send(value: string) { this.frames.push(JSON.parse(value)); }
  close() { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event('close')); }
  opened() { this.readyState = WebSocket.OPEN; this.dispatchEvent(new Event('open')); }
  item(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'item', streamId: this.frames[0].streamId, value }) })); }
}
it('injected socket carries original streams, abort cancellation and reconnect without replacing WebSocket', async () => {
  const native = globalThis.WebSocket;
  const sockets: Socket[] = [];
  const factory = vi.fn(() => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; });
  const mux = new RemoteStreamMuxClient(factory);
  mux.start(); expect(factory).toHaveBeenCalledOnce(); expect(factory.mock.calls[0]).toEqual(['ws://localhost/api/remote.mux']);
  sockets[0].opened();
  const abort = new AbortController(); const stream = mux.open('fixture', { value: 1 }, abort.signal);
  const next = stream.next();
  await vi.waitFor(() => expect(sockets[0].frames[0]).toMatchObject({ type: 'open', endpoint: 'fixture' }));
  sockets[0].item('answer'); expect(await next).toEqual({ done: false, value: 'answer' });
  abort.abort(new Error('stop')); await expect(stream.next()).rejects.toThrow('stop');
  expect(sockets[0].frames.at(-1)).toMatchObject({ type: 'cancel' });
  mux.reconnect(); await vi.waitFor(() => expect(sockets).toHaveLength(2)); sockets[1].opened();
  await mux.close(); expect(globalThis.WebSocket).toBe(native);
});

it('scopes host and descendant rules while retaining dark, platform and focus selectors', () => {
  const css = scopeTheme(':root { --token: white } body[data-ds-dark-theme] { --token: black } html[data-platform="darwin"] body { --platform: mac } *::before { corner-shape: round } :focus-visible { outline-width: 2px }');
  expect(css).toContain('.dsh-ui-host { --token: white }');
  expect(css).toContain('.dsh-ui-host[data-ds-dark-theme]');
  expect(css).toContain('html[data-platform="darwin"] .dsh-ui-host');
  expect(css).toContain('.dsh-ui-host *::before'); expect(css).toContain('.dsh-ui-host :focus-visible');
  expect(css).not.toMatch(/(?:^|\})\s*(?:body|:root|\*|:focus-visible)/);
});
