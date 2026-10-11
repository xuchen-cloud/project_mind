import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { startLocalProvider } from './fixtures/local-provider.mjs';

// Run explicitly: node --test packages/dsh-assistant/test/runtime.integration.mjs
// Real subprocess + rc.2 Web RPC/mux + provider SSE; no SDK, browser, or build.
const root = fileURLToPath(new URL('..', import.meta.url));
const redact = (text) => String(text).replace(/([?&]token=)[^\s"'<>]+/g, '$1[redacted]').replace(/local-integration-key/g, '[redacted]');
async function waitFor(read, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(20);
  }
  throw new Error(`Timed out: ${description}`);
}

async function launch(data, patch, sharedProvider, project, profileDirectory, sourceHandler) {
  const child = fork(path.join(root, 'scripts/runtime.mjs'), [...(sharedProvider ? ['--embedded'] : []), '--port', '0', '--no-open'], {
    cwd: root, execArgv: [], silent: true,
    env: { ...process.env, PROJECT_MIND_DSH_USER_DATA: data,
      ...(project ? { PROJECT_MIND_DSH_PROFILE_DIR: profileDirectory ?? path.join(path.dirname(data), 'shared-profile') } : {}),
      ...(patch ? { PROJECT_MIND_DSH_PATCH: patch } : {}), LOCAL_TEST_KEY: 'local-integration-key' },
  });
  if (sharedProvider) child.stdin.write(JSON.stringify({ type: 'configure', provider: sharedProvider, project }) + '\n');
  let output = '';
  let ready;
  let ended;
  let spawnError;
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-64000); });
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-64000); });
  if (sourceHandler) createInterface({ input: child.stdout }).on('line', async line => {
    if (!line.startsWith('MIND_DSH_SOURCE ')) return;
    const frame = JSON.parse(line.slice('MIND_DSH_SOURCE '.length));
    let result;
    try { result = { ok: true, value: await sourceHandler(frame.payload) }; }
    catch (error) { result = { ok: false, error: { message: String(error.message) } }; }
    child.stdin.write(JSON.stringify({ type: 'mind-source-response', id: frame.id, result }) + '\n');
  });
  child.on('message', (message) => { if (message?.type === 'ready') ready = message; });
  child.on('error', (error) => { spawnError = error; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => { ended = { code, signal }; resolve(ended); }));
  let stopping;
  const stop = () => stopping ??= (async () => {
    if (!ended) {
      if (sharedProvider) child.stdin.end('shutdown\n');
      else child.kill('SIGTERM');
    }
    const timer = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 8000);
    try {
      const result = await exited;
      assert.equal(result.signal, null, 'runtime must shut down without forced termination');
      assert.equal(result.code, 0, `runtime exit: ${redact(output).slice(-4000)}`);
    } finally { clearTimeout(timer); }
  })();
  try {
    await waitFor(() => {
      if (spawnError) throw spawnError;
      if (ended) throw new Error(`Runtime exited before ready (${ended.code}): ${redact(output).slice(-8000)}`);
      return ready && output.match(/http:\/\/[^\s"'<>]+\?token=[^\s"'<>]+/);
    }, 'runtime IPC ready and authenticated URL', 30000);
    assert.ok(Number.isInteger(ready.port) && ready.port > 0);
    const authUrl = new URL(output.match(/http:\/\/[^\s"'<>]+\?token=[^\s"'<>]+/)[0]);
    assert.equal(Number(authUrl.port), ready.port);
    const origin = authUrl.origin;
    const exchange = await fetch(authUrl, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    assert.equal(exchange.status, 303, 'launch token exchange redirects to clean URL');
    const cookie = exchange.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    assert.ok(cookie, 'token exchange must mint cookie');
    await exchange.arrayBuffer();
    const headers = { Origin: origin, Cookie: cookie };
    const rpc = async (method, request, argument = 'request') => {
      const rpcId = randomUUID();
      const response = await fetch(`${origin}/api/${method}`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: request === undefined ? {} : { [argument]: request } } }),
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 200, `${method} HTTP status`);
      const envelope = await response.json();
      assert.equal(envelope.type, 'server-response');
      assert.equal(envelope.rpcId, rpcId);
      assert.equal(envelope.result.ok, true, `${method}: ${redact(JSON.stringify(envelope.result.error))}`);
      return envelope.result.value;
    };
    return { child, origin, headers, rpc, stop, diagnostics: () => redact(output).slice(-8000) };
  } catch (error) {
    await stop().catch(() => {});
    throw new Error(`${error.message}\n${redact(output).slice(-8000)}`, { cause: error });
  }
}

async function follow(runtime, sessionId) {
  const socket = new WebSocket(`${runtime.origin.replace('http:', 'ws:')}/api/remote.mux`, { headers: runtime.headers });
  const frames = [];
  let failure;
  socket.on('error', (error) => { failure = error; });
  socket.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.type === 'error') failure = new Error(`session/follow: ${redact(JSON.stringify(message.error))}`);
      else if (message.type === 'item' && message.streamId === 'session-follow') frames.push(message.value);
    } catch (error) { failure = error; }
  });
  const read = (predicate, description) => waitFor(() => {
    if (failure) throw failure;
    assert.equal(socket.readyState, WebSocket.OPEN, 'follow socket closed unexpectedly');
    return frames.find(predicate);
  }, description);
  const close = async () => {
    if (socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.terminate();
    await closed;
  };
  try {
    await waitFor(() => { if (failure) throw failure; return socket.readyState === WebSocket.OPEN; }, 'mux WebSocket open');
    socket.send(JSON.stringify({ type: 'open', streamId: 'session-follow', endpoint: 'session/follow', payload: {
      args: { request: { address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 100 } },
    } }));
    const snapshot = await read((frame) => frame.type === 'snapshot', 'session follow snapshot');
    return { frames, snapshot, read, close };
  } catch (error) { await close(); throw error; }
}

