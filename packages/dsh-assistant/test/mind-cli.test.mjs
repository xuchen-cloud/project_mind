import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, mkdtemp, writeFile, chmod, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';

const binding = () => import('../scripts/mind-cli.mjs');
const context = { kind: 'project', id: 7, directory: '/workspace/project' };
const cli = { executable: '/bundled/bin/mind', workspace: '/workspace', connection: 'a'.repeat(32), discovery: '/native/cli-bridge.json', projectId: 7 };
const deferred = () => Promise.withResolvers();
const spec = (sessionId = 'a', mode = 'workspace-write') => ({ command: 'echo ordinary-shell', workdir: context.directory, timeoutMs: 3000, onExpiry: 'kill', stdoutMaxBytes: 4000, dshEnv: { DSH_SESSION_ID: sessionId }, sandboxPolicy: { mode, workspaceRoot: context.directory } });

function fixture(t, execute) {
  const ctx = new Context();
  ctx.provide('sessionController', { async list() { return { items: [{ sessionId: 'a', cwd: context.directory }, { sessionId: 'b', cwd: context.directory }, { sessionId: 'foreign', cwd: '/other' }] }; } });
  const prompts = [];
  ctx.provide('systemPrompt', { section(value) { prompts.push(value); return () => {}; }, getSectionOrder() { return 10200; } });
  const calls = [];
  const bridge = { async request(value) { calls.push(value); if (value.operation === 'cliLeaseOpen') return { leaseId: `lease-${calls.length}`, token: `secret-${value.sessionId}-${calls.length}` }; } };
  const executions = [];
  const shell = { async execute(value) { executions.push(value); return execute(value); } };
  const removeShell = ctx.provide('shell', shell);
  t.after(() => ctx.fiber.dispose());
  return { ctx, shell, bridge, calls, executions, prompts, removeShell };
}
function controlled() {
  const result = deferred();
  const handle = { status: 'running', done: result.promise.then(() => {}, () => {}), result: () => result.promise, kill() { result.resolve({ aborted: true }); return true; } };
  return { handle, result };
}

test('embedded runtime wires CLI configuration and binding before exposing ready', async () => {
  const runtime = await readFile(new URL('../scripts/runtime.mjs', import.meta.url), 'utf8');
  assert.match(runtime, /readMindCli\(frame, context\)/);
  assert.match(runtime, /installMindCli\(host, context, cli, sourceBridge\)/);
  assert.doesNotMatch(runtime, /if \(context.kind === 'project'\) sourceBridge =/);
});

test('configure is optional, strict, scope-bound and credential-free', async t => {
  const { readMindCli } = await binding();
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mind-cli-config-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'mind');
  await writeFile(executable, '#!/bin/sh\nexit 0\n'); await chmod(executable, 0o700);
  const config = { ...cli, executable, workspace: root, discovery: path.join(root, 'native-bridge.json') };
  const read = value => readMindCli(JSON.stringify({ cli: value }), context);
  assert.equal(await readMindCli('{}', context), undefined);
  assert.deepEqual(await read(config), config);
  for (const invalid of [null, false, [], {}, { ...config, executable: 'mind' }, { ...config, workspace: 'relative' }, { ...config, discovery: 'relative' }, { ...config, connection: 'bad' }, { ...config, projectId: null }, { ...config, projectId: 8 }, { ...config, projectId: 1.2 }, { ...config, token: 'long-lived-secret' }, { ...config, executable: root }, { ...config, executable: path.join(root, 'missing') }]) {
    await assert.rejects(read(invalid), error => /Invalid main CLI/.test(error.message) && !error.message.includes('long-lived-secret'));
  }
  const workspace = { kind: 'workspace', directory: root };
  assert.deepEqual(await readMindCli(JSON.stringify({ cli: { ...config, projectId: null } }), workspace), { ...config, projectId: null });
  await assert.rejects(readMindCli(JSON.stringify({ cli: { ...config, projectId: null, workspace: path.dirname(root) } }), workspace), /Invalid main CLI/);
});

