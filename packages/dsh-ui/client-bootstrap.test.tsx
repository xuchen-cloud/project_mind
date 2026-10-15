import { afterAll, expect, it, vi } from 'vitest';
import { Profiler, isValidElement, createElement, type ComponentType } from 'react';
import { act, cleanup, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
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
  rpcRequests: [] as any[],
  pending: new Set<() => void>(),
  streams: new Set<AbortSignal>(),
  closed: vi.fn(),
  catalog: false,
  dual: false,
  followReleases: new Map<string, () => void>(),
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
      if (String(input).endsWith('/mind/source/resolve')) {
        const request = JSON.parse(String(init.body));
        const { path } = request.payload.args.request;
        return Promise.resolve(new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { sourceRef: { object: { workspaceId: 'fixture', scope: { kind: 'project', projectId: 7 }, kind: 'file', id: path }, revision: 'sha256:fixture', fileVersion: 1, recordVersion: null, blockId: null, locator: null, title: path, excerpt: '' } } } }), { headers: { 'content-type': 'application/json' } }));
      }
      if (fixture.catalog && String(input).endsWith('/session/cancel')) {
        const request = JSON.parse(String(init.body)); fixture.rpcRequests.push(request);
        return Promise.resolve(new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } }), { headers: { 'content-type': 'application/json' } }));
      }
      if (fixture.catalog && /api\/session\/(list|projections)$/.test(String(input))) {
        const request = JSON.parse(String(init.body));
        const projections = { asOfSeq: -1, values: { sessionListMetadata: { blank: fixture.blank, lastPromptAt: fixture.blank ? null : 1 } } };
        const value = String(input).endsWith('/list')
          ? { items: [ ...(fixture.dual ? [{ agentAvailable: true, sessionId: 'second-session', updatedAt: 1, running: false, blank: false, cwd: '/fixture/project' }] : []), { agentAvailable: true, sessionId: 'fixture-session', updatedAt: 1, running: false, blank: fixture.blank, cwd: '/fixture/project' }] }
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
            fixture.followReleases.set((payload as any).args.request.address.sessionId, resolve);
            if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
          });
          if (signal.aborted) return;
          yield { type: 'snapshot', header: { version: 1, id: (payload as any).args.request.address.sessionId, createdAt: 1, isSeeded: false, cwd: '/fixture/project' },
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
import { DshConversationHost, disposeDshClients, insertDshFileReference } from './adapters/index.jsx';

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
    // Exercise the actual registered views, including delayed slot injection.
    const sourceRef = { object: { workspaceId: 'ws', scope: { kind: 'project', projectId: 7 }, kind: 'file', id: '9' }, revision: 'sha256:fixed', fileVersion: 1, title: 'sample.txt' };
    const fixedPath = `mind-source/${btoa(JSON.stringify(sourceRef)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}/sample.txt`;
    const text = `Inspect@${fixedPath}\n<mind-file-source>${JSON.stringify({ sourceRef, content: 'private model bytes' })}</mind-file-source>`;
    for (const kind of ['user', 'steering']) {
      const entry = ctx.slots.entries('conversation.chat.node').find(entry => entry.options.key === kind)!;
      const openFile = vi.fn();
      const view = render(createElement(entry.component as ComponentType<any>, { node: { kind, data: { content: [{ type: 'text', text }], time: 1 } }, t: (key: string) => key, renderMessageImages: () => null, openSkill: vi.fn(), openFile }));
      expect(view.container.innerHTML).not.toMatch(/mind-source|mind-file-source|private model bytes|sha256/);
      fireEvent.click(screen.getByRole('button', { name: 'sample.txt · v1' }));
      expect(openFile).toHaveBeenCalledWith(fixedPath, undefined);
      cleanup();
    }
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
        expect(document.querySelector('.dsh-ui-frame')).not.toBeNull();
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
    let selected = false;
    const selection = client.select('fixture-session').then(reference => { selected = true; return reference; });
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
    const reference = await selection;
    cleanup();
    render(<HostPortalProvider value={portal}><div className="dsh-ui-host">{client.ctx.slots.renderSlot('root', { mode: 'chat', reference })}</div></HostPortalProvider>);
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
    await act(async () => { await client.insertFile('fixture-session', 'README.md'); });
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
    const second = client.select('fixture-session').then(reference => { secondResolved = true; return reference; });
    await waitFor(() => expect(client.ctx.sessions.retainInfo('fixture-session').getSnapshot().retainedBy.mainView).toBe(1));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(secondResolved).toBe(false);
    const sessions = client.ctx.sessions;
    const binding = sessions.binding('fixture-session');
    expect(binding).toBeDefined();
    expect(sessions.retainInfo('fixture-session').getSnapshot().retainedBy.mainView).toBe(1);
    fixture.releaseFollow!();
    const reference = await second;
    cleanup();
    render(<HostPortalProvider value={portal}>{client.ctx.slots.renderSlot('root', { mode: 'chat', reference })}</HostPortalProvider>);
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


it('keeps two original Session scopes independently rendered and explicitly routes references', async () => {
  fixture.catalog = true; fixture.dual = true; fixture.followReleases.clear();
  const fontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
  Object.defineProperty(document, 'fonts', { configurable: true, value: Object.assign(new EventTarget(), { ready: Promise.resolve() }) });
  const client = await createDshClient(7);
  try {
    const firstOpening = client.select('fixture-session');
    const secondOpening = client.select('second-session');
    await waitFor(() => expect(fixture.followReleases.size).toBe(2));
    fixture.followReleases.get('second-session')!();
    const second = await secondOpening;
    fixture.followReleases.get('fixture-session')!();
    const first = await firstOpening;
    expect(first.sessionId).toBe('fixture-session');
    expect(second.sessionId).toBe('second-session');
    render(<div>{client.ctx.slots.renderSlot('root', { mode: 'chat', reference: first })}
      {client.ctx.slots.renderSlot('root', { mode: 'chat', reference: second })}</div>);
    await waitFor(() => expect(screen.getAllByRole('textbox')).toHaveLength(2));
    expect([...document.querySelectorAll('[data-conversation-session]')].map(node => node.getAttribute('data-conversation-session')))
      .toEqual(expect.arrayContaining(['fixture-session', 'second-session']));
    await act(async () => { await Promise.all([client.insertFile('fixture-session', 'first.md'), client.insertFile('second-session', 'second.md')]); });
    const drafts = screen.getAllByRole('textbox').map(node => node.textContent);
    expect(drafts.filter(value => value?.includes('first.md'))).toHaveLength(1);
    expect(drafts.filter(value => value?.includes('second.md'))).toHaveLength(1);
    expect(drafts.every(value => !(value?.includes('first.md') && value?.includes('second.md')))).toBe(true);
    cleanup(); first.release(); second.release();
    expect(fixture.calls.some(path => path.endsWith('/cancel'))).toBe(false);
    const reopened = await client.select('fixture-session');
    render(client.ctx.slots.renderSlot('root', { mode: 'chat', reference: reopened }));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveTextContent('first.md'));
    cleanup();
    expect(reopened.sessionId).toBe('fixture-session');
    reopened.release();
  } finally { cleanup(); await client.dispose(); fixture.catalog = false; fixture.dual = false;
    if (fontsDescriptor) Object.defineProperty(document, 'fonts', fontsDescriptor); else Reflect.deleteProperty(document, 'fonts');
  }
});

