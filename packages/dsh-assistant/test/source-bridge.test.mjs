import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSourceBridge, installSourceService, sourceProjections, sourceTitleText } from '../scripts/source-bridge.mjs';

function fixedProjection(overrides = {}) {
  const sourceRef = { object: { workspaceId: 'workspace', scope: { kind: 'project', projectId: 7 }, kind: 'file', id: '9' },
    revision: 'sha256:' + 'a'.repeat(64), fileVersion: 1, recordVersion: null, blockId: null,
    locator: { kind: 'line', start: 1, end: 1 }, title: 'fixed.txt', excerpt: '' };
  const metadata = { id: 'fixed-read', sourceRef, offset: 1, limit: 1, requestedLimit: 1,
    truncated: false, content: '1: immutable bytes', ...overrides };
  return `@mind-source/${Buffer.from(JSON.stringify(sourceRef)).toString('base64url')}/fixed.txt\n<mind-file-source>${JSON.stringify(metadata)}</mind-file-source>`;
}

async function sourceStream(request) {
  const handlers = new Map();
  const directory = '/project';
  await installSourceService({
    sessionController: { async list() { return { items: [{ sessionId: 'session', cwd: directory }] }; } },
    connection: { fetch: { register() {} } }, agents: { list() { return []; } },
    on(name, handler) { handlers.set(name, handler); }, effect() {},
  }, { directory }, { request });
  return async messages => {
    const chunks = [];
    for await (const chunk of handlers.get('llm/stream')({ sessionId: 'session', messages }, async function* () {
      yield { type: 'text-delta', text: 'continued' };
    })) chunks.push(chunk);
    return chunks;
  };
}

const textMessage = (id, role, text) => ({ id, role, content: [{ type: 'text', text }] });

test('bash source marker literals do not poison the current or next model turn', async () => {
  const file = fileURLToPath(new URL('../../../src-tauri/src/dsh_assistant.rs', import.meta.url));
  const source = execFileSync('bash', ['-c', 'cat "$1"', 'source-regression', file], { encoding: 'utf8' });
  assert.ok(source.includes('<mind-file-source>'));
  assert.ok(source.includes('</mind-file-source>'));
  const deliveries = [];
  const stream = await sourceStream(async payload => {
    deliveries.push(payload);
    throw new Error('Invalid source projection');
  });
  const history = [textMessage('bash-output', 'tool', source)];
  assert.deepEqual(await stream(history), [{ type: 'text-delta', text: 'continued' }]);
  assert.deepEqual(await stream([...history, textMessage('next-prompt', 'user', '继续')]),
    [{ type: 'text-delta', text: 'continued' }]);
  assert.deepEqual(deliveries, []);
});

test('source scanning ignores bare markers and malformed native envelopes and keeps later fixed evidence', () => {
  const fixed = fixedProjection();
  const prefix = fixed.slice(0, fixed.indexOf('\n') + 1);
  const ordinary = [
    fixed.slice(prefix.length),
    '<mind-file-source>{invalid JSON}</mind-file-source>',
    ...['null', '[]', '{}', '{"id":"literal"}', '{invalid JSON}'].map(value => `${prefix}<mind-file-source>${value}</mind-file-source>`),
    fixedProjection({ content: 42 }), fixedProjection({ requestedLimit: '1' }),
  ].join('\n');
  assert.deepEqual(sourceProjections(ordinary), []);
  assert.deepEqual(sourceProjections(`${ordinary}\n${fixed}`).map(item => item.projection), [fixed]);
});

