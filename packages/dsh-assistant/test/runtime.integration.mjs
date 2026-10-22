import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, execFile } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm, chmod } from 'node:fs/promises';
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
const redact = (text) => String(text).replace(/([?&]token=)[^\s"'<>]+/g, '$1[redacted]').replace(/(?:local-integration-key|alternative-integration-key)/g, '[redacted]');
async function waitFor(read, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(20);
  }
  throw new Error(`Timed out: ${description}`);
}

async function launch(data, patch, sharedProvider, project, profileDirectory, sourceHandler, workspace, cli) {
  const child = fork(path.join(root, 'scripts/runtime.mjs'), [...(sharedProvider ? ['--embedded'] : []), '--port', '0', '--no-open'], {
    cwd: root, execArgv: [], silent: true,
    env: { ...process.env, PROJECT_MIND_DSH_USER_DATA: data, PROJECT_MIND_DSH_SKILLS_DATA: path.join(path.dirname(data), 'skill-management'),
      ...((project || workspace) ? { PROJECT_MIND_DSH_PROFILE_DIR: profileDirectory ?? path.join(path.dirname(data), 'shared-profile') } : {}),
      ...(patch ? { PROJECT_MIND_DSH_PATCH: patch } : {}), LOCAL_TEST_KEY: 'local-integration-key' },
  });
  if (sharedProvider) child.stdin.write(JSON.stringify({ type: 'configure', provider: { ...sharedProvider, providers: undefined }, providers: sharedProvider.providers, ...(workspace ? { workspace } : { project }), ...(cli ? { cli } : {}) }) + '\n');
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

function assertRestoredHistory(stream, before) {
  const restored = events(stream);
  assert.deepEqual(restored.slice(0, before.length), before, 'restore preserves the exact durable history prefix');
  for (const event of restored.slice(before.length)) {
    assert.equal(event.type, 'session/end-seed', 'only the upstream shutdown boundary may be appended');
  }
}

// Office transport fixtures only: the real rc.2 provider/Agent/registry and
// NativeSourceBridge run below, but no Rust File service or Office engine runs.
// Native engine edits, CAS and format preservation are tested separately.
function officeFixture(format) {
  const sourceRef = { object: { workspaceId: 'office-transport', scope: { kind: 'project', projectId: 118 }, kind: 'file', id: '42' },
    revision: 'sha256:' + 'a'.repeat(64), fileVersion: 3, recordVersion: null, blockId: null, locator: null, title: `中文.${format}`, excerpt: '' };
  const views = {
    docx: { format, nodes: [{ id: 'p0', type: 'paragraph', text: '原文' }], readOnly: false },
    xlsx: { format, sheets: [{ id: 'sheet1', name: '工作表', hidden: false, veryHidden: false, rowCount: 1, columnCount: 2 }],
      ranges: { sheet1: { area: 'A1:B1', cells: [{ row: 0, column: 0, value: 2 }, { row: 0, column: 1, value: 4, formula: 'A1*2' }] } }, definedNames: [] },
    pptx: { format, size: { width: 1280, height: 720 }, textElements: [{ slideIndex: 0, cNvPrId: '2', paragraphIndex: 0, runIndex: 0, text: '原文' }],
      pictureElements: [], limitations: [] },
  };
  const edits = {
    docx: [{ type: 'text', nodeId: 'p0', text: '修改', expectedText: '原文' }],
    xlsx: [{ sheetId: 'sheet1', row: 0, column: 1, kind: 'formula', formula: 'A1*3' }],
    pptx: [{ kind: 'text', slideIndex: 0, cNvPrId: '2', paragraphIndex: 0, runIndex: 0, text: '修改' }],
  };
  const view = views[format];
  const model = { ...view, assets: [{ dataUrl: 'PRIVATE_OFFICE_BINARY' }], document: { content: ['PRIVATE_OFFICE_RENDERER'] } };
  if (format === 'xlsx') {
    model.sheets = view.sheets.map(sheet => ({ ...sheet, renderer: 'PRIVATE_OFFICE_RENDERER' }));
    model.ranges = { sheet1: { ...view.ranges.sheet1, cells: view.ranges.sheet1.cells.map(cell => ({ ...cell, style: 'PRIVATE_OFFICE_RENDERER' })) } };
  }
  const savedRef = { ...sourceRef, revision: 'sha256:' + 'b'.repeat(64), fileVersion: 4 };
  return { sourceRef, edits: edits[format], view, inspected: { sourceRef, model },
    saved: { sourceRef: savedRef, model, commit: { requestId: 'fixture-commit', versionNumber: 4 } } };
}

function providerToolReply(bodies, callId) {
  const message = bodies.at(-1)?.messages.find(message => message.role === 'tool' && message.tool_call_id === callId);
  assert.ok(message, `provider must receive the actual tool result for ${callId}`);
  return typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('');
}

test('Office rc.2 transport: real provider discovers tools and actual Session forwards fixed File edits', { timeout: 60000 }, async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'mind-office-transport-'));
  const directory = await realpath(temp);
  const bodies = [], operations = [];
  const provider = await startLocalProvider({ onSyntheticRequest: body => bodies.push(body) });
  let runtime, stream, fixture;
  t.after(async () => {
    try { await stream?.close(); } finally {
      try { await runtime?.stop(); } finally { await provider.close(); await rm(temp, { recursive: true, force: true }); }
    }
  });
  const data = path.join(temp, 'data');
  const shared = { name: 'Office local fixture', modelId: 'local-test-model', baseUrl: provider.url, apiKey: 'local-integration-key', supportsImage: false };
  const project = { id: 118, name: 'Office transport', directory };
  const handleSource = payload => {
    operations.push(payload);
    if (payload.operation === 'officeInspect') return fixture.inspected;
    if (payload.operation === 'officeEdit') return fixture.saved;
    throw new Error(`Unexpected native transport operation: ${payload.operation}`);
  };
  runtime = await launch(data, undefined, shared, project, undefined, handleSource);
  const { sessionId } = await runtime.rpc('session/create', {});
  await runtime.rpc('session/rename', { sessionId, title: 'Office transport fixture' });
  stream = await follow(runtime, sessionId);
  assert.equal(stream.snapshot.header.cwd, directory);
  await prompt(runtime, stream, sessionId, 'Discover the available Office tools');
  const discovered = bodies[0].tools.filter(tool => tool.function.name.startsWith('file_office_'));
  assert.deepEqual(discovered.map(tool => tool.function.name).sort(), ['file_office_edit', 'file_office_inspect']);
  const inspectSchema = discovered.find(tool => tool.function.name === 'file_office_inspect').function.parameters;
  assert.equal(inspectSchema.properties.file_path.type, 'string');
  assert.deepEqual(inspectSchema.required, ['file_path']);
  const editSchema = discovered.find(tool => tool.function.name === 'file_office_edit').function.parameters;
  assert.deepEqual([...editSchema.required].sort(), ['edits', 'source_ref']);
  assert.equal(editSchema.properties.edits.type, 'array');
  assert.ok(Object.hasOwn(editSchema.properties, 'source_ref'));
  assert.deepEqual(operations, [], 'discovery alone must not request native File bytes');

  for (const format of ['docx', 'xlsx', 'pptx']) await t.test(format, async () => {
    fixture = officeFixture(format);
    const inspectId = `office-inspect-${format}`;
    provider.enqueueResponse({ chunks: [''], toolCalls: [{ index: 0, id: inspectId, type: 'function', function: {
      name: 'file_office_inspect', arguments: JSON.stringify({ file_path: fixture.sourceRef.title }),
    } }] });
    await prompt(runtime, stream, sessionId, `Inspect the ${format} File`);
    assert.deepEqual(operations.at(-1), { operation: 'officeInspect', sessionId, path: fixture.sourceRef.title });
    const inspected = JSON.parse(providerToolReply(bodies, inspectId));
    assert.deepEqual(inspected, { sourceRef: fixture.sourceRef, model: fixture.view });
    assert.doesNotMatch(providerToolReply(bodies, inspectId), /PRIVATE_OFFICE_/);

    // Use the sourceRef actually returned to the provider, not a live path or
    // a second registry-only call. The queued SSE call drives the real Agent.
    const editId = `office-edit-${format}`;
    const args = { source_ref: inspected.sourceRef, edits: fixture.edits };
    provider.enqueueResponse({ chunks: [''], toolCalls: [{ index: 0, id: editId, type: 'function', function: {
      name: 'file_office_edit', arguments: JSON.stringify(args),
    } }] });
    await prompt(runtime, stream, sessionId, `Save the ${format} edit`);
    assert.deepEqual(operations.at(-1), { operation: 'officeEdit', sessionId, requestId: editId, sourceRef: inspected.sourceRef, edits: fixture.edits });
    const call = events(stream).find(event => event.type === 'tool/call' && event.data.callId === editId);
    assert.equal(call?.data.name, 'file_office_edit');
    assert.deepEqual(JSON.parse(call.data.arguments), args);
    assert.equal(operations.at(-1).requestId, call.data.callId, 'native request identity must equal the real exec.callId');
    const result = events(stream).find(event => event.type === 'tool/result' && event.data.message.source.callId === editId);
    assert.equal(result?.data.message.isError, false);
    const expected = { sourceRef: fixture.saved.sourceRef, model: fixture.view, commit: fixture.saved.commit };
    assert.deepEqual(JSON.parse(result.data.message.content.map(block => block.text).join('')), expected);
    assert.deepEqual(JSON.parse(providerToolReply(bodies, editId)), expected);
    assert.doesNotMatch(providerToolReply(bodies, editId), /PRIVATE_OFFICE_/);
  });
  assert.equal(operations.length, 6, 'each provider call crosses native transport exactly once');
  const beforeRestart = events(stream).filter(event => event.type === 'tool/call' || event.type === 'tool/result');
  await stream.close(); stream = undefined;
  await runtime.stop();
  runtime = await launch(data, undefined, shared, project, undefined, handleSource);
  stream = await follow(runtime, sessionId);
  assert.deepEqual(events(stream).filter(event => event.type === 'tool/call' || event.type === 'tool/result'), beforeRestart);
  await prompt(runtime, stream, sessionId, 'Continue after restart without another edit');
  assert.equal(operations.length, 6, 'history replay must not repeat native saves');
  for (const format of ['docx', 'xlsx', 'pptx']) assert.ok(bodies.at(-1).messages.some(message => message.role === 'tool' && message.tool_call_id === `office-edit-${format}`));
});