const events = (stream) => stream.frames.flatMap((frame) => frame.type === 'snapshot' ? frame.records.map((record) => record.event) : frame.type === 'event' ? [frame.event] : []);
const assistantText = (event) => event.data.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');

test('source stdio delivers fixed composer and actual read projections to a local model with real message identities', { timeout: 60000 }, async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'mind-source-integration-'));
  const bodies = [];
  const provider = await startLocalProvider({ onSyntheticRequest: body => bodies.push(body) });
  let runtime, stream;
  t.after(async () => { await stream?.close(); await runtime?.stop(); await provider.close(); await rm(temp, { recursive: true, force: true }); });
  const directory = await realpath(temp);
  const sourceRef = { object: { workspaceId: 'synthetic', scope: { kind: 'project', projectId: 7 }, kind: 'file', id: '9' }, revision: 'sha256:' + 'a'.repeat(64), fileVersion: 1, recordVersion: null, blockId: null, locator: null, title: 'old.md', excerpt: '' };
  const operations = [];
  const sourceHandler = payload => {
    operations.push(payload);
    if (payload.operation === 'delivery') {
      assert.equal(payload.projectionHash, createHash('sha256').update(payload.projection).digest('hex'));
      assert.match(payload.deliveryId, /^(composer|read):/);
      return null;
    }
    const metadata = { id: randomUUID(), sourceRef: payload.sourceRef ?? sourceRef, offset: payload.offset, limit: payload.limit, content: payload.sourceRef ? '1: fixed historical bytes' : '1: tool snapshot bytes' };
    return { sourceRef: metadata.sourceRef, projection: `<mind-file-source>${JSON.stringify(metadata)}</mind-file-source>`, readValue: {path:"renamed.md", offset:1, lines:[{number:1,text:metadata.content.slice(3)}], totalLines:1} };
  };
  runtime = await launch(path.join(temp, 'data'), undefined, { name: 'local', modelId: 'local-test-model', baseUrl: provider.url, apiKey: 'local-integration-key', supportsImage: false }, { id: 7, name: 'Source', directory }, undefined, sourceHandler);
  const { sessionId } = await runtime.rpc('session/create', {});
  stream = await follow(runtime, sessionId);
  const prepared = await runtime.rpc('mind/source/prepare', { sessionId, path: 'renamed.md', sourceRef });
  await writeFile(path.join(temp, 'renamed.md'), 'different live bytes');
  await prompt(runtime, stream, sessionId, prepared.projection);
  assert.ok(bodies.some(body => JSON.stringify(body.messages).includes('fixed historical bytes')));
  assert.ok(operations.some(item => item.operation === 'prepare' && item.sourceRef?.fileVersion === 1));
  assert.ok(operations.some(item => item.operation === 'delivery' && item.deliveryId.startsWith('composer:') && item.sessionId === sessionId));
  provider.enqueueResponse({ chunks: [''], toolCalls: [{ index: 0, id: 'source-read-call', type: 'function', function: { name: 'read', arguments: JSON.stringify({ file_path: 'renamed.md', offset: 1, limit: 1 }) } }] });
  await prompt(runtime, stream, sessionId, 'Use the read tool');
  assert.ok(operations.some(item => item.operation === 'prepare' && !item.sourceRef && item.path === 'renamed.md'), JSON.stringify(bodies.at(-1)?.messages));
  assert.ok(operations.some(item => item.operation === 'delivery' && item.deliveryId.startsWith('read:') && item.projection.includes('tool snapshot bytes')));
  assert.ok(bodies.some(body => body.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('tool snapshot bytes'))));
  provider.enqueueResponse({ chunks: [''], toolCalls: [{ index: 0, id: 'source-edit-call', type: 'function', function: { name: 'edit', arguments: JSON.stringify({ file_path: 'renamed.md', old_string: 'different live bytes', new_string: 'edited after source read' }) } }] });
  await prompt(runtime, stream, sessionId, 'Edit the file just read');
  assert.equal(await readFile(path.join(temp, 'renamed.md'), 'utf8'), 'edited after source read');
});
test('PTC nested read summary delivers its fixed projection under the actual parent message', { timeout: 60000 }, async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'mind-source-ptc-'));
  const directory = await realpath(temp);
  const bodies = [], operations = [];
  const provider = await startLocalProvider({ onSyntheticRequest: body => bodies.push(body) });
  let runtime, stream;
  t.after(async () => { await stream?.close(); await runtime?.stop(); await provider.close(); await rm(temp, { recursive: true, force: true }); });
  const patch = path.join(temp, 'ptc.patch.yml');
  const policy = path.join(temp, 'source-policy.mjs');
  await writeFile(policy, `export const name = 'source-projection-test-policy';
export function apply(ctx) {
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next();
    if (exec.name === 'read' && exec.arguments.file_path === 'dispatch-value.md') return { ...result, value: { path: 'dispatch-value.md', offset: 1, lines: [{ number: 1, text: 'dispatch replaced value' }], totalLines: 1 } };
    return result;
  });
  ctx.on('tools/post-execute', (exec, result, next) => {
    const target = exec.name === 'read' ? exec.arguments.file_path : exec.arguments.description;
    if (target === 'child-content.md' || target === 'parent-content') return { kind: 'accept', content: [{ type: 'text', text: 'policy replaced content' }] };
    if (target === 'child-value.md') return { kind: 'accept', value: { path: 'child-value.md', offset: 1, lines: [{ number: 1, text: 'policy replaced value' }], totalLines: 1 } };
    if (target === 'parent-value') return { kind: 'accept', value: { logs: [], result: 'policy replaced value' } };
    if (target === 'child-block.md' || target === 'parent-block') return { kind: 'block', feedback: [{ type: 'text', text: 'policy blocked' }] };
    return next();
  });
}
`);
  await writeFile(patch, '- id: tools\n  config:\n    mode: both\n- insert:\n    - id: source-projection-test-policy\n      name: ' + JSON.stringify(policy) + '\n');
  for (const name of ['child-content.md', 'child-value.md', 'child-block.md', 'dispatch-value.md']) await writeFile(path.join(temp, name), 'immutable nested bytes');
  await writeFile(path.join(temp, 'nested.md'), 'immutable nested bytes');
  const sourceRef = { object: { workspaceId: 'ptc', scope: { kind: 'project', projectId: 8 }, kind: 'file', id: '9' }, revision: 'sha256:' + 'a'.repeat(64), fileVersion: 1, locator: { kind: 'line', start: 1, end: 1 }, title: 'nested.md' };
  let prepared;
  runtime = await launch(path.join(temp, 'data'), patch, { name: 'local', modelId: 'local-test-model', baseUrl: provider.url, apiKey: 'local-integration-key', supportsImage: false }, { id: 8, name: 'PTC', directory }, undefined, payload => {
    operations.push(payload);
    if (payload.operation === 'delivery') return null;
    const metadata = { id: randomUUID(), sourceRef, offset: 1, limit: 1, requestedLimit: 1, truncated: false, content: '1: immutable nested bytes' };
    prepared = `<mind-file-source>${JSON.stringify(metadata)}</mind-file-source>`;
    return { projection: prepared, sourceRef, readValue: { path: 'nested.md', offset: 1, lines: [{ number: 1, text: 'immutable nested bytes' }], totalLines: 1, truncated: false } };
  });
  const { sessionId } = await runtime.rpc('session/create', {});
  stream = await follow(runtime, sessionId);
  provider.enqueueResponse({ chunks: [''], toolCalls: [{ index: 0, id: 'nested-run', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ description: 'summarize a File', code: "await tools.read({ file_path: 'nested.md', offset: 1, limit: 1 }); return 'summary only';" }) } }] });
  await prompt(runtime, stream, sessionId, 'Read from a program and return only a summary');
  assert.ok(operations.some(item => item.operation === 'prepare'), runtime.diagnostics());
  const finalTool = bodies.flatMap(body => body.messages).find(message => message.role === 'tool' && message.tool_call_id === 'nested-run' && JSON.stringify(message.content).includes('immutable nested bytes'));
  assert.ok(finalTool, JSON.stringify(bodies.at(-1)?.messages.filter(message => message.role === 'tool')));
  assert.ok(JSON.stringify(finalTool.content).includes('summary only'));
  const delivery = operations.find(item => item.operation === 'delivery');
  assert.equal(delivery.sessionId, sessionId);
  assert.equal(delivery.projection, prepared);
  assert.equal(delivery.projectionHash, createHash('sha256').update(prepared).digest('hex'));
  assert.match(delivery.deliveryId, /^read:/);
  for (const [name, file, description] of [
    ['dispatch-value', 'dispatch-value.md', 'dispatch value replacement'],
    ['child-content', 'child-content.md', 'child content replacement'],
    ['child-value', 'child-value.md', 'child value replacement'],
    ['child-block', 'child-block.md', 'child block'],
    ['parent-content', 'nested.md', 'parent-content'],
    ['parent-value', 'nested.md', 'parent-value'],
    ['parent-block', 'nested.md', 'parent-block'],
  ]) {
    const before = operations.filter(item => item.operation === 'delivery').length;
    const callId = 'nested-policy-' + name;
    provider.enqueueResponse({ chunks: [''], toolCalls: [{ index: 0, id: callId, type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ description, code: `await tools.read({ file_path: '${file}', offset: 1, limit: 1 }); return 'summary only';` }) } }] });
    await prompt(runtime, stream, sessionId, 'Policy case ' + name);
    const message = bodies.at(-1).messages.find(item => item.role === 'tool' && item.tool_call_id === callId);
    assert.ok(message, runtime.diagnostics());
    assert.ok(!JSON.stringify(message.content).includes('<mind-file-source>'), name);
    assert.equal(operations.filter(item => item.operation === 'delivery').length, before, name);
  }
});