test('fixed composer and read projections are revalidated after history reload and deduplicated after admission', async () => {
  const projection = fixedProjection();
  const history = [textMessage('composer', 'user', projection), textMessage('read', 'tool', projection)];
  const deliveries = [];
  const stream = await sourceStream(async payload => { deliveries.push(payload); });
  await stream(history);
  assert.deepEqual(deliveries.map(item => item.deliveryId), ['composer:composer:fixed-read', 'read:read:fixed-read']);
  for (const payload of deliveries) {
    assert.equal(payload.operation, 'delivery');
    assert.equal(payload.sessionId, 'session');
    assert.equal(payload.projection, projection);
    assert.equal(payload.projectionHash, createHash('sha256').update(projection).digest('hex'));
  }
  await stream(history);
  assert.equal(deliveries.length, 2);
  const reloaded = await sourceStream(async payload => { deliveries.push(payload); });
  await reloaded(history);
  assert.equal(deliveries.length, 4, 'persisted native projections still require native validation after reload');
});

test('native fixed-byte mismatch still fails delivery and is not remembered as admitted', async () => {
  const projection = fixedProjection({ content: '1: tampered bytes' });
  const deliveries = [];
  const stream = await sourceStream(async payload => {
    deliveries.push(payload);
    throw new Error('Source projection does not match fixed bytes');
  });
  const history = [textMessage('read', 'tool', projection)];
  await assert.rejects(stream(history), /Source projection does not match fixed bytes/);
  await assert.rejects(stream(history), /Source projection does not match fixed bytes/);
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].projection, projection);
});

test('native empty File projections still reach delivery validation', async () => {
  const projection = fixedProjection({ limit: 0, content: '' });
  const deliveries = [];
  const stream = await sourceStream(async payload => { deliveries.push(payload); });
  await stream([textMessage('empty-read', 'tool', projection)]);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].projection, projection);
});

test('source stdio correlates out-of-order responses and revokes pending reads on parent close', async () => {
  const stdin = new PassThrough();
  const input = createInterface({ input: stdin });
  const frames = [];
  const bridge = createSourceBridge(input, line => frames.push(JSON.parse(line.slice('MIND_DSH_SOURCE '.length))));
  const first = bridge.request({ operation: 'prepare', sessionId: 'a', path: 'old.md' });
  const second = bridge.request({ operation: 'prepare', sessionId: 'b', path: 'new.md' });
  stdin.write(JSON.stringify({ type: 'mind-source-response', id: frames[1].id, result: { ok: true, value: { projection: 'B' } } }) + '\n');
  stdin.write(JSON.stringify({ type: 'mind-source-response', id: frames[0].id, result: { ok: true, value: { projection: 'A' } } }) + '\n');
  assert.equal((await first).projection, 'A');
  assert.equal((await second).projection, 'B');
  const pending = bridge.request({ operation: 'prepare', sessionId: 'a', path: 'pending.md' });
  input.close();
  await assert.rejects(pending, /closed/);
  await assert.rejects(bridge.request({ operation: 'prepare' }), /closed/);
});

test('title input preserves ordinary paths and malformed source literals without interpreting them', () => {
  const ordinary = '@ordinary/path unchanged title';
  assert.equal(sourceTitleText(ordinary), ordinary);
  const metadata = JSON.stringify({ sourceRef: { title: 'sample.txt', fileVersion: 1 }, content: 'literal user text' });
  const literals = [
    `@mind-source/A/sample.txt\n<mind-file-source>${metadata}</mind-file-source>`,
    `@mind-source/${Buffer.from('{"title":').toString('base64url')}/sample.txt\n<mind-file-source>${metadata}</mind-file-source>`,
    '<mind-file-source>{invalid JSON}</mind-file-source>',
    '<mind-file-source>{"sourceRef":null}</mind-file-source>',
    ...[{ title: 42, fileVersion: 1 }, { fileVersion: 1 }, { title: 'sample.txt', fileVersion: 0 }, { title: 'sample.txt', fileVersion: '1' }].map(sourceRef => `<mind-file-source>${JSON.stringify({ sourceRef })}</mind-file-source>`),
    `@mind-source/${Buffer.from(JSON.stringify({ title: 'other.txt', fileVersion: 1 })).toString('base64url')}/sample.txt\n<mind-file-source>${metadata}</mind-file-source>`,
  ];
  for (const literal of literals) assert.equal(sourceTitleText(`prompt${literal}`), `prompt${literal}`);
});