test('Office rc.2 transport: registered pre/post tool policies still deny, replace and block', { timeout: 60000 }, async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'mind-office-policy-'));
  const directory = await realpath(temp);
  const bodies = [], operations = [];
  const fixture = officeFixture('docx');
  const provider = await startLocalProvider({ onSyntheticRequest: body => bodies.push(body) });
  let runtime, stream;
  t.after(async () => {
    try { await stream?.close(); } finally {
      try { await runtime?.stop(); } finally { await provider.close(); await rm(temp, { recursive: true, force: true }); }
    }
  });
  const trace = path.join(temp, 'policy.jsonl');
  const policy = path.join(temp, 'office-policy.mjs');
  const patch = path.join(temp, 'office.patch.yml');
  await writeFile(trace, '');
  await writeFile(policy, `import { appendFileSync } from 'node:fs';
export const name = 'office-transport-test-policy';
export function apply(ctx) {
  const record = (stage, exec, result) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({stage, name: exec.name, callId: exec.callId, sessionId: exec.agent?.session.id, ...(result ? {isError: result.isError} : {})}) + '\\n');
  ctx.on('tools/pre-execute', (exec, next) => {
    if (!exec.name.startsWith('file_office_')) return next();
    record('pre', exec);
    if (exec.callId.endsWith('-pre-deny')) return {kind: 'deny', reason: 'Office pre-policy denied'};
    return next();
  });
  ctx.on('tools/post-execute', (exec, result, next) => {
    if (!exec.name.startsWith('file_office_')) return next();
    record('post', exec, result);
    if (exec.callId.endsWith('-post-content')) return {kind: 'accept', content: [{type: 'text', text: 'Office policy replacement content'}]};
    if (exec.callId.endsWith('-post-value')) return {kind: 'accept', value: {policy: 'Office replacement value'}};
    if (exec.callId.endsWith('-post-block')) return {kind: 'block', feedback: [{type: 'text', text: 'Office post-policy blocked'}]};
    return next();
  });
}
`);
  await writeFile(patch, '- insert:\n    - id: office-transport-test-policy\n      name: ' + JSON.stringify(policy) + '\n');
  runtime = await launch(path.join(temp, 'data'), patch,
    { name: 'Office local fixture', modelId: 'local-test-model', baseUrl: provider.url, apiKey: 'local-integration-key', supportsImage: false },
    { id: 118, name: 'Office policy transport', directory }, undefined, payload => {
      operations.push(payload);
      if (payload.requestId?.endsWith('-native-error')) throw new Error('Office native transport conflict');
      if (payload.operation === 'officeInspect') return fixture.inspected;
      if (payload.operation === 'officeEdit') return fixture.saved;
      throw new Error(`Unexpected native transport operation: ${payload.operation}`);
    });
  const { sessionId } = await runtime.rpc('session/create', {});
  await runtime.rpc('session/rename', { sessionId, title: 'Office policy fixture' });
  stream = await follow(runtime, sessionId);
  for (const name of ['file_office_inspect', 'file_office_edit']) {
    const cases = ['allow', 'pre-deny', 'post-content', 'post-value', 'post-block', ...(name === 'file_office_edit' ? ['native-error'] : [])];
    for (const mode of cases) await t.test(`${name} ${mode}`, async () => {
      const callId = `${name}-${mode}`;
      const args = name === 'file_office_inspect' ? { file_path: fixture.sourceRef.title } : { source_ref: fixture.sourceRef, edits: fixture.edits };
      const before = operations.length;
      provider.enqueueResponse({ chunks: [''], toolCalls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      await prompt(runtime, stream, sessionId, `Office policy case ${callId}`);
      assert.equal(operations.length - before, mode === 'pre-deny' ? 0 : 1, 'pre denial must prevent native dispatch; post policy runs after dispatch');
      if (mode !== 'pre-deny') assert.deepEqual(operations.at(-1), name === 'file_office_inspect'
        ? { operation: 'officeInspect', sessionId, path: fixture.sourceRef.title }
        : { operation: 'officeEdit', sessionId, requestId: callId, sourceRef: fixture.sourceRef, edits: fixture.edits });
      const entries = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.callId === callId);
      assert.deepEqual(entries.map(entry => entry.stage), ['pre', 'post']);
      for (const entry of entries) { assert.equal(entry.name, name); assert.equal(entry.sessionId, sessionId); }
      assert.equal(entries[1].isError, ['pre-deny', 'native-error'].includes(mode));
      const result = events(stream).find(event => event.type === 'tool/result' && event.data.message.source.callId === callId);
      assert.ok(result, runtime.diagnostics());
      assert.equal(result.data.message.isError, ['pre-deny', 'post-block', 'native-error'].includes(mode));
      const projected = providerToolReply(bodies, callId);
      assert.equal(result.data.message.content.map(block => block.text).join(''), projected, 'provider receives the policy-finalized durable result');
      if (mode === 'allow') assert.deepEqual(JSON.parse(projected), name === 'file_office_inspect'
        ? { sourceRef: fixture.sourceRef, model: fixture.view }
        : { sourceRef: fixture.saved.sourceRef, model: fixture.view, commit: fixture.saved.commit });
      else if (mode === 'post-value') assert.deepEqual(JSON.parse(projected), { policy: 'Office replacement value' });
      else assert.ok(projected.includes({ 'pre-deny': 'Office pre-policy denied', 'post-content': 'Office policy replacement content',
        'post-block': 'Office post-policy blocked', 'native-error': 'Office native transport conflict' }[mode]), projected);
      assert.doesNotMatch(projected, /PRIVATE_OFFICE_/);
      if (['post-content', 'post-value', 'post-block'].includes(mode)) assert.doesNotMatch(projected, /sourceRef|fixture-commit|原文/);
    });
  }
});

