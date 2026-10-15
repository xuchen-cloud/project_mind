import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '../../src/protocol.mjs';

const entry = fileURLToPath(new URL('../../src/probe-entry.mjs', import.meta.url));
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

test('real JSONL probe process bridges SDK tools, persists before completion, resumes and cancels without system Node', { timeout: 30000 }, async () => {
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
      function: { name: round === 1 ? 'mind_source_read' : 'mind_output_stage', arguments: '{"payload":"scoped content"}' } }] }
      : { role: 'assistant', content: 'Durable answer.' };
    for (const [value, finish_reason] of [[delta, null], [{}, round <= 2 ? 'tool_calls' : 'stop']]) {
      response.write(`data: ${JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', created: 1,
        model: 'fixture', choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const profile = { providerFamily: 'openai_compatible', enabled: true, supportsText: true,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, defaultModel: 'fixture' };
  const sessionId = '7'.repeat(32);
  const runId = '8'.repeat(32);
  let client = transport(root);
  try {
    client.send('initialize', { workspaceRoot: root });
    assert.equal((await client.waitFor((frame) => frame.requestId === 'initialize')).data.runtimeAvailable, false);
    client.send('session.open', { sessionId, profile, apiKey: 'private-fixture-key', toolCallingVerified: true });
    assert.ok((await client.waitFor((frame) => frame.requestId === 'session.open')).ok);
    client.send('run.start', { sessionId, runId, prompt: 'Read a scoped source and stage an answer.' });
    for (const method of ['source.read', 'output.stage']) {
      const call = await client.waitFor((frame) => frame.method === 'tool.call' && frame.data.method === method);
      client.send('tool.result', { sessionId, runId, result: { ref: 'record:1', text: 'Scoped result' } }, call.requestId);
    }
    const completed = await client.waitFor((frame) => frame.type === 'run.completed');
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
    client.send('initialize', { workspaceRoot: moved });
    await client.waitFor((frame) => frame.requestId === 'initialize');
    client.send('session.open', { sessionId, profile, apiKey: 'private-fixture-key', toolCallingVerified: true, resume: true });
    assert.ok((await client.waitFor((frame) => frame.requestId === 'session.open')).ok);
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
  } finally {
    client.kill();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
  }
});
