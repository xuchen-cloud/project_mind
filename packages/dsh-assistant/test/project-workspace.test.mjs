import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindContext, readContext } from '../scripts/project-workspace.mjs';

test('native project frame resolves an existing absolute directory', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mind-project-frame-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await readContext(JSON.stringify({ project: { id: 1, name: ' Project ', directory } })),
    { kind: 'project', id: 1, name: 'Project', directory: await realpath(directory) });
});

test('project identity and directory must be explicit and valid', async () => {
  for (const project of [undefined, { id: 0, name: 'A', directory: tmpdir() },
    { id: 1.5, name: 'A', directory: tmpdir() }, { id: 1, name: ' ', directory: tmpdir() },
    { id: 1, name: 'A', directory: 'relative' }]) {
    await assert.rejects(readContext(JSON.stringify({ project })), /Invalid main (project|context) configuration/);
  }
});

test('startup restores only unaccounted current-project sessions through the registry', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mind-project-reconcile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const canonical = await realpath(directory);
  const attached = [];
  const mapped = {
    id: 'mapped', path: canonical, title: 'Project', sessionIds: ['owned'],
    async attachSession(id) { attached.push(id); this.sessionIds.push(id); },
  };
  const ctx = {
    workspaceRegistry: { get: id => { assert.equal(id, 'mapped'); return mapped; }, archivedSessionIds: ['removed'] },
    workspaceController: { create: async () => ({ workspace: { workspaceId: 'mapped', title: 'Project' } }) },
    sessionController: { list: async () => ({ items: [
      { sessionId: 'orphan', cwd: canonical }, { sessionId: 'owned', cwd: canonical },
      { sessionId: 'removed', cwd: canonical }, { sessionId: 'foreign', cwd: `${canonical}/other` },
    ] }) },
    connection: { fetch: { register() {} } }, effect() {},
  };
  await bindContext(ctx, { id: 1, name: 'Project', directory: canonical });
  assert.deepEqual(attached, ['orphan']);
  assert.deepEqual((await ctx.workspaceController.initializeDefault()).workspace.sessionIds, ['owned', 'orphan']);
});

test('startup reports registry attach failure rather than publishing fake membership', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'mind-project-reconcile-error-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ctx = {
    workspaceRegistry: { archivedSessionIds: [], get: () => ({ sessionIds: [], attachSession: async () => { throw new Error('stored cwd mismatch'); } }) },
    workspaceController: { create: async () => ({ workspace: { workspaceId: 'mapped' } }) },
    sessionController: { list: async () => ({ items: [{ sessionId: 'orphan', cwd: directory }] }) },
  };
  await assert.rejects(bindContext(ctx, { id: 1, name: 'Project', directory }), /stored cwd mismatch/);
});

const workspaceId = '00bc24e8-bd28-4a46-967b-29cb0ae4aa41';

test('native Workspace frame binds the real Workspace identity and directory', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mind-workspace-frame-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await readContext(JSON.stringify({ workspace: { id: workspaceId, name: ' Workspace ', directory } })),
    { kind: 'workspace', id: workspaceId, name: 'Workspace', directory: await realpath(directory) });
});

test('native Workspace frame accepts the persisted 32 hexadecimal identity', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mind-native-workspace-frame-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const id = '0123456789abcdef0123456789abcdef';
  assert.deepEqual(await readContext(JSON.stringify({ workspace: { id, name: ' Native Workspace ', directory } })),
    { kind: 'workspace', id, name: 'Native Workspace', directory: await realpath(directory) });
  for (const invalidId of ['a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32), '../' + 'a'.repeat(32), '工作区'.repeat(11)]) {
    await assert.rejects(readContext(JSON.stringify({ workspace: { id: invalidId, name: 'Native', directory } })), /Invalid main workspace configuration/);
  }
});