test('long first questions receive a summarized title through the embedded auxiliary model', { timeout: 60000 }, async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'mind-long-title-'));
  const bodies = [];
  const summarizedTitle = '项目会话联动验收';
  const provider = await startLocalProvider({ onSyntheticRequest(body) {
    bodies.push(body);
    const isTitle = body.messages.some(message => typeof message.content === 'string' && message.content.startsWith('Generate the session title'));
    provider.enqueueResponse({ chunks: [isTitle ? summarizedTitle : 'Synthetic answer'] });
  } });
  let runtime, stream;
  t.after(async () => { await stream?.close(); await runtime?.stop(); await provider.close(); await rm(temp, { recursive: true, force: true }); });
  const directory = await realpath(temp);
  const shared = { name: 'local', modelId: 'local-test-model', baseUrl: provider.url, apiKey: 'local-integration-key', supportsImage: false };
  runtime = await launch(path.join(temp, 'data'), undefined, shared, { id: 7, name: 'Title', directory });
  const { sessionId } = await runtime.rpc('session/create', {});
  stream = await follow(runtime, sessionId);
  const text = '请先检查项目会话。\n' + '验收包括待办状态、记录修订、文件版本和今日计划。\n'.repeat(90);
  assert.ok(Buffer.byteLength(text) > 4096);
  await prompt(runtime, stream, sessionId, text);
  const generated = await stream.read(frame => frame.type === 'event' && frame.event.type === 'session/title' && frame.event.data.source.kind === 'provider', 'summarized long-question title');
  assert.equal(generated.event.data.title, summarizedTitle);
  const fallback = events(stream).find(event => event.type === 'session/title' && event.data.source.kind === 'fallback');
  assert.notEqual(generated.event.data.title, fallback.data.title);
  const titleRequests = bodies.filter(body => body.messages.some(message => typeof message.content === 'string' && message.content.startsWith('Generate the session title')));
  assert.equal(titleRequests.length, 1);
  assert.equal(titleRequests[0].max_tokens ?? titleRequests[0].max_completion_tokens, 1024);
  const titleInput = titleRequests[0].messages.find(message => typeof message.content === 'string' && message.content.startsWith('Generate the session title')).content;
  const titleMessages = JSON.parse(titleInput.slice(titleInput.indexOf('\n') + 1));
  assert.equal(titleMessages.length, 1);
  assert.equal(titleMessages[0].text, text, 'the auxiliary model receives the full first prompt');
  assert.ok(bodies.some(body => body !== titleRequests[0] && body.messages.some(message =>
    message.role === 'user' && (typeof message.content === 'string' ? message.content :
      message.content.filter(block => block.type === 'text').map(block => block.text).join('')).includes(text))),
  'title generation preserves the original main-model prompt');
  const listed = (await runtime.rpc('session/list', {}, '_request')).items.find(item => item.sessionId === sessionId);
  assert.equal(listed.title ?? listed.projections.values.title, summarizedTitle);
  assert.equal(events(stream).find(event => event.type === 'user/message').data.content[0].text, text);
});