async function prompt(runtime, stream, sessionId, text, expectedKind = 'completed') {
  const from = stream.frames.length;
  const result = await runtime.rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] });
  assert.deepEqual(result, { accepted: true });
  const end = await stream.read((frame) => stream.frames.indexOf(frame) >= from && frame.type === 'event' && frame.event.type === 'turn/end', `turn completion: ${text}`);
  assert.equal(end.event.data.reason.kind, expectedKind, JSON.stringify(end.event.data.reason));
  return end.event;
}

async function assertNodeTree(child) {
  assert.equal(child.spawnfile, process.execPath);
  const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,comm=']);
  const rows = stdout.trim().split('\n').map((row) => row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean);
  const descendants = new Set([child.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [, pid, parent] of rows) if (descendants.has(Number(parent)) && !descendants.has(Number(pid))) { descendants.add(Number(pid)); changed = true; }
  }
  for (const [, pid, , command] of rows) if (descendants.has(Number(pid))) assert.doesNotMatch(command, /electron|project_mind\.app/i, 'independent runtime must not spawn desktop app');
}

test('independent Node DSH: upstream UI, streaming, stop/recovery and durable history', { timeout: 120000 }, async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), 'mind-dsh-integration-'));
  const provider = await startLocalProvider();
  let runtime;
  let stream;
  t.after(async () => {
    try { await stream?.close(); } finally {
      try { await runtime?.stop(); } finally { await provider.close(); await rm(temp, { recursive: true, force: true }); }
    }
  });
  const data = path.join(temp, 'data');
  const patch = path.join(temp, 'test.patch.yml');
  await writeFile(patch, `- id: agent-default-model
  config:
    provider: local-test
    model: local-test-model
- id: llm-pi-ai
  config:
    providers:
      local-test:
        api: openai-completions
        baseURL: ${JSON.stringify(provider.url)}
        apiKeyEnv: LOCAL_TEST_KEY
        models:
          - id: local-test-model
        retryPolicy:
          mode: normal
          maxRetries: 0
`);
  runtime = await launch(data, patch);
  await assertNodeTree(runtime.child);
  const unauthenticated = await fetch(`${runtime.origin}/api/session/list`, { method: 'POST', headers: { Origin: runtime.origin } });
  assert.equal(unauthenticated.status, 401);
  await unauthenticated.arrayBuffer();
  const htmlResponse = await fetch(`${runtime.origin}/`, { headers: runtime.headers });
  assert.equal(htmlResponse.status, 200);
  const html = await htmlResponse.text();
  assert.match(html, /<html/i);
  assert.match(html, /__DSH_BOOT__/);
  for (const name of ['dsh-desktop-client-ui', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-api-session-controller']) assert.ok(html.includes(name), `upstream roster missing ${name}`);
  const catalog = await runtime.rpc('session/modelCatalog');
  assert.ok(catalog.groups.some((group) => group.id === 'local-test' && group.models.some((model) => model.id === 'local-test-model')));
  const { sessionId } = await runtime.rpc('session/create', { cwd: path.join(data, 'workspace') });
  assert.equal(typeof sessionId, 'string');
  // Pin a synthetic title so background title generation cannot consume the
  // provider's one-shot controls intended for conversation turns.
  const renamed = await runtime.rpc('session/rename', { sessionId, title: 'Local integration session' });
  assert.equal(renamed.title, 'Local integration session');
  const selection = await runtime.rpc('session/selectModel', { sessionId, provider: 'local-test', model: 'local-test-model' });
  assert.deepEqual(selection.selected, { provider: 'local-test', model: 'local-test-model' });
  stream = await follow(runtime, sessionId);
  assert.equal(stream.snapshot.header.id, sessionId);

  // Gate chunks rather than relying on timing to prove the Web mux is incremental.
  const control = provider.enqueueResponse({ manual: true, chunks: ['First incremental ', 'answer.'] });
  const firstTurn = prompt(runtime, stream, sessionId, 'Integration first turn');
  await waitFor(() => provider.requests.length >= 1, 'first provider request').catch((error) => {
    throw new Error(`${error.message}\n${runtime.diagnostics()}\n${redact(JSON.stringify(stream.frames))}`);
  });
  control.advance();
  await stream.read((frame) => frame.type === 'assistant-stream' && frame.frame.type === 'chunk' && frame.frame.chunk.type === 'text-delta' && frame.frame.chunk.text === 'First incremental ', 'incremental first chunk');
  assert.equal(provider.requests[0].outcome, 'streaming');
  assert.equal(events(stream).filter((event) => event.type === 'turn/end').length, 0);
  control.advance();
  await firstTurn;
  assert.ok(events(stream).some((event) => event.type === 'assistant/message' && assistantText(event) === 'First incremental answer.'));
  await prompt(runtime, stream, sessionId, 'Integration second turn');
  assert.equal(provider.requests.length, 2);
  const roles = provider.requests[1].roles;
  // rc.2 pi-ai also serializes dynamic system messages as user roles.
  const firstRoles = provider.requests[0].roles;
  assert.deepEqual(roles.slice(0, firstRoles.length), firstRoles, 'second request replays the first input prefix');
  assert.equal(roles[firstRoles.length], 'assistant', 'prior answer follows the replayed input');
  assert.equal(roles.at(-1), 'user');
  assert.equal(events(stream).filter((event) => event.type === 'user/message' && event.data.source.kind === 'user').length, 2);

  provider.enqueueResponse({ manual: true, chunks: ['Partial before cancel', 'MUST NOT BE SENT'] }).advance();
  const cancelledTurn = prompt(runtime, stream, sessionId, 'Integration cancelled turn', 'aborted');
  await stream.read((frame) => frame.type === 'assistant-stream' && frame.frame.type === 'chunk' && frame.frame.chunk.type === 'text-delta' && frame.frame.chunk.text === 'Partial before cancel', 'partial reply before cancel');
  assert.equal(provider.requests[2].outcome, 'streaming');
  assert.deepEqual(await runtime.rpc('session/cancel', { sessionId }), { accepted: true });
  await cancelledTurn;
  await waitFor(() => provider.requests[2].outcome === 'aborted', 'cancel propagates to provider');
  assert.ok(!JSON.stringify(stream.frames).includes('MUST NOT BE SENT'));
  await prompt(runtime, stream, sessionId, 'Integration after cancellation');
  provider.failNext(400);
  await prompt(runtime, stream, sessionId, 'Integration explicit failure', 'error');
  assert.equal(provider.requests[4].outcome, 'failed');
  assert.equal(provider.requests[4].status, 400);
  await prompt(runtime, stream, sessionId, 'Integration after failure');
  assert.equal(provider.requests.length, 6, 'retry disabled: exactly one provider request per turn');
  assert.ok(!JSON.stringify(provider.requests).includes('local-integration-key'));
  await assertNodeTree(runtime.child);

  const beforeRestart = events(stream);
  await stream.close();
  stream = undefined;
  await runtime.stop();
  runtime = await launch(data, patch);
  const list = await runtime.rpc('session/list', {}, '_request');
  assert.ok(list.items.some((item) => item.sessionId === sessionId), 'saved session listed after restart');
  stream = await follow(runtime, sessionId);
  const restored = events(stream);
  assert.deepEqual(restored, beforeRestart, 'restart must restore the exact durable event prefix');
  await prompt(runtime, stream, sessionId, 'Integration after restart');
  assert.equal(provider.requests.length, 7);
  assert.deepEqual(provider.requests[6].roles.slice(0, firstRoles.length), firstRoles);
  assert.ok(provider.requests[6].messageCount > provider.requests[5].messageCount, 'post-restart provider receives growing history');
  assert.equal(events(stream).filter((event) => event.type === 'user/message' && event.data.source.kind === 'user').length, 7);
  assert.ok(provider.requests[6].roles.includes('assistant'));
});