test('prompt supplies binding facts without lease credentials; PATH and env are per shell', async t => {
  const { installMindCli } = await binding();
  const run = controlled(); const f = fixture(t, () => run.handle);
  const ambient = Object.fromEntries(['PATH', 'PROJECT_MIND_CLI_TOKEN', 'PROJECT_MIND_CLI_DISCOVERY'].map(key => [key, process.env[key]]));
  await installMindCli(f.ctx, context, cli, f.bridge);
  const prompt = f.prompts.map(value => value.text).join('\n');
  for (const fact of ['project-mind-cli', cli.executable, '--workspace', cli.workspace, '--connection', cli.connection, '--project', 'Record', 'Todo', 'receipt']) assert.ok(prompt.includes(fact), fact);
  assert.doesNotMatch(prompt, /secret-|PROJECT_MIND_CLI_TOKEN|cliLeaseOpen/);
  const request = { ...spec(), env: { PATH: '/caller/bin', CUSTOM: 'kept' } };
  const before = structuredClone(request);
  const handle = await f.shell.execute(request);
  assert.equal(handle, run.handle, 'preserve upstream live handle identity');
  assert.deepEqual(request, before);
  assert.equal(f.executions[0].env.PATH, `/bundled/bin${path.delimiter}/caller/bin`);
  assert.equal(f.executions[0].env.CUSTOM, 'kept');
  assert.equal(f.executions[0].env.PROJECT_MIND_CLI_DISCOVERY, cli.discovery);
  assert.equal(f.executions[0].env.PROJECT_MIND_SESSION_ID, 'a');
  assert.match(f.executions[0].env.PROJECT_MIND_CLI_TOKEN, /^secret-a-/);
  assert.equal(f.executions[0].sandboxPolicy, request.sandboxPolicy);
  for (const [key, value] of Object.entries(ambient)) assert.ok(process.env[key] === value, `${key} must stay unchanged`);
  assert.equal(f.calls.length, 1, 'publishing a handle must not revoke a live lease');
  run.result.resolve({ exitCode: 0 }); await handle.result();
  assert.equal(f.calls[1].operation, 'cliLeaseClose');
});

test('all shell commands authenticate actual Session ownership and resolved mode', async t => {
  const { installMindCli } = await binding();
  const f = fixture(t, () => { throw new Error('should not spawn'); });
  await installMindCli(f.ctx, context, cli, f.bridge);
  for (const request of [{ ...spec(), dshEnv: undefined, env: { DSH_SESSION_ID: 'a' } }, spec('foreign'), spec('missing'), { ...spec(), sandboxPolicy: undefined }, spec('a', 'invented')]) await assert.rejects(f.shell.execute(request), /Session|sandbox/);
  assert.equal(f.calls.length, 0); assert.equal(f.executions.length, 0);
});

test('concurrent Sessions have isolated leases and readonly reaches native authority unchanged', async t => {
  const { installMindCli } = await binding();
  const runs = [controlled(), controlled()]; let index = 0;
  const f = fixture(t, () => runs[index++].handle);
  await installMindCli(f.ctx, context, cli, f.bridge);
  const [a, b] = await Promise.all([f.shell.execute(spec('a', 'read-only')), f.shell.execute(spec('b'))]);
  assert.deepEqual(f.calls.map(({ sessionId, mode }) => ({ sessionId, mode })), [{ sessionId: 'a', mode: 'read-only' }, { sessionId: 'b', mode: 'workspace-write' }]);
  assert.notEqual(f.executions[0].env.PROJECT_MIND_CLI_TOKEN, f.executions[1].env.PROJECT_MIND_CLI_TOKEN);
  runs[1].result.resolve({ exitCode: 0 }); await b.result();
  assert.deepEqual(f.calls.at(-1), { operation: 'cliLeaseClose', sessionId: 'b', leaseId: 'lease-2' });
  runs[0].result.resolve({ exitCode: 4 }); assert.equal((await a.result()).exitCode, 4);
  assert.deepEqual(f.calls.at(-1), { operation: 'cliLeaseClose', sessionId: 'a', leaseId: 'lease-1' });
});

test('spawn rejection, result rejection, cancellation and background completion revoke leases', async t => {
  const { installMindCli } = await binding();
  for (const failure of ['spawn', 'result', 'abort', 'background']) await t.test(failure, async t => {
    const run = controlled(); const f = fixture(t, () => { if (failure === 'spawn') throw new Error('spawn failed'); return run.handle; });
    await installMindCli(f.ctx, context, cli, f.bridge);
    if (failure === 'spawn') await assert.rejects(f.shell.execute(spec()), /spawn failed/);
    else {
      const handle = await f.shell.execute(spec());
      if (failure === 'result') { run.result.reject(new Error('result failed')); await assert.rejects(handle.result(), /result failed/); }
      else if (failure === 'abort') { handle.kill(); await handle.result(); }
      else { run.result.resolve({ exitCode: 0 }); await handle.done; await new Promise(resolve => setImmediate(resolve)); }
    }
    assert.equal(f.calls.filter(value => value.operation === 'cliLeaseClose').length, 1);
  });
});