test('configure rejects ambiguous scopes and malformed Workspace frames', async () => {
  const workspace = { id: workspaceId, name: 'Workspace', directory: tmpdir() };
  const project = { id: 1, name: 'Project', directory: tmpdir() };
  for (const frame of [null, [], {}, { workspace, project }, { workspace, project: null },
    { project, workspace: null }, ...[null, {}, { ...workspace, id: 0 }, { ...workspace, id: ' ' },
      { ...workspace, id: 'not-a-uuid' }, { ...workspace, name: ' ' },
      { ...workspace, directory: 'relative' }].map(workspace => ({ workspace }))]) {
    await assert.rejects(readContext(JSON.stringify(frame)), /Invalid main .*configuration/);
  }
  await assert.rejects(readContext('{'), /Invalid main .*configuration/);
});

test('configure rejects missing paths and files as directories', async () => {
  await assert.rejects(readContext(JSON.stringify({ workspace: { id: workspaceId, name: 'Workspace', directory: '/nonexistent/mind-workspace' } })));
  await assert.rejects(readContext(JSON.stringify({ workspace: { id: workspaceId, name: 'Workspace', directory: fileURLToPath(import.meta.url) } })), /directory is unavailable/);
});

test('Workspace binding rejects other directories and workspace IDs while retaining upstream session creation', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mind-workspace-bind-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const canonical = await realpath(directory);
  const created = [];
  const mapped = { id: 'mapped', path: canonical, title: 'Workspace', sessionIds: [] };
  const ctx = {
    workspaceRegistry: { get: () => mapped, archivedSessionIds: ['removed'] },
    workspaceController: { create: async () => ({ workspace: { workspaceId: 'mapped', title: 'Workspace' } }) },
    sessionController: {
      list: async () => ({ items: [] }), create: async request => { created.push(request); return { sessionId: 'new' }; },
      follow: () => 'upstream-follow',
    },
    connection: { fetch: { register() {} } }, effect() {},
  };
  await bindContext(ctx, { kind: 'workspace', id: workspaceId, name: 'Workspace', directory: canonical });
  assert.equal((await ctx.workspaceController.initializeDefault()).workspace.path, canonical);
  await assert.rejects(ctx.workspaceController.create({ path: tmpdir() }), /main application navigation/);
  await assert.rejects(ctx.workspaceController.rename({}), /main application/);
  await assert.rejects(ctx.workspaceController.delete({}), /main application/);
  await assert.rejects(ctx.sessionController.create({ cwd: tmpdir() }), /another context/);
  await assert.rejects(ctx.sessionController.create({ workspaceId: 'foreign' }), /another context/);
  await assert.rejects(ctx.sessionController.create({ sessionId: 'removed' }), /removed/);
  assert.throws(() => ctx.sessionController.follow({ sessionId: 'removed' }), /removed/);
  assert.deepEqual(created, []);
  assert.deepEqual(await ctx.sessionController.create({ cwd: canonical }), { sessionId: 'new' });
  assert.deepEqual(created, [{ workspaceId: 'mapped' }]);
});


test('session list projects durable pins in registry order and keeps unpinned order and archived filtering', async () => {
  const directory = await realpath(tmpdir());
  const items = ['plain-a', 'pin-a', 'removed', 'plain-b', 'pin-b'].map(sessionId => ({ sessionId, cwd: directory, title: sessionId }));
  const registry = {
    get: () => ({ sessionIds: items.map(item => item.sessionId) }),
    archivedSessionIds: ['removed'], pinnedSessionIds: ['missing', 'pin-b', 'removed', 'pin-a'],
  };
  const ctx = {
    workspaceRegistry: registry,
    workspaceController: { create: async () => ({ workspace: { workspaceId: 'mapped', title: 'Project' } }) },
    sessionController: { list: async () => ({ items, cursor: 'retained' }) },
    connection: { fetch: { register() {} } }, effect() {},
  };
  await bindContext(ctx, { id: 1, name: 'Project', directory });
  const list = await ctx.sessionController.list({});
  assert.equal(list.cursor, 'retained');
  assert.deepEqual(list.items.map(({ sessionId, pinned }) => [sessionId, pinned]), [
    ['pin-b', true], ['pin-a', true], ['plain-a', false], ['plain-b', false],
  ]);
  assert.deepEqual(items.map(item => item.sessionId), ['plain-a', 'pin-a', 'removed', 'plain-b', 'pin-b']);
  assert.ok(items.every(item => !Object.hasOwn(item, 'pinned')));
  registry.pinnedSessionIds = ['plain-b'];
  assert.deepEqual((await ctx.sessionController.list({})).items.map(({ sessionId, pinned }) => [sessionId, pinned]), [
    ['plain-b', true], ['plain-a', false], ['pin-a', false], ['pin-b', false],
  ]);
});

