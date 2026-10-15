import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  const directory = await mkdtemp(path.join(tmpdir(), 'mind-project-reconcile-error-'));
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
  await assert.rejects(readContext(JSON.stringify({ workspace: { id: workspaceId, name: 'Workspace', directory: new URL(import.meta.url).pathname } })), /directory is unavailable/);
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
  ctx.sessionController.projections = async () => { throw new Error('Durable projection unavailable'); };
  await assert.rejects(ctx.sessionController.list({}, signal), /Durable projection unavailable/);
  ctx.sessionController.projections = async () => {
    ctx.workspaceRegistry.archivedSessionIds.push('cold');
    return { asOfSeq: 3, values: { title: 'Durable renamed title' } };
  };
  assert.ok(!(await ctx.sessionController.list({}, signal)).items.some(item => item.sessionId === 'cold'));
});
