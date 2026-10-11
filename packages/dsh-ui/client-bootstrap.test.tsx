import { afterAll, expect, it, vi } from 'vitest';
import { Profiler, isValidElement } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { HostPortalProvider } from './upstream/client/ui-primitives/src/HostPortal';
import * as chat from './upstream/client/ui-chat/src/client/index';
import * as trajectory from './upstream/client/ui-trajectory/src/client/index';
import * as commands from './upstream/client/ui-commands/src/client/index';
import * as permissions from './upstream/client/ui-permission-presets/src/client/index';

const fixture = vi.hoisted(() => {
  // Capture timing calls. vitest.profiler.config.mjs enables the module-level
  // ReactDOM timing gate before the shared setup imports ReactDOM.
  vi.resetModules();
  const measureDescriptor = Object.getOwnPropertyDescriptor(performance, 'measure');
  const stampDescriptor = Object.getOwnPropertyDescriptor(console, 'timeStamp');
  const measure = vi.fn();
  // Lexical restores persisted drafts and scrolls selections; jsdom has no geometry.
  const rangeRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() });
  Object.defineProperty(performance, 'measure', { configurable: true, value: measure });
  Object.defineProperty(console, 'timeStamp', { configurable: true, value: vi.fn() });
  return { measure, measureDescriptor, stampDescriptor, rangeRect,
  calls: [] as string[],
  pending: new Set<() => void>(),
  streams: new Set<AbortSignal>(),
  closed: vi.fn(),
  catalog: false,
  blank: false,
  emitEvent: undefined as ((frame: unknown) => void) | undefined,
  opens: [] as { endpoint: string; payload: unknown }[],
  releaseFollow: undefined as (() => void) | undefined,
};
});
afterAll(() => {
  if (fixture.rangeRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', fixture.rangeRect); else Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
  if (fixture.measureDescriptor) Object.defineProperty(performance, 'measure', fixture.measureDescriptor); else Reflect.deleteProperty(performance, 'measure');
  if (fixture.stampDescriptor) Object.defineProperty(console, 'timeStamp', fixture.stampDescriptor); else Reflect.deleteProperty(console, 'timeStamp');
});

// Only the physical carrier is replaced. Connection, gateway, generated Remote
// contributions, Cordis and every UI plugin run their original implementations.
vi.mock('./adapters/transport.mjs', async () => {
  const { createWebConnectionRpc } = await import('./upstream/client/connection/src/client/rpc');
  return { createTauriTransport: () => {
    const fetch = vi.fn((input: string | URL, init: RequestInit) => {
      fixture.calls.push(String(input));
      if (fixture.catalog && /api\/session\/(list|projections)$/.test(String(input))) {
        const request = JSON.parse(String(init.body));
        const projections = { asOfSeq: -1, values: { sessionListMetadata: { blank: fixture.blank, lastPromptAt: fixture.blank ? null : 1 } } };
        const value = String(input).endsWith('/list')
          ? { items: [{ agentAvailable: true, sessionId: 'fixture-session', updatedAt: 1, running: false, blank: fixture.blank, cwd: '/fixture/project' }] }
          : projections;
        return Promise.resolve(new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }), { headers: { 'content-type': 'application/json' } }));
      }
      return new Promise<Response>((_resolve, reject) => {
        const cancel = () => {
          fixture.pending.delete(cancel);
          init.signal?.removeEventListener('abort', cancel);
          reject(new DOMException('Fixture carrier disposed', 'AbortError'));
        };
        fixture.pending.add(cancel);
        init.signal?.addEventListener('abort', cancel, { once: true });
        if (init.signal?.aborted) cancel();
      });
    });
    const open = async function* (endpoint: string, payload: unknown, signal: AbortSignal) {
      fixture.streams.add(signal);
      fixture.opens.push({ endpoint, payload });
      try {
        // Real gateway readiness frame; domain baselines and initial unary RPC
        // intentionally remain pending to verify bootstrap does not need a server.
        if (endpoint === '$events') {
          const frames: unknown[] = [];
          let wake: (() => void) | undefined;
          const abort = () => wake?.();
          signal.addEventListener('abort', abort);
          fixture.emitEvent = frame => { frames.push(frame); wake?.(); };
          try {
            yield { type: 'ready', clientId: 'bootstrap-fixture', host: { home: '/fixture/home' } };
            while (!signal.aborted) {
              if (frames.length === 0) await new Promise<void>(resolve => { wake = resolve; if (signal.aborted) resolve(); });
              wake = undefined;
              if (!signal.aborted && frames.length > 0) yield frames.shift();
            }
          } finally { signal.removeEventListener('abort', abort); fixture.emitEvent = undefined; }
          return;
        }
        if (fixture.catalog && endpoint === 'session/control') yield { type: 'baseline', value: { projections: {} } };
        if (fixture.catalog && endpoint === 'session/follow') {
          await new Promise<void>(resolve => {
            fixture.releaseFollow = resolve;
            if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
          });
          if (signal.aborted) return;
          yield { type: 'snapshot', header: { version: 1, id: 'fixture-session', createdAt: 1, isSeeded: false, cwd: '/fixture/project' },
            cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: { sessionListMetadata: { blank: fixture.blank, lastPromptAt: fixture.blank ? null : 1 } } },
            assistantStream: { revision: 0 } };
        }
        await new Promise<void>(resolve => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      } finally { fixture.streams.delete(signal); }
    };
    return {
      fetch, rpc: createWebConnectionRpc(fetch, open),
      async close() { fixture.closed(); for (const cancel of [...fixture.pending]) cancel(); },
    };
  } };
});
import { createDshClient } from './adapters/client.jsx';