test('cold owned sessions load durable title through public projections instead of stale list hints', async () => {
  const directory = await realpath(tmpdir());
  const signal = AbortSignal.timeout(1000);
  const loaded = [];
  const items = [
    { sessionId: 'cold', cwd: directory, agentAvailable: false, projections: { kind: 'cached', asOfSeq: 0, values: { title: 'Old hint' } } },
    { sessionId: 'live', cwd: directory, agentAvailable: true, projections: { kind: 'sequenced', asOfSeq: 2, values: { title: 'Live title' } } },
    { sessionId: 'foreign', cwd: `${directory}/foreign`, agentAvailable: false },
    { sessionId: 'removed', cwd: directory, agentAvailable: false },
  ];
  const ctx = {
    workspaceRegistry: { get: () => ({ sessionIds: items.map(item => item.sessionId) }), archivedSessionIds: ['removed'], pinnedSessionIds: [] },
    workspaceController: { create: async () => ({ workspace: { workspaceId: 'mapped', title: 'Project' } }) },
    sessionController: {
      list: async () => ({ items }),
      projections: async (request, actualSignal) => {
        loaded.push(request); assert.equal(actualSignal, signal);
        return { asOfSeq: 3, values: { title: 'Durable renamed title' } };
      },
    },
    connection: { fetch: { register() {} } }, effect() {},
  };
  await bindContext(ctx, { id: 1, name: 'Project', directory });
  const list = await ctx.sessionController.list({}, signal);
  assert.deepEqual(loaded, [{ sessionId: 'cold' }]);
  assert.deepEqual(list.items[0].projections, { kind: 'sequenced', asOfSeq: 3, values: { title: 'Durable renamed title' } });
  assert.equal(list.items[1].projections.values.title, 'Live title');
  assert.equal(items[0].projections.values.title, 'Old hint');
  items[0].updatedAt = 1; // A changed catalog row invalidates the cached title.
  ctx.sessionController.projections = async () => { throw new Error('Durable projection unavailable'); };
  await assert.rejects(ctx.sessionController.list({}, signal), /Durable projection unavailable/);
  ctx.sessionController.projections = async () => {
    ctx.workspaceRegistry.archivedSessionIds.push('cold');
    return { asOfSeq: 3, values: { title: 'Durable renamed title' } };
  };
  assert.ok(!(await ctx.sessionController.list({}, signal)).items.some(item => item.sessionId === 'cold'));
});

async function indexedFixture(t, count = 100, persistence = false) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'mind-indexed-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rows = Array.from({ length: count }, (_, index) => ({ sessionId: `s${index}`, cwd: directory, agentAvailable: false, updatedAt: 1000 }));
  const handlers = new Map(), routes = new Map();
  const record = { sessionIds: rows.map(row => row.sessionId) };
  let lists = 0, projections = 0;
  const ctx = {
    workspaceRegistry: { get: () => record, archivedSessionIds: [], pinnedSessionIds: [] },
    workspaceController: { create: async () => ({ workspace: { workspaceId: 'mapped' } }) },
    sessionController: {
      list: async () => { lists++; await ctx.catalogRead?.(); return { items: structuredClone(rows) }; },
      projections: async ({ sessionId }) => { projections++; return { asOfSeq: 1, values: { title: sessionId } }; },
    },
    on(event, listener) { const set = handlers.get(event) ?? []; set.push(listener); handlers.set(event, set); },
    emit(event, ...args) { for (const listener of handlers.get(event) ?? []) listener(...args); },
    connection: { fetch: { register(route) { routes.set(route.path, route.fetch); } } }, effect(setup) { t.after(setup()); },
  };
  const registry = await bindContext(ctx, { kind: 'project', id: 1, name: 'Project', directory }, persistence ? { home: directory } : {});
  return { ctx, registry, rows, record, routes, directory, lists: () => lists, projections: () => projections };
}