test('fixed source auto titles reach the catalog and header without changing stored user/model projections', { timeout: 60000 }, async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'mind-source-title-'));
  const bodies = [], operations = [];
  const provider = await startLocalProvider({ onSyntheticRequest: body => bodies.push(body) });
  let runtime, stream;
  t.after(async () => { await stream?.close(); await runtime?.stop(); await provider.close(); await rm(temp, { recursive: true, force: true }); });
  const directory = await realpath(temp);
  const sourceRef = { object: { workspaceId: 'title-fixture', scope: { kind: 'project', projectId: 7 }, kind: 'file', id: '9' }, revision: 'sha256:' + 'a'.repeat(64), fileVersion: 1, recordVersion: null, blockId: null, title: 'sample.txt', locator: { kind: 'line', start: 1, end: 120 }, excerpt: '' };
  const token = `mind-source/${Buffer.from(JSON.stringify(sourceRef)).toString('base64url')}/sample.txt`;
  const projection = `@${token}\n<mind-file-source>${JSON.stringify({ id: 'fixed-v1', sourceRef, offset: 1, limit: 120, requestedLimit: 120, truncated: false, content: Array.from({ length: 120 }, (_, i) => `${i + 1}: immutable model bytes for this source`).join('\n') }).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')}</mind-file-source>`;
  const data = path.join(temp, 'data');
  const shared = { name: 'local', modelId: 'local-test-model', baseUrl: provider.url, apiKey: 'local-integration-key', supportsImage: false };
  const project = { id: 7, name: 'Title', directory };
  const handleSource = payload => { operations.push(payload); return null; };
  runtime = await launch(data, undefined, shared, project, undefined, handleSource);
  const { sessionId } = await runtime.rpc('session/create', {});
  stream = await follow(runtime, sessionId);
  const text = `${projection}\nacceptance ordinary prompt`;
  await prompt(runtime, stream, sessionId, text);
  const fallback = events(stream).find(event => event.type === 'session/title' && event.data.source.kind === 'fallback');
  assert.equal(fallback?.data.title, 'sample.txt · v1 acceptance ordinary');
  const titleBody = await waitFor(() => bodies.find(body => body.messages.some(message => typeof message.content === 'string' && message.content.startsWith('Generate the session title'))), 'actual auxiliary title provider input');
  const titleInput = titleBody.messages.find(message => typeof message.content === 'string' && message.content.startsWith('Generate the session title')).content;
  assert.ok(titleInput.includes('sample.txt · v1'));
  assert.doesNotMatch(titleInput, /mind-source|mind-file-source|immutable model bytes/);
  const generated = await stream.read(frame => frame.type === 'event' && frame.event.type === 'session/title' && frame.event.data.source.kind === 'provider', 'provider title');
  const listed = (await runtime.rpc('session/list', {}, '_request')).items.find(item => item.sessionId === sessionId);
  const listedTitle = listed.title ?? listed.projections.values.title;
  assert.equal(listedTitle, generated.event.data.title);
  assert.doesNotMatch(listedTitle, /mind-source|mind-file-source/);
  await stream.close(); await runtime.stop();
  runtime = await launch(data, undefined, shared, project, undefined, handleSource);
  stream = await follow(runtime, sessionId);
  assert.equal(stream.snapshot.projections.values.title, listedTitle, 'header uses the same durable title projection');
  const stored = events(stream).find(event => event.type === 'user/message');
  assert.equal(stored.data.content[0].text, text);
  assert.ok(bodies.some(body => body.messages.some(message => message.role === 'user' && (typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('')).includes(projection))));
  assert.ok(operations.some(payload => payload.operation === 'delivery' && payload.projection === projection && payload.sessionId === sessionId && payload.projectionHash === createHash('sha256').update(projection).digest('hex')));
  await runtime.rpc('session/rename', { sessionId, title: '@ordinary/path title' });
  const renamed = (await runtime.rpc('session/list', {}, '_request')).items.find(item => item.sessionId === sessionId);
  assert.equal(renamed.title ?? renamed.projections.values.title, '@ordinary/path title');
  await stream.close();
  const ordinary = await runtime.rpc('session/create', {});
  stream = await follow(runtime, ordinary.sessionId);
  await prompt(runtime, stream, ordinary.sessionId, '@ordinary/path unchanged');
  assert.equal(events(stream).find(event => event.type === 'session/title' && event.data.source.kind === 'fallback').data.title, '@ordinary/path unchanged');
});

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
    const metadata = { id: randomUUID(), sourceRef: { ...(payload.sourceRef ?? sourceRef), locator: { kind: 'line', start: 1, end: 1 } }, offset: payload.offset, limit: 1, requestedLimit: payload.limit, truncated: false, content: payload.sourceRef ? '1: fixed historical bytes' : '1: tool snapshot bytes' };
    const token = `mind-source/${Buffer.from(JSON.stringify(metadata.sourceRef)).toString('base64url')}/old.md`;
    return { sourceRef: metadata.sourceRef, projection: `@${token}\n<mind-file-source>${JSON.stringify(metadata).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')}</mind-file-source>`, readValue: {path:token, offset:1, lines:[{number:1,text:metadata.content.slice(3)}], totalLines:1, truncated:false} };
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
  const sourceRef = { object: { workspaceId: 'ptc', scope: { kind: 'project', projectId: 8 }, kind: 'file', id: '9' }, revision: 'sha256:' + 'a'.repeat(64), fileVersion: 1, recordVersion: null, blockId: null, locator: { kind: 'line', start: 1, end: 1 }, title: 'nested.md', excerpt: '' };
  let prepared;
  runtime = await launch(path.join(temp, 'data'), patch, { name: 'local', modelId: 'local-test-model', baseUrl: provider.url, apiKey: 'local-integration-key', supportsImage: false }, { id: 8, name: 'PTC', directory }, undefined, payload => {
    operations.push(payload);
    if (payload.operation === 'delivery') return null;
    const metadata = { id: randomUUID(), sourceRef, offset: 1, limit: 1, requestedLimit: 1, truncated: false, content: '1: immutable nested bytes' };
    const token = `mind-source/${Buffer.from(JSON.stringify(sourceRef)).toString('base64url')}/nested.md`;
    prepared = `@${token}\n<mind-file-source>${JSON.stringify(metadata).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')}</mind-file-source>`;
    return { projection: prepared, sourceRef, readValue: { path: token, offset: 1, lines: [{ number: 1, text: 'immutable nested bytes' }], totalLines: 1, truncated: false } };
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
  assertRestoredHistory(stream, beforeRestart);
  await prompt(runtime, stream, sessionId, 'Integration after restart');
  assert.equal(provider.requests.length, 7);
  assert.deepEqual(provider.requests[6].roles.slice(0, firstRoles.length), firstRoles);
  assert.ok(provider.requests[6].messageCount > provider.requests[5].messageCount, 'post-restart provider receives growing history');
  assert.equal(events(stream).filter((event) => event.type === 'user/message' && event.data.source.kind === 'user').length, 7);
  assert.ok(provider.requests[6].roles.includes('assistant'));
});

