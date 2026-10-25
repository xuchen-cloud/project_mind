import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { bindContext } from '../scripts/project-workspace.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mind-shared-contexts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = await realpath(root);
  const project = path.join(directory, 'project'); await mkdir(project);
  const rows = [{ sessionId: 'workspace-session', cwd: directory, agentAvailable: false },
    { sessionId: 'project-session', cwd: project, agentAvailable: false }];
  const records = new Map(), handlers = new Map(), hydrated = [], created = [];
  const ctx = {
    workspaceRegistry: { archivedSessionIds: [], pinnedSessionIds: [], get: id => records.get(id) },
    workspaceController: {
      async create({ path: directory }) {
        let record = [...records.values()].find(row => row.path === directory);
        if (!record) { const id = `workspace-${records.size}`; record = { id, path: directory, title: path.basename(directory), sessionIds: [], async setTitle(title) { this.title = title; }, async attachSession(id) { this.sessionIds.push(id); } }; records.set(id, record); }
        return { workspace: { workspaceId: record.id, ...record } };
      },
      async rename({ workspaceId, title }) { if ([...records.values()].some(row => row.id !== workspaceId && row.title === title)) throw new Error('Workspace name conflict'); records.get(workspaceId).title = title; },
    },
    sessionController: {
      async list() { return { items: rows }; },
      async projections({ sessionId }) { hydrated.push(sessionId); return { asOfSeq: 2, values: { title: sessionId } }; },
      async create(request) { created.push(request); return { sessionId: 'new' }; },
      follow() {},
    },
    connection: { fetch: { register(route) { handlers.set(route.path, route.fetch); } } }, effect() {}, emit() {},
  };
  const workspace = { kind: 'workspace', id: '0123456789abcdef0123456789abcdef', name: 'Mind', directory };
  const contexts = await bindContext(ctx, workspace);
  const rpc = async (method, request) => {
    const response = await handlers.get(`/api/${method}`)(new Request(`http://localhost/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload: { args: { request } } }) }));
    return (await response.json()).result;
  };
  return { ctx, contexts, rpc, workspace, project: { kind: 'project', id: 17, name: 'Project', directory: project }, hydrated, created, rows };
}

test('one registry routes two native scopes and hydrates only the requested scope', async t => {
  const f = await fixture(t);
  assert.equal((await f.rpc('mind/context', { context: f.project })).ok, true);
  const list = await f.rpc('mind/session/list', { context: f.project });
  assert.equal(list.ok, true);
  assert.deepEqual(list.value.items.map(row => row.sessionId), ['project-session']);
  assert.deepEqual(f.hydrated, ['project-session']);
  assert.equal((await f.contexts.forSession('workspace-session')).kind, 'workspace');
  assert.equal((await f.contexts.forSession('project-session')).id, 17);
  assert.equal((await f.rpc('mind/session/create', { context: f.project })).ok, true);
  assert.deepEqual(f.created, [{ workspaceId: 'workspace-1' }]);
  const foreign = await f.rpc('mind/session/delete', { context: f.workspace, sessionId: 'project-session' });
  assert.equal(foreign.ok, false);
  assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, []);
});

test('shared attachment access follows persisted message references in the requested scope', async t => {
  const f = await fixture(t);
  await f.rpc('mind/context', { context: f.project });
  const foreign = path.join(f.project.directory, 'private.png');
  const own = path.join(f.workspace.directory, 'owned.png');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(foreign, 'image'); await writeFile(own, 'image');
  f.ctx.attachments = { imageHostPath: ref => ref.attachmentId === 'workspace-image' ? own : foreign };
  f.ctx.sessionController.inspect = async sessionId => ({ events: [{ type: 'user/message', surfaceOp: 'append', seq: 1, data: { id: 'message', role: 'user', content: [{ type: 'image', attachment: { attachmentId: sessionId === 'workspace-session' ? 'workspace-image' : 'project-image' } }], timestamp: 1, source: { kind: 'user' } } }] });
  assert.deepEqual((await f.rpc('mind/session/fileAccess', { context: f.workspace, path: own })).value, { allowed: true });
  assert.deepEqual((await f.rpc('mind/session/fileAccess', { context: f.workspace, path: foreign })).value, { allowed: false });
});


test('native scopes with the same display name retain separate registry identities', async t => {
  const f = await fixture(t);
  const registered = await f.rpc('mind/context', { context: { ...f.project, name: f.workspace.name } });
  assert.equal(registered.ok, true);
  assert.notEqual((await f.contexts.forSession('project-session')).workspaceId, (await f.contexts.forSession('workspace-session')).workspaceId);
});