test('embedded runtime uses the piped main AI model, hides separate Models settings, preserves history and shuts down via stdin', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mind-dsh-embedded-'));
  const provider = await startLocalProvider();
  const data = path.join(temporary, 'data');
  const shared = { name: 'Main application model', baseUrl: provider.url, modelId: 'main-test-model', apiKey: 'local-integration-key', supportsImage: false };
  const project = { id: 1, name: 'Main project', directory: path.join(temporary, 'main-project') };
  await mkdir(project.directory);
  project.directory = await realpath(project.directory);
  let runtime;
  let stream;
  t.after(async () => { try { await stream?.close(); } finally { try { await runtime?.stop(); } finally { await provider.close(); await rm(temporary, { recursive: true, force: true }); } } });
  runtime = await launch(data, undefined, shared, project);
  assert.doesNotMatch(runtime.diagnostics(), /dsh web: http/, 'embedded launcher must not print its tokenized browser URL');
  const catalog = await runtime.rpc('session/modelCatalog');
  assert.deepEqual(catalog.groups.map(group => group.id), ['mind-main']);
  assert.deepEqual(catalog.groups[0].models.map(model => model.id), [shared.modelId]);
  const html = await (await fetch(`${runtime.origin}/`, { headers: runtime.headers })).text();
  assert.ok(!html.includes('@deepseek-ai/dsh-client-ui-settings-models'));
  const { sessionId } = await runtime.rpc('session/create', {});
  const list = await runtime.rpc('session/list', {}, '_request');
  assert.equal(list.items.find(item => item.sessionId === sessionId).cwd, project.directory);
  const mapped = await runtime.rpc('workspace/initializeDefault');
  assert.equal(mapped.workspace.path, project.directory);
  assert.equal(mapped.workspace.title, project.name);
  assert.ok(mapped.workspace.sessionIds.includes(sessionId));
  await runtime.rpc('session/rename', { sessionId, title: 'Embedded main model session' });
  stream = await follow(runtime, sessionId);
  await prompt(runtime, stream, sessionId, 'Use shared main model');
  assert.equal(provider.requests[0].model, shared.modelId);
  const durable = events(stream);
  await stream.close(); stream = undefined;
  await runtime.stop();
  const credentials = await readFile(path.join(data, '.credentials.yaml'), 'utf8');
  assert.ok(!credentials.includes(shared.apiKey), 'unlocked main key must not be copied into DSH credentials');
  runtime = await launch(data, undefined, shared, project);
  stream = await follow(runtime, sessionId);
  assert.deepEqual(events(stream), durable);
  await prompt(runtime, stream, sessionId, 'Main model after restart');
  assert.equal(provider.requests[1].model, shared.modelId);
  await stream.close(); stream = undefined;
  await runtime.stop();
  const changed = { ...shared, modelId: 'changed-main-model' };
  runtime = await launch(data, undefined, changed, project);
  stream = await follow(runtime, sessionId);
  const selection = events(stream).findLast(event => event.type === 'model/selection');
  assert.equal(selection.data.model, changed.modelId, 'restored session follows the main model binding');
  await prompt(runtime, stream, sessionId, 'Continue old session with updated main model');
  assert.equal(provider.requests[2].model, changed.modelId);
});