test('embedded assistant advertises, disables and re-enables the bundled CLI Skill without a model request', { timeout: 45000 }, async t => {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'mind-dsh-skills-')));
  const provider = await startLocalProvider();
  const project = { id: 149, name: 'Skills fixture', directory: path.join(temporary, 'project') };
  await mkdir(project.directory);
  let runtime;
  let workspaceRuntime;
  t.after(async () => {
    try { await Promise.all([runtime?.stop(), workspaceRuntime?.stop()]); }
    finally { await provider.close(); await rm(temporary, { recursive: true, force: true }); }
  });
  const data = path.join(temporary, 'data');
  const shared = {
    name: 'Skills fixture', baseUrl: provider.url, modelId: 'local-test-model',
    apiKey: 'local-integration-key', supportsImage: false,
  };
  const manage = async (action, entryPath) => {
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, 'scripts/skills.mjs'), '--cwd', project.directory,
      ...(action ? ['--action', action, '--entry', entryPath] : [])], {
      env: { ...process.env, PROJECT_MIND_DSH_USER_DATA: data, PROJECT_MIND_DSH_SKILLS_DATA: path.join(temporary, 'skill-management') },
    });
    return JSON.parse(stdout);
  };
  runtime = await launch(data, undefined, shared, project);
  const { sessionId } = await runtime.rpc('session/create', {});
  const catalog = await runtime.rpc('skills/list', { sessionId });
  const cli = catalog.skills.find(skill => skill.name === 'project-mind-cli');
  assert.ok(cli, 'the actual assistant Session must discover its bundled CLI Skill');
  assert.equal(cli.modelInvocable, true);
  assert.equal(cli.path, path.join(root, 'skills/project-mind-cli/SKILL.md'));
  const workspace = { id: randomUUID(), name: 'Skills workspace', directory: path.join(temporary, 'workspace') };
  await mkdir(workspace.directory);
  workspaceRuntime = await launch(path.join(temporary, 'workspace-data'), undefined, shared, undefined, undefined, undefined, workspace);
  const workspaceSession = await workspaceRuntime.rpc('session/create', {});
  const workspaceHasBuiltin = async () => (await workspaceRuntime.rpc('skills/list', { sessionId: workspaceSession.sessionId })).skills.some(skill => skill.name === 'project-mind-cli');
  assert.ok(await workspaceHasBuiltin());
  const settings = await manage();
  const entry = settings.skills.find(skill => skill.name === 'project-mind-cli');
  const disabled = await manage('disable', entry.entryPath);
  assert.equal(disabled.skills.find(skill => skill.name === 'project-mind-cli').disabled, true);
  await waitFor(async () => !(await runtime.rpc('skills/list', { sessionId })).skills.some(skill => skill.name === 'project-mind-cli'), 'running Session removes disabled builtin');
  await waitFor(async () => !await workspaceHasBuiltin(), 'Workspace Session shares disabled builtin state');
  await runtime.stop();
  runtime = await launch(data, undefined, shared, project);
  const restarted = await runtime.rpc('session/create', {});
  assert.ok(!(await runtime.rpc('skills/list', { sessionId: restarted.sessionId })).skills.some(skill => skill.name === 'project-mind-cli'), 'restart must preserve disabled state');
  const disabledEntry = disabled.skills.find(skill => skill.name === 'project-mind-cli');
  await manage('enable', disabledEntry.entryPath);
  await waitFor(async () => (await runtime.rpc('skills/list', { sessionId: restarted.sessionId })).skills.some(skill => skill.name === 'project-mind-cli'), 'running Session sees re-enabled builtin');
  await waitFor(workspaceHasBuiltin, 'Workspace Session shares re-enabled builtin state');
  assert.equal(provider.requests.length, 0);
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
  assertRestoredHistory(stream, durable);
  await prompt(runtime, stream, sessionId, 'Main model after restart');
  assert.equal(provider.requests[1].model, shared.modelId);
  const beforeModelChange = events(stream);
  await stream.close(); stream = undefined;
  await runtime.stop();
  const changed = { ...shared, modelId: 'changed-main-model' };
  runtime = await launch(data, undefined, changed, project);
  stream = await follow(runtime, sessionId);
  assert.equal(stream.snapshot.projections.values.modelSelection.next.model, shared.modelId);
  assertRestoredHistory(stream, beforeModelChange);
  await runtime.rpc('session/selectModel', { sessionId, provider: 'mind-main', model: changed.modelId });
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

// Authenticate fixture requests without recording secret-bearing headers.
async function authenticatedProvider(key) {
  const fixture = await startLocalProvider();
  let accepted = 0;
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(401); res.end('Wrong fixture credential'); return;
    }
    accepted++;
    const upstream = httpRequest(new URL(req.url, fixture.url), { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { res.destroy(); });
    req.pipe(upstream);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { ...fixture, url: `http://127.0.0.1:${server.address().port}/v1`, accepted: () => accepted,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await fixture.close();
    },
  };
}

