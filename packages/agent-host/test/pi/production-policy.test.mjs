import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { createHostProtocol } from '../../src/host-protocol.mjs';
import { createPiSession } from '../../src/pi-spike.mjs';
import { validateToolDescriptors } from '../../src/tool-descriptors.mjs';
import { PROTOCOL_VERSION } from '../../src/protocol.mjs';

const frame = (method, data = {}) => ({ protocolVersion: PROTOCOL_VERSION, requestId: method, method, data });
const descriptor = { name: 'mind_source_read', method: 'source.read', description: 'Read the granted source',
  parameters: { type: 'object', properties: { locator: { anyOf: [{ type: 'string', maxLength: 128 }, { type: 'null' }] } }, additionalProperties: false } };

test('production rejects unregistered discovery, duplicate tools and unbounded schemas', async () => {
  assert.deepEqual(validateToolDescriptors([descriptor]), [descriptor]);
  const todoGet = { ...descriptor, name: 'mind_todo_get', method: 'todo.get' };
  assert.deepEqual(validateToolDescriptors([todoGet]), [todoGet]);
  for (const method of ['bash', 'shell.exec', 'file.read', 'file.create', 'record.create', 'todo.create', 'todo.update']) {
    assert.throws(() => validateToolDescriptors([{ ...descriptor, method }]), { code: 'INVALID_ARGUMENT' });
  }
  assert.throws(() => validateToolDescriptors([descriptor, descriptor]));
  assert.throws(() => validateToolDescriptors([{ ...descriptor, parameters: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false } }]));
  const frames = [];
  let opened = false;
  const protocol = createHostProtocol({ workspaceRoot: '/tmp/workspace', write: (value) => frames.push(value),
    makeSession: async () => { opened = true; } });
  await protocol.handle(frame('initialize', { workspaceRoot: '/tmp/workspace', systemPrompt: 'Trusted manifest', tools: [descriptor] }));
  await protocol.handle(frame('session.open', { sessionId: '1'.repeat(32), apiKey: 'pipe-only-key',
    profile: { providerFamily: 'openai_compatible', enabled: true, supportsText: true, baseUrl: 'https://fixture.example/v1', defaultModel: 'fixture' } }));
  assert.equal(frames.at(-1).error.code, 'TOOL_CALL_UNSUPPORTED');
  assert.equal(opened, false);
  assert.ok(!JSON.stringify(frames).includes('pipe-only-key'));
});

test('trusted Record tools allow canonical recursive schemas but never external or missing refs', () => {
  const tool = { ...descriptor, method: 'output.stage', parameters: {
    type: 'object', properties: { block: { $ref: '#/$defs/Block' } }, additionalProperties: false,
    $defs: { Block: { type: 'object', properties: { text: { type: 'string', maxLength: 65536 },
      content: { type: 'array', maxItems: 100, items: { $ref: '#/$defs/Block' } } }, additionalProperties: false } },
  } };
  assert.deepEqual(validateToolDescriptors([tool]), [tool]);
  for (const ref of ['https://fixture.invalid/schema', '#/$defs/Missing', '#/properties/block']) {
    const invalid = structuredClone(tool);
    invalid.parameters.properties.block.$ref = ref;
    assert.throws(() => validateToolDescriptors([invalid]), { code: 'INVALID_ARGUMENT' });
  }
  const unbounded = structuredClone(tool);
  delete unbounded.parameters.$defs.Block.properties.text.maxLength;
  assert.throws(() => validateToolDescriptors([unbounded]), { code: 'INVALID_ARGUMENT' });
});

test('real SDK error preserves history and performs one provider request without retries', { timeout: 10000 }, async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    ++requests;
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'private-fixture-key must not be transported' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(os.tmpdir(), 'mind-production-error-'));
  let session;
  try {
    session = await createPiSession({ workspaceRoot: root, sessionId: '2'.repeat(32),
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, modelId: 'fixture', apiKey: 'private-fixture-key',
      tools: [], dispatchTool: async () => assert.fail('No tool is granted') });
    assert.deepEqual(session.activeTools(), []);
    const checkpoint = await session.prompt('Keep this failed user turn.');
    assert.equal(requests, 1);
    assert.ok(checkpoint.jsonl.includes('Keep this failed user turn.'));
    assert.ok(checkpoint.jsonl.includes('"stopReason":"error"'));
    assert.ok(!checkpoint.jsonl.includes('private-fixture-key'));
  } finally {
    await session?.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