it('resolves the original graph with active chat, trajectory, commands and permissions before initial server replies', async () => {
  fixture.calls.length = 0; fixture.closed.mockClear();
  const errors = vi.spyOn(console, 'error');
  // FontFaceSet is a browser EventTarget absent from jsdom's layout-free DOM.
  const fontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
  Object.defineProperty(document, 'fonts', { configurable: true, value: Object.assign(new EventTarget(), { ready: Promise.resolve() }) });
  const client = await createDshClient(7);
  try {
    const ctx = client.ctx;
    expect(isValidElement(ctx)).toBe(false);
    expect(Object.getOwnPropertyDescriptor(ctx, '$$typeof')).toMatchObject({ value: undefined, enumerable: false });
    const probe = ctx.plugin(() => {});
    await probe.await();
    const child = probe.ctx.extend({});
    expect(probe.ctx.$$typeof).toBeUndefined();
    expect(child.$$typeof).toBeUndefined();
    expect(Object.hasOwn(child, '$$typeof')).toBe(false);
    expect(isValidElement(child)).toBe(false);
    expect(() => child.unprovidedProbeService).toThrow('cannot get property "unprovidedProbeService" without inject');
    await probe.dispose();
    for (const service of ['connection', 'typert', 'remote', 'configForms', 'settingsSchema', 'locale',
      'slots', 'sessions', 'workspaces', 'uiSession', 'uiWorkspace', 'uiConversation', 'inputTriggers', 'commandUi', 'fileUpload']) {
      expect(ctx.get(service), service).toBeDefined();
    }
    for (const plugin of [chat, trajectory, commands, permissions]) {
      const runtime = ctx.registry.get(plugin);
      expect(runtime, 'critical plugin is registered').toBeDefined();
      expect(runtime.fibers.length).toBeGreaterThan(0);
      for (const fiber of runtime.fibers) expect(fiber.state, fiber.name).toBe(2);
    }
    const fibers = [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers]);
    // Chat optionally decorates the original right-sidebar tab list. The main
    // host supplies its own file panel and intentionally has no such provider.
    const requiredFibers = fibers.filter(fiber => !(Object.keys(fiber.inject).length === 1 && 'sidebarRightTabs' in fiber.inject));
    expect(requiredFibers.filter(fiber => fiber.state !== 2).map(fiber => [fiber.name, fiber.state])).toEqual([]);
    expect(ctx.commandUi).toBeInstanceOf(commands.CommandUiRuntime);
    const views = ctx.slots.entries('conversation.view').map(entry => entry.options.id);
    expect(views).toEqual(expect.arrayContaining(['chat', 'trajectory']));
    expect(ctx.slots.entries('settings.general.item').some(entry => entry.options.id === 'permission')).toBe(true);
    expect(ctx.slots.entries('conversation.input.permission')).toHaveLength(1);
    expect(fixture.calls).toContain('api/settings/describe');
    expect(fixture.pending.size).toBeGreaterThan(0);
    expect(fixture.streams.size).toBeGreaterThan(0);
    const entryErrors: unknown[] = [];
    const unsubscribeErrors = ctx.slots.onEntryError((_slot, _entry, error) => entryErrors.push(error));
    const portal = document.createElement('div'); portal.className = 'dsh-ui-host'; document.body.append(portal);
    try {
      render(<HostPortalProvider value={portal}><div className="dsh-ui-host">{ctx.slots.renderSlot('root', { mode: 'chat' })}</div></HostPortalProvider>);
      await waitFor(() => {
        expect(entryErrors).toEqual([]);
        expect(screen.getByRole('textbox')).toHaveAttribute('data-composer-input');
      });
      expect(errors).not.toHaveBeenCalled();
    } finally { cleanup(); unsubscribeErrors(); portal.remove(); }
  } finally {
    await client.dispose();
    await client.dispose();
    expect(fixture.closed).toHaveBeenCalledOnce();
    expect(fixture.pending.size).toBe(0);
    expect(fixture.streams.size).toBe(0);
    errors.mockRestore();
    if (fontsDescriptor) Object.defineProperty(document, 'fonts', fontsDescriptor);
    else Reflect.deleteProperty(document, 'fonts');
  }
});


