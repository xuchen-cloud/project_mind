import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSharedModel, sharedModelPatches, installSharedCredential, SHARED_KEY_REF } from '../scripts/shared-model.mjs';
const provider = { name: 'Main general', baseUrl: 'https://example.test/v1/', modelId: 'shared-model', apiKey: 'synthetic-pipe-key', supportsImage: true };

test('native configuration maps the main model only and never places its secret in patches', () => {
  const parsed = readSharedModel(JSON.stringify({ type: 'configure', provider }));
  const patches = sharedModelPatches(parsed);
  assert.equal(parsed.baseUrl, 'https://example.test/v1');
  assert.ok(!JSON.stringify(patches).includes(provider.apiKey));
  assert.deepEqual(patches.find(patch => patch.id === 'agent-default-model').config, { provider: 'mind-main', model: provider.modelId });
  assert.equal(patches.find(patch => patch.id === 'ui-settings-models').disabled, true);
  assert.deepEqual(patches.find(patch => patch.id === 'llm-pi-ai').config.providers['mind-main'].models[0].input, ['text', 'image']);
});

test('invalid native frames reject without revealing key or input content', () => {
  for (const value of ['broken', JSON.stringify({ type: 'shutdown', provider }), JSON.stringify({ type: 'configure', provider: { ...provider, baseUrl: 'https://key:secret@example.test' } }), JSON.stringify({ type: 'configure', provider: { ...provider, modelId: '' } })]) {
    assert.throws(() => readSharedModel(value), error => !error.message.includes(provider.apiKey) && /^Invalid main AI/.test(error.message));
  }
});

test('shared key is read-only memory while signed browser records keep their original provider', async () => {
  const credentials = {
    async resolve(ref) { return { value: `local:${ref}` }; },
    async describe() { return { configured: true, writable: true }; },
    async set(ref, value) { return `${ref}:${value}`; }, async unset(ref) { return ref; },
  };
  const original = { ...credentials };
  let release;
  installSharedCredential({ inject(names, apply) {
    assert.deepEqual(names, ['credentials']); apply({ credentials, effect(register) { release = register(); } });
  } }, provider);
  assert.deepEqual(await credentials.resolve(SHARED_KEY_REF), { value: provider.apiKey, source: 'main-app' });
  assert.deepEqual(await credentials.describe(SHARED_KEY_REF), { configured: true, source: 'main-app', writable: false });
  assert.deepEqual(await credentials.resolve('OTHER_KEY'), { value: 'local:OTHER_KEY' });
  await assert.rejects(credentials.set(SHARED_KEY_REF, 'another'), /main application AI settings/);
  await assert.rejects(credentials.unset(SHARED_KEY_REF), /main application AI settings/);
  assert.equal(await credentials.set('OTHER_KEY', 'test'), 'OTHER_KEY:test');
  release();
  assert.equal(credentials.resolve, original.resolve);
});