test('two main projects have distinct mapped directories and persistent session lists', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mind-dsh-projects-'));
  const provider = await startLocalProvider();
  const shared = { name: 'Main general', baseUrl: provider.url, modelId: 'project-model', apiKey: 'local-integration-key', supportsImage: false };
  const a = { id: 1, name: 'Project A', directory: path.join(temporary, 'A') };
  const b = { id: 2, name: 'Project B', directory: path.join(temporary, 'B') };
  await mkdir(a.directory); await mkdir(b.directory);
  a.directory = await realpath(a.directory); b.directory = await realpath(b.directory);
  const dataA = path.join(temporary, 'history', '1');
  const dataB = path.join(temporary, 'history', '2');
  let runtime;
  t.after(async () => { try { await runtime?.stop(); } finally { await provider.close(); await rm(temporary, { recursive: true, force: true }); } });
  runtime = await launch(dataA, undefined, shared, a);
  const first = await runtime.rpc('session/create', {});
  await runtime.rpc('session/rename', { sessionId: first.sessionId, title: 'Only Project A' });
  await assert.rejects(runtime.rpc('session/create', { cwd: b.directory }));
  await runtime.stop();
  runtime = await launch(dataB, undefined, shared, b);
  const emptyB = await runtime.rpc('session/list', {}, '_request');
  assert.deepEqual(emptyB.items, []);
  const second = await runtime.rpc('session/create', {});
  const listB = await runtime.rpc('session/list', {}, '_request');
  assert.deepEqual(listB.items.map(item => item.cwd), [b.directory]);
  assert.ok(!listB.items.some(item => item.sessionId === first.sessionId));
  await runtime.stop();
  runtime = await launch(dataA, undefined, shared, a);
  const listA = await runtime.rpc('session/list', {}, '_request');
  assert.deepEqual(listA.items.map(item => item.sessionId), [first.sessionId]);
  assert.ok(!listA.items.some(item => item.sessionId === second.sessionId));
});