test('embedded model catalog, running next request, Session isolation and durable follow', { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mind-dsh-models-'));
  const main = await authenticatedProvider('local-integration-key');
  const alternate = await authenticatedProvider('alternative-integration-key');
  const gated = main.enqueueResponse({ chunks: ['first request remains main'], manual: true });
  const provider = { name: 'Main', baseUrl: main.url, modelId: 'main-test-model', apiKey: 'local-integration-key', supportsImage: false };
  const alternative = { id: 'mind-profile-42', name: 'Alternative', baseUrl: alternate.url, modelId: 'alternate-test-model', apiKey: 'alternative-integration-key', supportsImage: false };
  const shared = { ...provider, providers: [alternative] };
  const data = path.join(temporary, 'data');
  const project = { id: 1, name: 'Models', directory: await realpath(temporary) };
  let runtime, stream, thirdStream;
  t.after(async () => { await stream?.close(); await thirdStream?.close(); await runtime?.stop(); await main.close(); await alternate.close(); await rm(temporary, { recursive: true, force: true }); });
  runtime = await launch(data, undefined, shared, project);
  const catalog = await runtime.rpc('session/modelCatalog');
  assert.deepEqual(catalog.groups.map(group => group.id), ['mind-main', alternative.id]);
  const { sessionId } = await runtime.rpc('session/create', {});
  const second = await runtime.rpc('session/create', {});
  await runtime.rpc('session/selectModel', { sessionId: second.sessionId, provider: 'mind-main', model: provider.modelId });
  stream = await follow(runtime, sessionId);
  await runtime.rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Synthetic running request' }] });
  await waitFor(() => main.requests[0]?.outcome === 'streaming', 'main request in flight');
  await runtime.rpc('session/selectModel', { sessionId, provider: alternative.id, model: alternative.modelId });
  const selection = (await runtime.rpc('session/projections', { sessionId })).values.modelSelection;
  assert.equal(selection.next.provider, alternative.id);
  assert.equal(selection.lastUsed.provider, 'mind-main');
  assert.equal(main.requests[0].model, provider.modelId);
  assert.ok(main.accepted() > 0);
  assert.equal(alternate.requests.length, 0);
  const isolated = (await runtime.rpc('session/projections', { sessionId: second.sessionId })).values.modelSelection;
  assert.equal(isolated.next.provider, 'mind-main');
  gated.advance();
  await stream.read(frame => frame.type === 'event' && frame.event.type === 'turn/end', 'first turn completes');
  await prompt(runtime, stream, sessionId, 'Synthetic next request');
  assert.ok(alternate.requests.some(request => request.model === alternative.modelId && request.outcome === 'completed'));
  assert.ok(alternate.accepted() > 0);
  const third = await runtime.rpc('session/create', {});
  thirdStream = await follow(runtime, third.sessionId);
  await prompt(runtime, thirdStream, third.sessionId, 'Synthetic independent new Session');
  const thirdSelection = (await runtime.rpc('session/projections', { sessionId: third.sessionId })).values.modelSelection;
  assert.equal(thirdSelection.lastUsed.provider, 'mind-main', 'a Session created after another selects an alternative must use the native default');
  assert.equal(thirdSelection.lastUsed.model, provider.modelId);
  assert.deepEqual((await runtime.rpc('session/modelCatalog')).default, { provider: 'mind-main', model: provider.modelId });
  await thirdStream.close(); thirdStream = undefined;
  await stream.close(); stream = undefined; await runtime.stop();
  runtime = await launch(data, undefined, shared, project);
  stream = await follow(runtime, sessionId);
  assert.equal(stream.snapshot.projections.values.modelSelection.next.provider, alternative.id);
  await prompt(runtime, stream, sessionId, 'Synthetic restored request');
  const beforeRemoval = events(stream);
  await stream.close(); stream = undefined; await runtime.stop();
  const credentials = await readFile(path.join(data, '.credentials.yaml'), 'utf8');
  for (const key of [provider.apiKey, alternative.apiKey]) assert.ok(!credentials.includes(key));
  runtime = await launch(data, undefined, provider, project);
  stream = await follow(runtime, sessionId);
  assert.equal(stream.snapshot.projections.values.modelSelection.next.provider, alternative.id);
  assert.equal(stream.snapshot.projections.values.modelSelection.next.model, alternative.modelId);
  assertRestoredHistory(stream, beforeRemoval);
  // An explicit valid selection recovers a stale conversation without replacing history.
  await runtime.rpc('session/selectModel', { sessionId, provider: 'mind-main', model: provider.modelId });
  const recovered = (await runtime.rpc('session/projections', { sessionId })).values.modelSelection;
  assert.equal(recovered.next.provider, 'mind-main');
  await prompt(runtime, stream, sessionId, 'Synthetic recovered request');
  assert.equal(main.requests.at(-1).model, provider.modelId);
});