test('one shared source middleware resolves real Session ownership for every scope',async()=>{
 const handlers=new Map(),routes=[],requests=[],checked=[];
 const ctx={connection:{fetch:{register:value=>routes.push(value)}},agents:{list:()=>[]},on(name,handler){assert.equal(handlers.has(name),false);handlers.set(name,handler);},effect(){}};
 const registry={async forSession(id){checked.push(id);if(!['workspace-session','project-session'].includes(id))throw new Error('Unknown Session');return {directory:'/scope/'+id};}};
 await installSourceService(ctx,registry,{async request(value){requests.push(value);return {fixed:true};}});
 for(const sessionId of ['workspace-session','project-session','foreign']){
  const response=await routes.find(route=>route.path.endsWith('/resolve')).fetch(new Request('http://local/api/mind/source/resolve',{method:'POST',body:JSON.stringify({type:'client-request',method:'mind/source/resolve',rpcId:sessionId,payload:{args:{request:{sessionId,path:'files/fixed.txt'}}}})}));
  assert.equal((await response.json()).result.ok,sessionId!=='foreign');
 }
 assert.deepEqual(requests.map(value=>value.sessionId),['workspace-session','project-session']);
 assert.deepEqual(checked,['workspace-session','project-session','foreign']);
 assert.equal(routes.length,2);assert.equal(handlers.size,4);
});

test('Skill reference reads use the ordinary read while business files retain native preparation', async t => {
  const { mkdtemp, mkdir, writeFile, rm, realpath, symlink, rename } = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const { Context } = await import('@deepseek-ai/cordis');
  const { default: SkillRegistry } = await import('@deepseek-ai/dsh-skill');
  const filesystem = await import('@deepseek-ai/dsh-skill-filesystem');
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mind-resource-read-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = path.join(root, 'packaged', 'reader');
  const bundled = path.join(root, 'managed');
  await mkdir(resources, { recursive: true });
  await mkdir(bundled);
  await writeFile(path.join(resources, 'SKILL.md'), '---\nname: reader\ndescription: Read references\n---\nRead guide.md');
  await writeFile(path.join(resources, 'guide.md'), 'reference');
  await symlink(resources, path.join(bundled, 'reader'), 'dir');
  const registry = new Context();
  await registry.plugin(SkillRegistry);
  await registry.plugin(filesystem, { includeDefaultRoots: false, bundledSkillDir: bundled, watch: false });
  t.after(() => registry.fiber.dispose());
  const handlers = new Map(), requests = [];
  await installSourceService({
    connection: { fetch: { register() {} } }, agents: { list: () => [] },
    on(name, handler) { handlers.set(name, handler); }, effect() {},
  }, { async forSession() {} }, { async request(payload) { requests.push(payload); return { readValue: { native: true }, projection: 'fixed' }; } });
  const agent = { session: { id: 'session', header: { cwd: root } }, ctx: { get(name) {
    if (name === 'skills') return registry.skills;
    return { async resolve() { return {}; }, async stat() { return undefined; } };
  } } };
  let ordinary = 0;
  const execute = file_path => handlers.get('tools/execute')({ name: 'read', token: Symbol(), arguments: { file_path }, agent }, async () => { ordinary++; return 'ordinary'; });
  assert.equal(await execute(path.join(resources, 'guide.md')), 'ordinary', 'canonical bundled paths are resources');
  assert.equal(await execute(path.join(bundled, 'reader', 'guide.md')), 'ordinary');
  assert.deepEqual(requests, [], 'resource reads create neither native preparation nor source evidence');
  await execute(path.join(root, 'business.md'));
  assert.equal(requests[0].operation, 'prepare');
  await mkdir(path.join(bundled, '.disabled'));
  await rename(path.join(bundled, 'reader'), path.join(bundled, '.disabled', 'reader'));
  await execute(path.join(resources, 'guide.md'));
  assert.equal(ordinary, 2, 'cached canonical resources lose authorization when disabled');
  assert.equal(requests.length, 2);
});
