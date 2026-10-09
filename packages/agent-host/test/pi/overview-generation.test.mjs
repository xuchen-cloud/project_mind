import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHostProtocol } from '../../src/host-protocol.mjs';
import { PROTOCOL_VERSION } from '../../src/protocol.mjs';

const batchId = 'b'.repeat(32);
const profile = { providerFamily: 'openai_compatible', enabled: true, supportsText: true,
  baseUrl: 'http://127.0.0.1/v1', defaultModel: 'fixture' };
const frame = (method, data = {}, requestId = method) => ({ protocolVersion: PROTOCOL_VERSION, method, data, requestId });
const input = { batchId, profile, modelId: 'fixture', toolCallingVerified: true, apiKey: 'secret', prompt: 'Return an overview JSON object.' };
function fixture(makeSession) {
  const frames = [];
  let persists = 0;
  const host = createHostProtocol({ workspaceRoot: '/tmp/workspace', write: (value) => frames.push(value),
    persistCheckpoint: async () => { persists++; return {}; }, loadCheckpoint: async () => null, makeSession });
  return { host, frames, persisted: () => persists, response: (id) => frames.find((value) => value.requestId === id) };
}
async function initialize(item) { await item.host.handle(frame('initialize', { workspaceRoot: '/tmp/workspace', systemPrompt: 'Normal session.' })); }

test('overview uses no tools or checkpoint and returns the completed assistant JSON and usage once', async () => {
  let options;
  let disposed = 0;
  const item = fixture(async (received) => {
    options = received;
    return { activeTools: () => [], prompt: async () => {
      received.onEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '{"summary":"ready"}' }], usage: { input: 12, output: 7, totalTokens: 19 } } });
      received.onEvent({ type: 'agent_settled' });
    }, cancel: async () => {}, dispose: async () => { disposed++; } };
  });
  await initialize(item);
  await item.host.handle(frame('overview.generate', { ...input }, 'generate'));
  await item.host.idle();
  assert.deepEqual(item.response('generate').data, { text: '{"summary":"ready"}',
    usage: { input: 12, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 19 } });
  assert.equal(item.frames.filter((value) => value.requestId === 'generate').length, 1);
  assert.equal(item.persisted(), 0);
  assert.deepEqual(options.tools, []);
  assert.equal(options.dispatchTool instanceof Function, true);
  assert.equal(options.checkpoint, undefined);
  assert.equal(disposed, 1);
  assert.equal(JSON.stringify(item.frames).includes('secret'), false);
});

test('matching cancellation settles original request and shutdown waits for disposal', async () => {
  let release;
  let cancelled = 0;
  let disposed = 0;
  const item = fixture(async () => ({ activeTools: () => [],
    prompt: () => new Promise((resolve) => { release = resolve; }),
    cancel: async () => { cancelled++; }, dispose: async () => { disposed++; } }));
  await initialize(item);
  await item.host.handle(frame('overview.generate', { ...input }, 'generate'));
  await new Promise((resolve) => setImmediate(resolve));
  await item.host.handle(frame('overview.cancel', { batchId: 'c'.repeat(32) }, 'wrong'));
  assert.equal(item.response('wrong').error.code, 'INVALID_ARGUMENT');
  await item.host.handle(frame('overview.cancel', { batchId }, 'cancel'));
  assert.deepEqual(item.response('cancel').data, { cancelling: true, batchId });
  assert.equal(item.response('generate'), undefined);
  release();
  await item.host.idle().catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(item.response('generate').error.code, 'RUN_CANCELLED');
  assert.ok(cancelled >= 1);
  assert.equal(disposed, 1);
  assert.equal(item.persisted(), 0);
});