test('native lease failures block execution and cleanup failures surface', async t => {
  const { installMindCli } = await binding();
  const run = controlled(); const f = fixture(t, () => run.handle);
  await installMindCli(f.ctx, context, cli, f.bridge);
  f.bridge.request = async () => { throw new Error('native denied'); };
  await assert.rejects(f.shell.execute(spec()), /native denied/); assert.equal(f.executions.length, 0);
  f.bridge.request = async value => { if (value.operation === 'cliLeaseOpen') return { leaseId: 'valid', token: 'secret' }; throw new Error('close failed'); };
  const handle = await f.shell.execute(spec()); run.result.resolve({ exitCode: 0 });
  await assert.rejects(handle.result(), /lease.*close|cleanup/i);
});


test('no CLI configuration leaves independent runtimes untouched', async t => {
  const { installMindCli } = await binding();
  const f = fixture(t, () => {}); const original = f.shell.execute;
  assert.equal(installMindCli(f.ctx, context, undefined, undefined), undefined);
  assert.equal(f.shell.execute, original); assert.equal(f.prompts.length, 0);
});

test('lease survives result projection until the real handle done settles', async t => {
  const { installMindCli } = await binding();
  const done = deferred();
  const handle = { done: done.promise, result: async () => ({ exitCode: 0 }), kill() { done.resolve(); } };
  const f = fixture(t, () => handle);
  await installMindCli(f.ctx, context, cli, f.bridge);
  await f.shell.execute(spec());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  done.resolve(); await handle.result();
  assert.equal(f.calls.at(-1).operation, 'cliLeaseClose');
});

test('abort while native open is in flight receives then revokes the lease without spawning', async t => {
  const { installMindCli } = await binding();
  const f = fixture(t, () => { throw new Error('must not spawn'); });
  const opened = deferred(), admitted = deferred();
  f.bridge.request = async value => {
    f.calls.push(value);
    if (value.operation === 'cliLeaseOpen') { admitted.resolve(); return opened.promise; }
  };
  await installMindCli(f.ctx, context, cli, f.bridge);
  const controller = new AbortController();
  const pending = f.shell.execute({ ...spec(), signal: controller.signal });
  await admitted.promise; controller.abort(new Error('cancelled'));
  opened.resolve({ leaseId: 'late-lease', token: 'never-used' });
  await assert.rejects(pending, /cancelled/);
  assert.equal(f.executions.length, 0);
  assert.deepEqual(f.calls.at(-1), { operation: 'cliLeaseClose', sessionId: 'a', leaseId: 'late-lease' });
});

test('service reload restores old executor, reattaches new executor and disposal revokes live leases', async t => {
  const { installMindCli } = await binding();
  const run = controlled(); const f = fixture(t, () => run.handle);
  const original = f.shell.execute;
  await installMindCli(f.ctx, context, cli, f.bridge);
  await f.shell.execute(spec());
  await f.removeShell();
  assert.equal(f.shell.execute, original);
  assert.equal(f.calls.at(-1).operation, 'cliLeaseClose');
  const next = controlled();
  const replacement = { async execute() { return next.handle; } };
  const nextOriginal = replacement.execute;
  f.ctx.provide('shell', replacement);
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(replacement.execute, nextOriginal);
  const handle = await f.ctx.shell.execute(spec('b'));
  await f.ctx.fiber.dispose();
  assert.equal((await handle.result()).aborted, true);
  assert.equal(f.calls.filter(value => value.operation === 'cliLeaseClose').length, 2);
});

test('malformed native lease fails closed and revokes a returned lease identity', async t => {
  const { installMindCli } = await binding();
  const f = fixture(t, () => { throw new Error('must not spawn'); });
  f.bridge.request = async value => {
    f.calls.push(value);
    if (value.operation === 'cliLeaseOpen') return { leaseId: 'bad-token-lease', token: '' };
  };
  await installMindCli(f.ctx, context, cli, f.bridge);
  await assert.rejects(f.shell.execute(spec()), /Invalid native Mind CLI lease/);
  assert.equal(f.executions.length, 0);
  assert.equal(f.calls.at(-1).operation, 'cliLeaseClose');
});