test('ownership index bounds real search and multi-consumer event directory reads', async t => {
  const { searchContextSessions } = await import('../scripts/context-session-reads.mjs');
  const f = await indexedFixture(t);
  let reads = 0;
  f.ctx.sessionQuery = { async filterEvents() { reads++; return []; } };
  const baseline = f.lists();
  await searchContextSessions(f.ctx, f.registry, f.registry.workspace, { query: 'missing' });
  assert.equal(reads, 100);
  assert.ok(f.lists() - baseline <= 2, `directory reads: ${f.lists() - baseline}`);
  const beforeEvents = f.lists();
  for (let event = 0; event < 100; event++) {
    await Promise.all(Array.from({ length: 5 }, () => f.registry.scopeForSession(`s${event}`)));
  }
  assert.equal(f.lists(), beforeEvents);
});

test('cold title projection is reused until committed content changes', async t => {
  const f = await indexedFixture(t);
  await f.ctx.sessionController.list({ cwd: f.directory });
  await f.ctx.sessionController.list({ cwd: f.directory });
  assert.equal(f.projections(), 100);
  f.ctx.emit('session/event', { id: 's0' }, { type: 'session/title' });
  await f.ctx.sessionController.list({ cwd: f.directory });
  assert.equal(f.projections(), 101);
});

test('ownership index observes creation, disposal, archive and ownership change across I/O', async t => {
  const f = await indexedFixture(t, 1);
  await f.registry.forSession('s0');
  f.rows.push({ sessionId: 'new', cwd: f.directory });
  f.ctx.emit('session/created', { id: 'new', header: { cwd: f.directory } });
  assert.equal((await f.registry.forSession('new')).id, 1);
  f.rows[0].cwd = '/foreign';
  f.ctx.emit('session/disposed', { id: 's0' });
  await assert.rejects(f.registry.forSession('s0'), /another context/);
  f.ctx.workspaceRegistry.archivedSessionIds.push('new');
  await assert.rejects(f.registry.forSession('new'), /removed/);
});

test('committed archive and scope revocation win before registry entities catch up', async t => {
  const f = await indexedFixture(t, 1);
  await f.registry.forSession('s0');
  f.ctx.emit('domain/changed', { domain: 'workspace', table: '', operation: 'put', value: { archivedSessionIds: ['s0'] } });
  await assert.rejects(f.registry.forSession('s0'), /removed/);
  f.ctx.emit('domain/changed', { domain: 'workspace', table: '', operation: 'put', value: { archivedSessionIds: [] } });
  assert.equal((await f.registry.forSession('s0')).id, 1);
  f.ctx.emit('domain/changed', { domain: 'workspace', table: 'workspaces', key: 'mapped', operation: 'put', value: { path: '/elsewhere' } });
  await assert.rejects(f.registry.forSession('s0'), /another context/);
  assert.throws(() => f.registry.select(f.registry.workspace), /not registered/);
  f.ctx.emit('domain/changed', { domain: 'workspace', table: 'workspaces', key: 'mapped', operation: 'put', value: { path: f.directory } });
  assert.equal((await f.registry.forSession('s0')).id, 1);
  f.ctx.emit('domain/changed', { domain: 'workspace', table: 'workspaces', key: 'mapped', operation: 'deleted' });
  await assert.rejects(f.registry.forSession('s0'), /another context/);
});

test('directory reads join safely across cancellation and retry invalidated in-flight results', async t => {
  const f = await indexedFixture(t, 1);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.ctx.catalogRead = () => gate;
  const controller = new AbortController();
  const cancelled = f.registry.forSession('s0', controller.signal);
  const surviving = f.registry.forSession('s0');
  controller.abort(new Error('caller cancelled'));
  await assert.rejects(cancelled, /caller cancelled/);
  f.rows[0].cwd = '/foreign';
  f.ctx.emit('session/disposed', { id: 's0' });
  f.ctx.catalogRead = undefined; release();
  await assert.rejects(surviving, /another context/);
  assert.ok(f.lists() <= 3);
});