test('overview rejects competing sessions and runs, excessive input and output, and unsettled model replies', async () => {
  let release;
  let options;
  const item = fixture(async (received) => { options = received; return { activeTools: () => [],
    prompt: () => new Promise((resolve) => { release = () => {
      received.onEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '{}'}] } });
      received.onEvent({ type: 'agent_settled' }); resolve();
    }; }), cancel: async () => {}, dispose: async () => {} }; });
  await initialize(item);
  await item.host.handle(frame('overview.generate', { ...input, prompt: 'x'.repeat(48001) }, 'large-input'));
  assert.equal(item.response('large-input').error.code, 'INVALID_ARGUMENT');
  await item.host.handle(frame('overview.generate', { ...input }, 'first'));
  await new Promise((resolve) => setImmediate(resolve));
  await item.host.handle(frame('overview.generate', { ...input }, 'second'));
  await item.host.handle(frame('session.open', { sessionId: '1'.repeat(32), profile, apiKey: 'secret' }, 'session'));
  await item.host.handle(frame('run.start', { sessionId: '1'.repeat(32), runId: '2'.repeat(32), prompt: 'hi' }, 'run'));
  assert.equal(item.response('second').error.code, 'RUN_BUSY');
  assert.equal(item.response('session').error.code, 'RUN_BUSY');
  assert.equal(item.response('run').error.code, 'RUN_BUSY');
  release(); await item.host.idle();
  assert.equal(item.response('first').ok, true);
  assert.deepEqual(options.tools, []);

  const oversized = fixture(async (received) => ({ activeTools: () => [], prompt: async () => {
    received.onEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'x'.repeat(24001) }] } });
    received.onEvent({ type: 'agent_settled' });
  }, cancel: async () => {}, dispose: async () => {} }));
  await initialize(oversized);
  await oversized.host.handle(frame('overview.generate', { ...input }, 'large-output'));
  await oversized.host.idle().catch(() => {});
  assert.equal(oversized.response('large-output').error.code, 'BUDGET_EXCEEDED');

  const unsettled = fixture(async (received) => ({ activeTools: () => [], prompt: async () => {
    received.onEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '{}'}] } });
  }, cancel: async () => {}, dispose: async () => {} }));
  await initialize(unsettled);
  await unsettled.host.handle(frame('overview.generate', { ...input }, 'unsettled'));
  await unsettled.host.idle().catch(() => {});
  assert.equal(unsettled.response('unsettled').error.code, 'MODEL_FAILED');
});

test('shutdown cancels a pending overview and waits for its disposal before replying', async () => {
  let release;
  let disposed = false;
  const item = fixture(async () => ({ activeTools: () => [],
    prompt: () => new Promise((resolve) => { release = resolve; }),
    cancel: async () => {}, dispose: async () => { disposed = true; } }));
  await initialize(item);
  await item.host.handle(frame('overview.generate', { ...input }, 'generate'));
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = item.host.handle(frame('shutdown', {}, 'shutdown'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(item.response('shutdown'), undefined);
  release(); await stopping;
  assert.equal(disposed, true);
  assert.equal(item.response('generate').error.code, 'RUN_CANCELLED');
  assert.deepEqual(item.response('shutdown').data, { stopped: true });
  assert.equal(item.persisted(), 0);
});

test('provider errors stay generic and dispose the short-lived session', async () => {
  let disposed = 0;
  const item = fixture(async () => ({ activeTools: () => [],
    prompt: async () => { throw new Error('secret provider detail'); },
    cancel: async () => {}, dispose: async () => { disposed++; } }));
  await initialize(item);
  await item.host.handle(frame('overview.generate', { ...input }, 'generate'));
  await item.host.idle().catch(() => {});
  assert.equal(item.response('generate').error.code, 'RUNTIME_FAILED');
  assert.equal(JSON.stringify(item.frames).includes('secret provider detail'), false);
  assert.equal(disposed, 1);
});

test('real Pi SDK generates overview JSON through a local OpenAI-compatible stub without session persistence', { timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mind-overview-sdk-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: '{"overview":"SDK ready"}' }, null], [{}, 'stop']]) {
      response.write(`data: ${JSON.stringify({ id: 'overview', object: 'chat.completion.chunk', created: 1, model: 'fixture',
        choices: [{ index: 0, delta, finish_reason }], usage: finish_reason ? { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } : undefined })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const frames = [];
  let persists = 0;
  const host = createHostProtocol({ workspaceRoot: root, write: (value) => frames.push(value),
    persistCheckpoint: async () => { persists++; return {}; }, loadCheckpoint: async () => null });
  try {
    await host.handle(frame('initialize', { workspaceRoot: root, systemPrompt: 'Normal session.' }));
    const localProfile = { ...profile, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
    await host.handle(frame('overview.generate', { ...input, profile: localProfile, apiKey: 'local-fixture-key' }, 'real-sdk'));
    await host.idle();
    const result = frames.find((value) => value.requestId === 'real-sdk');
    assert.equal(result?.ok, true);
    assert.equal(result.data.text, '{"overview":"SDK ready"}');
    assert.deepEqual(result.data.usage, { input: 9, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 13 });
    assert.equal(requests.length, 1);
    assert.ok(!requests[0].tools?.length);
    assert.equal(persists, 0);
    assert.deepEqual(await readdir(root), []);
    assert.equal(JSON.stringify(frames).includes('local-fixture-key'), false);
  } finally {
    await host.handle(frame('shutdown'));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