it.each([false, true])('opens selected session blank=%s without starving timers and renders its original scope', async (blank) => {
  fixture.catalog = true; fixture.blank = blank; fixture.calls.length = 0; fixture.opens.length = 0; fixture.closed.mockClear();
  fixture.releaseFollow = undefined; fixture.measure.mockClear();
  const fontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
  Object.defineProperty(document, 'fonts', { configurable: true, value: Object.assign(new EventTarget(), { ready: Promise.resolve() }) });
  const client = await createDshClient(7);
  const portal = document.createElement('div'); portal.className = 'dsh-ui-host'; document.body.append(portal);
  const entryErrors: unknown[] = [];
  const unsubscribe = client.ctx.slots.onEntryError((_slot, _entry, error) => entryErrors.push(error));
  try {
    await waitFor(() => expect(client.ctx.sessions.list.getSnapshot().byId['fixture-session']).toBeDefined());
    render(<Profiler id="selected-session" onRender={() => {}}><HostPortalProvider value={portal}><div className="dsh-ui-host">{client.ctx.slots.renderSlot('root', { mode: 'chat' })}</div></HostPortalProvider></Profiler>);
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveAttribute('data-composer-input'));
    let selected = false;
    const selection = client.select('fixture-session').then(() => { selected = true; });
    await waitFor(() => expect(fixture.releaseFollow).toBeDefined());
    expect(fixture.opens.find(item => item.endpoint === 'session/follow')?.payload).toEqual({ args: { request: {
      address: { kind: 'session', sessionId: 'fixture-session' }, assistantStream: true,
      maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 },
    } } });
    expect(selected).toBe(false);
    const binding = client.ctx.sessions.binding('fixture-session');
    expect(binding).toBeDefined();
    expect(binding.session.getSnapshot().openState).toBe('loading');
    expect(binding.session.getSnapshot().blank).toBe(blank);
    expect(binding.ctx.fiber.state).toBe(2);
    expect(isValidElement(binding.ctx)).toBe(false);
    expect(() => binding.ctx.unprovidedProbeService).toThrow('cannot get property "unprovidedProbeService" without inject');

    const timer = AbortSignal.timeout(10);
    await new Promise<void>(resolve => timer.addEventListener('abort', () => resolve(), { once: true }));
    expect(timer.aborted).toBe(true);
    expect(selected).toBe(false);
    expect(entryErrors).toEqual([]);
    fixture.releaseFollow!();
    await selection;
    expect(selected).toBe(true);
    expect(binding.session.getSnapshot().openState).toBe('open');
    expect(binding.session.getSnapshot().blank).toBe(blank);
    expect(client.ctx.sessions.scope('fixture-session')).toBe(binding.ctx);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    await waitFor(() => {
      expect(entryErrors).toEqual([]);
      expect(screen.getByRole('textbox')).toHaveAttribute('data-composer-input');
      if (!blank) expect(screen.getAllByRole('tab')).toHaveLength(2);
    });
    const input = client.ctx.conversation.input.for(binding.ctx);
    const beforeDraft = input.state.getSnapshot().draft;
    const composer = screen.getByRole('textbox');
    const beforeReferences = (composer.textContent ?? '').split('README.md').length - 1;
    await act(async () => { client.insertFile('README.md'); });
    await waitFor(() => {
      expect(input.state.getSnapshot().draft).toBe(beforeDraft + '@README.md ');
      expect(screen.getByRole('textbox')).toBe(composer);
      expect((composer.textContent ?? '').split('README.md').length - 1).toBe(beforeReferences + 1);
      expect(client.ctx.conversation.input.for(binding.ctx)).toBe(input);
    });
    if (Reflect.get(globalThis, '__dshProfilerTest')) {
      expect(fixture.measure.mock.calls.some(call => String(call[0]).startsWith('\u200b'))).toBe(true);
    }
    if (!blank) expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(expect.arrayContaining([expect.stringMatching(/Chat|对话|聊天/), expect.stringMatching(/Trajectory|轨迹/)]));
  } finally {
    cleanup(); unsubscribe(); portal.remove();
    const sessions = client.ctx.sessions;
    await client.dispose();
    expect(fixture.pending.size).toBe(0); expect(fixture.streams.size).toBe(0);
    expect(sessions.binding('fixture-session')).toBeUndefined();
    fixture.catalog = false; fixture.blank = false;
    if (fontsDescriptor) Object.defineProperty(document, 'fonts', fontsDescriptor); else Reflect.deleteProperty(document, 'fonts');
  }
});