test('Workspace runtime: real chat, stop, restore and isolation from Project history', { timeout: 90000 }, async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'mind-workspace-runtime-'));
  const directory = await realpath(temp);
  const workspace = { id: randomUUID(), name: 'Workspace fixture', directory };
  const project = { id: 161, name: 'Project fixture', directory: path.join(directory, 'Project') };
  await mkdir(project.directory);
  const bodies = [];
  const provider = await startLocalProvider({ onSyntheticRequest: body => bodies.push(body) });
  const shared = { name: 'Local shared model', baseUrl: provider.url, modelId: 'local-test-model', apiKey: 'local-integration-key', supportsImage: false };
  const data = path.join(temp, 'history', workspace.id);
  const profile = path.join(temp, 'profiles', 'assistant');
  let runtime, projectRuntime, stream, projectStream;
  t.after(async () => {
    await Promise.all([stream?.close(), projectStream?.close()]);
    await Promise.all([runtime?.stop(), projectRuntime?.stop()]);
    await provider.close(); await rm(temp, { recursive: true, force: true });
  });
  const startWorkspace = () => launch(path.join(data, 'workspace'), undefined, shared, undefined, profile, undefined, workspace);
  runtime = await startWorkspace();
  const sourceResponse = await fetch(`${runtime.origin}/api/mind/source/resolve`, {
    method: 'POST', headers: { ...runtime.headers, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(sourceResponse.status, 404, 'Workspace never installs the Project source route');
  await sourceResponse.arrayBuffer();
  const mapped = (await runtime.rpc('workspace/initializeDefault')).workspace;
  assert.equal(mapped.path, directory);
  assert.equal(mapped.title, workspace.name);
  await assert.rejects(runtime.rpc('workspace/create', { path: project.directory }));
  await assert.rejects(runtime.rpc('workspace/rename', { workspaceId: mapped.workspaceId, title: 'No' }));
  await assert.rejects(runtime.rpc('workspace/delete', { workspaceId: mapped.workspaceId }));
  await assert.rejects(runtime.rpc('session/create', { cwd: project.directory }));
  await assert.rejects(runtime.rpc('session/create', { workspaceId: 'foreign-workspace' }));
  const { sessionId } = await runtime.rpc('session/create', {});
  await runtime.rpc('session/rename', { sessionId, title: 'Workspace history' });
  stream = await follow(runtime, sessionId);
  assert.equal(stream.snapshot.header.cwd, directory);
  await prompt(runtime, stream, sessionId, 'Workspace first turn');
  assert.ok(events(stream).some(event => event.type === 'assistant/message' && assistantText(event) === 'Local test provider reply.'));
  assert.equal(provider.requests[0].model, shared.modelId);
  const modelCatalog = await runtime.rpc('session/modelCatalog');
  assert.deepEqual(modelCatalog.groups.map(group => group.id), ['mind-main']);
  assert.deepEqual((await runtime.rpc('session/selectModel', { sessionId, provider: 'mind-main', model: shared.modelId })).selected, { provider: 'mind-main', model: shared.modelId });
  const toolNames = bodies[0].tools.map(tool => tool.function.name);
  assert.ok(toolNames.length > 0, 'ordinary DSH tools remain available');
  assert.ok(!toolNames.some(name => name.startsWith('file_office_')), 'Workspace never installs Project Office tools');
  await writeFile(path.join(directory, 'workspace-note.txt'), 'Workspace ordinary file bytes');
  provider.enqueueResponse({ chunks: [''], toolCalls: [{ index: 0, id: 'workspace-read-call', type: 'function', function: {
    name: 'read', arguments: JSON.stringify({ file_path: 'workspace-note.txt', offset: 1, limit: 1 }),
  } }] });
  await prompt(runtime, stream, sessionId, 'Read the ordinary Workspace file');
  assert.match(providerToolReply(bodies, 'workspace-read-call'), /Workspace ordinary file bytes/);
  const readResult = events(stream).find(event => event.type === 'tool/result' && event.data.message.source.callId === 'workspace-read-call');
  assert.equal(readResult?.data.message.isError, false, 'ordinary read executes without the Project source bridge');
  const uploadResponse = await fetch(`${runtime.origin}/api/session/uploadFileBinary?sessionId=${encodeURIComponent(sessionId)}&name=workspace-attachment.txt`, {
    method: 'POST', headers: { ...runtime.headers, 'content-type': 'application/octet-stream' }, body: 'Workspace attachment bytes',
  });
  assert.equal(uploadResponse.status, 200);
  const uploaded = await uploadResponse.json();
  assert.equal(uploaded.ok, true, redact(JSON.stringify(uploaded.error)));
  const attachmentFrom = stream.frames.length;
  await runtime.rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [
    { type: 'text', text: 'Workspace attachment prompt' }, { type: 'file', receiptId: uploaded.value.receiptId },
  ] });
  const attachmentEnd = await stream.read(frame => stream.frames.indexOf(frame) >= attachmentFrom && frame.type === 'event' && frame.event.type === 'turn/end', 'Workspace attachment turn completes');
  assert.equal(attachmentEnd.event.data.reason.kind, 'completed');
  assert.ok(events(stream).some(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'file')), 'ordinary attachment persists in the Workspace message');
  const stopRequestIndex = provider.requests.length;
  provider.enqueueResponse({ manual: true, chunks: ['Workspace partial', 'Do not emit'] }).advance();
  const turn = prompt(runtime, stream, sessionId, 'Workspace stop', 'aborted');
  await stream.read(frame => frame.type === 'assistant-stream' && frame.frame.type === 'chunk' && frame.frame.chunk.type === 'text-delta' && frame.frame.chunk.text === 'Workspace partial', 'Workspace partial response');
  await runtime.rpc('session/cancel', { sessionId }); await turn;
  await waitFor(() => provider.requests[stopRequestIndex].outcome === 'aborted', 'Workspace cancel reaches provider');
  await prompt(runtime, stream, sessionId, 'Workspace after stop');

  projectRuntime = await launch(path.join(data, String(project.id)), undefined, shared, project, profile);
  assert.deepEqual((await projectRuntime.rpc('session/list', {}, '_request')).items, []);
  const projectSession = await projectRuntime.rpc('session/create', {});
  await projectRuntime.rpc('session/rename', { sessionId: projectSession.sessionId, title: 'Project history' });
  projectStream = await follow(projectRuntime, projectSession.sessionId);
  assert.equal(projectStream.snapshot.header.cwd, project.directory);
  await assert.rejects(projectRuntime.rpc('session/cancel', { sessionId }));
  await assert.rejects(follow(projectRuntime, sessionId));
  await assert.rejects(runtime.rpc('session/prompt', { sessionId: projectSession.sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Foreign' }] }));
  await assert.rejects(follow(runtime, projectSession.sessionId));
  await prompt(projectRuntime, projectStream, projectSession.sessionId, 'Project stays usable');
  assert.ok(bodies.at(-1).tools.some(tool => tool.function.name === 'file_office_inspect'), 'Project still installs its own Office tools');
  const before = events(stream);
  await stream.close(); stream = undefined;
  await runtime.stop();
  runtime = await startWorkspace();
  const list = (await runtime.rpc('session/list', {}, '_request')).items;
  assert.deepEqual(list.map(item => item.sessionId), [sessionId]);
  assert.equal(list[0].cwd, directory);
  stream = await follow(runtime, sessionId);
  assertRestoredHistory(stream, before);
  await prompt(runtime, stream, sessionId, 'Workspace after restart');
  assert.ok(!JSON.stringify(bodies.at(-1).messages).includes('Project stays usable'));
  assert.deepEqual((await projectRuntime.rpc('session/list', {}, '_request')).items.map(item => item.sessionId), [projectSession.sessionId]);
  await runtime.rpc('mind/session/delete', { sessionId });
  assert.deepEqual((await runtime.rpc('session/list', {}, '_request')).items, []);
  await assert.rejects(runtime.rpc('session/create', { sessionId }));
  await assert.rejects(follow(runtime, sessionId));
  await stream.close(); stream = undefined;
  await runtime.stop(); runtime = await startWorkspace();
  assert.deepEqual((await runtime.rpc('session/list', {}, '_request')).items, []);
});


test('embedded runtime rejects malformed or ambiguous context configuration before READY', { timeout: 30000 }, async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'mind-invalid-context-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const workspace = { id: randomUUID(), name: 'Workspace', directory: temp };
  const project = { id: 161, name: 'Project', directory: temp };
  const provider = { name: 'Local fixture', modelId: 'local-test-model', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'local-integration-key', supportsImage: false };
  for (const context of [{ project, workspace }, { workspace, project: null },
    { workspace: { ...workspace, id: 0 } }, { workspace: { ...workspace, directory: 'relative' } },
    { project: { ...project, id: 0 } }]) {
    const child = fork(path.join(root, 'scripts/runtime.mjs'), ['--embedded', '--no-open'], {
      cwd: root, execArgv: [], silent: true, env: { ...process.env, PROJECT_MIND_DSH_USER_DATA: temp },
    });
    const kill = () => child.kill('SIGKILL');
    t.after(kill);
    let output = '', ready = false;
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('message', message => { if (message?.type === 'ready') ready = true; });
    const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    child.stdin.end(JSON.stringify({ type: 'configure', provider, ...context }) + '\n');
    const result = await exit;
    assert.equal(result.signal, null);
    assert.equal(result.code, 1, redact(output));
    assert.equal(ready, false);
    assert.match(output, /Invalid main .*configuration/);
    assert.doesNotMatch(output, /MIND_DSH_READY/);
  }
});