test('main session removal persists across restart and refuses active work without destroying history', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mind-dsh-removal-'));
  const provider = await startLocalProvider();
  const data = path.join(temporary, 'history');
  const project = { id: 1, name: 'Removal project', directory: path.join(temporary, 'project') };
  await mkdir(project.directory); project.directory = await realpath(project.directory);
  const shared = { name: 'Main general', baseUrl: provider.url, modelId: 'project-model', apiKey: 'local-integration-key', supportsImage: false };
  let runtime, stream;
  t.after(async () => { try { await stream?.close(); } finally { try { await runtime?.stop(); } finally { await provider.close(); await rm(temporary, { recursive: true, force: true }); } } });
  runtime = await launch(data, undefined, shared, project);
  const first = await runtime.rpc('session/create', {});
  stream = await follow(runtime, first.sessionId);
  provider.enqueueResponse({ manual: true, chunks: ['Partial before removal', 'MUST NOT BE SENT'] }).advance();
  const turn = prompt(runtime, stream, first.sessionId, 'Integration cancelled turn', 'aborted');
  await stream.read(frame => frame.type === 'assistant-stream' && frame.frame.type === 'chunk' && frame.frame.chunk.type === 'text-delta', 'running before removal');
  await assert.rejects(runtime.rpc('mind/session/delete', { sessionId: first.sessionId }), /activity|active|running|archive|session/i);
  assert.ok((await runtime.rpc('session/list', {}, '_request')).items.some(item => item.sessionId === first.sessionId));
  await runtime.rpc('session/cancel', { sessionId: first.sessionId }); await turn;
  await stream.close(); stream = undefined;
  await runtime.rpc('mind/session/delete', { sessionId: first.sessionId });
  assert.ok(!(await runtime.rpc('session/list', {}, '_request')).items.some(item => item.sessionId === first.sessionId));
  const remaining = await runtime.rpc('session/create', {});
  await runtime.stop(); runtime = await launch(data, undefined, shared, project);
  assert.deepEqual((await runtime.rpc('session/list', {}, '_request')).items.map(item => item.sessionId), [remaining.sessionId]);
  await assert.rejects(runtime.rpc('session/create', { sessionId: first.sessionId }));
});