it('publishes initial busy and clears host busy after real status events update the catalog', async () => {
  fixture.catalog = true; fixture.blank = false;
  const client = await createDshClient(7);
  const listener = vi.fn();
  const lateListener = vi.fn();
  let unsubscribe = () => {};
  let unsubscribeLate = () => {};
  let unsubscribeCatalog = () => {};
  const synchronousBusy: boolean[] = [];
  try {
    await waitFor(() => expect(client.ctx.sessions.list.getSnapshot().byId['fixture-session']).toBeDefined());
    unsubscribe = client.subscribe(listener);
    expect(listener).toHaveBeenCalledWith('busy', false);
    let previousRunning = false;
    unsubscribeCatalog = client.ctx.sessions.list.subscribe(() => {
      const running = client.ctx.sessions.list.getSnapshot().byId['fixture-session'].running;
      if (running !== previousRunning && listener.mock.calls.some(call => call[0] === 'busy' && call[1] === running)) synchronousBusy.push(running);
      previousRunning = running;
    });
    fixture.emitEvent!({ type: 'emit', event: 'api-session/status', args: ['fixture-session', true] });
    await waitFor(() => {
      expect(client.ctx.sessions.list.getSnapshot().byId['fixture-session'].running).toBe(true);
      expect(listener).toHaveBeenCalledWith('busy', true);
    });
    unsubscribeLate = client.subscribe(lateListener);
    expect(lateListener).toHaveBeenCalledWith('busy', true);
    listener.mockClear(); lateListener.mockClear();
    fixture.emitEvent!({ type: 'emit', event: 'api-session/status', args: ['fixture-session', false] });
    await waitFor(() => {
      expect(client.ctx.sessions.list.getSnapshot().byId['fixture-session'].running).toBe(false);
      expect(listener).toHaveBeenCalledWith('busy', false);
      expect(lateListener).toHaveBeenCalledWith('busy', false);
      expect(listener).toHaveBeenCalledWith('filesChanged', undefined);
    });
    expect(listener.mock.calls.filter(call => call[0] === 'busy').at(-1)).toEqual(['busy', false]);
    expect(synchronousBusy).toEqual([]);
  } finally {
    unsubscribe(); unsubscribeLate(); unsubscribeCatalog(); await client.dispose();
    fixture.catalog = false;
    expect(fixture.pending.size).toBe(0); expect(fixture.streams.size).toBe(0);
  }
});