it('two actual Hosts scope composer and stop controls, keep hidden runs subscribed and restore the original draft', async () => {
  // Earlier fixtures use the same synthetic IDs; isolate their persisted drafts.
  localStorage.removeItem('dsh.conversation.fixture-session');
  localStorage.removeItem('dsh.conversation.second-session');
  fixture.catalog = true; fixture.dual = true; fixture.blank = false; fixture.followReleases.clear(); fixture.rpcRequests = [];
  const fontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
  Object.defineProperty(document, 'fonts', { configurable: true, value: Object.assign(new EventTarget(), { ready: Promise.resolve() }) });
  const readyA = vi.fn(), readyB = vi.fn(), busy = vi.fn(), modelA = vi.fn(), modelB = vi.fn(), sessionRuns = vi.fn();
  window.addEventListener('mind:dsh-project-busy', busy);
  window.addEventListener('mind:dsh-session-runs', sessionRuns);
  const shell = (first = true) => <div>
    {first ? <DshConversationHost projectId={7} sessionId="fixture-session" focused={false} onReady={readyA} onModelChange={modelA} /> : null}
    <DshConversationHost projectId={7} sessionId="second-session" focused onReady={readyB} onModelChange={modelB} />
  </div>;
  const view = render(shell());
  try {
    await waitFor(() => expect(fixture.followReleases.size).toBe(2));
    await act(async () => { fixture.followReleases.get('second-session')!(); fixture.followReleases.get('fixture-session')!(); });
    await waitFor(() => { expect(readyA).toHaveBeenCalledOnce(); expect(readyB).toHaveBeenCalledOnce(); });
    expect(modelA).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'fixture-session', running: false }));
    expect(modelB).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'second-session', running: false }));
    await act(async () => { await insertDshFileReference(7, 'fixture-session', 'first.md'); });
    const hosts = [...document.querySelectorAll('[data-dsh-component-host]')] as HTMLElement[];
    expect(within(hosts[0]).getByRole('textbox')).toHaveTextContent('first.md');
    expect(within(hosts[1]).getByRole('textbox')).not.toHaveTextContent('first.md');
    await act(async () => {
      fixture.emitEvent!({ type: 'emit', event: 'api-session/status', args: ['fixture-session', true] });
    });
    await waitFor(() => expect(modelA).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'fixture-session', running: true })));
    expect(modelB).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'second-session', running: false }));
    await act(async () => { fixture.emitEvent!({ type: 'emit', event: 'api-session/status', args: ['second-session', true] }); });
    await waitFor(() => expect(modelB).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'second-session', running: true })));
    fireEvent.click(await within(hosts[1]).findByRole('button', { name: /Stop generating|停止生成/ }));
    await waitFor(() => expect(fixture.rpcRequests).toHaveLength(1));
    expect(fixture.rpcRequests[0].payload.args.request.sessionId).toBe('second-session');
    view.rerender(shell(false));
    expect(fixture.rpcRequests).toHaveLength(1);
    const secondInput = within(hosts[1]).getByRole('textbox');
    act(() => secondInput.focus());
    view.rerender(shell());
    await waitFor(() => expect(readyA).toHaveBeenCalledTimes(2));
    expect(document.activeElement).toBe(secondInput);
    view.unmount();
    busy.mockClear(); modelA.mockClear(); modelB.mockClear(); sessionRuns.mockClear();
    fixture.emitEvent!({ type: 'emit', event: 'api-session/status', args: ['fixture-session', false] });
    fixture.emitEvent!({ type: 'emit', event: 'api-session/status', args: ['second-session', false] });
    await waitFor(() => expect(busy.mock.calls.some(([event]) => event.detail.busy === false)).toBe(true));
    await waitFor(() => expect(sessionRuns).toHaveBeenCalledWith(expect.objectContaining({ detail: { projectId: 7, runningBySession: { 'fixture-session': false, 'second-session': false } } })));
    expect(modelA).not.toHaveBeenCalled(); expect(modelB).not.toHaveBeenCalled();
    render(<DshConversationHost projectId={7} sessionId="fixture-session" />);
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveTextContent('first.md'));
  } finally {
    cleanup(); await disposeDshClients(); window.removeEventListener('mind:dsh-project-busy', busy); window.removeEventListener('mind:dsh-session-runs', sessionRuns);
    fixture.catalog = false; fixture.dual = false;
    if (fontsDescriptor) Object.defineProperty(document, 'fonts', fontsDescriptor); else Reflect.deleteProperty(document, 'fonts');
  }
});