test('orphan blank project session recovers durable ownership across a shared-profile project switch and can prompt', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mind-dsh-blank-restart-'));
  const provider = await startLocalProvider();
  const workspaceRoot = path.join(temporary, 'projects', 'workspace-fixture');
  const data = path.join(workspaceRoot, '1');
  const dataB = path.join(workspaceRoot, '2');
  const profileDirectory = path.join(workspaceRoot, 'profiles', 'assistant');
  const project = { id: 1, name: 'Blank restart project', directory: path.join(temporary, 'project') };
  await mkdir(project.directory); project.directory = await realpath(project.directory);
  const projectB = { id: 2, name: 'Project B', directory: path.join(temporary, 'project-b') };
  await mkdir(projectB.directory); projectB.directory = await realpath(projectB.directory);
  const shared = { name: 'Main general', baseUrl: provider.url, modelId: 'blank-project-model', apiKey: 'local-integration-key', supportsImage: false };
  let runtime, stream;
  t.after(async () => { try { await stream?.close(); } finally { try { await runtime?.stop(); } finally { await provider.close(); await rm(temporary, { recursive: true, force: true }); } } });
  const workspaceBaseline = async () => {
    const socket = new WebSocket(`${runtime.origin.replace('http:', 'ws:')}/api/remote.mux`, { headers: runtime.headers });
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('workspace/follow baseline timeout')), 10000);
        socket.on('error', reject);
        socket.on('open', () => socket.send(JSON.stringify({ type: 'open', streamId: 'blank-workspace', endpoint: 'workspace/follow', payload: { args: {} } })));
        socket.on('message', data => {
          const frame = JSON.parse(data.toString());
          if (frame.streamId !== 'blank-workspace') return;
          clearTimeout(timer);
          if (frame.type !== 'item' || frame.value.type !== 'baseline') reject(new Error('workspace/follow did not open with a baseline'));
          else resolve(frame.value.value.items);
        });
      });
    } finally { clearTimeout(timer); socket.terminate(); }
  };
  runtime = await launch(data, undefined, shared, project, profileDirectory);
  const { sessionId } = await runtime.rpc('session/create', {});
  assert.ok((await workspaceBaseline())[0].sessionIds.includes(sessionId));
  await runtime.stop();
  // Reproduce the observed legacy fixture: keep the actual persisted blank
  // header and remove only its durable workspace account in this isolated test.
  const registryPath = path.join(data, 'storages', 'workspace.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const record = Object.values(registry.tables.workspaces).find(item => item.path === project.directory);
  assert.ok(record.sessionIds.includes(sessionId));
  record.sessionIds = record.sessionIds.filter(id => id !== sessionId);
  await writeFile(registryPath, JSON.stringify(registry));
  runtime = await launch(dataB, undefined, shared, projectB, profileDirectory);
  const b = await runtime.rpc('session/create', {});
  await runtime.rpc('session/rename', { sessionId: b.sessionId, title: 'Project B fixture' });
  stream = await follow(runtime, b.sessionId);
  await prompt(runtime, stream, b.sessionId, 'Project B on the shared profile');
  await stream.close(); stream = undefined;
  await runtime.stop();
  runtime = await launch(data, undefined, shared, project, profileDirectory);
  const items = await workspaceBaseline();
  assert.equal(items.length, 1);
  assert.equal(items[0].path, project.directory);
  assert.ok(items[0].sessionIds.includes(sessionId), 'restarted workspace must own its previously blank session');
  const restoredRegistry = JSON.parse(await readFile(registryPath, 'utf8'));
  assert.ok(Object.values(restoredRegistry.tables.workspaces)
    .find(item => item.path === project.directory).sessionIds.includes(sessionId),
  'restored ownership must be durably stored, not only present in a follow frame');
  const list = await runtime.rpc('session/list', {}, '_request');
  assert.equal(list.items.find(item => item.sessionId === sessionId)?.cwd, project.directory);
  await runtime.rpc('session/rename', { sessionId, title: 'Blank restart fixture' });
  stream = await follow(runtime, sessionId);
  await prompt(runtime, stream, sessionId, 'First prompt after blank session restart');
  assert.equal(provider.requests[1].model, shared.modelId);
});

