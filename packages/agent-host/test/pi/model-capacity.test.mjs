import assert from 'node:assert/strict';
import test from 'node:test';
import { capacityFromModels, resolveModelCapacity, overviewInputBudget } from '../../src/model-capacity.mjs';
import { createHostProtocol } from '../../src/host-protocol.mjs';
import { PROTOCOL_VERSION } from '../../src/protocol.mjs';
import { MAX_FRAME_BYTES, MAX_OVERVIEW_INPUT_BYTES } from '../../src/protocol.mjs';

const model = (id, contextWindow, maxTokens) => ({ id, contextWindow, maxTokens });
const profile = { providerFamily: 'openai_compatible', enabled: true, supportsText: true,
  baseUrl: 'http://127.0.0.1/v1', defaultModel: 'gpt-4o' };
const frame = (method, data = {}, requestId = method) => ({ protocolVersion: PROTOCOL_VERSION, method, data, requestId });

test('catalog requires exact ID and consistent capacity across matching providers', () => {
  const models = [model('known', 8000, 2000), model('known', 8000, 2000)];
  assert.deepEqual(capacityFromModels(models, 'known'), { contextWindow: 8000, maxTokens: 2000, source: 'sdk_catalog' });
  assert.equal(capacityFromModels(models, 'known-alias').source, 'fallback');
  assert.equal(capacityFromModels([...models, model('known', 9000, 2000)], 'known').source, 'fallback');
  assert.deepEqual(capacityFromModels(models, 'unknown', { contextWindow: 64000, maxTokens: 8000 }),
    { contextWindow: 64000, maxTokens: 8000, source: 'explicit' });
});

test('real bundled SDK catalog and restricted Host capacity protocol agree', async () => {
  const direct = await resolveModelCapacity('gpt-4o');
  assert.equal(direct.source, 'sdk_catalog');
  const frames = [];
  const host = createHostProtocol({ workspaceRoot: '/tmp/workspace', write: (value) => frames.push(value) });
  await host.handle(frame('initialize', { workspaceRoot: '/tmp/workspace', systemPrompt: 'Initialize.' }));
  await host.handle(frame('overview.capacity', { profile, modelId: 'gpt-4o', toolCallingVerified: true }));
  const response = frames.find((value) => value.requestId === 'overview.capacity');
  assert.equal(response.ok, true);
  assert.equal(response.data.contextWindow, direct.contextWindow);
  assert.equal(response.data.maxTokens, direct.maxTokens);
  assert.deepEqual({ inputBytes: response.data.inputBytes, outputTokens: response.data.outputTokens,
    source: response.data.source }, overviewInputBudget(direct));
  assert.equal(response.data.outputTokens <= 4096, true);
  await host.handle(frame('shutdown'));
});

test('smaller context keeps less UTF-8 input and output reserve', () => {
  const small = overviewInputBudget({ contextWindow: 8000, maxTokens: 2000, source: 'sdk_catalog' });
  const large = overviewInputBudget({ contextWindow: 128000, maxTokens: 16000, source: 'sdk_catalog' });
  assert.equal(small.outputTokens, 2000);
  assert.equal(large.outputTokens, 4096);
  assert.equal(small.inputBytes < large.inputBytes, true);
  assert.equal(Buffer.byteLength('中'.repeat(Math.ceil(small.inputBytes / 2)), 'utf8') > small.inputBytes, true);
  assert.equal(MAX_OVERVIEW_INPUT_BYTES, MAX_FRAME_BYTES / 8);
  assert.equal(overviewInputBudget({ contextWindow: 4_000_000, maxTokens: 16_000,
    source: 'explicit' }).inputBytes, MAX_OVERVIEW_INPUT_BYTES);
});