test('bounded session fork preserves completed history and independent durable continuation', { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mind-dsh-session-fork-'));
  const provider = await startLocalProvider();
  const data = path.join(temporary, 'history');
  const project = { id: 1, name: 'Fork project', directory: path.join(temporary, 'project') };
  await mkdir(project.directory); project.directory = await realpath(project.directory);
  const shared = { name: 'Local fork fixture', baseUrl: provider.url, modelId: 'fork-model', apiKey: 'local-integration-key', supportsImage: false };
  let runtime, source, child;
  t.after(async () => {
    try { await source?.close(); await child?.close(); }
    finally { try { await runtime?.stop(); } finally { await provider.close(); await rm(temporary, { recursive: true, force: true }); } }
  });
  runtime = await launch(data, undefined, shared, project);
  const { sessionId } = await runtime.rpc('session/create', {});
  await runtime.rpc('session/rename', { sessionId, title: 'Fork fixture title' });
  source = await follow(runtime, sessionId);
  provider.enqueueResponse({ chunks: ['Source completed answer'] });
  const end = await prompt(runtime, source, sessionId, 'Fork source first turn');
  const prefix = events(source).filter(event => event.seq <= end.seq);
  assert.ok(prefix.some(event => event.type === 'assistant/message' && assistantText(event) === 'Source completed answer'));
  // This is the exact bounded native request: no atSeq, cwd, or workspace override.
  const forked = await runtime.rpc('session/fork', { sessionId });
  assert.equal(typeof forked.sessionId, 'string');
  assert.ok(forked.sessionId.length > 0);
  assert.notEqual(forked.sessionId, sessionId);
  child = await follow(runtime, forked.sessionId);
  assert.equal(child.snapshot.header.parentSession, sessionId);
  assert.equal(child.snapshot.header.cwd, project.directory);
  assert.deepEqual(events(child).slice(0, prefix.length), prefix, 'fork must preserve the exact completed source prefix');
  assert.ok(events(child).some(event => event.type === 'session/end-seed' && event.data.inherited === true));
  const mapped = await runtime.rpc('workspace/initializeDefault');
  assert.ok(mapped.workspace.sessionIds.includes(sessionId));
  assert.ok(mapped.workspace.sessionIds.includes(forked.sessionId));
  provider.enqueueResponse({ chunks: ['Source independent answer'] });
  await prompt(runtime, source, sessionId, 'Fork source second turn');
  assert.ok(!JSON.stringify(events(child)).includes('Fork source second turn'), 'later source history must not enter the fork');
  provider.enqueueResponse({ chunks: ['Fork independent answer'] });
  await prompt(runtime, child, forked.sessionId, 'Fork child continuation');
  assert.ok(!JSON.stringify(events(source)).includes('Fork child continuation'), 'fork continuation must not alter the source');
  assert.equal(events(child).filter(event => event.type === 'turn/end').length, 2);
  assert.equal(events(source).filter(event => event.type === 'turn/end').length, 2);
  assert.equal(provider.requests.length, 3, 'fork itself must not generate a provider request');
  assert.ok(provider.requests[2].roles.includes('assistant'), 'fork continuation must replay inherited assistant history');
  const durable = events(child);
  await source.close(); source = undefined;
  await child.close(); child = undefined;
  await runtime.stop();
  runtime = await launch(data, undefined, shared, project);
  child = await follow(runtime, forked.sessionId);
  assertRestoredHistory(child, durable);
  assert.equal(child.snapshot.header.parentSession, sessionId);
  assert.ok(events(child).some(event => event.type === 'assistant/message' && assistantText(event) === 'Fork independent answer'));
});


test('Mind CLI lease rc.2 runtime: model bash uses native Workspace binding and isolated shell lease', { timeout: 60000 }, async t => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'mind-cli-runtime-')));
  const bodies = [], operations = [];
  const leases = new Set();
  const provider = await startLocalProvider({ onSyntheticRequest: body => bodies.push(body) });
  let runtime, stream;
  t.after(async () => {
    try { await stream?.close(); } finally {
      try { await runtime?.stop(); } finally { await provider.close(); await rm(temp, { recursive: true, force: true }); }
    }
  });
  const workspace = { id: randomUUID(), name: 'CLI Workspace', directory: path.join(temp, 'workspace') };
  await mkdir(workspace.directory);
  const bin = path.join(temp, 'bundle'); await mkdir(bin);
  const executable = path.join(bin, 'mind');
  const discovery = path.join(temp, 'independent-bridge.json');
  // A fixture binary consumes credentials without echoing them. An active
  // marker is native-owned; closing the lease removes it. JSON remains public.
  const marker = path.join(temp, 'lease-active');
  await writeFile(executable, `#!/bin/sh
[ -n "$PROJECT_MIND_CLI_TOKEN" ] || exit 31
[ "$PROJECT_MIND_CLI_DISCOVERY" = '${discovery}' ] || exit 32
[ -f '${marker}' ] || exit 33
printf '%s\\n' '{"ok":true,"data":{"fixture":"native-cli-read","receipt":"fixture-receipt"}}'
`);
  await chmod(executable, 0o700);
  const cli = { executable, workspace: workspace.directory, connection: 'a'.repeat(32), discovery, projectId: null };
  const shared = { name: 'CLI local fixture', modelId: 'local-test-model', baseUrl: provider.url, apiKey: 'local-integration-key', supportsImage: false };
  const patch = path.join(temp, 'readonly.patch.yml');
  await writeFile(patch, '- id: sandbox-policy\n  config:\n    mode: read-only\n');
  const token = 'synthetic-ephemeral-cli-lease';
  runtime = await launch(path.join(temp, 'data'), patch, shared, undefined, undefined, async payload => {
    operations.push(payload);
    if (payload.operation === 'cliLeaseOpen') {
      assert.equal(payload.mode, 'read-only');
      const leaseId = `lease-${operations.length}`;
      leases.add(leaseId); await writeFile(marker, 'active');
      return { leaseId, token };
    }
    assert.equal(payload.operation, 'cliLeaseClose');
    assert.ok(leases.delete(payload.leaseId)); await rm(marker);
    return null;
  }, workspace, cli);
  const { sessionId } = await runtime.rpc('session/create', {});
  await runtime.rpc('session/rename', { sessionId, title: 'CLI binding fixture' });
  stream = await follow(runtime, sessionId);
  provider.enqueueResponse({ chunks: [''], toolCalls: [{ index: 0, id: 'cli-runtime-bash', type: 'function', function: {
    name: 'bash', arguments: JSON.stringify({ description: 'Inspect native Workspace CLI binding', command: `mind doctor --workspace '${cli.workspace}' --connection ${cli.connection} --json` }),
  } }] });
  await prompt(runtime, stream, sessionId, 'Use the bound native CLI to inspect this Workspace');
  const reply = providerToolReply(bodies, 'cli-runtime-bash');
  assert.match(reply, /native-cli-read/);
  assert.match(reply, /fixture-receipt/);
  assert.deepEqual(operations, [{ operation: 'cliLeaseOpen', sessionId, mode: 'read-only' }, { operation: 'cliLeaseClose', sessionId, leaseId: 'lease-1' }]);
  assert.equal(leases.size, 0);
  const system = bodies[0].messages.filter(message => message.role === 'system').map(message => JSON.stringify(message.content)).join('\n');
  for (const fact of ['project-mind-cli', executable, '--workspace-scope', cli.connection]) assert.ok(system.includes(fact), fact);
  assert.ok(!JSON.stringify(bodies).includes(token), 'lease credentials must never enter model input');
  assert.ok(!runtime.diagnostics().includes(token), 'lease credentials must never enter runtime logs');
  assert.ok(!JSON.stringify(events(stream)).includes(token), 'lease credentials must never enter durable Session events');
});
