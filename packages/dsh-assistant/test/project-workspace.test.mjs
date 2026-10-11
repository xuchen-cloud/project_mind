import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bindProject, readProject } from '../scripts/project-workspace.mjs';

test('native project frame resolves an existing absolute directory', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mind-project-frame-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await readProject(JSON.stringify({ project: { id: 1, name: ' Project ', directory } })),
    { id: 1, name: 'Project', directory: await realpath(directory) });
});

test('project identity and directory must be explicit and valid', async () => {
  for (const project of [undefined, { id: 0, name: 'A', directory: tmpdir() },
    { id: 1.5, name: 'A', directory: tmpdir() }, { id: 1, name: ' ', directory: tmpdir() },
    { id: 1, name: 'A', directory: 'relative' }]) {
    await assert.rejects(readProject(JSON.stringify({ project })), /Invalid main project configuration/);
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
  await bindProject(ctx, { id: 1, name: 'Project', directory: canonical });
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
  await assert.rejects(bindProject(ctx, { id: 1, name: 'Project', directory }), /stored cwd mismatch/);
});