test('a title changed while another title loads cannot publish a stale list', async t => {
  const f = await indexedFixture(t, 2);
  const projections = f.ctx.sessionController.projections;
  f.ctx.sessionController.projections = async request => {
    if (request.sessionId === 's1') f.ctx.emit('session/event', { id: 's0' }, { type: 'session/title' });
    return projections(request);
  };
  await assert.rejects(f.ctx.sessionController.list({ cwd: f.directory }), /changed while/);
});

async function rpcFixture(f, method, request) {
  const response = await f.routes.get(`/api/${method}`)(new Request(`http://localhost/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload: { args: { request } } }) }));
  return (await response.json()).result;
}

test('real inventory RPC accepts the native serialized null option shape', async t => {
  const f = await indexedFixture(t, 1);
  const result = await rpcFixture(f, 'mind/session/inventory', {
    context: { kind: 'project', id: 1 }, authorization: 'native-grant',
    input: { scope: { kind: 'project', projectId: 1 }, mode: 'metadata', ids: [], titleQuery: null, contentQuery: null, tag: null, tagIds: [], cursor: null, limit: null, budgetChars: null },
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.page.totalCount, 1);
});

test('attachment misses reuse projected paths and content/archive events revoke hits', async t => {
  const { writeFile } = await import('node:fs/promises');
  const f = await indexedFixture(t, 20);
  const requested = path.join(f.directory, 'shared.png'); await writeFile(requested, 'image');
  let inspected = 0, referenced = false;
  f.ctx.attachments = { imageHostPath: () => requested };
  f.ctx.sessionController.inspect = async () => { inspected++; return { events: referenced ? [{ type: 'user/message', surfaceOp: 'append', data: { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'shared' } }] } }] : [] }; };
  const request = () => rpcFixture(f, 'mind/session/fileAccess', { context: { kind: 'project', id: 1 }, path: requested });
  assert.deepEqual((await request()).value, { allowed: false });
  assert.deepEqual((await request()).value, { allowed: false });
  assert.equal(inspected, 20);
  referenced = true;
  f.ctx.emit('session/event', { id: 's0' }, { type: 'user/message' });
  assert.deepEqual((await request()).value, { allowed: true });
  assert.equal(inspected, 21);
  f.ctx.emit('domain/changed', { domain: 'workspace', table: '', operation: 'put', value: { archivedSessionIds: f.rows.map(row => row.sessionId) } });
  assert.deepEqual((await request()).value, { allowed: false });
});

test('five real scoped event wrappers route 100 events with one shared catalog read', async t => {
  const { mkdir } = await import('node:fs/promises');
  const { installContextStreams } = await import('../scripts/context-streams.mjs');
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mind-event-index-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contexts = [];
  for (let index = 0; index < 5; index++) {
    const directory = path.join(root, String(index)); await mkdir(directory);
    contexts.push({ kind: 'project', id: index + 1, name: `Project ${index + 1}`, directory });
  }
  const rows = Array.from({ length: 100 }, (_, index) => ({ sessionId: `s${index}`, cwd: contexts[index % 5].directory }));
  const records = new Map(), listeners = new Map(); let lists = 0;
  const ctx = {
    workspaceController: { async create({ path: directory }) {
      const id = `w${records.size}`;
      records.set(id, { id, path: directory, sessionIds: [], async attachSession(id) { this.sessionIds.push(id); } });
      return { workspace: { workspaceId: id } };
    } },
    workspaceRegistry: { archivedSessionIds: [], get: id => records.get(id) },
    sessionController: { async list() { lists++; return { items: rows }; } },
    connection: { fetch: { register() {} } }, effect() {},
    on(name, listener) { const all = listeners.get(name) ?? []; all.push(listener); listeners.set(name, all); },
    typertGateway: {
      async openWireStream() { return (async function* () { for (let index = 0; index < 100; index++) yield { type: 'emit', event: 'api-session/status', args: ['s0', true] }; })(); },
      async dispatchRpc() {},
    },
  };
  const registry = await bindContext(ctx, contexts[0]);
  for (const context of contexts.slice(1)) await registry.register(context);
  installContextStreams(ctx, registry);
  lists = 0;
  const counts = await Promise.all(contexts.map(async context => {
    let count = 0;
    const stream = await ctx.typertGateway.openWireStream('$events', { mindContext: context });
    for await (const _ of stream) count++;
    return count;
  }));
  assert.deepEqual(counts, [100, 0, 0, 0, 0]);
  assert.equal(lists, 1);
});

test('a live conversation event does not abort unrelated cold title loads', async t => {
  const f = await indexedFixture(t, 2);
  f.rows[1].agentAvailable = true;
  const projections = f.ctx.sessionController.projections;
  f.ctx.sessionController.projections = async request => {
    f.ctx.emit('session/event', { id: 's1' }, { type: 'assistant/message' });
    return projections(request);
  };
  assert.equal((await f.ctx.sessionController.list({ cwd: f.directory })).items.length, 2);
});

test('register rejects changing a bound context directory and retains only its original mapping', async t => {
  const { mkdir } = await import('node:fs/promises');
  const f = await indexedFixture(t, 1);
  const moved = path.join(f.directory, 'moved'); await mkdir(moved);
  await assert.rejects(f.registry.register({ ...f.registry.workspace, directory: moved }), /directory changed/);
  assert.equal((await f.registry.forSession('s0')).directory, f.directory);
  assert.throws(() => f.registry.select({ ...f.registry.workspace, directory: moved }), /not registered/);
});

test('changed activity cannot reuse a matching but stale title hint', async t => {
  const f = await indexedFixture(t, 1);
  f.rows[0].projections = { kind: 'cached', asOfSeq: 1, values: { title: 's0' } };
  await f.ctx.sessionController.list({ cwd: f.directory });
  f.rows[0].updatedAt++;
  f.ctx.sessionController.projections = async () => ({ asOfSeq: 2, values: { title: 'Renamed externally' } });
  const result = await f.ctx.sessionController.list({ cwd: f.directory });
  assert.equal(result.items[0].projections.values.title, 'Renamed externally');
});

test('a refresh arriving during an older pending read requires a fresh catalog generation', async t => {
  const f = await indexedFixture(t, 1);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  // The old backend read owns its earlier snapshot until its I/O completes.
  let first = true;
  f.ctx.catalogRead = async () => { if (first) { first = false; started(); await gate; } };
  const earlier = f.registry.forSession('s0');
  await ready;
  const before = f.lists();
  const refreshed = f.ctx.sessionController.list({ cwd: f.directory });
  release(); await earlier; await refreshed;
  assert.equal(f.lists() - before, 1, 'refresh must start another read after the old in-flight one');
});

test('external Session JSONL writes invalidate ownership and title reads without ctx events', async t => {
  const { mkdir, writeFile, readFile, unlink } = await import('node:fs/promises');
  const f = await indexedFixture(t, 1, true);
  const logs = path.join(f.directory, 'sessions', 'external'); await mkdir(logs, { recursive: true });
  const file = path.join(logs, 's0.jsonl');
  await writeFile(file, JSON.stringify(f.rows[0]) + '\n');
  // File-backed catalogue simulates the public listing seam while the actual
  // home watcher receives physical JSONL writes, with no ctx.emit call.
  f.ctx.catalogRead = async () => {
    try { f.rows.splice(0, f.rows.length, JSON.parse(await readFile(file, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') f.rows.splice(0); else throw error; }
  };
  await f.registry.forSession('s0');
  const waitRevision = async revision => {
    const deadline = performance.now() + 2000;
    while (f.registry.revision() === revision && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.notEqual(f.registry.revision(), revision);
  };
  let revision = f.registry.revision();
  await writeFile(file, JSON.stringify({ ...f.rows[0], cwd: '/foreign' }) + '\n');
  await waitRevision(revision);
  await assert.rejects(f.registry.forSession('s0'), /another context/);
  revision = f.registry.revision();
  await unlink(file); await waitRevision(revision);
  await assert.rejects(f.registry.forSession('s0'), /another context/);
  revision = f.registry.revision();
  await writeFile(file, JSON.stringify({ sessionId: 'new', cwd: f.directory }) + '\n');
  await waitRevision(revision);
  assert.equal((await f.registry.forSession('new')).id, 1);
});

test('bounded reconciliation validates persistence revisions even when summary hints do not change', async t => {
  const f = await indexedFixture(t, 1);
  let revision = 'one';
  f.ctx.sessionPersistence = { async list() { return [{ header: { id: 's0', cwd: f.directory }, revision }]; } };
  await f.ctx.sessionController.list({ cwd: f.directory });
  assert.equal(f.projections(), 1);
  revision = 'two'; // e.g. assistant text/title edit with unchanged lastPromptAt.
  const now = performance.now();
  t.mock.method(performance, 'now', () => now + 6000);
  await f.registry.forSession('s0');
  await f.ctx.sessionController.list({ cwd: f.directory });
  assert.equal(f.projections(), 2);
});

async function persistedStreamFixture(t) {
  const { Context } = await import('@deepseek-ai/cordis');
  const { default: SessionStore } = await import('@deepseek-ai/dsh-session');
  const { default: Persistence } = await import('@deepseek-ai/dsh-session-persistence-jsonl');
  const { default: SessionQuery } = await import('@deepseek-ai/dsh-session-query');
  const { default: Projections } = await import('@deepseek-ai/dsh-session-projection');
  const { default: SessionController } = await import('@deepseek-ai/dsh-api-session-controller');
  const { mkdir } = await import('node:fs/promises');
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mind-persisted-stream-')));
  const home = path.join(root, 'home'); await mkdir(home);
  const ctx = new Context();
  let writer, detach;
  t.after(async () => { detach?.(); await writer?.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  await ctx.plugin(SessionStore);
  await ctx.plugin(Persistence, { root: path.join(home, 'sessions'), compression: 'none' });
  await ctx.plugin(SessionQuery); await ctx.plugin(Projections);
  ctx.provide('agents', { get() {} });
  ctx.provide('typert', { lookups: { configure() {} }, contexts: { configureHost() {} } });
  ctx.provide('fileUploads', { registerAgentResolver() { return () => {}; } });
  ctx.provide('connection', { fetch: { register() {} } });
  const records = new Map();
  ctx.provide('workspaceRegistry', { get: id => records.get(id), archivedSessionIds: [], pinnedSessionIds: [] });
  ctx.provide('workspaceController', { async create({ path: directory }) {
    const id = `w${records.size}`;
    records.set(id, { id, path: directory, title: 'Project', sessionIds: [], async attachSession(id) { this.sessionIds.push(id); } });
    return { workspace: { workspaceId: id } };
  } });
  new SessionController(ctx, { nativeOpen: false });
  let lists = 0, artifacts = 0;
  const list = ctx.sessionPersistence.list, listArtifacts = ctx.sessionPersistence.listArtifacts;
  ctx.sessionPersistence.list = function (...args) { lists++; return list.apply(this, args); };
  ctx.sessionPersistence.listArtifacts = function (...args) { artifacts++; return listArtifacts.apply(this, args); };
  const contexts = [];
  for (let index = 0; index < 5; index++) {
    const directory = path.join(root, String(index)); await mkdir(directory);
    contexts.push({ kind: 'project', id: index + 1, name: 'Project', directory });
  }
  const session = ctx.sessions.prepare('streaming', { meta: { cwd: contexts[0].directory } });
  writer = await ctx.sessionPersistence.create(session.header);
  detach = ctx.sessions.enter(session); ctx.sessions.announce(session);
  await ctx.sessions.flush(session);
  const registry = await bindContext(ctx, contexts[0], { home });
  for (const context of contexts.slice(1)) await registry.register(context);
  return { ctx, registry, session, writer, home, contexts,
    counts: () => ({ lists, artifacts }), reset() { lists = artifacts = 0; } };
}

test('real JSONL home watcher and five stream consumers do not rescan on live durable batches', async t => {
  const { watch } = await import('node:fs');
  const { installContextStreams } = await import('../scripts/context-streams.mjs');
  const f = await persistedStreamFixture(t);
  let writes = 0;
  const notifications = [];
  const watched = watch(f.home, { recursive: true }, (_event, filename) => {
    notifications.push([_event, String(filename)]);
    if (String(filename).endsWith('.jsonl')) writes++;
  });
  t.after(() => watched.close());
  const consumers = Array.from({ length: 5 }, () => []);
  f.ctx.provide('typertGateway', { async openWireStream() {
    const queue = consumers.find(items => !items.open); queue.open = true;
    return (async function* () {
      for (let batch = 0; batch < 4; batch++) {
        await queue[batch];
        for (let token = 0; token < 25; token++) yield { type: 'emit', event: 'api-session/status', args: [f.session.id, true] };
      }
    })();
  }, async dispatchRpc() {} });
  const releases = [];
  for (let batch = 0; batch < 4; batch++) {
    const gates = consumers.map(queue => { let resolve; queue.push(new Promise(done => { resolve = done; })); return resolve; });
    releases.push(() => gates.forEach(resolve => resolve()));
  }
  await new Promise(resolve => setTimeout(resolve, 30));
  await f.registry.forSession(f.session.id); f.reset();
  installContextStreams(f.ctx, f.registry);
  const reading = Promise.all(f.contexts.map(async context => {
    let count = 0;
    for await (const _ of await f.ctx.typertGateway.openWireStream('$events', { mindContext: context })) count++;
    return count;
  }));
  for (let batch = 0; batch < 4; batch++) {
    f.session.append('session/title', { title: `Batch ${batch}`, messageSeqs: [], source: { kind: 'user' } });
    await new Promise(resolve => setTimeout(resolve, 240)); // actual pinned 200ms drain
    releases[batch]();
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.deepEqual(await reading, [100, 0, 0, 0, 0]);
  assert.ok(writes >= 4, `real backend must have written each batch (${writes})`);
  assert.deepEqual(f.counts(), { lists: 0, artifacts: 0 }, JSON.stringify({ notifications, location: f.ctx.sessionPersistence.locate(f.session.header) }));
  f.reset();
  await f.ctx.sessionController.list({ cwd: f.contexts[0].directory });
  assert.deepEqual(f.counts(), { lists: 1, artifacts: 1 }, 'one refresh shares the controller persistence listing');
});

test('real cold persistence changes remain visible while known live files are excluded from watcher scans', async t => {
  const { unlink } = await import('node:fs/promises');
  const f = await persistedStreamFixture(t);
  const cold = f.ctx.sessions.prepare('external-cold', { meta: { cwd: f.contexts[0].directory } });
  const waitWatch = async previous => {
    const deadline = performance.now() + 2000;
    while (f.registry.revision() === previous && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.notEqual(f.registry.revision(), previous);
  };
  let previous = f.registry.revision();
  let writer = await f.ctx.sessionPersistence.create(cold.header);
  cold.append('session/title', { title: 'Cold', messageSeqs: [], source: { kind: 'user' } });
  await writer.append(cold.snapshotEvents()); await writer.close();
  await waitWatch(previous);
  assert.equal((await f.registry.forSession(cold.id)).id, 1);
  f.reset();
  previous = f.registry.revision();
  writer = await f.ctx.sessionPersistence.open(cold.id, 'write');
  const changed = cold.append('session/title', { title: 'Cold external edit', messageSeqs: [], source: { kind: 'user' } });
  await writer.append([changed]); await writer.close();
  await waitWatch(previous);
  const contentBeforeRead = f.registry.revision().split(':')[0];
  await f.registry.forSession(cold.id);
  assert.notEqual(f.registry.revision().split(':')[0], contentBeforeRead, 'cold file revision invalidates cached content');
  assert.deepEqual(f.counts(), { lists: 1, artifacts: 1 });
  await unlink(f.ctx.sessionPersistence.locate(cold.header).path);
  // macOS may coalesce unlink with the preceding fsync notification. Exercise
  // the real bounded reconciliation as well as the watcher fast path.
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) {
    try { await f.registry.forSession(cold.id); }
    catch (error) { assert.match(error.message, /another context/); break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await assert.rejects(f.registry.forSession(cold.id), /another context/);
  // Native committed authorization revocation is synchronous, with no clock advance.
  f.ctx.emit('domain/changed', { domain: 'workspace', table: 'workspaces', operation: 'deleted', key: f.registry.workspace.workspaceId });
  await assert.rejects(f.registry.forSession(f.session.id), /another context/);
});