test('two Project runtimes stream concurrently, survive view disconnect and stop only their own Session', { timeout: 90000 }, async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mind-dsh-parallel-'));
  const providers = await Promise.all([startLocalProvider(), startLocalProvider()]);
  const projects = [1, 2].map(id => ({ id, name: `Parallel Project ${id}`, directory: path.join(temporary, String(id)) }));
  for (const project of projects) { await mkdir(project.directory); project.directory = await realpath(project.directory); }
  const runtimes = [], streams = [];
  t.after(async () => {
    await Promise.all(streams.map(stream => stream?.close()));
    await Promise.all(runtimes.map(runtime => runtime.stop()));
    await Promise.all(providers.map(provider => provider.close()));
    await rm(temporary, { recursive: true, force: true });
  });
  const ids = [];
  const controls = [];
  for (let index = 0; index < 2; index++) {
    const provider = providers[index];
    const runtime = await launch(path.join(temporary, 'history', String(index)), undefined,
      { name: 'Main model', baseUrl: provider.url, modelId: 'parallel-model', apiKey: 'local-integration-key', supportsImage: false },
      projects[index], path.join(temporary, 'profiles', 'assistant'));
    runtimes.push(runtime);
    const { sessionId } = await runtime.rpc('session/create', {}); ids.push(sessionId);
    await runtime.rpc('session/rename', { sessionId, title: `Concurrent ${index}` });
    streams.push(await follow(runtime, sessionId));
    const control = provider.enqueueResponse({ manual: true, chunks: [`Project ${index} incremental`, `Project ${index} done`] });
    controls.push(control);
    assert.deepEqual(await runtime.rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: `Project ${index} prompt` }] }), { accepted: true });
    await waitFor(() => provider.requests.length === 1, `provider ${index} started`);
    control.advance();
    await streams[index].read(frame => frame.type === 'assistant-stream' && frame.frame.type === 'chunk' && frame.frame.chunk.type === 'text-delta', `Project ${index} incremental output`);
  }
  assert.notEqual(runtimes[0].child.pid, runtimes[1].child.pid);
  assert.notEqual(runtimes[0].origin, runtimes[1].origin);
  assert.equal(providers[0].requests[0].outcome, 'streaming');
  assert.equal(providers[1].requests[0].outcome, 'streaming');
  // Closing the view carrier leaves Project A running and discoverable.
  await streams[0].close(); streams[0] = undefined;
  const catalogA = await runtimes[0].rpc('session/list', {}, '_request');
  assert.ok(catalogA.items.some(item => item.sessionId === ids[0] && item.running));
  streams[0] = await follow(runtimes[0], ids[0]);
  await assert.rejects(runtimes[1].rpc('session/cancel', { sessionId: ids[0] }));
  assert.deepEqual(await runtimes[0].rpc('session/cancel', { sessionId: ids[0] }), { accepted: true });
  await waitFor(() => providers[0].requests[0].outcome === 'aborted', 'A stop propagates');
  assert.equal(providers[1].requests[0].outcome, 'streaming');
  controls[1].advance();
  await streams[1].read(frame => frame.type === 'event' && frame.event.type === 'turn/end', 'B completes independently');
  assert.ok(events(streams[1]).some(event => event.type === 'assistant/message' && assistantText(event) === 'Project 1 incrementalProject 1 done'));
  assert.ok(!JSON.stringify(streams[1].frames).includes('Project 0 incremental'));
  await streams[0].close(); streams[0] = undefined;
  await runtimes[0].stop();
  assert.ok((await runtimes[1].rpc('session/list', {}, '_request')).items.some(item => item.sessionId === ids[1]));
});