it('invalidates the Session catalog for title, create, delete and order changes without status churn or subscribe replay', async () => {
  fixture.catalog = true; fixture.dual = true;
  const client = await createDshClient(7);
  const changes = vi.fn();
  try {
    await waitFor(() => expect(client.ctx.sessions.list.getSnapshot().ids).toHaveLength(2));
    client.subscribe(type => { if (type === 'sessionsChanged') changes(); });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(changes).not.toHaveBeenCalled();
    const emit = async (event: string, args: unknown[]) => {
      fixture.emitEvent!({ type: 'emit', event, args });
      await new Promise(resolve => setTimeout(resolve, 0));
    };
    await emit('api-session/status', ['fixture-session', true]);
    expect(changes).not.toHaveBeenCalled();
    const summary = { sessionId: 'fixture-session', updatedAt: 1, running: true, blank: false, agentAvailable: true, cwd: '/fixture/project' };
    await emit('api-session/added', [{ ...summary, projections: { kind: 'sequenced', asOfSeq: 1, values: { title: 'Automatic title' } } }]);
    await waitFor(() => expect(changes).toHaveBeenCalledTimes(1));
    // Replayed metadata does not invalidate a second time.
    await emit('api-session/added', [{ ...summary, projections: { kind: 'sequenced', asOfSeq: 1, values: { title: 'Automatic title' } } }]);
    expect(changes).toHaveBeenCalledTimes(1);
    await emit('api-session/added', [{ ...summary, sessionId: 'new-session', running: false, updatedAt: 2 }]);
    await waitFor(() => expect(changes).toHaveBeenCalledTimes(2));
    await emit('api-session/removed', ['new-session']);
    await waitFor(() => expect(changes).toHaveBeenCalledTimes(3));
    await emit('api-session/activity', ['second-session', 3]);
    await waitFor(() => expect(changes).toHaveBeenCalledTimes(4));
    // Several catalog writes in a turn publish one invalidation.
    client.ctx.sessions.handleSessionAdded({ ...summary, sessionId: 'batch-a', updatedAt: 4 });
    client.ctx.sessions.handleSessionAdded({ ...summary, sessionId: 'batch-b', updatedAt: 5 });
    await waitFor(() => expect(changes).toHaveBeenCalledTimes(5));
    const late = vi.fn();
    client.subscribe(type => { if (type === 'sessionsChanged') late(); });
    expect(late).not.toHaveBeenCalled();
    client.ctx.sessions.handleSessionRemoved('batch-a');
    await client.dispose();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(changes).toHaveBeenCalledTimes(5);
  } finally { await client.dispose(); fixture.catalog = false; fixture.dual = false; }
});

it('publishes exact Session running facts from the original catalog and clears on disposal', async () => {
  fixture.catalog = true; fixture.dual = true;
  const client = await createDshClient(7); const listener = vi.fn();
  try {
    await waitFor(() => expect(client.ctx.sessions.list.getSnapshot().byId['second-session']).toBeDefined());
    client.subscribe(listener);
    expect(listener).toHaveBeenCalledWith('sessionRuns', { 'fixture-session': false, 'second-session': false });
    fixture.emitEvent!({ type: 'emit', event: 'api-session/status', args: ['fixture-session', true] });
    await waitFor(() => expect(listener).toHaveBeenCalledWith('sessionRuns', { 'fixture-session': true, 'second-session': false }));
    fixture.emitEvent!({ type: 'emit', event: 'api-session/status', args: ['fixture-session', false] });
    await waitFor(() => expect(listener.mock.calls.filter(call => call[0] === 'sessionRuns').at(-1)?.[1]).toEqual({ 'fixture-session': false, 'second-session': false }));
    await client.dispose();
    expect(listener.mock.calls.filter(call => call[0] === 'sessionRuns').at(-1)?.[1]).toEqual({});
  } finally { await client.dispose(); fixture.catalog = false; fixture.dual = false; }
});
