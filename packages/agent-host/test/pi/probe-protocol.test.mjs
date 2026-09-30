import assert from 'node:assert/strict';
import test from 'node:test';
import { createProbeProtocol } from '../../src/probe-protocol.mjs';
import { PROTOCOL_VERSION } from '../../src/protocol.mjs';

const sessionId = '1'.repeat(32);
const runId = '2'.repeat(32);
const frame = (method, data, requestId = method) => ({ protocolVersion: PROTOCOL_VERSION, method, data, requestId });
const profile = { providerFamily: 'openai_compatible', enabled: true, supportsText: true,
  baseUrl: 'http://127.0.0.1/v1', defaultModel: 'fixture' };

test('transport correlates tool replies and waits for checkpoint persistence before a terminal event', async () => {
  const frames = [];
  let bridge;
  let persist;
  const persisted = new Promise((resolve) => { persist = resolve; });
  const protocol = createProbeProtocol({ workspaceRoot: '/tmp/workspace',
    write: (value) => frames.push(value),
    persistCheckpoint: async () => { await persisted; return { checksum: 'fixture', bytes: 100 }; },
    makeSession: async ({ dispatchTool, onEvent }) => {
      bridge = dispatchTool;
      return { activeTools: () => ['mind_source_read', 'mind_output_stage'],
        prompt: async () => {
          const answer = await dispatchTool({ method: 'source.read', toolCallId: 'call1', payload: 'allowed', signal: new AbortController().signal });
          assert.deepEqual(answer, { text: 'authorized result' });
          onEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Answer' } });
          onEvent({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Answer' }], stopReason: 'stop' } });
          onEvent({ type: 'agent_settled' });
          return { jsonl: 'fixture', checksum: 'fixture', bytes: 100 };
        }, cancel: async () => {}, dispose: async () => {} };
    } });
  await protocol.handle(frame('initialize'));
  await protocol.handle(frame('session.open', { sessionId, profile, apiKey: 'secret', toolCallingVerified: true }));
  await protocol.handle(frame('run.start', { sessionId, runId, prompt: 'Read source' }));
  const request = frames.find((value) => value.method === 'tool.call');
  assert.ok(request);
  await protocol.handle(frame('tool.result', { sessionId, runId: '3'.repeat(32), result: {} }, request.requestId));
  assert.equal(frames.at(-1).error.code, 'SCOPE_DENIED');
  await protocol.handle(frame('run.start', { sessionId, runId, prompt: 'Second' }, 'second-run'));
  assert.equal(frames.at(-1).error.code, 'RUN_BUSY');
  await protocol.handle(frame('tool.result', { sessionId, runId, result: { text: 'authorized result' } }, request.requestId));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(frames.some((value) => value.type === 'message.completed'));
  assert.ok(!frames.some((value) => value.type === 'run.completed'));
  persist();
  await protocol.idle();
  assert.equal(frames.at(-1).type, 'run.completed');
  const events = frames.filter((value) => value.type);
  assert.deepEqual(events.map((value) => value.seq), [1, 2, 3, 4]);
  assert.ok(!JSON.stringify(frames).includes('secret'));
  await protocol.handle(frame('shutdown'));
  await assert.rejects(bridge({ method: 'source.read', payload: '' }), /cancelled/);
});