it.each([false, true])('reselects the same blank session after cancellation (wait for first rejection=%s)', async (waitForRejection) => {
  fixture.catalog = true; fixture.blank = true; fixture.releaseFollow = undefined;
  const fontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
  Object.defineProperty(document, 'fonts', { configurable: true, value: Object.assign(new EventTarget(), { ready: Promise.resolve() }) });
  const client = await createDshClient(7);
  const portal = document.createElement('div'); portal.className = 'dsh-ui-host'; document.body.append(portal);
  const entryErrors: unknown[] = [];
  const unsubscribe = client.ctx.slots.onEntryError((_slot, _entry, error) => entryErrors.push(error));
  try {
    await waitFor(() => expect(client.ctx.sessions.list.getSnapshot().byId['fixture-session']).toBeDefined());
    render(<Profiler id="cancelled-selection" onRender={() => {}}><HostPortalProvider value={portal}><div className="dsh-ui-host">{client.ctx.slots.renderSlot('root', { mode: 'chat' })}</div></HostPortalProvider></Profiler>);
    const controller = new AbortController();
    const first = client.select('fixture-session', controller.signal).then(() => ({ resolved: true }), error => ({ error }));
    await waitFor(() => expect(fixture.releaseFollow).toBeDefined());
    const reason = new DOMException('Selection effect cleanup', 'AbortError');
    controller.abort(reason);
    if (waitForRejection) {
      expect(await first).toEqual({ error: reason });
    }
    let secondResolved = false;
    const second = client.select('fixture-session').then(() => { secondResolved = true; });
    await waitFor(() => expect(client.ctx.sessions.retainInfo('fixture-session').getSnapshot().retainedBy.mainView).toBe(1));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(secondResolved).toBe(false);
    const sessions = client.ctx.sessions;
    const binding = sessions.binding('fixture-session');
    expect(binding).toBeDefined();
    expect(sessions.retainInfo('fixture-session').getSnapshot().retainedBy.mainView).toBe(1);
    fixture.releaseFollow!();
    await second;
    const firstResult = await first;
    expect(firstResult).toHaveProperty('error');
    expect(sessions.binding('fixture-session')).toBe(binding);
    expect(sessions.retainInfo('fixture-session').getSnapshot().retainedBy.mainView).toBe(1);
    expect(binding.session.getSnapshot().openState).toBe('open');
    await waitFor(() => {
      expect(entryErrors).toEqual([]);
      expect(screen.getByRole('textbox')).toHaveAttribute('contenteditable', 'true');
      expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-disabled', 'true');
    });
  } finally {
    cleanup(); unsubscribe(); portal.remove(); await client.dispose();
    fixture.catalog = false; fixture.blank = false;
    expect(fixture.pending.size).toBe(0); expect(fixture.streams.size).toBe(0);
    if (fontsDescriptor) Object.defineProperty(document, 'fonts', fontsDescriptor); else Reflect.deleteProperty(document, 'fonts');
  }
});
