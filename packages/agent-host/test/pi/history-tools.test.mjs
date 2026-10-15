import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHostProtocol } from '../../src/host-protocol.mjs';
import { PROTOCOL_VERSION } from '../../src/protocol.mjs';
import { encodeSession } from '../../src/session-codec.mjs';

const request = (method, data = {}, requestId = method) => ({ protocolVersion: PROTOCOL_VERSION, requestId, method, data });
const parameters = { type: 'object', properties: { query: { type: 'string', maxLength: 256 } },
  required: ['query'], additionalProperties: false };
const tools = ['session.search', 'session.messages.read'].map((method) => ({
  name: `mind_${method.replaceAll('.', '_')}`, method, description: `Scoped ${method}`, parameters,
}));

function stream(response, delta, reason) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [value, finish_reason] of [[delta, null], [{}, reason]]) {
    response.write(`data: ${JSON.stringify({ id: 'history-fixture', object: 'chat.completion.chunk',
      created: 1, model: 'fixture', choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`);
  }
  response.end('data: [DONE]\n\n');
}

test('real Pi history tools round trip through Native bridge while context checks stay internal', { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mind-history-tools-'));
  const requests = [];
  const server = createServer(async (incoming, response) => {
    let body = '';
    for await (const chunk of incoming) body += chunk;
    requests.push(JSON.parse(body));
    const round = requests.length;
    if (round <= 2) stream(response, { role: 'assistant', tool_calls: [{ index: 0,
      id: `history-call-${round}`, type: 'function', function: {
        name: round === 1 ? 'mind_session_search' : 'mind_session_messages_read',
        arguments: JSON.stringify({ query: round === 1 ? 'decision' : 'message-1' }),
      } }] }, 'tool_calls');
    else stream(response, { role: 'assistant', content: 'Verified the original discussion.' }, 'stop');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const sessionId = '6'.repeat(32);
  const runId = '7'.repeat(32);
  const frames = [];
  const bridgeErrors = [];
  let host;
  const nativeResults = {
    'session.context.check': { allowedEntryIds: [] },
    'session.search': { hits: [{ sessionId, messageId: 'message-1', excerpt: 'Decision excerpt' }] },
    'session.messages.read': { messageId: 'message-1', text: 'Exact original wording' },
  };
  host = createHostProtocol({ workspaceRoot: root,
    persistCheckpoint: async (_id, checkpoint) => checkpoint,
    write(frame) {
      frames.push(frame);
      if (frame.method === 'tool.call') queueMicrotask(() => {
        host.handle(request('tool.result', { sessionId, runId,
          result: nativeResults[frame.data.method] }, frame.requestId)).catch((error) => bridgeErrors.push(error));
      });
    } });
  try {
    await host.handle(request('initialize', { workspaceRoot: root, systemPrompt: 'Trusted scope', tools }));
    assert.equal(frames.at(-1).ok, true);
    await host.handle(request('session.open', { sessionId, apiKey: 'fixture-secret', toolCallingVerified: true,
      hostOwnedHistoryPolicy: true,
      profile: { providerFamily: 'openai_compatible', enabled: true, supportsText: true,
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`, defaultModel: 'fixture' } }));
    assert.equal(frames.at(-1).ok, true);
    await host.handle(request('run.start', { sessionId, runId, prompt: 'Find and verify earlier discussion.' }));
    await host.idle();
    assert.deepEqual(bridgeErrors, []);
    assert.equal(frames.find((frame) => frame.type === 'run.completed')?.data.checkpoint !== undefined, true);
    assert.deepEqual(frames.filter((frame) => frame.method === 'tool.call').map((frame) => frame.data.method),
      ['session.context.check', 'session.search', 'session.context.check', 'session.messages.read', 'session.context.check']);
    assert.deepEqual(frames.filter((frame) => frame.method === 'tool.call' && frame.data.method !== 'session.context.check')
      .map((frame) => frame.data.payload), [{ query: 'decision' }, { query: 'message-1' }]);
    assert.equal(requests.length, 3);
    for (const providerRequest of requests) {
      assert.deepEqual(providerRequest.tools.map((tool) => tool.function.name).sort(),
        ['mind_session_messages_read', 'mind_session_search']);
      assert.ok(!JSON.stringify(providerRequest).includes('session.context.check'));
    }
    assert.ok(JSON.stringify(requests[1].messages).includes('Decision excerpt'));
    assert.ok(JSON.stringify(requests[2].messages).includes('Exact original wording'));
  } finally {
    await host.handle(request('shutdown'));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('internal context checks do not spend the model tool call budget', async () => {
  const root = '/tmp/mind-history-budget';
  const sessionId = '8'.repeat(32);
  const runId = '9'.repeat(32);
  const frames = [];
  let host;
  host = createHostProtocol({ workspaceRoot: root,
    persistCheckpoint: async (_id, checkpoint) => checkpoint,
    makeSession: async ({ historyPolicy, dispatchTool, onEvent }) => ({
      activeTools: () => tools.map((tool) => tool.name),
      async prompt() {
        for (let index = 0; index < 30; index++) await historyPolicy({
          method: 'session.context.check', toolCallId: `context-check-${index}`, payload: { entryIds: [] } });
        await dispatchTool({ method: 'session.search', toolCallId: 'model-search', payload: { query: 'decision' } });
        onEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [] } });
        onEvent({ type: 'agent_settled' });
        return { ...encodeSession([{ type: 'session', version: 3, id: sessionId,
          timestamp: new Date().toISOString(), cwd: root }], root), leafId: null };
      },
      dispose: async () => {},
    }),
    write(frame) {
      frames.push(frame);
      if (frame.method === 'tool.call') queueMicrotask(() => {
        void host.handle(request('tool.result', { sessionId, runId,
          result: frame.data.method === 'session.context.check'
            ? { allowedEntryIds: [] } : { hits: [] } }, frame.requestId));
      });
    } });
  await host.handle(request('initialize', { workspaceRoot: root, systemPrompt: 'Trusted scope', tools }));
  await host.handle(request('session.open', { sessionId, apiKey: 'fixture-secret', toolCallingVerified: true,
    hostOwnedHistoryPolicy: true, profile: { providerFamily: 'openai_compatible', enabled: true,
      supportsText: true, baseUrl: 'https://fixture.invalid/v1', defaultModel: 'fixture' } }));
  await host.handle(request('run.start', { sessionId, runId, prompt: 'Find discussion' }));
  await host.idle();
  assert.equal(frames.filter((frame) => frame.method === 'tool.call' && frame.data.method === 'session.context.check').length, 30);
  assert.equal(frames.filter((frame) => frame.method === 'tool.call' && frame.data.method === 'session.search').length, 1);
  assert.equal(frames.find((frame) => frame.type === 'run.completed') !== undefined, true);
  assert.equal(frames.some((frame) => frame.data?.code === 'BUDGET_EXCEEDED'), false);
});
