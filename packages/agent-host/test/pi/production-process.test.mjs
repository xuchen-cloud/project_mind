import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, cp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '../../src/protocol.mjs';

const entry = fileURLToPath(new URL('../../src/index.mjs', import.meta.url));
function transport(root) {
  const env = { PATH: '', HOME: root, TEMP: root, TMP: root, TMPDIR: root };
  if (process.platform === 'win32') env.SystemRoot = process.env.SystemRoot;
  const child = spawn(process.execPath, [entry], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const frames = [];
  let buffer = '';
  let stderr = '';
  const waiters = new Set();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const frame = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      frames.push(frame);
      for (const waiter of waiters) if (waiter.predicate(frame)) { waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(frame); }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  return {
    frames, exited,
    send: (method, data, requestId = method) => child.stdin.write(`${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, requestId, method, data })}\n`),
    waitFor(predicate) {
      const prior = frames.find(predicate);
      if (prior) return Promise.resolve(prior);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error('Probe response timed out')); }, 10000) };
        waiters.add(waiter);
      });
    },
    stderr: () => stderr,
    kill: () => child.kill(),
  };
}

test('production SDK process: explicit read tools, raw arguments, committed projection, usage, migrated resume and cancellation', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mind-process 中文 '));
  const moved = await mkdtemp(path.join(os.tmpdir(), 'mind-process moved '));
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    const round = requests.length;
    if (round === 5) return; // cancellation fixture waits until the client aborts
    const delta = round <= 2 ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${round}`, type: 'function',
      function: { name: round === 1 ? 'mind_source_read' : 'mind_knowledge_get', arguments: '{"locator":"record:1"}' } }] }
      : { role: 'assistant', content: 'Durable answer.' };
    for (const [value, finish_reason] of [[delta, null], [{}, round <= 2 ? 'tool_calls' : 'stop']]) {
      response.write(`data: ${JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', created: 1,
        model: 'fixture', choices: [{ index: 0, delta: value, finish_reason }], usage: finish_reason ? { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } : undefined })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const profile = { providerFamily: 'openai_compatible', enabled: true, supportsText: true,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, defaultModel: 'fixture' };
  const sessionId = '7'.repeat(32);
  const runId = '8'.repeat(32);
  const tools = ['source.read', 'knowledge.get'].map((method) => ({
    name: `mind_${method.replace('.', '_')}`, method, description: `Scoped ${method}`,
    parameters: { type: 'object', properties: { locator: { type: 'string', maxLength: 128 } }, required: ['locator'], additionalProperties: false },
  }));
  const initialization = (workspaceRoot) => ({ workspaceRoot, systemPrompt: 'Project bounded manifest. Never discover local files.', tools });
  let client = transport(root);
  try {
    client.send('initialize', initialization(root));
    assert.equal((await client.waitFor((frame) => frame.requestId === 'initialize')).data.runtimeAvailable, true);
    client.send('session.open', { sessionId, profile, apiKey: 'private-fixture-key' });
    assert.ok((await client.waitFor((frame) => frame.requestId === 'session.open')).ok);
    client.send('run.start', { sessionId, runId, prompt: 'Read a scoped source and stage an answer.' });
    for (const method of ['source.read', 'knowledge.get']) {
      const call = await client.waitFor((frame) => frame.method === 'tool.call' && frame.data.method === method);
      assert.deepEqual(call.data.payload, { locator: 'record:1' });
      client.send('tool.result', { sessionId, runId, result: { ref: 'record:1', text: 'Scoped result' } }, call.requestId);
    }
    const completed = await client.waitFor((frame) => frame.type === 'run.completed');
    assert.deepEqual(completed.data.usage, { input: 30, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 36 });
    assert.ok(completed.data.checkpoint.entryCount >= 6);
    client.send('session.messages.read', { sessionId, checksum: completed.data.checkpoint.checksum, offset: 0, limit: 2 }, 'projection-first');
    const firstPage = (await client.waitFor((frame) => frame.requestId === 'projection-first')).data;
    assert.equal(firstPage.messages[0].role, 'user');
    assert.equal(firstPage.nextOffset, 2);
    const live = client.frames.filter((frame) => frame.type === 'message.completed').map((frame) => frame.data);
    assert.deepEqual(firstPage.messages, live.slice(0, 2));
    assert.deepEqual(live.map((message) => message.role), ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
    assert.ok(live.every((message) => message.runtimeEntryId && message.createdAt));
    client.send('session.messages.read', { sessionId, checksum: 'sha256:wrong', offset: 0 }, 'wrong-checksum');
    assert.equal((await client.waitFor((frame) => frame.requestId === 'wrong-checksum')).error.code, 'RUNTIME_INCOMPATIBLE');
    const jsonl = await readFile(path.join(root, '.project-mind', 'agent', 'sessions', sessionId, 'session.jsonl'), 'utf8');
    assert.equal(Buffer.byteLength(jsonl, 'utf8'), completed.data.checkpoint.bytes);
    assert.ok(jsonl.includes('Durable answer.'));
    assert.ok(!jsonl.includes(root));
    assert.ok(!jsonl.includes('private-fixture-key'));
    assert.ok(client.frames.some((frame) => frame.type === 'text.delta'));
    client.send('shutdown');
    assert.equal(await client.exited, 0);
    assert.equal(client.stderr(), '');
    await cp(path.join(root, '.project-mind'), path.join(moved, '.project-mind'), { recursive: true });
    client = transport(moved);
    client.send('initialize', initialization(moved));
    await client.waitFor((frame) => frame.requestId === 'initialize');
    client.send('session.open', { sessionId, profile, apiKey: 'private-fixture-key', resume: true });
    const opened = await client.waitFor((frame) => frame.requestId === 'session.open');
    assert.ok(opened.ok);
    assert.equal(opened.data.checkpoint.checksum, completed.data.checkpoint.checksum);
    assert.equal(opened.data.messageCount, live.length);
    client.send('session.messages.read', { sessionId, checksum: opened.data.checkpoint.checksum, offset: 0, limit: 100 }, 'restored-projection');
    assert.deepEqual((await client.waitFor((frame) => frame.requestId === 'restored-projection')).data.messages, live);
    const resumeRun = '9'.repeat(32);
    client.send('run.start', { sessionId, runId: resumeRun, prompt: 'Continue.' });
    await client.waitFor((frame) => frame.type === 'run.completed' && frame.runId === resumeRun);
    assert.ok(JSON.stringify(requests[3].messages).includes('Durable answer.'));
    const cancelRun = 'a'.repeat(32);
    client.send('run.start', { sessionId, runId: cancelRun, prompt: 'Cancel this pending response.' }, 'cancel-start');
    await client.waitFor((frame) => frame.type === 'run.started' && frame.runId === cancelRun);
    // Wait for the real provider request, rather than cancelling before preparation.
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { clearInterval(interval); reject(new Error('Provider did not receive run')); }, 5000);
      const interval = setInterval(() => { if (requests.length === 5) { clearInterval(interval); clearTimeout(deadline); resolve(); } }, 5);
    });
    client.send('run.cancel', { sessionId, runId: cancelRun });
    await client.waitFor((frame) => frame.type === 'run.cancelled' && frame.runId === cancelRun);
    client.send('shutdown');
    assert.equal(await client.exited, 0);
    assert.equal(client.stderr(), '');
    assert.ok(!JSON.stringify(client.frames).includes('private-fixture-key'));
    // A damaged authoritative checkpoint must stay intact and cannot become a new session.
    const history = path.join(moved, '.project-mind', 'agent', 'sessions', sessionId, 'session.jsonl');
    await writeFile(history, 'damaged history preserved');
    client = transport(moved);
    client.send('initialize', initialization(moved));
    await client.waitFor((frame) => frame.requestId === 'initialize');
    client.send('session.open', { sessionId, profile, apiKey: 'private-fixture-key', resume: true });
    assert.equal((await client.waitFor((frame) => frame.requestId === 'session.open')).error.code, 'RUNTIME_INCOMPATIBLE');
    client.send('session.open', { sessionId, profile, apiKey: 'private-fixture-key' }, 'try-new');
    assert.equal((await client.waitFor((frame) => frame.requestId === 'try-new')).error.code, 'RUNTIME_INCOMPATIBLE');
    assert.equal(await readFile(history, 'utf8'), 'damaged history preserved');
    client.send('shutdown');
    assert.equal(await client.exited, 0);
  } finally {
    client.kill();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
  }
});
